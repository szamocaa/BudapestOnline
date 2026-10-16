#!/usr/bin/env node
// Downloads the VIII. district from OpenStreetMap once and saves it as data/district8.json, so the
// game loads instantly (no Overpass wait) and works offline. Needs Node 18+ and internet.
//
//   node tools/bake_snapshot.mjs                 # download from Overpass
//   node tools/bake_snapshot.mjs --raw dump.json # use a saved Overpass response instead
//
// Map data (c) OpenStreetMap contributors, ODbL. If you publish data/district8.json, keep this
// attribution and publish it under the ODbL as well.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildQuery, normalise, cityStats, OVERPASS_ENDPOINTS } from '../game/osm.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'data', 'district8.json');
const rawArg = process.argv.indexOf('--raw');

let raw;
if (rawArg > 0) {
	raw = JSON.parse(fs.readFileSync(process.argv[rawArg + 1], 'utf8'));
} else {
	for (const endpoint of OVERPASS_ENDPOINTS) {
		try {
			console.log(`Downloading from ${endpoint} (can take a minute)...`);
			const res = await fetch(endpoint, { method: 'POST', body: 'data=' + encodeURIComponent(buildQuery()), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'budapest-online-snapshot/1.0' } });
			if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 400)}`);
			raw = await res.json();
			break;
		} catch (err) {
			console.warn(`  failed: ${err.message}`);
		}
	}
	if (!raw) {
		console.error('All Overpass servers failed. Try again later.');
		process.exit(1);
	}
}
const data = normalise(raw);
data.source = 'snapshot';
data.createdAt = new Date().toISOString();
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(data));
console.log(`Saved ${path.relative(root, out)}: ${cityStats(data)}, ${(fs.statSync(out).size / 1e6).toFixed(1)} MB`);
