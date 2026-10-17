// Roofs for arbitrary OSM footprints (pure geometry, tested in tests/web/buildings.test.mjs).
//
// Pest tenement roofs slope towards the street and the courtyard but end in a vertical gable on the
// party walls (where the brick firewall rises). We get that shape from a per-edge weighted inward
// offset of the footprint: sloped edges move inwards, party-wall edges (weight 0) stay put, and the
// largest valid offset gives the ridge. Mansards use two offsets; domes, onions and cones shrink the
// footprint towards its centre.
import { ShapeUtils, Vector2 } from '../vendor/three.module.min.js';
import { polygonArea, pointInPolygon } from '../geo.js';

/** Outward normals of a ring's edges (ri = 0 outer ring, > 0 hole). */
function ringEdges(ring, isOuter) {
	const area = polygonArea(ring);
	const s = (isOuter ? area > 0 : area < 0) ? 1 : -1;
	const out = [];
	for (let i = 0; i < ring.length; i++) {
		const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
		const len = Math.hypot(bx - ax, bz - az) || 1e-9;
		const ux = (bx - ax) / len, uz = (bz - az) / len;
		out.push({ ux, uz, nx: s * uz, nz: -s * ux, len });
	}
	return out;
}

/** Inward offset of each ring by d * weight per edge. Returns new rings (same vertex count). */
export function offsetRings(rings, weights, d) {
	return rings.map((ring, ri) => {
		const E = ringEdges(ring, ri === 0);
		const w = weights[ri];
		const n = ring.length;
		const out = new Array(n);
		for (let j = 0; j < n; j++) {
			const p = (j - 1 + n) % n;
			const a = E[p], b = E[j];
			const [vx, vz] = ring[j];
			const da = d * w[p], db = d * w[j];
			// Line p: through V - n_p * da, direction u_p. Line j: through V - n_j * db, direction u_j.
			const cr = a.ux * b.uz - a.uz * b.ux;
			if (Math.abs(cr) < 0.02) {
				const dd = Math.max(da, db);
				out[j] = [vx - (b.nx + a.nx) * 0.5 * dd, vz - (b.nz + a.nz) * 0.5 * dd];
				continue;
			}
			const px = vx - a.nx * da, pz = vz - a.nz * da;
			const qx = vx - b.nx * db, qz = vz - b.nz * db;
			// px + ua*s = qx + ub*t  ->  s = ((q-p) x ub) / (ua x ub)
			const s = ((qx - px) * b.uz - (qz - pz) * b.ux) / cr;
			out[j] = [px + a.ux * s, pz + a.uz * s];
		}
		return out;
	});
}

function segsCross(ax, az, bx, bz, cx, cz, dx, dz) {
	const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
	const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
	const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
	const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
	return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}

/** An offset is valid while no edge flips and no two offset edges cross. */
export function offsetValid(rings, off, weights) {
	const all = [];
	for (let ri = 0; ri < rings.length; ri++) {
		const r0 = rings[ri], r1 = off[ri], n = r0.length;
		for (let i = 0; i < n; i++) {
			const j = (i + 1) % n;
			const ox = r0[j][0] - r0[i][0], oz = r0[j][1] - r0[i][1];
			const nx = r1[j][0] - r1[i][0], nz = r1[j][1] - r1[i][1];
			const l0 = Math.hypot(ox, oz);
			if (l0 < 1e-6) continue;
			const dot = (ox * nx + oz * nz) / l0;
			if (dot < -0.02) return false; // flipped
			if (weights[ri][i] === 0 && dot < 0.05) return false; // a gable end may not vanish
			all.push([r1[i][0], r1[i][1], r1[j][0], r1[j][1]]);
		}
	}
	// Courtyards must stay inside the shrinking outline.
	for (let ri = 1; ri < off.length; ri++) {
		const h = off[ri];
		let mx = 0, mz = 0;
		for (const [x, z] of h) { mx += x; mz += z; }
		if (!pointInPolygon(h[0][0], h[0][1], off[0]) || pointInPolygon(off[0][0][0], off[0][0][1], h)) return false;
		if (!pointInPolygon(mx / h.length, mz / h.length, off[0])) return false;
	}
	const m = all.length;
	if (m > 400) return true; // huge outlines: trust the flip test only
	for (let a = 0; a < m; a++) for (let b = a + 2; b < m; b++) {
		const A = all[a], B = all[b];
		if (segsCross(A[0], A[1], A[2], A[3], B[0], B[1], B[2], B[3])) return false;
	}
	return true;
}

/** Largest valid offset distance up to dMax (binary search). */
export function maxOffset(rings, weights, dMax, steps = 9) {
	let lo = 0, hi = dMax;
	if (offsetValid(rings, offsetRings(rings, weights, hi), weights)) return hi;
	for (let k = 0; k < steps; k++) {
		const mid = (lo + hi) / 2;
		if (offsetValid(rings, offsetRings(rings, weights, mid), weights)) lo = mid;
		else hi = mid;
	}
	return lo;
}

function triangulate(rings) {
	const contour = rings[0].map(([x, z]) => new Vector2(x, z));
	if (Math.abs(ShapeUtils.area(contour)) < 0.05) return { pts: [], tris: [] };
	const holes = rings.slice(1).filter((h) => h.length >= 3).map((h) => h.map(([x, z]) => new Vector2(x, z)));
	let tris;
	try { tris = ShapeUtils.triangulateShape(contour, holes); } catch { return { pts: [], tris: [] }; }
	const pts = [contour, ...holes].flat().map((v) => [v.x, v.y]);
	return { pts, tris };
}

/**
 * Builds the roof faces of one building.
 *   rings: [outer, ...holes] ([x, z] arrays), weights[ri][edge] in 0..1 (0 = vertical gable/party),
 *   y0: eave height, spec: { kind, pitch (rad), rise (optional total height), cap (max inset) }.
 * Returns { faces: [{ kind: 'slope'|'gable'|'top'|'flat', pts: [[x, y, z], ...] (convex, counter-
 * clockwise seen from outside), ux, uz (eave direction for UVs) }], ridge (y of the top), topRings }.
 */
export function roofFaces(rings, weights, y0, spec) {
	const faces = [];
	const kind = spec.kind;
	if (kind === 'flat') {
		const t = triangulate(rings);
		for (const [a, b, c] of t.tris) faces.push({ kind: 'flat', pts: upTri(t.pts[a], t.pts[b], t.pts[c], y0) });
		return { faces, ridge: y0, topRings: rings };
	}
	if (kind === 'dome' || kind === 'onion' || kind === 'cone') return radialRoof(rings[0], y0, spec, faces);
	const tanP = Math.tan(spec.pitch || 0.62);
	const stages = [];
	if (kind === 'mansard') {
		const d1 = maxOffset(rings, weights, 1.3);
		stages.push({ d: d1, rise: Math.min(3.4, d1 * 2.6) });
		stages.push({ d: null, rise: null, tan: 0.42, cap: spec.cap || 6.5, maxRise: 2.2 });
	} else {
		stages.push({ d: null, rise: spec.rise, tan: tanP, cap: kind === 'pyramidal' ? 60 : spec.cap || 6.5, maxRise: spec.rise || 6.2 });
	}
	let cur = rings, y = y0;
	for (const st of stages) {
		let d = st.d;
		if (d == null) d = maxOffset(cur, weights, st.cap);
		if (d < 0.05) break;
		let rise = st.rise != null ? st.rise : Math.min(st.maxRise, d * st.tan);
		const next = offsetRings(cur, weights, d);
		const y1 = y + rise;
		for (let ri = 0; ri < cur.length; ri++) {
			const A = cur[ri], B = next[ri], n = A.length;
			const E = ringEdges(A, ri === 0);
			for (let i = 0; i < n; i++) {
				const j = (i + 1) % n;
				if (E[i].len < 0.02) continue;
				const p = [[A[i][0], y, A[i][1]], [A[j][0], y, A[j][1]], [B[j][0], y1, B[j][1]], [B[i][0], y1, B[i][1]]];
				const top = Math.hypot(B[j][0] - B[i][0], B[j][1] - B[i][1]);
				const pts = top < 0.02 ? [p[0], p[1], p[2]] : p;
				faces.push({ kind: weights[ri][i] > 0 ? 'slope' : 'gable', pts: outward(pts, E[i].nx, E[i].nz), ux: E[i].ux, uz: E[i].uz, nx: E[i].nx, nz: E[i].nz, d, rise });
			}
		}
		cur = next;
		y = y1;
	}
	// Top: what is left of the footprint at the ridge height (a terrace on deep blocks).
	const t = triangulate(cur);
	let topArea = 0;
	for (const [a, b, c] of t.tris) {
		const P = t.pts[a], Q = t.pts[b], R = t.pts[c];
		const ar = Math.abs((Q[0] - P[0]) * (R[1] - P[1]) - (Q[1] - P[1]) * (R[0] - P[0])) / 2;
		if (ar < 1e-4) continue;
		topArea += ar;
		faces.push({ kind: 'top', pts: upTri(P, Q, R, y) });
	}
	if (topArea > 12) for (const f of faces) if (f.kind === 'top') f.kind = 'flat';
	return { faces, ridge: y, topRings: cur };
}

function upTri(P, Q, R, y) {
	const ny = (Q[1] - P[1]) * (R[0] - P[0]) - (Q[0] - P[0]) * (R[1] - P[1]);
	return ny > 0 ? [[P[0], y, P[1]], [Q[0], y, Q[1]], [R[0], y, R[1]]] : [[P[0], y, P[1]], [R[0], y, R[1]], [Q[0], y, Q[1]]];
}

/** Orders a planar polygon's points so its normal (right-handed) points along the outward side. */
function outward(pts, nx, nz) {
	const [a, b, c] = pts;
	const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
	const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
	let gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
	if (Math.hypot(gx, gy, gz) < 1e-9 && pts.length > 3) {
		const d = pts[3];
		const wx = d[0] - a[0], wy = d[1] - a[1], wz = d[2] - a[2];
		gx = uy * wz - uz * wy; gy = uz * wx - ux * wz; gz = ux * wy - uy * wx;
	}
	// Slopes face up and out; gables face out.
	const dot = gx * nx + gz * nz + gy * 0.5;
	return dot >= 0 ? pts : pts.slice().reverse();
}

function radialRoof(ring, y0, spec, faces) {
	let cx = 0, cz = 0;
	for (const [x, z] of ring) { cx += x; cz += z; }
	cx /= ring.length; cz /= ring.length;
	let rad = 0;
	for (const [x, z] of ring) rad += Math.hypot(x - cx, z - cz);
	rad /= ring.length;
	const H = spec.rise || (spec.kind === 'cone' ? rad * 1.6 : spec.kind === 'onion' ? rad * 2.2 : rad * 0.9);
	const prof = [];
	const N = spec.kind === 'cone' ? 1 : 6;
	for (let k = 0; k <= N; k++) {
		const t = k / N;
		if (spec.kind === 'cone') prof.push([1 - t, t]);
		else if (spec.kind === 'onion') {
			const s = t < 0.45 ? 1 + 0.25 * Math.sin((t / 0.45) * Math.PI * 0.5) : 1.25 * Math.cos(((t - 0.45) / 0.55) * Math.PI * 0.5) ** 1.6;
			prof.push([s, t]);
		} else prof.push([Math.cos(t * Math.PI * 0.5), Math.sin(t * Math.PI * 0.5)]);
	}
	const area = polygonArea(ring);
	for (let k = 0; k < N; k++) {
		const [s0, h0] = prof[k], [s1, h1] = prof[k + 1];
		for (let i = 0; i < ring.length; i++) {
			const j = (i + 1) % ring.length;
			const [ax, az] = ring[i], [bx, bz] = ring[j];
			const P = (x, z, s, h) => [cx + (x - cx) * s, y0 + h * H, cz + (z - cz) * s];
			let pts = s1 < 0.01 ? [P(ax, az, s0, h0), P(bx, bz, s0, h0), [cx, y0 + h1 * H, cz]] : [P(ax, az, s0, h0), P(bx, bz, s0, h0), P(bx, bz, s1, h1), P(ax, az, s1, h1)];
			// Ring winding decides which way is out.
			if (area < 0) pts = pts.slice().reverse();
			const len = Math.hypot(bx - ax, bz - az) || 1;
			faces.push({ kind: 'slope', pts: fixUp(pts, cx, cz), ux: (bx - ax) / len, uz: (bz - az) / len });
		}
	}
	return { faces, ridge: y0 + H, topRings: [ring.map(([x, z]) => [cx + (x - cx) * 0.01, cz + (z - cz) * 0.01])] };
}

function fixUp(pts, cx, cz) {
	const [a, b, c] = pts;
	const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
	const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
	const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
	const mx = (a[0] + b[0] + c[0]) / 3 - cx, mz = (a[2] + b[2] + c[2]) / 3 - cz;
	return gx * mx + gz * mz + gy * 0.3 >= 0 ? pts : pts.slice().reverse();
}

/** Height of a hipped roof surface above the eave at distance s inside the eave line. */
export function roofYAt(y0, rise, d, s) {
	return y0 + rise * Math.min(1, s / Math.max(d, 1e-6));
}
