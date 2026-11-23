import { AskAI, useChats, type AskTarget } from "../components/AskAI";
import { DiffCodeLayoutSelect, useDiffCodeLayout } from "../components/FileDiff";
import { CommitDiff } from "../components/CommitDiff";
import { NavIcon } from "../components/NavIcon";
import { RepositoryShortcuts, useCachedRepositories, repositoryFromInput } from "../components/RepositoryShortcuts";
import { RepoEntry } from "../components/RepoEntry";
import { useShallow } from "zustand/react/shallow";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  buildOverviewPrompt,
  diffHash,
  fileStatus,
  freshness,
  parsePRKey,
  prKey as mkKey,
  newId,
  prProgress,
  toSnapshot,
  type CommitNode,
  type PRSnapshot,
  type RawIssueComment,
  type RawReview,
  type RawReviewComment,
} from "@nonlinear/core";
import { useApp, useSettings, type AIChat } from "../lib/store";
import { describeError, deferredNotice, enrichPR, githubApi, guardedWrite, WriteBlocked, cachedCapabilities, signalReviewStart, submitLGTM } from "../lib/github";
import { loadPRDiff, remapIfHeadChanged, fileSectionOf, loadReviewCommits, loadReviewCommitDiff, loadPRConversation, type LoadedDiff } from "../lib/review";
import { aiAllowedFor, estimate, latestSummary, model, summarize } from "../lib/ai";
import { renderMarkdown } from "../lib/markdown";
import { useChainGraph } from "../lib/chains";
import { useActions } from "../lib/keys";
import { CIChip, ReviewChip, PRStateChip, timeAgo, Modal, DiffStat, Split } from "../components/ui";
import { ChainPanel } from "../components/ChainPanel";
import { ReviewFiles } from "./ReviewFiles";

/* ---------------- Entry: repo picker + All/Open/Closed list (§5.1) ---------------- */

export function ReviewHome() {
  const prs = useApp((s) => s.prs);
  const repos = useCachedRepositories();
  // Start on the first starred (pinned) repository, else the most recently used, else the first known one.
  const [repo, setRepo] = useState(() => {
    const layout = useApp.getState().settings_().layout;
    const pinned = (layout.graphPinned as string[] | undefined) ?? [];
    const recent = (layout.graphRecent as string[] | undefined) ?? [];
    return (pinned[0] ?? recent[0] ?? repos[0] ?? "").toLowerCase();
  });
  const [repoInput, setRepoInput] = useState(repo);
  const openRepo = (text: string) => {
    const key = repositoryFromInput(text);
    if (!key) { setErr("Enter a repository as owner/repo (or paste its GitHub URL)."); return; }
    setErr(null);
    setRepoInput(key);
    setRepo(key);
  };
  const [state, setState] = useState<"open" | "closed" | "all">("open");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [goto, setGoto] = useState("");
  const nav = useNavigate();
  const list = Object.values(prs)
    .filter((p) => `${p.owner}/${p.repo}`.toLowerCase() === repo && (state === "all" || (state === "open" ? p.state === "open" : p.state !== "open")))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const load = async () => {
    if (!repo) return;
    setBusy(true);
    setErr(null);
    try {
      const [o, n] = repo.split("/") as [string, string];
      const pulls = await (await githubApi()).listPulls(o, n, state, 2);
      useApp.getState().putMany("prs", pulls.map((p) => { const s = toSnapshot(p); const old = useApp.getState().prs[s.key]; return [s.key, old && old.headSha === s.headSha ? { ...s, reviews: old.reviews, reviewDecision: old.reviewDecision, ci: old.ci } : s]; }));
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, state]);

  return (
    <div className="page">
      <h1 className="h1">Review</h1>
      <div className="row" style={{ marginBottom: 12, flexWrap: "wrap" }}>
        <form className="review-repo-picker" onSubmit={(e) => { e.preventDefault(); openRepo(repoInput); }}>
          <RepoEntry value={repoInput} onChange={setRepoInput} onSelect={openRepo} placeholder="owner/repo — type, pick a recent one, or search GitHub" />
        </form>
        <RepositoryShortcuts current={repo || null} repositories={repos} onOpen={openRepo} />
        <div className="row" role="tablist">
          {(["all", "open", "closed"] as const).map((s) => (
            <button key={s} role="tab" aria-selected={state === s} className={`btn sm ${state === s ? "primary" : ""}`} onClick={() => setState(s)}>
              {s[0]!.toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        {busy && <span className="faint small">Loading…</span>}
        <span className="spacer" />
        <input className="input" data-workspace-entry data-workspace-search placeholder="Open any PR: owner/repo#123 or URL" value={goto} onChange={(e) => setGoto(e.target.value)} onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          const m = /([^/\s]+)\/([^/\s#]+)(?:#|\/pull\/)(\d+)/.exec(goto);
          if (m) nav(`/review/${m[1]}/${m[2]}/${m[3]}`);
        }} style={{ width: 300 }} />
      </div>
      {err && <div className="banner err">{err}</div>}
      <div className="panel">
        {list.map((p) => (
          <Link key={p.key} to={`/review/${p.owner}/${p.repo}/${p.number}`} className="list-row" style={{ color: "inherit", textDecoration: "none" }}>
            <ReviewProgressPill pr={p} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ellipsis">{p.title}</div>
              <div className="faint small">#{p.number} · {p.author} · {timeAgo(p.updatedAt)}</div>
            </div>
            <PRStateChip pr={p} />
            <ReviewChip d={p.reviewDecision} />
          </Link>
        ))}
        {!list.length && <div className="empty">No PRs.</div>}
      </div>
    </div>
  );
}

function ReviewProgressPill({ pr }: { pr: PRSnapshot }) {
  const p = useApp((s) => s.reviews[pr.key]);
  if (!p) return <span className="chip review-progress-pill">Not started</span>;
  const g = prProgress(p);
  const total = Math.max(pr.changedFiles, g.total);
  return (
    <span className={`chip ${g.stale ? "err" : g.complete === total && total ? "ok" : "warn"} review-progress-pill`} title={`${g.complete} of ${total} changed files reviewed privately`}>
      {g.complete}/{total}{p.headSha !== pr.headSha ? " ⟳" : ""}
    </span>
  );
}

/* ---------------- PR review (§5) ---------------- */

type Tab = "overview" | "files" | "commits" | "conversation";

export function ReviewPR() {
  const { owner, repo, number, tab } = useParams();
  const key = mkKey({ owner: owner!, repo: repo!, number: Number(number) });
  const pr = useApp((s) => s.prs[key]);
  const toast = useApp((s) => s.toast);
  const nav = useNavigate();
  const [diff, setDiff] = useState<LoadedDiff | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [commentRevision, setCommentRevision] = useState(0);
  const [ask, setAsk] = useState<{ target: AskTarget; id: number; chatId: string } | null>(null);
  const [askDocked, setAskDocked] = useState(false);
  const [askVisible, setAskVisible] = useState(false);
  const [askDock, setAskDock] = useState<HTMLDivElement | null>(null);
  const chats = useChats(key);
  const openAsk = (target: AskTarget) => {
    setAsk((current) => {
      if (current && current.target.path === target.path && current.target.selected === target.selected && current.target.context === target.context) return current;
      return { target, id: (current?.id ?? 0) + 1, chatId: newId("chat") };
    });
    if (!ask || ask.target.path !== target.path || ask.target.selected !== target.selected || ask.target.context !== target.context) setAskDocked(false);
    setAskVisible(true);
  };
  /** A conversation about the whole PR: its diff (bounded), without files excluded from AI. */
  const wholePRTarget = (): AskTarget | null => {
    if (!pr) return null;
    const repoKey = `${pr.owner}/${pr.repo}`.toLowerCase();
    const context = diff ? diff.index.files.filter((f) => !f.binary && aiAllowedFor(repoKey, f.path).ok).map((f) => fileSectionOf(diff, f)).join("\n").slice(0, 40_000) : "";
    return { repoKey, prKey: key, prTitle: pr.title, prUrl: pr.url, path: "", label: "whole PR", selected: "", context };
  };
  const openChat = (chat: AIChat | null) => {
    const target = chat?.target ?? wholePRTarget();
    if (!target) return;
    setAsk((current) => ({ target, id: (current?.id ?? 0) + 1, chatId: chat?.id ?? newId("chat") }));
    setAskDocked(true);
    setAskVisible(true);
  };
  /** Toolbar button: show/hide the docked chat; first time, open the latest conversation (or a new whole-PR one). */
  const toggleChat = () => {
    if (ask && askDocked) { setAskVisible(!askVisible); return; }
    openChat(chats[0] ?? null);
  };
  const [remapInfo, setRemapInfo] = useState<string | null>(null);
  const location = useLocation();
  const tabs: Tab[] = ["overview", "files", "commits", "conversation"];
  const saved = localStorage.getItem(`nl:review-tab:${key}`);
  const activeTab = tabs.find((value) => value === (tab ?? saved)) ?? "files";
  useEffect(() => {
    if (!pr) return;
    localStorage.setItem(`nl:review-tab:${key}`, activeTab);
    localStorage.setItem("nl:last-review", `/review/${pr.owner}/${pr.repo}/${pr.number}/${activeTab}`);
  }, [key, activeTab, pr]);
  const { graph } = useChainGraph();

  useEffect(() => {
    const cached = useApp.getState().prs[key];
    if (cached && Date.now() - cached.fetchedAt < 60_000) return;
    if (!useApp.getState().online) {
      if (!cached) setErr("Offline and this PR is not cached.");
      return;
    }
    enrichPR(key).catch((e) => {
      if (!useApp.getState().prs[key]) setErr(describeError(e));
      else useApp.getState().toast("warn", `Showing cached PR: ${describeError(e)}`);
    });
  }, [key]);

  useEffect(() => {
    if (!pr) return;
    let cancelled = false;
    setErr(null);
    loadPRDiff(pr)
      .then(async (d) => {
        if (cancelled) return;
        setDiff(d);
        const r = await remapIfHeadChanged(pr, d);
        if (r) setRemapInfo(`New commits since your last review: progress carried over for unchanged code; ${r.stale} changed lines need re-review${r.orphanedNotes ? `; ${r.orphanedNotes} notes need relocation` : ""}.`);
      })
      .catch((e) => !cancelled && setErr(describeError(e)));
    return () => {
      cancelled = true;
    };
  }, [pr?.headSha, pr?.baseSha]);

  // Chain navigation, prerequisite-first, with breadcrumbs (§5.1)
  const chainOrder = useMemo(() => graph.topoOrder(graph.component(key)), [graph, key]);
  const goChain = (delta: number) => {
    const i = chainOrder.indexOf(key);
    const next = chainOrder[i + delta];
    if (!next) return;
    const crumbs: string[] = JSON.parse(sessionStorage.getItem("nl:crumbs") ?? "[]");
    sessionStorage.setItem("nl:crumbs", JSON.stringify([...crumbs.filter((c) => c !== key), key].slice(-8)));
    const r = parsePRKey(next)!;
    nav(`/review/${r.owner}/${r.repo}/${r.number}/${activeTab}`);
  };
  useActions({ chainPrev: () => goChain(-1), chainNext: () => goChain(1) }, [chainOrder.join(), key, activeTab]);
  const crumbs: string[] = JSON.parse(sessionStorage.getItem("nl:crumbs") ?? "[]").filter((c: string) => c !== key);

  if (!pr) return <div className="empty">{err ?? "Loading PR…"}</div>;

  return (
    <div className="col" style={{ height: "100%", gap: 0 }}>
      <div className="toolbar">
        <Link className="btn ghost sm" to="/review">← Reviews</Link>
        {crumbs.length > 0 && (
          <span className="small faint">
            {crumbs.slice(-3).map((c) => {
              const r = parsePRKey(c)!;
              return (
                <Link key={c} to={`/pr/${r.owner}/${r.repo}/${r.number}`} style={{ marginRight: 6 }}>
                  ← {r.repo}#{r.number}
                </Link>
              );
            })}
          </span>
        )}
        <h1 className="toolbar-title ellipsis" style={{ maxWidth: 520 }} title={pr.title}>
          {pr.title}
        </h1>
        <span className="faint small">{key}</span>
        <PRStateChip pr={pr} />
        <ReviewChip d={pr.reviewDecision} />
        <CIChip ci={pr.ci} />
        <span className="spacer" />
        {chainOrder.length > 1 && (
          <span className="row small">
            <button className="btn sm" disabled={chainOrder.indexOf(key) === 0} onClick={() => goChain(-1)} title="Previous (prerequisite) [">
              [ prev
            </button>
            <span className="faint">
              {chainOrder.indexOf(key) + 1}/{chainOrder.length} in chain
            </span>
            <button className="btn sm" disabled={chainOrder.indexOf(key) === chainOrder.length - 1} onClick={() => goChain(1)} title="Next (dependent) ]">
              next ]
            </button>
          </span>
        )}
        <ReviewingChip pr={pr} />
        <PRNotesButton pr={pr} />
        <button className="btn sm" onClick={() => nav(`/review/${owner}/${repo}/${number}/conversation`)}>PR comment</button>
        <LGTMButton pr={pr} />
        <SubmitReviewButton pr={pr} onSubmitted={() => setCommentRevision(Date.now())} />
        <button className="btn sm" aria-pressed={!!ask && askDocked && askVisible} onClick={toggleChat}
          title={chats.length ? `AI chat · ${chats.length} saved conversation${chats.length > 1 ? "s" : ""} for this PR` : "AI chat about this PR"}>
          ✦ AI chat{chats.length ? ` (${chats.length})` : ""}
        </button>
        <a className="btn sm" href={pr.url} target="_blank" rel="noreferrer">
          GitHub ↗
        </a>
        <button className="btn sm" onClick={() => void enrichPR(key).then(() => { setCommentRevision(Date.now()); toast("info", "Refreshed"); }).catch((e) => toast("error", describeError(e)))}>
          ↻
        </button>
      </div>
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t} role="tab" aria-selected={activeTab === t} className={`tab ${activeTab === t ? "active" : ""}`} onClick={() => nav(`/review/${owner}/${repo}/${number}/${t}`)}>
            {t === "files" ? `Files changed ${diff ? diff.index.files.length : ""}` : t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {remapInfo && (
        <div className="banner warn" style={{ margin: 8 }}>
          {remapInfo}{" "}
          <button className="btn ghost sm" onClick={() => setRemapInfo(null)}>
            dismiss
          </button>
        </div>
      )}
      {err && <div className="banner err" style={{ margin: 8 }}>{err}</div>}
      <div className="review-workspace-body">
        <Split id="review-ai" className="workspace-split" initial={0.70} min={0.19} showSecond={askDocked && askVisible}>
          <div style={{ height: "100%", minHeight: 0 }}>
        {activeTab === "overview" && <Overview pr={pr} diff={diff} />}
        {activeTab === "files" && (diff ? <ReviewFiles pr={pr} diff={diff} refreshComments={commentRevision} focusSearch={location.state?.focusReviewSearch === true} onAsk={openAsk} /> : <div className="empty">{err ? "" : "Loading diff…"}</div>)}
        {activeTab === "commits" && <Commits pr={pr} />}
        {activeTab === "conversation" && <Conversation pr={pr} revision={commentRevision} />}
          </div>
          <div ref={setAskDock} className="review-ask-dock" />
        </Split>
      </div>
      {ask && <AskAI key={ask.id} chatId={ask.chatId} target={ask.target} docked={askDocked} dock={askDock} onSwitch={openChat}
        onDock={() => { setAskDocked(true); setAskVisible(true); }}
        onClose={() => { if (askDocked) setAskVisible(false); else setAsk(null); }} />}
    </div>
  );
}

/** Shows whether GitHub knows you're reviewing; lets you signal it explicitly. */
function ReviewingChip({ pr }: { pr: PRSnapshot }) {
  const signalled = useApp((s) => !!s.reviewSignals[pr.key]);
  const me = useSettings().me;
  if (!me || pr.author.toLowerCase() === me.toLowerCase() || pr.state !== "open") return null;
  const listed = pr.requestedReviewers?.some((u) => u.toLowerCase() === me.toLowerCase()) || pr.reviews?.some((r) => r.user.toLowerCase() === me.toLowerCase());
  if (signalled || listed) return <span className="chip info" title="GitHub lists you as a reviewer on this PR">👀 Reviewing</span>;
  return <button className="btn sm" title="Request a review from yourself so GitHub shows you're reviewing" onClick={() => void signalReviewStart(pr, { force: true })}>👀 Start review</button>;
}

/** One-click approval with an "LGTM" review on GitHub. */
function LGTMButton({ pr }: { pr: PRSnapshot }) {
  const me = useSettings().me;
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const mine = !!me && pr.author.toLowerCase() === me.toLowerCase();
  const approved = !!me && pr.reviews?.some((r) => r.user.toLowerCase() === me.toLowerCase() && r.state === "APPROVED");
  return <button className={`btn sm ${approved ? "ok-btn" : ""}`} disabled={busy || mine || pr.state !== "open"} aria-pressed={approved}
    title={mine ? "You can't approve your own pull request" : approved ? "You approved this PR on GitHub. Click to approve again on the current head." : "Approve on GitHub with an “LGTM” review"}
    onClick={async () => {
      setBusy(true);
      try {
        const res = await submitLGTM(pr);
        const notice = deferredNotice(res, "LGTM approval");
        if (notice) toast("warn", notice);
        else { toast("success", `Approved ${pr.key} on GitHub (LGTM)`); void enrichPR(pr.key); }
      } catch (e) {
        toast("error", e instanceof WriteBlocked ? e.message : describeError(e));
      } finally {
        setBusy(false);
      }
    }}>{approved ? "✓ LGTM'd" : "👍 LGTM"}</button>;
}

function PRNotesButton({ pr }: { pr: PRSnapshot }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const notes = useApp(useShallow((state) => Object.values(state.notes).filter((note) => note.prKey === pr.key && !note.anchor)));
  const save = () => {
    if (!body.trim()) return;
    const id = newId("note");
    useApp.getState().put("notes", id, { id, prKey: pr.key, headSha: pr.headSha, anchor: null, body: body.trim(), orphaned: false, createdAt: Date.now(), updatedAt: Date.now() });
    setBody("");
  };
  return <>
    <button className="btn sm" onClick={() => setOpen(true)}>PR notes{notes.length ? ` (${notes.length})` : ""}</button>
    {open && <Modal title="Private PR notes" onClose={() => setOpen(false)}>
      <div className="col">
        {notes.map((note) => <div key={note.id} className="panel pad inline-annotation row" style={{ alignItems: "flex-start" }}>
          <span className="grow" style={{ whiteSpace: "pre-wrap" }}>{note.body}</span>
          <button className="btn ghost sm" aria-label="Delete note" title="Delete note" onClick={() => useApp.getState().remove("notes", note.id)}><NavIcon name="trash" /></button>
        </div>)}
        <textarea className="input" aria-label="PR-level private note" placeholder="Private note about this pull request" value={body} onChange={(e) => setBody(e.target.value)} />
        <button className="btn primary" disabled={!body.trim()} onClick={save}>Save PR note</button>
      </div>
    </Modal>}
  </>;
}

/* ---------------- Overview + AI summary (§5.2) ---------------- */

function Overview({ pr, diff }: { pr: PRSnapshot; diff: LoadedDiff | null }) {
  const progress = useApp((s) => s.reviews[pr.key]);
  const settings = useSettings();
  return (
    <div className="page">
      <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
        <div className="grow col" style={{ gap: 16 }}>
          <AISummary pr={pr} diff={diff} />
          <section>
            <h3 className="h3">Description</h3>
            <div className="md panel pad" dangerouslySetInnerHTML={{ __html: renderMarkdown(pr.body) || "<em>No description</em>" }} />
          </section>
        </div>
        <div className="col" style={{ width: 360, flex: "none" }}>
          <section className="panel pad">
            <ChainPanel pr={pr.key} />
          </section>
          <section className="panel pad">
            <h3 className="h3">Your private review progress</h3>
            {diff ? (
              <div className="col small" style={{ gap: 4 }}>
                {diff.index.files.map((f) => {
                  const s = progress?.files[f.path];
                  const st = s ? fileStatus(s) : "not-started";
                  return (
                    <div key={f.path} className="row">
                      <span className={`chip ${st === "complete" ? "ok" : st === "needs-rereview" ? "err" : st === "incomplete" ? "warn" : ""}`} style={{ width: 92 }}>
                        {st}
                      </span>
                      <span className="ellipsis grow mono">{f.path}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <span className="faint">Loading…</span>
            )}
            <p className="faint small">Private to you. Never shown on GitHub and never an approval.</p>
          </section>
          <section className="panel pad small">
            <div className="row" style={{ marginBottom: 8 }}>
              <h3 className="h3 grow" style={{ margin: 0 }}>Stats</h3>
              <DiffStat additions={pr.additions} deletions={pr.deletions} />
            </div>
            <div className="review-stats">
              <div className="review-stat add"><b>+{pr.additions.toLocaleString()}</b><span>Additions</span></div>
              <div className="review-stat del"><b>−{pr.deletions.toLocaleString()}</b><span>Deletions</span></div>
              <div className="review-stat"><b>{pr.changedFiles.toLocaleString()}</b><span>Files</span></div>
            </div>
            {pr.additions + pr.deletions > 0 && (
              <div className="review-stat-bar" title={`${Math.round(pr.additions / (pr.additions + pr.deletions) * 100)}% additions`}>
                <span className="a" style={{ width: `${pr.additions / (pr.additions + pr.deletions) * 100}%` }} />
                <span className="d" style={{ width: `${pr.deletions / (pr.additions + pr.deletions) * 100}%` }} />
              </div>
            )}
            <dl className="review-stat-meta">
              <dt>Head</dt><dd><a className="mono" href={`https://github.com/${pr.headRepo ?? `${pr.owner}/${pr.repo}`}/commit/${pr.headSha}`} target="_blank" rel="noreferrer">{pr.headSha.slice(0, 8)}</a></dd>
              <dt>Base</dt><dd><a className="mono" href={`https://github.com/${pr.owner}/${pr.repo}/commit/${pr.baseSha}`} target="_blank" rel="noreferrer">{pr.baseSha.slice(0, 8)}</a></dd>
              {settings.me && <><dt>You</dt><dd>@{settings.me}</dd></>}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}

function AISummary({ pr, diff }: { pr: PRSnapshot; diff: LoadedDiff | null }) {
  const settings = useSettings();
  const summaries = useApp((s) => s.summaries);
  void summaries;
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<null | { modelId: string }>(null);
  const toast = useApp((s) => s.toast);
  const repoKey = `${pr.owner}/${pr.repo}`.toLowerCase();
  const allowed = aiAllowedFor(repoKey);
  const hash = diff ? diffHash([diff.text]) : "";
  const latest = latestSummary(pr.key, null);
  const fr = freshness(latest, hash);

  const build = () => {
    if (!diff) return null;
    const files = diff.index.files.map((f) => {
      const fs = latestSummary(pr.key, f.path);
      // Files matching this repository's AI exclusions never go into the prompt.
      const excluded = !aiAllowedFor(repoKey, f.path).ok;
      return { path: f.path, additions: f.additions, deletions: f.deletions, patch: f.generated || excluded ? undefined : fileSectionOf(diff, f), summary: excluded ? undefined : fs?.text.split("\n")[0] };
    });
    return buildOverviewPrompt({ url: pr.url, title: pr.title, body: pr.body ?? "", files, maxPatchChars: 60_000 });
  };

  const run = async (modelId: string) => {
    const p = build();
    if (!p) return;
    setBusy(true);
    try {
      await summarize({ prKey: pr.key, repo: repoKey, pr: pr.number, baseSha: pr.baseSha, headSha: pr.headSha, diffHash: hash, file: null, modelId, system: p.system, user: p.user });
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const prompt = confirm ? build() : null;
  const m = confirm ? model(confirm.modelId) : undefined;
  const est = prompt && m ? estimate(m, prompt.system, prompt.user) : null;

  return (
    <section className="panel pad">
      <div className="row">
        <h3 className="h3 grow" style={{ margin: 0 }}>
          AI summary{" "}
          <span className={`chip ${fr === "fresh" ? "ok" : fr === "stale" ? "warn" : ""}`}>{fr === "not-generated" ? "not generated" : fr}</span>
        </h3>
        <button className="btn sm" disabled={busy || !diff || !allowed.ok} onClick={() => setConfirm({ modelId: settings.defaultModel })} title={allowed.reason}>
          {latest ? "Regenerate" : "Generate"}
        </button>
        <button className="btn sm" disabled={busy || !diff || !allowed.ok} onClick={() => setConfirm({ modelId: settings.escalationModel })} title="Escalate to a stronger model">
          Escalate
        </button>
      </div>
      {!allowed.ok && <div className="faint small">{allowed.reason}</div>}
      {busy && <div className="faint small">Summarizing…</div>}
      {latest && (
        <>
          <div className="md" style={{ marginTop: 8 }} dangerouslySetInnerHTML={{ __html: renderMarkdown(latest.text) }} />
          <div className="faint small">
            {latest.modelId} · {latest.promptVersion} · ${latest.costUsd.toFixed(4)} · {timeAgo(latest.createdAt)} · AI output is untrusted and is not a review or approval.
          </div>
        </>
      )}
      {confirm && prompt && est && (
        <Modal
          title="Send to model?"
          onClose={() => setConfirm(null)}
          wide
          footer={
            <>
              <button className="btn" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  setConfirm(null);
                  void run(confirm.modelId);
                }}
              >
                Send (~${est.usd.toFixed(4)})
              </button>
            </>
          }
        >
          <div className="col small">
            <div>
              Model <b>{est.model.label}</b> · ~{est.inputTokens.toLocaleString()} input tokens · ≤{est.outputTokens} output · estimated <b>${est.usd.toFixed(4)}</b>
            </div>
            <div>
              Includes {prompt.includedPatches.length}/{diff!.index.files.length} file patches (bounded), stats for all files.
            </div>
            <details>
              <summary>Preview exact prompt</summary>
              <pre className="mono small" style={{ whiteSpace: "pre-wrap", maxHeight: 300, overflow: "auto" }}>{prompt.user.slice(0, 20000)}</pre>
            </details>
          </div>
        </Modal>
      )}
    </section>
  );
}

/* ---------------- Commits ---------------- */

function Commits({ pr }: { pr: PRSnapshot }) {
  const [commits, setCommits] = useState<CommitNode[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<CommitNode | null>(null);
  useEffect(() => {
    let live = true;
    setErr(null);
    void loadReviewCommits(pr).then((items) => { if (live) setCommits(items); }).catch((error) => { if (live) setErr(describeError(error)); });
    return () => { live = false; };
  }, [pr.key, pr.headSha]);
  if (err) return <div className="banner err" style={{ margin: 12 }}>{err}</div>;
  if (!commits) return <div className="empty">Loading…</div>;
  return <div className="page">
    <div className="review-commits" aria-label="Pull request commits">
      {commits.map((commit) => <div className="review-commit" key={commit.sha}>
        <button type="button" className="btn ghost review-commit-row" aria-expanded={selected?.sha === commit.sha} onClick={() => setSelected(selected?.sha === commit.sha ? null : commit)}>
          <span className="mono">{commit.sha.slice(0, 8)}</span><span className="grow ellipsis">{commit.message.split("\n")[0]}</span>
          <span className="muted ellipsis">{commit.author}</span><span className="faint">{timeAgo(commit.committedAt)}</span>
        </button>
        {selected?.sha === commit.sha && <CommitPeek pr={pr} commit={commit} onClose={() => setSelected(null)} />}
      </div>)}
    </div>
    {!commits.length && <div className="empty">No commits.</div>}
  </div>;
}

function CommitPeek({ pr, commit, onClose }: { pr: PRSnapshot; commit: CommitNode; onClose: () => void }) {
  const [layout, setLayout] = useDiffCodeLayout("nl:review-fit", "scroll");
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void loadReviewCommitDiff(pr, commit.sha).then((text) => { if (live) setPatch(text); }).catch((err) => { if (live) setError(describeError(err)); });
    return () => { live = false; };
  }, [pr.key, commit.sha]);
  return <section className="panel commit-peek" aria-label="Commit changes" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
    <div className="toolbar small"><span className="grow">Commit changes</span><DiffCodeLayoutSelect layout={layout} onChange={setLayout} /><button className="btn ghost sm" aria-label="Close commit changes" onClick={onClose}><NavIcon name="close" /></button></div>
    {patch !== null ? <CommitDiff text={patch} layout={layout} /> : <div className={error ? "banner err" : "empty"}>{error ?? "Loading changes…"}</div>}
  </section>;
}

/* ---------------- Conversation ---------------- */

type Event = { at: string; kind: "comment" | "review" | "inline"; user: string; body: string; url: string; extra?: string };

function Conversation({ pr, revision }: { pr: PRSnapshot; revision: number }) {
  const [events, setEvents] = useState<Event[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState("");
  const toast = useApp((s) => s.toast);
  const r = parsePRKey(pr.key)!;
  const canReview = cachedCapabilities(`${r.owner}/${r.repo}`.toLowerCase()).has("can-review");
  const load = async (refreshAfter = 0) => {
    setErr(null);
    try {
      const [ic, rv, rc] = await loadPRConversation(pr, refreshAfter);
      const ev: Event[] = [
        ...ic.map((x: RawIssueComment) => ({ at: x.created_at, kind: "comment" as const, user: x.user?.login ?? "?", body: x.body, url: x.html_url })),
        ...rv.filter((x: RawReview) => x.body || x.state !== "COMMENTED").map((x: RawReview) => ({ at: x.submitted_at ?? "", kind: "review" as const, user: x.user?.login ?? "?", body: x.body, url: x.html_url, extra: x.state })),
        ...rc.map((x: RawReviewComment) => ({ at: x.created_at, kind: "inline" as const, user: x.user?.login ?? "?", body: x.body, url: x.html_url, extra: `${x.path}:${x.line ?? x.original_line}` })),
      ].sort((a, b) => a.at.localeCompare(b.at));
      setEvents(ev);
    } catch (e) {
      setErr(describeError(e));
    }
  };
  useEffect(() => {
    void load(revision);
  }, [pr.key, pr.headSha, revision]);
  return (
    <div className="page" style={{ maxWidth: 900 }}>
      {err && <div className="banner err">{err}</div>}
      {!events && !err && <div className="empty">Loading…</div>}
      {events?.map((e, i) => (
        <div key={i} className="panel pad" style={{ marginBottom: 8 }}>
          <div className="row small">
            <b>{e.user}</b>
            {e.kind === "review" && <span className={`chip ${e.extra === "APPROVED" ? "ok" : e.extra === "CHANGES_REQUESTED" ? "err" : ""}`}>{e.extra?.toLowerCase().replace("_", " ")}</span>}
            {e.kind === "inline" && <span className="chip mono">{e.extra}</span>}
            <span className="faint">{timeAgo(e.at)}</span>
            <span className="spacer" />
            <a href={e.url} target="_blank" rel="noreferrer" className="small">
              ↗
            </a>
          </div>
          <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(e.body) }} />
        </div>
      ))}
      <div className="panel pad col">
        <textarea className="input" placeholder={canReview ? "Comment on GitHub (visible to everyone)…" : "Sign in with write consent to comment"} value={text} onChange={(e) => setText(e.target.value)} disabled={!canReview} />
        <div className="row">
          <span className="faint small grow">This posts a public GitHub comment. For private notes use the Files tab.</span>
          <button
            className="btn primary"
            disabled={!text.trim() || !canReview}
            onClick={async () => {
              try {
                const res = await guardedWrite(pr.key, "can-review", "comment", { body: text }, async () => (await githubApi()).createIssueComment(r.owner, r.repo, r.number, text));
                const notice = deferredNotice(res, "Comment");
                if (notice) toast("warn", notice);
                else toast("success", "Comment posted to GitHub");
                setText("");
                void load(Date.now());
              } catch (e) {
                toast("error", e instanceof WriteBlocked ? e.message : describeError(e));
              }
            }}
          >
            Comment
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Submit review (GitHub's actual API) ---------------- */

function SubmitReviewButton({ pr, onSubmitted }: { pr: PRSnapshot; onSubmitted: () => void }) {
  const drafts = useApp(useShallow((s) => Object.values(s.drafts).filter((d) => d.prKey === pr.key)));
  const [open, setOpen] = useState(false);
  const [event, setEvent] = useState<"COMMENT" | "APPROVE" | "REQUEST_CHANGES">("COMMENT");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useApp((s) => s.toast);
  const remove = useApp((s) => s.remove);
  const r = parsePRKey(pr.key)!;
  const obsolete = drafts.filter((d) => d.headSha !== pr.headSha);
  const isMine = useSettings().me?.toLowerCase() === pr.author.toLowerCase();
  return (
    <>
      <button className="btn sm primary" onClick={() => setOpen(true)}>
        Submit review{drafts.length ? ` (${drafts.length})` : ""}
      </button>
      {open && (
        <Modal
          title="Submit GitHub review"
          onClose={() => setOpen(false)}
          footer={
            <>
              <button className="btn" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={busy || (event !== "APPROVE" && !body.trim() && !drafts.length)}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const valid = drafts.filter((d) => d.headSha === pr.headSha);
                    const request = {
                      commit_id: pr.headSha,
                      event,
                      body: body || undefined,
                      comments: valid.map((d) => ({ path: d.path, line: d.line, side: d.side, ...(d.startLine && d.startLine !== d.line ? { start_line: d.startLine, start_side: d.side } : {}), body: d.body })),
                    };
                    const res = await guardedWrite(pr.key, "can-review", "review", { event, body, comments: request.comments, drafts: valid.map((d) => d.id), request }, async () =>
                      (await githubApi()).submitReview(r.owner, r.repo, r.number, request),
                    );
                    if (res && typeof res === "object" && "staged" in res) {
                      // The staged review carries these comments now; don't keep a second local copy.
                      valid.forEach((d) => remove("drafts", d.id));
                      toast("warn", deferredNotice(res, "Review")!);
                      setOpen(false);
                    } else if (res && typeof res === "object" && "queued" in res) toast("warn", deferredNotice(res, "Review")!);
                    else {
                      valid.forEach((d) => remove("drafts", d.id));
                      toast("success", "Review submitted to GitHub");
                      onSubmitted();
                      setOpen(false);
                      void enrichPR(pr.key);
                    }
                  } catch (e) {
                    toast("error", e instanceof WriteBlocked ? e.message : describeError(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Submit to GitHub
              </button>
            </>
          }
        >
          <div className="col">
            <textarea className="input" placeholder="Review summary (public)" value={body} onChange={(e) => setBody(e.target.value)} />
            {(["COMMENT", "APPROVE", "REQUEST_CHANGES"] as const).map((e) => (
              <label key={e} className="row">
                <input type="radio" checked={event === e} onChange={() => setEvent(e)} disabled={isMine && e !== "COMMENT"} /> {e === "COMMENT" ? "Comment" : e === "APPROVE" ? "Approve" : "Request changes"}
              </label>
            ))}
            <div className="small">
              {drafts.length} draft inline comment(s) will be included.
              {obsolete.length > 0 && <div className="banner warn">{obsolete.length} draft(s) were written against an older head and cannot be anchored; they will be kept locally. Re-anchor or post them as PR-level comments.</div>}
            </div>
            <div className="faint small">Your private “Reviewed” progress is separate from GitHub approvals.</div>
          </div>
        </Modal>
      )}
    </>
  );
}
