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

// Skin tones from light to deep. A mixed city population with plenty of darker tones (the VIII.
// district has a large Roma community and many residents with African and Asian roots). Values are
// sRGB albedo, kept warm and saturated so shading never turns them grey.
export const SKIN_TONES = [
	{ hex: '#f0cfb6', w: 0.13 }, { hex: '#e3b892', w: 0.15 }, { hex: '#d29f76', w: 0.14 }, { hex: '#bb8559', w: 0.14 },
	{ hex: '#a26b42', w: 0.14 }, { hex: '#875433', w: 0.12 }, { hex: '#6a3f25', w: 0.1 }, { hex: '#4a2b19', w: 0.08 },
];
const HAIR = ['#141110', '#1f1813', '#2e2219', '#4a3424', '#6b4c33', '#9c7a4d', '#b9b2a8', '#d9d4ca'];
const HAIR_W = [0.24, 0.24, 0.2, 0.13, 0.09, 0.05, 0.03, 0.02];
const HAIR_OLD = ['#6d6964', '#8f8a84', '#aaa59e', '#c8c4bc', '#dedad2'];
const HAIR_DYED = ['#7a2a1e', '#a8673a', '#c9a77a', '#3a1d2e'];
// October in Budapest: mostly dark outerwear with a few accents.
const COATS = ['#16171a', '#1e2026', '#24282f', '#2b2e35', '#1f2a3a', '#283650', '#2f3b2c', '#3b3a2a', '#3a2a22', '#4a3326', '#6b4f36', '#8a6a4a', '#9c8a6e', '#5a1f24', '#3c4a55', '#4d4f52', '#6b6f73', '#7a2e1f', '#2d4a3e', '#c9c3b6'];
const PUFFERS = ['#111214', '#15171b', '#1a1d24', '#202a3a', '#2e3a2c', '#3d3f44', '#7c6a52', '#8a1f1f', '#1f3b5a', '#c8c2b4', '#4a4a2e'];
const SPORT = ['#151515', '#1d1d20', '#2b2b2e', '#3a3d42', '#6e7177', '#1d2b4a', '#5a1a22', '#2f4b3a', '#8a8d91', '#c9c9c9'];
const KNITS = ['#5a4632', '#7a6a58', '#3a2f2a', '#6b2a2a', '#2e3a4a', '#8c7b62', '#a89a84', '#4a4f3a'];
const JEANS = ['#1d2a44', '#26385a', '#2f4670', '#3a5580', '#1a1d24', '#2b2b2e', '#4a5a72', '#53627a'];
const TROUSERS = ['#151618', '#22252b', '#2e2b26', '#3d3a33', '#4a4438', '#2a3140', '#5a5348', '#6b6253'];
const TRACK = ['#121212', '#1c1f2a', '#2a2a2e', '#3a3d42'];
const SKIRTS = ['#141414', '#2a2a2e', '#3a2a22', '#4a2b2e', '#2b3442', '#5a4a3a', '#7a6a58', '#6b5a2a'];
const TIGHTS = ['#101012', '#17171b', '#221d1b', '#2e2420'];
const SNEAKERS = ['#f0f0ee', '#e4e2dc', '#1a1a1a', '#2a2d33', '#7a7d82', '#c9c3b6', '#e8e8e8'];
const BOOTS = ['#1a1512', '#2a1f18', '#3a2a1e', '#141414', '#4a3424'];
const DRESS = ['#141414', '#2a1d15', '#1c1612'];
const ACCENTS = ['#7a1f24', '#b5762a', '#2f4b3a', '#d8d2c4', '#3a4a6b', '#6b6f73', '#141414', '#8a3a2a', '#c9a227', '#4a2a4a', '#9c5a2a', '#1f3b5a', '#a3a09a'];
const BAGS = ['#141414', '#1c1814', '#2a1f18', '#5a3d2b', '#3a3d42', '#7a5a3a', '#1d2a44', '#6b2a2a'];

function pick(list, r) {
	return list[Math.floor(r() * list.length)];
}

function pickWeighted(list, r) {
	let x = r() * list.reduce((s, e) => s + e.w, 0);
	for (const e of list) if ((x -= e.w) <= 0) return e;
	return list[list.length - 1];
}

/** Index from a list of weights. */
function choose(weights, r) {
	let x = r() * weights.reduce((s, w) => s + w, 0);
	for (let i = 0; i < weights.length; i++) if ((x -= weights[i]) <= 0) return i;
	return weights.length - 1;
}

/** Normal-ish random number (sum of three uniforms), mean 0, sd ~1. */
const gauss = (r) => (r() + r() + r() - 1.5) * 2;

// Style codes shared with game/people/body.js (kept as numbers here so the simulation has no
// rendering imports): hair 0 buzz, 1 short, 2 long, 3 ponytail, 4 bun, 5 curly, 6 bald;
// headwear 0 none, 1 cap, 2 beanie, 3 headscarf; upper 0 jacket, 1 puffer, 2 coat, 3 hoodie,
// 4 tracksuit top, 5 knit; lower 0 jeans, 1 trousers, 2 skirt + tights, 3 tracksuit; shoes
// 0 sneakers, 1 boots, 2 dress shoes; acc bits 1 scarf, 2 backpack, 4 cross-body bag, 8 shopping
// bag, 16 walking stick, 32 glasses, 64 stubble, 128 beard; walk 0 normal, 1 texting, 2 phone at
// the ear, 3 hands in pockets; idle 0 standing, 1 texting, 2 phoning, 3 pockets, 4 arms crossed,
// 5 smoking.

/**
 * How a person looks (and only that: behaviour comes from Crowd.behaviourRandom, a separate stream).
 * Mid-October Budapest street clothing; a diverse population.
 */
export function makeLook(seed) {
	const r = rng(hashString('look:' + seed));
	const age = r();
	const elderly = age > 0.85, teen = age < 0.12;
	const female = r() < 0.51;
	const skin = pickWeighted(SKIN_TONES, r).hex;
	const ageK = elderly ? 0.45 + r() * 0.55 : 0;
	// Heights: men ~177 cm, women ~164 cm (Hungarian averages), teens a bit shorter, elderly stoop.
	let height = female ? 1.645 + gauss(r) * 0.06 : 1.772 + gauss(r) * 0.068;
	if (teen) height -= 0.04 + r() * 0.06;
	if (elderly) height -= 0.03;
	height = Math.min(1.98, Math.max(1.47, height));
	const heavy = Math.max(-0.45, Math.min(1, (r() + r()) * 0.75 - 0.55 + (elderly ? 0.2 : 0) - (teen ? 0.25 : 0)));
	const fem = female ? 0.86 + r() * 0.14 : r() * 0.1;
	// Hair.
	let hairStyle = female
		? [2, 3, 4, 1, 5, 0][choose([0.38, 0.2, 0.15, 0.14, 0.11, 0.02], r)]
		: [0, 1, 5, 6, 2, 3][choose([0.3, 0.42, 0.08, elderly ? 0.35 : 0.08, 0.04, 0.02], r)];
	let hair = elderly ? pick(HAIR_OLD, r) : HAIR[choose(HAIR_W, r)];
	if (!elderly && female && r() < 0.12) hair = pick(HAIR_DYED, r);
	// Headwear (cold mornings: beanies; caps on young men; headscarves for some women).
	let headwear = 0;
	const hw = r();
	if (female && hw < (elderly ? 0.1 : 0.025)) headwear = 3;
	else if (hw < 0.14) headwear = 2;
	else if (!female && hw < (teen ? 0.3 : 0.2)) headwear = 1;
	// Clothes.
	const upper = choose([0.3, 0.2, female || elderly ? 0.22 : 0.12, teen ? 0.3 : 0.12, teen ? 0.12 : 0.06, 0.1], r);
	let lower = female ? choose([0.4, 0.27, elderly ? 0.3 : 0.22, 0.08], r) : choose([0.5, 0.36, 0, upper === 4 ? 0.9 : 0.12], r);
	if (upper === 4 && r() < 0.6 && lower !== 2) lower = 3;
	const shoeStyle = choose([teen ? 0.9 : 0.6, female ? 0.3 : 0.2, elderly ? 0.35 : 0.12], r);
	const topList = [COATS, PUFFERS, COATS, SPORT, SPORT, KNITS][upper];
	const top = pick(topList, r);
	const bottomList = [JEANS, TROUSERS, SKIRTS, TRACK][lower];
	const bottom = pick(bottomList, r);
	const legs = lower === 2 ? pick(TIGHTS, r) : bottom;
	const shoes = pick([SNEAKERS, BOOTS, DRESS][shoeStyle], r);
	const accent = pick(ACCENTS, r);
	const bag = pick(BAGS, r);
	// Accessories.
	let acc = 0;
	if (r() < (upper === 2 ? 0.4 : 0.15)) acc |= 1;
	if (r() < (teen ? 0.5 : elderly ? 0.03 : 0.18)) acc |= 2;
	if (r() < (female ? 0.38 : 0.07) && !(acc & 2)) acc |= 4;
	if (r() < (elderly ? 0.3 : 0.1)) acc |= 8;
	if (elderly && r() < 0.25) acc |= 16;
	if (r() < (elderly ? 0.5 : 0.17)) acc |= 32;
	if (!female && !teen) { const b = r(); if (b < 0.16) acc |= 128; else if (b < 0.42) acc |= 64; }
	// Habits (looks only: never read by the danger system).
	let walkStyle = choose([0.66, teen ? 0.3 : 0.14, 0.05, female ? 0.06 : 0.15], r);
	if (acc & 24) walkStyle = walkStyle === 3 ? 3 : 0;
	const idleStyle = choose([0.3, 0.25, 0.07, 0.18, 0.1, elderly ? 0.03 : 0.08], r);
	if (headwear === 3) hairStyle = 2;
	return {
		skin, hair, top, bottom, legs, shoes, accent, bag,
		height, build: 0.9 + heavy * 0.2, heavy, fem, age: ageK,
		hairStyle, headwear, upper, lower, shoeStyle, acc, walkStyle, idleStyle,
		longHair: hairStyle === 2 || hairStyle === 3,
		cap: headwear === 1,
		female, elderly, teen,
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
