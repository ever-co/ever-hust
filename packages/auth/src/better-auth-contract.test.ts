/**
 * What this package relies on from the real better-auth, checked against the installed release.
 *
 * - The Jest stand-in for better-auth/api (./test-stubs/better-auth-api.ts) must build the same
 *   APIError as the real one, or the guard tests prove nothing.
 * - The guest self-delete guard matches one path. If the anonymous plugin mounts its delete
 *   endpoint under another path, the guard lets it through without any error.
 * - The Drizzle auth tables must hold every field better-auth writes for the options index.ts
 *   passes (core tables, the anonymous plugin, the extra user fields). Since 1.7 the Drizzle
 *   adapter checks this itself before every request and fails the request on a mismatch, so a
 *   field a new release adds needs a migration before the bump ships.
 *
 * Here index.ts builds a REAL auth instance: better-auth, its Drizzle adapter, the anonymous
 * plugin and better-auth/api are the installed modules, the tables are the real Drizzle schema.
 * Only the database client is a stand-in; nothing below runs a query. better-auth ships ES
 * modules only and this Jest setup runs CJS, so the real modules come from Node's own loader
 * (see tests/jest/unpdf.cjs for the same approach).
 */
import { getTableColumns, type Column, type Table } from "drizzle-orm";
import * as stub from "./test-stubs/better-auth-api";
import { DELETE_ANONYMOUS_USER_PATH, DELETE_ANONYMOUS_USER_REFUSED } from "./anonymous-self-delete-guard";

jest.mock("better-auth", () =>
  process.getBuiltinModule("node:module").createRequire(__filename)("better-auth"),
);
// jest.config.ts maps better-auth/api to the stand-in for this project; here it is the real one.
jest.mock("better-auth/api", () =>
  process.getBuiltinModule("node:module").createRequire(__filename)("better-auth/api"),
);
jest.mock("better-auth/plugins", () =>
  process.getBuiltinModule("node:module").createRequire(__filename)("better-auth/plugins"),
);
// The real adapter, which also keeps the config index.ts hands it (the model -> table map).
jest.mock("better-auth/adapters/drizzle", () => {
  const real = process.getBuiltinModule("node:module").createRequire(__filename)(
    "better-auth/adapters/drizzle",
  ) as { drizzleAdapter: (db: unknown, config: unknown) => unknown };
  const configs: unknown[] = [];
  return {
    configs,
    drizzleAdapter: (db: unknown, config: unknown) => {
      configs.push(config);
      return real.drizzleAdapter(db, config);
    },
  };
});
jest.mock("@ever-hust/db/client", () => ({ db: {} }));
jest.mock("./migrate-anonymous-user", () => ({ migrateAnonymousUserData: jest.fn() }));
jest.mock("@ever-hust/supabase/storage", () => ({ deleteUserFiles: jest.fn() }));

process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-characters-long";
process.env.BETTER_AUTH_URL = "http://localhost:8443";

import * as drizzleAdapterModule from "better-auth/adapters/drizzle";
import { auth } from "./index";

const { createRequire } = process.getBuiltinModule("node:module");
const realRequire = createRequire(__filename);

type RealApi = {
  APIError: new (status: string, body?: { message?: string }) => Error & {
    status: string;
    statusCode: number;
    body?: { message?: string };
  };
  createAuthMiddleware: (handler: unknown) => unknown;
};
type FieldDef = { type: string | string[]; required?: boolean; unique?: boolean; fieldName?: string };
type TableDef = { modelName: string; fields: Record<string, FieldDef> };
type Endpoint = { path: string; options?: { method?: string | string[] } };

const realApi = realRequire("better-auth/api") as RealApi;
const realDb = realRequire("better-auth/db") as { getAuthTables: (options: unknown) => Record<string, TableDef> };
const realPlugins = realRequire("better-auth/plugins") as {
  anonymous: (options?: Record<string, unknown>) => { endpoints?: Record<string, Endpoint> };
};

const schema = (drizzleAdapterModule as unknown as { configs: { schema: Record<string, Table> }[] })
  .configs[0]!.schema;

function prototypeNames(value: object): string[] {
  const names: string[] = [];
  for (let p = Object.getPrototypeOf(value); p; p = Object.getPrototypeOf(p)) {
    names.push((p as { constructor: { name: string } }).constructor.name);
  }
  return names;
}

describe("the better-auth/api stand-in matches the real module", () => {
  it.each(["BAD_REQUEST", "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "INTERNAL_SERVER_ERROR"])(
    "APIError(%s) has the same name, status, statusCode and message",
    (status) => {
      const real = new realApi.APIError(status, { message: "refused" });
      const fake = new stub.APIError(status, { message: "refused" });
      // The real class comes from Node's realm, not Jest's, so instanceof Error can't be used.
      expect(prototypeNames(real)).toContain("Error");
      expect(prototypeNames(fake)).toContain("Error");
      expect({
        name: fake.name,
        status: fake.status,
        statusCode: fake.statusCode,
        message: fake.message,
        bodyMessage: fake.body?.message,
      }).toEqual({
        name: real.name,
        status: real.status,
        statusCode: real.statusCode,
        message: real.message,
        bodyMessage: real.body?.message,
      });
    },
  );

  it("createAuthMiddleware exists in the real module", () => {
    expect(typeof realApi.createAuthMiddleware).toBe("function");
  });
});

describe("the guest self-delete guard matches the real anonymous plugin", () => {
  it("the plugin mounts its delete endpoint at the path the guard refuses", () => {
    const endpoints = Object.values(
      realPlugins.anonymous({ emailDomainName: "hust.local", disableDeleteAnonymousUser: true })
        .endpoints ?? {},
    );
    const del = endpoints.find((e) => e.path === DELETE_ANONYMOUS_USER_PATH);
    expect(endpoints.map((e) => e.path)).toContain(DELETE_ANONYMOUS_USER_PATH);
    expect([del?.options?.method].flat()).toContain("POST");
  });

  it("the real auth handler answers POST /api/auth/delete-anonymous-user with 403", async () => {
    const res = await auth.handler(
      new Request(`http://localhost:8443/api/auth${DELETE_ANONYMOUS_USER_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:8443" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message?: string }).message).toBe(DELETE_ANONYMOUS_USER_REFUSED);
  });
});

/** better-auth field types to the Drizzle column dataType that stores them. */
const DATA_TYPES: Record<string, string[]> = {
  string: ["string"],
  boolean: ["boolean"],
  date: ["date"],
  json: ["json"],
  number: ["number", "bigint"],
  "string[]": ["array", "json"],
  "number[]": ["array", "json"],
};

describe("the Drizzle auth tables hold every field better-auth writes", () => {
  it("better-auth's own schema check passes (it runs before every auth request)", async () => {
    await expect(auth.api.ok()).resolves.toEqual({ ok: true });
    const res = await auth.handler(new Request("http://localhost:8443/api/auth/ok"));
    expect(res.status).toBe(200);
  });

  const tables = Object.values(realDb.getAuthTables(auth.options));

  it("covers the four core models", () => {
    expect(tables.map((t) => t.modelName)).toEqual(
      expect.arrayContaining(["user", "session", "account", "verification"]),
    );
  });

  const rows = tables.flatMap((t) =>
    Object.entries(t.fields).map(([key, field]) => [t.modelName, field.fieldName ?? key, field] as const),
  );

  it.each(rows)("%s.%s has a column of the same type, NOT NULL and UNIQUE where required", (model, fieldName, field) => {
    const table = schema[model];
    expect(table).toBeDefined();
    // The Drizzle adapter looks a field up by the table's JS key (see user-fields.ts).
    const column = (getTableColumns(table!) as Record<string, Column>)[fieldName];
    expect(column).toBeDefined();
    const type = Array.isArray(field.type) ? "string" : field.type;
    expect(DATA_TYPES[type] ?? [type]).toContain(column!.dataType);
    if (field.required !== false) expect(column!.notNull).toBe(true);
    if (field.unique) expect(column!.isUnique).toBe(true);
  });
});
