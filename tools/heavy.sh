#!/bin/sh
# Runs a heavy command (test Home Assistant, browser tests, screenshots) one at a time across all checkouts.
# The machine also runs a real home, so only one of each kind runs at once:
#   sh tools/heavy.sh testha  <cmd…>   – anything that starts or uses the test HA on port 8124
#   sh tools/heavy.sh browser <cmd…>   – Playwright tests and screenshots without the test HA
# Waits for the slot (up to 60 min), then runs the command.
set -e
KIND=$1; shift
DIR=${HEAVY_LOCKS:-${XDG_RUNTIME_DIR:-/tmp}/roomwise-locks}
mkdir -p "$DIR"
exec flock -w 3600 "$DIR/$KIND.lock" "$@"
