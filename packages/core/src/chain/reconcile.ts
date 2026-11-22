/**
 * Reconcile declared edges (from many PR bodies) with local-only edges into a
 * single DAG with per-edge sync status (design §2.2-2.3).
 */
import type { PRKey, PRRef } from "../ids";
import { prKey } from "../ids";
import { DependencyGraph, type DependencyEdge, type CycleError } from "./dag";
import { parseDependencies, type ParsedEdge, type ParseWarning } from "./parser";

export interface BodySource {
  pr: PRRef;
  body: string | null;
}

export interface LocalEdge {
  from: PRKey;
  to: PRKey;
  /** true once the user has asked to write it to GitHub but it hasn't been confirmed */
  pending?: boolean;
  /** user explicitly removed a GitHub-declared edge locally */
  removed?: boolean;
}

export interface Disagreement {
  from: PRKey;
  to: PRKey;
  message: string;
  sources: PRKey[];
}

export interface ReconcileResult {
  graph: DependencyGraph;
  rejected: { edge: DependencyEdge; error: CycleError }[];
  disagreements: Disagreement[];
  warnings: (ParseWarning & { pr: PRKey })[];
}

export function reconcile(bodies: BodySource[], local: LocalEdge[]): ReconcileResult {
  const declared = new Map<string, { edge: ParsedEdge; declaredBy: Set<PRKey> }>();
  const warnings: ReconcileResult["warnings"] = [];
  const disagreements: Disagreement[] = [];

  for (const { pr, body } of bodies) {
    const self = prKey(pr);
    const res = parseDependencies(body, pr);
    res.warnings.forEach((w) => warnings.push({ ...w, pr: self }));
    for (const e of res.edges) {
      const k = `${e.from}->${e.to}`;
      const cur = declared.get(k);
      if (cur) cur.declaredBy.add(self);
      else declared.set(k, { edge: e, declaredBy: new Set([self]) });
    }
  }

  // Contradictions: a->b declared by one PR and b->a by another.
  for (const [k, v] of declared) {
    const rev = `${v.edge.to}->${v.edge.from}`;
    if (declared.has(rev) && k < rev) {
      disagreements.push({
        from: v.edge.from,
        to: v.edge.to,
        message: "Contradictory ordering declared in different PR descriptions",
        sources: [...v.declaredBy, ...declared.get(rev)!.declaredBy],
      });
    }
  }

  const edges: DependencyEdge[] = [];
  const localMap = new Map(local.map((l) => [`${l.from}->${l.to}`, l]));
  for (const [k, v] of declared) {
    const l = localMap.get(k);
    if (l?.removed) {
      edges.push({ ...strip(v.edge), sync: "pending", note: "Removed locally; GitHub description still declares it" });
      // edge remains in graph flagged until GitHub is updated
      continue;
    }
    edges.push({ ...strip(v.edge), sync: "synced" });
  }
  for (const l of local) {
    const k = `${l.from}->${l.to}`;
    if (declared.has(k) || l.removed) continue;
    edges.push({ from: l.from, to: l.to, source: "local", confidence: 1, sync: l.pending ? "pending" : "local-only" });
  }
  for (const d of disagreements) {
    for (const e of edges) {
      if ((e.from === d.from && e.to === d.to) || (e.from === d.to && e.to === d.from)) {
        e.sync = "conflict";
        e.note = d.message;
      }
    }
  }

  const { graph, rejected } = DependencyGraph.from(edges);
  for (const { pr } of bodies) graph.addNode(prKey(pr));
  return { graph, rejected, disagreements, warnings };
}

function strip(e: ParsedEdge): Omit<DependencyEdge, "sync"> {
  return { from: e.from, to: e.to, source: e.source, confidence: e.confidence };
}

export type ChainMutation =
  | { kind: "add-prerequisite"; pr: PRKey; prerequisite: PRKey }
  | { kind: "remove-edge"; from: PRKey; to: PRKey }
  | { kind: "reorder"; order: PRKey[] }
  | { kind: "create"; members: PRKey[] }
  | { kind: "split"; at: PRKey; members: PRKey[] };

/**
 * Apply a mutation to an edge list, returning the new edges. Used to preview
 * graph mutations before saving (§2.3).
 */
export function applyMutation(edges: { from: PRKey; to: PRKey }[], m: ChainMutation): { from: PRKey; to: PRKey }[] {
  const key = (e: { from: PRKey; to: PRKey }) => `${e.from}->${e.to}`;
  const cur = new Map(edges.map((e) => [key(e), e]));
  switch (m.kind) {
    case "add-prerequisite":
      cur.set(`${m.prerequisite}->${m.pr}`, { from: m.prerequisite, to: m.pr });
      break;
    case "remove-edge":
      cur.delete(`${m.from}->${m.to}`);
      break;
    case "create":
    case "reorder": {
      const members = m.kind === "create" ? m.members : m.order;
      const set = new Set(members);
      for (const [k, e] of cur) if (set.has(e.from) && set.has(e.to)) cur.delete(k);
      for (let i = 0; i + 1 < members.length; i++) cur.set(`${members[i]}->${members[i + 1]}`, { from: members[i]!, to: members[i + 1]! });
      break;
    }
    case "split": {
      // Detach `at` and everything after it in `members` from what came before.
      const idx = m.members.indexOf(m.at);
      if (idx <= 0) break;
      const before = new Set(m.members.slice(0, idx));
      const after = new Set(m.members.slice(idx));
      for (const [k, e] of cur) if (before.has(e.from) && after.has(e.to)) cur.delete(k);
      break;
    }
  }
  return [...cur.values()];
}

export interface EdgeDiff {
  added: { from: PRKey; to: PRKey }[];
  removed: { from: PRKey; to: PRKey }[];
}

export function diffEdges(before: { from: PRKey; to: PRKey }[], after: { from: PRKey; to: PRKey }[]): EdgeDiff {
  const k = (e: { from: PRKey; to: PRKey }) => `${e.from}->${e.to}`;
  const b = new Set(before.map(k));
  const a = new Set(after.map(k));
  return { added: after.filter((e) => !b.has(k(e))), removed: before.filter((e) => !a.has(k(e))) };
}
