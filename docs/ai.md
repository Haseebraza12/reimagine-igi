# Soldier AI behaviour

This document describes what `igi.exe` does natively for a soldier once the
script VM ([qvm-vm.md](qvm-vm.md)) has queued an action: the action
implementations, perception and the event producers, the walk graphs and
route table, and the movement interface. It is the reference for replacing
the placeholder AI in `web-port/src/engine/combat/enemy.ts`.

- Port code: `web-port/src/loaders/ai-graph.ts` (graph files, routes, node
  geometry) and `web-port/src/loaders/ai-rules.ts` (constants and pure rule
  functions).
- Python reference and self-check: `tools/igi_ai.py` (stdlib only). It
  parses every graph, checks the route tables, simulates every patrol path,
  maps the combat settings, and re-reads the recovered constants from
  `igi.exe`.
- Tests: `web-port/tests/ai.test.ts`.

Evidence labels:

- **[recovered]**: read from `igi.exe` code; Ghidra `FUN_` names, image base
  0x400000.
- **[observed]**: measured on the shipped files with `tools/igi_ai.py`.
- **[inferred]**: reasoning only.

`igi.exe` SHA-256 `2b1673443e2635d97787344da5fab9d1ac6b717d34d18c5bab7f30749b1174c2`
(the same binary as qvm-vm.md).

Terms: **H** is the HumanAI task (0x3ec8 bytes), **soldier** the
HumanSoldier it drives (H+0x14), a **tick** is 1/30 s, **units** are IGI
units (4096 per metre, z up).

## 1. Driver details beyond qvm-vm.md

**Action record** (0x30 bytes, from `FUN_0044fbe0`) [recovered]:

| Offset | Field |
| --- | --- |
| +0x08 | priority index of the event that queued it (-1 when queued by CREATE) |
| +0x0c | reaction delay |
| +0x10 | AIACTIONFLAG (bit 0 PUSHABLE) |
| +0x14 | start function (called once when pushed) |
| +0x18 | update function (called every tick while on top) |
| +0x1c | "resume" function used by the combat sub-states |
| +0x20 | stop function (called when popped) |
| +0x24 | combat sub-state function (returns true when finished) |
| +0x28 | action data (the record filled by the `AIAction_*` handler) |

- **Running** (`FUN_0044ecf0`): from the top of the stack, the first record
  whose update function is set is run. A record without an update function
  only has its delay decremented. [recovered]
- **Reaction delay is a no-op.** `FUN_0044fc40` stores
  `fistp((rand + 1) * 0.2 * 30)` = 6..11 ticks in +0x0c (fistp truncates:
  the FPU runs in chop mode, see gameplay.md "FPU rounding mode"; rand ≤
  65535/65536), but every start
  function installs an update function, so the delay is never consumed.
  [recovered] This corrects the "reaction delay" in qvm-vm.md section 6.
- **Ending an action** is `FUN_0044fdc0`: stop function, unlink, free the
  data record. An action ends only by calling it itself (or by being popped
  as non-PUSHABLE under a new action). Idle, Dead and KickGrenade never end.
- **Priority gate** (`FUN_0044eb80`): event types are visited in the
  soldier's priority-list order; a type is dispatched only while its index
  is lower than the top action's +0x08, or lower than 24 when the stack is
  empty. Per type, the number of events processed this frame is kept in
  H+0x87c[type]; the combat code reads these counts (sections 2.6, 6.2).
  [recovered]

**What one frame does** (`FUN_0044e260`, order matters) [recovered]:

1. Clear the 40 input channels H+0x3c6c..0x3d0c (section 4.1). Copy the
   soldier position into H+0x20 (z lowered by bone 0's offset), the
   orientation into H+0x50, the eye position into H+0x38 and the eye matrix
   into H+0x78.
2. Return early, doing nothing at all, when the soldier has no AI script or
   **no AI graph** ("No AI graph in HumanAI #%d").
3. First update: equip (`FUN_0044e9d0`: primary weapon if WEAPONTYPE 0..2,
   grenade if WEAPONTYPE 4), run CREATE, then skip to step 9.
4. On death (once): pop every action, run DEAD with DEAD's priority index.
5. While alive: build the view record H+0x3a30 (eye position, head matrix,
   both cones; the alarm lengths are used when H+0x3ab7 is set), run
   perception (section 2.2), queue ENEMYDETECTION for every visible alive
   enemy and FRIENDLYDETECTION for every visible dead friend, queue
   ALARMON / ALARMOFF from the AlarmControl (H+0x3ac0), and count down the
   animation interval (ANIMATION event).
6. Combat target bookkeeping: if H holds a target record (H+0x3aa8) whose
   object is still in its perception lists, set the alarm flag; otherwise
   leave the record.
7. H+0x3ab7 = (ALARMON queued this frame) or (target still perceived).
8. Queue IDLE if the action stack is empty.
9. Dispatch events (`FUN_0044eb80`), then run the top action (`FUN_0044ecf0`).
10. Forward the channels to the soldier body (message `FUN_004ead50`).

## 2. Perception and events

### 2.1 View cones

`FUN_0044f0c0` (event cones) and `FUN_00487d80` (vision) [recovered]:

- The point is expressed in the eye frame: x along the head matrix's first
  column (right), y along the second (forward), z along the third (up).
- **vertical** = |angle of (0, y, z) from +y| and **horizontal** =
  |angle of (x, y, 0) from +y| (`FUN_004868f0`, `FUN_00486950`, acos).
- Visible in a cone when `distance <= length`, `vertical < alpha` and
  `horizontal < gamma`. The primary cone is tried first, then the secondary
  cone. The event-cone test also requires y >= 0.
- **alpha is the vertical half-angle and gamma the horizontal half-angle.**
  This corrects docs/formats.md, which inferred the opposite. The names
  follow IGI's Euler naming (gamma = rotation about z).
- Lengths: the alarm lengths (H+0xb8, secondary H+0xd8) replace the normal
  ones while H+0x3ab7 is set (step 7 above).

Defaults set by the HumanAI constructor `FUN_0044deb0` [recovered]:

| Cone | alpha (vertical) | gamma (horizontal) | length | alarm length |
| --- | --- | --- | --- | --- |
| primary | 45° | 50° | 30 m | 30 m |
| secondary | 45° | 80° | 10 m | 10 m |

The shipped scripts set only the primary cone [observed]: guard / patrol /
gunner / priboi / anya / ekk / civilian alpha 50°, gamma 45°, 40 m, alarm
50 m; sniper alpha 30°, gamma 15°, 100 m / 110 m; rpg 90° / 90°, 80 m;
mission script 2209 sets 20 m. **Every soldier therefore also has the
default 160°-wide, 10 m peripheral cone.** `SetViewLength` raises the alarm
length to the new length when the alarm length is shorter (`FUN_0044ca80`).

### 2.2 Vision

`FUN_00487b70`, `FUN_00487cf0`, `FUN_00487f40`, set up by `FUN_00487ae0`
from `FUN_0044f3a0` with the arguments (team, 6, mask, 4, 8) [recovered]:

- **Who is tracked.** Every object of the detectable registry
  `DAT_005c4a00` (filled at create, so in task-tree order: SCamera holders
  and humans) answering the detection-info message (humans:
  `FUN_0045eaa0`) whose class mask matches gets a slot. The soldiers' mask
  is the human class only (`FUN_00462e90`, 0x44f500). Flags 6 keep alive
  objects of another team (enemy list H+0x1610) and dead objects of the own
  team (friend list H+0x161c). Skipped: the soldier itself and humans out of
  the world (in-world flag +0xcf6, set / cleared only by the add / remove
  handlers 0x45f5c0 / 0x45f610; the player is out of the world during the
  level-1 intro). New slots go to the list's tail (`FUN_00487920`, which
  also stamps the slot with the application tick, +0x18).
- **Schedule** [recovered `FUN_00487b70`, `FUN_00487ae0`, `FUN_00402a30`].
  The whole pass, the slot bookkeeping included, runs only on ticks where
  `(application tick & 3) == phase`; between them the lists keep the last
  run's slots (so step 6's "target still perceived" and the
  ENEMYDETECTION loop see a target that died or left the world until the
  next phase tick; ENEMYDETECTION itself is not queued for a dead object,
  `FUN_00461db0`). Per registry object: drop / add its slot, then
  `FUN_00487cf0` for it. Per slot the cone test runs every 2nd run (every 8
  ticks); while the target is in the cone, the sight ray runs every 3rd run
  (every 12 ticks). A failed cone test clears "visible" immediately. The
  ray countdown only runs while the target is in the cone, so noticing a
  target that steps into view can lag by up to about 20 ticks (phase wait +
  next cone test + leftover ray countdown).
- **Phase.** `FUN_0044f3a0` (HumanAI compile, unconditional) takes the
  phase from the process-wide counter `DAT_005c4a48` (static 0, never
  reset, +1 mod 4 per detector set-up) that the SCamera lenses (at create),
  Car / Heli (when their model loads) and AIStationaryGunHolder share; so a
  soldier's phase is its HumanAI's place in that sequence
  ([mission.md](mission.md) "SCamera vision", `perceptionPhases`). Level 1,
  first load: HumanAI_1506 3, HumanAI_2022 1, HumanAI_3032 2, … A restart
  continues the counter.
- **The tick** is the application tick `*(DAT_00563dfc + 0x34)`: reset at
  each level load (`FUN_004029a0`), +1 after every main-loop tick
  (`FUN_00402250`, 0x4023ce). The in-game menu pauses only the Game task
  (Game +0xe0 set by the MenuManager through `FUN_00415c60`, 0x417152;
  `FUN_00415306` then skips its children), so the application tick keeps
  counting while the level tick stands still, and the phases shift against
  the level tick after every pause.
- **Points.** The ray goes from the eye (soldier position + body eye offset
  at body+0x70+0x2ac) to the target point: the target's origin + 2826.24
  units (0.69 m) standing, + 1433.6 units (0.35 m) crouched
  (`FUN_00464490`).
- **Line of sight** (`FUN_00487f40`): passes when the ray hits nothing, or
  when the see-through product of its hits is >= 0.79 ([collision.md](collision.md)
  §7; this corrects "first hit at >= 0.79 of the way").
- **Humans on the ray** [recovered `FUN_00487f40`, `FUN_004c4630`,
  `FUN_004be350`, `FUN_00441c30`, `FUN_0045e490`, `FUN_0045e210`,
  `FUN_004cef60`; observed level-1 models]:
  - The ray record is {self = the soldier, target = the slot's object}
    with filter message 0x53f120. `FUN_004c4630` sends message 8 to every
    object of categories 0, 1, 4, 5 in the octree cells the segment crosses
    (no class excluded), then tests the terrain.
  - Humans answer the filter with `FUN_00441c30`: skip when the object is
    the record's self or target. So **every other human blocks**: the
    player, other soldiers, Jones, alive or dead (a body keeps +0xcf6 and
    stays in the octree; there is no alive test). The same filter serves
    Car, Heli, SCamera holder and AIStationaryGunHolder.
  - A human's message 8 (`FUN_0045e490`): the segment must pass the sphere
    of radius human +0xa0 around its position +0x20 (the pelvis):
    `FUN_0045e210`, distance from the centre to the segment's line ≤ r and
    the segment's box meeting the cube ±r. r = HSEM +120 of its "Model"
    (`FUN_0045e520` → `FUN_004cfd90` → `FUN_004c59a0`; the draw LODs do not
    change it): 003_01_1 3778, 001_01_1 3862, 019_01_1 3793, 015_01_1 3678,
    000_01_1 (player) 3883 units, about 0.9 m. Posed faces outside it (the
    soles, a stretched arm: posed vertices reach 4200–5300 units) cannot
    stop a ray that misses it.
  - Then the pose is brought up to date (`FUN_0045e150`) and the
    BoneDynCubeObj handler `FUN_004cef60` tests every face of the model's
    collision set 0 (model +0x2c, the set bullets use), each vertex placed
    by its bone (R p + T): a crossed face (t in [0, 1], both sides) marks the
    ray blocked; material 0xffff makes the product 0; a front face
    multiplies it by the material's see-through; see-through 0 makes it 0
    and stops. Every level-1 human face is Flesh, BloodyFlesh, NormalMetal
    or Runway (see-through 0), so **any crossed face stops the ray**;
    see-through materials never apply to humans.
  - The combat node search ray `FUN_00489b00` (section 6) uses filter
    0x537430 instead; humans answer it with 0x4fa7f0 (always skip), so no
    human blocks that ray.
- **No lighting, movement or detection-time factors exist.** Detection is
  binary: cone + ray. The only stance effect is the lower target point when
  crouched (and silent footsteps, 2.3).
- While visible, an ENEMYDETECTION (or FRIENDLYDETECTION) event with the
  target's position, source = other = target, is queued **every frame**.
- **Port** (`web-port/src/engine/ai/human-ai.ts` `perceive`, `phase`;
  `ai/world.ts` `AiWorld.appTick`, `AiHooks.lineOfSight(a, b, skip)`,
  `perceptionPhase`; `combat/enemy.ts` `humanSightHits`;
  `combat/body-collision.ts` `segmentNearSphere`, `BodyCollision.sightHits`;
  `combat/soldier-body.ts` `SoldierBody.sightHits`): the humans are kept in
  task-tree order; the phase comes from the mission system's
  `perceptionPhase(aiTaskId)` (the same `perceptionPhases` map as the
  lenses, resolved lazily because `enemies.reset()` runs before
  `mission.start()`); the phase test reads `ctx.appTick` (game.ts keeps
  it; the level tick when absent). The player's body answers through
  `player.bodyHit` (its nearest face: exact while every face has
  see-through 0). Measured on level 1 (headless, 900 ticks): the human pass
  costs 0.01–0.03 ms per tick for the soldiers' bodies plus 0.013 ms for the
  player's, about 3.5–5.7 µs per body test (most stop at the sphere), the
  whole perception ray 0.025–0.07 ms per tick, against 5.5–5.9 ms for the
  soldiers' tick.

### 2.3 Event producers

Every event record is `{type, team, flags, range (f32 units), position,
source, other}`. Broadcasts go to every HumanAI (`FUN_0044fab0`); direct
posts go to one (`FUN_0044fb20`). [recovered; immediates re-read by
`tools/igi_ai.py`]

| Event | Flags | Range | Position, notes | Producer |
| --- | --- | --- | --- | --- |
| WALK (10) | 0x46 | ground material arg 5 × 4096 | each footstep sound; none while crouched. Arg 5 of `DefineGameMaterial` (material.qvm): Ground / Wood / Concrete / metals 1 m, Gravel 10 m, Air / Textiles / Rug / Glass / Snow 0 [observed] | `FUN_00462560` |
| GROUNDIMPACT (11) | 0x46 | 5 m; 10 m when the landing hurt | lander | `FUN_00408570` |
| DOOR (12) | 0x46 | 5 m | door user | `FUN_0040c370` |
| FENCE (13) | 0x46 | 5 m | climber | `FUN_00411710` |
| LADDER (14) | 0x46 | 5 m | climber | `FUN_0040d8b0` and 2 others |
| TAKINGDAMAGE (15) | 0 | - | posted only to the damaged soldier; other = attacker | 7 human damage handlers (e.g. 0x4543b1) |
| GUNSHOT (16) | 0x46 | WeaponConfig "AI Detection Event Range" | gun +0x150; other = shooter. 30 m (0x1e000) for most guns, 1 m (0x1000) for MP5SD, Dragunov, grenades, knife [observed weaponconfig.qvm] | `FUN_00477ea0` |
| GRENADETHROWN (17) | 0x01 | none | view cone only | `FUN_00475760` |
| GRENADELAND (18) | 0x02 | 5 m | any team | `FUN_004753f0` |
| FLASHBANG (19) | 0x03 | 10 m | range and view cone | 0x47cc92 |
| GUNSHOTMISS (20) | 0x46 | 2 m | points along the bullet path (`FUN_00479970`); team = shooter's | 0x45f443 |
| EXPLOSION (21) | 0x02 | 25 m typical (10 m, 5 m variants) | explosion | projectile spawns (0x427b24, ...) |
| ALERT (5) | 0x26 | 7 m | alerting soldier; other = its target | `FUN_00488f30` |
| ALERT_RESPONSE (6) | 0x24 | - | `SendResponse` | `FUN_0044dc90` |
| COMBAT (7) | 0 | - | posted to self by SetCombat | `FUN_0048c980` |

Flags 0x46 mean: in range, the "other" object is human, and the listener
is on another team than the noise maker. **Hearing is never occluded**
(walls do not matter) and is measured from the event position to the
listener's position. Gunshots are measured from the gun, not from the
impact; impacts and near misses are the separate GUNSHOTMISS event.

### 2.4 Receive filter

`FUN_0044eee0` [recovered]. The event is dropped when the listener is
dead, inactive, or is itself the source or "other" object; before CREATE
ran only type 0 is accepted, afterwards only types in its priority list.
The flags are then tested in this order, the first failure dropping the
event:

| Bit | Test |
| --- | --- |
| 0x02 | `range >= |position - listener.position|` |
| 0x01 | position inside the listener's view cones (section 2.1, y >= 0; alarm lengths when H+0x3ab7), no ray |
| 0x04 | the other object is a human |
| 0x08 | the other object is alive |
| 0x10 | the other object is dead |
| 0x20 | record team == listener team |
| 0x40 | record team != listener team |

Accepted events are copied into the soldier's per-type queue
(`FUN_0044f2f0`).

### 2.5 Alert propagation

While a combat action holds a target, `FUN_00488d40` counts ticks; on the
first tick and then every 20 ticks it broadcasts ALERT (`FUN_00488f30`):
team = own team, flags 0x26, range 7 m from the alerting soldier, other =
the target. So same-team soldiers within 7 m are alerted, without a view
check. [recovered] The scripts answer ALERT with `SendResponse` and
`SetCombat` (guard, patrol), which puts the alerted soldier into combat
against the same target. [observed scripts]

### 2.6 Target memory

`FUN_00488d40` (every combat tick) [recovered]:

- The target's **last known position** lives in a shared target record
  (pool at 0x580d70, 8 records, `FUN_0044fe50`); all soldiers fighting the
  same target share it.
- It is updated to the target's real position when the target is visible,
  and also when **any** of ALERT, WALK, GROUNDIMPACT, DOOR, FENCE, LADDER,
  TAKINGDAMAGE, GUNSHOT, GRENADELAND or GUNSHOTMISS events were processed
  this frame: hearing anything reveals the target's current position.
- The first time a visible target is the player, a random `detected_01` ..
  `detected_06` voice plays, at most once per 90 ticks globally.
- The record also lists every attacker with a status: 0 = firing, 1 =
  reloading, 2 = waiting, -1 = none. The shooter limits in section 6 count
  status 0.

### 2.7 Alarm

ALARMON is queued every frame while the soldier's AlarmControl task has
+0x2a1 set ("isAlarm"), ALARMOFF while it has +0x2a2 set. ALARMON also
switches vision to the alarm lengths. Raising the alarm is script-level:
`AIAction_Activate` on the alarm trigger task (section 5). [recovered]

## 3. Walk graphs

### 3.1 File format

`graphs/graph<id>.dat` is the engine's generic **GraphStream**.
[recovered: writer `FUN_004f0a80`, reader `FUN_004f08a0`, field table
`FUN_004f09c0`; observed on all 11 level-1 files, which parse to exactly
EOF]

- u32 magic 0xFFEEDDCC, then records:
  `u8 4 | u32 tag | u8 0 | u8 fieldType | u8 valueType | payload`.
- `tag = FUN_004f0a40(name)`: the sum of the upper-cased characters times
  the weights 1, 1+0x13d, 1+2×0x13d, ... (mod 0x10000).
- Value types: 5 i32, 6 f32, 8 three f64, 9 `u8 n` + n bytes of text,
  10 blob = `u8 10, u8 5, u32 length` + bytes.

| Field | Type | Tag | Meaning |
| --- | --- | --- | --- |
| nMaxNodes | 5 | 0x000d3ae6 | capacity (ids < capacity and < 1000) |
| RouteTable | 10 | 0x000fde0d | cap² × {i32 next, f32 cost} |
| nNodeID | 5 | 0x000735ce | node id |
| tNodePosition | 8 | 0x001d4295 | graph-local position, units |
| vNodeGamma | 6 | 0x000f7e9c | rotation of the node square about z (rad; 0 on every level-1 node) |
| vNodeRadius | 6 | 0x00143023 | half-size of the node square, **metres** |
| nNodeMaterial | 5 | 0x001bb629 | material id or -1 |
| nNodeCriteria | 9 | 0x001bd3e5 | criteria expression text |
| nLinkID1, nLinkID2 | 5 | 0x0009104a, 0x000918f6 | undirected link |
| eLinkType | 5 | 0x000da923 | link type (1 on every level-1 link) |

`tools/pipeline/nav_build.py` reads the same bytes as "4-byte signature +
u16 + u16"; that works only because every tag's top byte is 0.

**Node in memory** (`FUN_004f00e0`) [recovered]: +8 position, +0x20 gamma,
+0x24 radius, +0x28 2 × radius, +0x30 criteria flags (the criteria text
evaluated by the expression engine over NODECRITERIA_DOOR / _VIEW / _STAIR,
registered by `FUN_004ffe00`), +0x134 graph, +0x138 material, +0x13c up to
64 link pointers.

**World position** (`FUN_004f0340`): graph position (the AIGraph task's
"Graph position") + node position. A graph flagged as attached is also
transformed by its parent object [recovered]; which flag setter applies
to the Heli / Train / Car graphs was not traced [inferred: those].

**Which graph a soldier uses**: the HumanAI "Graph ID" names the AIGraph
task and the file `graph<id>.dat` (`FUN_0044f3a0` → `FUN_004efe60`). The
soldier's current node starts as the node closest to it. [recovered] All
29 level-1 HumanAI ids resolve [observed].

### 3.2 Route table

[recovered `FUN_005001f0`, `FUN_004506b0`; loaded from the file by the
AIGraph "RouteTable" handler 0x500100]

- The entry for (from, to) is at index `cap*to + from`: the next node to
  step to, and the path cost (units). -1 / -1.0 means unreachable.
- Soldiers route only through this table: no A* or other search at run
  time. From the current node they repeatedly take `next` until reaching
  the target.
- [observed] next == to for all 1,752 directed links of graph 4019, and
  every next hop is a neighbour. Graphs 7 and 13 store exact Dijkstra costs
  on 3-D link lengths. **Graph 4019 stores 46 stale link costs** (nodes
  79..265, up to 3 m off), so the port must use the stored table rather
  than recompute it.

### 3.3 Node geometry

All [recovered]:

- **On a node** (`FUN_004f0610`): `local = R(gamma)^T (p - node)` must lie in
  the square |x|, |y| <= (radius + margin) × 4096. "Standing on the node"
  uses a 0.3 m margin; with the height check, |dz| <= 1 m.
- **Closest node** (`FUN_00500550`): minimises `|node - p| - radius×4096`,
  skipping NODECRITERIA_VIEW nodes.
- **Route legs** (`FUN_00450e90`): between two nodes the walker aims at the
  exit point of the first node's square and the entry point of the next
  node's square, along the leg (so wide nodes are crossed edge to edge).
  The first node's exit point is used only if the walker already stands on
  it. On the last leg the walker goes to the target's reserved cell when one
  is given and lies on the node, else to the node centre.
- **Occupancy** (`FUN_00451a70`, `FUN_00451b30`, `FUN_00451990`):
  - A node is a grid of 2 m cells, n = trunc(radius) per axis (0x451adf:
    size × 0.5, fistp in chop mode; n = 0 for the 0.5 m nodes, 1 for 1.5 m).
  - A node-local offset maps to cell trunc(n/2 + offset/8192), clamped to
    [0, n] (0x451d56 / 0x451d65).
  - Reserving a cell stamps a 5×5 kernel: 100 in the centre, 50 on the
    ring, 25 on the outer ring (table 0x53aa48).
  - A cell is free while its total is < 25, so reservations stay at least
    3 cells (6 m) apart. A node with n = 0 holds one soldier.
  - Walk-to-node actions reserve the cell nearest the node centre; the
    combat node search requires a free cell.
- **Doors**: a leg whose two nodes both have NODECRITERIA_DOOR is flagged.
  While steering to it (`FUN_00450310`, before the reach test) the walker
  finds, once per leg, the door of the use list nearest the leg point
  (`FUN_00445240`, no radius), reads its state (`FUN_00446be0`: 0 open,
  1 closed, 2 moving with the open request, 3 moving without), toggles the
  request on 1 or 3 (`FUN_00446c10`) and waits, facing the leg point, until
  it is open ("Waiting for door to open"). The door is forgotten when the
  leg is reached. [recovered, ported]
- **Stairs**: no evasive rolls and no FallFlat on a NODECRITERIA_STAIR node.

### 3.4 Patrol paths

A patrol path is a `PatrolPath` task (often a child of the soldier) whose
`PatrolPathCommand` children are (Command, Command Parameter).
`AIAction_Patrol(pathId, start, flags)` takes the PatrolPath task id and the
index of the first command. [recovered: `FUN_00452650` finds the task by
id; `FUN_00452690` skips `start` commands]

| Value | Command | Patrol action does (`FUN_0048cca0`) |
| --- | --- | --- |
| 0 | ANIMATION | request animation `param` (channel 23); finishes when back in the stand / kneel state |
| 1 | DELAY | wait `param` **ticks** |
| 2 | WALKTO | walk (toggle) to node `param`; clears crouch |
| 3 | RUNTO | run to node `param`; clears crouch |
| 4 | CROUCH | from now on hold the kneel request every tick; advances at once |
| 5 | LOOKATNODE | turn toward the node, clamp 0.025926 rad per tick of steering, tolerance 3° |
| 6 | END | loop marker (see below) |
| 7 | QUIT | end the Patrol action |
| 8 | SETSPEED | ignored by soldiers (vehicles' speed in km/h) |

**Cursor** (`FUN_00452540`, `FUN_00452570`) [recovered]:

- After the last command the cursor goes back to the END command if one
  was passed, else to the first command.
- Reaching that END again leaves the cursor in place, so the command after
  END repeats forever. This is the "End script, only runs commands after
  this one" of the editor text.
- An END directly after an END is fatal.
- [observed, level 1] Normal routes end in QUIT; the IDLE handler then
  starts the same path again from the top.
  - The alarm paths (`2605`...) are `RUNTO n, END, LOOKATNODE m`: run to
    the post, then keep facing node m.
  - `3030` has no QUIT and loops.
  - The Heli / Train paths are `END, ANIMATION n`: play the seated
    animation forever.

## 4. Movement

### 4.1 The virtual controller

The AI never moves a soldier directly. Each tick it writes 40 float
**input channels** (H+0x3c6c + 4i, cleared every frame). The soldier class
copies them into its own input array (soldier +0x1b0; previous frame at
+0x110; `FUN_00453e60`), the same array the player's input fills. The body
code then moves the soldier. [recovered]

**Channels** [recovered]:

| Channel | Use | Set by |
| --- | --- | --- |
| 0 | turn (yaw) | `clamp(error, ±limit) / π` |
| 1 | pitch | as channel 0 |
| 2 / 3 | left / right (roll in the evasive states) | |
| 4 | forward | 1.0 while following waypoints |
| 5 | back | |
| 6 | trigger | firing |
| 8 | reload | |
| 26 | combat run (body states 17 / 18, section 4.3) | 1.0 in RePosition / Follow / LookForTarget |

**Requests.** Actions issue requests 0..9 through the per-AI-type table
0x53f3c0; the patrol and guard types map them to these channels
[recovered]:

| Request | Channel | Meaning |
| --- | --- | --- |
| 0 | 20 | walk/run toggle |
| 1 | 21 | kneel |
| 2 | 22 | lie down |
| 3 | 23 | play animation (value = animation id; -1 cancels) |
| 4 | 24 | use / stationary gun |
| 5 | 25 | panic run |
| 6 | 27 | aim |
| 7 | 28 | change weapon (FUN_00413c60) |
| 8 | 29 | throw grenade |
| 9 | 30 | close combat |

**Walk and run**: walking flag soldier +0xd00, toggled by a non-zero
channel 20. `FUN_004513f0` (walk) presses it when the flag is 0;
`FUN_00451470` (run) presses it when it is set. [recovered]

**Body states** read back through table 0x53f4fc [recovered]: stand 0,
kneel 19, liedown 26, animation 35, stationary gun 36 (soldier +0x2fc).

### 4.2 Following a route

`FUN_004510b0` → `FUN_004506b0` builds the waypoint queue (H+0xe0) from the
route table. Then `FUN_00450310` runs every tick [recovered]:

1. Express the next waypoint in the soldier's frame.
2. It is reached when |x| <= 1228.8 and |y| <= 1228.8 units (a 0.3 m box).
   The current node (H+0x3e24) becomes the waypoint's node, and the next
   waypoint is processed in the same tick.
3. Otherwise channel 4 = 1.0, channel 0 = yaw error clamped to ±H+0x3ec0
   (π for walking, so a full-rate turn) × 1/π, channel 1 = the pitch term.

**Turning to a point** (`FUN_004510e0`): same steering; done when both
errors are <= the tolerance (2° for aiming and LookAtEvent, 3° for
LookAtNode). [recovered]

**Speeds, turn rates, collision, steps.** None are AI constants. The body
moves by its animation's root translation rotated by the body matrix
(`FUN_00453ea0` → `FUN_004c9650` "Delta translation"; EKK gets an extra
factor `FUN_00413a20`), and turns at channel 0 × the body's own rate.
Walk/run/crouch speeds, turn rate, collision radius and step / slope rules
therefore belong to the character body. [recovered for the mechanism; the
body constants were not traced here]

### 4.3 The soldier body (state graph)

The channels drive the HumanSoldier state graph; the full table is in
[characters.md](characters.md) "Soldier state graph" (port:
`web-port/src/engine/ai/soldier-graph.ts`, `motor.ts`). What the AI side
needs [recovered]:

- **Order.** In the task tree each HumanSoldier node precedes its HumanAI
  node, so the body (FUN_0045bd00) runs first with the channels the AI
  wrote on its previous frame; the AI frame (FUN_0044e260) then sees the
  body's post-update position, orientation and state. Soldiers run in node
  order.
- **Body state** (+0x2fc) = graph state: the decision code waits for 0
  (stand), 19 (kneel), 26 (lie down); 35 is the scripted animation, 36 the
  stationary gun.
- **Requests and their states**: forward → 3 walk (walking flag) / 2 run;
  panic (ch 25) + forward → 1; ch 26 + forward → 17 combat run, + fire → 18
  (the clip is refilled every tick there); aim (ch 27) → 11 → 10, then fire
  (ch 6) → 6; kneel (ch 21) → 13 → 19 and releasing it pops straight to 0;
  lie down (ch 22) → 15 → 26, releasing it → 16 → 0; kneeling fire: fire →
  24, aim + fire → 22; reload (ch 8) → 7 / 23 / 28 (refill at the clip end);
  grenade (ch 29) → 8 (released on animation event 11 when the AI holds a
  target record, FUN_00451700); close combat (ch 30) → 9 (one blow on event
  12: rand ≤ "Close Combat hit probability", damage H+0x3da4 to the target
  object, no distance test in the body code); left / right (ch 2 / 3) → 4 / 5
  standing, 20 / 21 kneeling, all ending in 19; animation (ch 23) → 35.
- **Firing**: the gun's trigger is held only in states 6, 18, 22 and 27.
  A trigger request in 0 or 10 does nothing until the raise / aim states
  have passed; after the trigger is released state 6 runs to the end of its
  13-tick loop, then lowers (12, 19 ticks) unless aim is still held.
- **Reload while aiming** is not taken: 6 / 10 do not test the reload bit,
  so a reload request waits for state 0 (after 12).
- **Flinch**: damage since the last flinch above "Recoil threshold" (H config
  → soldier +0xd04) interrupts most states with the zone's hit clip (30,
  prone 31); the upper-body aim is off until it ends.

## 5. Actions, tick by tick

All functions [recovered]. "Ends" means `FUN_0044fdc0`. Times read in
seconds are converted at use with `now + t × 30`.

- **Patrol** (start 0x48cc40 / update 0x48cca0 / stop 0x48ceb0): starts
  walking; pushes a path cursor (up to N nested at H+0x1518); per tick runs
  the current command (section 3.4). After a command finishes, the cursor
  advances and its timer resets.
- **Combat** (sections 6, 7).
- **Dead** (0x488fa0): every tick only levels the view (`FUN_004501c0`).
  Never ends.
- **Idle** (0x48c940): the same; never ends. It is queued PUSHABLE by the
  common scripts, so any new action replaces it.
- **FallFlat(time)** (0x48cee0): request lie down every tick for `time`
  seconds, then end. Not queued when the current node is a STAIR node or
  when the event's other object is nearer than "liedown min distance". This
  corrects qvm-vm.md's "graph-node check".
- **Activate(taskId, run, flags)** (0x48ca40 / 0x48cb70) [recovered]:
  1. Look up the task. If it is a switch-like task and not already
     reserved, find the node nearest it, then breadth-first search up to 10
     nodes for one with a free occupancy cell.
  2. Walk or run (by `run`) to the nearest node, request use (channel 24 =
     task id), then step to the free node if it differs, and end.
  3. The task is reserved (H+0x3ab0) until the action stops.
- **WalkToNode / RunToNode(node)** (0x48cf70 / 0x48cfd0): walk or run to
  the node, reserving its cell; end on arrival.
- **FireAtNode / FireAtTask(target, t0, t1, reload)** (0x48d040 /
  0x48d180):
  1. For t0 ticks fire bursts (section 7) at the node position or at the
     task position (a QObj-based task), pausing t1 ticks between bursts;
     end after t0.
  2. When the clip is empty: with `reload` press reload; without it the clip
     is refilled instantly.
- **PlayAnimation(anim)** (0x48c2e0): wait for the stand state, request
  the animation, wait while the body is in the animation state, end.
- **PlaySound(name, bool)** (0x48c3a0): play the named sound at the
  soldier's position; end in the same tick. With `bool` set, a sound is
  started on the soldier object instead; that variant's argument was not
  traced.
- **MoveToEvent(run)** (0x48c440): go (walk or run) to the node nearest
  the event position; end on arrival.
- **LookAtEvent(time)** (0x48c4c0): turn to the event position (2°); once
  facing, end when `time` seconds have passed since the start.
- **Stunned(time)** (0x48c570): request animation 38 for `time` seconds;
  end.
- **KickGrenade** (0x48c670): finds the nearest node to the grenade, then
  only logs "Kick grenade" every tick. It never ends: a stub.
- **RunPanicking(r)** (0x48c690 / 0x48c8c0): **r is a radius in metres,
  not a time**; this corrects qvm-vm.md.
  1. If the event is within r × 4096, breadth-first search up to 10 nodes,
     from the node nearest the event, for a node farther than r from the
     event with a free cell.
  2. Panic-run there (channel 25), then end.
  3. If the event is farther than r, end at once.
- **SetCombat** (0x48c980): post COMBAT (team = own team, position, source
  and other copied from the current event) to itself; end in the same tick.
  The COMBAT event is dispatched next frame, and the script answers it with
  `AIAction_Combat`.

## 6. Combat

`AIAction_Combat` queues the type's combat action [recovered]:

| AI types | Combat action |
| --- | --- |
| RPG | 0x48af60 |
| GUNNER | 0x48b6e0 |
| SNIPER, PRIBOI, `*_GUARD_*` | 0x48b420 |
| ANYA, EKK | 0x489080 |
| `*_PATROL_*` | 0x488fc0 |
| CIVILIAN | nothing |

The start function registers the soldier as an attacker in the target
record of the first event that has an "other" object. It also sets "first
sequence" (data +0x28), which halves the hit probability of the first burst
(section 7).

### 6.1 Every combat tick

`FUN_00488d40` [recovered]:

- Refresh the perception slot of the target (H+0x3ddc). The action ends
  when the target is dead or no longer tracked.
- Update the shared last known position (section 2.6).
- Update the distance to it (data +8).
- Broadcast ALERT every 20 ticks.

The stop function (0x48bbf0) unregisters from the target record and leaves
a stationary gun.

### 6.2 Patrol types

`FUN_00488fc0` starts in Kneel when the soldier is crouched, in Liedown
when it is lying, else in Stand. [recovered]

**Stand** (`FUN_0048a020`), per tick:

1. **Evasive check first** (`FUN_0048a250`). It can interrupt a running
   sub-state:
   1. Draw r0.
   2. Return none when the last check was less than 10 ticks ago, when no
      GUNSHOTMISS, GUNSHOT or TAKINGDAMAGE event arrived this frame, or when
      standing on a STAIR node.
   3. Draw r1; return none when r1 > evasive probability.
   4. If roll/liedown probability == 0, or (r0 > roll/liedown probability
      and distance > liedown min distance), choose **lie down**.
   5. Otherwise draw r2 and choose **roll left** when the point 3 m to the
      left is inside the current node square, the last roll was not left,
      and (side probability == 0 or r2 > side probability).
   6. Otherwise choose **roll right** on the mirrored test (side probability
      == 1 or r2 <= side probability).
   7. Rolls press channel 2 / 3 until the body is in the kneel state.

   The **kneel** variants of the probabilities are never read; the stand
   values are used in every state.
2. Run the current sub-state, if any, until it reports done.
3. Otherwise wait for the stand state (an animation is cancelled with
   request 3 = -1), then decide with `FUN_0048a3f0` (`aiCombatDecision`)
   [recovered]:
   1. With no move target and not standing on its node (0.3 m margin):
      **RePosition**.
   2. Target not visible: count. When `count % 30 > 15`, look for a node
      near the target (below); if one is found, **Move** there. Otherwise
      **GiveUp** (end the action) once the count exceeds the targeting
      timeout, else **Look**.
   3. Distance < 1.5 m (H+0x3da8): **Close** (close-combat trigger).
   4. Clip empty: **Grenade** when a grenade is carried, the distance is
      within the grenade min/max, and rand <= "grenade throw probability";
      else **Reload**.
   5. Distance > tracking distance and a node is found on my route to the
      target: **Move**.
   6. **Grenade** under the same conditions with "grenade throw when reload
      probability". The two probabilities apply in the reverse of what
      their names say: the "throw" value applies when the clip is empty.
   7. Fewer than 3 others firing at the target: **Fire** (status 0);
      otherwise **Look** (status 2).

**Node search** (`FUN_00489470`, `FUN_00489680`) [recovered]:

- Breadth-first from the node nearest the target, examining at most 5
  nodes.
- Takes the first node that has a free occupancy cell and a clear ray from
  node height + "Node cover midoffset" × 4096 to the target's aim point.
  The 0.79 rule applies. The midoffset is graph +0x80; that it is the
  AIGraph parameter is recovered from the AIGraph schema `FUN_004ffe00`,
  whose field offsets and defaults (0.3 link width at +0x98, 0.01 step at
  +0xa8) line up with the declared parameter order. The level-1 value is
  1 m, and 0.5 m on graph 4019 [observed].
- When the target is visible the node must also lie on my shortest route
  to the target's node: cost(me→target) >= cost(node→me) + cost(node→target)
  in the route table.

**Sub-states** [recovered]:

| State | What it does |
| --- | --- |
| RePosition (`FUN_0048ab80`) | walks back to its reserved cell on the current node |
| Follow (`FUN_0048ac80`) | **runs** to the move node (the search is redone every tick); if the target is visible and lies within acos(0.96) ≈ 16° of the facing direction, it fires while running (subject to the 4-shooter limit) |
| LookForTarget (`FUN_0048aed0`) | turns to the last known aim point (2°) |
| Reload (0x48bf30) | presses reload until the clip has rounds |
| Grenade (`FUN_0048c010`) | holds request 8 while standing; the body throws, using the grenade fly / explode times |
| Close (`FUN_0048bfd0`) | holds request 9 |
| Fire (`FUN_0048bcd0`) | section 7 |

**Kneel** (`FUN_0048a6a0`) and **Liedown** (`FUN_0048a960`) hold their
stance request every tick and use the same decision, with these
differences:

- **Grenade only logs** "Kneel / liedown throw grenade" and throws nothing.
- **Close** stands up.
- **RePosition, Move and Look** stand up first.
- Their "stand up when liedown min distance < 0" branch never triggers with
  the shipped settings.
- Liedown is entered only through the evasive choice; leaving it needs a
  Close, RePosition, Move or Look decision.

### 6.3 Guard, sniper, priboi

`FUN_0048b4a0` ("Guard Combat - Stand") [recovered]:

- Never moves, kneels or rolls.
- Not visible: count; give up after the targeting timeout. While the
  target is outside the cone, turn toward its last known aim point.
- Clip empty: reload.
- Visible: if fewer than 4 others are firing at the target, start a fire
  sequence; otherwise wait (status 2).
- The weapon-kind 5 branches (close combat, request 9) never run: H+0x3dd4
  is only ever 0.

### 6.4 ANYA, EKK

`FUN_004890e0` uses `FUN_004892b0`: the patrol decision without Close and
without grenades (shooter limit 3). Stand state only; the close-combat
distance is 0. [recovered]

### 6.5 RPG

`FUN_0048aff0` (Stand) / `FUN_0048b210` (Kneel) [recovered]:

- Never moves.
- Reloads in the kneel state.
- Between shots, with probability 0.4, it switches stand ↔ kneel.
- It fires when the target is visible.
- The not-visible handling and timeout are the same as the guard's.

### 6.6 GUNNER

`FUN_0048b760` [recovered]:

- With a stationary gun (H+0x3ac4) not used by someone else, checks
  whether the target lies inside the gun's arcs, measured in the gun's
  frame: |horizontal| < gun +0x1e8, and gun +0x1e4 < vertical < gun +0x1e0
  (degrees).
- Not on the gun, target in the arcs: after 30 ticks, mount (request 4,
  value = gun id). Meanwhile, and whenever the target is outside, it
  behaves as a guard with its primary weapon ("No primary weapon"
  otherwise).
- On the gun: it aims the gun (`FUN_00473b80`) and fires through it with
  the guard rules (limit 4). After 30 ticks with the target outside the
  arcs it presses request 0 = 1.0; that this dismounts is [inferred].

## 7. Firing

**Start of a sequence** (`FUN_00489de0`) [recovered]:

- **Aim point**: the target's last known origin + 2048 units (0.5 m)
  standing, + 1024 (0.25 m) crouched (`FUN_00450150`).
- **Rounds** in the sequence, with clip = WeaponConfig Rounds/Clip (gun
  +0x648), burst = Maximum Rounds/Burst (gun +0x64c) and r drawn first:
  - When burst == clip or burst < 2: `fistp(clip × (r × random clip % +
    min clip %))`, truncated (the sum is stored as float32 first, 0x489e08;
    fistp at 0x489ec8), clamped to [1, max rounds per sequence]. Example:
    clip 32, 30 % → trunc(9.6) = 9.
  - Otherwise: one burst of `burst` rounds.
  - A grenade weapon (WEAPONTYPE 4) fires 1 round with hit probability 1.
- **Hit probability**, with d the distance from the soldier to the aim
  point and L the soldier's current non-alarm view length (H+0xb0):
  - `p = min-range probability` when d < 0.01 units;
  - otherwise `p = min(d, L) / L × (max-range − min-range) + min-range`.
  - The first sequence of a Combat action uses p / 2.
  - "Maximum range" therefore means the view length.
- p is stored in soldier +0x4d4 and travels with every bullet.

**Every firing tick** (`FUN_0048bd00`) [recovered]:

1. Aim point += (target aim point − aim point) × aim precision (smoothing
   per tick).
2. When the sequence's rounds are used up or the clip is empty, the
   sequence is done.
3. Request aim (channel 27).
4. Each time the gun's clip count changes, one round is counted. For a
   burst-1 weapon the next shot waits `fistp((r × random shot delay +
   min shot delay) × 30)` ticks, truncated (0x48beb6).
5. Turn to the aim point (2°). Once facing and the wait is over, pull the
   trigger (channel 6). The gun's own fire rate and spread then apply.

**How p is applied** (`FUN_0045d100`, the Human class's bullet-ray filter)
[recovered]:

- When an AI bullet's ray reaches the player's hitbox, it may collide only
  if `rand() <= p`; otherwise it passes through, possibly hitting the
  scenery behind and raising GUNSHOTMISS.
- Bullets never collide with humans of the shooter's team, and always with
  other non-player humans.
- The player's own bullets carry p = 1.

**Not applied anywhere**: "Combat firing minimum / random delay" (the
pause between sequences; only written to H+0x3dcc, never read), "Combat
initial movement delay" and "Combat movement delay" (same field), and the
two kneel evasive probabilities. **There is no pause between sequences**:
the decision runs again on the next tick. [recovered by an exhaustive
reference count in the .text listing]

## 8. Combat settings mapping

`FUN_00407080` copies the HumanAIConfigItem of the soldier's AI type at
the active profile difficulty into H. `tools/igi_ai.py` prints the whole
table. [recovered]

| Field | H offset | Conversion | Read by |
| --- | --- | --- | --- |
| Damage scale | soldier +0x258 | copy | damage code |
| Recoil threshold | soldier +0xd04 | copy | HumanSoldier only |
| Initial movement delay | 0x3d3c | × 30, fistp (truncated) | **never read** |
| Movement delay | 0x3d40 | × 30, fistp (truncated) | **never read** |
| Targeting timeout | 0x3d48 | × 30, fistp (truncated, 0x407100..0x40714c) | decisions |
| Tracking distance | 0x3db8 | × 4096 | decisions |
| Liedown min distance | 0x3db0 | × 4096 | evasive, FallFlat |
| Evasive probability | 0x3d4c | copy | evasive |
| Stand roll/liedown probability | 0x3d50 | copy | evasive |
| Kneel roll/liedown probability | 0x3d54 | copy | **never read** |
| Stand roll side probability | 0x3d58 | copy | evasive |
| Kneel roll side probability | 0x3d5c | copy | **never read** |
| Hit probability at min / max range | 0x3d60 / 0x3d64 | copy | fire start |
| Max rounds per sequence | 0x3d44 | copy | fire start |
| Aim precision | 0x3dc0 | copy | fire tick |
| Min / random clip % | 0x3d68 / 0x3d6c | copy | fire start |
| Firing min / random delay | 0x3d70 / 0x3d74 | copy | **never read** |
| Min / random shot delay | 0x3d78 / 0x3d7c | copy | fire tick |
| Grenade throw probability | 0x3d80 | copy | decision, clip **empty** |
| Grenade throw when reload probability | 0x3d84 | copy | decision, clip **loaded** |
| Grenade min / max distance | 0x3d88 / 0x3d8c | × 4096 (f32) | decision |
| Grenade fly / explode times | 0x3d90..0x3d9c | copy | soldier grenade code (0x45a2xx) |
| Close-combat hit probability / damage | 0x3da0 / 0x3da4 | copy | soldier close-combat code |

## 9. Constants

Every value below is [recovered] and re-read from the exe image by
`tools/igi_ai.py`.

| Constant | Value | Where |
| --- | --- | --- |
| tick | 1/30 s | GAME_FREQUENCY |
| perception period / cone / ray | 4 ticks / every 2nd run / every 3rd run | `FUN_0044f3a0` args 4, 8 |
| line-of-sight pass | first hit at >= 0.79 of the ray | 0x532218 |
| vision target height | 2826.24 units standing, 1433.6 crouched | `FUN_00464490` |
| aim height | 2048 units standing, 1024 crouched | 0x531460 / 0x5318e8 |
| default cones | 45° / 50° / 30 m; secondary 45° / 80° / 10 m | `FUN_0044deb0` |
| ALERT | every 20 ticks, 7 m (28672 units), flags 0x26 | `FUN_00488d40` / `FUN_00488f30` |
| detected voice gap | 90 ticks | `FUN_00488d40` |
| hearing ranges | gunshot 30 m / 1 m; door, fence, ladder, landing 5 m (hard landing 10 m); miss 2 m; grenade land 5 m; flashbang 10 m; explosion 25 m | section 2.3 |
| waypoint reached | |x|, |y| <= 1228.8 units | 0x531850 |
| steering gain | 1/π | 0x531820 |
| turn clamp | π normally, 0.025926 rad for LookAtNode | `FUN_004513c0` / `FUN_00451390` |
| tolerances | 2° aim / LookAtEvent, 3° LookAtNode | 0x3d0efa35 / 0x3d567750 |
| on-node margin | 0.3 m; height ±1 m | `FUN_004f0610` |
| occupancy | 2 m cells, kernel 100/50/25, free below 25 | 0x531708, 0x53aa48 |
| node search | BFS 5 nodes (combat), 10 (Activate, RunPanicking) | `FUN_00489470`, `FUN_0048c720` |
| roll room | 3 m (12288 units) to either side inside the node square | `FUN_004514f0` |
| evasive gap | 10 ticks | `FUN_0048a250` |
| close-combat distance | 1.5 m (0 for ANYA / EKK) | H+0x3da8 |
| shooters per target | 3 (patrol / female decision), 4 (guard, gunner, follow) | decisions |
| fire while running | cos > 0.96 | 0x532238 |
| RPG stance switch | 0.4 | 0x5315d8 |
| reaction delay | 6..11 ticks (truncated), no effect | `FUN_0044fc40` |
| death countdown | 300 ticks (H+0x3d38 → H+0x3e08) | `FUN_0044deb0` |

## 10. Integration notes for the engine

Per soldier keep:

- The qvm-vm.md state: event queues, priority list, action stack, script
  slots, view parameters.
- The perception slots.
- The current node and the waypoint queue.
- The occupancy reservation.
- The combat config (`aiCombatConfig`).
- A shared target record per target: last known position and the attacker
  list with statuses.

**Each 30 Hz tick, for every soldier:**

1. Zero the 40 channels.
2. Return if the soldier's graph is missing (the original AI does nothing).
3. On the first tick run CREATE. On death run DEAD once.
4. If `(application tick & 3) == phase`, walk the humans in task-tree
   order: drop or add their slots (team rule, in world), then run
   `aiPerceptionStep` for each tracked one:
   - cone = `aiInViewCone(eye, targetPoint, view, alarmFlag)`;
   - ray = the see-through product of the world hits and of every other
     human's posed set-0 faces (sphere pre-test) from the eye to origin +
     2826.24 (or 1433.6 crouched).
5. Queue ENEMYDETECTION / FRIENDLYDETECTION for every visible slot, every
   tick. Queue ALARMON / ALARMOFF from the alarm task, ANIMATION from the
   interval timer, and IDLE if the stack is empty.
6. Set the alarm flag from step 5 or "target still tracked".
7. Dispatch events by priority (qvm-vm.md), then run the top action's
   update.
8. Feed the channels to the soldier body.

**World events.** When the player or a soldier makes a noise, build the
record from `AI_EVENT_PRODUCERS` and offer it to every soldier through
`aiEventAccepted`.

**Movement.** `aiGraphWaypoints` gives the legs. Each tick steer with
`aiSteerValue(yawError, π)` on channel 0 and press forward until the
waypoint is inside the 1228.8 box. The body supplies the speed (animation
root motion; walk vs run by the toggle).

**Combat.** On a decision tick (stand state, no sub-state):

- Call `aiEvasiveChoice`, then `aiCombatDecision`.
- On FIRE, start a sequence with `aiRoundsPerSequence`, `aiHitProbability`
  (first sequence halved) and `aiShotDelayTicks`.
- Each tick move the aim point with `aiAimStep` and pull the trigger only
  when facing within 2°.
- For every bullet ray that reaches the player, collide only if
  `aiBulletMayHitPlayer(rand, p)`.

**RNG.** Draw from the level RNG in the exe's order (qvm-vm.md "Random
numbers"):

- the evasive check draws r0 every decision tick, r1 and r2 only when the
  earlier tests pass;
- a fire sequence draws its r first;
- the grenade checks draw only when every other grenade condition holds.

## 11. Open questions

- **Body side**: answered in 4.3 and characters.md "Soldier state graph"
  (speeds are the clips' root motion; turn FUN_0045fd00).
- **Channels**: 26 is the combat run (states 17 / 18) and request 7
  (channel 28) changes the weapon (4.3); channels 7 and 9 set graph bits
  0x400 / 0x1000 that no HumanSoldier state reads.
- **Graph attachment**: which code sets the "attached" flag of a graph
  (graph +0x64) for the Heli / Train / Car graphs was not traced.
- **Body reactions**: the rolls and requests 8 / 9 are in 4.3; the grenade
  throw arithmetic with the fly / explode times (FUN_0045a170 → FUN_00451740,
  FUN_00413b70) was not traced.
- **Spread**: the gun's spread on AI shots, beyond the per-bullet player
  filter, follows WeaponConfig and was not re-traced here.
- **Waypoint queue**: `FUN_004506b0` can start a new route from a later
  node already in the old queue when the soldier is not on its current
  node. `aiGraphWaypoints` covers only the plain case.
- **AlarmControl +0x2a2**: assumed to be "alarm turned off" [inferred].
- **Hearing positions**: TAKINGDAMAGE's position vector and the exact
  GUNSHOTMISS sample points (`FUN_00479970`) were not decoded.
- **Death countdown**: H+0x3e08's use beyond the countdown (body removal or
  AI shutdown) was only partly read.

## 12. Validation

- `python tools/igi_ai.py` prints `all checks passed`. It covers:
  - all 11 level-1 graphs (route invariants; graphs 7 and 13 equal
    Dijkstra; graph 4019's 46 stale costs);
  - every patrol path simulated;
  - the 29 GD_2 config items;
  - 37 constants and 2 tables re-read from `igi.exe`.
- `npx vitest run tests/ai.test.ts` passes 19 tests:
  - synthetic stream, route, node and rule cases;
  - level-1 graphs against their AIGraph tasks;
  - patrol paths 2605, 2401, 1504 and 3030;
  - the settings.qvm config.
