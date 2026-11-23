import { copyText } from "../lib/clipboard";
import { NavIcon } from "../components/NavIcon";
import { useShallow } from "zustand/react/shallow";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  buildFilePrompt,
  diffHash,
  fileStatus,
  flagRange,
  freshness,
  indexPatch,
  markAllReviewed,
  markReviewed,
  newId,
  parseFileHunks,
  parseGitmodules,
  parsePRKey,
  progress,
  resetFile,
  setFrontier,
  unflagRange,
  type DiffFileEntry,
  type DiffLine,
  type FileReviewState,
  type Hunk,
  type Interval,
  type PRSnapshot,
  type PrivateNote,
  proposeGitlink,
  gitlinkPatch,
  toCommitNode,
  type GitlinkProposal,
  type RawCommit,
  type RawReviewComment,
  buildFileTree,
  visibleTreeRows,
  ancestorFolders,
  buildFindIndex,
  findInIndex,
  nextMatch,
  matchesByRow,
  countMatchesPerFile,
  identifierAt,
  toSplitRows,
} from "@nonlinear/core";
import { useApp, useSettings, type DraftComment } from "../lib/store";
import { fileSectionOf, loadInlineComments, fileState, saveFileState, gitlinkShas, type LoadedDiff } from "../lib/review";
import { githubApi, describeError, signalReviewStart } from "../lib/github";
import { aiAllowedFor, latestSummary, summarize } from "../lib/ai";
import { renderMarkdown } from "../lib/markdown";
import { isDesktop, desktop, invoke } from "../lib/platform";
import { exactRoot, headMatches, lspAvailable, lspLocations, workingTreeFor, type LspLocation } from "../lib/lsp";
import { useActions } from "../lib/keys";
import { expandToEnclosing } from "../lib/treesitter";
import { DiffCodeLayoutSelect, FileDiff, hunkStarts, useDiffCodeLayout, type DiffCodeLayout, type DiffMode, type DiffSide } from "../components/FileDiff";
import { Split, Modal, download, DiffStat } from "../components/ui";
import type { AskTarget } from "../components/AskAI";
import { FileInspector } from "./FileInspector";
import { SymbolPanel, type SymbolRequest } from "../components/SymbolPanel";
import { columnAtPoint, type SymbolLocation } from "../lib/codenav";

const onDiffSide = (line: DiffLine, side?: DiffSide) =>
  side === "LEFT" ? line.oldNo !== null : side === "RIGHT" ? line.newNo !== null : true;

const STATUS_ICON: Record<string, string> = { complete: "✓", incomplete: "◐", "not-started": "○", postponed: "⏸", "needs-rereview": "⟳" };

export interface FindState {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  scope: "file" | "all";
  /** bump to refocus the find input */
  focus: number;
}

type FileView = "list" | "tree";

export function ReviewFiles({ pr, diff, refreshComments, focusSearch, onAsk }: { pr: PRSnapshot; diff: LoadedDiff; refreshComments: number; focusSearch?: boolean; onAsk: (target: AskTarget) => void }) {
  const [comments, setComments] = useState<RawReviewComment[]>([]);
  useEffect(() => {
    let active = true;
    void loadInlineComments(pr, refreshComments).then((items) => {
      if (active) setComments(items);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [pr.key, pr.headSha, refreshComments]);
  const reviews = useApp((s) => s.reviews[pr.key]);
  const [selectedPath, setSelectedPath] = useState(() => localStorage.getItem(`nl:review-file:${pr.key}`) ?? "");
  const notePaths = useApp(useShallow((s) => Object.values(s.notes).filter((note) => note.prKey === pr.key && note.anchor).map((note) => note.anchor!.path)));
  const commentPaths = useMemo(() => new Set(comments.map((comment) => comment.path)), [comments]);
  const [filter, setFilter] = useState("");
  const filterInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focusSearch) { filterInput.current?.focus(); filterInput.current?.select(); } }, [focusSearch]);
  const [mode, setMode] = useState<DiffMode>(() => (localStorage.getItem("nl:diffmode") as DiffMode) ?? "unified");
  const [layout, setLayout] = useDiffCodeLayout("nl:review-fit", "scroll");
  const [view, setView] = useState<FileView>(() => localStorage.getItem("nl:review-file-view") === "tree" ? "tree" : "list");
  const changeView = (v: FileView) => { setView(v); localStorage.setItem("nl:review-file-view", v); };
  const files = diff.index.files;
  const tree = useMemo(() => buildFileTree(files.map((f) => f.path)), [files]);
  const visibleSet = useMemo(() => {
    const q = filter.toLowerCase();
    return new Set(files.map((f, i) => (!q || f.path.toLowerCase().includes(q) ? i : -1)).filter((i) => i >= 0));
  }, [files, filter]);
  const order = useMemo(() => (view === "tree" ? tree.order : files.map((_, i) => i)).filter((i) => visibleSet.has(i)), [view, tree, files, visibleSet]);
  const sel = Math.max(0, files.findIndex((file) => file.path === selectedPath));
  const setSel = (index: number) => {
    const path = files[index]?.path;
    if (!path) return;
    localStorage.setItem(`nl:review-file:${pr.key}`, path);
    setSelectedPath(path);
  };
  const f = files[sel];

  // Folder collapse state (tree view), remembered per PR.
  const collapseKey = `nl:review-tree-collapsed:${pr.key}`;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(collapseKey) ?? "[]") as string[]); } catch { return new Set(); }
  });
  const saveCollapsed = (next: Set<string>) => { setCollapsed(next); try { localStorage.setItem(collapseKey, JSON.stringify([...next])); } catch { /* storage full or blocked */ } };
  // Keep the selected file visible: expand its folders.
  useEffect(() => {
    if (view !== "tree") return;
    const up = ancestorFolders(tree, sel).filter((p) => collapsed.has(p));
    if (up.length) saveCollapsed(new Set([...collapsed].filter((p) => !up.includes(p))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, view, tree]);

  const step = (dir: 1 | -1) => {
    if (!order.length) return;
    const at = order.indexOf(sel);
    setSel(order[at < 0 ? 0 : Math.max(0, Math.min(order.length - 1, at + dir))]!);
  };
  useActions({ next: () => step(1), prev: () => step(-1) }, [order, sel]);

  // ---- Find (Cmd/Ctrl+F in the code) ----
  const [find, setFind] = useState<FindState>({ open: false, query: "", caseSensitive: false, wholeWord: false, regex: false, scope: "file", focus: 0 });
  const [pendingFind, setPendingFind] = useState<{ path: string; at: "first" | "last" } | null>(null);
  const deferredQuery = useDeferredValue(find.open && find.scope === "all" ? find.query : "");
  const lowerText = useMemo(() => (find.scope === "all" && find.open && !find.caseSensitive ? diff.text.toLowerCase() : null), [diff.text, find.scope, find.open, find.caseSensitive]);
  const fileCounts = useMemo(() => countMatchesPerFile(diff.text, lowerText, files.map((x) => x.start), deferredQuery, { caseSensitive: find.caseSensitive, wholeWord: find.wholeWord, regex: find.regex }),
    [diff.text, lowerText, files, deferredQuery, find.caseSensitive, find.wholeWord, find.regex]);
  const showCounts = find.open && find.scope === "all" && !!deferredQuery;
  const totalAll = showCounts ? [...fileCounts.values()].reduce((a, b) => a + b, 0) : 0;
  const findEdge = (dir: 1 | -1) => {
    if (find.scope !== "all") return false;
    const candidates = (view === "tree" ? tree.order : files.map((_, i) => i)).filter((i) => (fileCounts.get(i) ?? 0) > 0);
    if (!candidates.length) return false;
    const at = candidates.indexOf(sel);
    const next = candidates[((at < 0 ? (dir > 0 ? -1 : 0) : at) + dir + candidates.length) % candidates.length]!;
    if (next === sel) return false;
    setPendingFind({ path: files[next]!.path, at: dir > 0 ? "first" : "last" });
    setSel(next);
    return true;
  };

  // ---- Go to definition / find references ----
  const [symbol, setSymbol] = useState<SymbolRequest | null>(null);
  const [reveal, setReveal] = useState<{ path: string; ri: number; n: number } | null>(null);
  const [inspectAt, setInspectAt] = useState<{ path: string; line: number } | null>(null);
  const requestSymbol = (name: string, origin: SymbolRequest["origin"], mode: SymbolRequest["mode"]) =>
    setSymbol((prev) => ({ name, origin, mode, n: (prev?.n ?? 0) + 1 }));
  const openLocation = (loc: SymbolLocation) => {
    const index = files.findIndex((x) => x.path === loc.path);
    if (loc.ri !== undefined && index >= 0) {
      setSel(index);
      setReveal((prev) => ({ path: loc.path, ri: loc.ri!, n: (prev?.n ?? 0) + 1 }));
    } else {
      setInspectAt({ path: loc.path, line: loc.line });
    }
  };
  useEffect(() => {
    if (!symbol) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".overlay:not([inert])") && !(e.target instanceof Element && e.target.closest(".find-bar, .inline-annotation, .review-context-menu"))) setSymbol(null);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [symbol]);

  const fileRow = (file: DiffFileEntry, i: number, depth?: number) => {
    const s = reviews?.files[file.path];
    const st = s ? fileStatus(s) : "not-started";
    const pct = s ? progress(s) : 0;
    const count = showCounts ? fileCounts.get(i) : undefined;
    const name = file.path.split("/").pop();
    return (
      <div key={file.path} role="treeitem" aria-selected={i === sel} aria-level={depth === undefined ? undefined : depth + 1} className={`tree-row ${i === sel ? "active" : ""} ${showCounts && !count ? "dim" : ""}`}
        style={depth === undefined ? undefined : { paddingLeft: 8 + depth * 14 }} onClick={() => setSel(i)} title={`${file.path} — ${st}`}>
        <span style={{ width: 14, flex: "none", color: st === "complete" ? "var(--ok)" : st === "needs-rereview" ? "var(--err)" : st === "incomplete" ? "var(--warn)" : "var(--text-3)" }} aria-label={st}>
          {STATUS_ICON[st]}
        </span>
        <span className="grow ellipsis">
          {name}
          {depth === undefined && <span className="faint small"> {file.path.split("/").slice(0, -1).join("/")}</span>}
        </span>
        {count ? <span className="chip find-count" title={`${count} match${count > 1 ? "es" : ""}`}>{count}</span> : null}
        {notePaths.includes(file.path) && <span className="file-annotation-marker note" title="Private note" aria-label="Private note">N</span>}
        {commentPaths.has(file.path) && <span className="file-annotation-marker comment" title="GitHub review comment" aria-label="GitHub review comment">C</span>}
        {file.gitlink && <span className="chip info">sub</span>}
        <span className="faint small">{Math.round(pct * 100)}%</span>
      </div>
    );
  };

  const treeRows = useMemo(() => {
    if (view !== "tree") return [];
    // While filtering, show every matching file with its folders expanded.
    const effective = filter ? new Set<string>() : collapsed;
    return visibleTreeRows(tree, effective).filter((n) => (n.kind === "file" ? visibleSet.has(n.index) : n.files.some((i) => visibleSet.has(i))));
  }, [view, tree, collapsed, filter, visibleSet]);

  return (
    <>
    <Split id="review-files" initial={0.22}>
      <div className="col review-file-list" style={{ height: "100%", gap: 0 }} aria-label="Changed files">
        <div className="review-file-list-head">
          <span>Files changed · {files.length}</span>
          <DiffStat compact additions={files.reduce((n, x) => n + x.additions, 0)} deletions={files.reduce((n, x) => n + x.deletions, 0)} />
          <span className="spacer" />
          <div className="seg-toggle" role="group" aria-label="File list layout">
            <button type="button" className={view === "list" ? "on" : ""} aria-pressed={view === "list"} onClick={() => changeView("list")} title="Flat list"><NavIcon name="list" /></button>
            <button type="button" className={view === "tree" ? "on" : ""} aria-pressed={view === "tree"} onClick={() => changeView("tree")} title="Folder tree"><NavIcon name="tree" /></button>
          </div>
        </div>
        <div className="toolbar">
          <input ref={filterInput} className="input grow" data-workspace-search placeholder="Filter files" aria-label="Filter files" value={filter}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== "Escape") return;
              e.preventDefault();
              e.stopPropagation();
              if (e.key === "Enter" && order.length && !order.includes(sel)) setSel(order[0]!);
              e.currentTarget.blur();
            }} onChange={(e) => setFilter(e.target.value)} />
          {view === "tree" && !filter && (
            <button className="btn ghost sm" title={collapsed.size ? "Expand all folders" : "Collapse all folders"}
              onClick={() => saveCollapsed(collapsed.size ? new Set() : new Set(visibleTreeRows(tree, new Set()).filter((n) => n.kind === "folder").map((n) => n.path)))}>
              {collapsed.size ? "Expand" : "Collapse"}
            </button>
          )}
        </div>
        {showCounts && <div className="find-summary small">{totalAll ? `${totalAll.toLocaleString()} match${totalAll > 1 ? "es" : ""} in ${fileCounts.size} file${fileCounts.size > 1 ? "s" : ""}` : "No matches in any file"}</div>}
        <div style={{ overflow: "auto", flex: 1, padding: 4 }} role="tree" aria-label={view === "tree" ? "Changed files by folder" : "Changed files"}>
          {view === "list" && order.map((i) => fileRow(files[i]!, i))}
          {view === "tree" && treeRows.map((n) => n.kind === "file" ? fileRow(files[n.index]!, n.index, n.depth) : (
            <div key={`dir:${n.path}`} role="treeitem" aria-expanded={filter ? true : !collapsed.has(n.path)} aria-level={n.depth + 1} className="tree-row tree-folder"
              style={{ paddingLeft: 8 + n.depth * 14 }} title={n.path}
              onClick={() => { if (filter) return; const next = new Set(collapsed); if (next.has(n.path)) next.delete(n.path); else next.add(n.path); saveCollapsed(next); }}>
              <span className={`tree-chevron ${filter || !collapsed.has(n.path) ? "open" : ""}`}><NavIcon name="chevron" /></span>
              <span className="grow ellipsis">{n.name}</span>
              {showCounts && (() => { const c = n.files.reduce((a, i) => a + (fileCounts.get(i) ?? 0), 0); return c ? <span className="chip find-count">{c}</span> : null; })()}
              <span className="faint small">{n.files.filter((i) => reviews?.files[files[i]!.path] && fileStatus(reviews.files[files[i]!.path]!) === "complete").length}/{n.files.length}</span>
            </div>
          ))}
          {!order.length && <div className="empty small">No files match “{filter}”.</div>}
        </div>
      </div>
      <Split id="review-symbols" vertical initial={0.68} min={0.2} showSecond={!!symbol}>
        {f ? <FilePane key={`${f.path}:${pr.headSha}`} pr={pr} diff={diff} file={f} comments={comments} onAsk={onAsk} layout={layout} setLayout={setLayout} mode={mode} setMode={(m) => { setMode(m); localStorage.setItem("nl:diffmode", m); }}
          find={find} setFind={setFind} pendingFind={pendingFind?.path === f.path ? pendingFind.at : null} clearPendingFind={() => setPendingFind(null)} onFindEdge={findEdge}
          allMatches={showCounts ? totalAll : null}
          reveal={reveal?.path === f.path ? reveal : null}
          onSymbol={requestSymbol} /> : <div className="empty">No files</div>}
        {symbol ? <SymbolPanel pr={pr} diff={diff} request={symbol} onOpen={openLocation} onClose={() => setSymbol(null)} /> : <div />}
      </Split>
    </Split>
    {inspectAt && f && <FileInspector pr={pr} diff={diff} file={f} at={inspectAt} onClose={() => setInspectAt(null)} />}
    </>
  );
}

function FilePane({ pr, diff, file, comments, layout, setLayout, mode, setMode, onAsk, find, setFind, pendingFind, clearPendingFind, onFindEdge, allMatches, reveal, onSymbol }: {
  pr: PRSnapshot; diff: LoadedDiff; file: DiffFileEntry; comments: RawReviewComment[]; layout: DiffCodeLayout; setLayout: (layout: DiffCodeLayout) => void; mode: DiffMode; setMode: (m: DiffMode) => void; onAsk: (target: AskTarget) => void;
  find: FindState; setFind: React.Dispatch<React.SetStateAction<FindState>>; pendingFind: "first" | "last" | null; clearPendingFind: () => void; onFindEdge: (dir: 1 | -1) => boolean; allMatches: number | null;
  reveal: { ri: number; n: number } | null;
  onSymbol: (name: string, origin: SymbolRequest["origin"], mode: SymbolRequest["mode"]) => void;
}) {
  const section = useMemo(() => fileSectionOf(diff, file), [diff, file]);
  const hunks = useMemo(() => parseFileHunks(section), [section]);
  const progressRec = useApp((s) => s.reviews[pr.key]);
  const state = fileState(progressRec, file, section);
  const notes = useApp(useShallow((s) => Object.values(s.notes).filter((n) => n.prKey === pr.key && n.anchor?.path === file.path)));
  const drafts = useApp(useShallow((s) => Object.values(s.drafts).filter((d) => d.prKey === pr.key && d.path === file.path)));
  const put = useApp((s) => s.put);
  const toast = useApp((s) => s.toast);
  const [selection, setSelection] = useState<Interval | null>(null);
  const [selectedSide, setSelectedSide] = useState<DiffSide>();
  // Side-by-side: a selection covers whole rows (both sides) for review marks, notes and copying;
  // a GitHub comment still goes on the side that was clicked, as on GitHub.
  const selectionSide: DiffSide | undefined = undefined;
  const commentSide = mode === "split" ? selectedSide : undefined;
  const allRows = useMemo(() => hunks.flatMap((h) => h.lines), [hunks]);
  // Side-by-side rows pair lines that aren't adjacent in file order; map each line to the span of its row
  // so a selection of rows covers both sides.
  const splitSpan = useMemo(() => {
    const span = new Map<number, [number, number]>();
    let ri = 0;
    for (const h of hunks) {
      const index = new Map<DiffLine, number>();
      for (const l of h.lines) index.set(l, ri++);
      for (const row of toSplitRows(h)) {
        const ris = [row.left, row.right].filter((l): l is DiffLine => !!l).map((l) => index.get(l)!);
        if (!ris.length) continue;
        const lo = Math.min(...ris);
        const hi = Math.max(...ris);
        for (const x of ris) span.set(x, [lo, hi]);
      }
    }
    return span;
  }, [hunks]);
  const wholeRows = (iv: Interval): Interval => mode !== "split" ? iv
    : [Math.min(iv[0], splitSpan.get(iv[0])?.[0] ?? iv[0]), Math.max(iv[1], (splitSpan.get(iv[1] - 1)?.[1] ?? iv[1] - 1) + 1)];
  const selectedLines = useMemo(() => selection
    ? allRows.slice(...selection).filter((line) => line.kind !== "meta" && onDiffSide(line, selectionSide))
    : [], [allRows, selection, selectionSide]);
  const [anchorLine, setAnchorLine] = useState<DiffLine | null>(null);
  const [fileHash, setFileHash] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void crypto.subtle?.digest("SHA-256", new TextEncoder().encode(file.path)).then((digest) => {
      if (active) setFileHash(Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [file.path]);
  const lineAnchor = (line: DiffLine) => {
    if (selectedSide === "LEFT" && line.oldNo !== null) return `L${line.oldNo}`;
    if (line.newNo !== null) return `R${line.newNo}`;
    return `L${line.oldNo}`;
  };
  const firstLine = selectedLines[0];
  const lastLine = selectedLines.at(-1);
  const copyGitHubLink = async () => {
    if (!fileHash || !firstLine || !lastLine) return;
    const url = new URL(pr.url);
    url.pathname = url.pathname.replace(/\/$/, "") + "/files";
    url.search = "";
    const start = lineAnchor(firstLine);
    const end = lineAnchor(lastLine);
    url.hash = `diff-${fileHash}${start}${end === start ? "" : "-" + end}`;
    const copied = await copyText(url.href);
    toast(copied ? "info" : "error", copied ? "GitHub link copied" : "Could not copy the GitHub link.");
  };

  const [composer, setComposer] = useState<null | "note" | "comment">(null);
  const [menu, setMenu] = useState<{ x: number; y: number; word?: { name: string; origin: NonNullable<SymbolRequest["origin"]> } } | null>(null);
  const [showNotes, setShowNotes] = useState(() => localStorage.getItem("nl:inline-notes") !== "false");
  const [showComments, setShowComments] = useState(() => localStorage.getItem("nl:inline-comments") !== "false");
  const [showRail, setShowRail] = useState(() => localStorage.getItem("nl:review-notes-pane") === "true");
  const [closedAnnotations, setClosedAnnotations] = useState<Set<string>>(() => new Set());
  const annotation = (id: string, label: string, body: string, url?: string, actions?: React.ReactNode) =>
    <details key={id} className="panel inline-annotation" open={!closedAnnotations.has(id)} onToggle={(e) => {
      const open = e.currentTarget.open;
      setClosedAnnotations((previous) => {
        if (open === !previous.has(id)) return previous;
        const next = new Set(previous);
        if (open) next.delete(id);
        else next.add(id);
        return next;
      });
    }}><summary>{label}</summary>{actions && <div className="annotation-actions">{actions}</div>}
      <div>{body}</div>{url && <a href={url} target="_blank" rel="noreferrer">View on GitHub ↗</a>}</details>;
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".overlay:not([inert]), #workspace-content[inert]")) {
        setComposer(null);
        setSelection(null);
        setMenu(null);
      }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (e: PointerEvent) => { if (!(e.target instanceof Element && e.target.closest(".review-context-menu"))) setMenu(null); };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [menu]);
  // Click anywhere outside the selected lines (and selection tools) clears the selection.
  useEffect(() => {
    if (!selection) return;
    const away = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || e.button !== 0) return;
      if (window.getSelection()?.toString()) return; // user is selecting text to copy
      if (e.target.closest(".dl.sel, .dl .no, .diff-annotation, .review-context-menu, .selection-bar, .rail, [data-keep-selection], .overlay, .modal, .inline-annotation")) return;
      setSelection(null);
      setComposer(null);
    };
    window.addEventListener("click", away);
    return () => window.removeEventListener("click", away);
  }, [selection]);
  const [scrollTo, setScrollTo] = useState<number | null>(null);
  const [expansions, setExpansions] = useState(new Map<number, { lines: string[]; startNo: number; label?: string }>());
  const [inspector, setInspector] = useState(false);
  const [impact, setImpact] = useState(false);
  const [sub, setSub] = useState(false);
  useEffect(() => {
    if (!selectedLines.length || sub) return;
    const text = selectedLines.map((line) => line.text).join("\n");
    const canCopyReview = () =>
      !document.getSelection()?.toString() &&
      !document.activeElement?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])') &&
      !document.querySelector(".overlay:not([inert]), #workspace-content[inert]");
    const onCopy = (event: ClipboardEvent) => {
      if (event.defaultPrevented || !event.clipboardData || !canCopyReview()) return;
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey ||
          event.key.toLowerCase() !== "c" || !canCopyReview()) return;
      // The synchronous copy event also works in webviews where the async Clipboard API is unavailable.
      try {
        if (document.execCommand("copy")) {
          event.preventDefault();
          return;
        }
      } catch { /* Continue with the async Clipboard API when available. */ }
      if (!navigator.clipboard) return;
      event.preventDefault();
      void navigator.clipboard.writeText(text).catch(() => toast("error", "Could not copy the selected lines."));
    };
    window.addEventListener("copy", onCopy);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("keydown", onKey);
    };
  }, [selectedLines, sub, toast]);

  // ---- Find in this file ----
  const findIndex = useMemo(() => buildFindIndex(allRows.map((line) => line.text)), [allRows]);
  const findQuery = useDeferredValue(find.open ? find.query : "");
  const findRes = useMemo(() => findInIndex(findIndex, findQuery, { caseSensitive: find.caseSensitive, wholeWord: find.wholeWord, regex: find.regex }),
    [findIndex, findQuery, find.caseSensitive, find.wholeWord, find.regex]);
  const findByRow = useMemo(() => matchesByRow(findRes), [findRes]);
  const [findCur, setFindCur] = useState(-1);
  const [localReveal, setLocalReveal] = useState<{ ri: number; n: number } | null>(reveal);
  const revealRow = (ri: number) => setLocalReveal((prev) => ({ ri, n: (prev?.n ?? 0) + 1 }));
  const goToMatch = (i: number) => {
    if (i < 0 || i >= findRes.rows.length) return;
    setFindCur(i);
    revealRow(findRes.rows[i]!);
  };
  // New results: start at the first match at/after the current position (or where a cross-file jump asked).
  useEffect(() => {
    if (!findRes.rows.length) { setFindCur(-1); return; }
    if (pendingFind) {
      goToMatch(pendingFind === "first" ? 0 : findRes.rows.length - 1);
      clearPendingFind();
      return;
    }
    const from = selection?.[0] ?? localReveal?.ri ?? 0;
    goToMatch(nextMatch(findRes, from, -1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findRes]);
  const findStep = (dir: 1 | -1) => {
    const n = findRes.rows.length;
    if (!n) { onFindEdge(dir); return; }
    const next = findCur + dir;
    if ((next >= n || next < 0) && onFindEdge(dir)) return;
    goToMatch((next + n) % n);
  };
  // Parent asked to reveal a row (symbol navigation): select it and scroll there.
  useEffect(() => {
    if (!reveal) return;
    setSelectedSide(undefined);
    setSelection([reveal.ri, reveal.ri + 1]);
    revealRow(reveal.ri);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.n]);

  const codeArea = useRef<HTMLDivElement>(null);
  const codeFocused = useRef(false);
  const findInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (find.open) { findInput.current?.focus(); findInput.current?.select(); } }, [find.focus]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target instanceof Node ? e.target : null;
      codeFocused.current = !!t && (!!codeArea.current?.contains(t) || !!(t instanceof Element && t.closest(".find-bar, .symbol-panel")));
    };
    const key = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const inCode = codeFocused.current || !!(document.activeElement && codeArea.current?.contains(document.activeElement)) || !!document.activeElement?.closest(".find-bar");
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f" && inCode && !document.querySelector(".overlay:not([inert])")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const picked = window.getSelection()?.toString() ?? "";
        const seed = picked && !picked.includes("\n") && picked.length < 200 && codeArea.current?.contains(window.getSelection()!.anchorNode) ? picked : null;
        setFind((f) => ({ ...f, open: true, query: seed ?? f.query, focus: f.focus + 1 }));
        return;
      }
      if (find.open && ((mod && e.key.toLowerCase() === "g") || e.key === "F3")) {
        e.preventDefault();
        findStep(e.shiftKey ? -1 : 1);
        return;
      }
      if ((e.key === "F12") && inCode) {
        const word = selectedWord();
        if (word) { e.preventDefault(); onSymbol(word.name, word.origin, e.shiftKey ? "references" : "definition"); }
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("pointerdown", down, true); window.removeEventListener("keydown", key, true); };
  });

  /** Identifier at a click inside a code cell. */
  const wordFromEvent = (e: React.MouseEvent, line: DiffLine): { name: string; origin: NonNullable<SymbolRequest["origin"]> } | null => {
    const code = e.target instanceof Element ? e.target.closest(".code") : null;
    if (!code) return null;
    const col = columnAtPoint(e.clientX, e.clientY, code);
    if (col == null) return null;
    const id = identifierAt(line.text, col);
    if (!id) return null;
    const side = line.newNo != null ? "new" as const : "old" as const;
    return { name: id.name, origin: { path: file.path, line: (side === "new" ? line.newNo! : line.oldNo!) - 1, col: id.start, side } };
  };
  /** Identifier in the current text selection inside the code (for F12). */
  const selectedWord = () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? "";
    if (!sel || !text || !codeArea.current?.contains(sel.anchorNode)) return null;
    const id = identifierAt(text, 0);
    if (!id || id.name !== text) return null;
    const row = sel.anchorNode?.parentElement?.closest(".dl");
    const no = row?.querySelectorAll(".no");
    const newNo = Number(no?.[no.length - 1]?.textContent || NaN);
    return { name: id.name, origin: Number.isFinite(newNo) ? { path: file.path, line: newNo - 1, col: 0, side: "new" as const } : undefined };
  };
  const [modHeld, setModHeld] = useState(false);
  useEffect(() => {
    const k = (e: KeyboardEvent) => setModHeld(e.metaKey || e.ctrlKey);
    const blur = () => setModHeld(false);
    window.addEventListener("keydown", k);
    window.addEventListener("keyup", k);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", k); window.removeEventListener("keyup", k); window.removeEventListener("blur", blur); };
  }, []);

  const starts = useMemo(() => hunkStarts(hunks), [hunks]);
  const st = fileStatus(state);
  const save = (s: FileReviewState) => saveFileState(pr, s);
  const reviewed = st === "complete";
  const curHunk = () => {
    const pos = selection?.[0] ?? scrollTo ?? 0;
    let h = 0;
    starts.forEach((s, i) => { if (s <= pos) h = i; });
    return h;
  };
  const hunkRange = (h: number): Interval => [starts[h]!, (starts[h + 1] ?? starts[h]! + hunks[h]!.lines.length)];

  const changeSelection = (change: (file: FileReviewState, range: Interval) => FileReviewState, fallback?: Interval) => {
    const range = selection ?? fallback;
    if (!range) return;
    if (!selectionSide || !selection) {
      save(change(state, range));
      return;
    }
    let next = state;
    let start = range[0];
    while (start < range[1]) {
      if (!onDiffSide(allRows[start]!, selectionSide)) { start++; continue; }
      let end = start + 1;
      while (end < range[1] && onDiffSide(allRows[end]!, selectionSide)) end++;
      next = change(next, [start, end]);
      start = end;
    }
    save(next);
  };

  useActions(
    {
      nextHunk: () => { const h = Math.min(hunks.length - 1, curHunk() + 1); setScrollTo(starts[h]!); setSelectedSide(undefined); setSelection(hunkRange(h)); },
      prevHunk: () => { const h = Math.max(0, curHunk() - 1); setScrollTo(starts[h]!); setSelectedSide(undefined); setSelection(hunkRange(h)); },
      markReviewed: () => changeSelection(markReviewed, hunks.length ? hunkRange(curHunk()) : undefined),
      flag: () => changeSelection(flagRange),
      comment: () => selection && setComposer("comment"),
      impact: () => setImpact(true),
    },
    [selection, state, hunks, scrollTo],
  );

  // Semantic expansion (§5.4): fetch full head file, expand to enclosing block.
  const [fullFile, setFullFile] = useState<string[] | null>(null);
  const loadFull = async (): Promise<string[] | null> => {
    if (fullFile) return fullFile;
    const r = parsePRKey(pr.key)!;
    const owner = pr.headRepo?.split("/")[0] ?? r.owner;
    const repo = pr.headRepo?.split("/")[1] ?? r.repo;
    try {
      const txt = await (await githubApi()).contents(owner, repo, file.path, pr.headSha);
      const lines = txt?.split("\n") ?? null;
      setFullFile(lines);
      return lines;
    } catch (e) {
      toast("error", describeError(e));
      return null;
    }
  };
  const onExpand = async (hi: number, h: Hunk) => {
    if (expansions.has(hi)) {
      setExpansions((old) => { const next = new Map(old); next.delete(hi); return next; });
      return;
    }
    const lines = await loadFull();
    if (!lines) return;
    const top = h.newStart - 1; // 0-based index of first hunk line in new file
    const prevEnd = hi > 0 ? hunks[hi - 1]!.newStart - 1 + hunks[hi - 1]!.newLines : 0;
    if (top <= prevEnd) return;
    const res = await expandToEnclosing(file.path, lines, top - 1, 400);
    const start = Math.max(prevEnd, Math.min(top - 1, res.start));
    const label = res.engine === "tree-sitter" ? `tree-sitter: ${res.label}` : res.engine === "heuristic" ? `heuristic fallback: ${res.label ?? "block"}` : "bounded lines (no semantic boundary found)";
    setExpansions((old) => new Map(old).set(hi, { lines: lines.slice(start, top), startNo: start + 1, label }));
  };

  const saveAnnotation = (body: string) => {
    if (!selection || !composer) return;
    if (composer === "note") {
      const rows = allRows.map((line) => line.text);
      const n: PrivateNote = {
        id: newId("note"),
        prKey: pr.key,
        headSha: pr.headSha,
        anchor: { path: file.path, rows: selection, anchorText: rows.slice(selection[0], selection[1]), before: rows.slice(Math.max(0, selection[0] - 2), selection[0]), after: rows.slice(selection[1], selection[1] + 2) },
        body, orphaned: false, createdAt: Date.now(), updatedAt: Date.now(),
      };
      put("notes", n.id, n);
      void signalReviewStart(pr);
    } else {
      const commentLines = commentSide ? selectedLines.filter((l) => onDiffSide(l, commentSide)) : selectedLines;
      const last = commentLines.at(-1) ?? anchorLine;
      const first = commentLines[0];
      const side = commentSide ?? (last?.kind === "del" ? "LEFT" : "RIGHT");
      const line = side === "LEFT" ? last?.oldNo : last?.newNo;
      const startLine = side === "LEFT" ? first?.oldNo : first?.newNo;
      if (line == null || (commentLines.length > 1 && (startLine == null || startLine >= line))) {
        toast("warn", "Select a continuous range on one side of the diff for a GitHub comment.");
        return;
      }
      const draft: DraftComment = { id: newId("draft"), prKey: pr.key, headSha: pr.headSha, path: file.path, line, side, startLine: first !== last ? startLine ?? undefined : undefined, body, createdAt: Date.now() };
      put("drafts", draft.id, draft);
      toast("info", "Draft saved. It will be posted when you submit your review.");
      void signalReviewStart(pr);
    }
    setComposer(null);
  };

  const annotations = new Map<number, React.ReactNode[]>();
  const annotate = (i: number, content: React.ReactNode) => {
    if (i < 0) return;
    const row = annotations.get(i) ?? [];
    row.push(content);
    annotations.set(i, row);
  };
  const lineIndex = (line: number, side: "LEFT" | "RIGHT") => allRows.findIndex((entry) => side === "LEFT" ? entry.oldNo === line : entry.newNo === line);
  if (showNotes) {
    for (const n of notes) if (n.anchor && !n.orphaned) {
      const [start, end] = n.anchor.rows;
      annotate(end - 1, annotation(n.id, `Private note · diff rows ${start + 1}–${end}`, n.body, undefined,
        <button type="button" className="btn ghost sm" onClick={() => useApp.getState().remove("notes", n.id)} aria-label="Delete private note" title="Delete private note"><NavIcon name="trash" /></button>));
    }
  }
  if (showComments) {
    for (const d of drafts) if (d.headSha === pr.headSha) {
      annotate(lineIndex(d.line, d.side), annotation(d.id, `Draft GitHub comment · ${d.startLine ? d.startLine + "–" : ""}${d.line}`, d.body, undefined,
        <button type="button" className="btn ghost sm" onClick={() => useApp.getState().remove("drafts", d.id)} aria-label="Discard draft comment"><NavIcon name="close" /></button>));
    }
    for (const c of comments) if (c.path === file.path && c.line != null) {
      annotate(lineIndex(c.line, c.side), annotation(`github:${c.id}`, `${c.user?.login ?? "GitHub"} · line ${c.start_line ? c.start_line + "–" : ""}${c.line}`, c.body, c.html_url));
    }
  }
  if (composer && selection) {
    annotate(selection[1] - 1, <Composer key={`${composer}:${selection.join("-")}`} kind={composer} onClose={() => setComposer(null)} onSave={saveAnnotation} />);
  }

  const openComposer = (kind: "note" | "comment") => {
    setComposer(kind);
  };

  const lineText = (l: DiffLine) => `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}${l.newNo ?? l.oldNo ?? ""}\t${l.text}`;
  const openAsk = (range: Interval | null) => {
    const iv = range ?? (hunks.length ? hunkRange(curHunk()) : null);
    if (!iv) return;
    const pick = range ? selectedLines : allRows.slice(iv[0], iv[1]);
    const nums = pick.map((l) => l.newNo ?? l.oldNo).filter((n): n is number => n != null);
    onAsk({
      repoKey: `${pr.owner}/${pr.repo}`.toLowerCase(),
      prKey: pr.key,
      prTitle: pr.title,
      prUrl: pr.url,
      path: file.path,
      label: nums.length ? (nums[0] === nums.at(-1) ? `line ${nums[0]}` : `lines ${nums[0]}–${nums.at(-1)}`) : `rows ${iv[0] + 1}–${iv[1]}`,
      selected: pick.map(lineText).join("\n"),
      context: allRows.slice(Math.max(0, iv[0] - 40), iv[1] + 40).map(lineText).join("\n"),
    });
  };

  const symbolActions = menu?.word ? [
    { label: `Go to definition of ${menu.word.name}`, run: () => onSymbol(menu.word!.name, menu.word!.origin, "definition") },
    { label: `Find references to ${menu.word.name}`, run: () => onSymbol(menu.word!.name, menu.word!.origin, "references") },
  ] : [];
  const actions = selection ? [
    { label: "Mark reviewed", run: () => changeSelection(markReviewed) },
    { label: "Needs revisit", run: () => changeSelection(flagRange) },
    { label: "Clear flag", run: () => changeSelection(unflagRange) },
    { label: "Private note", run: () => openComposer("note") },
    { label: "GitHub comment", run: () => openComposer("comment") },
    { label: "✦ Ask AI about this", run: () => openAsk(selection) },
  ] : [];

  return (
    <div className="col" style={{ height: "100%", gap: 0 }}>
      <div className="toolbar">
        <span className="mono ellipsis" style={{ maxWidth: 420 }} title={file.path}>
          {file.kind === "renamed" ? `${file.oldPath} → ` : ""}
          {file.path}
        </span>
        <span className="chip">{file.kind}</span>
        <DiffStat additions={file.additions} deletions={file.deletions} />
        <span className={`chip ${st === "complete" ? "ok" : st === "needs-rereview" ? "err" : st === "incomplete" ? "warn" : ""}`}>
          {STATUS_ICON[st]} {st}
        </span>
        <div className="hbar" style={{ width: 120 }} title={`${Math.round(progress(state) * 100)}% reviewed`}>
          <span style={{ left: 0, width: `${progress(state) * 100}%`, background: "var(--ok)" }} />
        </div>
        <span className="spacer" />
        <DiffCodeLayoutSelect layout={layout} onChange={setLayout} />
        <select className="input" value={mode} onChange={(e) => setMode(e.target.value as DiffMode)} aria-label="Diff mode">
          <option value="unified">Unified</option>
          <option value="split">Side-by-side</option>
        </select>
        <button className={`btn sm ${reviewed ? "primary" : ""}`} aria-pressed={reviewed} onClick={() => save(reviewed ? resetFile(state) : markAllReviewed(state))} title={reviewed ? "Reset file review" : "Mark the whole file reviewed"}>
          {reviewed ? "✓ Reviewed" : "Mark file reviewed"}
        </button>
        <button className="btn sm" onClick={() => save({ ...state, postponed: !state.postponed, updatedAt: Date.now() })}>
          {state.postponed ? "▶ Unpostpone" : "⏸ Come back later"}
        </button>
        <label className="small row"><input type="checkbox" checked={showNotes} onChange={(e) => { setShowNotes(e.target.checked); localStorage.setItem("nl:inline-notes", String(e.target.checked)); }} /> Inline notes</label>
        <label className="small row"><input type="checkbox" checked={showComments} onChange={(e) => { setShowComments(e.target.checked); localStorage.setItem("nl:inline-comments", String(e.target.checked)); }} /> Inline comments</label>
        <button className="btn sm" aria-pressed={showRail} onClick={() => { setShowRail(!showRail); localStorage.setItem("nl:review-notes-pane", String(!showRail)); }}>Notes pane</button>
        <button className="btn sm" data-keep-selection onClick={() => openAsk(selection)} title={selection ? "Ask an AI model about the selected lines" : "Ask an AI model about the current hunk (select lines first to narrow it)"}>
          ✦ Ask AI
        </button>
        <button className="btn sm" onClick={() => setInspector(true)}>
          ⛶ Inspect
        </button>
        <button className="btn sm" onClick={() => setImpact(true)} title="Impact graph (g)">
          ⑃ Impact
        </button>
        {file.gitlink && (
          <button className="btn sm primary" onClick={() => setSub((s) => !s)}>
            {sub ? "Collapse submodule" : "Expand submodule change"}
          </button>
        )}
      </div>
      <FileSummary pr={pr} file={file} section={section} />
      {find.open && (
        <div className="find-bar" role="search" aria-label="Find in code">
          <NavIcon name="search" />
          <input ref={findInput} className={`input grow mono ${find.query && !findRes.total && !findRes.error && !allMatches ? "no-match" : ""}`} aria-label="Find in code" placeholder={find.scope === "all" ? "Find in all changed files" : "Find in this file"}
            value={find.query} spellCheck={false}
            onChange={(e) => setFind((f) => ({ ...f, query: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); findStep(e.shiftKey ? -1 : 1); }
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setFind((f) => ({ ...f, open: false })); codeFocused.current = true; }
            }} />
          <span className="find-count-label small" aria-live="polite">
            {findRes.error ? <span className="err-text" title={findRes.error}>invalid regex</span>
              : !find.query ? "" : findRes.total ? `${findCur + 1} of ${findRes.total.toLocaleString()}${findRes.capped ? "+" : ""}${allMatches ? ` · ${allMatches.toLocaleString()} in all files` : ""}`
              : allMatches ? `0 here · ${allMatches.toLocaleString()} in other files` : "No results"}
          </span>
          <button type="button" className={`btn sm find-opt ${find.caseSensitive ? "on" : ""}`} aria-pressed={find.caseSensitive} title="Match case" aria-label="Match case" onClick={() => setFind((f) => ({ ...f, caseSensitive: !f.caseSensitive }))}>Aa</button>
          <button type="button" className={`btn sm find-opt ${find.wholeWord ? "on" : ""}`} aria-pressed={find.wholeWord} title="Whole word" aria-label="Whole word" onClick={() => setFind((f) => ({ ...f, wholeWord: !f.wholeWord }))}><u>ab</u></button>
          <button type="button" className={`btn sm find-opt ${find.regex ? "on" : ""}`} aria-pressed={find.regex} title="Regular expression" aria-label="Regular expression" onClick={() => setFind((f) => ({ ...f, regex: !f.regex }))}>.*</button>
          <select className="input" aria-label="Search scope" value={find.scope} onChange={(e) => setFind((f) => ({ ...f, scope: e.target.value as FindState["scope"] }))}>
            <option value="file">This file</option>
            <option value="all">All changed files</option>
          </select>
          <button type="button" className="btn sm" onClick={() => findStep(-1)} title="Previous match (⇧↵)" aria-label="Previous match">↑</button>
          <button type="button" className="btn sm" onClick={() => findStep(1)} title="Next match (↵)" aria-label="Next match">↓</button>
          <button type="button" className="btn ghost sm" onClick={() => setFind((f) => ({ ...f, open: false }))} aria-label="Close find" title="Close (Esc)"><NavIcon name="close" /></button>
        </div>
      )}
      <div className="selection-slot">
      {selection && (
        <div className="toolbar small selection-bar">
          <span>
            Rows {selection[0] + 1}–{selection[1]} selected{commentSide && <span className="faint" title="Review marks, notes and copying cover both sides; a GitHub comment goes on the side you clicked."> · comments on the {commentSide === "LEFT" ? "old (left)" : "new (right)"} side</span>}
          </span>
          <button className="btn sm" onClick={() => changeSelection(markReviewed)}>
            r Mark reviewed
          </button>
          <button className="btn sm" onClick={() => changeSelection(flagRange)}>
            x Needs revisit
          </button>
          <button className="btn sm" onClick={() => changeSelection(unflagRange)}>
            Clear flag
          </button>
          <button className="btn sm" onClick={() => openComposer("note")}>
            ✎ Private note
          </button>
          <button className="btn sm" onClick={() => openComposer("comment")}>
            c GitHub comment
          </button>
          <button className="btn sm" onClick={() => openAsk(selection)}>
            ✦ Ask AI
          </button>
          <button type="button" className="btn sm" onClick={() => void copyGitHubLink()} disabled={!fileHash || !firstLine}
            title="Copy a direct link to these lines on GitHub"><NavIcon name="copy" /> Copy GitHub link</button>
          <button className="btn ghost sm" onClick={() => setSelection(null)}>
            ✕
          </button>
        </div>
      )}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Split id="review-notes" initial={0.74} min={0.18} showSecond={showRail}>
        <div ref={codeArea} className={`grow review-code-area ${modHeld ? "mod-held" : ""}`} style={{ height: "100%", minWidth: 0, padding: 4 }}>
          {sub ? (
            <SubmoduleExpansion pr={pr} file={file} section={section} mode={mode} layout={layout} />
          ) : (
            <FileDiff
              key={mode}
              path={file.path}
              section={section}
              mode={mode}
              layout={layout}
              expansions={expansions}
              onExpand={(hi, h) => void onExpand(hi, h)}
              review={{ state, setFrontier: (row) => save(setFrontier(fileState(useApp.getState().reviews[pr.key], file, section), row)) }}
              selection={selection}
              selectionSide={selectionSide}
              onSelect={(iv, a) => {
                setSelectedSide(a.side);
                setSelection(wholeRows(iv));
                setComposer(null);
                setMenu(null);
                setAnchorLine(a.line);
              }}
              annotations={annotations}
              onLineContext={(e, i, line, side) => {
                e.preventDefault();
                if (!selection || i < selection[0] || i >= selection[1] || (selectionSide && side !== selectionSide)) {
                  setSelectedSide(side);
                  setSelection(wholeRows([i, i + 1]));
                  setComposer(null);
                }
                setAnchorLine(line);
                const word = wordFromEvent(e, line) ?? undefined;
                setMenu({ x: Math.max(0, Math.min(e.clientX, window.innerWidth - 260)), y: Math.max(0, Math.min(e.clientY, window.innerHeight - (word ? 290 : 210))), word });
              }}
              scrollToRow={scrollTo}
              scrollKey={`nl:review-scroll:${pr.key}:${diff.baseSha}:${diff.headSha}:${mode}:${file.path}`}
              find={find.open && findRes.rows.length ? { byRow: findByRow, current: findCur >= 0 ? { ri: findRes.rows[findCur]!, col: findRes.cols[findCur]! } : null } : null}
              reveal={localReveal}
              onCodeClick={(e, _ri, line) => {
                if (!(e.metaKey || e.ctrlKey) || window.getSelection()?.toString()) return;
                const word = wordFromEvent(e, line);
                if (!word) return;
                e.preventDefault();
                e.stopPropagation();
                onSymbol(word.name, word.origin, "definition");
              }}
            />
          )}
        </div>
        <NotesRail pr={pr} file={file} notes={notes} drafts={drafts} />
        </Split>
      </div>
      {menu && <div className="panel review-context-menu" style={{ left: menu.x, top: menu.y }} role="group" aria-label="Diff line actions">
        {symbolActions.map((action) => <button key={action.label} className="btn ghost ellipsis" onClick={() => { action.run(); setMenu(null); }}>{action.label}</button>)}
        {symbolActions.length > 0 && actions.length > 0 && <div className="menu-sep" role="separator" />}
        {actions.map((action) => <button key={action.label} className="btn ghost" onClick={() => { action.run(); setMenu(null); }}>{action.label}</button>)}
      </div>}
      {inspector && <FileInspector pr={pr} diff={diff} file={file} onClose={() => setInspector(false)} />}
      {impact && <ImpactGraph pr={pr} diff={diff} file={file} section={section} onClose={() => setImpact(false)} />}
    </div>
  );
}

function FileSummary({ pr, file, section }: { pr: PRSnapshot; file: DiffFileEntry; section: string }) {
  const settings = useSettings();
  useApp((s) => s.summaries);
  const [busy, setBusy] = useState(false);
  const toast = useApp((s) => s.toast);
  const repoKey = `${pr.owner}/${pr.repo}`.toLowerCase();
  const allowed = aiAllowedFor(repoKey, file.path);
  const hash = diffHash([section]);
  const s = latestSummary(pr.key, file.path);
  const fr = freshness(s, hash);
  if (!allowed.ok && !s) return null;
  return (
    <div className="toolbar small" style={{ alignItems: "flex-start" }}>
      <div className="grow">
        {s ? <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(s.text) }} /> : <span className="faint">No file summary.</span>}
        {s && <div className="faint">{s.modelId} · {fr} · AI output is not a review.</div>}
      </div>
      <button
        className="btn sm"
        disabled={busy || !allowed.ok}
        title={allowed.reason}
        onClick={async () => {
          setBusy(true);
          try {
            const p = buildFilePrompt(file.path, section, 30_000, pr.url);
            await summarize({ prKey: pr.key, repo: repoKey, pr: pr.number, baseSha: pr.baseSha, headSha: pr.headSha, diffHash: hash, file: file.path, modelId: settings.models.find((m) => m.tier === "cheap" && m.provider === settings.models.find((x) => x.id === settings.defaultModel)?.provider)?.id ?? settings.defaultModel, system: p.system, user: p.user, maxOut: 400 });
          } catch (e) {
            toast("error", (e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "…" : "Summarize this file"}
      </button>
    </div>
  );
}

function NotesRail({ pr, file, notes, drafts }: { pr: PRSnapshot; file: DiffFileEntry; notes: PrivateNote[]; drafts: DraftComment[] }) {
  const remove = useApp((s) => s.remove);
  const orphaned = useApp(useShallow((s) => Object.values(s.notes).filter((n) => n.prKey === pr.key && n.orphaned)));

  return (
    <aside className="review-notes-rail" aria-label="Notes and drafts">
      {!notes.length && !drafts.length && !orphaned.length && <div className="empty small">No notes or drafts for this file.</div>}
      {notes.length > 0 && <h3 className="h3">Private notes</h3>}
      {notes.map((n) => (
        <div key={n.id} className="panel pad small" style={{ marginBottom: 6 }}>
          <div className="faint">rows {n.anchor!.rows[0] + 1}–{n.anchor!.rows[1]}</div>
          <div>{n.body}</div>
          <button type="button" className="btn ghost sm" aria-label="Delete private note" title="Delete private note"
            onClick={() => remove("notes", n.id)}><NavIcon name="trash" /></button>
        </div>
      ))}
      {drafts.length > 0 && <h3 className="h3">Draft GitHub comments</h3>}
      {drafts.map((d) => (
        <div key={d.id} className="panel pad small" style={{ marginBottom: 6 }}>
          <div className="faint">
            {d.side} line {d.startLine ? `${d.startLine}–` : ""}
            {d.line} {d.headSha !== pr.headSha && <span className="chip warn">obsolete revision</span>}
          </div>
          <div>{d.body}</div>
          <button className="btn ghost sm" onClick={() => remove("drafts", d.id)}>
            discard
          </button>
        </div>
      ))}
      {orphaned.length > 0 && <h3 className="h3">Orphaned notes</h3>}
      {orphaned.map((n) => (
        <div key={n.id} className="panel pad small" style={{ marginBottom: 6, borderColor: "var(--warn)" }}>
          <div className="faint">was {n.anchor?.path}</div>
          <div>{n.body}</div>
          <div className="faint">Code changed; relocate manually by creating a new note.</div>
        </div>
      ))}
      <div className="faint small">{file.path}</div>
    </aside>
  );
}

function Composer({ kind, onClose, onSave }: { kind: "note" | "comment"; onClose: () => void; onSave: (body: string) => void }) {
  const [body, setBody] = useState("");
  const label = kind === "note" ? "Private note" : "Draft GitHub comment";
  return <form className="panel inline-annotation col" onSubmit={(e) => { e.preventDefault(); if (body.trim()) onSave(body); }}>
    <textarea aria-label={label} placeholder={label} autoFocus className="input" value={body} onChange={(e) => setBody(e.target.value)} />
    <div className="row">
      <button className="btn primary sm" disabled={!body.trim()}>{kind === "note" ? "Save note" : "Save draft"}</button>
      <button type="button" className="btn sm" onClick={onClose}>Cancel</button>
    </div>
  </form>;
}

/* ---------------- Submodule expansion (§5.1) ---------------- */

function SubmoduleExpansion({ pr, file, section, mode, layout }: { pr: PRSnapshot; file: DiffFileEntry; section: string; mode: DiffMode; layout: DiffCodeLayout }) {
  const { oldSha, newSha } = gitlinkShas(section);
  const [state, setState] = useState<{ child?: { owner: string; repo: string }; text?: string; err?: string; status?: string; speculative?: string }>({});
  const [sel, setSel] = useState(0);
  const prs = useApp((s) => s.prs);
  useEffect(() => {
    (async () => {
      try {
        const r = parsePRKey(pr.key)!;
        const c = await githubApi();
        const gm = await c.contents(r.owner, r.repo, ".gitmodules", pr.headSha);
        const entry = parseGitmodules(gm ?? "", { owner: r.owner, repo: r.repo }).find((e) => e.path === file.path);
        if (!entry?.github) throw new Error(`Cannot resolve ${file.path} in .gitmodules at ${pr.headSha.slice(0, 8)}`);
        if (!oldSha || !newSha) throw new Error("Not a gitlink update (added/removed submodule).");
        const { owner, repo } = entry.github;
        const cmp = await c.compareStatus(owner, repo, oldSha, newSha);
        const text = await c.compareDiff(owner, repo, oldSha, newSha);
        // Is newSha the head of an open upstream PR? Then it's provisional (§5.1 speculative).
        const upstream = Object.values(prs).find((p) => p.owner.toLowerCase() === owner.toLowerCase() && p.repo.toLowerCase() === repo.toLowerCase() && p.headSha.startsWith(newSha) && p.state === "open");
        setState({ child: entry.github, text, status: `${cmp.status} (ahead ${cmp.ahead_by}, behind ${cmp.behind_by}); merge-base ${cmp.merge_base_sha?.slice(0, 8) ?? "?"}`, speculative: upstream?.key });
      } catch (e) {
        setState({ err: describeError(e) });
      }
    })();
  }, [pr.key, pr.headSha, file.path]);
  const ix = useMemo(() => (state.text ? indexPatch(state.text) : null), [state.text]);
  const upstreamMerged = useMemo(() => {
    if (!state.child || !newSha) return null;
    return Object.values(prs).find((p) => p.owner.toLowerCase() === state.child!.owner.toLowerCase() && p.repo.toLowerCase() === state.child!.repo.toLowerCase() && p.headSha.startsWith(newSha) && p.state === "merged") ?? null;
  }, [prs, state.child, newSha]);
  if (state.err) return <div className="banner err">{state.err}</div>;
  if (!ix) return <div className="empty">Loading submodule comparison…</div>;
  const f = ix.files[sel];
  return (
    <div className="col" style={{ height: "100%", gap: 4 }}>
      <div className="banner info small">
        Nested diff of <b>{state.child!.owner}/{state.child!.repo}</b> <span className="mono">{oldSha?.slice(0, 8)}…{newSha?.slice(0, 8)}</span> — mode: three-dot merge-base comparison. Relationship: {state.status}.
        {state.speculative && <> Pinned revision is the head of open upstream PR <b>{state.speculative}</b> — this pin is <b>provisional</b>.</>}
      </div>
      {upstreamMerged && <GitlinkReconcile pr={pr} path={file.path} provisional={newSha!} oldSha={oldSha} upstream={upstreamMerged} />}
      <div className="row" style={{ flex: 1, minHeight: 0, alignItems: "stretch" }}>
        <div style={{ width: 240, overflow: "auto", borderRight: "1px solid var(--border)" }}>
          {ix.files.map((x, i) => (
            <div key={x.path} className={`tree-row ${i === sel ? "active" : ""}`} onClick={() => setSel(i)}>
              <span className="ellipsis grow">{x.path}</span>
              <span className="faint small">+{x.additions}</span>
            </div>
          ))}
        </div>
        <div className="grow" style={{ minWidth: 0 }}>{f && <FileDiff key={f.path} path={f.path} section={state.text!.slice(f.start, f.end)} mode={mode} layout={layout} />}</div>
      </div>
    </div>
  );
}

/* ---------------- Impact graph (§5.4) ---------------- */

function ImpactGraph({ pr, diff, file, section, onClose }: { pr: PRSnapshot; diff: LoadedDiff; file: DiffFileEntry; section: string; onClose: () => void }) {
  const symbols = useMemo(() => {
    const out = new Set<string>();
    for (const h of parseFileHunks(section)) {
      const m = /\b(?:def|class|object|trait|fn|function|val|var|struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(h.section);
      if (m) out.add(m[1]!);
      for (const l of h.lines) {
        if (l.kind === "context" || l.kind === "meta") continue;
        const d = /\b(?:def|class|object|trait|fn|function|struct|enum|case class)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(l.text);
        if (d) out.add(d[1]!);
      }
    }
    return [...out];
  }, [section]);
  const refs = useMemo(() => {
    const m = new Map<string, { path: string; count: number }[]>();
    for (const s of symbols.slice(0, 30)) {
      const re = new RegExp(`\\b${s}\\b`);
      const hits: { path: string; count: number }[] = [];
      for (const f of diff.index.files.slice(0, 120)) {
        if (f.path === file.path) continue;
        const txt = diff.text.slice(f.start, f.end);
        const count = txt.split("\n").filter((l) => re.test(l)).length;
        if (count) hits.push({ path: f.path, count });
      }
      m.set(s, hits);
    }
    return m;
  }, [symbols, diff, file.path]);
  const [indexed, setIndexed] = useState<ImpactEdge[] | null>(null);
  const [graphMessage, setGraphMessage] = useState<string | null>(null);
  const repoKey = `${pr.owner}/${pr.repo}`.toLowerCase();
  const lspAvail = lspAvailable(repoKey, file.path);
  const [confirmed, setConfirmed] = useState<Record<string, { server: string; locations: LspLocation[]; error?: string }>>({});
  useEffect(() => {
    const path = workingTreeFor(repoKey);
    if (!isDesktop() || !path || !symbols.length) return;
    let cancelled = false;
    void (async () => {
      if (!await headMatches(repoKey, pr.headSha)) {
        if (!cancelled) setGraphMessage("The local checkout is on a different revision from this PR.");
        return;
      }
      const edges: ImpactEdge[] = [];
      let indexedQueries = 0;
      for (const symbol of symbols.slice(0, 5)) {
        if (cancelled) return;
        for (const direction of ["callees", "impact"] as const) {
          const result = await invoke<CodeGraphResult>("codegraph_lineage", { repoPath: path, direction, symbol, file: file.path }).catch(() => null);
          if (!result || result.filteredOut || result.changedOnDisk?.length) continue;
          const definitions = result.definitions?.filter((entry) => entry.definition.filePath === file.path);
          if (!definitions?.length) continue;
          indexedQueries++;
          for (const entry of definitions) {
            const nodes = new Map((entry.affected ?? entry.callees ?? []).map((node) => [node.id, node.filePath]));
            for (const root of entry.roots ?? [entry.definition.id]) nodes.set(root, file.path);
            for (const relation of entry.edges ?? []) {
              const from = nodes.get(relation.source);
              const to = nodes.get(relation.target);
              if (from && to && from !== to) edges.push({ from: to, to: from });
            }
          }
        }
      }
      if (cancelled) return;
      if (indexedQueries) setIndexed(edges);
      else setGraphMessage("No CodeGraph index results for the changed symbols on this revision.");
    })().catch((error) => { if (!cancelled) setGraphMessage(String(error)); });
    return () => { cancelled = true; };
  }, [repoKey, pr.headSha, file.path, symbols]);
  const confirmRefs = async (sym: string) => {
    try {
      // Exact PR head revision (worktree from the mirror cache or mapped working tree).
      const root = await exactRoot(repoKey, pr.headSha);
      const text = await desktop.gitShow(root, "HEAD", file.path);
      const lines = text.split("\n");
      const re = new RegExp(`\\b(?:def|class|object|trait|fn|function|struct|enum|module|val|var|int|void|auto)\\b[^\\n]*?\\b(${sym})\\b`);
      const line = lines.findIndex((l) => re.test(l));
      if (line < 0) throw new Error(`Declaration of ${sym} not found in the working tree copy of ${file.path}`);
      const character = lines[line]!.search(new RegExp(`\\b${sym}\\b`));
      const r = await lspLocations(repoKey, file.path, "references", line, character, pr.headSha);
      setConfirmed((c) => ({ ...c, [sym]: r }));
    } catch (e) {
      setConfirmed((c) => ({ ...c, [sym]: { server: lspAvail.ok ? lspAvail.server.name : "", locations: [], error: (e as Error).message } }));
    }
  };
  const inferred = useMemo<ImpactEdge[]>(() => {
    const changes = diff.index.files.slice(0, 120).map((changed) => {
      const text = fileSectionOf(diff, changed).slice(0, 100_000);
      return { path: changed.path, text, symbols: new Set([...text.matchAll(/\b(?:def|class|object|trait|fn|function|struct|enum|interface|module)\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]!)) };
    });
    const edges: ImpactEdge[] = [];
    for (const definition of changes) {
      for (const symbol of definition.symbols) {
        const word = new RegExp(`\\b${symbol}\\b`);
        for (const consumer of changes) {
          if (consumer.path !== definition.path && !consumer.symbols.has(symbol) && word.test(consumer.text)) {
            edges.push({ from: definition.path, to: consumer.path });
          }
        }
      }
    }
    for (const [symbol, uses] of refs) {
      if (symbols.includes(symbol)) for (const use of uses) edges.push({ from: file.path, to: use.path });
    }
    return edges;
  }, [diff, file.path, refs, symbols]);

  const confirmedEdges = Object.values(confirmed).flatMap((entry) => entry.locations
    .filter((location) => location.path !== file.path && !location.path.startsWith("file:"))
    .map((location) => ({ from: file.path, to: location.path })));

  return (
    <Modal title={`Impact — ${file.path}`} onClose={onClose} wide>
      <div className="col small">
        <div className="banner info">
          {indexed ? "CodeGraph index for the PR revision" : "Relationships inferred from symbols in the changed files"}
          {confirmedEdges.length > 0 && " · includes language-server references"}
        </div>
        <ImpactDiagram file={file.path} edges={[...(indexed ?? inferred), ...confirmedEdges]} />
        {graphMessage && <p className="faint small">{graphMessage}</p>}
        <details><summary>Symbol evidence</summary>
        {symbols.length === 0 && <div className="faint">No changed declarations detected.</div>}
        {symbols.map((s) => (
          <div key={s} className="panel pad">
            <div className="row">
              <b className="mono">{s}</b>
              <span className="spacer" />
              {lspAvail.ok && (
                <button className="btn sm" onClick={() => void confirmRefs(s)}>
                  Confirm with {lspAvail.server.name}
                </button>
              )}
            </div>
            {confirmed[s] && (
              <div>
                <span className="chip ok">confirmed · {confirmed[s]!.server}</span> {confirmed[s]!.locations.length} reference(s)
                {confirmed[s]!.locations.slice(0, 30).map((l, i) => (
                  <div key={i} className="mono">↳ {l.path}:{l.line + 1}</div>
                ))}
                {confirmed[s]!.error && <div className="banner warn">{confirmed[s]!.error}</div>}
              </div>
            )}
            {(refs.get(s) ?? []).map((h) => (
              <div key={h.path} className="mono">
                ↳ {h.path} <span className="faint">({h.count} lines, inferred)</span>
              </div>
            ))}
            {!(refs.get(s) ?? []).length && <div className="faint">No references in other changed files.</div>}
          </div>
        ))}
        </details>
        <div className="faint">Index key: {pr.key}@{pr.headSha.slice(0, 8)} · heuristic-v1</div>
      </div>
    </Modal>
  );
}

/* ---------------- Gitlink reconciliation after upstream merge (§2.4) ---------------- */

function GitlinkReconcile({ pr, path, provisional, oldSha, upstream }: { pr: PRSnapshot; path: string; provisional: string; oldSha: string | null; upstream: PRSnapshot }) {
  const [p, setP] = useState<GitlinkProposal | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const put = useApp((s) => s.put);
  const toast = useApp((s) => s.toast);
  useEffect(() => {
    (async () => {
      try {
        const c = await githubApi();
        const [raw, prCommits] = await Promise.all([c.getPull(upstream.owner, upstream.repo, upstream.number), c.listPullCommits(upstream.owner, upstream.repo, upstream.number)]);
        const base = await c.request<RawCommit[]>("GET", `/repos/${upstream.owner}/${upstream.repo}/commits?sha=${encodeURIComponent(raw.base.ref)}&per_page=50`);
        const trees = new Map<string, string>();
        for (const x of [...base, ...prCommits]) trees.set(x.sha, (x.commit as unknown as { tree?: { sha: string } }).tree?.sha ?? "");
        setP(
          proposeGitlink(provisional, {
            prCommits: prCommits.map(toCommitNode),
            headSha: raw.head.sha,
            mergeCommitSha: raw.merge_commit_sha ?? null,
            baseAfterMerge: base.map(toCommitNode),
            treeOf: (s) => trees.get(s) || undefined,
            baseBranch: raw.base.ref,
          }),
        );
      } catch (e) {
        setErr(describeError(e));
      }
    })();
  }, [upstream.key, provisional]);
  if (err) return <div className="banner err small">{err}</div>;
  if (!p) return <div className="faint small">Upstream {upstream.key} merged — computing gitlink proposal…</div>;
  const patch = p.proposedSha && oldSha ? gitlinkPatch([{ parentRepo: `${pr.owner}/${pr.repo}`, path, oldSha: provisional, newSha: p.proposedSha, childRepo: null, checks: { fetchable: "unknown", ancestorOfTarget: "unknown" } }]) : "";
  return (
    <div className="panel pad small col" style={{ gap: 4, borderColor: "var(--warn)" }}>
      <div className="row">
        <b>Upstream {upstream.key} merged ({p.method})</b>
        <span className={`chip ${p.confidence === "verified" ? "ok" : p.confidence === "probable" ? "warn" : "err"}`}>{p.confidence}</span>
        <span className="spacer" />
        {p.proposedSha && (
          <>
            <button className="btn sm" onClick={() => download(`${path.replace(/\//g, "_")}-gitlink.patch`, patch)}>
              Download patch
            </button>
            <button
              className="btn sm"
              onClick={() => {
                const d: DraftComment = { id: newId("draft"), prKey: pr.key, headSha: pr.headSha, path, line: 1, side: "RIGHT", body: `Upstream ${upstream.key} has merged (${p.method}). Please update the gitlink:\n\n\`\`\`suggestion\nSubproject commit ${p.proposedSha}\n\`\`\`\n\nThen re-run CI; review freshness will be recalculated.`, createdAt: Date.now() };
                put("drafts", d.id, d);
                toast("info", "Draft review comment added; submit it with your review.");
              }}
            >
              Draft review comment
            </button>
          </>
        )}
      </div>
      <div>
        Provisional <span className="mono">{provisional.slice(0, 10)}</span> → proposed <span className="mono">{p.proposedSha?.slice(0, 10) ?? "unresolved"}</span>
      </div>
      {p.evidence.map((x, i) => (
        <div key={i} style={{ color: "var(--ok)" }}>✓ {x}</div>
      ))}
      {p.warnings.map((x, i) => (
        <div key={i} style={{ color: "var(--warn)" }}>⚠ {x}</div>
      ))}
      <div className="faint">Nothing is pushed automatically. Merge of the upstream PR alone does not prove the downstream gitlink is correct.</div>
    </div>
  );
}


type ImpactEdge = { from: string; to: string };

type CodeGraphNode = { id: string; filePath: string };
type CodeGraphResult = {
  filteredOut?: boolean;
  changedOnDisk?: string[];
  definitions?: {
    definition: CodeGraphNode;
    roots?: string[];
    affected?: CodeGraphNode[];
    callees?: CodeGraphNode[];
    edges?: { source: string; target: string }[];
  }[];
};

function ImpactDiagram({ file, edges }: { file: string; edges: ImpactEdge[] }) {
  const [hover, setHover] = useState<string | null>(null);
  const unique = [...new Map(edges.map((edge) => [JSON.stringify([edge.from, edge.to]), edge])).values()];
  const lineage = (from: "from" | "to", to: "from" | "to") => {
    const seen = new Set([file]);
    const paths = [file];
    for (let i = 0; i < paths.length && seen.size < 13; i++) {
      for (const edge of unique) {
        if (edge[from] !== paths[i] || seen.has(edge[to])) continue;
        seen.add(edge[to]);
        paths.push(edge[to]);
        if (seen.size >= 13) break;
      }
    }
    return paths.slice(1);
  };
  const ancestors = lineage("to", "from");
  const descendants = lineage("from", "to").filter((path) => !ancestors.includes(path));
  const related = new Set([...ancestors, file, ...descendants]);
  const context = [...new Set(unique.flatMap(({ from, to }) => [from, to]))].filter((path) => !related.has(path)).slice(0, 4);
  const columns = [
    { title: "Dependencies", paths: ancestors },
    { title: "Current file", paths: [file, ...context] },
    { title: "Dependents", paths: descendants },
  ];
  const points = new Map<string, { x: number; y: number }>();
  const boxWidth = 230;
  const rowHeight = 30;
  const height = 50 + Math.max(...columns.map(({ paths }) => paths.length), 1) * rowHeight;
  columns.forEach(({ paths }, column) => paths.forEach((path, row) => points.set(path, { x: 10 + column * 308, y: 42 + row * rowHeight })));
  return <div className="impact-diagram" role="group" aria-label="File dependency graph">
    <svg viewBox={`0 0 866 ${height}`} width="866" height={height} aria-label={`Dependencies and dependents of ${file}`}>
      <defs><marker id="impact-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L8 4 L0 8 Z" fill="context-stroke" /></marker></defs>
      {columns.map(({ title, paths }, i) => <text key={title} x={10 + i * 308} y={24} className="impact-heading">{title}{i !== 1 ? ` (${paths.length})` : ""}</text>)}
      {unique.map(({ from, to }) => {
        const start = points.get(from);
        const end = points.get(to);
        if (!start || !end) return null;
        const highlighted = hover ? from === hover || to === hover : related.has(from) && related.has(to);
        const backwards = start.x > end.x;
        const x1 = start.x + (backwards ? 0 : boxWidth);
        const x2 = end.x + (backwards ? boxWidth : 0);
        const mid = start.x === end.x ? start.x + boxWidth + 35 : (x1 + x2) / 2;
        const target = start.x === end.x ? end.x + boxWidth : x2;
        return <path key={JSON.stringify([from, to])} className={`impact-edge ${highlighted ? "highlighted" : ""}`}
          d={`M ${x1} ${start.y} C ${mid} ${start.y}, ${mid} ${end.y}, ${target} ${end.y}`} markerEnd="url(#impact-arrow)" />;
      })}
      {[...points].map(([path, pos]) => <g key={path} className={`impact-node ${path === file ? "current" : ""} ${related.has(path) ? "" : "unrelated"}`}
        tabIndex={0} onMouseEnter={() => setHover(path)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(path)} onBlur={() => setHover(null)}>
        <title>{path}</title>
        <rect x={pos.x} y={pos.y - 11} width={boxWidth} height={22} rx={5} />
        <text x={pos.x + 8} y={pos.y + 4}>{path.length > 30 ? "…" + path.slice(-29) : path}</text>
      </g>)}
    </svg>
    {ancestors.length === 0 && descendants.length === 0 && <p className="faint small">No connected files found in the available graph.</p>}
  </div>;
}
