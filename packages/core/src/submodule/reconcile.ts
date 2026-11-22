/**
 * Submodule-aware dependency reconciliation (design §2.4).
 *
 * When a downstream PR bumps a gitlink to a provisional SHA from an upstream
 * PR, and that upstream PR merges (merge/squash/rebase), compute the proposed
 * final gitlink. Merge of the upstream PR alone never proves the downstream
 * pin is correct; we verify reachability and tree equality.
 */
import type { CommitNode } from "../graph/commits";

export type MergeMethod = "merge" | "squash" | "rebase" | "unknown";

export interface UpstreamMergeFacts {
  /** commits on the PR branch, oldest → newest */
  prCommits: CommitNode[];
  /** PR head SHA at merge time */
  headSha: string;
  /** API merge_commit_sha */
  mergeCommitSha: string | null;
  /** base branch commits after merge, newest first (first-parent history) */
  baseAfterMerge: CommitNode[];
  /** tree SHA lookup (for content equality) */
  treeOf: (sha: string) => string | undefined;
  baseBranch: string;
}

export interface GitlinkProposal {
  method: MergeMethod;
  provisionalSha: string;
  proposedSha: string | null;
  confidence: "verified" | "probable" | "unresolved";
  evidence: string[];
  warnings: string[];
}

export function detectMergeMethod(f: UpstreamMergeFacts): MergeMethod {
  const mc = f.baseAfterMerge.find((c) => c.sha === f.mergeCommitSha);
  if (!mc) return "unknown";
  if (mc.parents.length === 2 && mc.parents.includes(f.headSha)) return "merge";
  if (f.prCommits.length > 1 && f.prCommits.every((pc) => f.baseAfterMerge.some((b) => b.message === pc.message && b.sha !== pc.sha))) return "rebase";
  if (mc.parents.length === 1) return f.prCommits.length === 1 && mc.message === f.prCommits[0]!.message ? "rebase" : "squash";
  return "unknown";
}

export function proposeGitlink(provisionalSha: string, f: UpstreamMergeFacts): GitlinkProposal {
  const method = detectMergeMethod(f);
  const evidence: string[] = [];
  const warnings: string[] = [];
  let proposed: string | null = null;
  let confidence: GitlinkProposal["confidence"] = "unresolved";
  const headTree = f.treeOf(f.headSha);

  if (provisionalSha !== f.headSha) {
    warnings.push(`Provisional pin ${provisionalSha.slice(0, 8)} is not the upstream PR head ${f.headSha.slice(0, 8)}; the downstream PR may be pinned to an older revision.`);
  }

  switch (method) {
    case "merge":
      // PR commits are reachable as-is; the provisional SHA itself may remain valid,
      // but the base-branch merge commit is the canonical published revision.
      proposed = f.mergeCommitSha;
      evidence.push(`Merge commit ${f.mergeCommitSha?.slice(0, 8)} has the PR head as a parent.`);
      if (headTree && f.mergeCommitSha && f.treeOf(f.mergeCommitSha) === headTree) evidence.push("Merge commit tree equals PR head tree.");
      confidence = "verified";
      break;
    case "squash": {
      proposed = f.mergeCommitSha;
      const t = f.mergeCommitSha ? f.treeOf(f.mergeCommitSha) : undefined;
      if (t && headTree && t === headTree) {
        evidence.push("Squash commit tree equals PR head tree.");
        confidence = "verified";
      } else {
        warnings.push("Squash commit tree differs from PR head (base moved or conflict resolution). Verify contents before pinning.");
        confidence = "probable";
      }
      break;
    }
    case "rebase": {
      // Choose the rebased counterpart of the PR head — NOT blindly merge_commit_sha.
      const last = f.prCommits[f.prCommits.length - 1];
      const counterpart = last ? f.baseAfterMerge.find((b) => b.message === last.message && b.sha !== last.sha) : undefined;
      proposed = counterpart?.sha ?? null;
      if (counterpart) {
        evidence.push(`Rebased counterpart of PR head found on ${f.baseBranch}: ${counterpart.sha.slice(0, 8)}.`);
        const t = f.treeOf(counterpart.sha);
        if (t && headTree && t === headTree) {
          evidence.push("Rebased commit tree equals PR head tree.");
          confidence = "verified";
        } else {
          confidence = "probable";
          warnings.push("Rebased tree differs from PR head; base advanced. Review the upstream diff.");
        }
        if (f.mergeCommitSha && f.mergeCommitSha !== counterpart.sha) warnings.push(`API merge_commit_sha ${f.mergeCommitSha.slice(0, 8)} is not the rebased head; ignoring it.`);
      } else warnings.push("Could not identify the rebased head commit on the base branch.");
      break;
    }
    default:
      warnings.push("Could not determine merge method from history.");
  }
  if (proposed && !f.baseAfterMerge.some((c) => c.sha === proposed)) {
    warnings.push(`Proposed ${proposed.slice(0, 8)} is not on the loaded ${f.baseBranch} history; reachability unverified.`);
    if (confidence === "verified") confidence = "probable";
  }
  warnings.push("After updating the gitlink, CI must rerun and review freshness must be recalculated.");
  return { method, provisionalSha, proposedSha: proposed, confidence, evidence, warnings };
}
