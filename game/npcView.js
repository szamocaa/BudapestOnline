// Draws the crowd: procedural humans (game/people/body.js) instanced in three levels of detail and
// posed on the GPU (game/people/shader.js). Per frame only a few numbers per person are uploaded
// (position, yaw, gait angle, state); looks are packed once per person.
//
//   const view = new CrowdView(scene, crowd, { max, radius });
//   view.update(px, pz, frame) -> number of people drawn
//   view.parts                  -> the meshes (the M2 platform lifts them to platform height)
//
// Draw calls: one per level of detail, plus a shadow-only copy of the nearest people (cheaper
// geometry) that is drawn in the shadow maps only: 3 + 2 (two sun cascades) on high.
import * as THREE from './vendor/three.module.min.js';
import { makeLook } from './crowd.js';
import { buildPerson } from './people/body.js';
import { createPeopleMaterial, createPeopleDepthMaterial } from './people/shader.js';
import { STRIDE, packLook, animOf, gait } from './people/looks.js';

// Level-of-detail distances (m) and how many people each level can hold at most.
export const LOD_DIST = [24, 70];
const SHADOW_DIST = 40;

let baseCache = null;
function baseAttributes() {
	if (baseCache) return baseCache;
	baseCache = [0, 1, 2].map((lod) => {
		const m = buildPerson(lod);
		return {
			index: new THREE.BufferAttribute(m.index, 1),
			position: new THREE.BufferAttribute(m.position, 3),
			normal: new THREE.BufferAttribute(m.normal, 3),
			aSkin: new THREE.BufferAttribute(m.skin, 4),
			aInfo: new THREE.BufferAttribute(m.info, 4),
			aFem: new THREE.BufferAttribute(m.fem, 3),
			aFat: new THREE.BufferAttribute(m.fat, 3),
			triangles: m.triangles,
		};
	});
	return baseCache;
}

export class CrowdView {
	constructor(scene, crowd, { max = 900, radius = 160 } = {}) {
		this.crowd = crowd;
		this.max = max;
		this.radius = radius;
		this.looks = new Map();
		this.material = createPeopleMaterial();
		this.depthMaterial = createPeopleDepthMaterial(this.material.userData.uniforms);
		const caps = [Math.min(max, 64), Math.min(max, 320), max];
		this.lods = caps.map((cap, lod) => this.makeBatch(lod, cap, false));
		this.shadow = this.makeBatch(1, Math.min(max, 72), true);
		this.parts = [...this.lods.map((b) => b.mesh), this.shadow.mesh];
		for (const p of this.parts) scene.add(p);
		this.visible = [];
		this.t0 = performance.now();
	}

	makeBatch(lod, cap, shadowOnly) {
		const base = baseAttributes()[lod];
		const geo = new THREE.InstancedBufferGeometry();
		geo.setIndex(base.index);
		for (const k of ['position', 'normal', 'aSkin', 'aInfo', 'aFem', 'aFat']) geo.setAttribute(k, base[k]);
		const arr = new Float32Array(cap * STRIDE);
		const ib = new THREE.InstancedInterleavedBuffer(arr, STRIDE, 1);
		ib.setUsage(THREE.DynamicDrawUsage);
		['iA', 'iB', 'iC', 'iD', 'iE', 'iF'].forEach((name, k) => geo.setAttribute(name, new THREE.InterleavedBufferAttribute(ib, 4, k * 4)));
		geo.instanceCount = 0;
		const mesh = new THREE.Mesh(geo, this.material);
		mesh.name = shadowOnly ? 'people-shadow' : `people-lod${lod}`;
		mesh.frustumCulled = false;
		mesh.castShadow = shadowOnly;
		mesh.receiveShadow = !shadowOnly;
		mesh.customDepthMaterial = this.depthMaterial;
		const batch = { mesh, geo, arr, ib, cap, n: 0, lod };
		if (shadowOnly) {
			// Drawn into the shadow maps only: no instances in the colour pass (no draw call).
			mesh.onBeforeShadow = () => { geo.instanceCount = batch.n; };
			mesh.onAfterShadow = () => { geo.instanceCount = 0; };
		}
		return batch;
	}

	look(id) {
		let l = this.looks.get(id);
		if (!l) {
			const L = makeLook(id);
			l = { packed: packLook(L), hs: L.height / 1.75, seed: ((id * 0.6180339887) % 1 + 1) % 1 };
			this.looks.set(id, l);
			if (this.looks.size > 20000) this.looks.delete(this.looks.keys().next().value);
		}
		return l;
	}

	/** Indices of people within the draw radius, nearest first when there are too many, at most `max`. */
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

	write(batch, i, L) {
		const c = this.crowd, a = batch.arr, o = batch.n++ * STRIDE;
		const anim = animOf(c.state[i]);
		const speed = c.speed ? c.speed[i] : 1.3;
		const [angle, amp] = gait(c.phase[i], speed, L.hs, anim);
		a[o] = c.x[i]; a[o + 1] = 0; a[o + 2] = c.z[i]; a[o + 3] = c.yaw[i];
		a[o + 4] = angle; a[o + 5] = anim; a[o + 6] = amp; a[o + 7] = L.seed;
		a.set(L.packed, o + 8);
	}

	update(cx, cz) {
		const vis = this.select(cx, cz);
		const n = vis.length / 2;
		this.material.userData.uniforms.uPeopleTime.value = ((performance.now() - this.t0) / 1000) % 3600;
		const [b0, b1, b2] = this.lods, sh = this.shadow;
		const d0 = LOD_DIST[0] ** 2, d1 = LOD_DIST[1] ** 2, ds = SHADOW_DIST ** 2;
		b0.n = b1.n = b2.n = sh.n = 0;
		for (let k = 0; k < n; k++) {
			const i = vis[k * 2], d = vis[k * 2 + 1];
			const L = this.look(this.crowd.id[i]);
			let b = d < d0 ? b0 : d < d1 ? b1 : b2;
			if (b === b0 && b0.n >= b0.cap) b = b1;
			if (b === b1 && b1.n >= b1.cap) b = b2;
			if (b.n >= b.cap) continue;
			this.write(b, i, L);
			if (d < ds && sh.n < sh.cap) this.write(sh, i, L);
		}
		for (const b of [b0, b1, b2, sh]) {
			if (b !== sh) b.geo.instanceCount = b.n;
			b.ib.clearUpdateRanges();
			if (b.n) { b.ib.addUpdateRange(0, b.n * STRIDE); b.ib.needsUpdate = true; }
		}
		return n;
	}
}
