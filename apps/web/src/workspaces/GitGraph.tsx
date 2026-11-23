import { RepoEntry } from "../components/RepoEntry";
import { RepositoryShortcuts, useCachedRepositories, repositoryFromInput } from "../components/RepositoryShortcuts";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { layoutLanes, type CommitNode } from "@nonlinear/core";
import { useApp } from "../lib/store";
import { githubApi, describeError } from "../lib/github";
import { gitlinksAt, remoteGitRefs, remoteGitLog, usesGitTransport } from "../lib/timeline";
import { isDesktop, invoke } from "../lib/platform";
import { availableSources, gitDiff, gitGitlinks, gitLog, gitRefs, sourceLabel, type Source } from "../lib/sources";
import { CommitDiff } from "../components/CommitDiff";
import { Modal, timeAgo, Split } from "../components/ui";

const LANE_W = 14;
const ROW_H = 28;
const COLORS = ["#7c5cff", "#2bb673", "#f5a623", "#3aa0ff", "#ff6b6b", "#e056fd", "#00b5ad", "#a0a0b0"];

interface Ref {
  name: string;
  sha: string;
  kind: "branch" | "tag";
}

const refKey = (ref: Ref) => `${ref.kind}:${ref.name}`;

/**
 * GitKraken-style graph (§7): one independent graph per repository from the
 * GitHub API (web) or a local working tree / mirror (desktop). Loads history
 * incrementally; never materializes the full graph on first open.
 */
export function GitGraph() {
  const { owner, repo } = useParams();
  const nav = useNavigate();
  const repositories = useCachedRepositories();
  const key = owner && repo ? `${owner}/${repo}`.toLowerCase() : null;
  const [input, setInput] = useState(key ?? "");
  const openRepo = (value: string) => {
    const repository = repositoryFromInput(value);
    if (repository) { setInput(repository); nav(`/graph/${repository}`); }
  };
  useEffect(() => { if (key) setInput(key); }, [key]);

  return (
    <div className="col" style={{ height: "100%", gap: 0 }}>
      <form className="toolbar graph-picker" onSubmit={(e) => { e.preventDefault(); openRepo(input); }}>
        <h1 className="toolbar-title">Git Graph</h1>
        <RepoEntry value={input} onChange={setInput} onSelect={openRepo} />
        <button type="submit" className="btn">Open</button>
        <RepositoryShortcuts current={key} repositories={repositories} onOpen={openRepo} />
      </form>
      {key ? <Graph key={key} repoKey={key} /> : <div className="empty">Choose a repository.</div>}
    </div>
  );
}

function Graph({ repoKey }: { repoKey: string }) {
  const [owner, name] = repoKey.split("/") as [string, string];
  const sources = useMemo(() => availableSources(repoKey), [repoKey]);
  const [src, setSrc] = useState<Source>(sources.find((source) => source.kind === "local") ?? sources[0]!);
  const remoteGit = usesGitTransport(src);
  const local = src.kind === "local" ? src.path : null;
  const [commits, setCommits] = useState<CommitNode[]>([]);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [selectedRefs, setSelectedRefs] = useState<Ref[]>([]);
  const [pages, setPages] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<{ commit: CommitNode; x: number; y: number } | null>(null);
  const [q, setQ] = useState("");
  const prs = useApp((s) => s.prs);
  const pins = useApp((s) => s.pins);
  const releases = useApp((s) => s.releases);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBusy("Loading refs…");
      try {
        let available: Ref[];
        let primary: string | undefined;
        if (src.kind !== "github") {
          const rs = await gitRefs(src);
          available = rs.map((r) => ({ name: r.name, sha: r.sha, kind: r.kind === "tag" ? "tag" : "branch" }));
          primary = (rs.find((ref) => ref.kind === "branch" && /^(main|master)$/.test(ref.name))
            ?? rs.find((ref) => ref.kind === "remote" && /\/(main|master)$/.test(ref.name))
            ?? rs.find((ref) => ref.kind === "branch"))?.name;
        } else if (remoteGit) {
          const { branch, branches, tags } = await remoteGitRefs(repoKey);
          available = [
            ...branches.map(([name, sha]) => ({ name, sha, kind: "branch" as const })),
            ...tags.map(([name, sha]) => ({ name, sha, kind: "tag" as const })),
          ];
          primary = branch ?? undefined;
        } else {
          const c = await githubApi();
          const [info, br, tg] = await Promise.all([c.repo(owner, name), c.branches(owner, name), c.tags(owner, name)]);
          available = [...br.map((b) => ({ name: b.name, sha: b.commit.sha, kind: "branch" as const })), ...tg.map((t) => ({ name: t.name, sha: t.commit.sha, kind: "tag" as const }))];
          primary = info.defaultBranch;
        }
        if (cancelled) return;
        const initial = available.find((ref) => ref.kind === "branch" && ref.name === primary)
          ?? (primary ? { kind: "branch" as const, name: primary, sha: "" } : null);
        setRefs(available);
        setSelectedRefs(initial ? [initial] : []);
      } catch (e) {
        if (!cancelled) setErr(describeError(e));
      } finally {
        if (!cancelled) setBusy(null);
      }
    })();
    return () => { cancelled = true; };
  }, [repoKey, JSON.stringify(src), remoteGit]);

  useEffect(() => {
    if (!selectedRefs.length && src.kind === "github") {
      setCommits([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setBusy("Loading history…");
      setErr(null);
      try {
        let all: CommitNode[] = [];
        if (src.kind !== "github") {
          all = await gitLog(src, "--all", pages * 200);
          for (const ref of selectedRefs) {
            if (cancelled) return;
            if (ref.sha && !all.some((commit) => commit.sha === ref.sha)) all.push(...await gitLog(src, ref.sha, pages * 200));
          }
        } else if (remoteGit) {
          for (const ref of selectedRefs) {
            if (cancelled) return;
            all.push(...await remoteGitLog(repoKey, `refs/${ref.kind === "tag" ? "tags" : "heads"}/${ref.name}`, pages * 200));
          }
        } else {
          const c = await githubApi();
          for (const ref of selectedRefs) {
            if (cancelled) return;
            all.push(...await c.commits(owner, name, { sha: ref.sha || ref.name, pages }));
          }
        }
        const m = new Map(all.map((x) => [x.sha, x]));
        if (!cancelled) setCommits([...m.values()]);
      } catch (e) {
        if (!cancelled) setErr(describeError(e));
      } finally {
        if (!cancelled) setBusy(null);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedRefs, pages, src, remoteGit]);

  const { rows, maxLane, dividers } = useMemo(() => layoutLanes(commits, selectedRefs.map((ref) => ref.sha || undefined)), [commits, selectedRefs]);
  const refsBySha = useMemo(() => {
    const m = new Map<string, Ref[]>();
    for (const r of refs) (m.get(r.sha) ?? m.set(r.sha, []).get(r.sha)!).push(r);
    return m;
  }, [refs]);
  const prsBySha = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const p of Object.values(prs)) if (`${p.owner}/${p.repo}`.toLowerCase() === repoKey) (m.get(p.headSha) ?? m.set(p.headSha, []).get(p.headSha)!).push(`#${p.number}`);
    return m;
  }, [prs, repoKey]);
  const pinsBySha = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const p of Object.values(pins)) if (p.childRepo === repoKey) (m.get(p.sha) ?? m.set(p.sha, []).get(p.sha)!).push(releases[p.releaseId]?.name ?? p.releaseId);
    return m;
  }, [pins, releases, repoKey]);

  const parentRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => ROW_H, overscan: 30 });
  const index = useMemo(() => new Map(rows.map((r, i) => [r.commit.sha, i])), [rows]);
  const jump = (needle: string) => {
    const n = needle.trim().toLowerCase();
    const ref = refs.find((r) => r.name.toLowerCase() === n);
    const sha = ref?.sha ?? rows.find((r) => r.commit.sha.startsWith(n))?.commit.sha;
    if (sha && index.has(sha)) {
      setSel(sha);
      virt.scrollToIndex(index.get(sha)!, { align: "center" });
    } else useApp.getState().toast("info", "Not in loaded history. Load more or select its branch or tag.");
  };
  const width = (maxLane + 1) * LANE_W + 8;
  const virtualRows = virt.getVirtualItems();
  const selCommit = sel ? commits.find((c) => c.sha === sel) : undefined;
  useEffect(() => {
    if (!selCommit) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector(".overlay:not([inert]), #workspace-content[inert]")) return;
      event.preventDefault();
      setSel(null);
      setHover(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selCommit]);

  const unselected = refs.filter((ref) => !selectedRefs.some((selected) => refKey(selected) === refKey(ref)));

  return (
    <>
      <div className="toolbar small">
        <select className="input" value="" onChange={(e) => {
          const ref = unselected.find((item) => refKey(item) === e.target.value);
          if (ref) setSelectedRefs([...selectedRefs, ref]);
        }} aria-label="Add branch or tag">
          <option value="">+ Add branch or tag</option>
          {(["branch", "tag"] as const).map((kind) => (
            <optgroup key={kind} label={kind === "branch" ? "Branches" : "Tags"}>
              {unselected.filter((ref) => ref.kind === kind).map((ref) => (
                <option key={refKey(ref)} value={refKey(ref)}>{ref.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {selectedRefs.map((ref) => (
          <span key={refKey(ref)} className={`chip ${ref.kind === "tag" ? "ref tag" : ""}`}>
            {ref.name}
            <button className="btn ghost sm" style={{ height: 16, padding: 0 }} aria-label={`Remove ${ref.kind} ${ref.name}`} onClick={() => setSelectedRefs(selectedRefs.filter((item) => item !== ref))}>
              ✕
            </button>
          </span>
        ))}
        <input className="input" data-workspace-search placeholder="Jump to SHA / ref" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && jump(q)} />
        <span className="spacer" />
        <select className="input" aria-label="Data source" value={JSON.stringify(src)} onChange={(e) => {
          setSrc(JSON.parse(e.target.value) as Source);
          setRefs([]);
          setSelectedRefs([]);
          setSel(null);
          setHover(null);
        }}>
          {sources.map((x) => (
            <option key={JSON.stringify(x)} value={JSON.stringify(x)}>
              {x.kind === "github" ? "GitHub" : sourceLabel(x)}
            </option>
          ))}
        </select>
        <span className="faint">
          {commits.length} commits loaded · {src.kind === "github" ? "GitHub" : sourceLabel(src)}
        </span>
        <button className="btn sm" onClick={() => setPages((p) => p + 1)} disabled={!!busy || (remoteGit && pages >= 25)}>
          Load more
        </button>
        {busy && <span className="faint">{busy}</span>}
      </div>
      {err && <div className="banner err">{err}</div>}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Split id="gitgraph" className="graph-split workspace-split" initial={0.64} showSecond={!!selCommit}>
          <div ref={parentRef} style={{ height: "100%", overflow: "auto" }} onScroll={() => { if (hover) setHover(null); }}>
            <div style={{ height: virt.getTotalSize(), position: "relative" }}>
              {virtualRows.map((vi) => {
                const r = rows[vi.index]!;
                const c = r.commit;
                const color = COLORS[r.lane % COLORS.length];
                return (
                  <div key={c.sha} className={`graph-row ${sel === c.sha ? "selected" : ""}`} style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)`, height: ROW_H }} onClick={() => setSel(c.sha)}>
                    <svg width={width} height={ROW_H} className="graph-dot" aria-hidden="true">
                      {dividers.map((lane) => (
                        <line key={lane} className="graph-branch-divider" x1={lane * LANE_W + 8} x2={lane * LANE_W + 8}
                          y1={0} y2={ROW_H} stroke="var(--text-3)" strokeOpacity={0.65} strokeLinecap="round" strokeDasharray="1 3" pointerEvents="none" />
                      ))}
                      {r.passThrough.map((lane) => (
                        <line key={lane} x1={lane * LANE_W + 8} x2={lane * LANE_W + 8} y1={0} y2={ROW_H} stroke={COLORS[lane % COLORS.length]} strokeWidth={2} />
                      ))}
                      {(r.hasIncoming ?? vi.index > 0) && <line x1={r.lane * LANE_W + 8} x2={r.lane * LANE_W + 8} y1={0} y2={ROW_H / 2} stroke={color} strokeWidth={2} />}
                      {r.edges.map((edge, i) => (
                        <path key={i} d={`M ${edge.fromLane * LANE_W + 8} ${ROW_H / 2} C ${edge.fromLane * LANE_W + 8} ${ROW_H}, ${edge.toLane * LANE_W + 8} ${ROW_H / 2}, ${edge.toLane * LANE_W + 8} ${ROW_H}`} stroke={COLORS[edge.toLane % COLORS.length]} strokeWidth={2} fill="none" />
                      ))}
                      <circle cx={r.lane * LANE_W + 8} cy={ROW_H / 2} r={c.parents.length > 1 ? 4 : 5}
                        fill={c.parents.length > 1 ? "var(--panel)" : color} stroke={color} strokeWidth="2"
                        onMouseEnter={(e) => {
                          const target = e.currentTarget.getBoundingClientRect();
                          setHover({ commit: c, x: target.right, y: target.bottom });
                        }} onMouseLeave={() => setHover(null)} />
                    </svg>
                    <span className="row grow" style={{ minWidth: 0, gap: 4 }}>
                      {refsBySha.get(c.sha)?.map((x) => (
                        <span key={refKey(x)} className={`ref ${x.kind === "tag" ? "tag" : ""}`}>
                          {x.kind === "tag" ? "🏷 " : ""}
                          {x.name}
                        </span>
                      ))}
                      {prsBySha.get(c.sha)?.map((x) => (
                        <span key={x} className="ref">
                          PR {x}
                        </span>
                      ))}
                      {pinsBySha.get(c.sha)?.map((x) => (
                        <span key={x} className="ref pin">
                          📍 {x}
                        </span>
                      ))}
                      <span className="ellipsis grow">{c.message.split("\n")[0]}</span>
                    </span>
                    <span className="faint small ellipsis graph-author" title={c.author}>
                      {c.author}
                    </span>
                    <span className="mono faint small" style={{ width: 70, flex: "none" }}>
                      {c.sha.slice(0, 7)}
                    </span>
                    <span className="faint small" style={{ width: 70, flex: "none" }}>
                      {timeAgo(c.committedAt)}
                    </span>
                  </div>
                );
              })}
            </div>
            {commits.length > 0 && rows.some((r) => r.commit.parents.some((p) => !index.has(p))) && <div className="faint small" style={{ padding: 8 }}>History truncated at loaded depth — ancestry beyond this point is unknown.</div>}
          </div>
          {selCommit && <div style={{ height: "100%", overflow: "auto" }}>
            <div className="inbox-detail-header"><span>Commit details</span><button className="btn ghost sm" aria-label="Close commit details" onClick={() => setSel(null)}>✕</button></div>
            <CommitDetail repoKey={repoKey} c={selCommit} refs={refs} local={local} src={src} />
          </div>}
        </Split>
      </div>
      {hover && <div className="panel pad small graph-tooltip" role="tooltip" style={{ left: Math.min(hover.x + 8, window.innerWidth - 326), top: Math.min(hover.y + 8, window.innerHeight - 110) }}>
        <div className="mono">{hover.commit.sha.slice(0, 12)} {refsBySha.get(hover.commit.sha)?.map((ref) => ref.name).join(" · ")}</div>
        <b>{hover.commit.message.split("\n")[0]}</b>
        <div className="faint">{hover.commit.author} · {new Date(hover.commit.committedAt).toLocaleString()}</div>
      </div>}

    </>
  );
}

function CommitDetail({ repoKey, c, refs, local, src }: { repoKey: string; c: CommitNode; refs: Ref[]; local: string | null; src: Source }) {
  const [owner, name] = repoKey.split("/") as [string, string];
  const [cmpRef, setCmpRef] = useState("");
  const [cmp, setCmp] = useState<{ status: string; ahead_by: number; behind_by: number; merge_base_sha: string | null } | null>(null);
  const [links, setLinks] = useState<Map<string, string> | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const timelines = useApp((s) => s.timelines);
  const toast = useApp((s) => s.toast);
  const nav = useNavigate();
  useEffect(() => {
    setCmp(null);
    setLinks(null);
    void (src.kind === "github" ? gitlinksAt(repoKey, c.sha, src) : gitGitlinks(src, c.sha)).then(setLinks).catch(() => setLinks(new Map()));
  }, [c.sha, repoKey]);
  const tl = Object.values(timelines).find((t) => t.root === repoKey);
  return (
    <div className="pad col">
      <div className="mono small">{c.sha}</div>
      <div style={{ whiteSpace: "pre-wrap" }}>{c.message}</div>
      <div className="faint small">
        {c.author} · {new Date(c.committedAt).toLocaleString()} · parents {c.parents.map((p) => p.slice(0, 7)).join(", ")}
      </div>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button
          className="btn sm"
          onClick={async () => {
            try {
              const p = c.parents[0];
              if (!p) return toast("info", "Root commit");
              setDiff(src.kind !== "github" ? await gitDiff(src, p, c.sha) : await (await githubApi()).compareDiff(owner, name, p, c.sha));
            } catch (e) {
              toast("error", describeError(e));
            }
          }}
        >
          View diff
        </button>
        <a className="btn sm" href={`https://github.com/${owner}/${name}/commit/${c.sha}`} target="_blank" rel="noreferrer">
          GitHub ↗
        </a>
        {tl && (
          <button className="btn sm" onClick={() => { useApp.getState().patch("timelines", tl.id, { rootSha: c.sha }); nav(`/timeline/${tl.id}`); }}>
            Open timeline at this commit
          </button>
        )}
        <button
          className="btn sm"
          disabled={!isDesktop() || !local}
          title={!isDesktop() ? "Requires the desktop app with an explicit working tree" : "Detached checkout (non-destructive; asks first)"}
          onClick={async () => {
            if (!local || !confirm(`Checkout ${c.sha.slice(0, 8)} (detached) in ${local}? Uncommitted changes block this.`)) return;
            try {
              await invoke("git_checkout_detached", { repoPath: local, rev: c.sha });
              toast("success", "Checked out (detached)");
            } catch (e) {
              toast("error", String(e));
            }
          }}
        >
          Checkout (local)
        </button>
      </div>
      <div className="panel pad col small">
        <h3 className="h3">Compare / merge preview</h3>
        <div className="row">
          <select className="input grow" value={cmpRef} onChange={(e) => setCmpRef(e.target.value)} aria-label="Compare with ref">
            <option value="">Compare with…</option>
            {refs.map((r) => (
              <option key={r.kind + r.name} value={r.name}>
                {r.kind}: {r.name}
              </option>
            ))}
          </select>
          <button className="btn sm" disabled={!cmpRef} onClick={() => void githubApi().then((g) => g.compareStatus(owner, name, cmpRef, c.sha)).then(setCmp).catch((e) => toast("error", describeError(e)))}>
            Compare
          </button>
        </div>
        {cmp && (
          <div>
            This commit is <b>{cmp.status}</b> relative to {cmpRef}: {cmp.ahead_by} ahead, {cmp.behind_by} behind. Merge base <span className="mono">{cmp.merge_base_sha?.slice(0, 8)}</span>.
            <div className="faint">
              {cmp.status === "behind" || cmp.status === "identical" ? "Already contained; merge/cherry-pick would be a no-op." : cmp.status === "ahead" ? "Fast-forward merge possible." : "Diverged: merge or rebase required; cherry-pick applies only this commit's diff."}
            </div>
          </div>
        )}
      </div>
      {links && links.size > 0 && (
        <div className="panel pad small">
          <h3 className="h3">Submodule pins at this commit</h3>
          {[...links].map(([p, s]) => (
            <div key={p} className="row">
              <span className="mono grow">{p}</span>
              <span className="mono faint">{s.slice(0, 10)}</span>
            </div>
          ))}
        </div>
      )}
      {diff !== null && (
        <Modal title={`Diff ${c.sha.slice(0, 8)}`} onClose={() => setDiff(null)} wide>
          <CommitDiff text={diff} />
        </Modal>
      )}
    </div>
  );
}
