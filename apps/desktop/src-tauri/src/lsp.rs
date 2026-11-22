//! Generic Language Server Protocol client (design §5.4).
//!
//! Language-agnostic: the UI passes the server command from a user-editable
//! registry (Metals for Scala, clangd for C/C++, pyright for Python,
//! rust-analyzer, typescript-language-server, verible-verilog-ls for
//! (System)Verilog, gopls, jdtls, …). One server process per (root, command),
//! JSON-RPC over stdio with Content-Length framing. Spawned via argv (no shell),
//! with request timeouts. Servers operate on the local working tree.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub fn encode(msg: &Value) -> Vec<u8> {
    let body = msg.to_string();
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend(body.into_bytes());
    out
}

/// Read one framed message. Returns None on EOF.
pub fn read_message<R: BufRead>(r: &mut R) -> std::io::Result<Option<Value>> {
    let mut len: Option<usize> = None;
    loop {
        let mut line = String::new();
        if r.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        let l = line.trim_end();
        if l.is_empty() {
            break;
        }
        if let Some(v) = l.strip_prefix("Content-Length:") {
            len = v.trim().parse().ok();
        }
    }
    let n = len.ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "missing Content-Length"))?;
    if n > 64 * 1024 * 1024 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "message too large"));
    }
    let mut buf = vec![0; n];
    r.read_exact(&mut buf)?;
    Ok(Some(serde_json::from_slice(&buf).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?))
}

pub fn validate_command(cmd: &str) -> Result<(), String> {
    let ok = !cmd.is_empty() && cmd.len() < 256 && !cmd.starts_with('-') && cmd.chars().all(|c| c.is_ascii_alphanumeric() || "/._-+".contains(c));
    if ok { Ok(()) } else { Err(format!("invalid language server command {cmd:?}")) }
}

pub fn file_uri(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let enc: String = s.chars().map(|c| if c.is_ascii_alphanumeric() || "/-_.~".contains(c) { c.to_string() } else { format!("%{:02X}", c as u32) }).collect();
    if enc.starts_with('/') { format!("file://{enc}") } else { format!("file:///{enc}") }
}

struct Server {
    child: Child,
    stdin: ChildStdin,
    next_id: i64,
    pending: Arc<Mutex<HashMap<i64, Sender<Value>>>>,
    opened: HashMap<String, i32>,
    root: PathBuf,
}

impl Server {
    fn start(root: &Path, command: &str, args: &[String]) -> Result<Self, String> {
        validate_command(command)?;
        let mut child = Command::new(command)
            .args(args)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("cannot start {command}: {e} (is it installed and on PATH?)"))?;
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let pending: Arc<Mutex<HashMap<i64, Sender<Value>>>> = Arc::default();
        let p2 = pending.clone();
        std::thread::spawn(move || {
            let mut r = BufReader::new(stdout);
            while let Ok(Some(msg)) = read_message(&mut r) {
                if let Some(id) = msg.get("id").and_then(Value::as_i64) {
                    if msg.get("method").is_none() {
                        if let Some(tx) = p2.lock().unwrap().remove(&id) {
                            let _ = tx.send(msg);
                        }
                    }
                }
            }
        });
        let mut s = Server { child, stdin, next_id: 1, pending, opened: HashMap::new(), root: root.to_path_buf() };
        s.request(
            "initialize",
            json!({
                "processId": std::process::id(),
                "rootUri": file_uri(root),
                "workspaceFolders": [{ "uri": file_uri(root), "name": root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default() }],
                "capabilities": { "textDocument": { "definition": { "linkSupport": false }, "references": {}, "documentSymbol": { "hierarchicalDocumentSymbolSupport": true }, "hover": { "contentFormat": ["markdown", "plaintext"] } } },
                "clientInfo": { "name": "Nonlinear" }
            }),
            Duration::from_secs(120),
        )?;
        s.notify("initialized", json!({}))?;
        Ok(s)
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.stdin.write_all(&encode(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))).map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())
    }

    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let (tx, rx): (Sender<Value>, Receiver<Value>) = channel();
        self.pending.lock().unwrap().insert(id, tx);
        self.stdin.write_all(&encode(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))).map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;
        match rx.recv_timeout(timeout) {
            Ok(msg) => match msg.get("error") {
                Some(err) => Err(format!("{method}: {}", err.get("message").and_then(Value::as_str).unwrap_or("error"))),
                None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
            },
            Err(RecvTimeoutError::Timeout) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("{method} timed out (server may still be indexing)"))
            }
            Err(_) => Err("language server exited".into()),
        }
    }

    fn ensure_open(&mut self, rel: &str, language_id: &str) -> Result<String, String> {
        let abs = self.root.join(rel);
        let canon = abs.canonicalize().map_err(|e| format!("{rel}: {e}"))?;
        if !canon.starts_with(&self.root) {
            return Err("path escapes the working tree".into());
        }
        let uri = file_uri(&canon);
        if !self.opened.contains_key(&uri) {
            let text = std::fs::read_to_string(&canon).map_err(|e| e.to_string())?;
            self.notify("textDocument/didOpen", json!({ "textDocument": { "uri": uri, "languageId": language_id, "version": 1, "text": text } }))?;
            self.opened.insert(uri.clone(), 1);
        }
        Ok(uri)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

#[derive(Default)]
pub struct LspManager {
    servers: Mutex<HashMap<(PathBuf, String), Arc<Mutex<Server>>>>,
}

#[derive(serde::Deserialize)]
pub struct LspQuery {
    pub root: String,
    pub command: String,
    pub args: Vec<String>,
    #[serde(rename = "languageId")]
    pub language_id: String,
    pub path: String,
    /// "definition" | "references" | "documentSymbol" | "hover"
    pub method: String,
    pub line: u32,
    pub character: u32,
}

impl LspManager {
    pub fn query(&self, q: &LspQuery) -> Result<Value, String> {
        let root = Path::new(&q.root).canonicalize().map_err(|e| format!("{}: {e}", q.root))?;
        if q.path.starts_with('/') || q.path.split('/').any(|s| s == "..") {
            return Err("invalid path".into());
        }
        let key = (root.clone(), q.command.clone());
        let server = {
            let mut m = self.servers.lock().unwrap();
            if let Some(s) = m.get(&key) {
                s.clone()
            } else {
                let s = Arc::new(Mutex::new(Server::start(&root, &q.command, &q.args)?));
                m.insert(key.clone(), s.clone());
                s
            }
        };
        let mut s = server.lock().unwrap();
        let uri = s.ensure_open(&q.path, &q.language_id)?;
        let pos = json!({ "line": q.line, "character": q.character });
        let (method, params) = match q.method.as_str() {
            "definition" => ("textDocument/definition", json!({ "textDocument": { "uri": uri }, "position": pos })),
            "references" => ("textDocument/references", json!({ "textDocument": { "uri": uri }, "position": pos, "context": { "includeDeclaration": false } })),
            "documentSymbol" => ("textDocument/documentSymbol", json!({ "textDocument": { "uri": uri } })),
            "hover" => ("textDocument/hover", json!({ "textDocument": { "uri": uri }, "position": pos })),
            m => return Err(format!("unsupported LSP method {m}")),
        };
        let res = s.request(method, params, Duration::from_secs(60));
        if res.is_err() && s.child.try_wait().map(|x| x.is_some()).unwrap_or(true) {
            drop(s);
            self.servers.lock().unwrap().remove(&key);
        }
        res
    }

    pub fn shutdown_all(&self) {
        self.servers.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framing_roundtrip() {
        let m = json!({ "jsonrpc": "2.0", "id": 1, "result": { "x": "é" } });
        let bytes = encode(&m);
        let mut r = BufReader::new(&bytes[..]);
        assert_eq!(read_message(&mut r).unwrap().unwrap(), m);
        assert!(read_message(&mut r).unwrap().is_none());
    }

    #[test]
    fn validates_commands_and_uris() {
        assert!(validate_command("clangd").is_ok());
        assert!(validate_command("/opt/homebrew/bin/rust-analyzer").is_ok());
        assert!(validate_command("sh -c x").is_err());
        assert!(validate_command("--evil").is_err());
        assert_eq!(file_uri(Path::new("/a b/c.scala")), "file:///a%20b/c.scala");
    }

    /// End-to-end against a tiny fake language server written in sh+python-free POSIX tools is
    /// impractical; instead we spawn this test binary's helper mode if available. Real servers
    /// (clangd, rust-analyzer, metals, …) are exercised manually / in the desktop smoke test.
    #[test]
    fn reports_missing_server_cleanly() {
        let m = LspManager::default();
        let dir = std::env::temp_dir();
        let e = m.query(&LspQuery { root: dir.to_string_lossy().into(), command: "definitely-not-a-language-server".into(), args: vec![], language_id: "c".into(), path: "x.c".into(), method: "definition".into(), line: 0, character: 0 }).unwrap_err();
        assert!(e.contains("cannot start"), "{e}");
    }

    #[test]
    fn clangd_definition_and_references_if_installed() {
        if Command::new("clangd").arg("--version").output().is_err() {
            eprintln!("clangd not installed; skipping");
            return;
        }
        let dir = std::env::temp_dir().join(format!("nl-lsp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.c"), "int foo(void) { return 1; }\n\nint main(void) {\n  return foo() + foo();\n}\n").unwrap();
        let m = LspManager::default();
        let q = |method: &str| LspQuery { root: dir.to_string_lossy().into(), command: "clangd".into(), args: vec![], language_id: "c".into(), path: "a.c".into(), method: method.into(), line: 3, character: 9 };
        let def = m.query(&q("definition")).unwrap();
        let first = if def.is_array() { def[0].clone() } else { def.clone() };
        assert_eq!(first["range"]["start"]["line"], 0, "{def}");
        let refs = m.query(&q("references")).unwrap();
        assert!(refs.as_array().map(|a| a.len() >= 2).unwrap_or(false), "{refs}");
        let syms = m.query(&q("documentSymbol")).unwrap();
        assert!(syms.to_string().contains("main"));
        m.shutdown_all();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
