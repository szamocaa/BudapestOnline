// Fixed tram and bus infrastructure: tram tracks, overhead wires and their poles, stop platforms,
// shelters and signs. Built once the lines are known (BKK or OSM shapes).
import * as THREE from '../vendor/three.module.min.js';
import { MeshBuffer, appendRibbon } from '../meshing.js';
import { cobbleTexture } from '../textures.js';
import { geometryFrom, offsetLine } from '../city/common.js';

/**
 * @param scene   THREE.Scene
 * @param city    CityData (city.rails = OSM tram tracks)
 * @param lines   transit lines [{ ref, mode, directions: [{ headsign, pts, stops: [{ name, s, x, z }] }] }]
 * @param world   the city (collide, ctx.addPost/addSolidBox for solid objects, ctx.night for lit materials)
 * @returns { update(frame) }
 */
export function buildTransitInfra(scene, city, lines, world, { quality = 'high' } = {}) {
	const root = new THREE.Group();
	root.name = 'transit-infra';
	scene.add(root);

	// Tram tracks: concrete bed with two rails (1.435 m gauge).
	const bedBuf = new MeshBuffer(), railBuf = new MeshBuffer();
	for (const rail of city.rails) {
		if (rail.kind !== 'tram') continue;
		appendRibbon(bedBuf, rail.pts, 2.6, 0.075, 1 / 3, [1, 1, 1], 1.3);
		for (const side of [-0.7175, 0.7175]) appendRibbon(railBuf, offsetLine(rail.pts, side), 0.075, 0.095, 1, [1, 1, 1], 0.05);
	}
	const bedMat = new THREE.MeshStandardMaterial({ map: cobbleTexture(), color: 0x9c968c, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
	const railMat = new THREE.MeshStandardMaterial({ color: 0x9fa3a8, roughness: 0.35, metalness: 0.85 });
	for (const [buf, mat] of [[bedBuf, bedMat], [railBuf, railMat]]) {
		if (!buf.idx.length) continue;
		const m = new THREE.Mesh(geometryFrom(buf, false), mat);
		m.receiveShadow = true;
		root.add(m);
	}

	return { root, update() {} };
}
