#!/usr/bin/env python3
"""Bakes BKK's static GTFS timetable data (lines, the shapes they run along, stops) for Budapest's
VIII. district into the compact binary file the Unreal project loads at runtime:

    Content/Data/district8_transit.bsb      (read by ATransitNetwork, Source/BudapestSim/Transit)

    python3 Tools/Transit/bake_gtfs.py                         # download BKK's GTFS zip and bake
    python3 Tools/Transit/bake_gtfs.py --zip budapest_gtfs.zip # bake a zip you downloaded yourself
    python3 Tools/Transit/bake_gtfs.py --save-zip gtfs.zip     # also keep the downloaded zip

Only the Python standard library is needed. The download is tried without an API key first and,
if BKK refuses it, again with ?key=... taken from --key, the BKK_API_KEY environment variable or the
file BkkApiKey.txt in the project folder (the same key the game uses for live vehicle positions).

What is kept (box = the VIII. district box of GeoProjection.h, padded by --margin degrees):
  - shapes (shapes.txt) with a segment inside the box, cut to the box; each piece keeps one point
    outside the box at every cut so lines run on past the edge; identical pieces of the same route
    are stored once
  - routes that own a kept shape or stop at a kept stop
  - stops (location_type 0 or empty) inside the box; with stop_times.txt (default) each stop also
    lists the routes that serve it, and stops nothing serves are dropped

File layout (all little-endian; "str" = u16 byte length + UTF-8 bytes, no terminator):

    char[4] "BSBT", u32 version (= 1)
    u32 routeCount
      per route: str id, str shortName, u16 routeType, u8[3] colour RGB, u8[3] text colour RGB
    u32 shapeCount
      per shape: u32 routeIndex, u32 pointCount (>= 2), pointCount x (f64 lat, f64 lon)
    u32 stopCount
      per stop: str id, str name, f64 lat, f64 lon, u16 routeCount, routeCount x u32 routeIndex

routeType is GTFS route_type (basic or extended; 65535 if missing/invalid). Colours are always
present: missing or invalid route_color / route_text_color get BKK's colours for the mode.
The reader is Source/BudapestSim/Transit/GtfsStaticReader.cpp.

Data: BKK open data (https://opendata.bkk.hu). Follow the terms you accepted for it.
"""
import argparse
import codecs
import csv
import io
import os
import pathlib
import re
import struct
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
PROJECT = HERE.parent.parent
DEFAULT_OUT = PROJECT / "Content" / "Data" / "district8_transit.bsb"
DEFAULT_URL = "https://go.bkk.hu/api/static/v1/public-gtfs/budapest_gtfs.zip"
KEY_FILE_NAME = "BkkApiKey.txt"
USER_AGENT = "budapest-sim-gtfs-baker/0.1 (hobby Unreal Engine project)"

FORMAT_MAGIC = b"BSBT"
FORMAT_VERSION = 1
MISSING_ROUTE_TYPE = 0xFFFF

# Must match BudapestGeo::DistrictVIII in Source/BudapestSim/Transit/GeoProjection.h (a test checks it).
DISTRICT_MIN_LAT = 47.4780
DISTRICT_MAX_LAT = 47.5060
DISTRICT_MIN_LON = 19.0540
DISTRICT_MAX_LON = 19.1060
DEFAULT_MARGIN_DEG = 0.003
# First pass over shapes.txt: shapes with no point within this much of the padded box are never
# loaded. A shape segment would have to be longer than ~1.5 km to cross the box without one.
NEAR_MARGIN_DEG = 0.02

# ----------------------------------------------------------------------------- route types and colours

TRAM, METRO, BUS, TROLLEYBUS, SUBURBAN_RAIL, FERRY, UNKNOWN = (
    "tram", "metro", "bus", "trolleybus", "suburban_rail", "ferry", "unknown")
MODE_SORT_ORDER = {TRAM: 0, METRO: 1, SUBURBAN_RAIL: 2, TROLLEYBUS: 3, BUS: 4, FERRY: 5, UNKNOWN: 6}


def mode_for_route_type(route_type):
    """GTFS route_type (basic or extended) -> mode. Mirrors GtfsStatic::ModeForRouteType in C++."""
    t = route_type
    if t == 0 or 900 <= t <= 906:
        return TRAM
    if t == 1 or 400 <= t <= 404:
        return METRO
    if t == 2 or 100 <= t <= 117:
        return SUBURBAN_RAIL
    if t == 3 or 200 <= t <= 209 or 700 <= t <= 716:
        return BUS
    if t in (11, 800):
        return TROLLEYBUS
    if t in (4, 1000, 1200):
        return FERRY
    return UNKNOWN


# BKK's own colours, used when routes.txt has none for a route.
METRO_COLORS = {"M1": "FFD800", "M2": "E41F18", "M3": "005CA5", "M4": "4CA22F"}
SUBURBAN_COLORS = {"H5": "821066", "H6": "884200", "H7": "EE7203", "H8": "ED677E", "H9": "ED677E"}
MODE_COLORS = {TRAM: "FFD800", METRO: "6E6E6E", SUBURBAN_RAIL: "008D3D", TROLLEYBUS: "FF1609",
               BUS: "009FE3", FERRY: "E50475", UNKNOWN: "7F7F7F"}
NIGHT_BUS_COLOR = "1E1E1E"


def parse_hex_color(text):
    """'FFD800' or '#ffd800' -> (255, 216, 0); None if missing or malformed."""
    value = (text or "").strip().lstrip("#")
    if not re.fullmatch(r"[0-9A-Fa-f]{6}", value):
        return None
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


def default_route_color(mode, short_name):
    name = (short_name or "").strip().upper()
    if mode == METRO and name in METRO_COLORS:
        return parse_hex_color(METRO_COLORS[name])
    if mode == SUBURBAN_RAIL and name in SUBURBAN_COLORS:
        return parse_hex_color(SUBURBAN_COLORS[name])
    if mode == BUS and re.fullmatch(r"9\d\d[A-Z]?", name):
        return parse_hex_color(NIGHT_BUS_COLOR)  # BKK night buses are numbered 9xx
    return parse_hex_color(MODE_COLORS[mode])


def readable_text_color(rgb):
    """Black on light backgrounds (e.g. tram yellow), white on dark ones."""
    r, g, b = rgb
    return (0, 0, 0) if 0.299 * r + 0.587 * g + 0.114 * b > 150 else (255, 255, 255)


def route_colors(route_type, short_name, color_text, text_color_text):
    color = parse_hex_color(color_text) or default_route_color(mode_for_route_type(route_type), short_name)
    text_color = parse_hex_color(text_color_text) or readable_text_color(color)
    return color, text_color


def natural_key(text):
    return [(0, int(part), "") if part.isdigit() else (1, 0, part) for part in re.split(r"(\d+)", text or "") if part]


# ----------------------------------------------------------------------------- GTFS (csv in a zip) reading

class Gtfs:
    """A GTFS zip. Files may sit at the root of the zip or inside one folder."""

    def __init__(self, path):
        self.path = pathlib.Path(path)
        if not zipfile.is_zipfile(self.path):
            raise SystemExit(f"{self.path} is not a zip file (a GTFS feed is a .zip of .txt files)")
        self.zip = zipfile.ZipFile(self.path)
        self.members = {}
        for name in self.zip.namelist():
            base = name.rsplit("/", 1)[-1]
            if base.endswith(".txt") and base not in self.members:
                self.members[base] = name

    def close(self):
        self.zip.close()

    def has(self, name):
        return name in self.members

    def rows(self, name, required, optional=()):
        """Streams one file. Yields (row, column) where column(name) -> stripped value or ''."""
        if name not in self.members:
            raise SystemExit(f"{self.path} has no {name}; is it a GTFS feed?")
        with self.zip.open(self.members[name]) as raw:
            text = io.TextIOWrapper(raw, encoding="utf-8-sig", errors="replace", newline="")
            reader = csv.reader(text)
            header = next(reader, None)
            if header is None:
                return
            index = {column.strip().lstrip(codecs.BOM_UTF8.decode()): i for i, column in enumerate(header)}
            missing = [column for column in required if column not in index]
            if missing:
                raise SystemExit(f"{name} lacks required column(s) {', '.join(missing)}")
            wanted = {column: index.get(column) for column in list(required) + list(optional)}
            for row in reader:
                if not row or (len(row) == 1 and not row[0].strip()):
                    continue  # blank line
                yield row, wanted

    @staticmethod
    def value(row, wanted, column):
        i = wanted.get(column)
        return row[i].strip() if i is not None and i < len(row) else ""


def parse_int(text, default=None):
    try:
        return int(text.strip())
    except (ValueError, AttributeError):
        try:
            return int(float(text))
        except (ValueError, TypeError):
            return default


def parse_float(text):
    try:
        value = float(text)
    except (ValueError, TypeError):
        return None
    return value if value == value and abs(value) != float("inf") else None


# ----------------------------------------------------------------------------- geometry

def padded_box(margin):
    return (DISTRICT_MIN_LAT - margin, DISTRICT_MIN_LON - margin, DISTRICT_MAX_LAT + margin, DISTRICT_MAX_LON + margin)


def in_box(lat, lon, box):
    return box[0] <= lat <= box[2] and box[1] <= lon <= box[3]


def segment_touches_box(a, b, box):
    """Liang-Barsky: does segment a-b (lat, lon) touch the box at all?"""
    t0, t1 = 0.0, 1.0
    for p0, d, low, high in ((a[0], b[0] - a[0], box[0], box[2]), (a[1], b[1] - a[1], box[1], box[3])):
        if d == 0.0:
            if p0 < low or p0 > high:
                return False
            continue
        ta, tb = (low - p0) / d, (high - p0) / d
        if ta > tb:
            ta, tb = tb, ta
        t0, t1 = max(t0, ta), min(t1, tb)
        if t0 > t1:
            return False
    return True


def drop_repeats(points):
    out = []
    for point in points:
        if not out or point != out[-1]:
            out.append(point)
    return out


def clip_to_box(points, box):
    """Maximal runs of consecutive segments that touch the box. Each run keeps its end points, so a
    piece that was cut starts/ends with one point outside the box."""
    pieces, current = [], []
    for a, b in zip(points, points[1:]):
        if segment_touches_box(a, b, box):
            if not current:
                current = [a]
            current.append(b)
        elif current:
            pieces.append(current)
            current = []
    if current:
        pieces.append(current)
    return pieces


# ----------------------------------------------------------------------------- baking

def load_routes(gtfs):
    routes = {}
    for row, cols in gtfs.rows("routes.txt", ["route_id"],
                               ["route_short_name", "route_long_name", "route_type", "route_color", "route_text_color"]):
        route_id = Gtfs.value(row, cols, "route_id")
        if not route_id:
            continue
        route_type = parse_int(Gtfs.value(row, cols, "route_type"), MISSING_ROUTE_TYPE)
        if not 0 <= route_type < MISSING_ROUTE_TYPE:
            route_type = MISSING_ROUTE_TYPE
        short_name = Gtfs.value(row, cols, "route_short_name") or Gtfs.value(row, cols, "route_long_name") or route_id
        color, text_color = route_colors(route_type, short_name, Gtfs.value(row, cols, "route_color"),
                                         Gtfs.value(row, cols, "route_text_color"))
        routes[route_id] = {"id": route_id, "short_name": short_name, "route_type": route_type,
                            "mode": mode_for_route_type(route_type), "color": color, "text_color": text_color}
    return routes


def load_trips(gtfs, routes):
    """-> ({shape_id: set(route_id)}, {trip_id: route_id}) for trips of known routes."""
    shape_routes, trip_routes = {}, {}
    for row, cols in gtfs.rows("trips.txt", ["route_id", "trip_id"], ["shape_id"]):
        route_id = Gtfs.value(row, cols, "route_id")
        if route_id not in routes:
            continue
        trip_routes[Gtfs.value(row, cols, "trip_id")] = route_id
        shape_id = Gtfs.value(row, cols, "shape_id")
        if shape_id:
            shape_routes.setdefault(shape_id, set()).add(route_id)
    return shape_routes, trip_routes


def load_shapes(gtfs, wanted_ids, near_box):
    """Two streaming passes over shapes.txt (it is large and need not be sorted): find the shapes that
    come near the district, then load only their points. -> {shape_id: [(lat, lon), ...]} in sequence order."""
    columns = ["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"]
    near = set()
    for row, cols in gtfs.rows("shapes.txt", columns):
        shape_id = Gtfs.value(row, cols, "shape_id")
        if shape_id in near or shape_id not in wanted_ids:
            continue
        lat, lon = parse_float(Gtfs.value(row, cols, "shape_pt_lat")), parse_float(Gtfs.value(row, cols, "shape_pt_lon"))
        if lat is not None and lon is not None and in_box(lat, lon, near_box):
            near.add(shape_id)

    raw = {shape_id: [] for shape_id in near}
    for row, cols in gtfs.rows("shapes.txt", columns):
        points = raw.get(Gtfs.value(row, cols, "shape_id"))
        if points is None:
            continue
        lat, lon = parse_float(Gtfs.value(row, cols, "shape_pt_lat")), parse_float(Gtfs.value(row, cols, "shape_pt_lon"))
        sequence = parse_int(Gtfs.value(row, cols, "shape_pt_sequence"))
        if lat is not None and lon is not None and sequence is not None:
            points.append((sequence, lat, lon))
    return {shape_id: drop_repeats([(lat, lon) for _, lat, lon in sorted(points, key=lambda p: p[0])])
            for shape_id, points in raw.items()}


def load_stops(gtfs, box):
    stops = {}
    for row, cols in gtfs.rows("stops.txt", ["stop_id"], ["stop_name", "stop_lat", "stop_lon", "location_type"]):
        if Gtfs.value(row, cols, "location_type") not in ("", "0"):
            continue  # stations, entrances, generic nodes, boarding areas
        lat, lon = parse_float(Gtfs.value(row, cols, "stop_lat")), parse_float(Gtfs.value(row, cols, "stop_lon"))
        stop_id = Gtfs.value(row, cols, "stop_id")
        if stop_id and lat is not None and lon is not None and in_box(lat, lon, box):
            stops[stop_id] = {"id": stop_id, "name": Gtfs.value(row, cols, "stop_name"), "lat": lat, "lon": lon, "routes": set()}
    return stops


def add_stop_routes(gtfs, stops, trip_routes):
    """One streaming pass over stop_times.txt (the biggest file) to learn which routes serve each stop."""
    for row, cols in gtfs.rows("stop_times.txt", ["trip_id", "stop_id"]):
        stop = stops.get(Gtfs.value(row, cols, "stop_id"))
        if stop is not None:
            route_id = trip_routes.get(Gtfs.value(row, cols, "trip_id"))
            if route_id is not None:
                stop["routes"].add(route_id)


def bake(zip_path, margin=DEFAULT_MARGIN_DEG, use_stop_times=True):
    """-> (routes, shapes, stops, stats), ready for write_transit. Routes are sorted by mode and line
    number; shapes refer to routes by index; output is deterministic."""
    box = padded_box(margin)
    near_box = padded_box(margin + NEAR_MARGIN_DEG)
    gtfs = Gtfs(zip_path)
    try:
        all_routes = load_routes(gtfs)
        shape_routes, trip_routes = load_trips(gtfs, all_routes)
        shape_points = load_shapes(gtfs, set(shape_routes), near_box) if gtfs.has("shapes.txt") else {}
        stops = load_stops(gtfs, box)
        read_stop_times = use_stop_times and gtfs.has("stop_times.txt")
        if read_stop_times:
            add_stop_routes(gtfs, stops, trip_routes)
    finally:
        gtfs.close()

    pieces = set()  # (route_id, tuple of points) - identical pieces of one route are kept once
    for shape_id, points in shape_points.items():
        for piece in clip_to_box(points, box):
            for route_id in shape_routes[shape_id]:
                pieces.add((route_id, tuple(piece)))

    unused_stops = 0
    if read_stop_times:
        for stop_id in [stop_id for stop_id, stop in stops.items() if not stop["routes"]]:
            del stops[stop_id]
            unused_stops += 1

    kept_ids = {route_id for route_id, _ in pieces} | {route_id for stop in stops.values() for route_id in stop["routes"]}
    routes = sorted((all_routes[route_id] for route_id in kept_ids),
                    key=lambda r: (MODE_SORT_ORDER[r["mode"]], natural_key(r["short_name"]), r["id"]))
    route_index = {route["id"]: i for i, route in enumerate(routes)}

    shapes = sorted(((route_index[route_id], list(points)) for route_id, points in pieces), key=lambda s: (s[0], s[1]))
    stop_list = []
    for stop in sorted(stops.values(), key=lambda s: s["id"]):
        stop_list.append(dict(stop, routes=sorted(route_index[route_id] for route_id in stop["routes"])))

    stats = {
        "routes": len(routes),
        "routes_by_mode": {mode: sum(1 for r in routes if r["mode"] == mode) for mode in MODE_SORT_ORDER if any(r["mode"] == mode for r in routes)},
        "routes_in_feed": len(all_routes),
        "shapes_near": len(shape_points),
        "shapes": len(shapes),
        "points": sum(len(points) for _, points in shapes),
        "stops": len(stop_list),
        "unused_stops_dropped": unused_stops,
        "used_stop_times": read_stop_times,
    }
    return routes, shapes, stop_list, stats


# ----------------------------------------------------------------------------- writing

def pack_str(text):
    data = text.encode("utf-8")
    if len(data) > 0xFFFF:
        data = data[:0xFFFF].decode("utf-8", errors="ignore").encode("utf-8")
    return struct.pack("<H", len(data)) + data


def encode_transit(routes, shapes, stops):
    out = bytearray(FORMAT_MAGIC + struct.pack("<II", FORMAT_VERSION, len(routes)))
    for route in routes:
        out += pack_str(route["id"]) + pack_str(route["short_name"])
        out += struct.pack("<H3B3B", route["route_type"], *route["color"], *route["text_color"])
    out += struct.pack("<I", len(shapes))
    for route_index, points in shapes:
        out += struct.pack("<II", route_index, len(points))
        for lat, lon in points:
            out += struct.pack("<dd", lat, lon)
    out += struct.pack("<I", len(stops))
    for stop in stops:
        out += pack_str(stop["id"]) + pack_str(stop["name"]) + struct.pack("<ddH", stop["lat"], stop["lon"], len(stop["routes"]))
        out += struct.pack(f"<{len(stop['routes'])}I", *stop["routes"])
    return bytes(out)


def write_transit(path, routes, shapes, stops):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = encode_transit(routes, shapes, stops)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_bytes(data)
    os.replace(temporary, path)  # never leave a half-written file for the game to choke on
    return len(data)


# ----------------------------------------------------------------------------- downloading

def resolve_key(cli_key, environ=None, project=PROJECT):
    """--key, then BKK_API_KEY, then <project>/BkkApiKey.txt. '' if none."""
    environ = os.environ if environ is None else environ
    for candidate in (cli_key, environ.get("BKK_API_KEY")):
        if candidate and candidate.strip():
            return candidate.strip()
    key_file = pathlib.Path(project) / KEY_FILE_NAME
    if key_file.is_file():
        return key_file.read_text(encoding="utf-8-sig", errors="replace").strip()
    return ""


def url_with_key(url, key):
    parts = urllib.parse.urlsplit(url)
    query = [(k, v) for k, v in urllib.parse.parse_qsl(parts.query, keep_blank_values=True) if k != "key"]
    query.append(("key", key))
    return urllib.parse.urlunsplit(parts._replace(query=urllib.parse.urlencode(query)))


def redact(text, key):
    return text.replace(key, "<key>").replace(urllib.parse.quote(key, safe=""), "<key>") if key else text


def fetch_to(url, destination, timeout=300):
    """Streams url to destination. Raises urllib errors; returns the byte count."""
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    total = 0
    with urllib.request.urlopen(request, timeout=timeout) as response, open(destination, "wb") as out:
        while True:
            chunk = response.read(1 << 20)
            if not chunk:
                break
            out.write(chunk)
            total += len(chunk)
    return total


def download(url, key, destination, timeout=300, log=print):
    """Tries the URL as is, then (if a key is known) with ?key=. Returns the attempt that worked."""
    attempts = [("without a key", url)]
    if key:
        attempts.append(("with your API key", url_with_key(url, key)))
    problems = []
    for label, attempt in attempts:
        log(f"Downloading {redact(attempt, key)} ({label}) ...")
        try:
            size = fetch_to(attempt, destination, timeout)
        except urllib.error.HTTPError as error:
            problems.append(f"{label}: HTTP {error.code}")
            log(f"  HTTP {error.code}")
            continue
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            problems.append(f"{label}: {redact(str(error), key)}")
            log(f"  failed: {redact(str(error), key)}")
            continue
        if zipfile.is_zipfile(destination):
            log(f"  {size / 1e6:.1f} MB")
            return label
        problems.append(f"{label}: the response ({size} bytes) is not a zip")
        log("  the response is not a zip file")
    hint = "" if key else (" No API key was found: pass --key, set BKK_API_KEY, or put the key in "
                           f"{KEY_FILE_NAME} in the project folder.")
    raise SystemExit("Could not download the GTFS zip (" + "; ".join(problems) + ")." + hint +
                     " You can also download it in a browser and run: bake_gtfs.py --zip <file>")


# ----------------------------------------------------------------------------- command line

def main(argv=None):
    parser = argparse.ArgumentParser(description="Bake BKK static GTFS (lines, shapes, stops) for the VIII. district.")
    parser.add_argument("--zip", type=pathlib.Path, help="local GTFS zip; skips the download")
    parser.add_argument("--url", default=DEFAULT_URL, help="GTFS zip URL (default: BKK's public feed)")
    parser.add_argument("--key", help="BKK API key (default: BKK_API_KEY, then BkkApiKey.txt in the project folder)")
    parser.add_argument("--save-zip", type=pathlib.Path, help="keep the downloaded zip here")
    parser.add_argument("--out", type=pathlib.Path, default=DEFAULT_OUT, help=f"output file (default: {DEFAULT_OUT})")
    parser.add_argument("--margin", type=float, default=DEFAULT_MARGIN_DEG, help="degrees added around the district box")
    parser.add_argument("--no-stop-times", action="store_true", help="skip stop_times.txt (faster; stops then list no lines)")
    args = parser.parse_args(argv)

    temporary_dir = None
    zip_path = args.zip
    try:
        if zip_path is None:
            if args.save_zip is not None:
                zip_path = args.save_zip
                zip_path.parent.mkdir(parents=True, exist_ok=True)
            else:
                temporary_dir = tempfile.TemporaryDirectory(prefix="bkk_gtfs_")
                zip_path = pathlib.Path(temporary_dir.name) / "budapest_gtfs.zip"
            download(args.url, resolve_key(args.key), zip_path)
        elif not zip_path.is_file():
            raise SystemExit(f"{zip_path} does not exist")

        print(f"Baking {zip_path} ...")
        routes, shapes, stops, stats = bake(zip_path, args.margin, not args.no_stop_times)
        size = write_transit(args.out, routes, shapes, stops)
    finally:
        if temporary_dir is not None:
            temporary_dir.cleanup()

    modes = ", ".join(f"{count} {mode}" for mode, count in stats["routes_by_mode"].items())
    print(f"  {stats['routes']} routes ({modes or 'none'}) of {stats['routes_in_feed']} in the feed")
    print(f"  {stats['shapes']} shape pieces, {stats['points']} points; {stats['stops']} stops"
          + (f" ({stats['unused_stops_dropped']} unused dropped)" if stats["used_stop_times"] else " (stop_times.txt not read)"))
    print(f"Wrote {args.out} ({size / 1024:.0f} KiB)")
    if stats["routes"] == 0:
        print("WARNING: nothing in the district box - is this Budapest's feed?", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
