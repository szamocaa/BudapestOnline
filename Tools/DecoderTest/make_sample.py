#!/usr/bin/env python3
"""Builds sample_vehicle_positions.pb with the *official* GTFS-realtime bindings, so the
C++ decoder is checked against an independent implementation of the protobuf format.

    pip install gtfs-realtime-bindings
    python3 make_sample.py
"""
import json
import pathlib

from google.transit import gtfs_realtime_pb2 as gtfs

OUT = pathlib.Path(__file__).parent

feed = gtfs.FeedMessage()
feed.header.gtfs_realtime_version = "2.0"
feed.header.incrementality = gtfs.FeedHeader.FULL_DATASET
feed.header.timestamp = 1790000000  # > 2**30, exercises multi-byte varints

expected = []


def add_vehicle(entity_id, lat, lon, route, trip, vid, label, bearing=None, speed=None,
                direction=None, stop=None, status=None, ts=None):
    e = feed.entity.add()
    e.id = entity_id
    v = e.vehicle
    v.trip.trip_id = trip
    v.trip.route_id = route
    if direction is not None:
        v.trip.direction_id = direction
    v.position.latitude = lat
    v.position.longitude = lon
    if bearing is not None:
        v.position.bearing = bearing
    if speed is not None:
        v.position.speed = speed
    v.vehicle.id = vid
    v.vehicle.label = label
    if stop:
        v.stop_id = stop
    if status is not None:
        v.current_status = status
    if ts is not None:
        v.timestamp = ts
    expected.append(dict(
        entity=entity_id, trip=trip, route=route, vehicle=vid, label=label, stop=stop or "",
        lat=v.position.latitude, lon=v.position.longitude,  # as stored (float32)
        bearing=v.position.bearing if bearing is not None else None,
        speed=v.position.speed if speed is not None else None,
        direction=direction if direction is not None else -1,
        status=status if status is not None else -1,
        ts=ts or 0))


add_vehicle("e1", 47.4979, 19.0402, "BKK_3040", "BKK_T1", "BKK_V100", "1234", bearing=90.0,
            speed=7.5, direction=1, stop="BKK_F00123", status=2, ts=1790000001)
add_vehicle("e2", 47.5000, 19.0500, "BKK_5200", "BKK_T2", "BKK_V200", "Kálvin tér",
            bearing=271.5, ts=1790000002)
add_vehicle("e3", 47.4500, 19.1000, "BKK_0910", "BKK_T3", "BKK_V300", "x" * 200, direction=0)

# Entity that must be ignored: flagged deleted.
gone = feed.entity.add()
gone.id = "deleted"
gone.is_deleted = True
gone.vehicle.position.latitude = 47.0
gone.vehicle.position.longitude = 19.0

# Entity that must be ignored: vehicle without a position.
nopos = feed.entity.add()
nopos.id = "nopos"
nopos.vehicle.vehicle.id = "BKK_V999"

# Entities of other kinds (decoder must skip them without choking).
tu = feed.entity.add()
tu.id = "tripupdate"
tu.trip_update.trip.trip_id = "BKK_TU"
stu = tu.trip_update.stop_time_update.add()
stu.stop_id = "BKK_F00001"
stu.arrival.delay = 120
al = feed.entity.add()
al.id = "alert"
al.alert.header_text.translation.add().text = "Pótlóbusz"

(OUT / "sample_vehicle_positions.pb").write_bytes(feed.SerializeToString())
(OUT / "sample_expected.json").write_text(json.dumps(
    dict(header_timestamp=feed.header.timestamp, vehicles=expected), indent=1, ensure_ascii=False))
print("wrote", len(feed.SerializeToString()), "bytes,", len(expected), "vehicles")
