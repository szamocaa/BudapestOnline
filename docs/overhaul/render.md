# Area: render – the image itself

Owns: `game/render/*`, `game/sky.js`. Reference: `render-tech.md` (and the colour/light notes in
every other doc). Budget: post-processing must be cheap (few full-screen passes), shadows ≤ 2
shadow-map renders per frame on high.

Goal: the "expensive" look comes mostly from you: light, atmosphere, tone, depth.

1. **Post-processing pipeline** in `render/pipeline.js` (keep its interface: `createPipeline(canvas,
   { quality })` → `{ renderer, render(scene, camera, frame), resize, info }`):
   * high: MSAA render target (WebGL2 samples 4) or SMAA → GTAO (or SAO) tuned for a street scene
     in metres (contact shadows under cars/people/kerbs, not dirty halos) → UnrealBloom tuned so
     only emissive things bloom (lamps, signs, lit windows, headlights, the sun) → a colour-grade
     pass (subtle filmic contrast, warm highlights/cool shadows, slight saturation control,
     vignette, very fine grain) → OutputPass (tone mapping: compare AgX / ACES / Neutral and pick
     the one that looks best for plaster facades and night lights).
   * medium: bloom + grade + cheap AA, no AO. low: plain render, no post.
   * The metro scene goes through the same pipeline (no sky; bloom on lights).
   * `info()` keeps returning draw calls/triangles of the main scene pass.
2. **Sky**: physically based sky driven by the real sun (`astro.js` already gives sun/moon
   positions): use `addons/objects/Sky.js` (Preetham) or an improved custom shader. Add soft
   procedural clouds that drift (a few cloud types; seed by date so every day differs), a
   proper sun disc and glow, the moon with its phase, stars at night dimmed by Budapest's light
   pollution, and an orange-grey city glow at the horizon at night.
3. **Environment lighting**: `scene.environment` from a PMREM of the sky (regenerate when the sun
   moved > ~1° or every few in-game minutes; never every frame) so glass, cars, wet asphalt and
   metals reflect the sky. Scale it down at night. Hemisphere/ambient tuned per time of day.
4. **Shadows**: sharp, stable, long at golden hour. Either CSM (`addons/csm/CSM.js`) or a single
   shadow camera fitted to the view frustum near the player with texel snapping (no shimmering
   when walking). Soft PCF. Night: no sun shadows.
5. **Atmosphere**: distance haze/aerial perspective coloured by the sky (distant buildings turn
   bluish-grey by day, dark blue-orange at night); never a flat grey wall.
6. **Exposure**: smooth eye adaptation between bright day and night streets; night must stay
   readable (Budapest is never pitch dark) but moody.
7. **Quality**: `CONFIG.quality` ('low'|'medium'|'high'); add automatic detection of a sensible
   default (check `renderer.getContext()` + `WEBGL_debug_renderer_info`, screen size, mobile) when
   the URL doesn't force one, and a runtime governor: if fps < 45 for 5 s, lower the pixel ratio,
   then drop AO. Expose `pipeline.setQuality(q)` for the settings menu (the UI area will call it).
8. Expose small helpers others may use later (document them at the top of the file): e.g.
   `pipeline.registerBloom(material)` is NOT needed if bloom is threshold-based – prefer
   threshold-based so other modules don't depend on you.

Views to check: the whole tour (`tests/web/tour.json`) at 10:30, 16:30, 18:40 (golden/blue hour),
22:30 and in the metro. Compare before/after screenshots.
