# Wire tasks (zip lines and hand-over-hand cables)

How igi.exe places, draws, collides with and uses `Wire` tasks. Port code:
`web-port/src/loaders/wire.ts`; tests: `web-port/tests/wire.test.ts`.

Evidence labels:

- **observed**: measured in the game data (file and method named);
- **recovered**: read from igi.exe code (addresses given);
- **inferred**: an interpretation that fits code and data but is not proven.

Units are IGI units (4096 = 1 m), z up, right-handed. Matrices are
row-major `m[r*3+c]` applied to column vectors, the same layout as the
engine's object rotation at `obj+0x70` (FUN_004c5aa0 computes
`R·(S·v)` with it).

## Summary

- A wire is **one rigid instance of its model**:
  - rotated so that model +y points from Start to Stop;
  - stretched along model y by `|Stop − Start| / 4096`;
  - placed at the **midpoint**.
- There is no sag, no segmenting and no generated geometry. Nothing else is
  drawn: there are no pulleys and no end-cap objects.
- It is drawn by the normal rigid-object path: vertex-lit, object fog.
- **Bullets** test it. The ray code ignores the y stretch, so only the
  **middle 1 m** of the cable can be hit.
- **Characters and AI sight** never test it. Bullets leave **no decal** on it.
- **The player can use it.** A downhill wire is slid down. A level wire is
  crossed hand over hand.

## 1. Type registration [recovered]

`FUN_0043e1b0` (called from the type-init list `FUN_00405f30` at 0x406101):

- `FUN_00401940("Wire", 0x138, FUN_004baae0())`: the class is 0x138 bytes and
  its parent is **RigidDynCubeObj**, so it inherits every rigid-object
  handler it does not override.
- The type id is stored at `DAT_0057f67c`.
- The parameter schema is `DAT_0057f680`. `FUN_0043e9c0` unregisters both
  (called from FUN_00406240).

| Slot (getter) | Handler | Meaning |
|---|---|---|
| 0 (create) | `FUN_0043e3b0` | `FUN_004bb930` rigid defaults (rotation I, scale 1, `+0x94 = 0`); octree insert at the origin with radius = 1.0 (no model yet); zero Start/Stop (+0xf0…+0x11c), Model string (+0x120) and the three flags +0x130…+0x132 |
| 1 (tick) | `0x43e500` | `isLastInUse (+0x131) = isInUse (+0x130)` |
| 2 (destroy) | `FUN_0043e520` | unregister, release model, remove from octree |
| `DAT_0054a16c` schema | `0x43e580` | returns `DAT_0057f680` |
| `DAT_0054a16d` compile | **`FUN_0043e590`** | **placement**, section 3 |
| `DAT_00549e30` / `e34` | `FUN_0043e8c0` / `FUN_0043e940` | register / unregister the script variables `"%s_isInUse"` (+0x130) and `"%s_isLastInUse"` (+0x131), strings 0x53a4a4 / 0x53a494 |
| `DAT_0053742a` | `FUN_0043e720` | use-target test: closest point on the wire (section 6) |
| `DAT_0053742b` | `0x43e880` | returns **9** (the "wire" interaction kind) |
| `DAT_0053742c` | `0x43e890` | `isInUse = 1` |
| `DAT_0053742e` | `0x43e8a0` | HUD action icon `a_wire` (`FUN_00485130`, docs/hud.md) |
| `DAT_00537430` (character-sweep filter) | `0x4159a0` | always skip |
| 8 (sight / transmission) | **0** | cleared at 0x43e2f9, so the sight ray never tests a wire |
| `DAT_0053e894` (bullet-hole decal; defined in `FUN_0047b630`, the BulletHole registration; RigidDynCubeObj handler `FUN_0047b9d0`) | **0** | cleared at 0x43e30d, so no decals |

Ray slots 9 and 10 (`FUN_004b7a60`) and the draw path are **inherited
unchanged**.

## 2. Parameters

- Schema [recovered, 0x43e320–0x43e397, `FUN_004e8730` stores
  `field − base` offsets]. There are three parameters:
  - `+0xf0`: ObjectPos, 3 × f64 (type id `DAT_00801370`);
  - `+0x108`: ObjectPos (same type id);
  - `+0x120`: string (`DAT_00801f6c`).
- Names [observed, `objects.qvm`, `Task_DeclareParameters`]:
  `Wire: "Start position" ObjectPos, "Stop position" ObjectPos,
  "Model" String16`.

Level 1 [observed, `missions/location0/level1/objects.qvm` via
`tools/level_tasks.py read_tasks`]:

- three Wire tasks, all children of a Container (id −1), all with model
  `320_01_1`;
- base ground z = player z − 8544 = 174,413,136.

| Id | Start | Stop | Length | Pitch | Height above base ground | Use |
|---|---|---|---|---|---|---|
| 3500 | 24631402, −56199400, 174434752 | 24760932, −56297984, 174434752 | 39.74 m | 0° | 5.3 m → 5.3 m | traverse |
| 3501 | 24649340, −55968532, 174500528 | 24441278, −56246268, 174470384 | 85.04 m | −4.96° | 21.3 m → 13.7 m | slide |
| 3502 | 24472610, −55944580, 174442496 | 24446002, −56045108, 174433600 | 25.48 m | −4.89° | 7.2 m → 5.0 m | slide |

No mission script reads `isInUse` / `isLastInUse` [observed: no such
string in `missions/location0`].

## 3. Placement (FUN_0043e590) [recovered]

```
d      = Stop − Start                         (f64; +0x108 − +0xf0)
L      = |d|                                  FUN_004a9410
u      = d / L                                FUN_004a93e0, then cast to f32
R      = frame(u)                             FUN_00486a60 → +0x70 (10 dwords copied)
scale  = (1, L · DAT_005314b0, 1)             +0x9c = L / 4096 (fmul at 0x43e60d);
                                              +0x98, +0xa0 keep 1.0 from FUN_004bb930
model  = lookup(Model)                        FUN_004c82b0 ("missing" if not found) → +0x6c
pos    = (Start + Stop) · DAT_00531580        0.5 → FUN_004bcb60 writes +0x20 and moves
                                              the octree entry, radius
                                              = model+0x78 × max(scale)
world(v) = pos + R · diag(scale) · v
```

**Frame** `FUN_00486a60(out, u)`. The columns of R are the model axes in
world space:

- model **y = u** (the wire direction);
- if `|u.z| ≤ 0.95` (`DAT_00531658`, f32):
  - x = normalize(u × Ẑ) = (u.y, −u.x, 0)/‖·‖, which is horizontal;
  - z = normalize(x × u), which is world up made perpendicular to the wire;
- otherwise (near-vertical wire):
  - z = normalize(X̂ × u) = (0, −u.z, u.y)/‖·‖;
  - x = normalize(u × z).

R is right-handed (x × y = z). A wire along +y gives the identity.

**Key points:**

- **Pivot:** the midpoint. With model y ∈ [−2048, 2048], the model end
  y = −2048 lands on Start and y = +2048 on Stop.
- **Stretch:** non-uniform, along model y only. The 1/4096 factor is
  **hard-coded**, not read from the model. A model that is not 4096 units
  long and centred on y = 0 would not span Start..Stop.
- **Roll:** model z is as close to world up as possible. There is no roll
  parameter.
- **Sag:** none. Nothing in the Wire code bends or subdivides the model.
- **Odd detail:** the copy into +0x70 is 10 dwords from a 9-float buffer, so
  +0x94 receives one uninitialised stack dword. The rigid draw `FUN_0052e5d0`
  reads +0x94 into a local with no traced use. [recovered copy; harmless
  effect inferred]

**Model 320_01_1** [observed, `level1.res` member `LOCAL:models/320_01_1.mef`,
decoded with `web-port/src/loaders/mef.ts` and a chunk dump]:

- **Shape:** a closed triangular prism of 18 vertices and 8 triangles, one
  render block.
  - y: −2048…+2048 (exactly 1 m);
  - x: −54.9…+54.9 (2.7 cm);
  - z: 0.21…127.99.
  - The cross-section is an apex at the bottom (z ≈ 0.2) under a flat top
    (z = 128). So the cable runs along the Start–Stop line and up to 3 cm
    above it.
- **UVs:** v runs 0 → 1 along the length, so one texture repeat is
  stretched over the whole wire.
- **HSEM, read as the runtime model header** (FUN_004c4d00 reads +0x30…+0x3c,
  FUN_004c59a0 reads +0x78):
  - +0x30: sphere centre (1.03, −2.27, 64.57);
  - +0x3c: sphere radius 2052.02;
  - +0x78: origin radius 2052.73, the farthest vertex from the origin;
  - +0x7c: point count 2.
- **XTVM** (16-byte records, f32 xyz + u32 0xffffffff) holds two points:
  (17.6, −2048, 121.5) and (17.6, +2048, 121.5), one per end.
  - The runtime reads the points at header +0x88, 16-byte stride
    (FUN_004c59c0 / FUN_004c5aa0). That this array is XTVM is
    **inferred**: the count and values match, but the loader fix-up was not
    traced.
- **No attachments:** ATTA is empty.
- **Render block:** deferred flag 0 and additive bit 0, so it is opaque.
  The model type is 0 (rigid, vertex-lit).
- **Collision set 0:**
  - 8 faces, one surface;
  - material **7 SoftMetal** (hardness 3, ricochet 30°, `bul_metal_sft`);
  - texture slot 0.
- **Collision set 1:** empty.
- `320_02_1` is a different model, the SplineObj cable segment
  (12 SplineObjWaypoint "Segment Model" uses in level 1). It is not part of
  Wire.

## 4. Drawing

- **World matrix** [recovered]. Wire registers no draw handler. The rigid
  draw `FUN_0052e5d0` builds the world matrix this way:
  1. copy the +0x70 rotation;
  2. multiply column c by `scale[c] · 0.001` (DAT_00b7092c);
  3. add translation `(pos − camera) · 0.001`;
  4. set it with `FUN_004933d0` and SetTransform (device +0x2c).

  That is exactly `T(pos) · R · diag(scale)`. The same scaled matrix is used
  for the model's points (`FUN_004c5aa0`).
- **Lighting and fog** [recovered path, flags observed]: 320_01_1 is drawn in
  the "Object, vertex-lit" path of docs/rendering.md §5:
  - D3D lighting, MODULATE(texture, diffuse);
  - object fog (D3DFOG_EXP);
  - ZBIAS 3, CULL CCW.
- **Light multipliers.** Wire never sets the per-object directional-light
  multipliers. EditRigidObj copies its "Dirlight Angular Effect" and
  "Dirlight Ambient Effect" into these fields in FUN_004e9810. So a wire keeps
  the FUN_004bb930 defaults: angular +0xa8…+0xb0 = 1, ambient +0xb4…+0xbc = 0.
  How the lighting code consumes them was not traced. [recovered defaults]
- **Normals.** The stretch only scales model y. The side normals of 320_01_1
  have y = 0, so lighting on the long faces does not depend on the stretch.
  [observed normals; consequence inferred]
- **LOD and cull** [recovered FUN_004c4d00 + observed `lod.qvm`]:
  - `ModelLODSettings(320_01_1)` has distances 7, 17, 17, 17 and cutoff 25.
  - The cull test is `t·(z − r) > 25 m`, where:
    - z is the view depth of `pos` plus the model's +0x30 centre offset,
      which is not rotated;
    - r = 2052.02 × max(scale);
    - t = tan(hFOV/2) = 1 for the player.
  - So a wire disappears when its midpoint is deeper than about L/2 + 25 m
    (3500: 44.9 m; 3501: 67.6 m; 3502: 37.8 m).
  - Only `_1` exists, so the LOD index is always 0.
- **Octree / visibility** [recovered]. The octree sphere is centred on
  `pos` with radius 2052.73 × max(scale). Unlike EditRigidObj (FUN_004d37c0,
  FUN_004d75d0), a wire is not registered with sectors. [recovered absence]

## 5. Collision and sight

Who tests a wire (docs/collision.md §6):

| Query | Result | Evidence |
|---|---|---|
| Character wall sweep (set 1, filter 0x537430) | **skipped** | Wire registers `0x4159a0` (always skip) at 0x43e2ac; set 1 is empty anyway [recovered + observed] |
| Ground probe / footsteps (set 1) | nothing to hit | set 1 empty [observed] |
| AI sight (method 8) | **skipped**: wires never block sight | slot 8 cleared at 0x43e2f9 [recovered] |
| Bullets (set 0, method 9) | **tested** | inherited FUN_004b7a60; Wire does not set the bullet filter 0x53742f [recovered] |
| Bullet-hole decal | **none** | slot `DAT_0053e894` cleared at 0x43e30d; the impact code calls it only when non-null (0x47cdc2) [recovered] |

**Bullet pose** [recovered, FUN_004b7a60]:

1. **Broad phase:** a box test against `pos ± model+0x78 × max(scale)`. This
   covers the whole stretched wire.
2. **Into model space:** both ray end points become `R^T(p − pos) / scale.x`.
   **All three axes are divided by +0x98** (nine `fdiv [esi+0x98]` at
   0x4b7d70…0x4b7fa8). For a wire scale.x = 1, so the face and sphere-tree
   test runs against the **unstretched** model. That is the middle
   4096 units (1 m) of the cable, at `pos`, rotated by R (`collisionMatrix`
   in wire.ts).
3. **Reported hit point:** mapped back with the per-axis scale,
   `pos + R·diag(scale)·hit_local` (0x4b8dd7…0x4b8e17). A hit at
   model y = h is therefore reported h·L/4096 from the midpoint, not at h.
4. **Hit distance** used for nearest-hit ordering is re-measured with the
   per-axis scale when scale ≠ (1,1,1). [recovered; which locals hold the
   hit point there is read from the decompile, not single-stepped]

**Hit effects:** SoftMetal sound and effect, penetration hardness 3 vs the
weapon. The general bullet rules apply (docs/gameplay.md). [inferred: the
Wire type changes nothing else on that path]

## 6. Runtime: use by the player [recovered unless noted]

The wire is a usable object, like ladders and doors. It is not inert.

### Target selection

- **Closest point** (`FUN_0043e720`):
  - F = `FUN_0043e9e0(wire)` = frame(normalize(world point 1 − world
    point 0)). The world points come from the model points through
    `R·diag(scale)`. For 320_01_1, F equals R to about 1e-7.
  - y = F.y · (human − pos), clamped to [p0.y·sy, p1.y·sy] = [−L/2, +L/2].
  - The candidate point is `pos + F.y · y`.
- **Picking:** `FUN_004159d0(search, wire, point)` accepts the point when it
  is within the search range (search context +0x78, measured from its origin
  at +8) and in front of its view axes (+0x20…+0x40; view-space y > 0). It
  keeps the candidate with the smallest horizontal and vertical angles
  (+0x70 / +0x74; the winner is stored at +0x80).
- **HUD and kind:** the HUD shows `a_wire`, and the kind is 9.

### Choosing the mode

`FUN_0040ce30` case 9 calls `FUN_0043ea60`:

1. α is the first angle of FUN_004a9f30 on F, `atan2(F[7], F[8])`. That is
   the pitch of Start→Stop.
2. α is wrapped to [0, 2π) when negative.
3. The test is `|α| > 2°` (`DAT_00531834`).
   - True: **slide** (flag `human+0xda0`).
   - False: **traverse** (flag `human+0xd93`).

Because of the wrap, these wires **slide**:

- every wire whose Stop is lower than its Start, at any angle;
- a rising wire steeper than 2°.

Only a level wire, or one rising by 2° or less, is crossed hand over hand.
In level 1: 3500 is traversed, and 3501 and 3502 are slid. They slope down
about 5°, so the result is the same either way.

### Attach

`FUN_00411a80` (traverse) and `FUN_00411ec0` (slide) place the player at a
hold point:

- y = F.y·(human − pos), clamped to [−L/2 + m, L/2 − m];
- hold = `pos + F.y·y − F.z·h`.

| | traverse | slide |
|---|---|---|
| end margin m | 3072 (0.75 m, `DAT_005314f0` f32) | 2048 (0.5 m, `DAT_00531500` f32) |
| hang h below the wire | 2150.4 (0.525 m, `DAT_005314e8` f64) | 3686.4 (0.9 m, `DAT_005314f8` f64) |
| heading | heading of F, +π when y > 0 (face the far end) | heading of F; the slide direction p1 − p0 is negated (+π) when it points up, so the slide always runs downhill; stored at human+0xda4 |
| human state | 0x2a (state table +0xa8) | 0x2b (+0xac) |
| sound | `wire_drag_1` / `wire_drag_2` alternating per hand step (code at 0x40dea4: input bit 0x80 plays the hand animation at speed +1, bit 0x100 at −1) | looping `wire_slide_1` (handle human+0xdb4) |

### While attached

The same functions run each tick. Leaving [−L/2 + m, L/2 − m], certain
input edges (human+0x1d4 / +0x134) or state flag 0x20000 detach the player:

- `isInUse` is cleared;
- the state becomes 0x1d, or 0x2f with that flag.

### Slide state update

Correction (docs/interactions.md §5, recovered): the wire slide is player
state 43 (`FUN_0040df90` enter, `FUN_0040dff0` tick): speed s = 0.99 s −
dir.z × 88.309761 (`0x531470`, `0x531474`), air velocity = dir × s, with
`wire_slide_1` started by the attach (`FUN_00411ec0`). `FUN_0040dca0` /
`FUN_0040dcf0` (×0.99, vz − 44.6) is the **ladder** slide (state 40), and its
"bit 4" is the grounded state flag. Input flags 0x80 / 0x100 are MoveUp /
MoveDown (`FUN_004106b0`). While attached the body moves by the clip's root
change plus the air velocity through `FUN_004600f0` with `+0x694 = 1` (no
collision); `human+0x76c` / `FUN_00461930` is the moving-platform path, not
the wire.

## 7. Port integration

Use `wirePose(start, stop, readWireModelInfo(mef))` from
`web-port/src/loaders/wire.ts`:

- **Drawing:** one `LevelInstance` per Wire task, model = the "Model"
  parameter. In IGI space, use position `pose.position` and linear part
  `pose.linear` (= R·diag(1, L/4096, 1)).
  - `igiRotationToEngine` (C·M·Cᵀ) is valid for this non-orthogonal matrix,
    and `engineMatrix4` gives the Three.js matrix.
  - The instance matrix **must carry the y stretch**. Its determinant is
    L/4096, not 1.
  - Three.js' normal matrix handles the non-uniform scale.
- **Bullets:** to match the exe, test the model with `pose.collisionMatrix`
  (rigid, unstretched). Optionally report the hit point through
  `pose.matrix`.
- **Sight and sweeps:** exclude Wire from AI sight. Set 1 is empty, so
  character sweeps never hit it anyway.
- **Use:** `wireUseMode(wireAttachFrame(pose, info))` and
  `wireHoldPoint(...)` reproduce the selection and attach rules of section 6.

## 8. Open questions

- Which consumer of `obj+0x94` exists in the render path, if any (it is
  garbage for wires).
- (Answered in docs/interactions.md §5: the attached movement, the hand
  steps and the input flags.)
- The XTVM → model+0x88 load-time fix-up (only inferred from count and
  values).
- How the per-object light multipliers +0xa8…+0xbc enter vertex lighting.
