/**
 * Global releases and draft pin manifests (design §3.2, §3.3).
 * A release is a named set of target revisions — no date required. Editing a
 * release never modifies GitHub or a working tree.
 */
import type { RepoKey } from "../ids";

export type ReleaseState = "draft" | "frozen" | "applied" | "archived";

export interface ReleaseRootTarget {
  root: RepoKey;
  /** desired root commit, if pinned; otherwise derived from pins */
  sha: string | null;
  baseRef: string;
}

export interface ReleasePin {
  releaseId: string;
  /** parent repository whose tree contains the gitlink */
  parentRepo: RepoKey;
  /** full path chain from the root, e.g. ["generators/gemmini", "software/gemmini-rocc-tests"] */
  pathChain: string[];
  childRepo: RepoKey | null;
  sha: string;
  /** commit date for timeline placement */
  committedAt?: string;
  note?: string;
  updatedAt: number;
}

export interface Release {
  id: string;
  name: string;
  color: string;
  state: ReleaseState;
  targetDate: string | null; // optional, informational only
  roots: ReleaseRootTarget[];
  validation: string[]; // qualification criteria
  createdAt: number;
  updatedAt: number;
  /** monotonically increasing revision for 3-way conflict detection on sync */
  revision: number;
}

export function pinKey(p: Pick<ReleasePin, "releaseId" | "parentRepo" | "pathChain">): string {
  return `${p.releaseId}|${p.parentRepo}|${p.pathChain.join("/")}`;
}

export interface Manifest {
  format: "nonlinear-release-manifest";
  version: 1;
  release: { id: string; name: string; state: ReleaseState; validation: string[] };
  roots: ReleaseRootTarget[];
  pins: { parent: RepoKey; path: string; child: RepoKey | null; sha: string }[];
  exportedAt: string;
}

export function exportManifest(r: Release, pins: ReleasePin[], now = new Date()): Manifest {
  return {
    format: "nonlinear-release-manifest",
    version: 1,
    release: { id: r.id, name: r.name, state: r.state, validation: r.validation },
    roots: r.roots,
    pins: pins
      .filter((p) => p.releaseId === r.id)
      .map((p) => ({ parent: p.parentRepo, path: p.pathChain.join("/"), child: p.childRepo, sha: p.sha }))
      .sort((a, b) => (a.parent + a.path).localeCompare(b.parent + b.path)),
    exportedAt: now.toISOString(),
  };
}

/** Lockfile-ish text export (one line per pin). */
export function manifestToText(m: Manifest): string {
  const lines = [`# ${m.release.name} (${m.release.id}) — ${m.release.state}`, `# exported ${m.exportedAt}`];
  for (const r of m.roots) lines.push(`root ${r.root} ${r.baseRef} ${r.sha ?? "-"}`);
  for (const p of m.pins) lines.push(`pin ${p.parent} ${p.path} ${p.sha}${p.child ? ` ${p.child}` : ""}`);
  return lines.join("\n") + "\n";
}

export interface CurrentGitlink {
  parentRepo: RepoKey;
  path: string;
  sha: string;
}

export interface GitlinkChange {
  parentRepo: RepoKey;
  path: string;
  oldSha: string | null;
  newSha: string;
  childRepo: RepoKey | null;
  checks: { fetchable: boolean | "unknown"; ancestorOfTarget: boolean | "unknown"; note?: string };
}

/**
 * Preview "Apply planned pins" (§3.2): gitlink old → new per parent.
 * Does not touch any repository. Callers fill in `checks` asynchronously.
 */
export function planApply(pins: ReleasePin[], current: CurrentGitlink[]): { changes: GitlinkChange[]; unchanged: number; parents: RepoKey[] } {
  const cur = new Map(current.map((c) => [`${c.parentRepo}|${c.path}`, c.sha]));
  const changes: GitlinkChange[] = [];
  let unchanged = 0;
  for (const p of pins) {
    const path = p.pathChain[p.pathChain.length - 1]!;
    const old = cur.get(`${p.parentRepo}|${path}`) ?? null;
    if (old === p.sha) {
      unchanged++;
      continue;
    }
    changes.push({ parentRepo: p.parentRepo, path, oldSha: old, newSha: p.sha, childRepo: p.childRepo, checks: { fetchable: "unknown", ancestorOfTarget: "unknown" } });
  }
  return { changes, unchanged, parents: [...new Set(changes.map((c) => c.parentRepo))].sort() };
}

/** Unified patch text for a set of gitlink updates in one parent repo. */
export function gitlinkPatch(changes: GitlinkChange[]): string {
  return changes
    .filter((c) => c.oldSha)
    .map((c) =>
      [
        `diff --git a/${c.path} b/${c.path}`,
        `index ${c.oldSha!.slice(0, 7)}..${c.newSha.slice(0, 7)} 160000`,
        `--- a/${c.path}`,
        `+++ b/${c.path}`,
        `@@ -1 +1 @@`,
        `-Subproject commit ${c.oldSha}`,
        `+Subproject commit ${c.newSha}`,
      ].join("\n"),
    )
    .join("\n") + "\n";
}

/**
 * Conflicting targets (§3.2): a parent can pin only one child revision per
 * commit. Detect when two releases in the same "apply" set, or two roots in
 * one release, want different SHAs for the same (parent, path).
 */
export function findPinConflicts(pins: ReleasePin[]): { parent: RepoKey; path: string; shas: string[]; releases: string[] }[] {
  const m = new Map<string, { shas: Set<string>; releases: Set<string> }>();
  for (const p of pins) {
    const k = `${p.parentRepo}|${p.pathChain[p.pathChain.length - 1]}`;
    let v = m.get(k);
    if (!v) m.set(k, (v = { shas: new Set(), releases: new Set() }));
    v.shas.add(p.sha);
    v.releases.add(p.releaseId);
  }
  return [...m]
    .filter(([, v]) => v.shas.size > 1)
    .map(([k, v]) => {
      const [parent, path] = k.split("|") as [string, string];
      return { parent, path, shas: [...v.shas], releases: [...v.releases] };
    });
}

/**
 * Nested consistency (§3.3): for a planned parent pin of a child repo, check
 * that the child's tree at that SHA pins the grandchildren at the planned
 * nested SHAs. `childGitlinksAt(sha)` returns the child's gitlinks at a commit.
 */
export interface NestedWarning {
  parentPath: string;
  nestedPath: string;
  plannedNested: string;
  actualAtParentPin: string | null;
  message: string;
}

export function checkNestedConsistency(
  parentPin: ReleasePin,
  nestedPins: ReleasePin[],
  childGitlinksAt: Map<string, string>,
): NestedWarning[] {
  const out: NestedWarning[] = [];
  const prefix = parentPin.pathChain.join("/");
  for (const n of nestedPins) {
    if (n.pathChain.length !== parentPin.pathChain.length + 1) continue;
    if (n.pathChain.slice(0, -1).join("/") !== prefix) continue;
    const nestedPath = n.pathChain[n.pathChain.length - 1]!;
    const actual = childGitlinksAt.get(nestedPath) ?? null;
    if (actual !== n.sha) {
      out.push({
        parentPath: prefix,
        nestedPath,
        plannedNested: n.sha,
        actualAtParentPin: actual,
        message: actual
          ? `Planned ${prefix}@${parentPin.sha.slice(0, 8)} pins ${nestedPath} at ${actual.slice(0, 8)}, not the planned ${n.sha.slice(0, 8)}. Propagate the nested proposal upward to select a parent commit that contains it.`
          : `Planned ${prefix}@${parentPin.sha.slice(0, 8)} does not contain submodule ${nestedPath}.`,
      });
    }
  }
  return out;
}

/** Three-way merge for pin manifests (§10): never silently LWW. */
export type PinMergeResult =
  | { kind: "clean"; pins: Map<string, ReleasePin> }
  | { kind: "conflict"; pins: Map<string, ReleasePin>; conflicts: { key: string; base: string | null; local: string | null; remote: string | null }[] };

export function mergePins(base: ReleasePin[], local: ReleasePin[], remote: ReleasePin[]): PinMergeResult {
  const toMap = (xs: ReleasePin[]) => new Map(xs.map((p) => [pinKey(p), p]));
  const b = toMap(base), l = toMap(local), r = toMap(remote);
  const keys = new Set([...b.keys(), ...l.keys(), ...r.keys()]);
  const out = new Map<string, ReleasePin>();
  const conflicts: { key: string; base: string | null; local: string | null; remote: string | null }[] = [];
  for (const k of keys) {
    const bs = b.get(k)?.sha ?? null, ls = l.get(k)?.sha ?? null, rs = r.get(k)?.sha ?? null;
    if (ls === rs) { if (ls) out.set(k, l.get(k)!); continue; }
    if (ls === bs) { if (rs) out.set(k, r.get(k)!); continue; }
    if (rs === bs) { if (ls) out.set(k, l.get(k)!); continue; }
    conflicts.push({ key: k, base: bs, local: ls, remote: rs });
    if (ls) out.set(k, l.get(k)!);
  }
  return conflicts.length ? { kind: "conflict", pins: out, conflicts } : { kind: "clean", pins: out };
}

export const RELEASE_COLORS = ["#7c5cff", "#ff6b6b", "#2bb673", "#f5a623", "#3aa0ff", "#e056fd", "#00b5ad"];
