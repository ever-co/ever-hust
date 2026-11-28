import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, users } from "@ever-hust/db";

/**
 * Opt-in integration test (T-2878): the four writers of users.preferences against a REAL
 * Postgres, two (or four) at once on the same user. Each one reads the whole JSON, merges its own
 * keys in and writes the whole JSON back, so without a row lock the later writer puts back a
 * stale copy of the other's keys: a just-saved BYOK key, evaluation weights or writing style
 * silently reverts. The writers: PATCH /api/user/settings and the savePreferences,
 * learnPreference and captureWritingStyle AI tools (the AI SDK runs the tool calls of one step
 * in parallel).
 *
 *   USER_PREFS_IT_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55441/hust_it
 *
 * The database must be a throwaway one whose name ends in `_it` or `_test` (the test inserts and
 * deletes users); the schema must already be pushed (`DATABASE_URL=… pnpm db:push`). Skipped when
 * unset.
 *
 * To make the interleaving certain rather than lucky, a third transaction holds the user row
 * under FOR UPDATE while the writers start, and is released only once every writer waits on that
 * lock. A writer that reads without the lock has already read the old JSON by then (a plain
 * SELECT is not blocked) and waits at its UPDATE; a writer that reads under FOR UPDATE waits
 * before it reads, and so reads the JSON the writer before it committed.
 */

// Read through a plain record: these are test-only settings, not Turborepo build inputs.
const env = process.env as Record<string, string | undefined>;
const url = env.USER_PREFS_IT_DATABASE_URL;
const dbName = url ? new URL(url).pathname.replace(/^\//, "") : "";
const enabled = Boolean(url) && /(_it|_test)$/.test(dbName);
const suite = enabled ? describe : describe.skip;

// `postgres` is CommonJS (`export =`). The db client imports it as a default export, which the
// app's build resolves (esModuleInterop) but Jest does not: give the function a `default` so the
// real client connects.
jest.mock("postgres", () => {
  const actual = jest.requireActual("postgres");
  return Object.assign(actual, { default: actual });
});

/** The user the mocked session returns. */
const mockSession = { userId: "" };
jest.mock("../get-session-user", () => ({
  requireSessionUser: async () => ({ id: mockSession.userId }),
}));
jest.mock("../rate-limit", () => ({ applyRateLimit: () => null }));

import { PATCH } from "../../app/api/user/settings/route";
import { savePreferencesTool } from "@ever-hust/ai/tools/save-preferences";
import { learnPreferenceTool } from "@ever-hust/ai/tools/learn-preference";
import { captureWritingStyleTool } from "@ever-hust/ai/tools/capture-writing-style";

type Prefs = Record<string, unknown>;
type Writer = {
  /** Runs the writer for the current user; true when it reported success. */
  run: (userId: string) => Promise<boolean>;
  /** True when the user's preferences still hold what this writer saved. */
  kept: (prefs: Prefs) => boolean;
};

const toolResult = async <T>(result: unknown) => (await result) as T;

const WRITERS = {
  settings: {
    run: async () => {
      const res = await PATCH(
        new Request("http://localhost/api/user/settings", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            preferences: { apiKeys: { anthropic: "it-not-a-real-key" } },
          }),
        }),
      );
      return res.status === 200;
    },
    kept: (prefs) => {
      const stored = (prefs.apiKeys as Record<string, unknown> | undefined)
        ?.anthropic;
      return typeof stored === "string" && stored.length > 0;
    },
  },
  savePreferences: {
    run: async (userId) =>
      (
        await toolResult<{ saved: boolean }>(
          savePreferencesTool.execute!(
            { userId, preferences: { jobType: ["contract"] } } as never,
            {} as never,
          ),
        )
      ).saved,
    kept: (prefs) => Array.isArray(prefs.jobType),
  },
  learnPreference: {
    run: async (userId) =>
      (
        await toolResult<{ updated: boolean }>(
          learnPreferenceTool.execute!(
            { userId, adjustments: { comp: 30, remote: 20 } } as never,
            {} as never,
          ),
        )
      ).updated,
    kept: (prefs) =>
      typeof prefs.evaluationWeights === "object" &&
      prefs.evaluationWeights !== null,
  },
  captureWritingStyle: {
    run: async (userId) =>
      (
        await toolResult<{ captured: boolean }>(
          captureWritingStyleTool.execute!(
            {
              userId,
              samples: [
                "I write short, plain sentences. I keep my cover letters direct and warm.",
              ],
            } as never,
            {} as never,
          ),
        )
      ).captured,
    kept: (prefs) =>
      typeof prefs.writingStyle === "object" && prefs.writingStyle !== null,
  },
} satisfies Record<string, Writer>;
type WriterName = keyof typeof WRITERS;

/** Backends of this database that wait on a lock. */
async function lockWaiters(): Promise<number> {
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]!.n;
}

/**
 * Starts every writer while another transaction holds the user row under FOR UPDATE, waits
 * until all of them wait on that lock, then releases it.
 */
async function raceOnLockedRow(
  userId: string,
  names: WriterName[],
): Promise<boolean[]> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let lockTaken!: () => void;
  const locked = new Promise<void>((resolve) => (lockTaken = resolve));

  const holder = db.transaction(async (tx) => {
    await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    lockTaken();
    await released;
  });
  await locked;

  const runs = names.map((name) => WRITERS[name].run(userId));
  try {
    const deadline = Date.now() + 15_000;
    let waiting = await lockWaiters();
    while (waiting < names.length) {
      if (Date.now() > deadline) {
        throw new Error(
          `expected ${names.length} writers to wait on the row lock, saw ${waiting}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      waiting = await lockWaiters();
    }
  } finally {
    release();
    await holder;
  }
  return Promise.all(runs);
}

async function preferencesOf(userId: string): Promise<Prefs> {
  const [row] = await db
    .select({ preferences: users.preferences })
    .from(users)
    .where(eq(users.id, userId));
  return (row?.preferences ?? {}) as Prefs;
}

suite("users.preferences writers against Postgres (opt-in)", () => {
  const savedEnv = {
    DATABASE_URL: env.DATABASE_URL,
    BYOK_ENCRYPTION_KEY: env.BYOK_ENCRYPTION_KEY,
  };
  let userId = "";

  beforeAll(() => {
    // The db client is a lazy singleton: it reads DATABASE_URL on first use, which is below.
    env.DATABASE_URL = url;
    // A throwaway key for this run: the settings PATCH encrypts the BYOK key it stores.
    env.BYOK_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await (
      db as unknown as { $client: { end: () => Promise<void> } }
    ).$client.end();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  });

  beforeEach(async () => {
    userId = `prefs-it-${randomBytes(6).toString("hex")}`;
    mockSession.userId = userId;
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      name: "Preferences IT",
      preferences: { seeded: "kept" },
    });
  });

  afterEach(async () => {
    await db.delete(users).where(eq(users.id, userId));
  });

  it.each<[WriterName, WriterName]>([
    // Parallel tool calls of one AI step.
    ["savePreferences", "learnPreference"],
    ["learnPreference", "captureWritingStyle"],
    // A Settings save during a chat.
    ["captureWritingStyle", "settings"],
    ["settings", "savePreferences"],
  ])(
    "%s and %s at once both keep their keys",
    async (first, second) => {
      const results = await raceOnLockedRow(userId, [first, second]);
      expect(results).toEqual([true, true]);

      const prefs = await preferencesOf(userId);
      expect({
        seeded: prefs.seeded,
        [first]: WRITERS[first].kept(prefs),
        [second]: WRITERS[second].kept(prefs),
      }).toEqual({ seeded: "kept", [first]: true, [second]: true });
    },
    30_000,
  );

  it("all four writers at once keep every key", async () => {
    const names = Object.keys(WRITERS) as WriterName[];
    const results = await raceOnLockedRow(userId, names);
    expect(results).toEqual(names.map(() => true));

    const prefs = await preferencesOf(userId);
    expect(
      Object.fromEntries(
        names.map((name) => [name, WRITERS[name].kept(prefs)]),
      ),
    ).toEqual(Object.fromEntries(names.map((name) => [name, true])));
    expect(prefs.seeded).toBe("kept");
  }, 30_000);
});
