// Live smoke test against public GitHub (anonymous; light on rate limit).
// Usage: node scripts/smoke-live.mjs [baseUrl] owner/repo#number
import { chromium } from "playwright-core";
const base = process.argv[2] ?? "http://localhost:4173";
const [, owner, repo, num] = /^([^/]+)\/([^#]+)#(\d+)$/.exec(process.argv[3] ?? "ucb-bar/chipyard#2393");
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
const shot = (n) => page.screenshot({ path: `${process.env.SHOTS ?? "/tmp"}/${n}.png` });

await page.goto(`${base}/#/pr/${owner}/${repo}/${num}/files`);
await page.locator(".tree-row").first().waitFor({ timeout: 30000 });
const files = await page.locator(".tree-row").count();
console.log("files in review tree:", files);
await page.waitForTimeout(500);
// Select first diff line, shift-select 3 more, flag them
const nos = page.locator(".dl .no");
await nos.nth(3).click();
await nos.nth(9).click({ modifiers: ["Shift"] });
await page.keyboard.press("x");
await page.waitForTimeout(200);
console.log("flagged rows:", await page.locator(".dl.flagged").count());
// drag frontier rail half-way
const rail = page.locator(".rail");
const box = await rail.boundingBox();
await page.mouse.move(box.x + 5, box.y + 2);
await page.mouse.down();
await page.mouse.move(box.x + 5, box.y + box.height * 0.5, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(200);
console.log("frontier:", await rail.getAttribute("aria-valuenow"), "/", await rail.getAttribute("aria-valuemax"));
console.log("status chip:", await page.locator(".toolbar .chip").nth(2).textContent());
await shot("10-review-files");

// Persist across reload
await page.reload();
await page.locator(".rail").waitFor({ timeout: 30000 });
console.log("frontier after reload:", await page.locator(".rail").getAttribute("aria-valuenow"));

await page.goto(`${base}/#/pr/${owner}/${repo}/${num}/overview`);
await page.waitForTimeout(1500);
await shot("11-review-overview");
console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no page errors");
await browser.close();
