// Procedural textures shared by the landmarks-b models (Erkel Színház, the Rákóczi tér market hall,
// the churches, Kerepesi temető, Ludovika, Corvin mozi). Every texture is drawn once on a canvas
// and cached, so all models share the same few images.
//
// Tiling textures are authored for UVs in metres (see b-kit.js): `repeat` is set so one image
// covers `tile` metres. Colour maps are near-white so vertex colours tint them to the real colour.
import * as THREE from '../../vendor/three.module.min.js';
import { rng } from '../../geo.js';

const cache = new Map();
const once = (key, fn) => {
	if (!cache.has(key)) cache.set(key, fn());
	return cache.get(key);
};

function canvas(w, h) {
	const c = typeof OffscreenCanvas !== 'undefined' && typeof document === 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
	c.width = w;
	c.height = h;
	return [c, c.getContext('2d', { willReadFrequently: true })];
}

function tex(c, { srgb = true, repeat = 1, wrap = true, aniso = 8 } = {}) {
	const t = new THREE.CanvasTexture(c);
	if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.repeat.set(repeat, repeat);
	t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
	t.anisotropy = aniso;
	t.needsUpdate = true;
	return t;
}

/** Periodic value noise in [0, 1]: n(x, y) tiles every `period` units. */
export function periodicNoise(seed, period) {
	const r = rng(seed);
	const g = new Float32Array(period * period);
	for (let i = 0; i < g.length; i++) g[i] = r();
	const at = (x, y) => g[(((y % period) + period) % period) * period + (((x % period) + period) % period)];
	return (x, y) => {
		const x0 = Math.floor(x), y0 = Math.floor(y);
		const fx = x - x0, fy = y - y0;
		const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
		const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
		return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
	};
}

/** Fractal sum of periodic noise; tiles over a `size`-pixel image. */
function fbm(seed, size, base, octaves) {
	const layers = [];
	for (let o = 0; o < octaves; o++) layers.push({ n: periodicNoise(seed + o * 101, base << o), k: 1 / (1 << o), f: (base << o) / size });
	const norm = layers.reduce((s, l) => s + l.k, 0);
	return (x, y) => {
		let v = 0;
		for (const l of layers) v += l.n(x * l.f, y * l.f) * l.k;
		return v / norm;
	};
}

/**
 * Builds a colour map + matching normal map from a per-pixel function.
 * fn(x, y) → [r, g, b, height]   (colour 0..255, height 0..1)
 */
function material(size, fn, { strength = 2.5, tile = 1 } = {}) {
	const [c, g] = canvas(size, size);
	const img = g.createImageData(size, size);
	const hgt = new Float32Array(size * size);
	for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
		const [r, gg, b, h] = fn(x, y);
		const i = (y * size + x) * 4;
		img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
		hgt[y * size + x] = h;
	}
	g.putImageData(img, 0, 0);
	const [nc, ng] = canvas(size, size);
	const nimg = ng.createImageData(size, size);
	const H = (x, y) => hgt[((y + size) % size) * size + ((x + size) % size)];
	for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
		const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
		const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
		const l = Math.hypot(dx, dy, 1);
		const i = (y * size + x) * 4;
		nimg.data[i] = Math.round((-dx / l * 0.5 + 0.5) * 255);
		nimg.data[i + 1] = Math.round((dy / l * 0.5 + 0.5) * 255);
		nimg.data[i + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
		nimg.data[i + 3] = 255;
	}
	ng.putImageData(nimg, 0, 0);
	return { map: tex(c, { repeat: 1 / tile }), normal: tex(nc, { srgb: false, repeat: 1 / tile }), tile };
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Lime plaster with mottling, faint streaks and grain. One image = 4 m. */
export const plasterTex = () => once('plaster', () => {
	const S = 512, n = fbm(11, S, 4, 5), fine = periodicNoise(12, 128), streak = periodicNoise(13, 64);
	return material(S, (x, y) => {
		const m = n(x, y);
		const f = fine(x / 4, y / 4);
		const st = streak(x / 8, y / 64) * streak(x / 3, y / 90);
		const v = 236 + (m - 0.5) * 30 + (f - 0.5) * 10 - st * 14;
		return [clamp255(v + 2), clamp255(v), clamp255(v - 3), m * 0.6 + f * 0.4];
	}, { strength: 1.6, tile: 4 });
});

/**
 * Dressed stone in courses (ashlar). One image = 3 m; courses 0.5 m, blocks 0.75–1.5 m long.
 * `rough` adds rock-faced (rusticated) bosses.
 */
export const stoneTex = (rough = false) => once('stone' + rough, () => {
	const S = 512, px = S / 3, course = 0.5 * px, joint = rough ? 5 : 2.5;
	const r = rng(rough ? 31 : 21), n = fbm(rough ? 32 : 22, S, 8, 4), fine = periodicNoise(23, 256);
	const rows = [];
	for (let k = 0; k < 6; k++) {
		const cuts = [];
		let x = r() * px;
		while (x < S + 2 * px) { cuts.push(x); x += (0.75 + r() * 0.75) * px; }
		rows.push({ cuts: cuts.map((c) => c % S).sort((a, b) => a - b), tones: cuts.map(() => (r() - 0.5) * 22) });
	}
	return material(S, (x, y) => {
		const row = rows[Math.floor(y / course) % 6];
		const yy = y % course;
		let dx = Infinity, tone = 0;
		for (let i = 0; i < row.cuts.length; i++) {
			const d = Math.abs(x - row.cuts[i]);
			const dw = Math.min(d, S - d);
			if (dw < dx) dx = dw;
		}
		// Block tone: the cut to the left of x.
		let ci = row.cuts.length - 1;
		for (let i = 0; i < row.cuts.length; i++) if (row.cuts[i] <= x) ci = i;
		tone = row.tones[ci];
		const dy = Math.min(yy, course - yy);
		const edge = Math.min(dx, dy);
		const inJoint = edge < joint;
		const m = n(x, y), f = fine(x / 2, y / 2);
		let h = inJoint ? 0 : Math.min(1, (edge - joint) / (rough ? 14 : 3)) * (rough ? 0.55 + m * 0.45 : 0.85 + f * 0.15);
		if (rough) h *= 0.75 + 0.25 * fine(x / 1.3, y / 1.3);
		const v = inJoint ? 196 : 234 + tone + (m - 0.5) * 26 + (f - 0.5) * 12;
		return [clamp255(v + 2), clamp255(v), clamp255(v - 4), h];
	}, { strength: rough ? 4 : 3, tile: 3 });
});

/** Brick in stretcher bond with lime mortar. One image = 1.6 m (24 courses). */
export const brickTex = () => once('brick', () => {
	const S = 512, courses = 24, ch = S / courses, bl = S / 6;
	const r = rng(41), n = fbm(42, S, 8, 3), fine = periodicNoise(43, 256);
	const tones = [];
	for (let i = 0; i < courses * 7; i++) tones.push((r() - 0.5) * 34 + (r() < 0.06 ? -30 : 0));
	return material(S, (x, y) => {
		const row = Math.floor(y / ch);
		const off = row % 2 ? bl / 2 : 0;
		const xx = (x + off) % S;
		const col = Math.floor(xx / bl);
		const jx = Math.min(xx % bl, bl - (xx % bl)), jy = Math.min(y % ch, ch - (y % ch));
		const mortar = jx < 2.2 || jy < 2.2;
		const f = fine(x / 2, y / 2), m = n(x, y);
		if (mortar) return [222 + f * 10, 216 + f * 10, 204 + f * 10, 0.05];
		const t = tones[row * 7 + col];
		const v = 236 + t + (m - 0.5) * 14 + (f - 0.5) * 16;
		return [clamp255(v), clamp255(v - 2), clamp255(v - 6), 0.6 + f * 0.25];
	}, { strength: 2.6, tile: 1.6 });
});

/** Roof covering: overlapping plain tiles / slates in rows. One image = 2 m. */
export const roofTex = () => once('roof', () => {
	const S = 512, rows = 12, rh = S / rows, tw = S / 10;
	const r = rng(51), fine = periodicNoise(52, 256), n = fbm(53, S, 4, 3);
	const tones = [];
	for (let i = 0; i < rows * 11; i++) tones.push((r() - 0.5) * 30);
	return material(S, (x, y) => {
		const row = Math.floor(y / rh);
		const off = row % 2 ? tw / 2 : 0;
		const xx = (x + off) % S;
		const col = Math.floor(xx / tw);
		const yy = (y % rh) / rh; // 0 top of the visible part .. 1 bottom edge
		const jx = Math.min(xx % tw, tw - (xx % tw));
		const f = fine(x / 2, y / 2), m = n(x, y);
		const gap = jx < 1.6;
		const v = gap ? 150 : 232 + tones[row * 11 + col] + (m - 0.5) * 30 - yy * 18 + (f - 0.5) * 10;
		const h = gap ? 0.1 : 0.35 + yy * 0.6 + f * 0.05;
		return [clamp255(v), clamp255(v), clamp255(v), h];
	}, { strength: 3, tile: 2 });
});

/** Standing-seam sheet metal (zinc / copper). One image = 2 m, seams every 0.5 m. */
export const metalTex = () => once('metal', () => {
	const S = 256, seam = S / 4, n = fbm(61, S, 4, 4), fine = periodicNoise(62, 128);
	return material(S, (x, y) => {
		const d = Math.min(x % seam, seam - (x % seam));
		const m = n(x, y), f = fine(x / 2, y / 2);
		const ridge = d < 2 ? 1 : d < 4 ? 0.4 : 0.15;
		const v = 228 + (m - 0.5) * 50 + (f - 0.5) * 8 + (d < 2 ? 14 : 0);
		return [clamp255(v), clamp255(v), clamp255(v), ridge + m * 0.05];
	}, { strength: 2.2, tile: 2 });
});

/** Fine-grained noise for bronze, iron and polished stone. One image = 2 m. */
export const grainTex = () => once('grain', () => {
	const S = 256, n = fbm(71, S, 8, 4), fine = periodicNoise(72, 128);
	return material(S, (x, y) => {
		const m = n(x, y), f = fine(x / 2, y / 2);
		const v = 225 + (m - 0.5) * 50 + (f - 0.5) * 16;
		return [clamp255(v), clamp255(v), clamp255(v), m];
	}, { strength: 1.2, tile: 2 });
});

// ---------------------------------------------------------------------------------- detail atlas
// One 1024² atlas of 4×4 cells for windows, doors, gates, clock faces and stained glass, with a
// matching emissive map (lit windows at night). Cell indices:
export const CELL = {
	sash: 0, sashCurtain: 1, sashDark: 2, sashBlind: 3, // rectangular windows (lit in 0 and 1)
	arched: 4, archedLit: 5, // round-headed windows (alpha-cut corners)
	stained: 6, rose: 7, // church glass (glow warm at night), round window
	lobby: 8, door: 9, gate: 10, clock: 11, // glazed lobby wall, panelled double door, iron gate, clock dial
	louvre: 12, shop: 13, archedDoor: 14, darkGlass: 15,
};
export const cellUV = (i) => {
	const cx = i % 4, cy = Math.floor(i / 4);
	// Half-texel inset so mipmaps do not bleed between cells.
	const e = 2 / 1024;
	return [cx / 4 + e, 1 - (cy + 1) / 4 + e, (cx + 1) / 4 - e, 1 - cy / 4 - e];
};

export const detailAtlas = () => once('atlas', () => {
	const S = 1024, C = 256;
	const [c, g] = canvas(S, S);
	const [e, ge] = canvas(S, S);
	ge.fillStyle = '#000';
	ge.fillRect(0, 0, S, S);
	g.clearRect(0, 0, S, S);
	const r = rng(81);
	const cell = (i) => [(i % 4) * C, Math.floor(i / 4) * C];

	const glass = (x, y, w, h, tint = [38, 48, 58]) => {
		const gr = g.createLinearGradient(x, y, x + w * 0.4, y + h);
		gr.addColorStop(0, `rgb(${tint[0] + 70},${tint[1] + 78},${tint[2] + 88})`);
		gr.addColorStop(0.45, `rgb(${tint[0] + 12},${tint[1] + 16},${tint[2] + 22})`);
		gr.addColorStop(1, `rgb(${tint[0]},${tint[1]},${tint[2]})`);
		g.fillStyle = gr;
		g.fillRect(x, y, w, h);
	};
	const lit = (x, y, w, h, col = [255, 206, 140], k = 1) => {
		const gr = ge.createLinearGradient(x, y, x, y + h);
		gr.addColorStop(0, `rgb(${col[0] * k * 0.75},${col[1] * k * 0.75},${col[2] * k * 0.75})`);
		gr.addColorStop(1, `rgb(${col[0] * k},${col[1] * k},${col[2] * k})`);
		ge.fillStyle = gr;
		ge.fillRect(x, y, w, h);
	};
	// Rectangular double casement window with transom (the Budapest "kapcsolt gerébtok" look).
	const sash = (i, { curtain = false, blind = false, light = false, dark = false } = {}) => {
		const [x, y] = cell(i);
		g.fillStyle = '#e9e4da';
		g.fillRect(x, y, C, C);
		const fx = x + 18, fy = y + 10, fw = C - 36, fh = C - 20;
		glass(fx, fy, fw, fh, dark ? [18, 22, 28] : [34, 44, 54]);
		if (light) lit(fx, fy, fw, fh, r() < 0.5 ? [255, 214, 150] : [255, 196, 120]);
		if (curtain) {
			g.fillStyle = 'rgba(236,228,210,0.85)';
			g.fillRect(fx, fy + fh * 0.3, fw * 0.28, fh * 0.7);
			g.fillRect(fx + fw * 0.72, fy + fh * 0.3, fw * 0.28, fh * 0.7);
			if (light) { ge.fillStyle = 'rgb(200,150,90)'; ge.fillRect(fx, fy + fh * 0.3, fw * 0.28, fh * 0.7); ge.fillRect(fx + fw * 0.72, fy + fh * 0.3, fw * 0.28, fh * 0.7); }
		}
		if (blind) {
			g.fillStyle = '#b9b2a4';
			g.fillRect(fx, fy, fw, fh * 0.55);
			g.fillStyle = 'rgba(0,0,0,0.12)';
			for (let k = fy; k < fy + fh * 0.55; k += 6) g.fillRect(fx, k, fw, 1);
		}
		// Frame: outer, mullion, transom.
		g.fillStyle = '#f2efe8';
		g.fillRect(fx - 8, fy - 6, fw + 16, 8);
		g.fillRect(fx - 8, fy + fh - 2, fw + 16, 8);
		g.fillRect(fx - 8, fy, 8, fh);
		g.fillRect(fx + fw, fy, 8, fh);
		g.fillRect(fx + fw / 2 - 5, fy, 10, fh);
		g.fillRect(fx, fy + fh * 0.3 - 4, fw, 9);
		g.fillRect(fx + fw / 4 - 2, fy + fh * 0.3, 4, fh * 0.7);
		g.fillRect(fx + fw * 0.75 - 2, fy + fh * 0.3, 4, fh * 0.7);
		ge.fillStyle = '#000';
		ge.fillRect(fx + fw / 2 - 5, fy, 10, fh);
		ge.fillRect(fx, fy + fh * 0.3 - 4, fw, 9);
		// Reveal shadow at the top and left (window set into the wall).
		const sh = g.createLinearGradient(fx, fy, fx, fy + 30);
		sh.addColorStop(0, 'rgba(0,0,0,0.45)');
		sh.addColorStop(1, 'rgba(0,0,0,0)');
		g.fillStyle = sh;
		g.fillRect(fx, fy, fw, 30);
	};
	sash(0, { light: true });
	sash(1, { curtain: true, light: true });
	sash(2, { dark: true });
	sash(3, { blind: true });

	// Round-headed windows: transparent outside the arch.
	const arched = (i, light) => {
		const [x, y] = cell(i);
		g.save();
		g.beginPath();
		const R = C / 2 - 1;
		g.moveTo(x + 1, y + C);
		g.lineTo(x + 1, y + C / 2);
		g.arc(x + C / 2, y + C / 2, R, Math.PI, 0);
		g.lineTo(x + C - 1, y + C);
		g.closePath();
		g.clip();
		g.fillStyle = '#ece6da';
		g.fillRect(x, y, C, C);
		g.beginPath();
		g.moveTo(x + 14, y + C - 8);
		g.lineTo(x + 14, y + C / 2);
		g.arc(x + C / 2, y + C / 2, R - 13, Math.PI, 0);
		g.lineTo(x + C - 14, y + C - 8);
		g.closePath();
		g.save();
		g.clip();
		glass(x, y, C, C);
		if (light) lit(x + 14, y, C - 28, C, [255, 210, 150]);
		g.restore();
		g.fillStyle = '#ece6da';
		g.fillRect(x + C / 2 - 4, y, 8, C);
		g.fillRect(x, y + C / 2 + 4, C, 8);
		g.fillRect(x, y + C * 0.78, C, 6);
		g.restore();
	};
	arched(4, false);
	arched(5, true);

	// Stained glass in lead cames, round-headed, glowing at night.
	{
		const [x, y] = cell(6);
		g.save();
		g.beginPath();
		const R = C / 2 - 1;
		g.moveTo(x + 1, y + C);
		g.lineTo(x + 1, y + C / 2);
		g.arc(x + C / 2, y + C / 2, R, Math.PI, 0);
		g.lineTo(x + C - 1, y + C);
		g.closePath();
		g.clip();
		const pal = [[64, 82, 130], [120, 48, 50], [170, 140, 60], [60, 100, 80], [110, 104, 140], [90, 72, 52]];
		for (let yy = y; yy < y + C; yy += 16) for (let xx = x; xx < x + C; xx += 16) {
			const p = pal[Math.floor(r() * pal.length)];
			g.fillStyle = `rgb(${p[0]},${p[1]},${p[2]})`;
			g.fillRect(xx, yy, 16, 16);
			ge.fillStyle = `rgb(${Math.min(255, p[0] * 1.6 + 60)},${Math.min(255, p[1] * 1.5 + 40)},${Math.min(255, p[2] * 1.2 + 20)})`;
			ge.fillRect(xx, yy, 16, 16);
		}
		g.strokeStyle = '#2a2622';
		g.lineWidth = 2;
		for (let yy = y; yy < y + C; yy += 16) { g.beginPath(); g.moveTo(x, yy); g.lineTo(x + C, yy); g.stroke(); }
		for (let xx = x; xx < x + C; xx += 16) { g.beginPath(); g.moveTo(xx, y); g.lineTo(xx, y + C); g.stroke(); }
		g.fillStyle = '#3a3530';
		g.fillRect(x + C / 2 - 3, y, 6, C);
		g.fillRect(x, y + C * 0.55, C, 5);
		g.restore();
	}
	// Rose / round window.
	{
		const [x, y] = cell(7);
		const cx = x + C / 2, cy = y + C / 2, R = C / 2 - 8;
		g.save();
		g.beginPath();
		g.arc(cx, cy, R, 0, Math.PI * 2);
		g.clip();
		glass(x, y, C, C, [50, 46, 60]);
		ge.save();
		ge.beginPath();
		ge.arc(cx, cy, R, 0, Math.PI * 2);
		ge.clip();
		lit(x, y, C, C, [255, 190, 120], 0.9);
		ge.restore();
		g.strokeStyle = '#e8e2d6';
		g.lineWidth = 9;
		for (let k = 0; k < 8; k++) {
			const a = (k / 8) * Math.PI * 2;
			g.beginPath();
			g.moveTo(cx, cy);
			g.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
			g.stroke();
		}
		g.beginPath();
		g.arc(cx, cy, R * 0.35, 0, Math.PI * 2);
		g.stroke();
		g.lineWidth = 14;
		g.beginPath();
		g.arc(cx, cy, R - 5, 0, Math.PI * 2);
		g.stroke();
		g.restore();
	}
	// Glazed lobby wall: big panes in slim bronze frames, bright at night.
	{
		const [x, y] = cell(8);
		glass(x, y, C, C, [30, 36, 40]);
		lit(x, y, C, C, [255, 222, 170], 1);
		g.fillStyle = 'rgba(255,240,210,0.08)';
		g.fillRect(x, y + C * 0.55, C, C * 0.45);
		g.fillStyle = '#4b4136';
		for (let k = 0; k <= 4; k++) g.fillRect(x + (k * C) / 4 - 3, y, 6, C);
		g.fillRect(x, y, C, 6);
		g.fillRect(x, y + C * 0.62, C, 6);
		g.fillRect(x, y + C - 6, C, 6);
		ge.fillStyle = '#000';
		for (let k = 0; k <= 4; k++) ge.fillRect(x + (k * C) / 4 - 3, y, 6, C);
	}
	// Panelled double door (dark oak) with a glazed fanlight.
	{
		const [x, y] = cell(9);
		g.fillStyle = '#4a3324';
		g.fillRect(x, y, C, C);
		glass(x + 14, y + 8, C - 28, 50, [40, 40, 40]);
		lit(x + 14, y + 8, C - 28, 50, [255, 200, 130], 0.7);
		g.fillStyle = '#5b3f2c';
		for (const px of [x + 16, x + C / 2 + 6]) {
			g.fillRect(px, y + 70, C / 2 - 22, 70);
			g.fillRect(px, y + 150, C / 2 - 22, 92);
		}
		g.fillStyle = 'rgba(0,0,0,0.35)';
		g.fillRect(x + C / 2 - 2, y + 60, 4, C - 60);
		g.fillStyle = '#c8a64e';
		g.fillRect(x + C / 2 - 14, y + 150, 6, 18);
		g.fillRect(x + C / 2 + 8, y + 150, 6, 18);
	}
	// Wrought-iron gate: bars, rails, spear tips and scrolls (alpha-cut).
	{
		const [x, y] = cell(10);
		g.fillStyle = '#1d1f1e';
		g.strokeStyle = '#1d1f1e';
		for (let k = 6; k < C; k += 16) {
			g.fillRect(x + k, y + 22, 5, C - 22);
			g.beginPath();
			g.moveTo(x + k - 3, y + 24);
			g.lineTo(x + k + 2.5, y + 8);
			g.lineTo(x + k + 8, y + 24);
			g.fill();
		}
		g.fillRect(x, y + 40, C, 7);
		g.fillRect(x, y + C - 40, C, 7);
		g.fillRect(x, y + C * 0.55, C, 5);
		g.lineWidth = 4;
		for (let k = 0; k < 8; k++) {
			g.beginPath();
			g.arc(x + 16 + k * 32, y + C * 0.55 - 16, 12, 0, Math.PI * 2);
			g.stroke();
		}
	}
	// Clock dial: white enamel with black numerals and hands, gilt rim; lit at night.
	{
		const [x, y] = cell(11);
		const cx = x + C / 2, cy = y + C / 2, R = C / 2 - 4;
		g.beginPath();
		g.arc(cx, cy, R, 0, Math.PI * 2);
		g.fillStyle = '#c9a24a';
		g.fill();
		g.beginPath();
		g.arc(cx, cy, R - 12, 0, Math.PI * 2);
		g.fillStyle = '#f4f1e8';
		g.fill();
		ge.beginPath();
		ge.arc(cx, cy, R - 12, 0, Math.PI * 2);
		ge.fillStyle = 'rgb(255,240,210)';
		ge.fill();
		g.fillStyle = '#1b1b1b';
		g.font = 'bold 30px Georgia, serif';
		g.textAlign = 'center';
		g.textBaseline = 'middle';
		const roman = ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
		for (let k = 0; k < 12; k++) {
			const a = (k / 12) * Math.PI * 2 - Math.PI / 2;
			g.save();
			g.translate(cx + Math.cos(a) * (R - 40), cy + Math.sin(a) * (R - 40));
			g.rotate(a + Math.PI / 2);
			g.fillText(roman[k], 0, 0);
			g.restore();
		}
		g.lineCap = 'round';
		g.strokeStyle = '#1b1b1b';
		g.lineWidth = 9;
		g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + 40, cy - 38); g.stroke();
		g.lineWidth = 6;
		g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx - 12, cy - 86); g.stroke();
		ge.strokeStyle = '#000';
		ge.lineWidth = 9;
		ge.beginPath(); ge.moveTo(cx, cy); ge.lineTo(cx + 40, cy - 38); ge.stroke();
		ge.lineWidth = 6;
		ge.beginPath(); ge.moveTo(cx, cy); ge.lineTo(cx - 12, cy - 86); ge.stroke();
	}
	// Belfry louvres.
	{
		const [x, y] = cell(12);
		g.save();
		g.beginPath();
		const R = C / 2 - 1;
		g.moveTo(x + 1, y + C);
		g.lineTo(x + 1, y + C / 2);
		g.arc(x + C / 2, y + C / 2, R, Math.PI, 0);
		g.lineTo(x + C - 1, y + C);
		g.closePath();
		g.clip();
		g.fillStyle = '#141414';
		g.fillRect(x, y, C, C);
		for (let k = y + 40; k < y + C; k += 18) {
			const gr = g.createLinearGradient(0, k, 0, k + 14);
			gr.addColorStop(0, '#6b5a48');
			gr.addColorStop(1, '#3b3128');
			g.fillStyle = gr;
			g.fillRect(x, k, C, 12);
		}
		g.restore();
	}
	// Shop window: glass with a lit interior and a dark fascia.
	{
		const [x, y] = cell(13);
		g.fillStyle = '#2a2a2a';
		g.fillRect(x, y, C, C);
		glass(x + 10, y + 50, C - 20, C - 60, [46, 50, 52]);
		lit(x + 10, y + 50, C - 20, C - 60, [255, 236, 200], 0.9);
		g.fillStyle = '#3a3a3a';
		g.fillRect(x + C / 2 - 3, y + 50, 6, C - 60);
	}
	// Arched double door (dark wood) with fanlight, alpha outside the arch.
	{
		const [x, y] = cell(14);
		g.save();
		g.beginPath();
		const R = C / 2 - 1;
		g.moveTo(x + 1, y + C);
		g.lineTo(x + 1, y + C / 2);
		g.arc(x + C / 2, y + C / 2, R, Math.PI, 0);
		g.lineTo(x + C - 1, y + C);
		g.closePath();
		g.clip();
		g.fillStyle = '#3f2b1e';
		g.fillRect(x, y, C, C);
		glass(x, y, C, C / 2, [40, 40, 44]);
		lit(x, y, C, C / 2, [255, 200, 130], 0.8);
		g.fillStyle = '#2e2017';
		for (let k = 0; k < 7; k++) {
			g.save();
			g.translate(x + C / 2, y + C / 2);
			g.rotate(Math.PI + (k / 6) * Math.PI);
			g.fillRect(0, -2, R, 4);
			g.restore();
		}
		g.fillRect(x, y + C / 2 - 3, C, 8);
		g.fillStyle = '#4e3626';
		for (const px of [x + 18, x + C / 2 + 8]) {
			g.fillRect(px, y + C / 2 + 14, C / 2 - 26, 40);
			g.fillRect(px, y + C / 2 + 62, C / 2 - 26, C / 2 - 74);
		}
		g.fillStyle = 'rgba(0,0,0,0.4)';
		g.fillRect(x + C / 2 - 2, y + C / 2, 4, C / 2);
		g.restore();
	}
	// Plain dark glass (modern windows, vitrines).
	{
		const [x, y] = cell(15);
		glass(x, y, C, C, [26, 32, 38]);
		g.fillStyle = '#2b2b2b';
		g.fillRect(x, y, C, 5);
		g.fillRect(x, y + C - 5, C, 5);
		g.fillRect(x, y, 5, C);
		g.fillRect(x + C - 5, y, 5, C);
	}
	const map = tex(c, { wrap: false });
	const emissive = tex(e, { wrap: false });
	map.generateMipmaps = true;
	return { map, emissive };
});

/**
 * A text sign on a transparent background (letters fixed to a facade, or a lit sign).
 * Returns { map, emissive } of a canvas `w`×`h` px.
 */
export function signTex(lines, { w = 1024, h = 128, colour = '#e8d9a8', glow = '#ffe8b0', bg = null, font = '600 86px "Times New Roman", Georgia, serif', stroke = null, letterSpacing = 0 } = {}) {
	const [c, g] = canvas(w, h);
	const [e, ge] = canvas(w, h);
	if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
	ge.fillStyle = '#000';
	ge.fillRect(0, 0, w, h);
	const list = Array.isArray(lines) ? lines : [lines];
	list.forEach((text, i) => {
		const y = (h / list.length) * (i + 0.5);
		for (const [ctx2, col] of [[g, colour], [ge, glow]]) {
			ctx2.font = font;
			ctx2.textAlign = 'center';
			ctx2.textBaseline = 'middle';
			if ('letterSpacing' in ctx2) ctx2.letterSpacing = letterSpacing + 'px';
			let size = parseInt(/(\d+)px/.exec(font)[1], 10);
			while (ctx2.measureText(text).width > w * 0.96 && size > 10) {
				size -= 2;
				ctx2.font = font.replace(/\d+px/, size + 'px');
			}
			if (stroke && ctx2 === g) { ctx2.strokeStyle = stroke; ctx2.lineWidth = 6; ctx2.strokeText(text, w / 2, y); }
			ctx2.fillStyle = col;
			ctx2.fillText(text, w / 2, y);
		}
	});
	return { map: tex(c, { wrap: false }), emissive: tex(e, { wrap: false }), canvas: c };
}

/** Headstone faces: polished granite with gilt / engraved lettering (4 variants side by side). */
export const graveTex = () => once('grave', () => {
	const W = 512, H = 128;
	const [c, g] = canvas(W, H);
	const r = rng(91);
	const n = fbm(92, W, 16, 3);
	const img = g.createImageData(W, H);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		const v = 200 + (n(x, y * 4) - 0.5) * 70 + (r() - 0.5) * 18;
		const i = (y * W + x) * 4;
		img.data[i] = img.data[i + 1] = img.data[i + 2] = clamp255(v);
		img.data[i + 3] = 255;
	}
	g.putImageData(img, 0, 0);
	// Cells 1..3: inscription panels (names, dates) in gilt or white.
	const names = ['NAGY', 'KOVÁCS', 'SZABÓ', 'TÓTH', 'HORVÁTH', 'VARGA', 'KISS', 'MOLNÁR', 'NÉMETH', 'FARKAS', 'BALOGH', 'PAPP'];
	for (let k = 1; k < 4; k++) {
		const x0 = k * 128;
		g.fillStyle = k === 3 ? 'rgba(238,236,230,0.9)' : 'rgba(214,176,92,0.95)';
		g.textAlign = 'center';
		g.font = 'bold 15px Georgia, serif';
		g.fillText(names[Math.floor(r() * names.length)], x0 + 64, 38);
		g.font = '11px Georgia, serif';
		const y1 = 1850 + Math.floor(r() * 120);
		g.fillText(`${y1}–${y1 + 30 + Math.floor(r() * 50)}`, x0 + 64, 56);
		g.fillText(names[Math.floor(r() * names.length)], x0 + 64, 76);
		g.fillText(`${y1 + 2}–${y1 + 40 + Math.floor(r() * 40)}`, x0 + 64, 92);
		g.fillRect(x0 + 52, 104, 24, 2);
		g.fillRect(x0 + 63, 98, 2, 14);
	}
	const t = tex(c, { wrap: false });
	return { map: t };
});
