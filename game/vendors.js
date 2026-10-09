// Vape sellers: real vape shops from OpenStreetMap get a seller outside, plus street stalls at busy spots.
import * as THREE from './vendor/three.module.min.js';
import { signTexture } from './textures.js';
import { ROLE } from './crowd.js';
import { rng } from './geo.js';

export const VAPE_MENU = [
	{ name: 'Eldobható vape – mangó', price: 3990 },
	{ name: 'Eldobható vape – jeges menta', price: 4290 },
	{ name: 'Eldobható vape – görögdinnye', price: 3990 },
	{ name: 'Liquid 10 ml', price: 2490 },
	{ name: 'Pod készülék', price: 7990 },
];

export function placeVendors(scene, data, graph, crowd, world, { stalls = 14, seed = 4 } = {}) {
	const r = rng(seed);
	const spots = [];
	// 1) Every mapped vape shop.
	for (const p of data.pois) if (p.kind === 'vape') spots.push({ x: p.x, z: p.z, name: p.name || 'Vape shop', shop: true });
	// 2) Stalls near busy junctions and stops, spread out at least 110 m apart.
	const candidates = [];
	for (const s of data.stops || []) candidates.push([s.x, s.z]);
	for (const e of data.entrances || []) candidates.push([e.x, e.z]);
	graph.usable.forEach((i) => { if (graph.adj[i].length >= 4) candidates.push(graph.nodes[i]); });
	for (let k = candidates.length - 1; k > 0; k--) {
		const j = Math.floor(r() * (k + 1));
		[candidates[k], candidates[j]] = [candidates[j], candidates[k]];
	}
	for (const [x, z] of candidates) {
		if (spots.filter((s) => !s.shop).length >= stalls) break;
		if (spots.some((s) => (s.x - x) ** 2 + (s.z - z) ** 2 < 110 * 110)) continue;
		spots.push({ x: x + 3, z: z + 3, name: 'Vape', shop: false });
	}

	const signMat = new THREE.MeshStandardMaterial({ map: signTexture('VAPE', { bg: '#0b0b12', fg: '#39ff88', border: '#39ff88', w: 256, h: 128, font: 'bold 80px Arial' }), emissive: 0xffffff, emissiveIntensity: 0.6 });
	signMat.emissiveMap = signMat.map;
	const tableMat = new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.6 });
	const clothMat = new THREE.MeshStandardMaterial({ color: 0x14532d, roughness: 0.9 });
	const boxMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
	const boxColours = [0xff4fa3, 0x38bdf8, 0xfacc15, 0x34d399, 0xa78bfa];
	const vendors = [];
	for (const s of spots) {
		const node = graph.nearest(s.x, s.z, 80);
		if (node < 0) continue;
		const [x, z] = world ? world.collide(s.x, s.z, 1.2) : [s.x, s.z];
		const g = new THREE.Group();
		g.position.set(x, 0, z);
		if (!s.shop) {
			const table = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.05, 0.7), tableMat);
			table.position.y = 0.85;
			const cloth = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.5, 0.72), clothMat);
			cloth.position.y = 0.6;
			g.add(table, cloth);
			for (let k = 0; k < 8; k++) {
				const box = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.14, 0.05), boxMat.clone());
				box.material.color.setHex(boxColours[k % boxColours.length]);
				box.position.set(-0.55 + k * 0.155, 0.95, (k % 2) * 0.12 - 0.06);
				g.add(box);
			}
			const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.45), signMat);
			sign.position.set(0, 1.25, 0.36);
			const signBack = sign.clone();
			signBack.rotation.y = Math.PI;
			signBack.position.z = -0.36;
			g.add(sign, signBack);
		}
		scene.add(g);
		// The seller stands next to the stall / shop door.
		const i = crowd.spawn(ROLE.VENDOR, node);
		if (i >= 0) {
			crowd.x[i] = x + 0.9;
			crowd.z[i] = z + 0.9;
			crowd.yaw[i] = r() * Math.PI * 2;
		}
		vendors.push({ x, z, name: s.name, shop: s.shop, id: i >= 0 ? crowd.id[i] : -1, group: g });
	}
	return vendors;
}

/** Sellers keep shop hours: stalls 9-23, shops 10-21. */
export function vendorOpen(v, hour) {
	return v.shop ? hour >= 10 && hour < 21 : hour >= 9 && hour < 23;
}
