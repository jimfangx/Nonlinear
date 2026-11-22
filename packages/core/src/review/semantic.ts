/**
 * Semantic context expansion (design §5.4).
 *
 * Preferred engines are tree-sitter / LSP (desktop/agent). This module is the
 * always-available *fallback*: a brace/indent heuristic scanner that finds the
 * nearest enclosing block start above a line and its closing boundary below.
 * Results are labelled with the engine so the UI can show "heuristic".
 */

export type Engine = "tree-sitter" | "lsp" | "heuristic" | "lines";

export interface ExpansionResult {
  start: number; // 0-based line index, inclusive
  end: number; // exclusive
  engine: Engine;
  label: string | null;
  capped: boolean;
}

const DECL = /^\s*(?:(?:private|protected|public|final|override|implicit|abstract|sealed|case|lazy|static|export|async|inline|pub(?:\(crate\))?|unsafe|extern|const)\s+)*(?:def|class|object|trait|enum|fn|function|impl|struct|module|interface|type|val|var|let|given|extension|namespace|package)\b[^\n]*/;

function braceDelta(line: string): number {
  // ignore strings and line comments roughly
  const s = line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)'|\/\/.*$/g, "");
  let d = 0;
  for (const c of s) {
    if (c === "{") d++;
    else if (c === "}") d--;
  }
  return d;
}

function indent(l: string): number {
  const m = /^[ \t]*/.exec(l)!;
  return m[0].replace(/\t/g, "    ").length;
}

/** Expand upward from `line` to the nearest enclosing declaration. */
export function expandUp(lines: string[], line: number, maxLines = 400): ExpansionResult {
  let depth = 0;
  const floor = Math.max(0, line - maxLines);
  const baseIndent = indent(lines[line] ?? "");
  for (let i = line; i >= floor; i--) {
    const l = lines[i] ?? "";
    depth += braceDelta(l);
    // enclosing block opened at or above here
    if ((depth > 0 || (indent(l) < baseIndent && l.trim())) && DECL.test(l)) {
      return { start: i, end: line + 1, engine: "heuristic", label: l.trim().slice(0, 120), capped: false };
    }
    if (depth > 0 && /\{\s*$/.test(l)) {
      return { start: i, end: line + 1, engine: "heuristic", label: l.trim().slice(0, 120), capped: false };
    }
  }
  return { start: floor, end: line + 1, engine: floor === 0 ? "heuristic" : "lines", label: null, capped: floor > 0 };
}

/** Expand downward from `line` to the closing boundary of the current block. */
export function expandDown(lines: string[], line: number, maxLines = 400): ExpansionResult {
  let depth = 0;
  const ceil = Math.min(lines.length, line + maxLines);
  const startIndent = indent(lines[line] ?? "");
  for (let i = line; i < ceil; i++) {
    const l = lines[i] ?? "";
    depth += braceDelta(l);
    if (depth < 0) return { start: line, end: i + 1, engine: "heuristic", label: l.trim().slice(0, 120), capped: false };
    // indentation-based languages (Python/Scala 3): dedent below start ends block
    if (i > line && l.trim() && indent(l) < startIndent && depth <= 0) return { start: line, end: i, engine: "heuristic", label: null, capped: false };
  }
  return { start: line, end: ceil, engine: ceil === lines.length ? "heuristic" : "lines", label: null, capped: ceil < lines.length };
}

/** Outline of declarations for the full-file inspector's symbol list/breadcrumbs. */
export function outline(lines: string[]): { line: number; text: string; depth: number }[] {
  const out: { line: number; text: string; depth: number }[] = [];
  let depth = 0;
  lines.forEach((l, i) => {
    if (DECL.test(l) && /\b(def|class|object|trait|enum|fn|function|impl|struct|module|interface|namespace)\b/.test(l)) out.push({ line: i, text: l.trim().replace(/[\s{=]+$/, "").slice(0, 100), depth });
    depth = Math.max(0, depth + braceDelta(l));
  });
  return out;
}

/** Breadcrumb trail of enclosing declarations for a line. */
export function breadcrumbs(lines: string[], line: number): string[] {
  const ol = outline(lines);
  const trail: { depth: number; text: string }[] = [];
  for (const o of ol) {
    if (o.line > line) break;
    while (trail.length && trail[trail.length - 1]!.depth >= o.depth) trail.pop();
    trail.push(o);
  }
  return trail.map((t) => t.text);
}
