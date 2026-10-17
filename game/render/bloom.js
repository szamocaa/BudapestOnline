// Physically based bloom (the "dual filter" of Jimenez 2014, as in many modern engines): a soft
// threshold, a chain of 13-tap downsamples and 9-tap tent upsamples, summed. Threshold-based, so
// whatever is bright enough blooms (lamps, lit windows, signs, headlights, the sun) and other modules
// never have to register anything.
//
//   const bloom = new Bloom(levels);
//   bloom.setSize(width, height);                      // drawing-buffer size
//   const tex = bloom.render(renderer, hdrTexture, { threshold, knee, exposure });
import * as THREE from '../vendor/three.module.min.js';

const VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const DOWN = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 texel;      // 1 / source size
uniform float prefilter; // 1 on the first pass: threshold + Karis average against fireflies
uniform float threshold, knee, exposure;
varying vec2 vUv;
vec3 s(vec2 o) { return texture2D(tSrc, vUv + o * texel).rgb; }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 kw(vec3 c) { return c / (1.0 + luma(c)); }
void main() {
	vec3 a = s(vec2(-2, 2)), b = s(vec2(0, 2)), c = s(vec2(2, 2));
	vec3 d = s(vec2(-2, 0)), e = s(vec2(0, 0)), f = s(vec2(2, 0));
	vec3 g = s(vec2(-2, -2)), h = s(vec2(0, -2)), i = s(vec2(2, -2));
	vec3 j = s(vec2(-1, 1)), k = s(vec2(1, 1)), l = s(vec2(-1, -1)), m = s(vec2(1, -1));
	vec3 o;
	if (prefilter > 0.5) {
		vec3 g0 = (j + k + l + m) * 0.25, g1 = (a + b + d + e) * 0.25, g2 = (b + c + e + f) * 0.25, g3 = (d + e + g + h) * 0.25, g4 = (e + f + h + i) * 0.25;
		float w0 = 1.0 / (1.0 + luma(g0)), w1 = 1.0 / (1.0 + luma(g1)), w2 = 1.0 / (1.0 + luma(g2)), w3 = 1.0 / (1.0 + luma(g3)), w4 = 1.0 / (1.0 + luma(g4));
		o = (g0 * w0 * 0.5 + (g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) * 0.125) / (w0 * 0.5 + (w1 + w2 + w3 + w4) * 0.125);
		o = min(o * exposure, vec3(200.0));
		float br = max(o.r, max(o.g, o.b));
		float rq = clamp(br - threshold + knee, 0.0, 2.0 * knee);
		rq = rq * rq / (4.0 * knee + 1e-4);
		o *= max(rq, br - threshold) / max(br, 1e-4);
	} else {
		o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
	}
	gl_FragColor = vec4(max(o, vec3(0.0)), 1.0);
}`;

const UP = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 texel;
uniform float weight;
varying vec2 vUv;
vec3 s(vec2 o) { return texture2D(tSrc, vUv + o * texel).rgb; }
void main() {
	vec3 c = s(vec2(0, 0)) * 4.0 + (s(vec2(-1, 0)) + s(vec2(1, 0)) + s(vec2(0, -1)) + s(vec2(0, 1))) * 2.0
		+ s(vec2(-1, -1)) + s(vec2(1, -1)) + s(vec2(-1, 1)) + s(vec2(1, 1));
	gl_FragColor = vec4(c / 16.0 * weight, 1.0);
}`;

export class Bloom {
	constructor(levels = 6) {
		this.levels = levels;
		this.mips = [];
		const opts = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
		for (let i = 0; i < levels; i++) this.mips.push(new THREE.WebGLRenderTarget(1, 1, opts));
		this.down = new THREE.ShaderMaterial({
			uniforms: { tSrc: { value: null }, texel: { value: new THREE.Vector2() }, prefilter: { value: 0 }, threshold: { value: 1.5 }, knee: { value: 0.6 }, exposure: { value: 1 } },
			vertexShader: VERT, fragmentShader: DOWN, depthTest: false, depthWrite: false,
		});
		this.up = new THREE.ShaderMaterial({
			uniforms: { tSrc: { value: null }, texel: { value: new THREE.Vector2() }, weight: { value: 1 } },
			vertexShader: VERT, fragmentShader: UP, depthTest: false, depthWrite: false,
			blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
		});
		this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.down);
		this.quad.frustumCulled = false;
		this.scene = new THREE.Scene();
		this.scene.add(this.quad);
		this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
		this.size = [0, 0];
	}

	setSize(w, h) {
		this.size = [w, h];
		let x = w, y = h;
		for (const m of this.mips) {
			x = Math.max(1, Math.floor(x / 2));
			y = Math.max(1, Math.floor(y / 2));
			m.setSize(x, y);
		}
	}

	pass(renderer, mat, target) {
		this.quad.material = mat;
		renderer.setRenderTarget(target);
		renderer.render(this.scene, this.cam);
	}

	/** Returns the bloom texture (half resolution) for an HDR source texture. */
	render(renderer, src, { threshold = 1.5, knee = 0.6, exposure = 1 } = {}) {
		const d = this.down.uniforms;
		const autoClear = renderer.autoClear;
		renderer.autoClear = true;
		let srcTex = src, sw = this.size[0], sh = this.size[1];
		for (let i = 0; i < this.levels; i++) {
			d.tSrc.value = srcTex;
			d.texel.value.set(1 / sw, 1 / sh);
			d.prefilter.value = i === 0 ? 1 : 0;
			d.threshold.value = threshold; d.knee.value = knee; d.exposure.value = exposure;
			this.pass(renderer, this.down, this.mips[i]);
			srcTex = this.mips[i].texture;
			sw = this.mips[i].width; sh = this.mips[i].height;
		}
		// upsample: add each smaller level onto the next larger one
		renderer.autoClear = false;
		const u = this.up.uniforms;
		for (let i = this.levels - 1; i > 0; i--) {
			u.tSrc.value = this.mips[i].texture;
			u.texel.value.set(1 / this.mips[i].width, 1 / this.mips[i].height);
			u.weight.value = 1;
			this.pass(renderer, this.up, this.mips[i - 1]);
		}
		renderer.autoClear = autoClear;
		return this.mips[0].texture;
	}

	dispose() {
		for (const m of this.mips) m.dispose();
		this.down.dispose();
		this.up.dispose();
	}
}
