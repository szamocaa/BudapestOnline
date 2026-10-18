#!/usr/bin/env bash
# Runs the web game's unit tests (Node 18+, no dependencies): every tests/web/*.test.mjs.
# The browser checks are separate (need Playwright):
#   node tests/web/play.mjs            # smoke test: day/night, tram ride, metro
#   node tests/web/shot.mjs tour <dir> # screenshots of the standard viewpoints
set -euo pipefail
cd "$(dirname "$0")"
for t in *.test.mjs; do
	node "$t"
done
echo "All web tests passed."
