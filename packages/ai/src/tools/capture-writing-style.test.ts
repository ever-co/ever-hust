jest.mock("@ever-hust/db", () =>
  require("./__tests__/fake-users-db").fakeDbModule(),
);
jest.mock("drizzle-orm", () => ({ eq: jest.fn() }));

import { fakeUsers, resetFakeUsers } from "./__tests__/fake-users-db";
import { captureWritingStyleTool } from "./capture-writing-style";

describe("captureWritingStyleTool guards (no DB hit)", () => {
  beforeEach(() => resetFakeUsers({}));

  it("requires auth", async () => {
    const r = await captureWritingStyleTool.execute!(
      { samples: ["hello world"] } as never,
      {} as never,
    );
    expect(r).toEqual({ captured: false, error: "Not authenticated." });
    expect(fakeUsers.calls).toEqual([]);
  });

  it("requires at least one sample", () => {
    expect(
      captureWritingStyleTool.inputSchema.safeParse({ samples: [] }).success,
    ).toBe(false);
    expect(
      captureWritingStyleTool.inputSchema.safeParse({ samples: ["a"] }).success,
    ).toBe(true);
  });
});

/**
 * The tool rewrites the whole users.preferences JSON. The AI SDK runs the tool calls of one step
 * in parallel (savePreferences, learnPreference), so the row must be read under FOR UPDATE in the
 * transaction that writes it back, or the later writer puts back a stale copy (T-2878).
 */
describe("captureWritingStyleTool writes", () => {
  const SAMPLE =
    "I build reliable systems. I like clear, short sentences and plain words.";

  it("reads the row under FOR UPDATE in the transaction that writes it", async () => {
    resetFakeUsers({ evaluationWeights: { comp: 30 } });

    const r = await captureWritingStyleTool.execute!(
      { samples: [SAMPLE], userId: "u1" } as never,
      {} as never,
    );

    expect(r).toMatchObject({ captured: true });
    expect(fakeUsers.calls).toEqual([
      "transaction",
      "tx select for update",
      "tx update preferences,updatedAt",
    ]);
    const prefs = fakeUsers.row!.preferences as Record<string, unknown>;
    expect(prefs.evaluationWeights).toEqual({ comp: 30 });
    expect(prefs.writingStyle).toBeDefined();
    // Only the fingerprint is stored, never the raw sample.
    expect(JSON.stringify(prefs)).not.toContain(SAMPLE);
  });

  it("answers user not found without writing", async () => {
    resetFakeUsers(null);

    const r = await captureWritingStyleTool.execute!(
      { samples: [SAMPLE], userId: "gone" } as never,
      {} as never,
    );

    expect(r).toEqual({ captured: false, error: "User not found." });
    expect(fakeUsers.calls).toEqual(["transaction", "tx select for update"]);
  });
});
