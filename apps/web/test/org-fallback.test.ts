import { describe, expect, it } from "vitest";
import { GitHubClient } from "@nonlinear/core";
import { withOrgFallback } from "../src/lib/github";

/** A client whose fetch answers per path; records which client served each call. */
function client(name: string, log: string[], answer: (path: string, method: string) => Response) {
  return new GitHubClient({
    token: name,
    baseUrl: `https://${name}.test`,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      log.push(`${name} ${init?.method ?? "GET"} ${url.pathname}`);
      return answer(url.pathname, init?.method ?? "GET");
    }) as typeof fetch,
  });
}
const restrictedBody = JSON.stringify({ message: "Although you appear to have the correct authorization credentials, the `acme` organization has enabled OAuth App access restrictions" });

describe("OAuth → personal access token fallback", () => {
  it("retries org-restricted calls with the fallback token and remembers the organization", async () => {
    const log: string[] = [];
    const notified: string[] = [];
    const restricted = new Set<string>();
    const oauth = client("oauth", log, (path, method) =>
      path.startsWith("/repos/acme/") && method !== "GET" ? new Response(restrictedBody, { status: 403 }) : new Response(JSON.stringify({ ok: "oauth" })));
    const pat = client("pat", log, () => new Response(JSON.stringify({ ok: "pat" })));
    const api = withOrgFallback(oauth, pat, restricted, (o) => notified.push(o));

    // Reads in the org still use OAuth.
    expect(await api.request("GET", "/repos/acme/app/pulls/1")).toEqual({ ok: "oauth" });
    // A write is refused for OAuth, then succeeds with the token.
    expect(await api.request("POST", "/repos/acme/app/issues/1/comments", { body: "hi" })).toEqual({ ok: "pat" });
    expect(notified).toEqual(["acme"]);
    expect(restricted.has("acme")).toBe(true);
    // Later calls for that org skip OAuth entirely; other orgs keep using OAuth.
    log.length = 0;
    expect(await api.request("POST", "/repos/ACME/app/issues/2/comments", { body: "again" })).toEqual({ ok: "pat" });
    expect(await api.request("POST", "/repos/other/lib/issues/1/comments", { body: "x" })).toEqual({ ok: "oauth" });
    expect(log).toEqual(["pat POST /repos/ACME/app/issues/2/comments", "oauth POST /repos/other/lib/issues/1/comments"]);
    expect(notified).toEqual(["acme"]);
  });

  it("does not retry other errors", async () => {
    const log: string[] = [];
    const oauth = client("oauth", log, () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    const pat = client("pat", log, () => new Response(JSON.stringify({ ok: "pat" })));
    const api = withOrgFallback(oauth, pat, new Set(), () => undefined);
    await expect(api.request("POST", "/repos/acme/app/issues/1/comments", {})).rejects.toMatchObject({ kind: "not-found" });
    expect(log).toEqual(["oauth POST /repos/acme/app/issues/1/comments"]);
  });
});
