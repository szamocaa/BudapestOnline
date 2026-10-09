// Local flat projection around the VIII. district. Game world: metres, +x = east, +z = south, +y = up
// (three.js convention: the camera looks down -z, so north is "forward" on the map).

export const ORIGIN = { lat: 47.4925, lon: 19.0800 };
const R = 6371008.8;
const DEG = Math.PI / 180;
const COS0 = Math.cos(ORIGIN.lat * DEG);

export function toXZ(lat, lon) {
	return [(lon - ORIGIN.lon) * DEG * R * COS0, -(lat - ORIGIN.lat) * DEG * R];
}

export function toLatLon(x, z) {
	return [ORIGIN.lat - z / (DEG * R), ORIGIN.lon + x / (DEG * R * COS0)];
}

/** Padded box around the district, [south, west, north, east] - used for Overpass queries and culling. */
export const DISTRICT_BBOX = [47.4730, 19.0560, 47.5045, 19.1130];

export function dist2(ax, az, bx, bz) {
	const dx = ax - bx, dz = az - bz;
	return dx * dx + dz * dz;
}

/** Closest point on segment AB to P: returns [x, z, t]. */
export function closestOnSegment(px, pz, ax, az, bx, bz) {
	const dx = bx - ax, dz = bz - az;
	const len2 = dx * dx + dz * dz;
	let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	return [ax + dx * t, az + dz * t, t];
}

export function polygonArea(pts) {
	let a = 0;
	for (let i = 0, n = pts.length; i < n; i++) {
		const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % n];
		a += x1 * z2 - x2 * z1;
	}
	return a / 2;
}

export function pointInPolygon(x, z, pts) {
	let inside = false;
	for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
		const [xi, zi] = pts[i], [xj, zj] = pts[j];
		if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
	}
	return inside;
}

/** Deterministic PRNG (mulberry32) so the city looks the same every visit. */
export function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function hashString(s) {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return h >>> 0;
}
