# Area: audio – the sound of Józsefváros

Owns: `game/audio/*`, `game/assets/audio/*` (CC0 only, with a LICENSE/credits file; or synthesize
everything with WebAudio). Keep the interface in `audio/audio.js`: `new AudioSystem()`, `start()`
(called from the Start click), `update(frame)`, `event(name, data)`. Reference: the sound notes in
`bkk-vehicles.md` and `m2-metro.md`, `street-furniture-traffic.md`. Budget: ≤ 24 simultaneous
voices, < 0.5 ms per frame.

1. **Ambience** that changes with place and time: traffic hum (stronger near big roads: use
   `frame.world.streetAt` / road data, and `frame.traffic` cars if present), distant trams, crowd
   murmur scaled by people near the player (`frame.crowd`), birds and pigeons in the morning,
   quieter nights with distant sirens, dogs, a passing scooter; inside the metro: hall
   reverb, escalator hum, tunnel rush.
2. **Player**: footsteps synced to speed (walk/run), different on asphalt/paving, jump/land.
3. **Vehicles** (spatialised with PannerNode/HRTF from `frame.vehicles`): tram rumble, wheel
   squeal in curves, the tram bell when departing, bus engine/door hiss/kneeling beep; inside a
   ride: the interior sound and the stop announcement "Következik: …" (Web Speech API
   `speechSynthesis` with a hu-HU voice when available; silently skip otherwise).
4. **Metro**: door chime and "Kérjük, vigyázzanak, az ajtók záródnak!", "A következő állomás: …"
   (speech), train arrival/departure.
5. **Events** from `audio.event(name, data)`: 'board', 'alight', 'metro-enter', 'surface',
   'encounter', 'shop', plus any the metro sends ('metro-doors', 'metro-announce'...).
6. A master volume and mute: `audio.setVolume(0..1)`, `audio.muted`; key N toggles mute (add the
   key handling inside your module with a window keydown listener). Never throw if WebAudio or
   speech is unavailable.

Synthesized sounds can sound cheap: design them carefully (filtered noise beds, layered
oscillators with envelopes, convolution reverb from a generated impulse) or vendor good CC0
samples. Test what you can in Node (scheduling logic) and verify in Chromium that no errors occur.
