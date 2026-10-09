import assert from 'node:assert/strict';
import { makeFallbackCity } from '../../game/fallback.js';
import { buildWalkGraph } from '../../game/crowd.js';

const t0 = performance.now();
const d = makeFallbackCity();
const ms = performance.now() - t0;
assert.equal(d.source, 'fallback');
assert.ok(d.buildings.length > 300, `${d.buildings.length} buildings`);
assert.ok(d.roads.length >= 20);
const refs = [...new Set(d.routes.map((r) => r.ref))].sort();
assert.deepEqual(refs, ['23', '24', '28A', '99', 'M2']);
for (const r of d.routes) {
	assert.ok(r.stops.length >= 3, `${r.ref} has stops`);
	for (let i = 1; i < r.stops.length; i++) assert.ok(r.stops[i].s > r.stops[i - 1].s, `${r.ref} stops in order`);
}
assert.ok(d.pois.filter((p) => p.kind === 'vape').length >= 3);
assert.ok(d.entrances.length >= 2);
const g = buildWalkGraph(d.roads);
assert.ok(g.usable.length > 50);
console.log(`ok fallback: ${d.buildings.length} buildings, ${d.roads.length} roads, ${d.routes.length} route directions, graph ${g.usable.length} nodes, built in ${ms.toFixed(0)} ms`);
