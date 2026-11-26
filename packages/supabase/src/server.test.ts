/**
 * getSupabaseServer must read its settings when it runs. Next.js inlines every
 * `process.env.NEXT_PUBLIC_*` it finds into the server bundle at build time; the web image is
 * built without the Supabase values, so the bundled client always threw "Missing Supabase
 * server environment variables" and no CV or avatar upload could work in any environment,
 * although the pods had the values at runtime.
 */
import { readFileSync } from "fs";
import { join } from "path";

const mockCreateClient = jest.fn((url: string, key: string) => ({ url, key }));
jest.mock("@supabase/supabase-js", () => ({
  createClient: (url: string, key: string) => mockCreateClient(url, key),
}));

import { getSupabaseServer, resetSupabaseServerForTests } from "./server";

const NAMES = ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const env = process.env as Record<string, string | undefined>;
const saved = Object.fromEntries(NAMES.map((n) => [n, env[n]]));

beforeEach(() => {
  for (const n of NAMES) delete env[n];
  mockCreateClient.mockClear();
  resetSupabaseServerForTests();
});
afterAll(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete env[n];
    else env[n] = saved[n];
  }
});

describe("getSupabaseServer", () => {
  it("uses NEXT_PUBLIC_SUPABASE_URL and the service-role key set at runtime", () => {
    env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.example.test";
    env.SUPABASE_SERVICE_ROLE_KEY = "service-role";

    getSupabaseServer();

    expect(mockCreateClient).toHaveBeenCalledWith("https://supabase.example.test", "service-role");
  });

  it("prefers SUPABASE_URL when both are set", () => {
    env.SUPABASE_URL = "http://storage.internal:8000";
    env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.example.test";
    env.SUPABASE_SERVICE_ROLE_KEY = "service-role";

    getSupabaseServer();

    expect(mockCreateClient).toHaveBeenCalledWith("http://storage.internal:8000", "service-role");
  });

  it("treats an empty value as unset", () => {
    env.SUPABASE_URL = "";
    env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.example.test";
    env.SUPABASE_SERVICE_ROLE_KEY = "service-role";

    getSupabaseServer();

    expect(mockCreateClient).toHaveBeenCalledWith("https://supabase.example.test", "service-role");
  });

  it("throws, naming the variables, when the URL or key is missing", () => {
    env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.example.test";
    expect(() => getSupabaseServer()).toThrow(/SUPABASE_SERVICE_ROLE_KEY must be set/);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("creates the client once", () => {
    env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.example.test";
    env.SUPABASE_SERVICE_ROLE_KEY = "service-role";

    expect(getSupabaseServer()).toBe(getSupabaseServer());
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
  });
});

describe("server-side Supabase code and build-time inlining", () => {
  // A literal `process.env.NEXT_PUBLIC_…` in server code is replaced with its build-time value
  // (undefined in the image build), which is what broke every storage call.
  it.each(["server.ts", "storage.ts"])("%s never reads process.env.NEXT_PUBLIC_* directly", (file) => {
    const source = readFileSync(join(__dirname, file), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(source).not.toMatch(/process\.env\.NEXT_PUBLIC_/);
    expect(source).not.toMatch(/process\.env\[\s*["'`]NEXT_PUBLIC_/);
  });
});
