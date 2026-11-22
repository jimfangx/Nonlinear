// Guard: Nonlinear talks to GitHub only via the REST API — never the `gh` CLI or a user's gh login (§8).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const ROOT = join(__dirname, "../../..");
const DIRS = ["apps/web/src", "packages/core/src", "services/sync/src", "apps/desktop/src-tauri/src", "scripts"];
const BAD = [/Command::new\("gh"\)/, /\b(spawn|execFile|execFileSync|exec|execSync)\(\s*["'`]gh\b/, /(^|[\s;&|(])gh (auth|api|pr|repo|issue)\b/m, /gh auth token/];

function walk(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    if (n === "node_modules" || n === "target" || n === "dist") return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx|rs|mjs|js|sh)$/.test(n) ? [p] : [];
  });
}

it("no code invokes the gh CLI", () => {
  const hits = DIRS.flatMap((d) => walk(join(ROOT, d))).filter((f) => !f.endsWith("no-gh-cli.test.ts")).flatMap((f) => {
    const s = readFileSync(f, "utf8");
    return BAD.filter((re) => re.test(s)).map((re) => `${f.slice(ROOT.length + 1)} matches ${re}`);
  });
  expect(hits).toEqual([]);
});
