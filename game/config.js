// Game settings. Anything here can be overridden from the address bar, e.g.
//   index.html?time=2026-10-09T22:30&speed=60&people=1500&quality=low&key=YOUR-KEY
export const CONFIG = {
	// BudapestGO / BKK FUTÁR public API key (from opendata.bkk.hu). It is visible to anyone who
	// opens the game, like every key used by a browser app; you can rotate it at opendata.bkk.hu.
	bkkKey: 'b69979df-2069-478b-9585-1371947d2e80',
	bkkBases: [
		'https://futar.bkk.hu/api/query/v1/ws/otp/api/where/',
		'https://go.bkk.hu/api/query/v1/ws/otp/api/where/',
	],
	livePollSeconds: 15,
	// People out in the whole district at the busiest hour (fewer at night).
	people: 2600,
	// How many are drawn around you at once.
	drawPeople: 900,
	quality: 'high',
	// Time speed: 1 = real time (a day takes 24 hours). Use ?speed=60 to watch a day in 24 minutes.
	speed: 1,
	startMoney: 20000,
};

export function applyUrlOverrides(cfg) {
	const q = new URLSearchParams(location.search);
	if (q.get('key')) cfg.bkkKey = q.get('key');
	if (q.get('speed')) cfg.speed = Math.max(0, parseFloat(q.get('speed')) || 1);
	if (q.get('people')) cfg.people = Math.max(0, parseInt(q.get('people'), 10) || cfg.people);
	if (q.get('quality')) cfg.quality = q.get('quality');
	if (q.get('time')) cfg.time = q.get('time');
	if (q.get('nolive')) cfg.noLive = true;
	if (q.get('fallback')) cfg.forceFallback = true;
	if (q.get('test')) cfg.test = true;
	if (cfg.quality === 'low') {
		cfg.drawPeople = Math.min(cfg.drawPeople, 400);
		cfg.people = Math.min(cfg.people, 1400);
	}
	return cfg;
}

/** Parses "2026-10-09T22:30" as Budapest local time and returns Unix seconds. */
export function parseBudapestTime(text, offsetFor) {
	const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{1,2}):(\d{2}))?$/.exec(text || '');
	if (!m) return null;
	const utcGuess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 12), +(m[5] || 0)) / 1000;
	return utcGuess - offsetFor(utcGuess) * 3600;
}
