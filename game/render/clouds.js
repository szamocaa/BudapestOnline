// Procedural clouds: one tileable noise texture generated once (CPU), and the cloud density
// function in GLSL (sky dome, stars) and in JavaScript (how much a cloud dims the sun right now).
//
// Noise texture channels (256 x 256, tileable, mipmapped):
//   r: low-frequency fbm (large cloud shapes)      g: high-frequency fbm (detail, moon maria)
//   b: billowy Worley noise (cumulus puffs)        a: streaky fbm stretched 8:1 (cirrus)
import { rng } from '../geo.js';

export const NOISE_SIZE = 256;
export const CLOUD_LOW_H = 1600; // m above the street: cumulus / stratocumulus base
export const CLOUD_HIGH_H = 8500; // cirrus
export const LOW_TILE = 14000; // metres covered by one tile of the noise at the low layer
export const HIGH_TILE = 42000;

function makeGrad(r, n) {
	const g = new Float32Array(n * 2);
	for (let i = 0; i < n; i++) {
		const a = r() * Math.PI * 2;
		g[i * 2] = Math.cos(a);
		g[i * 2 + 1] = Math.sin(a);
	}
	return g;
}

/** Tileable gradient noise with integer periods px, py (lattice cells across the tile). */
function perlin(x, y, px, py, grad, perm) {
	const x0 = Math.floor(x), y0 = Math.floor(y);
	const fx = x - x0, fy = y - y0;
	const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
	const ix0 = ((x0 % px) + px) % px, iy0 = ((y0 % py) + py) % py;
	const ix1 = (ix0 + 1) % px, iy1 = (iy0 + 1) % py;
	const h = (ix, iy) => perm[(perm[ix & 255] + iy) & 255];
	const dot = (k, dx, dy) => grad[k * 2] * dx + grad[k * 2 + 1] * dy;
	const n00 = dot(h(ix0, iy0), fx, fy), n10 = dot(h(ix1, iy0), fx - 1, fy);
	const n01 = dot(h(ix0, iy1), fx, fy - 1), n11 = dot(h(ix1, iy1), fx - 1, fy - 1);
	const a = n00 + (n10 - n00) * u, b = n01 + (n11 - n01) * u;
	return a + (b - a) * v;
}

/** Tileable Worley F1 distance (0 at a feature point, ~1 far from any). */
function worley(x, y, period, pts) {
	const cx = Math.floor(x), cy = Math.floor(y);
	let best = 9;
	for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
		const gx = cx + ox, gy = cy + oy;
		const wx = ((gx % period) + period) % period, wy = ((gy % period) + period) % period;
		const k = (wy * period + wx) * 2;
		const dx = gx + pts[k] - x, dy = gy + pts[k + 1] - y;
		const d = dx * dx + dy * dy;
		if (d < best) best = d;
	}
	return Math.sqrt(best);
}

/** Generates the RGBA8 noise (Uint8Array, NOISE_SIZE^2 * 4). Deterministic. */
export function makeCloudNoise(size = NOISE_SIZE, seed = 1234) {
	const r = rng(seed);
	const perm = new Uint8Array(256);
	for (let i = 0; i < 256; i++) perm[i] = i;
	for (let i = 255; i > 0; i--) {
		const j = Math.floor(r() * (i + 1));
		[perm[i], perm[j]] = [perm[j], perm[i]];
	}
	const grad = makeGrad(r, 256);
	const worleyPts = [4, 8, 16].map((p) => {
		const a = new Float32Array(p * p * 2);
		for (let i = 0; i < a.length; i++) a[i] = r();
		return a;
	});
	const ch = [new Float32Array(size * size), new Float32Array(size * size), new Float32Array(size * size), new Float32Array(size * size)];
	for (let y = 0; y < size; y++) {
		const v = y / size;
		for (let x = 0; x < size; x++) {
			const u = x / size;
			const i = y * size + x;
			// r: 5 octaves, base period 4
			let f = 0, amp = 0.5, p = 4;
			for (let o = 0; o < 5; o++, amp *= 0.5, p *= 2) f += amp * perlin(u * p, v * p, p, p, grad, perm);
			ch[0][i] = f;
			// g: 4 octaves, base period 16
			f = 0; amp = 0.5; p = 16;
			for (let o = 0; o < 4; o++, amp *= 0.5, p *= 2) f += amp * perlin(u * p + 17.3, v * p + 5.1, p, p, grad, perm);
			ch[1][i] = f;
			// b: billows (inverted Worley, 3 octaves)
			let w = 0;
			[4, 8, 16].forEach((q, k) => { w += [0.6, 0.27, 0.13][k] * (1 - Math.min(1, worley(u * q, v * q, q, worleyPts[k]))); });
			ch[2][i] = w;
			// a: cirrus streaks, stretched along x
			f = 0; amp = 0.55; let px = 2, py = 16;
			for (let o = 0; o < 4; o++, amp *= 0.5, px *= 2, py *= 2) f += amp * perlin(u * px + 3.7, v * py + 9.2, px, py, grad, perm);
			ch[3][i] = f;
		}
	}
	const out = new Uint8Array(size * size * 4);
	for (let c = 0; c < 4; c++) {
		let lo = Infinity, hi = -Infinity;
		for (const x of ch[c]) { if (x < lo) lo = x; if (x > hi) hi = x; }
		const k = 255 / (hi - lo || 1);
		for (let i = 0; i < size * size; i++) out[i * 4 + c] = Math.round((ch[c][i] - lo) * k);
	}
	return out;
}

// ---------------------------------------------------------------- density (GLSL and JS twins)

// Uniforms: cloudShape = (threshold, stratus, cirrus amount, sharpness), cloudWind = (low xy, high xy)
// offsets in metres, cirrusRot = (cos, sin) of the cirrus streak direction.
export const CLOUD_GLSL = /* glsl */ `
uniform sampler2D tNoise;
uniform vec4 cloudShape;
uniform vec4 cloudWind;
uniform vec2 cirrusRot;
float lowCloud(vec2 p) {
	vec2 uv = (p + cloudWind.xy) / ${LOW_TILE.toFixed(1)};
	vec4 a = texture(tNoise, uv);
	vec4 b = texture(tNoise, uv * 4.13 + vec2(0.37, 0.71));
	float cumulus = a.r * 0.55 + a.b * 0.45;
	float strat = a.r * 0.8 + b.r * 0.2;
	float m = mix(cumulus, strat, cloudShape.y);
	m -= (1.0 - b.b) * 0.10 * (1.0 - 0.6 * cloudShape.y);
	return clamp((m - cloudShape.x) * cloudShape.w, 0.0, 1.0);
}
float highCloud(vec2 p) {
	vec2 q = (p + cloudWind.zw) / ${HIGH_TILE.toFixed(1)};
	q = vec2(q.x * cirrusRot.x + q.y * cirrusRot.y, -q.x * cirrusRot.y + q.y * cirrusRot.x);
	float c = texture(tNoise, q).a * 0.7 + texture(tNoise, q * 2.7 + vec2(0.5, 0.2)).a * 0.3;
	float mask = texture(tNoise, q * 0.37 + vec2(0.13, 0.61)).r;
	return clamp((c - 0.62 + cloudShape.z * 0.3) * 3.0, 0.0, 1.0) * smoothstep(0.35, 0.65, mask + cloudShape.z * 0.3) * cloudShape.z;
}
`;

/** CPU sampler over the generated noise (bilinear, wrapping, level 0). */
export function noiseSampler(data, size = NOISE_SIZE) {
	return (u, v) => {
		const x = (u - Math.floor(u)) * size - 0.5, y = (v - Math.floor(v)) * size - 0.5;
		const x0 = Math.floor(x), y0 = Math.floor(y);
		const fx = x - x0, fy = y - y0;
		const xi0 = ((x0 % size) + size) % size, yi0 = ((y0 % size) + size) % size;
		const xi1 = (xi0 + 1) % size, yi1 = (yi0 + 1) % size;
		const out = [0, 0, 0, 0];
		for (let c = 0; c < 4; c++) {
			const a = data[(yi0 * size + xi0) * 4 + c], b = data[(yi0 * size + xi1) * 4 + c];
			const d = data[(yi1 * size + xi0) * 4 + c], e = data[(yi1 * size + xi1) * 4 + c];
			out[c] = ((a + (b - a) * fx) * (1 - fy) + (d + (e - d) * fx) * fy) / 255;
		}
		return out;
	};
}

/** JS twin of lowCloud(): shape = { threshold, stratus, sharp }, wind = [x, z] offset in metres. */
export function lowCloudJS(sample, x, z, shape, wind) {
	const u = (x + wind[0]) / LOW_TILE, v = (z + wind[1]) / LOW_TILE;
	const a = sample(u, v), b = sample(u * 4.13 + 0.37, v * 4.13 + 0.71);
	const cumulus = a[0] * 0.55 + a[2] * 0.45;
	const strat = a[0] * 0.8 + b[0] * 0.2;
	let m = cumulus + (strat - cumulus) * shape.stratus;
	m -= (1 - b[2]) * 0.1 * (1 - 0.6 * shape.stratus);
	return Math.min(1, Math.max(0, (m - shape.threshold) * shape.sharp));
}

/**
 * The density threshold that leaves `coverage` (0..1) of the sky covered for a given stratus mix:
 * a quantile of the noise distribution, so coverage means what it says.
 */
export function coverageThreshold(sample, coverage, stratus) {
	const vals = [];
	const r = rng(99);
	for (let i = 0; i < 1500; i++) {
		const u = r(), v = r();
		const a = sample(u, v), b = sample(u * 4.13 + 0.37, v * 4.13 + 0.71);
		const cumulus = a[0] * 0.55 + a[2] * 0.45;
		const strat = a[0] * 0.8 + b[0] * 0.2;
		let m = cumulus + (strat - cumulus) * stratus;
		m -= (1 - b[2]) * 0.1 * (1 - 0.6 * stratus);
		vals.push(m);
	}
	vals.sort((p, q) => p - q);
	const k = Math.min(vals.length - 1, Math.max(0, Math.floor((1 - coverage) * vals.length)));
	return vals[k];
}
