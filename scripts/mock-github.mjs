// Deterministic mock of the GitHub REST endpoints Nonlinear uses, for e2e tests.
// Scenario: Chipyard PR #789 depends on BOOM PR #123 and bumps the BOOM gitlink
// to a provisional (unmerged) SHA. The user ("maintainer") can push to chipyard
// but has read-only access to riscv-boom (writes there fail as org-restricted).
//
// Usage: node scripts/mock-github.mjs [port]     (default 4010)
import http from "node:http";

const PORT = Number(process.argv[2] ?? 4010);
const DAY = 864e5;
const now = Date.UTC(2026, 10, 20);
const iso = (daysAgo) => new Date(now - daysAgo * DAY).toISOString();
const sha = (prefix, i) => (prefix + String(i).padStart(4, "0")).padEnd(40, "0");

function history(prefix, n, startDaysAgo, stepDays, author) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push({ sha: sha(prefix, i), parents: i > 1 ? [sha(prefix, i - 1)] : [], date: iso(startDaysAgo - (i - 1) * stepDays), msg: `${prefix} change ${i}`, author });
  return out.reverse(); // newest first
}

const repos = {
  "ucb-bar/chipyard": { owner: "ucb-bar", name: "chipyard", id: 1, perms: { admin: false, maintain: true, push: true, triage: true, pull: true }, default: "main", hist: history("c0ffee", 6, 50, 9, "maintainer") },
  "riscv-boom/riscv-boom": { owner: "riscv-boom", name: "riscv-boom", id: 2, perms: { pull: true }, default: "master", hist: history("b00b00", 12, 70, 6, "boomdev") },
  "chipsalliance/rocket-chip": { owner: "chipsalliance", name: "rocket-chip", id: 3, perms: { pull: true }, default: "master", hist: history("40c4e7", 8, 80, 10, "rocketdev") },
};
// unmerged BOOM PR head (off master)
const boomPRHead = { sha: sha("b00bff", 1), parents: [sha("b00b00", 9)], date: iso(5), msg: "Fix i34 issue-queue wakeup", author: "boomdev" };
repos["riscv-boom/riscv-boom"].extra = [boomPRHead];

const gitmodules = `[submodule "generators/boom"]
\tpath = generators/boom
\turl = https://github.com/riscv-boom/riscv-boom.git
[submodule "generators/rocket-chip"]
\tpath = generators/rocket-chip
\turl = https://github.com/chipsalliance/rocket-chip.git
`;
const chipyardTip = repos["ucb-bar/chipyard"].hist[0].sha;
const gitlinksByCommit = { [chipyardTip]: { "generators/boom": sha("b00b00", 5), "generators/rocket-chip": sha("40c4e7", 4) } };
for (const c of repos["ucb-bar/chipyard"].hist) gitlinksByCommit[c.sha] ??= { "generators/boom": sha("b00b00", 3), "generators/rocket-chip": sha("40c4e7", 2) };

const scalaDiff = (path, n) => `diff --git a/${path} b/${path}
index 1111111..2222222 100644
--- a/${path}
+++ b/${path}
@@ -10,6 +10,8 @@ class IssueUnit(implicit p: Parameters) extends BoomModule {
   val io = IO(new IssueUnitIO)
   val slots = Seq.fill(numSlots)(Module(new IssueSlot))
-  val wakeup = io.wakeup_ports
+  // i34: filter speculative wakeups
+  val wakeup = io.wakeup_ports.map(w => w.filter(!_.bits.poisoned))
+  val revision = ${n}
   for (s <- slots) {
     s.io.wakeup := wakeup
   }
@@ -40,5 +41,6 @@ class IssueUnit(implicit p: Parameters) extends BoomModule {
   def selectOldest(): UInt = {
     val ages = slots.map(_.io.age)
+    assert(ages.nonEmpty)
     PriorityEncoder(ages)
   }
 }
`;

const prs = {
  "riscv-boom/riscv-boom#123": { number: 123, repo: "riscv-boom/riscv-boom", title: "Fix i34 issue-queue wakeup", body: "Fixes the speculative wakeup bug.\n", user: "boomdev", head: boomPRHead.sha, headRef: "fix-i34", base: "master", baseSha: sha("b00b00", 9), draft: false, reviewers: [], created: iso(6), updated: iso(5), diff: scalaDiff("src/main/scala/v3/exu/issue-unit.scala", 1), ci: "success" },
  "riscv-boom/riscv-boom#124": { number: 124, repo: "riscv-boom/riscv-boom", title: "Tune LSU replay", body: "", user: "boomdev", head: sha("b00b00", 11), headRef: "lsu", base: "master", baseSha: sha("b00b00", 10), draft: true, reviewers: [], created: iso(9), updated: iso(8), diff: scalaDiff("src/main/scala/v3/lsu/lsu.scala", 4), ci: "success" },
  "ucb-bar/chipyard#789": {
    number: 789, repo: "ucb-bar/chipyard", title: "Bump BOOM for i34 fix", body: "Integrates the BOOM i34 fix.\n\nDepends-On: riscv-boom/riscv-boom#123\n", user: "contributor", head: sha("c0ffff", 1), headRef: "bump-boom", base: "main", baseSha: chipyardTip, draft: false, reviewers: ["maintainer"], created: iso(4), updated: iso(1),
    diff: scalaDiff("generators/chipyard/src/main/scala/config/BoomConfigs.scala", 2) + `diff --git a/generators/boom b/generators/boom
index ${sha("b00b00", 5).slice(0, 7)}..${boomPRHead.sha.slice(0, 7)} 160000
--- a/generators/boom
+++ b/generators/boom
@@ -1 +1 @@
-Subproject commit ${sha("b00b00", 5)}
+Subproject commit ${boomPRHead.sha}
`, ci: "pending",
  },
  "ucb-bar/chipyard#790": { number: 790, repo: "ucb-bar/chipyard", title: "WIP: Pixi env", body: "", user: "maintainer", head: sha("c0fffe", 1), headRef: "pixi", base: "main", baseSha: chipyardTip, draft: true, reviewers: [], created: iso(3), updated: iso(2), diff: scalaDiff("scripts/env.scala", 3), ci: "failure" },
};
const reviews = { "ucb-bar/chipyard#789": [], "riscv-boom/riscv-boom#123": [{ id: 1, user: { login: "boomlead" }, state: "APPROVED", body: "LGTM", submitted_at: iso(4), commit_id: boomPRHead.sha, html_url: "https://github.com/x" }] };
const comments = {};
const created = { trees: 0, commits: 0, refs: [], pulls: [] };

function repoJson(k, authed) {
  const r = repos[k];
  return { id: r.id, node_id: `R_${r.id}`, name: r.name, full_name: k, owner: { login: r.owner, type: "Organization" }, private: false, fork: false, archived: false, description: `${r.name} (mock)`, default_branch: r.default, pushed_at: iso(1), html_url: `https://github.com/${k}`, ...(authed ? { permissions: r.perms } : {}) };
}
function commitJson(k, c) {
  return { sha: c.sha, parents: c.parents.map((s) => ({ sha: s })), commit: { message: c.msg, author: { name: c.author, date: c.date }, committer: { name: c.author, date: c.date }, tree: { sha: c.tree ?? `tree_${c.sha.slice(0, 8)}` } }, author: { login: c.author } };
}
function findCommit(k, ref) {
  const r = repos[k];
  const all = [...r.hist, ...(r.extra ?? [])];
  if (ref === r.default || ref === "HEAD") return r.hist[0];
  return all.find((c) => c.sha === ref || c.sha.startsWith(ref));
}
function pullJson(key) {
  const p = prs[key];
  const [owner] = p.repo.split("/");
  return {
    id: p.number, node_id: `PR_${p.number}`, number: p.number, title: p.title, body: p.body, state: p.state ?? "open", draft: p.draft, user: { login: p.user },
    head: { ref: p.headRef, sha: p.head, repo: { full_name: p.repo } }, base: { ref: p.base, sha: p.baseSha, repo: { full_name: p.repo, private: false } },
    labels: (p.labels ?? []).map((name) => ({ name })), milestone: null, assignees: [], requested_reviewers: p.reviewers.map((login) => ({ login })), requested_teams: [],
    merged_at: p.mergedAt ?? null, closed_at: p.mergedAt ?? null, created_at: p.created, updated_at: p.updated, html_url: `https://github.com/${p.repo}/pull/${p.number}`,
    mergeable: true, mergeable_state: "clean", additions: 6, deletions: 2, changed_files: (p.diff.match(/^diff --git/gm) ?? []).length, comments: (comments[key] ?? []).length, review_comments: 0, merge_commit_sha: p.mergeCommit ?? null, _owner: owner,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const auth = req.headers.authorization ?? "";
  const authed = auth === "Bearer mock-token";
  const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS", "access-control-expose-headers": "x-ratelimit-limit,x-ratelimit-remaining,x-ratelimit-reset,etag", "x-ratelimit-limit": authed ? "5000" : "60", "x-ratelimit-remaining": authed ? "4999" : "59", "x-ratelimit-reset": String(Math.floor(now / 1000) + 3600) };
  const send = (status, body, type = "application/json") => {
    res.writeHead(status, { ...headers, "content-type": type });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  if (req.method === "OPTIONS") return send(204, "", "text/plain");
  let body = "";
  for await (const chunk of req) body += chunk;
  const json = body ? JSON.parse(body) : null;
  const p = url.pathname;
  const accept = req.headers.accept ?? "";
  let m;

  // OAuth web flow (used by the sync Worker in e2e): auto-approves.
  if (p === "/login/oauth/authorize") {
    const back = new URL(url.searchParams.get("redirect_uri"));
    back.searchParams.set("code", "mockcode");
    back.searchParams.set("state", url.searchParams.get("state"));
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }
  if (p === "/login/oauth/access_token") return send(200, { access_token: "mock-token", token_type: "bearer", scope: "public_repo" });
  if (p === "/user") return authed ? send(200, { login: "maintainer", id: 9, avatar_url: "", name: "Maintainer" }) : send(401, { message: "Requires authentication" });
  if (p === "/user/teams") return send(200, []);
  if (p === "/user/repos") return authed ? send(200, Object.keys(repos).map((k) => repoJson(k, true))) : send(401, { message: "Requires authentication" });
  if ((m = /^\/(?:orgs|users)\/([^/]+)\/repos$/.exec(p))) return send(200, Object.keys(repos).filter((k) => k.startsWith(m[1].toLowerCase() + "/")).map((k) => repoJson(k, authed)));
  if (p === "/search/repositories") return send(200, { items: Object.keys(repos).filter((k) => k.includes((url.searchParams.get("q") ?? "").split(" ")[0])).map((k) => repoJson(k, authed)) });

  // Test hook: simulate a new commit pushed to a PR (changes only the 2nd hunk of the first file).
  if ((m = /^\/_push\/(.+)$/.exec(p)) && req.method === "POST") {
    const pr = prs[decodeURIComponent(m[1])];
    pr.head = sha("c0ff11", Math.floor(Math.random() * 9000));
    pr.diff = pr.diff.replace("+    assert(ages.nonEmpty)", "+    assert(ages.nonEmpty, \"no slots\")").replace("index 1111111..2222222", "index 1111111..3333333");
    pr.updated = new Date().toISOString();
    return send(200, { head: pr.head });
  }
  // Test hook: squash-merge a PR (adds a commit on the base branch whose tree equals the PR head tree).
  if ((m = /^\/_merge\/(.+)$/.exec(p)) && req.method === "POST") {
    const pr = prs[decodeURIComponent(m[1])];
    const r = repos[pr.repo];
    const sq = { sha: sha("5900a5", 1), parents: [r.hist[0].sha], date: new Date().toISOString(), msg: `${pr.title} (#${pr.number})`, author: "boomlead", tree: `tree_${pr.head.slice(0, 8)}` };
    r.hist.unshift(sq);
    Object.assign(pr, { state: "closed", mergedAt: sq.date, mergeCommit: sq.sha, updated: sq.date });
    return send(200, { merged: sq.sha });
  }
  if (!(m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p))) return send(404, { message: "Not Found" });
  const key = `${m[1]}/${m[2]}`.toLowerCase();
  const rest = m[3] ?? "";
  const r = repos[key];
  if (!r) return send(404, { message: "Not Found" });
  if (rest === "") return send(200, repoJson(key, authed));

  if (rest === "/pulls" && req.method === "GET") {
    const state = url.searchParams.get("state") ?? "open";
    return send(200, Object.keys(prs).filter((k) => k.startsWith(key + "#") && (state === "all" || (prs[k].state ?? "open") === state)).map(pullJson));
  }
  if (rest === "/pulls" && req.method === "POST") {
    if (!authed || !r.perms.push) return send(403, { message: "Resource not accessible" });
    created.pulls.push(json);
    return send(201, { number: 999, html_url: `https://github.com/${key}/pull/999` });
  }
  if ((m = /^\/pulls\/(\d+)$/.exec(rest))) {
    const k = `${key}#${m[1]}`;
    const pr = prs[k];
    if (!pr) return send(404, { message: "Not Found" });
    if (req.method === "PATCH") {
      if (!authed) return send(401, { message: "Requires authentication" });
      if (!r.perms.push && !r.perms.triage) return send(403, { message: "Although you appear to have the correct authorization credentials, the `riscv-boom` organization has enabled OAuth App access restrictions" });
      Object.assign(pr, { body: json.body ?? pr.body, title: json.title ?? pr.title, updated: new Date().toISOString() });
      return send(200, pullJson(k));
    }
    if (accept.includes("diff")) return send(200, pr.diff, "text/plain");
    return send(200, pullJson(k));
  }
  if ((m = /^\/pulls\/(\d+)\/reviews$/.exec(rest))) {
    const k = `${key}#${m[1]}`;
    if (req.method === "POST") {
      if (!authed) return send(401, { message: "Requires authentication" });
      const rv = { id: Date.now(), user: { login: "maintainer" }, state: json.event === "APPROVE" ? "APPROVED" : json.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED", body: json.body ?? "", submitted_at: new Date().toISOString(), commit_id: json.commit_id, html_url: "https://github.com/x", _comments: json.comments ?? [] };
      (reviews[k] ??= []).push(rv);
      return send(200, rv);
    }
    return send(200, reviews[k] ?? []);
  }
  if ((m = /^\/pulls\/(\d+)\/comments$/.exec(rest))) return send(200, (reviews[`${key}#${m[1]}`] ?? []).flatMap((rv) => (rv._comments ?? []).map((c, i) => ({ id: rv.id + i, user: rv.user, body: c.body, path: c.path, line: c.line, original_line: c.line, side: c.side, commit_id: rv.commit_id, created_at: rv.submitted_at, html_url: "https://github.com/x" }))));
  if ((m = /^\/pulls\/(\d+)\/commits$/.exec(rest))) { const pr = prs[`${key}#${m[1]}`]; return send(200, [commitJson(key, { sha: pr?.head ?? "0", parents: [pr?.baseSha ?? ""], date: iso(1), msg: pr?.title ?? "PR commit", author: pr?.user ?? "x" })]); }
  if ((m = /^\/pulls\/(\d+)\/requested_reviewers$/.exec(rest))) return send(201, {});
  if ((m = /^\/issues\/(\d+)\/comments$/.exec(rest))) {
    const k = `${key}#${m[1]}`;
    if (req.method === "POST") {
      if (!authed) return send(401, { message: "Requires authentication" });
      const c = { id: Date.now(), user: { login: "maintainer" }, body: json.body, created_at: new Date().toISOString(), html_url: "https://github.com/x" };
      (comments[k] ??= []).push(c);
      return send(201, c);
    }
    return send(200, comments[k] ?? []);
  }
  if ((m = /^\/issues\/(\d+)\/labels$/.exec(rest))) { const pr = prs[`${key}#${m[1]}`]; if (pr) pr.labels = json.labels; return send(200, []); }
  if (/^\/issues\/\d+$/.test(rest)) return send(200, {});
  if ((m = /^\/commits\/([^/]+)\/status$/.exec(rest))) {
    const pr = Object.values(prs).find((x) => x.head === m[1]);
    return send(200, { state: pr?.ci ?? "success", total_count: pr ? 1 : 0 });
  }
  if (/^\/commits\/[^/]+\/check-runs$/.test(rest)) return send(200, { total_count: 0, check_runs: [] });
  if ((m = /^\/commits\/([^/]+)$/.exec(rest))) {
    const c = findCommit(key, decodeURIComponent(m[1]));
    return c ? send(200, commitJson(key, c)) : send(404, { message: "No commit found" });
  }
  if (rest === "/commits") {
    const start = findCommit(key, url.searchParams.get("sha") ?? r.default);
    if (!start) return send(404, { message: "Not Found" });
    const all = [...r.hist, ...(r.extra ?? [])];
    const out = [];
    let cur = start;
    while (cur && out.length < 100) {
      out.push(cur);
      cur = all.find((c) => c.sha === cur.parents[0]);
    }
    const page = Number(url.searchParams.get("page") ?? 1);
    return send(200, page > 1 ? [] : out.map((c) => commitJson(key, c)));
  }
  if ((m = /^\/contents\/(.+)$/.exec(rest))) {
    if (key === "ucb-bar/chipyard" && m[1] === ".gitmodules") return send(200, { type: "file", encoding: "base64", content: Buffer.from(gitmodules).toString("base64") });
    if (m[1].endsWith(".scala")) {
      const lines = Array.from({ length: 8 }, (_, i) => `// header ${i + 1}`);
      lines.push("class IssueUnit(implicit p: Parameters) extends BoomModule {");
      while (lines.length < 39) lines.push(`  val v${lines.length} = ${lines.length}`);
      lines.push("  def selectOldest(): UInt = {", "    val ages = slots.map(_.io.age)", "    assert(ages.nonEmpty)", "    PriorityEncoder(ages)", "  }", "}");
      return send(200, { type: "file", encoding: "base64", content: Buffer.from(lines.join("\n")).toString("base64") });
    }
    return send(404, { message: "Not Found" });
  }
  if ((m = /^\/git\/trees\/([^/]+)$/.exec(rest)) && req.method === "GET") {
    const c = findCommit(key, decodeURIComponent(m[1]));
    const links = key === "ucb-bar/chipyard" && c ? gitlinksByCommit[c.sha] ?? {} : {};
    return send(200, { truncated: false, tree: [{ path: ".gitmodules", mode: "100644", type: "blob", sha: "g" }, ...Object.entries(links).map(([path, s]) => ({ path, mode: "160000", type: "commit", sha: s }))] });
  }
  if (rest === "/git/trees" && req.method === "POST") { created.trees++; return send(201, { sha: "newtree" }); }
  if (rest === "/git/commits" && req.method === "POST") { created.commits++; return send(201, { sha: "newcommit" }); }
  if (rest === "/git/refs" && req.method === "POST") { created.refs.push(json.ref); return send(201, { ref: json.ref }); }
  if (rest === "/branches") return send(200, [{ name: r.default, commit: { sha: r.hist[0].sha } }, ...(r.extra ? [{ name: "fix-i34", commit: { sha: r.extra[0].sha } }] : [])]);
  if (rest === "/tags") return send(200, [{ name: "v1.0.0", commit: { sha: r.hist[Math.min(3, r.hist.length - 1)].sha } }]);
  if (rest === "/labels") return send(200, [{ name: "bug", color: "f00" }]);
  if (rest === "/milestones") return send(200, []);
  if ((m = /^\/compare\/([^.]+)\.\.\.(.+)$/.exec(rest))) {
    const [a, b] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])];
    if (accept.includes("diff")) return send(200, scalaDiff("src/main/scala/v3/exu/issue-unit.scala", 7), "text/plain");
    const ca = findCommit(key, a), cb = findCommit(key, b);
    const onMain = (s) => r.hist.some((c) => c.sha === s);
    const status = !ca || !cb ? "diverged" : onMain(ca.sha) && onMain(cb.sha) ? (ca.date <= cb.date ? (ca.sha === cb.sha ? "identical" : "ahead") : "behind") : "diverged";
    return send(200, { status, ahead_by: 1, behind_by: status === "diverged" ? 2 : 0, merge_base_commit: { sha: sha(key.startsWith("riscv") ? "b00b00" : "c0ffee", 3) } });
  }
  if (rest === "/_created") return send(200, created);
  return send(404, { message: `Mock: unhandled ${req.method} ${p}` });
});
server.listen(PORT, () => console.log(`mock GitHub on http://localhost:${PORT} (token: mock-token)`));
