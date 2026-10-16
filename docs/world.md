# World tasks of the full game: DiscardTerrain, RotatingObject, AlarmLight (+ reflector), Siren, RainEffect, CubeModifier

Engineer "world". Spec: `scratchpad/specs/world.md`. Every address below is a
**full-exe** address (igi.exe SHA-256 `88cb85fa…`), checked again with
`re-full/decomp.sh` and the disassembly where noted. Evidence tags:
[observed] data, [recovered] code, [inferred] reasoning.

Suggested home: a new `docs/world.md` (or a "World task types" chapter of
`docs/mission.md`), plus the ledger rows at the end of this file.

## Files

- `src/loaders/objects/` (new): `rotating-object.ts`, `alarm-light.ts`,
  `siren.ts`, `rain-effect.ts` (RainEffect + CubeModifier), `index.ts`
  (re-exported from `src/loaders/index.ts`, which registers the behaviours).
- `src/engine/world/world-tasks.ts` (new): the engine side (poses, model
  swaps, reflector spin, glow quads, sounds, Rain objects).
- `src/engine/fx/rain.ts` (new): the Rain object (particle step, floor trace,
  vertex fill, cull, per-cell layers, three.js draw).
- Shared files, small blocks: `loaders/level.ts` (3 POSE_SPECS entries),
  `engine/level.ts` (MOVING_TASK_TYPES += RotatingObject, AlarmLight),
  `engine/world/world-builder.ts` (DESTRUCTIBLE_ROOT_TASKS += Siren,
  AlarmLight; new `setInstanceHidden(i, hidden)`: render only, collision
  kept; cleared by `resetInstanceModels`), `engine/combat/object-damage.ts`
  (Siren as ExplodeObject, AlarmLight and RotatingObject handlers, bridge
  `destroyAlarmLight` / `setRotatingObjectDestroyed`, same-name destroyed
  model not swapped), `engine/fx/alarm-lights.ts` (optional `facing` test),
  `engine/fx/effects.ts` (draws the glows with the SCamera lights),
  `engine/game.ts` (create / load / reset / tick / dispose of world-tasks).
- Tests: `tests/world-tasks.test.ts` (synthetic, 21), `tests/full-world.test.ts`
  (all 14 missions, 12).

## Census [observed]

Task types of the 14 missions that L1 lacks: AIStationaryGunHolder,
AlarmLight, BinocularOverlayHolder, Cabinet, CarAI, CubeModifier,
DiscardTerrain, Elevator, Generator, GenericPickup, GenericTBA, GuardGenerator,
GunM16A2, GunSPAS12, **HumanSoldierFemale (L14 ×5)**, HumanSoldierRPG,
MineField, PlaceExplosiveTBA, Plane, Radio, RainEffect, RotatingObject,
Siren, StationaryGun. The world/presentation ones are all covered here (or
by DiscardTerrain, already done). HumanSoldierFemale is a soldier type and is
assigned to nobody (open point for the lead). DiscardTerrainArea has 0
instances.

## DiscardTerrain

**Class** [recovered]: `FUN_0052c0c0`.

- `FUN_00401900("DiscardTerrain", 0x158, EditorRigidObj)`; the parent getter is `FUN_005034d0` → "EditorRigidObj".
- EditorRigidObj clears draw (4) and ray methods 9, 10 and 0xb (0x503400…). DiscardTerrain also clears 8, 9 and 10 again.

Handlers:

| Slot / method | Handler | Role |
|---|---|---|
| create | `FUN_0052c000` | |
| draw (4) | `FUN_004f1160` | returns an editor flag; draws nothing |
| method 0xf | `LAB_0052c0b0` | `DAT_00b12bb8 = 1` |
| transform (7) | `LAB_0052c510` | |
| destroy | `LAB_00426860` | |
| schema | `LAB_0052c500` | |
| compile | `FUN_0052c290` | |
| method 0xb | `FUN_0052bf00` | terrain-hit veto |
| world add | `FUN_0052c580` | |
| world remove | `FUN_0052c5a0` | |

No slot-1 update; it lives under Static anyway.

**Schema** [observed + recovered]:

| Name | Kind | Offset | Default |
|---|---|---|---|
| Position | ObjectPos | +0xf0 (3 × f64) | 0 |
| Level | Int32 | +0x150 | 10 |

Examples:

- L3 "SecurityBuilding": Position (23324586, −54824376, 174426304), Level 15.
- L12 "WinchHouse": (112288240, −41958300, 179555408), Level 14.
- Level values over all 63 instances: 15 × 54, 14 × 9 [observed].
- Names (where given) are building names: AmmoBuilding, PowerBuilding, Barracks, WinchHouse(Lift), EkksHQLift, EkksHeliPad, SecurityBuilding, generator, RadioBuilding.

**Create** (`FUN_0052c000`) [recovered]:

- Zeroes its fields and sets Level = 10.
- `FUN_004c5710(world, task, model("johan"))`. No model "johan" exists in the data, so it is invisible.
- `FUN_004c7140(world, task, &Position, 4096.0, category 4)`: inserted in object list category 4.

**Compile** (`FUN_0052c290`) [recovered]:

```
half = 0x40000000 >> Level;  side = 2·half          // L15: 65536 (16 m), L14: 32 m, L10: 512 m
o    = tree origin (world+0xde0/4/8, always 0, docs/terrain.md)
min  = ((int)trunc(Position + o) & −side) − o        // per axis; fistp chop then two's-complement mask = floor to multiple of side
max  = min + side;  centre (+0x138) = min + side/2
scale (+0x98..+0xa0) = side · 0.000116257 (0x534c58)
FUN_004c6e70(world, task, centre, min(+0x108), max(+0x120))   // octree placement by AABB
```

So the cube is exactly the level-L terrain octree node that contains Position. Example, L3 SecurityBuilding: min (23265280, −54853632, 174391296), max = min + 65536.

**Effect 1: terrain collision veto** (method 0xb `FUN_0052bf00`) [recovered]

- The vertical-ray query `FUN_004cb9f0` with flag 0x80000000 (terrain) ray-casts the terrain (`FUN_004cb050`).
- For a terrain hit closer than the current object hit, it asks the category-4 objects around the hit point: `FUN_004ce090(world, 0xb, &rec, point, 0x20000000, 4)`.
- DiscardTerrain clears the "keep" byte of every point with `min < p ≤ max` on all three axes (strict lower, inclusive upper: `(min<p) != (max<p)`). The terrain hit is then dropped.
- The same veto runs in the list-ray path at 0x4de414 (method-0xb dispatch over the hit list).
- docs/collision.md: "only DiscardTerrain implements 0xb".
- Net effect: players, AI, bullets and the rain trace (§4) pass through terrain inside the cube. This is how basements below grade work.
- Example: L3 AmmoBuilding uses two stacked level-15 cubes from 21.3 m below to 10.7 m above its floor z 174413136.

**Effect 2: terrain render discard** (method 0xf) [recovered mechanism, depth detail inferred]

- In the octree render traversal `FUN_004d14e0`, for each node the objects attached to it whose type implements 0xf (object flag 0x80 at +0x5c, node flag 0x80 at +0x38) get method 0xf.
- DiscardTerrain sets `DAT_00b12bb8 = 1`, and the traversal then zeroes that node's terrain child mask (`local_5d8 = 0` at 0x4d1c3d / 0x4d1de7). No terrain below that node is emitted.
- [inferred] The node is the one that holds the object, i.e. the level-L cube. Whether a coarser LOD cell that covers the cube (emitted while processing the parent) still draws terrain there is **unknown**. In practice the cube is inside a building.

**Player/AI interaction:** none directly; only the two effects above. Not drawn, never updated, no members.

## DiscardTerrainArea (editor generator; 0 instances)

**Class** `FUN_0052b6c0` [recovered]:

- `FUN_00401900("DiscardTerrainArea", 0x78, RigidDynCubeObj)`.

| Slot / method | Handler |
|---|---|
| create | `LAB_0052b7f0` |
| transform (7) | `LAB_0052be70` |
| destroy | `FUN_004d3710` (empty `ret`) |
| schema | `LAB_0052be60` |
| compile | `FUN_0052b840` |

No update and no draw override.

**Schema** [recovered kinds and offsets; no `Task_DeclareParameters` for it exists in any shipped QVM, so the names are unknown; the names below are inferred roles]:

| Field | Kind | Offset | Default |
|---|---|---|---|
| Position | ObjectPos | +0x20 | 0 |
| Level | Int32 | +0x68 | 12 |
| MaxLevel | Int32 | +0x6c | 16 |
| Generate | bool8 | +0x70 | 0 |

**Compile** [recovered]:

1. Snap to the Level node, as in DiscardTerrain (min +0x38, max +0x50).
2. If Generate is set: delete all children (`FUN_00401780`), call `FUN_0052b9f0(task, Level, side, centre)`, then clear Generate.

`FUN_0052b9f0` is a recursive generator. While `level ≤ MaxLevel`:

- If test `FUN_0052bcc0` = 1: create a child **DiscardTerrain** with Position = node centre and Level = level (`FUN_0052c610`, `FUN_004012a0(parent, DiscardTerrain)`, then compile).
- Otherwise recurse into the 8 octants (offsets 0.25 / 0.75 of the side).

Test `FUN_0052bcc0`:

- Cast a 1 m grid of vertical rays: (side/4096)² rays from the cube top, length = side, `FUN_004cb9f0(…, 0xff, 0, 0x80000000)`.
- Every ray must hit inside the cube, and a point query `FUN_004c9750(world, …, hit + 40.96 up, 1, 0xc, …)` at each hit must report non-zero.
- Otherwise the test returns 2.

This is an editor tool that produced the DiscardTerrain lists. The port can ignore it.


In the port: `web-port/src/loaders/terrain-octree.ts` `addDiscard` / `discarded`, applied by `loaders/level.ts`; tested by `tests/full-game.test.ts` (mission 3) [E167].

## RotatingObject [recovered: class FUN_00438df0, create FUN_00438c30, compile FUN_004395d0, update FUN_00439090, bullet LAB_00439750, sound host LAB_00439770]

- Create defaults: Degrees per second 10 (0x41200000), Acceleration 1,
  Destructable 1, "Rotate sound" "", Base +0x160 = identity, var block
  FUN_004e6ab0(1), destroyed +0x1a8 = 0.
- Compile: +0x160 := +0x70 (identity: the Orientation parameter is
  overwritten; data all 0), model + placement at Position, +0x70 := +0x160,
  target = current = Degrees per second, angles 0, sound instance replaced by
  FUN_004e6b00(task, "Rotate sound") (loops for the object's life, independent
  of On), On compiled.
- Update: targets := 0 when (On compiled and (char)fistp(On) == 0) or
  destroyed (never restored). Per axis `cur` approaches the target by
  `acc × f32(1/30)` (0x533678), clamped; angle += cur × f32(1/30) (f32
  stores, chop mode); `while angle >= 360` (0x533818) angle −= 360.
  +0x70 = Base × FUN_004b38e0(angles × f32(π/180) 0x53367c). **FUN_004b38e0 =
  FUN_004b3be0(γ) × FUN_004b3ba0(β) × FUN_004b3b60(α) = Rz(z) Ry(y) Rx(x)**
  (the order §9 left open; same as every Real32x9 orientation). Var 0 =
  curY/degY + curX/degX + curZ/degZ stored as f32 and clamped (`< 0 → 0`,
  `> 1 → 1`; a NaN passes both, L5/L8 have deg X = deg Y = 0).
- Bullet (LAB_00439750): Destructable → destroyed. No shipped dish is
  Destructable; not in the explosion damage list.
- Port: behaviour `loaders/objects/rotating-object.ts`; the dish is a dynamic
  task (MOVING_TASK_TYPES), placed by POSE_SPECS with identity rotation;
  world-tasks sets `setTaskTransform(node, pose × build⁻¹)` after every tick
  (render + collision body follow); "Rotate sound" via `objectSound` at
  Position with var 0, created at the mission (re)start.
- Data [observed]: L3 90°/s, On "1" (forever); L5 25°/s, accel 0, On "0"
  (forever at 25°/s); L8 25°/s, accel 1, On "!Switch_260.isPressed"
  (decelerates 25 s after the press, never restarts). Verified in
  `full-world.test.ts`; seen turning in `shots/L3-dish-in-a/b.png` (inside the
  opaque dome 446_03_1; no rain inside: the trace hits the roof).

## AlarmLight + AlarmLightReflector [recovered: class FUN_004397c0, create FUN_0043a0e0, compile FUN_0043a450, update FUN_0043a270, bullet LAB_0043a5e0 → FUN_0043a5f0, explosion FUN_0043a660, reflector create FUN_00439a50, update FUN_00439b70, draw FUN_00439ec0, glow FUN_00439f10]

- Compile shows the "Off model"; the magic container +0xe8 gets the model's
  ATTA objects (FUN_004c4950): 344_01_1's ATTA 344_02_1 =
  TASKTYPE_ALARMLIGHTREFLECTOR. The loader places it as the lamp's attachment
  "0" (magicType TASKTYPE_ALARMLIGHTREFLECTOR).
- Update (checked against the asm 0x43a30c–0x43a328): prev = isOn; the On
  sound instance (+0x1f4) is deleted while !prev or destroyed, else started
  if absent; destroyed → return (no expression, children or reflector);
  isOn = (char)fistp(On); rising edge → model +0x140 (**Off model**), falling
  edge → +0x130 (**On model**): the opposite fields. Then children, then the
  container (reflector).
- Reflector: θ += f32(π/30) (0x53381c) while owner isOn && !isDestroyed;
  +0x70 = M_lamp × M_attach × Rx(θ) (FUN_004b3b60 = [1 0 0; 0 c −s; 0 s c]).
- Glow: drawn by the reflector's draw while the owner is intact and on:
  centre = reflector + R × magic vertex 0 of 344_02_1 (276.3, −430.5, −3.2);
  only when (camera − lamp +0x20) · (lamp +0x108 column 1) > 0 (strict, the
  lamp's local +y); depth > 0; half-size 6144.0 units (0x439ff0) through
  FUN_00498040; red = 2·|fmod(θ, π)(double 0x533618) × f32(1/π) − 0.5| × 128
  (0x5335b4), g = b = 0; sprite alarmlight.spr (16×16 round glow), flags
  0x1040008 (same pipeline as the SCamera light).
- Damage: any bullet; an explosion with factor ≠ 0 (lamp origin, model
  radius). Destroy once: FUN_00480fe0(+0x20, 1, 0, 0.05 (0x3d4ccccd), 4096,
  0, 2048, 5, 2, 0, "1009_01_1", "Explode sound", 21, 2, 20480 (0x46a00000),
  0); isDestroyed = 1; model = "Destroyde model" ("" everywhere → no model).
- [observed] 344_03_1 (On model) = 344_01_1 without the ATTA: identical
  mesh, uvs, blocks, textures, collision set 0; the set-1 hull differs in 4
  coordinates by 0.0004 units. So the quirk swap has no visible or physical
  effect; world-tasks skips swaps between models of equal content
  (`sameModelContent`, collision tolerance 1e-5 m) and keeps the placed
  instance (its DNER deferred glass blocks). A destroyed lamp's root
  instance is removed (setInstanceModel null: render + collision); its
  reflector keeps its collision but is not drawn (`setInstanceHidden`).
- Port approximations: the reflector's spin moves its render entries only
  (`setInstanceTransform`; its collision sits inside the dome, so the dome is
  always hit first) [inferred harmless]; the glow is drawn whenever the lamp
  is in the world, independent of the reflector's LOD cutoff (the draw method
  runs before the inherited model draw that applies the LOD) [inferred].
- Visual check: `shots/L6-lamp0-off.png` (off: no glow) and
  `shots/L6-lamp0-on-*.png` (the round sprite, depth-clipped by the wall
  where the wall is nearer than the quad's single depth: a hard diagonal edge,
  as the recovered constant-depth quad implies).

## Siren [recovered: class FUN_00449360 (ExplodeObject subclass), create LAB_004492a0, update FUN_004494d0, compile FUN_00449610]

- Create: FUN_00481360 defaults (1, 0.5, 0.5, 1, 0, 5, 4, "explosion_1"),
  isOn / isLastOn / members 0, sound strings cleared, instances 0.
- Update: ExplodeObject update (children, Explosion expression, countdown,
  explode), isLastOn = isOn, isOn = (char)fistp(eval(On Expression))
  (FUN_004f16e0 without the compiled test; an absent expression reads 0
  [inferred], none exists), then exactly: `!isOn && !exploded && working →
  stop working; if !isOn { if exploded && faulty → stop faulty; return };
  if !exploded && !working → start Working; if isOn && exploded { stop
  working; start Faulty if none }`.
- Port: behaviour `loaders/objects/siren.ts` (state flags `working` /
  `faulty`); world-tasks plays them with `objectSound` at Position
  ("alarmsystem_working" = ALARM_1, 40 / 80 m, loop [observed]); the damage
  system treats it as an ExplodeObject (limit "Damage scale" 1: six 0.2
  bullets; explosion 0.5 m / 0.5 m / damage 1 / 5 fragments / 4 fireballs,
  "explosion_1" has no DefineSound: silent [observed]). L11's "Destroyed
  model" names the intact model 310_01_1: the damage system now skips a
  destroyed-model swap to the same name (the lightmapped instance stays)
  [inferred: setting the shown model changes nothing].

## RainEffect and the Rain object [recovered: class FUN_00436780, update LAB_00436990, compile FUN_00436a50; Rain FUN_00498ab0 (0x56d0), create FUN_00498960, colour FUN_00499fa0, step FUN_00499cf0, draw FUN_00498b80 → FUN_00498bd0 (trace) + FUN_00498f10 (FUN_00499090 fill, FUN_00499910 cull, FUN_00499430 cells)]

All constants read from the exe (`scripts/peek.mjs`): C = 10895.3604
(0x5342d0 / double 0x534288), 1/C double 0x534290 and f32 0x534280, 5.5C
(0x534298), 12C (0x534278), H = 24576 (0x5342a0), 1/H (0x5342a8), 1.5H
(0x5342b0), 3H (0x5342c0 / 0x5342c8), spawn 307.2 (0x5342cc), drift
136.53334 (0x5342d4), fade step f32(1/60) (0x5334c0), streak 2048
(0x533688), flake 81.92 (0x5342b8), alpha factor −255 (0x5342d8), speeds
2048.0 / 0x434ccccd (204.8). Corrections / additions to the spec:

- The Rain object's generator is the level-RNG algorithm (FUN_004b4770 /
  FUN_004b4740 = step `s2 ^= s0>>7; s1 ^= s2; s0 += s1`, float = (s0 & 0xffff)
  × 2⁻¹⁶, int = s0 % n) with FUN_004b4720's initial state {0xc8fb1a07,
  0x39ea7756, 0x7ff13ccd} set once at the class registration (= `new
  LevelRng(0)`), never reseeded: one per session in the port.
- Step order per drop: z −= speed (wrap +H below 0); snow: timer (stored as
  float) := (int)timer − 1, and when the old timer < 0: timer += rand(30) +
  30, vx = (r − 0.5)·K, vy = (r − 0.5)·K; x += vx (wrap ±C, group ^= 1), y +=
  vy (wrap ±C, group ^= 2). Spawn: x = r·C, y = r·C, timer 0, z = H − speed,
  group = rand(4) (draw order x, y, group).
- **80 drops after 13 ticks (rain) / 121 (snow)**, not 12 / 120: the f32 307.2
  is 307.20001, so 12 × 2048 leaves the last spawn one tick later.
- Fill (FUN_00499090) quirks [recovered, asm 0x4990d7, 0x4992d5]: the
  highest drop is searched among drops 0 … n−2 only (n−1 comparisons from
  drop 0); the per-group z list records the z of the **next** drop of the
  global order (read after the pointer decrement), and the per-layer cut
  counts the leading list values > t. Both reproduced.
- Trace (FUN_00498bd0): ring origin floor((cam − 5.5C)/C + 0.5); slot
  coordinates accumulated in doubles exactly as the exe; budget 10000 on the
  first draw, else ceil(|Δx|·f32(1/C)·12) + ceil(f32|Δy|·f32(1/C)·12); ray
  from (x, y, camZ + start) down by start + end, flags 0xc8000000 → port
  `TRI_BULLET` (visible object faces + terrain, DiscardTerrain cut)
  [inferred mapping]. On a miss the out record keeps the previous hit of the
  same pass (stack buffer reused): port = previous hit of the call, else
  camZ − end [inferred]. Records store x, y, floor as doubles (+0, +8, +0x10),
  the depth key f32 (+0x18), flags (+0x1c).
- Cull (FUN_00499910): outcode bits 1 left, 2 top, 4 right, 8 bottom, 0x10
  behind (behind points keep a side bit by the sign of their view x / y);
  column flag = 0x20 | AND of its two points; a cell is queued when the AND of
  its 4 corner columns is exactly 0x20; key = max corner key, key = mean of
  the two depths.
- Cell draw (FUN_00499430): group = (floor(y/C)&1)<<1 | (floor(x/C)&1) of
  the (i, j) corner; t = f32(floorMax − bandBase − 3H), then per layer k = 2,
  1, 0: t = f32(t + H); n = all if t < 0, 0 if t > H, else the leading list
  values > t; DrawPrimitiveVB(LINELIST 2 / TRIANGLELIST 4, start g·480,
  n·2 / n·6 vertices).
- States [recovered from the SetRenderState / SetTextureStageState calls]:
  as the spec. Port: rain = `LineSegments` (vertex colour RGBA, top alpha 0,
  bottom alpha = colour byte), snow = textured quads (snow.tex 16×16, MAG
  linear / MIN nearest), alpha blend, no fog, depth LESS, no depth write,
  drawn for `ctx.camera` only (the map computer's camera skips it).
- Approximation: igi.exe inserts every cell into its one depth-sorted
  deferred list; the port sorts the cells back to front inside one mesh that
  three.js draws in its transparent pass [approximation].
- No sounds (footstep / ambient rain need a RainDynCubeObj, none in the data).
- Shots: `shots/L3-start.png` (rain), `shots/L3-dish-a.png`,
  `shots/L7-weather.png` (snow).

## CubeModifier [recovered: class FUN_0052b3b0, create LAB_0052b320, destroy LAB_0052b4d0, compile LAB_0052b510, transform LAB_0052b630]

Editor marker: create never adds it to the world (no model, collision or
draw), no update slot, the Expression (labels such as "VILLAGE", "tank") is
never compiled, the global array DAT_00a843ac[100] it registers into is read
nowhere else (every reference in 0x52b37e–0x52b4fd). [observed] all 15 have
Static above them (directly or through Containers): never updated. Port: no
POSE_SPECS entry (not placed), a no-op behaviour (no expression, no child
update), tested in both test files. DiscardTerrainArea (FUN_0052b6c0, 0
instances): editor generator, ignored.

## Open points

- HumanSoldierFemale (L14 ×5) is in nobody's assignment.
- Object explosions (ExplodeObject / Siren / AlarmLight) do not place their
  scorch decal (the damage system emits scorch only for grenades) —
  pre-existing.
- A model swap to a model whose content differs from the shown one would use
  `setInstanceModel`, whose replacement meshes lose the DNER deferred flags
  (no such swap in the shipped data).
- The reflector's collision does not spin with it (render-only transform).
- The cell sort approximation of the rain (see above).
