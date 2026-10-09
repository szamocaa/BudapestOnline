// BKK FUTÁR / BudapestGO public API client (browser fetch, no proxy).
// Docs: realCity Query Server API (OpenAPI), https://opendata.bkk.hu. Data: BKK Zrt., CC BY 4.0.

import { toXZ } from '../geo.js';
import { cumulative, projectOnLine } from '../osm.js';

export const ROUTE_IDS = { '99': 'BKK_0990', '23': 'BKK_3230', '24': 'BKK_3240', '28A': 'BKK_3281', M2: 'BKK_5200' };
const REF_BY_ID = Object.fromEntries(Object.entries(ROUTE_IDS).map(([ref, id]) => [id, ref]));

/** Google encoded polyline (precision 1e5) -> [[lat, lon], ...]. */
export function decodePolyline(str, precision = 1e5) {
	const out = [];
	let index = 0, lat = 0, lon = 0;
	while (index < str.length) {
		for (const which of [0, 1]) {
			let result = 0, shift = 0, b;
			do {
				b = str.charCodeAt(index++) - 63;
				result |= (b & 0x1f) << shift;
				shift += 5;
			} while (b >= 0x20 && index < str.length + 1);
			const delta = result & 1 ? ~(result >> 1) : result >> 1;
			if (which === 0) lat += delta;
			else lon += delta;
		}
		out.push([lat / precision, lon / precision]);
	}
	return out;
}

const modeOf = (type) => (type === 'SUBWAY' ? 'metro' : type === 'TRAM' ? 'tram' : type === 'TROLLEYBUS' ? 'trolleybus' : 'bus');

/**
 * route-details responses -> lines in the game's format:
 * [{ ref, mode, colour, text, name, directions: [{ headsign, direction, pts, cum, length, stops: [{ id, name, x, z, s }] }] }]
 */
export function parseRouteDetails(json) {
	const e = json && json.data && json.data.entry;
	if (!e) return null;
	const stops = (json.data.references && json.data.references.stops) || {};
	const ref = REF_BY_ID[e.id] || e.shortName;
	const line = {
		ref,
		routeId: e.id,
		mode: modeOf(e.type),
		colour: '#' + ((e.style && e.style.color) || e.color || 'FFD800'),
		text: '#' + ((e.style && e.style.icon && e.style.icon.textColor) || e.textColor || '000000'),
		name: e.description || e.longName || ref,
		directions: [],
	};
	for (const v of e.variants || []) {
		if (!v.polyline || !v.polyline.points) continue;
		const pts = decodePolyline(v.polyline.points).map(([lat, lon]) => toXZ(lat, lon));
		if (pts.length < 2) continue;
		const cum = cumulative(pts);
		const st = [];
		let lastS = -1;
		for (const id of v.stopIds || []) {
			const s = stops[id];
			if (!s) continue;
			const [x, z] = toXZ(s.lat, s.lon);
			const pr = projectOnLine(pts, cum, x, z, lastS - 30);
			if (!pr || pr.dist > 80) continue;
			st.push({ id, name: s.name, x: pr.x, z: pr.z, s: pr.s });
			lastS = pr.s;
		}
		line.directions.push({ headsign: v.headsign || '', direction: v.direction, pts, cum, length: cum[cum.length - 1], stops: st });
	}
	return line.directions.length ? line : null;
}

/** vehicles-for-route response -> [{ id, ref, x, z, bearing, headsign, status, stopId, updated, tripId, model }] */
export function parseVehicles(json) {
	const d = json && json.data;
	if (!d || !Array.isArray(d.list)) return null;
	const trips = (d.references && d.references.trips) || {};
	const out = [];
	for (const v of d.list) {
		if (!v.location || v.location.lat == null) continue;
		const ref = REF_BY_ID[v.routeId];
		if (!ref) continue;
		const [x, z] = toXZ(v.location.lat, v.location.lon);
		const trip = trips[v.tripId] || {};
		out.push({
			id: v.vehicleId || v.licensePlate || `${v.routeId}:${v.tripId}`,
			ref,
			x,
			z,
			bearing: typeof v.bearing === 'number' ? v.bearing : null,
			headsign: trip.tripHeadsign || '',
			direction: trip.directionId != null ? String(trip.directionId) : null,
			status: v.status || '',
			stopId: v.stopId || null,
			updated: v.lastUpdateTime || null,
			plate: v.licensePlate || '',
			model: v.model || v.label || '',
		});
	}
	return out;
}

export class BkkClient {
	constructor({ key, bases, version = 4, appVersion = 'budapest-online-1.0' }) {
		this.key = key;
		this.bases = bases;
		this.version = version;
		this.appVersion = appVersion;
		this.working = null; // base URL that answered last time
		this.lastError = '';
	}

	url(base, method, params) {
		const q = new URLSearchParams({ key: this.key, version: String(this.version), appVersion: this.appVersion });
		for (const [k, v] of Object.entries(params)) {
			if (Array.isArray(v)) v.forEach((x) => q.append(k, x));
			else q.set(k, v);
		}
		return `${base}${method}.json?${q}`;
	}

	async call(method, params, signal) {
		const bases = this.working ? [this.working, ...this.bases.filter((b) => b !== this.working)] : this.bases;
		for (const base of bases) {
			try {
				const res = await fetch(this.url(base, method, params), { signal, cache: 'no-store' });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const json = await res.json();
				if (json.status && json.status !== 'OK') throw new Error(`${json.code} ${json.text || json.status}`);
				this.working = base;
				this.lastError = '';
				return json;
			} catch (err) {
				if (signal && signal.aborted) throw err;
				// A CORS refusal shows up as a TypeError with no status.
				this.lastError = err instanceof TypeError ? 'a böngésző nem engedi (CORS/hálózat)' : err.message;
			}
		}
		throw new Error(this.lastError || 'BKK API nem elérhető');
	}

	async routeDetails(refs, signal) {
		const lines = [];
		for (const ref of refs) {
			const json = await this.call('route-details', { routeId: ROUTE_IDS[ref], includeReferences: 'stops' }, signal);
			const line = parseRouteDetails(json);
			if (line) lines.push(line);
		}
		return lines;
	}

	async vehicles(refs, signal) {
		const json = await this.call('vehicles-for-route', { routeId: refs.map((r) => ROUTE_IDS[r]), includeReferences: 'routes,trips' }, signal);
		return parseVehicles(json) || [];
	}
}
