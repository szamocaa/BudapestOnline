// Rákóczi téri Vásárcsarnok (Rákóczi tér 7–9): one of the five district market halls the city built
// in 1897 (Rozinay István, Klunzinger Pál), burnt out in 1988 and rebuilt in 1991. Modelled as
// the sister halls look: red brick walls with cream stone dressings, a cross-shaped high nave with
// grey metal gable roofs over lower aisles, and on every arm a brick gable with a huge iron-framed
// lunette window over three arched doorways. The main front faces the square (west); its gable
// carries the "VÁSÁRCSARNOK" inscription. Walls follow the OSM footprint (corner pavilions included).
import * as THREE from '../../vendor/three.module.min.js';
import { Mesher, Frame, facades, edgeNormals, simplifyRing, finish, rgb, shade, windowAt } from './b-kit.js';
import { signTex, CELL, cellUV } from './b-tex.js';

const BRICK = rgb('#b4553c'), DRESS = rgb('#e2d5b5'), PLINTH = rgb('#8d8478'), ROOF = rgb('#7d8388'), IRON = rgb('#2f3433');
const AISLE = 8.6; // aisle wall top (main cornice)
const EAVE = 13.4; // nave eaves
const RIDGE = 18.6; // nave ridge
const NAVE = 22; // nave width

/**
 * The hall's frame: centre of the footprint's extent, local +z out of the main front (the edge
 * facing furthest west, towards Rákóczi tér), and the local extents. Pure (testable).
 */
export function hallFrame(ring) {
	const ns = edgeNormals(ring);
	let best = -1, score = Infinity;
	ring.forEach((p, i) => {
		const q = ring[(i + 1) % ring.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
		const s = ns[i][0] * Math.min(L, 30); // most westward, long edges first
		if (L > 8 && s < score) { score = s; best = i; }
	});
	const [nx, nz] = ns[Math.max(0, best)];
	const yaw = Math.atan2(nx, nz);
	const f0 = new Frame(0, 0, yaw);
	let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
	for (const [x, z] of ring) {
		const [lx, lz] = f0.local(x, z);
		x0 = Math.min(x0, lx); x1 = Math.max(x1, lx); z0 = Math.min(z0, lz); z1 = Math.max(z1, lz);
	}
	const [cx, , cz] = f0.p((x0 + x1) / 2, 0, (z0 + z1) / 2);
	return { frame: new Frame(cx, cz, yaw), w: x1 - x0, d: z1 - z0, front: best };
}

export default {
	id: 'vasarcsarnok',
	name: 'Rákóczi téri Vásárcsarnok',
	lat: 47.49234,
	lon: 19.07343,
	match: (b) => b.name === 'Rákóczi téri Vásárcsarnok' || (b.tags && b.tags.wikidata === 'Q3115168'),
	build(ctx, site) {
		const b = site.buildings[0];
		if (!b) return;
		const ring = simplifyRing(b.outer, 0.4);
		const { frame: G, w: W, d: D, front } = hallFrame(ring);
		const m = new Mesher();
		m.flood = (x, y, z, nx, ny) => (ny > 0.5 ? 0 : Math.max(0, 1 - y / 20) * 0.35);

		// ------------------------------------------------------------- aisle walls (footprint)
		m.tint = BRICK;
		m.walls('brick', ring, 0.9, AISLE);
		m.tint = PLINTH;
		m.sweep('stone', ring, [[0.18, 0], [0.18, 0.9], [0.06, 1.0], [0, 1.0]]);
		m.tint = DRESS;
		m.sweep('stone', ring, [[0, 4.75], [0.12, 4.8], [0.12, 5.05], [0, 5.1]]); // impost band
		m.sweep('stone', ring, [[0, AISLE - 0.7], [0.12, AISLE - 0.6], [0.4, AISLE - 0.3], [0.4, AISLE], [0.1, AISLE], [0.1, AISLE + 0.6], [-0.2, AISLE + 0.6]]);
		m.tint = shade(ROOF, 0.75);
		m.cap('metal', ring, AISLE + 0.3);

		// ------------------------------------------------------------- cross-shaped high nave
		const hx = W / 2, hz = D / 2, n2 = NAVE / 2;
		m.tint = BRICK;
		m.box('brick', G, -n2, AISLE, -hz, n2, EAVE, hz, { top: false }); // nave along the depth
		m.box('brick', G, -hx, AISLE, -n2, hx, EAVE, n2, { top: false }); // transept
		m.tint = DRESS;
		m.box('stone', G, -n2 - 0.3, EAVE - 0.35, -hz + 0.01, n2 + 0.3, EAVE, hz - 0.01, { top: false, skip: 'fb' });
		m.box('stone', G, -hx + 0.01, EAVE - 0.35, -n2 - 0.3, hx - 0.01, EAVE, n2 + 0.3, { top: false, skip: 'lr' });
		m.tint = ROOF;
		const roofOpts = { hip: 0, overhang: 0.45, wallKey: 'brick', wallCol: BRICK };
		m.roof('metal', G, -n2, -hz, n2, hz, EAVE, RIDGE - EAVE, { ...roofOpts, alongX: false });
		m.roof('metal', G, -hx, -n2, hx, n2, EAVE, RIDGE - EAVE, { ...roofOpts, alongX: true });
		// Glazed ridge lanterns (the 1991 roof lets daylight into the hall).
		m.tint = IRON;
		m.box('iron', G, -1.3, RIDGE - 0.25, -hz + 4, 1.3, RIDGE + 0.9, -n2 - 2);
		m.box('iron', G, -1.3, RIDGE - 0.25, n2 + 2, 1.3, RIDGE + 0.9, hz - 4);
		for (const s of [-1, 1]) {
			const L = G.sub(s * 1.31, 0, 0, s * Math.PI / 2);
			m.panel('detail', L, -hz + 4, RIDGE - 0.1, -n2 - 2, RIDGE + 0.8, 0.0, CELL.darkGlass);
			m.panel('detail', L, n2 + 2, RIDGE - 0.1, hz - 4, RIDGE + 0.8, 0.0, CELL.darkGlass);
		}
		// Clerestory: arched windows in the nave walls above the aisle roofs.
		const clere = (F, from, to) => {
			const n = Math.floor((to - from) / 3.6);
			for (let k = 0; k < n; k++) {
				const x = from + (to - from) * ((k + 0.5) / n);
				windowAt(m, F, x, AISLE + 1.1, 1.5, 3.0, { cell: CELL.arched, arched: true, surround: 0.16, col: DRESS, depth: 0.1 });
			}
		};
		for (const s of [-1, 1]) {
			// Nave side walls (facing ±x), split by the transept.
			const FA = G.sub(s * n2, 0, 0, s * Math.PI / 2);
			clere(FA, -hz + 1.5, -n2 - 0.5);
			clere(FA, n2 + 0.5, hz - 1.5);
			// Transept side walls (facing ±z).
			const FB = G.sub(0, 0, s * n2, s > 0 ? 0 : Math.PI);
			clere(FB, -hx + 1.5, -n2 - 0.5);
			clere(FB, n2 + 0.5, hx - 1.5);
		}

		// ------------------------------------------------------------- facades
		const ns = edgeNormals(ring);
		const sign = signTex('VÁSÁRCSARNOK', { w: 1024, h: 96, colour: '#3a2a20', glow: '#000000', bg: '#ddd0b0', font: '700 70px Georgia, "Times New Roman", serif', letterSpacing: 14 });
		for (const f of facades(ring, 2.5)) {
			const F = f.frame, L = f.length;
			// Where does a nave arm meet this wall? Project the hall centre onto it.
			const [gx, , gz] = G.d(0, 0, 1);
			const dot = ns[f.i][0] * gx + ns[f.i][1] * gz;
			const [lc] = F.local(G.x, G.z);
			const armMeets = Math.abs(dot) > 0.9 || Math.abs(dot) < 0.1;
			const gable = armMeets && L > NAVE + 4 && lc > n2 && lc < L - n2 ? lc : null;
			aisleBays(m, F, L, gable);
			if (gable != null) gableFront(m, F, gable, f.i === front);
		}
		const signMat = new THREE.MeshStandardMaterial({ map: sign.map, roughness: 0.85 });

		finish(m, ctx, ctx.root, { sign: signMat }, { name: 'vasarcsarnok' });
		ctx.addSolidRing(b.outer, b);
	},
};

/** Brick aisle wall: pilasters, arched windows below the impost band, small arched windows above. */
function aisleBays(m, F, L, gable) {
	const bay = 4.3;
	const segs = gable == null ? [[0, L]] : [[0, gable - NAVE / 2 - 1.2], [gable + NAVE / 2 + 1.2, L]];
	for (const [a, b] of segs) {
		const len = b - a;
		const n = Math.floor(len / bay);
		if (n < 1) continue;
		const bw = len / n;
		m.tint = DRESS;
		for (let k = 0; k <= n; k++) m.box('stone', F, a + k * bw - 0.32, 1.0, 0, a + k * bw + 0.32, AISLE - 0.7, 0.14, { top: false });
		for (let k = 0; k < n; k++) {
			const x = a + (k + 0.5) * bw;
			windowAt(m, F, x, 1.3, Math.min(2.0, bw - 1.6), 3.1, { cell: k % 4 === 1 ? CELL.archedLit : CELL.arched, arched: true, surround: 0.18, col: DRESS, depth: 0.12, keystone: true });
			windowAt(m, F, x, 5.6, Math.min(1.5, bw - 2), 1.9, { cell: CELL.arched, arched: true, surround: 0.14, col: DRESS, depth: 0.1, sill: false });
		}
	}
}

/** A nave gable on a facade: flanking stone piers with finials, three doorways, inscription, lunette window. */
function gableFront(m, F, c, main) {
	const n2 = NAVE / 2;
	const span = n2 + 0.5;
	// Brick wall face of the gable section (slightly proud of the aisle wall) up to the eaves.
	m.tint = BRICK;
	m.box('brick', F, c - span, 0.9, 0, c + span, EAVE, 0.3, { top: false });
	m.tint = PLINTH;
	m.box('stone', F, c - span - 0.05, 0, 0, c + span + 0.05, 1.0, 0.45);
	// Flanking piers with stone quoins and finials.
	m.tint = DRESS;
	for (const s of [-1, 1]) {
		const x = c + s * (span + 0.15);
		m.box('stone', F, x - 0.75, 0.9, 0, x + 0.75, EAVE + 1.6, 0.6);
		m.box('stone', F, x - 0.9, EAVE + 1.6, -0.15, x + 0.9, EAVE + 2.0, 0.75);
		m.pyramid('stone', F, x, 0.3, EAVE + 2.0, 1.4, 1.4, 1.9);
		for (let y = 1.5; y < EAVE; y += 1.3) m.box('stone', F, x - 0.85, y, 0, x + 0.85, y + 0.55, 0.66, { top: false });
	}
	// Rake coping along the gable edges and a finial at the apex.
	const run = n2 + 0.45;
	for (const s of [-1, 1]) {
		// A stone slab 0.45 m thick along each rake (front face, back face, top).
		const A = [c + s * run, EAVE], B = [c, RIDGE + 0.2], t = 0.45;
		const [l, r] = s < 0 ? [A, B] : [B, A];
		m.poly('stone', F, [[l[0], l[1], 0.45], [r[0], r[1], 0.45], [r[0], r[1] + t, 0.45], [l[0], l[1] + t, 0.45]]);
		m.poly('stone', F, [[r[0], r[1], -0.3], [l[0], l[1], -0.3], [l[0], l[1] + t, -0.3], [r[0], r[1] + t, -0.3]]);
		const [p, q] = s < 0 ? [A, B] : [B, A];
		m.poly('stone', F, [[p[0], p[1] + t, 0.45], [q[0], q[1] + t, 0.45], [q[0], q[1] + t, -0.3], [p[0], p[1] + t, -0.3]]);
	}
	m.box('stone', F, c - 0.5, RIDGE + 0.2, -0.1, c + 0.5, RIDGE + 0.9, 0.5);
	m.pyramid('stone', F, c, 0.2, RIDGE + 0.9, 0.8, 0.8, 1.4);
	// Stone string courses across the gable.
	m.box('stone', F, c - span, 4.75, 0, c + span, 5.1, 0.45);
	m.box('stone', F, c - span, AISLE - 0.6, 0, c + span, AISLE - 0.25, 0.42);
	// Three round-arched doorways in stone surrounds.
	for (const dx of [-4.4, 0, 4.4]) {
		const w = dx ? 2.6 : 3.2;
		m.archPanel('detail', F, c + dx - w / 2, 0.95, c + dx + w / 2, 4.6, 0.31, CELL.archedDoor);
		m.box('stone', F, c + dx - w / 2 - 0.3, 0.95, 0.25, c + dx - w / 2, 4.6 - w / 2, 0.5);
		m.box('stone', F, c + dx + w / 2, 0.95, 0.25, c + dx + w / 2 + 0.3, 4.6 - w / 2, 0.5);
		m.arch('stone', F, c + dx, 4.6 - w / 2, w / 2, 0.3, 0.25, 0.25, { n: 8 });
	}
	// Inscription panel (main front only) between the doors and the lunette.
	if (main) m.panel('sign', F, c - 6.2, 5.35, c + 6.2, 6.35, 0.33, [0, 0, 1, 1], [1, 1, 1]);
	// The great lunette window: iron mullions over dark glass under a stone archivolt.
	const R = 5.6, sy = 9.0, y0 = 6.7;
	const uv = cellUV(CELL.darkGlass);
	const U = (x, y) => [uv[0] + ((x - (c - R)) / (2 * R)) * (uv[2] - uv[0]), uv[1] + ((y - y0) / (sy + R - y0)) * (uv[3] - uv[1])];
	m.poly('detail', F, [[c - R, y0, 0.33], [c + R, y0, 0.33], [c + R, sy, 0.33], [c - R, sy, 0.33]], [U(c - R, y0), U(c + R, y0), U(c + R, sy), U(c - R, sy)]);
	const N = 14;
	for (let i = 0; i < N; i++) {
		const a0 = Math.PI - (i / N) * Math.PI, a1 = Math.PI - ((i + 1) / N) * Math.PI;
		const p0 = [c + Math.cos(a0) * R, sy + Math.sin(a0) * R], p1 = [c + Math.cos(a1) * R, sy + Math.sin(a1) * R];
		m.poly('detail', F, [[c, sy, 0.33], [p0[0], p0[1], 0.33], [p1[0], p1[1], 0.33]], [U(c, sy), U(...p0), U(...p1)]);
	}
	m.tint = IRON;
	for (let k = 1; k < 8; k++) {
		const x = c - R + (2 * R * k) / 8;
		const top = sy + Math.sqrt(Math.max(0, R * R - (x - c) ** 2));
		m.box('iron', F, x - 0.06, y0, 0.33, x + 0.06, top, 0.43);
	}
	m.box('iron', F, c - R, sy - 0.07, 0.33, c + R, sy + 0.07, 0.45);
	m.box('iron', F, c - R, y0 + 1.15, 0.33, c + R, y0 + 1.25, 0.43);
	m.arch('iron', F, c, sy, R * 0.55, 0.1, 0.33, 0.1, { n: 10 });
	m.tint = DRESS;
	m.arch('stone', F, c, sy, R, 0.55, 0.3, 0.5, { n: 16 });
	m.box('stone', F, c - R - 0.55, y0, 0.3, c - R, sy, 0.5);
	m.box('stone', F, c + R, y0, 0.3, c + R + 0.55, sy, 0.5);
	m.box('stone', F, c - R - 0.7, y0 - 0.3, 0.3, c + R + 0.7, y0, 0.6);
	m.box('stone', F, c - 0.35, sy + R - 0.2, 0.3, c + 0.35, sy + R + 0.8, 0.62); // keystone
}
