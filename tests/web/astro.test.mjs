// Checks game/astro.js against the same PyEphem + tz database reference as the C++ version.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { sunPosition, moonPosition, budapestOffsetHours, budapestHours } from '../../game/astro.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const rows = fs.readFileSync(path.join(here, '../../Tools/CoreTests/astro_reference.csv'), 'utf8').trim().split('\n').slice(1);
const LAT = 47.4977, LON = 19.0541;
const angle = (a, b) => { let d = (a - b) % 360; if (d > 180) d -= 360; if (d < -180) d += 360; return Math.abs(d); };
let worst = { sunEl: 0, sunAz: 0, moonEl: 0, moonAz: 0, illum: 0 };
for (const row of rows) {
	const [unix, sEl, sAz, mEl, mAz, ill, off] = row.split(',').map(Number);
	const s = sunPosition(unix, LAT, LON), m = moonPosition(unix, LAT, LON);
	worst.sunEl = Math.max(worst.sunEl, Math.abs(s.elevation - sEl));
	worst.sunAz = Math.max(worst.sunAz, angle(s.azimuth, sAz));
	worst.moonEl = Math.max(worst.moonEl, Math.abs(m.elevation - mEl));
	worst.moonAz = Math.max(worst.moonAz, angle(m.azimuth, mAz));
	worst.illum = Math.max(worst.illum, Math.abs(m.illumination - ill));
	assert.equal(budapestOffsetHours(unix), off, `offset at ${unix}`);
}
assert.ok(rows.length > 1000);
assert.ok(worst.sunEl < 0.05 && worst.sunAz < 0.1, JSON.stringify(worst));
assert.ok(worst.moonEl < 0.5 && worst.moonAz < 1.0 && worst.illum < 0.02, JSON.stringify(worst));
assert.equal(budapestHours(Date.UTC(2026, 5, 21, 10, 0, 0) / 1000), 12);
assert.equal(budapestHours(Date.UTC(2026, 11, 21, 23, 30, 0) / 1000), 0.5);
console.log(`ok astro.js: ${rows.length} rows, worst ${JSON.stringify(Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, +v.toFixed(4)])))}`);
