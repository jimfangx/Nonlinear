import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { layoutLanes, indexPatch, type CommitNode } from "@nonlinear/core";
import { useApp } from "../lib/store";
import { githubApi, describeError } from "../lib/github";
import { gitlinksAt } from "../lib/timeline";
import { isDesktop, invoke } from "../lib/platform";
import { availableSources, gitDiff, gitGitlinks, gitLog, gitRefs, sourceLabel, type Source } from "../lib/sources";
import { FileDiff } from "../components/FileDiff";
import { Modal, timeAgo, Split } from "../components/ui";

const LANE_W = 14;
const ROW_H = 28;
const COLORS = ["#7c5cff", "#2bb673", "#f5a623", "#3aa0ff", "#ff6b6b", "#e056fd", "#00b5ad", "#a0a0b0"];

interface Ref {
  name: string;
  sha: string;
  kind: "branch" | "tag";
}

/**
 * GitKraken-style graph (§7): one independent graph per repository from the
 * GitHub API (web) or a local working tree / mirror (desktop). Loads history
 * incrementally; never materializes the full graph on first open.
 */
export function GitGraph() {
  const { owner, repo } = useParams();
  const views = useApp((s) => s.views);
  const nav = useNavigate();
  const repos = useMemo(() => [...new Set(Object.values(views).flatMap((v) => v.repos))].sort(), [views]);
  const [input, setInput] = useState(owner && repo ? `${owner}/${repo}` : repos[0] ?? "");
  const [localPath, setLocalPath] = useState("");
  const key = owner && repo ? `${owner}/${repo}`.toLowerCase() : null;
  return (
    <div className="col" style={{ height: "100%", gap: 0 }}>
      <div className="toolbar">
        <h1 className="toolbar-title">Git Graph</h1>
        <input className="input" list="graph-repos" value={input} onChange={(e) => setInput(e.target.value)} placeholder="owner/repo" onKeyDown={(e) => e.key === "Enter" && nav(`/graph/${input}`)} />
        <datalist id="graph-repos">
          {repos.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        <button className="btn sm" onClick={() => nav(`/graph/${input}`)}>
          Open (GitHub)
        </button>
      </div>
      {key ? <Graph key={key} repoKey={key} /> : <div className="empty">Choose a repository.</div>}
    </div>
  );
}

function Graph({ repoKey }: { repoKey: string }) {
  const [owner, name] = repoKey.split("/") as [string, string];
  const sources = useMemo(() => availableSources(repoKey), [repoKey]);
  const [src, setSrc] = useState<Source>(sources[0]!);
  const local = src.kind === "local" ? src.path : null;
  const [commits, setCommits] = useState<CommitNode[]>([]);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [selectedBranches, setSelectedBranches] = useState<string[]>([]);
  const [pages, setPages] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const prs = useApp((s) => s.prs);
  const pins = useApp((s) => s.pins);
  const releases = useApp((s) => s.releases);

  useEffect(() => {
    (async () => {
      setBusy("Loading refs…");
      try {
        if (src.kind !== "github") {
          const rs = await gitRefs(src);
          setRefs(rs.map((r) => ({ name: r.name, sha: r.sha, kind: r.kind === "tag" ? "tag" : "branch" })));
        } else {
          const c = await githubApi();
          const [info, br, tg] = await Promise.all([c.repo(owner, name), c.branches(owner, name), c.tags(owner, name)]);
          setRefs([...br.map((b) => ({ name: b.name, sha: b.commit.sha, kind: "branch" as const })), ...tg.slice(0, 40).map((t) => ({ name: t.name, sha: t.commit.sha, kind: "tag" as const }))]);
          setSelectedBranches([info.defaultBranch]);
        }
      } catch (e) {
        setErr(describeError(e));
      } finally {
        setBusy(null);
      }
    })();
  }, [repoKey, JSON.stringify(src)]);

  useEffect(() => {
    if (!selectedBranches.length && src.kind === "github") return;
    (async () => {
      setBusy("Loading history…");
      try {
        let all: CommitNode[] = [];
        if (src.kind !== "github") all = await gitLog(src, "--all", pages * 200);
        else {
          const c = await githubApi();
          for (const b of selectedBranches) all.push(...(await c.commits(owner, name, { sha: b, pages })));
        }
        const m = new Map(all.map((x) => [x.sha, x]));
        setCommits([...m.values()]);
      } catch (e) {
        setErr(describeError(e));
      } finally {
        setBusy(null);
      }
    })();
  }, [selectedBranches.join(","), pages, JSON.stringify(src)]);

  const { rows, maxLane } = useMemo(() => layoutLanes(commits), [commits]);
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
    } else useApp.getState().toast("info", "Not in loaded history. Load more or select its branch.");
  };
  const width = (maxLane + 1) * LANE_W + 8;
  const selCommit = sel ? commits.find((c) => c.sha === sel) : undefined;

  return (
    <>
      <div className="toolbar small">
        <span>Branches:</span>
        <select className="input" multiple={false} value="" onChange={(e) => e.target.value && setSelectedBranches([...new Set([...selectedBranches, e.target.value])])} aria-label="Add branch">
          <option value="">+ add branch</option>
          {refs.filter((r) => r.kind === "branch" && !selectedBranches.includes(r.name)).map((r) => (
            <option key={r.name}>{r.name}</option>
          ))}
        </select>
        {selectedBranches.map((b) => (
          <span key={b} className="chip">
            {b}
            <button className="btn ghost sm" style={{ height: 16, padding: 0 }} onClick={() => setSelectedBranches(selectedBranches.filter((x) => x !== b))}>
              ✕
            </button>
          </span>
        ))}
        <input className="input" placeholder="Jump to SHA / ref" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && jump(q)} />
        <span className="spacer" />
        <select className="input" aria-label="Data source" value={JSON.stringify(src)} onChange={(e) => setSrc(JSON.parse(e.target.value) as Source)}>
          {sources.map((x) => (
            <option key={JSON.stringify(x)} value={JSON.stringify(x)}>
              {sourceLabel(x)}
            </option>
          ))}
        </select>
        <span className="faint">
          {commits.length} commits loaded · {sourceLabel(src)}
        </span>
        <button className="btn sm" onClick={() => setPages((p) => p + 1)} disabled={!!busy}>
          Load more
        </button>
        {busy && <span className="faint">{busy}</span>}
      </div>
      {err && <div className="banner err">{err}</div>}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Split id="gitgraph" initial={0.64}>
          <div ref={parentRef} style={{ height: "100%", overflow: "auto" }}>
            <div style={{ height: virt.getTotalSize(), position: "relative" }}>
              {virt.getVirtualItems().map((vi) => {
                const r = rows[vi.index]!;
                const c = r.commit;
                const color = COLORS[r.lane % COLORS.length];
                return (
                  <div key={c.sha} className={`graph-row ${sel === c.sha ? "selected" : ""}`} style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)`, height: ROW_H }} onClick={() => setSel(c.sha)}>
                    <svg width={width} height={ROW_H} style={{ flex: "none" }} aria-hidden>
                      {r.passThrough.map((l) => (
                        <line key={`p${l}`} x1={l * LANE_W + 8} x2={l * LANE_W + 8} y1={0} y2={ROW_H} stroke={COLORS[l % COLORS.length]} strokeWidth={2} />
                      ))}
                      {vi.index > 0 && <line x1={r.lane * LANE_W + 8} x2={r.lane * LANE_W + 8} y1={0} y2={ROW_H / 2} stroke={color} strokeWidth={2} />}
                      {r.edges.map((e, i) => (
                        <path key={i} d={`M ${e.fromLane * LANE_W + 8} ${ROW_H / 2} C ${e.fromLane * LANE_W + 8} ${ROW_H}, ${e.toLane * LANE_W + 8} ${ROW_H / 2}, ${e.toLane * LANE_W + 8} ${ROW_H}`} stroke={COLORS[e.toLane % COLORS.length]} strokeWidth={2} fill="none" />
                      ))}
                      <circle cx={r.lane * LANE_W + 8} cy={ROW_H / 2} r={c.parents.length > 1 ? 3 : 5} fill={c.parents.length > 1 ? "var(--panel)" : color} stroke={color} strokeWidth={2} />
                    </svg>
                    <span className="row grow" style={{ minWidth: 0, gap: 4 }}>
                      {refsBySha.get(c.sha)?.map((x) => (
                        <span key={x.name} className={`ref ${x.kind === "tag" ? "tag" : ""}`}>
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
                    <span className="faint small" style={{ width: 110, flex: "none" }}>
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
          <div style={{ height: "100%", overflow: "auto" }}>{selCommit ? <CommitDetail repoKey={repoKey} c={selCommit} refs={refs} local={local} src={src} /> : <div className="empty">Select a commit</div>}</div>
        </Split>
      </div>
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
    void (src.kind === "github" ? gitlinksAt(repoKey, c.sha) : gitGitlinks(src, c.sha)).then(setLinks).catch(() => setLinks(new Map()));
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

function CommitDiff({ text }: { text: string }) {
  const ix = useMemo(() => indexPatch(text), [text]);
  const [i, setI] = useState(0);
  const f = ix.files[i];
  return (
    <div className="row" style={{ height: "60vh", alignItems: "stretch" }}>
      <div style={{ width: 220, overflow: "auto" }}>
        {ix.files.map((x, k) => (
          <div key={x.path} className={`tree-row ${k === i ? "active" : ""}`} onClick={() => setI(k)}>
            <span className="ellipsis">{x.path}</span>
          </div>
        ))}
      </div>
      <div className="grow" style={{ minWidth: 0 }}>{f && <FileDiff key={f.path} section={text.slice(f.start, f.end)} mode="unified" />}</div>
    </div>
  );
}
