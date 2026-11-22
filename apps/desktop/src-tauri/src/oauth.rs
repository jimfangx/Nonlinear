//! Native-app OAuth via the system browser (RFC 8252): a one-shot loopback
//! listener on 127.0.0.1 receives the redirect. The PKCE verifier stays in the
//! app; no client secret is bundled (the Nonlinear Cloud backend holds it).

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct Loopback {
    result: Arc<Mutex<Option<Result<String, String>>>>,
}

impl Loopback {
    /// Bind 127.0.0.1:0 and accept exactly one `GET /cb?...` request in a thread.
    pub fn start(&self) -> Result<u16, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        *self.result.lock().unwrap() = None;
        let slot = self.result.clone();
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(600);
            listener.set_nonblocking(true).ok();
            while Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).ok();
                        stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
                        let mut line = String::new();
                        let _ = BufReader::new(&stream).read_line(&mut line);
                        let target = line.split_whitespace().nth(1).unwrap_or("").to_string();
                        let (status, body, res) = if let Some(q) = target.strip_prefix("/cb?") {
                            ("200 OK", "<h3>Nonlinear: signed in.</h3><p>You can close this tab and return to the app.</p>", Ok(q.to_string()))
                        } else {
                            ("404 Not Found", "Not found", Err(String::new()))
                        };
                        let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len());
                        if let Ok(q) = res {
                            *slot.lock().unwrap() = Some(Ok(q));
                            return;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(100)),
                    Err(e) => {
                        *slot.lock().unwrap() = Some(Err(e.to_string()));
                        return;
                    }
                }
            }
            *slot.lock().unwrap() = Some(Err("timed out waiting for the browser".into()));
        });
        Ok(port)
    }

    /// Poll for the query string received on /cb (None while pending).
    pub fn take(&self) -> Option<Result<String, String>> {
        self.result.lock().unwrap().take()
    }
}

/// Open a URL in the OS browser. Only https URLs (or loopback http) are allowed.
pub fn open_external(url: &str) -> Result<(), String> {
    let ok = url.starts_with("https://") || url.starts_with("http://127.0.0.1") || url.starts_with("http://localhost");
    if !ok || url.chars().any(|c| c.is_control() || c == '"' || c == '\'' || c == ' ') {
        return Err("refusing to open this URL".into());
    }
    #[cfg(target_os = "macos")]
    let st = std::process::Command::new("open").arg(url).status();
    #[cfg(target_os = "windows")]
    let st = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let st = std::process::Command::new("xdg-open").arg(url).status();
    st.map_err(|e| e.to_string()).and_then(|s| if s.success() { Ok(()) } else { Err("browser launch failed".into()) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpStream;

    #[test]
    fn loopback_receives_one_callback() {
        let lb = Loopback::default();
        let port = lb.start().unwrap();
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET /cb?nl_code=abc&client_state=xyz HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
        let mut resp = String::new();
        s.read_to_string(&mut resp).unwrap();
        assert!(resp.starts_with("HTTP/1.1 200"));
        for _ in 0..50 {
            if let Some(r) = lb.take() {
                assert_eq!(r.unwrap(), "nl_code=abc&client_state=xyz");
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("no result");
    }

    #[test]
    fn refuses_unsafe_urls() {
        assert!(open_external("file:///etc/passwd").is_err());
        assert!(open_external("javascript:alert(1)").is_err());
        assert!(open_external("https://x\" && rm").is_err());
    }
}
