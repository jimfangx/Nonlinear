import { useShallow } from "zustand/react/shallow";
import { useEffect, useMemo, useState } from "react";
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
} from "@nonlinear/core";
import { useApp, useSettings, type DraftComment } from "../lib/store";
import { fileSectionOf, fileState, saveFileState, gitlinkShas, type LoadedDiff } from "../lib/review";
import { githubApi, describeError } from "../lib/github";
import { aiAllowedFor, latestSummary, summarize } from "../lib/ai";
import { renderMarkdown } from "../lib/markdown";
import { isDesktop, desktop, invoke } from "../lib/platform";
import { exactRoot, headMatches, lspAvailable, lspLocations, workingTreeFor, type LspLocation } from "../lib/lsp";
import { useActions } from "../lib/keys";
import { expandToEnclosing } from "../lib/treesitter";
import { FileDiff, hunkStarts, type DiffMode } from "../components/FileDiff";
import { Split, Modal, download } from "../components/ui";
import { FileInspector } from "./FileInspector";

const STATUS_ICON: Record<string, string> = { complete: "✓", incomplete: "◐", "not-started": "○", postponed: "⏸", "needs-rereview": "⟳" };

export function ReviewFiles({ pr, diff, refreshComments }: { pr: PRSnapshot; diff: LoadedDiff; refreshComments: number }) {
  const [comments, setComments] = useState<RawReviewComment[]>([]);
  useEffect(() => {
    let active = true;
    void githubApi().then((api) => api.listReviewComments(pr.owner, pr.repo, pr.number)).then((items) => {
      if (active) setComments(items);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [pr.key, pr.headSha, refreshComments]);
  const reviews = useApp((s) => s.reviews[pr.key]);
  const [sel, setSel] = useState(0);
  const [filter, setFilter] = useState("");
  const [mode, setMode] = useState<DiffMode>(() => (localStorage.getItem("nl:diffmode") as DiffMode) ?? "unified");
  const files = diff.index.files;
  const visible = useMemo(() => files.map((f, i) => ({ f, i })).filter(({ f }) => !filter || f.path.toLowerCase().includes(filter.toLowerCase())), [files, filter]);
  const f = files[sel];

  useActions(
    {
      next: () => setSel((s) => Math.min(files.length - 1, s + 1)),
      prev: () => setSel((s) => Math.max(0, s - 1)),
    },
    [files.length],
  );

  return (
    <Split id="review-files" initial={0.22}>
      <div className="col" style={{ height: "100%", gap: 0 }}>
        <div className="toolbar">
          <input className="input grow" placeholder="Filter files" aria-label="Filter files" value={filter}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== "Escape") return;
              e.preventDefault();
              e.stopPropagation();
              if (e.key === "Enter" && visible.length && !visible.some(({ i }) => i === sel)) setSel(visible[0]!.i);
              e.currentTarget.blur();
            }} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div style={{ overflow: "auto", flex: 1, padding: 4 }} role="tree">
          {visible.map(({ f: file, i }) => {
            const s = reviews?.files[file.path];
            const st = s ? fileStatus(s) : "not-started";
            const pct = s ? progress(s) : 0;
            return (
              <div key={file.path} role="treeitem" aria-selected={i === sel} className={`tree-row ${i === sel ? "active" : ""}`} onClick={() => setSel(i)} title={`${file.path} — ${st}`}>
                <span style={{ width: 14, color: st === "complete" ? "var(--ok)" : st === "needs-rereview" ? "var(--err)" : st === "incomplete" ? "var(--warn)" : "var(--text-3)" }} aria-label={st}>
                  {STATUS_ICON[st]}
                </span>
                <span className="grow ellipsis">
                  {file.path.split("/").pop()}
                  <span className="faint small"> {file.path.split("/").slice(0, -1).join("/")}</span>
                </span>
                {file.gitlink && <span className="chip info">sub</span>}
                <span className="faint small">{Math.round(pct * 100)}%</span>
              </div>
            );
          })}
        </div>
      </div>
      {f ? <FilePane key={`${f.path}:${pr.headSha}`} pr={pr} diff={diff} file={f} comments={comments} mode={mode} setMode={(m) => { setMode(m); localStorage.setItem("nl:diffmode", m); }} /> : <div className="empty">No files</div>}
    </Split>
  );
}

function FilePane({ pr, diff, file, comments, mode, setMode }: { pr: PRSnapshot; diff: LoadedDiff; file: DiffFileEntry; comments: RawReviewComment[]; mode: DiffMode; setMode: (m: DiffMode) => void }) {
  const section = useMemo(() => fileSectionOf(diff, file), [diff, file]);
  const hunks = useMemo(() => parseFileHunks(section), [section]);
  const progressRec = useApp((s) => s.reviews[pr.key]);
  const state = fileState(progressRec, file, section);
  const notes = useApp(useShallow((s) => Object.values(s.notes).filter((n) => n.prKey === pr.key && n.anchor?.path === file.path)));
  const drafts = useApp(useShallow((s) => Object.values(s.drafts).filter((d) => d.prKey === pr.key && d.path === file.path)));
  const put = useApp((s) => s.put);
  const toast = useApp((s) => s.toast);
  const [selection, setSelection] = useState<Interval | null>(null);
  const [anchorLine, setAnchorLine] = useState<DiffLine | null>(null);
  const [composer, setComposer] = useState<null | "note" | "comment">(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [showNotes, setShowNotes] = useState(() => localStorage.getItem("nl:inline-notes") !== "false");
  const [showComments, setShowComments] = useState(() => localStorage.getItem("nl:inline-comments") !== "false");
  const [showRail, setShowRail] = useState(() => localStorage.getItem("nl:review-notes-pane") === "true");
  const [closedAnnotations, setClosedAnnotations] = useState<Set<string>>(() => new Set());
  const annotation = (id: string, label: string, body: string, url?: string) =>
    <details key={id} className="panel inline-annotation" open={!closedAnnotations.has(id)} onToggle={(e) => {
      const open = e.currentTarget.open;
      setClosedAnnotations((previous) => {
        if (open === !previous.has(id)) return previous;
        const next = new Set(previous);
        if (open) next.delete(id);
        else next.add(id);
        return next;
      });
    }}><summary>{label}</summary><div>{body}</div>{url && <a href={url} target="_blank" rel="noreferrer">View on GitHub ↗</a>}</details>;
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
  const [scrollTo, setScrollTo] = useState<number | null>(null);
  const [expansions, setExpansions] = useState(new Map<number, { lines: string[]; startNo: number; label?: string }>());
  const [inspector, setInspector] = useState(false);
  const [impact, setImpact] = useState(false);
  const [sub, setSub] = useState(false);
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

  useActions(
    {
      nextHunk: () => { const h = Math.min(hunks.length - 1, curHunk() + 1); setScrollTo(starts[h]!); setSelection(hunkRange(h)); },
      prevHunk: () => { const h = Math.max(0, curHunk() - 1); setScrollTo(starts[h]!); setSelection(hunkRange(h)); },
      markReviewed: () => save(markReviewed(state, selection ?? hunkRange(curHunk()))),
      flag: () => selection && save(flagRange(state, selection)),
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
    const lines = await loadFull();
    if (!lines) return;
    const top = h.newStart - 1; // 0-based index of first hunk line in new file
    const prevEnd = hi > 0 ? hunks[hi - 1]!.newStart - 1 + hunks[hi - 1]!.newLines : 0;
    const cur = expansions.get(hi);
    const from = cur ? cur.startNo - 1 : top;
    const res = await expandToEnclosing(file.path, lines, Math.max(0, from - 1), 400);
    const start = Math.max(prevEnd, res.start);
    const next = new Map(expansions);
    const label = res.engine === "tree-sitter" ? `tree-sitter: ${res.label}` : res.engine === "heuristic" ? `heuristic fallback: ${res.label ?? "block"}` : "bounded lines (no semantic boundary found)";
    next.set(hi, { lines: lines.slice(start, top), startNo: start + 1, label: res.capped ? `${label} (capped; expand again for more)` : label });
    setExpansions(next);
  };

  const allRows = useMemo(() => hunks.flatMap((h) => h.lines), [hunks]);

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
    } else {
      const last = allRows[selection[1] - 1] ?? anchorLine;
      const first = allRows[selection[0]];
      const side = last?.kind === "del" ? "LEFT" : "RIGHT";
      const line = side === "LEFT" ? last?.oldNo : last?.newNo;
      const startLine = side === "LEFT" ? first?.oldNo : first?.newNo;
      if (line == null || (selection[1] - selection[0] > 1 && (startLine == null || startLine >= line))) {
        toast("warn", "Select a continuous range on one side of the diff for a GitHub comment.");
        return;
      }
      const draft: DraftComment = { id: newId("draft"), prKey: pr.key, headSha: pr.headSha, path: file.path, line, side, startLine: first !== last ? startLine ?? undefined : undefined, body, createdAt: Date.now() };
      put("drafts", draft.id, draft);
      toast("info", "Draft saved. It will be posted when you submit your review.");
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
      annotate(end - 1, annotation(n.id, `Private note · diff rows ${start + 1}–${end}`, n.body));
    }
  }
  if (showComments) {
    for (const d of drafts) if (d.headSha === pr.headSha) {
      annotate(lineIndex(d.line, d.side), annotation(d.id, `Draft GitHub comment · ${d.startLine ? d.startLine + "–" : ""}${d.line}`, d.body));
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
    if (selection) setScrollTo(selection[1] - 1);
  };

  const actions = selection ? [
    { label: "Mark reviewed", run: () => save(markReviewed(state, selection)) },
    { label: "Needs revisit", run: () => save(flagRange(state, selection)) },
    { label: "Clear flag", run: () => save(unflagRange(state, selection)) },
    { label: "Private note", run: () => openComposer("note") },
    { label: "GitHub comment", run: () => openComposer("comment") },
  ] : [];

  return (
    <div className="col" style={{ height: "100%", gap: 0 }}>
      <div className="toolbar">
        <span className="mono ellipsis" style={{ maxWidth: 420 }} title={file.path}>
          {file.kind === "renamed" ? `${file.oldPath} → ` : ""}
          {file.path}
        </span>
        <span className="chip">{file.kind}</span>
        <span className="chip">
          +{file.additions} −{file.deletions}
        </span>
        <span className={`chip ${st === "complete" ? "ok" : st === "needs-rereview" ? "err" : st === "incomplete" ? "warn" : ""}`}>
          {STATUS_ICON[st]} {st}
        </span>
        <div className="hbar" style={{ width: 120 }} title={`${Math.round(progress(state) * 100)}% reviewed`}>
          <span style={{ left: 0, width: `${progress(state) * 100}%`, background: "var(--ok)" }} />
        </div>
        <span className="spacer" />
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
      {selection && (
        <div className="toolbar small" style={{ background: "var(--accent-2)" }}>
          <span>
            Rows {selection[0] + 1}–{selection[1]} selected
          </span>
          <button className="btn sm" onClick={() => save(markReviewed(state, selection))}>
            r Mark reviewed
          </button>
          <button className="btn sm" onClick={() => save(flagRange(state, selection))}>
            x Needs revisit
          </button>
          <button className="btn sm" onClick={() => save(unflagRange(state, selection))}>
            Clear flag
          </button>
          <button className="btn sm" onClick={() => openComposer("note")}>
            ✎ Private note
          </button>
          <button className="btn sm" onClick={() => openComposer("comment")}>
            c GitHub comment
          </button>
          <button className="btn ghost sm" onClick={() => setSelection(null)}>
            ✕
          </button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Split id="review-notes" initial={0.74} min={0.18} showSecond={showRail}>
        <div className="grow" style={{ height: "100%", minWidth: 0, padding: 4 }}>
          {sub ? (
            <SubmoduleExpansion pr={pr} file={file} section={section} mode={mode} />
          ) : (
            <FileDiff
              section={section}
              mode={mode}
              expansions={expansions}
              onExpand={(hi, h) => void onExpand(hi, h)}
              review={{ state, setFrontier: (row) => save(setFrontier(fileState(useApp.getState().reviews[pr.key], file, section), row)) }}
              selection={selection}
              onSelect={(iv, a) => {
                setSelection(iv);
                setComposer(null);
                setMenu(null);
                setAnchorLine(a?.line ?? null);
              }}
              annotations={annotations}
              onLineContext={(e, i, line) => {
                e.preventDefault();
                if (!selection || i < selection[0] || i >= selection[1]) {
                  setSelection([i, i + 1]);
                  setComposer(null);
                }
                setAnchorLine(line);
                setMenu({ x: Math.max(0, Math.min(e.clientX, window.innerWidth - 195)), y: Math.max(0, Math.min(e.clientY, window.innerHeight - 176)) });
              }}
              scrollToRow={scrollTo}
            />
          )}
        </div>
        <NotesRail pr={pr} file={file} notes={notes} drafts={drafts} />
        </Split>
      </div>
      {menu && <div className="panel review-context-menu" style={{ left: menu.x, top: menu.y }} role="group" aria-label="Diff line actions">
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
            const p = buildFilePrompt(file.path, section, 30_000);
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
          <button className="btn ghost sm" onClick={() => remove("notes", n.id)}>
            delete
          </button>
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

function SubmoduleExpansion({ pr, file, section, mode }: { pr: PRSnapshot; file: DiffFileEntry; section: string; mode: DiffMode }) {
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
        <div className="grow" style={{ minWidth: 0 }}>{f && <FileDiff key={f.path} section={state.text!.slice(f.start, f.end)} mode={mode} />}</div>
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
