// Two-device "Connect" journey against the real sync Worker (wrangler dev) + mock GitHub OAuth.
// Prereqs: app built with VITE_NONLINEAR_CLOUD_URL=http://localhost:8787 and served on :4173;
//          `node scripts/mock-github.mjs 4010`; `wrangler dev` for services/sync on :8787 with
//          GITHUB_API/GITHUB_WEB=http://localhost:4010.
import { chromium } from "playwright-core";
const APP = process.argv[2] ?? "http://localhost:4173";
const SHOTS = process.env.SHOTS ?? "/tmp";
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
let failed = 0;
const check = (n, ok, d = "") => { if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${n}${d ? ` — ${d}` : ""}`); };
const device = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  return page;
};

// Device A: one click → connected
const A = await device();
await A.goto(`${APP}/#/settings`);
await A.getByRole("button", { name: "Connect with GitHub" }).click();
await A.getByText("Connected as @maintainer").first().waitFor({ timeout: 20000 });
check("A: Connect with one click (no URL/passphrase fields)", true);
check("A: GitHub API routed through backend proxy", (await A.getByLabel("GitHub API base").inputValue()) === "http://localhost:8787/gh");
// First connect creates the key and must show it until the user confirms saving it.
const prompt = A.getByRole("dialog", { name: "Save your recovery key" });
await prompt.waitFor({ timeout: 10000 });
const rk = (await prompt.locator("code.mono").textContent())?.trim();
check("A: recovery key shown on first connect", /^NL1-/.test(rk ?? ""));
check("A: Done needs confirmation", await prompt.getByRole("button", { name: "Done" }).isDisabled());
await prompt.getByRole("checkbox").check();
await prompt.getByRole("button", { name: "Done" }).click();
await prompt.waitFor({ state: "detached" });
await A.waitForTimeout(300); // let the IndexedDB write land before reloading
await A.reload();
await A.getByRole("button", { name: "Sync now" }).waitFor();
check("A: prompt stays dismissed once saved", (await A.getByRole("dialog", { name: "Save your recovery key" }).count()) === 0);
await A.getByRole("button", { name: "Show recovery key" }).click();
check("A: Settings shows the same key", (await A.locator("code.mono").first().textContent())?.trim() === rk);
await A.screenshot({ path: `${SHOTS}/cloud-A-connected.png` });

// Device A creates a card and syncs
await A.goto(`${APP}/#/board`);
await A.getByRole("button", { name: "+ Card" }).click();
await A.getByRole("complementary", { name: "Feature card" }).getByRole("textbox", { name: "Title", exact: true }).fill("Synced feature card");
await A.getByRole("button", { name: "Done" }).click();
await A.goto(`${APP}/#/settings`);
await A.getByRole("button", { name: "Sync now" }).click();
await A.getByText(/Pushed \d+/).waitFor({ timeout: 10000 });

// Device B: Connect → needs pairing → approve on A
const B = await device();
await B.goto(`${APP}/#/settings`);
await B.getByRole("button", { name: "Connect with GitHub" }).click();
await B.getByRole("button", { name: "Approve from another device" }).waitFor({ timeout: 20000 });
check("B: detects existing encrypted data and asks to pair", true);
await B.getByRole("button", { name: "Approve from another device" }).click();
const codeB = (await B.getByText(/Confirm the other device shows code/).locator("b").textContent())?.trim();
await B.screenshot({ path: `${SHOTS}/cloud-B-pairing.png` });
await A.reload();
await A.getByText("Approve new device?").waitFor({ timeout: 30000 });
const codeA = (await A.locator(".modal b.mono").textContent())?.trim();
check("Verification codes match on both devices", codeA === codeB, `${codeA} / ${codeB}`);
await A.screenshot({ path: `${SHOTS}/cloud-A-approve.png` });
await A.getByRole("button", { name: "Approve" }).click();
await B.getByText("Connected as @maintainer").first().waitFor({ timeout: 20000 });
check("B: paired and connected", true);
await B.getByRole("button", { name: "Sync now" }).click();
await B.getByText(/pulled [1-9]/).waitFor({ timeout: 10000 });
await B.goto(`${APP}/#/board`);
await B.getByText("Synced feature card").waitFor({ timeout: 5000 });
check("B: card created on A appears after sync (E2E encrypted)", true);

// Conflict: both devices edit the same release pin while out of sync (§10)
const setPin = (page, sha) => page.evaluate((sha) => {
  const st = window.__nl.getState();
  st.put("releases", "rel_x", { id: "rel_x", name: "vNext", color: "#f00", state: "draft", targetDate: null, roots: [], validation: [], createdAt: 1, updatedAt: 1, revision: 1 });
  st.put("pins", "rel_x|ucb-bar/chipyard|generators/boom", { releaseId: "rel_x", parentRepo: "ucb-bar/chipyard", pathChain: ["generators/boom"], childRepo: "riscv-boom/riscv-boom", sha, updatedAt: Date.now() });
}, sha);
for (const p of [A, B]) { await p.evaluate(() => localStorage.setItem("nl:test", "1")); await p.reload(); await p.waitForTimeout(500); }
const syncNow = async (p) => { await p.goto(`${APP}/#/settings`); await p.getByRole("button", { name: "Sync now" }).click(); await p.getByText(/Pushed \d+, pulled \d+/).last().waitFor({ timeout: 10000 }); await p.waitForTimeout(300); };
await A.goto(`${APP}/#/timeline?new=1`);
await A.getByLabel("Root repository").fill("ucb-bar/chipyard");
await A.getByLabel(/Root commit/).fill("a".repeat(40));
await A.getByRole("button", { name: "Create", exact: true }).click();
await A.waitForURL(/#\/timeline\/tl_/);
const timelineId = new URL(A.url()).hash.split("/").at(-1);
await A.evaluate((id) => window.__nl.getState().patch("timelines", id, { zoom: "month", zoomScale: 2.75 }), timelineId);
await syncNow(A);
await syncNow(B);
await B.goto(`${APP}/#/timeline`);
await B.getByRole("button", { name: "Remove timeline ucb-bar/chipyard@main" }).waitFor();
check("Timeline created on A appears on B", true);
const timeline = (page) => page.evaluate((id) => window.__nl.getState().timelines[id], timelineId);
const onB = await timeline(B);
check("Custom timeline zoom and fixed commit round-trip", onB?.zoomScale === 2.75 && onB?.rootSha === "a".repeat(40));
await A.evaluate((id) => window.__nl.getState().patch("timelines", id, { rootSha: null }), timelineId);
await syncNow(A);
await syncNow(B);
check("Following the branch clears the fixed commit on the other device", (await timeline(B))?.rootSha === null);
await B.goto(`${APP}/#/timeline`);
await B.getByRole("button", { name: "Remove timeline ucb-bar/chipyard@main" }).click();
await B.getByRole("button", { name: "Remove view", exact: true }).click();
await syncNow(B);
await syncNow(A);
check("Timeline removal is synced to A", await A.evaluate((id) => !window.__nl.getState().timelines[id], timelineId));

await setPin(A, "a".repeat(40));
await syncNow(A);
await syncNow(B);
await setPin(A, "b".repeat(40));
await setPin(B, "c".repeat(40));
await syncNow(B);
await syncNow(A);
await A.getByText(/1 sync conflict/).waitFor({ timeout: 10000 });
check("Conflict: concurrent pin edits surfaced, not silently overwritten", (await A.getByText("bbbbbbbbbb").count()) > 0 && (await A.getByText("cccccccccc").count()) > 0);
await A.screenshot({ path: `${SHOTS}/cloud-conflict.png` });
await A.getByRole("button", { name: "Keep mine" }).click();
await syncNow(A);
await syncNow(B);
const bPin = await B.evaluate(() => window.__nl.getState().pins["rel_x|ucb-bar/chipyard|generators/boom"]?.sha);
check("Conflict: 'Keep mine' propagates to the other device", bPin === "b".repeat(40), bPin);

// Device C: recovery key path
const C = await device();
await C.goto(`${APP}/#/settings`);
await C.getByRole("button", { name: "Connect with GitHub" }).click();
await C.getByPlaceholder("NL1-…").fill(rk);
await C.getByRole("button", { name: "Use recovery key" }).click();
await C.getByText("Connected as @maintainer").first().waitFor({ timeout: 10000 });
check("C: recovery key connects a new device", true);

// Lost key: A disconnects (deleting its key), reconnects, resets encryption. Its local data must be
// uploaded under the new key, so a fresh device restores everything from the NEW recovery key alone.
const cardsOnA = await A.evaluate(() => Object.values(window.__nl.getState().cards).filter((c) => !c.deleted).map((c) => c.title).sort());
await A.goto(`${APP}/#/settings`);
await A.getByRole("button", { name: "Disconnect", exact: true }).last().click();
await A.getByRole("button", { name: "Connect with GitHub" }).click();
await A.getByRole("button", { name: "Approve from another device" }).waitFor({ timeout: 20000 });
check("D: a device without the key is asked to pair", true);
await A.getByText("Lost all devices and the recovery key?").click();
await A.getByRole("button", { name: "Reset cloud encryption" }).click();
// In-app confirmation (window.confirm does nothing in the desktop webview).
await A.getByRole("dialog", { name: "Reset cloud encryption?" }).getByRole("button", { name: "Reset and re-upload" }).click();
await A.getByText(/New encryption key created\. Uploaded \d+ item/).waitFor({ timeout: 30000 });
const uploaded = Number((await A.getByText(/Uploaded \d+ item/).first().textContent()).match(/Uploaded (\d+)/)[1]);
const resetPrompt = A.getByRole("dialog", { name: "Save your recovery key" });
await resetPrompt.waitFor({ timeout: 10000 });
const newRk = (await resetPrompt.locator("code.mono").textContent())?.trim();
check("D: reset shows a NEW recovery key", /^NL1-/.test(newRk ?? "") && newRk !== rk);
check("D: reset uploads this device's data", uploaded >= cardsOnA.length && uploaded > 0, `${uploaded} items`);
await resetPrompt.getByRole("checkbox").check();
await resetPrompt.getByRole("button", { name: "Done" }).click();

const E = await device();
await E.goto(`${APP}/#/settings`);
await E.getByRole("button", { name: "Connect with GitHub" }).click();
await E.getByPlaceholder("NL1-…").fill(rk);
await E.getByRole("button", { name: "Use recovery key" }).click();
await E.getByText("That recovery key doesn't match this account.").waitFor({ timeout: 10000 });
check("D: the old recovery key no longer works", true);
await E.getByPlaceholder("NL1-…").fill(newRk);
await E.getByRole("button", { name: "Use recovery key" }).click();
await E.getByText("Connected as @maintainer").first().waitFor({ timeout: 10000 });
await E.evaluate(() => localStorage.setItem("nl:test", "1"));
await E.reload();
await E.waitForTimeout(500);
await syncNow(E);
const cardsOnE = await E.evaluate(() => Object.values(window.__nl.getState().cards).filter((c) => !c.deleted).map((c) => c.title).sort());
check("D: new device restores all cards with the new key", JSON.stringify(cardsOnE) === JSON.stringify(cardsOnA) && cardsOnA.length > 0, JSON.stringify(cardsOnE));

console.log(failed ? `${failed} FAILED` : "all cloud checks passed");
await browser.close();
process.exit(failed ? 1 : 0);
