/**
 * Git data sources (§3.1, §7, §9): GitHub API, a local working tree (desktop),
 * or an SSH host running the unprivileged helper. Local/SSH reuse an existing
 * clone (submodules checked out under the root) instead of cloning anything.
 */
import { parseGitLog, parseLsTreeGitlinks, parseRefs, type CommitNode } from "@nonlinear/core";
import { desktop, invoke, isDesktop } from "./platform";
import { useApp } from "./store";

export type Source =
  | { kind: "github" }
  | { kind: "local"; path: string }
  | { kind: "ssh"; alias: string; root: string; repo: string }
  /** managed blob-less partial mirror in the desktop app's cache (§9) */
  | { kind: "mirror"; repoKey: string };

export function sourceLabel(s: Source): string {
  if (s.kind === "mirror") return `mirror cache (${s.repoKey})`;
  return s.kind === "github" ? "GitHub API" : s.kind === "local" ? `local ${s.path}` : `ssh ${s.alias}:${s.root}${s.repo ? "/" + s.repo : ""}`;
}

/** Child source for a submodule; mirrors are per-repository, so pass the child's repo key. */
export function childSource(s: Source, path: string, childRepoKey?: string | null): Source {
  if (s.kind === "mirror") return childRepoKey ? { kind: "mirror", repoKey: childRepoKey } : { kind: "github" };
  if (s.kind === "local") return { kind: "local", path: `${s.path.replace(/\/$/, "")}/${path}` };
  if (s.kind === "ssh") return { ...s, repo: s.repo ? `${s.repo}/${path}` : path };
  return s;
}

function sshAllowed(alias: string): void {
  const h = useApp.getState().settings_().sshHosts.find((x) => x.alias === alias);
  if (!h?.allowed) throw new Error(`Execution on ${alias} is not permitted (Settings → Remote compute).`);
}

const mirrorPaths = new Map<string, Promise<string>>();
/** Resolve (cloning on first use, then fetching once per session) a mirror to a local bare repo path. */
async function resolve(s: Source): Promise<Source> {
  if (s.kind !== "mirror") return s;
  let p = mirrorPaths.get(s.repoKey);
  if (!p) {
    p = invoke<string>("mirror_ensure", { repoKey: s.repoKey, fetch: true });
    mirrorPaths.set(s.repoKey, p);
    p.catch(() => mirrorPaths.delete(s.repoKey));
  }
  return { kind: "local", path: await p };
}

async function ssh(s: Extract<Source, { kind: "ssh" }>, kind: string, args: string[]): Promise<string> {
  sshAllowed(s.alias);
  return desktop.sshRun(s.alias, s.root, { kind, repo: s.repo, args });
}

export async function gitLog(s0: Source, rev: string, limit: number): Promise<CommitNode[]> {
  const s = await resolve(s0);
  if (s.kind === "local") return desktop.gitLog(s.path, rev, limit);
  if (s.kind === "ssh") return parseGitLog(await ssh(s, "git-log", [rev, String(limit)]));
  throw new Error("use the GitHub client for GitHub sources");
}

export async function gitRefs(s0: Source): Promise<{ name: string; sha: string; kind: string }[]> {
  const s = await resolve(s0);
  if (s.kind === "local") return desktop.gitRefs(s.path);
  if (s.kind === "ssh") return parseRefs(await ssh(s, "refs", []));
  throw new Error("use the GitHub client for GitHub sources");
}

export async function gitGitlinks(s0: Source, rev: string): Promise<Map<string, string>> {
  const s = await resolve(s0);
  if (s.kind === "local") return new Map((await desktop.gitGitlinks(s.path, rev)).map((g) => [g.path, g.sha]));
  if (s.kind === "ssh") return parseLsTreeGitlinks(await ssh(s, "gitlinks", [rev]));
  throw new Error("use the GitHub client for GitHub sources");
}

export async function gitShowFile(s0: Source, rev: string, path: string): Promise<string | null> {
  const s = await resolve(s0);
  try {
    if (s.kind === "local") return await desktop.gitShow(s.path, rev, path);
    if (s.kind === "ssh") return await ssh(s, "show-file", [rev, path]);
  } catch {
    return null;
  }
  throw new Error("use the GitHub client for GitHub sources");
}

export async function gitDiff(s0: Source, a: string, b: string): Promise<string> {
  const s = await resolve(s0);
  if (s.kind === "local") return desktop.gitDiff(s.path, a, b);
  if (s.kind === "ssh") return ssh(s, "diff", [a, b]);
  throw new Error("use the GitHub client for GitHub sources");
}

/** Sources the user can pick for a repository. */
export function availableSources(repoKey: string): Source[] {
  const s = useApp.getState().settings_();
  const out: Source[] = [{ kind: "github" }];
  const local = s.localRepos[repoKey.toLowerCase()];
  if (local) out.push({ kind: "local", path: local });
  if (isDesktop()) out.push({ kind: "mirror", repoKey: repoKey.toLowerCase() });
  for (const h of s.sshHosts.filter((x) => x.allowed)) out.push({ kind: "ssh", alias: h.alias, root: h.root, repo: "" });
  return out;
}
