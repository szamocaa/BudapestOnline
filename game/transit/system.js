// Combines line geometry, the timetable model and live BKK positions into one list of vehicles.
import { LINE_DEFAULTS, makeRun, departures, activeVehicles, pointAt, serviceClock, headwayAt, runStateAt } from './schedule.js';
import { cumulative, projectOnLine } from '../osm.js';

const LIVE_FRESH_S = 120;

function angleDiff(a, b) {
	let d = (a - b) % (Math.PI * 2);
	if (d > Math.PI) d -= Math.PI * 2;
	if (d < -Math.PI) d += Math.PI * 2;
	return Math.abs(d);
}

export class TransitSystem {
	/** lines: [{ ref, mode, colour, text, name, directions: [{ headsign, pts, cum?, stops }] }] */
	constructor(lines) {
		this.lines = lines.map((l) => {
			const cfg = { ...(LINE_DEFAULTS[l.ref] || LINE_DEFAULTS['99']) };
			if (l.colour) cfg.colour = l.colour;
			if (l.text) cfg.text = l.text;
			const directions = l.directions.map((d, i) => {
				const cum = d.cum || cumulative(d.pts);
				// Stops need world positions for "which stop am I at" queries; derive missing ones from s.
				const stops = (d.stops || []).map((st) => (st.x != null ? st : { ...st, x: pointAt(d.pts, cum, st.s)[0], z: pointAt(d.pts, cum, st.s)[1] }));
				const dir = { ...d, stops, cum, length: cum[cum.length - 1], index: i };
				dir.run = makeRun({ pts: d.pts, cum, stops }, cfg);
				return dir;
			});
			return { ...l, cfg, directions };
		});
		this.byRef = new Map(this.lines.map((l) => [l.ref, l]));
		this.depCache = new Map();
		this.live = new Map(); // vehicle id -> state
		this.liveAt = new Map(); // ref -> last unix time with live data
		this.vehicles = [];
	}

	deps(line, dir, weekend) {
		const key = `${line.ref}:${dir.index}:${weekend}`;
		if (!this.depCache.has(key)) {
			const hw = headwayAt(line.cfg, 12, weekend) || 10;
			this.depCache.set(key, departures(line.cfg, weekend, dir.index * hw * 30));
		}
		return this.depCache.get(key);
	}

	/** Feed a fresh live snapshot (from BkkClient.vehicles). */
	setLive(list, unix) {
		const seen = new Set();
		for (const v of list) {
			const line = this.byRef.get(v.ref);
			if (!line) continue;
			this.liveAt.set(v.ref, unix);
			seen.add(v.id);
			const match = this.matchDirection(line, v);
			let st = this.live.get(v.id);
			if (!st) {
				st = { id: v.id, ref: v.ref, dir: match.dir, s: match.s, targetS: match.s, x: v.x, z: v.z, yaw: 0, onRoute: match.onRoute };
				this.live.set(v.id, st);
			}
			if (st.dir !== match.dir || Math.abs(match.s - st.s) > 400) st.s = match.s;
			Object.assign(st, { dir: match.dir, targetS: match.s, rawX: v.x, rawZ: v.z, bearing: v.bearing, headsign: v.headsign, status: v.status, onRoute: match.onRoute, updated: unix, model: v.model, plate: v.plate });
		}
		for (const [id, st] of this.live) if (!seen.has(id) && unix - st.updated > LIVE_FRESH_S) this.live.delete(id);
	}

	matchDirection(line, v) {
		let best = null;
		const yaw = v.bearing != null ? (v.bearing * Math.PI) / 180 : null; // compass bearing -> world yaw (atan2(dx, dz) uses +z south)
		for (const dir of line.directions) {
			const pr = projectOnLine(dir.pts, dir.cum, v.x, v.z);
			if (!pr) continue;
			let score = pr.dist;
			if (v.headsign && dir.headsign && v.headsign === dir.headsign) score -= 40;
			if (yaw != null) {
				const a = dir.pts[pr.seg], b = dir.pts[pr.seg + 1];
				const segYaw = Math.atan2(b[0] - a[0], -(b[1] - a[1])); // compass-style: 0 = north (-z)
				score += angleDiff(segYaw, yaw) > Math.PI / 2 ? 35 : 0;
			}
			if (!best || score < best.score) best = { dir: dir.index, s: pr.s, score, onRoute: pr.dist < 60 };
		}
		return best || { dir: 0, s: 0, onRoute: false };
	}

	liveFor(ref, unix) {
		const t = this.liveAt.get(ref);
		return t != null && unix - t < LIVE_FRESH_S;
	}

	update(dt, unix, localHours, dayIndex) {
		const { seconds, weekend } = serviceClock(localHours, dayIndex);
		const out = [];
		for (const line of this.lines) {
			if (this.liveFor(line.ref, unix)) continue; // live data replaces the timetable for this line
			for (const dir of line.directions) {
				const deps = this.deps(line, dir, weekend);
				for (const v of activeVehicles(dir.run, deps, seconds)) {
					if (v.state.finished) continue;
					const [x, z, yaw] = pointAt(dir.pts, dir.cum, v.state.s);
					const atStop = v.state.atStop >= 0 && v.elapsed >= 0;
					out.push({
						key: `${line.ref}:${dir.index}:${v.index}:${weekend}`,
						ref: line.ref, line, dir, s: v.state.s, x, z, yaw,
						atStop, stopName: atStop ? dir.run.stops[v.state.atStop].name : '',
						nextStop: dir.run.stops[v.state.nextStop] ? dir.run.stops[v.state.nextStop].name : '',
						leavesIn: v.state.leavesIn || 0,
						headsign: dir.headsign, live: false, speed: v.state.speed,
					});
				}
			}
		}
		for (const st of this.live.values()) {
			const line = this.byRef.get(st.ref);
			if (!line) continue;
			const dir = line.directions[st.dir];
			let x, z, yaw;
			if (st.onRoute && dir) {
				// Glide towards the reported position along the line, no faster than the vehicle could drive.
				// GPS jitter can report a few metres behind: wait instead of reversing; snap on big jumps.
				const diff = st.targetS - st.s;
				if (diff < -30) st.s = st.targetS;
				const step = diff > 0 ? Math.min(diff, line.cfg.vmax * 1.4 * dt) : 0;
				st.s += step;
				st.speed = step / Math.max(dt, 1e-3);
				[x, z, yaw] = pointAt(dir.pts, dir.cum, st.s);
			} else {
				x = st.rawX; z = st.rawZ;
				yaw = st.bearing != null ? Math.PI - (st.bearing * Math.PI) / 180 : 0;
				st.speed = 0;
			}
			let stopName = '', nextStop = '';
			if (dir) {
				const near = dir.stops.find((s) => Math.abs(s.s - st.s) < 25);
				const nxt = dir.stops.find((s) => s.s > st.s);
				if (near && (st.status === 'STOPPED_AT' || st.speed < 0.5)) stopName = near.name;
				nextStop = nxt ? nxt.name : '';
			}
			out.push({
				key: 'live:' + st.id, ref: st.ref, line, dir, s: st.s, x, z, yaw,
				atStop: !!stopName, stopName, nextStop, leavesIn: stopName ? 15 : 0,
				headsign: st.headsign || (dir && dir.headsign) || '', live: true, speed: st.speed, model: st.model, plate: st.plate,
			});
		}
		this.vehicles = out;
		return out;
	}

	/** Vehicle the player can get on: standing at a stop within reach. */
	boardable(px, pz, reach = 9) {
		let best = null, bestD = reach * reach;
		for (const v of this.vehicles) {
			if (v.line.mode === 'metro' || !v.atStop) continue;
			const d = (v.x - px) ** 2 + (v.z - pz) ** 2;
			if (d < bestD) { bestD = d; best = v; }
		}
		return best;
	}

	/** Upcoming departures at the stop nearest to (x, z) within 40 m: [{ ref, headsign, minutes, live }]. */
	departuresNear(x, z, unix, localHours, dayIndex) {
		const { seconds, weekend } = serviceClock(localHours, dayIndex);
		let stopName = null, bestD = 40 * 40;
		for (const line of this.lines) for (const dir of line.directions) for (const st of dir.stops) {
			if (line.mode === 'metro') continue;
			const d = (st.x - x) ** 2 + (st.z - z) ** 2;
			if (d < bestD) { bestD = d; stopName = st.name; }
		}
		if (!stopName) return null;
		const list = [];
		for (const line of this.lines) {
			if (line.mode === 'metro') continue;
			for (const dir of line.directions) {
				const k = dir.run.stops.findIndex((s) => s.name === stopName);
				if (k < 0 || k === dir.run.stops.length - 1) continue;
				const leg = dir.run.legs[k];
				const deps = this.deps(line, dir, weekend);
				for (const dep of deps) {
					const at = dep + leg.depart;
					if (at >= seconds - 10) {
						list.push({ ref: line.ref, headsign: dir.headsign, minutes: Math.max(0, Math.round((at - seconds) / 60)), live: false });
						break;
					}
				}
			}
		}
		list.sort((a, b) => a.minutes - b.minutes);
		return { stopName, list };
	}

	/** Seconds until the next metro train of line `ref` departs the stop named `stopName` in direction index `dirIndex`. */
	nextTrain(ref, dirIndex, stopName, localHours, dayIndex) {
		const line = this.byRef.get(ref);
		if (!line || !line.directions[dirIndex]) return null;
		const { seconds, weekend } = serviceClock(localHours, dayIndex);
		const dir = line.directions[dirIndex];
		const k = dir.run.stops.findIndex((s) => s.name.startsWith(stopName));
		if (k < 0) return null;
		for (const dep of this.deps(line, dir, weekend)) {
			const at = dep + dir.run.legs[k].arrive;
			if (at >= seconds) return { wait: at - seconds, travelTo: (name) => {
				const j = dir.run.stops.findIndex((s) => s.name.startsWith(name));
				return j > k ? dir.run.legs[j].arrive - dir.run.legs[k].depart : null;
			} };
		}
		return null;
	}

	stateOf(key) {
		return this.vehicles.find((v) => v.key === key) || null;
	}
}

export { runStateAt };
