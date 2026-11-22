/**
 * Canonical identifiers (design §1). Never use a bare PR number or submodule
 * basename as a unique key; always fully qualify as `owner/repo#number`.
 */

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface PRRef extends RepoRef {
  number: number;
}

/** `owner/repo#number`, lower-cased owner/repo (GitHub names are case-insensitive). */
export type PRKey = string;
/** `owner/repo`, lower-cased. */
export type RepoKey = string;

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export function isValidRepoName(s: string): boolean {
  return NAME.test(s) && s !== "." && s !== "..";
}

export function repoKey(r: RepoRef): RepoKey {
  return `${r.owner}/${r.repo}`.toLowerCase();
}

export function prKey(r: PRRef): PRKey {
  return `${repoKey(r)}#${r.number}`;
}

export function parseRepoKey(s: string): RepoRef | null {
  const m = /^([^/\s]+)\/([^/\s#]+)$/.exec(s.trim());
  if (!m || !isValidRepoName(m[1]!) || !isValidRepoName(m[2]!)) return null;
  return { owner: m[1]!, repo: m[2]!.replace(/\.git$/, "") };
}

/**
 * Parse a PR reference in one of:
 *   owner/repo#123
 *   https://github.com/owner/repo/pull/123 (optionally with trailing path/query/fragment)
 *   #123 (only when `context` repo is supplied)
 */
export function parsePRRef(text: string, context?: RepoRef): PRRef | null {
  const t = text.trim().replace(/^<|>$/g, "");
  let m = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#][^\s]*)?$/i.exec(t);
  if (m) return mk(m[1]!, m[2]!, m[3]!);
  m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(t);
  if (m) return mk(m[1]!, m[2]!, m[3]!);
  m = /^#(\d+)$/.exec(t);
  if (m && context) return mk(context.owner, context.repo, m[1]!);
  return null;
}

function mk(owner: string, repo: string, num: string): PRRef | null {
  if (!isValidRepoName(owner) || !isValidRepoName(repo)) return null;
  const n = Number(num);
  if (!Number.isSafeInteger(n) || n <= 0) return null;
  return { owner, repo, number: n };
}

export function parsePRKey(key: PRKey): PRRef | null {
  return parsePRRef(key);
}

export function prUrl(r: PRRef): string {
  return `https://github.com/${r.owner}/${r.repo}/pull/${r.number}`;
}

/**
 * Submodule identity (design §1): paths and URLs may change over time, so the
 * identity includes the parent commit at which it was observed.
 */
export interface SubmoduleIdentity {
  parentRepo: RepoKey;
  parentCommitSha: string;
  path: string;
  childUrl: string;
  childRepo: RepoKey | null;
  gitlinkSha: string;
}

export function submoduleKey(s: SubmoduleIdentity): string {
  return [s.parentRepo, s.parentCommitSha, s.path, s.childRepo ?? s.childUrl, s.gitlinkSha].join("|");
}

/** Short random ID with a prefix, e.g. `chain_01h…`. Not cryptographic. */
export function newId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, "0");
  return `${prefix}_${t}${r}`;
}

export function isSha(s: string): boolean {
  return /^[0-9a-f]{40}$/i.test(s) || /^[0-9a-f]{64}$/i.test(s);
}

export function shortSha(s: string): string {
  return s.slice(0, 8);
}
