import { test } from "@playwright/test";

/**
 * A model provider's rate limit, as the chat stream reports it. The AI SDK passes the failed model
 * call's message through as the UI stream's `error` part. OpenRouter's free-model daily cap
 * (main CI, 2026-11-26):
 *
 *   data: {"type":"error","errorText":"Failed after 3 attempts. Last error: Rate limit exceeded: free-models-per-day-high-balance. "}
 *
 * Anthropic answers 429 with "... would exceed the rate limit ..." (`rate_limit_error`).
 * Only `error` parts are read: Hust's own caps (searches, cover letters) are tool results, and a
 * tool that throws becomes a tool output part, so neither can turn a Hust failure into a skip.
 */
const PROVIDER_RATE_LIMIT = /rate[ _-]?limit|too many requests/i;

/** The `errorText` of the first `error` part in a UI message stream (SSE) body, if it has one. */
export function streamErrorText(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let part: unknown;
    try {
      part = JSON.parse(payload);
    } catch {
      continue;
    }
    if (
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "error"
    ) {
      const text = (part as { errorText?: unknown }).errorText;
      return typeof text === "string" ? text : "";
    }
  }
  return undefined;
}

/** The stream's error text when the model provider refused the call with a rate limit, else undefined. */
export function providerRateLimitError(body: string): string | undefined {
  const text = streamErrorText(body);
  return text !== undefined && PROVIDER_RATE_LIMIT.test(text) ? text : undefined;
}

/**
 * Skip the running test, instead of failing it, when the model provider rate-limited the chat
 * call: a spent free-model quota says nothing about Hust's code, and Playwright's CI retries would
 * only spend more of it. Any other stream error is left to the test's own assertions.
 */
export function skipIfProviderRateLimited(body: string): void {
  const error = providerRateLimitError(body);
  test.skip(
    error !== undefined,
    `Model provider rate limit, not a Hust failure: ${error?.trim()}`,
  );
}
