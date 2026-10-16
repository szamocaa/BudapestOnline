import assert from 'node:assert/strict';
import { vehicleSignal, pedestrianSignal, axisOf, CYCLE } from '../../game/traffic/signals.js';

assert.equal(axisOf(0), 'A');
assert.equal(axisOf(Math.PI), 'A');
assert.equal(axisOf(Math.PI / 2), 'B');
// Over a full cycle at one junction: the two axes are never green together, and pedestrians
// crossing an axis only walk while that axis has red.
for (let t = 1000; t < 1000 + CYCLE; t += 0.5) {
	const a = vehicleSignal(10, 20, 0, t), b = vehicleSignal(10, 20, Math.PI / 2, t);
	assert.ok(!(a !== 'red' && b !== 'red'), `both axes moving at t=${t}: ${a}/${b}`);
	if (pedestrianSignal(10, 20, 0, t) !== 'red') assert.equal(a, 'red', `pedestrians walk across moving cars at t=${t}`);
}
// Each axis gets green at some point.
const seen = new Set();
for (let t = 0; t < CYCLE; t++) seen.add(vehicleSignal(0, 0, 0, t));
assert.ok(seen.has('green') && seen.has('yellow') && seen.has('red'));
console.log('signals ok');
