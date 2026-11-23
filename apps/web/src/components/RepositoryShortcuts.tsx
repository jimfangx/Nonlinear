import { useEffect, useMemo, useRef } from "react";
import { parseRepoKey } from "@nonlinear/core";
import { useApp } from "../lib/store";
import type { CachedOption } from "./CachedEntry";

/** Remember that a repository was used (picker, PR page…): most recent first, with a visit count. */
export function recordRepositoryVisit(repo: string): void {
  const key = repo.toLowerCase();
  const state = useApp.getState();
  const saved = state.settings_().layout;
  const history = (saved.graphRecent as string[] | undefined) ?? [];
  if (history[0] === key) return;
  const counts = (saved.graphVisits as Record<string, number> | undefined) ?? {};
  state.setSettings({ layout: { ...saved, graphRecent: [key, ...history.filter((r) => r !== key)].slice(0, 12),
    graphVisits: { ...counts, [key]: (counts[key] ?? 0) + 1 } } });
}

/** Repositories for a type-ahead: pinned, then recently used, then everything else the app knows about. */
export function useRepositoryOptions(repositories: string[]): CachedOption[] {
  const layout = useApp((state) => state.settings_().layout);
  return useMemo(() => {
    const pinned = (layout.graphPinned as string[] | undefined) ?? [];
    const recent = (layout.graphRecent as string[] | undefined) ?? [];
    const out: CachedOption[] = [];
    const seen = new Set<string>();
    const add = (value: string, detail?: string) => {
      const v = value.toLowerCase();
      if (!seen.has(v)) { seen.add(v); out.push({ value: v, detail }); }
    };
    pinned.forEach((r) => add(r, "pinned"));
    recent.forEach((r) => add(r, "recent"));
    repositories.forEach((r) => add(r));
    return out;
  }, [layout, repositories]);
}

/** "owner/repo" from typed text or a GitHub URL, lower-cased; null if it isn't one. */
export function repositoryFromInput(text: string): string | null {
  const t = text.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  const ref = parseRepoKey(t.split("/").slice(0, 2).join("/"));
  return ref ? `${ref.owner}/${ref.repo}`.toLowerCase() : null;
}

export function useCachedRepositories(): string[] {
  const repositories = useApp((state) => state.repos);
  const views = useApp((state) => state.views);
  const prs = useApp((state) => state.prs);
  const timelines = useApp((state) => state.timelines);
  const local = useApp((state) => state.settings_().localRepos);
  return useMemo(() => [...new Set([
    ...Object.keys(repositories), ...Object.keys(local),
    ...Object.values(views).flatMap((view) => view.repos),
    ...Object.values(prs).map((pr) => `${pr.owner}/${pr.repo}`),
    ...Object.values(timelines).map((timeline) => timeline.root),
  ].map((repo) => repo.toLowerCase()))].sort(), [repositories, views, prs, timelines, local]);
}

export function RepositoryShortcuts({ current, repositories, onOpen }: {
  current: string | null;
  repositories: string[];
  onOpen: (repo: string) => void;
}) {
  const layout = useApp((state) => state.settings_().layout);
  const pinned = (layout.graphPinned as string[] | undefined) ?? [];
  const recent = (layout.graphRecent as string[] | undefined) ?? [];
  const visits = (layout.graphVisits as Record<string, number> | undefined) ?? {};
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (!current || current === previous.current) return;
    previous.current = current;
    recordRepositoryVisit(current);
  }, [current]);

  const ranked = [...new Set([...(current ? [current] : []), ...recent, ...repositories])].sort((a, b) => (visits[b] ?? 0) - (visits[a] ?? 0));
  const shortcuts = [...new Set([...pinned, ...ranked.slice(0, Math.max(5 - pinned.length, 0)), ...(current ? [current] : [])])];
  const togglePin = (repo: string) => {
    const state = useApp.getState();
    state.setSettings({ layout: { ...state.settings_().layout, graphPinned: pinned.includes(repo) ? pinned.filter((value) => value !== repo) : [...pinned, repo] } });
  };
  return <>{shortcuts.map((repo) => <span className={`graph-shortcut ${repo === current ? "selected" : ""}`} key={repo}>
    <button type="button" onClick={() => onOpen(repo)} title={repo}>{repo.split("/").at(-1)}</button>
    <button type="button" onClick={() => togglePin(repo)} aria-pressed={pinned.includes(repo)}
      aria-label={`${pinned.includes(repo) ? "Unpin" : "Pin"} ${repo}`}>{pinned.includes(repo) ? "★" : "☆"}</button>
  </span>)}</>;
}
