# Nonlinear

A local-first, GitHub-native workspace for maintainers who coordinate releases across independently owned repositories and nested Git submodules (built for the Chipyard ecosystem). It combines PR triage, cross-repository dependency chains, submodule release pinning, a feature kanban, human-centred large-diff review, a multi-repo JSON diff viewer, and a Git graph.

No GitHub App is installed into any organization. GitHub stays the source of truth for PRs, reviews and permissions. Nonlinear keeps your private notes, review progress, release plans and cards on your own devices, with optional end-to-end-encrypted sync.

The design lives in [`design/`](design/). Implementation status and handoff notes are in [`IMPLEMENTATION_NOTES.md`](IMPLEMENTATION_NOTES.md).

## Quick start

```sh
npm install
npm run dev            # web app at http://localhost:5173
npm test               # unit tests (core, web, sync worker)
npm run desktop        # Tauri desktop app (needs Rust toolchain)
```

Open **Settings → Nonlinear Cloud → Connect with GitHub** to sign in and sync, or keep using it anonymously for public repositories (GitHub limits anonymous use to 60 requests per hour).

## Layout

| Path | What |
|---|---|
| `packages/core` | Pure TypeScript domain logic: chain parser/DAG/managed blocks, unified-diff indexer, review intervals and revision remap, releases, kanban ranks, encrypted op log and device pairing, LLM budget, GitHub client |
| `apps/web` | React PWA, the shared UI for web and desktop |
| `apps/desktop` | Tauri 2 shell. Rust core with git CLI, SQLite (WAL), OS keychain, SSH helper, CodeGraph, device-flow OAuth |
| `services/sync` | Cloudflare Worker + D1: OAuth BFF, GitHub proxy, encrypted op log, device-pairing relay |
| `scripts` | Mock GitHub API, end-to-end journeys, smoke tests, remote helper |

## Deploying Nonlinear Cloud

```sh
cd services/sync
npx wrangler d1 create nonlinear              # put the id into wrangler.toml
npx wrangler d1 migrations apply nonlinear --remote
npx wrangler secret put GITHUB_CLIENT_SECRET  # from a GitHub OAuth App (callback: https://<worker>/auth/github/callback)
npx wrangler secret put TOKEN_KEY             # base64 of 32 random bytes
npx wrangler deploy
```

Then build the app with `VITE_NONLINEAR_CLOUD_URL=https://<worker>` so users get the one-click **Connect** button. If the Worker isn't on `*.workers.dev`, add its origin to the CSP in `apps/web/index.html` and to `ALLOWED_ORIGINS`.
