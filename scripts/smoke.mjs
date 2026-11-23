// Headless smoke test of the built web app using locally installed Chrome.
// Usage: node scripts/smoke.mjs [baseUrl] [path/to/diff.json]
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:4173";
const diffPath = process.argv[3];
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
const shot = async (n) => page.screenshot({ path: `${process.env.SHOTS ?? "/tmp"}/${n}.png` });

await page.goto(base + "/#/inbox");
await page.getByText("Create your first repository view").waitFor({ timeout: 10000 });
await shot("01-inbox-empty");

for (const r of ["timeline", "board", "review", "diff", "graph", "releases", "settings"]) {
  await page.goto(`${base}/#/${r}`);
  await page.waitForTimeout(400);
  await shot(`02-${r}`);
}

if (diffPath) {
  await page.goto(base + "/#/diff");
  const t0 = Date.now();
  await page.setInputFiles('input[type="file"]', diffPath);
  await page.getByText(/Parsed 73 files across 6 groups/).waitFor({ timeout: 15000 });
  console.log(`diff import rendered in ${Date.now() - t0} ms`);
  await page.getByText("generators/boom", { exact: true }).waitFor();
  const groups = await page.locator(".tree-row b").allTextContents();
  console.log("groups:", groups.join(" | "));
  await page.locator(".tree-row", { hasText: ".scala" }).nth(20).click();
  await page.waitForTimeout(300);
  await shot("03-diff-boom-file");
  const lines = await page.locator(".dl").count();
  console.log("rendered diff rows (virtualized):", lines);
  await page.getByLabel("search content").check();
  await page.getByPlaceholder("Search paths…").fill("FastIssue");
  await page.waitForTimeout(1500);
  console.log("content-search hits (spilled, async):", await page.locator(".tree-row:has(.mono)").count());
  const url = page.url();
  await page.reload();
  await page.goto(url);
  await page.getByText(/73 files · \+/).waitFor({ timeout: 10000 });
  console.log("reopened spilled import after reload: ok");
}

// Board: create a card and move it via keyboard
await page.goto(base + "/#/board");
await page.getByRole("button", { name: "+ Card" }).click();
await page.getByRole("textbox", { name: "Title", exact: true }).fill("BOOM iteration 95 integration");
await page.getByRole("button", { name: "Done" }).click();
await page.locator(".card").first().focus();
await page.keyboard.press("Alt+ArrowRight");
await page.waitForTimeout(200);
const inProgress = await page.locator('section[aria-label="In progress"] .card').count();
console.log("cards in 'In progress' after Alt+→:", inProgress);
await shot("04-board");

// Releases: create one
await page.goto(base + "/#/releases");
await page.getByRole("button", { name: "+ New release" }).click();
await page.getByRole("dialog", { name: "New release" }).getByLabel("Name", { exact: true }).fill("Smoke test release");
await page.getByRole("button", { name: "Create" }).click();
await page.waitForTimeout(300);
await shot("05-release");

// Persistence across reload (local-first)
await page.reload();
await page.goto(base + "/#/board");
await page.waitForTimeout(500);
console.log("card persisted after reload:", await page.locator(".card").count());

// Command palette
await page.keyboard.press("Meta+k");
await page.waitForTimeout(200);
console.log("palette open:", await page.locator(".palette").count());
await shot("06-palette");

console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no page errors");
await browser.close();
