#!/usr/bin/env bash
# Builds and runs the GTFS-realtime decoder test with strict warnings and sanitizers. No Unreal needed.
set -euo pipefail
cd "$(dirname "$0")"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
${CXX:-g++} -std=c++17 -O1 -g -I../../Source/BudapestSim -Wall -Wextra -Wshadow -Wconversion -Werror \
  -fsanitize=address,undefined -fno-sanitize-recover=undefined \
  decoder_test.cpp ../../Source/BudapestSim/Transit/GtfsRtDecoder.cpp -o "$OUT/decoder_test"
"$OUT/decoder_test" sample_vehicle_positions.pb
