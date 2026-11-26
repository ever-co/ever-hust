/**
 * One Node.js version and one Next.js release for the whole repo.
 *
 * Dependabot moves one package.json line at a time, and a Node bump touches the Dockerfiles, the
 * workflows, `engines` and `@types/node`. A bump that misses one of them builds the image on one
 * Node and tests on another, or runs `next` beside an `@next/*` package from another release.
 * These checks read the files themselves, so a partial bump fails here instead of in production.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..", "..");

type PackageJson = {
  name?: string;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function readJson(rel: string): PackageJson {
  return JSON.parse(read(rel)) as PackageJson;
}

/** package.json files of the workspace (pnpm-workspace.yaml) plus the standalone docs site. */
function packageJsonFiles(): string[] {
  const files = ["package.json"];
  for (const dir of ["apps", "packages", "packages/plugins"]) {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}/package.json`;
      if (entry.isDirectory() && existsSync(join(ROOT, rel))) files.push(rel);
    }
  }
  return files;
}

function allDeps(pkg: PackageJson): Record<string, string> {
  return { ...pkg.dependencies, ...pkg.devDependencies };
}

/** Every Node version a Dockerfile stage or a workflow pins, with where it was found. */
function nodePins(): { where: string; version: string }[] {
  const pins: { where: string; version: string }[] = [];
  for (const dir of readdirSync(join(ROOT, ".deploy"), { withFileTypes: true })) {
    const rel = `.deploy/${dir.name}/Dockerfile`;
    if (!dir.isDirectory() || !existsSync(join(ROOT, rel))) continue;
    for (const m of read(rel).matchAll(/^FROM\s+node:([^\s-]+)/gm)) {
      pins.push({ where: rel, version: m[1]! });
    }
  }
  for (const file of readdirSync(join(ROOT, ".github/workflows"))) {
    if (!/\.ya?ml$/.test(file)) continue;
    const rel = `.github/workflows/${file}`;
    // `node-version: ${{ env.NODE_VERSION }}` reads the pin below, so only literal values count.
    for (const m of read(rel).matchAll(/(?:NODE_VERSION|node-version):\s*["']?(\d[\w.]*)["']?/g)) {
      pins.push({ where: rel, version: m[1]! });
    }
  }
  return pins;
}

const pins = nodePins();
const nodeVersion = pins[0]?.version ?? "";
const nodeMajor = nodeVersion.split(".")[0];

describe("Node.js is one version everywhere", () => {
  it("every Dockerfile stage and workflow pins the same exact x.y.z", () => {
    expect(pins.filter((p) => p.where.startsWith(".deploy/")).length).toBeGreaterThanOrEqual(2);
    expect(pins.filter((p) => p.where.startsWith(".github/")).length).toBeGreaterThanOrEqual(1);
    expect(nodeVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pins.filter((p) => p.version !== nodeVersion)).toEqual([]);
  });

  it("every engines.node asks for that major", () => {
    const engines = packageJsonFiles()
      .map((rel) => ({ rel, node: readJson(rel).engines?.node }))
      .filter((e) => e.node !== undefined);
    expect(engines.map((e) => e.rel)).toContain("package.json");
    expect(engines.filter((e) => e.node !== `>=${nodeMajor}`)).toEqual([]);
  });

  it("every @types/node is the same range, on that major", () => {
    const ranges = packageJsonFiles()
      .map((rel) => ({ rel, range: allDeps(readJson(rel))["@types/node"] }))
      .filter((r) => r.range !== undefined);
    expect(ranges.length).toBeGreaterThan(0);
    const first = ranges[0]!.range!;
    expect(first.replace(/^[\^~]/, "").split(".")[0]).toBe(nodeMajor);
    expect(ranges.filter((r) => r.range !== first)).toEqual([]);
  });
});

describe("Next.js is one release", () => {
  const web = allDeps(readJson("apps/web/package.json"));

  it("apps/web pins next exactly", () => {
    expect(web.next).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("every @next/* package and eslint-config-next is on the same release as next", () => {
    const off: string[] = [];
    let seen = 0;
    for (const rel of packageJsonFiles()) {
      for (const [name, range] of Object.entries(allDeps(readJson(rel)))) {
        if (!name.startsWith("@next/") && name !== "eslint-config-next") continue;
        seen++;
        if (range.replace(/^[\^~]/, "") !== web.next) off.push(`${rel}: ${name}@${range}`);
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(off).toEqual([]);
  });
});

describe("better-auth is one range", () => {
  it("every package that uses better-auth asks for the same range", () => {
    const ranges = packageJsonFiles()
      .map((rel) => ({ rel, range: allDeps(readJson(rel))["better-auth"] }))
      .filter((r) => r.range !== undefined);
    expect(ranges.map((r) => r.rel).sort()).toEqual(["apps/web/package.json", "packages/auth/package.json"]);
    expect(new Set(ranges.map((r) => r.range)).size).toBe(1);
  });
});
