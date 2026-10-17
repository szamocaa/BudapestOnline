// Shared geometry and material kit for the hand-made landmarks (Keleti, Blaha, the Museum quarter).
//
// A landmark is built into a `Parts` accumulator: every primitive (box, extruded moulding, lathe,
// facade wall with openings, statue...) is written straight into a few big vertex buffers, one per
// material channel. `parts.build(ctx)` then turns each channel into ONE mesh, so a whole landmark
// costs only a handful of draw calls:
//   solid  – stone, render, roofs, iron, bronze: one patched MeshStandardMaterial. Colour is per
//            vertex; the surface detail (grain, ashlar joints, slate courses, standing seams, soot
//            streaks, roughness, metalness, night floodlight) is per vertex attribute + triplanar
//            world-space shader work, so no UVs and no per-object textures are needed.
//   glass  – windows and glazed screens: fake sky reflection + per-window night glow.
//   decal  – textured pieces (clock dials, signs, neon letters, lit lanterns) from one shared atlas.
// Everything here is plain math on arrays; the three.js objects are made only in build().
import * as THREE from '../../vendor/three.module.min.js';
import { pointInPolygon, polygonArea, rng } from '../../geo.js';

const TAU = Math.PI * 2;

/** Hex colour (number or '#rrggbb') → linear [r, g, b] (what vertex colours expect). */
export function rgb(hex) {
	const c = new THREE.Color(hex);
	return [c.r, c.g, c.b];
}
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mulc = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export { mixc, mulc };

/** Pattern ids understood by the solid shader. */
export const PAT = { none: 0, ashlar: 1, slate: 2, seam: 3, brick: 4 };

const GLOW_WARM = [1.0, 0.7, 0.4];
const DEFAULT_SURF = { c: [0.6, 0.55, 0.48], grime: 0.3, pat: 0, ps: 0.5, rough: 0.85, metal: 0, flood: 0, floodH: 30, lit: 0, ch: 'solid', uvr: null };

/**
 * Geometry accumulator. Coordinates go through the current frame matrix (local → world). Surface
 * properties (colour, grime, pattern, roughness, metalness, floodlight, channel) are a state that
 * `set()` changes and `save()`/`restore()` scope.
 */
export class Parts {
	constructor() {
		this.ch = new Map();
		this.M = new THREE.Matrix4();
		this.N = new THREE.Matrix3();
		this.s = { ...DEFAULT_SURF };
		this.stack = [];
		this._v = new THREE.Vector3();
		this._n = new THREE.Vector3();
		this.tris = 0;
	}
	// ------------------------------------------------------------ state
	set(props) {
		for (const k in props) {
			const v = props[k];
			this.s[k] = k === 'c' && !Array.isArray(v) ? rgb(v) : v;
		}
		return this;
	}
	save() { this.stack.push({ s: { ...this.s }, M: this.M.clone() }); return this; }
	restore() {
		const t = this.stack.pop();
		this.s = t.s;
		this.M.copy(t.M);
		this.N.getNormalMatrix(this.M);
		return this;
	}
	/** Sets the frame matrix (local → world). */
	frame(m) { this.M.copy(m); this.N.getNormalMatrix(this.M); return this; }
	/** Frame at (x, y, z) rotated by yaw about +y: local +z points along (sin yaw, cos yaw). */
	at(x, y, z, yaw = 0) {
		this.M.makeRotationY(yaw).setPosition(x, y, z);
		this.N.getNormalMatrix(this.M);
		return this;
	}
	/** Frame on a wall edge A→B: local x runs A→B, y up, local +z = the outward side (right of A→B). */
	edge(ax, az, bx, bz, y = 0) {
		this.M.copy(edgeMatrix(ax, az, bx, bz, y));
		this.N.getNormalMatrix(this.M);
		return this;
	}
	/** Multiplies the current frame by a local transform. */
	mul(m) { this.M.multiply(m); this.N.getNormalMatrix(this.M); return this; }
	translate(x, y, z) { return this.mul(new THREE.Matrix4().makeTranslation(x, y, z)); }
	rotateY(a) { return this.mul(new THREE.Matrix4().makeRotationY(a)); }
	rotateX(a) { return this.mul(new THREE.Matrix4().makeRotationX(a)); }
	rotateZ(a) { return this.mul(new THREE.Matrix4().makeRotationZ(a)); }
	scale(x, y = x, z = x) { return this.mul(new THREE.Matrix4().makeScale(x, y, z)); }

	// ------------------------------------------------------------ low level
	buf(name = this.s.ch) {
		let b = this.ch.get(name);
		if (!b) {
			b = { pos: [], nrm: [], uv: [], col: [], surf: [], ext: [], idx: [], n: 0 };
			this.ch.set(name, b);
		}
		return b;
	}
	/** Emits one vertex (local coordinates) and returns its index in the channel. */
	vert(x, y, z, nx, ny, nz, u = 0, v = 0, c = null) {
		const b = this.buf();
		const p = this._v.set(x, y, z).applyMatrix4(this.M);
		const n = this._n.set(nx, ny, nz).applyMatrix3(this.N).normalize();
		const s = this.s;
		b.pos.push(p.x, p.y, p.z);
		b.nrm.push(n.x, n.y, n.z);
		if (s.uvr) b.uv.push(s.uvr[0] + u * (s.uvr[2] - s.uvr[0]), s.uvr[1] + v * (s.uvr[3] - s.uvr[1]));
		else b.uv.push(u, v);
		const col = c || s.c;
		b.col.push(col[0], col[1], col[2]);
		if (s.ch === 'glass') {
			const gl = s.glow || GLOW_WARM;
			b.surf.push(gl[0], gl[1], gl[2], s.rough);
		} else b.surf.push(s.grime, s.pat, s.ps, s.rough);
		const fl = s.flood ? s.flood * Math.min(1, Math.max(0.3, 1.1 - p.y / s.floodH)) : 0;
		b.ext.push(s.metal, s.ch === 'solid' ? fl : s.lit);
		return b.n++;
	}
	tri(a, b, c) { this.buf().idx.push(a, b, c); this.tris++; }
	/** A flat quad p0..p3 (counter-clockwise seen from the front), local coordinates. */
	quad(p0, p1, p2, p3, uv = null, c = null) {
		// Normal from the diagonals: also right for quads that collapse to a triangle (p0 = p1, as in
		// the centre sectors of a fan). A zero normal would give NaN lighting (black holes + bloom).
		const ax = p2[0] - p0[0], ay = p2[1] - p0[1], az = p2[2] - p0[2];
		const bx = p3[0] - p1[0], by = p3[1] - p1[1], bz = p3[2] - p1[2];
		let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
		const l = Math.hypot(nx, ny, nz);
		if (l < 1e-9) return; // fully degenerate: nothing to draw
		nx /= l; ny /= l; nz /= l;
		const u = uv || [0, 0, 1, 1];
		const i0 = this.vert(p0[0], p0[1], p0[2], nx, ny, nz, u[0], u[1], c);
		const i1 = this.vert(p1[0], p1[1], p1[2], nx, ny, nz, u[2], u[1], c);
		const i2 = this.vert(p2[0], p2[1], p2[2], nx, ny, nz, u[2], u[3], c);
		const i3 = this.vert(p3[0], p3[1], p3[2], nx, ny, nz, u[0], u[3], c);
		this.tri(i0, i1, i2);
		this.tri(i0, i2, i3);
	}
	/** Axis-aligned box in the local frame. `skip` = string of faces to leave out: 'b' bottom, 't' top, 'n' -z, 'f' +z, 'l' -x, 'r' +x. */
	box(x0, y0, z0, x1, y1, z1, skip = 'b') {
		if (x0 > x1) [x0, x1] = [x1, x0];
		if (y0 > y1) [y0, y1] = [y1, y0];
		if (z0 > z1) [z0, z1] = [z1, z0];
		if (!skip.includes('f')) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
		if (!skip.includes('n')) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);
		if (!skip.includes('r')) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);
		if (!skip.includes('l')) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
		if (!skip.includes('t')) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
		if (!skip.includes('b')) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
	}
	/** Box given by centre and size. */
	cbox(cx, cy, cz, w, h, d, skip = 'b') { this.box(cx - w / 2, cy - h / 2, cz - d / 2, cx + w / 2, cy + h / 2, cz + d / 2, skip); }
	/**
	 * Extrudes a 2D profile [[z, y], ...] (drawn in the local z–y plane, listed so that the outside
	 * is on the right when walking the list) along local x from x0 to x1. Flat-shaded segments.
	 * `caps`: close both ends with the profile polygon.
	 */
	extrude(profile, x0, x1, caps = true) {
		for (let i = 0; i + 1 < profile.length; i++) {
			const [za, ya] = profile[i], [zb, yb] = profile[i + 1];
			if (Math.abs(za - zb) + Math.abs(ya - yb) < 1e-6) continue;
			this.quad([x0, ya, za], [x1, ya, za], [x1, yb, zb], [x0, yb, zb]);
		}
		if (caps) this.cap(profile, x0, x1);
	}
	/** End caps of an extruded profile (triangulated polygon) at x0 (facing -x) and x1 (facing +x). */
	cap(profile, x0, x1) {
		const pts = profile.map(([z, y]) => new THREE.Vector2(z, y));
		if (pts.length < 3) return;
		let tris;
		try { tris = THREE.ShapeUtils.triangulateShape(pts, []); } catch { return; }
		for (const [x, nx] of [[x0, -1], [x1, 1]]) {
			const base = pts.map(([z, y]) => this.vert(x, y, z, nx, 0, 0));
			for (const [a, b, c] of tris) {
				// Orientation of (a,b,c) in z–y: keep the face pointing along nx.
				const A = profile[a], B = profile[b], C = profile[c];
				const cr = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]); // z×y component → x direction sign is -cr
				if (-cr * nx > 0) this.tri(base[a], base[b], base[c]);
				else this.tri(base[a], base[c], base[b]);
			}
		}
	}
	/**
	 * Lathe around the local y axis at (cx, cy, cz). profile = [[r, y], ...] bottom to top.
	 * opts: seg (radial segments), a0/a1 (angle range), smooth (average normals), sx/sz (ellipse scale).
	 */
	lathe(profile, cx = 0, cy = 0, cz = 0, { seg = 12, a0 = 0, a1 = TAU, smooth = false, sx = 1, sz = 1, capTop = false } = {}) {
		const n = profile.length;
		const segN = [];
		for (let i = 0; i + 1 < n; i++) {
			const dr = profile[i + 1][0] - profile[i][0], dy = profile[i + 1][1] - profile[i][1];
			const l = Math.hypot(dr, dy) || 1;
			segN.push([dy / l, -dr / l]);
		}
		const pointN = profile.map((_, i) => {
			const a = segN[Math.max(0, i - 1)], b = segN[Math.min(segN.length - 1, i)];
			const x = a[0] + b[0], y = a[1] + b[1], l = Math.hypot(x, y) || 1;
			return [x / l, y / l];
		});
		const full = Math.abs(a1 - a0 - TAU) < 1e-6;
		const ring = (r, y, nr, ny) => {
			const ids = [];
			for (let j = 0; j <= seg; j++) {
				const a = a0 + ((a1 - a0) * j) / seg;
				const ca = Math.cos(a), sa = Math.sin(a);
				ids.push(this.vert(cx + r * sa * sx, cy + y, cz + r * ca * sz, nr * sa / sx, ny, nr * ca / sz, j / seg, y));
			}
			return ids;
		};
		for (let i = 0; i + 1 < n; i++) {
			const [ra, ya] = profile[i], [rb, yb] = profile[i + 1];
			const na = smooth ? pointN[i] : segN[i], nb = smooth ? pointN[i + 1] : segN[i];
			const A = ring(ra, ya, na[0], na[1]), B = ring(rb, yb, nb[0], nb[1]);
			for (let j = 0; j < seg; j++) {
				if (ra > 1e-5) this.tri(A[j], A[j + 1], B[j + 1]);
				if (rb > 1e-5) this.tri(A[j], B[j + 1], B[j]);
			}
		}
		if (capTop && profile[n - 1][0] > 1e-5) {
			const [r, y] = profile[n - 1];
			const c = this.vert(cx, cy + y, cz, 0, 1, 0);
			const R = ring(r, y, 0, 1);
			for (let j = 0; j < seg; j++) this.tri(c, R[j], R[j + 1]);
		}
		void full;
	}
	/** Cylinder (local, axis y). */
	cyl(cx, y0, cz, r0, r1, h, seg = 10, caps = true) {
		this.lathe(caps ? [[0, 0], [r0, 0], [r1, h], [0, h]] : [[r0, 0], [r1, h]], cx, y0, cz, { seg });
	}
	/** A tapered rod from point a to point b (local coordinates), radius ra → rb. */
	rod(a, b, ra, rb = ra, seg = 6) {
		const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
		const d = B.clone().sub(A);
		const h = d.length();
		if (h < 1e-5) return;
		const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
		this.save();
		this.mul(new THREE.Matrix4().compose(A, q, new THREE.Vector3(1, 1, 1)));
		this.lathe([[0, -ra * 0.3], [ra, 0], [rb, h], [0, h + rb * 0.3]], 0, 0, 0, { seg, smooth: true });
		this.restore();
	}
	/** Ellipsoid (local) centred at c with radii (rx, ry, rz). */
	blob(c, rx, ry, rz, seg = 8, rings = 5) {
		const prof = [];
		for (let i = 0; i <= rings; i++) {
			const t = -Math.PI / 2 + (Math.PI * i) / rings;
			prof.push([Math.cos(t), Math.sin(t)]);
		}
		this.save();
		this.mul(new THREE.Matrix4().makeTranslation(c[0], c[1], c[2]).multiply(new THREE.Matrix4().makeScale(rx, ry, rz)));
		this.lathe(prof, 0, 0, 0, { seg, smooth: true });
		this.restore();
	}
	/** Appends a three.js BufferGeometry through the current frame (optionally with a local matrix). */
	geometry(g, m = null) {
		const pos = g.attributes.position, nrm = g.attributes.normal, uv = g.attributes.uv;
		this.save();
		if (m) this.mul(m);
		const base = [];
		for (let i = 0; i < pos.count; i++) base.push(this.vert(pos.getX(i), pos.getY(i), pos.getZ(i), nrm.getX(i), nrm.getY(i), nrm.getZ(i), uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0));
		if (g.index) for (let i = 0; i < g.index.count; i += 3) this.tri(base[g.index.getX(i)], base[g.index.getX(i + 1)], base[g.index.getX(i + 2)]);
		else for (let i = 0; i < pos.count; i += 3) this.tri(base[i], base[i + 1], base[i + 2]);
		this.restore();
	}
	/**
	 * A flat panel in the local x–y plane at z, facing +z: the outline (2D points) with holes,
	 * triangulated. Used for walls with window openings and for arched screens.
	 */
	panel(outline, holes = [], z = 0, back = false) {
		const contour = outline.map(([x, y]) => new THREE.Vector2(x, y));
		const hs = holes.map((h) => h.map(([x, y]) => new THREE.Vector2(x, y)));
		let tris;
		try { tris = THREE.ShapeUtils.triangulateShape(contour, hs); } catch { return; }
		const flat = [contour, ...hs].flat();
		const nz = back ? -1 : 1;
		const ids = flat.map((p) => this.vert(p.x, p.y, z, 0, 0, nz, p.x, p.y));
		for (const [a, b, c] of tris) {
			const A = flat[a], B = flat[b], C = flat[c];
			const cr = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
			if (cr * nz > 0) this.tri(ids[a], ids[b], ids[c]);
			else this.tri(ids[a], ids[c], ids[b]);
		}
	}
	/** Inward reveal of a 2D outline (in the x–y plane at z = 0) going back to z = -depth. */
	reveal(outline, depth, closed = true) {
		const n = outline.length;
		const ccw = signedArea2(outline) > 0;
		for (let i = 0; i < (closed ? n : n - 1); i++) {
			const a = outline[i], b = outline[(i + 1) % n];
			// Faces point into the opening (towards its centre).
			if (ccw) this.quad([a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], -depth], [a[0], a[1], -depth]);
			else this.quad([b[0], b[1], 0], [a[0], a[1], 0], [a[0], a[1], -depth], [b[0], b[1], -depth]);
		}
	}
	/**
	 * Moulded band following a closed world-space ring (x, z) – plinths, string courses, cornices,
	 * parapets, mansards. profile = [[d, y], ...] where d is the offset outwards from the ring (metres,
	 * negative = inwards) and y the height, listed bottom → top. Corners are mitred.
	 */
	ringBand(ring, profile, y0 = 0, { closed = true } = {}) {
		const r = orientRing(ring);
		const n = r.length;
		const offs = profile.map(([d]) => offsetRing(r, d, closed));
		this.save();
		this.M.identity();
		this.N.identity();
		for (let k = 0; k + 1 < profile.length; k++) {
			const ya = y0 + profile[k][1], yb = y0 + profile[k + 1][1];
			const A = offs[k], B = offs[k + 1];
			for (let i = 0; i < (closed ? n : n - 1); i++) {
				const j = (i + 1) % n;
				this.quad([A[i][0], ya, A[i][1]], [A[j][0], ya, A[j][1]], [B[j][0], yb, B[j][1]], [B[i][0], yb, B[i][1]]);
			}
		}
		this.restore();
		return offs[offs.length - 1];
	}
	/** Flat horizontal polygon (world x, z ring) at height y, facing up (or down). */
	flat(ring, y, holes = [], down = false) {
		this.save();
		this.M.identity();
		this.N.identity();
		const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
		const hs = holes.map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
		let tris;
		try { tris = THREE.ShapeUtils.triangulateShape(contour, hs); } catch { this.restore(); return; }
		const pts = [contour, ...hs].flat();
		const ny = down ? -1 : 1;
		const ids = pts.map((p) => this.vert(p.x, y, p.y, 0, ny, 0, p.x, p.y));
		for (const [a, b, c] of tris) {
			const A = pts[a], B = pts[b], C = pts[c];
			const up = (B.y - A.y) * (C.x - A.x) - (B.x - A.x) * (C.y - A.y);
			if (up * ny > 0) this.tri(ids[a], ids[b], ids[c]);
			else this.tri(ids[a], ids[c], ids[b]);
		}
		this.restore();
	}
	/** Vertical walls along a world ring from y0 to y1 (outward facing). */
	walls(ring, y0, y1) {
		this.ringBand(ring, [[0, 0], [0, y1 - y0]], y0);
	}

	// ------------------------------------------------------------ build
	/** Creates one mesh per channel under ctx.root (or `parent`). Returns { meshes, tris, draw }. */
	build(ctx, { parent = null, name = 'landmark', shadows = true } = {}) {
		const out = [];
		const mats = landmarkMaterials(ctx);
		for (const [name2, b] of this.ch) {
			if (!b.idx.length) continue;
			const g = new THREE.BufferGeometry();
			g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
			g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
			g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
			g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
			g.setAttribute('lmSurf', new THREE.Float32BufferAttribute(b.surf, 4));
			g.setAttribute('lmExt', new THREE.Float32BufferAttribute(b.ext, 2));
			g.setIndex(b.idx);
			g.computeBoundingSphere();
			g.computeBoundingBox();
			const mat = mats[name2] || mats.solid;
			const m = new THREE.Mesh(g, mat);
			m.name = `${name}:${name2}`;
			m.castShadow = shadows && (name2 === 'solid');
			m.receiveShadow = name2 !== 'glow';
			m.matrixAutoUpdate = false;
			m.updateMatrix();
			(parent || ctx.root).add(m);
			out.push(m);
		}
		return { meshes: out, tris: this.tris };
	}
}

function signedArea2(pts) {
	let a = 0;
	for (let i = 0; i < pts.length; i++) {
		const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
		a += x1 * y2 - x2 * y1;
	}
	return a / 2;
}

/** Local→world matrix for a wall edge A→B with the outside on the right of A→B. */
export function edgeMatrix(ax, az, bx, bz, y = 0) {
	const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1;
	const ux = dx / l, uz = dz / l;
	return new THREE.Matrix4().makeBasis(new THREE.Vector3(ux, 0, uz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-uz, 0, ux)).setPosition(ax, y, az);
}

/**
 * Ring in a fixed orientation: walking it, the solid is on the LEFT and the outside on the right
 * (so edge frames built with edgeMatrix face outwards). Removes duplicate closing points.
 */
export function orientRing(ring) {
	let r = ring.slice();
	if (r.length > 1) {
		const a = r[0], b = r[r.length - 1];
		if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) r.pop();
	}
	// polygonArea > 0 with x east / z south means the ring runs clockwise on a map (seen from above,
	// north up). Walking clockwise the inside is on the right; we want it on the left.
	if (polygonArea(r) > 0) r = r.reverse();
	return r;
}

/** Outward normal of edge i of an oriented ring (solid on the left). */
function edgeNormal(r, i) {
	const a = r[i], b = r[(i + 1) % r.length];
	const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
	return [-dz / l, dx / l];
}

/** Mitred offset of an oriented ring by d (outwards positive). */
export function offsetRing(r, d, closed = true) {
	const n = r.length;
	const out = [];
	for (let i = 0; i < n; i++) {
		let na, nb;
		if (!closed && i === 0) na = nb = edgeNormal(r, 0);
		else if (!closed && i === n - 1) na = nb = edgeNormal(r, n - 2);
		else { na = edgeNormal(r, (i - 1 + n) % n); nb = edgeNormal(r, i); }
		let mx = na[0] + nb[0], mz = na[1] + nb[1];
		const dot = na[0] * nb[0] + na[1] * nb[1];
		const k = 1 / Math.max(0.25, 1 + dot);
		mx *= k; mz *= k;
		out.push([r[i][0] + mx * d, r[i][1] + mz * d]);
	}
	return out;
}

/** Edges of an oriented ring as { a, b, len, nx, nz, mid } (outward normals). */
export function ringEdges(ring) {
	const r = orientRing(ring);
	return r.map((a, i) => {
		const b = r[(i + 1) % r.length];
		const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
		const [nx, nz] = edgeNormal(r, i);
		return { a, b, len, nx, nz, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], i };
	});
}

/** Simplifies a ring: drops points closer than `minLen` and nearly collinear points. */
export function simplifyRing(ring, minLen = 0.6, angle = 0.06) {
	let r = orientRing(ring);
	let changed = true;
	while (changed && r.length > 3) {
		changed = false;
		for (let i = 0; i < r.length && r.length > 3; i++) {
			const p = r[(i - 1 + r.length) % r.length], c = r[i], n = r[(i + 1) % r.length];
			const l1 = Math.hypot(c[0] - p[0], c[1] - p[1]), l2 = Math.hypot(n[0] - c[0], n[1] - c[1]);
			const cr = ((c[0] - p[0]) * (n[1] - c[1]) - (c[1] - p[1]) * (n[0] - c[0])) / ((l1 * l2) || 1);
			if (l1 < minLen || Math.abs(cr) < angle) {
				r.splice(i, 1);
				changed = true;
				i--;
			}
		}
	}
	return r;
}

// ================================================================ facade helpers

/** Outline of an opening: rectangle, or with a round/segmental head. Counter-clockwise in x–y. */
export function openingOutline(x, y, w, h, head = 'flat', seg = 8) {
	const pts = [[x, y], [x + w, y]];
	if (head === 'round') {
		const r = w / 2, cy = y + h - r;
		pts.push([x + w, cy]);
		for (let i = 1; i < seg; i++) {
			const a = (Math.PI * i) / seg;
			pts.push([x + r + Math.cos(a) * r, cy + Math.sin(a) * r]);
		}
		pts.push([x, cy]);
	} else if (head === 'segment') {
		const rise = Math.min(w * 0.18, h * 0.2), cy0 = y + h - rise;
		const R = (w * w / 4 + rise * rise) / (2 * rise), cy = cy0 + rise - R;
		const half = Math.asin(Math.min(1, w / 2 / R));
		pts.push([x + w, cy0]);
		for (let i = 1; i < seg; i++) {
			const a = Math.PI / 2 - half + (2 * half * i) / seg;
			pts.push([x + w / 2 + Math.cos(a) * R, cy + Math.sin(a) * R]);
		}
		pts.push([x, cy0]);
	} else {
		pts.push([x + w, y + h], [x, y + h]);
	}
	return pts;
}

/**
 * A wall panel (local frame, x from 0 to len, y from y0 to y1, at z = 0) with openings cut out.
 * openings = [{ x, y, w, h, head, depth, glass, frame, sill, lit, mullions }] (x, y = bottom-left).
 * Writes the wall (current surface state), reveals, glass (channel 'glass') and frames.
 * opts: { frameColour, glassColour, revealColour, rng }.
 */
export function wallWithOpenings(P, len, y0, y1, openings, opts = {}) {
	const holes = openings.map((o) => openingOutline(o.x, o.y, o.w, o.h, o.head || 'flat'));
	P.panel([[0, y0], [len, y0], [len, y1], [0, y1]], holes, 0);
	openings.forEach((o, i) => openingFill(P, o, holes[i], opts));
}

/** Reveal + glass + frame for one opening (outline already cut from the wall). */
export function openingFill(P, o, outline, opts = {}) {
	const r = opts.rng || Math.random;
	const depth = o.depth ?? 0.3;
	const wallC = P.s.c;
	P.save();
	P.set({ c: opts.revealColour || mulc(wallC, 0.8), pat: 0 });
	P.reveal(outline, depth);
	P.restore();
	if (o.glass === false) {
		// Blind opening (niche back / door leaf).
		P.save();
		if (o.fill) P.set({ c: o.fill, pat: 0, rough: o.fillRough ?? 0.7, metal: o.fillMetal ?? 0 });
		else P.set({ c: mulc(wallC, 0.6), pat: 0 });
		P.panel(outline, [], -depth);
		P.restore();
		return;
	}
	// Glass pane (slightly tinted per window), with a night glow for some windows.
	P.save();
	const gc = opts.glassColour || [0.06, 0.075, 0.085];
	const tint = 0.85 + r() * 0.3;
	const lit = o.lit != null ? o.lit : (r() < (opts.litShare ?? 0.35) ? 0.55 + r() * 0.45 : 0);
	P.set({ ch: 'glass', c: mulc(gc, tint), lit });
	P.panel(outline, [], -depth + 0.06);
	P.restore();
	// Frame (a border ring) and glazing bars.
	const fw = o.frameW ?? 0.07;
	const fc = o.frame || opts.frameColour || [0.75, 0.72, 0.66];
	P.save();
	P.set({ c: fc, pat: 0, rough: 0.6, grime: P.s.grime * 0.5 });
	const z0 = -depth + 0.02, z1 = -depth + 0.12;
	const { x, y, w, h } = o;
	P.box(x, y, z0, x + w, y + fw, z1, 'b');
	P.box(x, y, z0, x + fw, y + h - (o.head === 'round' ? w / 2 : 0), z1, 'b');
	P.box(x + w - fw, y, z0, x + w, y + h - (o.head === 'round' ? w / 2 : 0), z1, 'b');
	if (o.head !== 'round') P.box(x, y + h - fw, z0, x + w, y + h, z1, 'b');
	const mull = o.mullions ?? (w > 0.9 ? 1 : 0);
	for (let k = 1; k <= mull; k++) {
		const mx = x + (w * k) / (mull + 1);
		P.box(mx - fw / 2, y, z0, mx + fw / 2, y + h - (o.head === 'round' ? w / 2 : 0), z1, 'b');
	}
	const tr = o.transom ?? (h > 1.6 ? 0.7 : 0);
	if (tr) {
		const ty = o.head === 'round' ? y + h - w / 2 : y + h * tr;
		P.box(x, ty - fw / 2, z0, x + w, ty + fw / 2, z1, 'b');
	}
	if (o.head === 'round') {
		// Fan bars in the arched head.
		const cx = x + w / 2, cy = y + h - w / 2, rr = w / 2;
		P.save();
		for (let k = 1; k < 4; k++) {
			const a = (Math.PI * k) / 4;
			P.save();
			P.translate(cx, cy, 0).rotateZ(a - Math.PI / 2);
			P.box(-fw / 2, 0, z0, fw / 2, rr, z1, 'b');
			P.restore();
		}
		P.restore();
	}
	P.restore();
}

/** Classical moulding profiles as [[d, y], ...] (d outwards from the wall, y up), bottom to top. */
export const PROFILES = {
	/** Main cornice: bed moulding, dentil band, corona, cyma. Height ~1.0 × k, projection ~0.9 × k. */
	cornice: (k = 1) => [[0, 0], [0.06, 0], [0.06, 0.08], [0.14, 0.12], [0.16, 0.2], [0.24, 0.24], [0.24, 0.36], [0.3, 0.38], [0.36, 0.42], [0.62, 0.48], [0.66, 0.5], [0.66, 0.68], [0.72, 0.7], [0.74, 0.76], [0.82, 0.86], [0.9, 0.96], [0.92, 1.0], [0, 1.0]].map(([d, y]) => [d * k, y * k]),
	/** Simple string course / band. */
	band: (k = 1) => [[0, 0], [0.08, 0.02], [0.12, 0.08], [0.12, 0.22], [0.16, 0.26], [0.16, 0.32], [0, 0.34]].map(([d, y]) => [d * k, y * k]),
	/** Plinth / base: projecting socle with a chamfer on top. */
	plinth: (h = 1, p = 0.15) => [[p, -0.3], [p, h - 0.12], [p * 0.4, h], [0, h + 0.02]],
	/** Window sill. */
	sill: (k = 1) => [[0, -0.12 * k], [0.12 * k, -0.1 * k], [0.14 * k, 0], [0.1 * k, 0.04 * k], [0, 0.04 * k]],
	/** Attic / parapet coping. */
	coping: (k = 1) => [[0, 0], [0.08 * k, 0.04 * k], [0.12 * k, 0.12 * k], [0.12 * k, 0.2 * k], [0, 0.22 * k]],
};

/** Moulded band along local x (x0..x1) on a wall at z = 0 (profile from PROFILES). */
export function moulding(P, profile, x0, x1, y, caps = true) {
	P.save();
	P.translate(0, y, 0);
	P.extrude(profile.map(([d, yy]) => [d, yy]), x0, x1, caps);
	P.restore();
}

/** Baluster lathe profile (vase), height h. */
function balusterProfile(h, r) {
	return [[r * 0.95, 0], [r * 0.95, 0.08 * h], [r * 0.6, 0.12 * h], [r * 0.75, 0.22 * h], [r, 0.38 * h], [r * 0.7, 0.55 * h], [r * 0.42, 0.7 * h], [r * 0.42, 0.78 * h], [r * 0.7, 0.84 * h], [r * 0.85, 0.9 * h], [r * 0.85, h]];
}

/**
 * Balustrade along local x from x0 to x1 at height y (plinth, vase balusters, handrail), with
 * pedestals every `ped` metres. depth = rail width.
 */
export function balustrade(P, x0, x1, y, { h = 1.0, spacing = 0.32, depth = 0.34, ped = 0, low = false, z = 0 } = {}) {
	const plinthH = 0.14 * h, railH = 0.14 * h, bh = h - plinthH - railH;
	P.box(x0, y, z - depth / 2, x1, y + plinthH, z + depth / 2, 'b');
	P.box(x0 - 0.03, y + h - railH, z - depth / 2 - 0.03, x1 + 0.03, y + h, z + depth / 2 + 0.03, 'b');
	const len = x1 - x0;
	const pedW = depth * 1.15;
	const peds = [];
	if (ped > 0) {
		const n = Math.max(1, Math.round(len / ped));
		for (let i = 0; i <= n; i++) peds.push(x0 + (len * i) / n);
	}
	for (const px of peds) P.box(px - pedW / 2, y, z - pedW / 2, px + pedW / 2, y + h + 0.04, z + pedW / 2, 'b');
	const n = Math.floor(len / spacing);
	const r9 = depth * 0.3;
	for (let i = 0; i < n; i++) {
		const bx = x0 + (i + 0.5) * (len / n);
		if (peds.some((p) => Math.abs(p - bx) < pedW / 2 + 0.08)) continue;
		// Low detail: a 4-sided vase (32 triangles instead of ~120) that keeps the silhouette.
		if (low) P.lathe([[r9 * 0.9, 0], [r9 * 0.55, 0.16 * bh], [r9, 0.42 * bh], [r9 * 0.42, 0.76 * bh], [r9 * 0.85, bh]], bx, y + plinthH, z, { seg: 4, a0: Math.PI / 4, a1: Math.PI / 4 + TAU });
		else P.lathe(balusterProfile(bh, depth * 0.3), bx, y + plinthH, z, { seg: 6 });
	}
}

/**
 * A classical column at local (x, y, z): base, shaft (optionally fluted, with entasis) and an
 * Ionic, Corinthian or Doric/Tuscan capital. h = total height incl. base and capital.
 */
export function column(P, x, y, z, h, r, { order = 'corinthian', flutes = 20, seg = 16, capColour = null } = {}) {
	const baseH = r * 1.0, capH = order === 'corinthian' ? r * 2.3 : order === 'ionic' ? r * 1.1 : r * 0.7;
	const shaftH = h - baseH - capH;
	// Attic base: plinth, torus, scotia, torus.
	P.box(x - r * 1.45, y, z - r * 1.45, x + r * 1.45, y + baseH * 0.32, z + r * 1.45, 'b');
	P.lathe([[r * 1.38, baseH * 0.32], [r * 1.42, baseH * 0.45], [r * 1.36, baseH * 0.6], [r * 1.12, baseH * 0.66], [r * 1.08, baseH * 0.78], [r * 1.22, baseH * 0.86], [r * 1.18, baseH * 0.95], [r * 1.02, baseH]], x, y, z, { seg, smooth: true });
	// Shaft with entasis (and flutes).
	const rings = 5;
	const ys = [];
	for (let i = 0; i <= rings; i++) ys.push((shaftH * i) / rings);
	const rad = (t) => r * (1 - 0.14 * Math.pow(t, 1.6));
	const fn = flutes > 0 ? flutes * 2 : seg;
	const vid = [];
	for (let i = 0; i <= rings; i++) {
		const row = [];
		const t = i / rings, rr = rad(t);
		for (let j = 0; j <= fn; j++) {
			const a = (TAU * j) / fn;
			const inset = flutes > 0 && j % 2 === 1 ? 0.07 * rr : 0;
			const R = rr - inset;
			// Normal: radial, tilted by the flute side.
			const na = flutes > 0 ? a + (j % 2 === 1 ? 0 : 0) : a;
			row.push(P.vert(x + Math.sin(a) * R, y + baseH + ys[i], z + Math.cos(a) * R, Math.sin(na), 0.05, Math.cos(na), j / fn, t));
		}
		vid.push(row);
	}
	for (let i = 0; i < rings; i++) for (let j = 0; j < fn; j++) {
		P.tri(vid[i][j], vid[i][j + 1], vid[i + 1][j + 1]);
		P.tri(vid[i][j], vid[i + 1][j + 1], vid[i + 1][j]);
	}
	const top = y + baseH + shaftH, rt = rad(1);
	P.save();
	if (capColour) P.set({ c: capColour });
	P.lathe([[rt * 1.02, 0], [rt * 1.1, r * 0.08], [rt * 1.02, r * 0.14]], x, top, z, { seg });
	if (order === 'corinthian') {
		// Bell with two rows of acanthus leaves and corner volutes, then the concave abacus.
		P.lathe([[rt, r * 0.14], [rt * 1.05, r * 0.9], [rt * 1.25, r * 1.6], [rt * 1.4, r * 1.9]], x, top, z, { seg, smooth: true });
		for (let row = 0; row < 2; row++) {
			const ly = top + r * (0.18 + row * 0.55), lh = r * (0.75 + row * 0.25);
			for (let k = 0; k < 8; k++) {
				const a = (TAU * (k + row * 0.5)) / 8;
				const rr = rt * (1.08 + row * 0.12);
				P.save();
				P.translate(x + Math.sin(a) * rr, ly, z + Math.cos(a) * rr).rotateY(a).rotateX(-0.28);
				P.box(-rt * 0.3, 0, -0.02, rt * 0.3, lh, rt * 0.16, 'b');
				P.restore();
			}
		}
		for (let k = 0; k < 4; k++) {
			const a = Math.PI / 4 + (TAU * k) / 4;
			const rr = rt * 1.45;
			P.save();
			P.translate(x + Math.sin(a) * rr, top + r * 1.75, z + Math.cos(a) * rr).rotateY(a);
			P.box(-r * 0.16, -r * 0.3, -r * 0.16, r * 0.16, r * 0.12, r * 0.22, 'b');
			P.restore();
		}
		const ab = r * 1.55;
		P.box(x - ab, top + capH - r * 0.36, z - ab, x + ab, top + capH, z + ab, 'b');
	} else if (order === 'ionic') {
		P.box(x - r * 1.2, top + r * 0.14, z - r * 1.05, x + r * 1.2, top + r * 0.62, z + r * 1.05, 'b');
		// Volutes: rolls on the two faces.
		for (const sx of [-1, 1]) {
			P.save();
			P.translate(x + sx * r * 1.12, top + r * 0.42, z).rotateX(Math.PI / 2);
			P.lathe([[0, -r * 1.08], [r * 0.34, -r * 1.06], [r * 0.38, -r * 0.98], [r * 0.3, 0], [r * 0.38, r * 0.98], [r * 0.34, r * 1.06], [0, r * 1.08]], 0, 0, 0, { seg: 8, smooth: true });
			P.restore();
		}
		P.box(x - r * 1.25, top + r * 0.62, z - r * 1.15, x + r * 1.25, top + capH, z + r * 1.15, 'b');
	} else {
		P.lathe([[rt * 1.02, r * 0.14], [rt * 1.3, r * 0.35], [rt * 1.3, r * 0.42]], x, top, z, { seg });
		P.box(x - r * 1.3, top + r * 0.42, z - r * 1.3, x + r * 1.3, top + capH, z + r * 1.3, 'b');
	}
	P.restore();
	return { top: top + capH };
}

/** Flat pilaster with base and capital on a wall (local x centre, from y0 to y1, projecting `p`). */
export function pilaster(P, x, y0, y1, w, p = 0.18, { order = 'ionic', capColour = null } = {}) {
	const bh = Math.min(0.5, (y1 - y0) * 0.06), ch = order === 'corinthian' ? w * 1.1 : w * 0.5;
	P.box(x - w / 2 - 0.06, y0, -0.02, x + w / 2 + 0.06, y0 + bh, p + 0.06, 'b');
	P.box(x - w / 2, y0 + bh, -0.02, x + w / 2, y1 - ch, p, 'b');
	P.save();
	if (capColour) P.set({ c: capColour });
	if (order === 'ionic') {
		P.box(x - w / 2 - 0.04, y1 - ch, -0.02, x + w / 2 + 0.04, y1 - ch * 0.35, p + 0.05, 'b');
		for (const sx of [-1, 1]) {
			P.save();
			P.translate(x + sx * w * 0.45, y1 - ch * 0.62, p + 0.05).rotateX(Math.PI / 2);
			P.cyl(0, -0.05, 0, ch * 0.3, ch * 0.3, 0.1, 8);
			P.restore();
		}
		P.box(x - w / 2 - 0.08, y1 - ch * 0.35, -0.02, x + w / 2 + 0.08, y1, p + 0.08, 'b');
	} else if (order === 'corinthian') {
		P.box(x - w / 2, y1 - ch, -0.02, x + w / 2, y1 - ch * 0.25, p + 0.07, 'b');
		for (let k = 0; k < 3; k++) {
			const lx = x - w * 0.33 + k * w * 0.33;
			P.box(lx - w * 0.13, y1 - ch * 0.95, p, lx + w * 0.13, y1 - ch * 0.45, p + 0.1, 'b');
		}
		P.box(x - w / 2 - 0.08, y1 - ch * 0.25, -0.02, x + w / 2 + 0.08, y1, p + 0.1, 'b');
	} else {
		P.box(x - w / 2 - 0.05, y1 - ch, -0.02, x + w / 2 + 0.05, y1, p + 0.06, 'b');
	}
	P.restore();
}

/**
 * Triangular pediment (local x centre cx, base y, width w, rise h), projecting depth d from the wall,
 * with raking cornices. Returns nothing; tympanum is the flat face.
 */
export function pediment(P, cx, y, w, h, d = 0.5, k = 0.45) {
	const x0 = cx - w / 2, x1 = cx + w / 2;
	// Horizontal cornice.
	P.save();
	P.translate(0, y, 0);
	P.extrude(PROFILES.cornice(k).map(([dd, yy]) => [dd + d * 0.0, yy]), x0 - 0.1, x1 + 0.1, true);
	P.restore();
	// Tympanum: a flat triangle slightly recessed.
	const ty = y + k;
	P.quad([x0 + k, ty, d * 0.25], [x1 - k, ty, d * 0.25], [cx, ty + h - k * 1.4, d * 0.25], [cx, ty + h - k * 1.4, d * 0.25]);
	P.box(x0 + k * 0.5, ty - 0.02, -0.02, x1 - k * 0.5, ty + 0.01, d * 0.25, 'b');
	// Raking cornices as slanted boxes.
	const ang = Math.atan2(h, w / 2);
	const len = Math.hypot(w / 2, h) + 0.3;
	for (const s of [-1, 1]) {
		P.save();
		P.translate(cx + (s * w) / 4, y + k * 0.5 + h / 2, 0).rotateZ(-s * ang);
		P.box(-len / 2, -k * 0.35, -0.02, len / 2, k * 0.55, k * 0.95, 'b');
		P.box(-len / 2, -k * 0.6, -0.02, len / 2, -k * 0.35, k * 0.6, 'b');
		P.restore();
	}
	// Back fill so the pediment is solid when seen from the side.
	P.quad([x0, ty, -0.02], [x0, ty, d * 0.25], [cx, ty + h - k * 0.6, d * 0.25], [cx, ty + h - k * 0.6, -0.02]);
	P.quad([x1, ty, d * 0.25], [x1, ty, -0.02], [cx, ty + h - k * 0.6, -0.02], [cx, ty + h - k * 0.6, d * 0.25]);
}

// ================================================================ statues

/**
 * A low-poly statue figure in the local frame: feet at (0, 0, 0), facing +z, `h` metres tall.
 * opts: { robe: 'coat'|'gown'|'none', armL: [shoulderFwd, shoulderOut, elbow], armR: [...],
 *         head: 'bare'|'hat'|'helmet'|'veil', wings, seated, hold: 'globe'|'wheel'|'staff'|'book'|'sheaf'|'hammer'|'scroll', stride }.
 * Angles in radians. ~400–900 triangles.
 */
export function figure(P, opts = {}) {
	const h = opts.h || 1.8;
	const k = h / 1.8;
	const seg = opts.seg || 7;
	P.save();
	P.scale(k, k, k);
	const seated = !!opts.seated;
	const hipY = seated ? 0.5 : 0.92;
	const stride = opts.stride ?? 0.12;
	// Legs and feet.
	if (seated) {
		for (const sx of [-1, 1]) {
			P.rod([sx * 0.11, hipY, 0], [sx * 0.13, hipY + 0.02, 0.42], 0.09, 0.07, seg);
			P.rod([sx * 0.13, hipY, 0.42], [sx * 0.14, 0.06, 0.48], 0.065, 0.05, seg);
			P.box(sx * 0.14 - 0.05, 0, 0.44, sx * 0.14 + 0.05, 0.08, 0.66, 'b');
		}
		// Seat block.
		P.box(-0.3, 0, -0.3, 0.3, hipY - 0.04, 0.2, 'b');
	} else {
		for (const sx of [-1, 1]) {
			const fz = sx * stride;
			P.rod([sx * 0.1, hipY, 0], [sx * 0.11, 0.48, fz * 0.5], 0.085, 0.06, seg);
			P.rod([sx * 0.11, 0.48, fz * 0.5], [sx * 0.11, 0.07, fz], 0.06, 0.045, seg);
			P.box(sx * 0.11 - 0.05, 0, fz - 0.06, sx * 0.11 + 0.05, 0.08, fz + 0.17, 'b');
		}
	}
	// Robe / coat over the lower body.
	if (opts.robe === 'gown') {
		const bottom = seated ? 0.05 : 0.02;
		if (seated) {
			P.lathe([[0.36, bottom], [0.34, 0.3], [0.3, hipY + 0.05], [0.2, 1.0], [0.16, 1.1]], 0, 0, 0.1, { seg: seg + 2, smooth: true, sz: 1.3 });
		} else {
			P.lathe([[0.3, bottom], [0.27, 0.3], [0.22, 0.7], [0.18, 1.0], [0.15, 1.2]], 0, 0, 0, { seg: seg + 2, smooth: true, sz: 0.85 });
		}
	} else if (opts.robe === 'coat') {
		P.lathe([[0.23, seated ? 0.45 : 0.5], [0.2, 0.75], [0.18, 1.0], [0.17, 1.12]], 0, 0, -0.01, { seg: seg + 1, smooth: true, sz: 0.75 });
	} else {
		P.lathe([[0.16, hipY - 0.06], [0.17, hipY + 0.12]], 0, 0, 0, { seg, sz: 0.8 });
	}
	// Torso.
	const sY = seated ? 1.0 : 1.42; // shoulder height
	const tY = seated ? 0.55 : 0.98;
	P.lathe([[0.15, tY], [0.16, tY + 0.18], [0.18, sY - 0.18], [0.2, sY - 0.06], [0.14, sY + 0.02], [0.06, sY + 0.06]], 0, 0, 0, { seg: seg + 1, smooth: true, sz: 0.72 });
	// Head and neck.
	P.rod([0, sY, 0], [0, sY + 0.1, 0.01], 0.05, 0.045, 5);
	P.blob([0, sY + 0.2, 0.01], 0.095, 0.12, 0.105, 7, 5);
	if (opts.head === 'hat') P.cyl(0, sY + 0.27, 0.01, 0.1, 0.095, 0.14, 7);
	else if (opts.head === 'helmet') { P.blob([0, sY + 0.27, 0.0], 0.11, 0.08, 0.12, 7, 4); P.box(-0.01, sY + 0.3, -0.12, 0.01, sY + 0.42, 0.08); }
	else if (opts.head === 'veil') P.lathe([[0.13, sY - 0.05], [0.12, sY + 0.15], [0.1, sY + 0.27], [0.0, sY + 0.33]], 0, 0, -0.01, { seg: 7, smooth: true });
	else if (opts.head === 'hair') P.blob([0, sY + 0.24, -0.02], 0.1, 0.1, 0.1, 7, 4);
	// Arms: [forward swing, outward swing, elbow bend].
	const arm = (sx, a) => {
		const [fw, out, el] = a || [0.1, 0.12, 0.2];
		const sh = [sx * 0.21, sY - 0.04, 0];
		const ul = 0.3, fl = 0.28;
		const e = [sh[0] + sx * Math.sin(out) * ul, sh[1] - Math.cos(out) * Math.cos(fw) * ul, sh[2] + Math.sin(fw) * ul];
		const dir = new THREE.Vector3(e[0] - sh[0], e[1] - sh[1], e[2] - sh[2]).normalize();
		// Bend the forearm forwards/up by el.
		const fdir = dir.clone().applyAxisAngle(new THREE.Vector3(1, 0, 0), -el);
		const w = [e[0] + fdir.x * fl, e[1] + fdir.y * fl, e[2] + fdir.z * fl];
		P.rod(sh, e, 0.06, 0.048, 5);
		P.rod(e, w, 0.046, 0.036, 5);
		P.blob(w, 0.04, 0.05, 0.035, 5, 3);
		return w;
	};
	const wl = arm(-1, opts.armL), wr = arm(1, opts.armR);
	// Held attributes.
	const hold = (what, w) => {
		if (!what) return;
		if (what === 'globe') P.blob([w[0], w[1] + 0.14, w[2]], 0.13, 0.13, 0.13, 8, 6);
		else if (what === 'wheel') {
			P.save();
			P.translate(w[0], w[1] + 0.05, w[2]).rotateZ(Math.PI / 2);
			P.lathe([[0.16, -0.03], [0.2, -0.03], [0.2, 0.03], [0.16, 0.03], [0.16, -0.03]], 0, 0, 0, { seg: 12 });
			P.restore();
		} else if (what === 'staff') P.rod([w[0], w[1] - 0.9, w[2]], [w[0], w[1] + 0.5, w[2]], 0.02, 0.02, 4);
		else if (what === 'trident') { P.rod([w[0], w[1] - 1.0, w[2]], [w[0], w[1] + 0.55, w[2]], 0.02, 0.02, 4); P.box(w[0] - 0.12, w[1] + 0.5, w[2] - 0.02, w[0] + 0.12, w[1] + 0.54, w[2] + 0.02); for (const dx of [-0.11, 0, 0.11]) P.box(w[0] + dx - 0.015, w[1] + 0.5, w[2] - 0.015, w[0] + dx + 0.015, w[1] + 0.72, w[2] + 0.015); }
		else if (what === 'book') P.box(w[0] - 0.1, w[1] - 0.02, w[2] - 0.02, w[0] + 0.1, w[1] + 0.12, w[2] + 0.12);
		else if (what === 'sheaf') P.lathe([[0.04, -0.35], [0.09, -0.1], [0.06, 0.05], [0.12, 0.25], [0.0, 0.32]], w[0], w[1], w[2], { seg: 6 });
		else if (what === 'hammer') { P.rod([w[0], w[1] - 0.45, w[2]], [w[0], w[1] + 0.15, w[2]], 0.02, 0.02, 4); P.box(w[0] - 0.12, w[1] + 0.1, w[2] - 0.05, w[0] + 0.12, w[1] + 0.2, w[2] + 0.05); }
		else if (what === 'scroll') { P.save(); P.translate(w[0], w[1], w[2]).rotateZ(Math.PI / 2); P.cyl(0, -0.16, 0, 0.04, 0.04, 0.32, 6); P.restore(); }
		else if (what === 'wreath') { P.save(); P.translate(w[0], w[1] + 0.05, w[2] + 0.05); P.lathe([[0.1, -0.02], [0.13, 0], [0.1, 0.02]], 0, 0, 0, { seg: 10 }); P.restore(); }
		else if (what === 'model') P.box(w[0] - 0.08, w[1] - 0.18, w[2] - 0.2, w[0] + 0.08, w[1] + 0.02, w[2] + 0.14);
	};
	hold(opts.holdL, wl);
	hold(opts.holdR, wr);
	// Drapery / cloak behind.
	if (opts.cloak) P.lathe([[0.25, seated ? 0.2 : 0.15], [0.24, 0.8], [0.22, sY - 0.05]], 0, 0, -0.06, { seg: 7, a0: Math.PI * 0.55, a1: Math.PI * 1.45 });
	// Wings: raised, swept-back "Nike" wings from the shoulder blades (tips above the head, a
	// scalloped feather edge below), angled back so they read as wings and not as a disc.
	if (opts.wings) {
		for (const sx of [-1, 1]) {
			P.save();
			P.translate(sx * 0.1, sY - 0.08, -0.14).rotateY(sx * 0.75).rotateZ(-sx * 0.12);
			const span = opts.wings;
			const pts = [[0, 0], [0.12, 0.42], [0.22, 0.78], [0.3, 1.0], [0.36, 0.92], [0.42, 0.72], [0.36, 0.62], [0.44, 0.44], [0.36, 0.34], [0.4, 0.14], [0.3, 0.06], [0.3, -0.16], [0.2, -0.2], [0.14, -0.38], [0.04, -0.2]]
				.map(([x, y]) => [sx * x * span, y * span]);
			const outline = sx > 0 ? pts : pts.slice().reverse();
			P.panel(outline, [], 0.02);
			P.panel(outline, [], -0.02, true);
			P.restore();
		}
	}
	P.restore();
}

// ================================================================ materials & textures

let SHARED = null;

/** Tileable value noise. */
function tileNoise(size, cells, r) {
	const g = new Float32Array(cells * cells);
	for (let i = 0; i < g.length; i++) g[i] = r();
	const out = new Float32Array(size * size);
	for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
		const fx = (x / size) * cells, fy = (y / size) * cells;
		const x0 = Math.floor(fx), y0 = Math.floor(fy);
		const tx = fx - x0, ty = fy - y0;
		const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
		const a = g[(y0 % cells) * cells + (x0 % cells)], b = g[(y0 % cells) * cells + ((x0 + 1) % cells)];
		const c = g[((y0 + 1) % cells) * cells + (x0 % cells)], d = g[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
		out[y * size + x] = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
	}
	return out;
}

/** The stone detail texture: R grain, G vertical soot streaks, B blotches, A height (pores). */
function detailTexture() {
	const S = 256;
	const r = rng(9091);
	const n1 = tileNoise(S, 64, r), n2 = tileNoise(S, 32, r), n3 = tileNoise(S, 8, r), n4 = tileNoise(S, 4, r), n5 = tileNoise(S, 128, r);
	// Streaks: noise stretched vertically (many cells in x, few in y).
	const st = new Float32Array(S * S);
	{
		const cx = 48, cy = 3;
		const g = new Float32Array(cx * cy);
		for (let i = 0; i < g.length; i++) g[i] = r();
		for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
			const fx = (x / S) * cx, fy = (y / S) * cy;
			const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
			const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
			const a = g[(y0 % cy) * cx + (x0 % cx)], b = g[(y0 % cy) * cx + ((x0 + 1) % cx)];
			const c = g[((y0 + 1) % cy) * cx + (x0 % cx)], d = g[((y0 + 1) % cy) * cx + ((x0 + 1) % cx)];
			st[y * S + x] = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
		}
	}
	const data = new Uint8Array(S * S * 4);
	for (let i = 0; i < S * S; i++) {
		const grain = 0.5 * n1[i] + 0.3 * n5[i] + 0.2 * n2[i];
		const blot = 0.6 * n3[i] + 0.4 * n4[i];
		const streak = Math.pow(st[i], 2.2);
		const pores = n5[i] > 0.82 ? 0.25 : 0;
		data[i * 4] = Math.round(Math.min(1, grain) * 255);
		data[i * 4 + 1] = Math.round(Math.min(1, streak) * 255);
		data[i * 4 + 2] = Math.round(Math.min(1, blot) * 255);
		data[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, 0.55 * n1[i] + 0.45 * n5[i] - pores)) * 255);
	}
	const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.magFilter = THREE.LinearFilter;
	t.minFilter = THREE.LinearMipmapLinearFilter;
	t.generateMipmaps = true;
	t.anisotropy = 4;
	t.colorSpace = THREE.NoColorSpace;
	t.needsUpdate = true;
	return t;
}

const SOLID_VERT_PARS = /* glsl */`
attribute vec4 lmSurf;
attribute vec2 lmExt;
varying vec3 vLmPos;
varying vec3 vLmNrm;
varying vec4 vLmSurf;
varying vec2 vLmExt;
`;
const SOLID_VERT_MAIN = /* glsl */`
vLmPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vLmNrm = normalize(mat3(modelMatrix) * objectNormal);
vLmSurf = lmSurf;
vLmExt = lmExt;
`;
const SOLID_FRAG_PARS = /* glsl */`
uniform sampler2D lmDetail;
uniform float lmNight;
uniform vec3 lmFloodColor;
varying vec3 vLmPos;
varying vec3 vLmNrm;
varying vec4 vLmSurf;
varying vec2 vLmExt;
float lmLine(float v, float w, float fw) {
	float f = fract(v);
	float d = min(f, 1.0 - f);
	return 1.0 - smoothstep(w, w + fw * 1.5 + 0.002, d);
}
vec3 lmPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection) {
	vec3 vSigmaX = normalize(dFdx(surf_pos.xyz));
	vec3 vSigmaY = normalize(dFdy(surf_pos.xyz));
	vec3 vN = surf_norm;
	vec3 R1 = cross(vSigmaY, vN);
	vec3 R2 = cross(vN, vSigmaX);
	float fDet = dot(vSigmaX, R1) * faceDirection;
	vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
	return normalize(abs(fDet) * surf_norm - vGrad);
}
`;
const SOLID_FRAG_COLOUR = /* glsl */`
vec3 lmN = normalize(vLmNrm);
vec3 lmW = pow(abs(lmN), vec3(4.0));
lmW /= (lmW.x + lmW.y + lmW.z);
vec3 lmP = vLmPos;
vec4 lmD = texture2D(lmDetail, lmP.zy * 0.43) * lmW.x + texture2D(lmDetail, lmP.xz * 0.43) * lmW.y + texture2D(lmDetail, lmP.xy * 0.43) * lmW.z;
vec4 lmL = texture2D(lmDetail, lmP.zy * 0.031 + 0.37) * lmW.x + texture2D(lmDetail, lmP.xz * 0.031 + 0.61) * lmW.y + texture2D(lmDetail, lmP.xy * 0.031 + 0.17) * lmW.z;
// Pattern: joints of ashlar, slate courses, standing seams, brick.
float lmPat = vLmSurf.y;
float lmS = max(vLmSurf.z, 0.05);
float lmH = lmW.x > lmW.z ? lmP.z : lmP.x;
float lmJoint = 0.0;
float lmYY = lmP.y / lmS, lmHH = lmH / lmS;
float lmFY = fwidth(lmYY), lmFH = min(fwidth(lmHH), 1.0);
if (lmPat > 0.5) {
	float row = floor(lmYY);
	float stag = 0.5 * mod(row, 2.0);
	if (lmPat < 1.5) {
		lmJoint = max(lmLine(lmYY, 0.035, lmFY), lmLine(lmHH / 2.1 + stag, 0.018, lmFH / 2.1)) * (1.0 - lmW.y);
	} else if (lmPat < 2.5) {
		lmJoint = max(lmLine(lmYY, 0.06, lmFY), 0.6 * lmLine(lmHH / 0.9 + stag, 0.04, lmFH / 0.9));
	} else if (lmPat < 3.5) {
		lmJoint = lmLine(lmHH, 0.03, lmFH) * 0.8;
	} else {
		lmJoint = max(lmLine(lmYY, 0.08, lmFY), lmLine(lmHH / 3.6 + stag, 0.03, lmFH / 3.6)) * (1.0 - lmW.y);
	}
	lmJoint *= 1.0 - smoothstep(0.25, 0.6, lmFY);
}
float lmVert = 1.0 - lmW.y;
float lmGrime = vLmSurf.x * (0.25 + 0.75 * lmL.b) * (0.3 + 0.7 * lmD.g) * lmVert;
lmGrime += vLmSurf.x * 0.35 * (1.0 - smoothstep(0.0, 1.6, lmP.y)) * lmVert;
diffuseColor.rgb *= (0.88 + 0.24 * lmD.r) * (0.92 + 0.16 * lmL.r);
diffuseColor.rgb *= 1.0 - min(0.6, lmGrime * 0.55);
diffuseColor.rgb *= 1.0 - lmJoint * 0.38;
`;
const SOLID_FRAG_ROUGH = /* glsl */`
roughnessFactor = clamp(vLmSurf.w * (0.9 + 0.2 * lmD.r) + lmGrime * 0.1 + lmJoint * 0.1, 0.04, 1.0);
`;
const SOLID_FRAG_METAL = /* glsl */`
metalnessFactor = vLmExt.x;
`;
const SOLID_FRAG_NORMAL = /* glsl */`
{
	float lmHt = lmD.a * 0.6 + lmL.a * 0.4 - lmJoint * 0.9;
	vec2 lmdH = vec2(dFdx(lmHt), dFdy(lmHt)) * 0.9;
	normal = lmPerturb(-vViewPosition, normal, lmdH, faceDirection);
}
`;
const SOLID_FRAG_EMIT = /* glsl */`
totalEmissiveRadiance += diffuseColor.rgb * lmFloodColor * vLmExt.y * lmNight;
`;

/** Patches a MeshStandardMaterial with the landmark solid shader. */
function patchSolid(mat, uniforms) {
	mat.onBeforeCompile = (sh) => {
		Object.assign(sh.uniforms, uniforms);
		sh.vertexShader = sh.vertexShader
			.replace('#include <common>', '#include <common>\n' + SOLID_VERT_PARS)
			.replace('#include <project_vertex>', '#include <project_vertex>\n' + SOLID_VERT_MAIN);
		sh.fragmentShader = sh.fragmentShader
			.replace('#include <common>', '#include <common>\n' + SOLID_FRAG_PARS)
			.replace('#include <color_fragment>', '#include <color_fragment>\n' + SOLID_FRAG_COLOUR)
			.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + SOLID_FRAG_ROUGH)
			.replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n' + SOLID_FRAG_METAL)
			.replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + SOLID_FRAG_NORMAL)
			.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + SOLID_FRAG_EMIT);
	};
	mat.customProgramCacheKey = () => 'lm-solid-v1';
}

const GLASS_FRAG_PARS = /* glsl */`
uniform float lmNight;
uniform vec3 lmZenith;
uniform vec3 lmHorizon;
uniform vec3 lmGround;
uniform vec3 lmWarm;
uniform float lmFakeSky;
varying vec3 vLmPos;
varying vec3 vLmNrm;
varying vec4 vLmSurf;
varying vec2 vLmExt;
`;
const GLASS_FRAG_EMIT = /* glsl */`
{
	vec3 V = normalize(vLmPos - cameraPosition);
	vec3 Nn = normalize(vLmNrm);
	if (dot(Nn, V) > 0.0) Nn = -Nn;
	vec3 R = reflect(V, Nn);
	float fres = 0.06 + 0.94 * pow(1.0 - max(dot(-V, Nn), 0.0), 4.0);
	vec3 sky = R.y > 0.0 ? mix(lmHorizon, lmZenith, pow(clamp(R.y, 0.0, 1.0), 0.6)) : mix(lmHorizon, lmGround, clamp(-R.y * 3.0, 0.0, 1.0));
	// scene.environment (the sky PMREM) already gives the daytime reflection; this fake sky only
	// fills in where there is no environment map and fades at night.
	totalEmissiveRadiance += sky * fres * lmFakeSky * (1.0 - 0.6 * vLmExt.y * lmNight);
	// Warm interior light; kept moderate so the night exposure keeps it amber, not white.
	totalEmissiveRadiance += vLmSurf.rgb * vLmExt.y * lmNight * 0.75;
}
`;

function patchGlass(mat, uniforms) {
	mat.onBeforeCompile = (sh) => {
		Object.assign(sh.uniforms, uniforms);
		sh.vertexShader = sh.vertexShader
			.replace('#include <common>', '#include <common>\n' + SOLID_VERT_PARS)
			.replace('#include <project_vertex>', '#include <project_vertex>\n' + SOLID_VERT_MAIN);
		sh.fragmentShader = sh.fragmentShader
			.replace('#include <common>', '#include <common>\n' + GLASS_FRAG_PARS)
			.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + GLASS_FRAG_EMIT);
	};
	mat.customProgramCacheKey = () => 'lm-glass-v1';
}

const DECAL_FRAG_PARS = /* glsl */`
uniform float lmNight;
varying vec3 vLmPos;
varying vec3 vLmNrm;
varying vec4 vLmSurf;
varying vec2 vLmExt;
`;
const DECAL_FRAG_EMIT = /* glsl */`
totalEmissiveRadiance += diffuseColor.rgb * vLmExt.y * (0.25 + lmNight * 3.0);
`;
function patchDecal(mat, uniforms) {
	mat.onBeforeCompile = (sh) => {
		Object.assign(sh.uniforms, uniforms);
		sh.vertexShader = sh.vertexShader
			.replace('#include <common>', '#include <common>\n' + SOLID_VERT_PARS)
			.replace('#include <project_vertex>', '#include <project_vertex>\n' + SOLID_VERT_MAIN);
		sh.fragmentShader = sh.fragmentShader
			.replace('#include <common>', '#include <common>\n' + DECAL_FRAG_PARS)
			.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + DECAL_FRAG_EMIT);
	};
	mat.customProgramCacheKey = () => 'lm-decal-v1';
}

/**
 * The shared materials (one set for every landmark of this kit) and the hooks that drive their
 * night/sky uniforms. The decal atlas is drawn once (see atlas()).
 */
export function landmarkMaterials(ctx) {
	if (SHARED && SHARED.ctx === ctx) return SHARED.mats;
	const uniforms = {
		lmDetail: { value: detailTexture() },
		lmNight: { value: 0 },
		lmFloodColor: { value: new THREE.Color(1.0, 0.74, 0.46).multiplyScalar(0.34) },
		lmZenith: { value: new THREE.Color(0x4a6fa5) },
		lmHorizon: { value: new THREE.Color(0xa9c3dc) },
		lmGround: { value: new THREE.Color(0x3a3834) },
		lmWarm: { value: new THREE.Color(1.0, 0.72, 0.42) },
		lmFakeSky: { value: 0.9 },
	};
	const solid = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
	patchSolid(solid, uniforms);
	const glass = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0.0, color: 0xffffff });
	patchGlass(glass, uniforms);
	const atlasTex = atlas().texture;
	const decal = new THREE.MeshStandardMaterial({ vertexColors: true, map: atlasTex, roughness: 0.55, metalness: 0, transparent: false, alphaTest: 0.35 });
	patchDecal(decal, uniforms);
	const glow = new THREE.MeshBasicMaterial({ vertexColors: true, map: atlasTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true });
	const mats = { solid, glass, decal, glow, uniforms };
	SHARED = { ctx, mats };
	ctx.onNight((k) => {
		uniforms.lmNight.value = k;
		glow.opacity = Math.min(1, k * 1.3);
	});
	let last = -1;
	const z = new THREE.Color(), hz = new THREE.Color();
	ctx.onUpdate((frame) => {
		if (frame.frameNo === last || (frame.frameNo % 15 !== 0 && last >= 0)) return;
		last = frame.frameNo;
		const fog = ctx.scene && ctx.scene.fog;
		const day = frame.sky ? (frame.sky.day ?? 1) : 1;
		if (fog) hz.copy(fog.color);
		else hz.set(0xa9c3dc);
		z.set(0x0a1020).lerp(new THREE.Color(0x3d6aa8), day);
		uniforms.lmHorizon.value.copy(hz).multiplyScalar(0.55 + 0.45 * day);
		uniforms.lmZenith.value.copy(z).multiplyScalar(0.7);
		uniforms.lmGround.value.set(0x2c2a27).multiplyScalar(0.3 + 0.7 * day);
		uniforms.lmFakeSky.value = ctx.scene && ctx.scene.environment ? 0.08 : 0.9;
	});
	return mats;
}

// ---------------------------------------------------------------- decal atlas
// One 1024² canvas shared by all decals. Regions are allocated by name (drawn on first use).
let ATLAS = null;
const ATLAS_SIZE = 1024;

/** The shared atlas: { texture, region(name, w, h, draw) → [u0, v0, u1, v1] }. */
export function atlas() {
	if (ATLAS) return ATLAS;
	const c = document.createElement('canvas');
	c.width = c.height = ATLAS_SIZE;
	const g = c.getContext('2d');
	g.fillStyle = '#ffffff';
	g.fillRect(0, 0, 8, 8); // region 'white' at the top-left corner
	const t = new THREE.CanvasTexture(c);
	t.colorSpace = THREE.SRGBColorSpace;
	t.anisotropy = 4;
	const regions = new Map([['white', [1 / ATLAS_SIZE, 1 - 7 / ATLAS_SIZE, 7 / ATLAS_SIZE, 1 - 1 / ATLAS_SIZE]]]);
	// Shelf packer.
	let sx = 8, sy = 0, shelfH = 8;
	ATLAS = {
		texture: t,
		canvas: c,
		region(name, w, h, draw) {
			if (regions.has(name)) return regions.get(name);
			if (sx + w > ATLAS_SIZE) { sx = 0; sy += shelfH + 2; shelfH = 0; }
			if (sy + h > ATLAS_SIZE) { console.warn('landmark atlas full'); return regions.get('white'); }
			const x = sx, y = sy;
			sx += w + 2;
			shelfH = Math.max(shelfH, h);
			g.save();
			g.translate(x, y);
			g.beginPath();
			g.rect(0, 0, w, h);
			g.clip();
			draw(g, w, h);
			g.restore();
			t.needsUpdate = true;
			// Canvas y grows downwards; texture v grows upwards (flipY).
			const uv = [(x + 0.5) / ATLAS_SIZE, 1 - (y + h - 0.5) / ATLAS_SIZE, (x + w - 0.5) / ATLAS_SIZE, 1 - (y + 0.5) / ATLAS_SIZE];
			regions.set(name, uv);
			return uv;
		},
	};
	return ATLAS;
}

/** A textured quad (decal channel) in the local x–y plane at z, centred at (cx, cy). */
export function decalQuad(P, uv, cx, cy, w, h, z = 0, { emit = 0, c = [1, 1, 1], ch = 'decal' } = {}) {
	P.save();
	P.set({ ch, c, lit: emit, uvr: uv, metal: 0 });
	P.quad([cx - w / 2, cy - h / 2, z], [cx + w / 2, cy - h / 2, z], [cx + w / 2, cy + h / 2, z], [cx - w / 2, cy + h / 2, z]);
	P.restore();
}

/** Glow sprite-like quad (additive, night only) – halo around lamps and lit lettering. */
export function glowQuad(P, cx, cy, w, h, z, colour) {
	const uv = atlas().region('halo', 64, 64, (g, w2, h2) => {
		const gr = g.createRadialGradient(w2 / 2, h2 / 2, 0, w2 / 2, h2 / 2, w2 / 2);
		gr.addColorStop(0, 'rgba(255,255,255,1)');
		gr.addColorStop(0.25, 'rgba(255,255,255,0.45)');
		gr.addColorStop(1, 'rgba(255,255,255,0)');
		g.fillStyle = gr;
		g.fillRect(0, 0, w2, h2);
	});
	decalQuad(P, uv, cx, cy, w, h, z, { ch: 'glow', c: colour });
}

// ---------------------------------------------------------------- helpers for landmarks

/** Finds OSM buildings by id list (data may be the fallback map: missing ids are fine). */
export function byIds(ctx, ids) {
	const set = new Set(ids);
	return ctx.data.buildings.filter((b) => set.has(b.id));
}

/** Point-in-ring test for site matching. */
export function inside(ring, x, z) { return pointInPolygon(x, z, ring); }

/**
 * Removes point props (statues, clocks, fountains drawn by the landmark itself) within `r` metres of
 * (x, z) from the shared CityData so the generic street-furniture builder does not draw them twice.
 */
export function consumeProps(ctx, x, z, r, kinds = ['statue', 'clock', 'fountain']) {
	const props = ctx.data.props;
	if (!Array.isArray(props)) return 0;
	let n = 0;
	for (let i = props.length - 1; i >= 0; i--) {
		const p = props[i];
		if (kinds.includes(p.kind) && (p.x - x) ** 2 + (p.z - z) ** 2 < r * r) {
			props.splice(i, 1);
			n++;
		}
	}
	return n;
}

/** Bounding box of rings: { x0, z0, x1, z1 }. */
export function bounds(rings) {
	let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
	for (const r of rings) for (const [x, z] of r) {
		if (x < x0) x0 = x;
		if (x > x1) x1 = x;
		if (z < z0) z0 = z;
		if (z > z1) z1 = z;
	}
	return { x0, z0, x1, z1 };
}

// ================================================================ generic building shell

/**
 * Safe inward offset for a roof: shrinks `inset` until the offset ring keeps its shape (no edge
 * flips direction), so hips and mansards never self-intersect. Returns [inset, ring].
 */
export function safeInset(ring, inset) {
	const r = orientRing(ring);
	const area0 = Math.abs(polygonArea(r));
	for (let tries = 0; tries < 12; tries++) {
		const o = offsetRing(r, -inset);
		let ok = Math.abs(polygonArea(o)) < area0 && Math.abs(polygonArea(o)) > area0 * 0.02;
		for (let i = 0; ok && i < r.length; i++) {
			const j = (i + 1) % r.length;
			const d0x = r[j][0] - r[i][0], d0z = r[j][1] - r[i][1];
			const d1x = o[j][0] - o[i][0], d1z = o[j][1] - o[i][1];
			const l0 = Math.hypot(d0x, d0z);
			if (l0 < 0.3) continue;
			if (d0x * d1x + d0z * d1z <= 0.05 * l0 * l0) ok = false;
		}
		if (ok) return [inset, o];
		inset *= 0.8;
	}
	return [0, r];
}

/**
 * A roof on a ring at height y: 'flat' (with a low parapet coping), 'hip' (single slope to a flat
 * ridge strip), 'mansard' (steep lower slope + low upper slope), 'tent' (all edges to one apex).
 * opts: { h, inset, h2, inset2, colour, pat, ps, rough, metal, dormers: { pitch, w, h, colour } }.
 */
export function roof(P, ring, y, type, opts = {}) {
	P.save();
	P.set({ c: opts.colour || [0.2, 0.2, 0.21], pat: opts.pat ?? PAT.slate, ps: opts.ps ?? 0.3, rough: opts.rough ?? 0.7, metal: opts.metal ?? 0.15, grime: opts.grime ?? 0.25, flood: 0 });
	const r = orientRing(ring);
	if (type === 'flat') {
		P.flat(r, y);
	} else if (type === 'tent') {
		const cx = r.reduce((s, p) => s + p[0], 0) / r.length, cz = r.reduce((s, p) => s + p[1], 0) / r.length;
		P.save();
		P.M.identity(); P.N.identity();
		for (let i = 0; i < r.length; i++) {
			const a = r[i], b = r[(i + 1) % r.length];
			P.quad([a[0], y, a[1]], [b[0], y, b[1]], [cx, y + opts.h, cz], [cx, y + opts.h, cz]);
		}
		P.restore();
	} else if (type === 'hip' || type === 'mansard') {
		const [ins, o1] = safeInset(r, opts.inset ?? 4);
		const h1 = type === 'hip' ? (opts.h ?? 3) * (ins / Math.max(0.01, opts.inset ?? 4)) : opts.h ?? 4;
		P.ringBand(r, [[0.0, 0], [-ins, h1]], y);
		if (type === 'mansard') {
			const [ins2, o2] = safeInset(o1, opts.inset2 ?? 3);
			const h2 = (opts.h2 ?? 1.2) * Math.min(1, ins2 / Math.max(0.01, opts.inset2 ?? 3));
			P.set({ c: opts.colour2 || opts.colour || [0.2, 0.2, 0.21], pat: opts.pat2 ?? opts.pat ?? PAT.seam, ps: opts.ps2 ?? 0.55, metal: opts.metal2 ?? opts.metal ?? 0.3 });
			P.ringBand(o1, [[0, 0], [-ins2, h2]], y + h1);
			P.flat(o2, y + h1 + h2);
		} else P.flat(o1, y + h1);
		if (opts.dormers && type === 'mansard') {
			const d = opts.dormers;
			for (const e of ringEdges(r)) {
				if (e.len < d.w * 2 + 2 || (opts.exterior && !opts.exterior(e))) continue;
				const n = Math.max(1, Math.floor((e.len - 2) / d.pitch));
				P.save();
				P.edge(e.a[0], e.a[1], e.b[0], e.b[1], y);
				for (let i = 0; i < n; i++) {
					const u = e.len / 2 + (i - (n - 1) / 2) * d.pitch;
					const dz = -ins * 0.5;
					P.set({ c: d.colour || [0.62, 0.58, 0.5], pat: 0, rough: 0.7, metal: 0 });
					P.box(u - d.w / 2 - 0.15, h1 * 0.25, dz - 0.3, u + d.w / 2 + 0.15, h1 * 0.25 + d.h + 0.3, dz + 0.45, 'bn');
					P.set({ ch: 'glass', c: [0.05, 0.06, 0.07], lit: Math.random() < 0.25 ? 0.6 : 0 });
					P.quad([u - d.w / 2, h1 * 0.25 + 0.15, dz + 0.47], [u + d.w / 2, h1 * 0.25 + 0.15, dz + 0.47], [u + d.w / 2, h1 * 0.25 + d.h, dz + 0.47], [u - d.w / 2, h1 * 0.25 + d.h, dz + 0.47]);
					P.set({ ch: 'solid', c: opts.colour || [0.2, 0.2, 0.21], pat: PAT.seam, ps: 0.4, metal: 0.3 });
					const y0 = h1 * 0.25 + d.h + 0.3;
					P.quad([u - d.w / 2 - 0.3, y0, dz + 0.55], [u + d.w / 2 + 0.3, y0, dz + 0.55], [u, y0 + d.w * 0.45, dz + 0.55], [u, y0 + d.w * 0.45, dz + 0.55]);
					P.quad([u + d.w / 2 + 0.3, y0, dz + 0.55], [u + d.w / 2 + 0.3, y0, dz - 0.6], [u, y0 + d.w * 0.45, dz - 0.6], [u, y0 + d.w * 0.45, dz + 0.55]);
					P.quad([u - d.w / 2 - 0.3, y0, dz - 0.6], [u - d.w / 2 - 0.3, y0, dz + 0.55], [u, y0 + d.w * 0.45, dz + 0.55], [u, y0 + d.w * 0.45, dz - 0.6]);
				}
				P.restore();
			}
		}
	}
	P.restore();
}

/** Distributes n window axes over an edge of length len (centred, given pitch), or [] if none fit. */
export function axes(len, pitch, margin = 1.2, min = 0) {
	const n = Math.max(min, Math.floor((len - 2 * margin) / pitch + 0.0001) + (len - 2 * margin >= 0 ? 1 : 0));
	if (n <= 0) return [];
	const p = n > 1 ? Math.min(pitch, (len - 2 * margin) / (n - 1)) : 0;
	return Array.from({ length: n }, (_, i) => len / 2 + (i - (n - 1) / 2) * p);
}

/**
 * The shell of a historic building on an OSM ring: walls with real window openings, rusticated
 * ground floor, string courses, main cornice, parapet/attic and a roof.
 *
 * spec = {
 *   wall, trim, plinthC, frame, glass,        // colours ([r,g,b] linear or hex)
 *   grime, flood,                             // weathering 0..1, night floodlight 0..1
 *   plinth: 0.8,                              // socle height
 *   floors: [{ y0, y1, rustic: course|0, win: { w, h, sill, head, surround, pediment, depth, balcony } , door }],
 *   pitch: 4.2, margin: 1.4,                  // window axes
 *   bands: [y...], cornice: { y, k }, parapet: { h, kind: 'attic'|'balustrade' },
 *   roof: { type, h, inset, ... }, top: height of the wall,
 *   pilasters: { from, to, w, order } | null, quoins: true,
 * }
 * opts.exterior(edge) → false for edges hidden against a neighbour (no windows there).
 */
export function buildingShell(P, ring, spec, opts = {}) {
	const r = orientRing(ring);
	const edges = ringEdges(r);
	const rnd = opts.rng || rng(1234);
	const wallC = Array.isArray(spec.wall) ? spec.wall : rgb(spec.wall || '#d3c6ab');
	const trimC = Array.isArray(spec.trim) ? spec.trim : rgb(spec.trim || '#e0d6c1');
	const plinthC = Array.isArray(spec.plinthC) ? spec.plinthC : rgb(spec.plinthC || '#8f8a80');
	const frameC = Array.isArray(spec.frame) ? spec.frame : rgb(spec.frame || '#d9d4ca');
	const top = spec.top;
	const grime = spec.grime ?? 0.35;
	const flood = spec.flood ?? 0;
	P.save();
	P.set({ c: wallC, grime, flood, floodH: top * 1.2, rough: 0.88, metal: 0, pat: 0, ch: 'solid' });
	for (const e of edges) {
		if (e.len < 0.05) continue;
		const ext = opts.exterior ? opts.exterior(e) : true;
		P.save();
		P.edge(e.a[0], e.a[1], e.b[0], e.b[1], 0);
		const ax = ext && e.len > (spec.minWinEdge ?? 3) ? axes(e.len, spec.pitch || 4.2, spec.margin ?? 1.4) : [];
		// Plinth band (below the first floor).
		const pl = spec.plinth ?? 0.8;
		for (const f of spec.floors) {
			const ops = [];
			if (f.win && ax.length) {
				ax.forEach((u, i) => {
					const isDoor = f.door && (f.door === 'all' || (f.door === 'centre' && i === Math.floor(ax.length / 2)) || (typeof f.door === 'function' && f.door(i, ax.length, e)));
					const w = isDoor ? f.doorW || f.win.w * 1.2 : f.win.w;
					const h = isDoor ? f.doorH || f.y1 - f.y0 - 0.6 : f.win.h;
					const y = isDoor ? Math.max(f.y0, 0.05) : f.y0 + (f.win.sill ?? 0.9);
					ops.push({ x: u - w / 2, y, w, h, head: isDoor ? f.doorHead || f.win.head : f.win.head, depth: f.win.depth ?? 0.32, door: isDoor, lit: isDoor ? (rnd() < 0.5 ? 0.9 : 0) : undefined });
				});
			}
			P.set({ c: f.colour || wallC, pat: f.rustic ? PAT.ashlar : f.pat || 0, ps: f.rustic || f.ps || 0.5 });
			wallWithOpenings(P, e.len, f.y0, f.y1, ops, { frameColour: frameC, rng: rnd, litShare: spec.litShare ?? 0.32, glassColour: spec.glass });
			// Window surrounds, sills and pediments.
			P.save();
			P.set({ c: trimC, pat: 0 });
			for (const o of ops) {
				if (o.door) continue;
				const s = f.win.surround;
				const sw = 0.16;
				if (s && s !== 'none') {
					if (o.head === 'round') {
						P.box(o.x - sw, o.y, 0, o.x, o.y + o.h - o.w / 2, 0.07, 'b');
						P.box(o.x + o.w, o.y, 0, o.x + o.w + sw, o.y + o.h - o.w / 2, 0.07, 'b');
						archBand(P, o.x + o.w / 2, o.y + o.h - o.w / 2, o.w / 2, o.w / 2 + sw, 0, 0.08, 7);
						P.box(o.x + o.w / 2 - 0.16, o.y + o.h - 0.05, 0, o.x + o.w / 2 + 0.16, o.y + o.h + sw + 0.12, 0.14, 'b');
					} else {
						P.box(o.x - sw, o.y, 0, o.x, o.y + o.h + sw, 0.07, 'b');
						P.box(o.x + o.w, o.y, 0, o.x + o.w + sw, o.y + o.h + sw, 0.07, 'b');
						P.box(o.x, o.y + o.h, 0, o.x + o.w, o.y + o.h + sw, 0.07, 'b');
					}
				}
				// Sill.
				P.box(o.x - sw - 0.08, o.y - 0.12, 0, o.x + o.w + sw + 0.08, o.y, 0.14, 'b');
				const ped = f.win.pediment;
				if (ped === 'triangle') {
					const py = o.y + o.h + sw;
					P.box(o.x - sw - 0.12, py, 0, o.x + o.w + sw + 0.12, py + 0.16, 0.2, 'b');
					P.quad([o.x - sw - 0.12, py + 0.16, 0.2], [o.x + o.w + sw + 0.12, py + 0.16, 0.2], [o.x + o.w / 2, py + 0.16 + o.w * 0.32, 0.2], [o.x + o.w / 2, py + 0.16 + o.w * 0.32, 0.2]);
					const L = Math.hypot(o.w / 2 + sw + 0.12, o.w * 0.32);
					const ang = Math.atan2(o.w * 0.32, o.w / 2 + sw + 0.12);
					for (const sx of [-1, 1]) {
						P.save();
						P.translate(o.x + o.w / 2 + sx * (o.w / 4 + sw / 2 + 0.06), py + 0.16 + o.w * 0.16, 0).rotateZ(-sx * ang);
						P.box(-L / 2, 0, 0, L / 2, 0.12, 0.24, 'b');
						P.restore();
					}
				} else if (ped === 'cornice') {
					const py = o.y + o.h + sw;
					P.box(o.x - sw - 0.04, py, 0, o.x + o.w + sw + 0.04, py + 0.34, 0.06, 'b');
					P.box(o.x - sw - 0.18, py + 0.34, 0, o.x + o.w + sw + 0.18, py + 0.52, 0.24, 'b');
					// Console brackets.
					for (const sx of [o.x - sw - 0.1, o.x + o.w + sw + 0.1]) P.box(sx - 0.07, py - 0.35, 0, sx + 0.07, py + 0.34, 0.16, 'b');
				} else if (ped === 'segment') {
					const py = o.y + o.h + sw;
					archBand(P, o.x + o.w / 2, py - o.w * 0.25, o.w * 0.62, o.w * 0.62 + 0.2, 0, 0.22, 6, 0.42);
				}
				if (f.win.balcony && f.win.balcony(o)) {
					P.save();
					P.translate(0, 0, 0);
					P.box(o.x - 0.5, o.y - 0.22, 0, o.x + o.w + 0.5, o.y - 0.05, 0.85, 'n');
					P.set({ c: [0.06, 0.06, 0.06], metal: 0.45, rough: 0.5 });
					for (let bx = o.x - 0.45; bx <= o.x + o.w + 0.46; bx += 0.14) P.box(bx - 0.012, o.y - 0.05, 0.78, bx + 0.012, o.y + 0.95, 0.81, 'bt');
					P.box(o.x - 0.5, o.y + 0.92, 0.76, o.x + o.w + 0.5, o.y + 0.98, 0.84, 'b');
					P.box(o.x - 0.5, o.y - 0.05, 0.05, o.x - 0.47, o.y + 0.98, 0.84, 'b');
					P.box(o.x + o.w + 0.47, o.y - 0.05, 0.05, o.x + o.w + 0.5, o.y + 0.98, 0.84, 'b');
					P.restore();
				}
			}
			P.restore();
			// Pilasters between axes on this floor.
			if (f.pilasters && ax.length > 1) {
				P.save();
				P.set({ c: trimC, pat: 0 });
				for (let i = 0; i + 1 < ax.length; i++) pilaster(P, (ax[i] + ax[i + 1]) / 2, f.y0, f.y1, f.pilasters.w || 0.6, f.pilasters.p ?? 0.16, { order: f.pilasters.order || 'ionic' });
				P.restore();
			}
		}
		// Corner quoins (rusticated strips at both ends of exterior edges).
		if (spec.quoins && ext && e.len > 4) {
			P.save();
			P.set({ c: trimC, pat: PAT.ashlar, ps: 0.55 });
			const qy0 = pl, qy1 = spec.cornice ? spec.cornice.y : top;
			for (const u of [0, e.len - 0.9]) P.box(u, qy0, 0, u + 0.9, qy1, 0.1, 'b');
			P.restore();
		}
		P.restore();
	}
	// Plinth, bands, cornice, parapet around the ring.
	P.set({ c: plinthC, pat: PAT.ashlar, ps: 0.45, grime: grime * 1.2, rough: 0.8 });
	P.ringBand(r, [[0.14, -0.4], [0.14, (spec.plinth ?? 0.8) - 0.1], [0.04, spec.plinth ?? 0.8], [0, (spec.plinth ?? 0.8) + 0.02]], 0);
	P.set({ c: trimC, pat: 0, grime });
	for (const b of spec.bands || []) P.ringBand(r, PROFILES.band(b.k ?? 0.9), b.y ?? b);
	if (spec.cornice) {
		P.set({ grime: grime * 1.3 });
		P.ringBand(r, PROFILES.cornice(spec.cornice.k ?? 1), spec.cornice.y);
		// Cornice soffit.
		const k = spec.cornice.k ?? 1;
		P.flat(offsetRing(r, 0.9 * k), spec.cornice.y + 0.5 * k, [r], true);
	}
	let y = spec.cornice ? spec.cornice.y + (spec.cornice.k ?? 1) : top;
	if (spec.parapet) {
		const ph = spec.parapet.h ?? 1;
		if (spec.parapet.kind === 'balustrade') {
			for (const e of edges) {
				if (e.len < 1.5) continue;
				P.save();
				P.edge(e.a[0], e.a[1], e.b[0], e.b[1], 0);
				balustrade(P, 0.3, e.len - 0.3, y, { h: ph, spacing: 0.34, depth: 0.32, ped: spec.parapet.ped ?? 4.2, z: -0.25, low: opts.lowDetail });
				P.restore();
			}
		} else {
			P.ringBand(r, [[0, 0], [0, ph - 0.2], [0.1, ph - 0.15], [0.1, ph], [-0.4, ph]], y);
		}
		y += ph;
	}
	if (spec.roof) roof(P, r, spec.roof.y ?? y - (spec.parapet ? spec.parapet.h ?? 1 : 0), spec.roof.type, { ...spec.roof, exterior: opts.exterior });
	P.restore();
	return { top: y };
}

/** A flat arched band (archivolt) in the local x–y plane: centre (cx, cy), radii r0..r1, from z0 to z1. */
export function archBand(P, cx, cy, r0, r1, z0, z1, seg = 10, span = 1) {
	const a0 = Math.PI / 2 - (Math.PI / 2) * span, a1 = Math.PI / 2 + (Math.PI / 2) * span;
	for (let i = 0; i < seg; i++) {
		const t0 = a0 + ((a1 - a0) * i) / seg, t1 = a0 + ((a1 - a0) * (i + 1)) / seg;
		const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
		const p = (r, c, s, z) => [cx + r * c, cy + r * s, z];
		// Front face.
		P.quad(p(r1, c0, s0, z1), p(r1, c1, s1, z1), p(r0, c1, s1, z1), p(r0, c0, s0, z1));
		// Outer face.
		P.quad(p(r1, c1, s1, z0), p(r1, c1, s1, z1), p(r1, c0, s0, z1), p(r1, c0, s0, z0));
		// Inner face (soffit).
		P.quad(p(r0, c0, s0, z0), p(r0, c0, s0, z1), p(r0, c1, s1, z1), p(r0, c1, s1, z0));
	}
}

/**
 * Sweeps a profile [[offset, z], ...] along a counter-clockwise 2D curve in the local x–y plane
 * (pts with unit outward normals nrm). The profile is listed from the inner edge outwards (offset
 * along the normal, z towards the viewer). Used for archivolts, arch soffits and roof ribs.
 */
export function sweep(P, pts, nrm, profile) {
	for (let k = 0; k + 1 < profile.length; k++) {
		const [o0, z0] = profile[k], [o1, z1] = profile[k + 1];
		if (Math.abs(o0 - o1) + Math.abs(z0 - z1) < 1e-6) continue;
		for (let i = 0; i + 1 < pts.length; i++) {
			const p = (j, o, z) => [pts[j][0] + nrm[j][0] * o, pts[j][1] + nrm[j][1] * o, z];
			P.quad(p(i, o0, z0), p(i, o1, z1), p(i + 1, o1, z1), p(i + 1, o0, z0));
		}
	}
}

/** Points and outward normals of a half-ellipse arch (centre cx, springing y, half-span a, rise b), CCW from the right springing. */
export function ellipseArch(cx, y, a, b, seg = 24) {
	const pts = [], nrm = [];
	for (let i = 0; i <= seg; i++) {
		const t = (Math.PI * i) / seg;
		const c = Math.cos(t), s = Math.sin(t);
		pts.push([cx + a * c, y + b * s]);
		const nx = c / a, ny = s / b, l = Math.hypot(nx, ny) || 1;
		nrm.push([nx / l, ny / l]);
	}
	return { pts, nrm };
}
