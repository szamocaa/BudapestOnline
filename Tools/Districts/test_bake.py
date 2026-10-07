import json
import math
import pathlib
import struct
import unittest

import bake_district as baker
import make_fixtures as fx

FIXTURES = pathlib.Path(__file__).resolve().parent / "fixtures"


def read_buildings(path):
    """Independent reader (struct-based) used to cross-check the writer."""
    data = path.read_bytes()
    assert data[:4] == b"BSBB"
    version, count = struct.unpack_from("<II", data, 4)
    assert version == 1
    pos, out = 12, []
    for _ in range(count):
        osm_id, height, min_height, ring_count = struct.unpack_from("<QffI", data, pos)
        pos += 20
        rings = []
        for _ in range(ring_count):
            (n,) = struct.unpack_from("<I", data, pos)
            pos += 4
            rings.append([struct.unpack_from("<dd", data, pos + 16 * i) for i in range(n)])
            pos += 16 * n
        (index_count,) = struct.unpack_from("<I", data, pos)
        pos += 4
        indices = list(struct.unpack_from(f"<{index_count}I", data, pos))
        pos += 4 * index_count
        out.append(dict(osm_id=osm_id, height=height, min_height=min_height, rings=rings, indices=indices))
    assert pos == len(data), "trailing bytes"
    return out


def area_m2(ring):
    return abs(baker.signed_area(baker.to_local_meters(ring, fx.ORIGIN_LAT, fx.ORIGIN_LON)))


def roof_area_m2(building):
    flat = [p for ring in building["rings"] for p in ring]
    xy = baker.to_local_meters(flat, fx.ORIGIN_LAT, fx.ORIGIN_LON)
    total = 0.0
    for a, b, c in zip(building["indices"][0::3], building["indices"][1::3], building["indices"][2::3]):
        total += abs(0.5 * ((xy[b][0] - xy[a][0]) * (xy[c][1] - xy[a][1]) - (xy[b][1] - xy[a][1]) * (xy[c][0] - xy[a][0])))
    return total


class BuildingBake(unittest.TestCase):
    def setUp(self):
        self.baked, self.stats = baker.bake_buildings(fx.buildings_json()["elements"])
        self.by_id = {b["osm_id"]: b for b in self.baked}

    def test_which_buildings_survive(self):
        self.assertEqual(sorted(self.by_id), [1001, 1002, 1003, 2001])
        self.assertEqual(self.stats["skipped_tiny"], 1)

    def test_heights(self):
        self.assertAlmostEqual(self.by_id[1001]["height"], 16.0)       # 5 levels x 3.2
        self.assertAlmostEqual(self.by_id[1002]["height"], 12.5)       # explicit height
        self.assertAlmostEqual(self.by_id[2001]["height"], 19.2)       # relation tags, 6 levels
        self.assertAlmostEqual(self.by_id[1003]["height"], 40 * 0.3048)  # feet

    def test_concave_roof_is_fully_covered(self):
        b = self.by_id[1002]
        self.assertAlmostEqual(roof_area_m2(b), 500.0, delta=1.0)

    def test_courtyard_is_cut_out_and_split_ways_are_joined(self):
        b = self.by_id[2001]
        self.assertEqual(len(b["rings"]), 2)
        self.assertAlmostEqual(area_m2(b["rings"][0]), 2400.0, delta=2.0)
        self.assertAlmostEqual(area_m2(b["rings"][1]), 600.0, delta=2.0)
        self.assertAlmostEqual(roof_area_m2(b), 1800.0, delta=2.0)

    def test_binary_round_trip(self):
        path = FIXTURES / "sample_buildings.bsb"
        again = read_buildings(path)
        self.assertEqual([b["osm_id"] for b in again], [b["osm_id"] for b in self.baked])
        for mine, theirs in zip(self.baked, again):
            self.assertAlmostEqual(mine["height"], theirs["height"], places=5)
            self.assertEqual(mine["indices"], theirs["indices"])
            for ring_a, ring_b in zip(mine["rings"], theirs["rings"]):
                self.assertEqual([tuple(p) for p in ring_a], [tuple(p) for p in ring_b])


class HeightParsing(unittest.TestCase):
    def test_lengths(self):
        self.assertEqual(baker.parse_length_m("12"), 12.0)
        self.assertEqual(baker.parse_length_m("12,5 m"), 12.5)
        self.assertAlmostEqual(baker.parse_length_m("100 ft"), 30.48)
        self.assertAlmostEqual(baker.parse_length_m("40'"), 12.192)
        self.assertAlmostEqual(baker.parse_length_m("6'6\""), 1.9812)
        self.assertEqual(baker.parse_length_m("12m"), 12.0)
        self.assertIsNone(baker.parse_length_m("12abc"))
        self.assertIsNone(baker.parse_length_m("tall"))
        self.assertIsNone(baker.parse_length_m("0"))

    def test_defaults_and_min_height(self):
        self.assertEqual(baker.building_heights({"building": "yes"})[0], baker.DEFAULT_HEIGHT_M)
        self.assertEqual(baker.building_heights({"building": "garage"})[0], 3.5)
        height, min_height, _ = baker.building_heights({"building": "yes", "height": "10", "min_height": "12"})
        self.assertEqual(min_height, 0.0)  # impossible min height is ignored


class PathBake(unittest.TestCase):
    def test_graph(self):
        nodes, edges, stats = baker.bake_paths(fx.highways_json()["elements"])
        self.assertEqual(len(nodes), 7)
        self.assertEqual(len(edges), 6)
        self.assertEqual(stats["nodes_dropped_disconnected"], 2)  # the island
        self.assertEqual(sorted(k for _, _, k in edges), [0, 1, 1, 1, 1, 2])

    def test_junction_is_shared(self):
        nodes, edges, _ = baker.bake_paths(fx.highways_json()["elements"])
        degree = {}
        for a, b, _ in edges:
            degree[a] = degree.get(a, 0) + 1
            degree[b] = degree.get(b, 0) + 1
        self.assertEqual(max(degree.values()), 4)  # the crossroads where both streets meet

    def test_binary_layout(self):
        data = (FIXTURES / "sample_paths.bsb").read_bytes()
        self.assertEqual(data[:4], b"BSBP")
        node_count = struct.unpack_from("<I", data, 8)[0]
        edge_count = struct.unpack_from("<I", data, 12 + 16 * node_count)[0]
        self.assertEqual((node_count, edge_count), (7, 6))
        self.assertEqual(len(data), 16 + 16 * node_count + 12 * edge_count)


class RingAssembly(unittest.TestCase):
    def test_open_ring_discarded(self):
        self.assertEqual(baker.assemble_rings([[(0, 0), (0, 1), (1, 1)]]), [])

    def test_fragments_in_any_orientation(self):
        square = [(0, 0), (0, 1), (1, 1), (1, 0)]
        for pieces in (
            [[square[0], square[1], square[2]], [square[2], square[3], square[0]]],   # head-to-tail
            [[square[0], square[1], square[2]], [square[0], square[3], square[2]]],   # second reversed
            [[square[2], square[3], square[0]], [square[0], square[1], square[2]]],   # given in the other order
        ):
            rings = baker.assemble_rings(pieces)
            self.assertEqual(len(rings), 1)
            self.assertEqual(sorted(rings[0]), sorted(square))


if __name__ == "__main__":
    unittest.main()
