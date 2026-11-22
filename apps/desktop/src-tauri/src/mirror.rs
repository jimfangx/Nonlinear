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
