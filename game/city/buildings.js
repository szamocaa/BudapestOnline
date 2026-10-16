// The city's ordinary buildings (Józsefváros tenements) from OSM footprints.
import * as THREE from '../vendor/three.module.min.js';
import { MeshBuffer, appendWalls, appendRoof, FLOOR_H, BAY_W, GROUND_H, SHOP_BAY_W } from '../meshing.js';
import { facadeTextures, shopfrontTexture, roofTexture } from '../textures.js';
import { rng, hashString } from '../geo.js';
import { geometryFrom, hexToRgb } from './common.js';

// Plaster colours typical of Józsefváros' 19th-century blocks: weathered ochre, cream, grey, brick.
const PLASTERS = ['#d8c7a0', '#cdb27c', '#e0d6c2', '#b9b2a4', '#c9a27a', '#a99c88', '#d4bfa8', '#bfae8f'];
const ROOFS = ['#4a4744', '#5a534c', '#6b4a3a', '#3f4146', '#7a5a46'];
const CHUNK = 250;

function nearestPalette(hex) {
	const c = new THREE.Color(hex);
	let best = 0, bestD = Infinity;
	PLASTERS.forEach((p, i) => {
		const q = new THREE.Color(p);
		const d = (q.r - c.r) ** 2 + (q.g - c.g) ** 2 + (q.b - c.b) ** 2;
		if (d < bestD) { bestD = d; best = i; }
	});
	return best;
}

/** Builds every OSM building not replaced by a landmark. Returns { meshes }. */
export function buildBuildings(ctx) {
	const { root, data } = ctx;
	const facades = PLASTERS.map((p, i) => facadeTextures(100 + i, p));
	const shop = shopfrontTexture(3);
	const roofTex = roofTexture();
	const facadeMats = facades.map((f) => ctx.night(new THREE.MeshStandardMaterial({ map: f.map, emissiveMap: f.emissive, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.88 }), 1.15));
	const shopMat = new THREE.MeshStandardMaterial({ map: shop.map, roughness: 0.85 });
	const roofMat = new THREE.MeshStandardMaterial({ map: roofTex, vertexColors: true, roughness: 0.8, metalness: 0.15 });

	const chunks = new Map();
	const chunkFor = (x, z) => {
		const k = Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK);
		if (!chunks.has(k)) chunks.set(k, { facade: PLASTERS.map(() => new MeshBuffer()), shop: new MeshBuffer(), roof: new MeshBuffer() });
		return chunks.get(k);
	};

	for (const b of data.buildings) {
		if (ctx.suppressed.has(b.id)) continue;
		if (b.hasParts) continue; // its building:part pieces are drawn instead
		const rings = [b.outer, ...(b.holes || [])];
		const r = rng(hashString('b' + b.id));
		const variant = b.colour ? nearestPalette(b.colour) : Math.floor(r() * PLASTERS.length);
		const ch = chunkFor(b.cx, b.cz);
		const h = Math.max(3, b.h);
		const base = b.minH || 0;
		const offU = Math.floor(r() * 8), offV = Math.floor(r() * 8);
		const hasShops = h > 7 && base < 0.5;
		const gTop = hasShops ? GROUND_H : base;
		// Ground floor: shopfronts, gates and shutters.
		if (hasShops) {
			const so = Math.floor(r() * 8);
			appendWalls(ch.shop, [b.outer], 0, GROUND_H, (a, y) => [(a / SHOP_BAY_W + so) / 8, y / GROUND_H]);
			if (b.holes && b.holes.length) appendWalls(ch.facade[variant], b.holes, 0, GROUND_H, (a, y) => [(a / BAY_W + offU) / 8, (y / FLOOR_H + offV) / 8]);
		}
		// Upper floors: one window bay every 3.2 m, one floor every 3.4 m.
		appendWalls(ch.facade[variant], rings, gTop, h, (a, y) => [(a / BAY_W + offU) / 8, ((y - gTop) / FLOOR_H + offV) / 8]);
		const roofColour = hexToRgb(b.roof || ROOFS[Math.floor(r() * ROOFS.length)]);
		appendRoof(ch.roof, rings, h, roofColour, 0.25);
		// Solid walls (only where they reach the street: parts in the air do not block walking).
		if (base < 2) for (const ring of rings) ctx.addSolidRing(ring, b);
	}

	const meshes = [];
	for (const ch of chunks.values()) {
		const add = (buf, mat, withColour) => {
			if (!buf.idx.length) return;
			const m = new THREE.Mesh(geometryFrom(buf, withColour), mat);
			m.castShadow = true;
			m.receiveShadow = true;
			root.add(m);
			meshes.push(m);
		};
		ch.facade.forEach((buf, i) => add(buf, facadeMats[i], false));
		add(ch.shop, shopMat, false);
		add(ch.roof, roofMat, true);
	}
	return { meshes };
}
