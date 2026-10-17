// Sky, sun, moon, stars, clouds, haze and the whole outdoor lighting, driven by the real sun and moon
// over Budapest and by the day's weather (seeded by the date, so every day is different).
//
//   const sky = new Sky(scene, renderer);
//   const st = sky.update(unix, camera.position);   // every street frame
//   st = { sunEl, moonEl, night, day, golden, illumination, exposure, cloudCover, sunDim }
//
// The pieces: render/atmosphere.js (Rayleigh + Mie sky model, weather), render/skydome.js (sky LUT,
// dome with sun/moon/clouds, stars), render/chunks.js (height haze coloured by the sky, cascaded
// sun shadows). The renderer's exposure lives in render/pipeline.js; it reads st.exposure.
import * as THREE from './vendor/three.module.min.js';
import { sunPosition, moonPosition } from './astro.js';
import { ORIGIN } from './geo.js';
import { CONFIG } from './config.js';
import {
	atmosphereParams, skyRadiance, twilightGain, sunTransmittance, weatherAt, localSiderealTime, equatorialToWorld, smoothstep,
} from './render/atmosphere.js';
import { noiseSampler, coverageThreshold, lowCloudJS, CLOUD_LOW_H, LOW_TILE, HIGH_TILE } from './render/clouds.js';
import { SkyDome } from './render/skydome.js';
import { setFogAtmosphere } from './render/chunks.js';

const smooth = smoothstep;
const D2R = Math.PI / 180;

/** Scene irradiance of the sun above the atmosphere (scene units; ~3.2 reaches the street at noon). */
export const SUN_E = 4.6;

/** Direction to a sky body in world space (+x east, +y up, +z south). */
export function skyDirection(azimuthDeg, elevationDeg) {
	const az = azimuthDeg * D2R, el = elevationDeg * D2R;
	return new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
}

/**
 * Exposure the eye settles at for a given horizontal illuminance (scene units): partial adaptation,
 * so overcast days and nights look darker than noon but stay readable.
 */
export function adaptedExposure(illuminance) {
	const e = Math.max(illuminance, 1e-3);
	return Math.min(3.6, Math.max(1.35, 1.35 * Math.pow(2.6 / e, 0.42)));
}

const tmpC = new THREE.Color();
// scratch objects (no allocations per frame)
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _p = new THREE.Vector3(), _fwd = new THREE.Vector3(), _c1 = new THREE.Vector3();
const _amb = new THREE.Color(), _tint = new THREE.Color(), _white = new THREE.Color(1, 1, 1), _gnd = new THREE.Color(0.32, 0.25, 0.2), _zen = new THREE.Color();
const col = (a, k = 1) => tmpC.setRGB(a[0] * k, a[1] * k, a[2] * k);

export class Sky {
	constructor(scene, renderer) {
		this.scene = scene;
		this.renderer = renderer;
		this.quality = CONFIG.quality || 'high';
		this.dome = new SkyDome(renderer);
		this.uniforms = this.dome.uniforms;
		scene.add(this.dome.mesh, this.dome.stars);
		this.sampler = noiseSampler(this.dome.noiseData);

		// Sun: on high two shadow cascades (near: sharp, 72 m across, every frame; far: 520 m, every
		// third frame). render/chunks.js blends them; the far light adds no light of its own.
		const cascades = this.quality === 'high';
		this.sun = new THREE.DirectionalLight(0xffffff, 3);
		this.sun.castShadow = true;
		this.sun.shadow.mapSize.set(2048, 2048);
		this.nearHalf = cascades ? 36 : 110;
		this.setupShadow(this.sun, this.nearHalf, cascades ? 0.02 : 0.08);
		scene.add(this.sun, this.sun.target);
		this.sunFar = null;
		if (cascades) {
			this.sunFar = new THREE.DirectionalLight(0xffffff, 0);
			this.sunFar.castShadow = true;
			this.sunFar.shadow.mapSize.set(2048, 2048);
			this.setupShadow(this.sunFar, 260, 0.22);
			this.sunFar.shadow.autoUpdate = false;
			scene.add(this.sunFar, this.sunFar.target);
		}
		this.moon = new THREE.DirectionalLight(0x9db4ff, 0);
		scene.add(this.moon, this.moon.target);
		// Ambient fill: bounce light by day, the city's own glow by night (scene.environment does the sky).
		this.hemi = new THREE.HemisphereLight(0xbfd6ff, 0x5a5048, 0.3);
		scene.add(this.hemi);
		scene.fog = new THREE.FogExp2(0xaabbcc, 0.0003);

		this.pmrem = new THREE.PMREMGenerator(renderer);
		this.envRT = null;
		this.env = { dir: new THREE.Vector3(0, -1, 0), unix: -1e9, real: -1e9, cover: -1 };
		this.cloud = { thr: 0.6, cover: -1, stratus: -1, real: -1e9, sunDim: 0, init: false };
		this.probe = null;
		this.frameNo = 0;
		this.lastCamera = null;
		this.dome.mesh.onBeforeRender = (r, s, cam) => {
			this.lastCamera = cam;
			this.dome.mesh.position.copy(cam.position);
			this.dome.mesh.updateMatrixWorld();
		};
		this.state = { sunEl: 0, moonEl: 0, night: 0, illumination: 0, golden: 0, day: 1, exposure: 1.5, cloudCover: 0, sunDim: 0 };
	}

	setupShadow(light, half, normalBias) {
		const sc = light.shadow.camera;
		sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
		sc.near = 1; sc.far = 1800;
		sc.updateProjectionMatrix();
		light.shadow.bias = -0.0002;
		light.shadow.normalBias = normalBias;
		light.userData.half = half;
	}

	/** Places a shadow camera over `center`, snapped to whole shadow-map texels (no shimmering). */
	fitShadow(light, center, dir) {
		const half = light.userData.half;
		const texel = (2 * half) / light.shadow.mapSize.x;
		const z = dir;
		const x = _x.set(z.z, 0, -z.x); // up x dir
		if (x.lengthSq() < 1e-6) x.set(1, 0, 0);
		x.normalize();
		const y = _y.crossVectors(z, x);
		const cx = Math.round(center.dot(x) / texel) * texel, cy = Math.round(center.dot(y) / texel) * texel, cz = center.dot(z);
		const p = _p.copy(x).multiplyScalar(cx).addScaledVector(y, cy).addScaledVector(z, cz);
		light.target.position.copy(p);
		light.position.copy(p).addScaledVector(dir, 900);
		light.target.updateMatrixWorld();
		light.updateMatrixWorld();
	}

	/** The day's clouds: coverage threshold (a noise quantile), wind offsets, cirrus. */
	updateClouds(unix, w, now) {
		const c = this.cloud;
		if (!c.init || Math.abs(w.coverage - c.cover) > 0.01 || Math.abs(w.stratus - c.stratus) > 0.03) {
			if (!c.init || now - c.real > 5000) {
				c.thr = coverageThreshold(this.sampler, w.coverage, w.stratus);
				c.cover = w.coverage; c.stratus = w.stratus; c.real = now; c.init = true;
			}
		}
		const u = this.uniforms;
		u.cloudShape.value.set(c.thr, w.stratus, w.cirrus, 3.5 + 3 * (1 - w.stratus));
		const pl = LOW_TILE * 100, ph = HIGH_TILE * 100;
		const dl = (w.windSpeed * unix) % pl, dh = (w.cirrusSpeed * unix) % ph;
		// wind blows *towards* windDir: the pattern moves that way, so sample against it
		u.cloudWind.value.set(-Math.sin(w.windDir) * dl, Math.cos(w.windDir) * dl, -Math.sin(w.cirrusDir) * dh, Math.cos(w.cirrusDir) * dh);
		u.cirrusRot.value.set(Math.cos(w.cirrusDir), Math.sin(w.cirrusDir));
	}

	/** Sky colour probes from the JS twin of the LUT model (only when the light moved). */
	probes(el, aod) {
		const p = this.probe;
		if (p && Math.abs(p.el - el) < 0.2 && Math.abs(p.aod - aod) < 0.004) return p;
		const P = atmosphereParams(aod);
		const s = [Math.cos(el * D2R), Math.sin(el * D2R), 0];
		const h = 0.06, ch = Math.cos(h), sh = Math.sin(h);
		const R = (d) => skyRadiance(d, s, P, 16, 6);
		const up30 = [Math.cos(0.5) * 0.7071, Math.sin(0.5), Math.cos(0.5) * 0.7071];
		this.probe = {
			el, aod,
			zenith: R([0, 1, 0]),
			to: R([ch, sh, 0]),
			away: R([-ch, sh, 0]),
			side: R([0, sh, ch]),
			mid: R(up30),
		};
		return this.probe;
	}

	/** Update everything for the given Unix time, centred on the player position. */
	update(unix, center) {
		const now = performance.now();
		this.frameNo++;
		const sp = sunPosition(unix, ORIGIN.lat, ORIGIN.lon);
		const mp = moonPosition(unix, ORIGIN.lat, ORIGIN.lon);
		const sunDir = skyDirection(sp.azimuth, sp.elevation);
		const moonDir = skyDirection(mp.azimuth, mp.elevation);
		const el = sp.elevation;
		const day = smooth(-4, 8, el);
		const golden = smooth(-6, 2, el) * (1 - smooth(4, 18, el));
		const night = 1 - smooth(-12, -2, el);
		const w = weatherAt(unix);
		const aod = w.aod;
		const u = this.uniforms;

		// --- clouds and the sky LUT
		this.updateClouds(unix, w, now);
		u.viewOrigin.value.set(center.x, 0, center.z);
		const useSun = el > -11 || mp.elevation < 0;
		const lutEl = useSun ? el : mp.elevation;
		this.dome.renderLut(this.renderer, lutEl * D2R, aod);
		u.lutLight.value.copy(useSun ? sunDir : moonDir);
		const moonUp = smooth(-1, 6, mp.elevation);
		u.lutScale.value = useSun ? SUN_E * twilightGain(el) : SUN_E * 0.01 * mp.illumination * moonUp;
		const pr = this.probes(lutEl, aod);
		const scale = u.lutScale.value;
		const avg = (k) => (pr.to[k] + pr.away[k] + 2 * pr.side[k]) * 0.25 * scale;
		const skyAvg = [avg(0), avg(1), avg(2)];
		const coverage = w.coverage;

		// --- the sun through the atmosphere, dimmed by the cloud passing in front of it right now
		const T = sunTransmittance(el, aod);
		let dim = 0;
		if (sunDir.y > 0.02) {
			const k = CLOUD_LOW_H / sunDir.y;
			const wd = u.cloudWind.value;
			dim = lowCloudJS(this.sampler, center.x + sunDir.x * k, center.z + sunDir.z * k,
				{ threshold: this.cloud.thr, stratus: w.stratus, sharp: u.cloudShape.value.w }, [wd.x, wd.y]);
		}
		this.cloud.sunDim += (dim - this.cloud.sunDim) * Math.min(1, 0.05 + (this.frameNo < 3 ? 1 : 0));
		const sunDim = this.cloud.sunDim;
		const sunK = SUN_E * (1 - 0.82 * smooth(0.05, 0.7, sunDim));
		this.sun.color.setRGB(T[0], T[1], T[2]);
		const tl = 0.2126 * T[0] + 0.7152 * T[1] + 0.0722 * T[2];
		this.sun.intensity = sunK;
		const shadows = tl > 0.004;
		const camFwd = _fwd.set(0, 0, -1);
		if (this.lastCamera) { this.lastCamera.getWorldDirection(camFwd); camFwd.y = 0; if (camFwd.lengthSq() > 1e-6) camFwd.normalize(); }
		const nearCenter = _c1.set(center.x, 0, center.z).addScaledVector(camFwd, this.nearHalf * 0.45);
		this.fitShadow(this.sun, nearCenter, sunDir);
		this.sun.shadow.autoUpdate = shadows;
		if (this.sunFar) {
			this.fitShadow(this.sunFar, _c1.set(center.x, 0, center.z).addScaledVector(camFwd, 90), sunDir);
			this.sunFar.shadow.needsUpdate = shadows && (this.frameNo % 3 === 1 || this.frameNo < 4);
		}

		// --- moon light (no shadows)
		this.moon.intensity = 0.06 * mp.illumination * moonUp * night;
		this.moon.position.copy(center).addScaledVector(moonDir, 400);
		this.moon.target.position.copy(center);

		// --- dome uniforms
		u.sunDir.value.copy(sunDir);
		u.moonDir.value.copy(moonDir);
		const discK = SUN_E * 26 * (1 - smooth(0.2, 0.9, sunDim));
		u.sunDisc.value.setRGB(T[0] * discK, T[1] * discK, T[2] * discK);
		const mk = (0.25 + 0.4 * night) * smooth(-2, 1, mp.elevation);
		u.moonDisc.value.setRGB(0.95 * mk, 0.93 * mk, 0.88 * mk);
		// clouds keep the sun ~1.3 deg longer than the street (they are 1.6 km up)
		const Tc = sunTransmittance(el + 1.3, aod);
		const cl = SUN_E * (useSun ? 1 : 0);
		const ml = 0.05 * mp.illumination * moonUp * night;
		u.cloudSun.value.setRGB(Tc[0] * cl + ml, Tc[1] * cl + ml, Tc[2] * cl + ml * 1.05);
		u.cirrusVis.value = 1 - 0.75 * night;
		u.cloudLightDir.value.copy(el > -4 || mp.elevation < 0 ? sunDir : moonDir);
		// night sky: deep blue zenith and the orange-grey glow of the city's lights
		const nk = night;
		u.nightSky.value.setRGB(0.0022 * nk, 0.0032 * nk, 0.0068 * nk);
		u.cityGlow.value.setRGB(0.026 * nk, 0.018 * nk, 0.0125 * nk);
		const cityOnClouds = [0.03 * nk, 0.0215 * nk, 0.0155 * nk];
		const zen = pr.zenith;
		u.cloudAmbient.value.setRGB(
			(zen[0] * 0.5 + skyAvg[0] / scale * 0.5) * scale * 1.3 + cityOnClouds[0],
			(zen[1] * 0.5 + skyAvg[1] / scale * 0.5) * scale * 1.3 + cityOnClouds[1],
			(zen[2] * 0.5 + skyAvg[2] / scale * 0.5) * scale * 1.3 + cityOnClouds[2]);
		// ground seen from above (for the environment map): pavement albedo ~0.12
		const eh = sunK * tl * Math.max(0, sunDir.y) + Math.PI * (skyAvg[1] + 0.03 * nk);
		const g = (0.12 * eh) / Math.PI;
		u.groundColor.value.setRGB(g * 1.05, g, g * 0.92);

		// --- stars
		const lst = localSiderealTime(unix, ORIGIN.lon);
		this.dome.starUniforms.eqToWorld.value.fromArray(equatorialToWorld(lst, ORIGIN.lat));
		this.dome.starUniforms.starVis.value = night * night * (1 - 0.55 * mp.illumination * moonUp);
		this.dome.starUniforms.time.value = (now / 1000) % 1000;
		this.dome.starUniforms.pixelRatio.value = this.renderer.getPixelRatio();

		// --- ambient fill
		const cityAmb = _amb.setRGB(0.55, 0.5, 0.5);
		const skyTint = _tint.setRGB(skyAvg[0], skyAvg[1], skyAvg[2]);
		const st = skyTint.r + skyTint.g + skyTint.b;
		if (st > 1e-5) skyTint.multiplyScalar(3 / st); else skyTint.setRGB(1, 1, 1);
		this.hemi.color.copy(cityAmb).lerp(skyTint.lerp(_white, 0.5), day);
		this.hemi.groundColor.setRGB(0.42, 0.36, 0.3).lerp(_gnd, night);
		this.hemi.intensity = 0.1 + 0.14 * day * (1 - 0.5 * coverage) + 0.27 * night;

		// --- haze (aerial perspective): the horizon sky colour, glowing towards the sun
		const fog = this.scene.fog;
		const fogC = [skyAvg[0] + 0.022 * nk, skyAvg[1] + 0.016 * nk, skyAvg[2] + 0.012 * nk];
		fog.color.setRGB(fogC[0], fogC[1], fogC[2]);
		const beta = (aod / 1.2 + 0.0134) * 1.9e-3 * (1 + 0.25 * night + 0.6 * w.stratus * coverage);
		fog.density = beta;
		const sunGlow = Math.max(0, 1 - sunDim * 0.8);
		setFogAtmosphere({
			sunDir,
			sunGlow,
			sunColor: col([Math.max(0, pr.to[0] * scale - fogC[0]), Math.max(0, pr.to[1] * scale - fogC[1]), Math.max(0, pr.to[2] * scale - fogC[2])]),
			zenith: _zen.setRGB(pr.mid[0] * scale + 0.004 * nk, pr.mid[1] * scale + 0.005 * nk, pr.mid[2] * scale + 0.008 * nk),
			falloff: 1 / 900,
			baseHeight: 0,
			maxOpacity: 1,
		});

		// --- environment map (PMREM of the sky), regenerated when the sky changed, never every frame
		const env = this.env;
		const moved = env.dir.angleTo(sunDir) > 1 * D2R || Math.abs(coverage - env.cover) > 0.03 || Math.abs(unix - env.unix) > 240;
		if ((moved && now - env.real > 1500) || !this.envRT) {
			env.dir.copy(sunDir); env.unix = unix; env.real = now; env.cover = coverage;
			u.discs.value = 0;
			const rt = this.pmrem.fromScene(this.dome.envScene, 0, 0.1, 100);
			u.discs.value = 1;
			if (this.envRT) this.envRT.dispose();
			this.envRT = rt;
			this.scene.environment = rt.texture;
		}
		this.scene.environmentIntensity = 0.85;

		// --- exposure target for the pipeline's eye adaptation
		const illum = eh + 0.06 * nk + ml * 0.5;
		const exposure = adaptedExposure(illum);

		this.state = { sunEl: el, moonEl: mp.elevation, night, illumination: mp.illumination, golden, day, exposure, cloudCover: coverage, sunDim };
		return this.state;
	}
}
