# Area: landmarks-b – squares, churches, theatre, market hall, cemetery

Owns: one module per landmark in `game/city/landmarks/` + its import line in `registry.js` (see the
format in `landmarks/index.js`). Reference: **`squares-churches-cemetery.md`**. Budget per landmark:
≤ 25 draw calls, ≤ 150 k triangles, build ≤ 150 ms (the cemetery may use instancing for graves).

Model these so they are instantly recognisable, using the exact OSM footprints (`site.buildings`)
and the reference dimensions, colours, materials and signage:

1. **Erkel Színház** (OSM "Erkel Színház") on II. János Pál pápa tér (the park itself is the
   streets area's; you may add the theatre's forecourt features).
2. **Rákóczi téri Vásárcsarnok** (OSM "Rákóczi téri Vásárcsarnok").
3. **Szent József templom** (Horváth Mihály tér) and **Magyarok Nagyasszonya templom** (Rezső tér):
   towers, roofs, facades, the clock, the cross.
4. **Fiumei úti sírkert / Kerepesi temető**: the main gate on Fiumei út, the boundary wall look,
   inside: the Kossuth, Batthyány and Deák mausoleums, the arcades, paths, grave rows (instanced
   headstones/crosses of several types), cemetery trees. It's a big area: keep it cheap at range.
5. **Ludovika** main building and wings (OSM "Ludovika", "Ludovika szárnyépület") + Orczy-kert
   entrance.
6. **Corvin mozi** (OSM "Corvin mozi") with its round shape and the Corvin köz memorial, and the
   recognisable bits of Corvin sétány / Corvin Plaza.
7. Any other strongly recognisable sight in the reference for VIII. you have time for (Teleki tér
   market, Mátyás tér...).

Use `ctx.addSolidRing(footprint)` for collisions and `ctx.night(material, max)` for lit windows,
floodlights and signs. Views: write `tests/web/views/landmarks-b.json` (2–3 per landmark, day and
night).
