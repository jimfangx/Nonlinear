/**
 * Computed inbox categories (design §2.1). These are NOT GitHub labels and a
 * PR may appear in several. The policy is user-editable.
 */
import type { PRKey } from "../ids";

export type CIState = "passing" | "failing" | "running" | "none" | "unknown";
export type ReviewDecision = "approved" | "changes-requested" | "review-required" | "none" | "unknown";
export type PRState = "open" | "closed" | "merged";
export type Permission = "none" | "read" | "triage" | "write" | "maintain" | "admin";

export interface PRSnapshot {
  key: PRKey;
  owner: string;
  repo: string;
  number: number;
  nodeId?: string;
  title: string;
  body: string | null;
  author: string;
  state: PRState;
  draft: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  headRepo?: string | null;
  labels: string[];
  milestone: string | null;
  assignees: string[];
  requestedReviewers: string[];
  requestedTeams: string[];
  /** latest review per user */
  reviews: { user: string; state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING"; submittedAt: string | null }[];
  reviewDecision: ReviewDecision;
  ci: CIState;
  mergeable: boolean | null;
  mergeableState: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  commentsCount: number;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  url: string;
  fetchedAt: number;
}

export type Category =
  | "needs-my-review"
  | "my-drafts"
  | "my-open"
  | "awaiting-review"
  | "waiting-for-ci"
  | "ci-failing"
  | "changes-requested"
  | "ready-to-merge"
  | "blocked-by-chain"
  | "all-open";

export const CATEGORY_LABELS: Record<Category, string> = {
  "needs-my-review": "Needs my review",
  "my-drafts": "My drafts",
  "my-open": "My open PRs",
  "awaiting-review": "Awaiting review",
  "waiting-for-ci": "Waiting for CI",
  "ci-failing": "CI failing",
  "changes-requested": "Changes requested",
  "ready-to-merge": "Ready to merge",
  "blocked-by-chain": "Blocked by chain",
  "all-open": "All open",
};

export interface ClassificationPolicy {
  /** count team review requests as "needs my review" */
  includeTeamRequests: boolean;
  /** count a PR as needing my review if I reviewed before but new commits arrived */
  includeStaleReviews: boolean;
  /** approvals required to leave "awaiting review" */
  requiredApprovals: number;
  /** treat "none" CI as passing for ready-to-merge */
  allowNoCI: boolean;
}

export const DEFAULT_POLICY: ClassificationPolicy = {
  includeTeamRequests: true,
  includeStaleReviews: false,
  requiredApprovals: 1,
  allowNoCI: true,
};

export interface ClassifyContext {
  me: string | null;
  myTeams: string[]; // "org/team-slug"
  /** PRs with unmerged prerequisites */
  blockedByChain: Set<PRKey>;
  policy: ClassificationPolicy;
}

export function classify(pr: PRSnapshot, ctx: ClassifyContext): Set<Category> {
  const out = new Set<Category>();
  if (pr.state !== "open") return out;
  out.add("all-open");
  const me = ctx.me?.toLowerCase() ?? null;
  const mine = me !== null && pr.author.toLowerCase() === me;
  const approvals = pr.reviews.filter((r) => r.state === "APPROVED").length;
  const changes = pr.reviewDecision === "changes-requested" || pr.reviews.some((r) => r.state === "CHANGES_REQUESTED");

  if (me && !mine) {
    const direct = pr.requestedReviewers.some((r) => r.toLowerCase() === me);
    const team = ctx.policy.includeTeamRequests && pr.requestedTeams.some((t) => ctx.myTeams.map((x) => x.toLowerCase()).includes(t.toLowerCase()));
    if (direct || team) out.add("needs-my-review");
  }
  if (mine && pr.draft) out.add("my-drafts");
  if (mine && !pr.draft) out.add("my-open");
  if (!pr.draft && !changes && approvals < ctx.policy.requiredApprovals && pr.reviewDecision !== "approved") out.add("awaiting-review");
  if (pr.ci === "running") out.add("waiting-for-ci");
  if (pr.ci === "failing") out.add("ci-failing");
  if (changes) out.add("changes-requested");
  if (ctx.blockedByChain.has(pr.key)) out.add("blocked-by-chain");
  const ciOk = pr.ci === "passing" || (ctx.policy.allowNoCI && pr.ci === "none");
  const approved = pr.reviewDecision === "approved" || (pr.reviewDecision !== "changes-requested" && approvals >= ctx.policy.requiredApprovals);
  if (!pr.draft && approved && ciOk && pr.mergeable !== false && !ctx.blockedByChain.has(pr.key)) out.add("ready-to-merge");
  return out;
}

export interface LocalPRAttrs {
  pinned?: boolean;
  snoozedUntil?: number | null;
  lastViewedAt?: number | null;
  lastViewedUpdatedAt?: string | null;
}

export function isUnread(pr: PRSnapshot, a: LocalPRAttrs | undefined): boolean {
  if (!a?.lastViewedUpdatedAt) return true;
  return pr.updatedAt > a.lastViewedUpdatedAt;
}

export function isSnoozed(a: LocalPRAttrs | undefined, now = Date.now()): boolean {
  return !!a?.snoozedUntil && a.snoozedUntil > now;
}

/** Per-action capability display (§8). */
export type Capability = "read-only" | "can-review" | "can-edit-metadata" | "can-push" | "can-merge";

export function capabilities(perm: Permission, opts: { tokenCanWrite: boolean; publicOnlyBlocked?: boolean }): Set<Capability> {
  const c = new Set<Capability>(["read-only"]);
  if (!opts.tokenCanWrite || opts.publicOnlyBlocked) return c;
  // Any authenticated user with public_repo can review public PRs.
  c.add("can-review");
  if (perm === "triage" || perm === "write" || perm === "maintain" || perm === "admin") c.add("can-edit-metadata");
  if (perm === "write" || perm === "maintain" || perm === "admin") {
    c.add("can-push");
    c.add("can-merge");
  }
  return c;
}

export function permissionFrom(p: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean } | null | undefined): Permission {
  if (!p) return "none";
  if (p.admin) return "admin";
  if (p.maintain) return "maintain";
  if (p.push) return "write";
  if (p.triage) return "triage";
  if (p.pull) return "read";
  return "none";
}

/* ---------------- Recent-event summaries (§2.1) ---------------- */

export interface PREvent {
  at: number;
  kind: "commits" | "review" | "ci" | "state" | "comments" | "labels" | "ready" | "reviewers";
  text: string;
}

/** Derive human-readable events by comparing two snapshots of the same PR. */
export function diffSnapshots(prev: PRSnapshot | undefined, next: PRSnapshot, at = Date.now()): PREvent[] {
  if (!prev) return [];
  const ev: PREvent[] = [];
  if (prev.headSha !== next.headSha) ev.push({ at, kind: "commits", text: `new commits (head ${next.headSha.slice(0, 7)})` });
  if (prev.state !== next.state) ev.push({ at, kind: "state", text: next.state === "merged" ? "merged" : next.state === "closed" ? "closed" : "reopened" });
  if (prev.draft && !next.draft) ev.push({ at, kind: "ready", text: "marked ready for review" });
  if (prev.ci !== next.ci && next.ci !== "unknown" && prev.ci !== "unknown") ev.push({ at, kind: "ci", text: `CI ${next.ci}` });
  const prevRev = new Map(prev.reviews.map((r) => [r.user, r.state]));
  for (const r of next.reviews) {
    if (prevRev.get(r.user) !== r.state && r.state !== "PENDING" && (prev.reviewDecision !== "unknown" || prev.reviews.length)) {
      ev.push({ at, kind: "review", text: `${r.user} ${r.state === "APPROVED" ? "approved" : r.state === "CHANGES_REQUESTED" ? "requested changes" : r.state === "DISMISSED" ? "review dismissed" : "commented"}` });
    }
  }
  if (next.commentsCount > prev.commentsCount) ev.push({ at, kind: "comments", text: `${next.commentsCount - prev.commentsCount} new comment${next.commentsCount - prev.commentsCount > 1 ? "s" : ""}` });
  const addedLabels = next.labels.filter((l) => !prev.labels.includes(l));
  const removedLabels = prev.labels.filter((l) => !next.labels.includes(l));
  if (addedLabels.length || removedLabels.length) ev.push({ at, kind: "labels", text: [...addedLabels.map((l) => `+${l}`), ...removedLabels.map((l) => `−${l}`)].join(" ") });
  const newReq = next.requestedReviewers.filter((r) => !prev.requestedReviewers.includes(r));
  if (newReq.length) ev.push({ at, kind: "reviewers", text: `review requested from ${newReq.join(", ")}` });
  return ev;
}

/** Short one-line summary of events not yet seen. */
export function summarizeEvents(events: PREvent[], since: number | null | undefined): string {
  const fresh = events.filter((e) => !since || e.at > since);
  if (!fresh.length) return "";
  const byKind = new Map<string, PREvent>();
  for (const e of fresh) byKind.set(e.kind, e); // latest per kind
  return [...byKind.values()].map((e) => e.text).join(" · ");
}
