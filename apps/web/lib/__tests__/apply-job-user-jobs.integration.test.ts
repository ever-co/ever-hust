import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { applications, db, jobs, userJobs, users } from "@ever-hust/db";

/**
 * Opt-in integration test (T-2900): the applyJob tool against a REAL Postgres while the same
 * job is favorited or unfavorited at the same moment. applyJob marks the job's user_jobs row
 * 'applied' with appliedAt (the profile's applied list and the inbox job matching read it) in
 * the transaction that creates the application.
 *
 *   APPLY_JOB_IT_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55442/hust_it
 *
 * The database must be a throwaway one whose name ends in `_it` or `_test` (the test inserts and
 * deletes users and jobs); the schema must already be pushed (`DATABASE_URL=… pnpm db:push`).
 * Skipped when unset.
 *
 * A select followed by an update or an insert loses to both toggles under READ COMMITTED, and
 * the test makes each interleaving certain rather than lucky with a holder transaction:
 *
 * - Unfavorite: the holder locks the favorited row; the unfavorite (the real DELETE or POST
 *   toggle route) queues on that lock first, then applyJob starts. A plain select reads the row
 *   (it is not blocked) and the update queues behind the unfavorite, which deletes the row: the
 *   update then changes nothing, the application commits and no row says 'applied'.
 * - Favorite: the holder inserts the 'favorited' row (what the toggle route and the favoriteJob
 *   tool do for a job with no row) and commits only once applyJob waits on it. A plain select
 *   saw no row, so the insert hits user_jobs_unique and the whole application rolls back.
 *
 * One upsert on (user_id, job_id) waits for the other writer and then inserts or updates.
 */

// Read through a plain record: these are test-only settings, not Turborepo build inputs.
const env = process.env as Record<string, string | undefined>;
const url = env.APPLY_JOB_IT_DATABASE_URL;
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

import { DELETE, POST } from "../../app/api/user/favorites/route";
import { applyJobTool } from "@ever-hust/ai/tools/apply-job";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const UNFAVORITE = {
  "DELETE /api/user/favorites": DELETE,
  "POST /api/user/favorites (toggle off)": POST,
} as const;

function favoritesRequest(method: string, jobId: number): Request {
  return new Request("http://localhost/api/user/favorites", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId }),
  });
}

async function applyJob(userId: string, jobId: number) {
  return (await applyJobTool.execute!(
    { userId, jobId } as never,
    {} as never,
  )) as {
    applied: boolean;
    applicationId?: string;
    error?: string;
  };
}

/** Backends of this database that wait on a lock. */
async function lockWaiters(): Promise<number> {
  const rows = (await db.execute(
    sql`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
  )) as unknown as Array<{ n: number }>;
  return rows[0]!.n;
}

async function untilLockWaiters(n: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  let waiting = await lockWaiters();
  while (waiting < n) {
    if (Date.now() > deadline) {
      throw new Error(
        `expected ${n} backends to wait on a lock, saw ${waiting}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    waiting = await lockWaiters();
  }
}

/**
 * Runs `hold` in a transaction that stays open, then starts each run in turn, each once the
 * ones before it wait on a lock, and commits the holder once all of them wait.
 */
async function behindHolder(
  hold: (tx: Tx) => Promise<unknown>,
  runs: Array<() => Promise<unknown>>,
): Promise<unknown[]> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));

  const holder = db.transaction(async (tx) => {
    await hold(tx);
    held();
    await released;
  });
  await Promise.race([holding, holder]);

  const started: Array<Promise<unknown>> = [];
  try {
    for (const run of runs) {
      started.push(run());
      await untilLockWaiters(started.length);
    }
  } catch (err) {
    release();
    await Promise.allSettled([holder, ...started]);
    throw err;
  }
  release();
  await holder;
  return Promise.all(started);
}

suite("applyJob and the favorite toggles against Postgres (opt-in)", () => {
  const savedDatabaseUrl = env.DATABASE_URL;
  let userId = "";
  let jobId = 0;

  beforeAll(() => {
    // The db client is a lazy singleton: it reads DATABASE_URL on first use, which is below.
    env.DATABASE_URL = url;
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await (
      db as unknown as { $client: { end: () => Promise<void> } }
    ).$client.end();
    if (savedDatabaseUrl === undefined) delete env.DATABASE_URL;
    else env.DATABASE_URL = savedDatabaseUrl;
  });

  beforeEach(async () => {
    const suffix = randomBytes(6).toString("hex");
    userId = `apply-it-${suffix}`;
    mockSession.userId = userId;
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      name: "Apply IT",
      subscriptionStatus: "active",
    });
    const [job] = await db
      .insert(jobs)
      .values({
        externalId: `apply-it-${suffix}`,
        site: "it",
        title: "Staff Engineer",
        companyName: "Acme",
        applyUrl: "https://jobs.example.test/apply",
      })
      .returning({ id: jobs.id });
    jobId = job!.id;
  });

  afterEach(async () => {
    // Cascades to the user's user_jobs, applications and agent instances.
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(jobs).where(eq(jobs.id, jobId));
  });

  async function userJobRows() {
    return db
      .select({ status: userJobs.status, appliedAt: userJobs.appliedAt })
      .from(userJobs)
      .where(and(eq(userJobs.userId, userId), eq(userJobs.jobId, jobId)));
  }

  async function applicationCount() {
    const rows = await db
      .select({ id: applications.id })
      .from(applications)
      .where(
        and(eq(applications.userId, userId), eq(applications.jobId, jobId)),
      );
    return rows.length;
  }

  it.each(Object.keys(UNFAVORITE) as Array<keyof typeof UNFAVORITE>)(
    "an unfavorite via %s that deletes the row during the apply keeps the 'applied' row",
    async (route) => {
      await db.insert(userJobs).values({ userId, jobId, status: "favorited" });
      const method = route.startsWith("DELETE") ? "DELETE" : "POST";

      const [unfavorite, applied] = (await behindHolder(
        (tx) =>
          tx
            .select({ id: userJobs.id })
            .from(userJobs)
            .where(and(eq(userJobs.userId, userId), eq(userJobs.jobId, jobId)))
            .for("update"),
        [
          () => UNFAVORITE[route](favoritesRequest(method, jobId)),
          () => applyJob(userId, jobId),
        ],
      )) as [Response, Awaited<ReturnType<typeof applyJob>>];

      expect(unfavorite.status).toBe(200);
      expect(await unfavorite.json()).toMatchObject({
        jobId,
        favorited: false,
      });
      expect(applied).toMatchObject({ applied: true });
      expect(await applicationCount()).toBe(1);
      expect(await userJobRows()).toEqual([
        { status: "applied", appliedAt: expect.any(Date) },
      ]);
    },
    30_000,
  );

  it("a favorite inserted during the apply does not roll the application back", async () => {
    const [applied] = (await behindHolder(
      (tx) =>
        tx.insert(userJobs).values({ userId, jobId, status: "favorited" }),
      [() => applyJob(userId, jobId)],
    )) as [Awaited<ReturnType<typeof applyJob>>];

    expect(applied).toMatchObject({ applied: true });
    expect(await applicationCount()).toBe(1);
    expect(await userJobRows()).toEqual([
      { status: "applied", appliedAt: expect.any(Date) },
    ]);
  }, 30_000);
});
