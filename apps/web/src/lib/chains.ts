import { useMemo } from "react";
import {
  reconcile,
  parseDependencies,
  parsePRKey,
  newId,
  type DependencyGraph,
  type LocalEdge,
  type PRKey,
  type ReconcileResult,
} from "@nonlinear/core";
import { useApp } from "./store";
import { ensurePR } from "./github";

/** Reconciled dependency graph across every cached PR body + local edges. */
export function useChainGraph(): ReconcileResult {
  const prs = useApp((s) => s.prs);
  const localEdges = useApp((s) => s.localEdges);
  return useMemo(() => {
    const bodies = Object.values(prs).map((p) => ({ pr: { owner: p.owner, repo: p.repo, number: p.number }, body: p.body }));
    return reconcile(bodies, Object.values(localEdges));
  }, [prs, localEdges]);
}

export function blockedSet(graph: DependencyGraph, prs: Record<string, { state: string }>): Set<PRKey> {
  const out = new Set<PRKey>();
  for (const n of graph.allNodes()) {
    for (const a of graph.ancestors(n)) {
      if (prs[a]?.state !== "merged") {
        out.add(n);
        break;
      }
    }
  }
  return out;
}

/** Fetch referenced external PRs (read-only) so the chain shows real statuses. */
export async function hydrateChain(members: PRKey[], max = 8): Promise<void> {
  const prs = useApp.getState().prs;
  const missing = members.filter((m) => !prs[m] && parsePRKey(m));
  await Promise.all(missing.slice(0, max).map((m) => ensurePR(m).catch(() => undefined)));
}

export function edgeId(from: PRKey, to: PRKey): string {
  return `${from}->${to}`;
}

export function setLocalEdges(add: { from: PRKey; to: PRKey }[], remove: { from: PRKey; to: PRKey }[], declared: Set<string>): void {
  const st = useApp.getState();
  for (const e of remove) {
    const id = edgeId(e.from, e.to);
    if (declared.has(id)) st.put("localEdges", id, { from: e.from, to: e.to, removed: true } satisfies LocalEdge);
    else st.remove("localEdges", id);
  }
  for (const e of add) {
    const id = edgeId(e.from, e.to);
    st.put("localEdges", id, { from: e.from, to: e.to } satisfies LocalEdge);
  }
}

/**
 * Stable chain id for a component (persisted so the managed block id doesn't churn).
 * Reuses an id already present in any member's PR description first, so a second
 * device or teammate updates the existing managed block instead of appending another.
 */
export function chainIdFor(members: PRKey[]): string {
  const st = useApp.getState();
  const set = new Set(members);
  for (const m of members) {
    const pr = st.prs[m];
    const ref = parsePRKey(m);
    if (!pr?.body || !ref) continue;
    const [existingId] = parseDependencies(pr.body, ref).managedBlockIds;
    if (existingId) {
      st.put("chains", existingId, { id: existingId, label: st.chains[existingId]?.label ?? "", members, createdAt: st.chains[existingId]?.createdAt ?? Date.now() });
      return existingId;
    }
  }
  const existing = Object.values(st.chains).find((c) => c.members.some((m) => set.has(m)));
  if (existing) {
    st.put("chains", existing.id, { ...existing, members });
    return existing.id;
  }
  const id = newId("chain");
  st.put("chains", id, { id, label: "", members, createdAt: Date.now() });
  return id;
}
