// Everything the player sees on top of the 3D view: loading screen, HUD panels, prompts, dialogs,
// toasts, the departure board and the help overlay. main.js only passes plain data in.
const $ = (id) => document.getElementById(id);

export const fmtFt = (n) => `${Math.round(n).toLocaleString('hu-HU')} Ft`;

export function createHud() {
	let lastPrompt = '';
	const hud = {
		/** Loading screen status line and progress bar (0..1). */
		status(text, progress) {
			$('status').textContent = text;
			if (progress != null) $('progress').firstElementChild.style.width = `${Math.round(progress * 100)}%`;
		},
		/** The loading screen's button: { label, onClick } or null to hide it. */
		loadingButton(opts) {
			const b = $('start');
			if (!opts) { b.style.display = 'none'; b.onclick = null; return; }
			b.textContent = opts.label;
			b.style.display = 'inline-block';
			b.onclick = opts.onClick;
		},
		/** Leave the loading screen and show the HUD. */
		enterGame() {
			$('loading').style.display = 'none';
			$('hud').classList.add('on');
		},
		toast(text) {
			const el = document.createElement('div');
			el.className = 'toast';
			el.textContent = text;
			$('toasts').appendChild(el);
			setTimeout(() => el.remove(), 5200);
			while ($('toasts').children.length > 4) $('toasts').firstElementChild.remove();
		},
		/** Context prompt at the bottom ("E – Felszállás ..."). key: shown as a key cap; '' hides it. */
		prompt(html) {
			if (html === lastPrompt) return;
			lastPrompt = html;
			const el = $('prompt');
			el.innerHTML = html;
			el.style.display = html ? 'block' : 'none';
		},
		/** An encounter dialog: who/say text and numbered options. */
		dialog(who, say, options) {
			const el = $('dialog');
			el.innerHTML = `<div class="who">${who}</div><div class="say">${say}</div>` + options.map((o, i) => `<div class="opt"><kbd>${i + 1}</kbd>${o}</div>`).join('');
			el.style.display = 'block';
		},
		/** A shop dialog: items [{ name, price }]. */
		shop(title, say, items) {
			const el = $('shop');
			el.innerHTML = `<div class="who">${title}</div><div class="say">${say}</div>` +
				items.map((m, i) => `<div class="opt"><kbd>${i + 1}</kbd>${m.name} – <b>${fmtFt(m.price)}</b></div>`).join('') +
				'<div class="opt" style="color:var(--muted)"><kbd>E</kbd>Köszi, majd máskor</div>';
			el.style.display = 'block';
		},
		hideDialogs() {
			$('dialog').style.display = 'none';
			$('shop').style.display = 'none';
		},
		/**
		 * The ride panel: null hides it; otherwise { ref, mode: 'tram'|'bus'|'metro', headsign, line2 }
		 * or { ref, mode, text } for a single plain-text message.
		 */
		ride(info) {
			const el = $('ride');
			if (!info) { el.style.display = 'none'; return; }
			el.style.display = 'block';
			const cls = info.mode === 'tram' ? '' : info.mode === 'metro' ? 'metro' : 'bus';
			const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
			if (info.text != null) { el.innerHTML = `<span class="badge ${cls}">${info.ref}</span>${esc(info.text)}`; return; }
			el.innerHTML = `<span class="badge ${cls}">${info.ref}</span>${info.headsign ? '▸ ' + esc(info.headsign) : ''}${info.line2 ? `<br><span style="color:var(--muted)">${esc(info.line2)}</span>` : ''}`;
		},
		/**
		 * Main HUD numbers. s = { time, seconds, date, weekday, zone, timeNote, street, danger: { level, text, colour },
		 * money, health, items, liveStatus, mapSource, sunEl }
		 */
		update(s) {
			$('clock').innerHTML = `${s.time}<small>${s.seconds}</small>`;
			$('date').textContent = `${s.date} ${s.weekday} · ${s.zone}${s.timeNote}`;
			$('street').textContent = s.street || '—';
			$('dangerText').textContent = s.danger.text;
			$('dangerText').style.color = s.danger.colour;
			const bar = $('dangerBar').firstElementChild;
			bar.style.width = `${Math.round(s.danger.level * 100)}%`;
			bar.style.background = s.danger.colour;
			$('money').textContent = fmtFt(s.money);
			$('healthBar').firstElementChild.style.width = `${Math.max(0, s.health)}%`;
			$('items').textContent = s.items;
			$('dataSrc').innerHTML = `BKK: <b>${s.liveStatus}</b><br>Térkép: <b>${s.mapSource}</b> · Nap ${s.sunEl.toFixed(0)}°`;
		},
		/**
		 * Departure board at the nearest stop: null hides it, else
		 * { stopName, rows: [{ ref, mode, headsign, minutes }], note }.
		 */
		board(b) {
			const el = $('board');
			if (!b || !b.rows.length) { el.style.display = 'none'; return; }
			el.style.display = 'block';
			el.innerHTML = `<h3>🚏 ${b.stopName}</h3>` + b.rows.map((d) => `<div class="row"><span class="badge ${d.mode === 'tram' ? '' : 'bus'}">${d.ref}</span><span class="head">${d.headsign}</span><span class="min">${d.minutes === 0 ? 'most' : d.minutes + ' p'}</span></div>`).join('') +
				`<div style="color:var(--muted);font-size:11px;margin-top:4px">${b.note}</div>`;
		},
		help(show) {
			const el = $('help');
			el.style.display = show == null ? (el.style.display === 'flex' ? 'none' : 'flex') : show ? 'flex' : 'none';
		},
	};
	return hud;
}
