/**
 * Spill-to-disk store for multi-repo diff imports (design §6: "chunked
 * spill-to-disk strategy" for large imports, bounded memory).
 *
 * Used from both the parsing worker and the UI, always via IndexedDB (also in
 * the desktop webview) so a worker can write without round-tripping through
 * the main thread. Layout:
 *   index:<importId>               → MultiRepoDiff with patch text stripped
 *   file:<importId>|<group>|<idx>  → one file's patch section
 */
import { openDB, type IDBPDatabase } from "idb";
import type { MultiRepoDiff } from "@nonlinear/core";

let dbp: Promise<IDBPDatabase> | null = null;
function db(): Promise<IDBPDatabase> {
  dbp ??= openDB("nonlinear-imports", 1, {
    upgrade(d) {
      d.createObjectStore("chunks");
    },
  });
  return dbp;
}

export const fileKey = (id: string, group: string, index: number) => `file:${id}|${group}|${index}`;

/** Write every file section + the stripped index in one transaction. Returns the stripped diff. */
export async function spillImport(diff: MultiRepoDiff): Promise<MultiRepoDiff> {
  const d = await db();
  const tx = d.transaction("chunks", "readwrite");
  const writes: Promise<unknown>[] = [];
  for (const g of diff.groups) {
    for (const f of g.index.files) writes.push(tx.store.put(g.patch.slice(f.start, f.end), fileKey(diff.id, g.path, f.index)));
  }
  const stripped: MultiRepoDiff = { ...diff, groups: diff.groups.map((g) => ({ ...g, patch: "" })) };
  writes.push(tx.store.put(JSON.stringify(stripped), `index:${diff.id}`));
  await Promise.all(writes);
  await tx.done;
  return stripped;
}

export async function loadIndex(id: string): Promise<MultiRepoDiff | null> {
  const raw = (await (await db()).get("chunks", `index:${id}`)) as string | undefined;
  return raw ? (JSON.parse(raw) as MultiRepoDiff) : null;
}

const lru = new Map<string, string>();
export async function loadFileSection(id: string, group: string, index: number): Promise<string> {
  const k = fileKey(id, group, index);
  const hit = lru.get(k);
  if (hit !== undefined) return hit;
  const v = ((await (await db()).get("chunks", k)) as string | undefined) ?? "";
  lru.set(k, v);
  if (lru.size > 32) lru.delete(lru.keys().next().value!);
  return v;
}

/** Async content search over spilled sections; yields to the UI between batches. */
export async function searchContent(id: string, q: string, signal: { cancelled: boolean }): Promise<Set<string>> {
  const out = new Set<string>();
  const needle = q.toLowerCase();
  const d = await db();
  const range = IDBKeyRange.bound(`file:${id}|`, `file:${id}|￿`);
  let cursor = await d.transaction("chunks").store.openCursor(range);
  let n = 0;
  while (cursor && !signal.cancelled) {
    if ((cursor.value as string).toLowerCase().includes(needle)) out.add((cursor.key as string).slice(5 + id.length + 1));
    cursor = await cursor.continue();
    if (++n % 200 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

export async function deleteImport(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction("chunks", "readwrite");
  await tx.store.delete(IDBKeyRange.bound(`file:${id}|`, `file:${id}|￿`));
  await tx.store.delete(`index:${id}`);
  await tx.done;
}
