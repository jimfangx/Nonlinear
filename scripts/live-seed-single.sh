#!/bin/sh
# Seed ONE existing repo (over SSH) for live verification. PRs are opened by live-prs-single.sh (needs a token).
# Usage: scripts/live-seed-single.sh git@github.com:OWNER/REPO.git
set -eu
URL="$1"
W=$(mktemp -d)
cd "$W"
git init -q -b main repo && cd repo
git config user.name "Nonlinear e2e"; git config user.email "nonlinear-e2e@users.noreply.github.com"
printf '# nonlinear-test\nLive verification repo for Nonlinear (kept intentionally).\n' > README.md
# submodule pinned to an older Hello-World commit; the release pin will target master's tip
git -c protocol.file.allow=always submodule add -q https://github.com/octocat/Hello-World generators/hello
(cd generators/hello && git checkout -q b3cbd5bbd7e81436d2eee04537ea2b4c0cad4cdf)
git add . && git commit -qm "Seed: README + generators/hello submodule"
git push -q -u "$URL" main
git checkout -q -b upstream-fix
printf 'object IssueUnit {\n  def retry(x: Int): Int = x + 1\n}\n' > IssueUnit.scala
git add . && git commit -qm "Fix retry handling for iteration 95" && git push -q -u "$URL" upstream-fix
git checkout -q main && git checkout -q -b bump-boom
printf 'class BoomConfig {\n  val tiles = 1\n  val skipStale = true\n}\n' > BoomConfigs.scala
git add . && git commit -qm "Bump BOOM for iteration 95" && git push -q -u "$URL" bump-boom
git checkout -q main && git checkout -q -b docs
printf '# docs\n' > DOCS.md && git add . && git commit -qm "Docs" && git push -q -u "$URL" docs
cd / && rm -rf "$W"
echo "seeded $URL (branches: main, upstream-fix, bump-boom, docs)"
