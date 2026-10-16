# Area: landmarks-a – Keleti, Blaha, Rákóczi út, the Museum quarter

Owns: one module per landmark in `game/city/landmarks/` + its import line in `registry.js` (see the
format in `landmarks/index.js`). Reference: **`keleti-baross.md`, `blaha.md`,
`museum-palotanegyed.md`**. Budget per landmark: ≤ 25 draw calls, ≤ 150 k triangles, build ≤ 150 ms.

Model these so they are instantly recognisable from the street, using the exact OSM footprints
(`site.buildings`, matched by name/wikidata/address or by polygon containment) and the reference
dimensions, colours, materials and signage:

1. **Keleti pályaudvar** (OSM "Keleti pályaudvar"): the main facade on Baross tér with the great
   arched glazed gable, the flanking pavilions/towers, statues (Watt, Stephenson), the clock,
   cornices, the iron-and-glass train shed behind, side arcades; at night lit. Plus **Baross tér**
   features: the Baross Gábor statue, the M4 glass skylights/entrance structures, paving (the
   M2 entrance details belong to the metro area – coordinate by leaving their spots clear).
2. **Blaha Lujza tér**: the **Corvin Áruház** in its current renovated look, the corner buildings
   of the square, the square's own structures from the 2021–23 redesign (canopies, water
   features, planters, kiosks) – paving is the streets area's; coordinate by not drawing ground.
3. **Rákóczi út** notable buildings on the VIII. side, e.g. the Uránia Nemzeti Filmszínház, Szent
   Rókus Kórház – whatever the reference marks as recognisable.
4. **Magyar Nemzeti Múzeum** + **Múzeumkert**: the portico with 8 Corinthian columns, pediment
   with sculpture, the grand stairs, wings and window axes, colours; the garden's statues and the
   fence/gates.
5. **Palotanegyed**: Magyar Rádió, the Pollack Mihály tér palaces (Esterházy, Festetics, Károlyi),
   Szabó Ervin Library (Wenckheim palace) – detailed facades from the references.

A landmark module may export helper geometry builders others can reuse; keep each landmark in its
own file. Use `ctx.addSolidRing(footprint)` so the player can't walk through. Use emissive
materials registered with `ctx.night(...)` for night lighting.

Views: write `tests/web/views/landmarks-a.json` with 2–3 viewpoints per landmark (day + night)
and compare with the descriptions.
