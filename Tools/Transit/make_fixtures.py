#!/usr/bin/env python3
"""Builds a small hand-made GTFS feed in BKK's real format (a zip of CSV .txt files) and bakes it:

    fixtures/sample_gtfs.zip       the feed (used by test_bake_gtfs.py)
    fixtures/sample_transit.bsb    the baked result (read by Tools/CoreTests/transit_static_test.cpp)

Run it again after changing the fixture or the file format; test_bake_gtfs.py fails while the
committed .bsb is out of date. Positions are written in metres (north, east) from the world origin.

The feed deliberately has the awkward parts of real GTFS: a UTF-8 BOM, CRLF line endings, quoted
fields with commas and doubled quotes, extra columns, missing optional columns (route_color in one
file version), extended route types, an unsorted and interleaved shapes.txt, parent stations and
entrances in stops.txt, and a trip without a shape.
"""
import math
import pathlib
import zipfile

import bake_gtfs as baker

HERE = pathlib.Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures"
ZIP_PATH = FIXTURES / "sample_gtfs.zip"
BSB_PATH = FIXTURES / "sample_transit.bsb"

ORIGIN_LAT, ORIGIN_LON = 47.4925, 19.0800  # BudapestGeo::DefaultOrigin*
EARTH_RADIUS_M = 6371008.8


def ll(north, east):
    lat = ORIGIN_LAT + north / (EARTH_RADIUS_M * math.radians(1))
    lon = ORIGIN_LON + east / (EARTH_RADIUS_M * math.radians(1) * math.cos(math.radians(ORIGIN_LAT)))
    return round(lat, 7), round(lon, 7)  # GTFS feeds carry ~7 decimals


# Shapes, as (north, east) metres. The padded district box spans about -1946..+1835 m north and
# -2180..+2180 m east of the origin.
TRAM_NORTH = [(n, -1000) for n in range(-3000, 3001, 500)]           # crosses the box south to north
TRAM_SOUTH = list(reversed(TRAM_NORTH))                              # same track, other direction
TRAM_NORTH_VARIANT = TRAM_NORTH[:-2] + [(2500, -800), (3000, -600)]  # same inside the box: deduplicated
TRAM_TWICE = [(0, 3000), (0, 1800), (0, 1000), (300, 2600), (600, 3000), (600, 1500), (600, 3500)]  # enters twice
BUS_DIAGONAL = [(-2600, -2600), (2600, 2600)]                        # no point inside, but crosses the box
METRO_LINE = [(-500, -1500), (0, 0), (500, 1500)]
TROLLEY_LINE = [(-1200, 500), (-1200, 1000), (-1200, 1500)]
NIGHT_LINE = [(-300, -300), (300, 300)]
DRT_LINE = [(900, 900), (900, 1200)]
FAR_LINE = [(10000, 0), (10500, 0)]
HEV_LINE = [(-9000, 5000), (-9500, 5500)]

SHAPES = {
    "T4N": TRAM_NORTH, "T4S": TRAM_SOUTH, "T4N_B": TRAM_NORTH_VARIANT, "T28": TRAM_TWICE,
    "B9": BUS_DIAGONAL, "M4": METRO_LINE, "TR83": TROLLEY_LINE, "B990": NIGHT_LINE, "B282": DRT_LINE,
    "FAR": FAR_LINE, "H5": HEV_LINE,
}

ROUTES_TXT = (
    "agency_id,route_id,route_short_name,route_long_name,route_type,route_desc,route_color,route_text_color,route_sort_order\r\n"
    'BKK,3040,4,"Széll Kálmán tér M / Újbuda-központ M",0,"Nagykörút, Margit híd",FFD800,000000,40\r\n'
    'BKK,3060,6,"Széll Kálmán tér M / Móricz Zsigmond körtér M",900,,,,60\r\n'           # extended type, no colours
    'BKK,3280,28,"Blaha Lujza tér M / Új köztemető",0,,#ffd800,,280\r\n'                 # '#' colour, no text colour
    'BKK,5400,M4,"Kelenföld vasútállomás M / Keleti pályaudvar M",1,,4CA22F,FFFFFF,4\r\n'
    'BKK,7830,83,"Fővám tér M / Orczy tér",11,,FF1609,FFFFFF,830\r\n'
    'BKK,0090,9,"Óbuda, Bogdáni út / Kőbánya alsó vasútállomás",3,,009FE3,FFFFFF,90\r\n'
    'BKK,9990,990,"Normafa / Blaha Lujza tér M",3,,1E1E1E,FFFFFF,990\r\n'
    'BKK,2820,282E,"Igény szerinti járat",715,,nonsense,,2820\r\n'                         # extended bus, bad colour
    'BKK,M3P,M3 pótló,"Metrópótló busz",3,,,,9000\r\n'                                    # no shapes, serves a stop
    'BKK,0200,200E,"Kőbánya-Kispest M / Liszt Ferenc Repülőtér",3,,009FE3,FFFFFF,200\r\n'  # far away
    'BKK,H5,H5,"Batthyány tér M+H / Szentendre",109,,821066,FFFFFF,5\r\n'                 # far away
)

TRIPS_TXT = (
    "route_id,trip_id,service_id,trip_headsign,direction_id,block_id,shape_id,wheelchair_accessible,bikes_allowed\r\n"
    "3040,T4-1,WD,Újbuda-központ M,0,b1,T4N,1,2\r\n"
    "3040,T4-2,WD,Széll Kálmán tér M,1,b1,T4S,1,2\r\n"
    "3040,T4-3,WD,Újbuda-központ M,0,b2,T4N_B,1,2\r\n"
    "3060,T6-1,WD,Móricz Zsigmond körtér M,0,b3,T4N,1,2\r\n"   # shape shared by two routes
    "3280,T28-1,WD,Új köztemető,0,b4,T28,1,2\r\n"
    "5400,M4-1,WD,Keleti pályaudvar M,0,b5,M4,1,2\r\n"
    "7830,TR83-1,WD,Orczy tér,0,b6,TR83,1,2\r\n"
    "0090,B9-1,WD,Kőbánya alsó vasútállomás,0,b7,B9,1,2\r\n"
    "9990,B990-1,NI,Blaha Lujza tér M,0,b8,B990,1,2\r\n"
    "2820,B282-1,WD,Kőbánya,0,b9,B282,1,2\r\n"
    "M3P,M3P-1,WD,Kőbánya-Kispest,0,b10,,1,2\r\n"               # no shape
    "0200,B200-1,WD,Repülőtér,0,b11,FAR,1,2\r\n"
    "H5,H5-1,WD,Szentendre,0,b12,H5,1,2\r\n"
    "NOPE,X-1,WD,Nowhere,0,b13,T4N,1,2\r\n"                     # unknown route: ignored
)


def shapes_txt():
    rows = []
    for shape_id, points in SHAPES.items():
        for sequence, (north, east) in enumerate(points, start=1):
            lat, lon = ll(north, east)
            rows.append((shape_id, lat, lon, sequence * 10, ""))
    # Real files are usually sorted, but nothing guarantees it: interleave two shapes and reverse one.
    tram_north = [row for row in rows if row[0] == "T4N"]
    tram_south = [row for row in rows if row[0] == "T4S"]
    others = [row for row in rows if row[0] not in ("T4N", "T4S")]
    mixed = [row for pair in zip(reversed(tram_north), tram_south) for row in pair]
    lines = ["shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled"]
    lines += [f"{s},{lat:.7f},{lon:.7f},{seq},{dist}" for s, lat, lon, seq, dist in mixed + others]
    return "\r\n".join(lines) + "\r\n"


def stops_txt():
    def stop(stop_id, name, north, east, location_type="0", parent=""):
        lat, lon = ll(north, east)
        quoted = '"' + name.replace('"', '""') + '"'
        return f"{stop_id},{quoted},{lat:.7f},{lon:.7f},{location_type},{parent},1\r\n"

    return ("stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station,wheelchair_boarding\r\n"
            + stop("F01000", "Blaha Lujza tér M", 0, -1000)
            + stop("F01001", 'Corvin-negyed M, "Kisfaludy" köz', -500, -1000, "")  # empty location_type = stop
            + stop("F01002", "Nagyvárad tér M", -1200, 1000, "", "STA1")
            + stop("F01003", "Orczy tér", 300, 2000)
            + stop("STA1", "Nagyvárad tér M (állomás)", -1200, 1000, "1")             # station: not a stop
            + stop("E01", "Nagyvárad tér M (kijárat)", -1210, 1010, "2", "STA1")      # entrance
            + stop("F09999", "Unused stop", 100, 100)                                  # nothing calls here
            + stop("F05000", "Far away", 10000, 0))                                    # outside the box


STOP_TIMES_TXT = (
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type,drop_off_type,shape_dist_traveled\r\n"
    "T4-1,08:00:00,08:00:00,F01001,1,,0,0,\r\n"
    "T4-1,08:02:00,08:02:00,F01000,2,,0,0,\r\n"
    "T6-1,08:01:00,08:01:00,F01000,1,,0,0,\r\n"
    "B9-1,08:05:00,08:05:00,F01000,1,,0,0,\r\n"
    "TR83-1,08:10:00,08:10:00,F01002,1,,0,0,\r\n"
    "TR83-1,08:14:00,08:14:00,F01003,2,,0,0,\r\n"
    "M3P-1,08:20:00,08:20:00,F01002,1,,0,0,\r\n"
    "M3P-1,08:21:00,08:21:00,F01002,2,,0,0,\r\n"
    "H5-1,09:00:00,09:00:00,F05000,1,,0,0,\r\n"
    "X-1,09:00:00,09:00:00,F01003,1,,0,0,\r\n"
)


def write_zip(path):
    files = {
        "agency.txt": "agency_id,agency_name,agency_url,agency_timezone,agency_lang\r\nBKK,BKK,https://bkk.hu,Europe/Budapest,hu\r\n",
        "routes.txt": ROUTES_TXT,
        "trips.txt": TRIPS_TXT,
        "shapes.txt": shapes_txt(),
        "stops.txt": stops_txt(),
        "stop_times.txt": STOP_TIMES_TXT,
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, text in files.items():
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))  # fixed date: reproducible bytes
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, ("﻿" if name == "routes.txt" else "") + text)


def main():
    FIXTURES.mkdir(exist_ok=True)
    write_zip(ZIP_PATH)
    routes, shapes, stops, _ = baker.bake(ZIP_PATH)
    baker.write_transit(BSB_PATH, routes, shapes, stops)
    print(f"wrote {ZIP_PATH.name} and {BSB_PATH.name}")


if __name__ == "__main__":
    main()
