// Landmarks (Keleti & co.): the stonework kit's pure geometry helpers and the Keleti OSM match.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Parts, orientRing, offsetRing, axes, ellipseArch, balustrade, bounds, inside } from '../../game/city/landmarks/stonework.js';
import keleti from '../../game/city/landmarks/keleti.js';

const finite = (arr) => arr.every((v) => Number.isFinite(v));

// --- window axes: evenly spread, centred, inside the margins
for (const len of [2, 5.5, 9, 23.7, 61]) {
	const ax = axes(len, 4.2, 1.2);
	for (const u of ax) assert.ok(u >= 1.2 - 1e-9 && u <= len - 1.2 + 1e-9, `axis ${u} inside ${len}`);
	if (ax.length) assert.ok(Math.abs((ax[0] + ax[ax.length - 1]) / 2 - len / 2) < 1e-9, 'axes centred');
	for (let i = 1; i < ax.length; i++) assert.ok(ax[i] - ax[i - 1] <= 4.2 + 1e-9, 'pitch not exceeded');
}

// --- rings: orientation is stable, outward offset grows the area
const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
const o1 = orientRing(sq), o2 = orientRing(sq.slice().reverse());
assert.deepEqual(orientRing(o1), o1, 'orientRing is idempotent');
assert.deepEqual(new Set(o1.map(String)), new Set(o2.map(String)), 'same points either way round');
const area = (r) => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a / 2); };
assert.ok(Math.abs(area(offsetRing(o1, 1)) - 144) < 1e-6, 'offset +1 m of a 10 m square is 12 × 12');
assert.ok(Math.abs(area(offsetRing(o1, -1)) - 64) < 1e-6, 'offset -1 m is 8 × 8');
assert.ok(inside(o1, 5, 5) && !inside(o1, 12, 5), 'point in polygon');
assert.deepEqual(bounds([sq]), { x0: 0, x1: 10, z0: 0, z1: 10 }, 'bounds');

// --- arches: points on the ellipse, unit outward normals
const arch = ellipseArch(0, 15, 14, 13.5, 24);
arch.pts.forEach(([x, y], i) => {
	assert.ok(Math.abs((x / 14) ** 2 + ((y - 15) / 13.5) ** 2 - 1) < 1e-9, 'on the ellipse');
	const [nx, ny] = arch.nrm[i];
	assert.ok(Math.abs(Math.hypot(nx, ny) - 1) < 1e-9, 'unit normal');
	assert.ok(nx * x + ny * (y - 15) > 0, 'normal points outwards');
});

// --- Parts: degenerate quads never produce NaN normals (a fan's centre sector collapses to a triangle)
{
	const P = new Parts();
	P.quad([0, 0, 0], [0, 0, 0], [1, 1, 0], [-1, 1, 0]);
	P.quad([0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]); // fully degenerate: skipped
	const b = P.ch.get('solid');
	assert.equal(b.n, 4, 'one quad emitted');
	assert.ok(finite(b.nrm) && finite(b.pos), 'finite normals');
	for (let i = 0; i < b.nrm.length; i += 3) assert.ok(Math.abs(b.nrm[i + 2] - 1) < 1e-9, 'normal faces +z');
}

// --- balustrade: the low-detail baluster is much cheaper than the full lathe
{
	const hi = new Parts(), lo = new Parts();
	balustrade(hi, 0, 10, 0, { spacing: 0.33 });
	balustrade(lo, 0, 10, 0, { spacing: 0.33, low: true });
	assert.ok(lo.tris * 2.5 < hi.tris, `low ${lo.tris} vs high ${hi.tris}`);
}

// --- Keleti replaces exactly the station and its square's mapped blocks
{
	const data = JSON.parse(fs.readFileSync(new URL('../../data/district8.json', import.meta.url), 'utf8'));
	const hit = data.buildings.filter((b) => keleti.match(b));
	assert.ok(hit.some((b) => b.name === 'Keleti pályaudvar'), 'station outline matched');
	assert.ok(hit.length >= 10 && hit.length <= 20, `station parts matched (${hit.length})`);
	for (const b of hit) {
		const [cx, cz] = b.outer.reduce((a, p) => [a[0] + p[0] / b.outer.length, a[1] + p[1] / b.outer.length], [0, 0]);
		assert.ok(cx > -20 && cx < 400 && cz > -960 && cz < -760, `matched block ${b.id} lies on Baross tér / the station`);
	}
}

console.log('landmarks-a tests passed');
