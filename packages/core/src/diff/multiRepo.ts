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
  format?: "unified";
  rootRef?: string;
  rootRepo?: { owner: string; repo: string; url: string };
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
    parsed = opts.format === "unified" ? splitUnifiedDiff(jsonText, opts.submodules) : JSON.parse(jsonText);
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
    if (opts.format === "unified" && path) {
      const localPath = (name: string) => name.startsWith(path + "/") ? name.slice(path.length + 1) : name;
      for (const file of index.files) {
        file.path = localPath(file.path);
        if (file.oldPath) file.oldPath = localPath(file.oldPath);
        if (file.newPath) file.newPath = localPath(file.newPath);
      }
    }
    let repo: RepoGroup["repo"] = path === "" ? opts.rootRepo : undefined;
    if (opts.submodules) {
      repo = path === "" ? (opts.rootRepo ?? null) : opts.submodules.get(path) ?? null;
      if (path !== "" && !repo) gIssues.push("Unknown submodule path (not in .gitmodules)");
    }
    groups.push({ path, originalKey: key, patch: value, patchHash: fnv1a(value), index, repo, issues: gIssues });
  }
  if (opts.format === "unified" && !groups.some((group) => group.index.files.length)) throw new Error("No files found in this unified diff.");
  groups.sort((a, b) => (a.path === "" ? -1 : b.path === "" ? 1 : a.path.localeCompare(b.path)));
  const totals = groups.reduce(
    (t, g) => ({ files: t.files + g.index.files.length, additions: t.additions + g.index.additions, deletions: t.deletions + g.index.deletions }),
    { files: 0, additions: 0, deletions: 0 },
  );
  const contentHash = fnv1a(jsonText);
  return {
    id: `diff_${opts.rootRepo ? fnv1a(JSON.stringify([contentHash, opts.rootRepo.url.toLowerCase(), opts.rootRef ?? null])) : contentHash}`,
    name: opts.name ?? "Imported diff",
    importedAt: opts.now ?? Date.now(),
    sourceBytes: jsonText.length,
    contentHash,
    groups,
    issues,
    totals,
  };
}

/** Git emits a summary before embedded patches in --submodule=diff output. */
function splitUnifiedDiff(text: string, repositories: ImportOptions["submodules"]): Record<string, string> {
  const summary = /^Submodule (.+?) ([a-f0-9]{7,64})\.\.\.?([a-f0-9]{7,64})(?::|[^\n]*)$/gm;
  const markers = [...text.matchAll(summary)].filter((match) => !isUnsafePath(match[1]!));
  if (!markers.length && !repositories?.size) return { "": text };
  const groups = new Map<string, string[]>();
  const append = (path: string, section: string) => {
    const parts = groups.get(path) ?? [];
    parts.push(section.endsWith("\n") ? section : section + "\n");
    groups.set(path, parts);
  };
  const paths = [...new Set([...(repositories?.keys() ?? []), ...markers.map((marker) => marker[1]!)])].sort((a, b) => b.length - a.length);
  const addFiles = (part: string) => {
    const index = indexPatch(part);
    for (const file of index.files) {
      const submodule = paths.find((path) => file.path.startsWith(path + "/") && (!file.oldPath || file.oldPath.startsWith(path + "/")) && (!file.newPath || file.newPath.startsWith(path + "/")));
      append(submodule ?? "", part.slice(file.start, file.end));
    }
  };
  let offset = 0;
  for (const marker of markers) {
    const [header, path, oldSha, newSha] = marker;
    addFiles(text.slice(offset, marker.index));
    if (oldSha !== newSha) {
      const patch = [
        `diff --git a/${path} b/${path}`, `index ${oldSha}..${newSha} 160000`,
        `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", `-Subproject commit ${oldSha}`, `+Subproject commit ${newSha}`,
      ].join("\n");
      const parent = paths.find((candidate) => path!.startsWith(candidate + "/"));
      append(parent ?? "", patch);
    }
    offset = marker.index + header.length;
  }
  addFiles(text.slice(offset));
  return Object.fromEntries([...groups].map(([path, parts]) => [path, parts.join("")]));
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
