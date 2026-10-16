// normalise() on hand-made data in the exact shape Overpass's `out geom` / `out body` returns.
import assert from 'node:assert/strict';
import { normalise, assembleRoute, cumulative, parseLength, buildingHeight, buildQuery } from '../../game/osm.js';
import { toXZ, toLatLon, polygonArea } from '../../game/geo.js';

// Metres (east, south) -> {lat, lon}
const ll = (x, z) => { const [lat, lon] = toLatLon(x, z); return { lat, lon }; };
const geom = (pts) => pts.map(([x, z]) => ll(x, z));
const closed = (pts) => [...pts, pts[0]];

const elements = [
	// Another district that a loose name search also returns ("XVIII. kerület"), far away: must be ignored.
	{ type: 'relation', id: 2, tags: { boundary: 'administrative', admin_level: '9', name: 'XVIII. kerület' }, members: [
		{ type: 'way', ref: 13, role: 'outer', geometry: geom(closed([[9000, 9000], [9500, 9000], [9500, 9500], [9000, 9500]])) },
	] },
	{ type: 'relation', id: 1, tags: { boundary: 'administrative', admin_level: '9', name: 'VIII. kerület' }, members: [
		{ type: 'way', ref: 11, role: 'outer', geometry: geom([[-500, -500], [500, -500], [500, 500]]) },
		{ type: 'way', ref: 12, role: 'outer', geometry: geom([[-500, -500], [-500, 500], [500, 500]]) }, // second half reversed
	] },
	{ type: 'way', id: 100, tags: { building: 'apartments', 'building:levels': '5', 'building:colour': 'yellow' }, geometry: geom(closed([[0, 0], [30, 0], [30, 20], [0, 20]])) },
	{ type: 'relation', id: 200, tags: { type: 'multipolygon', building: 'yes', height: '19 m' }, members: [
		{ type: 'way', ref: 201, role: 'outer', geometry: geom([[100, 0], [160, 0], [160, 40]]) },
		{ type: 'way', ref: 202, role: 'outer', geometry: geom([[100, 0], [100, 40], [160, 40]]) },
		{ type: 'way', ref: 203, role: 'inner', geometry: geom(closed([[115, 10], [145, 10], [145, 30], [115, 30]])) },
	] },
	// Simple 3D Buildings: an outline with a domed part inside it.
	{ type: 'way', id: 110, tags: { building: 'church', name: 'Szent József templom', wikidata: 'Q1' }, geometry: geom(closed([[300, 0], [340, 0], [340, 60], [300, 60]])) },
	{ type: 'way', id: 111, tags: { 'building:part': 'yes', height: '42', min_height: '20', 'roof:shape': 'dome', 'roof:height': '8', 'building:material': 'stone', 'roof:colour': 'green' }, geometry: geom(closed([[310, 10], [330, 10], [330, 30], [310, 30]])) },
	{ type: 'way', id: 120, tags: { barrier: 'wall', height: '3' }, geometry: geom([[-200, 0], [-100, 0]]) },
	{ type: 'way', id: 403, tags: { highway: 'residential', name: 'Mátyás tér', 'parking:both': 'parallel', surface: 'sett', lanes: '2' }, geometry: geom([[50, 50], [50, 150]]) },
	{ type: 'node', id: 705, lat: ll(20, 10).lat, lon: ll(20, 10).lon, tags: { amenity: 'bench' } },
	{ type: 'node', id: 706, lat: ll(22, 10).lat, lon: ll(22, 10).lon, tags: { highway: 'crossing', crossing: 'zebra' } },
	{ type: 'way', id: 300, tags: { building: 'yes' }, geometry: geom(closed([[2000, 2000], [2010, 2000], [2010, 2010], [2000, 2010]])) }, // far outside the district
	{ type: 'way', id: 400, tags: { highway: 'primary', name: 'József körút' }, geometry: geom([[0, -100], [0, 300]]) },
	{ type: 'way', id: 401, tags: { highway: 'footway' }, geometry: geom([[0, 0], [50, 0]]) },
	{ type: 'way', id: 402, tags: { highway: 'service', tunnel: 'yes' }, geometry: geom([[0, 0], [10, 0]]) },
	{ type: 'way', id: 500, tags: { railway: 'tram' }, geometry: geom([[5, -100], [5, 300]]) },
	{ type: 'way', id: 600, tags: { leisure: 'park', name: 'Teleki tér' }, geometry: geom(closed([[200, 200], [260, 200], [260, 260], [200, 260]])) },
	{ type: 'node', id: 700, lat: ll(10, 10).lat, lon: ll(10, 10).lon, tags: { natural: 'tree' } },
	{ type: 'node', id: 701, lat: ll(12, 10).lat, lon: ll(12, 10).lon, tags: { highway: 'street_lamp' } },
	{ type: 'node', id: 702, lat: ll(14, 10).lat, lon: ll(14, 10).lon, tags: { shop: 'e-cigarette', name: 'Vape Corner' } },
	{ type: 'node', id: 703, lat: ll(16, 10).lat, lon: ll(16, 10).lon, tags: { railway: 'subway_entrance', name: 'Blaha Lujza tér' } },
	{ type: 'node', id: 704, lat: ll(18, 10).lat, lon: ll(18, 10).lon, tags: { amenity: 'pharmacy', name: 'Patika' } },
	// Route relation: 3 ways, the middle one stored backwards, plus stop nodes (named via `node(r.routes); out body`).
	{ type: 'relation', id: 900, tags: { type: 'route', route: 'tram', ref: '28A', name: 'Villamos 28A: Blaha Lujza tér => Új köztemető', from: 'Blaha Lujza tér', to: 'Új köztemető', colour: '#FFD800' }, members: [
		{ type: 'node', ref: 901, role: 'stop', lat: ll(0, 0).lat, lon: ll(0, 0).lon },
		{ type: 'node', ref: 902, role: 'platform', lat: ll(3, 0).lat, lon: ll(3, 0).lon },
		{ type: 'way', ref: 910, role: '', geometry: geom([[0, 0], [100, 0]]) },
		{ type: 'way', ref: 911, role: '', geometry: geom([[200, 50], [100, 0]]) },
		{ type: 'way', ref: 912, role: '', geometry: geom([[200, 50], [300, 50]]) },
		{ type: 'node', ref: 903, role: 'stop', lat: ll(200, 50).lat, lon: ll(200, 50).lon },
		{ type: 'node', ref: 904, role: 'stop', lat: ll(300, 52).lat, lon: ll(300, 52).lon },
	] },
	{ type: 'relation', id: 950, tags: { type: 'route', route: 'bus', ref: '7' }, members: [] }, // not one of our lines
	{ type: 'relation', id: 951, tags: { type: 'route', route: 'bus', ref: '28A' }, members: [{ type: 'way', ref: 1, role: '', geometry: geom([[0, 0], [100, 0]]) }] }, // right number, wrong mode
	{ type: 'node', id: 901, lat: 0, lon: 0, tags: { name: 'Blaha Lujza tér' } },
	{ type: 'node', id: 902, lat: 0, lon: 0, tags: { name: 'Blaha Lujza tér' } },
	{ type: 'node', id: 903, lat: 0, lon: 0, tags: { name: 'II. János Pál pápa tér' } },
	{ type: 'node', id: 904, lat: 0, lon: 0, tags: { name: 'Teleki tér' } },
];

const d = normalise({ elements });

assert.ok(d.boundary && Math.abs(Math.abs(polygonArea(d.boundary)) - 1e6) < 50, 'boundary ring joined');
assert.deepEqual(d.buildings.map((b) => b.id).sort((x, y) => x - y), [100, 110, 111, 200], 'far building filtered by boundary');
const church = d.buildings.find((b) => b.id === 110), dome = d.buildings.find((b) => b.id === 111);
assert.ok(church.hasParts && !church.part, 'outline knows it has parts');
assert.ok(dome.part && dome.roofShape === 'dome' && dome.roofH === 8 && dome.minH === 20 && dome.h === 42 && dome.material === 'stone');
assert.equal(church.tags.wikidata, 'Q1');
assert.ok(!('roofShape' in d.buildings.find((b) => b.id === 100)), 'absent tags are not stored');
assert.deepEqual(d.barriers.map((w) => [w.kind, w.h]), [['wall', 3]]);
const matyas = d.roads.find((r) => r.id === 403);
assert.deepEqual(matyas.parking, { left: 'parallel', right: 'parallel' });
assert.equal(matyas.surface, 'sett');
assert.deepEqual(d.props.map((q) => q.kind).sort(), ['bench', 'crossing']);
assert.equal(d.props.find((q) => q.kind === 'crossing').crossing, 'zebra');
const b100 = d.buildings.find((b) => b.id === 100);
assert.equal(b100.colour, '#e2c56c');
assert.ok(Math.abs(b100.h - (5 * 3.4 + 0.8)) < 1e-9);
const b200 = d.buildings.find((b) => b.id === 200);
assert.equal(b200.h, 19);
assert.equal(b200.holes.length, 1, 'courtyard kept');
assert.ok(Math.abs(Math.abs(polygonArea(b200.outer)) - 2400) < 2);
assert.equal(d.roads.length, 3, 'tunnel skipped');
assert.equal(d.roads.find((r) => r.id === 400).name, 'József körút');
assert.equal(d.roads.find((r) => r.id === 400).width, 17);
assert.equal(d.rails.length, 1);
assert.equal(d.areas[0].kind, 'park');
assert.equal(d.trees.length, 1);
assert.equal(d.lamps.length, 1);
assert.deepEqual(d.pois.map((p) => p.kind).sort(), ['pharmacy', 'vape']);
assert.equal(d.entrances[0].name, 'Blaha Lujza tér');

assert.equal(d.routes.length, 1, 'only our lines');
const r = d.routes[0];
assert.equal(r.ref, '28A');
assert.equal(r.mode, 'tram');
assert.equal(r.colour, '#ffd800');
assert.ok(Math.abs(r.length - (100 + Math.hypot(100, 50) + 100)) < 0.5, `route length ${r.length}`);
assert.deepEqual(r.pts[0], [0, 0]);
assert.deepEqual(r.stops.map((s) => s.name), ['Blaha Lujza tér', 'II. János Pál pápa tér', 'Teleki tér'], 'stop/platform duplicates merged, order kept');
assert.ok(r.stops[1].s > r.stops[0].s && r.stops[2].s > r.stops[1].s);

// helpers
assert.equal(parseLength("40'"), 40 * 0.3048);
assert.equal(parseLength('12,5 m'), 12.5);
assert.equal(parseLength('tall'), null);
assert.deepEqual(buildingHeight({ building: 'yes' }), [16, 0]);
assert.deepEqual(buildingHeight({ building: 'garage' }), [3.5, 0]);
const line = assembleRoute([[[10, 0], [0, 0]], [[10, 0], [20, 0]]]);
assert.deepEqual(line, [[0, 0], [10, 0], [20, 0]], 'first way flipped to meet the second');
assert.deepEqual(cumulative([[0, 0], [3, 4], [3, 10]]), [0, 5, 11]);
assert.ok(buildQuery().includes('rel(1606100)') && buildQuery().includes('28A'));
console.log(`ok osm.js: ${d.buildings.length} buildings, route ${r.ref} ${r.length} m with ${r.stops.length} stops`);
