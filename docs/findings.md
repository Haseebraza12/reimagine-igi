# Findings from the supplied installation

Scope: the local `Game Files/` directory (one mission, `location0/level1`,
"Trainyard"). Labels as in [formats.md](formats.md).

## Inventory (observed)

| Finding | Evidence |
| --- | --- |
| 266 files, 77,754,361 bytes (74.15 MiB) | `research/inventory.json` |
| 53 ILFF/IRES archives, 8,786 named records, all parse | `research/resources.json` |
| 118 LOOP v8 scripts with recoverable symbol tables | `research/qvm-symbols.json` |
| Level 1: 417 models, 393 textures, 1,308 object lightmaps; location0: 184 models, 270 textures | archive listings |
| Native x86 PE32, image base `0x00400000`, entry `0x0049bff5`; imports DDRAW, DINPUT, DSOUND, WINMM | `research/native-triage.json` |

`igi.exe` SHA-256 `2b1673443e2635d97787344da5fab9d1ac6b717d34d18c5bab7f30749b1174c2`.

## Decoded and validated

| Area | Result | Where |
| --- | --- | --- |
| Scripts | 14 opcodes named; every mission-1 script parses into a call tree; 98/98 player and 49/49 AK47 constants recovered | [qvm.md](qvm.md) |
| Mission tasks | All 1,362 `Task_New` decode with schema widths that consume every argument | [formats.md](formats.md) |
| Models | All 601 models decode (render mesh, attachments, collision); vertex layout corrected vs the community reference | [formats.md](formats.md) |
| Model textures | `.mtp` INST layout recovered (community layout does not parse) | [formats.md](formats.md) |
| Coordinates | Right-handed, z up, 4096 units/m; gamma CCW (0 vs 23 walk-graph crossings); ATTA row vectors (0 vs 40 penetrations per desk) | [formats.md](formats.md) |
| Terrain | ctr/cmd octree + HeightMap relief: 267/268 lightmap tiles over ~57 km within 1 cm; base exact | [terrain.md](terrain.md) |
| Terrain look | Materials, tile maps, UVs, lightmaps and palette recovered from `igi.exe`; orientation/seam/alignment tests discriminate | [terrain.md](terrain.md) |
| Object lighting | `.olm` layout, file naming (building instance-list order) and the vertex-lit formula recovered from `igi.exe`; all 1,308 lightmap sizes match | [formats.md](formats.md) |
| Soldier AI data | View constants from the AI scripts (guard/patrol 40 m, sniper 100 m; one mission override); combat settings per AI type and difficulty (`settings.qvm`, GD_2 from `config.qvm`) | [formats.md](formats.md) |
| Mission flow | Objective M1_OBJ1 → `EditVariable_105` → `AreaActivate_200` beside the truck; messages from `StatusMessage` + areas | `web-port/src/loaders/level.ts` |
| Weapons | 24 `WeaponConfig` tasks (rates, clips, reloads, recoil, sounds) | [formats.md](formats.md) |
| Sounds | ILSF formats 0–3 (PCM and IMA ADPCM, streamed or in memory) all decode; the software 3D mixer and the event → sound table recovered | [audio.md](audio.md) |
| Script VM | 49 opcodes and the host-call convention; every shipped `.qvm` runs (1,222 runs, 0 aborted) | [qvm-vm.md](qvm-vm.md) |
| Characters | Skinned models, skeletons and `.iff` animations; posing; first-person arms; bone-local collision posed for hit tests | [characters.md](characters.md) |
| Rendering | Camera, fog, sky and clouds, render states, model LOD, decals, shadows, muzzle flash | [rendering.md](rendering.md) |
| HUD and menus | Fonts, sprites, radio messages, loading screen, menus, failed / complete flows | [hud.md](hud.md) |
| Movement and combat | Root motion, jump, falling, slopes, the three-ray sweep and ground probe; weapon rules, ricochet and penetration, zones and damage | [gameplay.md](gameplay.md), [collision.md](collision.md) |
| AI | Driver order, perception, hearing, route graphs, actions, combat and firing; the AI scripts run as shipped | [ai.md](ai.md) |
| Mission runtime | Tree update order, cut-scenes, doors, switches, alarms, cameras, complete / fail | [mission.md](mission.md) |
| Vehicles and wires | Rigid body, helicopter, truck, trains on the rail spline; wire placement | [vehicles.md](vehicles.md), [wire.md](wire.md) |
| FPU mode | The game runs the x87 in chop mode: conversions truncate, float32 stores round toward zero | [gameplay.md](gameplay.md) "FPU rounding mode" |

An earlier pipeline treated the first `terrain.hmp` grid as the level's
height field and the `.hmp` body as 16-bit. Both were wrong: the three grids
are 8-bit HeightMap detail stamps applied on top of the octree surface. That
pipeline and its loaders were removed.

`config.qvm` stores `GOInMouInv = 0` although both readable files say 1; the
discrepancy is preserved, not reconciled ([qvm.md](qvm.md)).

## Still unresolved

The HumanSoldier animation state graph (which clip each AI request plays),
the intro movies (Indeo 5), menu sub-screen widgets and the map computer,
platform motion, and any comparison against the running original. Each
document lists its own open questions. See [roadmap.md](roadmap.md).
