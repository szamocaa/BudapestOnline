// Street-level objects: trees, street lamps (and the real lights near the player at night), and
// street furniture. Everything here is instanced.
import * as THREE from '../vendor/three.module.min.js';
import { glowTexture } from '../textures.js';
import { rng } from '../geo.js';

const LAMP_Y = 6.4; // height of the light source

/** Returns { lamps } where lamps = [{ x, z, y, kind }]. */
export function buildProps(ctx) {
	const { root, data } = ctx;

	// ---------------------------------------------------------------- trees
	const treeR = rng(77);
	const trees = data.trees.slice();
	if (trees.length) {
		const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.16, 0.24, 3.2, 6), new THREE.MeshStandardMaterial({ color: 0x5a4636, roughness: 1 }), trees.length);
		const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.6, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true }), trees.length);
		const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
		trees.forEach(([x, z], i) => {
			const k = 0.8 + treeR() * 0.6;
			m.compose(p.set(x, 1.6 * k, z), q.identity(), s.set(k, k, k));
			trunk.setMatrixAt(i, m);
			q.setFromEuler(new THREE.Euler(0, treeR() * 6.28, 0));
			m.compose(p.set(x, 4.6 * k, z), q, s.set(k * (0.9 + treeR() * 0.3), k * (0.8 + treeR() * 0.4), k * (0.9 + treeR() * 0.3)));
			crown.setMatrixAt(i, m);
			col.setHSL(0.24 + treeR() * 0.06, 0.38 + treeR() * 0.2, 0.22 + treeR() * 0.1);
			crown.setColorAt(i, col);
			ctx.addPost(x, z, 0.3, 'tree');
		});
		for (const im of [trunk, crown]) { im.castShadow = true; im.receiveShadow = true; root.add(im); }
	}

	// ---------------------------------------------------------------- street lamps
	// OSM lamps where mapped; otherwise one every ~30 m along streets, alternating sides.
	let spots = data.lamps.slice();
	if (spots.length < data.roads.length / 4) spots = spots.concat(generateLamps(data.roads, spots));
	const lamps = spots.map(([x, z]) => ({ x, z, y: LAMP_Y, kind: 'pole' }));
	const lampPole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.11, 6.5, 6), new THREE.MeshStandardMaterial({ color: 0x2f3438, roughness: 0.6, metalness: 0.5 }), lamps.length);
	const lampHeadMat = ctx.night(new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffc27a, emissiveIntensity: 0, roughness: 0.4 }), 3.5);
	const lampHead = new THREE.InstancedMesh(new THREE.BoxGeometry(0.55, 0.22, 0.32), lampHeadMat, lamps.length);
	{
		const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
		lamps.forEach(({ x, z }, i) => {
			m.compose(p.set(x, 3.25, z), q.identity(), s);
			lampPole.setMatrixAt(i, m);
			m.compose(p.set(x, 6.55, z), q, s);
			lampHead.setMatrixAt(i, m);
			ctx.addPost(x, z, 0.15, 'lamp');
		});
	}
	lampPole.castShadow = true;
	root.add(lampPole, lampHead);
	// Soft glow sprites around lamp heads at night.
	const glowGeo = new THREE.BufferGeometry();
	glowGeo.setAttribute('position', new THREE.Float32BufferAttribute(lamps.flatMap(({ x, z }) => [x, LAMP_Y, z]), 3));
	const glowMat = new THREE.PointsMaterial({ map: glowTexture(), size: 3.2, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, color: 0xffd9a0 });
	root.add(new THREE.Points(glowGeo, glowMat));
	ctx.onNight((k) => (glowMat.opacity = Math.min(1, k * 1.2)));
	ctx.lamps.push(...lamps);

	// Real lights on the lamps nearest the player at night (the rest only glow).
	const lights = [];
	for (let i = 0; i < (ctx.quality === 'low' ? 4 : 10); i++) {
		const l = new THREE.PointLight(0xffc27a, 0, 30, 1.6);
		root.add(l);
		lights.push(l);
	}
	let timer = 0;
	ctx.onUpdate((frame) => {
		timer -= frame.dt;
		if (timer > 0) return;
		timer = 0.4;
		const night = frame.sky.night;
		const near = frame.world.lampsNear(frame.player.x, frame.player.z, 70);
		lights.forEach((l, i) => {
			const e = near[i];
			if (e && night > 0.05) {
				const lamp = e[0];
				l.position.set(lamp.x, lamp.y - 0.2, lamp.z);
				l.intensity = 60 * night;
			} else l.intensity = 0;
		});
	});

	return { lamps };
}

function generateLamps(roads, existing) {
	const out = [];
	const taken = new Set(existing.map(([x, z]) => Math.floor(x / 12) + ',' + Math.floor(z / 12)));
	for (const r of roads) {
		if (!['primary', 'secondary', 'tertiary', 'residential', 'living_street', 'unclassified', 'pedestrian'].includes(r.cls)) continue;
		let side = 1, acc = 0;
		for (let i = 0; i + 1 < r.pts.length; i++) {
			const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
			const len = Math.hypot(bx - ax, bz - az);
			if (len < 0.1) continue;
			const ux = (bx - ax) / len, uz = (bz - az) / len;
			for (let s = 30 - acc; s < len; s += 30) {
				const off = (r.width / 2 + 0.6) * side;
				const x = ax + ux * s - uz * off, z = az + uz * s + ux * off;
				const k = Math.floor(x / 12) + ',' + Math.floor(z / 12);
				if (!taken.has(k)) { taken.add(k); out.push([x, z]); }
				side = -side;
			}
			acc = (acc + len) % 30;
		}
	}
	return out;
}
