// Fiumei úti sírkert (Kerepesi temető): the main gate on Fiumei út and the cemetery wall along the
// street. The gate ensemble: the wide wrought-iron carriage gate with a curved top and a crest,
// between two big rusticated stone piers carrying urns, pedestrian gates and smaller piers with
// stone balls either side, railings on a stone plinth, and the two ochre gate lodges with hipped
// roofs (the left one carries the "FIUMEI ÚTI SÍRKERT" lettering). The plastered wall with
// pilasters and a stone coping follows Fiumei út north and south of the gate.
//
// TODO (next steps): the Kossuth, Batthyány and Deák mausoleums, the arcades (OSM historic=tomb
// strips south of the main avenue), instanced grave rows and cemetery trees inside.
import * as THREE from '../../vendor/three.module.min.js';
import { toXZ } from '../../geo.js';
import { Mesher, Frame, finish, rgb, shade, windowAt } from './b-kit.js';
import { signTex, CELL } from './b-tex.js';

const OCHRE = rgb('#cdbb94'), STONE = rgb('#cfc6b4'), WALL = rgb('#bdb096'), PLINTH = rgb('#8e877c'), ROOF = rgb('#5b5f63'), IRON = rgb('#1f2221'), GILT = rgb('#b8954f');
const WALL_OFF = 11; // wall line: metres east of the Fiumei út centreline
const WALL_H = 3.1;

/**
 * Layout of the gate ensemble along the wall (local x, centred on the gate): piers, iron gates
 * and railing runs within ±span/2, lodges beyond. Pure (testable).
 */
export function gatePlan(span = 30) {
	const main = 6.4, big = 1.5, side = 2.4, small = 1.0;
	const xb = main / 2 + big / 2, xs = xb + big / 2 + side + small / 2;
	const piers = [
		{ x: -xs, w: small, h: 3.9, big: false }, { x: -xb, w: big, h: 5.3, big: true },
		{ x: xb, w: big, h: 5.3, big: true }, { x: xs, w: small, h: 3.9, big: false },
	];
	const end = span / 2;
	if (end > xs + small / 2 + 2) piers.push({ x: -end + small / 2, w: small, h: 3.4, big: false }, { x: end - small / 2, w: small, h: 3.4, big: false });
	piers.sort((a, b) => a.x - b.x);
	const gates = [
		{ x0: -main / 2, x1: main / 2, h: 4.2, main: true },
		{ x0: -xs + small / 2, x1: -xb - big / 2, h: 3.1, main: false },
		{ x0: xb + big / 2, x1: xs - small / 2, h: 3.1, main: false },
	];
	const rails = end > xs + small / 2 + 2 ? [[-end + small, -xs - small / 2], [xs + small / 2, end - small]] : [];
	return { piers, gates, rails, lodges: [[-end - 10, -end], [end, end + 10]] };
}

/** Principal direction of a point set (unit [ux, uz]). */
function principal(pts) {
	let mx = 0, mz = 0;
	for (const [x, z] of pts) { mx += x; mz += z; }
	mx /= pts.length; mz /= pts.length;
	let a = 0, b = 0, c = 0;
	for (const [x, z] of pts) { const dx = x - mx, dz = z - mz; a += dx * dx; b += dx * dz; c += dz * dz; }
	const ang = 0.5 * Math.atan2(2 * b, a - c);
	return [Math.cos(ang), Math.sin(ang)];
}

/** Point in polygon (ring of [x, z]). */
function inside(ring, x, z) {
	let r = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, zi] = ring[i], [xj, zj] = ring[j];
		if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) r = !r;
	}
	return r;
}

export default {
	id: 'kerepesi',
	name: 'Fiumei úti sírkert',
	lat: 47.49378,
	lon: 19.08636,
	match: () => false,
	build(ctx, site) {
		const road = [];
		// Fiumei út centreline points, densified every 4 m (the OSM segments are long and straight).
		for (const r of ctx.data.roads) {
			if (r.name !== 'Fiumei út') continue;
			for (let i = 0; i + 1 < r.pts.length; i++) {
				const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
				const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 4));
				for (let j = 0; j < k; j++) road.push([ax + ((bx - ax) * j) / k, az + ((bz - az) * j) / k]);
			}
			road.push(r.pts[r.pts.length - 1]);
		}
		if (road.length < 2) return;
		// Base point: the Fiumei út – Teleki László tér junction nearest the reference point.
		let base = road[0], bd = Infinity;
		for (const p of road) { const d = Math.hypot(p[0] - site.x, p[1] - site.z); if (d < bd) { bd = d; base = p; } }
		let u = principal(road.filter((p) => Math.hypot(p[0] - base[0], p[1] - base[1]) < 150));
		if (u[1] < 0) u = [-u[0], -u[1]]; // along = towards the south-east
		let n = [u[1], -u[0]]; // east of the road
		if (n[0] < 0) n = [-n[0], -n[1]];
		const along = (p) => (p[0] - base[0]) * u[0] + (p[1] - base[1]) * u[1];
		const off = (p) => (p[0] - base[0]) * n[0] + (p[1] - base[1]) * n[1];
		const at = (a, o) => [base[0] + u[0] * a + n[0] * o, base[1] + u[1] * a + n[1] * o];
		// The gate lines up with the start of the main avenue (Arany János út) when it is mapped.
		let gateA = 6;
		const ave = ctx.data.roads.find((r) => r.name === 'Arany János út');
		if (ave) { const p = ave.pts.reduce((a, q) => (off(q) < off(a) ? q : a)); if (Math.abs(along(p)) < 40) gateA = along(p); }
		// Wall line: the road's east edge (max offset of the nearby road points) + WALL_OFF.
		const offAt = (a) => {
			let best = null;
			for (const p of road) if (Math.abs(along(p) - a) < 6) { const o = off(p); if (o < 25 && (best == null || o > best)) best = o; }
			return best;
		};
		const m = new Mesher();
		m.flood = null;
		const plan = gatePlan(30);
		const gOff = (offAt(gateA) ?? 0) + WALL_OFF;
		const [gx, gz] = at(gateA, gOff);
		const yaw = Math.atan2(-n[0], -n[1]);
		const G = new Frame(gx, gz, yaw); // +z points to the street, x along the wall
		const gapA0 = gateA - (plan.lodges[1][1] + 0.5), gapA1 = gateA + (plan.lodges[1][1] + 0.5);

		// --------------------------------------------------------------- the cemetery wall
		const near = ctx.data.buildings.filter((b) => Math.hypot(b.cx - gx, b.cz - gz) < 700 && !(b.tags && b.tags.historic === 'tomb'));
		const blocked = (x, z) => near.some((b) => Math.hypot(b.cx - x, b.cz - z) < 120 && b.outer.some(([bx, bz]) => Math.hypot(bx - x, bz - z) < 4) || (Math.hypot(b.cx - x, b.cz - z) < 120 && inside(b.outer, x, z)));
		const STEP = 6;
		let prev = null;
		for (let a = -480; a <= 282; a += STEP) {
			const o = offAt(a);
			const inGap = a > gapA0 - STEP && a < gapA1;
			if (o == null || inGap) { prev = null; continue; }
			const p = at(a, o + WALL_OFF);
			if (blocked(p[0], p[1])) { prev = null; continue; }
			if (prev) wallPiece(m, ctx, prev, p);
			prev = p;
		}
		// Short pieces from the lodges to the regular wall rhythm.
		for (const s of [-1, 1]) {
			const a0 = gateA + s * (plan.lodges[1][1] + 0.2), a1 = s < 0 ? Math.floor((gapA0 - STEP) / STEP) * STEP : Math.ceil(gapA1 / STEP) * STEP;
			const o0 = offAt(a0), o1 = offAt(a1);
			if (o0 != null && o1 != null) wallPiece(m, ctx, at(a0, gOff), at(a1, o1 + WALL_OFF));
		}

		// --------------------------------------------------------------- the gate ensemble
		for (const p of plan.piers) pier(m, ctx, G, p);
		for (const g of plan.gates) ironGate(m, ctx, G, g);
		for (const [x0, x1] of plan.rails) railing(m, ctx, G, x0, x1);
		const sign = signTex('FIUMEI ÚTI SÍRKERT', { w: 1024, h: 96, colour: '#3c3326', glow: '#1a140c', font: '600 70px Georgia, "Times New Roman", serif', letterSpacing: 10 });
		plan.lodges.forEach(([x0, x1], k) => lodge(m, ctx, G, x0, x1, k === 0)); // left one, seen from the street
		const signMat = new THREE.MeshStandardMaterial({ map: sign.map, alphaTest: 0.4, roughness: 0.6, metalness: 0.2 });
		finish(m, ctx, ctx.root, { sign: signMat }, { name: 'kerepesi' });
	},
};

/** One straight piece of the cemetery wall between two points (street face first). */
function wallPiece(m, ctx, a, b) {
	const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
	if (len < 0.3) return;
	// Frame at a, x towards b; +z must point to the street (west of the wall).
	const yaw = Math.atan2(-(b[1] - a[1]), b[0] - a[0]);
	let F = new Frame(a[0], a[1], yaw);
	let x0 = 0, x1 = len;
	const [zx] = F.d(0, 0, 1);
	if (zx > 0) { F = new Frame(a[0], a[1], yaw + Math.PI); x0 = -len; x1 = 0; }
	m.tint = PLINTH;
	m.box('stone', F, x0, 0, -0.62, x1, 0.55, 0.08, { top: false });
	m.tint = WALL;
	m.box('plaster', F, x0, 0.55, -0.55, x1, WALL_H, 0.0, { top: false });
	m.tint = STONE;
	m.box('stone', F, x0 - 0.02, WALL_H, -0.68, x1 + 0.02, WALL_H + 0.18, 0.13);
	m.poly('stone', F, [[x0, WALL_H + 0.18, 0.05], [x1, WALL_H + 0.18, 0.05], [x1, WALL_H + 0.36, -0.27], [x0, WALL_H + 0.36, -0.27]]);
	m.poly('stone', F, [[x1, WALL_H + 0.18, -0.6], [x0, WALL_H + 0.18, -0.6], [x0, WALL_H + 0.36, -0.27], [x1, WALL_H + 0.36, -0.27]]);
	// Pilaster at the start of every piece (also hides the joints).
	m.box('stone', F, -0.32, 0, -0.75, 0.32, WALL_H + 0.45, 0.16); // at point a (local x = 0)
	ctx.addWall(a[0], a[1], b[0], b[1]);
}

/** A stone gate pier: rusticated shaft, cornice, urn (big) or ball (small). */
function pier(m, ctx, G, p) {
	const w = p.w, h = p.h;
	m.tint = PLINTH;
	m.cbox('stone', G, p.x, 0, 0, w + 0.3, 0.7, w + 0.3);
	m.tint = STONE;
	m.cbox('stone', G, p.x, 0.7, 0, w - 0.08, h - 0.7, w - 0.08);
	// Rustication: protruding blocks with shadow joints.
	for (let y = 0.8; y < h - 0.6; y += 0.62) m.cbox('stone', G, p.x, y, 0, w, 0.52, w, { top: false });
	m.cbox('stone', G, p.x, h - 0.05, 0, w + 0.28, 0.32, w + 0.28);
	m.cbox('stone', G, p.x, h + 0.27, 0, w + 0.1, 0.18, w + 0.1);
	const [px, , pz] = G.p(p.x, 0, 0);
	if (p.big) {
		m.lathe('stone', G, p.x, 0, [[0.32, h + 0.45], [0.42, h + 0.6], [0.24, h + 0.85], [0.5, h + 1.25], [0.56, h + 1.45], [0.42, h + 1.7], [0.18, h + 1.85], [0.12, h + 2.15], [0.2, h + 2.3], [0, h + 2.45]], 12);
	} else {
		m.lathe('stone', G, p.x, 0, [[0.2, h + 0.45], [0.12, h + 0.55], [0.3, h + 0.72], [0.36, h + 0.95], [0.3, h + 1.18], [0.16, h + 1.3], [0, h + 1.33]], 10);
	}
	ctx.addSolidBox(px, pz, w + 0.3, w + 0.3, G.yaw);
}

/** Wrought-iron gate: bars with spear tips, rails, curved top and a gilt crest on the main gate. */
function ironGate(m, ctx, G, g) {
	const w = g.x1 - g.x0, n = Math.round(w / 0.15);
	const top = (x) => (g.main ? g.h - 0.7 + 0.7 * Math.sin(Math.PI * ((x - g.x0) / w)) : g.h);
	m.tint = IRON;
	for (let k = 1; k < n; k++) {
		const x = g.x0 + (k * w) / n, t = top(x);
		m.box('iron', G, x - 0.018, 0.06, -0.02, x + 0.018, t, 0.02, { top: false });
		m.pyramid('iron', G, x, 0, t, 0.07, 0.07, 0.2);
	}
	for (const y of [0.12, 0.95, g.h - 1.05]) m.box('iron', G, g.x0, y, -0.035, g.x1, y + 0.07, 0.035);
	// Frame posts and the meeting stile.
	m.box('iron', G, g.x0, 0, -0.05, g.x0 + 0.08, top(g.x0) + 0.1, 0.05);
	m.box('iron', G, g.x1 - 0.08, 0, -0.05, g.x1, top(g.x1) + 0.1, 0.05);
	if (g.main) {
		const c = (g.x0 + g.x1) / 2;
		m.box('iron', G, c - 0.05, 0, -0.05, c + 0.05, g.h, 0.05);
		// Scrolls band and the gilt crest above the gate.
		m.arch('iron', G, c - w / 4, g.h - 1.05, w / 4 - 0.15, 0.05, -0.03, 0.06, { n: 10 });
		m.arch('iron', G, c + w / 4, g.h - 1.05, w / 4 - 0.15, 0.05, -0.03, 0.06, { n: 10 });
		m.tint = GILT;
		m.arch('bronze', G, c, g.h + 0.55, 0.42, 0.07, -0.04, 0.08, { n: 14, from: 0, to: Math.PI * 2 });
		m.box('bronze', G, c - 0.035, g.h + 0.15, -0.04, c + 0.035, g.h + 1.25, 0.04);
		m.box('bronze', G, c - 0.3, g.h + 0.78, -0.04, c + 0.3, g.h + 0.85, 0.04);
	}
	// The closed gate blocks the player (the cemetery inside is not built yet).
	const [ax, , az] = G.p(g.x0, 0, 0), [bx, , bz] = G.p(g.x1, 0, 0);
	ctx.addWall(ax, az, bx, bz);
}

/** Railing on a stone plinth between a pier and a lodge. */
function railing(m, ctx, G, x0, x1) {
	m.tint = PLINTH;
	m.box('stone', G, x0, 0, -0.3, x1, 0.6, 0.3);
	m.tint = STONE;
	m.box('stone', G, x0, 0.6, -0.34, x1, 0.7, 0.34);
	const n = Math.round((x1 - x0) / 0.16);
	m.tint = IRON;
	for (let k = 1; k < n; k++) {
		const x = x0 + ((x1 - x0) * k) / n;
		m.box('iron', G, x - 0.016, 0.7, -0.016, x + 0.016, 2.55, 0.016, { top: false });
		m.pyramid('iron', G, x, 0, 2.55, 0.06, 0.06, 0.16);
	}
	m.box('iron', G, x0, 2.25, -0.03, x1, 2.31, 0.03);
	m.box('iron', G, x0, 0.85, -0.03, x1, 0.91, 0.03);
	const [ax, , az] = G.p(x0, 0, 0), [bx, , bz] = G.p(x1, 0, 0);
	ctx.addWall(ax, az, bx, bz);
}

/** A gate lodge: ochre walls, stone quoins and cornice, arched windows, hipped slate roof. */
function lodge(m, ctx, G, x0, x1, signed) {
	const z0 = -7.5, z1 = 0.6, H = 6.2;
	const ring = [G.p(x0, 0, z1), G.p(x1, 0, z1), G.p(x1, 0, z0), G.p(x0, 0, z0)].map(([x, , z]) => [x, z]);
	m.tint = OCHRE;
	m.box('plaster', G, x0, 0.8, z0, x1, H, z1, { top: false });
	m.tint = PLINTH;
	m.box('stone', G, x0 - 0.1, 0, z0 - 0.1, x1 + 0.1, 0.8, z1 + 0.1);
	m.tint = STONE;
	// Quoins at the street corners.
	for (const x of [x0, x1]) for (let y = 0.8, k = 0; y < H - 0.6; y += 0.55, k++) {
		const w = k % 2 ? 0.55 : 0.85;
		m.box('stone', G, x === x0 ? x0 - 0.05 : x1 - w, y, z1 - (k % 2 ? 0.55 : 0.85), x === x0 ? x0 + w : x1 + 0.05, y + 0.5, z1 + 0.05, { top: false });
	}
	// Cornice and frieze band.
	m.box('stone', G, x0 - 0.05, H - 1.0, z0 - 0.05, x1 + 0.05, H - 0.9, z1 + 0.06);
	m.box('stone', G, x0 - 0.35, H - 0.2, z0 - 0.35, x1 + 0.35, H + 0.1, z1 + 0.35);
	m.box('stone', G, x0 - 0.2, H - 0.42, z0 - 0.2, x1 + 0.2, H - 0.2, z1 + 0.2);
	m.tint = ROOF;
	m.roof('roof', G, x0, z0, x1, z1, H + 0.1, 2.6, { hip: 1, overhang: 0.3 });
	m.box('metal', G, (x0 + x1) / 2 - 0.35, H + 1.6, (z0 + z1) / 2 - 0.35, (x0 + x1) / 2 + 0.35, H + 3.0, (z0 + z1) / 2 + 0.35); // chimney
	// Street front: two arched windows; gate side: a door; back: windows.
	const F = G.sub(0, 0, z1);
	const cx = (x0 + x1) / 2;
	m.tint = STONE;
	for (const dx of [-2.3, 2.3]) windowAt(m, F, cx + dx, 1.5, 1.3, 2.6, { cell: CELL.arched, arched: true, surround: 0.18, col: STONE, keystone: true, depth: 0.12 });
	if (signed) m.panel('sign', F, x0 + 0.6, H - 0.88, x1 - 0.6, H - 0.48, 0.08, [0, 0, 1, 1], [1, 1, 1]);
	const inner = Math.abs(x0) < Math.abs(x1) ? x0 : x1, side = inner === x0 ? -1 : 1;
	const S = G.sub(inner, 0, (z0 + z1) / 2, (side * Math.PI) / 2);
	m.panel('detail', S, -0.8, 0.8, 0.8, 3.3, 0.02, CELL.door);
	m.box('stone', S, -1.05, 0.8, -0.02, -0.8, 3.55, 0.14);
	m.box('stone', S, 0.8, 0.8, -0.02, 1.05, 3.55, 0.14);
	m.box('stone', S, -1.05, 3.3, -0.02, 1.05, 3.6, 0.18);
	ctx.addSolidRing(ring);
}

void toXZ;
void shade;
