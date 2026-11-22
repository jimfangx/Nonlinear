import {
  indexPatch,
  parseFileHunks,
  parsePRKey,
  rowSignatures,
  remapFileState,
  emptyFileState,
  relocateAnchor,
  type DiffFileEntry,
  type FileReviewState,
  type PRReviewProgress,
  type ParsedPatchIndex,
  type PRSnapshot,
} from "@nonlinear/core";
import { getBlob, putBlob } from "./db";
import { githubApi } from "./github";
import { useApp } from "./store";

export interface LoadedDiff {
  headSha: string;
  baseSha: string;
  text: string;
  index: ParsedPatchIndex;
}

const mem = new Map<string, LoadedDiff>();

/** Content-addressed by head/base SHA: immutable, safe to cache forever (§5.5). */
export async function loadPRDiff(pr: PRSnapshot): Promise<LoadedDiff> {
  const key = `prdiff:${pr.key}:${pr.baseSha}:${pr.headSha}`;
  const m = mem.get(key);
  if (m) return m;
  let text = await getBlob(key);
  if (text === undefined) {
    const r = parsePRKey(pr.key)!;
    text = await (await githubApi()).pullDiff(r.owner, r.repo, r.number);
    await putBlob(key, text);
  }
  const d = { headSha: pr.headSha, baseSha: pr.baseSha, text, index: indexPatch(text) };
  mem.set(key, d);
  return d;
}

export function fileSectionOf(d: LoadedDiff, f: DiffFileEntry): string {
  return d.text.slice(f.start, f.end);
}

/** Last diff we reviewed for a PR (to remap progress when head changes). */
export async function previousDiffText(prKey: string, baseSha: string, headSha: string): Promise<string | undefined> {
  return getBlob(`prdiff:${prKey}:${baseSha}:${headSha}`);
}

export function progressKey(prKey: string): string {
  return prKey;
}

export function getProgress(pr: PRSnapshot): PRReviewProgress | undefined {
  return useApp.getState().reviews[progressKey(pr.key)];
}

export function fileState(p: PRReviewProgress | undefined, f: DiffFileEntry, section: string): FileReviewState {
  const existing = p?.files[f.path];
  if (existing) return existing;
  const rows = parseFileHunks(section).reduce((n, h) => n + h.lines.length, 0);
  return emptyFileState(f.path, rows, f.newOid);
}

export function saveFileState(pr: PRSnapshot, s: FileReviewState): void {
  const st = useApp.getState();
  const cur = st.reviews[progressKey(pr.key)] ?? { prKey: pr.key, headSha: pr.headSha, baseSha: pr.baseSha, phase: "active" as const, files: {}, updatedAt: Date.now() };
  st.put("reviews", progressKey(pr.key), { ...cur, files: { ...cur.files, [s.path]: s }, updatedAt: Date.now() });
}

/**
 * Head SHA changed since the user last reviewed: remap every file's progress
 * using content matching (§5.3). Returns a summary for display.
 */
export async function remapIfHeadChanged(pr: PRSnapshot, now: LoadedDiff): Promise<{ remapped: number; stale: number; orphanedNotes: number } | null> {
  const st = useApp.getState();
  const p = st.reviews[progressKey(pr.key)];
  if (!p || p.headSha === pr.headSha) return null;
  const prevText = await previousDiffText(pr.key, p.baseSha, p.headSha);
  const prevIndex = prevText ? indexPatch(prevText) : null;
  const files: Record<string, FileReviewState> = {};
  let stale = 0;
  for (const f of now.index.files) {
    const old = p.files[f.path] ?? (f.oldPath ? p.files[f.oldPath] : undefined);
    const section = fileSectionOf(now, f);
    const nextSigs = rowSignatures(parseFileHunks(section));
    if (!old) continue;
    const pf = prevIndex?.files.find((x) => x.path === old.path);
    const prevSigs = pf && prevText ? rowSignatures(parseFileHunks(prevText.slice(pf.start, pf.end))) : [];
    const r = remapFileState({ ...old, path: f.path }, prevSigs, nextSigs, f.newOid);
    files[f.path] = r.state;
    stale += r.staleRows;
  }
  // Notes: remap anchors by content; orphan when not found.
  let orphaned = 0;
  for (const n of Object.values(st.notes).filter((n) => n.prKey === pr.key && n.headSha !== pr.headSha)) {
    if (!n.anchor) {
      st.put("notes", n.id, { ...n, headSha: pr.headSha });
      continue;
    }
    const f = now.index.files.find((x) => x.path === n.anchor!.path);
    const texts = f ? parseFileHunks(fileSectionOf(now, f)).flatMap((h) => h.lines.map((l) => l.text)) : [];
    const loc = relocateAnchor(n.anchor, texts);
    if (loc) st.put("notes", n.id, { ...n, headSha: pr.headSha, anchor: { ...n.anchor, rows: loc }, orphaned: false });
    else {
      orphaned++;
      st.put("notes", n.id, { ...n, orphaned: true });
    }
  }
  st.put("reviews", progressKey(pr.key), { ...p, headSha: pr.headSha, baseSha: pr.baseSha, files, updatedAt: Date.now() });
  return { remapped: Object.keys(files).length, stale, orphanedNotes: orphaned };
}

/** Extract old/new gitlink SHAs from a submodule file section. */
export function gitlinkShas(section: string): { oldSha: string | null; newSha: string | null } {
  const o = /^-Subproject commit ([0-9a-f]{7,40})/m.exec(section);
  const n = /^\+Subproject commit ([0-9a-f]{7,40})/m.exec(section);
  return { oldSha: o?.[1] ?? null, newSha: n?.[1] ?? null };
}
