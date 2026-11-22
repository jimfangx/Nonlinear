import { describe, expect, it } from "vitest";
import { parseGitLog, parseLsTreeGitlinks, parseRefs } from "../src/graph/gitText";
describe("git text parsers", () => {
  it("parses log records, gitlinks and refs", () => {
    const log = "aaa\u001fbbb ccc\u001f2026-01-01T00:00:00Z\u001fJim\u001fHEAD -> main, tag: v1\u001fmsg\nbody\u001e\nddd\u001f\u001f2025-12-31T00:00:00Z\u001fA\u001f\u001froot\u001e";
    const c = parseGitLog(log);
    expect(c.map((x) => x.sha)).toEqual(["aaa", "ddd"]);
    expect(c[0]!.parents).toEqual(["bbb", "ccc"]);
    expect(c[0]!.message).toBe("msg\nbody");
    expect(c[1]!.parents).toEqual([]);
    expect([...parseLsTreeGitlinks("100644 blob 1\tREADME\u0000160000 commit 2\tgenerators/boom\u0000")]).toEqual([["generators/boom", "2"]]);
    expect(parseRefs("refs/tags/v1\taaa\tbbb\nrefs/heads/main\tccc\t\n")).toEqual([{ name: "v1", sha: "bbb", kind: "tag" }, { name: "main", sha: "ccc", kind: "branch" }]);
  });
});
