# Area: ui – HUD, menus, loading screen, minimap

Owns: `index.html` (markup and CSS), `game/ui/*`, `game/minimap.js`, `game/assets/fonts/*`.
`main.js` only calls the `hud` methods in `game/ui/hud.js` (keep their names and arguments; you may
add more and list them in integration notes). Budget: HUD DOM updates ≤ 4 per second.

Make it feel like a premium game:

1. **Visual language**: a coherent design system (type scale, spacing, colours, glass panels with
   subtle borders and shadows, smooth transitions). Vendor an open-licensed font from npm
   (`@fontsource/*`, OFL) as woff2 with its licence; a DIN-like face suits BKK signage. Inline SVG
   icons (no emoji). Hungarian copy throughout.
2. **HUD**: compact clock/date/place/safety panel; money and health; a BKK FUTÁR-style departure
   board (dark panel, amber/white LED-like text, line badges in BKK colours: tram yellow #FFD800
   with black text, bus blue #009EE3, M2 red #E41F18); the in-vehicle ride display styled like the
   real passenger information screen; prompts as clean key-cap hints; dialogs as cinematic
   subtitles with options; toasts.
3. **Title / loading screen**: a strong title "Budapest Online — Józsefváros", a background (e.g. an
   SVG/CSS skyline of Józsefváros with the Keleti facade, or a blurred live render once the city is
   built), staged progress, then a main menu: Indulás, Beállítások (quality low/medium/high →
   `CONFIG.quality` + `pipeline.setQuality` if present; volume → `audio.setVolume`; mouse
   sensitivity → `player.sensitivity`; field of view), Irányítás (controls), Credits (OpenStreetMap
   ODbL, BKK CC BY 4.0, three.js MIT, fonts OFL, any audio credits). Settings persist in
   localStorage (wrap every access in try/catch).
4. **Pause menu** (Esc releases the pointer → show pause: Folytatás, Beállítások, Irányítás).
5. **Minimap**: cleaner and more legible (roads by class, buildings, parks, the lines in BKK
   colours, M2 entrances, vape sellers, landmark icons, north marker), optional north-up mode.
6. Mobile: tidy touch controls (stick, E, jump) that don't cover the HUD.

Check with screenshots (`tests/web/shot.mjs` captures the HUD too) and make sure the whole flow
works in Chromium: loading → menu → start → pause → settings → resume, with no console errors.
To let main.js call new things (e.g. a pause menu needing `player.locked` changes), add methods to
`hud` and document the one-line calls the integrator must add to `main.js`.
