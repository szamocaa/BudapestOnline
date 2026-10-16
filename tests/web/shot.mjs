// Takes screenshots of the game from given viewpoints (headless Chromium + SwiftShader) and prints
// render stats, so changes to the look can be checked without a GPU.
//
//   node tests/web/shot.mjs <spec.json | tour> [outDir] [--size 1280x720] [--params "fallback=1"]
//
// spec.json is a list of shots:
//   [{ "name": "blaha", "time": "2026-10-09T10:30",
//      "at": [47.49660, 19.07040], "lookAt": [47.4958, 19.0722],   // or "yaw": radians
//      "pitch": 0, "height": 1.68,                                  // eye height in metres
//      "metro": 0,                                                  // optional: inside the M2 at Blaha (0) / Keleti (1)
//      "wait": 2500 }]
// "tour" uses tests/web/tour.json (the standard viewpoints of the district).
// Needs Playwright: npm i playwright, or PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const size = flag('--size', '1280x720').split('x').map(Number);
const params = flag('--params', '');
const specArg = args[0] || 'tour';
const outDir = path.resolve(args[1] || path.join(root, 'tests/web/out'));
const specPath = specArg === 'tour' ? path.join(root, 'tests/web/tour.json') : path.resolve(specArg);
const shots = JSON.parse(fs.readFileSync(specPath, 'utf8'));
fs.mkdirSync(outDir, { recursive: true });

const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.hdr': 'application/octet-stream', '.ktx2': 'application/octet-stream', '.glb': 'model/gltf-binary' };
const server = http.createServer((req, res) => {
	const rel = decodeURIComponent(req.url.split('?')[0]);
	const p = path.join(root, rel === '/' ? 'index.html' : rel);
	if (!p.startsWith(root)) { res.writeHead(403); res.end(); return; }
	fs.readFile(p, (err, data) => {
		if (err) { res.writeHead(404); res.end(); return; }
		res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
		res.end(data);
	});
}).listen(0);
const port = server.address().port;

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
const first = shots[0] || {};
const t0 = Date.now();
await page.goto(`http://127.0.0.1:${port}/index.html?test=1&nolive=1&time=${first.time || '2026-10-09T10:30'}${params ? '&' + params : ''}`);
await page.waitForFunction(() => window.__game && window.__game.stats.fps > 0, null, { timeout: 240000 });
const loadSeconds = (Date.now() - t0) / 1000;
const report = { loadSeconds, map: await page.evaluate(() => window.__game.city.source), shots: [] };

for (const s of shots) {
	await page.evaluate(async (s) => {
		const g = window.__game;
		if (s.time) g.setTime(s.time);
		if (s.metro != null) { g.enterMetro(s.metro); return; }
		if (g.state().mode === 'metro') g.leaveMetro && g.leaveMetro();
		g.view(s);
	}, s);
	await page.waitForTimeout(s.wait || 2500);
	const stats = await page.evaluate(() => { const g = window.__game; return { fps: g.stats.fps, people: g.stats.people, drawn: g.stats.drawn, vehicles: g.stats.vehicles, render: g.stats.render, street: g.world.streetAt(g.player.x, g.player.z) }; });
	const file = path.join(outDir, `${s.name}.png`);
	await page.screenshot({ path: file });
	report.shots.push({ name: s.name, file, ...stats });
	console.log(`${s.name}: ${stats.render ? `${stats.render.drawCalls} draw calls, ${(stats.render.triangles / 1e6).toFixed(2)} M triangles` : ''}, ${stats.drawn} people drawn, street: ${stats.street || '-'}`);
}
report.errors = errors;
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 1));
console.log(`map: ${report.map}, load ${loadSeconds.toFixed(1)} s`);
console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no console errors');
await browser.close();
server.close();
