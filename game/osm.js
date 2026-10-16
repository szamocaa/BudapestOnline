// OpenStreetMap data for the VIII. district: download (Overpass API, straight from the browser),
// normalise into the game's own compact format, and cache. The same normalise() is used by
// tools/bake_snapshot.mjs to write data/district8.json.
//
// Map data (c) OpenStreetMap contributors, ODbL - https://www.openstreetmap.org/copyright

import { toXZ, DISTRICT_BBOX, polygonArea, pointInPolygon, closestOnSegment, hashString } from './geo.js';

export const DATA_VERSION = 4;
export const LINE_REFS = ['99', '23', '24', '28A', 'M2'];
/** The OSM route type each of our lines must have (a Volán bus numbered 24 is not tram 24). */
export const LINE_ROUTE = { '99': 'bus', '23': 'tram', '24': 'tram', '28A': 'tram', M2: 'subway' };

export const OVERPASS_ENDPOINTS = [
	'https://overpass-api.de/api/interpreter',
	'https://overpass.kumi.systems/api/interpreter',
	'https://overpass.private.coffee/api/interpreter',
	'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

export function buildQuery() {
	const [s, w, n, e] = DISTRICT_BBOX;
	const bb = `(${s},${w},${n},${e})`;
	const refs = LINE_REFS.join('|');
	return `[out:json][timeout:180];
(rel(1606100);rel["boundary"="administrative"]["admin_level"="9"]["name"~"(^|[^IVX])VIII\\. kerület"](47.40,18.90,47.60,19.30);)->.b;
.b out geom;
(way["building"]${bb};relation["building"]["type"="multipolygon"]${bb};way["building:part"]${bb};relation["building:part"]["type"="multipolygon"]${bb};)->.bld;
.bld out geom;
way["highway"]${bb}->.hw;
.hw out geom;
way["railway"~"^(tram|subway|rail)$"]${bb}->.rw;
.rw out geom;
way["barrier"~"^(wall|fence|retaining_wall|hedge|guard_rail)$"]${bb}->.bar;
.bar out geom;
(way["leisure"~"^(park|garden|playground|pitch)$"]${bb};way["landuse"~"^(grass|cemetery|recreation_ground|village_green|religious)$"]${bb};relation["leisure"="park"]${bb};relation["landuse"="cemetery"]${bb};way["amenity"="parking"]${bb};way["place"="square"]${bb};way["highway"="pedestrian"]["area"="yes"]${bb};way["natural"="water"]${bb};)->.ar;
.ar out geom;
(node["natural"="tree"]${bb};node["highway"="street_lamp"]${bb};node["shop"]${bb};node["amenity"]${bb};node["railway"="subway_entrance"]${bb};node["highway"="bus_stop"]${bb};node["railway"="tram_stop"]${bb};node["highway"~"^(crossing|traffic_signals)$"]${bb};node["barrier"="bollard"]${bb};node["historic"]${bb};node["tourism"~"^(artwork|attraction|hotel|museum)$"]${bb};node["man_made"~"^(advertising|street_cabinet|flagpole)$"]${bb};node["advertising"]${bb};node["leisure"~"^(playground|fitness_station)$"]${bb};)->.pt;
.pt out body;
rel["type"="route"]["route"~"^(bus|tram|subway)$"]["ref"~"^(${refs})$"](47.35,18.90,47.65,19.35)->.routes;
.routes out geom;
node(r.routes);
out body;`;
}

/** Downloads raw Overpass JSON, trying each mirror. onProgress(text) receives status messages. */
export async function fetchOverpass(onProgress = () => {}, signal) {
	const query = buildQuery();
	let lastError = null;
	for (const endpoint of OVERPASS_ENDPOINTS) {
		try {
			onProgress(`OpenStreetMap letöltés: ${new URL(endpoint).host} ...`);
			const res = await fetch(endpoint, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const json = await res.json();
			if (!json.elements || json.elements.length < 100) throw new Error('üres válasz');
			return json;
		} catch (err) {
			if (signal && signal.aborted) throw err;
			lastError = err;
		}
	}
	throw new Error(`Az OpenStreetMap szerverek nem elérhetők (${lastError && lastError.message})`);
}

// ---------------------------------------------------------------- helpers

const ptsOf = (geometry) => (geometry || []).filter(Boolean).map((g) => toXZ(g.lat, g.lon));
const round = (v) => Math.round(v * 100) / 100 + 0; // + 0 turns -0 into 0
const roundPts = (pts) => pts.map(([x, z]) => [round(x), round(z)]);

function closeRing(pts) {
	const out = [];
	for (const p of pts) if (!out.length || p[0] !== out[out.length - 1][0] || p[1] !== out[out.length - 1][1]) out.push(p);
	if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
	return out;
}

/** Joins way pieces (arrays of [x,z]) end-to-end into closed rings; open leftovers are dropped. */
export function assembleRings(segments) {
	const same = (a, b) => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
	const pending = segments.filter((s) => s.length >= 2).map((s) => s.slice());
	const rings = [];
	while (pending.length) {
		let cur = pending.shift();
		let guard = 0;
		while (!same(cur[0], cur[cur.length - 1]) && guard++ < 10000) {
			const i = pending.findIndex((o) => same(o[0], cur[cur.length - 1]) || same(o[o.length - 1], cur[cur.length - 1]) || same(o[o.length - 1], cur[0]) || same(o[0], cur[0]));
			if (i < 0) break;
			const o = pending.splice(i, 1)[0];
			if (same(o[0], cur[cur.length - 1])) cur = cur.concat(o.slice(1));
			else if (same(o[o.length - 1], cur[cur.length - 1])) cur = cur.concat(o.slice(0, -1).reverse());
			else if (same(o[o.length - 1], cur[0])) cur = o.slice(0, -1).concat(cur);
			else cur = o.slice(1).reverse().concat(cur);
		}
		if (same(cur[0], cur[cur.length - 1]) && cur.length >= 4) rings.push(closeRing(cur));
	}
	return rings;
}

export function parseLength(v) {
	if (v == null) return null;
	const t = String(v).trim().toLowerCase().replace(',', '.');
	const fi = t.match(/^(\d+)'\s*(\d+(?:\.\d+)?)"?$/);
	if (fi) return (parseInt(fi[1], 10) * 12 + parseFloat(fi[2])) * 0.0254;
	const m = t.match(/^(-?\d+(?:\.\d+)?)\s*(meters|metres|meter|metre|m|feet|ft|')?(?:\s|$)/);
	if (!m) return null;
	let n = parseFloat(m[1]);
	if (m[2] === 'ft' || m[2] === 'feet' || m[2] === "'") n *= 0.3048;
	return n > 0 ? n : null;
}

const HEIGHT_BY_TYPE = {
	house: 7, detached: 7, garage: 3.5, garages: 3.5, shed: 3, kiosk: 3, roof: 4, service: 5, industrial: 10,
	warehouse: 8, retail: 8, commercial: 15, office: 20, hotel: 22, school: 14, kindergarten: 7, university: 18,
	hospital: 20, church: 24, chapel: 10, synagogue: 20, apartments: 19, residential: 18, train_station: 16,
};

export function buildingHeight(tags) {
	let h = parseLength(tags.height);
	if (h == null && tags['building:levels']) {
		const lv = parseFloat(String(tags['building:levels']).replace(',', '.'));
		if (lv > 0) h = lv * 3.4 + (tags['roof:levels'] ? 1.5 : 0.8);
	}
	if (h == null) h = HEIGHT_BY_TYPE[tags.building] || 16; // VIII. district: mostly 4-6 storey 19th-century blocks
	let minH = parseLength(tags.min_height);
	if (minH == null && tags['building:min_level']) minH = parseFloat(tags['building:min_level']) * 3.4 || 0;
	if (minH == null || minH >= h - 0.5) minH = 0;
	return [h, minH];
}

const NAMED_COLOURS = {
	white: '#eeeeea', yellow: '#e2c56c', beige: '#d8c8a0', grey: '#9a9a96', gray: '#9a9a96', brown: '#8b6b4a', red: '#a04a3a',
	orange: '#d08c4c', pink: '#d8a8a0', blue: '#7f98b8', green: '#8aa07a', black: '#333333', cream: '#efe4c4', tan: '#c8ac80',
};
export function parseColour(v) {
	if (!v) return null;
	const t = String(v).trim().toLowerCase();
	if (/^#[0-9a-f]{6}$/.test(t)) return t;
	if (/^#[0-9a-f]{3}$/.test(t)) return '#' + t.slice(1).split('').map((c) => c + c).join('');
	return NAMED_COLOURS[t] || null;
}

export const ROAD_WIDTH = {
	motorway: 18, trunk: 18, primary: 17, primary_link: 8, secondary: 13, secondary_link: 7, tertiary: 11, tertiary_link: 6,
	residential: 8, living_street: 6, unclassified: 7, service: 4.5, pedestrian: 6, footway: 2.5, path: 2, steps: 3,
	cycleway: 2, track: 3,
};

function lineMode(tags) {
	if (tags.route === 'subway') return 'metro';
	if (tags.route === 'tram') return 'tram';
	return 'bus';
}

/** Orders a route relation's way members into one continuous polyline (flipping ways as needed). */
export function assembleRoute(wayGeoms) {
	const same = (a, b) => Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) < 0.5;
	const segs = wayGeoms.filter((g) => g.length >= 2);
	if (!segs.length) return [];
	let line = segs[0].slice();
	if (segs.length > 1) {
		const next = segs[1];
		const endTouches = same(line[line.length - 1], next[0]) || same(line[line.length - 1], next[next.length - 1]);
		const startTouches = same(line[0], next[0]) || same(line[0], next[next.length - 1]);
		if (!endTouches && startTouches) line.reverse();
	}
	for (let i = 1; i < segs.length; i++) {
		const s = segs[i];
		const end = line[line.length - 1];
		if (same(s[0], end)) line = line.concat(s.slice(1));
		else if (same(s[s.length - 1], end)) line = line.concat(s.slice(0, -1).reverse());
		else {
			// A gap in the relation (incomplete data): continue from whichever end of the way is nearer.
			const d0 = (s[0][0] - end[0]) ** 2 + (s[0][1] - end[1]) ** 2;
			const d1 = (s[s.length - 1][0] - end[0]) ** 2 + (s[s.length - 1][1] - end[1]) ** 2;
			line = line.concat(d0 <= d1 ? s : s.slice().reverse());
		}
	}
	return line;
}

/** Cumulative distances along a polyline. */
export function cumulative(pts) {
	const s = [0];
	for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
	return s;
}

/** Projects (x,z) onto a polyline: { s, dist, x, z, seg }. */
export function projectOnLine(pts, cum, x, z, minS = -Infinity) {
	let best = null;
	for (let i = 0; i + 1 < pts.length; i++) {
		if (cum[i + 1] < minS) continue;
		const [cx, cz, t] = closestOnSegment(x, z, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
		const d = Math.hypot(cx - x, cz - z);
		if (!best || d < best.dist) best = { s: cum[i] + t * (cum[i + 1] - cum[i]), dist: d, x: cx, z: cz, seg: i };
	}
	return best;
}

// ---------------------------------------------------------------- normalise

/** Converts raw Overpass JSON into the game's CityData. */
export function normalise(raw) {
	const els = raw.elements || [];
	const nodesById = new Map();
	for (const el of els) if (el.type === 'node' && el.tags) nodesById.set(el.id, el);

	const data = {
		version: DATA_VERSION,
		source: 'openstreetmap',
		boundary: null,
		buildings: [],
		roads: [],
		areas: [],
		rails: [],
		trees: [],
		lamps: [],
		pois: [],
		stops: [],
		entrances: [],
		routes: [],
		barriers: [],
		props: [],
	};

	// District boundary (outer ring of the admin relation). Several districts may come back (a name
	// search for "VIII. kerület" also finds "XVIII. kerület"): use the one around the map origin,
	// which lies in Józsefváros.
	const outerRing = (rel) => {
		const rings = assembleRings((rel.members || []).filter((m) => m.type === 'way' && m.role !== 'inner' && m.geometry).map((m) => ptsOf(m.geometry)));
		return rings.length ? rings.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)))[0] : null;
	};
	const admins = els.filter((e) => e.type === 'relation' && e.tags && e.tags.boundary === 'administrative' && e.tags.admin_level === '9');
	let boundary = null;
	for (const rel of admins) {
		const ring = outerRing(rel);
		if (ring && ring.length > 2 && pointInPolygon(0, 0, ring)) { boundary = ring; break; }
	}
	if (boundary) data.boundary = roundPts(boundary);

	const seenWays = new Set();
	for (const el of els) {
		const t = el.tags || {};
		if (el.type === 'way') {
			if (seenWays.has(el.id)) continue;
			seenWays.add(el.id);
			const pts = ptsOf(el.geometry);
			if (pts.length < 2) continue;
			const closed = el.geometry.length > 3 && el.geometry[0].lat === el.geometry[el.geometry.length - 1].lat && el.geometry[0].lon === el.geometry[el.geometry.length - 1].lon;

			if (isBuilding(t) && closed) {
				addBuilding(data, el.id, t, [closeRing(pts)]);
			} else if (t.barrier && /^(wall|fence|retaining_wall|hedge|guard_rail)$/.test(t.barrier)) {
				data.barriers.push({ id: el.id, kind: t.barrier, pts: roundPts(pts), h: round(parseLength(t.height) || BARRIER_HEIGHT[t.barrier]), material: t.material || t.fence_type || t.wall || '' });
			} else if (t.highway && !(t.area === 'yes' && t.highway === 'pedestrian')) {
				if (t.tunnel === 'yes' || t.indoor === 'yes' || t.highway === 'construction' || t.highway === 'proposed' || t.highway === 'platform') continue;
				const cls = t.highway;
				const width = parseLength(t.width) || ROAD_WIDTH[cls] || 4;
				data.roads.push({ id: el.id, cls, name: t.name || '', pts: roundPts(pts), width: round(width), oneway: t.oneway === 'yes', foot: t.foot !== 'no' && t.access !== 'private', ...roadExtras(t) });
			} else if (t.railway === 'tram' || t.railway === 'subway' || t.railway === 'rail') {
				if (t.railway === 'subway' || t.tunnel === 'yes') continue; // underground: drawn separately
				data.rails.push({ id: el.id, kind: t.railway, pts: roundPts(pts) });
			} else if (closed) {
				const kind = areaKind(t);
				if (kind) data.areas.push({ id: el.id, kind, name: t.name || '', outer: roundPts(closeRing(pts)), holes: [] });
			}
		} else if (el.type === 'relation') {
			if (t.type === 'route') continue;
			if (t.boundary) continue;
			const outer = assembleRings((el.members || []).filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => ptsOf(m.geometry)));
			const inner = assembleRings((el.members || []).filter((m) => m.type === 'way' && m.role === 'inner').map((m) => ptsOf(m.geometry)));
			if (isBuilding(t)) {
				for (const o of outer) addBuilding(data, el.id, t, [o, ...inner.filter((h) => pointInPolygon(h[0][0], h[0][1], o))]);
			} else {
				const kind = areaKind(t);
				if (kind) for (const o of outer) data.areas.push({ id: el.id, kind, name: t.name || '', outer: roundPts(o), holes: inner.filter((h) => pointInPolygon(h[0][0], h[0][1], o)).map(roundPts) });
			}
		} else if (el.type === 'node' && el.tags) {
			const [x, z] = toXZ(el.lat, el.lon);
			const p = [round(x), round(z)];
			const prop = propKind(t);
			if (prop) data.props.push({ x: p[0], z: p[1], kind: prop, ...(t.name ? { name: t.name } : {}), ...(t.crossing ? { crossing: t.crossing } : {}) });
			if (t.natural === 'tree') data.trees.push(p);
			else if (t.highway === 'street_lamp') data.lamps.push(p);
			else if (t.railway === 'subway_entrance') data.entrances.push({ x: p[0], z: p[1], name: t.name || '', ref: t.ref || '' });
			else if (t.highway === 'bus_stop' || t.railway === 'tram_stop' || (t.public_transport === 'platform' && t.name)) data.stops.push({ x: p[0], z: p[1], name: t.name || '', kind: t.railway === 'tram_stop' ? 'tram' : 'bus' });
			else {
				const kind = poiKind(t);
				if (kind) data.pois.push({ x: p[0], z: p[1], kind, name: t.name || t.brand || '', id: el.id });
			}
		}
	}

	// Transit lines: one entry per route relation (each direction is its own relation in OSM).
	for (const rel of els) {
		if (rel.type !== 'relation' || !rel.tags || rel.tags.type !== 'route') continue;
		const t = rel.tags;
		if (!LINE_REFS.includes(t.ref) || LINE_ROUTE[t.ref] !== t.route) continue;
		const ways = (rel.members || []).filter((m) => m.type === 'way' && m.geometry && !/platform/.test(m.role || '')).map((m) => ptsOf(m.geometry));
		const pts = assembleRoute(ways);
		if (pts.length < 2) continue;
		const cum = cumulative(pts);
		const stops = [];
		let lastS = -1;
		for (const m of rel.members || []) {
			if (m.type !== 'node' || !/^(stop|stop_entry_only|stop_exit_only|platform|platform_entry_only|platform_exit_only)$/.test(m.role || '')) continue;
			const node = nodesById.get(m.ref);
			const lat = m.lat != null ? m.lat : node && node.lat;
			const lon = m.lon != null ? m.lon : node && node.lon;
			if (lat == null) continue;
			const [x, z] = toXZ(lat, lon);
			const pr = projectOnLine(pts, cum, x, z, lastS - 50);
			if (!pr || pr.dist > 60) continue;
			const name = (node && node.tags && node.tags.name) || '';
			// A stop and its platform usually both appear: keep one entry per name.
			if (stops.length && (stops[stops.length - 1].name === name || Math.abs(stops[stops.length - 1].s - pr.s) < 25)) continue;
			stops.push({ name, s: round(pr.s), x: round(pr.x), z: round(pr.z) });
			lastS = pr.s;
		}
		data.routes.push({
			id: rel.id,
			ref: t.ref,
			mode: lineMode(t),
			name: t.name || t.ref,
			from: t.from || '',
			to: t.to || '',
			colour: parseColour(t.colour) || null,
			pts: roundPts(pts),
			length: round(cum[cum.length - 1]),
			stops,
		});
	}

	// Keep the district (plus the far side of its boundary streets) when the boundary is known.
	if (data.boundary) {
		const near = makeNearBoundaryTest(data.boundary, 90);
		data.buildings = data.buildings.filter((b) => near(b.cx, b.cz));
	}
	data.buildings.sort((a, b) => a.id - b.id);
	markOutlinesWithParts(data.buildings);
	return data;
}

const isBuilding = (t) => (t.building && t.building !== 'no') || (t['building:part'] && t['building:part'] !== 'no');

const BARRIER_HEIGHT = { wall: 2.2, fence: 1.6, retaining_wall: 1, hedge: 1.3, guard_rail: 0.9 };

/** Street furniture and other point features drawn as props (benches, bollards, crossings...). */
function propKind(t) {
	if (t.highway === 'crossing') return 'crossing';
	if (t.highway === 'traffic_signals') return 'signals';
	if (t.barrier === 'bollard') return 'bollard';
	if (t.amenity === 'bench') return 'bench';
	if (t.amenity === 'waste_basket') return 'bin';
	if (t.amenity === 'recycling') return 'recycling';
	if (t.amenity === 'post_box') return 'postbox';
	if (t.amenity === 'telephone') return 'phone';
	if (t.amenity === 'vending_machine') return 'vending';
	if (t.amenity === 'bicycle_parking') return 'bikerack';
	if (t.amenity === 'bicycle_rental') return 'bikeshare';
	if (t.amenity === 'drinking_water') return 'drinking';
	if (t.amenity === 'fountain') return 'fountain';
	if (t.amenity === 'parcel_locker') return 'locker';
	if (t.amenity === 'toilets') return 'toilets';
	if (t.amenity === 'clock') return 'clock';
	if (t.advertising === 'column' || t.man_made === 'advertising') return 'adcolumn';
	if (t.advertising) return 'billboard';
	if (t.man_made === 'street_cabinet') return 'cabinet';
	if (t.historic === 'memorial' || t.historic === 'monument' || t.historic === 'statue' || t.tourism === 'artwork') return t.memorial === 'plaque' ? null : 'statue';
	if (t.leisure === 'playground' || t.leisure === 'fitness_station') return 'playground';
	return null;
}

const PARKING_SIDE = ['both', 'left', 'right'];
/** Road attributes the city builder uses for kerbs, parked cars and surfaces. */
function roadExtras(t) {
	const e = {};
	if (t.lanes) e.lanes = parseInt(t.lanes, 10) || undefined;
	if (t.surface) e.surface = t.surface;
	if (t.sidewalk) e.sidewalk = t.sidewalk;
	if (t.footway) e.footway = t.footway;
	if (t.bridge && t.bridge !== 'no') e.bridge = true;
	if (t.layer) e.layer = parseInt(t.layer, 10) || 0;
	if (t.service) e.service = t.service;
	if (t.maxspeed) e.maxspeed = parseInt(t.maxspeed, 10) || undefined;
	// Street parking (both tagging schemes): {left, right} = 'parallel' | 'diagonal' | 'perpendicular'.
	const park = {};
	for (const side of PARKING_SIDE) {
		const v = t[`parking:${side}`] || t[`parking:lane:${side}`];
		if (!v || /^(no|none|separate|marked|no_parking|no_stopping|fire_lane)$/.test(v)) continue;
		const kind = /diagonal/.test(v) ? 'diagonal' : /perpendicular/.test(v) ? 'perpendicular' : 'parallel';
		if (side !== 'right') park.left = kind;
		if (side !== 'left') park.right = kind;
	}
	if (park.left || park.right) e.parking = park;
	for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
	return e;
}

/**
 * OSM's Simple 3D Buildings: when a building outline has building:part pieces inside it, the parts
 * describe the shape and the outline itself must not be drawn on top of them.
 */
function markOutlinesWithParts(buildings) {
	const parts = buildings.filter((b) => b.part);
	if (!parts.length) return;
	for (const b of buildings) {
		if (b.part) continue;
		let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
		for (const [x, z] of b.outer) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
		for (const p of parts) {
			if (p.cx < x0 || p.cx > x1 || p.cz < z0 || p.cz > z1) continue;
			if (pointInPolygon(p.cx, p.cz, b.outer)) { b.hasParts = true; break; }
		}
	}
}

function addBuilding(data, id, t, rings) {
	const outer = rings[0];
	if (outer.length < 3 || Math.abs(polygonArea(outer)) < 6) return;
	const [h, minH] = buildingHeight(t);
	let cx = 0, cz = 0;
	for (const [x, z] of outer) { cx += x; cz += z; }
	cx /= outer.length; cz /= outer.length;
	const isPart = !(t.building && t.building !== 'no');
	const b = {
		id,
		outer: roundPts(outer),
		holes: rings.slice(1).filter((r) => r.length >= 3).map(roundPts),
		h: round(h),
		minH: round(minH),
		kind: isPart ? t['building:part'] : t.building,
		name: t.name || '',
		colour: parseColour(t['building:colour']),
		roof: parseColour(t['roof:colour']),
		cx: round(cx),
		cz: round(cz),
	};
	// Simple 3D Buildings tags: only stored when present, to keep the snapshot small.
	if (isPart) b.part = true;
	if (t['roof:shape'] && t['roof:shape'] !== 'flat') b.roofShape = t['roof:shape'];
	const rh = parseLength(t['roof:height']);
	if (rh != null) b.roofH = round(rh);
	else if (t['roof:levels'] && parseFloat(t['roof:levels']) > 0) b.roofH = round(parseFloat(t['roof:levels']) * 3);
	if (t['roof:direction']) b.roofDir = parseFloat(t['roof:direction']) || t['roof:direction'];
	if (t['roof:orientation']) b.roofOrient = t['roof:orientation'];
	if (t['roof:material']) b.roofMat = t['roof:material'];
	if (t['building:material']) b.material = t['building:material'];
	if (t['building:levels']) b.levels = parseFloat(String(t['building:levels']).replace(',', '.')) || undefined;
	if (t['building:min_level']) b.minLevel = parseFloat(t['building:min_level']) || 0;
	for (const k of ['wikidata', 'historic', 'amenity', 'tourism', 'heritage', 'start_date', 'architect', 'building:architecture', 'addr:street', 'addr:housenumber']) if (t[k]) (b.tags ||= {})[k] = t[k];
	for (const k of Object.keys(b)) if (b[k] === undefined) delete b[k];
	data.buildings.push(b);
}

function areaKind(t) {
	if (t.leisure === 'park' || t.leisure === 'garden' || t.landuse === 'village_green' || t.landuse === 'recreation_ground') return 'park';
	if (t.landuse === 'grass') return 'grass';
	if (t.landuse === 'cemetery' || t.amenity === 'grave_yard') return 'cemetery';
	if (t.leisure === 'playground') return 'playground';
	if (t.leisure === 'pitch') return 'pitch';
	if (t.amenity === 'parking') return 'parking';
	if (t.place === 'square' || (t.highway === 'pedestrian' && t.area === 'yes')) return 'plaza';
	if (t.natural === 'water') return 'water';
	if (t.landuse === 'religious') return 'grass';
	return null;
}

function poiKind(t) {
	if (t.shop === 'e-cigarette') return 'vape';
	if (t.shop === 'tobacco') return 'tobacco';
	if (t.shop === 'kiosk' || t.shop === 'newsagent') return 'kiosk';
	if (t.shop === 'convenience' || t.shop === 'supermarket' || t.shop === 'alcohol') return 'grocery';
	if (t.shop) return 'shop';
	const a = t.amenity;
	if (a === 'pharmacy') return 'pharmacy';
	if (a === 'cafe') return 'cafe';
	if (a === 'bar' || a === 'pub' || a === 'nightclub') return 'bar';
	if (a === 'restaurant' || a === 'fast_food') return 'food';
	if (a === 'police') return 'police';
	if (a === 'place_of_worship') return 'church';
	if (a === 'school' || a === 'kindergarten' || a === 'university' || a === 'college') return 'school';
	if (a === 'bicycle_rental' || a === 'atm' || a === 'bank') return a === 'atm' || a === 'bank' ? 'atm' : 'bikes';
	return null;
}

function makeNearBoundaryTest(boundary, margin) {
	const segs = [];
	for (let i = 0; i < boundary.length; i++) segs.push([boundary[i], boundary[(i + 1) % boundary.length]]);
	return (x, z) => {
		if (pointInPolygon(x, z, boundary)) return true;
		for (const [a, b] of segs) {
			const [cx, cz] = closestOnSegment(x, z, a[0], a[1], b[0], b[1]);
			if ((cx - x) ** 2 + (cz - z) ** 2 < margin * margin) return true;
		}
		return false;
	};
}

// ---------------------------------------------------------------- cache (IndexedDB)

const DB = 'budapest-online';
const STORE = 'city';
const KEY = `district8-v${DATA_VERSION}`;
const MAX_AGE_DAYS = 30;

function openDb() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB, 1);
		req.onupgradeneeded = () => req.result.createObjectStore(STORE);
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

export async function loadCached() {
	try {
		const db = await openDb();
		return await new Promise((resolve) => {
			const req = db.transaction(STORE).objectStore(STORE).get(KEY);
			req.onsuccess = () => {
				const v = req.result;
				resolve(v && Date.now() - v.savedAt < MAX_AGE_DAYS * 86400e3 ? v.data : null);
			};
			req.onerror = () => resolve(null);
		});
	} catch {
		return null;
	}
}

export async function saveCached(data) {
	try {
		const db = await openDb();
		db.transaction(STORE, 'readwrite').objectStore(STORE).put({ savedAt: Date.now(), data }, KEY);
	} catch {
		/* private mode etc. - not fatal */
	}
}

export function cityStats(d) {
	return `${d.buildings.length} épület, ${d.roads.length} út, ${d.routes.length} vonal, ${d.pois.filter((p) => p.kind === 'vape').length} vape bolt`;
}

export { hashString };
