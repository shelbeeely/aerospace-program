#!/usr/bin/env bash
# Stop hook: before Claude finishes a turn, run the repo's fast checks on uncommitted work.
#
#   npm run typecheck          the whole project type-checks
#   npm run train -- --check   no network weights are stale (trained on older code)
#
# A failure exits 2 with what failed on stderr, which sends Claude back to fix it (exit 1 would
# only report it and let the turn end). After 3 failed tries in a row it lets the turn end with a
# message instead, so it can never loop forever. Nothing to check (no uncommitted TypeScript,
# weights or package changes) exits 0 at once.
set -uo pipefail
input=$(cat)
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0

session=$(printf '%s' "$input" | jq -r '.session_id // "session"' 2>/dev/null || echo session)
state="${TMPDIR:-/tmp}/claude-stop-checks-${session//[^A-Za-z0-9_-]/_}"

if [ -z "$(git status --porcelain -- '*.ts' 'src/brain/weights' 'package.json' 2>/dev/null)" ]; then
  rm -f "$state"
  exit 0
fi

fail=""
if ! out=$(npm run --silent typecheck 2>&1); then
  fail+=$'npm run typecheck failed:\n'"$(printf '%s\n' "$out" | head -40)"$'\n\n'
fi
if ! out=$(npm run --silent train -- --check 2>&1); then
  fail+=$'Stale network weights; run npm run train:\n'"$(printf '%s\n' "$out" | grep -E 'STALE' | head -10)"$'\n'
fi

if [ -z "$fail" ]; then
  rm -f "$state"
  exit 0
fi

tries=$(( $(cat "$state" 2>/dev/null || echo 0) + 1 ))
if [ "$tries" -gt 3 ]; then
  rm -f "$state"
  echo '{"systemMessage": "Stop checks (typecheck, stale weights) still failing after 3 tries; finishing anyway."}'
  exit 0
fi
echo "$tries" > "$state"
printf 'Stop checks failed (try %d of 3). Fix these before finishing:\n\n%s' "$tries" "$fail" >&2
exit 2
