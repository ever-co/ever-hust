/**
 * Turbo 2 runs tasks in strict env mode: it removes every environment variable that turbo.json
 * does not list before it starts a task. A variable missing from `globalEnv` never reaches
 * `next build` under `pnpm build`, even when CI or the shell sets it, and it is not part of the
 * build hash. better-auth reads its config while `next build` collects page data, so a missing
 * BETTER_AUTH_URL there prints "[Better Auth] Base URL is not set" once per worker.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..", "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function globalEnv(): string[] {
  const turbo = JSON.parse(read("turbo.json")) as { globalEnv?: string[] };
  return turbo.globalEnv ?? [];
}

describe("turbo.json globalEnv", () => {
  it("passes BETTER_AUTH_URL through to the build", () => {
    expect(globalEnv()).toContain("BETTER_AUTH_URL");
  });

  it("lists every BETTER_AUTH_* variable the better-auth config reads", () => {
    const source = read("packages/auth/src/index.ts");
    const names = [...source.matchAll(/process\.env\.(BETTER_AUTH_\w+)/g)].map(
      (m) => m[1]!,
    );
    expect(names).toEqual(
      expect.arrayContaining(["BETTER_AUTH_URL", "BETTER_AUTH_SECRET"]),
    );
    const missing = [...new Set(names)].filter(
      (name) => !globalEnv().includes(name),
    );
    expect(missing).toEqual([]);
  });
});
