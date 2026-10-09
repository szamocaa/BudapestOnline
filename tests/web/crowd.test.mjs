import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildWalkGraph, Crowd, makeLook, SKIN_TONES, densityForHour, ROLE, STATE } from '../../game/crowd.js';
import { DangerSystem, dangerForHour, dangerLabel } from '../../game/danger.js';

// A 12 x 12 street grid, 80 m blocks, mixed street classes.
const roads = [];
// Like real OSM ways, crossing streets share a node at every junction.
const along = (f) => Array.from({ length: 13 }, (_, k) => f(k * 80));
for (let i = 0; i <= 12; i++) {
	roads.push({ cls: i % 4 === 0 ? 'secondary' : 'residential', width: i % 4 === 0 ? 13 : 8, name: `Utca ${i}`, pts: along((v) => [i * 80, v]) });
	roads.push({ cls: i % 3 === 0 ? 'footway' : 'tertiary', width: i % 3 === 0 ? 2.5 : 11, name: `Köz ${i}`, pts: along((v) => [v, i * 80]) });
}
roads.push({ cls: 'motorway', width: 18, pts: [[2000, 0], [3000, 0]] }); // not walkable
const g = buildWalkGraph(roads);
assert.equal(g.usable.length, 13 * 13, 'one node per crossing, motorway excluded');
assert.equal(g.nearest(81, 79), g.usable.find((i) => g.nodes[i][0] === 80 && g.nodes[i][1] === 80));

const crowd = new Crowd(g, 5000, 42);
crowd.balance(3000, 3000);
assert.equal(crowd.n, 3000);

// Everyone stays on a pavement next to an edge, with finite positions, through 10 simulated minutes.
const t0 = performance.now();
for (let s = 0; s < 600 * 10; s++) crowd.step(0.1, s * 0.1);
const ms = performance.now() - t0;
for (let i = 0; i < crowd.n; i++) {
	assert.ok(Number.isFinite(crowd.x[i]) && Number.isFinite(crowd.z[i]));
	assert.ok(crowd.x[i] > -20 && crowd.x[i] < 980 && crowd.z[i] > -20 && crowd.z[i] < 980, 'inside the grid');
	assert.ok(crowd.from[i] !== crowd.to[i] || g.adj[crowd.from[i]].length === 0);
}
assert.ok(ms < 20000, `3000 people x 6000 steps took ${ms.toFixed(0)} ms`);

// Fleeing moves people away from a threat.
const tx = 480, tz = 480;
const meanDist = () => { let s = 0, k = 0; for (let i = 0; i < crowd.n; i++) { const d = Math.hypot(crowd.x[i] - tx, crowd.z[i] - tz); if (d < 120) { s += d; k++; } } return [s / k, k]; };
const watched = [];
for (let i = 0; i < crowd.n; i++) if (Math.hypot(crowd.x[i] - tx, crowd.z[i] - tz) < 50) watched.push(crowd.id[i]);
const before = watched.map((id) => { const i = crowd.id.indexOf(id); return Math.hypot(crowd.x[i] - tx, crowd.z[i] - tz); });
crowd.alarm(tx, tz, 20, 1000);
for (let s = 0; s < 100; s++) crowd.step(0.1, 1000 + s * 0.1);
const after = watched.map((id) => { const i = crowd.id.indexOf(id); return Math.hypot(crowd.x[i] - tx, crowd.z[i] - tz); });
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
assert.ok(avg(after) > avg(before) + 10, `fled: ${avg(before).toFixed(1)} -> ${avg(after).toFixed(1)} m`);

// Population follows a target both ways.
crowd.balance(500, 5000);
let walkers = 0; for (let i = 0; i < crowd.n; i++) if (crowd.role[i] !== ROLE.VENDOR) walkers++;
assert.equal(walkers, 500);

// Looks: deterministic per person, full tone range used.
assert.deepEqual(makeLook(17), makeLook(17));
const tones = new Map();
for (let id = 1; id <= 20000; id++) { const s = makeLook(id).skin; tones.set(s, (tones.get(s) || 0) + 1); }
assert.equal(tones.size, SKIN_TONES.length);

// Danger never looks at appearance: the people chosen to cause trouble have the same skin-tone mix as everyone else.
assert.ok(!/makeLook|SKIN_TONES|skin/.test(fs.readFileSync(new URL('../../game/danger.js', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')), 'danger.js must not use looks');
const big = new Crowd(g, 6000, 9);
big.balance(5000, 5000);
const danger = new DangerSystem(big, { seed: 3 });
const chosen = new Map(), population = new Map();
for (let i = 0; i < big.n; i++) { const s = makeLook(big.id[i]).skin; population.set(s, (population.get(s) || 0) + 1); }
let picks = 0;
for (let k = 0; k < 40000; k++) {
	const i = danger.pickNearby(480, 480, 0, 2000);
	const s = makeLook(big.id[i]).skin; chosen.set(s, (chosen.get(s) || 0) + 1); picks++;
}
let chi = 0;
for (const [s, n] of population) { const expected = (n / big.n) * picks; chi += ((chosen.get(s) || 0) - expected) ** 2 / expected; }
assert.ok(chi < 24.3, `chi-square ${chi.toFixed(2)} (7 dof, p=0.001 cut-off 24.3)`);

// Time of day: calm mornings, dangerous nights.
assert.ok(dangerForHour(8) < 0.1 && dangerForHour(14) < 0.15 && dangerForHour(21) > 0.5 && dangerForHour(2) > 0.9);
assert.equal(dangerLabel(dangerForHour(2)).text, 'gatya');
assert.equal(dangerLabel(dangerForHour(9)).text, 'nyugis');
assert.ok(densityForHour(17) === 1 && densityForHour(3) < 0.1);

// Encounters happen at night and play out without errors.
const night = new Crowd(g, 2000, 5);
night.balance(1500, 2000);
const ds = new DangerSystem(night, { seed: 11, lightAt: () => 0 });
const events = [];
const player = { x: 480, z: 480 };
for (let s = 0; s < 36000; s++) {
	night.step(0.1, s * 0.1);
	ds.update(0.1, s * 0.1, 2, player, {
		onEncounter: (e) => { events.push(e.kind); ds.respond(['pay', 'refuse', 'spray', 'punch'][events.length % 4], { onEnd: () => {} }); },
		onPickpocket: () => events.push('pickpocket'),
		onEnd: () => {},
	});
}
assert.ok(events.length >= 5, `night encounters in an hour: ${events.length} (${[...new Set(events)]})`);
const day = new DangerSystem(night, { seed: 11, lightAt: () => 1 });
let dayEvents = 0;
for (let s = 0; s < 36000; s++) day.update(0.1, s * 0.1, 9, player, { onEncounter: () => { dayEvents++; day.respond('refuse', {}); }, onPickpocket: () => dayEvents++, onEnd: () => {} });
assert.ok(dayEvents < events.length / 2, `day ${dayEvents} vs night ${events.length}`);
// Focused population: most people end up near the player, and keep following when the player moves.
const focusCrowd = new Crowd(g, 3000, 21);
const fx = 200, fz = 200, focus = { x: fx, z: fz, r: 250, share: 0.65 };
for (let k = 0; k < 200; k++) { focusCrowd.balance(2000, 50, focus); focusCrowd.step(0.1, k * 0.1); }
const nearCount = (x, z) => { let k = 0; for (let i = 0; i < focusCrowd.n; i++) if ((focusCrowd.x[i] - x) ** 2 + (focusCrowd.z[i] - z) ** 2 < 260 ** 2) k++; return k; };
assert.ok(focusCrowd.n === 2000, `population ${focusCrowd.n}`);
assert.ok(nearCount(fx, fz) > 1100, `near the player: ${nearCount(fx, fz)}`);
const moved = { x: 800, z: 800, r: 250, share: 0.65 };
for (let k = 0; k < 400; k++) { focusCrowd.balance(2000, 50, moved); focusCrowd.step(0.1, 100 + k * 0.1); }
assert.ok(nearCount(800, 800) > 1000, `followed the player: ${nearCount(800, 800)}`);
console.log(`ok crowd/danger: 3000 people x 6000 steps in ${ms.toFixed(0)} ms, flee ${avg(before).toFixed(0)}->${avg(after).toFixed(0)} m, chi2 ${chi.toFixed(1)}, night ${events.length} vs day ${dayEvents} events/hour`);
