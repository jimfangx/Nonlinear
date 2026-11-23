import { useMemo, useRef, useState, useEffect, useLayoutEffect, type ReactNode } from "react";
import { CodeText } from "./CodeText";
import { useVirtualizer } from "@tanstack/react-virtual";
import { parseFileHunks, toSplitRows, contains, type DiffLine, type Hunk, type FileReviewState, type Interval } from "@nonlinear/core";

const LINE_HEIGHT = 20;

export type DiffMode = "unified" | "split";
export type DiffSide = "LEFT" | "RIGHT";
export type DiffCodeLayout = "wrap" | "compact" | "scroll";

export function useDiffCodeLayout(storageKey: string, fallback: DiffCodeLayout) {
  const [layout, setLayout] = useState<DiffCodeLayout>(() => {
    const saved = localStorage.getItem(storageKey);
    return saved === "wrap" || saved === "compact" || saved === "scroll" ? saved : fallback;
  });
  const changeLayout = (next: DiffCodeLayout) => {
    setLayout(next);
    localStorage.setItem(storageKey, next);
  };
  return [layout, changeLayout] as const;
}

export function DiffCodeLayoutSelect({ layout, onChange }: { layout: DiffCodeLayout; onChange: (layout: DiffCodeLayout) => void }) {
  return <select className="input" value={layout} aria-label="Code layout" onChange={(event) => onChange(event.currentTarget.value as DiffCodeLayout)}>
    <option value="wrap">Wrap lines</option>
    <option value="compact">Smaller text</option>
    <option value="scroll">Horizontal scroll</option>
  </select>;
}

type LineTarget = { line: DiffLine; ri: number; side?: DiffSide };

/** One display row. `ri` = review row index (into flattened hunk lines) or null. */
type Row =
  | { t: "hunk"; hunk: Hunk; hi: number }
  | { t: "line"; line: DiffLine; ri: number; hi: number }
  | { t: "split"; left: DiffLine | null; right: DiffLine | null; ri: number[]; hi: number }
  | { t: "annotation"; ri: number }
  | { t: "ctx"; text: string; no: number; label?: string };

export interface ReviewOverlay {
  state: FileReviewState;
  setFrontier: (row: number) => void;
}

export interface FileDiffProps {
  path?: string;
  section: string;
  mode: DiffMode;
  /** extra context lines above hunk i (from semantic expansion) */
  expansions?: Map<number, { lines: string[]; startNo: number; label?: string }>;
  onExpand?: (hunkIndex: number, hunk: Hunk) => void;
  review?: ReviewOverlay;
  selection?: Interval | null;
  selectionSide?: DiffSide;
  onSelect?: (iv: Interval, endpoint: LineTarget) => void;
  highlight?: string;
  /** annotations per review row (comments/notes markers) */
  annotations?: Map<number, ReactNode>;
  onLineContext?: (event: React.MouseEvent, ri: number, line: DiffLine, side?: DiffSide) => void;
  height?: number | string;
  layout: DiffCodeLayout;
  scrollToRow?: number | null;
  scrollKey?: string;
  /** find-in-file matches per review row ([col, len]) and the current match */
  find?: { byRow: Map<number, [number, number][]>; current: { ri: number; col: number } | null } | null;
  /** scroll a review row into the middle of the view (bump `n` to repeat) */
  reveal?: { ri: number; n: number } | null;
  /** click on a code cell (used for Cmd/Ctrl+click go-to-definition) */
  onCodeClick?: (event: React.MouseEvent, ri: number, line: DiffLine, side?: DiffSide) => void;
}

export function useHunks(section: string): Hunk[] {
  return useMemo(() => parseFileHunks(section), [section]);
}

export function FileDiff(props: FileDiffProps) {
  const { section, mode, layout, expansions, onExpand, review, selection, onSelect, highlight, annotations, onLineContext, find, onCodeClick } = props;
  const wrap = layout !== "scroll";
  const hunks = useHunks(section);
  const diffRows = useMemo(() => {
    const out: Row[] = [];
    let ri = 0;
    hunks.forEach((h, hi) => {
      const ex = expansions?.get(hi);
      if (ex) ex.lines.forEach((text, k) => out.push({ t: "ctx", text, no: ex.startNo + k, label: k === 0 ? ex.label : undefined }));
      out.push({ t: "hunk", hunk: h, hi });
      if (mode === "unified") {
        for (const l of h.lines) out.push({ t: "line", line: l, ri: ri++, hi });
      } else {
        // pair rows; maintain review indices of the underlying lines
        const idx = new Map<DiffLine, number>();
        for (const l of h.lines) idx.set(l, ri++);
        for (const sr of toSplitRows(h)) {
          const ris = [sr.left, sr.right].filter((x): x is DiffLine => !!x).map((l) => idx.get(l)!);
          out.push({ t: "split", left: sr.left, right: sr.right, ri: [...new Set(ris)], hi });
        }
        // meta lines are dropped in split mode; their indices are still counted
      }
    });
    return out;
  }, [hunks, mode, expansions]);

  const rows = useMemo(() => {
    if (!annotations?.size) return diffRows;
    return diffRows.flatMap((r): Row[] => {
      const indices = r.t === "line" ? [r.ri] : r.t === "split" ? r.ri : [];
      return [r, ...indices.filter((ri) => annotations.has(ri)).map((ri): Row => ({ t: "annotation", ri }))];
    });
  }, [diffRows, annotations]);

  const totalRows = useMemo(() => hunks.reduce((n, h) => n + h.lines.length, 0), [hunks]);
  const jumpIndex = props.scrollToRow == null ? -1 : rows.findIndex((row) => row.t === "line" ? row.ri >= props.scrollToRow! : row.t === "split" && row.ri.some((ri) => ri >= props.scrollToRow!));
  const parentRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    initialOffset: () => props.scrollKey ? Number(localStorage.getItem(props.scrollKey)) || 0 : 0,
    estimateSize: (i) => rows[i]?.t === "annotation" ? 100 : LINE_HEIGHT,
    getItemKey: (i) => {
      const row = rows[i];
      switch (row?.t) {
        case "annotation": return `annotation:${row.ri}`;
        case "hunk": return `hunk:${row.hi}`;
        case "ctx": return `ctx:${row.no}`;
        case "line": return `line:${row.ri}`;
        case "split": return `split:${row.ri.join(",")}`;
        default: return i;
      }
    },
    overscan: 30,
  });
  useEffect(() => {
    const element = parentRef.current;
    const key = props.scrollKey;
    if (!element || !key) return;
    let timeout: number | undefined;
    let latest = element.scrollTop;
    const save = () => localStorage.setItem(key, String(latest));
    const onScroll = () => {
      latest = element.scrollTop;
      window.clearTimeout(timeout);
      timeout = window.setTimeout(save, 160);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", save);
    return () => {
      window.clearTimeout(timeout);
      element.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", save);
      save();
    };
  }, [props.scrollKey]);
  const longest = useMemo(() => {
    if (wrap) return 0;
    const length = (text: string) => text.replace(/\t/g, "    ").length;
    let max = 0;
    for (const row of diffRows) {
      if (row.t === "hunk") max = Math.max(max, length(row.hunk.header));
      if (row.t === "line") max = Math.max(max, length(row.line.text));
      if (row.t === "split") max = Math.max(max, length(row.left?.text ?? ""), length(row.right?.text ?? ""));
      if (row.t === "ctx") max = Math.max(max, length(row.text));
    }
    return max;
  }, [diffRows, wrap]);
  const layoutHeight = virt.getTotalSize();
  const anchor = useRef<Pick<LineTarget, "ri" | "side"> | null>(null);
  const drag = useRef<{ pointerId: number; start: number; end: number; y: number; side?: DiffSide } | null>(null);
  const dragFrame = useRef(0);
  const suppressGestureClick = useRef(false);
  const currentRows = useRef(rows);
  currentRows.current = rows;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  useEffect(() => { if (!selection) anchor.current = null; }, [selection]);
  useEffect(() => () => cancelAnimationFrame(dragFrame.current), []);

  const latestJumpIndex = useRef(jumpIndex);
  latestJumpIndex.current = jumpIndex;
  useEffect(() => {
    if (props.scrollToRow != null && latestJumpIndex.current >= 0) virt.scrollToIndex(latestJumpIndex.current, { align: "start" });
  }, [props.scrollToRow, virt]);
  const latestRows = useRef(rows);
  latestRows.current = rows;
  useEffect(() => {
    const target = props.reveal;
    if (!target) return;
    const index = latestRows.current.findIndex((row) => row.t === "line" ? row.ri === target.ri : row.t === "split" && row.ri.includes(target.ri));
    if (index < 0) return;
    const el = parentRef.current;
    const item = virt.measurementsCache[index];
    const visible = el && item && item.start >= el.scrollTop + 20 && item.end <= el.scrollTop + el.clientHeight - 20;
    if (!visible) virt.scrollToIndex(index, { align: "center" });
    // bring the current match into view horizontally (scroll layout)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const mark = parentRef.current?.querySelector("mark.find-current");
      if (mark && parentRef.current) {
        const box = mark.getBoundingClientRect();
        const view = parentRef.current.getBoundingClientRect();
        if (box.left < view.left + 140 || box.right > view.right - 20) parentRef.current.scrollLeft += box.left - view.left - view.width / 2;
      }
    }));
  }, [props.reveal?.n, virt]);
  useLayoutEffect(() => {
    virt.measure();
    for (const row of parentRef.current?.querySelectorAll<HTMLElement>("[data-index]") ?? []) virt.measureElement(row);
  }, [layout, virt]);

  const reviewedAt = (ri: number) => {
    if (!review) return "";
    const s = review.state;
    if (contains(s.stale, ri)) return "stale";
    if (contains(s.flagged, ri)) return "flagged";
    if (ri < s.frontier || contains(s.reviewed, ri)) return "reviewed";
    return "";
  };

  const selectThrough = (start: number, target: LineTarget) => {
    onSelectRef.current?.([Math.min(start, target.ri), Math.max(start, target.ri) + 1], target);
  };

  const gutter = (line: DiffLine | null, ri: number | undefined, side?: DiffSide) => {
    if (!onSelect || !line || ri === undefined || (line.oldNo === null && line.newNo === null)) return {};
    return {
      "data-review-gutter": true,
      onPointerDown(event: React.PointerEvent<HTMLElement>) {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || !event.isPrimary || !parentRef.current) return;
        event.preventDefault();
        document.getSelection()?.removeAllRanges();
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        const start = event.shiftKey && (mode === "unified" || anchor.current?.side === side) ? anchor.current?.ri ?? ri : ri;
        anchor.current = { ri: start, side };
        drag.current = { pointerId: event.pointerId, start, end: ri, side, y: event.clientY };
        suppressGestureClick.current = true;
        parentRef.current.setPointerCapture(event.pointerId);
        selectThrough(start, { line, ri, side });
      },
    };
  };

  const moveSelection = (autoScroll: boolean) => {
    const active = drag.current;
    const element = parentRef.current;
    if (!active || !element) return;
    const bounds = element.getBoundingClientRect();
    const y = active.y - bounds.top;
    const height = element.clientHeight;
    const distance = y < 24 ? y - 24 : y > height - 24 ? y - (height - 24) : 0;
    const before = element.scrollTop;
    if (autoScroll && distance) element.scrollTop += Math.max(-28, Math.min(28, distance / 2));
    const item = virt.getVirtualItemForOffset(element.scrollTop + Math.min(height - 1, Math.max(0, y)));
    const row = item && currentRows.current[item.index];
    if (row?.t === "line" && row.ri !== active.end && row.line.kind !== "meta") {
      active.end = row.ri;
      selectThrough(active.start, { line: row.line, ri: row.ri, side: active.side });
    } else if (row?.t === "split") {
      const right = active.side === "RIGHT";
      const line = right ? row.right : row.left;
      const ri = right ? row.ri.at(-1) : row.ri[0];
      if (line && ri !== undefined && ri !== active.end) {
        active.end = ri;
        selectThrough(active.start, { line, ri, side: active.side });
      }
    }
    if (autoScroll && before !== element.scrollTop) scheduleSelectionFrame();
  };

  const scheduleSelectionFrame = () => {
    if (dragFrame.current) return;
    dragFrame.current = requestAnimationFrame(() => {
      dragFrame.current = 0;
      moveSelection(true);
    });
  };
  const finishSelection = (event: React.PointerEvent<HTMLDivElement>, applyEndpoint = false) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    if (applyEndpoint && drag.current.y !== event.clientY) {
      drag.current.y = event.clientY;
      moveSelection(false);
    } else if (applyEndpoint && dragFrame.current) moveSelection(false);
    drag.current = null;
    cancelAnimationFrame(dragFrame.current);
    dragFrame.current = 0;
  };

  const hl = (text: string, ri?: number) => {
    const marks = ri === undefined ? undefined : find?.byRow.get(ri);
    const current = find?.current;
    return <CodeText path={props.path} text={text} query={marks ? undefined : highlight} marks={marks} currentCol={marks && current && current.ri === ri ? current.col : undefined} />;
  };


  const selected = (ri: number) => !!selection && ri >= selection[0] && ri < selection[1];

  // Frontier rail: drag down to mark lines up to that location reviewed (§5.3)
  const boundaries = useMemo(() => {
    const positions = new Array<number>(totalRows + 1).fill(0);
    let lastCodeEnd = 0;
    rows.forEach((r, i) => {
      const indices = r.t === "line" ? [r.ri] : r.t === "split" ? r.ri : [];
      if (!indices.length) return;
      lastCodeEnd = virt.measurementsCache[i]?.end ?? (i + 1) * LINE_HEIGHT;
      indices.forEach((index) => { positions[index + 1] = lastCodeEnd; });
    });
    for (let i = 1; i < positions.length; i++) positions[i] = Math.max(positions[i]!, positions[i - 1]!);
    positions[totalRows] = lastCodeEnd || layoutHeight;
    return positions;
  }, [rows, totalRows, layoutHeight, virt]);
  const railRef = useRef<HTMLDivElement>(null);
  const onRailDown = (e: React.PointerEvent) => {
    if (!review) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    moveFrontier(e.clientY);
  };
  const moveFrontier = (y: number) => {
    if (!review || !railRef.current) return;
    const offset = y - railRef.current.getBoundingClientRect().top;
    let low = 0;
    let high = boundaries.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (boundaries[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    review.setFrontier(low);
  };
  const onRailKey = (e: React.KeyboardEvent) => {
    if (!review) return;
    const step = e.shiftKey ? 50 : 1;
    if (e.key === "ArrowDown") { e.preventDefault(); review.setFrontier(review.state.frontier + step); }
    if (e.key === "ArrowUp") { e.preventDefault(); review.setFrontier(review.state.frontier - step); }
    if (e.key === "End") { e.preventDefault(); review.setFrontier(totalRows); }
    if (e.key === "Home") { e.preventDefault(); review.setFrontier(0); }
  };
  const yOf = (n: number) => boundaries[Math.max(0, Math.min(n, totalRows))] ?? 0;

  if (!hunks.length) return <div className="empty small">No textual changes (binary, mode-only, rename-only, or empty patch).</div>;

  return (
    <div ref={parentRef} className={`diff diff-scroll ${wrap ? "wrap-code" : ""} ${layout === "compact" ? "compact-code" : ""}`} style={{ height: props.height ?? "100%" }}
      onPointerDownCapture={() => { suppressGestureClick.current = false; }}
      onPointerMove={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current.y = event.clientY;
        scheduleSelectionFrame();
      }}
      onPointerUp={(event) => finishSelection(event, true)}
      onPointerCancel={finishSelection}
      onLostPointerCapture={finishSelection}
      onClickCapture={(event) => {
        if (!event.detail || !suppressGestureClick.current) return;
        suppressGestureClick.current = false;
        event.stopPropagation();
      }}>
      <div className="diff-content" style={{ height: layoutHeight, width: wrap ? undefined : `calc(${mode === "split" ? longest * 2 : longest}ch + ${(mode === "split" ? 155 : 135) + (review ? 18 : 0)}px)` }}>
      {review && totalRows > 0 && (
        <div
          ref={railRef}
          className="rail"
          style={{ height: yOf(totalRows) }}
          role="slider"
          tabIndex={0}
          aria-label="Reviewed frontier"
          aria-valuemin={0}
          aria-valuemax={totalRows}
          aria-valuenow={review.state.frontier}
          onPointerDown={onRailDown}
          onKeyDown={onRailKey}
          onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) moveFrontier(e.clientY); }}
          onPointerUp={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) moveFrontier(e.clientY); }}
          title="Drag down to mark lines reviewed. Arrow keys adjust; Shift = 50 lines."
        >
          <div className="fill" style={{ height: yOf(review.state.frontier) }} />
          {review.state.reviewed.map(([a, b], i) => (
            <div key={`r${i}`} className="seg" style={{ top: yOf(a), height: yOf(b) - yOf(a), background: "var(--ok)", opacity: 0.6 }} />
          ))}
          {review.state.flagged.map(([a, b], i) => (
            <div key={`f${i}`} className="seg" style={{ top: yOf(a), height: Math.max(yOf(b) - yOf(a), 3), background: "var(--warn)" }} />
          ))}
          {review.state.stale.map(([a, b], i) => (
            <div key={`s${i}`} className="seg" style={{ top: yOf(a), height: Math.max(yOf(b) - yOf(a), 3), background: "var(--err)" }} />
          ))}
          <div className="handle" style={{ top: `clamp(3px, ${yOf(review.state.frontier)}px, calc(100% - 3px))` }} />
        </div>
      )}
        <div className="diff-rows">
          {virt.getVirtualItems().map((vi) => {
            const r = rows[vi.index]!;
            const measure = wrap ? { ref: virt.measureElement, "data-index": vi.index } : {};
            const style = { position: "absolute" as const, top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` };
            if (r.t === "annotation") {
              return <div key={vi.key} ref={virt.measureElement} data-index={vi.index} className="diff-annotation" style={style}>{annotations?.get(r.ri)}</div>;
            }
            if (r.t === "hunk") {
              return (
                <div key={vi.key} {...measure} style={style} className="dl hunk">
                  <span className="no" />
                  <span className="no">
                    {onExpand && (
                      <button className="btn ghost sm" style={{ height: 18, padding: "0 4px" }} aria-expanded={expansions?.has(r.hi) ?? false} title={expansions?.has(r.hi) ? "Collapse expanded context" : "Expand to enclosing block"} onClick={() => onExpand(r.hi, r.hunk)}>
                        {expansions?.has(r.hi) ? "⤓" : "⤒"}
                      </button>
                    )}
                  </span>
                  <span />
                  <span className="code">{r.hunk.header}</span>
                </div>
              );
            }
            if (r.t === "ctx") {
              return (
                <div key={vi.key} {...measure} style={style} className="dl" title={r.label ? `Expanded (${r.label})` : "Expanded context"}>
                  <span className="no" />
                  <span className="no">{r.no}</span>
                  <span className="sign"> </span>
                  <span className="code faint">{hl(r.text)}</span>
                </div>
              );
            }
            if (r.t === "line") {
              const l = r.line;
              const cls = l.kind === "add" ? "add" : l.kind === "del" ? "del" : "";
              return (
                <div key={vi.key} {...measure} style={style} className={`dl ${cls} ${reviewedAt(r.ri)} ${selected(r.ri) ? "sel" : ""}`} onContextMenu={(e) => onLineContext?.(e, r.ri, l)}>
                  <span className="no" {...gutter(l, r.ri, "LEFT")}>
                    {l.oldNo ?? ""}
                  </span>
                  <span className="no" {...gutter(l, r.ri, "RIGHT")}>
                    {l.newNo ?? ""}
                  </span>
                  <span className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : l.kind === "meta" ? "\\" : " "}</span>
                  <span className="code" onClick={onCodeClick ? (e) => onCodeClick(e, r.ri, l) : undefined}>
                    {hl(l.text, r.ri)}
                  </span>
                </div>
              );
            }
            const left = r.left;
            const right = r.right;
            const rc = r.ri.map(reviewedAt).find(Boolean) ?? "";
            const leftSelected = props.selectionSide !== "RIGHT" && !!left && selected(r.ri[0]!);
            const rightSelected = props.selectionSide !== "LEFT" && !!right && selected(r.ri[r.ri.length - 1]!);
            return (
              <div key={vi.key} {...measure} style={style} className={`dl split-line ${rc} ${leftSelected || rightSelected ? "sel" : ""}`}
                data-selected-left={leftSelected || undefined} data-selected-right={rightSelected || undefined}
                onContextMenu={(e) => {
                const cell = e.target instanceof Element ? e.target.closest(".dl > span") : null;
                const useRight = !left || (!!right && cell !== null && Array.from(e.currentTarget.children).indexOf(cell) >= 3);
                const line = useRight ? right : left;
                const i = useRight ? r.ri.at(-1) : r.ri[0];
                if (line && i !== undefined) onLineContext?.(e, i, line, useRight ? "RIGHT" : "LEFT");
              }}>
                <span className={`no ${left && left.kind === "del" ? "del" : ""}`} {...gutter(left, r.ri[0], "LEFT")}>
                  {left?.oldNo ?? ""}
                </span>
                <span className={`sign ${left?.kind === "del" ? "del" : left ? "" : "empty-side"}`}>{left?.kind === "del" ? "−" : " "}</span>
                <span className={`code ${left?.kind === "del" ? "del" : left ? "" : "empty-side"}`} onClick={onCodeClick && left ? (e) => onCodeClick(e, r.ri[0]!, left, "LEFT") : undefined}>{left ? hl(left.text, r.ri[0]) : ""}</span>
                <span className={`no ${right?.kind === "add" ? "add" : ""}`} {...gutter(right, r.ri.at(-1), "RIGHT")}>
                  {right?.newNo ?? ""}
                </span>
                <span className={`sign ${right?.kind === "add" ? "add" : right ? "" : "empty-side"}`}>{right?.kind === "add" ? "+" : " "}</span>
                <span className={`code ${right?.kind === "add" ? "add" : right ? "" : "empty-side"}`} onClick={onCodeClick && right ? (e) => onCodeClick(e, r.ri.at(-1)!, right, "RIGHT") : undefined}>
                  {right ? hl(right.text, r.ri.at(-1)) : ""}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Starting review row of each hunk (for n/p navigation). */
export function hunkStarts(hunks: Hunk[]): number[] {
  const out: number[] = [];
  let ri = 0;
  for (const h of hunks) {
    out.push(ri);
    ri += h.lines.length;
  }
  return out;
}

export function totalRowsOf(hunks: Hunk[]): number {
  return hunks.reduce((n, h) => n + h.lines.length, 0);
}
