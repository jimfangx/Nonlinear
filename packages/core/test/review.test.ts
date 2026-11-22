import { describe, expect, it } from "vitest";
import { emptyFileState, setFrontier, flagRange, fileStatus, markReviewed, remapFileState, rowSignatures, relocateAnchor, progress, subtract, union } from "../src/review/intervals";
import { parseFileHunks } from "../src/diff/unified";
import { expandUp, expandDown, breadcrumbs } from "../src/review/semantic";

describe("intervals", () => {
  it("union/subtract", () => {
    expect(union([[0, 2]], [[1, 5], [7, 8]])).toEqual([[0, 5], [7, 8]]);
    expect(subtract([[0, 10]], [[2, 3], [5, 6]])).toEqual([[0, 2], [3, 5], [6, 10]]);
  });
  it("frontier + flagged holes: complete only when frontier at end and no flags", () => {
    let s = emptyFileState("a.scala", 100);
    expect(fileStatus(s)).toBe("not-started");
    s = setFrontier(s, 50);
    expect(fileStatus(s)).toBe("incomplete");
    s = flagRange(s, [10, 20]);
    s = setFrontier(s, 100);
    expect(fileStatus(s)).toBe("incomplete");
    expect(progress(s)).toBeCloseTo(0.9);
    s = markReviewed(s, [10, 20]);
    expect(fileStatus(s)).toBe("complete");
  });
  it("frontier absorbs adjacent reviewed ranges", () => {
    let s = markReviewed(emptyFileState("a", 10), [3, 6]);
    s = setFrontier(s, 3);
    expect(s.frontier).toBe(6);
  });
});

const v1 = `@@ -1,3 +1,3 @@ class A
 a
-b
+B
@@ -10,3 +10,3 @@ def foo
 x
-y
+Y
`;
const v2same = v1;
const v2changed = `@@ -1,3 +1,3 @@ class A
 a
-b
+B
@@ -10,3 +10,4 @@ def foo
 x
-y
+Y2
+Z
`;

describe("revision-aware remap (§5.3, journey D)", () => {
  it("preserves identical blobs", () => {
    const a = rowSignatures(parseFileHunks(v1));
    const s = setFrontier(emptyFileState("f", a.length, "blob1"), a.length);
    const r = remapFileState(s, a, rowSignatures(parseFileHunks(v2same)), "blob1");
    expect(r.identical).toBe(true);
    expect(fileStatus(r.state)).toBe("complete");
  });
  it("keeps unchanged hunk reviewed, marks changed hunk stale; never by line number", () => {
    const a = rowSignatures(parseFileHunks(v1));
    const b = rowSignatures(parseFileHunks(v2changed));
    const s = setFrontier(emptyFileState("f", a.length, "blob1"), a.length);
    const r = remapFileState(s, a, b, "blob2");
    expect(r.state.frontier).toBe(3); // first hunk (3 rows) preserved
    expect(r.state.stale).toEqual([[3, b.length]]);
    expect(fileStatus(r.state)).toBe("needs-rereview");
    expect(fileStatus(setFrontier(r.state, b.length))).toBe("complete");
  });
  it("does not trust a matching (abbreviated) blob id when content differs", () => {
    const a = rowSignatures(parseFileHunks(v1));
    const b = rowSignatures(parseFileHunks(v2changed));
    const s = setFrontier(emptyFileState("f", a.length, "2222222"), a.length);
    const r = remapFileState(s, a, b, "2222222");
    expect(r.identical).toBe(false);
    expect(r.state.stale.length).toBeGreaterThan(0);
  });
  it("treats duplicated hunks as ambiguous", () => {
    const dup = `@@ -1,1 +1,1 @@\n-a\n+b\n@@ -9,1 +9,1 @@\n-a\n+b\n`;
    const a = rowSignatures(parseFileHunks(dup));
    const s = setFrontier(emptyFileState("f", a.length, "x"), a.length);
    const r = remapFileState(s, a, a, "y");
    expect(r.preservedRows).toBe(0);
    expect(r.state.stale.length).toBeGreaterThan(0);
  });
  it("relocates note anchors by content, orphaning when absent", () => {
    const anchor = { path: "f", rows: [1, 2] as [number, number], anchorText: ["foo()"], before: ["a"], after: ["b"] };
    expect(relocateAnchor(anchor, ["x", "a", "foo()", "b"])).toEqual([2, 3]);
    expect(relocateAnchor(anchor, ["foo()", "q", "a", "foo()", "b"])).toEqual([3, 4]);
    expect(relocateAnchor(anchor, ["nothing"])).toBeNull();
  });
});

describe("semantic fallback", () => {
  const src = ["package x", "class A {", "  def foo(): Int = {", "    val a = 1", "    a + 1", "  }", "  def bar = 2", "}"];
  it("expands to enclosing def/class", () => {
    expect(expandUp(src, 4).start).toBe(2);
    expect(expandDown(src, 3).end).toBe(6);
    expect(breadcrumbs(src, 4)).toEqual(["class A", "def foo(): Int"]);
  });
});
