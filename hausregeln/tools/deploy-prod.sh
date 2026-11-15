#!/bin/sh
# Copies the integration roomwise into a Home Assistant config folder:
#   HA_CONFIG_DIR=/path/to/config sh hausregeln/tools/deploy-prod.sh
# (HA_CONFIG_DIR may also be set in the repository's .env). Python changes need a restart of Home Assistant afterwards.
# Build first (node tools/build.mjs, and in hausregeln/ node tools/build.mjs): the built card and panel are not in git.
# A config folder that still has the old integrations (floorplan_card, house_rules): roomwise does not start next to
# them – see docs/doku/guides/umstieg-roomwise.md (delete the old folders, restart; nothing else).
set -e
R=$(cd "$(dirname "$0")/../.." && pwd)
if [ -z "$HA_CONFIG_DIR" ] && [ -f "$R/.env" ]; then
  HA_CONFIG_DIR=$(sed -n 's/^[[:space:]]*HA_CONFIG_DIR[[:space:]]*=[[:space:]]*//p' "$R/.env" | tail -n 1)
fi
[ -n "$HA_CONFIG_DIR" ] || { echo "Set HA_CONFIG_DIR to the folder that holds configuration.yaml." >&2; exit 1; }
[ -f "$HA_CONFIG_DIR/configuration.yaml" ] || { echo "No configuration.yaml in $HA_CONFIG_DIR" >&2; exit 1; }
[ -f "$R/custom_components/roomwise/frontend/floorplan-card.js" ] || { echo "Card not built: node tools/build.mjs" >&2; exit 1; }
[ -f "$R/custom_components/roomwise/house_rules/frontend/house-rules-panel.js" ] || { echo "Panel not built: (cd hausregeln && node tools/build.mjs)" >&2; exit 1; }
mkdir -p "$HA_CONFIG_DIR/custom_components/roomwise"
# old chunks stay (pages that are still open load them); everything else is replaced
rsync -a --delete --exclude __pycache__ --exclude 'frontend/chunks/' "$R/custom_components/roomwise/" "$HA_CONFIG_DIR/custom_components/roomwise/"
rsync -a --exclude __pycache__ "$R/custom_components/roomwise/frontend/chunks/" "$HA_CONFIG_DIR/custom_components/roomwise/frontend/chunks/"
echo "copied to $HA_CONFIG_DIR/custom_components/roomwise"
for old in floorplan_card house_rules; do
  [ -d "$HA_CONFIG_DIR/custom_components/$old" ] && echo "note: the old integration $old is still in $HA_CONFIG_DIR/custom_components – roomwise waits until it is deleted (then restart)"
done
exit 0
