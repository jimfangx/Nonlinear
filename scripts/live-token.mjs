// Token for live verification: GH_TOKEN env var, or a private file (default ~/.config/nonlinear/test-token).
// Never printed. Create the file yourself; it is not needed by the app.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
export function liveToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  const p = process.env.NONLINEAR_TEST_TOKEN_FILE ?? `${homedir()}/.config/nonlinear/test-token`;
  try {
    if ((statSync(p).mode & 0o077) !== 0) console.warn(`warning: ${p} is readable by others; run chmod 600 ${p}`);
    return readFileSync(p, "utf8").trim();
  } catch {
    throw new Error(`No token: set GH_TOKEN or create ${p} (fine-grained PAT for the test repo)`);
  }
}
