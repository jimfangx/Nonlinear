import { describe, expect, it } from "vitest";
import {
  buildFindIndex, findInIndex, nextMatch, matchesByRow, countMatchesPerFile,
  buildFileTree, visibleTreeRows, ancestorFolders,
  identifierAt, languageFamily, classifyOccurrence, scanOccurrences, codeMask,
} from "../src";

describe("find index", () => {
  const rows = ["const foo = 1;", "foo(foo)", "", "Food is not foo_bar", "FOO"];
  const ix = buildFindIndex(rows);

  it("finds case-insensitive matches with row and column", () => {
    const r = findInIndex(ix, "foo");
    expect(r.total).toBe(6);
    expect([...r.rows]).toEqual([0, 1, 1, 3, 3, 4]);
    expect([...r.cols]).toEqual([6, 0, 4, 0, 12, 0]);
    expect(r.cols[0]).toBe(6);
    expect(r.cols[2]).toBe(4);
  });

  it("supports case-sensitive, whole-word and regex", () => {
    expect(findInIndex(ix, "foo", { caseSensitive: true }).total).toBe(4);
    expect(findInIndex(ix, "foo", { wholeWord: true }).total).toBe(4); // excludes Food, foo_bar
    const re = findInIndex(ix, "f[o]+\\(", { regex: true });
    expect(re.total).toBe(1);
    expect(findInIndex(ix, "(", { regex: true }).error).toBeTruthy();
  });

  it("never matches across rows", () => {
    expect(findInIndex(buildFindIndex(["ab", "cd"]), "b\nc", { regex: true }).total).toBe(0);
  });

  it("navigates and groups matches", () => {
    const r = findInIndex(ix, "foo");
    expect(nextMatch(r, 1, 0)).toBe(2);
    expect(nextMatch(r, 4, 5)).toBe(0); // wraps
    expect(matchesByRow(r).get(1)).toEqual([[0, 3], [4, 3]]);
  });

  it("is fast on large inputs", () => {
    const big = Array.from({ length: 200_000 }, (_, i) => `  val signal${i} = io.in(${i}) + needle${i % 97}`);
    const t0 = performance.now();
    const index = buildFindIndex(big);
    const r = findInIndex(index, "needle13");
    const ms = performance.now() - t0;
    expect(r.total).toBeGreaterThan(2000);
    expect(ms).toBeLessThan(1500);
  });

  it("counts matches per file on content lines only", () => {
    const text = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-x foo\n+x foo\ndiff --git a/foo b/foo\n@@ -1 +1 @@\n context\n";
    const second = text.indexOf("diff --git a/foo");
    const counts = countMatchesPerFile(text, null, [0, second], "foo");
    expect(counts.get(0)).toBe(2);
    expect(counts.get(1)).toBeUndefined();
  });
});

describe("file tree", () => {
  const paths = ["src/main/scala/A.scala", "src/main/scala/B.scala", "README.md", "src/test/T.scala", "docs/x.md"];
  const tree = buildFileTree(paths);

  it("puts folders before files and compacts single-child chains", () => {
    expect(tree.roots.map((n) => n.name)).toEqual(["docs", "src", "README.md"]);
    const src = tree.roots[1]!;
    expect(src.kind === "folder" && src.children.map((c) => c.name)).toEqual(["main/scala", "test"]);
  });

  it("gives display order and handles collapse", () => {
    expect(tree.order).toEqual([4, 0, 1, 3, 2]);
    expect(visibleTreeRows(tree, new Set(["src"])).map((n) => n.name)).toEqual(["docs", "x.md", "src", "README.md"]);
    expect(ancestorFolders(tree, 1)).toEqual(["src", "src/main/scala"]);
  });
});

describe("symbols", () => {
  it("finds the identifier under the cursor", () => {
    expect(identifierAt("  val ioBundle = IO(x)", 9)?.name).toBe("ioBundle");
    expect(identifierAt("foo(bar)", 3)?.name).toBe("foo");
    expect(identifierAt("x = 42", 5)).toBeNull();
  });

  it("maps paths to language families", () => {
    expect(languageFamily("a/b/Top.scala")).toBe("scala");
    expect(languageFamily("rtl/core.sv")).toBe("verilog");
    expect(languageFamily("Makefile")).toBe("make");
    expect(languageFamily("x.unknown")).toBe("generic");
  });

  it("classifies declarations across languages", () => {
    const def = (line: string, name: string, path: string) => classifyOccurrence(line, line.indexOf(name), name, languageFamily(path)).kind;
    expect(def("  def selectOldest(): UInt = {", "selectOldest", "a.scala")).toBe("definition");
    expect(def("  val ages = slots.map(_.io.age)", "slots", "a.scala")).toBe("reference");
    expect(def("int add(int a, int b) {", "add", "a.c")).toBe("definition");
    expect(def("  return add(1, 2);", "add", "a.c")).toBe("reference");
    expect(def("export async function load(id: string) {", "load", "a.ts")).toBe("definition");
    expect(def("const { load } = mod;", "load", "a.ts")).toBe("definition");
    expect(def("import { load } from './x';", "load", "a.ts")).toBe("import");
    expect(def("def handler(event):", "handler", "a.py")).toBe("definition");
    expect(def("result = handler(evt)", "handler", "a.py")).toBe("reference");
    expect(def("result = handler(evt)", "result", "a.py")).toBe("definition");
    expect(def("pub fn parse(input: &str) -> Ast {", "parse", "a.rs")).toBe("definition");
    expect(def("func (s *Server) Serve(l net.Listener) error {", "Serve", "a.go")).toBe("definition");
    expect(def("  logic [3:0] count_q;", "count_q", "a.sv")).toBe("definition");
    expect(def("  assign out = count_q + 1;", "count_q", "a.sv")).toBe("reference");
    expect(def("module counter #(parameter W = 4) (", "counter", "a.sv")).toBe("definition");
  });

  it("marks hits in strings and comments as non-code", () => {
    const m = codeMask('x = "foo" // foo', "c");
    expect(m[0]).toBe(1);
    expect(m[6]).toBe(0);
    expect(m[14]).toBe(0);
    const occ = scanOccurrences('def foo():\n  return "foo"  # foo\nfoo()\n', "foo", "py");
    expect(occ.map((o) => [o.line, o.kind, o.inCode])).toEqual([[0, "definition", true], [1, "reference", false], [1, "reference", false], [2, "reference", true]]);
  });
});
