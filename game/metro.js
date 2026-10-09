// The M2 underground between Blaha Lujza tér and Keleti pályaudvar: platforms, tunnel and trains.
// Times come from the transit timetable (or live data when BKK provides it).
import * as THREE from './vendor/three.module.min.js';
import { segmentTime, segmentDistance, LINE_DEFAULTS } from './transit/schedule.js';
import { signTexture } from './textures.js';
import { CrowdView } from './npcView.js';
import { STATE } from './crowd.js';

export const STATIONS = ['Blaha Lujza tér', 'Keleti pályaudvar'];
const TUNNEL_LEN = 1006; // metres of track Blaha -> Keleti under Rákóczi út (BKK GTFS shape distance)
const PLATFORM_LEN = 110;
const TRAIN_CARS = 5, CAR_LEN = 19.5;
const TRACK_X = [-3.6, 3.6]; // track 0 towards Keleti / Örs vezér tere, track 1 towards Blaha / Déli pu.

function tileTexture() {
	const c = document.createElement('canvas');
	c.width = c.height = 256;
	const g = c.getContext('2d');
	g.fillStyle = '#d9d6cf';
	g.fillRect(0, 0, 256, 256);
	for (let y = 0; y < 256; y += 32) for (let x = 0; x < 256; x += 64) {
		const v = 200 + Math.random() * 25;
		g.fillStyle = `rgb(${v},${v - 3},${v - 8})`;
		g.fillRect(x + 1, y + 1, 62, 30);
	}
	g.fillStyle = '#c0281e';
	g.fillRect(0, 150, 256, 18); // M2 red band
	const t = new THREE.CanvasTexture(c);
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.colorSpace = THREE.SRGBColorSpace;
	return t;
}

export class Metro {
	constructor() {
		this.scene = new THREE.Scene();
		this.scene.background = new THREE.Color(0x07080a);
		this.scene.fog = new THREE.Fog(0x07080a, 40, 260);
		this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 600);
		this.state = 'off';
		this.station = 0;
		this.message = '';
		this.build();
	}

	stationZ(i) {
		return i === 0 ? 0 : -TUNNEL_LEN;
	}

	build() {
		const s = this.scene;
		s.add(new THREE.HemisphereLight(0xfff4e0, 0x403a30, 1.6));
		const tiles = tileTexture();
		tiles.repeat.set(24, 2);
		const wallMat = new THREE.MeshStandardMaterial({ map: tiles, roughness: 0.5, side: THREE.BackSide, emissive: 0x222018 });
		const floorMat = new THREE.MeshStandardMaterial({ color: 0x8e8a83, roughness: 0.8 });
		const trackMat = new THREE.MeshStandardMaterial({ color: 0x3a3632, roughness: 1 });
		const railMat = new THREE.MeshStandardMaterial({ color: 0xaab0b6, metalness: 0.9, roughness: 0.3 });
		const lightMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff6e8, emissiveIntensity: 2.2 });
		const tunnelMat = new THREE.MeshStandardMaterial({ color: 0x3b3936, roughness: 1, side: THREE.BackSide });

		for (let i = 0; i < 2; i++) {
			const z0 = this.stationZ(i);
			// Station hall: a long tiled vault over an island platform with a track on each side.
			const hall = new THREE.Mesh(new THREE.BoxGeometry(17, 8.5, PLATFORM_LEN + 16), wallMat);
			hall.position.set(0, 3.9, z0 - PLATFORM_LEN / 2);
			s.add(hall);
			const platform = new THREE.Mesh(new THREE.BoxGeometry(4.6, 1.05, PLATFORM_LEN), floorMat);
			platform.position.set(0, 0.52, z0 - PLATFORM_LEN / 2);
			s.add(platform);
			for (const side of [-1, 1]) {
				const edge = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, PLATFORM_LEN), new THREE.MeshStandardMaterial({ color: 0xe8c72a, emissive: 0x332800 }));
				edge.position.set(side * 2.15, 1.06, z0 - PLATFORM_LEN / 2);
				s.add(edge);
			}
			// Benches down the middle of the platform.
			for (let k = 0; k < 6; k++) {
				const bench = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.45, 2.2), new THREE.MeshStandardMaterial({ color: 0x8a5a2b }));
				bench.position.set(0, 1.28, z0 - 15 - k * 16);
				s.add(bench);
			}
			const lamp = new THREE.PointLight(0xfff1dc, 60, 70, 1.5);
			lamp.position.set(0, 6, z0 - PLATFORM_LEN / 2);
			s.add(lamp);
			for (let k = 0; k < 14; k++) {
				const l = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 4), lightMat);
				l.position.set(0, 6.6, z0 - 6 - k * 7.6);
				s.add(l);
			}
			// Station name boards on both walls and an exit stair at the platform end.
			const nameMat = new THREE.MeshStandardMaterial({ map: signTexture(STATIONS[i], { bg: '#1d2b5a', fg: '#ffffff', w: 768, h: 128 }), emissive: 0xffffff, emissiveIntensity: 0.3 });
			nameMat.emissiveMap = nameMat.map;
			for (const side of [-1, 1]) for (const dz of [-20, -55, -90]) {
				const b = new THREE.Mesh(new THREE.PlaneGeometry(5, 0.85), nameMat);
				b.position.set(side * 7.4, 3.2, z0 + dz);
				b.rotation.y = -side * Math.PI / 2;
				s.add(b);
			}
			const stair = new THREE.Mesh(new THREE.BoxGeometry(3.4, 4, 8), new THREE.MeshStandardMaterial({ color: 0x6e6a64 }));
			stair.position.set(0, 3, z0 - PLATFORM_LEN + 2);
			stair.rotation.x = -0.5;
			s.add(stair);
			const exitMat = new THREE.MeshStandardMaterial({ map: signTexture('KIJÁRAT ▲ EXIT', { bg: '#0d5c2e', fg: '#ffffff', w: 512, h: 128 }), emissive: 0xffffff, emissiveIntensity: 0.6 });
			exitMat.emissiveMap = exitMat.map;
			const exit = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.65), exitMat);
			exit.position.set(0, 4.6, z0 - PLATFORM_LEN + 9);
			s.add(exit);
			// Departure board.
			this.boards = this.boards || [];
			const bc = document.createElement('canvas');
			bc.width = 512;
			bc.height = 160;
			const bt = new THREE.CanvasTexture(bc);
			bt.colorSpace = THREE.SRGBColorSpace;
			const bm = new THREE.MeshStandardMaterial({ map: bt, emissiveMap: bt, emissive: 0xffffff, emissiveIntensity: 0.9 });
			const board = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.75), bm);
			board.position.set(0, 3.3, z0 - 12);
			s.add(board);
			this.boards.push({ canvas: bc, tex: bt });
		}
		// Track beds along the whole stretch; tunnel tubes only between and beyond the stations.
		const tubeSegments = [[60, 8], [-PLATFORM_LEN - 8, -TUNNEL_LEN + 8], [-TUNNEL_LEN - PLATFORM_LEN - 8, -TUNNEL_LEN - PLATFORM_LEN - 400]];
		for (const tx of TRACK_X) {
			for (const [za, zb] of tubeSegments) {
				const len = Math.abs(za - zb);
				const tube = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, len, 16, 1, true), tunnelMat);
				tube.rotation.x = Math.PI / 2;
				tube.position.set(tx, 1.6, (za + zb) / 2);
				s.add(tube);
			}
			const bed = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.2, TUNNEL_LEN + 600), trackMat);
			bed.position.set(tx, 0, -TUNNEL_LEN / 2);
			s.add(bed);
			for (const r of [-0.72, 0.72]) {
				const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.14, TUNNEL_LEN + 600), railMat);
				rail.position.set(tx + r, 0.17, -TUNNEL_LEN / 2);
				s.add(rail);
			}
			// Tunnel lights every 25 m: they stream past the windows while riding.
			for (let z = -PLATFORM_LEN - 12; z > -TUNNEL_LEN + 8; z -= 25) {
				const l = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.6), lightMat);
				l.position.set(tx + (tx < 0 ? -2.6 : 2.6), 2.2, z);
				s.add(l);
			}
		}
		// Trains: one per track.
		this.trains = TRACK_X.map((tx) => this.makeTrain(tx));
		// People waiting on the platforms.
		const n = 26;
		const ppl = { n, id: new Int32Array(n), x: new Float32Array(n), z: new Float32Array(n), yaw: new Float32Array(n), phase: new Float32Array(n), state: new Uint8Array(n).fill(STATE.IDLE) };
		for (let i = 0; i < n; i++) {
			ppl.id[i] = 900000 + i;
			ppl.x[i] = (Math.random() - 0.5) * 3;
			ppl.z[i] = this.stationZ(i % 2) - 8 - Math.random() * 90;
			ppl.yaw[i] = Math.random() < 0.5 ? Math.PI / 2 : -Math.PI / 2;
		}
		this.people = ppl;
		this.peopleView = new CrowdView(s, ppl, { max: n, radius: 2000 });
		for (const p of this.peopleView.parts) p.position.y = 1.05;
	}

	makeTrain(tx) {
		const g = new THREE.Group();
		const body = new THREE.MeshStandardMaterial({ color: 0xe9ecef, roughness: 0.35, metalness: 0.3 });
		const glass = new THREE.MeshStandardMaterial({ color: 0x1a2028, roughness: 0.1, metalness: 0.5, emissive: 0xfff3dc, emissiveIntensity: 0.25 });
		const red = new THREE.MeshStandardMaterial({ color: 0xc8231b, roughness: 0.4 });
		const floor = new THREE.MeshStandardMaterial({ color: 0x55585c });
		for (let c = 0; c < TRAIN_CARS; c++) {
			const z = c * (CAR_LEN + 0.6) + CAR_LEN / 2; // cars trail behind the front (local +z)
			const shell = new THREE.Mesh(new THREE.BoxGeometry(2.7, 3.1, CAR_LEN), body);
			shell.position.set(0, 1.85, z);
			g.add(shell);
			for (const side of [-1, 1]) {
				const w = new THREE.Mesh(new THREE.BoxGeometry(0.02, 1.0, CAR_LEN * 0.9), glass);
				w.position.set(side * 1.36, 2.3, z);
				g.add(w);
				const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.22, CAR_LEN), red);
				stripe.position.set(side * 1.365, 1.45, z);
				g.add(stripe);
			}
			const fl = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.05, CAR_LEN - 0.4), floor);
			fl.position.set(0, 1.05, z);
			g.add(fl);
		}
		g.position.set(tx, 0, 600);
		this.scene.add(g);
		return { group: g };
	}

	/** Enter a station from the street. */
	enter(stationIndex, ctx) {
		this.state = 'platform';
		this.station = stationIndex;
		this.px = 0;
		this.pz = this.stationZ(stationIndex) - PLATFORM_LEN + 14;
		this.yaw = 0;
		this.pitch = 0;
		this.cycle = null;
		this.message = `M2 · ${STATIONS[stationIndex]} — várd a szerelvényt ${STATIONS[1 - stationIndex]} felé`;
		this.planNext(ctx);
	}

	/** Seconds until the next train towards the other station, from the timetable model. */
	planNext(ctx) {
		const line = LINE_DEFAULTS.M2;
		const travel = segmentTime(TUNNEL_LEN, line.vmax, line.accel);
		let wait = null;
		const next = ctx.transit && ctx.transit.nextTrain('M2', this.station === 0 ? this.dirTowardsKeleti(ctx) : 1 - this.dirTowardsKeleti(ctx), STATIONS[this.station].split(' ')[0], ctx.hours, ctx.dayIndex);
		if (next) wait = next.wait;
		if (wait == null) {
			// No timetable data: fall back to the headway at this hour.
			const hw = (ctx.headway || 4) * 60;
			wait = hw - (ctx.seconds % hw);
		}
		this.cycle = { arriveIn: Math.max(12, wait), dwell: line.dwell, travel, phase: 'approach', t: 0, track: this.station };
	}

	dirTowardsKeleti(ctx) {
		// Which M2 direction index runs Blaha -> Keleti (towards Örs vezér tere).
		const line = ctx.transit && ctx.transit.byRef.get('M2');
		if (!line) return 0;
		for (const d of line.directions) {
			const b = d.stops.findIndex((s) => s.name.startsWith('Blaha'));
			const k = d.stops.findIndex((s) => s.name.startsWith('Keleti'));
			if (b >= 0 && k > b) return d.index;
		}
		return 0;
	}

	/** Where a train's front stops at station `i` when travelling in direction `dir` (-1 = towards Keleti). */
	stopFront(i, dir) {
		const z0 = this.stationZ(i);
		return dir < 0 ? z0 - PLATFORM_LEN + 5 : z0 - 5;
	}

	placeTrain(train, frontZ, dir) {
		train.group.position.z = frontZ;
		train.group.rotation.y = dir < 0 ? 0 : Math.PI;
	}

	/** Returns { action: 'surface', station } when the player climbs back up. */
	update(dt, keys, mouse, ctx) {
		if (this.state === 'off') return null;
		const line = LINE_DEFAULTS.M2;
		const c = this.cycle;
		// Station 0 (Blaha) boards track 0 towards Keleti (-z); station 1 (Keleti) boards track 1 towards Blaha (+z).
		const boardTrack = this.state === 'platform' ? this.station : c.track;
		const dir = boardTrack === 0 ? -1 : 1;
		const train = this.trains[boardTrack];
		c.t += dt;
		let prompt = '';
		if (this.state === 'platform') {
			const stop = this.stopFront(this.station, dir);
			if (c.phase === 'approach') {
				const left = c.arriveIn - c.t;
				const brake = line.vmax / line.accel;
				// Cruise in, then brake to a stop at the platform end.
				const remaining = left > brake ? 0.5 * line.accel * brake * brake + line.vmax * (left - brake) : 0.5 * line.accel * left * left;
				this.placeTrain(train, stop - dir * Math.min(remaining, 900), dir);
				if (left <= 0) {
					c.phase = 'dwell';
					c.t = 0;
				}
				this.message = `M2 · ${STATIONS[this.station]} — következő szerelvény ${STATIONS[1 - this.station]} felé: ${Math.max(0, Math.ceil(left))} mp`;
			} else if (c.phase === 'dwell') {
				this.placeTrain(train, stop, dir);
				const near = Math.abs(this.px - TRACK_X[boardTrack]) < 3.3;
				prompt = near ? 'E – Beszállás (M2)' : 'Menj a peron szélére a beszálláshoz';
				this.message = `Ajtók nyitva · ${Math.max(0, Math.ceil(c.dwell - c.t))} mp`;
				if (keys.pressed('KeyE') && near) {
					this.state = 'riding';
					c.phase = 'riding';
					c.track = boardTrack;
					c.t = 0;
				} else if (c.t > c.dwell) {
					this.planNext(ctx);
				}
			}
			if (this.state === 'platform') {
				this.walk(dt, keys, mouse, -2.2, 2.2, this.stationZ(this.station) - PLATFORM_LEN + 10, this.stationZ(this.station) - 3);
				const exitNear = this.pz < this.stationZ(this.station) - PLATFORM_LEN + 16;
				if (exitNear && !prompt) prompt = 'E – Fel a felszínre';
				if (exitNear && keys.pressed('KeyE')) {
					this.state = 'off';
					return { action: 'surface', station: this.station };
				}
			}
		} else if (this.state === 'riding') {
			const from = this.stopFront(this.station, dir);
			const front = from + dir * segmentDistance(TUNNEL_LEN, line.vmax, line.accel, c.t);
			this.placeTrain(train, front, dir);
			// Standing in the second car.
			this.px = TRACK_X[c.track] + 0.6;
			this.pz = front - dir * (CAR_LEN * 1.5 + 0.6);
			this.look(mouse);
			this.message = `M2 ▸ ${STATIONS[1 - this.station]} · ${Math.max(0, Math.ceil(c.travel - c.t))} mp`;
			if (c.t >= c.travel) {
				this.station = 1 - this.station;
				this.state = 'arrived';
				c.t = 0;
			}
		} else if (this.state === 'arrived') {
			prompt = 'E – Kiszállás';
			this.message = `Megérkeztél: ${STATIONS[this.station]}`;
			this.look(mouse);
			if (keys.pressed('KeyE') || c.t > 25) {
				this.state = 'platform';
				this.px = 0;
				this.pz = this.pz < this.stationZ(this.station) - PLATFORM_LEN + 12 ? this.stationZ(this.station) - PLATFORM_LEN + 14 : this.pz;
				this.planNext(ctx);
			}
		}
		const seated = this.state === 'riding' || this.state === 'arrived';
		this.camera.position.set(this.px, 1.05 + (seated ? 1.6 : 1.68), this.pz);
		this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
		this.peopleView.update(this.px, this.pz);
		this.prompt = prompt;
		this.drawBoards(ctx);
		return null;
	}

	look(mouse) {
		this.yaw = mouse.yaw;
		this.pitch = mouse.pitch;
	}

	walk(dt, keys, mouse, minX, maxX, minZ, maxZ) {
		this.look(mouse);
		let fx = 0, fz = 0;
		if (keys.down('KeyW')) fz -= 1;
		if (keys.down('KeyS')) fz += 1;
		if (keys.down('KeyA')) fx -= 1;
		if (keys.down('KeyD')) fx += 1;
		const l = Math.hypot(fx, fz);
		if (!l) return;
		const sp = (keys.down('ShiftLeft') ? 4.5 : 1.5) * dt / l;
		const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
		this.px = Math.max(minX, Math.min(maxX, this.px + (fx * c + fz * s) * sp));
		this.pz = Math.max(minZ, Math.min(maxZ, this.pz + (-fx * s + fz * c) * sp));
	}

	drawBoards(ctx) {
		if (!this.boards || !this.cycle) return;
		const frame = Math.floor(performance.now() / 500);
		if (frame === this.lastBoardFrame) return;
		this.lastBoardFrame = frame;
		this.boards.forEach((b, i) => {
			const g = b.canvas.getContext('2d');
			g.fillStyle = '#05070a';
			g.fillRect(0, 0, 512, 160);
			g.fillStyle = '#ffb000';
			g.font = 'bold 34px "Courier New", monospace';
			const to = i === 0 ? 'Örs vezér tere' : 'Déli pályaudvar';
			let left = '—';
			if (i === this.station && this.cycle.phase === 'approach') left = `${Math.ceil(Math.max(0, this.cycle.arriveIn - this.cycle.t) / 60)} perc`;
			if (i === this.station && this.cycle.phase === 'dwell') left = 'BESZÁLLÁS';
			g.fillText(`M2 ${to}`, 18, 60);
			g.fillText(left, 18, 120);
			g.fillStyle = '#e6e6e6';
			g.font = '24px monospace';
			g.fillText(ctx.clock || '', 400, 120);
			b.tex.needsUpdate = true;
		});
	}

	render(renderer) {
		renderer.render(this.scene, this.camera);
	}
}
