// Builds the static city from CityData and answers spatial queries about it.
// The look of each part lives in its own module: ground.js, buildings.js, shopsigns.js, props.js,
// landmarks/. They all write into one CityContext (common.js).
import { closestOnSegment } from '../geo.js';
import { createCityContext } from './common.js';
import { buildGround } from './ground.js';
import { buildBuildings } from './buildings.js';
import { buildShopSigns } from './shopsigns.js';
import { buildProps } from './props.js';
import { planLandmarks, buildLandmarks } from './landmarks/index.js';

export function buildCity(scene, data, { quality = 'high' } = {}) {
	const ctx = createCityContext(scene, data, { quality });
	const plans = planLandmarks(ctx);
	const landmarks = buildLandmarks(ctx, plans);
	buildGround(ctx);
	const { meshes: buildingMeshes } = buildBuildings(ctx);
	const { vapeShops, placeOnWall, signMat } = buildShopSigns(ctx);
	ctx.placeOnWall = placeOnWall;
	ctx.signMat = signMat;
	buildProps(ctx);

	// Lamps as a grid for "how lit is this spot" (danger) and for the real lights near the player.
	const lampGrid = new Map();
	ctx.lamps.forEach((l) => {
		const k = Math.floor(l.x / 25) + ',' + Math.floor(l.z / 25);
		if (!lampGrid.has(k)) lampGrid.set(k, []);
		lampGrid.get(k).push(l);
	});
	/** Lamps within r of (x, z), nearest first, as [lamp, distanceSquared]. */
	function lampsNear(x, z, r) {
		const out = [];
		for (let gx = Math.floor((x - r) / 25); gx <= Math.floor((x + r) / 25); gx++)
			for (let gz = Math.floor((z - r) / 25); gz <= Math.floor((z + r) / 25); gz++)
				for (const l of lampGrid.get(gx + ',' + gz) || []) {
					const d = (l.x - x) ** 2 + (l.z - z) ** 2;
					if (d < r * r) out.push([l, d]);
				}
		return out.sort((a, b) => a[1] - b[1]);
	}
	function lightAt(x, z) {
		const near = lampsNear(x, z, 22);
		return near.length ? Math.max(0.15, 1 - Math.sqrt(near[0][1]) / 22) : 0;
	}

	/** Push a circle out of any wall or post it overlaps; returns the corrected [x, z]. */
	function collide(x, z, radius) {
		for (let pass = 0; pass < 3; pass++) {
			let moved = false;
			for (const s of ctx.walls.near(x, z, radius + 1)) {
				const [cx, cz] = closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz);
				const dx = x - cx, dz = z - cz;
				const d = Math.hypot(dx, dz);
				if (d < radius && d > 1e-6) {
					x = cx + (dx / d) * radius;
					z = cz + (dz / d) * radius;
					moved = true;
				}
			}
			for (const [p, d2] of ctx.posts.near(x, z, radius + 1.5)) {
				const r = radius + p.data.r;
				if (d2 < r * r && d2 > 1e-8) {
					const d = Math.sqrt(d2);
					x = p.x + ((x - p.x) / d) * r;
					z = p.z + ((z - p.z) / d) * r;
					moved = true;
				}
			}
			if (!moved) break;
		}
		return [x, z];
	}

	function streetAt(x, z) {
		let best = null, bestD = 30 * 30;
		for (const s of ctx.streets.near(x, z, 30)) {
			if (!s.data.name) continue;
			const [cx, cz] = closestOnSegment(x, z, s.ax, s.az, s.bx, s.bz);
			const d = (cx - x) ** 2 + (cz - z) ** 2;
			if (d < bestD) { bestD = d; best = s.data.name; }
		}
		return best;
	}

	let lastNight = -1;
	function setNight(k) {
		if (Math.abs(k - lastNight) < 0.002) return;
		lastNight = k;
		for (const { material, max } of ctx.nightMaterials) material.emissiveIntensity = k * max;
		for (const fn of ctx.nightHooks) fn(k);
	}

	/** Per-frame updates of animated city parts (lights, fountains, flags...). */
	function update(frame) {
		for (const fn of ctx.updaters) fn(frame);
	}

	return {
		root: ctx.root,
		ctx,
		landmarks,
		collide,
		streetAt,
		lightAt,
		lampsNear,
		lamps: ctx.lamps,
		setNight,
		update,
		vapeShops,
		buildingMeshes,
		wallsNear: (x, z, r) => ctx.walls.near(x, z, r),
	};
}
