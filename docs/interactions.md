# Player interactions: Use / Activate, ladders, fences, wires, pickups

How igi.exe lets the player use objects (doors, switches, terminals,
ladders, fences, wires) and collect pickups, and how the port reproduces it.

Port code:

- `web-port/src/engine/player/use-objects.ts`: the target search, the use
  kinds, the HUD icons and the per-type use tests;
- `web-port/src/engine/player/clip-track.ts`: a body-animation track with
  the exe's speed / reverse / event rules;
- `web-port/src/engine/player/attach.ts`: the attached states (ladder,
  fence, wire);
- `web-port/src/engine/player/interact.ts`: the controller (model data,
  use list, Activate dispatch, terminal hacking, lock picking);
- `web-port/src/engine/combat/pickups.ts`: GunPickup / AmmoPickup, soldier
  weapon drops;
- `web-port/src/engine/player/player.ts`: the hooks in the player tick.

Tests: `web-port/tests/interactions.test.ts`.

Evidence labels:

- **observed**: measured in the game data (file and method named);
- **recovered**: read from igi.exe code (addresses given);
- **inferred**: an interpretation that fits code and data but is not proven.

Units are IGI units (4096 = 1 m), z up. Object matrices are row-major,
columns = model axes in world space (`obj+0x70`).

## 1. The use target search [recovered]

The player tick `FUN_00410a30` calls `FUN_0045fb20` third (after the
platform update `FUN_0045f930`), before both state machines:

1. The target (`human+0x7b0`) is cleared.
2. Only when the human is **grounded** (state flag 4, `human+0x2f4`) and
   **not using anything** (`human+0x7b8 == 0`), a search context is built:
   - origin: the camera eye (`camera+0xe0`, `FUN_00464470`);
   - view axes: `camera+0xf8` (`FUN_004644f0`), columns right, forward, up;
   - best vertical / horizontal angle = **π/4** for the player
     (`FUN_00461d90` is true for the camera's human, `0x5317c0`), π for
     other humans (`0x531400`);
   - range: f64 **8192 units (2 m)** at `context+0x78`;
   - winner at `context+0x80`.
3. Method `0x42a` (the use-target test) of every object in the use list
   `DAT_00577b5c` (capacity 512, objects add themselves on create with
   `FUN_004b79c0`) runs in list order. The winner becomes the target.
4. While an object is active (`human+0x7b4`), its method `0x42c` runs every
   tick, still only when grounded, with a use counter `human+0x7bc`.

**Common point test** `FUN_004159d0(context, object, point)`:

- `|point − eye| < range` (3-D);
- local = view axesᵀ · (point − eye); **local.y > 0** (in front);
- v = |`FUN_004868f0`(local)| = angle of (0, y, z) from +y;
  h = |`FUN_00486950`(local)| = angle of (x, y, 0) from +y;
- if **v < best v and h < best h** (both strictly): both bests are
  replaced and the object wins.

Ladder (bottom) and Fence do not use it: inside their region they set the
winner with both angles **0** ("claim"), so nothing later in the list can
beat them.

### Use kinds, icons [recovered]

Kind = method `0x42b`; HUD icon = method `0x42e` → `FUN_00485130`
(docs/hud.md). The HUD draws the icon only while `+0x7b8 == 0` and a target
exists (`0x45f0f1`).

| Type | Kind | Getter | Icon |
|---|---|---|---|
| Switch | 2 | `0x4e6d20` | action_pressbutton |
| Door | 3 | `0x4e6b60` | a_door, action_picklock when locked |
| Cabinet | 4 | `0x427380` | action_searchcab |
| Terminal (also AlarmControl, SCameraControl: parent `FUN_00442fc0`) | 5 | `0x442f50` | action_comput |
| StationaryGun | 6 | `0x4736f0` | a_gun |
| Wire | 9 | `0x43e880` | a_wire |
| Ladder | 10 | `0x43f880` | a_ladder |
| Fence | 11 | `0x4e6430` | a_fence |
| GenericTBA | 12 | `0x4261c0` | its sprite parameter |
| PlaceExplosiveTBA | 13 | `0x437e80` | — |

Registrations: `FUN_00443d10` (Switch), `FUN_00445290` (Door),
`FUN_00443040` (Cabinet), `FUN_00442860` (Terminal), `FUN_004726f0`
(StationaryGun), `FUN_0043e1b0` (Wire), `FUN_0043f5a0` (Ladder),
`FUN_0043eac0` (Fence), `FUN_00446c20` (GenericTBA), `FUN_00437b40`
(PlaceExplosiveTBA). The slot ids `0x537428…0x537436` are allocated in
`FUN_004148b0`.

### Per-type use tests [recovered]

| Type | Test | Rule |
|---|---|---|
| Ladder | `FUN_0043f680` | local = Rᵀ(eye − pos). **Bottom**: \|local.y\| < 2 m, −2867.2 < local.x < 2867.2 (`0x531868`/`0x531440`), angle(view forward, ∓ ladder y towards the ladder) < π/4, pos.z < eye.z < pos.z + point1.z → claim, `human+0xd7b = 0`. **Top**: (eye − point1) · ladder y < 0 and `FUN_004159d0`(point 1) → `+0xd7b = 1` |
| Wire | `FUN_0043e720` | the wire point nearest the eye (clamped to the ends) → `FUN_004159d0` (docs/wire.md §6) |
| Door | `FUN_00445920` | locked and not pickable (`+0x198`, `+0x13c`) → no part. p0 = point 0; local = Rᵀ(eye − p0); −4096 < x < 1843.2 and −4096 < z < 4096 (`0x5318b0`, `0x5318a8`, `0x531498`) → `FUN_004159d0`(p0) and `FUN_004159d0`(p0 + R(x, 0, z)) |
| Switch | `FUN_00444500` | not destroyed (`+0x1c2`); p = point 0; in front (R col1 · (eye − p) > 0), \|R col0 · (eye − p)\| < 3072 (f64 `0x531890`) → `FUN_004159d0`(p) |
| Terminal | `FUN_00442e60` | isOn (`+0x240`); as Switch with point 1 |
| Fence | `FUN_0043f280` | not electric (`+0x11c`); local = Rᵀ(eye − pos): \|local.y\| < 2 m, point0.x < local.x < point1.x, angle(view forward, ∓ fence y) < π/3 (f32 `0x531858`) → claim |

"Point i" is the model's XTVM point i (`FUN_00486e20` world offset R·S·p,
`FUN_00486ed0` local S·p).

## 2. Activate and the dispatch [recovered]

Activate is input channel 9 (`human+0x1b0` current, `+0x110` previous
tick; channel names at `0x536778`: 0 Analog X … 4 Up, 5 Down, 6 Fire,
7 Alternate fire, 8 Reload, **9 Activate**, 10 Crouch, 11 Jump …).
The state-flag function `FUN_004106b0` turns channels into flags:
0x20 Left, 0x40 Right, **0x80 Up**, **0x100 Down**, 0x200 Fire, 0x400 Alt
fire, 0x800 Reload, 0x1000 Activate, 0x2000 Crouch, 0x4000 Jump; 1 = body
clip finished (anim flag 0x100), 4 = grounded, 0x20000 = dead
(`FUN_00408530`).

It is read in the upper-body machine's idle state `FUN_0040ead0`
(second machine at `human+0xcf8`, table `0x5366d0`), after fire,
alternate fire, reload, next weapon and a pending weapon selection have had
their turn (each of them returns first):

- `+0x7b9` (latch) is cleared when Activate is up;
- target present, latch clear and **Activate held** → kind = method
  `0x42b`, `FUN_00464650`(camera), `FUN_0040ce30(human, kind)`.

`FUN_0040ce30`: active = target (`FUN_004622e0`), in use
(`FUN_00462250`, `+0x7b8 = 1`), counter 0, then:

| Kind | Effect |
|---|---|
| 2 Switch | `FUN_00443ce0`: isLastPressed = isPressed, isPressed = 1, press tick = LevelFlow tick; release |
| 3 Door | unlocked: `FUN_00446c10` toggles the request, `FUN_0040c370` AI DOOR noise (type 12, flags 0x46, 20480 units); release. Locked and pickable: lock-pick state 30 |
| 4, 5, 6, 7, 12, 13 | states 31, 32, 33, 34, 35, 36 (cabinet, terminal, stationary gun, ?, generic TBA, explosive) |
| 9 Wire | `FUN_0043ea60`: slide (`+0xda0`) or traverse (`+0xd93`) |
| 10 Ladder | `+0xd78 = 1` |
| 11 Fence | `+0xd90 = 1` |

"Release" is `FUN_00462260`: `+0x7b8 = 0`, `+0x7b9 = 1` (so one press
uses one object; the latch clears once Activate is released), and the
callers clear the active object.

After both state machines the player tick runs the attach functions
(`FUN_00411380` ladder `+0xd78/+0xd79`, `FUN_00411710` fence
`+0xd90/+0xd91`, `FUN_00411a80` traverse `+0xd93/+0xd94`, `FUN_00411ec0`
slide `+0xda0/+0xda1`): the request flag attaches, the "attached" flag
re-runs the detach checks every tick.

**Attach effects** (all four): position (`FUN_00461de0`, clears slide and
knock-back), heading (`FUN_00461e60`), air velocity 0, `+0x510 = 1` (yaw
input ignored, `FUN_0045fd00`), camera `+0x138 = 1` (pitch input ignored,
`FUN_00463470`) and `FUN_00463390` (view pitch reset to 0), `+0x694 = 1`
(no sweep, no ground probe in `FUN_004600f0`), ground released
(`FUN_00461f10`), `+0x52c = 1` (root motion not scaled by 1.75),
`+0x4f0 = 3` (view mode 3: the third-person orbit camera, §10), weapon
holstered (`FUN_0040c600`, `+0xd44 = 1`; the upper-body machine drops to
state 0). Detach undoes them.

**Not an attach**: `human+0x76c` (the "attach task", debug label
"Attach task" at 0x5370b0, that makes `FUN_00410a30` call `FUN_00461930`
instead of `FUN_004600f0`) is set by `FUN_00461f50` only for a
StationaryGun user (player state 33 at 0x40cbb9, AI at 0x45880a /
0x45b3da) and, in the ground probe `FUN_00460fd0`, only for AI soldiers
(`human+0x800` = their HumanAI) whose AIGraph is flagged as attached; the
player standing on a vehicle is carried through the ground task instead
(docs/collision.md §13). Ladders, fences and wires never set it: they move
through `FUN_004600f0` with `+0x694 = 1`. [corrected; recovered]

## 3. Animation tracks [recovered]

The attached states drive the body clip's speed (`clip-track.ts`):

- start (`FUN_004cb5f0`): forward from 0 at +160 ticks per game tick, or
  (flag 2) reversed from the duration at −160; flag 0x8000 fires the start
  events on the first advance;
- speed (`FUN_004ccc10`): 160 × s; `FUN_004ccbe0` sets the reverse flag
  when s < 0;
- advance (`FUN_004cb1f0`, events `FUN_004cb450`): forward (t, t′],
  backward [t′, t), both exactly t when t = t′; at the end the finished
  flag 0x100 rises; a loop wraps (forward events (−1, t′ − d], backward
  [t′ + d, d + 1)); a one-shot clamps;
- the human keeps the first event of the tick (`+0x538` trigger, `+0x540`
  time; `FUN_00460010` resets the trigger to −1 first).

The anim advances in `FUN_00460010`, after the state handler, and the root
change `FUN_004c9650` reads is that of the previous advance. The port
applies each advance's change in the same tick (one tick earlier; the
total motion is identical) [port simplification].

## 4. Ladders [recovered]

Ladders are `TASKTYPE_LADDER` magic objects of buildings (`FUN_0043f440`
create; type parent `FUN_004d0590`). Level 1 has six (observed):

| Building | Model | Rungs |
|---|---|---|
| 1118 | 400_18_1 | 24 |
| 1118 | 400_17_1 | 20 |
| 1104 | 435_02_1 | 59 |
| 1105 | 314_01_1 | 38 |
| 1121 | 417_02_1 (×2) | 24 |

Model points (observed, XTVM): p1 = the top, p2 = the foot (z ≈ 0), p3 =
2611.2 units under p1 (the top hold base), p0 ≈ 1.84 m (unused here).
Ladder +y points away from the wall: the climber stands on that side.

- **Rungs** (`+0x138`): fistp(|p2.z − p3.z| × float(1/1228.8)) (chop).
- **Mount from the bottom** (`+0xd7b = 0`): pelvis = world p2 +
  R(0, 1515.52, 3915.776), heading = ladder heading + π, rung 0, state 37.
- **Mount from the top** (`+0xd7b = 1`): pelvis = world p3 +
  R(0, −1638.4, 3481.6), heading + π, rung = rungs − 6, state 38.
- Clips (table `0x5368c8`): 37 → 168 loop, 38 → 170 reversed one-shot,
  39 → 170 one-shot, 40 → 169 loop.
- **37 climb** (`0x40d7b0`): a trigger-8 event with a new time stops the
  clip, adds the step to the rung, plays `walk_ladder_N` at the human
  (N from `0x536c70`: 1 2 3 4 2 3 2 3 4 3 2 1) and sends an AI LADDER noise
  (type 14, flags 0x46, 20480 units). Idle: Up → at rung − 6 the top exit
  (39), else step +1; Down → at rung 0 step off (state 0), else step −1
  (both are tested, Down last); an Activate press → slide (40).
- **38 / 39**: rung sounds on trigger 8; when the clip finishes 38 → 37,
  39 → step off at the top (state 0).
- **40 slide** (`FUN_0040dca0`, `FUN_0040dcf0`): `+0x694 = 0` (collides),
  looping `wire_slide_1`; each tick air × 0.99 and vz = (vz − 44.600887) ×
  0.99 (`0x531470`, `0x53146c`); grounded → stop the loop, state 0. No
  fall damage (that is only taken in the jump / fall states).
- Death (0x20000) detaches (state 47).

Clip 168 lifts the pelvis ~1217 units per rung (two rungs per 0.7 s
cycle; one rung every ~10.5 ticks with Up held); the exit clip 170 rises
7549 units and moves 3173 forward, so the climb ends within 5 cm of the
top mount point (port test, observed with the shipped data).

## 5. Fence and wires [recovered]

**Fence** (`FUN_00411710`, state 41 `FUN_0040dda0` / `0x40de00`):
pelvis = pos + R(local x, ±2457.6, 3891.2) on the side the pelvis is on,
heading + π on the +y side; clip 171 (6 s, one shot); a 6.0 × 30 counter
(`0x531530`); an AI FENCE noise (type 13) every tick; when the clip
finishes → fall state 29. Level 1 has one Fence (302_01_1, not electric).

**Wires** (docs/wire.md §6 for the mount rules):

- Traverse, state 42 (`FUN_0040de60` / `0x40dea0`, clip 172 loop): the
  trigger-8 event stops a hand step; idle, Up / Down start a step
  (speed ±1) and play `wire_drag_1` / `_2` alternately (`0x536ca0`),
  attached to the human. Each step moves ~2058 units (0.5 m) along the
  facing.
- Slide, state 43 (`FUN_0040df90` / `FUN_0040dff0`, clip 173): speed
  s = 0.99 s − dir.z × 88.309761 (`0x531474`), air = dir × s; the loop
  `wire_slide_1` starts at the attach. Terminal speed on a 5° wire ≈ 764
  units/tick (5.6 m/s).
- Detach (`FUN_00411a80` / `FUN_00411ec0`, every tick while attached): an
  Activate press, leaving [p0.y + m, p1.y − m] or death → fall state 29,
  whose entry (`FUN_0040bec0`) sets the air velocity to the last root
  change, so a slide ends with a straight drop.
- `Wire.isInUse` is set by method 0x42c only while the user is grounded,
  so it never becomes 1 [recovered conditions; consequence inferred].

Correction to docs/wire.md: `FUN_0040dca0` is the **ladder** slide (state
40), not the wire slide; the wire slide is state 43; "input bit 4" is the
grounded flag.

## 6. Terminals, switches, doors [recovered]

- **Switch** (kind 2): pressed and released at once (above).
- **Terminal** (kind 5, state 32, `FUN_0040c780` / `FUN_0040c980`):
  stance = world point 1 + R col1 × 2764.8 (x stored as float32), heading
  + π, then stood on the ground below (`FUN_00461ea0`); clip 90;
  `typecomp_loop` attached; counter limit = fistp("Hack Time (s)" × 30).
  Each tick the counter grows to the limit; at the limit with Activate
  held and alive → `FUN_004473f0` (isHacked, isHackedThisTick, hack tick)
  and `typecomp_end` at the human; Activate released or death earlier →
  abort. Either way: weapon back, view unlocked, release, state 0. While
  active and grounded, method 0x42c sets isInUse and the use tick
  (`FUN_00442f60`). The HUD progress bar (`FUN_004130c0`, `+0xd68`) shows
  counter / limit.
- **Lock picking** (state 30, `FUN_0040bfe0` / `FUN_0040c260`): the same
  with "Pick lock time (s)", clip 89, `picklock_loop` / `pickloop_end`; at
  the end `FUN_00446bd0`(door, 1) and the door toggles open; the weapon
  stays out. The stance (`FUN_00473b30`) is not ported; level 1 has no
  pickable door (observed).
- Level 1 (observed): 6 Switches, Terminals 501 / 502 (252_01_1, 5 s) in
  container 1118, Terminal 1402 and SCameraControl 90 / 91 ("waypoint"
  model, under the terrain), 23 Doors (ids 400–409 locked, none pickable).

## 7. Pickups [recovered]

- Walked over, never used: `FUN_00410f10` (player tick, after the move,
  alive only) calls method 0x429 of every object in the pickup list
  `DAT_00577b64` (capacity 256) with the pelvis position.
- Touch (`FUN_0046bdb0` GunPickup, `FUN_0046c510` AmmoPickup): r = model
  origin radius × max scale, at least **2867.2** (0.7 m); collected when
  the **horizontal** distance < r and |dz| < **4096**. (Level 1's ammo
  models 116_01_1, 115_01_1, 104_01_1 have radii 552–760, so r = 0.7 m;
  observed.)
- GunPickup grants its "ID" weapon with WeaponConfig Rounds/Clip rounds
  (`FUN_0046bbd0`: `+0x150` = weapon def `+0x648`; that field is
  Rounds/Clip per docs/ai.md §7). AmmoPickup grants "Ammo" rounds of "ID".
- Collect: the human methods `FUN_0045ec30` (gun) / `FUN_0045ebf0`
  (ammo). A gun already carried adds the rounds to that gun's ammo pool; a
  new gun is created (`FUN_00476370(human, 0, id, rounds, 1)`, rounds in
  the gun's `+0x144`). Pools: `FUN_0047b4c0`, count + amount clamped to
  [0, cap] when a cap exists (the DefineHumanPlayerAmmoLimit entries).
  Sound **weaponpickup_1** for both (2-D, `FUN_004dddc0`). Message
  "PICKEDUPWEAPON" + weapon Name, or "PICKEDUPAMMO" + ammo.spr
  (`FUN_00483920`, docs/hud.md §5). The pickup deletes itself on its next
  tick.
- **Soldier drops**: the soldier death states (`FUN_004534d0`,
  `FUN_00458500`, `FUN_004585b0`) drop the weapon in hand
  (`FUN_004e9010` → the Gun's method at `0x478340`): when the list has
  room, `FUN_0046b500` creates a GunPickup at the gun's position, rotation
  (alpha 0, beta +π/2, gamma kept: the alpha test compares radians with
  ∓90, so alpha is always 0), rest height = hit + 409.6 of a ray from 2048
  above to 204800 below (no hit: the drop height). The new pickup gets
  Rounds/Clip rounds (compile) [the gun's own `+0x144` is passed but not
  read: inferred from the 4 parameters].
- Drop fall (`FUN_0046ba20`): below rest → z = rest, v × −0.5 and
  `weapondrop_01` (level RNG > 0.5) or `_02` at the pickup; at or below
  rest with |v| < 409.6 → v = 0; else z −= v, v += 44.600889.
- Level 1 (observed): 6 GunPickups (UZI, 3 × GRENADE, MEDIPACK, MINIMI)
  and 5 AmmoPickups (AMMO_ID_919 32 / 16 / 16, MEDIPACK 50, 556 100) in
  containers 1112, 1116–1119.

### Pickups (rendering, ammo types)

**Ammo types** [recovered layout `FUN_0047b1b0`, values observed]. igi.exe
walks every directory of `LOCAL:ammo` and runs its `ammo.qsc`
(`FUN_0047b3d0` → `FUN_004a7890`, callback `FUN_0047b120`). Each
`DefineAmmoType` fills one 0x168-byte record at `DAT_005c1790` (count
`DAT_005c4494`):

| Arg | Record | Meaning | Reader |
|---|---|---|---|
| 0 | +0x00 int | AMMO_ID value (arg 1 is defined as a symbol with this value, `FUN_004aea50`) | `FUN_0047b420` (by id) |
| 1 | — | symbol name, e.g. `AMMO_ID_919` | — |
| 2 | +0x28, 32 B | `<919>` (localized-string key form) | none found |
| 3 | +0x48, 256 B | `<919DESC>` | none found |
| 4 | +0x04 int | calibre, matched with WeaponConfig "Calibre ID" | `FUN_0047b450` → gun +0x12c |
| 5 | +0x24 f32 | 3.5 (919, 556, 44), 9.7 (357), 12 (762), 2 (others) | none found (unresolved) |
| 6–8 / 9–11 | +0x08…+0x1c | tracer colour near / far (docs/rendering.md 7.7) | `FUN_004792b0` |
| 12 | +0x20 | tracer on | `FUN_00479e30` 0x47a7c0 |
| 13 | +0x148, 16 B | **pickup model** | AmmoPickup compile `FUN_0046c350` |
| 14 | +0x158, 16 B | `Sound0` everywhere | none found |

Models (arg 13): 12 → 114_01_1, 127 → none (""), 357 → 118_01_1,
44 → 120_01_1, 556 → 115_01_1, 762 → 119_01_1, 919 → 116_01_1,
DRAGUNOV / FLASHBANG → 137_01_1, GRENADE → 135_01_1, M203 → 108_05_1,
MEDIPACK → 104_01_1, PROXIMITYMINE → 136_01_1 (all in location0.res, all
blocks opaque) [observed].

**Drawing** [recovered]:

- GunPickup and AmmoPickup derive from SectorInteriorObject (`FUN_004d7560`)
  → RigidDynCubeObj (`FUN_004baae0`) and register no draw method. They draw
  with RigidDynCubeObj's method 4 `FUN_00506540`: one `DrawRigidMesh`
  message (`FUN_0052e5d0`) for the model at object +0x6c, then the object's
  child objects.
- Model: GunPickup = the weapon def +0x61c model (`FUN_0046bbd0`);
  AmmoPickup = ammo def +0x148 (`FUN_0046c350`). Both only set +0x6c
  (`FUN_004baaf0`). Neither calls `FUN_004bab70`, which builds the ATTA child
  objects for a held Gun (`FUN_004770e0`) and for RigidDynCubeObj's own
  constructor `FUN_004b9230`. So a gun pickup draws the gun **body only**, with
  no magazine, moving part or flame.
- Pose: position +0xf0, written to the object every tick (`FUN_00415810` →
  `FUN_004bcb60`; a drop's falls), and rotation +0x70 = Rz(γ) Ry(β) Rx(α)
  of "Orientation" (drops: (0, π/2, γ)). The ticks (`FUN_0046ba20`,
  `LAB_0046c2c0`) only fall and delete: there is no spin, bob or scale.
- Lighting: no lightmap, so the vertex-lit DrawRigidMesh path applies,
  texture × clamp(ambient + front × max(0, n·l)) with world normals
  (docs/formats.md "Object lighting"). Object fog, ZBIAS 3 and the DNER block
  kinds apply (121_01_1, the medipack, has one deferred block).
- Not reproduced: the model LOD and cutoff that DrawRigidMesh applies
  (`FUN_004c4d00`). The port always draws `_1`.

**Port**:

- `loaders/render-params.ts` (`readAmmoTypes`, `loadAmmoTypes`,
  `AMMO_DIRS`) and `IgiLevel.ammoTypes`.
- `loaders/level.ts` loads the AmmoPickup models into `models` and puts the
  GunPickup weapons into `guns`.
- `combat/pickups.ts` gives AmmoPickups the ammo model and radius
  max(model radius, 2867.2); `PickupSystem.inWorld`.
- `render/pickups.ts` (`createPickupRenderer(ctx, scene, { fog?, mipBias? })`
  → `update(items, inWorld?)`, `dispose()`) does the drawing.
- `scripts/stage-raw.mjs` stages `ammo/`.
- Tests: `tests/pickups-render.test.ts`.

## 8. Port integration

`player.ts` owns the controllers (`PlayerController.interactions`,
`.pickups`) and runs, per tick: the search; a running hack / lock pick
(the body stays at its stance); the attached tick (free move, or the
normal collision move for the ladder slide); the Activate dispatch; the
normal state machine and move; the pickups.

Hooks the rest of the engine needs (not wired yet):

- game.ts: `hud.setActionIcon(playerController.interactions.actionIcon)`
  instead of the door ray; remove `doorAhead` / `mission.useDoor` and create
  the player with `{ interactions: { doors: true } }`; skip mouse look
  while `interactions.viewLocked`; draw `interactions.progress` as the
  action progress bar.
- weapon.ts: no fire / reload / weapon change while
  `interactions.weaponHolstered`; implement `PickupInventory`
  (`hasWeapon`, `addWeaponAmmo`, `addAmmo`, `addWeapon`) with the caps of
  `level.humanPlayer.ammoLimits` (`addCappedAmmo`).
- enemy.ts: broadcast `INTERACT_EVENTS.Noise` to the AI (types 12–14);
  add `gunPosition` (and the gun yaw) to the EnemyKilled payload.
- audio (sound-events.ts): play `weaponpickup_1` for ammo pickups too (the
  exe plays it for both; `pickup` is GenericPickup's).
- renderer: `render/pickups.ts` draws `pickups.items`. game.ts creates it
  after the effects and calls `update(pickups.items, pickups.inWorld)`
  before each world render (see "Pickups (rendering, ammo types)").

## 9. Open questions

- View mode (§10): method `0x5460cc` that `FUN_0045dd70` skips for the
  first-person human (a per-view pass over visible objects; its purpose
  was not traced); whether a holstered weapon stays in the hand slot
  `+0x4c4` (then the third-person body is drawn holding it); the sound
  listener in the third-person modes.
- `FUN_00464650`(camera) before a use, and the cabinet, stationary gun,
  GenericTBA and PlaceExplosiveTBA uses (not in level 1).
- The lock-pick stance `FUN_00473b30`.
- The exact gun position at a soldier's death (its bone-22 attachment);
  the port takes it from enemy.ts when given, else 1 m above the feet.

## 10. View mode `human+0x4f0` and the HumanCamera [recovered]

The view mode is read in one place: the human method `FUN_0045e940`
(vtable built in `FUN_0045d170`, method id `DAT_0053e922`) fills the
HumanCamera's record at `cam+0x70`: eye `arms+0xe0`, view axes
`arms+0xf8`, FOV tangent `arms+0x1e4`, body matrix `human+0x78`, gun FOV
`arms+0x1e8`, and **mode = `human+0x4f0`** (4 instead when the
StationaryGun override `arms+0x13a` is on, `FUN_00464540`; 2 when the
debug toggle `+0x4f4` flips on input channel 19, which is always 0 for the
player). The HumanCamera (type "HumanCamera", `FUN_00480c80`; update
`FUN_00480dc0`) keeps the mode at `cam+0xe8`; a change runs the new mode's
entry function, then the mode's camera is built (switch at 0x480e2f) and
submitted (`FUN_004cfed0`, near 1.0, priority 300).

| Mode | Set by | Camera |
|---|---|---|
| 1 | default, detach, end of a use | first person: eye, view axes, `arms+0x1e4` (`FUN_00481fc0`) |
| 3 | attach (`FUN_00411380`, `FUN_00411710`, `FUN_00411a80`, `FUN_00411ec0`); use states 30 lock pick, 31 cabinet, 32 terminal, 34, 35, 36 (0x40c1ee, 0x40c5b3, 0x40c926, 0x40cd6e, 0x40d221, 0x40d627); soldier death states | third-person orbit (`FUN_00481630` entry, `FUN_00481660` input, `FUN_00481750` placement) |
| 4 | StationaryGun use (`FUN_00472c40`) | first-person-like at the gun's override pose |
| 5 | **player death**, state 47 `FUN_0040e660` (0x40e6c0) | death orbit (`FUN_00482190`, `FUN_004821d0`, `FUN_004822d0`, `FUN_00482860`) |

`FUN_0040e660` is the player's death state (death clip, `player_death_`
sound, weapon holstered, yaw and pitch locked, air velocity = last move),
not the map computer.

**Mode 3 orbit** (all per HumanCamera update, IGI units):

- Entry: distance `cam+0x110` = 1024, `cam+0x114` = 10240, orbit pitch
  `cam+0x108` = yaw `cam+0x10c` = 0 (so every attach starts straight
  behind the body).
- Input (`FUN_00481660`): pitch += look × 0.6981317 (f32 0x5321c8, the
  look channel's value with the same invert flip as channel 1, config
  `+0x538`), clamped to ±1.3089969 (75°); yaw += turn × −0.6981317
  (unbounded). The player's own yaw and pitch stay locked (`+0x510`,
  `arms+0x138`).
- Placement (`FUN_00481750`): camera = eye + B·Rz(yaw)·Rx(pitch)·(0,
  −10240, 0) with B the body matrix `human+0x78` (heading + gun yaw kick);
  it looks at the eye with no roll (`FUN_004813d0`); FOV tan(π/4) = 1 (zoom
  ignored). The orbit point is the **eye** (pelvis + 2826.24 / 1433.6
  crouched + lean / shake / dip, `FUN_00464490`), not a head bone.
- Collision: a ray from the eye to the camera (same query as the arms
  pull-back ray) steps 20.48 units through faces whose material
  transmission is > 0; at an opaque hit the camera is pulled in to
  (hit distance − 204.8) only if all eight corners of a world-axis box at
  the pelvis (x, y ±716.8, z 0 and +2662.4; `FUN_00481c80`) are also
  blocked from the camera (each corner ray steps through see-through faces
  too).

**Mode 5** (death): entry as mode 3 plus `cam+0x124` = 1. On the first
tick, when the player was killed by a shooter (`human+0xde8`, set by
`FUN_004123e0` at the killing hit), the camera sits 10240 behind the
pelvis (+4096 up) on the line from the killer and looks at the killer
(`FUN_00482dc0`); bit 0 of `cam+0x124` is cleared after every tick, so
this lasts one tick. Then: pitch += look × 0.698 (raw port value, no
invert flip), yaw += turn × **+**0.698, pitch clamped ±75°; four rays from
the eye to points ±0.4·`cam+0x110` around the camera at the new angles
shrink `cam+0x114` to max(1.05 × hit depth, 4096) on a front-facing hit;
with both pairs free it grows 341.33 per tick back to 10240; `cam+0x110`
follows `cam+0x114` at 341.33 per tick (`FUN_004822d0`, `FUN_004821d0`).
Placement and collision as mode 3 at distance `cam+0x114`.

**Who reads `cam+0xe8 == 1`** (the camera's own human, active camera =
HumanCamera):

- `FUN_004630e0` (arms object, draw slot 4): the first-person arms and the
  hand item (gun method with flag 1) are drawn only in mode 1 and with the
  map computer closed (`FUN_0046abe0`).
- `FUN_0045ddd0` (human, draw slot 4) and `FUN_0045dd70` (method
  `0x5460cc`): the third-person body, the hand item on it (flag 0) and the
  name text are skipped only in mode 1; in modes 3, 4, 5 and whenever
  another camera is active (cut-scenes) **the player's body is drawn**.
- `FUN_0045f070` (human HUD, 0x45f098): health bar, weapon name / icon /
  ammo / clip graphic, crosshair and the use icon only in mode 1.
- `FUN_004130c0` (player HUD, 0x413570): the damage tint and the flash-bang
  white-out only in mode 1; the action progress bar (terminal, lock pick)
  is drawn in every mode.

**Other mode-3 setters**: `FUN_004534d0` (0x453571), `FUN_00455610`
(0x455727), `FUN_004583a0` (0x4584b7), `FUN_00458500` (clip 29),
`FUN_004585b0` (clip 30), `FUN_0045aea0` (0x45afb9, standing death),
`FUN_0045b000` (kneeling death, clip 24), `FUN_0045b0b0` (prone death,
clip 25) are the **soldiers'** death-state entries of the HumanAI state
machines (gun dropped, `ai_death_` sound, `FUN_0045c3b0`). None is the
player's death and none is a cut-scene; they only matter if the
HumanCamera looks through that soldier.

**Port** (`player/camera.ts`, `player/first-person.ts` `viewMode`,
`render/viewmodel.ts`; tests `tests/view-mode.test.ts`): `playerViewMode`
gives 5 when dead, 3 while `interactions.busy` (attached, hacking,
picking), else 1; the camera controller builds the orbit and its collision,
`orbitTick(dx, dy, invertY)` applies the mouse per tick, the arms are not
drawn unless `firstPerson.viewMode` is 1. Not ported: the one-tick killer
shot, modes 2 and 4, the player's third-person body (needs a renderer in
game.ts) and the HUD gating (hud).
