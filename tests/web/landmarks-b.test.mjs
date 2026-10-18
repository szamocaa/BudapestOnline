// Unit tests for the pure helpers of the landmarks-b models (no browser needed).
import assert from 'node:assert/strict';
import { splitStage, chainFront, signPieces } from '../../game/city/landmarks/erkel.js';
import { hallFrame } from '../../game/city/landmarks/vasarcsarnok.js';
import { gatePlan } from '../../game/city/landmarks/kerepesi.js';
import { simplifyRing, offsetRing, edgeNormals, Frame } from '../../game/city/landmarks/b-kit.js';

// Frame round trip.
{
	const f = new Frame(10, -5, 0.7);
	const [x, , z] = f.p(3, 0, -2);
	const [lx, lz] = f.local(x, z);
	assert.ok(Math.abs(lx - 3) < 1e-9 && Math.abs(lz + 2) < 1e-9);
	const [dx, , dz] = f.d(0, 0, 1);
	assert.ok(Math.abs(dx - Math.sin(0.7)) < 1e-9 && Math.abs(dz - Math.cos(0.7)) < 1e-9);
}

// Edge normals point outwards whatever the winding; offsetRing grows the ring.
{
	const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
	for (const ring of [sq, [...sq].reverse()]) {
		const ns = edgeNormals(ring);
		ring.forEach((p, i) => {
			const q = ring[(i + 1) % ring.length];
			const mx = (p[0] + q[0]) / 2 + ns[i][0], mz = (p[1] + q[1]) / 2 + ns[i][1];
			assert.ok(mx < 0 || mx > 10 || mz < 0 || mz > 10, 'normal points out');
		});
		const big = offsetRing(ring, 1);
		assert.ok(big.every(([x, z]) => x < 0.01 || x > 9.99 || z < 0.01 || z > 9.99));
		assert.ok(big.some(([x]) => x < -0.9));
	}
	assert.equal(simplifyRing([[0, 0], [5, 0.05], [10, 0], [10, 10], [0, 10]]).length, 4);
}

// Erkel: the stage block is the run of three long edges; the rest keeps the other points.
{
	const ring = [[0, 0], [20, 0], [20, 10], [35, 40], [0, 75], [-35, 40], [-20, 10], [-20, 0]].map(([x, z]) => [x, -z]);
	const { stage, rest } = splitStage(ring);
	assert.equal(stage.length, 4);
	assert.equal(rest.length, ring.length - 2);
	assert.equal(splitStage([[0, 0], [5, 0], [5, 5], [0, 5]]).stage, null);
}

// Erkel: a curved front is chained in reading order and the sign spans it without gaps.
{
	const segs = [0, 1, 2].map((i) => ({ i, length: 10, withRing: false, frame: null }));
	const { list, total } = chainFront(segs, 10);
	assert.equal(total, 30);
	assert.deepEqual(list.map((e) => e.seg.i), [2, 1, 0]);
	// Wrap-around: indices 9, 0, 1 of a 10-edge ring chain as 9 → 0 → 1.
	const wrap = chainFront([0, 1, 9].map((i) => ({ i, length: 5, withRing: true })), 10);
	assert.deepEqual(wrap.list.map((e) => e.seg.i), [9, 0, 1]);
	const pieces = signPieces(list, 5, 25);
	assert.equal(pieces.length, 3);
	assert.ok(Math.abs(pieces[0].u0) < 1e-9 && Math.abs(pieces[2].u1 - 1) < 1e-9);
	for (let k = 1; k < pieces.length; k++) assert.ok(Math.abs(pieces[k].u0 - pieces[k - 1].u1) < 1e-9);
	assert.ok(Math.abs(pieces[0].x0 - 5) < 1e-9 && Math.abs(pieces[2].x1 - 5) < 1e-9);
}

// Market hall: the main front is the westward edge and the frame looks out of it.
{
	const yaw = 0.35, F = new Frame(-500, -50, yaw);
	const ring = [[-36, -35], [36, -35], [36, 35], [-36, 35]].map(([x, z]) => { const [wx, , wz] = F.p(x, 0, z); return [wx, wz]; });
	const { frame, w, d } = hallFrame(ring);
	const [dx] = frame.d(0, 0, 1);
	assert.ok(dx < -0.9, 'front faces west');
	assert.ok(Math.abs(w - 70) < 1e-6 && Math.abs(d - 72) < 1e-6);
}

// Kerepesi: the gate plan is symmetric and fits the given opening.
{
	const p = gatePlan(30);
	assert.ok(p.piers.length >= 2);
	const xs = p.piers.map((q) => q.x);
	assert.ok(Math.abs(xs[0] + xs[xs.length - 1]) < 1e-9, 'symmetric');
	assert.ok(Math.max(...xs.map(Math.abs)) <= 15);
}

console.log('landmarks-b tests passed');
