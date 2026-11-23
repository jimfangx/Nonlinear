// Screen-reader-oriented audit via Chrome's accessibility tree (what VoiceOver/NVDA consume):
// landmarks, headings, accessible names of interactive elements, and Tab-order announcements.
// Prereqs: app on :4173 and mock GitHub on :4010.
import { chromium } from "playwright-core";
import { createMockInboxView } from "./mock-inbox.mjs";
const APP = process.argv[2] ?? "http://localhost:4173";
const MOCK = process.argv[3] ?? "http://localhost:4010";
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const cdp = await page.context().newCDPSession(page);
await page.goto(`${APP}/#/settings`);
await page.getByLabel("GitHub API base").fill(MOCK);
await page.getByPlaceholder("github_pat_…").fill("mock-token");
await page.getByRole("button", { name: "Save token" }).click();
await page.getByText("@maintainer").first().waitFor();
await page.goto(`${APP}/#/inbox`);
await createMockInboxView(page);
await page.getByText("Bump BOOM for iteration 95").first().waitFor({ timeout: 15000 });
const views = [["inbox", "#/inbox"], ["review-files", "#/pr/ucb-bar/chipyard/789/files"], ["review-overview", "#/pr/ucb-bar/chipyard/789/overview"], ["board", "#/board"], ["timeline", "#/timeline"], ["releases", "#/releases"], ["diff", "#/diff"], ["graph", "#/graph/ucb-bar/chipyard"], ["settings", "#/settings"]];
let problems = 0;
const INTERACTIVE = new Set(["button", "link", "textbox", "combobox", "checkbox", "radio", "slider", "tab", "option", "menuitem", "searchbox", "spinbutton", "switch"]);
for (const [name, hash] of views) {
  await page.goto(`${APP}/${hash}`);
  await page.waitForTimeout(1200);
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const role = (n) => n.role?.value;
  const nm = (n) => (n.name?.value ?? "").trim();
  const live = nodes.filter((n) => !n.ignored);
  const landmarks = new Set(live.map(role).filter((r) => ["banner", "navigation", "main"].includes(r)));
  const headings = live.filter((n) => role(n) === "heading").map(nm);
  const unnamed = live.filter((n) => INTERACTIVE.has(role(n)) && !nm(n));
  // Tab order: first 12 stops and what a screen reader would announce
  await page.reload();
  await page.waitForTimeout(1000);
  const stops = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    stops.push(await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return "(body)";
      const label = el.getAttribute("aria-label") || el.labels?.[0]?.textContent || el.getAttribute("placeholder") || el.textContent || "";
      return `${el.tagName.toLowerCase()}:${label.trim().slice(0, 40)}`;
    }));
  }
  const emptyStops = stops.filter((s) => /:$/.test(s));
  if (!/skip to content/i.test(stops[0] ?? "")) emptyStops.push("first stop is not a skip link: " + stops[0]);
  const issues = [];
  for (const l of ["banner", "navigation", "main"]) if (!landmarks.has(l)) issues.push(`missing ${l} landmark`);
  if (!headings.length) issues.push("no headings");
  if (unnamed.length) issues.push(`${unnamed.length} unnamed interactive: ${unnamed.slice(0, 4).map((n) => role(n)).join(",")}`);
  if (emptyStops.length) issues.push(`tab stops without names: ${emptyStops.join(" | ")}`);
  problems += issues.length;
  console.log(`${issues.length ? "FAIL" : "PASS"} ${name}: headings=[${headings.slice(0, 4).join(" / ")}] tab=[${stops.slice(0, 5).join(" → ")}]${issues.length ? "\n     " + issues.join("\n     ") : ""}`);
}
console.log(problems ? `\n${problems} screen-reader issues` : "\nscreen-reader structure OK");
await browser.close();
process.exit(problems ? 1 : 0);
