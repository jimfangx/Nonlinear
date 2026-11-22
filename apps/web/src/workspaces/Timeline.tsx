import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  checkNestedConsistency,
  makeScale,
  newId,
  pinKey,
  scaleWidth,
  ticks,
  xOf,
  type CommitNode,
  type Release,
  type ReleasePin,
  type TimeScale,
  type Zoom,
} from "@nonlinear/core";
import { useApp, type TimelineView } from "../lib/store";
import { loadRoot, rowsFor, loadRowHistory, loadRowPRs, pinOnBranch, gitlinksAt, type RootSnapshot, type SubmoduleRow } from "../lib/timeline";
import { describeError } from "../lib/github";
import { availableSources, childSource, sourceLabel, type Source } from "../lib/sources";
import { Modal } from "../components/ui";

export function TimelineWorkspace() {
  const { id } = useParams();
  const timelines = useApp((s) => s.timelines);
  const [creating, setCreating] = useState(false);
  const nav = useNavigate();
  const tl = id ? timelines[id] : undefined;
  const [splitWith, setSplitWith] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>(tl?.zoom ?? "week");
  const [crossX, setCrossX] = useState<number | null>(null);
  const [scrollX, setScrollX] = useState(0);
  const [scales, setScales] = useState<Record<string, TimeScale>>({});
  const [focusChild, setFocusChild] = useState<{ repo: string; sha: string | null } | null>(null);

  useEffect(() => setSplitWith(null), [id]);

  if (!tl) {
    return (
      <div className="page">
        <h1 className="h1">Submodule Timelines</h1>
        <p className="muted">Track a root repository and baseline ref; one row per submodule in .gitmodules at the selected root commit. Releases are drawn as draggable segmented lines; nothing is written to GitHub until you apply a release explicitly.</p>
        <div className="panel">
          {Object.values(timelines).map((t) => (
            <div key={t.id} className="list-row" onClick={() => nav(`/timeline/${t.id}`)}>
              <b className="grow">{t.name}</b>
              <span className="faint small">
                {t.root}@{t.baseRef}
              </span>
            </div>
          ))}
          {!Object.keys(timelines).length && <div className="empty">No timelines yet.</div>}
        </div>
        <button className="btn primary" style={{ marginTop: 12 }} onClick={() => setCreating(true)}>
          + New timeline
        </button>
        {creating && <CreateTimeline onClose={() => setCreating(false)} />}
      </div>
    );
  }

  // Union scale so both panes share calendar alignment (§3.3).
  const union: TimeScale | null = (() => {
    const ss = Object.values(scales);
    if (!ss.length) return null;
    return { start: Math.min(...ss.map((s) => s.start)), end: Math.max(...ss.map((s) => s.end)), pxPerDay: ss[0]!.pxPerDay };
  })();

  const children = Object.values(timelines).filter((t) => t.id !== tl.id);

  return (
    <div className="col" style={{ height: "100%", gap: 0 }}>
      <div className="toolbar">
        <h1 className="toolbar-title">{tl.name}</h1>
        <span className="faint small">
          {tl.root}@{tl.baseRef}
          {tl.rootSha ? ` (${tl.rootSha.slice(0, 8)})` : ""}
        </span>
        <span className="spacer" />
        <label className="small row">
          Zoom
          <select className="input" value={zoom} onChange={(e) => { setZoom(e.target.value as Zoom); useApp.getState().patch("timelines", tl.id, { zoom: e.target.value as Zoom }); }}>
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
          </select>
        </label>
        <select className="input" value={splitWith ?? ""} onChange={(e) => setSplitWith(e.target.value || null)} aria-label="Split with timeline">
          <option value="">No split</option>
          {children.map((c) => (
            <option key={c.id} value={c.id}>
              Split: {c.name}
            </option>
          ))}
        </select>
        <button className="btn sm" onClick={() => setCreating(true)}>
          + New
        </button>
      </div>
      <div className="col" style={{ flex: 1, minHeight: 0, gap: 0 }}>
        <div style={{ flex: 1, minHeight: 0, borderBottom: splitWith ? "2px solid var(--border-strong)" : undefined }}>
          <TimelinePane
            tl={tl}
            zoom={zoom}
            union={union}
            onScale={(s) => setScales((x) => (x[tl.id]?.start === s.start && x[tl.id]?.end === s.end && x[tl.id]?.pxPerDay === s.pxPerDay ? x : { ...x, [tl.id]: s }))}
            crossX={crossX}
            setCrossX={setCrossX}
            scrollX={scrollX}
            setScrollX={setScrollX}
            highlightChild={focusChild}
            onOpenChild={(row) => {
              const existing = Object.values(timelines).find((t) => t.root === row.childKey);
              if (existing) setSplitWith(existing.id);
              else if (row.childKey) {
                const t: TimelineView = { id: newId("tl"), name: `${row.entry.path} (${row.childKey})`, root: row.childKey, baseRef: row.branch ?? "main", rootSha: null, visiblePaths: null, zoom, parentTimelineId: tl.id, pathPrefix: [...tl.pathPrefix, row.entry.path], createdAt: Date.now(), source: tl.source && tl.source.kind !== "github" ? childSource(tl.source, row.entry.path, row.childKey) : undefined };
                if (confirm(`Create child timeline for ${row.childKey}?`)) {
                  useApp.getState().put("timelines", t.id, t);
                  setSplitWith(t.id);
                }
              }
            }}
          />
        </div>
        {splitWith && timelines[splitWith] && (
          <div style={{ flex: 1, minHeight: 0 }}>
            <TimelinePane
              tl={timelines[splitWith]!}
              zoom={zoom}
              union={union}
              onScale={(s) => setScales((x) => (x[splitWith]?.start === s.start && x[splitWith]?.end === s.end && x[splitWith]?.pxPerDay === s.pxPerDay ? x : { ...x, [splitWith]: s }))}
              crossX={crossX}
              setCrossX={setCrossX}
              scrollX={scrollX}
              setScrollX={setScrollX}
              parent={tl}
              onSelectPin={(repo, sha) => setFocusChild({ repo, sha })}
              onOpenChild={() => undefined}
            />
          </div>
        )}
      </div>
      {creating && <CreateTimeline onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateTimeline({ onClose }: { onClose: () => void }) {
  const [root, setRoot] = useState("ucb-bar/chipyard");
  const [ref, setRef] = useState("main");
  const [sha, setSha] = useState("");
  const nav = useNavigate();
  return (
    <Modal
      title="New timeline view"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!/^[^/\s]+\/[^/\s]+$/.test(root)}
          onClick={() => {
            const t: TimelineView = { id: newId("tl"), name: `${root}@${ref}`, root: root.toLowerCase(), baseRef: ref, rootSha: sha.trim() || null, visiblePaths: null, zoom: "week", parentTimelineId: null, pathPrefix: [], createdAt: Date.now() };
            useApp.getState().put("timelines", t.id, t);
            onClose();
            nav(`/timeline/${t.id}`);
          }}
        >
          Create
        </button>
      }
    >
      <div className="col">
        <label className="col" style={{ gap: 2 }}>
          <span className="small muted">Root repository</span>
          <input className="input" value={root} onChange={(e) => setRoot(e.target.value)} />
        </label>
        <label className="col" style={{ gap: 2 }}>
          <span className="small muted">Baseline branch/ref</span>
          <input className="input" value={ref} onChange={(e) => setRef(e.target.value)} />
        </label>
        <label className="col" style={{ gap: 2 }}>
          <span className="small muted">Root commit (optional; default = tip of ref)</span>
          <input className="input mono" value={sha} onChange={(e) => setSha(e.target.value)} />
        </label>
      </div>
    </Modal>
  );
}

const ROW_H = 36;
const LABEL_W = 260;

interface PaneProps {
  tl: TimelineView;
  zoom: Zoom;
  union: TimeScale | null;
  onScale: (s: TimeScale) => void;
  crossX: number | null;
  setCrossX: (x: number | null) => void;
  scrollX: number;
  setScrollX: (x: number) => void;
  parent?: TimelineView;
  highlightChild?: { repo: string; sha: string | null } | null;
  onSelectPin?: (repo: string, sha: string) => void;
  onOpenChild: (row: SubmoduleRow) => void;
}

function TimelinePane({ tl, zoom, union, onScale, crossX, setCrossX, scrollX, setScrollX, parent, highlightChild, onSelectPin, onOpenChild }: PaneProps) {
  const [snap, setSnap] = useState<RootSnapshot | null>(null);
  const [rows, setRows] = useState<SubmoduleRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [alignDate, setAlignDate] = useState("");
  const [suggest, setSuggest] = useState<Map<string, CommitNode>>(new Map());
  const [hover, setHover] = useState<{ c: CommitNode; x: number; y: number; row: string } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const releases = useApp((s) => s.releases);
  const pins = useApp((s) => s.pins);
  const put = useApp((s) => s.put);
  const remove = useApp((s) => s.remove);
  const [visibleReleases, setVisibleReleases] = useState<Set<string>>(() => new Set(Object.values(releases).filter((r) => r.state !== "archived").map((r) => r.id)));
  const [activeRelease, setActiveRelease] = useState<string | null>(Object.values(releases).find((r) => r.state === "draft")?.id ?? null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    setSnap(null);
    const src = tl.source ?? { kind: "github" as const };
    loadRoot(tl.root, tl.baseRef, tl.rootSha, src)
      .then(async (s) => {
        if (cancelled) return;
        setSnap(s);
        const base = rowsFor(s);
        setRows(base);
        // Load child histories with bounded concurrency.
        const out = [...base];
        let i = 0;
        await Promise.all(
          Array.from({ length: 4 }, async () => {
            while (i < out.length) {
              const k = i++;
              if (out[k]!.status !== "loading") continue;
              out[k] = await loadRowHistory(out[k]!, { sinceDays: zoom === "month" ? 365 : zoom === "week" ? 120 : 30 }, src);
              out[k] = { ...out[k]!, prs: await loadRowPRs(out[k]!, Object.values(useApp.getState().prs)).catch(() => []) };
              if (!cancelled) setRows([...out]);
            }
          }),
        );
      })
      .catch((e) => !cancelled && setErr(describeError(e)));
    return () => {
      cancelled = true;
    };
  }, [tl.root, tl.baseRef, tl.rootSha, JSON.stringify(tl.source ?? null)]);

  const ownScale = useMemo(() => {
    const dates: string[] = [];
    for (const r of rows) for (const c of r.history ?? []) dates.push(c.committedAt);
    if (snap) dates.push(snap.commit.committedAt);
    return makeScale(dates, zoom);
  }, [rows, snap, zoom]);
  useEffect(() => onScale(ownScale), [ownScale]);
  const scale = union ? { ...union, pxPerDay: ownScale.pxPerDay } : ownScale;
  const width = scaleWidth(scale);
  const tks = useMemo(() => ticks(scale, zoom), [scale, zoom]);

  // synchronized horizontal scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (el && Math.abs(el.scrollLeft - scrollX) > 1) el.scrollLeft = scrollX;
  }, [scrollX]);

  const pinFor = (relId: string, path: string): ReleasePin | undefined => pins[pinKey({ releaseId: relId, parentRepo: tl.root, pathChain: [...tl.pathPrefix, path] })];

  const setPin = (rel: Release, row: SubmoduleRow, c: CommitNode) => {
    if (rel.state === "frozen") {
      useApp.getState().toast("warn", `${rel.name} is frozen. Unfreeze it to edit pins.`);
      return;
    }
    const p: ReleasePin = { releaseId: rel.id, parentRepo: tl.root, pathChain: [...tl.pathPrefix, row.entry.path], childRepo: row.childKey, sha: c.sha, committedAt: c.committedAt, updatedAt: Date.now() };
    put("pins", pinKey(p), p);
  };

  // Nested consistency warnings (§3.3): compare parent's planned pin of this child vs our pins.
  useEffect(() => {
    if (!parent) return setWarnings([]);
    const out: string[] = [];
    void (async () => {
      for (const rel of Object.values(releases)) {
        const parentPin = Object.values(pins).find((p) => p.releaseId === rel.id && p.parentRepo === parent.root && p.childRepo === tl.root);
        if (!parentPin) continue;
        const nested = Object.values(pins).filter((p) => p.releaseId === rel.id && p.parentRepo === tl.root);
        if (!nested.length) continue;
        try {
          const links = await gitlinksAt(tl.root, parentPin.sha);
          const adjusted = nested.map((n) => ({ ...n, pathChain: [...parentPin.pathChain, n.pathChain[n.pathChain.length - 1]!] }));
          for (const w of checkNestedConsistency(parentPin, adjusted, links)) out.push(`${rel.name}: ${w.message}`);
        } catch (e) {
          out.push(`${rel.name}: could not verify nested pins (${describeError(e)})`);
        }
      }
      setWarnings(out);
    })();
  }, [parent, pins, releases, tl.root]);

  const propagateUp = async (rel: Release) => {
    // Find a child commit (on loaded history of this pane's root) whose gitlinks contain all nested pins.
    if (!parent) return;
    const nested = Object.values(pins).filter((p) => p.releaseId === rel.id && p.parentRepo === tl.root);
    const parentRows = await loadRoot(parent.root, parent.baseRef, parent.rootSha).then(rowsFor);
    const row = parentRows.find((r) => r.childKey === tl.root);
    if (!row) return useApp.getState().toast("warn", "This repository is not a submodule of the parent timeline's root.");
    const hist = (await loadRowHistory(row, { sinceDays: 180 })).history ?? [];
    for (const c of hist.slice(0, 25)) {
      const links = await gitlinksAt(tl.root, c.sha);
      if (nested.every((n) => links.get(n.pathChain[n.pathChain.length - 1]!) === n.sha)) {
        const p: ReleasePin = { releaseId: rel.id, parentRepo: parent.root, pathChain: [...parent.pathPrefix, row.entry.path], childRepo: tl.root, sha: c.sha, committedAt: c.committedAt, note: "Proposed by propagate-upward (draft)", updatedAt: Date.now() };
        put("pins", pinKey(p), p);
        return useApp.getState().toast("success", `Draft parent pin ${row.entry.path} → ${c.sha.slice(0, 8)} contains all nested pins.`);
      }
    }
    useApp.getState().toast("warn", "No recent commit of this repository contains all planned nested pins. Pins may need an upstream bump first.");
  };

  const doAlign = () => {
    if (!alignDate) return setSuggest(new Map());
    const iso = new Date(alignDate + "T23:59:59Z").toISOString();
    const m = new Map<string, CommitNode>();
    for (const r of rows) {
      if (!r.index || !r.tip) continue;
      const c = r.index.latestAtOrBefore(r.tip.sha, iso);
      if (c) m.set(r.entry.path, c);
    }
    setSuggest(m);
  };

  const visibleRels = Object.values(releases).filter((r) => visibleReleases.has(r.id));

  if (err) return <div className="banner err" style={{ margin: 12 }}>{err}</div>;
  if (!snap) return <div className="empty">Loading {tl.root}@{tl.baseRef}…</div>;

  return (
    <div className="col" style={{ height: "100%", gap: 0 }}>
      <div className="toolbar small">
        <b>{tl.root}</b>
        <span className="mono faint" title={snap.commit.message}>
          @{snap.commit.sha.slice(0, 8)} · {new Date(snap.commit.committedAt).toLocaleDateString()}
        </span>
        <span className="faint">{rows.length} submodules</span>
        <select
          className="input"
          aria-label="Data source"
          value={JSON.stringify(tl.source ?? { kind: "github" })}
          onChange={(e) => useApp.getState().patch("timelines", tl.id, { source: JSON.parse(e.target.value) as Source })}
        >
          {availableSources(tl.root).map((s) => (
            <option key={JSON.stringify(s)} value={JSON.stringify(s)}>
              {sourceLabel(s)}
            </option>
          ))}
        </select>
        <span className="spacer" />
        {Object.values(releases).filter((r) => r.state !== "archived").map((r) => (
          <label key={r.id} className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={visibleReleases.has(r.id)} onChange={() => { const s = new Set(visibleReleases); s.has(r.id) ? s.delete(r.id) : s.add(r.id); setVisibleReleases(s); }} />
            <span className="dot" style={{ background: r.color }} />
            {r.name}
            {r.state === "frozen" && " ❄"}
          </label>
        ))}
        <select className="input" value={activeRelease ?? ""} onChange={(e) => setActiveRelease(e.target.value || null)} aria-label="Release to edit">
          <option value="">Edit release…</option>
          {Object.values(releases).filter((r) => r.state === "draft").map((r) => (
            <option key={r.id} value={r.id}>
              Editing: {r.name}
            </option>
          ))}
        </select>
        <input type="date" className="input" value={alignDate} onChange={(e) => setAlignDate(e.target.value)} aria-label="Align to date" />
        <button className="btn sm" onClick={doAlign} title="Suggest latest reachable commit ≤ date (does not change pins)">
          Align to date
        </button>
        {suggest.size > 0 && activeRelease && (
          <button
            className="btn sm primary"
            onClick={() => {
              const rel = releases[activeRelease]!;
              for (const r of rows) {
                const c = suggest.get(r.entry.path);
                if (c) setPin(rel, r, c);
              }
              setSuggest(new Map());
            }}
          >
            Accept {suggest.size} suggestions
          </button>
        )}
        {parent && activeRelease && (
          <button className="btn sm" onClick={() => void propagateUp(releases[activeRelease]!)} title="Draft only">
            ⇡ Propagate proposal upward
          </button>
        )}
      </div>
      {warnings.map((w, i) => (
        <div key={i} className="banner warn small">
          ⚠ {w}
        </div>
      ))}
      <div
        ref={scrollRef}
        className="tl"
        style={{ overflow: "auto", flex: 1 }}
        onScroll={(e) => setScrollX((e.target as HTMLDivElement).scrollLeft)}
        onMouseLeave={() => setCrossX(null)}
      >
        <div className="tl-axis" style={{ width: LABEL_W + width }}>
          <div className="tl-label" style={{ height: 28 }}>
            <span className="faint small">submodule / pin</span>
          </div>
          <div className="tl-canvas" style={{ width, height: 28 }}>
            {tks.map((t, i) => (
              <span key={i} className="faint small" style={{ position: "absolute", left: t.x + 2, top: 6, whiteSpace: "nowrap" }}>
                {t.label}
              </span>
            ))}
          </div>
        </div>
        <div style={{ position: "relative", width: LABEL_W + width }} onMouseMove={(e) => {
          const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          const x = e.clientX - rect.left - LABEL_W;
          setCrossX(x >= 0 ? x : null);
        }}>
          {rows.map((r, ri) => (
            <TimelineRow
              key={r.entry.path}
              row={r}
              scale={scale}
              width={width}
              tl={tl}
              releases={visibleRels}
              pinFor={pinFor}
              activeRelease={activeRelease ? releases[activeRelease] ?? null : null}
              onSetPin={setPin}
              onClearPin={(rel) => remove("pins", pinKey({ releaseId: rel.id, parentRepo: tl.root, pathChain: [...tl.pathPrefix, r.entry.path] }))}
              suggestion={suggest.get(r.entry.path)}
              onHover={(c, x) => setHover(c ? { c, x, y: ri * ROW_H, row: r.entry.path } : null)}
              onOpenChild={() => onOpenChild(r)}
              highlighted={!!highlightChild && highlightChild.repo === r.childKey}
              onSelectPin={onSelectPin}
            />
          ))}
          {/* Release segmented lines + right-side anchors (§3.2) */}
          <svg style={{ position: "absolute", left: LABEL_W, top: 0, pointerEvents: "none" }} width={width} height={rows.length * ROW_H}>
            {visibleRels.map((rel) => {
              const pts = rows.map((r, i) => {
                const p = pinFor(rel.id, r.entry.path);
                const c = p?.committedAt ?? r.pinnedCommit?.committedAt;
                return c ? `${xOf(scale, c)},${i * ROW_H + ROW_H / 2}` : null;
              });
              const segs: string[][] = [[]];
              pts.forEach((p) => (p ? segs[segs.length - 1]!.push(p) : segs.push([])));
              return (
                <g key={rel.id}>
                  {segs.filter((s) => s.length > 1).map((s, i) => (
                    <polyline key={i} points={s.join(" ")} fill="none" stroke={rel.color} strokeWidth={2} strokeLinejoin="round" opacity={0.85} />
                  ))}
                </g>
              );
            })}
            {crossX !== null && <line x1={crossX} x2={crossX} y1={0} y2={rows.length * ROW_H} stroke="var(--text-3)" strokeDasharray="3 3" />}
          </svg>
          {visibleRels.map((rel, i) => (
            <div key={rel.id} style={{ position: "absolute", right: 4 + i * 18, top: -24, width: 14, height: 14, borderRadius: 3, background: rel.color }} title={`${rel.name} anchor`} />
          ))}
          {hover && (
            <div className="panel pad small" style={{ position: "absolute", left: LABEL_W + hover.x + 10, top: hover.y + ROW_H, zIndex: 10, maxWidth: 360, pointerEvents: "none" }}>
              <div className="mono">{hover.c.sha.slice(0, 12)}</div>
              <div>{hover.c.message.split("\n")[0]}</div>
              <div className="faint">
                {hover.c.author} · {new Date(hover.c.committedAt).toLocaleString()}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TimelineRow({
  row,
  scale,
  width,
  tl,
  releases,
  pinFor,
  activeRelease,
  onSetPin,
  onClearPin,
  suggestion,
  onHover,
  onOpenChild,
  highlighted,
  onSelectPin,
}: {
  row: SubmoduleRow;
  scale: TimeScale;
  width: number;
  tl: TimelineView;
  releases: Release[];
  pinFor: (relId: string, path: string) => ReleasePin | undefined;
  activeRelease: Release | null;
  onSetPin: (rel: Release, row: SubmoduleRow, c: CommitNode) => void;
  onClearPin: (rel: Release) => void;
  suggestion?: CommitNode;
  onHover: (c: CommitNode | null, x: number) => void;
  onOpenChild: () => void;
  highlighted: boolean;
  onSelectPin?: (repo: string, sha: string) => void;
}) {
  const hist = useMemo(() => [...(row.history ?? [])].sort((a, b) => a.committedAt.localeCompare(b.committedAt)), [row.history]);
  const onBranch = pinOnBranch(row);
  const canvasRef = useRef<HTMLDivElement>(null);

  const nearest = useCallback(
    (x: number): CommitNode | null => {
      let best: CommitNode | null = null;
      let bd = Infinity;
      for (const c of hist) {
        const d = Math.abs(xOf(scale, c.committedAt) - x);
        if (d < bd) {
          bd = d;
          best = c;
        }
      }
      return best;
    },
    [hist, scale],
  );

  const startDrag = (rel: Release) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = canvasRef.current!.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const c = nearest(ev.clientX - rect.left);
      if (c) onSetPin(rel, row, c);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const keyMove = (rel: Release, cur: string) => (e: React.KeyboardEvent) => {
    const i = hist.findIndex((c) => c.sha === cur);
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const j = Math.max(0, Math.min(hist.length - 1, (i < 0 ? hist.length - 1 : i) + (e.key === "ArrowRight" ? 1 : -1)));
      onSetPin(rel, row, hist[j]!);
    }
    if (e.key === "Delete" || e.key === "Backspace") onClearPin(rel);
  };

  return (
    <div className="tl-row" style={{ background: highlighted ? "var(--accent-2)" : undefined }}>
      <div className="tl-label" style={{ width: LABEL_W }}>
        <div className="row" style={{ gap: 4 }}>
          <b className="ellipsis grow mono small" title={row.entry.path}>
            {row.entry.path}
          </b>
          {row.childKey && (
            <button className="btn ghost sm" style={{ height: 18 }} onClick={onOpenChild} title="Open child timeline">
              ↳
            </button>
          )}
        </div>
        <div className="faint small ellipsis">
          {row.childKey ?? row.entry.url ?? "?"} · <span className="mono">{row.pinned?.slice(0, 8) ?? "—"}</span>
          {row.status === "unresolved" && <span className="chip warn" style={{ marginLeft: 4 }}>unresolved</span>}
          {row.status === "private-or-missing" && <span className="chip err" style={{ marginLeft: 4 }} title={row.error}>unavailable</span>}
          {onBranch === false && <span className="chip warn" style={{ marginLeft: 4 }} title={`Pinned commit is not on ${row.branch}`}>diverged</span>}
        </div>
      </div>
      <div ref={canvasRef} className="tl-canvas" style={{ width, height: ROW_H }} onDoubleClick={(e) => {
        if (!activeRelease) return;
        const rect = canvasRef.current!.getBoundingClientRect();
        const c = nearest(e.clientX - rect.left);
        if (c) onSetPin(activeRelease, row, c);
      }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: ROW_H / 2, height: 1, background: "var(--border)" }} />
        {row.status === "loading" && <span className="faint small" style={{ position: "absolute", left: 8, top: 10 }}>loading history…</span>}
        {row.error && row.status !== "ok" && <span className="faint small" style={{ position: "absolute", left: 8, top: 10 }}>{row.error}</span>}
        {hist.map((c) => {
          const x = xOf(scale, c.committedAt);
          const onBr = row.tip && row.index ? row.index.isAncestor(c.sha, row.tip.sha) : true;
          return (
            <div
              key={c.sha}
              onMouseEnter={() => onHover(c, x)}
              onMouseLeave={() => onHover(null, 0)}
              style={{ position: "absolute", left: x - 3, top: ROW_H / 2 - 3, width: 6, height: 6, borderRadius: "50%", background: onBr === false ? "transparent" : "var(--text-3)", border: onBr === false ? "1px solid var(--warn)" : undefined }}
            />
          );
        })}
        {row.tags?.filter((t) => row.index?.bySha.has(t.sha)).map((t) => (
          <span key={t.name} className="ref tag" style={{ position: "absolute", left: xOf(scale, row.index!.bySha.get(t.sha)!.committedAt) + 4, top: 1 }}>
            {t.name}
          </span>
        ))}
        {row.prs?.map((p) => {
          const onBranch = row.tip && row.index ? row.index.isAncestor(p.head.sha, row.tip.sha) : "unknown";
          return (
            <a
              key={p.key}
              href={`#/pr/${p.key.replace("#", "/").replace(/^([^/]+)\/([^/]+)\//, "$1/$2/")}`}
              className="ref"
              title={`${p.key} ${p.title}\nhead ${p.head.sha.slice(0, 8)} (${new Date(p.head.committedAt).toLocaleDateString()})${onBranch === false ? " — not on the tracked branch" : ""}`}
              style={{ position: "absolute", left: xOf(scale, p.head.committedAt) - 4, top: ROW_H - 15, zIndex: 2, background: "var(--info-bg)", border: `1px ${p.draft ? "dashed" : "solid"} var(--info)` }}
              onMouseEnter={() => onHover(p.head, xOf(scale, p.head.committedAt))}
              onMouseLeave={() => onHover(null, 0)}
            >
              PR #{p.number}
            </a>
          );
        })}
        {row.tip && <span className="ref" style={{ position: "absolute", left: xOf(scale, row.tip.committedAt) + 4, top: ROW_H - 16 }}>{row.branch}</span>}
        {row.pinnedCommit && (
          <div
            title={`Current gitlink ${row.pinned} (${new Date(row.pinnedCommit.committedAt).toLocaleDateString()})`}
            onClick={() => row.childKey && onSelectPin?.(row.childKey, row.pinned!)}
            onMouseEnter={() => onHover(row.pinnedCommit!, xOf(scale, row.pinnedCommit!.committedAt))}
            onMouseLeave={() => onHover(null, 0)}
            style={{ position: "absolute", left: xOf(scale, row.pinnedCommit.committedAt) - 7, top: ROW_H / 2 - 7, width: 14, height: 14, borderRadius: "50%", background: "var(--text)", border: "2px solid var(--panel)", cursor: "pointer", zIndex: 2 }}
          />
        )}
        {suggestion && <div title={`Align-to-date suggestion ${suggestion.sha.slice(0, 8)}`} style={{ position: "absolute", left: xOf(scale, suggestion.committedAt) - 6, top: ROW_H / 2 - 6, width: 12, height: 12, borderRadius: 2, border: "2px dashed var(--accent)", zIndex: 2 }} />}
        {releases.map((rel) => {
          const p = pinFor(rel.id, row.entry.path);
          const at = p?.committedAt ?? row.pinnedCommit?.committedAt;
          if (!at) return null;
          const editable = activeRelease?.id === rel.id && rel.state === "draft";
          return (
            <div
              key={rel.id}
              role="slider"
              tabIndex={editable ? 0 : -1}
              aria-label={`${rel.name} pin for ${row.entry.path}`}
              aria-valuetext={p?.sha ?? "not set (current gitlink)"}
              onPointerDown={editable ? startDrag(rel) : undefined}
              onKeyDown={editable ? keyMove(rel, p?.sha ?? row.pinned ?? "") : undefined}
              title={`${rel.name}: ${p ? p.sha.slice(0, 8) : "not set — follows current gitlink"}${editable ? " (drag or ←/→; Del clears)" : ""}`}
              style={{
                position: "absolute",
                left: xOf(scale, at) - 6,
                top: ROW_H / 2 - 12,
                width: 12,
                height: 24,
                borderRadius: 3,
                background: p ? rel.color : "transparent",
                border: `2px ${p ? "solid" : "dashed"} ${rel.color}`,
                cursor: editable ? "ew-resize" : "default",
                zIndex: 3,
                opacity: editable || p ? 1 : 0.6,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

