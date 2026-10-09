import assert from 'node:assert/strict';
import { TransitSystem } from '../../game/transit/system.js';
import { cumulative } from '../../game/osm.js';

const pts = [[0, 0], [0, -1500], [800, -1500]]; // north, then east
const back = pts.slice().reverse();
const mkStops = (p) => { const c = cumulative(p); return [0, 0.25, 0.5, 0.75, 1].map((k, i) => ({ name: `Megálló ${i}`, s: c[c.length - 1] * k })); };
const stopsA = mkStops(pts), stopsB = mkStops(back).map((s, i, a) => ({ ...s, name: a[a.length - 1 - i].name }));
const sys = new TransitSystem([{ ref: '28A', mode: 'tram', directions: [{ headsign: 'Új köztemető', pts, stops: stopsA }, { headsign: 'Blaha Lujza tér', pts: back, stops: stopsB }] }]);

// Weekday 18:00 (Wednesday, every 10 min): timetable vehicles in both directions.
const unixNoon = Date.UTC(2026, 9, 7, 16, 0, 0) / 1000;
const v1 = sys.update(0.1, unixNoon, 18, 3);
assert.ok(v1.length >= 2, `${v1.length} trams at 18:00`);
assert.ok(v1.some((v) => v.dir.index === 0) && v1.some((v) => v.dir.index === 1));
for (const v of v1) assert.ok(Number.isFinite(v.x) && Number.isFinite(v.z) && Number.isFinite(v.yaw));
// None at 03:30.
assert.equal(sys.update(0.1, unixNoon, 3.5, 3).length, 0);

// Departures board at a stop.
const board = sys.departuresNear(2, -1150, unixNoon, 18, 3);
assert.equal(sys.departuresNear(0, -750, unixNoon, 18, 3), null, 'no stop within 40 m');
assert.equal(board.stopName, 'Megálló 2');
assert.ok(board.list.length >= 1 && board.list.every((d) => d.minutes >= 0 && d.minutes < 30));

// Live data replaces the timetable and glides along the route without reversing.
sys.setLive([{ id: 'V1', ref: '28A', x: 3, z: -400, bearing: 0, headsign: 'Új köztemető', status: 'IN_TRANSIT_TO' }], unixNoon);
let v = sys.update(0.1, unixNoon, 18, 3);
assert.equal(v.length, 1);
assert.equal(v[0].live, true);
assert.equal(v[0].dir.index, 0, 'heading north matches direction 0');
assert.ok(Math.abs(v[0].s - 400) < 1);
sys.setLive([{ id: 'V1', ref: '28A', x: 0, z: -460, bearing: 0, headsign: '' }], unixNoon + 10);
let prev = v[0].s;
for (let k = 0; k < 100; k++) {
	v = sys.update(0.1, unixNoon + 10 + k * 0.1, 18, 3);
	assert.ok(v[0].s >= prev - 1e-9, 'never reverses');
	prev = v[0].s;
}
assert.ok(Math.abs(prev - 460) < 1, `caught up to ${prev}`);
// Jitter backwards is ignored, a big jump snaps.
sys.setLive([{ id: 'V1', ref: '28A', x: 0, z: -455, bearing: 0 }], unixNoon + 30);
v = sys.update(0.1, unixNoon + 30, 18, 3);
assert.ok(Math.abs(v[0].s - 460) < 1, 'stays put on small backwards jitter');
sys.setLive([{ id: 'V1', ref: '28A', x: 0, z: -1400, bearing: 0 }], unixNoon + 40);
v = sys.update(0.1, unixNoon + 40, 18, 3);
assert.ok(Math.abs(v[0].s - 1400) < 1, 'big jump snaps');
// Live data goes stale -> timetable returns.
v = sys.update(0.1, unixNoon + 400, 18, 3);
assert.ok(v.some((x) => !x.live), 'timetable back after live data stops');
console.log('ok system: timetable both ways, departures board, live replacement/gliding/snapping/staleness');
