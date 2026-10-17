// Keleti pályaudvar (Rochlitz Gyula & Feketeházy János, 1881–84) and its forecourt on Baross tér.
//
// The station is built on its exact OSM footprint and parts: the 46 m wide triumphal-arch front
// block on Baross tér (x ≈ 203.7), the 180 m long catenary train shed behind it, the corner and
// middle pavilions with mansards and the two-storey side wings along Thököly út (north) and
// Kerepesi út (south). Reference: scratchpad ref/keleti-baross.md (dimensions, colours, layout).
//
// Front block, seen from the square (left = north, Thököly út side):
//   Stephenson tower | great arch (glass screen, 4-column portal with 4 statues, clock) | Watt tower
//   with the crowning group "A közlekedés allegóriája" (Steam on a globe between Neptune and Vulcan)
//   on the attic at ~43 m.
import * as THREE from '../../vendor/three.module.min.js';
import { toXZ, rng } from '../../geo.js';
import {
	Parts, rgb, mulc, mixc, PAT, PROFILES, orientRing, ringEdges, offsetRing, bounds, inside, consumeProps,
	wallWithOpenings, openingOutline, openingFill, balustrade, column, pilaster, figure, buildingShell, roof,
	archBand, sweep, ellipseArch, atlas, decalQuad, glowQuad, edgeMatrix,
} from './stonework.js';

// OSM ids (data/district8.json): the outline and its building:parts, the Baross tér underpass part
// (mapped as a 16 m "building" across the square) and two small shelters mapped as 16 m blocks.
const ID = {
	outline: 9906133, front: 1512257035, hall: 1512257036,
	lotzN: 1512257037, midS: 1512257038, pavNW: 1512257039, pavSW: 1512257040, pavNE: 1512257041, pavSE: 1512257042,
	wingNW: 1512257043, wingNE: 1512257044, wingSW: 1512257045, wingSE: 1512257046,
};
const EXTRA = new Set([4202804, 1348982422, 1348982423]);
const PARTS = new Set(Object.values(ID));

// Colours (daylight estimates from the reference, as linear RGB).
const C = {
	stone: rgb('#d3c6ab'), stoneLit: rgb('#e0d6c1'), recess: rgb('#a99a80'), granite: rgb('#8e8a83'),
	wing: rgb('#c6b18d'), wingPatch: rgb('#b4a487'), wingGrey: rgb('#9e978a'),
	iron: rgb('#3b4045'), glass: rgb('#62717a'), slate: rgb('#4b4f55'), zinc: rgb('#7e848a'),
	statue: rgb('#b8b2a5'), group: rgb('#a7a49b'), bronze: rgb('#4d5747'), bronzeHi: rgb('#6e6a4f'),
	limestone: rgb('#d9d1bd'), frame: rgb('#5a4a3a'), gate: rgb('#1f1f1f'), gilt: rgb('#b08d42'),
};

const BAROSS = toXZ(47.49980, 19.08108); // fallback position of the Baross Gábor statue

export default {
	id: 'keleti',
	name: 'Keleti pályaudvar',
	lat: 47.50030,
	lon: 19.08330,
	match(b) {
		return PARTS.has(b.id) || EXTRA.has(b.id) || b.name === 'Keleti pályaudvar' || b.name === 'Baross téri aluljáró';
	},
	build(ctx, site) {
		const byId = new Map(site.buildings.map((b) => [b.id, b]));
		const outline = byId.get(ID.outline) || site.buildings.find((b) => b.name === 'Keleti pályaudvar');
		if (!outline) {
			// Fallback map: nothing to replace, so put nothing here (the generic blocks stay).
			for (const b of site.buildings) ctx.suppressed.delete(b.id);
			return;
		}
		const t0 = performance.now();
		const P = new Parts();
		const lay = layout(outline, byId);
		buildFront(P, ctx, lay);
		buildShed(P, lay);
		buildWings(P, lay, byId);
		const hands = buildClockHands(ctx, lay);
		// Baross tér: the Baross Gábor statue (OSM prop position) and the two shelters.
		const st = (ctx.data.props || []).find((p) => p.kind === 'statue' && /Baross/.test(p.name || ''));
		const [sx, sz] = st ? [st.x, st.z] : BAROSS;
		buildBarossStatue(P, ctx, sx, sz);
		for (const id of [1348982422, 1348982423]) if (byId.has(id)) buildShelter(P, ctx, byId.get(id).outer);
		consumeProps(ctx, lay.fx + 2, lay.zc, 32);
		consumeProps(ctx, sx, sz, 6);
		// Collision: the whole station outline plus the projecting towers and portal.
		ctx.addSolidRing(orientRing(outline.outer), outline);
		for (const ring of lay.solids) ctx.addSolidRing(ring);
		const { meshes } = P.build(ctx, { name: 'keleti' });
		if (hands) meshes.push(hands);
		this.stats = { tris: P.tris, meshes: meshes.length, ms: performance.now() - t0 };
	},
};

// ---------------------------------------------------------------- layout

function ringOf(b) { return b ? orientRing(b.outer) : null; }

/** Derives the facade frame and part rings from the OSM data. */
function layout(outline, byId) {
	const front = byId.get(ID.front);
	const hall = byId.get(ID.hall);
	const bb = bounds([outline.outer]);
	let fx, za, zb, backX;
	if (front) {
		const fb = bounds([front.outer]);
		fx = fb.x0; za = fb.z0; zb = fb.z1; backX = fb.x1;
	} else {
		const zc = (bb.z0 + bb.z1) / 2;
		fx = bb.x0; za = zc - 23.1; zb = zc + 23.1; backX = fx + 4;
	}
	const hb = hall ? bounds([hall.outer]) : { x0: backX, x1: bb.x1, z0: za, z1: zb };
	const W = zb - za;
	const lay = {
		fx, za, zb, W, backX, depth: backX - fx, zc: (za + zb) / 2,
		hall: { x0: hb.x0, x1: hb.x1, z0: hb.z0, z1: hb.z1 },
		bb, solids: [],
		// Front block proportions (local u from north end, metres).
		TW: 8.6, ys: 15.4, crown: 28.9, cornice: 30.6, attic: 32.2, atticTop: 33.8,
	};
	lay.uc = W / 2;
	lay.archA = W / 2 - lay.TW;
	lay.archB = lay.crown - lay.ys;
	/** Local frame of the front (u along +z from the north end, outward = west). */
	lay.frontM = edgeMatrix(fx, za, fx, zb, 0);
	return lay;
}

/** World (x, z) of a front-local point (u, w): w = distance in front of the facade plane. */
function fl(lay, u, w) { return [lay.fx - w, lay.za + u]; }

// ---------------------------------------------------------------- front block

function buildFront(P, ctx, lay) {
	const { W, TW, ys, uc, archA, archB, cornice, attic, atticTop, depth } = lay;
	const r = rng(1884);
	P.save();
	P.frame(lay.frontM);
	P.set({ c: C.stone, grime: 0.22, flood: 0.85, floodH: 40, rough: 0.82 });

	// --- towers -------------------------------------------------------------------------
	for (const side of [0, 1]) {
		const u0 = side ? W - TW : 0, u1 = side ? W : TW;
		const rs0 = u0 + 1.7, rs1 = u1 - 1.7; // central projecting part (risalit)
		const zf = 1.2, zr = 2.3;
		// Core: back to the hall, front face in zones.
		P.set({ c: C.stone, pat: PAT.ashlar, ps: 0.62 });
		P.box(u0, -0.3, -depth, u1, attic, zf, 'bf');
		zonePanels(P, u0, u1, zf, [[-0.3, 1.1, C.granite, PAT.ashlar, 0.55], [1.1, 11.4, C.stone, PAT.ashlar, 0.55], [11.4, attic, C.stone, PAT.ashlar, 0.78]]);
		// Risalit with the statue niche, the upper window, the tablet and the oculus.
		P.set({ c: C.stoneLit, pat: PAT.ashlar, ps: 0.55 });
		P.box(rs0, -0.3, zf - 0.01, rs1, cornice, zr, 'bf');
		const niche = { x: (rs0 + rs1) / 2 - 1.4, y: 2.7, w: 2.8, h: 6.3, head: 'round' };
		const win = { x: (rs0 + rs1) / 2 - 1.05, y: 13.6, w: 2.1, h: 6.1, head: 'round' };
		const ocx = (rs0 + rs1) / 2, ocy = 26.4;
		const oc = circleOutline(ocx, ocy, 1.0, 14);
		P.save();
		P.translate(0, 0, zr);
		P.set({ pat: PAT.ashlar, ps: 0.55 });
		const nO = openingOutline(niche.x, niche.y, niche.w, niche.h, 'round', 10);
		const wO = openingOutline(win.x, win.y, win.w, win.h, 'round', 8);
		// Lower zone (rusticated) with the niche, upper zones smooth with the window and oculus.
		P.panel([[rs0, -0.3], [rs1, -0.3], [rs1, 11.4], [rs0, 11.4]], [nO], 0);
		P.set({ pat: PAT.ashlar, ps: 0.78 });
		P.panel([[rs0, 11.4], [rs1, 11.4], [rs1, cornice], [rs0, cornice]], [wO, oc], 0);
		// Niche: deep round-headed recess with a shell hood and a pedestal.
		P.set({ c: C.recess, pat: 0, grime: 0.4 });
		openingFill(P, { ...niche, depth: 1.15, glass: false, fill: mulc(C.recess, 0.9) }, nO);
		P.set({ c: C.stoneLit, grime: 0.22 });
		archBand(P, niche.x + niche.w / 2, niche.y + niche.h - niche.w / 2, niche.w / 2, niche.w / 2 + 0.35, 0, 0.18, 10);
		P.box(niche.x - 0.35, niche.y - 0.32, 0, niche.x + niche.w + 0.35, niche.y, 0.3, 'b');
		P.box(niche.x + niche.w / 2 - 0.3, niche.y + niche.h - 0.1, 0, niche.x + niche.w / 2 + 0.3, niche.y + niche.h + 0.6, 0.32, 'b'); // keystone
		P.box(niche.x + 0.5, niche.y, -1.05, niche.x + niche.w - 0.5, niche.y + 0.55, -0.25, 'b'); // statue pedestal
		// Upper window (glazed, lit at night) with a moulded surround and balustered sill.
		P.set({ c: C.stoneLit, pat: 0 });
		openingFill(P, { ...win, depth: 0.45, lit: 0.8, frame: C.iron, mullions: 1, frameW: 0.06 }, wO, { rng: r, glassColour: mulc(C.glass, 0.25) });
		archBand(P, win.x + win.w / 2, win.y + win.h - win.w / 2, win.w / 2, win.w / 2 + 0.28, 0, 0.14, 8);
		P.box(win.x - 0.28, win.y, 0, win.x, win.y + win.h - win.w / 2, 0.14, 'b');
		P.box(win.x + win.w, win.y, 0, win.x + win.w + 0.28, win.y + win.h - win.w / 2, 0.14, 'b');
		balustrade(P, win.x - 0.5, win.x + win.w + 0.5, win.y - 1.1, { h: 1.0, spacing: 0.3, depth: 0.32, z: 0.25, low: ctx.quality === 'low' });
		P.box(win.x - 0.6, win.y - 1.25, 0, win.x + win.w + 0.6, win.y - 1.1, 0.5, 'b');
		// Tablet with the year above the window.
		const year = side ? '1984' : '1884';
		const uvY = atlas().region('keleti-' + year, 192, 64, (g, w, h) => tablet(g, w, h, year));
		P.box(ocx - 1.45, 20.25, 0, ocx + 1.45, 21.55, 0.1, 'b');
		decalQuad(P, uvY, ocx, 20.9, 2.5, 0.95, 0.105, { c: [0.9, 0.85, 0.75] });
		// Oculus: round window in a square frame with a wreath ring.
		openingFill(P, { x: ocx - 1, y: ocy - 1, w: 2, h: 2, head: 'flat', depth: 0.4, lit: 0.7, frame: C.iron, mullions: 1, transom: 0.5, frameW: 0.05 }, oc, { rng: r, glassColour: mulc(C.glass, 0.25) });
		ringTorus(P, ocx, ocy, 1.1, 0.16, 0.12, 16);
		P.box(ocx - 1.6, ocy - 1.6, 0, ocx + 1.6, ocy - 1.42, 0.12, 'b');
		P.box(ocx - 1.6, ocy + 1.42, 0, ocx + 1.6, ocy + 1.6, 0.12, 'b');
		P.box(ocx - 1.6, ocy - 1.6, 0, ocx - 1.42, ocy + 1.6, 0.12, 'b');
		P.box(ocx + 1.42, ocy - 1.6, 0, ocx + 1.6, ocy + 1.6, 0.12, 'b');
		// Paired Corinthian pilasters on the risalit edges (upper zone).
		P.set({ c: C.stoneLit });
		for (const px of [rs0 + 0.42, rs1 - 0.42]) pilaster(P, px, 12.5, 22.1, 0.62, 0.2, { order: 'corinthian' });
		for (const px of [rs0 + 0.42, rs1 - 0.42]) pilaster(P, px, 23.0, cornice - 0.05, 0.62, 0.2, { order: 'ionic' });
		P.restore();
		// Statue in the niche: Stephenson (north, left) with a locomotive model, Watt (south) with a scroll.
		P.save();
		P.set({ c: C.statue, grime: 0.35, pat: 0, rough: 0.7, flood: 0.6 });
		P.translate((rs0 + rs1) / 2, niche.y + 0.55, zr - 0.62);
		figure(P, side
			? { h: 3.8, robe: 'coat', head: 'bare', armR: [0.5, 0.1, 0.9], holdR: 'scroll', armL: [0.05, 0.08, 0.3], stride: 0.1 }
			: { h: 3.8, robe: 'coat', head: 'hair', armL: [0.45, 0.15, 1.0], holdL: 'model', armR: [0.0, 0.1, 0.15], stride: 0.12 });
		P.restore();
		// Granite plinth and the moulded bands around the tower.
		const ring = [[u0, -depth], [u1, -depth], [u1, zf], [rs1, zf], [rs1, zr], [rs0, zr], [rs0, zf], [u0, zf]];
		const wring = ring.map(([u, w]) => fl(lay, u, w));
		lay.solids.push(wring);
		P.save();
		P.M.identity(); P.N.identity();
		P.set({ c: C.granite, pat: PAT.ashlar, ps: 0.55, grime: 0.4 });
		P.ringBand(wring, [[0.18, -0.3], [0.18, 0.95], [0.06, 1.1], [0, 1.12]], 0);
		P.set({ c: C.stoneLit, pat: 0, grime: 0.3 });
		P.ringBand(wring, PROFILES.band(1.4), 11.25);
		P.ringBand(wring, PROFILES.band(1.1), 22.1);
		P.restore();
	}

	// --- great arch: spandrel wall, archivolt, keystone, soffit --------------------------
	const arch = ellipseArch(uc, ys, archA, archB, 28);
	const spandrel = [[TW, ys], ...arch.pts.slice().reverse().map((p) => p), [W - TW, ys]];
	// Panel outline: from the left springing over the arch to the right springing, up and back.
	const outlineArch = [[TW, ys]];
	for (let i = arch.pts.length - 1; i >= 0; i--) outlineArch.push(arch.pts[i]);
	outlineArch.push([W - TW, ys], [W - TW, cornice], [TW, cornice]);
	void spandrel;
	P.set({ c: C.stone, pat: PAT.ashlar, ps: 0.78, grime: 0.22 });
	P.panel(outlineArch, [], 0);
	// Soffit of the arch (from the facade plane back to the glass screen).
	P.set({ c: mulc(C.stone, 0.92), pat: PAT.ashlar, ps: 0.9 });
	sweep(P, arch.pts, arch.nrm, [[0, -2.0], [0, 0]]);
	// Archivolt: three stepped fasciae and an outer moulding.
	P.set({ c: C.stoneLit, pat: 0 });
	sweep(P, arch.pts, arch.nrm, [[0, 0], [0, 0.28], [0.45, 0.28], [0.5, 0.36], [1.0, 0.36], [1.05, 0.46], [1.5, 0.46], [1.62, 0.62], [1.75, 0.62], [1.8, 0]]);
	// Keystone with a volute console.
	P.box(uc - 0.9, lay.crown + 0.2, 0, uc + 0.9, cornice + 0.2, 0.95, 'b');
	P.box(uc - 0.65, lay.crown - 0.4, 0, uc + 0.65, lay.crown + 0.3, 0.8, 'b');
	// Impost blocks at the springing.
	for (const u of [TW, W - TW]) P.box(u - 0.6, ys - 0.7, -2.0, u + 0.6, ys, 0.5, 'b');
	// Spandrel medallions with the MÁV winged wheel.
	const uvWheel = atlas().region('mav-wheel', 160, 160, wingedWheel);
	for (const u of [TW + 3.4, W - TW - 3.4]) {
		ringTorus(P, u, 26.3, 1.45, 0.16, 0.16, 18);
		decalQuad(P, uvWheel, u, 26.3, 2.6, 2.6, 0.06, { c: [0.82, 0.78, 0.7] });
	}

	// --- glass screen with its iron grid -------------------------------------------------
	const zs = -2.0;
	const scrOutline = [[TW, -0.3], [W - TW, -0.3], ...arch.pts.map((p) => p)];
	P.save();
	P.set({ ch: 'glass', c: mulc(C.glass, 0.32), lit: 0.95, glow: [1.0, 0.78, 0.5] });
	screenPanes(P, lay, arch, zs, r);
	P.restore();
	void scrOutline;
	P.save();
	P.set({ c: C.iron, metal: 0.4, rough: 0.55, grime: 0.1, flood: 0.1, pat: 0 });
	screenBars(P, lay, arch, zs);
	P.restore();

	// --- portal: wall with three arched bays, four columns, entablature, balustrade, statues
	buildPortal(P, ctx, lay, r);

	// --- main cornice, attic and the crowning group --------------------------------------
	const blockRing = [[0, -depth], [W, -depth], [W, 1.2], [W - 1.7, 1.2], [W - 1.7, 2.3], [W - TW + 1.7, 2.3], [W - TW + 1.7, 1.2], [W - TW, 1.2], [W - TW, 0], [TW, 0], [TW, 1.2], [TW - 1.7, 1.2], [TW - 1.7, 2.3], [1.7, 2.3], [1.7, 1.2], [0, 1.2]];
	const wBlock = blockRing.map(([u, w]) => fl(lay, u, w));
	P.save();
	P.M.identity(); P.N.identity();
	P.set({ c: C.stoneLit, pat: 0, grime: 0.32, flood: 0.75 });
	P.ringBand(wBlock, PROFILES.cornice(1.6), cornice);
	P.flat(offsetRing(orientRing(wBlock), 1.4), cornice + 0.8, [orientRing(wBlock)], true);
	// Attic band with sunk panels and a coping.
	P.set({ c: C.stone, pat: PAT.ashlar, ps: 0.8 });
	P.ringBand(wBlock, [[0, 0], [0, atticTop - attic - 0.25], [0.12, atticTop - attic - 0.18], [0.14, atticTop - attic], [-0.5, atticTop - attic]], attic);
	P.set({ c: C.zinc, pat: PAT.seam, ps: 0.6, metal: 0.3, rough: 0.5, flood: 0 });
	P.flat(offsetRing(orientRing(wBlock), -0.5), atticTop - 0.02);
	P.restore();
	// Urn finials on the tower corners.
	P.set({ c: C.stoneLit, pat: 0, flood: 0.6 });
	for (const u of [0.6, TW - 0.6, W - TW + 0.6, W - 0.6]) for (const w of [1.6]) urn(P, u, atticTop, w, 1.8);
	// Frieze inscription in the attic (weathered, recessed letters).
	const uvMKAV = atlas().region('mkav', 512, 40, (g, w, h) => inscription(g, w, h, 'MAGYAR KIRÁLYI ÁLLAMVASUTAK', '#6f6450', 0.75));
	decalQuad(P, uvMKAV, uc, attic + 0.75, 18.5, 1.25, 0.02, { c: [0.95, 0.92, 0.85] });
	// Group pedestal: stepped block on the attic, centred.
	P.set({ c: C.stone, pat: PAT.ashlar, ps: 0.7, flood: 0.7 });
	P.box(uc - 7.2, atticTop - 0.1, -2.8, uc + 7.2, atticTop + 1.1, 0.6, 'b');
	P.set({ c: C.stoneLit, pat: 0 });
	P.save();
	P.translate(0, atticTop + 1.1, 0.6);
	P.extrude([[0, 0], [0.1, 0], [0.1, 0.12], [0.25, 0.2], [0.25, 0.32], [-3.4, 0.32]], uc - 7.3, uc + 7.3, true);
	P.restore();
	P.box(uc - 2.2, atticTop + 1.4, -2.4, uc + 2.2, atticTop + 2.6, 0.3, 'b');
	P.box(uc - 1.6, atticTop + 2.6, -2.0, uc + 1.6, atticTop + 3.0, -0.1, 'b');
	// The crowning group: Steam on a globe with a cogwheel, wings spread; Neptune and Vulcan.
	P.save();
	P.set({ c: C.group, metal: 0.35, rough: 0.5, grime: 0.15, pat: 0, flood: 0.6 });
	const gy = atticTop + 3.0;
	P.blob([uc, gy + 0.85, -1.05], 1.0, 0.9, 1.0, 12, 8); // globe
	ringTorus(P, uc, gy + 0.85, 1.02, 0.05, 0.06, 18, -1.05, true);
	P.translate(uc, gy + 1.65, -1.0);
	figure(P, { h: 5.2, robe: 'gown', head: 'hair', wings: 2.4, armR: [0.4, 1.6, 0.6], holdR: 'wheel', armL: [0.3, 0.5, 1.1], holdL: 'staff', stride: 0.05, cloak: true });
	P.restore();
	for (const sx of [-1, 1]) {
		P.save();
		P.set({ c: C.group, metal: 0.35, rough: 0.5, grime: 0.15, pat: 0, flood: 0.6 });
		P.translate(uc + sx * 4.6, atticTop + 1.42, -1.0).rotateY(-sx * 0.55);
		figure(P, sx < 0
			? { h: 3.9, seated: true, robe: 'none', head: 'hair', armR: [0.6, 0.4, 0.2], holdR: 'trident', armL: [0.1, 0.5, 0.6], cloak: true }
			: { h: 3.9, seated: true, robe: 'none', head: 'hat', armL: [0.9, 0.5, 0.5], holdL: 'hammer', armR: [0.2, 0.4, 0.8], cloak: true });
		P.restore();
		// Attributes at their feet: an amphora (water) and an anvil (fire).
		P.save();
		P.set({ c: C.group, metal: 0.35, rough: 0.5, pat: 0, flood: 0.5 });
		if (sx < 0) P.lathe([[0.0, 0], [0.25, 0.05], [0.42, 0.45], [0.3, 0.85], [0.15, 1.0], [0.2, 1.12], [0.0, 1.12]], uc - 6.5, atticTop + 1.42, -0.6, { seg: 10, smooth: true });
		else { P.box(uc + 6.0, atticTop + 1.42, -1.0, uc + 6.9, atticTop + 2.1, -0.4, 'b'); P.box(uc + 5.8, atticTop + 2.1, -1.05, uc + 7.1, atticTop + 2.35, -0.35, 'b'); }
		P.restore();
	}

	// Block sides above the pavilions and the back (towards the hall) — plain walls with a band.
	P.set({ c: C.stone, pat: PAT.ashlar, ps: 0.8, grime: 0.35, flood: 0.4 });
	P.box(TW, ys, -depth, W - TW, cornice, -2.05, 'bf');
	P.restore();
}

/** Stacked wall zones on a face at z (local frame): [[y0, y1, colour, pattern, scale], ...]. */
function zonePanels(P, u0, u1, z, zones) {
	for (const [y0, y1, c, pat, ps] of zones) {
		P.save();
		P.set({ c, pat, ps });
		P.quad([u0, y0, z], [u1, y0, z], [u1, y1, z], [u0, y1, z]);
		P.restore();
	}
}

function circleOutline(cx, cy, r, n) {
	const out = [];
	for (let i = 0; i < n; i++) {
		const a = (Math.PI * 2 * i) / n;
		out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
	}
	return out;
}

/** A moulded ring (torus-like band) in the local x–y plane at z. */
function ringTorus(P, cx, cy, r, w, d, n = 16, z = 0, horizontal = false) {
	const pts = [], nrm = [];
	for (let i = 0; i <= n; i++) {
		const a = (Math.PI * 2 * i) / n;
		pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
		nrm.push([Math.cos(a), Math.sin(a)]);
	}
	P.save();
	if (horizontal) {
		P.translate(cx, cy, z).rotateX(-Math.PI / 2).translate(-cx, -cy, 0);
	} else P.translate(0, 0, z);
	sweep(P, pts, nrm, [[-w / 2, 0], [-w / 2, d * 0.7], [0, d], [w / 2, d * 0.7], [w / 2, 0]]);
	P.restore();
}

/** Urn finial (local) standing at (u, y, w). */
function urn(P, u, y, w, h) {
	P.box(u - 0.45, y, w - 0.45, u + 0.45, y + 0.35 * h / 1.8, w + 0.45, 'b');
	P.lathe([[0.36, 0], [0.36, 0.08], [0.2, 0.14], [0.22, 0.3], [0.38, 0.55], [0.42, 0.78], [0.3, 1.0], [0.14, 1.08], [0.18, 1.18], [0.06, 1.3], [0.0, 1.42]].map(([a, b]) => [a * h / 1.8, b * h / 1.8]), u, y + 0.35 * h / 1.8, w, { seg: 10, smooth: true });
}

// ---------------------------------------------------------------- glass screen

/** Height of the screen's top edge at local u (arch curve above the springing). */
function archTop(lay, u) {
	const t = (u - lay.uc) / lay.archA;
	if (Math.abs(t) >= 1) return lay.ys;
	return lay.ys + lay.archB * Math.sqrt(1 - t * t);
}

function screenPanes(P, lay, arch, zs, r) {
	const { TW, W, ys } = lay;
	// Rectangular part: panes in a grid (each its own tint), to the springing line.
	const u0 = TW + 0.05, u1 = W - TW - 0.05;
	const nx = 24, rows = 10;
	const pw = (u1 - u0) / nx, ph = (ys - 0.0) / rows;
	for (let i = 0; i < nx; i++) for (let j = 0; j < rows; j++) {
		const k = 0.82 + r() * 0.36;
		const lit = 0.6 + r() * 0.4;
		P.save();
		P.set({ c: mulc(P.s.c, k), lit });
		const x0 = u0 + i * pw, y0 = j * ph;
		P.quad([x0, y0, zs], [x0 + pw, y0, zs], [x0 + pw, y0 + ph, zs], [x0, y0 + ph, zs]);
		P.restore();
	}
	// Fan part: sectors between radial bars and two concentric rings.
	const seg = arch.pts.length - 1;
	const rings = [0, 0.38, 0.72, 1.0];
	for (let i = 0; i < seg; i++) for (let j = 0; j + 1 < rings.length; j++) {
		const a = arch.pts[i], b = arch.pts[i + 1];
		const p = (pt, f) => [lay.uc + (pt[0] - lay.uc) * f, ys + (pt[1] - ys) * f, zs];
		const k = 0.82 + r() * 0.36;
		P.save();
		P.set({ c: mulc(P.s.c, k), lit: 0.6 + r() * 0.4 });
		P.quad(p(b, rings[j]), p(a, rings[j]), p(a, rings[j + 1]), p(b, rings[j + 1]));
		P.restore();
	}
}

function screenBars(P, lay, arch, zs) {
	const { TW, W, ys, uc } = lay;
	const u0 = TW, u1 = W - TW;
	const nx = 24, pw = (u1 - u0) / nx;
	// Vertical mullions up to the springing (heavier every 4th), transoms every ~1.5 m.
	for (let i = 1; i < nx; i++) {
		const u = u0 + i * pw;
		const heavy = i % 4 === 0;
		const w = heavy ? 0.13 : 0.055;
		P.box(u - w, -0.3, zs, u + w, ys, zs + (heavy ? 0.42 : 0.18), 'b');
	}
	for (let j = 1; j <= 10; j++) {
		const y = (ys * j) / 10;
		const heavy = j % 5 === 0 || j === 10;
		P.box(u0, y - (heavy ? 0.16 : 0.05), zs, u1, y + (heavy ? 0.16 : 0.05), zs + (heavy ? 0.4 : 0.16), 'b');
	}
	// Fan: radial bars from the centre of the springing line and two elliptical rings.
	const seg = arch.pts.length - 1;
	for (let i = 1; i < seg; i++) {
		if (i % 2) continue;
		const p = arch.pts[i];
		const dx = p[0] - uc, dy = p[1] - ys, L = Math.hypot(dx, dy);
		const ang = Math.atan2(dy, dx);
		P.save();
		P.translate(uc, ys, 0).rotateZ(ang - Math.PI / 2);
		P.box(-0.06, 0.9, zs, 0.06, L, zs + 0.2, 'b');
		P.restore();
	}
	for (const f of [0.38, 0.72]) {
		const pts = arch.pts.map(([x, y]) => [uc + (x - uc) * f, ys + (y - ys) * f]);
		const nrm = arch.nrm;
		P.save();
		P.translate(0, 0, zs);
		sweep(P, pts, nrm, [[-0.07, 0], [-0.07, 0.22], [0.07, 0.22], [0.07, 0]]);
		P.restore();
	}
	// Hub of the fan with the MÁV emblem.
	P.save();
	P.translate(0, 0, zs);
	sweep(P, ellipseArch(uc, ys, 0.95, 0.95, 10).pts, ellipseArch(uc, ys, 0.95, 0.95, 10).nrm, [[-0.1, 0], [-0.1, 0.3], [0.12, 0.3], [0.12, 0]]);
	P.restore();
	// Frame along the arch curve.
	P.save();
	P.translate(0, 0, zs);
	sweep(P, arch.pts, arch.nrm, [[-0.25, 0], [-0.25, 0.35], [0.02, 0.35], [0.02, 0]]);
	P.restore();
}

// ---------------------------------------------------------------- portal

function buildPortal(P, ctx, lay, r) {
	const { TW, W, uc } = lay;
	const zw = -1.25; // portal wall plane
	const low = ctx.quality === 'low';
	// Bays: centre (door + lunette with the clock), two side bays, two narrow windows.
	const bays = [
		{ x: uc - 3.0, y: 0.05, w: 6.0, h: 9.9, head: 'round', centre: true },
		{ x: uc - 8.5, y: 0.05, w: 3.9, h: 8.5, head: 'round' },
		{ x: uc + 4.6, y: 0.05, w: 3.9, h: 8.5, head: 'round' },
		{ x: TW + 1.0, y: 2.2, w: 2.0, h: 5.8, head: 'round' },
		{ x: W - TW - 3.0, y: 2.2, w: 2.0, h: 5.8, head: 'round' },
	];
	P.save();
	P.translate(0, 0, zw);
	P.set({ c: C.stone, pat: PAT.ashlar, ps: 0.55, grime: 0.28, flood: 0.9 });
	const holes = bays.map((b) => openingOutline(b.x, b.y, b.w, b.h, 'round', 12));
	P.panel([[TW, -0.3], [W - TW, -0.3], [W - TW, 10.65], [TW, 10.65]], holes, 0);
	bays.forEach((b, i) => {
		P.set({ c: C.stoneLit, pat: 0 });
		openingFill(P, { ...b, depth: 0.55, lit: 0.95, frame: C.gate, mullions: b.centre ? 3 : 2, transom: 1, frameW: 0.09 }, holes[i], { rng: r, glassColour: mulc(C.glass, 0.22) });
		archBand(P, b.x + b.w / 2, b.y + b.h - b.w / 2, b.w / 2, b.w / 2 + 0.38, 0, 0.16, 12);
		P.box(b.x + b.w / 2 - 0.32, b.y + b.h - 0.12, 0, b.x + b.w / 2 + 0.32, b.y + b.h + 0.55, 0.3, 'b');
		if (b.y < 0.1) {
			// Wrought-iron gate leaves in the lower part of the door bays, with the gilt winged wheel.
			P.save();
			P.set({ c: C.gate, metal: 0.5, rough: 0.45, grime: 0.1, pat: 0, flood: 0.2 });
			const gh = b.centre ? 5.2 : 4.6;
			for (let gx = b.x + 0.2; gx < b.x + b.w - 0.1; gx += 0.22) P.box(gx - 0.02, 0.0, -0.32, gx + 0.02, gh, -0.28, 'b');
			for (const gy of [0.25, 1.1, gh * 0.6, gh - 0.1]) P.box(b.x, gy - 0.04, -0.34, b.x + b.w, gy + 0.04, -0.26, 'b');
			P.restore();
			const uvWheel = atlas().region('mav-wheel', 160, 160, wingedWheel);
			decalQuad(P, uvWheel, b.x + b.w / 2, b.centre ? 4.05 : 3.6, b.centre ? 1.5 : 1.1, b.centre ? 1.5 : 1.1, -0.25, { c: [1.0, 0.82, 0.45], emit: 0.12 });
		}
	});
	// Clock in the lunette of the centre bay.
	const cb = bays[0];
	const cy = cb.y + cb.h - cb.w / 2 + 0.25;
	lay.clock = { u: uc, y: cy, w: zw - 0.2, r: 1.22 };
	P.set({ c: C.gilt, metal: 0.6, rough: 0.35, pat: 0, flood: 0.3 });
	ringTorus(P, uc, cy, 1.32, 0.22, 0.22, 24, -0.42);
	const uvDial = atlas().region('keleti-dial', 256, 256, clockDial);
	decalQuad(P, uvDial, uc, cy, 2.44, 2.44, -0.4, { emit: 0.55, c: [1, 1, 1] });
	P.box(uc - 2.9, cb.y + cb.h - cb.w / 2 - 0.9, -0.5, uc + 2.9, cb.y + cb.h - cb.w / 2 - 0.62, 0.1, 'b'); // transom beam
	P.restore();

	// Columns on tall pedestals, standing in front of the wall.
	const colU = [uc - 9.25, uc - 3.8, uc + 3.8, uc + 9.25];
	const zc = -0.15, pedH = 2.5, colH = 8.15, entY = pedH + colH;
	P.set({ c: C.stone, pat: PAT.ashlar, ps: 0.6, flood: 0.9 });
	for (const u of colU) {
		P.box(u - 0.85, -0.3, zc - 0.85, u + 0.85, pedH - 0.25, zc + 0.85, 'b');
		P.set({ c: C.stoneLit, pat: 0 });
		P.box(u - 0.95, -0.3, zc - 0.95, u + 0.95, 0.35, zc + 0.95, 'b');
		P.box(u - 0.95, pedH - 0.25, zc - 0.95, u + 0.95, pedH, zc + 0.95, 'b');
		column(P, u, pedH, zc, colH, 0.5, { order: 'corinthian', flutes: low ? 0 : 16, seg: 14 });
		P.set({ c: C.stone, pat: PAT.ashlar, ps: 0.6 });
		lay.solids.push([[u - 0.95, zc - 0.95], [u + 0.95, zc - 0.95], [u + 0.95, zc + 0.95], [u - 0.95, zc + 0.95]].map(([a, b]) => fl(lay, a, b)));
	}
	// Entablature (architrave, frieze, cornice) across the portal, breaking forward over the columns.
	P.set({ c: C.stoneLit, pat: 0, grime: 0.3 });
	P.save();
	P.translate(0, entY, zw);
	const ent = [[0, 0], [1.75, 0], [1.75, 0.22], [1.8, 0.24], [1.8, 0.5], [1.86, 0.52], [1.86, 0.62], [1.7, 0.64], [1.7, 1.02], [1.8, 1.06], [1.95, 1.12], [2.25, 1.22], [2.3, 1.38], [2.38, 1.42], [2.38, 1.5], [0, 1.5]];
	P.extrude(ent, colU[0] - 1.2, colU[3] + 1.2, true);
	P.restore();
	// Inscription band in the frieze.
	const uvPort = atlas().region('keleti-frieze', 320, 32, (g, w, h) => inscription(g, w, h, 'KELETI PÁLYAUDVAR', '#4a4236', 0.0));
	void uvPort;
	// Balustrade on top with pedestals carrying the four allegorical statues.
	const by = entY + 1.5;
	balustrade(P, colU[0] - 1.1, colU[3] + 1.1, by, { h: 1.15, spacing: 0.33, depth: 0.42, z: zc + 0.4, low });
	const poses = [
		{ h: 2.9, robe: 'gown', head: 'veil', armL: [0.5, 0.2, 0.9], holdL: 'staff', armR: [0.4, 0.15, 1.2] }, // spinning woman
		{ h: 2.9, robe: 'coat', head: 'hat', armR: [0.2, 0.15, 0.9], holdR: 'hammer', armL: [0.05, 0.1, 0.3] }, // miner
		{ h: 2.9, robe: 'gown', head: 'hair', armL: [0.5, 0.25, 0.9], holdL: 'sheaf', armR: [0.2, 0.1, 0.5] }, // sheaf-binding woman
		{ h: 2.9, robe: 'coat', head: 'hat', armR: [0.5, 0.1, 1.1], holdR: 'book', armL: [0.05, 0.12, 0.35] }, // merchant
	];
	colU.forEach((u, i) => {
		P.set({ c: C.stone, pat: PAT.ashlar, ps: 0.6 });
		P.box(u - 0.75, by, zc - 0.55, u + 0.75, by + 1.45, zc + 0.95, 'b');
		P.set({ c: C.stoneLit, pat: 0 });
		P.box(u - 0.85, by + 1.45, zc - 0.65, u + 0.85, by + 1.62, zc + 1.05, 'b');
		P.save();
		P.set({ c: C.statue, pat: 0, grime: 0.3, rough: 0.75, flood: 0.8 });
		P.translate(u, by + 1.62, zc + 0.25);
		figure(P, poses[i]);
		P.restore();
	});
}

// ---------------------------------------------------------------- train shed

/** Catenary cross-section of the hall: t ∈ [-1, 1] → height. */
function shedY(t, H) {
	const a = 2.1;
	return H * (1 - (Math.cosh(a * t) - 1) / (Math.cosh(a) - 1));
}

function buildShed(P, lay) {
	const { x0, x1, z0, z1 } = lay.hall;
	const zc = (z0 + z1) / 2, hw = (z1 - z0) / 2, H = 31.2;
	const N = 28;
	const prof = [];
	for (let i = 0; i <= N; i++) {
		const t = -1 + (2 * i) / N;
		prof.push([zc + t * hw, shedY(t, H), t]);
	}
	const xa = lay.backX + 0.02, xb = x1;
	P.save();
	P.M.identity(); P.N.identity();
	const isGlass = (t) => Math.abs(t) < 0.27 || (Math.abs(t) > 0.5 && Math.abs(t) < 0.6);
	for (let i = 0; i < N; i++) {
		const [za, ya, ta] = prof[i], [zb, yb, tb] = prof[i + 1];
		const tm = (ta + tb) / 2;
		if (ya < 6 && yb < 6) continue; // hidden by the wings
		if (isGlass(tm)) P.set({ ch: 'glass', c: [0.07, 0.085, 0.095], lit: 0.65, glow: [1.0, 0.82, 0.58] });
		else P.set({ ch: 'solid', c: mixc(C.slate, C.zinc, 0.25), pat: PAT.seam, ps: 0.62, metal: 0.35, rough: 0.55, grime: 0.15, flood: 0 });
		// Quad along x; outward normal points up/out (away from the hall axis).
		P.quad([xb, ya, za], [xa, ya, za], [xa, yb, zb], [xb, yb, zb]);
	}
	// Glazing bars across the glass bands and raised ribs every ~9.7 m.
	P.set({ ch: 'solid', c: C.iron, pat: 0, metal: 0.45, rough: 0.5, grime: 0.1 });
	const ribStep = (xb - xa) / Math.round((xb - xa) / 9.7);
	for (let x = xa + ribStep; x < xb - 1; x += ribStep) shedRib(P, prof, x, 0.32, 0.38);
	for (let x = xa + 1.2; x < xb - 0.5; x += 2.4) shedRib(P, prof, x, 0.05, 0.08, isGlass);
	// Ridge cap and the ventilation lantern strip along the crown.
	P.set({ c: mixc(C.slate, C.zinc, 0.4), pat: PAT.seam, ps: 0.5, metal: 0.35 });
	P.box(xa, H - 0.05, zc - 1.6, xb, H + 0.9, zc + 1.6, 'b');
	P.set({ ch: 'glass', c: [0.06, 0.07, 0.08], lit: 0.5 });
	P.quad([xa, H + 0.05, zc + 1.62], [xb, H + 0.05, zc + 1.62], [xb, H + 0.75, zc + 1.62], [xa, H + 0.75, zc + 1.62]);
	P.quad([xb, H + 0.05, zc - 1.62], [xa, H + 0.05, zc - 1.62], [xa, H + 0.75, zc - 1.62], [xb, H + 0.75, zc - 1.62]);
	P.set({ ch: 'solid', c: mixc(C.slate, C.zinc, 0.4), pat: PAT.seam, ps: 0.5, metal: 0.35 });
	P.box(xa, H + 0.85, zc - 2.0, xb, H + 1.05, zc + 2.0, 'b');
	// East gable: glazed screen in the catenary outline with an iron grid.
	const gable = prof.map(([z, y]) => [z, y]);
	P.save();
	P.M.copy(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0)).setPosition(xb, 0, 0));
	P.N.getNormalMatrix(P.M);
	// local x = -z world, so flip the gable outline into local coordinates.
	const gl = gable.map(([z, y]) => [-z, y]).reverse();
	P.set({ ch: 'glass', c: [0.07, 0.08, 0.09], lit: 0.5 });
	P.panel(gl.filter(([, y]) => y >= 0), [], -0.6);
	P.set({ ch: 'solid', c: C.iron, metal: 0.45, rough: 0.5, pat: 0 });
	for (let k = 1; k < 16; k++) {
		const zz = z0 + ((z1 - z0) * k) / 16;
		const t = (zz - zc) / hw;
		P.box(-zz - 0.07, 6, -0.6, -zz + 0.07, shedY(t, H), -0.4, 'b');
	}
	for (let y = 9; y < H; y += 3.2) {
		const t = Math.sqrt(Math.max(0, 1 - y / H)) * 0.98;
		const half = hw * Math.min(1, t * 1.05);
		P.box(-zc - half, y - 0.07, -0.6, -zc + half, y + 0.07, -0.4, 'b');
	}
	P.set({ c: mixc(C.slate, C.zinc, 0.3), pat: PAT.seam, ps: 0.6, metal: 0.35 });
	sweep(P, gl.map(([z, y]) => [z, y]), gl.map((_, i) => {
		const a = gl[Math.max(0, i - 1)], b = gl[Math.min(gl.length - 1, i + 1)];
		const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
		return [dy / l, -dx / l];
	}), [[-0.1, -0.8], [-0.1, 0.4], [0.5, 0.4], [0.5, -0.8]]);
	P.restore();
	P.restore();
}

/** A rib following the shed profile at x (optionally only where `where(t)` is true). */
function shedRib(P, prof, x, w, h, where = null) {
	for (let i = 0; i + 1 < prof.length; i++) {
		const [za, ya, ta] = prof[i], [zb, yb, tb] = prof[i + 1];
		if (ya < 6 && yb < 6) continue;
		if (where && !where((ta + tb) / 2)) continue;
		// Normal of the roof segment (outward).
		const dz = zb - za, dy = yb - ya, l = Math.hypot(dz, dy) || 1;
		const nz = -dy / l * Math.sign(za - (prof[0][0] + prof[prof.length - 1][0]) / 2 || 1) * 0;
		void nz;
		let onz = dy / l, ony = -dz / l;
		// Make the normal point away from the hall interior (up).
		if (ony < 0) { onz = -onz; ony = -ony; }
		const A = [za + onz * h, ya + ony * h], B = [zb + onz * h, yb + ony * h];
		P.quad([x - w, A[1], A[0]], [x + w, A[1], A[0]], [x + w, B[1], B[0]], [x - w, B[1], B[0]]);
		P.quad([x + w, ya, za], [x + w, yb, zb], [x + w, B[1], B[0]], [x + w, A[1], A[0]]);
		P.quad([x - w, yb, zb], [x - w, ya, za], [x - w, A[1], A[0]], [x - w, B[1], B[0]]);
	}
}

// ---------------------------------------------------------------- pavilions and side wings

function buildWings(P, lay, byId) {
	const parts = [ID.pavNW, ID.pavSW, ID.pavNE, ID.pavSE, ID.lotzN, ID.midS, ID.wingNW, ID.wingNE, ID.wingSW, ID.wingSE].map((id) => byId.get(id)).filter(Boolean);
	const rings = new Map(parts.map((b) => [b.id, orientRing(b.outer)]));
	const allRings = [...rings.values(), ringOf(byId.get(ID.hall)), ringOf(byId.get(ID.front))].filter(Boolean);
	// An edge is exterior if a point 0.8 m outside its middle is in no other station part.
	const exteriorFor = (own) => (e) => {
		const px = e.mid[0] + e.nx * 0.8, pz = e.mid[1] + e.nz * 0.8;
		return !allRings.some((r2) => r2 !== own && inside(r2, px, pz));
	};
	const r = rng(77);
	for (const b of parts) {
		const ring = rings.get(b.id);
		const pav = b.id === ID.pavNW || b.id === ID.pavSW || b.id === ID.pavNE || b.id === ID.pavSE || b.id === ID.lotzN || b.id === ID.midS;
		const front = b.id === ID.pavNW || b.id === ID.pavSW;
		// The side wings and back parts are visibly decayed; the front pavilions were renewed with the centre.
		const grime = front ? 0.45 : pav ? 0.7 : 0.85;
		const wall = front ? mixc(C.stone, C.wing, 0.4) : mixc(C.wing, C.wingPatch, r() * 0.5);
		if (pav) {
			buildingShell(P, ring, {
				wall, trim: front ? C.stoneLit : mixc(C.stoneLit, C.wing, 0.5), plinthC: C.granite, frame: C.frame, grime, flood: front ? 0.55 : 0.25,
				plinth: 1.0, top: 17.0, pitch: 4.9, margin: 2.2, quoins: true,
				floors: [
					{ y0: 0, y1: 6.6, rustic: 0.55, win: { w: 2.3, h: 4.6, sill: 1.0, head: 'round', surround: 'frame', depth: 0.45 }, door: front ? 'centre' : null, doorW: 2.8, doorH: 5.6 },
					{ y0: 6.6, y1: 12.6, win: { w: 2.0, h: 3.6, sill: 1.1, head: 'flat', surround: 'frame', pediment: 'cornice', depth: 0.38 }, pilasters: { w: 0.55, order: 'corinthian' } },
					{ y0: 12.6, y1: 15.4, win: { w: 1.6, h: 1.25, sill: 0.7, head: 'flat', surround: 'frame', depth: 0.3 } },
				],
				bands: [{ y: 6.45, k: 1.0 }, { y: 12.45, k: 0.9 }],
				cornice: { y: 15.4, k: 1.3 },
				parapet: { h: 0.9, kind: 'balustrade', ped: 4.9 },
				roof: { type: 'mansard', y: 17.6, h: 4.6, inset: 1.6, h2: 1.4, inset2: 4.5, colour: C.slate, colour2: C.zinc, dormers: { pitch: 4.9, w: 1.2, h: 1.6, colour: C.stoneLit } },
				litShare: 0.25,
			}, { exterior: exteriorFor(ring), rng: r });
			// Iron cresting along the mansard top (a thin railing).
			cresting(P, ring, 17.6 + 4.6 + 1.4 * 0.95, 4.3);
		} else {
			buildingShell(P, ring, {
				wall, trim: mixc(C.stoneLit, C.wing, 0.55), plinthC: C.granite, frame: C.frame, grime, flood: 0.15,
				plinth: 0.9, top: 12.4, pitch: 4.7, margin: 1.6, quoins: false,
				floors: [
					{ y0: 0, y1: 6.2, rustic: 0.5, win: { w: 2.2, h: 4.4, sill: 0.9, head: 'round', surround: 'frame', depth: 0.42 }, door: (i, n) => i % 4 === 2, doorW: 2.4, doorH: 5.0 },
					{ y0: 6.2, y1: 11.0, win: { w: 2.0, h: 3.4, sill: 0.8, head: 'round', surround: 'frame', depth: 0.36 } },
				],
				bands: [{ y: 6.05, k: 0.9 }],
				cornice: { y: 11.0, k: 1.1 },
				parapet: { h: 0.6, kind: 'attic' },
				roof: { type: 'hip', y: 11.6 + 0.6, h: 2.6, inset: 3.5, colour: mixc(C.slate, C.zinc, 0.2), pat: PAT.seam, ps: 0.6, metal: 0.3 },
				litShare: 0.18,
			}, { exterior: exteriorFor(ring), rng: r });
		}
	}
}

/** Thin iron cresting railing around a ring inset by `inset` at height y. */
function cresting(P, ring, y, inset) {
	const o = offsetRing(orientRing(ring), -inset);
	P.save();
	P.set({ c: C.iron, metal: 0.45, rough: 0.5, grime: 0.1, pat: 0, flood: 0 });
	const edges = ringEdges(o);
	for (const e of edges) {
		if (e.len < 1) continue;
		P.save();
		P.edge(e.a[0], e.a[1], e.b[0], e.b[1], y);
		P.box(0, 0.55, -0.03, e.len, 0.6, 0.03, 'b');
		for (let u = 0.4; u < e.len; u += 0.4) P.box(u - 0.015, 0, -0.015, u + 0.015, u % 1.2 < 0.4 ? 0.9 : 0.6, 0.015, 'b');
		P.restore();
	}
	P.restore();
}

// ---------------------------------------------------------------- clock hands (live time)

function buildClockHands(ctx, lay) {
	if (!lay.clock) return null;
	const { u, y, w } = lay.clock;
	const m = new THREE.Matrix4().multiplyMatrices(lay.frontM, new THREE.Matrix4().makeTranslation(u, y, w + 0.03));
	const g = new THREE.BufferGeometry();
	const pos = new Float32Array(2 * 4 * 3);
	g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
	g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
	g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(24).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
	const mat = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.5, metalness: 0.3, side: THREE.DoubleSide });
	const mesh = new THREE.Mesh(g, mat);
	mesh.matrixAutoUpdate = false;
	mesh.matrix.copy(m);
	mesh.frustumCulled = false;
	mesh.name = 'keleti:clock-hands';
	ctx.root.add(mesh);
	let lastMin = -1;
	const set = (k, ang, len, wid, tail) => {
		const s = Math.sin(ang), c = Math.cos(ang);
		const pts = [[-wid, -tail], [wid, -tail], [wid * 0.45, len], [-wid * 0.45, len]];
		pts.forEach(([px, py], i) => {
			pos[(k * 4 + i) * 3] = px * c + py * s;
			pos[(k * 4 + i) * 3 + 1] = -px * s + py * c;
			pos[(k * 4 + i) * 3 + 2] = k * 0.02;
		});
	};
	const update = (hours) => {
		const mins = Math.floor(hours * 60);
		if (mins === lastMin) return;
		lastMin = mins;
		const hh = (hours % 12) / 12, mm = (hours % 1);
		set(0, hh * Math.PI * 2, 0.62, 0.055, 0.12);
		set(1, mm * Math.PI * 2, 0.98, 0.04, 0.16);
		g.attributes.position.needsUpdate = true;
		g.computeBoundingSphere();
	};
	update(10.1);
	ctx.onUpdate((frame) => {
		if (typeof frame.hours === 'number' && isFinite(frame.hours)) update(frame.hours);
	});
	return mesh;
}

// ---------------------------------------------------------------- Baross tér

function buildBarossStatue(P, ctx, x, z) {
	// Faces Rákóczi út (towards the west-south-west), Keleti behind it.
	const yaw = Math.atan2(-0.92, 0.39);
	P.save();
	P.at(x, 0, z, yaw);
	P.set({ c: C.limestone, pat: PAT.ashlar, ps: 0.45, grime: 0.3, rough: 0.8, flood: 0.5, floodH: 12, metal: 0 });
	// Granite steps, the limestone pedestal with mouldings and the inscription.
	P.box(-3.6, -0.3, -3.6, 3.6, 0.32, 3.6, 'b');
	P.box(-3.0, 0.32, -3.0, 3.0, 0.64, 3.0, 'b');
	P.set({ pat: 0 });
	P.box(-1.9, 0.64, -1.9, 1.9, 1.3, 1.9, 'b');
	P.set({ pat: PAT.ashlar, ps: 0.6 });
	P.box(-1.55, 1.3, -1.55, 1.55, 5.6, 1.55, 'b');
	P.set({ pat: 0 });
	for (const [y, k] of [[1.3, 0.55], [5.4, 0.8]]) {
		P.save();
		P.translate(0, y, 0);
		for (let side = 0; side < 4; side++) {
			P.save();
			P.rotateY((side * Math.PI) / 2).translate(0, 0, 1.55);
			P.extrude(PROFILES.band(k), -1.55 - 0.3 * k, 1.55 + 0.3 * k, false);
			P.restore();
		}
		P.restore();
	}
	P.box(-1.75, 5.85, -1.75, 1.75, 6.25, 1.75, 'b');
	P.box(-1.25, 6.25, -1.25, 1.25, 6.75, 1.25, 'b');
	const uv = atlas().region('baross-name', 256, 64, (g, w, h) => inscription(g, w, h, 'BAROSS', '#2c2a26', 0.0, 'bold 44px Georgia, serif'));
	decalQuad(P, uv, 0, 4.1, 2.2, 0.55, 1.56, { c: [0.9, 0.85, 0.7] });
	// Bronze: Baross standing on top, Commerce and Industry seated at the front corners, a genius below.
	P.set({ c: C.bronze, metal: 0.45, rough: 0.5, grime: 0.15, pat: 0, flood: 0.45 });
	P.save();
	P.translate(0, 6.75, 0);
	figure(P, { h: 4.6, robe: 'coat', head: 'bare', armR: [0.7, 0.15, 0.45], armL: [0.05, 0.1, 0.9], holdL: 'scroll', stride: 0.15 });
	P.restore();
	for (const sx of [-1, 1]) {
		P.save();
		P.translate(sx * 1.85, 0.64, 1.4).rotateY(sx * 0.35);
		figure(P, sx < 0
			? { h: 3.4, seated: true, robe: 'gown', head: 'hair', armL: [0.5, 0.4, 0.6], holdL: 'staff', armR: [0.3, 0.2, 0.9], cloak: true }
			: { h: 3.4, seated: true, robe: 'gown', head: 'helmet', armR: [0.4, 0.3, 0.5], holdR: 'hammer', armL: [0.3, 0.3, 0.8], holdL: 'wheel' });
		P.restore();
	}
	P.save();
	P.translate(0, 1.3, 1.85);
	figure(P, { h: 1.6, robe: 'none', head: 'hair', wings: 1.2, armR: [1.2, 0.3, 0.2], holdR: 'wreath', armL: [0.2, 0.2, 0.4] });
	P.restore();
	P.restore();
	ctx.addSolidBox(x, z, 7.4, 7.4, yaw);
}

/** A small steel-and-glass shelter on an OSM outline (mapped as a 16 m block). */
function buildShelter(P, ctx, outer) {
	const ring = orientRing(outer);
	const edges = ringEdges(ring).sort((a, b) => b.len - a.len);
	const e = edges[0];
	const len = e.len;
	const depth = edges[2] ? edges[2].len : 1.6;
	P.save();
	P.edge(e.a[0], e.a[1], e.b[0], e.b[1], 0);
	P.set({ c: [0.35, 0.37, 0.39], metal: 0.5, rough: 0.4, grime: 0.1, pat: 0, flood: 0 });
	for (const u of [0.1, len - 0.1]) for (const w of [-0.1, -depth + 0.1]) P.box(u - 0.05, 0, w - 0.05, u + 0.05, 2.55, w + 0.05, 'b');
	P.box(-0.1, 2.55, -depth - 0.15, len + 0.1, 2.7, 0.15, 'b');
	P.set({ ch: 'glass', c: [0.2, 0.24, 0.26], lit: 0 });
	P.quad([0.1, 0.25, -depth + 0.1], [len - 0.1, 0.25, -depth + 0.1], [len - 0.1, 2.5, -depth + 0.1], [0.1, 2.5, -depth + 0.1]);
	P.quad([len - 0.1, 0.25, -depth + 0.12], [0.1, 0.25, -depth + 0.12], [0.1, 2.5, -depth + 0.12], [len - 0.1, 2.5, -depth + 0.12]);
	P.set({ ch: 'solid', c: [0.25, 0.22, 0.2], metal: 0.3, rough: 0.6 });
	P.box(0.4, 0.45, -depth + 0.15, len - 0.4, 0.5, -depth + 0.55, 'b');
	P.restore();
	ctx.addWall(...offsetPoint(e, -depth + 0.1), ...offsetPoint(e, -depth + 0.1, true));
}

function offsetPoint(e, w, end = false) {
	const p = end ? e.b : e.a;
	return [p[0] + e.nx * w, p[1] + e.nz * w];
}

// ---------------------------------------------------------------- atlas drawings

function clockDial(g, w, h) {
	const cx = w / 2, cy = h / 2, R = w / 2 - 2;
	g.fillStyle = '#f2efe6';
	g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
	const gr = g.createRadialGradient(cx, cy, R * 0.2, cx, cy, R);
	gr.addColorStop(0, 'rgba(255,255,255,0)');
	gr.addColorStop(1, 'rgba(120,110,90,0.25)');
	g.fillStyle = gr;
	g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
	g.strokeStyle = '#151515';
	g.lineWidth = 3;
	g.beginPath(); g.arc(cx, cy, R * 0.93, 0, Math.PI * 2); g.stroke();
	for (let i = 0; i < 60; i++) {
		const a = (i / 60) * Math.PI * 2;
		const major = i % 5 === 0;
		g.lineWidth = major ? 9 : 2.5;
		const r0 = major ? R * 0.68 : R * 0.84, r1 = R * 0.9;
		g.beginPath();
		g.moveTo(cx + Math.sin(a) * r0, cy - Math.cos(a) * r0);
		g.lineTo(cx + Math.sin(a) * r1, cy - Math.cos(a) * r1);
		g.stroke();
	}
	g.fillStyle = '#151515';
	g.beginPath(); g.arc(cx, cy, 7, 0, Math.PI * 2); g.fill();
}

function tablet(g, w, h, text) {
	g.fillStyle = '#7d7462';
	g.fillRect(0, 0, w, h);
	g.strokeStyle = '#5c5446';
	g.lineWidth = 4;
	g.strokeRect(4, 4, w - 8, h - 8);
	g.fillStyle = '#c8a960';
	g.font = 'bold 44px Georgia, "Times New Roman", serif';
	g.textAlign = 'center';
	g.textBaseline = 'middle';
	g.fillText(text.split('').join(' '), w / 2, h / 2 + 2);
}

function inscription(g, w, h, text, colour, weather = 0, font = null) {
	g.fillStyle = 'rgba(0,0,0,0)';
	g.clearRect(0, 0, w, h);
	g.font = font || `bold ${Math.round(h * 0.78)}px Georgia, "Times New Roman", serif`;
	g.textAlign = 'center';
	g.textBaseline = 'middle';
	g.fillStyle = colour;
	const spaced = text.split('').join(String.fromCharCode(8202));
	g.fillText(spaced, w / 2, h / 2 + 1, w - 6);
	if (weather > 0) {
		// Patchy weathering: erase random flecks so the letters read old and recessed.
		g.globalCompositeOperation = 'destination-out';
		const r = rng(31);
		for (let i = 0; i < w * h * 0.04 * weather; i++) {
			g.fillStyle = `rgba(0,0,0,${0.2 + r() * 0.5})`;
			g.fillRect(r() * w, r() * h, 1 + r() * 3, 1 + r() * 2);
		}
		g.globalCompositeOperation = 'source-over';
	}
}

/** MÁV winged wheel (szárnyas kerék): a spoked wheel with two spread wings, cream relief on transparent. */
function wingedWheel(g, w, h) {
	g.clearRect(0, 0, w, h);
	const cx = w / 2, cy = h / 2;
	g.fillStyle = '#e8dfca';
	g.strokeStyle = '#e8dfca';
	// Wings.
	for (const s of [-1, 1]) {
		g.beginPath();
		g.moveTo(cx + s * 14, cy - 6);
		g.quadraticCurveTo(cx + s * 50, cy - 40, cx + s * 76, cy - 34);
		g.quadraticCurveTo(cx + s * 60, cy - 20, cx + s * 70, cy - 14);
		g.quadraticCurveTo(cx + s * 52, cy - 6, cx + s * 62, cy + 2);
		g.quadraticCurveTo(cx + s * 40, cy + 6, cx + s * 14, cy + 8);
		g.closePath();
		g.fill();
	}
	// Wheel: rim, hub, spokes.
	g.lineWidth = 7;
	g.beginPath(); g.arc(cx, cy, 26, 0, Math.PI * 2); g.stroke();
	g.lineWidth = 4;
	for (let i = 0; i < 8; i++) {
		const a = (i / 8) * Math.PI * 2;
		g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * 24, cy + Math.sin(a) * 24); g.stroke();
	}
	g.beginPath(); g.arc(cx, cy, 7, 0, Math.PI * 2); g.fill();
	// Rail under the wheel.
	g.fillRect(cx - 40, cy + 30, 80, 6);
}
