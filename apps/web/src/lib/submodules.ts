/**
 * Repositories that are submodules of a GitHub repository (read from .gitmodules
 * on its default branch), optionally following nested submodules.
 */
import { parseGitmodules, type RepoInfo } from "@nonlinear/core";
import { githubApi } from "./github";
import { useApp } from "./store";

export interface SubmoduleScan {
  /** owner/repo keys of submodule repositories found (lower-case), in discovery order */
  repos: string[];
  /** submodules that aren't GitHub repositories (path → url) */
  skipped: string[];
  /** repositories whose .gitmodules couldn't be read */
  errors: string[];
}

export async function findSubmoduleRepos(root: string, opts: { nested: boolean; max?: number } = { nested: false }): Promise<SubmoduleScan> {
  const max = opts.max ?? 100;
  const c = await githubApi();
  const seen = new Set([root.toLowerCase()]);
  const out: SubmoduleScan = { repos: [], skipped: [], errors: [] };
  const infos: RepoInfo[] = [];
  let level = [root.toLowerCase()];
  for (let depth = 0; level.length && out.repos.length < max && depth < (opts.nested ? 5 : 1); depth++) {
    const next: string[] = [];
    for (const key of level) {
      const [owner, repo] = key.split("/") as [string, string];
      try {
        const info = await c.repo(owner, repo);
        const text = await c.contents(owner, repo, ".gitmodules", info.defaultBranch);
        if (!text) continue;
        for (const e of parseGitmodules(text, { owner, repo })) {
          if (!e.github) { out.skipped.push(`${key}: ${e.path}`); continue; }
          const k = `${e.github.owner}/${e.github.repo}`.toLowerCase();
          if (seen.has(k) || out.repos.length >= max) continue;
          seen.add(k);
          out.repos.push(k);
          next.push(k);
        }
      } catch {
        out.errors.push(key);
      }
    }
    level = next;
  }
  // Look up each repository so pickers can show it (name, description, your permission).
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(5, out.repos.length) }, async () => {
    while (i < out.repos.length) {
      const [owner, repo] = out.repos[i++]!.split("/") as [string, string];
      try { infos.push(await c.repo(owner, repo)); } catch { /* still added; shown without details */ }
    }
  }));
  if (infos.length) useApp.getState().putMany("repos", infos.map((r) => [r.key, r]));
  return out;
}
