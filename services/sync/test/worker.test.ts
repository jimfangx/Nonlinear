/**
 * Worker tests using a D1-compatible shim over node:sqlite (real SQL + real migration).
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/worker";

class Stmt {
  args: unknown[] = [];
  constructor(private db: DatabaseSync, private sql: string) {}
  bind(...a: unknown[]) { this.args = a; return this; }
  async first<T>() { return (this.db.prepare(this.sql).get(...(this.args as never[])) as T) ?? null; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...(this.args as never[])) as T[] }; }
  async run() { this.db.prepare(this.sql).run(...(this.args as never[])); return { success: true }; }
}
function d1(): D1Database {
  const db = new DatabaseSync(":memory:");
  for (const m of ["0001_init.sql", "0002_pairing.sql", "0003_pkce.sql"]) db.exec(readFileSync(new URL(`../migrations/${m}`, import.meta.url), "utf8"));
  return {
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (ss: Stmt[]) => Promise.all(ss.map((s) => s.run())),
  } as unknown as D1Database;
}

const KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
let env: Env;
const APP = "http://localhost:5173";

beforeEach(() => {
  env = { DB: d1(), GITHUB_CLIENT_ID: "cid", GITHUB_CLIENT_SECRET: "secret", TOKEN_KEY: KEY, ALLOWED_ORIGINS: APP, GITHUB_API: "https://gh.test", GITHUB_WEB: "https://ghweb.test" };
  vi.restoreAllMocks();
});

const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://sync.test${path}`, init), env);

async function login(scope = "public_repo", grantedScope = scope): Promise<string> {
  const start = await call(`/auth/github/start?scope=${scope}&return=${encodeURIComponent(APP + "/")}`);
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const u = String(input instanceof Request ? input.url : input);
    if (u.endsWith("/login/oauth/access_token")) return new Response(JSON.stringify({ access_token: "gho_real", scope: grantedScope }));
    if (u.endsWith("/user")) return new Response(JSON.stringify({ id: 42, login: "maintainer" }));
    return new Response(JSON.stringify({ proxied: u }), { headers: { "x-ratelimit-remaining": "4999" } });
  });
  const cb = await call(`/auth/github/callback?code=abc&state=${state}`);
  expect(cb.status).toBe(302);
  expect(cb.headers.get("set-cookie")).toMatch(/nl_session=.*HttpOnly/);
  const codeParam = new URL(cb.headers.get("location")!).searchParams.get("nl_code")!;
  expect(cb.headers.get("location")).not.toMatch(/gho_real/);
  const sres = await call("/auth/session", { method: "POST", body: JSON.stringify({ code: codeParam }) });
  const s = (await sres.json()) as { session: string; login: string; scopes: string };
  expect(s.login).toBe("maintainer");
  // one-time
  expect((await call("/auth/session", { method: "POST", body: JSON.stringify({ code: codeParam }) })).status).toBe(400);
  return s.session;
}

describe("auth", () => {
  it("rejects disallowed scopes and return origins", async () => {
    expect((await call(`/auth/github/start?scope=repo&return=${encodeURIComponent(APP)}`)).status).toBe(400);
    expect((await call(`/auth/github/start?scope=&return=${encodeURIComponent("https://evil.example")}`)).status).toBe(400);
  });
  it("refuses an over-scoped token from GitHub", async () => {
    const start = await call(`/auth/github/start?scope=public_repo&return=${encodeURIComponent(APP)}`);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ access_token: "x", scope: "repo,public_repo" })));
    expect((await call(`/auth/github/callback?code=a&state=${state}`)).status).toBe(400);
  });
  it("proxies with server-held token and blocks writes without public_repo", async () => {
    const ro = await login("", "");
    const g = await call("/gh/repos/a/b", { headers: { authorization: `Bearer ${ro}` } });
    expect(((await g.json()) as { proxied: string }).proxied).toBe("https://gh.test/repos/a/b");
    const w = await call("/gh/repos/a/b/pulls/1", { method: "PATCH", body: "{}", headers: { authorization: `Bearer ${ro}` } });
    expect(w.status).toBe(403);
    expect((await call("/gh/admin/x", { headers: { authorization: `Bearer ${ro}` } })).status).toBe(403);
  });
  it("cookie auth requires CSRF for unsafe methods", async () => {
    const s = await login();
    const r = await call("/v1/ops", { method: "POST", body: JSON.stringify({ ops: [] }), headers: { cookie: `nl_session=${s}` } });
    expect(r.status).toBe(401);
    const ok = await call("/v1/ops", { method: "POST", body: JSON.stringify({ ops: [] }), headers: { cookie: `nl_session=${s}; nl_csrf=t`, "x-nonlinear-csrf": "t" } });
    expect(ok.status).toBe(200);
  });
});

describe("ops", () => {
  it("is idempotent, cursored, per-user", async () => {
    const s = await login();
    const op = (id: string) => ({ opId: id, deviceId: "d1", entityKey: "k", baseRevision: 0, timestamp: 1, schemaVersion: 1, action: "set", ciphertext: "Y3Q=" });
    const auth = { authorization: `Bearer ${s}` };
    await call("/v1/ops", { method: "POST", headers: auth, body: JSON.stringify({ ops: [op("a"), op("b")] }) });
    await call("/v1/ops", { method: "POST", headers: auth, body: JSON.stringify({ ops: [op("a")] }) });
    const r1 = (await (await call("/v1/ops?since=0", { headers: auth })).json()) as { ops: { opId: string }[]; cursor: string };
    expect(r1.ops.map((o) => o.opId)).toEqual(["a", "b"]);
    const r2 = (await (await call(`/v1/ops?since=${r1.cursor}`, { headers: auth })).json()) as { ops: unknown[] };
    expect(r2.ops).toHaveLength(0);
    expect((await call("/v1/ops?since=0")).status).toBe(401);
  });
  it("bounds payloads", async () => {
    const s = await login();
    const big = { opId: "x", deviceId: "d", entityKey: "k", baseRevision: 0, timestamp: 0, schemaVersion: 1, action: "set", ciphertext: "a".repeat(70_000) };
    expect((await call("/v1/ops", { method: "POST", headers: { authorization: `Bearer ${s}` }, body: JSON.stringify({ ops: [big] }) })).status).toBe(400);
  });
});

describe("one-click sync", () => {
  it("stores a key check once; pairs a device through the relay", async () => {
    const s = await login();
    const auth = { authorization: `Bearer ${s}` };
    expect(((await (await call("/v1/keycheck", { headers: auth })).json()) as { keycheck: null }).keycheck).toBeNull();
    expect((await call("/v1/keycheck", { method: "PUT", headers: auth, body: JSON.stringify({ keycheck: "iv.ct" }) })).status).toBe(200);
    expect((await call("/v1/keycheck", { method: "PUT", headers: auth, body: JSON.stringify({ keycheck: "other" }) })).status).toBe(409);
    const { id } = (await (await call("/v1/pair", { method: "POST", headers: auth, body: JSON.stringify({ devicePub: "PUB", label: "Laptop" }) })).json()) as { id: string };
    const pend = (await (await call("/v1/pair", { headers: auth })).json()) as { pending: { id: string; label: string }[] };
    expect(pend.pending[0]).toMatchObject({ id, label: "Laptop" });
    expect(((await (await call(`/v1/pair/${id}`, { headers: auth })).json()) as { status: string }).status).toBe("pending");
    await call(`/v1/pair/${id}/approve`, { method: "POST", headers: auth, body: JSON.stringify({ wrapped: "W", approverPub: "A" }) });
    expect(await (await call(`/v1/pair/${id}`, { headers: auth })).json()).toEqual({ status: "approved", wrapped: "W", approverPub: "A" });
    expect((await call(`/v1/pair/${id}`, { headers: auth })).status).toBe(404); // delivered once
  });
});

describe("desktop loopback + PKCE", () => {
  it("requires PKCE for loopback and verifies the verifier", async () => {
    const ret = encodeURIComponent("http://127.0.0.1:53123/cb");
    expect((await call(`/auth/github/start?scope=&return=${ret}`)).status).toBe(400);
    expect((await call(`/auth/github/start?scope=&return=${encodeURIComponent("http://127.0.0.1:1/evil")}&code_challenge=${"a".repeat(43)}`)).status).toBe(400);
    const verifier = "v".repeat(64);
    const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url");
    const start = await call(`/auth/github/start?scope=&return=${ret}&code_challenge=${challenge}&client_state=xyz`);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const u = String(input);
      if (u.endsWith("/login/oauth/access_token")) return new Response(JSON.stringify({ access_token: "t", scope: "" }));
      return new Response(JSON.stringify({ id: 1, login: "desk" }));
    });
    const cb = await call(`/auth/github/callback?code=c&state=${state}`);
    const loc = new URL(cb.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("http://127.0.0.1:53123/cb");
    expect(loc.searchParams.get("client_state")).toBe("xyz");
    const code = loc.searchParams.get("nl_code")!;
    // wrong verifier burns the code
    expect((await call("/auth/session", { method: "POST", body: JSON.stringify({ code, code_verifier: "nope" }) })).status).toBe(400);
    const start2 = await call(`/auth/github/start?scope=&return=${ret}&code_challenge=${challenge}`);
    const cb2 = await call(`/auth/github/callback?code=c&state=${new URL(start2.headers.get("location")!).searchParams.get("state")}`);
    const code2 = new URL(cb2.headers.get("location")!).searchParams.get("nl_code")!;
    const ok = await call("/auth/session", { method: "POST", body: JSON.stringify({ code: code2, code_verifier: verifier }) });
    expect(((await ok.json()) as { login: string }).login).toBe("desk");
  });
});
