/**
 * GitHub service: builds a bounded client from the user's chosen auth, mirrors
 * PR snapshots into the local cache, and gates every write behind a fresh
 * permission check (§8) and an online check (offline → pending intention, §9).
 */
import {
  GitHubClient,
  GitHubError,
  type RateLimit,
  capabilities,
  fnv1a,
  newId,
  parsePRKey,
  permissionFrom,
  rebaseManagedUpdate,
  toSnapshot,
  type Capability,
  type ManagedBlockContent,
  type PRSnapshot,
  type RawRepo,
  type RepoInfo,
  type Intention,
  type PREvent,
  diffSnapshots,
} from "@nonlinear/core";
import { getSecret } from "./db";
import { useApp, type StagedWrite } from "./store";
import { safeModeOn, stage, takeRunner, discardStaged } from "./safemode";

let client: GitHubClient | null = null;
let clientToken: string | null | undefined;
const etagCache = new Map<string, { etag: string; body: unknown }>();

/** Store PR snapshots and record derived activity events (§2.1 recent-event summaries). */
export function storeSnapshots(snaps: PRSnapshot[]): void {
  const st = useApp.getState();
  const evs: [string, PREvent[]][] = [];
  for (const s of snaps) {
    const e = diffSnapshots(st.prs[s.key], s);
    if (e.length) evs.push([s.key, [...e, ...(st.prEvents[s.key] ?? [])].slice(0, 20)]);
  }
  st.putMany("prs", snaps.map((s) => [s.key, s]));
  if (evs.length) st.putMany("prEvents", evs);
}

/** Personal access token used only for organizations that block the OAuth app (secret name). */
export const FALLBACK_TOKEN_SECRET = "github-pat-fallback";
const DIRECT_API = "https://api.github.com";
/** Organizations (lower-case) that refused the OAuth app this session; their calls go straight to the fallback token. */
export const oauthRestrictedOrgs = new Set<string>();
let clientFallback: string | null | undefined;

/** Repository owner a REST path refers to, if any. */
function ownerOfPath(path: string): string | null {
  const m = /^\/(?:repos|orgs)\/([^/?#]+)/.exec(path);
  return m ? decodeURIComponent(m[1]!).toLowerCase() : null;
}

/**
 * Route calls for organizations that refuse the OAuth app ("org-restricted") to a
 * second client (personal access token). The first refusal per organization is
 * retried and remembered; later calls for it go straight to the fallback.
 */
export function withOrgFallback(primary: GitHubClient, direct: GitHubClient, restricted: Set<string>, onRestricted: (owner: string) => void): GitHubClient {
  const viaPrimary = primary.request.bind(primary);
  const textViaPrimary = primary.requestText.bind(primary);
  const retry = async <T,>(path: string, first: () => Promise<T>, second: () => Promise<T>): Promise<T> => {
    const owner = ownerOfPath(path);
    if (owner && restricted.has(owner)) return second();
    try {
      return await first();
    } catch (e) {
      if (!(e instanceof GitHubError) || e.kind !== "org-restricted") throw e;
      if (owner && !restricted.has(owner)) {
        restricted.add(owner);
        onRestricted(owner);
      }
      return second();
    }
  };
  primary.request = <T,>(method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    retry<T>(path, () => viaPrimary<T>(method, path, body, headers), () => direct.request<T>(method, path, body, headers));
  primary.requestText = (path: string, accept: string) =>
    retry(path, () => textViaPrimary(path, accept), () => direct.requestText(path, accept));
  return primary;
}

export async function githubApi(): Promise<GitHubClient> {
  const s = useApp.getState().settings_();
  const token = s.authMode === "anonymous" ? null : ((await getSecret("github-token")) ?? null);
  // Signed in through a sync server (OAuth): an optional personal access token covers organizations that block the OAuth app.
  const viaOAuth = s.authMode === "oauth";
  const fallback = viaOAuth ? ((await getSecret(FALLBACK_TOKEN_SECRET)) ?? null) : null;
  const base = s.apiBase.trim().replace(/\/+$/, "") || DIRECT_API;
  if (!client || token !== clientToken || fallback !== clientFallback || client.baseUrl !== base) {
    clientToken = token;
    clientFallback = fallback;
    const onRateLimit = (r: RateLimit) => useApp.setState({ rateLimit: r });
    const primary = new GitHubClient({ token, baseUrl: base, publicOnly: s.publicOnly, cache: etagCache, onRateLimit });
    if (fallback) {
      // Same conditional-request cache: entries are keyed by full URL, so proxy and direct responses never mix.
      const direct = new GitHubClient({ token: fallback, baseUrl: DIRECT_API, publicOnly: s.publicOnly, cache: etagCache, onRateLimit });
      withOrgFallback(primary, direct, oauthRestrictedOrgs, (owner) =>
        useApp.getState().toast("info", `${owner} blocks the OAuth app, so Nonlinear is using your personal access token for ${owner}.`));
    }
    client = primary;
  }
  return client;
}

export function githubAvatarUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && url.hostname.endsWith(".githubusercontent.com")) return url.href;
  } catch { /* Use the account icon for invalid image URLs. */ }
  return null;
}

const avatarRequests = new Map<string, Promise<void>>();

export function refreshGitHubAvatar(): Promise<void> | undefined {
  const app = useApp.getState();
  const { me, apiBase, authMode, githubAvatar } = app.settings_();
  if (!app.online || !me || authMode === "anonymous") return;
  if (githubAvatar?.login === me && githubAvatar.apiBase === apiBase && Date.now() - githubAvatar.checkedAt < 86_400_000) return;
  const key = JSON.stringify([me, apiBase, authMode]);
  let pending = avatarRequests.get(key);
  if (!pending) {
    pending = (async () => {
      const api = await githubApi();
      if (!api.authenticated) return;
      const profile = await api.viewer();
      const state = useApp.getState();
      const current = state.settings_();
      if (current.me !== me || current.apiBase !== apiBase || current.authMode !== authMode || profile.login.toLowerCase() !== me.toLowerCase()) return;
      state.setSettings({ githubAvatar: { login: me, apiBase, url: githubAvatarUrl(profile.avatar_url), checkedAt: Date.now() } });
    })().catch(() => undefined).finally(() => avatarRequests.delete(key));
    avatarRequests.set(key, pending);
  }
  return pending;
}

export function resetClient(): void {
  client = null;
  retryMissingAfter.clear();
}

/** Simple concurrency limiter so a big view doesn't burst the API. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<(R | Error)[]> {
  const out: (R | Error)[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        try {
          out[k] = await fn(items[k]!);
        } catch (e) {
          out[k] = e as Error;
        }
      }
    }),
  );
  return out;
}

export function describeError(e: unknown): string {
  if (e instanceof GitHubError) {
    switch (e.kind) {
      case "org-restricted":
        return useApp.getState().settings_().authMode === "oauth"
          ? "This organization blocks the OAuth app. Ask an org owner to approve it, or add a fallback personal access token in Settings → GitHub access."
          : "This organization restricts third-party OAuth app access. GitHub requires an org owner to approve the app; use the prepared text/patch or open on GitHub instead.";
      case "rate-limited":
        return "GitHub rate limit reached. Sign in or add a token to raise the limit; cached data remains available.";
      case "auth":
        return "GitHub authentication required or expired. Reconnect in Settings.";
      case "private-blocked":
        return e.message;
      case "network":
        return "Network unavailable. Showing cached data.";
      default:
        return e.message;
    }
  }
  return (e as Error)?.message ?? String(e);
}

/* ------------------------------------------------------------------ */
/* Repositories                                                        */
/* ------------------------------------------------------------------ */

export async function fetchRepo(key: string): Promise<RepoInfo> {
  const [owner, name] = key.split("/") as [string, string];
  const info = await (await githubApi()).repo(owner, name);
  useApp.getState().put("repos", info.key, info);
  return info;
}

/** Fresh permission check immediately before a write (§8). */
export async function freshCapabilities(repoKey: string): Promise<{ caps: Set<Capability>; info: RepoInfo }> {
  const [owner, name] = repoKey.split("/") as [string, string];
  const c = await githubApi();
  const raw = await c.request<RawRepo>("GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  const s = useApp.getState().settings_();
  const perm = permissionFrom(raw.permissions);
  const info: RepoInfo = { ...(useApp.getState().repos[repoKey] ?? ({} as RepoInfo)), key: repoKey, permission: perm, private: raw.private } as RepoInfo;
  useApp.getState().patch("repos", repoKey, { permission: perm });
  const caps = capabilities(perm, { tokenCanWrite: s.tokenCanWrite && s.authMode !== "anonymous", publicOnlyBlocked: s.publicOnly && raw.private });
  return { caps, info };
}

export function cachedCapabilities(repoKey: string): Set<Capability> {
  const st = useApp.getState();
  const s = st.settings_();
  const r = st.repos[repoKey];
  return capabilities(r?.permission ?? "read", { tokenCanWrite: s.tokenCanWrite && s.authMode !== "anonymous", publicOnlyBlocked: s.publicOnly && !!r?.private });
}

/* ------------------------------------------------------------------ */
/* PR mirror                                                           */
/* ------------------------------------------------------------------ */

export interface RefreshProgress {
  done: number;
  total: number;
  errors: string[];
}

/** Refresh open PRs for repos. Enrichment (reviews+CI) is bounded when unauthenticated. */
export async function refreshRepos(repos: string[], onProgress?: (p: RefreshProgress) => void, state: "open" | "all" = "open"): Promise<RefreshProgress> {
  const c = await githubApi();
  const st = useApp.getState();
  const prog: RefreshProgress = { done: 0, total: repos.length, errors: [] };
  const lists = await pool(repos, 4, async (rk) => {
    const [owner, name] = rk.split("/") as [string, string];
    if (!st.repos[rk]) await fetchRepo(rk).catch(() => undefined);
    const pulls = await c.listPulls(owner, name, state, c.authenticated ? 3 : 1);
    prog.done++;
    onProgress?.({ ...prog });
    return pulls;
  });
  const pulls = lists.flatMap((l, i) => {
    if (l instanceof Error) {
      prog.errors.push(`${repos[i]}: ${describeError(l)}`);
      return [];
    }
    return l;
  });
  // Preserve previously-enriched fields if PR unchanged.
  const prev = useApp.getState().prs;
  const snaps = pulls.map((p) => {
    const s = toSnapshot(p);
    const old = prev[s.key];
    if (old && old.headSha === s.headSha && old.updatedAt === s.updatedAt) return { ...s, reviews: old.reviews, reviewDecision: old.reviewDecision, ci: old.ci, mergeable: old.mergeable, mergeableState: old.mergeableState, additions: old.additions, deletions: old.deletions, changedFiles: old.changedFiles };
    return s;
  });
  storeSnapshots(snaps);
  // Enrich the most recently updated PRs within a fixed request budget.
  const needs = snaps.filter((s) => s.reviewDecision === "unknown" || s.ci === "unknown");
  const remaining = useApp.getState().rateLimit?.remaining;
  const limit = Math.min(c.authenticated ? 25 : 10, remaining === undefined ? Infinity : Math.max(0, Math.floor((remaining - 8) / 5)));
  const budget = needs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  prog.total += budget.length;
  await pool(budget, 6, async (s) => {
    await enrichPR(s.key).catch((e) => prog.errors.push(`${s.key}: ${describeError(e)}`));
    prog.done++;
    onProgress?.({ ...prog });
  });
  return prog;
}

const enrichments = new Map<string, Promise<PRSnapshot>>();

export function enrichPR(key: string): Promise<PRSnapshot> {
  let request = enrichments.get(key);
  if (!request) {
    request = loadEnrichedPR(key).finally(() => enrichments.delete(key));
    enrichments.set(key, request);
  }
  return request;
}

async function loadEnrichedPR(key: string): Promise<PRSnapshot> {
  const r = parsePRKey(key);
  if (!r) throw new Error(`bad PR key ${key}`);
  const c = await githubApi();
  const [pull, reviews] = await Promise.all([c.getPull(r.owner, r.repo, r.number), c.listReviews(r.owner, r.repo, r.number)]);
  if (pull.base.repo.private && useApp.getState().settings_().publicOnly) throw new GitHubError("Public-only mode: private repository", 403, "private-blocked");
  const ci = await c.ciState(r.owner, r.repo, pull.head.sha);
  const snap = toSnapshot(pull, { reviews, ci });
  storeSnapshots([snap]);
  return snap;
}

const missingPRs = new Map<string, Promise<PRSnapshot | null>>();
const retryMissingAfter = new Map<string, number>();

/** Load an uncached PR's metadata for the Inbox or a chain in one request. */
export function ensurePR(key: string): Promise<PRSnapshot | null> {
  const { prs, online } = useApp.getState();
  if (prs[key] || !online || Date.now() < (retryMissingAfter.get(key) ?? 0)) {
    return Promise.resolve(prs[key] ?? null);
  }
  let request = missingPRs.get(key);
  if (!request) {
    request = (async () => {
      const r = parsePRKey(key);
      if (!r) return null;
      const pull = await (await githubApi()).getPull(r.owner, r.repo, r.number);
      if (pull.base.repo.private && useApp.getState().settings_().publicOnly) return null;
      const existing = useApp.getState().prs[key];
      if (existing) return existing;
      const snap = toSnapshot(pull);
      storeSnapshots([snap]);
      return snap;
    })().catch(() => {
      retryMissingAfter.set(key, Date.now() + 60_000);
      return null;
    }).finally(() => missingPRs.delete(key));
    missingPRs.set(key, request);
  }
  return request;
}

/* ------------------------------------------------------------------ */
/* Writes: online + fresh permission; else pending intention           */
/* ------------------------------------------------------------------ */

export class WriteBlocked extends Error {
  constructor(
    message: string,
    public fallback?: { text?: string; url?: string },
  ) {
    super(message);
  }
}

function queueIntention(kind: Intention["kind"], prKey: string, payload: Record<string, unknown>): Intention {
  const snap = useApp.getState().prs[prKey];
  const i: Intention = {
    id: newId("int"),
    kind,
    prKey,
    observedHeadSha: snap?.headSha ?? null,
    observedBodyHash: snap?.body != null ? fnv1a(snap.body) : null,
    payload,
    createdAt: Date.now(),
    status: "queued",
  };
  useApp.getState().put("intentions", i.id, i);
  return i;
}

export type Deferred = { queued: Intention } | { staged: StagedWrite };

/** If a write was deferred (offline queue or safe mode), a message for the user; else null. */
export function deferredNotice(res: unknown, what = "Change"): string | null {
  if (!res || typeof res !== "object") return null;
  if ("staged" in res) return `Safe mode: ${what.toLowerCase()} staged. You'll review it before anything is sent to GitHub.`;
  if ("queued" in res) return `Offline: ${what.toLowerCase()} queued. You'll confirm it before it is sent.`;
  return null;
}

/** Online + signed-in + fresh permission check, then perform the write. */
async function checkedWrite<T>(repoKey: string, need: Capability, doWrite: () => Promise<T>, fallback?: { text?: string; url?: string }): Promise<T> {
  const st = useApp.getState();
  if (st.settings_().authMode === "anonymous") throw new WriteBlocked("Sign in to write to GitHub. Nonlinear never uses an over-scoped credential silently.", fallback);
  const { caps } = await freshCapabilities(repoKey);
  if (!caps.has(need)) throw new WriteBlocked(`You don't have “${need}” on ${repoKey}.`, fallback);
  try {
    return await doWrite();
  } catch (e) {
    if (e instanceof GitHubError && (e.kind === "org-restricted" || e.kind === "forbidden")) throw new WriteBlocked(describeError(e), fallback);
    throw e;
  }
}

export async function guardedWrite<T>(
  prKey: string,
  need: Capability,
  kind: Intention["kind"],
  payload: Record<string, unknown>,
  doWrite: () => Promise<T>,
  fallback?: { text?: string; url?: string },
): Promise<T | Deferred> {
  const st = useApp.getState();
  const r = parsePRKey(prKey)!;
  const repoKey = `${r.owner}/${r.repo}`.toLowerCase();
  if (safeModeOn()) return { staged: stage({ kind, prKey, repoKey, need, payload, run: doWrite }) };
  if (!st.online) return { queued: queueIntention(kind, prKey, payload) };
  try {
    return await checkedWrite(repoKey, need, doWrite, fallback);
  } catch (e) {
    if (e instanceof GitHubError && e.kind === "network") return { queued: queueIntention(kind, prKey, payload) };
    throw e;
  }
}

/** Repository-level write (no PR), e.g. a release branch + draft PR. Staged in safe mode. */
export async function guardedRepoWrite<T>(repoKey: string, need: Capability, kind: Intention["kind"], payload: Record<string, unknown>, doWrite: () => Promise<T>): Promise<T | { staged: StagedWrite }> {
  if (safeModeOn()) return { staged: stage({ kind, prKey: null, repoKey, need, payload, run: doWrite }) };
  return checkedWrite(repoKey, need, doWrite);
}

/** Send one change that safe mode staged. Permissions are re-checked now. */
export async function sendStaged(item: StagedWrite): Promise<void> {
  if (!useApp.getState().online) throw new Error("You're offline. Reconnect to send staged changes.");
  const run = takeRunner(item.id) ?? replayFromPayload(item);
  const result = await checkedWrite(item.repoKey, item.need, run);
  if (result && typeof result === "object" && "kind" in result && (result as { kind: string }).kind === "conflict") {
    throw new Error((result as { reason?: string }).reason ?? "The PR changed on GitHub; re-apply the change.");
  }
  discardStaged(item.id);
  if (item.prKey) void enrichPR(item.prKey).catch(() => undefined);
}

function replayFromPayload(item: StagedWrite): () => Promise<unknown> {
  const p = item.payload as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = item.prKey ? parsePRKey(item.prKey) : null;
  return async () => {
    const c = await githubApi();
    if (!r) throw new Error("This change can't be replayed after a reload. Discard it and redo the action.");
    switch (item.kind) {
      case "comment": return c.createIssueComment(r.owner, r.repo, r.number, p.body);
      case "review": return c.submitReview(r.owner, r.repo, r.number, p.request);
      case "lgtm": return c.submitReview(r.owner, r.repo, r.number, { commit_id: p.commit_id, event: "APPROVE", body: p.body || "LGTM" });
      case "review-start": return c.requestReviewers(r.owner, r.repo, r.number, [p.login]);
      case "chain-block": {
        const current = await c.getPull(r.owner, r.repo, r.number);
        const outcome = rebaseManagedUpdate(p.baseBody, current.body ?? "", p.content);
        if (outcome.kind === "conflict") return outcome;
        return c.updatePull(r.owner, r.repo, r.number, { body: outcome.body });
      }
      case "update-body": case "labels": case "milestone": case "reviewers": {
        if (p.body !== undefined || p.title !== undefined) await c.updatePull(r.owner, r.repo, r.number, { title: p.title, body: p.body });
        if (p.labels) await c.setLabels(r.owner, r.repo, r.number, p.labels);
        if (p.milestone !== undefined) await c.setMilestone(r.owner, r.repo, r.number, p.milestone);
        if (p.reviewers?.length) await c.requestReviewers(r.owner, r.repo, r.number, p.reviewers);
        return;
      }
      default: throw new Error("This change can't be replayed after a reload. Discard it and redo the action.");
    }
  };
}

/** Approve on GitHub with an "LGTM" review. */
export function submitLGTM(pr: PRSnapshot, body = "LGTM") {
  const r = parsePRKey(pr.key)!;
  const payload = { commit_id: pr.headSha, body };
  return guardedWrite(pr.key, "can-review", "lgtm", payload, async () => (await githubApi()).submitReview(r.owner, r.repo, r.number, { commit_id: pr.headSha, event: "APPROVE", body }));
}

/**
 * Make "I've started reviewing" visible on GitHub by requesting a review from
 * yourself (GitHub then shows "Awaiting review from @you"). GitHub's pending
 * reviews are only visible to their author, so this is the only public signal
 * the API offers. Sent at most once per PR; never for your own PRs.
 */
export async function signalReviewStart(pr: PRSnapshot, opts: { force?: boolean } = {}): Promise<void> {
  const st = useApp.getState();
  const s = st.settings_();
  if ((!s.signalReviewStart && !opts.force) || !s.me || st.reviewSignals[pr.key] || pr.state !== "open") return;
  if (pr.author.toLowerCase() === s.me.toLowerCase()) return;
  const me = s.me.toLowerCase();
  if (pr.reviews?.some((rv) => rv.user.toLowerCase() === me) || pr.requestedReviewers?.some((u) => u.toLowerCase() === me)) { st.put("reviewSignals", pr.key, { at: Date.now() }); return; }
  st.put("reviewSignals", pr.key, { at: Date.now() });
  const r = parsePRKey(pr.key)!;
  try {
    const res = await guardedWrite(pr.key, "can-review", "review-start", { login: s.me }, async () => (await githubApi()).requestReviewers(r.owner, r.repo, r.number, [s.me!]));
    if (res && typeof res === "object" && "staged" in res) st.toast("info", "Safe mode: “started reviewing” signal staged for GitHub.");
    else if (!(res && typeof res === "object" && "queued" in res)) st.toast("info", `Marked on GitHub that @${s.me} is reviewing ${pr.key}.`);
  } catch (e) {
    st.remove("reviewSignals", pr.key);
    st.toast("warn", `Couldn't mark the review start on GitHub: ${describeError(e)}`);
  }
}

/**
 * Write a managed chain block to a PR body with optimistic concurrency (§2.3):
 * fetch the current body, compare to the base we showed the user, rebase only
 * our block, or report a conflict.
 */
export async function writeChainBlock(prKey: string, baseBody: string, content: ManagedBlockContent) {
  const r = parsePRKey(prKey)!;
  return guardedWrite(
    prKey,
    "can-edit-metadata",
    "chain-block",
    { content, baseBody },
    async () => {
      const c = await githubApi();
      const current = await c.getPull(r.owner, r.repo, r.number);
      const outcome = rebaseManagedUpdate(baseBody, current.body ?? "", content);
      if (outcome.kind === "conflict") return outcome;
      const updated = await c.updatePull(r.owner, r.repo, r.number, { body: outcome.body });
      useApp.getState().put("prs", prKey, { ...toSnapshot(updated), ...pickEnriched(useApp.getState().prs[prKey]) });
      return outcome;
    },
    { url: `https://github.com/${r.owner}/${r.repo}/pull/${r.number}` },
  );
}

function pickEnriched(s: PRSnapshot | undefined): Partial<PRSnapshot> {
  if (!s) return {};
  return { reviews: s.reviews, reviewDecision: s.reviewDecision, ci: s.ci };
}

export async function updatePRFields(prKey: string, patch: { title?: string; body?: string; labels?: string[]; milestone?: number | null; reviewers?: string[] }) {
  const r = parsePRKey(prKey)!;
  return guardedWrite(prKey, "can-edit-metadata", "update-body", patch, async () => {
    const c = await githubApi();
    if (patch.body !== undefined || patch.title !== undefined) {
      // optimistic concurrency on body
      const cur = await c.getPull(r.owner, r.repo, r.number);
      const known = useApp.getState().prs[prKey];
      if (patch.body !== undefined && known && (cur.body ?? "") !== (known.body ?? "")) {
        throw new Error("The description changed on GitHub since you opened it. Refresh and re-apply your edit.");
      }
      await c.updatePull(r.owner, r.repo, r.number, { title: patch.title, body: patch.body });
    }
    if (patch.labels) await c.setLabels(r.owner, r.repo, r.number, patch.labels);
    if (patch.milestone !== undefined) await c.setMilestone(r.owner, r.repo, r.number, patch.milestone);
    if (patch.reviewers?.length) await c.requestReviewers(r.owner, r.repo, r.number, patch.reviewers);
    return enrichPR(prKey);
  });
}
