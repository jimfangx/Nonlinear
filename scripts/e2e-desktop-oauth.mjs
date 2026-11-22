// Protocol test for desktop sign-in (RFC 8252 loopback + PKCE) against the real sync Worker + mock GitHub.
// Plays the roles of the system browser and the app's loopback listener.
import http from "node:http";
import crypto from "node:crypto";
const CLOUD = process.argv[2] ?? "http://localhost:8787";
const b64url = (b) => Buffer.from(b).toString("base64url");
const verifier = b64url(crypto.randomBytes(32));
const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
const clientState = b64url(crypto.randomBytes(16));
let got;
const srv = http.createServer((req, res) => { got = new URL(req.url, "http://127.0.0.1").searchParams; res.end("ok"); srv.close(); }).listen(0, "127.0.0.1");
await new Promise((r) => srv.on("listening", r));
const port = srv.address().port;
let url = `${CLOUD}/auth/github/start?scope=&return=${encodeURIComponent(`http://127.0.0.1:${port}/cb`)}&code_challenge=${challenge}&client_state=${clientState}`;
for (let i = 0; i < 6 && url; i++) {   // "browser" follows redirects
  const r = await fetch(url, { redirect: "manual" });
  url = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
}
await new Promise((r) => setTimeout(r, 200));
const fail = (m) => { console.log("FAIL", m); process.exit(1); };
if (!got) fail("loopback never received the redirect");
if (got.get("client_state") !== clientState) fail("client_state mismatch");
const code = got.get("nl_code");
const bad = await fetch(`${CLOUD}/auth/session`, { method: "POST", body: JSON.stringify({ code, code_verifier: "wrong" }) });
console.log(bad.status === 400 ? "PASS intercepted code without verifier is rejected (and burned)" : "FAIL wrong verifier accepted");
// fresh round with the right verifier
url = `${CLOUD}/auth/github/start?scope=&return=${encodeURIComponent(`http://127.0.0.1:${port}/cb`)}&code_challenge=${challenge}&client_state=${clientState}`;
const srv2 = http.createServer((req, res) => { got = new URL(req.url, "http://127.0.0.1").searchParams; res.end("ok"); srv2.close(); }).listen(port, "127.0.0.1");
for (let i = 0; i < 6 && url; i++) { const r = await fetch(url, { redirect: "manual" }); url = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null; }
await new Promise((r) => setTimeout(r, 200));
const ok = await (await fetch(`${CLOUD}/auth/session`, { method: "POST", body: JSON.stringify({ code: got.get("nl_code"), code_verifier: verifier }) })).json();
console.log(ok.login === "maintainer" && ok.session ? "PASS loopback + PKCE yields a session (no client secret in app)" : `FAIL ${JSON.stringify(ok)}`);
const proxied = await fetch(`${CLOUD}/gh/repos/ucb-bar/chipyard`, { headers: { authorization: `Bearer ${ok.session}` } });
console.log(proxied.ok ? "PASS session works through /gh proxy" : `FAIL proxy ${proxied.status}`);
process.exit(0);
