/**
 * Minimal, bounded GitHub REST client usable from browser, worker, or Node (§8, §9).
 * - Works unauthenticated for public data (60 req/h) or with a user token.
 * - Never requests scopes itself; that is the auth layer's job.
 * - Enforces timeouts and response-size caps; exposes rate-limit state.
 * - Public-only mode rejects private repository metadata/content.
 */
import type { PRSnapshot, CIState, ReviewDecision, Permission } from "../inbox/classify";
import { permissionFrom } from "../inbox/classify";
import { prKey } from "../ids";
import type { CommitNode } from "../graph/commits";

export interface RateLimit {
  limit: number;
  remaining: number;
  resetAt: number;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    public status: number,
    public kind: "auth" | "forbidden" | "not-found" | "rate-limited" | "org-restricted" | "conflict" | "validation" | "network" | "private-blocked" | "other",
    public docs?: string,
  ) {
    super(message);
  }
}

export interface ClientOptions {
  token?: string | null;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  publicOnly?: boolean;
  onRateLimit?: (r: RateLimit) => void;
  /** ETag cache for conditional requests */
  cache?: Map<string, { etag: string; body: unknown }>;
}

export class GitHubClient {
  readonly baseUrl: string;
  rate: RateLimit | null = null;
  private readonly f: typeof fetch;

  constructor(private readonly o: ClientOptions = {}) {
    this.baseUrl = o.baseUrl ?? "https://api.github.com";
    this.f = o.fetch ?? ((...a) => fetch(...a));
  }

  get authenticated(): boolean {
    return !!this.o.token;
  }

  async request<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    if (!path.startsWith("/")) throw new Error("path must be relative");
    const url = this.baseUrl + path;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...extraHeaders,
    };
    if (this.o.token) headers.Authorization = `Bearer ${this.o.token}`;
    const cached = method === "GET" ? this.o.cache?.get(url) : undefined;
    if (cached) headers["If-None-Match"] = cached.etag;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 20_000);
    let res: Response;
    try {
      res = await this.f(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      throw new GitHubError(`Network error: ${(e as Error).message}`, 0, "network");
    } finally {
      clearTimeout(timer);
    }
    const lim = res.headers.get("x-ratelimit-limit");
    if (lim) {
      this.rate = {
        limit: Number(lim),
        remaining: Number(res.headers.get("x-ratelimit-remaining") ?? 0),
        resetAt: Number(res.headers.get("x-ratelimit-reset") ?? 0) * 1000,
      };
      this.o.onRateLimit?.(this.rate);
    }
    if (res.status === 304 && cached) return cached.body as T;
    const text = await res.text();
    if (text.length > (this.o.maxBytes ?? 20 * 1024 * 1024)) throw new GitHubError("Response exceeds size cap", res.status, "other");
    const data = text ? safeJson(text) : null;
    if (!res.ok) throw toError(res.status, data, res.headers);
    const etag = res.headers.get("etag");
    if (etag && method === "GET" && this.o.cache) this.o.cache.set(url, { etag, body: data });
    return data as T;
  }

  /** Text responses (e.g. `.diff`). */
  async requestText(path: string, accept: string): Promise<string> {
    const headers: Record<string, string> = { Accept: accept, "X-GitHub-Api-Version": "2022-11-28" };
    if (this.o.token) headers.Authorization = `Bearer ${this.o.token}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 60_000);
    try {
      const res = await this.f(this.baseUrl + path, { headers, signal: ctl.signal });
      const t = await res.text();
      if (!res.ok) throw toError(res.status, safeJson(t), res.headers);
      if (t.length > (this.o.maxBytes ?? 50 * 1024 * 1024)) throw new GitHubError("Diff exceeds size cap", res.status, "other");
      return t;
    } catch (e) {
      if (e instanceof GitHubError) throw e;
      throw new GitHubError(`Network error: ${(e as Error).message}`, 0, "network");
    } finally {
      clearTimeout(timer);
    }
  }

  async paginate<T>(path: string, maxPages = 10): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.request<T[]>("GET", `${path}${sep}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  private guardPrivate(r: { private?: boolean; full_name?: string }): void {
    if (this.o.publicOnly && r.private) throw new GitHubError(`Public-only mode: ${r.full_name ?? "repository"} is private`, 403, "private-blocked");
  }

  /* ---------------- Users & repos ---------------- */

  viewer(): Promise<{ login: string; id: number; avatar_url: string; name: string | null }> {
    return this.request("GET", "/user");
  }

  async viewerTeams(): Promise<string[]> {
    try {
      const ts = await this.paginate<{ slug: string; organization: { login: string } }>("/user/teams", 3);
      return ts.map((t) => `${t.organization.login}/${t.slug}`);
    } catch {
      return []; // requires read:org; not requested by default
    }
  }

  async repo(owner: string, repo: string): Promise<RepoInfo> {
    const r = await this.request<RawRepo>("GET", `/repos/${enc(owner)}/${enc(repo)}`);
    this.guardPrivate(r);
    return toRepoInfo(r);
  }

  async listRepos(kind: "user" | "org", name: string, maxPages = 5): Promise<RepoInfo[]> {
    const path = kind === "org" ? `/orgs/${enc(name)}/repos?type=public&sort=pushed` : `/users/${enc(name)}/repos?type=owner&sort=pushed`;
    const rs = await this.paginate<RawRepo>(path, maxPages);
    return rs.filter((r) => !(this.o.publicOnly && r.private)).map(toRepoInfo);
  }

  async myRepos(maxPages = 5): Promise<RepoInfo[]> {
    const rs = await this.paginate<RawRepo>("/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed", maxPages);
    return rs.filter((r) => !(this.o.publicOnly && r.private)).map(toRepoInfo);
  }

  async searchRepos(q: string): Promise<RepoInfo[]> {
    const r = await this.request<{ items: RawRepo[] }>("GET", `/search/repositories?q=${encodeURIComponent(q + " is:public")}&per_page=30`);
    return r.items.map(toRepoInfo);
  }

  /* ---------------- PRs ---------------- */

  async listPulls(owner: string, repo: string, state: "open" | "closed" | "all" = "open", maxPages = 3): Promise<RawPull[]> {
    return this.paginate<RawPull>(`/repos/${enc(owner)}/${enc(repo)}/pulls?state=${state}&sort=updated&direction=desc`, maxPages);
  }

  getPull(owner: string, repo: string, n: number): Promise<RawPull> {
    return this.request("GET", `/repos/${enc(owner)}/${enc(repo)}/pulls/${n}`);
  }

  listPullFiles(owner: string, repo: string, n: number): Promise<RawPullFile[]> {
    return this.paginate(`/repos/${enc(owner)}/${enc(repo)}/pulls/${n}/files`, 30);
  }

  listPullCommits(owner: string, repo: string, n: number): Promise<RawCommit[]> {
    return this.paginate(`/repos/${enc(owner)}/${enc(repo)}/pulls/${n}/commits`, 3);
  }

  listReviews(owner: string, repo: string, n: number): Promise<RawReview[]> {
    return this.paginate(`/repos/${enc(owner)}/${enc(repo)}/pulls/${n}/reviews`, 3);
  }

  listReviewComments(owner: string, repo: string, n: number): Promise<RawReviewComment[]> {
    return this.paginate(`/repos/${enc(owner)}/${enc(repo)}/pulls/${n}/comments`, 5);
  }

  listIssueComments(owner: string, repo: string, n: number): Promise<RawIssueComment[]> {
    return this.paginate(`/repos/${enc(owner)}/${enc(repo)}/issues/${n}/comments`, 5);
  }

  pullDiff(owner: string, repo: string, n: number): Promise<string> {
    return this.requestText(`/repos/${enc(owner)}/${enc(repo)}/pulls/${n}`, "application/vnd.github.diff");
  }

  compareDiff(owner: string, repo: string, base: string, head: string): Promise<string> {
    return this.requestText(`/repos/${enc(owner)}/${enc(repo)}/compare/${enc(base)}...${enc(head)}`, "application/vnd.github.diff");
  }

  async ciState(owner: string, repo: string, sha: string): Promise<CIState> {
    try {
      const [st, runs] = await Promise.all([
        this.request<{ state: string; total_count: number }>("GET", `/repos/${enc(owner)}/${enc(repo)}/commits/${enc(sha)}/status`),
        this.request<{ total_count: number; check_runs: { status: string; conclusion: string | null }[] }>("GET", `/repos/${enc(owner)}/${enc(repo)}/commits/${enc(sha)}/check-runs?per_page=100`),
      ]);
      return combineCI(st, runs.check_runs);
    } catch {
      return "unknown";
    }
  }

  /** Writes ---------------------------------------------------------- */

  updatePull(owner: string, repo: string, n: number, patch: { title?: string; body?: string; state?: "open" | "closed"; base?: string }): Promise<RawPull> {
    return this.request("PATCH", `/repos/${enc(owner)}/${enc(repo)}/pulls/${n}`, patch);
  }

  setLabels(owner: string, repo: string, n: number, labels: string[]): Promise<unknown> {
    return this.request("PUT", `/repos/${enc(owner)}/${enc(repo)}/issues/${n}/labels`, { labels });
  }

  setMilestone(owner: string, repo: string, n: number, milestone: number | null): Promise<unknown> {
    return this.request("PATCH", `/repos/${enc(owner)}/${enc(repo)}/issues/${n}`, { milestone });
  }

  requestReviewers(owner: string, repo: string, n: number, reviewers: string[], team_reviewers: string[] = []): Promise<unknown> {
    return this.request("POST", `/repos/${enc(owner)}/${enc(repo)}/pulls/${n}/requested_reviewers`, { reviewers, team_reviewers });
  }

  createIssueComment(owner: string, repo: string, n: number, body: string): Promise<RawIssueComment> {
    return this.request("POST", `/repos/${enc(owner)}/${enc(repo)}/issues/${n}/comments`, { body });
  }

  /** Submit a review with inline comments in one call (GitHub's actual review API). */
  submitReview(
    owner: string,
    repo: string,
    n: number,
    r: { commit_id: string; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body?: string; comments?: { path: string; line: number; side: "LEFT" | "RIGHT"; start_line?: number; start_side?: "LEFT" | "RIGHT"; body: string }[] },
  ): Promise<RawReview> {
    return this.request("POST", `/repos/${enc(owner)}/${enc(repo)}/pulls/${n}/reviews`, r);
  }

  replyToReviewComment(owner: string, repo: string, n: number, commentId: number, body: string): Promise<RawReviewComment> {
    return this.request("POST", `/repos/${enc(owner)}/${enc(repo)}/pulls/${n}/comments/${commentId}/replies`, { body });
  }

  /* ---------------- Git data ---------------- */

  async contents(owner: string, repo: string, path: string, ref: string): Promise<string | null> {
    try {
      const r = await this.request<{ content?: string; encoding?: string; type: string }>("GET", `/repos/${enc(owner)}/${enc(repo)}/contents/${path.split("/").map(enc).join("/")}?ref=${enc(ref)}`);
      if (r.type !== "file" || !r.content) return null;
      return decodeB64(r.content);
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "not-found") return null;
      throw e;
    }
  }

  /** Gitlinks (mode 160000) at a commit via the Git Trees API, without cloning (§9). */
  async gitlinks(owner: string, repo: string, treeish: string): Promise<Map<string, string>> {
    const t = await this.request<{ tree: { path: string; mode: string; type: string; sha: string }[]; truncated: boolean }>(
      "GET",
      `/repos/${enc(owner)}/${enc(repo)}/git/trees/${enc(treeish)}?recursive=1`,
    );
    const m = new Map<string, string>();
    for (const e of t.tree) if (e.mode === "160000" || e.type === "commit") m.set(e.path, e.sha);
    return m;
  }

  async commits(owner: string, repo: string, opts: { sha?: string; since?: string; until?: string; path?: string; pages?: number } = {}): Promise<CommitNode[]> {
    const q = new URLSearchParams();
    if (opts.sha) q.set("sha", opts.sha);
    if (opts.since) q.set("since", opts.since);
    if (opts.until) q.set("until", opts.until);
    if (opts.path) q.set("path", opts.path);
    const raw = await this.paginate<RawCommit>(`/repos/${enc(owner)}/${enc(repo)}/commits?${q}`, opts.pages ?? 2);
    return raw.map(toCommitNode);
  }

  async commit(owner: string, repo: string, sha: string): Promise<CommitNode> {
    return toCommitNode(await this.request<RawCommit>("GET", `/repos/${enc(owner)}/${enc(repo)}/commits/${enc(sha)}`));
  }

  /** ahead/behind relation between two commits */
  async compareStatus(owner: string, repo: string, base: string, head: string): Promise<{ status: "ahead" | "behind" | "identical" | "diverged"; ahead_by: number; behind_by: number; merge_base_sha: string | null }> {
    const r = await this.request<{ status: "ahead" | "behind" | "identical" | "diverged"; ahead_by: number; behind_by: number; merge_base_commit?: { sha: string } }>(
      "GET",
      `/repos/${enc(owner)}/${enc(repo)}/compare/${enc(base)}...${enc(head)}?per_page=1`,
    );
    return { status: r.status, ahead_by: r.ahead_by, behind_by: r.behind_by, merge_base_sha: r.merge_base_commit?.sha ?? null };
  }

  branches(owner: string, repo: string): Promise<{ name: string; commit: { sha: string } }[]> {
    return this.paginate(`/repos/${enc(owner)}/${enc(repo)}/branches`, 3);
  }

  tags(owner: string, repo: string): Promise<{ name: string; commit: { sha: string } }[]> {
    return this.paginate(`/repos/${enc(owner)}/${enc(repo)}/tags`, 3);
  }

  labels(owner: string, repo: string): Promise<{ name: string; color: string }[]> {
    return this.paginate(`/repos/${enc(owner)}/${enc(repo)}/labels`, 3);
  }

  milestones(owner: string, repo: string): Promise<{ number: number; title: string }[]> {
    return this.paginate(`/repos/${enc(owner)}/${enc(repo)}/milestones?state=open`, 2);
  }
}

/* ---------------- helpers & raw types ---------------- */

function enc(s: string): string {
  return encodeURIComponent(s);
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t);
  } catch {
    return { message: t.slice(0, 200) };
  }
}

function decodeB64(s: string): string {
  const bin = atob(s.replace(/\s/g, ""));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(u);
}

function toError(status: number, data: unknown, headers: Headers): GitHubError {
  const msg = (data as { message?: string } | null)?.message ?? `HTTP ${status}`;
  const docs = (data as { documentation_url?: string } | null)?.documentation_url;
  if (status === 401) return new GitHubError("GitHub authentication required or expired", status, "auth", docs);
  if (status === 403 || status === 429) {
    if (headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(msg)) return new GitHubError(`Rate limited: ${msg}`, status, "rate-limited", docs);
    if (/OAuth App access restrictions|organization has enabled/i.test(msg)) return new GitHubError(`Organization restricts this OAuth app: ${msg}`, status, "org-restricted", docs);
    return new GitHubError(msg, status, "forbidden", docs);
  }
  if (status === 404) return new GitHubError(msg, status, "not-found", docs);
  if (status === 409) return new GitHubError(msg, status, "conflict", docs);
  if (status === 422) return new GitHubError(msg, status, "validation", docs);
  return new GitHubError(msg, status, "other", docs);
}

export function combineCI(status: { state: string; total_count: number }, runs: { status: string; conclusion: string | null }[]): CIState {
  const states: CIState[] = [];
  if (status.total_count > 0) states.push(status.state === "success" ? "passing" : status.state === "pending" ? "running" : "failing");
  for (const r of runs) {
    if (r.status !== "completed") states.push("running");
    else if (["success", "neutral", "skipped"].includes(r.conclusion ?? "")) states.push("passing");
    else states.push("failing");
  }
  if (!states.length) return "none";
  if (states.includes("failing")) return "failing";
  if (states.includes("running")) return "running";
  return "passing";
}

export interface RawRepo {
  id: number;
  node_id: string;
  name: string;
  full_name: string;
  owner: { login: string; type: string };
  private: boolean;
  fork: boolean;
  archived: boolean;
  description: string | null;
  default_branch: string;
  pushed_at: string;
  html_url: string;
  permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean };
}

export interface RepoInfo {
  id: number;
  key: string;
  owner: string;
  name: string;
  ownerType: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  description: string | null;
  defaultBranch: string;
  pushedAt: string;
  permission: Permission;
  url: string;
}

export function toRepoInfo(r: RawRepo): RepoInfo {
  return {
    id: r.id,
    key: r.full_name.toLowerCase(),
    owner: r.owner.login,
    name: r.name,
    ownerType: r.owner.type,
    private: r.private,
    fork: r.fork,
    archived: r.archived,
    description: r.description,
    defaultBranch: r.default_branch,
    pushedAt: r.pushed_at,
    permission: r.permissions ? permissionFrom(r.permissions) : "read",
    url: r.html_url,
  };
}

export interface RawPull {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft?: boolean;
  user: { login: string } | null;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string; sha: string; repo: { full_name: string; private: boolean } };
  labels: { name: string; color?: string }[];
  milestone: { title: string; number: number } | null;
  assignees?: { login: string }[];
  requested_reviewers?: { login: string }[];
  requested_teams?: { slug: string }[];
  merged_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  mergeable?: boolean | null;
  mergeable_state?: string;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  comments?: number;
  review_comments?: number;
  merge_commit_sha?: string | null;
}

export interface RawPullFile {
  sha: string | null;
  filename: string;
  previous_filename?: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface RawCommit {
  sha: string;
  parents: { sha: string }[];
  commit: { message: string; author: { name: string; date: string } | null; committer: { name: string; date: string } | null };
  author: { login: string } | null;
}

export interface RawReview {
  id: number;
  user: { login: string } | null;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";
  body: string;
  submitted_at: string | null;
  commit_id: string;
  html_url: string;
}

export interface RawReviewComment {
  id: number;
  in_reply_to_id?: number;
  user: { login: string } | null;
  body: string;
  path: string;
  line: number | null;
  original_line: number | null;
  side: "LEFT" | "RIGHT";
  commit_id: string;
  created_at: string;
  html_url: string;
}

export interface RawIssueComment {
  id: number;
  user: { login: string } | null;
  body: string;
  created_at: string;
  html_url: string;
}

export function toCommitNode(c: RawCommit): CommitNode {
  return {
    sha: c.sha,
    parents: c.parents.map((p) => p.sha),
    committedAt: c.commit.committer?.date ?? c.commit.author?.date ?? new Date(0).toISOString(),
    authoredAt: c.commit.author?.date,
    author: c.author?.login ?? c.commit.author?.name ?? "unknown",
    message: c.commit.message,
  };
}

/** Latest review state per user (ignoring COMMENTED after a decisive review). */
export function latestReviews(reviews: RawReview[]): PRSnapshot["reviews"] {
  const m = new Map<string, RawReview>();
  for (const r of reviews) {
    const u = r.user?.login;
    if (!u) continue;
    const prev = m.get(u);
    if (r.state === "COMMENTED" && prev && prev.state !== "COMMENTED") continue;
    m.set(u, r);
  }
  return [...m.values()].map((r) => ({ user: r.user!.login, state: r.state, submittedAt: r.submitted_at }));
}

export function reviewDecisionFrom(reviews: PRSnapshot["reviews"], requested: number): ReviewDecision {
  if (reviews.some((r) => r.state === "CHANGES_REQUESTED")) return "changes-requested";
  if (reviews.some((r) => r.state === "APPROVED") && requested === 0) return "approved";
  if (requested > 0 || !reviews.length) return "review-required";
  return "none";
}

export function toSnapshot(p: RawPull, extra: { reviews?: RawReview[]; ci?: CIState } = {}): PRSnapshot {
  const [owner, repo] = p.base.repo.full_name.split("/") as [string, string];
  const reviews = latestReviews(extra.reviews ?? []);
  const requested = (p.requested_reviewers?.length ?? 0) + (p.requested_teams?.length ?? 0);
  return {
    key: prKey({ owner, repo, number: p.number }),
    owner,
    repo,
    number: p.number,
    nodeId: p.node_id,
    title: p.title,
    body: p.body,
    author: p.user?.login ?? "ghost",
    state: p.merged_at ? "merged" : p.state,
    draft: !!p.draft,
    headRef: p.head.ref,
    headSha: p.head.sha,
    baseRef: p.base.ref,
    baseSha: p.base.sha,
    headRepo: p.head.repo?.full_name ?? null,
    labels: p.labels.map((l) => l.name),
    milestone: p.milestone?.title ?? null,
    assignees: (p.assignees ?? []).map((a) => a.login),
    requestedReviewers: (p.requested_reviewers ?? []).map((r) => r.login),
    requestedTeams: (p.requested_teams ?? []).map((t) => `${owner}/${t.slug}`),
    reviews,
    reviewDecision: extra.reviews ? reviewDecisionFrom(reviews, requested) : "unknown",
    ci: extra.ci ?? "unknown",
    mergeable: p.mergeable ?? null,
    mergeableState: p.mergeable_state ?? null,
    additions: p.additions ?? 0,
    deletions: p.deletions ?? 0,
    changedFiles: p.changed_files ?? 0,
    commentsCount: (p.comments ?? 0) + (p.review_comments ?? 0),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    mergedAt: p.merged_at,
    closedAt: p.closed_at,
    url: p.html_url,
    fetchedAt: Date.now(),
  };
}
