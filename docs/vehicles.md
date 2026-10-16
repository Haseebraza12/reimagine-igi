# Vehicle physics: helicopter, car / truck, trains on the rail spline

This document describes how `igi.exe` moves vehicles: the shared rigid body,
the helicopter (`Heli`), the car / truck (`Car`), and the train with its
wagons along a `SplineObj`, plus a replay of the level-1 intro and outro that
checks the result against the cut-scene cameras.

- Implementation: `web-port/src/loaders/vehicles.ts` (`HeliSim`, `CarSim`,
  `RailSpline`, `placeTrain`, `readPhysicsObjTypes`, `driveFromAnimTask`).
- Python reference, level-1 replays and self-checks: `tools/igi_vehicles.py`
  (stdlib only).
- Tests: `web-port/tests/vehicles.test.ts`.
- Related: [mission.md](mission.md) (task runtime, AnimTask playback, the
  intro / outro timelines and camera keys), [formats.md](formats.md)
  (coordinates, models), [collision.md](collision.md) (collision sets, rays),
  [audio.md](audio.md) (vehicle sounds), [gameplay.md](gameplay.md).

Evidence labels:

- **[recovered]**: read from `igi.exe` code; addresses are Ghidra `FUN_` names,
  image base 0x400000; constants are read from the executable.
- **[observed]**: measured on the shipped files by `tools/igi_vehicles.py`.
- **[inferred]**: reasoning only.

Units: IGI world units (4096 = 1 m), z up, 30 ticks per second. Velocities are
units/tick, forces units·mass/tick². Matrices are row-major `float[9]` at
object +0x70 with world = M·local (columns are the local axes).

## 1. Overview

**Vehicles move only when their AnimTask steps** [recovered, mission.md §2].
The AnimTask sends its 34-float channel state with the current nTick to the
target (message 0x54a262, `FUN_004eace0`); the handler is the vehicle's
"AnimTask input":

| Vehicle | Input | nTick 0 | nTick > 0 |
| --- | --- | --- | --- |
| Train | `FUN_0042a450` | reset distance / thrust, place | thrust ramp, distance += speed, place (`FUN_004296d0`) |
| Heli | `FUN_00430df0` | reset pose, body, thrust | attached rotors (`FUN_004eb2c0`), physics `FUN_004310b0` |
| Car | `FUN_0042dcb0` | reset pose, body, contact points | physics `FUN_0042df40` |

The vehicle writes back into the AnimTask's channel buffer at nTick 0 (heli:
ch3 = −1, ch4 = −2, ch0..2 = 0; car: ch1 = −1, ch2 = −2; train: ch1 = −2), so
"−1 = keep" holds until a record sets the channel again [recovered].

Per-tick numerics [recovered from the asm]: positions are doubles (+0x20);
matrices, velocities, forces and spline points are float32 struct fields;
intermediate expressions run on the x87 stack. Both implementations round
with float32 wherever the exe stores to a float and compute in double between
(TS and Python agree to the bit on the level-1 replays; neither reproduces x87
extended precision exactly).

## 2. The rigid body (object +0xf0) [recovered]

| Body offset (object) | Field |
| --- | --- |
| +0x00 (+0xf0) | mass |
| +0x04 (+0xf4) | 1 / mass |
| +0x08 (+0xf8) | speed = approximate \|v\| (`FUN_004a8cf0`: max + 0.414213568 mid + 0.317837238 min of \|x\|, \|y\|, \|z\|) |
| +0x0c..+0x14 | inverse inertia (diagonal, body frame) |
| +0x18..+0x20 (+0x108) | velocity (world, float) |
| +0x24 | unit velocity |
| +0x30..+0x38 (+0x120) | angular momentum (**body frame**) |
| +0x48..+0x50 (+0x138) | angular velocity (world), from the last integration |
| +0x54 / +0x5c / +0x60 | pending force list {force xyz, point xyz, both body frame}, count, last count |

- **Setup** (`FUN_004f2320` → `FUN_004e3a50` → `FUN_004e3160`): mass = type
  mass; inertia of the type's box (size × 4096): Ix = m (y² + z²) / 12 etc.;
  the inverse inertia is multiplied by 1.01 (0x5322c4); velocities, momentum,
  speed and forces are zeroed (`FUN_004e31e0`).
- **Add force** (`FUN_004e3ad0`): append (F, p).
- **Integrate** (`FUN_004e3220`): F = ΣF, τ = Σ p × F (only for p ≠ 0, F ≠ 0);
  v += M (F / m); L += τ; if L ≠ 0: ω_world = M (I⁻¹ L); the orientation is
  converted to a quaternion, advanced by an 8-multiply product with (ω/2, 0)
  (first-order integration of q̇ = ½ ω q per tick), normalised twice and turned
  back into M. Then speed and unit velocity are recomputed (`FUN_004e3930`).
- **Step** (`FUN_004f2d00(obj, g, linear, angular, ...)` → `FUN_004f2bb0`):
  gravity force −g·mass along row 2 of M (world −z in the body frame) at the
  origin, integrate, L ×= angular, v ×= linear, recompute the speed; **the
  position moves by v only when speed > 40.96 units/tick** (0x531730, 0.3 m/s);
  then the body-point collision passes (`FUN_004f25c0` with "Collision
  detection", `FUN_004f3240` test-and-revert) run over the type's contact
  points that are not wheels — none for the level-1 vehicles (the truck's four
  points are its wheels, flagged off by `FUN_0042e1a0`; the Bell type has none),
  so **the level-1 vehicles collide with the world only through their ground
  rays**. g = 44.600887 (immediate 0x4232674f = 9.8 m/s² in units/tick²).
- **At rest** (`FUN_004f33d0`): skip the whole step when contacts > 0, the
  wake flag +0x690 is clear, **no forces are pending (+0x14c = 0)**, speed <
  type +0x2cc and |ω|² < type +0x2d0. Wheel springs and rotor lift are pending
  every tick, so driving vehicles never rest.

| Vehicle step | linear damping | angular damping |
| --- | --- | --- |
| Heli (`FUN_004310b0`) | 1.0 | 0.92 |
| Car (`FUN_0042df40`) | 0.97 | 0.9 |

**Drag** (`FUN_004e2e40(elements, n, 0.000327, body, M, −v)`, immediate
0x39ab7132): u = Mᵀ(−v), q = 0.000327 · approxLen(u)²; each element adds
n (û·n) coef q at its point (flat-plate drag) [recovered].

## 3. Physics object types (`DefinePhysicsObjType`) [recovered layout, observed values]

`FUN_004e4860` registers the script function; its handler `FUN_004e48a0`
fills 0x2d8-byte records at 0x7ef6c8. The vehicle task's "Model" selects the
record with the same model (`FUN_004e4cc0`). 37 calls in 17 scripts under
`physicsobj/` (the TS reader decodes 34; the 3 plane scripts contain argument
expressions the conservative call-tree reader does not evaluate; planes are
unused in level 1).

| Args | Offset | Meaning |
| --- | --- | --- |
| 0, 1 | +0, +4 | task type symbol, index |
| 2 | +8 | mass |
| 3..5 | +0xc..+0x14 | box size (m): inertia |
| 6..8 | +0x18, +0x38, +0x138 | name, description, model |
| 9, then 6 per point | +0x148, +0x14c.. | contact points {magic vertex, side (+0x150), int, f, lateral grip (+0x15c), rolling grip (+0x160)} |
| next 2 | +0x2cc, +0x2d0 | rest speed, rest angular speed² |
| rest | +0x2d4 → config | parsed by the class handler (message `DAT_00549cb8`) |

Base vehicle config (`FUN_004f9e10`, 0x118 bytes): cfg[0..9], then n drag
elements of 7 args {coef, px, py, pz (m), nx, ny, nz} (stored as coef, unit
n, p × 4096 by `FUN_004e3050`), then the view cone (length × 4096, two angles
× ½ deg→rad). Car (`FUN_0042cda0`, after the base): n wheels of 6 args
{steerable +0x11c, driven +0x11d, max steer deg +0x120, contact point +0x124
(< 0: no physics; the wheel model shows contact −10−k), travel × 4096 +0x128,
spring +0x12c}, suspension offset × 4096 (+0x25c), wheels-from-model flag
(+0x260), differential flag (+0x261), sound (+0x262), explosion vertices
(+0x2ac/+0x284), wreck model (+0x2b0). Rotor (`FUN_0042ccc0`, no base): main
byte, tail byte, spin sign (int), arg × π/180, spin per tick, model. Wheel
(`FUN_0042f100`): model, radius × 4096, arg × 4096. HeliWheel magic objects
(`magicobj.qvm`, `FUN_00426440`): [1] = arg0 × 4096, [0] = arg1 × 4096.

Level-1 values [observed]:

| Type | Values |
| --- | --- |
| Heli 709_01_1 (`helis/bell`) | mass 3000, box 2.2 × 7.8 × 3 m, no contact points, rest 68 / 0.001; cfg = 200, 50 (pitch gain), 0.4 (pitch smoothing), 50 (roll gain), 0.4, 50 (yaw gain), 0.4, 3000, 0.027 (thrust step ≥ 0.8), 0.003 (thrust step < 0.8); drag (coef, normal) = (20, x), (3, y), (50, z) at the origin |
| Rotors 711_01_1 / 712_01_1 | main rotor (spin 1 × 0.1 rad/tick × thrust) / tail rotor (10 × 0.12) |
| HeliWheels 709_02_1, 709_03_1 | ray depth 0.3 m (1228.8), stiff zone 0.15 m (614.4); ATTA at (±5.4, 5.2, −1.16) m and (±5.4, −0.83, −1.25) m |
| Car 622_01_1 (`cars/cutscene_truck`; `cars/truck` defines 610_01_1) | mass 3000, box 2.2 × 7.8 × 3 m, 4 contact points = magic vertices 0..3 (corners, grips 0.95 lateral / 0.05 rolling), rest 30 / 0.001; cfg[6] steering smoothing 0.95, cfg[7] drive 5000, cfg[8] thrust smoothing 0.95, no drag; 6 wheels: 0 and 3 steerable (45°) and driven on contacts 1 (front left) and 2 (front right), 1 and 5 free on contacts 0 and 3 (rear), 2 and 4 visual only (−10, −13 → contacts 0, 3); travel 0.3 m, spring 0.5; suspension offset 0.2 m; wheels from model (6 × 600_02_1, radius 0.5 m) |
| Train models 605..609_01_1 | magic vertices 0 / 1 at x = −34652.4 / +34457.5: car length 69109.9 units (16.87 m), origin fraction 0.50141 |

## 4. Helicopter [recovered]

Class `Heli` (0x539e08): create `FUN_004307c0` (Original Thrust default 1),
update `FUN_00430950` (sounds, explosion, view cone; no motion), compile
`FUN_00431bd0` (model, `FUN_004f2320`, thrust = target = Original Thrust,
pose = "Position" / "Orientation", attached objects re-created), AnimTask
input `FUN_00430df0`, physics `FUN_004310b0`. The model's ATTA magic objects
become attached children (+0xe8): `Rotor` (`FUN_0042c750`, placed by
`FUN_0042c990`) and `HeliWheel` skids (placed by `FUN_004270b0`).

Input (`FUN_00430df0`): if ch3 ≠ −1: target = ch3; inputs (+0x734..) = ch0,
ch1, ch2. nTick 0: pose = initial, body set up, thrust = target = Original
Thrust, controls 0, v = M · "Speed", channels written back. nTick > 0: the
rotors update (with the **previous** tick's thrust), then:

1. **Thrust ramp**: step = cfg[8] (0.027) if thrust ≥ 0.8 else cfg[9]
   (0.003); thrust moves toward the target by the step without overshoot;
   below 0.001 with target 0 it snaps to 0.
2. **Controls**: c_k = s_k c_k + (1 − s_k) input_k with s = cfg[2], [4], [6].
3. **Control forces** (when any c ≠ 0 and (no skid contact or speed > 2)):
   (0, c0 · cfg[1] · m · (−0.8), 0) at (0, 0, 0.2 m) — forward/back push and
   pitch; (c1 · cfg[3] · m, 0, 0) at (0, 0, 0.1 m) — sideways push and roll;
   (c2 · cfg[5] · thrust · m · 0.08, 0, 0) at (0, 3 m, 0) — yaw.
4. **Weathervane** (no contact and speed > 2): tilt = (local x horizontal
   direction) · (local z); M = M · Rx(∓0.7 · tilt · cfg[5] · 2.9089e−4) (sign
   by whether the heli is upright). The rotation is about local **x** although
   the measured tilt is a roll — implemented literally.
5. If not at rest: **skid contacts** (`FUN_004317d0`, below), drag, step
   (g, 1.0, 0.92).

Rotor (`FUN_0042c750`): a main rotor adds lift F = m g thrust along local z
plus cos(angle(y_h, z)) · F along local y (y_h = local y projected on the
horizontal: a forward push proportional to the nose-down tilt), both at the
origin; main and tail rotors add ±2.5 m thrust along local x at (0, 2 m, 0)
(only without ground contact) — with both rotors present these cancel
exactly. So **thrust 1 hovers exactly** (lift = weight). Spin angle += sign ×
spin × thrust.

Skids (`FUN_004317d0`): per HeliWheel a vertical segment from 2 m above the
skid point to 0.3 m below (`FUN_004c24c0`). Hit at distance d:
d ≥ 2 m + 0.15 m → spring force m g/4 (0.3 m − (d − 2 m)) / 0.3 m; else
stiff force m g/4 (2 − d / (2 m + 0.15 m)) and the heli is lifted by the
deepest penetration (2.15 m − d) — but only if the last contacting skid in
ATTA order was the stiff kind (the flag is overwritten per skid). Each
contact damps v by (0.95, 0.95, 0.97) and L by 0.98 immediately.

## 5. Car / truck [recovered]

Class `Car` (0x539d58): create `FUN_0042d420`, update `FUN_0042d5c0` (sound,
explosion `FUN_0042d840`, attached children; no motion), compile
`FUN_0042e7d0` (+ `FUN_0042ea60`: driven / steerable counts; with the
wheels-from-model flag the model's `TASKTYPE_WHEEL` objects claim wheels 0,
1, … in ATTA order, `FUN_0042f280`), AnimTask input `FUN_0042dcb0`.

Input: if ch1 ≠ −1: thrust target = ch1; steering target = ch0; brake = (ch3
≠ −1). nTick 0: pose = initial, body set up, contact points re-read from the
model's magic vertices and the wheel points lowered by the suspension offset
(`FUN_0042ded0`), thrust = target = Original Thrust, steering 0. nTick > 0
(`FUN_0042df40`):

1. thrust = 0.95 thrust + 0.05 target; steer = 0.95 steer + 0.05 target;
   thrust snaps to 0 below 0.01 with target 0.
2. **Suspension** (`FUN_0042e1a0`), per present wheel with a contact point: a
   vertical segment from travel + 1 m above the (lowered) contact point to
   0.5 m below it. Compression c = travel + 1 m − d; a hit within the top metre
   is full travel with force × (2 − d/4096) and lifts the car by 1 m − d.
   Spring force (c / travel) · spring · m · g along local z at the contact
   point. The compression is smoothed for the wheel model (0.95/0.05 when
   extending). For a touching wheel: normal = hit normal, wheel point =
   contact point + 0.4 m up, contacts = 1, then drive and friction.
3. **Drive** (`FUN_0042ff90`, driven wheels in contact, thrust ≠ 0): force
   (cfg[7] · thrust · g / n_driven − speed) along (n × y) × n (the forward
   axis projected on the ground), converted to the body frame and turned by
   Rz(−steer), at the wheel point; steer = max steer · π/180 · steering.
4. **Tyre friction** (`FUN_0042fbe0`): u = unit tangential velocity of the
   contact point (v + ω × r, opposed); in the wheel frame Rz(steer) the
   lateral component × lateral grip (0.95), the rolling one × rolling grip
   (0.05; = lateral when braking, and the thrust decays × 0.95); static force
   |v_t| m 0.1 while |v_t| ≤ 4 g n_z, else kinetic 0.24 m g n_z.
5. If not at rest: step (g, 0.97, 0.9). Wheel models (`FUN_0042f440`,
   `FUN_0042f8c0`): spin rate from the contact point speed (or the drive for
   airborne driven wheels), 0.7/0.3 smoothed, steer angle −max·steer·π/180,
   height = ATTA z + compression − suspension offset.

Equilibrium on flat ground: four springs carry m g at half travel, so the
truck rests with its origin 173.5 units (4 cm) above the floor.

**Explosion** (mission.md §2): after the destroyed flag (+0x91c) the car
spawns fragments at the explosion vertices, waits 10 or 30 ticks, replaces
itself with the wreck model and sets `isExploded`; what sets +0x91c (damage)
was not traced.

## 6. Train and rail spline [recovered unless marked]

**Train** (class `DAT_0057f1f0`): create `FUN_00429390`, compile
`FUN_00429560` (car length = |x0 − x1| of model magic vertices 0 and 1
(+0x74c), origin fraction |x0| / length (+0x748), distance = "Position"),
update `FUN_0042aa90` (sound only), input `FUN_0042a450` (mission.md: thrust
ramp by ThrustStep, speed = MaxSpeed (km/h) × thrust × 37.926 units/tick,
distance −= speed with Flip Direction). Wagons are the **child Train tasks**
in file order (`FUN_00401c20` / `FUN_00401c80`); their own speed parameters
are unused.

**Rail spline** (`SplineObj` + `SplineObjWaypoint`): waypoint k ≥ 1 owns the
segment from waypoint k−1 to k (`FUN_004db070` called from the waypoint
compile at 0x4f8361 with the previous waypoint's pose, this waypoint's
"Segment Model" and piece count +0x198 — "NumAreas", clamped to
min(NumAreas, SplineObj "Number of Matrices / Segment", 20) [recovered:
schema 0x4f91be..0x4f92ee, clamp 0x4f8098; section 11]). `FUN_004db1d0`: per axis a cubic Hermite (`FUN_00511e70` /
`FUN_00511ed0`) from p0 to p1 with tangents = column 0 (local x) of each
waypoint matrix (Rz γ · Ry β · Rx α) × the **3D** chord, sampled at s = i/n,
i = 0..n, stored as float points relative to the segment midpoint; piece
lengths are float chords; the segment length is their float sum; the
spline's total (+0x28) is the float sum of the segment lengths (0x4f8905).
Linear splines use one straight piece. The SplineObj compile (`FUN_004f9360`)
rotates all waypoints about the first by Rz(gamma − π) when "Gamma
Orientation" differs from the π it was created with (0x4f9300); level 1's
3.1415929 is one float ulp above π (≤ 0.75 units of change) [trigger
inferred].

**Evaluation** (`FUN_004f5830(spline, 0, out, &ok, distance, n, offsets,
0)`): the distance is wrapped into [0, total) (float), so **trains run in a
loop**; point 0 is at that arc length on the polyline (linear within a
piece); point j+1 is at **Euclidean** distance |offset j| from point j,
searched forward (offset > 0) or backward along the pieces and solved on the
crossing piece with the laws of cosines and sines (degenerate case: linear);
while the current piece end is still farther than the offset, the arc
estimate distance + Σ offsets is used instead. Past the spline's end the
points clamp to the last (first) point.

**Placement** (`FUN_004296d0`, `FUN_00429bd0`): offsets = +length per car
with Flip Direction, −length otherwise; car j sits between points j and j+1:
d = p1 − p0, the frame of `FUN_004aa2f0` (rows A = unit(r × d), B = d × A,
C = A × B with r = unit(dy, −dx, 0)) shuffled and transposed to columns
(−Ĉ, B̂, Â): local x points from the back coupling to the front (the direction
of travel of a flipped train), local z up; origin = p0 + frac (p1 − p0) +
M (0, Displacement X, Displacement Y) × 4096.

Level 1 [observed]: SplineObj 1500 has 12 waypoints, 11 segments, 130 pieces,
total 4,461,265 units (1089.2 m; float32 sums chopped, as the FPU runs in chop mode). The placed locomotives of trains 1499, 1501,
1999 and 2099 lie within 3 units (< 1 mm) of the positions the editor stored
in their AnimTasks (a strong check of the spline, the chord search and the
origin fraction); the AnimTask orientations are the train's rotated by −90°
about z (editor convention [inferred]; it cancels in camera links).

**Drawing**: trains use the polyline (n pieces); the segment models are
deformed onto the same polyline with one frame per point (section 11). The
port's former inferred drawing ((cos γ, sin γ) × the horizontal chord as
tangents, linear z, the start waypoint's "Segment Model") was replaced; it
was up to 4.7 m off on segment 6 (the ramp after waypoint 5, β = −15°).

## 7. Level-1 replay [observed: `python tools/igi_vehicles.py`]

The replay runs the Python mission runtime (`tools/igi_mission.py`) from the
first tick, drives every vehicle from its AnimTask, and enters the outro by
putting the player in area 200 at tick 2950. Ground: the terrain octree with
HeightMap relief plus the set-0 collision of the static models near the base
(the garage floor is 0.19 m above the terrain). Positions in metres from the
`HumanPlayer_0` spawn (x east, y north, z up):

| Vehicle | Ticks | Path |
| --- | --- | --- |
| Heli 1502 (CutScene_1200) | 2..561 | from (−463, −1254, 126) north at ~39 m/s, descending to 27 m (≈ 9.5 m above the terrain at tick 361), climbing to 56 m; ends (−440, −523, 54) |
| Heli 1508 (CutScene_1201) | 583..628 | hovers at (−578, −442, 26), drifts 3 m |
| Train 1501 (CutScene_1200) | 2..561 | 70 km/h north-east from (−553, −378, 20) to (−383, −60, 20) |
| Train 1507 (CutScene_1201) | 561..628 | starts at the same spot, accelerates 0.05 → 0.2–0.4 thrust |
| Train 1999 + wagons (CutScene_1202) | 628..2760 | 100 km/h; reaches the base (x ≈ +145 m) at tick ~1528, wraps to the far end of the spline at ticks 1558 and 2728 |
| Train 2099 (CutScene_1203) | 2760..2950 | into the base from (4, 14, −2) to (52, −18, −2) |
| Truck 1099 (CutScene_1204) | 2952..3701 | settles 12 cm, drives south out of the garage (92, −57) → (92, −65) by nTick 182, swings west to (86, −76) and back east through the main gate opening (gates 400/401 at x 97.9 m, y −89.3..−85.3 m) at nTick ≈ 443, about 40 ticks after both gates are fully open (nTick 391 / 401), then south to (103, −129) at nTick 751 |

Camera framing (screen x, y in [−1, 1], `framing()` in the tool):

| Cut-scene key | Vehicle | Result |
| --- | --- | --- |
| 1200 keys 0–4 ("Heli tale cam", linked to 1502) | trains 1501 / 1999 / 1507 ahead | in frame at 500–900 m, the heli at the image centre 10–14 m away (keys 1–2) |
| 1200 key 6 ("Heli flyby", fixed camera, target 1502) | 1502 | passes **10.6 m** from the camera (closest at nTick ≈ 510) |
| 1201 key 0 (linked to train 1507, target Jones) | heli 1508 | 4 m away at the right edge (x 0.78) while Jones jumps |
| 1202 keys 0–1 ("Train driveby cam", target 1999) | 1999 | passes **3.6 m** from the camera |
| 1202 keys 3/12/18 (linked to wagon 2333) | 2333 | fixed at (0.22, 0.44), 6.3 m (rigid link) |
| 1202 keys 19–27 ("Handy cam truck", fixed) | truck 1099 (static) | in frame, (0.02..0.21, −0.24..0.41), 46.6 m, through the zoom keys |
| 1203 key 0 ("Train drives into base", fixed) | 2099 / wagon 3555 | in frame on the left (x −0.68..−0.46), 61–105 m, moving away |
| 1204 keys 0–5 (target 1099) | truck | 14.9 → 6.8 m (passing the camera at nTick ~250) → 61.6 m at the end |

## 8. Integration notes for the engine

- **Construction order**: build the `HeliSim` / `CarSim` objects (types from
  `readPhysicsObjTypes` over `physicsobj/**.qvm`, `readMagicObjects`, model
  `readMefMagicVertices` + `readMef(..).attachments`) **before**
  `new MissionRuntime(...)`: its compile already sends nTick 0 through
  `host.onAnimInput`.
- **Per 30 Hz tick**: `host.onAnimInput(anim, nTick, channels)` →
  `vehicle.animInput(nTick, channels, world)`; keep the same `channels` array
  (the vehicle writes back). This happens at the AnimTask's place in the tree
  walk, before the cut-scene camera of the same tick reads the pose. Trains:
  `placeTrain(rail, cars, runtime.trainStateAt(node).distance, flip)` (one
  `RailSpline` per SplineObj, `trainCar` per Train task and child wagon).
- **Cut-scene cameras**: `mission-system.ts` resolves link / target through
  `taskPose(taskId)` with `setTaskPose` overrides, and captures the link
  poses right after the runtime is built. Set the override for 1502 / 1508 /
  1099 inside `onAnimInput`. Train tasks have a scalar "Position" (a
  distance), so `taskPose` must come from `placeTrain` for every car with an
  id (1501, 1507, 1888, 1999, 2333, 2334, 2099, 3555, 1499): compute it lazily
  inside `taskPose` from `trainStateAt` (the runtime updates train distances
  internally and does not call the host), including before the initial-pose
  capture (the compile placement is the link's initial pose).
- **World query**: `castDown(x, y, top, bottom)` over `CollisionWorld.raycast`:
  origin `igiPointToEngine([x, y, top], origin)`, direction (0, −1, 0), max
  distance (top − bottom) / 4096; distance × 4096; normal engine (nx, ny, nz)
  → IGI (nx, −nz, ny). The exe's ray filter skips the vehicle itself: exclude
  the vehicle's own dynamic body (e.g. an ignore-task option); trains and
  other vehicles are hit. Set 0 of the model collision is what these rays
  read (docs/collision.md).
- **Rendering**: done in `engine/world/vehicles.ts` (section 12): every
  vehicle task is placed at its compile pose and moved per tick, rigidly per
  task (keyed by the task's node index, so wagons and doors with id −1 have
  their own handles) and per instance for rotors and wheels (recovered
  transforms, section 12).
- Vehicles hidden by their container (`onContainerWorld`) still keep their
  state; the exe does not update them (their AnimTask does not run).

## 9. Validation

```
python tools/igi_vehicles.py            # types, spline, trajectories, framing, self-checks
python tools/igi_vehicles.py --json     # the same as JSON
python tools/igi_vehicles.py --golden   # TS parity reference values
cd web-port && npx vitest run tests/vehicles.test.ts
```

Self-checks: 37 types; Bell config and drag; truck wheels; box inertia; exact
hover at thrust 1; rail length; couplings at the car length; locomotives at
their AnimTask positions (< 4 units); heli flyby < 20 m; train drive-by <
10 m; truck through the gate opening after the gates open. The TS tests
(11) cover the decoding, the integrator, hover / climb, skid rest, truck
spring equilibrium and driving, straight-rail couplings, the level-1 spline
and train positions, bit-level parity with the Python reference for the
heli 1502 and truck 1099 AnimTask drives, and an intro run through
`MissionRuntime` (flyby and drive-by distances).

## 10. Open questions

- **Body-point collision** (`FUN_004f25c0`, `FUN_004f3490`, `FUN_004f3500`,
  `FUN_004f38c0`) and the post-move test (`FUN_004f3240`, `FUN_004c1c10`) were
  read only far enough to show they do nothing for the level-1 vehicles; their
  response physics is not reimplemented. "Force Z" (+0x6d9) is not modelled.
- **Weathervane axis**: the heli measures a roll but rotates about local x;
  implemented as read. Its effect is small (≤ 0.01 rad/tick).
- The **gamma-quirk trigger** is inferred; the train positions match the
  editor's AnimTask positions with or without the quirk (both < 3 units).
  (NumAreas as the piece count is now recovered, section 11.)
- **Ray semantics**: the result layout of `FUN_004c24c0` (hit flag +0x58,
  distance +0x60, normal +0x38) is recovered from its users; whether the exe
  hits back faces, portal faces or alpha-tested faces on these rays, and the
  exact set of objects the vehicle filter skips, were not traced.
- **x87 precision**: float32 rounding is applied at the stores; extended
  intermediates may differ in the last bits (trajectories could drift slightly
  from the exe over long runs; the replays are not chaotic over a cut-scene).
- The heli type's extra values ("2, 0, 1, 0" for the Bell) and the Mil's
  explosion vertex list, the rotor arg3, contact point fields +0x154 / +0x158
  and the wheel arg +0x2ec ("bounce", `FUN_0042f7b0`) were not traced.
- The AnimTask editor orientation of trains (−90° from the placed train) is
  unexplained.

## 11. Segment drawing (SplineObjSegment) [recovered unless marked]

Implementation: `web-port/src/loaders/spline-segment.ts`; used by
`loaders/level.ts buildSplineSegments` (render geometry and HSMC collision),
tests in `web-port/tests/vehicle-world.test.ts`.

**Type** `SplineObjSegment` (0x5465a8, 0x5b8 bytes, registered at 0x4dae50):
destroy `FUN_004dac20`, draw (method 4) `FUN_004daf30`, which calls the
renderer's "DrawSplineMesh" handler `FUN_0052cfc0` (registered at 0x52c2e2;
message names at 0x54603c..0x5460ac), rays (methods 9 and 10) `FUN_004d8380`,
compile `FUN_004db070` → `FUN_004db1d0`.

**Who owns which segment.** The waypoint compile (0x4f7b10) takes the
previous sibling waypoint (`FUN_00401cc0`, Exec list +4) and, from the second
waypoint on, creates or updates the segment at 0x4f8361 with: the previous
waypoint's position / matrix, its own position / matrix, its own "Segment
Model" (+0x188), "NumAreas" (+0x198), "Flip" (+0x1a4), and linear = SplineObj
"Linear Segments" (+0x4e) or its own "Align" (+0x1a1). The schema
(0x4f91be..0x4f92ee) puts Orientation at +0x110 (matrix), Position +0xf8,
Waypoint Model +0x178, Segment Model +0x188, NumAreas +0x198, Align +0x1a1,
Flip +0x1a4, Automatic Orientation +0x1a5; the SplineObj schema puts Collision
LOD at +0x20, Number of Matrices / Segment at +0x24 (range 2..20, 0x80acf8),
Snap Length +0x4c, Display waypoints +0x4d, Linear Segments +0x4e,
Automatic Orientation +0x4f. Pieces n = min(NumAreas, Number of Matrices /
Segment, 20) (0x4f8098). An empty Segment Model gives no model
(`FUN_004c82b0` returns 0 for "", "missing" for unknown names) and the draw
returns at once: the segment counts for the spline length but is not drawn.
Level 1: the rail's segments are drawn with 322_01_1, 323_01_1 × 3, 368_01_1 ×
7; on cable spline 1 the 25 m span from waypoint 0 to 1 is NOT drawn (waypoint
1 has no Segment Model) and the 1.1 m span 1→2 is [observed].

**Frames** (`FUN_004db1d0`): besides the points p_i (section 6), one float
matrix per point at +0x200 + 0x28 i:
- M_0 / M_n = the start / end waypoint matrices (copied);
- 0 < i < n: the Hermite derivative d (`FUN_00511f00`: d = s c3 + s c3 +
  3 s² c2 + m0 per axis, stored as floats) gives the heading γ = atan2(d_y,
  d_x) (0 when d_x = 0) and pitch β = −asin(d_z / |d|) (`FUN_004a8fe0`; both 0
  when d = 0); the roll α is the waypoints' α (`FUN_004a9f30`: α = atan2(M[7],
  M[8]) wrapped to [0, 2π); gimbal case atan2(−M[5], M[4])) interpolated
  linearly in s (float) after unwrapping the pair to within ±π (0x4db537);
  M_i = Rz(γ) Ry(β) Rx(α) (`FUN_004a9bc0`).
- Linear segments: M_0 = M_1 = Rz(heading of the float chord); the object
  matrix +0x70 = that matrix with column 0 replaced by chord / (x_max − x_min)
  (negated with Flip); +0x520 holds its inverse for the rays.

**Model x range** (+0xfc / +0x100): min(0, min x) and max(0, max x) over the
render vertices of every LOD of the segment model (the loop over the model
list +0x3c at 0x4db8a5). Level 1: 368_01_1 / 323_01_1 −0.004..532480 (130 m),
322_01_1 −0.0007..266240, 320_02_1 −2048..2048 [observed].

**Vertex deformation** (`FUN_0052d340`, the draw's dynamic vertex buffer
fill; `FUN_004d80e0`, applied once to a copy of each HSMC set at compile):
f = (x − x0) · n / (x_max − x_min) with x0 = x_min (Flip: x0 = x_max and f
negated); i = FISTP(f) (chop mode: truncation), i = n → n − 1; t = clamp(f −
i, 0, 1); P = M_i (0, y, z) + p_i, Q = M_{i+1} (0, y, z) + p_{i+1}; v = P +
t (Q − P), stored as float, relative to the segment midpoint. Model x only
selects the place along the polyline; the cross-section (y, z) rides on the
blended frames, so the centreline of the rail is exactly the trains'
polyline. Draw normals = M_i n (not blended). Linear: v = M (x − (x_min +
x_max)/2, y, z) and the normals are copied unrotated. The draw sets a world
matrix of identity rotation at the midpoint (`FUN_0052cfc0`); blocks with
material 0xffff are drawn untextured (SELECTARG2) as in the rigid draw.
Collision: the ray handler `FUN_004d8380` tests the deformed copy
(+0x5a0 / +0x5a8, one per set; linear: the original set through +0x520) and
negates the face normal with Flip. The character hull (set 1) of the rail
models overhangs the render x range (−1236.6..534110 for 368_01_1); those
vertices get |f − i| < 1 beyond an end and collapse onto the end frame
(observed range; beyond one piece the exe would read past its arrays — the
port clamps i, never needed in level 1).

**Change vs the port's former drawing** (same model on the same segment,
level 1, [observed by the port]): rail segment 6 up to 4.72 m (2.36 m
horizontal, 4.69 m vertical), segment 5 up to 3.99 m, the others ≤ 0.11 m;
segments 1, 2 and 5 now use the end waypoint's model (322_01_1, 323_01_1,
368_01_1 instead of 368_01_1, 322_01_1, 323_01_1); the linear cables are
unchanged except the waypoint-ownership change on cable spline 1.

Not modelled (all false in level 1): "Snap Length" (0x4f80c1 moves the
waypoint by the model length), "Automatic Orientation" (0x4f7b48), the
`DrawSplineMesh` lighting parameters "Dirlight Angular / Ambient Effect".

## 12. Vehicles in the engine

Implementation: `web-port/src/engine/world/vehicles.ts` (`createVehicleSystem`,
`vehicleRenderCopies`), `loaders/level.ts` (placement), `loaders/level-vehicles.ts`
(physics types, magic objects, vehicle model data), `engine/mission/mission-system.ts`
(per-tick flow), `engine/world/world-builder.ts` (per-instance transforms,
render copies), tests in `web-port/tests/vehicle-world.test.ts`.

- **Placement** [recovered]: Heli at "Position" / "Orientation" with its ATTA
  children (rotors 711_01_1 → blades 711_02_1 × 2, tail rotor 712_01_1,
  skids 709_02_1 / 709_03_1); Car via `POSE_SPECS`; every top-level Train
  task and its child Train tasks (file order) at `placeTrain(rail, cars,
  "Position", Flip Direction)` on its RailroadQTaskID spline, each car with its
  model's ATTA children (the locomotive's six glass panes; the DeathZone
  605_08_1 is hidden as everywhere). Heli and train placements are not
  mission points (they must not widen the terrain detail region).
- **Keys**: moving entries are keyed by the task's pre-order index (=
  MissionTasks node index = `LevelInstance.taskIndex`); a collision hit on a
  dynamic body reports `triangle = −1 − key`.
- **Per tick**: AnimTask inputs drive `HeliSim` / `CarSim`
  (`MissionHost.onAnimInput`); the ground rays use `CollisionWorld.raycast`
  with `TRI_BULLET` (set 0 + terrain) and `skipBody` = the vehicle's own key.
  After `runtime.tick()` the mission system moves doors, then vehicles
  (`sync`: rigid task transform from the simulated / placed pose, then per
  instance rotors and wheels), then hides dynamic tasks outside the world.
  Train poses come from `trainStateAt(node).distance` (wrapping: trains loop).
  `taskPose` returns vehicle poses (train cars lazily, also before the
  initial link-pose capture).
- **Rotors** [recovered `FUN_0042c750`, `FUN_0042c990`, `FUN_0042b940`]: the
  rotor object stays at its unspun ATTA pose (its collision too). Its angle
  (+0x138) grows by count × spin × thrust per tick (count = the int at rotor
  config +0xc, which `vehicles.ts` names `spinSign`: 1 for the hub, 17 for
  the blades, 10 for the tail rotor). It is drawn count times with
  W Rx(21.362831 · angle + k · spin · thrust) Rz(flap), k = 0..count−1, the
  angle stored as a float after each step (0x42c4c7); flap = clamp(−clamp(1 −
  thrust, −0.1, 1) · arg − (z · v) · 0.0263671875 · arg / (cfg0 · 0.4), ±arg)
  with arg = config +0x4 (5° for the blades, 0 otherwise), z the heli's local
  z axis, v its velocity, cfg0 = 200. Child rotors (the blades) are placed
  from the hub's unspun pose and keep their own angle; that they use the
  heli's thrust is [inferred].
- **Wheels** [recovered `FUN_0042f8c0`, `FUN_004a9680`]: W = W_car Rz(steer)
  Rx(spin) L_atta at the ATTA offset with z + compression − suspension
  offset (`CarSim.wheelPoses`). The wheels' collision faces stay with the
  truck body [approximation: spin, steer and ≤ 0.3 m of compression are not
  applied to them].
- **Containers**: a vehicle whose AnimTask does not run keeps its state; out
  of the world its entries are hidden and its bodies disabled.

Validation (`tests/vehicle-world.test.ts`): rail centreline on the polyline
(< 1 unit at 8 sample distances), recovered model choice, segment-6 vertices
equal to the recovered deformation (< 0.1 mm), a ray hits the deformed set 0;
train compile poses = `placeTrain`; heli 1502 and truck 1099 through
`MissionRuntime` + the engine vehicle system equal the golden values (< 1 /
< 2 units) and the standalone reference driver bit for bit; train car poses
and collision bodies follow `placeTrain` at the runtime's distance; rotor
copy counts and spin step; wheel pose; doors with id −1 have their own
bodies.

---

## Full game: missions 2–14 (full exe)


To be merged into `docs/vehicles.md` (new sections after §12) and the evidence
ledger. All addresses are **full-exe** `FUN_` names (image base 0x400000).
Labels: **[recovered]** read from igi.exe, **[observed]** measured on the shipped
full-game files, **[inferred]** reasoning only.

Implementation: `web-port/src/loaders/plane.ts` (PlaneSim), `src/loaders/car-ai.ts`
(CarAi, VehicleDetector), `src/loaders/vehicles.ts` (attaMatrix, autoOrientMatrix,
RailSpline Position / Automatic Orientation, plane types), `src/loaders/qvm.ts`
(constant-expression arguments), `src/engine/world/vehicles.ts` (planes, CarAI,
car update / explosion / wreck, heli door, sounds, CRITERIA_VEHICLE),
`src/engine/mission/mission-system.ts` (hooks), `src/engine/game.ts` (vehicle sounds).
Tests: `tests/full-vehicles.test.ts` (20), `tests/vehicles.test.ts` (type count).

### 1. QVM reader: constant-expression arguments [observed + recovered]

The three `physicsobj/planes/*/plane.qvm` scripts failed in the call-tree reader
because some `DefinePhysicsObjType` arguments are postfix constant expressions:
`PUSHW 15000; PUSHF 1.5; MUL` (cfg[7] = 22500), `PUSHF 0.027; PUSHB 2; MUL`
(cfg[8] = 0.054), `PUSHF 0.003; PUSHB 2; MUL` (cfg[9] = 0.006) [observed: opcode
0x1b at code 0x173 in SU27/CutSceneMissile, 0x2c2 in JSF]. `readQvmCallTree` now
folds arguments made only of numeric pushes and ADD 0x19 / SUB 0x1a / MUL 0x1b /
DIV 0x1c / PLUS 0x2b / MINUS 0x2c with the VM's semantics (FUN_004b3e50 [recovered,
qvm-vm.ts]: int op int stays int, any float operand gives one float32 operation).
Any other opcode still throws. Result: 37 physics types (was 34); every other
script parses as before.

Plane types [observed, decoded]: SU27 702_02_1 and CutSceneMissile 714_01_1:
mass 10000, box 5 × 16 × 2.5 m, no contact points, rest 0.7 / 0.001, cfg = 700,
1.7, 0.9, 0.9, 0.9, 40, 0.9, 22500, 0.054, 0.006; drag (coef, point m, unit
normal): (6, 0, x), (2, 0, y), (60, (0, 8, 0), (0, −0.0871, 0.9962)), (0), (0),
(10, (0, −8, 0), x); JSF 701_01_1 the same with 8 contact points.

### 2. ATTA child matrices are re-orthonormalised (FUN_004c4950) [recovered]

The create of every ATTA child (FUN_004c4950, called through FUN_004f4800 by the
vehicle compiles) does not use the stored 3×3 directly: with a = column 0 and
b = column 1 of the stored (row-vector) matrix and c = a × b, the child's matrix
(column form, world = P M) has rows (unit a, unit(c × a), unit(unit a × (c × a))).
For a proper rotation this is the transpose the loader already used. A mirroring
record becomes the proper rotation keeping a and b: diag(−1, 1, 1) →
diag(−1, 1, −1) = Ry(π). Only 8 of the 2,120 ATTA records of the full game
mirror [observed]: the SU-27's left main gear 702_15_1 and left taileron
702_14_1, and six parts of 617_01_1; none in the one-mission build.
702_15_1's mesh is 702_12_1 (the right main gear) with z negated [observed: all
130 vertices], so with the stored mirror its wheel would point up through the
wing and its ground ray would never reach the ground (the plane rolls ~60° onto
its left wing); with the recovered rotation it is the mirrored right gear, wheel
down. `vehicles.ts attaMatrix` is used by `level.ts place()` (all attachments),
the engine's attachment chains, car wheels and the plane parts.

### 3. Plane [recovered unless marked]

Class `Plane` (FUN_004330f0): create FUN_00433410 (Original Thrust 1, Canopy 0,
Gear 1, sound block FUN_004e6ab0(2)), update FUN_00433690, compile FUN_00434770,
AnimTask input FUN_004337e0, physics FUN_00433b50, gear contact FUN_00434310,
reset FUN_00433530 / FUN_00433580. No damage handler, no members.

- **Compile**: model, body FUN_004fb700, reset (canopy / gear / hatch / gear-anim
  flags from "Canopy" / "Gear"; Break, Catapult, Force Z 0), then the ATTA children
  are created (FUN_004f4820 / FUN_004f4800) and read those flags; target = thrust
  = Original Thrust; v = "Speed" or Original Thrust × cfg[0] × 30.340740
  (0x533778) along local +y (the compile uses the matrix before "Orientation" is
  copied; the AnimTask's nTick 0 redoes it with the right one).
- **Input** (every AnimTask step): ch0..2 → inputs; ch3 ≠ −1 → target; ch5 / ch6 /
  ch9 ≠ −1 → canopy / gear / Force Z ^= (char)fistp(ch) (chop mode: truncation);
  Break = ch7 ≠ −1; Catapult = ch8 ≠ −1; nothing written back. nTick 0: pose,
  body, thrust = target = Original Thrust, inputs / controls 0, children
  re-created with the current flags, reset, v0. nTick > 0: physics.
- **Reset FUN_00433580**: copies the type's drag elements, rebuilds elements 3 / 4
  (the tailerons): coef = wing coef × 0.5 (0x533504), normal = wing normal,
  point = (±16384, −wing.y, wing.z), and writes them back into the type
  (+0x80 / +0x9c of the config, read by the per-tick code).
- **Physics FUN_00433b50**, m = mass, g = 44.600887: f = clamp(speed /
  (cfg[7] × 37.925926), 0, 1); thrust step cfg[8] (thrust ≥ 0.8) / cfg[9];
  target − 0.6 (0x53369c) with ground contacts and target < 1; move without
  overshoot; thrust < 0.001 → 0 (always); c_k = (s_k c_k + (1 − s_k) in_k) ×
  (0.995 − 0.00083 f) with s = cfg[2], [4], [6]; tailerons (any c ≠ 0 and
  (contacts 0 or speed ≥ 10)): P = c0 cfg[1] π/360, R = c1 cfg[3] π/360, θ3 =
  min(−(R + P), cfg[1]), θ4 = min(R − P, cfg[1]), n3 / n4 = Rx(θ) × the type's
  taileron normals; Break: forward ×3, tailerons wing × 0.375, wing × 0.75;
  Catapult: (0, m × 6489.43, 0) at the origin; thrust ≠ 0: (0, m thrust g, 0),
  turned by Rz(cfg[5] c2 π/360) without contacts, at (0, 10 m, 0); gear contact;
  not at rest → drag (contacts 0 or speed > 30 km/h) and step(g, 1.0, 0.92);
  sound block = (thrust, thrust > 0.01).
- **Contacts** (+0x1b8) are counted only by the generic body-point collision per
  contact point (0x4fbbe0 / 0x4fbe27 / 0x4fc79e); the SU-27 and the missile have
  none, so for every shipped plane contacts = 0 (no ground target drop, thrust
  yaw and drag always on, never at rest).
- **Gear contact FUN_00434310**, per Gear child (≤ 4): ray from the gear's magic
  vertex 0 in the world (its current pose, retract angle included) + 2 m down to
  it; the force point is the ATTA offset + the raw vertex (M^T M v); hit d ≤ 2 m:
  d ≥ 1.85 m spring (2 m − d) / 614.4 × 0.4 m g, else ((1.85 m − d) / 1.85 m + 1)
  × 0.4 m g and the plane is lifted by the deepest penetration (any stiff hit);
  per contacting gear v.x, v.y × thrust × 0.8, L × 0.98. Consequence [observed in
  the port]: on the ground a plane only rolls with thrust ≥ 1.25 (1.25 × 0.8 = 1):
  mission 3 plane 601 (thrust 1.25) rolls, lifts off along the runway and climbs
  away; plane 600 (thrust ≤ 1) crawls out of the hangar at ~2 km/h.
- **Sub-parts** (0x140-byte magic objects; world = M_plane L_atta R):
  Gear (create FUN_00435460: 0 with the gear down, else param0 deg; update
  FUN_00435930; place FUN_00435a80 → FUN_004355a0: R = Rz(steer) Rx(a), steer =
  c2 π/4 for a steerable gear while down); Hatch (create FUN_00435c50, update
  FUN_00435e50); CockpitShield (create FUN_00434e10: canopy open → param deg;
  update FUN_004352a0); Rudder (FUN_004362c0; RUDDER_AILERON 0 / TAILERON_LEFT 1 /
  TAILERON_RIGHT 2 / GAMMA 3 registered by FUN_004361d0, now mapped by
  readMagicObjects). The angle updates run once per physics tick in the port
  [inferred: the caller of slot 1 was not traced; ATTA order kept].
- **Afterburner is never drawn**: the class's draw (slot 4, FUN_0042bd40) only
  queues an "AfterburnerPrimitive" whose draw FUN_0042c4b0 calls FUN_004c1780, a
  bare `ret` [recovered]. TASKTYPE_AFTERBURNER is hidden (level.ts HIDDEN_MAGIC).
- **Sound**: FUN_00433690: "Play sound" evaluating to 0 stops, else group "su27"
  (0x53bfcc) once; vars (thrust, playing).

### 4. CarAI [recovered]

Class FUN_00425c80; update FUN_00425de0, compile FUN_004265a0 (car / AIGraph by
id; reset input nTick 0 with brake 0 → ch3 −1). Implemented literally:
cursor = the HumanAI patrol cursor (FUN_004537e0 / FUN_00453760 =
AiPatrolCursor); WALKTO / RUNTO: arrived within 3 m (FUN_004260c0) → advance,
else next hop FUN_00425c10 (nearest node FUN_005096f0 → route FUN_005096c0;
no link: error, nearest node), S = SETSPEED value, drive FUN_00426140; DELAY n
(n + 2 ticks, brake request); END / QUIT: parked, brake 1, steer 0, desired 0,
thrust output kept; SETSPEED: value, brake request 0; outputs of the branches
that do not recompute are re-sent. Desired speed FUN_004255a0 (constants 0x533600
.. 0x533670, π stored as 3.1415926535897944), FUN_00425b80 (hop adjust),
thrust / brake FUN_00426260 (thrust = clamp(e × 0.01 + car thrust), brake
unless (no request and e ≥ −5)), steering ±1 beyond 10°, a × (−6/π) inside,
× ((1 − thrust) 0.95 + 0.05) on patrol. Target test FUN_00426000 (no "Can fire"
/ dead target → patrol; attacker slot +0x2ed0 (always 0: only the create and the end of every update write it);
first visible perception entry → memory 600; else memory−−). Attack
FUN_004262f0 / FUN_00425900: next hop toward the node nearest the target at
20 km/h, stopped within 3 m and pivoting toward the target (desired 5 km/h
beyond 10°, else |a| × 28.65); the brake output is the request (0 while
pivoting). Output FUN_00426510: ch0 steer, ch1 thrust, ch3 brake or −1.
Graphs: loadLevelVehicles reads `graphs/graph<Graph ID>.dat` with the AIGraph's
"Graph position" (13 of the 16 CarAI tasks drive; the three "Fake" twins have no
graph / route). Observed in the port: mission 6 APC 800 drives W1, W3, W9, passes
the END and continues with W17 (tracked: slow pivots at full lock).

### 5. Car (full-exe class 0x42dcf0) [recovered]

- Update FUN_0042e320 order: once per tick; skip when exploded; "Play sound";
  "Open door" (CarDoor, FUN_0042e810: no car of missions 1–14 has one);
  "Can fire" FUN_0042e870; task children (the CarAI drives the car here); magic
  children; place / AIStationaryGun children when not driven; clear +0x2ecc /
  +0x2ed0; explosion FUN_0042e5a0 (run at the start of the next update in the
  port: same tick, before the children).
- "Can fire" → (char)fistp(expr) at +0x91d; while set the perception
  FUN_00489750(+0xa90, eye = position + (0, 0, 8192), the car matrix) runs; the
  falling edge clears it (FUN_00489b90) and takes a new phase (FUN_004896c0).
- Perception (compile FUN_0042f530: FUN_004896c0(1, 4, phase) with the stacked
  4 / 8 → cone every 2nd, sight every 3rd run; cone α, γ in rad (ViewCone Alpha /
  Gamma (degrees) × 0x53367c), length × 4096): FUN_00489750 tracks alive objects
  of a team ≠ 1 (flags 4, own team 1), registry order, AddTail; FUN_00489960:
  local = M^T (point − eye), |local| ≤ length, the angle of (0, y, z) from +y
  (FUN_004148f0) < α (float), |the horizontal angle of (x, y, 0) from +y (FUN_00414950, z zeroed)| < γ; sight
  FUN_00489b20 = the AI sight ray (≥ 0.79). `VehicleDetector` in car-ai.ts.
- Damage FUN_0042fb40: kind-12 records only (object-damage.ts already sets the
  car's flag for weapon 12); explosion FUN_0042e5a0: per explosion vertex
  FUN_00480fe0(vertex, 1, rand < 30 ticks, 1.0, 12288, 3072, 3072, 3, 2, …,
  "1009_01_1", "explo_03_l", …, 100000) and wait 30; without vertices one at the
  origin scaled by the model's bounding radius FUN_004d0950 (× 0.25, × 0.05,
  × 0.005; the damage data's origin radius in the port) and wait 10; then
  the wreck (type +0x2b0: APC 601_08_1, T80 614_08_1) replaces the car
  (FUN_004f0ee0 + FUN_00401780) and isExploded = 1. nTick 0 of any driver clears
  destroyed / the countdown. The port swaps the car's root instance to the wreck
  model (damage data now builds the wreck models; car instances are
  destructible) and removes its parts; `Car_N.isExploded` reads the vehicle
  system.

### 6. Heli (full-exe class 0x4310f0) [recovered]

Update FUN_004316d0: "Play sound" 0 → stop "helicopter_1", else start once;
destroyed (+0x750, never set: helis cannot be destroyed); "Open door" →
FUN_00426d80 sets the HeliDoor flag; "Can fire" → perception with the matrix
rotated by FUN_004b34f0(−π/2) (implemented: world/vehicles.ts heliCanFire; it feeds the turret and the rocket pods, "Mounted weapons" below).
HeliDoor (class registered at 0x4272a4): params (axis, speed m/s × 136.53
(0x533680) units/tick, distance m × 4096) (FUN_004277c0); update FUN_004273b0
slides d toward distance / 0; place FUN_004274e0: ATTA offset[axis] + d, matrix
M L_atta. It updates with the heli's other children in the AnimTask input
[inferred: FUN_004eb2c0 updates every attached child]. Mission 6 Mil 802: the
door slides 2.65 m along y at 0.6 m/s once AnimTask_852 passes 20 s. Heli sound
block (FUN_00431e30): (thrust, thrust > 0.01).

### 7. Rails: SplineObj compile FUN_00502740 and Automatic Orientation [recovered]

- Create 0x5026e0: γ0 = π (float 0x40490fdb), previous position 0. Compile (game:
  no editor argument): γ ≠ γ0 → every waypoint rotated about the first by
  Rz(γ − γ0) (float rotated offset + double first position); Position ≠ 0 → every
  waypoint moved by the float vector Rz(γ) Position. This resolves the doc's
  "gamma quirk trigger" (level 1: 3.1415929 = π + 1 ulp fires).
- Waypoint compile FUN_00500ef0 (0x500f28..0x501452): with the SplineObj's or the
  waypoint's "Automatic Orientation", a curved spline and a neighbour: t = (P −
  P_prev) + (P_next − P) (float, missing terms left out; t = 0 → (1, 0, 0)); h =
  unit(t.y, −t.x, 0) ((0, 1, 0) for a vertical t); c = h × t; b = c × t; e =
  unit(t) × b; matrix columns unit(t), unit(b), unit(e). Applied before the
  segments are built; "Align" does not prevent it, "Linear Segments" does.
  Used by mission 10 rail 870 and a mission 9 "yard rail line"; mission 9's
  Bridge Fencing splines have Position ≠ 0 / γ = 1.57.

### 8. AreaActivate CRITERIA_VEHICLE [recovered]

CRITERIA_VEHICLE is registered by the "Vehicle" base class (0x4f4160..,
0x748-byte objects; Train, Car, Heli and Plane derive from it); its handler
FUN_004f4560 counts every object of the vehicle list DAT_00a76c40 whose position
(+0x20) is inside the area. The port passes every heli, car (not exploded),
plane and train car in the world (missions 6, 7, 10 use it: gates, "vehicle -
Game complete").

### 9. Sounds [recovered groups; wiring inferred]

game.ts runs each vehicle's group as an object sound (audio.objectSound) with
its parameter block: Heli "helicopter_1" (thrust, playing), Plane "su27"
(thrust, playing), Car the type's group (thrust, playing, min(1, speed ×
0.001)); "t80_sounds" is defined nowhere (silent T80) [observed]. Vehicles out
of the world keep no voice [inferred]. Level 1's heli and truck now sound too.

### 10. Open points

- Gear magic parameters 3–5 (0.98, 0.1, 0.5) unread; plane "Force Z" toggle has
  no reader; car "Lights" / "PilotAnim".
- The sub-part slot-1 update caller (per physics tick in the port).
- CarDoor ("Open door" of cars) not animated (unused by the shipped missions).
- That the damage data's origin radius equals FUN_004d0950's model radius
  (no-vertex car explosions: only the Limo, which has no wreck either).

---

## Mounted weapons and the Missile (full exe)

To be merged into `docs/vehicles.md` (new section "Mounted weapons" after the
"Full game" §9) and `docs/combat.md` (§7.4 / §7.5 and Part 1 §7), plus the
evidence ledger. Every address is a **full-exe** `FUN_` name / address (image
base 0x400000). Labels: **[recovered]** read from igi.exe, **[observed]**
measured on the shipped full-game files or in the port, **[inferred]**
reasoning only.

Implementation:

- `web-port/src/engine/combat/vehicle-weapons.ts` (new): the AIStationaryGun
  turrets and RocketPods of Cars / Helis (create, update, place, Gun fire,
  pods, drawing).
- `web-port/src/engine/combat/missile.ts` (new): the Missile object (type,
  spawn, guidance, smoke draws, physics, update outcome).
- `web-port/src/engine/combat/projectiles.ts`: the RPG approximation replaced
  by the Missile; spawn takes an aim matrix, target point / object and the
  firing vehicle's body; the missile's sound group and smoke system.
- `web-port/src/engine/combat/grenade.ts`: the physics-object step
  (`stepRigidObject`, FUN_004f2d00 demo = FUN_004fc0e0 full) exported for the
  Missile (grenade behaviour unchanged).
- `web-port/src/loaders/vehicles.ts`: TASKTYPE_MISSILE config decoded
  (`MissileConfig`, `MISSILE_SYMBOLS`).
- `web-port/src/engine/world/vehicles.ts`: `MountedWeaponHooks` called at the
  exe's points, `afterChildren` (end of the Car update), the Heli "Can fire"
  perception.
- `web-port/src/loaders/mission.ts`: `MissionHost.afterTaskChildren`;
  `web-port/src/engine/mission/mission-system.ts`: `setVehicleWeapons`, the
  hook to `vehicles.afterChildren`; `web-port/src/engine/combat/combat-objects.ts`:
  creates and registers the vehicle weapons, draws their gun models.
- `web-port/src/loaders/level.ts`: the HIND rocket model 700_10_1 is loaded
  when a RocketPod is placed; the turret gun models' and missile models' magic
  vertices join `level.vehicles.models`.
- `web-port/src/loaders/car-ai.ts`: `headingFromY` = FUN_00414950 zeroes z
  (fix, below).

Tests: `tests/turrets.test.ts` (12 synthetic), `tests/full-turrets.test.ts`
(8, full data; rig `tests/turrets-rig.ts`).

### 1. What the full game mounts [observed]

magicobj.qvm defines five TASKTYPE_AISTATIONARYGUN objects and one
TASKTYPE_ROCKETPOD; the vehicle models carry them as ATTA records:

| Vehicle model (task) | ATTA path | Turret / pod | Gun model -> weaponconfig | Projectile |
|---|---|---|---|---|
| APC 601_01_1 (Car) | 17 | 601_02_1 (side 361°, up 75°, down -8°, 30°/s, "tank_turret", min 6 m) | 601_05_1 -> WEAPON_ID_APC (id 40, 12 rpm, spread 1° / 2°, muzzle velocity 5, `rpg_launch_1`) | Missile 110_02_1 (RPG18 type) |
| T80 614_01_1 (Car) | 0 | 614_02_1 (361°, 15°, -4°, 15°/s) | 614_03_1 -> WEAPON_ID_T80 (id 43, as the APC) | Missile 110_02_1 |
| T80, on 614_02_1 | 0/0 | 614_10_1 (360°, 45°, -20°, 30°/s) | 123_01_1 -> WEAPON_ID_M2HB (800 rpm, damage 1.0) | bullets |
| Mil 700_01_1 (Heli) | 11 | 700_11_1 (135°, 5°, -90°, 50°/s) | 700_12_1 -> WEAPON_ID_MIL (id 41, 550 rpm, damage 0.25, spread 1° / 2°, `mil_loop` / `mil_loop_e`) | bullets |
| Mil | 7, 8, 9, 10 | 4 x RocketPod 700_09_1 (param 15) | - | HIND rocket 700_10_1 |

(456_12_1 is the mission 14 holder turret, combat.md §3.) No Plane, Train or
other Car / Heli model attaches a weapon. Armed vehicle tasks: APC in missions
6, 7, 8, 14; T80 in 7, 8, 10; Mil in 6, 7, 10, 12 (the Mils of mission 12
have no "Can fire"; mission 10's #852 has "Can fire" true on exactly one tick,
`AnimTask_801.nTick == 30 * GAME_FREQUENCY`). Gun muzzles = gun magic vertex 2:
601_05_1 (-47, 15222, -108), 614_03_1 (27, 40937, -111), 123_01_1 (3, 5091,
199); 700_12_1 has no magic vertex (muzzle = its origin). Turret pivots =
turret magic vertex 1: 601_02_1 (137, -4844, 1478); 614_02_1 / 614_10_1 /
700_11_1 none (origin).

### 2. How the vehicle creates and drives them [recovered]

- **Creation**: the vehicle's compile runs FUN_004f4800: a MagicObjContainer
  (FUN_004e0930(0, vehicle): no parent, so the task walk never reaches it) at
  +0xe8 and FUN_004c4950(container, vehicle, vehicle), which creates one object
  per ATTA record with a magicobj definition, passing the vehicle as the
  child's "parent" (create struct [0x22]) and the definition ([0x23]).
  AIStationaryGun create FUN_0046eae0 stores +0xf0 the ATTA offset, +0x108 B
  (the re-orthonormalised ATTA matrix), +0x130 the parent, +0x1b8 the
  definition, creates the Gun (FUN_00477c50(self, 0, weapon by gun model
  FUN_00413c00, ammo, 0)), zeroes pitch / yaw / memory / spin, poses itself
  (FUN_0046ec90: turret = V B Rz(yaw), gun = V B Rz(yaw + pi) Ry(spin)
  Rx(pitch) at the turret's magic vertex 1, V = the parent's matrix) and then
  creates its OWN ATTA children with FUN_004c4950(self, self, +0x130): 614_10_1
  lives in 614_02_1's child list but its +0x130 is the T80.
- **Detector**: the turret update 0x46f390 asks its +0x130 for its detector
  (method 0x54127e, getter FUN_00489630): Car FUN_0042fc70 -> +0xa90, Heli
  FUN_00433000 -> +0x8c0, AIStationaryGunHolder FUN_0046e9e0 -> +0x168. Without
  an answer the update does nothing (not even the Gun's update).
- **Car order** (update FUN_0042e320 at the Car node): "Can fire" -> the car
  perception (vehicles engineer's port); the task children (a CarAI's input,
  0x42ec0e: FUN_004f4660 = the container's update 0x488700 = every attached
  child's update, then +0x2ecc = 1 and the physics FUN_0042eca0, which ends by
  placing the children with method 0x4d9fb0); then the update loop over the
  attached children; when not driven this tick (+0x2ecc == 0): place them and
  update the AIStationaryGun-type ones again (FUN_00401be0 / FUN_00401c40 with
  FUN_00470400 = the class id); +0x2ecc = 0, +0x2ed0 = 0; the explosion. **So a
  car's turrets update twice per tick**, driven or not (their Gun too: twice
  the slew rate, half the effective cooldown and memory) [recovered; observed
  in the port: 2 updates per tick].
- **Heli order**: the Heli update FUN_004316d0 does NOT update the attached
  children. The AnimTask input FUN_00431b70: nTick 0 resets the heli and
  re-creates its children (FUN_004f4820 / FUN_004f4800), then places them;
  nTick > 0 runs FUN_004f4660 (children update: turret and pods) before the
  physics FUN_00431e30, which ends by placing them. A Mil whose AnimTask does
  not run does not aim or fire.
- **Heli "Can fire"** (FUN_004316d0, after "Play sound", the destroyed check
  and "Open door"): (char)fistp of +0x7a8 into +0x751; while set: eye +0x848 =
  the heli's origin, matrix +0x860 = M Rx(-pi/2) (FUN_004b34f0(m, m,
  0xbfc90fdb) = M Rx(a)), no secondary cone (+0x8b8 = 0), FUN_00489750(+0x8c0,
  eye, self, team 1). Falling edge: FUN_00489b90 and a new phase
  (FUN_004896c0(1, 4, FUN_00464250(4, 8))). The compile (0x43298e..0x4329dc)
  converts the cone like the car's (deg x 0x53367c, length x 4096) and takes a
  perception phase; create defaults 180° / 360° / 60 m (0x4316a6..).
- **Place** 0x46fba0 (the container's pose P, Pm): position = P + Pm
  f32(offset); +0x70 = Pm B Rz(yaw); the Gun's pose FUN_00470050: at
  position + (+0x70) v1, matrix = V Rz(yaw) Rx(pitch) [Ry(spin) when spin !=
  0], V = the +0x130 matrix (FUN_004f2310 sets the Gun object's pose,
  +0x178 / +0x190 keep it); then its own children are placed with its pose.
  The nested MG therefore sits on the turned main turret while it aims in the
  T80's frame [recovered; visually its mount turns by both yaws].
- **Turret update** 0x46f390: target = the first entry of det +0x18 with
  visible (+0x29) and an object; local = V^T (object +0x20 - turret +0x20)
  with the PARENT's matrix; then exactly the holder turret rules (combat.md
  §3.4, `loaders/objects/ai-stationary-gun.ts stepAiTurret`): memory 90,
  unwrap above 2 pi, slew, clamp, fire window 5° and min range, spin, the
  turning sound above 2°; the Gun use FUN_0046f950 (method 0x53f314 with
  {fire, ..., user 0, 1.0}); the children (the Gun 0x478640: cooldown - 1; a
  nested turret's update).
- **Gun fire** FUN_00478ba0 / FUN_00479780 as for every gun (combat.md §2.4):
  request off -> shots 0; shots == burst -> no request; shot needs cooldown 0
  (and clip > 0 for a calibre); burst >= 2 (all four vehicle guns): the
  "fire" sound loops from the request's start, the "Loop End" sound at its end
  (the APC / T80 play `rpg_launch_1` twice); muzzle = gun + M v2, direction
  col 1, aim basis FUN_00414a60; per round the spread (min for the first 4
  shots of a hold, then max) r1 r2 r3 x spread and r4 x 2 pi from the level
  RNG (Rz(0) Ry(az) Rx(a)); the projectile FUN_00413d10 (TASKTYPE_GUNSHOT: the
  bullet; TASKTYPE_MISSILE: the Missile's spawn method LAB_004298a0 ->
  FUN_00429a30(Dynamic, gun, owner, muzzle, aim matrix, weaponconfig +0x660
  muzzle velocity, ..., +0x6e0 "Missile - Model", weaponconfig)); cooldown
  fistp(60 / rpm x 30); clip - 1; then the GUNSHOT AI event (team 1 without a
  user, flags 0x46, the weaponconfig range) at the muzzle and the view-kick
  draws. Fire rates per update: APC / T80 150 ticks, M2HB 2, MIL 3 (so 75 /
  1 tick on a car with the double update).
- **RocketPod** (class FUN_00427830, 0x140 bytes): definition reader
  FUN_00427d40 (param x 30 = 450 ticks); create FUN_00427940 (+0x13c =
  FUN_004b47c0(level RNG, 450): a level-RNG draw at every creation, i.e. the
  heli compile and every AnimTask nTick 0); place FUN_00426fa0 (P + Pm offset,
  Pm B); update FUN_00427a70: while +0x13c < 0, for every visible entry of the
  heli's list +0x8d8 with an object: local = pod^T (object - pod), local.y >=
  0 and |FUN_00414950(local)| < 1.3 (double 0x533690) and FUN_004ce410(world,
  pod, object, filter 0x54127c, {pod, pod, object}) clear -> FUN_00429a30(
  Dynamic, pod, pod, pod + col1 x 2048 (f32 sums, 0x533688), the pod's matrix,
  heli +0xf8 x 0.00732421875 (0x533684) + 5 (0x5335f8) m/s, the object's
  position, 0, "700_10_1" (0x53bb60), weaponconfig 0) and +0x13c = rand(450) +
  450 (the loop continues: two visible targets can draw two rockets in one
  tick); every update +0x13c - 1. The list walk is the exec-style
  "while (node->next)" over a header with a NULL tail sentinel.
- **Car attacker slot +0x2ed0** (read by the CarAI target test
  FUN_00426000): the only writes in the exe are the create (0x42e309) and the
  end of every update (0x42e586), both 0; it is not a script member (the
  car's members at 0x42e0dc.. are the ViewCone fields +0x2ec0..+0x2ec8). It is
  always 0: the CarAI's "attacker" branch is dead code [recovered].
- **FUN_00414950 zeroes z** (0x414954 / 0x41495d store 0 into the
  argument's z double before normalising): it is the horizontal heading of
  (x, y, 0) from +y, negative for x > 0, not a 3D angle. FUN_00489960 (the
  vehicle cone) compares |FUN_004148f0| < alpha (float) and |FUN_00414950| <
  gamma. `car-ai.ts headingFromY` is fixed accordingly (it also feeds the
  CarAI steering, which uses FUN_00414950); all vehicle tests still pass.

### 3. The Missile [recovered unless marked]

- **Type** (TASKTYPE_MISSILE, reader FUN_00429730 after the Vehicle base
  reader): the base config (cfg[0..9], drag elements, view cone) then +0x118
  smoke (MISSILE_SMOKE_NONE 0 / NORMAL 1), +0x11c guidance (DIRECT 0,
  HIND_HELICOPTER 1, BALLISTIC 2, ANTITANK 3, KEYBOARD 4, BOMB 5), +0x120 fuel,
  +0x124 burn x f32 1/30, +0x128, +0x12c / +0x130 x 4096, +0x134, +0x138,
  sprite, sound. Shipped [observed]: RPG18 110_02_1 (direct, fuel 4, thrust
  200, turn 5, smoke spacing 0.25 m, growth 0.5 m, interval 1, size 1); cgm2
  136_02_1 (direct, fuel 15; no weapon fires it); HIND 700_10_1 (guided,
  fuel 30, thrust 25, turn 35 / smoothing 0.9, spacing 0.1 m, growth 0.9 m,
  interval 0.9, size 4). All: mass 10, box 0.4 x 5 x 0.4 m, one contact point
  at magic vertex 0 (the nose, (0, 2420.5, 0)) with restitution 0.2 and grip
  1, rest 0.7 / 0.001, drag elements {1, (0, 4 m, 0), n z} and {1, (0, 4 m, 0),
  n x}, sound `radarwind_1`, sprite `smoke2.spr`.
- **Spawn** FUN_00429a30: matrix = the aim matrix, body FUN_004fb700 (mass,
  box inertia, contact points), fuel = type fuel, drag copied by FUN_00429ef0
  (elements 2 / 3 = 0 / 1 with point.y negated), throttle = target = 1, the
  smoke system FUN_00429dc0 and the sound FUN_00429d80, gun / owner handles,
  guidance init (DIRECT: aim = muzzle + col1 x 4096000; HIND: +0x840 = target
  - muzzle, aim = target), velocity = col1 x muzzle velocity x f32 136.53334,
  source = the weaponconfig. The Vehicle create FUN_004fb5f0 sets collision
  detection +0x6d8 = 1.
- **Update** 0x428390: target object -> aim; guidance; smoke while fuel != 0;
  physics FUN_00428d00; sound position; children; no contact: when the global
  frame (DAT_00bc2360 +0x68) & 0x1f == 0, a ray 1000 m down, nothing -> the
  missile is deleted; contact: a ray 3 m down (the scorch hit) and
  FUN_00480fe0(position, 1, 1, 5.0, 10240, 7168, 6144, 10, 5, hit,
  "1009_01_1", "explo_03_l", 21, 2, 102400, source), deleted.
- **Physics** FUN_00428d00: throttle step cfg[8] at or above 0.7 else cfg[9];
  controls smoothed by cfg[2] / [4] / [6]; any control -> M = M Rx(c0 cfg[1]
  pi/180) Rz(c2 cfg[5] pi/180); fuel 0 -> M = M Rz((0.3 - r3) 0.1) Ry((0.7 -
  r2) 0.1) Rx((0.5 - r1) 0.1) with r1, r2, r3 drawn in that order from the
  missile generator DAT_0057bc88 (FUN_004b4770; initialised once by
  FUN_004b4720 at the class registration, never re-seeded: process-wide);
  throttle and fuel -> body force (0, cfg[7] throttle g, 0) at the origin;
  fuel = max(0, fuel - burn); unless at rest (FUN_004fc7b0: contacts, no wake
  flag, no pending force, slow): flat-plate drag FUN_004ec2c0 (= the vehicles'
  `applyDrag`) and FUN_004fc0e0(g 44.600887, linear 0.95, angular 0.92) =
  the demo FUN_004f2d00 the grenades use (FUN_004fbf90 weight + integrate +
  damping; FUN_004fb9a0 contact pass: per contact point the path P -> P + (v
  + w x r) cast with the missile's filter, vn = FUN_004fc870 (> 1 separating,
  <= -1 contact), impulse FUN_004fc8e0 with (1 + e), friction FUN_004fcca0,
  contacts + 1, one per step; move above 40.96; inside test FUN_004fc620:
  5 m up from each point, first hit a back face -> previous pose, contacts +
  1).
- **Ray filter** LAB_00427fc0 (the Missile's answer to method 0x539547): a ray
  of the missile itself, its gun or its owner, or any other Missile, passes.
  The missile's own rays send the record {self, gun, owner, 1.0}.
- **HIND guidance** FUN_00428930: d = position - aim, P = (d . o) d + 12800
  unit((d . o) d) (FUN_004b30c0, double 0x40c80000...), FUN_00428b60(P): local
  = M^T (P - position), input0 = clamp(FUN_004148f0(local), -1, 1) (pitch,
  positive up), input2 = clamp(FUN_00414950(local), -1, 1) (yaw, positive
  left). P is used as a world point; (d . o) d is huge and points along -d
  while d . o < 0, so the rocket turns toward the aim point (and away once it
  passed it).
- **Smoke** FUN_00428630: counter +0x878 >= fistp(+0x880): one draw (alpha r
  x 0.3 + 0.15), n = max(1, fistp(speed / +0x884)) particles spaced v / n
  from the tail (magic vertex 1 for a model with two or more magic vertices
  [inferred: the model field read is its vertex count]); per particle three
  unused draws, then FUN_004fe120(system, point, unit velocity, alpha, spin
  (0.5 - r) x 0.0376991, angle r x 2 pi, scale 1, life fistp(+0x88c x 3),
  fade fistp((r x 0.3 + 0.6) x +0x88c x 30)): six draws per particle. System
  FUN_00429dc0 -> FUN_004fdf00 (= the demo's FUN_004f4b20 particle system,
  emit FUN_004fe120 = FUN_004f4d40): sprite, acceleration (0, 0, 0.0217778),
  colour 12.7 (dark, as the explosion smoke), half-size +0x12c, far 2048000,
  flags 0x1080000, growth (+0x130 / +0x12c - 1) / (+0x88c x 30), 2000
  particles, a child of the Dynamic task removed when empty (it outlives the
  missile).
- **Consequences** [observed in the port]: an RPG18 / turret round reaches
  53.1 m/s after 10 ticks and 124.0 m/s at burnout (tick 120: v <- 0.95 (v +
  892)), then tumbles and slows (0.95 per tick) to a few m/s within 2 s; the
  HIND rocket's thrust 25 gives only ~15.5 m/s (0.95 (v + 111.5)) and it sinks
  until its guidance pitches up.

### 4. Port notes and approximations

- Collision: the port merges a vehicle's ATTA parts into the vehicle's
  dynamic body, so a turret round's or pod rocket's rays and the pods'
  clear-line test skip the firing vehicle's whole body [approximation: the
  exe skips only the gun and the turret / pod objects]. The turret's collision
  faces stay at the build pose (as the wheels').
- Turret bullets use the soldiers' bullet path with team 1 (soldiers of team
  1 are spared) and hit probability 1.0 against the player (the record's 1.0,
  no AI user) [inferred, as the mission 14 holder turrets].
- The pods' clear-line test FUN_004ce410 is a set-0 + terrain ray [inferred:
  the per-class answers to filter 0x54127c are not traced].
- Missile contact rays hit the humans (but the owner) with the normal facing
  the ray [inferred]; the player's FUN_0045d100 draw on such a ray and the hit
  object's contact method (FUN_004fc860 answers, FUN_004fbe86's v x 0.25) are
  not modelled.
- The pods' create draws happen when the vehicle system is built (the heli
  compile) and at every AnimTask nTick 0; whether the level RNG is seeded
  before the exe's compile is [inferred].
- Drawing: the turret ATTA instance is turned each tick (setInstanceTransform
  with the turret pose), the gun model (601_05_1, 614_03_1, 123_01_1,
  700_12_1) is drawn at the Gun's pose with its GUNFLAME muzzle flash
  (render/combat-models.ts); the missile models with their smoke trails.
- Cheats: Unlimited Health protects against turret bullets and missile
  explosions (both go through player.damage); Invisible To Enemies takes the
  player out of the vehicle perception (captureHumans' inWorld), so the
  turrets lose the target and stop.
- Mission 14 holder turrets (combat engineer's port), for the record: the
  holder update calls the place method 0x4d9fb0 (0x46e753), so the sentry gun's
  pose there is also FUN_00470050's (H Rz(yaw) Rx(pitch) Ry(spin), no B) after
  the first tick; `ai-turrets.ts` uses FUN_0046ec90's H B Rz(yaw + pi) Ry(spin)
  Rx(pitch) every tick (same barrel direction for B = Rz(pi); the roll and the
  update / place order differ).

### Open points (mounted weapons)

- The missile contact with an object that answers FUN_004fc860 (humans,
  cars: v x 0.25 at 0x4fbe86) and the player's FUN_0045d100 draw on a missile
  ray; the exact per-class answers of FUN_004ce410 (pods' clear line).
- The smoke start for a missile model with a single magic vertex
  (FUN_00414ed0); no shipped missile has one.
- MISSILE_TYPE_MISSILE_BALLISTIC / ANTITANK / KEYBOARD / BOMB guidance
  (FUN_00428a60, FUN_00428ad0, FUN_00428a00) is not ported: no shipped type
  uses them.
- Turret / gun collision follows the vehicle's build pose (the turret's
  rotation is render only).
