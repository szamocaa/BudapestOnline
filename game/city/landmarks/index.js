// Hand-made models of Józsefváros' landmarks, placed on their real OSM footprints.
//
// Each landmark module exports a definition:
//   export default {
//     id: 'keleti',                       // short id
//     name: 'Keleti pályaudvar',
//     lat, lon,                           // reference point (used when OSM data is missing)
//     match(b) { return ... },            // true for OSM buildings/parts this model replaces
//     build(ctx, site) { ... },           // add meshes under ctx.root, colliders via ctx.addSolid*
//   };
// `site` = { buildings: [the matched OSM buildings], x, z (reference point in world metres) }.
// The matched buildings are suppressed (buildings.js skips them) before anything is built.
import { toXZ } from '../../geo.js';

/** Registered landmark definitions (landmark modules add themselves here via this list). */
import { LANDMARKS } from './registry.js';

/** Marks the OSM buildings each landmark replaces. Call before buildBuildings. */
export function planLandmarks(ctx) {
	const plans = [];
	for (const def of LANDMARKS) {
		let buildings = [];
		try {
			buildings = def.match ? ctx.data.buildings.filter((b) => def.match(b)) : [];
		} catch (err) {
			console.warn(`landmark ${def.id}: match failed`, err);
		}
		for (const b of buildings) ctx.suppressed.add(b.id);
		const [x, z] = toXZ(def.lat, def.lon);
		plans.push({ def, site: { buildings, x, z } });
	}
	return plans;
}

/**
 * Builds every planned landmark. Runs BEFORE buildBuildings, so a landmark that fails gets its
 * original OSM blocks back (and one broken landmark never stops the city from loading).
 */
export function buildLandmarks(ctx, plans) {
	const built = [];
	for (const { def, site } of plans) {
		try {
			def.build(ctx, site);
			built.push(def.id);
		} catch (err) {
			console.error(`landmark ${def.id} failed`, err);
			// Put the original OSM blocks back so there is no hole in the city.
			for (const b of site.buildings) ctx.suppressed.delete(b.id);
		}
	}
	return built;
}
