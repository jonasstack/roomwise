#!/bin/sh
# Starts the isolated test Home Assistant for the companion tests: container fp-test-ha on 127.0.0.1:8124 with this
# checkout's custom_components/roomwise and the recording helper fp_fake (testha/fp_fake). It shares the port with the
# Hausregeln test HA (hr-test-ha) and stops it, so run it only inside `sh tools/heavy.sh testha …`.
# `start.sh fresh` starts from scratch. Waits until Home Assistant answers.
set -e
R=$(cd "$(dirname "$0")/../../.." && pwd)
D="$R/tools/.cache/fp-testha"
if [ "$1" = "fresh" ]; then
  docker rm -f fp-test-ha >/dev/null 2>&1 || true
  [ -d "$D" ] && docker run --rm -v "$R/tools/.cache:/c" alpine rm -rf /c/fp-testha
  rm -f "$R/tools/.cache/companion-test-token"
fi
mkdir -p "$D"
cp "$R/tools/companion/testha/configuration.yaml" "$D/"
docker rm -f hr-test-ha fp-test-ha >/dev/null 2>&1 || true
docker run -d --name fp-test-ha -p 127.0.0.1:8124:8123 -e TZ=Europe/Berlin \
  -v "$D:/config" \
  -v "$R/custom_components/roomwise:/config/custom_components/roomwise:ro" \
  -v "$R/tools/companion/testha/fp_fake:/config/custom_components/fp_fake:ro" \
  ghcr.io/home-assistant/home-assistant:stable >/dev/null
i=0
until curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8124/api/ | grep -qE '200|401'; do
  i=$((i + 1))
  [ $i -gt 150 ] && echo "test HA did not come up" && exit 1
  sleep 2
done
sleep 5
echo "companion test HA running on http://127.0.0.1:8124"
