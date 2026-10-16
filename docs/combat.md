# Combat tasks of the full game: StationaryGun, AI turrets, MineField, M203, SPAS12, HumanSoldierRPG, GuardGenerator, HumanSoldierFemale

Part 1 is the port (what is implemented where, with its evidence); Part 2 is the reverse-engineered specification it follows. Every address is in the full-game exe (docs/evidence-ledger.md E163).

## Part 1: in the port


Work tree: `wt/combat/work`. Spec: `specs/combat.md`. Every address is in the
**full exe** unless marked otherwise. Evidence tags: **[observed]** (seen in the
data or by running the port on the full data), **[recovered]** (read from the
disassembly / decompile), **[inferred]** (a reasoned guess, not traced).
Units: IGI 4096 = 1 m, z up, radians; the engine works in metres, y up.
Each new module starts with a header comment that lists its addresses in more
detail than below.

### Architecture

The four task types run as **registered task behaviours** of the mission
runtime (`src/loaders/objects/*.ts`, imported for their side effect by
`src/loaders/objects/index.ts`, which `src/loaders/index.ts` imports). Each
behaviour keeps the recovered state machine at its place in the task tree
(update order as in the exe) and talks to the engine only through
`MissionHost.onTaskEvent(name, payload)` and `MissionHost.query(name, ...)`;
without an engine (tests, tools) the behaviours still run.

`src/engine/combat/combat-objects.ts` is the engine side: it registers the
event handlers and queries on the mission system and drives
`stationary-guns.ts`, `ai-turrets.ts`, `projectiles.ts` and the soldier
manager (`enemy.ts`). `game.ts` creates it next to the other systems, resets
it with the mission, hands it the world (ray tests) and draws its models
(`src/engine/render/combat-models.ts`).

Mission-system hooks added (small, in `src/engine/mission/mission-system.ts`):
`onTaskEvent` / `setTaskQuery` / host `query`, `random` (the level RNG),
`takePerceptionPhase`, `Enemy.outOfWorld` in the in-world test.

### 1. GuardGenerator (82 tasks, missions 4-14)

`src/loaders/objects/guard-generator.ts`, engine `enemy.ts` (`spawnGenerated`,
`removeGenerated`, `corpseTick`).

- [recovered] Class FUN_00487be0 (size 0x80). Schema "Generate guards"
  (+0x20), "Max spawns" (+0x78). Members `<name>.isOn`, `.isSpawned` (bytes),
  `.nSpawns` (int) (0x488430).
- [recovered] Compile FUN_00488200 -> FUN_00488220 turns the children into a
  template and deletes them: **no generated soldier exists at level start**,
  and their HumanAI compile (which takes a perception phase from the
  process-wide counter DAT_005c4a48) never runs at load.
  `src/loaders/mission.ts` `perceptionPhases` therefore skips HumanAIs under a
  GuardGenerator, so every later soldier gets the exe's phase. [observed:
  mission 14 has 38 generators; the phases of the other AIs shift accordingly]
- [recovered] Update FUN_00487ee0 (before the children): isOn =
  (char)fistp(expr) when valid; off -> isSpawned = 0 only with no child; on and
  nSpawns < max: no child -> spawn; dead child (+0xcf5) and out of the world
  (+0xcf6 == 0) -> delete (FUN_004015f0) and spawn. Spawn FUN_00488000 sets
  isSpawned = 1, nSpawns + 1 (the first spawn counts).
- [recovered] Corpse removal, HumanAI update 0x44fa8f-0x44fb7f: after the
  death clip ends, countdown H+0x3e10 (300, set by AI init 0x44f25a) runs down;
  once negative a GuardGenerator child leaves the world unconditionally
  (FUN_00488610); any other soldier only when it was not drawn in the previous
  tick (+0x7c4 stamp in the draw path 0x45f2bf). Port: `corpseTick` with the
  body's LOD choice standing in for the stamp.
- Engine: `guard.spawn` creates the template's soldier and HumanAI (fresh
  perception phase via `takePerceptionPhase`), `guard.remove` deletes it,
  query `guard.child` answers {dead, inWorld}.
- [observed] mission 8: a generator respawns its soldier after the corpse left
  the world (>300 ticks after death); mission 4: the generators in closed
  containers do not spawn.

### 2. StationaryGun (20 tasks, M2HB)

Rules `src/loaders/objects/stationary-gun.ts`; engine
`src/engine/combat/stationary-guns.ts`; player `player.ts` (state 33),
`camera.ts` (mode 4), `interact.ts` / `use-objects.ts` (use).

- [recovered] Class FUN_00473ed0, create 0x473d30, compile 0x474980 (Gun via
  FUN_00477c50 with the task's Ammo; -1 = endless, the fire code only
  decrements a clip > 0). [observed] all 20 are WEAPON_ID_M2HB, Ammo -1 except
  mission 7 #3301 (10000 rounds, then dry-fires, no reload path).
- [recovered] Update FUN_00474190: **unmanned**: the stored pitch moves to Max
  down by 5 deg/tick (f32 0x53387c) without overshoot; yaw and the **drawn
  totals are not changed** (so the barrel keeps its last manned pose).
  **Manned**: pitch += ch1 x pi, yaw -= ch0 x pi, clamp FUN_004748b0 (yaw only
  when maxSide < 2 pi), totals = angle + kick, kick x 0.9, then the Gun use
  FUN_00474360 which overwrites the kick with the Gun's outputs (one-tick
  recoil jitter).
- [recovered] Pose FUN_00474420: object = base x Rz(total yaw) (the holder
  model turns); pivot = origin + FUN_00414e20(index 1) = **the origin**
  (123_02_1 has one magic vertex, index 1 is not below the count); gun matrix =
  object x Rz(pi) Rx(pitch); eye = pivot + 0.2 m x gun col2 - 0.5 m x gun col1,
  the view override = the gun matrix.
- [recovered] Firing (Gun FUN_00479780 / FUN_00478ba0): 2-tick cooldown
  (fistp(60/800 x 30)), spread = minimum for the first 4 shots of a hold then
  the maximum, burst loop sound with Loop End, muzzle = magic vertex 2 of the
  gun model, direction gun col1, GUNSHOT AI event at the muzzle (team of the
  user or 1), clip -1 never decremented. Player-manned guns shoot the
  player's bullets (`weapon.ts shootBullet`, so One Shot Kills applies);
  soldier-manned ones the soldier's.
- [recovered] Use: candidate test FUN_00474e30 (from behind only), kind 6,
  icon `a_gun.spr`; mount through FUN_00444b30: the human stands 0.7 m behind
  the use point (P + col1 x 2867.2), heading gamma + pi, the player flips M
  when in front.
- [recovered] Player state 33 (enter FUN_0040c970, tick 0x40cae0): arms clip
  198, weapon holstered, attached; leaves on a fresh Activate press or death
  (state 0, FUN_00475340 releases the gun and the view override).
- [recovered] Camera mode 4: eye/matrix from the override, 90 deg horizontal
  FOV (the port's `fovYDeg` now derives the vertical FOV from tanX in modes 1
  and 4).
- [recovered] **HUD while mounted**: the player HUD FUN_0045f070 tests the
  camera mode (0x45f075 `cmp [cam+0xe8], 1`) and skips the health, weapon
  panel, crosshair and use icon in any other mode, so on the gun (mode 4) none
  of them is drawn. The gun's own HUD method (id 0x539546 -> FUN_00474f10 ->
  FUN_004871c0: the pulsing `a_gun` icon at (W/2, 0.875 H), alpha tri x 0.7 +
  0.3) is called only from the human HUD 0x460400 for the **use target**
  (+0x7b0) in mode 1 while nothing is in use (+0x7b8 == 0, 0x460481): it is the
  normal action icon before mounting. The port already follows both rules
  (`hud.setPlayerView(camera mode)`, `firstPersonView`), no HUD change needed.
- [observed] mission 8: the player mounts #775 from behind, state 33 / mode 4,
  4-5 rounds in 10 ticks, leaves on a fresh Activate.

#### GUNNER soldiers (`src/engine/ai/gunner.ts`, `combat.ts`, `motor.ts`)

- [recovered] AITYPE_GUNNER start FUN_0048d2c0, tick FUN_0048d340: target in
  the gun's arcs (aim point into the base frame, FUN_004148f0/FUN_00414950)
  for 30 ticks -> request 4 = gun id on channel 24; the body mounts in its
  pre-update (0x459c2b, FUN_00459d50 -> FUN_0045c8b0) into body state 36;
  out of the arcs on the gun for 30 ticks -> request 0 (but state 36 leaves
  only on a fresh channel-24 press or death: the soldier stays). Fire tick
  FUN_0048d8e0; the AI turn writes clamp(err, +-pi)/pi into channels 0/1 so
  the gun follows. `GetGunnerStatus` via `hooks.stationaryGun` ("StationaryGun
  ID #%d not defined").
- [observed] mission 8: soldier 445 (SetGunnerID 780) mounts on channel 24,
  state 36, 0.7 m behind the gun, gun 780 in use.

### 3. AIStationaryGunHolder / AIStationaryGun (mission 14)

Rules `src/loaders/objects/ai-stationary-gun.ts`; engine
`src/engine/combat/ai-turrets.ts`.

- [recovered] Holder FUN_0046e370 (create 0x46e210, compile FUN_0046e7f0,
  update 0x46e5b0): Team / On expressions (fistp), detector cone (Viewcone
  Alpha/Gamma 360 deg, length 10 m), run on the holder's perception phase.
- [recovered] Turret def (DefineMagicObj tail, FUN_0046fa50), create
  FUN_0046eae0, update 0x46f390: first visible slot, 90-tick memory, 2 pi
  unwrap, slew by the def steps, fire FUN_0046f950 within 5 deg and beyond min
  range, spin, turning sound while the clamped error > 2 deg; pose
  FUN_0046fba0 / FUN_0046ec90.
- [inferred] the ATTA matrix B = the instance placement relative to the
  holder (FUN_004e0930 not traced); the bullets spare the holder's team.
- Invisible cheat: the turret perceives through `present()`, which is false
  for the invisible player.
- [observed] nine holders, each with its 456_12_1 turret and the SENTRY gun;
  their team flips with `!Terminal_301.isHacked` (hack -> turrets switch side).

### 4. MineField (missions 7, 9)

`src/loaders/objects/mine-field.ts`; engine query/explosion in
`combat-objects.ts`.

- [recovered] Class FUN_0043a840, create FUN_0043ab50, update FUN_0043abc0
  (timer -1 idle; != 0 count down, also below -1: "explode once" gives -30 and
  never fires again; 0 + expression != 0 -> explode, timer = fistp(f32 repeat
  x 30)), explode FUN_0043ac40 (task "Explode close to task ID", snap ray 400 m
  down then up FUN_004149b0, FUN_00480fe0 with radius x 4096, scorch 6144,
  model 1009_01_1, no AI event, range 102400).
- [observed] mission 7: explodes under the player inside its trigger area,
  sound `explo_m_02` as in the data.

### 5. M203 (mission 6 M16A2)

`weapon.ts` (S1 alt branch, S6), `weapon-tags.ts` (M203 tags), `projectiles.ts`.

- [recovered] S1 0x40ec96: AlternateFire with WEAPON_ID_M16A2: Unlimited Ammo
  flag -> S6 at once, else an AMMO_ID_M203 round leaves the pool (0x40ed08) ->
  S6. S6 enter 0x40f4a0: FireAnim2 (arms clip 39) and the alternate request;
  S6 tick 0x40fd70: clip end -> S1. GunM16A2 use FUN_00473510 launches.
- [recovered] Launch at the eye: v = view col1 x f32(km/h x 4096000) x
  9.259259e-6 (270 km/h -> 10240 units/tick); "m203_launch_1". Flight
  0x476340: v xy x 0.995, vz = (vz - 35.68071) x 0.995; ray old -> new; hit ->
  FUN_00480fe0 at the hit point (damage 1.0, radius 5 m, falloff 0 = binary,
  scorch 4096, 3 frags, 1 fireball, "explo_proxy", AI 21, range 102400).
  Three level-RNG draws per tick for the smoke particle are consumed.
- HUD: the existing M203 counter (`hud.setM203Rounds`) shows the pool.
- [observed] mission 5 data: pool 3 -> 2, clip 39, 10240 units/tick.

### 6. SPAS12

`weapon.ts` `spasReload` (S3 branch for TASKTYPE_GUNSPAS12).

- [recovered] Fire: 30 pellets, cooldown fistp(60/40 x 30) = 45 ticks (weapon
  config, already in the pellet path).
- [recovered] Reload FUN_00472ae0: clip 61 (0.4 s blend) -> 62 per shell (one
  round from the pool each, until full or the pool is empty) -> 63 -> done; no
  pool -> done at once; the UnlimitedAmmo flag is not read (the pool is).
- [observed] 5 -> 7 rounds: clips 61, 62, 62, 63 in about 83 ticks.

### 7. HumanSoldierRPG (mission 10 #431) and the RPG missile

`soldier-variants.ts` (graph), `rpg-combat.ts` (combat), `projectiles.ts`
(missile), `enemy.ts` (TASKTYPE_MISSILE guns).

- [recovered] Class FUN_00456ad0, create FUN_00456c70 (skeleton 2, Stand
  Animation 2), graph 0x53e6a8 (15 states), action table 0x53e720, zones
  0x53e798, pre-update FUN_00456cf0, request map 0x54138c, body-state map
  0x541590 (stand 0, kneel 7, animation 14); death via FUN_0045daa0 -> 15/16.
- [recovered] AITYPE_RPG combat FUN_0048cb40 / 0x48cbd0 (stand) / 0x48cdf0
  (kneel): stance switch after a shot with rand < 0.4 (f32 0x5335d4); reload
  sub-state 0x48dd10 kneels, alternates animated reload (channel 8) and the
  instant refill [alternation inferred].
- Missile: [recovered] spawn values (682.7 units/tick, fuel 4 s, explosion
  damage 5, radius 2.5 m, falloff 1.75 m, 10 frags, 5 fireballs, "explo_03_l",
  source = weapon id 12 so it destroys cars). The flight is the recovered
  Vehicle-physics step (combat/missile.ts; docs/vehicles.md "Mounted weapons
  and the Missile"); the tumble uses its own RNG (DAT_0057bc88), never the
  level RNG.

### 8. HumanSoldierFemale (mission 14, 5 tasks) - coordinator item

`src/loaders/soldier-types.ts`, `soldier-variants.ts`, `motor.ts`,
`loaders/level.ts`, `mission-system.ts`, `game.ts`, `enemy.ts`.

- [recovered] Class FUN_00454970, same schema and size (0xd50) as
  HumanSoldier; create 0x454b10: skeleton 6, Stand Animation -1, own graph
  0x53e400 (13 states), action table 0x53e4a0 for every AI type, zone table
  0x53e508; compile 0x454f10 (stand clip 6). Pre-update 0x454ba0 (keep mask
  0xffc3e01c, channels 21-24 = animation, use, aim, weapon change), request
  map 0x541454, body-state map 0x5415f4 (stand 0, animation 11). Hits: as the
  soldier's but the flinch bit is never set. Root motion x
  DefineHumanPlayerGeneral arg 0 (DAT_0056e1e8, 1.75) for AITYPE_EKK.
- `SOLDIER_TASK_TYPES` {HumanSoldier, HumanSoldierFemale, HumanSoldierRPG}
  with per-type defaults (skeleton / Stand Animation 1/-1, 6/-1, 2/2) is used
  by every place that tested "HumanSoldier": loader soldier list
  (`LevelSoldier.taskType`), mission-system soldier nodes / values / update,
  game.ts node tick, enemy.ts.
- [observed] full data: the 5 L14 females load (skeleton 6; Ekk 012_01_1 x4,
  Anya 015_01_1); the female body with 006.iff plays stand 6, raise 7, aim 14,
  fire 9.
- Not modelled: the female's use (switch / door through channel 22) and weapon
  change (channel 24) - no mission script asks for them in the AI paths the
  port runs.

### Cheats

Unlimited Ammo (M203: S6 at once as the exe's flag; SPAS reload reads the
pool as in the exe), Unlimited Health (player damage path unchanged), One Shot
Kills (gun-mounted player shots use the player's bullet path), Invisible
(turret perception, gun GUNSHOT events from the player skipped, soldiers'
perception unchanged) keep working.

### Tests

- `tests/combat-objects.test.ts` (synthetic, 18): GuardGenerator, MineField,
  StationaryGun rules/pose/use/arcs, cooldowns, turret, M203 ballistics,
  female / RPG graphs.
- `tests/full-combat.test.ts` (full data, skipped without `game-data`, 15):
  counts (20 / 9 / 2 / 82 / 1 / 5), gun parameters, phase skip, generators,
  L14 females, L10 RPG, L14 turrets and team switch, female motor, L7
  MineField, L8 engine rig (generator respawn, player mount, gunner), L5 M203,
  SPAS12 reload.

### Open points

- M203 smoke particles are not drawn (their RNG draws are consumed).
- Female use (switch / door) and weapon change requests not modelled.
- HumanSoldierPistol (FUN_00459880) is registered in the exe but placed in no
  mission: not added.
- Turret ATTA matrix B and the turret bullets' team filter are inferred.

## Part 2: recovered rules (full exe)


Source: the **full-game** `igi.exe` (`scratchpad/re-full/igi.exe`, Ghidra 12 project
`ghidra_proj_master`, objdump `igi_full.asm`). Every address below is a
full-exe address. The repo docs (docs/*.md) quote the DEMO build; the
equivalences used are listed in §0. Data: `web-port/game-data`
(objects.qvm of missions/location0/level1..14, weapons/weaponconfig.qvm,
weapons/*/weapon.qvm, ammo/*, common/ai/settings.qvm, magicobj/magicobj.qvm,
physicsobj/missiles/*, common/anims/00x.iff, animtrigger/animtrigger.qvm),
read with the port loaders (`readQvmCallTree`, `readTaskTree`,
`flattenTasks`, `readAnimations`, `readMefMagicVertices`).

Labels: **[recovered]** read from igi.exe code; **[observed]** read from a
data file; **[inferred]** interpretation the traced code does not prove.
Units: 4096 units = 1 m, z up, 30 ticks/s. The x87 FPU runs in chop mode
(docs/gameplay.md), so every "ROUND" below is a truncating `fistp`; the
port's `fireCooldownTicks` (loaders/gameplay-params.ts) already models it.

---

### 0. Address map and conventions [recovered]

Class registration (`FUN_00401900(name, size, parent)`; method slot 0 =
create, 1 = update, 2 = destroy via `FUN_00401400` / `FUN_00401530`; other
methods by id; dispatch table `0xa96ae0[method × 0x180 + type]`, update
slots `0xa970e0[type]`; all registered from `FUN_00402930`):

| Class | Registration | Size | Parent | create / update / destroy |
|---|---|---|---|---|
| StationaryGun | `FUN_00473ed0` | 0x220 | 0x4c48c0 (model object) | 0x473d30 / `FUN_00474190` / `FUN_00474960` |
| AIStationaryGunHolder | `FUN_0046e370` | 0x26a0 | 0x4c48c0 | 0x46e210 / 0x46e5b0 / 0x46e7a0 |
| AIStationaryGun | `FUN_0046f2b0` | 0x1e8 | 0x4d9fa0 (magic obj) | `FUN_0046eae0` / 0x46f390 / 0x426860 |
| MineField | `FUN_0043a840` | 0xd0 | 0x5034d0 | 0x43ab50 / 0x43abc0 / 0x43ad20 |
| Gun (base weapon) | `FUN_00477e30` | 0x1b0 | 0x4c48c0 | 0x478540 / 0x478640 / `FUN_00478840` |
| GunM16A2 | `FUN_004733f0` | 0x1b0 | Gun | 0x4734d0 / (Gun) / `FUN_004754a0` |
| GunSPAS12 | `FUN_00472a70` | 0x1b0 | Gun | 0x472ca0 / (Gun) / (Gun) |
| M203 (projectile) | `FUN_00476110` | 0x128 | 0x4c48c0 | 0x4761b0 / 0x476340 / `FUN_00476600` |
| Missile (RPG rocket) | `FUN_00427ff0` | 0x898 | Vehicle 0x4f45f0 (0x748) | 0x428270 / 0x428390 / `FUN_00428ca0` |
| HumanSoldierRPG | `FUN_00456ad0` | 0xd40 | Human 0x460be0 | 0x456c70 / 0x454ee0 / `FUN_00459ec0` |
| GuardGenerator | `FUN_00487be0` | 0x80 | 0x4018f0 (container) | `FUN_00487eb0` / 0x487ee0 / `FUN_004880f0` |

Method ids used here (getter → global byte): use-point candidates
`FUN_004167f0` (0x539542), use kind `FUN_00416810` (0x539543), use
start/continue `FUN_00416800` (0x539544), gun use `FUN_00460bf0`
(0x53f314), gun reload `FUN_00460c10` (0x53f315), HUD draw `FUN_00487190`
(0x540b5c), parameter schema `FUN_004f1a60` (0x54e0e4), compile
`FUN_004f1a70` (0x54e0e5), weaponconfig tag reader `FUN_004071d0`
(0x5690d8), projectile spawn `FUN_00413b20` (0x5391ae), bullet/ray filter
`FUN_00416830` (0x539547), add/remove from world `FUN_004cea10` /
`FUN_004cea20`, map-computer icon `FUN_00467d90` (0x53f582).

State tables: player movement graph 0x5385b4 (demo 0x53660c; state 33 =
0x538638), player weapon graph 0x538678 (demo 0x5366d0: S0 0x40e960, S1
0x40e9b0, S2 0x40ef60, S3 0x40f170, S4 0x40f230, S5 0x40f370, **S6
0x40f4a0**, S7 0x40f4f0, **S8 0x40f930**, S9 0x40fa60, S10 0x40fb30, S11
0x40fda0, S12 0x40f0d0), HumanSoldier body graph 0x53ec10 (demo 0x53cbc0;
state 36 = 0x53eca0), HumanSoldierRPG body graph 0x53e6a8 (demo 0x53c658).
Other full-exe equivalents: item use `FUN_00462e50` (demo FUN_00461a90),
gun core fire `FUN_00478ba0` (demo FUN_004772c0), explosion creator
`FUN_00480fe0` (demo FUN_0047f350, same 16-argument signature), player use
dispatch `FUN_0040cd30` (demo FUN_0040ce30), AI config copy 0x406fb8 (demo
FUN_00407080; HumanAI fields are shifted **+8** in the full exe: initial
movement delay ×30 → H+0x3d44, movement delay ×30 → H+0x3d48, targeting
timeout ×30 → H+0x3d50).

---

### 1. Instance counts per mission (objects.qvm) [observed]

| Level | StationaryGun | AIStationaryGunHolder | MineField | GunM16A2 task | GunSPAS12 task | HumanSoldierRPG | GuardGenerator |
|---|---|---|---|---|---|---|---|
| 1–3 | – | – | – | – | – | – | – |
| 4 | 1 | – | – | 6 (soldiers) | 5 (soldiers) | – | 4 |
| 5 | – | – | – | 1 (player) | 1 | – | 4 |
| 6 | 2 | – | – | 5 (soldiers) | 11 | – | 14 |
| 7 | 3 | – | 1 | – | 3 | – | 4 |
| 8 | 6 | – | – | – | 8 | – | 9 |
| 9 | 2 | – | 1 | 1 (player) | 12 | – | 6 |
| 10 | – | – | – | 1 (player) | – | 1 | 3 |
| 11 | 4 | – | – | – | 4 | – | – |
| 12 | 2 | – | – | – | – | – | – |
| 13 | – | – | – | 1 (player) | – | – | – |
| 14 | – | 9 | – | – | – | – | 38 |
| **Σ** | 20 | 9 | 2 | 14 | 44 | 1 | 82 |

`GunM16A2` / `GunSPAS12` objects.qvm tasks are weapon children of
HumanSoldier / HumanPlayer (schema `ID` EnumString32, `Slot` Int16). Any
M16A2 / SPAS12 built from weaponconfig (pickups, `DefineHumanPlayer…`)
also gets the class, because `FUN_00477c50` creates the weapon with the
weaponconfig "Weapon Task Type" (+0x6d8): TASKTYPE_GUNM16A2 /
TASKTYPE_GUNSPAS12 [recovered]. Many soldiers carry M16A2 / SPAS12 as a
plain `Gun` task (e.g. L14 SPAS soldiers, L12 M16A2 soldiers), which is the
base class; for SPAS12 that only changes the player-side reload (§6).
No `AIStationaryGun`, `M203`, `Missile` or `Mine` task is ever placed in
objects.qvm: they are created at run time.

---

### 2. StationaryGun (M2HB tripod gun, player and GUNNER use)

#### 2.1 Schema [observed objects.qvm L4+; offsets/defaults recovered `FUN_00473d30`, `FUN_00473ed0`]

`Task_DeclareParameters("StationaryGun", Position ObjectPos, Orientation
Real32x9, "Holder model" String16, "Weapon ID" String32, "Max up angle"
Degrees, "Max down angle" Degrees, "Max sideways angle" Degrees, Ammo
Int32)`.

| Field | Offset | Default |
|---|---|---|
| Position / base matrix | +0xf0 (double xyz) / +0x108 (3×3) | 0 / identity |
| Holder model | +0x1b0 | "" (data: 123_02_1 tripod) |
| Weapon ID | +0x1c0 | "WEAPON_ID_M2HB" |
| Max up / down / sideways | +0x1e0 / +0x1e4 / +0x1e8 (deg) | 25 / −25 / 90 |
| Ammo | +0x1ec | −1 (range 0..100000 declared, `DAT_005be380/384`) |
| run-time: pitch, yaw | +0x1f8, +0x1fc (rad) | 0 |
| kick pitch / yaw | +0x1f0, +0x1f4 | 0 |
| total pitch / yaw | +0x200, +0x204 | 0 |
| user (human) | +0x208 | 0 |
| attached gun slot | +0x20c | Gun task |
| tick stamp | +0x218 | −1 |
| in use | +0x21c (byte) | 0 |
| gun pose (pivot, matrix) | +0x170 (doubles), +0x188 | |
| platform-relative pose | +0x130, +0x148 | |

All 20 instances use holder 123_02_1, WEAPON_ID_M2HB, Ammo −1 except L7
#3301 (Ammo 10000). Examples: L4 #775 up 25 / down −25 / side 180; L8 #775
"tank main gate" 6 / −5 / 115; L8 #779 "ammo building" 12 / 0 / 90; L8
#778 "HQ gun 3" 25 / −60 / 180; L11/L12 #207–#209 25 / −25 / 60. Parents:
Buildings (L4 gun post, L6 Big Warehouse, L7 guard tower, L11 Barracks /
FortifiedGunpost, L12 Barracks) or Containers ("Fixed position guns",
"Stationary Guns").

#### 2.2 Methods [recovered `FUN_00473ed0`]

create 0x473d30 (defaults above), update `FUN_00474190`, destroy
`FUN_00474960`, compile 0x474980, use-point candidate `FUN_00474e30`,
use kind `FUN_00474ed0` (writes **6**), use start/continue `FUN_00474ee0`,
0x539546 → `FUN_00474f10` (`FUN_004871c0(human, human+0x434)`, purpose
unknown), 0x53954e → `FUN_00474f30`, schema `FUN_00474f50`, platform carry
(id 0x547f40) `FUN_00474f60`, method 6 = `FUN_004d3710`, sight filter
(0x54127c) `FUN_004752b0` (skips the gun and its user). Exported helpers:
`FUN_00475300` (type id), `FUN_00475310` GetPose (copies +0x170 pivot and
+0x188 gun matrix), `FUN_00475340` Release (`FUN_00465910(user arms)`
clears the view override, user = 0, in-use = 0), `FUN_00475370` IsInUse
(+0x21c).

**Compile** 0x474980: model = holder; base matrix → +0x70; resets angles,
kick, user, in-use; creates the weapon `FUN_00477c50(self, slot 0,
weaponconfig(Weapon ID), Ammo, 0)` attached at +0x20c; poses it
(`FUN_00474420`); `FUN_00474ae0` stores the pose relative to the nearest
parent of the model-object class (for carry by moving parents).

#### 2.3 Update `FUN_00474190` (once per application tick, stamp +0x218) [recovered]

- **Unmanned** (+0x208 = 0): pitch moves toward `maxDown·π/180` by
  **0.0872665 rad (5°) per tick** (f32 `DAT_0053387c`), no overshoot; yaw
  unchanged; then `FUN_00474360(self, fire = 0)` (sets kick to 0).
- **Manned**: pitch += user channel 1 (`+0x1b4`, look) × π; yaw −= user
  channel 0 (`+0x1b0`, turn) × π (f32 π `DAT_00533400`) — raw channels, no
  FOV-tangent scaling or averaging; clamp `FUN_004748b0`: pitch to
  [maxDown, maxUp]·π/180; yaw to ±maxSide·π/180 **only when
  maxSide·π/180 < 2π** (double `DAT_00533728`), no wrap; fire = user
  channel 6 (`+0x1c8`, Fire) ≠ 0; totals +0x200 = pitch + kickPitch,
  +0x204 = yaw + kickYaw; kick ×= 0.9 (`DAT_005335a8`); then
  `FUN_00474360(self, fire)`.
- `FUN_00474360`: builds a gun-use record {fire, …, +0x28 scale = user
  +0x4d4 (1.0 unmanned), +0x2c = user} and calls the attached Gun's use
  method; **+0x1f0 / +0x1f4 are overwritten** with the record's kick outputs
  (+0x20 / +0x24), which the Gun writes only when a round left (0
  otherwise). So recoil is a one-tick jitter on the tick after each shot,
  never cumulative.
- `FUN_00474420` pose: object matrix +0x70 = base combined with Rz(total
  yaw) (the holder model turns with the yaw); pivot P = origin + rotated
  magic vertex (index 1 if the model's +0x7c short > 0, else 0; 123_02_1 has
  one magic vertex (0, −3, 460) units); gun matrix = +0x70 ×
  Euler(total pitch, 0, **π**) (`FUN_004b38e0`), i.e. the barrel points
  along −col1 of the object; the gun is placed there (`FUN_004f2310`) and
  the pose kept at +0x170/+0x188. With a user: **eye = P + 0.2 m (819.2,
  f32 `DAT_00534134`) along gun col 2 − 0.5 m (2048, `DAT_00533688`) along
  gun col 1**, orientation = gun matrix, written to the user's view object
  as an override (`FUN_004658d0`: arms+0x13a = 1, +0x140 pos, +0x158
  matrix).
- Then children update. No heat, overheat, spin-up or reload logic exists
  anywhere in the class [recovered by absence in all registered methods].

#### 2.4 Firing (the attached Gun) [recovered `FUN_00479780`, `FUN_00478ba0`, 0x478640]

- Ammo: the Gun's clip +0x144 = the Ammo param. The Gun update replaces
  only the sentinel −2 by Rounds/Clip (0x478655); the fire code blocks when
  an ammo type exists and clip == 0, and decrements only when clip > 0.
  **Ammo −1 = endless**; L7 #3301 has 10000 rounds and then dry-fires
  (no reload path for a StationaryGun).
- M2HB weaponconfig [observed]: damage 1.0, penetration 3, muzzle 930,
  800 rpm → cooldown **2 ticks** (15 rounds/s), Rounds/Burst 10000,
  spread 0.4° for the first 4 rounds of a hold then 5° (`+0x140 < 4`
  test), kick fixed X 0.1°, random X 1°, random Z 1° (the random pair is a
  point in the unit disk, two level-RNG draws per try), sound loop
  `m2hb_loop` / end `m2hb_loop_e` (burst ≥ 2 path), casing 113_01_1 (only
  ejected for the player's own gun: `FUN_00416a70(0) == owner`, so never
  for a stationary gun), Gun Model 123_01_1, AI GUNSHOT 30 m, event team =
  user's team.
- Muzzle = gun magic vertex 2 (no record position) and direction = gun
  matrix col 1 (`FUN_00478ba0`), one GunShot per round.

#### 2.5 Player use (movement state 33) [recovered]

- Candidate test `FUN_00474e30` (called by the use search, demo
  FUN_0045fb20): only when not in use; P = magic-vertex point; the gun is a
  candidate when `(searcherPos − P) · col1(+0x70) ≥ 0` (behind the gun),
  then the usual angle/range ranking (`FUN_00416ad0`; docs/interactions.md
  §1). Use kind 6 → HUD icon a_gun.spr.
- Activate (S1 0x40ee64…0x40eed6) → `FUN_0040cd30(human, 6)`: used object
  (+0x7b4, `FUN_004636a0`) = target, +0x7bc = 0, state 33 (+0x2fc = 0x21),
  enter `FUN_0040c970`.
- **Enter `FUN_0040c970`**: pose (P, M) = `FUN_00444b30(gun)`; if
  `(human − P)·col1(M) < 0` M is turned by π (`FUN_004b3790`, cannot happen
  after the candidate test); human x/y = P + col1·**2867.2 (0.7 m)**
  (double `DAT_00533440`), z kept; heading = gamma(M) + π (faces the gun);
  arms mode 0 (`FUN_004137e0`), weapon holstered (`FUN_0040c140`), body
  clip **198** (`FUN_00489ea0`), view-object calls `FUN_00464720` /
  `FUN_00464700`, `FUN_004635f0`, attach (`FUN_00463310` → platform carry,
  E100), `FUN_00463590`, weapon inactive (+0x4d0 = 0). Tick 0x40cae0.
- Each tick the human's use step `FUN_00460ee0` re-calls the start/continue
  method with the use counter +0x7bc (then +1). `FUN_00474ee0` takes the
  user only when the counter is 0 and sets in-use every call.
- **Exit (tick 0x40cae0)**: Activate pressed (channel 9 `+0x1d4` ≠ 0 and
  previous `+0x134` = 0) or graph flag 0x20000 (death): weapon active,
  `FUN_0040c2d0` (unholster), `FUN_00464710`, `FUN_00463600`, Release,
  `FUN_00463620`, detach, `FUN_00463550`, `FUN_004635a0`, state 0. The
  player stays where he stood (0.7 m behind).
- Camera: `FUN_0045fcd0` fills the camera record from the override (eye,
  gun matrix) and sets **mode 4**; FOV = arms +0x1e4 (unzoomed 90°)
  (docs/interactions.md §10 for mode 4). The player body is carried by the
  gun's yaw through the attach (docs E099/E100).

#### 2.6 AI use: GUNNER [recovered]

- Script call `AIFunction_SetGunnerID(id)` → `FUN_0044e390` writes
  H+0x3ac8 (initial −1, 0x44f171); `GetGunnerID` `FUN_0044e4b0`;
  `GetGunnerStatus` `FUN_0044e5e0` = IsInUse of that gun (0 when unset;
  logs "StationaryGun ID #%d not defined" when the id is unknown).
- SetGunnerID calls in level AI scripts [observed, `readQvmLiteralCalls`]:
  L4 ai502 (SPETNAZ_GUARD_AK, never uses it) and ai516 (GUNNER) → #775;
  L6 ai506 → #200, ai507 → #201; L7 ai502 → #3301, ai507 → #3302, ai517 →
  #3303; L8 ai503 → #778, ai506 → #776, ai512 → #775, ai514 → #779, ai534 →
  #777, ai545 → #780; L9 ai511 → #351, ai516 → #352, ai510 → **#350 (no
  such task: "Stationary gun ID #%d not found")**. L11/L12 guns have no
  gunner (player-only). L8 GuardGenerator #658 "tank tower gunner 445"
  respawns a gunner.
- GUNNER combat start `FUN_0048d2c0` (tick `FUN_0048d340` "Gunner Combat -
  Stand", stop `FUN_0048d7d0`): counter data+0x1c = 30.
  Per tick: if the gun exists and is free or mine: aim point
  (`FUN_00451380`) − gun pivot (+0xf0), into the base frame (+0x108ᵀ),
  negated; vertical `FUN_004148f0` and horizontal `FUN_00414950` angles;
  **in arcs** when |h| < maxSide and maxDown < v < maxUp (rad).
  - Not on the gun (body state ≠ table[4] = 36): in arcs → count down 30
    ticks, then request 4 (channel 24) = float(gun id) → mount; out of arcs
    → count reset to 30. Meanwhile it fights as a guard with its own weapon
    (`FUN_0048d080`), or logs "No primary weapon" (H+0x3e00 = −1).
  - On the gun: in arcs → count = 30; out of arcs → count down, at 0 press
    request 0 (channel 20) and unregister as attacker. The soldier gun
    state's tick 0x45c9b0 only leaves on a fresh channel-24 press or death
    (0x20000), so this press **does not dismount** [recovered both sides;
    net effect inferred]. AI eye/view = GetPose (H+0x38 pos, H+0x78
    matrix). Target visible: if fewer than 4 attackers, start a fire
    sequence (`FUN_0048b9c0`) with sub-state 0x48d8b0 → fire tick
    `FUN_0048d8e0` (on the gun it fires the gun's weapon +0x20c by pressing
    channel 6, aim point smoothing × aim precision, 2° turn tolerance
    0x3d0efa35); else status 2. Not visible: count; > targeting timeout
    (H+0x3d50) → end combat; else turn toward the target.
  - The gun turns by the AI's channels 0/1 (yaw −= ch0·π, pitch += ch1·π);
    the AI turn writes clamp(error, ±limit)/π, so the gun follows the error
    exactly up to the limit.
  - With an endless gun (clip −1 never changes) the sequence round counter
    H+0x3e54 never decrements (`FUN_0048d8e0` decrements it only when the
    clip value changes): the gunner keeps firing while aimed and visible
    [inferred consequence].
- Soldier mount (`FUN_00459d50`, kind 6 → body state 36 = 0x24): entry
  `FUN_0045c8b0` = the player placement (0.7 m along col1, own z, heading
  gamma + π, no flip test), body clip **31** one-shot, attach; tick
  0x45c9b0 releases on channel-24 press / death (`FUN_00475340`).
- GUNNER settings [observed settings.qvm GD_1/2/3]: damage scale 0.3 / 0.5
  / 0.8, targeting timeout 15 / 20 / 30 s, hit p at max range 0.1 / 0.3 /
  0.5, aim precision 0.6, max rounds/sequence 50.

#### 2.7 Port notes (StationaryGun)

- New `StationaryGun` runtime object: fields of §2.1; update exactly as
  §2.3 at 30 Hz; pose = holder rotated by yaw, gun = Euler(pitch, 0, π);
  eye override (0.2 m up, 0.5 m back) → camera mode 4 with 90° FOV.
- Player: kind-6 use (already listed in `player/use-objects.ts`); state
  33 placement 0.7 m behind P, body clip 198, holster, attach to the gun
  (`PLATFORM_TASK_TYPES` already includes StationaryGun); exit on Activate
  press. Feed the gun from the player's channels 0/1/6 (turn/look/fire),
  not from the normal look code.
- Fire through the normal Gun (cooldown 2, spread 0.4°/5°, kick jitter,
  `m2hb_loop`); Ammo −1 → no decrement. No overheat.
- GUNNER: implement §2.6; `human-ai.ts` currently returns 0 for
  `GetGunnerStatus` — return IsInUse of H+0x3ac8's gun.

---

### 3. AIStationaryGunHolder / AIStationaryGun (L14 ceiling sentry turrets)

#### 3.1 Holder schema and instances [observed L14; recovered 0x46e210, 0x46e7f0]

`AIStationaryGunHolder(Position ObjectPos, Orientation Real32x9, "Holder
model" String16, "Viewcone Alpha" Degrees, "Viewcone Gamma" Degrees,
"Viewcone Length" Real32, "On expression" VarString, "Team expression"
VarString)`. Offsets: pos +0x2598, matrix +0x25b0, model +0x25d8, alpha
+0x25e8 (default 360), gamma +0x25ec (360), length +0x25f0 (10 m), On
+0x25f4, Team +0x2644, team value +0x2694 (default 1), isOn +0x2698,
detector +0x168.

L14 (9, holder model 456_11_1, cone 360°/360°): four "Gun fires at Jones
running" in ConditionalContainers 3001/3002 (cut-scenes; On =
ConditionalContainer_300x.isRun or `CutScene_1102.nTick <
2.5*GAME_FREQUENCY`, Team "0", length 20/100 m; their target "Main
character" is a HumanSoldier with model 000_01_1 and Team 1), and #2500
"Inside Room", #2501–#2504 "Generator Room" (On `EditVariable_1451.nValue
== 2`, Team `!Terminal_301.isHacked`, length 50 m): hacking Terminal_301
switches the turrets to team 0, so they then shoot the team-1 soldiers.

#### 3.2 Turret definition (magicobj.qvm) [observed; reader `FUN_0046fa50` recovered]

`DefineMagicObj(model, model, TASKTYPE_AISTATIONARYGUN, gunModel,
maxSide°, maxUp°, maxDown°, ammo, pitchSpeed°/s, yawSpeed°/s, sound,
spin°/s, minRange m)` → def +0x00 gun model, +0x28 maxSide rad, +0x20 maxUp
rad, +0x24 maxDown rad, +0x2c ammo, +0x30 pitch step rad/tick (×π/180/30),
+0x34 yaw step, +0x38 sound, +0x58 spin step, +0x5c minRange ×4096.

| Def | Gun model → weapon (`FUN_00413c00` matches weaponconfig "Gun Model") | Values |
|---|---|---|
| 456_12_1 (ATTA of 456_11_1 at (−18, 48, −1275)) | 456_13_1 → WEAPON_ID_SENTRY: damage 0.05, 1000 rpm (cooldown **1 tick**), spread ±15°, muzzle 930 | side 361°, up −10°, down −90°, 10000 rounds, 60°/s both, `tank_turret`, spin 45°/s, min range 0.2 m |
| 700_11_1 (MIL heli) | 700_12_1 → WEAPON_ID_MIL | 135, 5, −90, 10000, 50, 50, 0, 6 m |
| 614_10_1 | 123_01_1 → M2HB | 360, 45, −20, 10000, 30, 30, 0, 6 |
| 601_02_1 (APC) | 601_05_1 → WEAPON_ID_APC (TASKTYPE_MISSILE, 12 rpm) | 361, 75, −8, 10000, 30, 30, 0, 6 |
| 614_02_1 (T80) | 614_03_1 → WEAPON_ID_T80 (TASKTYPE_MISSILE) | 361, 15, −4, 10000, 15, 15, 0, 6 |

The holder's compile `FUN_0046e7f0` builds its model children through
`FUN_004e0930(0, holder)`; that the ATTA 456_12_1 becomes the
AIStationaryGun is [inferred] from the model + magicobj definitions. The
gun create `FUN_0046eae0` stores holder (+0x130), def (+0x1b8), creates the
weapon `FUN_00477c50(self, 0, weapon, def ammo, 0)` at +0x1c4.

#### 3.3 Holder update 0x46e5b0 [recovered]

team = ROUND(Team expr); isOn = ROUND(On expr). Off: when it was on,
the detector is reset (`FUN_00489b90`, `FUN_004896c0(det, 1, 4,
FUN_00464250(4, 8))`). On: the detector frame = holder pose, and
`FUN_00489750(det, frame, self, team)` runs on the detector's phase ticks
(`(tick & 3) == phase`; phase from the shared counter at compile, docs
E130): every registry object except self with a matching class gets a
slot; an object of **another team** is tracked (enemy list det+0x18) when
the detector flags (4) match its alive flag; same team objects need flags
& 3 = 0 → ignored. Cone test + sight ray as for soldiers (cone alpha /
gamma / length of the holder; 360° = everything within length).

#### 3.4 AIStationaryGun update 0x46f390 [recovered]

1. Target = the first slot in the holder's enemy list with "visible"
   (+0x29) and an object; local = holderMatrixᵀ (objectPos − turretPos);
   yaw = `FUN_00414950` (horizontal), pitch = angle between local and its
   horizontal projection, negative below.
2. Lost target memory: when a target disappears, the last angles are kept
   for **90 ticks** (+0x1d4 = 0x5a).
3. maxSide > 2π: if |targetYaw − yaw| > π then targetYaw += 2π (one-way
   unwrap).
4. pitch (+0x1bc) and yaw (+0x1c0) slew toward the target by def+0x30 /
   +0x34 per tick; clamp `FUN_0046f9d0` (pitch [maxDown, maxUp], yaw ±maxSide
   when < 2π).
5. Fire `FUN_0046f950(gun, f)`: f = 1 when a target exists, |Δpitch| <
   5° and |Δyaw| < 5° (`DAT_0053387c`) and dist² > minRange²; then the
   barrel spin +0x1e4 += def+0x58. Otherwise f = 0. The Gun's own cooldown
   / burst rules apply (sentry: 1 tick, burst 10000).
6. Turning sound: loop def sound at the turret while the remaining error to
   the clamped target exceeds 2° (`DAT_00533834`), else stop it.

#### 3.5 Port notes

Holder = a detector (reuse the SCamera / soldier perception code with
team-from-expression and enemy = alive, team ≠ turret team) + one turret;
turret = §3.4 at 30 Hz, muzzle = gun magic vertex 2 (456_13_1:
(−4, 6916, −19)), flame ATTA 1000_01_1. Only L14 needs it.

---

### 4. MineField

#### 4.1 Schema and defaults [observed; recovered `FUN_0043a840`, `FUN_0043ab50`]

`MineField(Position ObjectPos, Explode VarString, "Explosion radius
(meter)" Real32 [0,100] def 3, "Explosion falloff radius (meter)" Real32
[0,100] def 1.5, "Explosion damage scale" Real32 [0,10] def 3, "Explosion
delay (seconds)" Real32 [0,60] def 0, "Explosion fragments" Int32 [0,1000]
def 3, "Explosion fireballs" Int32 [0,100] def 3, "Explosion sound"
String16, "Explode close to task ID" Int32 [−1,4096] def 0, "Explosion delay
between explosions (seconds) -1: explode once" Real32 [−1,10000] def 5,
"Snap explosion to ground" bool8 def 1)`. Offsets: +0x20 pos, +0x38
expression, +0x88 radius, +0x8c falloff, +0x90 damage, +0x94 delay, +0x98
fragments, +0x9c fireballs, +0xa0 sound, +0xc0 task id, +0xc4 repeat
delay, +0xc8 snap, +0xcc timer.

#### 4.2 Instances [observed]

| Level | Task | Explode | Values |
|---|---|---|---|
| L7 | MineField #−1 in "minefield tasks" | `(AreaActivate_151/152/153/154/155/156/157/159/161/162/163/168/176/186.nActive …) && !HumanPlayer_0.isDead` | 3 m, falloff 1.5 m, damage 4.5, delay 0, 3 fragments, 3 fireballs, sound **"explo_m_02"** (no such sample is named elsewhere; the other level uses explo_02_m), task 0, repeat 5 s, snap |
| L9 | MineField #158 in "Area Activates" | `AreaActivate_157.nActive && !HumanPlayer_0.isDead` | same, sound explo_02_m |

Trigger areas are ordinary AreaActivate boxes with CRITERIA_HUMAN0 (player
only), e.g. L7 #151 at (−7270610, 90283400, 174777104) dims 769621 × 791234
× 284573 units, #161 4114094 × 545808 × 270160, #186 80000 × 135502 × 60000;
L9 #157 at (23168492, −51752124, 174727504) dims 1750795 × 681804 ×
963836.

#### 4.3 Behaviour [recovered `FUN_0043abc0`, `FUN_0043ac40`]

- Update: timer +0xcc: −1 → nothing; > 0 → timer − 1, nothing else; 0 →
  when the expression is valid and evaluates ≠ 0: explode, then timer =
  ROUND(repeat × 30) (5 s → 150 ticks). "−1: explode once" gives −30, a
  negative timer that never reaches 0 or −1 again: one explosion [recovered
  arithmetic].
- Explode: **the centre is the task named by "Explode close to task ID"**,
  not the MineField's Position: `FUN_004f1030(id)`, its position record
  through method 7 (table 0xa994e0); with snap, `FUN_004149b0` casts a ray
  1638400 units (400 m) down, else up, and takes the hit z. Missing task →
  no explosion. Both levels use id 0 = HumanPlayer_0: **the explosion
  happens at the player's feet** every 5 s while he is in any trigger box.
- Explosion: `FUN_00480fe0(centre, count 1, interval ROUND(delay×30) = 0,
  damage 4.5, radius 3 m×4096, falloff 1.5 m×4096, scorch size 6144, 3
  fragments, 3 fireballs, scorch target none (no decal), "1009_01_1",
  sound, aiType −1 (no AI event), 0, 102400, source 0)`.
- Damage to the player (docs/damage.md §3 Humans): factor 1 inside
  radius + body radius/3, 4.5 × zone-13 × difficulty (0.75/1/1.25) ≫ the
  player's limit → lethal [inferred]; knock-back, ear ringing, shake as for
  any explosion. The MineField's Position is never read by its methods.

#### 4.4 Port notes

Implement as a mission object: evaluate the expression each tick, timer as
above, explosion through the existing explosion pipeline at the target
task's position snapped to ground. No mines are rendered.

---

### 5. GunM16A2 and the M203 grenade launcher

#### 5.1 Class [recovered `FUN_004733f0`]

GunM16A2 = Gun + create 0x4734d0 (Gun create, Weapon ID "WEAPON_ID_M16A2"),
destroy `FUN_004754a0`, use `FUN_00473510`, HUD 0x473620, DefineWeaponType
extra-args reader `FUN_00473790` (weapon.qvm args 85, 3, 1 [observed]),
extra size 0x1c (`FUN_004737e0`), weaponconfig tag reader
`FUN_004737f0`: frees wc+0x6e4, allocates {muzzle km/h, explosion radius m,
activate radius, model[16]} with defaults **270, 5, 1, "108_05_1"**
overridden by TagItems. weaponconfig.qvm tags [observed]: 270 km/h, 5 m,
1, 108_05_1. M16A2 weaponconfig: damage 0.3, 500 rpm (cooldown 3),
clip 20, burst 20, spread 3°/10°, FireAnim2 = arms clip **39** (1.4667 s,
44 ticks; trigger 1053 `m16_g_reload_1` at 0.5 s [observed 005.iff,
animtrigger.qvm]).

#### 5.2 Player state S6 [recovered]

- S1 (0x40ec96…): AlternateFire held (pre-tick flag 0x400; Fire not held,
  docs/weapons-view.md §2) and the hand weapon's id (wc+0) ==
  WEAPON_ID_M16A2: with UnlimitedAmmo (`DAT_0056e214`) → S6; else the
  AMMO_ID_M203 record in the inventory (+0x340, `FUN_0047cee0`): pool > 0 →
  **pool − 1 (0x40ed08)** → S6; else fall through (reload / peek …). Works
  with an empty M16 clip. (Same branch: WEAPON_ID_PROXIMITYMINE → +0x4d2
  = 1, S8.)
- S6 enter 0x40f4a0: alt-request +0x4d2 = 1; arms play wc FireAnim2
  (+0x688) with no loop, no blend (`FUN_004d61d0`); tick 0x40fd70: clip-end
  flag → S1. Holding AlternateFire re-enters S6 from S1, so a held button
  launches about every 45 ticks (44-tick clip + 1) while rounds remain
  [inferred from the tick structure].
- The same tick, item use `FUN_00462e50` (after the state machines)
  builds the use record (+0x18 = +0x4d2, +0x04 = eye from the view object,
  +0x08 = view matrix) and clears +0x4d2.
- Soldiers never set +0x4d2 (writers: 0x40ed21, 0x40f4c0 only; cleared at
  0x45ebb3, 0x463034) → **soldiers' M16A2 never launch grenades**.

#### 5.3 Launch `FUN_00473510` [recovered]

Base Gun use first (no round unless Fire was requested; it sets muzzle
+0x150 = record eye and dir +0x168 = view col 1). If record +0x18:
velocity = dir × km/h × 4096000 × 9.259259e−6 (f32 `DAT_005334a4`,
`DAT_005334a0`) = **10240 units/tick = 75 m/s**; sound `m203_launch_1` at
+0x150 (`FUN_004e6b00`, `FUN_004e6c30`); `FUN_00476670(Dynamic, gun,
owner, pos = eye, matrix = basis of dir (`FUN_00414a60`), velocity,
model "108_05_1", explosionRadius 5, activateRadius 1)`. No view kick, no
spread, no AI GUNSHOT event, no casing.

#### 5.4 M203 projectile (class "M203", TASKTYPE_M203) [recovered 0x4761b0, 0x476340, `FUN_00476600`, `FUN_00476670`]

- Fields: +0xf0 position (double), +0x70 matrix, +0x108 velocity (f32),
  +0x114 gun handle, +0x118 owner handle, +0x120 explosion radius, +0x124
  "activate radius", +0x11c smoke particle system (smoke1.spr, created in
  create: colour 127, size 614.4, 819200.0, flags 0x1000008, 0.1, 20).
- Update, per tick: vx ×= 0.995, vy ×= 0.995, **vz = (vz − 35.68071) ×
  0.995** (f32 `DAT_00533790`, `DAT_00534140` = 7.84 m/s²); position += v;
  ray old → new position (`FUN_004cc2a0`, filter method 0x539547 =
  `LAB_00416a90` with record {self, gun, owner, 1.0}: ignores its gun and
  shooter). Hit → explosion and delete; else model moved and one smoke
  particle emitted (`FUN_004fe120`: speed (0.75 r + 0.15) × 37.93, size
  (r + 1) × 0.35, angle ((r − 0.5) × 2) × 0.05236 + 0.0128; **3 level-RNG
  draws per tick**). No lifetime limit, no arming distance.
- Explosion `FUN_00480fe0(hit point [inferred from the ray record], 1, 1,
  damage = +0x124 (**the "Activate radius" tag, 1.0**), radius = +0x120 ×
  4096 (5 m), falloff 0, scorch 4096, 3 fragments, 1 fireball, scorch
  target = the hit object, "1009_01_1", **"explo_proxy"**, AI 21 EXPLOSION,
  flags 2, range 102400 (25 m), source 0)` (argument order verified at
  0x47644f–0x47649b). Falloff 0 makes the damage binary: 1.0 to every
  damage-list object within 5 m + its target radius, else 0. Source 0 →
  cars ignore it (their handler needs weapon id 12, docs/damage.md).
- Example ballistics from 1.6 m eye height [derived]: level shot hits the
  ground after 20 ticks at 47.5 m; 10° up: 96 ticks, 187 m, apex 10.7 m;
  30° up: 242 ticks, 303 m (max range ≈ 30–35°).

#### 5.5 Ammo, HUD [observed / recovered]

AMMO_ID_M203 = DefineAmmoType(8, …, calibre 10002, pickup model 108_05_1).
Player start pools (HumanPlayer children GunM16A2 + AddAmmo): L5 3, L9 5,
L10 5, L13 2. Pickups (AmmoPickup AMMO_ID_M203): L2 6 × 1 (+ GunPickup
M16A2), L9 1 × 10, L11 3 × 1 (+ M16A2), L13 3 × 1, L14 1 × 2 + 1 × 5 (+
M16A2). HUD `FUN_00473620`: after the base Gun panel (0x479d20) the
AMMO_ID_M203 count is printed "%-4d", right-aligned left of the clip
graphic, then M16_alternative.spr 8 px (`DAT_00534114`) further left
(docs/hud.md §13; port `Hud.setM203Rounds`, already wired in game.ts).

#### 5.6 Port notes

Add S6 to `combat/weapon.ts` (S1 branch, pool decrement at entry,
FireAnim2 one-shot, back to S1 at clip end), the launch in the GunM16A2
use, and an `M203` projectile (velocity update order above, ray per tick
with the gun/owner ignore list, binary 5 m explosion of damage 1 with
explo_proxy and 3 RNG draws per flight tick for the smoke). UnlimitedAmmo:
S6 without pool.

---

### 6. GunSPAS12

#### 6.1 Class [recovered `FUN_00472a70`]

Only two overrides: create 0x472ca0 (Gun create, id "WEAPON_ID_SPAS12")
and the **reload method** (0x53f315) `FUN_00472ae0`. Fire, HUD, kick are
the base Gun's.

#### 6.2 Fire [recovered `FUN_00478ba0`; weaponconfig observed]

- Weaponconfig: SHOTGUN, calibre 12 (AMMO_ID_12), damage **0.25 per
  pellet**, penetration 1, muzzle 600, **Bullets/Round 30**, 40 rpm →
  cooldown **45 ticks**, clip 7, burst 1 (one round per trigger pull; the
  burst counter +0x140 resets when Fire is released), spread min = max =
  40° (weapon.qvm says 20; weaponconfig wins), kick fixed X 11°, no random
  kick, Fire sound `spas12_shot_1` (single-shot path, 50/50 pick between
  the two equal samples: 1 RNG draw), casing 109_03_1, AI GUNSHOT 30 m.
- Per round: for each of the 30 pellets, 4 level-RNG draws: tilt = r1·r2·r3
  × 40° (density concentrated at the centre, mean 5°), roll = r4 × 2π; the
  aim matrix is rotated by `FUN_004b38e0(tilt, roll, 0)` and one GunShot is
  spawned (`FUN_00413d10`). Then the casing (player only), cooldown, clip −
  1, kick (2 draws per unit-disk try).
- Player arms: FireAnim1 = clip **60** (43 ticks) with the pump sounds
  `spas12_reload_1` at 0.433 s and `spas12_reload_2` at 0.667 s (anim
  triggers 1019/1020) — the pump is part of the fire clip; the cooldown (45)
  outlasts it.

#### 6.3 Shell-by-shell reload (player only) [recovered `FUN_00472ae0`, S3 0x40f180]

The player's S3 calls the gun's reload method every tick with a record
{human, …, +0x20 done flag, +0x21 UnlimitedAmmo}; S3 ends (S1, weapon
active) when the flag is set; nothing interrupts it. The SPAS12 method
(state +0x1ac):
- state 0: no AMMO_ID_12 record or pool 0 → done at once; else play arms
  clip **61** with a 0.4 s blend (12-tick fade; `FUN_00489f20` = arms
  layer 0), state 1;
- state 1: arms clip end → clip **62**, state 2;
- state 2: on clip end: if clip ≠ Rounds/Clip (7) and pool > 0 → pool −
  1, clip + 1, and if it was not the last missing shell → clip 62 again;
  otherwise → clip **63**, state 3 (a pool that empties mid-reload costs
  one extra empty 62 cycle);
- state 3: clip end → done, state 0.
Clips [observed 005.iff]: 61 = 19 ticks (`spas12_bulins_1` at 0.033 s,
`_2` at 0.633 s), 62 = 10 ticks (`spas12_bulins_3` at 0.133 s), 63 = 43 ticks
(`spas12_bulins_4`, `spas12_reload_1`, `spas12_reload_2`: the closing
pump). Reloading k shells ≈ 1 + 19 + 10 k + 43 ticks (1 shell ≈ 73 ticks,
7 ≈ 133). UnlimitedAmmo is ignored by this method (it reads the pool only).
The method is called only by the player's S3 (callers of 0x460c10:
0x40f1c7 plus class registrations/forwarders); **soldiers reload through
their body state graph**, whose reload state refills the clip at its end
(`FUN_004f2350(gun, 1)`, seen in the RPG graph's state 9; assumed the same
for HumanSoldier [inferred]) or through the AI's instant refill, so a
soldier's SPAS12 reload is the ordinary one.

#### 6.4 Users [observed]

Soldier types AITYPE_*_SPAS (GUARD/PATROL/SECURITY_PATROL/MAFIA/SPETNAZ),
44 GunSPAS12 tasks plus Gun-class SPAS soldiers (L3, L6, L14); player
pickups: L11 GunPickup SPAS12; AMMO_ID_12 pickups L6 2 × 9, L11 7 + 8,
L13 32, L14 2 × 12.

#### 6.5 Port notes

Pellet loop with the exact draw order; per-weapon reload strategy: SPAS12
player reload replaces the generic S3 phases with the 61/62/63 sequence
and per-shell transfer; soldier reload unchanged.

---

### 7. HumanSoldierRPG and the RPG rocket

#### 7.1 Class and instance [recovered `FUN_00456ad0`, `FUN_00456c70`; observed L10]

Schema identical to HumanSoldier: `Position, Gamma Angle, Model String16,
Team Int32, "Bone Heirachy" Int32, "Stand Animation" Int32` (defaults
+0xcf8 = **2**, +0xcfc = **2**; +0xd00 walking flag = 1). One instance:
L10 #431 "RPG Guard" (model 013_01_1, team 1, skeleton 2, stand clip 2)
with Gun WEAPON_ID_RPG18 and HumanAI #531 AITYPE_RPG, graph 8, inside
ConditionalContainer #361 "2 storey reinforcments w/rpg guard" (condition
`GuardGenerator_700.nSpawns == 2 && GuardGenerator_701.nSpawns == 2 &&
GuardGenerator_702.nSpawns == 2 || this.isRun`) together with three
PATROL_AK reinforcements.

Methods: update 0x454ee0 (Human base), input/tick (id 0x54e1da)
0x456fb0 → `FUN_00456ff0` (channels copied unless +0x250, graph run
`FUN_004ec1e0`, ch 20 toggles walking, flinch bit cleared, turn, move or
attached move, view, gun use `FUN_00462e50`), compile 0x456e50 (skeleton
from +0xcf8, stand clip), bullet hit `FUN_004572d0` (0x539549), explosion
hit `FUN_00457430` (0x53954b), melee `FUN_00457620` (0x53f317), zone
records 0x53e798 of {multiplier, flinch clip, death clip, death clip}
(multipliers cycle 0.5 / 0.75 / 1.0 over the first 10 records read, every
record has flinch 13 and deaths 15 / 15; head multiplier per
docs/gameplay.md), action table 0x53e720 (12 {clip, loop} pairs). Bullet
hit: damage × zone multiplier (zones 15/16 unscaled when AI +0x3abd),
accumulated; at the limit (+0x258): death type +0xd08 = 1 for a SHOTGUN
(WEAPONTYPE 2) else 2, flag 0x20000; else flinch 0x10000 + `ai_hit_`;
always posts AI event 15 (TAKINGDAMAGE). Explosion hit: factor with
radius +0xa0 / 3, × zone-13 multiplier; death type 0 or flinch +
`ai_xplhit_`.

#### 7.2 Body graph (15 states, skeleton 2 / 002.iff) [recovered entries 0x455990…0x456960, ticks; clips observed]

Pre-update `FUN_00456cf0` bits: 1 clip end, 2 anim event, 4 grounded
(kept), 0x10000 flinch, 0x20000 death, 0x40000 walking flag, 0x20/0x40/
0x80/0x100 channels 2/3/4/5, 0x200 ch 6 Fire, 0x400 ch 7, 0x800 ch 8
Reload, 0x1000 ch 9, 0x80000 ch 21 (kneel request), 0x100000 ch 22
(scripted anim, id → +0xd04). Most ticks first test: not grounded → 11,
flinch → 12, death → 13; the ticks of states 5, 6 / 12 and 11 skip the
flinch test; state 13's tick tests nothing.

| St | Clip (loop) | Meaning | Transitions |
|---|---|---|---|
| 0 | Stand Animation or 2 (3.27 s) | stand idle | Fire → 4; Reload or ch21 → 5; ch22 → 14; forward → 1 (run) / 2 (walking flag) |
| 1 | 3 (L) 0.70 s, 2.87 m/s | run | Fire 4, Reload/ch21 5, walking → 2, no forward → 0 |
| 2 | 4 (L) 1.10 s, 1.16 m/s | walk (phase carried from 1) | Fire 4, Reload/ch21 5, not walking → 1, no forward → 0 |
| 4 | 5 1.03 s | shoulder the launcher (standing) | end → 3 |
| 3 | 6 (L) 1.03 s, crouch flag 1 | standing aim/fire hold: Fire held → fire request every tick | clip end without Fire → 0 |
| 5 | 7 0.50 s | stand → kneel | end → 7 |
| 7 | 8 0.50 s, crouch flag 1 | kneel idle | Fire → 10; Reload → 9; ch21 and bit 0x10 off → **0 directly** |
| 10 | 10 1.03 s | kneel shoulder | end → 8 |
| 8 | 11 (L) 1.03 s | kneel aim/fire hold, fire request while Fire | clip end without Fire → 7 |
| 9 | 19 4.77 s (143 ticks) | kneel reload | end → `FUN_004f2350(gun, 1)` (clip refilled, pool untouched) → 7 |
| 6 | 9 0.83 s | kneel → stand | never entered (no transition leads here) |
| 11 | 2 (L) | falling | grounded → landing sound → 0 |
| 12 | zone clip 13 (3.67 s) | flinch | end → 0 |
| 13 | death: AI override (H+0x3ad0) else by death type +0xd08: bullets (shotgun 1, other 2): 2 → zone table (15) or {14, 12}[rand 2]; < 2 / explosion 0 → `FUN_0045daa0` → 16 or 15 | death: gun dropped, `ai_death_`, push; end → +0x33c (anim finished) | |
| 14 | scripted (+0xd04) | animation | any input bit or id −1 → 0 |

AI request map for AITYPE_RPG (table 0x54138c): 0 → ch 20, 1 → ch 21
(kneel), 3 → ch 22, 6 → ch 23 (aim; not read by this graph), 4/5/7/8/9
none (no stationary gun, panic, weapon change, grenade, close combat).
State map (0x541590): stand 0, kneel 7, animation 14.

#### 7.3 RPG combat [recovered `FUN_0048cb40`, stand `FUN_0048cbd0`, kneel `FUN_0048cdf0`]

- Start: stand or kneel tick by the crouch flag; stop `FUN_0048d7d0`;
  timer H+0x3dd4 = initial movement delay×30 (set again to movement
  delay×30 whenever the target is seen; never consumed here); registers as
  attacker of the event's other object.
- Each tick (both stances): common target refresh `FUN_0048a920`; no target
  slot → end. If no sub-state: (kneel tick requests kneel, ch 21 = 1.0) once
  the body is in the stance: not visible → count; > targeting timeout
  (H+0x3d50; RPG 10 s for all difficulties) → end; target outside the cone
  → "Turning to target" (2°). Clip empty and last action ≠ reload →
  Reload sub-state `LAB_0048dd10` via `FUN_0048ae70(ai, data, fn, sub)`
  (sets the sub-state and, from the stand tick, runs the kneel tick once
  at once; the combat tick itself is not switched). The sub-state requests
  kneel every tick; once kneeling with an empty clip it presses ch 8
  (H+0x3c94 = 1.0) when the toggle H+0x3df1 is set, else refills at once
  (`FUN_004f2350(gun, 1)`); a loaded clip in kneel flips H+0x3df1 and ends
  it, so reloads alternate between the animated (state 9) and the instant
  refill [recovered; alternation inferred]. Afterwards the body stands up
  by itself (state 7 → 0 when ch 21 is released). last = 1. After a shot (last = 0):
  rand < **0.4** (`DAT_005335d4`) → switch stand ↔ kneel, last = 2. Visible →
  aim point, fire sequence (`FUN_0048b9c0`, first sequence halves the hit
  probability), sub-state stand 0x48d8b0 / kneel 0x48dcd0 → fire tick
  `FUN_0048d8e0`, last = 0. Weapon kind 5 in stand → close combat request 9
  (none for RPG).
- RPG settings [observed]: hit p 1.0 at min range → 0.25 at max, aim
  precision 0.2, shot delay 0.1 s; rounds per sequence = 1 (clip 1).

#### 7.4 RPG18 and the Missile [recovered `FUN_004298a0`, `FUN_00429a30`, 0x428390, `FUN_00428d00`, `FUN_00429730`; observed data]

- Weaponconfig "LAW 80" (WEAPON_ID_RPG18, id 12): TASKTYPE_GUN, calibre 1000
  (AMMO_ID_1000), Muzzle Velocity **5**, 40 rpm (45 ticks), clip 1, burst
  1, spread 0, kick 10°, FireAnim1 57 (33 ticks), no reload anim,
  `rpg_launch_1`, projectile TASKTYPE_MISSILE, tag "Missile - Model"
  110_02_1. The damage factor 0.25 is unused by the rocket.
- Spawn (projectile method `FUN_004298a0`): `FUN_00429a30(Dynamic, gun,
  owner, muzzle, aim matrix, muzzle velocity, 0, 0, model, weaponconfig)`:
  type = DefinePhysicsObjType of the model; velocity = aim col1 × 5 ×
  136.533 (`DAT_00533680`) = **682.7 units/tick (5 m/s)**; fuel +0x864 =
  type +0x120; throttle = target = 1.0; direct type: aim point = muzzle +
  dir × 4096000; source +0x894 = weaponconfig (cars check its id 12).
- Missile type physicsobj/missiles/RPG18 [observed + layout
  docs/vehicles.md §3]: mass 10, box 0.4 × 5 × 0.4 m, 1 contact point
  (magic vertex 0, grips 1/1), rest 0.7 / 0.001, cfg = 200, 5, 0.8, 5, 0.8,
  5, 0.8, **200 (thrust)**, 0.027, 0.003; 4 drag elements: {1, (0, 4, 0) m,
  n (0, 0, 1)}, {1, (0, 4, 0) m, n (1, 0, 0)}, two zero; tail (reader
  `FUN_00429730`): smoke NORMAL, MISSILE_TYPE_MISSILE_DIRECT, fuel **4**,
  burn 1 × 1/30 per tick (4 s), 50, 0.25 m, 0.5 m, 1, 1, "smoke2.spr",
  sound "radarwind_1".
- Flight per tick (update 0x428390): guidance by type (direct
  `FUN_00428910`: steering 0 = no guidance); smoke particles while fuel >
  0 (`FUN_00428630`); `FUN_00428d00`: throttle ramp (cfg step 0.027 above
  0.7, 0.003 below), control smoothing 0.8, yaw/pitch rates ≤ 5°/tick;
  with fuel = 0 a random tumble Euler((0.5 − r)·0.1, (0.7 − r)·0.1, (0.3 −
  r)·0.1) rad per tick; thrust force (0, 200 × throttle × 44.600887, 0) in
  the body frame while fuel and throttle ≠ 0; fuel −= 1/30; then the
  Vehicle rigid-body step `FUN_004fc0e0(g 44.600887, linear 0.95, angular
  0.92)` with the gun/owner ignore filter; flat-plate drag 0.000327. All
  missile random draws use the missile generator **`DAT_0057bc88`**, not
  the level RNG. Net: v ← 0.95 (v + 892) → ≈ 124 m/s after the 4-s burn
  [derived].
- No contact: every 32 frames a ray 1000 m down; nothing below → delete.
  Contact (+0x1b8): ray 3 m down for the scorch target, then
  `FUN_00480fe0(pos, 1, 1, damage **5.0**, radius 2.5 m, falloff 1.75 m,
  scorch 1.5 m, 10 fragments, 5 fireballs, hit, "1009_01_1",
  **"explo_03_l"**, AI 21, flags 2, 102400, source weaponconfig)`, delete.
- The player's RPG18 (GunPickups L6 2, L7 1, L8 2, L10 2, L14 1) uses the
  same Missile.

#### 7.5 Port notes

Add a `HumanSoldierRPG` body graph (table above, skeleton 2 clips) next to
`ai/soldier-graph.ts`; RPG combat as §7.3; Missile as a Vehicle-physics
body (reuse the port's vehicle rigid body: thrust, damping, drag elements,
contact) with its own RNG stream, or as a first approximation a straight
thrusting projectile with v ← 0.95 (v + 892) and gravity 44.6 until
contact, explosion 5 / 2.5 m / 1.75 m.

---

### 8. GuardGenerator

#### 8.1 Schema and members [observed; recovered `FUN_00487be0`, `FUN_00487eb0`, 0x488430]

`GuardGenerator("Generate guards" VarString, "Max spawns" Int32)`; +0x20
expression, +0x70 isOn, +0x71 members registered, +0x72 isSpawned, +0x74
nSpawns, +0x78 Max spawns, +0x7c template. Script members
`<name>.isOn`, `<name>.isSpawned` (bytes) and `<name>.nSpawns` (int)
(e.g. `GuardGenerator_828.isOn`, `GuardGenerator_700.nSpawns == 2`).

#### 8.2 Behaviour [recovered]

- **Compile** `FUN_00488200` → `FUN_00488220`: every child subtree is
  serialised into a template (each task's declared parameters copied
  through its schema) and **the children are deleted**: at level start no
  generated soldier exists.
- **Update** `FUN_00487ee0` each tick (before the children):
  1. isOn = (byte)ROUND(expression) when the expression is valid.
  2. isOn = 0: when the generator has no child, isSpawned = 0 (a living
     soldier is never removed).
  3. isOn ≠ 0 and nSpawns < Max spawns: no child → spawn; else if the child
     is dead (human +0xcf5) and out of the world (+0xcf6 = 0) → delete it
     and spawn. Each spawn: isSpawned = 1, nSpawns + 1. Max spawns counts
     the first spawn.
  4. Children update.
- **Spawn** `FUN_00488000`: instantiate the template under the generator
  (`FUN_00488040`) and run compile on it (record 1): same Position, Gamma,
  Model, Team, Gun(s), HumanAI (type, graph, script) as written; the HumanAI
  compile takes the next shared perception phase.
- **Corpse removal** (HumanAI update 0x44fa8f–0x44fb7f): for a dead
  soldier in the world whose death clip has finished (+0x33c, set by the
  death state's end tick 0x45c740): AI cleanup, then the countdown H+0x3e10
  (= H+0x3d40, set to **300** at AI init 0x44f25a) decrements per tick;
  once negative the body is removed from the world (method 0x548177)
  **unconditionally when the soldier's parent is a GuardGenerator**
  (`FUN_00488610` returns its type); other soldiers only when H+0x7c4 = −1
  or more than 1 tick has passed since H+0x7c4 (stamped in the draw path
  0x45f2bf when `FUN_004d06c0` returns 0) — i.e. bodies vanish when not
  seen [inferred meaning of +0x7c4].
  ⇒ respawn ≈ death clip + 301 ticks (~10 s) after a kill, at the original
  spot, until nSpawns = Max spawns [derived].
- Forwarded methods: add/remove world, platform carry, the map-computer
  icon (only while isSpawned).

#### 8.3 Data [observed]

| Level | Generators | Σ Max spawns | Children (AI type / weapon) | Typical expressions |
|---|---|---|---|---|
| 4 | 4 | 15 | GUNNER AK47 1, PATROL_AK 2, GUARD_AK 1 | "1" (spawn at once) |
| 5 | 4 | 8 | SECURITY_PATROL_UZI 3, SECURITY_PATROL_SPAS 1 | `AlarmControl_97.isAlarm` |
| 6 | 14 | 81 | MAFIA_PATROL_AK 10, MAFIA_GUARD_SPAS 3, MAFIA_PATROL_SPAS 1 | `!AreaActivate_15x.nActive && Door_11xx.isClosed` (spawn behind closed doors while the player is not in the area), Max 3–12 |
| 7 | 4 | 18 | PATROL_AK 3, GUARD_SPAS 1 | `!AreaActivate_183.nActive && Door_234.isClosed` |
| 8 | 9 | 46 | SECURITY_PATROL_SPAS 3, PATROL_AK 3 (+2 with grenades), GUNNER 1 | `AlarmControl_97.isAlarm && !AreaActivate_477.nActive` |
| 9 | 6 | 28 | PATROL_SPAS 2, SECURITY_PATROL_SPAS 4 | `!AreaActivate_154.nActive && Door_208.isClosed` |
| 10 | 3 | 9 | SPETNAZ_PATROL_AK 2, PATROL_AK 1 | "1" (wave; ConditionalContainer #361 waits for nSpawns == 2 each) |
| 14 | 38 | 230 | SPETNAZ_* AK/SPAS/M16A2, SECURITY_PATROL_SPAS | `LevelTimer_14xx.isRun && LevelTimer_14xx.nTick < 16*GAME_FREQUENCY` (alarm bursts), `Terminal_1704.isHacked`, `EditVariable_740.nValue == 1 && …`, `LevelTimer_1415.nTick > 1000` |

Examples: L4 #600 "Barracks ground floor Gunner 416" ("1", Max 4); L6 #302
"Backdoor 410" (`!AreaActivate_152.nActive && Door_1109.isClosed`, Max 12);
L14 #800 "Office area Alarm Guards" (`LevelTimer_1400.isRun &&
LevelTimer_1400.nTick < 16*GAME_FREQUENCY`, Max 15); L14 #828/#829
(`LevelTimer_1415.nTick > 1000`, Max 1).

#### 8.4 Port notes

Mission-runtime node: at load, keep the child subtrees as templates and do
not instantiate them; per tick evaluate the expression, spawn by
instantiating the template (soldier + AI + perception phase), publish
isOn / isSpawned / nSpawns; the soldier system must remove generated
corpses from the world 300 ticks after the death clip ends (flag them "out
of world" for the AI registry, collision and rendering).

---

### 9. Unknowns / not traced

- `FUN_00474f10` (StationaryGun method 0x539546 → `FUN_004871c0`) and the
  player HUD while on the gun (crosshair, weapon panel).
- The exact M203 explosion point (ray record +8, read as the hit point) and
  the M203 smoke particle parameters beyond the recovered arguments.
- The rocket's muzzle point for soldiers (eye of the view object is
  [inferred]).
- The RPG graph's bit 0x10 source (kept by the pre-update mask
  0xffe3e01c).
- `FUN_004d06c0` (visibility stamp for corpse removal) semantics.
- AIStationaryGunHolder `FUN_004e0930` (child creation) and
  `FUN_004896c0` flag meanings beyond "alive, other team".
- ProximityMine (class 0x475380, S8) and the Mine projectile (`FUN_00475ac0`,
  TASKTYPE_MINE) were located but are outside this spec.
