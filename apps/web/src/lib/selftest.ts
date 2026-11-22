/**
 * Desktop self-test (NONLINEAR_SELFTEST=1). Runs inside the real Tauri webview and
 * exercises the actual IPC bridge + Rust core, then writes a JSON report and exits.
 * Used by scripts/desktop-selftest.sh; never runs in normal use.
 */
import { parseGitLog } from "@nonlinear/core";
import { invoke, isDesktop } from "./platform";
import { loadAll, putRecord, deleteRecord, putBlob, getBlob, deleteBlob, getSecret, setSecret, outboxAdd, outboxAll, outboxRemove } from "./db";
import { gitLog, gitRefs, gitGitlinks } from "./sources";

interface Mode {
  enabled: boolean;
  ai: string | null;
  repo: string | null;
  scratch: string | null;
}

export async function maybeRunSelftest(): Promise<boolean> {
  if (!isDesktop()) return false;
  const mode = await invoke<Mode>("selftest_mode");
  if (!mode.enabled) return false;
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const check = async (name: string, fn: () => Promise<string | boolean | void>) => {
    try {
      const r = await fn();
      checks.push({ name, ok: r !== false, detail: typeof r === "string" ? r : undefined });
    } catch (e) {
      checks.push({ name, ok: false, detail: String((e as Error)?.message ?? e) });
    }
  };
  // UI mounted?
  await new Promise((r) => setTimeout(r, 1500));
  await check("ui: app shell rendered", async () => !!document.querySelector(".sidebar") && !!document.querySelector(".topbar"));
  await check("sqlite: record put/load/delete", async () => {
    await putRecord("selftest", "x", { v: 42 });
    const ok = (await loadAll()).some((r) => r.collection === "selftest" && (r.value as { v: number }).v === 42);
    await deleteRecord("selftest", "x");
    return ok && !(await loadAll()).some((r) => r.collection === "selftest");
  });
  await check("sqlite: blob + outbox", async () => {
    await putBlob("selftest", "hello");
    const b = await getBlob("selftest");
    await deleteBlob("selftest");
    await outboxAdd({ opId: "selftest-op" });
    const has = (await outboxAll<{ opId: string }>()).some((o) => o.opId === "selftest-op");
    await outboxRemove(["selftest-op"]);
    return b === "hello" && has;
  });
  await check("keychain: set/get/delete", async () => {
    await setSecret("nonlinear-selftest", "s3cret");
    const v = await getSecret("nonlinear-selftest");
    await setSecret("nonlinear-selftest", null);
    return v === "s3cret" && (await getSecret("nonlinear-selftest")) === undefined;
  });
  if (mode.repo) {
    const src = { kind: "local" as const, path: mode.repo };
    await check("git (local source): log/refs", async () => {
      const log = await gitLog(src, "HEAD", 5);
      const refs = await gitRefs(src);
      return log.length > 0 && refs.length > 0 ? `${log.length} commits, ${refs.length} refs` : false;
    });
    await check("git (local source): gitlinks", async () => `${(await gitGitlinks(src, "HEAD")).size} gitlinks`);
    void parseGitLog;
  }
  if (mode.scratch) {
    await check("lsp: clangd definition through webview IPC", async () => {
      const res = await invoke<unknown>("lsp_query", { query: { root: mode.scratch, command: "clangd", args: [], languageId: "c", path: "a.c", method: "definition", line: 3, character: 9 } });
      const first = (Array.isArray(res) ? res[0] : res) as { range?: { start: { line: number } } } | undefined;
      return first?.range?.start.line === 0 ? "definition at line 1" : false;
    });
  }
  await check("mirror: partial clone of a public GitHub repo + log via mirror source", async () => {
    const log = await gitLog({ kind: "mirror", repoKey: "octocat/hello-world" }, "--all", 20);
    return log.length > 0 ? `${log.length} commits via mirror` : false;
  });
  await check("worktree: exact-SHA checkout from mirror", async () => {
    const [head] = await gitLog({ kind: "mirror", repoKey: "octocat/hello-world" }, "HEAD", 1);
    const wt = await invoke<string>("worktree_at", { repoKey: "octocat/hello-world", sha: head!.sha, localRepo: null });
    const readme = await invoke<string>("git_show_file", { repoPath: wt, rev: "HEAD", path: "README" });
    return readme.length > 0 ? `worktree at ${head!.sha.slice(0, 8)}` : false;
  });
  if (mode.ai) {
    // Opt-in only (NONLINEAR_SELFTEST_AI=claude-code): one tiny real prompt through webview → Rust → local CLI.
    await check(`ai adapter: real ${mode.ai} round-trip`, async () => {
      const out = await invoke<string>("ai_local_run", { tool: mode.ai, prompt: "This is an automated connectivity test from the Nonlinear desktop app. Reply with exactly the text NONLINEAR_ADAPTER_OK and nothing else." });
      if (!out.includes("NONLINEAR_ADAPTER_OK")) throw new Error(`unexpected output: ${out.slice(0, 120)}`);
      return `${mode.ai} replied (${out.trim().length} chars)`;
    });
  }
  await check("ai adapters: unknown tool rejected", async () => {
    try {
      await invoke("ai_local_run", { tool: "sh", prompt: "x" });
      return false;
    } catch {
      return true;
    }
  });
  // ---- Drive the real UI in the desktop window like a user would ----
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred: () => boolean, ms = 8000) => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) return false;
      await wait(100);
    }
    return true;
  };
  for (const [route, heading] of [["#/inbox", /repository view|Chipyard|view/i], ["#/timeline", /Timelines?/], ["#/board", /Board/], ["#/review", /Review/], ["#/diff", /Multi-Repository Diff/], ["#/graph", /Git Graph/], ["#/releases", /Releases/], ["#/settings", /Settings/]] as const) {
    await check(`ui: navigate ${route}`, async () => {
      location.hash = route;
      const ok = await waitFor(() => [...document.querySelectorAll("main h1")].some((h) => heading.test(h.textContent ?? "")));
      return ok ? (document.querySelector("main h1")?.textContent ?? "") : false;
    });
  }
  await check("ui: create a feature card by clicking and typing; persisted to SQLite", async () => {
    location.hash = "#/board";
    const findBtn = () => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "+ Card") as HTMLButtonElement | undefined;
    await waitFor(() => document.querySelector("main h1")?.textContent === "Board" && !!findBtn());
    const btn = findBtn();
    if (!btn) throw new Error("+ Card button not found");
    btn.click();
    if (!(await waitFor(() => !!document.querySelector(".modal input")))) throw new Error("card editor did not open");
    const input = document.querySelector(".modal input") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "Desktop selftest card");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await wait(300);
    ([...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Done") as HTMLButtonElement).click();
    const shown = await waitFor(() => [...document.querySelectorAll(".card")].some((c) => c.textContent?.includes("Desktop selftest card")));
    await wait(500);
    const rec = (await loadAll()).find((r) => r.collection === "cards" && (r.value as { title?: string }).title === "Desktop selftest card");
    if (rec) await deleteRecord("cards", rec.id);
    if (shown && rec) return "card rendered and stored in SQLite";
    throw new Error(`shown=${shown} stored=${!!rec} cards=[${[...document.querySelectorAll(".card")].map((c) => c.textContent).join("|")}] titles=[${(await loadAll()).filter((r) => r.collection === "cards").map((r) => (r.value as { title?: string }).title).join("|")}]`);
  });
  await check("ui: command palette opens with ⌘K", async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, ctrlKey: !/mac/i.test(navigator.platform), bubbles: true }));
    return waitFor(() => !!document.querySelector(".palette input"), 3000);
  });
  await check("security: rejects unsafe git revision", async () => {
    try {
      await invoke("git_log", { repoPath: mode.repo ?? "/", rev: "--upload-pack=x", limit: 1 });
      return false;
    } catch {
      return true;
    }
  });
  await invoke("selftest_report", { report: { at: new Date().toISOString(), ok: checks.every((c) => c.ok), checks } });
  return true;
}
