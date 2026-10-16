// Budapest Online – Józsefváros. Boots the data, builds the city and runs the game loop.
import * as THREE from './vendor/three.module.min.js';
import { CONFIG, applyUrlOverrides, parseBudapestTime } from './config.js';
import { toXZ } from './geo.js';
import { budapestHours, budapestClock, budapestOffsetHours } from './astro.js';
import { fetchOverpass, normalise, loadCached, saveCached, cityStats, DATA_VERSION, cumulative } from './osm.js';
import { makeFallbackCity } from './fallback.js';
import { buildCity } from './city/index.js';
import { Sky } from './sky.js';
import { createPipeline } from './render/pipeline.js';
import { createHud, fmtFt } from './ui/hud.js';
import { Traffic } from './traffic/traffic.js';
import { AudioSystem } from './audio/audio.js';
import { buildWalkGraph, Crowd, densityForHour } from './crowd.js';
import { CrowdView } from './npcView.js';
import { DangerSystem, dangerLabel } from './danger.js';
import { placeVendors, vendorOpen, VAPE_MENU } from './vendors.js';
import { Player } from './player.js';
import { Minimap } from './minimap.js';
import { TransitSystem } from './transit/system.js';
import { VehicleView } from './transit/view.js';
import { buildTransitInfra } from './transit/infra.js';
import { BkkClient } from './transit/bkk.js';
import { LINE_DEFAULTS, headwayAt, serviceClock } from './transit/schedule.js';
import { Metro, STATIONS } from './metro.js';
import { buildEntrances } from './metro/entrances.js';

applyUrlOverrides(CONFIG);
const $ = (id) => document.getElementById(id);
const REFS = ['99', '23', '24', '28A', 'M2'];
const PLACES = { blaha: [47.4969, 19.0707], keleti: [47.4998, 19.0826], clinics: [47.4828, 19.0792], spawn: [47.4958, 19.0722] };

const hud = createHud();
const setStatus = (text, progress) => hud.status(text, progress);
const toast = (text) => hud.toast(text);

// ---------------------------------------------------------------- data loading

async function loadCity() {
	if (CONFIG.forceFallback) return makeFallbackCity();
	try {
		const res = await fetch('data/district8.json', { cache: 'no-cache' });
		if (res.ok) {
			const d = await res.json();
			if (d.version === DATA_VERSION) {
				d.source = 'snapshot';
				return d;
			}
		}
	} catch { /* no snapshot */ }
	const cached = await loadCached();
	if (cached) {
		cached.source = 'cache';
		return cached;
	}
	// Live OpenStreetMap download straight from the browser, with a way out if it is slow.
	const abort = new AbortController();
	const skipped = new Promise((resolve) => hud.loadingButton({ label: 'Kihagyom – egyszerűsített térkép', onClick: () => { abort.abort(); resolve(null); } }));
	const started = performance.now();
	const tick = setInterval(() => setStatus(`Valódi térkép letöltése az OpenStreetMapről… ${Math.round((performance.now() - started) / 1000)} mp (első alkalommal 20–90 mp, utána gyorsítótárból)`), 500);
	try {
		const raw = await Promise.race([fetchOverpass((t) => setStatus(t), abort.signal), skipped]);
		if (raw) {
			setStatus('Térkép feldolgozása…', 0.4);
			const d = normalise(raw);
			d.source = 'openstreetmap';
			saveCached(d);
			return d;
		}
	} catch (err) {
		toast(`Térkép: ${err.message} – egyszerűsített térképpel indulunk.`);
	} finally {
		clearInterval(tick);
		hud.loadingButton(null);
	}
	return makeFallbackCity();
}

function linesFromOsm(routes) {
	const byRef = new Map();
	for (const r of routes || []) {
		if (!byRef.has(r.ref)) byRef.set(r.ref, { ref: r.ref, mode: r.mode, colour: r.colour || LINE_DEFAULTS[r.ref]?.colour, text: LINE_DEFAULTS[r.ref]?.text, name: r.name, directions: [] });
		byRef.get(r.ref).directions.push({ headsign: r.to || r.name, pts: r.pts, stops: r.stops });
	}
	return [...byRef.values()];
}

async function loadLines(city, client) {
	let lines = [];
	let source = 'menetrend (OSM)';
	if (client && !CONFIG.noLive) {
		try {
			const cached = JSON.parse(localStorage.getItem('bkk-lines-v1') || 'null');
			if (cached && Date.now() - cached.at < 7 * 86400e3) lines = cached.lines;
		} catch { /* ignore */ }
		if (!lines.length) {
			try {
				setStatus('BKK vonalak letöltése (99, 23, 24, 28A, M2)…', 0.7);
				lines = await client.routeDetails(REFS);
				try { localStorage.setItem('bkk-lines-v1', JSON.stringify({ at: Date.now(), lines: lines.map((l) => ({ ...l, directions: l.directions.map(({ cum, ...d }) => d) })) })); } catch { /* full */ }
			} catch (err) {
				toast(`BKK API: ${err.message} – a térkép szerinti útvonalakat használom.`);
			}
		}
		if (lines.length) source = 'BKK';
	}
	// Exact BKK shapes saved with the game (tools/bake_bkk.mjs), for when the API is out of reach.
	if (!lines.length && !CONFIG.forceFallback) {
		try {
			const res = await fetch('data/bkk-lines.json', { cache: 'no-cache' });
			if (res.ok) {
				const saved = await res.json();
				if (saved.version === 1 && saved.lines && saved.lines.length) {
					lines = saved.lines;
					source = 'BKK (mentett)';
				}
			}
		} catch { /* no saved lines */ }
	}
	// Fill in any line BKK did not give us from OpenStreetMap, then from the built-in fallback.
	for (const extra of [linesFromOsm(city.routes), city.fallbackLines || []]) {
		for (const l of extra) if (!lines.some((x) => x.ref === l.ref) && l.directions.length) lines.push(l);
	}
	for (const l of lines) for (const d of l.directions) if (!d.cum) d.cum = cumulative(d.pts);
	return { lines, source };
}

// ---------------------------------------------------------------- boot

async function main() {
	setStatus('Indulás…', 0.05);
	const canvas = $('view');
	const pipeline = createPipeline(canvas, { quality: CONFIG.quality });
	const renderer = pipeline.renderer;

	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 3000);

	setStatus('Térkép betöltése…', 0.1);
	const city = await loadCity();
	setStatus(`Város építése: ${cityStats(city)}…`, 0.5);
	await new Promise((r) => setTimeout(r, 30));
	const world = buildCity(scene, city, { quality: CONFIG.quality });
	const sky = new Sky(scene, renderer);

	const client = CONFIG.bkkKey ? new BkkClient({ key: CONFIG.bkkKey, bases: CONFIG.bkkBases }) : null;
	const { lines, source: lineSource } = await loadLines(city, client);
	const transit = new TransitSystem(lines);
	const vehicleView = new VehicleView(scene);
	const infra = buildTransitInfra(scene, city, lines, world, { quality: CONFIG.quality });
	const traffic = new Traffic(scene, city, world, { quality: CONFIG.quality });
	const audio = new AudioSystem();

	setStatus('Emberek az utcán…', 0.85);
	const graph = buildWalkGraph(city.roads);
	const crowd = new Crowd(graph, CONFIG.people + 200, 2024);
	const crowdView = new CrowdView(scene, crowd, { max: CONFIG.drawPeople, radius: 170 });
	const vendors = placeVendors(scene, city, graph, crowd, world);
	const danger = new DangerSystem(crowd, { lightAt: (x, z) => (sky.state.night > 0.5 ? world.lightAt(x, z) : 1) });

	const player = new Player(camera, canvas, world);
	player.money = CONFIG.startMoney;
	const metro = new Metro();

	// M2 entrances: mapped ones near the stations, else the station points themselves.
	const stationXZ = [toXZ(...PLACES.blaha), toXZ(...PLACES.keleti)];
	const m2 = transit.byRef.get('M2');
	if (m2) for (const d of m2.directions) for (const s of d.stops) {
		if (s.name.startsWith('Blaha')) stationXZ[0] = [s.x, s.z];
		if (s.name.startsWith('Keleti')) stationXZ[1] = [s.x, s.z];
	}
	let entrances = city.entrances.filter((e) => stationXZ.some(([x, z]) => (e.x - x) ** 2 + (e.z - z) ** 2 < 260 * 260));
	if (!entrances.length) entrances = stationXZ.map(([x, z], i) => ({ x, z, name: STATIONS[i] }));
	const mapped = new Set(entrances);
	entrances = entrances.map((e) => {
		const st = (e.x - stationXZ[0][0]) ** 2 + (e.z - stationXZ[0][1]) ** 2 < (e.x - stationXZ[1][0]) ** 2 + (e.z - stationXZ[1][1]) ** 2 ? 0 : 1;
		return { ...e, station: st, mapped: mapped.has(e) };
	});
	const entranceView = buildEntrances(scene, entrances, world);

	const minimap = new Minimap($('minimap'), city, lines);

	// Spawn at Blaha Lujza tér, looking down Népszínház utca.
	const [bx, bz] = toXZ(...PLACES.spawn);
	const spawnNode = graph.nearest(bx, bz, 400);
	const [sx, sz] = spawnNode >= 0 ? graph.nodes[spawnNode] : [bx, bz];
	player.teleport(sx, sz, Math.atan2(-1, 0.4));

	// ---------------------------------------------------------------- time
	let realtime = !CONFIG.time && CONFIG.speed === 1;
	let unix = CONFIG.time ? parseBudapestTime(CONFIG.time, budapestOffsetHours) || Date.now() / 1000 : Date.now() / 1000;
	let speed = CONFIG.speed;
	const speeds = [0, 1, 10, 60, 300, 1200];

	// ---------------------------------------------------------------- live BKK data
	let liveStatus = client && !CONFIG.noLive ? 'kapcsolódás…' : 'kikapcsolva';
	let liveCount = 0;
	let polling = false;
	async function pollLive() {
		if (!client || CONFIG.noLive || polling || document.hidden || !realtime) return;
		polling = true;
		try {
			const list = await client.vehicles(REFS);
			transit.setLive(list, Date.now() / 1000);
			liveCount = list.length;
			liveStatus = list.length ? `élő (${list.length} jármű)` : 'nincs élő jármű – menetrend';
		} catch (err) {
			liveStatus = `nem elérhető (${err.message}) – menetrend`;
		} finally {
			polling = false;
		}
	}
	pollLive();
	setInterval(pollLive, CONFIG.livePollSeconds * 1000);

	// ---------------------------------------------------------------- input
	const pressed = new Set();
	window.addEventListener('keydown', (e) => { if (!e.repeat) pressed.add(e.code); });
	const input = { down: (c) => player.keys.has(c), pressed: (c) => pressed.has(c) };
	let mode = 'street'; // 'street' | 'metro'
	let dialog = null; // encounter or shop
	let ride = null; // { key, line, headsign }

	const dangerCallbacks = {
		onEncounter: (e) => {
			dialog = { type: 'encounter', kind: e.kind };
			audio.event('encounter', { kind: e.kind });
			const opts = e.kind === 'mugging'
				? ['Odaadom a pénzt', 'Megpróbálok lelépni', `Gázspray (${player.spray} db)`, 'Visszaütök']
				: ['Adok egy százast', 'Bocsi, nincs nálam', `Gázspray (${player.spray} db)`, 'Elküldöm a francba'];
			showDialog(e.kind === 'mugging' ? 'Valaki elállja az utad' : 'Odajön hozzád valaki', `„${e.line}”`, opts);
		},
		onPickpocket: (amount) => {
			const lost = Math.min(player.money, amount);
			player.money -= lost;
			if (lost > 0) toast(`Zsebes! Hiányzik ${fmtFt(lost)} a zsebedből.`);
		},
		onEnd: (kind, outcome) => {
			hideDialog();
			dialog = null;
			resolveOutcome(kind, outcome);
		},
	};

	function resolveOutcome(kind, outcome) {
		const take = (k) => { const lost = Math.round(player.money * k); player.money -= lost; return lost; };
		switch (outcome) {
			case 'paid':
				if (kind === 'mugging') toast(`Odaadtad: ${fmtFt(take(0.7))}. Legalább nem esett bajod.`);
				else { player.money = Math.max(0, player.money - 100); toast('„Kösz, tesó, jó napot!”'); }
				break;
			case 'sprayed': toast('Lefújtad gázsprayvel – elmenekül.'); break;
			case 'fight-won': player.health -= 5; toast('Behúztál neki, inkább elszaladt.'); break;
			case 'fight-lost': player.health -= 35; toast(`Rosszul sült el: megvertek és elvittek ${fmtFt(take(0.4))}.`); break;
			case 'robbed': player.health -= 10; toast(`Kiraboltak! Elvittek ${fmtFt(take(0.6))}.`); break;
			case 'left': toast('Morogva továbbállt.'); break;
			case 'walked-away':
			case 'escaped': toast('Leléptél.'); break;
			case 'ignored': toast('Továbbment.'); break;
			default: break;
		}
	}

	const showDialog = (who, say, options) => hud.dialog(who, say, options);
	const hideDialog = () => hud.hideDialogs();

	function openShop(v) {
		dialog = { type: 'shop', vendor: v };
		hud.shop(v.shop ? v.name : 'Vape árus', '„Mit adhatok, főnök?”', VAPE_MENU);
		audio.event('shop', { vendor: v });
	}

	// Touch controls: virtual stick and an E button.
	const stick = $('touch');
	stick.addEventListener('touchmove', (e) => {
		const t = e.touches[0], r = stick.getBoundingClientRect();
		player.touchMove.x = Math.max(-1, Math.min(1, (t.clientX - r.left - r.width / 2) / (r.width / 2)));
		player.touchMove.y = Math.max(-1, Math.min(1, (t.clientY - r.top - r.height / 2) / (r.height / 2)));
		e.preventDefault();
	}, { passive: false });
	stick.addEventListener('touchend', () => (player.touchMove.x = player.touchMove.y = 0));
	$('touchE').addEventListener('touchstart', (e) => { pressed.add('KeyE'); e.preventDefault(); }, { passive: false });
	$('touchJump').addEventListener('touchstart', (e) => { player.touchJump = true; e.preventDefault(); }, { passive: false });
	$('touchJump').addEventListener('touchend', () => (player.touchJump = false));

	// ---------------------------------------------------------------- start screen
	setStatus(`Kész. Térkép: ${city.source === 'fallback' ? 'egyszerűsített (offline)' : 'OpenStreetMap'} · Vonalak: ${lineSource}`, 1);
	const begin = () => {
		hud.loadingButton(null);
		hud.enterGame();
		player.lock();
		audio.start();
		let seen = false;
		try { seen = !!localStorage.getItem('bo-help-seen'); localStorage.setItem('bo-help-seen', '1'); } catch { /* storage blocked */ }
		if (!seen) {
			hud.help(true);
			setTimeout(() => hud.help(false), 7000);
		}
		toast('Blaha Lujza tér. A villamosok és buszok a megállókban állnak meg – E-vel szállsz fel.');
	};
	hud.loadingButton({ label: 'Indulás', onClick: begin });
	if (CONFIG.test) begin();
	canvas.addEventListener('click', () => player.lock());
	window.addEventListener('resize', () => {
		pipeline.resize(window.innerWidth, window.innerHeight);
		camera.aspect = metro.camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		metro.camera.updateProjectionMatrix();
	});
	metro.camera.aspect = window.innerWidth / window.innerHeight;
	metro.camera.updateProjectionMatrix();

	// ---------------------------------------------------------------- loop
	let last = performance.now();
	let frameNo = 0;
	let hudTimer = 0, fps = 60, regen = 0;
	const stats = { fps: 0, people: 0, drawn: 0, vehicles: 0, render: null };
	let st = sky.update(unix, camera.position);
	/**
	 * The per-frame state shared with every module's update(frame):
	 *   dt (real s, max 0.1), simDt (simulated s), unix, hours, dayIndex, frameNo,
	 *   mode ('street' | 'metro'), sky ({ sunEl, moonEl, night 0..1, day 0..1, golden 0..1, illumination }),
	 *   camera (the active one), player, world, vehicles (transit vehicles near the player), crowd,
	 *   ride (null or { key }), danger (0..1), metro, quality.
	 */
	const frameState = { dt: 0, simDt: 0, unix, hours: 0, dayIndex: 0, frameNo: 0, mode, sky: st, camera, player, world, vehicles: [], crowd, ride, danger: 0, metro, quality: CONFIG.quality };

	function loop(now) {
		requestAnimationFrame(loop);
		const dt = Math.min(0.1, (now - last) / 1000);
		last = now;
		frameNo++;
		fps = fps * 0.95 + (1 / Math.max(dt, 1e-3)) * 0.05;

		// Time.
		if (pressed.has('BracketRight') || pressed.has('BracketLeft')) {
			const i = speeds.indexOf(speed) < 0 ? 1 : speeds.indexOf(speed);
			speed = speeds[Math.max(0, Math.min(speeds.length - 1, i + (pressed.has('BracketRight') ? 1 : -1)))];
			realtime = false;
			toast(speed === 1 ? 'Idő: valós sebesség' : speed === 0 ? 'Idő: megállítva' : `Idő: ${speed}× gyorsítva (élő BKK adat szünetel)`);
		}
		if (realtime) unix = Date.now() / 1000;
		else unix += dt * speed;
		const hours = budapestHours(unix);
		const clock = budapestClock(unix);
		const simDt = realtime ? dt : dt * Math.min(speed, 60);

		if (pressed.has('KeyH')) hud.help();
		if (pressed.has('KeyM')) minimap.zoom = minimap.zoom > 1 ? 0.6 : 1.6;

		const svc = serviceClock(hours, clock.dayIndex);
		const ctx = { transit, hours, dayIndex: clock.dayIndex, seconds: svc.seconds, headway: headwayAt(LINE_DEFAULTS.M2, hours, svc.weekend), clock: clock.time };
		const frame = frameState;
		Object.assign(frame, { dt, simDt, unix, hours, dayIndex: clock.dayIndex, frameNo, mode, ride, danger: danger.level });

		if (mode === 'metro') {
			const r = metro.update(dt, input, player, ctx);
			if (r && r.action === 'surface') {
				mode = 'street';
				const e = entrances.find((x) => x.station === r.station) || entrances[0];
				const [ex, ez] = world.collide(e.x + 2, e.z + 2, 0.4);
				player.teleport(ex, ez);
				toast(`Felértél: ${STATIONS[r.station]}`);
				audio.event('surface', { station: r.station });
			}
			frame.camera = metro.camera;
			audio.update(frame);
			pipeline.render(metro.scene, metro.camera, frame);
			stats.render = pipeline.info();
			setPrompt(metro.prompt);
			hud.ride({ ref: 'M2', mode: 'metro', text: metro.message });
		} else {
			// City simulation.
			st = sky.update(unix, camera.position);
			frame.sky = st;
			frame.camera = camera;
			world.setNight(st.night);
			const targetPeople = Math.round(CONFIG.people * densityForHour(hours));
			crowd.balance(targetPeople, crowd.n < targetPeople * 0.6 ? 150 : 25, { x: player.x, z: player.z, r: 260, share: 0.7 });
			crowd.step(simDt, unix);
			const vehicles = transit.update(simDt, unix, hours, clock.dayIndex);
			const near = vehicles.filter((v) => (v.x - player.x) ** 2 + (v.z - player.z) ** 2 < 1600 * 1600);
			vehicleView.update(near, frameNo, st.night);
			frame.vehicles = near;

			// Riding.
			let seat = null;
			if (ride) {
				const v = transit.stateOf(ride.key);
				seat = vehicleView.seat(ride.key);
				if (!v || !seat) {
					alight(v || ride.lastState);
				} else {
					ride.lastState = v;
					hud.ride({ ref: v.ref, mode: v.line.mode === 'tram' ? 'tram' : 'bus', headsign: v.headsign || '', line2: v.atStop ? 'Megálló: ' + v.stopName : 'Következik: ' + (v.nextStop || '—') });
				}
			} else {
				hud.ride(null);
			}
			player.riding = ride ? ride.key : null;
			player.update(dt, seat);

			// Encounters (only on foot, not in dialogs with vendors).
			if (!ride && (!dialog || dialog.type === 'encounter')) danger.update(simDt, unix, hours, player, dangerCallbacks);

			// Interactions.
			let prompt = '';
			if (dialog && dialog.type === 'encounter') {
				for (let k = 1; k <= 4; k++) if (pressed.has(`Digit${k}`)) {
					const action = ['pay', 'refuse', 'spray', 'punch'][k - 1];
					if (action === 'spray' && player.spray <= 0) { toast('Nincs több gázsprayd!'); continue; }
					if (action === 'spray') player.spray--;
					danger.respond(action, dangerCallbacks);
				}
			} else if (dialog && dialog.type === 'shop') {
				for (let k = 1; k <= VAPE_MENU.length; k++) if (pressed.has(`Digit${k}`)) {
					const item = VAPE_MENU[k - 1];
					if (player.money >= item.price) { player.money -= item.price; toast(`Vettél: ${item.name} (${fmtFt(item.price)})`); }
					else toast('Erre most nincs elég pénzed.');
				}
				if (pressed.has('KeyE') || pressed.has('Escape') || Math.hypot(dialog.vendor.x - player.x, dialog.vendor.z - player.z) > 5) { hideDialog(); dialog = null; }
			} else if (ride) {
				const v = transit.stateOf(ride.key);
				if (v && v.atStop) {
					prompt = `<kbd>E</kbd>Leszállás: ${v.stopName}`;
					if (pressed.has('KeyE')) alight(v);
				}
			} else {
				const bv = transit.boardable(player.x, player.z);
				const ent = entrances.find((e) => (e.x - player.x) ** 2 + (e.z - player.z) ** 2 < 25);
				const vend = vendors.find((v) => (v.x - player.x) ** 2 + (v.z - player.z) ** 2 < 10);
				if (bv) {
					prompt = `<kbd>E</kbd>Felszállás: <span class="badge ${bv.line.mode === 'tram' ? '' : 'bus'}">${bv.ref}</span> ${bv.headsign || ''}`;
					if (pressed.has('KeyE')) {
						ride = { key: bv.key, lastState: bv };
						toast(`Felszálltál: ${bv.ref} ▸ ${bv.headsign}`);
						audio.event('board', { ref: bv.ref, mode: bv.line.mode });
					}
				} else if (ent) {
					prompt = `<kbd>E</kbd>Le a metróhoz – M2 ${STATIONS[ent.station]}`;
					if (pressed.has('KeyE')) {
						mode = 'metro';
						metro.enter(ent.station, ctx);
						audio.event('metro-enter', { station: ent.station });
					}
				} else if (vend) {
					if (vendorOpen(vend, hours)) {
						prompt = `<kbd>E</kbd>${vend.shop ? vend.name : 'Vape árus'} – vásárlás`;
						if (pressed.has('KeyE')) openShop(vend);
					} else prompt = `${vend.shop ? vend.name : 'Vape árus'} – most zárva`;
				}
			}
			setPrompt(prompt);

			// Health: slow recovery; fainting sends you to the Klinikák.
			regen += dt;
			if (regen > 4) { regen = 0; player.health = Math.min(100, player.health + 1); }
			if (player.health <= 0) {
				const [cx, cz] = toXZ(...PLACES.clinics);
				const n = graph.nearest(cx, cz, 300);
				player.teleport(...(n >= 0 ? graph.nodes[n] : [cx, cz]));
				player.health = 60;
				player.money = Math.round(player.money * 0.9);
				ride = null;
				toast('Elájultál… a Klinikákon tértél magadhoz.');
			}

			stats.drawn = crowdView.update(player.x, player.z, frame);
			frame.ride = ride;
			world.update(frame);
			infra.update(frame);
			entranceView.update(frame);
			traffic.update(frame);
			audio.update(frame);
			pipeline.render(scene, camera, frame);
			stats.vehicles = vehicles.length;
			stats.render = pipeline.info();

			hudTimer -= dt;
			if (hudTimer <= 0) {
				hudTimer = 0.25;
				updateHud(clock, st);
				minimap.draw(player, near, vendors, entrances);
			}
		}

		stats.fps = Math.round(fps);
		stats.people = crowd.n;
		pressed.clear();
	}

	function alight(v) {
		if (!ride) return;
		ride = null;
		player.riding = null;
		if (v) {
			// Step off on the kerb side: right of the direction of travel (forward = (sin yaw, cos yaw)).
			const side = 3.2;
			const x = v.x - Math.cos(v.yaw) * side, z = v.z + Math.sin(v.yaw) * side;
			const [cx, cz] = world.collide(x, z, 0.4);
			player.teleport(cx, cz, player.yaw);
			toast(v.stopName ? `Leszálltál: ${v.stopName}` : 'Leszálltál.');
			audio.event('alight', { ref: v.ref });
		}
	}

	const setPrompt = (html) => hud.prompt(html);

	function updateHud(clock, st) {
		hud.update({
			...clock,
			timeNote: realtime ? '' : speed === 0 ? ' · megállítva' : ` · ${speed}×`,
			street: world.streetAt(player.x, player.z),
			danger: { level: danger.level, ...dangerLabel(danger.level) },
			money: player.money,
			health: player.health,
			items: `Gázspray: ${player.spray} db · Bérlet: Budapest-bérlet`,
			liveStatus,
			mapSource: city.source === 'fallback' ? 'egyszerűsített' : 'OpenStreetMap',
			sunEl: st.sunEl,
		});
		const board = !ride ? transit.departuresNear(player.x, player.z, unix, budapestHours(unix), clock.dayIndex) : null;
		hud.board(board && {
			stopName: board.stopName,
			rows: board.list.slice(0, 6).map((d) => ({ ...d, mode: transit.byRef.get(d.ref).mode })),
			note: liveCount ? 'élő járművek a térképen · indulások menetrend szerint' : 'menetrend szerint',
		});
	}

	// Hooks for automated tests (tests/web/play.mjs).
	window.__game = {
		stats,
		player,
		transit,
		crowd,
		city,
		world,
		scene,
		camera,
		pipeline,
		sky,
		traffic,
		audio,
		frame: frameState,
		setTime: (iso) => { unix = parseBudapestTime(iso, budapestOffsetHours); realtime = false; speed = 1; },
		teleport: (lat, lon, yaw) => { const [x, z] = toXZ(lat, lon); player.teleport(x, z, yaw); },
		state: () => ({ mode, ride, dialog: dialog && dialog.type, money: player.money, health: player.health, danger: danger.level, hours: budapestHours(unix) }),
		press: (code) => pressed.add(code),
		/**
		 * Puts the camera at a viewpoint (for screenshots): { at: [lat, lon], lookAt: [lat, lon, height?],
		 * yaw, pitch, height (eye height in metres) }.
		 */
		view: (v) => {
			ride = null;
			mode = 'street';
			const [x, z] = v.at ? toXZ(v.at[0], v.at[1]) : [player.x, player.z];
			let yaw = v.yaw != null ? v.yaw : player.yaw;
			const eye = v.height || 1.68;
			let pitch = v.pitch || 0;
			if (v.lookAt) {
				const [tx, tz] = toXZ(v.lookAt[0], v.lookAt[1]);
				yaw = Math.atan2(-(tx - x), -(tz - z));
				if (v.pitch == null) pitch = Math.atan2((v.lookAt[2] || eye) - eye, Math.hypot(tx - x, tz - z));
			}
			player.teleport(x, z, yaw);
			player.pitch = pitch;
			player.eye = eye;
		},
		leaveMetro: () => { mode = 'street'; },
		enterMetro: (i) => { mode = 'metro'; metro.enter(i, { transit, hours: budapestHours(unix), dayIndex: budapestClock(unix).dayIndex, seconds: serviceClock(budapestHours(unix), budapestClock(unix).dayIndex).seconds, headway: 4 }); },
		metro,
	};
	requestAnimationFrame(loop);
}

main().catch((err) => {
	console.error(err);
	setStatus(`Hiba: ${err.message}`);
});
