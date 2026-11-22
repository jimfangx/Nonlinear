/**
 * Dependency-reference parser for PR descriptions (design §2.2).
 *
 * Recognised, case-insensitive, line-oriented forms (Markdown list prefixes allowed):
 *   Depends-On: owner/repo#123
 *   Depends on https://github.com/owner/repo/pull/123
 *   Depends-On: #12, owner/repo#13            (multiple prerequisites)
 *   PR Stack: <PR> -> <PR> -> <PR>
 *   PR-Stack: <PR> → <PR>
 *   Chain: <PR> <PR> <PR>
 *
 * Convention for Chain/PR Stack: leftmost is prerequisite, rightmost is downstream.
 */
import { parsePRRef, prKey, type PRKey, type PRRef, type RepoRef } from "../ids";

export type EdgeSource = "depends-on" | "stack" | "chain" | "managed-block" | "inferred" | "local";

export interface ParsedEdge {
  /** prerequisite (upstream) */
  from: PRKey;
  /** dependent (downstream) */
  to: PRKey;
  source: EdgeSource;
  /** 1 for explicit declarations; <1 for ordered declarations / inferred */
  confidence: number;
  line: number;
  rawText: string;
}

export interface ParseWarning {
  line: number;
  message: string;
  rawText: string;
}

export interface ParseResult {
  edges: ParsedEdge[];
  warnings: ParseWarning[];
  /** Ordered stacks as declared, preserving original order. */
  stacks: { members: PRKey[]; source: "stack" | "chain"; line: number; rawText: string }[];
  /** IDs of managed blocks found (if any). */
  managedBlockIds: string[];
}

const LIST_PREFIX = /^\s*(?:[-*+]|\d+[.)])?\s*(?:\[[ xX]\]\s*)?/;
const DEPENDS = /^(?:depends[-_ ]on|depends|requires|blocked[-_ ]by)\s*:?\s+(.+)$/i;
const STACK = /^(?:pr[-_ ]?stack)\s*:\s*(.+)$/i;
const CHAIN = /^chain\s*:\s*(.+)$/i;
const TOKEN = /(https?:\/\/(?:www\.)?github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+[^\s,;)\]>]*|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+|#\d+)/g;
const MANAGED_START = /<!--\s*(?:nonlinear|maintainer-workbench):chain:start\s+v(\d+)\s+id=([A-Za-z0-9_-]+)\s*-->/i;

function extractRefs(text: string, self: PRRef): { refs: PRRef[]; bad: string[] } {
  const refs: PRRef[] = [];
  const bad: string[] = [];
  // Strip markdown link syntax: [label](url) -> url
  const cleaned = text.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, " $2 ").replace(/[`*_]/g, " ");
  for (const m of cleaned.matchAll(TOKEN)) {
    const r = parsePRRef(m[1]!.replace(/[.,;:]+$/, ""), self);
    if (r) refs.push(r);
    else bad.push(m[1]!);
  }
  return { refs, bad };
}

/** Parse a PR body. `self` is the PR whose body is being parsed. */
export function parseDependencies(body: string | null | undefined, self: PRRef): ParseResult {
  const result: ParseResult = { edges: [], warnings: [], stacks: [], managedBlockIds: [] };
  if (!body) return result;
  const selfKey = prKey(self);
  const lines = body.split(/\r?\n/);
  let inFence = false;
  let inManaged = false;

  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    if (/^\s*(```|~~~)/.test(rawLine)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const ms = MANAGED_START.exec(rawLine);
    if (ms) {
      inManaged = true;
      result.managedBlockIds.push(ms[2]!);
      return;
    }
    if (/(?:nonlinear|maintainer-workbench):chain:end/i.test(rawLine)) {
      inManaged = false;
      return;
    }
    if (/^\s*>/.test(rawLine)) return; // quoted text is not a declaration
    const line = rawLine.replace(LIST_PREFIX, "").trim();
    if (!line) return;

    let m = DEPENDS.exec(line);
    if (m) {
      const { refs, bad } = extractRefs(m[1]!, self);
      for (const b of bad) result.warnings.push({ line: lineNo, message: `Unresolvable reference "${b}"`, rawText: rawLine });
      if (refs.length === 0) return;
      for (const r of refs) {
        const k = prKey(r);
        if (k === selfKey) {
          result.warnings.push({ line: lineNo, message: "PR declares a dependency on itself", rawText: rawLine });
          continue;
        }
        result.edges.push({
          from: k,
          to: selfKey,
          source: inManaged ? "managed-block" : "depends-on",
          confidence: 1,
          line: lineNo,
          rawText: rawLine,
        });
      }
      return;
    }

    const isStack = STACK.exec(line);
    const isChain = isStack ? null : CHAIN.exec(line);
    m = isStack ?? isChain;
    if (m) {
      const source = isStack ? "stack" : "chain";
      const payload = m[1]!;
      if (isStack && !/(->|→|=>|>)/.test(payload) && extractRefs(payload, self).refs.length > 1) {
        result.warnings.push({ line: lineNo, message: "PR Stack without arrows; assuming left-to-right order", rawText: rawLine });
      }
      if (/<-|←/.test(payload)) {
        result.warnings.push({
          line: lineNo,
          message: "Reverse arrow found; convention is leftmost = prerequisite. Order is ambiguous.",
          rawText: rawLine,
        });
      }
      const { refs, bad } = extractRefs(payload, self);
      for (const b of bad) result.warnings.push({ line: lineNo, message: `Unresolvable reference "${b}"`, rawText: rawLine });
      const keys = dedupe(refs.map(prKey));
      if (keys.length < 2) {
        result.warnings.push({ line: lineNo, message: `${source} declaration with fewer than 2 PRs`, rawText: rawLine });
        return;
      }
      result.stacks.push({ members: keys, source, line: lineNo, rawText: rawLine });
      for (let i = 0; i + 1 < keys.length; i++) {
        result.edges.push({
          from: keys[i]!,
          to: keys[i + 1]!,
          source: inManaged ? "managed-block" : source,
          confidence: inManaged ? 1 : 0.9,
          line: lineNo,
          rawText: rawLine,
        });
      }
      if (!keys.includes(selfKey)) {
        result.warnings.push({ line: lineNo, message: "Declared stack does not include this PR", rawText: rawLine });
      }
    }
  });

  if (inManaged) result.warnings.push({ line: lines.length, message: "Unterminated managed chain block", rawText: "" });
  result.edges = dedupeEdges(result.edges);
  return result;
}

function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function dedupeEdges(edges: ParsedEdge[]): ParsedEdge[] {
  const seen = new Map<string, ParsedEdge>();
  for (const e of edges) {
    const k = `${e.from}->${e.to}`;
    const prev = seen.get(k);
    if (!prev || e.confidence > prev.confidence) seen.set(k, e);
  }
  return [...seen.values()];
}

/**
 * Inferred candidates (design §2.2: never auto-accept). Suggest a dependency
 * when a body mentions another PR in free text without a declaration keyword.
 */
export function inferCandidates(body: string | null | undefined, self: PRRef, declared: ParseResult): ParsedEdge[] {
  if (!body) return [];
  const declaredKeys = new Set(declared.edges.flatMap((e) => [e.from, e.to]));
  const selfKey = prKey(self);
  const out: ParsedEdge[] = [];
  body.split(/\r?\n/).forEach((line, i) => {
    if (DEPENDS.test(line.replace(LIST_PREFIX, "").trim())) return;
    if (!/(after|on top of|builds on|needs|stacked|follow[- ]?up)/i.test(line)) return;
    for (const r of extractRefs(line, self).refs) {
      const k = prKey(r);
      if (k === selfKey || declaredKeys.has(k)) continue;
      out.push({ from: k, to: selfKey, source: "inferred", confidence: 0.4, line: i + 1, rawText: line });
    }
  });
  return out;
}

export type { RepoRef };
