#!/usr/bin/env bash
# Runs every test that does not need Unreal: decoder, astronomy, city data/mesher, and the Python baker.
# C++ is built with strict warnings and AddressSanitizer/UBSan (set SANITIZE=0 to turn the sanitizers off).
set -euo pipefail
cd "$(dirname "$0")"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
SRC=../Source/BudapestSim
CXX="${CXX:-g++}"
FLAGS=(-std=c++17 -O1 -g "-I$SRC" -Wall -Wextra -Wshadow -Wconversion -Werror)
if [ "${SANITIZE:-1}" = "1" ]; then FLAGS+=(-fsanitize=address,undefined -fno-sanitize-recover=undefined); fi

echo "== GTFS-realtime decoder"
"$CXX" "${FLAGS[@]}" DecoderTest/decoder_test.cpp "$SRC/Transit/GtfsRtDecoder.cpp" -o "$OUT/decoder"
"$OUT/decoder" DecoderTest/sample_vehicle_positions.pb

echo "== Sun / moon / Budapest clock"
"$CXX" "${FLAGS[@]}" CoreTests/astro_test.cpp "$SRC/World/Astro.cpp" -o "$OUT/astro"
"$OUT/astro" CoreTests/astro_reference.csv

echo "== Baked city data reader + building mesher"
"$CXX" "${FLAGS[@]}" CoreTests/city_test.cpp "$SRC/City/BsbReader.cpp" "$SRC/City/BuildingMesher.cpp" -o "$OUT/city"
"$OUT/city" Districts/fixtures

echo "== District baker (Python)"
if python3 -c "import numpy, mapbox_earcut" 2>/dev/null; then
  (cd Districts && python3 -m unittest test_bake)
else
  echo "skipped: pip install -r Tools/Districts/requirements.txt"
fi
echo "All tests passed."
