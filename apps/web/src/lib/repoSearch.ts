/**
 * GitHub repository lookup for type-aheads when the local cache has no match.
 * - "owner/name" → exact repository lookup, plus a search inside that owner
 * - "owner/"     → that owner's repositories (search)
 * - anything else → repository name search
 * Results are cached per query for 10 minutes (search is rate-limited to 30/min).
 */
import { parseRepoKey } from "@nonlinear/core";
import type { CachedOption } from "../components/CachedEntry";
import { githubApi } from "./github";

const cache = new Map<string, { at: number; results: CachedOption[] }>();
const TTL = 10 * 60_000;

export async function searchGitHubRepos(text: string): Promise<CachedOption[]> {
  const q = text.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\/+$/, (m) => (text.trim().endsWith("/") ? "/" : "")).toLowerCase();
  if (q.length < 2) return [];
  const hit = cache.get(q);
  if (hit && Date.now() - hit.at < TTL) return hit.results;
  const c = await githubApi();
  const out = new Map<string, CachedOption>();
  const add = (key: string, detail: string | null | undefined) => {
    const k = key.toLowerCase();
    if (!out.has(k)) out.set(k, { value: k, detail: detail ? `GitHub · ${detail}` : "GitHub" });
  };
  const [owner, partial] = q.includes("/") ? (q.split("/", 2) as [string, string]) : [null, q];
  const jobs: Promise<void>[] = [];
  const exact = owner && partial ? parseRepoKey(`${owner}/${partial}`) : null;
  if (exact) {
    jobs.push(c.repo(exact.owner, exact.repo).then((r) => add(r.key, r.description)).catch(() => undefined));
  }
  const term = owner ? `${partial ? `${partial} in:name ` : ""}user:${owner}` : `${q} in:name`;
  jobs.push(c.searchRepos(term).then((rs) => rs.slice(0, 10).forEach((r) => add(r.key, r.description))).catch(() => undefined));
  await Promise.all(jobs);
  const results = [...out.values()];
  cache.set(q, { at: Date.now(), results });
  return results;
}
