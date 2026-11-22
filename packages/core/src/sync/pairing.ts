/**
 * One-click sync keys and device pairing (design §10: "require a recovery key or
 * device-pairing process to decrypt on a new device").
 *
 *  - The first device generates a random 256-bit sync key (no passphrase).
 *  - The recovery key is that key, base32-ish grouped for humans.
 *  - A new device pairs via ECDH P-256: it posts its public key; an existing
 *    device wraps the sync key to it. The server relays only public keys and
 *    ciphertext. Both screens show a short verification code derived from the
 *    new device's public key so users can detect a substituted key.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64u(u: Uint8Array): string {
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64u(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const u = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

export function generateSyncKey(): string {
  return b64u(crypto.getRandomValues(new Uint8Array(32)));
}

/* Recovery keys use Crockford base32 (no '-' in the alphabet, case-insensitive,
   tolerant of I/L→1 and O→0 typos) so dash grouping is unambiguous. */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(s: string): Uint8Array | null {
  const clean = s.toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0");
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** Human-friendly recovery key: `NL1-` + base32 in groups of 4. */
export function toRecoveryKey(syncKey: string): string {
  return `NL1-${base32(unb64u(syncKey)).match(/.{1,4}/g)!.join("-")}`;
}

export function fromRecoveryKey(rk: string): string | null {
  const body = rk.trim().replace(/^NL1-/i, "").replace(/[-\s]/g, "");
  const bytes = unbase32(body);
  return bytes && bytes.length === 32 ? b64u(bytes) : null;
}

export async function importSyncKey(syncKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", unb64u(syncKey), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Salt for opaque entity keys, derived from the sync key (stable across devices). */
export async function syncKeySalt(syncKey: string): Promise<string> {
  return b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`nonlinear-entity-salt:${syncKey}`))));
}

const CHECK = "nonlinear-keycheck-v1";

export async function makeKeyCheck(syncKey: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importSyncKey(syncKey), enc.encode(CHECK)));
  return `${b64u(iv)}.${b64u(ct)}`;
}

export async function verifyKeyCheck(syncKey: string, check: string): Promise<boolean> {
  try {
    const [iv, ct] = check.split(".") as [string, string];
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(iv) }, await importSyncKey(syncKey), unb64u(ct));
    return dec.decode(pt) === CHECK;
  } catch {
    return false;
  }
}

/* ---------------- pairing ---------------- */

export interface PairingKeypair {
  publicKey: string; // raw, b64url
  privateKey: CryptoKey;
}

export async function newPairingKeypair(): Promise<PairingKeypair> {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { publicKey: b64u(raw), privateKey: kp.privateKey };
}

async function sharedKey(priv: CryptoKey, peerPub: string): Promise<CryptoKey> {
  const pub = await crypto.subtle.importKey("raw", unb64u(peerPub), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256);
  const hk = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("nonlinear-pairing-v1"), info: enc.encode("sync-key-wrap") }, hk, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Short code shown on both devices (derived from the new device's public key). */
export async function verificationCode(devicePub: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", unb64u(devicePub)));
  const n = ((h[0]! << 16) | (h[1]! << 8) | h[2]!) % 1_000_000;
  return String(n).padStart(6, "0").replace(/(\d{3})(\d{3})/, "$1 $2");
}

/** Existing device: wrap the sync key for the requesting device. */
export async function wrapForDevice(syncKey: string, devicePub: string): Promise<{ wrapped: string; approverPub: string }> {
  const eph = await newPairingKeypair();
  const k = await sharedKey(eph.privateKey, devicePub);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, enc.encode(syncKey)));
  return { wrapped: `${b64u(iv)}.${b64u(ct)}`, approverPub: eph.publicKey };
}

/** New device: unwrap the sync key. */
export async function unwrapFromApprover(kp: PairingKeypair, wrapped: string, approverPub: string): Promise<string> {
  const k = await sharedKey(kp.privateKey, approverPub);
  const [iv, ct] = wrapped.split(".") as [string, string];
  return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(iv) }, k, unb64u(ct)));
}
