import { useEffect, useMemo, useRef } from "react";
import { useApp } from "../lib/store";

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
    const state = useApp.getState();
    const saved = state.settings_().layout;
    const history = (saved.graphRecent as string[] | undefined) ?? [];
    const counts = (saved.graphVisits as Record<string, number> | undefined) ?? {};
    state.setSettings({ layout: { ...saved, graphRecent: [current, ...history.filter((repo) => repo !== current)].slice(0, 12),
      graphVisits: { ...counts, [current]: (counts[current] ?? 0) + 1 } } });
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
