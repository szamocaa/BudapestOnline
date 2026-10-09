// All textures are drawn at start-up on canvases: no image files needed.
import * as THREE from './vendor/three.module.min.js';
import { rng } from './geo.js';

function canvas(w, h) {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	return [c, c.getContext('2d')];
}

function toTexture(c, { repeat = true, srgb = true, aniso = 8 } = {}) {
	const t = new THREE.CanvasTexture(c);
	if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
	t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
	t.anisotropy = aniso;
	t.needsUpdate = true;
	return t;
}

function noise(ctx, w, h, amount, r, alpha = 0.08) {
	for (let i = 0; i < amount; i++) {
		const v = Math.floor(r() * 255);
		ctx.fillStyle = `rgba(${v},${v},${v},${alpha})`;
		ctx.fillRect(r() * w, r() * h, 1 + r() * 3, 1 + r() * 3);
	}
}

/**
 * Upper-floor facade in one plaster colour: an atlas of CELLS x FLOORS window bays (each bay 3.2 m
 * wide, 3.4 m tall), plus the matching night emissive map with a random ~35 % of windows lit.
 * Buildings pick a colour variant and a random offset into the atlas, so neighbours differ.
 */
export function facadeTextures(seed, plaster) {
	const CELLS = 8, FLOORS = 8, CW = 96, CH = 102;
	const [c, g] = canvas(CELLS * CW, FLOORS * CH);
	const [e, ge] = canvas(CELLS * CW, FLOORS * CH);
	const r = rng(seed);
	const base = new THREE.Color(plaster);
	const tone = (k) => `rgb(${Math.round(Math.min(1, base.r * k) * 255)},${Math.round(Math.min(1, base.g * k) * 255)},${Math.round(Math.min(1, base.b * k) * 255)})`;
	ge.fillStyle = '#000';
	ge.fillRect(0, 0, e.width, e.height);
	const style = Math.floor(r() * 3); // 0 plain sash windows, 1 arched heads, 2 with shutters
	for (let fy = 0; fy < FLOORS; fy++) {
		for (let cx = 0; cx < CELLS; cx++) {
			const x0 = cx * CW, y0 = fy * CH;
			g.fillStyle = tone(0.92 + r() * 0.1);
			g.fillRect(x0, y0, CW, CH);
			g.fillStyle = tone(0.78);
			g.fillRect(x0, y0 + CH - 7, CW, 7); // string course between floors
			const ww = 36 + Math.floor(r() * 8), wh = 54 + Math.floor(r() * 8);
			const wx = x0 + (CW - ww) / 2, wy = y0 + 22;
			g.fillStyle = tone(1.08); // stucco surround
			g.fillRect(wx - 7, wy - 7, ww + 14, wh + 14);
			if (style === 1) {
				g.beginPath();
				g.arc(wx + ww / 2, wy - 2, ww / 2 + 7, Math.PI, 0);
				g.fill();
			}
			g.fillStyle = '#d9d4ca'; // frame
			g.fillRect(wx - 3, wy - 3, ww + 6, wh + 6);
			const gt = 28 + Math.floor(r() * 30);
			const grad = g.createLinearGradient(wx, wy, wx + ww, wy + wh);
			grad.addColorStop(0, `rgb(${gt + 45},${gt + 55},${gt + 70})`);
			grad.addColorStop(1, `rgb(${gt},${gt + 6},${gt + 14})`);
			g.fillStyle = grad;
			g.fillRect(wx, wy, ww, wh);
			if (r() < 0.45) {
				g.fillStyle = `rgb(${150 + r() * 80},${140 + r() * 70},${120 + r() * 60})`;
				g.fillRect(wx + 2, wy + 2, ww / 2 - 4, wh * (0.4 + r() * 0.5));
			}
			g.fillStyle = '#cfc9bd';
			g.fillRect(wx + ww / 2 - 2, wy, 4, wh);
			g.fillRect(wx, wy + wh * 0.32, ww, 3);
			if (style === 2 && r() < 0.8) {
				g.fillStyle = r() < 0.5 ? '#5d6b52' : '#6e5a43';
				g.fillRect(wx - 16, wy, 12, wh);
				g.fillRect(wx + ww + 4, wy, 12, wh);
			}
			g.fillStyle = tone(0.7);
			g.fillRect(wx - 9, wy + wh + 5, ww + 18, 5); // sill
			if (r() < 0.08) {
				// Satellite dish or air-conditioner box.
				g.fillStyle = r() < 0.5 ? '#e6e6e6' : '#b8b8b8';
				g.fillRect(wx + ww + 10, wy + wh - 18, 16, 14);
			}
			if (r() < 0.35) {
				const warm = r() < 0.85;
				ge.fillStyle = warm ? `rgb(255,${190 + r() * 40},${110 + r() * 50})` : 'rgb(150,175,255)';
				ge.fillRect(wx, wy, ww, wh);
				ge.fillStyle = 'rgba(0,0,0,0.4)';
				ge.fillRect(wx + ww / 2 - 2, wy, 4, wh);
				ge.fillRect(wx, wy + wh * 0.32, ww, 3);
			}
		}
	}
	noise(g, c.width, c.height, 9000, r, 0.05);
	for (let i = 0; i < 70; i++) {
		const x = r() * c.width, y = r() * c.height;
		const grad = g.createLinearGradient(x, y, x, y + 90);
		grad.addColorStop(0, 'rgba(50,45,40,0.13)');
		grad.addColorStop(1, 'rgba(50,45,40,0)');
		g.fillStyle = grad;
		g.fillRect(x, y, 10 + r() * 24, 90);
	}
	return { map: toTexture(c), emissive: toTexture(e), cellsX: CELLS, cellsY: FLOORS };
}

/** Ground floor: shopfronts, doorways and closed roller shutters (4.5 m bays, 3.6 m high). */
export function shopfrontTexture(seed = 2) {
	const N = 8, W = 128, H = 104;
	const [c, g] = canvas(N * W, H);
	const r = rng(seed);
	const signColours = ['#1f4e79', '#7a1f1f', '#1f5e3a', '#333333', '#c27c0e', '#5a2a6e', '#0e6e6e'];
	for (let i = 0; i < N; i++) {
		const x0 = i * W;
		g.fillStyle = 'rgba(205,200,192,1)';
		g.fillRect(x0, 0, W, H);
		g.fillStyle = 'rgba(80,75,70,1)';
		g.fillRect(x0, H - 6, W, 6); // plinth
		const kind = r();
		if (kind < 0.45) {
			// Shop window with a sign.
			g.fillStyle = signColours[Math.floor(r() * signColours.length)];
			g.fillRect(x0 + 8, 8, W - 16, 16);
			g.fillStyle = 'rgba(255,255,255,0.8)';
			for (let k = 0; k < 5; k++) g.fillRect(x0 + 18 + k * 18, 13, 10, 6);
			const gr = g.createLinearGradient(x0, 30, x0 + W, H);
			gr.addColorStop(0, 'rgb(90,105,115)');
			gr.addColorStop(1, 'rgb(25,30,36)');
			g.fillStyle = gr;
			g.fillRect(x0 + 10, 30, W - 20, H - 40);
			g.fillStyle = 'rgb(50,50,50)';
			g.fillRect(x0 + W / 2 - 1, 30, 3, H - 40);
		} else if (kind < 0.7) {
			// Roller shutter, often tagged.
			g.fillStyle = 'rgb(150,152,150)';
			g.fillRect(x0 + 10, 26, W - 20, H - 34);
			g.fillStyle = 'rgb(110,112,110)';
			for (let y = 28; y < H - 8; y += 5) g.fillRect(x0 + 10, y, W - 20, 1);
			if (r() < 0.7) {
				g.font = `bold ${16 + Math.floor(r() * 10)}px sans-serif`;
				g.fillStyle = ['rgb(200,40,60)', 'rgb(30,30,30)', 'rgb(40,90,200)'][Math.floor(r() * 3)];
				g.fillText(['VIII', 'NYOLC', 'ZG', 'FTC', 'JÓZSI', 'KMK'][Math.floor(r() * 6)], x0 + 18, 70);
			}
		} else {
			// Big wooden gate into the courtyard (bérház kapu).
			g.fillStyle = 'rgb(90,60,40)';
			g.fillRect(x0 + 34, 18, W - 68, H - 24);
			g.fillStyle = 'rgb(60,40,28)';
			g.fillRect(x0 + W / 2 - 1, 18, 2, H - 24);
			g.beginPath();
			g.arc(x0 + W / 2, 30, (W - 68) / 2, Math.PI, 0);
			g.fillStyle = 'rgb(70,48,32)';
			g.fill();
		}
	}
	noise(g, c.width, c.height, 2500, r, 0.06);
	const t = toTexture(c);
	return { map: t, bays: N };
}

function tiled(w, h, draw, opts) {
	const [c, g] = canvas(w, h);
	draw(g, w, h);
	return toTexture(c, opts);
}

export function asphaltTexture() {
	return tiled(256, 256, (g, w, h) => {
		const r = rng(5);
		g.fillStyle = '#3b3c3e';
		g.fillRect(0, 0, w, h);
		noise(g, w, h, 6000, r, 0.12);
		for (let i = 0; i < 6; i++) {
			g.strokeStyle = 'rgba(20,20,20,0.35)';
			g.beginPath();
			let x = r() * w, y = r() * h;
			g.moveTo(x, y);
			for (let k = 0; k < 6; k++) g.lineTo((x += (r() - 0.5) * 40), (y += (r() - 0.5) * 40));
			g.stroke();
		}
	});
}

export function pavementTexture() {
	return tiled(256, 256, (g, w, h) => {
		const r = rng(6);
		g.fillStyle = '#8d8a84';
		g.fillRect(0, 0, w, h);
		const s = 32;
		for (let y = 0; y < h; y += s) for (let x = 0; x < w; x += s) {
			const v = 128 + Math.floor(r() * 30);
			g.fillStyle = `rgb(${v},${v - 2},${v - 6})`;
			g.fillRect(x + 1, y + 1, s - 2, s - 2);
		}
		noise(g, w, h, 3000, r, 0.1);
		// Old chewing gum and stains.
		for (let i = 0; i < 40; i++) {
			g.fillStyle = 'rgba(40,40,40,0.25)';
			g.beginPath();
			g.arc(r() * w, r() * h, 1 + r() * 2.5, 0, Math.PI * 2);
			g.fill();
		}
	});
}

export function cobbleTexture() {
	return tiled(256, 256, (g, w, h) => {
		const r = rng(7);
		g.fillStyle = '#5b5852';
		g.fillRect(0, 0, w, h);
		const s = 16;
		for (let y = 0; y < h; y += s) for (let x = (y / s) % 2 ? s / 2 : 0; x < w + s; x += s) {
			const v = 95 + Math.floor(r() * 45);
			g.fillStyle = `rgb(${v},${v - 4},${v - 10})`;
			g.beginPath();
			g.ellipse(x, y + s / 2, s / 2 - 1.5, s / 2 - 2, 0, 0, Math.PI * 2);
			g.fill();
		}
	});
}

export function grassTexture() {
	return tiled(256, 256, (g, w, h) => {
		const r = rng(8);
		g.fillStyle = '#4c6b34';
		g.fillRect(0, 0, w, h);
		for (let i = 0; i < 9000; i++) {
			const v = r();
			g.fillStyle = v < 0.5 ? `rgba(30,60,20,0.25)` : v < 0.9 ? 'rgba(110,140,70,0.25)' : 'rgba(120,100,60,0.3)';
			g.fillRect(r() * w, r() * h, 1, 2 + r() * 3);
		}
	});
}

export function roofTexture() {
	return tiled(128, 128, (g, w, h) => {
		const r = rng(9);
		g.fillStyle = '#d0d0d0';
		g.fillRect(0, 0, w, h);
		for (let x = 0; x < w; x += 8) {
			g.fillStyle = 'rgba(0,0,0,0.12)';
			g.fillRect(x, 0, 1, h);
		}
		noise(g, w, h, 1500, r, 0.12);
	});
}

/** A text sign (shop sign, stop name, line number) as a texture. */
export function signTexture(text, { bg = '#1b1b1b', fg = '#ffffff', w = 512, h = 128, font = 'bold 72px Arial, sans-serif', border = null } = {}) {
	const [c, g] = canvas(w, h);
	g.fillStyle = bg;
	g.fillRect(0, 0, w, h);
	if (border) {
		g.strokeStyle = border;
		g.lineWidth = 8;
		g.strokeRect(4, 4, w - 8, h - 8);
	}
	g.fillStyle = fg;
	g.font = font;
	g.textAlign = 'center';
	g.textBaseline = 'middle';
	let size = parseInt(font.match(/(\d+)px/)[1], 10);
	while (g.measureText(text).width > w - 30 && size > 12) {
		size -= 4;
		g.font = font.replace(/\d+px/, size + 'px');
	}
	g.fillText(text, w / 2, h / 2 + 2);
	return toTexture(c, { repeat: false });
}

/** Simple radial glow sprite for lamps and lights. */
export function glowTexture() {
	const [c, g] = canvas(64, 64);
	const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
	gr.addColorStop(0, 'rgba(255,240,210,1)');
	gr.addColorStop(0.25, 'rgba(255,210,150,0.5)');
	gr.addColorStop(1, 'rgba(255,200,140,0)');
	g.fillStyle = gr;
	g.fillRect(0, 0, 64, 64);
	return toTexture(c, { repeat: false });
}
