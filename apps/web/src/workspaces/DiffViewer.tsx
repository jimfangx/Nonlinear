import { getBlob, putBlob } from "../lib/db";
import { gitShowFile } from "../lib/sources";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { filterFiles, parseGitmodules, submoduleMap, LARGE_IMPORT_WARN_BYTES, type DiffFileEntry, type MultiRepoDiff, type RepoGroup } from "@nonlinear/core";
import { useApp } from "../lib/store";
import { deleteImport, loadFileSection, loadIndex, searchContent } from "../lib/importStore";
import { githubApi, describeError } from "../lib/github";
import { DiffCodeLayoutSelect, FileDiff, useDiffCodeLayout, type DiffCodeLayout, type DiffMode } from "../components/FileDiff";
import { DiffStat, Split, timeAgo } from "../components/ui";
import { NavIcon } from "../components/NavIcon";
import { keyLabel, useActions } from "../lib/keys";
import type { WorkerIn, WorkerOut } from "../workers/diff.worker";

const loaded = new Map<string, MultiRepoDiff>();

function parseInWorker(file: File, name: string, root: string, rootRef: string, submodules: WorkerIn["submodules"], onProgress: (p: string) => void): Promise<{ diff: MultiRepoDiff; ms: number }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("../workers/diff.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.kind === "progress") onProgress(`Indexing ${m.path} (${m.done}/${m.total})`);
      if (m.kind === "done") {
        resolve({ diff: m.diff, ms: m.ms });
        w.terminate();
      }
      if (m.kind === "error") {
        reject(new Error(m.message));
        w.terminate();
      }
    };
    w.onerror = (e) => {
      reject(new Error(e.message));
      w.terminate();
    };
    w.postMessage({ kind: "import", file, name, root, rootRef, submodules } satisfies WorkerIn);
  });
}

export function DiffWorkspace() {
  const { id } = useParams();
  const diffs = useApp((s) => s.diffs);
  const nav = useNavigate();
  const [diff, setDiff] = useState<MultiRepoDiff | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [root, setRoot] = useState("");
  const [rootRef, setRootRef] = useState("main");
  const fileRef = useRef<HTMLInputElement>(null);
  const importing = useRef(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!id) return setDiff(null);
    const cached = loaded.get(id);
    if (cached) return setDiff(cached);
    const meta = diffs[id];
    if (!meta) return;
    setStatus("Loading from local cache…");
    void loadIndex(id).then((d) => {
      if (!d) return setStatus("Import data missing from local cache.");
      loaded.set(id, d);
      setDiff(d);
      setStatus(null);
    });
  }, [id, diffs]);

  const importFile = async (f: File) => {
    if (importing.current) return;
    importing.current = true;
    try {
      if (f.size > LARGE_IMPORT_WARN_BYTES) useApp.getState().toast("info", `${(f.size / 1048576).toFixed(1)} MB is above the 50 MB target: patches are spilled to disk and loaded per file.`);
      let subs: WorkerIn["submodules"];
      if (/^[^/\s]+\/[^/\s]+$/.test(root.trim())) {
        setStatus(`Resolving submodules via ${root}@${rootRef} .gitmodules…`);
        subs = await resolveSubmodules(root.trim(), rootRef.trim() || "HEAD").catch((e) => {
          useApp.getState().toast("warn", `Could not resolve .gitmodules: ${describeError(e)}. Importing without repository identities.`);
          return undefined;
        });
      }
      const { diff: d, ms } = await parseInWorker(f, f.name, root.trim(), rootRef.trim() || "HEAD", subs, setStatus);
      useApp.getState().put("diffs", d.id, { id: d.id, name: f.name, rootRepo: root.trim() || null, sourceBytes: d.sourceBytes, contentHash: d.contentHash, importedAt: d.importedAt, totals: d.totals });
      loaded.set(d.id, d);
      setStatus(null);
      useApp.getState().toast("success", `Parsed ${d.totals.files} files across ${d.groups.length} groups in ${Math.round(ms)} ms`);
      nav(`/diff/${d.id}`);
    } catch (e) {
      setStatus(null);
      useApp.getState().toast("error", (e as Error).message);
    } finally {
      importing.current = false;
    }
  };

  const dropHandlers = {
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setDragging(true);
    },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false);
    },
    onDrop: (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragging(false);
      const file = event.dataTransfer.files[0];
      if (file) void importFile(file);
    },
  };

  if (!id || !diff) {
    return (
      <div className="page" {...dropHandlers}>
        <h1 className="h1">Multi-Repository Diff</h1>
        <p className="muted">Import a JSON map of submodule patches or a .diff or .patch with optional submodule changes.</p>
        <div className="panel pad col" style={{ maxWidth: 720 }}>
          <div className="row">
            <label className="col grow" style={{ gap: 2 }}>
              <span className="small muted">Root repository (optional, resolves submodule identities)</span>
              <input className="input" value={root} onChange={(e) => setRoot(e.target.value)} data-workspace-entry placeholder="owner/repo" />
            </label>
            <label className="col" style={{ gap: 2, width: 140 }}>
              <span className="small muted">Ref</span>
              <input className="input" value={rootRef} onChange={(e) => setRootRef(e.target.value)} />
            </label>
          </div>
          <button type="button" className={`panel pad diff-drop ${dragging ? "drag-over" : ""}`} onClick={() => fileRef.current?.click()}>
            Drop a JSON, .diff, or .patch file here or click to choose
          </button>
          <input ref={fileRef} type="file" accept=".json,.diff,.patch,application/json,text/x-diff,text/x-patch" hidden onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (file) void importFile(file);
          }} />
          {status && <div className="faint small">{status}</div>}
        </div>
        {Object.keys(diffs).length > 0 && (
          <div style={{ marginTop: 20, maxWidth: 720 }}>
            <h3 className="h3">Previous imports (available offline)</h3>
            <div className="panel">
              {Object.values(diffs)
                .sort((a, b) => b.importedAt - a.importedAt)
                .map((d) => (
                  <div key={d.id} className="list-row" onClick={() => nav(`/diff/${d.id}`)}>
                    <span className="grow">
                      <b>{d.name}</b> <span className="faint small">{d.rootRepo ?? "no root"}</span>
                    </span>
                    <span className="faint small">
                      {d.totals.files} files · {(d.sourceBytes / 1024).toFixed(0)} KB · {timeAgo(d.importedAt)}
                    </span>
                    <button
                      className="btn ghost sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        useApp.getState().remove("diffs", d.id);
                        void deleteImport(d.id);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>
    );
  }
  return <div className="active-diff-workspace" {...dropHandlers}>
    <DiffView diff={diff} />
    {(dragging || status) && <div className="panel pad diff-drop-status" role="status">{dragging ? "Drop to import a diff" : status}</div>}
  </div>;
}

async function resolveSubmodules(root: string, ref: string): Promise<WorkerIn["submodules"]> {
  const [owner, repo] = root.split("/") as [string, string];
  const settings = useApp.getState().settings_();
  const path = settings.localRepos[root.toLowerCase()];
  let text: string | null | undefined;
  if (path) {
    try { text = await gitShowFile({ kind: "local", path }, ref, ".gitmodules"); } catch { /* Try the configured GitHub source. */ }
  }
  if (text === undefined || text === null) {
    const key = `diff-gitmodules:${settings.apiBase}:${settings.me ?? "anonymous"}:${settings.publicOnly}:${root.toLowerCase()}:${ref}`;
    const saved = await getBlob(key).then((value) => value ? JSON.parse(value) as { text: string | null; at: number } : null).catch(() => null);
    if (saved && (Date.now() - saved.at < 30 * 60_000 || !useApp.getState().online)) text = saved.text;
    else {
      try {
        text = await (await githubApi()).contents(owner, repo, ".gitmodules", ref);
        await putBlob(key, JSON.stringify({ text, at: Date.now() })).catch(() => undefined);
      } catch (error) {
        if (!saved) throw error;
        text = saved.text;
      }
    }
  }
  return [...submoduleMap(parseGitmodules(text ?? "", { owner, repo }))];
}

const KINDS = ["added", "deleted", "modified", "renamed", "binary", "submodule", "mode-change"];

function DiffView({ diff }: { diff: MultiRepoDiff }) {
  const [q, setQ] = useState("");
  const [content, setContent] = useState(false);
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  const [groupsSel, setGroupsSel] = useState<Set<string> | null>(null);
  const [mode, setMode] = useState<DiffMode>("split");
  const [sidebar, setSidebar] = useState(() => localStorage.getItem("nl:diff-sidebar") !== "hidden");
  const [fit, setFit] = useDiffCodeLayout("nl:diff-fit", "wrap");
  const toggleSidebar = () => setSidebar((value) => {
    localStorage.setItem("nl:diff-sidebar", value ? "hidden" : "visible");
    return !value;
  });
  const [sel, setSel] = useState<{ g: string; p: string } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Content search runs asynchronously over the spilled sections on disk.
  const [contentHits, setContentHits] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!content || q.length < 2) return setContentHits(null);
    const sig = { cancelled: false };
    const t = setTimeout(() => void searchContent(diff.id, q, sig).then((h) => !sig.cancelled && setContentHits(h)), 250);
    return () => {
      sig.cancelled = true;
      clearTimeout(t);
    };
  }, [content, q, diff.id]);
  const files = useMemo(() => {
    if (content && q.length >= 2) {
      if (!contentHits) return [];
      return filterFiles(diff, { kinds, groups: groupsSel ?? undefined }).filter((x) => contentHits.has(`${x.group.path}|${x.file.index}`) || `${x.group.path}/${x.file.path}`.toLowerCase().includes(q.toLowerCase()));
    }
    return filterFiles(diff, { query: q, kinds, groups: groupsSel ?? undefined });
  }, [diff, q, content, kinds, groupsSel, contentHits]);
  type Row = { t: "group"; g: RepoGroup; count: number } | { t: "file"; g: RepoGroup; f: DiffFileEntry };
  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const g of diff.groups) {
      const fs = files.filter((x) => x.group === g);
      if (!fs.length && (q || kinds.size)) continue;
      out.push({ t: "group", g, count: fs.length });
      if (!collapsed.has(g.path)) for (const x of fs) out.push({ t: "file", g, f: x.file });
    }
    return out;
  }, [diff, files, collapsed, q, kinds]);
  const parentRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => 26, overscan: 20 });
  const current = sel ? diff.groups.find((g) => g.path === sel.g)?.index.files.find((f) => f.path === sel.p) : undefined;
  const currentGroup = sel ? diff.groups.find((g) => g.path === sel.g) : undefined;
  const fileRows = useMemo(() => rows.map((r, i) => ({ r, i })).filter((x): x is { r: Extract<Row, { t: "file" }>; i: number } => x.r.t === "file"), [rows]);
  const step = (delta: number) => {
    if (!fileRows.length) return;
    const at = fileRows.findIndex(({ r }) => sel?.g === r.g.path && sel.p === r.f.path);
    const next = fileRows[at < 0 ? (delta > 0 ? 0 : fileRows.length - 1) : Math.max(0, Math.min(fileRows.length - 1, at + delta))]!;
    setSel({ g: next.r.g.path, p: next.r.f.path });
    virt.scrollToIndex(next.i, { align: "auto" });
  };
  useActions({ next: () => step(1), prev: () => step(-1), diffSidebar: (event) => { if (!event.repeat && !document.querySelector("#workspace-content[inert], .overlay:not([inert])")) toggleSidebar(); } }, [fileRows, sel]);

  return (
    <div className="col" style={{ height: "100%", gap: 0 }}>
      <div className="toolbar">
        <button className="btn ghost" type="button" aria-label="Toggle changed files" aria-pressed={sidebar} title={`Toggle changed files (${keyLabel("diffSidebar")})`} onClick={toggleSidebar}><NavIcon name="sidebar" /></button>
        <h1 className="toolbar-title">{diff.name}</h1>
        <span className="chip">
          {diff.totals.files} files · +{diff.totals.additions} −{diff.totals.deletions} · {diff.groups.length} groups
        </span>
        <input className="input" style={{ width: 240 }} data-workspace-search placeholder="Search paths…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="row small">
          <input type="checkbox" checked={content} onChange={(e) => setContent(e.target.checked)} /> search content
        </label>
        {KINDS.map((k) => (
          <button key={k} className={`btn sm ${kinds.has(k) ? "primary" : ""}`} onClick={() => { const s = new Set(kinds); s.has(k) ? s.delete(k) : s.add(k); setKinds(s); }}>
            {k}
          </button>
        ))}
        <span className="spacer" />
        <DiffCodeLayoutSelect layout={fit} onChange={setFit} />
        <select className="input" value={mode} onChange={(e) => setMode(e.target.value as DiffMode)} aria-label="Diff mode">
          <option value="split">Side-by-side</option>
          <option value="unified">Unified</option>
        </select>
      </div>
      {diff.issues.length > 0 && <div className="banner warn">{diff.issues.join(" · ")}</div>}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Split id="multidiff" className="workspace-split" initial={0.26} showFirst={sidebar}>
          <div className="col review-file-list diff-file-list" aria-label="Changed files">
          <div className="review-file-list-head"><span>Files changed · {diff.totals.files}</span><DiffStat compact additions={diff.totals.additions} deletions={diff.totals.deletions} /></div>
          <div ref={parentRef} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 4 }} role="tree">
            <div style={{ height: virt.getTotalSize(), position: "relative" }}>
              {virt.getVirtualItems().map((vi) => {
                const r = rows[vi.index]!;
                const style = { position: "absolute" as const, top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)`, height: 26 };
                if (r.t === "group") {
                  const label = r.g.path === "" ? "(root)" : r.g.path;
                  return (
                    <div key={vi.key} style={style} className="tree-row" onClick={() => { const s = new Set(collapsed); s.has(r.g.path) ? s.delete(r.g.path) : s.add(r.g.path); setCollapsed(s); }}>
                      <span>{collapsed.has(r.g.path) ? "▸" : "▾"}</span>
                      <b className="ellipsis grow">{label}</b>
                      {r.g.repo && <span className="faint small">{r.g.repo.owner}/{r.g.repo.repo}</span>}
                      <span className="chip">{r.g.index.files.length}</span>
                      <input
                        type="checkbox"
                        aria-label={`Include ${label}`}
                        checked={!groupsSel || groupsSel.has(r.g.path)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => {
                          const s = new Set(groupsSel ?? diff.groups.map((g) => g.path));
                          s.has(r.g.path) ? s.delete(r.g.path) : s.add(r.g.path);
                          setGroupsSel(s);
                        }}
                      />
                    </div>
                  );
                }
                const active = sel?.g === r.g.path && sel.p === r.f.path;
                return (
                  <div key={vi.key} style={{ ...style, paddingLeft: 22 }} className={`tree-row ${active ? "active" : ""}`} role="treeitem" aria-selected={active} onClick={() => setSel({ g: r.g.path, p: r.f.path })} title={r.f.path}>
                    <KindIcon k={r.f.kind} />
                    <span className="ellipsis grow">{r.f.path.split("/").at(-1)} <span className="faint small">{r.f.path.split("/").slice(0, -1).join("/")}</span></span>
                    <span className="small" style={{ color: "var(--ok)" }}>+{r.f.additions}</span>
                    <span className="small" style={{ color: "var(--err)" }}>−{r.f.deletions}</span>
                  </div>
                );
              })}
            </div>
            {diff.groups.filter((g) => g.index.files.length === 0).map((g) => (
              <div key={g.path} className="faint small" style={{ padding: "4px 8px" }}>
                {g.path || "(root)"}: no changed files
              </div>
            ))}
          </div>
          </div>
          <div className="col" style={{ height: "100%", gap: 0 }}>
            {current && currentGroup ? (
              <>
                <div className="toolbar small">
                  <span className="faint">{currentGroup.path === "" ? "root" : currentGroup.path}</span>
                  <span>›</span>
                  <b className="mono">{current.path}</b>
                  {current.kind === "renamed" && <span className="faint">from {current.oldPath}</span>}
                  <span className="chip">{current.kind}</span>
                  {current.generated && <span className="chip warn">generated</span>}
                  {currentGroup.repo && (
                    <a href={`https://github.com/${currentGroup.repo.owner}/${currentGroup.repo.repo}/blob/HEAD/${current.path}`} target="_blank" rel="noreferrer">
                      GitHub ↗
                    </a>
                  )}
                  {current.issues.length > 0 && <span className="chip err">{current.issues.join("; ")}</span>}
                </div>
                <div style={{ flex: 1, minHeight: 0, padding: 4 }}>
                  <SpilledFileDiff key={`${sel!.g}/${sel!.p}`} id={diff.id} group={currentGroup.path} index={current.index} path={current.path} mode={mode} fit={fit} highlight={content ? q : undefined} />
                </div>
              </>
            ) : (
              <div className="empty">Select a file. Only that file's patch is parsed and rendered.</div>
            )}
          </div>
        </Split>
      </div>
    </div>
  );
}

function SpilledFileDiff({ id, group, index, path, mode, highlight, fit }: { fit: DiffCodeLayout; id: string; group: string; index: number; path: string; mode: DiffMode; highlight?: string }) {
  const [section, setSection] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void loadFileSection(id, group, index).then((s) => live && setSection(s));
    return () => {
      live = false;
    };
  }, [id, group, index]);
  if (section === null) return <div className="empty small">Loading patch from disk…</div>;
  return <FileDiff path={path} section={section} mode={mode} layout={fit} highlight={highlight} />;
}

function KindIcon({ k }: { k: string }) {
  const m: Record<string, [string, string]> = { added: ["A", "var(--ok)"], deleted: ["D", "var(--err)"], modified: ["M", "var(--warn)"], renamed: ["R", "var(--info)"], copied: ["C", "var(--info)"], binary: ["B", "var(--text-3)"], submodule: ["S", "var(--accent)"], "mode-change": ["X", "var(--text-3)"] };
  const [c, col] = m[k] ?? ["?", "var(--text-3)"];
  return (
    <span className="mono" style={{ color: col, width: 12, fontWeight: 700 }} title={k}>
      {c}
    </span>
  );
}
