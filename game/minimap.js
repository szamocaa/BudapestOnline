// A rotating minimap: static layer drawn once, vehicles/player/vendors drawn every frame.
export class Minimap {
	constructor(canvas, data, lines) {
		this.canvas = canvas;
		this.ctx = canvas.getContext('2d');
		this.scale = 0.5; // pixels per metre in the static layer
		const xs = [], zs = [];
		for (const b of data.buildings) { xs.push(b.cx); zs.push(b.cz); }
		for (const r of data.roads) for (const [x, z] of r.pts) { xs.push(x); zs.push(z); }
		const pad = 300;
		this.minX = Math.max(-3000, Math.min(...xs, 0) - pad);
		this.minZ = Math.max(-3000, Math.min(...zs, 0) - pad);
		const maxX = Math.min(3000, Math.max(...xs, 0) + pad), maxZ = Math.min(3000, Math.max(...zs, 0) + pad);
		const w = Math.ceil((maxX - this.minX) * this.scale), h = Math.ceil((maxZ - this.minZ) * this.scale);
		const off = document.createElement('canvas');
		off.width = w;
		off.height = h;
		const g = off.getContext('2d');
		const P = (x, z) => [(x - this.minX) * this.scale, (z - this.minZ) * this.scale];
		g.fillStyle = '#1b1d21';
		g.fillRect(0, 0, w, h);
		const poly = (pts, fill) => {
			g.beginPath();
			pts.forEach(([x, z], i) => { const [px, pz] = P(x, z); if (i) g.lineTo(px, pz); else g.moveTo(px, pz); });
			g.closePath();
			g.fillStyle = fill;
			g.fill();
		};
		for (const a of data.areas) poly(a.outer, a.kind === 'park' || a.kind === 'grass' || a.kind === 'cemetery' ? '#2c4a2a' : a.kind === 'water' ? '#23415a' : '#2b2d31');
		g.lineCap = 'round';
		for (const r of data.roads) {
			g.strokeStyle = r.cls === 'footway' || r.cls === 'path' || r.cls === 'pedestrian' ? '#3a3d43' : '#555960';
			g.lineWidth = Math.max(1, r.width * this.scale);
			g.beginPath();
			r.pts.forEach(([x, z], i) => { const [px, pz] = P(x, z); if (i) g.lineTo(px, pz); else g.moveTo(px, pz); });
			g.stroke();
		}
		for (const b of data.buildings) poly(b.outer, '#6d6559');
		if (data.boundary) {
			g.strokeStyle = 'rgba(255,200,80,0.6)';
			g.setLineDash([6, 4]);
			g.lineWidth = 2;
			g.beginPath();
			data.boundary.forEach(([x, z], i) => { const [px, pz] = P(x, z); if (i) g.lineTo(px, pz); else g.moveTo(px, pz); });
			g.closePath();
			g.stroke();
			g.setLineDash([]);
		}
		for (const l of lines) for (const d of l.directions) {
			g.strokeStyle = l.mode === 'metro' ? 'rgba(228,31,24,0.75)' : l.colour || '#ffd800';
			g.lineWidth = l.mode === 'metro' ? 3 : 2;
			if (l.mode === 'metro') g.setLineDash([5, 4]);
			g.beginPath();
			d.pts.forEach(([x, z], i) => { const [px, pz] = P(x, z); if (i) g.lineTo(px, pz); else g.moveTo(px, pz); });
			g.stroke();
			g.setLineDash([]);
		}
		this.layer = off;
		this.zoom = 1.6; // on-screen pixels per static-layer pixel
	}

	draw(player, vehicles, vendors, entrances) {
		const c = this.ctx, W = this.canvas.width, H = this.canvas.height;
		const k = this.scale * this.zoom;
		c.save();
		c.clearRect(0, 0, W, H);
		c.beginPath();
		c.arc(W / 2, H / 2, W / 2 - 2, 0, Math.PI * 2);
		c.clip();
		c.fillStyle = '#111';
		c.fillRect(0, 0, W, H);
		c.translate(W / 2, H / 2);
		c.rotate(player.yaw); // map turns so "forward" is up
		c.scale(this.zoom, this.zoom);
		c.translate(-(player.x - this.minX) * this.scale, -(player.z - this.minZ) * this.scale);
		c.drawImage(this.layer, 0, 0);
		c.setTransform(1, 0, 0, 1, 0, 0);
		const toScreen = (x, z) => {
			const dx = (x - player.x) * k, dz = (z - player.z) * k;
			const s = Math.sin(player.yaw), co = Math.cos(player.yaw);
			return [W / 2 + dx * co - dz * s, H / 2 + dx * s + dz * co];
		};
		for (const e of entrances) {
			const [sx, sz] = toScreen(e.x, e.z);
			c.fillStyle = '#e41f18';
			c.fillRect(sx - 6, sz - 6, 12, 12);
			c.fillStyle = '#fff';
			c.font = 'bold 10px sans-serif';
			c.fillText('M', sx - 4, sz + 4);
		}
		for (const v of vendors) {
			const [sx, sz] = toScreen(v.x, v.z);
			c.fillStyle = '#39ff88';
			c.beginPath();
			c.arc(sx, sz, 3.5, 0, Math.PI * 2);
			c.fill();
		}
		c.font = 'bold 10px sans-serif';
		for (const v of vehicles) {
			if (v.line.mode === 'metro') continue;
			const [sx, sz] = toScreen(v.x, v.z);
			if (sx < -20 || sz < -20 || sx > W + 20 || sz > H + 20) continue;
			c.fillStyle = v.line.cfg.colour;
			c.strokeStyle = '#000';
			c.lineWidth = 1;
			c.beginPath();
			c.roundRect(sx - 11, sz - 7, 22, 14, 3);
			c.fill();
			c.stroke();
			c.fillStyle = v.line.cfg.text;
			c.textAlign = 'center';
			c.fillText(v.ref, sx, sz + 4);
		}
		c.textAlign = 'left';
		// Player arrow (always pointing up).
		c.fillStyle = '#ffffff';
		c.beginPath();
		c.moveTo(W / 2, H / 2 - 9);
		c.lineTo(W / 2 + 6, H / 2 + 7);
		c.lineTo(W / 2, H / 2 + 3);
		c.lineTo(W / 2 - 6, H / 2 + 7);
		c.closePath();
		c.fill();
		c.restore();
		c.strokeStyle = 'rgba(255,255,255,0.35)';
		c.lineWidth = 2;
		c.beginPath();
		c.arc(W / 2, H / 2, W / 2 - 2, 0, Math.PI * 2);
		c.stroke();
		c.fillStyle = '#fff';
		c.font = 'bold 11px sans-serif';
		c.fillText('É', W / 2 + Math.sin(player.yaw) * (W / 2 - 12) - 4, H / 2 - Math.cos(player.yaw) * (H / 2 - 12) + 4);
	}
}
