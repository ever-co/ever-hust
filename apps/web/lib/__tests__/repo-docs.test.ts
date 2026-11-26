/**
 * AGENTS.md and CLAUDE.md name the pnpm the repo pins.
 *
 * Contributors and coding agents read these two files first. pnpm 10 behaves differently from
 * pnpm 9 (for one, it does not run dependency install scripts unless they are allowed), so a doc
 * that names another major leads to a local install that differs from CI and the Docker images.
 * These checks read the root `packageManager` pin and the docs themselves, so a pnpm major bump
 * that leaves the docs behind fails here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..", "..");
const DOCS = ["AGENTS.md", "CLAUDE.md"];

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

type PnpmMention = { line: number; mention: string; major: number };

/** Every pnpm version a text names: "pnpm 9", "**pnpm 9**", "pnpm@9.15.0", "pnpm v10", "pnpm 10+". */
function pnpmMentions(text: string): PnpmMention[] {
  const found: PnpmMention[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(/\bpnpm(?:@|\s+v?)(\d+)/gi)) {
      found.push({ line: i + 1, mention: m[0], major: Number(m[1]) });
    }
  });
  return found;
}

const packageManager =
  (JSON.parse(read("package.json")) as { packageManager?: string })
    .packageManager ?? "";
const pinnedMajor = Number(/^pnpm@(\d+)\.\d+\.\d+/.exec(packageManager)?.[1]);

describe("AGENTS.md and CLAUDE.md name the pinned pnpm major", () => {
  it("the root package.json pins an exact pnpm release", () => {
    expect(packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+/);
    expect(Number.isInteger(pinnedMajor)).toBe(true);
  });

  it("finds every way the docs write a pnpm version, and nothing else", () => {
    const sample =
      '"pnpm@9.15.0" | pnpm 9 (NOT npm) | **pnpm 9** workspaces | pnpm v10 | pnpm 10+';
    expect(pnpmMentions(sample).map((m) => m.major)).toEqual([9, 9, 9, 10, 10]);
    expect(
      pnpmMentions(
        "pnpm install\npnpm-workspace.yaml\npnpm test -- --selectProjects ai\npnpm dev",
      ),
    ).toEqual([]);
  });

  it.each(DOCS)(
    "%s names no pnpm major other than the root packageManager",
    (doc) => {
      const stale = pnpmMentions(read(doc))
        .filter((m) => m.major !== pinnedMajor)
        .map(
          (m) =>
            `${doc}:${m.line} "${m.mention}" (package.json pins ${packageManager})`,
        );
      expect(stale).toEqual([]);
    },
  );
});
