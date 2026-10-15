# Runtime terrain: `terrain.ctr` + `terrain.cmd` (+ `terrain.hmp`)

Status: **decoded and validated** for mission 1, including the per-frame
LOD selection, geomorphing and draw (section 7). Reference decoder:
[`tools/terrain_ctr.py`](../tools/terrain_ctr.py) (stdlib Python). Browser
port: [`web-port/src/loaders/terrain-octree.ts`](../web-port/src/loaders/terrain-octree.ts),
whose heights and mesh match the Python decoder exactly
(`web-port/tests/terrain-octree.test.ts`), and
[`web-port/src/engine/world/terrain-render.ts`](../web-port/src/engine/world/terrain-render.ts)
(per-frame selection and geomorph, `web-port/tests/terrain-lod.test.ts`).

Confidence labels: **observed** (measured over all records), **recovered**
(read from `igi.exe` disassembly/decompilation, addresses given), **inferred**
(consistent with data and code, not directly confirmed). Units are IGI world
units (4096 = 1 m), z up. "Level" L is octree depth (root = 0).

## Validation

Residual = sample z − decoded surface z (the surface in that column nearest
the sample). Samples are world positions from `objects.qvm` and the AI graphs.

| Samples | n | median | within 1 cm | within 0.25 m |
|---|---|---|---|---|
| TerrainLightMap tiles (spread over ~57 km) | 268 | 8 units | 267 | 267 |
| AI graph nodes | 289 | 0 | 187 | 206 (the other 82 stand on floors/roofs) |
| Buildings | 26 | 5 units | 25 | 25 |

- The base decodes to 174,413,141.33 at all 441 points of a 21 × 21 grid over
  the building footprint; as float32 that is exactly 174,413,136, the
  buildings' z.
- The outliers are one building (472_01_1), one soldier and one AI node that
  sit inside a sealed structure about 3.2 km below the map.
- Falsification (TerrainLightMap tiles within 0.25 m): recovered rules 267;
  rotation direction reversed 128; mirror bit ignored 122; x/y fields swapped
  208; no octant permutation 12.
- Heightmap relief matters: of 45 placed objects inside the three HeightMap
  areas, 23 match within 1 cm with the relief and 0 without.

## 1. World frame

- One octree whose root cube is centred on world (0, 0, 0), half-size 2^30.
  [recovered: traversal FUN_004c6530 builds ±0x40000000 octant offsets; the
  tree origin fields +0xde0/4/8 are zeroed in the constructor at 0x4bbd40 and
  never written elsewhere]
- A node at level L has half-size 2^(30−L). [recovered]
- Outside the mission area the far field is a repeated 16 km tile instanced
  with D4 transforms around a datum at z = 2^29/3. [observed] Expanding the
  whole world at level 16 would be 6.7e9 cells, so callers choose a region.

## 2. `terrain.ctr`: 32-byte nodes (11,022 in level 1)

Node 0 is an all-zero dummy; node 1 is the root.

| Bytes | Field | Meaning |
|---|---|---|
| 0–15 | u16 A[8] | child node index for slot s when B[s] ≥ 0 [recovered] |
| 16–23 | s8 B[8] | child transform 0..7, or −1 = leaf slot [recovered] |
| 24 | u8 | bit s set ⇔ B[s] ≥ 0 [observed + recovered] |
| 25–27 | | 64, 67, 0 everywhere; no reader found [observed] |
| 28–31 | u32 | byte offset of the node's record in terrain.cmd [recovered: loader rebases it at 0x4bc7ee] |

Leaf A values are 1 (solid) / 0 (air) at depth ≤ 16 and −1 for depth-17
nodes [observed; meaning inferred].

### Octants and transforms [recovered, verified algebraically]

- Octant i = x + 2y + 4z (bit set = positive half).
- Transform t acts in the horizontal plane only: mirror x if t & 4, then
  rotate counter-clockwise by 90° × (t & 3).
- Under accumulated transform t, octant i is stored in slot PERM[t][i] (table
  at 0x545e48); the child's transform is COMP[t][B[slot]] (table built by
  FUN_004c5f40 at 0xab8920). Both tables are reproduced in the decoders.

## 3. `terrain.cmd` records (5,005, back to back to EOF)

- u16 ntri, u16 triangle bytes (= 4·ntri in all records), u16 nbase,
  u16 nextra; then ntri × {u8 i0, i1, i2, flags}; then (nbase + nextra) u32
  vertices. [recovered + observed]
- Vertex bits: x = 26–31, y = 20–25, z = 14–19, each minus 24 (always even,
  within ±24 = the node faces). Bits 0–5 of extra vertices name the base
  vertex they morph to at the coarser LOD; bits 6–9 select the texture
  projection. [recovered at 0x509620 / 0x4bf333]
- World position = node centre + xform(t, x, y, z) × 2^(27−L)/3. At level 16
  one step of 2 is 1365.33 units = 0.33 m. [recovered: FUN_00509250]
- Stored triangles are counter-clockwise seen from +z; mirrored transforms
  reverse the winding. Flag 0x10 ends a strip: each record is a list of
  strips whose consecutive triangles share two vertices, and the stored
  winding agrees with the strip parity on all 55,224 level-1 triangles
  [observed]. Bits 5–7 are set (flags 0xE0 / 0xF0) on every triangle
  [observed]; the draw reads only bit 4 [recovered 0x50cc7b].

## 4. Which nodes form the surface

Every collision path examined stops at **level 16** (8 m cells): point test
FUN_004bff90 → FUN_004bf240 descends while level < 16; ray and sweep queries
FUN_004c1270/FUN_004c2a30 test at level 16. The renderer picks a level per
cell every frame (section 7), never deeper than 16. The 2,160 depth-17 nodes
are never reached by those paths. [recovered] In the level-1 mission region
the level-16 mesh is watertight (no interior open edges).

Per level, a cell record holds at most 16 triangles (an 8 m level-16 cell is
a 3 × 3 base grid plus extra vertices) [observed over all 11,021 records].

## 5. HeightMap detail relief (`terrain.hmp`)

- terrain.hmp: 256 × {u32 runtime pointer, u32 flag, u32 side} header, then at
  0xC00 the (side+1)² signed-byte grids of the used entries in index order.
  Level 1 uses entries 0, 1, 2 (side 128, values 7..121, neutral 64).
- `HeightMap` tasks in objects.qvm (Position, Level 11, Size 128, Bitmap ID)
  snap to the level-11 node containing the position. Inside that node, a
  vertex gets r = (bilinear(grid) − 64) × 256, grid origin at the node's
  minimum corner, cell = node size / Size, for cells of level ≥ 14 (none
  below, `local_c20 = 0` at 0x509181). Level ≥ 15 cells and every extra
  vertex store z + r; **level-14 base vertices store z and the draw adds
  (1 − lod) · r**, so the relief fades in as level-14 cells come near
  (section 7). Collision (level 16) always has the full relief. [recovered:
  FUN_004fe260, FUN_00509250 0x509190–0x5094a0, x87 chop rounding at
  0x4966d0]
- These grids are small repeating detail stamps, **not** the level's height
  field (an earlier pipeline treated the first grid as the whole terrain; that
  interpretation was wrong and has been removed).

## 6. Texturing and lighting

Reference: [`tools/terrain_tex.py`](../tools/terrain_tex.py) (self-checks
below); browser port: `web-port/src/loaders/terrain-look.ts` +
`web-port/src/engine/world/terrain-render.ts`. Everything here is
**recovered** from `igi.exe` unless marked.

**terrain.tex** (LOOP v9): 18 layers of 128 × 128 A1R5G5B5 (alpha set on
every pixel), records at 0x34, pixels contiguous from 0x274. The loader
(FUN_005112b0) reads the version, the s16 at 0x12 (= 5, probably a mip count,
inferred), the palette offset, the count and the records; the trailing
`LOOP` v6 footer is never read.

**Materials and tile maps** (terrain.qvm): `CreateTerrainTileMap(id, 64
layers)` gives an 8 × 8 tile map (index vtile·8 + utile).
`CreateTerrainMaterial(id, arg, 32 × {enabled, p2, p3, scaleA, tilemapA,
scaleB, tilemapB})` gives per-level tile maps and scales; only the scale and
tile-map fields are read (FUN_00509250). Level 1: material 0 uses tile maps
0 → 1 → 2 by level; materials 1–5 use tile maps 3–7. Tile maps 2 and 3
arrange layers 3–6 and 7–10 into seamless 2 × 2 pictures [seam test below].

**Material per vertex**: `TextureModifier` tasks (Level, Material Index,
Bitmap ID) cover the level-`Level` node containing their position, and apply
to cells **finer** than that level (see "Ancestor rule" below);
`terrain.bit` holds their 1-bit masks (256 × {ptr, flag, side} header, masks
at 0xC00). For a cell the up-to-4 innermost covering modifiers are tested in
order (deeper first; within one node, earlier in objects.qvm first —
inferred, it affects 0.02% of vertices); the first whose mask bit is set at
the vertex gives the material, else material 0. Mask sample k lies at
node_min + k·node/(Size−1); x87 chop rounding.

**Layer and UVs per material and cell** (level L, centre c; both
CreateTerrainMaterial scales are stored × 0.5 by FUN_004bc890 at
0x4bc8f7/0x4bc917, s = that float32): detail layer **B**:
k = trunc(s·c) >> (22−L), slope s/half; coarse layer **A**:
k = trunc(s·c) >> (23−L), slope s·0.5/half (one A image spans two cells);
layer = tilemap[((k_y & 0x7ff) >> 8)·8 + ((k_x & 0x7ff) >> 8)] (tile map B or
A of the material's level-L record); uv = (vertex − centre)·slope +
((k & 0xff) + 1)/256. At level 16 every 8 m cell shows one whole 128-pixel B
layer. Where a vertex's projection bits are set (B: bits 8–9, A: bits 6–7),
u comes from x or y (by `(bits ^ (t & 1)) & 1`) and v from z (steep faces;
55 of 56 such vertices match the dominant horizontal normal axis).
[recovered FUN_00509250 0x509fea–0x50a0f0] Sampling: stage 0 LINEAR, MIPFILTER
POINT (nearest of the **5** mip levels 128 → 8 texels the game generates,
mip count at terrain.tex 0x12 passed to FUN_004a8690), CLAMP, MipMapControl
LOD bias [inferred: the stage-0 bias is not reset].

**Blending** (FUN_0050be70 colour table, FUN_00509250 column choice)
[recovered]: every material group of a cell draws two lists: B with vertex
colour weight and A with the complementary one. With w = 1 − lod of the
vertex's morph target (section 7), W = trunc(255 w), W2 = trunc(255 w·w):

| Vertex | B (detail) | A (coarse) |
|---|---|---|
| own material, target has the same | W | 255 − W |
| own material, target has another | W2 | W − W2 |
| target's material (that case) | W − W2 | 255 − 2W + W2 |

so at lod 0 a vertex shows its own material's B layer, at lod 1 its target's
material's A layer. The first list of a cell is opaque (ZFUNC LESS), the rest
add (ONE/ONE, LESSEQUAL); the colour is Σ Gouraud weight × layer. A list is
skipped when every base vertex of the cell has lod ≥ 0.99 (B) or ≤ 0.01 (A)
(≤ 2/255 of weight; not reproduced by the port).

**Lightmaps**: `terrain.lmp` = 268 records {u32 side, side² bytes}; record i
belongs to the `TerrainLightMap` task with TextureIndex i (sides agree
268/268; levels 4–10, sides 16–128). A cell uses the deepest TerrainLightMap
node **coarser than the cell** containing it (ancestor rule);
u = (x − node_min_x)/node_size + 0.5/side, v likewise in y
(FUN_004efac0: scale 2^−(23−L)/256, offset (256/side)·0.5/256), morphing
with the vertex like the layer uv. The lightmap is a texture (created with
0 mip levels at 0x4bc31a, so bilinear only, CLAMP) sampled per pixel in pass
2, which multiplies by palette[value] with palette[i] = min(255,
trunc(i·sun + 255·ambient)), sun = Dirlight front colour, ambient = "Ambient
color terrain" (the x87 products are exact; the sum chops). Terrain has no
vertex lighting.

**Ancestor rule** [recovered]: TerrainLightMap, TextureModifier and HeightMap
tasks are linked into the object octree with their node's box
(FUN_004bd570 → FUN_004bcf40, smallest aligned cube = the level-L node), and
their enter/exit callbacks (TerrainLightMap: 0x4eee80 pushes its index on the
stack at 0xb3d85c, 0x4eeef0 pops) run when the selection (section 7)
*refines* that node. A cell drawn at level L records the state when its
parent was refined, so a level-L task applies to cells of levels > L only
(e.g. a level-10 cell inside a level-10 lightmap tile uses the level-9 one).

**Time of day**: initialised to 0 and never advanced, which is below every
keyframe, so the earliest keyframe (Time 12) applies: ambient (0.269, 0.288,
0.327), sun (1, 0.769, 0.615) → palette[0] = (68, 73, 83),
palette[255] = (255, 255, 240).

Self-checks (`python3 tools/terrain_tex.py`):

| Check | Recovered reading | Alternatives |
|---|---|---|
| Lightmap value vs surface normal (Lambert fit R²) | 0.551 | 0.001–0.073 flipped/transposed/rotated |
| Colour step across tile-map neighbours | 31.2 / 27.1 (inside one layer: 34.0) | transposed 49.5, random pairs 53.8 |
| Lightmap value at building footprints (median) | 29 (baked shadows) | 54 shifted 8 m, 96 at 16 m; random base points 142 |

Every full-detail cell in the mission area has a lightmap; 205 of 288 AI
nodes and 22 of 25 buildings stand on "Dirt inside base" (material 4), whose
triangles are flat.

## 7. Rendering: per-frame LOD, geomorphing, far field [recovered]

**Selection** (FUN_004c7590 → FUN_004c6530, every frame and view):

- LOD threshold T = DAT_00abc9ac: the base is 0xa3 = **163** at
  `GOGfxPerformance(0)` (FUN_00405e50 → FUN_004c80f0 store it at 0x5460d8;
  0x60 with performance flag 0x10, 0x81 with 0x20); when the camera's
  tan(hFOV/2) ≤ 1, T = trunc(base / sqrt(tanX)) (pow at 0x49c620, fistp
  chop), so zooming in raises T; never below 70.
- Depth-first from the root; for each existing child (octant i in slot
  PERM[t][i]) at level L, half-size h, centre c, camera p truncated to
  integers:
  1. frustum: v = R(c − p) with the camera rotation (rows right, down,
     forward); keep if v.z > 64 − ry, |v.x| < v.z·tanX + rx,
     |v.y| < v.z·tanY + ry, where rx = 1.7321·h / cos(atan tanX) (the
     bounding sphere pushed along each side plane) and ry likewise
     (integer-accumulated rotated octant offsets in the exe);
  2. z floor: c.z + h ≥ the water plane z (terrain +0xdfc; level 1 has none:
     −2^29);
  3. **m = (max(|c − p|) − h) >> (25 − L)**, i.e. 32·(Chebyshev distance / h − 1);
  4. m ≥ T or L = 16: the child is drawn as a cell if L ≥ 7 (coarser ones
     are dropped), else the traversal descends into it.
- At T = 163 a level-L node is refined while its centre is within
  2^(25−L)·(32 + T) units: level-16 cells appear within ~49 m (Chebyshev,
  level-15 node centre), level 15 to 97 m, 14 to 195 m, … level 7 cells
  out to ~25 km (level-6 node centre), the **far-field limit** (no explicit
  draw distance; the camera far plane is 100 km). Fogged to the fog colour
  beyond ~1.43 km (f byte 0), the far cells still cut the mountain
  silhouettes out of the sky.
- No hysteresis: the set is a pure function of the camera. Built cells are
  cached in a 2048-entry hash on (x, y, z) and rebuilt when absent the
  previous frame; at most 0x1000 new cells per frame (both irrelevant to the
  image). Typical level-1 frame: ~450 cells, ~3,800 triangles.

**Geomorph** (FUN_005090a0 / FUN_0050a740 constants, FUN_0050be70 per vertex):

- offset = trunc((T + 64)·0.375) (0x532bb8), slope = float32(1/(T − 64)) ×
  2.6666667 (0x532bb0); T = 163: 85 and 0.026936.
- Base vertex: lod = clamp((d·0.375/2^(25−L) − offset)·slope, 0, 1) with d
  the Chebyshev distance (3-D) of its stored position to the camera (lod
  flags at 0x50c47d/0x50c494); z += (1 − lod)·relief (level 14, section 5).
- Extra vertex: p += (target_stored − p)·lod_target (its target's lod, not
  its own), likewise its B/A/lightmap uv; its blend weights use the target's
  lod too.
- A level-16 vertex morphs between 28.3 m (lod 0) and 40.7 m (lod 1); in
  general between h(T/32 + 2) and h·T/16 from the camera, so a cell is fully
  coarse exactly where its parent takes over: boundaries between levels are
  closed. Validation (`terrain-lod.test.ts`): on ~1,400 samples along every
  mixed-level cell boundary of a frame the two sides agree to 4 mm with
  this rule, while unmorphed geometry disagrees on ~900; same-level edges
  can open where an interior extra vertex collapses onto the edge, and are
  then closed by vertical sliver triangles (as in the exe).

**Draw** (FUN_0050be70, three passes with FUN_0050d6a0, docs/rendering.md):
pre-transformed vertices (FVF 0x1c4); per vertex fog
f = 1/2^(log2 e · z · 0.001 · d′) (f2xm1/fscale at 0x50c63d, i.e.
exp(−z_m · 0.002048 · density); d′ = density × 0.0005 clamped to [0, 16384]
by FUN_00508f60), clamped ≥ 0, stored as trunc(255 f) in the specular
alpha; base-pass fog colour = trunc(255 c) of the clamped terrain fog colour
(0x50bf43); colour = (f·layers + (1 − f)·fog)·(f·lightmap + 1 − f). D3D culling
is off, but each strip triangle's signed screen area is tested on the CPU
(0x50cc26, sign flipped per strip triangle and for mirrored cells): back
faces of the stored winding are skipped, except in cells with a vertex
behind the near plane, which go through the clipper (FUN_0050d920)
unculled.

Port: `TerrainOctree.selectCells` + `morphCellGeometry` (CPU reference),
`TerrainLook.cellLook`, and `engine/world/terrain-render.ts`, which keeps
built cells in fixed 48-vertex GPU slots, draws the frame's cells with one
indexed call and evaluates lod, morph, weights and fog in the vertex shader.
Collision keeps the static level-16 mesh.

## 8. Open questions

1. ctr bytes 25–27 and the leaf A values: no reader found.
2. Depth-17 nodes: purpose unknown (never drawn: the selection stops at 16).
3. ~~Triangle flag bits 5–7~~: always set in level 1, unread by the draw;
   collision use not checked.
4. Whether the collision walk applies HeightMap relief (the global at
   0xb47d98 gates it in FUN_004bf240).
5. ~~The exact in-game LOD metric~~: recovered (section 7).
6. Only level 1 is available; other missions need their own region and
   HeightMap tasks (both come from their objects.qvm).
7. GlobalLight "Texture filter" ambient/scale/gamma: no runtime use found.
8. ~~The exponential fog constants~~: recovered (section 7, "Draw").
9. A-layer projection bits (6–7) match the local normal only 26 of 36 times.
10. How the 5 terrain mip levels are filtered when generated (the port uses
    the WebGL box filter) and how the 2000-era D3D drivers interpolated the
    specular-alpha fog (the port: perspective-correct per pixel).
