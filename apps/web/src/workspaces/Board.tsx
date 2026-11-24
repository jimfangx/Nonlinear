import { useShallow } from "zustand/react/shallow";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  columnCards,
  moveCard,
  newCardInContext,
  newId,
  placementOf,
  parsePRKey,
  type CardPlacement,
  type FeatureCard,
} from "@nonlinear/core";
import { useApp, useSettings } from "../lib/store";
import { Split } from "../components/ui";
import { useActions } from "../lib/keys";
import { CachedEntry } from "../components/CachedEntry";
import { RepoEntry } from "../components/RepoEntry";
import { useCachedRepositories } from "../components/RepositoryShortcuts";
import { renderMarkdown } from "../lib/markdown";
import { createIssue, deferredNotice, describeError, lookupNumber, WriteBlocked } from "../lib/github";
import type { CachedOption } from "../components/CachedEntry";
import { useChainGraph } from "../lib/chains";

/** Feature kanban (§4): shared cards, per-context placements. */
export function Board() {
  const { context: ctxParam } = useParams();
  const ctx = ctxParam ? decodeURIComponent(ctxParam) : "all";
  const cards = useApp((s) => s.cards);
  const placementsRec = useApp((s) => s.placements);
  const views = useApp((s) => s.views);
  const releases = useApp((s) => s.releases);
  const settings = useSettings();
  const columns = settings.columns;
  const nav = useNavigate();
  const [filter, setFilter] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const editing = cards[params.get("card") ?? ""];
  const openCard = (card: FeatureCard | null) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    if (card) next.set("card", card.id);
    else next.delete("card");
    return next;
  }, { replace: true });
  const [freshCard, setFreshCard] = useState<string | null>(null);
  const createCard = () => {
    const card = newCardInContext(newId("card"), "New feature", ctx);
    useApp.getState().put("cards", card.id, card);
    setFreshCard(card.id);
    openCard(card);
  };
  useEffect(() => {
    if (!editing) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector(".overlay:not([inert]), #workspace-content[inert]")) return;
      event.preventDefault();
      openCard(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [editing, setParams]);
  useActions({ newCard: (event) => { if (!event.repeat) createCard(); } });
  const [focused, setFocused] = useState<string | null>(null);
  const placements = useMemo(() => Object.values(placementsRec), [placementsRec]);
  const allCards = useMemo(() => Object.values(cards).filter((c) => !c.deleted && (!filter || `${c.title} ${c.description} ${c.repos.join(" ")}`.toLowerCase().includes(filter.toLowerCase()))), [cards, filter]);
  const repos = useMemo(() => [...new Set(Object.values(views).flatMap((v) => v.repos))].sort(), [views]);

  const savePlacement = (p: CardPlacement) => useApp.getState().put("placements", `${p.cardId}@${p.context}`, p);
  const move = (cardId: string, column: string, index: number) => savePlacement(moveCard(placements, cardId, ctx, column, index).moved);

  const keyMove = (c: FeatureCard) => (e: React.KeyboardEvent) => {
    const p = placementOf(placements, c.id, ctx, columns);
    const ci = columns.findIndex((x) => x.id === p.column);
    const colCards = columnCards(allCards, placements, ctx, p.column, columns);
    const idx = colCards.findIndex((x) => x.id === c.id);
    if (e.key === "Enter") return openCard(c);
    if (!e.altKey && !e.shiftKey) return;
    if (e.key === "ArrowRight" && ci < columns.length - 1) { e.preventDefault(); move(c.id, columns[ci + 1]!.id, 0); }
    if (e.key === "ArrowLeft" && ci > 0) { e.preventDefault(); move(c.id, columns[ci - 1]!.id, 0); }
    if (e.key === "ArrowUp" && idx > 0) { e.preventDefault(); move(c.id, p.column, idx - 1); }
    if (e.key === "ArrowDown") { e.preventDefault(); move(c.id, p.column, idx + 1); }
  };

  return (
    <div className="col" style={{ height: "100%", gap: 0 }}>
      <div className="toolbar">
        <h1 className="toolbar-title">Board</h1>
        <select className="input" value={ctx} onChange={(e) => nav(`/board/${encodeURIComponent(e.target.value)}`)} aria-label="Board context">
          <option value="all">All features</option>
          <optgroup label="Repositories">
            {repos.map((r) => (
              <option key={r} value={`repo:${r}`}>
                {r}
              </option>
            ))}
          </optgroup>
          <optgroup label="Releases">
            {Object.values(releases).map((r) => (
              <option key={r.id} value={`release:${r.id}`}>
                {r.name}
              </option>
            ))}
          </optgroup>
        </select>
        <input className="input" data-workspace-search placeholder="Filter cards" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="faint small">Placement is per board; content is shared. Alt+Arrows moves the focused card.</span>
        <span className="spacer" />
        <button
          className="btn primary sm"
          onClick={createCard}
        >
          + Card
        </button>
      </div>
      <div className="board-layout">
      <Split id="board-details" className="workspace-split" initial={0.63} showSecond={!!editing && !editing.deleted}>
      <div className="board" tabIndex={0} aria-label="Board columns (scroll horizontally)">
        {columns.map((col) => {
          const cs = columnCards(allCards, placements, ctx, col.id, columns);
          return (
            <section
              key={col.id}
              className={`column ${dropCol === col.id ? "drop" : ""}`}
              aria-label={col.name}
              onDragOver={(e) => {
                e.preventDefault();
                setDropCol(col.id);
              }}
              onDragLeave={() => setDropCol(null)}
              onDrop={(e) => {
                e.preventDefault();
                setDropCol(null);
                if (!dragging) return;
                const cards = [...(e.currentTarget.querySelectorAll("[data-card]") as NodeListOf<HTMLElement>)];
                let idx = cards.findIndex((el) => e.clientY < el.getBoundingClientRect().top + el.offsetHeight / 2);
                if (idx < 0) idx = cards.length;
                move(dragging, col.id, idx);
                setDragging(null);
              }}
            >
              <div className="col-head">
                {col.name} <span className="faint">{cs.length}</span>
              </div>
              <div className="cards">
                {cs.map((c) => (
                  <CardView key={c.id} card={c} dragging={dragging === c.id} focused={focused === c.id} onFocus={() => setFocused(c.id)} onDragStart={() => setDragging(c.id)} onDragEnd={() => setDragging(null)} onOpen={() => openCard(c)} onKeyDown={keyMove(c)} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
      {editing && !editing.deleted && <CardEditor key={editing.id} card={editing} fresh={freshCard === editing.id} context={ctx} onClose={() => { setFreshCard(null); openCard(null); }} />}
      </Split>
      </div>
    </div>
  );
}

function CardView({ card, dragging, focused, onFocus, onDragStart, onDragEnd, onOpen, onKeyDown }: { card: FeatureCard; dragging: boolean; focused: boolean; onFocus: () => void; onDragStart: () => void; onDragEnd: () => void; onOpen: () => void; onKeyDown: (e: React.KeyboardEvent) => void }) {
  const prs = useApp((s) => s.prs);
  const releases = useApp((s) => s.releases);
  const cards = useApp((s) => s.cards);
  const { graph } = useChainGraph();
  const done = card.checklist.filter((c) => c.done).length;
  const blockedDeps = card.dependsOn.filter((d) => cards[d] && !cards[d]!.deleted);
  const unmergedUpstream = card.prs.flatMap((p) => [...graph.ancestors(p)]).filter((a) => prs[a]?.state !== "merged");
  return (
    <div
      data-card
      className={`card ${dragging ? "dragging" : ""}`}
      draggable
      tabIndex={0}
      onFocus={onFocus}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      aria-label={card.title}
      style={focused ? { borderColor: "var(--accent)" } : undefined}
    >
      <div style={{ fontWeight: 500 }}>{card.title}</div>
      <div className="row small" style={{ flexWrap: "wrap", gap: 4, marginTop: 4 }}>
        {card.releases.map((r) => (
          <span key={r} className="chip" style={{ borderLeft: `3px solid ${releases[r]?.color ?? "gray"}` }}>
            {releases[r]?.name ?? r}
          </span>
        ))}
        {card.repos.slice(0, 2).map((r) => (
          <span key={r} className="chip">
            {r.split("/")[1]}
          </span>
        ))}
        {card.prs.length > 0 && <span className="chip info">⇄ {card.prs.length} PR</span>}
        {(card.issues?.length ?? 0) > 0 && <span className="chip">◉ {card.issues!.length} issue{card.issues!.length === 1 ? "" : "s"}</span>}
        {card.checklist.length > 0 && <span className={`chip ${done === card.checklist.length ? "ok" : ""}`}>☑ {done}/{card.checklist.length}</span>}
        {blockedDeps.length > 0 && <span className="chip warn">⛓ {blockedDeps.length} dep</span>}
        {unmergedUpstream.length > 0 && <span className="chip warn" title={unmergedUpstream.join(", ")}>⬆ {unmergedUpstream.length} upstream open</span>}
      </div>
    </div>
  );
}

const DEFAULT_TITLE = "New feature";

function uniqueOptions(options: CachedOption[]): CachedOption[] {
  const seen = new Set<string>();
  return options.filter((o) => !seen.has(o.value) && !!seen.add(o.value));
}

/**
 * Resolve what was typed in a link box (`owner/repo#12`, `#12` or `12`) to a PR or issue.
 * Bare numbers are tried against the card's repositories first, then the board's and views'.
 */
async function resolveRef(value: string, repos: string[], want: "pr" | "issue"): Promise<{ key: string; title: string; repo: string } | null> {
  const text = value.trim();
  const full = parsePRKey(text);
  const bare = /^#?(\d+)$/.exec(text);
  const targets = full ? [{ repo: `${full.owner}/${full.repo}`.toLowerCase(), n: full.number }] : bare ? repos.slice(0, 8).map((repo) => ({ repo, n: Number(bare[1]) })) : [];
  for (const { repo, n } of targets) {
    const hit = await lookupNumber(repo, n);
    if (!hit) continue;
    if (hit.kind === "pr" && want === "pr") return { key: hit.key, title: hit.title, repo };
    if (hit.kind === "issue" && want === "issue") return { key: hit.issue.key, title: hit.issue.title, repo };
    if (full) return null; // exact reference of the other kind
  }
  return null;
}

function CardEditor({ card, fresh, context, onClose }: { card: FeatureCard; fresh: boolean; context: string; onClose: () => void }) {
  const put = useApp((s) => s.put);
  const cards = useApp((s) => s.cards);
  const releases = useApp((s) => s.releases);
  const prs = useApp((s) => s.prs);
  const placements = useApp(useShallow((s) => Object.values(s.placements).filter((p) => p.cardId === card.id)));
  const columns = useSettings().columns;
  const c = card;
  const repositories = useCachedRepositories();
  const [prIn, setPrIn] = useState("");
  const [item, setItem] = useState("");
  const [repoIn, setRepoIn] = useState("");
  const [issueIn, setIssueIn] = useState("");
  const issues = useApp((s) => s.issues);
  const views = useApp((s) => s.views);
  const toast = useApp((s) => s.toast);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!fresh) return;
    titleRef.current?.focus();
    titleRef.current?.select();
  }, [fresh]);
  const save = (next: FeatureCard) => put("cards", next.id, { ...next, updatedAt: Date.now() });
  /** Always the latest stored card, so async lookups don't overwrite edits made meanwhile. */
  const latest = () => useApp.getState().cards[c.id] ?? c;
  const lookupRepos = [...new Set([...c.repos, ...(context.startsWith("repo:") ? [context.slice(5)] : []), ...Object.values(views).flatMap((v) => v.repos)].map((r) => r.toLowerCase()))];
  const numberOptions = (typed: string, kind: "pr" | "issue"): CachedOption[] => {
    const n = /^#?(\d+)$/.exec(typed.trim())?.[1];
    if (!n) return [];
    const pool = kind === "pr" ? Object.values(prs).map((p) => ({ key: p.key, title: p.title })) : Object.values(issues).map((i) => ({ key: i.key, title: i.title }));
    return pool.filter((x) => x.key.endsWith(`#${n}`)).sort((a, b) => Number(lookupRepos.indexOf(a.key.split("#")[0]!) < 0) - Number(lookupRepos.indexOf(b.key.split("#")[0]!) < 0)).map((x) => ({ value: x.key, detail: x.title }));
  };
  const link = async (value: string, kind: "pr" | "issue") => {
    if (!value.trim()) return;
    (kind === "pr" ? setPrIn : setIssueIn)("");
    const hit = await resolveRef(value, lookupRepos, kind);
    if (!hit) {
      toast("warn", `Couldn't find ${kind === "pr" ? "a pull request" : "an issue"} “${value.trim()}”${/^#?\d+$/.test(value.trim()) ? " in this card's or your views' repositories" : ""}.`);
      return;
    }
    const cur = latest();
    const list = kind === "pr" ? cur.prs : cur.issues ?? [];
    save({
      ...cur,
      ...(kind === "pr" ? { prs: [...new Set([...list, hit.key])] } : { issues: [...new Set([...list, hit.key])] }),
      repos: [...new Set([...cur.repos, hit.repo])],
      title: !cur.title.trim() || cur.title === DEFAULT_TITLE ? hit.title : cur.title,
    });
  };
  const linkPR = (value: string) => void link(value, "pr");
  const linkIssue = (value: string) => void link(value, "issue");
  const [issueRepo, setIssueRepo] = useState("");
  const [creatingIssue, setCreatingIssue] = useState(false);
  const issueTargets = lookupRepos;
  const targetRepo = issueRepo || c.repos[0] || issueTargets[0] || "";
  const openUpstream = async () => {
    if (!targetRepo || creatingIssue) return;
    setCreatingIssue(true);
    try {
      const cur = latest();
      const res = await createIssue(targetRepo, cur.title.trim() || DEFAULT_TITLE, cardDescription(cur));
      const notice = deferredNotice(res, "Issue");
      if (notice) toast("warn", notice);
      else if (res && typeof res === "object" && "key" in res) {
        const now = latest();
        save({ ...now, issues: [...new Set([...(now.issues ?? []), res.key])], repos: [...new Set([...now.repos, targetRepo])] });
        toast("success", `Opened ${res.key} on GitHub.`);
      }
    } catch (e) {
      toast("error", e instanceof WriteBlocked ? e.message : describeError(e));
    } finally {
      setCreatingIssue(false);
    }
  };
  /** ⌘/Ctrl+Enter: keep whatever is half-typed in the entry boxes, then close the card. */
  const commitAndClose = () => {
    if (item.trim()) save({ ...latest(), checklist: [...latest().checklist, { id: newId("ck"), text: item.trim(), done: false }] });
    if (repoIn.trim()) linkRepo(repoIn);
    if (prIn.trim()) linkPR(prIn);
    if (issueIn.trim()) linkIssue(issueIn);
    onClose();
  };
  const linkRepo = (value: string) => {
    const repo = value.trim().toLowerCase();
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return;
    save({ ...latest(), repos: [...new Set([...latest().repos, repo])] });
    setRepoIn("");
  };
  return (
    <aside className="board-details" aria-label="Feature card" data-search-pane onKeyDownCapture={(e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        commitAndClose();
      }
    }}>
      <div className="inbox-detail-header"><span>Feature card</span><button className="btn ghost sm" aria-label="Close card" onClick={onClose}>✕</button></div>
      <div className="col pad">
        <input ref={titleRef} className="input" style={{ fontSize: 16, fontWeight: 600 }} value={c.title} onChange={(e) => save({ ...c, title: e.target.value })} aria-label="Title" />
        {!(c.issues?.length) && issueTargets.length > 0 && (
          <div className="row small board-upstream" role="group" aria-label="Create upstream issue">
            <span className="faint">Track upstream:</span>
            <select className="input" aria-label="Repository for the new issue" value={targetRepo} onChange={(e) => setIssueRepo(e.target.value)}>
              {issueTargets.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button className="btn sm" disabled={creatingIssue} title="Open a GitHub issue with this card's title and description, and link it" onClick={() => void openUpstream()}>
              {creatingIssue ? "Creating…" : "Create as GitHub issue"}
            </button>
          </div>
        )}
        <MarkdownField label="Description / completion criteria" value={cardDescription(c)} onChange={(description) => save({ ...c, description, links: [] })} />
        <div className="col" style={{ gap: 16 }}>
          <div className="grow col">
            <h3 className="h3">Checklist</h3>
            {c.checklist.map((it) => (
              <label key={it.id} className="row small">
                <input type="checkbox" checked={it.done} onChange={() => save({ ...c, checklist: c.checklist.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)) })} />
                <span className="grow">{it.text}</span>
                <button className="btn ghost sm" onClick={() => save({ ...c, checklist: c.checklist.filter((x) => x.id !== it.id) })}>
                  ✕
                </button>
              </label>
            ))}
            <input className="input" value={item} placeholder="Add item + Enter" onChange={(e) => setItem(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && item.trim()) { save({ ...c, checklist: [...c.checklist, { id: newId("ck"), text: item.trim(), done: false }] }); setItem(""); } }} />

            <h3 className="h3">Linked PRs</h3>
            {c.prs.map((p) => {
              const r = parsePRKey(p);
              return (
                <div key={p} className="row small">
                  <a href={`#/pr/${r?.owner}/${r?.repo}/${r?.number}`} className="grow ellipsis">
                    {p} {prs[p]?.title}
                  </a>
                  <span className="chip">{prs[p]?.state ?? "?"}</span>
                  <button className="btn ghost sm" onClick={() => save({ ...c, prs: c.prs.filter((x) => x !== p) })}>
                    ✕
                  </button>
                </div>
              );
            })}
            <CachedEntry label="Link pull request" placeholder="#123 or owner/repo#123 + Enter" value={prIn} onChange={setPrIn} onSelect={linkPR}
              options={uniqueOptions([...numberOptions(prIn, "pr"), ...Object.values(prs).map((pr) => ({ value: pr.key, detail: pr.title }))]).filter((o) => !c.prs.includes(o.value))}
              search={async (q) => { const hit = await resolveRef(q, lookupRepos, "pr"); return hit ? [{ value: hit.key, detail: hit.title }] : []; }} />

            <h3 className="h3">Linked issues</h3>
            {(c.issues ?? []).map((k) => {
              const issue = issues[k];
              const r = parsePRKey(k);
              return (
                <div key={k} className="row small">
                  <a href={issue?.url ?? `https://github.com/${r?.owner}/${r?.repo}/issues/${r?.number}`} target="_blank" rel="noreferrer" className="grow ellipsis">
                    {k} {issue?.title}
                  </a>
                  <span className="chip">{issue?.state ?? "?"}</span>
                  <button className="btn ghost sm" aria-label={`Unlink ${k}`} onClick={() => save({ ...latest(), issues: (latest().issues ?? []).filter((x) => x !== k) })}>✕</button>
                </div>
              );
            })}
            <CachedEntry label="Link issue" placeholder="#123 or owner/repo#123 + Enter" value={issueIn} onChange={setIssueIn} onSelect={linkIssue}
              options={uniqueOptions([...numberOptions(issueIn, "issue"), ...Object.values(issues).map((i) => ({ value: i.key, detail: i.title }))]).filter((o) => !(c.issues ?? []).includes(o.value))}
              search={async (q) => { const hit = await resolveRef(q, lookupRepos, "issue"); return hit ? [{ value: hit.key, detail: hit.title }] : []; }} />
            <MarkdownField label="Private notes" value={c.notes ?? ""} onChange={(notes) => save({ ...c, notes })} />
          </div>
          <div className="col">
            <h3 className="h3">Releases</h3>
            {Object.values(releases).map((r) => (
              <label key={r.id} className="row small">
                <input type="checkbox" checked={c.releases.includes(r.id)} onChange={(e) => save({ ...c, releases: e.target.checked ? [...c.releases, r.id] : c.releases.filter((x) => x !== r.id) })} />
                <span className="dot" style={{ background: r.color }} /> {r.name}
              </label>
            ))}
            <h3 className="h3">Repositories</h3>
            {c.repos.map((r) => (
              <div key={r} className="row small">
                <span className="grow">{r}</span>
                <button className="btn ghost sm" onClick={() => save({ ...c, repos: c.repos.filter((x) => x !== r) })}>
                  ✕
                </button>
              </div>
            ))}
            <RepoEntry label="Link repository" placeholder="owner/repo + Enter" value={repoIn} onChange={setRepoIn} onSelect={linkRepo} exclude={c.repos} />
            <h3 className="h3">Depends on cards</h3>
            <select aria-label="Add card dependency" className="input" value="" onChange={(e) => e.target.value && save({ ...c, dependsOn: [...new Set([...c.dependsOn, e.target.value])] })}>
              <option value="">Add dependency…</option>
              {Object.values(cards).filter((x) => x.id !== c.id && !x.deleted).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title}
                </option>
              ))}
            </select>
            {c.dependsOn.map((d) => (
              <div key={d} className="row small">
                <span className="grow">⛓ {cards[d]?.title ?? d}</span>
                <button className="btn ghost sm" onClick={() => save({ ...c, dependsOn: c.dependsOn.filter((x) => x !== d) })}>
                  ✕
                </button>
              </div>
            ))}
            <h3 className="h3">Placements</h3>
            {placements.map((p) => (
              <div key={p.context} className="small faint">
                {p.context}: {columns.find((x) => x.id === p.column)?.name ?? p.column}
              </div>
            ))}
            {!placements.length && <div className="small faint">Default column on every board</div>}
          </div>
        </div>
        <div className="row">
          <button className="btn danger" onClick={() => { save({ ...c, deleted: true }); onClose(); }}>Delete</button>
          <span className="spacer" />
          <button className="btn primary" onClick={commitAndClose} title="⌘/Ctrl+Enter">Done</button>
        </div>
      </div>
    </aside>
  );
}


function cardDescription(card: FeatureCard): string {
  if (!card.links.length) return card.description;
  const links = card.links.map(({ title, url }) => {
    const label = (title || url).replace(/[\\\[\]]/g, "\\$&").replace(/[\r\n]/g, " ");
    return `- [${label}](<${url.replace(/[<>\s]/g, encodeURIComponent)}>)`;
  });
  return [card.description, links.join("\n")].filter(Boolean).join("\n\n");
}

function MarkdownField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [editing, setEditing] = useState(false);
  return <section className="col">
    <div className="row">
      <h3 className="h3 grow">{label}</h3>
      {value && <button className="btn ghost sm" onClick={() => setEditing(!editing)}>{editing ? "Preview" : "Edit Markdown"}</button>}
    </div>
    {editing || !value
      ? <textarea className="input board-markdown" aria-label={label} placeholder="Markdown supported" value={value}
          onFocus={() => setEditing(true)} onChange={(e) => onChange(e.target.value)} />
      : <div className="md panel pad" dangerouslySetInnerHTML={{ __html: renderMarkdown(value) }} />}
  </section>;
}
