// The street-level M2 entrances (stairs down, canopies, the red "M" signs).
import * as THREE from '../vendor/three.module.min.js';
import { signTexture } from '../textures.js';

/**
 * @param scene     THREE.Scene
 * @param entrances [{ x, z, name, station: 0 (Blaha) | 1 (Keleti), mapped: bool }]
 * @param world     the city (ctx.addSolidBox / addPost for collisions, ctx.night for lit materials)
 * @returns { root, update(frame) }
 */
export function buildEntrances(scene, entrances, world) {
	const root = new THREE.Group();
	root.name = 'metro-entrances';
	scene.add(root);
	const map = signTexture('M', { bg: '#e41f18', fg: '#ffffff', w: 128, h: 128, font: 'bold 100px Arial' });
	const mMat = new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: 0xffffff, emissiveIntensity: 0.4, roughness: 0.5 });
	if (world && world.ctx) world.ctx.night(mMat, 1.2);
	const mGeo = new THREE.BoxGeometry(0.6, 0.6, 0.6);
	const poleMat = new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.6, roughness: 0.4 });
	const poleGeo = new THREE.CylinderGeometry(0.06, 0.06, 3);
	for (const e of entrances) {
		const pole = new THREE.Mesh(poleGeo, poleMat);
		pole.position.set(e.x, 1.5, e.z);
		const cube = new THREE.Mesh(mGeo, mMat);
		cube.position.set(e.x, 3.2, e.z);
		root.add(pole, cube);
	}
	return { root, update() {} };
}
