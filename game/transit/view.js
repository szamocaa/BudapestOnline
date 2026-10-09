// 3D models for trams and buses, placed every frame from TransitSystem.vehicles.
import * as THREE from '../vendor/three.module.min.js';
import { pointAt } from './schedule.js';
import { signTexture } from '../textures.js';

import { LINE_DEFAULTS } from './schedule.js';

const BODY = {
	tram: { width: 2.3, height: 3.25, floor: 0.4 },
	bus: { width: 2.55, height: 2.95, floor: 0.32 },
};

const shared = {};
function materials() {
	if (shared.ready) return shared;
	shared.ready = true;
	const side = THREE.DoubleSide; // walls are seen from inside while riding
	shared.tram = new THREE.MeshStandardMaterial({ color: 0xf2c400, roughness: 0.45, metalness: 0.15, side });
	shared.tramTatra = new THREE.MeshStandardMaterial({ color: 0xf4c20d, roughness: 0.5, metalness: 0.1, side });
	shared.bus = new THREE.MeshStandardMaterial({ color: 0x0a8fd0, roughness: 0.4, metalness: 0.2, side });
	shared.cream = new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.5, side });
	shared.inner = new THREE.MeshStandardMaterial({ color: 0xc9c6bd, roughness: 0.8, side });
	shared.seat = new THREE.MeshStandardMaterial({ color: 0x3b4a6b, roughness: 0.9 });
	shared.glass = new THREE.MeshStandardMaterial({ color: 0x223040, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.35, depthWrite: false, side, emissive: 0xffe2b0, emissiveIntensity: 0 });
	shared.dark = new THREE.MeshStandardMaterial({ color: 0x222426, roughness: 0.7, side });
	shared.wheel = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
	shared.metal = new THREE.MeshStandardMaterial({ color: 0x7c8186, roughness: 0.4, metalness: 0.8 });
	shared.headlight = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2d0, emissiveIntensity: 0.4 });
	shared.interiorLight = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff6e0, emissiveIntensity: 0.3 });
	shared.box = new THREE.BoxGeometry(1, 1, 1);
	shared.wheelGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.32, 14).rotateZ(Math.PI / 2);
	shared.signs = new Map();
	return shared;
}

function signMaterial(text, bg = '#111111', fg = '#ffb000') {
	const key = text + bg + fg;
	if (!shared.signs.has(key)) {
		const map = signTexture(text, { bg, fg, w: 512, h: 96, font: 'bold 64px "Courier New", monospace' });
		shared.signs.set(key, new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: 0xffffff, emissiveIntensity: 0.9, side: THREE.DoubleSide }));
	}
	return shared.signs.get(key);
}

function part(group, mat, x, y, z, sx, sy, sz, shadow = true) {
	const m = new THREE.Mesh(shared.box, mat);
	m.position.set(x, y, z);
	m.scale.set(sx, sy, sz);
	m.castShadow = shadow;
	group.add(m);
	return m;
}

/**
 * One body section built from panels (so you can look out of the windows from inside).
 * Local frame: forward +z, origin on the ground at the section centre.
 */
function makeSection(mode, len, first, last, ref, headsign, bodyMat) {
	const M = materials();
	const g = new THREE.Group();
	const { width: w, height: h, floor: f } = BODY[mode];
	const sill = f + 1.0, top = f + h * 0.8;
	for (const side of [-1, 1]) {
		const x = side * (w / 2);
		part(g, bodyMat, x, (f + sill) / 2, 0, 0.06, sill - f, len); // lower side panel
		part(g, bodyMat, x, (top + f + h) / 2, 0, 0.06, f + h - top, len); // band above the windows
		part(g, M.glass, x, (sill + top) / 2, 0, 0.03, top - sill, len * 0.96, false); // windows
		for (let z = -len / 2 + 0.7; z <= len / 2 - 0.6; z += 1.5) part(g, bodyMat, x, (sill + top) / 2, z, 0.07, top - sill, 0.1); // window pillars
		if (mode === 'tram') part(g, M.cream, x + side * 0.035, sill - 0.12, 0, 0.02, 0.16, len * 0.98, false);
		// Doors.
		for (const dz of len > 9 ? [-len * 0.28, len * 0.22] : [len * 0.3]) part(g, M.dark, x + side * 0.04, (f + top) / 2, dz, 0.03, top - f - 0.1, 1.25, false);
	}
	part(g, bodyMat, 0, f + h, 0, w + 0.06, 0.08, len); // roof
	part(g, M.inner, 0, f + 0.03, 0, w, 0.06, len, false); // floor
	part(g, M.interiorLight, 0, f + h - 0.06, 0, 0.25, 0.03, len * 0.8, false); // ceiling light strip
	part(g, M.dark, 0, f + h + 0.18, 0, w * 0.85, 0.25, len * 0.7); // roof equipment
	// Seats along the windows.
	for (let z = -len / 2 + 1.4; z < len / 2 - 1; z += 1.6) for (const sx of [-w / 2 + 0.45, w / 2 - 0.45]) part(g, M.seat, sx, f + 0.5, z, 0.5, 0.45, 0.5, false);
	// Running gear.
	if (mode === 'tram') {
		for (const dz of [-len * 0.3, len * 0.3]) part(g, M.dark, 0, f * 0.6, dz, w * 0.8, f * 1.1, 2.2, false);
	} else {
		for (const side of [-1, 1]) for (const dz of first ? [len * 0.3, -len * 0.25] : [-len * 0.3]) {
			const wl = new THREE.Mesh(M.wheelGeo, M.wheel);
			wl.position.set(side * (w / 2 - 0.15), 0.5, dz);
			g.add(wl);
		}
	}
	const sign = signMaterial(`${ref}  ${headsign || ''}`.trim());
	const endWall = (zSign, withSign) => {
		const z = zSign * len / 2;
		part(g, bodyMat, 0, (f + sill) / 2, z, w, sill - f, 0.06);
		part(g, M.glass, 0, (sill + top) / 2, z, w * 0.94, top - sill, 0.03, false);
		part(g, bodyMat, 0, (top + f + h) / 2, z, w, f + h - top, 0.06);
		if (withSign) {
			const s = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.85, 0.32), sign);
			s.position.set(0, f + h * 0.9, z + zSign * 0.04);
			if (zSign < 0) s.rotation.y = Math.PI;
			g.add(s);
			for (const side of [-1, 1]) part(g, M.headlight, side * (w / 2 - 0.35), f + 0.45, z + zSign * 0.04, 0.35, 0.18, 0.04, false);
		}
	};
	if (first) endWall(1, true);
	if (last) endWall(-1, mode === 'tram'); // trams here are bidirectional: sign at both ends
	if (mode === 'tram' && !first && !last) {
		part(g, M.metal, 0, f + h + 0.95, 0, 1.6, 0.06, 0.06);
		const arm = part(g, M.metal, 0, f + h + 0.55, 0, 0.06, 0.06, 1.3);
		arm.rotation.x = 0.6;
	}
	if (first) for (const side of [-1, 1]) {
		const s = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.3), sign);
		s.position.set(side * (w / 2 + 0.05), f + h * 0.88, len * 0.15);
		s.rotation.y = side * Math.PI / 2;
		g.add(s);
	}
	return g;
}

export class VehicleView {
	constructor(scene) {
		this.scene = scene;
		this.models = new Map();
		materials();
	}

	model(v) {
		let m = this.models.get(v.key);
		if (m) return m;
		const mode = v.line.mode === 'tram' ? 'tram' : 'bus';
		const cfg = (LINE_DEFAULTS[v.ref] && LINE_DEFAULTS[v.ref].vehicle) || { sections: mode === 'tram' ? 2 : 1, len: mode === 'tram' ? 13 : 12, gap: 0.5 };
		const bodyMat = mode === 'bus' ? shared.bus : v.ref === '28A' ? shared.tramTatra : shared.tram;
		const group = new THREE.Group();
		const sections = [];
		for (let i = 0; i < cfg.sections; i++) {
			const sec = makeSection(mode, cfg.len, i === 0, i === cfg.sections - 1, v.ref, v.headsign, bodyMat);
			group.add(sec);
			sections.push(sec);
		}
		this.scene.add(group);
		m = { group, sections, spec: { len: cfg.len, gap: cfg.gap, floor: BODY[mode].floor }, seen: 0 };
		this.models.set(v.key, m);
		return m;
	}

	update(vehicles, frame, nightK) {
		for (const v of vehicles) {
			if (v.line.mode === 'metro') continue;
			const m = this.model(v);
			m.seen = frame;
			const { pts, cum } = v.dir;
			const step = m.spec.len + m.spec.gap;
			for (let i = 0; i < m.sections.length; i++) {
				// Each section sits between two points on the route, so the vehicle bends through curves.
				const front = v.s - i * step, back = front - m.spec.len;
				const [fx, fz] = pointAt(pts, cum, Math.max(0, front));
				const [bx, bz] = pointAt(pts, cum, Math.max(0, back));
				const sec = m.sections[i];
				if (v.live && !v.dir) continue;
				sec.position.set((fx + bx) / 2, 0.02, (fz + bz) / 2);
				sec.rotation.y = Math.atan2(fx - bx, fz - bz);
			}
		}
		for (const [key, m] of this.models) {
			if (m.seen !== frame) {
				this.scene.remove(m.group);
				this.models.delete(key);
			}
		}
		shared.glass.emissiveIntensity = nightK * 0.35;
		shared.headlight.emissiveIntensity = 0.4 + nightK * 2;
	}

	/** World transform of a seat in vehicle `key` (for riding). */
	seat(key) {
		const m = this.models.get(key);
		if (!m) return null;
		const s = m.sections[0];
		// A window seat on the right-hand side, a little behind the front door.
		const yaw = s.rotation.y, side = -0.4, back = -1.2;
		return { x: s.position.x + Math.cos(yaw) * side + Math.sin(yaw) * back, z: s.position.z - Math.sin(yaw) * side + Math.cos(yaw) * back, yaw, y: m.spec.floor + 1.45 };
	}
}
