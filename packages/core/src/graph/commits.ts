/**
 * Commit DAG utilities for the submodule timeline (§3.1) and Git graph (§7).
 * Dates are visual coordinates only; ancestry is the source of truth.
 */

export interface CommitNode {
  sha: string;
  parents: string[];
  committedAt: string; // ISO
  authoredAt?: string;
  author: string;
  message: string;
  refs?: string[]; // branch/tag names
}

export class CommitIndex {
  readonly bySha = new Map<string, CommitNode>();
  /** true when parents referenced but not loaded (shallow/paginated history) */
  incomplete = false;

  constructor(commits: CommitNode[] = []) {
    this.add(commits);
  }

  add(commits: CommitNode[]): void {
    for (const c of commits) this.bySha.set(c.sha, c);
    this.incomplete = [...this.bySha.values()].some((c) => c.parents.some((p) => !this.bySha.has(p)));
  }

  /** Is `a` an ancestor of (or equal to) `b`? "unknown" if history is truncated before resolving. */
  isAncestor(a: string, b: string): boolean | "unknown" {
    if (a === b) return true;
    const seen = new Set<string>();
    const stack = [b];
    let hitBoundary = false;
    while (stack.length) {
      const s = stack.pop()!;
      if (seen.has(s)) continue;
      seen.add(s);
      const c = this.bySha.get(s);
      if (!c) { hitBoundary = true; continue; }
      for (const p of c.parents) {
        if (p === a) return true;
        stack.push(p);
      }
    }
    return hitBoundary ? "unknown" : false;
  }

  /** Commits reachable from `tip` (first-parent optional), newest first by topo-date. */
  reachable(tip: string, limit = 5000): CommitNode[] {
    const out: CommitNode[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length && out.length < limit) {
      const s = stack.pop()!;
      if (seen.has(s)) continue;
      seen.add(s);
      const c = this.bySha.get(s);
      if (!c) continue;
      out.push(c);
      stack.push(...c.parents);
    }
    return out.sort((x, y) => y.committedAt.localeCompare(x.committedAt));
  }

  /** "Align to date" (§3.2): latest commit reachable from tip with committedAt <= date. Suggestion only. */
  latestAtOrBefore(tip: string, isoDate: string): CommitNode | null {
    let best: CommitNode | null = null;
    for (const c of this.reachable(tip)) if (c.committedAt <= isoDate && (!best || c.committedAt > best.committedAt)) best = c;
    return best;
  }

  /** Merge base (best common ancestor by date among common ancestors). */
  mergeBase(a: string, b: string): string | null {
    const anc = (x: string) => new Set(this.reachable(x, 100000).map((c) => c.sha));
    const A = anc(a);
    let best: CommitNode | null = null;
    for (const c of this.reachable(b, 100000)) if (A.has(c.sha) && (!best || c.committedAt > best.committedAt)) best = c;
    return best?.sha ?? null;
  }
}

/* ------------------------------------------------------------------ */
/* Lane layout (GitKraken-style) — incremental-friendly                 */
/* ------------------------------------------------------------------ */

export interface LaidOutCommit {
  commit: CommitNode;
  row: number;
  lane: number;
  /** Whether a drawn lane reaches this commit from an earlier row. */
  hasIncoming?: boolean;
  /** edges to parents: [fromLane, toLane, parentRow|null] */
  edges: { toSha: string; fromLane: number; toLane: number }[];
  /** active lanes passing through this row (for drawing vertical lines) */
  passThrough: number[];
}

/**
 * Assign lanes for commits in topological (newest-first) order.
 * Standard algorithm: maintain an array of "expected sha" per lane.
 */
export function layoutLanes(commits: CommitNode[], branchTips: readonly (string | undefined)[] = []): {
  rows: LaidOutCommit[];
  maxLane: number;
  dividers: number[];
} {
  const ordered = topoSortNewestFirst(commits);
  const comparing = branchTips.length > 1;
  const owners = new Map<string, number>();
  if (comparing) {
    const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
    branchTips.forEach((tip, group) => {
      const pending = tip ? [tip] : [];
      while (pending.length) {
        const sha = pending.pop()!;
        if (owners.has(sha)) continue;
        owners.set(sha, group);
        pending.push(...(bySha.get(sha)?.parents ?? []));
      }
    });
  }

  const lanes: (string | null)[] = [];
  const laneGroups: number[] = [];
  const rows: LaidOutCommit[] = [];
  const freeLane = (group: number) => {
    const free = lanes.findIndex((expected, i) => expected === null && laneGroups[i] === group);
    if (free >= 0) return free;
    laneGroups.push(group);
    lanes.push(null);
    return lanes.length - 1;
  };
  ordered.forEach((c, row) => {
    const incoming = lanes.indexOf(c.sha);
    const group = owners.get(c.sha) ?? 0;
    const lane = incoming >= 0 ? incoming : freeLane(group);
    // Any other lanes also waiting for this commit converge here.
    for (let i = 0; i < lanes.length; i++) if (i !== lane && lanes[i] === c.sha) lanes[i] = null;
    const passThrough = lanes.map((s, i) => (s && i !== lane ? i : -1)).filter((i) => i >= 0);
    const edges: LaidOutCommit["edges"] = [];
    lanes[lane] = comparing ? null : c.parents[0] ?? null;
    c.parents.forEach((sha, i) => {
      const parentGroup = owners.get(sha) ?? group;
      let toLane = comparing || i > 0 ? lanes.indexOf(sha) : lane;
      if (toLane < 0) {
        toLane = i === 0 && group === parentGroup ? lane : freeLane(parentGroup);
        lanes[toLane] = sha;
      }
      edges.push({ toSha: sha, fromLane: lane, toLane });
    });
    rows.push({ commit: c, row, lane, edges, passThrough, hasIncoming: comparing ? incoming >= 0 : undefined });
  });

  if (!comparing) return { rows, maxLane: Math.max(0, lanes.length - 1), dividers: [] };

  // Keep each branch's lanes contiguous. Shared ancestors belong to the first selected
  // branch that reaches them, so ancestry can cross a divider without duplicating commits.
  const positions: number[] = [];
  const dividers: number[] = [];
  let offset = 0;
  branchTips.forEach((_, group) => {
    if (group) dividers.push(offset - 0.5);
    let count = 0;
    laneGroups.forEach((owner, lane) => { if (owner === group) positions[lane] = offset + count++; });
    offset += Math.max(1, count);
  });
  for (const row of rows) {
    row.lane = positions[row.lane]!;
    row.passThrough = row.passThrough.map((lane) => positions[lane]!);
    for (const edge of row.edges) {
      edge.fromLane = positions[edge.fromLane]!;
      edge.toLane = positions[edge.toLane]!;
    }
  }
  return { rows, maxLane: offset - 1, dividers };
}

/** Topological order (children before parents), ties by date desc. */
export function topoSortNewestFirst(commits: CommitNode[]): CommitNode[] {
  const by = new Map(commits.map((c) => [c.sha, c]));
  const childCount = new Map<string, number>();
  for (const c of commits) for (const p of c.parents) if (by.has(p)) childCount.set(p, (childCount.get(p) ?? 0) + 1);
  const ready = commits.filter((c) => !childCount.get(c.sha)).sort((a, b) => b.committedAt.localeCompare(a.committedAt));
  const out: CommitNode[] = [];
  while (ready.length) {
    const c = ready.shift()!;
    out.push(c);
    for (const p of c.parents) {
      if (!by.has(p)) continue;
      const n = childCount.get(p)! - 1;
      childCount.set(p, n);
      if (n === 0) {
        const pc = by.get(p)!;
        // insert keeping date-desc order
        let i = 0;
        while (i < ready.length && ready[i]!.committedAt >= pc.committedAt) i++;
        ready.splice(i, 0, pc);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Timeline scale                                                      */
/* ------------------------------------------------------------------ */

export type Zoom = "day" | "week" | "month" | "year";
export const PX_PER_DAY: Record<Zoom, number> = { day: 80, week: 16, month: 4, year: 1 };

export interface TimeScale {
  start: number; // ms
  end: number; // ms
  pxPerDay: number;
}

export function makeScale(dates: (string | number)[], zoom: Zoom, padDays = 3): TimeScale {
  const ts = dates.map((d) => (typeof d === "number" ? d : Date.parse(d))).filter((n) => Number.isFinite(n));
  const now = Date.now();
  const min = ts.length ? Math.min(...ts) : now - 30 * 864e5;
  const max = Math.max(ts.length ? Math.max(...ts) : now, now);
  return { start: min - padDays * 864e5, end: max + padDays * 864e5, pxPerDay: PX_PER_DAY[zoom] };
}

export function xOf(s: TimeScale, d: string | number): number {
  const t = typeof d === "number" ? d : Date.parse(d);
  return ((t - s.start) / 864e5) * s.pxPerDay;
}

export function scaleWidth(s: TimeScale): number {
  return xOf(s, s.end);
}

export function ticks(s: TimeScale, zoom: Zoom): { x: number; label: string }[] {
  const out: { x: number; label: string }[] = [];
  const d = new Date(s.start);
  const format = new Intl.DateTimeFormat(undefined, zoom === "year"
    ? { month: "short", year: "numeric", timeZone: "UTC" }
    : zoom === "month" ? { month: "short", year: "2-digit", timeZone: "UTC" }
    : { month: "short", day: "numeric", timeZone: "UTC" });
  d.setUTCHours(0, 0, 0, 0);
  if (zoom === "month" || zoom === "year") d.setUTCDate(1);
  if (zoom === "year") d.setUTCMonth(Math.floor(d.getUTCMonth() / 3) * 3);
  if (zoom === "week") d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  while (d.getTime() <= s.end) {
    if (d.getTime() >= s.start) {
      out.push({ x: xOf(s, d.getTime()), label: format.format(d) });
    }
    if (zoom === "day") d.setUTCDate(d.getUTCDate() + 1);
    else if (zoom === "week") d.setUTCDate(d.getUTCDate() + 7);
    else d.setUTCMonth(d.getUTCMonth() + (zoom === "year" ? 3 : 1));
  }
  return out;
}
