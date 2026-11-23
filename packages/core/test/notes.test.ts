import { describe, expect, it } from "vitest";
import { categorize, prNumberFromMessage, renderReleaseNotes } from "../src";

describe("release notes", () => {
  it("finds PR numbers in merge and squash commits", () => {
    expect(prNumberFromMessage("Merge pull request #42 from a/b\n\nbody")).toBe(42);
    expect(prNumberFromMessage("Add TLB widths (#3512)")).toBe(3512);
    expect(prNumberFromMessage("plain commit")).toBeNull();
  });

  it("categorizes by label, then conventional prefix", () => {
    expect(categorize({ title: "Something", labels: ["Bug"] })).toBe("🐛 Bug fixes");
    expect(categorize({ title: "feat(core): add x", labels: [] })).toBe("🚀 Features");
    expect(categorize({ title: "Tidy", labels: [] })).toBe("Other changes");
  });

  it("renders a table and grouped sections", () => {
    const md = renderReleaseNotes("v2.1", [
      { path: "generators/rocket-chip", repo: "chipsalliance/rocket-chip", fromSha: "a".repeat(40), toSha: "b".repeat(40), commitCount: 3, warnings: [],
        changes: [
          { number: 7, title: "Fix PMP check (#7)", author: "alice", labels: ["bug"], url: "https://github.com/x/y/pull/7", sha: "c".repeat(40) },
          { number: 8, title: "feat: Sv48", author: "bob", labels: [], url: "https://github.com/x/y/pull/8", sha: "d".repeat(40) },
        ] },
      { path: "unchanged", repo: null, fromSha: "e".repeat(40), toSha: "e".repeat(40), commitCount: 0, warnings: [], changes: [] },
    ]);
    expect(md).toContain("Updates 1 submodule.");
    expect(md).toContain("### 🐛 Bug fixes");
    expect(md).toContain("- Fix PMP check [#7](https://github.com/x/y/pull/7) @alice");
    expect(md).toContain("### 🚀 Features");
    expect(md).toContain("compare/" + "a".repeat(40) + "..." + "b".repeat(40));
    expect(md).not.toContain("## unchanged");
  });
});
