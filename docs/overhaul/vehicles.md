# Area: vehicles – trams, buses and their infrastructure

Owns: `game/transit/view.js`, `game/transit/infra.js`, the vehicle specs (`vehicle` field) in
`game/transit/schedule.js` `LINE_DEFAULTS`. Reference: **`bkk-vehicles.md`**,
`street-furniture-traffic.md`. Budget: ≤ 12 draw calls per vehicle (merge per section), infra ≤ 60
draw calls, ≤ 0.6 M triangles total.

1. **The real vehicle types** per line as the reference says (trams on 23, 24, 28A; the bus on 99):
   exact proportions, number of sections and articulations, door layout, windows, front and rear
   shape, liveries (BKV yellow shade, white/grey bands, logos as simple shapes), destination LED
   displays with the real line number and destination (`v.headsign`), side and rear displays,
   pantograph on trams touching the wire, bogies and wheels, mirrors, wipers, head/tail lights.
   Interior: seats (colours), handrails, floor, ceiling lights (lit at night), stop-request
   buttons, passenger info screens; when the player rides, the view from the window seat must look
   right. Doors open when `atStop` and close before leaving (animate).
2. **Tram infrastructure** (`infra.js`): grooved rails embedded in the street (asphalt or concrete
   strips) or ballast/grass track where the reference says; **overhead catenary** – poles at
   realistic spacing with cross-span wires, the contact wire(s) above each track following curves,
   rosettes on building walls in narrow streets; switches at junctions.
3. **Stops**: platform islands/kerbs, BKK shelters (design from the reference), stop poles/signs
   with line numbers, FUTÁR passenger displays showing the next departures
   (`frame.transit.departuresNear(x, z, unix, hours, dayIndex)` → { stopName, list: [{ ref,
   headsign, minutes }] }) at major stops, ticket machines where real. Bus 99 stops get their
   signs and shelters too (stop positions: the `lines` passed to `buildTransitInfra`).
4. Night: interiors and displays glow (register materials with `world.ctx.night`).

Views: `tests/web/views/vehicles.json`: a 28A in Népszínház utca, a 24 at II. János Pál pápa tér, a
99 bus at its stop, inside a tram (ride: board via `__game.press('KeyE')` next to a stopped vehicle,
see `tests/web/play.mjs`), catenary over a junction, night.
