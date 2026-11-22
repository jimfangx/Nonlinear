/**
 * Private, revision-aware review progress (design §5.3).
 *
 * Coordinates are 0-based *row indices* into the file's rendered diff (the
 * concatenation of all hunk lines in order). A file is complete only when the
 * contiguous frontier reaches the end AND no flagged ("needs revisit") or
 * stale intervals remain.
 */
import type { Hunk } from "../diff/unified";
import { fnv1a } from "../diff/unified";

export type Interval = [start: number, end: number]; // half-open

export function normalize(xs: Interval[]): Interval[] {
  const s = xs.filter(([a, b]) => b > a).map(([a, b]) => [a, b] as Interval).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const iv of s) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

export function union(a: Interval[], b: Interval[]): Interval[] {
  return normalize([...a, ...b]);
}

export function subtract(a: Interval[], b: Interval[]): Interval[] {
  let cur = normalize(a);
  for (const [bs, be] of normalize(b)) {
    const next: Interval[] = [];
    for (const [s, e] of cur) {
      if (be <= s || bs >= e) next.push([s, e]);
      else {
        if (bs > s) next.push([s, bs]);
        if (be < e) next.push([be, e]);
      }
    }
    cur = next;
  }
  return cur;
}

export function covered(xs: Interval[]): number {
  return normalize(xs).reduce((n, [a, b]) => n + (b - a), 0);
}

export function contains(xs: Interval[], i: number): boolean {
  return xs.some(([a, b]) => i >= a && i < b);
}

export type FileReviewStatus = "not-started" | "incomplete" | "complete" | "postponed" | "needs-rereview";

export interface FileReviewState {
  path: string;
  /** git blob id of the new side (or content hash) at the reviewed revision */
  blobId: string | null;
  totalRows: number;
  /** Contiguous reviewed prefix [0, frontier) */
  frontier: number;
  /** Additional reviewed ranges beyond the frontier (e.g. hunk marked reviewed via `r`). */
  reviewed: Interval[];
  /** "Needs revisit" holes; remain visible even if inside the frontier. */
  flagged: Interval[];
  /** Ranges that changed in a newer revision and must be re-reviewed. */
  stale: Interval[];
  postponed: boolean;
  /** "Come back later" free-form */
  incompleteNote?: string;
  updatedAt: number;
}

export function emptyFileState(path: string, totalRows: number, blobId: string | null = null): FileReviewState {
  return { path, blobId, totalRows, frontier: 0, reviewed: [], flagged: [], stale: [], postponed: false, updatedAt: Date.now() };
}

export function reviewedSet(s: FileReviewState): Interval[] {
  return subtract(union([[0, s.frontier]], s.reviewed), union(s.flagged, s.stale));
}

export function fileStatus(s: FileReviewState): FileReviewStatus {
  if (s.postponed) return "postponed";
  if (s.stale.length) return "needs-rereview";
  if (s.totalRows === 0) return s.frontier > 0 || s.reviewed.length ? "complete" : "not-started";
  const done = covered(reviewedSet(s));
  if (done === 0 && !s.flagged.length) return "not-started";
  if (done >= s.totalRows && !s.flagged.length) return "complete";
  return "incomplete";
}

export function progress(s: FileReviewState): number {
  return s.totalRows === 0 ? (fileStatus(s) === "complete" ? 1 : 0) : covered(reviewedSet(s)) / s.totalRows;
}

export function setFrontier(s: FileReviewState, row: number): FileReviewState {
  const frontier = Math.max(0, Math.min(s.totalRows, Math.round(row)));
  // Moving the frontier past stale rows re-reviews them; flagged holes remain.
  const stale = subtract(s.stale, [[0, frontier]]);
  // Absorb reviewed ranges adjacent to the frontier to keep it contiguous.
  const reviewed = frontier < s.frontier ? subtract(s.reviewed, [[frontier, s.frontier]]) : s.reviewed;
  let f = frontier;
  for (const [a, b] of normalize(reviewed)) if (a <= f && b > f) f = b;
  return { ...s, frontier: f, reviewed, stale, updatedAt: Date.now() };
}

export function markReviewed(s: FileReviewState, iv: Interval): FileReviewState {
  return setFrontier({ ...s, reviewed: union(s.reviewed, [iv]), stale: subtract(s.stale, [iv]), flagged: subtract(s.flagged, [iv]) }, s.frontier);
}

export function flagRange(s: FileReviewState, iv: Interval): FileReviewState {
  return { ...s, flagged: union(s.flagged, [iv]), updatedAt: Date.now() };
}

export function unflagRange(s: FileReviewState, iv: Interval): FileReviewState {
  return { ...s, flagged: subtract(s.flagged, [iv]), updatedAt: Date.now() };
}

export function markAllReviewed(s: FileReviewState): FileReviewState {
  return { ...s, frontier: Math.max(1, s.totalRows), reviewed: [], flagged: [], stale: [], postponed: false, updatedAt: Date.now() };
}

export function resetFile(s: FileReviewState): FileReviewState {
  return { ...s, frontier: 0, reviewed: [], flagged: [], stale: [], updatedAt: Date.now() };
}

/* ------------------------------------------------------------------ */
/* Revision-aware remapping (§5.3)                                     */
/* ------------------------------------------------------------------ */

/** Row signature used to match content between revisions. */
export interface RowSig {
  /** hash of (kind + text) — position-independent */
  content: string;
  /** hash of the enclosing hunk's +/- lines */
  hunk: string;
  /** index of the enclosing hunk in its file */
  hunkIndex: number;
}

export function rowSignatures(hunks: Hunk[]): RowSig[] {
  const out: RowSig[] = [];
  hunks.forEach((h, hi) => {
    for (const l of h.lines) out.push({ content: fnv1a(`${l.kind}\u0000${l.text}`), hunk: h.hash, hunkIndex: hi });
  });
  return out;
}

export interface RemapResult {
  state: FileReviewState;
  preservedRows: number;
  staleRows: number;
  /** true when the whole file is byte-identical (same blob) */
  identical: boolean;
}

interface HunkSpan {
  hash: string;
  range: Interval;
}

function hunkSpans(sigs: RowSig[]): HunkSpan[] {
  const out: HunkSpan[] = [];
  sigs.forEach((s, i) => {
    const last = out[out.length - 1];
    if (last && sigs[i - 1]?.hunkIndex === s.hunkIndex) last.range[1] = i + 1;
    else out.push({ hash: s.hunk, range: [i, i + 1] });
  });
  return out;
}

/**
 * Carry review progress to a new revision.
 *  - Same blob id ⇒ preserve everything.
 *  - Otherwise: a reviewed row is preserved only if it belongs to a hunk whose
 *    content hash is unchanged AND that hunk content appears exactly once in
 *    both revisions (unambiguous). Rows in changed/ambiguous hunks become stale
 *    if any progress existed; never auto-reviewed. Same line number ≠ same code.
 */
export function remapFileState(prev: FileReviewState, prevSigs: RowSig[], nextSigs: RowSig[], nextBlobId: string | null): RemapResult {
  // Same blob id is only trusted when row content also matches (abbreviated ids can collide).
  const sameContent = prevSigs.length === nextSigs.length && prevSigs.every((s, i) => s.content === nextSigs[i]!.content);
  if (prev.blobId && nextBlobId && prev.blobId === nextBlobId && sameContent) {
    return { state: { ...prev, updatedAt: Date.now() }, preservedRows: covered(reviewedSet(prev)), staleRows: 0, identical: true };
  }
  const prevSpans = hunkSpans(prevSigs);
  const nextSpans = hunkSpans(nextSigs);
  const count = (spans: HunkSpan[]) => {
    const m = new Map<string, number>();
    for (const s of spans) m.set(s.hash, (m.get(s.hash) ?? 0) + 1);
    return m;
  };
  const prevCount = count(prevSpans);
  const nextCount = count(nextSpans);
  const prevByHash = new Map(prevSpans.map((s) => [s.hash, s.range]));

  const prevReviewed = reviewedSet(prev);
  const hadProgress = covered(prevReviewed) > 0 || prev.flagged.length > 0;
  const reviewed: Interval[] = [];
  const flagged: Interval[] = [];
  const stale: Interval[] = [];
  let preserved = 0;

  for (const { hash, range: [ns, ne] } of nextSpans) {
    const pr = prevByHash.get(hash);
    const unambiguous = prevCount.get(hash) === 1 && nextCount.get(hash) === 1;
    if (pr && unambiguous && ne - ns === pr[1] - pr[0]) {
      for (let k = 0; k < ne - ns; k++) {
        if (contains(prevReviewed, pr[0] + k)) {
          reviewed.push([ns + k, ns + k + 1]);
          preserved++;
        }
        if (contains(prev.flagged, pr[0] + k)) flagged.push([ns + k, ns + k + 1]);
      }
    } else if (hadProgress) {
      stale.push([ns, ne]);
    }
  }

  const rev = normalize(reviewed);
  const frontier = rev[0] && rev[0][0] === 0 ? rev[0][1] : 0;
  const state: FileReviewState = {
    ...prev,
    blobId: nextBlobId,
    totalRows: nextSigs.length,
    frontier,
    reviewed: rev,
    flagged: normalize(flagged),
    stale: normalize(stale),
    updatedAt: Date.now(),
  };
  return { state, preservedRows: preserved, staleRows: covered(state.stale), identical: false };
}

/* ------------------------------------------------------------------ */
/* Notes with content anchors (§5.3)                                   */
/* ------------------------------------------------------------------ */

export interface NoteAnchor {
  path: string;
  /** row range at creation */
  rows: Interval;
  /** content of anchored rows and 2 lines of context either side */
  anchorText: string[];
  before: string[];
  after: string[];
}

export interface PrivateNote {
  id: string;
  prKey: string;
  headSha: string;
  anchor: NoteAnchor | null; // null => PR-level
  body: string;
  orphaned: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Relocate a note in the new row texts; returns null if no unique match (orphaned). */
export function relocateAnchor(a: NoteAnchor, rowTexts: string[]): Interval | null {
  const n = a.anchorText.length;
  if (n === 0) return null;
  const matches: number[] = [];
  for (let i = 0; i + n <= rowTexts.length; i++) {
    let ok = true;
    for (let k = 0; k < n; k++) if (rowTexts[i + k] !== a.anchorText[k]) { ok = false; break; }
    if (ok) matches.push(i);
  }
  if (matches.length === 1) return [matches[0]!, matches[0]! + n];
  if (matches.length > 1) {
    // Disambiguate using context.
    const scored = matches.map((i) => {
      let s = 0;
      a.before.forEach((t, k) => { if (rowTexts[i - a.before.length + k] === t) s++; });
      a.after.forEach((t, k) => { if (rowTexts[i + n + k] === t) s++; });
      return { i, s };
    }).sort((x, y) => y.s - x.s);
    if (scored[0]!.s > (scored[1]?.s ?? -1)) return [scored[0]!.i, scored[0]!.i + n];
  }
  return null;
}

export type PRReviewPhase = "active" | "paused";

export interface PRReviewProgress {
  prKey: string;
  headSha: string;
  baseSha: string;
  phase: PRReviewPhase;
  files: Record<string, FileReviewState>;
  updatedAt: number;
}

export function prProgress(p: PRReviewProgress): { complete: number; total: number; stale: number } {
  const fs = Object.values(p.files);
  return {
    complete: fs.filter((f) => fileStatus(f) === "complete").length,
    total: fs.length,
    stale: fs.filter((f) => f.stale.length > 0).length,
  };
}
