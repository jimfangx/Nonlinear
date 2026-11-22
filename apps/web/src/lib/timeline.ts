/**
 * Submodule timeline data (§3.1). Uses GitHub Trees/Contents/Commits APIs and
 * fetches one child history on demand; never clones the full tree.
 */
import { parseGitmodules, CommitIndex, type CommitNode, type GitmoduleEntry } from "@nonlinear/core";
import { githubApi } from "./github";
import { childSource, gitGitlinks, gitLog, gitRefs, gitShowFile, sourceLabel, type Source } from "./sources";
import { getBlob, putBlob } from "./db";

export interface RootSnapshot {
  root: string;
  ref: string;
  commit: CommitNode;
  gitmodules: GitmoduleEntry[];
  gitlinks: Map<string, string>;
}

export interface SubmoduleRow {
  entry: GitmoduleEntry;
  /** pinned gitlink at the selected root commit (null = missing from tree) */
  pinned: string | null;
  childKey: string | null;
  status: "ok" | "unresolved" | "private-or-missing" | "loading";
  error?: string;
  history?: CommitNode[];
  index?: CommitIndex;
  pinnedCommit?: CommitNode;
  branch?: string;
  tip?: CommitNode;
  tags?: { name: string; sha: string }[];
  /** open PRs against the child repo, placed at their head commit date (§3.1) */
  prs?: { key: string; number: number; title: string; head: CommitNode; draft: boolean }[];
}

const mem = new Map<string, unknown>();

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const m = mem.get(key) as { at: number; v: T } | undefined;
  if (m && Date.now() - m.at < ttlMs) return m.v;
  const raw = await getBlob(`tlc:${key}`);
  if (raw) {
    const parsed = JSON.parse(raw) as { at: number; v: T };
    if (Date.now() - parsed.at < ttlMs || !navigator.onLine) {
      mem.set(key, parsed);
      return parsed.v;
    }
  }
  try {
    const v = await fn();
    const rec = { at: Date.now(), v };
    mem.set(key, rec);
    await putBlob(`tlc:${key}`, JSON.stringify(rec));
    return v;
  } catch (e) {
    if (raw) return (JSON.parse(raw) as { v: T }).v; // offline fallback (stale)
    throw e;
  }
}

export async function loadRoot(root: string, ref: string, sha: string | null, src: Source = { kind: "github" }): Promise<RootSnapshot> {
  const [owner, repo] = root.split("/") as [string, string];
  if (src.kind !== "github") {
    // Local working tree or SSH host: same data, no GitHub API calls (§9).
    const [commit] = await gitLog(src, sha ?? ref, 1);
    if (!commit) throw new Error(`${sha ?? ref} not found in ${sourceLabel(src)}`);
    const gm = await gitShowFile(src, commit.sha, ".gitmodules");
    return { root, ref, commit, gitmodules: parseGitmodules(gm ?? "", { owner, repo }), gitlinks: await gitGitlinks(src, commit.sha) };
  }
  const c = await githubApi();
  const commit = await cached(`commit:${root}:${sha ?? ref}`, sha ? Infinity : 5 * 60_000, () => c.commit(owner, repo, sha ?? ref));
  const gm = await cached(`gitmodules:${root}:${commit.sha}`, Infinity, () => c.contents(owner, repo, ".gitmodules", commit.sha));
  const links = await cached(`gitlinks:${root}:${commit.sha}`, Infinity, async () => [...(await c.gitlinks(owner, repo, commit.sha))]);
  return { root, ref, commit, gitmodules: parseGitmodules(gm ?? "", { owner, repo }), gitlinks: new Map(links) };
}

export async function gitlinksAt(repoKey: string, sha: string): Promise<Map<string, string>> {
  const [owner, repo] = repoKey.split("/") as [string, string];
  const c = await githubApi();
  return new Map(await cached(`gitlinks:${repoKey}:${sha}`, Infinity, async () => [...(await c.gitlinks(owner, repo, sha))]));
}

export function rowsFor(s: RootSnapshot): SubmoduleRow[] {
  const rows: SubmoduleRow[] = s.gitmodules.map((e) => {
    const pinned = s.gitlinks.get(e.path) ?? null;
    return {
      entry: e,
      pinned,
      childKey: e.github ? `${e.github.owner}/${e.github.repo}`.toLowerCase() : null,
      status: !e.github || e.issues.length ? "unresolved" : pinned ? "loading" : "unresolved",
      error: !e.github ? "Non-GitHub URL" : !pinned ? "No gitlink at this commit" : e.issues.join("; ") || undefined,
    };
  });
  // Gitlinks present in the tree but missing from .gitmodules → unresolved rows (never silently removed).
  for (const [path, sha] of s.gitlinks) {
    if (!s.gitmodules.some((e) => e.path === path)) {
      rows.push({ entry: { name: path, path, url: "", branch: null, github: null, issues: ["Missing from .gitmodules"] }, pinned: sha, childKey: null, status: "unresolved", error: "Gitlink without .gitmodules entry" });
    }
  }
  return rows.sort((a, b) => a.entry.path.localeCompare(b.entry.path));
}

/** Load child history around the pinned commit and up to the branch tip. */
export async function loadRowHistory(row: SubmoduleRow, opts: { sinceDays: number }, src: Source = { kind: "github" }): Promise<SubmoduleRow> {
  if (!row.pinned) return row;
  if (src.kind !== "github") {
    // History from the checked-out submodule under the working tree (fetch state as-is; nothing is fetched or modified).
    try {
      const cs = childSource(src, row.entry.path, row.childKey);
      if (cs.kind === "github") return { ...row, status: "unresolved", error: "Submodule URL is not on GitHub; no mirror available" };
      const refs = await gitRefs(cs);
      const branchName = row.entry.branch && row.entry.branch !== "." ? row.entry.branch : null;
      const tipRef = refs.find((r) => r.kind === "remote" && (branchName ? r.name === `origin/${branchName}` : r.name === "origin/HEAD")) ?? refs.find((r) => r.kind === "remote" && /^origin\/(main|master)$/.test(r.name)) ?? refs.find((r) => r.kind === "branch");
      const history = await gitLog(cs, "--all", 600);
      const index = new CommitIndex(history);
      const pinnedCommit = index.bySha.get(row.pinned);
      if (!pinnedCommit) return { ...row, status: "private-or-missing", error: "Pinned commit not present in the local clone (run git fetch in the submodule)" };
      const since = Date.parse(pinnedCommit.committedAt) - opts.sinceDays * 864e5;
      const shown = history.filter((c) => Date.parse(c.committedAt) >= since || c.sha === row.pinned);
      return { ...row, status: "ok", branch: tipRef?.name ?? "HEAD", history: shown, index, pinnedCommit, tip: tipRef ? index.bySha.get(tipRef.sha) : history[0], tags: refs.filter((r) => r.kind === "tag").slice(0, 80).map((t) => ({ name: t.name, sha: t.sha })) };
    } catch (e) {
      return { ...row, status: "private-or-missing", error: (e as Error).message };
    }
  }
  if (!row.childKey) return row;
  const [owner, repo] = row.childKey.split("/") as [string, string];
  const c = await githubApi();
  try {
    const info = await cached(`repo:${row.childKey}`, 24 * 3600_000, () => c.repo(owner, repo));
    const branch = row.entry.branch && row.entry.branch !== "." ? row.entry.branch : info.defaultBranch;
    const pinnedCommit = await cached(`commit:${row.childKey}:${row.pinned}`, Infinity, () => c.commit(owner, repo, row.pinned!));
    const since = new Date(Math.min(Date.parse(pinnedCommit.committedAt), Date.now()) - opts.sinceDays * 864e5).toISOString();
    const history = await cached(`hist:${row.childKey}:${branch}:${since.slice(0, 10)}`, 30 * 60_000, () => c.commits(owner, repo, { sha: branch, since, pages: 2 }));
    const tags = await cached(`tags:${row.childKey}`, 3600_000, async () => (await c.tags(owner, repo)).slice(0, 50).map((t) => ({ name: t.name, sha: t.commit.sha })));
    const all = history.some((h) => h.sha === pinnedCommit.sha) ? history : [...history, pinnedCommit];
    return { ...row, status: "ok", branch, history: all, index: new CommitIndex(all), pinnedCommit, tip: history[0], tags };
  } catch (e) {
    return { ...row, status: "private-or-missing", error: (e as Error).message };
  }
}

/** Is the pinned commit on the tracked branch? (diverged pins are shown distinctly) */
export function pinOnBranch(row: SubmoduleRow): boolean | "unknown" {
  if (!row.index || !row.tip || !row.pinned) return "unknown";
  return row.index.isAncestor(row.pinned, row.tip.sha);
}

/** Head commits of open PRs (from the local PR cache) for a child repository. */
export async function loadRowPRs(row: SubmoduleRow, prs: { key: string; owner: string; repo: string; number: number; title: string; headSha: string; state: string; draft: boolean }[]): Promise<SubmoduleRow["prs"]> {
  if (!row.childKey) return [];
  const [owner, repo] = row.childKey.split("/") as [string, string];
  const mine = prs.filter((p) => p.state === "open" && `${p.owner}/${p.repo}`.toLowerCase() === row.childKey).slice(0, 15);
  const c = await githubApi();
  const out: NonNullable<SubmoduleRow["prs"]> = [];
  for (const p of mine) {
    try {
      const head = row.index?.bySha.get(p.headSha) ?? (await cached(`commit:${row.childKey}:${p.headSha}`, Infinity, () => c.commit(owner, repo, p.headSha)));
      out.push({ key: p.key, number: p.number, title: p.title, head, draft: p.draft });
    } catch {
      /* head commit not accessible (e.g. deleted fork); skip */
    }
  }
  return out;
}
