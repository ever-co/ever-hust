/**
 * savePreferences merges the new preferences into users.preferences. The AI SDK runs the tool
 * calls of one step in parallel, and the Settings page writes the same JSON, so the row must be
 * read under FOR UPDATE inside the transaction that writes it back: a plain SELECT does not
 * block another writer, and the later write would put back a stale copy of the other's keys.
 */
jest.mock("@ever-hust/db", () =>
  require("./__tests__/fake-users-db").fakeDbModule(),
);
jest.mock("drizzle-orm", () => ({ eq: jest.fn() }));

import { fakeUsers, resetFakeUsers } from "./__tests__/fake-users-db";
import { savePreferencesTool } from "./save-preferences";

const run = (input: Record<string, unknown>) =>
  savePreferencesTool.execute!(input as never, {} as never);

describe("savePreferencesTool", () => {
  beforeEach(() =>
    resetFakeUsers({ writingStyle: { formality: 0.4 }, aiModel: "m" }),
  );

  it("requires auth", async () => {
    const r = await run({ preferences: { jobType: ["fulltime"] } });
    expect(r).toEqual({ saved: false, error: "Not authenticated" });
    expect(fakeUsers.calls).toEqual([]);
  });

  it("reads the row under FOR UPDATE in the transaction that writes it", async () => {
    const r = await run({
      userId: "u1",
      preferences: { jobType: ["fulltime"] },
    });

    expect(r).toMatchObject({ saved: true });
    expect(fakeUsers.calls).toEqual([
      "transaction",
      "tx select for update",
      "tx update preferences,updatedAt",
    ]);
  });

  it("keeps the keys it did not change and can mark onboarding complete", async () => {
    const r = await run({
      userId: "u1",
      preferences: { jobType: ["contract"] },
      markOnboardingComplete: true,
    });

    expect(r).toMatchObject({ saved: true, onboardingCompleted: true });
    expect(fakeUsers.row).toMatchObject({
      onboardingCompleted: true,
      preferences: {
        writingStyle: { formality: 0.4 },
        aiModel: "m",
        jobType: ["contract"],
      },
    });
    expect(fakeUsers.calls).toEqual([
      "transaction",
      "tx select for update",
      "tx update onboardingCompleted,preferences,updatedAt",
    ]);
  });
});
