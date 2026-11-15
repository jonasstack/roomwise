#!/bin/sh
# Doku screens of the card from the demo home: starts the isolated test HA (127.0.0.1:8124, this checkout's code),
# then doku-screens.mjs (pictures, hotspot boxes as JSON, HTML copies). Build first (node tools/build.mjs).
# Run under the lock:  sh tools/heavy.sh testha sh tools/design/doku-screens.sh [basis,mehr]
set -e
cd "$(dirname "$0")/../.."
sh hausregeln/tools/testha/start.sh
node tools/design/doku-screens.mjs docs/doku/assets/screens "${1:-basis,mehr}"
