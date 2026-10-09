// Building geometry as plain arrays (tested in tests/web/meshing.test.mjs).
// World axes: +x east, +y up, +z south. Front faces are counter-clockwise (three.js default).

import { ShapeUtils, Vector2 } from './vendor/three.module.min.js';
import { polygonArea } from './geo.js';

export const FLOOR_H = 3.4;
export const BAY_W = 3.2;
export const GROUND_H = 3.8;
export const SHOP_BAY_W = 4.5;

export class MeshBuffer {
	constructor() {
		this.pos = [];
		this.nrm = [];
		this.uv = [];
		this.col = [];
		this.idx = [];
	}
	get vertexCount() {
		return this.pos.length / 3;
	}
	vertex(x, y, z, nx, ny, nz, u, v, r = 1, g = 1, b = 1) {
		this.pos.push(x, y, z);
		this.nrm.push(nx, ny, nz);
		this.uv.push(u, v);
		this.col.push(r, g, b);
		return this.vertexCount - 1;
	}
}

/**
 * Appends one wall band per ring edge, facing away from the solid. `uvFor(along, y)` maps the
 * distance along the ring and the height to texture coordinates.
 */
export function appendWalls(buf, rings, y0, y1, uvFor, colour = [1, 1, 1]) {
	if (y1 - y0 < 0.05) return;
	rings.forEach((ring, ringIndex) => {
		const area = polygonArea(ring);
		const isOuter = ringIndex === 0;
		// polygonArea > 0 means the solid lies to the "+z of +x" side of travel (see test); flip accordingly.
		const outwardSign = (isOuter ? area > 0 : area < 0) ? 1 : -1;
		let along = 0;
		for (let i = 0; i < ring.length; i++) {
			const [ax, az] = ring[i];
			const [bx, bz] = ring[(i + 1) % ring.length];
			const dx = bx - ax, dz = bz - az;
			const len = Math.hypot(dx, dz);
			if (len < 0.05) continue;
			// Outward normal in x/z.
			const nx = (outwardSign * dz) / len, nz = (-outwardSign * dx) / len;
			const [u0, v0] = uvFor(along, y0), [u1, v1] = uvFor(along + len, y1);
			const a = buf.vertex(ax, y0, az, nx, 0, nz, u0, v0, ...colour);
			const b = buf.vertex(bx, y0, bz, nx, 0, nz, u1, v0, ...colour);
			const c = buf.vertex(bx, y1, bz, nx, 0, nz, u1, v1, ...colour);
			const d = buf.vertex(ax, y1, az, nx, 0, nz, u0, v1, ...colour);
			// Triangle (a, b, c) has normal (-dz, 0, dx) * h; use it when that is outward.
			if (outwardSign < 0) buf.idx.push(a, b, c, a, c, d);
			else buf.idx.push(a, c, b, a, d, c);
			along += len;
		}
	});
}

/** Appends a flat roof (with courtyard holes) at height y, facing up. */
export function appendRoof(buf, rings, y, colour = [1, 1, 1], uvScale = 0.25) {
	const contour = rings[0].map(([x, z]) => new Vector2(x, z));
	const holes = rings.slice(1).map((r) => r.map(([x, z]) => new Vector2(x, z)));
	let tris;
	try {
		tris = ShapeUtils.triangulateShape(contour, holes);
	} catch {
		return 0;
	}
	const flat = [contour, ...holes].flat();
	const base = buf.vertexCount;
	for (const p of flat) buf.vertex(p.x, y, p.y, 0, 1, 0, p.x * uvScale, p.y * uvScale, ...colour);
	for (const [a, b, c] of tris) {
		const A = flat[a], B = flat[b], C = flat[c];
		// Normal (B-A) x (C-A) has y = (Bz-Az)(Cx-Ax) - (Bx-Ax)(Cz-Az); keep it pointing up.
		const ny = (B.y - A.y) * (C.x - A.x) - (B.x - A.x) * (C.y - A.y);
		if (ny > 0) buf.idx.push(base + a, base + b, base + c);
		else if (ny < 0) buf.idx.push(base + a, base + c, base + b);
	}
	return tris.length;
}

/** A ribbon of width w along a polyline at height y (roads, rails, kerbs). UVs are world-aligned. */
export function appendRibbon(buf, pts, width, y, uvScale = 1 / 6, colour = [1, 1, 1], extend = 0) {
	const h = width / 2;
	for (let i = 0; i + 1 < pts.length; i++) {
		let [ax, az] = pts[i];
		let [bx, bz] = pts[i + 1];
		const dx = bx - ax, dz = bz - az;
		const len = Math.hypot(dx, dz);
		if (len < 0.01) continue;
		const ux = dx / len, uz = dz / len;
		// Extend a little so joints between segments have no gaps.
		const e = Math.min(extend, len / 2);
		ax -= ux * e; az -= uz * e; bx += ux * e; bz += uz * e;
		const px = -uz * h, pz = ux * h;
		const base = buf.vertexCount;
		const corners = [[ax + px, az + pz], [bx + px, bz + pz], [bx - px, bz - pz], [ax - px, az - pz]];
		for (const [x, z] of corners) buf.vertex(x, y, z, 0, 1, 0, x * uvScale, z * uvScale, ...colour);
		// Corners go round anticlockwise seen from above when (ux, uz) x (px, pz) ... check winding by the normal's y.
		const ny = (corners[1][1] - corners[0][1]) * (corners[2][0] - corners[0][0]) - (corners[1][0] - corners[0][0]) * (corners[2][1] - corners[0][1]);
		if (ny > 0) buf.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
		else buf.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
	}
}

/** A flat polygon (park, square) at height y. */
export function appendPolygon(buf, outer, holes, y, uvScale = 0.2, colour = [1, 1, 1]) {
	return appendRoof(buf, [outer, ...holes], y, colour, uvScale);
}
