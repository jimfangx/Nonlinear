import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { parsePRKey, newId, type FeatureCard, type RawIssueComment, type RawReviewComment } from "@nonlinear/core";
import { useApp } from "../lib/store";
import { cachedCapabilities, ensurePR, enrichPR, githubApi, updatePRFields, describeError, deferredNotice, WriteBlocked } from "../lib/github";
import { renderMarkdown } from "../lib/markdown";
import { ChainPanel } from "../components/ChainPanel";
import { CIChip, ReviewChip, PRStateChip, timeAgo, Modal } from "../components/ui";

/** In-app PR details with GitHub-equivalent metadata and permitted edits (§2.1). */
export function PRDetail({ prKey }: { prKey: string }) {
  const pr = useApp((s) => s.prs[prKey]);
  const linkedCards = useApp((s) => s.cards);
  const linked = Object.values(linkedCards).filter((card) => !card.deleted && card.prs.includes(prKey));
  const toast = useApp((s) => s.toast);
  const online = useApp((s) => s.online);
  const [editing, setEditing] = useState<null | "body" | "labels" | "reviewers">(null);
  const [linkCard, setLinkCard] = useState(false);
  const r = parsePRKey(prKey);
  const repoKey = r ? `${r.owner}/${r.repo}`.toLowerCase() : "";
  const [loading, setLoading] = useState(false);
  const caps = cachedCapabilities(repoKey);

  useEffect(() => {
    if (!r || !online || pr) return;
    let cancelled = false;
    setLoading(true);
    void ensurePR(prKey).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [prKey, online, !!pr]);

  useEffect(() => {
    if (!pr || !online || (pr.reviewDecision !== "unknown" && pr.ci !== "unknown")) return;
    const timer = window.setTimeout(() => void enrichPR(prKey).catch(() => undefined), 450);
    return () => window.clearTimeout(timer);
  }, [prKey, online, !!pr]);

  if (!pr) return <div className="empty">{loading ? "Loading PR…" : "Pull request unavailable."}</div>;
  return (
    <div className="pad col" style={{ gap: 12 }}>
      <div>
        <div className="row small faint">
          <span>
            {pr.owner}/{pr.repo}#{pr.number}
          </span>
          <span>·</span>
          <span>
            {pr.headRef} → {pr.baseRef}
          </span>
          <span className="spacer" />
          <span>fetched {timeAgo(pr.fetchedAt)}</span>
        </div>
        <h1 className="h1">{pr.title}</h1>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <PRStateChip pr={pr} />
          <ReviewChip d={pr.reviewDecision} />
          <CIChip ci={pr.ci} />
          <span className={`chip ${pr.mergeable === false ? "err" : pr.mergeable ? "ok" : ""}`}>{pr.mergeable === null ? "mergeability ?" : pr.mergeable ? "mergeable" : "conflicts"}</span>
          <span className="chip">
            +{pr.additions} −{pr.deletions} · {pr.changedFiles} files
          </span>
          {pr.milestone && <span className="chip info">⚑ {pr.milestone}</span>}
        </div>
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <Link className="btn primary" to={`/review/${pr.owner}/${pr.repo}/${pr.number}`}>
          Open in Review
        </Link>
        <a className="btn" href={pr.url} target="_blank" rel="noreferrer">
          Open on GitHub ↗
        </a>
        <button className="btn" onClick={() => setLinkCard(true)}>
          {linked.length ? `▦ Linked to ${linked.length === 1 ? linked[0]!.title : linked.length + " cards"}` : "▦ Link to card"}
        </button>
        <span className="spacer" />
        <span className="small faint" title="Your capabilities on this repository">
          {[...caps].map((c) => c.replace("can-", "can ").replace("-", " ")).join(" · ")}
        </span>
      </div>

      <section className="panel pad">
        <ChainPanel pr={prKey} />
      </section>
      <RecentActivity prKey={prKey} />

      <section className="row" style={{ alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <Field label="Author">{pr.author}</Field>
        <Field label="Reviewers" onEdit={caps.has("can-edit-metadata") ? () => setEditing("reviewers") : undefined}>
          {[...pr.reviews.map((x) => `${x.user} (${x.state.toLowerCase().replace("_", " ")})`), ...pr.requestedReviewers.map((x) => `${x} (requested)`), ...pr.requestedTeams.map((x) => `@${x}`)].join(", ") || "—"}
        </Field>
        <Field label="Labels" onEdit={caps.has("can-edit-metadata") ? () => setEditing("labels") : undefined}>
          {pr.labels.length ? pr.labels.map((l) => <span key={l} className="chip" style={{ marginRight: 4 }}>{l}</span>) : "—"}
        </Field>
        <Field label="Assignees">{pr.assignees.join(", ") || "—"}</Field>
        <Field label="Updated">{timeAgo(pr.updatedAt)}</Field>
      </section>

      <section>
        <div className="row">
          <h3 className="h3 grow">Description</h3>
          {caps.has("can-edit-metadata") ? (
            <button className="btn sm" onClick={() => setEditing("body")}>
              Edit
            </button>
          ) : (
            <span className="faint small">Read only</span>
          )}
        </div>
        <div className="md panel pad" dangerouslySetInnerHTML={{ __html: renderMarkdown(pr.body) || "<em>No description</em>" }} />
      </section>

      {editing && (
        <EditModal
          kind={editing}
          prKey={prKey}
          onClose={() => setEditing(null)}
          onSave={async (v) => {
            try {
              const patch = editing === "body" ? { body: v } : editing === "labels" ? { labels: split(v) } : { reviewers: split(v) };
              const res = await updatePRFields(prKey, patch);
              const notice = deferredNotice(res);
              if (notice) toast("warn", notice);
              else toast("success", "Updated on GitHub");
              setEditing(null);
            } catch (e) {
              toast("error", e instanceof WriteBlocked ? e.message : describeError(e));
            }
          }}
        />
      )}
      <PRComments key={prKey} owner={pr.owner} repo={pr.repo} number={pr.number} />
      {linkCard && <LinkCardModal prKey={prKey} onClose={() => setLinkCard(false)} />}
    </div>
  );
}

type DetailComment = RawIssueComment | RawReviewComment;
const commentCache = new Map<string, { time: number; request: Promise<DetailComment[]> }>();

function PRComments({ owner, repo, number }: { owner: string; repo: string; number: number }) {
  const online = useApp((s) => s.online);
  const apiBase = useApp((s) => s.settings_().apiBase);
  const [comments, setComments] = useState<DetailComment[]>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const key = `${apiBase}:${owner}/${repo}#${number}`;
    let cache = commentCache.get(key);
    if (online && (!cache || Date.now() - cache.time > 5 * 60_000)) {
      const request = githubApi().then((api) => Promise.all([
        api.listIssueComments(owner, repo, number),
        api.listReviewComments(owner, repo, number),
      ])).then((items) => items.flat().sort((a, b) => a.created_at.localeCompare(b.created_at)));
      cache = { time: Date.now(), request };
      commentCache.set(key, cache);
      void request.catch(() => { if (commentCache.get(key)?.request === request) commentCache.delete(key); });
    }
    void cache?.request.then((items) => { if (active) { setComments(items); setError(false); } }, () => { if (active) setError(true); });
    return () => { active = false; };
  }, [apiBase, owner, repo, number, online]);
  return <section className="col" aria-label="GitHub comments">
    <h3 className="h3">Comments {comments?.length ? `(${comments.length})` : ""}</h3>
    {comments?.map((comment) => <article className="panel pad" key={comment.html_url}>
      <div className="row small">
        <b>{comment.user?.login ?? "Deleted user"}</b>
        {"path" in comment && <span className="mono ellipsis">{comment.path}{comment.line ? `:${comment.line}` : ""}</span>}
        <a className="faint" href={comment.html_url} target="_blank" rel="noreferrer">{timeAgo(comment.created_at)}</a>
      </div>
      <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(comment.body) }} />
    </article>)}
    {!comments?.length && <div className="faint small">{comments ? "No GitHub comments." : !online ? "Comments are unavailable offline." : error ? "Could not load GitHub comments." : "Loading comments…"}</div>}
  </section>;
}

function split(v: string): string[] {
  return v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

function Field({ label, children, onEdit }: { label: string; children: React.ReactNode; onEdit?: () => void }) {
  return (
    <div style={{ minWidth: 140, maxWidth: 360 }}>
      <h3 className="h3 row" style={{ marginBottom: 2 }}>
        {label}
        {onEdit && (
          <button className="btn ghost sm" onClick={onEdit} aria-label={`Edit ${label}`}>
            ✎
          </button>
        )}
      </h3>
      <div className="small">{children}</div>
    </div>
  );
}

function EditModal({ kind, prKey, onClose, onSave }: { kind: "body" | "labels" | "reviewers"; prKey: string; onClose: () => void; onSave: (v: string) => Promise<void> }) {
  const pr = useApp((s) => s.prs[prKey])!;
  const init = kind === "body" ? pr.body ?? "" : kind === "labels" ? pr.labels.join(", ") : pr.requestedReviewers.join(", ");
  const [v, setV] = useState(init);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={`Edit ${kind} — ${prKey}`}
      onClose={onClose}
      wide={kind === "body"}
      footer={
        <>
          <span className="faint small grow">Writes go through the GitHub API after a fresh permission check; concurrent edits are detected.</span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || v === init}
            onClick={async () => {
              setBusy(true);
              await onSave(v);
              setBusy(false);
            }}
          >
            {busy ? "Saving…" : "Save to GitHub"}
          </button>
        </>
      }
    >
      {kind === "body" ? (
        <textarea aria-label={`Edit ${kind}`} className="input mono" style={{ width: "100%", minHeight: 320 }} value={v} onChange={(e) => setV(e.target.value)} />
      ) : (
        <input aria-label={`Edit ${kind}`} className="input" style={{ width: "100%" }} value={v} onChange={(e) => setV(e.target.value)} placeholder="comma separated" />
      )}
    </Modal>
  );
}

function LinkCardModal({ prKey, onClose }: { prKey: string; onClose: () => void }) {
  const cards = useApp((s) => s.cards);
  const put = useApp((s) => s.put);
  const pr = useApp((s) => s.prs[prKey]);
  const [title, setTitle] = useState(pr?.title ?? "");
  return (
    <Modal title="Link PR to a feature card" onClose={onClose}>
      <div className="col">
        {Object.values(cards).filter((c) => !c.deleted).map((c) => (
          <label key={c.id} className="row">
            <input
              type="checkbox"
              checked={c.prs.includes(prKey)}
              onChange={(e) => put("cards", c.id, { ...c, prs: e.target.checked ? [...c.prs, prKey] : c.prs.filter((p) => p !== prKey), updatedAt: Date.now() })}
            />
            {c.title}
          </label>
        ))}
        <div className="row">
          <input aria-label="New card title" className="input grow" value={title} onChange={(e) => setTitle(e.target.value)} />
          <button
            className="btn"
            onClick={() => {
              const id = newId("card");
              const repo = pr ? `${pr.owner}/${pr.repo}`.toLowerCase() : "";
              const c: FeatureCard = { id, title, description: "", repos: repo ? [repo] : [], releases: [], prs: [prKey], chains: [], links: [], checklist: [], dependsOn: [], notes: "", createdAt: Date.now(), updatedAt: Date.now() };
              put("cards", id, c);
            }}
          >
            + New card
          </button>
        </div>
      </div>
    </Modal>
  );
}

function RecentActivity({ prKey }: { prKey: string }) {
  const events = useApp((s) => s.prEvents[prKey]);
  if (!events?.length) return null;
  return (
    <section className="panel pad small">
      <h3 className="h3">Recent activity (observed by Nonlinear)</h3>
      {events.slice(0, 8).map((e, i) => (
        <div key={i} className="row">
          <span className="faint" style={{ width: 70 }}>{timeAgo(e.at)}</span>
          <span>{e.text}</span>
        </div>
      ))}
    </section>
  );
}
