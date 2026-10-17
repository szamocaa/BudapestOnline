// Geometry kit for the landmarks-b models: a mesher that merges everything of one landmark into
// one mesh per material (few draw calls), local "frames" so facades can be modelled in their own
// coordinates, primitives (boxes, prisms, lathes, roofs, swept mouldings, extruded footprints,
// windows) and the shared materials.
//
// Conventions: metres; world +x east, +y up, +z south. A Frame maps local (x, y, z) to the world
// with a yaw (three.js rotation.y) and an origin. For a facade frame (see facadeFrame) local +x
// runs left→right as seen from outside, +z points out of the wall and y is up.
//
// UVs: 'world' UVs are in metres, planar per face (u along the face, v up the face), so tiling
// textures (b-tex.js) have the same texel density everywhere. Primitives with curved faces pass
// their own UVs scaled to metres.
import * as THREE from '../../vendor/three.module.min.js';
import { polygonArea } from '../../geo.js';
import { plasterTex, stoneTex, brickTex, roofTex, metalTex, grainTex, detailAtlas, cellUV } from './b-tex.js';

// ----------------------------------------------------------------------------------- frames

export class Frame {
	constructor(x = 0, z = 0, yaw = 0, y = 0) {
		this.x = x; this.y = y; this.z = z; this.yaw = yaw;
		this.c = Math.cos(yaw); this.s = Math.sin(yaw);
	}
	/** World position of local (lx, ly, lz) → [x, y, z]. */
	p(lx, ly, lz) {
		return [this.x + lx * this.c + lz * this.s, this.y + ly, this.z - lx * this.s + lz * this.c];
	}
	/** World direction of a local direction. */
	d(lx, ly, lz) {
		return [lx * this.c + lz * this.s, ly, -lx * this.s + lz * this.c];
	}
	/** A child frame at local (lx, ly, lz), turned by dyaw. */
	sub(lx, ly, lz, dyaw = 0) {
		const [x, y, z] = this.p(lx, ly, lz);
		return new Frame(x, z, this.yaw + dyaw, y);
	}
	/** World → local (x, z only). */
	local(x, z) {
		const dx = x - this.x, dz = z - this.z;
		return [dx * this.c - dz * this.s, dx * this.s + dz * this.c];
	}
}
export const WORLD = new Frame();

/** Outward unit normal of each edge of a ring (whatever its winding). */
export function edgeNormals(ring) {
	const sign = polygonArea(ring) > 0 ? 1 : -1;
	const out = [];
	for (let i = 0; i < ring.length; i++) {
		const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
		const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1;
		out.push([(sign * dz) / l, (-sign * dx) / l]);
	}
	return out;
}

/**
 * A facade frame on the wall from A to B of a footprint: origin at the left end (seen from
 * outside), +x along the wall, +z outwards. Returns { frame, length }.
 */
export function facadeFrame(ax, az, bx, bz, outward) {
	const [nx, nz] = outward;
	const yaw = Math.atan2(nx, nz);
	const f = new Frame(ax, az, yaw);
	const [la] = f.local(ax, az), [lb] = f.local(bx, bz);
	const o = la <= lb ? [ax, az] : [bx, bz];
	return { frame: new Frame(o[0], o[1], yaw), length: Math.abs(lb - la) };
}

/** The ring's edges as facade frames: [{ frame, length, i }]. */
export function facades(ring, minLength = 0) {
	const ns = edgeNormals(ring), out = [];
	for (let i = 0; i < ring.length; i++) {
		const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
		if (Math.hypot(bx - ax, bz - az) < minLength) continue;
		out.push({ ...facadeFrame(ax, az, bx, bz, ns[i]), i });
	}
	return out;
}

/** Ring offset by d metres (outwards when d > 0), mitred and clamped. */
export function offsetRing(ring, d) {
	const ns = edgeNormals(ring), n = ring.length, out = [];
	for (let i = 0; i < n; i++) {
		const a = ns[(i - 1 + n) % n], b = ns[i];
		let mx = a[0] + b[0], mz = a[1] + b[1];
		const ml = Math.hypot(mx, mz);
		if (ml < 1e-6) { mx = b[0]; mz = b[1]; } else { mx /= ml; mz /= ml; }
		const k = Math.min(3, 1 / Math.max(0.2, mx * b[0] + mz * b[1]));
		out.push([ring[i][0] + mx * k * d, ring[i][1] + mz * k * d]);
	}
	return out;
}

/** Removes near-duplicate and collinear points (keeps the shape, fewer edges). */
export function simplifyRing(ring, eps = 0.15) {
	let pts = ring.filter((p, i) => {
		const q = ring[(i + 1) % ring.length];
		return Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.05;
	});
	let changed = true;
	while (changed && pts.length > 3) {
		changed = false;
		for (let i = 0; i < pts.length; i++) {
			const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
			const dx = c[0] - a[0], dz = c[1] - a[1], l = Math.hypot(dx, dz) || 1;
			const dist = Math.abs((b[0] - a[0]) * dz - (b[1] - a[1]) * dx) / l;
			if (dist < eps) { pts.splice(i, 1); changed = true; break; }
		}
	}
	return pts;
}

/** Oriented bounding rectangle of a ring along its longest edge: { cx, cz, yaw, w, d }. */
export function orientedBox(ring) {
	let best = 0, yaw = 0;
	for (let i = 0; i < ring.length; i++) {
		const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
		const l = Math.hypot(bx - ax, bz - az);
		if (l > best) { best = l; yaw = Math.atan2(-(bz - az), bx - ax); }
	}
	const f = new Frame(0, 0, yaw);
	let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
	for (const [x, z] of ring) {
		const [lx, lz] = f.local(x, z);
		x0 = Math.min(x0, lx); x1 = Math.max(x1, lx); z0 = Math.min(z0, lz); z1 = Math.max(z1, lz);
	}
	const [cx, , cz] = f.p((x0 + x1) / 2, 0, (z0 + z1) / 2);
	return { cx, cz, yaw, w: x1 - x0, d: z1 - z0 };
}

// ----------------------------------------------------------------------------------- mesher

/** Geometry of one material: flat arrays, appended to by the mesher. */
class Part {
	constructor() {
		this.pos = []; this.nrm = []; this.uv = []; this.col = []; this.fl = []; this.idx = [];
	}
	get count() { return this.pos.length / 3; }
}

const tmpN = [0, 0, 0];
/** World-planar UV in metres for a point with normal n. */
export function worldUV(x, y, z, nx, ny, nz) {
	const l = Math.hypot(nx, nz);
	if (l < 0.25) return [x, -z];
	return [(x * nz - z * nx) / l, y / l];
}

export class Mesher {
	constructor() {
		this.parts = new Map();
		/** Current vertex colour [r, g, b] (linear). */
		this.tint = [1, 1, 1];
		/** Floodlight weight of a vertex: fn(x, y, z, nx, ny, nz) → 0..1, or null. */
		this.flood = null;
	}
	part(key) {
		let p = this.parts.get(key);
		if (!p) { p = new Part(); this.parts.set(key, p); }
		return p;
	}
	colour(hex) { const c = new THREE.Color(hex); this.tint = [c.r, c.g, c.b]; return this; }
	/** Adds one vertex in world space; uv = null means world-planar UV. */
	v(P, x, y, z, nx, ny, nz, u, w, col = this.tint) {
		if (u == null) [u, w] = worldUV(x, y, z, nx, ny, nz);
		P.pos.push(x, y, z);
		P.nrm.push(nx, ny, nz);
		P.uv.push(u, w);
		P.col.push(col[0], col[1], col[2]);
		P.fl.push(this.flood ? this.flood(x, y, z, nx, ny, nz) : 0);
		return P.count - 1;
	}
	/**
	 * A planar polygon (3 or 4 local points, counter-clockwise seen from the front) in frame F.
	 * uvs: null (world UVs) or a list of [u, v] per point.
	 */
	poly(key, F, pts, uvs = null, col = this.tint) {
		const P = this.part(key);
		const W = pts.map(([x, y, z]) => F.p(x, y, z));
		const [a, b, c] = W;
		const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
		const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
		let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
		const l = Math.hypot(nx, ny, nz) || 1;
		nx /= l; ny /= l; nz /= l;
		const base = P.count;
		W.forEach((p, i) => this.v(P, p[0], p[1], p[2], nx, ny, nz, uvs ? uvs[i][0] : null, uvs ? uvs[i][1] : null, col));
		for (let i = 1; i + 1 < W.length; i++) P.idx.push(base, base + i, base + i + 1);
	}
	/** A quad facing local +z at depth z: from (x0, y0) to (x1, y1), with an atlas cell or UV rect. */
	panel(key, F, x0, y0, x1, y1, z, uvRect = null, col = this.tint) {
		const r = typeof uvRect === 'number' ? cellUV(uvRect) : uvRect;
		const uvs = r ? [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]] : null;
		this.poly(key, F, [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]], uvs, col);
	}
	/** Axis-aligned box in frame F from (x0, y0, z0) to (x1, y1, z1). Bottom face skipped unless asked. */
	box(key, F, x0, y0, z0, x1, y1, z1, { bottom = false, top = true, col = this.tint, skip = '' } = {}) {
		const q = (a, b, c, d) => this.poly(key, F, [a, b, c, d], null, col);
		if (!skip.includes('f')) q([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +z
		if (!skip.includes('b')) q([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]); // -z
		if (!skip.includes('r')) q([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]); // +x
		if (!skip.includes('l')) q([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // -x
		if (top) q([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
		if (bottom) q([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
	}
	/** Box centred at (cx, cz), bottom at y0. */
	cbox(key, F, cx, y0, cz, w, h, d, opts) {
		this.box(key, F, cx - w / 2, y0, cz - d / 2, cx + w / 2, y0 + h, cz + d / 2, opts);
	}
	/**
	 * A frustum / prism with n sides around the local y axis at (cx, cz): radius r0 at y0, r1 at y1.
	 * smooth: round normals (columns, drums). caps: 'top', 'bottom', 'both' or ''.
	 */
	prism(key, F, cx, cz, y0, y1, r0, r1, n = 8, { smooth = false, caps = 'top', rot = 0, col = this.tint, uvScale = null } = {}) {
		const P = this.part(key);
		const circ = 2 * Math.PI * Math.max(r0, r1);
		const slope = (r0 - r1) / Math.max(1e-6, y1 - y0);
		const ring = (r, y, a) => F.p(cx + Math.sin(a) * r, y, cz + Math.cos(a) * r);
		for (let i = 0; i < n; i++) {
			const a0 = rot + (i / n) * Math.PI * 2, a1 = rot + ((i + 1) / n) * Math.PI * 2, am = (a0 + a1) / 2;
			const pa = ring(r0, y0, a0), pb = ring(r0, y0, a1), pc = ring(r1, y1, a1), pd = ring(r1, y1, a0);
			const nrm = (a) => {
				const [x, , z] = F.d(Math.sin(a), 0, Math.cos(a));
				const l = Math.hypot(1, slope);
				return [x / l, slope / l, z / l];
			};
			const na = smooth ? nrm(a0) : nrm(am), nb = smooth ? nrm(a1) : nrm(am);
			const u0 = (i / n) * circ, u1 = ((i + 1) / n) * circ;
			const sl = Math.hypot(y1 - y0, r0 - r1);
			const useUV = smooth || uvScale;
			const base = P.count;
			this.v(P, ...pa, ...na, useUV ? u0 : null, useUV ? 0 : null, col);
			this.v(P, ...pb, ...nb, useUV ? u1 : null, useUV ? 0 : null, col);
			this.v(P, ...pc, ...nb, useUV ? u1 : null, useUV ? sl : null, col);
			this.v(P, ...pd, ...na, useUV ? u0 : null, useUV ? sl : null, col);
			P.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
		}
		const cap = (y, r, up) => {
			if (r < 1e-4) return;
			const [nx, ny, nz] = up ? [0, 1, 0] : [0, -1, 0];
			const c = F.p(cx, y, cz);
			const base = P.count;
			this.v(P, ...c, nx, ny, nz, null, null, col);
			for (let i = 0; i <= n; i++) this.v(P, ...ring(r, y, rot + (i / n) * Math.PI * 2), nx, ny, nz, null, null, col);
			for (let i = 0; i < n; i++) up ? P.idx.push(base, base + 1 + i, base + 2 + i) : P.idx.push(base, base + 2 + i, base + 1 + i);
		};
		if (caps === 'top' || caps === 'both') cap(y1, r1, true);
		if (caps === 'bottom' || caps === 'both') cap(y0, r0, false);
	}
	/**
	 * Surface of revolution around local y at (cx, cz): profile = [[r, y], ...] bottom → top.
	 * Smooth normals; UVs in metres (u around the widest circumference, v along the profile).
	 */
	lathe(key, F, cx, cz, profile, n = 16, { col = this.tint, rot = 0, flat = false } = {}) {
		const P = this.part(key);
		const rMax = Math.max(...profile.map((p) => p[0]));
		const circ = 2 * Math.PI * rMax;
		// Profile normals (in the r/y plane) per vertex: average of adjacent segment normals.
		const segN = [];
		for (let j = 0; j + 1 < profile.length; j++) {
			const dr = profile[j + 1][0] - profile[j][0], dy = profile[j + 1][1] - profile[j][1];
			const l = Math.hypot(dr, dy) || 1;
			segN.push([dy / l, -dr / l]);
		}
		const vN = profile.map((_, j) => {
			const a = segN[Math.max(0, j - 1)], b = segN[Math.min(segN.length - 1, j)];
			const x = a[0] + b[0], y = a[1] + b[1], l = Math.hypot(x, y) || 1;
			return [x / l, y / l];
		});
		let acc = 0;
		const vs = profile.map((p, j) => (j ? (acc += Math.hypot(p[0] - profile[j - 1][0], p[1] - profile[j - 1][1])) : 0));
		if (flat) {
			for (let j = 0; j + 1 < profile.length; j++) {
				const [nr, ny] = segN[j];
				for (let i = 0; i < n; i++) {
					const a0 = rot + (i / n) * Math.PI * 2, a1 = rot + ((i + 1) / n) * Math.PI * 2, am = (a0 + a1) / 2;
					const [nx, , nz] = F.d(Math.sin(am) * nr, 0, Math.cos(am) * nr);
					const pt = (a, k) => F.p(cx + Math.sin(a) * profile[k][0], profile[k][1], cz + Math.cos(a) * profile[k][0]);
					const base = P.count;
					this.v(P, ...pt(a0, j), nx, ny, nz, (i / n) * circ, vs[j], col);
					this.v(P, ...pt(a1, j), nx, ny, nz, ((i + 1) / n) * circ, vs[j], col);
					this.v(P, ...pt(a1, j + 1), nx, ny, nz, ((i + 1) / n) * circ, vs[j + 1], col);
					this.v(P, ...pt(a0, j + 1), nx, ny, nz, (i / n) * circ, vs[j + 1], col);
					P.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
				}
			}
			return;
		}
		const base = P.count;
		for (let j = 0; j < profile.length; j++) {
			const [r, y] = profile[j];
			const [nr, ny] = vN[j];
			for (let i = 0; i <= n; i++) {
				const a = rot + (i / n) * Math.PI * 2;
				const p = F.p(cx + Math.sin(a) * r, y, cz + Math.cos(a) * r);
				const [nx, , nz] = F.d(Math.sin(a) * nr, 0, Math.cos(a) * nr);
				this.v(P, ...p, nx, ny, nz, (i / n) * circ, vs[j], col);
			}
		}
		for (let j = 0; j + 1 < profile.length; j++) for (let i = 0; i < n; i++) {
			const a = base + j * (n + 1) + i, b = a + 1, c = a + n + 2, d = a + n + 1;
			P.idx.push(a, b, c, a, c, d);
		}
	}
	/**
	 * Swept moulding along a polyline/ring in world x/z (outward normals from `normals` or the
	 * ring's own): profile = [[offset, y], ...] bottom → top, offset measured outwards.
	 */
	sweep(key, ring, profile, { closed = true, col = this.tint, normals = null } = {}) {
		const P = this.part(key);
		const n = ring.length;
		const ns = normals || edgeNormals(ring);
		const edges = closed ? n : n - 1;
		const miter = (i) => {
			if (!closed && i === 0) return [ns[0][0], ns[0][1], 1];
			if (!closed && i === n - 1) return [ns[n - 2][0], ns[n - 2][1], 1];
			const a = ns[(i - 1 + n) % n], b = ns[i % n];
			let mx = a[0] + b[0], mz = a[1] + b[1];
			const ml = Math.hypot(mx, mz);
			if (ml < 1e-6) { mx = b[0]; mz = b[1]; } else { mx /= ml; mz /= ml; }
			return [mx, mz, Math.min(3, 1 / Math.max(0.25, mx * b[0] + mz * b[1]))];
		};
		const ms = ring.map((_, i) => miter(i));
		let along = 0;
		for (let e = 0; e < edges; e++) {
			const i0 = e, i1 = (e + 1) % n;
			const [en, ez] = ns[e];
			const len = Math.hypot(ring[i1][0] - ring[i0][0], ring[i1][1] - ring[i0][1]);
			let pv = 0;
			for (let j = 0; j + 1 < profile.length; j++) {
				const [o0, y0] = profile[j], [o1, y1] = profile[j + 1];
				const pt = (i, o, y) => [ring[i][0] + ms[i][0] * ms[i][2] * o, y, ring[i][1] + ms[i][1] * ms[i][2] * o];
				const A = pt(i0, o0, y0), B = pt(i1, o0, y0), C = pt(i1, o1, y1), D = pt(i0, o1, y1);
				// Face normal: the profile step (do, dy) turned outwards.
				const dO = o1 - o0, dY = y1 - y0, l = Math.hypot(dO, dY) || 1;
				const nx = (en * dY) / l, ny = -dO / l, nz = (ez * dY) / l;
				const v0 = pv, v1 = pv + l;
				pv = v1;
				const base = P.count;
				this.v(P, ...A, nx, ny, nz, along, v0, col);
				this.v(P, ...B, nx, ny, nz, along + len, v0, col);
				this.v(P, ...C, nx, ny, nz, along + len, v1, col);
				this.v(P, ...D, nx, ny, nz, along, v1, col);
				// Winding: make (B-A)x(D-A) agree with the normal.
				const cx = (B[1] - A[1]) * (D[2] - A[2]) - (B[2] - A[2]) * (D[1] - A[1]);
				const cy = (B[2] - A[2]) * (D[0] - A[0]) - (B[0] - A[0]) * (D[2] - A[2]);
				const cz = (B[0] - A[0]) * (D[1] - A[1]) - (B[1] - A[1]) * (D[0] - A[0]);
				if (cx * nx + cy * ny + cz * nz >= 0) P.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
				else P.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
			}
			along += len;
		}
	}
	/** Vertical walls of a ring (world x/z) from y0 to y1, facing outwards (inwards if inside). */
	walls(key, ring, y0, y1, { col = this.tint, inside = false } = {}) {
		const ns = edgeNormals(ring);
		this.sweep(key, ring, [[0, y0], [0, y1]], { col, normals: inside ? ns.map(([x, z]) => [-x, -z]) : ns });
	}
	/** Horizontal cap of a ring (with holes) at height y, facing up (or down). */
	cap(key, ring, y, { holes = [], down = false, col = this.tint } = {}) {
		const P = this.part(key);
		const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
		const hs = holes.map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
		let tris;
		try { tris = THREE.ShapeUtils.triangulateShape(contour, hs); } catch { return; }
		const flat = [contour, ...hs].flat();
		const base = P.count;
		const ny = down ? -1 : 1;
		for (const p of flat) this.v(P, p.x, y, p.y, 0, ny, 0, null, null, col);
		for (const [a, b, c] of tris) {
			const A = flat[a], B = flat[b], C = flat[c];
			const up = (B.y - A.y) * (C.x - A.x) - (B.x - A.x) * (C.y - A.y);
			if ((up > 0) === !down) P.idx.push(base + a, base + b, base + c);
			else P.idx.push(base + a, base + c, base + b);
		}
	}
	/** A solid extruded footprint: walls + top (+ bottom). */
	extrude(key, ring, y0, y1, { holes = [], col = this.tint, top = true, bottom = false, topKey = key } = {}) {
		this.walls(key, ring, y0, y1, { col });
		for (const h of holes) this.walls(key, h, y0, y1, { col, inside: true });
		if (top) this.cap(topKey, ring, y1, { holes, col });
		if (bottom) this.cap(key, ring, y0, { holes, down: true, col });
	}
	/**
	 * Pitched roof on a local rectangle [x0, x1] × [z0, z1] in F from eave height y0 rising by
	 * `rise`. hip: 0 = gable (ridge along the long axis), 1 = full hip; values between hip the
	 * ends partially. Gable end walls go to `wallKey` when given.
	 */
	roof(key, F, x0, z0, x1, z1, y0, rise, { hip = 0, overhang = 0.4, wallKey = null, col = this.tint, wallCol = null, alongX = null } = {}) {
		const ax = alongX == null ? x1 - x0 >= z1 - z0 : alongX;
		// Work in a frame where the ridge runs along local x.
		const G = ax ? F.sub((x0 + x1) / 2, 0, (z0 + z1) / 2) : F.sub((x0 + x1) / 2, 0, (z0 + z1) / 2, Math.PI / 2);
		const L = (ax ? x1 - x0 : z1 - z0) / 2, D = (ax ? z1 - z0 : x1 - x0) / 2;
		const o = overhang, dropO = (rise / D) * o;
		const ye = y0 - dropO, yr = y0 + rise;
		const h = Math.min(L, D * hip); // how far the hip runs in along the ridge
		const rl = L - h; // half ridge length
		const lo = L + o, dO = D + o;
		// Long slopes.
		this.poly(key, G, [[-lo, ye, dO], [lo, ye, dO], [rl, yr, 0], [-rl, yr, 0]], null, col);
		this.poly(key, G, [[lo, ye, -dO], [-lo, ye, -dO], [-rl, yr, 0], [rl, yr, 0]], null, col);
		if (h > 0.01) {
			this.poly(key, G, [[lo, ye, dO], [lo, ye, -dO], [rl, yr, 0]], null, col);
			this.poly(key, G, [[-lo, ye, -dO], [-lo, ye, dO], [-rl, yr, 0]], null, col);
		} else {
			// Gable ends: wall triangles + the roof's verge thickness.
			const wk = wallKey || key, wc = wallCol || col;
			this.poly(wk, G, [[L, y0, D], [L, y0, -D], [L, yr, 0]], null, wc);
			this.poly(wk, G, [[-L, y0, -D], [-L, y0, D], [-L, yr, 0]], null, wc);
			if (o > 0) {
				// Undersides of the overhang at the gables.
				this.poly(key, G, [[lo, ye, dO], [lo, ye - 0.12, dO], [lo, yr - 0.12, 0], [lo, yr, 0]], null, col);
				this.poly(key, G, [[lo, yr, 0], [lo, yr - 0.12, 0], [lo, ye - 0.12, -dO], [lo, ye, -dO]], null, col);
				this.poly(key, G, [[-lo, yr, 0], [-lo, yr - 0.12, 0], [-lo, ye - 0.12, dO], [-lo, ye, dO]], null, col);
				this.poly(key, G, [[-lo, ye, -dO], [-lo, ye - 0.12, -dO], [-lo, yr - 0.12, 0], [-lo, yr, 0]], null, col);
			}
		}
		// Eave soffits (so the overhang is not paper-thin from below).
		if (o > 0) {
			this.poly(key, G, [[-lo, ye, dO], [-lo, ye, -dO], [lo, ye, -dO], [lo, ye, dO]], null, col);
		}
	}
	/** Pyramid / spire on a local square or rectangle centred at (cx, cz). */
	pyramid(key, F, cx, cz, y0, w, d, h, col = this.tint) {
		const a = [cx - w / 2, y0, cz + d / 2], b = [cx + w / 2, y0, cz + d / 2], c = [cx + w / 2, y0, cz - d / 2], e = [cx - w / 2, y0, cz - d / 2];
		const t = [cx, y0 + h, cz];
		this.poly(key, F, [a, b, t], null, col);
		this.poly(key, F, [b, c, t], null, col);
		this.poly(key, F, [c, e, t], null, col);
		this.poly(key, F, [e, a, t], null, col);
	}
	/**
	 * A semicircular arch band in the local x/y plane (facing +z): centre (cx, cy), inner radius
	 * r, width t, depth d (from z0 to z0 + d). Used for archivolts and arcades.
	 */
	arch(key, F, cx, cy, r, t, z0, d, { n = 10, col = this.tint, from = 0, to = Math.PI } = {}) {
		for (let i = 0; i < n; i++) {
			const a0 = from + ((to - from) * i) / n, a1 = from + ((to - from) * (i + 1)) / n;
			const p = (a, rr) => [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr];
			const [ix0, iy0] = p(a0, r), [ix1, iy1] = p(a1, r), [ox0, oy0] = p(a0, r + t), [ox1, oy1] = p(a1, r + t);
			const zf = z0 + d;
			// Front face, back face, intrados (inner), extrados (outer).
			this.poly(key, F, [[ix0, iy0, zf], [ox0, oy0, zf], [ox1, oy1, zf], [ix1, iy1, zf]], null, col);
			this.poly(key, F, [[ix0, iy0, z0], [ix1, iy1, z0], [ox1, oy1, z0], [ox0, oy0, z0]], null, col);
			this.poly(key, F, [[ix0, iy0, z0], [ix0, iy0, zf], [ix1, iy1, zf], [ix1, iy1, z0]], null, col);
			this.poly(key, F, [[ox0, oy0, zf], [ox0, oy0, z0], [ox1, oy1, z0], [ox1, oy1, zf]], null, col);
		}
	}
	/**
	 * Fills the wall around a semicircular opening (centre (cx, cy), radius R) up to the square
	 * [cx - R, cx + R] × [cy, cy + R + top], in the plane z, facing +z (arcade spandrels).
	 */
	spandrel(key, F, cx, cy, R, top, z, { n = 8, col = this.tint } = {}) {
		for (const side of [-1, 1]) {
			const K = [cx + side * R, cy + R, z];
			for (let i = 0; i < n; i++) {
				const a0 = side < 0 ? Math.PI - (i / n) * (Math.PI / 2) : (i / n) * (Math.PI / 2);
				const a1 = side < 0 ? Math.PI - ((i + 1) / n) * (Math.PI / 2) : ((i + 1) / n) * (Math.PI / 2);
				const p0 = [cx + Math.cos(a0) * R, cy + Math.sin(a0) * R, z], p1 = [cx + Math.cos(a1) * R, cy + Math.sin(a1) * R, z];
				this.poly(key, F, side < 0 ? [p0, p1, K] : [p1, p0, K], null, col);
			}
		}
		if (top > 0.001) this.poly(key, F, [[cx - R, cy + R, z], [cx + R, cy + R, z], [cx + R, cy + R + top, z], [cx - R, cy + R + top, z]], null, col);
	}
	/**
	 * An arched glass/door panel facing +z: the atlas cell's top half (a semicircle) maps onto the
	 * top w/2 of the panel, the bottom half onto the rest, so the arch stays round.
	 */
	archPanel(key, F, x0, y0, x1, y1, z, cell, col = [1, 1, 1]) {
		const r = cellUV(cell), w = x1 - x0, ys = Math.max(y0, y1 - w / 2), vm = (r[1] + r[3]) / 2;
		this.panel(key, F, x0, y0, x1, ys, z, [r[0], r[1], r[2], vm], col);
		this.panel(key, F, x0, ys, x1, y1, z, [r[0], vm, r[2], r[3]], col);
	}
}

// ----------------------------------------------------------------------------------- windows

/**
 * A window in a facade frame at x (centre), sill height y, size w × h: glass panel from the
 * atlas plus a 3D surround (architrave, sill, optional cornice/pediment, keystone).
 * style: { cell, frameKey, depth, surround (width), cornice: 'flat'|'pediment'|'segment'|null,
 *          arched: bool, sill: bool, col (frame colour), recess }
 */
export function windowAt(m, F, x, y, w, h, s = {}) {
	const key = s.frameKey || 'stone';
	const sw = s.surround ?? 0.16, dp = s.depth ?? 0.12, rc = s.recess ?? 0.03;
	const col = s.col || m.tint;
	const x0 = x - w / 2, x1 = x + w / 2, y1 = y + h;
	if (s.arched) m.archPanel('detail', F, x0, y, x1, y1, rc, s.cell ?? 4);
	else m.panel('detail', F, x0, y, x1, y1, rc, s.cell ?? 0, [1, 1, 1]);
	if (sw > 0) {
		// Jambs (inner reveal faces give the recess).
		m.box(key, F, x0 - sw, y, -0.05, x0, s.arched ? y1 - w / 2 : y1, dp, { col });
		m.box(key, F, x1, y, -0.05, x1 + sw, s.arched ? y1 - w / 2 : y1, dp, { col });
		if (s.arched) m.arch(key, F, x, y1 - w / 2, w / 2, sw, -0.05, dp + 0.05, { n: 8, col });
		else m.box(key, F, x0 - sw, y1, -0.05, x1 + sw, y1 + sw, dp, { col });
	}
	if (s.sill !== false) m.box(key, F, x0 - sw - 0.06, y - 0.1, -0.05, x1 + sw + 0.06, y, dp + 0.08, { col });
	const top = s.arched ? y1 : y1 + sw;
	if (s.cornice === 'flat') m.box(key, F, x0 - sw - 0.12, top + 0.05, -0.05, x1 + sw + 0.12, top + 0.2, dp + 0.12, { col });
	else if (s.cornice === 'pediment') {
		const pw = w / 2 + sw + 0.15, ph = 0.42;
		m.box(key, F, x0 - sw - 0.15, top + 0.04, -0.05, x1 + sw + 0.15, top + 0.16, dp + 0.12, { col });
		m.poly(key, F, [[x - pw, top + 0.16, dp + 0.1], [x + pw, top + 0.16, dp + 0.1], [x, top + 0.16 + ph, dp + 0.1]], null, col);
		const L = Math.hypot(pw, ph);
		m.poly(key, F, [[x + pw, top + 0.16, dp + 0.1], [x + pw, top + 0.16, -0.05], [x, top + 0.16 + ph, -0.05], [x, top + 0.16 + ph, dp + 0.1]], null, col);
		m.poly(key, F, [[x, top + 0.16 + ph, dp + 0.1], [x, top + 0.16 + ph, -0.05], [x - pw, top + 0.16, -0.05], [x - pw, top + 0.16, dp + 0.1]], null, col);
		void L;
	} else if (s.cornice === 'segment') {
		m.arch(key, F, x, top - w * 0.9, w * 0.9 + 0.1, 0.16, -0.05, dp + 0.1, { n: 6, col, from: Math.PI * 0.32, to: Math.PI * 0.68 });
	}
	if (s.keystone) m.box(key, F, x - 0.13, top - 0.12, -0.05, x + 0.13, top + 0.22, dp + 0.06, { col });
}

// ----------------------------------------------------------------------------------- materials

let mats = null;
const floodUniform = { value: new THREE.Color(0, 0, 0) };

/** Adds the per-vertex floodlight term (attribute `flood`) to a standard material. */
function withFlood(mat) {
	mat.onBeforeCompile = (sh) => {
		sh.uniforms.uFlood = floodUniform;
		sh.vertexShader = sh.vertexShader
			.replace('#include <common>', '#include <common>\nattribute float flood;\nvarying float vFlood;')
			.replace('#include <begin_vertex>', '#include <begin_vertex>\nvFlood = flood;');
		sh.fragmentShader = sh.fragmentShader
			.replace('#include <common>', '#include <common>\nuniform vec3 uFlood;\nvarying float vFlood;')
			.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += uFlood * vFlood * diffuseColor.rgb;');
	};
	mat.customProgramCacheKey = () => 'lb-flood';
	return mat;
}

/**
 * The shared materials (created once): plaster, stone, rustic, brick, roof, metal, bronze, iron,
 * detail (window atlas), glow. Night-lit ones are registered with ctx.night by the caller.
 */
export function landmarkMaterials(ctx) {
	if (mats) return mats;
	const std = (o, flood = true) => {
		const m = new THREE.MeshStandardMaterial({ vertexColors: true, ...o });
		return flood ? withFlood(m) : m;
	};
	const P = plasterTex(), S = stoneTex(false), R = stoneTex(true), B = brickTex(), T = roofTex(), M = metalTex(), G = grainTex();
	const A = detailAtlas();
	mats = {
		plaster: std({ map: P.map, normalMap: P.normal, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.9 }),
		stone: std({ map: S.map, normalMap: S.normal, normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.82 }),
		rustic: std({ map: R.map, normalMap: R.normal, normalScale: new THREE.Vector2(1, 1), roughness: 0.88 }),
		brick: std({ map: B.map, normalMap: B.normal, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.88 }),
		roof: std({ map: T.map, normalMap: T.normal, normalScale: new THREE.Vector2(0.9, 0.9), roughness: 0.75, side: THREE.DoubleSide }),
		metal: std({ map: M.map, normalMap: M.normal, normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.48, metalness: 0.55, side: THREE.DoubleSide }),
		bronze: std({ map: G.map, normalMap: G.normal, roughness: 0.42, metalness: 0.85 }),
		iron: std({ map: G.map, roughness: 0.55, metalness: 0.6 }, false),
		polished: std({ map: G.map, roughness: 0.18, metalness: 0.0 }, false),
		detail: ctx.night(new THREE.MeshStandardMaterial({ map: A.map, emissiveMap: A.emissive, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.22, metalness: 0.05, alphaTest: 0.5, side: THREE.DoubleSide }), 1.6),
		glow: ctx.night(new THREE.MeshStandardMaterial({ vertexColors: true, color: 0xffffff, emissive: 0xffd9a0, emissiveIntensity: 0, roughness: 0.4 }), 4),
	};
	// Floodlights come on with the night.
	ctx.onNight((k) => floodUniform.value.setRGB(1.0 * k, 0.78 * k, 0.5 * k));
	return mats;
}
/** Forget cached materials (a new city context needs its own night registration). */
export function resetMaterials() { mats = null; }

/**
 * Turns the mesher's parts into meshes under `parent` (one per material), with shadows.
 * extra: { key: material } for landmark-specific materials (signs).
 */
export function finish(m, ctx, parent, extra = {}, { shadows = true, name = 'landmark' } = {}) {
	const all = { ...landmarkMaterials(ctx), ...extra };
	const group = new THREE.Group();
	group.name = name;
	let tris = 0;
	for (const [key, P] of m.parts) {
		if (!P.idx.length) continue;
		const mat = all[key];
		if (!mat) { console.warn(`landmark ${name}: no material ${key}`); continue; }
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.Float32BufferAttribute(P.pos, 3));
		g.setAttribute('normal', new THREE.Float32BufferAttribute(P.nrm, 3));
		g.setAttribute('uv', new THREE.Float32BufferAttribute(P.uv, 2));
		g.setAttribute('color', new THREE.Float32BufferAttribute(P.col, 3));
		g.setAttribute('flood', new THREE.Float32BufferAttribute(P.fl, 1));
		g.setIndex(P.count > 65535 ? new THREE.Uint32BufferAttribute(P.idx, 1) : new THREE.Uint16BufferAttribute(P.idx, 1));
		g.computeBoundingSphere();
		const mesh = new THREE.Mesh(g, mat);
		mesh.name = `${name}:${key}`;
		const noShadow = key === 'detail' || key === 'glow' || key.startsWith('sign');
		mesh.castShadow = shadows && !noShadow;
		mesh.receiveShadow = !noShadow || key === 'detail';
		group.add(mesh);
		tris += P.idx.length / 3;
	}
	parent.add(group);
	group.userData.triangles = tris;
	return group;
}

/** sRGB hex → linear [r, g, b] for vertex colours. */
export const rgb = (hex) => {
	const c = new THREE.Color(hex);
	return [c.r, c.g, c.b];
};
/** Linear colour scaled (for darker/lighter variants). */
export const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
