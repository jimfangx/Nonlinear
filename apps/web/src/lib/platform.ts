/**
 * Platform bridge. In the Tauri desktop shell, heavy/local operations (git,
 * SQLite mirror, SSH helper, keychain) are invoked in the Rust core. On the
 * web PWA these return `unavailable` and the UI shows a clear message (§9).
 */

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isDesktop(): boolean {
  return typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;
}

export class Unavailable extends Error {
  constructor(feature: string) {
    super(`${feature} requires the desktop app or a paired agent.`);
  }
}

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) throw new Unavailable(cmd);
  const { invoke: inv } = await import("@tauri-apps/api/core");
  return inv<T>(cmd, args);
}

/** Desktop commands implemented in apps/desktop/src-tauri/src/commands.rs */
export const desktop = {
  gitLog: (repoPath: string, rev: string, limit: number) =>
    invoke<{ sha: string; parents: string[]; committedAt: string; author: string; message: string; refs: string[] }[]>("git_log", { repoPath, rev, limit }),
  gitRefs: (repoPath: string) => invoke<{ name: string; sha: string; kind: string }[]>("git_refs", { repoPath }),
  gitGitlinks: (repoPath: string, rev: string) => invoke<{ path: string; sha: string }[]>("git_gitlinks", { repoPath, rev }),
  gitDiff: (repoPath: string, base: string, head: string) => invoke<string>("git_diff", { repoPath, base, head }),
  gitShow: (repoPath: string, rev: string, path: string) => invoke<string>("git_show_file", { repoPath, rev, path }),
  keychainGet: (key: string) => invoke<string | null>("keychain_get", { key }),
  keychainSet: (key: string, value: string | null) => invoke<void>("keychain_set", { key, value }),
  sshRun: (host: string, root: string, task: { kind: string; repo: string; args: string[] }) => invoke<string>("ssh_run", { host, root, task }),
  codegraph: (repoPath: string, sub: string, symbol: string) => invoke<string>("codegraph", { repoPath, sub, symbol }),
  deviceLogin: (clientId: string) => invoke<{ user_code: string; verification_uri: string; device_code: string; interval: number }>("github_device_start", { clientId }),
  devicePoll: (clientId: string, deviceCode: string) => invoke<{ access_token?: string; scope?: string; error?: string }>("github_device_poll", { clientId, deviceCode }),
};
