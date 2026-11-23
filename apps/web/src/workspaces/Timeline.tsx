import { copyText } from "../lib/clipboard";
import { NavIcon } from "../components/NavIcon";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  checkNestedConsistency,
  makeScale,
  newId,
  PX_PER_DAY,
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
import { childSource } from "../lib/sources";
import { Modal, Split } from "../components/ui";

export function TimelineWorkspace() {
  const { id } = useParams();
  const timelines = useApp((s) => s.timelines);
  const [params, setParams] = useSearchParams();
  const creating = params.has("new");
  const closeCreate = () => setParams({}, { replace: true });
  const nav = useNavigate();
  const tl = id ? timelines[id] : undefined;
  const [splitWith, setSplitWith] = useState<string | null>(null);
  const [pxPerDay, setPxPerDay] = useState(() => timelineZoom(tl));
  const lastZoom = useRef(pxPerDay);
  const zoom = nearestZoom(pxPerDay);
  const [years, setYears] = useState(2);
  const historyStart = useMemo(() => {
    const start = new Date();
    start.setUTCFullYear(start.getUTCFullYear() - years);
    start.setUTCHours(0, 0, 0, 0);
    return +start;
  }, [years]);
  const [scrollDate, setScrollDate] = useState<number | null>(null);
  const jumpDate = (date: number) => setScrollDate((previous) => previous === date ? date + 1 : date);
  const activePane = useRef<string | null>(null);
  const zoomPreviews = useRef(new Set<(zoom: number, date: number) => void>());
  const endZoomGesture = useRef<(() => void) | null>(null);
  const [scales, setScales] = useState<Record<string, TimeScale>>({});
  const [removing, setRemoving] = useState<TimelineView | null>(null);
  const [focusChild, setFocusChild] = useState<{ repo: string; sha: string | null } | null>(null);

  useEffect(() => {
    setSplitWith(null);
    setYears(2);
    setScrollDate(null);
    lastZoom.current = timelineZoom(tl);
    setPxPerDay(lastZoom.current);
  }, [id]);

  useEffect(() => {
    if (!tl) return;
    const clear = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector(".overlay:not([inert]), #workspace-content[inert]")) {
        setFocusChild(null);
      }
    };
    window.addEventListener("keydown", clear);
    return () => window.removeEventListener("keydown", clear);
  }, [tl?.id]);

  const removeTimeline = (view: TimelineView) => {
    const state = useApp.getState();
    for (const child of Object.values(state.timelines)) {
      if (child.parentTimelineId === view.id) state.patch("timelines", child.id, { parentTimelineId: null });
    }
    state.remove("timelines", view.id);
    const layout = state.settings_().layout;
    if (Array.isArray(layout.sidebarPins) && layout.sidebarPins.includes(`/timeline/${view.id}`)) {
      state.setSettings({ layout: { ...layout, sidebarPins: layout.sidebarPins.filter((path) => path !== `/timeline/${view.id}`) } });
    }
    setRemoving(null);
  };

  if (!tl) {
    return (
      <div className="page">
        <h1 className="h1">Submodule Timelines</h1>
        <p className="muted">Track the commits and release pins of a root repository’s submodules.</p>
        <div className="panel">
          {Object.values(timelines).map((t) => (
            <div key={t.id} className="list-row">
              <Link className="grow" to={`/timeline/${t.id}`}><b>{t.name}</b></Link>
              <span className="faint small">
                {t.root}@{t.baseRef}
              </span>
              <button type="button" className="btn ghost sm" title="Remove timeline view" aria-label={`Remove timeline ${t.name}`} onClick={() => setRemoving(t)}><NavIcon name="close" /></button>
            </div>
          ))}
          {!Object.keys(timelines).length && <div className="empty">No timelines yet.</div>}
        </div>
        {creating && <CreateTimeline onClose={closeCreate} />}
        {removing && <Modal title="Remove timeline view" onClose={() => setRemoving(null)}
          footer={<button type="button" className="btn danger" onClick={() => removeTimeline(removing)}>Remove view</button>}>
          <p>Remove <b>{removing.name}</b> from your timelines?</p>
        </Modal>}
      </div>
    );
  }

  // Union scale so both panes share calendar alignment (§3.3).
  const union: TimeScale | null = (() => {
    const ss = [scales[tl.id], splitWith ? scales[splitWith] : undefined].filter((s): s is TimeScale => !!s);
    if (!ss.length) return null;
    return { start: Math.min(...ss.map((s) => s.start)), end: Math.max(...ss.map((s) => s.end)), pxPerDay: ss[0]!.pxPerDay };
  })();

  const fitMarkers = (oldest: number, requested = false) => {
    const required = Math.ceil((Date.now() - oldest + 30 * 864e5) / (365.2425 * 864e5));
    setYears((previous) => Math.max(previous, requested ? required : Math.min(6, required)));
  };
  const openChild = (root: TimelineView, row: SubmoduleRow, openInSplit: boolean) => {
    if (!row.childKey) return;
    let child = Object.values(timelines).find((timeline) => timeline.root === row.childKey);
    if (!child) {
      child = {
        id: newId("tl"), name: `${row.entry.path} (${row.childKey})`, root: row.childKey, baseRef: row.branch ?? "HEAD",
        rootSha: null, visiblePaths: null, zoom, zoomScale: pxPerDay, parentTimelineId: root.id,
        pathPrefix: [...root.pathPrefix, row.entry.path], createdAt: Date.now(),
        source: root.source && root.source.kind !== "github" && root.source.kind !== "mirror"
          ? childSource(root.source, row.entry.path, row.childKey) : undefined,
      };
      useApp.getState().put("timelines", child.id, child);
    }
    if (openInSplit) setSplitWith(child.id);
    else nav(`/timeline/${child.id}`);
  };

  const children = Object.values(timelines).filter((t) => t.id !== tl.id);
  const changeZoom = (next: number, date: number) => {
    jumpDate(date);
    lastZoom.current = next;
    setPxPerDay(next);
  };
  const previewZoom = (next: number, date: number) => {
    lastZoom.current = next;
    zoomPreviews.current.forEach((render) => render(next, date));
  };
  const saveZoom = (next: number) => {
    const current = useApp.getState().timelines[tl.id];
    if (!current || next !== lastZoom.current || timelineZoom(current) === next) return;
    const preset = nearestZoom(next);
    useApp.getState().patch("timelines", tl.id, { zoom: preset, zoomScale: next });
  };

  return (
    <div className="col" style={{ height: "100%", gap: 0 }}>
      <div className="timeline-split-wrap">
      <Split id="timelines" vertical initial={0.5} showSecond={!!splitWith && !!timelines[splitWith]}>
          <TimelinePane
            tl={tl}
            zoom={zoom}
            pxPerDay={pxPerDay}
            onZoom={changeZoom}
            onZoomPreview={previewZoom}
            zoomPreviews={zoomPreviews}
            endZoomGesture={endZoomGesture}
            saveZoom={saveZoom}
            activePane={activePane}
            union={union}
            onScale={(s) => setScales((x) => (x[tl.id]?.start === s.start && x[tl.id]?.end === s.end && x[tl.id]?.pxPerDay === s.pxPerDay ? x : { ...x, [tl.id]: s }))}
            historyStart={historyStart}
            fitMarkers={fitMarkers}
            loadEarlier={() => { setScrollDate(historyStart); setYears((value) => value + 2); }}
            synchronize={!!splitWith}
            controls={<>
        <label className="small row">
          Zoom
          <select className="input" aria-label="Timeline zoom" value={PX_PER_DAY[zoom] === pxPerDay ? zoom : "custom"} onChange={(e) => {
            const next = PX_PER_DAY[e.target.value as Zoom];
            endZoomGesture.current?.();
            lastZoom.current = next;
            setPxPerDay(next);
            saveZoom(next);
          }}>
            {PX_PER_DAY[zoom] !== pxPerDay && <option value="custom" disabled>Custom ({Math.round(pxPerDay / PX_PER_DAY.week * 100)}%)</option>}
            <option value="day">Day</option>
            <option value="week">Week</option>
            <option value="month">Month</option>
            <option value="year">Year</option>
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
            setScrollDate={jumpDate}
            highlightChild={focusChild}
            onOpenChild={(row) => openChild(tl, row, true)}
          />
        {splitWith && timelines[splitWith] && (
            <TimelinePane
              tl={timelines[splitWith]!}
              zoom={zoom}
              pxPerDay={pxPerDay}
              onZoom={changeZoom}
              onZoomPreview={previewZoom}
              zoomPreviews={zoomPreviews}
              endZoomGesture={endZoomGesture}
              saveZoom={saveZoom}
              activePane={activePane}
              union={union}
              onScale={(s) => setScales((x) => (x[splitWith]?.start === s.start && x[splitWith]?.end === s.end && x[splitWith]?.pxPerDay === s.pxPerDay ? x : { ...x, [splitWith]: s }))}
              historyStart={historyStart}
              fitMarkers={fitMarkers}
              loadEarlier={() => { setScrollDate(historyStart); setYears((value) => value + 2); }}
              synchronize
              scrollDate={scrollDate}
              setScrollDate={jumpDate}
              parent={tl}
              onSelectPin={(repo, sha) => setFocusChild({ repo, sha })}
              onOpenChild={(row) => openChild(timelines[splitWith]!, row, false)}
            />
        )}
      </Split>
      </div>
      {creating && <CreateTimeline onClose={closeCreate} />}
    </div>
  );
}

function CreateTimeline({ onClose }: { onClose: () => void }) {
  const [root, setRoot] = useState("");
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
          <input className="input" value={root} onChange={(e) => setRoot(e.target.value)} placeholder="owner/repo" />
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
const AXIS_H = 42;
const DOT_TILE_WIDTH = 512;
const ZOOM_LEVELS: readonly Zoom[] = ["day", "week", "month", "year"];
const MS_PER_DAY = 864e5;

const clampZoom = (value: number) => Math.max(PX_PER_DAY.year, Math.min(PX_PER_DAY.day, value));
const timelineZoom = (view?: TimelineView) => typeof view?.zoomScale === "number" && Number.isFinite(view.zoomScale)
  ? clampZoom(view.zoomScale) : PX_PER_DAY[view?.zoom ?? "week"] ?? PX_PER_DAY.week;
const nearestZoom = (value: number) => ZOOM_LEVELS.find((zoom, index) => {
  const next = ZOOM_LEVELS[index + 1];
  return !next || value >= Math.sqrt(PX_PER_DAY[zoom] * PX_PER_DAY[next]);
}) ?? "year";

interface PaneProps {
  tl: TimelineView;
  zoom: Zoom;
  pxPerDay: number;
  onZoom: (zoom: number, date: number) => void;
  onZoomPreview: (zoom: number, date: number) => void;
  zoomPreviews: React.RefObject<Set<(zoom: number, date: number) => void>>;
  endZoomGesture: React.RefObject<(() => void) | null>;
  saveZoom: (zoom: number) => void;
  activePane: React.RefObject<string | null>;
  union: TimeScale | null;
  onScale: (s: TimeScale) => void;
  historyStart: number;
  fitMarkers: (oldest: number, requested?: boolean) => void;
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

function TimelinePane({ tl, zoom, pxPerDay, onZoom, onZoomPreview, zoomPreviews, endZoomGesture, saveZoom, activePane, union, onScale, historyStart, fitMarkers, loadEarlier, synchronize, controls, scrollDate, setScrollDate, parent, highlightChild, onSelectPin, onOpenChild }: PaneProps) {
  const [snap, setSnap] = useState<RootSnapshot | null>(null);
  const [jumpingToTip, setJumpingToTip] = useState(false);
  const latestRequest = useRef<Promise<RootSnapshot> | null>(null);
  const followSnapshot = useRef<RootSnapshot | null>(null);
  const [rows, setRows] = useState<SubmoduleRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [alignDate, setAlignDate] = useState("");
  const [query, setQuery] = useState("");
  const [highlightedRow, setHighlightedRow] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<Map<string, CommitNode>>(new Map());
  const [popup, setPopup] = useState<CommitPopup | null>(null);
  const [windowLeft, setWindowLeft] = useState(0);
  const [windowScale, setWindowScale] = useState(pxPerDay);
  const [visibleWindow] = useState(createVisibleWindow);
  const [windowTop, setWindowTop] = useState(0);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const publishScroll = useRef(0);
  useEffect(() => {
    const clear = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !document.querySelector(".overlay:not([inert]), #workspace-content[inert]")) {
        setHighlightedRow(null);
      }
    };
    window.addEventListener("keydown", clear);
    return () => window.removeEventListener("keydown", clear);
  }, []);
  const crosshair = useRef<HTMLDivElement>(null);
  const source = !tl.source || tl.source.kind === "github" || tl.source.kind === "mirror" ? { kind: "github" as const } : tl.source;
  const timelines = useApp((state) => state.timelines);
  const theme = useApp((state) => state.settings_().theme);
  const childRoots = useMemo(() => new Set(Object.values(timelines).map((timeline) => timeline.root)), [timelines]);
  const filteredRows = useMemo(() => {
    const words = query.toLowerCase().trim().split(/\s+/);
    return rows.filter((row) => words.every((word) => `${row.entry.path} ${row.childKey ?? ""} ${row.pinned ?? ""}`.toLowerCase().includes(word)));
  }, [rows, query]);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideHover = () => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setPopup((current) => current?.locked ? current : null), 240);
  };
  useEffect(() => () => clearTimeout(hideTimer.current), []);
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
    setJumpingToTip(false);
    setSnap(null);
    setRows([]);
    setQuery("");
    setHighlightedRow(null);
    setPopup(null);
    manualDate.current = null;
    appliedDate.current = null;
    const followed = followSnapshot.current;
    followSnapshot.current = null;
    if (followed && !tl.rootSha && followed.root === tl.root && followed.ref === tl.baseRef) setSnap(followed);
    else {
      void loadRoot(tl.root, tl.baseRef, tl.rootSha, source)
        .then((snapshot) => { if (!cancelled) setSnap(snapshot); })
        .catch((error) => { if (!cancelled) setErr(describeError(error)); });
    }
    return () => {
      cancelled = true;
      latestRequest.current = null;
      cancelAnimationFrame(publishScroll.current);
      publishScroll.current = 0;
    };
  }, [tl.root, tl.baseRef, tl.rootSha, JSON.stringify(source)]);

  useEffect(() => {
    if (!snap) return;
    let cancelled = false;
    const base = rowsFor(snap).filter((row) => !tl.visiblePaths || tl.visiblePaths.includes(row.entry.path));
    setRows((existing) => base.map((row) => existing.find((old) => old.entry.path === row.entry.path && old.pinned === row.pinned) ?? row));
    setLoadingHistory(true);
    let next = 0;
    let frame = 0;
    const pending = new Map<string, SubmoduleRow>();
    const flush = () => {
      frame = 0;
      if (cancelled || !pending.size) return;
      const loaded = new Map(pending);
      pending.clear();
      setRows((previous) => previous.map((item) => loaded.get(item.entry.path) ?? item));
    };
    const since = new Date(historyStart).toISOString().slice(0, 10);
    void Promise.all(Array.from({ length: 4 }, async () => {
      while (!cancelled && next < base.length) {
        const row = base[next++]!;
        if (row.status !== "loading") continue;
        const loaded = await loadRowHistory(row, { sinceDays: 730, since, rootRef: tl.baseRef }, source)
          .catch((error): SubmoduleRow => ({ ...row, status: "private-or-missing", error: describeError(error) }));
        if (cancelled) return;
        const prs = await rowPRs(loaded, Object.values(useApp.getState().prs), source.kind === "github" && !usesGitTransport(source)).catch(() => []);
        if (!cancelled) {
          pending.set(loaded.entry.path, { ...loaded, prs });
          if (!frame) frame = requestAnimationFrame(flush);
        }
      }
    })).finally(() => {
      cancelAnimationFrame(frame);
      flush();
      if (!cancelled) setLoadingHistory(false);
    });
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [snap, historyStart, tl.visiblePaths]);

  useEffect(() => {
    if (!snap || !rows.length || loadingHistory) return;
    const dates = [
      snap.commit.committedAt,
      ...rows.map((row) => row.pinnedCommit?.committedAt),
      ...Object.values(pins).filter((pin) => pin.parentRepo === tl.root).map((pin) => pin.committedAt),
    ].flatMap((date) => date && Number.isFinite(Date.parse(date)) ? [Date.parse(date)] : []);
    if (dates.length) fitMarkers(Math.min(...dates));
  }, [snap, rows, loadingHistory, pins, tl.root]);

  const ownScale = useMemo(() => {
    const end = Math.max(
      Date.now(),
      snap ? Date.parse(snap.commit.committedAt) || 0 : 0,
      ...Object.values(pins).filter((pin) => pin.parentRepo === tl.root).map((pin) => Date.parse(pin.committedAt ?? "") || 0),
    );
    return { ...makeScale([end], "week"), start: historyStart };
  }, [historyStart, snap, pins, tl.root]);
  useEffect(() => onScale(ownScale), [ownScale]);
  const scale = { ...(union ?? ownScale), pxPerDay };
  const rightPadding = Math.round(Math.max(0, viewportWidth - LABEL_W) / 2);
  const width = Math.max(scaleWidth(scale) + rightPadding, viewportWidth - LABEL_W);
  if (windowScale !== pxPerDay) {
    // Update the render window before laying out the new scale. Painting the
    // old horizontal window first would rasterize tiles the user cannot see.
    const date = scrollDate !== appliedDate.current ? scrollDate : manualDate.current ?? scrollDate;
    const max = Math.max(0, Math.round(LABEL_W + width) - viewportWidth);
    const left = date === null ? Math.max(0, max - rightPadding) : Math.max(0, Math.min(max, xOf(scale, date)));
    setWindowScale(pxPerDay);
    setWindowLeft(Math.floor(left / 256) * 256);
  }
  const plotWidth = Math.max(0, viewportWidth - LABEL_W);
  // Cover the extra date range revealed by the compositor between rerenders.
  const overscan = Math.max(384, Math.ceil(plotWidth * 0.62));
  const windowStart = Math.max(0, windowLeft - overscan);
  const windowEnd = windowLeft + plotWidth + overscan + 256;
  const firstRow = Math.max(0, Math.floor((windowTop - 4 * ROW_H - AXIS_H) / ROW_H));
  const lastRow = Math.ceil((windowTop + viewport.height + 6 * ROW_H) / ROW_H);
  const axisScale = PX_PER_DAY[zoom];
  const axisRatio = pxPerDay / axisScale;
  const tks = useMemo(() => ticks({ ...scale, pxPerDay: axisScale }, zoom), [scale.start, scale.end, axisScale, zoom]);
  const minorScale = pxPerDay >= 4 ? 4 : pxPerDay * 7 >= 4 ? 1 : 0;
  const minor = useMemo(() => minorTicks({ ...scale, pxPerDay: minorScale }), [scale.start, scale.end, minorScale]);
  const minorRatio = minorScale ? pxPerDay / minorScale : 1;

  const zoomInput = useRef({ scale, onZoom, onZoomPreview, saveZoom });
  useLayoutEffect(() => { zoomInput.current = { scale, onZoom, onZoomPreview, saveZoom }; });
  const ready = !!snap;
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    let frame = 0;
    let delta = 0;
    let pointerX = NaN;
    let easeWheel = false;
    let pinchScale: number | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let pending: { zoom: number; date: number } | undefined;
    const zoomLeft = (zoom: number, date: number, plotWidth: number) => {
      const { start, end } = zoomInput.current.scale;
      const max = Math.max(0, (end - start) / MS_PER_DAY * zoom - Math.floor(plotWidth / 2));
      return Math.max(0, Math.min(max, (date - start) / MS_PER_DAY * zoom));
    };
    const preview = (zoom: number, date: number) => {
      const ratio = zoom / zoomInput.current.scale.pxPerDay;
      const left = zoomLeft(zoom, date, Math.max(0, element.clientWidth - LABEL_W));
      element.style.setProperty("--tl-preview-scale", String(ratio));
      element.style.setProperty("--tl-preview-inverse", String(1 / ratio));
      element.style.setProperty("--tl-preview-shift", `${element.scrollLeft - left}px`);
      element.classList.add("tl-zooming");
    };
    zoomPreviews.current.add(preview);
    const commit = () => {
      const current = zoomInput.current;
      if (pending && (current.scale.pxPerDay !== pending.zoom || element.classList.contains("tl-zooming"))) {
        const { zoom, date } = pending;
        flushSync(() => current.onZoom(zoom, date));
      }
    };
    const finish = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      delta = 0;
      clearTimeout(idleTimer);
      commit();
      if (pending) zoomInput.current.saveZoom(pending.zoom);
      pending = undefined;
      if (endZoomGesture.current === finish) endZoomGesture.current = null;
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const current = zoomInput.current;
        const previousZoom = pending?.zoom ?? current.scale.pxPerDay;
        const step = easeWheel && Math.abs(delta) > 0.013 ? delta * 0.45 : delta;
        const nextZoom = clampZoom(previousZoom * Math.exp(step));
        delta -= step;
        if (nextZoom === previousZoom) { delta = 0; return; }
        const plotWidth = Math.max(0, element.clientWidth - LABEL_W);
        const plotLeft = element.getBoundingClientRect().left + LABEL_W;
        const cursor = Number.isFinite(pointerX) ? Math.max(0, Math.min(plotWidth, pointerX - plotLeft)) : plotWidth / 2;
        const previousDate = pending?.date ?? current.scale.start + element.scrollLeft / previousZoom * MS_PER_DAY;
        const anchor = previousDate + (cursor / previousZoom - cursor / nextZoom) * MS_PER_DAY;
        const date = current.scale.start + zoomLeft(nextZoom, anchor, plotWidth) / nextZoom * MS_PER_DAY;
        if (!pending) setPopup(null);
        pending = { zoom: nextZoom, date };
        cancelAnimationFrame(publishScroll.current);
        publishScroll.current = 0;
        const ratio = nextZoom / current.scale.pxPerDay;
        if (ratio < 0.63 || ratio > 1.8) {
          setWindowTop(Math.floor(element.scrollTop / (ROW_H * 3)) * ROW_H * 3);
          commit();
        } else current.onZoomPreview(nextZoom, date);
        clearTimeout(idleTimer);
        idleTimer = setTimeout(finish, 160);
        if (delta) schedule();
      });
    };
    const queue = (amount: number, x: number, ease = false) => {
      if (!Number.isFinite(amount) || amount === 0) return;
      if (endZoomGesture.current !== finish) endZoomGesture.current?.();
      endZoomGesture.current = finish;
      delta += amount;
      pointerX = x;
      easeWheel = ease;
      schedule();
    };
    const wheel = (event: WheelEvent) => {
      if (!event.metaKey && !event.ctrlKey) {
        if (pending) finish();
        return;
      }
      event.preventDefault();
      if (pinchScale !== null) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1;
      queue(-event.deltaY * unit * (event.metaKey ? 0.004 : 0.008), event.clientX, event.metaKey);
    };
    const pinchStart = (event: Event) => {
      event.preventDefault();
      delta = 0;
      endZoomGesture.current?.();
      pinchScale = 1;
    };
    const pinchChange = (event: Event) => {
      event.preventDefault();
      const { scale, clientX } = event as MouseEvent & { scale: number };
      if (pinchScale === null || !Number.isFinite(scale) || scale <= 0) return;
      queue(Math.log(scale / pinchScale), clientX);
      pinchScale = scale;
    };
    const pinchEnd = (event: Event) => {
      event.preventDefault();
      pinchScale = null;
    };
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("gesturestart", pinchStart, { passive: false });
    element.addEventListener("gesturechange", pinchChange, { passive: false });
    element.addEventListener("gestureend", pinchEnd, { passive: false });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(idleTimer);
      if (pending) zoomInput.current.saveZoom(pending.zoom);
      if (endZoomGesture.current === finish) endZoomGesture.current = null;
      zoomPreviews.current.delete(preview);
      element.classList.remove("tl-zooming");
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("gesturestart", pinchStart);
      element.removeEventListener("gesturechange", pinchChange);
      element.removeEventListener("gestureend", pinchEnd);
    };
  }, [ready, tl.id]);

  useEffect(() => {
    const move = (event: KeyboardEvent) => {
      const element = scrollRef.current;
      if (!element || (activePane.current ?? (parent ? parent.id : tl.id)) !== tl.id
        || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing
        || document.querySelector(".overlay:not([inert]), #workspace-content[inert]")
        || (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]"))) return;
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "h", "l", "j", "k"].includes(event.key)) endZoomGesture.current?.();
      switch (event.key) {
        case "ArrowLeft": case "h":
        case "ArrowRight": case "l": {
          const step = Math.max(64, (element.clientWidth - LABEL_W) / 3);
          element.scrollLeft += (event.key === "ArrowLeft" || event.key === "h") ? -step : step;
          break;
        }
        case "ArrowUp": case "ArrowDown":
          element.scrollTop += event.key === "ArrowUp" ? -ROW_H : ROW_H;
          break;
        case "j": case "k": {
          if (!filteredRows.length) return;
          const index = filteredRows.findIndex((row) => row.entry.path === highlightedRow);
          const down = event.key === "j";
          const visibleIndex = down ? Math.floor(element.scrollTop / ROW_H)
            : Math.ceil((element.scrollTop + element.clientHeight - AXIS_H) / ROW_H) - 1;
          const next = Math.max(0, Math.min(filteredRows.length - 1, index < 0 ? visibleIndex : index + (down ? 1 : -1)));
          setHighlightedRow(filteredRows[next]!.entry.path);
          const top = next * ROW_H;
          const bottom = top + ROW_H + AXIS_H;
          if (top < element.scrollTop) element.scrollTop = top;
          else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
          break;
        }
        default: return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", move);
    return () => window.removeEventListener("keydown", move);
  }, [activePane, endZoomGesture, filteredRows, highlightedRow, parent?.id, tl.id]);

  useEffect(() => () => { if (activePane.current === tl.id) activePane.current = null; }, [activePane, tl.id]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setViewport((previous) => previous.width === width && previous.height === height ? previous : { width, height });
      visibleWindow.update(element.scrollLeft, Math.max(0, width - LABEL_W));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [snap]);

  // Keep the calendar date at the left edge as additional history loads or zoom changes.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.classList.remove("tl-zooming");
    const max = Math.max(0, el.scrollWidth - el.clientWidth);
    const externalJump = scrollDate !== appliedDate.current;
    const date = externalJump ? scrollDate : manualDate.current ?? scrollDate;
    appliedDate.current = scrollDate;
    if (externalJump) manualDate.current = date;
    const offset = date === null ? Math.max(0, max - rightPadding) : Math.min(max, Math.max(0, xOf(scale, date)));
    if (Math.abs(el.scrollLeft - offset) > 1) {
      el.scrollTo({ left: offset, behavior: "instant" });
      programmaticScroll.current = el.scrollLeft;
      setWindowLeft(Math.floor(el.scrollLeft / 256) * 256);
      visibleWindow.update(el.scrollLeft, Math.max(0, el.clientWidth - LABEL_W));
    }
  }, [scrollDate, scale.start, scale.pxPerDay, width, snap, viewportWidth, rightPadding]);

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

  const jumpToDate = (date: number) => {
    if (!Number.isFinite(date)) return;
    const center = Math.max(0, viewportWidth - LABEL_W) / 2 / scale.pxPerDay * 864e5;
    if (date - center < historyStart) fitMarkers(date - center, true);
    setScrollDate(date - center);
  };

  const jumpToTip = async () => {
    if (latestRequest.current) return;
    const request = loadRoot(tl.root, tl.baseRef, null, source, true);
    latestRequest.current = request;
    setJumpingToTip(true);
    try {
      const latest = await request;
      if (latestRequest.current !== request) return;
      if (tl.rootSha) {
        followSnapshot.current = latest;
        useApp.getState().patch("timelines", tl.id, { rootSha: null });
      } else setSnap((previous) => previous?.commit.sha === latest.commit.sha ? previous : latest);
      setPopup(null);
      jumpToDate(Date.parse(latest.commit.committedAt));
    } catch (error) {
      if (latestRequest.current === request) useApp.getState().toast("error", describeError(error));
    } finally {
      if (latestRequest.current === request) {
        latestRequest.current = null;
        setJumpingToTip(false);
      }
    }
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
    <div className="col" data-search-pane style={{ height: "100%", gap: 0 }}
      onPointerDownCapture={() => { endZoomGesture.current?.(); activePane.current = tl.id; }}
      onFocusCapture={() => { activePane.current = tl.id; }}>
      <div className="toolbar small">
        <div className="row tl-heading" title={snap.commit.message}>
          <h1 className="toolbar-title">{tl.root}@{tl.baseRef}</h1>
          <CommitHash repo={tl.root} sha={snap.commit.sha} prefix="@" />
          {tl.rootSha && <span className="chip warn" title={`This timeline is pinned to ${tl.rootSha}`}>Pinned commit</span>}
          <span className="mono faint">· {new Date(snap.commit.committedAt).toLocaleDateString()} · {query ? `${filteredRows.length}/` : ""}{rows.length} submodules</span>
        </div>
        <input className="input" data-workspace-search aria-label="Search submodules" placeholder="Search submodules…" value={query} onChange={(event) => {
          setQuery(event.target.value);
          if (scrollRef.current) scrollRef.current.scrollTop = 0;
          setWindowTop(0);
        }} />
        {controls}
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
            jumpToDate(Date.parse(alignDate));
          }}>→</button>
        </div>
        <button className="btn sm" onClick={() => {
          const el = scrollRef.current;
          if (!el) return;
          el.scrollTo({ left: el.scrollWidth - el.clientWidth, behavior: "instant" });
        }} title="Scroll to the end of the timeline">Timeline end</button>
        <button className="btn sm" disabled={jumpingToTip} onClick={() => void jumpToTip()}
          title={tl.rootSha ? `Clear the fixed commit and follow ${tl.baseRef}` : `Refresh and center the timeline on the latest commit of ${tl.root}@${tl.baseRef}`}>
          {jumpingToTip ? "Finding latest…" : tl.rootSha ? `Follow ${tl.baseRef}` : `Jump to latest ${tl.baseRef}`}
        </button>
        {activeRelease && <button className="btn sm" onClick={doAlign} title="Suggest, for each submodule, the latest commit at or before the selected date (or today). Suggestions are shown as dashed markers until you accept them.">Suggest pins at date</button>}
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
        onClick={(e) => { if (e.target instanceof Element && !e.target.closest(".tl-dots, .tl-pin-marker, .tl-pr-marker, .tl-tip-marker")) setPopup(null); }}
        onScroll={(event) => {
          if (publishScroll.current) return;
          const element = event.currentTarget;
          publishScroll.current = requestAnimationFrame(() => {
            publishScroll.current = 0;
            const left = Math.max(0, element.scrollLeft);
            const movedHorizontally = left !== visibleWindow.left;
            const ignored = programmaticScroll.current;
            programmaticScroll.current = null;
            visibleWindow.update(left, Math.max(0, viewportWidth - LABEL_W));
            setWindowLeft(Math.floor(left / 256) * 256);
            setWindowTop(Math.floor(element.scrollTop / (ROW_H * 3)) * ROW_H * 3);
            if (!movedHorizontally || (ignored !== null && Math.abs(left - ignored) <= 1)) return;
            const date = scale.start + left / scale.pxPerDay * 864e5;
            manualDate.current = date;
            if (synchronize) setScrollDate(date);
          });
        }}
        onMouseLeave={(event) => { if (crosshair.current) crosshair.current.hidden = true; if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest(".tl-popup"))) hideHover(); }}
      >
        <div className="tl-axis" style={{ width: LABEL_W + width }}>
          <div className="tl-label" style={{ height: AXIS_H, width: LABEL_W }}>
            <span className="faint small">submodule / pin</span>
          </div>
          <div className="tl-canvas" style={{ width, height: AXIS_H }}>
            {snap && <span className="tl-baseline" style={{ left: xOf(scale, snap.commit.committedAt) }}
              title={`${tl.root} · ${snap.commit.sha.slice(0, 8)}`}>{tl.root.split("/").at(-1)}@{tl.rootSha ? snap.commit.sha.slice(0, 8) : tl.baseRef}</span>}
            {windowStart === 0 && <button className="btn sm tl-load-earlier" disabled={loadingHistory} onClick={loadEarlier}>
              {loadingHistory ? "Loading history…" : "← Load earlier history"}
            </button>}
            {minor.filter((x) => x * minorRatio >= windowStart && x * minorRatio <= windowEnd).map((x) => (
              <span key={`m${x}`} className="tl-tick minor" style={{ left: x * minorRatio }} aria-hidden="true" />
            ))}
            {tks.filter((tick) => tick.x * axisRatio >= windowStart && tick.x * axisRatio <= windowEnd).map((t) => (
              <span key={t.x}>
                <span className="tl-tick major" style={{ left: t.x * axisRatio }} aria-hidden="true" />
                <span className="faint small tl-tick-label" style={{ position: "absolute", left: t.x * axisRatio + 3, top: 16, whiteSpace: "nowrap" }}>
                  {t.label}
                </span>
              </span>
            ))}
          </div>
        </div>
        <div className="tl-track" style={{ position: "relative", width: LABEL_W + width, height: Math.max(100, filteredRows.length * ROW_H) }} onMouseMove={(e) => {
          const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          const x = e.clientX - rect.left - LABEL_W;
          const overLabel = e.target instanceof Element && e.target.closest(".tl-label");
          const line = crosshair.current;
          if (line) {
            line.hidden = !!overLabel || x < 0 || x > width;
            if (!line.hidden) line.style.transform = `translateX(${x}px)`;
          }
        }}>
          {filteredRows.slice(firstRow, lastRow).map((r, index) => (
            <div key={r.entry.path} style={{ position: "absolute", width: "100%", top: (firstRow + index) * ROW_H }}>
            <TimelineRow
              row={r}
              scale={scale}
              width={width}
              windowStart={windowStart}
              windowEnd={windowEnd}
              rootSha={snap.commit.sha}
              theme={theme}
              hasChild={!!r.childKey && childRoots.has(r.childKey)}
              visibleWindow={visibleWindow}
              onJumpMarker={(date) => {
                setHighlightedRow(r.entry.path);
                jumpToDate(date);
              }}
              onHighlight={() => setHighlightedRow(r.entry.path)}
              tl={tl}
              releases={visibleRels}
              pinFor={pinFor}
              activeRelease={activeRelease ? releases[activeRelease] ?? null : null}
              onSetPin={setPin}
              onClearPin={(rel) => remove("pins", pinKey({ releaseId: rel.id, parentRepo: tl.root, pathChain: [...tl.pathPrefix, r.entry.path] }))}
              suggestion={suggest.get(r.entry.path)}
              showPopup={(commit, target, locked, pr, position) => {
                clearTimeout(hideTimer.current);
                const bounds = target.getBoundingClientRect();
                setPopup((current) => !locked && (current?.locked || (current?.commit.sha === commit.sha && current.repo === r.childKey))
                  ? current : { commit, repo: r.childKey, tags: r.tags?.filter((tag) => tag.sha === commit.sha).map((tag) => tag.name), pr, locked, x: position?.x ?? bounds.left, y: position?.y ?? bounds.bottom });
              }}
              hideHover={hideHover}
              onOpenChild={() => onOpenChild(r)}
              highlighted={highlightedRow === r.entry.path || (!!highlightChild && highlightChild.repo === r.childKey)}
              onSelectPin={onSelectPin}
            />
            </div>
          ))}
          <div className="tl-guides" style={{ left: LABEL_W, width, height: filteredRows.length * ROW_H }} aria-hidden="true">
            <div className="tl-guide-root" style={{ left: xOf(scale, snap.commit.committedAt) }} />
            <div ref={crosshair} className="tl-crosshair" hidden />
          </div>
          {!filteredRows.length && <div className="empty tl-no-results">No matching submodules.</div>}
        </div>
      </div>
      {popup && <div className={`panel pad small tl-popup ${popup.locked ? "locked" : ""} ${popup.tags?.length ? "tagged" : ""}`}
        style={{ left: Math.max(4, Math.min(popup.x, window.innerWidth - 325)), top: Math.max(4, Math.min(popup.y + 8, window.innerHeight - 130)) }}
        onMouseEnter={() => clearTimeout(hideTimer.current)} onMouseLeave={hideHover} role={popup.locked ? "dialog" : undefined} aria-label="Commit details">
        <div className="row">
          {popup.repo ? <CommitHash repo={popup.repo} sha={popup.commit.sha} prefix="#" /> : <span className="mono">{popup.commit.sha.slice(0, 8)}</span>}
          {popup.repo && popup.tags?.map((tag) => <a className="ref tag" key={tag} href={tagLink(popup.repo!, tag)} target="_blank" rel="noreferrer">{tag}</a>)}
          {popup.pr && popup.repo && <a href={`https://github.com/${popup.repo}/pull/${popup.pr}`} target="_blank" rel="noreferrer">PR #{popup.pr}</a>}
          {popup.locked && <button className="btn ghost sm tl-popup-close" aria-label="Close commit details" onClick={() => setPopup(null)}>✕</button>}
        </div>
        <div>{popup.commit.message.split("\n")[0]}</div>
        <div className="faint">{popup.commit.author} · {new Date(popup.commit.committedAt).toLocaleString()}</div>
      </div>}

    </div>
  );
}

/** Fine-grained tick positions: daily when there is room, otherwise weekly (Sundays). */
/** Approximate rendered width of a `.ref` label (11px sans, 6px padding + border each side). */
function labelWidth(text: string, perChar = 6.6, padding = 14): number {
  return Math.ceil(text.length * perChar) + padding;
}

interface StackedLabel { left: number; w: number; order: number }

/**
 * Keep each label at its anchor x, but when labels in a lane collide, offset each later label just enough
 * (minVisible px) that every label underneath keeps a hoverable sliver. Later labels stack on top (higher order).
 */
function stackLabels(items: { id: string; x: number; w: number }[], minVisible = 18): Map<string, StackedLabel> {
  const out = new Map<string, StackedLabel>();
  let prevLeft = -Infinity;
  [...items].sort((a, b) => a.x - b.x).forEach((item, order) => {
    const left = Math.max(item.x, prevLeft + minVisible);
    out.set(item.id, { left, w: item.w, order });
    prevLeft = left;
  });
  return out;
}

function minorTicks(s: TimeScale): number[] {
  const stepDays = s.pxPerDay >= 4 ? 1 : s.pxPerDay * 7 >= 4 ? 7 : 0;
  if (!stepDays) return [];
  const d = new Date(s.start);
  d.setUTCHours(0, 0, 0, 0);
  if (stepDays === 7) d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  const out: number[] = [];
  while (d.getTime() <= s.end && out.length < 20_000) {
    if (d.getTime() >= s.start) out.push(Math.round(xOf(s, d.getTime())));
    d.setUTCDate(d.getUTCDate() + stepDays);
  }
  return out;
}

function lowerBound<T>(points: readonly T[], x: number, coordinate: (point: T) => number): number {
  let first = 0;
  let last = points.length;
  while (first < last) {
    const middle = Math.floor((first + last) / 2);
    if (coordinate(points[middle]!) < x) first = middle + 1;
    else last = middle;
  }
  return first;
}

function createVisibleWindow() {
  const listeners = new Set<() => void>();
  return {
    left: 0,
    right: 0,
    update(left: number, width: number) {
      const right = left + width;
      if (left === this.left && right === this.right) return;
      this.left = left;
      this.right = right;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

function MarkerJump({ direction, viewport, markers, path, onJump }: {
  direction: "left" | "right";
  viewport: ReturnType<typeof createVisibleWindow>;
  markers: { label: string; date: number; x: number }[];
  path: string;
  onJump: (date: number) => void;
}) {
  const target = useSyncExternalStore(viewport.subscribe, () => {
    let nearest: typeof markers[number] | undefined;
    for (const marker of markers) {
      if (direction === "left" && marker.x < viewport.left - 1 && (!nearest || nearest.x < marker.x)) nearest = marker;
      if (direction === "right" && marker.x > viewport.right + 1 && (!nearest || nearest.x > marker.x)) nearest = marker;
    }
    return nearest;
  });
  return target && <button className="btn ghost sm tl-older" onClick={() => onJump(target.date)} title={`Jump to ${target.label}`}
    aria-label={`Jump to ${target.label} for ${path}`}>{direction === "left" ? "←" : "→"}</button>;
}

const tagLink = (repo: string, name: string) => `https://github.com/${repo}/tree/${name.split("/").map(encodeURIComponent).join("/")}`;

type CommitPopup = { commit: CommitNode; tags?: string[]; repo: string | null; pr?: number; locked: boolean; x: number; y: number };
type TimedCommit = { commit: CommitNode; time: number };
const sortedHistories = new WeakMap<CommitNode[], TimedCommit[]>();
const emptyHistory: TimedCommit[] = [];

function sortedHistory(commits?: CommitNode[]): TimedCommit[] {
  if (!commits) return emptyHistory;
  let history = sortedHistories.get(commits);
  if (!history) {
    history = commits.map((commit) => ({ commit, time: Date.parse(commit.committedAt) }))
      .filter((point) => Number.isFinite(point.time)).sort((a, b) => a.time - b.time);
    sortedHistories.set(commits, history);
  }
  return history;
}

function TimelineRow({
  row,
  scale,
  width,
  windowStart,
  windowEnd,
  rootSha,
  theme,
  hasChild,
  visibleWindow,
  onJumpMarker,
  onHighlight,
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
  theme: string;
  hasChild: boolean;
  visibleWindow: ReturnType<typeof createVisibleWindow>;
  onJumpMarker: (date: number) => void;
  onHighlight: () => void;
  tl: TimelineView;
  releases: Release[];
  pinFor: (relId: string, path: string) => ReleasePin | undefined;
  activeRelease: Release | null;
  onSetPin: (rel: Release, row: SubmoduleRow, c: CommitNode) => void;
  onClearPin: (rel: Release) => void;
  suggestion?: CommitNode;
  showPopup: (commit: CommitNode, target: HTMLElement, locked: boolean, pr?: number, position?: { x: number; y: number }) => void;
  hideHover: () => void;
  onOpenChild: () => void;
  highlighted: boolean;
  onSelectPin?: (repo: string, sha: string) => void;
}) {
  const history = sortedHistory(row.history);
  const onBranch = useMemo(() => pinOnBranch(row), [row]);
  const start = scale.start;
  const pxPerDay = scale.pxPerDay;
  const timeAt = (x: number) => start + x / pxPerDay * 864e5;
  const from = lowerBound(history, timeAt(windowStart), (point) => point.time);
  const to = lowerBound(history, timeAt(windowEnd), (point) => point.time);
  const branchCommits = useMemo(() => new Set(row.tip ? row.index?.reachable(row.tip.sha, row.index.bySha.size).map((commit) => commit.sha) : []), [row.index, row.tip]);
  const canvasRef = useRef<HTMLDivElement>(null);

  const nearest = useCallback((x: number) => {
    const date = start + x / pxPerDay * 864e5;
    const next = lowerBound(history, date, (point) => point.time);
    const left = history[next - 1];
    const right = history[next];
    return !right || (left && date - left.time < right.time - date) ? left ?? right : right;
  }, [history, start, pxPerDay]);

  const labelFolder = row.entry.path.split("/").slice(0, -1).map(encodeURIComponent).join("/");
  const currentTag = `${tl.root.split("/").at(-1)}@${tl.rootSha ? rootSha.slice(0, 8) : tl.baseRef}`;
  // Labels stay anchored at their commit. Colliding labels in a lane are offset just enough that each keeps a hoverable sliver;
  // hovering one brings it to the front and fades the labels it overlaps. Bottom lane = PR markers + branch tip, top lane = tags.
  const tipX = row.tip ? xOf(scale, row.tip.committedAt) : -1;
  const bottomLane = stackLabels([
    ...(row.prs ?? []).map((p) => ({ id: p.key, x: xOf(scale, p.head.committedAt) - 4, w: labelWidth(`PR #${p.number}`) })),
    ...(row.tip && tipX >= 0 ? [{ id: "\0tip", x: tipX, w: labelWidth(row.branch ?? "") }] : []),
  ]);
  const visibleTags = (row.tags ?? []).filter((t) => { const dot = row.index?.bySha.get(t.sha); return dot && xOf(scale, dot.committedAt) >= windowStart && xOf(scale, dot.committedAt) <= windowEnd; });
  const topLane = stackLabels(visibleTags.map((t) => ({ id: t.name, x: xOf(scale, row.index!.bySha.get(t.sha)!.committedAt) + 4, w: labelWidth(t.name) })));
  const [hoveredLabel, setHoveredLabel] = useState<string | null>(null);
  const pinX = row.pinnedCommit ? xOf(scale, row.pinnedCommit.committedAt) : -1;
  // the pin's caption sits in the top lane too; it can't move, but takes part in hover fading
  const pinCaption: StackedLabel | null = pinX >= 0 ? { left: pinX + 2, w: labelWidth(currentTag, 5.5, 6), order: 0 } : null;
  const overlaps = (a: StackedLabel, b: StackedLabel) => a.left < b.left + b.w && b.left < a.left + a.w;
  const captionFaded = !!pinCaption && !!hoveredLabel && hoveredLabel !== "\0pin" && !!topLane.get(hoveredLabel) && overlaps(pinCaption, topLane.get(hoveredLabel)!);
  const laneStyle = (lane: Map<string, StackedLabel>, id: string, baseZ: number): React.CSSProperties => {
    const me = lane.get(id);
    if (!me) return {};
    const hov = hoveredLabel === "\0pin" ? (lane === topLane ? pinCaption ?? undefined : undefined) : hoveredLabel && hoveredLabel !== id ? lane.get(hoveredLabel) : undefined;
    const covered = !!hov && me.left < hov.left + hov.w && hov.left < me.left + me.w;
    return { left: me.left, zIndex: hoveredLabel === id ? 20 : baseZ + me.order, opacity: covered ? 0.2 : 1, transition: "opacity .15s" };
  };
  const hoverProps = (id: string) => ({ onPointerEnter: () => setHoveredLabel(id), onPointerLeave: () => setHoveredLabel((h) => (h === id ? null : h)) });
  const markers = [
    { label: `${row.branch ?? "Default branch"} tip`, date: row.tip?.committedAt },
    { label: currentTag, date: row.pinnedCommit?.committedAt },
    ...releases.map((release) => ({ label: release.name, date: pinFor(release.id, row.entry.path)?.committedAt ?? row.pinnedCommit?.committedAt })),
  ].flatMap(({ label, date }) => date ? [{ label, date: Date.parse(date), x: xOf(scale, date) }] : []);

  const startDrag = (rel: Release) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = canvasRef.current!.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const c = nearest(ev.clientX - rect.left);
      if (c) onSetPin(rel, row, c.commit);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const keyMove = (rel: Release, cur: string) => (e: React.KeyboardEvent) => {
    const i = history.findIndex(({ commit }) => commit.sha === cur);
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      if (!history.length) return;
      const j = Math.max(0, Math.min(history.length - 1, (i < 0 ? history.length - 1 : i) + (e.key === "ArrowRight" ? 1 : -1)));
      onSetPin(rel, row, history[j]!.commit);
    }
    if (e.key === "Delete" || e.key === "Backspace") onClearPin(rel);
  };

  return (
    <div className={`tl-row ${highlighted ? "highlighted" : ""}`} style={{ height: ROW_H }} onClick={onHighlight}>
      <div className="tl-label" style={{ width: LABEL_W }}>
        <div className="row tl-label-top">
          <a className="tl-path tl-link ellipsis mono small" title={`View ${row.entry.path} in its containing folder`} href={`https://github.com/${tl.root}/tree/${rootSha}${labelFolder ? "/" + labelFolder : ""}`} target="_blank" rel="noreferrer">
            {row.entry.path}
          </a>
          <MarkerJump direction="left" viewport={visibleWindow} markers={markers} path={row.entry.path} onJump={onJumpMarker} />
          <MarkerJump direction="right" viewport={visibleWindow} markers={markers} path={row.entry.path} onJump={onJumpMarker} />
          {row.childKey && <button className={`btn ghost sm tl-child ${hasChild ? "" : "faint"}`} onClick={onOpenChild}
            title={hasChild ? "Open child timeline" : "Create child timeline"}
            aria-label={`${hasChild ? "Open" : "Create"} child timeline for ${row.entry.path}`}>↳</button>}
        </div>
        <div className="tl-meta faint small">
          {row.childKey ? <a className="ellipsis tl-link" title={row.childKey} href={`https://github.com/${row.childKey}`} target="_blank" rel="noreferrer">{row.childKey}</a> : <span className="ellipsis">{row.entry.url || "?"}</span>}
          {row.pinned ? <CommitHash repo={row.childKey} sha={row.pinned} /> : <span className="mono">—</span>}
          {row.status === "unresolved" && <span className="chip warn" style={{ marginLeft: 4 }}>unresolved</span>}
          {row.status === "private-or-missing" && <span className="chip err" style={{ marginLeft: 4 }} title={row.error}>unavailable</span>}
          {onBranch === false && <span className="chip warn" style={{ marginLeft: 4 }} title={`Pinned commit is not on ${row.branch}`}>diverged</span>}
        </div>
      </div>
      <div ref={canvasRef} className="tl-canvas" style={{ width, height: ROW_H }} onDoubleClick={(e) => {
        if (!activeRelease) return;
        const rect = canvasRef.current!.getBoundingClientRect();
        const c = nearest(e.clientX - rect.left);
        if (c) onSetPin(activeRelease, row, c.commit);
      }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: ROW_H / 2, height: 1, background: "var(--border)" }} />
        {row.status === "loading" && <span className="faint small" style={{ position: "absolute", left: 8, top: 10 }}>loading history…</span>}
        {row.error && row.status !== "ok" && <span className="faint small" style={{ position: "absolute", left: 8, top: 10 }}>{row.error}</span>}
        {to > from && <TimelineDots history={history} from={from} to={to} start={start} pxPerDay={pxPerDay}
          first={windowStart} last={Math.min(windowEnd, width)}
          onBranch={row.tip ? branchCommits : null} theme={theme}
          onHover={(point, target, locked, position) => showPopup(point.commit, target, locked, row.prs?.find((pr) => pr.head.sha === point.commit.sha)?.number, position)}
          onLeave={hideHover} />}
        {visibleTags.map((t) => (
          row.childKey && <a key={t.name} className="ref tag tl-tag-link" href={tagLink(row.childKey, t.name)} target="_blank" rel="noreferrer"
            style={laneStyle(topLane, t.name, 2)} {...hoverProps(t.name)}>{t.name}</a>
        ))}
        {row.prs?.map((p) => {
          const onBranch = !row.tip || branchCommits.has(p.head.sha);
          return (
            <button
              key={p.key}
              className="ref tl-pr-marker"
              title={`${p.key} ${p.title}\nhead ${p.head.sha.slice(0, 8)} (${new Date(p.head.committedAt).toLocaleDateString()})${onBranch === false ? " — not on the tracked branch" : ""}`}
              style={{ position: "absolute", top: ROW_H - 15, ...laneStyle(bottomLane, p.key, 2), background: "var(--info-bg)", border: `1px ${p.draft ? "dashed" : "solid"} var(--info)` }}
              onMouseEnter={(e) => { setHoveredLabel(p.key); showPopup(p.head, e.currentTarget, false, p.number); }}
              onClick={(e) => showPopup(p.head, e.currentTarget, true, p.number)}
              onMouseLeave={() => { setHoveredLabel((h) => (h === p.key ? null : h)); hideHover(); }}
            >
              PR #{p.number}
            </button>
          );
        })}
        {row.tip && tipX >= 0 && <button type="button" className="ref tl-tip-marker"
          style={laneStyle(bottomLane, "\0tip", 2)} title={`${row.branch} tip · ${row.tip.sha.slice(0, 8)}`}
          onMouseEnter={(event) => { setHoveredLabel("\0tip"); showPopup(row.tip!, event.currentTarget, false); }}
          onMouseLeave={() => { setHoveredLabel((h) => (h === "\0tip" ? null : h)); hideHover(); }}
          onClick={(event) => showPopup(row.tip!, event.currentTarget, true)}>{row.branch}</button>}
        {row.pinnedCommit && xOf(scale, row.pinnedCommit.committedAt) >= 0 && (
          <button
            type="button"
            aria-label={`Pinned commit ${row.pinned?.slice(0, 8)}`}
            title={`${tl.root}@${tl.baseRef} pins ${row.pinned} (${new Date(row.pinnedCommit.committedAt).toLocaleDateString()})`}
            onClick={(e) => {
              showPopup(row.pinnedCommit!, e.currentTarget, true);
              if (row.childKey && row.pinned) onSelectPin?.(row.childKey, row.pinned);
            }}
            onMouseEnter={(e) => { setHoveredLabel("\0pin"); showPopup(row.pinnedCommit!, e.currentTarget, false); }}
            onMouseLeave={() => { setHoveredLabel((h) => (h === "\0pin" ? null : h)); hideHover(); }}
            className="tl-pin-marker"
            style={{ left: xOf(scale, row.pinnedCommit.committedAt), ...(hoveredLabel === "\0pin" ? { zIndex: 20 } : {}) }}
          ><span className="tl-pin-caption" style={{ opacity: captionFaded ? 0.2 : 1, transition: "opacity .15s" }}>{currentTag}</span></button>
        )}
        {suggestion && <div title={`Align-to-date suggestion ${suggestion.sha.slice(0, 8)}`} style={{ position: "absolute", left: xOf(scale, suggestion.committedAt) - 6, top: ROW_H / 2 - 6, width: 12, height: 12, borderRadius: 2, border: "2px dashed var(--accent)", zIndex: 2 }} />}
        {releases.map((rel) => {
          const p = pinFor(rel.id, row.entry.path);
          const at = p?.committedAt ?? row.pinnedCommit?.committedAt;
          if (!at || xOf(scale, at) < 0) return null;
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



function CommitHash({ repo, sha, prefix = "" }: { repo: string | null; sha: string; prefix?: string }) {
  const toast = useApp((state) => state.toast);
  return <span className="tl-hash mono">
    {repo ? <a className="tl-link" href={`https://github.com/${repo}/commit/${sha}`} target="_blank" rel="noreferrer">{prefix}{sha.slice(0, 8)}</a> : <span>{sha.slice(0, 8)}</span>}
    <button className="btn ghost tl-copy" title="Copy full commit hash" aria-label={`Copy commit hash ${sha.slice(0, 8)}`} onClick={(event) => {
      event.stopPropagation();
      void copyText(sha).then((copied) => toast(copied ? "info" : "error", copied ? "Commit hash copied" : "Could not copy the commit hash."));
    }}><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1" /><path d="M3 10H2V2h8v1" /></svg></button>
  </span>;
}

type PlottedCommit = { commit: CommitNode; x: number };
const paintedTiles = new WeakMap<TimedCommit[], {
  theme: string;
  onBranch: Set<string> | null;
  tiles: Map<string, HTMLCanvasElement>;
}>();
const dotSprites = new Map<string, HTMLCanvasElement>();

function dotSprite(color: string, ratio: number, outline: boolean): HTMLCanvasElement {
  const key = `${color}:${ratio}:${outline}`;
  const existing = dotSprites.get(key);
  if (existing) return existing;
  const sprite = document.createElement("canvas");
  sprite.width = Math.ceil(8 * ratio);
  sprite.height = sprite.width;
  const context = sprite.getContext("2d");
  if (context) {
    context.scale(ratio, ratio);
    context.beginPath();
    context.arc(4, 4, 3, 0, Math.PI * 2);
    if (outline) {
      context.strokeStyle = color;
      context.stroke();
    } else {
      context.fillStyle = color;
      context.fill();
    }
  }
  dotSprites.set(key, sprite);
  if (dotSprites.size > 24) dotSprites.delete(dotSprites.keys().next().value!);
  return sprite;
}

// The scrollport moves the canvases natively. Only freshly entered tiles need painting.
const TimelineDotTile = memo(function TimelineDotTile({ history, start, pxPerDay, left, onBranch, theme }: {
  history: TimedCommit[];
  start: number;
  pxPerDay: number;
  left: number;
  onBranch: Set<string> | null;
  theme: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // Leave room for the radius at both seams. Each dot belongs to exactly one tile.
  const inset = 4;
  const end = left + DOT_TILE_WIDTH;
  const width = DOT_TILE_WIDTH + inset * 2;
  const from = lowerBound(history, start + left / pxPerDay * 864e5, (point) => point.time);
  const to = lowerBound(history, start + end / pxPerDay * 864e5, (point) => point.time);
  useLayoutEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    element.width = Math.ceil(width * ratio);
    element.height = Math.ceil(18 * ratio);
    let cache = paintedTiles.get(history);
    if (!cache || cache.theme !== theme || cache.onBranch !== onBranch) {
      cache = { theme, onBranch, tiles: new Map() };
      paintedTiles.set(history, cache);
    }
    const key = `${start}:${pxPerDay}:${left}:${ratio}`;
    const previous = cache.tiles.get(key);
    if (previous && previous !== element) {
      context.drawImage(previous, 0, 0);
      cache.tiles.delete(key);
      cache.tiles.set(key, previous);
      return;
    }
    const colors = getComputedStyle(element);
    const solid = dotSprite(colors.getPropertyValue("--text-3").trim(), ratio, false);
    const outline = dotSprite(colors.getPropertyValue("--warn").trim(), ratio, true);
    let filledColumn = -1;
    let outlinedColumn = -1;
    for (let i = from; i < to; i++) {
      const { time, commit } = history[i]!;
      const x = (time - start) / 864e5 * pxPerDay - left + inset;
      const fill = !onBranch || onBranch.has(commit.sha);
      const column = Math.round(x * ratio);
      if (fill ? column === filledColumn : column === outlinedColumn) continue;
      context.drawImage(fill ? solid : outline, column - 4 * ratio, 5 * ratio);
      if (fill) {
        filledColumn = column;
      } else {
        outlinedColumn = column;
      }
    }
    cache.tiles.set(key, element);
    if (cache.tiles.size > 10) cache.tiles.delete(cache.tiles.keys().next().value!);
  }, [history, from, to, start, pxPerDay, left, width, onBranch, theme]);
  return from < to ? <canvas className="tl-dot-tile" ref={canvas} aria-hidden="true"
    style={{ left: `calc(${left - inset}px * var(--tile-scale))`, width }} /> : null;
});

function TimelineDots({ history, from, to, start, pxPerDay, first, last, onBranch, theme, onHover, onLeave }: {
  history: TimedCommit[];
  from: number;
  to: number;
  start: number;
  pxPerDay: number;
  first: number;
  last: number;
  onBranch: Set<string> | null;
  theme: string;
  onHover: (point: PlottedCommit, target: HTMLElement, locked: boolean, position: { x: number; y: number }) => void;
  onLeave: () => void;
}) {
  const keyboard = useRef<number | null>(null);
  const hovered = useRef("");
  // Resample only when crossing a raster scale band. Between bands the browser
  // scales the existing tiles, while hit testing still uses the exact zoom.
  const rasterScale = 2 ** Math.round(Math.log2(pxPerDay));
  const tileScale = pxPerDay / rasterScale;
  const tiles = [];
  for (let left = Math.floor(first / tileScale / DOT_TILE_WIDTH) * DOT_TILE_WIDTH; left < last / tileScale; left += DOT_TILE_WIDTH) {
    tiles.push(<TimelineDotTile key={`${rasterScale}:${left}`} history={history} start={start} pxPerDay={rasterScale} left={left} onBranch={onBranch} theme={theme} />);
  }
  const xOfPoint = (point: TimedCommit) => (point.time - start) / 864e5 * pxPerDay;
  const pointAt = (event: React.MouseEvent<HTMLDivElement>) => {
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left + first;
    const time = start + x / pxPerDay * 864e5;
    const index = lowerBound(history, time, (point) => point.time);
    const left = index > from ? history[index - 1] : undefined;
    const right = index < to ? history[index] : undefined;
    const point = !right || (left && time - left.time < right.time - time) ? left : right;
    return point && Math.abs(x - xOfPoint(point)) <= 7 ? point : undefined;
  };
  const display = (point: TimedCommit, target: HTMLElement, locked: boolean) => {
    const box = target.getBoundingClientRect();
    const x = xOfPoint(point);
    onHover({ commit: point.commit, x }, target, locked, { x: box.left + x - first, y: box.bottom });
  };
  return <>
    <div className="tl-dot-layer" aria-hidden="true" style={{ "--tile-scale": tileScale } as React.CSSProperties}>{tiles}</div>
    <div className="tl-dots" style={{ left: first, width: Math.max(1, last - first) }} tabIndex={0}
      role="group" aria-label={`${to - from} commits in view. Use the arrow keys to browse and Enter to open details.`}
      onMouseMove={(event) => {
        const point = pointAt(event);
        if (point?.commit.sha === hovered.current) return;
        hovered.current = point?.commit.sha ?? "";
        if (point) display(point, event.currentTarget, false);
        else onLeave();
      }}
      onMouseLeave={() => { hovered.current = ""; onLeave(); }}
      onClick={(event) => { const point = pointAt(event); if (point) display(point, event.currentTarget, true); }}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Enter", " "].includes(event.key)) return;
        event.preventDefault();
        let index = keyboard.current ?? from;
        if (event.key.startsWith("Arrow")) index += event.key === "ArrowLeft" ? -1 : 1;
        keyboard.current = Math.max(from, Math.min(to - 1, index));
        const point = history[keyboard.current];
        if (point) display(point, event.currentTarget, !event.key.startsWith("Arrow"));
      }}
      onBlur={onLeave} />
  </>;
}
