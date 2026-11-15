#!/bin/sh
# Starts the isolated test Home Assistant (127.0.0.1:8124) with Hausregeln, the card's companion integration
# (only loaded once a test adds it) and the fake devices.
# Its data lives in .cache/testha (kept across reboots); `start.sh fresh` starts from scratch.
set -e
R=$(cd "$(dirname "$0")/../.." && pwd)
D="$R/.cache/testha"
if [ "$1" = "fresh" ]; then
  docker rm -f hr-test-ha >/dev/null 2>&1 || true
  [ -d "$D" ] && docker run --rm -v "$R/.cache:/c" alpine rm -rf /c/testha
  rm -f "$R/.cache/test-token"
fi
mkdir -p "$D"
cp "$R/tools/testha/config/configuration.yaml" "$R/tools/testha/config/automations.yaml" "$D/"
# also frees the port from the companion test HA (tools/companion/testha/start.sh)
docker rm -f hr-test-ha fp-test-ha >/dev/null 2>&1 || true
docker run -d --name hr-test-ha -p 127.0.0.1:8124:8123 -e TZ=Europe/Berlin \
  -v "$D:/config" \
  -v "$R/custom_components/house_rules:/config/custom_components/house_rules:ro" \
  -v "$R/tools/testha/hr_fake:/config/custom_components/hr_fake:ro" \
  -v "$R/../custom_components/floorplan_card:/config/custom_components/floorplan_card:ro" \
  ghcr.io/home-assistant/home-assistant:stable >/dev/null
echo "test HA starting on http://127.0.0.1:8124"
