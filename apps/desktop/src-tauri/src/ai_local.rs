//! Optional local AI adapters (design §5.2): Claude Code / Codex CLI.
//! These are *adapters*, not API-key providers: they run the user's own
//! installed CLI non-interactively, prompt via stdin (never via a shell
//! string), with a timeout and output cap. Antigravity has no supported
//! public API and is intentionally not offered.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::Duration;
use wait_timeout::ChildExt;

pub fn argv(tool: &str) -> Result<(&'static str, Vec<&'static str>), String> {
    match tool {
        // print mode, no tools, text output
        "claude-code" => Ok(("claude", vec!["-p", "--output-format", "text"])),
        // non-interactive exec reading the prompt from stdin
        "codex-cli" => Ok(("codex", vec!["exec", "-"])),
        _ => Err(format!("unsupported local adapter {tool:?}")),
    }
}

pub fn run(tool: &str, prompt: &str, timeout: Duration) -> Result<String, String> {
    if prompt.len() > 2 * 1024 * 1024 {
        return Err("prompt too large".into());
    }
    let (bin, args) = argv(tool)?;
    // Empty sandbox cwd: the CLI must not treat "/" (Finder launch) or the user's repos as its project.
    let sandbox = std::env::temp_dir().join("nonlinear-ai-adapter");
    std::fs::create_dir_all(&sandbox).map_err(|e| e.to_string())?;
    let mut child = Command::new(bin)
        .args(&args)
        .current_dir(&sandbox)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{bin} not available: {e}"))?;
    {
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(prompt.as_bytes()).map_err(|e| e.to_string())?;
    }
    let mut stdout = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stdout.by_ref().take(4 * 1024 * 1024).read_to_string(&mut s);
        s
    });
    // Drain stderr concurrently so a chatty CLI can never block on a full pipe.
    let mut stderr = child.stderr.take().unwrap();
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.by_ref().take(256 * 1024).read_to_string(&mut s);
        s
    });
    match child.wait_timeout(timeout).map_err(|e| e.to_string())? {
        Some(st) if st.success() => Ok(reader.join().unwrap_or_default()),
        Some(_) => {
            let e = err_reader.join().unwrap_or_default();
            Err(format!("{bin} failed: {}", e.trim().chars().take(400).collect::<String>()))
        }
        None => {
            let _ = child.kill();
            Err(format!("{bin} timed out — if macOS showed a keychain prompt for the CLI's saved login, choose \"Always Allow\" and retry"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_known_adapters() {
        assert!(argv("claude-code").is_ok());
        assert!(argv("codex-cli").is_ok());
        assert!(argv("antigravity").is_err());
        assert!(argv("sh").is_err());
    }
}

#[cfg(test)]
mod live {
    /// Real call; opt-in only: NONLINEAR_LIVE_AI=claude-code cargo test live_adapter -- --nocapture
    #[test]
    fn live_adapter() {
        let Ok(tool) = std::env::var("NONLINEAR_LIVE_AI") else { return };
        crate::augment_path();
        let t0 = std::time::Instant::now();
        let r = super::run(&tool, "Reply with exactly the text NONLINEAR_ADAPTER_OK and nothing else.", std::time::Duration::from_secs(90));
        eprintln!("{tool}: {:?} in {:?}", r.as_ref().map(|s| s.trim()), t0.elapsed());
        assert!(r.unwrap().contains("NONLINEAR_ADAPTER_OK"));
    }
}
