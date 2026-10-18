// Vape sellers: real vape shops from OpenStreetMap get a seller outside, plus street stalls at busy
// spots. Every stall is merged into four shared meshes (structure, glass, printed signs, LED strips),
// so all stalls together cost a handful of draw calls.
//
// A stall: pop-up gazebo (or a parasol), folding table with a cloth, a glass display case full of
// colourful disposable vapes, tent cards with prices in Ft, an A-frame board on the pavement and LED
// strips that glow at night. The seller stands behind the table facing the street.
import * as THREE from './vendor/three.module.min.js';
import { ROLE } from './crowd.js';
import { rng } from './geo.js';

export const VAPE_MENU = [
	{ name: 'Eldobható vape – mangó', price: 3990 },
	{ name: 'Eldobható vape – jeges menta', price: 4290 },
	{ name: 'Eldobható vape – görögdinnye', price: 3990 },
	{ name: 'Liquid 10 ml', price: 2490 },
	{ name: 'Pod készülék', price: 7990 },
];

const ft = (n) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} Ft`;

// ---------------------------------------------------------------- printed signs (one atlas)

const ATLAS = { w: 1024, h: 1024 };
const REGIONS = {
	banner: [0, 0, 1024, 112],
	cloth: [0, 120, 640, 150],
	cards: [0, 280, 256, 150], // four cards side by side
	board: [0, 440, 400, 560],
};

function atlasTexture() {
	const c = document.createElement('canvas');
	c.width = ATLAS.w; c.height = ATLAS.h;
	const g = c.getContext('2d');
	const font = (w, px) => `${w} ${px}px "Helvetica Neue", Arial, sans-serif`;
	// Valance banner: black with neon lettering.
	let [x, y, w, h] = REGIONS.banner;
	g.fillStyle = '#0d0d10'; g.fillRect(x, y, w, h);
	g.textAlign = 'center'; g.textBaseline = 'middle';
	g.font = font(800, 78); g.fillStyle = '#3dffa0'; g.fillText('VAPE', x + 190, y + h / 2 + 3);
	g.font = font(600, 40); g.fillStyle = '#f0f0f0'; g.fillText('ELDOBHATÓ · LIQUID · POD', x + 640, y + h / 2 + 2);
	g.fillStyle = '#ff3fb4'; g.fillRect(x + 340, y + 26, 6, h - 52);
	// Table cloth print.
	[x, y, w, h] = REGIONS.cloth;
	g.fillStyle = '#16121c'; g.fillRect(x, y, w, h);
	g.font = font(800, 92); g.fillStyle = '#ff3fb4'; g.fillText('VAPE', x + 170, y + h / 2 + 4);
	g.font = font(700, 44); g.fillStyle = '#ffffff'; g.fillText(`${ft(3990)}-tól`, x + 470, y + h / 2 + 2);
	// Tent cards with prices.
	const items = [['mangó', 3990, '#ffb020'], ['jeges menta', 4290, '#35c8ff'], ['liquid 10 ml', 2490, '#7ee04a'], ['pod', 7990, '#c77dff']];
	items.forEach(([label, price, col], k) => {
		const [cx, cy, cw, ch] = REGIONS.cards;
		const ox = cx + k * cw;
		g.fillStyle = '#fbfaf6'; g.fillRect(ox + 4, cy + 4, cw - 8, ch - 8);
		g.fillStyle = col; g.fillRect(ox + 4, cy + 4, cw - 8, 26);
		g.fillStyle = '#111'; g.font = font(800, 54); g.fillText(ft(price), ox + cw / 2, cy + 82);
		g.font = font(500, 26); g.fillStyle = '#444'; g.fillText(label, ox + cw / 2, cy + 125);
	});
	// A-frame board (chalkboard menu).
	[x, y, w, h] = REGIONS.board;
	g.fillStyle = '#1b201d'; g.fillRect(x, y, w, h);
	g.strokeStyle = '#c9a76b'; g.lineWidth = 14; g.strokeRect(x + 7, y + 7, w - 14, h - 14);
	g.font = font(800, 92); g.fillStyle = '#3dffa0'; g.fillText('VAPE', x + w / 2, y + 95);
	g.font = font(600, 34); g.fillStyle = '#f4f1e8';
	const lines = [['Eldobható', ft(3990)], ['Jeges menta', ft(4290)], ['Liquid 10 ml', ft(2490)], ['Pod készülék', ft(7990)]];
	lines.forEach(([a, b], k) => {
		g.textAlign = 'left'; g.fillText(a, x + 34, y + 190 + k * 70);
		g.textAlign = 'right'; g.fillStyle = '#ffd25a'; g.fillText(b, x + w - 34, y + 190 + k * 70); g.fillStyle = '#f4f1e8';
	});
	g.textAlign = 'center'; g.font = font(500, 28); g.fillStyle = '#9fd8ff'; g.fillText('Kártyával is fizethetsz', x + w / 2, y + h - 50);
	const t = new THREE.CanvasTexture(c);
	t.colorSpace = THREE.SRGBColorSpace;
	t.anisotropy = 4;
	return t;
}

// ---------------------------------------------------------------- geometry batches

class Batch {
	constructor() { this.p = []; this.n = []; this.c = []; this.uv = []; this.i = []; }
	vert(p, n, c, uv) { this.p.push(...p); this.n.push(...n); this.c.push(...c); this.uv.push(...(uv || [0, 0])); return this.p.length / 3 - 1; }
	geometry() {
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
		g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
		g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
		g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
		g.setIndex(this.i);
		g.computeBoundingSphere();
		return g;
	}
}

const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };

/** Stall-local frame: local +z faces the street; yaw as everywhere (forward = (sin, cos)). */
function frame(x, z, yaw) {
	const c = Math.cos(yaw), s = Math.sin(yaw);
	return {
		p: (lx, ly, lz) => [x + lx * c + lz * s, ly, z - lx * s + lz * c],
		n: (nx, ny, nz) => [nx * c + nz * s, ny, -nx * s + nz * c],
	};
}

/** Axis-aligned (in stall space) box, optionally tilted about its own x axis. */
function box(b, F, [cx, cy, cz], [sx, sy, sz], color, tilt = 0) {
	const col = typeof color === 'string' ? lin(color) : color;
	const ct = Math.cos(tilt), st = Math.sin(tilt);
	const rot = (x, y, z) => [x, y * ct - z * st, y * st + z * ct];
	const faces = [[[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
		[[0, -1, 0], [1, 0, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]];
	for (const [nn, u, v] of faces) {
		const base = b.p.length / 3;
		const nr = F.n(...rot(...nn));
		for (const [a, bb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
			const l = [0, 1, 2].map((k) => (nn[k] + u[k] * a + v[k] * bb) * [sx, sy, sz][k] / 2);
			const r = rot(...l);
			b.vert(F.p(cx + r[0], cy + r[1], cz + r[2]), nr, col);
		}
		b.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
	}
}

/** A flat textured quad facing +z (stall space) unless `back`, using an atlas region. */
function sign(b, F, [cx, cy, cz], w, h, region, { back = false, tilt = 0 } = {}) {
	const [rx, ry, rw, rh] = region;
	const u0 = rx / ATLAS.w, u1 = (rx + rw) / ATLAS.w, v0 = 1 - (ry + rh) / ATLAS.h, v1 = 1 - ry / ATLAS.h;
	const ct = Math.cos(tilt), st = Math.sin(tilt);
	const s = back ? -1 : 1;
	const nr = F.n(0, -st * s, ct * s);
	const base = b.p.length / 3;
	for (const [a, bb, u, v] of [[-1, -1, u0, v0], [1, -1, u1, v0], [1, 1, u1, v1], [-1, 1, u0, v1]]) {
		const lx = (a * w / 2) * s, ly = bb * h / 2;
		b.vert(F.p(cx + lx, cy + ly * ct, cz + ly * st), nr, [1, 1, 1], [u, v]);
	}
	b.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** Pyramid / cone roof (apex up) seen from above and below. */
function roof(b, F, apexY, rimY, corners, color) {
	const col = lin(color), under = col.map((v) => v * 0.6);
	const apex = [0, apexY, 0];
	for (let k = 0; k < corners.length; k++) {
		const a = [corners[k][0], rimY, corners[k][1]], c = [corners[(k + 1) % corners.length][0], rimY, corners[(k + 1) % corners.length][1]];
		const e1 = [a[0] - apex[0], a[1] - apex[1], a[2] - apex[2]], e2 = [c[0] - apex[0], c[1] - apex[1], c[2] - apex[2]];
		let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
		const l = Math.hypot(...n); n = n.map((v) => v / l);
		if (n[1] < 0) n = n.map((v) => -v);
		const top = [apex, a, c], bot = [[0, apexY - 0.015, 0], [a[0], rimY - 0.015, a[2]], [c[0], rimY - 0.015, c[2]]];
		const base = b.p.length / 3;
		for (const p of top) b.vert(F.p(...p), F.n(...n), col);
		for (const p of bot) b.vert(F.p(...p), F.n(0, -1, 0), under);
		// Wind both so their normals face the right way.
		const up = (a[2] * c[0] - a[0] * c[2]) > 0;
		b.i.push(...(up ? [base, base + 1, base + 2, base + 3, base + 5, base + 4] : [base, base + 2, base + 1, base + 3, base + 4, base + 5]));
	}
}

const CANOPY = ['#17181b', '#1e2b24', '#1c2433', '#4a1d22', '#222'];
const CLOTH = ['#14111a', '#1a1d24', '#2b1838', '#0f2a22'];
const DEVICES = ['#ff3f8e', '#35c8ff', '#7ee04a', '#ffb020', '#c77dff', '#ffe14d', '#ff5b3a', '#3df0c8', '#f2f2f2', '#2a6bff'];

function buildStall(B, x, z, yaw, r) {
	const F = frame(x, z, yaw);
	const alu = '#9ea2a8', dark = '#1a1a1c';
	const gazebo = r() < 0.6;
	const canopy = CANOPY[Math.floor(r() * CANOPY.length)], cloth = CLOTH[Math.floor(r() * CLOTH.length)];
	if (gazebo) {
		// Pop-up gazebo 2.0 x 1.6 m: legs, top frame, pyramid roof, valance with a printed banner.
		for (const [lx, lz] of [[-0.98, -0.78], [0.98, -0.78], [0.98, 0.78], [-0.98, 0.78]]) box(B.solid, F, [lx, 1.02, lz], [0.035, 2.04, 0.035], alu);
		box(B.solid, F, [0, 2.03, 0.78], [2.0, 0.03, 0.03], alu); box(B.solid, F, [0, 2.03, -0.78], [2.0, 0.03, 0.03], alu);
		box(B.solid, F, [0.98, 2.03, 0], [0.03, 0.03, 1.6], alu); box(B.solid, F, [-0.98, 2.03, 0], [0.03, 0.03, 1.6], alu);
		roof(B.solid, F, 2.42, 2.05, [[1.02, 0.82], [-1.02, 0.82], [-1.02, -0.82], [1.02, -0.82]], canopy);
		box(B.solid, F, [0, 1.94, -0.815], [2.04, 0.22, 0.006], canopy);
		box(B.solid, F, [1.015, 1.94, 0], [0.006, 0.22, 1.64], canopy); box(B.solid, F, [-1.015, 1.94, 0], [0.006, 0.22, 1.64], canopy);
		box(B.solid, F, [0, 1.94, 0.815], [2.04, 0.22, 0.006], canopy);
		sign(B.signs, F, [0, 1.94, 0.82], 2.0, 0.205, REGIONS.banner);
		sign(B.signs, F, [0, 1.94, -0.82], 2.0, 0.205, REGIONS.banner, { back: true });
		ledStrip(B.led, F, [0, 1.81, 0.77], 1.9);
	} else {
		// Market parasol on a pole behind the table.
		box(B.solid, F, [0, 1.18, -0.38], [0.04, 2.36, 0.04], '#d9d9d9');
		const rim = []; for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; rim.push([Math.cos(a) * 1.25, Math.sin(a) * 1.25 - 0.38]); }
		roof(B.solid, F, 2.38, 2.02, rim.map(([a, c]) => [a, c]).map(([a, c]) => [a, c]), canopy);
		box(B.solid, F, [0, 0.04, -0.38], [0.45, 0.08, 0.45], '#3a3a3a');
	}
	// Folding table with a cloth (front and sides), legs visible at the back.
	box(B.solid, F, [0, 0.745, 0], [1.5, 0.035, 0.6], '#e9e7e1');
	box(B.solid, F, [0, 0.43, 0.303], [1.52, 0.6, 0.006], cloth);
	box(B.solid, F, [0.763, 0.43, 0], [0.006, 0.6, 0.61], cloth); box(B.solid, F, [-0.763, 0.43, 0], [0.006, 0.6, 0.61], cloth);
	for (const lx of [-0.7, 0.7]) box(B.solid, F, [lx, 0.37, -0.26], [0.025, 0.74, 0.025], dark);
	sign(B.signs, F, [0, 0.48, 0.308], 1.0, 0.234, REGIONS.cloth);
	ledStrip(B.led, F, [0, 0.718, 0.305], 1.48);
	// Glass display case with two tiers of devices.
	box(B.solid, F, [0, 0.775, -0.02], [0.92, 0.025, 0.34], dark);
	box(B.solid, F, [0, 0.82, -0.09], [0.9, 0.07, 0.14], '#2b2b30'); // riser for the back row
	for (const [ex, ez] of [[-0.455, 0.145], [0.455, 0.145], [-0.455, -0.185], [0.455, -0.185]]) box(B.solid, F, [ex, 0.925, ez], [0.012, 0.28, 0.012], alu);
	box(B.solid, F, [0, 1.065, 0.145], [0.92, 0.012, 0.012], alu); box(B.solid, F, [0, 1.065, -0.185], [0.92, 0.012, 0.012], alu);
	box(B.glass, F, [0, 0.925, -0.02], [0.9, 0.28, 0.33], '#ffffff');
	for (let row = 0; row < 2; row++) {
		for (let k = 0; k < 13; k++) {
			const lx = -0.39 + k * 0.065, boxed = r() < 0.25;
			const col = DEVICES[Math.floor(r() * DEVICES.length)];
			const y0 = row ? 0.855 : 0.788, lz = row ? -0.09 : 0.07;
			if (boxed) box(B.solid, F, [lx, y0 + 0.05, lz], [0.045, 0.1, 0.03], col);
			else box(B.solid, F, [lx, y0 + 0.048, lz], [0.024, 0.095, 0.016], col);
		}
	}
	// Tent cards and liquid bottles on the table.
	[-0.62, 0.55, 0.66].forEach((lx, k) => {
		const reg = REGIONS.cards; const i = Math.floor(r() * 4);
		sign(B.signs, F, [lx, 0.8, 0.18], 0.11, 0.064, [reg[0] + i * reg[2], reg[1], reg[2], reg[3]], { tilt: -0.35 });
		box(B.solid, F, [lx, 0.795, 0.165], [0.11, 0.004, 0.03], '#dcdcdc', -0.35);
	});
	for (let k = 0; k < 8; k++) box(B.solid, F, [-0.66 + (k % 4) * 0.035, 0.79, -0.05 - Math.floor(k / 4) * 0.04], [0.022, 0.055, 0.022], DEVICES[(k * 3) % DEVICES.length]);
	// A-frame board on the pavement in front, to the left.
	const ax = -1.35, az = 0.85;
	box(B.solid, F, [ax, 0.38, az + 0.12], [0.46, 0.74, 0.018], dark, -0.17);
	box(B.solid, F, [ax, 0.38, az - 0.12], [0.46, 0.74, 0.018], dark, 0.17);
	sign(B.signs, F, [ax, 0.38, az + 0.13], 0.4, 0.56, REGIONS.board, { tilt: -0.17 });
	sign(B.signs, F, [ax, 0.38, az - 0.13], 0.4, 0.56, REGIONS.board, { back: true, tilt: 0.17 });
	return gazebo;
}

/** An LED strip: thin bar whose colour runs from cyan to magenta (unlit material). */
function ledStrip(b, F, [cx, cy, cz], len) {
	const n = 8;
	for (let k = 0; k < n; k++) {
		const t = k / (n - 1);
		const col = [0.25 + 0.75 * t, 0.85 - 0.7 * t, 1.0];
		box(b, F, [cx - len / 2 + (k + 0.5) * len / n, cy, cz], [len / n, 0.012, 0.012], col);
	}
}

// ---------------------------------------------------------------- placement

export function placeVendors(scene, data, graph, crowd, world, { stalls = 14, seed = 4 } = {}) {
	const r = rng(seed);
	const spots = [];
	// 1) Every mapped vape shop.
	for (const p of data.pois) if (p.kind === 'vape') spots.push({ x: p.x, z: p.z, name: p.name || 'Vape shop', shop: true });
	// 2) Stalls on the pavement near busy stops, metro entrances and junctions, at least 110 m apart.
	const candidates = [];
	for (const s of data.stops || []) candidates.push([s.x, s.z]);
	for (const e of data.entrances || []) candidates.push([e.x, e.z]);
	graph.usable.forEach((i) => { if (graph.adj[i].length >= 4) candidates.push(graph.nodes[i]); });
	for (let k = candidates.length - 1; k > 0; k--) {
		const j = Math.floor(r() * (k + 1));
		[candidates[k], candidates[j]] = [candidates[j], candidates[k]];
	}
	for (const [cx, cz] of candidates) {
		if (spots.filter((s) => !s.shop).length >= stalls) break;
		if (spots.some((s) => (s.x - cx) ** 2 + (s.z - cz) ** 2 < 110 * 110)) continue;
		const place = stallPlace(graph, world, cx, cz);
		if (place) spots.push({ ...place, name: 'Vape', shop: false });
	}

	const B = { solid: new Batch(), glass: new Batch(), signs: new Batch(), led: new Batch() };
	const vendors = [];
	for (const s of spots) {
		const node = graph.nearest(s.x, s.z, 80);
		if (node < 0) continue;
		let x = s.x, z = s.z, yaw = s.yaw || 0;
		if (s.shop) [x, z] = world ? world.collide(s.x, s.z, 1.2) : [s.x, s.z];
		else {
			buildStall(B, x, z, yaw, r);
			if (world && world.ctx) {
				world.ctx.addSolidBox(x, z, 1.55, 0.65, yaw);
				const F = frame(x, z, yaw);
				for (const [lx, lz] of [[-0.98, 0.78], [0.98, 0.78]]) { const [px, , pz] = F.p(lx, 0, lz); world.ctx.addPost(px, pz, 0.06); }
			}
		}
		// The seller: behind the stall's table facing the street, or next to the shop door.
		const i = crowd.spawn(ROLE.VENDOR, node);
		if (i >= 0) {
			if (s.shop) { crowd.x[i] = x + 0.9; crowd.z[i] = z + 0.9; crowd.yaw[i] = r() * Math.PI * 2; }
			else { const [px, , pz] = frame(x, z, yaw).p(0.15, 0, -0.55); crowd.x[i] = px; crowd.z[i] = pz; crowd.yaw[i] = yaw; }
		}
		vendors.push({ x, z, yaw, name: s.name, shop: s.shop, id: i >= 0 ? crowd.id[i] : -1 });
	}

	// Four shared meshes for all stalls.
	const tex = typeof document !== 'undefined' ? atlasTexture() : null;
	const solidMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.05 });
	const glassMat = new THREE.MeshStandardMaterial({ color: 0xdfe8ee, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.16, depthWrite: false });
	const signMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0 });
	const ledMat = new THREE.MeshBasicMaterial({ vertexColors: true });
	const meshes = [];
	for (const [b, mat, shadow] of [[B.solid, solidMat, true], [B.glass, glassMat, false], [B.signs, signMat, false], [B.led, ledMat, false]]) {
		if (!b.i.length) continue;
		const m = new THREE.Mesh(b.geometry(), mat);
		m.castShadow = shadow; m.receiveShadow = true;
		m.name = 'vendor-stalls';
		scene.add(m);
		meshes.push(m);
	}
	if (meshes.length) meshes[0].userData.stalls = vendors.filter((v) => !v.shop); // for debugging / screenshots
	if (world && world.ctx) {
		// Signs are backlit a little at night; LEDs go from a faint daytime glow to bright.
		world.ctx.night(signMat, 0.35);
		world.ctx.onNight((k) => { ledMat.color.setScalar(0.7 + 3.3 * k); });
	}
	return vendors;
}

/**
 * A pavement spot for a stall near (x, z): beside the nearest walkable street, beyond the line
 * people walk on, its front facing the street. Null if there is no room.
 */
function stallPlace(graph, world, x, z) {
	const node = graph.nearest(x, z, 60);
	if (node < 0) return null;
	const [nx, nz] = graph.nodes[node];
	for (const e of graph.adj[node]) {
		const [bx, bz] = graph.nodes[e.to];
		const len = Math.hypot(bx - nx, bz - nz);
		if (len < 8 || e.offset < 2) continue; // footpaths and short stubs: no room
		const dx = (bx - nx) / len, dz = (bz - nz) / len;
		for (const side of [1, -1]) {
			// 6 m along the edge (off the junction), 1.5 m beyond the walking line.
			const o = (e.offset + 1.5) * side;
			const px = nx + dx * 6 - dz * o, pz = nz + dz * 6 + dx * o;
			if (!world) return { x: px, z: pz, yaw: Math.atan2(dz * side, -dx * side) };
			const [qx, qz] = world.collide(px, pz, 1.4);
			if (Math.hypot(qx - px, qz - pz) > 0.8) continue;
			// Facing the street centre line: front (+z local) towards -perpendicular.
			return { x: qx, z: qz, yaw: Math.atan2(dz * side, -dx * side) };
		}
	}
	return null;
}

/** Sellers keep shop hours: stalls 9-23, shops 10-21. */
export function vendorOpen(v, hour) {
	return v.shop ? hour >= 10 && hour < 21 : hour >= 9 && hour < 23;
}
