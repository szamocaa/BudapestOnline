#!/usr/bin/env node
// Converts an OSM XML file (e.g. from `osmium cat -f osm`) into the JSON that Overpass returns for
// `out geom`, so tools/bake_snapshot.mjs --raw can bake the map without an Overpass server.
//
//   node tools/osm_xml_to_overpass.mjs extract.osm raw.json
//
// Relations are filtered to what the game's Overpass query selects: the VIII. district boundary,
// building (part) and park/cemetery multipolygons, and the routes of our lines. (A complete
// extract would otherwise drag in e.g. the whole Danube riverbank or the country border.)
import fs from 'node:fs';
import readline from 'node:readline';
import { LINE_REFS, LINE_ROUTE } from '../game/osm.js';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
	console.error('usage: node tools/osm_xml_to_overpass.mjs extract.osm raw.json');
	process.exit(1);
}
const DISTRICT_RELATION = 1606100;

const ENT = { '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&apos;': "'" };
const unescape = (s) => s.replace(/&(quot|amp|lt|gt|apos|#\d+|#x[0-9a-f]+);/gi, (m) => ENT[m] || (m[1] === '#' ? String.fromCodePoint(m[2] === 'x' || m[2] === 'X' ? parseInt(m.slice(3, -1), 16) : parseInt(m.slice(2, -1), 10)) : m));
const attrs = (line) => {
	const o = {};
	for (const m of line.matchAll(/(\w+)="([^"]*)"/g)) o[m[1]] = m[2];
	return o;
};

const nodes = new Map(); // id -> [lat, lon]
const taggedNodes = [];
const ways = new Map(); // id -> { id, tags, refs }
const relations = [];
let cur = null;

const rl = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });
for await (const raw of rl) {
	const line = raw.trim();
	if (line.startsWith('<node ')) {
		const a = attrs(line);
		const id = Number(a.id);
		nodes.set(id, [Number(a.lat), Number(a.lon)]);
		cur = line.endsWith('/>') ? null : { type: 'node', id, lat: Number(a.lat), lon: Number(a.lon), tags: {} };
	} else if (line.startsWith('<way ')) {
		cur = { type: 'way', id: Number(attrs(line).id), tags: {}, refs: [] };
		if (line.endsWith('/>')) { ways.set(cur.id, cur); cur = null; }
	} else if (line.startsWith('<relation ')) {
		cur = { type: 'relation', id: Number(attrs(line).id), tags: {}, members: [] };
		if (line.endsWith('/>')) { relations.push(cur); cur = null; }
	} else if (line.startsWith('<tag ') && cur) {
		const a = attrs(line);
		cur.tags[unescape(a.k)] = unescape(a.v);
	} else if (line.startsWith('<nd ') && cur) {
		cur.refs.push(Number(attrs(line).ref));
	} else if (line.startsWith('<member ') && cur) {
		const a = attrs(line);
		cur.members.push({ type: a.type, ref: Number(a.ref), role: unescape(a.role || '') });
	} else if (line === '</node>' && cur) {
		if (Object.keys(cur.tags).length) taggedNodes.push(cur);
		cur = null;
	} else if (line === '</way>' && cur) {
		ways.set(cur.id, cur);
		cur = null;
	} else if (line === '</relation>' && cur) {
		relations.push(cur);
		cur = null;
	}
}

function wanted(r) {
	const t = r.tags;
	if (r.id === DISTRICT_RELATION) return true;
	if (t.type === 'route') return LINE_REFS.includes(t.ref) && LINE_ROUTE[t.ref] === t.route;
	if (t.type !== 'multipolygon') return false;
	return !!(t.building || t['building:part'] || t.leisure === 'park' || t.landuse === 'cemetery');
}

const geometryOf = (way) => way.refs.map((r) => nodes.get(r)).filter(Boolean).map(([lat, lon]) => ({ lat, lon }));
const elements = [];
for (const n of taggedNodes) elements.push(n);
for (const w of ways.values()) {
	const geometry = geometryOf(w);
	if (geometry.length >= 2) elements.push({ type: 'way', id: w.id, tags: w.tags, nodes: w.refs, geometry });
}
for (const r of relations) {
	if (!wanted(r)) continue;
	const members = [];
	for (const m of r.members) {
		if (m.type === 'way') {
			const w = ways.get(m.ref);
			if (w) members.push({ type: 'way', ref: m.ref, role: m.role, geometry: geometryOf(w) });
		} else if (m.type === 'node') {
			const n = nodes.get(m.ref);
			if (n) members.push({ type: 'node', ref: m.ref, role: m.role, lat: n[0], lon: n[1] });
		}
	}
	elements.push({ type: 'relation', id: r.id, tags: r.tags, members });
}
fs.writeFileSync(output, JSON.stringify({ version: 0.6, generator: 'osm_xml_to_overpass', elements }));
console.log(`${output}: ${taggedNodes.length} tagged nodes, ${ways.size} ways, ${relations.length} relations`);
