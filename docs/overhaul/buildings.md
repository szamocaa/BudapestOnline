# Area: buildings – the Józsefváros tenements

Owns: `game/city/buildings.js`, `game/city/shopsigns.js`, new `game/city/facades*.js` (and helpers
you create), `game/meshing.js` (keep `MeshBuffer, appendWalls, appendRoof, appendRibbon,
appendPolygon` working for others). Reference: **`squares-churches-cemetery.md` (tenement house
section)**, `blaha.md`, `museum-palotanegyed.md`, `street-furniture-traffic.md` (signage).
Budget (high): ≤ 180 draw calls incl. shadow pass, ≤ 1.4 M triangles visible from a street.

90 % of what the player sees is ordinary buildings. Make them unmistakably Budapest:

1. **Heights and storeys**: 2 334 of 3 665 OSM buildings have no `levels`. Derive believable
   storey counts and heights (ground floor ~4.5–5 m, upper floors ~3.8–4.2 m in 1880–1910 blocks;
   inner Józsefváros mostly 4–5 storeys, outer parts lower, some 1–2 storey older houses, modern
   blocks around Corvin taller) from footprint size, position (distance from the Nagykörút /
   Kiskörút), the street class, `start_date`, kind (`apartments`, `office`, `church`...) and the
   neighbours, so the skyline looks right. Respect `h`/`levels` when OSM has them.
2. **Real 3D facades** at street level: recessed windows with frames and glass (reflective with the
   environment map), sills, lintels/pediments, shutters on some, string courses between floors, a
   strong main cornice, rusticated ground floor, big arched wooden gates (kapu), corner buildings
   with chamfers and occasional balconies/bays, attic/top storey variations. Several styles
   (eclectic/historicist, secession, plain 1950s–80s, modern glass) chosen per building from tags,
   age and location. Window rhythm aligned to each wall's length (no cut-off windows at corners).
3. **Ground floors**: shopfronts with signage (real OSM shop names via `shopsigns.js`), roller
   shutters (closed at night for many shops), cafés with lit interiors, gates, a few empty
   "kiadó" (to let) shops. Correct the NEMZETI DOHÁNYBOLT, gyógyszertár (pharmacy) and vape shop
   sign designs from the references; vape shops must glow at night.
4. **Materials and wear**: plaster colours from the reference palette (mostly ochre, cream, grey,
   faded pastel; many greyish/sooty), with weathering (dirt streaks under sills and cornices,
   soot at the top, patched plaster, exposed brick in places, graffiti tags at ground level),
   roughness/normal detail; renovated buildings clean and brighter.
5. **Firewalls** (tűzfal): walls standing above/beside lower neighbours are windowless exposed
   brick or grey plaster, sometimes with faded painted ads – very Budapest.
6. **Roofs**: pitched tiled or slate roofs (red-brown tiles, dark grey slate, tin), hipped towards
   streets, chimneys, dormers, flat roofs on modern blocks; support OSM `roofShape`
   (gabled/hipped/pyramidal/mansard/dome/onion/cone...), `roofH`, `roof` colour.
7. **Courtyards** (OSM holes): inner facades plainer, with the typical "gang" (open access
   balconies with iron railings).
8. **Building parts** (`b.part`): draw from `minH` to `h` with their roof shapes (needed by
   landmark areas too); skip outlines with `hasParts`. Skip `ctx.suppressed` ids.
9. **Windows at night**: lit rooms with varied warm/cool colours, curtains, occupancy changing with
   the hour (many lit at 20:00, few at 03:00). An interior-mapping shader (fake rooms behind the
   glass) is the premium solution if it fits the budget.
10. **Performance**: chunked merged geometry with LOD (full detail < ~250 m, simple textured boxes
   beyond), shared materials/atlases, shadows only from near chunks. Build time < 1 s on a laptop.

Views: the tour plus your own street-level shots in Népszínház utca, Szigony utca, Mátyás tér,
Bérkocsis utca, Krúdy Gyula utca, a courtyard, and an overview at 60 m; day and night.
