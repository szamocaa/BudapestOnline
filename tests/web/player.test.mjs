import assert from 'node:assert/strict';

// Minimal browser stubs: the player only needs event listeners.
const listeners = {};
globalThis.window = { innerWidth: 800, addEventListener: (t, f) => ((listeners[t] ||= []).push(f)) };
globalThis.document = { addEventListener() {}, pointerLockElement: null };
const press = (type, code, repeat = false) => listeners[type].forEach((f) => f({ code, repeat, preventDefault() {} }));

const THREE = await import('../../game/vendor/three.module.min.js');
const { Player, JUMP_HEIGHT, SPRINT_SPEED } = await import('../../game/player.js');
const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);
const dom = { addEventListener() {} };
const p = new Player(camera, dom, { collide: (x, z) => [x, z] });
const run = (seconds, dt = 1 / 60) => { let peak = 0; for (let t = 0; t < seconds; t += dt) { p.update(dt); peak = Math.max(peak, p.y); } return peak; };

// Standing still: stays on the ground at eye height.
run(0.5);
assert.equal(p.y, 0);
assert.ok(Math.abs(camera.position.y - p.eye) < 1e-9);

// A tap that starts and ends between two frames still jumps, to about JUMP_HEIGHT, and lands.
press('keydown', 'Space');
press('keyup', 'Space');
const peak = run(1.2);
assert.ok(Math.abs(peak - JUMP_HEIGHT) < 0.08, `peak ${peak}`);
assert.equal(p.y, 0);
assert.ok(p.onGround);

// Key auto-repeat while held does not queue extra jumps; holding Space keeps hopping.
press('keydown', 'Space');
let hops = 0, was = true;
for (let t = 0; t < 3; t += 1 / 60) { p.update(1 / 60); if (was && !p.onGround) hops++; was = p.onGround; press('keydown', 'Space', true); }
press('keyup', 'Space');
assert.ok(hops >= 3 && hops <= 6, `${hops} hops in 3 s`);
run(1.5);
assert.ok(p.onGround && p.y === 0);

// Jumping while sprinting keeps the horizontal speed.
press('keydown', 'KeyW'); press('keydown', 'ShiftLeft');
run(2);
press('keydown', 'Space'); press('keyup', 'Space');
p.update(1 / 60);
assert.ok(!p.onGround);
run(0.3);
assert.ok(p.speed > SPRINT_SPEED * 0.95, `air speed ${p.speed}`);
press('keyup', 'KeyW'); press('keyup', 'ShiftLeft');

// Low frame rate (dt clamped to 0.1 s in main.js) still lands cleanly on the ground.
press('keydown', 'Space'); press('keyup', 'Space');
const slowPeak = run(1.5, 0.1);
assert.ok(slowPeak > 0.8 && slowPeak < 1.3, `slow peak ${slowPeak}`);
assert.equal(p.y, 0);

// Riding a vehicle or teleporting cancels a pending jump.
press('keydown', 'Space'); press('keyup', 'Space');
p.teleport(10, 10);
p.update(1 / 60);
assert.ok(p.onGround && p.y === 0);

console.log('player ok');
