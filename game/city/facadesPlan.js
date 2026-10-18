// Planning the Józsefváros buildings before any geometry is made (pure logic, no three.js; tested in
// tests/web/buildings.test.mjs):
//   * which walls are party walls shared with a neighbour, which face a street, a courtyard or an
//     open side (firewalls, "tűzfal");
//   * storey counts and heights for the 2/3 of OSM buildings that have no `building:levels`, from the
//     neighbours, the area, the footprint and the kind;
//   * an architectural style, colours, roof and weathering per building;
//   * which shop (OSM point of interest) sits behind which ground-floor bay.
// World axes: metres, +x east, +z south.
import { polygonArea, pointInPolygon, hashString, rng } from '../geo.js';

// ---------------------------------------------------------------- chunk grid (detail streaming)

export const CHUNK = 100;
export const GRID_X0 = -1800, GRID_Z0 = -1300, GRID_W = 44, GRID_H = 36;
export function chunkIndex(x, z) {
	const ix = Math.max(0, Math.min(GRID_W - 1, Math.floor((x - GRID_X0) / CHUNK)));
	const iz = Math.max(0, Math.min(GRID_H - 1, Math.floor((z - GRID_Z0) / CHUNK)));
	return [ix, iz];
}

// ---------------------------------------------------------------- styles

/**
 * Architectural styles. Ranges are [min, max] in metres: gH ground storey, fH upper storey,
 * cz cornice/attic zone above the top floor ceiling, axis window spacing, winW/winH window size.
 */
export const STYLES = {
	eclectic: { gH: [4.6, 5.3], fH: [3.85, 4.2], cz: [1.15, 1.5], axis: [3.6, 4.2], winW: [1.22, 1.42], winH: [2.25, 2.55], recess: 0.24, cornice: 3, string: 1, lintel: 1, plinth: 0.75, rustic: 0.85, roof: 'hip', court: true },
	secession: { gH: [4.5, 5.1], fH: [3.8, 4.1], cz: [0.9, 1.3], axis: [3.4, 4.0], winW: [1.3, 1.6], winH: [2.1, 2.45], recess: 0.22, cornice: 2, string: 1, lintel: 2, plinth: 0.6, rustic: 0.3, roof: 'hip', court: true },
	plain: { gH: [4.3, 5.0], fH: [3.6, 3.95], cz: [0.55, 0.9], axis: [3.3, 4.0], winW: [1.2, 1.4], winH: [2.0, 2.35], recess: 0.2, cornice: 1, string: 0, lintel: 0, plinth: 0.5, rustic: 0.25, roof: 'hip', court: true },
	palace: { gH: [5.4, 6.2], fH: [4.9, 5.6], cz: [1.5, 2.0], axis: [4.0, 4.8], winW: [1.45, 1.7], winH: [2.8, 3.2], recess: 0.3, cornice: 3, string: 1, lintel: 3, plinth: 1.0, rustic: 1, roof: 'hip', court: true },
	brick: { gH: [4.5, 5.2], fH: [4.0, 4.6], cz: [1.0, 1.4], axis: [3.6, 4.2], winW: [1.3, 1.5], winH: [2.3, 2.7], recess: 0.26, cornice: 2, string: 1, lintel: 1, plinth: 0.8, rustic: 0, roof: 'hip', court: true },
	house: { gH: [3.6, 4.1], fH: [3.3, 3.6], cz: [0.45, 0.65], axis: [2.9, 3.5], winW: [1.05, 1.2], winH: [1.65, 1.9], recess: 0.18, cornice: 1, string: 0, lintel: 0, plinth: 0.6, rustic: 0, roof: 'gable', court: true },
	interwar: { gH: [3.8, 4.3], fH: [3.15, 3.4], cz: [0.45, 0.7], axis: [3.0, 3.5], winW: [1.2, 1.5], winH: [1.6, 1.8], recess: 0.16, cornice: 1, string: 0, lintel: 0, plinth: 0.5, rustic: 0, roof: 'hip', court: true },
	socialist: { gH: [3.0, 3.3], fH: [2.8, 2.95], cz: [0.6, 0.8], axis: [2.7, 3.2], winW: [1.4, 1.8], winH: [1.4, 1.55], recess: 0.12, cornice: 0, string: 0, lintel: 0, plinth: 0.4, rustic: 0, roof: 'flat', court: false },
	modern: { gH: [4.0, 4.6], fH: [3.1, 3.35], cz: [0.8, 1.1], axis: [2.6, 3.1], winW: [1.7, 2.1], winH: [2.2, 2.45], recess: 0.15, cornice: 0, string: 0, lintel: 0, plinth: 0.2, rustic: 0, roof: 'flat', court: false },
	industrial: { gH: [4.8, 6.0], fH: [3.8, 4.3], cz: [0.5, 0.8], axis: [3.6, 4.6], winW: [1.8, 2.4], winH: [1.5, 2.0], recess: 0.15, cornice: 0, string: 0, lintel: 0, plinth: 0.4, rustic: 0, roof: 'gable', court: false },
	church: { gH: [6.0, 7.0], fH: [5.5, 6.0], cz: [1.0, 1.3], axis: [4.5, 5.5], winW: [1.4, 1.8], winH: [3.5, 4.5], recess: 0.35, cornice: 2, string: 0, lintel: 0, plinth: 0.9, rustic: 0, roof: 'gable', court: false },
};

/** Old tenement styles: blank firewalls on plot lines, courtyards with "gang" balconies. */
export const TENEMENT = new Set(['eclectic', 'secession', 'plain', 'palace', 'brick', 'interwar', 'house']);

// Plaster colours (sRGB hex) observed on Józsefváros facades: ochres, creams, greys, faded pastels.
const PLASTER = {
	eclectic: ['#cdb48c', '#d8c49a', '#e3d7bc', '#cdb892', '#c9bba0', '#bfb5a6', '#d4c7ae', '#a8aa9a', '#b5b0a6', '#c8c5be', '#d9c9a3', '#c4a882', '#d4b2a0', '#afc4d2', '#bdb59c', '#e0cfa6', '#cbbfa9'],
	secession: ['#e5c77a', '#d9cfb0', '#b9c4a8', '#c8d0c6', '#e1d2b3', '#d6b48e', '#c5cfd6', '#e8dcc0', '#cfb98f'],
	plain: ['#bdb6a8', '#c9c2b2', '#d2c8b0', '#b0aa9e', '#c6bba3', '#a9a397', '#d0c4a6', '#bab4a6'],
	palace: ['#d8cdb4', '#e2d8c0', '#cfc2a2', '#d6c9a8', '#c9bfa8'],
	brick: ['#c69a5c', '#b5583f', '#c97e52', '#d1a868'],
	house: ['#e4d9be', '#d9c79e', '#e8e0cc', '#cdbf9e', '#d8b998', '#c9c7b8'],
	interwar: ['#d6cfbe', '#cfc6b0', '#c8c4b8', '#ddd2b6'],
	socialist: ['#d6d1c4', '#cfc8b4', '#ddd6bd', '#c2c0b8', '#d9cfae'],
	modern: ['#ecebe7', '#dedcd6', '#d4d4d0', '#e6e0d4', '#c9c5bd', '#bfc2c4'],
	industrial: ['#b9b1a1', '#a9a49a', '#b04f3a', '#c4b79c'],
	church: ['#d9cfb8', '#cfc4aa'],
};
const ROOF_TILE = ['#8a4b35', '#7b4432', '#95553c', '#7a4a3a', '#86503c'];
const ROOF_SLATE = ['#4f5258', '#575a5f', '#4a4c50'];
const ROOF_TIN = ['#6e7275', '#7a7d7f', '#7d3b2e', '#4f6650', '#5f6467'];
export const ROOF_MAT = { tile: 0, slate: 1, tin: 2, flat: 3, copper: 4 };

const HEIGHT_DEFAULTS = {
	house: 7, detached: 7, garage: 3.5, garages: 3.5, shed: 3, kiosk: 3, roof: 4, service: 5, industrial: 10,
	warehouse: 8, retail: 8, commercial: 15, office: 20, hotel: 22, school: 14, kindergarten: 7, university: 18,
	hospital: 20, church: 24, chapel: 10, synagogue: 20, apartments: 19, residential: 18, train_station: 16,
};

export function hexRgb(hex) {
	const v = parseInt(hex.slice(1), 16);
	// sRGB -> linear, as three.js vertex colours are linear.
	const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
	return [lin((v >> 16) & 255), lin((v >> 8) & 255), lin(v & 255)];
}

const pick = (r, list) => list[Math.floor(r() * list.length) % list.length];
const range = (r, [a, b]) => a + (b - a) * r();
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------------------------------------------------------------- spatial helpers

class Grid {
	constructor(cell) { this.cell = cell; this.map = new Map(); }
	key(ix, iz) { return ix * 65536 + iz; }
	addBox(x0, z0, x1, z1, item) {
		const c = this.cell;
		for (let ix = Math.floor(x0 / c); ix <= Math.floor(x1 / c); ix++)
			for (let iz = Math.floor(z0 / c); iz <= Math.floor(z1 / c); iz++) {
				const k = this.key(ix, iz);
				let l = this.map.get(k);
				if (!l) this.map.set(k, (l = []));
				l.push(item);
			}
	}
	query(x0, z0, x1, z1, out, stamp) {
		const c = this.cell;
		for (let ix = Math.floor(x0 / c); ix <= Math.floor(x1 / c); ix++)
			for (let iz = Math.floor(z0 / c); iz <= Math.floor(z1 / c); iz++) {
				const l = this.map.get(this.key(ix, iz));
				if (l) for (const it of l) if (it._q !== stamp) { it._q = stamp; out.push(it); }
			}
		return out;
	}
}

/** Distance along the ray (px,pz)+t(dx,dz) to segment AB, or Infinity. */
function raySeg(px, pz, dx, dz, ax, az, bx, bz) {
	const ex = bx - ax, ez = bz - az;
	const den = dx * ez - dz * ex;
	if (Math.abs(den) < 1e-9) return Infinity;
	const qx = ax - px, qz = az - pz;
	const t = (qx * ez - qz * ex) / den;
	const s = (qx * dz - qz * dx) / den;
	return t >= 0 && s >= 0 && s <= 1 ? t : Infinity;
}

// ---------------------------------------------------------------- planning

const STREET_CLASSES = new Set(['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential', 'living_street', 'unclassified', 'pedestrian', 'service', 'trunk', 'footway', 'path', 'cycleway', 'track']);
const ROAD_RANK = { primary: 5, trunk: 5, primary_link: 4, secondary: 4, secondary_link: 3, tertiary: 3, tertiary_link: 2, pedestrian: 3, residential: 2, living_street: 2, unclassified: 2, service: 1, footway: 0, path: 0, cycleway: 0, track: 0 };

/**
 * Plans every building. Returns { infos (drawable buildings), byId, roadGrid }.
 * Each info: { id, b, seed, style, levels, base, floorY[], wallTop, roof{}, plaster, trim, dirt, renovated,
 *   rings, segs[], chunk[ix,iz], shops }.
 */
export function planBuildings(data, { suppressed = new Set() } = {}) {
	const all = data.buildings.filter((b) => !b.hasParts && b.outer && b.outer.length >= 3);
	const infos = [];
	const byId = new Map();
	for (const b of all) {
		const info = { id: b.id, b, drawn: !suppressed.has(b.id), seed: hashString('bld' + b.id + (b.part ? 'p' : '')), base: b.minH || 0, area: Math.abs(polygonArea(b.outer)) - (b.holes || []).reduce((s, h) => s + Math.abs(polygonArea(h)), 0), edges: [], nbLen: new Map() };
		info.rings = [b.outer, ...(b.holes || []).filter((h) => h.length >= 3)];
		byId.set(b.id + (b.part ? 'p' : ''), info);
		infos.push(info);
	}

	// 1) Edges and party walls (collinear, overlapping edges of two different buildings).
	const edgeGrid = new Grid(8);
	for (const info of infos) {
		info.rings.forEach((ring, ri) => {
			const area = polygonArea(ring);
			const outwardSign = (ri === 0 ? area > 0 : area < 0) ? 1 : -1;
			for (let i = 0; i < ring.length; i++) {
				const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
				const len = Math.hypot(bx - ax, bz - az);
				const e = { info, ri, i, ax, az, bx, bz, len, ux: 0, uz: 0, nx: 0, nz: 0, cover: [] };
				if (len > 1e-6) {
					e.ux = (bx - ax) / len; e.uz = (bz - az) / len;
					e.nx = outwardSign * e.uz; e.nz = -outwardSign * e.ux;
				}
				info.edges.push(e);
				if (len > 0.05) edgeGrid.addBox(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), e);
			}
		});
	}
	let stamp = 1;
	const cand = [];
	for (const info of infos) for (const e of info.edges) {
		if (e.len < 0.3) continue;
		cand.length = 0;
		edgeGrid.query(Math.min(e.ax, e.bx) - 0.5, Math.min(e.az, e.bz) - 0.5, Math.max(e.ax, e.bx) + 0.5, Math.max(e.az, e.bz) + 0.5, cand, ++stamp);
		for (const f of cand) {
			if (f.info === info || f.len < 0.3) continue;
			if (Math.abs(e.ux * f.uz - e.uz * f.ux) > 0.12) continue; // not parallel
			const d1 = (f.ax - e.ax) * -e.uz + (f.az - e.az) * e.ux, d2 = (f.bx - e.ax) * -e.uz + (f.bz - e.az) * e.ux;
			if (Math.abs(d1) > 0.6 || Math.abs(d2) > 0.6) continue;
			let t1 = (f.ax - e.ax) * e.ux + (f.az - e.az) * e.uz, t2 = (f.bx - e.ax) * e.ux + (f.bz - e.az) * e.uz;
			if (t1 > t2) [t1, t2] = [t2, t1];
			t1 = Math.max(0, t1); t2 = Math.min(e.len, t2);
			if (t2 - t1 < 0.25) continue;
			if (f.nx * e.nx + f.nz * e.nz > 0.5) {
				// Same-facing overlap: two OSM outlines share this facade (a block outline over its houses,
				// a part over its parent). Drawing both would z-fight, so the smaller building (or the later
				// id) yields that stretch and treats it as covered by the other.
				info.sameFacing = (info.sameFacing || 0) + 1;
				const yields = info.area < f.info.area - 1 || (Math.abs(info.area - f.info.area) <= 1 && info.id > f.info.id);
				if (yields) e.cover.push({ t0: t1, t1: t2, nb: f.info, dup: true });
				continue;
			}
			e.cover.push({ t0: t1, t1: t2, nb: f.info });
			info.nbLen.set(f.info, (info.nbLen.get(f.info) || 0) + (t2 - t1));
		}
	}

	// 2) Storeys, heights and style.
	const roads = data.roads || [];
	const roadGrid = new Grid(25);
	for (const r of roads) {
		if (!STREET_CLASSES.has(r.cls)) continue;
		for (let i = 0; i + 1 < r.pts.length; i++) {
			const [ax, az] = r.pts[i], [bx, bz] = r.pts[i + 1];
			roadGrid.addBox(Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz), { ax, az, bx, bz, r, rank: ROAD_RANK[r.cls] ?? 1, foot: r.cls === 'footway' || r.cls === 'path' || r.cls === 'cycleway' || r.cls === 'track' });
		}
	}
	const nearRoadRank = (x, z, rad) => {
		const out = [];
		roadGrid.query(x - rad, z - rad, x + rad, z + rad, out, ++stamp);
		let best = 0;
		for (const s of out) {
			if (s.foot) continue;
			const dx = s.bx - s.ax, dz = s.bz - s.az, l2 = dx * dx + dz * dz || 1;
			const t = clamp(((x - s.ax) * dx + (z - s.az) * dz) / l2, 0, 1);
			if ((s.ax + dx * t - x) ** 2 + (s.az + dz * t - z) ** 2 < rad * rad) best = Math.max(best, s.rank);
		}
		return best;
	};
	planHeights(infos, nearRoadRank);

	// 3) Wall segments: covered (party), street, courtyard or open side.
	const areaGrid = new Grid(50);
	for (const a of data.areas || []) {
		if (!/^(plaza|park|parking|grass|playground|pitch|water|cemetery)$/.test(a.kind)) continue;
		let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
		for (const [x, z] of a.outer) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
		areaGrid.addBox(x0, z0, x1, z1, { a, x0, z0, x1, z1 });
	}
	const inOpenArea = (x, z) => {
		const out = [];
		areaGrid.query(x, z, x, z, out, ++stamp);
		for (const it of out) if (x >= it.x0 && x <= it.x1 && z >= it.z0 && z <= it.z1 && pointInPolygon(x, z, it.a.outer) && !(it.a.holes || []).some((h) => pointInPolygon(x, z, h))) return true;
		return false;
	};
	const probe = (px, pz, dx, dz, self) => {
		// Nearest road (centre line minus half its width) and nearest building wall along the ray.
		const R = 46;
		const x0 = Math.min(px, px + dx * R), x1 = Math.max(px, px + dx * R), z0 = Math.min(pz, pz + dz * R), z1 = Math.max(pz, pz + dz * R);
		const rs = [];
		roadGrid.query(x0, z0, x1, z1, rs, ++stamp);
		let tr = Infinity, rank = 0;
		for (const s of rs) {
			const t = raySeg(px, pz, dx, dz, s.ax, s.az, s.bx, s.bz);
			if (t === Infinity) continue;
			const tt = Math.max(0, t - (s.r.width || 6) / 2);
			if (tt < tr - 0.5 || (tt < tr + 0.5 && s.rank > rank)) { tr = Math.min(tr, tt); rank = s.foot ? Math.max(rank, 0) : Math.max(rank, s.rank); }
		}
		const es = [];
		edgeGrid.query(x0, z0, x1, z1, es, ++stamp);
		let tb = Infinity;
		for (const f of es) {
			if (f === self) continue;
			const t = raySeg(px, pz, dx, dz, f.ax, f.az, f.bx, f.bz);
			if (t > 0.05 && t < tb) tb = t;
		}
		return { tr, tb, rank };
	};

	for (const info of infos) {
		if (!info.drawn) continue;
		info.segs = [];
		for (const e of info.edges) {
			if (e.len < 0.05) continue;
			// Split the edge at every cover boundary.
			const cuts = [0, e.len];
			for (const c of e.cover) cuts.push(c.t0, c.t1);
			cuts.sort((a, b) => a - b);
			const pieces = [];
			for (let k = 0; k + 1 < cuts.length; k++) {
				const t0 = cuts[k], t1 = cuts[k + 1];
				if (t1 - t0 < 0.02) continue;
				const tm = (t0 + t1) / 2;
				let top = -1, nbBase = 0, nb = null;
				for (const c of e.cover) if (c.t0 <= tm && c.t1 >= tm && (c.nb.base < 1.5 || c.dup) && c.nb.wallTop > top) { top = c.nb.wallTop; nb = c.nb; nbBase = c.nb.base; }
				pieces.push({ t0, t1, covered: top >= 0, top, nb, nbBase });
			}
			// Merge neighbouring pieces with the same cover; swallow slivers.
			const merged = [];
			for (const p of pieces) {
				const last = merged[merged.length - 1];
				if (last && last.covered === p.covered && Math.abs(last.top - p.top) < 0.6) { last.t1 = p.t1; last.top = Math.max(last.top, p.top); continue; }
				if (last && p.t1 - p.t0 < 0.4) { last.t1 = p.t1; continue; }
				merged.push({ ...p });
			}
			if (merged.length > 1 && merged[0].t1 - merged[0].t0 < 0.4) { merged[1].t0 = 0; merged.shift(); }
			for (const p of merged) {
				const seg = { info, e, ri: e.ri, t0: p.t0, t1: p.t1, len: p.t1 - p.t0, ax: e.ax + e.ux * p.t0, az: e.az + e.uz * p.t0, bx: e.ax + e.ux * p.t1, bz: e.az + e.uz * p.t1, ux: e.ux, uz: e.uz, nx: e.nx, nz: e.nz, kind: 'party', coverTop: p.top, rank: 0, pois: [] };
				if (!p.covered) {
					// Vote along the segment: street, courtyard or open side.
					let street = 0, court = 0, open = 0, rank = 0;
					const samples = seg.len > 12 ? [0.2, 0.5, 0.8] : [0.5];
					for (const f of samples) {
						const px = seg.ax + (seg.bx - seg.ax) * f + e.nx * 0.2, pz = seg.az + (seg.bz - seg.az) * f + e.nz * 0.2;
						const { tr, tb, rank: rk } = probe(px, pz, e.nx, e.nz, e);
						if (tr < tb && tr < 40) { street++; rank = Math.max(rank, rk); }
						else if (inOpenArea(px + e.nx * 5, pz + e.nz * 5)) { street++; rank = Math.max(rank, 2); }
						else if (tb < 38) court++;
						else open++;
					}
					seg.kind = e.ri > 0 ? (street > court + open ? 'court' : 'court') : street >= court && street >= open ? 'street' : court >= open ? 'court' : 'side';
					seg.rank = rank;
				}
				info.segs.push(seg);
			}
		}
		info.frontRank = Math.max(0, ...info.segs.filter((s) => s.kind === 'street').map((s) => s.rank));
		info.streetLen = info.segs.reduce((s, g) => s + (g.kind === 'street' ? g.len : 0), 0);
	}

	// Ground-floor height depends on the street: the big avenues have tall shop storeys.
	for (const info of infos) if (info.drawn) finishBuilding(info);

	// 4) Shops: every point of interest goes behind the nearest street-facing wall.
	const segGrid = new Grid(25);
	for (const info of infos) if (info.drawn && info.base < 1) for (const s of info.segs) if (s.kind === 'street' && s.len > 2) segGrid.addBox(Math.min(s.ax, s.bx), Math.min(s.az, s.bz), Math.max(s.ax, s.bx), Math.max(s.az, s.bz), s);
	for (const p of data.pois || []) {
		if (!/^(shop|food|cafe|bar|grocery|tobacco|pharmacy|kiosk|vape|atm|bikes)$/.test(p.kind)) continue;
		const out = [];
		segGrid.query(p.x - 20, p.z - 20, p.x + 20, p.z + 20, out, ++stamp);
		let best = null, bestD = 20 * 20;
		for (const s of out) {
			const dx = s.bx - s.ax, dz = s.bz - s.az;
			const t = clamp(((p.x - s.ax) * dx + (p.z - s.az) * dz) / (s.len * s.len), 0, 1);
			const d = (s.ax + dx * t - p.x) ** 2 + (s.az + dz * t - p.z) ** 2;
			if (d < bestD) { bestD = d; best = { s, t: t * s.len }; }
		}
		if (best) best.s.pois.push({ poi: p, t: best.t });
	}
	return { infos: infos.filter((i) => i.drawn), all: infos, byId, roadGrid, nearRoadRank };
}

/** Whether OSM's height was made up by the importer from levels or the building type. */
function heightIsDerived(b) {
	if (b.levels) return Math.abs(b.h - (b.levels * 3.4 + 0.8)) < 0.08 || Math.abs(b.h - (b.levels * 3.4 + 1.5)) < 0.08;
	return Math.abs(b.h - (HEIGHT_DEFAULTS[b.kind] || 16)) < 0.05;
}

const SMALL_KINDS = /^(garage|garages|shed|kiosk|roof|carport|allotment_house|hut|cabin|toilets|container|transformer_tower|bunker|greenhouse|service)$/;
const INDUSTRIAL_KINDS = /^(industrial|warehouse|manufacture|transportation|hangar|depot|train_station|parking|sports_centre|construction|bridge)$/;
const CHURCH_KINDS = /^(church|chapel|cathedral|synagogue|mosque|temple|religious)$/;

function chooseStyle(info, r) {
	const b = info.b;
	const t = b.tags || {};
	const year = parseInt(String(t.start_date || '').replace(/[^0-9]/g, '').slice(0, 4), 10) || 0;
	const name = (b.name || '').toLowerCase();
	if (b.part) return info.levels >= 7 ? 'modern' : 'plain';
	if (CHURCH_KINDS.test(b.kind)) return 'church';
	if (SMALL_KINDS.test(b.kind) || INDUSTRIAL_KINDS.test(b.kind)) return 'industrial';
	if (b.material === 'glass' || b.material === 'aluminium') return 'modern';
	if (year) {
		if (year >= 1990) return 'modern';
		if (year >= 1946) return 'socialist';
		if (year >= 1920) return 'interwar';
		if (year >= 1898) return r() < 0.55 ? 'secession' : 'eclectic';
		if (year < 1850) return info.levels <= 2 ? 'house' : 'plain';
		if (/palota|palais|kastély|kaszinó/.test(name)) return 'palace';
		return b.material === 'brick' ? 'brick' : 'eclectic';
	}
	if (/palota|palais|kastély|kaszinó/.test(name)) return 'palace';
	if (/irodaház|hotel|campus|center|centre|mall|plaza|üzletház|business|residence|lakópark/.test(name)) return 'modern';
	if (b.material === 'brick') return 'brick';
	if (/^(university|college|hospital|school|government|public|civic|museum)$/.test(b.kind)) return info.levels <= 5 ? (r() < 0.45 ? 'brick' : 'palace') : 'modern';
	if (/^(house|detached|semidetached_house|bungalow|farm)$/.test(b.kind) || (info.levels <= 2 && info.area < 450)) return info.levels <= 2 ? 'house' : 'plain';
	const coverage = info.partyShare;
	if (info.levels >= 8) return coverage > 0.25 && r() < 0.3 ? 'interwar' : r() < 0.55 ? 'modern' : 'socialist';
	if (info.levels >= 7 && coverage < 0.15) return r() < 0.6 ? 'modern' : 'socialist';
	if (info.levels >= 4 && coverage < 0.06 && info.rings.length === 1 && info.b.outer.length <= 6 && info.area > 300) return r() < 0.6 ? 'socialist' : 'modern';
	if (/^(office|commercial|retail|hotel)$/.test(b.kind) && info.levels >= 5 && coverage < 0.2) return 'modern';
	const x = r();
	if (info.levels <= 2) return x < 0.6 ? 'house' : 'plain';
	return x < 0.56 ? 'eclectic' : x < 0.72 ? 'secession' : x < 0.93 ? 'plain' : x < 0.97 ? 'interwar' : 'brick';
}

/** Levels for buildings without `building:levels`: neighbours, area, footprint and kind. */
function planHeights(infos, nearRoadRank) {
	// Spatial prior: average levels of tagged apartment blocks per 150 m cell.
	const cell = 150, sums = new Map();
	for (const i of infos) {
		const b = i.b;
		if (!b.levels || b.part || !/^(apartments|residential|yes)$/.test(b.kind) || b.levels > 9) continue;
		const k = Math.floor(b.cx / cell) + ',' + Math.floor(b.cz / cell);
		const s = sums.get(k) || [0, 0];
		s[0] += b.levels; s[1]++;
		sums.set(k, s);
	}
	const prior = (x, z) => {
		let sum = 0, w = 0;
		const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
		for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
			const s = sums.get(cx + dx + ',' + (cz + dz));
			if (!s) continue;
			const ww = dx === 0 && dz === 0 ? 2 : 1;
			sum += (s[0] / s[1]) * ww * Math.min(s[1], 6);
			w += ww * Math.min(s[1], 6);
		}
		return w ? sum / w : 4;
	};
	for (const i of infos) {
		let perim = 0, shared = 0;
		for (const e of i.edges) perim += e.len;
		for (const v of i.nbLen.values()) shared += v;
		i.partyShare = perim > 0 ? shared / perim : 0;
		i.known = !!i.b.levels || !heightIsDerived(i.b);
		if (i.b.levels) i.levels = Math.max(1, Math.round(i.b.levels));
	}
	const estimate = (i) => {
		const b = i.b;
		if (SMALL_KINDS.test(b.kind) || i.area < 45) return 1;
		if (INDUSTRIAL_KINDS.test(b.kind)) return i.area > 2500 ? 1 : i.area > 600 ? 2 : 1;
		if (/^(house|detached|bungalow|semidetached_house)$/.test(b.kind)) return i.area > 250 ? 2 : 1;
		if (CHURCH_KINDS.test(b.kind)) return 2;
		// Neighbours sharing walls (weighted by the shared length; mapped ones count double).
		let sum = 0, w = 0;
		for (const [nb, len] of i.nbLen) if (nb.levels) { const k = nb.b.levels ? 1 : 0.5; sum += nb.levels * len * k; w += len * k; }
		let lv = w > 3 ? sum / w : prior(b.cx, b.cz);
		const r = rng(i.seed ^ 0x51ed);
		// Variation along a street: a storey up or down here and there.
		const jitter = r();
		if (w > 3) lv += jitter < 0.18 ? -1 : jitter > 0.84 ? 1 : 0;
		else lv += jitter < 0.25 ? -1 : jitter > 0.8 ? 1 : 0;
		// Small footprints are old low houses or back wings.
		if (i.area < 110) lv = Math.min(lv, 2);
		else if (i.area < 220) lv = Math.min(lv, 3 + (jitter > 0.6 ? 1 : 0));
		// Main avenues (the Nagykörút, Rákóczi út, Üllői út) have the tallest blocks.
		const rank = nearRoadRank(b.cx, b.cz, 30);
		if (rank >= 4 && i.area > 300) lv = Math.max(lv, 4.6);
		if (/^(school|university|hospital|public|government|office|hotel|commercial)$/.test(b.kind)) lv = Math.max(lv, 3);
		return clamp(Math.round(lv), 1, 8);
	};
	// Buildings with an explicit OSM height get their storeys from it.
	for (const i of infos) if (!i.b.levels && i.known) i.levels = clamp(Math.round((i.b.h - (i.b.minH || 0) - 4.8 - 1.2) / 3.95) + 1, 1, 40);
	// The best-informed first, so the estimate flows along continuous street fronts.
	const order = infos.filter((i) => !i.levels);
	const mapped = (i) => { let k = 0; for (const [nb, l] of i.nbLen) if (nb.levels) k += l; return k; };
	order.sort((a, b) => mapped(b) - mapped(a));
	for (const i of order) i.levels = estimate(i);
	for (const i of infos) {
		const r = rng(i.seed);
		const b = i.b;
		i.style = chooseStyle(i, r);
		const S = STYLES[i.style];
		i.gH = range(r, S.gH);
		i.fH = range(r, S.fH);
		i.cz = range(r, S.cz);
		if (b.part && i.base > 1) i.gH = i.fH;
		// Storey bottoms.
		const fy = [i.base];
		for (let k = 0; k < i.levels; k++) fy.push(fy[k] + (k === 0 ? i.gH : k === 1 && i.style !== 'socialist' && i.style !== 'modern' ? i.fH * 1.04 : k === i.levels - 1 && i.levels > 3 ? i.fH * 0.95 : i.fH));
		i.floorY = fy;
		i.wallTop = fy[i.levels] + i.cz;
		if (i.known && !heightIsDerived(b)) {
			// Respect OSM's explicit height: scale the storeys to it (minus a roof if tagged).
			const target = Math.max(i.base + 2.5, b.h - (b.roofShape && b.roofShape !== 'flat' ? b.roofH || Math.min(5, b.h * 0.25) : 0));
			const k = (target - i.base) / (i.wallTop - i.base);
			if (k > 0.55 && k < 1.6) {
				i.floorY = fy.map((y) => i.base + (y - i.base) * k);
				i.gH *= k; i.fH *= k; i.cz *= k;
				i.wallTop = target;
			} else {
				i.wallTop = target;
				i.levels = Math.max(1, Math.round((target - i.base - i.cz - i.gH) / i.fH) + 1);
				const f2 = [i.base];
				for (let q = 0; q < i.levels; q++) f2.push(f2[q] + (q === 0 ? i.gH : i.fH));
				const k2 = (target - i.base) / (f2[i.levels] + i.cz - i.base);
				i.floorY = f2.map((y) => i.base + (y - i.base) * k2);
			}
		}
	}
}

/** Colours, roof, weathering and decoration choices for one building. */
function finishBuilding(info) {
	const r = rng(info.seed ^ 0x9e3779b9);
	const b = info.b;
	const S = STYLES[info.style];
	info.S = S;
	// Main streets: taller shop storey.
	if (info.frontRank >= 4 && TENEMENT.has(info.style) && info.levels >= 3) {
		const extra = 0.35 + r() * 0.4;
		for (let k = 1; k < info.floorY.length; k++) info.floorY[k] += extra;
		info.gH += extra;
		info.wallTop += extra;
	}
	const pal = PLASTER[info.style];
	let hex = b.colour && /^#[0-9a-f]{6}$/i.test(b.colour) ? b.colour : pick(r, pal);
	if (b.material === 'brick' && info.style !== 'brick') hex = pick(r, PLASTER.brick);
	const base = hexRgb(hex);
	// Renovated facades are clean and a touch brighter; most are greyed by soot.
	info.renovated = r() < (info.style === 'modern' ? 0.9 : info.style === 'socialist' ? 0.35 : 0.24);
	info.dirt = info.renovated ? 0.08 + r() * 0.12 : 0.3 + r() * 0.55;
	const grey = info.renovated ? 0 : 0.12 + r() * 0.22;
	const lum = base[0] * 0.3 + base[1] * 0.59 + base[2] * 0.11;
	info.plaster = base.map((c) => (c * (1 - grey) + lum * grey) * (info.renovated ? 1.04 : 0.94 - info.dirt * 0.12));
	// Trim (window surrounds, cornices): lighter or same hue darker.
	const tr = r();
	info.trim = tr < 0.45 ? info.plaster.map((c) => Math.min(1, c * 1.22 + 0.04)) : tr < 0.8 ? info.plaster.map((c) => c * 0.86) : hexRgb(pick(r, ['#e8e0cf', '#d9d2c2', '#cfc6b3'])).map((c, k) => c * (0.75 + 0.25 * info.plaster[k] / Math.max(0.01, lum)) * (info.renovated ? 1 : 0.85));
	info.groundTone = r();
	// Window frames: white (replaced), brown/varnished (old), cream or dark green.
	const fr = r();
	info.frame = info.style === 'modern' ? 3 : info.style === 'socialist' ? (fr < 0.6 ? 0 : 1) : fr < 0.42 ? 0 : fr < 0.78 ? 1 : fr < 0.9 ? 2 : 3;
	info.blinds = info.style === 'modern' ? 0.15 : 0.55 + r() * 0.35; // share of windows with external roller blinds
	info.balconyAxis = r() < (info.style === 'eclectic' || info.style === 'secession' || info.style === 'palace' ? 0.65 : info.style === 'socialist' ? 0.0 : 0.15);
	info.shutters = info.style === 'house' ? r() < 0.7 : info.style === 'plain' || info.style === 'eclectic' ? r() < 0.08 : false;
	info.lintelKind = S.lintel === 0 ? 0 : S.lintel === 3 ? 3 : 1 + Math.floor(r() * 3);
	info.consoles = (info.style === 'eclectic' || info.style === 'palace') && r() < 0.75;
	info.gangs = TENEMENT.has(info.style) && info.style !== 'house' && info.levels >= 2;
	info.turret = TENEMENT.has(info.style) && info.levels >= 4 && info.style !== 'plain' && r() < 0.4;
	info.adSeed = r();
	info.shopShare = info.frontRank >= 4 ? 0.9 : info.frontRank === 3 ? 0.7 : info.frontRank === 2 ? 0.38 : 0.18;
	if (!TENEMENT.has(info.style) && info.style !== 'modern') info.shopShare *= 0.3;
	if (info.style === 'modern') info.shopShare = info.frontRank >= 2 ? 0.75 : 0.25;
	// Roof.
	let kind = b.roofShape || S.roof;
	if (info.style === 'modern' || info.style === 'socialist') kind = b.roofShape || 'flat';
	if (/^(many|quadruple_saltbox|double_saltbox|half-hipped|crosspitched|side_hipped)$/.test(kind)) kind = 'hip';
	if (kind === 'hipped') kind = 'hip';
	if (kind === 'gabled' || kind === 'saltbox' || kind === 'sawtooth') kind = 'gable';
	if (kind === 'gambrel') kind = 'mansard';
	if (kind === 'round') kind = 'dome';
	if (kind === 'hip' && TENEMENT.has(info.style) && info.style !== 'house' && r() < 0.12 && info.levels >= 4) kind = 'mansard';
	if (!/^(hip|gable|pyramidal|mansard|dome|onion|cone|flat|skillion)$/.test(kind)) kind = 'hip';
	if (kind === 'skillion') kind = 'flat';
	const mr = r();
	let mat = b.roofMat === 'roof_tiles' ? 'tile' : b.roofMat === 'glass' ? 'tin' : kind === 'flat' ? 'flat' : kind === 'dome' || kind === 'onion' ? 'copper' : mr < 0.5 ? 'tile' : mr < 0.72 ? 'slate' : 'tin';
	if (info.style === 'industrial' && kind !== 'flat') mat = mr < 0.6 ? 'tin' : 'slate';
	const colour = b.roof ? hexRgb(b.roof) : hexRgb(mat === 'tile' ? pick(r, ROOF_TILE) : mat === 'slate' ? pick(r, ROOF_SLATE) : mat === 'tin' ? pick(r, ROOF_TIN) : mat === 'copper' ? '#6f9c88' : pick(r, ['#5a5a58', '#6b6a66', '#4e4e4c']));
	const pitch = kind === 'flat' ? 0 : info.style === 'industrial' ? 0.32 + r() * 0.2 : info.style === 'house' ? 0.7 + r() * 0.15 : 0.58 + r() * 0.16; // radians
	info.roof = { kind, mat, colour, pitch, rise: b.roofH || null };
}

// ---------------------------------------------------------------- facade layout

/**
 * Window axes along one wall segment: n bays evenly spread between the margins, so no window is cut
 * off at a corner. Returns { n, start, step } with bay k centred at start + (k + 0.5) * step.
 */
export function layoutBays(len, axis, m0 = 0.9, m1 = 0.9, minW = 1.6) {
	const usable = len - m0 - m1;
	if (len < minW) return { n: 0, start: 0, step: 0 };
	if (usable < axis * 0.6) {
		// One central axis if there is room for a window at all.
		return len >= minW + 0.5 ? { n: 1, start: 0, step: len } : { n: 0, start: 0, step: 0 };
	}
	const n = Math.max(1, Math.round(usable / axis));
	return { n, start: m0, step: usable / n };
}

/** Night occupancy (share of flats with lights on) for a time of day in hours. */
export function occupancyAt(h) {
	const pts = [[0, 0.16], [1.5, 0.09], [4, 0.05], [5.5, 0.12], [6.5, 0.3], [7.5, 0.26], [9, 0.1], [16, 0.12], [17.5, 0.3], [19, 0.55], [20.5, 0.68], [22, 0.55], [23, 0.34], [24, 0.16]];
	h = ((h % 24) + 24) % 24;
	for (let k = 0; k + 1 < pts.length; k++) {
		const [h0, v0] = pts[k], [h1, v1] = pts[k + 1];
		if (h >= h0 && h <= h1) return v0 + (v1 - v0) * ((h - h0) / (h1 - h0));
	}
	return 0.2;
}
