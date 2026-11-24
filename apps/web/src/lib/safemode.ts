/**
 * Safe mode: while on, nothing is written to GitHub. Each write is staged
 * locally (persisted) with a human-readable preview. Leaving safe mode opens a
 * review where every staged change is sent or discarded explicitly.
 *
 * The exact write closure is kept in memory so a send behaves exactly as the
 * original action would have (e.g. the chain block is rebased against the PR
 * body at send time). After a reload only the payload survives; known kinds are
 * replayed from it, others ask the user to redo the action.
 */
import { newId, parsePRKey, type Capability, type IntentionKind } from "@nonlinear/core";
import { useApp, type StagedWrite } from "./store";

const runners = new Map<string, () => Promise<unknown>>();

export function safeModeOn(): boolean {
  return useApp.getState().settings_().safeMode;
}

export interface StageRequest {
  kind: IntentionKind;
  prKey: string | null;
  repoKey: string;
  need: Capability;
  payload: Record<string, unknown>;
  run: () => Promise<unknown>;
  title?: string;
  preview?: string;
  url?: string;
}

export function stage(req: StageRequest): StagedWrite {
  const id = newId("stg");
  const described = describe(req.kind, req.prKey, req.payload);
  const item: StagedWrite = {
    id,
    kind: req.kind,
    prKey: req.prKey,
    repoKey: req.repoKey,
    need: req.need,
    title: req.title ?? described.title,
    preview: req.preview ?? described.preview,
    url: req.url ?? (req.prKey ? prUrl(req.prKey) : `https://github.com/${req.repoKey}`),
    payload: req.payload,
    createdAt: Date.now(),
  };
  runners.set(id, req.run);
  useApp.getState().put("staged", id, item);
  return item;
}

export function hasRunner(id: string): boolean {
  return runners.has(id);
}

export function takeRunner(id: string): (() => Promise<unknown>) | undefined {
  const r = runners.get(id);
  runners.delete(id);
  return r;
}

export function discardStaged(id: string): void {
  runners.delete(id);
  useApp.getState().remove("staged", id);
}

function prUrl(prKey: string): string {
  const r = parsePRKey(prKey);
  return r ? `https://github.com/${r.owner}/${r.repo}/pull/${r.number}` : "";
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v, null, 1));

/** Plain-language summary of what a staged write will do upstream. */
export function describe(kind: IntentionKind, prKey: string | null, p: Record<string, unknown>): { title: string; preview: string } {
  const on = prKey ?? "repository";
  switch (kind) {
    case "comment":
      return { title: `Post a comment on ${on}`, preview: str(p.body) };
    case "review": {
      const comments = (p.comments as { path: string; line: number; body: string }[] | undefined) ?? [];
      const ev = p.event === "APPROVE" ? "Approve" : p.event === "REQUEST_CHANGES" ? "Request changes on" : "Submit a review on";
      return { title: `${ev} ${on}${comments.length ? ` with ${comments.length} inline comment${comments.length > 1 ? "s" : ""}` : ""}`, preview: [str(p.body), ...comments.map((c) => `${c.path}:${c.line} — ${c.body}`)].filter(Boolean).join("\n\n") };
    }
    case "lgtm":
      return { title: `Approve ${on} (LGTM)`, preview: str(p.body) || "LGTM" };
    case "review-start":
      return { title: `Add yourself as a reviewer on ${on}`, preview: `Requests a review from @${str(p.login)} so others can see you are reviewing.` };
    case "chain-block":
      return { title: `Update the managed chain block in ${on}`, preview: str((p.content as { label?: string } | undefined)?.label ?? "") || "Rewrites only the Nonlinear chain section of the PR description." };
    case "update-body":
    case "labels":
    case "milestone":
    case "reviewers": {
      const parts: string[] = [];
      if (p.title !== undefined) parts.push(`Title → ${str(p.title)}`);
      if (p.labels !== undefined) parts.push(`Labels → ${(p.labels as string[]).join(", ") || "(none)"}`);
      if (p.milestone !== undefined) parts.push(`Milestone → ${p.milestone ?? "(none)"}`);
      if ((p.reviewers as string[] | undefined)?.length) parts.push(`Request reviewers → ${(p.reviewers as string[]).join(", ")}`);
      if (p.body !== undefined) parts.push(`Description →\n${str(p.body)}`);
      return { title: `Edit ${on}`, preview: parts.join("\n") };
    }
    case "release-pr":
      return { title: `Create a branch and draft PR in ${str(p.repo)}`, preview: str(p.summary) };
    case "create-issue":
      return { title: `Open an issue in ${str(p.repo)}`, preview: `${str(p.title)}\n\n${str(p.body)}` };
  }
}
