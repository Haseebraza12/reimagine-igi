# Mission task runtime, cut-scenes and mission flow

This document describes how `igi.exe` runs a level's `objects.qvm` tasks at
run time: the per-tick update order, what every level-1 task type does each
tick, the members it publishes to task conditions, the cut-scene system, and
the mission flow from load to "complete" or "failed".

- Implementation: `web-port/src/loaders/mission.ts` (`readMissionTasks`,
  `MissionRuntime`, `sampleCutSceneCamera`, `stepDoor`, `areaContains`, ...).
- Python reference with self-checks: `tools/igi_mission.py` (stdlib only).
- Tests: `web-port/tests/mission.test.ts`.
- Related: [qvm-vm.md](qvm-vm.md) (condition language), [hud.md](hud.md)
  (message drawing, menus), [audio.md](audio.md) (sound playback),
  [rendering.md](rendering.md) (camera/FOV), [characters.md](characters.md)
  (animations), [gameplay.md](gameplay.md) (vision, damage).

Evidence labels:

- **[recovered]**: read from `igi.exe` code; function addresses are Ghidra
  `FUN_`/`LAB_` names, image base 0x400000.
- **[observed]**: measured on the shipped files (`tools/igi_mission.py`).
- **[inferred]**: reasoning only.

Input identity (SHA-256):

| File | SHA-256 |
| --- | --- |
| `igi.exe` | `2b1673443e2635d97787344da5fab9d1ac6b717d34d18c5bab7f30749b1174c2` |
| `missions/location0/level1/objects.qvm` | `8c16ff3eb6251e2d3b7e16b07ce6b71b9ea4f54e8a17fcd866fc58bb44ed85cd` |

## 1. The task object model

**Classes** [recovered]. Every task type is a class registered with
`FUN_00401940(name, size, parentClass)`, which copies the parent's handlers.
Handlers live in a table at 0xa3c820 with 0x180 entries per message:

| Message | Meaning | Getter |
| --- | --- | --- |
| slot 0 | create (defaults) | — |
| slot 1 | per-tick update (table 0xa3ce20) | — |
| slot 2 | destroy | — |
| `DAT_0054a16c` | return the parameter schema (Task_New) | `FUN_004e8710` |
| `DAT_0054a16d` | compile: compile conditions, capture link poses, rewind AnimTasks | `FUN_004e8720` |
| `DAT_00549e30` / `e34` | register / unregister members (ids >= 0 only) | `FUN_004e7eb0` / `FUN_004e7ec0` |
| `DAT_00549e38` | parameters set | `FUN_004e7ed0` |
| 0x545f5f / 0x545f5e | remove from / add to the world | `FUN_004c4c40` / `FUN_004c4c30` |
| `DAT_0054a262..268` | AnimTask messages (input step = 0x54a262) | `FUN_004ead50`... |
| 7 | get transform (used by camera link / target) | — |

**Loading** [recovered]. `FUN_004e79e0` runs `objects.qsc` with the
`Task_New` context set to the Level root. `Task_New` (`FUN_004e7420`)
creates each task (slot 0), reads its parameters per schema, registers its
members if its id is >= 0, then evaluates its children (pre-order). After the
script, the "compile" message is broadcast once over the whole tree in
pre-order (`FUN_00401dc0`). The level frequency is 30 (`FUN_004e7ab0(...,
0x1e)` at 0x415063; root +0x2c = 30, +0x30 = 33 ms). The cut-scene clock is
also set to 30 (`FUN_004ed1a0(0x1e)` at 0x415048).

**Children** [recovered]. A task's children are an Exec-style list
(`AddTail`, `FUN_004a5d50`), so siblings keep file order. Children are walked
through a stack (`DAT_00aa0420`) that tolerates deletion during the walk
(`FUN_00401630`).

**No scheduler** [recovered]. Nothing iterates all tasks. Each frame the Game
task (`FUN_00415306`) first checks `LevelFlow.isComplete`; if false and the
game is not paused (+0xe0), it updates its children, among them the Level
root. The Level root's update (`LAB_004e7100`) updates its children in order
and then advances the level clock (+0x24 ms += 33, +0x28 tick += 1). **Every
task type decides whether, and before or after its own logic, it updates its
children.** The per-type rule is in the table of section 2.

| Type | Update (slot 1) | Children |
| --- | --- | --- |
| Level root | `LAB_004e7100` | all, then tick++ |
| Static | `FUN_00526660` (empty) | **never** |
| Dynamic | `LAB_004e7300` | all, unless 0x805fa5 (editor freeze, always 0) |
| Container, EditCamera, CameraBase | `LAB_004fc9f0` | all |
| ConditionalContainer | `FUN_00485450` | only while running (and once on the stop tick) |
| LevelTimer | `FUN_00515bb0` | **before** its own logic |
| CutScene | `FUN_004ebe30` | before (its EditCameras do nothing) |
| AreaActivate | `FUN_004fb540` | **after** computing nActive |
| Door, Switch, SCamera, ExplodeObject, Terminal family | see below | before |
| Train `FUN_0042aa90`, Heli `FUN_00430950`, Car `FUN_0042d5c0` | own expressions / effects first | after (the AnimTask) |
| LevelFlow | `LAB_004876b0` | before |
| Building, EditRigidObj | inherited (base class not traced) | assumed all [inferred] |

So the global update order is the tree's pre-order, except that a task's own
logic runs before or after its children as listed. In level 1 the top level
is `Container 'EnvironmentalEffects'` (#0), `Static` (#12, never updated),
`Dynamic` (#465), `LevelFlow_10` (#1361, last).

## 2. Per-type run-time behaviour

All conditions are compiled once at load (`FUN_004e80a0` rewrite +
`FUN_004ae920`) and evaluated in float mode (`FUN_004e8380`) at the point
shown. "Absent" = empty text or compile failure (`FUN_004e8360` false): the
field is then skipped. `byte(x)` = `(char)fistp(x)`: the exe stores most
flags as the low byte of the truncated value (the FPU runs in chop mode, see
[gameplay.md](gameplay.md) "FPU rounding mode": every `fistp` truncates toward
zero, and the evaluator's `+ − × ÷` on doubles round toward zero too). Ticks
are 30 Hz.

### AreaActivate (8 in level 1) [recovered]

- Parameters: Position (doubles), Orientation (Real32x9), **Dimensions =
  full box size** (half extents = Dimensions × 0.5, constant 0x531508,
  `FUN_004fb290`), Criteria.
- Compile (`FUN_004fb290`): `mask = int-eval(Criteria)` (`FUN_004ae9b0`);
  half extents; world AABB of the rotated box (+0x20/+0x38, a pre-filter).
- Update (`FUN_004fb540`): `nActive = 0`; for every set criteria bit, call
  the bit's callback, which adds the number of matching actors inside; then
  update children.
- Criteria (registered by `FUN_004fb6d0`): `CRITERIA_HUMAN` = every human
  (`LAB_0045f6e0`), `CRITERIA_HUMAN0..7` = humans whose team (+0xfc) is k
  (`LAB_0045f680`), `CRITERIA_VEHICLE` (`FUN_004eae10`). The human callbacks
  walk the global human list `DAT_005c115c` and have **no alive test**.
- Inside test (`FUN_004faf50`): `local = Rᵀ (p − Position)`; inside when
  `−half ≤ local ≤ half` on each axis (boundaries count). `p` is the human's
  origin (+0x20), which [gameplay.md](gameplay.md) puts at the pelvis.
- Member: `nActive` (int, `LAB_004fb1d0`).
- Level 1: all eight have identity orientation. Only 200 (truck), 303, 304,
  305 are referenced; 300, 301, 302 and 306 (`CRITERIA_HUMAN1`) are unused.
  [observed]

| Area | Centre (units) | Full size (m) | Criteria | Used by |
| --- | --- | --- | --- | --- |
| 200 | 24956964, −56099004, 174417760 | 4.58 × 2.56 × 2.44 | HUMAN0 | EditVariable_105 (objective), EditVariable_199 (outro) |
| 303 | 24582346, −56146488, 174417888 | 2.86 × 10.47 × 2.44 | HUMAN0 | StatusMessage_1395 (locked gates) |
| 304 | 24603260, −56314048, 174417840 | 23.4 × 23.5 × 2.44 | HUMAN0 | StatusMessage_1394 (climb fence) |
| 305 | 24854760, −56331872, 174417552 | 2.44 cube | HUMAN0 | StatusMessage_1393 (truck hint) |

### StatusMessage (23) [recovered `FUN_00483690`]

```
now = LevelFlow.nTick                     (DAT_00b680a0 + 0x68)
if ((!sendOnce || !isSendt || instant) && nTickSendt + 210 < now):
    if instant && isSendt: delete the task
    if Send present (or instant):
        if !instant && eval(Send) == 0.0: return      # no rounding
        create the on-screen message (FUN_004850f0, FUN_004845c0)
        isSendt = 1; nTickSendt = now
```

- Create: `nTickSendt = −100000`, `isSendt = 0` (`LAB_00483630`).
  Members: `isSendt` (char), `nTickSendt` (int) (`FUN_00483800`).
- A message with "Is send once" = FALSE re-sends at most every 210 ticks
  while its condition holds (level 1: CAMERASOFFLINE_*, whose `==` tests make
  them one-shot per hack anyway).
- Drawing, slots, typing and sounds: [hud.md](hud.md) §5.

### EditVariable (4) [recovered `FUN_004866f0`]

`nValue += fistp(eval(Add))` then `nValue −= fistp(eval(Sub))` (truncated,
0x4ebeb3 / 0x4ebedb), each when present. "Initial value" is written straight into nValue (+0xd8). Member
`nValue` (int).

### LevelTimer (3) [recovered `FUN_00515bb0`]

Update children; `isRun = byte(eval(On))` if present; if Reset present and
`eval(Reset) != 0.0`: `nTick = 0`; then `if isRun: nTick += 1`. "Initial run"
is the initial isRun. Members `isRun` (char), `nTick` (int). The first tick
on which On is true ends with nTick = 1.

### ConditionalContainer (8) [recovered `FUN_00485450`]

```
prev = isRun
if Condition present: isRun = byte(eval(Condition))
if !isRun && !prev:
    if inWorld: send "remove from world" to each child (recursive); inWorld = 0
else:                                   # running, or the tick it stopped
    if !inWorld: send "add to world" to each child; inWorld = 1
    update children
if isRun && !prev: eval(Run at start)
if !isRun && prev: eval(Run at stop)
```

- Create: `isRun = 0`, `inWorld = 1` (all subtrees start in the world)
  (`FUN_00485410`). Member `isRun` (char).
- Consequences: a container's children are frozen (not updated, not in the
  world) while it is off; on the stop tick they are updated one last time;
  they leave the world on the following tick. On tick 1 every container whose
  condition is false removes its subtree (in level 1: the player, the outro,
  the train 1499 and the intro sub-containers).
- "Remove from world" is `FUN_004c4c40`'s message: objects call
  `FUN_004bd780(world, obj)` (`FUN_004bbc30`); a CutScene destroys its filter
  overlays (`FUN_004ed0f0`). The meaning "remove from the scene/collision" is
  [inferred] from that code.

### CutScene (5) and EditCamera (48) [recovered]

Parameters (offsets from `FUN_004eb760`): Run +0x7c, Reset +0xcc, Time delta
+0x11c, Start time +0x68, Initial run +0x60 (= isRun), Time scale +0x6c,
Viewport height factor +0x70, fade in/out +0x74/+0x78, Time of day +0x210,
Start/Stop expression +0x16c/+0x1bc. Members `isRun`, `isFinished` (char),
`nTick` (int) (`FUN_004ebc10`).

Compile (`FUN_004ecfa0`): negative fade times → 0; `nTick = trunc(30 ×
Start time)` (0x4ecfd6: `fild 30; fmul; fistp`).

Update (`FUN_004ebe30`):

```
update children (EditCameras: no logic)
if Run present: isRun = byte(eval(Run))
if Reset present && byte(eval(Reset)) != 0: nTick = 0; isFinished = 0
if isRun:
    apply camera at nTick (FUN_004ec060, below)
    nTick += (Time delta present ? trunc(eval(Time delta) * 30) : 1), clamped >= 0   # 0x4ebf33, chop-mode fimul
    if !wasRun: eval(Start expression)
else if wasRun: remember the frame; eval(Stop expression)
else if the remembered frame != current frame: destroy filter overlays
wasRun = isRun
```

**Camera keys** (`FUN_004eb4e0`): the first EditCamera child and the
EditCamera siblings after it (and their EditCamera children, depth first).
Key start = running **float32** sum of `Time scale × Duration`; total = the
final sum. Angles are unwrapped key to key into (−π, π] (`FUN_004eb5a0`; the
exe rewrites them in place on every apply, which converges after the first).

**Apply** (`FUN_004ec060`):

1. `t = (float)nTick / 30` (float32).
2. Current key `i` = last key with `start <= t`. Zero-duration keys share
   the next key's start, so they are never current; they only end the
   previous segment.
3. If `total < t` (float32 compare): `isFinished = 1`, `nTick =
   trunc(30 × total)` (0x4ec149), and the stored key index is reset, which
   forces a "cut".
4. A change of `i` is a **cut** (filters are rebuilt).
5. Curve keys `k0..k3 = clamp(i−1 .. i+2)`; then if `!k0.smooth: k0 = k1`; if
   `!k1.smooth: k2 = k1` (hold k1); if `!k2.smooth: k3 = k2`.
6. `FUN_004ec230` interpolates and submits (below).

**Interpolation** (`FUN_004ec230` → `FUN_004ece70` → `FUN_00511e70` /
`FUN_00511ed0`): every channel is a cubic Hermite from p1 to p2 at `s = (t −
t1)/(t2 − t1)` (0 when t2 = t1) with tangents

- `m1 = (p2 − p0)(t1 − t0)/(t2 − t0)` (note **t1 − t0**, as the exe computes),
- `m2 = (p3 − p1)(t2 − t1)/(t3 − t1)`,
- each 0 when its denominator is 0.

Channels: position x/y/z (doubles), alpha, beta, gamma, FOV, time of day
(−1 → the CutScene's), camera shake, noise. Filter colour is linear between
k1 and k2.

**Orientation** = `Rz(γ)·Ry(β)·Rx(α)` (`FUN_004a9bc0`), row-major, columns =
camera right, down, forward ([rendering.md](rendering.md): x right, y down, z
forward). α = −90° looks horizontally along the rotated +y.

**Link** (k1's "Link task ID" ≥ 0; `FUN_004ff7a0`): key positions are in
world space relative to the link task's pose captured at compile
(`FUN_004ff270`: compiles the link task, then reads its transform with
message 7 into +0x48/+0x60). At run time `p' = cur.pos + Rcur·Rinitᵀ·(p −
init.pos)`, `M' = Rcur·Rinitᵀ·M`. Without "Update link continously" this is
done only at cuts and reused (+0x218). All 48 level-1 keys update
continuously.

**Target** (k1's "Target task ID" ≥ 0; `FUN_004ff480`, applied after the
link): look-at matrix from the camera position to the target's origin:
forward = unit(target − pos), right = unit(forward × +z), down =
−unit(right × forward).

**FOV**: clamped to [0.001, 3] at compile; passed to the camera as the
horizontal tangent (the slot that holds tan(45°) = 1 for the player,
[rendering.md](rendering.md)); FOV 1 = 90° horizontal, 0.1 ≈ 11.4°.

**Camera shake** (k-interpolated `Camera shake`): each axis of the position
moves by `(0.5 − rand) × shake × 4096` units and two or three angles by
`(0.5 − rand) × shake × 0.5340708` rad, using the CutScene class RNG
(`DAT_00807358`). [recovered amplitudes; which angles get which draw is
uncertain]

**Submission**: `FUN_004cfed0(camera, pos, M, fov, 1.0, 1000.0, frame, 0,
timeOfDay, 0)`. Within one frame the submission with the highest priority
wins; equal priority: the later one. The player's HumanCamera submits with
priority 300, so **a running cut-scene owns the view**. Two cut-scenes in
the same frame: the later in tree order wins (the hand-over tick).

**Letterbox** (`WideScreenFilter`, `FUN_00499330`, draw `LAB_0049a4b0`):
`c = min(fadeIn, fadeOut)` where fadeIn = t/fadeInTime while t < fadeInTime
(else 1), fadeOut = (total − t)/fadeOutTime while within the last
fadeOutTime (else 1); `f = (1 − c) + c × Viewport height factor`. If f ≠ 1 two
black bars `(W+1) × ((1 − f)(H+1)/2 + 1)` are drawn at the top and bottom.
The overlay is created once and not resized afterwards. Level 1: factor 0.7,
no fades → bars of 73.15 px at 640×480 from the first frame.

**Time of day**: interpolated like the other channels (keys at −1 take the
CutScene's Time of day, `FUN_004ec230`) and submitted with the camera
(+0x58). Nothing reads it: the lights are interpolated once at time 0
(docs/rendering.md §3). Level 1: every CutScene has Time of day 0 and every
key −1, so the value is 0 anyway. [recovered submission and light setters;
"no reader" is inferred from the searches listed in rendering.md §3]

#### Camera filters [recovered `FUN_00499900`, `FUN_004ec230`, `FUN_004ebe30`; drawing in [rendering.md](rendering.md) §5]

EditCamera FILTER: `CAMERAFILTER_TYPE_*` NONE 0, LINE 1, BAND 2,
BAND_UPDATE 3, HANDICAM 4. Classes LineFilter (0x38 bytes), WideScreenFilter
(0x44), BandFilter (0x74), HandiCamFilter (0x4c), each with a render handler
(slot 0, per frame), an update (slot 1, per tick) and a destructor (slot 2),
created as children of the in-game overlay root `DAT_00807368` (GameScreen
+0x24).

At a **cut** (and only when the overlay root exists) `FUN_004ec230`
destroys the CutScene's three slots and creates what the current key k1
asks for, with **k1's own** Filter color:

| k1 FILTER | Created | Arguments (call site) |
|---|---|---|
| LINE | `FUN_004992e0` → +0x25c | colour, depth 614.4, deferred 1 (0x4ecc98) |
| BAND, BAND_UPDATE | `FUN_00499390` → +0x264 | depth 614.4, colour (clamped to [0, 1]), roll period 60, burst period 90, Noise (0x4ecd10); BAND_UPDATE first advances the global camera number `DAT_00541b80` 1 → 2 … 9 → 1 (`FUN_004997f0`), stored in the band (+0x60) |
| HANDICAM | `FUN_00499810` → +0x268 | colour, depth 614.4 (0x4ecd65); time stamp = GetTickCount, blink 0 |

On **every** apply: the band's colour = the colour interpolated k1 → k2,
clamped (`FUN_00499700`), and the line's noise = the interpolated Noise
(`FUN_0049bef0`). The line and handicam colours stay k1's; the band's noise
stays the value at the cut.

Per tick: BandFilter (`LAB_0049a7a0`) burst −= 4/60 (not below 0), roll
counter 0 … 60 cyclic, burst counter +1 up to 90, then counter =
trunc(rand × 90 × 0.7) and burst = rand × noise; HandiCamFilter
(`LAB_0049bbb0`) time code += real ms × 0.024 (24 frames/s) and blink +=
real ms / 1000 (reset above 1.5 s). LineFilter: nothing. All filter draws
use their own RNG `DAT_006c62c8`, initialised once at start-up
(`FUN_00499900`: `FUN_004aaa00`, then the time code = rand × 21600).

**Lifetime** (`FUN_004ebe30`): on the tick a CutScene stops it remembers the
render frame counter (`DAT_007ef148`, +0x270); on a later tick in another
frame it destroys all its overlays; leaving the world destroys them at once
(`FUN_004ed0f0`). So an overlay outlives its cut-scene by one tick.

What they look like (rendering.md §5): LINE = dark scan lines every 4 px
(colour, alpha 76) plus Noise static; BAND with Noise 0 = the frame
multiplied by the colour (a tint / fade), with Noise ≠ 0 = scrolling
multiply bands with speckles and "CAMERA n"; HANDICAM = 2-px scan lines,
white corner brackets, a running time code and a blinking upside-down
battery icon.

Level 1 [observed with these rules, `tests/cutscene-filters.test.ts`]:
every LINE / HANDICAM key has Filter color (0, 0, 0) → black scan lines;
the Anya LINE overlays exist on ticks 1233–1697 and 1791–2234 with Noise
1 → 0 over the first 0.25 s and 0 → 1 over the last 0.25 s of each video
link; the HANDICAM overlay on 2318–2760 (rebuilt on the finish tick 2759,
kept through CutScene_1202's stop tick 2760, i.e. over the first two ticks
of CutScene_1203); its time code starts at 00 : 12 : 38 : 08 in a fresh
session. The outro's BAND keys (CutScene_1204 keys 4 → 5, Noise 0) go
from colour (1, 1, 1) to (0, 0, 0): the last 3 s (from start tick + 660)
fade the frame to black.

### AnimTask (8) [recovered]

- AnimData (`FUN_004ea1f0`): n records `(channel, value)`; channel 32 (' ')
  = wait, its value truncated to ticks (0x4ea247).
- Playback state: 34 floats (+0x6c): channels 0..31, 32 = wait counter, 33 =
  record cursor. Step (`FUN_004eabe0`): if a wait is active, decrement it and
  advance the cursor when it reaches 0; while no wait is active, apply
  records `channel[c] = value`. Then send the state with the current nTick to
  the target (`FUN_004eace0`, message 0x54a262).
- Seek (`FUN_004eab70`): n = 0 or backwards → clear, nTick = 0, step n + 1
  times; forwards → step until nTick = n (the message carries the
  pre-increment tick).
- Compile: seek(0) (rewinds the target to its start pose). Update
  (`FUN_004ea7c0`): `isRun = byte(eval(Run))`; if isRun: seek(nTick + 1).
  The first update therefore re-sends nTick 0.
- Members `isRun` (char), `nTick` (int).
- Level-1 AnimTasks are children of their targets, so they update inside the
  vehicle's update.

| AnimTask | Target | Run | Records |
| --- | --- | --- | --- |
| −1 | Car_1099 (truck) | CutScene_1204.isRun | 63 |
| 1498 | Train_1499 | 1 | 6 |
| −1 | Train_1501 | CutScene_1200.isRun | 6 |
| −1 | Heli_1502 | CutScene_1200.isRun | 269 |
| 1599 | Heli_1508 | CutScene_1201.isRun | 40 |
| −1 | Train_1507 | CutScene_1201.isRun | 18 |
| −1 | Train_1999 | CutScene_1202.isRun | 2 |
| −1 | Train_2099 | CutScene_1203.isRun | 6 |

### Train (23), Heli (2), Car (1): AnimTask input [recovered]

- **Train** (`FUN_0042a450`): channel 0 = target thrust (−1.0 = keep). nTick
  0 = reset: distance = "Position", thrust = target = "Original thrust",
  wagons placed. Otherwise thrust moves toward the target by ThrustStep,
  speed = MaxSpeed × thrust × 4096000 × (1/108000) units/tick (MaxSpeed in
  km/h), distance += speed (negated with Flip Direction), then the
  locomotive and wagons are placed along the RailroadQTaskID SplineObj at
  that distance (`FUN_004296d0` → `FUN_004f5830`, wagon spacing from each
  wagon's length +0x74c). Train_1501 runs 0.35 × 200 = 70 km/h. The spline
  arc-length evaluation was not reimplemented.
- **Car** (`FUN_0042dcb0`): channel 1 = thrust target (−1 keep), channel 0 →
  steering target (+0x73c), channel 3 ≠ −1 → flag +0x744; nTick 0 resets the
  pose and thrust; otherwise `FUN_0042df40` steps the car physics.
- **Heli** (`FUN_00430df0`): channels 0/1/2 → control axes (+0x734/+0x738/
  +0x73c, smoothed with factors from the physicsobj config), channel 3 →
  thrust target (−1 keep); nTick 0 resets; `FUN_004310b0` applies forces and
  integrates (`FUN_004e3ad0`, `FUN_004f2d00`).
- Vehicles move **only when their AnimTask steps**. The car and heli rigid-
  body dynamics were not recovered.
- **Car_1099.isExploded** (+0x2ed5, `FUN_0042d840`): after the car's
  destroyed flag (+0x91c) the car spawns its explosions, waits 10 or 30
  ticks, replaces itself with the wreck and sets isExploded. An exploded car
  no longer updates (`FUN_0042d5c0`). The flag is set only by the car's
  explosion handler (0x42ede0), and only for explosions whose source is
  weapon 12 (the LAW 80's missiles); bullets do nothing. Level 1 has no LAW,
  so Car_1099.isExploded stays 0 [recovered handler; level consequence
  inferred] ([damage.md](damage.md)).

### Door (23) [recovered `FUN_00445ae0`, `FUN_00446600`, `FUN_00446c10`]

Parameters: Position start, Position stop X/Y (**metres** in the door frame,
range ±10), Position slider (initial slide 0..1), Orientation, Max angle
(degrees, ±360), Open time (s, 0.5..100), Pickable, Pick lock time,
Locked/Open/Close expressions, three sounds.

```
update children
isLastOpen = isOpen; isLastClosed = isClosed
if isClosed && Open present && eval(Open) != 0: wantOpen = 1
if isOpen: nDoorOpenTicks += 1; if Close present && eval(Close) != 0: wantOpen = 0
else nDoorOpenTicks = 0
if Locked present: isLocked = byte(eval(Locked)); if isPicked: isLocked = 0
targetAngle = wantOpen ? MaxAngle : 0; targetSlide = wantOpen ? 1 : 0
angle moves |MaxAngle| / (OpenTime*30) per tick toward targetAngle
slide moves 1/(OpenTime*30) per tick toward targetSlide (if a stop X/Y is set)
at both targets: isClosed = (target == 0); isOpen = !isClosed; else both 0
if it moved and the swept volume hits something (FUN_004c24c0): reopen fully
sounds: Open on isOpen rising, Close on isClosed rising, Move loop while moving
```

- Pose: `start + R·(stopX, stopY, 0)·slide·4096`, `R·Rz(angle)`
  (`FUN_00445060`, `FUN_004a9a70`).
- Compile: isClosed = isLastClosed = 1, isOpen = wantOpen = 0.
- "Use" (`FUN_0040ce30` case 3): if not locked, `wantOpen ^= 1`
  (`FUN_00446c10`) and a DOOR noise event (`FUN_0040c370`); if locked and
  Pickable, the human enters its lock-pick state (state 0x1e). What sets
  isPicked and after how long was not traced [inferred: Pick lock time].
- Members `isLocked isOpen isClosed isLastClosed isLastOpen isPicked`
  (char), `nDoorOpenTicks` (int) (`FUN_00446860`).
- Level 1 [observed]: 17 building doors slide 1 m in 1 s, unlocked, no
  expressions. Six gates (Locked '1', slide 3.6 m in 2 s): 408/409 open on
  `Switch_506/505.isLastPressed` or the partner's isOpen; 402/403 on
  `Switch_500.isLastPressed`; 400/401 (main entrance) on
  `CutScene_1204.nTick > 11.35*30 / 11*30` (outro). No gate has a Close
  expression.

### Switch (6) [recovered `FUN_00444210`, `FUN_00443ce0`]

- Press (player/AI "use"): `isLastPressed = isPressed; isPressed = 1;
  pressTick = LevelFlow.nTick`.
- Update: children; `isOn = byte(eval(On))`; when `pressTick + 2 <
  LevelFlow.nTick`: `isLastPressed = isPressed; isPressed = 0`. Model index:
  destroyed 4, else (on ? 0 : 2) + pressed; the "switch" sound plays when the
  state becomes on-and-not-pressed.
- **`isLastPressed` is a one-tick pulse ~3 ticks after the press** — the
  value every level-1 expression tests.
- Members `isOn isLastOn isPressed isLastPressed isDestroyed
  isLastDestroyed` (`FUN_00444630`).

### ExplodeObject (6), Terminal (3), AlarmControl (1), SCameraControl (2) [recovered]

Class chain ExplodeObject ← Terminal ← {AlarmControl, SCameraControl}
(`FUN_0047f6b0`, `FUN_00442fc0`).

- **ExplodeObject** (`FUN_0047fce0`): children; if not exploded: flag =
  byte(eval(Explosion expression)); if flag or countdown == 0: explode
  (`FUN_0047fdd0`: destroyed model, explosion with fragments/fireballs,
  `isExploded = 1`); if countdown > 0: countdown −= 1. Countdown starts at −1.
  Damage sets it [recovered, [damage.md](damage.md)]: once the damage sum
  reaches "Damage scale", a bullet sets it to 0 (`LAB_00480520`) and every
  explosion to trunc("Explosion delay" × 30) (`LAB_00480560`, only while in
  the world). Member `isExploded`.
- **Terminal** (`FUN_00442ac0`): ExplodeObject update; `isOn =
  byte(eval(On Expression))` unless exploded (then 0); `isInUse` clears when
  `useTick + 2 < LevelFlow.nTick`, `isLastInUse = isInUse`;
  `isHackedThisTick` clears when `hackTick + 2 < now`. Use: `isInUse = 1,
  useTick = now` (0x442f64). Hack done (`FUN_004473f0`, from the human hack
  state, which reads "Hack Time (s)" via `FUN_00443030`): `isHacked = 1,
  isHackedThisTick = 1, hackTick = now`. Members `isInUse isLastInUse isOn
  isHacked isHackedThisTick` (`FUN_00442c40`).
- **AlarmControl** (`FUN_0043fa60`): Terminal update; if not exploded and
  isOn: `isTrigger = byte(eval(Trigger))`, if isTrigger `nTriggerLastTick =
  level tick`, `isAlarm = byte(eval(Alarm))`; else both 0. Members
  `isTrigger isAlarm` (char), `nTriggerLastTick` (int, starts −10000)
  (`FUN_0043fc00`). The AI reads isAlarm (`FUN_0043fdc0`).
- **SCameraControl** (`FUN_0043ff30`): Terminal update; `isDetection =
  byte(eval(Detection))` unless exploded. Member `isDetection`.

### SCamera (5) [recovered `FUN_004417d0`, lens `LAB_00440930`, `FUN_00440db0`]

- Update: the lens (a child created in `FUN_004415b0`) runs first, with
  **last tick's isOn**; then `isOn = byte(eval(On Expression))` unless
  exploded.
- isExploded is set by the lens: 0.5 damage from bullets or explosions
  makes its next update (after that tick's detection) set it, swap to
  "Camera Destroyed Model" and explode (0.25, 0.5 m, `explo_camera`)
  [recovered, [damage.md](damage.md)].
- Lens (`LAB_00440930`): the light's blink counter first (+0x25d4 7…0, at
  0 the phase +0x25d8 toggles: every 8 ticks, whatever isOn); `isLastDetection
  = isDetection`. On: pitch slews 2.5°/tick toward Camera Alpha; vision runs
  (below); detection logic below. Off: pitch droops 2.5°/tick to −75°,
  `isDetection = 0`, sounds stop. Last, the rotation +0x70 (0x440c24).
- Detection (`FUN_00440db0`): `isDetection = 0`; the target is the first
  visible entry of list +0x1ac, replaced by the first visible entry of list
  +0x1a0 when there is one. A new target (pointer +0x25b8) sets
  `nDetectionTime = 90` (list +0x1a0) or 0 (list +0x1ac); every tick with a
  target `nDetectionTime −= 1` if non-zero, and `isDetection = 1` once it is 0.
  So **an enemy must stay seen for 90 ticks (3 s, the first sighting tick
  included)**, and **a body or a destroyed camera raises isDetection on the
  tick it is seen** ("camera_beep_al"). Without a target: `nDetectionTime =
  0`, wait 60 ticks after losing one, then sweep.
- Tracking: turn toward the target bearing by ≤ 0.75°/tick when it is more
  than 5° off, within [−Right°, +Left°]. Sweep: between +Left° and −Right° at
  Speed°/s, waiting Gamma Delay s at each end. View yaw = Holder Gamma +
  Camera Gamma + sweep. The bearing (0x440e8b) is `FUN_00486950` of the
  target's point minus the **lens origin** (+0x20, the pivot, not the eye) in
  the lens matrix +0x70 (the previous update's): positive = to the left; the
  point is `FUN_004411e0`: a human's vision point (`FUN_00464490`), a camera's
  Holder Position (+0xf0).
- Sounds: `camera_move` while turning, `camera_beep_s` while counting,
  `camera_beep_l` / `_al` while detecting.
- Members `isDetection isLastDetection` (char), `nDetectionTime` (int),
  `isExploded` (char).

#### SCamera vision [recovered `FUN_00487ae0`, `FUN_00487b70`, `FUN_00487cf0`, `FUN_00487d80`, `FUN_00487f40`, `FUN_00441bf0`, `FUN_00441580`]

The lens runs the soldiers' detector ([ai.md](ai.md) §2.2) with its own
set-up:

- **Set-up** (lens create `LAB_00440780`, 0x4408c6): `FUN_00487ae0(lens
  +0x188, team 1, flags 6, mask, 4, 8)`; mask = human class (0x5c1174,
  `FUN_00462e90`) | SCamera class (0x57f6d0, `FUN_00442850`). Every update
  while on: eye +0x110 = lens + R × **magic vertex 1** of its model, eye
  matrix +0x128 = R, both from the lens matrix +0x70 **of the previous
  update**; +0x180 = 0 (no secondary cone); `FUN_00487b70(lens +0x188, eye,
  holder, team 1)`.
- **Who is tracked** (`FUN_00487b70`): the registry `DAT_005c4a00` (filled
  at create by `FUN_00487aa0`: SCamera holders `FUN_004415b0`, humans
  0x45d850; so task-tree order), each answering the detection-info message:
  humans `FUN_0045eaa0` (team +0xfc, alive = !isDead +0xcf5, in world +0xcf6
  — set / cleared by the add / remove-from-world handlers 0x45f5c0 /
  0x45f610 — point = origin + 0.69 m standing / 0.35 m crouched,
  `FUN_00464490`); SCamera holders `FUN_00441bf0` (team 1, alive =
  !isExploded, always in the world, point = holder position). Skipped: the
  camera's own holder, objects out of the world. Flags 6 keep **alive objects
  of another team** (list +0x1a0: the player, team 0; Jones, team 0, when in
  the world) and **dead objects of team 1** (list +0x1ac: soldiers' bodies and
  destroyed SCameras). New slots go to the tail (`FUN_00487920`); a slot
  leaves its list when its object stops qualifying.
- **Schedule**: the whole pass runs on ticks with `(tick & 3) == phase`
  (tick = the application tick `*(DAT_00563dfc + 0x34)`, reset at each level
  load by `FUN_004029a0`, +1 after every main-loop tick, 0x4023ce); per slot
  the cone test every 2nd pass (8 ticks), the sight ray every 3rd pass (12
  ticks) while in the cone; a failed cone test clears "visible" at once
  (`FUN_00487cf0`, as the soldiers').
- **Phase** (`DAT_005c4a48`, `FUN_00487ae0`): a process-wide counter (static
  0, never reset, +1 mod 4 per detector set-up). objects.qsc creates every
  task before the compile pass, so the five lenses take the first phases of
  a load (level 1, first mission of the process: 1301…1305 = 0, 1, 2, 3, 0),
  then the compile pass takes the others in pre-order: HumanAI
  (`FUN_0044f3a0`), Car (`FUN_0042e7d0`) and Heli (`FUN_00431bd0`) when their
  model loads, AIStationaryGunHolder (`FUN_0046d370`); level 1: Car_1099 1,
  Heli_1502 2, HumanAI_1506 3, Heli_1508 0, HumanAI_2022 1, … A restart
  continues the counter; run-time re-inits (Car / Heli / StationaryGun "Can
  fire" falling to 0: 0x42dbcf, 0x430c68, 0x46d201) advance it too.
- **Cone** (`FUN_00487d80`): `point − eye` in the eye matrix (columns right,
  forward = model +y, up); in when distance (double) ≤ length, float32(|vertical
  angle|) < alpha and |horizontal angle| < gamma. **Viewcone Alpha is the
  vertical** and Gamma the horizontal angle, both halved as integers at
  compile (0x441410: 55° → 27°): level 1 = ±45° vertical, ±27° horizontal,
  25 m.
- **Sight ray** (`FUN_00487f40`): eye → point through the world
  (`FUN_004c4630`, all object categories and the terrain, filter 0x53f120,
  record {self = holder, target}); the lens filter `0x441580` skips a lens
  whose holder is the ray's self or target, the SCamera / human / Car / Heli
  filter 0x441c30 skips the self and the target object; passes when nothing
  is hit or the see-through product is ≥ 0.79 (glass, one fence). So a
  camera sees through its own head and a target camera's head; other humans
  block the ray: every human in the world but the target, alive or dead,
  through its HSEM sphere (radius = HSEM +120 of its Model, about 0.9 m,
  around the pelvis, `FUN_0045e210`) and then the faces of its posed
  collision set 0 (`FUN_004cef60`; all see-through 0, so any crossed face
  stops the ray). Details in [ai.md](ai.md) §2.2 "Humans on the ray".
- **The application tick runs while paused** [recovered]: the main loop
  `FUN_00402250` updates both task trees and then increments +0x34
  (0x4023c5–0x4023ce) on every tick it runs. The in-game menu only sets
  Game +0xe0 (MenuManager 0x417152 → `FUN_00415c60`), which stops
  `FUN_00415306` from updating the Game task's children. The loop's own
  guards (`DAT_005c4d40`, the ScreenGrab flags `DAT_00801342/3`, the
  `FUN_0048e9b0` device flags `DAT_005c4db0/1`) are not the pause. So
  after a pause the lenses' (and soldiers') phase ticks shift against the
  level tick.
- **No RNG, no lighting, no stance factor** besides the lower crouched point;
  detection is cone + ray + the 90-tick count (list +0x1a0).

#### Parts: holder, lens, light [recovered `FUN_00440190`, `FUN_00441900`, `FUN_00441290`, `LAB_00441c50`]

Two objects per task, both SectorInteriorObject (parent `FUN_004d7560`), so
both are rigid objects with the inherited ray methods 9/10 (bullets, sight,
character sweep test their model's HSMC sets at the current pose,
[collision.md](collision.md) §3) and the RigidDynCubeObj draw (method 4,
vertex-lit `FUN_00506540`, E093):

- **Parameters** (schema in `FUN_00440190`, 15 entries, class 0x1c8 bytes):
  +0xf0 Holder Position (3 × f64), +0x108 Holder Gamma, +0x10c Holder Model,
  +0x120 Camera Alpha, +0x124 Camera Gamma, +0x128 Camera Model, +0x138
  Camera Destroyed Model, +0x148 / +0x14a / +0x14c Rotate Gamma Right /
  Left / Speed (short; default 45), +0x150 Gamma Delay (1.0), +0x154 / +0x156
  Viewcone Alpha / Gamma (short; 90), +0x158 Viewcone length (10.0), +0x174
  On Expression. Run time: +0x15c the lens, +0x168 isOn, +0x169 isDetection,
  +0x16a isLastDetection, +0x16c nDetectionTime, +0x170 isExploded.
- **Holder** (the SCamera itself, compile `FUN_00441900`): model = "Holder
  Model" (`FUN_004c82b0`: "missing" for an unknown name) at Holder Position,
  rotation Rz(Holder Gamma) (`FUN_004a9ec0`); octree + sector registration.
  No damage handlers: bullets stop on it and do nothing.
- **Lens** (class SCameraLens, 0x25e8 bytes, created by the holder's create
  `FUN_004415b0` → `FUN_004012e0`; the holder pointer is lens +0x25d0) is
  the camera head:
  - create `LAB_00440780`: damage list and lens list, pitch +0xf0 = 0, sweep
    +0xf4 = 0, damage 0 / limit 0.5 ([damage.md](damage.md)).
  - compile `FUN_00441290` (from the holder's compile): model = "Camera
    Model" (only `FUN_004baaf0`, no `FUN_004bab70`, so the model's ATTA
    children — 313_04_1, the `TASKTYPE_SCAMERALENSVIEWCONE` helper — are not
    built); **position = holder + Rz(Holder Gamma) × magic vertex 0 of the
    Holder Model** (`FUN_00486e20(holder, 0)`; none → the holder's position);
    pitch = Camera Alpha (0x44139e); rotation = `FUN_004a9bc0(pitch, 0,
    Holder Gamma + Camera Gamma)`; eye +0x110 = lens + R × magic vertex 1 of
    the Camera Model, eye matrix +0x128 = the rotation; half view cone
    +0x150 / +0x158 = (Viewcone Alpha / 2, Viewcone Gamma / 2 as integers) ×
    deg, length +0x160 = Viewcone length × 4096.
  - The lens never moves: every update ends with **rotation =
    Rz(f32(sweep + Holder Gamma + Camera Gamma)) · Rx(pitch)** (β = 0,
    0x440c24), i.e. yaw about world z through the pivot, then pitch about the
    head's own x axis. Model +y is the view axis; Camera Alpha −0.1 looks 5.7°
    down; the droop −75° hangs it nearly straight down. The vision of a tick
    uses the eye and matrix of the previous tick's rotation (copied before
    the end-of-update rotation).
  - Destroyed (0x440b9d): model = "Camera Destroyed Model", +0xdc = 0, the
    explosion; the lens stays in the world with that model (its faces take
    the bullets) and keeps updating, so the broken head droops to −75°.
- **Light** (lens draw, method 4 `LAB_00441c50`): while the holder isOn,
  before the model, a screen quad of `alarmlight.spr` frame 0 (registered by
  `FUN_004158c0` in the class registration 0x440635, loaded from
  `LOCAL:common/sprites/` by `FUN_00415270`; 16 × 16, grey 230 with a round
  alpha falloff) at lens + R × magic vertex 0 of the current model (313_02_1:
  (−1.5, 1379.6, 1109.9), the top of the head), R = the current lens matrix;
  drawn only in front of the camera (`FUN_00496190`: view depth > 0),
  half-size = world half-size × viewport scale / depth (`FUN_004962b0`: a
  camera-facing square of that world size), all corners at the centre's
  depth: idle green (r, g, b) = (0, 128, 0)/128 at 819.2 units (0.2 m) in
  blink phase 1, dim (0, 64, 0) at 307.2 (0.075 m) in phase 0; counting or
  detecting (isDetection or nDetectionTime ≠ 0) red (128, 0, 0) at 1433.6
  (0.35 m) / 512 (0.125 m); the phase toggles every 8 ticks (+0x25d4 counter
  7…0, +0x25d8). `FUN_004ab6b0` passes alpha 0.5 and flags 0x1040008, and
  the TL path (`FUN_00504300`, `FUN_00504b00`, `FUN_00504e40`) makes that:
  vertex alpha **255** (none of 0x10880024 set, so the 0.5 is dropped),
  diffuse bytes trunc(c/128 × 255) (64 → 127), texture × diffuse, alpha =
  texture alpha; 0x8 **additive** SRCALPHA / ONE with alpha test > 10;
  0x40000 z test LESSEQUAL without z write (queued in the depth-sorted
  deferred list `FUN_004ad570`); 0x1000000 bilinear, clamp; FOGENABLE 0.
  [recovered; ported: `fx/alarm-lights.ts`]
- Map computer: `LAB_00441e40` draws the camera icon (cycling frames every
  8 ticks while on), `FUN_00441fb0` its 12-segment view cone clipped by rays.

**Level 1** [observed, `tests/scamera.test.ts`, survey of the built world]:
five SCameras (ids 1301–1305), all in plain Containers under Dynamic (no
ConditionalContainer, always in the world), all models 313_01_1 / 313_02_1 /
313_03_1, Viewcone 90° × 55° × 25 m, On = `!LevelTimer_95.isRun ||
LevelTimer_95.nTick > 3600`. Each holder hangs on a wall 0.12–0.17 m behind
its origin; the heads are 3.6–5.6 m above the open ground and can be seen
(and shot) from the ground around them:

| Id | Head (engine x, y, z m) | Mounted on | Camera Alpha / Gamma | Sweep Left / Right, speed, delay |
| --- | --- | --- | --- | --- |
| 1301 | 18.2, 5.6, 106.3 | lamp pole EditRigidObj 335_01_1 | −0.1 / 0 | 1° / 95°, 15°/s, 4 s |
| 1302 | 56.9, 4.0, 99.0 | Building 1117 (409_01_1) | −0.1 / 1.257 | fixed |
| 1303 | −26.2, 4.0, 139.4 | Building 1123 (412_01_1) | 0 / −0.8 | 110° / 1°, 15°/s, 5 s |
| 1304 | 4.3, 3.6, 101.9 | Building 1106 (410_01_1) | −0.1 / −0.628 | fixed |
| 1305 | −33.6, 4.7, 97.3 | Building 1105 (405_01_1) | −0.1 / −1.990 | 100° / 10°, 15°/s, 5 s |

Head models: 313_02_1 (96 vertices; HSMC set 0 56 faces Plastic / Rubber,
set 1 12 faces; magic 0 = light, 1 = eye; LODs _2…_4), destroyed 313_03_1
(no magic vertex). Holder 313_01_1 magic 0 = (2.3, 959.8, 338.1).

Port: `loaders/level.ts` places the head (LevelInstance.part
"scameraLens") right after its holder at the compile pose;
`world-builder.ts` gives it its own dynamic key (`scameraLensKey(node)` =
2,000,000 + node: render entries, collision body, relit vertex light) and
makes it destructible; `mission-system.ts` turns it every tick from the
runtime's yaw / pitch (`securityCameraLensMatrix`); `object-damage.ts`
registers it as the lens.

Vision port: `loaders/mission.ts` `SecurityCameraDetector` (registry walk,
team lists, schedule, target choice), `securityCameraCone`,
`securityCameraInViewCone`, `securityCameraBearing`, `perceptionPhases`;
the runtime keeps the lens matrix of the last update (`rotYaw`, `rotPitch`)
and the blink (`lightCount`, `lightPhase`). `mission-system.ts` is the host
(`cameraSighting`): phases from a session counter, the eye from the damage
data's magic vertices, the registry (holders with their live isExploded, the
player with its eye as the point, the soldiers with their AI origin), the
sight ray with `TRI_SIGHT` + `sightTransmission` / `aiSightPasses`, skipping
the two cameras' holder and lens instances, plus the humans' posed bodies
(`enemies.sightHits`, every human but the target), the schedule on
`ctx.appTick` (the level tick when absent), and `perceptionPhase(taskId)` for
the soldiers from the same load's map. With `setNodeTick` (game.ts) the
humans are read live (they have not moved yet when the SCameras update);
otherwise as they were at the start of the tick (`beginTick()`, else the end
of the previous tick). `securityCameraLights()` feeds `fx/alarm-lights.ts`
(effects scene hook). [observed, `tests/scamera-vision.test.ts`]: standing
8 m in front of 1304 the camera's first sighting is a phase-3 tick, isDetection
follows 89 ticks later, SCameraControl_90.isDetection on the same tick,
AlarmControl_98.isAlarm and the radio message two ticks later; 20 m out
behind 319_04_1 the player is in the cone but not seen; a team-1 body in
view, or camera 1304 destroyed in 1301's sweep, raises isDetection at once.
[observed, `tests/sight-occlusion.test.ts`, the game's systems headless]: a
soldier standing on the ray 8 m in front of 1304 (the player crouched behind
it) keeps the player in the cone but unseen; once it steps 4 m aside the count
starts on a phase-3 application tick; with the application tick 2 ahead of
the level tick (a pause) the first sighting is on (appTick & 3) == 3.

### ConditionalSound (21) and AmbientArea (22) [recovered `FUN_004246a0`, `FUN_0044b1b0`]

Trigger logic only (playback: [audio.md](audio.md) §5): `isLastRun = isRun;
isRun = byte(eval(Condition))`; refresh the playing flag (`FUN_004248b0`,
which also re-submits a playing Simple voice each tick); unless OneShot and
already started: not running → stop a definition voice (`FUN_00424790`; a
Simple raw sample is not stopped); rising edge → start (`FUN_004247d0`);
then update children. Members `isRun isLastRun isPlaying` (char),
`nPlayTick` (int). Because voices must be re-submitted every tick
([audio.md](audio.md) §3), a sound whose container stops updating stops too
— this is how skipping the intro silences the voice-over [inferred from the
two recovered rules]. All 22 AmbientAreas sit in the gameplay container
(1495), so ambience and music play only during gameplay.

### DefineComputerObjective (1) [recovered `FUN_00465f90`]

Each tick: if "Objectives Valid" is present and byte(eval) == 0, skip; else
it becomes the current objective set (`DAT_005c11b0`) and for each of the six
objectives `complete = (char)fistp(eval(Complete))`, `failed = ...` (0 when
absent). No members; the map computer shows the list. Level 1: one objective
`M1_OBJ1` "Steal the truck near the main entrance.", link 1120 (truck
garage), complete = `EditVariable_105.nValue == 1`.

### LevelFlow (1) [recovered `FUN_004872f0`, `LAB_004876b0`]

- Create: `DAT_00b680a0 = this`; difficulty from the player profile (1 if
  none); creates the in-game MenuManager (`ingamemenu.qsc`).
- Update (when not frozen): `isFailedLast = isFailed`; children; `isComplete
  = byte(eval(Complete))`; `isFailed = byte(eval(Failed))`; if isFailed:
  isComplete = 0; `nTick += 1`; snapshot the Key0..9 states.
- Members `isComplete isFailed` (char), `nTick eDifficulty` (int), globals
  `Key0_isPressed..Key9_isPressed` (`DIK_0..DIK_9 & 0x80`) (`FUN_004873b0`).
- Script functions (`FUN_00486fd0`): `LevelFlow_GetBreakCutSceneKey()` =
  DirectInput byte 0xbce9a3 (`DIK_ESCAPE`) & 0x80; `LevelFlow_LevelFailed()`
  = isFailed; `LevelFlow_IsCountryUSA()`.
- `LevelFlow.nTick` is the clock of StatusMessage, Switch and Terminal; it
  equals the number of completed ticks (it is the last task updated).

### Humans, AI [recovered member registration only]

`HumanPlayer_0.isDead` / `HumanSoldier_<id>.isDead` = human +0xcf5, `eTeam` =
+0xfc (Human base class, 0x45f4f3); `HumanAI_<id>.isDetection` = +0x3ab5
(0x44f573). Their logic is the AI/gameplay documents' subject.

### Member summary

| Type | Members (char unless noted) | Register handler |
| --- | --- | --- |
| AreaActivate | nActive (int) | `LAB_004fb1d0` |
| StatusMessage | isSendt, nTickSendt (int) | `FUN_00483800` |
| EditVariable | nValue (int) | `FUN_00486810` |
| LevelTimer | isRun, nTick (int) | `FUN_00515a60` |
| ConditionalContainer | isRun | `FUN_00485890` |
| CutScene | isRun, isFinished, nTick (int) | `FUN_004ebc10` |
| AnimTask | isRun, nTick (int) | `FUN_004ea820` |
| LevelFlow | isComplete, isFailed, nTick (int), eDifficulty (int); Key0..9_isPressed | `FUN_004873b0` |
| Door | isLocked, isOpen, isClosed, isLastClosed, isLastOpen, isPicked, nDoorOpenTicks (int) | `FUN_00446860` |
| Switch | isOn, isLastOn, isPressed, isLastPressed, isDestroyed, isLastDestroyed | `FUN_00444630` |
| ExplodeObject | isExploded | `FUN_00480650` |
| Terminal (+ subclasses) | isInUse, isLastInUse, isOn, isHacked, isHackedThisTick | `FUN_00442c40` |
| AlarmControl | + isTrigger, isAlarm, nTriggerLastTick (int) | `FUN_0043fc00` |
| SCameraControl | + isDetection | `FUN_00440060` |
| SCamera | isDetection, isLastDetection, nDetectionTime (int), isExploded | 0x441a50 |
| ConditionalSound | isRun, isLastRun, isPlaying, nPlayTick (int) | `FUN_00424990` |
| Car | isExploded | 0x42ef93 |
| HumanPlayer / HumanSoldier | isDead, eTeam (int) | 0x45f4f3 |
| HumanAI | isDetection | 0x44f573 |
| Train | (none; Play Sound expression only) | — |

### Level-1 inventory [observed, 1,362 tasks, 59 types]

| Count | Types | Run-time role |
| --- | --- | --- |
| 382, 268, 141, 48, 40, 37, 36 | EditRigidObj, TerrainLightMap, PatrolPathCommand, EditCamera, Gun, PatrolPath, Container | static/AI data; EditCamera = camera keys; Container = children only |
| 29, 29, 26, 25, 23 | HumanSoldier, HumanAI, Building, SplineObjWaypoint, StatusMessage | humans/AI (other docs); StatusMessage above |
| 23, 23, 22, 22, 21 | Door, Train, LightmapInfo, AmbientArea, ConditionalSound | above / static / audio |
| 18, 17, 11, 9, 8, 8, 8 | Static, ComputerHilight, AIGraph, TextureModifier, AreaActivate, AnimTask, ConditionalContainer | Static never updates; map computer; AI; terrain |
| 6 each | SplineObj, Switch, GunPickup, ExplodeObject | rails/cables; above; pickups |
| 5, 5, 5, 4, 4 | SCamera, AmmoPickup, CutScene, EditVariable, GunMP5SD | above |
| 3 each | HeightMap, LevelTimer, Terminal, Wire, Smoke | terrain; above; decoration; particles |
| 2 each | GlobalLightKeyframe, DirlightKeyframe, FlatSkyLayer, SCameraControl, Heli | lighting/sky; above |
| 1 each | MipMapControl, LODSettings, GlobalLight, Dirlight, FlatSky, Dynamic, AlarmControl, DefineComputerObjective, Fence, Car, HumanPlayer, HumanPlayerInput, Binocular, AddAmmo, GunDRAGUNOV, LevelFlow | above / player loadout |

113 parameters are compiled as conditions (`tools/igi_mission.py`).

## 3. The cut-scene system

**Triggering** [recovered + observed]. A CutScene runs while its Run
condition is true; level 1 chains them with
`CutScene_A.isFinished && !CutScene_B.isFinished`, so B starts **on the same
tick** A finishes (B is later in the tree). The intro also needs its
container chain: `ConditionalContainer_4001 'Intro cutscene'` runs while
`!CutScene_1203.isFinished && !EditVariable_4004.nValue`; each shot's actors
live in a sub-container that runs while its CutScene runs (so they enter the
world **one tick after** the shot starts — the sub-container is earlier in
the tree than the CutScene).

**Timeline**: `nTick` counts ticks from the shot's start (0 on its first
tick). Camera, sounds (`ConditionalSound` on `CutScene_x.nTick`), actor AI
(`CutScene_x.nTick` tests in IDLE) and AnimTasks (`Run =
CutScene_x.isRun`) all key off it. Subtitles key off `LevelTimer_999`, which
runs with the intro container (nTick = global tick).

**Subtitles**: `StatusMessage` with "Cutscene message" TRUE, font4, whole
text at once at (10, 415), last 3 lines, removed after trunc(Duration × 30)
ticks ([hud.md](hud.md) §5).

**Player control** [recovered + inferred]: the player sits in
`ConditionalContainer_1495` (`!CC_4001.isRun && !CC_4007.isRun`), so during
both cut-scenes the HumanPlayer is out of the world and not updated (no
input, no HUD — the HUD is drawn only for the player's camera,
[hud.md](hud.md) §4). The intro container's Run at start / stop calls
`MenuManager_SetEnabled(FALSE/TRUE)`, so Esc does not open the in-game menu
during the intro; it only feeds `LevelFlow_GetBreakCutSceneKey()`. The outro
disables nothing and cannot be skipped [observed].

**Skipping** [recovered]: `EditVariable_4004` (`Add = nValue == 0 &&
LevelFlow_GetBreakCutSceneKey()`) becomes 1 on the first tick Esc is held;
`CC_4001` (later in the same tick) stops: its children update one last time,
then `MenuManager_SetEnabled(TRUE)`; `CC_1495` starts the same tick (player
added, `StatusMessageScreen_ClearMessages()`); the next tick the intro subtree
leaves the world and its sounds stop being refreshed.

## 4. Level-1 intro (from the first tick)

### Timeline [observed with the recovered rules: `MissionRuntime` and `igi_mission.py --timeline` agree]

Tick k = the k-th Level update after load. CutScene nTick at the apply of
tick k is `k − start`.

| Tick | Event |
| --- | --- |
| 1 | CC_1497, 4002, 4003, 4005, 4006, 4007, 1495 remove their subtrees (player gone); CutScene_1200 starts (key 0); `MenuManager_SetEnabled(0)`; voice-over `_cut01_01` starts (ConditionalSound_3998, Simple, OneShot); heli sounds 3000/3004 start |
| 2 | CC_4002 adds Train_1501, Heli_1502 (+pilot); subtitle M1_CUT_01 |
| 181 / 271 / 346 / 481 | 1200 cuts to keys 1 / 2 / 4 / 6; 346–481 heli-interior sounds, 476 `m1_heliby02` |
| 560 | 1200 finished (nTick 559); 1201 starts (Jones jumping onto train) |
| 561 / 562 | CC_4003 adds Heli_1508, Train_1507; CC_4002 removes |
| 568 | `land_ground_2` |
| 627 | 1201 finished (nTick 67); 1202 starts (Speeding train) |
| 628 / 629 | CC_4005 adds Train_1999 (+soldier); CC_4003 removes; `m1_trainby01` |
| 657 … 2758 | 1202 shots: drive-by 627–739, Jones hiding 740–932, train total 933–1232, Anya video link (LINE filter) 1233–1697 and 1791–2234, Jones hiding 1698–1790 and 2235–2317, handicam on the truck 2318–2758 |
| 2759 | 1202 finished (nTick 2132); 1203 starts (Jones jumping off train) |
| 2760 / 2761 | CC_4006 adds Train_2099 (+soldier); CC_4005 removes |
| 2922 | 1203 finished (nTick 163) |
| 2923 | CC_4001 stops: `MenuManager_SetEnabled(1)`; CC_1495 adds the player, `StatusMessageScreen_ClearMessages()`; the player's camera takes over (97.4 s after the first tick) |
| 2924 | CC_1497 adds Train_1499 (leaves the base for 9 s: LevelTimer_1496); CC_4001's subtree leaves the world |

Float32 matters: CutScene_1200's total sums to 18.6000004 in float32, so it
finishes at nTick 559, not 558.

### Subtitles (LevelTimer_999.nTick = tick) [observed]

`Send = LevelTimer_999.nTick > X*GAME_FREQUENCY` fires at tick ⌊X × 30⌋ + 1,
with the product taken as the exe computes it: a double FMUL in chop mode.
24.7 × 30 and 59.8 × 30 come out as 740.999… and 1793.999…, so those two
lines appear on ticks 741 and 1794, not 742 and 1795. "Ticks shown" =
trunc(Duration × 30) of the float32 Duration (8.7 → 260, 2.3 → 68).

| Tick | Key | Ticks shown | Text |
| --- | --- | --- | --- |
| 2 | M1_CUT_01 | 345 | ANYA: Good work getting here so fast. This mission has top priority. Target: Josef Priboi. You are to locate him and bring him out for debriefing. Josef is our only link with the heist of the warhead. |
| 361 | M1_CUT_02 | 105 | JONES: Yeah, yeah. I need to know one thing, where he is. |
| 481 | M1_CUT_03 | 255 | ANYA: Josef is held at a military airfield. The whole area has excellent air defences. We have to place you some distance from the target until those defense are disabled. |
| 741 | M1_CUT_04 | 60 | JONES: What? Is transport waiting? |
| 811 | M1_CUT_05 | 102 | ANYA: You'll cover the ground using locally resourced transportation assets. |
| 931 | M1_CUT_06 | 51 | JONES: You mean I have to steal something? |
| 991 | M1_CUT_07 | 260 | ANYA: Exactly. You will travel to the next goods yard - there you will resource transportation. The whole operation is simple - there are three stages: |
| 1261 | M1_CUT_08 | 315 | ANYA: One - acquire transportation assets. Two - disable air defences. Three - Find Josef Priboi and safely extract him for debriefing. Even... |
| 1591 | M1_CUT_09 | 66 | JONES: ...even a grunt like me can follow it - I see |
| 1666 | M1_CUT_10 | 36 | ANYA: That's the best we have. |
| 1711 | M1_CUT_11 | 68 | JONES: Anya, just how did you track Josef down? |
| 1794 | M1_CUT_12 | 180 | ANYA: We traced Josef's call to his apartment, right? Local agents raided it they found photos of Josef and his mobile number. |
| 1981 | M1_CUT_13 | 255 | ANYA: So, we called it and triangulated the co-ordinates. The mobile's located at a military airfield - that's where Josef is - that's our primary target. |
| 2251 | M1_CUT_14 | 51 | JONES: Cunning - assuming he's there. |
| 2326 | M1_CUT_15 | 270 | ANYA: You must make your way through the goods yard to the truck. Avoid the cameras at all cost - if you alert the security, you'll have the entire base zeroing in on your position. |
| 2611 | M1_CUT_16 | 300 | ANYA: Get to the truck. This is your objective on this mission. Reach it and steal it. I want this mission to be brief and above all quiet. Get to work Jones! |

### Sounds [observed; playback rules in audio.md]

| Tick (start–stop) | ConditionalSound | Def | Condition |
| --- | --- | --- | --- |
| 1 | 3998 | `_cut01_01` (raw 97.7 s, Simple, OneShot) | 1 |
| 1–346 | 3000, 3004 | m1_heligen01, m1_heliblad02_vol1 | CutScene_1200.nTick < 345 |
| 347–481 | 3001, 3003 | m1_heliinside01, m1_heliblad01 | 345 < nTick < 480 |
| 476 | 3002 | m1_heliby02 | nTick > 474 |
| 568 | 3005 | land_ground_2 | CutScene_1201.nTick > 7.5 |
| 628–740 | 3006 | m1_trainby01 | CutScene_1202 0..112.5 |
| 934–1221 | 3007 | m1_trainext01 | 306..593.7 |
| 1221–1686 | 3008, 3011, 3012 | office 1 | 593.7..1058.7 |
| 1792–2235 | 3009, 3010, 3013 | office 2 | 1164..1608 |

### Actors [observed from the AI bytecode; executed by the AI runtime]

| AI (soldier) | Where | IDLE action |
| --- | --- | --- |
| 1506 (heli pilot, invulnerable) | Heli_1502 | `AIAction_Patrol(1504)` |
| 1989 (Jones, HumanSoldier_1666, invulnerable) | 'Jones AI jumping off chopper' | `AIAction_PlayAnimation(242)` when `CutScene_1200.nTick > 547` |
| 2022 (soldier on train, invulnerable) | Train_2333 | `AIAction_Patrol(2020)` |
| 3032 (soldier on train, invulnerable) | Train_2099 wagon | `AIAction_PlayAnimation(239)` when `CutScene_1203.nTick > 120` |
| 1898 (Anya, model 015_01_1) | 'Anya HQ' | `AIAction_PlayAnimation(4)` |
| 3091 / 3099 (guards) | 'AIs in base for security cam' | `Patrol(3030)` / `PlayAnimation(41)` |
| 3201 (Jones driving, HumanSoldier_4023, invulnerable) | outro | `PlayAnimation(61)` |

Animation numbers map to clips per [characters.md](characters.md).

### Camera keys [observed; positions in world units, angles in degrees]

**CutScene_1200 Insertion helicopter** — total 18.6000 s, finished at nTick 559

| # | start s | dur s | position | α / β / γ | FOV | smooth | link | target | filter | noise | shake | name |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | 6 | 22664462, -60994444, 174919168 | -102.0 / 0.0 / 0.0 | 1 | Y | 1502 | - | NONE | 0.5 | 0 | Heli tale cam1 |
| 1 | 6 | 3 | 22682578, -61025932, 174956480 | -120.0 / 0.0 / 0.0 | 1 | Y | 1502 | - | NONE | 0.5 | 0 | Heli tale cam1 |
| 2 | 9 | 2.5 | 22694698, -61037572, 174959488 | -114.0 / 11.5 / 18.0 | 1.1 | Y | 1502 | - | NONE | 0.5 | 0 | Heli tale cam1 |
| 3 | 11.5 | 0 | 22694698, -61037572, 174959488 | -114.0 / -17.2 / 23.7 | 1.1 | - | 1502 | - | NONE | 0.5 | 0 | Heli tale cam1 |
| 4 | 11.5 | 4.5 | 22680260, -60985420, 174936640 | -90.0 / -12.0 / -138.0 | 1 | Y | 1502 | - | NONE | 0.5 | 0.003 | Closeup of Jones in heli |
| 5 | 16 | 0 | 22680260, -60985420, 174936640 | -90.0 / -12.0 / -136.3 | 1 | - | 1502 | - | NONE | 0.5 | 0.003 | Closeup of Jones in heli |
| 6 | 16 | 2.6 | 22737976, -58322336, 174616368 | 0.0 / 0.0 / 0.0 | 1 | - | - | 1502 | NONE | 0.5 | 0 | Heli flyby |

**CutScene_1201 Jones jumping onto train** — total 2.2000 s, finished at nTick 67

| # | start s | dur s | position | α / β / γ | FOV | smooth | link | target | filter | noise | shake | name |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | 2.2 | 22189212, -57662084, 174525504 | -96.0 / 0.0 / -48.0 | 1.1 | Y | 1507 | 1666 | NONE | 0.5 | 0.02 | Jones jumping onto train |
| 1 | 2.2 | 0 | 22188996, -57662036, 174526496 | -96.0 / 0.0 / -48.0 | 1.05 | - | 1507 | 1666 | NONE | 0.5 | 0 | Jones jumping onto train |

**CutScene_1202 Speeding train** — total 71.0660 s, finished at nTick 2132

| # | start s | dur s | position | α / β / γ | FOV | smooth | link | target | filter | noise | shake | name |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | 1 | 22533994, -56954592, 174509280 | 0.0 / 0.0 / 0.0 | 1 | Y | - | 1999 | NONE | 0.5 | 0.002 | Train driveby cam |
| 1 | 1 | 2.75 | 22533994, -56954592, 174509280 | 0.0 / 0.0 / 0.0 | 1 | Y | - | 1999 | NONE | 0.5 | 0.0125 | Train driveby cam |
| 2 | 3.75 | 0 | 22533994, -56954592, 174509280 | 0.0 / 0.0 / 0.0 | 1 | - | - | 1999 | NONE | 0.5 | 0.004 | Train driveby cam |
| 3 | 3.75 | 6.45 | 22387540, -57253440, 174513088 | -90.0 / 0.0 / 0.0 | 1 | Y | 2333 | - | NONE | 0.5 | 0.004 | Jones hiding on train |
| 4 | 10.2 | 0 | 22387540, -57253440, 174513264 | -96.0 / 0.0 / 0.0 | 0.9 | - | 2333 | - | NONE | 0.5 | 0.004 | Jones hiding on train |
| 5 | 10.2 | 10 | 22432768, -57370288, 174543936 | 0.0 / 0.0 / 0.0 | 1 | Y | 1999 | 1999 | NONE | 0.5 | 0 | Train total |
| 6 | 20.2 | 0 | 22548252, -56980548, 174534512 | 0.0 / 0.0 / 0.0 | 1 | - | 1999 | 1999 | NONE | 0.5 | 0 | Train total |
| 7 | 20.2 | 0.25 | 24107626, -55684720, 161170112 | -108.9 / 0.0 / 42.0 | 0.85 | Y | - | - | LINE | 1 | 0 | Anya |
| 8 | 20.45 | 0 | 24107626, -55684720, 161170112 | -108.9 / 0.0 / 42.0 | 0.85 | - | - | - | LINE | 0 | 0 | Anya |
| 9 | 20.45 | 15 | 24107626, -55684720, 161170112 | -108.9 / 0.0 / 42.0 | 0.85 | - | - | - | LINE | 0 | 0 | Anya |
| 10 | 35.45 | 0.25 | 24107626, -55684720, 161170112 | -108.9 / 0.0 / 42.0 | 0.85 | Y | - | - | LINE | 0 | 0 | Anya |
| 11 | 35.7 | 0 | 24107626, -55684720, 161170112 | -108.9 / 0.0 / 42.0 | 0.85 | - | - | - | LINE | 1 | 0 | Anya |
| 12 | 35.7 | 3.1 | 22387540, -57253440, 174513088 | -90.0 / 0.0 / 0.0 | 1 | - | 2333 | - | NONE | 0.5 | 0.004 | Jones hiding on train |
| 13 | 38.8 | 0.25 | 24107626, -55684720, 161170112 | -108.9 / 0.0 / 42.0 | 0.85 | Y | - | - | LINE | 1 | 0 | Anya |
| 14 | 39.05 | 0 | 24107626, -55684720, 161170112 | -108.9 / 0.0 / 42.0 | 0.85 | - | - | - | LINE | 0 | 0 | Anya |
| 15 | 39.05 | 14.3 | 24107626, -55684720, 161170112 | -108.9 / 0.0 / 42.0 | 0.85 | - | - | - | LINE | 0 | 0 | Anya |
| 16 | 53.35 | 0.25 | 24107626, -55684720, 161170112 | -108.9 / 0.0 / 42.0 | 0.85 | Y | - | - | LINE | 0 | 0 | Anya |
| 17 | 53.6 | 0 | 24107626, -55684720, 161170112 | -108.9 / 0.0 / 42.0 | 0.85 | - | - | - | LINE | 1 | 0 | Anya |
| 18 | 53.6 | 2.75 | 22387540, -57253440, 174513088 | -90.0 / 0.0 / 0.0 | 1 | - | 2333 | - | NONE | 0.5 | 0.004 | Jones hiding on train |
| 19 | 56.35 | 1.55 | 25011866, -56268904, 174419744 | -101.7 / 0.0 / 18.0 | 1 | Y | - | - | HANDICAM | 0 | 0.02 | Handy cam truck |
| 20 | 57.9 | 2 | 25011866, -56268904, 174419744 | -90.0 / 0.0 / 18.0 | 0.5 | - | - | - | HANDICAM | 0 | 0.0051 | Handy cam truck |
| 21 | 59.9 | 1 | 25011866, -56268904, 174419744 | -90.0 / 0.0 / 18.0 | 0.5 | Y | - | - | HANDICAM | 0 | 0.005 | Handy cam truck |
| 22 | 60.9 | 0.7 | 25011866, -56268904, 174419744 | -90.0 / 0.0 / 18.0 | 0.15 | - | - | - | HANDICAM | 0 | 0.003 | Handy cam truck |
| 23 | 61.6 | 0.5 | 25011866, -56268904, 174419744 | -90.0 / 0.0 / 18.0 | 0.15 | Y | - | - | HANDICAM | 0 | 0.0035 | Handy cam truck |
| 24 | 62.1 | 4.5 | 25011866, -56268904, 174419744 | -90.0 / 0.0 / 18.0 | 0.1 | - | - | - | HANDICAM | 0 | 0.00125 | Handy cam truck |
| 25 | 66.6 | 0.5 | 25011866, -56268904, 174419744 | -90.0 / 0.0 / 18.0 | 0.1 | Y | - | - | HANDICAM | 0 | 0.00225 | Handy cam truck |
| 26 | 67.1 | 3.451 | 25011866, -56268904, 174419744 | -89.4 / 0.0 / 18.0 | 0.12 | - | - | - | HANDICAM | 0 | 0.00125 | Handy cam truck |
| 27 | 70.55 | 0.515 | 25011866, -56268904, 174419744 | -90.0 / 0.0 / 18.0 | 0.1 | Y | - | - | HANDICAM | 0 | 0.0045 | Handy cam truck |
| 28 | 71.07 | 0 | 25011866, -56268904, 174419744 | -102.0 / 0.0 / 18.0 | 0.11 | - | - | - | HANDICAM | 0 | 0.01 | Handy cam truck |
| 29 | 71.07 | 0 | 25011866, -56268904, 174419744 | -102.0 / 0.0 / 18.0 | 0.1 | - | - | - | HANDICAM | 1 | 0.0045 | Handy cam truck |

The Anya keys sit 3.2 km below the terrain, where the "Anya HQ" set is built
[observed].

**CutScene_1203 Jones jumping off train** — total 5.4000 s, finished at nTick 163

| # | start s | dur s | position | α / β / γ | FOV | smooth | link | target | filter | noise | shake | name |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | 4 | 24303650, -55722580, 174439424 | -96.0 / 0.0 / -138.0 | 1 | Y | - | - | NONE | 0.5 | 0 | Train drives into base |
| 1 | 4 | 0 | 24303650, -55722580, 174456560 | -102.0 / 0.0 / -132.0 | 0.9 | - | - | - | NONE | 0.5 | 0 | Train drives into base |
| 2 | 4 | 1.4 | 24353382, -55799036, 174435072 | 0.0 / 0.0 / 0.0 | 1 | - | 3555 | 3031 | NONE | 0.5 | 0 | Jones jumps off train - Yiiiihaaa! |

## 5. Level-1 outro (truck)

**CutScene_1204** — total 25.0000 s, finished at nTick 751 (CC_4007 'Outro
Cutscene' runs while `EditVariable_199.nValue == 1 && !CutScene_1204.isFinished`)

| # | start s | dur s | position | α / β / γ | FOV | smooth | link | target | filter | noise | shake | name |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 0 | 12 | 24939228, -56142056, 174418944 | 0.0 / 0.0 / 0.0 | 0.9 | Y | - | 1099 | NONE | 0 | 0 | Truck out of garage |
| 1 | 12 | 0 | 24921682, -56145144, 174450240 | 0.0 / 0.0 / 0.0 | 1.1 | - | - | 1099 | NONE | 0 | 0 | Truck out of garage |
| 2 | 12 | 10 | 24921682, -56145144, 174450240 | 0.0 / 0.0 / 0.0 | 1.1 | Y | - | 1099 | NONE | 0 | 0 | Truck out of garage |
| 3 | 22 | 0 | 24921682, -56145144, 174450240 | 0.0 / 0.0 / 0.0 | 0.95 | - | - | 1099 | NONE | 0 | 0 | Truck out of garage |
| 4 | 22 | 3 | 24921682, -56145144, 174450240 | 0.0 / 0.0 / 0.0 | 0.95 | Y | - | 1099 | BAND | 0 | 0 | Truck out of garage |
| 5 | 25 | 0 | 24921682, -56145144, 174450240 | 0.0 / 0.0 / 0.0 | 0.95 | - | - | 1099 | BAND | 0 | 0 | Truck out of garage |

Every key looks at the truck (target 1099), so the camera tracks it while the
position interpolates. With the player entering area 200 on tick S
[observed with `MissionRuntime`]:

| Tick | Event |
| --- | --- |
| S | EditVariable_199 = 1 (it is after AreaActivate_200 in the tree); CC_4007 starts: Jones-driving soldier 4023 and outro sounds enter, CutScene_1204 key 0; CC_1495 stop tick |
| S+1 | EditVariable_105 = 1 (it is **before** the area: one-tick lag); objective 1 complete; player subtree leaves the world; truck AnimTask starts (re-sends nTick 0); `m1o_truck`, `m1o_baseamb`, `m1o_wind` start (`CutScene_1204.nTick > 0`) |
| S+211 | `m1o_train1` (nTick > 210) |
| S+331 / S+341 | gates 401 / 400 start opening (`CutScene_1204.nTick > 330` / `> 340.5`; the gates are earlier in the tree than the cut-scene), fully open 60 ticks later |
| S+751 | CutScene_1204 finished → LevelFlow.isComplete = 1 |
| S+752 | Game task sees isComplete (`FUN_00415306`): loading screen, next mission = −1 → main menu ([hud.md](hud.md) §7) |

The truck is driven by its AnimTask (63 records: channel 1 throttle 0.125 →
0.25 → 0.375, channel 0 steering ±1) through the car physics, which were not
recovered.

## 6. Mission flow

**Start** [recovered + observed]: Flow 4 (`FUN_004157f0`) builds the game;
level load sets the cut-scene clock (30), the overlay parent and camera,
runs `objects.qsc` with frequency 30, then compile. LevelFlow's create
loads the in-game menu. Initial states: everything as created (sections
above); all ConditionalContainers have their children in the world until
tick 1. Player spawn = `HumanPlayer_0` (24578514, −55852816, 174421680),
gamma 3.096 rad, team 0, loadout binoculars (slot 0), MP5SD (slot 0), Glock
(slot 1), knife (slot 1), 49 × 9 mm (`AddAmmo`).

**Objective**: `EditVariable_105` (Add = `nValue == 0 &&
AreaActivate_200.nActive`) → `DefineComputerObjective_104` objective 1
complete. Its only effect is the map computer list; no message.

**Mission complete**: `LevelFlow_10.Complete = CutScene_1204.isFinished`.
The outro is reached only through `EditVariable_199` (Add =
`AreaActivate_200.nActive && nValue == 0 && !Car_1099.isExploded`).

**Mission failed**: `LevelFlow_10.Failed = StatusMessage_1391.isSendt`;
1391 (in the gameplay container, radio style, sound "message") sends
`MISSION_FAILED` when `HumanPlayer_0.isDead || Car_1099.isExploded ||
HumanSoldier_4023.isDead`. LevelFlow sets isFailed on the same tick (it is
later in the tree) and forces isComplete = 0. The in-game menu then opens
after 151 ticks, or on Space/Return when dead ([hud.md](hud.md) §7).
HumanSoldier_4023 (Jones driving) is out of the world except during the
outro [observed].

**Alarm** [observed with the recovered rules]: a camera's 90-tick sighting
(tick D) → SCameraControl_90.isDetection on D (it is after the SCameras) →
AlarmControl_98.isTrigger and EditVariable_97 = 1 on D+1 → isAlarm on D+2 →
alarm loops 96/93 and radio M1_MSG_5 on D+2; soldiers react through
`AIFunction_GetAlarmControlStatus`. SCameraControl_91 does the same for any
of soldiers 2205–2216's `isDetection`; any alarm pad (Switch 94/92/99)
triggers it too. A pad pressed during the alarm resets EditVariable_97
(Sub), switching the alarm off.

**Cameras offline**: hacking Terminal 501 or 502 makes `LevelTimer_95` run
(Reset by `isHackedThisTick`, which lasts 3 ticks); every SCamera's On is
`!LevelTimer_95.isRun || LevelTimer_95.nTick > 3600`, so cameras are off for
120 s; CAMERASOFFLINE_2MIN at timer tick 1, _1MIN at 1800.

## 7. Integration notes: a task runtime for the engine

`MissionRuntime` implements this; the engine supplies a `MissionHost`.

1. **Load**: `readMissionTasks(objects.qvm)` → `new MissionRuntime(tasks,
   host)`. The constructor creates every task's state, registers members for
   ids ≥ 0, then compiles in pre-order (CutScene nTick = 30 × Start time;
   AnimTasks rewind and send nTick 0 to their vehicles). Capture each
   camera link task's pose now (`applyCameraLink`'s `initial`).
2. **Each 30 Hz tick**: `runtime.tick()`. It returns immediately when the
   mission is complete (then run the hand-over of [hud.md](hud.md) §7) or
   when `paused` (in-game menu). Otherwise it walks the tree in pre-order
   with each type's child rule, then increments `levelTick`.
3. **Humans, AI, weapons, pickups, vehicles' physics** are the engine's:
   implement `host.updateTask(node)` so they update at their exact place in
   the walk (e.g. the player inside ConditionalContainer_1495, soldiers
   inside it after the player). Publish their members through
   `host.value(name)`: `HumanPlayer_0.isDead`, `HumanSoldier_<id>.isDead`,
   `HumanAI_<id>.isDetection`, `Car_1099.isExploded`.
4. **World membership**: `host.onContainerWorld(container, inWorld)` —
   hide/remove the subtree's objects (render, collision, AI) when false;
   restore when true. On tick 1 this removes the player for the intro.
5. **Area tests**: `host.humans()` = every human's origin (+0x20, pelvis)
   and team, as stored before the tick's own updates.
6. **Interactions**: player/AI "use" → `useDoor(node)`, `pressSwitch(id)`,
   `useTerminal(id)`; hack finished → `hackTerminal(id)`; damage on an
   explosive → `detonate(node)`; lock picked → `pickDoorLock(node)`.
7. **Cut-scenes**: on `host.onCutSceneCamera(sample, cut)`: apply the link
   (`applyCameraLink` with the link task's current pose) and the target
   (`cameraLookAt` to the target's origin) per the sample's `link` /
   `target`; add shake; set the view with horizontal tangent `sample.fov`
   (vertical = 0.75 × that, 4:3); draw letterbox bars of
   `letterboxBarHeight(H, sample.viewportFactor)`; pass the current key's
   FILTER, own colour, the interpolated colour / Noise and `sample.cut` to
   `CutsceneFilters.apply`, and after the tick call `endTick` with the
   cut-scenes that applied / stopped (the engine does this in
   `mission-system.ts`; `render/cutscene-filters.ts` draws them every frame).
   Give this camera priority over the player camera for that frame. Hide the
   player HUD while a cut-scene camera is active; keep status messages.
8. **AnimTasks**: trains are handled inside the runtime (`trainStateAt`
   gives distance along rail spline 1500; place wagons along the spline);
   heli/car inputs arrive in `host.onAnimInput(anim, nTick, channels)`
   (nTick 0 = reset to the task's initial pose).
9. **Messages and sounds**: `onStatusMessage` → the HUD's StatusMessageScreen
   ([hud.md](hud.md) §5); `onSound(sound, start)` → audio rules of
   [audio.md](audio.md) §5; keep re-submitting Simple voices while their task
   updates, and stop them when it stops updating (skip).
10. **Script calls**: `host.call("MenuManager_SetEnabled", [b])` (enable /
    disable the in-game menu on Esc), `host.call(
    "StatusMessageScreen_ClearMessages", [])`; `host.escapePressed()` = Esc
    held this tick.

## 8. Validation

`python tools/igi_mission.py --timeline` (from the repository root) prints the
inventory, cut-scene totals, actor scripts and the intro timeline, then runs
self-checks (finish ticks, subtitle ticks, intro hand-over, Esc skip, outro
and completion, failure, alarm):

```
missions/location0/level1/objects.qvm (tools/level_tasks.py): 1362 tasks, 59 types, 113 conditions
CutScene_1200 'Insertion helicopter': 7 keys, total 18.600000 s, finishes at nTick 559
CutScene_1201 'Jones jumping onto train': 2 keys, total 2.200000 s, finishes at nTick 67
CutScene_1202 'Speeding train': 30 keys, total 71.065987 s, finishes at nTick 2132
CutScene_1203 'Jones jumping off train': 3 keys, total 5.400000 s, finishes at nTick 163
CutScene_1204 '': 6 keys, total 25.000000 s, finishes at nTick 751
self-checks: all passed
```

`npx vitest run tests/mission.test.ts` (16 tests): synthetic checks of the
matrix convention, the area test, Hermite, link/look-at, letterbox,
AnimTask playback, train ramp and door motion; level-1 checks of the
inventory, cut-scene timelines and finish ticks, the intro chain and subtitle
ticks, the Esc skip, the alarm chain, the truck outro to mission complete,
failure on death and the intro train speed. The Python and TypeScript
runtimes produce the same intro timeline.

## 9. Open questions

- **Vehicle physics**: the heli (`FUN_004310b0`) and car (`FUN_0042df40`)
  rigid-body steps and their physicsobj configs were not recovered, so the
  heli and truck paths of the cut-scenes cannot yet be reproduced exactly
  (camera keys linked to / targeting them depend on those paths).
- **Rail spline**: wagon placement along SplineObj 1500 (`FUN_004f5830`,
  precomputed segment tables) was not reimplemented.
- **Camera shake**: the exact shake angle assignment was not traced. (The
  filters and the time of day are recovered, §2 "Camera filters".)
- **Filter details**: the band texture's magnification filter is inherited
  render state (point assumed); the overlay root's update order relative to
  the Level root within a tick, and D3D's last-pixel rule for the bracket
  lines, are inferred.
- **Building / EditRigidObj** child updates are inherited from a base class
  not traced (they must update, since their doors move) [inferred].
- **Damage paths**: closed for ExplodeObject's countdown, the car's
  destroyed flag and SCamera.isExploded (the lens takes 0.5 damage) in
  [damage.md](damage.md). The lock-pick and hack durations are in
  [interactions.md](interactions.md).
- **SCamera lists**: recovered (see "SCamera vision"): +0x1a0 = alive
  humans of another team, +0x1ac = dead team-1 humans and destroyed SCameras.
  Ported since: other humans on a camera's sight ray (`cameraLineOfSight`
  adds `enemies.sightHits`), the application tick (`ctx.appTick`; game.ts
  must keep it: 0 with ctx.tick at a mission (re)start, +1 per fixed-step
  iteration while a mission is active, paused or not), the soldiers' phases
  from the same `perceptionPhases` map (`mission.perceptionPhase(aiTaskId)`).
  Not ported: the SCamera sounds (`FUN_00440ca0`); the Car / Heli /
  AIStationaryGunHolder detectors (here they only advance the counter).
- **Human list**: whether `DAT_005c115c` (AreaActivate humans) drops dead or
  out-of-world humans was not checked; level 1 is not affected (the areas
  that matter count the player).
- **Overlay quirk**: the letterbox overlay is never resized after creation;
  with non-zero fades the bar would freeze at its first size. Level 1 has no
  fades.
