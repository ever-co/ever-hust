/**
 * PATCH /api/user/settings merges the sent preferences into users.preferences. The AI tools
 * (savePreferences, learnPreference, captureWritingStyle) write the same JSON during a chat, so
 * the row must be read under FOR UPDATE inside the transaction that writes it back: a plain
 * SELECT does not block another writer, and the later write would put back a stale copy of the
 * other's keys (a just-saved BYOK key could silently revert, T-2878).
 */
type Row = {
  preferences: Record<string, unknown> | null;
  [column: string]: unknown;
};
const mockUser: { row: Row | null; calls: string[] } = { row: null, calls: [] };

type Settle = (value: unknown) => unknown;
/** The statements the route can run, on the db itself or on a transaction. */
function mockQueries(scope: "db" | "tx") {
  return {
    select: () => {
      let lock: string | null = null;
      const query = {
        from: () => query,
        where: () => query,
        limit: () => query,
        for: (strength: string) => {
          lock = strength;
          return query;
        },
        then: (resolve: Settle, reject: Settle) => {
          mockUser.calls.push(`${scope} select${lock ? ` for ${lock}` : ""}`);
          const rows = mockUser.row
            ? [{ preferences: mockUser.row.preferences }]
            : [];
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return query;
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          then: (resolve: Settle, reject: Settle) => {
            mockUser.calls.push(
              `${scope} update ${Object.keys(values).sort().join(",")}`,
            );
            if (mockUser.row) Object.assign(mockUser.row, values);
            return Promise.resolve(undefined).then(resolve, reject);
          },
        }),
      }),
    }),
  };
}
jest.mock("@ever-hust/db", () => ({
  db: {
    ...mockQueries("db"),
    transaction: async <T>(fn: (tx: object) => Promise<T>) => {
      mockUser.calls.push("transaction");
      return fn(mockQueries("tx"));
    },
  },
  users: { id: "id", preferences: "preferences" },
}));
jest.mock("drizzle-orm", () => ({ eq: jest.fn() }));
jest.mock("@ever-hust/ai/crypto", () => ({
  encryptApiKey: (key: string) => `enc(${key})`,
}));
jest.mock("../get-session-user", () => ({
  requireSessionUser: async () => ({ id: "user-1" }),
}));
jest.mock("../rate-limit", () => ({ applyRateLimit: () => null }));

import { PATCH } from "../../app/api/user/settings/route";

function patch(body: unknown) {
  return PATCH(
    new Request("http://localhost/api/user/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("PATCH /api/user/settings preferences merge", () => {
  beforeEach(() => {
    mockUser.row = {
      preferences: {
        evaluationWeights: { comp: 30 },
        apiKeys: { openai: "enc(old-openai)" },
      },
    };
    mockUser.calls = [];
  });

  it("reads the row under FOR UPDATE in the transaction that writes it", async () => {
    const res = await patch({ preferences: { aiModel: "claude-sonnet-4-5" } });

    expect(res.status).toBe(200);
    expect(mockUser.calls).toEqual([
      "transaction",
      "tx select for update",
      "tx update preferences,updatedAt",
    ]);
    expect(mockUser.row!.preferences).toEqual({
      evaluationWeights: { comp: 30 },
      apiKeys: { openai: "enc(old-openai)" },
      aiModel: "claude-sonnet-4-5",
    });
  });

  it("encrypts a new BYOK key and keeps the sibling keys, under the same lock", async () => {
    const res = await patch({
      name: "Jane",
      preferences: { apiKeys: { anthropic: "new-key" } },
    });

    expect(res.status).toBe(200);
    expect(mockUser.calls).toEqual([
      "transaction",
      "tx select for update",
      "tx update name,preferences,updatedAt",
    ]);
    expect(mockUser.row!.preferences).toEqual({
      evaluationWeights: { comp: 30 },
      apiKeys: { openai: "enc(old-openai)", anthropic: "enc(new-key)" },
    });
  });

  it("updates the other fields without a transaction when no preferences are sent", async () => {
    const res = await patch({ headline: "Engineer" });

    expect(res.status).toBe(200);
    expect(mockUser.calls).toEqual(["db update headline,updatedAt"]);
  });
});
