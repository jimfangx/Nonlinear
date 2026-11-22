// Live GitHub write verification against throwaway repos from live-setup.sh.
// Usage: node scripts/e2e-live.mjs   (app served on :4173; token from GH_TOKEN or ~/.config/nonlinear/test-token)
// The token is placed only in the headless browser's local storage and never printed.
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { liveToken } from "./live-token.mjs";
const env = Object.fromEntries(readFileSync("scripts/.live.env", "utf8").trim().split("\n").map((l) => l.split("=")));
const { OWNER, PARENT, CHILD, FIX_SHA } = env;
const SINGLE = env.MODE === "single";
const SUBPATH = env.SUBPATH ?? "generators/boom";
// Single-repo mode: chain is #1 → #2 inside one repo, follow-up PR is #3, submodule child is CHILDREPO.
const BUMP = Number(env.BUMP ?? (SINGLE ? 2 : 1)), FOLLOW = Number(env.FOLLOW ?? (SINGLE ? 3 : 2)), UP = Number(env.UP ?? 1);
const TOKEN = liveToken();
const APP = process.argv[2] ?? "http://localhost:4173";
const P = `${OWNER}/${PARENT}`.toLowerCase(), C = SINGLE ? (env.CHILDREPO ?? "").toLowerCase() : `${OWNER}/${CHILD}`.toLowerCase();
const api = async (path, init = {}) => (await fetch(`https://api.github.com${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, accept: "application/vnd.github+json", ...(init.headers ?? {}) } })).json();
let failed = 0;
const check = (n, ok, d = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.goto(`${APP}/#/settings`);
await page.evaluate(() => localStorage.setItem("nl:test", "1"));
await page.reload();
await page.getByLabel("GitHub API base").fill("https://api.github.com");
await page.getByLabel("Fine-grained personal access token").fill(TOKEN);
await page.getByRole("button", { name: "Save token" }).click();
await page.getByText(new RegExp(`@${OWNER}`, "i")).first().waitFor({ timeout: 20000 });
await page.evaluate(([p, c]) => window.__nl.getState().put("views", "live", { id: "live", name: "Live e2e", repos: c && c !== "octocat/hello-world" ? [...new Set([p, c])] : [p], category: "all-open", groupBy: "none", sort: "updated", releaseLens: null, createdAt: Date.now() }), [P, C]);
await page.goto(`${APP}/#/inbox/live`);
await page.getByRole("button", { name: /Refresh/ }).click();
await page.getByText("Bump BOOM for i34 fix").first().waitFor({ timeout: 30000 });
await page.getByRole("tab", { name: /All open/ }).click();
await page.locator(".list-row", { hasText: `${P}#${BUMP}` }).click();
await page.getByText(/[23] PRs · linear stack/).waitFor({ timeout: 20000 });
check("live: Depends-On chain detected across repos", true);

// 1) managed chain block on writable PR #2
await page.locator(".list-row", { hasText: `${P}#${FOLLOW}` }).click();
await page.getByRole("button", { name: "+ Prerequisite" }).click();
await page.getByPlaceholder(/owner\/repo#123/).fill(`${P}#${BUMP}`);
await page.getByRole("button", { name: "Preview" }).click();
await page.getByRole("button", { name: "Save", exact: true }).click();
await page.getByText(/Updated managed block/).waitFor({ timeout: 30000 });
const pr2 = await api(`/repos/${P}/pulls/${FOLLOW}`);
check("live: exactly one managed block (re-saving from a fresh device reuses the block id)", ((pr2.body ?? "").match(/chain:start/g) ?? []).length === 1, `${((pr2.body ?? "").match(/chain:start/g) ?? []).length} block(s)`);
check("live: managed chain block written to PR description", /nonlinear:chain:start v1 id=chain_/.test(pr2.body ?? "") && (pr2.body ?? "").toLowerCase().includes(`github.com/${P}/pull/${BUMP}`));

// 2) labels via PRDetail edit
await page.getByRole("button", { name: "Edit Labels" }).click();
const LABEL = `nonlinear-e2e-${Date.now().toString(36)}`;
await page.getByRole("textbox", { name: "Edit labels" }).fill(LABEL);
await page.getByRole("button", { name: "Save to GitHub" }).click();
await page.getByText("Updated on GitHub").waitFor({ timeout: 20000 });
check("live: label written", (await api(`/repos/${P}/issues/${FOLLOW}/labels`)).some((l) => l.name === LABEL));

// 3) inline draft comment + review submission on PR #1
await page.goto(`${APP}/#/pr/${OWNER}/${PARENT}/${BUMP}/files`);
await page.locator(".tree-row", { hasText: "BoomConfigs" }).click();
await page.locator(".dl.add .no").first().waitFor({ timeout: 30000 });
await page.locator(".dl.add").first().locator(".no").nth(1).click();
await page.screenshot({ path: (process.env.SHOTS ?? "/tmp") + "/live-review.png" });
await page.keyboard.press("c");
await page.locator(".modal textarea").fill("Nonlinear live e2e inline comment");
await page.getByRole("button", { name: "Save draft" }).click();
await page.getByRole("button", { name: /Submit review \(1\)/ }).click();
await page.locator(".modal textarea").fill("Nonlinear live e2e review");
await page.getByRole("button", { name: "Submit to GitHub" }).click();
await page.getByText("Review submitted to GitHub").waitFor({ timeout: 30000 });
const rc = await api(`/repos/${P}/pulls/${BUMP}/comments`);
check("live: inline review comment anchored on GitHub", rc.some((c) => c.body.includes("live e2e inline") && c.path === "BoomConfigs.scala"));

// 4) conversation comment
await page.goto(`${APP}/#/pr/${OWNER}/${PARENT}/${BUMP}/conversation`);
await page.locator("textarea").last().fill("Nonlinear live e2e comment");
await page.getByRole("button", { name: "Comment", exact: true }).click();
await page.getByText("Comment posted to GitHub").waitFor({ timeout: 20000 });
check("live: issue comment posted", (await api(`/repos/${P}/issues/${BUMP}/comments`)).some((c) => c.body === "Nonlinear live e2e comment"));

// 5) release pin → branch + draft PR via Git Data API (gitlink bump)
await page.evaluate(([p, c, sha, sub]) => {
  const st = window.__nl.getState();
  st.put("releases", "rel_live", { id: "rel_live", name: "Live vNext", color: "#7c5cff", state: "draft", targetDate: null, roots: [{ root: p, sha: null, baseRef: "main" }], validation: [], createdAt: 1, updatedAt: 1, revision: 1 });
  st.put("pins", `rel_live|${p}|${sub}`, { releaseId: "rel_live", parentRepo: p, pathChain: [sub], childRepo: c, sha, updatedAt: Date.now() });
}, [P, C, FIX_SHA, SUBPATH]);
await page.goto(`${APP}/#/releases/rel_live`);
await page.getByRole("button", { name: "Apply planned pins…" }).click();
await page.getByRole("button", { name: "Compute preview" }).click();
await page.getByText(/gitlink changes across/).waitFor({ timeout: 30000 });
await page.getByRole("button", { name: "Open draft PR…" }).click();
await page.getByRole("button", { name: "Create branch + draft PR" }).click();
await page.getByText(/Draft PR opened/).waitFor({ timeout: 30000 });
const pulls = await api(`/repos/${P}/pulls?state=open`);
const bump = pulls.find((p) => p.title.includes("[Live vNext]"));
const files = bump ? await api(`/repos/${P}/pulls/${bump.number}/files`) : [];
check("live: gitlink bump draft PR created with the pinned SHA", !!bump && bump.draft && JSON.stringify(files).includes(FIX_SHA.slice(0, 7)));

await browser.close();
console.log(failed ? `${failed} FAILED` : "all live checks passed");
process.exit(failed ? 1 : 0);
