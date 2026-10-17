// Geometry of the Józsefváros buildings (plain arrays, no three.js objects; tested in
// tests/web/buildings.test.mjs). Two levels of detail:
//   * detail (near the player): real 3D facades: recessed windows with glass, raised surrounds,
//     sills, lintels and pediments, string courses, a main cornice with consoles, rusticated ground
//     floors with shopfronts and arched gates, balconies, courtyard "gang" walkways with iron
//     railings, firewalls, roofs with gables and chimneys;
//   * far shell: one quad per wall, the same roofs and a cornice slab; windows are drawn by the far
//     shader from the bay layout carried in the vertex attributes. The shell also casts the shadows.
import { layoutBays, STYLES, TENEMENT, hexRgb } from './facadesPlan.js';
import { roofFaces } from './facadesRoof.js';
import { rng } from '../geo.js';

/** Texture layers of the facade material (facadesTex.js draws them in this order). */
export const LAYER = { PLASTER: 0, ROUGH: 1, RUSTIC: 2, STONE: 3, BRICK: 4, WOOD: 5, TILE: 6, SLATE: 7, TIN: 8, FLAT: 9, CONCRETE: 10, METAL: 11, AD: 12, ORN: 13 };
const ROOF_LAYER = { tile: LAYER.TILE, slate: LAYER.SLATE, tin: LAYER.TIN, flat: LAYER.FLAT, copper: LAYER.TIN };

/** Glass modes (facadesTex.js glazing shader). */
export const GLASS = { FLAT: 0, SHOP: 1, EMPTY: 2, OFFICE: 3, DOOR: 4, STAIR: 5, TOBACCO: 6, VAPE: 7, FANLIGHT: 8, CAFE: 9, PHARMACY: 10 };
/** Window frame colours (index into the glazing shader's palette). */
export const FRAME = { WHITE: 0, BROWN: 1, CREAM: 2, GREY: 3, GREEN: 4, BLACK: 5 };
/** Railing patterns (rows of the railing atlas). */
export const RAIL = { WROUGHT: 0, GANG: 1, MODERN: 2, SECESSION: 3 };

// ---------------------------------------------------------------- buffers

/** Growable typed array (amortised doubling; .a is the backing array, .n the used length). */
class Grow {
	constructor(T, cap) { this.T = T; this.a = new T(cap); this.n = 0; }
	need(k) {
		if (this.n + k <= this.a.length) return;
		let c = this.a.length * 2;
		while (c < this.n + k) c *= 2;
		const b = new this.T(c);
		b.set(this.a);
		this.a = b;
	}
	view() { return this.a.subarray(0, this.n); }
}

/**
 * Opaque facade geometry, packed for the GPU: position f32x3, normal i8x3 (normalised), uv f32x2
 * (metres), tint u8x4 (linear rgb, dirt / 2), layer u8 (texture layer, see LAYER).
 */
export class OpaqueBuf {
	constructor(cap = 4096) {
		this.P = new Grow(Float32Array, cap * 3); this.N = new Grow(Int8Array, cap * 3); this.U = new Grow(Float32Array, cap * 2);
		this.C = new Grow(Uint8Array, cap * 4); this.Lr = new Grow(Uint8Array, cap); this.I = new Grow(Uint32Array, cap * 2);
		this.n = 0;
	}
	get triangles() { return this.I.n / 3; }
	_v(x, y, z, nx, ny, nz, u, v, c, layer, d) {
		const P = this.P, N = this.N, U = this.U, C = this.C, L = this.Lr;
		P.a[P.n++] = x; P.a[P.n++] = y; P.a[P.n++] = z;
		N.a[N.n++] = Math.round(nx * 127); N.a[N.n++] = Math.round(ny * 127); N.a[N.n++] = Math.round(nz * 127);
		U.a[U.n++] = u; U.a[U.n++] = v;
		const cl = (q) => (q <= 0 ? 0 : q >= 1 ? 255 : Math.round(q * 255));
		C.a[C.n++] = cl(c[0]); C.a[C.n++] = cl(c[1]); C.a[C.n++] = cl(c[2]); C.a[C.n++] = cl(d * 0.5);
		L.a[L.n++] = layer;
		return this.n++;
	}
	_reserve(v, i) { this.P.need(v * 3); this.N.need(v * 3); this.U.need(v * 2); this.C.need(v * 4); this.Lr.need(v); this.I.need(i); }
	/** Quad from P (12 numbers: 4 corners), outward normal n; UV 8 numbers; D 4 dirt values. */
	quad(P, nx, ny, nz, UV, c, layer, d0, d1, d2, d3) {
		const gx = (P[4] - P[1]) * (P[8] - P[2]) - (P[5] - P[2]) * (P[7] - P[1]);
		const gy = (P[5] - P[2]) * (P[6] - P[0]) - (P[3] - P[0]) * (P[8] - P[2]);
		const gz = (P[3] - P[0]) * (P[7] - P[1]) - (P[4] - P[1]) * (P[6] - P[0]);
		this._reserve(4, 6);
		const b = this.n;
		this._v(P[0], P[1], P[2], nx, ny, nz, UV[0], UV[1], c, layer, d0);
		this._v(P[3], P[4], P[5], nx, ny, nz, UV[2], UV[3], c, layer, d1);
		this._v(P[6], P[7], P[8], nx, ny, nz, UV[4], UV[5], c, layer, d2);
		this._v(P[9], P[10], P[11], nx, ny, nz, UV[6], UV[7], c, layer, d3);
		const I = this.I;
		if (gx * nx + gy * ny + gz * nz >= 0) { I.a[I.n++] = b; I.a[I.n++] = b + 1; I.a[I.n++] = b + 2; I.a[I.n++] = b; I.a[I.n++] = b + 2; I.a[I.n++] = b + 3; }
		else { I.a[I.n++] = b; I.a[I.n++] = b + 2; I.a[I.n++] = b + 1; I.a[I.n++] = b; I.a[I.n++] = b + 3; I.a[I.n++] = b + 2; }
	}
	/** Triangle from P (9 numbers). */
	tri(P, nx, ny, nz, UV, c, layer, d) {
		const gx = (P[4] - P[1]) * (P[8] - P[2]) - (P[5] - P[2]) * (P[7] - P[1]);
		const gy = (P[5] - P[2]) * (P[6] - P[0]) - (P[3] - P[0]) * (P[8] - P[2]);
		const gz = (P[3] - P[0]) * (P[7] - P[1]) - (P[4] - P[1]) * (P[6] - P[0]);
		this._reserve(3, 3);
		const b = this.n;
		this._v(P[0], P[1], P[2], nx, ny, nz, UV[0], UV[1], c, layer, d);
		this._v(P[3], P[4], P[5], nx, ny, nz, UV[2], UV[3], c, layer, d);
		this._v(P[6], P[7], P[8], nx, ny, nz, UV[4], UV[5], c, layer, d);
		const I = this.I;
		if (gx * nx + gy * ny + gz * nz >= 0) { I.a[I.n++] = b; I.a[I.n++] = b + 1; I.a[I.n++] = b + 2; }
		else { I.a[I.n++] = b; I.a[I.n++] = b + 2; I.a[I.n++] = b + 1; }
	}
}

/** Glazing: position, normal, tangent (x, z), uv (0..1 over the pane), win (w, h, seed, mode), win2 (blind, curtain, frame, flags). */
export class GlassBuf {
	constructor() { this.pos = []; this.nrm = []; this.tan = []; this.uv = []; this.win = []; this.win2 = []; this.idx = []; this.n = 0; }
	vert(x, y, z, nx, nz, tx, tz, u, v, W, W2) {
		this.pos.push(x, y, z); this.nrm.push(nx, 0, nz); this.tan.push(tx, tz); this.uv.push(u, v);
		this.win.push(W[0], W[1], W[2], W[3]); this.win2.push(W2[0], W2[1], W2[2], W2[3]);
		return this.n++;
	}
}

/** Alpha-tested railings: position, normal, uv (u in metres along, v = pattern row + height). */
export class RailBuf {
	constructor() { this.pos = []; this.nrm = []; this.uv = []; this.idx = []; this.n = 0; }
}

/** Far shell: position, normal, colour, f1 (u, step, start, n), f2 (groundTop, floorH, topY, kind + seed), chunk. */
export class FarBuf {
	constructor() { this.pos = []; this.nrm = []; this.col = []; this.f1 = []; this.f2 = []; this.chunk = []; this.idx = []; this.n = 0; }
	vert(x, y, z, nx, ny, nz, c, F1, F2, ch) {
		this.pos.push(x, y, z); this.nrm.push(nx, ny, nz); this.col.push(c[0], c[1], c[2]);
		this.f1.push(F1[0], F1[1], F1[2], F1[3]); this.f2.push(F2[0], F2[1], F2[2], F2[3]); this.chunk.push(ch);
		return this.n++;
	}
}

// ---------------------------------------------------------------- facade frame helpers

const P = new Float64Array(12);
const UVS = new Float64Array(8);

/** Local frame of one wall segment: X/Z(t, d) with t along the wall and d outwards. */
class Frame {
	set(seg, uOff = 0) {
		this.ax = seg.ax; this.az = seg.az; this.ux = seg.ux; this.uz = seg.uz; this.nx = seg.nx; this.nz = seg.nz; this.uo = uOff;
		return this;
	}
	X(t, d) { return this.ax + this.ux * t + this.nx * d; }
	Z(t, d) { return this.az + this.uz * t + this.nz * d; }
}

function setP(F, k, t, y, d) {
	P[k * 3] = F.X(t, d); P[k * 3 + 1] = y; P[k * 3 + 2] = F.Z(t, d);
}

/** Face parallel to the wall at depth d (normal = outward). Dirt per corner (t0y0, t1y0, t1y1, t0y1). */
function front(B, F, t0, t1, y0, y1, d, c, layer, a, b, cc, dd) {
	setP(F, 0, t0, y0, d); setP(F, 1, t1, y0, d); setP(F, 2, t1, y1, d); setP(F, 3, t0, y1, d);
	const u0 = F.uo + t0, u1 = F.uo + t1;
	UVS[0] = u0; UVS[1] = y0; UVS[2] = u1; UVS[3] = y0; UVS[4] = u1; UVS[5] = y1; UVS[6] = u0; UVS[7] = y1;
	B.quad(P, F.nx, 0, F.nz, UVS, c, layer, a, b, cc, dd);
}
/** Face across the wall at position t, spanning depths d0..d1 (normal = sgn * along). */
function side(B, F, t, y0, y1, d0, d1, sgn, c, layer, dirt) {
	setP(F, 0, t, y0, d0); setP(F, 1, t, y0, d1); setP(F, 2, t, y1, d1); setP(F, 3, t, y1, d0);
	UVS[0] = d0; UVS[1] = y0; UVS[2] = d1; UVS[3] = y0; UVS[4] = d1; UVS[5] = y1; UVS[6] = d0; UVS[7] = y1;
	B.quad(P, F.ux * sgn, 0, F.uz * sgn, UVS, c, layer, dirt, dirt, dirt, dirt);
}
/** Horizontal face at height y (normal up for sgn = 1, down for -1). */
function horiz(B, F, t0, t1, y, d0, d1, sgn, c, layer, dirt) {
	setP(F, 0, t0, y, d0); setP(F, 1, t1, y, d0); setP(F, 2, t1, y, d1); setP(F, 3, t0, y, d1);
	const u0 = F.uo + t0, u1 = F.uo + t1;
	UVS[0] = u0; UVS[1] = d0; UVS[2] = u1; UVS[3] = d0; UVS[4] = u1; UVS[5] = d1; UVS[6] = u0; UVS[7] = d1;
	B.quad(P, 0, sgn, 0, UVS, c, layer, dirt, dirt, dirt, dirt);
}
/** Box against the wall. mask: 1 front, 2 top, 4 bottom, 8 start side, 16 end side. */
function box(B, F, t0, t1, y0, y1, d0, d1, c, layer, dirt, mask = 31, dirtTop = dirt) {
	if (mask & 1) front(B, F, t0, t1, y0, y1, d1, c, layer, dirt, dirt, dirtTop, dirtTop);
	if (mask & 2) horiz(B, F, t0, t1, y1, d0, d1, 1, c, layer, dirtTop);
	if (mask & 4) horiz(B, F, t0, t1, y0, d0, d1, -1, c, layer, dirt);
	if (mask & 8) side(B, F, t0, y0, y1, d0, d1, -1, c, layer, dirt);
	if (mask & 16) side(B, F, t1, y0, y1, d0, d1, 1, c, layer, dirt);
}

function glassQuad(G, F, t0, t1, y0, y1, d, W, W2) {
	const b = G.n;
	G.vert(F.X(t0, d), y0, F.Z(t0, d), F.nx, F.nz, F.ux, F.uz, 0, 0, W, W2);
	G.vert(F.X(t1, d), y0, F.Z(t1, d), F.nx, F.nz, F.ux, F.uz, 1, 0, W, W2);
	G.vert(F.X(t1, d), y1, F.Z(t1, d), F.nx, F.nz, F.ux, F.uz, 1, 1, W, W2);
	G.vert(F.X(t0, d), y1, F.Z(t0, d), F.nx, F.nz, F.ux, F.uz, 0, 1, W, W2);
	pushQuadIdx(G, b, F.nx, F.nz, F.ux, F.uz);
}
/** Index order for a quad laid out (t0,y0),(t1,y0),(t1,y1),(t0,y1) so its front faces the normal. */
function pushQuadIdx(B, b, nx, nz, ux, uz) {
	// Geometric normal of (t0,y0)->(t1,y0)->(t1,y1) is along x up = (-uz, 0, ux).
	if (-uz * nx + ux * nz >= 0) B.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
	else B.idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
}

function railQuad(R, F, t0, t1, y0, y1, d, row) {
	const b = R.n;
	const h = Math.max(0.01, y1 - y0);
	const v0 = row * 0.25 + 0.005, v1 = row * 0.25 + 0.245;
	const pts = [[t0, y0, 0, v0], [t1, y0, t1 - t0, v0], [t1, y1, t1 - t0, v1], [t0, y1, 0, v1]];
	for (const [t, y, u, v] of pts) {
		R.pos.push(F.X(t, d), y, F.Z(t, d)); R.nrm.push(F.nx, 0, F.nz); R.uv.push(u / Math.max(0.9, h), v); R.n++;
	}
	pushQuadIdx(R, b, F.nx, F.nz, F.ux, F.uz);
}
/** A railing across the wall direction (balcony sides): from depth d0 to d1 at position t. */
function railSide(R, F, t, y0, y1, d0, d1, row) {
	const b = R.n;
	const v0 = row * 0.25 + 0.005, v1 = row * 0.25 + 0.245;
	const h = Math.max(0.01, y1 - y0);
	const pts = [[d0, y0, 0, v0], [d1, y0, d1 - d0, v0], [d1, y1, d1 - d0, v1], [d0, y1, 0, v1]];
	for (const [d, y, u, v] of pts) { R.pos.push(F.X(t, d), y, F.Z(t, d)); R.nrm.push(F.ux, 0, F.uz); R.uv.push(Math.abs(u) / Math.max(0.9, h), v); R.n++; }
	R.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
}

// ---------------------------------------------------------------- profiles

// Cornice profiles (d outwards, y up from the cornice base), from the wall at the bottom round to
// the wall at the top. Grand: frieze, bed moulding, soffit with consoles, corona, cyma.
const PROFILES = {
	3: [[0, 0], [0.05, 0], [0.05, 0.42], [0.12, 0.46], [0.16, 0.56], [0.74, 0.6], [0.76, 0.64], [0.76, 0.84], [0.84, 0.9], [0.86, 1.0], [0.0, 1.06]],
	2: [[0, 0], [0.04, 0], [0.04, 0.28], [0.12, 0.34], [0.5, 0.42], [0.52, 0.62], [0.58, 0.7], [0.0, 0.76]],
	1: [[0, 0], [0.08, 0.04], [0.26, 0.14], [0.3, 0.3], [0.0, 0.36]],
	court: [[0, 0], [0.12, 0.06], [0.22, 0.2], [0.0, 0.26]],
	string: [[0, 0], [0.06, 0.02], [0.09, 0.12], [0.11, 0.2], [0.04, 0.24], [0.0, 0.26]],
	sill: [[0, 0], [0.04, 0.0], [0.06, 0.06], [0.06, 0.16], [0, 0.18]],
};
export function profileHeight(p) { return PROFILES[p][PROFILES[p].length - 1][1]; }

/**
 * Extrudes a profile along a wall segment at base height yb. End offsets em0/em1 are mitre vectors
 * (x, z, scaled so their component along the wall normal is 1) or null for a square, capped end.
 */
function extrude(B, F, len, yb, prof, c, layer, dirt, m0, m1, scale = 1) {
	const n = prof.length;
	const at = (t, m, d) => (m ? [F.X(t, 0) + m[0] * d, F.Z(t, 0) + m[1] * d] : [F.X(t, d), F.Z(t, d)]);
	for (let k = 0; k + 1 < n; k++) {
		const [da, ya] = prof[k], [db, yb2] = prof[k + 1];
		const dA = da * scale, dB = db * scale, yA = yb + ya * scale, yB = yb + yb2 * scale;
		// 2D outward normal of this profile edge (profile runs counter-clockwise in (d, y)).
		let pd = yB - yA, py = -(dB - dA);
		const pl = Math.hypot(pd, py) || 1;
		pd /= pl; py /= pl;
		const [x0a, z0a] = at(0, m0, dA), [x1a, z1a] = at(len, m1, dA), [x1b, z1b] = at(len, m1, dB), [x0b, z0b] = at(0, m0, dB);
		P[0] = x0a; P[1] = yA; P[2] = z0a; P[3] = x1a; P[4] = yA; P[5] = z1a; P[6] = x1b; P[7] = yB; P[8] = z1b; P[9] = x0b; P[10] = yB; P[11] = z0b;
		const vA = ya * scale + da * scale, vB = yb2 * scale + db * scale;
		UVS[0] = F.uo; UVS[1] = vA; UVS[2] = F.uo + len; UVS[3] = vA; UVS[4] = F.uo + len; UVS[5] = vB; UVS[6] = F.uo; UVS[7] = vB;
		B.quad(P, F.nx * pd, py, F.nz * pd, UVS, c, layer, dirt, dirt, dirt, dirt);
	}
	// Caps at square ends: fan from the profile's centroid.
	for (const [t, m, sgn] of [[0, m0, -1], [len, m1, 1]]) {
		if (m) continue;
		let cd = 0, cy = 0;
		for (const [d, y] of prof) { cd += d; cy += y; }
		cd = (cd / n) * scale; cy = yb + (cy / n) * scale;
		for (let k = 0; k + 1 < n; k++) {
			const [da, ya] = prof[k], [db, yb2] = prof[k + 1];
			P[0] = F.X(t, cd); P[1] = cy; P[2] = F.Z(t, cd);
			P[3] = F.X(t, da * scale); P[4] = yb + ya * scale; P[5] = F.Z(t, da * scale);
			P[6] = F.X(t, db * scale); P[7] = yb + yb2 * scale; P[8] = F.Z(t, db * scale);
			UVS[0] = cd; UVS[1] = cy; UVS[2] = da; UVS[3] = ya; UVS[4] = db; UVS[5] = yb2;
			B.tri(P, F.ux * sgn, 0, F.uz * sgn, UVS, c, layer, dirt);
		}
	}
}

/** Mitre vector between two outward normals (scaled so its component along each normal is 1). */
function mitre(ax, az, bx, bz) {
	const dot = ax * bx + az * bz;
	if (dot < -0.7) return null;
	const k = 1 / (1 + dot);
	return [(ax + bx) * k, (az + bz) * k];
}

// ---------------------------------------------------------------- per building detail

const SILL_H = 0.88;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Segments grouped per ring, each with prev/next (geometric neighbours around the ring). */
function ringLinks(info) {
	const byRing = new Map();
	for (const s of info.segs) {
		if (!byRing.has(s.ri)) byRing.set(s.ri, []);
		byRing.get(s.ri).push(s);
	}
	for (const list of byRing.values()) {
		const n = list.length;
		list.forEach((s, i) => { s.prev = list[(i - 1 + n) % n]; s.next = list[(i + 1) % n]; });
	}
	// Distance along the ring for continuous texture coordinates.
	for (const s of info.segs) s.uo = s.e.ri * 37.1 + s.e.i * 13.7 + s.t0;
	return byRing;
}

/** Edge weights for the roof: 0 where the wall is a party wall or a blank plot-line firewall. */
function roofWeights(info) {
	const W = info.rings.map((r) => new Array(r.length).fill(1));
	const shared = new Map();
	for (const s of info.segs) {
		const k = s.e.ri + ':' + s.e.i;
		const blank = s.kind === 'party' || (s.kind === 'side' && s.firewall);
		shared.set(k, (shared.get(k) || 0) + (blank ? s.len : 0));
	}
	info.edges.forEach((e) => {
		if (e.len < 1e-6) return;
		if ((shared.get(e.ri + ':' + e.i) || 0) > e.len * 0.5) W[e.ri][e.i] = 0;
	});
	if (info.roof.kind === 'gable') {
		// Ridge along the longest wall: walls across it become gables.
		let best = null;
		for (const e of info.edges) if (e.ri === 0 && (!best || e.len > best.len)) best = e;
		if (best) for (const e of info.edges) if (Math.abs(e.ux * best.ux + e.uz * best.uz) < 0.5) W[e.ri][e.i] = 0;
	}
	return W;
}

/** Roof faces of a building (cached: the far shell and the detail share them). */
export function roofOf(info) {
	if (info.roofCache) return info.roofCache;
	const r = info.roof;
	let kind = r.kind;
	// Flat roofs get a parapet: the roof plane sits a little below the wall top.
	const y0 = info.wallTop - (kind === 'flat' ? 0.55 : 0);
	const W = roofWeights(info);
	let res;
	try {
		res = roofFaces(info.rings, W, y0, { kind: kind === 'gable' ? 'hip' : kind, pitch: r.pitch, rise: r.rise, cap: info.style === 'house' ? 5 : 6.5 });
	} catch {
		res = roofFaces(info.rings, W, y0, { kind: 'flat' });
	}
	info.roofCache = res;
	return res;
}

/** Shop/bay/gate decisions for one street-facing segment (deterministic per building). */
function groundPlan(info, seg, bays, r, isMain) {
	const kinds = new Array(bays.n).fill('wall');
	const pois = new Array(bays.n).fill(null);
	if (info.base > 1 || bays.n === 0) return { kinds, pois, gate: -1 };
	// Points of interest take the nearest free bay.
	for (const { poi, t } of seg.pois) {
		let k = Math.round((t - bays.start) / bays.step - 0.5);
		k = Math.max(0, Math.min(bays.n - 1, k));
		for (let o = 0; o < bays.n; o++) {
			const kk = (k + (o % 2 ? (o + 1) / 2 : -o / 2) + bays.n * 4) % bays.n;
			if (!pois[kk]) { pois[kk] = poi; kinds[kk] = 'shop'; break; }
		}
	}
	let gate = -1;
	const tenement = TENEMENT.has(info.style) && info.style !== 'house' && info.levels >= 2;
	if (isMain && (tenement || info.style === 'palace') && bays.n >= 1 && bays.step > 2.9) {
		// The gate sits in the central axis (or next to it), never where a mapped shop is.
		const mid = Math.floor(bays.n / 2);
		for (const k of [mid, mid - 1, mid + 1, 0, bays.n - 1]) if (k >= 0 && k < bays.n && kinds[k] !== 'shop') { gate = k; break; }
		if (gate >= 0) kinds[gate] = 'gate';
	} else if (isMain && info.style === 'house' && bays.n >= 2) {
		gate = bays.n - 1;
		kinds[gate] = 'gate';
	}
	for (let k = 0; k < bays.n; k++) {
		if (kinds[k] !== 'wall') continue;
		const x = r();
		if (info.style === 'modern') kinds[k] = x < info.shopShare ? 'shop' : 'lobby';
		else if (info.style === 'socialist' || info.style === 'industrial') kinds[k] = x < info.shopShare ? 'shop' : 'window';
		else kinds[k] = x < info.shopShare ? 'shop' : x < info.shopShare + 0.08 ? 'door' : 'window';
	}
	return { kinds, pois, gate };
}

/**
 * Generates the detailed geometry of one building into the chunk buffers.
 * out = { opaque: OpaqueBuf, glass: GlassBuf, rail: RailBuf, signs: [] (sign requests) }.
 */
export function buildDetail(info, out) {
	const { opaque: B, glass: G, rail: R } = out;
	const S = STYLES[info.style];
	const r = rng(info.seed ^ 0x2545f491);
	ringLinks(info);
	const F = new Frame();
	const fy = info.floorY;
	const L = info.levels;
	const base = info.base;
	const wallTop = info.wallTop;
	const topFloorTop = fy[L];
	const axis = lerp(S.axis[0], S.axis[1], r());
	const winW = lerp(S.winW[0], S.winW[1], r());
	const winH = lerp(S.winH[0], S.winH[1], r());
	const recess = S.recess;
	const plaster = info.plaster, trim = info.trim;
	const rustic = r() < S.rustic;
	const groundCol = info.groundTone < 0.3 ? trim : info.groundTone < 0.55 ? plaster.map((c) => c * 0.9) : plaster;
	const stone = hexRgb(info.groundTone < 0.5 ? '#8f8a80' : '#a39d90');
	const dirtBase = info.dirt * 0.32;
	const isBrick = info.style === 'brick' || (info.style === 'industrial' && info.seed % 3 === 0);
	const wallLayer = isBrick ? LAYER.BRICK : info.style === 'socialist' ? LAYER.CONCRETE : info.renovated ? LAYER.PLASTER : LAYER.ROUGH;
	const wallCol = isBrick ? plaster.map((c) => Math.min(1, c * 1.25 + 0.1)) : plaster;
	// The main street front: the longest street-facing segment.
	let main = null;
	for (const s of info.segs) if (s.kind === 'street' && (!main || s.len > main.len)) main = s;
	const frameIdx = info.frame;

	const dirtAt = (y) => dirtBase + info.dirt * 0.55 * smooth(wallTop - 4.5, wallTop - 0.2, y) + 0.55 * Math.max(0, 1 - (y - base) / 0.9);

	for (const seg of info.segs) {
		F.set(seg, seg.uo);
		const len = seg.len;
		if (len < 0.25) continue;
		const prevExposed = seg.prev && seg.prev !== seg && seg.prev.kind !== 'party';
		const nextExposed = seg.next && seg.next !== seg && seg.next.kind !== 'party';

		if (seg.kind === 'party') {
			if (seg.coverTop < wallTop - 0.3) firewall(B, F, info, seg, Math.max(base, seg.coverTop), wallTop, r);
			continue;
		}
		const tenement = TENEMENT.has(info.style);
		if (seg.kind === 'side' && tenement && (r() < 0.75 || len < 3)) {
			seg.firewall = true;
			firewall(B, F, info, seg, base, wallTop, r);
			continue;
		}
		const court = seg.kind !== 'street';
		const m0 = prevExposed ? 0.95 : 0.65, m1 = nextExposed ? 0.95 : 0.65;
		const ax = court ? axis * 0.9 : axis;
		const bays = layoutBays(len, ax, m0, m1, court ? 1.5 : 1.8);
		const windows = []; // { t0, t1, y0, y1 } for dirt streaks
		const openings = []; // per floor band: [{ t0, t1, y0, y1, arch }]
		for (let f = 0; f < L; f++) openings.push([]);
		const decor = []; // deferred decoration calls

		// Short corner pieces (chamfers) between two street fronts: corner balconies.
		const chamfer = !court && len < 7.5 && seg.prev.kind === 'street' && seg.next.kind === 'street' && bays.n === 1;
		const plan = !court ? groundPlan(info, seg, bays, r, seg === main) : null;
		const gangs = court && info.gangs && len > 3.5 && L >= 2 && info.base < 1 && seg.kind === 'court';

		for (let k = 0; k < bays.n; k++) {
			const c = bays.start + (k + 0.5) * bays.step;
			const maxW = Math.max(0.6, bays.step - 0.7);
			// Ground floor.
			if (base < 1 && L >= 1) {
				const g0 = fy[0], g1 = fy[1];
				const kind = court ? (gangs || r() < 0.3 ? (k % 3 === 1 ? 'door' : 'window') : 'window') : plan.kinds[k];
				if (kind === 'gate') {
					const w = Math.min(maxW, info.style === 'house' ? 2.4 : 2.8 + r() * 0.5);
					const h = Math.min(g1 - g0 - 0.55, info.style === 'house' ? 3.0 : 4.3);
					const rad = w / 2;
					const o = { t0: c - w / 2, t1: c + w / 2, y0: g0, y1: g0 + h, arch: rad };
					openings[0].push(o);
					decor.push(() => gate(B, G, F, o, info, r, stone));
				} else if (kind === 'shop' || kind === 'lobby') {
					const w = Math.min(maxW, info.style === 'modern' ? bays.step - 0.5 : 3.3);
					const top = Math.min(g1 - 0.9, g0 + (g1 - g0 > 4.6 ? 3.6 : 3.1));
					const o = { t0: c - w / 2, t1: c + w / 2, y0: g0, y1: top };
					openings[0].push(o);
					const poi = plan.pois[k];
					decor.push(() => shopfront(B, G, F, o, info, r, poi, kind === 'lobby', out, g1, seg));
				} else if (kind === 'door') {
					const w = Math.min(maxW, 1.1);
					const o = { t0: c - w / 2, t1: c + w / 2, y0: g0, y1: g0 + Math.min(2.5, g1 - g0 - 0.6) };
					openings[0].push(o);
					decor.push(() => windowUnit(B, G, F, o, info, r, { mode: GLASS.DOOR, frame: frameIdx === 0 ? FRAME.BROWN : frameIdx, sill: false, surround: !court, lintel: false, recess: 0.18 }));
				} else {
					const sillY = g0 + (court ? 0.95 : info.style === 'socialist' || info.style === 'modern' ? 0.9 : 1.25);
					const w = Math.min(maxW, court ? winW * 0.8 : winW);
					const h = Math.min(court ? winH * 0.75 : winH, g1 - sillY - 0.55);
					if (h > 0.6) {
						const o = { t0: c - w / 2, t1: c + w / 2, y0: sillY, y1: sillY + h };
						openings[0].push(o);
						windows.push(o);
						decor.push(() => windowUnit(B, G, F, o, info, r, { mode: GLASS.FLAT, bars: !court || r() < 0.5, frame: frameIdx, surround: !court && S.lintel > 0, lintel: false, recess }));
					}
				}
			}
			// Upper floors.
			for (let f = Math.max(1, base > 1 ? 0 : 1); f < L; f++) {
				const y0f = fy[f], y1f = fy[f + 1];
				const fh = y1f - y0f;
				let w = Math.min(maxW, court ? winW * (k % 3 === 1 && gangs ? 0.72 : 0.82) : chamfer ? Math.min(winW, len - 0.9) : winW);
				let h = court ? winH * 0.72 : f === L - 1 && L > 3 && info.style !== 'modern' && info.style !== 'socialist' ? winH * 0.88 : winH;
				let sill = court ? 1.0 : SILL_H;
				if (info.style === 'modern' || info.style === 'socialist') sill = info.style === 'modern' ? 0.45 : 0.85;
				h = Math.min(h, fh - sill - (court ? 0.35 : 0.5));
				if (w < 0.4 || h < 0.5) continue;
				const balcony = !court && ((chamfer && r() < 0.65) || (seg === main && info.balconyAxis && bays.n >= 3 && (bays.n % 2 ? k === (bays.n - 1) / 2 : false) && (f === 1 || (f === 2 && L >= 4 && info.seed % 2 === 0))) || (info.style === 'socialist' && k % 2 === 0 && info.seed % 3 === 0));
				const door = court && gangs && k % 3 === 1;
				if (door) { sill = 0.02; h = Math.min(2.25, fh - 0.4); w = Math.min(w, 0.95); }
				const o = { t0: c - w / 2, t1: c + w / 2, y0: y0f + (balcony ? 0.04 : sill), y1: y0f + sill + h };
				openings[f].push(o);
				windows.push(o);
				const mode = door ? GLASS.DOOR : info.style === 'modern' ? GLASS.OFFICE : GLASS.FLAT;
				const lint = court ? 0 : f === 1 ? info.lintelKind : f < L - 1 ? Math.min(1, info.lintelKind) : 0;
				decor.push(() => windowUnit(B, G, F, o, info, r, { mode, frame: frameIdx, sill: !balcony && !door && info.style !== 'modern', surround: !court && S.lintel > 0, lintel: lint, recess: door ? 0.15 : recess, floor: f, shutters: info.shutters && !court, balconyDoor: balcony }));
				if (balcony) decor.push(() => balconyAt(B, R, F, c, w, y0f, info, r, f, chamfer));
			}
		}

		// Wall bands with holes.
		const bandLayer = (f, y) => {
			if (y < base + S.plinth && base < 1) return LAYER.STONE;
			if (f === 0 && base < 1 && rustic && !court && !isBrick) return LAYER.RUSTIC;
			return court ? (isBrick ? LAYER.BRICK : LAYER.ROUGH) : wallLayer;
		};
		for (let f = 0; f < L; f++) {
			const y0 = fy[f], y1 = f === L - 1 ? wallTop : fy[f + 1];
			const extra = [];
			if (f === 0 && base < 1) { extra.push(base + S.plinth); extra.push(base + 0.9); }
			wallBand(B, F, len, y0, y1, openings[f], extra, (y) => bandLayer(f, y), (y, lay) => (lay === LAYER.STONE ? stone : f === 0 && !court && !isBrick ? groundCol : wallCol), windows, dirtAt, info.dirt);
		}
		for (const fn of decor) fn();

		// String courses, the main cornice and the gangs.
		const mStart = prevExposed ? mitre(seg.prev.nx, seg.prev.nz, seg.nx, seg.nz) : null;
		const mEnd = nextExposed ? mitre(seg.nx, seg.nz, seg.next.nx, seg.next.nz) : null;
		const decoCol = trim;
		if (!court && base < 1 && L >= 2 && info.style !== 'modern' && info.style !== 'socialist') {
			extrude(B, F, len, fy[1] - 0.06, PROFILES.string, decoCol, LAYER.PLASTER, dirtBase + 0.15, mStart, mEnd, 1.15);
		}
		if (!court && S.string && L >= 3) {
			for (let f = 2; f < L; f++) if (f === 2 || info.style === 'palace' || info.seed % 4 === 0) extrude(B, F, len, fy[f] - 0.05, PROFILES.string, decoCol, LAYER.PLASTER, dirtBase + 0.2, mStart, mEnd, 0.8);
		}
		const cKind = court ? (S.cornice > 0 ? 'court' : 0) : S.cornice;
		if (cKind && L >= 1) {
			const prof = cKind;
			const ph = profileHeight(prof);
			const scale = court ? 1 : Math.min(1.25, Math.max(0.75, info.cz / 1.2));
			const yb = wallTop - ph * scale;
			if (!court && S.cornice === 3) {
				// Frieze band with ornament under the cornice.
				front(B, F, 0, len, yb - 0.42, yb, 0.012, decoCol, LAYER.ORN, dirtBase + 0.35, dirtBase + 0.35, dirtBase + 0.4, dirtBase + 0.4);
			}
			extrude(B, F, len, yb, PROFILES[prof], decoCol, prof === 3 ? LAYER.ORN : LAYER.PLASTER, dirtBase + 0.25 + info.dirt * 0.25, mStart, mEnd, scale);
			if (!court && info.consoles && prof === 3) {
				const n = Math.floor((len - 0.4) / 0.85);
				for (let k = 0; k < n; k++) {
					const t = 0.2 + (len - 0.4) * (k + 0.5) / n;
					box(B, F, t - 0.08, t + 0.08, yb + 0.3 * scale, yb + 0.58 * scale, 0.05, 0.68 * scale, decoCol, LAYER.PLASTER, dirtBase + 0.4, 29);
				}
			}
		}
		if (gangs) gangWalk(B, R, F, seg, info, r, prevExposed && seg.prev.kind === 'court');
	}

	// Roof, gables and chimneys.
	roofDetail(B, info, r);
}

/** One floor band of a wall with rectangular (and arched) openings cut out. */
function wallBand(B, F, len, y0, y1, ops, extraY, layerAt, colAt, windows, dirtAt, dirtK) {
	if (y1 - y0 < 0.02) return;
	const xs = [0, len];
	const ys = [y0, y1];
	for (const o of ops) {
		xs.push(o.t0, o.t1);
		ys.push(o.y0, o.arch ? o.y1 - o.arch : o.y1, o.y1);
	}
	for (const y of extraY) if (y > y0 && y < y1) ys.push(y);
	xs.sort((a, b) => a - b);
	ys.sort((a, b) => a - b);
	const X = [], Y = [];
	for (const x of xs) if (x >= -1e-6 && x <= len + 1e-6 && (!X.length || x - X[X.length - 1] > 0.004)) X.push(Math.min(len, Math.max(0, x)));
	for (const y of ys) if (y >= y0 - 1e-6 && y <= y1 + 1e-6 && (!Y.length || y - Y[Y.length - 1] > 0.004)) Y.push(y);
	for (let i = 0; i + 1 < X.length; i++) {
		const t0 = X[i], t1 = X[i + 1], tm = (t0 + t1) / 2;
		// Window above this column (for the dirt streak running down from its sill).
		const above = [];
		for (const w of windows) if (tm > w.t0 && tm < w.t1) above.push(w);
		for (let j = 0; j + 1 < Y.length; j++) {
			const ya = Y[j], yb = Y[j + 1], ym = (ya + yb) / 2;
			let hole = null;
			for (const o of ops) if (tm > o.t0 && tm < o.t1 && ym > o.y0 && ym < o.y1) { hole = o; break; }
			const lay = layerAt(ym);
			const col = colAt(ym, lay);
			if (hole) {
				if (hole.arch && ym > hole.y1 - hole.arch) spandrel(B, F, hole, col, lay, dirtAt(ym));
				continue;
			}
			const streak = (y) => {
				let s = 0;
				for (const w of above) if (w.y0 >= y - 1e-3 && w.y0 - y < 3.2) s = Math.max(s, (1 - (w.y0 - y) / 3.2) ** 1.4);
				return s * (0.25 + dirtK * 0.75);
			};
			const da = dirtAt(ya) + streak(ya), db = dirtAt(yb) + streak(yb);
			front(B, F, t0, t1, ya, yb, 0, col, lay, da, da, db, db);
		}
	}
}

/** The wall left over above a round arch inside its rectangle (two fans). */
function spandrel(B, F, o, col, lay, dirt) {
	const c = (o.t0 + o.t1) / 2, ys = o.y1 - o.arch, r = o.arch;
	const N = 8;
	for (let k = 0; k < N; k++) {
		const a0 = Math.PI - (k / N) * Math.PI, a1 = Math.PI - ((k + 1) / N) * Math.PI;
		const t0 = c + Math.cos(a0) * r, y0 = ys + Math.sin(a0) * r, t1 = c + Math.cos(a1) * r, y1 = ys + Math.sin(a1) * r;
		const tc = k < N / 2 ? o.t0 : o.t1;
		P[0] = F.X(tc, 0); P[1] = o.y1; P[2] = F.Z(tc, 0);
		P[3] = F.X(t0, 0); P[4] = y0; P[5] = F.Z(t0, 0);
		P[6] = F.X(t1, 0); P[7] = y1; P[8] = F.Z(t1, 0);
		UVS[0] = F.uo + tc; UVS[1] = o.y1; UVS[2] = F.uo + t0; UVS[3] = y0; UVS[4] = F.uo + t1; UVS[5] = y1;
		B.tri(P, F.nx, 0, F.nz, UVS, col, lay, dirt);
	}
}

/** Reveals (inside faces of an opening) from depth dFront back to -depth. */
function reveals(B, F, o, depth, col, lay, dirt, dFront = 0, skipBottom = false) {
	side(B, F, o.t0, o.y0, o.y1, dFront, -depth, 1, col, lay, dirt);
	side(B, F, o.t1, o.y0, o.y1, dFront, -depth, -1, col, lay, dirt);
	horiz(B, F, o.t0, o.t1, o.y1, dFront, -depth, -1, col, lay, dirt);
	if (!skipBottom) horiz(B, F, o.t0, o.t1, o.y0, dFront, -depth, 1, col, lay, dirt + 0.2);
}

/** A window (or glazed door) in its opening: reveals, glass, surround, sill, lintel, shutters. */
function windowUnit(B, G, F, o, info, r, opt) {
	const depth = opt.recess;
	const sur = opt.surround;
	const fw = sur ? 0.15 : 0, fd = sur ? 0.045 : 0;
	const trim = info.trim, dirt = info.dirt * 0.3;
	reveals(B, F, o, depth, info.plaster.map((c) => c * 0.92), info.renovated ? LAYER.PLASTER : LAYER.ROUGH, dirt + 0.1, fd, opt.sill === false && !sur);
	const blind = opt.mode === GLASS.FLAT && r() < info.blinds ? (r() < 0.35 ? 1 : 0.15 + r() * 0.75) : 0;
	const curtain = r();
	const flags = (opt.bars ? 1 : 0) + (opt.floor === 0 ? 2 : 0);
	glassQuad(G, F, o.t0, o.t1, o.y0, o.y1, -depth, [o.t1 - o.t0, o.y1 - o.y0, r(), opt.mode], [blind, curtain, opt.frame, flags]);
	if (sur) {
		// Raised stucco surround: left, right and top bars (front faces + outer sides).
		box(B, F, o.t0 - fw, o.t0, o.y0, o.y1 + fw, 0, fd, trim, LAYER.PLASTER, dirt, 1 | 8);
		box(B, F, o.t1, o.t1 + fw, o.y0, o.y1 + fw, 0, fd, trim, LAYER.PLASTER, dirt, 1 | 16);
		box(B, F, o.t0 - fw, o.t1 + fw, o.y1, o.y1 + fw, 0, fd, trim, LAYER.PLASTER, dirt + 0.1, 1 | 2);
		if (opt.sill === false) box(B, F, o.t0 - fw, o.t1 + fw, o.y0 - fw * 0.6, o.y0, 0, fd, trim, LAYER.PLASTER, dirt, 1 | 4 | 8 | 16);
	}
	if (opt.sill !== false && !opt.balconyDoor) {
		const sw = fw + 0.1;
		box(B, F, o.t0 - sw, o.t1 + sw, o.y0 - 0.12, o.y0, 0, 0.14, sur ? trim : info.plaster.map((c) => c * 0.85), LAYER.PLASTER, dirt + 0.35, 31, dirt + 0.6);
		// A sill-height panel under the window on the grander fronts.
		if (sur && opt.floor >= 1 && info.lintelKind >= 2) box(B, F, o.t0, o.t1, o.y0 - 0.75, o.y0 - 0.2, 0, 0.025, trim, LAYER.ORN, dirt + 0.2, 1 | 2 | 4 | 8 | 16);
	}
	const lk = opt.lintel || 0;
	if (lk >= 1 && sur) {
		const y = o.y1 + fw, ext = fw + 0.14;
		// Cap (szemöldökpárkány).
		box(B, F, o.t0 - ext, o.t1 + ext, y, y + 0.2, 0, 0.17, trim, LAYER.PLASTER, dirt + 0.2, 31, dirt + 0.5);
		if (lk === 2 || lk === 3) {
			// Triangular (2) or segmental (3) pediment on top of the cap.
			const t0 = o.t0 - ext, t1 = o.t1 + ext, yb = y + 0.2, hgt = (t1 - t0) * (lk === 2 ? 0.2 : 0.16);
			const cTop = yb + hgt;
			const pts = lk === 2 ? [[t0, yb], [(t0 + t1) / 2, cTop], [t1, yb]] : [0, 1, 2, 3, 4].map((k) => { const a = Math.PI - (k / 4) * Math.PI; return [(t0 + t1) / 2 + Math.cos(a) * (t1 - t0) / 2, yb + Math.sin(a) * hgt]; });
			for (let k = 0; k + 1 < pts.length; k++) {
				const [ta, ya] = pts[k], [tb, yb2] = pts[k + 1];
				// Sloped top face.
				setP(F, 0, ta, ya, 0); setP(F, 1, tb, yb2, 0); setP(F, 2, tb, yb2, 0.17); setP(F, 3, ta, ya, 0.17);
				const ex = tb - ta, ey = yb2 - ya, el = Math.hypot(ex, ey) || 1;
				const nUp = ex / el, nAl = -ey / el; // normal in (t, y): (-ey, ex)
				UVS[0] = F.uo + ta; UVS[1] = 0; UVS[2] = F.uo + tb; UVS[3] = 0; UVS[4] = F.uo + tb; UVS[5] = 0.17; UVS[6] = F.uo + ta; UVS[7] = 0.17;
				B.quad(P, F.ux * nAl, nUp, F.uz * nAl, UVS, trim, LAYER.PLASTER, dirt + 0.5, dirt + 0.5, dirt + 0.5, dirt + 0.5);
				// Front (tympanum) triangle from the base centre.
				P[0] = F.X((t0 + t1) / 2, 0.17); P[1] = yb; P[2] = F.Z((t0 + t1) / 2, 0.17);
				P[3] = F.X(ta, 0.17); P[4] = ya; P[5] = F.Z(ta, 0.17);
				P[6] = F.X(tb, 0.17); P[7] = yb2; P[8] = F.Z(tb, 0.17);
				UVS[0] = F.uo + (t0 + t1) / 2; UVS[1] = yb; UVS[2] = F.uo + ta; UVS[3] = ya; UVS[4] = F.uo + tb; UVS[5] = yb2;
				B.tri(P, F.nx, 0, F.nz, UVS, trim, LAYER.ORN, dirt + 0.3);
			}
		}
		if (lk >= 2 && sur) {
			// Small consoles carrying the cap.
			for (const t of [o.t0 - fw * 0.5, o.t1 + fw * 0.5]) box(B, F, t - 0.07, t + 0.07, y - 0.32, y, fd, 0.14, trim, LAYER.PLASTER, dirt + 0.2, 1 | 4 | 8 | 16);
		}
	}
	if (opt.shutters) {
		// Opened wooden louvred shutters (zsalugáter) folded back against the wall.
		const w = (o.t1 - o.t0) / 2, col = hexRgb(info.seed % 2 ? '#4d5e47' : '#6a5038');
		for (const [ta, tb] of [[o.t0 - fw - w - 0.04, o.t0 - fw - 0.04], [o.t1 + fw + 0.04, o.t1 + fw + w + 0.04]]) box(B, F, ta, tb, o.y0, o.y1, 0, 0.04, col, LAYER.WOOD, dirt, 31);
	}
}

/** Shopfront: recessed glazing with frame, fascia sign, shutter box. */
function shopfront(B, G, F, o, info, r, poi, lobby, out, gTop, seg) {
	const depth = 0.28;
	const portal = info.style !== 'modern' && r() < 0.32;
	const dark = hexRgb(pick(r, ['#2b2522', '#1f2a24', '#30261f', '#202224', '#3a2a1e']));
	reveals(B, F, o, depth, portal ? dark : info.plaster.map((c) => c * 0.88), portal ? LAYER.WOOD : LAYER.ROUGH, info.dirt * 0.4 + 0.2, 0, true);
	// Threshold step.
	box(B, F, o.t0, o.t1, o.y0, o.y0 + 0.12, -depth, 0.05, hexRgb('#8b877e'), LAYER.STONE, 0.6, 1 | 2 | 8 | 16);
	let mode = GLASS.SHOP;
	const kind = poi ? poi.kind : '';
	const name = poi ? poi.name || '' : '';
	if (lobby) mode = GLASS.OFFICE;
	else if (!poi && r() < 0.16) mode = GLASS.EMPTY;
	else if (kind === 'tobacco' && !/smoke|vape/i.test(name)) mode = GLASS.TOBACCO;
	else if (kind === 'vape' || /vape|e-?smoke|e-?cig|liquid/i.test(name)) mode = GLASS.VAPE;
	else if (kind === 'cafe' || kind === 'bar' || kind === 'food') mode = GLASS.CAFE;
	else if (kind === 'pharmacy') mode = GLASS.PHARMACY;
	const hoursSeed = r();
	glassQuad(G, F, o.t0, o.t1, o.y0 + 0.12, o.y1, -depth + 0.02, [o.t1 - o.t0, o.y1 - o.y0 - 0.12, r(), mode], [hoursSeed, r(), portal ? FRAME.BROWN : FRAME.BLACK, 0]);
	if (portal) {
		// Old wooden shop portal (portál) around the opening.
		box(B, F, o.t0 - 0.22, o.t0, o.y0, o.y1 + 0.5, 0, 0.12, dark, LAYER.WOOD, 0.2, 1 | 8 | 16 | 2);
		box(B, F, o.t1, o.t1 + 0.22, o.y0, o.y1 + 0.5, 0, 0.12, dark, LAYER.WOOD, 0.2, 1 | 8 | 16 | 2);
		box(B, F, o.t0 - 0.22, o.t1 + 0.22, o.y1, o.y1 + 0.55, 0, 0.14, dark, LAYER.WOOD, 0.2, 31);
	} else if (mode !== GLASS.OFFICE && r() < 0.6) {
		// Roller-shutter box over the opening.
		box(B, F, o.t0 - 0.05, o.t1 + 0.05, o.y1, o.y1 + 0.3, 0, 0.16, hexRgb(pick(r, ['#8c8f90', '#6f7274', '#a7a49c'])), LAYER.METAL, 0.3, 31);
	}
	// Sign request: fascia above the opening (shopsigns.js draws it into the chunk atlas).
	const signY0 = o.y1 + (portal ? 0.04 : 0.36), signY1 = Math.min(gTop - 0.15, signY0 + 0.7);
	if (out.signs && signY1 - signY0 > 0.3 && mode !== GLASS.OFFICE) {
		out.signs.push({ seg, F: { ax: F.ax, az: F.az, ux: F.ux, uz: F.uz, nx: F.nx, nz: F.nz }, t0: o.t0 - (portal ? 0.1 : 0.15), t1: o.t1 + (portal ? 0.1 : 0.15), y0: signY0, y1: signY1, d: portal ? 0.15 : 0.06, poi, mode, seed: r(), gTop, shopTop: o.y1, bottom: o.y0 });
	}
}

/** Arched wooden gate (kapu) with a fanlight, stone surround and keystone. */
function gate(B, G, F, o, info, r, stone) {
	const depth = 0.5;
	const c = (o.t0 + o.t1) / 2, rad = o.arch, ys = o.y1 - rad;
	const wall = info.plaster.map((v) => v * 0.9);
	// Side reveals and the arched soffit.
	side(B, F, o.t0, o.y0, ys, 0, -depth, 1, wall, LAYER.ROUGH, 0.4);
	side(B, F, o.t1, o.y0, ys, 0, -depth, -1, wall, LAYER.ROUGH, 0.4);
	const N = 8;
	for (let k = 0; k < N; k++) {
		const a0 = Math.PI - (k / N) * Math.PI, a1 = Math.PI - ((k + 1) / N) * Math.PI;
		const t0 = c + Math.cos(a0) * rad, y0 = ys + Math.sin(a0) * rad, t1 = c + Math.cos(a1) * rad, y1 = ys + Math.sin(a1) * rad;
		setP(F, 0, t0, y0, 0); setP(F, 1, t1, y1, 0); setP(F, 2, t1, y1, -depth); setP(F, 3, t0, y0, -depth);
		const am = (a0 + a1) / 2;
		UVS[0] = 0; UVS[1] = t0; UVS[2] = 0; UVS[3] = t1; UVS[4] = depth; UVS[5] = t1; UVS[6] = depth; UVS[7] = t0;
		B.quad(P, -Math.cos(am) * F.ux, -Math.sin(am), -Math.cos(am) * F.uz, UVS, wall, LAYER.ROUGH, 0.35);
	}
	// Door leaves (wood) and the fanlight (glass with radial bars).
	const wood = hexRgb(pick(r, ['#5a3c26', '#4a3222', '#3c4a3a', '#5e2f25', '#3b3a36', '#6b4a2e']));
	front(B, F, o.t0, o.t1, o.y0, ys, -depth + 0.02, wood, LAYER.WOOD, 0.5, 0.5, 0.25, 0.25);
	// Transom bar between door and fanlight.
	box(B, F, o.t0, o.t1, ys - 0.12, ys, -depth + 0.02, -depth + 0.1, wood, LAYER.WOOD, 0.2, 1 | 2 | 4);
	const b0 = G.n;
	const W = [o.t1 - o.t0, rad, r(), GLASS.FANLIGHT], W2 = [0, 0, FRAME.BLACK, 0];
	G.vert(F.X(c, -depth + 0.03), ys, F.Z(c, -depth + 0.03), F.nx, F.nz, F.ux, F.uz, 0.5, 0, W, W2);
	for (let k = 0; k <= N; k++) {
		const a = Math.PI - (k / N) * Math.PI;
		const t = c + Math.cos(a) * rad, y = ys + Math.sin(a) * rad;
		G.vert(F.X(t, -depth + 0.03), y, F.Z(t, -depth + 0.03), F.nx, F.nz, F.ux, F.uz, 0.5 + Math.cos(a) * 0.5, Math.sin(a), W, W2);
	}
	for (let k = 0; k < N; k++) {
		// Triangle (centre, k, k+1) seen from outside.
		const a = b0, b = b0 + 1 + k, cc = b0 + 2 + k;
		// Points go anticlockwise in (t, y) as k grows when the frame's t axis points right.
		if (-F.uz * F.nx + F.ux * F.nz >= 0) G.idx.push(a, cc, b); else G.idx.push(a, b, cc);
	}
	// Stone surround with a keystone.
	const sw = 0.28;
	box(B, F, o.t0 - sw, o.t0, o.y0, ys, 0, 0.06, stone, LAYER.STONE, 0.3, 1 | 8 | 16);
	box(B, F, o.t1, o.t1 + sw, o.y0, ys, 0, 0.06, stone, LAYER.STONE, 0.3, 1 | 8 | 16);
	box(B, F, c - 0.2, c + 0.2, o.y1 - 0.05, o.y1 + 0.42, 0, 0.12, stone, LAYER.STONE, 0.3, 31);
	box(B, F, o.t0 - sw - 0.05, o.t0 + 0.02, ys - 0.02, ys + 0.18, 0, 0.1, stone, LAYER.STONE, 0.3, 31);
	box(B, F, o.t1 - 0.02, o.t1 + sw + 0.05, ys - 0.02, ys + 0.18, 0, 0.1, stone, LAYER.STONE, 0.3, 31);
}

/** Balcony: stone slab on consoles with a wrought-iron railing. */
function balconyAt(B, R, F, c, w, y, info, r, f, corner) {
	const half = corner ? w / 2 + 0.25 : w / 2 + 0.55 + (info.style === 'palace' ? 0.6 : 0);
	const depth = corner ? 0.75 : info.style === 'socialist' ? 1.2 : 0.95;
	const col = info.style === 'socialist' ? hexRgb('#b9b6ae') : info.trim;
	box(B, F, c - half, c + half, y - 0.2, y, 0, depth, col, LAYER.STONE, info.dirt * 0.4 + 0.2, 31, info.dirt * 0.5 + 0.3);
	if (info.style !== 'socialist') {
		const n = Math.max(2, Math.round(half * 2 / 1.1));
		for (let k = 0; k < n; k++) {
			const t = c - half + 0.2 + (half * 2 - 0.4) * (k / (n - 1));
			box(B, F, t - 0.07, t + 0.07, y - 0.62, y - 0.2, 0, depth * 0.75, col, LAYER.PLASTER, info.dirt * 0.4, 1 | 4 | 8 | 16);
		}
	}
	const row = info.style === 'secession' ? RAIL.SECESSION : info.style === 'socialist' || info.style === 'modern' ? RAIL.MODERN : RAIL.WROUGHT;
	railQuad(R, F, c - half, c + half, y, y + 1.0, depth - 0.04, row);
	railSide(R, F, c - half + 0.03, y, y + 1.0, 0, depth - 0.04, row);
	railSide(R, F, c + half - 0.03, y, y + 1.0, 0, depth - 0.04, row);
}

/** Courtyard walkways (gang) on every upper floor, on stone consoles, with iron railings. */
function gangWalk(B, R, F, seg, info, r, startShared) {
	const depth = 1.15;
	const t0 = startShared ? depth : 0, t1 = seg.len;
	if (t1 - t0 < 1.5) return;
	const col = hexRgb(info.seed % 2 ? '#a19c92' : '#8f8b84');
	for (let f = 1; f < info.levels; f++) {
		const y = info.floorY[f];
		box(B, F, t0, t1, y - 0.18, y, 0, depth, col, LAYER.STONE, info.dirt * 0.4 + 0.25, 31, info.dirt * 0.4 + 0.4);
		const n = Math.max(2, Math.round((t1 - t0) / 1.9));
		for (let k = 0; k <= n; k++) {
			const t = t0 + 0.25 + (t1 - t0 - 0.5) * (k / n);
			box(B, F, t - 0.09, t + 0.09, y - 0.55, y - 0.18, 0, depth * 0.8, col, LAYER.STONE, info.dirt * 0.4 + 0.2, 1 | 4 | 8 | 16);
		}
		railQuad(R, F, t0, t1, y, y + 1.0, depth - 0.05, RAIL.GANG);
		if (!startShared) railSide(R, F, t0 + 0.03, y, y + 1.0, 0, depth - 0.05, RAIL.GANG);
	}
}

/** Blank party wall above a lower neighbour (or a plot-line side): brick or grey plaster, sometimes a faded painted ad. */
function firewall(B, F, info, seg, y0, y1, r) {
	if (y1 - y0 < 0.1) return;
	const len = seg.len;
	const brick = (info.seed >> 3) % 5 < 2;
	const grey = hexRgb(pick(r, ['#9c978d', '#8f8b84', '#a8a299', '#b3aa98', '#8a8379']));
	const col = brick ? hexRgb('#b98c78') : grey;
	const lay = brick ? LAYER.BRICK : LAYER.ROUGH;
	const area = len * (y1 - y0);
	// Bands so the soot at the top and grime lower down shade the wall.
	const ys = [y0];
	for (let y = y0 + 3; y < y1 - 0.5; y += 3) ys.push(y);
	ys.push(y1);
	for (let j = 0; j + 1 < ys.length; j++) {
		const d0 = 0.25 + info.dirt * 0.5 * smooth(y1 - 6, y1, ys[j]) + 0.4 * Math.max(0, 1 - (ys[j] - info.base) / 1.5);
		const d1 = 0.25 + info.dirt * 0.5 * smooth(y1 - 6, y1, ys[j + 1]);
		front(B, F, 0, len, ys[j], ys[j + 1], 0, col, lay, d0, d0, d1, d1);
	}
	// Faded painted advertisement on big, high firewalls.
	if (area > 70 && len > 7 && y1 - y0 > 7 && info.adSeed < 0.22 && y1 > 12) {
		const w = Math.min(len - 1.5, 9 + info.adSeed * 20), h = w * 0.5;
		const top = y1 - 1.2, bot = Math.max(y0 + 1, top - h);
		const t0 = (len - w) / 2;
		const k = Math.floor(info.adSeed * 4 / 0.22) % 4;
		setP(F, 0, t0, bot, 0.015); setP(F, 1, t0 + w, bot, 0.015); setP(F, 2, t0 + w, top, 0.015); setP(F, 3, t0, top, 0.015);
		// The ad layer holds 4 ads in a 2x2 grid; uv picks one cell.
		const cu = (k % 2) * 0.5, cv = Math.floor(k / 2) * 0.5;
		UVS[0] = cu; UVS[1] = cv; UVS[2] = cu + 0.5; UVS[3] = cv; UVS[4] = cu + 0.5; UVS[5] = cv + 0.5; UVS[6] = cu; UVS[7] = cv + 0.5;
		B.quad(P, F.nx, 0, F.nz, UVS, [1, 1, 1], LAYER.AD, 0.35, 0.35, 0.35, 0.35);
	}
}

function pick(r, list) { return list[Math.floor(r() * list.length) % list.length]; }

/** Roof faces into the opaque buffer, plus chimneys on gables and ridges. */
function roofDetail(B, info, r) {
	const roof = roofOf(info);
	const lay = ROOF_LAYER[info.roof.mat];
	const rc = info.roof.colour;
	const gableCol = (info.seed >> 3) % 5 < 2 ? hexRgb('#b98c78') : hexRgb('#9c978d');
	const gableLay = (info.seed >> 3) % 5 < 2 ? LAYER.BRICK : LAYER.ROUGH;
	const P9 = new Float64Array(9), UV6 = new Float64Array(6);
	const chimneys = [];
	for (const f of roof.faces) {
		const pts = f.pts;
		let nx, ny, nz;
		{
			const [a, b, c] = pts;
			const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
			const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
			nx = uy * vz - uz * vy; ny = uz * vx - ux * vz; nz = ux * vy - uy * vx;
			const l = Math.hypot(nx, ny, nz);
			if (l < 1e-9) continue;
			nx /= l; ny /= l; nz /= l;
		}
		const isGable = f.kind === 'gable';
		const layer = isGable ? gableLay : f.kind === 'flat' ? LAYER.FLAT : lay;
		const col = isGable ? gableCol : f.kind === 'flat' ? hexRgb('#6e6c68') : rc;
		const dirt = isGable ? 0.45 + info.dirt * 0.3 : 0.15 + info.dirt * 0.25;
		// UVs: along the eave and up the slope (metres).
		const ux = f.ux ?? 1, uz = f.uz ?? 0;
		const uvOf = (p) => (isGable ? [p[0] * ux + p[2] * uz, p[1]] : f.kind === 'slope' ? [p[0] * ux + p[2] * uz, (p[0] * -uz + p[2] * ux) * (f.nx != null ? Math.sign(f.nx * -uz + f.nz * ux) || 1 : 1) * Math.hypot(1, (f.rise || 0) / Math.max(0.1, f.d || 1)) + p[1] * 0.0] : [p[0], p[2]]);
		for (let k = 1; k + 1 < pts.length; k++) {
			const A = pts[0], Bp = pts[k], C = pts[k + 1];
			P9[0] = A[0]; P9[1] = A[1]; P9[2] = A[2]; P9[3] = Bp[0]; P9[4] = Bp[1]; P9[5] = Bp[2]; P9[6] = C[0]; P9[7] = C[1]; P9[8] = C[2];
			const ua = uvOf(A), ub = uvOf(Bp), uc = uvOf(C);
			UV6[0] = ua[0]; UV6[1] = ua[1]; UV6[2] = ub[0]; UV6[3] = ub[1]; UV6[4] = uc[0]; UV6[5] = uc[1];
			B.tri(P9, nx, ny, nz, UV6, col, layer, dirt);
		}
		if (isGable && pts.length === 4) {
			// Chimney stacks along the top of the party wall.
			const a = pts[2], b = pts[3];
			const l = Math.hypot(b[0] - a[0], b[2] - a[2]);
			const n = l > 4 ? Math.min(3, 1 + Math.floor(l / 7)) : l > 1.2 ? 1 : 0;
			for (let k = 0; k < n; k++) {
				const t = (k + 0.5) / n;
				chimneys.push([a[0] + (b[0] - a[0]) * t - f.nx * 0.35, a[1], a[2] + (b[2] - a[2]) * t - f.nz * 0.35, f.ux, f.uz]);
			}
		}
	}
	if (!chimneys.length && info.roof.kind !== 'flat' && roof.topRings && roof.topRings[0] && TENEMENT.has(info.style)) {
		const ring = roof.topRings[0];
		const n = Math.min(3, Math.max(1, Math.floor(ring.length / 3)));
		for (let k = 0; k < n; k++) {
			const p = ring[Math.floor((k + 0.5) * ring.length / n) % ring.length];
			chimneys.push([p[0], roof.ridge, p[1], 1, 0]);
		}
	}
	const brick = hexRgb('#9a6a58'), cap = hexRgb('#8e8b84');
	for (const [x, y, z, ux, uz] of chimneys) {
		const h = 1.1 + r() * 0.9;
		const w = 0.42 + r() * 0.2, d = 0.42;
		const seg = { ax: x - ux * w, az: z - uz * w, ux, uz, nx: uz, nz: -ux };
		const F = new Frame().set(seg, x + z);
		box(B, F, 0, w * 2, y - 0.8, y + h, -d, d, brick, LAYER.BRICK, 0.55, 31, 0.9);
		box(B, F, -0.05, w * 2 + 0.05, y + h, y + h + 0.1, -d - 0.05, d + 0.05, cap, LAYER.CONCRETE, 0.6, 31);
		// The back face (box() skips it).
		side(B, { X: (t, dd) => F.X(t, dd), Z: (t, dd) => F.Z(t, dd), ux: -uz, uz: ux, uo: 0 }, -d, y - 0.8, y + h, 0, w * 2, -1, brick, LAYER.BRICK, 0.6);
	}
}

// ---------------------------------------------------------------- far shell

/**
 * The simple shell of one building for the far level of detail and for shadows: one quad per wall
 * (exposed walls set in by `inset`, deeper than any window or gate recess, so the shell never
 * shadows the glazing of the detailed facade and causes no shadow acne on it),
 * firewall bands, the roof and a cornice slab. ch = chunk index (hidden while the detail is shown).
 */
export function buildFar(info, FB, ch, inset = 0.7) {
	ringLinks(info);
	const fy = info.floorY;
	const L = info.levels;
	const gTop = info.base < 1 ? fy[1] : info.base;
	const fH = L > 1 ? (fy[L] - fy[1]) / Math.max(1, L - 1) : info.fH;
	const topY = fy[L];
	const S = STYLES[info.style];
	const axis = (S.axis[0] + S.axis[1]) / 2;
	const seedF = (info.seed % 997) / 997;
	const F2 = [gTop, fH, topY, 0];
	const F1 = [0, 0, 0, 0];
	const pl = info.plaster;
	const firewallCol = (info.seed >> 3) % 5 < 2 ? hexRgb('#b98c78') : hexRgb('#9c978d');
	for (const seg of info.segs) {
		const len = seg.len;
		if (len < 0.2) continue;
		let y0 = info.base, kind = seg.kind === 'street' ? 1 : seg.kind === 'court' ? 2 : 3, col = pl;
		if (seg.kind === 'party') {
			if (seg.coverTop >= info.wallTop - 0.3) continue;
			y0 = Math.max(info.base, seg.coverTop);
			kind = 3;
			col = firewallCol;
		}
		if (seg.kind === 'side' && seg.firewall) { kind = 3; col = firewallCol; }
		const exposed = seg.kind !== 'party';
		const dIn = exposed ? -inset : 0;
		// Mitred ends against other set-in walls; square ends against party walls.
		const pe = seg.prev && seg.prev.kind !== 'party', ne = seg.next && seg.next.kind !== 'party';
		const m0 = exposed && pe ? mitre(seg.prev.nx, seg.prev.nz, seg.nx, seg.nz) : null;
		const m1 = exposed && ne ? mitre(seg.nx, seg.nz, seg.next.nx, seg.next.nz) : null;
		const ax0 = m0 ? seg.ax + m0[0] * dIn : seg.ax + seg.nx * dIn, az0 = m0 ? seg.az + m0[1] * dIn : seg.az + seg.nz * dIn;
		const ax1 = m1 ? seg.bx + m1[0] * dIn : seg.bx + seg.nx * dIn, az1 = m1 ? seg.bz + m1[1] * dIn : seg.bz + seg.nz * dIn;
		const bays = kind === 3 ? { n: 0, start: 0, step: 1 } : layoutBays(len, kind === 2 ? axis * 0.9 : axis, pe ? 0.95 : 0.65, ne ? 0.95 : 0.65);
		const f2 = [gTop, fH, topY, kind + seedF];
		const b = FB.n;
		const U0 = [0, bays.step, bays.start, bays.n], U1 = [len, bays.step, bays.start, bays.n];
		FB.vert(ax0, y0, az0, seg.nx, 0, seg.nz, col, U0, f2, ch);
		FB.vert(ax1, y0, az1, seg.nx, 0, seg.nz, col, U1, f2, ch);
		FB.vert(ax1, info.wallTop, az1, seg.nx, 0, seg.nz, col, U1, f2, ch);
		FB.vert(ax0, info.wallTop, az0, seg.nx, 0, seg.nz, col, U0, f2, ch);
		pushQuadIdx(FB, b, seg.nx, seg.nz, seg.ux, seg.uz);
		// Cornice slab (street fronts): gives the far silhouette its overhang and the facade its shadow line.
		if (seg.kind === 'street' && S.cornice >= 2) {
			const proj = S.cornice === 3 ? 0.8 : 0.5;
			const yb = info.wallTop - 0.55, yt = info.wallTop - 0.05;
			const cm0 = pe ? mitre(seg.prev.nx, seg.prev.nz, seg.nx, seg.nz) : null, cm1 = ne ? mitre(seg.nx, seg.nz, seg.next.nx, seg.next.nz) : null;
			const p0 = cm0 ? [seg.ax + cm0[0] * proj, seg.az + cm0[1] * proj] : [seg.ax + seg.nx * proj, seg.az + seg.nz * proj];
			const p1 = cm1 ? [seg.bx + cm1[0] * proj, seg.bz + cm1[1] * proj] : [seg.bx + seg.nx * proj, seg.bz + seg.nz * proj];
			const c2 = info.trim, z4 = [0, 0, 0, 0], k0 = [gTop, fH, topY, 0];
			// front
			let q = FB.n;
			FB.vert(p0[0], yb, p0[1], seg.nx, 0, seg.nz, c2, z4, k0, ch); FB.vert(p1[0], yb, p1[1], seg.nx, 0, seg.nz, c2, z4, k0, ch);
			FB.vert(p1[0], yt, p1[1], seg.nx, 0, seg.nz, c2, z4, k0, ch); FB.vert(p0[0], yt, p0[1], seg.nx, 0, seg.nz, c2, z4, k0, ch);
			pushQuadIdx(FB, q, seg.nx, seg.nz, seg.ux, seg.uz);
			// underside (from the set-in wall to the front edge)
			q = FB.n;
			FB.vert(ax0, yb, az0, 0, -1, 0, c2, z4, k0, ch); FB.vert(ax1, yb, az1, 0, -1, 0, c2, z4, k0, ch);
			FB.vert(p1[0], yb, p1[1], 0, -1, 0, c2, z4, k0, ch); FB.vert(p0[0], yb, p0[1], 0, -1, 0, c2, z4, k0, ch);
			orientIdx(FB, q, 0, -1, 0);
			// top
			q = FB.n;
			FB.vert(ax0, yt, az0, 0, 1, 0, c2, z4, k0, ch); FB.vert(ax1, yt, az1, 0, 1, 0, c2, z4, k0, ch);
			FB.vert(p1[0], yt, p1[1], 0, 1, 0, c2, z4, k0, ch); FB.vert(p0[0], yt, p0[1], 0, 1, 0, c2, z4, k0, ch);
			orientIdx(FB, q, 0, 1, 0);
		}
	}
	const roof = roofOf(info);
	const rc = info.roof.colour;
	const z4 = [0, 0, 0, 0];
	for (const f of roof.faces) {
		const pts = f.pts;
		const [a, b2, c] = pts;
		const ux = b2[0] - a[0], uy = b2[1] - a[1], uz = b2[2] - a[2];
		const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
		let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
		const l = Math.hypot(nx, ny, nz);
		if (l < 1e-9) continue;
		nx /= l; ny /= l; nz /= l;
		const col = f.kind === 'gable' ? firewallCol : f.kind === 'flat' ? hexRgb('#6e6c68') : rc;
		const kind = f.kind === 'gable' ? 3 : 0;
		const f2 = [gTop, fH, -1, kind + (f.kind === 'flat' ? 0.5 : 0.25)];
		const base = FB.n;
		for (const p of pts) FB.vert(p[0], p[1], p[2], nx, ny, nz, col, z4, f2, ch);
		for (let k = 1; k + 1 < pts.length; k++) FB.idx.push(base, base + k, base + k + 1);
	}
}

function orientIdx(B, b, nx, ny, nz) {
	const p = B.pos;
	const ax = p[b * 3], ay = p[b * 3 + 1], az = p[b * 3 + 2];
	const ux = p[(b + 1) * 3] - ax, uy = p[(b + 1) * 3 + 1] - ay, uz = p[(b + 1) * 3 + 2] - az;
	const vx = p[(b + 2) * 3] - ax, vy = p[(b + 2) * 3 + 1] - ay, vz = p[(b + 2) * 3 + 2] - az;
	const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
	if (gx * nx + gy * ny + gz * nz >= 0) B.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
	else B.idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
}
