# Nonlinear: implementation notes (agent handoff)

The product is **Nonlinear**. The design calls it "Maintainer Workbench".
Specs live in `design/chipyard_maintainer_workbench_design-v2_impl_robot.md` (authoritative)
and `design/v2_refined` (human summary). Section refs below (§n) point to the authoritative doc.

## Layout

```
packages/core/     Pure TS domain logic + tests (vitest). No DOM/React. Imported as @nonlinear/core.
apps/web/          React 19 + Vite PWA, the shared UI for the web and desktop builds.
apps/desktop/      Tauri 2 shell (Rust core: local git, SQLite, SSH helper) wrapping apps/web.
services/sync/     Cloudflare Worker + D1: encrypted op-log sync + OAuth BFF.
design/            Specs (do not edit).
```

Commands (from repo root): `npm install`, `npm test`, `npm run typecheck`, `npm run dev` (web).

## Naming decisions
- Managed PR-body marker is `<!-- nonlinear:chain:start v1 id=... -->` / `<!-- nonlinear:chain:end -->`.
  The parser also accepts the legacy `maintainer-workbench:` marker from the design doc.
- Release manifest export format: `"format": "nonlinear-release-manifest", "version": 1`.

## Status by phase (§14)

Legend: ✅ done + tested · 🟡 partial · ⬜ not started

### packages/core
| Module | § | Status | Notes |
|---|---|---|---|
| `ids.ts` | 1 | ✅ | PRKey = lowercased `owner/repo#n`; submodule identity tuple |
| `chain/parser.ts` | 2.2 | ✅ | Depends-On / PR Stack / Chain, list forms, fences/quotes ignored, inferred candidates (never auto-accepted) |
| `chain/dag.ts` | 2.2 | ✅ | DAG, cycle rejection w/ explanation, topo/linear/layers, readiness *explanations* (no single "ready" flag) |
| `chain/managedBlock.ts` | 2.3 | ✅ | upsert/remove by id, 3-way `rebaseManagedUpdate` (conflict if our block was edited remotely) |
| `chain/reconcile.ts` | 2.2-2.3 | ✅ | bodies + local edges → graph with Synced/Local only/Pending/Conflict; mutation preview |
| `diff/unified.ts` | 5.5, 6 | ✅ | single-pass offset index, lazy hunk parse, split rows, validation (truncation, unsafe paths, binary, gitlink, rename, mode) |
| `diff/multiRepo.ts` | 6 | ✅ | JSON import; root and submodule grouping, empty patch handling, file indexing, and lazy hunk parsing |
| `review/intervals.ts` | 5.3 | ✅ | frontier + reviewed + flagged + stale intervals; revision remap by unambiguous hunk content hash; note anchors |
| `review/semantic.ts` | 5.4 | ✅ | heuristic fallback (labelled). Engines, best first: **any LSP server** (desktop; registry in Settings: Metals, clangd, pyright, rust-analyzer, tsserver, verible, gopls, jdtls, user-added), tree-sitter (`apps/web/src/lib/treesitter.ts`), heuristic |
| `inbox/classify.ts` | 2.1, 8 | ✅ | computed categories, editable policy, capabilities derivation |
| `submodule/gitmodules.ts` | 3.1 | ✅ | parse, URL resolution incl. relative URLs |
| `submodule/reconcile.ts` | 2.4 | ✅ | merge/squash/rebase detection → proposed gitlink with evidence/confidence |
| `release/manifest.ts` | 3.2-3.3 | ✅ | export, apply plan, gitlink patch, conflicts, nested consistency, 3-way pin merge |
| `graph/commits.ts` | 3.1, 7 | ✅ | ancestry ("unknown" on truncated history), merge-base, align-to-date, lane layout, time scale |
| `kanban/board.ts` | 4 | ✅ | shared cards, per-context placements, fractional ranks |
| `sync/oplog.ts` | 10 | ✅ | op store (field LWW; strict 3-way kinds raise conflicts), AES-GCM + PBKDF2 E2E encryption, private-repo guard |
| `ai/budget.ts` | 5.2, 11 | ✅ | model table, reserve/settle ledger ($70 warn / $95 stop), cache keys, bounded prompts |
| `github/client.ts` | 8 | ✅ (untested against live API in CI) | bounded fetch, ETag cache, error kinds (org-restricted, rate-limited…), public-only guard |
| `github/intentions.ts` | 9 | ✅ | offline pending intentions → `needs-confirmation`, never auto-sent |
| `sync/pairing.ts` | 10 | ✅ | one-click sync key, recovery key `NL1-…` (Crockford base32 — **not** base64url, whose `-` collided with the group separator), key-check, ECDH P-256 device pairing + verification code |
| `graph/gitText.ts` | 9 | ✅ | parsers for raw git output from the SSH helper (log/ls-tree/for-each-ref); tested against the real helper script |
| `inbox/classify.ts` → `diffSnapshots` | 2.1 | ✅ | recent-event summaries derived from successive snapshots |

### apps/web (React 19 + Vite 8 PWA, zustand, IndexedDB via idb)
| Area | § | Status | Where |
|---|---|---|---|
| Shell: sidebar, top bar (online/offline, rate limit, public-only, theme), ⌘K palette, toasts, persisted split panes | 1, 12 | ✅ | `App.tsx`, `components/ui.tsx`, `CommandPalette.tsx` |
| Local store (collections → IndexedDB, sync outbox for user-owned kinds) | 9 | ✅ | `lib/store.ts`, `lib/db.ts` |
| GitHub service: bounded client, PR mirror, enrichment budget when anonymous, fresh permission check before writes, offline → intentions | 8, 9 | ✅ | `lib/github.ts` |
| Workspace A: views + repo picker, computed categories, release lens, grouping, multi-select pin/snooze, unread, PR details + edits, chain panel w/ mutation preview + managed block writes | 2 | ✅ | `workspaces/Inbox.tsx`, `PRDetail.tsx`, `components/ChainPanel.tsx`, `lib/chains.ts` |
| Gitlink merge reconciliation proposals UI (merge/squash/rebase → proposed SHA w/ evidence; patch or draft review comment; never pushes) | 2.4 | ✅ | `ReviewFiles.tsx` → `GitlinkReconcile` |
| Workspace B: timeline (rows from .gitmodules at root commit, calendar axis, pins, tags, branch tip, diverged marking), release handles (drag + keyboard), align-to-date suggestions, split view w/ shared crosshair + x-scroll, child timelines, nested consistency warnings, propagate upward | 3 | ✅ | `workspaces/Timeline.tsx`, `lib/timeline.ts` |
| Releases: freeze, criteria, compare to tag, export JSON/lock, apply preview w/ checks, patch download, branch + draft PR via Git Data API after confirm | 3.2 | ✅ | `workspaces/Releases.tsx` |
| Workspace C: kanban w/ per-context placements, DnD + Alt+Arrows, card editor (checklist, PRs, links, deps, releases, notes) | 4 | ✅ | `workspaces/Board.tsx` |
| Workspace D: review home (All/Open/Closed), 3-pane review, frontier rail, flags, stale, notes, draft comments → GitHub review API, remap on new head, chain prev/next + breadcrumbs, submodule expansion w/ provisional label, semantic expand (heuristic), inspector w/ split, impact (heuristic; CodeGraph on desktop), AI summaries w/ preview + cost | 5 | ✅ | `workspaces/Review*.tsx`, `FileInspector.tsx`, `components/FileDiff.tsx`, `lib/review.ts`, `lib/ai.ts` |
| Workspace E: worker reads the File itself, indexes, **spills every file section to IndexedDB** (`lib/importStore.ts`), UI loads one section at a time; async content search over spilled data; instant offline re-open (no re-parse) | 6 | ✅ | `workspaces/DiffViewer.tsx`, `workers/diff.worker.ts` |
| Workspace F: lane graph, refs/PR/pin labels, compare/merge preview, gitlinks at commit, diff; **data source picker: GitHub API / local working tree / SSH host** | 7 | ✅ | `workspaces/GitGraph.tsx`, `lib/sources.ts` |
| Inbox recent activity (list line "↳ …" since last viewed + PR detail panel) | 2.1 | ✅ | `lib/github.ts#storeSnapshots`, `prEvents` collection |
| Timeline: PR markers on rows (open PRs at head-commit date, dashed = draft); **source picker GitHub / local / SSH** (child history read from checked-out submodules) | 3.1, 9 | ✅ | `lib/timeline.ts`, `workspaces/Timeline.tsx` |
| Sync conflicts: pull-before-push, 3-way base tracking for pins/chain edges/chains, conflict queue + Keep mine / Take theirs | 10 | ✅ | `lib/sync.ts`, Settings → Sync conflicts, top-bar chip |
| Inspector: LSP Definition / References (double-click identifier), warns when working-tree HEAD ≠ viewed SHA; Impact: "Confirm with <server>" → confirmed references | 5.4 | ✅ (desktop) | `lib/lsp.ts`, `FileInspector.tsx`, `ReviewFiles.tsx` |
| Accessibility: axe-core WCAG 2.0/2.1/2.2 A+AA audit, light + dark, 10 views → **0 violations** (`scripts/a11y.mjs`); screen-reader structure audit over Chrome's accessibility tree (`scripts/sr-audit.mjs`): landmarks, semantic h1–h3 per view, named controls, "Skip to content" first tab stop → 9/9 views pass | 12 | ✅ automated | a manual VoiceOver/NVDA listen-through still needs a human |
| Settings: Nonlinear Cloud **Connect** (one click), PAT, device flow (desktop), public-only, API base (GHE / mock), intentions queue, policy, AI keys/models/budgets/per-repo policy, keybindings, columns, SSH hosts, export/wipe | 8-11 | ✅ | `workspaces/Settings.tsx`, `lib/cloud.ts`, `components/CloudGlue.tsx` |

### services/sync (Cloudflare Worker + D1)
✅ OAuth BFF (scopes only "" or `public_repo`; refuses over-scoped tokens; token AES-GCM sealed in D1; one-time code → session; HttpOnly cookie + CSRF double-submit or bearer),
`/gh/*` bounded proxy (writes need `public_repo`), `/v1/ops` idempotent encrypted op log with cursor, `/v1/keycheck`, `/v1/pair*` device-pairing relay, `/v1/me`.
Tests: `services/sync/test/worker.test.ts` uses a D1 shim over `node:sqlite` running the real migrations.

**One-click Connect** (user request): Settings → Nonlinear Cloud → "Connect with GitHub". The service URL is baked in at build time via
`VITE_NONLINEAR_CLOUD_URL` (override under "Advanced: self-hosted service"). First device auto-creates the E2E key; later devices pair by approval
(matching 6-digit code) or recovery key. GitHub calls then go through `${cloud}/gh` so the token never reaches the browser.

### apps/desktop (Tauri 2)
✅ `src-tauri/src/store.rs` SQLite WAL store (records/blobs/outbox) — `apps/web/src/lib/db.ts` routes to it when running in Tauri; secrets → OS keychain (`keyring`).
✅ `git.rs` git CLI with argv only, rev/path validation, timeouts, output caps (log/refs/gitlinks/diff/show/checkout --detach refusing dirty trees).
✅ `remote.rs` SSH offload with allowlisted task kinds → `apps/desktop/nonlinear-helper.sh` (install unprivileged on remote), CodeGraph CLI runner.
✅ GitHub device flow (no client secret in binary). `cargo test` = 5 tests; `npx tauri build --debug --bundles app` produces `Nonlinear.app` (verified).
✅ `lsp.rs` generic JSON-RPC/stdio LSP client (any server; one process per root+command; argv only; timeouts). Real end-to-end test against **clangd** (definition/references/documentSymbol) when installed.
✅ `oauth.rs` system-browser sign-in: RFC 8252 loopback listener + `open_external` (https/loopback only); PKCE enforced by the Worker. `scripts/e2e-desktop-oauth.mjs` verifies the protocol against the real Worker.
✅ SSH helper kinds: version, git-log, gitlinks, refs, show-file, diff, codegraph (argv validated in Rust; output parsed by core `gitText.ts`).
✅ **Desktop self-test**: `scripts/desktop-selftest.sh` launches the real `Nonlinear.app` with `NONLINEAR_SELFTEST=1` (window stays hidden), runs `apps/web/src/lib/selftest.ts` inside the actual webview → IPC → Rust (UI mounted, SQLite records/blobs/outbox, keychain, git via local source, clangd LSP, unsafe-rev rejection), writes a JSON report and exits. 
✅ `mirror.rs`: managed **blob-less partial bare mirrors** of public GitHub repos in the app data dir (§9), surfaced as a "mirror cache" data source for Timeline and Git Graph (child submodules use their own mirrors). Also **worktree-at-SHA**: a detached `git worktree` at the exact PR head in the app cache, so LSP and Impact analyse precisely the reviewed revision without touching the user's checkout. Worktrees are pruned after 14 days.
✅ `ai_local.rs`: optional local adapters **Claude Code** (`claude -p`) and **Codex CLI** (`codex exec -`). Prompt goes via stdin, with a timeout and output cap, and the same per-repo policy and preview as API providers. Cost to the app budget is $0. Antigravity is intentionally not offered (no supported public API).
Desktop self-test (`scripts/desktop-selftest.sh`): **21/21** checks in the real app. Besides the IPC, git, LSP, mirror and worktree checks, it drives the actual UI in the desktop webview: all 8 workspaces, creating a card by click + typing (verified persisted in SQLite), and the ⌘K palette. Live partial-mirror coverage includes, including a live partial mirror of `octocat/Hello-World` and an exact-SHA worktree from it. `cargo test`: 14.

### Deviation from design §9 (deliberate)
The design puts "parsing and graph layout" in the Rust core. Diff indexing and lane layout live in **TypeScript** (`packages/core`) and run in a Web Worker, so the web PWA and the desktop app share one implementation. They meet the performance targets (51 MB in about 280 ms). Move them to Rust/WASM only if profiling on real data shows a need.

## Testing
- `npm test` — core (61 + 1 skipped benchmark) + web (4) + sync worker (8). `cd apps/desktop/src-tauri && cargo test` — Rust (11, incl. clangd LSP round-trip).
- `node scripts/a11y.mjs` — axe WCAG audit (needs app + mock running).
- `node scripts/e2e-desktop-oauth.mjs` — desktop loopback+PKCE protocol against the running Worker.
- Large-import benchmark: `cd packages/core && BENCH=1 npx vitest run test/bench.large.test.ts` → 51 MB / 3504 files indexed in ~280 ms.
- E2E (headless local Chrome via playwright-core; no browser download):
  1. `node scripts/mock-github.mjs 4010` — deterministic GitHub mock (chain scenario, OAuth, `/_push/<pr>` hook to simulate new commits).
  2. `cd apps/web && VITE_NONLINEAR_CLOUD_URL=http://localhost:8787 npx vite build && npx vite preview --port 4173`
  3. `node scripts/e2e.mjs` → journeys A, B (+ §2.4 squash reconcile), C (+ timeline PR markers), D, F, tree-sitter expansion, inspector, submodule, graph (26 checks).
  4. For cloud: `cd services/sync && npx wrangler d1 migrations apply nonlinear --local && npx wrangler dev --local --port 8787 --var GITHUB_API:http://localhost:4010 --var GITHUB_WEB:http://localhost:4010 --var TOKEN_KEY:<base64 32B> --var GITHUB_CLIENT_SECRET:x --var ALLOWED_ORIGINS:http://localhost:4173`, then `node scripts/e2e-cloud.mjs` (two-device pairing, conflict resolution, recovery key; 10 checks). **Not idempotent**: delete `services/sync/.wrangler/state` and re-apply migrations before each run (the mock always logs in the same user).
  5. `node scripts/smoke.mjs http://localhost:4173 <path-to-diff.json>` — optional JSON diff import journey E + general smoke (no network needed except .gitmodules lookup).
- Live GitHub: `scripts/smoke-live.mjs` (anonymous; 60 req/h limit is easy to exhaust).

## GitHub access policy
The app, the scripts and the services use **only the GitHub REST API** (web/desktop `GitHubClient`; sync Worker proxy at `/gh/*`, which is an HTTP path, not the CLI). Nothing invokes the `gh` CLI or reuses a user's gh login; `apps/web/test/no-gh-cli.test.ts` enforces this. The web client factory is `githubApi()` in `apps/web/src/lib/github.ts`.

## Gotchas learned
- zustand v5: selectors returning new arrays/objects loop forever (React #185). Use `useShallow` or select the raw record + `useMemo`.
- GitHub `.diff` `index` lines carry *abbreviated* blob ids; never trust blob-id equality alone for review remap (now also compares row content).
- CSP in `apps/web/index.html` must list the cloud origin if it's not `*.workers.dev`/localhost; WASM (tree-sitter) needs `'wasm-unsafe-eval'`.
- web-tree-sitter must stay at **0.20.8** to load the `tree-sitter-wasms@0.1.13` grammars (newer runtimes reject the old ABI). Read node fields *before* `tree.delete()`.
- Mock fixtures: hunk header counts must be exact — the indexer correctly flags mismatches as truncation.

## Live GitHub verification — ✅ done 2026-11-22
Against **`jimfangx/nonlinear-test`** (kept; do not delete) with a fine-grained PAT scoped to that repo (read from `~/.config/nonlinear/test-token`, never printed): `node scripts/live-prs-single.mjs jimfangx/nonlinear-test` then `node scripts/e2e-live.mjs` → **7/7 live checks passed**:
Depends-On chain detection · managed chain block written to PR #3 · exactly one block after re-saving from a fresh device · label written · inline review comment anchored + review submitted on PR #2 · conversation comment · gitlink-bump **draft PR #4** created via the Git Data API with the pinned SHA.
Bug found and fixed by the live run: a fresh device minted a new managed-block id and would have appended a second block. `chainIdFor` (`apps/web/src/lib/chains.ts`) now reuses ids already present in members' PR bodies.
The script is re-runnable: it reuses existing PRs and uses a unique label per run.

## Local AI adapter — ✅ verified in-app 2026-11-22
`NONLINEAR_SELFTEST_AI=claude-code scripts/desktop-selftest.sh` → **22/22**, including a real Claude Code round-trip (webview → IPC → Rust → `claude -p`). Fixes that made it work from a GUI launch:
- `augment_path()` at startup: Finder/Dock launches get a minimal PATH; adds ~/.local/bin, Homebrew, ~/.cargo/bin, Coursier.
- The adapter runs the CLI in an empty sandbox cwd (not `/` or user repos) and drains stderr concurrently.
- In AI self-test mode the window is shown and focused. A hidden, never-activated app stalled the CLI call; a keychain prompt was suspected but none appeared on the passing run.
The app toasts a note that macOS *may* ask once to allow access to the CLI's saved login (keychain). Codex CLI is wired identically but was not invoked (the user asked for Claude Code only).

## Distribution build (macOS)
`cd apps/desktop && npx tauri build --bundles app`, then `scripts/make-dmg.sh` produces `src-tauri/target/release/bundle/Nonlinear_<ver>_arm64.dmg` (about 6 MB).
Tauri's own DMG step can fail with `hdiutil: couldn't unmount … Resource busy` (Spotlight or another app holding the temp image), which is why the plain-hdiutil script exists. Bundle identifier is `dev.nonlinear.desktop` (it was `dev.nonlinear.app`; Tauri warns about the `.app` suffix). The current build is **ad-hoc signed, arm64 only**. Public distribution needs a Developer ID signature + notarization, and Intel/universal builds need rustup targets (Rust here is from Homebrew, without rustup). The release-binary self-test passes.

## Remaining items
None known. The user waived the manual VoiceOver/NVDA pass. Live GitHub writes and the Claude Code adapter are verified.
