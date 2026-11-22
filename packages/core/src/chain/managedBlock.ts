/**
 * Managed Markdown block in PR descriptions (design §2.3).
 *
 *   <!-- nonlinear:chain:start v1 id=chain_01 -->
 *   Depends-On: https://github.com/o/r/pull/1
 *   PR-Stack: https://github.com/o/r/pull/1 -> https://github.com/o/s/pull/2
 *   <!-- nonlinear:chain:end -->
 *
 * Only the block carrying the same managed ID is ever replaced; unrelated text
 * and other tools' metadata are preserved byte-for-byte.
 */
import { parsePRKey, prUrl, type PRKey } from "../ids";

export const BLOCK_VERSION = 1;
const START_RE = (id: string) =>
  new RegExp(`<!--\\s*(?:nonlinear|maintainer-workbench):chain:start\\s+v\\d+\\s+id=${escapeRe(id)}\\s*-->`, "i");
const END_RE = /<!--\s*(?:nonlinear|maintainer-workbench):chain:end\s*-->/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ManagedBlockContent {
  chainId: string;
  /** Direct prerequisites of the PR whose body this is. */
  dependsOn: PRKey[];
  /** Ordered stack (topological), for human readers. */
  stack: PRKey[];
}

function url(k: PRKey): string {
  const r = parsePRKey(k);
  if (!r) throw new Error(`Invalid PR key ${k}`);
  return prUrl(r);
}

export function renderManagedBlock(c: ManagedBlockContent): string {
  if (!/^[A-Za-z0-9_-]+$/.test(c.chainId)) throw new Error("Invalid chain id");
  const lines = [`<!-- nonlinear:chain:start v${BLOCK_VERSION} id=${c.chainId} -->`];
  for (const d of c.dependsOn) lines.push(`Depends-On: ${url(d)}`);
  if (c.stack.length > 1) lines.push(`PR-Stack: ${c.stack.map(url).join(" -> ")}`);
  lines.push("<!-- nonlinear:chain:end -->");
  return lines.join("\n");
}

export interface BlockLocation {
  start: number;
  end: number; // exclusive, after end marker
  text: string;
}

export function findManagedBlock(body: string, chainId: string): BlockLocation | null {
  const s = START_RE(chainId).exec(body);
  if (!s) return null;
  const rest = body.slice(s.index);
  const e = END_RE.exec(rest);
  if (!e) return null;
  const end = s.index + e.index + e[0].length;
  return { start: s.index, end, text: body.slice(s.index, end) };
}

/** Insert or replace our block, appended at the end of the description. */
export function upsertManagedBlock(body: string | null | undefined, c: ManagedBlockContent): string {
  const b = body ?? "";
  const block = renderManagedBlock(c);
  const loc = findManagedBlock(b, c.chainId);
  if (loc) return b.slice(0, loc.start) + block + b.slice(loc.end);
  const trimmed = b.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

export function removeManagedBlock(body: string, chainId: string): string {
  const loc = findManagedBlock(body, chainId);
  if (!loc) return body;
  const before = body.slice(0, loc.start).replace(/\s+$/, "");
  const after = body.slice(loc.end).replace(/^\s+/, "");
  return after ? `${before}\n\n${after}` : before ? `${before}\n` : "";
}

export type RebaseOutcome =
  | { kind: "unchanged-remote"; body: string }
  | { kind: "rebased"; body: string; note: string }
  | { kind: "conflict"; reason: string; remoteBlock: string | null; baseBlock: string | null };

/**
 * Concurrency-safe update (§2.3). `base` is the description we last fetched,
 * `remote` is the description fetched immediately before writing.
 *  - remote == base           → write our desired body
 *  - only non-block text changed remotely → rebase our block onto remote
 *  - our managed block was changed remotely by someone else → conflict
 */
export function rebaseManagedUpdate(base: string, remote: string, desired: ManagedBlockContent): RebaseOutcome {
  const next = upsertManagedBlock(remote, desired);
  if (base === remote) return { kind: "unchanged-remote", body: next };
  const baseBlock = findManagedBlock(base, desired.chainId)?.text ?? null;
  const remoteBlock = findManagedBlock(remote, desired.chainId)?.text ?? null;
  if (normalize(baseBlock) !== normalize(remoteBlock)) {
    return {
      kind: "conflict",
      reason: remoteBlock
        ? "The managed chain block was edited on GitHub since it was last fetched."
        : "The managed chain block was removed on GitHub since it was last fetched.",
      remoteBlock,
      baseBlock,
    };
  }
  return { kind: "rebased", body: next, note: "Description changed on GitHub; only the managed block was updated." };
}

function normalize(s: string | null): string | null {
  return s === null ? null : s.replace(/\r\n/g, "\n").trim();
}
