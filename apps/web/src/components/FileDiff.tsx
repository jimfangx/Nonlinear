import { useMemo, useRef, useState, useEffect, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { parseFileHunks, toSplitRows, contains, type DiffLine, type Hunk, type FileReviewState, type Interval } from "@nonlinear/core";

export type DiffMode = "unified" | "split";

/** One display row. `ri` = review row index (into flattened hunk lines) or null. */
type Row =
  | { t: "hunk"; hunk: Hunk; hi: number }
  | { t: "line"; line: DiffLine; ri: number; hi: number }
  | { t: "split"; left: DiffLine | null; right: DiffLine | null; ri: number[]; hi: number }
  | { t: "ctx"; text: string; no: number; label?: string };

export interface ReviewOverlay {
  state: FileReviewState;
  setFrontier: (row: number) => void;
}

export interface FileDiffProps {
  section: string;
  mode: DiffMode;
  /** extra context lines above hunk i (from semantic expansion) */
  expansions?: Map<number, { lines: string[]; startNo: number; label?: string }>;
  onExpand?: (hunkIndex: number, hunk: Hunk) => void;
  review?: ReviewOverlay;
  selection?: Interval | null;
  onSelect?: (iv: Interval | null, anchor: { line: DiffLine; ri: number } | null) => void;
  highlight?: string;
  /** annotations per review row (comments/notes markers) */
  markers?: Map<number, ReactNode>;
  height?: number | string;
  scrollToRow?: number | null;
}

export function useHunks(section: string): Hunk[] {
  return useMemo(() => parseFileHunks(section), [section]);
}

export function FileDiff(props: FileDiffProps) {
  const { section, mode, expansions, onExpand, review, selection, onSelect, highlight, markers } = props;
  const hunks = useHunks(section);
  const rows = useMemo(() => {
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

  const totalRows = useMemo(() => hunks.reduce((n, h) => n + h.lines.length, 0), [hunks]);
  const parentRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => 20, overscan: 30 });
  const [anchor, setAnchor] = useState<number | null>(null);

  useEffect(() => {
    if (props.scrollToRow == null) return;
    const i = rows.findIndex((r) => (r.t === "line" && r.ri >= props.scrollToRow!) || (r.t === "split" && r.ri.some((x) => x >= props.scrollToRow!)));
    if (i >= 0) virt.scrollToIndex(i, { align: "start" });
  }, [props.scrollToRow, rows, virt]);

  const reviewedAt = (ri: number) => {
    if (!review) return "";
    const s = review.state;
    if (contains(s.stale, ri)) return "stale";
    if (contains(s.flagged, ri)) return "flagged";
    if (ri < s.frontier || contains(s.reviewed, ri)) return "reviewed";
    return "";
  };

  const clickLine = (e: React.MouseEvent, ri: number, line: DiffLine) => {
    if (!onSelect) return;
    if (e.shiftKey && anchor !== null) {
      onSelect([Math.min(anchor, ri), Math.max(anchor, ri) + 1], { line, ri });
    } else {
      setAnchor(ri);
      onSelect([ri, ri + 1], { line, ri });
    }
  };

  const hl = (text: string): ReactNode => {
    if (!highlight) return text;
    const i = text.toLowerCase().indexOf(highlight.toLowerCase());
    if (i < 0) return text;
    return (
      <>
        {text.slice(0, i)}
        <mark>{text.slice(i, i + highlight.length)}</mark>
        {text.slice(i + highlight.length)}
      </>
    );
  };

  const selected = (ri: number) => !!selection && ri >= selection[0] && ri < selection[1];

  // Frontier rail: drag down to mark lines up to that location reviewed (§5.3)
  const railRef = useRef<HTMLDivElement>(null);
  const onRailDown = (e: React.PointerEvent) => {
    if (!review) return;
    e.preventDefault();
    const rect = railRef.current!.getBoundingClientRect();
    const toRow = (y: number) => Math.round(Math.max(0, Math.min(1, (y - rect.top) / rect.height)) * totalRows);
    review.setFrontier(toRow(e.clientY));
    const move = (ev: PointerEvent) => review.setFrontier(toRow(ev.clientY));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onRailKey = (e: React.KeyboardEvent) => {
    if (!review) return;
    const step = e.shiftKey ? 50 : 1;
    if (e.key === "ArrowDown") { e.preventDefault(); review.setFrontier(review.state.frontier + step); }
    if (e.key === "ArrowUp") { e.preventDefault(); review.setFrontier(review.state.frontier - step); }
    if (e.key === "End") { e.preventDefault(); review.setFrontier(totalRows); }
    if (e.key === "Home") { e.preventDefault(); review.setFrontier(0); }
  };
  const pct = (n: number) => `${totalRows ? (n / totalRows) * 100 : 0}%`;

  if (!hunks.length) return <div className="empty small">No textual changes (binary, mode-only, rename-only, or empty patch).</div>;

  return (
    <div className="row" style={{ alignItems: "stretch", gap: 4, height: props.height ?? "100%", minHeight: 0 }}>
      {review && (
        <div
          ref={railRef}
          className="rail"
          role="slider"
          tabIndex={0}
          aria-label="Reviewed frontier"
          aria-valuemin={0}
          aria-valuemax={totalRows}
          aria-valuenow={review.state.frontier}
          onPointerDown={onRailDown}
          onKeyDown={onRailKey}
          title="Drag down to mark lines reviewed. Arrow keys adjust; Shift = 50 lines."
        >
          <div className="fill" style={{ height: pct(review.state.frontier) }} />
          {review.state.reviewed.map(([a, b], i) => (
            <div key={`r${i}`} className="seg" style={{ top: pct(a), height: pct(b - a), background: "var(--ok)", opacity: 0.6 }} />
          ))}
          {review.state.flagged.map(([a, b], i) => (
            <div key={`f${i}`} className="seg" style={{ top: pct(a), height: `max(${pct(b - a)}, 3px)`, background: "var(--warn)" }} />
          ))}
          {review.state.stale.map(([a, b], i) => (
            <div key={`s${i}`} className="seg" style={{ top: pct(a), height: `max(${pct(b - a)}, 3px)`, background: "var(--err)" }} />
          ))}
          <div className="handle" style={{ top: pct(review.state.frontier) }} />
        </div>
      )}
      <div ref={parentRef} className="diff grow" style={{ overflow: "auto", height: "100%" }}>
        <div style={{ height: virt.getTotalSize(), position: "relative", minWidth: "max-content", width: "100%" }}>
          {virt.getVirtualItems().map((vi) => {
            const r = rows[vi.index]!;
            const style = { position: "absolute" as const, top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` };
            if (r.t === "hunk") {
              return (
                <div key={vi.key} style={style} className="dl hunk">
                  <span className="no" />
                  <span className="no">
                    {onExpand && (
                      <button className="btn ghost sm" style={{ height: 18, padding: "0 4px" }} title="Expand to enclosing block" onClick={() => onExpand(r.hi, r.hunk)}>
                        ⤒
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
                <div key={vi.key} style={style} className="dl" title={r.label ? `Expanded (${r.label})` : "Expanded context"}>
                  <span className="no">{r.no}</span>
                  <span className="no">{r.no}</span>
                  <span className="sign"> </span>
                  <span className="code faint">{r.text}</span>
                </div>
              );
            }
            if (r.t === "line") {
              const l = r.line;
              const cls = l.kind === "add" ? "add" : l.kind === "del" ? "del" : "";
              return (
                <div key={vi.key} style={style} className={`dl ${cls} ${reviewedAt(r.ri)} ${selected(r.ri) ? "sel" : ""}`}>
                  <span className="no" onClick={(e) => clickLine(e, r.ri, l)}>
                    {l.oldNo ?? ""}
                  </span>
                  <span className="no" onClick={(e) => clickLine(e, r.ri, l)}>
                    {l.newNo ?? ""}
                  </span>
                  <span className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : l.kind === "meta" ? "\\" : " "}</span>
                  <span className="code">
                    {hl(l.text)}
                    {markers?.get(r.ri)}
                  </span>
                </div>
              );
            }
            const left = r.left;
            const right = r.right;
            const rc = r.ri.map(reviewedAt).find(Boolean) ?? "";
            const sel = r.ri.some(selected);
            return (
              <div key={vi.key} style={style} className={`dl split ${rc} ${sel ? "sel" : ""}`}>
                <span className={`no ${left && left.kind === "del" ? "del" : ""}`} onClick={(e) => left && clickLine(e, r.ri[0]!, left)}>
                  {left?.oldNo ?? ""}
                </span>
                <span className={`sign ${left?.kind === "del" ? "del" : left ? "" : "empty-side"}`}>{left?.kind === "del" ? "−" : " "}</span>
                <span className={`code ${left?.kind === "del" ? "del" : left ? "" : "empty-side"}`}>{left ? hl(left.text) : ""}</span>
                <span className={`no ${right?.kind === "add" ? "add" : ""}`} onClick={(e) => right && clickLine(e, r.ri[r.ri.length - 1]!, right)}>
                  {right?.newNo ?? ""}
                </span>
                <span className={`sign ${right?.kind === "add" ? "add" : right ? "" : "empty-side"}`}>{right?.kind === "add" ? "+" : " "}</span>
                <span className={`code ${right?.kind === "add" ? "add" : right ? "" : "empty-side"}`}>
                  {right ? hl(right.text) : ""}
                  {r.ri.map((x) => markers?.get(x)).filter(Boolean)}
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
