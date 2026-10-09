// Pedestrian simulation (no rendering): a walkable graph from the OSM streets, a district-wide
// population that follows the time of day, and per-person looks.
//
// Looks and behaviour come from two SEPARATE random streams, so how someone looks never decides
// how they behave (tests/web/crowd.test.mjs checks this).

import { rng, hashString } from './geo.js';

// ---------------------------------------------------------------- walk graph

const WALKABLE = new Set(['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential',
	'living_street', 'unclassified', 'service', 'pedestrian', 'footway', 'path', 'steps', 'cycleway', 'track']);
const CARRIAGEWAY = new Set(['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential', 'living_street', 'unclassified', 'service']);

export function buildWalkGraph(roads) {
	const key = (p) => `${Math.round(p[0] * 2)},${Math.round(p[1] * 2)}`;
	const index = new Map();
	const nodes = [];
	const adj = [];
	const node = (p) => {
		const k = key(p);
		let i = index.get(k);
		if (i === undefined) {
			i = nodes.length;
			index.set(k, i);
			nodes.push([p[0], p[1]]);
			adj.push([]);
		}
		return i;
	};
	for (const r of roads) {
		if (!WALKABLE.has(r.cls) || r.foot === false) continue;
		// Pavements sit just outside the carriageway; footpaths are walked down the middle.
		const offset = CARRIAGEWAY.has(r.cls) ? r.width / 2 + 1.6 : 0.3;
		const weight = r.cls === 'primary' || r.cls === 'secondary' ? 3 : r.cls === 'pedestrian' ? 3 : r.cls === 'tertiary' ? 2.5 : r.cls === 'footway' ? 1.2 : 1.6;
		for (let i = 0; i + 1 < r.pts.length; i++) {
			const a = node(r.pts[i]), b = node(r.pts[i + 1]);
			if (a === b) continue;
			adj[a].push({ to: b, offset, weight, name: r.name });
			adj[b].push({ to: a, offset, weight, name: r.name });
		}
	}
	// Spatial grid for "nearest node" queries.
	const cell = 40;
	const grid = new Map();
	nodes.forEach(([x, z], i) => {
		if (!adj[i].length) return;
		const k = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
		if (!grid.has(k)) grid.set(k, []);
		grid.get(k).push(i);
	});
	const nearest = (x, z, maxR = 200) => {
		let best = -1, bestD = Infinity;
		const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
		for (let r = 0; r * cell <= maxR + cell; r++) {
			for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
				if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
				for (const i of grid.get(`${cx + dx},${cz + dz}`) || []) {
					const d = (nodes[i][0] - x) ** 2 + (nodes[i][1] - z) ** 2;
					if (d < bestD) { bestD = d; best = i; }
				}
			}
			if (best >= 0 && Math.sqrt(bestD) < r * cell) break;
		}
		return best;
	};
	const usable = nodes.map((_, i) => i).filter((i) => adj[i].length);
	return { nodes, adj, nearest, usable };
}

// ---------------------------------------------------------------- looks

// Skin tones from light to deep. A mixed city population with plenty of darker tones.
export const SKIN_TONES = [
	{ hex: '#f2d3bd', w: 0.13 }, { hex: '#e6bc98', w: 0.15 }, { hex: '#d6a37c', w: 0.14 }, { hex: '#c08b62', w: 0.14 },
	{ hex: '#a8714a', w: 0.14 }, { hex: '#8d5a3b', w: 0.12 }, { hex: '#6e432a', w: 0.1 }, { hex: '#4e2f1e', w: 0.08 },
];
const HAIR = ['#141110', '#1f1813', '#2e2219', '#4a3424', '#6b4c33', '#9c7a4d', '#b9b2a8', '#d9d4ca'];
const TOPS = ['#1c1c1f', '#26303f', '#3a3a3e', '#4b5243', '#5c2a2e', '#6d6a64', '#2f4a63', '#7a5c3c', '#8e8e90', '#a33b2f', '#2e5e4e', '#c9b48a', '#e6e2da', '#3d2f4f'];
const BOTTOMS = ['#1a1a1c', '#22324a', '#2f4d73', '#3b3b3b', '#4a4238', '#5e5a50', '#b8a88a'];
const SHOES = ['#111111', '#2a2a2a', '#e8e8e8', '#5a4030'];

function pick(list, r) {
	return list[Math.floor(r() * list.length)];
}

function pickWeighted(list, r) {
	let x = r() * list.reduce((s, e) => s + e.w, 0);
	for (const e of list) if ((x -= e.w) <= 0) return e;
	return list[list.length - 1];
}

export function makeLook(seed) {
	const r = rng(hashString('look:' + seed));
	const age = r();
	const elderly = age > 0.85, teen = age < 0.12;
	return {
		skin: pickWeighted(SKIN_TONES, r).hex,
		hair: elderly ? pick(HAIR.slice(6), r) : pick(HAIR.slice(0, 6), r),
		top: pick(TOPS, r),
		bottom: pick(BOTTOMS, r),
		shoes: pick(SHOES, r),
		height: (teen ? 1.55 : 1.6) + r() * (teen ? 0.2 : 0.32),
		build: 0.85 + r() * 0.35,
		longHair: r() < 0.35,
		cap: r() < 0.12,
		elderly,
		teen,
	};
}

// ---------------------------------------------------------------- behaviour

/** Fraction of the peak population that is out at a local Budapest hour (a plausible daily rhythm). */
export function densityForHour(h) {
	const t = [0.10, 0.07, 0.05, 0.04, 0.05, 0.10, 0.25, 0.60, 0.90, 0.70, 0.60, 0.65, 0.85, 0.80, 0.65, 0.68, 0.85, 1.00, 0.95, 0.80, 0.60, 0.45, 0.30, 0.18];
	const w = ((h % 24) + 24) % 24;
	const i = Math.floor(w);
	return t[i] + (t[(i + 1) % 24] - t[i]) * (w - i);
}

export const ROLE = { WALKER: 0, LOITERER: 1, VENDOR: 2 };
export const STATE = { WALK: 0, IDLE: 1, FLEE: 2, APPROACH: 3, KNOCKED: 4, STUNNED: 5 };

/**
 * District-wide crowd. Each person walks graph edges on a pavement offset; numbers follow the clock.
 * Arrays are struct-of-arrays for speed (thousands of people are updated every frame).
 */
export class Crowd {
	constructor(graph, capacity, seed = 1) {
		this.g = graph;
		this.cap = capacity;
		this.rand = rng(seed);
		this.n = 0;
		this.id = new Int32Array(capacity);
		this.from = new Int32Array(capacity);
		this.to = new Int32Array(capacity);
		this.t = new Float32Array(capacity); // metres travelled along the current edge
		this.len = new Float32Array(capacity);
		this.speed = new Float32Array(capacity);
		this.side = new Float32Array(capacity);
		this.offset = new Float32Array(capacity);
		this.x = new Float32Array(capacity);
		this.z = new Float32Array(capacity);
		this.yaw = new Float32Array(capacity);
		this.phase = new Float32Array(capacity);
		this.role = new Uint8Array(capacity);
		this.state = new Uint8Array(capacity);
		this.timer = new Float32Array(capacity);
		this.nextId = 1;
		this.threat = null; // {x, z, until}
	}

	/** Behaviour random stream for a person: independent of makeLook(id). */
	behaviourRandom(id) {
		return rng(hashString('behaviour:' + id));
	}

	spawn(role = ROLE.WALKER, node = -1) {
		if (this.n >= this.cap || !this.g.usable.length) return -1;
		const i = this.n++;
		const id = this.nextId++;
		const br = this.behaviourRandom(id);
		this.id[i] = id;
		this.role[i] = role;
		this.state[i] = role === ROLE.WALKER ? STATE.WALK : STATE.IDLE;
		this.speed[i] = 1.05 + br() * 0.6;
		this.side[i] = br() < 0.5 ? -1 : 1;
		this.phase[i] = br() * 10;
		this.timer[i] = role === ROLE.LOITERER ? 30 + br() * 240 : 0;
		const start = node >= 0 ? node : this.g.usable[Math.floor(this.rand() * this.g.usable.length)];
		this.from[i] = start;
		this.to[i] = this.pickNext(-1, start, br);
		this.t[i] = role === ROLE.WALKER ? this.rand() * 0.9 : 0;
		this.setEdge(i);
		this.t[i] *= this.len[i];
		this.place(i);
		return i;
	}

	remove(i) {
		const last = --this.n;
		if (i !== last) for (const arr of [this.id, this.from, this.to, this.t, this.len, this.speed, this.side, this.offset, this.x, this.z, this.yaw, this.phase, this.role, this.state, this.timer]) arr[i] = arr[last];
	}

	setEdge(i) {
		const a = this.g.nodes[this.from[i]], b = this.g.nodes[this.to[i]];
		this.len[i] = Math.max(0.01, Math.hypot(b[0] - a[0], b[1] - a[1]));
		const e = this.g.adj[this.from[i]].find((ed) => ed.to === this.to[i]);
		this.offset[i] = e ? e.offset : 0.3;
	}

	pickNext(from, cur, r = this.rand) {
		const edges = this.g.adj[cur];
		if (!edges.length) return cur;
		const options = edges.filter((e) => e.to !== from);
		if (!options.length) return edges[0].to; // dead end: turn round
		if (this.threat) {
			// Fleeing: prefer the neighbour farthest from the danger.
			let best = options[0], bestD = -1;
			for (const e of options) {
				const [x, z] = this.g.nodes[e.to];
				const d = (x - this.threat.x) ** 2 + (z - this.threat.z) ** 2;
				if (d > bestD) { bestD = d; best = e; }
			}
			if (r() < 0.8) return best.to;
		}
		let total = 0;
		for (const e of options) total += e.weight;
		let x = r() * total;
		for (const e of options) if ((x -= e.weight) <= 0) return e.to;
		return options[options.length - 1].to;
	}

	place(i) {
		const a = this.g.nodes[this.from[i]], b = this.g.nodes[this.to[i]];
		const k = this.t[i] / this.len[i];
		const dx = (b[0] - a[0]) / this.len[i], dz = (b[1] - a[1]) / this.len[i];
		// Right-hand perpendicular in x/z, times side and pavement offset.
		const o = this.offset[i] * this.side[i];
		this.x[i] = a[0] + (b[0] - a[0]) * k - dz * o;
		this.z[i] = a[1] + (b[1] - a[1]) * k + dx * o;
		this.yaw[i] = Math.atan2(dx, dz);
	}

	step(dt, now) {
		const fleeing = this.threat && now < this.threat.until;
		if (this.threat && !fleeing) this.threat = null;
		for (let i = 0; i < this.n; i++) {
			const st = this.state[i];
			if (st === STATE.KNOCKED || st === STATE.STUNNED) {
				this.timer[i] -= dt;
				if (this.timer[i] <= 0) this.state[i] = STATE.FLEE;
				continue;
			}
			if (st === STATE.APPROACH) continue; // driven by the danger system
			if (st === STATE.IDLE) {
				this.phase[i] += dt * 0.3;
				if (this.role[i] === ROLE.VENDOR) continue;
				this.timer[i] -= dt;
				if (this.timer[i] > 0 && !(fleeing && this.near(i, this.threat, 45))) continue;
				this.state[i] = STATE.WALK;
			}
			let v = this.speed[i];
			if (st === STATE.FLEE || (fleeing && this.near(i, this.threat, 60))) {
				v *= 2.8;
				this.state[i] = STATE.FLEE;
			}
			this.t[i] += v * dt;
			this.phase[i] += v * dt * 1.7;
			while (this.t[i] >= this.len[i]) {
				this.t[i] -= this.len[i];
				const cur = this.to[i];
				this.to[i] = this.pickNext(this.from[i], cur);
				this.from[i] = cur;
				this.setEdge(i);
				if (this.state[i] === STATE.FLEE && !fleeing && this.rand() < 0.2) this.state[i] = STATE.WALK;
			}
			this.place(i);
		}
	}

	near(i, p, r) {
		return p && (this.x[i] - p.x) ** 2 + (this.z[i] - p.z) ** 2 < r * r;
	}

	/**
	 * Grows or shrinks the population gradually towards `target` walkers. With a `focus`
	 * ({x, z, r, share}) the crowd is kept dense around the player: about `share` of everyone walks
	 * within `r` metres of the focus, and people far away are quietly moved closer (never within 45 m,
	 * so nobody pops into existence in front of you).
	 */
	balance(target, perStep = 20, focus = null) {
		let walkers = 0, near = 0;
		const r2 = focus ? focus.r * focus.r : 0;
		for (let i = 0; i < this.n; i++) {
			if (this.role[i] === ROLE.VENDOR) continue;
			walkers++;
			if (focus && (this.x[i] - focus.x) ** 2 + (this.z[i] - focus.z) ** 2 < r2) near++;
		}
		const wantNear = focus ? Math.round(target * focus.share) : 0;
		const spawnOne = () => {
			const role = this.rand() < 0.12 ? ROLE.LOITERER : ROLE.WALKER;
			if (focus && near < wantNear) {
				const node = this.nodeNear(focus.x, focus.z, 45, focus.r);
				if (node >= 0) { near++; return this.spawn(role, node); }
			}
			return this.spawn(role);
		};
		for (let k = 0; k < perStep && walkers < target; k++, walkers++) spawnOne();
		for (let k = 0; k < perStep && walkers > target; k++) {
			const i = this.pickRemovable(focus);
			if (i < 0) break;
			this.remove(i);
			walkers--;
		}
		// Population is right but too thin around the player: relocate far walkers.
		if (focus && near < wantNear) {
			for (let k = 0; k < Math.min(perStep, wantNear - near); k++) {
				const i = this.pickRemovable(focus, true);
				if (i < 0) break;
				this.remove(i);
				spawnOne();
			}
		}
	}

	/** A random usable node between minR and maxR from (x, z), or -1. */
	nodeNear(x, z, minR, maxR) {
		const u = this.g.usable;
		for (let attempt = 0; attempt < 40; attempt++) {
			const node = u[Math.floor(this.rand() * u.length)];
			const d2 = (this.g.nodes[node][0] - x) ** 2 + (this.g.nodes[node][1] - z) ** 2;
			if (d2 >= minR * minR && d2 <= maxR * maxR) return node;
		}
		// Sparse graph: take the nearest node to a random point on the ring.
		const a = this.rand() * Math.PI * 2, d = minR + this.rand() * (maxR - minR);
		const node = this.g.nearest(x + Math.cos(a) * d, z + Math.sin(a) * d, maxR);
		return node;
	}

	/** Someone who can leave: far from the focus first, never vendors or people in an encounter. */
	pickRemovable(focus, farOnly = false) {
		for (let attempt = 0; attempt < 30; attempt++) {
			const i = Math.floor(this.rand() * this.n);
			if (this.role[i] === ROLE.VENDOR || this.state[i] === STATE.APPROACH) continue;
			if (!focus) return i;
			const d2 = (this.x[i] - focus.x) ** 2 + (this.z[i] - focus.z) ** 2;
			if (d2 > (focus.r * 1.6) ** 2) return i;
			if (!farOnly && attempt > 20) return i;
		}
		return -1;
	}

	alarm(x, z, seconds = 20, now = 0) {
		this.threat = { x, z, until: now + seconds };
	}
}
