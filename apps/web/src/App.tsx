import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { HashRouter, NavLink, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { useApp, useSettings } from "./lib/store";
import { CommandPalette } from "./components/CommandPalette";
import { CloudGlue } from "./components/CloudGlue";
import { Modal, Toasts, timeAgo } from "./components/ui";
import { keyLabel, useActions } from "./lib/keys";
const Inbox = lazy(() => import("./workspaces/Inbox").then((m) => ({ default: m.Inbox })));
const ReviewHome = lazy(() => import("./workspaces/Review").then((m) => ({ default: m.ReviewHome })));
const ReviewPR = lazy(() => import("./workspaces/Review").then((m) => ({ default: m.ReviewPR })));
const Board = lazy(() => import("./workspaces/Board").then((m) => ({ default: m.Board })));
const DiffWorkspace = lazy(() => import("./workspaces/DiffViewer").then((m) => ({ default: m.DiffWorkspace })));
const TimelineWorkspace = lazy(() => import("./workspaces/Timeline").then((m) => ({ default: m.TimelineWorkspace })));
const GitGraph = lazy(() => import("./workspaces/GitGraph").then((m) => ({ default: m.GitGraph })));
const Releases = lazy(() => import("./workspaces/Releases").then((m) => ({ default: m.Releases })));
const SettingsPage = lazy(() => import("./workspaces/Settings").then((m) => ({ default: m.SettingsPage })));
import { isDesktop, invoke } from "./lib/platform";
import { NavIcon } from "./components/NavIcon";
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
  const nav = useNavigate();
  const location = useLocation();
  const lastWorkspace = useRef<typeof location | null>(null);
  const background = location.pathname === "/settings" ? lastWorkspace.current : null;
  useEffect(() => {
    if (location.pathname !== "/settings") lastWorkspace.current = location;
  }, [location]);
  const [shortcuts, setShortcuts] = useState(false);
  const closeShortcuts = useCallback(() => setShortcuts(false), []);
  useActions({
    historyBack: () => nav(-1),
    historyForward: () => nav(1),
    settings: () => location.pathname === "/settings"
      ? (location.state?.settingsShortcut ? nav(-1) : nav(lastWorkspace.current ?? "/inbox", { replace: true }))
      : nav("/settings", { state: { settingsShortcut: true } }),
    shortcuts: () => setShortcuts((open) => !open),
  });
  useEffect(() => {
    const el = document.documentElement;
    if (settings.theme === "system") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", settings.theme);
  }, [settings.theme]);
  useEffect(() => startSyncLoop(), []);
  return (
    <div className="app"
      onContextMenu={(e) => {
        if (!isDesktop() || !(e.target instanceof Element)) return;
        if (!e.target.closest('textarea, input:not([type="checkbox"]):not([type="radio"]), [contenteditable="true"]')) e.preventDefault();
      }}
      onDragStart={(e) => {
        if (e.target instanceof Element && e.target.closest(".sidebar a, .brand")) e.preventDefault();
      }}
      onClick={(e) => {
      if (!isDesktop() || e.defaultPrevented || !(e.target instanceof Element)) return;
      const link = e.target.closest<HTMLAnchorElement>('a[target="_blank"]');
      if (!link || !/^https?:\/\//i.test(link.href)) return;
      e.preventDefault();
      void invoke("open_external", { url: link.href }).catch((error) => {
        useApp.getState().toast("error", String(error));
      });
    }}>
      <button
        className="skip-link"
        onClick={() => {
          const m = document.getElementById("main-content");
          const pane = m?.querySelector(".workspace-content:not([inert])");
          const target = (pane?.querySelector("h1, input, button, [tabindex]") as HTMLElement | null) ?? m;
          if (target && !target.hasAttribute("tabindex") && target.tagName === "H1") target.setAttribute("tabindex", "-1");
          target?.focus();
        }}
      >
        Skip to content
      </button>
      <TopBar />
      <Sidebar />
      <main className="main" id="main-content" tabIndex={-1}>
        <div id="workspace-content" className="workspace-content" inert={!!background}>
        <Suspense fallback={<div className="empty">Loading…</div>}>
        <Routes location={background ?? location}>
          <Route path="/" element={<Navigate to="/inbox" replace />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/inbox/:viewId" element={<Inbox />} />
          <Route path="/review" element={<ReviewHome />} />
          <Route path="/pr/:owner/:repo/:number" element={<InboxPRLink />} />
          <Route path="/review/:owner/:repo/:number/:tab?" element={<ReviewRoute />} />
          <Route path="/pr/:owner/:repo/:number/:tab" element={<ReviewRoute />} />
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
        </div>
        {background && <div className="workspace-content"><Suspense fallback={<div className="empty">Loading…</div>}><SettingsPage /></Suspense></div>}
      </main>
      <CommandPalette />
      <Modal open={shortcuts} title="Keyboard shortcuts" onClose={closeShortcuts}>
        <dl className="shortcut-list">
          {Object.entries(SHORTCUTS).map(([action, label]) => <div key={action}><dt>{label}</dt><dd><kbd className="kbd">{keyLabel(action)}</kbd></dd></div>)}
        </dl>
        <StatusLegend />
      </Modal>
      <CloudGlue />
      <Toasts />
    </div>
  );
}

const SHORTCUTS = {
  palette: "Command palette", settings: "Settings", shortcuts: "Keyboard shortcuts",
  historyBack: "Back", historyForward: "Forward", next: "Next pull request", prev: "Previous pull request",
  chainPrev: "Previous PR in chain", chainNext: "Next PR in chain",
  nextHunk: "Next hunk", prevHunk: "Previous hunk", markReviewed: "Mark lines reviewed",
  flag: "Flag for later", comment: "Draft a comment", impact: "Impact graph",
};

function StatusLegend() {
  const sections: [string, [string, string, string][]][] = [
    ["PR Inbox", [["? Review", "tone-neutral", "Review status hasn’t been fetched"], ["○ Review", "warn", "Review requested or required"], ["✓ Approved", "ok", "Approved on GitHub"], ["± Changes", "err", "Changes requested"], ["✓ CI", "ok", "Checks passed"], ["◷ CI", "warn", "Checks running"], ["✕ CI", "err", "Checks failed"], ["? CI", "tone-neutral", "Check status unknown"]]],
    ["Review", [["○ Not started", "tone-neutral", "No lines reviewed"], ["◐ In progress", "warn", "Some lines still need review"], ["⟳ Re-review", "err", "Changed lines need another look"], ["✓ Reviewed", "ok", "File review complete"], ["0/1", "tone-neutral", "Zero of one changed files reviewed"]]],
    ["Timeline", [["● Commit", "tone-neutral", "One commit in loaded history"], ["│ Pin", "info", "Submodule commit pinned by the root"], ["┊ Baseline", "info", "Date of the selected root commit"], ["◇ Release", "accent", "Planned release pin"]]],
    ["Board and releases", [["❄ Frozen", "info", "Release pins are locked"], ["● Release color", "accent", "Identifies the same release across views"]]],
    ["Git Graph and Multi-Repo Diff", [["⑂ Lane", "info", "Commit ancestry"], ["+ Addition", "ok", "Added line"], ["− Deletion", "err", "Removed line"]]],
  ];
  return <div className="shortcut-legend"><h2 className="h2">Symbols and colors</h2>{sections.map(([section, entries]) =>
    <section key={section}><h3 className="h3">{section}</h3><dl>{entries.map(([symbol, color, meaning]) =>
      <div key={symbol}><dt className={`chip ${color}`}>{symbol}</dt><dd>{meaning}</dd></div>
    )}</dl></section>
  )}</div>;
}

function ReviewRoute() {
  const { owner, repo, number } = useParams();
  return <ReviewPR key={`${owner}/${repo}#${number}`} />;
}

function InboxPRLink() {
  const { owner, repo, number } = useParams();
  const views = useApp((s) => s.views);
  const matching = Object.values(views).find((v) => v.repos.some((r) => r.toLowerCase() === `${owner}/${repo}`.toLowerCase()));
  const query = new URLSearchParams({ pr: `${owner}/${repo}#${number}`.toLowerCase() });
  return <Navigate to={`/inbox${matching ? "/" + matching.id : ""}?${query}`} replace />;
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
      <NavLink to="/inbox" className="brand" aria-label="Nonlinear, PR Inbox" draggable={false}>
        <img src="./icon.svg" alt="" draggable={false} /> Nonlinear
      </NavLink>
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
  const nav = useNavigate();
  const location = useLocation();
  const pinned = Object.entries(prLocal).filter(([, a]) => a.pinned).map(([k]) => prs[k]).filter(Boolean);
  const link = (to: string, label: React.ReactNode, extra?: React.ReactNode) => (
    <NavLink key={to} to={to} draggable={false} end={to.startsWith("/inbox/")} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
      {label}
      {extra}
    </NavLink>
  );
  return (
    <nav className="sidebar" aria-label="Primary" onContextMenu={(e) => { if (isDesktop()) e.preventDefault(); }}>
      <div className="sidebar-links">
      {link("/inbox", <><NavIcon name="inbox" /> PR Inbox</>)}
      {link("/timeline", <><NavIcon name="timeline" /> Submodule Timeline</>)}
      {link("/board", <><NavIcon name="board" /> Board</>)}
      {link("/review", <><NavIcon name="review" /> Review</>)}
      {link("/diff", <><NavIcon name="diff" /> Multi-Repo Diff</>)}
      {link("/graph", <><NavIcon name="graph" /> Git Graph</>)}

      <div className="nav-section">Views <button className="nav-add" aria-label="New view" title="New view" onClick={() => nav("/inbox?newView=1")}>+</button></div>
      {Object.values(views).sort((a, b) => a.name.localeCompare(b.name)).map((v) => link(`/inbox/${v.id}`, <span className="ellipsis">{v.name}</span>, <span className="faint small" style={{ marginLeft: "auto" }}>{v.repos.length}</span>))}

      <div className="nav-section">
        Releases <NavLink to="/releases" className="faint">manage</NavLink>
      </div>
      {Object.values(releases).filter((r) => r.state !== "archived").map((r) =>
        link(`/releases/${r.id}`, <><span className="dot" style={{ background: r.color }} /> <span className="ellipsis">{r.name}</span></>, <span className="faint small" style={{ marginLeft: "auto" }}>{r.state === "frozen" ? "❄" : ""}</span>),
      )}

      <div className="nav-section">Timelines <button className="nav-add" aria-label="New timeline" title="New timeline" onClick={() => nav(`${location.pathname.startsWith("/timeline/") ? location.pathname : "/timeline"}?new=1`)}>+</button></div>
      {Object.values(timelines).filter((t) => !t.parentTimelineId).map((t) => link(`/timeline/${t.id}`, <span className="ellipsis">{t.name}</span>))}

      {pinned.length > 0 && <div className="nav-section">Pinned PRs</div>}
      {pinned.map((p) => link(`/pr/${p!.owner}/${p!.repo}/${p!.number}`, <span className="ellipsis">📌 {p!.repo}#{p!.number} {p!.title}</span>))}

      </div>
      <div className="sidebar-footer">
      <div className="sync-status" role="status"><span className={`chip ${settings.lastSyncError ? "warn" : settings.syncEnabled ? "ok" : ""}`}><span className="sync-dot" aria-hidden="true" />
        {settings.syncEnabled ? (settings.lastSyncError ? `⚠ ${settings.lastSyncError}` : `Synced ${timeAgo(settings.lastSyncAt)}`) : "Local only · Sync off"}
      </span></div>
      {link("/settings", <><NavIcon name="settings" /> Settings</>)}
      </div>
    </nav>
  );
}
