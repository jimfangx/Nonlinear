/**
 * Optional encrypted sync with the Workers+D1 backend (§10). Local writes are
 * never blocked by sync. The server only sees opaque entity keys + ciphertext.
 * Secrets and code caches are never uploaded.
 */
import { decryptOp, encryptOp, importSyncKey, referencesPrivateRepo, syncKeySalt, type EncryptedOp, type Op } from "@nonlinear/core";
import { deleteRecord, getSecret, outboxAll, outboxRemove, putRecord, setSecret } from "./db";
import { useApp, COLLECTIONS, type CollectionName, type SyncConflict } from "./store";
import { DEFAULT_CLOUD_URL } from "./cloud";

let keyCache: { raw: string; key: CryptoKey; salt: string } | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let backoff = 0;

/** Collections whose concurrent edits require explicit resolution (§10). */
const STRICT = new Set(["pins", "localEdges", "chains"]);

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== "updatedAt").sort(([a], [b]) => a.localeCompare(b))) : x));
}

async function applyRemote(coll: string, id: string, value: unknown): Promise<void> {
  if (value === null) {
    useApp.setState((x) => {
      const copy = { ...(x as unknown as Record<string, Record<string, unknown>>)[coll] };
      delete copy[id];
      return { [coll]: copy } as never;
    });
    await deleteRecord(coll, id);
  } else {
    useApp.setState((x) => ({ [coll]: { ...(x as unknown as Record<string, Record<string, unknown>>)[coll], [id]: value } }) as never);
    await putRecord(coll, id, value);
  }
}

/** Resolve a conflict explicitly. "mine" re-publishes the local value; "theirs" adopts the remote one. */
export async function resolveConflict(key: string, choice: "mine" | "theirs"): Promise<void> {
  const st = useApp.getState();
  const c = st.syncConflicts[key];
  if (!c) return;
  st.putMany("syncBase", [[key, stable(c.remote)]]);
  if (choice === "theirs") {
    const pending = (await outboxAll<Op>()).filter((o) => o.entityId === key).map((o) => o.opId);
    await outboxRemove(pending);
    await applyRemote(c.collection, c.id, c.remote);
  } else if (c.local === null) {
    st.remove(c.collection as CollectionName, c.id);
  } else {
    st.put(c.collection as CollectionName, c.id, { ...(c.local as object), updatedAt: Date.now() } as never);
  }
  st.remove("syncConflicts", key);
}

async function key(): Promise<{ key: CryptoKey; salt: string } | null> {
  const raw = await getSecret("sync-key");
  if (!raw) return null;
  if (keyCache?.raw !== raw) keyCache = { raw, key: await importSyncKey(raw), salt: await syncKeySalt(raw) };
  return keyCache;
}

export async function syncOnce(): Promise<{ pushed: number; pulled: number }> {
  const st = useApp.getState();
  const s = st.settings_();
  const base = s.syncUrl || DEFAULT_CLOUD_URL;
  if (!s.syncEnabled || !base) return { pushed: 0, pulled: 0 };
  const k = await key();
  if (!k) throw new Error("This device is not paired yet");
  const session = await getSecret("sync-session");
  const headers = { "content-type": "application/json", ...(session ? { authorization: `Bearer ${session}` } : {}) };
  const isPrivate = (r: string) => !!st.repos[r]?.private;

  // 1) pull first so remote ops based on an older state are judged against our *unpushed* edits
  const cursor = (await getSecret("sync-cursor")) ?? "0";
  const r = await fetch(`${base}/v1/ops?since=${encodeURIComponent(cursor)}&device=${encodeURIComponent(s.deviceId)}`, { headers });
  if (!r.ok) throw new Error(`Sync pull failed: HTTP ${r.status}`);
  const { ops: remote, cursor: next } = (await r.json()) as { ops: EncryptedOp[]; cursor: string };
  let pulled = 0;
  for (const e of remote) {
    if (e.deviceId === s.deviceId) continue;
    try {
      const op = await decryptOp(e, k.key);
      const [coll, ...rest] = op.entityId.split(":");
      const id = rest.join(":");
      if (!(coll! in COLLECTIONS) || !COLLECTIONS[coll as CollectionName].synced) continue;
      const state = useApp.getState() as unknown as Record<string, Record<string, unknown>>;
      const cur = state[coll!]?.[id];
      const remoteVal = op.action === "delete" ? null : op.action === "patch" && cur ? { ...(cur as object), ...(op.payload ?? {}) } : op.payload;
      if (STRICT.has(coll!)) {
        // 3-way: base (last agreed) vs local vs remote — never silent LWW (§10)
        const bkey = `${coll}:${id}`;
        const baseStr = useApp.getState().syncBase[bkey] ?? "null";
        const localStr = stable(cur ?? null);
        const remoteStr = stable(remoteVal);
        if (remoteStr === localStr) {
          useApp.getState().putMany("syncBase", [[bkey, remoteStr]]);
          continue;
        }
        if (localStr !== baseStr) {
          useApp.getState().putMany("syncConflicts", [[bkey, { key: bkey, collection: coll!, id, base: JSON.parse(baseStr), local: cur ?? null, remote: remoteVal, remoteDevice: op.deviceId, at: Date.now() } satisfies SyncConflict]]);
          continue;
        }
        useApp.getState().putMany("syncBase", [[bkey, remoteStr]]);
      }
      await applyRemote(coll!, id, remoteVal);
      pulled++;
    } catch {
      /* undecryptable (different key) — skip */
    }
  }

  // 2) push, holding back ops for entities with unresolved conflicts
  const conflicts = useApp.getState().syncConflicts;
  const all = await outboxAll<Op & { collection: string }>();
  const ops = all.filter((o) => !conflicts[o.entityId]).slice(0, 200);
  const safe = ops.filter((o) => !(s.publicOnly && referencesPrivateRepo(o.payload, isPrivate)));
  const enc = await Promise.all(safe.map((o) => encryptOp(o, k.key, k.salt)));
  if (enc.length) {
    const pr = await fetch(`${base}/v1/ops`, { method: "POST", headers, body: JSON.stringify({ ops: enc }) });
    if (!pr.ok) throw new Error(`Sync push failed: HTTP ${pr.status}`);
  }
  await outboxRemove(ops.map((o) => o.opId));
  const st2 = useApp.getState() as unknown as Record<string, Record<string, unknown>>;
  const bases: [string, string][] = [];
  for (const o of safe) {
    if (!STRICT.has(o.collection)) continue;
    const [coll, ...rest] = o.entityId.split(":");
    bases.push([o.entityId, stable(st2[coll!]?.[rest.join(":")] ?? null)]);
  }
  if (bases.length) useApp.getState().putMany("syncBase", bases);
  await setSecret("sync-cursor", next);
  return { pushed: enc.length, pulled };
}

export function startSyncLoop(): () => void {
  const tick = async () => {
    const st = useApp.getState();
    const s = st.settings_();
    if (!s.syncEnabled || !st.online) return;
    if (backoff > 0) {
      backoff--;
      return;
    }
    try {
      await syncOnce();
      st.setSettings({ lastSyncAt: Date.now(), lastSyncError: null });
    } catch (e) {
      backoff = Math.min(10, (backoff || 1) * 2);
      st.setSettings({ lastSyncError: (e as Error).message });
    }
  };
  timer = setInterval(() => void tick(), 30_000);
  void tick();
  return () => {
    if (timer) clearInterval(timer);
  };
}
