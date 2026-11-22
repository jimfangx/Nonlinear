/**
 * Parsers for raw git CLI output (used for SSH-helper results, §9).
 * Formats match apps/desktop/nonlinear-helper.sh and the Rust core.
 */
import type { CommitNode } from "./commits";

const SEP = "\u001f";
const REC = "\u001e";

/** `git log --format=%H%x1f%P%x1f%cI%x1f%an%x1f%D%x1f%B%x1e` */
export function parseGitLog(out: string): CommitNode[] {
  const res: CommitNode[] = [];
  for (const rec of out.split(REC)) {
    const r = rec.replace(/^\n+/, "");
    if (!r) continue;
    const f = r.split(SEP);
    if (f.length < 6) continue;
    res.push({
      sha: f[0]!,
      parents: f[1]!.split(/\s+/).filter(Boolean),
      committedAt: f[2]!,
      author: f[3]!,
      refs: f[4]!.split(", ").filter(Boolean).map((x) => x.replace(/^HEAD -> /, "")),
      message: f.slice(5).join(SEP).trimEnd(),
    });
  }
  return res;
}

/** `git ls-tree -r -z <rev>` → gitlinks (mode 160000) */
export function parseLsTreeGitlinks(out: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const ent of out.split("\0")) {
    const tab = ent.indexOf("\t");
    if (tab < 0) continue;
    const [mode, , sha] = ent.slice(0, tab).split(" ");
    if (mode === "160000" && sha) m.set(ent.slice(tab + 1), sha);
  }
  return m;
}

/** `git for-each-ref --format=%(refname)%09%(objectname)%09%(*objectname)` */
export function parseRefs(out: string): { name: string; sha: string; kind: "branch" | "tag" | "remote" }[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [name, sha, peeled] = l.split("\t") as [string, string, string | undefined];
      const kind = name.startsWith("refs/tags/") ? "tag" : name.startsWith("refs/heads/") ? "branch" : "remote";
      return { name: name.replace(/^refs\/(tags|heads|remotes)\//, ""), sha: peeled || sha, kind } as const;
    });
}
