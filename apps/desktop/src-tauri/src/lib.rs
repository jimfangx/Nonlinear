//! Nonlinear desktop core. Tauri commands exposed to the shared React UI.

mod ai_local;
mod git;
mod mirror;
mod lsp;
mod oauth;
mod remote;
mod review_mcp;
pub use review_mcp::serve as serve_review_mcp;
mod store;

use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};
use store::Store;
use tauri::Manager;

type Res<T> = Result<T, String>;

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}
fn e<E: std::fmt::Display>(x: E) -> String {
    x.to_string()
}

/* ---------------- SQLite store ---------------- */

#[tauri::command]
fn review_mcp_share(app: tauri::AppHandle, store: tauri::State<Store>, context: Option<serde_json::Value>) -> Res<serde_json::Value> {
    let db = app.path().app_data_dir().map_err(e)?.join("nonlinear.sqlite3");
    let command = std::env::current_exe().map_err(e)?;
    if let Some(context) = context {
        if !context.is_object() || context.to_string().len() > review_mcp::MAX_CONTEXT_BYTES {
            return Err("Review context exceeds the share limit".into());
        }
        let payload = serde_json::json!({ "expiresAt": review_mcp::now_seconds() + 1800, "context": context });
        store.blob_put(review_mcp::CONTEXT_KEY, &payload.to_string()).map_err(e)?;
    } else {
        store.blob_delete(review_mcp::CONTEXT_KEY).map_err(e)?;
    }
    Ok(serde_json::json!({ "command": command, "args": ["--review-mcp", db.to_string_lossy().as_ref()] }))
}

#[tauri::command]
fn db_load_all(s: tauri::State<Store>) -> Res<Vec<store::Record>> {
    s.load_all().map_err(e)
}
#[tauri::command]
fn db_put(s: tauri::State<Store>, collection: String, id: String, value: serde_json::Value) -> Res<()> {
    s.put(&collection, &id, &value, now()).map_err(e)
}
#[tauri::command]
fn db_restore(s: tauri::State<Store>, records: Vec<store::Record>, blobs: Vec<(String, String)>) -> Res<()> {
    s.restore(&records, &blobs).map_err(e)
}
#[tauri::command]
fn db_delete(s: tauri::State<Store>, collection: String, id: String) -> Res<()> {
    s.delete(&collection, &id).map_err(e)
}
#[tauri::command]
fn blob_put(s: tauri::State<Store>, key: String, value: String) -> Res<()> {
    s.blob_put(&key, &value).map_err(e)
}
#[tauri::command]
fn blob_get(s: tauri::State<Store>, key: String) -> Res<Option<String>> {
    s.blob_get(&key).map_err(e)
}
#[tauri::command]
fn blob_delete(s: tauri::State<Store>, key: String) -> Res<()> {
    s.blob_delete(&key).map_err(e)
}
#[tauri::command]
fn outbox_add(s: tauri::State<Store>, op: serde_json::Value) -> Res<()> {
    let id = op.get("opId").and_then(|v| v.as_str()).ok_or("op without opId")?.to_string();
    s.outbox_add(&id, &op, now()).map_err(e)
}
#[tauri::command]
fn outbox_all(s: tauri::State<Store>) -> Res<Vec<serde_json::Value>> {
    s.outbox_all().map_err(e)
}
#[tauri::command]
fn outbox_remove(s: tauri::State<Store>, ids: Vec<String>) -> Res<()> {
    s.outbox_remove(&ids).map_err(e)
}
#[tauri::command]
fn db_wipe(s: tauri::State<Store>) -> Res<()> {
    s.wipe().map_err(e)
}

/// Full local erase: database (compacted), mirrors, worktrees, timeline caches, the
/// webview/HTTP cache, an older build's data folder, and optionally keychain secrets.
/// The user's own working trees are never touched; their stale worktree entries are pruned.
#[derive(Serialize)]
struct WipeReport {
    removed: Vec<String>,
    bytes: u64,
    errors: Vec<String>,
}

fn dir_size(p: &std::path::Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(p) else { return 0 };
    if !meta.is_dir() {
        return meta.len();
    }
    std::fs::read_dir(p).map(|rd| rd.flatten().map(|e| dir_size(&e.path())).sum()).unwrap_or(0)
}

#[tauri::command]
async fn data_wipe_all(
    app: tauri::AppHandle,
    s: tauri::State<'_, Store>,
    lsps: tauri::State<'_, std::sync::Arc<lsp::LspManager>>,
    secret_keys: Vec<String>,
    local_repos: Vec<String>,
) -> Res<WipeReport> {
    lsps.shutdown_all(); // language servers may hold worktrees open
    let mut report = WipeReport { removed: vec![], bytes: 0, errors: vec![] };
    let data = data_dir(&app)?;
    let before = ["nonlinear.sqlite3", "nonlinear.sqlite3-wal", "nonlinear.sqlite3-shm"].iter().map(|f| dir_size(&data.join(f))).sum::<u64>();
    match s.wipe_and_compact() {
        Ok(()) => {
            let after = ["nonlinear.sqlite3", "nonlinear.sqlite3-wal", "nonlinear.sqlite3-shm"].iter().map(|f| dir_size(&data.join(f))).sum::<u64>();
            report.bytes += before.saturating_sub(after);
            report.removed.push("database".into());
        }
        Err(x) => report.errors.push(format!("database: {x}")),
    }
    let mut targets: Vec<std::path::PathBuf> = ["mirrors", "worktrees", "timeline-history", "timeline-trees"].iter().map(|d| data.join(d)).collect();
    // Data folder of builds that used the old bundle identifier.
    if let Some(parent) = data.parent() {
        let legacy = parent.join("dev.nonlinear.app");
        if legacy != data {
            targets.push(legacy);
        }
    }
    if let Ok(cache) = app.path().app_cache_dir() {
        if let Ok(rd) = std::fs::read_dir(&cache) {
            targets.extend(rd.flatten().map(|e| e.path()));
        }
    }
    for t in targets {
        if !t.exists() {
            continue;
        }
        let size = dir_size(&t);
        let res = if t.is_dir() { std::fs::remove_dir_all(&t) } else { std::fs::remove_file(&t) };
        match res {
            Ok(()) => {
                report.bytes += size;
                report.removed.push(t.to_string_lossy().into_owned());
            }
            Err(x) => report.errors.push(format!("{}: {x}", t.display())),
        }
    }
    // Worktrees made from the user's own checkouts leave metadata in that repo; prune only the entries whose folder is gone.
    for repo in local_repos {
        if let Ok(r) = git::validate_repo(&repo) {
            let _ = git::run_git(&r, &["worktree", "prune"], std::time::Duration::from_secs(20));
        }
    }
    for key in secret_keys {
        if let Err(x) = keychain_set(key.clone(), None) {
            report.errors.push(format!("keychain {key}: {x}"));
        } else {
            report.removed.push(format!("keychain:{key}"));
        }
    }
    Ok(report)
}

#[tauri::command]
async fn git_grep(repo_path: String, word: String, max: usize) -> Res<Vec<git::GrepHit>> {
    let r = git::validate_repo(&repo_path).map_err(e)?;
    tauri::async_runtime::spawn_blocking(move || git::grep_word(&r, &word, max.clamp(1, 5000))).await.map_err(e)?.map_err(e)
}

/* ---------------- OS keychain (secrets never touch SQLite or sync) ---------------- */

const SERVICE: &str = "dev.nonlinear.app";

#[tauri::command]
fn keychain_get(key: String) -> Res<Option<String>> {
    let entry = keyring::Entry::new(SERVICE, &key).map_err(e)?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(x) => Err(e(x)),
    }
}
#[tauri::command]
fn keychain_set(key: String, value: Option<String>) -> Res<()> {
    let entry = keyring::Entry::new(SERVICE, &key).map_err(e)?;
    match value {
        Some(v) => entry.set_password(&v).map_err(e),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(x) => Err(e(x)),
        },
    }
}

/* ---------------- Git ---------------- */

#[tauri::command]
async fn git_log(repo_path: String, rev: String, limit: usize) -> Res<Vec<git::LogEntry>> {
    let r = git::validate_repo(&repo_path).map_err(e)?;
    tauri::async_runtime::spawn_blocking(move || git::log(&r, &rev, limit)).await.map_err(e)?.map_err(e)
}
#[tauri::command]
async fn git_refs(repo_path: String) -> Res<Vec<git::RefEntry>> {
    let r = git::validate_repo(&repo_path).map_err(e)?;
    tauri::async_runtime::spawn_blocking(move || git::refs(&r)).await.map_err(e)?.map_err(e)
}
#[tauri::command]
async fn git_gitlinks(repo_path: String, rev: String) -> Res<Vec<git::Gitlink>> {
    let r = git::validate_repo(&repo_path).map_err(e)?;
    tauri::async_runtime::spawn_blocking(move || git::gitlinks(&r, &rev)).await.map_err(e)?.map_err(e)
}
#[tauri::command]
async fn git_diff(repo_path: String, base: String, head: String) -> Res<String> {
    let r = git::validate_repo(&repo_path).map_err(e)?;
    tauri::async_runtime::spawn_blocking(move || git::diff(&r, &base, &head)).await.map_err(e)?.map_err(e)
}
#[tauri::command]
async fn git_show_file(repo_path: String, rev: String, path: String) -> Res<String> {
    let r = git::validate_repo(&repo_path).map_err(e)?;
    tauri::async_runtime::spawn_blocking(move || git::show_file(&r, &rev, &path)).await.map_err(e)?.map_err(e)
}
/// Git write: UI asks for confirmation first; refuses on a dirty tree.
#[tauri::command]
async fn git_checkout_detached(repo_path: String, rev: String) -> Res<()> {
    let r = git::validate_repo(&repo_path).map_err(e)?;
    tauri::async_runtime::spawn_blocking(move || git::checkout_detached(&r, &rev)).await.map_err(e)?.map_err(e)
}

/* ---------------- Remote compute + CodeGraph ---------------- */

#[tauri::command]
async fn ssh_run(host: String, root: String, task: remote::Task) -> Res<String> {
    tauri::async_runtime::spawn_blocking(move || remote::ssh_run(&host, &root, &task)).await.map_err(e)?.map_err(e)
}
#[tauri::command]
async fn codegraph(repo_path: String, sub: String, symbol: String) -> Res<String> {
    let r = git::validate_repo(&repo_path).map_err(e)?;
    tauri::async_runtime::spawn_blocking(move || remote::codegraph_local(&r, &sub, &symbol)).await.map_err(e)?.map_err(e)
}

#[tauri::command]
async fn codegraph_lineage(repo_path: String, direction: String, symbol: String, file: String) -> Res<serde_json::Value> {
    let root = git::validate_repo(&repo_path).map_err(e)?;
    tauri::async_runtime::spawn_blocking(move || remote::codegraph_lineage(&root, &direction, &symbol, &file))
        .await.map_err(e)?.map_err(e)
}

/* ---------------- GitHub OAuth device flow (no client secret in the binary) ---------------- */

#[derive(Serialize, serde::Deserialize)]
struct DeviceStart {
    device_code: String,
    user_code: String,
    verification_uri: String,
    interval: u64,
}

#[tauri::command]
async fn github_device_start(client_id: String) -> Res<DeviceStart> {
    tauri::async_runtime::spawn_blocking(move || {
        // Empty scope = read-only public access; writes are a separate, explicit upgrade.
        ureq::post("https://github.com/login/device/code")
            .set("Accept", "application/json")
            .send_json(serde_json::json!({ "client_id": client_id, "scope": "" }))
            .map_err(e)?
            .into_json::<DeviceStart>()
            .map_err(e)
    })
    .await
    .map_err(e)?
}

#[tauri::command]
async fn github_device_poll(client_id: String, device_code: String) -> Res<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(move || {
        ureq::post("https://github.com/login/oauth/access_token")
            .set("Accept", "application/json")
            .send_json(serde_json::json!({ "client_id": client_id, "device_code": device_code, "grant_type": "urn:ietf:params:oauth:grant-type:device_code" }))
            .map_err(e)?
            .into_json::<serde_json::Value>()
            .map_err(e)
    })
    .await
    .map_err(e)?
}

/* ---------------- Language servers (any language; registry lives in the UI) ---------------- */

#[tauri::command]
async fn lsp_query(m: tauri::State<'_, std::sync::Arc<lsp::LspManager>>, query: lsp::LspQuery) -> Res<serde_json::Value> {
    let mgr = m.inner().clone();
    tauri::async_runtime::spawn_blocking(move || mgr.query(&query)).await.map_err(e)?
}
#[tauri::command]
fn lsp_shutdown(m: tauri::State<'_, std::sync::Arc<lsp::LspManager>>) {
    m.shutdown_all();
}
#[tauri::command]
async fn git_head(repo_path: String) -> Res<String> {
    let r = git::validate_repo(&repo_path).map_err(e)?;
    tauri::async_runtime::spawn_blocking(move || git::run_git(&r, &["rev-parse", "HEAD"], std::time::Duration::from_secs(10)).map(|s| s.trim().to_string())).await.map_err(e)?.map_err(e)
}

/* ---------------- Mirror cache + worktree-at-SHA (§9, §5.4) ---------------- */

fn data_dir(app: &tauri::AppHandle) -> Res<std::path::PathBuf> {
    app.path().app_data_dir().map_err(e)
}

#[tauri::command]
async fn mirror_ensure(app: tauri::AppHandle, repo_key: String, fetch: bool) -> Res<String> {
    let d = data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || mirror::ensure_mirror(&d, &repo_key, fetch).map(|p| p.to_string_lossy().to_string()))
        .await
        .map_err(e)?
        .map_err(e)
}

#[tauri::command]
async fn timeline_fetch(app: tauri::AppHandle, repo_key: String, rev: String, depth: usize, trees: bool, since: Option<String>, refresh: Option<bool>) -> Res<(String, String)> {
    let dir = data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        mirror::timeline_fetch(&dir, &repo_key, &rev, depth, trees, since.as_deref(), refresh.unwrap_or(false))
            .map(|(path, reference)| (path.to_string_lossy().into_owned(), reference))
    }).await.map_err(e)?.map_err(e)
}

#[tauri::command]
async fn timeline_refs(app: tauri::AppHandle, repo_key: String) -> Res<mirror::TimelineRefs> {
    let dir = data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || mirror::timeline_refs(&repo_key, &dir))
        .await.map_err(e)?.map_err(e)
}

/// Exact-revision checkout for LSP: from the mirror (or a given local repo), detached, in the app cache.
#[tauri::command]
async fn worktree_at(app: tauri::AppHandle, repo_key: String, sha: String, local_repo: Option<String>) -> Res<String> {
    let d = data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let repo = match local_repo {
            Some(p) => git::validate_repo(&p)?,
            None => mirror::ensure_mirror(&d, &repo_key, false)?,
        };
        mirror::prune_worktrees(&d, std::time::Duration::from_secs(14 * 86400));
        mirror::worktree_at(&d, &repo, &repo_key.replace('/', "__"), &sha).map(|p| p.to_string_lossy().to_string())
    })
    .await
    .map_err(e)?
    .map_err(e)
}

/* ---------------- Local AI adapters (Claude Code / Codex CLI) ---------------- */

#[tauri::command]
async fn ai_local_run(tool: String, prompt: String) -> Res<String> {
    tauri::async_runtime::spawn_blocking(move || ai_local::run(&tool, &prompt, std::time::Duration::from_secs(300))).await.map_err(e)?
}

/* ---------------- Self-test (NONLINEAR_SELFTEST=1): exercises the real webview↔Rust bridge ---------------- */

#[derive(Serialize)]
struct SelftestMode {
    enabled: bool,
    /// opt-in real local-AI call (e.g. "claude-code"); spends the user's quota, so never default
    ai: Option<String>,
    repo: Option<String>,
    scratch: Option<String>,
}

#[tauri::command]
fn selftest_mode() -> SelftestMode {
    let enabled = std::env::var("NONLINEAR_SELFTEST").is_ok();
    let scratch = enabled.then(|| {
        let d = std::env::temp_dir().join(format!("nonlinear-selftest-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        let _ = std::fs::write(d.join("a.c"), "int foo(void) { return 1; }\n\nint main(void) {\n  return foo() + foo();\n}\n");
        d.to_string_lossy().to_string()
    });
    SelftestMode { enabled, ai: std::env::var("NONLINEAR_SELFTEST_AI").ok(), repo: std::env::var("NONLINEAR_SELFTEST_REPO").ok(), scratch }
}

#[tauri::command]
fn selftest_report(app: tauri::AppHandle, report: serde_json::Value) -> Res<()> {
    let out = std::env::var("NONLINEAR_SELFTEST_OUT").unwrap_or_else(|_| std::env::temp_dir().join("nonlinear-selftest.json").to_string_lossy().to_string());
    std::fs::write(&out, serde_json::to_string_pretty(&report).map_err(e)?).map_err(e)?;
    app.exit(0);
    Ok(())
}

/* ---------------- System-browser OAuth (RFC 8252 loopback) ---------------- */

#[tauri::command]
fn oauth_loopback_start(lb: tauri::State<oauth::Loopback>) -> Res<u16> {
    lb.start()
}
#[tauri::command]
fn oauth_loopback_poll(lb: tauri::State<oauth::Loopback>) -> Res<Option<String>> {
    match lb.take() {
        None => Ok(None),
        Some(Ok(q)) => Ok(Some(q)),
        Some(Err(x)) => Err(x),
    }
}
#[tauri::command]
fn open_external(url: String) -> Res<()> {
    oauth::open_external(&url)
}

#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

/// GUI apps launched from Finder/Dock get a minimal PATH; add the usual user tool
/// locations so git, ssh, language servers and local AI CLIs resolve like in a shell.
pub fn augment_path() {
    let home = std::env::var("HOME").unwrap_or_default();
    let extra = [
        format!("{home}/.local/bin"),
        format!("{home}/.cargo/bin"),
        format!("{home}/Library/Application Support/Coursier/bin"),
        format!("{home}/.local/share/coursier/bin"),
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
        "/usr/bin".into(),
        "/bin".into(),
    ];
    let cur = std::env::var("PATH").unwrap_or_default();
    let mut parts: Vec<String> = cur.split(':').filter(|p| !p.is_empty()).map(String::from).collect();
    for e in extra {
        if !parts.contains(&e) && std::path::Path::new(&e).is_dir() {
            parts.push(e);
        }
    }
    std::env::set_var("PATH", parts.join(":"));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    augment_path();
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let store = Store::open(&dir.join("nonlinear.sqlite3")).map_err(|x| Box::new(x) as Box<dyn std::error::Error>)?;
            app.manage(store);
            app.manage(oauth::Loopback::default());
            app.manage(std::sync::Arc::new(lsp::LspManager::default()));
            // Window starts hidden (tauri.conf.json). Show it normally, and also during an AI self-test:
            // macOS only presents the CLI's keychain-access prompt for a visible, active app.
            let selftest = std::env::var("NONLINEAR_SELFTEST").is_ok();
            let ai_selftest = std::env::var("NONLINEAR_SELFTEST_AI").is_ok();
            if !selftest || ai_selftest {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            review_mcp_share, db_load_all, db_put, db_restore, db_delete, blob_put, blob_get, blob_delete, outbox_add, outbox_all, outbox_remove, db_wipe, data_wipe_all, git_grep,
            keychain_get, keychain_set,
            git_log, git_refs, git_gitlinks, git_diff, git_show_file, git_checkout_detached,
            ssh_run, codegraph, codegraph_lineage,
            github_device_start, github_device_poll,
            oauth_loopback_start, oauth_loopback_poll, open_external, open_devtools,
            lsp_query, lsp_shutdown, git_head,
            selftest_mode, selftest_report,
            mirror_ensure, timeline_fetch, timeline_refs, worktree_at, ai_local_run
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nonlinear");
}
