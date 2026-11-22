/**
 * Multi-repository JSON diff import (design §6).
 * Format: { "<relative submodule path>": "<unified diff string>", ... }, "" = root.
 */
import { fnv1a, indexPatch, isUnsafePath, type DiffFileEntry, type ParsedPatchIndex } from "./unified";

export interface RepoGroup {
  /** normalised path ("" = root) */
  path: string;
  /** original key as it appeared in JSON */
  originalKey: string;
  patch: string;
  patchHash: string;
  index: ParsedPatchIndex;
  /** resolved from .gitmodules when a root repo is provided */
  repo?: { owner: string; repo: string; url: string } | null;
  issues: string[];
}

export interface MultiRepoDiff {
  id: string;
  name: string;
  importedAt: number;
  sourceBytes: number;
  /** hash of the whole original JSON text, for dedup */
  contentHash: string;
  groups: RepoGroup[];
  issues: string[];
  totals: { files: number; additions: number; deletions: number };
}

export interface ImportOptions {
  name?: string;
  /** path -> repo, from .gitmodules of the root repository at the chosen commit */
  submodules?: Map<string, { owner: string; repo: string; url: string }>;
  now?: number;
  /** progressive callback per group (for worker progress events) */
  onProgress?: (done: number, total: number, path: string) => void;
}

export const LARGE_IMPORT_WARN_BYTES = 50 * 1024 * 1024;

export function normalizeKey(k: string): string {
  return k.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/").replace(/\/$/, "").trim();
}

export function importMultiRepoDiff(jsonText: string, opts: ImportOptions = {}): MultiRepoDiff {
  const issues: string[] = [];
  if (jsonText.length > LARGE_IMPORT_WARN_BYTES) issues.push(`Import is ${(jsonText.length / 1048576).toFixed(1)} MB, above the 50 MB target; rendering will be chunked.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`Invalid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object mapping submodule path → unified diff string");

  const groups: RepoGroup[] = [];
  const seen = new Map<string, string>();
  const entries = Object.entries(parsed as Record<string, unknown>);
  let done = 0;
  for (const [key, value] of entries) {
    opts.onProgress?.(++done, entries.length, normalizeKey(key) || "(root)");
    const gIssues: string[] = [];
    const path = normalizeKey(key);
    if (path !== key) gIssues.push(`Key "${key}" normalised to "${path}"`);
    if (path && isUnsafePath(path)) {
      issues.push(`Rejected unsafe submodule path "${key}"`);
      continue;
    }
    if (seen.has(path)) {
      issues.push(`Duplicate path "${path}" (keys "${seen.get(path)}" and "${key}"); later entry ignored`);
      continue;
    }
    seen.set(path, key);
    if (typeof value !== "string") {
      issues.push(`Value for "${key}" is not a string; ignored`);
      continue;
    }
    const index = indexPatch(value);
    gIssues.push(...index.issues);
    let repo: RepoGroup["repo"] = undefined;
    if (opts.submodules) {
      repo = path === "" ? null : opts.submodules.get(path) ?? null;
      if (path !== "" && !repo) gIssues.push("Unknown submodule path (not in .gitmodules)");
    }
    groups.push({ path, originalKey: key, patch: value, patchHash: fnv1a(value), index, repo, issues: gIssues });
  }
  groups.sort((a, b) => (a.path === "" ? -1 : b.path === "" ? 1 : a.path.localeCompare(b.path)));
  const totals = groups.reduce(
    (t, g) => ({ files: t.files + g.index.files.length, additions: t.additions + g.index.additions, deletions: t.deletions + g.index.deletions }),
    { files: 0, additions: 0, deletions: 0 },
  );
  const contentHash = fnv1a(jsonText);
  return {
    id: `diff_${contentHash}`,
    name: opts.name ?? "Imported diff",
    importedAt: opts.now ?? Date.now(),
    sourceBytes: jsonText.length,
    contentHash,
    groups,
    issues,
    totals,
  };
}

export function fileSection(group: RepoGroup, f: DiffFileEntry): string {
  return group.patch.slice(f.start, f.end);
}

export interface FileFilter {
  query?: string;
  kinds?: Set<string>;
  groups?: Set<string>;
  /** search content too (slower) */
  content?: boolean;
}

export function filterFiles(diff: MultiRepoDiff, f: FileFilter): { group: RepoGroup; file: DiffFileEntry }[] {
  const q = f.query?.toLowerCase() ?? "";
  const out: { group: RepoGroup; file: DiffFileEntry }[] = [];
  for (const g of diff.groups) {
    if (f.groups && !f.groups.has(g.path)) continue;
    for (const file of g.index.files) {
      if (f.kinds && f.kinds.size && !f.kinds.has(file.kind)) continue;
      if (q) {
        const full = (g.path ? g.path + "/" : "") + file.path;
        const hit = full.toLowerCase().includes(q) || (f.content && fileSection(g, file).toLowerCase().includes(q));
        if (!hit) continue;
      }
      out.push({ group: g, file });
    }
  }
  return out;
}

/** Build a tree of directories for the file tree pane. */
export interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file?: DiffFileEntry;
}

export function buildTree(files: DiffFileEntry[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    parts.forEach((p, i) => {
      let nx = node.children.get(p);
      if (!nx) {
        nx = { name: p, path: parts.slice(0, i + 1).join("/"), children: new Map() };
        node.children.set(p, nx);
      }
      node = nx;
    });
    node.file = f;
  }
  // collapse single-child directory chains
  const collapse = (n: TreeNode): TreeNode => {
    for (const [k, c] of n.children) n.children.set(k, collapse(c));
    if (!n.file && n.children.size === 1 && n.name) {
      const only = [...n.children.values()][0]!;
      if (!only.file) return { ...only, name: `${n.name}/${only.name}` };
    }
    return n;
  };
  return collapse(root);
}
