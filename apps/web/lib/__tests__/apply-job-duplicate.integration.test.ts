import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  agentInstances,
  applications,
  db,
  jobs,
  userJobs,
  users,
} from "@ever-hust/db";

/**
 * Opt-in integration test (T-2926): two applyJob calls for the same user and job at the same
 * moment, against a REAL Postgres. The AI SDK runs one step's tool calls in parallel, and a user
 * can apply from two tabs. applyJob refuses a second application for a job with an active one,
 * but that check is a plain select inside the transaction: under READ COMMITTED it does not
 * block, so two applies that both select before either commits both find nothing and both
 * insert. The job then shows twice in the user's applications and the funnel counts it twice.
 *
 *   APPLY_JOB_IT_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55442/hust_it
 *
 * The database must be a throwaway one whose name ends in `_it` or `_test` (the test inserts and
 * deletes users and jobs); the schema must already be pushed (`DATABASE_URL=… pnpm db:push`).
 * Skipped when unset.
 *
 * To make the interleaving certain rather than lucky, a holder transaction locks the user row
 * FOR UPDATE, which blocks the foreign-key check of the agent_instances insert that follows the
 * duplicate select. The first apply starts and waits there; the second starts once it does.
 * Without a lock before the select, the second also runs its select (it is not blocked), finds
 * nothing and waits at the same insert: both create an application. With the advisory lock on
 * (user, job), the second waits on that lock before its select, and once the first commits it
 * sees the first application and is refused.
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

import { applyJobTool } from "@ever-hust/ai/tools/apply-job";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ApplyResult = {
  applied: boolean;
  applicationId?: number;
  agentInstanceId?: string;
  existingApplicationId?: number;
  error?: string;
};

const DUPLICATE = "You already have an active application for this job.";

async function applyJob(userId: string, jobId: number): Promise<ApplyResult> {
  return (await applyJobTool.execute!(
    { userId, jobId } as never,
    {} as never,
  )) as ApplyResult;
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
async function behindHolder<T>(
  hold: (tx: Tx) => Promise<unknown>,
  runs: Array<() => Promise<T>>,
): Promise<T[]> {
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

  const started: Array<Promise<T>> = [];
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

suite("concurrent applyJob calls for one job against Postgres (opt-in)", () => {
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
    userId = `apply-dup-it-${suffix}`;
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.test`,
      name: "Apply Duplicate IT",
      subscriptionStatus: "active",
    });
    const [job] = await db
      .insert(jobs)
      .values({
        externalId: `apply-dup-it-${suffix}`,
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

  async function applicationIds(): Promise<number[]> {
    const rows = await db
      .select({ id: applications.id })
      .from(applications)
      .where(
        and(eq(applications.userId, userId), eq(applications.jobId, jobId)),
      );
    return rows.map((row) => row.id);
  }

  async function agentInstanceCount(): Promise<number> {
    const rows = await db
      .select({ id: agentInstances.id })
      .from(agentInstances)
      .where(
        and(eq(agentInstances.userId, userId), eq(agentInstances.jobId, jobId)),
      );
    return rows.length;
  }

  /** One apply went through and the other was refused as a duplicate of it, in either order. */
  async function expectOneApplication(results: ApplyResult[]): Promise<void> {
    const ids = await applicationIds();
    expect(ids).toHaveLength(1);
    // The refused apply rolled back before it wrote anything: no orphan agent instance.
    expect(await agentInstanceCount()).toBe(1);

    const applied = results.filter((result) => result.applied);
    const refused = results.filter((result) => !result.applied);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      applied: true,
      applicationId: ids[0],
    });
    expect(refused).toEqual([
      expect.objectContaining({
        applied: false,
        error: DUPLICATE,
        existingApplicationId: ids[0],
      }),
    ]);

    expect(
      await db
        .select({ status: userJobs.status })
        .from(userJobs)
        .where(and(eq(userJobs.userId, userId), eq(userJobs.jobId, jobId))),
    ).toEqual([{ status: "applied" }]);
  }

  it.each([
    ["the job has no user_jobs row", false],
    ["the job is favorited", true],
  ])(
    "two applies that both pass the duplicate select create one application when %s",
    async (_case, favorited) => {
      if (favorited) {
        await db
          .insert(userJobs)
          .values({ userId, jobId, status: "favorited" });
      }

      const results = await behindHolder(
        (tx) =>
          tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, userId))
            .for("update"),
        [() => applyJob(userId, jobId), () => applyJob(userId, jobId)],
      );

      await expectOneApplication(results);
    },
    30_000,
  );

  it("two applies started together (one step's parallel tool calls) create one application", async () => {
    for (let round = 0; round < 5; round++) {
      await db.delete(applications).where(eq(applications.userId, userId));
      await db.delete(agentInstances).where(eq(agentInstances.userId, userId));

      const results = await Promise.all([
        applyJob(userId, jobId),
        applyJob(userId, jobId),
      ]);

      await expectOneApplication(results);
    }
  }, 30_000);
});
