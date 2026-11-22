import { useShallow } from "zustand/react/shallow";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  exportManifest,
  findPinConflicts,
  gitlinkPatch,
  manifestToText,
  newId,
  planApply,
  RELEASE_COLORS,
  type GitlinkChange,
  type Release,
} from "@nonlinear/core";
import { useApp } from "../lib/store";
import { githubApi, describeError, freshCapabilities } from "../lib/github";
import { gitlinksAt } from "../lib/timeline";
import { Modal, download, timeAgo } from "../components/ui";

export function Releases() {
  const { id } = useParams();
  const releases = useApp((s) => s.releases);
  const nav = useNavigate();
  const [creating, setCreating] = useState(false);
  const rel = id ? releases[id] : undefined;
  return (
    <div className="page">
      <div className="row">
        <h1 className="h1 grow">Releases</h1>
        <button className="btn primary" onClick={() => setCreating(true)}>
          + New release
        </button>
      </div>
      <p className="muted small">A release is a named set of target revisions and qualification criteria. No date is required. Editing a release never modifies GitHub or a working tree.</p>
      <div className="row" style={{ alignItems: "flex-start", gap: 16 }}>
        <div className="panel" style={{ width: 260, flex: "none" }}>
          {Object.values(releases).sort((a, b) => b.createdAt - a.createdAt).map((r) => (
            <div key={r.id} className={`list-row ${r.id === id ? "selected" : ""}`} onClick={() => nav(`/releases/${r.id}`)}>
              <span className="dot" style={{ background: r.color }} />
              <span className="grow ellipsis">{r.name}</span>
              <span className="chip">{r.state}</span>
            </div>
          ))}
          {!Object.keys(releases).length && <div className="empty small">No releases</div>}
        </div>
        <div className="grow">{rel ? <ReleaseDetail rel={rel} /> : <div className="empty">Select a release</div>}</div>
      </div>
      {creating && <CreateRelease onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateRelease({ onClose }: { onClose: () => void }) {
  const n = Object.keys(useApp.getState().releases).length;
  const [name, setName] = useState("Chipyard vNext");
  const [root, setRoot] = useState("ucb-bar/chipyard");
  const [color, setColor] = useState(RELEASE_COLORS[n % RELEASE_COLORS.length]!);
  const nav = useNavigate();
  return (
    <Modal
      title="New release"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!name.trim()}
          onClick={() => {
            const r: Release = { id: newId("rel"), name: name.trim(), color, state: "draft", targetDate: null, roots: root ? [{ root: root.toLowerCase(), sha: null, baseRef: "main" }] : [], validation: [], createdAt: Date.now(), updatedAt: Date.now(), revision: 1 };
            useApp.getState().put("releases", r.id, r);
            onClose();
            nav(`/releases/${r.id}`);
          }}
        >
          Create
        </button>
      }
    >
      <div className="col">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
        <input className="input" value={root} onChange={(e) => setRoot(e.target.value)} placeholder="Root repository" aria-label="Root repository" />
        <div className="row">
          {RELEASE_COLORS.map((c) => (
            <button key={c} className="btn sm" aria-label={`Color ${c}`} style={{ background: c, width: 24, outline: c === color ? "2px solid var(--text)" : undefined }} onClick={() => setColor(c)} />
          ))}
        </div>
      </div>
    </Modal>
  );
}

function ReleaseDetail({ rel }: { rel: Release }) {
  const allPins = useApp((s) => s.pins);
  const patch = useApp((s) => s.patch);
  const remove = useApp((s) => s.remove);
  const cards = useApp((s) => s.cards);
  const toast = useApp((s) => s.toast);
  const pins = useMemo(() => Object.values(allPins).filter((p) => p.releaseId === rel.id), [allPins, rel.id]);
  const conflicts = useMemo(() => findPinConflicts(Object.values(allPins).filter((p) => useApp.getState().releases[p.releaseId]?.state !== "archived")), [allPins]);
  const [criterion, setCriterion] = useState("");
  const [applying, setApplying] = useState(false);
  const [cmpTag, setCmpTag] = useState("");
  const [cmp, setCmp] = useState<{ path: string; pin: string; tag: string | null }[] | null>(null);
  const bump = (p: Partial<Release>) => patch("releases", rel.id, { ...p, updatedAt: Date.now(), revision: rel.revision + 1 });
  const feat = Object.values(cards).filter((c) => c.releases.includes(rel.id) && !c.deleted);

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="panel pad col">
        <div className="row">
          <span className="dot" style={{ background: rel.color, width: 14, height: 14 }} />
          <input className="input grow" value={rel.name} onChange={(e) => bump({ name: e.target.value })} aria-label="Release name" style={{ fontWeight: 600 }} />
          <select className="input" value={rel.state} onChange={(e) => bump({ state: e.target.value as Release["state"] })} aria-label="State">
            <option value="draft">Draft</option>
            <option value="frozen">Frozen</option>
            <option value="applied">Applied</option>
            <option value="archived">Archived</option>
          </select>
          <label className="row small">
            Optional date <input type="date" className="input" value={rel.targetDate ?? ""} onChange={(e) => bump({ targetDate: e.target.value || null })} />
          </label>
        </div>
        <div className="small">
          Roots:{" "}
          {rel.roots.map((r) => (
            <span key={r.root} className="chip mono" style={{ marginRight: 4 }}>
              {r.root}@{r.baseRef}
            </span>
          ))}
        </div>
        <div>
          <h3 className="h3">Qualification criteria</h3>
          {rel.validation.map((v, i) => (
            <div key={i} className="row small">
              • {v}
              <button className="btn ghost sm" onClick={() => bump({ validation: rel.validation.filter((_, j) => j !== i) })}>
                ✕
              </button>
            </div>
          ))}
          <div className="row">
            <input className="input grow" value={criterion} onChange={(e) => setCriterion(e.target.value)} placeholder="e.g. FireSim smoke tests pass on all pins" onKeyDown={(e) => { if (e.key === "Enter" && criterion.trim()) { bump({ validation: [...rel.validation, criterion.trim()] }); setCriterion(""); } }} />
          </div>
        </div>
      </div>

      {conflicts.filter((c) => c.releases.includes(rel.id)).map((c, i) => (
        <div key={i} className="banner warn">
          ⚠ {c.parent}:{c.path} has different targets across releases ({c.releases.map((r) => useApp.getState().releases[r]?.name ?? r).join(", ")}). A parent commit can pin only one revision; resolve explicitly before applying both.
        </div>
      ))}

      <div className="panel">
        <div className="toolbar">
          <b>Pins ({pins.length})</b>
          <span className="spacer" />
          <input className="input" placeholder="Compare to tag/ref" value={cmpTag} onChange={(e) => setCmpTag(e.target.value)} style={{ width: 160 }} />
          <button
            className="btn sm"
            disabled={!cmpTag || !rel.roots[0]}
            onClick={async () => {
              try {
                const links = await gitlinksAt(rel.roots[0]!.root, cmpTag);
                setCmp(pins.filter((p) => p.parentRepo === rel.roots[0]!.root).map((p) => ({ path: p.pathChain.join("/"), pin: p.sha, tag: links.get(p.pathChain[p.pathChain.length - 1]!) ?? null })));
              } catch (e) {
                toast("error", describeError(e));
              }
            }}
          >
            Compare
          </button>
          <button className="btn sm" onClick={() => download(`${rel.name}.manifest.json`, JSON.stringify(exportManifest(rel, pins), null, 2), "application/json")}>
            Export JSON
          </button>
          <button className="btn sm" onClick={() => download(`${rel.name}.lock`, manifestToText(exportManifest(rel, pins)))}>
            Export lock
          </button>
          <button className="btn sm primary" disabled={!pins.length} onClick={() => setApplying(true)}>
            Apply planned pins…
          </button>
        </div>
        <table className="grid">
          <thead>
            <tr>
              <th>Parent</th>
              <th>Path</th>
              <th>Child</th>
              <th>Pin</th>
              {cmp && <th>At {cmpTag}</th>}
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {pins.sort((a, b) => a.pathChain.join("/").localeCompare(b.pathChain.join("/"))).map((p) => {
              const c = cmp?.find((x) => x.path === p.pathChain.join("/"));
              return (
                <tr key={`${p.parentRepo}|${p.pathChain.join("/")}`}>
                  <td className="mono small">{p.parentRepo}</td>
                  <td className="mono small">{p.pathChain.join(" / ")}</td>
                  <td className="small">{p.childRepo ?? "—"}</td>
                  <td className="mono small" title={p.note}>{p.sha.slice(0, 10)}</td>
                  {cmp && <td className="mono small">{c?.tag ? (c.tag === p.sha ? "= same" : c.tag.slice(0, 10)) : "—"}</td>}
                  <td className="faint small">{timeAgo(p.updatedAt)}</td>
                  <td>
                    {rel.state === "draft" && (
                      <button className="btn ghost sm" onClick={() => remove("pins", `${p.releaseId}|${p.parentRepo}|${p.pathChain.join("/")}`)}>
                        ✕
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!pins.length && <div className="empty small">No pins yet. Open a timeline and drag this release's handles to set desired commits.</div>}
      </div>

      <div className="panel pad">
        <h3 className="h3">Features targeting this release</h3>
        {feat.map((c) => (
          <div key={c.id} className="small">
            ▦ {c.title} {c.prs.length ? <span className="faint">({c.prs.length} PRs)</span> : null}
          </div>
        ))}
        {!feat.length && <div className="faint small">No cards are tagged with this release.</div>}
      </div>
      {applying && <ApplyModal rel={rel} onClose={() => setApplying(false)} />}
    </div>
  );
}

/**
 * Apply planned pins (§3.2): gitlink old → new per parent, checks, then a
 * patch or (with explicit confirmation + permission) a branch + PR.
 */
function ApplyModal({ rel, onClose }: { rel: Release; onClose: () => void }) {
  const pins = useApp(useShallow((s) => Object.values(s.pins).filter((p) => p.releaseId === rel.id)));
  const toast = useApp((s) => s.toast);
  const [plan, setPlan] = useState<{ changes: GitlinkChange[]; unchanged: number; parents: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [branch, setBranch] = useState(`nonlinear/${rel.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
  const [confirmPR, setConfirmPR] = useState<string | null>(null);

  const build = async () => {
    setBusy("Reading current gitlinks…");
    try {
      const parents = [...new Set(pins.map((p) => p.parentRepo))];
      const current = (
        await Promise.all(
          parents.map(async (parent) => {
            const root = rel.roots.find((r) => r.root === parent);
            const [o, n] = parent.split("/") as [string, string];
            const ref = root?.baseRef ?? (await (await githubApi()).repo(o, n)).defaultBranch;
            const links = await gitlinksAt(parent, ref);
            return [...links].map(([path, sha]) => ({ parentRepo: parent, path, sha }));
          }),
        )
      ).flat();
      const p = planApply(pins, current);
      setBusy("Verifying child commits…");
      const c = await githubApi();
      for (const ch of p.changes) {
        if (!ch.childRepo) continue;
        const [o, n] = ch.childRepo.split("/") as [string, string];
        try {
          await c.commit(o, n, ch.newSha);
          ch.checks.fetchable = true;
          const info = await c.repo(o, n);
          const st = await c.compareStatus(o, n, ch.newSha, info.defaultBranch);
          ch.checks.ancestorOfTarget = st.status === "ahead" || st.status === "identical";
          if (!ch.checks.ancestorOfTarget) ch.checks.note = `Not on ${info.defaultBranch} (${st.status}); may be an unmerged PR head.`;
        } catch (e) {
          ch.checks.fetchable = false;
          ch.checks.note = describeError(e);
        }
      }
      setPlan({ ...p });
    } catch (e) {
      toast("error", describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const createPR = async (parent: string) => {
    const changes = plan!.changes.filter((c) => c.parentRepo === parent && c.oldSha);
    setBusy(`Checking permissions on ${parent}…`);
    try {
      const { caps } = await freshCapabilities(parent);
      if (!caps.has("can-push")) throw new Error(`You don't have push permission on ${parent}. Download the patch instead.`);
      const [o, n] = parent.split("/") as [string, string];
      const c = await githubApi();
      const root = rel.roots.find((r) => r.root === parent);
      const baseRef = root?.baseRef ?? (await c.repo(o, n)).defaultBranch;
      setBusy("Creating tree/commit…");
      const baseCommit = await c.request<{ sha: string; commit: { tree: { sha: string } } }>("GET", `/repos/${o}/${n}/commits/${encodeURIComponent(baseRef)}`);
      const tree = await c.request<{ sha: string }>("POST", `/repos/${o}/${n}/git/trees`, {
        base_tree: baseCommit.commit.tree.sha,
        tree: changes.map((ch) => ({ path: ch.path, mode: "160000", type: "commit", sha: ch.newSha })),
      });
      const commit = await c.request<{ sha: string }>("POST", `/repos/${o}/${n}/git/commits`, {
        message: `Bump submodules for ${rel.name}\n\n${changes.map((ch) => `${ch.path}: ${ch.oldSha?.slice(0, 8)} -> ${ch.newSha.slice(0, 8)}`).join("\n")}`,
        tree: tree.sha,
        parents: [baseCommit.sha],
      });
      await c.request("POST", `/repos/${o}/${n}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
      const pr = await c.request<{ html_url: string }>("POST", `/repos/${o}/${n}/pulls`, {
        title: `[${rel.name}] Bump submodule pins`,
        head: branch,
        base: baseRef,
        body: `Generated by Nonlinear from release manifest **${rel.name}**.\n\n| path | old | new |\n|---|---|---|\n${changes.map((ch) => `| \`${ch.path}\` | \`${ch.oldSha?.slice(0, 10)}\` | \`${ch.newSha.slice(0, 10)}\` |`).join("\n")}\n\nCI must pass before merge.`,
        draft: true,
      });
      toast("success", `Draft PR opened: ${pr.html_url}`);
      window.open(pr.html_url, "_blank", "noopener");
    } catch (e) {
      toast("error", describeError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title={`Apply planned pins — ${rel.name}`} onClose={onClose} wide>
      {!plan && (
        <div className="col">
          <p className="small muted">Computes gitlink old → new against each parent's baseline branch, checks the child commits are fetchable and on their default branch, and lets you export a patch or open a draft PR. Nothing is pushed automatically.</p>
          <button className="btn primary" disabled={!!busy} onClick={() => void build()}>
            {busy ?? "Compute preview"}
          </button>
        </div>
      )}
      {plan && (
        <div className="col">
          <div className="small">
            {plan.changes.length} gitlink changes across {plan.parents.length} parent(s); {plan.unchanged} pins already match.
          </div>
          {plan.parents.map((parent) => {
            const chs = plan.changes.filter((c) => c.parentRepo === parent);
            return (
              <div key={parent} className="panel pad">
                <div className="row">
                  <b className="grow">{parent}</b>
                  <button className="btn sm" onClick={() => download(`${parent.replace("/", "_")}-gitlinks.patch`, gitlinkPatch(chs))}>
                    Download patch
                  </button>
                  <button className="btn sm primary" disabled={!!busy || chs.some((c) => c.checks.fetchable === false)} onClick={() => setConfirmPR(parent)}>
                    Open draft PR…
                  </button>
                </div>
                <table className="grid small">
                  <tbody>
                    {chs.map((c) => (
                      <tr key={c.path}>
                        <td className="mono">{c.path}</td>
                        <td className="mono">
                          {c.oldSha?.slice(0, 10) ?? "(new)"} → {c.newSha.slice(0, 10)}
                        </td>
                        <td>
                          {c.checks.fetchable === true ? <span className="chip ok">fetchable</span> : c.checks.fetchable === false ? <span className="chip err">not fetchable</span> : <span className="chip">?</span>}{" "}
                          {c.checks.ancestorOfTarget === true ? <span className="chip ok">on default branch</span> : c.checks.ancestorOfTarget === false ? <span className="chip warn">off-branch</span> : null}
                          {c.checks.note && <div className="faint">{c.checks.note}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
          <label className="row small">
            Branch name <input className="input grow mono" value={branch} onChange={(e) => setBranch(e.target.value)} />
          </label>
          {busy && <div className="faint small">{busy}</div>}
        </div>
      )}
      {confirmPR && (
        <Modal
          title="Confirm GitHub write"
          onClose={() => setConfirmPR(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmPR(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  const p = confirmPR;
                  setConfirmPR(null);
                  void createPR(p);
                }}
              >
                Create branch + draft PR
              </button>
            </>
          }
        >
          This will create branch <code>{branch}</code> in <b>{confirmPR}</b> with a single commit updating {plan!.changes.filter((c) => c.parentRepo === confirmPR).length} gitlinks, and open a <b>draft</b> PR. Requires push permission (checked again now). CI must run before merge.
        </Modal>
      )}
    </Modal>
  );
}
