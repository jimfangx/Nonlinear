import { describe, expect, it } from "vitest";
import { GitHubClient, type RateLimit } from "../src/github/client";

const res = (status: number, headers: Record<string, string> = {}) => new Response(status === 401 ? JSON.stringify({ message: "Bad credentials" }) : "{}", { status, headers });

describe("GitHubClient", () => {
  it("reports only the core rate limit, not search's 30/min", async () => {
    const seen: RateLimit[] = [];
    const replies = [
      res(200, { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4990", "x-ratelimit-resource": "core" }),
      res(200, { "x-ratelimit-limit": "30", "x-ratelimit-remaining": "29", "x-ratelimit-resource": "search" }),
    ];
    const c = new GitHubClient({ token: "t", fetch: async () => replies.shift()!, onRateLimit: (r) => seen.push(r) });
    await c.request("GET", "/user");
    await c.request("GET", "/search/repositories?q=x");
    expect(seen.map((r) => r.limit)).toEqual([5000]);
    expect(c.rate?.limit).toBe(5000);
  });

  it("renews the token once on 401 and retries", async () => {
    const auths: string[] = [];
    const c = new GitHubClient({
      token: "old",
      fetch: async (_u, init) => {
        const a = (init?.headers as Record<string, string>).Authorization!;
        auths.push(a);
        return a === "Bearer new" ? res(200) : res(401);
      },
      renewToken: async () => "new",
    });
    await c.request("GET", "/user");
    expect(auths).toEqual(["Bearer old", "Bearer new"]);
    const dead = new GitHubClient({ token: "old", fetch: async () => res(401), renewToken: async () => null });
    await expect(dead.request("GET", "/user")).rejects.toMatchObject({ status: 401 });
  });

  it("shares one renewal between concurrent 401s", async () => {
    let renewals = 0;
    const c = new GitHubClient({
      token: "old",
      fetch: async (_u, init) => {
        await new Promise((r) => setTimeout(r, 5));
        return (init?.headers as Record<string, string>).Authorization === "Bearer new" ? res(200) : res(401);
      },
      renewToken: async () => {
        renewals++;
        await new Promise((r) => setTimeout(r, 20));
        return renewals === 1 ? "new" : null;
      },
    });
    await Promise.all(["/a", "/b", "/c", "/d"].map((p) => c.request("GET", p)));
    // A request that failed with an already-replaced token retries without renewing again.
    await new Promise((r) => setTimeout(r, 1));
    expect(renewals).toBe(1);
  });
});
