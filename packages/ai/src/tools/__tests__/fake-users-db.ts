/**
 * A stand-in for `@ever-hust/db` that keeps one user's row and records every statement a
 * preferences writer runs, on the db itself or on a transaction, so a test can check that the
 * row is read under `FOR UPDATE` inside the transaction that writes it back (T-2878).
 *
 * Use it from a test file with:
 *
 *   jest.mock("@ever-hust/db", () => require("./__tests__/fake-users-db").fakeDbModule());
 *   import { fakeUsers, resetFakeUsers } from "./__tests__/fake-users-db";
 */

type Row = {
  preferences: Record<string, unknown> | null;
  [column: string]: unknown;
};

export const fakeUsers: {
  /** The user's row; null when the user does not exist. */
  row: Row | null;
  /**
   * The statements in the order they ran, e.g. "transaction", "tx select for update",
   * "tx update preferences,updatedAt", "db select", "db update preferences,updatedAt".
   */
  calls: string[];
} = { row: null, calls: [] };

/** Start a test with a user whose preferences are `preferences` (no row when null). */
export function resetFakeUsers(preferences: Record<string, unknown> | null) {
  fakeUsers.row =
    preferences === null ? null : { preferences: { ...preferences } };
  fakeUsers.calls = [];
}

type Settle = (value: unknown) => unknown;

function queries(scope: "db" | "tx") {
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
          fakeUsers.calls.push(`${scope} select${lock ? ` for ${lock}` : ""}`);
          const rows = fakeUsers.row
            ? [{ preferences: fakeUsers.row.preferences }]
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
            fakeUsers.calls.push(
              `${scope} update ${Object.keys(values).sort().join(",")}`,
            );
            if (fakeUsers.row) Object.assign(fakeUsers.row, values);
            return Promise.resolve(undefined).then(resolve, reject);
          },
        }),
      }),
    }),
  };
}

export function fakeDbModule() {
  return {
    db: {
      ...queries("db"),
      transaction: async <T>(
        fn: (tx: ReturnType<typeof queries>) => Promise<T>,
      ) => {
        fakeUsers.calls.push("transaction");
        return fn(queries("tx"));
      },
    },
    users: { id: "id", preferences: "preferences" },
  };
}
