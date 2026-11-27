import { test, expect } from "@playwright/test";
import { providerRateLimitError, streamErrorText } from "./helpers/live-llm";

// The parser behind the live-LLM specs' rate-limit skip (helpers/live-llm.ts). No server or
// browser needed: these feed it chat stream bodies.

const sse = (...parts: object[]) =>
  parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join("") + "data: [DONE]\n\n";

// The body main CI got on 2026-11-26 when OpenRouter's free-model daily cap was spent.
const OPENROUTER_DAILY_CAP = sse(
  { type: "start" },
  {
    type: "error",
    errorText:
      "Failed after 3 attempts. Last error: Rate limit exceeded: free-models-per-day-high-balance. ",
  },
);

test.describe("live-LLM stream helpers", () => {
  test("a provider rate limit is recognised", () => {
    expect(providerRateLimitError(OPENROUTER_DAILY_CAP)).toContain(
      "Rate limit exceeded: free-models-per-day-high-balance",
    );
    expect(
      providerRateLimitError(
        sse({
          type: "error",
          errorText:
            "This request would exceed the rate limit for your organization of 50 requests per minute.",
        }),
      ),
    ).toBeDefined();
    expect(
      providerRateLimitError(sse({ type: "error", errorText: "429 Too Many Requests" })),
    ).toBeDefined();
  });

  test("CRLF line endings are read too", () => {
    expect(providerRateLimitError(OPENROUTER_DAILY_CAP.replace(/\n/g, "\r\n"))).toBeDefined();
  });

  test("any other stream error is not a rate limit, so the test still fails", () => {
    const body = sse({ type: "error", errorText: "Invalid schema for function 'searchJobs'" });
    expect(streamErrorText(body)).toBe("Invalid schema for function 'searchJobs'");
    expect(providerRateLimitError(body)).toBeUndefined();
  });

  test("a rate-limit message outside an error part is ignored", () => {
    // Hust's own caps come back as tool results; the model may also just say the words.
    const body = sse(
      { type: "start" },
      {
        type: "tool-output-available",
        toolCallId: "call_1",
        output: { error: "Rate limit exceeded", limitType: "searches" },
      },
      { type: "text-delta", id: "t1", delta: "You hit the rate limit for searches today." },
      { type: "finish" },
    );
    expect(streamErrorText(body)).toBeUndefined();
    expect(providerRateLimitError(body)).toBeUndefined();
  });

  test("a body that is not a UI message stream has no error", () => {
    expect(streamErrorText("")).toBeUndefined();
    expect(streamErrorText("data: not json\n\n")).toBeUndefined();
    expect(streamErrorText('{"error":"Rate limit exceeded"}')).toBeUndefined();
  });
});
