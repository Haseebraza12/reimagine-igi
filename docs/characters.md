# Characters: skinned models, skeletons and animations

How Project I.G.I. (igi.exe, 2000) stores, poses and animates its
characters: soldiers (third person) and the player's first-person arms.
Labels: **observed** (measured on the files), **recovered** (read from
igi.exe code; function addresses given), **inferred** (consistent with the
data, not confirmed in code).

Code: `tools/igi_anim.py` (reference, stdlib, self-checks and previews),
`web-port/src/loaders/anim.ts` (`readAnimations`, `sampleClip`, tables),
`web-port/src/loaders/skeleton.ts` (`readSkinnedModel`, `poseSkeleton`,
`poseVertices`, `skinBuffers`), tests in `web-port/tests/characters.test.ts`.

## Files

| What | Where | Evidence |
|---|---|---|
| Skeletons + animations | `common/anims/000.iff 001 002 003 005 006` | location0.mtp `BANM` chunk lists exactly these six; FUN_004c8fb0 loads each as `%sanims/%s.iff` through FUN_004cce30 at level load (level1.mtp `BANM` is empty) — recovered |
| Skeleton id | `BOSH` word 0, equal to the file number | observed (all six) |
| Soldier models | `level1.res`: 000_01, 001_01, 003_01, 015_01, 019_01 (LODs `_1`..`_5`) | observed |
| First-person arms | `location0.res`: 005_01_1 | FUN_004632d0 loads the string "005_01_1" — recovered |

A HumanSoldier task's `Bone Heirachy` value is the skeleton id. Recovered:
the bone-object constructor takes its skeleton type from the word at
human+0xcf8 (FUN_004cfcb0 call at 0x45bb8a), and the next field, human+0xcfc,
is the idle override that the tasks call `Stand Animation` (FUN_00459620).
Inferred: +0xcf8 holds `Bone Heirachy` (field order). Observed: each model's
bind pose fits exactly the skeleton its tasks name (below).

Level 1 soldiers: 003_01_1 ×12, 019_01_1 ×12 and 001_01_1 ×1 on skeleton 1
(001.iff); 000_01_1 ×5 on skeletons 0/1 (cut-scene actors, the truck driver
"Jones"); 015_01_1 ×1 on skeleton 6. AI types are GUARD_AK, PATROL_AK and
SNIPER. The player task uses 000_01_1 (skeleton 0, third-person body only).

## Animation container (`.iff`)

EA-IFF chunks, big-endian sizes, padded to even length (observed; parsed by
FUN_004cce30, chunk helpers FUN_00511580..FUN_00511740 — recovered).

```
FORM BOBJ
  FORM BOBH
    BOSH  u32 skeleton id, u32 bone count
    PLST  i32 parent per bone (-1 = root; every parent < its child)
    TLST  f32[3] per bone: joint offset in the parent's frame (IGI units)
  FORM BOAL
    BALH  u32 clip count, u32 id capacity (= largest clip id + 1)
    clip count × FORM BOAN
      BOAH  f32 duration (ticks), u32 flags (bit 31 = loop), i32 clip id
      BOTH  u32 n; BOTD (only if n > 0) n × 40 bytes:
            f32 pos[3], f32 time, f32 c[3], f32 d[3]       root translation
      bone count × { BORH u32 n; BORD n × 52 bytes:
            f32 q[4] (x,y,z,w), f32 time, f32 a[4], f32 b[4] }  rotations
      BOEH  u32 n; BOED n × 24 bytes: i32 trigger, i32 0, f32 time, f32[3]
```

- The stored sizes of `FORM BOBJ` and `FORM BOAL` stop after the 12-byte
  header of their last child FORM; all other sizes are exact (observed on all
  six files; the readers verify the quirk and reject anything else).
- Exe storage (recovered, FUN_004cce30): per skeleton {bone count, parent
  list, TLST} at 0x7e4a00 + 12·id; clip records of 0x14 bytes {duration,
  flags, translation track, per-bone rotation tracks (16 bytes each),
  events} indexed by clip id. Tracks with one key keep only the first 16/20
  bytes of the key.
- Clip ids are per file: 001.iff clip 3 and 000.iff clip 3 are unrelated
  (observed: 39 shared ids, none with matching content).
- **Time unit: 3ds Max ticks, 4800 per second.** FUN_004c93d0(30.0) sets the
  per-update step to 4800/30 = 160 ticks (the game logic runs at 30 Hz,
  call at 0x414f9d); blend seconds are converted with ×4800 (FUN_004cc860)
  — recovered. Key times are mostly on the 160-tick (30 fps) grid; some clips
  have off-grid keys (observed, 31 of 376 clips). Every track starts at time 0
  and increases strictly (observed). 96 clips have keys past their duration;
  those are never reached (observed).

| File | Skeleton | Bones | Clips (loop flag) | Used by |
|---|---|---|---|---|
| 000.iff | 0 | 33 | 122 (58) | player body 000_01_1 (third person), cut-scene soldiers |
| 001.iff | 1 | 33 | 95 (32) | level-1 soldiers 003/019/001 |
| 002.iff | 2 | 33 | 18 (3) | not used by level 1 |
| 003.iff | 3 | 33 | 47 (6) | not used by level 1 |
| 005.iff | 5 | 56 | 78 (20) | first-person arms 005_01_1 |
| 006.iff | 6 | 33 | 16 (7) | 015_01_1 (seated figure) |

## Skeletons

All 33-bone skeletons share this hierarchy (observed); the TLST offsets
differ (skeleton 0 vs 1 by up to 6.2 cm). Names are inferred from the
skinned geometry (models face +y, +x is the character's right). Offsets
below are skeleton 1, in cm.

| Bone | Parent | Offset (x, y, z) | Label |
|---|---|---|---|
| 0 | -1 | 0, 0, 0 | pelvis (root) |
| 1 | 0 | 0, 4.5, 13.5 | spine |
| 2 | 1 | 0, -9.0, 25.1 | chest |
| 3 | 2 | 0, 2.3, 16.8 | upper chest |
| 4 | 3 | 0, 2.0, 9.1 | neck/head (head mesh) |
| 5 | 4 | 0, 2.4, 21.8 | head top (end) |
| 6, 7 | 4, 6 | … | head detail (11–24 vertices on 6) |
| 8–13 | 3, 8, … | -20.8, 4.4, -9.5 … | left clavicle, upper arm, forearm, hand, fingers, finger end |
| 14–19 | 3, 14, … | 19.9, 4.4, -9.5 … | right side |
| 20–22 | 1, 20, 21 | 0, 17.6, -5.6 / 0, 51.4, 9.6 / 0, 39.4, 31.7 | gun chain; **22 = gun mount** (no vertices) |
| 23–27 | 0, 23, … | -10.5, 2.3, -1.1 / 0, -1.0, -43.7 / … | left thigh, shin, foot, toes, toe end |
| 28–32 | 0, 28, … | 10.6, 2.3, -1.1 … | right leg |

The 56-bone first-person skeleton (005.iff): 0 root; 1→2→3 gun chain
(**3 = gun body**); 4→5→6 right upper arm, forearm, hand; 7–26 five right
finger chains of four bones; 27→28→29 left arm; 30–49 left fingers;
50→51→52 magazine chain (**52 = magazine**); 53→54→55 moving-part chain
(**55 = slide/bolt/pump**). Bones 1–3 and 50–55 carry no vertices.

## Bone models (`.mef` type 1)

Recovered from the skinning routine FUN_0052be70 (called by DrawBoneMesh,
FUN_0052fc20, name registered in FUN_004c5b80); every claim also observed on
all 26 bone models.

- D3DR u32 words: [0] = 4, [1] faces, [2] blocks, **[3] extra-influence
  count, [4] primary vertex count**. XTRV holds primaries then extras
  (40 bytes each): `f32 pos[3]` (bone space), `f32 normal[3]`, `f32 uv[2]`,
  `f32 weight`, `u16 target`, `u16 bone` — the "packed bone references in
  uv2" are weight / target / bone.
- Render blocks (DNER) index primaries only. Each extra adds to primary
  `target`; a primary's weight plus its extras' weights sum to 1 (max error
  1.6e-6). Up to 6 influences per vertex (observed).
- Skinning with bone world rotation R and position T:
  - **LOD 0**: `out[v] = w_v (R_b p_v + T_b)`, then each extra adds
    `w_e (R_b' p_e + T_b')` to `out[target_e]`.
  - **LOD ≥ 1**: `out[v] = R_b p_v + T_b`; weights and extras ignored.
  - Normals: `R_b n_v` of the primary bone, never blended.
  - The caller passes the LOD index (0x52fe06); the first-person arms force
    LOD 0 (obj+0xd4 = 0 in FUN_004632d0).
  - At most 4000 primaries ("Bone model too large", FUN_0052be70).
- No inverse bind matrices: vertices are bone-local. With every local
  rotation set to identity ("bind pose") a vertex's influences agree to
  0.02 cm for 000_01_1 (skeleton 0), 003_01_1 (skeleton 1) and 015_01_1
  (skeleton 6), and to ≤ 1.0 cm for 001_01_1 and 019_01_1 (skeleton 1);
  with the wrong skeleton they disagree by 6–11 cm (observed,
  `igi_anim.py`, test "bind pose"). So the identity pose is the authored
  pose. Bind-pose heights: 1.76–1.85 m. The arms model's fingers agree
  exactly but its shoulder/elbow influences disagree by up to 18 cm
  (observed; the exe uses the same formula, so rendering is unaffected).
- Collision meshes (HSMC/XTVC): the 4th dword of each XTVC vertex is its
  bone; positions are bone-local and are posed with the bone matrices for
  hit tests (FUN_004cdcb0, FUN_004cef60 — recovered; values 0–31/0–48
  observed).

## Posing

Recovered from FUN_004c9f50 → FUN_004ca120 (bone records of 0x84 bytes:
+8 TLST, +0x18 world position, +0x24 world 3×3, +0x4c world quaternion,
+0x60 local quaternion, +0x74 parent, +0x78 first child, +0x7c sibling).

```
world_q[0] = object_q * local_q[0]          world_T[0] = R(object_q) * TLST[0] (= 0)
world_q[b] = world_q[p] * local_q[b]        world_T[b] = world_T[p] + R(world_q[p]) * TLST[b]
```

Quaternions are (x, y, z, w), Hamilton product (checked numerically against
the exe's 8-multiply formula), `R(q)` the standard column-vector matrix.
Bone positions are relative to the object position; the object position is
added at draw time (DrawBoneMesh translates by the object's double-precision
position).

**Root translation** (the BOTD track) is not applied to the root bone.
FUN_004c9650 returns its current value and its change since the last update:

- The change, rotated into world space, moves the human (root motion;
  FUN_00453ea0 / FUN_0045bd00 at human+0x520) — recovered.
- The absolute value is the pelvis offset above the feet: FUN_00488760
  computes model-space bone positions as `bone + rootTranslation`, and the
  ground probes (FUN_004606b0) and vehicle exit (FUN_0044e28f) put the feet
  at `position.z − rootTranslation.z` — recovered. So the human's position
  is at pelvis level and its feet are `rootTranslation.z` (≈ 0.97 m
  standing, 0.54 m kneeling, 0.11 m prone) below it.
- Port rule: `vertex_world = objectPosition + R_obj·(rootTranslation.xy − rootTranslation(0).xy for root motion, rootTranslation.z) + skinned`;
  with the feet on the ground use `feet + R_obj·(0, 0, root.z) + skinned`
  plus the horizontal root motion if the clip should move the character.

Upper-body aim (FUN_00488390, recovered): pitch and yaw of the view are
added to bones 1 (spine) and 4 (neck) after sampling (FUN_004cd700),
clamped to ±0.96 rad on bone 1 with the excess on bone 4.

## Sampling and playback

Recovered from FUN_004cb810 (rotations), FUN_004caed0 (translation),
FUN_004cd3d0 (per-segment slerp precomputation), FUN_004cab90 (slerp),
FUN_004aa7b0 (arc). FUN_004c92d0 sets the smooth mode (flag 0x7e4d88 = 1).

- **Rotation** at time t: first key k with time ≥ t. Exact hit → key k.
  Before the first key → key 0. After the last key → hold the last key, or,
  if the clip's loop bit is set, interpolate from the last key to key 0 over
  `duration − lastTime`. Otherwise `u = 1 − (t_k − t)/(t_k − t_{k−1})` and
  **squad**: `slerp(slerp(q0, q1, u), slerp(a0, b1, u), 2u(1−u))`. Each slerp
  takes the shorter arc, uses plain (unnormalised) lerp below 0.01 rad and
  returns q0 at exactly 0; the outer slerp returns its first argument when
  the weight `1 − 2u(1−u)` ≥ 0.999 and its second when ≤ 0.001. (Squad vs
  plain slerp differ by up to 2.9° on clip 4.)
- **Translation**: exact key; past the last key hold it (no wrap); otherwise
  Hermite with `dt = t1 − t0`:
  `h00 p0 + h01 p1 + dt (h10 c0 + (u² − u³) d1)` (`h00 = 2u³−3u²+1`,
  `h01 = 3u²−2u³`, `h10 = u−2u²+u³`).
- **Playback** (FUN_004cb1f0): time += 160 ticks per 30 Hz update (×speed).
  The *caller's* loop flag decides wrapping (`t −= duration`); one-shot play
  clamps at the duration and raises "finished" (bit 0x100). Reverse play
  (flag 2) is supported. Events between the old and new time fire
  (FUN_004cb450): trigger ids ≥ 1000 are `animtrigger/animtrigger.qvm`
  `DefineAnimTrigger` sounds (1006–1011 mp5_reload_1–5, 1040 bodyfall_9,
  1041 guard_roll, 1052 gunpunch_01, …); 1010 marks footsteps (not in the
  script; inferred); 3–12 are engine triggers (unknown).
- **Blending** (FUN_004cc860): a blend time of at least one update
  (f32(seconds × 4800 / 160)) fades the old pose out through the bone
  object's blend tree ("Blending" below); shorter switches are immediate.
  Soldier actions pass 0 (instant switches); the player's body actions pass
  0.2 s (0x3e4ccccd), the arms' stance clips 0.4 s — recovered.
- Loops are continuous at 30 fps: the step at every wrap is no larger than
  the clip's largest one-frame step (observed for all 001.iff loops, e.g.
  clip 3: 21.5° vs 31.0°). Cycles are authored one frame longer than the
  duration: clip 3's root keys repeat every 3520 ticks, its duration is 3360.

## Blending (the bone object's blend tree)

All recovered: FUN_004cc860 (play), FUN_004cc550 / FUN_004cc660 (fade node
and record), LAB_004cca30 / LAB_004cca40 (weight getter, update),
FUN_004c98b0 / FUN_004c9940 / FUN_004c9de0 (advance, collapse),
FUN_004c9650 / FUN_004c96c0 / FUN_004c9800 (root), FUN_004ca120 /
FUN_004ca5e0 / FUN_004ca850 / FUN_004cab90 (pose), FUN_004ccaf0 (newest
instance), FUN_004cb5f0 / FUN_004cb1f0 / FUN_004cb450 (instance, advance,
events), FUN_00460010 / FUN_00463840 / FUN_00462560 / FUN_004594e0 (event
use). Port: `web-port/src/engine/world/bone-anim.ts` (`BoneAnim`), used by
`player/body.ts`, `ai/clip-player.ts` and `player/first-person.ts`; tests
`web-port/tests/anim-blend.test.ts`.

- **Layout.** A bone object (human+0x68, arms+0x68) has one 0x84-byte record
  per bone. A layer is the tree at bone record +0x80. Layer 0 (bone 0)
  drives the whole skeleton: a bone without its own tree uses its nearest
  ancestor's (FUN_004ca120).
  - Node (0x2c bytes, FUN_004c9c50): parent; blend function (0 = FUN_004ca850);
    weight getter; destroy; update; fade record; two branches {type −1 empty,
    0 node, 1 leaf; pointer} at +0x1c / +0x24. Branch 0 is the older pose,
    branch 1 the newer.
  - Leaf = clip instance (0x34 bytes, FUN_004cb5f0): bone, clip id (+4),
    flags (+8: 1 loop, 2 reverse, 0x100 finished, 0x8000 first advance),
    clip (+0xc), stored root sample (+0x10: the first translation key, the
    last when reversed), last root change (+0x1c), rate (+0x28: ±160), time
    (+0x2c).
  - Fade record (16 bytes, FUN_004cc660): {t = 0, n, w = 1.0, result}.
- **Play** FUN_004cc860(object, layer, clip, flags, s):
  - n = f32(f32(s) × 4800 / 160), stored with `fstp DWORD` (chop): 0.2 s →
    6 updates, 0.4 s → 12.
  - Every call makes a new instance (the same clip restarts at 0).
  - The layer has a tree and n ≥ 1 (FUN_004cc550, result 0): a root whose
    branch 1 is empty (a single clip) is reused; otherwise a new root takes
    the whole old tree as its branch 0. The new instance becomes branch 1
    with a fresh fade; bone flag 0x10000 (blending) is set.
  - Otherwise the whole tree is freed (FUN_004c9b40) and a single-leaf root
    holds the new instance; bone flags 0x100, 0x10000 and 0x40000 are
    cleared.
- **Weight** (LAB_004cca40, once per advance): t = t + 1; t ≥ n → w = 0,
  return the result; else w = f32(1 − t/n) (x87 `fdiv`, `fsubr`,
  `fstp DWORD`, all chopped), return −1. LAB_004cca30 returns w, the weight
  of branch 0 (the old pose). So w = 1.0 from the play until the first
  advance, then 5/6, 4/6, …, 1/6 for the body: linear in updates, not eased,
  stored as float32.
- **Root** (FUN_004c9650 → FUN_004c96c0): every leaf samples its translation
  at its own time (FUN_004caed0: change = sample − stored, stored = sample;
  a one-key track gives the key and 0). A node returns (b0 − b1)·w + b1 for
  both the absolute translation and the change (FUN_004c9800).
  - During a blend the root motion is the linear mix of both clips' own
    per-update changes. The pelvis height (+0x51c, FUN_00488760 /
    FUN_004606b0) is the same mix of their heights.
  - A new instance's first change is 0: its stored sample is its first key.
  - A phase carry-over (FUN_004ccc40) right after the play makes that first
    change s(t_phase) − key0. On a blended play (the player) its weight is
    1 − w = 0. On an instant play (soldiers entering 1, 2, 3 or 17
    mid-stride, "Locomotion phase") it applies in full: the soldier moves by
    the clip's root offset at that phase in one tick: at half a stride
    1.2 m for run 3 and 4.3 m for the long walk cycle 57 (001.iff), more
    near the end of the cycle. Nothing in the soldier
    tick (FUN_0045bd00) guards it. [recovered; not checked in the running
    game]
- **Rotations** (FUN_004ca5e0 → FUN_004ca850 → FUN_004cab90(q0 = branch 0,
  q1 = branch 1, w)): q1 when w ≤ 0.001, q0 when w ≥ 0.999, otherwise the
  slerp of "Sampling and playback" from q0 toward q1 by 1 − w (shorter arc;
  plain lerp below 0.01 rad). It is a slerp, not a normalised lerp.
- **Advance** (FUN_004c98b0 → FUN_004c9940):
  - Bone flag 0x10000 is cleared first.
  - A node without a fade advances branch 0, then branch 1.
  - A fading node updates its record first. While it runs (−1): flag
    0x10000 is set, then branch 0 (old) and branch 1 advance. When it ends
    (result 0): the record is destroyed, branch 0 is freed **without a last
    advance**, and branch 1 advances.
  - FUN_004c9de0 then replaces every node left with one branch by that
    branch.
- **Nested blends**: a blended play during a blend makes the running blend
  the older branch of a new root. Both fades keep running; the inner one,
  started earlier, ends first and its node collapses.
- **Finished flag**: each instance advance (FUN_004cb1f0) clears the
  instance's and the bone's 0x100 before it may set them. The newest
  instance advances last, so after an advance the bone's flag is the newest
  instance's.
- **Newest instance** (FUN_004ccaf0; used for the phase, duration, time, set
  time, speed and clip id, FUN_004ccb50–FUN_004ccc40): while blending,
  follow branch 1 down to a leaf; otherwise the root's branch 0.
- **Events**: all instances append to one list in advance order (oldest
  first).
  - The humans act on the first event only (FUN_00460010: +0x538 trigger,
    +0x53c clip, sound via FUN_004e2c60); so do the arms (FUN_00463840,
    arms+0x20c).
  - Footsteps (FUN_00462560 player, FUN_004594e0 soldiers) need that first
    event to be 1010 **and** its clip to be the newest instance's clip.
  - So the outgoing clip still fires its events during a fade and wins a
    tick it shares with the new clip, but its footsteps are dropped (unless
    both are the same clip id).
- **Who blends**:
  - Player body 0.2 s: the ground states, the lean, the map computer, hit 46
    and death 47.
  - 0 (instant): the jump 28, the fall 29, the run states entered from the
    jump, the use and attached states, the initial clip.
  - Arms 0.4 s for the stance clips (FUN_00413780 modes 1–5, 9, 10), 0
    otherwise.
  - Soldiers pass 0 everywhere: they never blend.
  - The player's third-person upper-body layer on bone 1 uses the same
    nodes: FUN_004882f0 → FUN_004cc7c0 / FUN_004cc680, and FUN_00488320 →
    FUN_004cc940 (result 2: both branches dropped). It also uses
    parent-inheriting leaves (LAB_004cae10) and an aim leaf (FUN_004cbd90).
    Not ported.
- **Consequences** (000.iff, port tests):
  - Stopping from a run (clip 4 → 2) slides 0.59–0.72 m, depending on the
    stride phase: one full run update at w = 1, then 5/6 … 1/6. A fade that
    started at 5/6 (the port's earlier guess) gave 0.42–0.51 m.
  - The jump (blend 0) frees the tree: the pelvis jumps to clip 25's first
    key (0.946 m) at once and its first change is 0.
  - Jump pressed 1–5 ticks after standing up from a crouch (clip 19, pelvis
    0.428 m): the feet start up to 0.52 m inside the floor. With the port's
    recovered sweep and ground probe the jump lands on the next tick.
    Pressed 6 ticks after: apex 1.55 m. From 7 ticks: the full 1.64 m.
    [outcome inferred from the port's movement code]
- Port precision: times, rates and weights follow the float32 / chop rules;
  root samples are double precision, as in `sampleTranslation`.

## Soldier animations (skeleton 1, 001.iff)

The human action → clip tables are static arrays of 38 × {i32 clip, i32
loop flag} (recovered): HumanSoldier 0x53ccc0, chosen by HumanAI type
(switch at 0x45bab0 on type − 5): PRIBOI → 0x53cf20, CIVILIAN → 0x53d050,
SPETNAZ_* → 0x53cdf0, every other type (incl. GUARD_AK, PATROL_AK, SNIPER)
→ 0x53ccc0. AITYPE values are the order of the name table at 0x53a970
(FUN_0044dd00): RPG 0, GUNNER 1, SNIPER 2, ANYA 3, EKK 4, PRIBOI 5,
CIVILIAN 6, PATROL_UZI 7, PATROL_AK 8, … GUARD_AK 12 … SPETNAZ_GUARD_SPAS
28. Handler i is the i-th pointer at 0x53cbc0; it calls FUN_00488290(human,
i, 0) → FUN_004cc860(human+0x68, bone 0, clip, flag, 0). Other classes:
player 0x5368c8, HumanSoldierFemale 0x53c450, RPG 0x53c6d0, Pistol 0x53c968.

Action → clip (0x53ccc0). Numbers recovered; meanings from the recovered
state graph below (transitions, the channels that lead there) and from the
rendered motion/root track:

| Act. | Clip | Loop | Meaning | Data (seconds, root) |
|---|---|---|---|---|
| 0 | 2 (or 'Stand Animation', played one-shot) | 1 | stand idle, rifle held | 2.93 s, static 0.97 m |
| 1 | 34 | 1 | panic run (channel 25) | 0.70 s, 4.33 m/s |
| 2 | 3 | 1 | run (walking flag off) | 0.70 s, 3.40 m/s |
| 3 | 57 | 1 | patrol walk | 6.77 s, 1.26 m/s, foot planted 90% |
| 4 / 5 | 10 / 11 | 0 | roll left / right, ends kneeling | 1.07 s, ±1.94 m sideways |
| 6 | 56 | 1 | stand fire (the only standing state that fires) | 0.43 s held pose |
| 7 | 14 | 0 | stand reload | 2.77 s |
| 8 | 58 | 0 | throw grenade (events 9/10/11) | 3.30 s |
| 9 | 70 | 0 | rifle-butt strike (gunpunch_01; the blow on event 12) | 1.20 s |
| 10 / 11 / 12 | 54 / 53 / 55 | 0 | aim pose / raise to aim / lower | 0.47–0.63 s |
| 13 / 14 | 7 / 19 | 0 | stand → kneel / kneel → stand (14 is never entered) | 0.5 / 1.0 s, root 0.97 ↔ 0.54 m |
| 15 / 16 | 12 / 13 | 0 | dive prone / prone → stand | 1.0 / 2.0 s, root 0.97 ↔ 0.11 m |
| 17 / 18 | 48 / 52 | 1 | combat run (channel 26) / combat run firing | 4.32 m/s |
| 19 | 18 | 0 | kneel (idle) | |
| 20 / 21 | 33 / 32 | 0 | kneeling roll left / right | ±1.95 m |
| 22 / 23 / 24 | 9 / 15 / 8 | 1/0/0 | kneel fire / kneel reload / kneel aim | |
| 25 | 20 | 0 | kneel → prone | |
| 26 / 27 / 28 | 16 / 17 / 21 | 0 | prone / prone fire / prone reload | |
| 29 | 2 | 1 | fall (not grounded; the last movement becomes the air velocity) | |
| 30 | zone table | 0 | hit reaction (flinch), clip by hit zone | |
| 31 | 26 | 0 | prone hit reaction | 3.33 s at 0.11 m |
| 32 | see "Hit reactions and deaths" | 0 | standing death (FUN_0045aea0); HumanAI SetDeathAnimation overrides | 2.4–2.6 s / 1.2, 0.8 s |
| 33 | 24 | 0 | kneeling death (FUN_0045b000) | 1.73 s |
| 34 | 25 | 0 | prone death (FUN_0045b0b0) | 0.50 s |
| 35 | scripted clip (human+0xd0c, one-shot) else table slot 2 | 0 | scripted animation (channel 23) | |
| 36 | 31 (entry plays it one-shot; table flag 1) | 1 | stationary gun (use, channel 24) | |
| 37 | 2 | 0 | use a switch-like task (one-shot idle) | |

`Stand Animation` (human+0xcfc, next to `Bone Heirachy`) replaces action 0
when not −1 (FUN_00459620, recovered): level-1 values 41 (001.iff relaxed
idle, 9.67 s loop), 61 (Jones: seated driving pose, 6.07 s loop), 19
(000.iff squat), 4 (006.iff seated). Death clips also play
`ai_death_N` sounds and run FUN_0045c3b0 to place the body.

Gun (third person): the weapon model on **bone 22** with identity offset puts
the right wrist 11 cm from the gun origin in both the idle (clip 2) and aim
(clip 56) poses and points the rifle forward when aiming (observed fit;
the attaching code was not found — inferred).

## Soldier state graph (HumanSoldier)

Recovered from the HumanSoldier constructor (0x45b600), FUN_004e2d10,
FUN_004e2d60, the pre-update FUN_0045b6a0, the 38 entry handlers at
0x53cbc0 and the tick functions they install. Port:
`web-port/src/engine/ai/soldier-graph.ts` (tables, `soldierTick`),
`motor.ts` (runs it), tests in `web-port/tests/soldier-anim.test.ts`.

- The graph object is human+0x2ec: +0 pre-update, +4 entry table, +8
  condition bits (human+0x2f4), +0xc previous state, +0x10 state
  (human+0x2fc, the body state the AI reads), +0x14 the running tick
  function. FUN_004e2d10 installs entry 0 as the running function, so the
  first run only enters state 0.
- Each soldier tick (FUN_0045bcc0 → FUN_0045bd00), with the channels the AI
  wrote on its previous frame (the HumanSoldier node precedes its HumanAI node
  in the task tree): graph run; channel 20 toggles the walking flag
  (+0xd00, constructor 1); the flinch bit is cleared; FUN_0045fd00 turn;
  FUN_00463470 view pitch; root delta (translation sampled at the current
  time minus the stored sample); FUN_00460010 advances the clip (events,
  finished flag, the advance's first event kept at +0x538/+0x53c); the move
  (FUN_004600f0); the gun (FUN_00461a90); footsteps (FUN_004594e0).
- A tick that switches state calls the new state's entry at once; the entry
  plays action-table slot = state with **blend 0** (every switch is instant
  and restarts the clip) and installs the state's tick, which first runs on
  the next game tick: at most one transition per tick.
- Condition bits: 0x1 bone 0 finished (flag 0x100, set at every loop wrap
  too), 0x2 blending, 0x4 grounded, 0x10 "Roof!" (FUN_004606b0), 0x20/0x40
  channels 2/3 (left/right), 0x80 ch 4 forward, 0x100 ch 5, 0x200 ch 6 fire,
  0x800 ch 8 reload, 0x10000 flinch, 0x20000 dead, 0x40000 walking flag,
  0x80000 ch 21 kneel, 0x100000 ch 22 lie down, 0x200000 ch 23 animation
  (+0xd0c = fistp(ch23), truncated), 0x400000 ch 24 use, 0x800000 ch 25
  panic, 0x1000000 ch 26, 0x2000000 ch 27 aim, 0x4000000 ch 29 grenade,
  0x8000000 ch 30 close combat. Kept from the previous tick: `& 0xf003e01c`.
  Channel 28 changes the weapon (FUN_00413c60), not a bit.
- Transitions (first match wins; "F" = finished; every state but 29/36/37
  first tests !grounded → 29; where listed, flinch → 30 (31 when prone) and
  dead → 32/33/34):

| State (clip) | Tick | Transitions |
|---|---|---|
| 0 stand (2 / Stand Animation one-shot) | 0x4596d0 | flinch 30; dead 32; kneel or roof 13; lie down 15; aim 11; grenade 8; reload 7; animation 35; close combat 9; ch26+fwd 17; panic+fwd 1; fwd → 3 walking / 2 running; left 4; right 5 |
| 1 panic run (34) | 0x459a00 | flinch 30; dead 32; kneel 13; lie down 15; aim 11; grenade 8; reload 7; panic released → 3/2 by the walking flag; left 4; right 5; no fwd 0 |
| 2 run (3) / 3 walk (57) | 0x459d30 / 0x456ce0 | as 1 up to reload; ch26 17; panic 1; walking flag → 3 (from 2) / not walking → 2 (from 3); left 4; right 5; no fwd 0 |
| 4, 5 rolls (10, 11); 13 stand→kneel (7); 20, 21 kneel rolls (33, 32) | 0x45a050 | dead 33; F 19 |
| 6 fire (56 loop) | 0x456fc0 | flinch 30; dead 32; **trigger = ch 6**; F and no fire → aim ? 10 : 12 |
| 7 reload (14) | 0x457120 | flinch 30; dead 32; F: clip refilled (FUN_004e8fd0(gun, 1)), aim ? 10 : 0 |
| 8 grenade (58) | 0x45a170 | flinch 30; dead 32; event 11 of this clip and a target record → throw once; F → aim ? 10 : 0 |
| 9 close combat (70) | 0x45a3b0 | flinch 30; dead 32; event 12 of this clip → one blow (rand ≤ hit probability, target required); F 0 |
| 10 aim (54) | 0x457430 | flinch 30; dead 32; no aim 12; fire 6 |
| 11 raise (53) | 0x45a590 | flinch 30; dead 32; F 10 |
| 12 lower (55) | 0x457570 | flinch 30; dead 32; F 0 |
| 14 kneel→stand (19) | 0x45a6d0 | dead 33; F 0 (never entered) |
| 15 dive (12) / 16 prone→stand (13) | 0x45a790 / 0x45a850 | dead 34; F → 26 / 0 |
| 17 combat run (48 loop) | 0x456840 | flinch 30; dead 32; kneel 13; lie down 15; fire 18; ch26 released → panic 1 / walking 3 / 2; left 4; right 5; no fwd 0 |
| 18 combat run firing (52 loop) | 0x456a60 | flinch 30; dead 32; clip refilled every tick; trigger = ch 6; ch26 released → 3/2; no fwd 0; F and no fire 17 |
| 19 kneel (18) | 0x457920 | flinch 30; dead 33; lie down 25; neither kneel nor roof → **0 directly**; fire 24; reload 23; left 20; right 21 |
| 22 kneel fire (9 loop) | 0x457be0 | flinch 30; dead 33; trigger = ch 6; F and no fire → aim ? 24 : 19 |
| 23 kneel reload (15) | 0x457d10 | flinch 30; dead 33; F: refill, 19 |
| 24 kneel aim (8) | 0x457e10 | flinch 30; dead 33; no aim 19; F and fire 22 |
| 25 kneel→prone (20) | 0x45aa30 | dead 33; F 26 |
| 26 prone (16) | 0x458000 | flinch 31; dead 34; no lie down 16; fire 27; reload 28 |
| 27 prone fire (17) / 28 prone reload (21) | 0x458130 / 0x45ab50 | flinch 31; dead 34; 27: trigger = ch 6, F and no fire 26; 28: F refill, 26 |
| 29 fall (2 loop) | 0x45ac70 | flinch 30; dead 32; grounded: landing sound, air velocity 0, → 0 |
| 30 flinch (zone clip) | 0x4582d0 | dead 32; F: aim on, 0 |
| 31 prone flinch (26) | 0x45add0 | dead 34; 20-tick guard, then flinch re-enters 31; F: aim on, 26 |
| 32–34 deaths | 0x45b160 | slide (FUN_0045c3b0) each tick until F, then the dead hold (0x40e7e0) |
| 35 scripted animation | 0x45b230 | flinch 30; dead 32; any of `bits & 0xfd81fe1` (F, move, fire, reload, stance, use, panic, ch26, aim, grenade, close combat) or +0xd0c = −1 → aim on, 0 |
| 36 stationary gun (31) / 37 use (2) | 0x458830 / 0x45b430 | entered by the use handler FUN_0045b940 (task kind 6 / 3); 36 leaves on a fresh ch 24 press or death; 37 on F |

- **Only states 6, 18, 22 and 27 pull the gun's trigger** (+0x4d1);
  the fire channel elsewhere only drives transitions. Standing fire needs aim:
  0 → 11 (raise, 14 ticks) → 10 → (fire) 6; at the end of each 13-tick loop
  of clip 56 without fire → 10 (aim held) or 12 (lower, 19 ticks) → 0.
  Kneeling fire needs fire then aim + fire: 19 → 24 → 22.
- **Locomotion phase**: entering 1 (from 2, 3, 17), 2 (from 1, 3, 17),
  3 (from 1, 2) or 17 (from 1, 2, 3) keeps the stride: new time =
  f32(newDuration × f32(oldTime / oldDuration)) (FUN_004ccbb0 / FUN_004ccc40).
- **Low-profile flag human+0x33d** (sweep heights, ground probe, eye and aim
  height FUN_00464490 / FUN_00450150, quiet footsteps) is written by the
  entries: 1 in 4, 5, 6, 18, 19, 20, 21, 25; unchanged in 7, 8, 9, 22, 23,
  24, 27, 28, 35–37; 0 elsewhere — prone (26) uses the standing heights and
  standing fire (6) the low ones.
- Upper-body aim flag human+0x64c (constructor 1): off on entering 30, 31,
  32–35, back on when 30, 31, 35 end.
- 'Stand Animation' (human+0xcfc) is played **one-shot** by state 0 (it
  holds its last frame); activation (FUN_0045bb60) plays it, or clip 2,
  one-shot before the first graph run.
- A scripted animation always plays one-shot (looping clips once); a
  continuing request (channel 23 on the next tick in state 0) starts it
  again. A cancel (−1) in state 0 enters 35 with table slot 2 (clip 3)
  for one tick.
- Root motion is sampled before the advance: the movement of tick N is the
  translation change from the previous advance, and a state switch's first
  delta is 0 (the new instance's stored sample is its first key), except
  after a locomotion phase carry-over, where it is the new clip's root
  offset at that phase ("Blending"). The pose is drawn at the advanced
  time; the pelvis sits at the human position (feet = position − the
  sampled root z, +0x51c).
- Action tables by HumanAI type (FUN_0045bab0): PRIBOI 0x53cf20, CIVILIAN
  0x53d050, SPETNAZ_* 0x53cdf0, others 0x53ccc0 (all four in
  soldier-graph.ts).
- Other classes (not used in level 1, documented only):
  HumanSoldierPistol (entries 0x53c868, 38 states, pre-update 0x458b30,
  actions 0x53c968, zones 0x53ca98) installs the same tick functions for
  most states (copies at 0x457b00, 0x457280, 0x457680, 0x457760, 0x457840,
  0x457f20, 0x458660 for the rest; inferred equivalent);
  HumanSoldierFemale (entries 0x53c3b0, 13 states, pre-update 0x4539b0,
  actions 0x53c450, zones 0x53c4b8) and HumanSoldierRPG (entries 0x53c658,
  15 states, pre-update 0x455b40, actions 0x53c6d0, zones 0x53c748) have
  their own smaller graphs (not decoded).

## Upper-body aim

Recovered FUN_00488390 (called by FUN_0045e150 after posing, when
human+0x64c is set), FUN_004aa940 (axis-angle quaternion, half angle 0.5),
FUN_004cd700 (subtree rotation), FUN_00463470 (view angles), FUN_00461a90
(kick). Port: `applyUpperBodyAim` in soldier-graph.ts, applied by
SoldierBody.pose.

- Pitch = arms +0x120 = +0x124 (channel-1 accumulation, clamped ±π/2) +
  +0x128 (gun kick, ×0.9 per tick). The spine (bone 1) turns by the pitch
  clamped to ±0.95993114 rad about the body's right axis (column 0 of the
  body matrix); the excess turns bone 4 (neck) about the same axis.
- Yaw = arms +0x12c turns bone 1 about the body's up axis and the excess bone
  4 about the bone 4 → 5 axis; it only moves toward a look-at target
  (arms +0x180), which the HumanAI clears every frame (FUN_0044e260 →
  FUN_00464590(arms, 0, 0)), so AI soldiers keep yaw 0.
- FUN_004cd700 pre-multiplies the rotation onto the world quaternion of
  every bone of the subtree (world_q' = q · world_q, checked numerically
  against the exe's 8-multiply product) and recomputes positions from the
  parents: the subtree turns about bone 1's (bone 4's) position. Bones 1..22
  (spine, chest, head, arms, gun chain) move; the gun on bone 22 follows, and
  so do the hit tests (the collision set is posed with the same matrices).
- The body matrix yaw is heading + the gun's yaw kick (+0x508 = +0x50c +
  arms +0x134); each shot's kick (FUN_00477ea0: fixed + random × a unit-disk
  sample, two level-RNG draws per try) applies to AI soldiers too.

## Hit reactions and deaths

Recovered FUN_0045bfe0 (bullets), FUN_004592a0 (explosions), FUN_0045c1a0
(melee), FUN_0045ad40 / FUN_0045ad90 (flinch entries), FUN_0045aea0,
FUN_0045b000, FUN_0045b0b0 (deaths), FUN_0045c820, FUN_0045c3b0, table
0x53d180.

- Every hit adds the zone-multiplied damage to human+0x254 and to the flinch
  sum +0xd08. When +0x254 reaches the maximum: dead bit, death type +0xd1c
  (bullets: 1 if the gun's WEAPONTYPE is 2 = SHOTGUN, else 2; explosions 0;
  melee 2) and direction +0xd20 (bullet travel direction; explosion: body −
  centre; melee: body − attacker). Otherwise, when +0xd08 > "Recoil
  threshold" (+0xd04, settings.qvm, constructor 0.33): flinch bit, +0xd08 = 0.
  Hit zone +0x2e8: bullets FUN_00488080, explosions 13, melee 13/14.
  WEAPONTYPE values (0x413e19): GUN 0, PISTOL 1, SHOTGUN 2, KNIFE 3, GRENADE
  4, BINOCULAR 5, MEDIPACK 6, PROXIMITYMINE 7.
- Flinch (state 30) plays the zone's clip one-shot; zones 0–2: 44, 3–5: 47,
  6–8: 45, 9–11: 46, 12–16: 27 (3.30 s). Prone: state 31, clip 26, which
  ignores new flinches for 20 ticks. Rolls, stance transitions (4, 5, 13–16,
  20, 21, 25) and the deaths cannot flinch.
- Standing death (32): HumanAI SetDeathAnimation (H+0x3acc) if set; else
  r = rand % 2 (level RNG, always drawn) and
  - type 0/1: FUN_0045c820: zero direction → clip 28; otherwise with the
    blast/shot direction v: dot(v̂, forward) > 0 (from behind) → heading =
    γ(v) and clip **71** (falls forward, 2.4 m); else heading = γ(v) + π
    and clip **28** (thrown back, 1.46 m); γ(v) = acos(v.y/|v|), negated
    for v.x > 0 (FUN_00486950);
  - type 2: head zones 15 / 16 → zone-table clip 30 (10 s stagger) / 22;
    other zones {23, 22}[r].
  Kneeling death (33, from 4, 5, 13, 14, 19–25): clip 24; prone death (34,
  from 15, 16, 26–28, 31): clip 25. The gun is dropped (FUN_004e9010).
- FUN_0045c3b0 (death slide): the clip's root travel from the first to the
  last translation key (horizontal), lengthened by 1 m and turned by the body
  matrix as it was before any blown-death turn, is cast from the pelvis in 8
  directions 45° apart (set 0, FUN_004c24c0). With a hit, the body moves
  back by the part of the travel beyond the nearest hit, spread over the
  clip (−f·W / (duration × 30) per tick, FUN_0045b160); with no hit, no
  slide. Root motion keeps moving the dying body (FUN_004600f0 runs for
  every human).

## Bone-model LOD

Recovered DrawBoneMesh FUN_0052fc20 → FUN_004c4fc0 (object +0xd4 ≠ 0; the
first-person arms use LOD 0); port `web-port/src/engine/combat/soldier-lod.ts`.

- LOD i draws variant `<base>_{i+1}` (level 1: 003_01_1 … 003_01_5) skinned
  by FUN_0052be70 with index i: LOD 0 weighted, LOD ≥ 1 rigid. −1 = not
  drawn.
- With a lod.qvm ModelLODSettings entry: d = t·(z − r), z = camera-forward
  depth of the object position + the model's sphere centre (unrotated),
  r = model radius, t = tan(horizontal half-FOV) (zoom refines); culled when
  d > cutoff, else the count of "Distance to LOD i" below d. Observed
  lod.qvm: 001/003/019_01_1 at 5 / 9 / 40 / 50 m, cutoff **80 m** (a soldier
  past ~81 m deep is invisible at the normal 90° view); 000_01_1 at 80 / 90 /
  100 / 110 m, cutoff 120 m. 015_01_1 has no entry (port: LOD 0).
- Inferred: the model record's sphere is the .mef HSEM chunk (centre words
  12–14 = record +0x30, radius word 30 = +0x78; 003_01_1: 3778 units).

## First-person arms and weapons

Recovered from FUN_004632d0 (creation), FUN_00463840 (per-frame placement),
FUN_00464490 (eye), FUN_00463470 (view angles), FUN_0040f5a0/0040fc60/
0040f6c0 (weapon clips).

- Model `005_01_1`, skeleton 5, LOD 0, starts clip 2; textures 005_04_1,
  005_02_1, 005_03_1 (location0.mtp → `missions/location0/common/textures/location0.res`).
- **Camera (eye)** = human position + (0, 0, 2826.24) units (0.69 m above the
  pelvis-level position, ≈ 1.66 m above the feet) standing; + 1433.6 units
  crouched. A lean offset (arms+0x19c) is added in view space with a
  collision check.
- **Arms placement** each frame:
  `position = eye + R·rootTranslation(t) + pullback·forward (+ shake z)`,
  `R = Euler(view pitch + recoil, shake, view yaw + recoil) · Euler(sway α, 0, sway γ)`
  (FUN_004a9bc0 Rz·Ry·Rx). The root translation of the 005.iff clip is the
  arms root's offset from the eye in view axes (x right, y forward, z up),
  e.g. MP5SD stand: (−8.8, 1.6, −10.6) cm. Bones are then posed with the
  root rotation R (FUN_00464370 → FUN_004c9f50). There is **no hard-coded
  hold offset**; it is all animation data.
- Wall pull-back: a ray 2048 units (0.5 m) forward; on a hit at distance d
  the arms move back by 2048 − d, approached at 113.8 units/update (75.9
  when returning).
- Weapon switch: arms snapped to sway (−0.611, −0.349) rad and returned to
  0 at 0.0582 / 0.0332 rad per 30 Hz update (FUN_0040f7f7 → FUN_00463410 /
  FUN_004633e0).
- Default FOV: arms+0x1e4 is compared with tan(π/4) and set to tan(π/6) when
  zooming (FUN_00463470): 90° default (inferred meaning).
- Weapon clips play on the arms (FUN_004cc860(arms+0x68, 0, weapon field
  +0x684/+0x688/…)); the clip ids are the WeaponConfig fields (observed,
  `weapons/weaponconfig.qvm`):

| Weapon | Gun model | Stand | Move (loop) | Fire | Reload |
|---|---|---|---|---|---|
| MP5SD | 103_01_1 | 18 | 19 | 20 | 21 |
| Glock 17 | 117_01_1 | 14 | 15 | 16 | 17 |
| Desert Eagle | 106_01_1 | 31 | 32 | 33 | 34 |
| Colt Anaconda | 101_01_1 | 35 | 36 | 37 | 38 |
| Uzi | 111_01_1 | 6 | 7 | 8 | 9 |
| Uzi ×2 | 111_04_1 | 70 | 71 | 72, 73, 74 | 75 |
| M16A2 | 108_01_1 | 2 | 3 | 4, 39 | 5 |
| AK47 | 100_01_1 | 10 | 11 | 12 | 13 |
| Minimi | 107_01_1 | 64 | 65 | 66 | 67 |
| SPAS12 | 109_01_1 | 58 | 59 | 60 | 61 |
| Jackhammer | 125_01_1 | 51 | 52 | 53 | 54 |
| Dragunov | 105_01_1 | 43 | 44 | 45 | 46 |
| Grenade / Flashbang | 135_01_1 / 137_01_1 | 22 | 23 | 24, 25 | – |
| RPG-18 | 110_01_1 | 55 | 56 | 57 | – |
| Prox. mine | 136_01_1 | 40 | 41 | – | – |
| Medipack | 121_01_1 | 76 | 77 | 78, 79, 80 | (5) |
| Knife | 133_01_1 | 26 | 27 | 28, 29, 30 | (5) |
| Binoculars | 102_01_1 | 68 | 69 | (4) | (5) |

  Stand clips are 1.97 s one-shots, move clips 0.97 s loops, fire clips
  0.5–0.7 s; reload clips carry the reload sound triggers (MP5SD 1006–1011).
  Third-person upper-body clips (`UpperBody*Anim`, 135–232) are in 000.iff.
- **Gun parts**: gun body on bone 3, magazine (GunClip) on bone 52, moving
  part (GunMovingPart) on bone 55, identity offsets. Observed: in each
  weapon's stand clip, relative to bone 3, bone 52 sits within 0.15 cm of the
  gun model's magazine ATTA part for Glock, Colt, Desert Eagle, MP5SD, Uzi,
  AK47, Minimi, Jackhammer and Dragunov (M16A2: 4.3 cm), and bone 55 within
  0.1 cm of the slide/bolt/pump part for Glock, Desert Eagle, Uzi, AK47 and
  SPAS12 (MP5SD bolt: 11.8 cm); the grenade's pin and lever parts sit on
  52/55 (0.1 cm). During the MP5SD reload bone 52 leaves with the left hand
  (0.67–1.0 s) and bone 55 is pulled back (2.33 s). The attaching code
  itself was not found (inferred).

## Textures (level 1)

From `missions/location0/level1/level1.mtp` (textures in
`missions/location0/level1/textures/level1.res`), by material slot:

- 003_01_1: 004_07_1, 004_09_1, 004_10_1, 004_12_1, 004_11_1, 015_13_1,
  004_08_1, 018_02_1, 018_03_1 (green fatigues, vest, beanie — textured
  preview checked).
- 019_01_1: 019_03_1, 007_10_1, 007_12_1, 007_11_1, 019_02_1, 019_06_1,
  019_07_1, 018_03_1, 015_05_1, 015_13_1, 019_01_1, 019_05_1, 000_10_1,
  000_09_1.
- 001_01_1: 001_11_1, 018_02_1, 018_03_1, 001_09_1, 001_12_1, 015_13_1,
  001_10_1, 007_10_1, 007_12_1, 007_11_1, 016_06_1, 016_07_1.
- 000_01_1: 000_03_1, 000_02_1, 000_06_1, 000_01_1, 000_09_1, 000_08_1,
  015_13_1, 000_05_1, 000_04_1, 000_07_1.

## Validation (tools/igi_anim.py, tests/characters.test.ts)

- All 6 `.iff` files and 26 bone models decode with every count, size and
  weight check (observed).
- Bind pose = authored pose (influence agreement above); wrong skeleton or
  wrong parent/child order fails.
- Walk cycles keep a foot planted (< 0.25 m/s) for 77% (clip 4) / 90%
  (clip 57) of the cycle with the recovered math; reversing the quaternion
  product drops this to 46%, omitting the root translation to 0%, conjugated
  quaternions to 2%.
- Speeds (root track): walks 1.1–1.5 m/s, runs 2.7–4.5 m/s.
- Previews (orthographic, `--png-dir`) show a coherent ~1.8 m soldier with
  feet on the ground; a textured render of 003_01_1 and a camera-space
  render of the arms holding the MP5SD (gun on bone 3) look like the game.

## Port integration

- Load `common/anims/001.iff` (soldiers), `005.iff` (arms) and, for
  completeness, `000.iff`/`006.iff`; `readAnimations` per file. Soldier
  models from `level1.res` (`readSkinnedModel(buffer, skeleton)`), arms and
  guns from `location0.res`.
- Units/axes: everything is IGI units (4096 = 1 m), z up, model forward +y.
  Convert positions with `coords.ts` ((x, z, −y)/4096); for quaternions
  (x, y, z, w) in IGI axes the engine quaternion is (x, z, −y, w).
- Exact skinning: `poseVertices(model, poseSkeleton(skeleton, sample.rotations, objectRotation))`
  each frame into a dynamic BufferGeometry (≤ 1100 vertices per soldier).
  GPU alternative: `skinBuffers` + three.js SkinnedMesh with bone inverses
  from `bindMatrix` (4 strongest influences; approximate).
- Placement: feet at the soldier's ground position; add
  `(0, 0, rootTranslation.z)` (and the horizontal root motion if the clip
  drives movement) rotated by the yaw.
- Clips: run the recovered state graph (`engine/ai/soldier-graph.ts`,
  `SoldierMotor`): every state switch plays its clip at once (blend 0),
  the body moves by the root delta sampled before the advance, the pose
  is drawn at the advanced time with the upper-body aim, and the LOD
  variant is chosen per camera (`soldier-lod.ts`).
- First person: arms root at `eye + R·rootTranslation`, posed with root
  rotation R = camera orientation; gun body/magazine/moving part on arms
  bones 3/52/55 with the WeaponConfig clips (MP5SD 18/19/20/21).
- Blends: the player's body, the arms and the soldiers all run the blend
  tree of `engine/world/bone-anim.ts` (root sample, then advance; pose from
  the blended tree).
- Animation steps at 30 Hz in the original; continuous sampling is a
  smoothing.

## Open questions

- The code that attaches gun models to arms bone 3/52/55 and soldier bone 22
  was not located; both are inferred from exact data fits.
- Non-sound triggers other than 11 (grenade release) and 12 (close-combat
  blow), and the three floats of each event, are not confirmed.
- The relative LOD rule's constants for bone objects (LODSettings "Bone
  Objects" values vs the globals FUN_004c4fc0 reads) were not traced; every
  level-1 soldier model except 015_01_1 has explicit lod.qvm distances.
- The female and RPG graphs (13 / 15 states) were not decoded; the pistol
  graph's duplicated tick functions were not compared line by line.
- The use handler (channel 24, FUN_0045b940: states 36 / 37, task kinds 2 /
  3 / 6) and channel 28 (weapon change) are not ported.
- Skeletons 2 and 3 (002/003.iff) are not used in level 1 and were not
  labelled.
