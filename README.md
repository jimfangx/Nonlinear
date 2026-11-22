<p align="center">
  <img src="apps/web/public/icon.svg" width="88" alt="Nonlinear logo">
</p>

<h1 align="center">Nonlinear</h1>

<p align="center">
  <strong>The release workbench for maintainers whose work doesn't fit in one repo.</strong><br>
  PR triage, cross-repo dependency chains, submodule pinning and large-diff review, all local-first and GitHub-native.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#features">Features</a> ·
  <a href="#privacy--security">Privacy</a> ·
  <a href="#self-hosting-nonlinear-cloud">Self-host</a> ·
  <a href="#development">Develop</a>
</p>

---

Shipping a release across a dozen repositories and nested Git submodules means juggling browser tabs, PRs that depend on each other, and diffs too large to keep in your head. Nonlinear puts all of it in one workspace.

- **No GitHub App to install.** Sign in with your own account. GitHub stays the source of truth for PRs, reviews and permissions.
- **Your notes stay yours.** Review progress, release plans, cards and private notes live on your devices, with optional end-to-end-encrypted sync.
- **Built for real ecosystems.** Designed around the [Chipyard](https://github.com/ucb-bar/chipyard) family of repos, and it works for any multi-repo or submodule-heavy project.

## Features

### 📥 Inbox: PR triage across every repo
One inbox for every repo you maintain. PRs are sorted into categories you can edit (needs my review, blocked, ready to merge…). You can pin, snooze, group by release and see what changed since you last looked.

### 🔗 Dependency chains
Declare `Depends-On: org/repo#123` in a PR body, or draw the chain in the UI. Nonlinear builds the DAG, rejects cycles, explains *why* something isn't ready to merge, and keeps a managed chain block up to date in every PR it touches. It shows you every edit before it writes anything.

### 🕰 Submodule timeline and releases
Each submodule gets a row on a shared calendar axis, showing pins, tags, branch tips and open PRs. Drag release handles to choose commits, align everything to a date, catch nested inconsistencies, then freeze a release and export a manifest, a patch, or a draft PR that bumps the gitlinks.

### 🔍 Review built for big diffs
A frontier rail tracks exactly which hunks you've reviewed. Progress follows hunks across force-pushes, and anything that changed since you looked is marked stale. You also get flags, private notes, draft comments that post as one GitHub review, prev/next navigation through a chain, and an inline view of submodule changes. Go-to-definition and find-references work with **any LSP server** (clangd, Metals, pyright, rust-analyzer, gopls…).

### 🗂 Kanban board
Cards link PRs, releases, checklists and dependencies. The same card can sit in different places on different boards, and every action has a keyboard shortcut.

### 📦 Multi-repo diff viewer
Import a JSON diff that spans the root repo and its submodules. A 51 MB, 3,500-file import is indexed in about 280 ms, saved locally, and reopens instantly offline.

### 🌿 Git graph
A lane graph with refs, PRs and pins, plus compare and merge previews. Data can come from the GitHub API, your local working tree, a managed partial mirror, or a remote machine over SSH.

### ✨ Optional AI summaries
Bring your own API key, or use a local **Claude Code** or **Codex CLI** install. You see every prompt before it's sent, policies are set per repo, and a hard budget cap stops spending.

### ⌨️ Also included
A ⌘K command palette, configurable keybindings, light and dark themes, and offline mode (GitHub writes queue up and wait for your confirmation). Automated WCAG 2.2 AA audits report zero violations.

## Install

### macOS app
Download the latest `.dmg` from [Releases](https://github.com/jimfangx/Nonlinear/releases), then drag **Nonlinear** into Applications.

> Current builds are Apple Silicon only and ad-hoc signed. The first time you open the app, right-click it and choose **Open**.

The desktop app adds local Git, SQLite storage, the OS keychain, LSP integration, partial repo mirrors and SSH offload.

### Web app
Nonlinear also runs as an installable PWA. Build it from source (see [Development](#development)) and serve `apps/web/dist`.

### Getting started
1. Open **Settings → Nonlinear Cloud → Connect with GitHub**. That's one click, and the app only asks for public-repo scope.
2. Add the repositories you maintain.
3. Start in the **Inbox**.

You can also use Nonlinear without signing in to browse public repositories, but GitHub limits anonymous use to 60 requests per hour.

## Privacy & security

- **Local-first.** Everything you create in Nonlinear is stored on your device: IndexedDB in the browser, SQLite on desktop.
- **End-to-end-encrypted sync.** Data is encrypted with AES-GCM before it leaves your device. New devices pair by approval with a matching 6-digit code, or with a recovery key.
- **Minimal GitHub scope.** OAuth requests only `public_repo`, and over-scoped tokens are refused. In the browser, your token never reaches the page.
- **Nothing is sent without you.** Every write to GitHub (chain blocks, labels, reviews, PRs) shows a preview first and needs your confirmation.

## Self-hosting Nonlinear Cloud

The sync service is a single Cloudflare Worker backed by D1.

```sh
cd services/sync
npx wrangler d1 create nonlinear              # put the id into wrangler.toml
npx wrangler d1 migrations apply nonlinear --remote
npx wrangler secret put GITHUB_CLIENT_SECRET  # GitHub OAuth App, callback: https://<worker>/auth/github/callback
npx wrangler secret put TOKEN_KEY             # base64 of 32 random bytes
npx wrangler deploy
```

Build the app with `VITE_NONLINEAR_CLOUD_URL=https://<worker>` so users get the one-click **Connect** button. If the Worker isn't on `*.workers.dev`, add its origin to the CSP in `apps/web/index.html` and to `ALLOWED_ORIGINS`.

## Development

```sh
npm install
npm run dev        # web app at http://localhost:5173
npm test           # core, web and sync-worker tests
npm run desktop    # Tauri desktop app (needs a Rust toolchain)
```

| Path | What |
|---|---|
| `packages/core` | Pure TypeScript domain logic: chains, diff indexing, review intervals, releases, kanban, encrypted op log, GitHub client |
| `apps/web` | React PWA, the shared UI for web and desktop |
| `apps/desktop` | Tauri 2 shell: Git CLI, SQLite, keychain, LSP, SSH helper, OAuth |
| `services/sync` | Cloudflare Worker + D1: OAuth, GitHub proxy, encrypted sync, device pairing |
| `site` | Marketing website (static, single file) |
| `scripts` | Mock GitHub, end-to-end journeys, accessibility audits, packaging |

Architecture, test suites and handoff notes are in [`IMPLEMENTATION_NOTES.md`](IMPLEMENTATION_NOTES.md). The full design spec is in [`design/`](design/).

**Building the macOS installer:**
```sh
npm ci
APPLE_SIGNING_IDENTITY=- npm run build -w @nonlinear/desktop -- --bundles app
scripts/make-dmg.sh
```

## License

[MIT](LICENSE)
