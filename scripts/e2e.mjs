// End-to-end journeys (design §13) against the mock GitHub API.
// Prereqs: built web app served (vite preview :4173) and `node scripts/mock-github.mjs 4010`.
// Usage: node scripts/e2e.mjs [appUrl] [mockUrl]
import { chromium } from "playwright-core";
import { createMockInboxView } from "./mock-inbox.mjs";

const APP = process.argv[2] ?? "http://localhost:4173";
const MOCK = process.argv[3] ?? "http://localhost:4010";
const SHOTS = process.env.SHOTS ?? "/tmp";
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};
const shot = (n) => page.screenshot({ path: `${SHOTS}/e2e-${n}.png` });
const step = async (name, fn) => {
  try {
    await fn();
  } catch (e) {
    check(name, false, e.message.split("\n")[0]);
    await shot(`fail-${name.replace(/\W+/g, "-")}`);
  }
};

// ---- Setup: point at mock, sign in with a token (journey A / F) ----
await step("setup", async () => {
  await page.goto(`${APP}/#/settings`);
  await page.getByLabel("GitHub API base").fill(MOCK);
  await page.getByPlaceholder("github_pat_…").fill("mock-token");
  await page.getByRole("button", { name: "Save token" }).click();
  await page.getByText("@maintainer").first().waitFor({ timeout: 10000 });
  check("A: sign in with token, no org App install", true);
});

// ---- Journey A: cross-org inbox ----
await step("A inbox", async () => {
  await page.goto(`${APP}/#/inbox`);
  await createMockInboxView(page);
  await page.getByText("Bump BOOM for iteration 95").first().waitFor({ timeout: 15000 });
  await page.getByRole("tab", { name: /Needs my review/ }).click();
  const needs = await page.locator(".list-row").allTextContents();
  check("A: 'Needs my review' contains chipyard#789", needs.some((t) => t.includes("Bump BOOM")), `${needs.length} rows`);
  await page.getByRole("tab", { name: /My drafts/ }).click();
  check("A: 'My drafts' contains #790", (await page.locator(".list-row").allTextContents()).some((t) => t.includes("Pixi")));
  await page.getByRole("tab", { name: /All open/ }).click();
  const all = await page.locator(".list-row").allTextContents();
  check("A: cross-org PRs listed (chipyard + riscv-boom)", all.some((t) => t.includes("riscv-boom/riscv-boom#123")) && all.some((t) => t.includes("ucb-bar/chipyard#789")));
  await page.locator(".list-row", { hasText: "riscv-boom/riscv-boom#123" }).click();
  await page.waitForTimeout(500);
  const editBtns = await page.getByRole("button", { name: "Edit", exact: true }).count();
  check("A: read-only upstream PR shows no enabled write actions", editBtns === 0, `edit buttons=${editBtns}`);
  await shot("A-inbox");
});

// ---- Journey B: chain detection + managed block write ----
await step("B chain", async () => {
  await page.locator(".list-row", { hasText: "ucb-bar/chipyard#789" }).click();
  await page.getByText(/2 PRs · linear stack/).waitFor({ timeout: 10000 });
  check("B: Depends-On detected (BOOM#123 → Chipyard#789)", true);
  await page.locator(".list-row", { hasText: "riscv-boom/riscv-boom#123" }).click();
  await page.getByText(/2 PRs · linear stack/).waitFor({ timeout: 5000 });
  check("B: same chain panel on upstream member", true);
  // Add prerequisite to the writable draft PR #790 and write the managed block.
  await page.getByRole("tab", { name: /All open/ }).click();
  await page.locator(".list-row", { hasText: "ucb-bar/chipyard#790" }).click();
  await page.getByRole("button", { name: "+ Prerequisite" }).click();
  await page.getByPlaceholder(/owner\/repo#123/).fill("ucb-bar/chipyard#789");
  await page.getByRole("button", { name: "Preview" }).click();
  await page.getByText("will update").first().waitFor({ timeout: 5000 });
  await shot("B-preview");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText(/Updated managed block in ucb-bar\/chipyard#790/).waitFor({ timeout: 10000 });
  const body = await (await fetch(`${MOCK}/repos/ucb-bar/chipyard/pulls/790`)).json();
  check("B: managed block written to writable PR", /<!-- nonlinear:chain:start v1 id=chain_\w+ -->\nDepends-On: https:\/\/github.com\/ucb-bar\/chipyard\/pull\/789/.test(body.body), body.body.replace(/\n/g, "⏎").slice(0, 160));
  await page.getByText(/3 PRs · linear stack/).waitFor({ timeout: 5000 });
  check("B: chain grows to 3 members", true);
});

// ---- Journey D: review interruption & revision-aware progress ----
await step("D review", async () => {
  await page.goto(`${APP}/#/pr/ucb-bar/chipyard/789/files`);
  await page.locator(".rail").waitFor({ timeout: 10000 });
  const nos = page.locator(".dl .no");
  await nos.nth(1).click();
  await nos.nth(3).click({ modifiers: ["Shift"] });
  await page.keyboard.press("x");
  const rail = page.locator(".rail");
  await rail.focus();
  await page.keyboard.press("End");
  await page.waitForTimeout(200);
  check("D: frontier at end but flagged hole keeps file incomplete", (await page.locator(".toolbar .chip", { hasText: "incomplete" }).count()) > 0);
  // private note
  await nos.nth(5).click();
  await page.getByRole("button", { name: "✎ Private note" }).click();
  await page.getByRole("textbox", { name: "Private note" }).fill("Confirm this default matches the release config");
  await page.getByRole("button", { name: "Save note" }).click();
  // draft GitHub comment
  await nos.nth(6).click();
  await page.keyboard.press("c");
  await page.getByRole("textbox", { name: "Draft GitHub comment" }).fill("Could this filter drop a valid update?");
  await page.getByRole("button", { name: "Save draft" }).click();
  check("D: selected review ranges render notes and drafts inline", await page.locator(".diff-annotation details").count() === 2);
  await page.keyboard.press("Escape");
  check("D: Escape clears the selected range", await page.locator(".dl.sel").count() === 0);
  await shot("D-review");
  // Offline reopen: progress survives
  await ctx.setOffline(true);
  await page.reload();
  await page.locator(".rail").waitFor({ timeout: 10000 });
  const fr = await page.locator(".rail").getAttribute("aria-valuenow");
  check("D: progress + note survive offline reopen", Number(fr) > 0 && (await page.getByText("Confirm this default").count()) > 0, `frontier=${fr}`);
  await ctx.setOffline(false);
  // Submit review: the draft comment goes to GitHub; the private note does not.
  await page.getByRole("button", { name: /Submit review \(1\)/ }).click();
  await page.locator(".modal textarea").fill("Mostly fine");
  await page.getByRole("button", { name: "Submit to GitHub" }).click();
  await page.getByText("Review submitted to GitHub").waitFor({ timeout: 10000 });
  const revs = await (await fetch(`${MOCK}/repos/ucb-bar/chipyard/pulls/789/comments`)).json();
  check("D: GitHub comment posted; private note not posted", revs.some((c) => c.body.includes("drop a valid update")) && !JSON.stringify(revs).includes("matches the release config"));
  // New commit modifies one reviewed hunk
  await page.locator(".rail").focus();
  await page.keyboard.press("End");
  await page.locator(".dl.flagged").first().waitFor();
  await page.locator(".dl .no").nth(1).click();
  await page.locator(".dl .no").nth(3).click({ modifiers: ["Shift"] });
  await page.keyboard.press("r");
  await page.waitForTimeout(200);
  const before = await page.locator(".toolbar .chip", { hasText: /complete/ }).first().textContent();
  await fetch(`${MOCK}/_push/${encodeURIComponent("ucb-bar/chipyard#789")}`, { method: "POST" });
  await page.getByRole("button", { name: "↻" }).click();
  await page.getByText(/New commits since your last review/).waitFor({ timeout: 10000 });
  const stale = await page.locator(".dl.stale").count();
  const reviewed = await page.locator(".dl.reviewed").count();
  check("D: changed hunk marked for re-review, unchanged work preserved", stale > 0 && reviewed > 0, `before='${before}', stale rows=${stale}, reviewed rows=${reviewed}`);
  await shot("D-remap");
});

// ---- Semantic expansion via tree-sitter (§5.4) ----
await step("semantic", async () => {
  await page.goto(`${APP}/#/pr/ucb-bar/chipyard/789/files`);
  await page.locator(".dl.hunk").nth(1).waitFor({ timeout: 10000 });
  await page.locator(".dl.hunk").nth(1).getByTitle("Expand to enclosing block").click();
  const row = page.locator('.dl[title^="Expanded (tree-sitter: class definition"]');
  await row.first().waitFor({ timeout: 15000 });
  check("§5.4: expand-up uses tree-sitter boundary (enclosing class)", (await row.count()) === 1);
  await page.getByRole("button", { name: "⛶ Inspect" }).click();
  await page.getByLabel("Symbols").getByText(/def selectOldest/).click();
  await page.getByText(/class IssueUnit.*›.*def selectOldest/).waitFor({ timeout: 10000 });
  check("§5.4: inspector shows exact SHA, outline and breadcrumbs", (await page.locator(".chip.mono", { hasText: "@c0ff" }).count()) > 0);
  await page.getByPlaceholder(/Split with/).fill("generators/chipyard/src/main/scala/config/BoomConfigs.scala");
  await page.getByPlaceholder(/Split with/).press("Enter");
  await page.waitForTimeout(800);
  check("§5.4: inspector split shows two panes with repo+SHA headers", (await page.locator(".chip.mono", { hasText: "@" }).count()) >= 2);
  await shot("inspector");
  await page.getByRole("button", { name: "Close" }).last().click();
  await shot("semantic");
});

// ---- Submodule expansion (§5.1) ----
await step("submodule", async () => {
  await page.locator(".tree-row", { has: page.locator(".chip", { hasText: "sub" }) }).first().click();
  await page.getByRole("button", { name: "Expand submodule change" }).click();
  await page.getByText(/provisional/).waitFor({ timeout: 10000 });
  check("§5.1: gitlink expands to nested diff, provisional pin labelled", true);
  await shot("submodule");
});

// ---- §2.4: upstream squash merge → proposed gitlink update (journey B tail) ----
await step("B reconcile", async () => {
  await fetch(`${MOCK}/_merge/${encodeURIComponent("riscv-boom/riscv-boom#123")}`, { method: "POST" });
  await page.goto(`${APP}/#/pr/riscv-boom/riscv-boom/123/overview`);
  await page.getByRole("button", { name: "↻" }).click();
  await page.locator(".chip", { hasText: "Merged" }).first().waitFor({ timeout: 10000 });
  await page.goto(`${APP}/#/pr/ucb-bar/chipyard/789/files`);
  await page.locator(".tree-row", { has: page.locator(".chip", { hasText: "sub" }) }).first().click();
  await page.getByRole("button", { name: "Expand submodule change" }).click();
  await page.getByText(/merged \(squash\)/).waitFor({ timeout: 15000 });
  const verified = await page.locator(".chip", { hasText: "verified" }).count();
  check("B: squash merge detected; proposed gitlink verified by tree equality", verified > 0);
  await shot("B-reconcile");
});

// ---- Journey C: timeline + release pins + apply preview ----
await step("C timeline", async () => {
  await page.goto(`${APP}/#/releases`);
  await page.getByRole("button", { name: "+ New release" }).click();
  const release = page.getByRole("dialog", { name: "New release" });
  check("New releases have a blank name and repository", await release.getByLabel("Name", { exact: true }).inputValue() === "" && await release.getByLabel("Root repository").inputValue() === "");
  await release.getByLabel("Name", { exact: true }).fill("Chipyard vNext");
  await release.getByLabel("Root repository").fill("ucb-bar/chipyard");
  await page.getByRole("button", { name: "Create" }).click();
  await page.goto(`${APP}/#/timeline`);
  await page.getByRole("button", { name: "New timeline" }).click();
  const timeline = page.getByRole("dialog", { name: "New timeline view" });
  check("New timelines require an explicit repository", await timeline.getByLabel("Root repository").inputValue() === "" && await timeline.getByRole("button", { name: "Create" }).isDisabled());
  await timeline.getByLabel("Root repository").fill("ucb-bar/chipyard");
  await page.getByRole("button", { name: "Create" }).click();
  await page.locator(".tl-row", { hasText: "generators/boom" }).waitFor({ timeout: 15000 });
  await page.locator(".tl-row", { hasText: "generators/boom" }).getByText("PR #124").waitFor({ timeout: 15000 });
  check("§3.1: open upstream PR shown on the submodule row", true);
  await page.locator(".tl .tl-label").first().click();
  await page.keyboard.press("j");
  await page.locator(".tl-row.highlighted").first().waitFor();
  await page.keyboard.press("Escape");
  check("Timeline J selects a submodule and Escape clears it", (await page.locator(".tl-row.highlighted").count()) === 0);
  await page.getByLabel("Release to edit").selectOption({ index: 1 });
  const handle = page.getByRole("slider", { name: /Chipyard vNext pin for generators\/boom/ });
  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(300);
  const val = await handle.getAttribute("aria-valuetext");
  check("C: keyboard drag sets draft pin for one row only", /^b00b00/.test(val ?? ""), val ?? "");
  await shot("C-timeline");
  await page.goto(`${APP}/#/releases`);
  await page.locator(".list-row", { hasText: "Chipyard vNext" }).click();
  await page.getByRole("button", { name: "Apply planned pins…" }).click();
  await page.getByRole("button", { name: "Compute preview" }).click();
  await page.getByText(/gitlink changes across/).waitFor({ timeout: 10000 });
  check("C: apply preview shows gitlink old → new", (await page.getByText(/→ b00b00/).count()) > 0);
  await page.getByRole("button", { name: "Open draft PR…" }).click();
  await page.getByRole("button", { name: "Create branch + draft PR" }).click();
  await page.waitForTimeout(1500);
  const created = await (await fetch(`${MOCK}/repos/ucb-bar/chipyard/_created`)).json();
  check("C: explicit confirm → branch + draft PR (no silent push)", created.refs.length === 1 && created.pulls[0]?.draft === true, JSON.stringify(created.refs));
  await shot("C-apply");
});

// ---- Journey F: org restriction + offline intentions ----
await step("F permissions/offline", async () => {
  await page.goto(`${APP}/#/pr/riscv-boom/riscv-boom/123/conversation`);
  await page.waitForTimeout(1000);
  await ctx.setOffline(true);
  await page.locator("textarea").fill("Queued while offline");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByText(/queued/).first().waitFor({ timeout: 5000 });
  check("F: offline write becomes a pending intention", (await page.getByText(/1 pending/).count()) > 0);
  await ctx.setOffline(false);
  const before = await (await fetch(`${MOCK}/repos/riscv-boom/riscv-boom/issues/123/comments`)).json();
  check("F: intention not auto-posted when back online", before.length === 0);
});

await step("graph", async () => {
  await page.goto(`${APP}/#/graph/ucb-bar/chipyard`);
  await page.locator(".graph-row").first().waitFor({ timeout: 10000 });
  check("§7: git graph renders lanes", (await page.locator(".graph-row").count()) >= 6);
  const refs = page.getByRole("combobox", { name: "Add branch or tag" });
  await refs.selectOption("tag:v1.0.0");
  await page.getByRole("button", { name: "Remove tag v1.0.0" }).waitFor();
  check("Git Graph can add a tag as a comparison ref", true);
  await page.locator(".graph-row").first().click();
  const close = page.getByRole("button", { name: "Close commit details" });
  await close.focus();
  await page.keyboard.press("Escape");
  await close.waitFor({ state: "hidden" });
  check("Escape closes Git Graph commit details", true);
  await shot("graph");
});

check("no uncaught page errors", errors.length === 0, errors.join(" | "));
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
await browser.close();
process.exit(failed ? 1 : 0);
