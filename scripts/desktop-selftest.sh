#!/bin/sh
# Launch the built desktop app in self-test mode (window stays hidden), wait for its report.
# Usage: scripts/desktop-selftest.sh [path/to/Nonlinear.app] [git repo with submodules]
set -eu
APP="${1:-apps/desktop/src-tauri/target/debug/bundle/macos/Nonlinear.app}"
REPO="${2:-$(pwd)}"
OUT="${TMPDIR:-/tmp}/nonlinear-selftest-$$.json"
rm -f "$OUT"
NONLINEAR_SELFTEST=1 NONLINEAR_SELFTEST_REPO="$REPO" NONLINEAR_SELFTEST_OUT="$OUT" "$APP/Contents/MacOS/nonlinear-desktop" &
PID=$!
i=0
LIMIT=90
if [ -n "${NONLINEAR_SELFTEST_AI:-}" ]; then
  LIMIT=300
  echo "Real $NONLINEAR_SELFTEST_AI call: the app window will appear. If macOS asks to allow access to the CLI's saved login, click \"Always Allow\"."
fi
while [ ! -s "$OUT" ] && [ $i -lt $LIMIT ]; do sleep 1; i=$((i+1)); done
kill $PID 2>/dev/null || true
[ -s "$OUT" ] || { echo "no self-test report (app failed to start?)"; exit 1; }
cat "$OUT"
grep -q '"ok": true' "$OUT"
