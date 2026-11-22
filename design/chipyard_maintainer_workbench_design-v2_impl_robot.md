# Maintainer Workbench — Product and Technical Design

**Status:** Proposed design, v0.2 · **Date:** November 22, 2026  
**Form factors:** macOS/Windows/Linux desktop application and installable web application (PWA)  
**Primary persona:** Maintainer coordinating releases across independently owned GitHub repositories and nested Git submodules

## 0. Product definition and design decisions

Maintainer Workbench is a **local-first, GitHub-native release and code-review workspace**. It brings together PR triage, cross-repository dependency chains, versioned submodule pins, release planning, kanban, large-diff review, and Git history. It must not require installation of a GitHub App into any upstream organization. GitHub remains the source of truth for PRs, reviews, issues, and repository permissions; the Workbench owns private notes, review progress, release plans, kanban cards, and cached code intelligence.

The user does **not** commit to sprint dates or release deadlines. Releases are named sets of target Git revisions and qualification criteria. A release can appear simultaneously in every repository timeline and kanban view, but no date is required.

**Resolved design choices**

| Question | Decision |
|---|---|
| Desktop/web implementation | **Tauri 2 + React/TypeScript** desktop; the same React application as a PWA; Rust core for local Git, parsing, graph layout, and SSH jobs |
| Primary source of truth | **GitHub** for external entities; **local SQLite** for user-owned entities; optional encrypted cloud sync |
| Remote GitHub access | Personal GitHub OAuth, with no organization GitHub App; no-scope read-only first, optional `public_repo` consent for public-repo writes |
| Private repos | Out of scope by default; never request classic `repo` scope. An optional separately consented fine-grained token may be restricted to explicitly selected repositories, subject to organization policy |
| Cross-org dependency editing | Read arbitrary public PRs; write canonical chain metadata only to PRs/branches the user is authorized to modify; retain other edges locally and show sync limitations |
| Submodule release editor | A **draft target manifest**, not a direct write to repository history. Generate a PR/patch only after preview and explicit confirmation |
| Large diffs | Streaming/worker-based parsing, virtualized file/hunk views, content-addressed caches, and an optional remote compute executor |
| Cloud backend | Start with **Cloudflare Workers + D1** for small encrypted user data; keep full Git mirrors, codegraph indexes, provider keys, and large patch blobs local |
| AI | Provider-neutral API, explicit per-model budget, cheap default summarization, escalation on demand, no unapproved code uploads |

## 1. Main navigation and shared object model

The six primary workspaces are **PR Inbox**, **Submodule Timeline**, **Board**, **Review**, **Multi-Repo Diff**, and **Git Graph**. The global left sidebar contains user-created views, pinned PRs, releases, command palette, and sync state. The top navigation contains a repository/release selector, search, notifications, offline indicator, and theme toggle. A PR, repository, release, or feature can be deep-linked from anywhere. Tabs and split panes persist between sessions.

A **repository view** is a named subset of selectable repositories. Repositories may be selected if the GitHub user is an owner, organization member with the relevant repository access, or collaborator. Track `read`, `triage`, `write`, `maintain`, and `admin` separately: being a collaborator does **not** imply write access. Read-only public upstream repositories can be referenced by a chain or submodule without being part of the user's writable set. A **timeline view** tracks one root repository and a selected baseline branch/ref. A **release** is global to the account and may target several repositories; a **feature** is one card that may connect multiple PRs, repositories, and releases.

Identifiers use GitHub repository IDs, PR node IDs, and fully qualified `owner/repo#number` keys. Never use a bare PR number or submodule basename as a unique identifier. A submodule is identified by `(parent_repo_id, parent_commit_sha, path, child_repo_id/url, gitlink_sha)`, because paths and URLs may change with time.

### Primary navigation objects

| Object | Core fields | Owner |
|---|---|---|
| `RepositoryView` | name, repo IDs, filters, sort, pinned items | Workbench |
| `PRSnapshot` | repo, number, head/base SHA, CI, reviews, labels, milestone, merge status | GitHub mirror |
| `PRDependency` | prerequisite PR, dependent PR, source, confidence, sync status | Reconciled graph |
| `Chain` | ordered display of a dependency DAG, optional shared label | Workbench + GitHub body block |
| `TimelineView` | root repo, baseline ref, visible child paths, zoom, split state | Workbench |
| `Release` | release ID/name, state, optional target date, root targets, validation policy | Workbench |
| `ReleasePin` | release ID, parent repo/path, chosen child commit SHA | Workbench draft |
| `FeatureCard` | title, text, repository tags, release tags, related PRs/chains | Workbench |
| `ReviewProgress` | PR head SHA, file blob IDs, reviewed intervals, flagged ranges, private notes | Workbench |
| `DiffArtifact` | imported format/version, content hash, root, per-submodule patches | Local cache |

## 2. Workspace A — PR Inbox and cross-repository chains

### 2.1 Views and inbox

Creating a view opens a searchable, paginated repository picker grouped by GitHub owner and permission. Support selecting any combination of accessible public repositories across organizations, and save the selection as a view. Default filters resemble GitHub's PR inbox: **Needs my review**, **My drafts**, **Awaiting review**, **Waiting for CI**, **Changes requested**, **Ready to merge**, **Blocked by chain**, and **All open**. These are computed categories, not assumed GitHub labels. A PR can appear in several categories. Expose a user-editable classification policy; for example, `Needs my review` requires a pending request to the user or a team they belong to, while `Awaiting review` means reviewer approvals remain outstanding. Show unread-since-last-viewed and snooze as private local attributes; do not request GitHub notification scopes merely for this feature.

The list is keyboard-first, supports multi-select, search, bulk pin/snooze, grouping by repository/chain/release, saved sorting, and summaries of recent events. Provide an optional **release lens** filtering the PR inbox to PRs referenced by a selected release or feature, plus their direct dependencies. This is not a calendar or sprint view.

Selecting a PR opens an in-app PR details panel with GitHub-equivalent metadata: title, body, author, reviewers, labels, milestones, checks, commits, conversation, linked issues, mergeability, and link to GitHub. Changes to permitted GitHub fields are written through the GitHub API with optimistic concurrency and visible error states. **Open in Review** navigates to Workspace D while retaining the current inbox selection.

### 2.2 Chain discovery and semantics

Parse dependency references from descriptions using case-insensitive, line-oriented syntax. Initially recognize `Depends-On: owner/repo#123`, `Depends on https://github.com/owner/repo/pull/123`, `PR Stack: <PR> -> <PR> -> <PR>`, and `Chain: <PR> <PR> <PR>`; support Markdown list forms and multiple prerequisites. Normalize references to canonical GitHub PR IDs. Parse direct `Depends-On` edges as authoritative declarations. Treat `Chain`/`PR Stack` as an **ordered declaration** with the documented convention **leftmost is prerequisite, rightmost is downstream**, while preserving the original text and signaling ambiguity. Avoid inferring causal dependencies solely from commit messages or similar titles; display such inferred candidates for manual confirmation. Where a GitHub body is missing required permissions or the parser finds contradictory chain definitions, retain a **local-only edge** and flag the disagreement.

The data model is a **directed acyclic graph (DAG)**, not only a list: one PR may depend on multiple others, and several PRs may depend on one PR. Reject cycles with an explanation. Render a linear stack when a total ordering exists, otherwise show branches and a topological order. Clicking *any* chain member shows the same chain panel, highlights the selected PR, and shows all members' actual status: draft/open/approved/CI running/CI failing/mergeable/merged/closed-unmerged/unknown. The chain's overall readiness must not collapse review approval, CI, branch protection, or write permissions into a single ungrounded “ready” flag.

### 2.3 Create/edit/synchronize chains

Provide **Create chain**, **Link PR**, **Reorder**, **Add prerequisite**, **Remove**, and **Split chain** actions. Before saving, preview the graph mutations and GitHub description changes. When the user can edit a target PR, write a deterministic managed Markdown block to the **end** of its description, preserving unrelated text and other tools' metadata:

```markdown
<!-- maintainer-workbench:chain:start v1 id=chain_01 -->
Depends-On: https://github.com/riscv-boom/riscv-boom/pull/123
PR-Stack: https://github.com/riscv-boom/riscv-boom/pull/123 -> https://github.com/ucb-bar/chipyard/pull/789
<!-- maintainer-workbench:chain:end -->
```

Only replace a block carrying the same managed ID; never overwrite an entire unrelated description. Fetch and compare the current description immediately before each update; on concurrent edits, rebase only the managed block or ask the user to resolve ambiguity. For read-only upstream PRs, show the dependency in Workbench and use the writable downstream PR as the GitHub-visible anchor. The upstream description cannot be guaranteed to change. Clearly display **Synced**, **Local only**, **Pending**, and **Conflict** on each graph edge.

### 2.4 Submodule-aware dependencies and stack merging

If a downstream PR changes a gitlink at a path corresponding to an upstream PR, show both its **provisional pinned SHA** and the **final upstream merge revision**. Merge of an upstream PR alone never proves the downstream gitlink is correct. For `merge`, `squash`, and `rebase`, obtain the post-merge base-branch state, choose the intended resultant commit (not blindly `merge_commit_sha` for multi-commit rebase), verify ancestry/reachability and expected API content, then produce a **proposed gitlink update**. Auto-push only on explicitly user-enabled writable, bot-owned branches; otherwise create a patch or a reviewable action. Rerun CI and recalculate review freshness after any update. Integrate with GitHub Auto-merge or Mergify when available, but never assume authority to merge unowned upstream PRs.

## 3. Workspace B — nested submodule timeline and global releases

### 3.1 Timeline model

A user creates one timeline view for a tracked root repository and a baseline ref, such as `ucb-bar/chipyard@main`. Show one row for every submodule in `.gitmodules` at the **selected root commit** (not only today's `.gitmodules`). Each row shows path, child owner/repo, pinned gitlink SHA as a prominent dot, selected release pin as a second marker, upstream default/configured target-branch tip, and intervening commits/tags/PRs.

The horizontal time axis has **calendar dates** (day/week/month zoom). Plot commits by committer timestamp, but preserve actual Git ancestry as the source of truth: histories are DAGs and dates may be nonmonotonic after rebases/cherry-picks. Show diverged branches distinctly and avoid depicting every newer-dated commit as an ancestor. Pin dots identify exact commits with hover details; fetching history uses paginated APIs or local Git mirrors. Missing/deleted/private submodules are represented as unresolved rows, not silently removed.

### 3.2 Release targets and draggable segmented line

A global release, e.g. `Chipyard vNext`, has one visual **anchor** at the right of the timeline and a colored vertical segmented line through the rows. Each row intersection includes a draggable handle. Dragging a handle to a commit sets that row's **draft desired pin**; the other rows do not move, so the line may become a stepped polyline. A secondary option *Align to date* suggests the latest reachable commit no later than a chosen calendar date; it never silently changes the desired SHA. Keyboard controls must offer equivalent precision.

The user may freeze/unfreeze a release, compare it to an existing tag, inspect dependency compatibility warnings, and export its lock/manifest. Editing a release does **not** modify GitHub or a working tree. **Apply planned pins** shows `gitlink old -> new` diffs, checks that the child commit is fetchable and expected, identifies impacted parents and PRs, and proposes a branch/PR or locally staged patch. Since a parent repo can pin only one child revision per commit, conflicting release targets across related roots require an explicit resolution.

Releases are shared globally in all views. The same release ID maps to desired Git snapshots for each root and descendant path. Release references across repos are logical coordination objects, not a promise that all upstream repositories will publish matching GitHub Releases or tags.

### 3.3 Nested navigation and aligned split view

A row may link to the tracked child repository. Clicking it opens an existing child timeline view, or offers **Create child view** if the user can track it; otherwise open the public GitHub repository. For nested dependencies, resolve `.gitmodules` and gitlinks recursively at the chosen historical commits and preserve the full submodule path chain. An example is `chipyard/generators/gemmini` and Gemmini's own submodules.

Allow two timeline views in a **top/bottom horizontal split**, with synchronized x-axis zoom and calendar alignment but independent y-axis rows, scroll positions, and selections. A shared crosshair makes time-correlated revisions visible. Selecting a nested Gemmini pin in the lower pane highlights the corresponding Gemmini gitlink in Chipyard's upper pane and warns if the upper planned revision cannot contain the lower planned pins. Offer **Propagate proposal upward** (draft only) instead of mutating pins silently.

## 4. Workspace C — feature kanban (local-only)

Cards represent **features or integration efforts**, not individual PRs. They may link to zero or many PRs/chains, documents, local notes, tracked repositories, and global releases. Provide configurable columns such as `Backlog`, `In progress`, `Blocked upstream`, `Needs validation`, `Ready for release`, `Done`, and `Deferred`.

A card is a single entity with multiple **context-specific placements**. Repository view and release view show the same card and shared content, but a `CardPlacement(card_id, view_context_id, column_id, rank)` determines its status/rank per context. Editing title, description, relationships, or completion criteria updates the shared card; moving a card between columns changes only that view's placement. Cards created in a repository or release view automatically receive the corresponding tag. Support drag-and-drop, keyboard moves, dependency badges, attachments/links, and filters. No GitHub issue or project sync is required. Offline card edits are durable and later synchronized.

## 5. Workspace D — human-centric PR review

### 5.1 Entry and layout

This tab can be entered from any PR link, or from its own repository picker and GitHub-like **All / Open / Closed** PR list (respecting the user's permitted repositories). Use a three-pane arrangement: file tree/navigation on the left, **Overview / Files changed / Commits / Conversation** in the center, and contextual chain/review state on the right. For a chain, keep a persistent chain rail on the right; jumping between members should encourage a **prerequisite-first** review, with breadcrumbs to return. The code reviewer can open GitHub at any time.

For gitlink changes, provide **Expand submodule change** on the file row. Compare the previous and new referenced child revisions, load their files as a nested diff under the submodule path, and display the same review controls. An unmerged upstream PR may be used as an **explicit speculative comparison** when the gitlink is provisional; label the baseline and ensure this never masquerades as the actual GitHub PR diff. Handle child history divergence as a proper merge-base comparison and state the chosen diff mode.

### 5.2 AI summaries

Overview contains a cached, attributed AI summary: intent, changed subsystems, risk areas, behavior/API changes, tests, probable integration impact, and explicit unknowns. Every file has a **Summarize this file** action. Summaries are keyed by `(repo, PR, base SHA, head SHA, normalized diff hash, model ID, prompt version, user context policy)`, and re-generated only when relevant code or selected model/prompt changes. Distinguish *stale*, *fresh*, and *not generated*. Never imply an AI assessment constitutes review or approval. For large PRs, summarize files/hunks independently, then combine an overview from bounded summaries and selected high-signal patches; preserve file/line citations.

Offer provider settings for OpenAI API/Codex models, Anthropic, Google Gemini API, OpenRouter, and optional local Ollama. Treat Claude Code/Codex CLI and Antigravity as **optional local adapters**, not as interchangeable API-key providers; don't promise an unsupported Antigravity public API. API keys reside in OS keychain on desktop or encrypted browser-local secrets on the web; never synchronize provider keys into cloud storage. Outbound model requests require a per-repository policy and preview for sensitive or NDA files. PR text and code are untrusted prompt data, not system instructions.

### 5.3 File and line review state

Replace GitHub's `Viewed` with private **Reviewed**, with **Review incomplete / Come back later** and personal notes. Each file shows a horizontal progress rail with a draggable **contiguous reviewed frontier**. Dragging it down marks lines up to that location reviewed; a file is complete only when the frontier reaches the end **and no excluded/flagged intervals remain**. Users may shift-select line or hunk ranges to mark **Needs revisit**; these holes remain visible even after moving the frontier beyond them. A file with no review or a partial frontier remains **Incomplete**. Also support file-level **Postpone** and a PR-level **Review paused** state. These states are private and must never be confused with GitHub approvals.

Store notes on individual files, lines, and selections separately from GitHub comments. **Notes remain local/synced privately**. **Comments**, suggestions, review submissions (Approve / Request changes / Comment), and thread resolution use GitHub's actual review APIs, with locally persisted draft comments until submission. Warn when GitHub cannot anchor a comment to the selected line (e.g. out-of-diff context or obsolete revision); offer a PR-level comment rather than silently moving the anchor.

All review progress is **revision-aware**. When head SHA changes, match unchanged file blobs and stable diff hunks by content; preserve clearly unaffected reviewed intervals, but mark changed and ambiguous segments for re-review. Remap notes with content anchors and line context when possible; keep orphaned notes accessible for manual relocation. Never automatically mark modified code reviewed because it occupied the same line number.

### 5.4 Semantic context and split file reading

Collapsed unchanged regions expand to a semantic boundary: nearest enclosing function/class/block start when expanding up, and closing boundary when expanding down; cap extremely large scopes and offer *Expand another block*. Use tree-sitter for fast syntax boundaries and LSP (e.g. Metals for Scala) when available. If semantic indexing fails, fall back to bounded lines and explicitly label the fallback.

Each changed file can open a **full-file inspector** with syntax highlighting, jump-to-definition, search, breadcrumbs, symbols, and links to the modified hunks. Support horizontal or vertical split with another changed file, arbitrary file at the PR revision, or file in a related upstream repository. Show the repository and exact SHA above each pane to avoid version confusion. Persist the layout.

A file's **Impact graph** button runs a cached semantic analysis of changed symbols and their direct/transitive callers, callees, and affected tests. Start with the open-source [CodeGraph](https://github.com/colbymchenry/codegraph) local CLI (`impact`, `callers`, `callees`, `affected` where supported), with tree-sitter/LSP fallback. Graph indices are keyed by repository revision and indexing-tool version. Cross-submodule edges require explicit resolution of symbols/build dependencies; present uncertain relationships as inferred rather than confirmed. Index in a background worker or via SSH; do not index a full Chipyard tree synchronously on the UI thread.

### 5.5 Large-review responsiveness and shortcuts

Virtualize file/hunk rows, lazy-fetch only visible patches, move parsing/syntax/graph operations to workers, and use immutable, content-addressed disk caches. Treat huge generated files, rename-only changes, binary files, and submodule patches distinctly. Include `j/k`, `n/p` next/previous hunk, `r` mark reviewed, `x` flag revisit, `c` comment, `g` impact graph, `[`/`]` chain navigation, `Cmd/Ctrl+K` command palette; make all shortcuts configurable and discoverable. GPU-accelerate scrolling/graph rendering only when profiling shows a benefit.

## 6. Workspace E — multi-repository JSON diff viewer

Import a root/master repository and a JSON file mapping **relative submodule path -> unified diff string**. The empty key `""` represents the root repository. Support multiple root and submodule entries, including empty patch strings, and index each changed file from its unified diff.

A valid import may be parsed without a local checkout; if a root repo is provided, resolve each path through `.gitmodules` to render repository identities and link to GitHub. Preserve the original JSON and exact patch text (hash for deduplication). Validation checks key normalization, duplicate/unsafe paths, diff headers, hunk syntax, file modes, renames, new/deleted files, truncated patches, binary indicators, and unknown submodule paths. Empty patch strings are valid and mean *no changed files*, not a parse failure. Never execute commands embedded in imported text.

Render a Diffchecker-like **side-by-side / unified** diff view, with a master file tree grouped by submodule and breadcrumbs for root and child repositories. Search across paths and content; filter by added/deleted/modified/renamed and by submodule; show change stats. Parsing occurs in a worker/Rust core with progressive results and windowed file rendering. Target at least **50 MB** imports without freezing the UI, with a warning and chunked spill-to-disk strategy beyond that. Import snapshots remain available offline and can participate in local notes and optional AI summaries. No GitHub mutation is implied by importing a diff.

## 7. Workspace F — GitKraken-style Git graph

One independent graph view per repository; select a local working tree, cached bare/partial mirror, or remote GitHub repository. Draw commit DAG lanes, branches, tags, merge bases, PR labels, authors, and ancestry. Support search by SHA/ref, cherry-pick/rebase/merge previews, and local **non-destructive** checkout/diff actions; Git write operations require confirmation and a local/SSH executor with an explicit working tree. Selecting a gitlink commit opens the child timeline or diff; from any release pin, jump to its commit on the graph. Large histories require incremental walking and GPU/canvas rendering only as needed, not a full commit-graph materialization on first open.

## 8. Authentication, permissions, privacy, and trust boundaries

**No GitHub organization App installation is required.** Use a registered **OAuth App** for personal sign-in. Start with the minimum no-scope/read-public authorization, upgrading only if a concrete GitHub write is requested. For public-repository PR metadata/review writes, optionally request `public_repo`; **never request classic `repo`, `admin:org`, or access to private repositories in the default flow**. `public_repo` covers **all public repositories** the token can access, not only selected repositories; the application's selected-repo allowlist is an app-side safety boundary, **not** an OAuth permission limit. Organizations can still restrict OAuth App access; read-only public data should remain usable, while organization write operations may be unavailable. Never imply the app bypasses organization policy.

If users require stricter repository-scoped access, support a **user-supplied fine-grained PAT** limited to selected repositories and permissions such as `Pull requests: write`, `Issues: write`, and `Contents: read` (plus `Contents: write` only for submodule gitlink updates). Such tokens may require organization approval or be blocked by organization policy. Different orgs may require separate tokens. Secrets must remain local, never be uploaded for cloud sync. A **Public-only mode** hides all private repos and rejects private repository metadata/content even if a local Git executable can access them. Do not invoke a user's broadly privileged `gh` login as a silent substitute for scoped authorization.

Desktop uses OS browser OAuth with PKCE/system callback where supported, or a deliberately enabled device flow; do not bundle a client secret in a distributed binary. Web uses OAuth authorization-code flow via a trusted backend/BFF, secure HTTP-only cookies, CSRF protection, encrypted server-side OAuth credentials, short sessions, and explicit disconnect/revoke. The backend is for authentication/sync and optional public API proxying; it is **not** a privileged organization agent. Verify repository `permissions.push` (or maintain/admin) immediately before each write. PR ownership alone does not bypass the app's chosen write restriction. Display per-action capability (`Read only`, `Can review`, `Can edit metadata`, `Can push`, `Can merge`) and let GitHub reject actions that branch protection disallows.

All GitHub API data, PR descriptions, code patches, and imported JSON are untrusted. Sanitize rendered Markdown/HTML, enforce bounded network requests, prevent shell/URL injection, and treat LLM output as untrusted. Disallow unsafe path traversal in nested submodules and imported patches. Git write commands and SSH executions require user consent; remote hosts receive only the paths/revisions/tasks explicitly selected.

## 9. Architecture: local, web, remote, and offline

```text
                GitHub public API / scoped user OAuth
                              |
        +---------------------+----------------------+
        |                                            |
  Tauri Desktop                                 Web PWA
  React UI + Rust core                    React UI + Web Workers
  SQLite + git mirrors                    OPFS/IndexedDB cache
        |                                            |
        +------ encrypted user-owned sync ops -------+
                              |
                    Workers API + D1
                 (small metadata only)
                              |
                Optional local/SSH compute agent
          Git, tree-sitter/Metals, CodeGraph, parsing
```

**Desktop:** Tauri 2 hosts the shared React front end and a Rust service. SQLite in WAL mode stores views, releases, cards, notes, review intervals, normalized GitHub metadata, and an append-only sync outbox. A content-addressed filesystem cache stores Git trees/patches, semantic indexes, and imported artifacts. Local Git operations use libgit2/Git CLI as appropriate; avoid recursively cloning all Chipyard submodules merely to display the timeline. Use GitHub Git Trees API and filtered/shallow mirrors first, with a single child fetched on demand.

**Web:** Installable PWA with service worker for application shell and recent views; IndexedDB or SQLite-WASM/OPFS for local data; Web Workers for parsing and rendering. Browser capabilities cannot run arbitrary Git, SSH, or local LSP/CodeGraph. Offer lighter API-based features and an optional **paired desktop/remote agent** for indexing, filesystem operations, and high-fidelity graph queries. Show when a feature is unavailable offline or without an agent.

**SSH offload:** User registers an SSH alias/host and optional working-tree root; install a versioned **unprivileged helper** in the user's home directory (or run a statically packaged helper), invoke commands over SSH without sudo, and stream bounded JSON/patch results. Reuse existing clones when available, avoid modifying them unless explicitly asked, and apply resource/time limits. Pairing should explicitly identify host, user, repo path, and execution permission. Never accept remote code execution requests from arbitrary imported JSON or PR descriptions.

**Offline:** Last-synced PR metadata, imported patches, reviewed intervals, notes, kanban, release manifests, and Git cache remain usable. GitHub-dependent writes cannot be committed offline: store them as **pending intentions**, then re-fetch the target SHA/metadata and require user confirmation before replay. Show stale timestamps. Cloud sync failure must never block local writes or delete local records.

## 10. Sync and storage design

Recommended initial cloud stack: **Cloudflare Workers + D1** for per-user, encrypted metadata, with an object store only if needed for user-selected artifacts. Local SQLite remains authoritative for immediate UX. Publish an append-only operation log with `(operation_id, user_id, device_id, entity_id, base_revision, timestamp, encrypted_payload)`, idempotent deduplication, soft-deletes/tombstones, and a server-side cursor. Keep large code assets, Git mirrors, LSP indexes, secrets, and cached AI prompts/results **local by default**. Cloud may retain encrypted card/notes/release data; require a recovery key or device-pairing process to decrypt on a new device. Plan for encrypted metadata to be opaque to server search; do indexing locally.

Conflict policy: field-level merges for simple preferences; per-context ordering for kanban with stable position keys; three-way comparison and explicit user conflict resolution for **PR chain ordering** and **release pin manifests** (never LWW silently on these); content-addressed versions for note anchors/AI caches. Use source IDs and schema versions so local/web edits converge idempotently. Prevent syncing any record accidentally referring to a private repository when Public-only mode is active.

**Provider options (published November 2026 pricing; recheck before deployment):**

| Option | Free baseline | Paid upgrade | Assessment |
|---|---|---|---|
| **Cloudflare Workers + D1** | Workers Free 100k requests/day; D1 Free 5M rows read/day, 100k written/day, 5 GB | Workers Paid starts with a low monthly minimum; D1 beyond allowances metered | **Recommended** for modest encrypted metadata and inexpensive multi-device sync |
| **Supabase** | 500 MB database, 1 GB file storage, two free projects (idle projects may pause) | Pro from $25/mo plus usage | Best if auth, Postgres, dashboards, and collaborative SQL are higher priority |
| **Self-host Postgres or SQLite sync** | Software free, infrastructure/maintenance not free | VPS/managed DB | Appropriate for organizations demanding full data custody; more maintenance |

Do not store large diffs in D1. A future cloud-assisted web diff service should use explicit opt-in, size limits, retention controls, and object storage. Exact costs depend on rate limits, bandwidth, and activity—not just database size.

## 11. LLM routing and cost controls (target **≤$100/month** for app-initiated OpenAI/Codex API calls)

Default model policy: **GPT-6 Luna** for classification and short file-level summaries; **GPT-6.1 Terra** for main file/PR summaries; **GPT-6.1 Sol** for deliberate escalation of difficult cross-module reasoning. Support Codex-specialized models through the OpenAI API if explicitly chosen; do not assume ChatGPT/Codex subscription usage equals API credit. Anthropic, Gemini, OpenRouter, and local models are configurable alternatives with their own spending ledgers. Current published OpenAI standard short-context rates per 1M tokens are approximately Luna **$0.05 input / $0.25 output**, Terra **$0.50 / $2.50**, and Sol **$1 / $5**; model availability and pricing are refreshed from provider metadata/settings rather than hardcoded as guarantees.

Provide **monthly budget $100**, **soft warning at $70**, and **hard application stop at $95** to leave headroom for delayed usage accounting; the provider's billing limit is a separate safeguard. Before dispatch, estimate cost from estimated input/output tokens and reserve budget; reconcile actual usage afterward. Default summarization never sends the entire 1.1 MB sample as one blind prompt. Use diff statistics + structural grouping + changed hunks + on-demand file selection. Cache by content hash and input policy; deduplicate concurrent requests; cap file and overview context; prefer local syntax/impact analysis before LLM calls. Show predicted cost in the UI and permit overriding the per-task model within the budget. **Never auto-send NDA or private code to a third-party LLM.**

## 12. Performance, accessibility, and reliability targets

| Metric | Target |
|---|---|
| App launch to cached inbox | <2 seconds on a typical development laptop |
| UI response to filtering/navigation | <100 ms for indexed local data |
| 1.12 MB sample JSON import | <3 seconds parse/index on reference laptop; no main-thread blocking |
| Large diff import | 50 MB target with progressive rendering and bounded memory |
| File/hunk scroll | 60 fps target on common hardware; no eager DOM rendering of all hunks |
| Offline edits | Persist locally immediately, survive restart/crash |
| Background sync | Eventual; expose last sync age, retries, and rate-limit/backoff status |
| GitHub writes | Permission recheck, conflict detection, no silent retries after partial failure |
| Accessibility | WCAG 2.2 AA target, full keyboard navigation, reduced motion, accessible contrast |

Use dark/light/system mode, restrained Linear/Graphite-inspired typography, dense tables with generous navigation affordances, a persistent command palette, accessible status indicators, and keyboard-resizable split panes. Avoid reliance on color alone to convey status. Support deep links and copyable URLs for views and PRs, keeping local-only notes inaccessible to GitHub.

## 13. Representative user journeys and acceptance criteria

**A. Cross-org release inbox:** Sign in with public-only GitHub access; create a `Chipyard integration` view with `ucb-bar/chipyard`, `riscv-boom/riscv-boom`, `chipsalliance/rocket-chip`, and `firesim/firesim`; see all open PRs and review categories. A PR dependency referencing an external public repo appears without that organization's App installation. Read-only PRs never display enabled GitHub write actions.

**B. Chain reconciliation:** Detect `Depends-On` from BOOM PR to Chipyard PR; show status rail in both; edit chain order; write only a managed block in the writable Chipyard PR and retain external changes as local-only where needed; detect a BOOM squash merge; propose the correct downstream gitlink update and require fresh CI before merge.

**C. Nested release pinning:** Open Chipyard timeline; set desired Gemmini commit for `vNext`; open Gemmini child timeline in an aligned split; choose nested dependency commits; observe incompatibility warnings until a reachable Gemmini parent commit containing the desired pins is identified; export a release manifest and preview the Git changes without pushing automatically.

**D. Review interruption:** Start a large Scala PR; drag the reviewed frontier halfway through a file; shift-select two hunks as incomplete and add a private note; close/reopen offline; progress survives. A new PR commit modifies one reviewed hunk: mark it for re-review while preserving clearly unchanged reviewed work. A submitted GitHub comment appears on GitHub; the private note does not.

**E. JSON diff import:** Import a representative JSON diff; show one root group and named submodule groups; preserve an empty submodule entry without error; jump to a changed file and load only its patch; compare side-by-side without cloning the repo.

**F. Permission and offline failure:** If OAuth org restriction prevents a GitHub write, show that GitHub requires authorization and fall back to a prepared text/patch or GitHub link. Never use an over-scoped credential silently. If disconnected, open existing review, timeline, board, and imported diff from cache; queue unsubmitted intentions locally without silently posting them when back online.

## 14. Recommended implementation phases

| Phase | Scope | Completion gate |
|---|---|---|
| **P0: Foundation** | Tauri + PWA shell; personal GitHub auth; public-only security mode; local SQLite; repo picker; normalized GH metadata; encrypted sync | Select repos from several organizations, offline inbox works, no org App installation |
| **P1: Maintainer core** | PR inbox, PR detail/editing, chain parser/editor/status rail, basic review UI, kanban | End-to-end triage/review on real cross-org public PRs with GitHub-synced comments and local notes |
| **P2: Release system** | Submodule timeline, global release manifests, nested split view, gitlink reconciliation proposals | Draft a nested Chipyard release and export/apply a validated PR/patch without unintended writes |
| **P3: Advanced review** | Revision-aware intervals/frontier, semantic context, file inspector, CodeGraph impact, AI caching/cost controls | Review a repeatedly updated large Scala PR without losing unaffected progress |
| **P4: Large-diff/Git** | JSON diff importer, semantic grouping, Git graph, SSH worker | Correctly render sample 73-file diff and large histories with measured UI responsiveness |

These phases are delivery dependencies, **not calendar deadlines**.

## 15. Risks and explicit follow-up decisions

1. **GitHub OAuth policy:** no OAuth design can guarantee write access to an organization that disallows it, and `public_repo` is not selected-repository-scoped. Ship Public-only read mode even where writes are blocked.
2. **Public vs private scope:** do not quietly enable private repos; private-only code views, if ever added, require a separate reviewed security model and credentials.
3. **Submodule semantics:** a GitHub PR's merge status does not prove a child gitlink points to the correct or reachable merged revision; verify history and content before proposing an update.
4. **Temporal graph accuracy:** dates are visual coordinates, not dependency/ancestry proofs; shallow/rewritten histories must be labeled incomplete.
5. **Review-state correctness:** interval-based progress must survive rebases and renames without falsely considering changed code reviewed.
6. **Cloud synchronization:** user-generated release plans and chain edits need conflict detection; never silently resolve revision conflicts in favor of latest timestamp.
7. **Security:** cloud code storage and remote LLM uploads should remain opt-in; protect tokens, avoid logging provider secrets, defend against prompt/shell injection.
8. **Scope control:** postpone fully automated cross-org merging, collaborative shared boards, and executing arbitrary local code. The primary value is **maintainer decision acceleration**, not a new CI platform.

### Sources used for technical constraints

- GitHub OAuth app scopes and access restrictions: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps and https://docs.github.com/en/organizations/managing-oauth-access-to-your-organizations-data/about-oauth-app-access-restrictions
- GitHub OAuth and token security: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app
- GitHub fine-grained token selection and approval: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- CodeGraph local CLI: https://github.com/colbymchenry/codegraph and https://github.com/colbymchenry/codegraph/blob/main/site/src/content/docs/reference/cli.md
- Cloudflare D1: https://developers.cloudflare.com/d1/platform/pricing/; Workers: https://developers.cloudflare.com/workers/platform/limits/
- Supabase pricing: https://supabase.com/pricing
- OpenAI API pricing: https://developers.openai.com/api/docs/pricing

---

**One-sentence product principle:** Show the maintainer every relevant cross-repository change, every upstream dependency, and every intended release pin in one place—without requiring upstream owners to install software, without imposing a release cadence, and without giving up GitHub as the shared collaboration interface.
