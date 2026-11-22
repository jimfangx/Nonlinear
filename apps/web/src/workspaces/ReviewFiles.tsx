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
} from "@nonlinear/core";
import { useApp, useSettings, type DraftComment } from "../lib/store";
import { fileSectionOf, fileState, saveFileState, gitlinkShas, type LoadedDiff } from "../lib/review";
import { githubApi, describeError } from "../lib/github";
import { aiAllowedFor, latestSummary, summarize } from "../lib/ai";
import { renderMarkdown } from "../lib/markdown";
import { isDesktop, desktop } from "../lib/platform";
import { exactRoot, lspAvailable, lspLocations, workingTreeFor, type LspLocation } from "../lib/lsp";
import { useActions } from "../lib/keys";
import { expandToEnclosing } from "../lib/treesitter";
import { FileDiff, hunkStarts, type DiffMode } from "../components/FileDiff";
import { Split, Modal, download } from "../components/ui";
import { FileInspector } from "./FileInspector";

const STATUS_ICON: Record<string, string> = { complete: "✓", incomplete: "◐", "not-started": "○", postponed: "⏸", "needs-rereview": "⟳" };

export function ReviewFiles({ pr, diff }: { pr: PRSnapshot; diff: LoadedDiff }) {
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
          <input className="input grow" placeholder="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} />
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
      {f ? <FilePane key={`${f.path}:${pr.headSha}`} pr={pr} diff={diff} file={f} mode={mode} setMode={(m) => { setMode(m); localStorage.setItem("nl:diffmode", m); }} /> : <div className="empty">No files</div>}
    </Split>
  );
}

function FilePane({ pr, diff, file, mode, setMode }: { pr: PRSnapshot; diff: LoadedDiff; file: DiffFileEntry; mode: DiffMode; setMode: (m: DiffMode) => void }) {
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
  const [scrollTo, setScrollTo] = useState<number | null>(null);
  const [expansions, setExpansions] = useState(new Map<number, { lines: string[]; startNo: number; label?: string }>());
  const [inspector, setInspector] = useState(false);
  const [impact, setImpact] = useState(false);
  const [sub, setSub] = useState(false);
  const starts = useMemo(() => hunkStarts(hunks), [hunks]);
  const st = fileStatus(state);
  const save = (s: FileReviewState) => saveFileState(pr, s);
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

  const markers = useMemo(() => {
    const m = new Map<number, React.ReactNode>();
    for (const n of notes) if (n.anchor) m.set(n.anchor.rows[0], <span className="chip accent" style={{ marginLeft: 8 }} title={n.body}>✎ note</span>);
    for (const d of drafts) {
      const rows = hunks.flatMap((h) => h.lines);
      const ri = rows.findIndex((l) => (d.side === "RIGHT" ? l.newNo === d.line && l.kind !== "del" : l.oldNo === d.line && l.kind !== "add"));
      if (ri >= 0) m.set(ri, <span className="chip info" style={{ marginLeft: 8 }} title={d.body}>💬 draft</span>);
    }
    return m;
  }, [notes, drafts, hunks]);

  const allRows = useMemo(() => hunks.flatMap((h) => h.lines), [hunks]);

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
        <button className="btn sm" onClick={() => save(markAllReviewed(state))} title="Mark whole file reviewed">
          ✓ Reviewed
        </button>
        <button className="btn sm" onClick={() => save({ ...state, postponed: !state.postponed, updatedAt: Date.now() })}>
          {state.postponed ? "▶ Unpostpone" : "⏸ Come back later"}
        </button>
        <button className="btn sm" onClick={() => save(resetFile(state))}>
          Reset
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
          <button className="btn sm" onClick={() => setComposer("note")}>
            ✎ Private note
          </button>
          <button className="btn sm" onClick={() => setComposer("comment")}>
            c GitHub comment
          </button>
          <button className="btn ghost sm" onClick={() => setSelection(null)}>
            ✕
          </button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <div className="grow" style={{ minWidth: 0, padding: 4 }}>
          {sub ? (
            <SubmoduleExpansion pr={pr} file={file} section={section} mode={mode} />
          ) : (
            <FileDiff
              section={section}
              mode={mode}
              expansions={expansions}
              onExpand={(hi, h) => void onExpand(hi, h)}
              review={{ state, setFrontier: (row) => save(setFrontier(state, row)) }}
              selection={selection}
              onSelect={(iv, a) => {
                setSelection(iv);
                setAnchorLine(a?.line ?? null);
              }}
              markers={markers}
              scrollToRow={scrollTo}
            />
          )}
        </div>
        <NotesRail pr={pr} file={file} notes={notes} drafts={drafts} />
      </div>
      {composer && selection && (
        <Composer
          kind={composer}
          onClose={() => setComposer(null)}
          onSave={(body) => {
            if (composer === "note") {
              const rows = allRows.map((l) => l.text);
              const n: PrivateNote = {
                id: newId("note"),
                prKey: pr.key,
                headSha: pr.headSha,
                anchor: { path: file.path, rows: selection, anchorText: rows.slice(selection[0], selection[1]), before: rows.slice(Math.max(0, selection[0] - 2), selection[0]), after: rows.slice(selection[1], selection[1] + 2) },
                body,
                orphaned: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              };
              put("notes", n.id, n);
            } else {
              const last = allRows[selection[1] - 1] ?? anchorLine;
              const first = allRows[selection[0]];
              if (!last || last.kind === "meta") {
                toast("warn", "GitHub cannot anchor a comment here. Use a PR-level comment instead.");
                return;
              }
              const side = last.kind === "del" ? "LEFT" : "RIGHT";
              const line = side === "LEFT" ? last.oldNo! : last.newNo!;
              const startLine = first && first !== last ? (side === "LEFT" ? first.oldNo : first.newNo) ?? undefined : undefined;
              const d: DraftComment = { id: newId("draft"), prKey: pr.key, headSha: pr.headSha, path: file.path, line, side, startLine, body, createdAt: Date.now() };
              put("drafts", d.id, d);
              toast("info", "Draft saved locally. It's posted when you submit your review.");
            }
            setComposer(null);
          }}
        />
      )}
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
  if (!notes.length && !drafts.length && !orphaned.length) return null;
  return (
    <aside style={{ width: 260, flex: "none", borderLeft: "1px solid var(--border)", overflow: "auto", padding: 8 }} aria-label="Notes and drafts">
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

function Composer({ kind, onClose, onSave }: { kind: "note" | "comment"; onClose: () => void; onSave: (b: string) => void }) {
  const [v, setV] = useState("");
  return (
    <Modal
      title={kind === "note" ? "Private note (never posted to GitHub)" : "Draft GitHub comment"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!v.trim()} onClick={() => onSave(v)}>
            {kind === "note" ? "Save note" : "Save draft"}
          </button>
        </>
      }
    >
      <textarea aria-label={kind === "note" ? "Private note" : "Draft GitHub comment"} autoFocus className="input" style={{ width: "100%" }} value={v} onChange={(e) => setV(e.target.value)} placeholder={kind === "comment" ? "Tip: ```suggestion blocks become GitHub suggestions" : ""} />
    </Modal>
  );
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
    for (const s of symbols) {
      const re = new RegExp(`\\b${s}\\b`);
      const hits: { path: string; count: number }[] = [];
      for (const f of diff.index.files) {
        if (f.path === file.path) continue;
        const txt = diff.text.slice(f.start, f.end);
        const count = txt.split("\n").filter((l) => re.test(l)).length;
        if (count) hits.push({ path: f.path, count });
      }
      m.set(s, hits);
    }
    return m;
  }, [symbols, diff, file.path]);
  const [cg, setCg] = useState<string | null>(null);
  const repoKey = `${pr.owner}/${pr.repo}`.toLowerCase();
  const lspAvail = lspAvailable(repoKey, file.path);
  const [confirmed, setConfirmed] = useState<Record<string, { server: string; locations: LspLocation[]; error?: string }>>({});
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
  return (
    <Modal title={`Impact — ${file.path}`} onClose={onClose} wide>
      <div className="col small">
        <div className="banner info">
          Engine: <b>{lspAvail.ok ? `${lspAvail.server.name} (LSP) on demand; heuristic below` : isDesktop() ? "heuristic (configure a language server + working tree for confirmed results)" : "heuristic (web)"}</b>. Unless marked confirmed, relationships are <b>inferred</b> from symbol names in this PR's changed files, not confirmed by a semantic index. For the full repo graph, use the desktop app or a paired SSH agent.
        </div>
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
              {isDesktop() && workingTreeFor(repoKey) && (
                <button className="btn sm" onClick={() => void desktop.codegraph(workingTreeFor(repoKey)!, "impact", s).then(setCg).catch((e) => setCg(String(e)))}>
                  CodeGraph impact
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
        {cg && <pre className="mono" style={{ whiteSpace: "pre-wrap" }}>{cg}</pre>}
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
