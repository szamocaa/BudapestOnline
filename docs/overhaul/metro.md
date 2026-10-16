# Area: metro – the M2 between Blaha and Keleti

Owns: `game/metro.js`, `game/metro/*` (including `entrances.js`). Reference: **`m2-metro.md`**,
`keleti-baross.md`, `blaha.md`. Budget: metro scene ≤ 250 draw calls, ≤ 1.2 M triangles.

The player said the metro must "look better". Make it the showcase:

1. **Stations**: rebuild Blaha Lujza tér and Keleti pályaudvar M2 stations exactly as the reference
   describes (station type and layout, platform side/island, length, wall cladding and colours
   after the renovation, floor, ceiling, light fixtures and colour temperature, station-name signs
   in the BKV/BKK style, wayfinding, M2 red, benches, bins, clocks, next-train displays with
   live countdown, ads, platform edge markings). Keleti also signs the M4 interchange.
2. **The way down**: entering from the street plays the descent: the stairs/underpass level
   (vestibule, kiosks), then the long escalators (ride them in first person with the lamps passing,
   skippable with E), then the platform. Same in reverse when surfacing. Keep it short (≈ 10–20 s
   of real time) and skippable.
3. **Trains**: Alstom Metropolis AM5-M2 exactly as described (exterior livery, front, lights,
   doors per car, number of cars; interior with seats, grab rails, displays, lighting). Doors
   open/close with the real chime and the announcement ("Kérjük, vigyázzanak, az ajtók
   záródnak!" / "A következő állomás: …") – trigger them via `frame.audio`-style events: since
   the metro update gets `ctx`, add an `events` array on the Metro instance (e.g.
   `this.events.push({ name: 'metro-doors' })`) and list it in your integration notes; the
   integrator forwards them to `audio.event`.
4. **The ride**: a lit tunnel with cables, lamps, segments and the right length; the train
   accelerates/brakes realistically; look out of the windows; arrival at the other station.
5. **Street entrances** (`metro/entrances.js`): realistic stair entrances at the real OSM entrance
   points (railings, canopy or glass box as the reference says, the red M sign column/cube, the
   underpass at Blaha and Baross tér). Solid parts collide (`world.ctx.addSolidBox`).
6. Keep main.js's interface: `Metro` with `scene`, `camera`, `enter(station, ctx)`,
   `update(dt, input, player, ctx)` → `{ action: 'surface', station }` when leaving, `prompt`,
   `message`; waiting passengers via `CrowdView`.

Views: `tests/web/views/metro.json` (use `"metro": 0` / `1` shots; add test hooks you need to put
the camera on the escalator / in the train – document them).
