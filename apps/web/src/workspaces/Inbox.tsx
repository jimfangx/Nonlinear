import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CATEGORY_LABELS, summarizeEvents, classify, isSnoozed, isUnread, newId, type Category, type PRSnapshot } from "@nonlinear/core";
import { useApp, useSettings, type RepositoryView } from "../lib/store";
import { refreshRepos, describeError } from "../lib/github";
import { useChainGraph, blockedSet } from "../lib/chains";
import { useActions } from "../lib/keys";
import { RepoPicker } from "../components/RepoPicker";
import { Split, Modal, CIChip, ReviewChip, PRStateChip, timeAgo } from "../components/ui";
import { PRDetail } from "./PRDetail";

const CATS: Category[] = ["needs-my-review", "my-drafts", "my-open", "awaiting-review", "waiting-for-ci", "ci-failing", "changes-requested", "ready-to-merge", "blocked-by-chain", "all-open"];

export function Inbox() {
  const { viewId } = useParams();
  const views = useApp((s) => s.views);
  const nav = useNavigate();
  const [editing, setEditing] = useState<RepositoryView | null>(null);
  const [params, setParams] = useSearchParams();
  const requested = params.get("pr");
  const creating = params.has("newView");
  const [draft] = useState(newView);
  const closeEditor = () => {
    setEditing(null);
    if (creating) setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.delete("newView");
      return next;
    }, { replace: true });
  };
  const editor = (creating || editing) && <ViewEditor view={creating ? draft : editing!} onClose={closeEditor} />;
  const view = viewId ? views[viewId] : Object.values(views).sort((a, b) => a.createdAt - b.createdAt)[0];

  useEffect(() => {
    if (!viewId && view && !creating) nav(`/inbox/${view.id}${params.size ? "?" + params : ""}`, { replace: true });
  }, [viewId, view, nav, creating, params]);

  if (!view && requested) {
    return <div className="inbox-layout inbox-without-view">
      <aside className="empty">Create a repository view to populate the Inbox.</aside>
      <InboxDetail prKey={requested} close={() => nav("/inbox", { replace: true })} />
      {editor}
    </div>;
  }
  if (!view) {
    return (
      <div className="page">
        <div className="panel pad" style={{ maxWidth: 720, margin: "40px auto" }}>
          <h1 className="h1">Create your first repository view</h1>
          <p className="muted">
            A view is a named set of repositories across any organizations. Public repositories work without signing in and without installing anything into those organizations.
          </p>
          <button className="btn primary" onClick={() => setEditing(newView())}>
            Create a view
          </button>
          <button
            className="btn"
            style={{ marginLeft: 8 }}
            onClick={() => {
              const v = { ...newView(), name: "Chipyard integration", repos: ["ucb-bar/chipyard", "riscv-boom/riscv-boom", "chipsalliance/rocket-chip", "firesim/firesim"] };
              useApp.getState().put("views", v.id, v);
              nav(`/inbox/${v.id}`);
            }}
          >
            Use “Chipyard integration” example
          </button>
        </div>
        {editor}
      </div>
    );
  }
  return <><InboxView key={view.id} view={view} onEdit={() => setEditing(view)} requested={requested} />{editor}</>;
}

function newView(): RepositoryView {
  return { id: newId("view"), name: "New view", repos: [], category: "all-open", groupBy: "none", sort: "updated", releaseLens: null, createdAt: Date.now() };
}

function InboxView({ view, onEdit, requested }: { view: RepositoryView; onEdit: () => void; requested: string | null }) {
  const prs = useApp((s) => s.prs);
  const prLocal = useApp((s) => s.prLocal);
  const prEvents = useApp((s) => s.prEvents);
  const releases = useApp((s) => s.releases);
  const cards = useApp((s) => s.cards);
  const settings = useSettings();
  const put = useApp((s) => s.put);
  const patch = useApp((s) => s.patch);
  const toast = useApp((s) => s.toast);
  const [, setParams] = useSearchParams();
  const { graph } = useChainGraph();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<Category>((view.category as Category) ?? "all-open");
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const current = requested;
  const activePR = current ? prs[current] : undefined;

  const repoSet = useMemo(() => new Set(view.repos), [view.repos]);
  const viewPRs = useMemo(() => Object.values(prs).filter((p) => repoSet.has(`${p.owner}/${p.repo}`.toLowerCase())), [prs, repoSet]);
  const blocked = useMemo(() => blockedSet(graph, prs), [graph, prs]);
  const ctx = useMemo(() => ({ me: settings.me, myTeams: settings.myTeams, blockedByChain: blocked, policy: settings.policy }), [settings.me, settings.myTeams, blocked, settings.policy]);
  const cats = useMemo(() => new Map(viewPRs.map((p) => [p.key, classify(p, ctx)])), [viewPRs, ctx]);

  // Release lens (§2.1): PRs referenced by release-tagged cards + their direct deps.
  const lensSet = useMemo(() => {
    if (!view.releaseLens) return null;
    const s = new Set<string>();
    for (const c of Object.values(cards)) if (c.releases.includes(view.releaseLens)) c.prs.forEach((p) => s.add(p));
    for (const k of [...s]) graph.prerequisites(k).forEach((p) => s.add(p));
    return s;
  }, [view.releaseLens, cards, graph]);

  const counts = useMemo(() => {
    const m = new Map<Category, number>();
    for (const [k, cs] of cats) {
      if (!showSnoozed && isSnoozed(prLocal[k])) continue;
      for (const c of cs) m.set(c, (m.get(c) ?? 0) + 1);
    }
    return m;
  }, [cats, prLocal, showSnoozed]);

  const list = useMemo(() => {
    const ql = q.toLowerCase();
    let xs = viewPRs.filter((p) => cats.get(p.key)?.has(cat));
    if (!showSnoozed) xs = xs.filter((p) => !isSnoozed(prLocal[p.key]));
    if (lensSet) xs = xs.filter((p) => lensSet.has(p.key));
    if (ql) xs = xs.filter((p) => `${p.key} ${p.title} ${p.author} ${p.labels.join(" ")} ${p.headRef}`.toLowerCase().includes(ql));
    const sorter: Record<RepositoryView["sort"], (a: PRSnapshot, b: PRSnapshot) => number> = {
      updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
      created: (a, b) => b.createdAt.localeCompare(a.createdAt),
      repo: (a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }),
    };
    xs.sort((a, b) => Number(!!prLocal[b.key]?.pinned) - Number(!!prLocal[a.key]?.pinned) || sorter[view.sort](a, b));
    if (view.groupBy === "repo") xs.sort((a, b) => `${a.owner}/${a.repo}`.localeCompare(`${b.owner}/${b.repo}`));
    if (view.groupBy === "chain") {
      const comp = new Map<string, string>();
      for (const p of xs) comp.set(p.key, graph.component(p.key).sort()[0]!);
      xs.sort((a, b) => comp.get(a.key)!.localeCompare(comp.get(b.key)!));
    }
    if (requested && activePR && !xs.some((p) => p.key === requested)) xs.unshift(activePR);
    return xs;
  }, [requested, activePR, viewPRs, cats, cat, q, prLocal, showSnoozed, view.sort, view.groupBy, graph, lensSet]);

  const groupOf = (p: PRSnapshot): string | null => {
    if (view.groupBy === "repo") return `${p.owner}/${p.repo}`;
    if (view.groupBy === "chain") {
      const c = graph.component(p.key);
      return c.length > 1 ? `Chain: ${graph.topoOrder(c).map((k) => k.split("/")[1]).join(" → ")}` : "Unchained";
    }
    if (view.groupBy === "release") {
      const rels = Object.values(cards).filter((c) => c.prs.includes(p.key)).flatMap((c) => c.releases);
      return rels.length ? rels.map((r) => releases[r]?.name ?? r).join(", ") : "No release";
    }
    return null;
  };

  const refresh = async () => {
    if (!view.repos.length) return;
    setBusy("Refreshing…");
    try {
      const r = await refreshRepos(view.repos, (p) => setBusy(`Refreshing ${p.done}/${p.total}…`));
      if (r.errors.length) toast("warn", r.errors.slice(0, 3).join("\n"));
    } catch (e) {
      toast("error", describeError(e));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    const newest = Math.max(0, ...viewPRs.map((p) => p.fetchedAt));
    if (!requested && Date.now() - newest > 10 * 60_000 && useApp.getState().online) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.id]);

  const entries: ({ group: string } | { pr: PRSnapshot })[] = [];
  let previousGroup: string | null = null;
  for (const pr of list) {
    const group = groupOf(pr);
    if (group && group !== previousGroup) entries.push({ group });
    previousGroup = group;
    if (view.groupBy !== "repo" || !group || !collapsed.has(group)) entries.push({ pr });
  }

  const visiblePRs = entries.flatMap((entry) => "pr" in entry ? [entry.pr] : []);
  const focus = visiblePRs.findIndex((p) => p.key === current);
  const selectPR = (key: string | null) => {
    if (key === current) return;
    setParams((existing) => {
      const next = new URLSearchParams(existing);
      if (key) next.set("pr", key);
      else next.delete("pr");
      return next;
    }, { replace: true });
  };

  useActions({
    next: () => { if (visiblePRs.length) selectPR(visiblePRs[Math.min(visiblePRs.length - 1, focus + 1)]!.key); },
    prev: () => { if (visiblePRs.length) selectPR(visiblePRs[Math.max(0, focus - 1)]!.key); },
  });

  useEffect(() => {
    if (!activePR) return;
    const { prLocal, put } = useApp.getState();
    if (view.groupBy === "repo") setCollapsed((old) => {
      const group = `${activePR.owner}/${activePR.repo}`;
      if (!old.has(group)) return old;
      const next = new Set(old); next.delete(group); return next;
    });
    put("prLocal", activePR.key, { ...prLocal[activePR.key], lastViewedAt: Date.now(), lastViewedUpdatedAt: activePR.updatedAt });
  }, [activePR?.key]);

  const bulk = (fn: (k: string) => void) => {
    const keys = selected.size ? [...selected] : current ? [current] : [];
    keys.forEach(fn);
    setSelected(new Set());
  };

  const parentRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({ count: entries.length, getScrollElement: () => parentRef.current, estimateSize: () => 60, overscan: 12 });
  const selectedIndex = entries.findIndex((entry) => "pr" in entry && entry.pr.key === current);
  useEffect(() => { if (selectedIndex >= 0) virt.scrollToIndex(selectedIndex, { align: "auto" }); }, [selectedIndex, virt]);
  const newest = Math.max(0, ...viewPRs.map((p) => p.fetchedAt));

  const listPane = (
    <div ref={parentRef} className="inbox-list" aria-label="Pull requests">
      {!list.length && <div className="empty">{viewPRs.length ? "No PRs in this category." : busy ? busy : "No cached PRs yet. Refresh to fetch."}</div>}
      <div style={{ height: virt.getTotalSize(), position: "relative" }}>
        {virt.getVirtualItems().map((vi) => {
          const entry = entries[vi.index]!;
          const style = { position: "absolute" as const, top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` };
          if ("group" in entry) {
            const group = entry.group;
            const closed = collapsed.has(group);
            return <div key={`group:${vi.index}:${group}`} style={style} data-index={vi.index} ref={virt.measureElement}>
              {view.groupBy === "repo" ? <button className="inbox-group" aria-expanded={!closed} onClick={() => {
                const next = new Set(collapsed);
                if (closed) next.delete(group);
                else {
                  next.add(group);
                  if (activePR && groupOf(activePR) === group) selectPR(null);
                }
                setCollapsed(next);
              }}><span aria-hidden="true">{closed ? "▸" : "▾"}</span> {group}</button> : <h3 className="inbox-group h3">{group}</h3>}
            </div>;
          }
          const p = entry.pr;
          const unread = isUnread(p, prLocal[p.key]);
          return (
            <div key={p.key} style={style} data-index={vi.index} ref={virt.measureElement}>
              <div
                aria-current={current === p.key ? "true" : undefined}
                className={`list-row ${current === p.key ? "selected" : ""} ${current === p.key ? "focused" : ""}`}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey) {
                    const s = new Set(selected);
                    s.has(p.key) ? s.delete(p.key) : s.add(p.key);
                    setSelected(s);
                    return;
                  }
                  selectPR(p.key);
                }}
              >
                <input type="checkbox" aria-label={`Select ${p.key}`} checked={selected.has(p.key)} onClick={(e) => e.stopPropagation()} onChange={() => { const s = new Set(selected); s.has(p.key) ? s.delete(p.key) : s.add(p.key); setSelected(s); }} />
                <span className="dot" style={{ background: unread ? "var(--accent)" : "transparent" }} title={unread ? "Updated since you last viewed" : ""} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis">
                    {prLocal[p.key]?.pinned && "📌 "}
                    <b style={{ fontWeight: unread ? 600 : 500 }}>{p.title}</b>
                  </div>
                  <div className="faint small ellipsis">
                    {p.owner}/{p.repo}#{p.number} · {p.author} · {timeAgo(p.updatedAt)}
                    {blocked.has(p.key) && " · ⛓ blocked"}
                  </div>
                  {(() => {
                    const sum = summarizeEvents(prEvents[p.key] ?? [], prLocal[p.key]?.lastViewedAt);
                    return sum ? <div className="small ellipsis" style={{ color: "var(--accent)" }} title="Since you last viewed">↳ {sum}</div> : null;
                  })()}
                </div>
                <PRStateChip pr={p} />
                <ReviewChip d={p.reviewDecision} />
                <CIChip ci={p.ci} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <>
      <div className="toolbar">
        <h1 className="toolbar-title">{view.name}</h1>
        <button className="btn sm" onClick={onEdit}>
          Edit view
        </button>
        <input className="input" style={{ width: 240 }} placeholder="Filter PRs…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" value={view.groupBy} onChange={(e) => patch("views", view.id, { groupBy: e.target.value as RepositoryView["groupBy"] })} aria-label="Group by">
          <option value="none">No grouping</option>
          <option value="repo">Group by repository</option>
          <option value="chain">Group by chain</option>
          <option value="release">Group by release</option>
        </select>
        <select className="input" value={view.sort} onChange={(e) => patch("views", view.id, { sort: e.target.value as RepositoryView["sort"] })} aria-label="Sort">
          <option value="updated">Recently updated</option>
          <option value="created">Newest</option>
          <option value="repo">Repository</option>
        </select>
        <select className="input" value={view.releaseLens ?? ""} onChange={(e) => patch("views", view.id, { releaseLens: e.target.value || null })} aria-label="Release lens" title="Show only pull requests attached to cards in this release, plus their direct prerequisites.">
          <option value="">No release filter</option>
          {Object.values(releases).map((r) => (
            <option key={r.id} value={r.id}>
              Release: {r.name}
            </option>
          ))}
        </select>
        <label className="row small">
          <input type="checkbox" checked={showSnoozed} onChange={(e) => setShowSnoozed(e.target.checked)} /> snoozed
        </label>
        <span className="spacer" />
        {selected.size > 0 && <span className="small muted">{selected.size} selected</span>}
        <button className="btn sm" onClick={() => bulk((k) => put("prLocal", k, { ...prLocal[k], pinned: !prLocal[k]?.pinned }))}>
          📌 Pin
        </button>
        <button className="btn sm" onClick={() => bulk((k) => put("prLocal", k, { ...prLocal[k], snoozedUntil: isSnoozed(prLocal[k]) ? null : Date.now() + 86400_000 }))}>
          💤 Snooze 1d
        </button>
        <span className="faint small">{newest ? `fetched ${timeAgo(newest)}` : "never fetched"}</span>
        <button className="btn sm" disabled={!!busy} onClick={() => void refresh()}>
          {busy ?? "↻ Refresh"}
        </button>
      </div>
      <div className="tabs" role="tablist">
        {CATS.map((c) => (
          <button
            key={c}
            role="tab"
            aria-selected={cat === c}
            className={`tab ${cat === c ? "active" : ""}`}
            onClick={() => {
              setCat(c);
              selectPR(null);
              patch("views", view.id, { category: c });
            }}
          >
            {CATEGORY_LABELS[c]} <span className="faint">{counts.get(c) ?? 0}</span>
          </button>
        ))}
      </div>
      <div className="inbox-layout">
        <Split id="inbox" initial={0.46} showSecond={!!current}>
          {listPane}
          {current && <InboxDetail prKey={current} close={() => selectPR(null)} />}
        </Split>
      </div>
    </>
  );
}

function InboxDetail({ prKey, close }: { prKey: string; close: () => void }) {
  return <section className="inbox-detail" aria-label="Pull request details">
    <div className="inbox-detail-header"><span>Pull request details</span><button className="btn ghost sm" onClick={close} aria-label="Close pull request details" title="Close pull request details">✕</button></div>
    <PRDetail key={prKey} prKey={prKey} />
  </section>;
}

function ViewEditor({ view, onClose }: { view: RepositoryView; onClose: () => void }) {
  const [name, setName] = useState(view.name);
  const [repos, setRepos] = useState(view.repos);
  const put = useApp((s) => s.put);
  const remove = useApp((s) => s.remove);
  const exists = !!useApp.getState().views[view.id];
  const nav = useNavigate();
  return (
    <Modal
      title={exists ? "Edit view" : "New view"}
      onClose={onClose}
      wide
      footer={
        <>
          {exists && (
            <button
              className="btn danger"
              onClick={() => {
                remove("views", view.id);
                onClose();
                nav("/inbox");
              }}
            >
              Delete view
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!name.trim()}
            onClick={() => {
              put("views", view.id, { ...view, name: name.trim(), repos });
              onClose();
              nav(`/inbox/${view.id}`);
            }}
          >
            Save
          </button>
        </>
      }
    >
      <div className="col">
        <label className="col" style={{ gap: 4 }}>
          <span className="small muted">Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <RepoPicker value={repos} onChange={setRepos} />
      </div>
    </Modal>
  );
}
