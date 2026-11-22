/**
 * Tree-sitter semantic boundaries (design §5.4), loaded lazily per language.
 * Falls back to the core heuristic (labelled) when a grammar is unavailable.
 */
import Parser from "web-tree-sitter";
import runtimeUrl from "web-tree-sitter/tree-sitter.wasm?url";
import scalaUrl from "tree-sitter-wasms/out/tree-sitter-scala.wasm?url";
import pythonUrl from "tree-sitter-wasms/out/tree-sitter-python.wasm?url";
import rustUrl from "tree-sitter-wasms/out/tree-sitter-rust.wasm?url";
import tsUrl from "tree-sitter-wasms/out/tree-sitter-typescript.wasm?url";
import jsUrl from "tree-sitter-wasms/out/tree-sitter-javascript.wasm?url";
import cUrl from "tree-sitter-wasms/out/tree-sitter-c.wasm?url";
import cppUrl from "tree-sitter-wasms/out/tree-sitter-cpp.wasm?url";
import javaUrl from "tree-sitter-wasms/out/tree-sitter-java.wasm?url";
import { expandUp, type ExpansionResult } from "@nonlinear/core";

const GRAMMARS: Record<string, string> = {
  scala: scalaUrl, sc: scalaUrl, sbt: scalaUrl,
  py: pythonUrl,
  rs: rustUrl,
  ts: tsUrl, tsx: tsUrl,
  js: jsUrl, jsx: jsUrl, mjs: jsUrl,
  c: cUrl, h: cUrl,
  cc: cppUrl, cpp: cppUrl, hpp: cppUrl, cxx: cppUrl, hh: cppUrl,
  java: javaUrl,
};

/** Node types that count as an enclosing semantic block. */
const BLOCK = /(function|method|class|object|trait|enum|struct|impl|module|namespace|interface|constructor|lambda|closure|val|var)_(definition|declaration|item|specifier)$|^(function_definition|class_definition|object_definition|trait_definition|function_item|impl_item|mod_item|method_declaration|class_declaration|function_declaration|method_definition|arrow_function|class_specifier|struct_specifier|namespace_definition|decorated_definition)$/;

let init: Promise<void> | null = null;
const langs = new Map<string, Promise<Parser.Language>>();

function ext(path: string): string {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

export function hasGrammar(path: string): boolean {
  return ext(path) in GRAMMARS;
}

async function parserFor(path: string): Promise<Parser | null> {
  const url = GRAMMARS[ext(path)];
  if (!url) return null;
  init ??= Parser.init({ locateFile: () => runtimeUrl });
  await init;
  let l = langs.get(url);
  if (!l) langs.set(url, (l = Parser.Language.load(url)));
  const p = new Parser();
  p.setLanguage(await l);
  return p;
}

/**
 * Expand upward from a 0-based line to the nearest enclosing semantic block.
 * Caps very large scopes (`maxLines`) and reports the engine used.
 */
export async function expandToEnclosing(path: string, lines: string[], line: number, maxLines = 400): Promise<ExpansionResult> {
  try {
    const p = await parserFor(path);
    if (p) {
      const tree = p.parse(lines.join("\n"));
      const col = Math.max(0, (lines[line] ?? "").search(/\S/));
      let n: Parser.SyntaxNode | null = tree.rootNode.descendantForPosition({ row: line, column: col });
      while (n && !(BLOCK.test(n.type) && n.startPosition.row < line)) n = n.parent;
      // Read node fields BEFORE freeing the tree (nodes point into WASM memory).
      const found = n ? { type: n.type, start: n.startPosition.row } : null;
      tree.delete();
      p.delete();
      if (found) {
        const capped = line - found.start > maxLines;
        return { start: capped ? line - maxLines : found.start, end: line + 1, engine: "tree-sitter", label: `${found.type.replace(/_/g, " ")}: ${(lines[found.start] ?? "").trim().slice(0, 80)}`, capped };
      }
    }
  } catch {
    /* fall through to heuristic */
  }
  return expandUp(lines, line, maxLines);
}
