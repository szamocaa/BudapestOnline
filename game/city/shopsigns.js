// Shop signs on the walls next to OSM shops: vape shops, tobacconists, pharmacies, groceries, bars.
import * as THREE from '../vendor/three.module.min.js';
import { signTexture } from '../textures.js';
import { closestOnSegment } from '../geo.js';

/** Returns { vapeShops, placeOnWall, signMat } (placeOnWall/signMat are reused by other builders). */
export function buildShopSigns(ctx) {
	const signs = new THREE.Group();
	signs.name = 'signs';
	ctx.root.add(signs);
	const signMats = new Map();
	const signMat = (text, style) => {
		const key = text + JSON.stringify(style);
		if (!signMats.has(key)) {
			const mat = new THREE.MeshStandardMaterial({ map: signTexture(text, style), emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.6 });
			mat.emissiveMap = mat.map;
			ctx.night(mat, style.glow || 0.6);
			signMats.set(key, mat);
		}
		return signMats.get(key);
	};
	const signGeo = new THREE.PlaneGeometry(1, 1);
	const placeOnWall = (x, z, width, height, mat, y = 3.3) => {
		// Find the nearest wall and hang the sign on it, facing out.
		let best = null, bestD = 14 * 14;
		for (const s of ctx.walls.near(x, z, 14)) {
			const [cx, cz] = closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz);
			const d = (cx - x) ** 2 + (cz - z) ** 2;
			if (d < bestD) { bestD = d; best = { s, cx, cz }; }
		}
		const mesh = new THREE.Mesh(signGeo, mat);
		mesh.scale.set(width, height, 1);
		if (best) {
			const { s, cx, cz } = best;
			let nx = -(s.bz - s.az), nz = s.bx - s.ax;
			const l = Math.hypot(nx, nz) || 1;
			nx /= l; nz /= l;
			// Point the normal towards where the POI is (outside the building).
			if ((x - cx) * nx + (z - cz) * nz < 0) { nx = -nx; nz = -nz; }
			mesh.position.set(cx + nx * 0.12, y, cz + nz * 0.12);
			mesh.rotation.y = Math.atan2(nx, nz);
		} else {
			mesh.position.set(x, y, z);
		}
		signs.add(mesh);
		return mesh;
	};

	const vapeShops = [];
	for (const p of ctx.data.pois) {
		if (p.kind === 'vape') {
			vapeShops.push(p);
			placeOnWall(p.x, p.z, 3.4, 0.85, signMat(p.name ? p.name.toUpperCase() : 'VAPE SHOP', { bg: '#0b0b12', fg: '#39ff88', border: '#39ff88', glow: 1.6 }));
		} else if (p.kind === 'tobacco') {
			placeOnWall(p.x, p.z, 3.0, 0.8, signMat('NEMZETI DOHÁNYBOLT', { bg: '#5b3a24', fg: '#ffffff', font: 'bold 52px Arial, sans-serif', glow: 0.8 }));
		} else if (p.kind === 'pharmacy') {
			placeOnWall(p.x, p.z, 0.9, 0.9, signMat('✚', { bg: '#0e8a3a', fg: '#ffffff', w: 128, h: 128, font: 'bold 110px Arial', glow: 1.4 }), 4.2);
		} else if (p.kind === 'grocery' || p.kind === 'kiosk') {
			placeOnWall(p.x, p.z, 2.8, 0.7, signMat(p.name || (p.kind === 'kiosk' ? 'TRAFIK' : 'ABC'), { bg: '#1f4e79', fg: '#ffffff', glow: 0.7 }));
		} else if ((p.kind === 'bar' || p.kind === 'food' || p.kind === 'cafe') && p.name) {
			placeOnWall(p.x, p.z, 2.8, 0.7, signMat(p.name, { bg: '#2b1d14', fg: '#ffd08a', glow: 0.9 }));
		}
	}
	return { vapeShops, placeOnWall, signMat };
}
