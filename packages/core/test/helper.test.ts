// The SSH helper's output must parse with the shared parsers (same code path the app uses for SSH sources).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGitLog, parseLsTreeGitlinks, parseRefs } from "../src/graph/gitText";
import { parseGitmodules } from "../src/submodule/gitmodules";

const helper = new URL("../../../apps/desktop/nonlinear-helper.sh", import.meta.url).pathname;
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always", ...a], { cwd, stdio: "pipe" }).toString();
const run = (...a: string[]) => execFileSync("sh", [helper, ...a]).toString();

describe("nonlinear-helper.sh ↔ parsers", () => {
  const dir = mkdtempSync(join(tmpdir(), "nl-helper-"));
  const child = join(dir, "child");
  const root = join(dir, "root");
  execFileSync("mkdir", ["-p", child, root]);
  git(child, "init", "-q", "-b", "main");
  writeFileSync(join(child, "a.txt"), "1");
  git(child, "add", ".");
  git(child, "commit", "-qm", "child one");
  git(root, "init", "-q", "-b", "main");
  git(root, "submodule", "add", "-q", child, "generators/boom");
  git(root, "commit", "-qm", "add boom");
  git(root, "tag", "v1");
  const childSha = git(child, "rev-parse", "HEAD").trim();

  it("git-log, gitlinks, refs, show-file", () => {
    const log = parseGitLog(run("git-log", root, "HEAD", "5"));
    expect(log[0]!.message).toBe("add boom");
    expect(log[0]!.refs!.join()).toMatch(/main/);
    expect(parseLsTreeGitlinks(run("gitlinks", root, "HEAD")).get("generators/boom")).toBe(childSha);
    expect(parseRefs(run("refs", root)).some((r) => r.kind === "tag" && r.name === "v1")).toBe(true);
    const gm = parseGitmodules(run("show-file", root, "HEAD", ".gitmodules"));
    expect(gm[0]!.path).toBe("generators/boom");
    expect(run("version")).toMatch(/nonlinear-helper 1/);
    expect(() => run("rm", root)).toThrow();
  });
});
