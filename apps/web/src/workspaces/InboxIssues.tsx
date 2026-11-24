import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { IssueSnapshot, RawIssueComment } from "@nonlinear/core";
import { useApp } from "../lib/store";
import { cachedCapabilities, deferredNotice, githubApi, guardedWrite } from "../lib/github";
import { renderMarkdown } from "../lib/markdown";
import { timeAgo } from "../components/ui";
import { MilestoneModal } from "./PRDetail";

/** Open issues across the view's repositories (Inbox → Issues tab). */
export function IssueList({ repos, query, current, onSelect, sort }: { repos: string[]; query: string; current: string | null; onSelect: (key: string) => void; sort: "updated" | "created" | "repo" }) {
  const issues = useApp((s) => s.issues);
  const list = useMemo(() => {
    const repoSet = new Set(repos.map((r) => r.toLowerCase()));
    const q = query.toLowerCase();
    const xs = Object.values(issues).filter((i) => i.state === "open" && repoSet.has(`${i.owner}/${i.repo}`.toLowerCase())
      && (!q || `${i.key} ${i.title} ${i.author} ${i.labels.join(" ")} ${i.milestone ?? ""}`.toLowerCase().includes(q)));
    const by: Record<typeof sort, (a: IssueSnapshot, b: IssueSnapshot) => number> = {
      updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
      created: (a, b) => b.createdAt.localeCompare(a.createdAt),
      repo: (a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }),
    };
    return xs.sort(by[sort]);
  }, [issues, repos, query, sort]);
  const parentRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({ count: list.length, getScrollElement: () => parentRef.current, getItemKey: (i) => list[i]!.key, estimateSize: () => 46, overscan: 12 });
  return (
    <div ref={parentRef} className="inbox-list" aria-label="Issues" tabIndex={-1}>
      {!list.length && <div className="empty">No cached open issues. Refresh to fetch.</div>}
      <div style={{ height: virt.getTotalSize(), position: "relative" }}>
        {virt.getVirtualItems().map((vi) => {
          const i = list[vi.index]!;
          return (
            <div key={vi.key} data-index={vi.index} ref={virt.measureElement} style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` }}>
              <div aria-current={current === i.key ? "true" : undefined} className={`list-row inbox-pr-row ${current === i.key ? "selected focused" : ""}`} onClick={() => onSelect(i.key)}>
                <span className="chip ok" title="Open issue">◉</span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis"><b style={{ fontWeight: 500 }}>{i.title}</b></div>
                  <div className="faint small ellipsis">{i.owner}/{i.repo}#{i.number} · {i.author} · {timeAgo(i.updatedAt)}{i.comments ? ` · 💬 ${i.comments}` : ""}</div>
                </div>
                {i.milestone && <span className="chip info">⚑ {i.milestone}</span>}
                {i.labels.slice(0, 2).map((l) => <span key={l} className="chip">{l}</span>)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function IssueDetail({ issueKey }: { issueKey: string }) {
  const issue = useApp((s) => s.issues[issueKey]);
  const cards = useApp((s) => s.cards);
  const online = useApp((s) => s.online);
  const [milestoneOpen, setMilestoneOpen] = useState(false);
  const [comments, setComments] = useState<RawIssueComment[] | null>(null);
  useEffect(() => {
    if (!issue || !online) return;
    let live = true;
    void githubApi().then((api) => api.listIssueComments(issue.owner, issue.repo, issue.number)).then((c) => live && setComments(c), () => live && setComments([]));
    return () => { live = false; };
  }, [issue?.key, online]);
  if (!issue) return <div className="empty">Issue unavailable.</div>;
  const caps = cachedCapabilities(`${issue.owner}/${issue.repo}`.toLowerCase());
  const linked = Object.values(cards).filter((c) => !c.deleted && c.issues?.includes(issue.key));
  const setMilestone = async (milestone: number | null) => {
    const res = await guardedWrite(issue.key, "can-edit-metadata", "milestone", { milestone }, async () => {
      const api = await githubApi();
      await api.setMilestone(issue.owner, issue.repo, issue.number, milestone);
      const { isPull: _p, ...fresh } = await api.getIssue(issue.owner, issue.repo, issue.number);
      useApp.getState().put("issues", fresh.key, fresh);
    });
    return deferredNotice(res, "Milestone");
  };
  return (
    <div className="pad col" style={{ gap: 12 }}>
      <div>
        <div className="row small faint">
          <span>{issue.owner}/{issue.repo}#{issue.number}</span>
          <span className="spacer" />
          <span>fetched {timeAgo(issue.fetchedAt)}</span>
        </div>
        <h1 className="h1">{issue.title}</h1>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <span className={`chip ${issue.state === "open" ? "ok" : ""}`}>{issue.state}</span>
          {issue.labels.map((l) => <span key={l} className="chip">{l}</span>)}
        </div>
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <a className="btn" href={issue.url} target="_blank" rel="noreferrer">Open on GitHub ↗</a>
        {linked.length > 0 && <span className="small faint">▦ On {linked.map((c) => c.title).join(", ")}</span>}
      </div>
      <section className="row" style={{ alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div style={{ minWidth: 140 }}><h3 className="h3">Author</h3><div className="small">{issue.author}</div></div>
        <div style={{ minWidth: 140 }}>
          <h3 className="h3 row" style={{ marginBottom: 2 }}>
            Milestone
            {caps.has("can-edit-metadata") && <button className="btn ghost sm" aria-label="Edit Milestone" onClick={() => setMilestoneOpen(true)}>✎</button>}
          </h3>
          <div className="small">{issue.milestone ? <span className="chip info">⚑ {issue.milestone}</span> : "—"}</div>
        </div>
        <div style={{ minWidth: 140 }}><h3 className="h3">Assignees</h3><div className="small">{issue.assignees.join(", ") || "—"}</div></div>
        <div style={{ minWidth: 140 }}><h3 className="h3">Updated</h3><div className="small">{timeAgo(issue.updatedAt)}</div></div>
      </section>
      <section>
        <h3 className="h3">Description</h3>
        <div className="md panel pad" dangerouslySetInnerHTML={{ __html: renderMarkdown(issue.body) || "<em>No description</em>" }} />
      </section>
      <section className="col" aria-label="GitHub comments">
        <h3 className="h3">Comments {comments?.length ? `(${comments.length})` : ""}</h3>
        {comments?.map((c) => (
          <article className="panel pad" key={c.html_url}>
            <div className="row small"><b>{c.user?.login ?? "Deleted user"}</b><a className="faint" href={c.html_url} target="_blank" rel="noreferrer">{timeAgo(c.created_at)}</a></div>
            <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(c.body) }} />
          </article>
        ))}
        {!comments?.length && <div className="faint small">{comments ? "No comments." : online ? "Loading comments…" : "Comments are unavailable offline."}</div>}
      </section>
      {milestoneOpen && <MilestoneModal owner={issue.owner} repo={issue.repo} itemKey={issue.key} current={issue.milestone} onPick={setMilestone} onClose={() => setMilestoneOpen(false)} />}
    </div>
  );
}
