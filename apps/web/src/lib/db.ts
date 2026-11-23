/**
 * Local persistence (design §9 Web): IndexedDB. Writes are durable immediately;
 * cloud sync is optional and never blocks local writes.
 *
 * Stores:
 *   records  — user-owned + cached entities, key = `${collection}:${id}`
 *   blobs    — large content-addressed text (imported diffs, PR patches)
 *   secrets  — tokens / provider keys (never synced)
 *   outbox   — sync ops awaiting upload
 */
import { openDB, type IDBPDatabase } from "idb";
import { isDesktop, invoke } from "./platform";

/** Desktop (Tauri): records/blobs/outbox live in SQLite (WAL) in the Rust core; secrets in the OS keychain. */
const native = (): boolean => isDesktop();

export const DB_NAME = "nonlinear";
export const DB_VERSION = 1;

let dbp: Promise<IDBPDatabase> | null = null;

export function db(): Promise<IDBPDatabase> {
  dbp ??= openDB(DB_NAME, DB_VERSION, {
    upgrade(d) {
      if (!d.objectStoreNames.contains("records")) {
        const s = d.createObjectStore("records");
        s.createIndex("collection", "collection");
      }
      if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs");
      if (!d.objectStoreNames.contains("secrets")) d.createObjectStore("secrets");
      if (!d.objectStoreNames.contains("outbox")) d.createObjectStore("outbox", { keyPath: "opId" });
    },
  });
  return dbp;
}

export interface StoredRecord<T = unknown> {
  collection: string;
  id: string;
  value: T;
  updatedAt: number;
}

export async function loadAll(): Promise<StoredRecord[]> {
  if (native()) return invoke<StoredRecord[]>("db_load_all");
  const d = await db();
  return (await d.getAll("records")) as StoredRecord[];
}

export async function putRecord(collection: string, id: string, value: unknown): Promise<void> {
  if (native()) return invoke("db_put", { collection, id, value });
  const d = await db();
  await d.put("records", { collection, id, value, updatedAt: Date.now() } satisfies StoredRecord, `${collection}:${id}`);
}

export async function restoreRecords(records: StoredRecord[], blobs: [string, string][]): Promise<void> {
  if (native()) return invoke("db_restore", { records, blobs });
  const tx = (await db()).transaction(["records", "blobs"], "readwrite");
  await Promise.all([
    ...records.map((record) => tx.objectStore("records").put(record, `${record.collection}:${record.id}`)),
    ...blobs.map(([key, value]) => tx.objectStore("blobs").put(value, key)),
    tx.done,
  ]);
}

export async function deleteRecord(collection: string, id: string): Promise<void> {
  if (native()) return invoke("db_delete", { collection, id });
  const d = await db();
  await d.delete("records", `${collection}:${id}`);
}

export async function putBlob(key: string, text: string): Promise<void> {
  if (native()) return invoke("blob_put", { key, value: text });
  await (await db()).put("blobs", text, key);
}

export async function getBlob(key: string): Promise<string | undefined> {
  if (native()) return (await invoke<string | null>("blob_get", { key })) ?? undefined;
  return (await (await db()).get("blobs", key)) as string | undefined;
}

export async function deleteBlob(key: string): Promise<void> {
  if (native()) return invoke("blob_delete", { key });
  await (await db()).delete("blobs", key);
}

export async function getSecret(key: string): Promise<string | undefined> {
  if (native()) return (await invoke<string | null>("keychain_get", { key })) ?? undefined;
  return (await (await db()).get("secrets", key)) as string | undefined;
}

export async function setSecret(key: string, value: string | null): Promise<void> {
  if (native()) return invoke("keychain_set", { key, value });
  const d = await db();
  if (value === null) await d.delete("secrets", key);
  else await d.put("secrets", value, key);
}

export async function outboxAdd(op: { opId: string }): Promise<void> {
  if (native()) return invoke("outbox_add", { op });
  await (await db()).put("outbox", op);
}

export async function outboxAll<T>(): Promise<T[]> {
  if (native()) return invoke<T[]>("outbox_all");
  return (await (await db()).getAll("outbox")) as T[];
}

export async function outboxRemove(ids: string[]): Promise<void> {
  if (native()) return invoke("outbox_remove", { ids });
  const d = await db();
  const tx = d.transaction("outbox", "readwrite");
  await Promise.all(ids.map((id) => tx.store.delete(id)));
  await tx.done;
}

export async function wipeAll(): Promise<void> {
  if (native()) return invoke("db_wipe");
  const d = await db();
  for (const s of ["records", "blobs", "outbox"] as const) await d.clear(s);
}

export interface EraseReport {
  removed: string[];
  bytes: number;
  errors: string[];
}

/**
 * Erase everything Nonlinear stores on this device: records, blobs, the outbox,
 * browser storage, and on desktop the SQLite file (compacted), repo mirrors,
 * worktrees, timeline caches, the webview cache and an older build's folder.
 * `secretKeys` (tokens, API keys) are removed too when given. The user's own
 * working trees are never touched.
 */
export async function eraseEverything(opts: { secretKeys: string[]; localRepos: string[] }): Promise<EraseReport> {
  let report: EraseReport = { removed: [], bytes: 0, errors: [] };
  if (native()) {
    report = await invoke<EraseReport>("data_wipe_all", { secretKeys: opts.secretKeys, localRepos: opts.localRepos });
  } else {
    const d = await db();
    for (const s of ["records", "blobs", "outbox"] as const) await d.clear(s);
    report.removed.push("IndexedDB records, blobs and outbox");
    if (opts.secretKeys.length) {
      await d.clear("secrets");
      report.removed.push("saved tokens and keys");
    }
  }
  try {
    const n = localStorage.length + sessionStorage.length;
    localStorage.clear();
    sessionStorage.clear();
    report.removed.push(`browser storage (${n} entries)`);
  } catch (error) {
    report.errors.push(`browser storage: ${String(error)}`);
  }
  return report;
}
