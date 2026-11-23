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
import { expandUp, languageFamily, scanOccurrences, type ExpansionResult, type TextOccurrence } from "@nonlinear/core";

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

/* ---------------- Symbol occurrences (go to definition / find references) ---------------- */

const IDENT_NODE = /(^|_)identifier(_pattern)?$|^(constant|simple_identifier|name|word|variable_name)$/;
const IMPORT_ANCESTOR = /^(import_statement|import_from_statement|import_declaration|import_clause|import_specifier|named_imports|aliased_import|use_declaration|use_list|scoped_use_list|preproc_include|using_declaration)$/;

const sameNode = (a: Parser.SyntaxNode | null, b: Parser.SyntaxNode) => !!a && a.startIndex === b.startIndex && a.endIndex === b.endIndex;

function labelFor(type: string): string {
  if (/macro|preproc_(def|function_def)/.test(type)) return "macro";
  if (/function|method|fn_|_fn|constructor|lambda|arrow/.test(type)) return "function";
  if (/class|struct|enum|trait|interface|object|union|impl|type_(alias|definition|item|declaration)|typedef|record/.test(type)) return "type";
  if (/parameter/.test(type)) return "parameter";
  if (/field|property|member/.test(type)) return "field";
  if (/module|namespace|mod_item|package/.test(type)) return "module";
  return "variable";
}

/** How a tree-sitter identifier node is used: declaration, import or plain reference. */
function astKind(node: Parser.SyntaxNode): { kind: "definition" | "import" | "reference"; label?: string } {
  for (let a: Parser.SyntaxNode | null = node.parent, depth = 0; a && depth < 6; a = a.parent, depth++) {
    if (IMPORT_ANCESTOR.test(a.type)) return { kind: "import", label: "import" };
  }
  let child = node;
  let parent = node.parent;
  // Walk up C/C++ declarator chains: int *foo(…) → function_declarator → declaration.
  while (parent && /(_declarator|^declarator)$/.test(parent.type) && sameNode(parent.childForFieldName("declarator"), child)) {
    if (parent.type === "function_declarator") return { kind: "definition", label: "function" };
    child = parent;
    parent = parent.parent;
  }
  if (!parent) return { kind: "reference" };
  if (child !== node && /declaration|definition|parameter|field/.test(parent.type)) return { kind: "definition", label: labelFor(parent.type) };
  for (const field of ["name", "pattern", "declarator"]) {
    if (sameNode(parent.childForFieldName(field), child) && !/call|invocation|access|reference|expression$|argument|attribute/.test(parent.type)) {
      return { kind: "definition", label: labelFor(parent.type) };
    }
  }
  if (parent.type === "assignment" && sameNode(parent.childForFieldName("left"), node)) return { kind: "definition", label: "variable" };
  if (/(^|_)parameters?$|parameter_(declaration|list)|formal_parameter|typed_parameter|default_parameter|lambda_parameters/.test(parent.type)) return { kind: "definition", label: "parameter" };
  // Patterns: let (a, b) = …, for x in …, val (a, b) = …
  if (/pattern|for_statement|for_in_clause|for_expression/.test(parent.type) && !/call/.test(parent.type)) {
    const grand = parent.parent;
    if (grand && /let_declaration|val_definition|var_definition|for_|lexical_declaration|variable_declarator/.test(grand.type)) return { kind: "definition", label: "variable" };
    if (/for_statement|for_in_clause/.test(parent.type) && sameNode(parent.childForFieldName("left"), node)) return { kind: "definition", label: "loop variable" };
  }
  return { kind: "reference" };
}

/**
 * Occurrences of `name` in `text`, classified with the file's syntax tree when a
 * grammar is available (strings/comments excluded exactly); otherwise `null`
 * and callers use the text heuristics.
 */
export async function syntaxOccurrences(path: string, text: string, name: string, limit = 5000): Promise<TextOccurrence[] | null> {
  if (!text.includes(name)) return [];
  let p: Parser | null = null;
  try {
    p = await parserFor(path);
  } catch {
    return null;
  }
  if (!p) return null;
  const base = scanOccurrences(text, name, languageFamily(path), limit);
  const tree = p.parse(text);
  try {
    return base.map((o) => {
      const node = tree.rootNode.descendantForPosition({ row: o.line, column: o.col });
      if (!node) return o;
      if (!IDENT_NODE.test(node.type) || node.text !== name) {
        // inside a string/comment, or a token we don't model: keep the text guess but flag non-code
        const nonCode = /comment|string|char|template_|heredoc|regex/.test(node.type) || /comment|string/.test(node.parent?.type ?? "");
        return nonCode ? { ...o, kind: "reference" as const, label: undefined, inCode: false } : o;
      }
      return { ...o, inCode: true, ...astKind(node) };
    });
  } finally {
    tree.delete();
    p.delete();
  }
}
