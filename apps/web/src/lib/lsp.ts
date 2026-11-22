/**
 * Multi-language LSP access (desktop). The registry maps file extensions to any
 * language server; Metals is just one entry. Falls back (labelled) to
 * tree-sitter / heuristics when no server or working tree is available.
 */
import { invoke, isDesktop } from "./platform";
import { useApp, type LspServer } from "./store";

export interface LspLocation {
  path: string; // repo-relative
  line: number; // 0-based
  character: number;
}

export function serverFor(path: string): LspServer | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return useApp.getState().settings_().lspServers.find((s) => s.enabled && s.extensions.includes(ext)) ?? null;
}

export function workingTreeFor(repoKey: string): string | null {
  return useApp.getState().settings_().localRepos[repoKey.toLowerCase()] ?? null;
}

export type LspAvailability = { ok: true; server: LspServer; root: string } | { ok: false; reason: string };

export function lspAvailable(repoKey: string, path: string): LspAvailability {
  if (!isDesktop()) return { ok: false, reason: "Language servers run in the desktop app." };
  const server = serverFor(path);
  if (!server) return { ok: false, reason: `No language server configured for .${path.split(".").pop()} files (Settings → Language servers).` };
  // Root is resolved per query to an exact-SHA worktree (from the mapped working tree or the mirror cache).
  return { ok: true, server, root: workingTreeFor(repoKey) ?? "" };
}

const worktrees = new Map<string, Promise<string>>();
/** Detached worktree at exactly `sha` in the app cache — LSP sees precisely the code under review. */
export function exactRoot(repoKey: string, sha: string): Promise<string> {
  const k = `${repoKey}@${sha}`;
  let p = worktrees.get(k);
  if (!p) {
    p = invoke<string>("worktree_at", { repoKey, sha, localRepo: workingTreeFor(repoKey) });
    worktrees.set(k, p);
    p.catch(() => worktrees.delete(k));
  }
  return p;
}

function toLocations(root: string, v: unknown): LspLocation[] {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  const prefix = `file://${root.replace(/\/$/, "")}/`;
  return arr
    .map((x: { uri?: string; targetUri?: string; range?: { start: { line: number; character: number } }; targetSelectionRange?: { start: { line: number; character: number } } }) => {
      const uri = decodeURIComponent(x.uri ?? x.targetUri ?? "");
      const start = (x.range ?? x.targetSelectionRange)?.start ?? { line: 0, character: 0 };
      return { path: uri.startsWith(prefix) ? uri.slice(prefix.length) : uri, line: start.line, character: start.character };
    })
    .filter((l) => l.path);
}

export async function lspLocations(repoKey: string, path: string, method: "definition" | "references", line: number, character: number, sha?: string): Promise<{ server: string; locations: LspLocation[]; root: string }> {
  const a = lspAvailable(repoKey, path);
  if (!a.ok) throw new Error(a.reason);
  const root = sha ? await exactRoot(repoKey, sha) : a.root;
  if (!root) throw new Error(`No revision to analyse for ${repoKey}`);
  const res = await invoke<unknown>("lsp_query", { query: { root, command: a.server.command, args: a.server.args, languageId: a.server.languageId, path, method, line, character } });
  return { server: a.server.name, locations: toLocations(root, res), root };
}

/** Does the local working tree's HEAD match the revision being viewed? */
export async function headMatches(repoKey: string, sha: string): Promise<boolean | null> {
  const root = workingTreeFor(repoKey);
  if (!root || !isDesktop()) return null;
  try {
    return (await invoke<string>("git_head", { repoPath: root })).startsWith(sha.slice(0, 12));
  } catch {
    return null;
  }
}
