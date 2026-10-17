// The city's ordinary buildings (the Józsefváros tenements) from OSM footprints.
//
//   facadesPlan.js  storeys, heights, styles, party walls / firewalls / courtyards, shops per wall;
//   facadesGeom.js  the geometry: detailed 3D facades near the player, a light shell for the rest;
//   facadesRoof.js  roofs for any footprint (hipped towards the street, gables on party walls...);
//   facadesTex.js   the procedural texture array and the facade / glazing / far / railing shaders.
//
// Levels of detail: the whole district is drawn as a far shell (one merged mesh per 500 m region,
// windows drawn by the shader); within DETAIL_R of the camera every 100 m chunk gets its detailed
// facades (built lazily, a few per frame) and the shader hides that chunk's shell. The shell also
// casts all building shadows, so detailed chunks cost no extra shadow-pass draw calls.
//
// TODO(buildings), in order of value:
//   * shop signs (facadesSigns.js, one shared atlas, one mesh per near chunk): roller shutters
//     pulled down over closed shops at night, a few lit "NYITVA" (open) signs, projecting blade signs
//     for cafés and bars as well;
//   * near chunks (< 60 m) could cast their own shadows (cornice/balcony shadow lines);
//   * plaster palette and dirt tuning against photos; corner chamfers/bays/turrets (info.turret);
//   * the speckle-prone ray-box room (roomAt) is fine on flats; shops use the parallax shopAt.
import * as THREE from '../vendor/three.module.min.js';
import { planBuildings, chunkIndex, occupancyAt, CHUNK, GRID_X0, GRID_Z0, GRID_W, GRID_H } from './facadesPlan.js';
import { OpaqueBuf, GlassBuf, RailBuf, FarBuf, buildDetail, buildFar } from './facadesGeom.js';
import { buildingUniforms, facadeMaterial, glassMaterial, farMaterial, railMaterial } from './facadesTex.js';
import { ATLAS, SignCells, layoutSigns, drawSign } from './facadesSigns.js';

const DETAIL_R = { high: 250, medium: 170, low: 95 };
const CORE_R = 130; // chunks this close are built at once (teleports, start-up)
const REGION = 5; // far-shell meshes cover REGION x REGION chunks
const FRAME_BUDGET_MS = 6;
const SIGN_R = { high: 170, medium: 130, low: 80 }; // chunks this close get their shop signs
const SIGN_CHUNKS_PER_FRAME = 3;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function farGeometry(fb) {
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(fb.pos, 3));
	g.setAttribute('normal', new THREE.Float32BufferAttribute(fb.nrm, 3));
	g.setAttribute('color', new THREE.Float32BufferAttribute(fb.col, 3));
	g.setAttribute('f1', new THREE.Float32BufferAttribute(fb.f1, 4));
	g.setAttribute('f2', new THREE.Float32BufferAttribute(fb.f2, 4));
	g.setAttribute('chunk', new THREE.Float32BufferAttribute(fb.chunk, 1));
	g.setIndex(new THREE.BufferAttribute(new Uint32Array(fb.idx), 1));
	g.computeBoundingSphere();
	return g;
}

function opaqueGeometry(O) {
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.BufferAttribute(O.P.view().slice(), 3));
	g.setAttribute('normal', new THREE.BufferAttribute(O.N.view().slice(), 3, true));
	g.setAttribute('uv', new THREE.BufferAttribute(O.U.view().slice(), 2));
	g.setAttribute('tint', new THREE.BufferAttribute(O.C.view().slice(), 4, true));
	g.setAttribute('layer', new THREE.BufferAttribute(O.Lr.view().slice(), 1));
	g.setIndex(new THREE.BufferAttribute(O.I.view().slice(), 1));
	g.computeBoundingSphere();
	return g;
}

function glassGeometry(G) {
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(G.pos, 3));
	g.setAttribute('normal', new THREE.Float32BufferAttribute(G.nrm, 3));
	g.setAttribute('wtan', new THREE.Float32BufferAttribute(G.tan, 2));
	g.setAttribute('uv', new THREE.Float32BufferAttribute(G.uv, 2));
	g.setAttribute('win', new THREE.Float32BufferAttribute(G.win, 4));
	g.setAttribute('win2', new THREE.Float32BufferAttribute(G.win2, 4));
	g.setIndex(new THREE.BufferAttribute(new Uint32Array(G.idx), 1));
	g.computeBoundingSphere();
	return g;
}

function railGeometry(R) {
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(R.pos, 3));
	g.setAttribute('normal', new THREE.Float32BufferAttribute(R.nrm, 3));
	g.setAttribute('uv', new THREE.Float32BufferAttribute(R.uv, 2));
	g.setIndex(new THREE.BufferAttribute(new Uint32Array(R.idx), 1));
	g.computeBoundingSphere();
	return g;
}

/** The shared shop-sign atlas: one canvas texture, cells drawn on demand (see facadesSigns.js). */
function signAtlas() {
	if (typeof document === 'undefined') return null;
	const canvas = document.createElement('canvas');
	canvas.width = ATLAS.W; canvas.height = ATLAS.H;
	const g = canvas.getContext('2d');
	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.anisotropy = 8;
	tex.generateMipmaps = true;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	const mat = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.06, roughness: 0.42, metalness: 0.05 });
	mat.name = 'shop-signs';
	mat.customProgramCacheKey = () => 'bld-shop-signs';
	mat.onBeforeCompile = (sh) => {
		sh.vertexShader = sh.vertexShader
			.replace('#include <common>', '#include <common>\nattribute float glow; varying float vGlow;')
			.replace('#include <uv_vertex>', '#include <uv_vertex>\nvGlow = glow;');
		sh.fragmentShader = sh.fragmentShader
			.replace('#include <common>', '#include <common>\nvarying float vGlow;')
			.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vGlow;');
	};
	return { canvas, g, tex, mat, cells: new SignCells(), dirty: false };
}

function signGeometry(buf) {
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
	g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nrm, 3));
	g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
	g.setAttribute('glow', new THREE.Float32BufferAttribute(buf.glow, 1));
	g.setIndex(buf.idx);
	g.computeBoundingSphere();
	return g;
}

const mixC = (out, a, b, t) => out.setRGB(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
const SKY = {
	top: { day: [0.3, 0.46, 0.78], gold: [0.42, 0.4, 0.55], night: [0.012, 0.016, 0.03] },
	hor: { day: [0.9, 0.94, 1.0], gold: [1.25, 0.78, 0.48], night: [0.07, 0.055, 0.05] },
};

/** Builds every OSM building not replaced by a landmark. Returns { meshes, plan, stats() }. */
export function buildBuildings(ctx) {
	const { root, data } = ctx;
	const quality = ctx.quality || 'high';
	const plan = planBuildings(data, { suppressed: ctx.suppressed });
	const U = buildingUniforms();
	const mask = new Uint8Array(GRID_W * GRID_H);
	const maskTex = new THREE.DataTexture(mask, GRID_W, GRID_H, THREE.RedFormat, THREE.UnsignedByteType);
	maskTex.needsUpdate = true;
	U.uDetail.value = maskTex;
	const mats = { facade: facadeMaterial(U), glass: glassMaterial(U), far: farMaterial(U), rail: railMaterial() };

	// Chunks of buildings (by footprint centre), collision walls and the shop fronts for the signs.
	const chunks = new Map();
	const shopFronts = new Map();
	for (const info of plan.infos) {
		const [ix, iz] = chunkIndex(info.b.cx, info.b.cz);
		const k = ix + iz * GRID_W;
		let ch = chunks.get(k);
		if (!ch) chunks.set(k, (ch = { k, ix, iz, cx: GRID_X0 + (ix + 0.5) * CHUNK, cz: GRID_Z0 + (iz + 0.5) * CHUNK, infos: [], group: null }));
		ch.infos.push(info);
		// Solid walls only where they reach the street (parts in the air do not block walking).
		if (info.base < 2) for (const ring of info.rings) ctx.addSolidRing(ring, info.b);
		// Shops on the ground floor get their sign from the chunk sign meshes (facadesSigns.js).
		if (info.base < 1) for (const s of info.segs) for (const { poi, t } of s.pois) {
			// Fascia band between the shop window head and the first-floor string course.
			shopFronts.set(poi, { x: s.ax + s.ux * t, z: s.az + s.uz * t, nx: s.nx, nz: s.nz, y: info.floorY[1] - 0.62, top: info.floorY[1] - 0.15 });
		}
	}
	ctx.shopFronts = shopFronts; // read by shopsigns.js
	const atlas = signAtlas();
	ctx.chunkSigns = !!atlas; // shopsigns.js leaves the shops with a front to the chunk signs

	// Far shell: every building, merged per region.
	const regions = new Map();
	for (const ch of chunks.values()) {
		const rk = Math.floor(ch.ix / REGION) + ',' + Math.floor(ch.iz / REGION);
		if (!regions.has(rk)) regions.set(rk, new FarBuf());
		const fb = regions.get(rk);
		for (const info of ch.infos) {
			try { buildFar(info, fb, ch.k); } catch { /* a broken footprint: skip it */ }
		}
	}
	const meshes = [];
	for (const fb of regions.values()) {
		if (!fb.idx.length) continue;
		const m = new THREE.Mesh(farGeometry(fb), mats.far);
		m.castShadow = true;
		m.receiveShadow = true;
		m.name = 'buildings-far';
		root.add(m);
		meshes.push(m);
	}

	// Detail chunks, built on demand.
	const detailRoot = new THREE.Group();
	detailRoot.name = 'buildings-detail';
	root.add(detailRoot);
	const stats = { built: 0, triangles: 0, buildMs: 0 };
	function buildChunk(ch) {
		const t0 = now();
		const out = { opaque: new OpaqueBuf(8192), glass: new GlassBuf(), rail: new RailBuf(), signs: [] };
		for (const info of ch.infos) {
			try { buildDetail(info, out); } catch { /* keep the shell for this one */ }
		}
		const group = new THREE.Group();
		const add = (geo, mat, shadow) => {
			if (!geo.index || !geo.index.count) { geo.dispose(); return; }
			const m = new THREE.Mesh(geo, mat);
			m.castShadow = shadow;
			m.receiveShadow = true;
			group.add(m);
		};
		add(opaqueGeometry(out.opaque), mats.facade, false);
		add(glassGeometry(out.glass), mats.glass, false);
		add(railGeometry(out.rail), mats.rail, false);
		ch.tris = out.opaque.triangles + (out.glass.idx.length + out.rail.idx.length) / 3;
		ch.signReqs = out.signs;
		ch.group = group;
		detailRoot.add(group);
		mask[ch.k] = 255;
		maskTex.needsUpdate = true;
		stats.built++;
		stats.buildMs += now() - t0;
	}
	function buildSigns(ch) {
		const A = atlas;
		const { buf, keys } = layoutSigns(ch.signReqs || [], (c) => {
			const got = A.cells.acquire(c.key);
			if (!got) return -1;
			if (got.fresh) { drawSign(A.g, got.cell, c); A.dirty = true; }
			return got.cell;
		});
		ch.signKeys = keys;
		if (!buf.idx.length) { ch.signMesh = false; return; }
		const m = new THREE.Mesh(signGeometry(buf), A.mat);
		m.name = 'shop-signs';
		m.receiveShadow = true;
		ch.signMesh = m;
		detailRoot.add(m);
	}
	function dropSigns(ch) {
		if (ch.signMesh) { detailRoot.remove(ch.signMesh); ch.signMesh.geometry.dispose(); }
		for (const k of ch.signKeys || []) atlas.cells.release(k);
		ch.signMesh = null;
		ch.signKeys = null;
	}
	function dropChunk(ch) {
		if (atlas && ch.signMesh != null) dropSigns(ch);
		detailRoot.remove(ch.group);
		for (const m of ch.group.children) m.geometry.dispose();
		ch.group = null;
		mask[ch.k] = 0;
		maskTex.needsUpdate = true;
	}

	const R = DETAIL_R[quality] || DETAIL_R.high;
	const SR = SIGN_R[quality] || SIGN_R.high;
	const list = [...chunks.values()];
	function stream(x, z) {
		const want = [];
		for (const ch of list) {
			// Distance from the camera to the chunk square.
			const dx = Math.max(0, Math.abs(x - ch.cx) - CHUNK / 2), dz = Math.max(0, Math.abs(z - ch.cz) - CHUNK / 2);
			const d = Math.hypot(dx, dz);
			ch.dist = d;
			if (ch.group && d > R + 70) dropChunk(ch);
			else if (!ch.group && d < R) want.push(ch);
		}
		if (want.length) {
			want.sort((a, b) => a.dist - b.dist);
			const t0 = now();
			for (const ch of want) {
				if (ch.dist > Math.min(CORE_R, R) && now() - t0 > FRAME_BUDGET_MS) break;
				buildChunk(ch);
			}
		}
		if (!atlas) return;
		// Shop signs: near detailed chunks only (released cells are recycled for new ones).
		const signWant = [];
		for (const ch of list) {
			if (!ch.group) continue;
			if (ch.signMesh != null && ch.dist > SR + 40) dropSigns(ch);
			else if (ch.signMesh == null && ch.dist < SR) signWant.push(ch);
		}
		signWant.sort((a, b) => a.dist - b.dist);
		for (let k = 0; k < signWant.length; k++) if (k < SIGN_CHUNKS_PER_FRAME || signWant[k].dist < CORE_R) buildSigns(signWant[k]);
		if (atlas.dirty) { atlas.tex.needsUpdate = true; atlas.dirty = false; }
	}

	const cTop = new THREE.Color(), cHor = new THREE.Color();
	ctx.onUpdate((frame) => {
		const cam = frame.camera;
		const x = cam ? cam.position.x : frame.player.x, z = cam ? cam.position.z : frame.player.z;
		stream(x, z);
		const sky = frame.sky || {};
		const night = sky.night ?? 0, golden = sky.golden ?? 0, day = sky.day ?? 1 - night;
		U.uHours.value = frame.hours ?? 12;
		U.uOcc.value = occupancyAt(frame.hours ?? 12);
		U.uTime.value += frame.dt || 0;
		U.uDayLight.value = Math.max(0, Math.min(1, day));
		mixC(cTop, SKY.top.day, SKY.top.night, night);
		mixC(cHor, SKY.hor.day, SKY.hor.night, night);
		if (golden > 0) {
			cTop.lerp(new THREE.Color(...SKY.top.gold), golden * 0.6);
			cHor.lerp(new THREE.Color(...SKY.hor.gold), golden * 0.7);
		}
		U.uSkyTop.value.copy(cTop);
		U.uSkyHor.value.copy(cHor);
		U.uStreet.value.setRGB(0.1 * (1 - night) + 0.03 * night, 0.1 * (1 - night) + 0.025 * night, 0.1 * (1 - night) + 0.02 * night);
	});
	ctx.onNight((k) => {
		U.uNight.value = Math.max(0, Math.min(1, (k - 0.15) / 0.6));
		if (atlas) atlas.mat.emissiveIntensity = 0.06 + 0.9 * U.uNight.value;
	});

	return {
		meshes,
		plan,
		stats: () => {
			let tris = 0, n = 0;
			for (const ch of list) if (ch.group) { tris += ch.tris; n++; }
			return { ...stats, chunks: n, detailTriangles: tris, signCells: atlas ? atlas.cells.byKey.size : 0 };
		},
	};
}
