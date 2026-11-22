import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { breadcrumbs, outline, parseFileHunks, parsePRKey, type DiffFileEntry, type PRSnapshot } from "@nonlinear/core";
import { githubApi, describeError } from "../lib/github";
import { lspAvailable, lspLocations, type LspLocation } from "../lib/lsp";
import type { LoadedDiff } from "../lib/review";
import { Split } from "../components/ui";

interface PaneSource {
  owner: string;
  repo: string;
  sha: string;
  path: string;
}

/**
 * Full-file inspector (§5.4): full file at an exact SHA with outline,
 * breadcrumbs, search, links to modified hunks, and an optional split with
 * another changed file, an arbitrary file at the PR revision, or a file in a
 * related upstream repository. Repo + SHA shown above each pane.
 */
export function FileInspector({ pr, diff, file, onClose }: { pr: PRSnapshot; diff: LoadedDiff; file: DiffFileEntry; onClose: () => void }) {
  const r = parsePRKey(pr.key)!;
  const [headOwner, headRepo] = (pr.headRepo ?? `${r.owner}/${r.repo}`).split("/") as [string, string];
  const primary: PaneSource = { owner: headOwner, repo: headRepo, sha: pr.headSha, path: file.path };
  const [second, setSecond] = useState<PaneSource | null>(null);
  const [vertical, setVertical] = useState(false);
  const [pick, setPick] = useState("");

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  const changedLines = useMemo(() => {
    const s = new Set<number>();
    for (const h of parseFileHunks(diff.text.slice(file.start, file.end))) for (const l of h.lines) if (l.kind === "add" && l.newNo) s.add(l.newNo);
    return s;
  }, [diff, file]);

  return (
    <div className="overlay" style={{ padding: 16, alignItems: "stretch" }}>
      <div className="modal" style={{ width: "100%", maxHeight: "none", display: "flex", flexDirection: "column" }}>
        <div className="head">
          <span className="grow">Inspector</span>
          <input
            className="input"
            style={{ width: 360 }}
            placeholder="Split with: path | owner/repo@sha:path"
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const m = /^([^/\s]+)\/([^@\s]+)@([^:\s]+):(.+)$/.exec(pick.trim());
              if (m) setSecond({ owner: m[1]!, repo: m[2]!, sha: m[3]!, path: m[4]! });
              else if (pick.trim()) setSecond({ ...primary, path: pick.trim() });
            }}
            list="changed-files"
          />
          <datalist id="changed-files">
            {diff.index.files.map((f) => (
              <option key={f.path} value={f.path} />
            ))}
          </datalist>
          {second && (
            <>
              <button className="btn sm" onClick={() => setVertical((v) => !v)}>
                {vertical ? "⇆ horizontal" : "⇅ vertical"}
              </button>
              <button className="btn sm" onClick={() => setSecond(null)}>
                Close split
              </button>
            </>
          )}
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {second ? (
            <Split id={`inspector-${vertical ? "v" : "h"}`} vertical={vertical} initial={0.5}>
              <FilePaneView src={primary} changed={changedLines} onOpen={setSecond} />
              <FilePaneView src={second} changed={new Set()} onOpen={setSecond} />
            </Split>
          ) : (
            <FilePaneView src={primary} changed={changedLines} onOpen={setSecond} />
          )}
        </div>
      </div>
    </div>
  );
}

function FilePaneView({ src, changed, onOpen }: { src: PaneSource; changed: Set<number>; onOpen: (s: PaneSource) => void }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [cur, setCur] = useState(0);
  const [col, setCol] = useState(0);
  const [lspRes, setLspRes] = useState<{ kind: string; server: string; locations: LspLocation[]; warn?: string } | null>(null);
  const [lspBusy, setLspBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const repoKey = `${src.owner}/${src.repo}`.toLowerCase();
  const avail = lspAvailable(repoKey, src.path);
  const runLsp = async (kind: "definition" | "references") => {
    setLspBusy(true);
    try {
      const res = await lspLocations(repoKey, src.path, kind, cur, col, src.sha);
      setLspRes({ kind, ...res, warn: undefined });
      const only = res.locations.length === 1 ? res.locations[0]! : null;
      if (kind === "definition" && only && only.path === src.path) {
        setCur(only.line);
        virt.scrollToIndex(only.line, { align: "center" });
      }
    } catch (e) {
      setLspRes({ kind, server: "", locations: [], warn: (e as Error).message });
    } finally {
      setLspBusy(false);
    }
  };
  useEffect(() => {
    setLines(null);
    setErr(null);
    githubApi()
      .then((c) => c.contents(src.owner, src.repo, src.path, src.sha))
      .then((t) => (t === null ? setErr("File not found at this revision") : setLines(t.split("\n"))))
      .catch((e) => setErr(describeError(e)));
  }, [src.owner, src.repo, src.sha, src.path]);
  const ol = useMemo(() => (lines ? outline(lines) : []), [lines]);
  const hits = useMemo(() => (lines && q ? lines.map((l, i) => (l.toLowerCase().includes(q.toLowerCase()) ? i : -1)).filter((i) => i >= 0) : []), [lines, q]);
  const changedSorted = useMemo(() => [...changed].sort((a, b) => a - b), [changed]);
  const virt = useVirtualizer({ count: lines?.length ?? 0, getScrollElement: () => ref.current, estimateSize: () => 20, overscan: 40 });
  const jump = (i: number) => {
    setCur(i);
    virt.scrollToIndex(i, { align: "center" });
  };
  const crumbs = lines ? breadcrumbs(lines, cur) : [];
  return (
    <div className="col" style={{ height: "100%", gap: 0 }}>
      <div className="toolbar small">
        <b>
          {src.owner}/{src.repo}
        </b>
        <span className="mono chip">@{src.sha.slice(0, 10)}</span>
        <span className="mono ellipsis">{src.path}</span>
        <span className="spacer" />
        <button className="btn sm" disabled={!avail.ok || lspBusy} title={avail.ok ? `${avail.server.name}: definition of the identifier at the cursor (double-click a word)` : avail.reason} onClick={() => void runLsp("definition")}>
          Definition
        </button>
        <button className="btn sm" disabled={!avail.ok || lspBusy} title={avail.ok ? `${avail.server.name}: references` : avail.reason} onClick={() => void runLsp("references")}>
          References
        </button>
        <input className="input" style={{ width: 160 }} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && hits.length && jump(hits.find((h) => h > cur) ?? hits[0]!)} />
        {q && <span className="faint">{hits.length} hits</span>}
        {changedSorted.length > 0 && (
          <button className="btn sm" onClick={() => jump((changedSorted.find((l) => l - 1 > cur) ?? changedSorted[0]!) - 1)}>
            next change
          </button>
        )}
      </div>
      <div className="small faint" style={{ padding: "2px 12px" }}>
        {crumbs.join(" › ") || "—"}
      </div>
      {err && <div className="banner err">{err}</div>}
      {lspRes && (
        <div className="panel pad small" style={{ margin: "0 8px 4px", maxHeight: 140, overflow: "auto" }}>
          <div className="row">
            <b>{lspRes.kind === "definition" ? "Definition" : "References"}</b>
            {lspRes.server && <span className="chip ok">confirmed · {lspRes.server} @ {src.sha.slice(0, 8)}</span>}
            <span className="faint">{lspRes.locations.length} result(s)</span>
            <span className="spacer" />
            <button className="btn ghost sm" onClick={() => setLspRes(null)}>✕</button>
          </div>
          {lspRes.warn && <div className="banner warn">{lspRes.warn}</div>}
          {lspRes.locations.map((l, i) => (
            <div key={i} className="tree-row mono" onClick={() => (l.path === src.path ? (setCur(l.line), virt.scrollToIndex(l.line, { align: "center" })) : onOpen({ ...src, path: l.path }))}>
              {l.path}:{l.line + 1}:{l.character + 1}
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ flex: 1, minHeight: 0, alignItems: "stretch" }}>
        <div style={{ width: 200, overflow: "auto", borderRight: "1px solid var(--border)" }} aria-label="Symbols">
          {ol.map((o) => (
            <div key={o.line} className="tree-row small" style={{ paddingLeft: 8 + o.depth * 10 }} onClick={() => jump(o.line)} title={o.text}>
              <span className="ellipsis">{o.text}</span>
            </div>
          ))}
        </div>
        <div ref={ref} className="diff grow" style={{ overflow: "auto" }}>
          <div style={{ height: virt.getTotalSize(), position: "relative", minWidth: "max-content", width: "100%" }}>
            {lines &&
              virt.getVirtualItems().map((vi) => {
                const i = vi.index;
                return (
                  <div key={i} data-l={i} className={`dl ${changed.has(i + 1) ? "add" : ""} ${i === cur ? "sel" : ""}`} style={{ gridTemplateColumns: "56px 1fr", position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` }} onClick={() => setCur(i)} onDoubleClick={() => {
                      const sel = window.getSelection();
                      const off = sel && sel.anchorNode && sel.anchorNode.parentElement?.classList.contains("code") ? sel.anchorOffset : (lines[i] ?? "").search(/\S/);
                      setCur(i);
                      setCol(Math.max(0, off));
                    }}>
                    <span className="no">{i + 1}</span>
                    <span className="code">{lines[i]}</span>
                  </div>
                );
              })}
          </div>
        </div>
      </div>
    </div>
  );
}
