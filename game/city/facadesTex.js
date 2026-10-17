// Materials of the Józsefváros buildings: one procedural texture array shared by every facade
// (plaster, rustication, stone, brick, wood, roof tiles, slate, tin, concrete, ornament, faded
// firewall ads, grime, graffiti) and four shaders built on MeshStandardMaterial:
//   * facade: tint x texture layer, bump from the layer's height, dirt streaks and street-level tags;
//   * glazing: window frames, external roller blinds, net curtains, a fake room behind the glass
//     (interior mapping), sky/street reflection with Fresnel, lit rooms at night by occupancy, and the
//     shop modes (shop, café, pharmacy, tobacconist, glowing vape shop, empty "kiadó" unit, offices);
//   * far shell: plain walls whose windows are drawn from the bay layout in the vertex data, hidden
//     per 100 m chunk while that chunk shows its detailed facades;
//   * railings: alpha-tested wrought iron (balconies, courtyard "gang" walkways).
import * as THREE from '../vendor/three.module.min.js';
import { rng } from '../geo.js';
import { GRID_W, GRID_H } from './facadesPlan.js';

const S = 256; // texels per layer side
const NL = 16;
export const GRIME = 14, GRAFFITI = 15;
// Metres per texture repeat, roughness, metalness and bump strength for each layer (see LAYER).
//            PLAST ROUGH RUSTC STONE BRICK WOOD  TILE  SLATE TIN   FLAT  CONCR METAL AD    ORN   GRIME GRAF
const TILE = [3.2, 3.2, 2.4, 1.6, 1.95, 1.6, 2.0, 2.0, 2.0, 4.0, 3.0, 1.0, 1.0, 1.2, 8.0, 6.0];
const ROUGH = [0.9, 0.95, 0.9, 0.78, 0.9, 0.62, 0.72, 0.55, 0.42, 0.95, 0.92, 0.45, 0.92, 0.88, 1, 1];
const METAL = [0, 0, 0, 0, 0, 0, 0, 0, 0.55, 0, 0, 0.5, 0, 0, 0, 0];
const BUMP = [0.6, 1.4, 3.0, 1.2, 2.6, 1.6, 3.2, 2.2, 1.6, 1.2, 0.8, 2.0, 0.2, 3.2, 0, 0];

// ---------------------------------------------------------------- procedural texels

function hash2(x, y, s) {
	let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function makeNoise(seed) {
	const L = new Float32Array(64 * 64), r = rng(seed);
	for (let i = 0; i < L.length; i++) L[i] = r();
	const vn = (x, y, per, off) => {
		const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
		const x0 = ((xi % per) + per) % per, y0 = ((yi % per) + per) % per, x1 = (x0 + 1) % per, y1 = (y0 + 1) % per;
		const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
		const g = (a, b) => L[(((b + off) & 63) << 6) | ((a + off * 3) & 63)];
		const a = g(x0, y0), b = g(x1, y0), c = g(x0, y1), d = g(x1, y1);
		return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
	};
	/** Periodic fbm over u, v in [0, 1): base lattice cells per tile (power of two), octaves. */
	return (u, v, base, oct = 4, sx = 1) => {
		let s = 0, amp = 0.5, tot = 0, f = base;
		for (let k = 0; k < oct && f <= 64; k++) {
			s += amp * vn(u * f * sx, v * f, f * sx, k * 7);
			tot += amp; amp *= 0.5; f *= 2;
		}
		return s / tot;
	};
}
const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };

/** Fills one layer: fn(u, v, px, py) -> [r, g, b, h] in 0..1 (albedo multiplier / 2, height). */
function fill(data, layer, fn) {
	const o = layer * S * S * 4;
	for (let py = 0; py < S; py++) for (let px = 0; px < S; px++) {
		const c = fn((px + 0.5) / S, (py + 0.5) / S, px, py);
		const i = o + (py * S + px) * 4;
		data[i] = sat(c[0]) * 255; data[i + 1] = sat(c[1]) * 255; data[i + 2] = sat(c[2]) * 255; data[i + 3] = sat(c[3]) * 255;
	}
}

function canvasLayer(data, layer, draw) {
	if (typeof document === 'undefined') return;
	const c = document.createElement('canvas');
	c.width = c.height = S;
	const g = c.getContext('2d', { willReadFrequently: true });
	draw(g);
	const img = g.getImageData(0, 0, S, S).data;
	const o = layer * S * S * 4;
	// Canvas rows run top-down; texture rows bottom-up.
	for (let y = 0; y < S; y++) data.set(img.subarray((S - 1 - y) * S * 4, (S - y) * S * 4), o + y * S * 4);
}

function buildLayers() {
	const data = new Uint8Array(S * S * 4 * NL);
	const n = makeNoise(11), m = makeNoise(23), q = makeNoise(37);
	const grey = (v, h) => [v, v, v, h];
	// Smooth (renovated) plaster: faint trowel marks.
	fill(data, 0, (u, v) => { const a = n(u, v, 4, 4), b = q(u, v, 32, 2); const k = 0.5 * (0.95 + 0.08 * (a - 0.5) + 0.06 * (b - 0.5)); return [k, k, k * 0.995, 0.5 + 0.25 * (b - 0.5)]; });
	// Old plaster: mottled, patched, hairline cracks, flaking spots.
	fill(data, 1, (u, v) => {
		const a = n(u, v, 2, 5), b = m(u, v, 16, 3), c = q(u, v, 4, 3);
		const patch = sstep(0.62, 0.66, c) * 0.06;
		const crack = 1 - sstep(0.0, 0.012, Math.abs(m(u, v, 8, 3) - 0.5)) * 1;
		const flake = sstep(0.72, 0.75, n(u + 0.3, v, 8, 2));
		let k = 0.5 * (0.92 + 0.14 * (a - 0.5) + 0.08 * (b - 0.5) + patch - crack * 0.07 - flake * 0.06);
		return [k * 1.0, k * 0.99, k * 0.97, 0.55 + 0.3 * (b - 0.5) - crack * 0.25 - flake * 0.2 + patch];
	});
	// Rusticated ground floor: horizontal channels every 0.4 m, rough render between.
	fill(data, 2, (u, v) => {
		const y = (v * 6) % 1, b = m(u, v, 16, 3);
		const groove = 1 - sstep(0.03, 0.09, Math.min(y, 1 - y));
		const k = 0.5 * (0.96 + 0.08 * (b - 0.5) - groove * 0.22);
		return [k, k, k, 0.75 - groove * 0.7 + 0.15 * (b - 0.5)];
	});
	// Stone (plinths, gate surrounds, sills): speckled limestone/granite with block joints.
	fill(data, 3, (u, v) => {
		const s = q(u, v, 32, 2), a = n(u, v, 4, 3);
		const jy = Math.min((v * 2) % 1, 1 - ((v * 2) % 1)), jx = Math.min((u * 2 + (Math.floor(v * 2) % 2) * 0.5) % 1, 1 - ((u * 2 + (Math.floor(v * 2) % 2) * 0.5) % 1));
		const j = 1 - sstep(0.004, 0.012, Math.min(jx, jy));
		const k = 0.5 * (0.94 + 0.16 * (s - 0.5) + 0.1 * (a - 0.5) - j * 0.25);
		return [k, k * 0.99, k * 0.96, 0.6 - j * 0.6 + 0.2 * (s - 0.5)];
	});
	// Brick: 26 courses of 7.5 bricks (25 x 6.5 cm + 1 cm joints), burnt and pale bricks, greyish mortar.
	fill(data, 4, (u, v) => {
		const row = Math.floor(v * 26), fy = v * 26 - row;
		const bx = u * 7.5 + (row % 2) * 0.5, col = Math.floor(bx), fx = bx - col;
		const mortar = fy < 0.13 || fx < 0.04 || (col % 7 === 6 && fx > 0.5 && fx < 0.54) ? 1 : 0;
		const hb = hash2(((col % 8) + 8) % 8, row, 4), s = q(u, v, 32, 2);
		if (mortar) { const g = 0.5 * (1.0 + 0.1 * (s - 0.5)); return [g * 0.95, g * 1.55, g * 1.9, 0.15]; }
		const k = 0.5 * (0.82 + 0.36 * hb + 0.12 * (s - 0.5)) * (hb < 0.1 ? 0.7 : 1);
		return [k, k * (0.92 + 0.12 * hash2(col, row, 9)), k * 0.9, 0.7 + 0.2 * (s - 0.5)];
	});
	// Wood: vertical grain with raised panels.
	fill(data, 5, (u, v) => {
		const g = n(u, v, 2, 3, 8), s = q(u, v, 16, 2);
		const px = (u * 4) % 1, py = (v * 4) % 1;
		const edge = Math.min(px, 1 - px, py, 1 - py);
		const bevel = sstep(0.04, 0.1, edge);
		const k = 0.5 * (0.88 + 0.22 * (g - 0.5) + 0.06 * (s - 0.5)) * (0.8 + 0.2 * bevel);
		return [k, k, k, 0.3 + 0.5 * bevel + 0.1 * (g - 0.5)];
	});
	// Beaver-tail roof tiles (hódfarkú cserép): staggered rows with rounded lower ends.
	fill(data, 6, (u, v) => {
		const row = Math.floor(v * 12), fy = v * 12 - row;
		const tx = u * 11 + (row % 2) * 0.5, col = Math.floor(tx), fx = tx - col - 0.5;
		const round = fy - (0.28 - 0.28 * Math.sqrt(Math.max(0, 1 - (fx * 2.1) ** 2)));
		const shade = round < 0 ? 0.55 : 1;
		const gap = Math.abs(fx) > 0.47 ? 0.6 : 1;
		const hv = hash2(((col % 11) + 11) % 11, row, 6), s = m(u, v, 32, 2), moss = sstep(0.6, 0.75, n(u, v, 4, 3));
		const k = 0.5 * (0.8 + 0.4 * hv + 0.1 * (s - 0.5)) * shade * gap;
		return [k * (1 - moss * 0.25), k * (1 + moss * 0.1), k * (1 - moss * 0.2), sat(0.2 + fy * 0.7) * (round < 0 ? 0.3 : 1)];
	});
	// Slate: staggered rectangular slates, slight sheen variation.
	fill(data, 7, (u, v) => {
		const row = Math.floor(v * 10), fy = v * 10 - row;
		const tx = u * 8 + (row % 2) * 0.5, col = Math.floor(tx), fx = tx - col;
		const edge = fy < 0.06 || fx < 0.03 ? 0.6 : 1;
		const hv = hash2(((col % 8) + 8) % 8, row, 7), s = q(u, v, 32, 2);
		const k = 0.5 * (0.85 + 0.3 * hv + 0.08 * (s - 0.5)) * edge;
		return [k, k, k * 1.03, 0.3 + fy * 0.6];
	});
	// Tin (bádog): standing seams every 0.5 m, rust and streaks.
	fill(data, 8, (u, v) => {
		const f = (u * 4) % 1, seam = 1 - sstep(0.0, 0.03, Math.min(f, 1 - f));
		const st = n(u, v, 4, 3, 6), rust = sstep(0.68, 0.8, m(u, v, 8, 3));
		const k = 0.5 * (0.95 + 0.12 * (st - 0.5) + seam * 0.15);
		return [k * (1 + rust * 0.25), k * (1 - rust * 0.1), k * (1 - rust * 0.3), 0.3 + seam * 0.7];
	});
	// Flat roofs: bitumen with gravel.
	fill(data, 9, (u, v) => { const g = q(u, v, 64, 1), a = n(u, v, 4, 3); const k = 0.5 * (0.85 + 0.25 * (g - 0.5) + 0.12 * (a - 0.5)); return [k, k, k, 0.4 + 0.5 * (g - 0.5)]; });
	// Concrete (socialist blocks): board marks and panel joints.
	fill(data, 10, (u, v) => {
		const s = q(u, v, 32, 2), a = n(u, v, 4, 3);
		const j = 1 - sstep(0.004, 0.01, Math.min(u, 1 - u, v, 1 - v));
		const k = 0.5 * (0.95 + 0.1 * (s - 0.5) + 0.08 * (a - 0.5) - j * 0.3);
		return [k, k, k * 1.01, 0.5 - j * 0.5 + 0.2 * (s - 0.5)];
	});
	// Metal: ribbed shutter boxes and roller shutters.
	fill(data, 11, (u, v) => { const f = (v * 12) % 1, rib = Math.sin(f * Math.PI); const s = q(u, v, 16, 2); const k = 0.5 * (0.85 + 0.15 * rib + 0.06 * (s - 0.5)); return [k, k, k, rib]; });
	// Ornament (frieze, cornice, tympana): rosettes between garland swags, dentils at the bottom.
	fill(data, 13, (u, v) => {
		const cu = (u * 2) % 1 - 0.5, cv = v - 0.5;
		const rr = Math.hypot(cu, cv * 2);
		const ang = Math.atan2(cv, cu);
		const rose = rr < 0.22 ? 0.6 + 0.4 * Math.cos(ang * 8) * sstep(0.22, 0.05, rr) : 0;
		const sw = Math.abs(cv - (0.18 - 0.5 * (cu * cu))) < 0.05 && Math.abs(cu) > 0.24 ? 0.7 : 0;
		const dent = v < 0.14 && (u * 12) % 1 < 0.6 ? 0.8 : 0;
		const h = Math.max(rose, sw, dent);
		const k = 0.5 * (0.92 + 0.1 * h - (h > 0 ? 0 : 0.04));
		return [k, k, k, 0.25 + 0.7 * h];
	});
	// Grime: r = vertical rain streaks, g = large blotches, b = fine noise.
	fill(data, GRIME, (u, v) => [n(u, v, 8, 3, 6) * 0.6 + m(u, v, 32, 2, 4) * 0.4, m(u, v, 2, 4), q(u, v, 32, 2), 0.5]);
	// Firewall ads (2 x 2 cells), faded, and street-level graffiti tags (rgb + coverage).
	canvasLayer(data, 12, (g) => {
		g.fillStyle = 'rgb(128,128,128)'; g.fillRect(0, 0, S, S);
		const ads = [['TUNGSRAM', '#c8102e', '#f2e6c8', 'IZZÓ'], ['OMNIA', '#6b3e1e', '#e8c97a', 'KÁVÉ'], ['UTASELLÁTÓ', '#1d4e89', '#f0ead8', 'ÉTTEREM'], ['FABULON', '#2b6e4f', '#efe3c2', 'KRÉM']];
		ads.forEach(([t, bg, fg, sub], k) => {
			const x = (k % 2) * 128, y = (1 - Math.floor(k / 2)) * 128;
			g.fillStyle = bg; g.fillRect(x + 6, y + 10, 116, 108);
			g.fillStyle = fg; g.font = `bold ${t.length > 8 ? 15 : 24}px Arial, sans-serif`; g.textAlign = 'center';
			g.fillText(t, x + 64, y + 58);
			g.font = 'bold 13px Arial, sans-serif'; g.fillText(sub, x + 64, y + 84);
			g.fillRect(x + 20, y + 94, 88, 3);
		});
		// Weathering: wash the colours out.
		const r = rng(5);
		for (let i = 0; i < 1400; i++) { g.fillStyle = `rgba(150,145,135,${0.08 + r() * 0.2})`; g.fillRect(r() * S, r() * S, 2 + r() * 14, 1 + r() * 5); }
	});
	canvasLayer(data, GRAFFITI, (g) => {
		g.clearRect(0, 0, S, S);
		const r = rng(77);
		const cols = ['#111111', '#1c1c2a', '#c0303a', '#e0e0e0', '#2b5fb0', '#8a2be2', '#d9a400'];
		for (let k = 0; k < 9; k++) {
			g.strokeStyle = cols[Math.floor(r() * cols.length)];
			g.lineWidth = 1.5 + r() * 3; g.lineCap = 'round'; g.lineJoin = 'round';
			let x = r() * S, y = S * (0.3 + r() * 0.62);
			g.beginPath(); g.moveTo(x, y);
			const n2 = 5 + Math.floor(r() * 7), sc = 8 + r() * 14;
			for (let i = 0; i < n2; i++) { const nx = x + (r() * 1.6 - 0.3) * sc, ny = y + (r() - 0.5) * sc * 1.6; g.quadraticCurveTo(x + (r() - 0.5) * sc * 2, y - r() * sc * 1.5, nx, ny); x = nx; y = ny; }
			g.stroke();
		}
	});
	return data;
}

let shared = null;
/** The texture array, generated once (DataArrayTexture, 256² x 16 layers, mipmapped). */
export function facadeLayers() {
	if (shared) return shared;
	const tex = new THREE.DataArrayTexture(buildLayers(), S, S, NL);
	tex.format = THREE.RGBAFormat;
	tex.type = THREE.UnsignedByteType;
	tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	tex.magFilter = THREE.LinearFilter;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	tex.generateMipmaps = true;
	tex.anisotropy = 8;
	tex.colorSpace = THREE.NoColorSpace;
	tex.needsUpdate = true;
	shared = tex;
	return tex;
}

// ---------------------------------------------------------------- shared uniforms

/** Uniforms every building shader reads; buildings.js updates them each frame. */
export function buildingUniforms() {
	return {
		uLayers: { value: facadeLayers() },
		uTile: { value: TILE }, uRough: { value: ROUGH }, uMetal: { value: METAL }, uBump: { value: BUMP },
		uNight: { value: 0 }, uOcc: { value: 0.3 }, uHours: { value: 12 }, uTime: { value: 0 },
		uSkyTop: { value: new THREE.Color(0.32, 0.46, 0.72) }, uSkyHor: { value: new THREE.Color(0.75, 0.8, 0.86) },
		uStreet: { value: new THREE.Color(0.12, 0.12, 0.12) }, uDayLight: { value: 1 },
		uDetail: { value: null },
	};
}

const LAYER_PARS = /* glsl */ `
uniform highp sampler2DArray uLayers;
uniform float uTile[16]; uniform float uRough[16]; uniform float uMetal[16]; uniform float uBump[16];
uniform float uNight; uniform float uOcc; uniform float uHours; uniform float uTime; uniform float uDayLight;
uniform vec3 uSkyTop; uniform vec3 uSkyHor; uniform vec3 uStreet;
float bHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec3 bumpPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection) {
	vec3 vSigmaX = normalize(dFdx(surf_pos.xyz));
	vec3 vSigmaY = normalize(dFdy(surf_pos.xyz));
	vec3 R1 = cross(vSigmaY, surf_norm);
	vec3 R2 = cross(surf_norm, vSigmaX);
	float fDet = dot(vSigmaX, R1) * faceDirection;
	vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
	return normalize(abs(fDet) * surf_norm - vGrad);
}
`;

function patch(mat, uniforms, edit) {
	// three.js caches programs by onBeforeCompile's source text, which is the same closure for every
	// material here: give each its own key or they would all share the first one's shader.
	mat.customProgramCacheKey = () => 'bld-' + mat.name;
	mat.onBeforeCompile = (sh) => {
		Object.assign(sh.uniforms, uniforms);
		edit(sh);
	};
	return mat;
}

// ---------------------------------------------------------------- detailed facades

export function facadeMaterial(U) {
	const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0 });
	mat.name = 'facade';
	return patch(mat, U, (sh) => {
		sh.vertexShader = sh.vertexShader
			.replace('#include <common>', `#include <common>
attribute vec4 tint; attribute float layer;
varying vec4 vTint; varying vec2 vUvM; varying float vLayer; varying vec3 vWPos; varying vec3 vWN;`)
			.replace('#include <uv_vertex>', `#include <uv_vertex>
vTint = tint; vUvM = uv; vLayer = layer; vWN = normal;`)
			.replace('#include <project_vertex>', `#include <project_vertex>
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
		sh.fragmentShader = sh.fragmentShader
			.replace('#include <common>', `#include <common>
${LAYER_PARS}
varying vec4 vTint; varying vec2 vUvM; varying float vLayer; varying vec3 vWPos; varying vec3 vWN;`)
			.replace('#include <map_fragment>', `
int Ly = int(vLayer + 0.5);
vec2 tuv = vUvM / uTile[Ly];
vec4 tx = texture(uLayers, vec3(tuv, float(Ly)));
vec3 alb = vTint.rgb * tx.rgb * 2.0;
vec4 gr = texture(uLayers, vec3(vUvM.x / 8.0 + vWPos.x * 0.013, vWPos.y / 8.0, ${GRIME}.0));
float dirt = vTint.a * 2.0;
float dk = clamp(dirt * (0.45 + 1.1 * gr.r) + (gr.g - 0.5) * 0.3 * dirt, 0.0, 1.0);
alb *= mix(vec3(1.0), vec3(0.5, 0.48, 0.45), dk * 0.85);
// Street-level tags on plaster, stone, concrete and shutters.
if (abs(vWN.y) < 0.2 && vWPos.y < 2.7 && (Ly <= 3 || Ly == 10 || Ly == 11)) {
	float zone = bHash(floor(vec2(vWPos.x + vWPos.z, vWPos.z - vWPos.x) / 9.0));
	if (zone > 0.55) {
		vec4 gf = texture(uLayers, vec3(vUvM.x / 6.0 + zone * 7.0, vWPos.y / 3.0, ${GRAFFITI}.0));
		alb = mix(alb, gf.rgb * 0.8, gf.a * smoothstep(2.7, 2.2, vWPos.y) * 0.9);
	}
}
diffuseColor.rgb = alb;`)
			.replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(uRough[Ly] + (tx.a - 0.5) * 0.15, 0.05, 1.0);')
			.replace('#include <metalnessmap_fragment>', 'float metalnessFactor = uMetal[Ly];')
			.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
	vec2 dx = dFdx(tuv), dy = dFdy(tuv);
	float hx = texture(uLayers, vec3(tuv + dx, float(Ly))).a, hy = texture(uLayers, vec3(tuv + dy, float(Ly))).a;
	normal = bumpPerturb(-vViewPosition, normal, vec2(hx - tx.a, hy - tx.a) * uBump[Ly], faceDirection);
}`);
	});
}

// ---------------------------------------------------------------- glazing

export function glassMaterial(U) {
	const mat = new THREE.MeshStandardMaterial({ roughness: 0.1, metalness: 0 });
	mat.name = 'glazing';
	return patch(mat, U, (sh) => {
		sh.vertexShader = sh.vertexShader
			.replace('#include <common>', `#include <common>
attribute vec2 wtan; attribute vec4 win; attribute vec4 win2;
varying vec2 vPane; flat varying vec4 vWin; flat varying vec4 vWin2; varying vec3 vWPos; varying vec3 vT; varying vec3 vNw;`)
			.replace('#include <uv_vertex>', `#include <uv_vertex>
vPane = uv; vWin = win; vWin2 = win2; vT = vec3(wtan.x, 0.0, wtan.y); vNw = normal;`)
			.replace('#include <project_vertex>', `#include <project_vertex>
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
		sh.fragmentShader = sh.fragmentShader
			.replace('#include <common>', `#include <common>
${LAYER_PARS}
varying vec2 vPane; flat varying vec4 vWin; flat varying vec4 vWin2; varying vec3 vWPos; varying vec3 vT; varying vec3 vNw;
vec3 framePal(float i) {
	return i < 0.5 ? vec3(0.78, 0.78, 0.76) : i < 1.5 ? vec3(0.16, 0.09, 0.05) : i < 2.5 ? vec3(0.62, 0.56, 0.44) : i < 3.5 ? vec3(0.22, 0.23, 0.24) : i < 4.5 ? vec3(0.07, 0.15, 0.09) : vec3(0.025);
}
// Shop interior: parallax layers (shelves on the back wall, floor, a band of ceiling lights).
// TODO(buildings): the ray-box room below speckles for deep shop rooms in SwiftShader; revisit on GPUs.
vec4 shopAt(vec2 pp, vec3 Vt, float seed) {
	vec2 q = pp + Vt.xy / max(Vt.z, 0.25) * vec2(0.22, 0.28);
	float shelf = smoothstep(0.0, 0.08, abs(fract(q.y * 3.2) - 0.5) - 0.32);
	vec3 goods = vec3(0.45 + 0.4 * bHash(floor(q * vec2(7.0, 3.2)) + seed), 0.4 + 0.35 * bHash(floor(q * vec2(5.0, 3.2)) + seed + 3.0), 0.35 + 0.4 * bHash(floor(q * vec2(6.0, 3.2)) + seed + 7.0));
	vec3 c = mix(goods, vec3(0.75, 0.73, 0.7), shelf);
	c = mix(vec3(0.42, 0.4, 0.37), c, smoothstep(0.0, 0.18, q.y));
	c = mix(c, vec3(0.9, 0.9, 0.88), smoothstep(0.9, 1.0, q.y));
	return vec4(c, 0.35 + 0.65 * smoothstep(0.2, 1.0, pp.y));
}
// Fake room behind the pane (interior mapping): o = pane point, d = view ray in room space.
vec4 roomAt(vec2 pp, vec3 Vt, float seed, float shop) {
	vec3 o = vec3(mix(-0.36, 0.36, pp.x), mix(-0.38, 0.6, pp.y), 0.0);
	vec3 d = Vt * vec3(1.0 / 1.9, 1.0 / 1.45, 1.0 / (shop > 0.5 ? 6.0 : 4.2));
	d.z = max(d.z, 1e-3);
	d.x = abs(d.x) < 1e-4 ? 1e-4 : d.x;
	d.y = abs(d.y) < 1e-4 ? 1e-4 : d.y;
	float tx = (sign(d.x) - o.x) / d.x, ty = (sign(d.y) - o.y) / d.y, tz = 1.0 / d.z;
	// Which face the ray hits, by ordered comparisons (float equality is unreliable on some GPUs).
	bool back = tz <= tx && tz <= ty, flr = !back && ty <= tx;
	float t = back ? tz : flr ? ty : tx;
	vec3 h = o + d * t;
	float s2 = fract(seed * 7.13);
	vec3 wall = mix(vec3(0.62, 0.58, 0.5), vec3(0.55, 0.62, 0.55), step(0.6, s2));
	wall = mix(wall, vec3(0.7, 0.66, 0.6), step(0.85, s2));
	vec3 c;
	if (back) {
		c = wall * 0.9;
		// Furniture or shelves against the back wall.
		float f = fract(seed * 13.7);
		if (shop > 0.5) { float row = fract(h.y * 2.5); c = mix(c, vec3(0.4 + 0.5 * bHash(floor(h.xy * vec2(9.0, 2.5))), 0.35 + 0.4 * bHash(floor(h.xy * vec2(7.0, 2.5)) + 3.0), 0.3 + 0.5 * bHash(floor(h.xy * vec2(5.0, 2.5)) + 9.0)), step(0.25, row) * step(h.y, 0.6)); }
		else if (h.y < -0.2 + f * 0.5 && abs(h.x - (f - 0.5)) < 0.45) c = vec3(0.18, 0.13, 0.1) * (0.6 + f);
		else if (abs(h.x + 0.3 - f * 0.4) < 0.18 && abs(h.y - 0.15) < 0.16) c = vec3(0.35, 0.3, 0.26) + 0.3 * f; // a picture frame
	} else if (flr) c = d.y < 0.0 ? vec3(0.3, 0.2, 0.12) : vec3(0.82, 0.8, 0.76);
	else c = wall * 0.8;
	vec3 L = vec3(0.0, 0.85, 0.5);
	float lampK = 1.0 / (1.0 + 3.0 * clamp(dot(h - L, h - L), 0.0, 20.0));
	return vec4(c * (0.5 + 0.5 * (1.0 - smoothstep(0.2, 1.0, t / tz))), lampK);
}`)
			.replace('#include <map_fragment>', `
vec2 sz = vWin.xy;
vec2 p = vPane * sz;
// Per-window data is flat: interpolating a constant can give 0.99999994, which breaks == tests
// and the hashes (visible as speckle).
float mode = floor(vWin.w + 0.5), seed = vWin.z;
float blind = vWin2.x, curtain = vWin2.y, frameI = vWin2.z, flags = vWin2.w;
vec3 V = normalize(vWPos - cameraPosition);
vec3 Nw = normalize(vNw);
vec3 Vt = vec3(dot(V, vT), V.y, -dot(V, Nw));
vec3 opaque = vec3(0.0); float opaqueK = 0.0; float rough = 0.06;
vec3 frameC = framePal(frameI);
float e = min(min(p.x, sz.x - p.x), min(p.y, sz.y - p.y));
float lit = 0.0; vec3 lightC = vec3(1.0, 0.72, 0.42);
// Window frames per mode.
if (mode < 0.5 || mode == 4.0) {
	float fw = 0.07;
	float trY = sz.y * 0.72;
	float m = step(e, fw) + step(abs(p.x - sz.x * 0.5), 0.045) + step(abs(p.y - trY), 0.04) * step(1.6, sz.y);
	float sash = step(e, fw + 0.035) + step(abs(p.x - sz.x * 0.5), 0.075);
	if (mode == 4.0 && p.y < sz.y * 0.45) m = 1.0; // door: wooden lower panel
	if (m > 0.5) { opaque = frameC; opaqueK = 1.0; rough = 0.5; }
	else if (sash > 0.5) { opaque = frameC * 0.8; opaqueK = 1.0; rough = 0.5; }
	// Lit rooms: occupancy by hour, warm/cool/TV.
	float hl = bHash(vec2(seed * 53.1, floor(uHours * 0.5 + seed * 3.0)));
	lit = step(hl, uOcc) * uNight;
	float lc = fract(seed * 31.3);
	lightC = lc < 0.62 ? vec3(1.0, 0.68, 0.36) : lc < 0.85 ? vec3(0.95, 0.86, 0.72) : lc < 0.95 ? vec3(0.75, 0.85, 1.0) : vec3(0.45, 0.6, 1.0) * (0.7 + 0.3 * sin(uTime * 7.0 + seed * 40.0));
	// External roller blind (redőny) pulled down from the top.
	if (blind > 0.01 && p.y > sz.y * (1.0 - blind)) {
		float sl = fract(p.y / 0.045);
		opaque = mix(vec3(0.62, 0.6, 0.55), vec3(0.42, 0.33, 0.24), step(0.5, fract(seed * 17.0))) * (0.8 + 0.2 * smoothstep(0.0, 0.5, sl));
		opaqueK = 1.0; rough = 0.6;
		if (sl < 0.12) opaque *= 0.5 + 0.5 * lit; // light leaks between the slats
	}
	// Ground-floor bars.
	if (mod(flags, 2.0) > 0.5 && abs(fract(p.x / 0.14) - 0.5) < 0.09) { opaque = vec3(0.04); opaqueK = 1.0; rough = 0.4; }
} else if (mode == 3.0) {
	float m = step(e, 0.05) + step(abs(fract(p.x / 1.25 + 0.5) - 0.5) * 1.25, 0.03) + step(abs(p.y - sz.y * 0.85), 0.03);
	if (m > 0.5) { opaque = vec3(0.2, 0.21, 0.22); opaqueK = 1.0; rough = 0.4; }
	float office = step(8.0, uHours) * step(uHours, 18.5);
	lit = max(office * 0.7, step(bHash(vec2(seed * 7.0, 2.0)), uOcc * 0.5) * uNight);
	lightC = vec3(0.9, 0.95, 1.0);
} else if (mode == 8.0) {
	// Fanlight over a gate: radial bars and a ring.
	vec2 q = vec2(vPane.x - 0.5, vPane.y) * vec2(2.0, 1.0);
	float r = length(q), a = atan(q.y, q.x);
	float bar = step(abs(fract(a / 3.14159 * 4.0 + 0.5) - 0.5), 0.07) + step(abs(r - 0.45), 0.05) + step(0.92, r) + step(vPane.y, 0.05);
	if (bar > 0.5) { opaque = vec3(0.04); opaqueK = 1.0; rough = 0.5; }
	lit = step(0.45, fract(seed * 5.3)) * uNight;
	lightC = vec3(1.0, 0.75, 0.42);
} else {
	// Shopfronts: thin dark frame, a door leaf, a transom.
	float m = step(e, 0.06) + step(abs(p.y - 2.35), 0.04) * step(2.9, sz.y) + step(abs(p.x - (sz.x - 1.0)), 0.04) * step(2.4, sz.x);
	if (m > 0.5) { opaque = frameC; opaqueK = 1.0; rough = 0.35; }
	float open = step(7.0 + floor(fract(seed * 3.7) * 2.0), uHours) * step(uHours, 18.0 + floor(blind * 5.0));
	if (blind > 0.9) open = 1.0; // non-stop
	if (mode == 9.0) open = step(8.0, uHours) * step(uHours, 23.0);
	if (mode == 7.0) open = step(10.0, uHours) * step(uHours, 22.0) + step(0.6, curtain);
	lit = clamp(open, 0.0, 1.0);
	lightC = mode == 9.0 ? vec3(1.0, 0.7, 0.4) : mode == 10.0 ? vec3(0.85, 1.0, 0.9) : vec3(0.95, 0.92, 0.85);
	if (mode == 2.0) {
		// Empty unit: whitewashed glass with a "KIADÓ" bill.
		opaque = vec3(0.78, 0.77, 0.72) * (0.85 + 0.15 * bHash(floor(p * 9.0))); opaqueK = 0.9; rough = 0.8;
		vec2 bill = p - vec2(sz.x * 0.5, 1.5);
		if (abs(bill.x) < 0.3 && abs(bill.y) < 0.21) { opaque = vec3(0.95, 0.94, 0.9); if (abs(bill.y - 0.08) < 0.05 && abs(bill.x) < 0.24) opaque = vec3(0.7, 0.05, 0.05); else if (abs(bill.y + 0.06) < 0.025 && abs(bill.x) < 0.2) opaque = vec3(0.1); }
		lit = 0.0;
	} else if (mode == 6.0) {
		// Nemzeti Dohánybolt: the windows are covered (no view inside), brown film, tricolour band, "18" sticker.
		opaque = vec3(0.23, 0.13, 0.07); opaqueK = 1.0; rough = 0.4;
		if (abs(p.y - 1.9) < 0.12) opaque = p.y > 1.98 ? vec3(0.62, 0.05, 0.06) : p.y > 1.82 ? vec3(0.9, 0.9, 0.88) : vec3(0.05, 0.38, 0.16);
		if (length(p - vec2(sz.x - 0.5, 1.4)) < 0.1) opaque = length(p - vec2(sz.x - 0.5, 1.4)) < 0.075 ? vec3(0.95) : vec3(0.75, 0.02, 0.02);
		if (m > 0.5) opaque = vec3(0.05);
	}
	// Roller shutter down after closing on most shops.
	if (lit < 0.5 && mode != 2.0 && fract(seed * 11.0) < 0.62 && mode != 9.0) {
		float rib = fract(p.y / 0.09);
		opaque = vec3(0.5, 0.51, 0.5) * (0.75 + 0.25 * smoothstep(0.0, 0.5, rib) * smoothstep(1.0, 0.6, rib)); opaqueK = 1.0; rough = 0.45;
		vec4 gf = texture(uLayers, vec3(p.x / 6.0 + seed * 5.0, p.y / 3.0, ${GRAFFITI}.0));
		opaque = mix(opaque, gf.rgb * 0.8, gf.a * step(0.4, fract(seed * 23.0)));
	}
}
// The glass: reflection (sky above the horizon, opposite facades and the street below) + the room.
vec3 R = reflect(V, Nw);
R.xz += (vec2(bHash(floor(p * 3.0) + seed), bHash(floor(p * 3.0) + seed + 7.0)) - 0.5) * 0.03;
R = normalize(R);
vec3 refl = R.y > 0.32 ? mix(uSkyHor, uSkyTop, smoothstep(0.32, 0.9, R.y)) : R.y > 0.0 ? mix(uStreet * 2.2, uSkyHor * 0.8, smoothstep(0.12, 0.32, R.y)) * (0.75 + 0.5 * step(0.5, fract(R.x * 9.0 + R.z * 9.0))) : uStreet;
float cosT = clamp(-dot(V, Nw), 0.0, 1.0);
float fres = 0.12 + 0.88 * pow(1.0 - cosT, 5.0);
bool roomy = mode < 0.5 || mode == 4.0 || mode == 3.0 || (mode >= 1.0 && mode != 2.0 && mode != 6.0 && mode != 8.0);
vec4 roomL = vec4(0.05, 0.05, 0.05, 0.6);
if (mode == 1.0 || mode >= 9.0) roomL = shopAt(vPane, Vt, seed);
else if (roomy) roomL = roomAt(vPane, Vt, seed, 0.0);
vec3 room = roomL.rgb; float lampK = roomL.a;
// Net curtains (függöny) in most flats.
float veil = (mode < 0.5 && curtain < 0.7) ? 0.72 * step(p.y, sz.y * (curtain < 0.35 ? 0.98 : 0.72)) : 0.0;
vec3 lace = vec3(0.85, 0.84, 0.8) * (0.9 + 0.1 * sin(p.x * 60.0 + sin(p.y * 40.0)));
float inside = (1.0 - fres);
vec3 transmitted = room * (uDayLight * 0.16 + lit * lightC * (0.6 + 1.6 * lampK) * (mode >= 1.0 && mode != 4.0 ? 0.38 + 0.6 * uNight : 1.0));
if (mode == 7.0) transmitted = (room * 0.25 + vec3(0.9, 0.1, 0.8) * smoothstep(0.08, 0.0, abs(vPane.y - 0.92)) + vec3(0.1, 0.9, 1.0) * smoothstep(0.1, 0.0, abs(vPane.x - 0.08))) * (0.3 + 1.7 * lit);
transmitted = mix(transmitted, lace * (uDayLight * 0.18 + lit * lightC * 0.9), veil);
vec3 glassE = transmitted * inside + refl * fres * (0.7 + 0.6 * uDayLight);
// Ambient occlusion at the top and sides of the recess.
float ao = mix(0.55, 1.0, smoothstep(0.0, 0.35, sz.y - p.y)) * mix(0.75, 1.0, smoothstep(0.0, 0.12, min(p.x, sz.x - p.x)));
diffuseColor.rgb = opaque * opaqueK * ao;
vec3 glassEmit = glassE * (1.0 - opaqueK) * ao;
if (mode == 6.0 && uNight > 0.3) glassEmit += vec3(0.05, 0.03, 0.01) * opaqueK;`)
			.replace('#include <roughnessmap_fragment>', 'float roughnessFactor = rough;')
			.replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
			.replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance = glassEmit;');
	});
}

// ---------------------------------------------------------------- far shell

export function farMaterial(U) {
	const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, vertexColors: true });
	mat.name = 'buildings-far';
	return patch(mat, U, (sh) => {
		sh.vertexShader = sh.vertexShader
			.replace('#include <common>', `#include <common>
attribute vec4 f1; attribute vec4 f2; attribute float chunk;
uniform sampler2D uDetail;
varying vec4 vF1; flat varying vec4 vF2; varying vec3 vWPos; varying vec3 vWN;`)
			.replace('#include <uv_vertex>', `#include <uv_vertex>
vF1 = f1; vF2 = f2; vWN = normal;`)
			.replace('#include <project_vertex>', `#include <project_vertex>
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
{
	float cx = mod(chunk, ${GRID_W}.0), cz = floor(chunk / ${GRID_W}.0 + 0.001);
	if (texelFetch(uDetail, ivec2(int(cx), int(cz)), 0).r > 0.5) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
}`);
		sh.fragmentShader = sh.fragmentShader
			.replace('#include <common>', `#include <common>
${LAYER_PARS}
varying vec4 vF1; flat varying vec4 vF2; varying vec3 vWPos; varying vec3 vWN;`)
			.replace('#include <color_fragment>', `
float kind = floor(vF2.w + 0.001), seedF = fract(vF2.w);
float y = vWPos.y, u = vF1.x, gTop = vF2.x, fH = max(vF2.y, 2.5), topY = vF2.z;
vec3 base = vColor.rgb;
float win = 0.0; float wlit = 0.0; float wrough = 0.9; vec3 wcol = vec3(0.0);
vec4 tx;
if (topY < 0.0) {
	// Roofs.
	tx = texture(uLayers, vec3(vWPos.xz / 2.0, seedF > 0.4 ? 9.0 : 6.0));
	base *= tx.rgb * 2.0;
} else {
	tx = texture(uLayers, vec3(u / 3.2, y / 3.2, kind > 2.5 ? 4.0 : 1.0));
	base *= tx.rgb * 2.0;
	base *= 1.0 - 0.4 * smoothstep(topY - 6.0, topY + 1.5, y) * (0.5 + seedF);
	base *= 1.0 - 0.25 * smoothstep(1.2, 0.0, y);
	if (kind > 0.5 && kind < 2.5 && y < topY) {
		float st = max(vF1.y, 0.5), bi = floor((u - vF1.z) / st);
		if (bi >= 0.0 && bi < vF1.w) {
			float lx = u - vF1.z - (bi + 0.5) * st;
			if (y > gTop) {
				float fi = floor((y - gTop) / fH), ly = y - gTop - fi * fH;
				float wh = min(fH - 1.45, 2.4);
				if (abs(lx) < 0.66 && ly > 0.92 && ly < 0.92 + wh) {
					win = 1.0;
					float e = min(0.66 - abs(lx), min(ly - 0.92, 0.92 + wh - ly));
					wcol = e < 0.07 ? vec3(0.7, 0.69, 0.66) : vec3(0.0);
					wlit = step(bHash(vec2(bi + seedF * 37.0, fi + seedF * 11.0)), uOcc) * uNight * step(0.07, e);
				}
			} else if (kind < 1.5 && y > 0.12 && y < gTop - 1.0 && abs(lx) < min(st * 0.5 - 0.4, 1.65)) {
				win = 1.0; wcol = vec3(0.02);
				wlit = step(bHash(vec2(bi, seedF * 9.0)), 0.6) * step(uHours, 21.0) * step(7.0, uHours);
			}
		}
	}
}
diffuseColor.rgb = win > 0.5 ? wcol : base;
vec3 farEmit = vec3(0.0);
if (win > 0.5 && dot(wcol, wcol) < 0.01) {
	vec3 Vv = normalize(vWPos - cameraPosition);
	vec3 R = reflect(Vv, normalize(vWN));
	float fres = 0.08 + 0.92 * pow(1.0 - clamp(-dot(Vv, normalize(vWN)), 0.0, 1.0), 5.0);
	farEmit = mix(uStreet * 1.5, mix(uSkyHor, uSkyTop, clamp(R.y, 0.0, 1.0)), step(0.0, R.y)) * fres * 0.8 + wlit * vec3(1.0, 0.7, 0.4) * 0.9 + uDayLight * vec3(0.02);
	wrough = 0.1;
}`)
			.replace('#include <roughnessmap_fragment>', 'float roughnessFactor = wrough;')
			.replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance = farEmit;');
	});
}

// ---------------------------------------------------------------- railings

/** Railing atlas: 4 rows (wrought, gang, modern, secession), alpha-tested. */
export function railMaterial() {
	let map = null;
	if (typeof document !== 'undefined') {
		const c = document.createElement('canvas');
		c.width = 256; c.height = 256;
		const g = c.getContext('2d');
		g.clearRect(0, 0, 256, 256);
		g.strokeStyle = g.fillStyle = '#ffffff';
		const row = (k, fn) => { g.save(); g.translate(0, (3 - k) * 64); fn(); g.restore(); };
		const rails = () => { g.fillRect(0, 2, 256, 6); g.fillRect(0, 56, 256, 4); };
		row(0, () => { rails(); g.lineWidth = 3; for (let x = 8; x < 256; x += 32) { g.fillRect(x - 1.5, 8, 3, 48); } g.lineWidth = 2.5; for (let x = 24; x < 256; x += 32) { g.beginPath(); g.arc(x, 24, 8, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.arc(x, 42, 8, 0, Math.PI * 2); g.stroke(); } });
		row(1, () => { g.fillRect(0, 1, 256, 7); g.fillRect(0, 54, 256, 4); g.fillRect(0, 16, 256, 2); for (let x = 4; x < 256; x += 30) g.fillRect(x - 1, 8, 2.5, 46); });
		row(2, () => { rails(); for (let x = 6; x < 256; x += 22) g.fillRect(x - 1, 8, 2, 48); });
		row(3, () => { rails(); g.lineWidth = 3; for (let x = 0; x < 256; x += 64) { g.beginPath(); g.moveTo(x, 56); g.bezierCurveTo(x + 10, 10, x + 54, 10, x + 64, 56); g.stroke(); g.beginPath(); g.moveTo(x + 32, 8); g.bezierCurveTo(x + 20, 30, x + 44, 30, x + 32, 56); g.stroke(); } });
		map = new THREE.CanvasTexture(c);
		map.wrapS = THREE.RepeatWrapping;
		map.anisotropy = 4;
	}
	const mat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, map, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.55, metalness: 0.5 });
	mat.name = 'railings';
	return mat;
}
