// Turns a person's look (crowd.js makeLook) and simulation state into the per-instance numbers the
// crowd shader reads (see shader.js for the layout). Pure functions, unit tested.
import { REF_HEIGHT } from './body.js';

export const STRIDE = 24; // floats per instance: iA, iB, iC, iD, iE, iF

/** sRGB '#rrggbb' as one float holding the 24-bit integer (exact in float32). */
export function packColor(hex) {
	return parseInt(hex.slice(1, 7), 16);
}

export function unpackColor(f) {
	return [Math.floor(f / 65536) & 255, Math.floor(f / 256) & 255, f & 255];
}

/** The 16 constant floats (iC, iD, iE, iF) of a look. */
export function packLook(L, out = new Float32Array(16)) {
	out[0] = L.height / REF_HEIGHT;
	out[1] = L.fem;
	out[2] = L.heavy;
	out[3] = L.age;
	out[4] = packColor(L.skin);
	out[5] = packColor(L.hair);
	out[6] = packColor(L.top);
	out[7] = packColor(L.legs);
	out[8] = packColor(L.bottom);
	out[9] = packColor(L.shoes);
	out[10] = packColor(L.accent);
	out[11] = packColor(L.bag);
	out[12] = L.hairStyle + 8 * L.headwear;
	out[13] = L.upper + 8 * L.lower + 32 * L.shoeStyle;
	out[14] = L.acc;
	out[15] = L.walkStyle + 4 * L.idleStyle;
	return out;
}

// crowd.js STATE -> shader animation (0 walk, 1 idle, 2 run, 3 knocked down, 4 stunned).
const ANIM_OF_STATE = [0, 1, 2, 0, 3, 4];
export const animOf = (state) => ANIM_OF_STATE[state] ?? 1;

/**
 * Gait angle (0..2pi) and stride scale for someone who has walked `phase` (crowd.js advances phase
 * by 1.7 per metre). One gait cycle (two steps) covers the stride length, so feet keep pace with
 * the ground: about 1.35 m at a normal walk for a 1.75 m person, longer when faster or running.
 */
export function gait(phase, speed, heightScale, anim) {
	const run = anim === 2;
	const amp = run ? 1 : Math.min(1.2, Math.max(0.8, 0.85 + (speed - 1.05) * 0.5));
	const stride = (run ? 2.4 : 1.35 * amp) * heightScale;
	const a = ((phase / 1.7) / stride) * Math.PI * 2;
	return [a - Math.floor(a / (Math.PI * 2)) * Math.PI * 2, amp];
}
