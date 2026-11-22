/**
 * Dependency DAG (design §2.2). One PR may depend on many; many may depend on one.
 * Cycles are rejected with an explanation. Edges carry sync status (§2.3).
 */
import type { PRKey } from "../ids";
import type { EdgeSource } from "./parser";

export type EdgeSyncStatus = "synced" | "local-only" | "pending" | "conflict";

export interface DependencyEdge {
  from: PRKey; // prerequisite
  to: PRKey; // dependent
  source: EdgeSource;
  confidence: number;
  sync: EdgeSyncStatus;
  /** Human-readable explanation, e.g. for conflicts. */
  note?: string;
}

export interface CycleError {
  kind: "cycle";
  cycle: PRKey[];
  message: string;
}

export class DependencyGraph {
  private readonly out = new Map<PRKey, Map<PRKey, DependencyEdge>>();
  private readonly inn = new Map<PRKey, Set<PRKey>>();
  private readonly nodes = new Set<PRKey>();

  static from(edges: DependencyEdge[]): { graph: DependencyGraph; rejected: { edge: DependencyEdge; error: CycleError }[] } {
    const g = new DependencyGraph();
    const rejected: { edge: DependencyEdge; error: CycleError }[] = [];
    // Higher-confidence edges first so that a low-confidence edge is rejected when it closes a cycle.
    for (const e of [...edges].sort((a, b) => b.confidence - a.confidence)) {
      const err = g.addEdge(e);
      if (err) rejected.push({ edge: e, error: err });
    }
    return { graph: g, rejected };
  }

  addNode(k: PRKey): void {
    this.nodes.add(k);
  }

  /** Adds an edge, or returns a CycleError (edge not added). */
  addEdge(e: DependencyEdge): CycleError | null {
    if (e.from === e.to) return { kind: "cycle", cycle: [e.from], message: `${e.from} cannot depend on itself` };
    const path = this.pathBetween(e.to, e.from);
    if (path) {
      const cycle = [...path, e.to];
      return {
        kind: "cycle",
        cycle,
        message: `Adding ${e.from} → ${e.to} would create a cycle: ${cycle.join(" → ")}`,
      };
    }
    this.nodes.add(e.from);
    this.nodes.add(e.to);
    let m = this.out.get(e.from);
    if (!m) this.out.set(e.from, (m = new Map()));
    const prev = m.get(e.to);
    if (!prev || prev.confidence <= e.confidence) m.set(e.to, e);
    let s = this.inn.get(e.to);
    if (!s) this.inn.set(e.to, (s = new Set()));
    s.add(e.from);
    return null;
  }

  removeEdge(from: PRKey, to: PRKey): boolean {
    const ok = this.out.get(from)?.delete(to) ?? false;
    this.inn.get(to)?.delete(from);
    return ok;
  }

  /** DFS path from a to b (inclusive) following dependency direction. */
  pathBetween(a: PRKey, b: PRKey): PRKey[] | null {
    const prev = new Map<PRKey, PRKey | null>([[a, null]]);
    const stack = [a];
    while (stack.length) {
      const n = stack.pop()!;
      if (n === b) {
        const path: PRKey[] = [];
        for (let c: PRKey | null = n; c !== null; c = prev.get(c) ?? null) path.unshift(c);
        return path;
      }
      for (const nx of this.out.get(n)?.keys() ?? []) {
        if (!prev.has(nx)) {
          prev.set(nx, n);
          stack.push(nx);
        }
      }
    }
    return null;
  }

  allNodes(): PRKey[] {
    return [...this.nodes];
  }

  edges(): DependencyEdge[] {
    return [...this.out.values()].flatMap((m) => [...m.values()]);
  }

  edge(from: PRKey, to: PRKey): DependencyEdge | undefined {
    return this.out.get(from)?.get(to);
  }

  prerequisites(k: PRKey): PRKey[] {
    return [...(this.inn.get(k) ?? [])];
  }

  dependents(k: PRKey): PRKey[] {
    return [...(this.out.get(k)?.keys() ?? [])];
  }

  /** Weakly-connected component containing `k`: the "chain" every member displays (§2.2). */
  component(k: PRKey): PRKey[] {
    if (!this.nodes.has(k)) return [k];
    const seen = new Set<PRKey>([k]);
    const q = [k];
    while (q.length) {
      const n = q.shift()!;
      for (const nx of [...this.dependents(n), ...this.prerequisites(n)]) {
        if (!seen.has(nx)) {
          seen.add(nx);
          q.push(nx);
        }
      }
    }
    return [...seen];
  }

  components(): PRKey[][] {
    const seen = new Set<PRKey>();
    const out: PRKey[][] = [];
    for (const n of [...this.nodes].sort()) {
      if (seen.has(n)) continue;
      const c = this.component(n);
      c.forEach((x) => seen.add(x));
      out.push(c);
    }
    return out;
  }

  /** Kahn's topological sort over a subset, deterministic (ties broken by key). */
  topoOrder(subset?: PRKey[]): PRKey[] {
    const nodes = new Set(subset ?? this.nodes);
    const indeg = new Map<PRKey, number>();
    for (const n of nodes) indeg.set(n, this.prerequisites(n).filter((p) => nodes.has(p)).length);
    const ready = [...nodes].filter((n) => indeg.get(n) === 0).sort();
    const order: PRKey[] = [];
    while (ready.length) {
      const n = ready.shift()!;
      order.push(n);
      for (const d of this.dependents(n).filter((x) => nodes.has(x)).sort()) {
        const v = indeg.get(d)! - 1;
        indeg.set(d, v);
        if (v === 0) {
          ready.push(d);
          ready.sort();
        }
      }
    }
    return order;
  }

  /** True when the subset has a unique total order (a linear stack). */
  isLinear(subset: PRKey[]): boolean {
    const order = this.topoOrder(subset);
    for (let i = 0; i + 1 < order.length; i++) {
      if (!this.edge(order[i]!, order[i + 1]!)) return false;
    }
    return true;
  }

  /** Depth (longest path from a root) for layered rendering of branching chains. */
  layers(subset: PRKey[]): Map<PRKey, number> {
    const set = new Set(subset);
    const depth = new Map<PRKey, number>();
    for (const n of this.topoOrder(subset)) {
      const ps = this.prerequisites(n).filter((p) => set.has(p));
      depth.set(n, ps.length ? Math.max(...ps.map((p) => depth.get(p) ?? 0)) + 1 : 0);
    }
    return depth;
  }

  /** All transitive prerequisites. */
  ancestors(k: PRKey): Set<PRKey> {
    const seen = new Set<PRKey>();
    const q = [...this.prerequisites(k)];
    while (q.length) {
      const n = q.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      q.push(...this.prerequisites(n));
    }
    return seen;
  }
}

/** Per-member status shown on chain rails (§2.2). Never collapsed into one "ready" flag. */
export type MemberState =
  | "draft"
  | "open"
  | "approved"
  | "ci-running"
  | "ci-failing"
  | "mergeable"
  | "merged"
  | "closed-unmerged"
  | "unknown";

export interface ChainReadiness {
  pr: PRKey;
  review: "approved" | "changes-requested" | "pending" | "none" | "unknown";
  ci: "passing" | "failing" | "running" | "none" | "unknown";
  mergeable: "yes" | "no" | "unknown";
  canWrite: boolean | "unknown";
  prerequisitesMerged: boolean;
  blockers: string[];
}

/** Explain why each member is or isn't mergeable, rather than emitting a single flag. */
export function explainReadiness(
  graph: DependencyGraph,
  pr: PRKey,
  facts: Map<PRKey, Omit<ChainReadiness, "pr" | "prerequisitesMerged" | "blockers"> & { merged: boolean }>,
): ChainReadiness {
  const f = facts.get(pr);
  const blockers: string[] = [];
  const unmerged = [...graph.ancestors(pr)].filter((a) => !facts.get(a)?.merged);
  if (unmerged.length) blockers.push(`Unmerged prerequisites: ${unmerged.sort().join(", ")}`);
  if (!f) {
    return { pr, review: "unknown", ci: "unknown", mergeable: "unknown", canWrite: "unknown", prerequisitesMerged: !unmerged.length, blockers: [...blockers, "No snapshot loaded"] };
  }
  if (f.review !== "approved") blockers.push(`Review: ${f.review}`);
  if (f.ci !== "passing" && f.ci !== "none") blockers.push(`CI: ${f.ci}`);
  if (f.mergeable !== "yes") blockers.push(`Mergeable: ${f.mergeable}`);
  if (f.canWrite !== true) blockers.push(f.canWrite === false ? "You lack merge permission" : "Merge permission unknown");
  return { pr, review: f.review, ci: f.ci, mergeable: f.mergeable, canWrite: f.canWrite, prerequisitesMerged: !unmerged.length, blockers };
}
