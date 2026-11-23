/**
 * Go to definition / find references for the Review tab, in any language.
 *
 * Results arrive progressively from several engines, each labelled:
 *  1. "diff"   — the PR's changed lines (instant, no network)
 *  2. "syntax" — full head versions of the changed files, classified with
 *                tree-sitter where a grammar exists, text heuristics otherwise
 *  3. "repo"   — the rest of the repository at the PR head: `git grep` in an
 *                exact-revision worktree on desktop; GitHub code search on web
 *                (locates candidate files on the default branch, then reads
 *                them at the PR head)
 *  4. "lsp"    — a configured language server (desktop), confirmed results
 */
import { languageFamily, parseFileHunks, parsePRKey, scanOccurrences, type DiffFileEntry, type OccurrenceKind, type PRSnapshot, type TextOccurrence } from "@nonlinear/core";
import { githubApi, describeError } from "./github";
import { fileSectionOf, type LoadedDiff } from "./review";
import { syntaxOccurrences, hasGrammar } from "./treesitter";
import { exactRoot, lspAvailable, lspLocations } from "./lsp";
import { invoke, isDesktop } from "./platform";
import { useApp } from "./store";

export type Engine = "diff" | "syntax" | "text" | "repo" | "lsp";

export interface SymbolLocation {
  path: string;
  /** 0-based line in the file at the PR head (new side), or base (old side) for deleted lines */
  line: number;
  col: number;
  side: "new" | "old";
  kind: OccurrenceKind;
  label?: string;
  text: string;
  engine: Engine;
  inCode: boolean;
  /** row in the file's review diff (when the line is part of the PR diff) */
  ri?: number;
}

export interface EngineStatus {
  engine: Engine;
  state: "running" | "done" | "skipped" | "error";
  note?: string;
}

export interface SymbolQuery {
  pr: PRSnapshot;
  diff: LoadedDiff;
  name: string;
  /** where the user clicked, for the language server */
  origin?: { path: string; line: number; col: number; side: "new" | "old" };
}

const headFiles = new Map<string, Promise<string | null>>();

/** Head-revision contents of a file, cached per repo@sha:path. */
export function headFile(pr: PRSnapshot, path: string): Promise<string | null> {
  const r = parsePRKey(pr.key)!;
  const repo = pr.headRepo ?? `${r.owner}/${r.repo}`;
  const key = `${repo}@${pr.headSha}:${path}`;
  let p = headFiles.get(key);
  if (!p) {
    const [owner, name] = repo.split("/") as [string, string];
    p = githubApi().then((c) => c.contents(owner, name, path, pr.headSha)).catch(() => null);
    headFiles.set(key, p);
    if (headFiles.size > 400) headFiles.delete(headFiles.keys().next().value!);
  }
  return p;
}

const IDENT = /[A-Za-z0-9_$]/;
const wordAt = (s: string, i: number, n: number) => !(IDENT.test(s[i - 1] ?? "") || IDENT.test(s[i + n] ?? ""));

/** new-line number (1-based) → review row, per file */
function rowMaps(section: string) {
  const byNew = new Map<number, number>();
  const byOld = new Map<number, number>();
  let ri = 0;
  for (const h of parseFileHunks(section)) for (const l of h.lines) {
    if (l.newNo != null) byNew.set(l.newNo, ri);
    if (l.oldNo != null && l.newNo == null) byOld.set(l.oldNo, ri);
    ri++;
  }
  return { byNew, byOld };
}

/** 1. Occurrences on the PR's changed lines (both sides). */
function diffOccurrences(q: SymbolQuery): SymbolLocation[] {
  const out: SymbolLocation[] = [];
  for (const file of q.diff.index.files) {
    const section = fileSectionOf(q.diff, file);
    if (!section.includes(q.name)) continue;
    const family = languageFamily(file.path);
    let ri = 0;
    for (const h of parseFileHunks(section)) for (const l of h.lines) {
      if (l.kind !== "meta" && l.text.includes(q.name)) {
        const occ = scanOccurrences(l.text, q.name, family, 50);
        for (const o of occ) {
          const side = l.newNo != null ? "new" : "old";
          out.push({ path: file.path, line: (side === "new" ? l.newNo! : l.oldNo!) - 1, col: o.col, side, kind: o.kind, label: o.label, text: l.text, engine: "diff", inCode: o.inCode, ri });
        }
      }
      ri++;
    }
  }
  return out;
}

function toLocations(path: string, text: string, occ: TextOccurrence[], engine: Engine, rows?: ReturnType<typeof rowMaps>): SymbolLocation[] {
  const lines = text.split("\n");
  return occ.map((o) => ({ path, line: o.line, col: o.col, side: "new" as const, kind: o.kind, label: o.label, text: lines[o.line] ?? "", engine, inCode: o.inCode, ri: rows?.byNew.get(o.line + 1) }));
}

async function classifyFile(path: string, text: string, name: string): Promise<{ occ: TextOccurrence[]; engine: Engine }> {
  const syn = hasGrammar(path) ? await syntaxOccurrences(path, text, name) : null;
  return syn ? { occ: syn, engine: "syntax" } : { occ: scanOccurrences(text, name, languageFamily(path)), engine: "text" };
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>, cancelled: () => boolean) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length && !cancelled()) await fn(items[next++]!);
  }));
}

/**
 * Run all engines; `emit` is called with the merged result list each time an
 * engine adds results. Returns a cancel function.
 */
export function findSymbol(q: SymbolQuery, emit: (locations: SymbolLocation[], status: EngineStatus[]) => void, opts: { repo?: boolean } = {}): () => void {
  let cancelled = false;
  const isCancelled = () => cancelled;
  const results = new Map<string, SymbolLocation>();
  const status = new Map<Engine, EngineStatus>();
  const rank: Record<Engine, number> = { lsp: 4, syntax: 3, repo: 2, text: 2, diff: 1 };
  const add = (locs: SymbolLocation[]) => {
    for (const l of locs) {
      const k = `${l.path}:${l.side}:${l.line}:${l.col}`;
      const prev = results.get(k);
      if (!prev || rank[l.engine] > rank[prev.engine]) results.set(k, { ...l, ri: l.ri ?? prev?.ri });
    }
  };
  const flush = () => { if (!cancelled) emit([...results.values()], [...status.values()]); };
  const setStatus = (engine: Engine, state: EngineStatus["state"], note?: string) => { status.set(engine, { engine, state, note }); flush(); };

  const repoKey = `${q.pr.owner}/${q.pr.repo}`.toLowerCase();
  const files: DiffFileEntry[] = q.diff.index.files.filter((f) => f.kind !== "deleted" && !f.gitlink && !f.binary);
  const rowsFor = new Map<string, ReturnType<typeof rowMaps>>();
  const rowsOf = (path: string) => {
    let r = rowsFor.get(path);
    if (!r) {
      const f = q.diff.index.files.find((x) => x.path === path);
      r = f ? rowMaps(fileSectionOf(q.diff, f)) : { byNew: new Map(), byOld: new Map() };
      rowsFor.set(path, r);
    }
    return r;
  };

  // 1. diff (synchronous)
  add(diffOccurrences(q));
  setStatus("diff", "done");

  void (async () => {
    // 4. language server, in parallel (desktop, new side only)
    const lsp = q.origin && q.origin.side === "new" ? lspAvailable(repoKey, q.origin.path) : null;
    const lspRun = lsp?.ok ? (async () => {
      setStatus("lsp", "running", lsp.server.name);
      try {
        const [defs, refs] = await Promise.all((["definition", "references"] as const).map((m) => lspLocations(repoKey, q.origin!.path, m, q.origin!.line, q.origin!.col, q.pr.headSha).catch(() => null)));
        const locs: SymbolLocation[] = [];
        for (const [res, kind] of [[defs, "definition"], [refs, "reference"]] as const) {
          for (const l of res?.locations ?? []) {
            if (l.path.startsWith("file:") || l.path.startsWith("/")) continue; // outside the repository
            const text = (await headFile(q.pr, l.path))?.split("\n")[l.line] ?? "";
            locs.push({ path: l.path, line: l.line, col: l.character, side: "new", kind, text, engine: "lsp", inCode: true, ri: rowsOf(l.path).byNew.get(l.line + 1) });
          }
        }
        add(locs);
        setStatus("lsp", "done", `${lsp.server.name} · ${locs.length}`);
      } catch (e) {
        setStatus("lsp", "error", (e as Error).message);
      }
    })() : Promise.resolve();

    // 2. full head versions of changed files (same language family first; bounded)
    setStatus("syntax", "running", `${files.length} changed files`);
    const family = q.origin ? languageFamily(q.origin.path) : null;
    const ordered = [...files].sort((a, b) => Number(languageFamily(b.path) === family) - Number(languageFamily(a.path) === family)).slice(0, 80);
    let read = 0;
    await pool(ordered, 6, async (f) => {
      const text = await headFile(q.pr, f.path);
      if (!text || text.length > 3_000_000 || !text.includes(q.name)) return;
      read++;
      const { occ, engine } = await classifyFile(f.path, text, q.name);
      add(toLocations(f.path, text, occ, engine, rowsOf(f.path)));
      flush();
    }, isCancelled);
    if (cancelled) return;
    setStatus("syntax", "done", `${read} file(s) contain it${files.length > ordered.length ? ` · first ${ordered.length} of ${files.length} files` : ""}`);

    // 3. whole repository — automatically when no definition is known yet, or on request
    const haveDef = [...results.values()].some((l) => l.kind === "definition" && l.inCode);
    if (opts.repo || !haveDef) await searchRepository(q, add, setStatus, rowsOf, isCancelled, files);
    else setStatus("repo", "skipped", "definition found in the PR; search the whole repository on request");
    await lspRun;
    flush();
  })().catch((e) => setStatus("syntax", "error", describeError(e)));

  return () => { cancelled = true; };
}

async function searchRepository(
  q: SymbolQuery,
  add: (l: SymbolLocation[]) => void,
  setStatus: (engine: Engine, state: EngineStatus["state"], note?: string) => void,
  rowsOf: (path: string) => ReturnType<typeof rowMaps>,
  cancelled: () => boolean,
  changed: DiffFileEntry[],
) {
  const repoKey = `${q.pr.owner}/${q.pr.repo}`.toLowerCase();
  const changedPaths = new Set(changed.map((f) => f.path));
  if (isDesktop()) {
    setStatus("repo", "running", "git grep at the PR head");
    try {
      const root = await exactRoot(repoKey, q.pr.headSha);
      const hits = await invoke<{ path: string; line: number; column: number; text: string }[]>("git_grep", { repoPath: root, word: q.name, max: 2000 });
      if (cancelled()) return;
      const byFile = new Map<string, typeof hits>();
      for (const h of hits) if (!changedPaths.has(h.path)) byFile.set(h.path, [...(byFile.get(h.path) ?? []), h]);
      const locs: SymbolLocation[] = [];
      for (const [path, list] of byFile) {
        const family = languageFamily(path);
        for (const h of list) {
          const col = Math.max(0, byteColToChar(h.text, h.column - 1));
          const occ = scanOccurrences(h.text, q.name, family, 20).find((o) => o.col === col) ?? scanOccurrences(h.text, q.name, family, 1)[0];
          if (occ) locs.push({ path, line: h.line - 1, col: occ.col, side: "new", kind: occ.kind, label: occ.label, text: h.text, engine: "repo", inCode: occ.inCode, ri: rowsOf(path).byNew.get(h.line) });
        }
      }
      add(locs);
      setStatus("repo", "done", `git grep · ${hits.length} hit(s) in ${byFile.size} other file(s)${hits.length >= 2000 ? " (first 2000)" : ""}`);
    } catch (e) {
      setStatus("repo", "error", `git grep: ${(e as Error).message ?? e}`);
    }
    return;
  }
  const s = useApp.getState().settings_();
  if (s.authMode === "anonymous") {
    setStatus("repo", "skipped", "Sign in to search the rest of the repository (GitHub code search needs a token).");
    return;
  }
  setStatus("repo", "running", "GitHub code search");
  try {
    const c = await githubApi();
    const res = await c.request<{ total_count: number; items: { path: string }[] }>("GET", `/search/code?q=${encodeURIComponent(`${q.name} repo:${q.pr.owner}/${q.pr.repo}`)}&per_page=30`);
    const paths = [...new Set(res.items.map((i) => i.path))].filter((p) => !changedPaths.has(p)).slice(0, 15);
    let found = 0;
    await pool(paths, 5, async (path) => {
      const text = await headFile(q.pr, path);
      if (!text?.includes(q.name)) return;
      const { occ } = await classifyFile(path, text, q.name);
      found += occ.length;
      add(toLocations(path, text, occ, "repo", rowsOf(path)));
    }, cancelled);
    setStatus("repo", "done", `GitHub code search (default branch) → ${paths.length} file(s) read at the PR head, ${found} hit(s)${res.total_count > 30 ? ` · ${res.total_count} files matched, first 30 used` : ""}`);
  } catch (e) {
    setStatus("repo", "error", `GitHub code search: ${describeError(e)}`);
  }
}

/** git grep reports byte columns; convert to a JS string index for UTF-8 text. */
function byteColToChar(text: string, byteCol: number): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    if (bytes >= byteCol) return i;
    const c = text.charCodeAt(i);
    bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c < 0xdc00 ? (i++, 4) : 3;
  }
  return text.length;
}

/** Column of a click inside a `.code` cell (text offset), using the caret under the pointer. */
export function columnAtPoint(x: number, y: number, codeEl: Element): number | null {
  type CaretPos = { offsetNode: Node; offset: number };
  const doc = document as Document & { caretPositionFromPoint?: (x: number, y: number) => CaretPos | null };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    if (p) { node = p.offsetNode; offset = p.offset; }
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) { node = r.startContainer; offset = r.startOffset; }
  }
  if (!node || !codeEl.contains(node)) return null;
  const range = document.createRange();
  range.setStart(codeEl, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

export const ENGINE_LABEL: Record<Engine, string> = {
  diff: "PR diff",
  syntax: "syntax tree",
  text: "text match",
  repo: "repository",
  lsp: "language server",
};

export { wordAt };
