// Erkel Színház (II. János Pál pápa tér 30): Hungary's largest theatre, the 1911 Népopera rebuilt
// in the 1950s/60s and renovated 2013. Modelled on the OSM footprint: the gently curved, fully
// glazed foyer front facing the northern edge of the square with its cantilevered canopy and the
// "ERKEL SZÍNHÁZ" letters on the stone attic, the long cream side facade towards the park with
// three window rows, the raised auditorium roof and the tall stage house at the southern end.
import * as THREE from '../../vendor/three.module.min.js';
import { Mesher, facades, edgeNormals, finish, rgb, shade, windowAt, Frame } from './b-kit.js';
import { signTex, CELL } from './b-tex.js';

const CREAM = rgb('#e4ddcd'), STONE = rgb('#cbc3b2'), PLINTH = rgb('#9c968b'), ROOF = rgb('#8a8f93'), DARK = rgb('#4b4740'), BRONZE = rgb('#6d5a40');
const H = 17.5; // main cornice
const STAGE_H = 28;

/** Splits the footprint into the stage block (three consecutive long edges) and the rest. */
export function splitStage(ring) {
	const n = ring.length;
	const len = (i) => Math.hypot(ring[(i + 1) % n][0] - ring[i][0], ring[(i + 1) % n][1] - ring[i][1]);
	for (let i = 0; i < n; i++) {
		if (len(i) > 30 && len((i + 1) % n) > 30 && len((i + 2) % n) > 30) {
			const ids = [i, (i + 1) % n, (i + 2) % n, (i + 3) % n];
			const stage = ids.map((k) => ring[k]);
			const rest = ring.filter((_, k) => k !== ids[1] && k !== ids[2]);
			return { stage, rest };
		}
	}
	return { stage: null, rest: ring };
}

export default {
	id: 'erkel',
	name: 'Erkel Színház',
	lat: 47.4958,
	lon: 19.0768,
	match: (b) => b.name === 'Erkel Színház' || (b.tags && b.tags.wikidata === 'Q727749'),
	build(ctx, site) {
		const b = site.buildings[0];
		if (!b) return;
		const ring = b.outer;
		const { stage, rest } = splitStage(ring);
		const m = new Mesher();
		// Floodlights wash the front (north-facing walls) and the park side.
		m.flood = (x, y, z, nx, ny, nz) => (ny > 0.5 ? 0 : Math.max(0, 1 - y / 22) * (nz < -0.5 ? 0.9 : nx > 0.6 ? 0.45 : 0));

		// ------------------------------------------------------------------ masses
		m.tint = CREAM;
		m.walls('plaster', rest, 0.7, H);
		m.tint = PLINTH;
		m.sweep('stone', rest, [[0.12, 0], [0.12, 0.7], [0, 0.78]]);
		// Main cornice and parapet.
		m.tint = STONE;
		m.sweep('stone', rest, [[0, H - 0.9], [0.08, H - 0.9], [0.08, H - 0.7], [0.45, H - 0.45], [0.45, H], [0.05, H], [0.05, H + 0.9], [-0.25, H + 0.9]]);
		m.tint = shade(ROOF, 0.6);
		m.cap('plaster', rest, H + 0.2);
		if (stage) {
			m.tint = CREAM;
			m.walls('plaster', stage, 0.7, STAGE_H);
			m.tint = PLINTH;
			m.sweep('stone', stage, [[0.12, 0], [0.12, 0.7], [0, 0.78]]);
			m.tint = STONE;
			m.sweep('stone', stage, [[0, STAGE_H - 0.6], [0.3, STAGE_H - 0.4], [0.3, STAGE_H], [0.05, STAGE_H], [0.05, STAGE_H + 0.7], [-0.25, STAGE_H + 0.7]]);
			m.tint = shade(ROOF, 0.6);
			m.cap('plaster', stage, STAGE_H + 0.2);
			// Plain band of small windows high up on the stage house, and the scenery door.
			for (const f of facades(stage, 20)) {
				m.tint = STONE;
				const n = Math.floor((f.length - 4) / 4.5);
				for (let k = 0; k < n; k++) windowAt(m, f.frame, 2 + (f.length - 4) * ((k + 0.5) / n), STAGE_H - 5, 1.1, 1.5, { cell: CELL.sashDark, surround: 0.1, col: STONE });
				for (let k = 0; k < n; k++) windowAt(m, f.frame, 2 + (f.length - 4) * ((k + 0.5) / n), 20.5, 1.1, 1.5, { cell: k % 3 ? CELL.sashDark : CELL.sash, surround: 0.1, col: STONE });
			}
		}
		// The raised auditorium: a box with a low metal hip roof over the middle of the house.
		{
			const ob = rest.reduce((a, [x, z]) => [Math.min(a[0], x), Math.min(a[1], z), Math.max(a[2], x), Math.max(a[3], z)], [Infinity, Infinity, -Infinity, -Infinity]);
			const cx = (ob[0] + ob[2]) / 2 + 2, cz = (ob[1] + ob[3]) / 2 + 6;
			const A = new Frame(cx, cz, 0);
			m.tint = CREAM;
			m.box('plaster', A, -17, H, -14, 17, H + 4.2, 14, { top: false });
			m.tint = STONE;
			m.box('stone', A, -17.3, H + 4.2, -14.3, 17.3, H + 4.6, 14.3, { top: false });
			m.tint = ROOF;
			m.roof('metal', A, -17.4, -14.4, 17.4, 14.4, H + 4.6, 3.2, { hip: 1, overhang: 0.2 });
			// Fly tower / roof plant on top of the auditorium.
			m.box('metal', A, -4, H + 4.6, -3, 4, H + 7.2, 3);
		}

		// ------------------------------------------------------------------ facades
		const ns = edgeNormals(rest);
		const sign = signTex('ERKEL SZÍNHÁZ', { w: 1024, h: 128, colour: '#d9c58f', glow: '#fff2cc', font: '600 96px "Times New Roman", Georgia, serif', letterSpacing: 6 });
		let signEdge = null;
		for (const f of facades(rest, 2.5)) {
			const [nx, nz] = ns[f.i];
			const F = f.frame, L = f.length;
			const a = rest[f.i], c = rest[(f.i + 1) % rest.length];
			// The internal cut towards the stage house is not a facade.
			if (stage && stage.some((p) => p === a) && stage.some((p) => p === c)) continue;
			if (nz < -0.55) {
				foyerFront(m, F, L);
				if (L > 11 && (!signEdge || L > signEdge.length)) signEdge = f;
			} else if (nx > 0.55) sideFacade(m, F, L, true);
			else sideFacade(m, F, L, false);
		}
		if (signEdge) {
			const F = signEdge.frame, L = signEdge.length, w = Math.min(L - 1.5, 13);
			m.panel('sign', F, L / 2 - w / 2, 14.2, L / 2 + w / 2, 14.2 + w / 8, 0.12, [0, 0, 1, 1], [1, 1, 1]);
		}
		const signMat = ctx.night(new THREE.MeshStandardMaterial({ map: sign.map, emissiveMap: sign.emissive, emissive: 0xffffff, emissiveIntensity: 0, transparent: true, alphaTest: 0.3, roughness: 0.35, metalness: 0.6 }), 2.6);

		// ------------------------------------------------------------------ forecourt
		// Poster showcases (plakáttartók) and two flagpoles in front of the foyer.
		if (signEdge) {
			const F = signEdge.frame, L = signEdge.length;
			for (const dx of [-7.5, 7.5]) {
				const P = F.sub(L / 2 + dx, 0, 6.5);
				m.tint = DARK;
				m.box('iron', P, -0.7, 0, -0.12, 0.7, 2.3, 0.12);
				m.panel('detail', P, -0.6, 0.35, 0.6, 2.15, 0.125, CELL.shop);
				m.panel('detail', P.sub(0, 0, 0, Math.PI), -0.6, 0.35, 0.6, 2.15, 0.125, CELL.shop);
				ctx.addSolidBox(...P.p(0, 0, 0).filter((_, i) => i !== 1), 1.4, 0.3, P.yaw);
			}
			for (const dx of [-12, 12]) {
				const P = F.sub(L / 2 + dx, 0, 3.2);
				m.tint = rgb('#c9ccce');
				m.prism('iron', P, 0, 0, 0, 11, 0.07, 0.05, 8, { smooth: true });
				const [px, , pz] = P.p(0, 0, 0);
				ctx.addPost(px, pz, 0.12);
			}
		}

		finish(m, ctx, ctx.root, { sign: signMat }, { name: 'erkel' });
		ctx.addSolidRing(ring, b);
	},
};

/** The glazed foyer front: stone piers, glass doors, canopy, two-storey glazing, stone attic. */
function foyerFront(m, F, L) {
	const bays = Math.max(1, Math.round(L / 3.2)), bw = L / bays;
	// Ground floor: entrance doors between granite piers.
	for (let k = 0; k <= bays; k++) {
		m.tint = STONE;
		m.box('stone', F, k * bw - 0.28, 0, 0, k * bw + 0.28, 4.6, 0.3);
	}
	for (let k = 0; k < bays; k++) m.panel('detail', F, k * bw + 0.28, 0.05, (k + 1) * bw - 0.28, 4.5, 0.06, CELL.lobby);
	// Cantilevered canopy with a light strip under its edge.
	m.tint = shade(STONE, 1.05);
	m.box('stone', F, -0.3, 4.6, 0, L + 0.3, 5.05, 2.8, { bottom: true });
	m.tint = [1, 1, 1];
	m.box('glow', F, 0.2, 4.55, 2.55, L - 0.2, 4.6, 2.7);
	// Two-storey foyer glazing between slender vertical fins.
	const fins = Math.max(2, Math.round(L / 1.6));
	for (let k = 0; k < fins; k++) m.panel('detail', F, (k * L) / fins, 5.3, ((k + 1) * L) / fins, 13.2, 0.04, CELL.lobby);
	m.tint = STONE;
	for (let k = 0; k <= fins; k++) m.box('stone', F, (k * L) / fins - 0.11, 5.05, 0, (k * L) / fins + 0.11, 13.4, 0.55);
	m.box('stone', F, -0.1, 13.2, -0.05, L + 0.1, 13.6, 0.6);
	// Attic band in stone cladding.
	m.box('stone', F, 0, 13.6, -0.04, L, H - 0.9, 0.08, { top: false });
}

/** Cream plastered side facade with stone window surrounds; the park side gets three rows. */
function sideFacade(m, F, L, park) {
	const bay = park ? 3.6 : 4.4;
	const n = Math.floor((L - 1.2) / bay);
	if (n < 1) return;
	const x0 = (L - n * bay) / 2;
	for (let k = 0; k < n; k++) {
		const x = x0 + (k + 0.5) * bay;
		const r = (k * 7 + Math.floor(L * 3)) % 5;
		m.tint = STONE;
		windowAt(m, F, x, 1.5, 1.3, 2.2, { cell: r === 0 ? CELL.sashDark : CELL.sash, surround: 0.14, col: STONE });
		windowAt(m, F, x, 6.2, 1.4, 3.2, { cell: r < 2 ? CELL.sashCurtain : CELL.sash, surround: 0.16, col: STONE, cornice: park ? 'flat' : null });
		if (park) windowAt(m, F, x, 11.2, 1.3, 2.4, { cell: r === 3 ? CELL.sashBlind : CELL.sashDark, surround: 0.14, col: STONE });
	}
	// String courses.
	m.tint = STONE;
	m.box('stone', F, 0, 5.2, 0, L, 5.45, 0.14);
	if (park) m.box('stone', F, 0, 10.3, 0, L, 10.5, 0.1);
}

export { DARK, BRONZE };
