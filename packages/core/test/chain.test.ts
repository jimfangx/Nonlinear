import { describe, expect, it } from "vitest";
import { parseDependencies, inferCandidates } from "../src/chain/parser";
import { DependencyGraph, explainReadiness } from "../src/chain/dag";
import { upsertManagedBlock, rebaseManagedUpdate, findManagedBlock, removeManagedBlock } from "../src/chain/managedBlock";
import { reconcile, applyMutation, diffEdges } from "../src/chain/reconcile";
import { parsePRRef, prKey } from "../src/ids";

const cy = { owner: "ucb-bar", repo: "chipyard", number: 789 };
const boom = "riscv-boom/riscv-boom#123";

describe("PR reference parsing", () => {
  it("parses URL, short and hash forms", () => {
    expect(parsePRRef("https://github.com/ucb-bar/chipyard/pull/1/files")).toEqual({ owner: "ucb-bar", repo: "chipyard", number: 1 });
    expect(parsePRRef("a/b#2")).toEqual({ owner: "a", repo: "b", number: 2 });
    expect(parsePRRef("#3", { owner: "x", repo: "y" })).toEqual({ owner: "x", repo: "y", number: 3 });
    expect(parsePRRef("#3")).toBeNull();
    expect(parsePRRef("../..#3")).toBeNull();
  });
});

describe("dependency parser", () => {
  it("parses Depends-On variants, lists and multiples", () => {
    const body = [
      "Some text",
      "- Depends-On: riscv-boom/riscv-boom#123",
      "* depends on https://github.com/chipsalliance/rocket-chip/pull/3500",
      "Depends-On: #5, firesim/firesim#10",
      "```", "Depends-On: ignored/inside#1", "```",
      "> Depends-On: quoted/ignored#1",
    ].join("\n");
    const r = parseDependencies(body, cy);
    expect(r.edges.map((e) => e.from).sort()).toEqual(["chipsalliance/rocket-chip#3500", "firesim/firesim#10", "riscv-boom/riscv-boom#123", "ucb-bar/chipyard#5"]);
    expect(r.edges.every((e) => e.to === "ucb-bar/chipyard#789" && e.confidence === 1)).toBe(true);
  });
  it("parses ordered stacks leftmost=prerequisite", () => {
    const r = parseDependencies("PR Stack: a/b#1 -> a/b#2 -> ucb-bar/chipyard#789\nChain: x/y#1 x/y#2", cy);
    expect(r.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["a/b#1>a/b#2", "a/b#2>ucb-bar/chipyard#789", "x/y#1>x/y#2"]);
    expect(r.warnings.some((w) => /does not include this PR/.test(w.message))).toBe(true);
  });
  it("warns on reverse arrows and self-deps", () => {
    const r = parseDependencies("PR Stack: a/b#1 <- a/b#2\nDepends-On: ucb-bar/chipyard#789", cy);
    expect(r.warnings.map((w) => w.message).join()).toMatch(/Reverse arrow/);
    expect(r.warnings.map((w) => w.message).join()).toMatch(/itself/);
  });
  it("reads managed blocks (new and legacy markers)", () => {
    const r = parseDependencies(`x\n<!-- nonlinear:chain:start v1 id=chain_01 -->\nDepends-On: ${boom}\n<!-- nonlinear:chain:end -->\n<!-- maintainer-workbench:chain:start v1 id=old -->\n<!-- maintainer-workbench:chain:end -->`, cy);
    expect(r.managedBlockIds).toEqual(["chain_01", "old"]);
    expect(r.edges[0]!.source).toBe("managed-block");
  });
  it("offers inferred candidates without declaring them", () => {
    const self = cy;
    const body = "This builds on a/b#4 and is cool";
    expect(inferCandidates(body, self, parseDependencies(body, self))[0]!.source).toBe("inferred");
    expect(parseDependencies(body, self).edges).toHaveLength(0);
  });
});

describe("DAG", () => {
  const e = (from: string, to: string) => ({ from, to, source: "depends-on" as const, confidence: 1, sync: "synced" as const });
  it("rejects cycles with explanation", () => {
    const { graph, rejected } = DependencyGraph.from([e("a#1", "a#2"), e("a#2", "a#3")]);
    const err = graph.addEdge(e("a#3", "a#1"));
    expect(err?.message).toMatch(/cycle/);
    expect(rejected).toHaveLength(0);
  });
  it("topo order, linearity, branching and components", () => {
    const { graph } = DependencyGraph.from([e("x#1", "x#2"), e("x#1", "x#3"), e("x#2", "x#4"), e("x#3", "x#4")]);
    const comp = graph.component("x#3");
    expect(comp.sort()).toEqual(["x#1", "x#2", "x#3", "x#4"]);
    expect(graph.topoOrder(comp)).toEqual(["x#1", "x#2", "x#3", "x#4"]);
    expect(graph.isLinear(comp)).toBe(false);
    expect(graph.isLinear(["x#1", "x#2", "x#4"])).toBe(true);
    expect(graph.layers(comp).get("x#4")).toBe(2);
  });
  it("explains readiness without collapsing to a single flag", () => {
    const { graph } = DependencyGraph.from([e("x#1", "x#2")]);
    const facts = new Map([
      ["x#1", { review: "approved" as const, ci: "passing" as const, mergeable: "yes" as const, canWrite: false as const, merged: false }],
      ["x#2", { review: "approved" as const, ci: "failing" as const, mergeable: "yes" as const, canWrite: true as const, merged: false }],
    ]);
    const r = explainReadiness(graph, "x#2", facts);
    expect(r.blockers.join("|")).toMatch(/Unmerged prerequisites: x#1/);
    expect(r.blockers.join("|")).toMatch(/CI: failing/);
  });
});

describe("managed block", () => {
  const content = { chainId: "chain_01", dependsOn: [boom], stack: [boom, prKey(cy)] };
  it("appends at end, preserves text and replaces only same id", () => {
    const body = "Intro\n\n<!-- other-tool:meta -->\n";
    const once = upsertManagedBlock(body, content);
    expect(once.startsWith("Intro\n\n<!-- other-tool:meta -->")).toBe(true);
    expect(once).toContain("Depends-On: https://github.com/riscv-boom/riscv-boom/pull/123");
    expect(once).toContain("PR-Stack: https://github.com/riscv-boom/riscv-boom/pull/123 -> https://github.com/ucb-bar/chipyard/pull/789");
    const twice = upsertManagedBlock(once + "\nTrailing", { ...content, dependsOn: [] });
    expect(twice).toContain("Trailing");
    expect(twice.match(/chain:start/g)).toHaveLength(1);
    const other = upsertManagedBlock(twice, { ...content, chainId: "chain_02" });
    expect(other.match(/chain:start/g)).toHaveLength(2);
    expect(findManagedBlock(removeManagedBlock(other, "chain_02"), "chain_02")).toBeNull();
  });
  it("rebases onto remote text edits, conflicts on block edits", () => {
    const base = upsertManagedBlock("A", content);
    expect(rebaseManagedUpdate(base, base, content).kind).toBe("unchanged-remote");
    const remote = base.replace("A", "A edited");
    const rb = rebaseManagedUpdate(base, remote, { ...content, dependsOn: [] });
    expect(rb.kind).toBe("rebased");
    expect(rb.kind === "rebased" && rb.body.startsWith("A edited")).toBe(true);
    const tampered = base.replace("Depends-On", "Depends-On: x/y#1\nDepends-On");
    expect(rebaseManagedUpdate(base, tampered, content).kind).toBe("conflict");
  });
});

describe("reconcile", () => {
  it("merges declarations, local-only edges and flags contradictions", () => {
    const r = reconcile(
      [
        { pr: { owner: "a", repo: "b", number: 2 }, body: "Depends-On: a/b#1" },
        { pr: { owner: "a", repo: "b", number: 1 }, body: "Depends-On: a/b#2" },
        { pr: { owner: "c", repo: "d", number: 9 }, body: "" },
      ],
      [{ from: "c/d#8", to: "c/d#9" }],
    );
    expect(r.disagreements).toHaveLength(1);
    expect(r.graph.edge("c/d#8", "c/d#9")?.sync).toBe("local-only");
    // One of the contradictory edges is rejected as a cycle.
    expect(r.rejected).toHaveLength(1);
    expect(r.graph.edges().find((x) => x.from.startsWith("a/b"))?.sync).toBe("conflict");
  });
  it("applies mutations for preview", () => {
    const before = [{ from: "a#1", to: "a#2" }, { from: "a#2", to: "a#3" }];
    const after = applyMutation(before, { kind: "reorder", order: ["a#2", "a#1", "a#3"] });
    const d = diffEdges(before, after);
    expect(d.added.map((x) => `${x.from}>${x.to}`).sort()).toEqual(["a#1>a#3", "a#2>a#1"]);
    const split = applyMutation(before, { kind: "split", at: "a#3", members: ["a#1", "a#2", "a#3"] });
    expect(split).toEqual([{ from: "a#1", to: "a#2" }]);
  });
});
