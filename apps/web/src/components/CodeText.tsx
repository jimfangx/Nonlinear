import { memo, useMemo } from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import makefile from "highlight.js/lib/languages/makefile";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import typescript from "highlight.js/lib/languages/typescript";
import verilog from "highlight.js/lib/languages/verilog";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [language, grammar] of Object.entries({ bash, c, cpp, css, java, javascript, json, makefile, python, rust, scala, typescript, verilog, xml, yaml })) {
  hljs.registerLanguage(language, grammar);
}

const languages: Record<string, string> = {
  sh: "bash", bash: "bash", zsh: "bash", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cxx: "cpp",
  css: "css", java: "java", js: "javascript", mjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
  json: "json", py: "python", rs: "rust", scala: "scala", sc: "scala", sbt: "scala", mk: "makefile", makefile: "makefile",
  v: "verilog", sv: "verilog", svh: "verilog", vh: "verilog", xml: "xml", html: "xml", yml: "yaml", yaml: "yaml",
};

export type Marks = readonly (readonly [number, number])[];

/** Insert <mark> tags at text offsets into highlight.js HTML (tags and entities don't count as text). */
function markHtml(html: string, marks: Marks, currentCol: number | undefined): string {
  let out = "";
  let pos = 0; // text offset
  let mi = 0;
  let open = false;
  const cls = (start: number) => (start === currentCol ? ' class="find-current"' : "");
  const startAt = (start: number) => `<mark${cls(start)}>`;
  for (let i = 0; i < html.length;) {
    // close / open marks at this text position
    if (open && pos === marks[mi]![0] + marks[mi]![1]) { out += "</mark>"; open = false; mi++; }
    if (!open && mi < marks.length && pos === marks[mi]![0]) { out += startAt(marks[mi]![0]); open = true; }
    const ch = html[i]!;
    if (ch === "<") {
      const end = html.indexOf(">", i);
      const tag = html.slice(i, end + 1);
      // keep marks properly nested: close before a tag, reopen after
      out += open ? `</mark>${tag}${startAt(marks[mi]![0])}` : tag;
      i = end + 1;
      continue;
    }
    if (ch === "&") {
      const end = html.indexOf(";", i);
      out += html.slice(i, end + 1);
      i = end + 1;
    } else {
      out += ch;
      i++;
    }
    pos++;
  }
  if (open) out += "</mark>";
  return out;
}

export const CodeText = memo(function CodeText({ path, text, query, marks, currentCol }: { path?: string; text: string; query?: string; marks?: Marks; currentCol?: number }) {
  const language = languages[path?.toLowerCase().split(/[/.]/).at(-1) ?? ""];
  const highlighted = useMemo(() => language && text.length < 12_000
    ? hljs.highlight(text, { language, ignoreIllegals: true }).value
    : null, [text, language]);
  if (marks?.length) {
    if (highlighted !== null) return <span className="syntax" dangerouslySetInnerHTML={{ __html: markHtml(highlighted, marks, currentCol) }} />;
    const parts: React.ReactNode[] = [];
    let at = 0;
    for (const [start, len] of marks) {
      parts.push(text.slice(at, start), <mark key={start} className={start === currentCol ? "find-current" : undefined}>{text.slice(start, start + len)}</mark>);
      at = start + len;
    }
    parts.push(text.slice(at));
    return <>{parts}</>;
  }
  const match = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (query && match >= 0) return <>{text.slice(0, match)}<mark>{text.slice(match, match + query.length)}</mark>{text.slice(match + query.length)}</>;
  // Highlight.js generates its own spans and escapes the source text.
  return highlighted === null ? text : <span className="syntax" dangerouslySetInnerHTML={{ __html: highlighted }} />;
});
