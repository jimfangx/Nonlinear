import { CachedEntry } from "./CachedEntry";
import { useCachedRepositories, useRepositoryOptions } from "./RepositoryShortcuts";
import { searchGitHubRepos } from "../lib/repoSearch";

/**
 * Repository type-ahead used wherever the app asks for a repo: pinned and recent
 * repositories first, then everything cached; on a cache miss it searches GitHub.
 */
export function RepoEntry({ value, onChange, onSelect, label = "Repository", placeholder = "owner/repo", exclude }: {
  value: string;
  onChange: (value: string) => void;
  onSelect: (value: string) => void;
  label?: string;
  placeholder?: string;
  /** repositories not to suggest (e.g. already linked) */
  exclude?: string[];
}) {
  const repos = useCachedRepositories();
  const options = useRepositoryOptions(repos).filter((o) => !exclude?.some((x) => x.toLowerCase() === o.value));
  return <CachedEntry value={value} onChange={onChange} onSelect={onSelect} options={options} label={label} placeholder={placeholder} search={searchGitHubRepos} />;
}
