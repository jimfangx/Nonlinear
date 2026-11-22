//! Managed mirror cache + worktree-at-SHA (design §9 "filtered/shallow mirrors
//! first, with a single child fetched on demand"; §5.4 LSP on the exact revision).
//!
//! - Mirrors: blob-less partial bare clones of *public GitHub* repositories in the
//!   app data dir (`mirrors/<owner>/<repo>.git`). Blobs are fetched lazily by git.
//! - Worktrees: detached `git worktree add` at an exact SHA in the app cache
//!   (`worktrees/<owner>__<repo>__<sha12>`), never touching the user's checkout.

use crate::git::{run_git, validate_rev, GitError};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn valid_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// `owner/repo` → https URL (public GitHub only; private repos are out of scope by default).
pub fn github_url(repo_key: &str) -> Result<(String, String, String), GitError> {
    let (o, r) = repo_key.split_once('/').ok_or_else(|| GitError("expected owner/repo".into()))?;
    if !valid_name(o) || !valid_name(r) {
        return Err(GitError(format!("invalid repository {repo_key:?}")));
    }
    Ok((format!("https://github.com/{o}/{r}.git"), o.to_lowercase(), r.to_lowercase()))
}

pub fn mirror_path(root: &Path, owner: &str, repo: &str) -> PathBuf {
    root.join("mirrors").join(owner).join(format!("{repo}.git"))
}

fn git_global(args: &[&str], cwd: &Path, timeout: Duration) -> Result<String, GitError> {
    run_git(cwd, args, timeout)
}

/// Ensure a partial mirror exists (clone if missing) and optionally fetch updates.
pub fn ensure_mirror_from(url: &str, dest: &Path, fetch: bool) -> Result<PathBuf, GitError> {
    if dest.join("HEAD").exists() {
        if fetch {
            git_global(&["fetch", "--prune", "--filter=blob:none", "origin", "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"], dest, Duration::from_secs(600))?;
        }
        return Ok(dest.to_path_buf());
    }
    let parent = dest.parent().ok_or_else(|| GitError("bad mirror path".into()))?;
    std::fs::create_dir_all(parent).map_err(|e| GitError(e.to_string()))?;
    let tmp = dest.with_extension("partial");
    let _ = std::fs::remove_dir_all(&tmp);
    git_global(&["clone", "--bare", "--filter=blob:none", "--no-tags", url, tmp.to_str().unwrap()], parent, Duration::from_secs(1800))?;
    git_global(&["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"], &tmp, Duration::from_secs(10))?;
    git_global(&["fetch", "--filter=blob:none", "origin", "+refs/tags/*:refs/tags/*"], &tmp, Duration::from_secs(600)).ok();
    std::fs::rename(&tmp, dest).map_err(|e| GitError(e.to_string()))?;
    Ok(dest.to_path_buf())
}

pub fn ensure_mirror(data_dir: &Path, repo_key: &str, fetch: bool) -> Result<PathBuf, GitError> {
    let (url, o, r) = github_url(repo_key)?;
    ensure_mirror_from(&url, &mirror_path(data_dir, &o, &r), fetch)
}

/// Fetch a bounded timeline ref into a bare object cache. The root needs trees
/// for .gitmodules and gitlinks, while child history needs only commit objects.
pub fn timeline_fetch(data_dir: &Path, repo_key: &str, rev: &str, depth: usize, trees: bool, since: Option<&str>) -> Result<(PathBuf, String), GitError> {
    let (url, owner, repo) = github_url(repo_key)?;
    let cache = data_dir.join(if trees { "timeline-trees" } else { "timeline-history" }).join(owner).join(repo);
    let depth = depth.clamp(1, 20_000);
    if rev.starts_with('-') { return Err(GitError("expected a remote ref or SHA".into())); }
    validate_rev(rev)?;
    let window = since.filter(|date| {
        date.len() == 10 && date.bytes().enumerate().all(|(i, b)| {
            if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() }
        })
    });
    if since.is_some() && window.is_none() { return Err(GitError("expected YYYY-MM-DD".into())); }
    let slot = match window {
        Some(date) => format!("refs/nonlinear/since/{date}/{rev}"),
        None => format!("refs/nonlinear/{depth}/{rev}"),
    };
    let locks = TIMELINE_LOCKS.get_or_init(|| std::array::from_fn(|_| std::sync::Mutex::new(())));
    let bucket = cache.to_string_lossy().bytes().map(usize::from).sum::<usize>() % locks.len();
    let _guard = locks[bucket].lock().map_err(|e| GitError(e.to_string()))?;
    timeline_fetch_from(&url, &cache, rev, &slot, depth, trees, window)?;
    Ok((cache, slot))
}

static TIMELINE_LOCKS: std::sync::OnceLock<[std::sync::Mutex<()>; 32]> = std::sync::OnceLock::new();

fn timeline_fetch_from(url: &str, cache: &Path, rev: &str, slot: &str, depth: usize, trees: bool, since: Option<&str>) -> Result<(), GitError> {
    std::fs::create_dir_all(cache).map_err(|e| GitError(e.to_string()))?;
    let short = Duration::from_secs(10);
    git_global(&["check-ref-format", slot], cache, short)?;
    if !cache.join("HEAD").is_file() {
        git_global(&["init", "--bare", "--quiet"], cache, short)?;
    }
    let filter = if trees { "blob:none" } else { "tree:0" };
    let spec = format!("{rev}^{{commit}}");
    let immutable = rev.len() == 40 && rev.bytes().all(|b| b.is_ascii_hexdigit());
    if immutable && git_global(&["rev-parse", "--verify", &spec], cache, short).is_ok() {
        git_global(&["update-ref", slot, rev], cache, short)?;
        return Ok(());
    }

    use std::hash::{DefaultHasher, Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    slot.hash(&mut hasher);
    let stamp = cache.join(format!("nonlinear-fetch-{:016x}", hasher.finish()));
    if let Ok(age) = std::fs::metadata(&stamp).and_then(|m| m.modified()).and_then(|m| {
        m.elapsed().map_err(std::io::Error::other)
    }) {
        if age < Duration::from_secs(30 * 60) { return Ok(()); }
    }

    git_global(&["config", "remote.origin.url", url], cache, short)?;
    git_global(&["config", "remote.origin.promisor", "true"], cache, short)?;
    git_global(&["config", "credential.helper", ""], cache, short)?;
    git_global(&["config", "remote.origin.partialclonefilter", filter], cache, short)?;
    let refspec = format!("+{rev}:{slot}");
    let fetch = |history: &str| git_global(&[
        "-c", "credential.helper=", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head",
        &format!("--filter={filter}"), history, "origin", &refspec,
    ], cache, Duration::from_secs(90));
    let depth_arg = format!("--depth={depth}");
    let fetched = match since {
        Some(date) => fetch(&format!("--shallow-since={date}T00:00:00Z")).or_else(|_| fetch("--depth=1")),
        None => fetch(&depth_arg),
    };
    if fetched.is_err() && git_global(&["show-ref", "--verify", "--quiet", slot], cache, short).is_ok() {
        return Ok(());
    }
    fetched?;
    std::fs::write(stamp, []).map_err(|e| GitError(e.to_string()))
}

#[derive(serde::Serialize)]
pub struct TimelineRefs {
    pub branch: Option<String>,
    pub branches: Vec<(String, String)>,
    pub tags: Vec<(String, String)>,
}

pub fn timeline_refs(repo_key: &str, cwd: &Path) -> Result<TimelineRefs, GitError> {
    let (url, _, _) = github_url(repo_key)?;
    let output = git_global(&["-c", "credential.helper=", "ls-remote", "--symref", &url, "HEAD", "refs/heads/*", "refs/tags/*"], cwd, Duration::from_secs(20))?;
    let mut branch = None;
    let mut tags = std::collections::BTreeMap::new();
    let mut branches = Vec::new();
    for line in output.lines() {
        let Some((value, reference)) = line.split_once('\t') else { continue };
        if reference == "HEAD" {
            if let Some(name) = value.strip_prefix("ref: refs/heads/") { branch = Some(name.to_owned()); }
        }
        if let Some(name) = reference.strip_prefix("refs/heads/") {
            branches.push((name.to_owned(), value.to_owned()));
        }
        if let Some(name) = reference.strip_prefix("refs/tags/") {
            let name = name.strip_suffix("^{}").unwrap_or(name);
            tags.insert(name.to_owned(), value.to_owned());
        }
    }
    Ok(TimelineRefs { branch, branches, tags: tags.into_iter().collect() })
}

/// Make sure `sha` is present (e.g. a PR head that isn't on any branch).
pub fn ensure_commit(repo: &Path, sha: &str) -> Result<(), GitError> {
    validate_rev(sha)?;
    let spec = format!("{sha}^{{commit}}");
    if run_git(repo, &["cat-file", "-e", &spec], Duration::from_secs(10)).is_ok() {
        return Ok(());
    }
    run_git(repo, &["fetch", "--filter=blob:none", "origin", sha], Duration::from_secs(600)).map(|_| ())
}

/// Detached worktree at an exact SHA inside the app cache. Idempotent.
pub fn worktree_at(data_dir: &Path, repo: &Path, label: &str, sha: &str) -> Result<PathBuf, GitError> {
    validate_rev(sha)?;
    if !label.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        return Err(GitError("invalid worktree label".into()));
    }
    let dir = data_dir.join("worktrees").join(format!("{label}__{}", &sha[..sha.len().min(12)]));
    if dir.join(".git").exists() {
        return Ok(dir);
    }
    std::fs::create_dir_all(data_dir.join("worktrees")).map_err(|e| GitError(e.to_string()))?;
    ensure_commit(repo, sha)?;
    run_git(repo, &["worktree", "add", "--detach", "--force", dir.to_str().unwrap(), sha], Duration::from_secs(900))?;
    Ok(dir)
}

/// Remove cached worktrees not used for `max_age` (bounded disk use).
pub fn prune_worktrees(data_dir: &Path, max_age: Duration) -> usize {
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(data_dir.join("worktrees")) {
        for e in rd.flatten() {
            let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|a| a > max_age).unwrap_or(false);
            if old && std::fs::remove_dir_all(e.path()).is_ok() {
                n += 1;
            }
        }
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(cwd: &Path, args: &[&str]) {
        let st = Command::new("git").args(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main"]).args(args).current_dir(cwd).output().unwrap();
        assert!(st.status.success(), "{:?}", String::from_utf8_lossy(&st.stderr));
    }

    #[test]
    fn rejects_bad_repo_keys() {
        assert!(github_url("ucb-bar/chipyard").is_ok());
        assert!(github_url("../x").is_err());
        assert!(github_url("a/b;rm").is_err());
        assert!(github_url("a/..").is_err());
    }

    #[test]
    fn mirror_then_worktree_at_exact_sha() {
        let base = std::env::temp_dir().join(format!("nl-mirror-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        git(&src, &["init", "-q"]);
        std::fs::write(src.join("a.txt"), "one").unwrap();
        git(&src, &["add", "."]);
        git(&src, &["commit", "-qm", "one"]);
        let first = String::from_utf8(Command::new("git").args(["rev-parse", "HEAD"]).current_dir(&src).output().unwrap().stdout).unwrap().trim().to_string();
        std::fs::write(src.join("a.txt"), "two").unwrap();
        git(&src, &["commit", "-qam", "two"]);
        git(&src, &["config", "uploadpack.allowFilter", "true"]);
        git(&src, &["config", "uploadpack.allowAnySHA1InWant", "true"]);

        let data = base.join("data");
        let url = format!("file://{}", src.display());
        let thin = data.join("timeline");
        timeline_fetch_from(&url, &thin, "HEAD", "refs/nonlinear/1/HEAD", 1, true, None).unwrap();
        let tip = crate::git::log(&thin, "refs/nonlinear/1/HEAD", 10).unwrap();
        assert_eq!(tip.len(), 1);
        assert_eq!(crate::git::show_file(&thin, &tip[0].sha, "a.txt").unwrap(), "two");
        let history = data.join("history");
        timeline_fetch_from(&url, &history, "HEAD", "refs/nonlinear/2/HEAD", 2, false, None).unwrap();
        let log = crate::git::log(&history, "refs/nonlinear/2/HEAD", 10).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[1].sha, first);
        timeline_fetch_from(&url, &history, &first, "refs/nonlinear/pin", 1, false, None).unwrap();
        assert_eq!(crate::git::log(&history, "refs/nonlinear/pin", 1).unwrap()[0].sha, first);
        assert!(timeline_fetch_from(&url, &history, "--all", "refs/nonlinear/--all", 1, false, None).is_err());
        let dated = data.join("dated-history");
        timeline_fetch_from(&url, &dated, "HEAD", "refs/nonlinear/since/2000-01-01/HEAD", 1, false, Some("2000-01-01")).unwrap();
        assert_eq!(crate::git::log(&dated, "refs/nonlinear/since/2000-01-01/HEAD", 10).unwrap().len(), 2);
        let m = ensure_mirror_from(&url, &data.join("mirrors/o/r.git"), false).unwrap();
        assert!(m.join("HEAD").exists());
        assert!(!crate::git::log(&m, "--all", 10).unwrap().is_empty());
        // idempotent + fetch path
        ensure_mirror_from(&url, &m, true).unwrap();
        let wt = worktree_at(&data, &m, "o__r", &first).unwrap();
        assert_eq!(std::fs::read_to_string(wt.join("a.txt")).unwrap(), "one");
        assert_eq!(worktree_at(&data, &m, "o__r", &first).unwrap(), wt);
        assert!(worktree_at(&data, &m, "bad label", &first).is_err());
        let _ = std::fs::remove_dir_all(&base);
    }
}
