#!/usr/bin/env node
// Downloads the shapes and stops of the game's BKK lines (99, 23, 24, 28A, M2) from the BKK FUTÁR
// API and saves them as data/bkk-lines.json, so the routes are exact even when the API cannot be
// reached from the player's browser. Needs Node 18+ and internet.
//
//   node tools/bake_bkk.mjs
//
// Data: BKK Zrt., CC BY 4.0.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../game/config.js';
import { BkkClient } from '../game/transit/bkk.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'data', 'bkk-lines.json');
const REFS = ['99', '23', '24', '28A', 'M2'];

const client = new BkkClient({ key: process.env.BKK_KEY || CONFIG.bkkKey, bases: CONFIG.bkkBases });
const lines = await client.routeDetails(REFS);
if (!lines.length) {
	console.error('The BKK API returned no lines.');
	process.exit(1);
}
const data = { version: 1, source: 'BKK FUTÁR', createdAt: new Date().toISOString(), lines: lines.map((l) => ({ ...l, directions: l.directions.map(({ cum, ...d }) => d) })) };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(data));
console.log(`Saved ${path.relative(root, out)}: ${lines.map((l) => `${l.ref} (${l.directions.length} irány, ${l.directions.reduce((n, d) => n + d.stops.length, 0)} megálló)`).join(', ')}`);
