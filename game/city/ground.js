// Ground, parks/squares, carriageways, pavements, kerbs and road markings.
// (Tram tracks and overhead wires live in transit/infra.js.)
import * as THREE from '../vendor/three.module.min.js';
import { MeshBuffer, appendRibbon, appendPolygon } from '../meshing.js';
import { asphaltTexture, pavementTexture, cobbleTexture, grassTexture } from '../textures.js';
import { geometryFrom, offsetLine } from './common.js';

export function buildGround(ctx) {
	const { root, data } = ctx;
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
		} else if (foot) {
			appendRibbon(footBuf, r.pts, r.width, 0.04, 1 / 4, [1, 1, 1], r.width / 2);
		} else {
			const y = 0.05 + (order[r.cls] || 0) * 0.004;
			appendRibbon(roadBuf, r.pts, r.width, y, 1 / 6, [1, 1, 1], r.width / 2);
			// Kerb line on both sides.
			if (r.width >= 6) for (const sideOff of [r.width / 2, -r.width / 2]) appendRibbon(kerbBuf, offsetLine(r.pts, sideOff), 0.3, y + 0.06, 1, [1, 1, 1], 0.15);
			// Dashed centre line on bigger streets.
			if (order[r.cls] >= 3 && !r.oneway) dashed(markBuf, r.pts, 0, 0.15, y + 0.003, 3, 6);
		}
		if (r.cls !== 'cycleway') for (let i = 0; i + 1 < r.pts.length; i++) ctx.streets.add(r.pts[i][0], r.pts[i][1], r.pts[i + 1][0], r.pts[i + 1][1], r);
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
	};
	const flat = [[areaBufs.grass, mats.grass], [areaBufs.plaza, mats.plaza], [areaBufs.asphalt, mats.asphalt], [areaBufs.sand, mats.sand], [areaBufs.water, mats.water],
		[roadBuf, mats.road], [footBuf, mats.foot], [cycleBuf, mats.cycle], [markBuf, mats.mark], [kerbBuf, mats.kerb]];
	for (const [buf, mat] of flat) {
		if (!buf.idx.length) continue;
		const m = new THREE.Mesh(geometryFrom(buf, false), mat);
		m.receiveShadow = true;
		root.add(m);
	}
	return {};
}

export function dashed(buf, pts, offset, width, y, dash, gap) {
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
