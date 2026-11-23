// Open the PRs for live verification in ONE repo via the GitHub API (no gh CLI). Writes scripts/.live.env.
// Usage: node scripts/live-prs-single.mjs OWNER/REPO
import { writeFileSync } from "node:fs";
import { liveToken } from "./live-token.mjs";
const R = process.argv[2];
if (!/^[\w.-]+\/[\w.-]+$/.test(R ?? "")) throw new Error("usage: node scripts/live-prs-single.mjs OWNER/REPO");
const [OWNER, NAME] = R.split("/");
const token = liveToken();
const api = async (path, body) => {
  const r = await fetch(`https://api.github.com${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "nonlinear-live-e2e" }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${j.message ?? ""}`);
  return j;
};
const existing = await api(`/repos/${R}/pulls?state=open&per_page=50`);
const open = async (head, title, body) => existing.find((p) => p.head.ref === head) ?? api(`/repos/${R}/pulls`, { head, base: "main", title, body });
const up = await open("upstream-fix", "Fix retry handling for iteration 95", "Upstream fix.");
const bump = await open("bump-boom", "Bump BOOM for iteration 95", `Integrates the fix.\n\nDepends-On: ${R}#${up.number}`);
const docs = await open("docs", "Docs follow-up", "Follow-up.");
const tip = (await api("/repos/octocat/Hello-World/commits/master")).sha;
writeFileSync("scripts/.live.env", `OWNER=${OWNER}\nPARENT=${NAME}\nCHILD=${NAME}\nFIX_SHA=${tip}\nMODE=single\nSUBPATH=generators/hello\nCHILDREPO=octocat/hello-world\nUP=${up.number}\nBUMP=${bump.number}\nFOLLOW=${docs.number}\n`);
console.log(`PRs: #${up.number} upstream, #${bump.number} bump (Depends-On #${up.number}), #${docs.number} follow-up`);
