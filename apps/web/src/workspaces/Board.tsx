import { useShallow } from "zustand/react/shallow";
import { useEffect, useMemo, useState } from "react";
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
  const createCard = () => {
    const card = newCardInContext(newId("card"), "New feature", ctx);
    useApp.getState().put("cards", card.id, card);
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
      {editing && !editing.deleted && <CardEditor key={editing.id} card={editing} onClose={() => openCard(null)} />}
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
        {card.checklist.length > 0 && <span className={`chip ${done === card.checklist.length ? "ok" : ""}`}>☑ {done}/{card.checklist.length}</span>}
        {blockedDeps.length > 0 && <span className="chip warn">⛓ {blockedDeps.length} dep</span>}
        {unmergedUpstream.length > 0 && <span className="chip warn" title={unmergedUpstream.join(", ")}>⬆ {unmergedUpstream.length} upstream open</span>}
      </div>
    </div>
  );
}

function CardEditor({ card, onClose }: { card: FeatureCard; onClose: () => void }) {
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
  const save = (next: FeatureCard) => put("cards", next.id, { ...next, updatedAt: Date.now() });
  const linkPR = (value: string) => {
    const pr = parsePRKey(value.trim());
    if (!pr) return;
    save({ ...c, prs: [...new Set([...c.prs, `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase()])] });
    setPrIn("");
  };
  const linkRepo = (value: string) => {
    const repo = value.trim().toLowerCase();
    if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return;
    save({ ...c, repos: [...new Set([...c.repos, repo])] });
    setRepoIn("");
  };
  return (
    <aside className="board-details" aria-label="Feature card" data-search-pane>
      <div className="inbox-detail-header"><span>Feature card</span><button className="btn ghost sm" aria-label="Close card" onClick={onClose}>✕</button></div>
      <div className="col pad">
        <input className="input" style={{ fontSize: 16, fontWeight: 600 }} value={c.title} onChange={(e) => save({ ...c, title: e.target.value })} aria-label="Title" />
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
            <CachedEntry label="Link pull request" placeholder="owner/repo#123 + Enter" value={prIn} onChange={setPrIn} onSelect={linkPR}
              options={Object.values(prs).filter((pr) => !c.prs.includes(pr.key)).map((pr) => ({ value: pr.key, detail: pr.title }))} />
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
          <button className="btn primary" onClick={onClose}>Done</button>
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
