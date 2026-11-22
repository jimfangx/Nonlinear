import { describe, expect, it } from "vitest";
import { importMultiRepoDiff, filterFiles, buildTree, fileSection } from "../src/diff/multiRepo";
import { indexPatch, parseFileHunks, toSplitRows } from "../src/diff/unified";

describe("multi-repository JSON diff import", () => {
  const t0 = performance.now();
  const patch = [
    "diff --git a/src/boom.scala b/src/boom.scala",
    "--- a/src/boom.scala",
    "+++ b/src/boom.scala",
    "@@ -1 +1 @@",
    "-val ready = false",
    "+val ready = true",
    "",
  ].join("\n");
  const sample = JSON.stringify({ "": patch, "generators/boom": patch, "generators/rocket-chip-blocks": "" });
  const d = importMultiRepoDiff(sample, { name: "sample" });
  const ms = performance.now() - t0;

  it("parses a representative import promptly", () => {
    expect(ms).toBeLessThan(3000);
  });
  it("has a root and named submodule groups", () => {
    expect(d.groups.map((g) => g.path)).toEqual([
      "",
      "generators/boom",
      "generators/rocket-chip-blocks",
    ]);
  });
  it("indexes root and submodule files", () => {
    expect(d.totals.files).toBe(2);
    expect(d.groups.find((g) => g.path === "generators/boom")!.index.files.length).toBe(1);
  });
  it("keeps the empty rocket-chip-blocks entry without error", () => {
    const g = d.groups.find((g) => g.path === "generators/rocket-chip-blocks")!;
    expect(g.patch).toBe("");
    expect(g.index.files).toHaveLength(0);
    expect(g.issues).toEqual([]);
  });
  it("produces no structural issues", () => {
    const all = d.groups.flatMap((g) => [...g.issues, ...g.index.files.flatMap((f) => f.issues.map((i) => `${g.path}:${f.path}: ${i}`))]);
    expect(all).toEqual([]);
    expect(d.issues).toEqual([]);
  });
  it("lazily parses one BOOM file's hunks consistently with the index", () => {
    const g = d.groups.find((g) => g.path === "generators/boom")!;
    for (const f of g.index.files) {
      const hunks = parseFileHunks(fileSection(g, f));
      expect(hunks.length).toBe(f.hunkCount);
      const adds = hunks.flatMap((h) => h.lines).filter((l) => l.kind === "add").length;
      const dels = hunks.flatMap((h) => h.lines).filter((l) => l.kind === "del").length;
      expect([adds, dels]).toEqual([f.additions, f.deletions]);
      hunks.forEach((h) => toSplitRows(h));
    }
  });
  it("filters and builds trees", () => {
    expect(filterFiles(d, { query: "boom" }).length).toBeGreaterThan(0);
    expect(buildTree(d.groups[0]!.index.files).children.size).toBeGreaterThan(0);
  });
});

describe("unified diff edge cases", () => {
  it("handles new, deleted, rename, binary, mode and gitlink", () => {
    const p = [
      "diff --git a/new.txt b/new.txt", "new file mode 100644", "index 0000000..e69de29", "--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1 @@", "+hi",
      "diff --git a/old.txt b/old.txt", "deleted file mode 100644", "index e69de29..0000000", "--- a/old.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
      "diff --git a/a.scala b/b.scala", "similarity index 100%", "rename from a.scala", "rename to b.scala",
      "diff --git a/img.png b/img.png", "index 1..2 100644", "Binary files a/img.png and b/img.png differ",
      "diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755",
      "diff --git a/generators/boom b/generators/boom", "index 1111111..2222222 160000", "--- a/generators/boom", "+++ b/generators/boom", "@@ -1 +1 @@", "-Subproject commit 1111111", "+Subproject commit 2222222",
      "",
    ].join("\n");
    const ix = indexPatch(p);
    expect(ix.files.map((f) => f.kind)).toEqual(["added", "deleted", "renamed", "binary", "mode-change", "submodule"]);
    expect(ix.files[2]!.oldPath).toBe("a.scala");
    expect(ix.files.every((f) => f.issues.length === 0)).toBe(true);
  });
  it("flags truncated hunks and unsafe paths", () => {
    const ix = indexPatch("diff --git a/../x b/../x\n--- a/../x\n+++ b/../x\n@@ -1,3 +1,3 @@\n a\n");
    expect(ix.files[0]!.issues.join()).toMatch(/Unsafe path/);
    expect(ix.files[0]!.issues.join()).toMatch(/Truncated/);
  });
  it("rejects unsafe JSON keys", () => {
    const d = importMultiRepoDiff(JSON.stringify({ "../evil": "", "./a/": "" }));
    expect(d.groups.map((g) => g.path)).toEqual(["a"]);
    expect(d.issues.join()).toMatch(/unsafe/);
  });
});
