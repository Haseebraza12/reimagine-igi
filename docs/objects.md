# Object tasks of the full game: Elevator (+ElevatorFloorIndicator), Generator, Radio, Cabinet (+Drawer), GenericPickup, GenericTBA, PlaceExplosiveTBA, BinocularOverlayHolder

Evidence labels: **[recovered]** read from the exe code, **[observed]** read from the game data, **[inferred]** an interpretation. Units are IGI units (4096 = 1 m), z up, 30 Hz logic tick. "byte(x)" = low byte of fistp(x) and "int(x)" = fistp(x). The FPU runs in chop mode, so every fistp truncates (see docs/gameplay.md).

## 0. Conventions and shared machinery

**Exe.** Every address here is in the full-game exe (`re-full/igi.exe`). The repo docs (interactions.md, mission.md, collision.md, hud.md) use a different build, and its addresses are shifted by about 0xE00–0x1200 in this region. Mapping [recovered]:

| Item | docs build | full exe |
|---|---|---|
| Activate dispatch (kind switch) | `FUN_0040ce30` | `FUN_0040cd30` |
| Use search + per-tick "active" call | `FUN_0045fb20` | `FUN_00460ee0` |
| Player pickup loop | `FUN_00410f10` | `FUN_00410f70` |
| Method-id bytes (allocated in order by `FUN_004017c0`) | `0x537428…0x537436` | `0x539540…0x53954e` (allocated at 0x415563…0x415613) |
| LevelFlow pointer (nTick at +0x68) | `DAT_00b680a0` | `DAT_00bc2360` |
| Elevator registration / platform method | `FUN_0043be30` / `FUN_0043d450` | `FUN_0043cc70` / `FUN_0043e290` |
| Cabinet / GenericTBA / PlaceExplosiveTBA registration | `FUN_00443040` / `FUN_00446c20` / `FUN_00437b40` | `FUN_00443ed0` / `FUN_00447db0` / `FUN_004388b0` |

**Method ids** (the getter returns the byte; the handler table is `0xa96ae0 + (id*0x180 + class)*4`) [recovered]:

| Byte | Getter | Meaning (docs name) |
|---|---|---|
| 0x539541 | `FUN_004167e0` | pickup touch (docs 0x429), called from the player pickup loop |
| 0x539542 | `FUN_004167f0` | use-target test (0x42a) |
| 0x539543 | `FUN_00416810` | use kind (0x42b) |
| 0x539544 | `FUN_00416800` | "active" per-tick call while used (0x42c) |
| 0x539546 | `FUN_00416820` | HUD action icon (0x42e) |
| 0x539548 / 0x53954d | `FUN_00416850` / `FUN_00416880` | ray-query object filters (GenericPickup answers 0 = not hit) [meaning inferred from the callers 0x40d2f3 and 0x4149d9] |
| 0x53954e | `FUN_00416890` | platform delta (docs 0x537436) |
| 0x547f40 | `FUN_004c5800` | "parent moved" (pos, R), sent to children |
| 0x548176 / 0x548177 | `FUN_004cea10` / `FUN_004cea20` | add to / remove from the world |
| 0x53f582 | `FUN_00467d90` | map-computer hilight target (`FUN_00443dc0`) |

- **Use list** (`FUN_004168a0`, docs `DAT_00577b5c`): Cabinet and GenericTBA (and so PlaceExplosiveTBA) add themselves on create (`FUN_004c1790`). [recovered]
- **Pickup list** (`FUN_004168c0`): GenericPickup adds itself on create. [recovered]
- **Sounds** [recovered from usage]:
  - `FUN_004e6b00(parent, name)` creates a sound object from the sound definition under `parent`. It returns 0 for an empty name or an unknown definition.
  - `FUN_004f0ee0()` is the global sound root `DAT_00a758ac`.
  - `FUN_004e6c30(snd, &pos)` positions the sound and `FUN_004e6c00(snd)` kills it.
  - `FUN_004e7200(name, flags, params)` plays 2-D by name: the definition's sample only, at volume 1.
- **Level RNG** = `FUN_00416d20()` = `DAT_0057babc + 0x2c`, and `FUN_004b47c0(rng, n)` = next() mod n. This is the same generator as docs "level generator". [recovered]
- **Model points**: `FUN_00414e20(out, obj, i)` gives the world offset of the model's XTVM point i. When the model has no point i (or no model) it gives (0,0,0), so the point is the object position. [recovered]
- **Rigid child attach**: on 0x547f40 a child sets pos = parentPos + parentR·localOffset (+0x130) and R = parentR·localR (+0x148), then forwards the message to its own children. This is `FUN_00445a80` for Switch. [recovered] Classes with this handler: Train, Smoke, Switch, Door, StationaryGun, ExplodeObject (so Generator, Radio, GenericTBA and Terminal), ConditionalContainer, GuardGenerator, EditRigidObj, SplineObjWaypoint, Container, ElevatorFloorIndicator, Elevator. Registration sites: 0x42ae3a, 0x4376fc, 0x444d3c, 0x4465f3, 0x473fe7, 0x4814dc, 0x4873d0, 0x487d11, 0x4f27d1, 0x502307, 0x505cd6, 0x43c77c, 0x43cd3a. There is **no** handler for Human or AIGraph. The local offset is captured at compile (e.g. `FUN_004453e0`) [inferred].
- **Class parents** [recovered]:
  - Elevator and ElevatorFloorIndicator ← RigidDynCubeObj (`FUN_004c48c0`).
  - Cabinet and GenericPickup ← SectorInteriorObj (`FUN_004e0830`).
  - Generator, Radio and GenericTBA ← ExplodeObject (`FUN_00481340`). PlaceExplosiveTBA ← GenericTBA (`FUN_00448550`).
  - Drawer ← magic-object class `FUN_004d9fa0`. BinocularOverlay and BinocularOverlayHolder ← base task (`FUN_004018f0`).
  - `FUN_00401900` copies the parent's handlers, so anything a class does not register is inherited.
- **Parameter names** are not in the exe. They come from each level's `Task_DeclareParameters`. The exe registers only the order, types and offsets (`FUN_004f1a80`), and the two orders match. Type constructors: f1010 ObjectPos, f0f70 Real32x9, f0fd0 String16, f0fe0 String32, f0fa0 Int32, f0fb0 Int16, f0f50 Real32, f0f20 Angle, f1000 bool8, f0fc0 VarString, f0f00 DropDownCombo. [recovered]
- **Member storage** [recovered]: `FUN_004b7ee0` = char, `FUN_004b7e80` = int, `FUN_004b7fc0` = **double** (size 8, type 2). The port's `TASK_MEMBERS` has no double kind yet; Elevator needs one.

## 1. Instances per mission [observed: all 14 `objects.qvm`, `readTaskTree`]

| Type | L1 | L2 | L3 | L4 | L5 | L6 | L7 | L8 | L9 | L10 | L11 | L12 | L13 | L14 | Σ |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Elevator | – | – | 2 | – | 1 | – | – | 1 | – | – | 2 | 4 | 3 | 3 | 16 |
| ElevatorFloorIndicator | – | – | – | – | – | – | – | – | – | – | – | – | – | – | 0 (no schema declared either) |
| Generator | – | – | 2 | – | 1 | – | 1 | 1 | – | – | 1 | 1 | – | – | 7 |
| Radio | – | – | – | – | – | – | 1 | – | – | – | 1 | – | – | – | 2 |
| Cabinet | – | – | – | – | – | 5 | – | – | – | – | – | – | – | – | 5 |
| GenericPickup | – | 1 | – | – | 2 | 2 | – | 2 | – | – | 2 | – | – | – | 9 |
| GenericTBA | – | 3 | – | – | – | – | – | 1 | – | – | – | – | – | – | 4 |
| PlaceExplosiveTBA | – | – | – | – | – | 2 | – | – | – | – | – | – | – | – | 2 |
| BinocularOverlayHolder | – | – | – | – | 1 | – | – | – | – | – | – | – | – | – | 1 |

No ComputerHilight in any mission targets one of these types (observed). The types do register the hilight handler (§0).

---

## 2. Elevator

### 2.1 Schema [recovered `FUN_0043cc70`, defaults `FUN_0043d010`; names observed]

| # | Name | Type | Offset | Default / range |
|---|---|---|---|---|
| 0 | Position | ObjectPos | +0xf0 (overwritten at run time with the current position) | 0 |
| 1 | Orientation | Real32x9 | +0x120 | identity |
| 2 | Model | String16 | +0x170 | "" |
| 3 | SplineObj taskid | Int32 | +0x180 | −1 |
| 4 | Linear | bool8 | +0x18c | 0 |
| 5 | Force orientation | bool8 | +0x18d | 0 |
| 6 | Pos (start arc distance, units) | Real32 | +0x188 | 0, range [0, 1e7]; the compile sets the editor max to the spline length |
| 7 | Max speed (m/s) | Real32 | +0x194 | 5.0, range [0, 10000] |
| 8 | Speed inertia (m/s added per tick) | Real32 | +0x198 | 0.99, range [0, 1] |
| 9 | Floor down | VarString | +0x534 | absent |
| 10 | Floor up | VarString | +0x4e4 | absent |
| 11 | Can start | VarString | +0x584 | absent = 1 |
| 12–21 | Wanted floor 0…9 | VarString | +0x1c4 + 0x50·i | absent |
| 22–24 | Start sound / Stop sound / Move sound | String32 | +0x5d9 / +0x5f9 / +0x619 | "" |

Run-time fields:

| Offset | Meaning |
|---|---|
| +0x184 | pos (arc distance, float) |
| +0x190 | speed (m/s) |
| +0x19c | nWantedFloor |
| +0x1a0 | vFloor (double) |
| +0x1a8 | vLastFloor (double) |
| +0x1b0[10] | isWantedFloor |
| +0x1bc | nInactive |
| +0x5d4 / +0x5d5 | last Floor up / last Floor down |
| +0x5d6 / +0x5d7 / +0x5d8 | isMoving / isStart / isStop |
| +0x63c | move-loop sound |
| +0x640 | last Can start (initially 1) |
| +0x644 | update guard |
| +0x108 / +0x148 | last world position / last R (platform delta) |

**Members** (`FUN_0043df20`) [recovered]:

| Member | Storage |
|---|---|
| vFloor, vLastFloor | double |
| isWantedFloor0…9 | char |
| nInactive, nWantedFloor | int |
| isMoving, isStart, isStop | char |

Handlers [recovered]:

| Handler | Address |
|---|---|
| create | `FUN_0043d010` |
| update | `FUN_0043d280` |
| destroy | `FUN_0043dcf0` (kills the move loop) |
| compile | `FUN_0043ddb0` |
| parent moved | `FUN_0043e1f0` |
| platform delta (0x53954e) | `FUN_0043e290` |

The elevator registers **no** use test or kind. The player never "uses" it; it presses Switches.

### 2.2 Floors = SplineObj waypoints [recovered `FUN_00502130`, `FUN_00502180`, `FUN_005020c0`, `FUN_00502200`]

- n floors = the number of SplineObjWaypoint children of the SplineObj "SplineObj taskid".
- f(i) = float sum of the segment lengths of waypoints 0..i, that is the arc length from waypoint 0 to waypoint i. Each waypoint k ≥ 1 owns segment k−1→k (`wp+0xf0 → seg+0xf8`). These are the same segments as docs/vehicles.md "Rail spline".
- total = f(n−1).

### 2.3 Per tick (`FUN_0043d280`) [recovered]

```
posOld = pos
if guard(+0x644) == *(DAT_00567c8c+0x34): return       // once per global tick [counter meaning inferred]
guard = counter
update children (they run first)
tgtOld = f(nWantedFloor)
for i in 0..9: if WantedFloor[i] present: isWantedFloor[i] = byte(eval)        // absent: keeps value (0)
up = present(FloorUp) ? int(eval) : 0
down = present(FloorDown) ? int(eval) : 0
can = present(CanStart) ? int(eval) : 1
if up && !lastUp:            nWantedFloor = min(nWantedFloor+1, n-1)      // rising edge of "Floor up"
elif down && !lastDown:      nWantedFloor = max(nWantedFloor-1, 0)        // rising edge of "Floor down"
else: for i in 0..9: if isWantedFloor[i]: nWantedFloor = i               // highest true index wins
lastUp = byte(up); lastDown = byte(down)
lastPos(+0x108) = worldPos(+0x20); lastR(+0x148) = R(+0x70)
if can: move()                                                            // FUN_0043d6e0 (below)
vLastFloor = vFloor; vFloor = 0
for i in 1..n-1: if f(i) > pos: vFloor = i - (f(i)-pos)/(f(i)-prev); break; prev = f(i)  // prev starts 0.0
if loop ran out (i == n): vFloor = n-1
tgt = f(nWantedFloor)
isMoving = (pos != tgt)                                                   // also true while halted by Can start = 0
if isMoving and no loop: loop = create(root, MoveSound); place at worldPos once
if !isMoving and loop: kill loop
isStart = (posOld == tgtOld && posOld != pos)  -> play StartSound at worldPos
isStop  = (pos == tgt && posOld != pos)        -> play StopSound at worldPos
if pos == tgt && !isMoving && can == lastCan: nInactive++ else nInactive = 0
lastCan = can
```

The three elevator sounds are created under the global root and positioned once at creation. Whether the loop then follows the car is **unknown**: it depends on whether `FUN_004e6c30` copies the position or keeps the pointer.

**move()** `FUN_0043d6e0` (needs a SplineObj and n > 0) [recovered; constants 0x53382c = 16384, 0x533828 = 1/16384, 0x5333c8 = 0.1, 0x533680 = 4096/30 = 136.5333, 0x5336c0/0x533824 = ±0.001]:

```
d = f(nWantedFloor) - pos
if |d| >= 16384 (4 m):
    if speed < Max: speed = min(speed + Inertia, Max)
    elif speed > Max: speed = max(speed - Inertia, Max)
else:
    speed = max(|d| * Max / 16384, 0.1)          // linear slow-down inside the last 4 m, floor 0.1 m/s
step = speed * 136.5333                          // units per tick
if d > 0.001: pos = min(pos + step, target)
elif d < -0.001: pos = max(pos - step, target)
else: pos = target
pose(); send "parent moved"(pos, R) to every child  // FUN_0043d960, FUN_0043d8c0
```

- The speed is not reset at stops. A new trip starts at 0.1 + Inertia.
- Example, Max 5 and Inertia 0.99: cruising 5 m/s (682.7 units/tick) is reached after 5 ticks.
- Inside 4 m the car covers about 4.2 %·Max/5 of the remaining distance per tick, down to 0.1 m/s at 8 cm. [derived]

**pose()** `FUN_0043d960` [recovered]:

- pos is clamped to [0, total]. At total, the evaluation uses total − 0.1.
- **Linear = 1**: world = lerp(waypoint 0 Position, last waypoint Position, pos/total), in doubles. R is unchanged (the Orientation parameter).
- **Linear = 0**: `FUN_004fec10(spline, &M, &world, &ok, pos, 0, 0, 0)` evaluates the spline polyline at arc distance pos, with a frame M. If ok and Force orientation = 0, R = Orientation·M (row-major product). With Force orientation = 1, R stays the Orientation.
- Then the sector re-link uses radius = model radius × max scale (`FUN_00416920`/`FUN_004c6940`).

**Compile** `FUN_0043ddb0` [recovered]:

- Load the Model and set R = Orientation.
- Set vLastFloor = vFloor (0), nInactive = 0, speed = 0.
- Compile all 13 expressions.
- pos = clamp(Pos, 0, total), then pose().
- Copy last pose = pose, so the first delta is 0.
- isStart = isStop = 0 and lastCan = 1. vFloor stays 0 until the first update.

### 2.4 Riders [recovered unless marked]

- **Humans** ride through the ground task. The platform method `FUN_0043e290` first calls the elevator's own update (`*(0xa970e0+class*4)`); the guard makes it a no-op if the elevator already ran this tick. It then returns c = worldPos, t = worldPos − lastPos and R_d = R·lastRᵀ. This is exactly docs/collision.md §13 (the port's `PLATFORM_TASK_TYPES` already lists Elevator).
- **Task children** move rigidly through 0x547f40: the inner Switch (all 16 elevators have one except L11 #88, L12 #1667 and L14 #1706), and Doors in L14 #1701/#1702. [observed children]
- AIGraph children (L11 #88, L12 #1667) have no 0x547f40 handler, but they are attached graphs (their parent, the Elevator, derives from RigidDynCubeObj): node positions follow the car (FUN_004f0340) and a soldier on them is attached to the elevator and rides it (FUN_00460fd0 -> FUN_00461f50; docs/ai.md "Soldiers on an attached graph", E199) [recovered]. HumanSoldier_-1 under L12 #1667 is not moved by the elevator code itself. [recovered: no handler]

### 2.5 Data [observed]

Standard lift (12 of 16): model 200_01_1, Max 5, Inertia 0.99 or 1, sounds elv_start_1 / elv_stop_1 / elv_move_1, an inner Switch child, Pos 0. Example, L3 Elevator_698 (Building_3077, spline 699, 2 waypoints, 30.5 m rise):

```
Can start      "Door_689.isClosed && Door_690.isClosed"
Wanted floor 0 "(Elevator_698.vFloor == 1 && Switch_697.isLastPressed) || Switch_688.isLastPressed"
Wanted floor 1 "(Elevator_698.vFloor == 0 && Switch_697.isLastPressed) || Switch_687.isLastPressed"
```

- The shaft doors (Door 689–696, Locked "1", slide 0.6 or 1.2 m in 0.6 s) have Open = "Elevator_698.vFloor == k" and Close = "Switch_697|688|687.isLastPressed". A press closes the doors, Can start becomes true, the car moves, and on arrival vFloor == k reopens that floor's doors.
- Can start sometimes also needs `Generator_N.isOn`: L3 #330, L11 #213, L12 #213.
- L5 #51 and L8 #811 have 3 floors.
- Every standard lift has a ConditionalContainer "Elevator_X.isMoving" holding an EditRigidObj "colbox2/3/4" (11 such containers: L3 666/555, L5 444, L8 555, L11 555, L12 444/121/122, L13 555/123/124). This is a collision box present only while moving. [observed; purpose inferred]
- **L14 #1701 / #1702**: model 245_01_1, Linear 0, Force orientation 1, 4 waypoints (horizontal, then vertical, then horizontal), floors 0 ↔ 3 only. Max 5 / 7.5, Inertia 1. Child Doors (Open "!Elevator.isMoving", 0.1 or 0.5 s, sounds elvdoor_*). [observed]
- **L14 #1706**: 433_06_1, 1.5 m/s, Wanted floor 0 "Terminal_1704.isHacked", floor 1 "AreaActivate_1801.nActive". [observed]
- **L11 #88 / L12 #1667**: 426_02_1, 2 / 1.5 m/s, a 66 m mostly horizontal path. Floor up "CutScene_114.isRun" / "1", so #1667 starts moving on tick 1 (rising edge against lastUp = 0). They carry AIGraph children. [observed]
- Member reads in data: vFloor (doors, wanted floors), isMoving (containers, doors). There are no reads of isStart, isStop, nInactive or nWantedFloor.

### 2.6 ElevatorFloorIndicator (unused) [recovered `FUN_0043c6d0`, update `FUN_0043ca10`, compile `FUN_0043cb70`, parent-moved `FUN_0043c390`]

The schema has 7 fields, no QVM names and no instances:

| Offset | Type |
|---|---|
| +0xf0 | ObjectPos |
| +0x108 | Real32x9 |
| +0x170, +0x180, +0x190 | String16 ×3 |
| +0x1a4, +0x1f4 | VarString ×2 |

- Update: children, then:
  - e1 = eval(+0x1a4) (absent counts as true);
  - e2 = eval(+0x1f4) (absent counts as true);
  - model = e1 ? +0x170 : +0x180 (the compile uses +0x180);
  - if e2, play the sound +0x190 at the position **every tick**.
- It follows a moving parent rigidly. 0x540904 (the bullet-hole message) is cleared, so it gets no decals.
- The port can ignore it (`effects.ts` already lists it).

---

## 3. Generator

**Schema** = ExplodeObject's 13 fields (Position … Explosion sound, docs/mission.md) plus the fields below [recovered `FUN_0043b2f0`, defaults `FUN_0043b490`]:

| Name | Type | Offset | Default |
|---|---|---|---|
| Run sound | String16 | +0x290 | "" |
| Shutdown sound | String16 | +0x2a0 | "" |
| On expression | VarString | +0x240 | absent |
| Use backup timer | bool8 | +0x2b4 | 1 |
| Seconds until power backup | Real32 | +0x2b0 | 10.0 |

- Run-time: isOn +0x23c (create 0, compile does not change it), nBackupTimer +0x2b8 (−1), run-loop sound +0x238.
- Members (`FUN_0043b6e0`): ExplodeObject's isExploded, plus isOn (char) and nBackupTimer (int).

**Update** `FUN_0043b500` [recovered; 0x5333bc = 30]:

```
wasOn = isOn
ExplodeObject update (children, explosion)
isOn = isExploded ? 0 : (present(On) ? byte(eval(On)) : isOn)
if UseBackup:
    if !isOn && timer == -1: timer = int(Seconds * 30)
    if timer < 1: isOn = 1          // also every tick while timer == -1 (no change then)
    else: timer -= 1
if !isOn: kill run loop; if wasOn: play ShutdownSound (child of the generator, at pos)
elif no loop && RunSound != "": loop = create(generator, RunSound) at pos
```

Consequences:

- With the backup timer, power is off for exactly N = int(S·30) ticks, then isOn = 1 **forever**. The timer stays 0 and is never re-armed, even while exploded.
- Without an On expression isOn starts at 0. So L12 Generator_99 (no model, no expression, 10 s) is off for the first 300 ticks.

There is no use, kind or HUD handling. The player interacts through child Switches or by shooting it (ExplodeObject damage, docs/damage.md).

**Sounds** [observed `common/sounds/sounds.qvm`]: generator_run is GENERATOR_RUN, volume 1, 0–25 m, loop. generator_stop is a one-shot, 0–25 m.

**Data** [observed]:

| Level | Task | Model | On expression | Backup | Notes |
|---|---|---|---|---|---|
| L3 | 98, 99 | 201_01_1 | "1" | 1 s | sounds generator_run / stop |
| L5 | 99 | 201_01_1 (destroyed 201_01_1) | "!Generator_99.isExploded" | 60 s | |
| L7 | 99 | 300_01_1 | "!isExploded" | 10 s | no sounds |
| L8 | 99 | 201_01_1 | "EditVariable_703.nValue > 0" | none | child Switch_258; EditVariable_703 "Turn Generator on" adds Switch_258.isPressed |
| L11 | 100 | 201_01_1 | "!isExploded" | 10 s | |
| L12 | 99 | none | absent | 10 s | |

isOn feeds Elevator Can start, Switch On, Terminal / AlarmControl / SCameraControl On, Door_240 (L8) and StatusMessage_1004/1005 (L8).

## 4. Radio

**Schema** = ExplodeObject's 13 fields plus the fields below [recovered `FUN_0043ad80`, defaults `FUN_0043af20`]:

| Name | Type | Offset | Default |
|---|---|---|---|
| Radio sound 0…3 | String16 | +0x294 + 0x10·i | "" |
| Shutdown sound | String16 | +0x2d4 | "" |
| On expression | VarString | +0x244 | absent |

- Run-time: isOn +0x240 (the compile sets 0), countdown +0x23c (the compile sets 0), a weak handle to the current sound at +0x238.
- Members (`FUN_0043b1c0`): isOn plus isExploded.

**Update** `FUN_0043af90` [recovered]:

```
wasOn = isOn; ExplodeObject update
isOn = isExploded ? 0 : (present(On) ? byte(eval) : isOn)
if !isOn: kill current sound; if wasOn: play ShutdownSound (child) at pos
else:
    if a sound is still playing: return
    free the ended handle
    if countdown != 0: countdown -= 1; return
    k = rand(4)  [level RNG]; snd = create(radio, RadioSound[k]) at pos
    countdown = rand(150) + 150  [level RNG]          // gap of 5–10 s after the sample ends
```

**Data** [observed]:

- L7 Radio_3366: model 204_01_1, destroyed 204_02_1, explosion radius 2 / delay 1 / 3 fragments / 3 fireballs, all sound names "", On "1".
- L11 Radio_201: the same, but On "" (absent), so it is never on.
- L7 AnimTask_306.Run reads "!Radio_3366.isExploded && AlarmControl_97.isAlarm && …". Shooting the radio stops the reinforcements. [inferred]
- **Port note**: the L7 radio has no audible samples but **still draws two level-RNG values** on tick 1 and then every (r+150)+1 ticks.

## 5. Cabinet (+ Drawer)

**Schema** [recovered `FUN_00443ed0`, defaults `FUN_00444420`]:

| Name | Type | Offset | Default |
|---|---|---|---|
| Position | ObjectPos | +0xf0 | |
| Orientation | **Angle** (one float, yaw; R = `FUN_004b3be0`, Rz) [Rz inferred] | +0x108 | |
| Model | String16 | +0x10c | |
| Search Time (s) | Real32 | +0x12c | 4.0 |

- Run-time:

| Offset | Meaning |
|---|---|
| +0x11c | drawer opening |
| +0x11d | drawer closing |
| +0x11e | drawer reset |
| +0x11f | isInUse |
| +0x120 | isLastInUse |
| +0x124 | useTick |
| +0x128 | isSearched |
| +0x130 | drawer-update enable |
| +0xe8 | drawer container |

- Members (`FUN_004449c0`): isInUse, isLastInUse, isSearched (char).

**Handlers** [recovered]:

| Handler | Address | Notes |
|---|---|---|
| create | `FUN_00444420` | adds itself to the use list |
| update | `FUN_00444590` | |
| compile | `FUN_004446e0` | instantiates the model's magic objects. 206_01_1 has one ATTA "206_02_1" = TASKTYPE_DRAWER [observed magicobj.qvm, level6.res] |
| use test | `LAB_00444860` | |
| kind | `LAB_00427d70` | = 4 |
| active | `LAB_00444940` | |
| icon | `LAB_004449a0` | |
| Drawer | create `FUN_00444150`, update `LAB_00444260` | |

**Use test** (point 0) [recovered]:

```
p = pos + point0
d = eye - p
if colY(R)·d > 0 and |colX(R)·d| < 3072: FUN_00416ad0(ctx, cab, p)
```

`FUN_00416ad0` is the common test: 2 m, π/4 angles for the player (docs/interactions.md §1). There is no "on" gate, so the cabinet can be searched again after isSearched.

**HUD** [recovered]: icon = StatusScreen sprite slot 0 (hud+0x3ec) = `STATUSSCREEN:action_searchcab.spr`. The sprite table at 0x540b70 is copied to 0x5c8a4c at 0x4869a6.

**Player state 31** (entry `FUN_0040c2f0`, tick `LAB_0040c510`; state table 0x5385b4) [recovered]:

- **Entry**:
  - arms off (`FUN_004137e0`(h, 0)); clip 84 one-shot.
  - Stance = (pos + point0) + R·(778.24, 2457.6, 0), with heading = γ(R) + π, then the ground snap (`FUN_00463260`).
  - Weapon holstered (+0xd44), progress bar on (+0xd68), limit +0xd60 = int(Search Time × 30), counter +0xd64 = 0.
  - View mode 3 (third-person orbit); yaw and pitch locked (`FUN_00463590`, `FUN_00464720`, `FUN_00464700`).
- **Tick**:
  - phase 0: when clip 84 finishes, play clip 85 looped → phase 1.
  - phase 1: when limit − 65 < counter, play clip 83 with 0.2 blend → phase 2. 65 = int(dur(83) = 10400 × (1/4800) × 30).
  - counter = min(counter + 1, limit).
  - **At the limit**, with Activate held and alive: isSearched = 1 (`FUN_00444b90`), then exit.
  - Before the limit, if Activate is released or the player is dead: `FUN_00444ba0` (reset +0x11e = 1, drawer snaps shut), then exit.
  - At the limit with Activate released: the same abort.
- **Exit**: weapon back, view mode 1, locks off, release (`FUN_00463620`, active = 0), progress bar off, idle state.
- With 4 s (all data) the run is: clip 84 for 50 ticks, clip 85 until tick 56, clip 83 for 65 ticks, done at tick 120.

**Active call** (method 0x539544, every tick of the use from `FUN_00460ee0`):

- isInUse = 1 and useTick = LevelFlow.nTick.
- The context's +0x24 is `human+0x538`, the anim event trigger of the tick. Trigger 0 means open (+0x11c = 1, +0x11d = 0, enable). Trigger 1 means close (+0x11d = 1, +0x11c = 0, enable).
- [observed `common/anims/000.iff`]:

| Clip | Length | Events |
|---|---|---|
| 84 | 1.667 s | trigger 0 at 0.333 s, trigger 1051 at 0.367 s (= animtrigger "cabinet", attached to the human: the open sound) |
| 85 | 6.27 s loop | none |
| 83 | 2.167 s | trigger 1 at 1.033 s (close) |

**Drawer tick** (only while enabled) [recovered; 0x5338a0 = 153.6, 0x53389c = 1843.2, 0x533898 = 102.4]:

- opening: slide += 153.6 per tick up to 1843.2 (0.45 m in 12 ticks), then disable;
- closing: slide −= 102.4 per tick down to 0 (18 ticks), then disable;
- reset: slide = 0, then disable;
- drawer pos = rest + R·(0, slide, 0).

**Cabinet update** `FUN_00444590`: children; the drawer tick while enabled; if useTick + 2 < nTick then isInUse = 0; isLastInUse = isInUse.

**Sound** [observed]: "cabinet" = CABINET, volume 1, 0–30 m, once.

**Data** [observed]:

- L6 Cabinet_1500–1504 in Building_2100: model 206_01_1, 4 s. Yaws −1.57 (×3) and 3.14 / 3.1516.
- StatusMessage_706 Send = "(Cabinet_1500|1501|1502.isSearched) && (Cabinet_1503|1504.isSearched)".
- Nothing is given by searching. Item effects are purely mission expressions.

## 6. GenericPickup

**Schema** [recovered `FUN_0046c0c0`, create `LAB_0046c2b0`]:

| Name | Type | Offset |
|---|---|---|
| Position | ObjectPos | +0xf0 |
| Orientation | Real32x9 | **directly into the render matrix +0x70** = Rz γ·Ry β·Rx α of the QVM Euler angles |
| Model | String16 | +0x108 |

- Run-time: isPickedUp +0x119, inWorld +0x11a (create 1).
- Member (`LAB_0046c570`): isPickedUp (char).

**Touch** `FUN_0046c630` (method 0x539541) [recovered]. The player loop `FUN_00410f70` calls it for every pickup-list object with the player position (+0x20), only when the player is alive.

```
r = max(model radius * max scale, 2867.2)
if |(dx, dy, 0)| < r and |dz| < 4096: isPickedUp = 1
```

- The touch has **no** inWorld or visibility test. AI never touch pickups.

**Update** `FUN_0046c3c0` [recovered]: if isPickedUp && inWorld: play 2-D "pickup" (`FUN_004e7200`) and remove from the world. isPickedUp stays 1.

- There is no inventory change, no message and no HUD element. Mission expressions do everything.
- Messages 0x548177 (`FUN_0046c8a0`) / 0x548176 (`FUN_0046c750`) remove / add the pickup. Add only works if it is not picked up.
- Both ray filters return 0 (`FUN_0045f920`), so rays and the C4 placement ray pass through it. [recovered value; filter meaning inferred]
- It is drawn as a static rigid model, with no spin or bob. [inferred from the SectorInteriorObj base]

**Sound** [observed]: "pickup" = PICKUP (0–20 m definition; played 2-D, so only the sample is used).

**Data** [observed]:

| Level | Task | Name | Model | Gates |
|---|---|---|---|---|
| L2 | 200 | – | 139_02_1 (C4) | EditVariable_270 → GenericTBA On; StatusMessage_218 |
| L5 | 301, 80 | – | 141_01_1 | 80.isPickedUp unlocks Door_-1 ("Locked expression !GenericPickup_80.isPickedUp"); EditVariable_22 |
| L6 | 755, 756 | "C4" | 139_02_1 | both feed PlaceExplosiveTBA On and StatusMessages 708/710 |
| L8 | 860 | "Map Computer" | 112_02_1 | gates HumanPlayerInput "Mapcomputer on expression" and objective 3 |
| L8 | 870 | "Laser Designator" | 140_01_1 | gates GenericTBA_181 |
| L11 | 333 | – | 324_01_1 | unreferenced |
| L11 | 250 | – | 105_01_1 | unreferenced |

## 7. GenericTBA ("to be activated" [inferred name])

**Schema** = ExplodeObject's 13 fields plus the fields below [recovered `FUN_00447db0`, defaults `LAB_00447ff0`]:

| Name | Type | Offset | Default |
|---|---|---|---|
| Explodable | bool8 | +0x238 | 0 |
| On Expression | VarString | +0x258 | absent; isOn create = 1 |
| Activate Anim | Int16 clip id | +0x24a | −1 |
| Activate Time (s) | Real32 | +0x24c | 4.0 |
| Click to select sprite | DropDownCombo string | +0x250 | |

- The sprite list is 10 entries (`DAT_0057c1f0` = 10, list `FUN_004871b0` = 0x5c8a4c):
  0 action_searchcab, 1 action_comput, 2 action_picklock, 3 a_gun, 4 action_pressbutton, 5 a_door, 6 a_fence, 7 a_ladder, 8 a_wire, 9 a_c4 (all `STATUSSCREEN:…spr`).
- The compile `LAB_00448200` resolves the sprite by exact string match to hud+0x3ec + i·0x18 (+0x254).
- ExplodeObject defaults (`FUN_00481360`): damage scale 1, radius 0.5, falloff 0.5, damage 1, delay 0, fragments 5, fireballs 4, "explo_02_m".
- **Members** (`LAB_004482d0`): isInUse, isLastInUse, isOn, isFinished, isFinishedThisTick (char), plus isExploded.

**Update** `LAB_004480b0` [recovered]:

```
if Explodable: ExplodeObject update (children + explosion)     // non-explodable TBAs never update children or explode
isOn = isExploded ? 0 : (present(On) ? byte(eval) : isOn)
if useTick + 2 < nTick: isInUse = 0
isLastInUse = isInUse
if finishTick + 2 < nTick: isFinishedThisTick = 0
```

**Use test** `LAB_00443c80` [recovered]: only when isOn. p = pos + point1. The rest is as Cabinet: in front on col Y, |col X · d| < 3072, then the common 2 m / π/4 test.

**Kind** = 12 (`LAB_0051baa0`). **Icon** (`LAB_00448510`) = the resolved sprite (+0x254). **Active** (`LAB_004484f0`): isInUse = 1, useTick = nTick.

**Player state 35** (entry `FUN_0040cf70`, tick `LAB_0040d580`) [recovered]:

- **Entry**:
  - crouch flag off (+0x33d); arms off.
  - Clip = Activate Anim, **looped** (`FUN_00489ea0`(h, clip, 1, 0)).
  - Stance = (pos + point1) + R·(0, 3481.6, 0), with heading γ(R) + π, then the ground snap.
  - Holster, progress bar on, limit = int(ActivateTime × 30), counter = 0, view mode 3, locks.
  - No state sound: +0xd70 = 0. Clip 245 has no events [observed].
- **Tick**: counter = min(counter + 1, limit).
  - At the limit with Activate held and alive: `FUN_00443ea0` sets isFinished = 1, isFinishedThisTick = 1 and finishTick = nTick, then exit.
  - Released or dead earlier: exit without finishing.
  - Exit is as for the cabinet.
- The TBA stays usable after finishing unless its On expression excludes it.

**Data** [observed]:

- L2 GenericTBA_282/284/286: model 202_01_1, sprite a_c4, anim 245, 4 s.
  - On = "EditVariable_270.nValue == 1 && !ConditionalContainer_20x.isRun". EditVariable_270 becomes 1 once the C4 pickup 200 is taken.
  - ConditionalContainer_203/204/205 (Condition "GenericTBA_28x.isFinished") show an EditRigidObj 139_02_1 (the planted charge). EditVariables 301–303 count them.
- L8 GenericTBA_181: no model, a_c4, 245, 6 s, On "GenericPickup_870.isPickedUp" (the laser designator).
  - Its isFinished shows the designator model 140_01_1 (ConditionalContainer_458) and starts the Su27 strike (ConditionalContainer_454).
  - It also feeds objective 4 and StatusMessage_1015.

## 8. PlaceExplosiveTBA

**Schema** = GenericTBA's plus the fields below [recovered `FUN_004388b0`, defaults `LAB_004389a0`]:

| Name | Type | Offset | Default |
|---|---|---|---|
| Activate radius (meters) | Real32 | +0x2a8 | 0.75 |
| Task ID to place | Int32 | +0x2ac | −1 |

- It overrides only create, schema, use test and kind (13, `LAB_00438bf0`).
- It inherits the update, members, icon (its sprite), active call and the finish.

**Use test** `LAB_004389e0` [recovered; 0x5333b8 = 4096]:

```
if isOn:
    p = pos + point1          // no model in the data, so p = Position
    d = p - eye
    if |d| < radius * 4096 and ctx.winner == 0:     // only if nothing earlier in the list won
        local = viewᵀ·d
        if local.y > 0:
            v, h = |angles| (FUN_004148f0 / FUN_00414950)
            if v < best_v and h < best_h: win
```

- There is no "in front of the object" test and no 2 m limit. With the L6 data (6.8 m) it can be targeted from 6.8 m.

**Player state 36** (entry `FUN_0040d180`, tick `LAB_0040d580`, the same tick as 35) [recovered]:

- **Entry** is as state 35 (crouch off, looped Activate Anim, limit, view mode 3, locks), except for the stance:
  - eye = camera eye (`FUN_00465800`); P = pos + point1.
  - Segment query eye → P with filter 0x539548 (`FUN_00416920`, `FUN_004cc2a0`).
  - On a hit: X = hit point, n = the hit's direction vector (query +0x38) [normal inferred]. Otherwise X = eye and n = P − eye.
  - γ = yaw(unit(n)) (`FUN_004b2d00`) + π/2.
  - If "Task ID to place" ≥ 0, the task exists and it is an EditRigidObj (`FUN_00401cf0`(class, `DAT_0054e1ac` "EditRigidObj")): its +0xf0 = X, and its +0x108 and +0x70 = Euler(α = π/2, β = 0, γ). **The charge is moved at the start of the use, even if the use is then aborted.**
  - Player position = X − unit(P − eye)·2048, then the ground snap; heading = γ.
- **Data** [observed]:
  - L6 PlaceExplosiveTBA_1602/1603: no model, Orientation γ = π, a_c4, anim 245, 4 s, radius 6.8 m, place 1610/1611.
  - On = "GenericPickup_755.isPickedUp && GenericPickup_756.isPickedUp && !PlaceExplosiveTBA_160x.isFinished".
  - EditRigidObj_1610/1611 "c4" (139_02_1, Orientation α = π/2) live in ConditionalContainer_356/358 (Condition "PlaceExplosiveTBA_160x.isFinished && !ExplodeObject_1600.isExploded").
  - LevelTimer_1604 On "1602.isFinished && 1603.isFinished" blows ExplodeObject_1600 "Large Fuel Tank" at nTick == 20·30.

## 9. BinocularOverlayHolder (+ BinocularOverlay)

**Holder** [recovered `FUN_00470fa0`]:

- Size 0x78. Schema: one field, "Visible expression" (VarString, +0x24). visible +0x74 (create 0), overlay handle +0x20.
- No members, no use.
- Update `LAB_00471330`:

```
if present: visible = byte(eval)
if !visible and the overlay exists: delete it
elif visible and no overlay: overlay = create BinocularOverlay under (StatusScreen container) = FUN_00485320(*(DAT_0057babc+0x44))
```

  The weak handle comes from `FUN_00401ae0`. Destroy (`FUN_00471400`) deletes the overlay.

**BinocularOverlay** (size 0x2e00):

- create `LAB_00471120` (fonts, 12 level bars);
- draw on the StatusScreen draw message 0x540b5c (`FUN_00471440` → `FUN_00471480`);
- camera source: either message 0x53f314 (`LAB_00472440`: the HumanCamera's eye, view axes and FOV; the Binocular weapon path), or slot 0x5488c8 (`LAB_00472400`), which copies the global view camera position `DAT_00bcab08` and forward `DAT_00bcaaf8` [globals' meaning inferred].
- The drawing is the one documented in docs/hud.md "Binocular overlay" [recovered there], with one full-game difference [recovered]: the RANGE ray is 1000 m, or 914.4 m (3000 ft) when the region string at 0x5c8c20 is "USA" (`FUN_0048f2d0`). The text is "%s: %0.f%s" with "M"/"ft" (or "%0.f+" with no hit), and the label is from `weapons/strings/Binoculars/range`, else "RANGE".
- With the 0x5488c8 path the projection matrix +0x38 / FOV +0x78 are not set, so the target squares are **unknown** in the holder case.

**Data** [observed]: L5 BinocularOverlayHolder_-1 is inside ConditionalContainer_1000 "Intro Cutscene". Visible = "CutScene_3500.isFinished && !CutScene_3501.isFinished && ConditionalContainer_1000.isRun". This is CutScene_3501 "Binoculars": Jones looks at the base. The isRun term matters because the container updates its children once on its stop tick (docs/mission.md), so the overlay is removed. [inferred]

---

## 10. In the port

| Part | Where |
|---|---|
| Behaviours (create / compile / update / members, the recovered rules above) | `web-port/src/loaders/objects/elevator.ts`, `power.ts` (Generator, Radio, the ExplodeObject family list), `use-tasks.ts` (Cabinet + drawer, GenericPickup, GenericTBA, PlaceExplosiveTBA, BinocularOverlayHolder, the player entry points) |
| Registration | `loaders/mission.ts` `registerTaskBehaviour` (the runtime calls create in pre-order, compile after the create pass, update at the node's place in the tick order; members are published as `<Type>_<id>.<member>`) |
| Models | `loaders/level.ts` POSE_SPECS (Elevator, Generator, Radio, Cabinet with its one-angle Orientation, GenericPickup, GenericTBA; PlaceExplosiveTBA has no model in the data); `engine/level.ts` MOVING_TASK_TYPES (Elevator, Cabinet, GenericPickup) and CARRYING_TASK_TYPES (an elevator's children become dynamic) |
| Engine side | `engine/mission/object-presenter.ts`: the sounds (MissionHost.onTaskEvent), the elevator model and its carried children (current x compile^-1; doors compose it with their own motion), the drawer (render only), the charge a PlaceExplosiveTBA moves, picked-up pickups leaving the world, the binocular holder flag |
| Riders | `MissionSystem.prepareRide` before the player's platform step: an elevator whose node has not run this tick updates early (FUN_0043e290 + the once-per-tick guard) |
| Use tests, stances | `engine/player/use-objects.ts` `timedUseTest`, `timedUseStance`, `placeExplosiveStance`, `UseSearch.considerFirst`, `tbaSprite` |
| Player states 31 / 35 / 36 | `engine/player/interact.ts` (`startTimed`, `tickObjectUse`, the active call with human+0x538) and `player.ts` (the use clip, the body's first event as the next tick's trigger, animtrigger sounds such as 1051 "cabinet") |
| Pickup touch | `player.ts` `touchGenericPickups` (every tick while alive, every GenericPickup, no in-world test) |
| Binocular overlay | `ui/hud.ts` `holderScopeView` (view camera position and forward, RANGE ray 1000 m / 914.4 m in the USA build), drawn by `hud-draw.ts` `submitHud` also during cut-scenes |
| Tests | `web-port/tests/objects.test.ts` (synthetic), `tests/full-objects.test.ts` (all 14 missions) |

Browser checks (preview build, `?test&mission=N`):

- **L3 Elevator_698:** pressing Switch_697 closes the shaft doors. The car then starts (Can start), accelerates to 5 m/s, slows over the last 4 m and stops at floor 1. A player standing in it rides up 30.4 m, and the inner switch moves with the car.
- **L6 Cabinet_1500:** the cabinet icon appears. Holding Activate gives the state 31 search: third-person view, progress bar, the drawer opening on clip 84's trigger 0 and closing on clip 83's trigger 1. isSearched is set at tick 120.
- **L2:** C4 pickup 200 sets EditVariable_270, which turns on GenericTBA_282 (icon a_c4.spr). State 35 for 4 s sets isFinished, which runs ConditionalContainer_203 (the planted charge).
- **L6:** both C4 pickups turn on PlaceExplosiveTBA_1602. State 36 moves EditRigidObj_1610 to the eye ray's hit and puts the player 2048 units back. isFinished then runs ConditionalContainer_356.
- **L5:** the binocular overlay shows during CutScene_3501 of the intro.

Not ported:

- The drawer's collision (it stays with the cabinet body).
- The rays passing through GenericPickups (their models keep their collision).

## 11. Open / unknown

- Whether `FUN_004e6c30` makes the elevator move loop (and the generator / radio sounds) follow the object, or just places them once.
- The exact hit-record field used as n in state 36 (normal assumed).
- The meaning of the global counter `*(DAT_00567c8c+0x34)` used by the elevator guard (assumed: once per logic tick).
- The binocular target squares and the projection in the holder (cut-scene) path.
- ElevatorFloorIndicator parameter names (never declared in any shipped level).
- The Cabinet "Angle" → matrix convention (Rz assumed).
- Clip 245's visual content.
- The meaning of method 0x539549 (Cabinet and ElevatorFloorIndicator register an empty handler `FUN_004d3710`).
