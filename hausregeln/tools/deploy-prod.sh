#!/bin/sh
# Copies the integration into a Home Assistant config folder: HA_CONFIG_DIR=/path/to/config sh tools/deploy-prod.sh
# (HA_CONFIG_DIR may also be set in the repository's .env). Python changes need a restart of Home Assistant afterwards.
set -e
R=$(cd "$(dirname "$0")/.." && pwd)
if [ -z "$HA_CONFIG_DIR" ] && [ -f "$R/../.env" ]; then
  HA_CONFIG_DIR=$(sed -n 's/^[[:space:]]*HA_CONFIG_DIR[[:space:]]*=[[:space:]]*//p' "$R/../.env" | tail -n 1)
fi
[ -n "$HA_CONFIG_DIR" ] || { echo "Set HA_CONFIG_DIR to the folder that holds configuration.yaml." >&2; exit 1; }
[ -f "$HA_CONFIG_DIR/configuration.yaml" ] || { echo "No configuration.yaml in $HA_CONFIG_DIR" >&2; exit 1; }
mkdir -p "$HA_CONFIG_DIR/custom_components/house_rules"
rsync -a --delete --exclude __pycache__ "$R/custom_components/house_rules/" "$HA_CONFIG_DIR/custom_components/house_rules/"
echo "copied to $HA_CONFIG_DIR/custom_components/house_rules"
