import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { PRSnapshot, EdgeSyncStatus } from "@nonlinear/core";
import { useApp } from "../lib/store";

/* ---------------- Split pane (keyboard-resizable, persisted) ---------------- */

export function Split({
  id,
  vertical = false,
  initial = 0.35,
  min = 0.12,
  children,
}: {
  id: string;
  vertical?: boolean;
  initial?: number;
  min?: number;
  children: [ReactNode, ReactNode];
}) {
  const saved = useApp((s) => (s.settings.main?.layout?.[`split:${id}`] as number | undefined) ?? initial);
  const [ratio, setRatio] = useState(saved);
  const ref = useRef<HTMLDivElement>(null);
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
    <div ref={ref} className={`split ${vertical ? "vertical" : ""}`}>
      <div className="pane" style={{ flexBasis: `${ratio * 100}%`, flexGrow: 0, flexShrink: 0 }}>
        {children[0]}
      </div>
      <div
        className="splitter"
        role="separator"
        aria-orientation={vertical ? "horizontal" : "vertical"}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        onPointerDown={onDown}
        onKeyDown={onKey}
      />
      <div className="pane" style={{ flex: 1 }}>
        {children[1]}
      </div>
    </div>
  );
}

/* ---------------- Modal ---------------- */

export function Modal({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" style={wide ? { width: "min(960px, 94vw)" } : undefined}>
        <div className="head">
          <span className="grow">{title}</span>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="body">{children}</div>
        {footer && <div className="foot">{footer}</div>}
      </div>
    </div>
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
