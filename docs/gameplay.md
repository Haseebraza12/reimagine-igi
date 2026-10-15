# Player movement, combat and detection rules

How `igi.exe` moves the player, fires weapons, applies damage and lets
soldiers see and hear. Every rule is labelled:

- **observed**: a value read from a game data file (file and method named);
- **recovered**: meaning or formula read from `igi.exe` code (function
  addresses given; Ghidra 12 decompilation of the analysed build, SHA-256
  `2b1673…74c2`, see E005);
- **inferred**: an interpretation the traced code does not prove.

`python tools/igi_gameplay.py` prints every value below with its source and
runs 115 self-checks: it verifies the quoted instruction bytes and constants
in `igi.exe`, and decodes the data files. The browser module is
`web-port/src/loaders/gameplay-params.ts`, tested by
`web-port/tests/gameplay-params.test.ts`.

## Time and units

- 4096 units = 1 m. [recovered]
- Game logic runs at a fixed **30 ticks per second**. [recovered]
  - `FUN_00414f80` calls `FUN_004c93d0(30.0)`. This sets the animation clock
    to 4800/30 animation ticks per game tick (4800.0 at `0x532af4`).
  - Every rate in the code is per tick. The debug line "Speed Z (m/s)" in
    `FUN_00410a30` converts with ×30/4096.
- Seconds become ticks as `FISTP(s × 30)`, which **truncates** (0.25 s →
  7 ticks; see "FPU rounding mode" below). [recovered]

## FPU rounding mode

igi.exe runs the x87 FPU in **chop** mode (round toward zero). Every
float → int conversion in game code therefore **truncates**. [recovered]

- `FUN_004966d0` (0x4966d0) does `fstcw [0x68b8dc]; or word [0x68b8dc],
  0xC00; fldcw [0x68b8dc]`. This sets rounding control to 11b (chop).
- WinMain calls it at 0x48db81. At the top of every message-loop pass
  (0x48dbc1) it first checks that `fld −1.75; fistp` gives −1.
  - Otherwise it prints "Invalid FPU rounding mode. May be caused by
    running a debug session with ftol optimize turned on." (0x53fc88) and
    hangs (0x48dcb8).
  - Then it calls `FUN_004966d0` again (0x48dbe9).
  - 0x4909ec and 0x4925c3 re-apply the mode after the DirectDraw/Direct3D
    set-up.
- DirectDraw is opened with DDSCL_FPUPRESERVE (SetCooperativeLevel flags
  0x1008 / 0x1011 at 0x491f72 / 0x492216), so Direct3D never leaves the
  mode changed.
- Precision control is not touched, so it keeps the Windows default of 53
  bits. Game code runs with control word 0xE7F.
- The build uses inline conversions ("ftol optimize"): every `(int)` cast is
  `fistp QWORD` followed by a read of the low dword.
  - There are 684 such sites and no `__ftol`.
  - So a value beyond int32 keeps its low 32 bits.
  - NaN and ±∞ give the integer indefinite, whose low dword is 0.
- The only explicit rounding:
  - the CRT `floor` (0x49c4be) and `ceil` (0x49caf0), called only at
    0x41f29b (menu slider, `floor(x + 0.5)`) and in the renderer at
    0x4971e6–0x497adb;
  - `+ 0.5` before `fistp` at 0x41f926 (slider step) and 0x4228f6 (menu).
  - These round half up and must stay that way when ported.
- The same mode also applies to arithmetic:
  - every x87 add / sub / mul / div rounds its 53-bit result toward zero;
  - every store to a float32 (`fstp DWORD`, including int → float32)
    truncates the mantissa.
  - This matters only when an exact result is a whole number that the FPU
    reaches inexactly. Example: 60 / 50 rpm × 30 = 36, but
    chop(chop(60/50) × 30) = 35.999… → 35 ticks.
  - It also matters when a float32 result is compared at a boundary.
    `Math.fround` rounds to nearest; `x87StoreF32` chops.
  - Example: the cut-scene clock t = float32(nTick / 30). For nTick = 66
    it chops to 2.1999998, below CutScene_1201's second key start (2.2f),
    so that key becomes current on tick 67, not 66.
  - mission.ts still uses `Math.fround` there. [inferred effect; not
    applied]

The port implements this in `web-port/src/loaders/x87.ts`:

- `x87Fistp` for conversions;
- `x87Add`, `x87Sub`, `x87Mul`, `x87Div` for chopped double operations;
- `x87StoreF32` and `x87F32Add` … `x87F32Div` for float32 stores.

The older helpers `fistp`, `x87Round`, `qvmRoundToInt` and `roundHalfEven`
now truncate as well; their names are historical.

Effects of the correction:

- Lean is 7 ticks, not 8.
- Weapon cooldowns change (see Weapons).
- Two mission 1 subtitles move one tick earlier (mission.md).
- HUD and sky colour bytes are truncated. 0.5 → 127, and sky ring channels
  are up to 1 lower.
- Half of the DirectSound volume table entries move 1 toward 0 (audio.md).
- The AI reaction delay is 6–11 ticks, not 6–12.

## `DefineHumanPlayerGeneral` (humanplayer.qvm)

Handler `FUN_00410160` (registered by `FUN_0040ff30`). It reads 43
arguments. Arguments 1–3 are multiplied by 4096000 × 1/108000 (km/h → units
per tick), arguments 4–5 by 4096 (m → units), and argument 6 by 30 then
FISTP (s → ticks). Values are observed; meanings recovered.

| Arg | Value | Meaning | Read by |
|---|---|---|---|
| 0 | 1.75 | Multiplies the **animation root-motion delta**: the player's displacement each tick. Not applied when flag `+0x52c` is set. | `FUN_00410a30` |
| 1 | 17.5 km/h = 4.86 m/s | Jump horizontal speed, along the normalised current move direction (0 when standing still), plus platform motion. | `FUN_0040bb80` |
| 2 | 27 km/h = 7.5 m/s | Jump vertical speed. Exactly 1024 units/tick, a value that only makes sense in km/h. | `FUN_0040bb80` |
| 3 | 0.5 km/h per tick = 4.17 m/s² | Air control: while airborne, Left/Right/Up/Down add ±this to the velocity each tick along the body axes. | `FUN_00408570` |
| 4 | 0.85 m | Peek + Left/Right: sideways camera offset. | `FUN_0040e0c0` |
| 5 | 0.85 m | Peek + Up while crouched: upward camera offset (looking over cover). | `FUN_0040e0c0` |
| 6 | 0.25 s → 7 ticks | Time to reach or leave a lean: FISTP(7.5) truncates to 7 (0x4101ff). Step = distance / 7 per tick. | `FUN_0040e0c0` |
| 7 | 3.0 | **Player maximum damage** (health capacity, `human+0x258`). | `FUN_00410460` |
| 8 | 0.5 | Electric-fence shock damage (× zone-13 multiplier), then a 45-tick cooldown and sound `elfence_spark1`. | `FUN_00412f20` |
| 9–25 | see Damage | Player hit-zone damage multipliers: table `0x536a50` → `human+0x264+8·zone`. | `FUN_00488050`, `FUN_00488250` |
| 26–42 | `0.5,0.75,1 ×4, 1,1,1, 100000, 100000` | Written to a second table at `0x536b60`. **No reader found**: the write loop is the only reference in `igi.exe`. | — |

The other humanplayer calls are recovered as follows:

- `DefineHumanPlayerWeaponCategory`: 9 groups mapped to keys 1–9 (`FUN_00410330`).
- `DefineHumanPlayerWeaponCycle`: the next/previous-weapon order (`LAB_004102b0`).
- `DefineHumanPlayerAmmoLimit`: the carry cap for each ammo type, applied by
  `FUN_00410460` → `FUN_0047b530`.

The script has **no** parameter for stamina, prone, swimming, eye height or
collision size (none of the 43 arguments reaches such code). [recovered]

## Movement

### Animation-driven speeds

Player speed comes from the animation, not from a constant.
[recovered: `FUN_00410a30`]

- Each tick, `FUN_004c9650` returns the root-bone delta of the playing
  animation blend.
- The delta is multiplied by 1.75 (arg 0) and rotated into the world.
- `FUN_004600f0` then integrates it, together with the jump/fall velocity,
  slope slide, knock-back and platform motion, and collides.

The player's animation for each movement direction comes from the table at
`0x5368c8` (`human+0x338`, `{anim id, flag}` per slot). [recovered]

Root speeds below are measured from `common/anims/000.iff` (skeleton/model
`000_01_1`, the HumanPlayer model). [observed]

- In each FORM BOAN, chunk BOAH holds f32 duration, u32 flags and u32 id.
  BOTD holds root keys of 10 f32: x, y, z, time, in-tangent, out-tangent.
  [layout inferred]
- Times are multiples of 160, which is one 30 Hz frame of the 4800 clock.
- Speed = horizontal distance from t=0 to t=duration, with keys
  interpolated linearly. [interpolation inferred]

| Slot = state (table index) | Anim id | Root speed | Player speed (×1.75) |
|---|---|---|---|
| run forward (1) | 4 | 3.36 m/s | **5.88 m/s** |
| run diagonals / back (2–6) | 37, 35, 64, 70, 68 | 2.74 | 4.80 |
| run strafe right / left (7/8) | 11 / 10 | 2.75 | 4.81 |
| walk forward (9) | 57 | 1.24 | **2.18** |
| walk diagonals / back (10–14) | 74, 72, 75, 77, 76 | 1.01 | 1.77 |
| walk strafe right / left (15/16) | 81 / 80 | 1.00 | 1.76 |
| crouch forward / fwd-diagonals / strafe (20–22, 26–27) | 17, 41, 39, 29, 28 | 1.59 | **2.79** |
| crouch back (+diagonals) (23–25) | 27, 49, 47 | 1.62 | 2.83 |
| crouch down / stand up (17/18, never entered) | 14 / 15 | (0.33 s, root drops 0.50 m) | — |
| stand / crouched (0 / 19) | 2 / 19 | 0 | 0 |

The labels are recovered from the state graph ("Player movement state
graph" below): the walking flag `human+0xd45` (constructor 0, flipped by
the ToggleWalkRun press edge after the graphs run) selects slots 9–16
instead of 1–8, and the input channel that enters each state gives its
direction (MoveUp = forward, MoveRight = right). [recovered]

### Jump, gravity, falling

All recovered, `FUN_00408570` / `FUN_0040bb80`:

- **Gravity**: `vz -= 84.7417 units/tick` every airborne tick (`0x5313f0`) =
  **18.62 m/s²**.
- **Jump**: vz = 7.5 m/s; horizontal speed as above.
  - Per tick (see "Movement integration"): no gravity on the jump tick,
    then vz −= 84.74 before each move. Apex 6,702 units = **1.64 m** above
    the take-off (plus the jump clip's own root z); touchdown 25 ticks after
    the jump, the landing is taken on tick 26.
- **Landing / fall damage**: v = |vz| in m/s at touchdown.
  - Damage = `max(0, v − 14) / 13 × maxDamage`. It starts at v = 14 m/s
    (about a 5.3 m drop) and kills from full health at v = 27 m/s (about
    19.6 m).
  - Sound: `player_fall_1` below 10 % of max, `player_fall_2` below 20 %,
    `player_fall_3` otherwise.
  - Camera dip = `min(1, v/8) × −1024` units.
  - Noise event GROUNDIMPACT: 5 m, or 10 m when the landing caused damage.

### Collision

All recovered, `FUN_004600f0`, `FUN_004606b0`, `FUN_00460fd0`:

- A human's position tracks its animated root (pelvis). Feet = position −
  root height (`FUN_00488760`).
- **Step / ground-snap distance**: 2048 units = **0.5 m** while grounded.
  It is 0 in the air and 2 m while sliding.
- Wall sweep probes at 0.1 m, 0.4 m and 1.8 m above the feet. Crouched:
  0.1 m, 0.2 m and 1.3 m.
- Roof flag when the ceiling is closer than 1.8 m.
- **No sweep radius**: three zero-radius rays against the HumanCollision
  hull (HSMC set 1), which lies about 0.2 m outside the walls
  (docs/collision.md §2, §4).
- **Slopes** (slope = 90° − elevation of the ground normal):
  - ≤ 45°: walkable.
  - 45–50°: add 18.96 units/tick² of slide.
  - 50–60°: add 56.89 units/tick².
  - 60–80°: slide at 948 units/tick.
  - over 80°: slide at 1137 units/tick.
  - The slide velocity decays ×0.9 per tick.
- Knock-back from hits: bullets 189.6 units/tick (1.39 m/s) along the
  horizontal shot direction; explosions 758.5 units/tick (5.6 m/s) times
  the horizontal part of the unit vector from the centre, only within
  (falloff + radius) × 1.5 ([damage.md](damage.md)). It decays ×0.9 per
  tick (`FUN_004123e0`, `FUN_00412930`).

### Movement integration

All recovered; port: `web-port/src/engine/world/character.ts` (shared by
the player and the soldiers) and `player/player.ts`.

- **Player tick** (`FUN_00410a30`): state machine (`FUN_004e2d60`) →
  root sample (`FUN_004c9650` into +0x514 / +0x520: the blend tree's root
  translation and its change since the last sample, i.e. up to the time the
  previous tick's advance reached) → change × arg 0 (1.75) rotated by the
  body matrix → advance (`FUN_00460010`: 160 animation ticks, the first
  event at +0x538) → `FUN_004600f0` → view, footsteps (`FUN_00462560`,
  after the move, from the ground record: the first event must be 1010 of
  the newest clip). A clip's play tick moves by 0 (its stored sample is its
  first key); during a 0.2 s blend the old clip keeps moving the body
  (docs/characters.md "Blending").
- **Move** (`FUN_004600f0`): slope slide from the last ground normal
  (slope = 90° − asin(n.z); > 80°: set n.xy × 1137, > 60°: × 948, > 50°:
  add × 56.89, > 45°: add × 18.96, else 0), slide and knock-back × 0.9,
  move = knock + slide + (air + root motion), sweep, ground probe with snap
  0 (air) / 2048 (grounded) / 8192 (sliding) units.
- **Sweep** (`FUN_004606b0`): per pass three rays from the old position
  along the move, length |move| + 10.24 units. Walls (|n.z| < 0.1,
  flattened) — nearest wins; grounded: only the 0.4 m and 1.8 m rays.
  Moving into the wall: end = hit + projection of (end − hit) on the wall
  plane + n × 10.24, repeat; after more than 10 passes x and y return to
  the start. Head-on, the re-swept ray ends exactly on the wall, so the
  slide repeats until that cancel: the body stops up to one move short.
  Airborne only: the 0.1 m ray on a floor with n.z > 0.9999 sets the end to
  the hit point + (root height − 409.6), the 1.8 m ray on any other non-wall
  surface caps the body under it (z = hit − (7372.8 − root height) − 10.24,
  vertical air speed 0, horizontal too unless the surface faces straight
  down).
- **Ground probe** (`FUN_00460fd0`): from 0.4 m (crouched 0.2 m) above the
  feet, 1000 m down and 2 m up (roof flag when root height + up distance
  < 7372.8); nothing below → 1000 m up. Grounded when feet − ground ≤ snap
  (always when the ground is above the feet: steps up to the ray start
  height are climbed).
- **Player states** (handler table `0x53660c`, clip slots `0x5368c8`):
  state 28 = jump (`FUN_0040bb80`): stance standing, slot 28 = clip 25
  played at 0.4× speed (`FUN_004ccc10`),
  air = unit(previous root delta.xy) × arg 1 + (0, 0, arg 2) + platform,
  ground released (`FUN_00461f10`), `jump_1`; state 29 = fall
  (`FUN_0040bec0`): stance standing, slot 29 = clip 2, air = previous root
  delta (x, y) + platform. Both then run `FUN_00408570` each tick (gravity,
  air control) and, once the move has set the grounded bit, take the
  landing on the next tick: fall damage, `player_fall_N`, the ground
  material's land sound, camera dip, GROUNDIMPACT noise; air velocity and
  knock-back are cleared. The full graph is in "Player movement state
  graph" below.
- **Knock-back** (`FUN_004123e0`): each bullet hit on the player adds the
  normalised shot direction's x, y × 189.63 units/tick (5 km/h).

### Player movement state graph

Recovered from the HumanPlayer constructor (0x41059c), `FUN_004e2d10`,
`FUN_004e2d60`, the pre-update `FUN_004106b0`, the 49 entries at `0x53660c`
and the ticks they install; every transition was checked against the
disassembly. Port: `web-port/src/engine/player/movement-graph.ts` (rules,
lean tick), `player/player.ts` (runs it), `player/body.ts` (clip start,
phase, speed); tests `web-port/tests/player-graph.test.ts`.

- **Graph object** `human+0x2ec` (same layout as the soldier's,
  docs/characters.md): +8 condition bits (`human+0x2f4`), +0xc previous
  state (`+0x2f8`), +0x10 state (`+0x2fc`), +0x14 tick (`+0x300`). The
  constructor passes initial state 0, so the first run only calls entry 0.
  A tick that switches state calls the new entry at once; the entry's tick
  first runs next game tick (one transition per tick).
- **Order** in `FUN_00410a30`: movement graph, weapon graph (`human+0xcf8`),
  then the ToggleWalkRun press edge (channel 20: `+0x200` set, `+0x160`
  clear) flips the walking flag `+0xd45` (constructor 0 = run). A toggle
  therefore changes the move state one tick later.
- **Condition bits** (`FUN_004106b0`): kept `& 0xfff7001c` (0x4 grounded and
  0x10 "Roof!" from the move, 0x20000 dead from `FUN_00408530` / the damage
  code), then 0x1 bone 0 finished, 0x2 blending, 0x40000 walking flag,
  0x20 MoveLeft (ch 2), 0x40 MoveRight (ch 3), 0x80 MoveUp (ch 4), 0x100
  MoveDown (ch 5), 0x200 Fire, 0x400 AlternateFire, 0x800 Reload, 0x1000
  Activate, **0x2000 Crouch (ch 10)**, 0x4000 Jump (ch 11), 0x80000
  NextWeapon. The channels hold the bound keys' held state (`FUN_0045cde0`
  from the action mask built at 0x4e3bb4 out of DirectInput key states): no
  input is a toggle, so **Crouch crouches only while held**.
- **Jump** is the press edge of ch 11 (`+0x1dc` set, `+0x13c` clear), read by
  the ticks of states 0–16 only: no jump while crouched (19–27), leaning or
  using the map computer.
- **Enter** functions write the low-profile flag `+0x33d`, play slot =
  state id (`FUN_00488290`, table `0x5368c8`) with blend 0.2 s
  (`0x3e4ccccd`), and set the arms mode wanted `+0xd5c` (`FUN_00413a00`:
  1 stand, 3 run, 2 walk, 4 crouched still / map computer, 5 crouched
  moving). "Phase" = the new clip starts at the old clip's stride phase
  (time = f32(newDuration × f32(oldTime / oldDuration)), `FUN_004ccbb0` →
  `FUN_004ccc40`) when the previous state is listed. `FUN_004cc860` always
  starts a new clip instance (the same clip restarts at 0); a blend under
  one update frees the clip tree and switches at once. The 0.2 s blend
  (6 updates) keeps the old clip playing: weight 1 on the play tick's root
  sample, then f32(1 − k/6) after the k-th advance, for the root change,
  the pelvis height and (slerp) the bone rotations alike; the 6th advance
  drops it without advancing it; a blend during a blend nests
  (docs/characters.md "Blending").
- **Combos**: the graph also matches two input sequences (0x536708: Fire
  press-release-press-release, 0x536738: NextWeapon twice, 6-tick windows)
  into graph +0x1c; nothing reads it for the player. (Earlier notes guessed
  0x536708 picked walk vs run: it does not.)
- Unused: `human+0xdc0` decays to 0 by 1/300 per tick in state 0's tick;
  only the constructor writes it (0).

Every ground state's tick first tests: not grounded → 29, hit (0x10000) →
46, dead (0x20000) → 47 (17/18: only not grounded). "J" = Jump edge, "C" =
Crouch held, "W" = walking flag, "stand up" = neither Crouch nor Roof.
Rules in order, first match wins.

| State | Enter | Slot clip | Blend | +0x33d | Mode | Phase from | Tick | Transitions (after the common tests) |
|---|---|---|---|---|---|---|---|---|
| 0 stand | 0x408880 | 2 | 0.2 | 0 | 1 | — | 0x4088c0 | !W: Up 1, Down 4, Right 7, Left 8; W: Up 9, Down 12, Right 15, Left 16; J 28; C 19 |
| 1 run fwd | 0x408b50 | 4 | 0 from 28, else 0.2 | 0 | 3 | — (computed, discarded) | 0x408bb0 | W 9; J 28; Right 2; Left 3; !Up 0; C 20 |
| 2 run fwd-right | 0x408d40 | 37 | 0.2 | 0 | 3 | — | 0x408d90 | W 10; J 28; !Up 7; !Right 1; C 21 |
| 3 run fwd-left | 0x408f00 | 35 | 0.2 | 0 | 3 | 1, 11, 22 | 0x408f80 | W 11; J 28; !Up 8; !Left 1; C 22 |
| 4 run back | 0x4090f0 | 64 | 0 from 28, else 0.2 | 0 | 3 | 5, 6, 12, 23 | 0x4091a0 | W 12; J 28; Right 5; Left 6; !Down 0; C 23 |
| 5 run back-right | 0x409330 | 70 | 0.2 | 0 | 3 | 4, 13, 24 | 0x4093b0 | W 13; J 28; !Down 7; !Right 4; C 24 |
| 6 run back-left | 0x409520 | 68 | 0.2 | 0 | 3 | 4, 14, 25 | 0x4095a0 | W 14; J 28; !Down 8; !Left 4; C 25 |
| 7 run right | 0x409710 | 11 | 0 from 28, else 0.2 | 0 | 3 | — | 0x409770 | W 15; J 28; !Right 0; Up 2; Down 5; C 26 |
| 8 run left | 0x409900 | 10 | 0 from 28, else 0.2 | 0 | 3 | — | 0x409960 | W 16; J 28; !Left 0; Up 3; Down 6; C 27 |
| 9 walk fwd | 0x409af0 | 57 | 0.2 | 0 | 2 | 1, 10, 11, 20 | 0x409b90 | !W 1; J 28; Right **2**; Left **3**; !Up 0; C 20 |
| 10 walk fwd-right | 0x409d20 | 74 | 0.2 | 0 | 2 | 2, 9, 21 | 0x409da0 | !W 2; J 28; !Up 15; !Right 9; C 21 |
| 11 walk fwd-left | 0x409f10 | 72 | 0.2 | 0 | 2 | 3, 9, 22 | 0x409f90 | !W 3; J 28; !Up 16; !Left 9; C 22 |
| 12 walk back | 0x40a100 | 75 | 0.2 | 0 | 2 | 4, 13, 14, 23 | 0x40a1a0 | !W 4; J 28; Right 13; Left 14; !Down 0; C 23 |
| 13 walk back-right | 0x40a330 | 77 | 0.2 | 0 | 2 | 5, 12, 24 | 0x40a3b0 | !W 5; J 28; !Down **7**; !Right 12; C **23** |
| 14 walk back-left | 0x40a520 | 76 | 0.2 | 0 | 2 | 6, 12, 25 | 0x40a5a0 | !W 6; J 28; !Down **15**; !Left 12; C **23** |
| 15 walk right | 0x40a710 | 81 | 0.2 | 0 | 2 | 26 | 0x40a780 | !W 7; J 28; !Right 0; Up 10; Down 13; C 26 |
| 16 walk left | 0x40a910 | 80 | 0.2 | 0 | 2 | 27 | 0x40a980 | !W 8; J 28; !Left 0; Up 11; Down 14; C 27 |
| 17 crouch down | 0x40ab10 | 14 (one shot) | 0.2 | 0 | — | — | 0x40ab40 | finished 19 (**never entered**) |
| 18 stand up | 0x40aba0 | 15 (one shot) | 0.2 | 0 | — | — | 0x40abd0 | finished 0 (**never entered**) |
| 19 crouched | 0x40ac30 | 19 | 0.2 | 1 | 4 | — | 0x40ac70 | Right 26; Left 27; stand up 0; Up 20; Down 23 |
| 20 crouch fwd | 0x40adc0 | 17 | 0.2 | 1 | 5 | 1 | 0x40ae30 | Right 21; Left 22; !Up 19; stand up → W ? 9 : 1 |
| 21 crouch fwd-right | 0x40af80 | 41 | 0.2 | 1 | 5 | 2, 20, 26 | 0x40b000 | !Right 20; !Up 26; stand up → W ? 10 : 2 |
| 22 crouch fwd-left | 0x40b130 | 39 | 0.2 | 1 | 5 | 3, 20, 27 | 0x40b1b0 | !Left 20; !Up 27; stand up → W ? 11 : 3 |
| 23 crouch back | 0x40b2e0 | 27 | 0.2 | 1 | 5 | 12 | 0x40b350 | Right 24; Left 25; !Down 19; stand up → W ? 12 : 4 |
| 24 crouch back-right | 0x40b4a0 | 49 | 0.2 | 1 | 5 | 5, 13, 23 | 0x40b520 | !Down 26; !Right 23; stand up → W ? 13 : 5 |
| 25 crouch back-left | 0x40b650 | 47 | 0.2 | 1 | 5 | 6, 14, 23 | 0x40b6d0 | !Down 27; !Left 23; stand up → W ? 14 : 6 |
| 26 crouch right | 0x40b800 | 29 | 0.2 | 1 | 5 | 7 | 0x40b870 | !Right 19; Up 21; Down 24; stand up → W ? 15 : 7 |
| 27 crouch left | 0x40b9c0 | 28 | 0.2 | 1 | 5 | 8 | 0x40ba30 | !Left 19; Up 22; Down 25; stand up → W ? 16 : 8 |
| 28 jump | 0x40bb80 | 25 at **0.4× speed** | 0 | 0 | — | — | 0x40bce0 | `FUN_00408570`; grounded: land sound, air 0 → W ? (Up 9, Down 12, Right 15, Left 16) : (1, 4, 7, 8), else 0 |
| 29 fall | 0x40bec0 | 2 | 0 | 0 | — | — | 0x40bf50 | `FUN_00408570`; grounded: land sound, air 0 → 0 |
| 30–36 use objects | 0x40bfe0 … 0x40d280 | own clips (89, 84, 90, 198, 189, task clip) | — | — | 0 | — | 0x40c260, 0x40c610, 0x40c980, 0x40cbe0, 0x40cdc0, 0x40d680 | lock pick, cabinet, terminal, stationary gun, ?, TBA, explosive (docs/interactions.md) |
| 37–43 attached | 0x40d760 … 0x40df90 | 168, 170 rev., 170, 169, 171, 172, 173 | 0 | 0 | 0 | — | 0x40d7b0 … 0x40dff0 | ladder, fence, wire (docs/interactions.md, docs/wire.md) |
| 44 lean | 0x40e070 | crouched: slot 19 (clip 19), else slot 44 (clip 2) | 0.2 | unchanged | — | — | 0x40e0c0 | none (left by the weapon S5 exit) |
| 45 map computer | 0x40e470 | 19 | 0.2 | **1** | 4 | — | 0x40e4c0 | MapComputer press (ch 32 edge) or dead: Computer destroyed, view locks off → dead ? 47 : 0 |
| 46 hit | 0x40e570 | hit-zone clip | 0.2 | 0 | 0 | — | 0x40e5d0 | dead 47; hit 46; finished 0 (no setter of 0x10000 on the player was found: unreachable) |
| 47 dead | 0x40e660 | the hit zone's record at 0x536a50 [rand(2)]: zones 0–13 clip 201 / 202, 14 → 215, 15 → 112, 16 → 204 (E113) | 0.2 | 0 | 0 | — | 0x40e720 | `player_death_{rand(3)}` after the clip draw; arms mode 0, holstered, view mode 5 (third-person orbit, body drawn); air velocity = +0x688; `FUN_00408570` (gravity; landing dip and GROUNDIMPACT noise while grounded); grounded: air / knock-back 0; grounded + finished: the hand item is released (a gun drops as a GunPickup, `FUN_004e9010`), weapon S1, dead hold 0x40e7e0 [ported] |
| 48 debug fly | 0x40e7f0 | 2 | 0.2 | 0 | — | — | 0x40e850 | toggled by ch 33 in `FUN_00410a30`; `FUN_0045cde0` writes 0 to ch 33: unreachable |

Consequences [recovered]:

- **Stance**: Crouch held → 19 (or the crouched move state) with a 0.2 s
  blend from the standing clip; released → stand/walk/run directly. The
  crouch-down / stand-up clips 14 / 15 never play. Standing up is refused
  while the "Roof!" flag is set (ground probe: ceiling within 1.8 m); state
  0 itself does not test the roof, so a state entered by a weapon hook
  (lean / map computer exit → 0) stands up and crouches again the next
  tick if needed.
- **Walk / run**: run is the default; the flag only matters when a state is
  (re)evaluated. Exe quirks kept by the port: walk forward + MoveRight /
  MoveLeft goes through the run diagonals 2 / 3 for one tick; walk
  back-right without MoveDown goes through run right 7; walk back-left
  without MoveDown goes to walk *right* 15 (then 0 / 16); walk back
  diagonals crouch into crouch back 23. The run states 1, 2, 7, 8 compute
  the stride phase and discard it.
- **No movement in 44 / 45**: their ticks never test grounded and play
  root-still clips; the air velocity is not touched (a lean started in the
  air keeps the take-off velocity without gravity until Peek is released).
- **Stopping and jumping through the blend** (000.iff, port tests): releasing
  MoveUp from a run slides 0.59–0.72 m (the run's full change on the stand
  tick, then 5/6 … 1/6). The jump plays with blend 0: the pelvis takes clip
  25's height (0.946 m) at once. Pressed 1–5 ticks after standing up from a
  crouch, the blended pelvis is still between the crouched 0.43 m and the
  standing 0.95 m, so the feet start inside the floor and the port's recovered sweep / ground probe land the
  jump on the next tick; 6 ticks after: apex 1.55 m; from 7: 1.64 m.
  [rules recovered; the outcome is the port's movement code]

**Lean** (state 44): weapon S5 (`FUN_0040f470`, entered from S1 while Peek
is held and a weapon is in the hand) sets arms mode 1, `FUN_00462250`
(`+0x7b8 = 1`: the use-target search stops), enters movement state 44, and
sets the arms sway target (−35°, −20°). The lean tick `FUN_0040e0c0` moves
the HumanView offsets (`human+0x4ec`), IGI units, float32:

- side `+0x19c`: MoveLeft held → toward −d, MoveRight held → toward +d
  (both: left then right, cancelling); the step `+0x1a8` = f32(d / ticks) is
  written only on the key's press edge; neither held → back toward 0, the
  step re-set when either was held last tick;
- up `+0x1a4`, only while `+0x33d` is set: MoveUp held → toward DAT_0056a36c,
  released → toward 0; its step `+0x1b0` is set on the press / release edge;
- each move stores f32(value ± step) and clamps by comparing the unrounded
  x87 sum: with d = 3481.6 units and 7 ticks the seventh step ends 0.00024
  units short and the eighth clamps;
- d = DAT_0056a368 = f32(arg 4 × 4096.0), up = DAT_0056a36c = f32(arg 5 ×
  4096.0), ticks = DAT_0056a370 = FISTP(arg 6 × 30.0) = 7 (`FUN_00410160`);
- the HumanView constructor `FUN_00462fe0` zeroes `+0x19c`…`+0x1b4`, so
  both steps start at 0: a strafe key already held when the first lean
  starts has no edge and the lean does not move until it is pressed again.
  Later leans reuse the last step.

S5's tick `FUN_0040f4f0`, Peek released: `FUN_00462260` (`+0x7b8 = 0`,
Activate latch `+0x7b9 = 1`), view `+0x19c`, `+0x1a0`, `+0x1a4` = 0 **at
once** (no easing back), movement state 0 (its enter: standing, clip 2),
sway target 0, weapon S1.

**Map computer** (state 45): weapon S1 (after the weapon request and the
Activate dispatch, binoculars not out) on a MapComputer press (ch 32:
`+0x230` set, `+0x190` clear) calls `FUN_00464650` (default FOV) and enters
S11 (`FUN_0040fea0`): movement state 45 at once, weapon inactive
(`+0x4d0 = 0`); its tick 0x40fef0 returns to S1 (active) once the movement
state is no longer 45. State 45's enter crouches the body (`+0x33d = 1`:
crouched eye 0.35 m above the pelvis, crouched probes; slot 45 = clip 19),
arms mode 4, view pitch input off (camera `+0x138 = 1`, `FUN_00463370`),
yaw input off (`+0x510 = 1`, `FUN_00462230`), and creates the Computer
(`FUN_0046aba0`). While the Computer exists `FUN_00410a30` skips the weapon
category and next/previous weapon keys (`FUN_00410fa0`, `FUN_0040f890`).

### Look (mouse and keys)

Recovered unless marked:

- **Mouse** (`FUN_0048e030`, DirectInput `DIMOUSESTATE2`, 20 bytes): each
  poll stores `lX × 1/255` and `lY × 1/255` (f64 0x532240, stored as
  float32) in 0xbcecc4 / 0xbcecc8.
- **Input port** (`FUN_004e3c41`): turn and look keys ramp an analogue value
  by fixed steps toward a limit (per-port tables at 0xb67df0…); the mouse
  value is added and the sum clamped to [−1, 1]: record +4 = turn, +8 =
  look up / down.
- **Yaw** (`FUN_0045fd00`, player and soldiers, each 30 Hz tick): `c` =
  turn channel (human+0x1b0); the smoothing branch `c = (c + previous
  tick's c) × 0.5` compares the extended fptan(π/4) result with the float
  tanX (0x45ff17), which never matches, so **the yaw is never smoothed**;
  `Δγ = −c·π·tanX`; when |c| < 0.06, `Δγ /= (2 − 16.667·|c|)`; γ += Δγ +
  platform rotation (+0x764).
- **Pitch** (`FUN_00463470`): the same rule on channel +0x1b4 with
  `+c·π·tanX`, clamped to ±π/2 (f32 0x5319c8 / 0x531468); a look-at target
  slews it at 3° per tick (0.05236 rad, 0x5317f4).
- **Zoom** (`FUN_00463470`): while the zoom-in input is held tanX × 0.96 per
  tick, zoom-out × 1.0416667 (f32 0x5319c4 / 0x5319c0); a third input resets
  tanX to tan(π/6) (f64 0x5319b8).
- **Mouse settings**: `GOInMouSens` (handler 0x4033a0) and `GOInMouInv`
  (0x403330) are stored per config slot. Invert [recovered]:
  `Config_GameOptionsInputSetInvertMouse` (`FUN_00403c20`) stores config
  +0x538 = (value == 0), and `FUN_0045cde0` (0x45ce64) negates the look
  channel when +0x538 is set. The shipped config.qvm has GOInMouInv 0, shown
  as "Invert Mouse: Yes" (the inverted look below); "No" negates the
  channel. Sensitivity [recovered]: `FUN_0045cde0` then multiplies both
  channels by clamp(config +0x53c, 0.05 (0x5315c0), 1.0) — GOInMouSens,
  shipped 0.4 — after the ±1 clamp; the third-person orbit of mode 3 reads
  these channels, the death camera (mode 5) the raw port values.
- **Signs**: the input-port record lands on the controller channels from
  human+0x1ac (record +4 = turn +0x1b0, +8 = look +0x1b4, +0xc / +0x10 =
  the left / right keys `FUN_00408570` reads at +0x1b8 / +0x1bc). A
  positive lX turns right (γ decreases; γ is counter-clockwise). The camera
  pitch α = body α (+0x4f8) + view pitch (+0x120), with the view matrix
  Rz(γ)·Rx(α) in body axes (x right, y forward, z up) at 0x463945, so a
  positive pitch looks up, and a positive lY (mouse moved toward the
  player) raises the view: **the look is inverted** while +0x538 is 0
  (the shipped default).
- **Timing**: `FUN_004e40e0` polls keyboard, mouse and joystick in the
  InputPort update, once per tick, so each tick gets all the motion since
  the previous one, and the view turns only on ticks.

Port: `web-port/src/engine/look.ts` (per tick, from game.ts; tests/look.test.ts).
game.ts applies the profile's invert field (menu "Invert Mouse");
`?look=normal` / `?look=inverted` override it (port option, not original).

## Health and damage

### Hit zones

Recovered, `FUN_00488080`. Each bone of skeleton 000 maps to a zone through
`int32[30]` at `0x53f148`:

| Bones | Zone |
|---|---|
| 0–3 | 12 (torso) |
| 4–7 | 16 (head/neck) |
| 8 / 9 / 10–13 | 11 / 10 / 9 |
| 14 / 15 / 16–19 | 5 / 4 / 3 |
| 20 / 21 / 22–24 | 8 / 7 / 6 |
| 25 / 26 / 27–29 | 2 / 1 / 0 |

So there are four limbs × (proximal, middle, distal) plus torso and head.
Which limb is left/right or arm/leg is not established.

Torso hits (zone 12) are refined by the direction toward the shooter in the
target's body frame:

- zone **13** (front) if it is ahead and |x| < y;
- zone **14** (back) if it is behind and |x| < |y|.

Any hit from the front whose impact is within 0.15 m (614.4 units,
`0x532220`) of bone 4 of `000_01_1` becomes zone **15** (head, front).

Multipliers per zone 0…16:

| Who | Limbs (distal, middle, proximal) | Torso 12–14 | Head 15–16 | Source |
|---|---|---|---|---|
| Player | 0.5, 0.75, 1 | 1 | **1** | humanplayer.qvm args 9–25, which override the exe default of 100 on the head [observed] |
| Soldiers (HumanSoldier, Pistol, RPG, Female) | 0.5, 0.75, 1 | 1 | **100** | tables `0x53d180`, `0x53ca98`, `0x53c748`, `0x53c4b8` [recovered] |

### Damage rules

All recovered.

- Every human accumulates damage in `human+0x254` and dies when it reaches
  `human+0x258` (its maximum).
- **Player maximum = 3.0** (arg 7).
- **Soldier maximum = settings.qvm "Damage scale"**. `FUN_00407080` copies
  config field `+0x2a0` to `human+0x258`.
  - GD_2: most soldiers 1.0, Mafia 1.2, Spetnaz 1.5, Anya 1.5, Ekk 2.5,
    Priboi 3.0.
  - The port's current use of "Damage scale" as a damage multiplier on the
    player is wrong.
- **Bullet damage** = weapon "Damage Factor" (WeaponConfig `+0x654`) × zone
  multiplier. It is copied unchanged into each gunshot and hit record
  (`FUN_00479870`, `FUN_00479e30`). **No distance fall-off, no
  calibre/ammo term.**
  - Player only: × difficulty factor 0.75 / 1 / 1.25 for GD_1 / GD_2 / GD_3
    (profile index 0/1/2; `FUN_004123e0`). `config.qvm` sets GD_2 → ×1.
  - Soldiers (`FUN_0045bfe0`): AI flag `+0x3ab8` makes the soldier immune,
    and AI flag `+0x3ab9` removes the ×100 on head zones.
  - Soldiers flinch (hit reaction, flag `0x10000`) when damage since the
    last flinch exceeds settings.qvm **"Recoil threshold"**, which
    `FUN_00407080` copies to `human+0xd04` (default 0.33).
  - Shotgun deaths use death type 1, others type 2.
- Examples:
  - AK47 (0.3) needs 10 torso hits to kill the player.
  - MP5SD (0.2) needs 5 torso hits on a 1.0 guard, 8 on Spetnaz. Any head
    hit kills.
  - A SPAS12 shot is 30 pellets × 0.25 each.
- **Explosions** (`FUN_00415b90`): e = distance − target radius − blast
  radius.
  - Damage = full factor if e < 0; factor × (falloff − e)/falloff if
    e < falloff; else 0.
  - Humans use target radius +0xa0 / 3 (f32 0x53152c), where +0xa0 is the
    body model's origin radius (HSEM +120, set with the bone model at
    `FUN_004cfda7`): 000_01_1 3882.7 → 0.32 m. Then × zone-13 multiplier;
    the player also × difficulty (`FUN_00412930`), soldiers get no
    TAKINGDAMAGE event (`FUN_004592a0`). [recovered; corrects "bounding
    radius"]
  - The player's knock-back applies only when the view is within
    (falloff + radius) × 1.5 of the centre, as the (x, y) of the unit 3D
    vector × 758.5; plus view shake, ear ringing and the four hit
    indicators ([damage.md](damage.md) §2 "Humans").
  - weaponconfig.qvm tags: Grenade radius 7 m, falloff 3 m, factor 1.
    Flashbang 10 m / 15 m / 1, but the flashbang path (`FUN_0047cd10`)
    deals no damage: it only flashes [recovered `FUN_004751f0`].
  - Damage sums store as chopped float32: five 0.2 rounds sum to
    0.99999996, so objects with limit 1 take six ([damage.md](damage.md) §1).
  - Objects (glass, barrels, computers, terminals, cameras): [damage.md](damage.md).
- **Melee on the player** (`FUN_00412c80`): zone 13 (front) or 14 (back) ×
  attacker damage × difficulty; sound `punched_01/02`.
- **Medipack** (player state `0x40fd10`): while Fire is held, each weapon
  cooldown it consumes 1 medipack round.
  - Each round removes `maxDamage × 0.01` of damage, clamped to [0, max].
    That is 1 % of health per round, every 8 ticks (220 rpm → 3.75
    rounds/s).
  - The factor is the "Factor of human max damage to add for each round"
    tag (0.01, default 0.01, `FUN_0046f100`).

## Weapons

`weapons/weaponconfig.qvm` overrides `weapons/*/weapon.qvm`. [recovered]

- `FUN_004020b0` loads all `weapon.qsc` files first (`FUN_00413b10`), then
  `weaponconfig.qsc` (`FUN_004072f0`).
- Each WeaponConfig task's handler `FUN_00407cf0` copies its 0x6e8-byte
  record over the weapon record with the same Weapon ID. Only the two
  task-type extension pointers are kept.
- So the port is right to read weaponconfig.qvm. For example MP5SD damage is
  0.2, not weapon.qvm's 0.15, and the Dragunov is *silenced* for AI hearing.

Gun behaviour (all recovered, `FUN_004772c0` fire, `FUN_00477ea0` after-fire,
`FUN_00477fe0` reload):

- **Rate of fire**: after a shot the gun cannot fire for
  `FISTP(60/rpm × 30)` ticks (0x477d6d: `fild rpm; fdivr 60.0; fmul 30.0;
  fistp`).
  - Every step is chopped (see "FPU rounding mode"), so the result is
    trunc(1800 / rpm).
  - Exception: when 1800 / rpm is a whole number but 60 / rpm is not exact
    in binary, the result is one less.
  - MP5SD 700, AK47 650, Uzi 680: 2 ticks (900 rpm effective).
  - M16A2 500: 3 ticks (600 rpm).
  - Glock 400: 4 ticks (450 rpm). Desert Eagle 250: 7.
  - UziX2 1200 and Sentry 1000: 1 tick. Minimi and M2HB 800: 2.
  - Dragunov, grenade, flashbang and binoculars (50 rpm): 35 ticks, not
    36, because 60/50 = 1.2 is inexact.
  - Knife 150: 11, not 12.
  - Exact cases: Colt 60 → 30, SPAS12 and RPG18 40 → 45, T80 and APC 12 →
    150.
- **Bursts / semi-auto**: shots counted while the trigger is held stop at
  "Maximum Rounds/Burst". The trigger must be released to fire again, so 1
  means semi-automatic.
- **Spread** (degrees, max deviation from the aim axis):
  - The first 4 shots of a trigger hold use "Minimum random spread"; later
    shots use "Maximum random spread". The absolute value is used.
  - Each pellet ("Bullets/Round") deviates by `r1·r2·r3 × spread` at
    azimuth `r4 × 2π`. The cube of uniform randoms concentrates hits at the
    centre: median 12.5 % of the maximum.
  - Direction [recovered, E102]: D = frame(aim)·Ry(b)·Rx(a) (FUN_004a9bc0),
    the bullet flies along D's y column, so dir = cos a·aim + sin a·(sin b·x
    + cos b·z) with FUN_00486a60's x (aim × Z, horizontal) and z (x × aim).
    Azimuth 0 tilts the shot up and π/2 to the right. No draws while the
    spread is 0 (knife, Dragunov). The player and the soldiers share this gun
    code and the level RNG (`web-port/src/engine/combat/pellet.ts`).
  - **Movement and crouching do not change spread** in this code path.
  - The port's "×0.15° units" is wrong: values are plain degrees.
- **Recoil (view kick)** per shot: pitch = fixedX + randomX·u and yaw =
  fixedZ + randomZ·v, with (u, v) uniform in the unit disk; degrees.
  - `FUN_00461a90` adds the kick to a camera offset that decays ×0.9 per
    tick, so the view returns by itself (half-life ≈ 6.6 ticks = 0.22 s).
  - Whether the offset also bends the next shot's aim is inferred (the aim
    matrix comes from the same camera object).
- **Range**: each bullet is an instant ray (no travel time) of "Effective
  Range of Weapon" metres (× 4096, `FUN_00479870`).
- **Penetration** (`FUN_00479e30`), comparing weapon "Penetration Power"
  with the material hardness (material.qvm arg 1):
  - difference ≥ 1: passes;
  - equal: 60 % chance;
  - otherwise the bullet stops.
  - Only surfaces belonging to a task (objects/buildings) can be passed.
  - Once the bullet has left a solid through a back face, the next front
    hit always stops it (`local_694`, 0x47a4b0), so a bullet passes at most
    one object or body. The "10" is the number of impact effects recorded
    per bullet, not a count of humans passed.
  - Each pass subtracts the hit distance from the remaining range and
    restarts 20.48 units (5 mm, 0x532130) past the hit point.
- **Ricochet**: once per bullet, with chance `(A − (90° − i))/A` (A =
  material ricochet angle, material.qvm arg 2; i = angle between the
  reversed ray and the face normal, so grazing hits ricochet). The
  direction is mirrored about the normal and the trace continues from the
  hit point (`riccochet_1..4` with its own limiter). The roll is drawn for
  every front hit until the bullet has ricocheted, even when A = 0.
- **Reload** (`FUN_00477fe0`): moves `min(clip − loaded, pool)` rounds from
  the ammo pool, so partial clips are kept.
  - **"Reload Time" is never read**: no instruction reads offset `+0x65c` or
    its absolute form. Reload length is therefore animation-driven
    [inferred].
  - Weapon-switch time: no parameter found.
- **Zoom** (weaponconfig TagItem children) [observed]:
  - MP5SD "Zoom – Min FOV" 60°;
  - Dragunov 5°;
  - Binoculars min 5°, max 90°, default 70°.
- **Grenade throw speed** (`FUN_00461a90`): `(pow(50h, 0.7) + 0.1h) × Muzzle
  Velocity` with h = hold ticks clamped to 3…60. For the hand grenade that
  is 3.7 → 30.5 m/s: the value is copied into the grenade body's velocity
  (+0x108, units/tick) by `FUN_00475760` [recovered]. h counts from the pin
  (arms trigger 4) to the throw (trigger 3); the fuse is always the full 4 s
  (docs/weapons-view.md §10, docs/damage.md "Thrown grenades").

### Player weapon handling (state machine, knife, binoculars, zoom)

Full derivation in [weapons-view.md](weapons-view.md); summary, all
recovered unless marked:

- The weapon state machine at `human+0xcf8` (table `0x5366d0`) decides when
  the player fires, reloads, switches and stabs. A shot comes one tick after
  S1 sees Fire; **reload length = the ReloadAnim clip** (rounds move one
  tick after its last frame; MP5SD 100 ticks, Glock 80) — this settles the
  "[inferred]" above.
- **Weapon switch**: no parameter — the arms sway down to (−35°, −20°) in 11
  ticks, the weapon changes, 11 ticks back up; usable 22 ticks after the
  request.
- The mission starts with an empty hand; the first player tick selects the
  first carried weapon of DefineHumanPlayerWeaponCycle: **the knife** in
  level 1.
- **Knife**: fired by the gun code (cooldown 11 ticks, burst 1), its
  projectile KnifeStab casts three 2 m rays (15° right, 5° right, 5° left);
  damage 0.1 × zone, or **1000 × zone on a soldier with no combat target**;
  `stab_01` on survived hits.
- **Binoculars**: the Binoculars key swaps them in at once (70°, arms
  hidden); ZoomIn / ZoomOut × 0.96 / × 1.04 per tick between 5° and 90°;
  AlternateFire held zooms, clicked again resets to 70°; no firing,
  reloading or switching while they are out; RANGE = 1000 m ray.
- **Zoom**: MP5SD (GunMP5SD) toggles with AlternateFire, both FOV
  tangents × 0.8 per tick down to the tag (reaches 54.2°, not 60°);
  Dragunov (GunDRAGUNOV) scope with arms hidden, × 0.96 / × 1.04, kick ×
  0.05. The player's ZoomIn / ZoomOut never reach the generic camera zoom
  of `FUN_00463470` (channels 16–18 are always 0 for the player).
- **View effects**: bullet / melee hit shake clamp(r, 0.25, 1) × (204.8
  units, 0.75°) over 15 ticks (5 RNG draws per tick); landing dip
  min(1, v/8) × −1024 units as d·sin(12°·k) over 15 ticks.
- Yaw is never averaged with the previous tick (0x45ff17 compares the
  unrounded fptan with the float32 tangent); pitch is, while unzoomed.

## AI combat (settings.qvm `HumanAIConfigItem`)

Field offsets are recovered from the schema in `FUN_00406550`. The copy into
the AI is `FUN_00407080`. The configured difficulty comes from `GOGameDiff`
(GD_1/2/3 = index 0/1/2, registered at `0x40307e`).

- **Hit probability** (`FUN_00489de0`): at the start of each fire sequence,
  p is linear in the AI-to-target distance d.
  - `p = pMin + min(d, L)/L × (pMax − pMin)`, where L is the soldier's
    normal **view length** (`AI+0xb0`, `SetViewLength`, metres).
  - So "minimum range" = 0 m and "maximum range" = the view length; beyond
    it, p = pMax.
  - An internal combat flag halves p (condition not traced). Grenades use
    p = 1.
- **How p is used** (`FUN_0045d100`, the human ray filter): when an AI
  bullet's ray reaches the **player**, it registers only if
  `rand ≤ p`. Otherwise it passes through as if missed.
  - The AI still aims (see aim precision) and the weapon spread still
    applies.
  - Bullets never hit humans of the shooter's own team.
  - The player's own p is 1.
- **Aim precision** (`FUN_0048bd00`): each fire update the aim point moves
  `aimPrecision ×` its remaining distance toward the target.
- **Rounds per sequence**: for weapons whose burst equals the clip or is
  below 2, `FISTP(clip × float32(minClip + rand × randomClip))`
  (truncated, 0x489ec8), clamped to [1, "Max Number Of Rounds per
  sequence"]. Otherwise the weapon burst is used.
- **Delay between single shots** (burst-1 weapons): `FISTP((minShot + rand
  × randomShot) × 30)` ticks, truncated (0x48beb6).
- **Delay between sequences**: computed as `FISTP(min + rand × random)`
  (truncated) **without** the ×30 (`FUN_0048b4a0`, 0x48b60e, AI+0x3dcc).
  No reader of that field was found, so the effect is unresolved.
- **Targeting timeout**: FISTP(s × 30) ticks, truncated (0x407100). Tracking and lie-down
  distances are × 4096. Close combat probability and damage are copied
  unconverted.

## Detection

### Vision

All recovered, `FUN_0044e330` → `FUN_00487b70` → `FUN_00487cf0` →
`FUN_00487d80` / `FUN_00487f40`.

The script setters (`FUN_0044ca80`, `FUN_0044cb10`, `FUN_0044cb70`,
`FUN_0044cbd0`):

- `AIFunction_SetViewLength(m)`: `AI+0xb0 = m × 4096`. It also raises the
  alarm length to at least this.
- `AIFunction_SetAlarmViewLength(m)`: `AI+0xb8`.
- `AIFunction_SetViewAlpha(deg)`: `AI+0xa0 = deg × π/180`.
- `AIFunction_SetViewGamma(deg)`: `AI+0xa8`.
- The `SetSecondary*` versions fill a second cone (`+0xc0…+0xd8`).

The check is made in the soldier's **eye frame**: the model eye offset and
eye matrix, with x right, y forward, z up. A target is in the cone when:

- the 3D distance is ≤ the view length (the **alarm** length while the
  soldier's alarm is on or it has a combat target);
- **|vertical angle| < alpha**, where the vertical angle is
  acos(y/√(y²+z²));
- **|horizontal angle| < gamma**, where the horizontal angle is
  acos(y/√(x²+y²)).

So alpha and gamma are **half-angles**, with **alpha vertical and gamma
horizontal**. The port currently has them the other way round.

- Guards/patrols: 40 m (50 m alarmed), ±50° vertical, ±45° horizontal.
- Snipers: 100 m (110 m alarmed), ±30° vertical, ±15° horizontal.
- `level1/ai/2209.qvm` sets 20 m.

The x-right/z-up axis convention of the eye matrix is supported but not
proven. The body matrix uses those columns (movement code), and the sign
conventions in `FUN_004868f0`/`FUN_00486950` match.

The target point is the human's position + 0.69 m standing or + 0.35 m
crouched (`FUN_00464490`). The position tracks the pelvis, so this is about
1.62 m / 0.78 m above the feet.

Line of sight is a ray from eye to target point. It counts as clear if
nothing is hit, or if the obstruction is at ≥ 0.79 of the distance
(fraction meaning inferred).

Timing:

- Each detector runs on 1 of every 4 ticks (staggered).
- The cone test repeats every 8 ticks; the line-of-sight ray every 12 ticks
  while in the cone.
- Then `AIEVENT_ENEMYDETECTION` is sent every AI update. There is **no
  gradual detection time** for soldiers: `nDetectionTime` belongs to
  security cameras (`SCamera`, `FUN_00440190`).
- Dead teammates in view raise `AIEVENT_FRIENDLYDETECTION`.
- **No lighting term and no stance term** exist in this path. Crouching
  only lowers the target point and silences footsteps.

### Hearing

All recovered. `FUN_0044fab0` broadcasts each event to every AI;
`FUN_0044eee0` filters it.

The event record is `{type, source team, flags, range (units), position,
source}`. Flag bits:

| Bit | Meaning |
|---|---|
| 2 | distance ≤ range (3D) |
| 1 | line of sight |
| 4 | source must be a human |
| 0x40 | listener of another team |
| 0x20 | same team |
| 8 / 0x10 | source alive / dead |

The AI symbol table is registered in `FUN_0044dd00`.

| Event (id) | Range | Who hears | Raised by |
|---|---|---|---|
| WALK (10) | ground material **footstep range** (material.qvm arg 5: 1 m on most surfaces, **10 m on gravel**, 0 on textiles/air). **Not raised while crouched.** | enemies | footstep sound trigger, `FUN_00462560` |
| GROUNDIMPACT (11) | 5 m; 10 m with fall damage | enemies | `FUN_00408570` |
| DOOR (12) | 5 m | enemies | `FUN_0040c370` |
| FENCE (13) | 5 m | enemies | fence climb, `FUN_00411710` |
| LADDER (14) | 5 m | enemies | ladder states (`0x40d8b0`, `0x40daf3`, `0x40dc53`) |
| GUNSHOT (16) | `HUMANAI_DETECTIONEVENT_GUNSHOT_RANGE` = 0x1e000 = **30 m**; `_SILENCED_RANGE` = 0x1000 = **1 m** | enemies | every shot, `FUN_00477ea0` |
| GRENADELAND (18) | 5 m | anyone | `FUN_00475470` |
| FLASHBANG (19) | 10 m, needs line of sight | anyone | `0x47cc92` |
| GUNSHOTMISS (20) | 2 m around the bullet impact | enemies of the shooter | `0x45f443` |
| ALERT (5) | 7 m | the soldier's teammates | `FUN_00488f30` |

The weaponconfig ranges are:

- **Silenced (1 m)**: MP5SD, Dragunov, knife, grenade, flashbang, proximity
  mine.
- **30 m**: all others.

The port's 70 m / 8 m are wrong. The ranges stored for the symbols are
units, and only whole-metre readings (30, 1) are consistent with the
4096-unit metre.

## Open questions

- Collision radius of the player/soldiers.
- First-person eye height: it comes from the model eye offset
  (`model+0x2ac`), which was not decoded.
- Speeds in "Animation-driven speeds" use linear key interpolation; the
  exe's Hermite sampler and blend tree (`FUN_004c96c0`, docs/characters.md
  "Blending") are what the port runs.
- The reader of the second 17-value table (`0x536b60`, values up to 100000).
  None was found.
- The AI sequence-delay unit (AI+0x3dcc), and the condition that halves the
  AI hit probability.
- Whether the recoil camera offset changes the aim of the next bullet.
- Reload and weapon-switch durations (animation-driven; animation lengths
  not mapped to weapons).
