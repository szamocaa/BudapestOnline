# Area: people – the characters

Owns: `game/npcView.js`, new `game/people/*`, the look part of `game/crowd.js` (`makeLook`,
`SKIN_TONES` – change the sim only if truly needed and keep `tests/web/crowd.test.mjs` passing),
the visuals in `game/vendors.js`. Reference: **`people.md`**. Budget (high): ≤ 30 draw calls for
the whole crowd incl. shadows, ≤ 1.0 M triangles for ~900 drawn people.

The current people are box robots. Replace them with believable humans:

1. **Bodies**: smooth procedural humanoid meshes with correct anatomy and proportions from the
   reference (men, women, teenagers, children, elderly with a stoop or a walking stick; slim to
   heavy builds; heights with realistic spread). Faces readable at 5–10 m: eyes, brows, nose, lips
   (texture atlas or geometry + shading), hair styles as meshes (short, long, ponytail, bun,
   curly, bald, caps, hijab/headscarf, beanie), beards. Skin tones spanning the district's real
   range (keep the darker tones well represented, as the player asked: "feketébb tónusú magyar
   polgárok"), shaded with care (no grey/ashy look; subsurface-ish warm terminator).
2. **Clothes** for mid-October Budapest: coats, puffer jackets, hoodies, tracksuits, jeans, skirts
   with tights, scarves, sneakers/boots; mostly dark with accents (reference palette). Accessories:
   backpacks, handbags, shopping bags, phones (some walk looking at the phone or with it at the
   ear), prams, dogs on leads, suitcases near Keleti. Uniformed roles: police in pairs, BKK ticket
   inspectors, FKF street sweepers in orange.
3. **Animation on the GPU**: instanced rendering with a vertex-shader skeleton (per-vertex bone
   weights + per-instance phase/speed/state) – natural walk cycles with knee bend, heel strike, arm
   swing, hip sway, head bob; idle (weight shift, looking at phone, smoking), standing chats in
   small groups, sitting on benches where `data.props` has benches (if feasible), running/fleeing,
   knocked down/stunned (states from `crowd.js` STATE). Shadows from the animated pose.
4. **LOD**: detailed < ~35 m, simplified < ~120 m, very cheap beyond. Keep the CrowdView interface:
   `new CrowdView(scene, crowd, { max, radius })`, `update(px, pz, frame)` returns the drawn count
   (the M2 platform also uses it).
5. **Vendors**: real-looking vape stalls (folding table, umbrella/gazebo, glass display with
   colourful devices, price signs in Ft, LED strip at night) and their sellers.
6. Dignity: no caricatures; appearance must never be linked to danger (keep `danger.js` blind to
   looks).

Views: `tests/web/views/people.json` – close-ups (3 m, 8 m), a crowd at Blaha at 17:30, people at a
tram stop, night, the M2 platform. Compare against photos described in the reference.
