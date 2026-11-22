#!/bin/sh
# Nonlinear remote helper (design §9 "SSH offload"). Install unprivileged:
#   install -m 755 nonlinear-helper.sh ~/.local/bin/nonlinear-helper
# The desktop app only invokes allowlisted kinds with validated arguments.
set -eu
VERSION=1
kind="${1:-}"; shift || true
case "$kind" in
  version) echo "nonlinear-helper $VERSION" ;;
  git-log)  repo="$1"; rev="$2"; n="$3"
            exec git -C "$repo" --no-optional-locks log --topo-order -n "$n" --format='%H%x1f%P%x1f%cI%x1f%an%x1f%D%x1f%B%x1e' "$rev" ;;
  gitlinks) repo="$1"; rev="$2"
            exec git -C "$repo" --no-optional-locks ls-tree -r -z "$rev" ;;
  refs)     repo="$1"
            exec git -C "$repo" --no-optional-locks for-each-ref --format='%(refname)%09%(objectname)%09%(*objectname)' refs/heads refs/remotes refs/tags ;;
  show-file) repo="$1"; rev="$2"; path="$3"
            exec git -C "$repo" --no-optional-locks show --no-textconv "$rev:$path" ;;
  diff)     repo="$1"; a="$2"; b="$3"
            exec git -C "$repo" --no-optional-locks diff --no-ext-diff --submodule=short "$a" "$b" -- ;;
  codegraph) repo="$1"; sub="$2"; sym="$3"
            cd "$repo" && exec timeout 120 codegraph "$sub" "$sym" ;;
  *) echo "unknown task" >&2; exit 2 ;;
esac
