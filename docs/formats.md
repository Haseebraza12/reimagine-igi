# Measured file formats

These notes describe the supplied installation (mission 1, "Trainyard") and
record how each claim is supported. Labels: **observed** (measured over the
files), **recovered** (static analysis of the files or `igi.exe`),
**inferred** (consistent with the data, not directly confirmed).

The browser port decodes all of these at runtime (`web-port/src/loaders/`);
the Python tools in `tools/` are the reference/research implementations.

## Coordinate system and transforms

| Claim | Evidence | Confidence |
|---|---|---|
| 4096 units = 1 m | Community note; four 14 m fuel-tank models are placed exactly 65,536 units (16 m) apart; player physics notes use the same scale | recovered |
| x, y horizontal, z up | Buildings share z = 174,413,136; AI graph nodes vary < 1.5 m in their third coordinate | observed |
| Right-handed | On model 203_01_1 the "V-17" label texture's u increases along +y on a +x-facing face; text reads left-to-right only in a right-handed frame | recovered |
| Task orientation gamma = counter-clockwise rotation about +z | With this sign 0 of 876 base AI walk-graph links pass through any rotated building; with the opposite sign 23 do | recovered |
| alpha/beta applied as Rz(γ)·Ry(β)·Rx(α) | Order untested: few placements use them | inferred |
| Models (characters, vehicles) face +y | The objective trigger beside truck 622_01_1 is at its +y (cab) end; the "Jones drive truck" figure shares the truck's gamma and sits left of centre (left-hand drive) | recovered |
| Model triangles are Direct3D clockwise-front | 79% of all triangles (92% of type-3) are clockwise relative to their stored normals | observed |
| ATTA matrices are applied as row vectors (v · M) | Rotated attached furniture then sits inside its rooms with 0 wall penetrations (desks), against 40 per desk with column vectors; totals 1,239 vs 1,827 | recovered |

The web port maps IGI (x, y, z) to engine metres as (x, z, −y) / 4096
relative to an origin (player x/y, base ground z). That is a proper rotation,
so nothing is mirrored; a character's IGI gamma equals the engine yaw.

## Resource containers: ILFF / IRES (`.res`)

All 53 `.res` files parse. Root: `ILFF`, u32 total size, u32 alignment (4 or
32), u32 0, `IRES`. First child at `align_up(20, alignment)`. Child header
(16 bytes): tag (`NAME`, `BODY`, `CSTR`, `PATH`), u32 payload length, u32
payload alignment (against the file origin), u32 delta to the next header (0
for the last). `NAME` carries the NUL-terminated virtual name of the next
payload. The final payload ends at EOF. [observed; `research/resources.json`]

Language files (`language/english/*.res`) store `CSTR` strings keyed by name,
e.g. `M1_OBJ1` = "Steal the truck near the main entrance." [observed]

## Textures: LOOP v11 (`.tex` in model texture archives)

Offset 8 u32 format, 22/24 u16 width/height, 26/28 repeated storage size,
30 u16 bytes per pixel, 32 base-level pixels (rows top-down); trailing bytes
are further mip levels (not decoded). [observed]

- Format 2, 2 bytes: A1R5G5B5. Of the 281 such textures level 1 renders, 277
  have the alpha bit set on every pixel and 4 mix 0/1 (cut-outs), so bit 15 =
  1 means opaque. [observed]
- Formats 3 and 67, 4 bytes: BGRA8888; 6 have binary alpha (cut-outs), 13
  smooth alpha (railings, tinted glass). [observed]
- v = 0 is the top row: the "V-17" label renders unmirrored and readable with
  top-down rows and no flip. [recovered]

## Terrain textures: LOOP v9 (`terrain.tex`)

52-byte header (layer count at 0x20 = 18, footer offset at 0x1C), 32-byte
layer records at 0x34 (u32 pixel offset, u32 mode, u16 row bytes, u16 width,
u16 height). Level 1: 18 layers of 128 × 128 A1R5G5B5, contiguous from 0x274.
The trailing `LOOP` v6 footer is not read by the game. [observed + recovered]

## Scripts: LOOP v8 (`.qvm`)

Header, opcodes and the call-tree grammar: [qvm.md](qvm.md). Every script
shipped with mission 1 (`objects.qvm`, `terrain.qvm`, `magicobj.qvm`,
`weaponconfig.qvm`, `humanplayer.qvm`, `config.qvm`) parses completely.

### Mission task tree (`objects.qvm`)

`Task_DeclareParameters(type, name, kind, ...)` statements declare schemas;
`Task_New(id, type, name, params..., children...)` instantiates them. Widths
per kind: `ObjectPos`, `RGB`, `Real32x3`, `Real64x3` → 3 values; `Real32x9`
→ 3 values (the editor's 3×3 matrix is stored as alpha/beta/gamma radians);
`Graph` → 3 (node count, capacity, link count); `AnimData` → 1 + 2n (count
then n pairs); all others → 1. With these widths all 1,362 `Task_New` calls
consume their parameters exactly and every remaining argument is a child
`Task_New`. [observed] Readers: `web-port/src/loaders/tasks.ts`,
`tools/level_tasks.py`.

Used by the port: `HumanPlayer` (spawn, heading, loadout), `HumanSoldier` +
`HumanAI` (soldiers, AI type, weapon), placement tasks (`Building`,
`EditRigidObj`, `Door`, `Car`, `Fence`, `Switch`, …), `SplineObj` /
`SplineObjWaypoint` (railway, cables), `AreaActivate`, `StatusMessage`,
`EditVariable`, `DefineComputerObjective` (objective and its area),
`FlatSky*`, `GlobalLightKeyframe`, `DirlightKeyframe`, `HeightMap`,
`TextureModifier`, `TerrainLightMap`, `LightmapInfo`.

Logic-only tasks (`AlarmControl`, `SCameraControl`, `Terminal`) use the editor
gizmo model `waypoint`, whose only render block has material slot −1; it is
never drawn. All `SplineObj` tasks have "Display waypoints" = FALSE, so
waypoint models are hidden; segment models are drawn. [observed]

### Spline objects

Each `SplineObjWaypoint`'s "Segment Model" spans the curve to the next
waypoint; model local +x (from x = 0, or centred) runs along the curve. The
130 m railway model 368_01_1 matches the 130 m spacing of straight railway
waypoints exactly, and waypoint gamma matches the chord bearing (wp0: 180° vs
183.7°). [observed] Curves (`Linear Segments` = FALSE) are drawn as cubic
Hermite curves with tangents along each waypoint's gamma. [inferred; the
original uses "Number of Matrices / Segment" rigid pieces]

## Models: `.mef` (nested ILFF, form `OCEM`)

All 601 models in the level-1 and location0 archives start with the chunks
HSEM ATTA XTVM TROP XVTP CFTP D3DR DNER XTRV, optionally followed by PMTL
and the collision chunks (HSMC, then two sets of XTVC ECFC TAMC HPSC); all
601 decode with every count cross-check passing. [observed] Types: level 1
has 346 lightmapped (3), 46 rigid (0) and 25 bone/skinned (1); location0 has
173 rigid, 10 lightmapped and 1 bone model.

| Chunk | Layout | Confidence |
|---|---|---|
| HSEM | u32 model type at +32 | observed |
| D3DR | type 0/1: u32 _, faces, blocks, …; type 3: u32 _, lightmaps, faces, blocks, vertices | observed (all counts cross-check) |
| XTRV | type 0: 32 bytes pos·normal·uv; type 1/3: 40 bytes pos·normal·uv·uv2 | observed: bytes 12–23 are unit normals on type 3, contradicting the community reference, which places UVs there |
| DNER | linked render blocks: f32×3 centre, then int16 index count, next, material slot, [type 3: _], vertex offset, vertex count, …; then u16 block-local indices | observed: offsets chain exactly; index totals = 3 × faces |
| ATTA | 68-byte records: char[16] sub-model, f32×3 offset, f32×9 matrix (row vectors), i32 bone | observed; matrices all have det +1 |
| HSMC | two 32-byte headers {faces, vertices, materials, spheres} whose counts match XTVC (16-byte vertices) / ECFC (8-byte faces) / TAMC / HPSC | observed (492/492) |

A block's material slot indexes the model's texture list in the `.mtp`.
Bone models (type 1) store vertices in bone-local pieces (about 0.85 m tall as
stored) with packed bone references in uv2; they need the skeleton/animation
system (`.iff`) and are not rendered yet.

Magic objects (`magicobj.qvm`: 372 `DefineMagicObj(name, model, TASKTYPE)`)
classify ATTA sub-models. The port hides `DEATHZONE`, `GUNFLAME` and
`SCAMERALENSVIEWCONE` helpers and renders `GLASS` as transparent; no IGI 1
attachment is a shadow volume (the community reference describes IGI 2).

## Model/texture table: `.mtp` (EA IFF `FORM` / `MTP `)

Big-endian chunk sizes, padded to even length. `MODS` and `TEXF`: u32 LE
count + NUL-terminated names, listing the matching models/textures `.res`
members in member order. `INST`: one record per model in `MODS` order,
{u32 model index, u32 n, n × u32 texture index}, filling the chunk exactly.
[observed; the community reference's u16 layout does not parse these files]

## Sounds: ILSF (`.wav` members of `common/sounds/sounds.res`)

"ILSF", u16 format (1 = PCM), u16 bits (16), u16 channels (1), u16 flags,
u32 sample rate (22,050 / 44,100), u32 frame count, then signed 16-bit PCM;
file length = 20 + frames × 2 exactly. Format 2 (level ambience) is
compressed and not decoded. [observed]

## Weapons (`weapons/weaponconfig.qvm`)

24 `WeaponConfig` tasks with a 50-field schema (Rounds/Minute, Rounds/Clip,
Reload Time, Damage Factor, spreads, view-change recoil, range, sounds, AI
detection range, weapon type …). Example: MP5SD 700 rounds/min, 32-round
clip, 1.8 s reload, 100 m effective range, silenced for AI hearing. The
semantics of spread units and damage scaling are inferred. [observed values]

## Soldier AI data (`common/ai/`, `missions/.../ai/`, `config.qvm`)

**View.** The shared AI scripts set a soldier's view on `AIEVENT_CREATE` with
single numeric literals. [observed values; recovered with
`readQvmLiteralCalls` in `web-port/src/loaders/qvm.ts`, which accepts a call
site only if its whole call layout decodes]

| Script | SetViewLength | SetAlarmViewLength | SetViewAlpha | SetViewGamma |
|---|---|---|---|---|
| `guard.qvm`, `patrol.qvm` | 40 | 50 | 50 | 45 |
| `sniper.qvm` | 100 | 110 | 30 | 15 |

Units are recovered ([qvm-vm.md](qvm-vm.md)): the handlers store lengths as
metres × 4096 and angles as degrees × π/180. The cone test (FUN_00487d80)
uses alpha as the **vertical** half-angle and gamma as the **horizontal**
half-angle in the eye frame; every soldier also has an unscripted secondary
cone (vertical 45°, horizontal 80°, 10 m) ([ai.md](ai.md)).

**Which script a soldier runs.** Recovered from the table at 0x53a8fc:
AITYPE 0 → rpg, 1 → gunner, 2 → sniper, 3 → anya, 4 → ekk, 5 → priboi,
6 → civilian, every `*_PATROL_*` → patrol, every `*_GUARD_*` → guard.
`observer.qvm` and `radioguard.qvm` are never loaded.

**Per-soldier overrides.** Each soldier can also have a mission script,
`MISSION:AI/<id>.qsc`, where the id is the `HumanAI` task id; level 1 ships
37 of them. `AIFunction_DefaultHandler` runs the common script in the same
event context; most mission scripts call it first on create (3201.qvm first
calls `SetEventPriority(IDLE)`). Only `2209.qvm` then sets a view value of its
own (view length 20), which overrides the shared one.

**Combat settings.** `common/ai/settings.qvm` holds 87 `HumanAIConfigItem`
tasks, one per AI type and difficulty (`GD_1`–`GD_3`). Each has named
fields:
- damage scale;
- hit probability at minimum and maximum range;
- maximum rounds per sequence, and the minimum and random clip percentages
  that set sequence length;
- delays between sequences and between shots;
- targeting timeout and tracking distance;
- evasive and grenade probabilities.

The configured difficulty is `GOGameDiff(GD_2)` in `config.qvm`, matching
`config.qsc`. [observed values; how the engine applies them is inferred, see
`web-port/src/engine/combat/enemy.ts`]

## Object lighting (`lightmaps.res`, `.olm`)

Recovered from `igi.exe` (`.olm` loader `FUN_0051daa0`, draw `FUN_0052e5d0`
"DrawRigidMesh"). `tools/object_lighting.py` reproduces it from the repository
data for all 22 level-1 buildings and all 1,308 `.olm` files. [recovered;
layout observed on every file]

- **File:** a 60-byte header, then one 44-byte entry per lightmap, then
  w × h × 4 bytes per lightmap in B, G, R, A order.
  - Header: f32 0.12 (magic), then f32 model version (equal to the MEF's HSEM
    f32), then the bake date and time as six u32. The bake time must be newer
    than the model's. The lightmap count is at byte 44 and equals D3DR word 1;
    it is always 1 here.
  - Entry: width and height as s16 at +0x28/+0x2a, with copies at +4/+6.
  - Pixels: RGB is the final baked light, ambient included. Alpha is ignored.
  - The game rejects and re-bakes a file whose magic, version, time or count
    does not match its model. Every level-1 file passes these checks.
- **Naming:** `<LightmapInfo Filename>_<MMMMM>.olm`, where MMMMM is the
  position in the building's instance list. For each model, the list holds:
  1. every LOD variant (`_1` … `_n`);
  2. the ATTA sub-models that have no attachments of their own, in ATTA order;
  3. the sub-models that do have attachments, expanded recursively.

  The building's own `Model` comes first. Then every descendant task with a
  `Model` parameter follows (EditRigidObj, Door, …), in task order. This order
  reproduces all 1,308 lightmap sizes, and each size equals the model's PMTL
  size.
- **Lightmapped draw** (type-3 meshes with a lightmap): lighting is off.
  The output is the texture (uv0, wrap) × the lightmap (uv1 = XTRV uv2; clamp,
  bilinear, no mipmaps), with MODULATE ×1.
- **Vertex-lit draw** (everything else): D3D fixed-function lighting with one
  directional light and Gouraud shading:
  colour = texture × clamp(ambient + front × max(0, n·l)).
  - ambient = GlobalLightKeyframe "Ambient color object category 1".
  - front = DirlightKeyframe "Front Color".
  - l points toward the light: (cos Γ cos β, −sin Γ cos β, sin β), from the
    keyframe Beta/Gamma. For level 1, l = (0.180, −0.847, 0.500).

Port: `web-port/src/loaders/olm.ts` (file) and `loaders/level.ts` (instance
lists and the size check). Lightmaps are packed into atlas pages with
replicated borders (`engine/world/lightmap-atlas.ts`) and drawn by
`engine/world/world-builder.ts`.

## Terrain

`terrain.ctr`, `.cmd`, `.hmp`, `.bit`, `.lmp`, `.tex`, `.qvm`: see
[terrain.md](terrain.md) (decoded and validated).

## Not yet decoded

- Skeletal models and animations (`.mef` type 1, `.iff`).
- AI script behaviour (event handlers in `common/ai/*.qvm` and
  `level1/ai/*.qvm`) beyond the view constants; mission scripts beyond the
  task data.
- Compressed ILSF (format 2) sounds.
