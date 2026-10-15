# Renderer: camera, fog, sky, render states, LOD, effects

Recovered from `igi.exe` (DirectDraw 7 + Direct3D 7 device, fixed function).
Reference tool: [`tools/igi_render_params.py`](../tools/igi_render_params.py)
(stdlib; re-reads every executable constant below at its address and checks
the derived values). Browser port: `web-port/src/loaders/render-params.ts`
(typed constants, task readers, sky-dome builder, fog/LOD/cloud helpers),
tests in `web-port/tests/render-params.test.ts`.

Labels: **observed** (measured from the game data), **recovered** (read from
`igi.exe` code, function addresses given), **inferred** (consistent, not
confirmed). Units: IGI units (4096 = 1 m, z up) unless metres are stated.

Device vtable offsets used at the call sites (IDirect3DDevice7, verified by
the argument patterns): `+0x28` Clear, `+0x2c` SetTransform, `+0x34`
SetViewport, `+0x40` SetMaterial, `+0x48` SetLight, `+0x50` SetRenderState,
`+0x7c` DrawPrimitiveVB, `+0x80` DrawIndexedPrimitiveVB, `+0x8c` SetTexture,
`+0x94` SetTextureStageState, `+0xb0` LightEnable. (`+0x8c` is SetTexture, not
SetTextureStageState.)

## 1. Scale and state system

- D3D units = IGI units × 0.001 (`DAT_00b7092c`, set at 0x491ad3). Every world
  matrix is `R · 0.001` with translation `(position − camera) · 0.001`; the
  view matrix is then rotation only [inferred: `FUN_004933d0(view, camera, 0)`].
  [recovered FUN_0052e5d0, FUN_00491970]
- Render states are grouped into four cached "state groups" (texture stage,
  blend, z/fog/light, misc: `DAT_00b70b28`, `DAT_00b70abc`, `DAT_00b70aec`,
  `DAT_00b70b04`); a draw selects one registered function per group
  (`FUN_004ad6c0` registers, the cached index skips repeats). [recovered]
- Game logic ticks at a fixed **30 Hz** (`FUN_004020b0` → `FUN_004029a0(0x1e)`);
  `FUN_00402250` runs task slot 1 ("tick") at that rate and renders between
  ticks. Per-tick constants below are per 1/30 s. [recovered]

## 2. Camera

### Projection and depth layers [recovered FUN_00495c70, FUN_00491970]

`FUN_00495c70` (registered as "SetActiveTransContext") sets a viewport and
the projection `_11 = 1/tanX`, `_22 = −1/tanY`, `_33 = Q`, `_34 = 1`,
`_43 = −Q·near`, `Q = far/(far − near)`. igi.exe's camera basis is x right,
**y down**, z forward (hence `_22 < 0`). Three transform contexts ("layers"):

| Layer | Used by | near | far | viewport MinZ–MaxZ |
|---|---|---|---|---|
| 0 | first-person gun (object field `+0xec == 0`) | 204.8 = 0.05 m | 6144 = 1.5 m | 0 – 0.05 |
| 1 | world (terrain, objects, sky) | 409.6 = 0.1 m | 4.096e8 = 100 km | 0.06 – 1.0 |
| 2 | unused (near = far) | 4.096e8 | 4.096e8 | 1.0 – 1.0 |

The gun's depth range lies entirely in front of the world's, so the gun
never clips into walls. The world near plane is re-set to 0.1 m at the start
of a view (`FUN_004c7cf0`, "SetNearClippingPlane" = `FUN_00495f70`).

### Field of view [recovered FUN_00495fe0, FUN_00490130, FUN_00462fe0, FUN_00463470]

- Camera build `FUN_00495fe0`: `tanY = H_vp · tanX / (aspect() · W_vp)` with
  `aspect() = 4·H/(3·W)` (`FUN_00490130`), i.e. **tanY = 0.75 · tanX** for any
  full-screen resolution: the 4:3 frustum is hard-wired (a 16:9 mode would be
  stretched). Default mode: 640 × 480 × 32 (`config.qsc` `GOGfxDisp`). [observed]
- Player: `tanX = fptan(π/4) = 1` → **90° horizontal, 73.74° vertical**
  (double π/4 at 0x5315f0). First-person gun: `tanX = fptan(π/6)` → **60° ×
  46.83°** (0x5319b8). Reset by `FUN_00464650`.
- Zoom: while a zoom input is held both tangents are multiplied by 0.96
  (in) or 1.0416667 (out) per tick (0x5319c4/0x5319c0). Binoculars:
  `DefineWeaponType` trailing values 5, 90, 70 = "Binocular – Min/Max/Default
  FOV (degrees)". [observed values; names from exe strings]
- The HumanCamera (`FUN_00480c80`, mode switch at 0x480de5) submits the
  human's eye position, rotation and FOV tangent (`FUN_004cfed0`, priority
  300) and copies the gun FOV into `DAT_00b27440`, which `FUN_0052e5d0` uses
  for layer-0 draws.

### Eye position and view motion [recovered FUN_00464490, FUN_00463840]

- Eye = human origin (`+0x20..0x30`, doubles) + **2826.24 units (0.69 m)**
  standing, **1433.6 (0.35 m)** crouched. The origin's height above the feet
  is not recovered (open question; soldiers' task positions sit on the
  ground, so the runtime origin must be raised ≈1 m by the physics [inferred]).
- Eye collision: the eye is kept 204.8 units (0.05 m) in front of any
  surface hit by the ray from the body to the eye.
- Shake: random offsets `amp · (2·rand − 1)` on angles and position; `amp`
  decays by a per-instance step each tick.
- Dip: eye z += `A·sin φ` (plus `0.075·A·sin φ` on the z of the lean offset),
  φ += 12°/tick until π (0.5 s); triggered by events [semantics inferred].
- No periodic walk bob exists in this function [inferred from its full
  decompilation]. Pitch is clamped to ±90°; pitch/yaw also approach target
  angles at 3°/tick when a target is set [semantics inferred].
- Peek/lean: a lateral offset approaches its target at 75.85 or 113.78
  units/tick (target up to 2048 units = 0.5 m, limited by collision)
  [recovered rates; semantics inferred].

### First-person weapon [recovered FUN_00476100, FUN_0052e5d0, FUN_0052f2c0]

The gun model, its clip, moving parts and flame are the human's held weapon
(attached to the skeleton's hand [inferred]); in first-person view their tasks set
`+0xec = 0` and draw in layer 0 with the 60° gun FOV and the 0.05–1.5 m
range. Its exact pose comes from the skeletal animation (`WeaponConfig`
StandAnim/MoveAnim/FireAnim/ReloadAnim), which is not decoded, so the hold
offset and the visual kick cannot be recovered yet. Camera recoil is the
`WeaponConfig` "view change" fields (MP5SD 0.7° + random 0.2° about X).
[observed values]

## 3. Fog [recovered FUN_00521280, FUN_00508f60, FUN_0050be70, FUN_0052daf0–FUN_0052e460, FUN_00498940]

- `FUN_00521280` interpolates the GlobalLightKeyframes (exact match, else
  linear between the nearest lower and upper Time, else the existing side)
  into five categories (terrain, object 1–4): ambient (`0xb275e0 + 12k`),
  fog colour (`0xb27620 + 12k`), **fog density × 0.0005** (`0xaeca40 + 4k`,
  constant at 0x532c80). Time of day stays 0, so level 1 uses Time 12 (E019).
  The light times are set only at compile, with 0: GlobalLight
  `FUN_00521ee0` → `FUN_005221c0(0)` (sets +0x194, re-interpolates) and
  Dirlight `FUN_00520fd0` → `FUN_00521230(0)` (+0x5c, `FUN_00520720`); both
  setters have no other caller. The time of day every camera submits
  (`FUN_004cfed0` 9th argument → camera +0x58; cut-scenes: the interpolated
  key value, −1 → the CutScene's; player: `FUN_00487890` = level clock /
  (rate × 3600) + start) is not read by the view render (`FUN_004de9e0`
  copies matrix, position, FOV and +0x44 only) nor by any hook found, so it
  changes nothing on screen. [recovered setters; no reader found: inferred]
- **Mode: exponential**, `f = exp(−d_D3D · density · 0.0005)`, i.e.
  `f = exp(−d_m · 0.002048 · density)`; colour = `mix(fog, surface, f)`.
  Level 1 (density 1.89): k = 0.003871/m, 50 % at 179 m, 90 % at 595 m.
- **Terrain**: pre-transformed vertices (FVF 0x1c4 = XYZRHW | DIFFUSE |
  SPECULAR | TEX1, `FUN_0050f800`); the fog factor is computed per vertex on
  the CPU from **view depth** z (camera forward axis, after the geomorph):
  `f = 1 / 2^(log2 e · z · 0.001 · d′)` (f2xm1/fscale at 0x50c63d and
  0x50c956 = `exp(−z·0.001·d′)`), clamped ≥ 0, stored as `trunc(255 f) << 24`
  in the specular alpha, with `FOGTABLEMODE = NONE`. d′ = "Fog density
  terrain" × 0.0005, clamped to [0, 16384] (`FUN_00508f60`); colour = "Fog
  color terrain" clamped to [0, 1] and converted to bytes `trunc(255 c)`
  (0x50bf43, via ×(−255) and fistp in chop mode). `FOGVERTEXMODE = EXP`,
  `FOGDENSITY = d′`, `RANGEFOGENABLE = TRUE`, `FOGSTART 10000` / `FOGEND
  30000` are also set but do not apply to TL vertices. Level 1 (d = 1.89):
  the byte reaches 0 (pure fog colour) beyond 1.43 km view depth.
- Terrain is drawn in three passes sharing that fog factor (`FUN_0050d6a0`):
  base (opaque, fog colour = terrain fog), additive material layers (ONE/ONE,
  fog colour black), lightmap multiply (ZERO/SRCCOLOR, fog colour white). The
  result is `(f·layers + (1−f)·fog) · (f·lightmap + 1 − f)` — not exactly
  `mix(fog, layers·lightmap, f)` (`terrainFoggedColour` in the port).
- **Objects** (rigid/lightmapped meshes, decals, blob shadows): D3D vertex fog
  `FOGVERTEXMODE = D3DFOG_EXP`, `FOGTABLEMODE = NONE`, `FOGDENSITY` and
  `FOGCOLOR` from **object category 1** only. `RANGEFOGENABLE` is never reset
  after the terrain sets it, so objects use radial eye distance where the
  device supports range fog [inferred]. `FOGENABLE` = camera field `+0xbc`
  (`FUN_004deb26`; on for the player view [inferred]).
- Categories 2–4 are interpolated but **never read** (no references to
  0xaeca48–0xaeca50, 0xb275f8+, 0xb27638+). [recovered]
- Not fogged: sky dome, cloud layers, 2-D/TL primitives (`FUN_00504b00`),
  additive deferred blocks (`FUN_0052f2c0`). GlobalLightKeyframe "Sky color"
  is only read by the water renderer (`FUN_0050a910`); level 1 has no water.

## 4. Sky

Order per frame: Clear → sky dome → cloud layers → terrain/objects (depth
test against the cleared buffer). [recovered FUN_00517d20]

### Clear colour [recovered FUN_00518670 → FUN_00490260, FUN_00490840]

`Clear(TARGET|ZBUFFER, FlatSky "Fog Color", z = 1)`. Level 1: #334a66.

### Dome [recovered FUN_005268b0, FUN_00526d20, FUN_005269c0, FUN_00526c10, FUN_00526de0]

- Vertex buffer FVF 0x42 (XYZ | DIFFUSE), 0x141 = 321 vertices, 0x744 = 1860
  indices: pole + 15 rings at 84°, 78°, …, 0° elevation × 20 vertices 18°
  apart + a skirt ring at `z = −0.5 R` under the horizon ring (same colour).
  R = 4.096e8 × 0.8 (80 km). Fan + quad strips in `FUN_00526d20` order.
- Colour of a ring at elevation φ with A = "SkyDome Angle" (deg → rad,
  ×π/180): if φ ≥ A, `b = 1 − (φ − A)/(π/2 − A)` between Top (b = 0) and
  Middle (b = 1); if φ < A, `b = 1 − max(0, φ/(A/2) − 1)` between Middle and
  Bottom (Bottom for φ ≤ A/2). Azimuth weight `a = |0.1 j − 1|` mixes
  "Colour 1" (a = 0) and "Colour 2" (a = 1); `c = lerp(lerp(c0, c1, a),
  lerp(c2, c3, a), b)`, converted to bytes by `trunc(float32(c) · 255)`,
  clamped at 255 (`FUN_00526c10` 0x526cab–0x526cf0), then
  Gouraud-interpolated. The FPU runs in chop mode, so the float32 store and
  the `fistp` both truncate: 0.5 → 127 (gameplay.md "FPU rounding mode").
  "Snap Colours" copies Middle/Bottom 1 into 2 (level 1: on).
- World matrix: rotation about z by `−(atan2(l.x, l.y) + π/2)`, l = first
  directional light's toward-the-light vector, so **Colour 1 faces the sun**;
  scale 0.001, centred on the camera. States: ZENABLE off, ZWRITE off, no
  blend, no fog, LIGHTING off, CULL CCW, COLOROP SELECTARG2 (diffuse).
- Level 1 ring colours (pole → horizon): #1d319d, #23399e, #29429f, #2f4aa0,
  #3552a2, #3b5aa3, #4162a4, #476ba5, #4d73a6, #527ba8, #5883a9, #5e8caa,
  #6494ab, #869a9c (12°), #b59d84 (6°), #b59d84 (0°). [derived from observed
  task values with the recovered formula]

### Cloud layers (FlatSkyLayer) [recovered FUN_00517d20, FUN_00518760, FUN_00518850, FUN_00504300]

- Each layer is a textured plane **"Z Pos" metres above the camera**
  (camera-relative: no parallax). For a screen ray `r` (world axes),
  `hit = r · (ZPos·4096 / r.z)`; `u = hit.x · Scale + offU`,
  `v = hit.y · Scale + offV`. Only rays above the horizon are drawn (a 13-row
  screen-space strip, 26 pre-transformed vertices with per-vertex UV/alpha;
  perspective-correct through rhw [inferred]).
- Alpha: with `D = Distance·4096`, `s = D − (D − 409.6)·FogAmount` and
  `z = hit · forward` (camera depth): `alpha = 1` for z < s, else
  `(s − s·D/z)/(s − D)` clamped to [0, 0.999]; × layer "Alpha". Level 1:
  plane 4 m up, opaque to 5.93 m depth, transparent from 100 m.
- Scroll: `off += (X Speed, Y Speed)` **per 30 Hz tick**, wrapped to [0, 1]
  (level 1: 0.0093, 0.0018 UV/s). One repeat = 1/Scale units (level 1:
  24.41 m on a plane 4 m up — far larger in angle than a 600 m plane).
- Drawn as a TL primitive with flags 0x41480000: colour = texture × layer
  Color (clamped 0..1), alpha = texture alpha × vertex alpha; SRCALPHA /
  INVSRCALPHA; bilinear, no mipmaps, WRAP; no depth test; no fog. Layers draw
  in task order (level 1: two identical sky_layer1.tex layers, colours
  (0.75, 0.96, 0.98) then (0.90, 1, 1), so the pattern is composited twice).
- `sky_layer1.tex` is LOOP v11 BGRA 64×64 (alpha used); `sky_layer2.tex` is
  not referenced by level 1. [observed]

### Sun disc and lens flare

Level 1 has **no** `Lensflare`/`LensflareItem` task and no string in
`igi.exe` names `flare00–07.tex`, so no flare or sun disc is drawn [observed].
The task types exist (`FUN_0051a950`: Lensflare 0x98 bytes with fields at
+0x6c, an RGB at +0x78, +0x84; LensflareItem 0x40 bytes: RGB +0x2c,
RangeReal32 +0x28, Real32 +0x24, +0x3c); their draw code was not traced.
The flare files are LOOP **v2** (24-byte header: u16 row bytes, w, h, 2 at
0x10; A1R5G5B5 from 0x18) 64×64 images holding one quadrant (bright centre at
the bottom-right corner): 00 streak + glow, 01/05 glows, 02–04 hexagon
fills/outlines, 06 orange sun with rays and ring, 07 blue ring. [observed]

## 5. Render states

Common to 3-D paths: DITHERENABLE on, SPECULARENABLE off, ZENABLE = D3DZB_TRUE,
ZFUNC LESSEQUAL unless noted, COLORVERTEX off for objects. [recovered]

| Path | Function(s) | Z test/write | ZBIAS | Cull | Blend | Alpha test | Fog |
|---|---|---|---|---|---|---|---|
| Object, vertex-lit | 0x52daf0 + 0x52dda0 | on/on | 3 | CCW | — | — | objects |
| Object, lightmapped | 0x52de80 + 0x52dfd0 | on/on | 3 | CCW | — | — | objects |
| Object block, deferred alpha | 0x52f2c0/0x52f780 (+0x52e190/0x52e460) | on/off | 3 | CCW | SRCALPHA, INVSRCALPHA | > 1 | objects |
| Object block, deferred additive | same, block flag bit 0 | on/off | 3 | CCW | ONE, ONE (unlit, texture only) | > 1 | none |
| Terrain base / layers / lightmap | 0x50be70, 0x50d7cc / 0x50d749 / 0x50d6a0 | on/on LESS; on/off LESSEQUAL | 0 | none (back faces skipped on the CPU, 0x50cc26) | — / ONE,ONE / ZERO,SRCCOLOR | — | terrain |
| Sky dome | 0x526de0 | off/off | 0 | CCW | — | — | none |
| Clouds, 2-D sprites (TL) | 0x504b00/0x504c40/0x504e40 | by flags | 0 | none | by flags | > 10 if flags & 0x8000003c | none |
| Decals, blob shadows (PolyList) | 0x498840/0x498940/0x498c10 | on/off | 0 | CW | SRCALPHA, INVSRCALPHA (flags 0; 8 = ONE/ONE, 0x10 = ZERO/INVSRCCOLOR) | > 0 | objects |
| Cut-scene LineFilter / HandiCamFilter lines | 0x499bd0 / 0x49b200 | on/off LESSEQUAL at depth 614.4 | 0 | none | SRCALPHA, INVSRCALPHA (diffuse only, no texture) | off | off |
| Cut-scene BandFilter bands | 0x49a840 | off/off | 0 | none | DESTCOLOR, ZERO (texture colour only, WRAP, no mip) | off | off |

- Texture stages: objects stage 0 MIN/MAG LINEAR, **MIPFILTER POINT**
  (nearest mip level, bilinear within it), WRAP; vertex-lit COLOROP
  MODULATE(TEXTURE, DIFFUSE), ALPHAOP SELECTARG1(TEXTURE); lightmapped stage 0
  SELECTARG1(TEXTURE), stage 1 = lightmap (uv1, CLAMP, LINEAR, no mip)
  MODULATE with CURRENT. Terrain: LINEAR, MIPFILTER POINT, **CLAMP**, over
  the 5 mip levels (128 → 8 texels) generated at load; terrain lightmaps
  have no mip levels (bilinear). Per-frame cell selection, geomorph and the
  detail/coarse layer blend: docs/terrain.md section 7.
- Deferred blocks: a DNER block with the s16 at +0x16 (type 0) / +0x18
  (type 3) non-zero is queued and drawn after the opaque pass sorted by depth
  (`FUN_004ad570`); flag byte bit 0 (+0x18 / +0x1c) selects additive. Observed
  on level-1/location0 models: additive exactly on the GUNFLAME models
  1000/1005/1007/1008/1010 and the explosion sprite 1006_01_1; 817 other
  deferred (alpha-blended) blocks: 29 rigid, 3 bone, 785 lightmapped.
- Deferred alpha blocks are drawn with D3D **LIGHTING on** and stage 0
  MODULATE(TEXTURE, DIFFUSE) (`FUN_0052f2c0` 0x52f414, `FUN_0052f780`
  0x52f943, set after the stage groups); additive ones LIGHTING off,
  SELECTARG1. The model vertex formats (table 0x54b944: 0x112, 0x212, 0x112)
  all carry normals, so a **lightmapped** deferred block (FVF 0x212 =
  XYZ | NORMAL | TEX2, stage 1 = lightmap MODULATE CURRENT) is texture ×
  vertex light × lightmap, unlike opaque lightmapped blocks (SELECTARG1). The
  vertex light is the same as for vertex-lit blocks: material diffuse and
  ambient 1 (`FUN_0052e190`), AMBIENT = object category-1 ambient, one
  directional light per Dirlight with diffuse 0.001 × its colour (0x52e1e7)
  — which cancels the ×1000 the inverse-transposed 0.001 world scale gives
  the normals (no NORMALIZENORMALS) [inferred] — so
  `min(1, ambient + colour · max(0, n·l))`. [recovered states; the on-screen
  result inferred from them]
- `TEXTUREFACTOR = (255 − byte +0x1b/+0x1f) << 24` (non-zero bytes 51/89/127
  on 101 alpha blocks; 0x52f4b2, 0x52f9a5, also 0x52d941) is set, but no
  `SetTextureStageState` call in igi.exe uses `D3DTA_TFACTOR` as an argument
  or `D3DTOP_BLENDFACTORALPHA` (every call site; register arguments resolved:
  0x497b97 sets 2 = TEXTURE): it has **no visible effect** [recovered].
- TL primitive flags (`FUN_00504300`): 0x1000000 LINEAR else POINT,
  0x400000 WRAP else CLAMP, no mip; blend 0x8 SRCALPHA/ONE, 0x10
  ZERO/INVSRCCOLOR, 0x80000000 ZERO/SRCCOLOR, else SRCALPHA/INVSRCALPHA;
  0x20000 z test + write, 0x40000 z test only, else no z; vertex alpha used
  when flags & 0x10880024, else 255; COLOROP/ALPHAOP MODULATE(TEXTURE, DIFFUSE).
- Mip LOD bias: `MipMapControl` render handler `FUN_00518bb0` sets
  `D3DTSS_MIPMAPLODBIAS` (stage 0) = "LOD bias (Standard MipMapping)" (level 1:
  −0.4). "MipMap mode" (1 = GR_MIPMAP_NEAREST) and "LOD blend" are stored
  but not applied by that handler. [recovered FUN_00518a50 field layout]
- Gamma: `config.qsc` `GOGfxGamma(1.000000)` [observed]. The value lives at
  config +0x214 (`Config_GraphicOptionsSetGamma` `FUN_00404370`); its only
  reader is the script getter (0x4043da / 0x404402) — no gamma ramp is ever
  set, so the menu's gamma has no visible effect [recovered: every +0x214
  access checked].
- Z-bias: objects ZBIAS 3 (pull toward the viewer over terrain); decals and
  shadows instead draw with the near plane × 1.01 (`FUN_00498c10`).

### Cut-scene camera filters [recovered FUN_00499900, LAB_00499bd0, LAB_0049a840, LAB_0049b200, FUN_0049a5d0, FUN_0049bc10, LAB_0049a7a0, LAB_0049bbb0]

The EditCamera FILTER overlays (lifetime and inputs: [mission.md](mission.md)
"Camera filters"). Each frame their render handler queues a draw in the
deferred list (`FUN_004ad570`) at depth 614.4 units (0.15 m), so they are
drawn over the whole 3-D scene and under the 2-D overlays (the
WideScreenFilter bars, the HUD). The draws write pre-transformed vertices
(XYZRHW | DIFFUSE | TEX1, 28 bytes) into the shared vertex buffer
`DAT_00b70a40` (Lock DISCARD / NOOVERWRITE, 200 vertices per batch) and use
the 3-D viewport `DAT_00b708f8` x, y, w, h (the full frame at 640 × 480,
[inferred]). z = Q·(1 − near·rhw) mapped to the viewport depth range, rhw =
1/(614.4 × 0.001). Every float → int is a chop `fistp`.

- **LINE** (`LAB_00499bd0`): a horizontal LINELIST line across the viewport
  at y = top, top + 4, … while y + 4 ≤ bottom (120 lines at 480), colour =
  the key's Filter color (trunc(c × 255)) with alpha byte 0x4c (76).
  Noise > 0: n = noise × 10; if n < 1, rows are 1/n px apart with one dash
  each, else every row gets trunc(n) dashes; a dash starts at x = rand × w,
  is rand × 50 px long (clipped at the right edge), grey = trunc(rand × 255),
  alpha = trunc(noise × 255) (3 RNG draws per dash, RNG `DAT_006c62c8`).
  When the 200-vertex batch is full the iteration only flushes, so every
  101st dash is dropped. [recovered]
- **BAND** (`FUN_0049a5d0` + `LAB_0049a840`): noise = 0 → only a 2-D
  rectangle over the viewport in the clamped, k1 → k2 interpolated colour with
  flag 0x80000000 (ZERO / SRCCOLOR: the frame is multiplied by the colour).
  Noise ≠ 0 → no tint; instead the frame is multiplied by a 16 × 16 BGRA
  texture (`+0x2c`, uploaded twice per frame by `FUN_004a8730`) repeated one
  texel per pixel over horizontal bands of h × 0.05 (24 px): edges at top,
  top (+ 12 px while the roll counter > 45), then every band height, last =
  bottom; the bands from edge 1 (odd) use rows of 2 px at trunc(128 c) and
  2 px at trunc(255 c) (`FUN_00499500`), those from edge 0 a flat
  trunc(255 c) (`FUN_004995c0`). Each texture first gets trunc(burst × 256)
  speckles (`FUN_00499620`): a random texel's R, G, B are scaled by one
  random factor and written back one byte up (displayed (G', B', 0)). Then
  "CAMERA n" (font1.fnt) at (w × 0.9 − 50, h × 0.2), colour 100/128 (byte
  199). [recovered; texture filtering is not set by the draw: inherited state,
  the port uses point sampling, inferred]
- **HANDICAM** (`LAB_0049b200` + `FUN_0049bc10`): two lines (y, y + 1) every
  4 px, alpha 0x4c, the key's colour; white opaque corner brackets at
  (0.1 | 0.9 w, 0.2 | 0.8 h) with 50-px arms pointing inwards, drawn twice
  1 px apart (2 px thick; the right / bottom corners land on x 575, y 384
  because 0.9f × 640 and 0.8f × 480 chop down); a time code
  "00 : MM : SS : FF" (font1.fnt, colour byte 199) at (w × 0.9 − 117,
  h × 0.8 − 20) = (459, 364); the battery sprite (common/sprites/battery.spr,
  64 × 32, red "empty" icon) as a quad (w × 0.1 + 4, h × 0.2 + 2) of width
  w × 0.07 and height width × 32/64 = 44.8 × 22.4 px at (68, 98), passed to
  `FUN_004ab6b0` bottom vertices first so it is drawn **upside down**, blinking
  (vertex alpha 1 while the phase ≥ 0.75 s, phase += real ms / 1000, reset
  above 1.5 s; flag 0xc0000). The time code DAT_006c6710 (frames, 24 per
  real second, `LAB_0049bbb0` with GetTickCount) starts at rand × 21600 with
  the first draw of the filter RNG = 18200.6 → "00 : 12 : 38 : 08"; the
  hours field is (minutes % 60) / 60, always 00. [recovered]

## 6. Model LOD [recovered FUN_004c4d00, FUN_004e4620, FUN_004e46e0, FUN_00405e50]

Inputs: `z` = view depth of the model's bounding-sphere centre × detail
(1.0 at `GOGfxPerformance(0)`; 1.5 / 2.0 for performance flags 0x40 / 0x80),
`r` = model radius × max(scale), `t` = current tan(hFOV/2) (zoom refines LOD).

- **Explicit** (`lod.qvm` ModelLODSettings, 460 entries, distances made
  non-decreasing then ×4096): `d = t·(z − r)`; culled if `d > cutoff`; LOD
  index = number of "Distance to LOD i" values below `d` (starting at 1 if
  the first distance is 0).
- **Relative** (`LODSettings` task; the five "relative" values × 0.02):
  `r' = (1 − k)·(R_ideal − r) + r` (k = "Degree to which radius affects LOD",
  R_ideal = "Ideal radius" × 4096), `d = z − r'`; LOD i+1 starts at
  `d > S·r'·(n0/ni)²/t` (S = first switch × 0.02, ni = triangle count of
  variant i); culled when the last variant is reached and `d > C·r'/t`
  (C = cutoff × 0.02). Level 1 rigid: S = 1.3, C = 49, k = 0.25, R_ideal = 15 m
  → a 10 m-radius building switches to LOD 1 at 31.6 m depth and is culled at
  688 m.
- `lod.qvm` and `material/material.qvm` are not staged by
  `web-port/scripts/stage-raw.mjs` yet.

## 7. Effects

| Effect | Data | Behaviour | Label |
|---|---|---|---|
| Muzzle flash | GUNFLAME ATTA sub-model of the gun: AK47 100→1000_01_1 (0.71 m), M2HB 123→1000, Glock 117 / Colt 101 / Desert Eagle 106 / Uzi 111 / Uzi×2 111_04→1005, M16A2 108 / Minimi 107→1007, SPAS12 109 / Jackhammer 125→1008; MP5SD 103 and Dragunov 105 have none | flat flame meshes across the barrel, textures 1000_02_1 / 1005_01_1 / … (opaque on black) drawn ONE/ONE unlit unfogged; shown while the gun's last-shot render frame (+0x138, set at 0x477d2b) ≥ frame − 1, only on even frames after the first (+0x13c), rolling about the flame's local y (the barrel) by {0, 4, 7}[rand(3)]° each shown frame, cumulative; rand(3) comes from the **second** level generator (`FUN_00415c30` = +0x38, seeded 0x19111911 at level start; this roll is its only user) (`FUN_00476000`, `FUN_004a9920` → `FUN_004a9e80`) | observed + recovered |
| Bullet impacts | `material.qvm` DefineGameMaterial args 22–28 (entry A, front faces) and 29–35 (entry B, exits): TASKTYPE_GUNSHOTEFFECT, dust flag, fragment flag, texture 1, texture 2, half-size, model (7.1) | 7.1–7.4 | recovered + observed |
| Blood | `textures.res` hole_blood1–4.tex, `sprites.res` blood1.spr (7 frames) / blood2.spr (8×8), loaded by the Human class (`FUN_0045d170`) | 7.5 | recovered |
| Blob shadow | `textures.res` shadow1.tex (32×32 black, alpha ≤ 199) | one quad, half-size 0.45 m, on the ground under each human, oriented to the ground normal, lifted 10 units; colour 0.9·clamp(0.8(1 − h/1000 m), 0.3, 1) (no visible effect with a black texture [inferred]); alpha blend, fog, no z-write (`FUN_004d7670`) | recovered |
| Smoke | `Smoke` task (level 1: the three locomotive exhausts, nodes 817 / 867 / 879 under Trains 814 / 846 / 870); `sprites.res` fireball / blood1 / smoke2 / smoke1.spr by "Sprite index" | 7.11 | recovered |
| Explosion | 1006_01_1 (a hemisphere dome, radius 2038 units, planar UVs, 26-frame 1006_anim000–025 64×64), additive block; smoke2.spr; GlassShatter; burn1.tex | 7.10 | recovered |
| Shell casings | WeaponConfig "Casing Model" (113_01_1; SPAS12 109_03_1) | 7.8 | recovered |
| Tracers | `ammo/<dir>/ammo.qvm` DefineAmmoType args 6–12 | 7.7 | recovered |

`common/textures/shadow00/01.tex` (white discs, LOOP v2) are not referenced
by `igi.exe` strings; level 1 uses shadow1.tex. [observed]

Port: `web-port/src/engine/fx/` (`bullet-effects.ts` holds every rule below
as pure functions; `decals.ts`, `particles.ts`, `debris.ts`, `tracers.ts`,
`muzzle-flash.ts`, `effect-assets.ts`; wired in `effects.ts`), tests in
`web-port/tests/fx-effects.test.ts`.

### 7.1 Which impacts get an effect [recovered FUN_00479e30 0x47a0d0–0x47a996, FUN_004084d0]

- The bullet loop records up to **10** impacts per bullet, in trace order:
  - a **front** hit (word 0x13) is recorded only when entry A's texture 1
    handle (record +0x58) is non-null, so Air, Water, Fence, HumanCollision,
    MetalLadder and MetalFence record nothing (no dust, fragments or hole);
    its direction is the cast vector mirrored about the unit face normal
    (`D − 2(D·n)n`, D = start − end of the cast before any ricochet);
  - a **back** hit (word 0x14, the bullet leaving a solid) is always
    recorded, with entry B and direction D.
- After the trace each record calls `FUN_004084d0(class id +0x254/+0x25c,
  record +0x258/+0x260, hit record, flag, direction)`, which sends message
  `DAT_00536576` to the class: the GunShotEffect handler `FUN_004376c0`.
- **flag** = 0 for every record of a bullet that ricocheted; otherwise 1,
  except the last record, which gets 0 when (record normal · direction) > 0 —
  true for every front and back record, so the last impact always has 0.
- The GunShotEffect record (0x60 bytes, `FUN_00437a30`): +0 dust flag, +1
  fragment flag, +2 / +0x1a texture 1 / 2 (handles +0x58 / +0x5c), +0x54 size
  × 4096.0 (double 0x531498) = the hole **half-size** in units, +0x32 model.
  Level 1 data: entry A has dust + fragments on every material with a texture
  except Glass; entry B never has them. Concrete: A bullethole_concrete /
  dent_concrete 0.05 m, B bullethole_concrete ×2 0.06 m; metals A
  bullethole_metal / dent_metal; most others hole_concrete1 0.03 m. [observed]

### 7.2 GunShotEffect handler [recovered FUN_004376c0]

Level-RNG (+0x2c) draws in this order:

1. human = the hit object derives from BoneDynCubeObj (`FUN_00401d30` with
   `FUN_004cfca0`): humans get no fragments and no dust.
2. Fragments (flag +1, not human): count = rand(3) + 2; Explosion0
   (`FUN_0047f410`: no fireball, smoke, sound or damage) draws three floats
   for its spin; the burst follows on its first tick (7.3).
3. Bullet hole when the hit has an object and (flag and texture 1, or
   texture 2): texture 1 if the flag is set and it exists, else texture 2,
   size = +0x54, sent through slot `DAT_0053e894` (7.4).
4. Dust (flag +0, not human): one raw step; when odd, two concrete1.spr
   particles in a new system (2 particles max, colour 127/128, half-size
   163.84 units × a scale that starts at 1 and grows 0.0889 per tick, far
   100 m, flags 0x1080000): at
   hit + n̂ × 491.52 and 40.96 higher; upward speed (r·0.75 + 0.15) ×
   4096000/108000 units/tick, the second × 1.25; alpha r·0.25 + 0.75; spin
   ((r − 0.5)·2)·0.05236 + 0.0128 rad/tick each; life 15 ticks, then alpha
   −1/30 per tick.

### 7.3 Fragments [recovered FUN_0047d570, FUN_0047d440, FUN_004fa830, FUN_004fa1d0, FUN_004fa7d0]

- Each fragment is the material's model (1009/1011/1012/1013_01_1, ≈0.7 ×
  1 m as stored) at **scale 0.1** (204.8/2048), at the hit point, initial
  tilt Rz(r k) Ry(r k) Rx(r k) with k = π/100.
- Launch (seven floats each): speed 340 + r·340 units/tick; direction = the
  third column of frame(dir)ᵀ · Rz(r π) · Rx(r · 30°), which covers only
  **half** of the 30° cone (the frame's b component never goes negative).
- Per tick (SimpointObjContainer): spin × 0.99, R = Rz Ry Rx(spin) applied
  to every fragment (`R·M`); v × 0.98, v.z −= 0.45 × 44.6 × 0.98 = 19.67
  units/tick; no collision. Each lives 45 ticks.
- Drawn as rigid vertex-lit objects with object fog [inferred: the
  RigidDynCubeObj path].

### 7.4 Bullet holes [recovered FUN_0047b630, FUN_0047b9d0, FUN_0047c6b0, FUN_0047bf10, FUN_004aa2f0, 0x47b700, FUN_00498c10]

- Slot `DAT_0053e894` has a handler on RigidDynCubeObj (propagated to its
  descendants by `FUN_00401440`) and on the terrain class; Wire, Rotor,
  Switch, ElevatorFloorIndicator, Gun, GunFlame, GunClip and GunMovingPart
  store 0; humans (BoneDynCubeObj) never had it. So: **no holes on humans,
  wires, switches, rotors or guns**.
- **No holes on the ground**: a terrain hit record carries no object
  (`FUN_004c24c0` 0x4c29e9 stores 0 at +0), and `FUN_004376c0` sends the
  hole only to a non-null object (the terrain class's own handler
  `FUN_0047c6b0` is never reached by bullets). Dust and fragments still
  appear on the terrain.
- Each object gets a BulletHole child holding **200** holes (a ring: the
  oldest slot is reused); at most **100** objects per level carry one (later
  objects get no holes). Port: one list per placed instance [inferred
  object granularity].
- A new hole is dropped when an existing valid hole of the list lies within
  1.5 × its half-size and (objects only) the normals' dot product > 0.9.
- The hole is **one fixed quad**: corners (±s, ±s, 12.288) in the frame of
  the object-local face normal (`FUN_004aa2f0`: a = |(n.y, −n.x, 0)| or
  (0, 1, 0), b = |a × n|; corner = x·b + y·a + 12.288·n), UVs (0,0), (0,1),
  (1,0), (1,1) for (+,+), (−,+), (+,−), (−,−), triangles (0,1,2), (1,3,2).
  Not clipped, not projected, **no random roll**.
- Each lifted corner casts a 24.576-unit ray along −n against all geometry
  (`FUN_004c4630`); if any ray hits nothing the hole is marked invalid
  (−NaN at +0x48): never drawn, but it keeps its slot.
- Draw: PolyList, LIGHTING off, vertex colour white (DAT_0053e888), textured
  triangles COLOROP MODULATE, **ALPHAOP SELECTARG1 (texture alpha)**;
  untextured ones SELECTARG2 (diffuse) for both; alpha test > 0, SRCALPHA /
  INVSRCALPHA, no z write, object fog, near × 1.01; at most 500 triangles
  per list. Holes live in the object's frame (they follow doors).
- Port: the quad frame uses the world-space normal, identical for objects
  rotated about z only [inferred equivalence].

### 7.5 Blood [recovered FUN_0045e5b0 → FUN_00462710, FUN_00462cf0]

Every bullet hit on a human, before the damage, if GOIsBlood (config.qsc
TRUE):

1. A ray 12288 units (3 m) along the bullet from the hit point against
   objects only (filter 0x20000000; the terrain needs bit 0x80000000); on a
   front face whose entry A has texture 1: a hole of
   hole_blood1 / hole_blood2 (rand(2)), half-size (r + 1) × 614.4.
2. Puff: the human's blood1.spr system (2 particles, half-size 1228.8,
   frame every trunc(15 / 7) = 2 ticks, no growth), one particle at the hit,
   life 15, then gone in one tick.
3. Droplets: the human's blood2.spr system (10 particles, half-size 102.4,
   gravity −14.867 units/tick², flags 0x80000): rand(3) + 3 along the bullet
   (10° cone, 378–606 units/tick) and rand(3) + 2 backwards (70° cone,
   37–113); each spin from the level RNG, direction and speed from the
   particle generator (`FUN_004f4e30`, `DAT_0080aba8` seeded 0x12332153);
   life 30, then alpha −1/7 per tick.
4. Droplet hits (`FUN_00462cf0`, the system's callback): tested every 15
   ticks against objects only (filter 0x20000000: droplets fall through the
   terrain); on a hit the droplet is removed and, when (previous − current) ·
   n < 0 with n the face's outward normal, a hole of hole_blood3 /
   hole_blood4 (rand(2)), half-size 102.4 + r × 204.8. [recovered sign: with
   outward normals this accepts only faces met from behind; inferred to be
   an original quirk]

### 7.6 Particles [recovered FUN_004f3b70, FUN_004f4b20, FUN_004f4d40, FUN_004f4280, FUN_004f3c40]

- Per tick: v += acceleration, position += v, angle += spin, scale +=
  growth, frame += 1 every `delay` ticks up to the last frame of the
  sprite's tile sequence; life counts down, then alpha −= fade; the particle
  dies at alpha ≤ 0 or scale ≤ 0; an empty system destroys itself when its
  byte +0xfd is set (`FUN_004f4200` sets 1; `FUN_004f51f0(sys, 0)` keeps the
  systems a task owns, e.g. the Smoke task's, 0x4f4825).
- A system is a child of the task passed to `FUN_004f4b20` (the Dynamic
  task for blood, dust and explosion smoke; the Smoke task for its own), so
  it steps where that task updates its children.
- Draw: a screen-aligned TL quad at the particle's view depth, half-size =
  size (× scale when growing) projected at that depth, ≥ 0.5 px, rotated
  in screen space when the spin is non-zero; not drawn nearer than 2048
  units or beyond the system's far distance; colour = texture × colour/128,
  alpha = texture × particle alpha (flag 0x80000; bytes trunc(v·255));
  without 0x80000 the colour is multiplied by the particle alpha and the
  vertex alpha is 255; bilinear, no mips, clamp; blend by the flags
  (`FUN_00504300`: 0x8 SRCALPHA/ONE, 0x10 ZERO/INVSRCCOLOR, 0x80000000
  ZERO/SRCCOLOR, else SRCALPHA/INVSRCALPHA); z test, no z write; no fog.
  Port: one batch per sprite and blend; the WebGL target alpha is kept at 1
  (D3D never displays it).

### 7.7 Tracers [recovered FUN_00479e30 0x47a7c0–0x47a90e, FUN_0047aba0, FUN_004792b0, FUN_004d7ac0, FUN_0047acf0, FUN_0047ac40, FUN_0047b1b0, FUN_0047b450]

- A gun's ammo type is the DefineAmmoType whose arg 4 equals the WeaponConfig
  "Calibre ID" (gun +0x12c). Arg 12 = 1 enables tracers: 9 mm, .357, .44,
  5.56, 7.62 and 12.7 mm; never 12-gauge or AMMO_ID_DRAGUNOV. [observed]
- Per gun a counter starts at 10; a cast draws a tracer when the counter is
  < 1, or the bullet has ricocheted, or it passed through the face of this
  cast (then the counter is reset to 10); otherwise it drops by 1. About one
  cast in eleven.
- Geometry: the cast's segment. With t = distance along the bullet / bullet
  range at each end: colour = lerp(args 6–8, args 9–11, t)/255 (level 1:
  (250, 200, 0) → (255, 255, 0)); alpha = clamp(t) × (1 − 0.1·z/2048000)
  (z = view depth, clamped), floored at 0.2.
- Drawn as a **1-pixel TL line** (z test, no write, alpha blend, untextured,
  unfogged), clipped at depth 409.6 units; a segment crossing the camera
  plane becomes one PolyList triangle (start, end, and a vertex 286.72 units
  across the segment in xy at the end ahead of the start; alphas 0, 0, 1).
- Lifetime: every drawn frame sets +0x34 = 0 and the next tick removes it, so
  a tracer shows from its tick to the next (1/30 s). Five slots per gun.

### 7.8 Shell casings [recovered FUN_004772c0 0x477b80–0x477ced, FUN_00476430, FUN_004769f0, 0x476c30]

- Only the player's gun (owner = `FUN_00415960(0)`) with a Casing Model; at
  the gun model's XTVM point 3 (the .mef "magic vertex" list read by
  `FUN_004c5aa0`; point 2 is the muzzle; AK47 point 3 = (−0.3, 767.4, 49.9)
  units [observed]), with the gun's rotation.
- Velocity: gun rotation × (s cos a, 0, s sin a), a = rand(30)°, s =
  ((rand(4) + 4) × 4096000) / 108000 in integers (151, 189, 227 or 265
  units/tick), plus the vector carried by the fire message; spin per tick
  Rz(rand(5)°) Ry(rand(5)°) Rx(rand(2)°).
- Per tick: v.z −= 44.6, v × 0.985, position += v, R = R × spin; no
  collision; 19 ticks.
- Drawn with the first-person gun (+0xec = 0: layer 0) when the camera's
  +0x5c flag is set [flag meaning inferred: first-person view].

### 7.9 Port hooks (to wire)

- `combat/bullet.ts` reports every hit (front and back, with the outward
  face normal, the cast vector, terrain / owner / body / human) and every
  cast (start, end, passed, ricocheted) plus the bullet's ricochet state;
  `weapon.ts` / `enemy.ts` pass them to `effects.bullet()` and call
  `effects.humanHit()` in each human hit's `apply()`.
- `engine/level.ts` passes `assets: await loadEffectAssets(raw, level,
  impactMaterials)`; `scripts/stage-raw.mjs` must stage `ammo/`.
- The first-person gun scene holds `effects.casingLayer`; the player's fire
  calls `effects.ejectCasing(weaponId, gunModel, gunWorldMatrix)` after the
  pellets; `game.ts` passes `running` to `effects.update`.
- `game.ts` creates `createSmokeEmitters(...)` (7.11), calls `reset()` after
  `mission.start` and `tick()` after each `mission.tick()`.
- The `game:scorch` sender may add `normal`, `owner` and `body` (the hit of
  its downward ray); without them `effects.ts` re-finds the face with a
  0.1 m vertical ray.

### 7.10 Explosions [recovered FUN_0047d570, FUN_0047e3d0, LAB_0047e960, FUN_0047ea50, LAB_0047eb00, FUN_0047d520, FUN_0047e790, FUN_0047ce40, FUN_0047d440, FUN_0047cf40, FUN_0047f410, FUN_00448b70, FUN_00449010, FUN_0044abb0, FUN_004494b0, LAB_00448c90, FUN_004986c0, FUN_00498940, FUN_00498c10, FUN_0047cd10, FUN_0047cb00, FUN_0047cb90]

Explosion logic (creation, draws, damage): [damage.md](damage.md) §3. All
explosion visuals draw from the level RNG (+0x2c, `FUN_00415c20`) except the
glass shards (private generator) and the cone draws of particle emitters
(`DAT_0080aba8`).

**FireBall** (task class "FireBall", 0x118 bytes, child of Dynamic):

- Create (`FUN_0047e3d0(pos, "1006_01_1", size, life, 0, unused, delay,
  period, 0, 0)` + slot 0 `LAB_0047e960`): +0x10c = size × 1/2048, life
  +0xf4 = +0xf8, delay +0xfc, frame period +0x108, frame +0xf0 = −1, extra
  roll +0x110 = +0x114 = 0 (explosions pass 0: no roll).
- Update (`FUN_0047ea50`): while delay > 0 only delay −= 1; then frame =
  trunc((life − left) / period × frames) mod frames (fild / fidiv / fimul /
  fistp in chop mode: life 52, left 50 gives 0, not 1), and left −= 1, or
  the task deletes itself when left is 0. So a fireball is drawn on `life`
  ticks (after the update of each); a delayed one also on the tick its delay
  reaches 0, with frame −1 = the model's texture-animation frame as the last
  fireball draw left it (the frame is written into the shared model,
  `FUN_004c5e10`).
- Draw (`LAB_0047eb00`, nothing while delay > 0): scale x = y = size/2048,
  z = (1 − left/life) × size/2048 + 0.01 with `left` after the update;
  d = unit(camera (`DAT_00b70848`) − centre), a = unit(z × d) =
  unit(−d.y, d.x, 0), b = unit(d × a), c = unit(a × b) = d; world matrix
  columns (a, b, c) (identity when d = (0, 0, 1)): the dome's apex (+z)
  points at the camera with x horizontal, a flat disc that bulges toward the
  viewer over the life. The model's UVs are the planar projection on its
  base (u = 0.5 + x/4076, v = 0.5 − y/4076), so it shows the 64×64 explosion
  frame as a sprite with depth. Render: the model's additive deferred block
  (§5): ONE/ONE, texture only, alpha test > 1, z test without write, ZBIAS
  3, D3D cull CCW, no fog, depth-sorted after the opaque pass. The centre
  is the explosion point (a barrel's origin on the floor), so the floor and
  walls clip the disc.

**ExplosionSmoke** (`FUN_0047d520`: life T, size = radius × 0.9): each
update draws from the level RNG; it only owns two one-particle smoke2.spr
systems (children of Dynamic, deleted when empty):

| | glow (first update, left = T) | shade (left = trunc(0.9 T): 134 for T = 150) |
|---|---|---|
| draws | fade, alpha, then (`FUN_0047ce40`) angle, spin | angle, spin |
| flags | 0x1000008: SRCALPHA / ONE | 0x1000010: ZERO / INVSRCCOLOR |
| life, fade | trunc(T × 0.1) ticks, then over trunc((r × 0.2 + 0.8) T) ticks | T ticks, then 1 per tick |
| alpha | (r + 1) × 0.1 | 0.001, then every update k × 0.3, k = left/(T/2) below T/2 else 1 − (left − T/2)/(0.9 T − T/2) (`FUN_004f5200`) |

Both: half-size (size, size), growth 1/T per tick, acceleration (0, 0,
2.2300444) units/tick², velocity (0, 0, 1), colour 12.7 (/128: at most 0.099
× the particle alpha, so both are faint), far 819200 units, angle r × 2π,
spin (0.5 − r) × 0.0188496 rad/tick. fireball.spr (`DAT_005c4508`) is only
the trail of fragments created with a trail type (`FUN_0047cf40`);
`FUN_0047d570` passes type 0: explosion fragments have no trail.

**Fragments**: 7.3 with the explosion's cone (π/2), speeds (272–1360) and
gravity (radius × 0.9/4096 × 44.6 × 0.98), launched in `FUN_0047d570`.

**GlassShatter** (class "GlassShatter", 0x2b048 bytes, child of Dynamic;
draws only from its private generator `DAT_0057f768`, set to the
`FUN_004aaa00` state once at start-up by the class registration
`FUN_00448b70` and never reseeded):

- Registration: a 30-entry rotation table, entry k = Rz Ry Rx(k a1, k a2,
  k a3) with a = (r × 40 − 20)/900 rad (90 draws).
- Create, in the pane's frame (world = R local + pane origin): the faces of
  the pane model's collision set 0 with (b − a) × (c − a) · push > 0 — the
  push is a **world** vector (bullet: the cast × 0.007; explosion: pane −
  centre) dotted with a **local** normal — are cut by `FUN_004494b0`; at
  most 1000 shards; life 30.
  - Bullet (`FUN_00449010`): the impact P = Rᵀ(hit − origin) and its
    normal Rᵀn are stored in globals; shard speed 10 units/tick from P.
  - Explosion (`FUN_0044abb0`): speed clamp(|origin − centre|, 0, 1) ×
    409.6 = 409.6 from the local centre; the cut still uses the globals of
    the **last bullet** shatter (zero before any).
- `FUN_004494b0(a, b, c)`: with P inside the triangle (tested on the plane
  of the largest |normal| component) the distances are 0, else for each
  edge (ca, ab, bc) the distance from P to the segment; d = distance/5120
  clamped to [0, 1]; limit = d × 4505.6 + 409.6 units. If limit(ca)² <
  |ab|² or limit(ab)² < |bc|² or limit(bc)² < |ca|²: one discarded draw,
  then the longest edge is cut at t = max(1 − shortest/longest, 0.5) − r ×
  0.1 or min(other/longest, 0.5) + r × 0.1 and both halves recurse
  (winding kept). Else a shard: centroid × 0.33333334, rotation index
  trunc(((1 − min d) + r) × 0.5 × 30), velocity unit(centroid − P′) × speed
  + (r × 4096 − 2048)/30 per axis (4 draws).
- Update (`LAB_00448c90`): gravity g = (R₂₀, R₂₁, R₂₂) × −44.6 (world down in
  the pane frame); vertex alpha = left/30; per shard centre += v, each
  vertex = centre′ + M(vertex − centre), v += g; left −= 1 and at 0 the task
  and its PolyList are deleted before any draw (drawn alphas 30/30 … 2/30).
- Draw: a PolyList (`FUN_004986c0`, flags 0) of the shards in the pane's
  frame at the break: untextured, colour (0.7, 0.7, 0.7) (178), vertex
  alpha, LIGHTING off, SRCALPHA/INVSRCALPHA, alpha test > 0, z test without
  write, **D3DCULL_CW** (the triangle (a, b, c) is drawn when it turns its
  (b − a) × (c − a) side to the viewer: the cut faces face away from the
  shooter, so only tumbling shards show on the shooter's side), object fog,
  near plane × 1.01.

**Scorch** (`FUN_0047f410` 0x47f51f, the grenade's target from
`FUN_004751f0`): the grenade casts a 2048-unit (0.5 m, double
0xc0a00000_00000000) ray straight down against objects and terrain
(`FUN_004c0e10`, filter −1); `FUN_0047f410` sends {hit record, 0,
burn1.tex, scorch size} through the hit object's bullet-hole slot
(`DAT_0053e894`, 7.4): a fixed burn1.tex quad of half-size = the scorch
size (grenades 6144 = 1.5 m), the 7.4 rules (duplicates, corner rays,
200-slot ring, object fog). A terrain hit carries no object: no scorch on
the ground. The flash grenade (`FUN_0047cd10`) does the same with half-size
2048.

**FlashBang** (flash grenade, `FUN_0047cb00` / `FUN_0047cb90`): one
smoke1.spr system (colour 127, half-size 2457.6, far 819200, 0x1000008
SRCALPHA/ONE, growth 0.0145833/tick, 20 particles); the first update emits
three particles (level RNG: upward speed (r + 1) × 1.5 km/h, alpha (r + 1)
× 0.25, spin ((r − 0.5) × 2) × 0.0436 + 0.0204; life 90, fade 30), plays
explo_flash, broadcasts AI event 19 (range 40960) and deletes itself. The
white-out itself is the flash message (slot `DAT_0053e8a4`) handled by each
human (not traced here).

Port: `fx/explosion.ts` (fireballs, glass PolyLists, fragments through
`fx/debris.ts` `FragmentSystem.launch`, smoke systems in the shared particle
manager), `fx/glass-shatter.ts`, rules in `combat/explosion-rules.ts`
(`fireballFrame`, `fireballScale`, `fireballBasis`, `smokeGlow`,
`smokeShade`, `smokeShadeAlpha`, `flashbangPuff`); the smoke draws happen
in `combat/object-damage.ts` (`smokeUpdate`, in Dynamic-list order: smokes
of earlier ticks, this tick's explosions, their new smokes); the scorch is
placed by `effects.ts` on `game:scorch`. Tests: `tests/explosion-fx.test.ts`.

### 7.11 Smoke task [recovered FUN_00436790, LAB_00436e10, FUN_00437280, FUN_004374c0, FUN_00437030, FUN_00436d50, LAB_00436f20, LAB_00436f80, FUN_004f4e30, FUN_004f5230]

- Fields (21 parameters, table `DAT_0057f348`): Position +0x28, Alpha +0x7c,
  Gamma +0x80, Number of Particles +0xf8, Radius +0x94, Maximum Random Angle
  +0x90, Minimum / Maximum Velocity +0x88 / +0x8c, Colour +0x104, Life Time
  +0xfc, Fade Time +0x100, Fade Mode +0x110, Sprite index +0x118, Particle
  Size +0x84, Particle Size Delta +0x114, Minimum / Maximum Rotation Speed
  +0x120 / +0x11c, Intensity +0x124, Initial generate factor value +0x98
  (double), Generate factor +0xa4 (expression), Move Particles +0x170.
- Create resets the class generator `DAT_0057f320` to the `FUN_004aaa00`
  state: after loading, the three level-1 smokes share it, initial state.
- Init (`FUN_00437280`): emission direction = third column of Rz(Gamma)
  Rx(Alpha) (level 1: 102° from up, slightly downward); one particle system
  owned by the task (kept when empty): sprite 0 fireball, 1 blood1, 2
  smoke2, else smoke1.spr; colour × 63 (/128); half-size Particle Size ×
  4096; growth Size Delta / 30 per tick; far 409600 units; Number of
  Particles; no acceleration; Fade Mode 0 → 0x1080000 (alpha blend with the
  particle alpha), 1 → 0x1000008, 2 → 0x1000010. `FUN_004374c0` keeps the
  offset from the nearest object ancestor (the Train) in its frame:
  local = Rᵀ(pos − P).
- Parent moved (slot `DAT_00545d24`, `FUN_00436d50`): position = R × local
  + P — the emitter rides the locomotive; the direction stays in world
  space. The in-world handlers register / drop the script variable
  "<name>.vGenerateFactor" (+0x98).
- Update (`FUN_00437030`), run only where the task tree reaches it (its
  ConditionalContainers running): with Move Particles every particle is
  shifted by the emitter's motion (`FUN_004f5230`); the children (its
  system) step; a compiled Generate factor replaces +0x98; acc += factor
  (float store, comparison on the unrounded sum) and while acc > 30: one
  particle, acc −= 30 — factor 30 gives one per tick from the second update.
- A particle: class generator r1 angle × 2π, r2 radius × Radius × 4096, r3
  spin; at (x + cos a · rad, y + sin a · rad, z); `FUN_004f4e30` with
  `DAT_0080aba8` (tilt, azimuth, speed): cone = Maximum Random Angle, speed
  from Maximum × 136 to Minimum × 136 units/tick (f32 0x5317e8 = 136), alpha
  = Intensity, spin ((Max − Min) r3 + Min)/30, life trunc(Life Time × 30),
  then fade over trunc(Fade Time × 30 / Intensity) ticks (chop: 2 s / 0.1 →
  599).
- Level 1: smoke1.spr, colour 126/128, half-size 0.7 m growing 0.0889 per
  tick, alpha 0.1 (× texture alpha ≤ 200: an 8 % veil), 4.5–6 m/s in a 45°
  cone; Smoke 867 (Train 846, "Train driveby") runs from tick 627 of the
  intro and settles at 113 live particles; 817 and 879 do not run in the
  intro. Smoke 817's offset from Train 814's compile pose is 63 m (its
  Position is a copy of 879's) [observed in the port's placement].
- Port: `fx/smoke-emitter.ts` (`createSmokeEmitters`), ticked after the
  mission runtime; container gating from the runtime's `isRun` (this tick
  or the previous: the falling-edge tick still updates children) and
  `inWorld` (hidden). Generate factor expressions are not evaluated (level
  1 has none). Tests: `tests/smoke-emitter.test.ts`.

## 8. Three.js mapping

- Camera: `PerspectiveCamera(fov = 73.74°, aspect, near 0.1, far 100000)`;
  aspect 4/3 reproduces the stretched original on any window, the window
  aspect gives Hor+. The current port's 70° fov / 0.15 / 9000 should become
  73.74° / 0.1 / (any far that covers the cull distances; the original's is
  100 km).
- Gun: a second scene rendered after the world with `clearDepth()` and its
  own camera (vertical fov 46.83°, near 0.05, far 1.5). That reproduces the
  separate depth range.
- Fog: per-fragment `f = exp(−k·d)` with k = density × 0.002048/m; terrain
  with view depth (`-mvPosition.z`), objects with distance (`length(
  mvPosition.xyz)`); use `THREE.FogExp2` only as an approximation (it is
  exp2). Terrain: `(f·layers + (1−f)·fog)·(f·lightmap + 1 − f)` with the
  per-vertex byte f and byte fog colour (`engine/world/terrain-render.ts`,
  which also selects and geomorphs the terrain cells per frame).
- Colours are D3DCOLOR bytes in gamma space with no linear-light maths; for
  a match render with `ColorManagement.enabled = false` and
  `outputColorSpace = LinearSRGBColorSpace`, or treat every game colour and
  texture as sRGB consistently.
- Sky: `buildSkyDome()` → BufferGeometry with vertex colours
  (`MeshBasicMaterial({vertexColors})`, depthTest/depthWrite false,
  renderOrder first, follows the camera, rotated by `skyDomeYawRad`), clear
  colour = FlatSky Fog Color. Clouds: a full-screen pass (or a big
  camera-centred plane) computing the ray–plane UV and `cloudLayerAlpha` per
  fragment; advance offsets by speed × 30 per second.
- Filtering: `minFilter = LinearMipmapNearestFilter`, `magFilter = Linear`;
  WebGL2 has no LOD-bias sampler state: apply −0.4 with
  `textureLod`/`texture(…, bias)` in a custom shader (or ignore; the visual
  difference is small).
- Z-bias 3 for objects: `polygonOffset(true)` with a small negative factor;
  decals: polygonOffset or a 1 % near-plane trick.
- Dithering/16-bit precision cannot be matched exactly in WebGL; omit.
- Cut-scene filters: `web-port/src/engine/render/cutscene-filters.ts` draws
  them after the world and before the letterbox with an orthographic
  640 × 480 camera, no depth test (nothing is nearer than 0.15 m in a
  cut-scene), cull off; lines are resolved to whole virtual pixels
  (`cutscene-filter-state.ts`), so they keep their 1-px / 4-px look at any
  window resolution.

## 9. Open questions

1. The human origin's height above the feet (absolute eye height).
2. First-person gun pose, sway and kick (need the `.iff` animations).
3. Lensflare/LensflareItem drawing (no level-1 data uses them).
4. ~~TEXTUREFACTOR alpha~~: set but read by no texture stage — no effect
   (section 5).
5. ~~Vertex lighting on deferred lightmapped blocks~~: yes, texture × vertex
   light × lightmap (section 5); the port's material supports it
   (`object-material.ts` `litLightmap`), `world-builder.ts` must supply
   `objLight` for those blocks.
6. ~~Smoke task and Explosion0 fireball draw parameters~~: recovered (7.10,
   7.11).
7. The camera +0x5c flag that gates casings, and which side of the tracer
   crossing triangle survives CULL CW.
8. ~~Terrain LOD / far-field draw distance~~: recovered (docs/terrain.md
   section 7).
9. Whether hardware without D3DPRASTERCAPS_FOGRANGE fell back to depth fog
   for objects.
