// The sky itself: a GPU sky-view lookup table of the physically based atmosphere (atmosphere.js),
// the dome that draws it with the sun disc, the moon (lit by the real sun, so its phase is right),
// two layers of drifting procedural clouds (clouds.js) and the city's light glow; plus the few
// hundred real naked-eye stars (stars.js) placed by sidereal time.
//
//   const dome = new SkyDome(renderer);
//   scene.add(dome.mesh, dome.stars);      // the dome draws last among opaque objects, sky pixels only
//   dome.renderLut(renderer, lightDir, aod) // when the light moved (cheap: 128 x 64 texels)
//   dome.uniforms.*                         // set by sky.js every frame
//   dome.envScene                           // a scene with only the dome, for the PMREM environment
import * as THREE from '../vendor/three.module.min.js';
import { ATMOSPHERE_GLSL, SKYVIEW_GLSL, atmosphereParams } from './atmosphere.js';
import { CLOUD_GLSL, makeCloudNoise, NOISE_SIZE, CLOUD_LOW_H, CLOUD_HIGH_H } from './clouds.js';
import { STARS, starColour, equatorialVector } from './stars.js';

export const LUT_W = 128, LUT_H = 64;

const FULLSCREEN_VERT = /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const LUT_FRAG = /* glsl */ `
${ATMOSPHERE_GLSL}
uniform float lightEl;
void main() {
	vec2 uv = (gl_FragCoord.xy - 0.5) / vec2(${LUT_W - 1}.0, ${LUT_H - 1}.0);
	float az = uv.x * 3.14159265;
	float s = uv.y < 0.5 ? -1.0 : 1.0;
	float e = 2.0 * uv.y - 1.0;
	float el = s * e * e * 1.5707963;
	vec3 d = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
	vec3 l = vec3(cos(lightEl), sin(lightEl), 0.0);
	gl_FragColor = vec4(skyRadiance(d, l), 1.0);
}`;

const DOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
	vDir = position;
	vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
	gl_Position = p;
	gl_Position.z = gl_Position.w; // at infinity
}`;

const DOME_FRAG = /* glsl */ `
uniform sampler2D tLut;
uniform vec3 lutLight;        // direction of the light the LUT was made for (sun, or moon at night)
uniform float lutScale;       // LUT value -> scene radiance
uniform vec3 sunDir, moonDir;
uniform vec3 sunDisc;         // radiance of the sun disc (HDR)
uniform vec3 moonDisc;        // radiance of the lit moon
uniform vec3 cloudSun;        // sun (or moon) irradiance reaching the cloud layer
uniform vec3 cloudLightDir;   // direction of that light
uniform vec3 cloudAmbient;    // sky + city light on the clouds (radiance of a white cloud)
uniform vec3 nightSky;        // base night sky radiance (zenith)
uniform vec3 cityGlow;        // light pollution radiance at the horizon
uniform vec3 groundColor;     // radiance below the horizon (only seen by the environment map)
uniform vec3 viewOrigin;      // world position the clouds are seen from
uniform float discs;          // 1 = draw sun and moon discs (0 for the environment map)
uniform float moonCos;        // cos of the moon's drawn angular radius
varying vec3 vDir;
${SKYVIEW_GLSL}
${CLOUD_GLSL}

float hg(float c, float g) {
	float g2 = g * g;
	return (1.0 - g2) / (12.566371 * pow(1.0 + g2 - 2.0 * g * c, 1.5));
}

vec3 skyAt(vec3 d) {
	vec3 dd = d;
	dd.y = max(dd.y, 0.0005);
	dd = normalize(dd);
	vec3 c = texture2D(tLut, skyViewUV(dd, lutLight, vec2(${LUT_W}.0, ${LUT_H}.0))).rgb * lutScale;
	float h = max(dd.y, 0.0);
	c += nightSky * (0.55 + 0.45 * (1.0 - h));
	c += cityGlow * (exp(-h * 9.0) * 0.8 + exp(-h * 2.5) * 0.2);
	return c;
}

void main() {
	vec3 d = normalize(vDir);
	vec3 col = skyAt(d);
	float clear = 1.0; // how much of the sun/moon disc shows through clouds

	if (d.y > 0.0) {
		float fade = smoothstep(0.025, 0.2, d.y);
		vec3 lh = normalize(vec3(cloudLightDir.x, 0.0, cloudLightDir.z) + vec3(1e-4, 0.0, 0.0));
		float ph = dot(d, cloudLightDir);
		// cirrus (high, thin, bright)
		vec2 pH = viewOrigin.xz + d.xz / max(d.y, 0.03) * ${CLOUD_HIGH_H.toFixed(1)};
		float ci = highCloud(pH) * fade;
		if (ci > 0.001) {
			vec3 cc = cloudSun * (0.08 + 2.2 * hg(ph, 0.5)) * 0.9 + cloudAmbient * 0.75;
			col = mix(col, cc, ci * 0.55);
			clear *= 1.0 - ci * 0.35;
		}
		// low clouds (cumulus / stratocumulus)
		vec2 pL = viewOrigin.xz + d.xz / max(d.y, 0.03) * ${CLOUD_LOW_H.toFixed(1)};
		float cl = lowCloud(pL);
		if (cl > 0.001) {
			// self shadowing: density between this point and the light
			float s1 = lowCloud(pL + lh.xz * 220.0);
			float s2 = lowCloud(pL + lh.xz * 650.0);
			float shade = exp(-(s1 * 1.2 + s2 * 0.6) * (0.6 + 0.8 * cloudShape.y));
			float thick = smoothstep(0.0, 1.0, cl);
			float powder = 1.0 - exp(-cl * 4.0);
			vec3 direct = cloudSun * mix(shade, 1.0, 0.15) * powder * (0.2 + 1.9 * hg(ph, 0.6) + 1.1 * hg(ph, -0.25));
			vec3 amb = cloudAmbient * mix(1.0, 0.55, thick * (0.4 + 0.6 * cloudShape.y));
			vec3 cc = direct + amb;
			// distant clouds sink into the haze of the horizon
			float haze = 1.0 - smoothstep(0.02, 0.3, d.y);
			cc = mix(cc, skyAt(d) * 1.1, haze * 0.7);
			float a = smoothstep(0.0, 0.45, cl) * fade;
			col = mix(col, cc, a);
			clear *= 1.0 - smoothstep(0.0, 0.25, cl) * fade;
		}
	} else {
		col = mix(col, groundColor, smoothstep(0.0, 0.06, -d.y));
	}

	if (discs > 0.5) {
		// sun: limb-darkened disc slightly larger than the real 0.53 deg, plus a tight aureole
		float cs = dot(d, sunDir);
		float r = 0.0062;
		float a = acos(clamp(cs, -1.0, 1.0));
		if (a < r * 1.2) {
			float x = clamp(a / r, 0.0, 1.0);
			float limb = 1.0 - 0.55 * (1.0 - sqrt(1.0 - x * x));
			col += sunDisc * limb * (1.0 - smoothstep(0.92, 1.05, a / r)) * clear;
		}
		col += sunDisc * 0.0006 * exp(-a * 90.0) * clear;
		// moon: a sphere lit by the sun, so phase and orientation follow the real geometry
		float mc = dot(d, moonDir);
		if (mc > moonCos) {
			vec3 right = normalize(cross(moonDir, vec3(0.0, 1.0, 0.0)));
			vec3 up = cross(right, moonDir);
			float sr = sqrt(1.0 - moonCos * moonCos);
			float mx = dot(d, right) / sr, my = dot(d, up) / sr;
			float mz = sqrt(max(0.0, 1.0 - mx * mx - my * my));
			vec3 n = mx * right + my * up - mz * moonDir;
			float lit = max(dot(n, sunDir), 0.0);
			float maria = texture2D(tNoise, vec2(mx, my) * 0.22 + vec2(0.31, 0.57)).g;
			float alb = 0.62 + 0.55 * smoothstep(0.35, 0.65, maria);
			float edge = smoothstep(1.0, 0.92, sqrt(mx * mx + my * my));
			vec3 m = moonDisc * alb * (lit + 0.012);
			col = mix(col, col * 0.6 + m, edge * clear);
		}
	}
	gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}`;

const STAR_VERT = /* glsl */ `
attribute vec3 starCol;
attribute float mag;
uniform mat3 eqToWorld;
uniform float starVis;
uniform float pixelRatio;
uniform vec3 viewOrigin;
uniform float time;
varying vec3 vCol;
${CLOUD_GLSL}
void main() {
	vec3 d = eqToWorld * position;
	vec4 p = projectionMatrix * viewMatrix * vec4(cameraPosition + d * 2000.0, 1.0);
	gl_Position = p;
	gl_Position.z = gl_Position.w;
	// extinction and haze near the horizon, clouds in front, light pollution
	float ext = smoothstep(0.03, 0.35, d.y);
	vec2 pL = viewOrigin.xz + d.xz / max(d.y, 0.03) * ${CLOUD_LOW_H.toFixed(1)};
	float cloud = d.y > 0.0 ? lowCloud(pL) : 1.0;
	float vis = starVis * ext * (1.0 - smoothstep(0.0, 0.3, cloud));
	float b = pow(10.0, -0.4 * (mag - 1.0));
	float tw = 0.82 + 0.18 * sin(time * (3.0 + fract(position.x * 91.7) * 5.0) + position.y * 47.0);
	vCol = starCol * min(b, 3.0) * vis * tw * 0.35;
	gl_PointSize = clamp(2.6 - 0.35 * mag, 1.2, 3.2) * pixelRatio;
	if (vis <= 0.001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const STAR_FRAG = /* glsl */ `
varying vec3 vCol;
void main() {
	vec2 q = gl_PointCoord * 2.0 - 1.0;
	float f = max(0.0, 1.0 - dot(q, q));
	gl_FragColor = vec4(vCol * f * f, 1.0);
}`;

export class SkyDome {
	constructor(renderer) {
		this.noiseData = makeCloudNoise(NOISE_SIZE);
		const tex = new THREE.DataTexture(this.noiseData, NOISE_SIZE, NOISE_SIZE, THREE.RGBAFormat);
		tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
		tex.magFilter = THREE.LinearFilter;
		tex.minFilter = THREE.LinearMipmapLinearFilter;
		tex.generateMipmaps = true;
		tex.needsUpdate = true;
		this.noise = tex;

		// Sky-view LUT
		this.lut = new THREE.WebGLRenderTarget(LUT_W, LUT_H, {
			type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
			wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, generateMipmaps: false,
		});
		const P = atmosphereParams(0.15);
		this.lutMat = new THREE.ShaderMaterial({
			uniforms: {
				lightEl: { value: 0.5 },
				mieExt: { value: P.mieExt }, mieScat: { value: P.mieScat }, mieG: { value: P.mieG }, msAmount: { value: P.ms },
			},
			vertexShader: FULLSCREEN_VERT, fragmentShader: LUT_FRAG, depthTest: false, depthWrite: false,
		});
		this.lutScene = new THREE.Scene();
		const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.lutMat);
		quad.frustumCulled = false;
		this.lutScene.add(quad);
		this.lutCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
		this.lutState = { el: NaN, aod: NaN };

		const v3 = () => ({ value: new THREE.Vector3() });
		const c3 = () => ({ value: new THREE.Color(0, 0, 0) });
		this.uniforms = {
			tLut: { value: this.lut.texture },
			tNoise: { value: tex },
			lutLight: { value: new THREE.Vector3(1, 0.5, 0).normalize() },
			lutScale: { value: 1 },
			sunDir: v3(), moonDir: v3(), cloudLightDir: v3(),
			sunDisc: c3(), moonDisc: c3(), cloudSun: c3(), cloudAmbient: c3(), nightSky: c3(), cityGlow: c3(), groundColor: c3(),
			viewOrigin: v3(),
			discs: { value: 1 },
			moonCos: { value: Math.cos(0.0075) },
			cloudShape: { value: new THREE.Vector4(0.6, 0, 0, 6) },
			cloudWind: { value: new THREE.Vector4() },
			cirrusRot: { value: new THREE.Vector2(1, 0) },
		};
		this.material = new THREE.ShaderMaterial({
			uniforms: this.uniforms, vertexShader: DOME_VERT, fragmentShader: DOME_FRAG,
			side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
		});
		const geo = new THREE.SphereGeometry(2400, 48, 24);
		this.mesh = new THREE.Mesh(geo, this.material);
		this.mesh.frustumCulled = false;
		this.mesh.renderOrder = 1e6; // last among opaque objects: only sky pixels get shaded
		this.mesh.name = 'skydome';
		this.mesh.onBeforeRender = (r, s, cam) => { this.mesh.position.copy(cam.position); this.mesh.updateMatrixWorld(); };

		// Environment scene (PMREM source): the same material, no discs.
		this.envScene = new THREE.Scene();
		const envMesh = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), this.material);
		envMesh.frustumCulled = false;
		this.envScene.add(envMesh);

		// Stars
		const pos = [], col = [], mag = [];
		for (const [ra, dec, m, bv] of STARS) {
			pos.push(...equatorialVector(ra, dec));
			col.push(...starColour(bv));
			mag.push(m);
		}
		const sg = new THREE.BufferGeometry();
		sg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
		sg.setAttribute('starCol', new THREE.Float32BufferAttribute(col, 3));
		sg.setAttribute('mag', new THREE.Float32BufferAttribute(mag, 1));
		this.starUniforms = {
			eqToWorld: { value: new THREE.Matrix3() },
			starVis: { value: 0 },
			pixelRatio: { value: renderer.getPixelRatio() },
			time: { value: 0 },
			viewOrigin: this.uniforms.viewOrigin,
			tNoise: this.uniforms.tNoise,
			cloudShape: this.uniforms.cloudShape,
			cloudWind: this.uniforms.cloudWind,
			cirrusRot: this.uniforms.cirrusRot,
		};
		this.stars = new THREE.Points(sg, new THREE.ShaderMaterial({
			uniforms: this.starUniforms, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
			transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false,
		}));
		this.stars.frustumCulled = false;
		this.stars.renderOrder = 1e6;
		this.stars.name = 'stars';
	}

	/** Re-renders the sky-view LUT for a light at elevation el (radians) when it changed noticeably. */
	renderLut(renderer, el, aod) {
		if (Math.abs(el - this.lutState.el) < 0.0035 && Math.abs(aod - this.lutState.aod) < 0.004) return false;
		this.lutState.el = el;
		this.lutState.aod = aod;
		const P = atmosphereParams(aod);
		const u = this.lutMat.uniforms;
		u.lightEl.value = el;
		u.mieExt.value = P.mieExt; u.mieScat.value = P.mieScat; u.mieG.value = P.mieG; u.msAmount.value = P.ms;
		const prev = renderer.getRenderTarget();
		renderer.setRenderTarget(this.lut);
		renderer.render(this.lutScene, this.lutCam);
		renderer.setRenderTarget(prev);
		return true;
	}
}
