#!/bin/sh
# Fresh companion test Home Assistant + the given tests, in one go (hold the lock for all of it):
#   tools/heavy.sh testha tools/companion/run.sh adapters vacuum trail
# Names map to tools/companion/test-<name>.mjs; screenshots go to $OUT (default /tmp). Exit code: failed tests.
set -u
R=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${OUT:-/tmp}
cd "$R"
node tools/build.mjs >/dev/null || exit 1
sh tools/companion/testha/start.sh fresh || exit 1
node tools/companion/setup.mjs || exit 1
fail=0
for t in "$@"; do
  echo "== test-$t"
  node "tools/companion/test-$t.mjs" http://127.0.0.1:8124 "$OUT" || fail=$((fail + 1))
done
exit $fail
