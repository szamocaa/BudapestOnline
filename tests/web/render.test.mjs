// Unit tests for the render area's pure logic: atmosphere model, weather, clouds, stars, quality tiers.
import assert from 'node:assert/strict';
import {
	airMass, sunTransmittance, skyRadiance, atmosphereParams, weatherAt, dayWeather, skyViewUV, skyViewDir,
	equatorialToWorld, localSiderealTime, twilightGain,
} from '../../game/render/atmosphere.js';
import { makeCloudNoise, noiseSampler, coverageThreshold, lowCloudJS } from '../../game/render/clouds.js';
import { STARS, starColour, equatorialVector } from '../../game/render/stars.js';
import { classifyGpu, whiteBalance, TIERS } from '../../game/render/pipeline.js';
import { adaptedExposure } from '../../game/sky.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

// --- direct sunlight
near(airMass(90), 1, 0.01, 'air mass at zenith');
assert.ok(airMass(0) > 30 && airMass(0) <= 40, 'air mass at the horizon ~38');
const tNoon = sunTransmittance(60, 0.12), tLow = sunTransmittance(3, 0.12);
assert.ok(tNoon[0] > tLow[0] && tNoon[2] > tLow[2], 'more light at noon');
assert.ok(tLow[2] / tLow[0] < tNoon[2] / tNoon[0], 'low sun is redder');
assert.deepEqual(sunTransmittance(-3, 0.12), [0, 0, 0], 'no direct sun below the horizon');
assert.ok(tNoon.every((v) => v > 0 && v < 1), 'transmittance in (0, 1)');

// --- sky radiance: blue zenith by day, warm horizon towards a setting sun
const P = atmosphereParams(0.12);
const e40 = (40 * Math.PI) / 180;
const zen = skyRadiance([0, 1, 0], [Math.cos(e40), Math.sin(e40), 0], P);
assert.ok(zen[2] > zen[1] && zen[1] > zen[0], 'zenith is blue');
const e2 = (2 * Math.PI) / 180;
const toSun = skyRadiance([Math.cos(0.05), Math.sin(0.05), 0], [Math.cos(e2), Math.sin(e2), 0], P);
assert.ok(toSun[0] > toSun[2], 'sunset horizon is warm');
assert.ok(twilightGain(0) === 1 && twilightGain(-6) > 1, 'twilight lift');

// --- sky-view LUT parameterisation round trip
for (const [u, v] of [[0.1, 0.8], [0.5, 0.55], [0.9, 0.3], [0.3, 0.97]]) {
	const { dir, light } = skyViewDir(u, v, 0.3);
	const [u2, v2] = skyViewUV(dir, light);
	near(u2, u, 1e-6, 'lut u'); near(v2, v, 1e-6, 'lut v');
}

// --- weather: deterministic, sane, different from day to day
const d0 = dayWeather(20735);
assert.deepEqual(d0, dayWeather(20735), 'weather is seeded by the date');
const covers = new Set();
for (let d = 20700; d < 20760; d++) {
	const w = dayWeather(d);
	assert.ok(w.coverage >= 0.1 && w.coverage <= 0.85, 'coverage range');
	assert.ok(w.aod >= 0.05 && w.aod <= 0.3, 'aerosol range');
	covers.add(w.coverage.toFixed(2));
}
assert.ok(covers.size > 30, 'days differ');
const unix = Date.UTC(2026, 9, 9, 8, 30) / 1000;
const wa = weatherAt(unix), wb = weatherAt(unix + 60);
near(wa.coverage, wb.coverage, 0.01, 'weather changes smoothly');

// --- clouds: the coverage threshold leaves the requested share of sky covered
const noise = makeCloudNoise(64, 7);
assert.equal(noise.length, 64 * 64 * 4);
const sample = noiseSampler(noise, 64);
for (const cov of [0.2, 0.5, 0.8]) {
	const thr = coverageThreshold(sample, cov, 0.2);
	let covered = 0, n = 0;
	for (let i = 0; i < 40; i++) for (let j = 0; j < 40; j++, n++) {
		if (lowCloudJS(sample, i * 351.7, j * 351.7, { threshold: thr, stratus: 0.2, sharp: 6 }, [0, 0]) > 0) covered++;
	}
	near(covered / n, cov, 0.12, `coverage ${cov}`);
}

// --- stars: Polaris stands due north at the latitude's height; the matrix is a rotation
const lat = 47.4925, lst = localSiderealTime(unix, 19.08);
const m = equatorialToWorld(lst, lat);
const apply = (v) => [0, 1, 2].map((r) => m[r] * v[0] + m[3 + r] * v[1] + m[6 + r] * v[2]);
const polaris = apply(equatorialVector(2.53, 89.26));
near(Math.asin(polaris[1]) * 180 / Math.PI, lat, 1.0, 'Polaris elevation');
assert.ok(polaris[2] < -0.6, 'Polaris is north (-z)');
for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) near(Math.hypot(...apply(v)), 1, 1e-9, 'rotation keeps length');
const betelgeuse = starColour(1.85), rigel = starColour(-0.03);
assert.ok(betelgeuse[2] / betelgeuse[0] < rigel[2] / rigel[0], 'Betelgeuse is redder than Rigel');
assert.ok(STARS.length > 100 && STARS.every((s) => s[2] < 3.7), 'bright stars only (light pollution)');

// --- quality tiers and the camera
assert.equal(classifyGpu('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'), 'high');
assert.equal(classifyGpu('Apple GPU'), 'high');
assert.equal(classifyGpu('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)'), 'high');
assert.equal(classifyGpu('ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)'), 'medium');
assert.equal(classifyGpu('Google SwiftShader'), 'low');
assert.equal(classifyGpu('Adreno (TM) 610', { mobile: true }), 'low');
assert.equal(classifyGpu('Google SwiftShader', { webdriver: true }), 'high');
assert.ok(TIERS.high.ao && !TIERS.medium.ao && !TIERS.low.post, 'tiers');
const wbv = whiteBalance(1), tr = sunTransmittance(35, 0.12);
near(wbv.x * tr[0], wbv.z * tr[2], 1e-9, 'white balance neutralises daylight');
assert.ok(adaptedExposure(2.6) < adaptedExposure(0.5) && adaptedExposure(0.5) < adaptedExposure(0.01), 'darker scene, higher exposure');
assert.ok(adaptedExposure(1e-6) <= 5.2 && adaptedExposure(100) >= 1.35, 'exposure clamped');

console.log('render tests passed');
