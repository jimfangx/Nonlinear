import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { parsePRRef, prKey } from "@nonlinear/core";
import { useApp } from "../lib/store";
import { useOverlayPresence } from "./ui";
import { invoke, isDesktop } from "../lib/platform";
import { useActions } from "../lib/keys";

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const nav = useNavigate();
  const location = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const present = useOverlayPresence(open);
  const lastPress = useRef(0);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const release = (e: KeyboardEvent) => {
      if (e.key === "Meta" || e.key === "Control") lastPress.current = 0;
    };
    const reset = () => { lastPress.current = 0; };
    window.addEventListener("keyup", release);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keyup", release);
      window.removeEventListener("blur", reset);
    };
  }, []);
  useEffect(() => {
    const h = () => setOpen(true);
    window.addEventListener("nonlinear:palette", h);
    return () => window.removeEventListener("nonlinear:palette", h);
  }, []);
  useEffect(() => setOpen(false), [location.key]);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setIdx(0);
    const focus = window.setTimeout(() => inputRef.current?.focus(), 0);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", escape, true);
    return () => {
      window.clearTimeout(focus);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open]);

  const st = useApp();
  const cmds = useMemo<Cmd[]>(() => {
    const base: Cmd[] = [
      { id: "inbox", label: "Go to PR Inbox", hint: "workspace", run: () => nav("/inbox") },
      { id: "timeline", label: "Go to Submodule Timeline", hint: "workspace", run: () => nav("/timeline") },
      { id: "board", label: "Go to Board", hint: "workspace", run: () => nav("/board") },
      { id: "review", label: "Go to Review", hint: "workspace", run: () => nav("/review") },
      { id: "diff", label: "Go to Multi-Repo Diff", hint: "workspace", run: () => nav("/diff") },
      { id: "graph", label: "Go to Git Graph", hint: "workspace", run: () => nav("/graph") },
      { id: "releases", label: "Manage releases", hint: "releases", run: () => nav("/releases") },
      { id: "settings", label: "Settings", run: () => nav("/settings") },
      { id: "reload", label: "Reload app", run: () => window.location.reload() },
      ...(isDesktop() ? [{ id: "devtools", label: "Open developer tools", run: () => {
        void invoke("open_devtools").catch((error) => st.toast("error", String(error)));
      } }] : []),
      { id: "theme", label: "Toggle theme", run: () => st.setSettings({ theme: st.settings_().theme === "dark" ? "light" : "dark" }) },
    ];
    for (const v of Object.values(st.views)) base.push({ id: `view:${v.id}`, label: `View: ${v.name}`, hint: `${v.repos.length} repos`, run: () => nav(`/inbox/${v.id}`) });
    for (const r of Object.values(st.releases)) base.push({ id: `rel:${r.id}`, label: `Release: ${r.name}`, hint: r.state, run: () => nav(`/releases/${r.id}`) });
    for (const t of Object.values(st.timelines)) base.push({ id: `tl:${t.id}`, label: `Timeline: ${t.name}`, hint: t.root, run: () => nav(`/timeline/${t.id}`) });
    for (const p of Object.values(st.prs).slice(0, 400)) base.push({ id: `pr:${p.key}`, label: `${p.key} ${p.title}`, hint: "PR", run: () => nav(`/pr/${p.owner}/${p.repo}/${p.number}`) });
    const ref = parsePRRef(q.trim());
    if (ref) base.unshift({ id: "open-ref", label: `Open ${prKey(ref)} in PR Inbox`, hint: "PR", run: () => nav(`/pr/${ref.owner}/${ref.repo}/${ref.number}`) });
    return base;
  }, [st, nav, q]);

  const filtered = useMemo(() => {
    const t = q.toLowerCase().split(/\s+/).filter(Boolean);
    return cmds.filter((c) => c.id === "open-ref" || t.every((w) => c.label.toLowerCase().includes(w) || c.hint?.toLowerCase().includes(w))).slice(0, 50);
  }, [cmds, q]);

  useActions({ palette: (event) => {
    if (event.repeat) return;
    const now = performance.now();
    if (open && lastPress.current && now - lastPress.current < 450) {
      if (filtered.length) setIdx((i) => (i + 1) % filtered.length);
    } else {
      setOpen(!open);
    }
    lastPress.current = now;
  } });

  useEffect(() => {
    if (open) document.getElementById(`cmd-${idx}`)?.scrollIntoView?.({ block: "nearest" });
  }, [idx, open]);

  if (!present) return null;
  return (
    <div className="overlay" data-closing={!open || undefined} inert={!open} onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="modal palette" role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          value={q}
          placeholder="Type a command, PR (owner/repo#123 or URL), view…"
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(filtered.length - 1, i + 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
            if (e.key === "Enter" && filtered[idx]) {
              filtered[idx]!.run();
              setOpen(false);
            }
          }}
          aria-activedescendant={filtered[idx] ? `cmd-${idx}` : undefined}
        />
        <div role="listbox">
          {filtered.map((c, i) => (
            <div
              id={`cmd-${i}`}
              key={c.id}
              role="option"
              aria-selected={i === idx}
              className={`item ${i === idx ? "active" : ""}`}
              onPointerMove={(e) => {
                if (pointer.current?.x === e.clientX && pointer.current.y === e.clientY) return;
                pointer.current = { x: e.clientX, y: e.clientY };
                setIdx(i);
              }}
              onClick={() => {
                c.run();
                setOpen(false);
              }}
            >
              <span className="grow ellipsis">{c.label}</span>
              {c.hint && <span className="faint small">{c.hint}</span>}
            </div>
          ))}
          {!filtered.length && <div className="item faint">No matches</div>}
        </div>
      </div>
    </div>
  );
}
