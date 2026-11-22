/**
 * GitHub service: builds a bounded client from the user's chosen auth, mirrors
 * PR snapshots into the local cache, and gates every write behind a fresh
 * permission check (§8) and an online check (offline → pending intention, §9).
 */
import {
  GitHubClient,
  GitHubError,
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
import { useApp } from "./store";

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

export async function githubApi(): Promise<GitHubClient> {
  const s = useApp.getState().settings_();
  const token = s.authMode === "anonymous" ? null : ((await getSecret("github-token")) ?? null);
  if (!client || token !== clientToken || client.baseUrl !== s.apiBase) {
    clientToken = token;
    client = new GitHubClient({
      token,
      baseUrl: s.apiBase || "https://api.github.com",
      publicOnly: s.publicOnly,
      cache: etagCache,
      onRateLimit: (r) => useApp.setState({ rateLimit: r }),
    });
  }
  return client;
}

export function resetClient(): void {
  client = null;
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
        return "This organization restricts third-party OAuth app access. GitHub requires an org owner to approve the app; use the prepared text/patch or open on GitHub instead.";
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
  // Enrich: authenticated → all (bounded concurrency); anonymous → 10 most recent unenriched.
  const needs = snaps.filter((s) => s.reviewDecision === "unknown" || s.ci === "unknown");
  const budget = c.authenticated ? needs : needs.slice(0, 10);
  prog.total += budget.length;
  await pool(budget, 6, async (s) => {
    await enrichPR(s.key).catch((e) => prog.errors.push(`${s.key}: ${describeError(e)}`));
    prog.done++;
    onProgress?.({ ...prog });
  });
  return prog;
}

export async function enrichPR(key: string): Promise<PRSnapshot> {
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

/** Fetch a single PR (e.g. an external dependency not in any view). */
export async function ensurePR(key: string, maxAgeMs = 5 * 60_000): Promise<PRSnapshot | null> {
  const cached = useApp.getState().prs[key];
  if (cached && Date.now() - cached.fetchedAt < maxAgeMs) return cached;
  if (!useApp.getState().online) return cached ?? null;
  try {
    return await enrichPR(key);
  } catch {
    return cached ?? null;
  }
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

export async function guardedWrite<T>(
  prKey: string,
  need: Capability,
  kind: Intention["kind"],
  payload: Record<string, unknown>,
  doWrite: () => Promise<T>,
  fallback?: { text?: string; url?: string },
): Promise<T | { queued: Intention }> {
  const st = useApp.getState();
  const r = parsePRKey(prKey)!;
  const repoKey = `${r.owner}/${r.repo}`.toLowerCase();
  if (!st.online) return { queued: queueIntention(kind, prKey, payload) };
  if (st.settings_().authMode === "anonymous") throw new WriteBlocked("Sign in to write to GitHub. Nonlinear never uses an over-scoped credential silently.", fallback);
  const { caps } = await freshCapabilities(repoKey);
  if (!caps.has(need)) throw new WriteBlocked(`You don't have “${need}” on ${repoKey}.`, fallback);
  try {
    return await doWrite();
  } catch (e) {
    if (e instanceof GitHubError && (e.kind === "org-restricted" || e.kind === "forbidden")) throw new WriteBlocked(describeError(e), fallback);
    if (e instanceof GitHubError && e.kind === "network") return { queued: queueIntention(kind, prKey, payload) };
    throw e;
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
