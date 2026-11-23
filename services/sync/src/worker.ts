/**
 * Nonlinear sync + auth backend (design §8, §10).
 *
 *  - OAuth App sign-in (authorization-code flow) as a BFF: the client secret and
 *    the user's GitHub token stay server-side (token encrypted with TOKEN_KEY).
 *    Scopes are limited to "" (read public) or "public_repo"; never `repo`.
 *  - /gh/*  : bounded proxy to api.github.com that swaps the session for the token.
 *  - /v1/ops: append-only, idempotent, end-to-end encrypted op log with a cursor.
 *  - Not a privileged org agent; holds no org credentials.
 */

export interface Env {
  DB: D1Database;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  TOKEN_KEY: string;
  ALLOWED_ORIGINS: string;
  /** Comma-separated GitHub logins allowed to sign in. Empty or unset: any GitHub account. */
  ALLOWED_USERS?: string;
  /** test hook */
  GITHUB_API?: string;
  GITHUB_WEB?: string;
}

const SESSION_TTL_MS = 12 * 3600_000;
const MAX_OPS_PER_PUSH = 200;
const MAX_CIPHERTEXT = 64 * 1024;
const MAX_PROXY_BODY = 1024 * 1024;
const ALLOWED_SCOPES = new Set(["", "public_repo"]);

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ------------------------------ helpers ------------------------------ */

function b64(u: Uint8Array): string {
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
function randomToken(bytes = 32): string {
  return b64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]!);
}
async function sha256(s: string): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}
async function aesKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", unb64(env.TOKEN_KEY), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(env: Env, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(env), enc.encode(plaintext)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64(out);
}
async function open(env: Env, sealed: string): Promise<string> {
  const raw = unb64(sealed);
  return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, await aesKey(env), raw.slice(12)));
}

function origins(env: Env): string[] {
  return env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
}
/** Is this GitHub login allowed on this server? (ALLOWED_USERS; empty = everyone) */
export function userAllowed(env: Env, login: string | null | undefined): boolean {
  const list = (env.ALLOWED_USERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length === 0 || (!!login && list.includes(login.toLowerCase()));
}
function cors(env: Env, req: Request): Record<string, string> {
  const o = req.headers.get("origin");
  if (!o || !origins(env).includes(o)) return {};
  return {
    "access-control-allow-origin": o,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization,content-type,accept,x-github-api-version,if-none-match",
    "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "access-control-expose-headers": "x-ratelimit-limit,x-ratelimit-remaining,x-ratelimit-reset,etag",
    vary: "origin",
  };
}
function json(env: Env, req: Request, status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors(env, req), ...extra } });
}
function allowedReturn(env: Env, url: string): boolean {
  try {
    const u = new URL(url);
    // RFC 8252 §7.3: native apps may use a loopback redirect on any port.
    if (u.protocol === "http:" && u.hostname === "127.0.0.1" && u.pathname === "/cb") return true;
    return origins(env).includes(u.origin);
  } catch {
    return false;
  }
}

interface Session {
  userId: number;
  token: string;
  scopes: string;
}

async function session(env: Env, req: Request): Promise<Session | null> {
  const auth = req.headers.get("authorization") ?? "";
  const cookie = /(?:^|;\s*)nl_session=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
  let secret: string | null = null;
  if (auth.startsWith("Bearer ")) secret = auth.slice(7);
  else if (cookie) {
    // Cookie auth requires CSRF double-submit for unsafe methods.
    if (req.method !== "GET" && req.method !== "HEAD") {
      const csrf = /(?:^|;\s*)nl_csrf=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
      if (!csrf || req.headers.get("x-nonlinear-csrf") !== csrf) return null;
    }
    secret = cookie;
  }
  if (!secret) return null;
  const row = await env.DB.prepare("SELECT s.user_id, s.token_ct, s.scopes, s.expires_at, u.login FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?").bind(await sha256(secret)).first<{ user_id: number; token_ct: string; scopes: string; expires_at: number; login: string }>();
  if (!row || row.expires_at < Date.now()) return null;
  // Removing someone from ALLOWED_USERS cuts off their existing sessions too.
  if (!userAllowed(env, row.login)) return null;
  return { userId: row.user_id, token: await open(env, row.token_ct), scopes: row.scopes };
}

/* ------------------------------ handlers ------------------------------ */

async function authStart(env: Env, req: Request, url: URL): Promise<Response> {
  const scope = url.searchParams.get("scope") ?? "";
  const ret = url.searchParams.get("return") ?? "";
  if (!ALLOWED_SCOPES.has(scope)) return json(env, req, 400, { error: "Only read-only or public_repo scopes are allowed" });
  if (!allowedReturn(env, ret)) return json(env, req, 400, { error: "Return URL origin not allowed" });
  const challenge = url.searchParams.get("code_challenge");
  const clientState = url.searchParams.get("client_state");
  if (challenge !== null && !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return json(env, req, 400, { error: "invalid code_challenge (S256, base64url)" });
  if (new URL(ret).hostname === "127.0.0.1" && !challenge) return json(env, req, 400, { error: "Loopback redirects require PKCE" });
  const state = randomToken();
  await env.DB.prepare("INSERT INTO oauth_states (state, scope, return_url, expires_at, code_challenge, client_state) VALUES (?, ?, ?, ?, ?, ?)").bind(state, scope, ret, Date.now() + 10 * 60_000, challenge, clientState ? clientState.slice(0, 64) : null).run();
  const gh = new URL(`${env.GITHUB_WEB ?? "https://github.com"}/login/oauth/authorize`);
  gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  gh.searchParams.set("redirect_uri", `${url.origin}/auth/github/callback`);
  gh.searchParams.set("scope", scope);
  gh.searchParams.set("state", state);
  gh.searchParams.set("allow_signup", "false");
  return Response.redirect(gh.toString(), 302);
}

async function authCallback(env: Env, req: Request, url: URL): Promise<Response> {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return json(env, req, 400, { error: "missing code/state" });
  const st = await env.DB.prepare("SELECT scope, return_url, expires_at, code_challenge, client_state FROM oauth_states WHERE state = ?").bind(state).first<{ scope: string; return_url: string; expires_at: number; code_challenge: string | null; client_state: string | null }>();
  await env.DB.prepare("DELETE FROM oauth_states WHERE state = ?").bind(state).run();
  if (!st || st.expires_at < Date.now()) return json(env, req, 400, { error: "invalid or expired state" });

  const tokRes = await fetch(`${env.GITHUB_WEB ?? "https://github.com"}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${url.origin}/auth/github/callback` }),
  });
  const tok = (await tokRes.json()) as { access_token?: string; scope?: string; error?: string };
  if (!tok.access_token) return json(env, req, 400, { error: tok.error ?? "token exchange failed" });
  const granted = (tok.scope ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (granted.some((s) => s === "repo" || s.startsWith("admin"))) return json(env, req, 400, { error: "Refusing over-scoped token" });

  const me = (await (await fetch(`${env.GITHUB_API ?? "https://api.github.com"}/user`, { headers: { authorization: `Bearer ${tok.access_token}`, "user-agent": "nonlinear-sync", accept: "application/vnd.github+json" } })).json()) as { id: number; login: string };
  if (!userAllowed(env, me.login)) {
    // Not on this server's list: drop the GitHub grant (best effort) and tell the app, without creating a session.
    await fetch(`${env.GITHUB_API ?? "https://api.github.com"}/applications/${env.GITHUB_CLIENT_ID}/grant`, {
      method: "DELETE",
      headers: { authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`, "content-type": "application/json", "user-agent": "nonlinear-sync" },
      body: JSON.stringify({ access_token: tok.access_token }),
    }).catch(() => undefined);
    const back = new URL(st.return_url);
    back.searchParams.set("nl_error", "not_allowed");
    back.searchParams.set("nl_login", String(me.login ?? ""));
    if (st.client_state) back.searchParams.set("client_state", st.client_state);
    return Response.redirect(back.toString(), 302);
  }
  await env.DB.prepare("INSERT INTO users (id, login, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET login = excluded.login").bind(me.id, me.login, Date.now()).run();

  const secret = randomToken();
  await env.DB.prepare("INSERT INTO sessions (id_hash, user_id, token_ct, scopes, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256(secret), me.id, await seal(env, tok.access_token), granted.join(","), Date.now() + SESSION_TTL_MS, Date.now())
    .run();
  // One-time code → client exchanges it for the session (never put the session itself in a URL).
  const oneTime = randomToken();
  await env.DB.prepare("INSERT INTO login_codes (code_hash, session, expires_at, code_challenge) VALUES (?, ?, ?, ?)").bind(await sha256(oneTime), await seal(env, secret), Date.now() + 60_000, st.code_challenge).run();
  const ret = new URL(st.return_url);
  ret.searchParams.set("nl_code", oneTime);
  if (st.client_state) ret.searchParams.set("client_state", st.client_state);
  const csrf = randomToken(16);
  return new Response(null, {
    status: 302,
    headers: {
      location: ret.toString(),
      "set-cookie": [`nl_session=${secret}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`, `nl_csrf=${csrf}; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`].join(", "),
    },
  });
}

async function authSession(env: Env, req: Request): Promise<Response> {
  const { code, code_verifier } = (await req.json()) as { code?: string; code_verifier?: string };
  if (!code) return json(env, req, 400, { error: "missing code" });
  const h = await sha256(code);
  const row = await env.DB.prepare("SELECT session, expires_at, code_challenge FROM login_codes WHERE code_hash = ?").bind(h).first<{ session: string; expires_at: number; code_challenge: string | null }>();
  await env.DB.prepare("DELETE FROM login_codes WHERE code_hash = ?").bind(h).run();
  if (!row || row.expires_at < Date.now()) return json(env, req, 400, { error: "invalid or expired code" });
  if (row.code_challenge) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(code_verifier ?? "")));
    if (b64(digest).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== row.code_challenge) return json(env, req, 400, { error: "PKCE verification failed" });
  }
  const secret = await open(env, row.session);
  const s = await env.DB.prepare("SELECT u.login, s.scopes FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?").bind(await sha256(secret)).first<{ login: string; scopes: string }>();
  return json(env, req, 200, { session: secret, login: s?.login, scopes: s?.scopes ?? "" });
}

async function authLogout(env: Env, req: Request): Promise<Response> {
  const s = await session(env, req);
  const auth = req.headers.get("authorization") ?? "";
  if (s && auth.startsWith("Bearer ")) {
    await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256(auth.slice(7))).run();
    // Revoke the grant at GitHub (requires client credentials; best effort).
    await fetch(`${env.GITHUB_API ?? "https://api.github.com"}/applications/${env.GITHUB_CLIENT_ID}/token`, {
      method: "DELETE",
      headers: { authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`, "content-type": "application/json", "user-agent": "nonlinear-sync" },
      body: JSON.stringify({ access_token: s.token }),
    }).catch(() => undefined);
  }
  return json(env, req, 200, { ok: true }, { "set-cookie": "nl_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax" });
}

/** Bounded GitHub API proxy: only REST paths the app uses; session → token swap. */
const PROXY_ALLOW = [/^\/user(\/teams|\/repos)?$/, /^\/(orgs|users)\/[^/]+\/repos$/, /^\/search\/repositories$/, /^\/repos\/[^/]+\/[^/]+(\/.*)?$/];

async function proxy(env: Env, req: Request, url: URL): Promise<Response> {
  const s = await session(env, req);
  if (!s) return json(env, req, 401, { message: "Requires authentication" });
  const path = url.pathname.slice(3);
  if (!PROXY_ALLOW.some((r) => r.test(path))) return json(env, req, 403, { message: "Path not allowed through Nonlinear proxy" });
  if (req.method !== "GET" && !s.scopes.split(",").includes("public_repo")) return json(env, req, 403, { message: "Write requires public_repo consent" });
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
  if (body && body.length > MAX_PROXY_BODY) return json(env, req, 413, { message: "Body too large" });
  const upstream = await fetch(`${env.GITHUB_API ?? "https://api.github.com"}${path}${url.search}`, {
    method: req.method,
    headers: {
      authorization: `Bearer ${s.token}`,
      accept: req.headers.get("accept") ?? "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "nonlinear-sync",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(req.headers.get("if-none-match") ? { "if-none-match": req.headers.get("if-none-match")! } : {}),
    },
    body,
  });
  const h = new Headers(cors(env, req));
  for (const k of ["content-type", "etag", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "link"]) {
    const v = upstream.headers.get(k);
    if (v) h.set(k, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: h });
}

interface EncryptedOpIn {
  opId: string;
  deviceId: string;
  entityKey: string;
  baseRevision: number;
  timestamp: number;
  schemaVersion: number;
  action: string;
  ciphertext: string;
}

async function pushOps(env: Env, req: Request): Promise<Response> {
  const s = await session(env, req);
  if (!s) return json(env, req, 401, { error: "unauthorized" });
  const { ops } = (await req.json()) as { ops: EncryptedOpIn[] };
  if (!Array.isArray(ops) || ops.length > MAX_OPS_PER_PUSH) return json(env, req, 400, { error: `send 1..${MAX_OPS_PER_PUSH} ops` });
  const stmts: D1PreparedStatement[] = [];
  for (const o of ops) {
    if (typeof o.opId !== "string" || typeof o.ciphertext !== "string" || o.ciphertext.length > MAX_CIPHERTEXT || typeof o.entityKey !== "string") return json(env, req, 400, { error: "invalid op" });
    stmts.push(
      env.DB.prepare("INSERT OR IGNORE INTO ops (user_id, op_id, device_id, entity_key, base_revision, ts, schema_version, action, ciphertext, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(
        s.userId, o.opId, String(o.deviceId).slice(0, 64), o.entityKey.slice(0, 128), Number(o.baseRevision) | 0, Number(o.timestamp) || 0, Number(o.schemaVersion) | 0, String(o.action).slice(0, 16), o.ciphertext, Date.now(),
      ),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json(env, req, 200, { accepted: ops.length });
}

async function pullOps(env: Env, req: Request, url: URL): Promise<Response> {
  const s = await session(env, req);
  if (!s) return json(env, req, 401, { error: "unauthorized" });
  const since = Number(url.searchParams.get("since") ?? 0) || 0;
  const rows = await env.DB.prepare("SELECT seq, op_id, device_id, entity_key, base_revision, ts, schema_version, action, ciphertext FROM ops WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT 500").bind(s.userId, since).all<{
    seq: number; op_id: string; device_id: string; entity_key: string; base_revision: number; ts: number; schema_version: number; action: string; ciphertext: string;
  }>();
  const results = rows.results ?? [];
  return json(env, req, 200, {
    ops: results.map((r) => ({ opId: r.op_id, userId: String(s.userId), deviceId: r.device_id, entityKey: r.entity_key, baseRevision: r.base_revision, timestamp: r.ts, schemaVersion: r.schema_version, action: r.action, ciphertext: r.ciphertext })),
    cursor: String(results.length ? results[results.length - 1]!.seq : since),
  });
}

/* ---------------- one-click sync: key check + device pairing ---------------- */

async function keycheck(env: Env, req: Request): Promise<Response> {
  const s = await session(env, req);
  if (!s) return json(env, req, 401, { error: "unauthorized" });
  if (req.method === "GET") {
    const row = await env.DB.prepare("SELECT keycheck FROM user_keys WHERE user_id = ?").bind(s.userId).first<{ keycheck: string }>();
    return json(env, req, 200, { keycheck: row?.keycheck ?? null });
  }
  const { keycheck: kc, reset } = (await req.json()) as { keycheck?: string; reset?: boolean };
  if (typeof kc !== "string" || kc.length > 512) return json(env, req, 400, { error: "invalid keycheck" });
  const existing = await env.DB.prepare("SELECT 1 AS x FROM user_keys WHERE user_id = ?").bind(s.userId).first();
  if (existing && !reset) return json(env, req, 409, { error: "A sync key already exists for this account; pair this device or use the recovery key." });
  if (reset) await env.DB.prepare("DELETE FROM ops WHERE user_id = ?").bind(s.userId).run(); // old ciphertext is unreadable with the new key
  await env.DB.prepare("INSERT INTO user_keys (user_id, keycheck, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET keycheck = excluded.keycheck, created_at = excluded.created_at").bind(s.userId, kc, Date.now()).run();
  return json(env, req, 200, { ok: true });
}

async function pairing(env: Env, req: Request, url: URL): Promise<Response> {
  const s = await session(env, req);
  if (!s) return json(env, req, 401, { error: "unauthorized" });
  const id = url.pathname.split("/")[3];
  const now = Date.now();
  await env.DB.prepare("DELETE FROM pairings WHERE expires_at < ?").bind(now).run();
  if (!id && req.method === "POST") {
    const { devicePub, label } = (await req.json()) as { devicePub?: string; label?: string };
    if (typeof devicePub !== "string" || devicePub.length > 200) return json(env, req, 400, { error: "invalid devicePub" });
    const pid = randomToken(12);
    await env.DB.prepare("INSERT INTO pairings (id, user_id, device_pub, label, expires_at) VALUES (?, ?, ?, ?, ?)").bind(pid, s.userId, devicePub, String(label ?? "New device").slice(0, 80), now + 10 * 60_000).run();
    return json(env, req, 200, { id: pid });
  }
  if (!id && req.method === "GET") {
    const rows = await env.DB.prepare("SELECT id, device_pub, label, expires_at FROM pairings WHERE user_id = ? AND wrapped IS NULL").bind(s.userId).all<{ id: string; device_pub: string; label: string; expires_at: number }>();
    return json(env, req, 200, { pending: (rows.results ?? []).map((r) => ({ id: r.id, devicePub: r.device_pub, label: r.label, expiresAt: r.expires_at })) });
  }
  const row = await env.DB.prepare("SELECT * FROM pairings WHERE id = ? AND user_id = ?").bind(id, s.userId).first<{ wrapped: string | null; approver_pub: string | null }>();
  if (!row) return json(env, req, 404, { error: "pairing not found or expired" });
  if (url.pathname.endsWith("/approve") && req.method === "POST") {
    const { wrapped, approverPub } = (await req.json()) as { wrapped?: string; approverPub?: string };
    if (typeof wrapped !== "string" || typeof approverPub !== "string" || wrapped.length > 1024) return json(env, req, 400, { error: "invalid" });
    await env.DB.prepare("UPDATE pairings SET wrapped = ?, approver_pub = ? WHERE id = ?").bind(wrapped, approverPub, id).run();
    return json(env, req, 200, { ok: true });
  }
  if (url.pathname.endsWith("/deny") && req.method === "POST") {
    await env.DB.prepare("DELETE FROM pairings WHERE id = ?").bind(id).run();
    return json(env, req, 200, { ok: true });
  }
  if (req.method === "GET") {
    if (!row.wrapped) return json(env, req, 200, { status: "pending" });
    await env.DB.prepare("DELETE FROM pairings WHERE id = ?").bind(id).run(); // deliver once
    return json(env, req, 200, { status: "approved", wrapped: row.wrapped, approverPub: row.approver_pub });
  }
  return json(env, req, 405, { error: "method not allowed" });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(env, req) });
    try {
      if (url.pathname === "/health") return json(env, req, 200, { ok: true });
      if (url.pathname === "/auth/github/start") return authStart(env, req, url);
      if (url.pathname === "/auth/github/callback") return authCallback(env, req, url);
      if (url.pathname === "/auth/session" && req.method === "POST") return authSession(env, req);
      if (url.pathname === "/auth/logout" && req.method === "POST") return authLogout(env, req);
      if (url.pathname.startsWith("/gh/")) return proxy(env, req, url);
      if (url.pathname === "/v1/keycheck") return keycheck(env, req);
      if (url.pathname === "/v1/pair" || url.pathname.startsWith("/v1/pair/")) return pairing(env, req, url);
      if (url.pathname === "/v1/me") {
        const s = await session(env, req);
        if (!s) return json(env, req, 401, { error: "unauthorized" });
        const u = await env.DB.prepare("SELECT login FROM users WHERE id = ?").bind(s.userId).first<{ login: string }>();
        return json(env, req, 200, { login: u?.login, scopes: s.scopes });
      }
      if (url.pathname === "/v1/ops" && req.method === "POST") return pushOps(env, req);
      if (url.pathname === "/v1/ops" && req.method === "GET") return pullOps(env, req, url);
      return json(env, req, 404, { error: "not found" });
    } catch (e) {
      return json(env, req, 500, { error: "internal error", detail: (e as Error).message.slice(0, 200) });
    }
  },
};
