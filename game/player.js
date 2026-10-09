// First-person player: walking, running, mouse look, collisions with buildings, riding vehicles.
import * as THREE from './vendor/three.module.min.js';

export const WALK_SPEED = 1.55; // m/s, a relaxed city walk
export const SPRINT_SPEED = 15; // m/s while holding Shift - unlimited, no stamina

export class Player {
	constructor(camera, dom, world) {
		this.camera = camera;
		this.world = world;
		this.dom = dom;
		this.x = 0;
		this.z = 0;
		this.eye = 1.68;
		this.yaw = 0;
		this.pitch = 0;
		this.vx = 0;
		this.vz = 0;
		this.bob = 0;
		this.health = 100;
		this.money = 20000;
		this.spray = 3;
		this.riding = null; // vehicle key
		this.underground = false;
		this.keys = new Set();
		this.locked = false;
		this.sensitivity = 0.0022;

		window.addEventListener('keydown', (e) => {
			this.keys.add(e.code);
			if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
		});
		window.addEventListener('keyup', (e) => this.keys.delete(e.code));
		window.addEventListener('blur', () => this.keys.clear());
		document.addEventListener('pointerlockchange', () => (this.locked = document.pointerLockElement === dom));
		document.addEventListener('mousemove', (e) => {
			if (!this.locked) return;
			this.yaw -= e.movementX * this.sensitivity;
			this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - e.movementY * this.sensitivity));
		});
		// Touch: drag to look (right half), on-screen stick handled by the HUD sets this.touchMove.
		this.touchMove = { x: 0, y: 0 };
		let lookTouch = null;
		dom.addEventListener('touchstart', (e) => {
			for (const t of e.changedTouches) if (t.clientX > window.innerWidth / 2) lookTouch = { id: t.identifier, x: t.clientX, y: t.clientY };
		}, { passive: true });
		dom.addEventListener('touchmove', (e) => {
			for (const t of e.changedTouches) if (lookTouch && t.identifier === lookTouch.id) {
				this.yaw -= (t.clientX - lookTouch.x) * 0.005;
				this.pitch = Math.max(-1.4, Math.min(1.4, this.pitch - (t.clientY - lookTouch.y) * 0.005));
				lookTouch.x = t.clientX;
				lookTouch.y = t.clientY;
			}
		}, { passive: true });
		dom.addEventListener('touchend', () => (lookTouch = null), { passive: true });
	}

	lock() {
		if (!this.locked && this.dom.requestPointerLock) this.dom.requestPointerLock();
	}

	teleport(x, z, yaw = this.yaw) {
		this.x = x;
		this.z = z;
		this.yaw = yaw;
		this.vx = this.vz = 0;
	}

	update(dt, seat) {
		const k = this.keys;
		if (this.riding) {
			if (seat) {
				this.x = seat.x;
				this.z = seat.z;
				this.camera.position.set(seat.x, seat.y, seat.z);
			}
			this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
			return;
		}
		let fx = 0, fz = 0;
		if (k.has('KeyW') || k.has('ArrowUp')) fz -= 1;
		if (k.has('KeyS') || k.has('ArrowDown')) fz += 1;
		if (k.has('KeyA') || k.has('ArrowLeft')) fx -= 1;
		if (k.has('KeyD') || k.has('ArrowRight')) fx += 1;
		fx += this.touchMove.x;
		fz += this.touchMove.y;
		const len = Math.hypot(fx, fz);
		// Unlimited stamina: you can run as long as you hold Shift.
		const running = (k.has('ShiftLeft') || k.has('ShiftRight')) && len > 0;
		// Sprinting is deliberately superhuman: 15 m/s (54 km/h).
		const speed = (running ? SPRINT_SPEED : WALK_SPEED) * (this.health < 30 ? 0.7 : 1);
		let tx = 0, tz = 0;
		if (len > 0) {
			const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
			// Camera forward is -z rotated by yaw.
			tx = ((fx * c + fz * s) / len) * speed;
			tz = ((-fx * s + fz * c) / len) * speed;
		}
		const a = 1 - Math.exp(-dt * (running ? 6 : 10));
		this.vx += (tx - this.vx) * a;
		this.vz += (tz - this.vz) * a;
		// Move in small steps so even a full-speed sprint can never pass through a wall in one frame.
		const travel = Math.hypot(this.vx, this.vz) * dt;
		const steps = Math.max(1, Math.ceil(travel / 0.2));
		for (let i = 0; i < steps; i++) {
			let nx = this.x + (this.vx * dt) / steps, nz = this.z + (this.vz * dt) / steps;
			if (this.world) [nx, nz] = this.world.collide(nx, nz, 0.35);
			this.x = nx;
			this.z = nz;
		}
		const v = Math.hypot(this.vx, this.vz);
		this.bob += v * dt * 2.1;
		const bobY = v > 0.3 ? Math.sin(this.bob * 2) * 0.035 * Math.min(1, v / 2) : 0;
		if (v > WALK_SPEED * 2) this.bob -= v * dt * 1.2; // longer strides, not a frantic shake
		this.camera.position.set(this.x, this.eye + bobY, this.z);
		this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
		// Widen the view while sprinting for a sense of speed.
		const fov = 70 + 14 * Math.min(1, Math.max(0, (v - WALK_SPEED) / (SPRINT_SPEED - WALK_SPEED)));
		if (Math.abs(this.camera.fov - fov) > 0.05) {
			this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 6);
			this.camera.updateProjectionMatrix();
		}
		this.speed = v;
		this.running = running;
	}

	forward() {
		return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
	}
}
