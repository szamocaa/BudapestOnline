# Budapest Sim

A real-time Budapest simulator for Unreal Engine 5, starting with **VIII. district (Józsefváros)**:

- the district's buildings, extruded from OpenStreetMap footprints (courtyards included)
- live trams, metro and buses from BKK's open data (simulated vehicles until you add an API key)
- pedestrians who walk the real street network, in numbers that follow the time of day
- a real 24-hour sky: sun, moon and twilight at Budapest's true position, in Budapest local time (daylight saving included)

The project is C++ only (no binary assets), so everything here is plain text.

## Status: what is verified and what is not

| Part | Status |
|---|---|
| GTFS-realtime decoder (`Transit/GtfsRtDecoder`) | **Tested** against the official protobuf library's output, with sanitizers and 20k corruption fuzz runs |
| Sun, moon, Budapest clock (`World/Astro`) | **Tested** against PyEphem and Python's tz database: sun within 0.011°, moon within 0.3° elevation, every DST switch second correct |
| Baked-data reader and building mesher (`City/*`) | **Tested**: closed solids, outward-facing triangles in every ring orientation (breaking the winding on purpose makes the tests fail) |
| OSM baker (`Tools/Districts/bake_district.py`) | **Tested on hand-made data in Overpass's format.** Not yet run against the live OpenStreetMap servers: they were unreachable from where this was written |
| All Unreal C++ (actors, subsystem, settings, game mode) | **Written but never compiled.** It needs a first build in your editor; expect a few small compile errors to fix |
| BKK feed URL and key placement | **Unverified.** The default URL is from memory; check it with `Tools/check_bkk_feed.sh` and BKK's docs |

Run everything that does not need the engine with `Tools/run_tests.sh`.

## Quick start

1. **Engine:** Unreal Engine 5.3 or newer (written for 5.8). The `.uproject` says 5.8; if you have another version, right-click `BudapestSim.uproject` → *Switch Unreal Engine version*.
2. **Build the district data** (needs internet, once):
   ```bash
   pip install -r Tools/Districts/requirements.txt
   python3 Tools/Districts/bake_district.py all
   ```
   This writes `Content/Data/district8_buildings.bsb` and `district8_paths.bsb`. Without them the game still runs, but with an empty city and no pedestrians.
3. **Generate project files and build:** right-click `BudapestSim.uproject` → *Generate project files*, open the solution/workspace, build `BudapestSimEditor`, then open the project. (Or double-click the `.uproject` and let the editor compile.)
4. **Play:** open any level (an empty one is fine) and press Play. The game mode builds the whole simulation by itself.

### Controls

| Key | Action |
|---|---|
| W A S D + mouse | fly |
| Q / E | down / up |
| G | toggle street level (eye height) and bird's-eye view |
| `,` / `.` | slower / faster clock (×1, ×10, ×60, ×600, ×3600) |
| T | back to real time |

Console: `SetTimeOfDay 22.5` jumps to 22:30, `SetTimeScale 60` runs one game minute per real second.

## Live transit data (BKK)

1. Register at <https://opendata.bkk.hu> and request an API key.
2. Provide it either way:
   - environment variable `BKK_API_KEY` (a Mac editor started from Finder will not see shell variables), or
   - *Project Settings → Game → Budapest Transit → Api Key* (saved under `Saved/Config`, which git ignores, so the key never lands in the repo).
3. Check it works before launching the editor: `BKK_API_KEY=... Tools/check_bkk_feed.sh`. It downloads one snapshot, decodes it with the game's decoder and lists some vehicles.

If BKK's documentation shows a different URL, or wants the key in a header, change *Vehicle Positions Url Template* (use `{key}` where the key goes) and *Api Key Header Name*.

Until a key is set, a simulated feed of 36 vehicles circles the district so you can see the pipeline working. The on-screen status line says `SIMULATED` or `LIVE`.

Vehicles outside the VIII. district are skipped (toggle `bRestrictToDistrictVIII` on the Transit Manager). Their type is not known yet, so live vehicles are coloured per route; see the roadmap.

## Buildings: why OpenStreetMap and not Google Maps

Recreating buildings by extracting geometry from Google Maps is not allowed by Google's terms, and there is no API that returns building geometry. OpenStreetMap's open data has footprints, heights and levels for most of the district, is free to use with attribution, and lets us build real 3D geometry. If you later want Google's photorealistic look, the permitted route is to *stream* their 3D tiles with the Cesium for Unreal plugin, which you can add alongside this.

What the baker does with the district:

- downloads every `building=*` way and multipolygon in the district boundary (courtyards become holes)
- uses `height`, else `building:levels × 3.2 m`, else a typical height for the building type, else 16 m (so many buildings are estimated: Józsefváros is mostly 4–6 storeys)
- triangulates roofs, builds a walkable street graph from `highway=*` ways
- limitations of this first version: flat roofs only (no gables or domes), `building:part` outlines are ignored

## Realistic pedestrians

Out of the box pedestrians are simple placeholder figures, because realistic people are art assets that have to be imported in the editor. To get lifelike ones:

1. Get human characters: [MetaHuman](https://www.unrealengine.com/metahuman) (free with Unreal, build them in MetaHuman Creator and export them to the project), or Fab / Mixamo characters.
2. In the editor, create a Blueprint whose parent class is **NpcCharacter**. Set its *Mesh* to the character's skeletal mesh and its *Anim Class* to an animation Blueprint made for that character's skeleton (MetaHumans and Epic's mannequins come with one; other characters need theirs retargeted). The animation Blueprint should drive walking from the character's velocity, which is how the Third Person template's does it.
3. If your character walks sideways, change *Mesh Yaw Offset* on the Blueprint (default −90, right for Epic's mannequin).
4. Make several (different people, ages, clothes) and add them under *Project Settings → Game → Budapest World → Pedestrian Classes*.

The system handles the rest: where they walk, how many are out, spawning near the camera only.

MetaHuman note: a MetaHuman is a body plus a separate face mesh and hair. Start by using the body mesh alone, which already looks like a person from street distance; the head and hair take extra setup in the Blueprint.

## The day cycle

`ADayCycleActor` computes the sun and moon's real position for Budapest at the simulated time, and drives a directional light for each, plus sky atmosphere, a real-time-captured sky light, fog and exposure. At speed ×1 the game clock *is* Budapest's clock; use `,` `.` to speed it up.

Not done yet: stars, clouds and weather, lit windows and street lights at night. Night brightness and the sun/moon intensities (`SunIntensity`, `MoonMaxIntensity` on the actor) will need tuning by eye in the editor.

Pedestrian numbers follow an hour-by-hour curve (`ANpcManager::DensityForHour`): near empty at 3 am, peaks around 8 and 17, a lunch bump. It is a plausible rhythm, not measured data.

## Project layout

```
Source/BudapestSim/
  Transit/   BKK feed (HTTP polling, protobuf decoder), vehicles, mock feed, lat/lon projection
  City/      baked-data reader, building mesher, district actor, pedestrian street graph
  Npc/       pedestrian character and crowd manager
  World/     astronomy, day-cycle actor, settings
  Game/      game mode (builds everything) and the flying pawn
Tools/
  Districts/ OSM download + bake (Python) and its tests/fixtures
  DecoderTest, CoreTests/   engine-free tests;  run_tests.sh runs them all
  check_bkk_feed.sh         test your BKK key and URL outside Unreal
```

World coordinates: +X = north, +Y = east, +Z = up, in centimetres, origin at the district centre. Compass bearings therefore equal actor yaw.

## Roadmap

1. Compile and fix first-build errors; run the baker on real data and look at the district.
2. Static GTFS import (`routes.txt` route types) so vehicles are correctly trams, metro or buses, with line colours and proper models. Metro belongs underground.
3. Real vehicle and building models and materials instead of boxes (windows, balconies, roof shapes).
4. Street furniture, lit windows and street lights at night, stars, weather.
5. A walking first-person mode, then driving/riding trams.
6. Grow beyond the VIII. district.

## Data and licences

- Buildings and streets: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL. Keep this attribution in anything you show or publish. If you publish the baked `.bsb` files, publish them under the ODbL too.
- Transit data: BKK open data. Follow the terms you accept when you request your key.
