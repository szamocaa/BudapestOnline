// Shop signs drawn into one shared, streamed atlas (one canvas texture for the whole city).
//
// facadesGeom.js emits a sign request per shopfront fascia (out.signs: wall frame, t0/t1, y0/y1,
// depth, the OSM POI, the glazing mode). buildings.js keeps them per chunk; chunks within SIGN_R
// get one merged sign mesh (one draw call, shared material), whose cells are allocated here by
// sign content, so the 80 Nemzeti Dohánybolt shops share one cell. Cells are reference counted
// and recycled least-recently-released first when the atlas is full.
//
// Pure logic (content, cells, geometry) runs in Node (tests/web/buildings.test.mjs); drawing needs
// a canvas (browser only).
import { GLASS } from './facadesGeom.js';

export const ATLAS = { W: 2048, H: 2048, CW: 512, CH: 80 };
ATLAS.COLS = Math.floor(ATLAS.W / ATLAS.CW);
ATLAS.ROWS = Math.floor(ATLAS.H / ATLAS.CH);
ATLAS.CELLS = ATLAS.COLS * ATLAS.ROWS;
const ASPECT = ATLAS.CW / ATLAS.CH; // 6.4 : 1, close to a Pest shop fascia

const SANS = 'Arial, Helvetica, "Liberation Sans", sans-serif';
const SERIF = 'Georgia, "Times New Roman", "Liberation Serif", serif';

// Unnamed shopfronts: the usual small trades of a Józsefváros ground floor.
const GENERIC = [
	['ÉLELMISZER', '#1d6b3a', '#ffffff', 0.5], ['PÉKSÉG', '#6b4426', '#f6e3c0', 0.4], ['FODRÁSZAT', '#151515', '#f2f2f2', 0.3],
	['ZÁLOGHÁZ', '#6a1420', '#e8c66a', 0.5], ['ÉKSZER · ARANY', '#13234a', '#e2c26b', 0.5], ['OPTIKA', '#f4f4f2', '#1d4f9a', 0.4],
	['VIRÁG', '#2f5d2a', '#ffffff', 0.3], ['NON-STOP', '#c4161c', '#ffffff', 0.9], ['PAPÍR · ÍRÓSZER', '#1f4e8c', '#ffffff', 0.4],
	['TELEFONSZERVIZ', '#111111', '#4fd3ff', 0.7], ['KULCSMÁSOLÁS', '#f2c400', '#151515', 0.3], ['CIPŐJAVÍTÁS', '#efebe2', '#2a2a2a', 0.2],
	['HASZNÁLT RUHA', '#d4561f', '#ffffff', 0.4], ['GYROS · PIZZA', '#b5121b', '#ffd23a', 0.8], ['BÜFÉ', '#fbfbf7', '#b5121b', 0.5],
	['PÉNZVÁLTÓ · EXCHANGE', '#f2c400', '#111111', 0.8], ['DROGÉRIA', '#c2185b', '#ffffff', 0.4], ['SZÉPSÉGSZALON', '#1a1a1a', '#f3a6c8', 0.5],
	['ZÖLDSÉG · GYÜMÖLCS', '#3b7a1e', '#ffffff', 0.3], ['HÚS · HENTESÁRU', '#9b1b1b', '#ffffff', 0.4], ['MOBIL · SIM · TARTOZÉK', '#0e0e10', '#ffffff', 0.7],
	['PATYOLAT', '#1d5fa8', '#ffffff', 0.3], ['LOTTÓZÓ', '#d0021b', '#ffffff', 0.5], ['ITALDISZKONT', '#2a1f4d', '#ffcf3f', 0.6],
];
const NAMED_PALETTE = [['#1b1b1b', '#ffffff'], ['#f3f1ea', '#1b1b1b'], ['#14365e', '#ffffff'], ['#5a1a1a', '#f0d79a'], ['#2c4a2e', '#f3efe2'], ['#7a0f14', '#ffffff'], ['#e9e1cf', '#5a1a1a'], ['#263238', '#ffd54f']];

const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const up = (s) => s.toLocaleUpperCase('hu-HU');

/**
 * What a sign request shows: { key (atlas cell identity), design, text, sub, bg, fg, glow (night
 * emission), frac (used width of the cell, 1 = a full fascia), place ('fascia' | 'window'),
 * blade (a projecting double-sided sign as well) } or null for no sign.
 */
export function signContent(req) {
	const poi = req.poi, mode = req.mode, seed = req.seed ?? 0.5;
	const name = poi && poi.name ? poi.name.trim() : '';
	const kind = poi ? poi.kind : '';
	if (mode === GLASS.EMPTY && !poi) {
		// To let: a paper poster stuck inside the window, the fascia left blank.
		return seed < 0.7 ? { key: 'kiado', design: 'kiado', text: 'KIADÓ', sub: 'ÜZLETHELYISÉG', bg: '#fbfaf5', fg: '#d0101b', glow: 0, frac: 0.3, place: 'window' } : null;
	}
	if (mode === GLASS.TOBACCO || (kind === 'tobacco' && mode !== GLASS.VAPE)) {
		return { key: 'tobacco', design: 'tobacco', text: 'NEMZETI DOHÁNYBOLT', bg: '#3e2a1d', fg: '#ffffff', glow: 0.55, frac: 1, place: 'fascia' };
	}
	if (mode === GLASS.VAPE || kind === 'vape') {
		const t = name ? up(name) : 'VAPE SHOP';
		return { key: 'vape:' + t, design: 'neon', text: t, sub: name && !/vape/i.test(name) ? 'VAPE · E-CIGI · LIQUID' : 'E-CIGI · LIQUID', bg: '#07070c', fg: seed < 0.5 ? '#39ff88' : '#ff3fd2', glow: 2.6, frac: 1, place: 'fascia' };
	}
	if (mode === GLASS.PHARMACY || kind === 'pharmacy') {
		const t = name ? name : 'Gyógyszertár';
		return { key: 'pharmacy:' + t, design: 'pharmacy', text: t, sub: /gyógyszert|patika/i.test(t) ? '' : 'GYÓGYSZERTÁR', bg: '#0b6e3b', fg: '#ffffff', glow: 0.9, frac: 1, place: 'fascia', blade: true };
	}
	if (kind === 'school' || kind === 'church' || kind === 'atm') return null;
	if (kind === 'police') return { key: 'police', design: 'plain', text: 'RENDŐRSÉG', bg: '#123a7a', fg: '#ffffff', glow: 0.5, frac: 1, place: 'fascia' };
	if (name) {
		if (kind === 'cafe') return { key: 'cafe:' + name, design: 'serif', text: name, sub: 'KÁVÉZÓ', bg: '#2a1d14', fg: '#f1cf8e', glow: 0.8, frac: 1, place: 'fascia' };
		if (kind === 'bar') return { key: 'bar:' + name, design: 'serif', text: name, sub: seed < 0.5 ? 'SÖRÖZŐ' : 'BÁR', bg: '#121212', fg: '#ffb347', glow: 1.0, frac: 1, place: 'fascia' };
		if (kind === 'food') return { key: 'food:' + name, design: 'plain', text: up(name), bg: seed < 0.5 ? '#a3121a' : '#1a1a1a', fg: seed < 0.5 ? '#ffd23a' : '#ffffff', glow: 0.9, frac: 1, place: 'fascia' };
		if (kind === 'grocery') return { key: 'grocery:' + name, design: 'plain', text: up(name), sub: 'ÉLELMISZER', bg: '#1d6b3a', fg: '#ffffff', glow: 0.6, frac: 1, place: 'fascia' };
		const [bg, fg] = NAMED_PALETTE[hash(name) % NAMED_PALETTE.length];
		return { key: 'shop:' + name, design: hash(name) % 3 === 0 ? 'serif' : 'plain', text: hash(name) % 3 === 0 ? name : up(name), bg, fg, glow: 0.45, frac: 1, place: 'fascia' };
	}
	if (kind === 'grocery') return { key: 'gen:abc', design: 'plain', text: 'ABC · ÉLELMISZER', bg: '#1d6b3a', fg: '#ffffff', glow: 0.6, frac: 1, place: 'fascia' };
	if (kind === 'kiosk') return { key: 'gen:trafik', design: 'plain', text: 'ÚJSÁG · TRAFIK', bg: '#1f4e8c', fg: '#ffffff', glow: 0.5, frac: 1, place: 'fascia' };
	if (kind === 'cafe') return { key: 'gen:kavezo', design: 'serif', text: 'Kávézó', bg: '#2a1d14', fg: '#f1cf8e', glow: 0.8, frac: 1, place: 'fascia' };
	if (kind === 'bar') return { key: 'gen:sorozo', design: 'serif', text: 'Söröző', bg: '#121212', fg: '#ffb347', glow: 1.0, frac: 1, place: 'fascia' };
	if (kind === 'food') return { key: 'gen:bufe', design: 'plain', text: 'BÜFÉ', bg: '#fbfbf7', fg: '#b5121b', glow: 0.6, frac: 1, place: 'fascia' };
	if (mode !== GLASS.SHOP && mode !== GLASS.EMPTY) return null;
	// Unnamed shop: most carry a trade sign, some none (or a sign the OSM data does not know).
	if (seed < 0.28) return null;
	const g = GENERIC[Math.floor(((seed - 0.28) / 0.72) * GENERIC.length) % GENERIC.length];
	return { key: 'gen:' + g[0], design: 'plain', text: g[0], bg: g[1], fg: g[2], glow: g[3], frac: 1, place: 'fascia' };
}

/** Atlas cells by content key, reference counted; released cells are reused oldest first. */
export class SignCells {
	constructor(n = ATLAS.CELLS) { this.n = n; this.byKey = new Map(); this.keyOf = new Array(n).fill(null); this.used = 0; this.clock = 0; this.free = new Map(); }
	/** Returns { cell, fresh } (fresh: needs drawing) or null when every cell is referenced. */
	acquire(key) {
		const e = this.byKey.get(key);
		if (e) {
			if (e.refs++ === 0) this.free.delete(e.cell);
			return { cell: e.cell, fresh: false };
		}
		let cell;
		if (this.used < this.n) cell = this.used++;
		else {
			if (!this.free.size) return null;
			let best = -1, bestT = Infinity;
			for (const [c, t] of this.free) if (t < bestT) { bestT = t; best = c; }
			cell = best;
			this.free.delete(cell);
			this.byKey.delete(this.keyOf[cell]);
		}
		this.keyOf[cell] = key;
		this.byKey.set(key, { cell, refs: 1 });
		return { cell, fresh: true };
	}
	release(key) {
		const e = this.byKey.get(key);
		if (!e || e.refs <= 0) return;
		if (--e.refs === 0) this.free.set(e.cell, ++this.clock);
	}
}

/** uv rectangle [u0, v0, u1, v1] of a cell (flipY texture: v grows upwards), inset against bleeding. */
export function cellUV(cell, frac = 1, x0 = 0) {
	const cx = cell % ATLAS.COLS, cy = Math.floor(cell / ATLAS.COLS);
	const px0 = cx * ATLAS.CW + x0 * ATLAS.CW + 2, px1 = cx * ATLAS.CW + (x0 + frac) * ATLAS.CW - 2;
	const py0 = cy * ATLAS.CH + 2, py1 = cy * ATLAS.CH + ATLAS.CH - 2;
	return [px0 / ATLAS.W, 1 - py1 / ATLAS.H, px1 / ATLAS.W, 1 - py0 / ATLAS.H];
}

/** Sign geometry buffers: position, normal, uv, glow; index. */
export class SignBuf {
	constructor() { this.pos = []; this.nrm = []; this.uv = []; this.glow = []; this.idx = []; this.n = 0; }
	/** Quad from four [x, y, z] corners (bottom-left, bottom-right, top-right, top-left seen from the front). */
	quad(c, nx, nz, uv, glow) {
		const b = this.n;
		const U = [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]];
		for (let k = 0; k < 4; k++) { this.pos.push(c[k][0], c[k][1], c[k][2]); this.nrm.push(nx, 0, nz); this.uv.push(U[k][0], U[k][1]); this.glow.push(glow); }
		// Front faces counter-clockwise seen from the normal side.
		const ex = c[1][0] - c[0][0], ez = c[1][2] - c[0][2];
		// Geometric normal of (c0, c1, c3) for an upright quad is (−ez, 0, ex) · sign.
		if (-ez * nx + ex * nz >= 0) this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
		else this.idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
		this.n += 4;
	}
}

/**
 * Lays out the signs of one chunk. reqs: facadesGeom sign requests; cellFor(content) → cell index or
 * -1. Returns { buf, keys } (keys: the content keys acquired, to release with the chunk).
 */
export function layoutSigns(reqs, cellFor) {
	const buf = new SignBuf();
	const keys = [];
	for (const q of reqs) {
		const c = q.content !== undefined ? q.content : (q.content = signContent(q));
		if (!c) continue;
		const cell = cellFor(c);
		if (cell < 0) continue;
		keys.push(c.key);
		const F = q.F;
		const X = (t, d) => F.ax + F.ux * t + F.nx * d, Z = (t, d) => F.az + F.uz * t + F.nz * d;
		// Text must read left to right for someone facing the wall: viewer's right is (nz, -nx).
		const flip = F.ux * F.nz - F.uz * F.nx < 0;
		const corners = (a, b, y0, y1, d) => {
			const [t0, t1] = flip ? [b, a] : [a, b];
			return [[X(t0, d), y0, Z(t0, d)], [X(t1, d), y0, Z(t1, d)], [X(t1, d), y1, Z(t1, d)], [X(t0, d), y1, Z(t0, d)]];
		};
		if (c.place === 'window') {
			// Poster inside the shop window, low and off-centre.
			const w = 0.95, h = w / (ASPECT * c.frac);
			const tc = (q.t0 + q.t1) / 2 + (q.seed - 0.5) * Math.max(0, q.t1 - q.t0 - 1.6);
			const y0 = q.bottom + 1.05;
			buf.quad(corners(tc - w / 2, tc + w / 2, y0, y0 + h, -0.2), F.nx, F.nz, cellUV(cell, c.frac), c.glow);
			continue;
		}
		// Fascia: full shop width, height from the art's aspect (at most the fascia band).
		const wa = q.t1 - q.t0;
		const band = q.y1 - q.y0;
		const h = Math.min(band, wa / (ASPECT * c.frac));
		const ym = (q.y0 + q.y1) / 2;
		buf.quad(corners(q.t0, q.t1, ym - h / 2, ym + h / 2, q.d + 0.02), F.nx, F.nz, cellUV(cell, c.frac), c.glow);
		if (c.blade) {
			// Projecting lit green cross, double-sided, beside the shop at first-floor sill height.
			const s = 0.62, t = q.t1 + 0.35, yb = q.y1 + 0.25;
			const uv = cellUV(cell, 1 / ASPECT, 1 - 1 / ASPECT);
			const P = (d, y) => [X(t, d), y, Z(t, d)];
			buf.quad([P(0.12, yb), P(0.12 + s, yb), P(0.12 + s, yb + s), P(0.12, yb + s)], -F.ux, -F.uz, uv, 1.6);
			buf.quad([P(0.12 + s, yb), P(0.12, yb), P(0.12, yb + s), P(0.12 + s, yb + s)], F.ux, F.uz, uv, 1.6);
		}
	}
	return { buf, keys };
}

// ---------------------------------------------------------------- drawing (browser)

function fitText(g, text, font, size, maxW, minScale = 0.62) {
	g.font = font.replace('{s}', size);
	let w = g.measureText(text).width;
	while (w * minScale > maxW && size > 10) { size -= 2; g.font = font.replace('{s}', size); w = g.measureText(text).width; }
	return { size, sx: w > maxW ? maxW / w : 1 };
}

function drawText(g, text, x, y, maxW, font, size, color) {
	const { sx } = fitText(g, text, font, size, maxW);
	g.save();
	g.translate(x, y);
	g.scale(sx, 1);
	g.fillStyle = color;
	g.fillText(text, 0, 0);
	g.restore();
}

function shade(hex, k) {
	const n = parseInt(hex.slice(1), 16);
	const f = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
	return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

/** Draws one sign's art into its cell of the atlas canvas context. */
export function drawSign(g, cell, c) {
	const W = ATLAS.CW, H = ATLAS.CH;
	const x0 = (cell % ATLAS.COLS) * W, y0 = Math.floor(cell / ATLAS.COLS) * H;
	g.save();
	g.translate(x0, y0);
	g.beginPath(); g.rect(0, 0, W, H); g.clip();
	g.textAlign = 'center';
	g.textBaseline = 'middle';
	const panel = (bg) => {
		const gr = g.createLinearGradient(0, 0, 0, H);
		gr.addColorStop(0, shade(bg, 1.12)); gr.addColorStop(0.5, bg); gr.addColorStop(1, shade(bg, 0.82));
		g.fillStyle = gr; g.fillRect(0, 0, W, H);
	};
	const twoLines = (left, right, mainFont, mainSize, color, subColor) => {
		const cx = (left + right) / 2, mw = right - left;
		if (c.sub) {
			drawText(g, c.text, cx, H * 0.4, mw, mainFont, mainSize, color);
			drawText(g, c.sub, cx, H * 0.8, mw, `bold {s}px ${SANS}`, 13, subColor || color);
		} else drawText(g, c.text, cx, H * 0.53, mw, mainFont, mainSize + 6, color);
	};
	if (c.design === 'tobacco') {
		panel(c.bg);
		// Tricolour band on the left, the age limit roundel on the right.
		const bw = 11;
		[['#ce2939', 10], ['#ffffff', 10 + bw], ['#477050', 10 + bw * 2]].forEach(([col, x]) => { g.fillStyle = col; g.fillRect(x, 8, bw, H - 16); });
		g.fillStyle = '#ffffff'; g.beginPath(); g.arc(W - 38, H / 2, 25, 0, Math.PI * 2); g.fill();
		g.strokeStyle = '#d0101b'; g.lineWidth = 6; g.beginPath(); g.arc(W - 38, H / 2, 22, 0, Math.PI * 2); g.stroke();
		drawText(g, '18', W - 38, H / 2 + 1, 30, `bold {s}px ${SANS}`, 22, '#111111');
		drawText(g, 'NEMZETI DOHÁNYBOLT', (52 + W - 72) / 2, H / 2 + 2, W - 72 - 52, `bold {s}px ${SANS}`, 40, '#ffffff');
		g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(52, H - 10, W - 124, 2);
	} else if (c.design === 'neon') {
		g.fillStyle = c.bg; g.fillRect(0, 0, W, H);
		g.strokeStyle = c.fg; g.lineWidth = 3; g.shadowColor = c.fg; g.shadowBlur = 10;
		g.strokeRect(6, 6, W - 12, H - 12);
		const cx = W / 2;
		for (let k = 0; k < 2; k++) {
			g.shadowBlur = k ? 4 : 16;
			drawText(g, c.text, cx, H * 0.42, W - 40, `bold {s}px ${SANS}`, 40, k ? '#f4fff8' : c.fg);
		}
		g.shadowBlur = 6;
		drawText(g, c.sub, cx, H * 0.8, W - 60, `bold {s}px ${SANS}`, 13, c.fg);
		g.shadowBlur = 0;
	} else if (c.design === 'pharmacy') {
		panel(c.bg);
		// Cross roundel at the left; the right end holds the blade-sign square (drawn separately).
		const cross = (cx, cy, r, col) => { g.fillStyle = col; g.fillRect(cx - r, cy - r * 0.33, r * 2, r * 0.66); g.fillRect(cx - r * 0.33, cy - r, r * 0.66, r * 2); };
		g.fillStyle = '#ffffff'; g.beginPath(); g.arc(40, H / 2, 28, 0, Math.PI * 2); g.fill();
		cross(40, H / 2, 19, '#0b8a45');
		twoLines(76, W - H - 10, `bold {s}px ${SERIF}`, 34, '#ffffff', '#d8f2e2');
		// Blade square: a lit green cross on dark glass, the last H x H pixels of the cell.
		g.fillStyle = '#0d1410'; g.fillRect(W - H, 0, H, H);
		g.shadowColor = '#22ff7a'; g.shadowBlur = 8;
		cross(W - H / 2, H / 2, 30, '#19d564');
		g.shadowBlur = 0;
	} else if (c.design === 'kiado') {
		const w = W * c.frac;
		g.fillStyle = c.bg; g.fillRect(0, 0, w, H);
		g.strokeStyle = '#d0101b'; g.lineWidth = 3; g.strokeRect(4, 4, w - 8, H - 8);
		drawText(g, c.text, w / 2, H * 0.42, w - 16, `bold {s}px ${SANS}`, 36, c.fg);
		drawText(g, c.sub, w / 2, H * 0.78, w - 16, `bold {s}px ${SANS}`, 12, '#222222');
	} else {
		panel(c.bg);
		g.strokeStyle = shade(c.fg, 0.9); g.globalAlpha = 0.5; g.lineWidth = 2; g.strokeRect(5, 5, W - 10, H - 10); g.globalAlpha = 1;
		const font = c.design === 'serif' ? `italic bold {s}px ${SERIF}` : `bold {s}px ${SANS}`;
		twoLines(16, W - 16, font, 36, c.fg);
	}
	g.restore();
}
