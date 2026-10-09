// Budapest Online – Józsefváros. Boots the data, builds the city and runs the game loop.
import * as THREE from './vendor/three.module.min.js';
import { CONFIG, applyUrlOverrides, parseBudapestTime } from './config.js';
import { toXZ } from './geo.js';
import { budapestHours, budapestClock, budapestOffsetHours } from './astro.js';
import { fetchOverpass, normalise, loadCached, saveCached, cityStats, DATA_VERSION, cumulative } from './osm.js';
import { makeFallbackCity } from './fallback.js';
import { buildWorld } from './world.js';
import { Sky } from './sky.js';
import { buildWalkGraph, Crowd, densityForHour } from './crowd.js';
import { CrowdView } from './npcView.js';
import { DangerSystem, dangerLabel } from './danger.js';
import { placeVendors, vendorOpen, VAPE_MENU } from './vendors.js';
import { Player } from './player.js';
import { Minimap } from './minimap.js';
import { TransitSystem } from './transit/system.js';
import { VehicleView } from './transit/view.js';
import { BkkClient } from './transit/bkk.js';
import { LINE_DEFAULTS, headwayAt, serviceClock } from './transit/schedule.js';
import { Metro, STATIONS } from './metro.js';

applyUrlOverrides(CONFIG);
const $ = (id) => document.getElementById(id);
const REFS = ['99', '23', '24', '28A', 'M2'];
const PLACES = { blaha: [47.4969, 19.0707], keleti: [47.4998, 19.0826], clinics: [47.4828, 19.0792], spawn: [47.4958, 19.0722] };

function setStatus(text, progress) {
	$('status').textContent = text;
	if (progress != null) $('progress').firstElementChild.style.width = `${Math.round(progress * 100)}%`;
}

function toast(text) {
	const el = document.createElement('div');
	el.className = 'toast';
	el.textContent = text;
	$('toasts').appendChild(el);
	setTimeout(() => el.remove(), 5200);
	while ($('toasts').children.length > 4) $('toasts').firstElementChild.remove();
}

const fmtFt = (n) => `${Math.round(n).toLocaleString('hu-HU')} Ft`;

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
	const skip = $('start');
	skip.textContent = 'Kihagyom – egyszerűsített térkép';
	skip.style.display = 'inline-block';
	const skipped = new Promise((resolve) => (skip.onclick = () => { abort.abort(); resolve(null); }));
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
		skip.style.display = 'none';
		skip.onclick = null;
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
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: CONFIG.quality !== 'low', powerPreference: 'high-performance' });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.quality === 'low' ? 1 : 1.75));
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.shadowMap.enabled = CONFIG.quality !== 'low';
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.outputColorSpace = THREE.SRGBColorSpace;

	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 3000);

	setStatus('Térkép betöltése…', 0.1);
	const city = await loadCity();
	setStatus(`Város építése: ${cityStats(city)}…`, 0.5);
	await new Promise((r) => setTimeout(r, 30));
	const world = buildWorld(scene, city, { quality: CONFIG.quality });
	const sky = new Sky(scene, renderer);

	const client = CONFIG.bkkKey ? new BkkClient({ key: CONFIG.bkkKey, bases: CONFIG.bkkBases }) : null;
	const { lines, source: lineSource } = await loadLines(city, client);
	const transit = new TransitSystem(lines);
	const vehicleView = new VehicleView(scene);

	setStatus('Emberek az utcán…', 0.85);
	const graph = buildWalkGraph(city.roads);
	const crowd = new Crowd(graph, CONFIG.people + 200, 2024);
	const crowdView = new CrowdView(scene, crowd, { max: CONFIG.drawPeople, radius: 170 });
	const vendors = placeVendors(scene, city, graph, crowd, world);
	const danger = new DangerSystem(crowd, { lightAt: (x, z) => (sky.state.night > 0.5 ? world.lightAt(x, z) : 1) });

	// Real lamp light around the player at night (the rest only glow).
	const lampLights = [];
	for (let i = 0; i < (CONFIG.quality === 'low' ? 4 : 10); i++) {
		const l = new THREE.PointLight(0xffc27a, 0, 30, 1.6);
		scene.add(l);
		lampLights.push(l);
	}

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
	entrances = entrances.map((e) => {
		const st = (e.x - stationXZ[0][0]) ** 2 + (e.z - stationXZ[0][1]) ** 2 < (e.x - stationXZ[1][0]) ** 2 + (e.z - stationXZ[1][1]) ** 2 ? 0 : 1;
		return { ...e, station: st };
	});
	if (!city.entrances.length) {
		// Draw simple M pylons where we invented entrances.
		const mMat = new THREE.MeshStandardMaterial({ color: 0xe41f18, emissive: 0xe41f18, emissiveIntensity: 0.4 });
		for (const e of entrances) {
			const p = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.7), mMat);
			p.position.set(e.x, 3, e.z);
			scene.add(p);
		}
	}

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
	let lastPrompt = '';

	const dangerCallbacks = {
		onEncounter: (e) => {
			dialog = { type: 'encounter', kind: e.kind };
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

	function showDialog(who, say, options) {
		const el = $('dialog');
		el.innerHTML = `<div class="who">${who}</div><div class="say">${say}</div>` + options.map((o, i) => `<div class="opt"><kbd>${i + 1}</kbd>${o}</div>`).join('');
		el.style.display = 'block';
	}
	function hideDialog() {
		$('dialog').style.display = 'none';
		$('shop').style.display = 'none';
	}

	function openShop(v) {
		dialog = { type: 'shop', vendor: v };
		const el = $('shop');
		el.innerHTML = `<div class="who">${v.shop ? v.name : 'Vape árus'}</div><div class="say">„Mit adhatok, főnök?”</div>` +
			VAPE_MENU.map((m, i) => `<div class="opt"><kbd>${i + 1}</kbd>${m.name} – <b>${fmtFt(m.price)}</b></div>`).join('') +
			'<div class="opt" style="color:var(--muted)"><kbd>E</kbd>Köszi, majd máskor</div>';
		el.style.display = 'block';
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

	// ---------------------------------------------------------------- start screen
	setStatus(`Kész. Térkép: ${city.source === 'fallback' ? 'egyszerűsített (offline)' : 'OpenStreetMap'} · Vonalak: ${lineSource}`, 1);
	const start = $('start');
	start.textContent = 'Indulás';
	start.style.display = 'inline-block';
	const begin = () => {
		$('loading').style.display = 'none';
		$('hud').classList.add('on');
		player.lock();
		let seen = false;
		try { seen = !!localStorage.getItem('bo-help-seen'); localStorage.setItem('bo-help-seen', '1'); } catch { /* storage blocked */ }
		if (!seen) {
			$('help').style.display = 'flex';
			setTimeout(() => ($('help').style.display = 'none'), 7000);
		}
		toast('Blaha Lujza tér. A villamosok és buszok a megállókban állnak meg – E-vel szállsz fel.');
	};
	start.onclick = begin;
	if (CONFIG.test) begin();
	canvas.addEventListener('click', () => player.lock());
	window.addEventListener('resize', () => {
		renderer.setSize(window.innerWidth, window.innerHeight);
		camera.aspect = metro.camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		metro.camera.updateProjectionMatrix();
	});
	metro.camera.aspect = window.innerWidth / window.innerHeight;
	metro.camera.updateProjectionMatrix();

	// ---------------------------------------------------------------- loop
	let last = performance.now();
	let frame = 0;
	let hudTimer = 0, lampTimer = 0, fps = 60, regen = 0;
	const stats = { fps: 0, people: 0, drawn: 0, vehicles: 0 };

	function loop(now) {
		requestAnimationFrame(loop);
		const dt = Math.min(0.1, (now - last) / 1000);
		last = now;
		frame++;
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

		if (pressed.has('KeyH')) $('help').style.display = $('help').style.display === 'flex' ? 'none' : 'flex';
		if (pressed.has('KeyM')) minimap.zoom = minimap.zoom > 1 ? 0.6 : 1.6;

		const svc = serviceClock(hours, clock.dayIndex);
		const ctx = { transit, hours, dayIndex: clock.dayIndex, seconds: svc.seconds, headway: headwayAt(LINE_DEFAULTS.M2, hours, svc.weekend), clock: clock.time };

		if (mode === 'metro') {
			const r = metro.update(dt, input, player, ctx);
			if (r && r.action === 'surface') {
				mode = 'street';
				const e = entrances.find((x) => x.station === r.station) || entrances[0];
				const [ex, ez] = world.collide(e.x + 2, e.z + 2, 0.4);
				player.teleport(ex, ez);
				toast(`Felértél: ${STATIONS[r.station]}`);
			}
			metro.render(renderer);
			setPrompt(metro.prompt);
			$('ride').style.display = 'block';
			$('ride').innerHTML = `<span class="badge metro">M2</span>${metro.message}`;
		} else {
			// City simulation.
			const st = sky.update(unix, camera.position);
			world.setNight(st.night);
			const targetPeople = Math.round(CONFIG.people * densityForHour(hours));
			crowd.balance(targetPeople, crowd.n < targetPeople * 0.6 ? 150 : 25, { x: player.x, z: player.z, r: 260, share: 0.7 });
			crowd.step(simDt, unix);
			const vehicles = transit.update(simDt, unix, hours, clock.dayIndex);
			const near = vehicles.filter((v) => (v.x - player.x) ** 2 + (v.z - player.z) ** 2 < 1600 * 1600);
			vehicleView.update(near, frame, st.night);

			// Riding.
			let seat = null;
			if (ride) {
				const v = transit.stateOf(ride.key);
				seat = vehicleView.seat(ride.key);
				if (!v || !seat) {
					alight(v || ride.lastState);
				} else {
					ride.lastState = v;
					$('ride').style.display = 'block';
					$('ride').innerHTML = `<span class="badge ${v.line.mode === 'tram' ? '' : 'bus'}">${v.ref}</span>▸ ${v.headsign || ''}<br><span style="color:var(--muted)">${v.atStop ? 'Megálló: ' + v.stopName : 'Következik: ' + (v.nextStop || '—')}</span>`;
				}
			} else {
				$('ride').style.display = 'none';
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
					}
				} else if (ent) {
					prompt = `<kbd>E</kbd>Le a metróhoz – M2 ${STATIONS[ent.station]}`;
					if (pressed.has('KeyE')) {
						mode = 'metro';
						metro.enter(ent.station, ctx);
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

			stats.drawn = crowdView.update(player.x, player.z);

			// Lamp lights near you at night.
			lampTimer -= dt;
			if (lampTimer <= 0) {
				lampTimer = 0.4;
				const nearL = world.lampsNear(player.x, player.z, 70);
				lampLights.forEach((l, i) => {
					const e = nearL[i];
					if (e && st.night > 0.05) {
						const [lx, lz] = world.lamps[e[0]];
						l.position.set(lx, 6.2, lz);
						l.intensity = 60 * st.night;
					} else l.intensity = 0;
				});
			}
			renderer.render(scene, camera);
			stats.vehicles = vehicles.length;

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
		}
	}

	function setPrompt(html) {
		if (html === lastPrompt) return;
		lastPrompt = html;
		const el = $('prompt');
		el.innerHTML = html;
		el.style.display = html ? 'block' : 'none';
	}

	function updateHud(clock, st) {
		$('clock').innerHTML = `${clock.time}<small>${clock.seconds}</small>`;
		$('date').textContent = `${clock.date} ${clock.weekday} · ${clock.zone}${realtime ? '' : speed === 0 ? ' · megállítva' : ` · ${speed}×`}`;
		$('street').textContent = world.streetAt(player.x, player.z) || '—';
		const lvl = danger.level;
		const lab = dangerLabel(lvl);
		$('dangerText').textContent = lab.text;
		$('dangerText').style.color = lab.colour;
		const bar = $('dangerBar').firstElementChild;
		bar.style.width = `${Math.round(lvl * 100)}%`;
		bar.style.background = lab.colour;
		$('money').textContent = fmtFt(player.money);
		$('healthBar').firstElementChild.style.width = `${Math.max(0, player.health)}%`;
		$('staminaBar').firstElementChild.style.width = `${Math.round(player.stamina * 100)}%`;
		$('items').textContent = `Gázspray: ${player.spray} db · Bérlet: Budapest-bérlet`;
		$('dataSrc').innerHTML = `BKK: <b>${liveStatus}</b><br>Térkép: <b>${city.source === 'fallback' ? 'egyszerűsített' : 'OpenStreetMap'}</b> · Nap ${st.sunEl.toFixed(0)}°`;
		const board = !ride ? transit.departuresNear(player.x, player.z, unix, budapestHours(unix), clock.dayIndex) : null;
		const el = $('board');
		if (board && board.list.length) {
			el.style.display = 'block';
			el.innerHTML = `<h3>🚏 ${board.stopName}</h3>` + board.list.slice(0, 6).map((d) => {
				const mode = transit.byRef.get(d.ref).mode;
				return `<div class="row"><span class="badge ${mode === 'tram' ? '' : 'bus'}">${d.ref}</span><span class="head">${d.headsign}</span><span class="min">${d.minutes === 0 ? 'most' : d.minutes + ' p'}</span></div>`;
			}).join('') + `<div style="color:var(--muted);font-size:11px;margin-top:4px">${liveCount ? 'élő járművek a térképen · indulások menetrend szerint' : 'menetrend szerint'}</div>`;
		} else el.style.display = 'none';
	}

	// Hooks for automated tests (tests/web/play.mjs).
	window.__game = {
		stats,
		player,
		transit,
		crowd,
		city,
		world,
		setTime: (iso) => { unix = parseBudapestTime(iso, budapestOffsetHours); realtime = false; speed = 1; },
		teleport: (lat, lon, yaw) => { const [x, z] = toXZ(lat, lon); player.teleport(x, z, yaw); },
		state: () => ({ mode, ride, dialog: dialog && dialog.type, money: player.money, health: player.health, danger: danger.level, hours: budapestHours(unix) }),
		press: (code) => pressed.add(code),
		enterMetro: (i) => { mode = 'metro'; metro.enter(i, { transit, hours: budapestHours(unix), dayIndex: budapestClock(unix).dayIndex, seconds: serviceClock(budapestHours(unix), budapestClock(unix).dayIndex).seconds, headway: 4 }); },
		metro,
	};
	requestAnimationFrame(loop);
}

main().catch((err) => {
	console.error(err);
	setStatus(`Hiba: ${err.message}`);
});
