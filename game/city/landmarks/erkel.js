// Erkel Színház (II. János Pál pápa tér 30): Hungary's largest theatre. The 1911 Népopera (Komor,
// Jakab, Márkus) got its present look from Kotsis Iván's 1959–61 front and was renovated in 2013.
// Modelled on the OSM footprint:
//  * the gently curved main front facing the square to the north-east: a row of glass doors under
//    a long cantilevered canopy, the two-storey glazed foyer between slender stone fins, and the
//    stone attic with the gilt "ERKEL SZÍNHÁZ" letters running along the curve;
//  * the cream plastered side wings (three window rows over a stone base);
//  * the raised auditorium with its low metal hip roof;
//  * the tall stage house at the southern end (pilaster strips, high window rows, scenery door).
import * as THREE from '../../vendor/three.module.min.js';
import { Mesher, facades, edgeNormals, finish, rgb, shade, windowAt, Frame } from './b-kit.js';
import { signTex, CELL } from './b-tex.js';

const CREAM = rgb('#e6dcc6'), STONE = rgb('#d3cbba'), WHITE = rgb('#ece8de'), PLINTH = rgb('#8f8a80'), ROOF = rgb('#868b8f'), DARK = rgb('#45423d'), BRONZE = rgb('#6d5a40');
const H = 17.5; // main cornice of the front and the wings
const STAGE_H = 27.5; // stage house (fly tower)
const FOYER_TOP = 13.4; // top of the foyer glazing
const CANOPY = 4.7; // underside of the entrance canopy

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

/**
 * Orders the facade segments of a (curved) front left→right as seen from outside and gives each
 * its running distance: [{ seg, s0, s1 }], plus the total length. Pure (testable).
 */
export function chainFront(segs, n = Infinity) {
	if (!segs.length) return { list: [], total: 0 };
	// A segment runs with the ring when its frame origin is the ring's start point.
	const withRing = segs.filter((f) => f.withRing).length >= segs.length / 2;
	let ordered = [...segs].sort((a, b) => a.i - b.i);
	// Rings wrap around: start after the largest index gap so the chain is contiguous.
	if (Number.isFinite(n) && ordered.length > 1) {
		let best = 0, at = 0;
		ordered.forEach((f, k) => {
			const next = ordered[(k + 1) % ordered.length];
			const gap = (next.i - f.i + n) % n;
			if (gap > best) { best = gap; at = (k + 1) % ordered.length; }
		});
		ordered = [...ordered.slice(at), ...ordered.slice(0, at)];
	}
	if (!withRing) ordered.reverse();
	let s = 0;
	const list = ordered.map((seg) => {
		const s0 = s;
		s += seg.length;
		return { seg, s0, s1: s };
	});
	return { list, total: s };
}

/** Sign panel pieces for a text band from sA to sB along a chain: [{ seg, x0, x1, u0, u1 }]. */
export function signPieces(list, sA, sB) {
	const out = [];
	for (const { seg, s0, s1 } of list) {
		const a = Math.max(s0, sA), b = Math.min(s1, sB);
		if (b - a < 0.01) continue;
		out.push({ seg, x0: a - s0, x1: b - s0, u0: (a - sA) / (sB - sA), u1: (b - sA) / (sB - sA) });
	}
	return out;
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
		// Floodlights wash the main front (north-facing) and, weaker, the park side.
		m.flood = (x, y, z, nx, ny, nz) => (ny > 0.5 ? 0 : Math.max(0, 1 - y / 24) * (nz < -0.5 ? 0.8 : nx > 0.6 ? 0.35 : 0));

		// ------------------------------------------------------------------ masses
		m.tint = CREAM;
		m.walls('plaster', rest, 0.7, H);
		m.tint = PLINTH;
		m.sweep('stone', rest, [[0.12, 0], [0.12, 0.7], [0, 0.78]]);
		// Main cornice: a thin projecting slab (the 1960s front has no classical mouldings).
		m.tint = WHITE;
		m.sweep('stone', rest, [[0, H - 0.75], [0.55, H - 0.6], [0.55, H - 0.2], [0.08, H - 0.2], [0.08, H + 0.7], [-0.25, H + 0.7]]);
		m.tint = shade(ROOF, 0.6);
		m.cap('plaster', rest, H);
		if (stage) stageHouse(m, stage);
		// The raised auditorium: a plastered drum-like box with a low metal hip roof.
		{
			const ob = rest.reduce((a, [x, z]) => [Math.min(a[0], x), Math.min(a[1], z), Math.max(a[2], x), Math.max(a[3], z)], [Infinity, Infinity, -Infinity, -Infinity]);
			const A = new Frame((ob[0] + ob[2]) / 2 + 2, (ob[1] + ob[3]) / 2 + 6, 0);
			m.tint = CREAM;
			m.box('plaster', A, -17, H, -14, 17, H + 4.2, 14, { top: false });
			m.tint = STONE;
			m.box('stone', A, -17.3, H + 4.2, -14.3, 17.3, H + 4.6, 14.3, { top: false });
			m.tint = ROOF;
			m.roof('metal', A, -17.4, -14.4, 17.4, 14.4, H + 4.6, 3.2, { hip: 1, overhang: 0.2 });
			m.box('metal', A, -4, H + 4.6, -3, 4, H + 7.2, 3); // roof plant
		}

		// ------------------------------------------------------------------ facades
		const ns = edgeNormals(rest);
		const front = [];
		for (const f of facades(rest, 2.5)) {
			const [nx, nz] = ns[f.i];
			const a = rest[f.i], c = rest[(f.i + 1) % rest.length];
			// The internal cut towards the stage house is not a facade.
			if (stage && stage.includes(a) && stage.includes(c)) continue;
			if (nz < -0.55) front.push({ ...f, withRing: Math.abs(f.frame.x - a[0]) < 1e-6 && Math.abs(f.frame.z - a[1]) < 1e-6 });
			else sideFacade(m, f.frame, f.length, nx > 0.55);
		}
		const { list, total } = chainFront(front, rest.length);
		for (const { seg } of list) foyerFront(m, seg.frame, seg.length);

		// "ERKEL SZÍNHÁZ" in gilt letters along the curved attic.
		let signMat = null;
		if (total > 12) {
			const W = Math.min(total - 4, 36), sA = (total - W) / 2;
			const hgt = W / 17;
			const y0 = FOYER_TOP + (H - 0.75 - FOYER_TOP - hgt) / 2;
			const sign = signTex('ERKEL SZÍNHÁZ', { w: 2048, h: 120, colour: '#cfae62', glow: '#fff0c8', font: '700 104px Georgia, "Times New Roman", serif', letterSpacing: 22 });
			for (const p of signPieces(list, sA, sA + W)) {
				m.panel('sign', p.seg.frame, p.x0, y0, p.x1, y0 + hgt, 0.16, [p.u0, 0, p.u1, 1], [1, 1, 1]);
			}
			signMat = ctx.night(new THREE.MeshStandardMaterial({ map: sign.map, emissiveMap: sign.emissive, emissive: 0xffffff, emissiveIntensity: 0, alphaTest: 0.4, roughness: 0.35, metalness: 0.7, side: THREE.DoubleSide }), 2.4);
		}

		// ------------------------------------------------------------------ forecourt
		// Poster showcases (plakáttartók) and flagpoles on the pavement in front of the doors.
		if (list.length) {
			const mid = list[Math.floor(list.length / 2)].seg;
			const F = mid.frame, L = mid.length;
			for (const dx of [-9, 9]) {
				const P = F.sub(L / 2 + dx, 0, 6);
				m.tint = DARK;
				m.box('iron', P, -0.7, 0, -0.1, 0.7, 2.3, 0.1);
				m.box('iron', P, -0.75, 2.3, -0.16, 0.75, 2.42, 0.16);
				m.panel('detail', P, -0.6, 0.35, 0.6, 2.15, 0.105, CELL.shop);
				m.panel('detail', P.sub(0, 0, 0, Math.PI), -0.6, 0.35, 0.6, 2.15, 0.105, CELL.shop);
				const [px, , pz] = P.p(0, 0, 0);
				ctx.addSolidBox(px, pz, 1.4, 0.3, P.yaw);
			}
			for (const dx of [-14, -12, 12, 14]) {
				const P = F.sub(L / 2 + dx, 0, 4.2);
				m.tint = rgb('#c9ccce');
				m.prism('iron', P, 0, 0, 0, 10.5, 0.07, 0.045, 8, { smooth: true });
				m.prism('iron', P, 0, 0, 10.5, 10.62, 0.08, 0.08, 8);
				const [px, , pz] = P.p(0, 0, 0);
				ctx.addPost(px, pz, 0.12);
			}
		}

		finish(m, ctx, ctx.root, signMat ? { sign: signMat } : {}, { name: 'erkel' });
		ctx.addSolidRing(ring, b);
	},
};

/** One segment of the glazed foyer front: doors, canopy, two-storey glazing between fins, attic. */
function foyerFront(m, F, L) {
	// Ground floor: glass doors between granite-clad piers on a dark plinth.
	const bays = Math.max(1, Math.round(L / 3.1)), bw = L / bays;
	for (let k = 0; k <= bays; k++) {
		m.tint = rgb('#b9b2a4');
		m.box('stone', F, k * bw - 0.3, 0, 0, k * bw + 0.3, CANOPY, 0.4);
	}
	for (let k = 0; k < bays; k++) m.panel('detail', F, k * bw + 0.3, 0.05, (k + 1) * bw - 0.3, CANOPY - 0.1, 0.05, CELL.lobby);
	// Cantilevered canopy: a white slab with a deep fascia and a light strip under its edge.
	m.tint = WHITE;
	m.box('stone', F, -0.2, CANOPY, 0, L + 0.2, CANOPY + 0.55, 3.4, { bottom: true });
	m.tint = [1, 1, 1];
	m.box('glow', F, 0.3, CANOPY - 0.04, 3.0, L - 0.3, CANOPY, 3.2);
	m.box('glow', F, 0.3, CANOPY - 0.04, 1.2, L - 0.3, CANOPY, 1.35);
	// Two-storey foyer glazing set back behind slender full-height stone fins.
	const fins = Math.max(2, Math.round(L / 1.75));
	for (let k = 0; k < fins; k++) {
		const x0 = (k * L) / fins, x1 = ((k + 1) * L) / fins;
		m.panel('detail', F, x0, CANOPY + 0.6, x1, 9.2, 0.05, CELL.lobby);
		m.panel('detail', F, x0, 9.35, x1, FOYER_TOP, 0.05, CELL.lobby);
	}
	m.tint = DARK;
	m.box('iron', F, 0, 9.2, 0, L, 9.35, 0.16, { bottom: true }); // transom
	m.tint = WHITE;
	for (let k = 0; k <= fins; k++) m.box('stone', F, (k * L) / fins - 0.14, CANOPY + 0.55, 0, (k * L) / fins + 0.14, FOYER_TOP + 0.2, 0.95);
	// Head of the glazing and the stone attic band.
	m.box('stone', F, -0.1, FOYER_TOP, 0, L + 0.1, FOYER_TOP + 0.45, 1.0, { bottom: true });
	m.tint = STONE;
	m.box('stone', F, 0, FOYER_TOP + 0.4, -0.04, L, H - 0.75, 0.1, { top: false });
}

/** Cream plastered side wing: stone base storey and three window rows; the park side is richer. */
function sideFacade(m, F, L, park) {
	const bay = park ? 3.4 : 3.8;
	const n = Math.floor((L - 1.0) / bay);
	// Stone-clad base storey.
	m.tint = STONE;
	m.box('stone', F, 0, 0.7, 0, L, 5.2, 0.08, { top: false });
	m.tint = WHITE;
	m.box('stone', F, -0.02, 5.2, 0, L + 0.02, 5.5, 0.2);
	m.box('stone', F, -0.02, 10.4, 0, L + 0.02, 10.58, 0.12);
	if (n < 1) return;
	const x0 = (L - n * bay) / 2;
	for (let k = 0; k < n; k++) {
		const x = x0 + (k + 0.5) * bay;
		const r = (k * 7 + Math.floor(L * 3)) % 5;
		windowAt(m, F, x, 1.6, 1.3, 2.4, { cell: r === 0 ? CELL.sashDark : CELL.sash, surround: 0.12, col: WHITE, depth: 0.16 });
		windowAt(m, F, x, 6.3, 1.4, 3.0, { cell: r < 2 ? CELL.sashCurtain : CELL.sash, surround: 0.15, col: WHITE, cornice: park ? 'flat' : null });
		windowAt(m, F, x, 11.6, 1.3, 2.5, { cell: r === 3 ? CELL.sashBlind : CELL.sashDark, surround: 0.13, col: WHITE });
	}
}

/** The stage house: tall plastered walls with pilaster strips, window rows and a scenery door. */
function stageHouse(m, stage) {
	m.tint = CREAM;
	m.walls('plaster', stage, 0.7, STAGE_H);
	m.tint = PLINTH;
	m.sweep('stone', stage, [[0.12, 0], [0.12, 0.7], [0, 0.78]]);
	m.tint = WHITE;
	m.sweep('stone', stage, [[0, STAGE_H - 0.7], [0.45, STAGE_H - 0.55], [0.45, STAGE_H - 0.15], [0.08, STAGE_H - 0.15], [0.08, STAGE_H + 0.6], [-0.25, STAGE_H + 0.6]]);
	m.tint = shade(ROOF, 0.6);
	m.cap('plaster', stage, STAGE_H);
	facades(stage, 20).forEach((f) => {
		const F = f.frame, L = f.length, idx = f.i;
		const inner = f.i === 3; // the closing edge faces the auditorium
		const y0 = inner ? H + 4.6 : 0.7;
		// Pilaster strips divide the wall into panels; band courses line up with the wings.
		const panels = Math.max(3, Math.round(L / 6.5)), pw = L / panels;
		m.tint = STONE;
		for (let k = 0; k <= panels; k++) m.box('stone', F, k * pw - 0.45, y0, 0, k * pw + 0.45, STAGE_H - 0.7, 0.16);
		m.tint = WHITE;
		if (!inner) {
			m.box('stone', F, 0, 0.7, 0, L, 5.2, 0.08, { top: false });
			m.box('stone', F, -0.02, 5.2, 0, L + 0.02, 5.5, 0.22);
			m.box('stone', F, -0.02, H - 0.75, 0, L + 0.02, H - 0.4, 0.26);
		}
		for (let k = 0; k < panels; k++) {
			const x = (k + 0.5) * pw;
			const r = (k * 5 + idx * 3) % 4;
			const door = !inner && idx === 1 && k === Math.floor(panels / 2);
			if (!inner && !door) {
				windowAt(m, F, x, 1.6, 1.3, 2.4, { cell: r === 0 ? CELL.sashBlind : CELL.sashDark, surround: 0.12, col: WHITE });
				windowAt(m, F, x, 7.0, 1.3, 2.6, { cell: r === 1 ? CELL.sash : CELL.sashDark, surround: 0.12, col: WHITE });
				windowAt(m, F, x, 11.8, 1.3, 2.6, { cell: CELL.sashDark, surround: 0.12, col: WHITE });
			}
			if (door) {
				// The scenery (loading) door: a tall steel door under a small canopy.
				m.panel('detail', F, x - 2, 0.75, x + 2, 5.0, 0.02, CELL.louvre);
				m.tint = DARK;
				m.box('iron', F, x - 2.3, 5.0, 0, x + 2.3, 5.2, 1.4, { bottom: true });
			}
			if (L > 20) windowAt(m, F, x, STAGE_H - 5.2, 1.1, 1.6, { cell: CELL.sashDark, surround: 0.1, col: WHITE });
			if (!inner && L > 20) windowAt(m, F, x, 20.2, 1.1, 1.6, { cell: CELL.sashDark, surround: 0.1, col: WHITE });
		}
	});
}

export { DARK, BRONZE };
