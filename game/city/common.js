// Shared helpers for the city builders (ground, buildings, props, landmarks) and the CityContext
// they all write into. Each builder module owns its own look; this file only holds the plumbing.
import * as THREE from '../vendor/three.module.min.js';

export function geometryFrom(buf, withColour = true) {
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
	g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nrm, 3));
	g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
	if (withColour) g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
	g.setIndex(buf.idx);
	g.computeBoundingSphere();
	return g;
}

export function hexToRgb(hex) {
	const c = new THREE.Color(hex);
	return [c.r, c.g, c.b];
}

/** Spatial index over line segments for collision and "what street am I on" queries. */
export class SegmentGrid {
	constructor(cell = 20) {
		this.cell = cell;
		this.map = new Map();
	}
	add(ax, az, bx, bz, data) {
		const c = this.cell;
		const seg = { ax, az, bx, bz, data };
		const x0 = Math.floor(Math.min(ax, bx) / c), x1 = Math.floor(Math.max(ax, bx) / c);
		const z0 = Math.floor(Math.min(az, bz) / c), z1 = Math.floor(Math.max(az, bz) / c);
		for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
			const k = x + ',' + z;
			if (!this.map.has(k)) this.map.set(k, []);
			this.map.get(k).push(seg);
		}
	}
	near(x, z, r) {
		const c = this.cell, out = new Set();
		for (let gx = Math.floor((x - r) / c); gx <= Math.floor((x + r) / c); gx++)
			for (let gz = Math.floor((z - r) / c); gz <= Math.floor((z + r) / c); gz++)
				for (const s of this.map.get(gx + ',' + gz) || []) out.add(s);
		return out;
	}
}

/** Uniform grid of points (circles) for small colliders and nearest-thing queries. */
export class PointGrid {
	constructor(cell = 25) {
		this.cell = cell;
		this.map = new Map();
		this.items = [];
	}
	add(x, z, data) {
		const k = Math.floor(x / this.cell) + ',' + Math.floor(z / this.cell);
		if (!this.map.has(k)) this.map.set(k, []);
		const item = { x, z, data };
		this.map.get(k).push(item);
		this.items.push(item);
		return item;
	}
	/** Items within r, nearest first, as [item, distanceSquared]. */
	near(x, z, r) {
		const c = this.cell, out = [];
		for (let gx = Math.floor((x - r) / c); gx <= Math.floor((x + r) / c); gx++)
			for (let gz = Math.floor((z - r) / c); gz <= Math.floor((z + r) / c); gz++)
				for (const it of this.map.get(gx + ',' + gz) || []) {
					const d = (it.x - x) ** 2 + (it.z - z) ** 2;
					if (d < r * r) out.push([it, d]);
				}
		return out.sort((a, b) => a[1] - b[1]);
	}
}

/** A polyline shifted sideways by d metres (positive = left of the direction of travel in x/z). */
export function offsetLine(pts, d) {
	const out = [];
	for (let i = 0; i < pts.length; i++) {
		const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
		const dx = b[0] - a[0], dz = b[1] - a[1];
		const l = Math.hypot(dx, dz) || 1;
		out.push([pts[i][0] - (dz / l) * d, pts[i][1] + (dx / l) * d]);
	}
	return out;
}

/** Calls fn(x, z, ux, uz, s) every `step` metres along a polyline (ux, uz = unit direction). */
export function alongLine(pts, step, fn, start = step / 2) {
	let acc = 0, next = start;
	for (let i = 0; i + 1 < pts.length; i++) {
		const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
		const len = Math.hypot(bx - ax, bz - az);
		if (len < 1e-6) continue;
		const ux = (bx - ax) / len, uz = (bz - az) / len;
		while (next <= acc + len) {
			const t = next - acc;
			fn(ax + ux * t, az + uz * t, ux, uz, next);
			next += step;
		}
		acc += len;
	}
}

/**
 * The shared state every city builder writes into. Builders add meshes under ctx.root, register
 * collision walls, night-lit materials and per-frame updaters here.
 */
export function createCityContext(scene, data, { quality = 'high' } = {}) {
	const root = new THREE.Group();
	root.name = 'city';
	scene.add(root);
	const ctx = {
		scene,
		root,
		data,
		quality, // 'low' | 'medium' | 'high'
		/** Building walls and other solid edges (segments): player collision and sign placement. */
		walls: new SegmentGrid(16),
		/** Small round obstacles (poles, trees, bins, kiosks...): player collision. */
		posts: new PointGrid(20),
		/** Named road centre lines: "which street am I on". */
		streets: new SegmentGrid(30),
		/** OSM building ids that a hand-made landmark replaces (buildings.js skips them). */
		suppressed: new Set(),
		/** Street lights: { x, z, y (height of the light), kind }. Filled by props.js. */
		lamps: [],
		nightMaterials: [],
		updaters: [],
		nightHooks: [],
		/** Material whose emissiveIntensity follows the night factor (0..1) up to `max`. */
		night(material, max = 1) {
			ctx.nightMaterials.push({ material, max });
			return material;
		},
		/** fn(frame) is called every frame while on the street (see main.js for the frame fields). */
		onUpdate(fn) { ctx.updaters.push(fn); },
		/** fn(nightFactor) is called when the light level changes. */
		onNight(fn) { ctx.nightHooks.push(fn); },
		/** A solid wall segment (collision only). */
		addWall(ax, az, bx, bz, info = null) { ctx.walls.add(ax, az, bx, bz, info); },
		/** A solid closed polygon outline (collision only). */
		addSolidRing(ring, info = null) {
			for (let i = 0; i < ring.length; i++) {
				const a = ring[i], b = ring[(i + 1) % ring.length];
				ctx.walls.add(a[0], a[1], b[0], b[1], info);
			}
		},
		/** A solid oriented box footprint centred at (x, z), w along yaw direction... (collision only). */
		addSolidBox(x, z, w, d, yaw = 0, info = null) {
			const c = Math.cos(yaw), s = Math.sin(yaw), hw = w / 2, hd = d / 2;
			const pts = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([u, v]) => [x + u * c + v * s, z - u * s + v * c]);
			ctx.addSolidRing(pts, info);
		},
		/** A solid round post (collision only). */
		addPost(x, z, r, info = null) { ctx.posts.add(x, z, { r, info }); },
	};
	return ctx;
}
