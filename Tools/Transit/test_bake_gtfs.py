"""Tests for bake_gtfs.py on the hand-made GTFS feed of make_fixtures.py.

    cd Tools/Transit && python3 -m unittest test_bake_gtfs
"""
import http.server
import math
import os
import pathlib
import re
import struct
import tempfile
import threading
import unittest
import zipfile

import bake_gtfs as baker
import make_fixtures as fx

HERE = pathlib.Path(__file__).resolve().parent
GEO_HEADER = HERE.parent.parent / "Source" / "BudapestSim" / "Transit" / "GeoProjection.h"


def read_transit(data):
    """Independent struct-based reader, used to cross-check the writer."""
    assert data[:4] == b"BSBT", data[:4]
    pos = 4

    def take(fmt):
        nonlocal pos
        values = struct.unpack_from("<" + fmt, data, pos)
        pos += struct.calcsize("<" + fmt)
        return values

    def text():
        nonlocal pos
        (length,) = take("H")
        value = data[pos:pos + length].decode("utf-8")
        pos += length
        return value

    version, route_count = take("II")
    assert version == 1
    routes = []
    for _ in range(route_count):
        route_id, short_name = text(), text()
        route_type, r, g, b, tr, tg, tb = take("H3B3B")
        routes.append(dict(id=route_id, short_name=short_name, route_type=route_type, color=(r, g, b), text_color=(tr, tg, tb)))
    (shape_count,) = take("I")
    shapes = []
    for _ in range(shape_count):
        route_index, point_count = take("II")
        shapes.append((route_index, [take("dd") for _ in range(point_count)]))
    (stop_count,) = take("I")
    stops = []
    for _ in range(stop_count):
        stop_id, name = text(), text()
        lat, lon, served = take("ddH")
        stops.append(dict(id=stop_id, name=name, lat=lat, lon=lon, routes=list(take(f"{served}I"))))
    assert pos == len(data), "trailing bytes"
    return routes, shapes, stops


def metres(point):
    lat, lon = point
    north = (lat - fx.ORIGIN_LAT) * math.radians(1) * fx.EARTH_RADIUS_M
    east = (lon - fx.ORIGIN_LON) * math.radians(1) * fx.EARTH_RADIUS_M * math.cos(math.radians(fx.ORIGIN_LAT))
    return round(north), round(east)


class Fixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.zip_path = pathlib.Path(cls.tmp.name) / "gtfs.zip"
        fx.write_zip(cls.zip_path)
        cls.routes, cls.shapes, cls.stops, cls.stats = baker.bake(cls.zip_path)
        cls.by_name = {route["short_name"]: i for i, route in enumerate(cls.routes)}

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def shapes_of(self, short_name):
        return [[metres(p) for p in points] for index, points in self.shapes if index == self.by_name[short_name]]


class RouteTypes(unittest.TestCase):
    def test_basic_and_extended_types(self):
        expected = {
            baker.TRAM: [0, 900, 903, 906], baker.METRO: [1, 400, 401, 404],
            baker.SUBURBAN_RAIL: [2, 100, 109, 117], baker.BUS: [3, 200, 209, 700, 704, 715, 716],
            baker.TROLLEYBUS: [11, 800], baker.FERRY: [4, 1000, 1200],
            baker.UNKNOWN: [5, 6, 7, 12, 99, 118, 210, 405, 717, 801, 907, 1100, 1400, 65535],
        }
        for mode, types in expected.items():
            for route_type in types:
                self.assertEqual(baker.mode_for_route_type(route_type), mode, route_type)

    def test_cpp_mapping_matches(self):
        # The C++ reader carries the same table; make sure nobody edits just one of them.
        source = (HERE.parent.parent / "Source" / "BudapestSim" / "Transit" / "GtfsStaticReader.cpp").read_text()
        for needle in ("900", "906", "400", "404", "100", "117", "200", "209", "700", "716", "800", "1000", "1200"):
            self.assertIn(needle, source)

    def test_default_colours(self):
        colour = lambda route_type, name: baker.route_colors(route_type, name, "", "")
        self.assertEqual(colour(0, "4"), ((0xFF, 0xD8, 0x00), (0, 0, 0)))
        self.assertEqual(colour(900, "6")[0], (0xFF, 0xD8, 0x00))
        self.assertEqual(colour(3, "9"), ((0x00, 0x9F, 0xE3), (255, 255, 255)))
        self.assertEqual(colour(3, "914")[0], (0x1E, 0x1E, 0x1E))   # night bus
        self.assertEqual(colour(11, "83")[0], (0xFF, 0x16, 0x09))
        self.assertEqual(colour(1, "M1"), ((0xFF, 0xD8, 0x00), (0, 0, 0)))
        self.assertEqual(colour(1, "M2")[0], (0xE4, 0x1F, 0x18))
        self.assertEqual(colour(401, "M3")[0], (0x00, 0x5C, 0xA5))
        self.assertEqual(colour(1, "M4")[0], (0x4C, 0xA2, 0x2F))
        self.assertEqual(colour(109, "H5")[0], (0x82, 0x10, 0x66))
        self.assertEqual(colour(2, "H99")[0], (0x00, 0x8D, 0x3D))

    def test_given_colours_win_and_bad_ones_are_ignored(self):
        self.assertEqual(baker.route_colors(3, "9", "#a0b0c0", "010203"), ((0xA0, 0xB0, 0xC0), (1, 2, 3)))
        self.assertEqual(baker.route_colors(0, "4", "FFD8", "zzzzzz"), ((0xFF, 0xD8, 0x00), (0, 0, 0)))


class Geometry(unittest.TestCase):
    BOX = (0.0, 0.0, 1.0, 1.0)

    def test_box_matches_geo_projection_header(self):
        header = GEO_HEADER.read_text()
        for name, value in (("MinLatitude", baker.DISTRICT_MIN_LAT), ("MaxLatitude", baker.DISTRICT_MAX_LAT),
                            ("MinLongitude", baker.DISTRICT_MIN_LON), ("MaxLongitude", baker.DISTRICT_MAX_LON)):
            match = re.search(rf"{name}\s*=\s*([0-9.]+)", header)
            self.assertIsNotNone(match, name)
            self.assertEqual(float(match.group(1)), value, name)

    def test_segment_box(self):
        touches = lambda a, b: baker.segment_touches_box(a, b, self.BOX)
        self.assertTrue(touches((0.5, 0.5), (0.6, 0.6)))
        self.assertTrue(touches((-1, 0.5), (2, 0.5)))       # passes straight through
        self.assertTrue(touches((-1, -1), (2, 2)))          # diagonal through
        self.assertTrue(touches((-1, 1), (1, -1)))          # grazes a corner
        self.assertFalse(touches((-1, 1.5), (1.5, 3)))
        self.assertFalse(touches((2, 0), (2, 1)))           # parallel, outside
        self.assertTrue(touches((1, 0.2), (1, 0.3)))        # on the edge

    def test_clip_keeps_one_point_outside_per_cut(self):
        line = [(-2, 0.5), (-1, 0.5), (0.5, 0.5), (2, 0.5), (3, 0.5)]
        self.assertEqual(baker.clip_to_box(line, self.BOX), [[(-1, 0.5), (0.5, 0.5), (2, 0.5)]])

    def test_clip_splits_and_drops(self):
        line = [(0.5, 2), (0.5, 0.5), (0.6, 2), (0.7, 3), (0.8, 2), (0.8, 0.5)]
        self.assertEqual(baker.clip_to_box(line, self.BOX), [[(0.5, 2), (0.5, 0.5), (0.6, 2)], [(0.8, 2), (0.8, 0.5)]])
        self.assertEqual(baker.clip_to_box([(5, 5), (6, 6)], self.BOX), [])
        self.assertEqual(baker.clip_to_box([(0.5, 0.5)], self.BOX), [])

    def test_drop_repeats(self):
        self.assertEqual(baker.drop_repeats([(1, 1), (1, 1), (2, 2), (1, 1)]), [(1, 1), (2, 2), (1, 1)])


class Bake(Fixture):
    def test_routes_kept_and_sorted(self):
        self.assertEqual([route["short_name"] for route in self.routes], ["4", "6", "28", "M4", "83", "9", "282E", "990", "M3 pótló"])
        self.assertEqual(self.stats["routes_in_feed"], 11)
        route_four = self.routes[self.by_name["4"]]
        self.assertEqual((route_four["id"], route_four["route_type"]), ("3040", 0))

    def test_route_colours_and_types(self):
        by = lambda name: self.routes[self.by_name[name]]
        self.assertEqual((by("6")["route_type"], by("6")["color"], by("6")["text_color"]), (900, (255, 216, 0), (0, 0, 0)))
        self.assertEqual(by("28")["color"], (255, 216, 0))
        self.assertEqual(by("282E")["route_type"], 715)
        self.assertEqual(by("282E")["color"], (0x00, 0x9F, 0xE3))
        self.assertEqual(by("990")["color"], (0x1E, 0x1E, 0x1E))
        self.assertEqual(by("83")["text_color"], (255, 255, 255))

    def test_tram_shapes_clipped_and_deduplicated(self):
        north = [(n, -1000) for n in range(-2000, 2001, 500)]
        self.assertEqual(sorted(self.shapes_of("4")), sorted([north, list(reversed(north))]))  # variant deduplicated
        self.assertEqual(self.shapes_of("6"), [north])                                       # shared shape: own copy

    def test_shape_entering_twice(self):
        self.assertEqual(sorted(self.shapes_of("28")),
                         sorted([[(0, 3000), (0, 1800), (0, 1000), (300, 2600)], [(600, 3000), (600, 1500), (600, 3500)]]))

    def test_crossing_segment_without_inside_points(self):
        self.assertEqual(self.shapes_of("9"), [[(-2600, -2600), (2600, 2600)]])

    def test_far_routes_dropped(self):
        self.assertNotIn("200E", self.by_name)
        self.assertNotIn("H5", self.by_name)
        self.assertEqual(self.stats["shapes"], 10)
        self.assertEqual(self.shapes_of("M3 pótló"), [])

    def test_stops(self):
        names = {stop["id"]: stop for stop in self.stops}
        self.assertEqual(sorted(names), ["F01000", "F01001", "F01002", "F01003"])
        self.assertEqual(names["F01001"]["name"], 'Corvin-negyed M, "Kisfaludy" köz')
        served = lambda stop_id: sorted(self.routes[i]["short_name"] for i in names[stop_id]["routes"])
        self.assertEqual(served("F01000"), ["4", "6", "9"])
        self.assertEqual(served("F01002"), ["83", "M3 pótló"])
        self.assertEqual(served("F01003"), ["83"])  # the trip of an unknown route does not count
        self.assertEqual(self.stats["unused_stops_dropped"], 1)
        self.assertEqual(metres((names["F01000"]["lat"], names["F01000"]["lon"])), (0, -1000))

    def test_without_stop_times(self):
        routes, _, stops, stats = baker.bake(self.zip_path, use_stop_times=False)
        self.assertFalse(stats["used_stop_times"])
        self.assertEqual(len(stops), 5)  # the unused stop stays: nothing says it is unused
        self.assertTrue(all(stop["routes"] == [] for stop in stops))
        self.assertNotIn("M3 pótló", [route["short_name"] for route in routes])

    def test_binary_round_trip(self):
        data = baker.encode_transit(self.routes, self.shapes, self.stops)
        routes, shapes, stops = read_transit(data)
        self.assertEqual([(r["id"], r["short_name"], r["route_type"], r["color"], r["text_color"]) for r in routes],
                         [(r["id"], r["short_name"], r["route_type"], r["color"], r["text_color"]) for r in self.routes])
        self.assertEqual(shapes, [(index, list(points)) for index, points in self.shapes])
        self.assertEqual([(s["id"], s["name"], s["lat"], s["lon"], s["routes"]) for s in stops],
                         [(s["id"], s["name"], s["lat"], s["lon"], s["routes"]) for s in self.stops])

    def test_committed_fixture_is_up_to_date(self):
        self.assertEqual(fx.BSB_PATH.read_bytes(), baker.encode_transit(self.routes, self.shapes, self.stops),
                         "run: python3 Tools/Transit/make_fixtures.py")
        with zipfile.ZipFile(fx.ZIP_PATH) as committed, zipfile.ZipFile(self.zip_path) as fresh:
            for name in fresh.namelist():
                self.assertEqual(committed.read(name), fresh.read(name), name)

    def test_shapes_streamed_selectively(self):
        self.assertEqual(self.stats["shapes_near"], 9)  # the two far-away shapes were never loaded

    def test_long_strings_are_capped(self):
        packed = baker.pack_str("é" * 40000)
        (length,) = struct.unpack_from("<H", packed)
        self.assertLessEqual(length, 0xFFFF)
        packed[2:].decode("utf-8")  # still valid UTF-8

    def test_feed_in_a_subfolder_and_missing_optional_columns(self):
        path = pathlib.Path(self.tmp.name) / "nested.zip"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("gtfs/routes.txt", "route_id,route_type\nR1,0\n")
            archive.writestr("gtfs/trips.txt", "route_id,trip_id\nR1,t1\n")
            archive.writestr("gtfs/stops.txt", "stop_id,stop_lat,stop_lon\nS1,47.49,19.08\nS2,,\n")
        routes, shapes, stops, stats = baker.bake(path)
        self.assertEqual((len(routes), len(shapes), [s["id"] for s in stops]), (0, 0, ["S1"]))
        self.assertFalse(stats["used_stop_times"])

    def test_not_a_zip(self):
        path = pathlib.Path(self.tmp.name) / "error.zip"
        path.write_text('{"code": 401, "text": "Unauthorized"}')
        with self.assertRaises(SystemExit):
            baker.bake(path)

    def test_command_line_with_local_zip(self):
        out = pathlib.Path(self.tmp.name) / "out" / "transit.bsb"
        self.assertEqual(baker.main(["--zip", str(self.zip_path), "--out", str(out)]), 0)
        self.assertEqual(out.read_bytes(), fx.BSB_PATH.read_bytes())


class Download(unittest.TestCase):
    def test_key_resolution_order(self):
        with tempfile.TemporaryDirectory() as project:
            self.assertEqual(baker.resolve_key(None, {}, project), "")
            (pathlib.Path(project) / "BkkApiKey.txt").write_text("﻿file-key \n")
            self.assertEqual(baker.resolve_key(None, {}, project), "file-key")
            self.assertEqual(baker.resolve_key(None, {"BKK_API_KEY": " env-key "}, project), "env-key")
            self.assertEqual(baker.resolve_key("cli-key", {"BKK_API_KEY": "env-key"}, project), "cli-key")

    def test_url_with_key(self):
        self.assertEqual(baker.url_with_key("https://x/a.zip", "k y"), "https://x/a.zip?key=k+y")
        self.assertEqual(baker.url_with_key("https://x/a.zip?v=1&key=old", "new"), "https://x/a.zip?v=1&key=new")
        self.assertEqual(baker.redact("https://x/a.zip?key=k%2By&key=k+y", "k+y"), "https://x/a.zip?key=<key>&key=<key>")

    def serve(self, needs_key):
        payload = fx.ZIP_PATH.read_bytes()
        seen = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(self.path)
                if needs_key and "key=secret" not in self.path:
                    self.send_response(401)
                    self.end_headers()
                    self.wfile.write(b'{"status":"UNAUTHORIZED"}')
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_port}/budapest_gtfs.zip", seen

    def test_public_download_needs_no_key(self):
        url, seen = self.serve(needs_key=False)
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "g.zip"
            self.assertEqual(baker.download(url, "secret", target, timeout=10, log=lambda *_: None), "without a key")
            self.assertEqual(target.read_bytes(), fx.ZIP_PATH.read_bytes())
        self.assertEqual(seen, ["/budapest_gtfs.zip"])

    def test_retries_with_key_and_never_logs_it(self):
        url, seen = self.serve(needs_key=True)
        lines = []
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "g.zip"
            self.assertEqual(baker.download(url, "secret", target, timeout=10, log=lines.append), "with your API key")
            self.assertTrue(zipfile.is_zipfile(target))
        self.assertEqual(seen, ["/budapest_gtfs.zip", "/budapest_gtfs.zip?key=secret"])
        self.assertFalse(any("secret" in line for line in lines), lines)

    def test_gives_up_with_a_helpful_message(self):
        url, _ = self.serve(needs_key=True)
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(SystemExit) as raised:
                baker.download(url, "", pathlib.Path(tmp) / "g.zip", timeout=10, log=lambda *_: None)
        self.assertIn("HTTP 401", str(raised.exception))
        self.assertIn("BKK_API_KEY", str(raised.exception))

    def test_command_line_download_end_to_end(self):
        url, _ = self.serve(needs_key=True)
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / "transit.bsb"
            saved = pathlib.Path(tmp) / "keep" / "gtfs.zip"
            old = os.environ.get("BKK_API_KEY")
            os.environ["BKK_API_KEY"] = "secret"
            try:
                self.assertEqual(baker.main(["--url", url, "--out", str(out), "--save-zip", str(saved)]), 0)
            finally:
                if old is None:
                    del os.environ["BKK_API_KEY"]
                else:
                    os.environ["BKK_API_KEY"] = old
            self.assertEqual(out.read_bytes(), fx.BSB_PATH.read_bytes())
            self.assertTrue(saved.is_file())


if __name__ == "__main__":
    unittest.main()
