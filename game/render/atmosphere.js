// Physically based sky over Budapest: Rayleigh + Mie (urban haze) + ozone, single scattering with a
// multiple-scattering approximation, after Hillaire (2020) "A scalable and production ready sky and
// atmosphere rendering technique". The same model exists twice:
//   * in JavaScript (skyRadiance, transmittance): the few colours the CPU needs (sun and moon light
//     colour, fog/haze colours, cloud lighting, ambient), and the unit tests;
//   * in GLSL (ATMOSPHERE_GLSL): the sky-view lookup table rendered on the GPU (skydome.js).
// Units: kilometres, radiance per unit sun illuminance (scaled to scene units by the caller).
// Also here: the day-to-day weather (seeded by the date) and sidereal time for the stars.
import { budapestOffsetHours } from '../astro.js';
import { rng } from '../geo.js';

export const EARTH_R = 6360; // km
export const ATMO_R = 6460;
export const CAMERA_ALT = 0.15; // Budapest street level, km above sea level
const RAYLEIGH = [5.802e-3, 13.558e-3, 33.1e-3]; // scattering = extinction, 1/km at sea level
const OZONE = [0.65e-3, 1.881e-3, 0.085e-3]; // absorption, 1/km at the peak of the layer
const HR = 8.0, HM = 1.2; // scale heights (km)

/** Atmosphere parameters for a given aerosol optical depth (AOD at 550 nm: 0.05 clean … 0.4 smoggy). */
export function atmosphereParams(aod = 0.15) {
	const mieExt = aod / HM;
	return { rayleigh: RAYLEIGH, ozone: OZONE, mieExt, mieScat: mieExt * 0.9, mieG: 0.78, ms: 0.3 };
}

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const smoothstep = (a, b, x) => {
	const t = clamp((x - a) / (b - a), 0, 1);
	return t * t * (3 - 2 * t);
};

function raySphere(ox, oy, oz, dx, dy, dz, r) {
	const b = ox * dx + oy * dy + oz * dz;
	const c = ox * ox + oy * oy + oz * oz - r * r;
	const d = b * b - c;
	if (d < 0) return null;
	const s = Math.sqrt(d);
	return [-b - s, -b + s];
}

function densities(h) {
	return [Math.exp(-h / HR), Math.exp(-h / HM), Math.max(0, 1 - Math.abs(h - 25) / 15)];
}

/**
 * Transmittance from a point at altitude h (km) along direction (dx, dy, dz) (y up) to space.
 * Zero when the ray hits the ground.
 */
export function transmittance(h, dx, dy, dz, P, steps = 24) {
	const oy = EARTH_R + h;
	const g = raySphere(0, oy, 0, dx, dy, dz, EARTH_R);
	if (g && g[0] > 0) return [0, 0, 0];
	const a = raySphere(0, oy, 0, dx, dy, dz, ATMO_R);
	if (!a) return [1, 1, 1];
	const L = a[1], dt = L / steps;
	let r = 0, m = 0, o = 0;
	for (let i = 0; i < steps; i++) {
		const t = (i + 0.5) * dt;
		const px = dx * t, py = oy + dy * t, pz = dz * t;
		const hh = Math.hypot(px, py, pz) - EARTH_R;
		const d = densities(hh);
		r += d[0] * dt; m += d[1] * dt; o += d[2] * dt;
	}
	return [0, 1, 2].map((k) => Math.exp(-(P.rayleigh[k] * r + P.mieExt * m + P.ozone[k] * o)));
}

export function phaseRayleigh(c) {
	return (3 / (16 * Math.PI)) * (1 + c * c);
}
export function phaseMie(c, g) {
	const g2 = g * g;
	return ((3 / (8 * Math.PI)) * (1 - g2) * (1 + c * c)) / ((2 + g2) * Math.pow(1 + g2 - 2 * g * c, 1.5));
}

/**
 * Sky radiance seen from street level in direction dir (unit, y up) with the light source in
 * direction sun (unit), per unit illuminance of the source. Returns [r, g, b].
 */
export function skyRadiance(dir, sun, P, steps = 20, lightSteps = 8) {
	const [dx, dy, dz] = dir;
	const oy = EARTH_R + CAMERA_ALT;
	const a = raySphere(0, oy, 0, dx, dy, dz, ATMO_R);
	let tMax = a ? a[1] : 0;
	const g = raySphere(0, oy, 0, dx, dy, dz, EARTH_R);
	if (g && g[0] > 0) tMax = Math.min(tMax, g[0]);
	const c = dx * sun[0] + dy * sun[1] + dz * sun[2];
	const pr = phaseRayleigh(c), pm = phaseMie(c, P.mieG);
	const L = [0, 0, 0], T = [1, 1, 1];
	for (let i = 0; i < steps; i++) {
		const t0 = tMax * (i / steps) ** 2, t1 = tMax * ((i + 1) / steps) ** 2;
		const t = (t0 + t1) / 2, dt = t1 - t0;
		const px = dx * t, py = oy + dy * t, pz = dz * t;
		const r = Math.hypot(px, py, pz);
		const h = r - EARTH_R;
		const d = densities(h);
		// Transmittance towards the light from this point (local "up" is p / r).
		const ux = px / r, uy = py / r, uz = pz / r;
		const mu = ux * sun[0] + uy * sun[1] + uz * sun[2];
		const tsun = sunTransmittanceAt(h, mu, P, lightSteps);
		// Multiple scattering: light scattered down from the lit air above (keeps the earth's shadow
		// and twilight from going black).
		const tms = sunTransmittanceAt(h, Math.min(1, mu + MS_LIFT), P, lightSteps).map((v) => v * smoothstep(-0.25, 0, mu));
		const ms = P.ms / Math.PI;
		for (let k = 0; k < 3; k++) {
			const sR = P.rayleigh[k] * d[0], sM = P.mieScat * d[1];
			const ext = P.rayleigh[k] * d[0] + P.mieExt * d[1] + P.ozone[k] * d[2];
			const scat = (sR * pr + sM * pm) * tsun[k] + (sR + sM) * ms * tms[k];
			const tStep = Math.exp(-ext * dt);
			L[k] += (T[k] * (scat - scat * tStep)) / Math.max(ext, 1e-9);
			T[k] *= tStep;
		}
	}
	return L;
}

/** Light reaching altitude h when the source is at zenith cosine mu (earth shadow included). */
export function sunTransmittanceAt(h, mu, P, steps = 8) {
	return transmittance(h, Math.sqrt(Math.max(0, 1 - mu * mu)), mu, 0, P, steps);
}

const MS_LIFT = 0.12; // the multiple-scattered light behaves as if the source were ~7 deg higher

/**
 * Artistic gain on the sky after sunset: the eye adapts far more than any exposure we can use, so
 * twilight is lifted (x1 at sunset, ~x6 at -6 deg) until the city's own light takes over.
 */
export function twilightGain(sunElDeg) {
	return Math.exp(clamp(-sunElDeg, 0, 10) * 0.3);
}

// GLSL twin of skyRadiance (keep in sync). Used by the sky-view LUT pass in skydome.js.
const MS_LIFT_GLSL = MS_LIFT.toFixed(3);
export const ATMOSPHERE_GLSL = /* glsl */ `
const float EARTH_R = ${EARTH_R.toFixed(1)};
const float ATMO_R = ${ATMO_R.toFixed(1)};
const float CAMERA_ALT = ${CAMERA_ALT};
const vec3 RAYLEIGH = vec3(${RAYLEIGH.map((v) => v.toExponential(4)).join(', ')});
const vec3 OZONE = vec3(${OZONE.map((v) => v.toExponential(4)).join(', ')});
const float HR = ${HR.toFixed(1)};
const float HM = ${HM.toFixed(1)};
uniform float mieExt, mieScat, mieG, msAmount;

vec2 raySphere(vec3 o, vec3 d, float r) {
	float b = dot(o, d);
	float c = dot(o, o) - r * r;
	float q = b * b - c;
	if (q < 0.0) return vec2(-1.0, -1.0);
	q = sqrt(q);
	return vec2(-b - q, -b + q);
}
vec3 densities(float h) {
	return vec3(exp(-h / HR), exp(-h / HM), max(0.0, 1.0 - abs(h - 25.0) / 15.0));
}
vec3 transmittanceTo(float h, vec3 d) {
	vec3 o = vec3(0.0, EARTH_R + h, 0.0);
	vec2 g = raySphere(o, d, EARTH_R);
	if (g.x > 0.0) return vec3(0.0);
	vec2 a = raySphere(o, d, ATMO_R);
	float dt = a.y / 8.0;
	vec3 od = vec3(0.0);
	for (int i = 0; i < 8; i++) {
		vec3 p = o + d * ((float(i) + 0.5) * dt);
		od += densities(length(p) - EARTH_R) * dt;
	}
	return exp(-(RAYLEIGH * od.x + vec3(mieExt * od.y) + OZONE * od.z));
}
float phaseR(float c) { return 0.0596831 * (1.0 + c * c); }
float phaseM(float c, float g) {
	float g2 = g * g;
	return 0.1193662 * (1.0 - g2) * (1.0 + c * c) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * c, 1.5));
}
vec3 skyRadiance(vec3 d, vec3 s) {
	vec3 o = vec3(0.0, EARTH_R + CAMERA_ALT, 0.0);
	vec2 a = raySphere(o, d, ATMO_R);
	float tMax = a.y;
	vec2 g = raySphere(o, d, EARTH_R);
	if (g.x > 0.0) tMax = min(tMax, g.x);
	float c = dot(d, s);
	float pr = phaseR(c), pm = phaseM(c, mieG);
	vec3 L = vec3(0.0), T = vec3(1.0);
	const int STEPS = 20;
	for (int i = 0; i < STEPS; i++) {
		float f0 = float(i) / float(STEPS), f1 = float(i + 1) / float(STEPS);
		float t0 = tMax * f0 * f0, t1 = tMax * f1 * f1;
		float t = 0.5 * (t0 + t1), dt = t1 - t0;
		vec3 p = o + d * t;
		float r = length(p);
		float h = r - EARTH_R;
		vec3 dn = densities(h);
		float mu = dot(p / r, s);
		vec3 ld = vec3(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);
		vec3 ts = transmittanceTo(h, ld);
		float mul = min(1.0, mu + ${MS_LIFT_GLSL});
		vec3 tms = transmittanceTo(h, vec3(sqrt(max(0.0, 1.0 - mul * mul)), mul, 0.0)) * smoothstep(-0.25, 0.0, mu);
		vec3 sR = RAYLEIGH * dn.x;
		vec3 sM = vec3(mieScat * dn.y);
		vec3 ext = RAYLEIGH * dn.x + vec3(mieExt * dn.y) + OZONE * dn.z;
		vec3 scat = (sR * pr + sM * pm) * ts + (sR + sM) * (msAmount / 3.14159265) * tms;
		vec3 ts2 = exp(-ext * dt);
		L += T * (scat - scat * ts2) / max(ext, vec3(1e-9));
		T *= ts2;
	}
	return L;
}
`;

// ---------------------------------------------------------------- sky-view LUT parameterisation

/** LUT coordinates (both 0..1) for a view direction, relative to the light's azimuth. */
export function skyViewUV(dir, light) {
	const el = Math.asin(clamp(dir[1], -1, 1));
	const hl = Math.hypot(dir[0], dir[2]), sl = Math.hypot(light[0], light[2]);
	let c = hl > 1e-6 && sl > 1e-6 ? (dir[0] * light[0] + dir[2] * light[2]) / (hl * sl) : 1;
	const u = Math.acos(clamp(c, -1, 1)) / Math.PI;
	const v = 0.5 + 0.5 * Math.sign(el) * Math.sqrt(Math.abs(el) / (Math.PI / 2));
	return [u, v];
}

/** Inverse of skyViewUV in a frame where the light is at azimuth 0 (x axis): returns a direction. */
export function skyViewDir(u, v, lightEl) {
	const az = u * Math.PI;
	const s = v < 0.5 ? -1 : 1;
	const el = s * (2 * v - 1) ** 2 * (Math.PI / 2);
	return { dir: [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)], light: [Math.cos(lightEl), Math.sin(lightEl), 0] };
}

export const SKYVIEW_GLSL = /* glsl */ `
vec2 skyViewUV(vec3 d, vec3 l, vec2 size) {
	float el = asin(clamp(d.y, -1.0, 1.0));
	vec2 dh = d.xz, lh = l.xz;
	float hl = length(dh), sl = length(lh);
	float c = (hl > 1e-5 && sl > 1e-5) ? dot(dh, lh) / (hl * sl) : 1.0;
	float u = acos(clamp(c, -1.0, 1.0)) / 3.14159265;
	float v = 0.5 + 0.5 * sign(el) * sqrt(abs(el) / 1.5707963);
	// texel centres: parameter 0..1 maps to the first..last texel
	return (vec2(u, v) * (size - 1.0) + 0.5) / size;
}
`;

// ---------------------------------------------------------------- weather (seeded by the date)

const lerp = (a, b, t) => a + (b - a) * t;

/** The weather of one Budapest calendar day (days since 1970-01-01, local time). */
export function dayWeather(day) {
	const r = rng((day * 2654435761) ^ 0x5bd1e995);
	r(); r();
	const roll = r();
	let coverage, cumulus, stratus;
	if (roll < 0.3) { coverage = 0.12 + r() * 0.16; cumulus = 1; stratus = 0; } // clear, a few small clouds
	else if (roll < 0.68) { coverage = 0.3 + r() * 0.18; cumulus = 1; stratus = r() * 0.25; } // fair-weather cumulus
	else if (roll < 0.88) { coverage = 0.48 + r() * 0.16; cumulus = 0.6; stratus = 0.5 + r() * 0.3; } // broken stratocumulus
	else { coverage = 0.64 + r() * 0.16; cumulus = 0.3; stratus = 0.85 + r() * 0.15; } // mostly cloudy
	const cirrus = r() < 0.55 ? 0.2 + r() * 0.6 : r() * 0.15;
	const windDir = r() * Math.PI * 2;
	return {
		coverage, cumulus, stratus, cirrus,
		aod: 0.06 + r() * 0.12 + (roll > 0.68 ? 0.04 : 0),
		windDir,
		windSpeed: 4 + r() * 9, // m/s at cloud level
		cirrusDir: windDir + (r() - 0.5) * 1.2,
		cirrusSpeed: 15 + r() * 20,
		seed: r(),
	};
}

/** Local Budapest day number and fraction of the day for a Unix time. */
export function budapestDay(unix) {
	const local = unix / 86400 + budapestOffsetHours(unix) / 24;
	const day = Math.floor(local);
	return { day, frac: local - day };
}

/** Weather at a moment: today's weather drifting into tomorrow's during the day. */
export function weatherAt(unix) {
	const { day, frac } = budapestDay(unix);
	const a = dayWeather(day), b = dayWeather(day + 1);
	// Hold today's weather for most of the day; drift towards tomorrow's in the evening and night.
	const t = smoothstep(0.62, 1.0, frac);
	const ang = (x, y) => x + Math.atan2(Math.sin(y - x), Math.cos(y - x)) * t;
	return {
		coverage: lerp(a.coverage, b.coverage, t),
		cumulus: lerp(a.cumulus, b.cumulus, t),
		stratus: lerp(a.stratus, b.stratus, t),
		cirrus: lerp(a.cirrus, b.cirrus, t),
		aod: lerp(a.aod, b.aod, t),
		windDir: ang(a.windDir, b.windDir),
		windSpeed: lerp(a.windSpeed, b.windSpeed, t),
		cirrusDir: ang(a.cirrusDir, b.cirrusDir),
		cirrusSpeed: lerp(a.cirrusSpeed, b.cirrusSpeed, t),
		day,
	};
}

// ---------------------------------------------------------------- sidereal time (stars)

/** Local sidereal time in radians at longitude lon (degrees east). */
export function localSiderealTime(unix, lon) {
	const j = unix / 86400 + 2440587.5;
	const T = (j - 2451545) / 36525;
	const g = 280.46061837 + 360.98564736629 * (j - 2451545) + 0.000387933 * T * T;
	return ((((g + lon) % 360) + 360) % 360) * (Math.PI / 180);
}

/**
 * Column-major 3x3 matrix (array of 9) taking an equatorial unit vector (x to the vernal equinox,
 * z to the celestial north pole) to the game world (+x east, +y up, +z south).
 */
export function equatorialToWorld(lst, latDeg) {
	const phi = (latDeg * Math.PI) / 180;
	const cl = Math.cos(lst), sl = Math.sin(lst), sp = Math.sin(phi), cp = Math.cos(phi);
	// Hour-angle frame: x' to the meridian on the equator, y' east, z' the pole.
	// x' = cl*ex + sl*ey ; y' = -sl*ex + cl*ey ; z' = ez
	// world = x' * (south*sin(phi) + up*cos(phi)) + y' * east + z' * (north*cos(phi) + up*sin(phi))
	// with east = (1,0,0), up = (0,1,0), south = (0,0,1), north = (0,0,-1).
	const X = [0, cp, sp]; // image of x'
	const Y = [1, 0, 0]; // image of y'
	const Z = [0, sp, -cp]; // image of z'
	// columns = images of ex, ey, ez
	const ex = [X[0] * cl - Y[0] * sl, X[1] * cl - Y[1] * sl, X[2] * cl - Y[2] * sl];
	const ey = [X[0] * sl + Y[0] * cl, X[1] * sl + Y[1] * cl, X[2] * sl + Y[2] * cl];
	return [...ex, ...ey, ...Z];
}

// ---------------------------------------------------------------- direct sunlight (analytic)

/** Relative optical air mass for a body at elevation elDeg (Kasten & Young 1989; ~38 at the horizon). */
export function airMass(elDeg) {
	const e = Math.max(elDeg, -1.5);
	const s = Math.sin((Math.max(e, 0) * Math.PI) / 180);
	return Math.min(40, 1 / (s + 0.50572 * Math.pow(e + 6.07995, -1.6364)));
}

/**
 * Transmittance of direct sunlight through the whole atmosphere for a sun at elDeg and the given
 * aerosol optical depth (aerosols are a little stronger in blue: Angstrom exponent ~1.3). [r, g, b]
 */
export function sunTransmittance(elDeg, aod = 0.15) {
	const m = airMass(elDeg);
	const ang = [0.8, 1.0, 1.32];
	// Below the horizon the sun is hidden by the earth; fade over the last half degree (refraction).
	const vis = smoothstep(-1.2, -0.3, elDeg);
	return [0, 1, 2].map((k) => vis * Math.exp(-(RAYLEIGH[k] * HR + OZONE[k] * 15 + aod * ang[k]) * m));
}
