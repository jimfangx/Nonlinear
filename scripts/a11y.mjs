// Accessibility audit (WCAG 2.0/2.1/2.2 A+AA rules via axe-core) across workspaces, light + dark.
// Prereqs: built app on :4173 and mock GitHub on :4010.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { createMockInboxView } from "./mock-inbox.mjs";
const require = createRequire(import.meta.url);
const axeSrc = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const APP = process.argv[2] ?? "http://localhost:4173";
const MOCK = process.argv[3] ?? "http://localhost:4010";
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const results = [];
for (const scheme of ["light", "dark"]) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, bypassCSP: true }); // audit-only: allow injecting axe
  const page = await ctx.newPage();
  await page.goto(`${APP}/#/settings`);
  await page.getByLabel("GitHub API base").fill(MOCK);
  await page.getByPlaceholder("github_pat_…").fill("mock-token");
  await page.getByRole("button", { name: "Save token" }).click();
  await page.getByText("@maintainer").first().waitFor();
  await page.goto(`${APP}/#/inbox`);
  await createMockInboxView(page);
  await page.getByText("Bump BOOM for iteration 95").first().waitFor({ timeout: 15000 });
  await page.locator(".list-row", { hasText: "ucb-bar/chipyard#789" }).click();
  await page.waitForTimeout(800);
  const pages = [
    ["inbox", null],
    ["review-files", "#/pr/ucb-bar/chipyard/789/files"],
    ["review-overview", "#/pr/ucb-bar/chipyard/789/overview"],
    ["review-home", "#/review"],
    ["board", "#/board"],
    ["timeline-list", "#/timeline"],
    ["releases", "#/releases"],
    ["diff", "#/diff"],
    ["graph", "#/graph/ucb-bar/chipyard"],
    ["settings", "#/settings"],
  ];
  for (const [name, hash] of pages) {
    if (hash) await page.goto(`${APP}/${hash}`);
    await page.waitForTimeout(1200);
    await page.addScriptTag({ content: axeSrc });
    const r = await page.evaluate(async () => {
      // @ts-ignore
      const res = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
      return res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, sample: v.nodes.slice(0, 3).map((n) => n.target.join(" ") + " :: " + (n.failureSummary ?? "").split("\n").slice(1, 2).join("")) }));
    });
    results.push({ scheme, name, violations: r });
  }
  await ctx.close();
}
let total = 0;
for (const r of results) {
  for (const v of r.violations) {
    total += v.nodes;
    console.log(`[${r.scheme}/${r.name}] ${v.impact} ${v.id} ×${v.nodes} — ${v.help}\n    ${v.sample.join("\n    ")}`);
  }
}
console.log(total ? `\n${total} violating nodes` : "\nno WCAG A/AA violations found");
await browser.close();
process.exit(total ? 1 : 0);
