# Area: traffic – parked and moving cars

Owns: `game/traffic/*` (keep `signals.js` exports and semantics; you may add functions). Reference:
**`street-furniture-traffic.md`**. Budget (high): ≤ 30 draw calls incl. shadows (instancing per
car model), ≤ 0.5 M triangles, simulation ≤ 1 ms per frame.

Budapest streets are packed with cars – without them the city looks empty and fake.

1. **Car models**: 6–8 procedural but properly shaped models (small hatchback, compact, sedan,
   estate, SUV, van, plus yellow Budapest taxi and a Hungarian police car), with glass (reflective,
   uses `scene.environment`), wheels with rims, lights (head/tail/brake/indicators emissive at
   night), number plates in the current Hungarian format. Realistic colour mix (lots of grey,
   silver, white, black, dark blue; few bright). One InstancedMesh per model and part, colours per
   instance.
2. **Parked cars** along kerbs: OSM `parking` tags where present, otherwise both sides of
   residential/unclassified/living streets (a few gaps), never on primary roads without tags, at
   crossings, near junction corners, at bus/tram stops or over tram tracks. Some half up on the
   pavement where the reference says it's common. They are solid for the player
   (`world.ctx.addSolidBox`).
3. **Moving traffic** on the road network (right-hand traffic, lanes, one-ways, speeds by road
   class), following each other, stopping at red lights (`signals.js` `vehicleSignal`) and at
   zebra crossings when a person/the player is on them, yielding to trams (transit vehicles in
   `frame.vehicles`), braking for the player. Density by time of day (rush hours busy, 3 am
   sparse). Taxis around Keleti. Smooth steering through curves, no popping (spawn/despawn out of
   sight, beyond ~250 m).
4. Expose for others: `traffic.carsNear(x, z, r)` → [{ x, z, yaw, speed, kind }] (audio uses it), and
   `traffic.count`.
5. Headlights at night: emissive + a cheap light cone/flare (no real lights per car).
6. If a moving car hits the player at speed: the car brakes; the player is pushed aside (no
   gore). Keep it fair.

Unit-test the lane/route logic in Node (`tests/web/traffic.test.mjs`). Views: your
`tests/web/views/traffic.json` (a residential street with parked cars, József körút with flowing
traffic, a signalised junction, Rákóczi út at night with headlights).
