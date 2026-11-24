import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PRSnapshot, EdgeSyncStatus } from "@nonlinear/core";
import { useApp } from "../lib/store";

/* ---------------- Split pane (keyboard-resizable, persisted) ---------------- */

export function Split({
  id,
  vertical = false,
  initial = 0.35,
  min = 0.12,
  showSecond = true,
  showFirst = true,
  className = "",
  children,
}: {
  id: string;
  vertical?: boolean;
  initial?: number;
  min?: number;
  showSecond?: boolean;
  showFirst?: boolean;
  className?: string;
  children: [ReactNode, ReactNode];
}) {
  const saved = useApp((s) => (s.settings.main?.layout?.[`split:${id}`] as number | undefined) ?? initial);
  const [ratio, setRatio] = useState(saved);
  const ref = useRef<HTMLDivElement>(null);
  const secondPresent = useAnimatedPresence(showSecond);
  const lastSecond = useRef<ReactNode>(null);
  useLayoutEffect(() => {
    if (showSecond) lastSecond.current = children[1];
  }, [showSecond, children[1]]);
  const closingSecond = secondPresent && !showSecond;
  const persist = useCallback(
    (r: number) => {
      const st = useApp.getState();
      st.setSettings({ layout: { ...st.settings_().layout, [`split:${id}`]: r } });
    },
    [id],
  );
  const clamp = (r: number) => Math.max(min, Math.min(1 - min, r));
  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = ref.current!;
    const rect = el.getBoundingClientRect();
    let last = ratio;
    const move = (ev: PointerEvent) => {
      last = clamp(vertical ? (ev.clientY - rect.top) / rect.height : (ev.clientX - rect.left) / rect.width);
      setRatio(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      persist(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const d = e.shiftKey ? 0.1 : 0.02;
    const dec = vertical ? "ArrowUp" : "ArrowLeft";
    const inc = vertical ? "ArrowDown" : "ArrowRight";
    if (e.key === dec || e.key === inc) {
      e.preventDefault();
      const r = clamp(ratio + (e.key === inc ? d : -d));
      setRatio(r);
      persist(r);
    }
  };
  return (
    <div ref={ref} className={`split ${vertical ? "vertical" : ""} ${className}`}>
      <div className="pane" hidden={!showFirst} style={{ flexBasis: secondPresent ? `${ratio * 100}%` : "100%", flexGrow: 0, flexShrink: 0 }}>
        {children[0]}
      </div>
      <div
        className="splitter"
        hidden={!showFirst || !secondPresent}
        inert={closingSecond}
        role="separator"
        aria-orientation={vertical ? "horizontal" : "vertical"}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        onPointerDown={onDown}
        onKeyDown={onKey}
      />
      <div className="pane split-secondary" style={{ flex: 1 }} hidden={!secondPresent}
        inert={closingSecond} data-closing={closingSecond || undefined}>
        {closingSecond ? lastSecond.current : children[1]}
      </div>
    </div>
  );
}

/* ---------------- Modal ---------------- */

export function useAnimatedPresence(open: boolean): boolean {
  const [exiting, setExiting] = useState(open);
  useEffect(() => {
    if (open) {
      setExiting(true);
      return;
    }
    if (!exiting) return;
    const timer = window.setTimeout(() => setExiting(false), window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 150);
    return () => window.clearTimeout(timer);
  }, [open, exiting]);
  return open || (exiting && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

export function Modal({ title, onClose, children, footer, wide, open: openProp }: { open?: boolean; title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const open = openProp ?? true;
  const titleId = useId();
  const [closing, setClosing] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const overlay = useRef<HTMLDivElement>(null);
  const present = useAnimatedPresence(open);
  const dismiss = () => {
    if (!open || closing) return;
    if (openProp !== undefined || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) onClose();
    else setClosing(true);
  };
  useEffect(() => {
    if (!open || !closing) return;
    const timer = window.setTimeout(() => {
      onCloseRef.current();
      setClosing(false);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [open, closing]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    overlay.current?.querySelector<HTMLElement>("[aria-label=Close]")?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && e.key === "Escape" && [...document.querySelectorAll(".overlay")].filter((element) => !element.closest("[inert]")).at(-1) === overlay.current) dismiss();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose, open, closing]);
  if (!present) return null;
  // Portaled to <body>: an ancestor with backdrop-filter/transform (e.g. the
  // top bar when a background image is set) would otherwise trap the fixed
  // overlay inside its own box and stacking context.
  return createPortal(
    <div ref={overlay} className="overlay" data-closing={(!open || closing) || undefined} inert={!open || closing} onMouseDown={(e) => e.target === e.currentTarget && dismiss()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} style={wide ? { width: "min(960px, 94vw)" } : undefined}>
        <div className="head">
          <span className="grow" id={titleId}>{title}</span>
          <button className="btn ghost sm" onClick={dismiss} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="body">{children}</div>
        {footer && <div className="foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ---------------- Toasts ---------------- */

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismiss);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="grow">{t.text}</span>
          <button className="btn ghost sm" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Status chips (never color alone) ---------------- */

export function PRStateChip({ pr }: { pr: PRSnapshot }) {
  if (pr.state === "merged") return <span className="chip accent">⇲ Merged</span>;
  if (pr.state === "closed") return <span className="chip err">✕ Closed</span>;
  if (pr.draft) return <span className="chip">◌ Draft</span>;
  return <span className="chip ok">● Open</span>;
}

export function CIChip({ ci }: { ci: PRSnapshot["ci"] }) {
  switch (ci) {
    case "passing":
      return <span className="chip ok" title="CI passing">✓ CI</span>;
    case "failing":
      return <span className="chip err" title="CI failing">✕ CI</span>;
    case "running":
      return <span className="chip warn" title="CI running">◷ CI</span>;
    case "none":
      return <span className="chip" title="No CI">– CI</span>;
    default:
      return <span className="chip" title="CI unknown">? CI</span>;
  }
}

export function ReviewChip({ d }: { d: PRSnapshot["reviewDecision"] }) {
  switch (d) {
    case "approved":
      return <span className="chip ok">✓ Approved</span>;
    case "changes-requested":
      return <span className="chip err">± Changes</span>;
    case "review-required":
      return <span className="chip warn">○ Review</span>;
    case "none":
      return <span className="chip">– No reviews</span>;
    default:
      return <span className="chip">? Review</span>;
  }
}

export function SyncChip({ s }: { s: EdgeSyncStatus }) {
  const m: Record<EdgeSyncStatus, [string, string]> = {
    synced: ["ok", "⇄ Synced"],
    "local-only": ["", "◍ Local only"],
    pending: ["warn", "◷ Pending"],
    conflict: ["err", "⚠ Conflict"],
  };
  return <span className={`chip ${m[s][0]}`}>{m[s][1]}</span>;
}

export function memberState(pr: PRSnapshot | undefined): { label: string; cls: string } {
  if (!pr) return { label: "unknown", cls: "" };
  if (pr.state === "merged") return { label: "merged", cls: "accent" };
  if (pr.state === "closed") return { label: "closed-unmerged", cls: "err" };
  if (pr.draft) return { label: "draft", cls: "" };
  if (pr.ci === "failing") return { label: "CI failing", cls: "err" };
  if (pr.ci === "running") return { label: "CI running", cls: "warn" };
  if (pr.reviewDecision === "approved" && pr.mergeable) return { label: "mergeable", cls: "ok" };
  if (pr.reviewDecision === "approved") return { label: "approved", cls: "ok" };
  return { label: "open", cls: "info" };
}

export function timeAgo(iso: string | number | null | undefined): string {
  if (!iso) return "—";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
}

export function Confirm({ title, children, confirmLabel = "Confirm", danger, onConfirm, onClose }: { title: string; children: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? "danger" : "primary"}`}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Modal>
  );
}

export function download(name: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------------- Diff stats (+ / − with a proportional block bar) ---------------- */

export function DiffStat({ additions, deletions, blocks = 5, compact = false }: { additions: number; deletions: number; blocks?: number; compact?: boolean }) {
  const total = additions + deletions;
  const add = total ? Math.round((additions / total) * blocks) : 0;
  const del = total ? Math.min(blocks - add, Math.round((deletions / total) * blocks)) : 0;
  return (
    <span className={`diffstat ${compact ? "compact" : ""}`} title={`${additions.toLocaleString()} additions, ${deletions.toLocaleString()} deletions`}>
      <span className="diffstat-add">+{additions.toLocaleString()}</span>
      <span className="diffstat-del">−{deletions.toLocaleString()}</span>
      <span className="diffstat-bar" aria-hidden="true">
        {Array.from({ length: blocks }, (_, i) => <i key={i} className={i < add ? "a" : i < add + del ? "d" : ""} />)}
      </span>
    </span>
  );
}

/* ---------------- In-app confirmation ---------------- */
// window.confirm() is a no-op in the macOS desktop webview (it returns false without showing
// anything), so every confirmation goes through this dialog instead.

interface ConfirmRequest { title: string; body: ReactNode; confirmLabel: string; danger: boolean; resolve: (ok: boolean) => void }
let showConfirm: ((r: ConfirmRequest) => void) | null = null;

export function askConfirm(o: { title: string; body: ReactNode; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    if (!showConfirm) return resolve(false);
    showConfirm({ title: o.title, body: o.body, confirmLabel: o.confirmLabel ?? "Continue", danger: o.danger ?? false, resolve });
  });
}

/** Mounted once in the app shell; renders requests from askConfirm(). */
export function ConfirmHost() {
  const [req, setReq] = useState<ConfirmRequest | null>(null);
  useEffect(() => {
    showConfirm = (r) => setReq((cur) => { cur?.resolve(false); return r; });
    return () => { showConfirm = null; };
  }, []);
  if (!req) return null;
  const done = (ok: boolean) => { req.resolve(ok); setReq(null); };
  return (
    <Modal open title={req.title} onClose={() => done(false)}
      footer={<>
        <span className="spacer" />
        <button className="btn" onClick={() => done(false)}>Cancel</button>
        <button className={`btn ${req.danger ? "danger" : "primary"}`} autoFocus onClick={() => done(true)}>{req.confirmLabel}</button>
      </>}>
      <div>{req.body}</div>
    </Modal>
  );
}
