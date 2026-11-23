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
import { TimelineWorkspace } from "./workspaces/Timeline";
const GitGraph = lazy(() => import("./workspaces/GitGraph").then((m) => ({ default: m.GitGraph })));
const Releases = lazy(() => import("./workspaces/Releases").then((m) => ({ default: m.Releases })));
const SettingsPage = lazy(() => import("./workspaces/Settings").then((m) => ({ default: m.SettingsPage })));
import { isDesktop, invoke } from "./lib/platform";
import { NavIcon } from "./components/NavIcon";
import { SafeModeControl } from "./components/SafeMode";
import { ThemeLayer } from "./components/ThemeLayer";
import { githubAvatarUrl, refreshGitHubAvatar } from "./lib/github";
import { startSyncLoop } from "./lib/sync";

const UI_ZOOM_LEVELS = [0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

function useDesktopZoom() {
  useEffect(() => {
    if (!isDesktop()) return;
    const key = "nl:ui-zoom";
    const normal = UI_ZOOM_LEVELS.indexOf(1);
    const saved = UI_ZOOM_LEVELS.indexOf(Number(localStorage.getItem(key)));
    let level = saved === -1 ? normal : saved;
    let request = 0;
    const apply = () => {
      const scale = UI_ZOOM_LEVELS[level]!;
      const revision = ++request;
      void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => getCurrentWebview().setZoom(scale))
        .then(() => { if (revision === request) localStorage.setItem(key, String(scale)); })
        .catch(() => { if (revision === request) useApp.getState().toast("error", "Could not change app zoom."); });
    };
    if (level !== normal) apply();
    const onKey = (event: KeyboardEvent) => {
      const mac = /Mac/i.test(navigator.platform);
      if (event.defaultPrevented || event.isComposing || event.altKey || (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return;
      let next: number;
      if (event.key === "+" || event.key === "=") next = Math.min(UI_ZOOM_LEVELS.length - 1, level + 1);
      else if (event.key === "-" || event.key === "_") next = Math.max(0, level - 1);
      else if (event.key === "0") next = normal;
      else return;
      event.preventDefault();
      if (next !== level) { level = next; apply(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}

export function App() {
  const loaded = useApp((s) => s.loaded);
  useDesktopZoom();
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
  const [sidebar, setSidebar] = useState(() => localStorage.getItem("nl:sidebar") !== "hidden");
  const toggleSidebar = () => setSidebar((open) => {
    localStorage.setItem("nl:sidebar", open ? "hidden" : "visible");
    return !open;
  });
  const [shortcuts, setShortcuts] = useState(false);
  const closeShortcuts = useCallback(() => setShortcuts(false), []);
  useActions({
    historyBack: () => nav(-1),
    historyForward: () => nav(1),
    settings: () => location.pathname === "/settings"
      ? (location.state?.settingsShortcut ? nav(-1) : nav(lastWorkspace.current ?? "/inbox", { replace: true }))
      : nav("/settings", { state: { settingsShortcut: true } }),
    sidebar: (event) => { if (!event.repeat) toggleSidebar(); },
    shortcuts: () => setShortcuts((open) => !open),
    find: () => {
      if (!focusWorkspaceInput("search") && /^\/(?:review|pr)\/[^/]+\/[^/]+\/\d+/.test(location.pathname) &&
          !document.querySelector(".overlay:not([inert])")) {
        const [, workspace, owner, repo, number] = location.pathname.split("/");
        if (workspace === "review" || location.pathname.endsWith("/overview") || location.pathname.endsWith("/commits") || location.pathname.endsWith("/conversation")) {
          nav(`/review/${owner}/${repo}/${number}/files`, { state: { focusReviewSearch: true } });
        }
      }
    },
    entry: () => focusWorkspaceInput("entry"),

  });
  useEffect(() => {
    const el = document.documentElement;
    if (settings.theme === "system") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", settings.theme);
  }, [settings.theme]);
  useEffect(() => startSyncLoop(), []);
  return (
    <div className={`app ${sidebar ? "" : "sidebar-hidden"}`}
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
      <TopBar sidebar={sidebar} onToggleSidebar={toggleSidebar} />
      <Sidebar hidden={!sidebar} />
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
        {background && <div className="workspace-content settings-workspace"><Suspense fallback={<div className="empty">Loading…</div>}><SettingsPage /></Suspense></div>}
      </main>
      <CommandPalette />
      <Modal open={shortcuts} title="Keyboard shortcuts" onClose={closeShortcuts}>
        <dl className="shortcut-list">
          {Object.entries(SHORTCUTS).map(([action, label]) => <div key={action}><dt>{label}</dt><dd><kbd className="kbd">{keyLabel(action)}</kbd></dd></div>)}
          <div><dt>Pan timeline</dt><dd><kbd className="kbd">← / → or H / L</kbd></dd></div>
          <div><dt>Scroll timeline rows</dt><dd><kbd className="kbd">↑ / ↓</kbd></dd></div>
          <div><dt>Select next or previous submodule</dt><dd><kbd className="kbd">J / K</kbd></dd></div>
          <div><dt>Zoom timeline</dt><dd><kbd className="kbd">⌘ + scroll or pinch</kbd></dd></div>
          <div><dt>Zoom app in, out, or reset</dt><dd><kbd className="kbd">⌘ + / ⌘ − / ⌘ 0</kbd></dd></div>
          <div><dt>Go to definition / references (review code)</dt><dd><kbd className="kbd">{/mac/i.test(navigator.platform) ? "⌘" : "Ctrl"} + click identifier</kbd></dd></div>
          <div><dt>Symbol actions (review code)</dt><dd><kbd className="kbd">Right-click identifier</kbd></dd></div>
          <div><dt>Definition / references of selected word</dt><dd><kbd className="kbd">F12 / ⇧F12</kbd></dd></div>
          <div><dt>Find in code (after clicking the diff)</dt><dd><kbd className="kbd">{/mac/i.test(navigator.platform) ? "⌘" : "Ctrl"}F</kbd></dd></div>
          <div><dt>Next / previous match</dt><dd><kbd className="kbd">↵ / ⇧↵ or {/mac/i.test(navigator.platform) ? "⌘" : "Ctrl"}G / ⇧{/mac/i.test(navigator.platform) ? "⌘" : "Ctrl"}G</kbd></dd></div>
        </dl>
        <StatusLegend />
      </Modal>
      <CloudGlue />
      <ThemeLayer />
      <Toasts />
    </div>
  );
}

function focusWorkspaceInput(kind: "search" | "entry") {
  const overlay = [...document.querySelectorAll(".overlay")].filter((element) => !element.closest("[inert]")).at(-1);
  const workspace = document.querySelector(".workspace-content:not([inert])");
  const pane = document.activeElement?.closest("[data-search-pane]");
  const selector = kind === "search" ? 'input[type="search"], input[data-workspace-search]' : "input[data-workspace-entry]";
  const root = overlay ?? workspace;
  const candidates = [...(root?.querySelectorAll<HTMLInputElement>(selector) ?? [])]
    .filter((input) => !input.disabled && input.getClientRects().length > 0);
  const target = candidates.find((input) => pane?.contains(input)) ?? candidates[0];
  target?.focus();
  target?.select();
  return !!target;
}

const SHORTCUTS = {
  palette: "Command palette", find: "Focus search", sidebar: "Toggle navigation sidebar", diffSidebar: "Toggle diff file list", entry: "Focus entry box", newCard: "New board card", settings: "Settings", shortcuts: "Keyboard shortcuts",
  historyBack: "Back", historyForward: "Forward", next: "Next pull request", prev: "Previous pull request",
  chainPrev: "Previous PR in chain", chainNext: "Next PR in chain",
  nextHunk: "Next hunk", prevHunk: "Previous hunk", markReviewed: "Mark lines reviewed",
  flag: "Flag for later", comment: "Draft a comment", impact: "Impact graph",
};

function StatusLegend() {
  const sections: [string, [string, string, string][]][] = [
    ["PR Inbox", [["? Review", "tone-neutral", "Review status hasn’t been fetched"], ["○ Review", "warn", "Review requested or required"], ["✓ Approved", "ok", "Approved on GitHub"], ["± Changes", "err", "Changes requested"], ["✓ CI", "ok", "Checks passed"], ["◷ CI", "warn", "Checks running"], ["✕ CI", "err", "Checks failed"], ["? CI", "tone-neutral", "Check status unknown"]]],
    ["Review", [["○ Not started", "tone-neutral", "No lines reviewed"], ["◐ In progress", "warn", "Some lines still need review"], ["⟳ Re-review", "err", "Changed lines need another look"], ["✓ Reviewed", "ok", "File review complete"], ["0/1", "tone-neutral", "Zero of one changed files reviewed"]]],
    ["Timeline", [["● Commit", "tone-neutral", "One commit in loaded history"], ["○ Yellow commit", "warn", "Commit outside the tracked submodule branch"], ["│ Branch tip", "ok", "Latest commit of the submodule’s tracked branch"], ["│ Pin", "info", "Submodule commit pinned by the root"], ["┊ Baseline", "info", "Date of the selected root commit"], ["◇ Release", "accent", "Planned release pin"]]],
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

function TopBar({ sidebar, onToggleSidebar }: { sidebar: boolean; onToggleSidebar: () => void }) {
  const online = useApp((s) => s.online);
  const rate = useApp((s) => s.rateLimit);
  const s = useSettings();
  const setSettings = useApp((x) => x.setSettings);
  const pendingIntentions = useApp((x) => Object.values(x.intentions).filter((i) => i.status === "queued" || i.status === "needs-confirmation").length);
  const nav = useNavigate();
  const conflicts = useApp((x) => Object.keys(x.syncConflicts).length);
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <NavLink to="/inbox" className="brand" aria-label="Nonlinear, PR Inbox" draggable={false}>
          <img src="./icon.svg" alt="" draggable={false} /> Nonlinear
        </NavLink>
        <button type="button" className="btn ghost sm topbar-sidebar-toggle" aria-label="Toggle navigation sidebar" aria-controls="primary-navigation" aria-expanded={sidebar}
          title={`Toggle navigation sidebar (${keyLabel("sidebar")})`} onClick={onToggleSidebar}><NavIcon name="sidebar" /></button>
      </div>
      <button className="btn topbar-search" onClick={() => window.dispatchEvent(new Event("nonlinear:palette"))}>
        <NavIcon name="search" /><span className="faint grow">Search or jump to…</span>
        <span className="kbd" aria-hidden="true">{keyLabel("palette")}</span>
      </button>
      <span className="spacer" />
      <div className="topbar-statuses">
      <span className={`chip ${rate && rate.remaining < rate.limit * 0.1 ? "warn" : ""}`}
        title={rate ? `Resets ${new Date(rate.resetAt).toLocaleTimeString()}` : "Waiting for GitHub API rate-limit data"}>
        <NavIcon name="activity" /> GitHub API {rate ? `${rate.remaining}/${rate.limit}` : "—"}
      </span>
      {pendingIntentions > 0 && (
        <button className="chip warn" onClick={() => nav("/settings#intentions")} title="GitHub writes waiting for your confirmation">
          <NavIcon name="clock" /> {pendingIntentions} pending
        </button>
      )}
      {conflicts > 0 && (
        <button className="chip err" onClick={() => nav("/settings")} title="Concurrent edits from another device need your decision">
          <NavIcon name="warning" /> {conflicts} sync conflict{conflicts > 1 ? "s" : ""}
        </button>
      )}
      <SafeModeControl />
      <span className={`chip sync-status ${s.lastSyncError ? "warn" : s.syncEnabled ? "ok" : ""}`} role="status"
        title={s.syncEnabled ? (s.lastSyncError ?? `Last synced ${timeAgo(s.lastSyncAt)}`) : "Data stays on this device. Connect Nonlinear Cloud in Settings to sync."}>
        <span className="sync-dot" aria-hidden="true" />
        {s.syncEnabled ? (s.lastSyncError ? "Sync error" : `Synced ${timeAgo(s.lastSyncAt)}`) : "Local only · Sync off"}
      </span>
      <span className={`chip ${online ? "ok" : "warn"}`} role="status">
        <span className="sync-dot" aria-hidden="true" /> {online ? "Online" : "Offline — cached"}
      </span>
      </div>
      <div className="topbar-account">
      <span className="chip" title={s.publicOnly ? "Private repositories are hidden and rejected" : "Private repos allowed for fine-grained tokens"}>
        <NavIcon name="lock" /> {s.publicOnly ? "Public-only" : "Private allowed"}
      </span>
      <GitHubAccount />
      <button
        className="btn ghost sm"
        aria-label="Toggle theme"
        onClick={() => setSettings({ theme: s.theme === "system" ? "dark" : s.theme === "dark" ? "light" : "system" })}
        title={`Theme: ${s.theme}`}
      >
        <NavIcon name="moon" />
      </button>
      </div>
    </header>
  );
}

function GitHubAccount() {
  const { me, authMode, apiBase, githubAvatar } = useSettings();
  const online = useApp((state) => state.online);
  useEffect(() => { void refreshGitHubAvatar(); }, [me, authMode, apiBase, online]);
  const login = authMode === "anonymous" ? null : me;
  const photo = login && githubAvatar?.login === login && githubAvatar.apiBase === apiBase ? githubAvatarUrl(githubAvatar.url) : null;
  return <span className="chip github-account" title={login ? `Signed in as @${login}` : "Anonymous"}>
    <AccountAvatar key={JSON.stringify([login, photo])} url={photo} />
    <span className="ellipsis">{login ? `@${login}` : "Anonymous"}</span>
  </span>;
}

function AccountAvatar({ url }: { url: string | null }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  return <span className="account-avatar" aria-hidden="true">
    {!loaded && <NavIcon name="account" />}
    {url && !failed && <img src={url} alt="" draggable={false} referrerPolicy="no-referrer"
      className={loaded ? "loaded" : undefined}
      onLoad={() => setLoaded(true)} onError={() => { setLoaded(false); setFailed(true); }} />}
  </span>;
}

function Sidebar({ hidden }: { hidden: boolean }) {
  const views = useApp((s) => s.views);
  const releases = useApp((s) => s.releases);
  const timelines = useApp((s) => s.timelines);
  const prLocal = useApp((s) => s.prLocal);
  const prs = useApp((s) => s.prs);
  const nav = useNavigate();
  const location = useLocation();
  const layout = useSettings().layout;
  const pins = (layout.sidebarPins as string[] | undefined) ?? [];
  const ordered = <T extends { id: string; name: string }>(items: T[], prefix: string) => items.sort((a, b) =>
    Number(pins.includes(prefix + b.id)) - Number(pins.includes(prefix + a.id)) || a.name.localeCompare(b.name));
  const pinnable = (to: string, name: string, label: React.ReactNode, extra?: React.ReactNode) => (
    <div className="sidebar-pinnable" key={to}>
      {link(to, label, extra)}
      <button type="button" className="nav-pin" aria-pressed={pins.includes(to)}
        aria-label={`${pins.includes(to) ? "Unpin" : "Pin"} ${name}`} title={`${pins.includes(to) ? "Unpin" : "Pin"} ${name}`}
        onClick={() => {
          const state = useApp.getState();
          state.setSettings({ layout: { ...state.settings_().layout, sidebarPins: pins.includes(to) ? pins.filter((id) => id !== to) : [...pins, to] } });
        }}><NavIcon name="pin" /></button>
    </div>
  );
  const pinned = Object.entries(prLocal).filter(([, a]) => a.pinned).map(([k]) => prs[k]).filter(Boolean);
  const link = (to: string, label: React.ReactNode, extra?: React.ReactNode) => (
    <NavLink key={to} to={to} draggable={false} end={to.startsWith("/inbox/")} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
      {label}
      {extra}
    </NavLink>
  );
  return (
    <nav id="primary-navigation" className="sidebar" hidden={hidden} aria-label="Primary" onContextMenu={(e) => { if (isDesktop()) e.preventDefault(); }}>
      <div className="sidebar-links">
      {link("/inbox", <><NavIcon name="inbox" /> PR Inbox</>)}
      {link("/timeline", <><NavIcon name="timeline" /> Submodule Timeline</>)}
      {link("/board", <><NavIcon name="board" /> Board</>)}
      {link(location.pathname === "/review" ? "/review" : localStorage.getItem("nl:last-review") ?? "/review", <><NavIcon name="review" /> Review</>)}
      {link("/diff", <><NavIcon name="diff" /> Multi-Repo Diff</>)}
      {link("/graph", <><NavIcon name="graph" /> Git Graph</>)}

      <div className="nav-section">Views <button className="nav-add" aria-label="New view" title="New view" onClick={() => nav("/inbox?newView=1")}>+</button></div>
      {ordered(Object.values(views), "/inbox/").map((v) => pinnable(`/inbox/${v.id}`, v.name, <span className="ellipsis">{v.name}</span>, <span className="faint small" style={{ marginLeft: "auto" }}>{v.repos.length}</span>))}

      <div className="nav-section">
        Releases <NavLink to="/releases" className="faint">manage</NavLink>
      </div>
      {ordered(Object.values(releases).filter((r) => r.state !== "archived"), "/releases/").map((r) =>
        pinnable(`/releases/${r.id}`, r.name, <><span className="dot" style={{ background: r.color }} /> <span className="ellipsis">{r.name}</span></>, <span className="faint small" style={{ marginLeft: "auto" }}>{r.state === "frozen" ? "❄" : ""}</span>),
      )}

      <div className="nav-section">Timelines <button className="nav-add" aria-label="New timeline" title="New timeline" onClick={() => nav(`${location.pathname.startsWith("/timeline/") ? location.pathname : "/timeline"}?new=1`)}>+</button></div>
      {ordered(Object.values(timelines), "/timeline/").map((t) => pinnable(`/timeline/${t.id}`, t.name, <span className="ellipsis">{t.name}</span>))}

      {pinned.length > 0 && <div className="nav-section">Pinned PRs</div>}
      {pinned.map((p) => link(`/pr/${p!.owner}/${p!.repo}/${p!.number}`, <><NavIcon name="pin" /><span className="ellipsis">{p!.repo}#{p!.number} {p!.title}</span></>))}

      </div>
      <div className="sidebar-footer">
      {link("/settings", <><NavIcon name="settings" /> Settings</>)}
      </div>
    </nav>
  );
}
