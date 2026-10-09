// Sun and moon positions and Budapest local time. Port of Source/BudapestSim/World/Astro.cpp
// (checked against PyEphem and the tz database; see tests/web/astro.test.mjs).

const DEG = Math.PI / 180;
const wrap360 = (d) => ((d % 360) + 360) % 360;
const jd = (unix) => unix / 86400 + 2440587.5;

function daysFromCivil(y, m, d) {
	y -= m <= 2 ? 1 : 0;
	const era = Math.floor((y >= 0 ? y : y - 399) / 400);
	const yoe = y - era * 400;
	const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
	const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
	return era * 146097 + doe - 719468;
}

function gmst(j) {
	const T = (j - 2451545) / 36525;
	return wrap360(280.46061837 + 360.98564736629 * (j - 2451545) + 0.000387933 * T * T);
}

function toHorizontal(ra, dec, j, lat, lon) {
	const H = (gmst(j) + lon) * DEG - ra;
	const phi = lat * DEG;
	const sinEl = Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H);
	const el = Math.asin(Math.max(-1, Math.min(1, sinEl))) / DEG;
	const az = wrap360(Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)) / DEG + 180);
	return { elevation: el, azimuth: az };
}

function sunEquatorial(j) {
	const T = (j - 2451545) / 36525;
	const L0 = wrap360(280.46646 + T * (36000.76983 + T * 0.0003032));
	const M = (357.52911 + T * (35999.05029 - T * 0.0001537)) * DEG;
	const C = Math.sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M) * (0.019993 - 0.000101 * T) + Math.sin(3 * M) * 0.000289;
	const omega = (125.04 - 1934.136 * T) * DEG;
	const lambda = (L0 + C - 0.00569 - 0.00478 * Math.sin(omega)) * DEG;
	const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
	const eps = (eps0 + 0.00256 * Math.cos(omega)) * DEG;
	return { ra: Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)), dec: Math.asin(Math.sin(eps) * Math.sin(lambda)) };
}

export function sunPosition(unix, lat, lon) {
	const j = jd(unix);
	const s = sunEquatorial(j);
	return toHorizontal(s.ra, s.dec, j, lat, lon);
}

export function moonPosition(unix, lat, lon) {
	const j = jd(unix);
	const T = (j - 2451545) / 36525;
	const L = wrap360(218.3164477 + 481267.88123421 * T);
	const D = wrap360(297.8501921 + 445267.1114034 * T) * DEG;
	const M = wrap360(357.5291092 + 35999.0502909 * T) * DEG;
	const Mp = wrap360(134.9633964 + 477198.8675055 * T) * DEG;
	const F = wrap360(93.272095 + 483202.0175233 * T) * DEG;
	const lam = (L + 6.289 * Math.sin(Mp) + 1.274 * Math.sin(2 * D - Mp) + 0.658 * Math.sin(2 * D) + 0.214 * Math.sin(2 * Mp) - 0.186 * Math.sin(M) - 0.114 * Math.sin(2 * F)) * DEG;
	const bet = (5.128 * Math.sin(F) + 0.281 * Math.sin(Mp + F) + 0.278 * Math.sin(Mp - F) + 0.173 * Math.sin(2 * D - F)) * DEG;
	const distKm = 385001 - 20905 * Math.cos(Mp);
	const eps = (23.4392911 - 0.0130042 * T) * DEG;
	const ra = Math.atan2(Math.sin(lam) * Math.cos(eps) - Math.tan(bet) * Math.sin(eps), Math.cos(lam));
	const dec = Math.asin(Math.sin(bet) * Math.cos(eps) + Math.cos(bet) * Math.sin(eps) * Math.sin(lam));
	const h = toHorizontal(ra, dec, j, lat, lon);
	const par = Math.asin(6378.14 / distKm);
	h.elevation -= (par / DEG) * Math.cos(h.elevation * DEG);
	const s = sunEquatorial(j);
	const cosSep = Math.sin(s.dec) * Math.sin(dec) + Math.cos(s.dec) * Math.cos(dec) * Math.cos(s.ra - ra);
	h.illumination = (1 - Math.max(-1, Math.min(1, cosSep))) / 2;
	return h;
}

function lastSundayAtOneUtc(year, month) {
	const nextY = month === 12 ? year + 1 : year;
	const nextM = month === 12 ? 1 : month + 1;
	const last = daysFromCivil(nextY, nextM, 1) - 1;
	const wd = (((last + 4) % 7) + 7) % 7; // 0 = Sunday (1970-01-01 was a Thursday)
	return (last - wd) * 86400 + 3600;
}

/** Hours Budapest is ahead of UTC (EU summer time rule). */
export function budapestOffsetHours(unix) {
	const year = new Date(Math.floor(unix) * 1000).getUTCFullYear();
	return unix >= lastSundayAtOneUtc(year, 3) && unix < lastSundayAtOneUtc(year, 10) ? 2 : 1;
}

/** Local Budapest wall-clock time of day in hours [0, 24). */
export function budapestHours(unix) {
	const local = unix + 3600 * budapestOffsetHours(unix);
	return (((local % 86400) + 86400) % 86400) / 3600;
}

export function budapestClock(unix) {
	const off = budapestOffsetHours(unix);
	const d = new Date((Math.floor(unix) + off * 3600) * 1000);
	const pad = (n) => String(n).padStart(2, '0');
	const days = ['vasárnap', 'hétfő', 'kedd', 'szerda', 'csütörtök', 'péntek', 'szombat'];
	return {
		time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
		seconds: pad(d.getUTCSeconds()),
		date: `${d.getUTCFullYear()}. ${pad(d.getUTCMonth() + 1)}. ${pad(d.getUTCDate())}.`,
		weekday: days[d.getUTCDay()],
		dayIndex: d.getUTCDay(),
		zone: off === 2 ? 'CEST' : 'CET',
	};
}
