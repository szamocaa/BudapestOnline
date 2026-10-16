// Traffic-light timing shared by the cars (traffic/) and the lights you see (city/ furniture), so
// both always agree. Pure functions of position and time: no state.
//
// Each junction runs a fixed 64 s cycle with two phases: the "A" axis (roads running closer to
// north-south) and the "B" axis (closer to east-west). The cycle start is offset per junction so
// neighbouring lights are not in sync.
import { hashString } from '../geo.js';

export const CYCLE = 64; // s
const A_GREEN = 26, YELLOW = 3, ALL_RED = 3; // A: green 0-26, yellow 26-29, red 29-64; B mirrored at 32

/** Axis of a heading (radians, atan2(dx, dz) convention): 'A' = north-south-ish, 'B' = east-west-ish. */
export function axisOf(heading) {
	const c = Math.abs(Math.cos(heading));
	return c >= Math.SQRT1_2 ? 'A' : 'B';
}

function offsetFor(x, z) {
	// Junctions within ~30 m share an offset (one controller per junction).
	return (hashString(`${Math.round(x / 30)},${Math.round(z / 30)}`) % 1000) / 1000 * CYCLE;
}

/** Light colour for vehicles travelling with `heading` through the junction at (x, z) at time t (unix s). */
export function vehicleSignal(x, z, heading, t) {
	const phase = (((t + offsetFor(x, z)) % CYCLE) + CYCLE) % CYCLE;
	const p = axisOf(heading) === 'A' ? phase : (phase + CYCLE / 2) % CYCLE;
	if (p < A_GREEN) return 'green';
	if (p < A_GREEN + YELLOW) return 'yellow';
	return 'red';
}

/**
 * Pedestrian light for people crossing the road whose cars travel with `roadHeading`:
 * green while those cars have red (minus a safety margin).
 */
export function pedestrianSignal(x, z, roadHeading, t) {
	const phase = (((t + offsetFor(x, z)) % CYCLE) + CYCLE) % CYCLE;
	const p = axisOf(roadHeading) === 'A' ? phase : (phase + CYCLE / 2) % CYCLE;
	const redStart = A_GREEN + YELLOW + ALL_RED;
	if (p >= redStart && p < CYCLE - ALL_RED - 6) return 'green';
	if (p >= CYCLE - ALL_RED - 6 && p < CYCLE - ALL_RED) return 'flashing';
	return 'red';
}
