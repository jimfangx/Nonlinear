/**
 * Nonlinear Cloud (Cloudflare Workers + D1): one-click Connect.
 *
 * Connect = GitHub sign-in through the backend (BFF; the GitHub token stays
 * server-side and API calls go through `${url}/gh`) + automatic end-to-end
 * encryption key setup. No URLs, passphrases or salts to type:
 *   - first device: a random sync key is generated; recovery key offered
 *   - other devices: approve from a connected device (ECDH pairing) or paste
 *     the recovery key
 */
import {
  fromRecoveryKey,
  generateSyncKey,
  makeKeyCheck,
  newPairingKeypair,
  toRecoveryKey,
  unwrapFromApprover,
  verificationCode,
  verifyKeyCheck,
  wrapForDevice,
  type PairingKeypair,
} from "@nonlinear/core";
import { getSecret, setSecret } from "./db";
import { republishAll, useApp } from "./store";
import { resetClient } from "./github";
import { invoke, isDesktop } from "./platform";

/** Build-time default service; self-hosters can override in Settings → Advanced. */
export const DEFAULT_CLOUD_URL: string = (import.meta.env.VITE_NONLINEAR_CLOUD_URL as string | undefined) ?? "";

export function cloudUrl(): string {
  // Tolerate a trailing slash or spaces left while the field is being edited.
  return useApp.getState().settings_().syncUrl.trim().replace(/\/+$/, "") || DEFAULT_CLOUD_URL;
}

let renewing: Promise<string | null> | null = null;
let reconnectStarted = false;
let lastReconnectAt = 0;

/**
 * Exchange the current session (live or recently expired) for a fresh one. Runs once even when
 * many calls hit 401 together. If the server can't renew it, sign in again: on desktop the system
 * browser round-trip happens automatically (GitHub skips the consent screen for an app already
 * authorized); on the web, a toast asks for one click because it navigates away.
 */
export function renewSession(): Promise<string | null> {
  renewing ??= (async () => {
    const old = await getSecret("sync-session");
    const base = cloudUrl();
    if (!old || !base) return null;
    try {
      const r = await fetch(`${base}/auth/refresh`, { method: "POST", headers: { authorization: `Bearer ${old}` } });
      if (r.ok) {
        const { session, login, scopes } = (await r.json()) as { session: string; login: string; scopes: string };
        await setSecret("sync-session", session);
        if (useApp.getState().settings_().authMode === "oauth") await setSecret("github-token", session);
        useApp.getState().setSettings({ me: login, tokenCanWrite: scopes.split(",").includes("public_repo"), lastSyncError: null });
        return session;
      }
      // 401: the server can't renew it. 404: a server without /auth/refresh (older deployment). Otherwise retry later.
      if (r.status !== 401 && r.status !== 404) return null;
    } catch {
      return null; // offline
    }
    void reconnect();
    return null;
  })().finally(() => setTimeout(() => (renewing = null), 5_000));
  return renewing;
}

async function reconnect(): Promise<void> {
  // At most one automatic sign-in per 30 minutes, so an ignored browser tab doesn't keep reopening.
  if (reconnectStarted || Date.now() - lastReconnectAt < 30 * 60_000) return;
  reconnectStarted = true;
  lastReconnectAt = Date.now();
  const st = useApp.getState();
  const writes = st.settings_().tokenCanWrite;
  if (!isDesktop()) {
    st.toast("warn", "Your Nonlinear Cloud sign-in ended. Open Settings → Nonlinear Cloud and click Connect to renew it.");
    return;
  }
  st.toast("info", "Renewing your GitHub sign-in in the browser…");
  try {
    await connect(writes);
    st.toast("success", "Sign-in renewed.");
  } catch (e) {
    st.toast("error", `Couldn't renew the sign-in: ${(e as Error).message}`);
  } finally {
    reconnectStarted = false;
  }
}

/** fetch() against the cloud with the session; renews it and retries once on 401. */
export async function cloudFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const go = (session: string | null) =>
    fetch(`${cloudUrl()}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(session ? { authorization: `Bearer ${session}` } : {}), ...(init.headers ?? {}) },
    });
  const session = (await getSecret("sync-session")) ?? null;
  const r = await go(session);
  if (r.status !== 401 || !session) return r;
  // Renewed meanwhile (by the GitHub client or another window): retry with that one instead of rotating again.
  const stored = (await getSecret("sync-session")) ?? null;
  const fresh = stored && stored !== session ? stored : await renewSession();
  return fresh ? go(fresh) : r;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await cloudFetch(path, init);
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw Object.assign(new Error(j.error ?? `HTTP ${r.status}`), { status: r.status });
  return j;
}

export type CloudState =
  | { kind: "disconnected" }
  | { kind: "needs-key"; login: string }
  | { kind: "pairing"; login: string; code: string }
  | { kind: "connected"; login: string };

function b64url(u: Uint8Array): string {
  let x = "";
  for (const b of u) x += String.fromCharCode(b);
  return btoa(x).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Step 1: send the user to GitHub via the backend.
 *  - Web: same-window redirect; the backend returns a one-time code.
 *  - Desktop: system browser + RFC 8252 loopback + PKCE (no secret in the app,
 *    the webview never shows the GitHub login page).
 */
export async function connect(withWrites: boolean): Promise<CloudState | null> {
  const url = cloudUrl();
  if (!url) throw new Error("No Nonlinear Cloud service is configured for this build.");
  const scope = withWrites ? "public_repo" : "";
  if (!isDesktop()) {
    const ret = location.origin + location.pathname + "#/settings";
    location.href = `${url}/auth/github/start?scope=${scope}&return=${encodeURIComponent(ret)}`;
    return null;
  }
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const clientState = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const port = await invoke<number>("oauth_loopback_start");
  const ret = `http://127.0.0.1:${port}/cb`;
  await invoke("open_external", { url: `${url}/auth/github/start?scope=${scope}&return=${encodeURIComponent(ret)}&code_challenge=${challenge}&client_state=${clientState}` });
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const q = await invoke<string | null>("oauth_loopback_poll");
    if (q) {
      const p = new URLSearchParams(q);
      if (p.get("client_state") !== clientState) throw new Error("Sign-in response did not match this request.");
      if (p.get("nl_error")) throw new Error(signInError(p));
      return finishSession(p.get("nl_code") ?? "", verifier);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Timed out waiting for the browser sign-in.");
}

/** Step 2 (web, on return): exchange the one-time code, then set up encryption. */
export async function completeConnectFromUrl(): Promise<CloudState | null> {
  const params = new URLSearchParams(location.search);
  if (params.get("nl_error")) {
    history.replaceState(null, "", location.pathname + location.hash);
    throw new Error(signInError(params));
  }
  const code = params.get("nl_code");
  if (!code) return null;
  history.replaceState(null, "", location.pathname + location.hash);
  return finishSession(code);
}

function signInError(p: URLSearchParams): string {
  if (p.get("nl_error") === "not_allowed") {
    const who = p.get("nl_login");
    return `This sync server only accepts specific GitHub accounts${who ? `, and @${who} isn't one of them` : ""}. Ask its operator to add you, or deploy your own (see the README).`;
  }
  return `Sign-in failed: ${p.get("nl_error")}`;
}

async function finishSession(code: string, verifier?: string): Promise<CloudState> {
  const r = await fetch(`${cloudUrl()}/auth/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, code_verifier: verifier }) });
  if (!r.ok) throw new Error("Sign-in link expired. Click Connect again.");
  const { session, login, scopes } = (await r.json()) as { session: string; login: string; scopes: string };
  await setSecret("sync-session", session);
  // GitHub calls go through the backend proxy with the session; the token never reaches the app.
  await setSecret("github-token", session);
  const st = useApp.getState();
  st.setSettings({ authMode: "oauth", apiBase: `${cloudUrl()}/gh`, me: login, githubAvatar: null, tokenCanWrite: scopes.split(",").includes("public_repo") });
  resetClient();
  return ensureKey(login);
}

/** Decide whether this device has the account's sync key. */
export async function ensureKey(login: string): Promise<CloudState> {
  const { keycheck } = await api<{ keycheck: string | null }>("/v1/keycheck");
  const local = await getSecret("sync-key");
  if (!keycheck) {
    const key = local ?? generateSyncKey();
    await api("/v1/keycheck", { method: "PUT", body: JSON.stringify({ keycheck: await makeKeyCheck(key) }) });
    // New key: CloudGlue shows the recovery key and asks the user to confirm saving it.
    await activate(key, { saved: false });
    return { kind: "connected", login };
  }
  if (local && (await verifyKeyCheck(local, keycheck))) {
    await activate(local);
    return { kind: "connected", login };
  }
  return { kind: "needs-key", login };
}

async function activate(key: string, opts: { saved?: boolean } = {}): Promise<void> {
  await setSecret("sync-key", key);
  // A key received by pairing or typed in as a recovery key is already saved somewhere; a new one isn't.
  if (opts.saved) useApp.getState().setSettings({ recoveryKeySavedAt: Date.now() });
  else if (opts.saved === false) useApp.getState().setSettings({ recoveryKeySavedAt: null });
  useApp.getState().setSettings({ syncEnabled: true, syncUrl: useApp.getState().settings_().syncUrl || DEFAULT_CLOUD_URL });
}

/** New device: request approval from an already-connected device. */
export async function requestPairing(onApproved: () => void): Promise<{ code: string; cancel: () => void }> {
  const kp: PairingKeypair = await newPairingKeypair();
  const label = `${navigator.platform || "Device"} · ${navigator.userAgent.includes("Firefox") ? "Firefox" : navigator.userAgent.includes("Safari") && !navigator.userAgent.includes("Chrome") ? "Safari" : "Chromium"}`;
  const { id } = await api<{ id: string }>("/v1/pair", { method: "POST", body: JSON.stringify({ devicePub: kp.publicKey, label }) });
  let stopped = false;
  const poll = async () => {
    if (stopped) return;
    try {
      const r = await api<{ status: string; wrapped?: string; approverPub?: string }>(`/v1/pair/${id}`);
      if (r.status === "approved") {
        const key = await unwrapFromApprover(kp, r.wrapped!, r.approverPub!);
        const { keycheck } = await api<{ keycheck: string | null }>("/v1/keycheck");
        if (!keycheck || !(await verifyKeyCheck(key, keycheck))) throw new Error("Received key failed verification");
        await activate(key, { saved: true });
        onApproved();
        return;
      }
    } catch (e) {
      if ((e as { status?: number }).status === 404) return useApp.getState().toast("warn", "Pairing request expired or was denied.");
      if (!(e instanceof Error && e.message.startsWith("HTTP"))) return useApp.getState().toast("error", (e as Error).message);
    }
    setTimeout(() => void poll(), 2500);
  };
  void poll();
  return { code: await verificationCode(kp.publicKey), cancel: () => (stopped = true) };
}

export async function applyRecoveryKey(rk: string): Promise<boolean> {
  const key = fromRecoveryKey(rk);
  if (!key) return false;
  const { keycheck } = await api<{ keycheck: string | null }>("/v1/keycheck");
  if (!keycheck || !(await verifyKeyCheck(key, keycheck))) return false;
  await activate(key, { saved: true });
  return true;
}

/** Lost every device and the recovery key: start over (server deletes old ciphertext). */
export async function resetEncryption(): Promise<{ uploaded: number }> {
  const key = generateSyncKey();
  await api("/v1/keycheck", { method: "PUT", body: JSON.stringify({ keycheck: await makeKeyCheck(key), reset: true }) });
  await setSecret("sync-cursor", "0");
  await activate(key, { saved: false });
  // The server deleted everything encrypted with the old key: upload this device's data under the new one.
  const queued = republishAll();
  const { syncOnce } = await import("./sync");
  let uploaded = 0;
  for (let i = 0; i < 500; i++) {
    const { pushed } = await syncOnce();
    uploaded += pushed;
    if (pushed === 0) break;
  }
  useApp.getState().setSettings({ lastSyncAt: Date.now(), lastSyncError: null });
  return { uploaded: Math.min(uploaded, queued) };
}

export async function recoveryKey(): Promise<string | null> {
  const k = await getSecret("sync-key");
  return k ? toRecoveryKey(k) : null;
}

/* ---------------- approving other devices (runs on connected devices) ---------------- */

export interface PendingPair {
  id: string;
  devicePub: string;
  label: string;
  code: string;
}

export async function pendingPairs(): Promise<PendingPair[]> {
  if (!(await getSecret("sync-key"))) return [];
  const { pending } = await api<{ pending: { id: string; devicePub: string; label: string }[] }>("/v1/pair");
  return Promise.all(pending.map(async (p) => ({ ...p, code: await verificationCode(p.devicePub) })));
}

export async function approvePair(p: PendingPair): Promise<void> {
  const key = await getSecret("sync-key");
  if (!key) throw new Error("This device has no sync key");
  await api(`/v1/pair/${p.id}/approve`, { method: "POST", body: JSON.stringify(await wrapForDevice(key, p.devicePub)) });
}

export async function denyPair(p: PendingPair): Promise<void> {
  await api(`/v1/pair/${p.id}/deny`, { method: "POST" });
}

export async function disconnect(): Promise<void> {
  try {
    await api("/auth/logout", { method: "POST" });
  } catch {
    /* offline: still clear locally */
  }
  for (const k of ["sync-session", "github-token", "sync-key", "sync-cursor"]) await setSecret(k, null);
  useApp.getState().setSettings({ syncEnabled: false, authMode: "anonymous", apiBase: "https://api.github.com", me: null, githubAvatar: null, tokenCanWrite: false });
  resetClient();
}

export async function currentState(): Promise<CloudState> {
  const s = useApp.getState().settings_();
  const session = await getSecret("sync-session");
  if (!session || !cloudUrl()) return { kind: "disconnected" };
  const key = await getSecret("sync-key");
  if (key && s.syncEnabled) return { kind: "connected", login: s.me ?? "" };
  return { kind: "needs-key", login: s.me ?? "" };
}
