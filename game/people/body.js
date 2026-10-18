// Procedural human figure for the crowd (no three.js dependency: plain typed arrays, unit tested).
//
// One rest-pose mesh of a 1.75 m reference person standing in a relaxed A-pose, facing +z, with
// their left hand on +x. Every vertex carries
//   aSkin  (bone0, bone1, weight of bone1, region)   – a 13-bone skeleton, posed in the vertex shader
//   aInfo  (group, maskA, maskB, flags)              – optional pieces (hair styles, coat, bags ...)
//   aFem / aFat                                        – morph deltas towards a female / heavier build
// The same function is evaluated with the male, female and heavy body parameters; the topology
// never depends on them, so the differences are exact morph targets. Three levels of detail share
// the layout: 0 (close, < ~35 m), 1 (< ~120 m), 2 (far).

export const B = { PELVIS: 0, CHEST: 1, HEAD: 2, THIGH_L: 3, SHIN_L: 4, FOOT_L: 5, THIGH_R: 6, SHIN_R: 7, FOOT_R: 8, ARM_L: 9, FORE_L: 10, ARM_R: 11, FORE_R: 12 };
export const PARENT = [-1, 0, 1, 0, 3, 4, 0, 6, 7, 1, 9, 1, 11];
export const REGION = { SKIN: 0, HAIR: 1, TOP: 2, LEGS: 3, SHOES: 4, ACCENT: 5, BAG: 6, LOWER: 7, PHONE: 8, STICK: 9, HAIR_OR_HAT: 10, STRAP: 11 };
// Optional pieces: GROUP.HAIR uses maskA (bit per HAIR style) and maskB (bit per HEADWEAR);
// GROUP.ACC uses maskA = the ACC bit that switches it on.
export const GROUP = { ALWAYS: 0, HAIR: 1, COAT: 2, SKIRT: 3, ACC: 4, PHONE: 5, HOOD: 6, HEADCOVER: 7 };
export const HAIR = { BUZZ: 0, SHORT: 1, LONG: 2, PONY: 3, BUN: 4, CURLY: 5, BALD: 6 };
export const HEADWEAR = { NONE: 0, CAP: 1, BEANIE: 2, SCARF: 3 };
export const UPPER = { JACKET: 0, PUFFER: 1, COAT: 2, HOODIE: 3, TRACK: 4, KNIT: 5 };
export const LOWER = { JEANS: 0, TROUSERS: 1, SKIRT: 2, TRACK: 3 };
export const SHOE = { SNEAKER: 0, BOOT: 1, DRESS: 2 };
export const ACC = { SCARF: 1, BACKPACK: 2, BAG: 4, SHOPPING: 8, STICK: 16, GLASSES: 32, STUBBLE: 64, BEARD: 128 };

export const HEAD_C = [0, 1.64, 0.012];
export const REF_HEIGHT = 1.75;

/** Body shape parameters: male base, female, heavy (all morphs are differences to the male base). */
export const BODY = {
	male: { hipX: 0.088, shX: 0.196, hipW: 0.162, waistW: 0.148, chestW: 0.163, shW: 0.172, belly: 0.1, chestF: 0.115, bust: 0, seat: 0.115, neck: 0.058, thigh: 0.085, calf: 0.06, arm: 1, hand: 1 },
	female: { hipX: 0.095, shX: 0.178, hipW: 0.18, waistW: 0.128, chestW: 0.148, shW: 0.155, belly: 0.088, chestF: 0.112, bust: 0.034, seat: 0.13, neck: 0.051, thigh: 0.09, calf: 0.058, arm: 0.86, hand: 0.88 },
	heavy: { hipX: 0.1, shX: 0.214, hipW: 0.19, waistW: 0.196, chestW: 0.192, shW: 0.19, belly: 0.17, chestF: 0.14, bust: 0.012, seat: 0.135, neck: 0.07, thigh: 0.106, calf: 0.07, arm: 1.3, hand: 1.08 },
};

/** Joint pivots of the 13 bones for a parameter set (the shader mixes these per person). */
export function joints(P) {
	const j = [[0, 0.95, 0], [0, 1.08, -0.01], [0, 1.505, -0.008]];
	for (const s of [1, -1]) j.push([s * P.hipX, 0.93, 0], [s * (P.hipX - 0.008), 0.505, 0.008], [s * (P.hipX - 0.012), 0.088, -0.012]);
	for (const s of [1, -1]) j.push([s * P.shX, 1.425, -0.012], [s * (P.shX + 0.018), 1.13, -0.03]);
	return j;
}

// ---------------------------------------------------------------- small vector helpers
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const g = (x, s) => Math.exp(-(x / s) * (x / s));
const spow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);

// ---------------------------------------------------------------- mesh accumulation

class Acc {
	constructor() { this.p = []; this.skin = []; this.info = []; this.idx = []; this.parts = []; }
	begin(info) { this.part = { v0: this.p.length / 3, i0: this.idx.length }; this.curInfo = info; }
	vert(p, skin, region) {
		this.p.push(p[0], p[1], p[2]);
		this.skin.push(skin[0], skin[1], skin[2], region);
		this.info.push(...this.curInfo);
		return this.p.length / 3 - 1;
	}
	end() { this.part.v1 = this.p.length / 3; this.part.i1 = this.idx.length; this.parts.push(this.part); }
	/**
	 * A grid of rows x cols vertices from fn(row, col) -> { p, skin, region }. Columns wrap around
	 * (closed loop) unless wrap = false. Rows are connected in order.
	 */
	grid(rows, cols, fn, { wrap = true, info = [0, 0, 0, 0], capStart = null, capEnd = null, flip = false } = {}) {
		this.begin(info);
		const base = this.p.length / 3;
		for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const v = fn(r, c); this.vert(v.p, v.skin, v.region); }
		const at = (r, c) => base + r * cols + (wrap ? c % cols : c);
		const cEnd = wrap ? cols : cols - 1;
		for (let r = 0; r + 1 < rows; r++) for (let c = 0; c < cEnd; c++) {
			const a = at(r, c), b = at(r + 1, c), cc = at(r + 1, c + 1), d = at(r, c + 1);
			// Outward when (column direction x row direction) points out of the surface.
			if (flip) this.idx.push(a, cc, d, a, b, cc);
			else this.idx.push(a, d, cc, a, cc, b);
		}
		for (const [cap, r, rev] of [[capStart, 0, false], [capEnd, rows - 1, true]]) {
			if (!cap) continue;
			const ci = this.vert(cap.p, cap.skin, cap.region);
			for (let c = 0; c < cEnd; c++) if (rev) this.idx.push(ci, at(r, c), at(r, c + 1)); else this.idx.push(ci, at(r, c + 1), at(r, c));
		}
		this.end();
	}
}

/**
 * A tube through rings { c: centre, rx (sideways), rf (front), rb (back), e (superellipse
 * exponent), skin, region }. `fwd` is the reference "front" direction of the cross sections.
 */
function tube(acc, rings, n, { fwd = [0, 0, 1], info, caps = [false, false], twist = 0 } = {}) {
	const frames = rings.map((r, i) => {
		const a = norm(sub(rings[Math.min(i + 1, rings.length - 1)].c, rings[Math.max(i - 1, 0)].c));
		const side = norm(cross(fwd, a));
		return { a, side, f: cross(a, side) };
	});
	const point = (r, k) => {
		const R = rings[r], F = frames[r];
		const t = (k / n) * Math.PI * 2 + twist;
		const e = 2 / (R.e || 2);
		const sx = spow(Math.cos(t), e), sz = spow(Math.sin(t), e);
		return add(R.c, add(mul(F.side, sx * R.rx), mul(F.f, sz * (sz > 0 ? R.rf : R.rb))));
	};
	const cap = (r, dir) => {
		const R = rings[r];
		return { p: add(R.c, mul(frames[r].a, dir * (R.cap ?? Math.min(R.rx, R.rf) * 0.5))), skin: R.skin, region: R.region };
	};
	acc.grid(rings.length, n, (r, k) => ({ p: point(r, k), skin: rings[r].skin, region: rings[r].region }), {
		info, capStart: caps[0] ? cap(0, -1) : null, capEnd: caps[1] ? cap(rings.length - 1, 1) : null,
	});
}

/** Rings kept at this level of detail (ring.k = coarsest LOD that still keeps it). */
const keep = (rings, lod) => rings.filter((r) => (r.k ?? 2) >= lod);

// ---------------------------------------------------------------- the head

/** A point on the head (theta 0 = front, +pi/2 = left; phi 0 = chin pole, pi = crown) pushed out by off. */
export function headPoint(theta, phi, off = 0, features = true) {
	const [cx, cy, cz] = HEAD_C;
	const s = Math.sin(phi), c = -Math.cos(phi);
	let y = cy + c * (c > 0 ? 0.112 : 0.108);
	const front = Math.cos(theta);
	let x = Math.sin(theta) * s * 0.0765;
	let z = front * s * (front > 0 ? 0.094 : 0.104);
	const jaw = smooth(cy - 0.015, cy - 0.108, y);
	x *= 1 - 0.36 * jaw;
	if (front < 0) z *= 1 - 0.5 * jaw;
	else z = z * (1 - 0.12 * jaw) + 0.008 * jaw * front;
	if (features) {
		const dy = y - cy;
		if (front > 0) {
			const ax = Math.abs(x);
			z += 0.02 * g(x, 0.0105) * g(dy + 0.036, 0.02) + 0.007 * g(x, 0.009) * g(dy + 0.004, 0.016); // nose, bridge
			z -= 0.0055 * g(ax - 0.031, 0.015) * g(dy - 0.002, 0.011); // eye sockets
			z += 0.0035 * g(dy - 0.021, 0.008) * g(x, 0.05); // brow ridge
			z += 0.0045 * g(x, 0.02) * g(dy + 0.072, 0.011); // lips
			z += 0.006 * g(x, 0.022) * g(dy + 0.097, 0.012); // chin
			x += Math.sign(x) * 0.003 * g(dy + 0.012, 0.02) * g(ax - 0.05, 0.02); // cheekbones
		}
		x += Math.sign(x) * 0.013 * g(dy + 0.006, 0.026) * g(z - cz + 0.008, 0.018) * smooth(0.5, 0.9, Math.abs(Math.sin(theta))); // ears
	}
	if (off) {
		const d = norm([x - cx, (y - cy) * 0.9, z - cz]);
		x += d[0] * off; y += d[1] * off; z += d[2] * off;
	}
	return [x, y, z];
}

/** Height of the hairline above the head centre (the scalp is painted with hair above it). */
export function hairlineY(front) {
	return front > 0 ? 0.052 * Math.pow(front, 0.8) : -0.085 * Math.pow(-front, 1.2);
}
const psiOf = (dy) => Math.acos(Math.max(-1, Math.min(1, dy / (dy > 0 ? 0.112 : 0.108))));

/** A shell over the scalp from the crown down to edgePsi(theta) (angle from the crown). */
function shell(acc, nu, nv, edgePsi, offFn, info, region) {
	const rows = nv + 2; // + one row tucked under the skin to close the edge
	acc.grid(rows, nu, (r, k) => {
		const th = (k / nu) * Math.PI * 2;
		const edge = edgePsi(th);
		const tucked = r === rows - 1;
		const psi = (Math.min(r, nv) / nv) * edge;
		const off = tucked ? -0.003 : offFn(psi, th, r / nv);
		return { p: headPoint(th, Math.PI - Math.max(psi, 1e-3), off, false), skin: [B.HEAD, B.HEAD, 0], region };
	}, { info, flip: true });
}

// ---------------------------------------------------------------- the figure

const W = (b0, b1 = b0, w = 0) => [b0, b1, w];

/** Builds the figure for body parameters P at a level of detail into acc. */
function figure(P, lod) {
	const acc = new Acc();
	const J = joints(P);
	const nT = [14, 8, 6][lod], nL = [8, 5, 4][lod], nA = [8, 5, 4][lod];
	const always = [GROUP.ALWAYS, 0, 0, 0];

	// Torso from the crotch to the top of the neck (inside the head).
	const tw = (y, w, f, b, e, skin, region, k) => ({ c: [0, y, 0], rx: w, rf: f, rb: b, e, skin, region, k });
	const T = REGION.TOP, S = REGION.SKIN;
	const torso = [
		tw(0.79, 0.035, 0.03, 0.03, 2, W(B.PELVIS), REGION.LEGS, 2),
		tw(0.815, 0.1, 0.07, 0.075, 2.2, W(B.PELVIS), REGION.LEGS, 1),
		tw(0.875, P.hipW * 0.96, 0.093, P.seat * 0.95, 2.4, W(B.PELVIS), REGION.LEGS, 1),
		tw(0.912, P.hipW * 0.99, 0.096, P.seat * 0.99, 2.5, W(B.PELVIS), REGION.LEGS, 1),
		tw(0.912, P.hipW + 0.007, 0.104, P.seat + 0.007, 2.5, W(B.PELVIS), REGION.TOP, 2), // jacket hem
		tw(0.94, P.hipW + 0.005, 0.102, P.seat + 0.004, 2.5, W(B.PELVIS), REGION.TOP, 1),
		tw(1.0, lerp(P.hipW, P.waistW, 0.5) + 0.004, P.belly * 0.97 + 0.004, 0.102, 2.5, W(B.PELVIS), REGION.TOP, 1),
		tw(1.08, P.waistW, P.belly, 0.09, 2.5, W(B.PELVIS, B.CHEST, 0.5), REGION.TOP, 2),
		tw(1.17, lerp(P.waistW, P.chestW, 0.55), lerp(P.belly, P.chestF, 0.5) + P.bust * 0.4, 0.09, 2.6, W(B.CHEST), T, 0),
		tw(1.26, P.chestW, P.chestF + P.bust, 0.096, 2.6, W(B.CHEST), T, 2),
		tw(1.34, P.shW * 0.97, P.chestF * 0.94 + P.bust * 0.3, 0.1, 2.5, W(B.CHEST), T, 1),
		tw(1.395, P.shW * 0.985, 0.094, 0.094, 2.4, W(B.CHEST), T, 2),
		tw(1.43, P.shW * 0.88, 0.083, 0.085, 2.2, W(B.CHEST), T, 0),
		tw(1.458, P.shW * 0.66, 0.072, 0.076, 2.1, W(B.CHEST), T, 1),
		tw(1.478, P.neck * 1.5, 0.066, 0.068, 2, W(B.CHEST), T, 0),
		tw(1.488, P.neck * 1.32, 0.062, 0.064, 2, W(B.CHEST), T, 1),
		tw(1.486, P.neck * 1.06, P.neck * 0.92, P.neck, 2, W(B.CHEST), S, 2),
		tw(1.53, P.neck, P.neck * 0.9, P.neck, 2, W(B.CHEST, B.HEAD, 0.6), S, 0),
		tw(1.6, P.neck * 0.95, P.neck * 0.85, P.neck * 0.95, 2, W(B.HEAD), S, 2),
	];
	tube(acc, keep(torso, lod), nT, { info: always, caps: [true, false] });

	// Legs (trousers / tights) down to the ankle, then the shoe.
	for (const s of [1, -1]) {
		const th = s > 0 ? B.THIGH_L : B.THIGH_R, sh = th + 1, ft = th + 2;
		const hip = J[th], knee = J[sh], ankle = J[ft];
		const at = (y) => (y >= knee[1] ? lerp3(knee, hip, (y - knee[1]) / (hip[1] - knee[1])) : lerp3(ankle, knee, (y - ankle[1]) / (knee[1] - ankle[1])));
		const ring = (y, rx, rf, rb, skin, k, dx = 0) => { const c = at(y); c[0] += s * dx; return { c, rx, rf, rb, e: 2, skin, region: REGION.LEGS, k }; };
		const legs = [
			ring(1.0, P.thigh * 1.02, 0.085, 0.09, W(B.PELVIS, th, 0.3), 2, -0.01),
			ring(0.9, P.thigh, P.thigh, P.thigh * 1.08, W(th, th, 0), 1),
			ring(0.78, P.thigh * 0.92, P.thigh * 0.93, P.thigh, W(th), 0),
			ring(0.66, P.thigh * 0.78, P.thigh * 0.8, P.thigh * 0.82, W(th), 1),
			ring(0.56, 0.054, 0.056, 0.057, W(th, sh, 0.25), 0),
			ring(0.505, 0.052, 0.055, 0.053, W(th, sh, 0.5), 2),
			ring(0.45, 0.053, 0.053, P.calf, W(th, sh, 0.85), 0),
			ring(0.37, P.calf * 0.92, 0.05, P.calf * 1.1, W(sh), 1),
			ring(0.26, 0.047, 0.046, 0.05, W(sh), 0),
			ring(0.16, 0.041, 0.042, 0.042, W(sh), 1),
			ring(0.1, 0.04, 0.042, 0.042, W(sh, ft, 0.35), 2),
		];
		tube(acc, keep(legs, lod), nL, { info: always });
		// Shoe: cross sections along +z (heel to toe); "front" of a section is up.
		const fr = (dz, y, hw, top, bot, k) => ({ c: [ankle[0] + s * 0.004 * (dz > 0.05 ? 1 : 0), y, ankle[2] + dz], rx: hw, rf: top, rb: bot, e: 2.6, skin: dz < -0.02 ? W(sh, ft, 0.85) : W(ft), region: REGION.SHOES, k, cap: 0.012 });
		const shoe = [
			fr(-0.086, 0.045, 0.03, 0.028, 0.04, 2),
			fr(-0.06, 0.06, 0.04, 0.05, 0.058, 0),
			fr(-0.01, 0.065, 0.044, 0.05, 0.064, 2),
			fr(0.05, 0.05, 0.047, 0.04, 0.049, 1),
			fr(0.11, 0.038, 0.05, 0.03, 0.037, 0),
			fr(0.165, 0.03, 0.045, 0.022, 0.029, 0),
			fr(0.2, 0.025, 0.032, 0.016, 0.024, 2),
		];
		tube(acc, keep(shoe, lod), nL, { fwd: [0, 1, 0], info: always, caps: [true, true] });
	}

	// Arms: sleeve down to a cuff, then the hand (palm towards the thigh).
	for (const s of [1, -1]) {
		const ab = s > 0 ? B.ARM_L : B.ARM_R, fb = ab + 1;
		const sh = J[ab], el = J[fb], wr = [s * (P.shX + 0.028), 0.875, -0.005], tip = [s * (P.shX + 0.032), 0.7, 0.012];
		const a = P.arm;
		const on = (p, q, t) => lerp3(p, q, t);
		const ring = (c, rx, rf, rb, skin, region, k, e = 2) => ({ c, rx, rf, rb, e, skin, region, k });
		const arms = [
			ring(add(sh, [-s * 0.02, 0.03, 0]), 0.036 * a, 0.04, 0.04, W(B.CHEST, ab, 0.5), T, 2),
			ring(add(sh, [s * 0.004, 0.005, 0]), 0.05 * a, 0.052 * a, 0.05 * a, W(B.CHEST, ab, 0.8), T, 0),
			ring(on(sh, el, 0.1), 0.053 * a, 0.053 * a, 0.05 * a, W(ab), T, 1),
			ring(on(sh, el, 0.4), 0.048 * a, 0.047 * a, 0.045 * a, W(ab), T, 0),
			ring(on(sh, el, 0.75), 0.043 * a, 0.043 * a, 0.041 * a, W(ab), T, 1),
			ring(on(sh, el, 0.94), 0.04 * a, 0.04 * a, 0.04 * a, W(ab, fb, 0.3), T, 0),
			ring(el, 0.039 * a, 0.04 * a, 0.041 * a, W(ab, fb, 0.5), T, 2),
			ring(on(el, wr, 0.18), 0.042 * a, 0.043 * a, 0.041 * a, W(fb), T, 0),
			ring(on(el, wr, 0.55), 0.037 * a, 0.036 * a, 0.034 * a, W(fb), T, 1),
			ring(on(el, wr, 0.9), 0.034 * a, 0.032 * a, 0.032 * a, W(fb), T, 0),
			ring(on(el, wr, 0.96), 0.034 * a, 0.032 * a, 0.032 * a, W(fb), T, 1),
			ring(on(el, wr, 0.97), 0.024 * P.hand, 0.021 * P.hand, 0.021 * P.hand, W(fb), S, 2),
			ring(on(wr, tip, 0.15), 0.017 * P.hand, 0.04 * P.hand, 0.036 * P.hand, W(fb), S, 1, 2.4),
			ring(on(wr, tip, 0.5), 0.016 * P.hand, 0.043 * P.hand, 0.036 * P.hand, W(fb), S, 0, 2.4),
			ring(on(wr, tip, 0.85), 0.013 * P.hand, 0.034 * P.hand, 0.03 * P.hand, W(fb), S, 1, 2.2),
			{ ...ring(tip, 0.009, 0.016, 0.014, W(fb), S, 2), cap: 0.01 },
		];
		tube(acc, keep(arms, lod), nA, { info: always, caps: [false, true] });
	}

	// Head.
	const nu = [20, 8, 6][lod], nv = [14, 6, 4][lod];
	acc.grid(nv + 1, nu, (r, k) => ({ p: headPoint((k / nu) * Math.PI * 2, (r / nv) * Math.PI, 0, lod < 2), skin: W(B.HEAD), region: S }), { info: always });

	// Hair and headwear.
	const hairBits = (...h) => h.reduce((m, x) => m | (1 << x), 0);
	const hairInfo = (hair, head) => [GROUP.HAIR, hair, head, 0];
	const NONE_HW = hairBits(HEADWEAR.NONE);
	const ANY_HW = hairBits(HEADWEAR.NONE, HEADWEAR.CAP, HEADWEAR.BEANIE);
	const sU = [16, 8, 6][lod], sV = [5, 2, 1][lod];
	const hairEdge = (th) => psiOf(hairlineY(Math.cos(th)) - 0.004);
	if (lod < 2) {
		// Scalp cap shared by most styles (bigger at the crown; curly hair is inflated in the shader).
		shell(acc, sU, sV, hairEdge, (psi) => 0.003 + 0.007 * Math.cos(psi) ** 2, hairInfo(hairBits(HAIR.SHORT, HAIR.LONG, HAIR.PONY, HAIR.BUN, HAIR.CURLY), NONE_HW), REGION.HAIR);
		// Long hair falling down the back.
		const dn = [6, 3][lod], du = [9, 5][lod];
		const drape = [];
		for (let r = 0; r <= dn; r++) {
			const t = r / dn, y = lerp(HEAD_C[1] + 0.03, 1.35, t);
			drape.push({ y, w: lerp(0.088, 0.135, smooth(0.25, 0.75, t)), d: lerp(0.112, 0.13, smooth(0.2, 0.7, t)) });
		}
		acc.grid(dn + 1, du * 2, (r, k) => {
			const D = drape[r];
			const outer = k < du;
			const kk = outer ? k : du * 2 - 1 - k;
			const th = lerp(1.25, Math.PI * 2 - 1.25, kk / (du - 1));
			const thick = outer ? 1 : 0.86;
			const p = [Math.sin(th) * D.w * thick, D.y, HEAD_C[2] + Math.cos(th) * D.d * thick - 0.012];
			const t = r / dn;
			return { p, skin: t < 0.45 ? W(B.HEAD) : W(B.HEAD, B.CHEST, smooth(0.45, 0.9, t)), region: REGION.HAIR };
		}, { info: hairInfo(hairBits(HAIR.LONG), ANY_HW), flip: true });
		// Ponytail.
		const cz = HEAD_C[2];
		const pony = [[0, HEAD_C[1] + 0.035, cz - 0.1, 0.03], [0, HEAD_C[1] - 0.01, cz - 0.13, 0.031], [0, 1.53, cz - 0.13, 0.024], [0, 1.45, cz - 0.11, 0.012]]
			.map(([x, y, z, r], i) => ({ c: [x, y, z], rx: r, rf: r, rb: r, e: 2, skin: W(B.HEAD), region: REGION.HAIR, k: 2, cap: i === 3 ? 0.012 : 0.01 }));
		tube(acc, pony, [7, 4][lod], { info: hairInfo(hairBits(HAIR.PONY), ANY_HW), caps: [true, true] });
		// Bun.
		const bn = [8, 4][lod];
		acc.grid(bn / 2 + 1 | 0, bn, (r, k) => {
			const ph = (r / (bn / 2 | 0)) * Math.PI, th = (k / bn) * Math.PI * 2;
			return { p: [Math.sin(ph) * Math.sin(th) * 0.045, HEAD_C[1] + 0.075 - Math.cos(ph) * 0.04, cz - 0.075 + Math.sin(ph) * Math.cos(th) * 0.04], skin: W(B.HEAD), region: REGION.HAIR };
		}, { info: hairInfo(hairBits(HAIR.BUN), NONE_HW) });
		const ALL_HAIR = hairBits(0, 1, 2, 3, 4, 5, 6);
		// Baseball cap: dome and visor.
		shell(acc, sU, sV, (th) => lerp(1.2, 1.5, (1 - Math.cos(th)) / 2), () => 0.014, hairInfo(ALL_HAIR, hairBits(HEADWEAR.CAP)), REGION.ACCENT);
		const vu = [6, 3][lod];
		acc.grid(3, vu * 2, (r, k) => {
			const outer = k < vu, kk = outer ? k : vu * 2 - 1 - k;
			const th = lerp(-0.85, 0.85, kk / (vu - 1));
			const base = headPoint(th, Math.PI - 1.2, 0.014, false);
			const reach = [0, 0.04, 0.075][r] * Math.cos(th * 0.8);
			const p = [base[0] * (1 + reach * 2), base[1] - reach * 0.25 + (outer ? 0.004 : -0.002), base[2] + reach];
			return { p, skin: W(B.HEAD), region: REGION.ACCENT };
		}, { info: hairInfo(ALL_HAIR, hairBits(HEADWEAR.CAP)), flip: true });
		// Beanie (covers the ears' tops, slight peak).
		shell(acc, sU, sV, (th) => psiOf(lerp(0.036, -0.045, (1 - Math.cos(th)) / 2) - 0.012 * Math.abs(Math.sin(th))), (psi) => 0.016 + 0.01 * Math.cos(psi) ** 2, hairInfo(ALL_HAIR, hairBits(HEADWEAR.BEANIE)), REGION.ACCENT);
		// Headscarf / hijab: frames the face, then falls over the neck and shoulders.
		const scarfEdge = (th) => { const a = Math.abs(((th + Math.PI) % (Math.PI * 2)) - Math.PI); return lerp(1.15, 2.75, smooth(0.62, 1.2, a)); };
		shell(acc, sU, sV + 1, scarfEdge, () => 0.015, hairInfo(ALL_HAIR, hairBits(HEADWEAR.SCARF)), REGION.ACCENT);
		const cn = [12, 8][lod];
		const cone = [[HEAD_C[1] - 0.05, 0.082, 0.09], [1.5, 0.092, 0.1], [1.45, 0.16, 0.13], [1.39, 0.205, 0.135]];
		acc.grid(cone.length, cn, (r, k) => {
			const th = (k / cn) * Math.PI * 2, [y, w, d] = cone[r];
			return { p: [Math.sin(th) * w, y, Math.cos(th) * d + (r === 0 ? 0.005 : -0.006)], skin: r < 2 ? W(B.HEAD, B.CHEST, r * 0.6) : W(B.CHEST), region: REGION.ACCENT };
		}, { info: hairInfo(ALL_HAIR, hairBits(HEADWEAR.SCARF)), flip: true });
	} else {
		// Far: one cap over the head in hair or hat colour (shader decides).
		shell(acc, sU, sV, hairEdge, () => 0.012, [GROUP.HEADCOVER, 0, 0, 0], REGION.HAIR_OR_HAT);
	}

	// Coat skirt (from the waist to the knee) and skirt: follow the thighs on their side.
	const sideSkin = (x, w, t) => {
		const sideW = Math.min(1, Math.abs(x) / w) * 0.75 * smooth(0.05, 1, t);
		return W(B.PELVIS, x > 0 ? B.THIGH_L : B.THIGH_R, sideW);
	};
	const lowerPiece = (yTop, yBot, wTop, wBot, fTop, fBot, bTop, bBot, region, group) => {
		const rows = [5, 3, 1][lod], n = [12, 8, 6][lod];
		acc.grid(rows + 1, n, (r, k) => {
			const t = r / rows, th = (k / n) * Math.PI * 2;
			const w = lerp(wTop, wBot, t), f = lerp(fTop, fBot, t), b = lerp(bTop, bBot, t);
			const cs = Math.cos(th), sn = Math.sin(th);
			const x = spow(cs, 2 / 2.4) * w, z = spow(sn, 2 / 2.4) * (sn > 0 ? f : b);
			return { p: [x, lerp(yTop, yBot, t), z], skin: sideSkin(x, w, t), region };
		}, { info: [group, 0, 0, 0] });
	};
	lowerPiece(1.06, 0.47, P.hipW + 0.006, P.hipW + 0.062, P.belly + 0.012, 0.15, P.seat + 0.012, 0.15, REGION.TOP, GROUP.COAT);
	lowerPiece(1.03, 0.56, P.hipW + 0.006, P.hipW + 0.045, P.belly * 0.95 + 0.008, 0.13, P.seat + 0.01, 0.14, REGION.LOWER, GROUP.SKIRT);

	if (lod < 2) {
		const blob = (c, r, e, skin, region, info, nu = [8, 5][lod], nv = [5, 3][lod]) => {
			acc.grid(nv + 1, nu, (i, k) => {
				const ph = (i / nv) * Math.PI, th = (k / nu) * Math.PI * 2;
				const sp = spow(Math.sin(ph), 2 / e), cp = spow(Math.cos(ph), 2 / e);
				return { p: [c[0] + sp * spow(Math.sin(th), 2 / e) * r[0], c[1] - cp * r[1], c[2] + sp * spow(Math.cos(th), 2 / e) * r[2]], skin, region };
			}, { info });
		};
		const acc4 = (bit) => [GROUP.ACC, bit, 0, 0];
		// Hood of a hoodie, bunched behind the neck.
		if (lod === 0) blob([0, 1.47, -0.1], [0.105, 0.05, 0.05], 2.4, W(B.CHEST), REGION.TOP, [GROUP.HOOD, 0, 0, 0]);
		// Backpack and its straps.
		blob([0, 1.24, -0.098 - P.seat * 0.2 - 0.07], [0.14, 0.19, 0.068], 4, W(B.CHEST), REGION.BAG, acc4(ACC.BACKPACK));
		for (const s of lod === 0 ? [1, -1] : []) {
			const pts = [[0.08, 1.4, -0.15], [0.1, 1.47, -0.05], [0.105, 1.44, 0.07], [0.12, 1.3, P.chestF + P.bust + 0.008], [0.135, 1.16, P.belly - 0.01]];
			tube(acc, pts.map((p) => ({ c: [s * p[0], p[1], p[2]], rx: 0.022, rf: 0.006, rb: 0.006, e: 4, skin: W(B.CHEST), region: REGION.STRAP })), 4, { info: acc4(ACC.BACKPACK), fwd: [0, 1, 0.3] });
		}
		// Cross-body bag on the left hip, strap over the right shoulder.
		blob([0.1, 0.97, P.belly + 0.035], [0.085, 0.07, 0.03], 4, W(B.PELVIS), REGION.BAG, acc4(ACC.BAG));
		const strap = [[0.17, 1.03, P.belly + 0.03], [0.1, 1.24, P.chestF + P.bust + 0.012], [-0.08, 1.43, 0.075], [-0.12, 1.48, -0.01], [-0.06, 1.38, -0.105], [P.hipW, 1.05, -0.07]];
		if (lod === 0) tube(acc, strap.map((p, i) => ({ c: p, rx: 0.012, rf: 0.004, rb: 0.004, e: 3, skin: i === 0 || i === 5 ? W(B.CHEST, B.PELVIS, 0.6) : W(B.CHEST), region: REGION.STRAP })), 4, { info: acc4(ACC.BAG), fwd: [0, 1, 0.2] });
		// Shopping bag in the right hand.
		blob([-(P.shX + 0.045), 0.6, 0.005], [0.035, 0.15, 0.12], 5, W(B.FORE_R), REGION.BAG, acc4(ACC.SHOPPING));
		// Scarf round the neck with one end hanging in front.
		const sn = [12, 6][lod], sr = [5, 3][lod];
		acc.grid(sr, sn, (i, k) => {
			const th = (k / sn) * Math.PI * 2, ph = (i / sr) * Math.PI * 2;
			const R = [P.neck + 0.022, P.neck + 0.018];
			const rr = 0.019 + 0.004 * Math.cos(th * 2);
			const cx = Math.sin(th) * (R[0] + Math.cos(ph) * rr), cz = Math.cos(th) * (R[1] + Math.cos(ph) * rr) - 0.004;
			return { p: [cx, 1.492 + Math.sin(ph) * rr * 1.2, cz], skin: W(B.CHEST, B.HEAD, 0.25), region: REGION.ACCENT };
		}, { info: acc4(ACC.SCARF) });
		const end = [[0.03, 1.47, P.neck + 0.03], [0.045, 1.38, P.chestF + P.bust * 0.5 + 0.03], [0.05, 1.25, P.chestF + P.bust + 0.022]];
		if (lod === 0) tube(acc, end.map((p) => ({ c: p, rx: 0.034, rf: 0.007, rb: 0.007, e: 3, skin: W(B.CHEST), region: REGION.ACCENT })), 4, { info: acc4(ACC.SCARF), caps: [false, true] });
		if (lod === 0) {
			// Phone in the right hand (screen on the palm side, +x).
			blob([-(P.shX + 0.03) + 0.022, 0.79, 0.012], [0.005, 0.075, 0.036], 6, W(B.FORE_R), REGION.PHONE, [GROUP.PHONE, 0, 0, 0], 8, 4);
			// Walking stick.
			const stick = [[-(P.shX + 0.03), 0.84, 0.03], [-(P.shX + 0.05), 0.0, 0.06]];
			tube(acc, stick.map((p) => ({ c: p, rx: 0.011, rf: 0.011, rb: 0.011, e: 2, skin: W(B.FORE_R), region: REGION.STICK })), 5, { info: acc4(ACC.STICK), caps: [true, true] });
		}
	}
	return acc;
}

/** Smooth per-part normals (each part is its own surface). */
function normals(acc) {
	const n = new Float32Array(acc.p.length), P = acc.p, I = acc.idx;
	for (const part of acc.parts) {
		for (let i = part.i0; i < part.i1; i += 3) {
			const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
			const e1 = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], e2 = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]];
			const f = cross(e1, e2);
			for (const v of [a, b, c]) { n[v] += f[0]; n[v + 1] += f[1]; n[v + 2] += f[2]; }
		}
	}
	for (let v = 0; v < n.length; v += 3) {
		const l = Math.hypot(n[v], n[v + 1], n[v + 2]) || 1;
		n[v] /= l; n[v + 1] /= l; n[v + 2] /= l;
	}
	return n;
}

/** Typed arrays for one level of detail: position, normal, skin, info, fem, fat, index. */
export function buildPerson(lod = 0) {
	const m = figure(BODY.male, lod), f = figure(BODY.female, lod), h = figure(BODY.heavy, lod);
	const position = new Float32Array(m.p);
	const fem = new Float32Array(m.p.length), fat = new Float32Array(m.p.length);
	for (let i = 0; i < m.p.length; i++) { fem[i] = f.p[i] - m.p[i]; fat[i] = h.p[i] - m.p[i]; }
	const normal = normals(m);
	const count = position.length / 3;
	const index = count > 65535 ? new Uint32Array(m.idx) : new Uint16Array(m.idx);
	return { position, normal, skin: new Float32Array(m.skin), info: new Float32Array(m.info), fem, fat, index, count, triangles: m.idx.length / 3 };
}

/** Joint pivots of the male, female and heavy bodies (for the shader). */
export function jointSets() {
	return { male: joints(BODY.male), female: joints(BODY.female), heavy: joints(BODY.heavy) };
}
