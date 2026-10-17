# Desktop browser implementation roadmap

Goal: the game's missions, original-looking, running locally in a desktop
browser from the player's own game files. Two builds were available:
`Game Files/` is the one-mission build (only `missions/location0/level1`,
Trainyard; the tests read its staged copy, `web-port/game-data-demo`), and
`original/full-game/app` is the full game with all 14 missions and its own
IGI.exe (E163), staged into `web-port/game-data` for the browser.

**Missions 2–14** — done, with listed gaps: every loader takes the mission's
paths from its DefineMission (`levelPathsFor`, `audioPathsFor`), the full
game's file differences are read (ILFF fonts E164, the 34-argument
DefineGraph E165, terrain tolerance E166, the untagged AI graphs E168,
constant-expression QVM arguments E179), and the 22 task types missions
2–14 add over mission 1 are implemented from the full exe:
[objects.md](objects.md), [world.md](world.md), [combat.md](combat.md),
[vehicles.md](vehicles.md) "Full game". All 14 missions start from Free
Mode and run their intro and gameplay in the browser smoke test
(`?test&mission=N`).

Status legend: **done** (implemented from recovered rules and checked
against data), **partial**, **open**. Every recovered value is listed in
[evidence-ledger.md](evidence-ledger.md).

## 1. Asset decoding — done

The browser decodes the original files directly (`web-port/src/loaders/`):

- resource archives, v11 / v9 textures, rigid and skinned models with their
  attachments, model / texture tables, baked lightmaps (`.olm`);
- skeletons and `.iff` animations;
- the mission task tree and every `.qvm` script (declarative and
  executable, [qvm-vm.md](qvm-vm.md));
- weapon configuration, ammo types (`ammo/*/ammo.qvm`), ILSF sounds (PCM and
  IMA ADPCM), localized text, the HUD / menu / map-computer sprites and
  fonts, the terrain.

## 2. Static level and rendering — done

- Terrain: the exe's per-frame octree LOD walk (threshold 163, Chebyshev
  metric, no hysteresis), the vertex geomorph, HeightMap relief from level
  14, the coarse / fine material layers, per-pixel lightmaps, per-vertex fog
  ([terrain.md](terrain.md) §7).
- Every placed instance with its ATTA sub-models, model LODs from `lod.qvm`,
  DNER block flags, baked lightmaps or the original vertex lighting; deferred
  lightmapped blocks also take the vertex light ([rendering.md](rendering.md)).
- Sky dome, cloud layers, exponential fog, the 4:3 camera.
- Wires stretched between their end points ([wire.md](wire.md)).
- The railway embankment along the exe's spline, the trains, helicopters
  (rotor blur copies) and the truck on the recovered vehicle physics
  ([vehicles.md](vehicles.md)).
- Weapon / ammo pickups (gun body or ammo model, vertex-lit) and dropped
  guns ([interactions.md](interactions.md)).
- Cut-scene camera filters (LINE, BAND, HANDICAM), letterbox, subtitles, the
  exact camera shake ([mission.md](mission.md)).
- Bullet holes, impact dust and fragments, tracers, blood, shell casings,
  muzzle flashes ([rendering.md](rendering.md) §7).

Open: comparing fixed camera views with the running original (no reference
captures exist in this repository).

## 3. Player — done

- The exe's movement state graph (49 states: walk / run toggle,
  hold-to-crouch, jump at 0.4× clip speed, fall, landing, lean, map
  computer) on the recovered body animation ([gameplay.md](gameplay.md)
  "Player movement state graph").
- Three-ray sweep against the HumanCollision hulls and the terrain, ground
  probe with step-up and recovery, slopes, platform carry (trains, cars)
  ([collision.md](collision.md)).
- Mouse look per tick with the profile's invert flag; the third-person orbit
  camera while attached / using (mode 3) and when dead (mode 5), with the
  player's body drawn ([interactions.md](interactions.md) §10).
- Use / Activate: doors, switches, terminals (hacking), ladders, fences,
  wires; pickups ([interactions.md](interactions.md)).
- Footstep, landing and hit sounds; landing dip, hit and explosion shake.
- The exe's animation blend tree (linear 6-update fades, slerp, root motion
  and pelvis height mixed by the same weight) for the player, the soldiers
  and the arms ([characters.md](characters.md) "Blending").

## 4. Weapons and damage — done

- The weapon state machine (ready, fire, reload, switch, peek, knife, dry
  fire, holstered, map computer), rate of fire, bursts, the exe's pellet
  direction, recoil, ricochet and penetration ([weapons-view.md](weapons-view.md)).
- Per-zone damage on the posed bone-model collision of soldiers and of the
  player.
- Object damage: glass, explosive barrels, terminals, explode objects,
  security-camera lenses; the explosion itself (damage, knock-back, shake,
  fragments, fireballs, chain reactions) ([damage.md](damage.md)).

## 5. Soldiers and mission — done, with listed gaps

- Soldiers: the decoded HumanSoldier state graph, the original AI scripts on
  the reimplemented script VM, perception on the exe's phase ticks with other
  humans blocking sight, hearing (including ladder, fence and door noises),
  route graphs (opening doors on door legs), combat decisions, firing, vehicle
  riders attached to their train / helicopter / truck ([ai.md](ai.md),
  [characters.md](characters.md)).
- Tick order: the task tree's own node order — doors, areas, vehicles and
  cut-scenes before the player, each soldier at its node, LevelFlow last.
- Mission runtime: cut-scenes, doors, switches, alarms, security cameras,
  radio messages, objectives, mission complete / failed
  ([mission.md](mission.md)).
- HUD, map computer, menus and sub-screens, loading screen and sound
  ([hud.md](hud.md), [audio.md](audio.md)).

Gaps (documented in code and in the documents above):

- the intro movies (Indeo 5) are skipped: playing them needs a decoder
  decision (see README);
- the Credits screen shows the web port's own pages and the Read Me box the
  port's own text (E200), not the shipped credits table and ReadMe.txt;
- of the Graphics menu's performance flags (applied at every level load,
  `FUN_00405e50`, engine/world/performance.ts) the terrain threshold and the
  model LOD scale are applied; bits 1 / 2 (a device callback) and 4 / 8 (two
  capability switches) are not, because what they change was not identified;
- the menu music is played by the port, not by any code found in igi.exe
  ([audio.md](audio.md) "Menu music");
- missions 2–14: the open points listed at the end of objects.md, world.md,
  combat.md and vehicles.md "Full game" (the drawer's collision, rain cells in one sorted mesh, the M203 smoke
  particles, the female soldiers' door / switch use, among others);

## 6. Optimise with measurements — partial

The automated checks run on a software renderer (SwiftShader). The terrain
is one draw call of ~3k triangles per frame (was ~430k). No frame rate has
been measured on real GPU hardware here. Profile before changing LOD,
culling or texture handling.

## Evidence discipline

Each subsystem keeps a source-bound finding, an implementation and a test.
Observed, recovered and inferred claims stay separate; unknowns stay unknown
until tested. Game files and anything derived from them stay local.
