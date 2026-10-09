import assert from 'node:assert/strict';
import { LINE_DEFAULTS, headwayAt, segmentTime, segmentDistance, makeRun, runStateAt, departures, activeVehicles, pointAt, serviceClock } from '../../game/transit/schedule.js';
import { cumulative } from '../../game/osm.js';

// Motion profile: continuous, monotonic, ends exactly at the stop; short hops never reach top speed.
for (const len of [5, 40, 120, 600]) {
	const T = segmentTime(len, 11, 0.9);
	let prev = 0;
	for (let i = 0; i <= 400; i++) {
		const s = segmentDistance(len, 11, 0.9, (T * i) / 400);
		assert.ok(s >= prev - 1e-9 && s <= len + 1e-9, `monotonic len ${len}`);
		if (i > 0) assert.ok(s - prev < (11 * T) / 400 + 1e-6, 'never faster than vmax');
		prev = s;
	}
	assert.ok(Math.abs(segmentDistance(len, 11, 0.9, T) - len) < 1e-9);
}
assert.ok(Math.abs(segmentTime(600, 11, 0.9) - (2 * 11 / 0.9 + (600 - 121 / 0.9) / 11)) < 1e-9);

// A 3 km line with 8 stops.
const pts = [[0, 0], [1000, 0], [1000, 1000], [2000, 1000]];
const cum = cumulative(pts);
const stops = [0, 300, 900, 1200, 1700, 2100, 2600, 3000].map((s, k) => ({ name: `Megálló ${k}`, s }));
const run = makeRun({ pts, cum, stops }, LINE_DEFAULTS['28A']);
assert.equal(run.legs.length, 8);
assert.ok(run.duration > 3000 / 11 && run.duration < 3000 / 4, `run takes ${run.duration.toFixed(0)} s`);
let prevS = -1;
for (let e = 0; e <= run.duration; e += 3) {
	const st = runStateAt(run, e);
	assert.ok(st.s >= prevS - 1e-9, 'never reverses');
	prevS = st.s;
}
assert.equal(runStateAt(run, run.duration + 5).finished, true);
assert.equal(runStateAt(run, 1).atStop, 0, 'dwelling at the first stop');

// Headways and service hours.
const l99 = LINE_DEFAULTS['99'];
assert.equal(headwayAt(l99, 7, false), 7);
assert.equal(headwayAt(l99, 2, false), null);
assert.equal(headwayAt(LINE_DEFAULTS['23'], 12, true), 15, 'tram 23 runs at weekends every 15 min');
assert.equal(headwayAt(LINE_DEFAULTS['23'], 21, false), null, 'tram 23 is a daytime line');
assert.equal(headwayAt(LINE_DEFAULTS['28A'], 14.5, false), null, 'the 28A has a weekday gap around 14:00-15:40');
const deps = departures(LINE_DEFAULTS['28A'], false);
assert.ok(deps.length > 40 && deps.length < 120, `${deps.length} departures`);
for (let i = 1; i < deps.length; i++) assert.ok(deps[i] > deps[i - 1]);

// Vehicles in service: about duration / headway, ordered and spaced along the line.
const noon = 11 * 3600;
const veh = activeVehicles(run, deps, noon);
const expected = run.duration / (headwayAt(LINE_DEFAULTS['28A'], 11, false) * 60);
assert.ok(Math.abs(veh.length - expected) <= 2, `${veh.length} vehicles vs ~${expected.toFixed(1)}`);
const ss = veh.map((v) => v.state.s).sort((a, b) => a - b);
for (let i = 1; i < ss.length; i++) assert.ok(ss[i] - ss[i - 1] > 50, 'vehicles do not bunch up');
assert.equal(activeVehicles(run, deps, 3.5 * 3600).length, 0, 'no trams at 03:30');

// Geometry helpers.
const [x, z] = pointAt(pts, cum, 1500);
assert.deepEqual([x, z], [1000, 500]);
assert.ok(Math.abs(pointAt(pts, cum, 1500)[2] - 0) < 1e-9, 'heading +z (south) is yaw 0');
assert.deepEqual(serviceClock(1.5, 6), { seconds: 25.5 * 3600, weekend: false }, 'Saturday 01:30 belongs to Friday\'s service day');
assert.deepEqual(serviceClock(10, 6), { seconds: 10 * 3600, weekend: true });
console.log(`ok schedule: run ${run.duration.toFixed(0)} s, ${veh.length} trams at noon, ${deps.length} departures/day`);
