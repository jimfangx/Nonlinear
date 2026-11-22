// Large-import benchmark (§12: 50 MB target). Skipped by default; run with BENCH=1 npx vitest run test/bench.large.test.ts
import { it, expect } from "vitest";
import { importMultiRepoDiff } from "../src/diff/multiRepo";
import { parseFileHunks } from "../src/diff/unified";

it.skipIf(!process.env.BENCH)("parses a ~50 MB import", () => {
  const big: Record<string, string> = {};
  const payload = "x".repeat(14_900);
  for (let i = 0; i < 3504; i++) {
    big[`submodule-${i}`] = [
      `diff --git a/file-${i}.txt b/file-${i}.txt`,
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -0,0 +1 @@",
      `+${payload}`,
      "",
    ].join("\n");
  }
  const text = JSON.stringify(big);
  const t0 = performance.now();
  const d = importMultiRepoDiff(text);
  const t1 = performance.now();
  const g = d.groups.find((x) => x.index.files.length)!;
  const f = g.index.files[0]!;
  const t2 = performance.now();
  parseFileHunks(g.patch.slice(f.start, f.end));
  const t3 = performance.now();
  console.log(`${(text.length / 1048576).toFixed(1)} MB, ${d.groups.length} groups, ${d.totals.files} files; index ${(t1 - t0).toFixed(0)} ms; lazy file parse ${(t3 - t2).toFixed(2)} ms`);
  expect(d.totals.files).toBeGreaterThan(3000);
}, 120_000);
