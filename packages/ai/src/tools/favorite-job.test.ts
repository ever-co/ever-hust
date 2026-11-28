/**
 * The chat favoriteJob tool must agree with the web heart (POST /api/user/favorites). The apply
 * tool marks a job's user_jobs row 'applied' with appliedAt, which the profile's applied list
 * reads. For that row the tool used to answer `favorited: true`, "It's in your favorites", while
 * the favorites list (status 'favorited' only) never showed the job. And it read the row without
 * FOR UPDATE, so an apply that committed 'applied' between its read and its update was
 * overwritten with 'favorited'. The AI SDK runs one step's tool calls in parallel (T-2899).
 *
 * The db below keeps one user_jobs row and records every statement, on the db or on a
 * transaction, with the row id an update or delete targets.
 */
jest.mock("@ever-hust/db", () => mockDbModule());
jest.mock("drizzle-orm", () => ({
  and: (...conds: unknown[]) => ({ and: conds }),
  eq: (column: unknown, value: unknown) => ({ eq: [column, value] }),
}));

import { favoriteJobTool } from "./favorite-job";

type Row = { id: number; userId: string; jobId: number; status: string };
type Settle = (value: unknown) => unknown;

const mockState: { row: Row | null; calls: string[] } = {
  row: null,
  calls: [],
};

/** The row id in `eq(userJobs.id, <id>)`, the only where clause the tool writes with. */
function mockTargetId(cond: unknown): unknown {
  const eq = (cond as { eq?: [unknown, unknown] }).eq;
  return eq && eq[0] === "id" ? eq[1] : "?";
}

/** A lazy thenable: the statement runs only when awaited, like a drizzle query builder. */
function mockRun(run: () => unknown) {
  return {
    then: (resolve: Settle, reject: Settle) =>
      new Promise((done) => done(run())).then(resolve, reject),
  };
}

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
        ...mockRun(() => {
          mockState.calls.push(`${scope} select${lock ? ` for ${lock}` : ""}`);
          const row = mockState.row;
          return row ? [{ id: row.id, status: row.status }] : [];
        }),
      };
      return query;
    },
    update: () => ({
      set: (values: { status: string }) => ({
        where: (cond: unknown) =>
          mockRun(() => {
            const id = mockTargetId(cond);
            mockState.calls.push(`${scope} update ${values.status} id=${id}`);
            if (mockState.row?.id === id) mockState.row.status = values.status;
          }),
      }),
    }),
    delete: () => ({
      where: (cond: unknown) =>
        mockRun(() => {
          const id = mockTargetId(cond);
          mockState.calls.push(`${scope} delete id=${id}`);
          if (mockState.row?.id === id) mockState.row = null;
        }),
    }),
    insert: () => ({
      values: (values: Omit<Row, "id">) =>
        mockRun(() => {
          mockState.calls.push(
            `${scope} insert ${values.userId}/${values.jobId} ${values.status}`,
          );
          mockState.row = { id: 99, ...values };
        }),
    }),
  };
}

function mockDbModule() {
  return {
    db: {
      ...mockQueries("db"),
      transaction: async <T>(
        fn: (tx: ReturnType<typeof mockQueries>) => Promise<T>,
      ) => {
        mockState.calls.push("transaction");
        return fn(mockQueries("tx"));
      },
    },
    userJobs: { id: "id", userId: "userId", jobId: "jobId", status: "status" },
  };
}

function resetRow(status: string | null) {
  mockState.row =
    status === null ? null : { id: 7, userId: "u1", jobId: 42, status };
  mockState.calls = [];
}

function favorite() {
  return favoriteJobTool.execute!(
    { jobId: 42, userId: "u1" } as never,
    {} as never,
  );
}

/** Statements that ran on the db itself rather than inside the transaction. */
function outsideTransaction() {
  return mockState.calls.filter((call) => call.startsWith("db "));
}

describe("favoriteJobTool", () => {
  it("leaves an applied job alone and says it is not in favorites", async () => {
    resetRow("applied");

    const r = await favorite();

    expect(r).toEqual({
      jobId: 42,
      favorited: false,
      // The same text as the web heart's 409 (apps/web/app/api/user/favorites/route.ts)
      message:
        "You applied to this job, so it stays in your applications and can't be added to favorites.",
    });
    expect(mockState.calls).toEqual(["transaction", "tx select for update"]);
    expect(mockState.row).toEqual({
      id: 7,
      userId: "u1",
      jobId: 42,
      status: "applied",
    });
  });

  it("reads the row FOR UPDATE inside the transaction that writes it", async () => {
    resetRow("viewed");

    await favorite();

    expect(mockState.calls).toEqual([
      "transaction",
      "tx select for update",
      "tx update favorited id=7",
    ]);
  });

  it("marks a viewed job favorited by the id it read", async () => {
    resetRow("viewed");

    const r = await favorite();

    expect(r).toEqual({
      jobId: 42,
      favorited: true,
      message: "Job added to favorites!",
    });
    expect(mockState.calls).toContain("tx update favorited id=7");
    expect(outsideTransaction()).toEqual([]);
    expect(mockState.row?.status).toBe("favorited");
  });

  it("removes a favorited job", async () => {
    resetRow("favorited");

    const r = await favorite();

    expect(r).toEqual({
      jobId: 42,
      favorited: false,
      message: "Job removed from favorites.",
    });
    expect(mockState.calls).toContain("tx delete id=7");
    expect(outsideTransaction()).toEqual([]);
    expect(mockState.row).toBeNull();
  });

  it("inserts a favorite when the user has no row for the job", async () => {
    resetRow(null);

    const r = await favorite();

    expect(r).toEqual({
      jobId: 42,
      favorited: true,
      message: "Job added to favorites!",
    });
    expect(mockState.calls).toContain("tx insert u1/42 favorited");
    expect(outsideTransaction()).toEqual([]);
  });

  it("does not touch the db without a user", async () => {
    resetRow("viewed");

    const r = await favoriteJobTool.execute!(
      { jobId: 42 } as never,
      {} as never,
    );

    expect(r).toEqual({
      jobId: 42,
      favorited: false,
      message: "Not authenticated",
    });
    expect(mockState.calls).toEqual([]);
  });
});
