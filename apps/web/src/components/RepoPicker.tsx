import { useMemo, useState } from "react";
import { parseRepoKey, type RepoInfo } from "@nonlinear/core";
import { githubApi, describeError } from "../lib/github";
import { useApp, useSettings } from "../lib/store";

/**
 * Searchable, paginated repository picker grouped by owner and permission (§2.1).
 * Sources: your repos (if signed in), any org/user's public repos, GitHub
 * search, or a direct `owner/repo`.
 */
export function RepoPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const settings = useSettings();
  const [results, setResults] = useState<RepoInfo[]>([]);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cachedRepos = useApp((s) => s.repos);

  const run = async (fn: () => Promise<RepoInfo[]>) => {
    setBusy(true);
    setErr(null);
    try {
      const rs = await fn();
      setResults((prev) => dedupe([...rs, ...prev]));
      useApp.getState().putMany("repos", rs.map((r) => [r.key, r]));
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const all = useMemo(() => dedupe([...results, ...value.map((k) => cachedRepos[k]).filter((x): x is RepoInfo => !!x)]), [results, value, cachedRepos]);
  const groups = useMemo(() => {
    const f = filter.toLowerCase();
    const m = new Map<string, RepoInfo[]>();
    for (const r of all) {
      if (f && !r.key.includes(f) && !(r.description ?? "").toLowerCase().includes(f)) continue;
      const g = `${r.owner}`;
      (m.get(g) ?? m.set(g, []).get(g)!).push(r);
    }
    return [...m].sort(([a], [b]) => a.localeCompare(b));
  }, [all, filter]);

  const toggle = (k: string) => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k]);

  return (
    <div className="col">
      <div className="row">
        <input
          className="input grow"
          placeholder="owner/repo, org name, or search terms"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            const direct = parseRepoKey(q);
            if (direct) void run(async () => [await (await githubApi()).repo(direct.owner, direct.repo)]);
            else void run(async () => (await githubApi()).searchRepos(q));
          }}
        />
        <button className="btn" disabled={busy || !q} onClick={() => void run(async () => (await githubApi()).listRepos("org", q.trim()).catch(async () => (await githubApi()).listRepos("user", q.trim())))}>
          List owner
        </button>
        <button className="btn" disabled={busy || !q} onClick={() => void run(async () => (await githubApi()).searchRepos(q))}>
          Search
        </button>
        <button className="btn" disabled={busy || settings.authMode === "anonymous"} title={settings.authMode === "anonymous" ? "Sign in to list your repositories" : ""} onClick={() => void run(async () => (await githubApi()).myRepos())}>
          My repos
        </button>
      </div>
      {err && <div className="banner err">{err}</div>}
      {busy && <div className="faint small">Loading…</div>}
      <div className="row small">
        <span className="muted">{value.length} selected</span>
        <span className="spacer" />
        <input className="input" style={{ width: 200 }} placeholder="Filter results" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div style={{ maxHeight: 340, overflow: "auto", border: "1px solid var(--border)", borderRadius: 6 }}>
        {groups.map(([owner, rs]) => (
          <div key={owner}>
            <h3 className="h3" style={{ padding: "8px 10px 2px" }}>{owner}</h3>
            {rs.sort((a, b) => permRank(b.permission) - permRank(a.permission) || a.name.localeCompare(b.name)).map((r) => (
              <label key={r.key} className="row" style={{ padding: "4px 10px", cursor: "pointer" }}>
                <input type="checkbox" checked={value.includes(r.key)} onChange={() => toggle(r.key)} />
                <span className="grow ellipsis">
                  <b>{r.name}</b> <span className="faint">{r.description}</span>
                </span>
                {r.archived && <span className="chip">archived</span>}
                {r.private && <span className="chip warn">private</span>}
                <span className={`chip ${r.permission === "admin" || r.permission === "maintain" || r.permission === "write" ? "ok" : ""}`}>{r.permission}</span>
              </label>
            ))}
          </div>
        ))}
        {!groups.length && <div className="empty small">Search for repositories, list an organization (e.g. <code>ucb-bar</code>), or enter <code>owner/repo</code> and press Enter.</div>}
      </div>
      <div className="faint small">
        Read-only public repositories are fine to track. Write permission is tracked separately (read / triage / write / maintain / admin); being a collaborator does not imply write access.
      </div>
    </div>
  );
}

function permRank(p: string): number {
  return ["none", "read", "triage", "write", "maintain", "admin"].indexOf(p);
}

function dedupe(rs: RepoInfo[]): RepoInfo[] {
  const m = new Map<string, RepoInfo>();
  for (const r of rs) if (!m.has(r.key)) m.set(r.key, r);
  return [...m.values()];
}
