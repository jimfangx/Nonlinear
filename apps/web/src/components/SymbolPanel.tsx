import { useEffect, useMemo, useRef, useState } from "react";
import type { PRSnapshot } from "@nonlinear/core";
import { ENGINE_LABEL, findSymbol, type EngineStatus, type SymbolLocation, type SymbolQuery } from "../lib/codenav";
import type { LoadedDiff } from "../lib/review";
import { CodeText } from "./CodeText";
import { NavIcon } from "./NavIcon";

export interface SymbolRequest {
  name: string;
  origin?: SymbolQuery["origin"];
  mode: "definition" | "references";
  /** bump to re-run */
  n: number;
}

type Tab = "definitions" | "references";

/**
 * Definitions and references of one identifier, across the PR diff, the full
 * changed files, the rest of the repository and (desktop) a language server.
 */
export function SymbolPanel({ pr, diff, request, onOpen, onClose }: {
  pr: PRSnapshot;
  diff: LoadedDiff;
  request: SymbolRequest;
  onOpen: (loc: SymbolLocation) => void;
  onClose: () => void;
}) {
  const [locs, setLocs] = useState<SymbolLocation[]>([]);
  const [status, setStatus] = useState<EngineStatus[]>([]);
  const [tab, setTab] = useState<Tab>(request.mode === "definition" ? "definitions" : "references");
  const [repo, setRepo] = useState(false);
  const [showNonCode, setShowNonCode] = useState(false);
  const autoJump = useRef(request.mode === "definition");

  useEffect(() => {
    setTab(request.mode === "definition" ? "definitions" : "references");
    autoJump.current = request.mode === "definition";
    setRepo(false);
  }, [request.n]);

  useEffect(() => {
    setLocs([]);
    setStatus([]);
    return findSymbol({ pr, diff, name: request.name, origin: request.origin }, (l, s) => { setLocs(l); setStatus(s); }, { repo });
  }, [request.n, repo, pr.key, pr.headSha]);

  const isOrigin = (l: SymbolLocation) => !!request.origin && l.path === request.origin.path && l.side === request.origin.side && l.line === request.origin.line;
  const sorted = useMemo(() => {
    const rank = (l: SymbolLocation) => (l.engine === "lsp" ? 0 : 1) + (request.origin && l.path === request.origin.path ? 0 : 2);
    return [...locs].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path) || a.line - b.line || a.col - b.col);
  }, [locs, request.origin]);
  const defs = sorted.filter((l) => l.inCode && (l.kind === "definition" || l.kind === "import"));
  const realDefs = defs.filter((l) => l.kind === "definition");
  const refs = sorted.filter((l) => l.inCode && l.kind === "reference");
  const nonCode = sorted.filter((l) => !l.inCode);
  const running = status.some((s) => s.state === "running");

  // Go to definition: jump straight there when there is exactly one (and it isn't where we clicked).
  useEffect(() => {
    if (!autoJump.current) return;
    const syntaxDone = status.find((s) => s.engine === "syntax")?.state === "done";
    const lspPending = status.find((s) => s.engine === "lsp")?.state === "running";
    const sameSide = realDefs.filter((l) => !request.origin || l.side === request.origin.side);
    const lspDefs = sameSide.filter((l) => l.engine === "lsp");
    const candidates = lspDefs.length ? lspDefs : sameSide;
    if (lspDefs.length === 1 || (syntaxDone && !lspPending && !running)) {
      autoJump.current = false;
      if (candidates.length === 1) {
        if (isOrigin(candidates[0]!)) setTab("references"); // invoked on the definition itself
        else onOpen(candidates[0]!);
      }
    }
  }, [status, locs]);

  const list = tab === "definitions" ? defs : refs;
  const groups = useMemo(() => {
    const m = new Map<string, SymbolLocation[]>();
    for (const l of list) m.set(l.path, [...(m.get(l.path) ?? []), l]);
    return [...m];
  }, [list]);
  const repoStatus = status.find((s) => s.engine === "repo");

  return (
    <section className="symbol-panel" aria-label={`Symbol ${request.name}`}>
      <div className="symbol-head">
        <b className="mono">{request.name}</b>
        <div className="seg-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "definitions"} className={tab === "definitions" ? "on" : ""} onClick={() => setTab("definitions")}>
            Definitions <span className="count">{realDefs.length}{defs.length > realDefs.length ? ` + ${defs.length - realDefs.length} import${defs.length - realDefs.length > 1 ? "s" : ""}` : ""}</span>
          </button>
          <button role="tab" aria-selected={tab === "references"} className={tab === "references" ? "on" : ""} onClick={() => setTab("references")}>
            References <span className="count">{refs.length}</span>
          </button>
        </div>
        {running && <span className="faint small">searching…</span>}
        <span className="spacer" />
        {repoStatus?.state === "skipped" && repoStatus.note?.includes("on request") && (
          <button className="btn sm" onClick={() => setRepo(true)} title="Also search files this PR didn't change">Search whole repository</button>
        )}
        <button className="btn ghost sm" onClick={onClose} aria-label="Close symbol panel" title="Close (Esc)"><NavIcon name="close" /></button>
      </div>
      <div className="symbol-status faint small">
        {status.filter((s) => s.engine !== "diff").map((s) => (
          <span key={s.engine} className={`symbol-engine ${s.state}`} title={s.note}>
            {ENGINE_LABEL[s.engine]}: {s.state === "running" ? "…" : s.state === "done" ? (s.note ?? "done") : s.state === "skipped" ? "skipped" : "error"}
            {s.state === "error" && s.note ? ` (${s.note.slice(0, 80)})` : ""}
          </span>
        ))}
      </div>
      <div className="symbol-list">
        {!groups.length && <div className="empty small">{running ? "Searching…" : tab === "definitions" ? "No definition found. It may come from a dependency outside this repository." : "No references found."}</div>}
        {groups.map(([path, items]) => (
          <div key={path} className="symbol-group">
            <div className="symbol-file mono small" title={path}>{path} <span className="faint">{items.length}</span></div>
            {items.slice(0, 200).map((l) => (
              <button key={`${l.side}:${l.line}:${l.col}`} className={`symbol-row ${isOrigin(l) ? "origin" : ""}`} onClick={() => onOpen(l)}
                title={`${l.path}:${l.line + 1} · found by ${ENGINE_LABEL[l.engine]}${l.ri === undefined ? " · opens the full file" : ""}`}>
                <span className="symbol-line mono">{l.side === "old" ? "−" : ""}{l.line + 1}</span>
                <span className="symbol-code mono"><CodeText path={l.path} text={l.text.trimEnd().slice(0, 300)} marks={l.col < 300 ? [[l.col, request.name.length]] : undefined} /></span>
                {l.label && <span className="chip">{l.label}</span>}
                {l.ri !== undefined && <span className="chip info" title="Part of this PR's diff">in PR</span>}
                {l.engine === "lsp" && <span className="chip ok">confirmed</span>}
              </button>
            ))}
          </div>
        ))}
        {nonCode.length > 0 && (
          <details className="small" open={showNonCode} onToggle={(e) => setShowNonCode(e.currentTarget.open)}>
            <summary className="faint">{nonCode.length} mention{nonCode.length > 1 ? "s" : ""} in comments or strings</summary>
            {showNonCode && nonCode.slice(0, 200).map((l) => (
              <button key={`${l.path}:${l.side}:${l.line}:${l.col}`} className="symbol-row" onClick={() => onOpen(l)}>
                <span className="symbol-line mono">{l.line + 1}</span>
                <span className="symbol-code mono"><span className="faint">{l.path.split("/").pop()}: </span>{l.text.trim().slice(0, 200)}</span>
              </button>
            ))}
          </details>
        )}
      </div>
    </section>
  );
}
