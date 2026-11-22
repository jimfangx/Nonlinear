/**
 * `.gitmodules` parsing and GitHub URL resolution (design §3.1, §3.3, §6).
 * Must be resolved at the *selected root commit*, not today's file.
 */
import { isUnsafePath } from "../diff/unified";

export interface GitmoduleEntry {
  name: string;
  path: string;
  url: string;
  branch: string | null;
  /** resolved GitHub owner/repo when the URL points to github.com */
  github: { owner: string; repo: string } | null;
  issues: string[];
}

export function parseGitmodules(text: string, parentGithub?: { owner: string; repo: string }): GitmoduleEntry[] {
  const out: GitmoduleEntry[] = [];
  let cur: { name: string; kv: Record<string, string> } | null = null;
  const push = () => {
    if (!cur) return;
    const path = cur.kv.path ?? "";
    const url = cur.kv.url ?? "";
    const issues: string[] = [];
    if (!path) issues.push("Missing path");
    else if (isUnsafePath(path)) issues.push("Unsafe path");
    if (!url) issues.push("Missing url");
    out.push({ name: cur.name, path: path.replace(/\/$/, ""), url, branch: cur.kv.branch ?? null, github: resolveGithubUrl(url, parentGithub), issues });
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[#;].*$/, "").trim();
    if (!line) continue;
    const sec = /^\[submodule\s+"(.+)"\]$/.exec(line);
    if (sec) {
      push();
      cur = { name: sec[1]!, kv: {} };
      continue;
    }
    const kv = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(line);
    if (kv && cur) cur.kv[kv[1]!.toLowerCase()] = kv[2]!.replace(/^"(.*)"$/, "$1");
  }
  push();
  return out;
}

export function resolveGithubUrl(url: string, parent?: { owner: string; repo: string }): { owner: string; repo: string } | null {
  let m = /^(?:https?:\/\/|git:\/\/)(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  if (m) return { owner: m[1]!, repo: m[2]! };
  m = /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  if (m) return { owner: m[1]!, repo: m[2]! };
  // Relative URL: ../repo.git or ../../owner/repo.git relative to parent
  if (parent && /^\.\.?\//.test(url)) {
    const parts = [parent.owner, parent.repo];
    for (const seg of url.replace(/\.git$/, "").split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== ".") parts.push(seg);
    }
    if (parts.length === 2) return { owner: parts[0]!, repo: parts[1]! };
  }
  return null;
}

/** Submodule paths as a Map for diff import resolution. */
export function submoduleMap(entries: GitmoduleEntry[]): Map<string, { owner: string; repo: string; url: string }> {
  const m = new Map<string, { owner: string; repo: string; url: string }>();
  for (const e of entries) if (e.github && !e.issues.length) m.set(e.path, { ...e.github, url: e.url });
  return m;
}
