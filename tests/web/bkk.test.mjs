// BKK client parsing on responses shaped like the real FUTÁR API (see research notes in README).
import assert from 'node:assert/strict';
import { decodePolyline, parseRouteDetails, parseVehicles, ROUTE_IDS, BkkClient } from '../../game/transit/bkk.js';
import { toXZ } from '../../game/geo.js';

// Google's reference vector.
assert.deepEqual(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);

function encode(points) {
	let out = '', plat = 0, plon = 0;
	const enc = (v) => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
	for (const [lat, lon] of points) { const a = Math.round(lat * 1e5), b = Math.round(lon * 1e5); out += enc(a - plat) + enc(b - plon); plat = a; plon = b; }
	return out;
}
// Népszínház utca from Blaha towards Teleki tér (approximate), stops along it.
const line = [[47.4963, 19.0712], [47.4950, 19.0748], [47.4937, 19.0790], [47.4925, 19.0830]];
assert.deepEqual(decodePolyline(encode(line)), line);
const details = {
	status: 'OK', code: 200,
	data: { entry: { id: 'BKK_3281', shortName: '28A', type: 'TRAM', description: 'Blaha Lujza tér M | Új köztemető (Kozma utca)', style: { color: 'FFD800', icon: { textColor: '000000' } },
		variants: [
			{ headsign: 'Új köztemető (Kozma utca)', direction: '0', stopIds: ['BKK_A', 'BKK_B', 'BKK_C', 'BKK_X'], polyline: { points: encode(line) } },
			{ headsign: 'Blaha Lujza tér M', direction: '1', stopIds: ['BKK_C', 'BKK_A'], polyline: { points: encode(line.slice().reverse()) } },
		] },
		references: { stops: {
			BKK_A: { name: 'Blaha Lujza tér M', lat: 47.4962, lon: 19.0713 },
			BKK_B: { name: 'II. János Pál pápa tér M', lat: 47.4938, lon: 19.0789 },
			BKK_C: { name: 'Teleki Blanka utca', lat: 47.4925, lon: 19.0829 },
			BKK_X: { name: 'Far away', lat: 47.6, lon: 19.3 },
		} } },
};
const parsed = parseRouteDetails(details);
assert.equal(parsed.ref, '28A');
assert.equal(parsed.mode, 'tram');
assert.equal(parsed.colour, '#FFD800');
assert.equal(parsed.directions.length, 2);
assert.deepEqual(parsed.directions[0].stops.map((s) => s.name), ['Blaha Lujza tér M', 'II. János Pál pápa tér M', 'Teleki Blanka utca'], 'far stop dropped');
assert.ok(parsed.directions[0].stops[1].s > parsed.directions[0].stops[0].s);
assert.ok(parsed.directions[0].length > 800 && parsed.directions[0].length < 1100, `length ${parsed.directions[0].length}`);
assert.equal(parseRouteDetails({ data: {} }), null);

const vehicles = parseVehicles({
	status: 'OK', currentTime: 1760000000000,
	data: { list: [
		{ vehicleId: 'BKK_4040', routeId: 'BKK_3281', tripId: 'T1', location: { lat: 47.4950, lon: 19.0748 }, bearing: 112.5, status: 'IN_TRANSIT_TO', stopId: 'BKK_B', lastUpdateTime: 1759999990, licensePlate: 'V4040', model: 'Tatra T5C5' },
		{ vehicleId: 'BKK_1', routeId: 'BKK_9999', location: { lat: 47.5, lon: 19.1 } },
		{ vehicleId: 'BKK_2', routeId: 'BKK_0990' },
	], references: { trips: { T1: { tripHeadsign: 'Új köztemető (Kozma utca)', directionId: 0 } } } },
});
assert.equal(vehicles.length, 1, 'unknown routes and vehicles without a location are skipped');
const v = vehicles[0];
assert.equal(v.ref, '28A');
assert.equal(v.headsign, 'Új köztemető (Kozma utca)');
assert.equal(v.direction, '0');
assert.deepEqual([v.x, v.z], toXZ(47.4950, 19.0748));
assert.equal(v.bearing, 112.5);

const client = new BkkClient({ key: 'k-123', bases: ['https://futar.bkk.hu/api/query/v1/ws/otp/api/where/'] });
const u = new URL(client.url(client.bases[0], 'vehicles-for-route', { routeId: Object.values(ROUTE_IDS), includeReferences: 'routes,trips' }));
assert.equal(u.pathname, '/api/query/v1/ws/otp/api/where/vehicles-for-route.json');
assert.deepEqual(u.searchParams.getAll('routeId').sort(), ['BKK_0990', 'BKK_3230', 'BKK_3240', 'BKK_3281', 'BKK_5200']);
assert.equal(u.searchParams.get('key'), 'k-123');
assert.equal(u.searchParams.get('version'), '4');
console.log('ok bkk.js: polyline decoding, route-details and vehicles-for-route parsing, request URLs');
