# Player weapons, items and first-person view

How `igi.exe` runs the player's weapon handling, the knife, the binoculars,
gun zoom, the first-person arms clips and the camera effects. Each statement
is labelled:

- **observed**: read from a game data file (file and method named);
- **recovered**: read from `igi.exe` code (addresses given; Ghidra 12
  decompilation and `objdump` disassembly of the analysed build, E005);
- **inferred**: an interpretation the traced code does not prove.

Port: `web-port/src/engine/combat/weapon.ts` (state machine and use
handlers), `combat/melee.ts` (knife), `combat/weapon-tags.ts`
(weaponconfig fields), `player/first-person.ts` (view object: arms clip,
sway, shake, dip, FOV), `player/camera.ts`, `render/viewmodel.ts`. Tests:
`web-port/tests/weapons-view.test.ts` (real level-1 data).

## 1. The player tick, weapon side

`FUN_00410a30` (player tick) [recovered], in order:

1. Input channels refresh: `human+0x1b0 + 4i` = current value of channel i,
   `human+0x110 + 4i` = previous tick's value (`FUN_0045fb20`). A "press" is
   current ≠ 0 and previous = 0.
2. `FUN_00410fa0` (WeaponCategory keys) and `FUN_0040f890` (next / previous
   weapon), unless the map computer is open (`FUN_0046abe0`).
3. Movement state machine (`human+0x2ec`, table `0x53660c`), then the
   **weapon state machine** (`human+0xcf8`, table `0x5366d0`) — both
   `FUN_004e2d60`.
4. Mouse look yaw (`FUN_0045fd00`), pitch and the generic camera zoom
   (`FUN_00463470`), body animation and movement.
5. View object update `FUN_00463840`: shake, eye, lean, dip, pull-back,
   sway step, arms clip step, arms pose.
6. Item use `FUN_00461a90` (fire, zoom handlers, binoculars) and the view
   kick.

### Input channels of the player [recovered `FUN_0045cde0`]

`FUN_0045cde0` copies the action bitmask (action table `0x5345b8`, 0x24-byte
records, mask at +0x20) into the channel array:

| Channel | Offset | Action (config.qvm name) | Mask |
|---|---|---|---|
| 0 / 1 | 0x1b0 / 0x1b4 | mouse turn / look (× sensitivity clamp [0.05, 1]) | — |
| 2–5 | 0x1b8–0x1c4 | MoveLeft / MoveRight / MoveUp / MoveDown | 1, 2, 4, 8 |
| 6 | 0x1c8 | Fire | 0x100 |
| 7 | 0x1cc | AlternateFire | 0x4000 |
| 8 | 0x1d0 | Reload | 0x200 |
| 9 | 0x1d4 | Activate | 0x400 |
| 10 | 0x1d8 | Crouch | 0x800 |
| 11 | 0x1dc | Jump | 0x1000 |
| 12 | 0x1e0 | Peek | 0x8000 |
| 13 | 0x1e4 | weapon select (−1; `FUN_00410fa0` writes the category's weapon id) | — |
| 14 / 15 | 0x1e8 / 0x1ec | ZoomIn / ZoomOut | 0x100000, 0x200000 |
| 16–19 | 0x1f0–0x1fc | always 0 for the player | — |
| 20 | 0x200 | ToggleWalkRun | 0x40000 |
| 21 / 22 | 0x204 / 0x208 | NextWeapon / PrevWeapon | 0x2000, 0x80000 |
| 23–31 | 0x20c–0x22c | WeaponCategory1–9 | 0x400000 … 0x40000000 |
| 32 | 0x230 | MapComputer | 0x20000 |
| 34 | 0x238 | Binoculars | 0x10000 |

Consequence: the generic camera zoom in `FUN_00463470` (× 0.96 / × 1.0416667
per tick on channels 16 / 17, reset on 18) never runs for the player. The
player's ZoomIn / ZoomOut keys reach only the Binocular and GunDRAGUNOV
handlers (§5, §6), with × 0.96 and **× 1.04** (f32 0x531a78). This corrects
docs/rendering.md "Zoom" and gameplay.md "Look". [recovered]

The name table at `0x536778` ("Analog X", "Zoom in", …) is a debug list whose
order does not match these channels. [recovered]

## 2. Weapon state machine (`human+0xcf8`, table `0x5366d0`)

`FUN_004e2d10(sm, pre-tick 0x4107f0, table 0x5366d0, initial state 1, 0
rules)` [recovered, 0x4105d7]. Each table entry is a state's *enter*
function; it installs the state's *tick* function, which first runs on the
next tick. The machine starts with S1's enter function as its first tick.

Pre-tick flags (`FUN_004107f0`): bit 0 = the arms clip-end flag 0x100 (from
the previous tick's arms update), 0x200 Fire held, 0x400 AlternateFire held,
0x800 Reload held, 0x8000 Peek held, … [recovered]

Human fields: `+0x4d0` weapon active, `+0x4d1` fire request (cleared after
each use), `+0x4d3` "fired" result of the last use, `+0xd48` cycle index,
`+0xd4c` requested weapon, `+0xd50/+0xd54` category key / index, `+0xd58`
arms mode playing, `+0xd5c` arms mode wanted by the movement, `+0xde4`
weapon to return to from the binoculars. [recovered]

| State | Enter / tick | Behaviour [recovered] |
|---|---|---|
| S0 | 0x40ea70 / 0x40ea90 | arms off (ladders, wire, fence, terminals: `+0xd44`): entered from S1 (0x40eb17, after FUN_00464650), S2 (0x40f0a2) and S12 (0x40f204); enter = arms mode 0; back to S1 when cleared (E101, ported) |
| S1 ready | 0x40eac0 / 0x40ead0 | see below |
| S2 fire | 0x40f060 / 0x40f070 | Fire released: (Reload held or clip 0) and pool > 0 and clip < Rounds/Clip → FOV reset, S3. Fire held: clip 0 and clip anim ended → S12, else fire request. A shot last tick → arms mode 6. Clip anim ended and Fire released → S1 |
| S3 reload | 0x40f270 / 0x40f280 → `FUN_004780b0` | weapon inactive every tick; phase 0: arms mode 7 (ReloadAnim); phase 1: when the clip anim has ended, the ammo moves (`FUN_00477fe0`), active, S1 |
| S4 switch | 0x40f330 / 0x40f380, 0x40f400 | inactive, arms mode 9, sway target (−35°, −20°) at (3.33°, 1.90°) per tick; when reached: the requested weapon goes to the hand, arms mode 10, sway target 0; when reached: active, S1 (a new request restarts S4) |
| S5 peek | 0x40f470 / 0x40f4f0 | arms mode 1, movement state 44 (lean), arms lowered like S4; Peek released → lean cleared, sway target 0, S1 |
| S6 | 0x40f5a0 | M16A2 grenade launcher (FireAnim2) |
| S7 grenade | 0x40f620 / 0x40f6c0, 0x40f770, 0x40fb50 | FireAnim1; its trigger 4 pulls the pin (cook count, `grenade_tick_1`); FireAnim1 ended and Fire released → FireAnim2; its trigger 3 throws; FireAnim2 ended → StandAnim, sway snapped down and raised, clip refilled from the pool (S1 when up) or, the last one gone, the next weapon of the cycle (§10; ported) |
| S8 | 0x40fa60 / 0x40fa80 | proximity mine |
| S9 knife | 0x40fb90 / 0x40fbb0 | count = 0; Fire held and count < 3 → fire request; a stab last tick → arms mode 8 (FireAnim[count]), count + 1; clip anim ended → S1 |
| S10 medipack | 0x40fc60 / 0x40fcc0, 0x40fd10, 0x40f5f0 | FireAnim1, then FireAnim2 looped; one AMMO_ID_MEDIPACK round heals 0.01 × max damage every trunc(60 / rpm × 30) + 1 ticks while Fire is held and damage is left; then FireAnim3 and S1 when it ends (§10; ported) |
| S11 | 0x40fea0 | map computer (movement state 45, inactive) |
| S12 dry fire | 0x40f1d0 / 0x40f200 | arms mode 1, sound `guns_dry_1` once; Fire released → S1 |

**S1 tick** (`FUN_0040ead0`) [recovered], in order:

1. If the arms mode playing ≠ the wanted one, play the wanted one.
2. Binoculars key pressed (channel 34 edge) and binoculars carried: if they
   are in the hand, call their deselect and request the remembered weapon;
   else put them in the hand at once (`FUN_004e8cf0`, **no animation**) and
   remember the previous weapon. Also writes 1.0 into the Fire channel
   (no reader of the previous-Fire value was found).
3. While the binoculars are out, nothing below runs: no firing, reloading,
   peeking, switching, using objects or the map computer.
4. With a weapon in the hand: Fire held → by WEAPONTYPE (weaponconfig
   +0x610; enum 0x413e19: GUN 0, PISTOL 1, SHOTGUN 2, KNIFE 3, GRENADE 4,
   BINOCULAR 5, MEDIPACK 6, PROXIMITYMINE 7; switch at 0x40ec4b): knife →
   S9; grenade → S7 when the clip holds a round; medipack → S10 when the
   AMMO_ID_MEDIPACK pool is not empty and the damage taken (+0x254) is not
   0; mine → S8 when the clip holds a round; any other type → S2 (clip > 0)
   or S12 (clip 0). A grenade, medipack or mine that cannot be used falls
   through to the tests below. AlternateFire (Fire not held): M16A2 with
   M203 rounds → S6, mine → S8. (Reload held or clip 0) and pool > 0 and
   clip < Rounds/Clip → S3. Peek → S5.
5. A requested weapon → S4. Then Activate on an object in reach, MapComputer
   → S11.

Each transition to S3, S4, S5 and S11 calls `FUN_00464650` (FOV tangents to
default, scope flag off). [recovered]

### Timings (30 Hz ticks) [recovered from the above + data]

- **Weapon switch**: 11 ticks down + 11 ticks up (0.61086524 / 0.058177643
  = 10.5 → 11 steps; 0.34906584 / 0.033244 = 10.5 → 11), so the new weapon
  is in the hand on the 12th tick after the request and usable on the 23rd
  (state S1 again; it can fire one tick later). There is no per-weapon
  switch time.
- **First shot**: S1 sees Fire and enters S2; the shot is on the next tick.
  A one-tick click from S1 only enters S2 (or S9) without firing; S2 then
  waits for the clip-end flag (a looping stand clip flags it only when it
  wraps).
- **Reload**: from the S1 / S2 decision, ReloadAnim starts the next tick
  and the rounds move one tick after its last frame: MP5SD clip 21 = 100
  ticks (3.33 s), Glock clip 17 = 80 ticks (2.67 s) [observed 005.iff].
  "Reload Time" (1.8 s / 2 s) is not read.
- **Dry fire**: holding Fire on an empty clip in S2 enters S12 when the fire
  clip ends: `guns_dry_1` once per press; after the release, S1 reloads by
  itself when the pool has rounds.
- **Start of a mission**: the hand is empty (`FUN_00410460` sets
  `+0xd48 = −1`; no code puts a weapon in the hand at creation). On the
  first player tick `FUN_0040f890` treats −1 like NextWeapon and requests
  the first carried, selectable weapon of `DefineHumanPlayerWeaponCycle`:
  in level 1 the **knife** (cycle KNIFE, GLOCK, … MP5SD …). It is raised
  by the switch above (empty arms go down, knife comes up). The player is
  not updated during the intro (docs/mission.md), so this happens when
  control is handed over.

### Selection [recovered `FUN_00410fa0`, `FUN_0040f890`]

- WeaponCategory k (DefineHumanPlayerWeaponCategory, humanplayer.qvm): if
  k differs from the last key, the index restarts at 0; the index then
  advances (wrapping) to the next carried weapon of the category. Repeated
  presses step through the category. Level 1 [observed humanplayer.qvm]:
  1 knife; 2 Glock, Colt, Desert Eagle; 3 Uzi, Uzi×2, MP5SD; 4 M16A2,
  AK47, Minimi; 5 SPAS12, Jackhammer; 6 Dragunov; 7 grenade, flashbang,
  mine; 8 RPG-18; 9 medipack. The binoculars are in no category and not in
  the cycle.
- Next / previous (or cycle index −1): step through the cycle from the
  cycle index to the next carried weapon that is selectable (has rounds in
  clip or pool, or "Is weapon selectable when empty", +0x6dc). While the
  binoculars are out, next / previous instead requests the remembered
  weapon.
- A category choice sets the cycle index to that weapon's position.
- The requested weapon is stored only if it differs from the hand's.

## 3. First-person arms clips

### Modes [recovered `FUN_00413780`, `FUN_00413a00`]

`FUN_00413780(human, mode)` plays the first-person clip on the arms (via
`FUN_00488340` → `FUN_004cc860(arms+0x68, 0, clip, loop, blend)`) and the
third-person upper-body clip (`FUN_004882f0`). WeaponConfig fields:
+0x67c StandAnim, +0x680 MoveAnim, +0x684/688/68c FireAnim1–3, +0x690
ReloadAnim, +0x694… UpperBody*.

| Mode | Arms clip | Loop | Blend | Set by |
|---|---|---|---|---|
| 0 | (upper body cleared, arms unchanged) | | | special movement states |
| 1 | StandAnim | yes | 0.4 s | movement: standing still (state 0) |
| 2 | MoveAnim | yes | 0.4 s | movement: walk states 9–16 |
| 3 | MoveAnim | yes | 0.4 s | movement: run states 1–8 |
| 4 | StandAnim | yes | 0.4 s | movement: crouched still (states 19, 45) |
| 5 | StandAnim | yes | 0.4 s | movement: crouched moving (states 20–27) |
| 6 | FireAnim1 | no | 0 | S2, the tick after each shot; start time = 160 × f32(r × 0.175) × 30 animation ticks (0 … 0.175 s, level RNG) |
| 7 | ReloadAnim | no | 0 | S3 |
| 8 | FireAnim[count] | no | 0 | S9 (knife: 28, 29, 30) |
| 9, 10 | StandAnim | yes | 0.4 s | S4 lowering (old weapon) / raising (new weapon) |

Movement states set the wanted mode `+0xd5c` in their enter functions
(`FUN_00413a00`; e.g. state 0 → 1, 1–8 → 3, 9–16 → 2, 19 → 4, 20–27 → 5);
jump, fall and the crouch transitions leave it. Only S1 applies it, so
during firing / reloading / switching the arms keep the action clip.
[recovered; the walk / run / crouch labels follow docs/gameplay.md
"Animation-driven speeds"] **Walking and running play MoveAnim;
standing, crouching and moving crouched play StandAnim.**

### Clip player [recovered]

- `FUN_004cc860(anim, layer, clip, loop, blend)`: n = f32(blend × 4800 /
  160) game ticks; if the layer already plays something and n ≥ 1, a fade
  node is created (`FUN_004cc550`, `FUN_004cc660`): weight 1 − t/n after t
  updates, removed at t ≥ n (`FUN_004cca40`). 0.4 s → **12 ticks, linear**.
  Otherwise the clip replaces the old one at once.
- `FUN_004cb1f0` (per update): time += 160; events between the old and the
  new time fire (the first update also fires events at the start time); at
  time ≥ duration the end flag 0x100 is set, looping clips wrap
  (time −= duration, events from 0), one-shots hold the last frame and set
  the flag again on every update.
- `FUN_004ccc40` sets a clip's time (used for the random fire-clip start).
- The arms object starts with clip 2 (one-shot) (`FUN_004632d0`).
- During a fade the old clip keeps advancing (it is advanced first) until
  the n-th update, which drops it without advancing it; the end flag is the
  newer clip's (each instance advance clears the shared flag before it may
  set it, and the newest advances last). The poses mix with the exe slerp
  `FUN_004cab90` and the root offsets (arms+0x1f0, sampled before the
  advance) linearly, by the same weight. A fade started during a fade
  nests. Only the first event of an update is acted on (arms+0x20c). Full
  rules: docs/characters.md "Blending". [recovered]

The port's earlier choice (stand when still, move while moving, fire per
shot, stand clips held at their last frame) is replaced by these rules.
Stand clips (1.97 s) loop.

## 4. Knife

Weaponconfig [observed weaponconfig.qvm, `npx vite-node` dump]: Weapon
Type KNIFE, Damage Factor 0.1, Rounds/Minute 150, Rounds/Clip −1,
Maximum Rounds/Burst 1, spread 0, view change 0, Fire Sound knife_1 /
knife_2, Projectile Task Type **TASKTYPE_KNIFESTAB**, Weapon Task Type
TASKTYPE_GUN, FireAnim 28 / 29 / 30 (0.7, 0.7, 0.83 s), StandAnim 26,
MoveAnim 27, AI detection GUNSHOT_SILENCED (1 m).

Recovered:

- The knife fires through the ordinary gun code (`FUN_004772c0`): request
  from S9, burst 1 per hold, cooldown FISTP(60/150 × 30) = **11 ticks**, no
  ammo pool (calibre −1), the 50/50 knife_1 / knife_2 sound, the GUNSHOT
  noise event and a (zero) view kick. Instead of a bullet it spawns a
  KnifeStab task (`FUN_00413cd0` via +0x6d4).
- **KnifeStab** (`FUN_0046ca90` registers, `FUN_0046caf0` runs): three rays
  (`FUN_0046cb30`) from the eye, length **8192 units = 2 m**
  (double 0x531708), along the aim forward turned about the aim's up axis by
  f32 −0.2617994, then + 0.17453294 twice: **15° right, 5° right, 5° left**
  (FUN_004a9a70 = M·Rz(a); the aim matrix is `FUN_00486a60`'s basis of the
  view forward with a horizontal right axis). Bullet collision set
  (`FUN_00415730`). The first ray whose nearest hit is a task with a hit
  handler (a human) ends the stab; walls let the next ray try. No impact
  effect on walls.
- Hit record: damage = Damage Factor (0.1), **replaced by 1000** when the
  victim is a human with an AI whose combat target record is empty
  (`H+0x3aa8 == 0`, `FUN_00451700`): a stealth kill. Direction = the ray;
  the attacker field is 0.
- The soldier handler `FUN_0045bfe0` multiplies by the zone multiplier
  (head × 100), checks death (knife deaths use death type 2), and on a
  survived hit plays `ai_hit_N` and, for WEAPONTYPE_KNIFE, **`stab_01`** on
  the soldier.
- Cadence: holding Fire gives one stab, FireAnim1 (21 ticks), back to S1,
  re-entry, next stab: **one stab every 24 ticks (0.8 s)**, always clip 28.
  Clicking again after the 11-tick cooldown but before the clip ends chains
  FireAnim1 → FireAnim2 → FireAnim3 (max 3 per S9 visit).
- Soldiers hit the player in melee through `FUN_00412c80` (docs/gameplay.md).

## 5. Binoculars

Weaponconfig [observed]: Weapon Task Type TASKTYPE_BINOCULAR, Projectile
Task Type −1, StandAnim 68, MoveAnim 69; TagItems "Binocular - Default
FOV (degrees)" 70, "… Max …" 90, "… Min …" 5 (`LAB_0046f930` reads them,
defaults 70 / 90 / 5; stored as f32 tan(value/2) via `fptan`).

Recovered (`FUN_0046f500`, `FUN_0046f3d0`, `FUN_0046f780`, `FUN_0046ff00`):

- Selected only by the Binoculars key, instantly (§2). While they are out
  the weapon state machine handles nothing else; **movement is not
  restricted**; firing, reloading and switching are blocked. Next / previous
  weapon puts them away (request of the remembered weapon → S4).
- First use update: scope flag on (`FUN_00464640`, arms rotated −90° about
  x = hidden), FOV tangent = tan(35°) (70° horizontal).
- Then each tick (only while the weapon is active):
  - AlternateFire released → toggle flag; AlternateFire pressed with the
    flag set → FOV back to the default, stop. So: **hold AlternateFire to
    zoom in, click it again to return to 70°**.
  - ZoomIn held (or AlternateFire held with the flag clear) and tangent >
    min: tangent × 0.96 (f32 chopped). ZoomOut held and tangent < max:
    × 1.04. The test is made before the multiply, so the end values
    overshoot slightly: 70° → 4.995° in **68 ticks (2.27 s)**, back to
    90.31° in 80 ticks.
  - On the tick a zoom key goes down the loop sound `bin_zoom_1` starts as
    a child of the player (`FUN_004dd750`); it stops when zooming stops or a
    limit is reached. With AlternateFire zooming the "previous key" is the
    ZoomIn channel (0), so the sound restarts every tick.
- Deselect (`FUN_0046f3d0`): stops the sound, view off, skips the next use
  update once.
- Overlay (`FUN_0046f780` → `FUN_0046ff00`, docs/hud.md): drawn while the
  view is on. **RANGE** = a ray from the eye along the view forward,
  **4096000 units = 1000 m** (double 0x531550), bullet collision set:
  distance / 4096 printed "RANGE: %0.fM", else "RANGE: 1000+M".
- Look speed follows the tangent (§7).

## 6. Gun zoom

Handler class from "Weapon Task Type" [observed weaponconfig.qvm]: MP5SD
TASKTYPE_GUNMP5SD (objects.qvm also creates it as `GunMP5SD`), Dragunov
TASKTYPE_GUNDRAGUNOV, Glock / knife TASKTYPE_GUN (no zoom).

**GunMP5SD** (`FUN_004721f0`, use `FUN_00472310`, tag `FUN_004724a0`
"Zoom - Min FOV (degrees)", default 50, MP5SD 60) [recovered]:

- After the gun's own use (fire, kick), every tick while active:
  AlternateFire press toggles zoom. Zoomed: while tanX > tan(min/2) both
  tangents (world and gun layer) × 0.8. Unzoomed: while tanX < 1 both
  × 1.25, then clamped to 1 / tan(30°).
- Chopped products: 1 → 0.8 → 0.64 → **0.512** (stop, below tan 30° =
  0.577): the MP5SD zooms to **54.2°**, not the tag's 60°, in 3 ticks; the
  gun layer goes from 60° to 32.9° (the gun looks bigger); back: 0.64, 0.8,
  0.99999982, then 1 on the 4th tick.
- Inactive (reload, switch): both tangents reset and zoom off. The arms
  stay visible; no overlay.

**GunDRAGUNOV** (`FUN_00471500`, use `FUN_00471670`, tag `FUN_00471b50`
default 5, overlay `FUN_00471860`) [recovered; not in level 1's
loadout]:

- AlternateFire press: scope on (arms hidden, overlay snipersight); view
  stays 90° until zoomed. Scoped: AlternateFire press → scope off and FOV
  reset; AlternateFire held from the previous tick or ZoomIn held → both
  tangents × 0.96 while > tan(min/2) (90° → 4.94° in 77 ticks); ZoomOut →
  × 1.04 up to 90°.
- Scoped, the view kick is × 0.05 (f32 0x5315c0).

## 7. Camera and view effects (`FUN_00463840`, view object = arms)

**FOV** [recovered]: world tangent arms+0x1e4 (reset f32 fptan(π/4) = 1),
gun-layer tangent arms+0x1e8 (reset tan 30°); vertical tangent = 0.75 ×
horizontal (docs/rendering.md). The HumanCamera submits arms+0x1e4 and copies
+0x1e8 for the gun layer, so zoom also refines LOD (world/lod.ts reads the
camera FOV).

**Mouse look** [recovered `FUN_0045fd00`, `FUN_00463470`]: each step is
c × π × tanX (eased below |c| 0.06), so the look slows in proportion to the
zoom. Pitch averages c with the previous tick while unzoomed (0x46348a
compares float32 tangents). **Yaw is never averaged**: 0x45ff17 compares
the unrounded `fptan` result (1.0000000437) with the float32 tangent
(1.0), which never matches. (gameplay.md "Look" and E046 state averaging for
both.)

**Shake** `FUN_004645e0(arms, pos, angle, ticks)` [recovered]: amplitude
+0x1b4 = 1, +0x1b8 = pos (units), +0x1bc = angle (rad), step +0x1c0 =
f32(1 / ticks). Each update while the amplitude ≠ 0: pitch, roll, yaw +=
angle × amp × (2r − 1) (three level-RNG draws), eye right and up += pos ×
amp × (2r − 1) (two draws), then amp −= step (0 once negative). The
chopped step leaves a 6e-8 amplitude on the 16th tick: **16 ticks, 80 RNG
draws** for a 15-tick shake. Callers:

| Cause | pos, angle | Ticks | Source |
|---|---|---|---|
| bullet hit on the player | s × 204.8 units, s × 0.75° with s = clamp(r, 0.25, 1) (one draw after the hit speech) | 15 | `FUN_004123e0` 0x412518 |
| melee hit (punch) | same | 15 | `FUN_00412c80` 0x412e41 |
| explosion | s = 1 if e < 0 else 1 − e/(6R), e = d − 3R (d eye–blast distance, R blast record +0x0c), only s > 0 | blast record +0x14 | `FUN_00412930` |
| electric fence | 204.8 units, 0.75° | 45 | `FUN_00412f20` 0x412f69 |

**Landing dip** `FUN_00464620(arms, d)` [recovered]: `FUN_00408570`
0x408699 computes v = |vz| × 30/4096 m/s, d = clamp(v/8, 0, 1) × −1024
units (−0.25 m max) and resets the phase. Each update while d ≠ 0: eye up
+= d sin φ, arms up += 0.075 d sin φ, φ += f32 12°; d = 0 once φ ≥ f32 π.
**15 ticks** (φ = 0°, 12°, …, 168°): a jump landing (7.5 m/s, d = −960)
dips 0, −200, −390, −564, −713, −831, −913, −955, −955, … units.

**Kick** [recovered `FUN_00461a90`]: offset = (offset + kick) × 0.9 per
tick, applied only while an item is in the hand.

Not ported [recovered, effect small]: the eye collision ray that keeps the
shifted eye 204.8 units (0.05 m) from walls.

## 8. Other weapon handling (level 1)

- AlternateFire: MP5SD zoom (§6); Glock and knife none; M16A2 M203 and the
  mine in S1 (§2).
- Every gun starts with a full clip (`FUN_00476d60`: +0x144 = −2 →
  Rounds/Clip) [recovered].
- Spread draws only happen when the shot's spread is non-zero
  (`FUN_004772c0`): the knife and the Dragunov draw none [recovered].
- Peek lowers the weapon and blocks firing; S5 itself puts the movement
  machine into state 44 (lean), and 0x40f495 is the only write of 44 to
  `+0x2fc` (table slot +0xb0 is read only there): **leaning starts only from
  S1** (not while firing, reloading or switching) [recovered].

## 9. Open questions

- Which visit order the fade node uses (end flag during a fade) and the
  exact pose mix (slerp vs. normalised lerp).
- The blast record fields behind the explosion shake (+0x0c, +0x14).
- The scale from mouse counts to the look channel is in gameplay.md "Look".
- The Fire-channel write in S1's binocular branch has no traced reader.

## 10. Grenade (S7) and medipack (S10)

Port: `web-port/src/engine/combat/weapon.ts` (states 7, 14, 15 and 10, 16,
17), `combat/grenade.ts` (the thrown object, docs/damage.md "Thrown
grenades"), `combat/weapon-tags.ts` (tags); tests
`web-port/tests/grenade.test.ts` (real level-1 data).

### S7 grenade [recovered unless marked]

Level 1 gives the player hand grenades through three GunPickups
(WEAPON_ID_GRENADE: the first puts the weapon in the inventory with
Rounds/Clip = 1 round in the clip, the next ones add 1 to its pool) [observed
objects.qvm]. The pool is the DefineAmmoType whose calibre is the weapon's
Calibre ID: AMMO_ID_GRENADE (10000) [observed ammo/GRENADE/ammo.qvm]. The
grenade is a TASKTYPE_GUN whose projectile is TASKTYPE_GRENADE, Muzzle
Velocity 15, 50 rpm, no casing [observed weaponconfig.qvm].

- **Enter** `FUN_0040f620`: FireAnim1 (clip 24) with no loop and no blend
  (`FUN_004cc860` directly: the arms mode +0xd58 is not changed); pin flag
  +0x4d8 = 0, cook count +0x4e0 = 0, sound handle +0x4e4 = 0; +0x4dc =
  fistp(fuse × 30) (= 120) is written and never read.
- **Pin tick** `FUN_0040f6c0`, each tick: the arms trigger of the last view
  update (view +0x20c, set by `FUN_004c98b0` in `FUN_00463840`) equal to 4
  → pin out (+0x4d8 = 1) and `grenade_tick_1` started on the view
  (`FUN_004dd750(view, …)`, kept in +0x4e4); with the pin out the cook count
  + 1; clip-end flag and Fire released (+0x1c8 = 0) → FireAnim2 (clip 25,
  no loop, no blend) and the throw tick.
- **Throw tick** 0x40f770, each tick: cook count + 1; trigger 3 → fire
  request (+0x4d1 = 1) and the tick sound killed (`FUN_004dd850`); clip-end
  flag → StandAnim with **no loop** and no blend, the sway snapped to
  (−35°, −20°) (`FUN_00463410`) with target 0 at the S4 rates
  (`FUN_004633e0`), then (`FUN_004e9050` gives clip and pool): pool 0 (and
  no infinite-ammo cheat, DAT_0056a384) → `FUN_0040f890(human, 1)` (the next
  selectable weapon of the cycle becomes the request) and the tick becomes
  S4's lower tick `FUN_0040f380` (the state number stays 7): the empty arms
  rise for 11 ticks, then the new weapon is put in the hand with arms mode
  10 already at sway 0; else `FUN_004e8fd0` (the gun's reload method
  `FUN_00477fe0`: the clip refills from the pool at once, no ReloadAnim) and
  the tick becomes `FUN_0040fb50`: S1 once the sway is reached.
- **The throw** is the ordinary gun use of the same tick (`FUN_00461a90` →
  `FUN_00477ea0` → `FUN_004772c0`): for WEAPONTYPE 4 the use record's
  velocity is (pow(50 h, 0.7) + 0.1 h) × Muzzle Velocity × the view
  matrix's column 1 (forward), h = (float) cook count clamped to [3, 60]
  (doubles 0x531810 / 0x531490, ×50.0 0x5319a8, ^0.7 0x5319a0 through the CRT
  pow, ×0.1f 0x5313c8), in units per tick; the human's own velocity
  (+0x688) is replaced, not added. Spawn point = the eye (`FUN_00464470`).
  The gun then fires as usual: the Fire sound pick (RNG low bit), no
  spread draws (spread 0), `FUN_00413cd0` → the projectile's spawn method
  `FUN_004756c0` → `FUN_00475760` (docs/damage.md), no casing, cooldown 36
  ticks, the GUNSHOT AI event (silenced: 1 m) and the view kick (two RNG
  draws per try, kick 0).
- **Cooked ticks are never taken off the fuse**: `FUN_004756c0` asks the
  gun's owner (class Human) for them through method DAT_005c1768; the only
  registration is Human's 0x4feb90, which writes 0. Holding the grenade
  only makes the throw stronger; the fuse is always 4 s after the release.
- **Timeline** (tap, level-1 clips: FireAnim1 29 ticks with trigger 4 at
  3520, FireAnim2 18 ticks with trigger 3 at 960 [observed 005.iff]; ticks
  after S1's Fire tick): pin and tick sound at 22, FireAnim2 at 29, throw at
  35 with h = 14 (1492 units/tick = 10.9 m/s), FireAnim2 ended at 47, S1 at
  58. Holding Fire longer keeps FireAnim1 on its last frame and the count
  running: h = ticks from the pin to the release + 7.
- RNG draws (level RNG, in order): none in S7 itself; at the throw the
  Fire-sound low bit (audio) and the kick loop (≥ 2).

### S10 medipack [recovered unless marked]

Level 1 has a medipack GunPickup (WEAPON_ID_MEDIPACK, 3 rounds in its clip,
never used) and an AmmoPickup AMMO_ID_MEDIPACK with 50 rounds [observed].
WeaponConfig: TASKTYPE_MEDIPACK (class "Medipack" `FUN_0046efa0`: its use
and reload methods are the empty stub `FUN_00526660`), 220 rpm, tag "Factor
of human max damage to add for each round" 0.01 (`FUN_0046f100` → +0x6e4,
default 0.01) [observed weaponconfig.qvm; recovered].

- **Enter** `FUN_0040fc60`: FireAnim1 (78, no loop, no blend; its trigger
  1050 at 5600 plays `syringe` [observed 005.iff, animtrigger.qvm]), the
  round timer +0xd6c = 0.
- 0x40fcc0: clip-end flag → FireAnim2 (79) **looped**, no blend.
- 0x40fd10, each tick: Fire released → FireAnim3 (80, no loop) and the end
  tick `FUN_0040f5f0` (the rest of this tick still runs); timer ≠ 0 →
  timer − 1 and nothing else; no AMMO_ID_MEDIPACK record → nothing; pool ≠
  0 and damage (+0x254) ≠ 0 → pool − 1, damage = damage − max (+0x258) ×
  factor, stored as float, set to 0 below 0 and to max above it; timer =
  fistp(60 / rpm × 30) = 8. Else FireAnim3 and the end tick.
- `FUN_0040f5f0`: S1 when the clip ends (FireAnim3: 27 ticks).
- So a round heals 0.03 (max 3) every 9 ticks while Fire is held: 0.1 of
  health per second, the 50 rounds 1.5. It only reads the pool, never the
  clip; no sound besides the arms trigger. The HUD's health bar follows
  `ctx.player.health` (max − damage) at once.

