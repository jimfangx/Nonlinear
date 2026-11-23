/**
 * Pending GitHub intentions (design §9 Offline, §13F).
 * GitHub writes cannot be committed offline: they are stored as intentions,
 * then on reconnect the target is re-fetched and the user must confirm replay.
 * Never auto-posted; never silently retried after partial failure.
 */

export type IntentionKind = "comment" | "review" | "update-body" | "labels" | "milestone" | "reviewers" | "chain-block" | "lgtm" | "review-start" | "release-pr";

export interface Intention {
  id: string;
  kind: IntentionKind;
  prKey: string;
  /** head/body fingerprint observed when the intention was created */
  observedHeadSha: string | null;
  observedBodyHash: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
  status: "queued" | "needs-confirmation" | "sent" | "failed" | "discarded";
  error?: string;
  /** what changed upstream since creation, filled on revalidation */
  drift?: string[];
}

export interface RevalidateFacts {
  headSha: string | null;
  bodyHash: string | null;
  state: "open" | "closed" | "merged";
  canWrite: boolean;
}

/** Prepare an intention for user confirmation; never returns "sent". */
export function revalidate(i: Intention, f: RevalidateFacts): Intention {
  const drift: string[] = [];
  if (i.observedHeadSha && f.headSha && i.observedHeadSha !== f.headSha) drift.push(`Head moved ${i.observedHeadSha.slice(0, 8)} → ${f.headSha.slice(0, 8)}; line anchors may be obsolete.`);
  if (i.observedBodyHash && f.bodyHash && i.observedBodyHash !== f.bodyHash) drift.push("Description changed on GitHub since this edit was drafted.");
  if (f.state !== "open") drift.push(`PR is now ${f.state}.`);
  if (!f.canWrite) drift.push("You no longer have permission for this action.");
  return { ...i, status: "needs-confirmation", drift };
}
