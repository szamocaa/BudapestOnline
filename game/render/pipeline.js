// The renderer and everything between the scene and the screen: shadows, ambient occlusion, bloom,
// eye adaptation, colour grading, tone mapping, quality tiers.
//
// Contract with main.js:
//   const pipeline = createPipeline(canvas, { quality });   // quality: 'high' | 'medium' | 'low' | 'auto'
//   pipeline.renderer                       // THREE.WebGLRenderer
//   pipeline.render(scene, camera, frame)   // draw one frame (street or metro scene)
//   pipeline.resize(width, height)
//   pipeline.info()                         // { drawCalls, triangles, ... } of the scene pass (shadow maps included)
//   pipeline.setQuality(q)                  // for the settings menu ('high' | 'medium' | 'low')
//   pipeline.quality                        // current tier
//   pipeline.exposure                       // current (adapted) exposure
//   pipeline.debug = 'ao' | null            // show the ambient occlusion buffer
// Helpers for other modules:
//   detectQuality()                         // a sensible default tier for this device
//   classifyGpu(rendererString, info)       // the pure part of it (unit tested)
//
// Frame (high): scene -> 4x MSAA HDR target (+ depth) -> GTAO (half res, from depth) -> bloom
// (threshold based: only what is really bright blooms) -> one final pass: AO, exposure, split toning,
// AgX tone mapping, saturation/contrast, vignette, grain. Medium: 2x MSAA, no AO. Low: direct render.
// Shader patches (aerial-perspective haze, cascaded sun shadows) are installed on import (chunks.js).
import * as THREE from '../vendor/three.module.min.js';
import { GTAOPass } from '../vendor/addons/postprocessing/GTAOPass.js';
import { installChunks } from './chunks.js';
import { Bloom } from './bloom.js';
import { sunTransmittance } from './atmosphere.js';

installChunks();

export const TIERS = {
	high: { pixelRatio: 1.5, samples: 4, ao: true, post: true, shadows: true },
	medium: { pixelRatio: 1.25, samples: 2, ao: false, post: true, shadows: true },
	low: { pixelRatio: 1, samples: 0, ao: false, post: false, shadows: false },
};

/** Quality tier for a GPU renderer string (WEBGL_debug_renderer_info) and some device facts. */
export function classifyGpu(gpu, { mobile = false, webdriver = false } = {}) {
	if (webdriver) return 'high'; // automated screenshots: always the full look
	const g = String(gpu || '').toLowerCase();
	if (!g) return mobile ? 'low' : 'medium';
	if (/swiftshader|llvmpipe|softpipe|software|basic render/.test(g)) return 'low';
	if (mobile) return /apple (a1[5-9]|m\d)|adreno.*(7[3-9]\d|8\d\d)|immortalis/.test(g) ? 'medium' : 'low';
	if (/apple (m\d|gpu)/.test(g)) return 'high';
	if (/nvidia|geforce|rtx|gtx|quadro|radeon (rx|pro)|amd radeon\(tm\) (rx|pro)|intel.*arc/.test(g)) return 'high';
	return 'medium';
}

/** A sensible default quality for this device. */
export function detectQuality() {
	try {
		const ua = navigator.userAgent || '';
		const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
		const c = document.createElement('canvas');
		const gl = c.getContext('webgl2');
		if (!gl) return 'low';
		const ext = gl.getExtension('WEBGL_debug_renderer_info');
		const gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
		const lose = gl.getExtension('WEBGL_lose_context');
		if (lose) lose.loseContext();
		let q = classifyGpu(gpu, { mobile, webdriver: !!navigator.webdriver });
		// a weak GPU driving a huge screen: one tier down
		if (q === 'high' && !navigator.webdriver && screen.width * screen.height * (window.devicePixelRatio || 1) ** 2 > 9e6 && !/apple|nvidia|geforce|rtx/i.test(gpu)) q = 'medium';
		return q;
	} catch {
		return 'medium';
	}
}

/**
 * Camera white balance: daylight (sun at 35 deg through a typical Budapest haze) renders neutral,
 * `amount` of the way (1 = full correction). Lamps stay warm, twilight stays blue, sunsets orange.
 */
export function whiteBalance(amount = 0.7) {
	const t = sunTransmittance(35, 0.12);
	const l = 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2];
	return new THREE.Vector3(...t.map((v) => 1 + (l / v - 1) * amount));
}

const FS_VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FINAL_FRAG = /* glsl */ `
uniform sampler2D tColor, tBloom, tAO;
uniform float useAO, aoStrength, bloomStrength, exposure, vignette, grain, time, saturation, contrast, debugAO;
uniform vec3 shadowTint, highlightTint, whiteBalance;
uniform vec2 resolution;
varying vec2 vUv;
#include <tonemapping_pars_fragment>
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
	vec3 c = texture2D(tColor, vUv).rgb;
	float ao = 1.0;
	if (useAO > 0.5) ao = mix(1.0, texture2D(tAO, vUv).r, aoStrength);
	if (debugAO > 0.5) { gl_FragColor = vec4(vec3(ao), 1.0); return; }
	c = (c * ao * exposure + texture2D(tBloom, vUv).rgb * bloomStrength) * whiteBalance;
	// split toning in scene light: cool shadows, warm highlights (amount set per time of day)
	float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
	c *= mix(shadowTint, highlightTint, l / (l + 0.4));
	#if TM == 1
		c = ACESFilmicToneMapping(c);
	#elif TM == 2
		c = NeutralToneMapping(c);
	#else
		c = AgXToneMapping(c);
	#endif
	c = clamp(c, 0.0, 1.0);
	// display-referred look: saturation and a gentle S-curve
	float ld = dot(c, vec3(0.2126, 0.7152, 0.0722));
	c = max(mix(vec3(ld), c, saturation), 0.0);
	c = sRGBTransferOETF(vec4(c, 1.0)).rgb;
	c = mix(c, c * c * (3.0 - 2.0 * c), contrast);
	vec2 q = (vUv - 0.5) * vec2(resolution.x / resolution.y, 1.0);
	c *= 1.0 - vignette * smoothstep(0.25, 1.1, dot(q, q) * 1.6);
	float n = hash(vUv * resolution + fract(time) * 917.0) + hash(vUv * resolution * 1.37 - fract(time * 1.3) * 431.0) - 1.0;
	c += n * grain * (1.0 - 0.6 * ld);
	gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

export function createPipeline(canvas, { quality = 'high' } = {}) {
	if (quality === 'auto' || !TIERS[quality]) quality = quality === 'auto' ? detectQuality() : 'high';
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality === 'low', powerPreference: 'high-performance' });
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	renderer.info.autoReset = false;
	const url = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
	const tm = { aces: 1, neutral: 2 }[url.get('tonemap')] || 0;
	renderer.toneMapping = [THREE.AgXToneMapping, THREE.ACESFilmicToneMapping, THREE.NeutralToneMapping][tm];

	const state = {
		quality,
		tier: { ...TIERS[quality] },
		width: window.innerWidth,
		height: window.innerHeight,
		exposure: 1.5,
		logExp: null,
		gov: { slow: 0, fps: 60, enabled: !navigator.webdriver },
	};

	let sceneRT = null, gtao = null, bloom = null;
	const finalMat = new THREE.ShaderMaterial({
		defines: { TM: tm },
		uniforms: {
			tColor: { value: null }, tBloom: { value: null }, tAO: { value: null },
			useAO: { value: 0 }, aoStrength: { value: 0.85 }, bloomStrength: { value: 0.05 }, exposure: { value: 1 },
			vignette: { value: 0.22 }, grain: { value: 0.012 }, time: { value: 0 }, saturation: { value: 1.06 }, contrast: { value: 0.14 },
			debugAO: { value: 0 },
			shadowTint: { value: new THREE.Vector3(1, 1, 1) }, whiteBalance: { value: whiteBalance(0.7) }, highlightTint: { value: new THREE.Vector3(1, 1, 1) },
			resolution: { value: new THREE.Vector2(1, 1) },
			toneMappingExposure: { value: 1 },
		},
		vertexShader: FS_VERT, fragmentShader: FINAL_FRAG, depthTest: false, depthWrite: false, toneMapped: false,
	});
	const fsScene = new THREE.Scene();
	const fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), finalMat);
	fsQuad.frustumCulled = false;
	fsScene.add(fsQuad);
	const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

	function bufferSize() {
		const pr = renderer.getPixelRatio();
		return [Math.max(1, Math.floor(state.width * pr)), Math.max(1, Math.floor(state.height * pr))];
	}

	function disposeTargets() {
		if (sceneRT) { sceneRT.depthTexture.dispose(); sceneRT.dispose(); sceneRT = null; }
		if (gtao) { gtao.gtaoRenderTarget.dispose(); gtao.pdRenderTarget.dispose(); gtao = null; }
		if (bloom) { bloom.dispose(); bloom = null; }
	}

	function makeGtao(depthTexture, camera, w, h) {
		// Depth only (normals reconstructed from depth): no extra scene pass, no extra draw calls.
		const p = new GTAOPass(new THREE.Scene(), camera, 1, 1);
		p.normalRenderTarget.dispose();
		p.setGBuffer(depthTexture);
		p.normalRenderTarget = { setSize() {}, dispose() {}, depthTexture: null };
		p.output = GTAOPass.OUTPUT.Off;
		// tuned for a street in metres: contact shadow under cars, people, kerbs, in corners and arcades
		p.updateGtaoMaterial({ radius: 1.1, distanceExponent: 1.6, thickness: 2.0, scale: 1.15, samples: 12, distanceFallOff: 0.6, screenSpaceRadius: false });
		p.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 1, rings: 2, samples: 12 });
		p.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
		return p;
	}

	function configure() {
		const t = state.tier;
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, t.pixelRatio));
		renderer.setSize(state.width, state.height);
		if (renderer.shadowMap.enabled !== t.shadows) { renderer.shadowMap.enabled = t.shadows; renderer.shadowMap.needsUpdate = true; }
		disposeTargets();
		if (!t.post) return;
		const [w, h] = bufferSize();
		sceneRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: t.samples, depthBuffer: true, stencilBuffer: false });
		sceneRT.depthTexture = new THREE.DepthTexture(w, h);
		sceneRT.depthTexture.type = THREE.UnsignedIntType;
		bloom = new Bloom(6);
		bloom.setSize(w, h);
		finalMat.uniforms.resolution.value.set(w, h);
	}
	configure();

	let last = { drawCalls: 0, triangles: 0 };
	let currentCamera = null;

	function grade(frame) {
		const u = finalMat.uniforms;
		const sky = frame && frame.sky;
		const metro = frame && frame.mode === 'metro';
		const night = metro ? 0.6 : sky ? sky.night : 0;
		const golden = metro ? 0 : sky ? sky.golden || 0 : 0;
		// shadows cool, highlights warm; stronger at golden hour and at night (sodium-ish lamps vs blue sky)
		u.shadowTint.value.set(1 - 0.03 * night - 0.01, 1, 1 + 0.06 * night + 0.02 + 0.02 * golden);
		u.highlightTint.value.set(1 + 0.025 + 0.04 * golden + 0.03 * night, 1 + 0.005 * golden, 1 - 0.03 - 0.06 * golden - 0.05 * night);
		u.grain.value = 0.010 + 0.012 * night;
		u.vignette.value = 0.2 + 0.08 * night;
		u.saturation.value = 1.04 + 0.04 * golden - 0.06 * night;
		u.bloomStrength.value = 0.035 + 0.035 * night;
	}

	function adapt(frame) {
		const dt = frame ? Math.min(0.1, frame.dt || 0) : 0.016;
		const target = frame && frame.mode === 'metro' ? 2.1 : frame && frame.sky && frame.sky.exposure ? frame.sky.exposure : 1.5;
		const lt = Math.log(target);
		if (state.logExp === null || !isFinite(state.logExp)) state.logExp = lt;
		// the eye adapts to darkness more slowly than to brightness
		const k = lt > state.logExp ? 0.9 : 2.2;
		state.logExp += (lt - state.logExp) * (1 - Math.exp(-dt * k));
		state.exposure = Math.exp(state.logExp);
	}

	function governor(frame) {
		const g = state.gov;
		if (!g.enabled || !frame || !(frame.dt > 0) || state.quality === 'low') return;
		g.fps += (1 / frame.dt - g.fps) * 0.05;
		g.slow = g.fps < 45 ? g.slow + frame.dt : Math.max(0, g.slow - frame.dt * 2);
		if (g.slow < 5) return;
		g.slow = 0;
		const t = state.tier;
		const pr = renderer.getPixelRatio();
		if (pr > 1.01) t.pixelRatio = Math.max(1, pr - 0.25);
		else if (t.ao) t.ao = false;
		else if (t.samples > 2) t.samples = 2;
		else if (pr > 0.76) t.pixelRatio = Math.max(0.75, pr - 0.125);
		else { g.enabled = false; return; }
		configure();
	}

	const api = {
		renderer,
		get quality() { return state.quality; },
		get exposure() { return state.exposure; },
		debug: null,
		render(scene, camera, frame) {
			adapt(frame);
			governor(frame);
			renderer.info.reset();
			if (!sceneRT) {
				renderer.toneMappingExposure = state.exposure;
				renderer.setRenderTarget(null);
				renderer.render(scene, camera);
				last = { drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, post: 0, exposure: state.exposure, quality: state.quality };
				return;
			}
			renderer.toneMappingExposure = 1;
			renderer.setRenderTarget(sceneRT);
			renderer.clear();
			renderer.render(scene, camera);
			const calls = renderer.info.render.calls, tris = renderer.info.render.triangles;
			const u = finalMat.uniforms;
			if (state.tier.ao) {
				if (!gtao || currentCamera !== camera) {
					if (gtao) { gtao.gtaoRenderTarget.dispose(); gtao.pdRenderTarget.dispose(); }
					const [w, h] = bufferSize();
					gtao = makeGtao(sceneRT.depthTexture, camera, w, h);
					currentCamera = camera;
				}
				gtao.render(renderer, null, sceneRT);
				u.tAO.value = gtao.pdRenderTarget.texture;
				u.useAO.value = 1;
			} else u.useAO.value = 0;
			grade(frame);
			u.tBloom.value = bloom.render(renderer, sceneRT.texture, { threshold: 1.7, knee: 0.7, exposure: state.exposure });
			u.tColor.value = sceneRT.texture;
			u.exposure.value = state.exposure;
			u.time.value = (performance.now() / 1000) % 1000;
			u.debugAO.value = api.debug === 'ao' ? 1 : 0;
			renderer.setRenderTarget(null);
			renderer.render(fsScene, fsCam);
			last = {
				drawCalls: calls, triangles: tris, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures,
				post: renderer.info.render.calls - calls, exposure: state.exposure, quality: state.quality, pixelRatio: renderer.getPixelRatio(),
			};
		},
		resize(w, h) {
			state.width = w;
			state.height = h;
			renderer.setSize(w, h);
			if (!sceneRT) return;
			const [bw, bh] = bufferSize();
			sceneRT.setSize(bw, bh);
			bloom.setSize(bw, bh);
			if (gtao) gtao.setSize(Math.max(1, bw >> 1), Math.max(1, bh >> 1));
			finalMat.uniforms.resolution.value.set(bw, bh);
		},
		setQuality(q) {
			if (!TIERS[q]) return;
			state.quality = q;
			state.tier = { ...TIERS[q] };
			state.gov.slow = 0;
			configure();
		},
		info: () => last,
	};
	return api;
}
