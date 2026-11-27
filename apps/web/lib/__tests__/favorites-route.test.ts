/**
 * The favorite and hide toggles must leave a job the user applied to alone. The apply tool
 * (packages/ai/src/tools/apply-job.ts) marks the user_jobs row 'applied' with appliedAt, which
 * the profile's applied list and the inbox job matching read. POST /api/user/favorites used to
 * set any row that was not 'favorited' to 'favorited', so a click on the heart of an applied
 * job lost 'applied', and a second click deleted the row and appliedAt with it. DELETE
 * /api/user/favorites deleted the row whatever its status, and POST /api/user/hidden-jobs
 * upserted 'hidden' over 'applied' (the unhide DELETE then removed the row).
 *
 * The db below is an in-memory user_jobs table that answers the routes' query shapes and
 * records every statement with its where clause.
 */
type Row = Record<string, unknown>;
type Column = { column: string };
type Cond =
  | { op: "eq" | "ne"; col: Column; val: unknown }
  | { op: "and"; conds: Cond[] };

function mockColumns(names: string[]): Record<string, Column> {
  return Object.fromEntries(names.map((column) => [column, { column }]));
}

const mockUserJobs = mockColumns([
  "id",
  "userId",
  "jobId",
  "status",
  "appliedAt",
  "createdAt",
  "updatedAt",
]);

const mockState = {
  rows: [] as Row[],
  /** Every statement in order, with the where clause it ran with. */
  statements: [] as Array<{ sql: string; where?: Cond }>,
  nextId: 1,
};

function mockMatches(row: Row, cond?: Cond): boolean {
  if (!cond) return true;
  if (cond.op === "and") return cond.conds.every((c) => mockMatches(row, c));
  if (cond.op === "ne") return row[cond.col.column] !== cond.val;
  return row[cond.col.column] === cond.val;
}

/** A lazy thenable: the statement runs only when awaited, like a drizzle query builder. */
function mockLazy<T>(run: () => T) {
  return {
    then<R1 = T, R2 = never>(
      onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
      onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
    ): Promise<R1 | R2> {
      return new Promise<T>((resolve) => resolve(run())).then(
        onFulfilled,
        onRejected,
      );
    },
  };
}

function mockProject(
  projection: Record<string, Column> | undefined,
  rows: Row[],
) {
  return rows.map((r) => {
    if (!projection) return { ...r };
    const out: Row = {};
    for (const [key, col] of Object.entries(projection))
      out[key] = r[col.column];
    return out;
  });
}

function mockInsertRow(values: Row): Row {
  if (
    mockState.rows.some(
      (r) => r.userId === values.userId && r.jobId === values.jobId,
    )
  ) {
    throw new Error(
      'duplicate key value violates unique constraint "user_jobs_unique"',
    );
  }
  const row: Row = { id: mockState.nextId++, appliedAt: null, ...values };
  mockState.rows.push(row);
  return row;
}

function mockMakeDb() {
  const record = (sql: string, where?: Cond) =>
    mockState.statements.push({ sql, where });

  return {
    select: (projection: Record<string, Column>) => ({
      from: () => ({
        where: (cond: Cond) => {
          const read = (n = Infinity) => {
            record("select", cond);
            return mockProject(
              projection,
              mockState.rows.filter((r) => mockMatches(r, cond)).slice(0, n),
            );
          };
          return {
            ...mockLazy(() => read()),
            limit: (n: number) => mockLazy(() => read(n)),
          };
        },
      }),
    }),
    update: () => ({
      set: (values: Row) => ({
        where: (cond: Cond) =>
          mockLazy(() => {
            record("update", cond);
            for (const row of mockState.rows.filter((r) =>
              mockMatches(r, cond),
            )) {
              Object.assign(row, values);
            }
          }),
      }),
    }),
    delete: () => ({
      where: (cond: Cond) =>
        mockLazy(() => {
          record("delete", cond);
          mockState.rows = mockState.rows.filter((r) => !mockMatches(r, cond));
        }),
    }),
    insert: () => ({
      values: (values: Row) => ({
        ...mockLazy(() => {
          record("insert");
          mockInsertRow(values);
        }),
        // ON CONFLICT (user_id, job_id) DO UPDATE SET ... [WHERE setWhere] [RETURNING ...]
        onConflictDoUpdate: (config: { set: Row; setWhere?: Cond }) => {
          const upsert = (): Row[] => {
            record("upsert", config.setWhere);
            const existing = mockState.rows.find(
              (r) => r.userId === values.userId && r.jobId === values.jobId,
            );
            if (!existing) return [mockInsertRow(values)];
            if (!mockMatches(existing, config.setWhere)) return [];
            Object.assign(existing, config.set);
            return [existing];
          };
          return {
            ...mockLazy(() => void upsert()),
            returning: (projection?: Record<string, Column>) =>
              mockLazy(() => mockProject(projection, upsert())),
          };
        },
      }),
    }),
  };
}

const mockDb = {
  ...mockMakeDb(),
  transaction: async <T>(fn: (tx: object) => Promise<T>): Promise<T> =>
    fn(mockMakeDb()),
};

jest.mock("@ever-hust/db", () => ({ db: mockDb, userJobs: mockUserJobs }));
jest.mock("drizzle-orm", () => ({
  eq: (col: Column, val: unknown) => ({ op: "eq", col, val }),
  ne: (col: Column, val: unknown) => ({ op: "ne", col, val }),
  and: (...conds: Cond[]) => ({ op: "and", conds }),
}));
jest.mock("../get-session-user", () => ({
  requireSessionUser: async () => ({ id: "user-1", email: "user@example.com" }),
}));
jest.mock("../rate-limit", () => ({ applyRateLimit: () => null }));

import {
  DELETE as deleteFavorite,
  POST as toggleFavorite,
} from "../../app/api/user/favorites/route";
import {
  DELETE as unhideJob,
  POST as hideJob,
} from "../../app/api/user/hidden-jobs/route";

const APPLIED_AT = new Date("2026-11-20T10:00:00.000Z");

function seed(status: string, jobId = 7): Row {
  const row: Row = {
    id: mockState.nextId++,
    userId: "user-1",
    jobId,
    status,
    appliedAt: status === "applied" ? APPLIED_AT : null,
  };
  mockState.rows.push(row);
  return { ...row };
}

function jsonRequest(method: string, path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const favorite = (jobId = 7) =>
  toggleFavorite(jsonRequest("POST", "/api/user/favorites", { jobId }));
const unfavorite = (jobId = 7) =>
  deleteFavorite(jsonRequest("DELETE", "/api/user/favorites", { jobId }));
const hide = (jobId = 7) =>
  hideJob(jsonRequest("POST", "/api/user/hidden-jobs", { jobId }));
const unhide = (jobId = 7) =>
  unhideJob(
    new Request(`http://localhost/api/user/hidden-jobs?jobId=${jobId}`, {
      method: "DELETE",
    }),
  );

/** The SQL verbs that ran, e.g. ["select", "update"]. */
const verbs = () => mockState.statements.map((s) => s.sql);

/** Every eq(column, value) in a where clause, as "column=value". */
function eqTerms(cond?: Cond): string[] {
  if (!cond) return [];
  if (cond.op === "and") return cond.conds.flatMap(eqTerms);
  return cond.op === "eq" ? [`${cond.col.column}=${String(cond.val)}`] : [];
}

const rowFor = (jobId = 7) => mockState.rows.find((r) => r.jobId === jobId);

beforeEach(() => {
  mockState.rows = [];
  mockState.statements = [];
  mockState.nextId = 1;
});

describe("POST /api/user/favorites", () => {
  it("a job the user applied to: answers 409, runs no write, keeps 'applied' and appliedAt", async () => {
    const applied = seed("applied");

    // Two clicks: the first used to turn 'applied' into 'favorited', the second deleted the row.
    for (let click = 0; click < 2; click++) {
      const res = await favorite();
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/applied/i);
    }

    expect(verbs()).toEqual(["select", "select"]);
    expect(mockState.rows).toEqual([applied]);
  });

  it("a favorited job: removes the favorite", async () => {
    seed("favorited");

    const res = await favorite();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: 7, favorited: false });
    expect(rowFor()).toBeUndefined();
  });

  it("a viewed job: becomes a favorite", async () => {
    const viewed = seed("viewed");

    const res = await favorite();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: 7, favorited: true });
    expect(rowFor()).toMatchObject({ id: viewed.id, status: "favorited" });
  });

  it("a job with no row yet: inserts a favorite", async () => {
    const res = await favorite();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: 7, favorited: true });
    expect(rowFor()).toMatchObject({ userId: "user-1", status: "favorited" });
  });

  it("updates and deletes the row it read, by its id", async () => {
    const viewed = seed("viewed");

    await favorite(); // viewed -> favorited
    await favorite(); // favorited -> removed

    const writes = mockState.statements.filter((s) => s.sql !== "select");
    expect(writes.map((s) => s.sql)).toEqual(["update", "delete"]);
    for (const write of writes) {
      expect(eqTerms(write.where)).toEqual([`id=${String(viewed.id)}`]);
    }
  });
});

describe("DELETE /api/user/favorites", () => {
  it("removes only a 'favorited' row: a job the user applied to keeps its row", async () => {
    const applied = seed("applied");

    const res = await unfavorite();

    expect(res.status).toBe(200);
    const deletes = mockState.statements.filter((s) => s.sql === "delete");
    expect(deletes).toHaveLength(1);
    expect(eqTerms(deletes[0]!.where)).toContain("status=favorited");
    expect(mockState.rows).toEqual([applied]);
  });

  it("still removes a favorite", async () => {
    seed("favorited");
    seed("favorited", 8);

    const res = await unfavorite();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: 7, favorited: false });
    expect(mockState.rows.map((r) => r.jobId)).toEqual([8]);
  });
});

describe("POST /api/user/hidden-jobs", () => {
  it("a job the user applied to: answers 409 and leaves the 'applied' row unchanged", async () => {
    const applied = seed("applied");

    const res = await hide();

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/applied/i);
    expect(mockState.rows).toEqual([applied]);

    // Unhiding afterwards removes only a 'hidden' row, so the applied row stays.
    expect((await unhide()).status).toBe(200);
    expect(mockState.rows).toEqual([applied]);
  });

  it("a viewed or favorited job: is hidden", async () => {
    seed("viewed");
    seed("favorited", 8);

    for (const jobId of [7, 8]) {
      const res = await hide(jobId);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ hidden: true, jobId });
      expect(rowFor(jobId)?.status).toBe("hidden");
    }
  });

  it("a job with no row yet: inserts a hidden row, and unhide removes it", async () => {
    const res = await hide();

    expect(res.status).toBe(200);
    expect(rowFor()).toMatchObject({ userId: "user-1", status: "hidden" });

    expect((await unhide()).status).toBe(200);
    expect(rowFor()).toBeUndefined();
  });
});
