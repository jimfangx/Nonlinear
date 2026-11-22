//! Local Git operations via the git CLI (design §7, §9).
//! Every invocation passes an argument vector (never a shell string), validates
//! repo paths and revisions, and applies a timeout and output cap.

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use wait_timeout::ChildExt;

pub const MAX_OUTPUT: usize = 64 * 1024 * 1024;

#[derive(Debug)]
pub struct GitError(pub String);

impl std::fmt::Display for GitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub fn validate_repo(path: &str) -> Result<PathBuf, GitError> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(GitError("repository path must be absolute".into()));
    }
    let canon = p.canonicalize().map_err(|e| GitError(format!("cannot access {path}: {e}")))?;
    if !canon.join(".git").exists() && !canon.join("HEAD").exists() {
        return Err(GitError(format!("{path} is not a git working tree or bare repository")));
    }
    Ok(canon)
}

/// Revisions: refs, SHAs, `A..B`, `--all`. No leading '-' except the explicit `--all`.
pub fn validate_rev(rev: &str) -> Result<(), GitError> {
    if rev == "--all" {
        return Ok(());
    }
    let ok = !rev.is_empty()
        && rev.len() <= 255
        && !rev.starts_with('-')
        && !rev.contains("...")
        && rev.chars().all(|c| c.is_ascii_alphanumeric() || "/._-~^".contains(c));
    if ok {
        Ok(())
    } else {
        Err(GitError(format!("invalid revision {rev:?}")))
    }
}

pub fn validate_relpath(p: &str) -> Result<(), GitError> {
    if p.is_empty() || p.starts_with('/') || p.starts_with('-') || p.split('/').any(|s| s == "..") || p.contains('\0') {
        return Err(GitError(format!("invalid path {p:?}")));
    }
    Ok(())
}

pub fn run_git(repo: &Path, args: &[&str], timeout: Duration) -> Result<String, GitError> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["-c", "core.pager=cat", "-c", "color.ui=false", "--no-optional-locks"])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| GitError(format!("failed to start git: {e}")))?;
    let mut out = Vec::new();
    let mut stdout = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.by_ref().take(MAX_OUTPUT as u64 + 1).read_to_end(&mut buf);
        buf
    });
    match child.wait_timeout(timeout).map_err(|e| GitError(e.to_string()))? {
        Some(status) => {
            out.extend(reader.join().unwrap_or_default());
            if out.len() > MAX_OUTPUT {
                return Err(GitError("git output exceeded cap".into()));
            }
            if !status.success() {
                let mut err = String::new();
                if let Some(mut e) = child.stderr.take() {
                    let _ = e.read_to_string(&mut err);
                }
                return Err(GitError(format!("git {}: {}", args.first().unwrap_or(&""), err.trim())));
            }
            Ok(String::from_utf8_lossy(&out).into_owned())
        }
        None => {
            let _ = child.kill();
            Err(GitError("git timed out".into()))
        }
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct LogEntry {
    pub sha: String,
    pub parents: Vec<String>,
    #[serde(rename = "committedAt")]
    pub committed_at: String,
    pub author: String,
    pub message: String,
    pub refs: Vec<String>,
}

const SEP: char = '\u{1f}';
const REC: char = '\u{1e}';

pub fn parse_log(out: &str) -> Vec<LogEntry> {
    out.split(REC)
        .filter_map(|rec| {
            let rec = rec.trim_start_matches('\n');
            if rec.is_empty() {
                return None;
            }
            let f: Vec<&str> = rec.splitn(6, SEP).collect();
            if f.len() < 6 {
                return None;
            }
            Some(LogEntry {
                sha: f[0].into(),
                parents: f[1].split_whitespace().map(String::from).collect(),
                committed_at: f[2].into(),
                author: f[3].into(),
                refs: f[4].split(", ").filter(|s| !s.is_empty()).map(|s| s.trim_start_matches("HEAD -> ").to_string()).collect(),
                message: f[5].trim_end().into(),
            })
        })
        .collect()
}

pub fn log(repo: &Path, rev: &str, limit: usize) -> Result<Vec<LogEntry>, GitError> {
    validate_rev(rev)?;
    let fmt = format!("--format=%H{SEP}%P{SEP}%cI{SEP}%an{SEP}%D{SEP}%B{REC}");
    let n = format!("-n{}", limit.min(20_000));
    let out = run_git(repo, &["log", "--topo-order", &n, &fmt, rev], Duration::from_secs(60))?;
    Ok(parse_log(&out))
}

#[derive(Serialize)]
pub struct RefEntry {
    pub name: String,
    pub sha: String,
    pub kind: String,
}

pub fn refs(repo: &Path) -> Result<Vec<RefEntry>, GitError> {
    let out = run_git(repo, &["for-each-ref", "--format=%(refname)%09%(objectname)%09%(*objectname)", "refs/heads", "refs/remotes", "refs/tags"], Duration::from_secs(20))?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let mut it = l.split('\t');
            let name = it.next()?;
            let sha = it.next()?;
            let peeled = it.next().unwrap_or("");
            let (kind, short) = if let Some(s) = name.strip_prefix("refs/tags/") {
                ("tag", s)
            } else if let Some(s) = name.strip_prefix("refs/heads/") {
                ("branch", s)
            } else {
                ("remote", name.strip_prefix("refs/remotes/").unwrap_or(name))
            };
            Some(RefEntry { name: short.into(), sha: if peeled.is_empty() { sha.into() } else { peeled.into() }, kind: kind.into() })
        })
        .collect())
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Gitlink {
    pub path: String,
    pub sha: String,
}

pub fn parse_ls_tree_gitlinks(out: &str) -> Vec<Gitlink> {
    out.split('\0')
        .filter_map(|l| {
            let (meta, path) = l.split_once('\t')?;
            let mut m = meta.split(' ');
            let mode = m.next()?;
            let _ty = m.next()?;
            let sha = m.next()?;
            (mode == "160000").then(|| Gitlink { path: path.into(), sha: sha.into() })
        })
        .collect()
}

pub fn gitlinks(repo: &Path, rev: &str) -> Result<Vec<Gitlink>, GitError> {
    validate_rev(rev)?;
    let out = run_git(repo, &["ls-tree", "-r", "-z", rev], Duration::from_secs(30))?;
    Ok(parse_ls_tree_gitlinks(&out))
}

pub fn diff(repo: &Path, base: &str, head: &str) -> Result<String, GitError> {
    validate_rev(base)?;
    validate_rev(head)?;
    run_git(repo, &["diff", "--no-ext-diff", "--submodule=short", base, head, "--"], Duration::from_secs(120))
}

pub fn show_file(repo: &Path, rev: &str, path: &str) -> Result<String, GitError> {
    validate_rev(rev)?;
    validate_relpath(path)?;
    let spec = format!("{rev}:{path}");
    run_git(repo, &["show", "--no-textconv", &spec], Duration::from_secs(30))
}

/// Non-destructive detached checkout: refuses if the working tree is dirty.
pub fn checkout_detached(repo: &Path, rev: &str) -> Result<(), GitError> {
    validate_rev(rev)?;
    let status = run_git(repo, &["status", "--porcelain", "--untracked-files=no"], Duration::from_secs(30))?;
    if !status.trim().is_empty() {
        return Err(GitError("working tree has uncommitted changes; refusing to checkout".into()));
    }
    run_git(repo, &["checkout", "--detach", rev], Duration::from_secs(120)).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rev_validation() {
        assert!(validate_rev("main").is_ok());
        assert!(validate_rev("--all").is_ok());
        assert!(validate_rev("abc123^").is_ok());
        assert!(validate_rev("origin/main~2").is_ok());
        assert!(validate_rev("--upload-pack=evil").is_err());
        assert!(validate_rev("a;rm -rf").is_err());
        assert!(validate_relpath("../etc/passwd").is_err());
        assert!(validate_relpath("src/main.rs").is_ok());
    }

    #[test]
    fn parses_log_and_lstree() {
        let out = format!("aaa{SEP}bbb ccc{SEP}2026-01-01T00:00:00Z{SEP}Jim{SEP}HEAD -> main, tag: v1{SEP}msg\nbody{REC}\n");
        let e = parse_log(&out);
        assert_eq!(e[0].parents, vec!["bbb", "ccc"]);
        assert_eq!(e[0].refs, vec!["main", "tag: v1"]);
        assert_eq!(e[0].message, "msg\nbody");
        let ls = "100644 blob 111\tREADME\x00160000 commit 222\tgenerators/boom\x00";
        assert_eq!(parse_ls_tree_gitlinks(ls), vec![Gitlink { path: "generators/boom".into(), sha: "222".into() }]);
    }

    #[test]
    fn runs_against_this_repo() {
        // The Nonlinear repo itself is a git repo; exercise log/refs end to end.
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap();
        let repo = validate_repo(root.to_str().unwrap()).unwrap();
        let l = log(&repo, "HEAD", 5).unwrap();
        assert!(!l.is_empty());
        assert!(refs(&repo).unwrap().iter().any(|r| r.kind == "branch"));
    }
}
