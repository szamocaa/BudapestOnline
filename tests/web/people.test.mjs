// People: procedural body mesh, look packing and gait timing (pure logic, no browser).
import assert from 'node:assert/strict';
import { buildPerson, jointSets, PARENT, REGION, GROUP, BODY } from '../../game/people/body.js';
import { packLook, packColor, unpackColor, gait, animOf, STRIDE } from '../../game/people/looks.js';
import { makeLook, STATE, SKIN_TONES } from '../../game/crowd.js';

// Meshes: finite, standing on the ground, about 1.75 m tall, valid bones/regions, budget per LOD.
const budget = [4500, 1500, 400];
const tris = [];
for (const lod of [0, 1, 2]) {
	const m = buildPerson(lod);
	tris.push(m.triangles);
	assert.ok(m.triangles <= budget[lod], `LOD ${lod}: ${m.triangles} triangles`);
	for (let i = 0; i < m.position.length; i++) assert.ok(Number.isFinite(m.position[i]) && Number.isFinite(m.normal[i]) && Number.isFinite(m.fem[i]) && Number.isFinite(m.fat[i]));
	let minY = Infinity, maxY = -Infinity;
	for (let v = 0; v < m.count; v++) {
		const y = m.position[v * 3 + 1];
		const [b0, b1, w, region] = m.skin.subarray(v * 4, v * 4 + 4);
		assert.ok(b0 >= 0 && b0 < 13 && b1 >= 0 && b1 < 13 && w >= 0 && w <= 1 && region >= 0 && region <= REGION.STRAP);
		const group = m.info[v * 4];
		if (group === GROUP.ALWAYS) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
		const nl = Math.hypot(m.normal[v * 3], m.normal[v * 3 + 1], m.normal[v * 3 + 2]);
		assert.ok(Math.abs(nl - 1) < 1e-3, 'unit normals');
	}
	assert.ok(minY > -0.01 && minY < 0.02, `feet on the ground (${minY.toFixed(3)})`);
	assert.ok(maxY > 1.73 && maxY < 1.77, `crown at 1.75 m (${maxY.toFixed(3)})`);
	for (let i = 0; i < m.index.length; i++) assert.ok(m.index[i] < m.count);
}
// Outward normals on the always-visible body: most normals point away from the body axis.
{
	const m = buildPerson(0);
	let out = 0, all = 0;
	for (let v = 0; v < m.count; v++) {
		if (m.info[v * 4] !== GROUP.ALWAYS) continue;
		const x = m.position[v * 3], y = m.position[v * 3 + 1], z = m.position[v * 3 + 2];
		if (y < 0.95 || y > 1.4 || Math.abs(x) > 0.12) continue; // the trunk
		all++;
		if (m.normal[v * 3] * x + m.normal[v * 3 + 2] * z > 0) out++;
	}
	assert.ok(out / all > 0.95, `trunk normals face outwards (${out}/${all})`);
}
// Skeleton: parents come first, joints of all body types are close to each other.
PARENT.forEach((p, i) => assert.ok(p < i));
const J = jointSets();
for (let i = 0; i < 13; i++) for (const k of ['female', 'heavy']) assert.ok(Math.hypot(...J[k][i].map((v, a) => v - J.male[i][a])) < 0.05);
assert.ok(BODY.female.hipW > BODY.male.hipW && BODY.female.shW < BODY.male.shW);

// Colours survive the float packing exactly.
for (const hex of ['#000000', '#ffffff', '#4a2b19', '#a1b2c3']) {
	const f = Math.fround(packColor(hex));
	assert.deepEqual(unpackColor(f), [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)));
}

// Looks: plausible heights and style codes, darker skin tones well represented, varied clothes.
const H = { f: [], m: [] };
let deep = 0, skirts = 0, scarves = 0, phones = 0;
const uppers = new Set(), hairs = new Set();
for (let id = 1; id <= 5000; id++) {
	const L = makeLook(id);
	(L.female ? H.f : H.m).push(L.height);
	const p = packLook(L);
	assert.equal(p.length, 16);
	assert.ok(p[0] > 0.8 && p[0] < 1.15);
	assert.ok(L.hairStyle >= 0 && L.hairStyle <= 6 && L.headwear >= 0 && L.headwear <= 3 && L.upper <= 5 && L.lower <= 3 && L.shoeStyle <= 2);
	if (SKIN_TONES.findIndex((t) => t.hex === L.skin) >= 4) deep++;
	if (L.lower === 2) skirts++;
	if (L.headwear === 3) scarves++;
	if (L.walkStyle === 1 || L.walkStyle === 2) phones++;
	uppers.add(L.upper); hairs.add(L.hairStyle);
	if (L.lower === 2) assert.ok(L.female);
}
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
assert.ok(Math.abs(mean(H.m) - 1.77) < 0.03 && Math.abs(mean(H.f) - 1.64) < 0.03, `mean heights ${mean(H.m).toFixed(3)} / ${mean(H.f).toFixed(3)}`);
assert.ok(deep / 5000 > 0.35, `darker tones ${deep}`);
assert.ok(skirts > 200 && scarves > 20 && phones > 500, `${skirts} skirts, ${scarves} headscarves, ${phones} on the phone`);
assert.equal(uppers.size, 6);
assert.equal(hairs.size, 7);

// Gait: one cycle per stride, so the angle advances 2pi per ~1.35 m at a walk.
assert.equal(animOf(STATE.WALK), 0);
assert.equal(animOf(STATE.FLEE), 2);
assert.equal(animOf(STATE.KNOCKED), 3);
assert.equal(animOf(STATE.IDLE), 1);
const [a0] = gait(0, 1.05, 1, 0), [a1] = gait(1.7 * 1.35 * 0.85 * 0.5, 1.05, 1, 0);
assert.ok(Math.abs(a0) < 1e-9 && Math.abs(a1 - Math.PI) < 1e-6, `half a stride is half a cycle (${a1})`);
const [ar] = gait(1e7 + 0.3, 3.6, 1, 2);
assert.ok(ar >= 0 && ar < Math.PI * 2);
assert.equal(STRIDE, 24);
console.log(`ok people: triangles per LOD ${tris.join(' / ')}, mean height m ${mean(H.m).toFixed(2)} f ${mean(H.f).toFixed(2)}, darker tones ${(deep / 50).toFixed(0)}%`);
