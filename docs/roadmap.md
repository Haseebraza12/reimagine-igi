# Desktop browser implementation roadmap

Goal: one original-looking mission running locally in a desktop browser from
the player's own game files, then broader compatibility. The supplied
installation contains only `missions/location0/level1` ("Trainyard"): it is
the one-mission build (its DefineMission has no next mission,
MISSION_NEXT_MISSION_UNDEFINED, although missions.res names all 14).

**Other missions** — engine ready, untested: every loader takes the mission's
paths from its DefineMission (`levelPathsFor`, `audioPathsFor`; IgiLevel.paths),
`npm run stage` stages every mission folder of an installation and writes
`game-data/missions.json`, the menus list the staged missions, and the game
unloads one mission before loading another (checked by unloading and
reloading Trainyard: no leftover scene objects). Missions 2–14 need their
original files; none were available here.

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
- the credits text is compiled into igi.exe and is shown only if igi.exe is
  staged (not done; a decision for the owner);
- of the Graphics menu's performance flags (applied at every level load,
  `FUN_00405e50`, engine/world/performance.ts) the terrain threshold and the
  model LOD scale are applied; bits 1 / 2 (a device callback) and 4 / 8 (two
  capability switches) are not, because what they change was not identified;
- the menu music is played by the port, not by any code found in igi.exe
  ([audio.md](audio.md) "Menu music");

## 6. Optimise with measurements — partial

The automated checks run on a software renderer (SwiftShader). The terrain
is one draw call of ~3k triangles per frame (was ~430k). No frame rate has
been measured on real GPU hardware here. Profile before changing LOD,
culling or texture handling.

## Evidence discipline

Each subsystem keeps a source-bound finding, an implementation and a test.
Observed, recovered and inferred claims stay separate; unknowns stay unknown
until tested. Game files and anything derived from them stay local.
