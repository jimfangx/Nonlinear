// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/lib/markdown";

describe("untrusted markdown (§8)", () => {
  it("strips scripts, event handlers and javascript: links", () => {
    const html = renderMarkdown(`hi <script>alert(1)</script><img src=x onerror=alert(1)> [x](javascript:alert(1)) <iframe src="https://evil"></iframe>`);
    expect(html).not.toMatch(/<script|onerror|javascript:|<iframe/i);
  });
  it("keeps GitHub images, opens links safely", () => {
    const html = renderMarkdown(`![a](https://user-images.githubusercontent.com/1.png) [gh](https://github.com/ucb-bar/chipyard)`);
    expect(html).toContain('src="https://user-images.githubusercontent.com/1.png"');
    expect(html).toMatch(/rel="noopener noreferrer nofollow"/);
    expect(html).toMatch(/target="_blank"/);
  });
  it("drops non-GitHub image sources (tracking pixels)", () => {
    expect(renderMarkdown(`![t](https://tracker.example/p.gif)`)).not.toContain("tracker.example");
  });
  it("renders the managed chain block as invisible comments + text", () => {
    const html = renderMarkdown("x\n\n<!-- nonlinear:chain:start v1 id=c -->\nDepends-On: https://github.com/a/b/pull/1\n<!-- nonlinear:chain:end -->");
    expect(html).toContain("Depends-On");
  });
});
