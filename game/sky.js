// Sky, sun, moon, stars, fog and lighting driven by the real sun/moon position over Budapest.
import * as THREE from './vendor/three.module.min.js';
import { sunPosition, moonPosition } from './astro.js';
import { ORIGIN, rng } from './geo.js';

const smooth = (a, b, x) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

/** Direction to a sky body in world space (+x east, +y up, +z south). */
export function skyDirection(azimuthDeg, elevationDeg) {
	const az = (azimuthDeg * Math.PI) / 180, el = (elevationDeg * Math.PI) / 180;
	return new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
}

export class Sky {
	constructor(scene, renderer) {
		this.scene = scene;
		this.renderer = renderer;
		this.uniforms = {
			sunDir: { value: new THREE.Vector3(0, 1, 0) },
			moonDir: { value: new THREE.Vector3(0, -1, 0) },
			zenith: { value: new THREE.Color() },
			horizon: { value: new THREE.Color() },
			glow: { value: new THREE.Color() },
			sunVis: { value: 1 },
			moonVis: { value: 0 },
			moonPhase: { value: 1 },
		};
		const dome = new THREE.Mesh(
			new THREE.SphereGeometry(2400, 48, 24),
			new THREE.ShaderMaterial({
				uniforms: this.uniforms,
				side: THREE.BackSide,
				depthWrite: false,
				fog: false,
				vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }`,
				fragmentShader: `
					uniform vec3 sunDir, moonDir, zenith, horizon, glow; uniform float sunVis, moonVis, moonPhase; varying vec3 vDir;
					void main(){
						vec3 d = normalize(vDir);
						float h = max(d.y, 0.0);
						vec3 col = mix(horizon, zenith, pow(h, 0.55));
						float sd = max(dot(d, sunDir), 0.0);
						col += glow * pow(sd, 6.0) * 0.55 * sunVis;
						col += vec3(1.0, 0.92, 0.75) * smoothstep(0.9993, 0.9997, sd) * 6.0 * sunVis;
						float md = max(dot(d, moonDir), 0.0);
						col += vec3(0.85, 0.88, 0.95) * smoothstep(0.99955, 0.99975, md) * (0.4 + 1.6 * moonPhase) * moonVis;
						col += vec3(0.5, 0.55, 0.7) * pow(md, 80.0) * 0.12 * moonVis * moonPhase;
						if (d.y < 0.0) col = mix(horizon, horizon * 0.45, min(-d.y * 4.0, 1.0));
						gl_FragColor = vec4(col, 1.0);
						#include <tonemapping_fragment>
						#include <colorspace_fragment>
					}`,
			}),
		);
		dome.frustumCulled = false;
		dome.renderOrder = -1;
		scene.add(dome);
		this.dome = dome;

		// Stars (dimmed by Budapest's light pollution).
		const r = rng(12);
		const starPos = [];
		for (let i = 0; i < 1400; i++) {
			const u = r() * 2 - 1, th = r() * Math.PI * 2;
			const y = Math.abs(u) * 0.95 + 0.05;
			const s = Math.sqrt(1 - y * y);
			starPos.push(Math.cos(th) * s * 2200, y * 2200, Math.sin(th) * s * 2200);
		}
		const sg = new THREE.BufferGeometry();
		sg.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
		this.starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false });
		this.stars = new THREE.Points(sg, this.starMat);
		this.stars.frustumCulled = false;
		scene.add(this.stars);

		this.sun = new THREE.DirectionalLight(0xffffff, 3);
		this.sun.castShadow = true;
		this.sun.shadow.mapSize.set(2048, 2048);
		const sc = this.sun.shadow.camera;
		sc.left = -110; sc.right = 110; sc.top = 110; sc.bottom = -110; sc.near = 1; sc.far = 900;
		this.sun.shadow.bias = -0.0004;
		this.sun.shadow.normalBias = 0.6;
		scene.add(this.sun, this.sun.target);

		this.moon = new THREE.DirectionalLight(0x9db4ff, 0);
		scene.add(this.moon, this.moon.target);
		this.hemi = new THREE.HemisphereLight(0xbfd6ff, 0x5a5048, 1);
		scene.add(this.hemi);
		scene.fog = new THREE.Fog(0xaaccee, 120, 1400);

		this.state = { sunEl: 0, moonEl: 0, night: 0, illumination: 0 };
	}

	/** Update everything for the given Unix time, centred on the player position. */
	update(unix, center) {
		const sp = sunPosition(unix, ORIGIN.lat, ORIGIN.lon);
		const mp = moonPosition(unix, ORIGIN.lat, ORIGIN.lon);
		const sunDir = skyDirection(sp.azimuth, sp.elevation);
		const moonDir = skyDirection(mp.azimuth, mp.elevation);
		const el = sp.elevation;
		const day = smooth(-4, 8, el);
		const golden = smooth(-6, 2, el) * (1 - smooth(4, 18, el));
		const night = 1 - smooth(-12, -2, el);

		const u = this.uniforms;
		u.sunDir.value.copy(sunDir);
		u.moonDir.value.copy(moonDir);
		u.sunVis.value = smooth(-3, 1, el);
		u.moonVis.value = smooth(-3, 2, mp.elevation) * (1 - day * 0.85);
		u.moonPhase.value = mp.illumination;

		const zDay = new THREE.Color(0x2f6fc4), hDay = new THREE.Color(0xa6c8e6);
		const zDusk = new THREE.Color(0x2b3a66), hDusk = new THREE.Color(0xf09a5c);
		// Night: deep blue with an orange city glow along the horizon.
		const zNight = new THREE.Color(0x03060f), hNight = new THREE.Color(0x2a2224);
		const z = zNight.clone().lerp(zDusk, smooth(-14, -2, el)).lerp(zDay, day);
		const h = hNight.clone().lerp(hDusk, smooth(-12, -1, el)).lerp(hDay, day);
		u.zenith.value.copy(z);
		u.horizon.value.copy(h.clone().lerp(new THREE.Color(0xff8a4a), golden * 0.5));
		u.glow.value.set(0xffd9a8).lerp(new THREE.Color(0xff7a3a), golden);

		this.starMat.opacity = night * 0.75 * (1 - mp.illumination * 0.4);

		// Sun light: follows the player so shadows stay sharp where you are.
		const sunUp = smooth(-2, 6, el);
		this.sun.intensity = 3.1 * sunUp;
		this.sun.color.set(0xffffff).lerp(new THREE.Color(0xffa860), golden * 0.8);
		this.sun.position.copy(center).addScaledVector(sunDir, 400);
		this.sun.target.position.copy(center);
		this.sun.castShadow = sunUp > 0.02;
		const moonUp = smooth(-1, 8, mp.elevation);
		this.moon.intensity = 0.35 * mp.illumination * moonUp * night;
		this.moon.position.copy(center).addScaledVector(moonDir, 400);
		this.moon.target.position.copy(center);

		// Ambient: daylight sky by day; at night a dim blue sky plus the orange glow of the city's lights
		// (Budapest is never pitch dark), so streets stay readable.
		const nightAmbient = new THREE.Color(0x4a5470).lerp(new THREE.Color(0x6b5440), 0.35);
		this.hemi.color.copy(nightAmbient).lerp(z.clone().lerp(new THREE.Color(0xffffff), 0.35), day);
		this.hemi.groundColor.set(0x4a4038).lerp(new THREE.Color(0x2e2620), night);
		this.hemi.intensity = 0.75 + 0.75 * day + 0.25 * golden;

		this.scene.fog.color.copy(h).lerp(z, 0.25);
		this.scene.fog.near = 60 + 100 * day;
		this.scene.fog.far = 700 + 900 * day;
		// Eyes adapt: brighter exposure at night so streets stay readable.
		this.renderer.toneMappingExposure = 0.95 + night * 0.75;

		this.dome.position.copy(center);
		this.stars.position.copy(center);
		this.state = { sunEl: el, moonEl: mp.elevation, night, illumination: mp.illumination, golden, day };
		return this.state;
	}
}
