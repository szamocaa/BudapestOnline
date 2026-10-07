#!/usr/bin/env python3
"""Writes astro_reference.csv using independent libraries (PyEphem for sun/moon, zoneinfo for
Europe/Budapest), so the C++ in World/Astro.cpp is checked against something we did not write.

    pip install ephem tzdata
    python3 make_astro_reference.py
"""
import csv
import datetime as dt
import math
import pathlib
import random
import zoneinfo

import ephem

LAT, LON = 47.4977, 19.0541  # Budapest, Deak Ferenc ter
BUDAPEST = zoneinfo.ZoneInfo("Europe/Budapest")
OUT = pathlib.Path(__file__).parent / "astro_reference.csv"

observer = ephem.Observer()
observer.lat, observer.lon = str(LAT), str(LON)
observer.elevation = 0
observer.pressure = 0  # no atmospheric refraction, matching Astro.cpp

timestamps = set()
rng = random.Random(7)
start = dt.datetime(2025, 1, 1, tzinfo=dt.timezone.utc)
for _ in range(1500):
    timestamps.add(int((start + dt.timedelta(seconds=rng.randrange(0, 4 * 365 * 86400))).timestamp()))

# Daylight-saving boundaries (one second either side), plus a few special instants.
for year, march_day, october_day in [(2025, 30, 26), (2026, 29, 25), (2027, 28, 31), (2028, 26, 29)]:
    for month, day in [(3, march_day), (10, october_day)]:
        edge = int(dt.datetime(year, month, day, 1, 0, 0, tzinfo=dt.timezone.utc).timestamp())
        timestamps.update([edge - 1, edge, edge + 1])
timestamps.add(int(dt.datetime(2026, 6, 21, 10, 0, tzinfo=dt.timezone.utc).timestamp()))   # solstice, near solar noon
timestamps.add(int(dt.datetime(2026, 12, 21, 11, 0, tzinfo=dt.timezone.utc).timestamp()))  # winter solstice
timestamps.add(int(dt.datetime(2028, 2, 29, 12, 0, tzinfo=dt.timezone.utc).timestamp()))   # leap day

with OUT.open("w", newline="") as handle:
    writer = csv.writer(handle)
    writer.writerow(["unix", "sun_el", "sun_az", "moon_el", "moon_az", "moon_illum", "utc_offset_hours"])
    for ts in sorted(timestamps):
        when = dt.datetime.fromtimestamp(ts, dt.timezone.utc)
        observer.date = ephem.Date(when.replace(tzinfo=None))
        sun, moon = ephem.Sun(observer), ephem.Moon(observer)
        offset = BUDAPEST.utcoffset(when.astimezone(BUDAPEST)).total_seconds() / 3600
        writer.writerow([ts, f"{math.degrees(sun.alt):.5f}", f"{math.degrees(sun.az):.5f}",
                         f"{math.degrees(moon.alt):.5f}", f"{math.degrees(moon.az):.5f}",
                         f"{moon.phase / 100:.5f}", int(offset)])
print("wrote", len(timestamps), "rows")
