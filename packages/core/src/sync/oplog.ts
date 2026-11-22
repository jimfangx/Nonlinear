/**
 * Append-only operation log for optional encrypted multi-device sync (§10).
 *
 * Local store is authoritative for UX; ops are published to the cloud as
 * encrypted payloads. Merge policy by entity kind:
 *   - prefs, cards (simple fields): field-level LWW by (timestamp, deviceId)
 *   - kanban placements: per-context, last writer wins on (column, rank)
 *   - chain ordering, release pins: 3-way; conflicts surfaced, never LWW
 *   - notes / AI caches: content-addressed; keep both on divergence
 */

export type EntityKind =
  | "view"
  | "release"
  | "release-pin"
  | "card"
  | "placement"
  | "note"
  | "review"
  | "chain-edge"
  | "pref"
  | "timeline";

export interface Op {
  opId: string;
  userId: string;
  deviceId: string;
  entityKind: EntityKind;
  entityId: string;
  /** revision of the entity this op was based on (for 3-way checks) */
  baseRevision: number;
  timestamp: number;
  /** set → full replacement, patch → field merge, delete → tombstone */
  action: "set" | "patch" | "delete";
  payload: Record<string, unknown> | null;
  schemaVersion: number;
}

export interface EncryptedOp extends Omit<Op, "payload" | "entityKind" | "entityId"> {
  /** server sees opaque ids: hash(entityKind:entityId) */
  entityKey: string;
  ciphertext: string; // base64(iv|ct) of JSON { entityKind, entityId, payload }
}

export interface EntityRecord {
  kind: EntityKind;
  id: string;
  revision: number;
  value: Record<string, unknown> | null; // null = tombstone
  fieldClock: Record<string, [number, string]>; // field -> (ts, device)
  lastOp: string;
}

export interface Conflict {
  kind: EntityKind;
  id: string;
  local: Op | null;
  remote: Op;
  reason: string;
}

const STRICT: Set<EntityKind> = new Set(["release-pin", "chain-edge"]);

function newer(a: [number, string], b: [number, string] | undefined): boolean {
  if (!b) return true;
  return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
}

export class OpStore {
  readonly entities = new Map<string, EntityRecord>();
  readonly applied = new Set<string>();
  readonly conflicts: Conflict[] = [];
  /** ops produced locally not yet acknowledged by the server */
  outbox: Op[] = [];

  key(kind: EntityKind, id: string): string {
    return `${kind}:${id}`;
  }

  get(kind: EntityKind, id: string): EntityRecord | undefined {
    return this.entities.get(this.key(kind, id));
  }

  /** Apply an op (local or remote). Idempotent by opId. */
  apply(op: Op, opts: { remote?: boolean; pendingLocal?: Op[] } = {}): "applied" | "duplicate" | "conflict" {
    if (this.applied.has(op.opId)) return "duplicate";
    const k = this.key(op.entityKind, op.entityId);
    const cur = this.entities.get(k);

    if (opts.remote && STRICT.has(op.entityKind) && cur && cur.revision !== op.baseRevision) {
      const local = (opts.pendingLocal ?? this.outbox).find((o) => o.entityKind === op.entityKind && o.entityId === op.entityId) ?? null;
      if (local && local.opId !== op.opId) {
        const sameValue = JSON.stringify(local.payload) === JSON.stringify(op.payload) && local.action === op.action;
        if (!sameValue) {
          this.conflicts.push({ kind: op.entityKind, id: op.entityId, local, remote: op, reason: "Concurrent edits to an entity that requires explicit resolution" });
          this.applied.add(op.opId);
          return "conflict";
        }
      }
    }

    const rec: EntityRecord = cur ?? { kind: op.entityKind, id: op.entityId, revision: 0, value: {}, fieldClock: {}, lastOp: "" };
    const clock: [number, string] = [op.timestamp, op.deviceId];
    if (op.action === "delete") {
      // Tombstone wins over earlier field edits but not over later ones.
      const latest = Object.values(rec.fieldClock).reduce<[number, string] | undefined>((m, c) => (newer(c, m) ? c : m), undefined);
      if (!latest || newer(clock, latest)) rec.value = null;
      rec.fieldClock["__deleted"] = clock;
    } else if (op.action === "set") {
      const prev = rec.fieldClock["__set"];
      if (newer(clock, prev)) {
        rec.value = { ...(op.payload ?? {}) };
        rec.fieldClock = { __set: clock };
        for (const f of Object.keys(op.payload ?? {})) rec.fieldClock[f] = clock;
      }
    } else {
      const v = rec.value ?? {};
      for (const [f, val] of Object.entries(op.payload ?? {})) {
        if (newer(clock, rec.fieldClock[f])) {
          v[f] = val;
          rec.fieldClock[f] = clock;
        }
      }
      const del = rec.fieldClock["__deleted"];
      rec.value = del && !newer(clock, del) ? null : v;
    }
    rec.revision += 1;
    rec.lastOp = op.opId;
    this.entities.set(k, rec);
    this.applied.add(op.opId);
    return "applied";
  }

  local(op: Op): void {
    this.apply(op);
    this.outbox.push(op);
  }

  ack(opIds: string[]): void {
    const s = new Set(opIds);
    this.outbox = this.outbox.filter((o) => !s.has(o.opId));
  }
}

/* ------------------------------------------------------------------ */
/* Client-side encryption (WebCrypto AES-GCM).                         */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(buf: ArrayBuffer | Uint8Array): string {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const u = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

/** Derive a sync key from a recovery passphrase (PBKDF2-SHA256, 310k iterations). */
export async function deriveKey(passphrase: string, saltB64: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: unb64(saltB64), iterations: 310_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function newSalt(): string {
  return b64(crypto.getRandomValues(new Uint8Array(16)));
}

export async function entityKey(kind: EntityKind, id: string, userSalt: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", enc.encode(`${userSalt}:${kind}:${id}`));
  return b64(h).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]!);
}

export async function encryptOp(op: Op, key: CryptoKey, userSalt: string): Promise<EncryptedOp> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = enc.encode(JSON.stringify({ entityKind: op.entityKind, entityId: op.entityId, action: op.action, payload: op.payload }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, body));
  const joined = new Uint8Array(iv.length + ct.length);
  joined.set(iv);
  joined.set(ct, iv.length);
  const { payload: _p, entityKind, entityId, ...rest } = op;
  void _p;
  return { ...rest, entityKey: await entityKey(entityKind, entityId, userSalt), ciphertext: b64(joined) };
}

export async function decryptOp(e: EncryptedOp, key: CryptoKey): Promise<Op> {
  const raw = unb64(e.ciphertext);
  const iv = raw.slice(0, 12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, raw.slice(12));
  const { entityKind, entityId, action, payload } = JSON.parse(dec.decode(pt)) as Pick<Op, "entityKind" | "entityId" | "action" | "payload">;
  const { entityKey: _k, ciphertext: _c, ...rest } = e;
  void _k;
  void _c;
  return { ...rest, entityKind, entityId, action, payload };
}

/** Public-only guard (§10): refuse to sync records that reference private repos. */
export function referencesPrivateRepo(payload: unknown, isPrivate: (repoKey: string) => boolean): boolean {
  const s = JSON.stringify(payload ?? null);
  for (const m of s.matchAll(/"([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)(?:#\d+)?"/g)) if (isPrivate(m[1]!.toLowerCase())) return true;
  return false;
}
