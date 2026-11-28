jest.mock("@ever-hust/db", () =>
  require("./__tests__/fake-users-db").fakeDbModule(),
);
jest.mock("drizzle-orm", () => ({ eq: jest.fn() }));

import { fakeUsers, resetFakeUsers } from "./__tests__/fake-users-db";
import { learnPreferenceTool } from "./learn-preference";

describe("learnPreferenceTool guards (no DB hit)", () => {
  beforeEach(() => resetFakeUsers({}));

  it("requires auth", async () => {
    const r = await learnPreferenceTool.execute!(
      { adjustments: { comp: 25 } } as never,
      {} as never,
    );
    expect(r).toEqual({ updated: false, error: "Not authenticated." });
    expect(fakeUsers.calls).toEqual([]);
  });

  it("rejects an adjustment with no known dimensions", async () => {
    const r = await learnPreferenceTool.execute!(
      { adjustments: { not_a_dim: 50 }, userId: "u1" } as never,
      {} as never,
    );
    expect(r).toEqual({
      updated: false,
      error: "No known evaluation dimensions in the adjustment.",
    });
    expect(fakeUsers.calls).toEqual([]);
  });
});

/**
 * The tool rewrites the whole users.preferences JSON. The AI SDK runs the tool calls of one step
 * in parallel (savePreferences, captureWritingStyle), so the row must be read under FOR UPDATE in
 * the transaction that writes it back, or the later writer puts back a stale copy (T-2878).
 */
describe("learnPreferenceTool writes", () => {
  it("reads the row under FOR UPDATE in the transaction that writes it", async () => {
    resetFakeUsers({ jobType: ["fulltime"] });

    const r = await learnPreferenceTool.execute!(
      { adjustments: { comp: 25 }, userId: "u1" } as never,
      {} as never,
    );

    expect(r).toMatchObject({ updated: true });
    expect(fakeUsers.calls).toEqual([
      "transaction",
      "tx select for update",
      "tx update preferences,updatedAt",
    ]);
    const prefs = fakeUsers.row!.preferences as Record<string, unknown>;
    expect(prefs.jobType).toEqual(["fulltime"]);
    expect(prefs.evaluationWeights).toMatchObject({ comp: expect.any(Number) });
  });

  it("answers user not found without writing", async () => {
    resetFakeUsers(null);

    const r = await learnPreferenceTool.execute!(
      { adjustments: { comp: 25 }, userId: "gone" } as never,
      {} as never,
    );

    expect(r).toEqual({ updated: false, error: "User not found." });
    expect(fakeUsers.calls).toEqual(["transaction", "tx select for update"]);
  });
});
