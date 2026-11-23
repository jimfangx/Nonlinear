import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  applyMutation,
  diffEdges,
  parsePRRef,
  parsePRKey,
  prKey,
  upsertManagedBlock,
  DependencyGraph,
  type ChainMutation,
  type PRKey,
} from "@nonlinear/core";
import { useApp } from "../lib/store";
import { useChainGraph, hydrateChain, setLocalEdges, chainIdFor, edgeId } from "../lib/chains";
import { cachedCapabilities, deferredNotice, writeChainBlock, WriteBlocked, describeError } from "../lib/github";
import { Modal, SyncChip, memberState } from "./ui";

/**
 * The same chain panel appears for every chain member (§2.2), highlighting the
 * selected PR. Mutations are previewed (graph + GitHub description changes)
 * before saving (§2.3).
 */
export function ChainPanel({ pr, compact }: { pr: PRKey; compact?: boolean }) {
  const { graph, disagreements, rejected, warnings } = useChainGraph();
  const prs = useApp((s) => s.prs);
  const members = useMemo(() => graph.component(pr), [graph, pr]);
  const order = useMemo(() => graph.topoOrder(members), [graph, members]);
  const linear = members.length > 1 && graph.isLinear(members);
  const layers = useMemo(() => graph.layers(members), [graph, members]);
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<ChainMutation | null>(null);

  useEffect(() => {
    void hydrateChain(members);
  }, [members.join(",")]);

  const myWarnings = warnings.filter((w) => members.includes(w.pr));
  const myDis = disagreements.filter((d) => members.includes(d.from) || members.includes(d.to));
  const myRejected = rejected.filter((r) => members.includes(r.edge.from) || members.includes(r.edge.to));

  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row">
        <h3 className="h3" style={{ margin: 0 }}>
          Chain {members.length > 1 ? `· ${members.length} PRs · ${linear ? "linear stack" : "branching DAG"}` : ""}
        </h3>
        <span className="spacer" />
        <button className="btn sm" onClick={() => setAdding(true)}>
          + Prerequisite
        </button>
      </div>
      {members.length <= 1 && <div className="faint small">No dependencies detected. Add a prerequisite or declare <code>Depends-On: owner/repo#123</code> in the PR description.</div>}
      {members.length > 1 &&
        order.map((m, i) => {
          const p = prs[m];
          const ms = memberState(p);
          const ref = parsePRKey(m)!;
          const isSel = m === pr;
          const prereqs = graph.prerequisites(m).filter((x) => members.includes(x));
          return (
            <div key={m} className="panel" style={{ padding: "6px 8px", marginLeft: (layers.get(m) ?? 0) * (linear ? 0 : 14), borderColor: isSel ? "var(--accent)" : undefined, background: isSel ? "var(--accent-2)" : undefined }}>
              <div className="row small">
                <span className="faint mono">{i + 1}.</span>
                {isSel ? <span className="grow ellipsis" aria-current="true" title={p?.title}>
                  <b>{ref.repo}#{ref.number}</b> <span className="muted">{p?.title ?? "(not loaded)"}</span>
                </span> :
                <Link to={`/pr/${ref.owner}/${ref.repo}/${ref.number}`} className="grow ellipsis" title={p?.title}>
                  <b>{ref.repo}#{ref.number}</b> <span className="muted">{p?.title ?? "(not loaded)"}</span>
                </Link>}
                <span className={`chip ${ms.cls}`}>{ms.label}</span>
              </div>
              {!compact && prereqs.length > 0 && (
                <div className="row small" style={{ flexWrap: "wrap", marginTop: 4 }}>
                  <span className="faint">after</span>
                  {prereqs.map((x) => {
                    const e = graph.edge(x, m)!;
                    return (
                      <span key={x} className="row" style={{ gap: 4 }}>
                        <span className="mono">{parsePRKey(x)?.repo}#{parsePRKey(x)?.number}</span>
                        <SyncChip s={e.sync} />
                        {e.source === "inferred" && <span className="chip warn">inferred</span>}
                        <button className="btn ghost sm" title="Remove dependency" onClick={() => setPending({ kind: "remove-edge", from: x, to: m })}>
                          ✕
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
              {!compact && linear && (
                <div className="row" style={{ gap: 2, marginTop: 2 }}>
                  <button className="btn ghost sm" disabled={i === 0} title="Move earlier" onClick={() => setPending({ kind: "reorder", order: swap(order, i, i - 1) })}>
                    ↑
                  </button>
                  <button className="btn ghost sm" disabled={i === order.length - 1} title="Move later" onClick={() => setPending({ kind: "reorder", order: swap(order, i, i + 1) })}>
                    ↓
                  </button>
                  {i > 0 && (
                    <button className="btn ghost sm" title="Split chain here" onClick={() => setPending({ kind: "split", at: m, members: order })}>
                      ✂ split
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      {myDis.map((d, i) => (
        <div key={i} className="banner warn small">
          ⚠ {d.message}: {d.from} ↔ {d.to} (declared in {d.sources.join(", ")})
        </div>
      ))}
      {myRejected.map((r, i) => (
        <div key={i} className="banner err small">
          {r.error.message}
        </div>
      ))}
      {!compact && myWarnings.slice(0, 4).map((w, i) => (
        <div key={i} className="faint small">
          {w.pr} line {w.line}: {w.message}
        </div>
      ))}
      {adding && (
        <AddPrereq
          pr={pr}
          onClose={() => setAdding(false)}
          onAdd={(pre) => {
            setAdding(false);
            setPending({ kind: "add-prerequisite", pr, prerequisite: pre });
          }}
        />
      )}
      {pending && <MutationPreview mutation={pending} graph={graph} members={members} onClose={() => setPending(null)} />}
    </div>
  );
}

function swap<T>(xs: T[], i: number, j: number): T[] {
  const c = [...xs];
  [c[i], c[j]] = [c[j]!, c[i]!];
  return c;
}

function AddPrereq({ pr, onClose, onAdd }: { pr: PRKey; onClose: () => void; onAdd: (k: PRKey) => void }) {
  const [v, setV] = useState("");
  const self = parsePRKey(pr)!;
  const ref = parsePRRef(v, { owner: self.owner, repo: self.repo });
  return (
    <Modal
      title={`Add prerequisite to ${pr}`}
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={!ref} onClick={() => ref && onAdd(prKey(ref))}>
          Preview
        </button>
      }
    >
      <input autoFocus className="input" style={{ width: "100%" }} placeholder="owner/repo#123, #123 or a GitHub PR URL" value={v} onChange={(e) => setV(e.target.value)} />
      <p className="faint small">Any public PR may be referenced, including in organizations you don't belong to. If you can't edit the upstream PR, the edge stays local or is anchored in the writable downstream PR.</p>
    </Modal>
  );
}

function MutationPreview({ mutation, graph, members, onClose }: { mutation: ChainMutation; graph: DependencyGraph; members: PRKey[]; onClose: () => void }) {
  const prs = useApp((s) => s.prs);
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [writeGitHub, setWriteGitHub] = useState(true);

  const current = graph.edges().filter((e) => members.includes(e.from) || members.includes(e.to)).map((e) => ({ from: e.from, to: e.to }));
  const next = applyMutation(current, mutation);
  const d = diffEdges(current, next);
  const declared = new Set(graph.edges().filter((e) => e.source !== "local").map((e) => edgeId(e.from, e.to)));

  // Validate acyclicity of the result.
  const check = DependencyGraph.from(next.map((e) => ({ ...e, source: "local", confidence: 1, sync: "local-only" })));
  const cycleErr = check.rejected[0]?.error.message;

  // Determine which PR bodies would change (writable PRs only).
  const affected = [...new Set(next.flatMap((e) => [e.from, e.to]).concat(d.removed.flatMap((e) => [e.from, e.to])))];
  const comp = check.graph;
  const bodyChanges = affected
    .map((k) => {
      const p = prs[k];
      const r = parsePRKey(k)!;
      const repoKey = `${r.owner}/${r.repo}`.toLowerCase();
      const caps = cachedCapabilities(repoKey);
      const prereqs = comp.prerequisites(k);
      const compMembers = comp.component(k);
      return { key: k, pr: p, canEdit: caps.has("can-edit-metadata"), prereqs, stack: comp.topoOrder(compMembers) };
    })
    .filter((x) => x.pr && x.pr.state === "open" && (x.prereqs.length > 0 || (x.pr.body ?? "").includes("chain:start")));

  const save = async () => {
    setBusy(true);
    try {
      setLocalEdges(d.added, d.removed, declared);
      if (writeGitHub) {
        const chainId = chainIdFor(comp.topoOrder(comp.component(members[0]!)));
        for (const b of bodyChanges.filter((x) => x.canEdit)) {
          const res = await writeChainBlock(b.key, b.pr!.body ?? "", { chainId, dependsOn: b.prereqs, stack: b.stack });
          const notice = deferredNotice(res, `${b.key} update`);
          if (notice) toast("warn", notice);
          else if ("kind" in res && res.kind === "conflict") toast("error", `${b.key}: ${res.reason} Resolve before re-saving.`);
          else toast("success", `Updated managed block in ${b.key}`);
        }
      }
      onClose();
    } catch (e) {
      toast("error", e instanceof WriteBlocked ? e.message : describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Preview chain change"
      onClose={onClose}
      wide
      footer={
        <>
          <label className="row small grow">
            <input type="checkbox" checked={writeGitHub} onChange={(e) => setWriteGitHub(e.target.checked)} /> Write managed blocks to PRs I can edit
          </label>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !!cycleErr} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      {cycleErr && <div className="banner err">{cycleErr}</div>}
      <h3 className="h3">Graph mutations</h3>
      <ul className="mono small">
        {d.added.map((e) => (
          <li key={`a${e.from}${e.to}`} style={{ color: "var(--ok)" }}>
            + {e.from} → {e.to}
          </li>
        ))}
        {d.removed.map((e) => (
          <li key={`r${e.from}${e.to}`} style={{ color: "var(--err)" }}>
            − {e.from} → {e.to}
          </li>
        ))}
        {!d.added.length && !d.removed.length && <li className="faint">No change</li>}
      </ul>
      <h3 className="h3">GitHub description changes</h3>
      {bodyChanges.length === 0 && <div className="faint small">No PR descriptions would change.</div>}
      {bodyChanges.map((b) => {
        const after = upsertManagedBlock(b.pr!.body, { chainId: "chain_preview", dependsOn: b.prereqs, stack: b.stack });
        return (
          <div key={b.key} className="panel pad" style={{ marginBottom: 8 }}>
            <div className="row small">
              <b>{b.key}</b>
              <span className="spacer" />
              {b.canEdit ? <span className="chip ok">will update</span> : <span className="chip">read-only → stays local only</span>}
            </div>
            {b.canEdit && <pre className="mono small" style={{ whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto" }}>{after.slice(Math.max(0, after.indexOf("<!-- nonlinear:chain:start")))}</pre>}
          </div>
        );
      })}
      <div className="faint small">Only a block carrying the same managed ID is replaced; all other description text is preserved. The current description is fetched again immediately before each write.</div>
    </Modal>
  );
}
