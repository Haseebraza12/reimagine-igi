# Collision and surface materials

How `igi.exe` collides characters, bullets and sight rays with models and
terrain, and which surface material each hit reports (footsteps, impacts,
penetration, ricochet). Labels:

- **observed**: measured over the data files (file and method named);
- **recovered**: read from `igi.exe` code (address named; Ghidra 12 on the
  analysed build, SHA-256 `2b1673…74c2`);
- **inferred**: an interpretation the traced code does not prove.

`python tools/igi_collision.py` decodes and validates all 601 model files,
prints every table below and runs 51 self-checks (instruction bytes and
constants in `igi.exe`, data invariants). `--hull` measures the hull offset,
`--png DIR` writes previews. Browser module:
`web-port/src/loaders/collision-mesh.ts`, tested by
`web-port/tests/collision-mesh.test.ts` (15 tests).

Units: 4096 = 1 m, z up, model space unless stated.

## 1. Model collision chunks (`.mef`)

Every `_1` model (246 distinct, plus `waypoint`, `mapcomputer`) has the
collision chunks and no LOD `_2+` model has them (all 601 files, two
archives; the 9 names stored in both archives differ only in header bytes
and have identical collision). [observed]

Chunk order: `HSMC`, then two sets of `XTVC ECFC TAMC HPSC`.

| Chunk | Layout | Evidence |
|---|---|---|
| HSMC | 2 × 32 bytes `{u32 faces, vertices, surfaces, spheres, 4 × u32 0}`. The loader (0x53025b) stores the pointers of ECFC/XTVC/TAMC/HPSC at +0x10/+0x14/+0x18/+0x1c, so set k is the 32-byte block at `model+0x2c + 32k`. | recovered; all counts match the chunk sizes (observed) |
| XTVC | 16 bytes: f32 x, y, z, u32 bone. The bone is non-zero only on bone models (type 1, values 0–48), whose positions are bone-local. | observed; bone use recovered in FUN_004cdcb0 (docs/characters.md) |
| ECFC | 8 bytes: u16 a, b, c, u16 surface (TAMC index). Same vertex order as the render triangles (38,726 of 38,726 matched faces). Outward normal = (c − a) × (b − a). | observed; normal formula recovered (FUN_004b7a60) |
| TAMC | 12 bytes: f32 transparency, i16 portal, i16 texture slot, u16 game material, u16 garbage (uninitialised in 363 of 1,377 records). | see below |
| HPSC | 24 bytes: f32 centre x, y, z, f32 radius, u16 first face, u16 face count, u16 first child, u16 next sibling. | recovered (FUN_004b7a60 walks it) and observed |

**TAMC fields.**

- **Game material** (+8): the `SetActiveMaterial` index of
  `material/material.qvm` (0–23 used), or 0xffff = none. Rays report 0xffff
  as material **1 (Ground)** (`world+0xd40`, 0x4b8eea); the sight test treats
  it as opaque (0x4ba728). [recovered]
- **Texture slot** (+6): the faces are exactly the render triangles of that
  model texture slot (1,028 of 1,032 slots identical, 2 differ by one face in
  206_01_1, 2 slots are render-only). So the material is assigned per
  texture. [observed]
- **Portal** (+4): ≥ 0 marks the polygon of that portal (ids match the
  model's `TROP` records and their `XVTP` vertices, e.g. 400_02_1 portals 0, 3,
  4). Every traced query skips these faces (0x4b84c0, 0x4ba07e) unless query
  word 6 is set, which no traced caller does. [recovered]
- **Transparency** (+0): 0 on textured faces, 1 on collision-only faces and on
  every set-1 surface, 0.2/0.35/0.5 on four glow/flame textures. No reader in
  the ray, sight or movement code. [observed values; meaning (lightmap-baker
  transparency) inferred]

| TAMC kind (set 0 unless noted) | records |
|---|---|
| texture slot + material | 993 |
| texture slot, no material | 38 |
| collision-only (slot −1, no material, transparency 1) | 129 (+2 with transparency 0) |
| portal polygon | 84 |
| set 1: HumanCollision (21), transparency 1 | 121 (+1 without material) |

**HPSC** is a binary bounding-sphere tree in first-child / next-sibling form:
node 0 is the root (no sibling), inner nodes have face count 0 and exactly
two children, every leaf owns one face, there are 2n − 1 nodes for n faces,
and every sphere contains its faces' vertices (worst excess 0.007 units).
Validated on every set. [observed] The bone models' spheres are built over
the bone-local positions.

**Topology** [observed]: set 0 is closed on 112 models, open on 32,
non-manifold on 101; set 1 is closed on 74, open on 42, non-manifold on 6.
The engine only casts rays, so it does not need closed meshes.

## 2. The two sets

| Set | Content | Read by | Evidence |
|---|---|---|---|
| **0** | the visible triangles (per texture material) + collision-only faces (untagged) + portal polygons | bullets (FUN_00479e30 → FUN_004c24c0, which always passes set 0: 0x4c2734); the sight test (method 8, FUN_004b9810, always set 0: 0x4b9867); the footstep material re-cast | recovered |
| **1** | a simplified hull, material 21 "HumanCollision", about **0.2 m outside** the walls and not raised vertically | the character wall sweep (FUN_004606b0) and ground probe (FUN_00460fd0); both call FUN_004c3d40 / FUN_004c2060 with set 1 (`push 1` at 0x46097d, 0x461368); FUN_004c3d40 stores it as query word 5 (0x4c3f91/0x4c3fb7); the handlers index `model+0x2c + 32 × word 5` (0x4b7ac0–0x4b7ac6) | recovered |

Hull offset [observed, `--hull`]: a ray from the centre of each
near-vertical set-1 face along its normal reaches the set-0 surface after
800–850 units in most cases (mode 825 units ≈ 0.2 m; 2,687 faces; median
914 units because simplified hulls also bridge recesses). Top and bottom
faces lie at offset 0.

Set 1 is empty on 124 of 246 models: characters (bone models), glass panes,
weapons, gun parts and small props. Those never block characters. All 34
glass panes attached to buildings are covered by their host's set-1 hull
within ±1 m of the pane (observed), so windows still stop the player while
bullets and sight pass the glass.

Level 1: 890 placed model instances (tasks with a Model plus their ATTA
sub-models): 888 have a set 0, 655 a set 1. [observed]

## 3. Query machinery

All recovered.

- **Dispatch.** Objects live in six object octrees on the world object
  (`DAT_00577b78+0x20`). Ray queries visit lists 0, 1, 4 and 5. For each
  object whose bounding sphere overlaps the query box and whose class mask
  matches, the query calls a per-task-type method from the table at
  0xa3c820 (`[method × 0x180 + type]`, registered by FUN_00401440, inherited
  by FUN_00401940).
- **Methods.**
  - 9: list of rays (non-vertical).
  - 10: vertical rays.
  - 8: sight / transmission.
  - 0xb: may veto a terrain hit at a point. Only DiscardTerrain implements
    it; level 1 has none. FUN_00526660 is an empty stub.
- **Handlers.**
  - RigidDynCubeObj registers FUN_004b7a60 (9 and 10) and FUN_004b9810 (8).
  - The base chain makes Building, Door, Fence, EditRigidObj, MagicObj,
    Glass, PhysicsObj, Vehicle (Car/Train/Heli) and Sector/SectorObject
    inherit them. The parents were resolved from the FUN_00401940 calls:
    - FUN_004baae0 → RigidDynCubeObj;
    - FUN_004d0590 → MagicObj;
    - FUN_004d5bd0 → SectorObject;
    - FUN_004d7560 → SectorInteriorObject;
    - FUN_004f2200 → PhysicsObj.
  - SectorObject runs the inherited method, then its interior children.
  - SplineObjSegment (railway) has its own handler, FUN_004d8380. It
    deforms the same HSMC set along the spline and uses the same material
    rule.
  - Humans (FUN_0045e190 / FUN_0045e490) do a sphere pre-test, then use the
    BoneDynCubeObj handlers (FUN_004cdcb0 / FUN_004cef60). Those pose the
    bone-local set with the skeleton.
- **Per-object pose.** Rays are moved into the object's current frame:
  position +0x20 (double), rotation +0x70…+0x90, scale +0x98…+0xa0. So
  doors, trains and cars collide at their animated pose.
- **Which model.** The model used is entry `obj+0xa4` of the object's model
  list. The constructor sets it to 0 (0x4bb99a), which is the `_1` model,
  the only LOD with collision.
- **Ray–face test** (FUN_004b7a60):
  - Walk the sphere tree. The root is not tested; a child is entered when
    the infinite line passes within its radius and its box overlaps the
    segment box (± 0.1 units).
  - Plane hit with t ∈ [0, 1], then barycentric coordinates on the
    dominant plane.
  - **No texture or alpha test**: FUN_0051d680 is `xor eax,eax; ret`.
- **Side.** A hit is *front* when the ray runs against the outward normal.
  The result stores the material in word 0x13 for front hits and in 0x14
  for back hits.
- **Hit ordering.**
  - A hit more than 0.1 unit closer always wins.
  - Within 0.1 unit, a front-face hit beats a back-face hit.
  - Terrain hits replace only strictly closer hits.

  Port: `hitReplaces`, `raycastCollisionSet`.

## 4. Characters

### Wall sweep (FUN_004606b0)

All recovered; constants verified by the tool.

- **Shape: three rays with zero radius.** There is no sphere, capsule or
  cylinder. The body width comes from the set-1 hull offset (≈ 0.2 m,
  section 2).
- **Probe heights** above the feet (position − root height, FUN_00488760):
  - standing: 409.6 / 1638.4 / 7372.8 units (0.1 / 0.4 / 1.8 m);
  - crouched (human+0x33d set): 409.6 / 819.2 / 5324.8 (0.1 / 0.2 / 1.3 m).
- **Rays.**
  - Each ray starts at the old position and runs along the move, length =
    move + **10.24 units** (2.5 mm, f64 at 0x531978).
  - Query: all objects + terrain, collision set 1, filter method 0x537430
    (section 6).
- **Wall test.**
  - A hit is a wall when |normal z| < 0.1 (0x5313c8). Its normal is
    flattened to the xy plane.
  - The nearest wall hit wins.
  - While grounded only the 0.4 m and 1.8 m probes count; the 0.1 m probe
    is left to the step / ground snap.
- **Slide.** When the move goes into the wall (move · n < 0):
  - the end point is projected onto the wall plane through the hit point
    (FUN_004a8f50) and pushed out by 10.24 units along n;
  - the status gets bit 8 and the sweep repeats;
  - after more than 10 passes the move is cancelled.
- **Airborne cases.**
  - The 0.1 m probe hitting a surface with normal z > 0.9999 lifts the body
    onto it.
  - The 1.8 m probe hitting a non-wall surface caps the head under it.

### Ground probe (FUN_00460fd0)

Recovered.

- **Rays.** Two rays against set 1 and terrain:
  - down 1000 m (dz = −4,096,000);
  - up 2 m (8192 units) for the roof flag.
  - Both start 0.4 m above the feet (0.2 m crouched).
- **Second pass.** If nothing is below, one more ray goes 1000 m up.
- **Grounded** when the ground is within 0.5 m (2048 units); this is also
  the step height (docs/gameplay.md).
- **Footstep material (re-cast).** When the ground hit is an object, a
  second vertical ray is cast against **set 0 of that object only** (method
  10). It runs from the hit point + 204.8 units down 2048 units (0x531988,
  0x531460). Its front material replaces the ground material.
- **Storage.** The ground record is copied to human+0x6a0. Its material
  word, human+0x6ec, is what the footstep (FUN_00462560, 0x4625b7) and
  landing (FUN_0040bce0, FUN_0040bf50, AI 0x453388) code read.
- **So** footsteps use the visible surface's material (Wood, Concrete,
  Gravel, …), never HumanCollision.

- **Soldiers with a graph do not probe** [recovered 0x46125a–0x46146f].
  The rays above are the branch for a human without a HumanAI (`human+0x800`
  = 0: the player). A HumanAI is set once at creation (`FUN_0045f8e0`, its
  only caller `FUN_0044deb0`) and never cleared, so for every soldier with
  a graph (HumanAI `+0x3b64`) the feet height comes from the graph, dead or
  alive, with no gravity and the on-ground flag always set:
  - no queued waypoint (`FUN_004a5e10` counts the path list `+0xe0`): the
    current node's world height (`FUN_004f02f0` / `FUN_004f0340`: node +
    graph position, through the parent's matrix for an attached graph),
    or the feet height unchanged when the node is not valid;
  - walking: when the first waypoint is more than 100 units (0x531990)
    from the stored next one (`+0x820`), previous (`+0x808`) = next and next
    = that waypoint (both start at the feet the first time);
    r = |next − feet| / |next − previous| (3-D, `FUN_004a9410` /
    `FUN_004a9590`) clamped to [0, 1]; z = (1 − r)(next.z − previous.z) +
    previous.z; exactly at next, next.z.
  - The object position is that height + bone 0's z in object space
    (`FUN_00488760`): the pose's root height. A seated soldier
    (level 1: Anya at her desk, clip 4 of skeleton 6) therefore sits at the
    node's floor height whatever furniture is under the placed point.
  Port: `HumanAi.graphFeetZ` (engine/ai/human-ai.ts), applied after the
  sweep in combat/enemy.ts. In level 1 every soldier's graph height is
  within 5 mm of the collision ground.

Humans are filtered out of the sweep, so characters do not collide with one
another through it (section 6).

## 5. Bullets

Recovered: FUN_00479e30 → FUN_004c24c0.

- **Ray.** Each bullet segment is one ray against set 0 of every object
  plus the terrain.
- **Front-face hits** (word 0x13 set, 0x14 empty) make the impact:
  - sound: material+0x154 + 32 × rand(6), the impact names (args 14–19);
  - decal / effect: material+0x254 / +0x258;
  - penetration: compares material+0x40 (hardness, arg 1) with the weapon's
    penetration power;
  - ricochet: uses material+0x44 (angle, arg 2).

  The rules themselves are in docs/gameplay.md.
- **Back-face hits** (leaving a solid) are queued with effect B
  (+0x25c/+0x260) and no impact.
- **Untagged faces** report Ground.
- **Terrain** reports Ground (section 7).

## 6. Who is tested

Each query passes a filter method; a type whose filter writes 0 is
skipped. Filters (recovered, registrations found by scanning every
FUN_00401440 call):

| Query | Skipped types (handler 0x4fa7f0 / 0x4159a0 = always skip) | Other filters |
|---|---|---|
| Character sweep (0x537430) | Human, HumanView, HumanAttach, Computer, GenericPickup, GunPickup, AmmoPickup, Grenade, Gun, FireBall, Wire | — |
| Ground probe (0x537435) | HumanView, HumanAttach, Computer, pickups, Grenade, Gun, FireBall | Human, Building: skip only self (0x4159b0) |
| Bullets (0x53742f) | HumanView, Computer, FireBall, gun parts (Gun, Gunx2, GunClip, GunCasing, GunFlame, GunMovingPart, GunCABarrel, GunCAClip) | Human: FUN_0045d100 (shooter's team, hit-probability roll); M203: ignore list; Missile: 0x4275a0 |
| AI sight (0x53f120) | Glass, DeathZone, FireBall | Human, Car, Heli, SCamera, …: 0x441c30; others not traced |

Types whose ray method 9 is cleared, so bullets and sweeps never hit them:

- DeathZone (0x4648bb). Its models also have an empty set 1 and no material
  (605_08_1).
- HitZone, SCameraLensViewCone, HeightMap, TextureModifier,
  TerrainLightMap, DiscardTerrain, Origo, EditorRigidObj, EditorMagicObj,
  SoundDefTriggerOnce.

[recovered]

Glass panes (`TASKTYPE_GLASS`) are ordinary rigid geometry for rays:

- material 14, hardness 0, so any weapon with penetration ≥ 1 passes;
- ricochet 15°;
- hole_plexi1 decals.

They have no set 1, and AI sight skips them.

## 7. Line of sight

Recovered: FUN_00487f40 → FUN_004c4630 → method 8.

- **Transmission.** The sight ray starts with transmission 1.0 (set 0, all
  objects through the filter, then terrain). For every face hit, in
  FUN_004b9810 / FUN_004cef60:
  - mark the ray blocked;
  - if the material is 0xffff → transmission 0, stop;
  - on a front-face hit, transmission ×= material+0x00 (DefineQMaterial
    argument 0, "see-through");
  - if see-through is 0 → transmission 0, stop.

  A terrain hit sets 0.
- **Verdict.** The target is visible when the ray is not blocked, **or the
  transmission is ≥ 0.79** (0x532218; fcomp at 0x487f91).
- **See-through values:**

  | Material | See-through |
  |---|---|
  | Air, Glass, HumanCollision, MetalLadder, MetalFence | 1 |
  | Fence | 0.8 |
  | everything else | 0 |

- **So** soldiers see through glass and through **one** fence (0.8) but not
  two (0.64).
- **Correction.** docs/ai.md and docs/gameplay.md read 0.79 as "first hit at
  ≥ 0.79 of the way". The code shows it is this transmission product.

## 8. Terrain

- **Rays and sweeps** (FUN_004c2a30 → FUN_004c3520): test the level-16
  terrain triangles.
  - The side flag picks the material: front hit → world table entry 1
    (**Ground**), back → none.
  - The triangle test adds the HeightMap relief
    `(bilinear(grid) − 64) × 256` when the global 0xb47d98 names an active
    HeightMap. This answers terrain.md open question 4: the collision walk
    applies the relief.

  [recovered]
- **Ground probe** (FUN_004c2060 → column query FUN_004c1270 with lookup
  flag 1): the material comes from FUN_004c1a30. [recovered]
  1. Collect the TextureModifiers whose node contains the point (method 13,
     FUN_004fcd70; only modifiers with a mask).
  2. Walk them from the last pushed (innermost) down. The tie order inside
     one node is inferred to match the renderer's.
  3. For each, sample its terrain.bit mask **bilinearly**:
     `fx = (x − x0) × scale`, ix = trunc(fx), 2 × 2 bits.
  4. The first whose value is ≥ **0.3** (0x5316a4) gives the terrain
     material; else terrain material 0.
  5. Return byte 0 of that terrain material's record =
     `CreateTerrainMaterial` **argument 1** (handler 0x4bc890 stores it at
     0xbced20 + id × 900).
- **Level 1.** All six terrain materials have argument 1 = 1, so **every
  terrain point is Ground** (footsteps walk_ground_*, 1 m noise; landing
  land_ground_1; impacts bul_dirt_1/2, which are undefined and silent per
  docs/audio.md; decal hole_concrete1 0.03; impact model 1009_01_1). On a
  4 m grid over the modifier boxes the terrain-material split is 0:
  529,857, 1: 51,905, 4: 3,289, 5: 4,773 samples; all map to Ground.
  [observed]
- **FPU mode.** The game runs the FPU in **chop** mode, so FISTP
  truncates. FUN_004966d0 ORs 0xC00 into the control word. WinMain calls it
  at 0x48db81 and again each message-loop pass (0x48dbe9), and aborts with
  "Invalid FPU rounding mode…" unless FISTP(−1.75) = −1 (0x48dbc1).
  [recovered]

## 9. Materials (`material/material.qvm`)

- **Layout** [recovered]:
  - Each `SetActiveMaterial(i)` selects record i at 0x565380 + i × 0x268.
    The world table at `world+0xd3c` holds those 32 pointers
    (FUN_004084a0).
  - `DefineQMaterial` (FUN_00407f40) fills +0x00 see-through, +0x0c arg 1,
    +0x08 arg 2, +0x14…+0x1c colour/255.
  - `DefineGameMaterial` (FUN_00408060) fills, from +0x20:
    - name;
    - +0x40 hardness, +0x44 ricochet angle;
    - +0x48 arg 3, +0x4c arg 4 (no reader traced for either);
    - +0x50 footstep range (m);
    - +0x54 walk[6], +0x114 land, +0x134 rain, +0x154 impact[6];
    - +0x214/+0x234 args 20–21;
    - effects A/B at +0x254/+0x25c.
- **Level-1 columns** ("L1") are set-0 faces / area of all 890 placed
  instances. "floor" counts upward faces (n_z > 0.7). [observed]

| # | Name | See-through | Hardness | Ricochet ° | Footstep m | Walk / land | Impact sounds | Decal (size m), model | L1 faces | L1 m² | L1 floor m² |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | Air | 1 | 0 | 0 | 0 | Walk0 / land_ground_1 | Hit0 | — (0.03), 1009_01_1 | 90 | 0.4 | 0 |
| 1 | Ground | 0 | 10 | 5 | 1 | walk_ground / land_ground_1 | bul_dirt_1/2 | hole_concrete1 (0.03), 1009_01_1 | terrain + untagged | — | — |
| 2 | Water | 0 | 0 | 0 | 1 | Walk0 / land_ground_1 | Hit0 | — | 0 | | |
| 3 | Wood | 0 | 1 | 10 | 1 | walk_wood / land_ground_5 | bul_wood_1–6 | bullethole_wood (0.03), 1011_01_1 | 8,467 | 10,556 | 1,884 |
| 4 | Carton | 0 | 1 | 10 | 1 | walk_ground / land_ground_1 | bul_carton | hole_concrete1, 1009 | 696 | 613 | 22 |
| 5 | StrongMetal | 0 | 10 | 30 | 1 | walk_metal / land_ground_2 | bul_metal_hrd | bullethole_metal + dent_metal, 1013_01_1 | 264 | 20 | 5 |
| 6 | NormalMetal | 0 | 5 | 30 | 1 | walk_metal / land_ground_2 | bul_metal_nrm | bullethole_metal, 1013 | 10,579 | 7,192 | 2,077 |
| 7 | SoftMetal | 0 | 3 | 30 | 1 | walk_metal / land_ground_2 | bul_metal_sft | bullethole_metal, 1013 | 11,258 | 17,501 | 5,148 |
| 8 | Flesh | 0 | 1 | 0 | 0 | Walk0 / land_ground_1 | bul_flesh | hole_concrete1, 1009 | 13,480 | 68 | 2 |
| 9 | BloodyFlesh | 0 | 1 | 0 | 0 | Walk0 | bul_flesh_2 | hole_concrete1, 1009 | 6,732 | 25 | 1 |
| 10 | Textiles | 0 | 0 | 5 | 0 | walk_ground | bul_textile_1 | hole_concrete1, 1009 | 3,352 | 334 | 208 |
| 11 | Concrete | 0 | 5 | 25 | 1 | walk_ground / land_ground_3 | bul_concrete_1/2 | bullethole_concrete + dent_concrete (0.05), 1012_01_1 | 1,895 | 11,718 | 4,114 |
| 12 | Runway | 0 | 10 | 25 | 1 | walk_ground | bul_asphalt | hole_concrete1 + dent_concrete, 1009 | 476 | 972 | 971 |
| 13 | Rug | 0 | 0 | 5 | 1 | walk_ground | bul_rug | hole_concrete1 | 0 | | |
| 14 | Glass | 1 | 0 | 15 | 1 | walk_ground | bul_glass_1–4 | hole_plexi1 (0.08), 1009 | 2,774 | 383 | 6 |
| 15 | Plastic | 0 | 1 | 15 | 1 | walk_ground | bul_plastic_1 | hole_concrete1 | 4,910 | 208 | 51 |
| 16 | Porcelain | 0 | 0 | 30 | 1 | walk_ground | bul_porc | hole_concrete1 | 218 | 126 | 62 |
| 17 | Rubber | 0 | 1 | 5 | 1 | walk_ground | bul_rubber_1 | hole_concrete1 | 494 | 29 | 2 |
| 18 | Fence | 0.8 | 0 | 30 | 1 | walk_metal / land_ground_2 | bul_metal_fnc | none | 3,206 | 30,182 | 36 |
| 19 | Gravel | 0 | 10 | 30 | **10** | walk_gravel / land_ground_4 | bul_gravel | hole_concrete1, 1009 | 44 | 740 | 740 |
| 20 | Snow | 0 | 0 | 0 | 1 | walk_snow | Hit0 | hole_concrete1 | 0 | | |
| 21 | HumanCollision | 1 | 0 | 0 | 1 | — | — | — | set 1 only: 14,894 faces, 101,845 m² | | |
| 22 | MetalLadder | 1 | 0 | 0 | 1 | — | — | — | 0 | | |
| 23 | MetalFence | 1 | 0 | 0 | 1 | — | — | — | 0 | | |

Level-1 set 0 also has:

- 5,256 untagged faces (20,021 m², 5,278 m² of floor), which rays report as
  Ground;
- 455 portal faces (364 m²), which are skipped.

[observed]

## 10. Port integration

**Implemented** (`web-port/src/engine/world/collision.ts`,
`world-builder.ts`, `character.ts`, `combat/bullet.ts`,
`player/player.ts`, `combat/enemy.ts`) as planned below; the remaining
gaps follow the plan.

1. **Build two worlds per instance from `readCollisionModel`** (same
   instance matrices as rendering; `_1` model only):
   - a *character* world from set 1;
   - a *bullet / sight* world from set 0, keeping per triangle the TAMC
     material (`rayMaterial` → −1 becomes 1), the side (store the original
     winding; front = ray · ((c−a)×(b−a)) < 0) and the see-through factor.

   Rules for both:
   - drop faces with `portal ≥ 0`;
   - skip instances whose task type is filtered (section 6), e.g. DeathZone
     everywhere and Wire for characters;
   - skip TRI_ALPHA: the original never alpha-tests.

   Doors, trains, cars and ConditionalContainer objects go through the
   dynamic bodies that `engine/world/collision.ts` now has:
   - `CollisionWorldBuilder.setTarget(id)` while adding that instance's
     triangles;
   - `CollisionWorld.setBodyTransform` / `setBodyEnabled` each tick;
   - ray hits on bodies report `triangle = -1 - bodyId`, so keep a per-body
     material array for them.

   The original tests those objects at their current pose (section 3).
2. **Character movement.** Replace the sphere push-out with
   `characterSweepRays` against the set-1 world:
   - wall = `flattenWallNormal(n)` non-null;
   - slide with `slideOnWall`; at most 10 iterations;
   - ignore the 0.1 m ray while grounded.
   - ground = vertical ray from 0.4 m (0.2 crouched) above the feet; snap
     within 0.5 m; roof ray 2 m up.

   With zero-radius rays the hull's ≈ 0.2 m offset is the body radius. Add
   no extra radius, or characters will stop 0.4 m from walls.
3. **Footsteps / landing.**
   - Object ground: re-cast 204.8 units down 2048 units against set 0 of
     the object that was hit, and take the front material.
   - Terrain ground: `TerrainMaterialLookup.gameMaterialAt(x, y)` (level 1
     always 1).

   Then:
   - WALK noise range = `SurfaceMaterial.footstepRangeM`;
   - sounds = `walk[]` / `land`;
   - not raised while crouched (human+0x33d is the crouch flag; this is the
     flag docs/audio.md calls "quiet walk").
4. **Bullets.** Nearest set-0 hit (`hitReplaces` ordering), then impact
   sound / decal / penetration / ricochet from the front-face material
   (`readSurfaceMaterials`, or the existing `readMaterialSounds` /
   `readImpactMaterials` / `readGameMaterials`). Terrain hits are Ground.
   Humans use their posed bone-model set 0 (Flesh / BloodyFlesh /
   NormalMetal helmets).
5. **AI sight.** Collect all set-0 hits along the eye→target ray with their
   side, then `sightTransmission` + `aiSightPasses` (≥ 0.79); any terrain
   hit blocks. Skip Glass, DeathZone and FireBall instances. Add every
   human but the looker and the target (filter 0x441c30, alive or dead):
   the segment must pass its HSEM sphere (HSEM +120 around the pelvis,
   `FUN_0045e210`), then each crossed face of its posed set 0 counts
   (`FUN_004cef60`; level-1 human faces are all see-through 0). The combat
   node ray `FUN_00489b00` (filter 0x537430) skips every human. See
   [ai.md](ai.md) §2.2.

Port status [as built]:

- Per-triangle flags: TRI_SOLID (set 1 + terrain), TRI_BULLET (set 0 +
  terrain), TRI_SIGHT (set 0 without Glass / Wire + terrain), TRI_TERRAIN;
  per-triangle material and owner (placed instance), hits report side,
  material, terrain and owner; `raycastAll` for the sight product.
- Wires use their rigid collision matrix (docs/wire.md); spline segments
  carry their sets bent like the render geometry.
- Soldiers are hit through their bone model's own set 0, posed each tick
  with the bone matrices (`soldier-body.ts`), with its face materials and the
  same ordering; a body's exit face is implied after a hit.
- Platform motion (`FUN_0045f930`, section 13): `character.ts`
  `updatePlatform` / `moveHuman` carry a human standing on a dynamic body
  (only the bodies `options.carries` accepts: Train, Car, Elevator,
  StationaryGun tasks, `PLATFORM_TASK_TYPES`) by moving the start of the
  move, `moved` includes the displacement, `platformMove` / `platformYaw`
  are left for the caller (jump / fall air, heading); `attachHuman` /
  `detachHuman` give the rigid attach move of `FUN_00461930`.
- Sight rays of soldiers and cameras add the humans' posed bodies
  (`enemy.ts` `humanSightHits`, `BodyCollision.sightHits`).
- Gaps: back-face exit effects (effect B) are not drawn (the sight filter
  0x441c30, skip the ray's self and target, is decoded in ai.md §2.2); the
  player's own body is a capsule for AI bullets (its bone
  model is not posed in first person).

Units: the helpers work in IGI units, z up. The port's engine frame is
IGI (x, y, z) → (x, z, −y) / 4096 relative to the level origin
(docs/formats.md), so transform rays into IGI space or convert results.

## 11. Cross-checks with other documents

- **docs/ai.md §2.2, docs/gameplay.md "Vision",
  tools/igi_gameplay.py (0x487f91).** The 0.79 is a material transmission,
  not a distance fraction (section 7).
- **FPU chop mode (section 8)**: resolved. gameplay.md "FPU rounding mode"
  now documents it, and every port helper truncates. These include `fistp`,
  `x87Round`, `qvmRoundToInt`, `roundHalfEven` and the new `x87.ts`.
  - The gun code does use FISTP (0x477d8c), so 700 rpm gives 2 ticks.
- **docs/audio.md footsteps.** Flag +0x33d is the crouch flag: the sweep
  picks the crouched probe heights from it.
- **docs/terrain.md open question 4.** The ray test applies HeightMap relief
  (section 8).

## 12. Open questions

- **TAMC transparency (+0) and material args 3–4.** No reader was found in
  the traced runtime code. Lightmap baking is the likely user.
- **Query word 6** (test portal faces) is set by no traced caller. Sector /
  portal crossing code probably uses it.
- **TextureModifier order inside one octree node** is assumed to match the
  renderer's. It is irrelevant for level 1 (all terrain is Ground).
- **Human-vs-human separation.** The sweep skips humans; any separate push
  between characters was not traced.
- **DeathZone kill test.** DeathZone geometry is inert for rays; the kill
  test (method 0 tick) was not traced.
- **Sight filter 0x441c30** (Human, Car, Heli, SCamera) and the Missile
  bullet filter 0x4275a0 were not decoded.
- **Bone-model hits.** FUN_004cdcb0 posing details (and its use of the
  bone-local sphere tree) were only skimmed; docs/characters.md covers
  posing.
- **Water** (FUN_00512a70) reports material table entry 0; level 1 has no
  Water.

## 13. Moving platforms and the attach task [recovered]

Two fields carry a human on a moving object (debug labels printed by the
player tick `FUN_00410a30`: "Ground task", "Attach task", "Delta move pos
X/Y/Z", "Delta move Alpha/Beta/Gamma").

**Ground task** `human+0x768` (`FUN_00462280`, read by `FUN_004622c0`): the
object hit by the ground probe's down ray (`FUN_00460fd0`) when the human
ends the move grounded; cleared when it is not grounded, when the hit is
terrain, and by `FUN_00461f10` (jump, attach states).

**Per tick** (`FUN_0045f930`, the player tick's first call after
`FUN_00408530`): the deltas `+0x728` (displacement), `+0x734` (rotation),
`+0x75c / +0x760 / +0x764` (its Euler angles) are cleared; the object is
the attach task, else the ground task. Its method `0x537436`
(`FUN_00415790`) returns its position c (`obj+0x20`, now), the rotation
since the last tick R_d = R_now R_prevᵀ and the translation t:

- the method exists only for **Train** (`FUN_0042ac50`: t = pos −
  `+0x6c0`, R_prev at `+0x694`), **Car** (`FUN_0042eea0`: the physics step
  `+0x6dc` / `+0x708`), **Elevator** (`FUN_0043d450`) and **StationaryGun**
  (`FUN_00473750`) — registrations `FUN_0042a0d0`, `FUN_0042cf90`,
  `FUN_0043be30`, `FUN_004726f0`; Heli (`FUN_00430370`, parent Vehicle
  `FUN_004eb250`) and every other type (doors, buildings) have none, so
  they carry nothing;
- displacement `+0x728` = (c − p) − R_d (c − p) + t (p = the human's
  position); with a turning platform this differs from the exact rigid
  motion by (I − R_d) t;
- `+0x75c / +0x760 / +0x764` = `FUN_004a9f30`(R_d): γ = atan2(R_d10,
  R_d00) wrapped to [0, 2π) (0 when |(R_d00, R_d10)| ≤ 1e-4).

**Use of the deltas** (normal move):

- `FUN_004600f0`: start = position + `+0x728` (double add, 0x46048f); the
  move, sweep and ground probe follow from there; `+0x688` (last move) =
  move + `+0x728` (0x460625), which the death-state entries copy into the
  air velocity (player 0x40e6e4; soldiers 0x4532f3, 0x4554c3, 0x458253,
  0x45ac43).
- `FUN_0045fd00`: heading `+0x50c` += turn step + `+0x764`; the turn step
  is zeroed while the yaw is locked (`+0x510`), the platform turn is not.
  α and β (`+0x75c`, `+0x760`) are not applied.
- Jump entry `FUN_0040bb80` adds `+0x728` to the air velocity (0x40bc87)
  before `FUN_00461f10` clears it; the fall entry `FUN_0040bec0` sets the
  air velocity to the root delta + `+0x728` (0x40bee0–0x40bf13).

**Attach task** `human+0x76c` (`FUN_00461f50` sets it and stores the
human's position and orientation in the object's frame, `+0x770` and
`+0x788`; `FUN_00462190` clears it; the constructor zeroes it at 0x45db5a):

- set only by a StationaryGun use (player state 33, 0x40cbb9, cleared at
  0x40cc5a; AI at 0x45880a / 0x45889c and 0x45b3da) and by the ground
  probe for **AI soldiers only**: the branch at 0x461328 runs only when
  `human+0x800` (the HumanAI, set by `FUN_0045f8e0` from `FUN_0044deb0`) is
  non-null, and attaches to the AIGraph's parent object (graph `+0x14`)
  while the soldier's graph (HumanAI `+0x3b64`) has its attached flag
  (`+100`), detaching when the flag is 0. The player standing on a train
  is never attached. The stored offset comes from the human's `+0x20` as it
  is before that tick's move, which for a rider on its first tick is its
  placed "Position" (the pelvis-level point, E151), so a rider keeps exactly
  the height it was placed at inside its vehicle;
- while set, `FUN_00410a30` calls `FUN_00461930` instead of
  `FUN_004600f0`: local `+0x770` += R_objᵀ × the root motion (`+0x520`,
  float sums), position = obj + R_obj local — no sweep, ground probe,
  gravity, air velocity, knock-back or slope slide, and `+0x688` is not
  updated; `FUN_0045fd00` takes the whole body orientation from R_obj ×
  `+0x788` (α, β and the heading follow the object; no turn input).

Port: `web-port/src/engine/world/character.ts` (`updatePlatform`,
`moveHuman`, `platformDelta`, `attachHuman`, `detachHuman`,
`PLATFORM_TASK_TYPES`), tests in `tests/collision.test.ts` ("platform
rules"). The port's dynamic bodies are build-pose → current transforms, so
the exe's pivot formula needs the object's build-pose origin
(`options.pivotOf`); without it the exact rigid motion is used. The yaw is
returned in (−π, π] (the same angle).
