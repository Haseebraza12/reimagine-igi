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
