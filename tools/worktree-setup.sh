#!/bin/sh
# Makes a fresh git worktree usable: links node_modules from the main checkout instead of installing again.
set -e
R=$(cd "$(dirname "$0")/.." && pwd)
MAIN=${MAIN_CHECKOUT:-$(git -C "$R" worktree list --porcelain | sed -n "1s/^worktree //p")}
[ "$R" = "$MAIN" ] && exit 0
[ -e "$R/node_modules" ] || ln -s "$MAIN/node_modules" "$R/node_modules"
[ -e "$R/hausregeln/node_modules" ] || ln -s "$MAIN/hausregeln/node_modules" "$R/hausregeln/node_modules"
echo "worktree ready: $R"
