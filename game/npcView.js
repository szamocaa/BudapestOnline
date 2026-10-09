// Draws the crowd as instanced low-poly people (legs, torso, arms, head, hair) with walking animation.
import * as THREE from './vendor/three.module.min.js';
import { makeLook, STATE } from './crowd.js';

export class CrowdView {
	constructor(scene, crowd, { max = 900, radius = 160 } = {}) {
		this.crowd = crowd;
		this.max = max;
		this.radius = radius;
		this.looks = new Map();
		const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
		const skinMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
		// Unit-sized parts, pivot at the joint (top of limbs) so rotation swings them naturally.
		const leg = new THREE.CylinderGeometry(0.075, 0.06, 1, 6).translate(0, -0.5, 0);
		const arm = new THREE.CylinderGeometry(0.05, 0.045, 1, 6).translate(0, -0.5, 0);
		const torso = new THREE.CylinderGeometry(0.19, 0.16, 1, 8).translate(0, 0.5, 0);
		const head = new THREE.SphereGeometry(0.5, 10, 8);
		const hair = new THREE.SphereGeometry(0.53, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55);
		this.legs = new THREE.InstancedMesh(leg, mat, max * 2);
		this.arms = new THREE.InstancedMesh(arm, mat, max * 2);
		this.torso = new THREE.InstancedMesh(torso, mat, max);
		this.head = new THREE.InstancedMesh(head, skinMat, max);
		this.hair = new THREE.InstancedMesh(hair, mat, max);
		this.parts = [this.legs, this.arms, this.torso, this.head, this.hair];
		for (const p of this.parts) {
			p.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
			p.castShadow = true;
			p.frustumCulled = false;
			p.count = 0;
			scene.add(p);
		}
		this.slotId = new Int32Array(max).fill(-1);
		this.m = new THREE.Matrix4();
		this.q = new THREE.Quaternion();
		this.e = new THREE.Euler();
		this.p = new THREE.Vector3();
		this.s = new THREE.Vector3();
		this.c = new THREE.Color();
		this.visible = [];
	}

	look(id) {
		let l = this.looks.get(id);
		if (!l) {
			l = makeLook(id);
			l.cSkin = new THREE.Color(l.skin);
			l.cHair = new THREE.Color(l.cap ? '#1d2a3a' : l.hair);
			l.cTop = new THREE.Color(l.top);
			l.cBottom = new THREE.Color(l.bottom);
			this.looks.set(id, l);
			if (this.looks.size > 20000) this.looks.delete(this.looks.keys().next().value);
		}
		return l;
	}

	/** Indices of people within the draw radius, nearest first, at most `max`. */
	select(cx, cz) {
		const c = this.crowd, r2 = this.radius * this.radius, out = this.visible;
		out.length = 0;
		for (let i = 0; i < c.n; i++) {
			const d = (c.x[i] - cx) ** 2 + (c.z[i] - cz) ** 2;
			if (d < r2) out.push(i, d);
		}
		if (out.length / 2 <= this.max) return out;
		const pairs = [];
		for (let k = 0; k < out.length; k += 2) pairs.push([out[k], out[k + 1]]);
		pairs.sort((a, b) => a[1] - b[1]);
		out.length = 0;
		for (let k = 0; k < this.max; k++) out.push(pairs[k][0], pairs[k][1]);
		return out;
	}

	update(cx, cz) {
		const c = this.crowd, vis = this.select(cx, cz);
		const n = vis.length / 2;
		const { m, q, e, p, s } = this;
		for (let k = 0; k < n; k++) {
			const i = vis[k * 2];
			const id = c.id[i];
			const L = this.look(id);
			const H = L.height, B = L.build;
			const st = c.state[i];
			const yaw = c.yaw[i];
			const ph = c.phase[i];
			const moving = st === STATE.WALK || st === STATE.FLEE || st === STATE.APPROACH;
			const amp = moving ? (st === STATE.FLEE ? 0.75 : 0.42) : 0;
			const swing = Math.sin(ph * 2.2) * amp;
			const bob = moving ? Math.abs(Math.cos(ph * 2.2)) * 0.03 : 0;
			const down = st === STATE.KNOCKED;
			const x = c.x[i], z = c.z[i];
			const legLen = H * 0.47, torsoLen = H * 0.32, headD = H * 0.13;
			const hipY = legLen + bob;
			const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
			// Local (right, up, forward) -> world, forward = (sin yaw, cos yaw).
			const W = (lx, ly, lz) => p.set(x + lx * cosY + lz * sinY, ly, z - lx * sinY + lz * cosY);

			if (down) {
				// Lying on the ground.
				e.set(Math.PI / 2, yaw, 0, 'YXZ');
				q.setFromEuler(e);
				m.compose(W(0, 0.18, -0.2), q, s.set(B, torsoLen + legLen, B));
				this.torso.setMatrixAt(k, m);
				for (let side = 0; side < 2; side++) {
					m.compose(W(0, -10, 0), q, s.set(0, 0, 0));
					this.legs.setMatrixAt(k * 2 + side, m);
					this.arms.setMatrixAt(k * 2 + side, m);
				}
				m.compose(W(0, 0.15, H * 0.62), q.identity(), s.set(headD, headD, headD));
				this.head.setMatrixAt(k, m);
				this.hair.setMatrixAt(k, m);
			} else {
				const stunned = st === STATE.STUNNED;
				for (let side = 0; side < 2; side++) {
					const sx = side ? 0.1 * B : -0.1 * B;
					e.set(side ? swing : -swing, yaw, 0, 'YXZ');
					q.setFromEuler(e);
					m.compose(W(sx, hipY, 0), q, s.set(B, legLen, B));
					this.legs.setMatrixAt(k * 2 + side, m);
					const ax = side ? 0.23 * B : -0.23 * B;
					// Arms swing opposite to legs; stunned people cover their face.
					const armRot = stunned ? -2.4 : side ? -swing * 0.8 : swing * 0.8;
					e.set(armRot, yaw, side ? -0.06 : 0.06, 'YXZ');
					q.setFromEuler(e);
					m.compose(W(ax, hipY + torsoLen * 0.95, 0), q, s.set(B, H * 0.34, B));
					this.arms.setMatrixAt(k * 2 + side, m);
				}
				e.set(stunned ? 0.35 : 0.04, yaw, 0, 'YXZ');
				q.setFromEuler(e);
				m.compose(W(0, hipY, 0), q, s.set(B, torsoLen, B * 0.8));
				this.torso.setMatrixAt(k, m);
				const headY = hipY + torsoLen + headD * 0.62;
				m.compose(W(0, headY, 0), q, s.set(headD, headD * 1.1, headD));
				this.head.setMatrixAt(k, m);
				const hs = L.longHair ? 1.08 : 1;
				m.compose(W(0, headY + headD * 0.04, L.longHair ? -0.02 : 0), q, s.set(headD * hs, headD * (L.longHair ? 1.25 : 1.05), headD * hs));
				this.hair.setMatrixAt(k, m);
			}

			if (this.slotId[k] !== id) {
				this.slotId[k] = id;
				this.legs.setColorAt(k * 2, L.cBottom);
				this.legs.setColorAt(k * 2 + 1, L.cBottom);
				this.arms.setColorAt(k * 2, L.cTop);
				this.arms.setColorAt(k * 2 + 1, L.cTop);
				this.torso.setColorAt(k, L.cTop);
				this.head.setColorAt(k, L.cSkin);
				this.hair.setColorAt(k, L.cHair);
			}
		}
		this.legs.count = this.arms.count = n * 2;
		this.torso.count = this.head.count = this.hair.count = n;
		for (const part of this.parts) {
			part.instanceMatrix.needsUpdate = true;
			if (part.instanceColor) part.instanceColor.needsUpdate = true;
		}
		return n;
	}
}
