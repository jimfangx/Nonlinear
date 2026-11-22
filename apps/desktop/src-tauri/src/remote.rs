//! SSH offload + CodeGraph (design §5.4, §9).
//! Only allowlisted task kinds run, with validated arguments, over
//! `ssh -o BatchMode=yes <alias> -- nonlinear-helper <kind> ...` (no sudo, no
//! shell string built from user/imported text). Output and time are bounded.

use crate::git::{validate_relpath, validate_rev, GitError, MAX_OUTPUT};
use serde::Deserialize;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;
use wait_timeout::ChildExt;

#[derive(Deserialize)]
pub struct Task {
    pub kind: String,
    /// repository path relative to the host's registered root
    pub repo: String,
    pub args: Vec<String>,
}

pub fn validate_alias(alias: &str) -> Result<(), GitError> {
    if alias.is_empty() || alias.len() > 64 || alias.starts_with('-') || !alias.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        return Err(GitError(format!("invalid ssh alias {alias:?}")));
    }
    Ok(())
}

/// Build the argv sent to the remote helper; rejects anything not allowlisted.
pub fn helper_argv(root: &str, t: &Task) -> Result<Vec<String>, GitError> {
    if !root.starts_with('/') || root.contains("..") || root.chars().any(|c| c.is_whitespace() || "'\"`$;&|<>\\".contains(c)) {
        return Err(GitError("invalid remote root".into()));
    }
    if !t.repo.is_empty() {
        validate_relpath(&t.repo)?;
    }
    let repo = if t.repo.is_empty() { root.to_string() } else { format!("{}/{}", root.trim_end_matches('/'), t.repo) };
    if repo.chars().any(|c| c.is_whitespace() || "'\"`$;&|<>\\".contains(c)) {
        return Err(GitError("invalid characters in repo path".into()));
    }
    let mut argv = vec!["nonlinear-helper".to_string(), t.kind.clone(), repo];
    match (t.kind.as_str(), t.args.as_slice()) {
        ("version", []) => argv.truncate(2),
        ("git-log", [rev, n]) => {
            validate_rev(rev)?;
            let n: u32 = n.parse().map_err(|_| GitError("bad count".into()))?;
            argv.extend([rev.clone(), n.min(20_000).to_string()]);
        }
        ("refs", []) => {}
        ("show-file", [rev, path]) => {
            validate_rev(rev)?;
            validate_relpath(path)?;
            if path.chars().any(|c| c.is_whitespace() || "'\"`$;&|<>\\".contains(c)) {
                return Err(GitError("invalid characters in path".into()));
            }
            argv.extend([rev.clone(), path.clone()]);
        }
        ("gitlinks", [rev]) => {
            validate_rev(rev)?;
            argv.push(rev.clone());
        }
        ("diff", [a, b]) => {
            validate_rev(a)?;
            validate_rev(b)?;
            argv.extend([a.clone(), b.clone()]);
        }
        ("codegraph", [sub, symbol]) => {
            if !["impact", "callers", "callees", "affected"].contains(&sub.as_str()) || !symbol.chars().all(|c| c.is_ascii_alphanumeric() || "_.$".contains(c)) {
                return Err(GitError("invalid codegraph query".into()));
            }
            argv.extend([sub.clone(), symbol.clone()]);
        }
        _ => return Err(GitError(format!("task {:?} is not allowed", t.kind))),
    }
    Ok(argv)
}

fn run_bounded(mut cmd: Command, timeout: Duration) -> Result<String, GitError> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| GitError(e.to_string()))?;
    let mut stdout = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.by_ref().take(MAX_OUTPUT as u64 + 1).read_to_end(&mut buf);
        buf
    });
    match child.wait_timeout(timeout).map_err(|e| GitError(e.to_string()))? {
        Some(st) => {
            let out = reader.join().unwrap_or_default();
            if out.len() > MAX_OUTPUT {
                return Err(GitError("output exceeded cap".into()));
            }
            if !st.success() {
                let mut e = String::new();
                if let Some(mut s) = child.stderr.take() {
                    let _ = s.read_to_string(&mut e);
                }
                return Err(GitError(e.trim().chars().take(500).collect()));
            }
            Ok(String::from_utf8_lossy(&out).into_owned())
        }
        None => {
            let _ = child.kill();
            Err(GitError("timed out".into()))
        }
    }
}

pub fn ssh_run(alias: &str, root: &str, t: &Task) -> Result<String, GitError> {
    validate_alias(alias)?;
    let argv = helper_argv(root, t)?;
    let mut cmd = Command::new("ssh");
    cmd.args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-T", alias, "--"]).args(&argv);
    run_bounded(cmd, Duration::from_secs(300))
}

pub fn codegraph_local(repo: &Path, sub: &str, symbol: &str) -> Result<String, GitError> {
    let t = Task { kind: "codegraph".into(), repo: String::new(), args: vec![sub.into(), symbol.into()] };
    helper_argv("/", &t)?; // reuse validation
    let mut cmd = Command::new("codegraph");
    cmd.current_dir(repo).args([sub, symbol]);
    run_bounded(cmd, Duration::from_secs(120)).map_err(|e| {
        if e.0.contains("No such file") || e.0.contains("not found") {
            GitError("CodeGraph CLI not installed (https://github.com/colbymchenry/codegraph); using heuristic fallback".into())
        } else {
            e
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allowlist() {
        let t = |k: &str, a: &[&str]| Task { kind: k.into(), repo: "chipyard".into(), args: a.iter().map(|s| s.to_string()).collect() };
        assert_eq!(helper_argv("/home/me", &t("git-log", &["main", "100"])).unwrap(), vec!["nonlinear-helper", "git-log", "/home/me/chipyard", "main", "100"]);
        assert!(helper_argv("/home/me", &t("rm", &[])).is_err());
        assert!(helper_argv("/home/me", &t("git-log", &["$(reboot)", "1"])).is_err());
        assert!(helper_argv("/home/me", &t("codegraph", &["impact", "foo;ls"])).is_err());
        assert!(helper_argv("/home/me; ls", &t("version", &[])).is_err());
        assert!(helper_argv("/home/me", &Task { kind: "diff".into(), repo: "../x".into(), args: vec!["a".into(), "b".into()] }).is_err());
        assert!(validate_alias("-oProxyCommand=x").is_err());
        assert!(helper_argv("/r", &t("show-file", &["main", ".gitmodules"])).is_ok());
        assert!(helper_argv("/r", &t("show-file", &["main", "a b;rm"])).is_err());
        assert!(validate_alias("bwrc").is_ok());
    }
}
