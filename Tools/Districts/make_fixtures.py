#!/usr/bin/env python3
"""Builds a small hand-made data set in the exact JSON shape Overpass's `out geom` returns, then
bakes it. Used by test_bake.py and by the C++ tests (Tools/CoreTests) to prove both sides agree.

Positions are given in metres (north, east) from an origin and converted to lat/lon.
"""
import json
import math
import pathlib

import bake_district as baker

HERE = pathlib.Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
ORIGIN_LAT, ORIGIN_LON = 47.4930, 19.0800


def ll(north, east):
    cos_lat = math.cos(math.radians(ORIGIN_LAT))
    return {"lat": ORIGIN_LAT + north / (baker.EARTH_RADIUS_M * math.radians(1)),
            "lon": ORIGIN_LON + east / (baker.EARTH_RADIUS_M * math.radians(1) * cos_lat)}


def geometry(points):
    return [ll(n, e) for n, e in points]


def closed(points):
    return list(points) + [points[0]]


RECT_A = [(0, 0), (0, 30), (20, 30), (20, 0)]                                  # 600 m2
L_SHAPE = [(100, 0), (100, 30), (110, 30), (110, 10), (130, 10), (130, 0)]    # 500 m2, concave
BLOCK_OUTER = [(200, 0), (200, 40), (260, 40), (260, 0)]                       # 2400 m2
COURTYARD = [(215, 10), (215, 30), (245, 30), (245, 10)]                       # 600 m2 hole
FEET_RECT = [(300, 0), (300, 10), (310, 10), (310, 0)]
TINY_SHED = [(400, 0), (400, 2), (402, 2), (402, 0)]                           # 4 m2 < minimum


def buildings_json():
    return {"elements": [
        {"type": "way", "id": 1001, "tags": {"building": "apartments", "building:levels": "5"},
         "geometry": geometry(closed(RECT_A))},
        {"type": "way", "id": 1002, "tags": {"building": "yes", "height": "12.5"},
         "geometry": geometry(closed(L_SHAPE))},
        {"type": "relation", "id": 2001, "tags": {"type": "multipolygon", "building": "yes", "building:levels": "6"},
         "members": [
             # Outer ring split over two ways, the second one running the opposite direction.
             {"type": "way", "ref": 3001, "role": "outer", "geometry": geometry([BLOCK_OUTER[0], BLOCK_OUTER[1], BLOCK_OUTER[2]])},
             {"type": "way", "ref": 3002, "role": "outer", "geometry": geometry([BLOCK_OUTER[0], BLOCK_OUTER[3], BLOCK_OUTER[2]])},
             {"type": "way", "ref": 3003, "role": "inner", "geometry": geometry(closed(COURTYARD))},
         ]},
        {"type": "way", "id": 1003, "tags": {"building": "yes", "height": "40'"}, "geometry": geometry(closed(FEET_RECT))},
        {"type": "way", "id": 1004, "tags": {"building": "shed"}, "geometry": geometry(closed(TINY_SHED))},
        {"type": "way", "id": 1005, "tags": {"building": "yes"}, "geometry": geometry([(500, 0), (500, 10), (510, 10)])},  # not closed
        {"type": "way", "id": 1006, "tags": {"amenity": "bench"}, "geometry": geometry(closed(RECT_A))},                  # not a building
    ]}


def highways_json():
    def way(way_id, tags, points):
        return {"type": "way", "id": way_id, "tags": tags, "geometry": geometry(points)}

    return {"elements": [
        way(1, {"highway": "residential"}, [(0, -50), (0, 0), (0, 50)]),
        way(2, {"highway": "residential"}, [(-50, 0), (0, 0), (50, 0)]),
        way(3, {"highway": "footway"}, [(0, 50), (30, 50)]),
        way(4, {"highway": "primary"}, [(50, 0), (50, 60)]),
        way(5, {"highway": "motorway"}, [(500, 500), (500, 600)]),                       # not walkable
        way(6, {"highway": "service", "service": "driveway"}, [(10, 10), (20, 10)]),     # skipped
        way(7, {"highway": "residential", "foot": "no"}, [(0, -50), (-30, -80)]),        # skipped
        way(8, {"highway": "footway"}, [(900, 900), (900, 950)]),                        # disconnected island
        {"type": "node", "id": 99, "lat": 47.0, "lon": 19.0},                            # ignored
    ]}


def main():
    FIXTURES.mkdir(exist_ok=True)
    (FIXTURES / "buildings.json").write_text(json.dumps(buildings_json(), indent=1))
    (FIXTURES / "highways.json").write_text(json.dumps(highways_json(), indent=1))
    baker.bake(FIXTURES, FIXTURES.parent / "fixtures_out")
    out = FIXTURES.parent / "fixtures_out"
    for name in ("district8_buildings.bsb", "district8_paths.bsb"):
        (FIXTURES / name.replace("district8", "sample")).write_bytes((out / name).read_bytes())
    for leftover in out.iterdir():
        leftover.unlink()
    out.rmdir()


if __name__ == "__main__":
    main()
