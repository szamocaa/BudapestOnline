// Builds the static city (ground, streets, buildings, trees, lamps, signs) from CityData.
import * as THREE from './vendor/three.module.min.js';
import { MeshBuffer, appendWalls, appendRoof, appendRibbon, appendPolygon, FLOOR_H, BAY_W, GROUND_H, SHOP_BAY_W } from './meshing.js';
import { facadeTextures, shopfrontTexture, asphaltTexture, pavementTexture, cobbleTexture, grassTexture, roofTexture, signTexture, glowTexture } from './textures.js';
import { rng, hashString, closestOnSegment } from './geo.js';

// Plaster colours typical of Józsefváros' 19th-century blocks: weathered ochre, cream, grey, brick.
const PLASTERS = ['#d8c7a0', '#cdb27c', '#e0d6c2', '#b9b2a4', '#c9a27a', '#a99c88', '#d4bfa8', '#bfae8f'];
const ROOFS = ['#4a4744', '#5a534c', '#6b4a3a', '#3f4146', '#7a5a46'];
const CHUNK = 250;

function geometryFrom(buf, withColour = true) {
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
	g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nrm, 3));
	g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
	if (withColour) g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
	g.setIndex(buf.idx);
	g.computeBoundingSphere();
	return g;
}

function hexToRgb(hex) {
	const c = new THREE.Color(hex);
	return [c.r, c.g, c.b];
}

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

/** Spatial index over line segments for collision and "what street am I on" queries. */
class SegmentGrid {
	constructor(cell = 20) {
		this.cell = cell;
		this.map = new Map();
	}
	add(ax, az, bx, bz, data) {
		const c = this.cell;
		const seg = { ax, az, bx, bz, data };
		const x0 = Math.floor(Math.min(ax, bx) / c), x1 = Math.floor(Math.max(ax, bx) / c);
		const z0 = Math.floor(Math.min(az, bz) / c), z1 = Math.floor(Math.max(az, bz) / c);
		for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
			const k = x + ',' + z;
			if (!this.map.has(k)) this.map.set(k, []);
			this.map.get(k).push(seg);
		}
	}
	near(x, z, r) {
		const c = this.cell, out = new Set();
		for (let gx = Math.floor((x - r) / c); gx <= Math.floor((x + r) / c); gx++)
			for (let gz = Math.floor((z - r) / c); gz <= Math.floor((z + r) / c); gz++)
				for (const s of this.map.get(gx + ',' + gz) || []) out.add(s);
		return out;
	}
}

export function buildWorld(scene, data, { quality = 'high' } = {}) {
	const root = new THREE.Group();
	root.name = 'city';
	scene.add(root);
	const nightMaterials = [];
	const walls = new SegmentGrid(16);
	const streets = new SegmentGrid(30);

	// ---------------------------------------------------------------- ground
	const pave = pavementTexture();
	pave.repeat.set(2800, 2800);
	const ground = new THREE.Mesh(new THREE.PlaneGeometry(5600, 5600), new THREE.MeshStandardMaterial({ map: pave, color: 0xe6e1d8, roughness: 0.95 }));
	ground.rotation.x = -Math.PI / 2;
	ground.receiveShadow = true;
	root.add(ground);

	// Areas: parks, squares, cemetery, parking.
	const areaBufs = { grass: new MeshBuffer(), plaza: new MeshBuffer(), asphalt: new MeshBuffer(), sand: new MeshBuffer(), water: new MeshBuffer() };
	for (const a of data.areas) {
		const kind = a.kind === 'park' || a.kind === 'grass' || a.kind === 'cemetery' || a.kind === 'pitch' ? 'grass' : a.kind === 'plaza' ? 'plaza' : a.kind === 'parking' ? 'asphalt' : a.kind === 'playground' ? 'sand' : a.kind === 'water' ? 'water' : null;
		if (!kind) continue;
		const y = kind === 'grass' ? 0.03 : kind === 'plaza' ? 0.02 : 0.025;
		appendPolygon(areaBufs[kind], a.outer, a.holes || [], y, kind === 'grass' ? 0.25 : 0.2);
	}

	// Roads: carriageways in asphalt, pavements/footpaths in paving, with lane markings.
	const roadBuf = new MeshBuffer(), footBuf = new MeshBuffer(), cycleBuf = new MeshBuffer(), markBuf = new MeshBuffer(), kerbBuf = new MeshBuffer();
	const order = { service: 0, unclassified: 1, living_street: 1, residential: 2, tertiary: 3, tertiary_link: 3, secondary: 4, secondary_link: 4, primary: 5, primary_link: 5, trunk: 6, motorway: 6 };
	for (const r of data.roads) {
		const foot = r.cls === 'footway' || r.cls === 'path' || r.cls === 'steps' || r.cls === 'pedestrian' || r.cls === 'track';
		if (r.cls === 'cycleway') {
			appendRibbon(cycleBuf, r.pts, r.width, 0.045, 1 / 4, [1, 1, 1], 0.3);
			continue;
		}
		if (foot) {
			appendRibbon(footBuf, r.pts, r.width, 0.04, 1 / 4, [1, 1, 1], r.width / 2);
		} else {
			const y = 0.05 + (order[r.cls] || 0) * 0.004;
			appendRibbon(roadBuf, r.pts, r.width, y, 1 / 6, [1, 1, 1], r.width / 2);
			// Kerb line on both sides.
			if (r.width >= 6) for (const sideOff of [r.width / 2, -r.width / 2]) appendRibbon(kerbBuf, offsetLine(r.pts, sideOff), 0.3, y + 0.06, 1, [1, 1, 1], 0.15);
			// Dashed centre line on bigger streets.
			if (order[r.cls] >= 3 && !r.oneway) dashed(markBuf, r.pts, 0, 0.15, y + 0.003, 3, 6);
		}
		for (let i = 0; i + 1 < r.pts.length; i++) streets.add(r.pts[i][0], r.pts[i][1], r.pts[i + 1][0], r.pts[i + 1][1], r);
	}

	// Tram tracks: concrete bed with two rails (1.435 m gauge).
	const bedBuf = new MeshBuffer(), railBuf = new MeshBuffer();
	for (const rail of data.rails) {
		if (rail.kind !== 'tram') continue;
		appendRibbon(bedBuf, rail.pts, 2.6, 0.075, 1 / 3, [1, 1, 1], 1.3);
		for (const side of [-0.7175, 0.7175]) appendRibbon(railBuf, offsetLine(rail.pts, side), 0.075, 0.095, 1, [1, 1, 1], 0.05);
	}

	const tex = { asphalt: asphaltTexture(), pave, cobble: cobbleTexture(), grass: grassTexture() };
	const mats = {
		road: new THREE.MeshStandardMaterial({ map: tex.asphalt, color: 0x8c8c8c, roughness: 0.92, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
		foot: new THREE.MeshStandardMaterial({ map: tex.pave, color: 0xcfcac0, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
		cycle: new THREE.MeshStandardMaterial({ map: tex.asphalt, color: 0xc06a5a, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }),
		mark: new THREE.MeshStandardMaterial({ color: 0xe8e6df, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
		kerb: new THREE.MeshStandardMaterial({ color: 0xb8b4ab, roughness: 0.85 }),
		grass: new THREE.MeshStandardMaterial({ map: tex.grass, roughness: 1 }),
		plaza: new THREE.MeshStandardMaterial({ map: tex.cobble, color: 0xd8d2c8, roughness: 0.95 }),
		asphalt: new THREE.MeshStandardMaterial({ map: tex.asphalt, color: 0xb8b8b8, roughness: 0.9 }),
		sand: new THREE.MeshStandardMaterial({ color: 0xc8b48a, roughness: 1 }),
		water: new THREE.MeshStandardMaterial({ color: 0x3d6e8c, roughness: 0.15, metalness: 0.1 }),
		bed: new THREE.MeshStandardMaterial({ map: tex.cobble, color: 0x9c968c, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
		rail: new THREE.MeshStandardMaterial({ color: 0x9fa3a8, roughness: 0.35, metalness: 0.85 }),
	};
	const flat = [[areaBufs.grass, mats.grass], [areaBufs.plaza, mats.plaza], [areaBufs.asphalt, mats.asphalt], [areaBufs.sand, mats.sand], [areaBufs.water, mats.water],
		[roadBuf, mats.road], [footBuf, mats.foot], [cycleBuf, mats.cycle], [markBuf, mats.mark], [kerbBuf, mats.kerb], [bedBuf, mats.bed], [railBuf, mats.rail]];
	for (const [buf, mat] of flat) {
		if (!buf.idx.length) continue;
		const m = new THREE.Mesh(geometryFrom(buf, false), mat);
		m.receiveShadow = true;
		root.add(m);
	}

	// ---------------------------------------------------------------- buildings
	const facades = PLASTERS.map((p, i) => facadeTextures(100 + i, p));
	const shop = shopfrontTexture(3);
	const roofTex = roofTexture();
	const facadeMats = facades.map((f) => {
		const m = new THREE.MeshStandardMaterial({ map: f.map, emissiveMap: f.emissive, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.88 });
		nightMaterials.push({ material: m, max: 1.15 });
		return m;
	});
	const shopMat = new THREE.MeshStandardMaterial({ map: shop.map, roughness: 0.85 });
	const roofMat = new THREE.MeshStandardMaterial({ map: roofTex, vertexColors: true, roughness: 0.8, metalness: 0.15 });

	const chunks = new Map();
	const chunkFor = (x, z) => {
		const k = Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK);
		if (!chunks.has(k)) chunks.set(k, { facade: PLASTERS.map(() => new MeshBuffer()), shop: new MeshBuffer(), roof: new MeshBuffer() });
		return chunks.get(k);
	};

	for (const b of data.buildings) {
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
		// Cornice: a slim band just under the roof, slightly proud of the wall.
		for (const ring of rings) {
			for (let i = 0; i < ring.length; i++) walls.add(ring[i][0], ring[i][1], ring[(i + 1) % ring.length][0], ring[(i + 1) % ring.length][1], b);
		}
	}

	const buildingMeshes = [];
	for (const ch of chunks.values()) {
		const add = (buf, mat, withColour) => {
			if (!buf.idx.length) return;
			const m = new THREE.Mesh(geometryFrom(buf, withColour), mat);
			m.castShadow = true;
			m.receiveShadow = true;
			root.add(m);
			buildingMeshes.push(m);
		};
		ch.facade.forEach((buf, i) => add(buf, facadeMats[i], false));
		add(ch.shop, shopMat, false);
		add(ch.roof, roofMat, true);
	}

	// ---------------------------------------------------------------- trees
	const treeR = rng(77);
	const trees = data.trees.slice();
	const treeCount = trees.length;
	if (treeCount) {
		const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.16, 0.24, 3.2, 6), new THREE.MeshStandardMaterial({ color: 0x5a4636, roughness: 1 }), treeCount);
		const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.6, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, flatShading: true }), treeCount);
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
		});
		for (const im of [trunk, crown]) { im.castShadow = true; im.receiveShadow = true; root.add(im); }
	}

	// ---------------------------------------------------------------- street lamps
	// OSM lamps where mapped; otherwise one every ~30 m along streets, alternating sides.
	let lamps = data.lamps.slice();
	if (lamps.length < data.roads.length / 4) lamps = lamps.concat(generateLamps(data.roads, lamps));
	const lampPole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.11, 6.5, 6), new THREE.MeshStandardMaterial({ color: 0x2f3438, roughness: 0.6, metalness: 0.5 }), lamps.length);
	const lampHeadMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffc27a, emissiveIntensity: 0, roughness: 0.4 });
	nightMaterials.push({ material: lampHeadMat, max: 3.5 });
	const lampHead = new THREE.InstancedMesh(new THREE.BoxGeometry(0.55, 0.22, 0.32), lampHeadMat, lamps.length);
	{
		const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
		lamps.forEach(([x, z], i) => {
			m.compose(p.set(x, 3.25, z), q.identity(), s);
			lampPole.setMatrixAt(i, m);
			m.compose(p.set(x, 6.55, z), q, s);
			lampHead.setMatrixAt(i, m);
		});
	}
	lampPole.castShadow = true;
	root.add(lampPole, lampHead);
	// Soft glow sprites around lamp heads at night.
	const glowGeo = new THREE.BufferGeometry();
	glowGeo.setAttribute('position', new THREE.Float32BufferAttribute(lamps.flatMap(([x, z]) => [x, 6.4, z]), 3));
	const glowMat = new THREE.PointsMaterial({ map: glowTexture(), size: 3.2, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, color: 0xffd9a0 });
	const glow = new THREE.Points(glowGeo, glowMat);
	root.add(glow);

	// ---------------------------------------------------------------- signs (shops, stops, metro)
	const signs = new THREE.Group();
	root.add(signs);
	const signMats = new Map();
	const signMat = (text, style) => {
		const key = text + JSON.stringify(style);
		if (!signMats.has(key)) {
			const mat = new THREE.MeshStandardMaterial({ map: signTexture(text, style), emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.6 });
			mat.emissiveMap = mat.map;
			nightMaterials.push({ material: mat, max: style.glow || 0.6 });
			signMats.set(key, mat);
		}
		return signMats.get(key);
	};
	const signGeo = new THREE.PlaneGeometry(1, 1);
	const placeOnWall = (x, z, width, height, mat, y = 3.3) => {
		// Find the nearest wall and hang the sign on it, facing out.
		let best = null, bestD = 14 * 14;
		for (const s of walls.near(x, z, 14)) {
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
	for (const p of data.pois) {
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

	// Metro entrances: the red M2 "M" pylon by each entrance.
	const mGeo = new THREE.BoxGeometry(0.6, 0.6, 0.6);
	const mMat = signMat('M', { bg: '#e41f18', fg: '#ffffff', w: 128, h: 128, font: 'bold 100px Arial', glow: 1.2 });
	const poleMat = new THREE.MeshStandardMaterial({ color: 0x333333, metalness: 0.6, roughness: 0.4 });
	for (const e of data.entrances) {
		const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3), poleMat);
		pole.position.set(e.x, 1.5, e.z);
		const cube = new THREE.Mesh(mGeo, mMat);
		cube.position.set(e.x, 3.2, e.z);
		signs.add(pole, cube);
	}

	// ---------------------------------------------------------------- queries
	function collide(x, z, radius) {
		// Push a circle out of any building wall it overlaps; returns the corrected [x, z].
		for (let pass = 0; pass < 3; pass++) {
			let moved = false;
			for (const s of walls.near(x, z, radius + 1)) {
				const [cx, cz] = closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz);
				const dx = x - cx, dz = z - cz;
				const d = Math.hypot(dx, dz);
				if (d < radius && d > 1e-6) {
					x = cx + (dx / d) * radius;
					z = cz + (dz / d) * radius;
					moved = true;
				}
			}
			if (!moved) break;
		}
		return [x, z];
	}

	function streetAt(x, z) {
		let best = null, bestD = 30 * 30;
		for (const s of streets.near(x, z, 30)) {
			if (!s.data.name) continue;
			const [cx, cz] = closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz);
			const d = (cx - x) ** 2 + (cz - z) ** 2;
			if (d < bestD) { bestD = d; best = s.data.name; }
		}
		return best;
	}

	// Lamps as a grid for "how lit is this spot" (danger) and for picking which lamps get real lights.
	const lampGrid = new Map();
	lamps.forEach(([x, z], i) => {
		const k = Math.floor(x / 25) + ',' + Math.floor(z / 25);
		if (!lampGrid.has(k)) lampGrid.set(k, []);
		lampGrid.get(k).push(i);
	});
	function lampsNear(x, z, r) {
		const out = [];
		for (let gx = Math.floor((x - r) / 25); gx <= Math.floor((x + r) / 25); gx++)
			for (let gz = Math.floor((z - r) / 25); gz <= Math.floor((z + r) / 25); gz++)
				for (const i of lampGrid.get(gx + ',' + gz) || []) {
					const d = (lamps[i][0] - x) ** 2 + (lamps[i][1] - z) ** 2;
					if (d < r * r) out.push([i, d]);
				}
		return out.sort((a, b) => a[1] - b[1]);
	}
	function lightAt(x, z) {
		const near = lampsNear(x, z, 22);
		return near.length ? Math.max(0.15, 1 - Math.sqrt(near[0][1]) / 22) : 0;
	}

	function setNight(k) {
		for (const { material, max } of nightMaterials) material.emissiveIntensity = k * max;
		glowMat.opacity = Math.min(1, k * 1.2);
	}

	return { root, collide, streetAt, lightAt, lampsNear, lamps, setNight, vapeShops, buildingMeshes, wallsNear: (x, z, r) => walls.near(x, z, r) };
}

function offsetLine(pts, d) {
	const out = [];
	for (let i = 0; i < pts.length; i++) {
		const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
		const dx = b[0] - a[0], dz = b[1] - a[1];
		const l = Math.hypot(dx, dz) || 1;
		out.push([pts[i][0] - (dz / l) * d, pts[i][1] + (dx / l) * d]);
	}
	return out;
}

function dashed(buf, pts, offset, width, y, dash, gap) {
	const line = offset ? offsetLine(pts, offset) : pts;
	if (!dash) {
		appendRibbon(buf, line, width, y, 1, [1, 1, 1], 0.05);
		return;
	}
	let carry = 0;
	for (let i = 0; i + 1 < line.length; i++) {
		const [ax, az] = line[i], [bx, bz] = line[i + 1];
		const len = Math.hypot(bx - ax, bz - az);
		for (let s = carry; s < len; s += dash + gap) {
			const e = Math.min(len, s + dash);
			const k0 = s / len, k1 = e / len;
			appendRibbon(buf, [[ax + (bx - ax) * k0, az + (bz - az) * k0], [ax + (bx - ax) * k1, az + (bz - az) * k1]], width, y, 1);
		}
		carry = ((carry - len) % (dash + gap) + (dash + gap)) % (dash + gap);
	}
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
