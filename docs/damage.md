# Shot objects and explosions

How `igi.exe` damages objects with bullets and explosions (glass, explosive
barrels, ExplodeObject and the Terminal family, security cameras, switches,
cars) and what an explosion does (fireballs, smoke, fragments, sound, AI
event, damage, knock-back, view shake). Labels:

- **observed**: measured over the data files (file and method named);
- **recovered**: read from `igi.exe` code (address named; Ghidra 12 on the
  analysed build, SHA-256 `2b1673…74c2`);
- **inferred**: an interpretation the traced code does not prove.

Units: 4096 = 1 m, z up, ticks of 1/30 s. The FPU runs in chop mode with
53-bit precision ([gameplay.md](gameplay.md) "FPU rounding mode"), which
matters for the damage sums below.

Port: `web-port/src/engine/combat/explosion-rules.ts` (pure rules),
`combat/object-damage.ts` (the run-time objects, the explosion queue),
`fx/explosion.ts` (visuals), `loaders/damage-data.ts` (model bounds, magic
definitions, destroyed models), `world/world-builder.ts` (removal and model
swaps), tested by `web-port/tests/damage.test.ts`.

## 1. Dispatch

All recovered.

- Every task type has a handler table at 0xa3c820 (`[method × 0x180 +
  type]`, [collision.md](collision.md) §3). Two methods matter here:
  - **bullet hit**, index `DAT_00537431` (getter `FUN_00415740`);
  - **explosion hit**, index `DAT_00537433` (getter `FUN_00415760`).
- **Bullets** (`FUN_00479e30`, call at 0x47a0dd): on a front-face hit
  (material word 0x13 set, 0x14 empty) of an object, the bullet calls the
  object's bullet-hit method with the record
  `{hit result, damage, segment x/y/z, shooter, …}` — damage = the
  gunshot's +0x38 (weapon "Damage Factor", no zone, no difficulty), segment
  = the end minus the start of the current cast. The call comes **before**
  the impact sound, the ricochet roll and the penetration test, and also
  when the bullet is already inside a solid. Terrain has no object.
- **Explosions** (`FUN_0047d570`, loop at 0x47e364): when the explosion's
  damage is not 0, every object of the **damage list** `DAT_00577b68`
  (`FUN_004157d0`) gets the explosion-hit method with the record
  `{fireball, &centre, damage, radius, falloff, 90, source}` (0x47e325).
  The list holds, in registration order (removal swaps the last entry in,
  `FUN_004b79f0`): glass (`FUN_00448630`), explode-magic objects
  (`FUN_0043b040`), ExplodeObject and subclasses (`FUN_0047faf0`),
  SCamera lenses (`FUN_00440780`), cars (0x42d40f), helis (0x4307cf) and
  every human (0x45d86d).
- **Damage factor** `FUN_00415b90(record, object, centre, targetRadius)`:
  `e = |centre − explosion| − targetRadius − radius` (register value);
  `damage` if `e < 0`; else with `e` stored as a float,
  `damage × (falloff − e) / falloff` if `e < falloff`; else 0.
- **Target radius** of most handlers: `FUN_004c59a0(model) × max(scale)`
  = the float at HSEM +120 of the model (the model header chunk is kept in
  memory; its +0x20 is the documented model type). That float equals the
  largest distance of any vertex — render and both collision sets — from
  the model origin on every model checked (300_01_1 4640, 203_01_1 4817,
  418_03_1 2354, 313_02_1 2864, 622_01_1 20913, 410_03_1 8401) [observed].
- **Damage sums** store as float32 in chop mode and compare the unrounded
  sum (`fld add; fadd [acc]; fst [acc]; fcomp [limit]`, e.g. 0x44894b,
  0x480532). 0.2 + 0.2 + 0.2 stores 0.59999996, so **five MP5SD / Glock
  rounds (0.2) sum to 0.99999996 and a limit of 1 needs six** [recovered
  arithmetic; consequence derived].

| Weapon damage (weaponconfig.qvm) [observed] | Limit 0.5 | Limit 1 | Limit 3 |
| --- | --- | --- | --- |
| MP5SD, Glock 0.2 | 3 | 6 | 16 |
| AK47, M16A2 0.3 | 2 | 4 | 11 |
| Uzi 0.35, Uzi×2 / SPAS12 pellet 0.25 | 2 | 3 / 4 | 9 / 12 |
| Dragunov 1.0 | 1 | 1 | 3 |

## 2. Per type

### Glass (TASKTYPE_GLASS) [recovered `FUN_004487b0` registration]

- **Create** (`FUN_00448630`): damage +0x13c = 0; threshold +0x140 =
  float(0.75 + rand × 0.75) (level RNG +0x2c, f32 0x531524), so
  [0.75, 1.5); broken +0x144 = 0. The draw happens when the building that
  owns the pane is created, which is before LevelFlow's create seeds the
  level RNG (`FUN_004872f0` → `FUN_00415c90`, LevelFlow is the last task):
  the thresholds use the generator's pre-seed state and take nothing from
  the seeded sequence (the port draws them from the generator's initial
  state [inferred]).
- **Bullet** (`LAB_00448940`): damage += hit damage; when the sum reaches
  the threshold and the pane is not broken: broken = 1, shards
  (`FUN_00449010`, pushed by segment × 0.007, f32 0x5318b8, normalised to
  10 units) and the sound **`glass_crush_{rand(3)+1}`** at the pane's
  origin (`FUN_00449470`, level RNG).
- **Explosion** (`LAB_004489e0`): the target is the model's HSEM bounding
  sphere (+48 centre rotated by the pane, +60 radius, no scale); damage +=
  factor; **any non-zero factor breaks it** (shards from the explosion
  centre, speed clamp(d, 0, 1) × 409.6 = 409.6, `FUN_0044abb0`, and the
  same sound).
- **Physics contact** (method `DAT_0054a556`, `LAB_00448af0`): breaks it
  (vehicles driving through); not used in level 1.
- **Update** (`FUN_004488c0`): children, then a broken pane deletes itself
  (`FUN_00401630`): render, collision and its damage-list entry go at the
  pane's next update, i.e. the tick after the hit for panes updated before
  the shooter (all level-1 building panes: their buildings, 518–769, come
  before the player, 1079).
- **Sight**: AI sight already skips Glass (filter 0x53f120), so breaking
  changes nothing for the AI; bullets then pass unhindered (no impact, no
  ricochet). While intact a pane is material 14 Glass: hardness 0 (any
  weapon with penetration ≥ 1 passes; the knife's 0 passes 60 %), ricochet
  15°, hole_plexi1 decals ([collision.md](collision.md) §6).
- **Hits to break** (threshold uniform in [0.75, 1.5) from the 16-bit RNG):
  MP5SD / Glock 4 (t ≤ 0.79999996, p ≈ 1/15), 5 (4/15), 6 (4/15),
  7 (4/15), 8 (t > 1.39999996, 2/15); AK47 3–5; Dragunov 1 (t ≤ 1, p 1/3)
  or 2 [derived from the rules].
- **GlassShatter** (`FUN_00448b70`, `FUN_00449010` / `FUN_0044abb0`,
  `FUN_004494b0`, update `LAB_00448c90`; full rules in
  [rendering.md](rendering.md) §7.10): the faces of the pane's collision
  set 0 whose (b − a) × (c − a) runs along the push (a world vector against
  a local normal) are cut finer near the impact (edge limit 409.6 units at
  the impact, up to 4915 units 5120 units away) with a private generator
  `DAT_0057f768` (seeded once at start-up; the level RNG is untouched); up
  to 1000 shards fly from the impact (bullet 10, explosion 409.6
  units/tick, plus ±68.27 per axis), fall with (R₂₀, R₂₁, R₂₂) × −44.6 =
  world down in the pane frame (+0xa8..+0xb0 is the pane rotation's third
  row) [recovered], tumble by a 30-entry rotation table and fade with alpha
  = left / 30; the effect lives 30 updates (29 drawn). An explosion keeps
  cutting around the last **bullet** impact (globals it does not set).
  Shards are an untextured grey (0.7) PolyList drawn with D3DCULL_CW: the
  cut faces turn their front away from the shooter.
- **Level 1** [observed]: 54 panes in 12 buildings (418_03_1 ×40,
  410_03_1 ×6, 425_02/03_1, 400_15/16_1, 409_02/03/04_1), 4 on the truck
  (600_03..06_1) and 24 on four train wagons (605_02..07_1).

### Explosive magic objects (TASKTYPE_EXPLODEMAGICOBJ) [recovered `FUN_0043b190`]

- `DefineMagicObj(name, model, TASKTYPE_EXPLODEMAGICOBJ, destroyed, sound,
  a5..a11)` (`FUN_0043b3b0`): a5 → +0x10 hit points, a6 → +0x28 fireballs,
  a7 → +0x24 fragments, a8 → +0x20 (no reader found), a9 → +0x18 falloff
  (m), a10 → +0x1c explosion damage, a11 → +0x14 radius (m).
- **Bullet** (`LAB_0043b470`): damage += hit damage (no test here).
- **Explosion** (`FUN_0043b490`): if not exploded, damage += factor.
- **Update** (`FUN_0043b270`, no children): if not exploded and hit points
  ≤ damage: swap to the destroyed model (a missing one hangs the game),
  explosion `FUN_0047f350(origin, 1, 0, damage, radius × 4096, falloff ×
  4096, 6144, fragments, fireballs, 0, 1009_01_1, sound, 21, 2, 100000,
  0)`; exploded +0x148 = 1. It goes off on the tick after the hit.

| Model (magicobj.qvm) [observed] | Destroyed | Sound | Hit points | Fireballs | Fragments | Falloff | Damage | Radius |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 300_01_1 (14 in level 1) | 300_02_1 | explo_02_m | 3 | 2 | 5 | 5 m | 3 | 2 m |
| 603_02_1 | 603_03_1 | explosion0 | 3 | 6 | 5 | 15 m | 3 | 15 m |
| 422_02_1, 458_14_1 | 422_03_1, 458_15_1 | woodcrash_01 | 1 | 0 | 5 | 1 m | 0 | 1 m |

So a level-1 barrel needs 3 damage (16 MP5SD rounds) and deals 3 — a full
human kill — within 2 m plus the target's radius, fading to 0 over 5 m
more. Barrels inside each other's reach go off one tick apart (chain).

### ExplodeObject, Terminal, AlarmControl, SCameraControl [recovered `FUN_0047f750`, `FUN_0047fce0`, `FUN_0047fdd0`]

- Parameters (schema at `FUN_0047f750`, compile `LAB_0047ffb0`): "Damage
  scale" +0x1f0 → limit +0x1ec; "Explosion radius" +0x1f8, "falloff
  radius" +0x1fc (m); "Explosion damage scale" +0x204 → +0x200; "Explosion
  delay" +0x208 (s); fragments +0x20c, fireballs +0x210; expression
  +0x194; sound +0x214; destroyed model +0x180. Terminal and its
  subclasses inherit the handlers (`FUN_00442860` registers none).
- **Bullet** (`LAB_00480520`): if not exploded (+0x190): damage +0x1e8 +=
  hit damage; when it reaches the limit, **countdown +0x1f4 = 0**.
- **Explosion** (`LAB_00480560`): if not exploded and in the world
  (+0x234): damage += factor (target radius: model origin radius); when it
  reaches the limit, **countdown = trunc(delay × 30)** — written again by
  every later explosion.
- **Update** (`FUN_0047fce0`, [mission.md](mission.md)): explodes when the
  expression is true or the countdown is 0, else counts down. A countdown
  of n set by an explosion goes off n + 1 updates later.
- **Explode** (`FUN_0047fdd0`): swap to the destroyed model (when it loads),
  **then** take magic vertex 0 of the current model (`FUN_00486e20` →
  `FUN_004c5aa0`: origin + R (scale × v); none → the origin) and call
  `FUN_0047f350(point, 1, 0, damage scale, radius × 4096, falloff × 4096,
  6144, fragments, fireballs, 0, 1009_01_1, sound, 21, 2, 100000, 0)`;
  isExploded = 1.
- **Level 1** [observed]: six computers (ExplodeObject 'Computer',
  203_01_1 → 203_02_1): limit 1, 0.5 m / 0.5 m, damage 0.5, delay 0.5 s
  (15 ticks), 1 fragment, 1 fireball, `explo_monitor`. Terminals 501/502
  (252_01_1 → 203_02_1): limit 1, 0.5 m / 0.5 m, damage 1, delay 0, 5
  fragments, 4 fireballs, `explo_02_m`. 203_02_1 has no magic vertex, so
  all of them explode at their origin. Terminal 1402, AlarmControl 98 and
  SCameraControl 90/91 use the `waypoint` model and lie 11–74 m under the
  ground: unreachable.
- Shooting a terminal is how the player stops it: Terminal.isOn = 0 once
  exploded, so a hacked or alarm terminal stops working
  ([mission.md](mission.md)).

### SCamera [recovered `FUN_00440190`]

- The holder (SCamera, 313_01_1) has no damage handlers; its lens (class
  SCameraLens, the "Camera Model" 313_02_1) has them and sits in the damage
  list. The lens **is the camera head**: one rigid object with its own
  model, placed at the holder's magic vertex 0 and turned every tick
  ([mission.md](mission.md) "Parts"). Bullets reach it through the
  inherited ray method 9 on its model's HSMC set 0 at its current pose (no
  bounding test; 313_02_1: 56 faces, Plastic / Rubber); the lens registers
  no bullet filter, so every shooter's bullets test it.
- **Lens origin** (+0x20, the explosion centre and the target point of the
  explosion handler) = holder position + Rz(Holder Gamma) × magic vertex 0
  of the Holder Model (`FUN_00441290` 0x4412d2, `FUN_00486e20`); the
  rotation never moves it. Target radius = 2863.6 units (313_02_1 +0x78).
- **Lens create** (`LAB_00440780`): damage +0x104 = 0, **limit +0x108 = 0.5**.
- **Bullet** (`LAB_00441470`) / **explosion** (`FUN_004414b0`, target
  radius = lens model origin radius): if the holder is not exploded
  (+0x170), damage += amount; at the limit the lens's destroy request
  +0x25cc = 1.
- **Lens update** (`LAB_00440930`, 0x440b9d): after this tick's vision and
  detection, a destroy request: holder isExploded = 1, lens model = "Camera
  Destroyed Model", `FUN_0047f350(lens origin, 1, 0, 0.25, 2048, 0, 0, 7,
  3, 0, 1009_01_1, explo_camera, 21, 2, 100000, 0)` — damage 0.25 within
  0.5 m only (falloff 0). Then the camera is off for good ([mission.md](mission.md)).
- **Destroyed state**: the same object keeps its place, its collision (now
  the faces of 313_03_1, same 56 / 12 face counts) and its updates; with the
  holder off it droops 2.5°/tick to −75° and the light goes out. The model
  swap happens at the lens update after the hit (the tick's vision and
  detection still run with the old state), not at the hit.
- Three MP5SD rounds destroy a camera [observed in the port: the player's
  MP5SD from 4.5 m, `isExploded` 1, droop to −75°].

### Switch [recovered `LAB_00444610`]

A bullet sets isDestroyed (+0x1c2) when "Destructable" (+0x220); no
explosion handler. Every level-1 switch has Destructable = FALSE [observed].

### Car [recovered 0x42ede0, `FUN_0042d840`]

- No bullet handler. The explosion handler counts only when the record's
  source (+0x18 → Explosion0 +0x84) points to the value 12: the launching
  weapon's id of a Missile (`FUN_00427xxx`, missile +0x894); 12 is the
  LAW 80 ([hud.md](hud.md) weapon icons). Then any non-zero factor sets
  the destroyed flag +0x91c.
- Destroyed: per point of the physics config (+0x2ac points at +0x284) an
  explosion after rand(30) ticks (1.0, 3 m, 0.75 m, 3 fragments, 2
  fireballs, `explo_03_l`), else one at the origin; 30 (10) ticks later
  the wreck model replaces it and Car.isExploded = 1 ([mission.md](mission.md)).
- **Level 1 has no LAW** (player MP5SD / Glock / knife; soldiers AK47,
  Uzi, Minimi, Dragunov, grenades, flashbangs [observed]): Car_1099 cannot
  explode, and `Car_1099.isExploded` stays 0 [inferred from the recovered
  handler and the level's weapons].

### No damage handlers [recovered registrations]

Building (`FUN_00447420`), Door (`FUN_00445290`), EditRigidObj
(`FUN_004e93c0`), MagicObj (`FUN_004cfff0`), RigidDynCubeObj
(`FUN_004b9670`) and Train register neither method: bullets leave only
their impact effects.

### Humans

- **Player** (`FUN_00412930`): d = |view position (HumanView +0xe0) −
  centre|:
  - knock-back: if d < (falloff + radius) × 1.5 (f32 0x531544) and not
    attached (+0x52c), +0x670 / +0x674 += (x, y) of the unit 3D vector
    view − centre × 758.518 units/tick (f32 0x531540; it decays ×0.9 per
    tick like bullet knock-back);
  - ear ringing (`earcandy`): if d < 102400, +0xdc8 += 1 − d × 9.7656e−6;
    the player tick clamps it to [0, 1], subtracts 1/150 per tick and plays
    the `earcandy` sound at that volume (`FUN_004111e0`);
  - view shake (`FUN_004645e0`): e = d − 3 radius; k = 1 if e < 0, else
    1 − e / (6 radius), skipped when k ≤ 0; amplitude k × 204.8 units,
    angle k × 0.75°, 90 ticks;
  - zone 13; factor `FUN_00415b90(origin +0x20, +0xa0 / 3)` where +0xa0 =
    the body model's origin radius (`FUN_004cfda7`: 000_01_1 → 3882.7,
    so 1294 units = 0.32 m); 0 → nothing more;
  - damage = factor × zone-13 multiplier (+0x2cc) × 0.75 / 1 / 1.25
    (difficulty 0 / 1 / 2), added unless god mode (`FUN_00415c80`);
    `player_xplhit_` unless dead; four RNG draws set the four hit-direction
    indicators +0xdcc..+0xdd8 to (rand + 1) × 0.4 (they fade 1/45 per
    tick).
- **Soldiers** (`FUN_004592a0` for HumanSoldier, siblings `FUN_004543c0`,
  `FUN_00456180`, `FUN_0045e650`): nothing when invulnerable (AI +0x3ab8);
  view shake with 1.5°; zone 13; factor with radius +0xa0 / 3; damage ×
  zone 13 (1) accumulates; at the maximum: dead, explosion death (flag
  0x20000), death push origin − centre; else, past the "Recoil threshold"
  since the last flinch, flinch (0x10000) and `ai_xplhit_`. **No
  TAKINGDAMAGE event** (only the bullet handlers post it).

## 3. The explosion [recovered]

### Creation (`FUN_0047f350` → `FUN_0047f410`)

`FUN_0047f350(pos, count, interval, damage, radius, falloff, scorchSize,
fragments, fireballs, scorchTarget, fragmentModel, sound, aiType, aiFlags,
aiRange, source)` draws the fragment direction (r − 0.5, r − 0.5, r − 0.3),
cone π/2, speed 272..1360 units/tick, and calls `FUN_0047f410`, which:

- creates an **Explosion0** task as the last child of the Dynamic task
  (`DAT_00805f94`, set by the Dynamic create at 0x4e7380);
- scorches `scorchTarget` (when given) with `burn1.tex` of half-size
  `scorchSize` through the hit object's bullet-hole slot (`FUN_0047ca60` =
  slot `DAT_0053e894`; the grenade's target is the hit of a 0.5 m ray
  straight down, `FUN_004c0e10`; a terrain hit has no object, so nothing
  on the ground; [rendering.md](rendering.md) §7.10);
- creates the fragment container (`FUN_004fa830(45, model, 0, 0.98, 0.6,
  44.6, radius × 0.9/4096, spin)`, three RNG draws × 0.628 for the spin);
- broadcasts the AI event at once (`FUN_0044fab0`, unless aiType = −1):
  `{type 21 EXPLOSION, team 1, flags 2 (range), range, position, source =
  the explosion, other = none}`.

| Caller | Damage | Radius | Falloff | Scorch | Frag. | Fireb. | Sound | AI range |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ExplodeObject family `FUN_0047fdd0` | "Explosion damage scale" | param m | param m | — | param | param | param | 100000 |
| Explode-magic `FUN_0043b270` | def | def m | def m | — | def | def | def | 100000 |
| SCamera lens 0x440bfa | 0.25 | 0.5 m | 0 | — | 7 | 3 | explo_camera | 100000 |
| Hand grenade `FUN_004751f0` | tag (1) | tag (7 m) | tag (3 m) | 1.5 m below | 3 | 1 | explo_02_m | 40960 |
| Grenade without config | 1 | 5 m | 0 | 1.5 m | 3 | 1 | explo_02_m | 40960 |
| Proximity mine 0x474beb | +0x124 | +0x120 m | 0 [inferred: esi] | 1 m | 3 | 1 | explo_proxy | 100000 |
| Car `FUN_0042d840` | 1 | 3 m / r × 0.25 | 0.75 m / r × 0.05 | 0.75 m | 3 | 2 / 1 | explo_03_l | 100000 |
| Heli 0x430af0 | 1 | 3 m | 0.75 m | 0.75 m | 3 | 2 | explo_03_l | none |
| Missile 0x427b59 | 5 | 2.5 m | 1.75 m | 1.5 m | 10 | 5 | explo_03_l | 100000 |
| M203 `FUN_00439850` | 0.05 | 1 m | 0 | 0.5 m | 5 | 2 | +0x180 | 20480 |
| Scripted explosion `FUN_00439e00` | +0x90 | +0x88 m | +0x8c m | 1.5 m | +0x98 | +0x9c | +0xa0 | none |

The flashbang (GRENADE_EXPLOSIONTYPE_FLASHBANG) does not call it: it
creates a flash (`FUN_0047cd10`, the flash method on every human, a
scorch) and deals no damage. The bullet impact debris (`FUN_00437749`) is
an Explosion0 with no damage, fireball or sound ([rendering.md](rendering.md)).

### Explosion0 (`FUN_0047f2b0`)

delay +0x40 = interval; each update: delay −= 1 while non-zero; at 0 with
explosions left: explode, left −= 1, delete at 0, else delay =
rand(interval). Every caller passes count 1 and interval 0 or 1, so the
explosion happens on the Explosion0's first update — the end of the
Dynamic walk of the tick that created it (it is appended to the list that
is being walked).

### Explode (`FUN_0047d570`)

Nothing at all when radius = 0. Otherwise, in this order:

1. **Fireballs** (FireBall, `FUN_0047e3d0`, model 1006_01_1: a hemisphere
   dome of radius 2038 units with the 26-frame additive texture
   1006_anim000..025): the first at the centre, size = radius (× 0.75
   when there are several), life 75 ticks; each further one i = 1..n−1
   draws size (r × 0.25 + 0.5) × radius, one unused float, offset
   (r − 0.5) × radius per axis, life trunc((r + 1) × 75 × 0.5) and start
   delay (75 / n) i + trunc(15 r) (7 draws). Scale = size / 2048; the
   dome's apex is turned to the camera (x horizontal) and that axis grows
   from 0.01 to full over the life; frame = trunc((life − left) / life ×
   26) mod 26 in chop mode (`FUN_0047ea50`, `LAB_0047eb00`; details and
   render states in [rendering.md](rendering.md) §7.10).
2. **Smoke** (ExplosionSmoke, `FUN_0047d520` / `FUN_0047e790`) when there
   is a fireball: life trunc(299 − 150 / n) (n > 1) or 150 ticks, size
   radius × 0.9; two one-particle `smoke2.spr` systems: a SRCALPHA/ONE glow
   on its first update (4 RNG draws: fade, alpha, angle, spin) and a
   ZERO/INVSRCCOLOR shade at left = trunc(0.9 T) (2 draws), whose alpha it
   sets to a triangle peaking at 0.3 every update; colour 12.7/128, so both
   are faint. The smoke updates come in Dynamic-list order: smokes of
   earlier ticks before this tick's Explosion0s, their new smokes after.
3. **Fragments** (`FUN_0047d440`): per fragment 7 draws — speed,
   roll r π, tilt r × cone, one unused, three spin-tilt floats × π/100;
   scale 0.1; then they fly with v × 0.98, v.z −= radius × 0.9/4096 ×
   44.6 × 0.98 per tick, no collision, 45 ticks (`FUN_004fa1d0`,
   `FUN_004fa7d0`; [rendering.md](rendering.md) for the bullet debris).
4. The **sound** at the centre (`FUN_004dd750` / `FUN_004dd880`).
5. The **damage list** (§1), when damage ≠ 0.

### Thrown grenades (class "Grenade") [recovered unless marked]

Port: `web-port/src/engine/combat/grenade.ts` (shared by the player's S7,
docs/weapons-view.md §10, and the soldiers' state 8), drawn by
`render/grenades.ts`; tests `web-port/tests/grenade.test.ts`. Positions in
units, velocities in units/tick.

- **Class** "Grenade" (0x738 bytes, `FUN_00474e70`, TASKTYPE_GRENADE)
  derives from PhysicsObj (`FUN_004f2200`): init `LAB_004750f0`, update
  `FUN_004751f0`, destroy `FUN_00475580`, bullet method 0x4755c0 (fuse = 0),
  explosion method `FUN_004755d0` (fuse = 0 when `FUN_00415b90` with the
  model's origin radius gives a non-zero factor: chain reaction one tick
  later), character-sweep and ground-probe filters "always skip", the
  projectile spawn `FUN_004756c0`, the weaponconfig tag reader
  `FUN_00474fe0` ("Grenade - Explosion damage factor / radius (meters) /
  falloff (meters)", defaults 1 / 5 / 0 → +0x6e0) and the type reader
  `FUN_00475690` (the DefinePhysicsObjType tail: fuse seconds, explosion
  type). No draw method: the rigid-object draw of its model.
- **Type** [observed physicsobj/physicsobj.qvm]: 135_01_1 (hand grenade)
  and 137_01_1 (flashbang): mass 0.3, box 0.1 × 0.1 × 0.15 m, five contact
  points at the model's magic vertices 0..4 (four round the body at
  z = −64, one at the bottom, z = −328 units; vertex 5, the top, is not a
  contact point), restitution 0.3 and friction 1 each, at rest below 3
  units/tick and |ω|² 0.016, fuse 4 s, GRENADE_EXPLOSIONTYPE_NORMAL /
  _FLASHBANG. The type is found by the weaponconfig "Gun Model"
  (`FUN_004e4cc0`), which is also the model drawn: the grenade in flight
  looks like the AMMO_ID_GRENADE pickup (135_01_1).
- **Create** `FUN_00475760(parent = Dynamic, owner, position, matrix,
  velocity, weaponconfig, cooked)`: placed at the position with the matrix;
  physics set up (`FUN_004f2210`, `FUN_004f2320`: box inertia, inverse × 1.01,
  contact points); fuse +0x720 = max(0, −fistp(4 × −30) − cooked) = 120 −
  cooked; the body's velocity = the argument (angular momentum 0: **no
  spin** until a bounce); AI event GRENADETHROWN (17, team −1, flags 1, range
  −1; `FUN_00475470`). Player: cooked 0 (docs/weapons-view.md §10). Soldier
  (state 8 `FUN_0045a170` on event 11 with a target): fly = f32(r ×
  random + min) s, cooked = fistp(r × random × 30 + min) (the explode
  minimum is added unscaled), position = origin + [human +0x70] +0x858
  (the port uses the hand bone [inferred]), velocity `FUN_00451740` =
  1.1 d / T + (0, 0, 22.300444 T), T = f32(fly × 30), d = aim point
  (`FUN_00450150`: last known origin + 0.5 m / 0.25 m crouched) − position.
- **Update** `FUN_004751f0` (a Dynamic child: first update in the tick that
  created it): fuse ≠ 0 → fuse − 1, physics `FUN_004754c0`, bounce sound
  `FUN_004753f0`, children; fuse 0 → explode, delete. So the explosion is
  on the 121st update (4 s after the throw).
- **Physics** `FUN_004754c0`: nothing at rest (`FUN_004f33d0`: contacts > 0,
  no wake flag, no pending force, speed < 3, |ω|² < 0.016); else
  `FUN_004f2d00(obj, 44.600887, 1.0, 0.92, world, filter 0x537430)` and,
  with no contact this tick, v × 0.985 (0x53212c). `FUN_004f2d00`:
  1. `FUN_004f2bb0`: force −(g m) along world z in the body frame,
     `FUN_004e3220` (v and L from the forces, orientation by ω), L × 0.92,
     v × 1.0.
  2. `FUN_004f25c0`: every contact point's path from P = position + M r to
     P + (v + ω × r) (the whole tick's motion) is cast (`FUN_004c24c0`:
     HSMC set 0 of the objects + terrain; the filter skips humans, pickups,
     other grenades, guns, wires); contacts := 0; for the hits in point
     order: normal = the face's outward (c − a) × (b − a), normalised; vn =
     (v + ω × r) · n (`FUN_004f3490`); vn > 1 separating, vn > −1 resting:
     skipped; vn ≤ −1: contacts + 1, impulse `FUN_004f3500` j = −(1 + e) vn
     / (1/m + n · ((I⁻¹ (r × n)) × r)) along n (L += Mᵀ (r × J), ω = M I⁻¹ L,
     v += J / m), friction `FUN_004f38c0` (t = −the unit tangential
     direction of v; v += t min(|v · t|, g |n_z| × friction); L × 0.92), and
     **no other point this tick**. The first point in index order wins even
     when a lower one would touch first: a grenade falling flat on its
     bottom takes the hit on side point 0 and starts to tumble. A hit
     object's contact method (DAT_0054a556: glass) may cancel a hit [not
     ported].
  3. Position += v only when the speed (approximate length) > 40.96
     (0x531730).
  4. `FUN_004f3240`: from every point at the new pose a ray 5 m up
     (`FUN_004c1c10`, 20480 units); the first hit a back face (the point is
     under a surface) → contacts + 1, position and matrix back to the
     previous tick's (+0x6c0 / +0x694), velocity kept.
  Resting on the ground the grenade keeps bouncing by a few units per tick
  (gravity 44.6 against restitution 0.3: ~10 units/tick up, under the move
  threshold, so it does not move); the rest test rarely passes.
- **Bounce sound** `FUN_004753f0`: with contacts and armed (+0x728 = 0):
  `grenade_bnc_1` at the grenade (`FUN_004dd750` / `FUN_004dd880`) and AI
  GRENADELAND (18, team −1, flags 2, 20480 = 5 m), disarmed, +0x724 = the
  tick; without contacts and more than 10 ticks after the last sound:
  re-armed.
- **Explosion** (fuse 0): the surface within 0.5 m below (`FUN_004c0e10`
  down 2048 units; terrain hits carry no object, so no scorch there);
  NORMAL: `FUN_0047f350(position, 1, 1, tags +0x6e0 [damage, radius × 4096,
  falloff × 4096], 6144, 3, 1, surface, 1009_01_1, explo_02_m, 21, 2,
  40960)`, level 1: 1, 7 m, 3 m [observed weaponconfig.qvm]; FLASHBANG
  (10 m, 15 m): `FUN_0047cd10` (a flash object, the flash method on every
  human, a 2048-unit scorch; no damage). Without a weaponconfig: 1 /
  20480 / 0, flash 20480 / 40960.
- RNG draws: none in the flight; the explosion's six in `FUN_0047f350` /
  `FUN_0047f410` (§3) and those of Explode; the soldier throw draws fly
  then cook.

## 4. Tick order

The objects above live in their buildings, which come before the humans in
the task tree; explosions are appended to the Dynamic task. So, for a
bullet in tick T: glass breaks (shards, sound) at T and disappears at
T + 1; a barrel or camera goes off at T + 1; a shot computer (countdown 0)
explodes at T + 1; an explosion's damage lands at the end of its tick; a
barrel it reaches goes off one tick later; a computer it reaches 16 ticks
later (delay 0.5 s). Car_1099.isExploded and other members read by
LevelFlow see the result one tick later [inferred from the recovered tree
order].

## 5. Port integration

- `world-builder.ts`: destructible instances (glass, explode-magic,
  the root model of ExplodeObject / Terminal family / Switch tasks, the
  SCamera lens) keep their posed collision; those of static tasks share one
  rebuildable body (`DESTRUCTIBLE_BODY_ID`), those of dynamic tasks stay in
  their task body, rebuilt without them. The SCamera lens has its own body
  (`scameraLensKey(node)`, turned by the mission system each tick), so its
  "Camera Destroyed Model" swap follows the turning head. `setInstanceModel(i, model | null)` removes or swaps
  (render and collision), `resetInstanceModels()`,
  `instanceWorldMatrix(i)`.
- `object-damage.ts`: `bulletHit(hit, damage)` from the bullet tracer;
  `beginTick()` before the humans (object updates), `endTick()` after the
  task runtime (pending runtime writes, runtime explosions, the explosion
  queue); `ExplosiveBridge` to the task runtime (isExploded, countdown,
  SCamera isExploded, Switch isDestroyed, in-world);
  `missionRuntimeBridge(runtime)` implements it over `nodeState`.
  Soldiers come from `setHumanTargets` (enemy.ts), thrown grenades too
  (combat/grenade.ts, provider "grenades": the fuse-0 method), the player from the
  context (`ctx.systems.player.damage`, optional `addKnock`), the AI event
  through `setAiEvents`. Events: `game:explosion`, `game:glass-break`,
  `game:object-destroyed`, `game:player-explosion` (knock, shake, ear
  ringing, indicators), `game:scorch`, `game:car-destroyed`.
- `fx/explosion.ts`: fireballs (model, frames, timing, camera basis, draw
  states), fragments (fx/debris.ts `FragmentSystem.launch`: the recovered
  motion with the explosion's cone, speeds and radius-scaled gravity,
  vertex-lit with object fog), the smoke systems (in the shared particle
  manager; their level-RNG draws happen in `object-damage.ts`
  `smokeUpdate`) and the glass shards (`fx/glass-shatter.ts`); no
  `Math.random`. `glassShatter` receives the bullet's hit point / the
  explosion centre (`from`). The scorch decal is placed by `fx/effects.ts`
  on `game:scorch`.
- Bullet holes: hits on the shared destructible body report
  `body = DESTRUCTIBLE_BODY_ID`; the decal lists should key them by
  instance (`RayHit.owner`) and drop an instance's holes when it is removed
  (`game:glass-break` → removal at the next tick) [inferred: the exe keeps
  holes per object and deletes them with it].

## 6. Open questions

- Closed: the fireball basis, the glass shard subdivision and the smoke
  particles are recovered ([rendering.md](rendering.md) §7.10).
- The bullet's hit normal is not in `BulletObjectHit`: the port takes the
  normal of the pane face containing the hit point (equivalent for a flat
  pane) [inferred].
- Closed: the lens origin (+0x20 of SCameraLens) is the holder's magic
  vertex 0 [recovered `FUN_00441290`]; the port places the lens (the turning
  head, `LevelInstance.part` "scameraLens", its own dynamic body) and
  registers it at attach / reset.
- The car wreck sequence is not implemented (level 1 cannot reach it).
- Heli and fence handlers, the M203 and the proximity mine were not
  traced beyond their explosion calls.
- Thrown grenades: the soldier's release point ([human +0x70] +0x858) and
  the grenade's initial matrix (player: the held gun's +0x70; soldier:
  `FUN_00451740`'s AI-frame × Rx(aim angle)) are not decoded (the port uses
  the hand bone, the view and the body heading [inferred]); bullets do not
  hit grenades in the port (method 0x4755c0); the glass contact method
  DAT_0054a556 (`FUN_004487b0`) is not ported; the flashbang's FLASHBANG AI
  event is kept from the earlier port (not found in `FUN_0047cd10`)
  [inferred].
- The damage-list order is approximated by the task tree order (the exe's
  list order follows creation with swap-removal).
