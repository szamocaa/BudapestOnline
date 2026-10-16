# Area: streets – ground, street furniture, lamps, trees

Owns: `game/city/ground.js`, `game/city/props.js`, new `game/city/surfaces.js`,
`game/city/furniture/*`. Reference: **`street-furniture-traffic.md`**, `blaha.md` (the square's
paving and features), `squares-churches-cemetery.md` (parks, squares). Budget (high): ≤ 110 draw
calls incl. shadows, ≤ 0.8 M triangles.

1. **Street cross-section**: asphalt carriageways with Hungarian road markings (centre/lane lines,
   stop lines, bus lanes with "BUSZ" on Rákóczi út, give-way triangles), zebra crossings where OSM
   has `crossing` nodes / `footway=crossing` ways, raised granite kerbs (~12–15 cm) with real
   height, pavements of concrete pavers/asphalt with colour variation, tree pits with grates, drains
   and manhole covers, sett (`surface=sett`) and paving-stone streets as tagged, parking bays.
   Tidy junctions (no overlapping ribbons, no z-fighting: use a strict height/polygonOffset scheme).
   Note: tram tracks/catenary belong to the vehicles area – leave a clean surface for them.
2. **Squares and parks**: Blaha's renovated square paving pattern, II. János Pál pápa tér park,
   Mátyás tér, Teleki tér, Rákóczi tér, Múzeumkert: grass with variation, paths, hedges, flower
   beds, playgrounds (`playground` props/areas), low fences.
3. **Walls and fences** from `data.barriers` (the long Kerepesi cemetery wall on Fiumei út!).
4. **Street furniture** from `data.props` (thousands: instanced, a few draw calls per type): benches
   (Budapest models), FKF bins, bollards, bike racks, MOL Bubi docks with bikes, parcel lockers,
   vending/parking machines, drinking fountains, advertising columns with posters, street cabinets,
   statues/memorials (generic pedestal + figure; named ones get a name plate), and **traffic
   signals** (Hungarian heads on poles, pedestrian lights; colours from
   `game/traffic/signals.js` so cars and lights agree). Traffic signs (one-way, priority, parking,
   zebra signs) where it makes sense.
5. **Street name plates** on building corners (the Budapest design from the reference, with the
   district number "VIII." and the real names from the road data) – a big realism win.
6. **Street lamps**: the right Budapest lamp type per street (Nagykörút / Rákóczi út candelabra,
   side-street brackets or catenary-hung lamps over the street centre, park lamps), the right light
   colour (sodium orange vs LED white per street), light pools on the ground at night, glow halos;
   keep `ctx.lamps` ({ x, z, y, kind }) filled and the "real point lights near the player" logic.
7. **Trees**: species shapes typical of the district (plane, hackberry, pagoda tree, lime), October
   foliage starting to turn, alpha-tested leaf cards or clustered geometry, bark, instanced, with a
   cheap far LOD; fallen leaves near trees.
8. Small life: pigeons on squares (simple animated instanced birds that fly off when you run), some
   litter and leaves.
9. Solid things collide (`ctx.addPost` / `ctx.addSolidBox`): poles, bins, kiosks, statues.

Views: the tour plus your own shots at a zebra crossing on József körút, a side street with
parked-car bays, Blaha square, Mátyás tér, Rákóczi tér, a signalised junction at night.
