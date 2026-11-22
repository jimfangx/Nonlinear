import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
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
  const view = viewId ? views[viewId] : Object.values(views).sort((a, b) => a.createdAt - b.createdAt)[0];

  useEffect(() => {
    if (!viewId && view) nav(`/inbox/${view.id}`, { replace: true });
  }, [viewId, view, nav]);

  if (!view) {
    return (
      <div className="page">
        <div className="panel pad" style={{ maxWidth: 720, margin: "40px auto" }}>
          <h1 className="h1">Create your first repository view</h1>
          <p className="muted">
            A view is a named set of repositories across any organizations. Public repositories work without signing in and without installing anything into those organizations.
          </p>
          <button className="btn primary" onClick={() => setEditing(newView())}>
            New view
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
        {editing && <ViewEditor view={editing} onClose={() => setEditing(null)} />}
      </div>
    );
  }
  return <InboxView key={view.id} view={view} onEdit={() => setEditing(view)} editing={editing} setEditing={setEditing} />;
}

function newView(): RepositoryView {
  return { id: newId("view"), name: "New view", repos: [], category: "all-open", groupBy: "none", sort: "updated", releaseLens: null, createdAt: Date.now() };
}

function InboxView({ view, onEdit, editing, setEditing }: { view: RepositoryView; onEdit: () => void; editing: RepositoryView | null; setEditing: (v: RepositoryView | null) => void }) {
  const prs = useApp((s) => s.prs);
  const prLocal = useApp((s) => s.prLocal);
  const prEvents = useApp((s) => s.prEvents);
  const releases = useApp((s) => s.releases);
  const cards = useApp((s) => s.cards);
  const settings = useSettings();
  const put = useApp((s) => s.put);
  const patch = useApp((s) => s.patch);
  const toast = useApp((s) => s.toast);
  const nav = useNavigate();
  const { graph } = useChainGraph();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<Category>((view.category as Category) ?? "all-open");
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);

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
    return xs;
  }, [viewPRs, cats, cat, q, prLocal, showSnoozed, view.sort, view.groupBy, graph, lensSet]);

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
    if (Date.now() - newest > 10 * 60_000 && useApp.getState().online) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.id]);

  const open = (p: PRSnapshot) => {
    setCurrent(p.key);
    const prev = prLocal[p.key] ?? {};
    put("prLocal", p.key, { ...prev, lastViewedAt: Date.now(), lastViewedUpdatedAt: p.updatedAt });
  };

  useActions(
    {
      next: () => setFocus((f) => Math.min(list.length - 1, f + 1)),
      prev: () => setFocus((f) => Math.max(0, f - 1)),
    },
    [list.length],
  );

  useEffect(() => {
    const p = list[focus];
    if (p) open(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const bulk = (fn: (k: string) => void) => {
    const keys = selected.size ? [...selected] : current ? [current] : [];
    keys.forEach(fn);
    setSelected(new Set());
  };

  const parentRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({ count: list.length, getScrollElement: () => parentRef.current, estimateSize: () => 60, overscan: 12 });
  useEffect(() => virt.scrollToIndex(focus, { align: "auto" }), [focus, virt]);
  const newest = Math.max(0, ...viewPRs.map((p) => p.fetchedAt));

  return (
    <>
      <div className="toolbar">
        <h1 className="toolbar-title">{view.name}</h1>
        <button className="btn sm" onClick={onEdit}>
          Edit view
        </button>
        <button className="btn sm" onClick={() => setEditing(newView())}>
          + New view
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
        <select className="input" value={view.releaseLens ?? ""} onChange={(e) => patch("views", view.id, { releaseLens: e.target.value || null })} aria-label="Release lens">
          <option value="">No release lens</option>
          {Object.values(releases).map((r) => (
            <option key={r.id} value={r.id}>
              Lens: {r.name}
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
              setFocus(0);
              patch("views", view.id, { category: c });
            }}
          >
            {CATEGORY_LABELS[c]} <span className="faint">{counts.get(c) ?? 0}</span>
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Split id="inbox" initial={0.48}>
          <div ref={parentRef} style={{ height: "100%", overflow: "auto" }} aria-label="Pull requests">
            {!list.length && <div className="empty">{viewPRs.length ? "No PRs in this category." : busy ? busy : "No cached PRs yet. Refresh to fetch."}</div>}
            <div style={{ height: virt.getTotalSize(), position: "relative" }}>
              {virt.getVirtualItems().map((vi) => {
                const p = list[vi.index]!;
                const g = groupOf(p);
                const prevG = vi.index > 0 ? groupOf(list[vi.index - 1]!) : null;
                const unread = isUnread(p, prLocal[p.key]);
                return (
                  <div key={p.key} style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` }} data-index={vi.index} ref={virt.measureElement}>
                    {g && g !== prevG && <h3 className="h3" style={{ padding: "10px 12px 4px", margin: 0, background: "var(--bg-2)" }}>{g}</h3>}
                    <div
                      aria-current={current === p.key ? "true" : undefined}
                      className={`list-row ${current === p.key ? "selected" : ""} ${vi.index === focus ? "focused" : ""}`}
                      onClick={(e) => {
                        if (e.metaKey || e.ctrlKey || e.shiftKey) {
                          const s = new Set(selected);
                          s.has(p.key) ? s.delete(p.key) : s.add(p.key);
                          setSelected(s);
                          return;
                        }
                        setFocus(vi.index);
                        open(p);
                      }}
                      onDoubleClick={() => nav(`/pr/${p.owner}/${p.repo}/${p.number}`)}
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
          <div style={{ height: "100%", overflow: "auto" }}>{current && prs[current] ? <PRDetail prKey={current} /> : <div className="empty">Select a PR (j/k to navigate)</div>}</div>
        </Split>
      </div>
      {editing && <ViewEditor view={editing} onClose={() => setEditing(null)} />}
    </>
  );
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
