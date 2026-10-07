#!/usr/bin/env bash
# Checks your BKK API key and the VehiclePositions URL OUTSIDE Unreal: downloads one snapshot,
# decodes it with the same decoder the game uses, and prints a few vehicles.
#
#   export BKK_API_KEY=your-key-from-opendata.bkk.hu
#   Tools/check_bkk_feed.sh
#
# If BKK documents a different URL, pass it (with {key} where the key goes):
#   BKK_VP_URL='https://example/VehiclePositions.pb?key={key}' Tools/check_bkk_feed.sh
set -euo pipefail
cd "$(dirname "$0")/.."

: "${BKK_API_KEY:?Set BKK_API_KEY first (free key: https://opendata.bkk.hu)}"
URL_TEMPLATE="${BKK_VP_URL:-https://go.bkk.hu/api/query/v1/ws/gtfs-rt/full/VehiclePositions.pb?key={key}}"
URL="${URL_TEMPLATE//\{key\}/$BKK_API_KEY}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "GET ${URL_TEMPLATE}"
STATUS=$(curl -sS -o "$WORK/feed.pb" -w '%{http_code} %{content_type}' "$URL") || { echo "request failed"; exit 1; }
echo "-> HTTP $STATUS, $(wc -c < "$WORK/feed.pb") bytes"
case "$STATUS" in
  200*) ;;
  401*|403*) echo "BKK rejected the key (or the key goes somewhere else, e.g. a header). Re-check the docs on opendata.bkk.hu."; exit 1 ;;
  *) echo "Unexpected response; first bytes:"; head -c 300 "$WORK/feed.pb"; echo; exit 1 ;;
esac

${CXX:-c++} -std=c++17 -O1 -ISource/BudapestSim Tools/DecoderTest/decoder_dump.cpp Source/BudapestSim/Transit/GtfsRtDecoder.cpp -o "$WORK/decoder_dump"
"$WORK/decoder_dump" "$WORK/feed.pb"
