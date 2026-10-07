#!/usr/bin/env python3
"""Downloads OpenStreetMap data for Budapest's VIII. district (Jozsefvaros) and bakes it into the
compact binary files the Unreal project loads at runtime:

    Content/Data/district8_buildings.bsb   extruded-building footprints, heights, roof triangles
    Content/Data/district8_paths.bsb       walkable street/footpath graph for pedestrians

    pip install -r requirements.txt
    python3 bake_district.py all            # download + bake (needs internet)
    python3 bake_district.py fetch          # only download  -> Tools/Districts/raw/*.json
    python3 bake_district.py bake           # only bake from the downloaded JSON

Data (c) OpenStreetMap contributors, ODbL 1.0 - https://www.openstreetmap.org/copyright
The baked files are a "produced work/derived database" of that data: keep the attribution, and
if you publish the baked files, publish them under the ODbL as well.
File layout is documented in Source/BudapestSim/City/BsbReader.h.
"""
import argparse
import collections
import json
import math
import pathlib
import re
import struct
import sys
import time
import urllib.error
import urllib.request

import numpy as np
import mapbox_earcut

HERE = pathlib.Path(__file__).resolve().parent
PROJECT = HERE.parent.parent
DEFAULT_RAW = HERE / "raw"
DEFAULT_OUT = PROJECT / "Content" / "Data"

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
USER_AGENT = "budapest-sim-baker/0.1 (hobby Unreal Engine project)"

DISTRICT_NAME = "VIII. kerület"
SEARCH_BBOX = (47.40, 18.90, 47.60, 19.30)  # south, west, north, east: just to pick the right relation

METERS_PER_LEVEL = 3.2
# Typical height when OSM has neither `height` nor `building:levels`. Jozsefvaros is mostly
# 4-6 storey 19th-century tenement blocks, so 5 floors is a better guess than a bungalow.
DEFAULT_HEIGHT_M = 16.0
HEIGHT_BY_TYPE = {
    "house": 7.0, "detached": 7.0, "semidetached_house": 7.0, "terrace": 7.0, "bungalow": 4.0,
    "garage": 3.5, "garages": 3.5, "carport": 3.0, "shed": 3.0, "hut": 3.0, "cabin": 4.0,
    "roof": 4.0, "kiosk": 3.0, "service": 5.0, "industrial": 10.0, "warehouse": 8.0,
    "retail": 8.0, "supermarket": 8.0, "commercial": 15.0, "office": 20.0, "hotel": 22.0,
    "school": 14.0, "kindergarten": 7.0, "university": 18.0, "hospital": 20.0,
    "church": 24.0, "chapel": 10.0, "cathedral": 35.0, "synagogue": 20.0,
    "apartments": 19.0, "residential": 18.0, "dormitory": 18.0,
}
MIN_FOOTPRINT_AREA_M2 = 5.0
EARTH_RADIUS_M = 6371008.8

WALK_CLASS = {
    "footway": 0, "pedestrian": 0, "path": 0, "steps": 0, "corridor": 0, "bridleway": 0, "cycleway": 0,
    "living_street": 1, "residential": 1, "service": 1, "unclassified": 1, "road": 1, "track": 1,
    "tertiary": 2, "tertiary_link": 2, "secondary": 2, "secondary_link": 2,
    "primary": 2, "primary_link": 2,
}


# ----------------------------------------------------------------------------- downloading

def district_prelude():
    s, w, n, e = SEARCH_BBOX
    return (
        '[out:json][timeout:240];\n'
        f'rel["boundary"="administrative"]["admin_level"="9"]["name"="{DISTRICT_NAME}"]({s},{w},{n},{e});\n'
        'map_to_area->.d;\n'
    )


QUERIES = {
    "buildings": district_prelude() + '(way["building"](area.d); relation["building"](area.d););\nout geom;',
    "highways": district_prelude() + 'way["highway"](area.d);\nout geom;',
}


def run_overpass(query):
    last_error = None
    for endpoint in OVERPASS_ENDPOINTS:
        request = urllib.request.Request(
            endpoint, data=("data=" + urllib.request.quote(query)).encode(),
            headers={"User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded"})
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                return json.loads(response.read().decode("utf-8"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error
            print(f"  {endpoint}: {error}", file=sys.stderr)
            time.sleep(2)
    raise SystemExit(f"All Overpass endpoints failed (last error: {last_error})")


def fetch(raw_dir):
    raw_dir.mkdir(parents=True, exist_ok=True)
    for name, query in QUERIES.items():
        print(f"Downloading {name} ...")
        data = run_overpass(query)
        count = len(data.get("elements", []))
        if count == 0:
            raise SystemExit(f"Overpass returned no {name}. The district boundary lookup probably failed; "
                             f"check DISTRICT_NAME / SEARCH_BBOX in this script.")
        (raw_dir / f"{name}.json").write_text(json.dumps(data))
        print(f"  {count} elements")


# ----------------------------------------------------------------------------- geometry helpers

def to_local_meters(points, origin_lat, origin_lon):
    """(lat, lon) list -> (north, east) metres around an origin; same axes as the Unreal world."""
    cos_lat = math.cos(math.radians(origin_lat))
    return [((lat - origin_lat) * math.radians(1) * EARTH_RADIUS_M,
             (lon - origin_lon) * math.radians(1) * EARTH_RADIUS_M * cos_lat) for lat, lon in points]


def signed_area(points):
    return 0.5 * sum(ax * by - bx * ay for (ax, ay), (bx, by) in zip(points, points[1:] + points[:1]))


def point_in_polygon(point, polygon):
    x, y = point
    inside = False
    for (ax, ay), (bx, by) in zip(polygon, polygon[1:] + polygon[:1]):
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            inside = not inside
    return inside


def clean_ring(points):
    """Drop the repeated closing point and consecutive duplicates."""
    cleaned = []
    for point in points:
        if not cleaned or point != cleaned[-1]:
            cleaned.append(point)
    if len(cleaned) > 1 and cleaned[0] == cleaned[-1]:
        cleaned.pop()
    return cleaned


def assemble_rings(segments):
    """Joins way fragments end-to-end into closed rings. Open leftovers are discarded."""
    pending = [list(segment) for segment in segments if len(segment) >= 2]
    rings = []
    while pending:
        current = pending.pop(0)
        while current[0] != current[-1]:
            for index, other in enumerate(pending):
                if other[0] == current[-1]:
                    current += other[1:]
                elif other[-1] == current[-1]:
                    current += other[-2::-1]
                elif other[-1] == current[0]:
                    current = other[:-1] + current
                elif other[0] == current[0]:
                    current = other[:0:-1] + current
                else:
                    continue
                pending.pop(index)
                break
            else:
                break  # nothing joins: open ring
        if current[0] == current[-1] and len(current) >= 4:
            rings.append(current[:-1])
    return rings


def element_points(geometry):
    return [(node["lat"], node["lon"]) for node in geometry]


# ----------------------------------------------------------------------------- heights

def parse_length_m(value):
    """OSM lengths: "12", "12.5", "12,5 m", "40 ft", "40'", "6'6\"". Returns metres or None."""
    if value is None:
        return None
    text = str(value).strip().lower().replace(",", ".")
    feet_inches = re.match(r"^(\d+)'\s*(\d+(?:\.\d+)?)\"?$", text)
    if feet_inches:
        total = (int(feet_inches.group(1)) * 12 + float(feet_inches.group(2))) * 0.0254
        return total if total > 0 else None
    match = re.match(r"^(-?\d+(?:\.\d+)?)\s*(meters|metres|meter|metre|m|feet|ft|')?(?:\s|$)", text)
    if not match:
        return None
    number = float(match.group(1))
    if match.group(2) in ("ft", "feet", "'"):
        number *= 0.3048
    return number if number > 0 else None


def parse_levels(value):
    if value is None:
        return None
    match = re.match(r"^\s*(\d+(?:\.\d+)?)", str(value).replace(",", "."))
    return float(match.group(1)) if match else None


def building_heights(tags):
    """Returns (height_m, min_height_m, source) where source says how reliable the height is."""
    height = parse_length_m(tags.get("height"))
    source = "height"
    if height is None:
        levels = parse_levels(tags.get("building:levels"))
        if levels:
            height, source = levels * METERS_PER_LEVEL, "levels"
    if height is None:
        height = HEIGHT_BY_TYPE.get(tags.get("building", "yes"))
        source = "type"
        if height is None:
            height, source = DEFAULT_HEIGHT_M, "default"

    min_height = parse_length_m(tags.get("min_height"))
    if min_height is None:
        min_level = parse_levels(tags.get("building:min_level"))
        min_height = min_level * METERS_PER_LEVEL if min_level else 0.0
    if min_height >= height - 0.5:
        min_height = 0.0
    return height, min_height, source


# ----------------------------------------------------------------------------- buildings

def footprints_from_element(element):
    """Yields (outer_ring, [hole_rings]) as lists of (lat, lon)."""
    if element["type"] == "way":
        ring = clean_ring(element_points(element.get("geometry", [])))
        geometry = element.get("geometry", [])
        closed = len(geometry) >= 4 and geometry[0] == geometry[-1]
        if closed and len(ring) >= 3:
            yield ring, []
        return

    if element["type"] != "relation":
        return
    outer_segments, inner_segments = [], []
    for member in element.get("members", []):
        if member.get("type") != "way" or "geometry" not in member:
            continue
        points = element_points(member["geometry"])
        (inner_segments if member.get("role") == "inner" else outer_segments).append(points)

    outers = assemble_rings(outer_segments)
    inners = assemble_rings(inner_segments)
    if not outers:
        return
    # Local planar approximation is plenty for deciding which outer ring contains a courtyard.
    origin_lat, origin_lon = outers[0][0]
    outer_xy = [to_local_meters(ring, origin_lat, origin_lon) for ring in outers]
    holes_for = collections.defaultdict(list)
    for inner in inners:
        inner_xy = to_local_meters(inner, origin_lat, origin_lon)
        for index, polygon in enumerate(outer_xy):
            if point_in_polygon(inner_xy[0], polygon):
                holes_for[index].append(inner)
                break
    for index, ring in enumerate(outers):
        yield clean_ring(ring), [clean_ring(hole) for hole in holes_for[index]]


def bake_buildings(elements):
    """Returns (list of baked building dicts, stats)."""
    stats = collections.Counter()
    baked = []
    for element in elements:
        tags = element.get("tags", {})
        if tags.get("building") in (None, "no"):
            continue
        stats["buildings_seen"] += 1
        height, min_height, source = building_heights(tags)
        produced = False
        for outer, holes in footprints_from_element(element):
            rings = [outer] + [hole for hole in holes if len(hole) >= 3]
            if len(outer) < 3:
                continue
            origin_lat, origin_lon = outer[0]
            rings_xy = [to_local_meters(ring, origin_lat, origin_lon) for ring in rings]
            outer_area = abs(signed_area(rings_xy[0]))
            if outer_area < MIN_FOOTPRINT_AREA_M2:
                stats["skipped_tiny"] += 1
                continue

            flat = [point for ring in rings_xy for point in ring]
            ends = np.cumsum([len(ring) for ring in rings_xy]).astype(np.uint32)
            indices = mapbox_earcut.triangulate_float64(np.array(flat, dtype=np.float64), ends)
            indices = [int(i) for i in indices]
            triangle_area = sum(
                abs(0.5 * ((flat[b][0] - flat[a][0]) * (flat[c][1] - flat[a][1]) -
                           (flat[b][1] - flat[a][1]) * (flat[c][0] - flat[a][0])))
                for a, b, c in zip(indices[0::3], indices[1::3], indices[2::3]))
            expected = outer_area - sum(abs(signed_area(ring)) for ring in rings_xy[1:])
            if not indices or abs(triangle_area - expected) > 0.02 * max(expected, 1.0):
                stats["skipped_bad_triangulation"] += 1  # self-intersecting or otherwise invalid outline
                continue

            baked.append({
                "osm_id": int(element["id"]), "height": height, "min_height": min_height,
                "rings": rings, "indices": indices,
            })
            stats["height_" + source] += 1
            produced = True
        if produced:
            stats["buildings_baked"] += 1
    return baked, stats


def write_buildings(path, baked):
    with open(path, "wb") as handle:
        handle.write(b"BSBB" + struct.pack("<II", 1, len(baked)))
        for building in baked:
            handle.write(struct.pack("<QffI", building["osm_id"], building["height"], building["min_height"],
                                     len(building["rings"])))
            for ring in building["rings"]:
                handle.write(struct.pack("<I", len(ring)))
                for lat, lon in ring:
                    handle.write(struct.pack("<dd", lat, lon))
            handle.write(struct.pack("<I", len(building["indices"])))
            handle.write(struct.pack(f"<{len(building['indices'])}I", *building["indices"]))


# ----------------------------------------------------------------------------- walkable paths

def bake_paths(elements):
    stats = collections.Counter()
    node_ids, nodes, edges = {}, [], {}

    def node_for(lat, lon):
        key = (round(lat, 7), round(lon, 7))
        if key not in node_ids:
            node_ids[key] = len(nodes)
            nodes.append(key)
        return node_ids[key]

    for element in elements:
        if element["type"] != "way":
            continue
        tags = element.get("tags", {})
        highway = tags.get("highway")
        if highway not in WALK_CLASS or tags.get("foot") == "no" or tags.get("access") == "private":
            stats["ways_skipped"] += 1
            continue
        if tags.get("service") in ("driveway", "parking_aisle", "drive-through") or tags.get("indoor") == "yes":
            stats["ways_skipped"] += 1
            continue
        if tags.get("tunnel") == "yes" and highway not in ("footway", "pedestrian", "steps", "path"):
            stats["ways_skipped"] += 1
            continue
        klass = WALK_CLASS[highway]
        points = element_points(element.get("geometry", []))
        for (lat_a, lon_a), (lat_b, lon_b) in zip(points, points[1:]):
            a, b = node_for(lat_a, lon_a), node_for(lat_b, lon_b)
            if a == b:
                continue
            key = (min(a, b), max(a, b))
            edges[key] = min(edges.get(key, klass), klass)  # a shared segment keeps its smaller (footpath-like) class
        stats["ways_used"] += 1

    # Keep only the largest connected component so pedestrians never spawn on an isolated island.
    parent = list(range(len(nodes)))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in edges:
        parent[find(a)] = find(b)
    used = {n for edge in edges for n in edge}
    sizes = collections.Counter(find(n) for n in used)
    if not sizes:
        return [], [], stats
    keep_root = sizes.most_common(1)[0][0]
    remap, kept_nodes = {}, []
    for index in sorted(used):
        if find(index) == keep_root:
            remap[index] = len(kept_nodes)
            kept_nodes.append(nodes[index])
    kept_edges = [(remap[a], remap[b], klass) for (a, b), klass in sorted(edges.items()) if a in remap and b in remap]
    stats["nodes"], stats["edges"] = len(kept_nodes), len(kept_edges)
    stats["nodes_dropped_disconnected"] = len(used) - len(kept_nodes)
    return kept_nodes, kept_edges, stats


def write_paths(path, nodes, edges):
    with open(path, "wb") as handle:
        handle.write(b"BSBP" + struct.pack("<II", 1, len(nodes)))
        for lat, lon in nodes:
            handle.write(struct.pack("<dd", lat, lon))
        handle.write(struct.pack("<I", len(edges)))
        for a, b, klass in edges:
            handle.write(struct.pack("<IIBBBB", a, b, klass, 0, 0, 0))


# ----------------------------------------------------------------------------- entry point

def bake(raw_dir, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    buildings_json = json.loads((raw_dir / "buildings.json").read_text())
    baked, stats = bake_buildings(buildings_json["elements"])
    write_buildings(out_dir / "district8_buildings.bsb", baked)
    print("buildings:", dict(stats))

    highways_json = json.loads((raw_dir / "highways.json").read_text())
    nodes, edges, path_stats = bake_paths(highways_json["elements"])
    write_paths(out_dir / "district8_paths.bsb", nodes, edges)
    print("paths:", dict(path_stats))
    print(f"wrote {out_dir}/district8_buildings.bsb and district8_paths.bsb")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["fetch", "bake", "all"])
    parser.add_argument("--raw", type=pathlib.Path, default=DEFAULT_RAW)
    parser.add_argument("--out", type=pathlib.Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    if args.command in ("fetch", "all"):
        fetch(args.raw)
    if args.command in ("bake", "all"):
        bake(args.raw, args.out)


if __name__ == "__main__":
    main()
