// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() == Some(std::ffi::OsStr::new("--review-mcp")) {
        if let Some(path) = args.next() {
            if let Err(error) = nonlinear_desktop_lib::serve_review_mcp(std::path::Path::new(&path)) {
                eprintln!("{error}");
                std::process::exit(1);
            }
            return;
        }
        eprintln!("Usage: nonlinear-desktop --review-mcp <absolute database path>");
        std::process::exit(2);
    }
    nonlinear_desktop_lib::run()
}
