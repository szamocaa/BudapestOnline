// End-to-end smoke test in headless Chromium (needs: npm i playwright, or PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs).
// Serves the repo, starts the game in test mode with the offline map, and checks it runs at
// several times of day, riding a tram and the M2. Screenshots go to tests/web/out/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'tests/web/out');
fs.mkdirSync(out, { recursive: true });
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
	const p = path.join(root, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
	if (!p.startsWith(root)) { res.writeHead(403); res.end(); return; }
	fs.readFile(p, (err, data) => {
		if (err) { res.writeHead(404); res.end(); return; }
		res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
		res.end(data);
	});
}).listen(0);
const port = server.address().port;
const extra = process.argv[2] || '';
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`http://127.0.0.1:${port}/index.html?test=1&fallback=1&nolive=1&time=2026-10-09T10:30${extra}`);
await page.waitForFunction(() => window.__game && window.__game.stats.fps > 0, null, { timeout: 120000 });
const wait = (ms) => page.waitForTimeout(ms);
const results = {};
async function snap(name, iso) {
	if (iso) await page.evaluate((t) => window.__game.setTime(t), iso);
	await wait(2500);
	results[name] = await page.evaluate(() => { const s = window.__game.state(); return { ...window.__game.stats, ...s, ride: s.ride ? s.ride.key : null }; });
	await page.screenshot({ path: path.join(out, `${name}.png`) });
}
await snap('morning', '2026-10-09T10:30');
await snap('evening', '2026-10-09T18:45');
await snap('night', '2026-10-09T23:30');
// Look along Népszínház utca from above to see the tram and the street.
await page.evaluate(() => { const g = window.__game; g.setTime('2026-10-09T12:00'); g.player.pitch = -0.35; });
await snap('noon-street');
// Ride: find a tram stopped at a stop, teleport next to it and press E.
const boarded = await page.evaluate(async () => {
	const g = window.__game;
	for (let k = 0; k < 400; k++) {
		const v = g.transit.vehicles.find((x) => x.atStop && x.line.mode !== 'metro' && x.leavesIn > 4);
		if (v) {
			g.player.teleport(v.x + 2, v.z + 2);
			await new Promise((r) => setTimeout(r, 300));
			g.press('KeyE');
			await new Promise((r) => setTimeout(r, 300));
			return { ref: v.ref, stop: v.stopName, ride: !!g.state().ride };
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	return null;
});
results.boarded = boarded;
await wait(4000);
await page.screenshot({ path: path.join(out, 'riding.png') });
results.riding = await page.evaluate(() => { const s = window.__game.state(); return { ...s, ride: s.ride ? { ref: s.ride.lastState.ref, headsign: s.ride.lastState.headsign } : null }; });
// Metro.
await page.evaluate(() => window.__game.enterMetro(0));
await wait(2500);
await page.screenshot({ path: path.join(out, 'metro.png') });
results.metro = await page.evaluate(() => ({ state: window.__game.metro.state, msg: window.__game.metro.message }));
console.log(JSON.stringify(results, null, 1));
console.log(errors.length ? `CONSOLE ISSUES (${errors.length}):\n` + [...new Set(errors)].slice(0, 30).join('\n') : 'no console errors');
await browser.close();
server.close();
