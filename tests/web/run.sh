#!/usr/bin/env bash
# Runs the web game's unit tests (Node 18+, no dependencies). The browser smoke test is separate:
#   npm i playwright && node tests/web/play.mjs
set -euo pipefail
cd "$(dirname "$0")"
for t in astro osm crowd schedule bkk system meshing fallback player signals render buildings landmarks-a people; do
	node "$t.test.mjs"
done
echo "All web tests passed."
