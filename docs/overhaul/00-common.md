# Budapest Online – the "real & expensive" overhaul: common brief

Read this first, then your area brief (`docs/overhaul/<area>.md`).

## What the player asked for

> "make the sights look more lookalike irl, make it exactly the same, make the metro system look
> better, and everything else, make the game feel 'real, expensive' the character designs, and tbh.
> everything"

The game is a first-person browser game set in Budapest's VIII. district (Józsefváros): real-time
24-hour day, real BKK lines (bus 99, trams 23, 24, 28A, M2 metro Blaha–Keleti), lots of people,
vape sellers, safer mornings and dangerous nights. Hungarian UI.

## The quality bar

* Someone from Budapest recognises every place instantly: Blaha Lujza tér, Népszínház utca, József
  körút, Rákóczi út, Keleti pályaudvar, the Nemzeti Múzeum, II. János Pál pápa tér, Kerepesi temető,
  Corvin köz, Mátyás tér... Real proportions, real colours, real details, at real coordinates.
* It looks like a polished modern game, not a prototype: no flat boxes where detail belongs, no
  visible texture repetition, no z-fighting, nothing floating or sunk into the ground, correct
  scale (1 unit = 1 metre), believable PBR materials (colour + roughness + normal detail), good
  light at every hour (morning, noon, golden hour, blue hour, night).
* Detail goes where the eye is: street level, 0–6 m above the pavement, within ~60 m.
* Never at the cost of smoothness: it must stay fluid in a browser (see the budgets).

## Reference material (read the ones for your area!)

Researchers wrote detailed descriptions (dimensions, colours as hex, layouts, sign texts) to
`/tmp/claude-0/-home-user/7f11b543-7b0c-5cc5-91a5-20847955add3/scratchpad/ref/`:

| file | contents |
|---|---|
| `keleti-baross.md` | Keleti pályaudvar, Baross tér, Rákóczi út |
| `blaha.md` | Blaha Lujza tér after the 2021–23 renovation, Corvin Áruház, Népszínház utca start |
| `museum-palotanegyed.md` | Nemzeti Múzeum, Múzeumkert, Palotanegyed palaces, Múzeum körút |
| `squares-churches-cemetery.md` | Erkel Színház, Rákóczi téri csarnok, churches, Kerepesi temető, Ludovika, Corvin mozi, **the typical Józsefváros tenement house** |
| `bkk-vehicles.md` | the trams/buses on 23, 24, 28A, 99; catenary; stops and shelters |
| `m2-metro.md` | Blaha and Keleti M2 stations, Alstom Metropolis trains, announcements |
| `street-furniture-traffic.md` | lamps, signs, kerbs, paving, bollards, bins, parked cars, taxis, police |
| `people.md` | clothing, body proportions, skin tones, activities, uniforms |
| `render-tech.md` | three.js r170 addons, post-processing, crowd animation, budgets, assets |

The real map is in `data/district8.json` (OpenStreetMap, baked by `.github/workflows/bake-data.yml`)
and the exact BKK line shapes/stops in `data/bkk-lines.json`. Named OSM buildings include
"Magyar Nemzeti Múzeum", "Keleti pályaudvar", "Erkel Színház", "Corvin mozi", "Rákóczi téri
Vásárcsarnok", "Ludovika", "Magyar Rádió" and many palaces; inspect the JSON with Node.

## Technology and limits

* three.js **r170**: `game/vendor/three.module.min.js`. Addons (MIT) are vendored in
  `game/vendor/addons/` with imports already rewritten: import them by relative path, e.g.
  `import { EffectComposer } from '../vendor/addons/postprocessing/EffectComposer.js'`.
* Plain ES modules, no build step, no runtime npm dependencies, no network assets at runtime except
  the existing OSM/BKK APIs. Everything is procedural or a committed file. From this machine only
  the npm registry is reachable (`npm pack <pkg>`): you may vendor CC0/MIT/OFL assets from npm
  (fonts, HDRIs, textures, sounds) into `game/assets/<kind>/` with their licence file; keep the
  repository growth for your area under ~8 MB and say what you added.
* Served by GitHub Pages. Target: a MacBook (Apple Silicon) in Chrome/Safari at 60 fps on
  `quality=high` at ~1440×900; `medium` for an average laptop; `low` for phones (`?quality=low`).
* **Frame budget on `high` for the whole street scene: ≤ 500 draw calls (shadow pass included),
  ≤ 3 M triangles, ≤ 150 MB of textures.** Your area brief gives your share. Use instancing,
  merged chunks, atlases, shared materials, LODs. The city has ~3 700 buildings, 7 000 road
  segments, 1 900 trees, 6 000 street props.
* City build time: keep your part under ~1 s on a laptop (this machine is ~5× slower; the shot
  tool prints the load time). Generate textures once and share them; never one canvas per object.
* No console errors or warnings. Code in update loops must never throw.
* Coordinates: metres, +x east, +y up, +z south, origin lat 47.4925 / lon 19.08. `toXZ(lat, lon)`
  and `toLatLon(x, z)` are in `game/geo.js`. Vehicle/crowd yaw: forward = (sin yaw, cos yaw),
  i.e. `yaw = atan2(dx, dz)`; a mesh whose front is +z gets `rotation.y = yaw`. Camera yaw:
  forward = (−sin yaw, −cos yaw).

## Architecture (who owns what)

| area | owns |
|---|---|
| render | `game/render/*`, `game/sky.js` |
| buildings | `game/city/buildings.js`, `game/city/shopsigns.js`, new `game/city/facades*.js`, `game/meshing.js` (keep existing exports working) |
| streets | `game/city/ground.js`, `game/city/props.js`, new `game/city/surfaces.js`, `game/city/furniture/*` |
| landmarks-a / landmarks-b | `game/city/landmarks/<id>.js` (one file per landmark) + one import line each in `game/city/landmarks/registry.js` |
| traffic | `game/traffic/*` (`signals.js` is shared: don't change its exports' meaning) |
| people | `game/npcView.js`, `game/people/*`, the look part of `game/crowd.js` (`makeLook`, `SKIN_TONES`), visuals in `game/vendors.js` |
| metro | `game/metro.js`, `game/metro/*` |
| vehicles | `game/transit/view.js`, `game/transit/infra.js`, vehicle specs in `game/transit/schedule.js` |
| audio | `game/audio/*`, `game/assets/audio/*` |
| ui | `index.html` (markup and CSS), `game/ui/*`, `game/minimap.js`, `game/assets/fonts/*` |
| integrator (not you) | `game/main.js`, `game/city/index.js`, `game/city/common.js`, `game/config.js`, tests' shared files |

`game/textures.js` is legacy shared code: don't change existing functions (others still call them);
put new texture generators in your own files.

### How the pieces connect

* `game/main.js` boots, then every frame (street mode) calls, in order: `sky.update`, `world.setNight`,
  crowd/transit simulation, `vehicleView.update`, `player.update`, `crowdView.update(px, pz, frame)`,
  `world.update(frame)`, `infra.update(frame)`, `entranceView.update(frame)`, `traffic.update(frame)`,
  `audio.update(frame)`, `pipeline.render(scene, camera, frame)`. In metro mode: `metro.update(...)`,
  `audio.update(frame)`, `pipeline.render(metro.scene, metro.camera, frame)`.
* **frame** (one shared object, see `main.js`): `dt` (real s, ≤ 0.1), `simDt`, `unix`, `hours`,
  `dayIndex`, `frameNo`, `mode` ('street'|'metro'), `sky` ({ sunEl, moonEl, night 0..1, day 0..1,
  golden 0..1, illumination }), `camera`, `player` (x, z, y, yaw, pitch, speed, running, onGround,
  riding), `world`, `vehicles` (transit vehicles near the player: { key, ref, line, x, z, yaw, s,
  dir, atStop, stopName, headsign, live }), `transit`, `crowd`, `ride`, `danger` (0..1), `metro`,
  `audio` (call `frame.audio.event(name, data)` for one-off sounds), `quality`.
* **City builders** (`game/city/index.js`) run in this order on one CityContext (`common.js`):
  `planLandmarks` (suppresses the OSM buildings a landmark replaces) → `buildLandmarks` →
  `buildGround` → `buildBuildings` → `buildShopSigns` → `buildProps`. The context gives you:
  `root` (add meshes here), `data` (CityData), `quality`, `night(material, max)` (emissive follows
  night), `onUpdate(fn(frame))`, `onNight(fn(k))`, `addSolidRing(ring)`, `addSolidBox(x, z, w, d,
  yaw)`, `addWall(ax, az, bx, bz)`, `addPost(x, z, r)` (player collision), `walls`/`streets`/`posts`
  spatial grids, `suppressed`, `lamps` (fill with { x, z, y, kind }), `placeOnWall`, `signMat`.
* The world object returned to main: `collide(x, z, r)`, `streetAt`, `lightAt`, `lampsNear(x, z, r)`
  → [[lamp, d²]], `setNight(k)`, `update(frame)`, `ctx`.
* Traffic lights: `game/traffic/signals.js` (`vehicleSignal`, `pedestrianSignal`) is the single source
  of truth for light colours, used by both the cars and the drawn signal heads.

### CityData (data/district8.json, game/osm.js `normalise`)

`buildings[]` { id, outer [[x,z]...], holes, h, minH, kind, name, colour, roof, cx, cz, and when
tagged: part (a building:part), hasParts (outline whose parts are drawn instead), roofShape,
roofH, roofDir, roofOrient, roofMat, material, levels, minLevel, tags { wikidata, historic,
amenity, start_date, architect, addr:street, addr:housenumber ... } } · `roads[]` { id, cls, name,
pts, width, oneway, foot, lanes, surface, sidewalk, footway, bridge, layer, service, maxspeed,
parking { left, right } } · `areas[]` { kind park|grass|cemetery|playground|pitch|parking|plaza|
water, outer, holes, name } · `rails[]` · `trees[]` [x,z] · `lamps[]` [x,z] · `props[]` { x, z, kind:
bench|bin|crossing|signals|bollard|bikerack|bikeshare|statue|adcolumn|billboard|cabinet|vending|
locker|drinking|fountain|postbox|phone|recycling|toilets|clock|playground, name?, crossing? } ·
`barriers[]` { kind wall|fence|retaining_wall|hedge|guard_rail, pts, h, material } · `pois[]`
(shops: vape, tobacco, kiosk, grocery, pharmacy, cafe, bar, food, ...) · `stops[]` · `entrances[]`
(M2/M4 entrances) · `routes[]` · `boundary`.

## Working rules

* You work in your own git worktree on your own branch. **Edit only the files your area owns.** If
  you truly need a change elsewhere (a new frame field, a hook in `main.js`), make the smallest
  possible edit and list it under "Integration notes" in your final report.
* Don't reformat or rename things other modules use. Keep public interfaces stable.
* Commit in small steps on your branch (do not push). Commit messages: an imperative summary line,
  a short body, and end with exactly these two lines:

      Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
      Claude-Session: https://claude.ai/code/session_01UKz9DQ4oiXT2MgGViUQfnY

  Never put model names anywhere else (code, comments, docs).
* `tests/web/run.sh` must pass. Add Node unit tests (no dependencies) for pure logic you write:
  `tests/web/<area>.test.mjs`, and add its name to the list in `tests/web/run.sh`.
* **Look at your work.** Screenshot tool (headless Chromium with software rendering, ~40–60 s per
  shot here):

      export PLAYWRIGHT_MODULE=/tmp/claude-0/-home-user/7f11b543-7b0c-5cc5-91a5-20847955add3/scratchpad/npm/node_modules/playwright/index.mjs
      node tests/web/shot.mjs tour <outDir>                        # the standard district tour (tests/web/tour.json)
      node tests/web/shot.mjs tests/web/views/<area>.json <outDir> --size 960x540

  A spec is a list of `{ name, time, at: [lat, lon], lookAt: [lat, lon, height?], yaw, pitch,
  height (eye height), metro: 0|1, wait }`. Put your area's viewpoints in
  `tests/web/views/<area>.json` (you own that file). Write screenshots to a directory under
  `/tmp/claude-0/-home-user/7f11b543-7b0c-5cc5-91a5-20847955add3/scratchpad/shots/<area>/`, not in
  the repo. Open PNGs with the Read tool, compare with the reference docs and iterate until it
  really looks right. The tool prints draw calls and triangles per shot: stay in budget.
  `?fallback=1` loads the small offline map (fast, for quick checks); the default is the real map.
  `window.__game` exposes `player, world, scene, camera, pipeline, sky, transit, crowd, traffic,
  audio, metro, frame, view(spec), setTime(iso), enterMetro(i), press(code)` for your own scripts.
* The machine has only 4 CPUs and other agents run browsers too: don't leave browsers or servers
  running, and keep screenshot batches small.
* Respect people: the population is diverse and must be depicted with dignity. Appearance must
  never influence who is dangerous (the danger system has no access to looks; keep it that way).

## Your final report

Return: what you built (files), how it looks (which screenshots you checked), measured draw
calls/triangles, what is still missing or weak, and integration notes (edits outside your files,
new frame fields, anything the integrator must do).
