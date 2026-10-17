// Buildings: planning (party walls, storeys, street fronts), bay layout, roofs and facade geometry.
import assert from 'node:assert/strict';
import { planBuildings, layoutBays, occupancyAt, chunkIndex, STYLES } from '../../game/city/facadesPlan.js';
import { roofFaces, offsetRings, maxOffset } from '../../game/city/facadesRoof.js';
import { OpaqueBuf, GlassBuf, RailBuf, FarBuf, buildDetail, buildFar } from '../../game/city/facadesGeom.js';

// --- bay layout: whole windows only, evenly spread between the margins
for (const len of [0.5, 1.7, 2.6, 5, 7.3, 12, 18.4, 33]) {
	for (const axis of [3.4, 4.0]) {
		const b = layoutBays(len, axis, 0.9, 0.9);
		if (b.n === 0) continue;
		assert.ok(b.start >= 0 && b.start + b.n * b.step <= len + 1e-9, `bays fit in ${len} m`);
		if (b.n > 1) assert.ok(b.step > axis * 0.66 && b.step < axis * 1.5, `bay width ${b.step} near the axis ${axis}`);
	}
}
assert.equal(layoutBays(1.2, 3.6).n, 0, 'no window on a 1.2 m wall');

// --- occupancy follows the evening
assert.ok(occupancyAt(20.5) > 0.5 && occupancyAt(3) < 0.1, 'many lit at 20:30, few at 03:00');
for (let h = 0; h < 24; h += 0.5) assert.ok(occupancyAt(h) > 0 && occupancyAt(h) <= 1);

// --- a street of three terraced houses (shared party walls) on a residential street
// Street along z = 0 (houses south of it, +z), plots 16 m wide and 14 m deep.
const rect = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
const B = (id, ring, extra = {}) => {
	const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length, cz = ring.reduce((s, p) => s + p[1], 0) / ring.length;
	return { id, outer: ring, holes: [], h: 16, minH: 0, kind: 'yes', cx, cz, tags: {}, ...extra };
};
const data = {
	buildings: [
		B(1, rect(0, 5, 16, 19), { levels: 4, h: 4 * 3.4 + 0.8 }),
		B(2, rect(16, 5, 32, 19)),
		B(3, rect(32, 5, 48, 19), { levels: 2, h: 2 * 3.4 + 0.8 }),
	],
	roads: [{ id: 9, cls: 'residential', name: 'Teszt utca', pts: [[-20, 0], [70, 0]], width: 8 }],
	areas: [], pois: [{ x: 24, z: 4, kind: 'tobacco', name: 'Nemzeti Dohánybolt' }],
};
const plan = planBuildings(data);
assert.equal(plan.infos.length, 3);
const [h1, h2, h3] = plan.infos;
assert.equal(h1.levels, 4, 'mapped levels are kept');
assert.equal(h3.levels, 2);
assert.ok(h2.levels >= 2 && h2.levels <= 5, `the unmapped middle house takes its storeys from the neighbours (${h2.levels})`);
for (const i of plan.infos) {
	assert.ok(STYLES[i.style], 'has a style');
	assert.ok(i.floorY.length === i.levels + 1 && i.wallTop > i.floorY[i.levels], 'storeys stack up to the cornice');
	assert.ok(i.floorY[1] - i.floorY[0] >= 3.5, 'tall ground storey');
	const kinds = i.segs.map((s) => s.kind);
	assert.ok(kinds.includes('street'), 'a street front');
}
const party = h2.segs.filter((s) => s.kind === 'party');
assert.equal(party.length, 2, 'the middle house has two party walls');
assert.ok(h2.segs.some((s) => s.kind === 'street' && s.nz < -0.9), 'its street front faces north, to the road');
assert.equal(h2.segs.find((s) => s.kind === 'street' && s.nz < -0.9).pois.length, 1, 'the shop sits behind the street wall');
assert.deepEqual(chunkIndex(h2.b.cx, h2.b.cz), chunkIndex(24, 12));

// --- roofs: a hip roof faces up and out, a roof with two gable ends has vertical gables
const ring = rect(0, 0, 20, 12);
const up = (pts) => {
	const [a, b, c] = pts;
	const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
	return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
};
const hip = roofFaces([ring], [[1, 1, 1, 1]], 15, { kind: 'hip', pitch: 0.6, cap: 6.5 });
assert.ok(hip.ridge > 15 && hip.ridge < 22, `ridge height ${hip.ridge}`);
for (const f of hip.faces) assert.ok(up(f.pts)[1] >= -1e-6, `${f.kind} faces up`);
const gab = roofFaces([ring], [[1, 0, 1, 0]], 15, { kind: 'hip', pitch: 0.6, cap: 6.5 });
const gables = gab.faces.filter((f) => f.kind === 'gable');
assert.equal(gables.length, 2, 'two gable ends');
for (const g of gables) assert.ok(Math.abs(up(g.pts)[1]) < 1e-6, 'gables are vertical');
assert.ok(maxOffset([ring], [[1, 1, 1, 1]], 20) <= 6.01, 'the ridge inset stops at the half width');
assert.equal(offsetRings([ring], [[0, 0, 0, 0]], 3)[0][0][0], 0, 'weight 0 keeps the wall');

// --- facade geometry: finite, unit normals, something in every buffer
const out = { opaque: new OpaqueBuf(), glass: new GlassBuf(), rail: new RailBuf(), signs: [] };
for (const i of plan.infos) buildDetail(i, out);
assert.ok(out.opaque.triangles > 500, `detail triangles ${out.opaque.triangles}`);
assert.ok(out.glass.idx.length > 0, 'windows have glass');
const P = out.opaque.P.view(), N = out.opaque.N.view();
for (let k = 0; k < P.length; k++) assert.ok(Number.isFinite(P[k]), 'finite positions');
for (let k = 0; k < N.length; k += 3) { const l = Math.hypot(N[k], N[k + 1], N[k + 2]) / 127; assert.ok(l > 0.97 && l < 1.03, 'unit normals'); }
for (const k of out.opaque.I.view()) assert.ok(k < out.opaque.n, 'indices in range');
const FB = new FarBuf();
for (const i of plan.infos) buildFar(i, FB, 7);
assert.ok(FB.idx.length > 0 && FB.chunk.every((c) => c === 7), 'far shell carries its chunk');

console.log('buildings tests passed');
