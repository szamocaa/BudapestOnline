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

// --- ring orientation: outer rings and courtyard holes in either winding must give outward walls
// (front faces towards the street / the courtyard, never culled away), for the detail and the shell.
{
	const { pointInPolygon } = await import('../../game/geo.js');
	const { faceNormal } = await import('../../game/city/facadesGeom.js');
	const sq = (x0, z0, x1, z1, cw) => (cw ? [[x0, z0], [x0, z1], [x1, z1], [x1, z0]] : [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]);
	const roads = [[[-20, -6], [60, -6]], [[-20, 46], [60, 46]], [[-6, -20], [-6, 60]], [[46, -20], [46, 60]]].map((pts, i) => ({ id: 50 + i, cls: 'residential', name: 'Kör utca', pts, width: 8 }));
	const triFacing = (Pa, Na, Ia) => {
		let good = 0, bad = 0;
		for (let k = 0; k < Ia.length; k += 3) {
			const a = Ia[k] * 3, b = Ia[k + 1] * 3, c = Ia[k + 2] * 3;
			const ux = Pa[b] - Pa[a], uy = Pa[b + 1] - Pa[a + 1], uz = Pa[b + 2] - Pa[a + 2];
			const vx = Pa[c] - Pa[a], vy = Pa[c + 1] - Pa[a + 1], vz = Pa[c + 2] - Pa[a + 2];
			const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
			const ar = Math.hypot(gx, gy, gz) / 2;
			if (ar < 1e-6) continue;
			const nl = Math.hypot(Na[a], Na[a + 1], Na[a + 2]);
			if ((gx * Na[a] + gy * Na[a + 1] + gz * Na[a + 2]) / (2 * ar * nl) > 0.5) good += ar; else bad += ar;
		}
		return { good, bad };
	};
	for (const outerCW of [false, true]) for (const holeCW of [false, true]) {
		const tag = `outer ${outerCW ? 'cw' : 'ccw'}, hole ${holeCW ? 'cw' : 'ccw'}`;
		const blk = B(100, sq(0, 0, 40, 40, outerCW), { levels: 4, h: 4 * 3.6 + 1, holes: [sq(14, 14, 26, 26, holeCW)] });
		const pl = planBuildings({ buildings: [blk], roads, areas: [], pois: [] });
		const info = pl.infos[0];
		const inside = (x, z) => pointInPolygon(x, z, info.rings[0]) && !pointInPolygon(x, z, info.rings[1]);
		assert.equal(info.segs.filter((s) => s.kind === 'street').length, 4, `${tag}: four street fronts`);
		assert.ok(info.segs.some((s) => s.kind === 'court' && s.ri === 1), `${tag}: courtyard walls`);
		for (const s of info.segs) {
			const mx = (s.ax + s.bx) / 2, mz = (s.az + s.bz) / 2;
			assert.ok(!inside(mx + s.nx * 0.5, mz + s.nz * 0.5) && inside(mx - s.nx * 0.5, mz - s.nz * 0.5), `${tag}: ring ${s.ri} wall normal points out of the building`);
		}
		const o = { opaque: new OpaqueBuf(), glass: new GlassBuf(), rail: new RailBuf(), signs: [] };
		buildDetail(info, o);
		const Pv = o.opaque.P.view(), Nv = o.opaque.N.view(), Iv = o.opaque.I.view();
		const f = triFacing(Pv, Nv, Iv);
		assert.ok(f.bad < f.good * 0.002, `${tag}: detail triangles wound like their normals (bad ${f.bad.toFixed(1)} m²)`);
		// Each wall's plane carries outward-facing plaster over most of its area (windows cut out).
		for (const s of info.segs) {
			let area = 0;
			for (let k = 0; k < Iv.length; k += 3) {
				const a = Iv[k] * 3;
				if (Math.abs(Nv[a] / 127 - s.nx) > 0.02 || Math.abs(Nv[a + 2] / 127 - s.nz) > 0.02) continue;
				let onPlane = true, t = 0;
				for (let q = 0; q < 3; q++) {
					const v = Iv[k + q] * 3;
					const d = (Pv[v] - s.ax) * s.nx + (Pv[v + 2] - s.az) * s.nz;
					t += ((Pv[v] - s.ax) * s.ux + (Pv[v + 2] - s.az) * s.uz) / 3;
					if (Math.abs(d) > 1e-3) onPlane = false;
				}
				if (!onPlane || t < 0 || t > s.len) continue;
				const b = Iv[k + 1] * 3, c = Iv[k + 2] * 3;
				const ux = Pv[b] - Pv[a], uy = Pv[b + 1] - Pv[a + 1], uz = Pv[b + 2] - Pv[a + 2];
				const vx = Pv[c] - Pv[a], vy = Pv[c + 1] - Pv[a + 1], vz = Pv[c + 2] - Pv[a + 2];
				const gx = uy * vz - uz * vy, gz = ux * vy - uy * vx;
				area += (gx * s.nx + gz * s.nz) / 2; // signed: inward-wound faces subtract
			}
			const full = s.len * (info.wallTop - info.base);
			assert.ok(area > full * 0.4, `${tag}: ring ${s.ri} wall has outward plaster (${area.toFixed(0)} of ${full.toFixed(0)} m²)`);
		}
		const G = o.glass;
		for (let k = 0; k < G.idx.length; k += 3) {
			const a = G.idx[k] * 3, b = G.idx[k + 1] * 3, c = G.idx[k + 2] * 3, p = G.pos;
			const gx = (p[b + 1] - p[a + 1]) * (p[c + 2] - p[a + 2]) - (p[b + 2] - p[a + 2]) * (p[c + 1] - p[a + 1]);
			const gz = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
			assert.ok(gx * G.nrm[a] + gz * G.nrm[a + 2] > 0, `${tag}: glass faces out`);
		}
		const fb = new FarBuf();
		buildFar(info, fb, 0);
		const ff = triFacing(fb.pos, fb.nrm, fb.idx);
		assert.ok(ff.bad < ff.good * 0.002, `${tag}: far shell wound like its normals`);
	}
	assert.deepEqual(faceNormal([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]).map(Math.round), [0, 0, 1]);
	assert.deepEqual(faceNormal([[0, 0, 0], [1e-7, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]).map(Math.round), [0, 0, 1], 'Newell normal survives a degenerate first corner');
}

console.log('buildings tests passed');
