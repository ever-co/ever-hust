/**
 * applyJob marks the job's user_jobs row 'applied' with appliedAt, which the profile's applied
 * list and the inbox job matching read (T-2900). It must do that in ONE statement, an upsert on
 * the (user_id, job_id) unique key: a select followed by an update or an insert races the
 * favorite toggles. An unfavorite that deletes the row after the select leaves the update with
 * no row to change (the application is created, the 'applied' row is not), and a favorite
 * insert that lands after the select makes the insert hit user_jobs_unique and roll the whole
 * application back. The race itself is proven against Postgres in
 * apps/web/lib/__tests__/apply-job-user-jobs.integration.test.ts.
 *
 * Two applies for the same user and job must create ONE application (T-2926). The duplicate
 * check is a plain select, which does not block under READ COMMITTED, so the transaction takes
 * an advisory lock on (user, job) before it: the second apply waits for the first to commit and
 * then sees its application. Proven against Postgres in
 * apps/web/lib/__tests__/apply-job-duplicate.integration.test.ts.
 */

type MockSql = { strings: string[]; values: unknown[] };

type MockCall = {
  scope: "db" | "tx";
  op: "select" | "insert" | "update" | "delete" | "execute";
  table: string;
  values?: Record<string, unknown>;
  onConflictDoUpdate?: { target: unknown; set: Record<string, unknown> };
  query?: MockSql;
  where?: unknown;
};

const mockDb: {
  /** The users row the tool reads; null when the user does not exist. */
  user: Record<string, unknown> | null;
  /** The jobs row the tool reads; null when the job does not exist. */
  job: Record<string, unknown> | null;
  /** What a select on applications returns. */
  applications: Array<{ id: number; status: string }>;
  /** What a select on user_jobs returns (only code that reads the row first sees it). */
  userJobs: Array<{ id: number }>;
  /** Every statement, in the order it ran. */
  calls: MockCall[];
} = { user: null, job: null, applications: [], userJobs: [], calls: [] };

jest.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
  ne: (column: unknown, value: unknown) => ({ ne: [column, value] }),
  and: (...conditions: unknown[]) => ({ and: conditions }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]): MockSql => ({
    strings: [...strings],
    values,
  }),
}));

jest.mock("@ever-hust/db", () => {
  type Table = { mockTable: string };
  type Settle = (value: unknown) => unknown;
  const table = (name: string, columns: string[]) =>
    Object.fromEntries([
      ["mockTable", name],
      ...columns.map((column) => [column, `${name}.${column}`]),
    ]) as Table & Record<string, string>;

  const selectRows = (name: string): unknown[] => {
    if (name === "users") return mockDb.user ? [mockDb.user] : [];
    if (name === "jobs") return mockDb.job ? [mockDb.job] : [];
    if (name === "applications") return mockDb.applications;
    if (name === "user_jobs") return mockDb.userJobs;
    return [];
  };
  const insertedRows = (name: string): unknown[] => {
    if (name === "agent_instances") return [{ id: "agent-1" }];
    if (name === "applications") return [{ id: 42 }];
    return [];
  };

  /** A query that records `call` and resolves to `rows` when it is awaited. */
  const settles = (call: () => MockCall, rows: () => unknown[]) => ({
    then: (resolve: Settle, reject: Settle) => {
      mockDb.calls.push(call());
      return Promise.resolve(rows()).then(resolve, reject);
    },
  });

  const queries = (scope: "db" | "tx") => ({
    select: () => ({
      from: (from: Table) => {
        let where: unknown;
        const query = {
          where: (condition: unknown) => {
            where = condition;
            return query;
          },
          limit: () => query,
          for: () => query,
          ...settles(
            () => ({ scope, op: "select", table: from.mockTable, where }),
            () => selectRows(from.mockTable),
          ),
        };
        return query;
      },
    }),
    insert: (into: Table) => ({
      values: (values: Record<string, unknown>) => {
        let onConflictDoUpdate: MockCall["onConflictDoUpdate"];
        const query = {
          onConflictDoUpdate: (
            config: NonNullable<MockCall["onConflictDoUpdate"]>,
          ) => {
            onConflictDoUpdate = config;
            return query;
          },
          returning: () => query,
          ...settles(
            () => ({
              scope,
              op: "insert",
              table: into.mockTable,
              values,
              ...(onConflictDoUpdate ? { onConflictDoUpdate } : {}),
            }),
            () => insertedRows(into.mockTable),
          ),
        };
        return query;
      },
    }),
    update: (target: Table) => ({
      set: (values: Record<string, unknown>) => ({
        where: () =>
          settles(
            () => ({ scope, op: "update", table: target.mockTable, values }),
            () => [],
          ),
      }),
    }),
    delete: (target: Table) => ({
      where: () =>
        settles(
          () => ({ scope, op: "delete", table: target.mockTable }),
          () => [],
        ),
    }),
    execute: (query: MockSql) =>
      settles(
        () => ({ scope, op: "execute", table: "", query }),
        () => [],
      ),
  });

  return {
    db: {
      ...queries("db"),
      transaction: async <T>(
        fn: (tx: ReturnType<typeof queries>) => Promise<T>,
      ) => fn(queries("tx")),
    },
    users: table("users", ["id", "name", "email", "subscriptionStatus"]),
    jobs: table("jobs", ["id", "title", "companyName", "jobUrl", "applyUrl"]),
    applications: table("applications", ["id", "status", "userId", "jobId"]),
    agentInstances: table("agent_instances", ["id"]),
    userJobs: table("user_jobs", ["id", "userId", "jobId", "status"]),
  };
});

import { applyJobTool } from "./apply-job";
import { proOnlyToolError } from "../payments";

const APPLY_URL = "https://jobs.example.test/apply/7";

const run = (input: Record<string, unknown>) =>
  applyJobTool.execute!(input as never, {} as never) as Promise<
    Record<string, unknown>
  >;

/** The statements in order, e.g. "db select users", "tx upsert user_jobs" or "tx advisory lock". */
const statements = () =>
  mockDb.calls.map((call) => {
    if (call.op === "execute") {
      return call.query!.strings.join("?").includes("pg_advisory_xact_lock")
        ? `${call.scope} advisory lock`
        : `${call.scope} execute`;
    }
    return `${call.scope} ${call.onConflictDoUpdate ? "upsert" : call.op} ${call.table}`;
  });

describe("applyJobTool", () => {
  beforeEach(() => {
    mockDb.user = {
      name: "Jane Doe",
      email: "jane.doe@example.test",
      subscriptionStatus: "active",
    };
    mockDb.job = {
      title: "Staff Engineer",
      companyName: "Acme",
      jobUrl: "https://jobs.example.test/7",
      applyUrl: APPLY_URL,
    };
    mockDb.applications = [];
    mockDb.userJobs = [];
    mockDb.calls = [];
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ["the job has no user_jobs row yet", []],
    ["the job is favorited", [{ id: 5 }]],
  ])(
    "marks the job applied with one user_jobs upsert on (userId, jobId) when %s",
    async (_case, userJobRows) => {
      mockDb.userJobs = userJobRows;

      const result = await run({ userId: "u1", jobId: 7 });

      expect(result).toMatchObject({
        applied: true,
        applicationId: 42,
        agentInstanceId: "agent-1",
        applicationUrl: APPLY_URL,
      });
      // No read of the user_jobs row and no update by its id: the upsert is the only
      // user_jobs statement, inside the transaction that creates the application.
      expect(statements()).toEqual([
        "db select users",
        "db select jobs",
        "tx advisory lock",
        "tx select applications",
        "tx insert agent_instances",
        "tx insert applications",
        "tx upsert user_jobs",
      ]);

      const upsert = mockDb.calls.find((call) => call.table === "user_jobs")!;
      expect(upsert.values).toEqual({
        userId: "u1",
        jobId: 7,
        status: "applied",
        appliedAt: expect.any(Date),
      });
      expect(upsert.onConflictDoUpdate).toEqual({
        target: ["user_jobs.userId", "user_jobs.jobId"],
        set: {
          status: "applied",
          appliedAt: expect.any(Date),
          updatedAt: expect.any(Date),
        },
      });
      // The inserted row and the updated row get the same applied time.
      expect(upsert.onConflictDoUpdate!.set.appliedAt).toEqual(
        upsert.values!.appliedAt,
      );
    },
  );

  it("refuses a duplicate application and writes nothing", async () => {
    mockDb.applications = [{ id: 9, status: "in_progress" }];

    const result = await run({ userId: "u1", jobId: 7 });

    expect(result).toEqual({
      applied: false,
      error: "You already have an active application for this job.",
      existingApplicationId: 9,
      applicationUrl: APPLY_URL,
    });
    expect(statements()).toEqual([
      "db select users",
      "db select jobs",
      "tx advisory lock",
      "tx select applications",
    ]);
  });

  it("leaves failed applications out of the duplicate select itself, not after limit(1)", async () => {
    await run({ userId: "u1", jobId: 7 });

    // With the status checked after `limit(1)`, an older failed row came back first and hid
    // the user's active application, so a second apply went through.
    const check = mockDb.calls.find(
      (call) => call.op === "select" && call.table === "applications",
    )!;
    expect(check.where).toEqual({
      and: [
        { eq: ["applications.userId", "u1"] },
        { eq: ["applications.jobId", 7] },
        { ne: ["applications.status", "failed"] },
      ],
    });
  });

  it("locks (user, job) inside the transaction before the duplicate check (T-2926)", async () => {
    const result = await run({ userId: "u1", jobId: 7 });

    expect(result).toMatchObject({ applied: true, applicationId: 42 });
    // The duplicate check is a plain select, which does not block another apply under READ
    // COMMITTED. Only a lock taken BEFORE it, in the same transaction, makes the second apply
    // wait for the first to commit and then see its application.
    const lockIndex = mockDb.calls.findIndex((call) => call.op === "execute");
    const checkIndex = mockDb.calls.findIndex(
      (call) => call.op === "select" && call.table === "applications",
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(lockIndex).toBeLessThan(checkIndex);

    const lock = mockDb.calls[lockIndex]!;
    // Transaction-scoped (released at commit or rollback), not a session lock left behind on a
    // pooled connection.
    expect(lock.scope).toBe("tx");
    expect(lock.query!.strings.join("?")).toBe(
      "select pg_advisory_xact_lock(hashtext('apply-job:' || ?), ?)",
    );
    // Keyed on the user AND the job: applies to other jobs do not wait on each other.
    expect(lock.query!.values).toEqual(["u1", 7]);
  });

  it("refuses a user without Pro and opens no transaction", async () => {
    mockDb.user = { ...mockDb.user, subscriptionStatus: "free" };

    const result = await run({ userId: "u1", jobId: 7 });

    expect(result).toEqual({
      applied: false,
      error: proOnlyToolError("Job applications require a Pro subscription."),
      requiresUpgrade: true,
    });
    expect(statements()).toEqual(["db select users"]);
  });
});
