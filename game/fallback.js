// Offline fallback: a simplified VIII. district built from approximate coordinates of its main
// streets, squares and the 99 / 23 / 24 / 28A / M2 lines. Used only when neither the snapshot,
// the cache nor OpenStreetMap is reachable (and in automated tests). It is produced in Overpass's
// own JSON shape and run through normalise(), so it exercises exactly the same code as real data.
import { normalise } from './osm.js';
import { toXZ, toLatLon, rng, pointInPolygon } from './geo.js';

// [lat, lon] polylines. Main streets from GTFS stop positions and known junctions (accurate to
// roughly 10-30 m); the smaller side streets are approximate. See README.
export const STREETS = [
	{ name: 'Rákóczi út', cls: 'primary', pts: [[47.49435, 19.06000], [47.49562, 19.06561], [47.49711, 19.07046], [47.49790, 19.07380], [47.49936, 19.07887], [47.49994, 19.08042]] },
	{ name: 'Múzeum körút', cls: 'primary', pts: [[47.49435, 19.06000], [47.49190, 19.06080], [47.48968, 19.06162]] },
	{ name: 'József körút', cls: 'primary', pts: [[47.49711, 19.07046], [47.49460, 19.07150], [47.49272, 19.07182], [47.49100, 19.07160], [47.48970, 19.07100], [47.48590, 19.07020]] },
	{ name: 'Üllői út', cls: 'primary', pts: [[47.48968, 19.06162], [47.48770, 19.06620], [47.48560, 19.07070], [47.48283, 19.07918], [47.47910, 19.08933], [47.47562, 19.09867]] },
	{ name: 'Népszínház utca', cls: 'tertiary', pts: [[47.49610, 19.07100], [47.49530, 19.07450], [47.49480, 19.07660], [47.49360, 19.08190], [47.49320, 19.08670]] },
	{ name: 'Festetics György utca', cls: 'tertiary', pts: [[47.50000, 19.08230], [47.49907, 19.08255], [47.49850, 19.08270]] },
	{ name: 'Fiumei út', cls: 'secondary', pts: [[47.49850, 19.08270], [47.49645, 19.08312], [47.49320, 19.08670], [47.49223, 19.08787], [47.48990, 19.09050]] },
	{ name: 'Kerepesi út', cls: 'primary', pts: [[47.49994, 19.08042], [47.50000, 19.08350], [47.50010, 19.09000], [47.49964, 19.09983], [47.50018, 19.10828]] },
	{ name: 'Kőbányai út', cls: 'secondary', pts: [[47.48990, 19.09050], [47.48895, 19.09550], [47.48761, 19.10385], [47.48634, 19.10858]] },
	{ name: 'Orczy út', cls: 'secondary', pts: [[47.48990, 19.09050], [47.48500, 19.09287], [47.48122, 19.09342], [47.47938, 19.08988]] },
	{ name: 'Baross utca', cls: 'tertiary', pts: [[47.48970, 19.06250], [47.48950, 19.07120], [47.48930, 19.07700], [47.48920, 19.08580], [47.48870, 19.08900]] },
	{ name: 'Kiss József utca', cls: 'residential', pts: [[47.49790, 19.07380], [47.49752, 19.07404], [47.49530, 19.07600]] },
	{ name: 'Nagy Fuvaros utca', cls: 'residential', pts: [[47.49460, 19.07700], [47.49330, 19.07780], [47.49225, 19.07870]] },
	{ name: 'Szerdahelyi utca', cls: 'residential', pts: [[47.49225, 19.07870], [47.49226, 19.08348], [47.49300, 19.08400]] },
	{ name: 'Dobozi utca', cls: 'residential', pts: [[47.49226, 19.08348], [47.49100, 19.08480], [47.48953, 19.08609]] },
	{ name: 'Kőris utca', cls: 'residential', pts: [[47.48953, 19.08609], [47.48717, 19.08922], [47.48646, 19.09256]] },
	{ name: 'Delej utca', cls: 'residential', pts: [[47.48646, 19.09256], [47.48446, 19.09641], [47.48361, 19.09891]] },
	{ name: 'Vajda Péter utca', cls: 'tertiary', pts: [[47.48361, 19.09891], [47.48239, 19.10250], [47.48259, 19.10477]] },
	{ name: 'Könyves Kálmán körút', cls: 'primary', pts: [[47.50018, 19.10828], [47.48634, 19.10858], [47.48259, 19.10477], [47.47562, 19.09867]] },
	{ name: 'Bérkocsis utca', cls: 'residential', pts: [[47.49500, 19.07250], [47.49330, 19.07330], [47.49180, 19.07400]] },
	{ name: 'Tavaszmező utca', cls: 'residential', pts: [[47.49010, 19.07100], [47.48990, 19.07500], [47.48960, 19.07900]] },
	{ name: 'Bródy Sándor utca', cls: 'residential', pts: [[47.49250, 19.06100], [47.49280, 19.06500], [47.49320, 19.06900]] },
	{ name: 'Szentkirályi utca', cls: 'residential', pts: [[47.49500, 19.06420], [47.49220, 19.06460], [47.48960, 19.06520]] },
	{ name: 'Práter utca', cls: 'residential', pts: [[47.48700, 19.07120], [47.48620, 19.07600], [47.48540, 19.08050]] },
	{ name: 'Corvin sétány', cls: 'pedestrian', pts: [[47.48560, 19.07150], [47.48500, 19.07450], [47.48440, 19.07780]] },
	{ name: 'Salgótarjáni utca', cls: 'residential', pts: [[47.49960, 19.09700], [47.49400, 19.09750], [47.49086, 19.09700]] },
];

const Kel = [47.49907, 19.08255];
// Lines through the district along their real stops (BKK GTFS, June 2026). One direction is listed; the
// other runs back along the same path. A few stops outside the district are kept so trips have length.
export const LINES = [
	{ ref: '99', route: 'bus', from: 'Blaha Lujza tér M', to: 'Udvarhely utca',
		path: [[47.496151, 19.071256], [47.4970, 19.0706], [47.4979, 19.0738], [47.497516, 19.074043], [47.4953, 19.0760], [47.494567, 19.076855], [47.492381, 19.078579], [47.49226, 19.08348], [47.489525, 19.086089], [47.487168, 19.089219], [47.486459, 19.092561], [47.48446, 19.096407], [47.483605, 19.098914], [47.482389, 19.102495], [47.478921, 19.112867], [47.476351, 19.118319]],
		stops: [['Blaha Lujza tér M (Népszínház utca)', 47.496151, 19.071256], ['Kiss József utca', 47.497516, 19.074043], ['II. János Pál pápa tér M', 47.494567, 19.076855], ['Mátyás tér', 47.492381, 19.078579], ['Teleki László tér (Szerdahelyi utca)', 47.492263, 19.083476], ['Kálvária tér', 47.489525, 19.086089], ['Kőris utca', 47.487168, 19.089219], ['Golgota tér', 47.486459, 19.092561], ['Delej utca', 47.48446, 19.096407], ['Bláthy Ottó utca', 47.483605, 19.098914], ['Vajda Péter utca (Villám utca)', 47.482389, 19.102495], ['Népligeti sportközpont', 47.478921, 19.112867], ['Fertő utca / Bihari utca', 47.476351, 19.118319]] },
	{ ref: '24', route: 'tram', from: 'Keleti pályaudvar M', to: 'Közvágóhíd H',
		path: [Kel, [47.4985, 19.0827], [47.496445, 19.08312], [47.4932, 19.0867], [47.492234, 19.08787], [47.489805, 19.09056], [47.484992, 19.092865], [47.481224, 19.093419], [47.479381, 19.089875], [47.476946, 19.08259], [47.476054, 19.076354], [47.474022, 19.070622], [47.470972, 19.073181], [47.467527, 19.075886]],
		stops: [['Keleti pályaudvar M', ...Kel], ['Dologház utca', 47.496445, 19.08312], ['Magdolna utca', 47.492234, 19.08787], ['Orczy tér', 47.489805, 19.09056], ['Golgota tér', 47.484992, 19.092865], ['Elnök utca', 47.481224, 19.093419], ['Nagyvárad tér M', 47.479381, 19.089875], ['Balázs Béla utca', 47.476946, 19.08259], ['Haller utca / Mester utca', 47.476054, 19.076354], ['Haller utca / Soroksári út', 47.474022, 19.070622], ['Müpa - Nemzeti Színház H', 47.470972, 19.073181], ['Közvágóhíd H', 47.467527, 19.075886]] },
	{ ref: '23', route: 'tram', from: 'Keleti pályaudvar M', to: 'Jászai Mari tér',
		path: [Kel, [47.4985, 19.0827], [47.496445, 19.08312], [47.4932, 19.0867], [47.492234, 19.08787], [47.489805, 19.09056], [47.484992, 19.092865], [47.481224, 19.093419], [47.479381, 19.089875], [47.476946, 19.08259], [47.476054, 19.076354], [47.47574, 19.069389], [47.480077, 19.066074], [47.482946, 19.062731]],
		stops: [['Keleti pályaudvar M', ...Kel], ['Dologház utca', 47.496445, 19.08312], ['Magdolna utca', 47.492234, 19.08787], ['Orczy tér', 47.489805, 19.09056], ['Golgota tér', 47.484992, 19.092865], ['Elnök utca', 47.481224, 19.093419], ['Nagyvárad tér M', 47.479381, 19.089875], ['Balázs Béla utca', 47.476946, 19.08259], ['Haller utca / Mester utca', 47.476054, 19.076354], ['Haller utca / Soroksári út', 47.47574, 19.069389], ['Boráros tér H', 47.480077, 19.066074], ['Zsil utca', 47.482946, 19.062731]] },
	{ ref: '28A', route: 'tram', from: 'Blaha Lujza tér M', to: 'Új köztemető (Kozma utca)',
		path: [[47.495648, 19.072742], [47.494819, 19.07655], [47.493604, 19.081884], [47.4932, 19.0867], [47.492234, 19.08787], [47.489805, 19.09056], [47.488949, 19.095496], [47.487614, 19.103854], [47.486343, 19.108577], [47.485136, 19.1131], [47.484018, 19.117198], [47.483106, 19.123287]],
		stops: [['Blaha Lujza tér M (Népszínház utca)', 47.495648, 19.072742], ['II. János Pál pápa tér M', 47.494819, 19.07655], ['Teleki László tér', 47.493604, 19.081884], ['Magdolna utca', 47.492234, 19.08787], ['Orczy tér', 47.489805, 19.09056], ['Kőbányai út 21.', 47.488949, 19.095496], ['Kőbányai út 31.', 47.487614, 19.103854], ['Kőbányai út / Könyves Kálmán körút', 47.486343, 19.108577], ['Eiffel Műhelyház', 47.485136, 19.1131], ['Kismartoni út', 47.484018, 19.117198], ['Mázsa utca', 47.483106, 19.123287]] },
	{ ref: 'M2', route: 'subway', from: 'Déli pályaudvar', to: 'Örs vezér tere',
		path: [[47.494825, 19.062457], [47.49562, 19.06561], [47.497006, 19.070274], [47.49936, 19.07887], [47.499683, 19.082881], [47.49964, 19.09983], [47.500174, 19.106381]],
		stops: [['Astoria', 47.494825, 19.062457], ['Blaha Lujza tér', 47.497006, 19.070274], ['Keleti pályaudvar', 47.499683, 19.082881], ['Puskás Ferenc Stadion', 47.500174, 19.106381]] },
];

// The VIII. district boundary (OpenStreetMap relation 1606100, via an OSM-derived GeoJSON).
export const BOUNDARY = [[47.494351, 19.060003], [47.494381, 19.060137], [47.494468, 19.060523], [47.494967, 19.062602], [47.495036, 19.062884], [47.495079, 19.063057], [47.495423, 19.06436], [47.495453, 19.064479], [47.495597, 19.064997], [47.495783, 19.065702], [47.495885, 19.066067], [47.495968, 19.066359], [47.496059, 19.06668], [47.496172, 19.067064], [47.496518, 19.068291], [47.496553, 19.068433], [47.497109, 19.070463], [47.497141, 19.070588], [47.497178, 19.070696], [47.497246, 19.070918], [47.497461, 19.071659], [47.49766, 19.072356], [47.4977, 19.07249], [47.498026, 19.073663], [47.498065, 19.073809], [47.498464, 19.075336], [47.498768, 19.076476], [47.498907, 19.07703], [47.49899, 19.077364], [47.499044, 19.077574], [47.499323, 19.078645], [47.49938, 19.078854], [47.499521, 19.079543], [47.499937, 19.080421], [47.501549, 19.083886], [47.50181, 19.084441], [47.501821, 19.084468], [47.501822, 19.084819], [47.501852, 19.088829], [47.501842, 19.090926], [47.502, 19.09115], [47.501829, 19.091693], [47.50171, 19.092606], [47.501225, 19.096322], [47.500975, 19.098237], [47.500973, 19.098254], [47.500866, 19.099072], [47.500535, 19.10161], [47.500498, 19.101897], [47.500326, 19.102558], [47.500115, 19.102655], [47.499844, 19.102764], [47.499654, 19.103031], [47.500177, 19.108276], [47.496683, 19.109275], [47.495683, 19.109274], [47.488689, 19.109266], [47.488366, 19.109106], [47.486699, 19.108285], [47.486403, 19.108138], [47.48639, 19.108128], [47.485523, 19.107355], [47.482593, 19.10477], [47.482216, 19.103645], [47.482138, 19.103583], [47.479989, 19.101963], [47.475622, 19.098671], [47.477382, 19.093943], [47.479101, 19.089328], [47.479824, 19.087073], [47.480116, 19.0863], [47.480262, 19.085914], [47.480475, 19.085305], [47.480721, 19.084614], [47.480778, 19.084449], [47.481262, 19.083067], [47.481551, 19.08222], [47.481572, 19.082155], [47.481758, 19.08164], [47.482201, 19.080441], [47.48265, 19.079167], [47.482852, 19.078588], [47.483107, 19.077857], [47.483297, 19.077313], [47.483495, 19.076746], [47.48378, 19.07592], [47.483888, 19.075611], [47.484163, 19.074834], [47.484286, 19.074481], [47.484566, 19.073679], [47.484668, 19.0734], [47.484895, 19.072738], [47.485209, 19.071837], [47.485583, 19.070719], [47.485742, 19.070232], [47.485782, 19.07011], [47.485823, 19.069987], [47.485853, 19.069897], [47.485894, 19.069787], [47.485931, 19.06968], [47.485987, 19.069521], [47.486071, 19.069316], [47.48633, 19.068709], [47.486573, 19.068141], [47.486951, 19.067329], [47.486963, 19.067306], [47.487075, 19.067067], [47.487205, 19.06679], [47.48738, 19.066433], [47.488237, 19.064675], [47.488358, 19.064426], [47.48869, 19.063744], [47.488821, 19.063458], [47.489432, 19.062166], [47.489555, 19.06191], [47.489679, 19.061617], [47.489936, 19.061765], [47.490271, 19.06178], [47.490808, 19.061673], [47.491412, 19.061529], [47.491874, 19.061307], [47.492704, 19.060879]];

const AREAS = [
	{ tags: { landuse: 'cemetery', name: 'Fiumei úti sírkert' }, pts: [[47.49840, 19.08420], [47.49900, 19.09600], [47.49300, 19.09820], [47.49120, 19.09280], [47.49340, 19.08760], [47.49640, 19.08420]] },
	{ tags: { leisure: 'park', name: 'Orczy-kert' }, pts: [[47.48560, 19.08700], [47.48520, 19.09180], [47.48260, 19.09230], [47.48300, 19.08750]] },
	{ tags: { leisure: 'park', name: 'II. János Pál pápa tér' }, pts: [[47.49600, 19.07620], [47.49580, 19.07860], [47.49470, 19.07880], [47.49490, 19.07640]] },
	{ tags: { leisure: 'park', name: 'Teleki László tér' }, pts: [[47.49360, 19.08280], [47.49350, 19.08420], [47.49270, 19.08430], [47.49280, 19.08290]] },
	{ tags: { leisure: 'park', name: 'Mátyás tér' }, pts: [[47.49250, 19.07830], [47.49240, 19.07960], [47.49170, 19.07970], [47.49180, 19.07840]] },
	{ tags: { leisure: 'park', name: 'Horváth Mihály tér' }, pts: [[47.48990, 19.07640], [47.48980, 19.07780], [47.48910, 19.07790], [47.48920, 19.07650]] },
	{ tags: { place: 'square', name: 'Blaha Lujza tér' }, pts: [[47.49750, 19.06960], [47.49770, 19.07160], [47.49650, 19.07190], [47.49630, 19.06990]] },
	{ tags: { place: 'square', name: 'Rákóczi tér' }, pts: [[47.49320, 19.07200], [47.49310, 19.07320], [47.49230, 19.07330], [47.49240, 19.07210]] },
];

// Shops for the offline map (invented positions on real streets; the live OSM map has the real ones).
const POIS = [
	{ shop: 'e-cigarette', name: 'Vape Station', at: [47.49520, 19.07470] },
	{ shop: 'e-cigarette', name: 'Smoke & Vape', at: [47.49150, 19.07175] },
	{ shop: 'e-cigarette', name: 'VapeLand', at: [47.48940, 19.07450] },
	{ shop: 'e-cigarette', name: 'Cloud Vape', at: [47.49370, 19.08120] },
	{ shop: 'e-cigarette', name: 'Vape Point', at: [47.49830, 19.07700] },
	{ shop: 'e-cigarette', name: 'Liquid Shop', at: [47.48880, 19.09500] },
	{ shop: 'tobacco', name: 'Nemzeti Dohánybolt', at: [47.49400, 19.07160] },
	{ shop: 'tobacco', name: 'Nemzeti Dohánybolt', at: [47.48930, 19.08000] },
	{ shop: 'tobacco', name: 'Nemzeti Dohánybolt', at: [47.49660, 19.08330] },
	{ amenity: 'pharmacy', name: 'Patika', at: [47.49330, 19.07170] },
	{ shop: 'convenience', name: 'ABC', at: [47.49470, 19.07600] },
	{ shop: 'convenience', name: 'Non-stop', at: [47.49210, 19.08000] },
	{ amenity: 'bar', name: 'Kocsma', at: [47.49200, 19.08300] },
	{ amenity: 'fast_food', name: 'Gyros', at: [47.49640, 19.07220] },
	{ amenity: 'cafe', name: 'Kávézó', at: [47.48600, 19.07400] },
];

const WIDTH = { primary: 17, secondary: 13, tertiary: 11, residential: 8, pedestrian: 6 };

export function makeFallbackCity() {
	const r = rng(8);
	const els = [];
	let id = 1;
	const geom = (pts) => pts.map(([lat, lon]) => ({ lat, lon }));
	const boundaryXZ = BOUNDARY.map(([lat, lon]) => toXZ(lat, lon));

	els.push({ type: 'relation', id: id++, tags: { boundary: 'administrative', admin_level: '9', name: 'VIII. kerület' }, members: [{ type: 'way', role: 'outer', geometry: geom([...BOUNDARY, BOUNDARY[0]]) }] });

	// Like real OSM, crossing streets must share a node at the junction: insert intersection points.
	const streets = STREETS.map((st) => ({ ...st, pts: st.pts.map((p) => p.slice()) }));
	for (let a = 0; a < streets.length; a++) for (let b = a + 1; b < streets.length; b++) {
		for (let i = 0; i + 1 < streets[a].pts.length; i++) for (let j = 0; j + 1 < streets[b].pts.length; j++) {
			const P = streets[a].pts, Q = streets[b].pts;
			const hit = segmentIntersection(P[i], P[i + 1], Q[j], Q[j + 1]);
			if (!hit) continue;
			P.splice(i + 1, 0, hit);
			Q.splice(j + 1, 0, hit);
			i++;
			break;
		}
	}

	const roadsXZ = [];
	for (const s of streets) {
		els.push({ type: 'way', id: id++, tags: { highway: s.cls, name: s.name }, geometry: geom(s.pts) });
		roadsXZ.push({ pts: s.pts.map(([a, b]) => toXZ(a, b)), w: WIDTH[s.cls] });
	}
	// Tram tracks under the tram lines, plus the Nagykörút tracks (trams 4 and 6) on József körút.
	for (const l of LINES) if (l.route === 'tram') els.push({ type: 'way', id: id++, tags: { railway: 'tram' }, geometry: geom(l.path) });
	els.push({ type: 'way', id: id++, tags: { railway: 'tram' }, geometry: geom(streets[2].pts) }); // trams 4 and 6 on the Nagykörút

	for (const a of AREAS) els.push({ type: 'way', id: id++, tags: a.tags, geometry: geom([...a.pts, a.pts[0]]) });

	// Continuous perimeter-block facades along every street, kept out of junctions and squares.
	const areasXZ = AREAS.map((a) => a.pts.map(([lat, lon]) => toXZ(lat, lon)));
	const nearOtherRoad = (x, z, self, clearance) => roadsXZ.some((rd) => rd !== self && rd.pts.some((p, i) => {
		if (i === 0) return false;
		const [ax, az] = rd.pts[i - 1], [bx, bz] = p;
		const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
		const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
		return (ax + dx * t - x) ** 2 + (az + dz * t - z) ** 2 < (rd.w / 2 + clearance) ** 2;
	}));
	const buildings = [];
	for (const rd of roadsXZ) {
		for (let i = 0; i + 1 < rd.pts.length; i++) {
			const [ax, az] = rd.pts[i], [bx, bz] = rd.pts[i + 1];
			const len = Math.hypot(bx - ax, bz - az);
			const ux = (bx - ax) / len, uz = (bz - az) / len;
			const px = -uz, pz = ux;
			for (const side of [-1, 1]) {
				let s = 6;
				while (s < len - 6) {
					const w = 14 + r() * 18, depth = 13 + r() * 6;
					const s1 = Math.min(len - 4, s + w);
					const off = rd.w / 2 + 3.2;
					const corner = (t, d) => [ax + ux * t + px * side * d, az + uz * t + pz * side * d];
					const quad = [corner(s, off), corner(s1, off), corner(s1, off + depth), corner(s, off + depth)];
					const [cx, cz] = corner((s + s1) / 2, off + depth / 2);
					const blocked = quad.some(([x, z]) => nearOtherRoad(x, z, rd, 2.5)) || areasXZ.some((a) => pointInPolygon(cx, cz, a)) || !pointInPolygon(cx, cz, boundaryXZ) ||
						buildings.some(([bx2, bz2]) => (bx2 - cx) ** 2 + (bz2 - cz) ** 2 < 100);
					if (!blocked) {
						buildings.push([cx, cz]);
						const levels = 3 + Math.floor(r() * 4);
						els.push({ type: 'way', id: id++, tags: { building: 'apartments', 'building:levels': String(levels) }, geometry: geom([...quad, quad[0]].map(([x, z]) => toLatLon(x, z))) });
					}
					s = s1 + 0.2;
				}
			}
		}
	}
	// Plane trees along the big streets and in the squares.
	for (const s of streets.slice(0, 8)) {
		const pts = s.pts.map(([a, b]) => toXZ(a, b));
		for (let i = 0; i + 1 < pts.length; i++) {
			const len = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
			for (let t = 10; t < len; t += 14) {
				const k = t / len;
				const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * k, z = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * k;
				const ux = (pts[i + 1][0] - pts[i][0]) / len, uz = (pts[i + 1][1] - pts[i][1]) / len;
				const off = WIDTH[s.cls] / 2 + 1.2;
				const [lat, lon] = toLatLon(x - uz * off, z + ux * off);
				els.push({ type: 'node', id: id++, lat, lon, tags: { natural: 'tree' } });
			}
		}
	}
	for (const a of areasXZ.slice(1)) for (let k = 0; k < 14; k++) {
		const xs = a.map((p) => p[0]), zs = a.map((p) => p[1]);
		const x = Math.min(...xs) + r() * (Math.max(...xs) - Math.min(...xs)), z = Math.min(...zs) + r() * (Math.max(...zs) - Math.min(...zs));
		if (pointInPolygon(x, z, a)) { const [lat, lon] = toLatLon(x, z); els.push({ type: 'node', id: id++, lat, lon, tags: { natural: 'tree' } }); }
	}
	for (const p of POIS) {
		const tags = { name: p.name };
		if (p.shop) tags.shop = p.shop;
		if (p.amenity) tags.amenity = p.amenity;
		els.push({ type: 'node', id: id++, lat: p.at[0], lon: p.at[1], tags });
	}
	for (const [lat, lon, name] of [[47.497462, 19.070723, 'Blaha Lujza tér'], [47.496862, 19.070699, 'Blaha Lujza tér'], [47.499954, 19.082972, 'Keleti pályaudvar'], [47.499635, 19.0807, 'Keleti pályaudvar']]) {
		els.push({ type: 'node', id: id++, lat, lon, tags: { railway: 'subway_entrance', name } });
	}
	// Route relations, both directions.
	for (const l of LINES) {
		for (const reverse of [false, true]) {
			const pts = reverse ? l.path.slice().reverse() : l.path;
			const stops = reverse ? l.stops.slice().reverse() : l.stops;
			const members = [];
			const stopIds = [];
			for (const [name, lat, lon] of stops) {
				const sid = id++;
				stopIds.push(sid);
				els.push({ type: 'node', id: sid, lat, lon, tags: { name, public_transport: 'stop_position' } });
				members.push({ type: 'node', ref: sid, role: 'stop', lat, lon });
			}
			members.push({ type: 'way', ref: id++, role: '', geometry: geom(pts) });
			els.push({ type: 'relation', id: id++, tags: { type: 'route', route: l.route, ref: l.ref, from: reverse ? l.to : l.from, to: reverse ? l.from : l.to, name: `${l.ref}: ${reverse ? l.to : l.from} => ${reverse ? l.from : l.to}` }, members });
		}
	}
	const data = normalise({ elements: els });
	data.source = 'fallback';
	return data;
}

function segmentIntersection(a, b, c, d) {
	const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
	if (Math.abs(den) < 1e-14) return null;
	const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den;
	const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
	if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return null;
	return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}
