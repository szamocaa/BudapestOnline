// Closed, outward-facing building solids in every ring orientation (divergence theorem check).
import assert from 'node:assert/strict';
import { MeshBuffer, appendWalls, appendRoof, appendRibbon } from '../../game/meshing.js';
import { polygonArea, pointInPolygon } from '../../game/geo.js';

function tri(buf, t) {
	const i = buf.idx.slice(t * 3, t * 3 + 3);
	const P = i.map((k) => buf.pos.slice(k * 3, k * 3 + 3));
	const u = [P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]];
	const v = [P[2][0] - P[0][0], P[2][1] - P[0][1], P[2][2] - P[0][2]];
	const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
	const vol = (P[0][0] * (P[1][1] * P[2][2] - P[1][2] * P[2][1]) - P[0][1] * (P[1][0] * P[2][2] - P[1][2] * P[2][0]) + P[0][2] * (P[1][0] * P[2][1] - P[1][1] * P[2][0])) / 6;
	return { P, n, vol, stored: buf.nrm.slice(i[0] * 3, i[0] * 3 + 3) };
}

function check(name, rings, h) {
	const buf = new MeshBuffer();
	appendWalls(buf, rings, 0, h, (a, y) => [a, y]);
	appendRoof(buf, rings, h);
	const area = Math.abs(polygonArea(rings[0])) - rings.slice(1).reduce((s, r) => s + Math.abs(polygonArea(r)), 0);
	let vol = 0;
	const inSolid = (x, z) => pointInPolygon(x, z, rings[0]) && !rings.slice(1).some((r) => pointInPolygon(x, z, r));
	for (let t = 0; t < buf.idx.length / 3; t++) {
		const T = tri(buf, t);
		vol += T.vol;
		const len = Math.hypot(...T.n);
		assert.ok(len > 0);
		const dot = (T.n[0] * T.stored[0] + T.n[1] * T.stored[1] + T.n[2] * T.stored[2]) / len;
		assert.ok(dot > 0.999, `${name}: triangle ${t} winding disagrees with its normal`);
		if (Math.abs(T.n[1]) < 1e-6) {
			const cx = (T.P[0][0] + T.P[1][0] + T.P[2][0]) / 3, cz = (T.P[0][2] + T.P[1][2] + T.P[2][2]) / 3;
			assert.ok(!inSolid(cx + T.stored[0] * 0.01, cz + T.stored[2] * 0.01), `${name}: wall ${t} faces into the building`);
			assert.ok(inSolid(cx - T.stored[0] * 0.01, cz - T.stored[2] * 0.01), `${name}: wall ${t} not on the boundary`);
		}
	}
	assert.ok(Math.abs(vol - area * h) < 1e-6 * area * h + 1e-6, `${name}: volume ${vol} vs ${area * h}`);
}

const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
const L = [[0, 0], [30, 0], [30, 10], [10, 10], [10, 20], [0, 20]];
const block = [[0, 0], [60, 0], [60, 40], [0, 40]];
const yard = [[15, 10], [45, 10], [45, 30], [15, 30]];
for (const [name, rings] of [['square', [square]], ['L', [L]], ['courtyard', [block, yard]]]) {
	for (let combo = 0; combo < 4; combo++) {
		const variant = rings.map((r, k) => ((k === 0 && combo & 1) || (k === 1 && combo & 2) ? r.slice().reverse() : r));
		check(`${name}#${combo}`, variant, 17);
	}
}

const rb = new MeshBuffer();
appendRibbon(rb, [[0, 0], [10, 0], [10, 10]], 4, 0.02);
for (let t = 0; t < rb.idx.length / 3; t++) assert.ok(tri(rb, t).n[1] > 0, 'ribbons face up');
console.log('ok meshing: closed outward solids for square, L-shape and courtyard block in all ring orientations');
