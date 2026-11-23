/**
 * Submodule timeline data from local Git, shallow desktop Git fetches, or the
 * GitHub API when running in a browser.
 */
import { parseGitmodules, CommitIndex, type CommitNode, type GitmoduleEntry } from "@nonlinear/core";
import { githubApi } from "./github";
import { childSource, gitGitlinks, gitLog, gitRefs, gitShowFile, sourceLabel, type Source } from "./sources";
import { invoke, isDesktop } from "./platform";
import { cloudUrl } from "./cloud";
import { useApp } from "./store";
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
  shallow?: boolean;
  tags?: { name: string; sha: string }[];
  /** open PRs against the child repo, placed at their head commit date (§3.1) */
  prs?: { key: string; number: number; title: string; head: CommitNode; draft: boolean }[];
}

const mem = new Map<string, unknown>();

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, refresh = false): Promise<T> {
  const m = mem.get(key) as { at: number; v: T } | undefined;
  if (!refresh && m && Date.now() - m.at < ttlMs) return m.v;
  const raw = refresh ? null : await getBlob(`tlc:${key}`);
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

export function usesGitTransport(source: Source = { kind: "github" }): boolean {
  if (!isDesktop() || source.kind !== "github" || source.transport === "api") return false;
  const settings = useApp.getState().settings_();
  const base = settings.apiBase.replace(/\/$/, "");
  return base === "https://api.github.com" || (settings.authMode === "oauth" && base === `${cloudUrl()}/gh`);
}

async function shallowSource(repoKey: string, rev: string, depth: number, trees = false, since?: string, refresh = false) {
  const [path, ref] = await invoke<[string, string]>("timeline_fetch", { repoKey, rev, depth, trees, since, refresh });
  return { source: { kind: "local" as const, path }, ref };
}

export async function remoteGitLog(repoKey: string, rev: string, limit: number, since?: string): Promise<CommitNode[]> {
  const { source, ref } = await shallowSource(repoKey, rev, limit, false, since);
  return gitLog(source, ref, limit);
}

type RemoteRefs = { branch: string | null; branches: [string, string][]; tags: [string, string][] };

const refsInFlight = new Map<string, Promise<RemoteRefs>>();

export function remoteGitRefs(repoKey: string): Promise<RemoteRefs> {
  let request = refsInFlight.get(repoKey);
  if (!request) {
    request = cached(`git-remote-refs:${repoKey}`, 30 * 60_000, () => invoke<RemoteRefs>("timeline_refs", { repoKey }))
      .finally(() => refsInFlight.delete(repoKey));
    refsInFlight.set(repoKey, request);
  }
  return request;
}

export async function loadRoot(root: string, ref: string, sha: string | null, src: Source = { kind: "github" }, refresh = false): Promise<RootSnapshot> {
  const [owner, repo] = root.split("/") as [string, string];
  if (usesGitTransport(src)) {
    const local = useApp.getState().settings_().localRepos[root.toLowerCase()];
    if (local && !refresh) {
      try { return await loadRoot(root, ref, sha, { kind: "local", path: local }); } catch { /* use remote Git */ }
    }
    const { source, ref: fetched } = await shallowSource(root, sha ?? ref, 1, true, undefined, refresh);
    return { ...await loadRoot(root, fetched, null, source), ref };
  }
  if (src.kind !== "github") {
    // Local working tree or SSH host: same data, no GitHub API calls (§9).
    const [commit] = await gitLog(src, sha ?? ref, 1);
    if (!commit) throw new Error(`${sha ?? ref} not found in ${sourceLabel(src)}`);
    const gm = await gitShowFile(src, commit.sha, ".gitmodules");
    return { root, ref, commit, gitmodules: parseGitmodules(gm ?? "", { owner, repo }), gitlinks: await gitGitlinks(src, commit.sha) };
  }
  const c = await githubApi();
  const commitKey = `commit:${root}:${sha ?? ref}`;
  const readCommit = () => c.commit(owner, repo, sha ?? ref);
  const commit = await cached(commitKey, sha ? Infinity : 5 * 60_000, readCommit, refresh);
  const gm = await cached(`gitmodules:${root}:${commit.sha}`, Infinity, () => c.contents(owner, repo, ".gitmodules", commit.sha));
  const links = await cached(`gitlinks:${root}:${commit.sha}`, Infinity, async () => [...(await c.gitlinks(owner, repo, commit.sha))]);
  return { root, ref, commit, gitmodules: parseGitmodules(gm ?? "", { owner, repo }), gitlinks: new Map(links) };
}

export async function gitlinksAt(repoKey: string, sha: string, githubSource?: Extract<Source, { kind: "github" }>): Promise<Map<string, string>> {
  if (usesGitTransport(githubSource)) {
    const local = useApp.getState().settings_().localRepos[repoKey.toLowerCase()];
    if (local) {
      try { return await gitGitlinks({ kind: "local", path: local }, sha); } catch { /* use remote Git */ }
    }
    const { source, ref } = await shallowSource(repoKey, sha, 1, true);
    return gitGitlinks(source, ref);
  }
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
export async function loadRowHistory(row: SubmoduleRow, opts: { sinceDays: number; rootRef?: string; since?: string }, src: Source = { kind: "github" }): Promise<SubmoduleRow> {
  if (!row.pinned) return row;
  const branchName = row.entry.branch === "." ? opts.rootRef : row.entry.branch;
  if (row.childKey && usesGitTransport(src)) {
    const repoKey = row.childKey;
    const pinned = row.pinned;
    const local = useApp.getState().settings_().localRepos[repoKey];
    if (local) {
      const result = await loadLocalRow(row, opts, { kind: "local", path: local }, branchName);
      if (result.status === "ok") return result;
    }
    const refs = remoteGitRefs(repoKey).catch((): RemoteRefs => ({ branch: null, branches: [], tags: [] }));
    const depth = opts.since ? 20_000 : 600;
    const branch = branchName || "HEAD";
    let fetchError: string | undefined;
    const tracked = await remoteGitLog(repoKey, branchName ? `refs/heads/${branch}` : branch, depth, opts.since).catch((error) => {
      fetchError = String(error);
      return [];
    });
    const pinnedHistory = tracked.some((commit) => commit.sha === pinned) ? [] : await remoteGitLog(repoKey, pinned, 120).catch((error) => {
      fetchError = String(error);
      return [];
    });
    const pinnedCommit = pinnedHistory[0] ?? tracked.find((commit) => commit.sha === pinned);
    const history = [...new Map([...tracked, ...pinnedHistory].map((commit) => [commit.sha, commit])).values()];
    const { branch: defaultBranch, tags } = await refs;
    const error = !pinnedCommit ? fetchError : undefined;
    return {
      ...row, status: error ? "private-or-missing" : "ok", error, branch: branchName || defaultBranch || "HEAD",
      history, pinnedCommit, index: new CommitIndex(history), tip: tracked[0], shallow: !!opts.since || tracked.length >= depth,
      tags: tags.map(([name, sha]) => ({ name, sha })),
    };
  }
  if (src.kind !== "github") {
    const child = childSource(src, row.entry.path, row.childKey);
    const loaded = await loadLocalRow(row, opts, child, branchName);
    if (src.kind === "local" && loaded.status !== "ok" && row.childKey && usesGitTransport() &&
        useApp.getState().settings_().localRepos[row.childKey] !== (child.kind === "local" ? child.path : undefined)) return loadRowHistory(row, opts);
    return loaded;
  }
  if (!row.childKey) return row;
  const [owner, repo] = row.childKey.split("/") as [string, string];
  const c = await githubApi();
  try {
    const info = await cached(`repo:${row.childKey}`, 24 * 3600_000, () => c.repo(owner, repo));
    const branch = branchName || info.defaultBranch;
    const pinnedCommit = await cached(`commit:${row.childKey}:${row.pinned}`, Infinity, () => c.commit(owner, repo, row.pinned!));
    const since = opts.since ? `${opts.since}T00:00:00Z` : new Date(Math.min(Date.parse(pinnedCommit.committedAt), Date.now()) - opts.sinceDays * 864e5).toISOString();
    const history = await cached(`hist:${row.childKey}:${branch}:${since.slice(0, 10)}`, 30 * 60_000, () => c.commits(owner, repo, { sha: branch, since, pages: 3 }));
    const tags = await cached(`tags:${row.childKey}`, 3600_000, async () => (await c.tags(owner, repo)).slice(0, 50).map((t) => ({ name: t.name, sha: t.commit.sha })));
    const all = history.some((h) => h.sha === pinnedCommit.sha) ? history : [...history, pinnedCommit];
    return { ...row, status: "ok", branch, history: all, index: new CommitIndex(all), pinnedCommit, tip: history[0], tags };
  } catch (e) {
    return { ...row, status: "private-or-missing", error: (e as Error).message };
  }
}

async function loadLocalRow(row: SubmoduleRow, { since, sinceDays }: { since?: string; sinceDays: number }, source: Source, branchName?: string | null): Promise<SubmoduleRow> {
  if (source.kind === "github" || !row.pinned) return row;
  try {
    const refs = await gitRefs(source);
    const tipRef = refs.find((r) => r.kind === "remote" && r.name === `origin/${branchName ?? "HEAD"}`)
      ?? refs.find((r) => r.kind === "branch" && r.name === branchName)
      ?? refs.find((r) => r.kind === "remote" && /^origin\/(main|master)$/.test(r.name))
      ?? refs.find((r) => r.kind === "branch");
    const history = await gitLog(source, tipRef?.sha ?? "--all", since && source.kind === "local" ? 20_000 : 600);
    const pinnedCommit = history.find((commit) => commit.sha === row.pinned) ?? (await gitLog(source, row.pinned, 1))[0];
    if (!pinnedCommit) throw new Error("Pinned commit is missing from the Git source.");
    const start = since ? Date.parse(since) : Date.parse(pinnedCommit.committedAt) - sinceDays * 864e5;
    const shown = history.filter((commit) => Date.parse(commit.committedAt) >= start);
    if (!shown.some((commit) => commit.sha === pinnedCommit.sha)) shown.push(pinnedCommit);
    return { ...row, status: "ok", branch: tipRef?.name.replace(/^origin\//, "") ?? "HEAD", history: shown,
      index: new CommitIndex([...history, pinnedCommit]), pinnedCommit, tip: history[0],
      tags: refs.filter((ref) => ref.kind === "tag").map(({ name, sha }) => ({ name, sha })) };
  } catch (e) {
    return { ...row, status: "private-or-missing", error: (e as Error).message };
  }
}

/** Is the pinned commit on the tracked branch? (diverged pins are shown distinctly) */
export function pinOnBranch(row: SubmoduleRow): boolean | "unknown" {
  if (!row.index || !row.tip || !row.pinned) return "unknown";
  const result = row.index.isAncestor(row.pinned, row.tip.sha);
  return row.shallow && result === false ? "unknown" : result;
}

/** Show cached PR heads, reusing Git history on desktop. */
export async function rowPRs(row: SubmoduleRow, prs: { key: string; owner: string; repo: string; number: number; title: string; headSha: string; state: string; draft: boolean }[], allowApi: boolean): Promise<SubmoduleRow["prs"]> {
  if (!row.childKey || !row.index) return [];
  const [owner, repo] = row.childKey.split("/") as [string, string];
  const open = prs.filter((p) => p.state === "open" && `${p.owner}/${p.repo}`.toLowerCase() === row.childKey).slice(0, 15);
  const out: NonNullable<SubmoduleRow["prs"]> = [];
  let missing = 0;
  for (const p of open) {
    let head = row.index.bySha.get(p.headSha);
    if (!head && allowApi && missing++ < 5) {
      head = await cached(`commit:${row.childKey}:${p.headSha}`, Infinity,
        async () => (await githubApi()).commit(owner, repo, p.headSha)).catch(() => undefined);
    }
    if (head) out.push({ key: p.key, number: p.number, title: p.title, head, draft: p.draft });
  }
  return out;
}
