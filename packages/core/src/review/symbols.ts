/**
 * Language-agnostic symbol helpers for "go to definition / find references"
 * when no language server is available. Works on plain text for any language;
 * per-family patterns decide which occurrences look like declarations.
 * (The web app layers tree-sitter on top for the languages it has grammars for.)
 */

export type LangFamily =
  | "c" | "java" | "js" | "py" | "rs" | "go" | "scala" | "kotlin" | "swift" | "verilog" | "vhdl"
  | "sh" | "ruby" | "lua" | "perl" | "make" | "generic";

const FAMILY: Record<string, LangFamily> = {
  c: "c", h: "c", cc: "c", cpp: "c", cxx: "c", hpp: "c", hh: "c", hxx: "c", ino: "c", cu: "c", cuh: "c", m: "c", mm: "c",
  java: "java", cs: "java", groovy: "java", dart: "java",
  js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", mts: "js", cts: "js", vue: "js", svelte: "js",
  py: "py", pyi: "py", pyx: "py",
  rs: "rs", go: "go",
  scala: "scala", sc: "scala", sbt: "scala", mill: "scala",
  kt: "kotlin", kts: "kotlin", swift: "swift",
  v: "verilog", sv: "verilog", svh: "verilog", vh: "verilog",
  vhd: "vhdl", vhdl: "vhdl",
  sh: "sh", bash: "sh", zsh: "sh", fish: "sh",
  rb: "ruby", rake: "ruby", lua: "lua", pl: "perl", pm: "perl",
  mk: "make", makefile: "make",
};

export function languageFamily(path: string): LangFamily {
  const base = path.split("/").pop()?.toLowerCase() ?? "";
  if (base === "makefile" || base === "gnumakefile") return "make";
  return FAMILY[base.split(".").pop() ?? ""] ?? "generic";
}

const IDENT = /[A-Za-z0-9_$]/;

/** The identifier under `col` in `text` (or immediately before it). */
export function identifierAt(text: string, col: number): { name: string; start: number; end: number } | null {
  let start = Math.max(0, Math.min(col, text.length));
  if (!IDENT.test(text[start] ?? "") && start > 0 && IDENT.test(text[start - 1] ?? "")) start--;
  if (!IDENT.test(text[start] ?? "")) return null;
  while (start > 0 && IDENT.test(text[start - 1]!)) start--;
  let end = start;
  while (end < text.length && IDENT.test(text[end]!)) end++;
  const name = text.slice(start, end);
  if (/^\d/.test(name)) return null; // a number literal
  return { name, start, end };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Rule = [RegExp, string, ("definition" | "import")?];

function rules(family: LangFamily, n: string): Rule[] {
  const N = `${esc(n)}(?![A-Za-z0-9_$])`;
  const B = `(?<![A-Za-z0-9_$])`;
  const r = (src: string, label: string, kind: "definition" | "import" = "definition"): Rule => [new RegExp(src), label, kind];
  const generic: Rule[] = [
    r(`\\b(?:def|fn|func|function|fun|sub|proc|macro)\\s+${B}${N}`, "function"),
    r(`\\b(?:class|struct|union|enum|trait|interface|object|protocol|record)\\s+${B}${N}`, "type"),
    r(`\\b(?:type|typedef|typealias|module|namespace|package)\\s+${B}${N}`, "type"),
    r(`\\b(?:val|var|let|const|local|my|our)\\s+(?:mut\\s+)?${B}${N}`, "variable"),
    r(`#\\s*define\\s+${B}${N}`, "macro"),
  ];
  switch (family) {
    case "c":
    case "java":
      return [
        r(`#\\s*define\\s+${B}${N}`, "macro"),
        r(`\\b(?:class|struct|union|enum(?:\\s+class)?|namespace|interface|record)\\s+(?:[A-Z_][A-Z0-9_]*\\s+)*${B}${N}(?!\\s*::)`, "type"),
        r(`\\btypedef\\b.*${B}${N}\\s*;`, "type"),
        r(`\\busing\\s+${B}${N}\\s*=`, "type"),
        r(`#\\s*include\\b.*${B}${N}`, "include", "import"),
        r(`^\\s*import\\s+(?:static\\s+)?[\\w.]*${B}${N}\\s*;`, "import", "import"),
        // return-type/qualifiers then the name, then ( = ; [ , { or end: a function or variable declaration
        r(`^\\s*(?!(?:return|else|case|goto|throw|new|delete|using|if|while|for|switch|do)\\b)(?:(?:[A-Za-z_][\\w:<>,]*|\\*|&)\\s*[*&]*\\s+)+(?:[A-Za-z_]\\w*::)*~?${B}${N}\\s*(?:\\(|=(?!=)|;|\\[|,|\\{|$)`, "declaration"),
      ];
    case "js":
      return [
        r(`\\b(?:function\\*?|class|interface|enum|namespace|module)\\s+${B}${N}`, "declaration"),
        r(`\\btype\\s+${B}${N}\\s*(?:<[^>]*>)?\\s*=`, "type"),
        r(`\\b(?:const|let|var)\\s+${B}${N}`, "variable"),
        r(`\\b(?:const|let|var)\\s+[{[][^=]*${B}${N}`, "variable"),
        r(`\\bimport\\b[^;]*${B}${N}[^;]*\\bfrom\\b`, "import", "import"),
        r(`\\bimport\\s+${B}${N}\\b`, "import", "import"),
        r(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set|declare)\\s+)*\\*?${B}${N}\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::[^={]+)?\\{`, "method"),
        r(`^\\s*(?:(?:public|private|protected|static|readonly|abstract|override|declare)\\s+)+${B}${N}\\s*[?!]?\\s*[:=]`, "field"),
      ];
    case "py":
      return [
        r(`^\\s*(?:async\\s+)?def\\s+${B}${N}`, "function"),
        r(`^\\s*class\\s+${B}${N}`, "class"),
        r(`^\\s*(?:[A-Za-z_][\\w.]*\\s*,\\s*)*${B}${N}\\s*(?:,\\s*[A-Za-z_][\\w.]*\\s*)*(?::[^=]+)?=(?!=)`, "variable"),
        r(`^\\s*(?:from\\s+\\S+\\s+)?import\\b.*${B}${N}`, "import", "import"),
        r(`\\bfor\\s+(?:[\\w\\s,(]*,\\s*)?${B}${N}\\b[\\w\\s,)]*\\bin\\b`, "loop variable"),
        r(`\\bas\\s+${B}${N}`, "alias"),
        r(`\\b(?:global|nonlocal)\\s+.*${B}${N}`, "variable"),
      ];
    case "rs":
      return [
        r(`\\b(?:fn|struct|enum|trait|type|mod|const|static|union)\\s+${B}${N}`, "declaration"),
        r(`\\bmacro_rules!\\s*${B}${N}`, "macro"),
        r(`\\blet\\s+(?:mut\\s+)?${B}${N}`, "variable"),
        r(`\\blet\\s+[(\\[{][^=]*${B}${N}`, "variable"),
        r(`\\bimpl\\b(?:<[^>]*>)?\\s+(?:[\\w:<>]+\\s+for\\s+)?${B}${N}`, "impl"),
        r(`^\\s*use\\b.*${B}${N}`, "import", "import"),
      ];
    case "go":
      return [
        r(`\\bfunc\\s+(?:\\([^)]*\\)\\s*)?${B}${N}`, "function"),
        r(`\\btype\\s+${B}${N}`, "type"),
        r(`\\b(?:var|const)\\s+(?:\\(\\s*)?${B}${N}`, "variable"),
        r(`${B}${N}\\s*(?:,\\s*\\w+\\s*)*:=`, "variable"),
        r(`^\\s*${B}${N}\\s+[\\w\\[\\]*.]+(?:\\s+\`[^\`]*\`)?\\s*$`, "field"),
      ];
    case "scala":
    case "kotlin":
    case "swift":
      return [
        r(`\\b(?:def|fun|func|init)\\s+${B}${N}`, "function"),
        r(`\\b(?:lazy\\s+val|val|var|let|given)\\s+${B}${N}`, "value"),
        r(`\\b(?:val|var|let)\\s+\\([^)]*${B}${N}`, "value"),
        r(`\\b(?:case\\s+class|class|case\\s+object|object|trait|type|enum|struct|protocol|interface|typealias|extension)\\s+${B}${N}`, "type"),
        r(`^\\s*import\\b.*${B}${N}`, "import", "import"),
        r(`^\\s*package\\s+[\\w.]*${B}${N}`, "package"),
      ];
    case "verilog":
      return [
        r(`\\b(?:module|macromodule|interface|package|class|program|primitive|typedef(?:\\s+\\w+)*|function(?:\\s+automatic)?(?:\\s+[\\w\\[\\]:]+)?|task(?:\\s+automatic)?)\\s+${B}${N}`, "declaration"),
        r(`\\b(?:wire|reg|logic|bit|byte|int|integer|longint|shortint|real|parameter|localparam|genvar|input|output|inout|var|tri|supply0|supply1|uwire)\\b[^;=()]*?${B}${N}\\s*(?:\\[[^\\]]*\\]\\s*)*(?:[;=,)]|$)`, "signal"),
        r("`define\\s+" + B + N, "macro"),
        r(`^\\s*[A-Za-z_]\\w*\\s+(?:#\\s*\\(.*\\)\\s*)?${B}${N}\\s*\\(`, "instance"),
      ];
    case "vhdl":
      return [r(`\\b(?:entity|component|signal|variable|constant|type|subtype|function|procedure|architecture|package|alias|port)\\s+${B}${N}`, "declaration"), r(`^\\s*${B}${N}\\s*:\\s*(?:in|out|inout|buffer)\\b`, "port")];
    case "sh":
      return [r(`^\\s*(?:function\\s+)?${B}${N}\\s*\\(\\s*\\)`, "function"), r(`^\\s*function\\s+${B}${N}`, "function"), r(`^\\s*(?:export\\s+|local\\s+|readonly\\s+|declare\\s+(?:-\\w+\\s+)*)?${B}${N}=`, "variable")];
    case "ruby":
    case "lua":
    case "perl":
      return [r(`\\b(?:def|class|module|function|sub)\\s+(?:self\\.)?(?:[\\w.:]+[.:])?${B}${N}`, "declaration"), r(`\\blocal\\s+(?:function\\s+)?${B}${N}`, "variable"), r(`\\b(?:my|our)\\s+[$@%]?${B}${N}`, "variable"), r(`^\\s*${B}${N}\\s*=(?!=)`, "variable")];
    case "make":
      return [r(`^${B}${N}\\s*(?:[:+?!]?=)`, "variable"), r(`^${B}${N}\\s*:(?!=)`, "target"), r(`^\\s*define\\s+${B}${N}`, "macro")];
    default:
      return generic;
  }
}

const HASH_COMMENT = new Set<LangFamily>(["py", "sh", "ruby", "perl", "make"]);
const DASH_COMMENT = new Set<LangFamily>(["vhdl", "lua"]);

/** Columns of `line` that are code (not inside strings or line comments). Heuristic, single line. */
export function codeMask(line: string, family: LangFamily): Uint8Array {
  const mask = new Uint8Array(line.length).fill(1);
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      mask[i] = 0;
      if (c === "\\") { if (i + 1 < line.length) mask[++i] = 0; continue; }
      if (c === quote) quote = "";
      continue;
    }
    const lineComment = (c === "/" && line[i + 1] === "/" && family !== "py" && family !== "sh")
      || (c === "#" && HASH_COMMENT.has(family))
      || (c === "-" && line[i + 1] === "-" && DASH_COMMENT.has(family));
    if (lineComment) { mask.fill(0, i); break; }
    if (c === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      const stop = end < 0 ? line.length : end + 2;
      mask.fill(0, i, stop);
      i = stop - 1;
      continue;
    }
    if (c === '"' || c === "`" || (c === "'" && family !== "rs" && family !== "verilog" && family !== "vhdl" && family !== "scala")) {
      quote = c;
      mask[i] = 0;
    }
  }
  // Lines that look like the middle of a block comment.
  if (/^\s*\*(?!\/)/.test(line) && family !== "py") mask.fill(0);
  return mask;
}

export type OccurrenceKind = "definition" | "import" | "reference";

export interface TextOccurrence {
  line: number; // 0-based
  col: number;
  kind: OccurrenceKind;
  label?: string;
  /** false when the hit is inside a string or comment (heuristic) */
  inCode: boolean;
}

/** Classify one occurrence of `name` at `col` in `line`. */
export function classifyOccurrence(line: string, col: number, name: string, family: LangFamily): { kind: OccurrenceKind; label?: string } {
  for (const [re, label, kind] of rules(family, name)) {
    const m = re.exec(line);
    if (!m) continue;
    // the rule's name must be this occurrence: the match must end at/after it and the name sit inside the match
    const at = m.index + m[0].lastIndexOf(name);
    if (m.index <= col && col < m.index + m[0].length && (at === col || line.indexOf(name, m.index) === col)) return { kind: kind ?? "definition", label };
  }
  return { kind: "reference" };
}

/** All whole-word occurrences of `name` in `text`, classified. Fast: one indexOf scan. */
export function scanOccurrences(text: string, name: string, family: LangFamily, limit = 5000): TextOccurrence[] {
  const out: TextOccurrence[] = [];
  if (!name) return out;
  let line = 0;
  let lineStart = 0;
  let at = text.indexOf(name);
  const masks = new Map<number, Uint8Array>();
  while (at >= 0 && out.length < limit) {
    const before = text[at - 1];
    const after = text[at + name.length];
    if (!(before && IDENT.test(before)) && !(after && IDENT.test(after))) {
      // advance line counter
      let nl = text.indexOf("\n", lineStart);
      while (nl >= 0 && nl < at) {
        line++;
        lineStart = nl + 1;
        nl = text.indexOf("\n", lineStart);
      }
      const lineEnd = nl < 0 ? text.length : nl;
      const lineText = text.slice(lineStart, lineEnd);
      const col = at - lineStart;
      let mask = masks.get(line);
      if (!mask) masks.set(line, (mask = codeMask(lineText, family)));
      const inCode = mask[col] === 1;
      const c = inCode ? classifyOccurrence(lineText, col, name, family) : { kind: "reference" as const };
      out.push({ line, col, inCode, ...c });
    }
    at = text.indexOf(name, at + name.length);
  }
  return out;
}
