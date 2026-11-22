import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
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
import { loadRoot, rowsFor, loadRowHistory, rowPRs, usesGitTransport, pinOnBranch, gitlinksAt, type RootSnapshot, type SubmoduleRow } from "../lib/timeline";
import { describeError } from "../lib/github";
import { availableSources, childSource, sourceLabel, type Source } from "../lib/sources";
import { Modal } from "../components/ui";

export function TimelineWorkspace() {
  const { id } = useParams();
  const timelines = useApp((s) => s.timelines);
  const [params, setParams] = useSearchParams();
  const creating = params.has("new");
  const closeCreate = () => setParams({}, { replace: true });
  const nav = useNavigate();
  const tl = id ? timelines[id] : undefined;
  const [splitWith, setSplitWith] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>(tl?.zoom ?? "week");
  const [years, setYears] = useState(2);
  const historyStart = useMemo(() => {
    const start = new Date();
    start.setUTCFullYear(start.getUTCFullYear() - years);
    start.setUTCHours(0, 0, 0, 0);
    return +start;
  }, [years]);
  const [scrollDate, setScrollDate] = useState<number | null>(null);
  const [scales, setScales] = useState<Record<string, TimeScale>>({});
  const [focusChild, setFocusChild] = useState<{ repo: string; sha: string | null } | null>(null);

  useEffect(() => {
    setSplitWith(null);
    setYears(2);
    setScrollDate(null);
    setZoom(tl?.zoom ?? "week");
  }, [id]);

  if (!tl) {
    return (
      <div className="page">
        <h1 className="h1">Submodule Timelines</h1>
        <p className="muted">Track the commits and release pins of a root repository’s submodules.</p>
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
        {creating && <CreateTimeline onClose={closeCreate} />}
      </div>
    );
  }

  // Union scale so both panes share calendar alignment (§3.3).
  const union: TimeScale | null = (() => {
    const ss = [scales[tl.id], splitWith ? scales[splitWith] : undefined].filter((s): s is TimeScale => !!s);
    if (!ss.length) return null;
    return { start: Math.min(...ss.map((s) => s.start)), end: Math.max(...ss.map((s) => s.end)), pxPerDay: ss[0]!.pxPerDay };
  })();

  const children = Object.values(timelines).filter((t) => t.id !== tl.id);

  return (
    <div className="col" style={{ height: "100%", gap: 0 }}>
      <div className="col" style={{ flex: 1, minHeight: 0, gap: 0 }}>
        <div style={{ flex: 1, minHeight: 0, borderBottom: splitWith ? "2px solid var(--border-strong)" : undefined }}>
          <TimelinePane
            tl={tl}
            zoom={zoom}
            union={union}
            onScale={(s) => setScales((x) => (x[tl.id]?.start === s.start && x[tl.id]?.end === s.end && x[tl.id]?.pxPerDay === s.pxPerDay ? x : { ...x, [tl.id]: s }))}
            historyStart={historyStart}
            loadEarlier={() => { setScrollDate(historyStart); setYears((value) => value + 2); }}
            synchronize={!!splitWith}
            controls={<>
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
            </>}
            scrollDate={scrollDate}
            setScrollDate={setScrollDate}
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
              historyStart={historyStart}
              loadEarlier={() => { setScrollDate(historyStart); setYears((value) => value + 2); }}
              synchronize
              scrollDate={scrollDate}
              setScrollDate={setScrollDate}
              parent={tl}
              onSelectPin={(repo, sha) => setFocusChild({ repo, sha })}
              onOpenChild={() => undefined}
            />
          </div>
        )}
      </div>
      {creating && <CreateTimeline onClose={closeCreate} />}
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

const ROW_H = 52;
const LABEL_W = 310;

interface PaneProps {
  tl: TimelineView;
  zoom: Zoom;
  union: TimeScale | null;
  onScale: (s: TimeScale) => void;
  historyStart: number;
  loadEarlier: () => void;
  synchronize: boolean;
  controls?: React.ReactNode;
  scrollDate: number | null;
  setScrollDate: (date: number) => void;
  parent?: TimelineView;
  highlightChild?: { repo: string; sha: string | null } | null;
  onSelectPin?: (repo: string, sha: string) => void;
  onOpenChild: (row: SubmoduleRow) => void;
}

function TimelinePane({ tl, zoom, union, onScale, historyStart, loadEarlier, synchronize, controls, scrollDate, setScrollDate, parent, highlightChild, onSelectPin, onOpenChild }: PaneProps) {
  const [snap, setSnap] = useState<RootSnapshot | null>(null);
  const [rows, setRows] = useState<SubmoduleRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [alignDate, setAlignDate] = useState("");
  const [suggest, setSuggest] = useState<Map<string, CommitNode>>(new Map());
  const [popup, setPopup] = useState<CommitPopup | null>(null);
  const [windowLeft, setWindowLeft] = useState(0);
  const [windowTop, setWindowTop] = useState(0);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const publishScroll = useRef(0);
  const crosshair = useRef<SVGLineElement>(null);
  const source = tl.source?.kind === "github" ? { kind: "github" as const } : tl.source ?? { kind: "github" as const };
  const hideHover = () => setPopup((current) => current?.locked ? current : null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const releases = useApp((s) => s.releases);
  const pins = useApp((s) => s.pins);
  const put = useApp((s) => s.put);
  const remove = useApp((s) => s.remove);
  const [visibleReleases, setVisibleReleases] = useState<Set<string>>(() => new Set(Object.values(releases).filter((r) => r.state !== "archived").map((r) => r.id)));
  const [activeRelease, setActiveRelease] = useState<string | null>(Object.values(releases).find((r) => r.state === "draft")?.id ?? null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const programmaticScroll = useRef<number | null>(null);
  const manualDate = useRef<number | null>(null);
  const appliedDate = useRef<number | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const viewportWidth = viewport.width;

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    setSnap(null);
    setRows([]);
    setPopup(null);
    manualDate.current = null;
    appliedDate.current = null;
    void loadRoot(tl.root, tl.baseRef, tl.rootSha, source)
      .then((snapshot) => { if (!cancelled) setSnap(snapshot); })
      .catch((error) => { if (!cancelled) setErr(describeError(error)); });
    return () => { cancelled = true; cancelAnimationFrame(publishScroll.current); };
  }, [tl.root, tl.baseRef, tl.rootSha, JSON.stringify(source)]);

  useEffect(() => {
    if (!snap) return;
    let cancelled = false;
    const base = rowsFor(snap).filter((row) => !tl.visiblePaths || tl.visiblePaths.includes(row.entry.path));
    setRows((existing) => base.map((row) => existing.find((old) => old.entry.path === row.entry.path && old.pinned === row.pinned) ?? row));
    setLoadingHistory(true);
    let next = 0;
    const since = new Date(historyStart).toISOString().slice(0, 10);
    void Promise.all(Array.from({ length: 4 }, async () => {
      while (!cancelled && next < base.length) {
        const row = base[next++]!;
        if (row.status !== "loading") continue;
        const loaded = await loadRowHistory(row, { sinceDays: 730, since, rootRef: tl.baseRef }, source)
          .catch((error): SubmoduleRow => ({ ...row, status: "private-or-missing", error: describeError(error) }));
        if (cancelled) return;
        const prs = await rowPRs(loaded, Object.values(useApp.getState().prs), source.kind === "github" && !usesGitTransport(source)).catch(() => []);
        if (!cancelled) setRows((previous) => previous.map((item) => item.entry.path === loaded.entry.path ? { ...loaded, prs } : item));
      }
    })).finally(() => { if (!cancelled) setLoadingHistory(false); });
    return () => { cancelled = true; };
  }, [snap, historyStart, tl.visiblePaths]);

  const ownScale = useMemo(() => {
    const end = Math.max(
      Date.now(),
      snap ? Date.parse(snap.commit.committedAt) || 0 : 0,
      ...Object.values(pins).filter((pin) => pin.parentRepo === tl.root).map((pin) => Date.parse(pin.committedAt ?? "") || 0),
    );
    return { ...makeScale([end], zoom), start: historyStart };
  }, [historyStart, snap, zoom, pins, tl.root]);
  useEffect(() => onScale(ownScale), [ownScale]);
  const scale = union ? { ...union, pxPerDay: ownScale.pxPerDay } : ownScale;
  const width = Math.max(scaleWidth(scale), viewportWidth - LABEL_W);
  const windowStart = Math.max(0, windowLeft - 384);
  const windowEnd = windowLeft + viewportWidth + 384;
  const firstRow = Math.max(0, Math.floor((windowTop - 4 * ROW_H - 42) / ROW_H));
  const lastRow = Math.ceil((windowTop + viewport.height + 6 * ROW_H) / ROW_H);
  const tks = useMemo(() => ticks(scale, zoom), [scale.start, scale.end, scale.pxPerDay, zoom]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [snap]);

  // Keep the calendar date at the left edge as additional history loads or zoom changes.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = Math.max(0, el.scrollWidth - el.clientWidth);
    const externalJump = scrollDate !== appliedDate.current;
    const date = externalJump ? scrollDate : manualDate.current ?? scrollDate;
    appliedDate.current = scrollDate;
    const offset = date === null ? max : Math.min(max, Math.max(0, xOf(scale, date)));
    if (Math.abs(el.scrollLeft - offset) > 1) {
      el.scrollLeft = offset;
      programmaticScroll.current = el.scrollLeft;
      if (date !== null) manualDate.current = scale.start + el.scrollLeft / scale.pxPerDay * 864e5;
      setWindowLeft(Math.floor(el.scrollLeft / 192) * 192);
    }
  }, [scrollDate, scale.start, scale.pxPerDay, width, snap, viewportWidth]);

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
    const iso = alignDate ? new Date(alignDate + "T23:59:59Z").toISOString() : new Date().toISOString();
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
        <h1 className="toolbar-title tl-heading" title={snap.commit.message}>
          {tl.root}@{tl.baseRef} <span className="mono faint">@{snap.commit.sha.slice(0, 8)} · {new Date(snap.commit.committedAt).toLocaleDateString()} · {rows.length} submodules</span>
        </h1>
        {controls}
        <select
          className="input"
          aria-label="Data source"
          value={JSON.stringify(source)}
          onChange={(e) => useApp.getState().patch("timelines", tl.id, { source: JSON.parse(e.target.value) as Source })}
        >
          {availableSources(tl.root).map((s) => (
            <option key={JSON.stringify(s)} value={JSON.stringify(s)}>
              {s.kind === "github" ? "GitHub" : sourceLabel(s)}
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
        <div className="tl-date">
          <label className="row small">Date <input type="date" className="input" value={alignDate} onChange={(e) => setAlignDate(e.target.value)} aria-label="Timeline date" min={new Date(historyStart).toISOString().slice(0, 10)} max={new Date(scale.end).toISOString().slice(0, 10)} /></label>
          <button className="btn" disabled={!alignDate} title="Go to selected date" aria-label="Go to selected date" onClick={() => {
            const time = Date.parse(alignDate);
            if (Number.isFinite(time)) setScrollDate(time - Math.max(0, viewportWidth - LABEL_W) / 2 / scale.pxPerDay * 864e5);
          }}>→</button>
        </div>
        <button className="btn sm" onClick={doAlign} title="Suggest the latest commit at or before the selected date">Latest</button>
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
        onClick={(e) => { if (e.target instanceof Element && !e.target.closest(".tl-commit, .tl-pin-marker, .tl-pr-marker")) setPopup(null); }}
        onScroll={(e) => {
          const el = e.currentTarget;
          const left = Math.max(0, el.scrollLeft);
          setWindowLeft(Math.floor(left / 192) * 192);
          setWindowTop(Math.floor(el.scrollTop / (ROW_H * 3)) * ROW_H * 3);
          const ignored = programmaticScroll.current;
          programmaticScroll.current = null;
          if (ignored !== null && Math.abs(left - ignored) <= 1) return;
          const date = scale.start + left / scale.pxPerDay * 864e5;
          manualDate.current = date;
          if (!synchronize) return;
          cancelAnimationFrame(publishScroll.current);
          publishScroll.current = requestAnimationFrame(() => setScrollDate(date));
        }}
        onMouseLeave={() => { crosshair.current?.setAttribute("visibility", "hidden"); hideHover(); }}
      >
        <div className="tl-axis" style={{ width: LABEL_W + width }}>
          <div className="tl-label" style={{ height: 42, width: LABEL_W }}>
            <span className="faint small">submodule / pin</span>
          </div>
          <div className="tl-canvas" style={{ width, height: 42 }}>
            {snap && <span className="tl-baseline" style={{ left: xOf(scale, snap.commit.committedAt) }}
              title={`${tl.root}@${tl.baseRef} · ${snap.commit.sha.slice(0, 8)}`}>{tl.root.split("/").at(-1)}@{tl.baseRef}</span>}
            {windowStart === 0 && <button className="btn sm tl-load-earlier" disabled={loadingHistory} onClick={loadEarlier}>
              {loadingHistory ? "Loading history…" : "← Load earlier history"}
            </button>}
            {tks.filter((tick) => tick.x >= windowStart && tick.x <= windowEnd).map((t, i) => (
              <span key={i} className="faint small" style={{ position: "absolute", left: t.x + 2, top: 23, whiteSpace: "nowrap" }}>
                {t.label}
              </span>
            ))}
          </div>
        </div>
        <div className="tl-track" style={{ position: "relative", width: LABEL_W + width, height: rows.length * ROW_H }} onMouseMove={(e) => {
          const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          const x = e.clientX - rect.left - LABEL_W;
          const overLabel = e.target instanceof Element && e.target.closest(".tl-label");
          const line = crosshair.current;
          if (line) {
            line.setAttribute("visibility", !overLabel && x >= 0 && x <= width ? "visible" : "hidden");
            line.setAttribute("x1", String(x));
            line.setAttribute("x2", String(x));
          }
        }}>
          {rows.slice(firstRow, lastRow).map((r, index) => (
            <div key={r.entry.path} style={{ position: "absolute", width: "100%", top: (firstRow + index) * ROW_H }}>
            <TimelineRow
              row={r}
              scale={scale}
              width={width}
              windowStart={windowStart}
              windowEnd={windowEnd}
              rootSha={snap.commit.sha}
              tl={tl}
              releases={visibleRels}
              pinFor={pinFor}
              activeRelease={activeRelease ? releases[activeRelease] ?? null : null}
              onSetPin={setPin}
              onClearPin={(rel) => remove("pins", pinKey({ releaseId: rel.id, parentRepo: tl.root, pathChain: [...tl.pathPrefix, r.entry.path] }))}
              suggestion={suggest.get(r.entry.path)}
              showPopup={(commit, target, locked, pr) => {
                const bounds = target.getBoundingClientRect();
                setPopup((current) => current?.locked && !locked ? current : { commit, repo: r.childKey, pr, locked, x: bounds.left, y: bounds.bottom });
              }}
              hideHover={hideHover}
              onOpenChild={() => onOpenChild(r)}
              highlighted={!!highlightChild && highlightChild.repo === r.childKey}
              onSelectPin={onSelectPin}
            />
            </div>
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
            {snap && <line x1={xOf(scale, snap.commit.committedAt)} x2={xOf(scale, snap.commit.committedAt)}
              y1={0} y2={rows.length * ROW_H} stroke="var(--info)" strokeDasharray="5 4" opacity={0.8} />}
            <line ref={crosshair} visibility="hidden" y1={0} y2={rows.length * ROW_H} stroke="var(--text-3)" strokeDasharray="3 3" />
          </svg>
          {visibleRels.map((rel, i) => (
            <div key={rel.id} style={{ position: "absolute", right: 4 + i * 18, top: -24, width: 14, height: 14, borderRadius: 3, background: rel.color }} title={`${rel.name} anchor`} />
          ))}
        </div>
      </div>
      {popup && <div className={`panel pad small tl-popup ${popup.locked ? "locked" : ""}`}
        style={{ left: Math.max(4, Math.min(popup.x, window.innerWidth - 325)), top: Math.max(4, Math.min(popup.y + 8, window.innerHeight - 130)) }}
        role={popup.locked ? "dialog" : undefined} aria-label="Commit details">
        <div className="row">
          {popup.repo ? <a className="mono" href={`https://github.com/${popup.repo}/commit/${popup.commit.sha}`} target="_blank" rel="noreferrer">#{popup.commit.sha.slice(0, 8)}</a> : <span className="mono">{popup.commit.sha.slice(0, 8)}</span>}
          {popup.pr && popup.repo && <a href={`https://github.com/${popup.repo}/pull/${popup.pr}`} target="_blank" rel="noreferrer">PR #{popup.pr}</a>}
          {popup.locked && <button className="btn ghost sm tl-popup-close" aria-label="Close commit details" onClick={() => setPopup(null)}>✕</button>}
        </div>
        <div>{popup.commit.message.split("\n")[0]}</div>
        <div className="faint">{popup.commit.author} · {new Date(popup.commit.committedAt).toLocaleString()}</div>
      </div>}

    </div>
  );
}

function lowerBound(points: { x: number }[], x: number): number {
  let first = 0;
  let last = points.length;
  while (first < last) {
    const middle = Math.floor((first + last) / 2);
    if (points[middle]!.x < x) first = middle + 1;
    else last = middle;
  }
  return first;
}

type CommitPopup = { commit: CommitNode; repo: string | null; pr?: number; locked: boolean; x: number; y: number };

function TimelineRow({
  row,
  scale,
  width,
  windowStart,
  windowEnd,
  rootSha,
  tl,
  releases,
  pinFor,
  activeRelease,
  onSetPin,
  onClearPin,
  suggestion,
  showPopup,
  hideHover,
  onOpenChild,
  highlighted,
  onSelectPin,
}: {
  row: SubmoduleRow;
  scale: TimeScale;
  width: number;
  windowStart: number;
  windowEnd: number;
  rootSha: string;
  tl: TimelineView;
  releases: Release[];
  pinFor: (relId: string, path: string) => ReleasePin | undefined;
  activeRelease: Release | null;
  onSetPin: (rel: Release, row: SubmoduleRow, c: CommitNode) => void;
  onClearPin: (rel: Release) => void;
  suggestion?: CommitNode;
  showPopup: (commit: CommitNode, target: HTMLElement, locked: boolean, pr?: number) => void;
  hideHover: () => void;
  onOpenChild: () => void;
  highlighted: boolean;
  onSelectPin?: (repo: string, sha: string) => void;
}) {
  const hist = useMemo(() => [...(row.history ?? [])].filter((commit) => Number.isFinite(Date.parse(commit.committedAt))).sort((a, b) => Date.parse(a.committedAt) - Date.parse(b.committedAt)), [row.history]);
  const onBranch = useMemo(() => pinOnBranch(row), [row]);
  const start = scale.start;
  const pxPerDay = scale.pxPerDay;
  const plotted = useMemo(() => hist.map((commit) => ({ commit, x: (Date.parse(commit.committedAt) - start) / 864e5 * pxPerDay })), [hist, start, pxPerDay]);
  const from = lowerBound(plotted, windowStart);
  const to = lowerBound(plotted, windowEnd);
  const branchCommits = useMemo(() => new Set(row.tip ? row.index?.reachable(row.tip.sha, row.index.bySha.size).map((commit) => commit.sha) : []), [row.index, row.tip]);
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
    <div className="tl-row" style={{ height: ROW_H, background: highlighted ? "var(--accent-2)" : undefined }}>
      <div className="tl-label" style={{ width: LABEL_W }}>
        <div className="row" style={{ gap: 4 }}>
          <a className="tl-path ellipsis grow mono small" title={row.entry.path} href={`https://github.com/${tl.root}/tree/${rootSha}/${row.entry.path.split("/").map(encodeURIComponent).join("/")}`} target="_blank" rel="noreferrer">
            {row.entry.path}
          </a>
          {row.childKey && (
            <button className="btn ghost sm" style={{ height: 18 }} onClick={onOpenChild} title="Open child timeline">
              ↳
            </button>
          )}
        </div>
        <div className="tl-meta faint small">
          {row.childKey ? <a className="ellipsis" title={row.childKey} href={`https://github.com/${row.childKey}`} target="_blank" rel="noreferrer">{row.childKey}</a> : <span className="ellipsis">{row.entry.url || "?"}</span>}
          {row.childKey && row.pinned ? <a className="mono" href={`https://github.com/${row.childKey}/commit/${row.pinned}`} target="_blank" rel="noreferrer">{row.pinned.slice(0, 8)}</a> : <span className="mono">{row.pinned?.slice(0, 8) ?? "—"}</span>}
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
        {plotted.slice(from, to).map(({ commit, x }) => {
          const onBr = !row.tip || branchCommits.has(commit.sha);
          const pr = row.prs?.find((item) => item.head.sha === commit.sha)?.number;
          return <button key={commit.sha} className={`tl-commit ${onBr ? "" : "off-branch"}`} style={{ left: x }}
            aria-label={`Commit ${commit.sha.slice(0, 8)}`}
            onMouseEnter={(e) => showPopup(commit, e.currentTarget, false, pr)} onMouseLeave={hideHover}
            onClick={(e) => showPopup(commit, e.currentTarget, true, pr)}
          />;
        })}
        {row.tags?.filter((t) => row.index?.bySha.has(t.sha)).map((t) => (
          <span key={t.name} className="ref tag" style={{ position: "absolute", left: xOf(scale, row.index!.bySha.get(t.sha)!.committedAt) + 4, top: 1 }}>
            {t.name}
          </span>
        ))}
        {row.prs?.map((p) => {
          const onBranch = !row.tip || branchCommits.has(p.head.sha);
          return (
            <button
              key={p.key}
              className="ref tl-pr-marker"
              title={`${p.key} ${p.title}\nhead ${p.head.sha.slice(0, 8)} (${new Date(p.head.committedAt).toLocaleDateString()})${onBranch === false ? " — not on the tracked branch" : ""}`}
              style={{ position: "absolute", left: xOf(scale, p.head.committedAt) - 4, top: ROW_H - 15, zIndex: 2, background: "var(--info-bg)", border: `1px ${p.draft ? "dashed" : "solid"} var(--info)` }}
              onMouseEnter={(e) => showPopup(p.head, e.currentTarget, false, p.number)}
              onClick={(e) => showPopup(p.head, e.currentTarget, true, p.number)}
              onMouseLeave={hideHover}
            >
              PR #{p.number}
</button>
          );
        })}
        {row.tip && <span className="ref" style={{ position: "absolute", left: xOf(scale, row.tip.committedAt) + 4, top: ROW_H - 16 }}>{row.branch}</span>}
        {row.pinnedCommit && (
          <button
            type="button"
            aria-label={`Pinned commit ${row.pinned?.slice(0, 8)}`}
            title={`${tl.root}@${tl.baseRef} pins ${row.pinned} (${new Date(row.pinnedCommit.committedAt).toLocaleDateString()})`}
            onClick={(e) => {
              showPopup(row.pinnedCommit!, e.currentTarget, true);
              if (row.childKey && row.pinned) onSelectPin?.(row.childKey, row.pinned);
            }}
            onMouseEnter={(e) => showPopup(row.pinnedCommit!, e.currentTarget, false)}
            onMouseLeave={hideHover}
            className="tl-pin-marker"
            style={{ left: xOf(scale, row.pinnedCommit.committedAt) }}
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

