// Timetable-driven vehicles (no rendering). Each direction of a line is a route polyline with stops;
// vehicles leave the first stop every `headway` minutes during service hours, drive with realistic
// acceleration/braking and dwell at every stop. Positions are a pure function of time, so the
// simulation is exact however the game is paused or sped up.

import { cumulative } from '../osm.js';

/**
 * Line settings. Headways: [fromHour, minutes] pairs in local Budapest time (null = no service),
 * for weekdays and weekends. Taken from BKK's GTFS timetable (June 2026, school-term weekday and
 * Saturday patterns) and rounded; autumn timetables may differ slightly - live data overrides them.
 * `vehicle`: model shown in the game (sections x length in metres).
 */
export const LINE_DEFAULTS = {
	'99': { mode: 'bus', name: '99-es busz', colour: '#009ee3', text: '#ffffff', vmax: 11, accel: 1.0, dwell: 18,
		vehicle: { model: 'Mercedes-Benz Conecto / Van Hool (12 m)', sections: 1, len: 12, gap: 0 },
		weekday: [[5.1, 10], [6, 8], [7, 7], [9, 8.5], [14, 6], [17, 7.5], [20, 10], [22, 15], [23, 20], [23.45, null]],
		weekend: [[5.1, 20], [7, 10], [20, 15], [22, 20], [23.45, null]] },
	'23': { mode: 'tram', name: '23-as villamos', colour: '#ffd800', text: '#000000', vmax: 11, accel: 0.9, dwell: 20,
		vehicle: { model: 'Ganz KCSV-7', sections: 2, len: 13, gap: 0.5 },
		weekday: [[4.95, 15], [6, 9.5], [14, 7.5], [19, 12], [20.35, null]],
		weekend: [[5.9, 15], [20.35, null]] },
	'24': { mode: 'tram', name: '24-es villamos', colour: '#ffd800', text: '#000000', vmax: 11, accel: 0.9, dwell: 20,
		vehicle: { model: 'Düwag TW 6000', sections: 2, len: 13.6, gap: 0.5 },
		weekday: [[4.5, 15], [6, 11.5], [9, 20], [13, 15], [19.5, 20], [23.99, null]],
		weekend: [[4.5, 20], [7.5, 15], [18, 20], [23.99, null]] },
	'28A': { mode: 'tram', name: '28A villamos', colour: '#ffd800', text: '#000000', vmax: 11, accel: 0.9, dwell: 20,
		vehicle: { model: 'Tatra T5C5K (két kocsi)', sections: 2, len: 14.6, gap: 1.2 },
		weekday: [[5.05, 15], [6, 12], [8, 20], [13.67, null], [15.67, 15], [18, 10], [19, 15], [21, 20], [23.05, null]],
		weekend: [[5.05, 20], [7, 10], [16, 15], [21, 20], [23.7, null]] },
	M2: { mode: 'metro', name: 'M2 metró', colour: '#e41f18', text: '#ffffff', vmax: 18, accel: 1.1, dwell: 25,
		vehicle: { model: 'Alstom Metropolis AM5-M2', sections: 5, len: 20, gap: 0.6 },
		weekday: [[4.6, 10], [6, 4], [7, 2.6], [9, 4], [10, 5], [13, 3.5], [16, 2.6], [18, 3.5], [19, 5], [22, 10], [23.99, null]],
		weekend: [[4.6, 10], [7, 5], [21, 10], [23.99, null]] },
};

/** Minutes between departures at local hour h (null = no service). */
export function headwayAt(line, hour, weekend) {
	const table = (weekend && line.weekend) || line.weekday;
	let value = null;
	for (const [from, minutes] of table) if (hour >= from) value = minutes;
	return value;
}

/** Time (s) and distance profile for driving `len` metres from standstill to standstill. */
export function segmentTime(len, vmax, a) {
	const dAcc = (vmax * vmax) / (2 * a);
	if (len >= 2 * dAcc) return 2 * (vmax / a) + (len - 2 * dAcc) / vmax;
	return 2 * Math.sqrt(len / a);
}

/** Distance travelled after `t` seconds on such a segment. */
export function segmentDistance(len, vmax, a, t) {
	const total = segmentTime(len, vmax, a);
	if (t <= 0) return 0;
	if (t >= total) return len;
	const dAcc = (vmax * vmax) / (2 * a);
	if (len >= 2 * dAcc) {
		const tAcc = vmax / a, tCruise = (len - 2 * dAcc) / vmax;
		if (t < tAcc) return 0.5 * a * t * t;
		if (t < tAcc + tCruise) return dAcc + vmax * (t - tAcc);
		const td = t - tAcc - tCruise;
		return dAcc + vmax * tCruise + vmax * td - 0.5 * a * td * td;
	}
	const half = total / 2, vPeak = a * half;
	if (t < half) return 0.5 * a * t * t;
	const td = t - half;
	return len / 2 + vPeak * td - 0.5 * a * td * td;
}

/** Precomputes the run of one direction: stop positions and arrival/departure offsets. */
export function makeRun(route, line) {
	const cum = route.cum || cumulative(route.pts);
	const length = cum[cum.length - 1];
	const stops = route.stops && route.stops.length >= 2 ? route.stops : [{ name: '', s: 0 }, { name: '', s: length }];
	const legs = [];
	let t = 0;
	// Start at the first stop; anything before it is depot running and is skipped.
	for (let k = 0; k < stops.length; k++) {
		const arrive = t;
		const depart = k === stops.length - 1 ? arrive : arrive + line.dwell;
		legs.push({ stop: k, s: stops[k].s, arrive, depart });
		if (k + 1 < stops.length) t = depart + segmentTime(Math.max(1, stops[k + 1].s - stops[k].s), line.vmax, line.accel);
	}
	return { route, line, cum, stops, legs, duration: legs[legs.length - 1].arrive, length };
}

/** State of a vehicle `elapsed` seconds after leaving the first stop. */
export function runStateAt(run, elapsed) {
	const legs = run.legs;
	if (elapsed <= 0) return { s: legs[0].s, atStop: 0, nextStop: 1, speed: 0 };
	for (let k = 0; k < legs.length; k++) {
		const L = legs[k];
		if (elapsed <= L.depart) return { s: L.s, atStop: k, nextStop: Math.min(k + 1, legs.length - 1), speed: 0, leavesIn: L.depart - elapsed };
		if (k + 1 < legs.length && elapsed < legs[k + 1].arrive) {
			const len = legs[k + 1].s - L.s;
			const tt = elapsed - L.depart;
			const s = L.s + segmentDistance(Math.max(1, len), run.line.vmax, run.line.accel, tt);
			return { s, atStop: -1, nextStop: k + 1, speed: run.line.vmax };
		}
	}
	const last = legs[legs.length - 1];
	return { s: last.s, atStop: legs.length - 1, nextStop: legs.length - 1, speed: 0, finished: true };
}

/**
 * Departure times (seconds of the local service day, which starts at 03:00) for one direction.
 * `offset` staggers the two directions.
 */
export function departures(line, weekend, offset = 0) {
	const out = [];
	let t = 3 * 3600 + offset;
	const end = 27 * 3600;
	while (t < end) {
		const h = (t / 3600) % 24;
		const hw = headwayAt(line, h, weekend);
		if (hw == null) {
			t += 300;
			continue;
		}
		out.push(t);
		t += hw * 60;
	}
	return out;
}

/** Vehicles of one run on the road at local service-day second `now`. */
export function activeVehicles(run, deps, now) {
	const list = [];
	for (let i = 0; i < deps.length; i++) {
		const e = now - deps[i];
		if (e < -60) break;
		if (e >= -60 && e <= run.duration + 30) list.push({ index: i, elapsed: e, state: runStateAt(run, e) });
	}
	return list;
}

/** Point and heading at distance s along a polyline: [x, z, yaw]. */
export function pointAt(pts, cum, s) {
	if (s <= 0) return [pts[0][0], pts[0][1], Math.atan2(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1])];
	let lo = 0, hi = cum.length - 1;
	if (s >= cum[hi]) {
		const a = pts[hi - 1], b = pts[hi];
		return [b[0], b[1], Math.atan2(b[0] - a[0], b[1] - a[1])];
	}
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (cum[mid] <= s) lo = mid;
		else hi = mid;
	}
	const a = pts[lo], b = pts[hi];
	const k = (s - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]);
	return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, Math.atan2(b[0] - a[0], b[1] - a[1])];
}

/** Seconds since 03:00 local time (the BKK service day), plus the weekend flag for that service day. */
export function serviceClock(localHours, dayIndex) {
	const h = localHours < 3 ? localHours + 24 : localHours;
	const serviceDay = localHours < 3 ? (dayIndex + 6) % 7 : dayIndex;
	return { seconds: h * 3600, weekend: serviceDay === 0 || serviceDay === 6 };
}
