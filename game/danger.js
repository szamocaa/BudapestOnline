// Street danger: depends on the time of day and how well lit the spot is - never on who people are.
// The person who starts trouble is picked at random from whoever is nearby; this module does not
// even have access to how people look (see crowd.js makeLook).

import { rng } from './geo.js';
import { STATE, ROLE } from './crowd.js';

/** 0 (calm) .. 1 (risky) by local hour: quiet mornings, rising through the evening, worst after midnight. */
export function dangerForHour(h) {
	const t = [0.95, 1.0, 1.0, 0.85, 0.55, 0.25, 0.08, 0.05, 0.05, 0.05, 0.06, 0.07, 0.08, 0.08, 0.09, 0.1, 0.12, 0.18, 0.28, 0.4, 0.55, 0.68, 0.78, 0.88];
	const w = ((h % 24) + 24) % 24;
	const i = Math.floor(w);
	return t[i] + (t[(i + 1) % 24] - t[i]) * (w - i);
}

export function dangerLabel(level) {
	if (level < 0.15) return { text: 'nyugis', colour: '#7bd389' };
	if (level < 0.4) return { text: 'figyelj', colour: '#e6c75a' };
	if (level < 0.7) return { text: 'feszült', colour: '#f0954a' };
	return { text: 'gatya', colour: '#ff5a4f' };
}

export const ENCOUNTERS = {
	beg: { title: 'Kéregetés', lines: ['Tesó, nincs egy százasod?', 'Főnök, egy cigire való?', 'Bocsi, kéne egy jegyre való...'] },
	pickpocket: { title: 'Zsebes', lines: [] },
	mugging: { title: 'Rablás', lines: ['Ide a tárcát, gyorsan!', 'Mi van nálad? Pakold ki!', 'Na, te ott! Adj ide mindent!'] },
};

/**
 * Picks and runs encounters. `lightAt(x, z)` returns 0 (dark) .. 1 (well lit).
 * Callbacks: onEncounter({kind, index, line}), onPickpocket(amount), onEnd(kind, outcome).
 */
export class DangerSystem {
	constructor(crowd, { lightAt = () => 0.5, seed = 7 } = {}) {
		this.crowd = crowd;
		this.lightAt = lightAt;
		this.rand = rng(seed);
		this.active = null; // { kind, index, id, phase: 'approach'|'talk', timer }
		this.cooldown = 20;
		this.level = 0;
	}

	/** Current danger at the player's spot. */
	levelAt(hour, x, z) {
		const lit = this.lightAt(x, z);
		return Math.min(1, dangerForHour(hour) * (1.25 - 0.5 * lit));
	}

	/** Uniform choice among nearby walkers/loiterers - appearance plays no part. */
	pickNearby(px, pz, minR, maxR) {
		const c = this.crowd;
		const candidates = [];
		for (let i = 0; i < c.n; i++) {
			if (c.role[i] === ROLE.VENDOR || c.state[i] !== STATE.WALK && c.state[i] !== STATE.IDLE) continue;
			const d2 = (c.x[i] - px) ** 2 + (c.z[i] - pz) ** 2;
			if (d2 >= minR * minR && d2 <= maxR * maxR) candidates.push(i);
		}
		return candidates.length ? candidates[Math.floor(this.rand() * candidates.length)] : -1;
	}

	update(dt, now, hour, player, callbacks) {
		this.level = this.levelAt(hour, player.x, player.z);
		const c = this.crowd;

		if (this.active) {
			const a = this.active;
			let i = a.index;
			if (i >= c.n || c.id[i] !== a.id) i = a.index = Array.prototype.indexOf.call(c.id.subarray(0, c.n), a.id);
			if (i < 0) { this.end(callbacks, 'gone'); return; }
			if (a.phase === 'approach') {
				const dx = player.x - c.x[i], dz = player.z - c.z[i];
				const d = Math.hypot(dx, dz);
				if (d > 70 || player.riding) { this.release(i); this.end(callbacks, 'escaped'); return; }
				const v = a.kind === 'mugging' ? 2.6 : 1.5;
				c.x[i] += (dx / d) * v * dt;
				c.z[i] += (dz / d) * v * dt;
				c.yaw[i] = Math.atan2(dx, dz);
				c.phase[i] += v * dt * 1.7;
				if (d < 1.9) {
					a.phase = 'talk';
					a.timer = a.kind === 'mugging' ? 6 : 10;
					callbacks.onEncounter && callbacks.onEncounter({ kind: a.kind, index: i, line: this.line(a.kind) });
				}
			} else {
				a.timer -= dt;
				const d = Math.hypot(player.x - c.x[i], player.z - c.z[i]);
				c.yaw[i] = Math.atan2(player.x - c.x[i], player.z - c.z[i]);
				if (d > 9) { this.release(i); this.end(callbacks, 'walked-away'); return; }
				if (a.timer <= 0) {
					// Patience ran out: a beggar leaves, a mugger grabs.
					const outcome = a.kind === 'mugging' ? 'robbed' : 'ignored';
					this.release(i);
					this.end(callbacks, outcome);
				}
			}
			return;
		}

		this.cooldown -= dt;
		if (this.cooldown > 0 || player.riding || player.underground) return;
		// Roughly one encounter every couple of minutes at full danger, rare by day.
		if (this.rand() > dt * (0.004 + this.level * 0.012)) return;

		const roll = this.rand();
		let kind;
		if (this.level > 0.55 && roll < this.level * 0.55) kind = 'mugging';
		else if (roll < 0.75) kind = 'beg';
		else kind = 'pickpocket';

		if (kind === 'pickpocket') {
			// Needs a crowd around you.
			let near = 0;
			for (let i = 0; i < c.n; i++) if ((c.x[i] - player.x) ** 2 + (c.z[i] - player.z) ** 2 < 36) near++;
			if (near < 4) return;
			this.cooldown = 60;
			callbacks.onPickpocket && callbacks.onPickpocket(500 + Math.floor(this.rand() * 6) * 500);
			return;
		}
		const i = this.pickNearby(player.x, player.z, 12, 55);
		if (i < 0) return;
		c.state[i] = STATE.APPROACH;
		this.active = { kind, index: i, id: c.id[i], phase: 'approach', timer: 0 };
	}

	line(kind) {
		const lines = ENCOUNTERS[kind].lines;
		return lines[Math.floor(this.rand() * lines.length)];
	}

	/** Player response while talking: 'pay' | 'refuse' | 'spray' | 'punch'. Returns the outcome. */
	respond(action, callbacks) {
		const a = this.active;
		if (!a || a.phase !== 'talk') return null;
		const i = a.index;
		let outcome;
		if (action === 'pay') outcome = 'paid';
		else if (action === 'spray') {
			this.crowd.state[i] = STATE.STUNNED;
			this.crowd.timer[i] = 6;
			outcome = 'sprayed';
		} else if (action === 'punch') {
			// A punch works on the timid, but a mugger may hit back.
			outcome = a.kind === 'mugging' && this.rand() < 0.5 ? 'fight-lost' : 'fight-won';
			this.crowd.state[i] = outcome === 'fight-won' ? STATE.KNOCKED : STATE.FLEE;
			this.crowd.timer[i] = 4;
		} else {
			outcome = a.kind === 'mugging' && this.rand() < 0.6 ? 'robbed' : 'left';
		}
		if (this.crowd.state[i] === STATE.APPROACH) this.release(i);
		this.end(callbacks, outcome);
		return outcome;
	}

	release(i) {
		if (i >= 0 && i < this.crowd.n && this.crowd.state[i] === STATE.APPROACH) this.crowd.state[i] = STATE.FLEE;
	}

	end(callbacks, outcome) {
		const kind = this.active && this.active.kind;
		this.active = null;
		this.cooldown = 25 + this.rand() * 40;
		callbacks.onEnd && callbacks.onEnd(kind, outcome);
	}
}
