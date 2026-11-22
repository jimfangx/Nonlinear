import { lazy, Suspense, useEffect } from "react";
import { HashRouter, NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { useApp, useSettings } from "./lib/store";
import { CommandPalette } from "./components/CommandPalette";
import { CloudGlue } from "./components/CloudGlue";
import { Toasts, timeAgo } from "./components/ui";
import { keyLabel } from "./lib/keys";
const Inbox = lazy(() => import("./workspaces/Inbox").then((m) => ({ default: m.Inbox })));
const ReviewHome = lazy(() => import("./workspaces/Review").then((m) => ({ default: m.ReviewHome })));
const ReviewPR = lazy(() => import("./workspaces/Review").then((m) => ({ default: m.ReviewPR })));
const Board = lazy(() => import("./workspaces/Board").then((m) => ({ default: m.Board })));
const DiffWorkspace = lazy(() => import("./workspaces/DiffViewer").then((m) => ({ default: m.DiffWorkspace })));
const TimelineWorkspace = lazy(() => import("./workspaces/Timeline").then((m) => ({ default: m.TimelineWorkspace })));
const GitGraph = lazy(() => import("./workspaces/GitGraph").then((m) => ({ default: m.GitGraph })));
const Releases = lazy(() => import("./workspaces/Releases").then((m) => ({ default: m.Releases })));
const SettingsPage = lazy(() => import("./workspaces/Settings").then((m) => ({ default: m.SettingsPage })));
import { startSyncLoop } from "./lib/sync";

export function App() {
  const loaded = useApp((s) => s.loaded);
  useEffect(() => {
    void useApp.getState().load();
  }, []);
  if (!loaded) return <div className="empty">Loading local data…</div>;
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  );
}

function Shell() {
  const settings = useSettings();
  useEffect(() => {
    const el = document.documentElement;
    if (settings.theme === "system") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", settings.theme);
  }, [settings.theme]);
  useEffect(() => startSyncLoop(), []);
  return (
    <div className="app">
      <button
        className="skip-link"
        onClick={() => {
          const m = document.getElementById("main-content");
          const target = (m?.querySelector("h1, input, button, [tabindex]") as HTMLElement | null) ?? m;
          if (target && !target.hasAttribute("tabindex") && target.tagName === "H1") target.setAttribute("tabindex", "-1");
          target?.focus();
        }}
      >
        Skip to content
      </button>
      <TopBar />
      <Sidebar />
      <main className="main" id="main-content" tabIndex={-1}>
        <Suspense fallback={<div className="empty">Loading…</div>}>
        <Routes>
          <Route path="/" element={<Navigate to="/inbox" replace />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/inbox/:viewId" element={<Inbox />} />
          <Route path="/review" element={<ReviewHome />} />
          <Route path="/pr/:owner/:repo/:number" element={<ReviewPR />} />
          <Route path="/pr/:owner/:repo/:number/:tab" element={<ReviewPR />} />
          <Route path="/timeline" element={<TimelineWorkspace />} />
          <Route path="/timeline/:id" element={<TimelineWorkspace />} />
          <Route path="/board" element={<Board />} />
          <Route path="/board/:context" element={<Board />} />
          <Route path="/diff" element={<DiffWorkspace />} />
          <Route path="/diff/:id" element={<DiffWorkspace />} />
          <Route path="/graph" element={<GitGraph />} />
          <Route path="/graph/:owner/:repo" element={<GitGraph />} />
          <Route path="/releases" element={<Releases />} />
          <Route path="/releases/:id" element={<Releases />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<div className="empty">Not found</div>} />
        </Routes>
        </Suspense>
      </main>
      <CommandPalette />
      <CloudGlue />
      <Toasts />
    </div>
  );
}

function TopBar() {
  const online = useApp((s) => s.online);
  const rate = useApp((s) => s.rateLimit);
  const s = useSettings();
  const setSettings = useApp((x) => x.setSettings);
  const pendingIntentions = useApp((x) => Object.values(x.intentions).filter((i) => i.status === "queued" || i.status === "needs-confirmation").length);
  const nav = useNavigate();
  const conflicts = useApp((x) => Object.keys(x.syncConflicts).length);
  return (
    <header className="topbar">
      <div className="brand">
        <img src="./icon.svg" alt="" /> Nonlinear
      </div>
      <button className="btn ghost" style={{ minWidth: 280, justifyContent: "space-between" }} onClick={() => window.dispatchEvent(new Event("nonlinear:palette"))}>
        <span className="faint">Search or jump to…</span>
        <span className="kbd" aria-hidden="true">{keyLabel("palette")}</span>
      </button>
      <span className="spacer" />
      {pendingIntentions > 0 && (
        <button className="chip warn" onClick={() => nav("/settings#intentions")} title="GitHub writes waiting for your confirmation">
          ◷ {pendingIntentions} pending
        </button>
      )}
      {conflicts > 0 && (
        <button className="chip err" onClick={() => nav("/settings")} title="Concurrent edits from another device need your decision">
          ⚠ {conflicts} sync conflict{conflicts > 1 ? "s" : ""}
        </button>
      )}
      {rate && (
        <span className={`chip ${rate.remaining < rate.limit * 0.1 ? "warn" : ""}`} title={`Resets ${new Date(rate.resetAt).toLocaleTimeString()}`}>
          API {rate.remaining}/{rate.limit}
        </span>
      )}
      <span className={`chip ${online ? "ok" : "warn"}`} role="status">
        {online ? "● Online" : "○ Offline — cached"}
      </span>
      <span className="chip" title={s.publicOnly ? "Private repositories are hidden and rejected" : "Private repos allowed for fine-grained tokens"}>
        {s.publicOnly ? "🔒 Public-only" : "Private allowed"}
      </span>
      <span className="chip">{s.me ? `@${s.me}` : "Anonymous"}</span>
      <button
        className="btn ghost sm"
        aria-label="Toggle theme"
        onClick={() => setSettings({ theme: s.theme === "system" ? "dark" : s.theme === "dark" ? "light" : "system" })}
        title={`Theme: ${s.theme}`}
      >
        {s.theme === "dark" ? "☾" : s.theme === "light" ? "☀" : "◐"}
      </button>
    </header>
  );
}

function Sidebar() {
  const views = useApp((s) => s.views);
  const releases = useApp((s) => s.releases);
  const timelines = useApp((s) => s.timelines);
  const prLocal = useApp((s) => s.prLocal);
  const prs = useApp((s) => s.prs);
  const settings = useSettings();
  const pinned = Object.entries(prLocal).filter(([, a]) => a.pinned).map(([k]) => prs[k]).filter(Boolean);
  const link = (to: string, label: React.ReactNode, extra?: React.ReactNode) => (
    <NavLink to={to} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
      {label}
      {extra}
    </NavLink>
  );
  return (
    <nav className="sidebar" aria-label="Primary">
      {link("/inbox", <>📥 PR Inbox</>)}
      {link("/timeline", <>⏱ Submodule Timeline</>)}
      {link("/board", <>▦ Board</>)}
      {link("/review", <>👁 Review</>)}
      {link("/diff", <>⇄ Multi-Repo Diff</>)}
      {link("/graph", <>⑂ Git Graph</>)}

      <div className="nav-section">Views</div>
      {Object.values(views).sort((a, b) => a.name.localeCompare(b.name)).map((v) => link(`/inbox/${v.id}`, <span className="ellipsis">{v.name}</span>, <span className="faint small" style={{ marginLeft: "auto" }}>{v.repos.length}</span>))}

      <div className="nav-section">
        Releases <NavLink to="/releases" className="faint">manage</NavLink>
      </div>
      {Object.values(releases).filter((r) => r.state !== "archived").map((r) =>
        link(`/releases/${r.id}`, <><span className="dot" style={{ background: r.color }} /> <span className="ellipsis">{r.name}</span></>, <span className="faint small" style={{ marginLeft: "auto" }}>{r.state === "frozen" ? "❄" : ""}</span>),
      )}

      {Object.keys(timelines).length > 0 && <div className="nav-section">Timelines</div>}
      {Object.values(timelines).filter((t) => !t.parentTimelineId).map((t) => link(`/timeline/${t.id}`, <span className="ellipsis">{t.name}</span>))}

      {pinned.length > 0 && <div className="nav-section">Pinned PRs</div>}
      {pinned.map((p) => link(`/pr/${p!.owner}/${p!.repo}/${p!.number}`, <span className="ellipsis">📌 {p!.repo}#{p!.number} {p!.title}</span>))}

      <div className="nav-section">Sync</div>
      <div className="nav-item faint small" style={{ cursor: "default" }}>
        {settings.syncEnabled ? (settings.lastSyncError ? `⚠ ${settings.lastSyncError}` : `Synced ${timeAgo(settings.lastSyncAt)}`) : "Local only (sync off)"}
      </div>
      {link("/settings", <>⚙ Settings</>)}
    </nav>
  );
}
