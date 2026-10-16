# HUD, fonts and screens

What `igi.exe` draws from launch to play: the interface image and font formats,
the in-game HUD, radio/status messages, the loading screen, and the
complete/failed flow, plus the menu system in enough detail to rebuild it,
the menu sub-screens and their widgets (section 12) and the map computer
(section 11).

Port: `web-port/src/loaders/ui.ts` (decoders, layout constants, timing helpers).
Reference tool: `tools/igi_ui.py`. It checks every interface asset and, with
`--png-dir DIR`, writes previews plus a mock HUD frame and loading screen built
from these rules. Tests: `web-port/tests/ui.test.ts`.

Labels:

- **observed**: measured on the files.
- **recovered**: read from `igi.exe` (function or data addresses given;
  decompiled with the Ghidra project, image base 0x400000).
- **inferred**: neither.

All positions are given for the reference resolution of 640×480 as well as the
general rule.

## 1. Assets

| Archive | Members | Used by | Evidence |
|---|---|---|---|
| `screens/game/status/status.res` | 47 `.spr` (HUD) | StatusScreen `FUN_00484920` loads 45 by name (`STATUSSCREEN:` → `LOCAL:screens/game/status/`) | recovered |
| `computer/computer.res` | font1–4 `.fnt`, 49 `.spr` (map computer) | `FUN_00469c10`, loaded at level-load step 6. Its **font3.fnt is the HUD text font** | recovered |
| `menusystem/ingamemenu.res` | pointer, glow, font1/3/4, slide* | in-game MenuManager (`ingamemenu.qvm`). **font1.fnt is the radio-message font; font4.fnt is the cutscene-subtitle font** (`FUN_00483f20`) | recovered |
| `menusystem/menusystem.res` | mainmenu.pic, logo(.us).pic, pointer, glow, win1_*, win2_*, fonts, slide* | main MenuManager (`mainmenu.qvm`) | recovered |
| `menusystem/loadingscreen.res` | loading.pic, loading_us.pic | `FUN_00488860` | recovered |
| `menusystem/missionsprites.res` | mission1–14.spr (168×124) | mission PictureBox (`Config_FillMissionPictureBox`) | recovered (string) |
| `common/sprites/sprites.res` | binoculars, snipersight(_x/_y), effects | Binocular / GunDRAGUNOV overlays, particles | recovered |
| `common/textures/common.res`, `textures.res` | world and decal textures (LOOP v11) | not interface | observed |
| `screens/intro/*.avi`, `*.wav`, `font3/4.fnt` | intro movies | IntroScreen `FUN_00417ef0` | recovered |

Font bytes: the `font1`, `font3` and `font4` members are byte-identical in
`menusystem.res` and `ingamemenu.res`. The loose `screens/intro/font3.fnt` and
`font4.fnt` differ from them in the character map only. (observed, md5)

Unused: these status.res members are never named in `igi.exe` (the string
search finds nothing): `mapsphere`, `mapcircle`, `mapdot`, `progressbar`,
`block`. The same holds for these sprites.res members: `exclamation`,
`question`, `filter_linje`. The english.res strings "LoadingText" ("Loading
Level... Please Wait...") and "Game Over" are not referenced by the exe or by
either menu script. (observed)

Identified HUD sprites (previews checked visually):

| Sprite | Content | Use |
|---|---|---|
| cross.spr 9×9 (format 2) | white crosshair | crosshair |
| powerbarbackground.spr 64×78 | green outline of a standing man, ring | health background |
| powerbar.spr 23×70 | red striped man | health fill |
| clip20.spr 61×(21×33) | magazine emptying, frame 0 = full | AMMODISPLAYTYPE_CLIP |
| barrel6.spr 61×(30×30) | revolver cylinder | BARREL (Colt) |
| shell7.spr 8×(30×30) | shotgun shells | SHELL (SPAS-12) |
| rocket.spr 15×33 | rocket | CLIP graphic for weapon 12 (LAW 80) |
| M16_alternative.spr 24×33 | 40 mm grenade | M203 counter |
| spl_grenade.spr | grenade | loaded but not drawn by the paths found |
| ak47, colt, deserteagle, druganov, flashgrenade, glock, health, jackhammer, LAW80, M16, Mp5, proximity, SAW, spaz, splintgrenade, stationary, uzi, binoculars | weapon pictures (green) | weapon icon |
| knife.spr | knife | loaded, but no weapon ID selects it |
| anya, note, ammo, weapon .spr (30×33) | Anya portrait ×2, ammo box, pistol | radio-message portraits |
| action_searchcab, action_comput, action_picklock, a_gun, action_pressbutton, a_door, a_fence, a_ladder, a_wire, a_c4 | action pictograms | "use" icons |

## 2. Formats

One loader, `FUN_004ac9f0` ("Invalid sprite file: %s"), reads every 2D image.
It dispatches on the LOOP version: v1, v5, v7, v9 and v10. (recovered) All 163
sprites/pictures and 12 fonts in the archives above parse, and every footer
ends at EOF. (observed, `tools/igi_ui.py`)

### LOOP v9 sprite / picture (`.spr`, `.pic`)

| Offset | Field |
|---|---|
| 0x00 | "LOOP", u32 9 |
| 0x10 | u32 0x00050000 (s16 at 0x12 = 5 is passed to the texture creator `FUN_004a8690`) |
| 0x18 | u32 palette offset (0 in every file) |
| 0x1c | u32 tile-map footer offset |
| 0x20 | u32 frame count |
| 0x28, 0x2c | u32 width, height (the sprite size returned by `FUN_004acf50`/`FUN_004acf70`) |
| 0x30 | u32 pixel format |
| 0x34 + 32·i | frame: u32 file offset of pixels, u32 format, u16 row bytes, u16 w, u16 h, s16 advance (+0xe), s16 x offset (+0x16), s16 y offset (+0x18), u32 flags (+0x1c) |

Frame offsets are added to the draw position (`FUN_004ab0e0`). A sprite with
one frame is flagged "fixed width" (0x10000); one with several frames uses
each frame's advance when drawn as a row. (recovered)

**LOOP v6 tile-map footer** (`FUN_004ad820`): +8 u32 picture width, +0xc
height (0xCCCCCCCC when unset), +0x10 columns, +0x14 rows, then 16-byte cells
{i32 0, i32 x, i32 y, i32 frame + 1}. Only the byte at cell +12 is read.
(recovered) A `.pic` is a grid of 64×32 tiles drawn as a text grid. The cell at
(c, r) is drawn at (x + 64c, y + 32r). loading.pic and mainmenu.pic are 10×15 →
640×480; logo.pic is 5×4 cropped to 295×107; logo_us.pic is 7×4 → 429×107.
(observed)

### LOOP v7 sprite (computer.res arrows/plus/sphere)

+0x18 palette, +0x1c tile map, +0x20 count, +0x28 w, +0x2c h, +0x30 format.
40-byte frames at +0x34: +0 offset, +4 row bytes, +8 w, +0xc h, +0x10
advance, +0x20 x, +0x24 y. (recovered; all 18 decode, observed)

### LOOP v10 font (`.fnt`)

| Offset | Field |
|---|---|
| 0x0c | u32 palette (0) |
| 0x10 | u32 glyph count (151 menu fonts, 96 computer fonts) |
| 0x14 | u32 pixel base (= end of the glyph table) |
| 0x18 | u16 proportional flag (1 in all fonts) |
| 0x1a | u16 space advance (pen step for characters without a glyph) |
| 0x1c | u16 32, not read by the loader |
| 0x1e | u16 line height |
| 0x20 | u16 cell width (24) |
| 0x22 | u16 pixel format (3) |
| 0x24 | u8[256] character → glyph number (1-based, 0 = none; space has none) |
| 0x124 + 20·g | glyph g ≥ 1: u32 pixel offset from the base, u32 format, s16 row bytes, w, h, x offset, y offset, advance |

(recovered `FUN_004ac9f0` v10 branch + `FUN_004ac800`; observed on all 12
fonts, which have no trailing bytes)

| Font | Glyphs | Line height | Space | Pixels | Role |
|---|---|---|---|---|---|
| computer/font3 | 96 | 9 | 3 | green (89,234,81), anti-aliased alpha | **HUD texts** |
| computer/font1, font2, font4 | 96 | 18, 16, 11 | 3 | grey / green | map computer |
| menusystem font1 | 151 | 11 | 4 | white, 1-bit alpha | radio messages, list boxes |
| menusystem font3 | 151 | 21 | 6 | white, AA | menu items and titles |
| menusystem font4 | 151 | 15 | 4 | white, AA | cutscene subtitles, small menu text |

### Pixel formats

Format 2 is A1R5G5B5 (bit 15 = opaque). Format 3 is 32-bit B,G,R,A. These are
the same codes as LOOP v11 `.tex`; no other code occurs in any UI file. The
decoded images are all correct pictures. (observed)

### Text drawing (recovered `FUN_004adb90` draw, `FUN_004ad990` width, `FUN_004ad100` set)

- A text object is a grid of glyph numbers (256 columns × 1 row for HUD texts).
- Each glyph quad is drawn at (pen + x offset, y + y offset) at the glyph's own
  size. The pen moves by the glyph advance, or by the space advance for an
  unmapped character.
- Line width = pen position after the last mapped character, so trailing spaces
  do not count.
- Flag 0x80 centres the line (x − trunc(width/2)); 0x100 right-aligns it
  (x − width).
- The text height is line height × rows.

### Intro movies and sound

| File | Content | Evidence |
|---|---|---|
| eidos.avi | RIFF AVI, video FourCC **IV50** (Indeo Video 5, proprietary), 320×240, 30 fps, 492 frames (16.4 s), no audio stream | observed |
| innerloop.avi | the same format, 401 frames (13.4 s) | observed |
| eidos.wav, innerloop.wav | not RIFF. ILSF format 2 (compressed), 16-bit stereo, 44,100 Hz, 721,770 / 587,776 frames (16.37 / 13.33 s = the video lengths), 1 byte per stereo frame (4:1, ADPCM-like; not decoded) | observed |

## 3. Rendering model shared by every 2D element (recovered)

- **Primitive.** Every sprite, glyph, rectangle and line goes through the
  render method "QVertex:RegisterStrip". D3D implementation: `FUN_00504f10` →
  `FUN_00504300`.
  - Vertex: x, y, z, u, v, alpha, r, g, b.
  - Type 0 = triangle strip (2 vertices expand to a rectangle). Type 1 = line
    strip.
- **Colour.** Helper calls take r, g, b in a 0–255 scale where **128 =
  neutral**: they multiply by 1/128 (`0x532a90`). The D3D path writes
  `trunc(v·255)` per channel: `fistp` at 0x504501–0x50458d. The game runs
  the FPU in chop mode, see gameplay.md "FPU rounding mode".
  - Exact halves therefore drop: 0.5 → 127, and 64 in the 128 scale →
    127.
  - Sprites drawn with (128,128,128) appear exactly as stored.
  - The game does not clamp: 255 → 508, so the byte is 252 and the carry goes
    into the next channel. A "pure red" (255,0,0) overlay is therefore
    (252,0,0) with alpha + 1.
  - When none of flags 0x10880024 are set, vertex alpha is forced to 255.
- **Texture stage** (`FUN_00504c40`):
  - colour = texture × diffuse; alpha = texture α × diffuse α.
  - Point sampling and clamp, unless flag 0x1000000 (bilinear) or 0x400000
    (wrap).
- **Blending** (`FUN_00504e40`): always enabled.
  - Default: SRCALPHA / INVSRCALPHA.
  - Flag 0x08: SRCALPHA / ONE (additive).
  - Flag 0x10: ZERO / INVSRCCOLOR.
  - Flag 0x80000000: ZERO / SRCCOLOR.
  - Any of 0x8000003c also enables alpha test > 10 (`FUN_00504b00`).
  - No fog, no culling, no z unless 0x20000/0x40000.
- **Pixel alignment.** Vertices are offset by −0.5 (`FUN_00504300`). With D3D7
  pixel centres this means a quad at integer x covers pixels x … x + w − 1. In
  general it starts at `ceil(x − 0.5)`.
- **Draw order.** 2D primitives go into per-viewport lists. `FUN_00495b20`
  pushes each one onto the front of its bucket, and `FUN_00495aa0` walks from
  the head, so **the elements of one frame are drawn in reverse order of
  submission**. Consequences:
  - The red health fill is under its green outline.
  - The radio text and portrait are over the message box.
  - The progress fill is over its green box.
  - The damage tint is under the whole HUD.
- **Resolution rule.** Anchor points are fractions of the screen size (W, H),
  read from `.rdata`. Sprites and glyphs are always drawn at 1:1 pixel size.
  Offsets in pixels (gaps, line spacing, 42-px message pitch, box sizes) do not
  scale. Full-screen pictures are 640×480, centred, unscaled.

## 4. In-game HUD (StatusScreen)

**Objects.**

- `StatusScreen`: class created by `FUN_00484870`, constructor
  `FUN_00484920`, update `FUN_00484c40`, render `FUN_00484ea0`.
- `StatusMessageScreen`: a child of it (`FUN_00484590`).
- Each frame the render method draws the children first, so messages are
  always drawn, including in cutscenes.
- The player HUD is drawn only when the active camera belongs to the player
  and the map computer is closed (`DAT_005c1680` = the open Computer,
  section 11). It is drawn by sending message 0x181 (`DAT_0053ea00`) to the
  player.
- Handler chain:
  - `HumanPlayer` `FUN_004130c0` calls the human handler `FUN_0045f070`.
  - That calls the current weapon's handler: Gun `FUN_00478440`, GunM16A2
    `FUN_00471e40`, GunDRAGUNOV `FUN_00471860`, Binocular `FUN_0046f780` →
    BinocularOverlay `FUN_0046ff00`.

**Visibility.** The health bar, weapon panel and overlays need the game's view
mode `*(game->0x5c)+0xe8 == 1`. Inferred meaning: first-person player view. The
HUD texts use computer/font3 (`FUN_0046a080()+0x14`, i.e. `DAT_005c12fc`).
(recovered)

At 640×480: W = 640, H = 480. Fractions are exact float32 values from the
listed addresses.

| Element | Asset | Position rule | 640×480 | Colour / blend | Function |
|---|---|---|---|---|---|
| Health background | powerbarbackground.spr 64×78 | centre (W·0.0625 `0x5315cc`, H·0.8958333 `0x531924`); top-left = centre − size/2 | (8, 391) | neutral | `FUN_0045f070` |
| Health fill | powerbar.spr 23×70 | centre − (2, 2); cropped from the top. Quad from y = cy−2−35 + 70·(1−h) to cy−2+35, v from (1−h) to 1. h = 1 − damage/maxDamage (human +0x254/+0x258), not drawn at 0 | x 26.5–49.5, y 393–463 at full health | neutral, flag 0x80000; drawn before (under) the outline | `FUN_0045f070` |
| Weapon name | weapon config `Name` (+0x110; same field builds "PICKEDUPWEAPON%s"), computer/font3 | right-aligned at x = W·0.984375 (`0x53213c`), top y = H·0.8958333 − 2 − 9 | right 630, top 419 | font colour (green) | `FUN_00478440` |
| Weapon icon | status.res sprite by Weapon ID (table below) | right edge W·0.984375, top = H·0.8958333 − 4 − iconH − 9 | MP5 48×26 at (582, 391) | neutral | `FUN_00478440` |
| Separator | line strip | from (W·0.984375, H·0.8958333) leftwards by iconW, or by nameW + 3 if the name is wider | y 430 | (0,229,0) α 127 (0.9f/0.5f direct: trunc(229.49999) / trunc(127.5)) | `FUN_00478440` |
| Ammo counter | "%-4d" (`0x53e400`), computer/font3 | right-aligned at W·0.984375 − 4, top H·0.8958333 + 4 | right 626, top 434 | font colour | `FUN_00478940`/`a40`/`c00`/`e30` |
| Clip graphic | clip20.spr frame 60 − trunc(60·clipRounds/RoundsPerClip) (≥ 0); rocket.spr frame 0 for weapon 12 | x = W·0.984375 − 4 − 8 − spriteW − counterW, top H·0.8958333 + 4 | — | neutral | `FUN_00478a40` |
| Barrel graphic | barrel6.spr frame spin + (6 − rounds)·10 (spin = gun +0x19c) | as clip; quad via `FUN_004ab6b0` | — | neutral | `FUN_00478c00` |
| Shell graphic | shell7.spr frame 7 − rounds | as clip | — | neutral | `FUN_00478e30` |
| M203 counter | "%-4d" of AMMO_ID_M203 + M16_alternative.spr | right edge = left of the main clip graphic; icon 8 px further left | — | — | `FUN_00471e40`, `FUN_00479190` |
| Crosshair | cross.spr 9×9, static (no spread) | (W/2 − trunc(w/2), H/2 − trunc(h/2)), fistp at 0x47886c / 0x478887 (chop mode) | (316, 236) | neutral | `FUN_00478440`, when Sight Display Type = 1 |
| Action icon | status.res a_*/action_* | centre (W/2, H·0.875 `0x532210`); top-left = centre − trunc(size/2) | door at (307, 398) | neutral, alpha = 0.3 + 0.7·tri(p) with flag 0x80000; p += 1/15 per tick (`0x532204`), wraps above 2 (`0x531588`); tri = p or 2 − p; p resets to 0 when there is no target (`FUN_00485220`) → 1-s pulse | `FUN_00485130` |
| Action progress box | rectangle | (W·0.3125, H·0.8333333), size (W·0.375, H·0.01875) | (200, 400) 240×9 | (0,100,0) → (0,199,0) α 0.5 | `FUN_004130c0` |
| Action progress fill | rectangle | (W·0.315625, H·0.8375), size (p·W·0.36875, H·0.0104167); p = player +0xd64/+0xd60 | (202, 402) ≤ 236×5 | (128,0,0) → (255,0,0) α 0.5 | `FUN_004130c0` |
| Progress outline | 4 line strips | box edges; right edge +1 px longer | — | (0,255,0) α 1 | `FUN_004130c0` |
| Damage tint | full-screen 4-vertex strip | corners TL/TR/BL/BR alpha = player +0xdcc/+0xdd8/+0xdd0/+0xdd4 | — | (255,0,0) → (252,0,0), Gouraud alpha gradient | `FUN_004130c0` |
| Flash-bang | full-screen rectangle | — | — | (255,255,255) → (253,253,252), alpha = clamp(+0xddc, 0, 0.99) | `FUN_004130c0` |
| Timer | "Time Left: %d minute%s, %d second%s" (`0x53eef8`), computer/font3, centred | (W·0.8125, H·0.0416667) | (520, 20) | font colour | `FUN_00484ea0`; only when LevelFlow "Interface timer enabled"; remaining = 30·MaxTime − tick |

Notes on the table rows:

- **Action progress.** The bar is shown while player +0xd68 is set. That flag
  is set by timed player actions at `0x40c1d6`–`0x40d621`.
- **Damage tint.** Each corner alpha decays by 1/45 per tick (`FUN_004112a0`,
  `0x5314bc`), so a hit fades in ≤ 1.2 s.
  - Non-directional hit: all four corners = 0.4·(1 + rand) (`0x4125a8`).
  - Directional hits set two corners full and two at half (`FUN_004126e4` and
    siblings). Which side maps to which hit direction is inferred.
- **Ammo counter value.**
  - Normal, grenade and clip display: the reserve pool for the weapon's calibre
    (`FUN_0047b5a0`).
  - Barrel display: pool ÷ Rounds/Clip.
- **Reverse order.** Submissions run: weapon panel (counter, graphic, name,
  icon, separator, crosshair) → action icon → health background → health fill
  → progress fill, box, outline → damage tint → flash. Draw in reverse.

**Not on the HUD** (recovered by absence: no such draw call in `FUN_00484ea0`,
`FUN_004130c0`, `FUN_0045f070` or the weapon handlers):

- No armour; health is the only vital.
- No compass or radar outside the binocular overlay.
- No objective text. Objectives are shown in the map computer
  (computer.res "Objectives") and announced by radio messages, so the port's
  current top-right objective line has no original counterpart.
- No kill or pickup counters; pickups use radio messages.
- Fonts have no kerning table, only the per-glyph offsets and advances.

**Weapon ID → icon** (switch in `FUN_00478440`; IDs from weaponconfig.qvm):

| ID | Icon | ID | Icon |
|---|---|---|---|
| 1 Glock 17 | glock.spr | 10 Minimi | SAW.spr |
| 3 Desert Eagle | deserteagle.spr | 11 Dragunov | druganov.spr |
| 4 M16 A2 | M16.spr | 12 LAW 80 | LAW80.spr |
| 5 AK47 | ak47.spr | 14 Hand Grenade | splintgrenade.spr |
| 6 Uzi, 13 Uzi ×2 | uzi.spr | 15 FlashBang | flashgrenade.spr |
| 7 Mp5 SD3 | Mp5.spr | 16 Proximity mine | proximity.spr |
| 8 Spas 12 | spaz.spr | 18 Binoculars | binoculars.spr |
| 9 Jackhammer | jackhammer.spr | 19 Medipack | health.spr |
| 21 Colt Anaconda | colt.spr | 42 M2HB | stationary.spr |

- The knife (20) and unlisted IDs get no icon.
- The ammo display type comes from weaponconfig "Ammo Display Type":
  NONE 0, NORMAL 1, CLIP 2, BARREL 3, SHELL 4, GRENADE 5 (registered at
  `0x413e94`–`0x413ed3`).
- NONE draws no name, separator or counter.
- The crosshair needs "Sight Display Type" = CROSSHAIR (1).

Level 1's player HUD:

- MP5SD (CLIP, crosshair).
- Glock (CLIP).
- Knife: health only.
- Binoculars: Binocular class; overlay only while zoomed.

**Action icon per object** (`FUN_00485130` callers):

| Caller | Icon |
|---|---|
| `0x43e8ae` | a_wire |
| `0x43f3fe` | a_fence |
| `0x43f8a9` | a_ladder |
| `0x442f8e` | action_comput |
| `0x443b1e` | action_searchcab |
| `0x4445fe` | action_pressbutton |
| `0x445ad2` door | action_picklock if locked (+0x198), else a_door |
| `0x447392` GenericTBA | named by its sprite parameter |
| `0x47373e` | a_gun |

**Sniper scope** (GunDRAGUNOV zoomed, `FUN_00471860`; the normal weapon panel
is not drawn):

- snipersight.spr (128×96) is the top-left quadrant. It is drawn four times,
  mirrored, to fill the screen with s = W/128 px overscan: TL (−s,−s)…(W/2,H/2);
  TR mirrored in x; BL mirrored in y; BR both.
- snipersight_x.spr (128×8) is stretched across the full width at
  y = H/2 − 4.
- snipersight_y.spr (8×96) is stretched over the full height at x = W/2 − 4.
- All bilinear (flag 0x1000000), neutral colour.

**Binocular overlay** (zoomed, `FUN_0046ff00`):

- binoculars.spr (256×256) left half covers (−s,−s)…(W/2, H+s); the right half
  is mirrored; s = W/256; bilinear.
- "RANGE: %0.fM" (`0x53e288`) or "RANGE: 1000+M" at
  (W·0.378125, H·0.55 − text height). This text and the W/N/E/S labels use
  computer/font3 (`0x46fc14`–`0x46fccf`).
- Compass tape (`FUN_004709e0`):
  - Box at (W·0.625, H·0.7916667), width W·0.28125, height = 2·text height + 26.
  - 64 ticks per full turn: 12 px every 16th tick with W/N/E/S labels above
    and below, 8 px every 8th, otherwise 4 px.
  - Tick lines are (0,64,0) in the 128 scale → (0,127,0) at α 1.
- 12 random level bars (`FUN_00470380`/`FUN_00470440`) along y = H·0.7625,
  from x = W·0.125, spacing W·0.1875/12.
- Two centre chevrons (shape at `0x532068`) at W/2 ± W·0.09375: green
  (0,100,0)/128, α 0.5.
- Full-width and full-height centre lines (0,32,0) in the 128 scale →
  (0,63,0) at α 0.5.
- Up to 10 target squares (shape `0x5320a8`):
  - Shrink from 11× to 1× while turning 90° over 250 ms.
  - Colour (64,0,0), (0,128,0) or (0,0,128) per target class.
  - Forgotten 3 s after leaving view.
- Exact tick and label pixel positions follow the listed constants
  (recovered). The two small markers at the tape centre are written with
  unscaled vertex colours (g = 64.0), which overflow; their on-screen result is
  inferred.

## 5. Radio / status messages (StatusMessageScreen)

**Source.**

- The mission task `StatusMessage` (objects.qvm) has these parameters:
  - Send (expression)
  - Text (messages.res key)
  - Sprite (portrait)
  - Sound
  - Is send once
  - Cutscene message
  - Duration (default 2.0 s)
- Pickups create the same object directly (`FUN_00483920`): "send once" and
  "instant", duration 2 s.
  - `GunPickup`: text "PICKEDUPWEAPON<Name>", no portrait (`0x46bf27`).
  - `AmmoPickup`: text "PICKEDUPAMMO" with portrait `STATUSSCREEN:ammo.spr`
    (`0x46c665`).

(recovered)

**Sending** (`FUN_00483690`, each tick):

- A message is pushed when its Send expression is non-zero (or it is instant).
- At most once per 210 ticks (7 s).
- If "Is send once" is set, never again.
- The Sound is played at volume 1 when sent (`FUN_004dddc0`). Level 1 uses
  "message" = common/sounds/sounds.res `message.wav`.
- A missing text key shows "RM: <key>" (`0x5378e0`).
- Radio (non-cutscene) texts are also added to the map-computer log
  (`FUN_00467960`).

(recovered)

**Slots.**

- 12 slots; a message takes the first free slot (`FUN_004845c0`).
- Drawing walks the slots in order. Each active slot is 42 px below the
  previous one, so later messages close the gap when earlier ones expire.
- Messages freeze while the game is paused (`FUN_00483af0`).

(recovered)

**Radio message** (Cutscene message = FALSE). Draw `FUN_00484060` and
`FUN_00484180`; update `FUN_00483b30`, 30 ticks/s:

| Item | Value |
|---|---|
| Origin | x = W·0.015625 (`0x5320d8`), y = H·0.0208333 (`0x5320dc`) → (10, 10); slot k is at y + 42·k |
| Portrait | anya/note/ammo/weapon.spr only (strcmp with the table at `0x53ea04`), drawn at (x, y), neutral, once tick > 9 |
| Box | full size x … x + 235 (half-width 117.5, `0x5321fc`), y … y + h, where h = portrait height or 37 (`0x532200`) |
| Box open animation | ticks 0–1: height scale += 0.5 (centred on y + h/2); ticks 2–8: width scale += 1/7 (centred on x + 117.5) |
| Box fill | black α 0.33 (`FUN_004aadd0`); then a green (0,0.5,0) quad (byte 127) with α 0.75 at tick 0, else 0.15 (`0x53169c`, `0x5315ac`); then an outline line strip (0,229,0) α 0.5 (0.9f → 229, 0x48446d) |
| Text | menusystem font1.fnt; 3 text objects at (x + portraitW + 3, y + 2 + 11·line); colour (0,120,0)/128 → (0,239,0) |
| Typing | from tick 9, one character per tick; re-wrapped each tick |
| Wrap | 229 px (`0x43650000`) |
| Hold / removal | after the last character, hold for trunc(Duration·30) ticks (`fistp` 0x483bf5; 8.7 s → 260); removed on the next tick |

- The draw is submitted as portrait, text, box, so on screen the box is under
  the text.
- Example lifetime: "ANYA: The truck is in the garage on the far side of the
  base." (61 chars) shows for 9 + 61 + 60 + 1 = 131 ticks (4.4 s). It wraps to
  "ANYA: The truck is in the garage on the far" / "side of the base."
  (checked by the test).

**Word wrap** (`FUN_00483d20`; port `wrapStatusText`):

- Walk the characters. Measure the width of the line before the current
  character.
- Break when that width ≥ the wrap width, or when the current character is
  '\n'. The break goes at the last space seen (it is never reset after a
  break), or before the current character if there was none.
- At most 9 lines are produced; **only the last 3 are shown**, so long text
  scrolls while it types.

(recovered)

**Cutscene message** (Cutscene message = TRUE, e.g. M1_CUT_01…16 during the
level-1 intro cutscene):

- Font: menusystem font4.fnt, neutral colour (white).
- No box and no portrait.
- The whole text appears at once, wrapped to W·0.96875 (`0x5321e8`) = 620 px.
- At most the last 3 lines are drawn, from (W·0.015625, H·0.8645833) = (10, 415),
  one line height (15) apart.
- Removed after trunc(Duration·30) ticks.

(recovered `FUN_00484520`, `FUN_00483b30`)

## 6. Loading screen

Shown by `FUN_00488860`; progress by `FUN_00488a40`. (recovered)

| Item | Value |
|---|---|
| Picture | loading.pic, or loading_us.pic when the Windows country name equals "USA" (`FUN_0048d680` → strcmpi with `0x534254`). Both are 640×480. The US one shows "I'm Going In" instead of the Project I.G.I. logo |
| Placement | 1:1 at ((W − 640)/2, (H − 480)/2); the rest of the screen is the cleared buffer (black, inferred) |
| Progress bar | 560×10 at ((W−640)/2 + 40, (H−480)/2 + 440). Empty pixels 0x00007F00, filled 0x0000FF00, written into a 32-bit buffer and blitted. Read as X8R8G8B8 these are (0,127,0) and (0,255,0); the channel order is inferred |
| Fill | width = trunc(560·done/total); filled from the left on each step |
| Steps | level load: total 9, one step per stage (`0x414d10` … `0x415072`); restart: 5 (`FUN_00415ee0`); mission-complete hand-over: total 1, never advanced (`FUN_00415306`) |
| Text | none (no text call in `FUN_00488860`) |

## 7. Flow from launch to play (recovered unless noted)

1. **Startup** requests Flow event 2, INTRO (`0x401058`).
   - Flow is a fixed 30-tick/s loop (`FUN_004029a0(0x1e)`; the constant
     GAME_FREQUENCY = 30 is registered at `0x414a23`).
2. **Intro** (IntroScreen, mode 0, `FUN_00418340`): plays eidos.avi, then
   innerloop.avi (the same list for USA and other countries).
   - **Esc** stops the current movie and goes straight to the main menu
     (`FUN_00418210`; key state byte `0xbce9a3` = DIK_ESCAPE).
   - After the last movie: Flow event 3.
   - Subtitles: `MovieSubtitle_RegisterFont/Text` with language/english/
     movies.res (INTRO_*, OUTRO_*). Their placement was not decoded.
   - outro.avi (mode 1) is referenced but not shipped.
3. **Main menu** (Flow 3): MenuManager from `menusystem/mainmenu.qvm`
   (resources menusystem.res, isOwnDisplay = TRUE).
   - Two minutes (3600 ticks) idle in the menu → Flow 8: the intro plays again
     in attract mode (`0x416ffe`).
   - Path to play: Single Player → screen 914 "Select Mission". It has a
     ScrollListBox of missions, a 172×128 PictureBox with mission<N>.spr and a
     description TextBox (font4).
   - OK → `Game_SetMission(id)` + MENUMANAGER_STARTGAME → Flow 4.
   - Player profiles and difficulty are chosen on screen 912 and dialog 933
     (Easy/Medium/Hard).
4. **Mission start** (Flow 4, `FUN_004157f0`): the loading screen with 9
   steps, then play.
   - There is no separate briefing screen. Mission 1 opens with an in-engine
     cutscene with font4 subtitles M1_CUT_01–16 (LevelTimer_999).
   - Esc skips it (`LevelFlow_GetBreakCutSceneKey` → EditVariable_4004).
5. **Pause.** Esc during play opens the in-game menu and pauses
   (`FUN_00417e60` → screen 900, game +0xe0 = 1). The menu is drawn over the
   frozen frame: isOwnDisplay = FALSE, and screen 900 has no background
   (inferred from the data).
6. **Mission failed.**
   - In level 1, `StatusMessage_1391` ("Mission Failed!", radio style, sound
     "message", 2 s) is sent when the player is dead, the truck has exploded or
     soldier 4023 is dead.
   - LevelFlow Failed = `StatusMessage_1391.isSendt`. LevelFlow +0x61
     (`FUN_004876b0`) makes the MenuManager (`0x4170ae`) do one of:
     - Player alive: open the in-game menu after 151 ticks (about 5 s) and
       pause.
     - Player dead (+0xcf5): open it when **Space** or **Return** (or Esc) is
       pressed.
   - "Resume Game" is disabled while `LevelFlow_LevelFailed()`.
   - "Restart Game" → dialog 932 → MENUMANAGER_RESTARTLEVEL → Flow 5 (loading
     screen, 5 steps) → play.
   - "Quit to Main Menu" → dialog 931 → Flow 6 → main menu.
   - The "Game Over" string is never shown.
7. **Mission complete.**
   - When LevelFlow isComplete becomes true (level 1: `CutScene_1204.isFinished`,
     the truck-escape cutscene), `FUN_00415306` immediately shows the loading
     screen (total 1, empty bar). It then reads the mission's next ID: mission.qvm
     `DefineMission(1, …, MISSION_NEXT_MISSION_UNDEFINED, …)` = −1.
   - Next ID −1: Flow 7 → Flow 3, back to the main menu. Otherwise it
     configures the next mission and goes to Flow 4.
   - **There is no "Mission Complete" screen**: the strings MISSION_COMPLETE
     and OBJECTIVE_COMPLETE exist only for mission scripts' StatusMessages, and
     level 1 does not use them.

## 8. Menu system (data-driven; enough to rebuild later)

- **Structure.** Both menus are task trees in `.qvm` files (decode with
  `readTaskTree`). Node types:
  - MenuManager {Current menuscreen, Resource path, isOwnDisplay}
  - MenuScreen {Background, Frame x0, y0, x1, y1, On Press Escape, …}
  - MenuFrame {Sprite Resource, X-Pos, Y-Pos, Width, Height, LineUpMode,
    X-/Y-Spacing, Is Selectable}
  - MenuText / MenuTextConditional {Text Resource, Font Resource, ColourIndex,
    On Click Script, Click Sound Resource, isEnabled/isVisible Expression}
  - SlideBar, ListBox, ScrollListBox, ToggleBox, InputBox, PictureBox, TextBox,
    AsciiBox, ControlsMenu, DialogWindow {X-Pos, Y-Pos, Width, Height,
    SwapKeys}
  - Scripts call MenuManager_PushScreen/PopScreen/ActivatePopupScreen/
    LeaveMenus(…, MENUMANAGER_IDLE | STARTGAME | QUITTOMAINMENU |
    RESTARTLEVEL | QUIT), Config_*, Game_SetMission and Flow_RequestEvent.
  - Text Resource keys resolve in language/english/menusystem.res.
- **Coordinates.** Item X/Y are in a 640×480 layout placed at
  ((W>>1) − 320, (H>>1) − 240) (`FUN_004207a0`, `FUN_00421340`).
  - Background pictures are drawn 1:1 at that origin.
  - logo.pic is drawn at x = trunc(320 − w/2) (+12 for logo_us; `fistp`
    at 0x421185), with no
    horizontal centring offset, and y = (H>>1) − 220 (`FUN_004210e0`).
- **Colours.** ColourIndex: TEXT_BLACK 0, TEXT_WHITE 1, TEXT_GREEN 2,
  TEXT_ORANGE 3 (`FUN_00420330`). The palette at `0x539728` in the 128 scale is
  (0,0,0), (128,128,128), (0,128,0), (128,95,0), [4] (64,128,64). As bytes:
  black, white, (0,255,0), (255,189,0).
  - Highlighted items use c·0.5 + 64.
  - glow.spr is drawn additively (flag 8) behind them, tinted c·0.2.
  - Text alpha fades in as (fade − 8)/8, and is halved when item flag 0x10 is
    set (inferred: disabled).
- **LineUpMode** (enum `0x5398d4`…): NONE 0, VERT_TOP 1, VERT_CENTRE 2,
  VERT_BOTTOM 3, HOR_LEFT 4, HOR_CENTRE 5, HOR_RIGHT 6, VERT_FILLOUT 7,
  HOR_FILLOUT 8. The layout algorithm was not decoded.
- **Window frame** (`FUN_00421340`, per MenuScreen):
  - Rectangle (x0+1, y0+1)–(x1+1, y1+1). It opens horizontally from the centre
    over 8 ticks (f = min(1, ticks/8)).
  - Outline line strip (0,191,0) α f.
  - Header line at y0 + 21.
  - Vertical gradient (0,255,0) α 0.2f at the top to 0.05f at the bottom.
  - Without a background picture, a black rectangle α 0.66f on top.
  - Drawn in reverse submission order: black, gradient, header line, outline.
- **Sounds.** menusystem/SOUND/sounds.res: menu_music, menu_ok, menu_cancel,
  menu_high, menu_sel, menu_sel2, menu_k01–07 (ILSF; the k* sounds are
  format 3).
- **In-game menu** (ingamemenu.qvm, ingamemenu.res):
  - Screen 900 "Game Paused" (font3, white title).
  - Frame 85,80–555,410.
  - Items (green): Resume Game, Restart Game, Sound, Controls,
    Quit to Main Menu.
  - Sub-screens 901–903 use mainmenu.pic.
  - Dialogs 930–933 "Are you sure?" Yes/No at 220,180 (200×120).
- **Main menu**: screen 900 with frame 100,163–540,470 on mainmenu.pic; items
  Single Player, Configuration, Select Player, Quit; Read Me and Credits in
  font4, orange.

## 9. Port integration notes

- **Files to stage.**
  - `computer/computer.res` (HUD font) is **not** in `web-port/scripts/stage-raw.mjs`
    REQUIRED; add `"computer/"`.
  - Everything else is already covered: `screens/`, `menusystem/`, `common/`,
    `language/english/`.
- **Exports.** `src/loaders/index.ts` does not export `ui.ts` yet. Add
  `export * from "./ui"` (or named exports) for the engine.
- **Drawing.** Draw the HUD in a separate 2D pass after the 3D frame. A
  `CanvasRenderingContext2D` overlay is the simplest exact match:
  - nearest-neighbour (`imageSmoothingEnabled = false`)
  - `globalCompositeOperation = "source-over"` = SRCALPHA/INVSRCALPHA
  - vertex colour = tint by multiply, e.g. draw a pre-tinted copy of the glyph
    atlas for the green radio text.

  Alternatively use an orthographic Three.js scene with MeshBasicMaterial
  (`map × color`, `transparent`, NearestFilter, depthTest off) and
  renderOrder = reverse submission order.
- **Scaling.**
  - **Exact:** render at the canvas's real pixel size with anchors at
    fraction·(W, H) and sprites 1:1. This is what the original does at
    800×600 and 1024×768; the HUD gets smaller at higher resolutions.
  - **Recommended for a browser window:** a virtual 640×480 (or 800×600)
    canvas, upscaled by an integer factor with nearest filtering. This keeps
    the proportions of the 640×480 original. Then start every quad at
    `pixelStart(x)` in virtual pixels.
- **Text.**
  - Fonts are proportional bitmap fonts. Use `layoutText` and `measureText`;
    never a browser font.
  - computer/font3 already has the green colour baked in; draw it with a
    neutral tint.
  - Radio text is the white menusystem font1 tinted to (0,239,0).
- **Timing.** Drive messages, pulses, fades and the loading bar from the
  30 Hz game tick (`GAME_TICKS_PER_SECOND`), not from the render frame rate.
  `statusMessageFrame(tick, …)` reproduces the radio timeline.
- **Colour overflow.** Reproduce the 252/253 overflow colours of the damage
  and flash overlays with `vertexColourByte`; a clamped 255 differs by 1–3
  levels.
- **Video.** The intro needs an IV50 decoder (not available in browsers) and
  an ILSF format 2 decoder. Until then the port should start at the main menu
  or the loading screen and must not invent replacement footage.

## 10. Recovered while implementing the port (web-port/src/engine/ui/)

These were traced after sections 1–9 were written; the implementation is in
`web-port/src/engine/ui/` and the decompiles are in the integration scratch
notes. Labels as elsewhere.

- **LineUpMode layout** (FUN_00423a80 / FUN_004239f0 / FUN_004239d0)
  [recovered]: all 9 modes and the centre flags, with C integer division.
  It reproduces the in-game menu items at y 101 / 126 / 151 … and Read Me at
  y 433. Implemented in `menu-model.ts`.
- **MenuManager state machine** (FUN_00416f70) [recovered]:
  - fade 0 → 16 in steps of 2;
  - Push / Pop / Request / LeaveMenus and pop-ups;
  - the LeaveMenus-IDLE guard while the mission has failed;
  - the idle state with the 151-tick failure timer, and Space / Return / Esc
    when dead.
- **Selection and input** [recovered]:
  - The first selectable item is selected when a screen opens; hover selects
    and plays menu_high.
  - A click is press-inside then release-inside.
  - Arrow keys and Enter go through the exe's virtual-key table; dialogs swap
    the keys (SwapKeys).
  - pointer.spr is drawn only in menu state 2, offset (−2, 0).
- **Highlighted items** [recovered]: colour c·0.5 + 64, plus an additive glow
  quad of 1.8w × 1.4h tinted c·0.2. Disabled MenuTextConditional items are
  drawn at half alpha.
- **Main-menu BackgroundFX** [recovered]: a rotating grid, lines and circles
  at alpha 0.075, stepped twice per 30 Hz tick (the main menu runs at 60
  ticks/s).
- **Radio box** [recovered]: the green fill is a gradient; the bottom-right
  vertex has green 1.0. The word wrap measures with FUN_004ad2e0, which
  counts the full pen advance including spaces.
- **Flash-bang** [recovered]: starts at 2.0, falls 1/90 per tick above 1.0
  and 1/60 below; drawn at alpha min(v, 0.99).
- **Directional damage tint** [recovered branch structure at
  0x4125d9–0x41282a; inferred]: the mapping of world axes and signs to the
  four corners.
- **Binocular and sniper overlays** [recovered]:
  - Binoculars: mask halves, RANGE text, compass tape with WNES labels,
    12 level bars, "[ ]" chevrons and centre lines.
  - Sniper scope: four mirrored quadrants and the cross hairs.
  - Bilinear sampling only where the exe sets flag 0x1000000.

Still open after section 10 (now covered by sections 11–13): the widgets,
menu music, the idle attract mode, the M203 counter, the binocular target
squares and the map computer.

## 11. Map computer

The MapComputer action opens a hand-held "satellite" computer with three
pages: a live top-down view of the level (map), the objective list and a log
of the radio messages. Port: `web-port/src/engine/ui/computer.ts` (model),
`computer-draw.ts` (drawing), `computer-world.ts` (task data); tests
`web-port/tests/ui-computer.test.ts`. All addresses: igi.exe, image base
0x400000.

### 11.1 Objects and life cycle [recovered]

| Object | Class / functions | Role |
|---|---|---|
| Computer | `FUN_0046a5e0` (ctor `FUN_0046a690`, update `FUN_0046a8d0`, dtor `FUN_0046ab00`) | The tool. Global `DAT_005c1680` = the open computer (this is the "map computer open" test of the StatusScreen, section 4). |
| ComputerMenu | `FUN_00469700` (ctor `FUN_00469780`, update `FUN_004697d0`, draw `FUN_004699d0`) | Pointer, mouse buttons, page switching (`FUN_00469b50`: 1 map, 2 objectives, 3 log). |
| ComputerMap | `FUN_00468240` (ctor `FUN_004682d0`, update `FUN_00468c70`, dtor `FUN_00469620`) | Page 1. |
| ComputerObjectives | `FUN_004679a0` (ctor `FUN_00467a10`, draw `FUN_00467ca0`) | Page 2. |
| ComputerLog | `FUN_00467420` (ctor `FUN_00467490`, draw `FUN_00467740`) | Page 3. |
| ComputerStartup | `FUN_00464f50` (ctor `FUN_00464dc0`, update `FUN_00465810`, draw `FUN_00465870` + `FUN_00465000`) | INITIALIZING / CONNECTING / DOWNLOADING bar. |
| ComputerObject | `FUN_00466280` (draw `FUN_004664f0`) | Markers over the map. |
| ComputerHilight | `FUN_00466e60` (ctor `LAB_00467060`, compile `FUN_00467130`, draw `FUN_00467310`) | Mission task: labels and sprites on objects. |
| DefineComputerObjective | `FUN_00465af0` (update `FUN_00465f90`) | Mission task: the six objectives (mission.md). |
| DefineComputerLimit | `FUN_004659c0` (`DAT_005c11a0`) | Mission task: clamps the map centre (`FUN_00468da0`, `FUN_00469510`). Not in level 1. |
| MenuItemTask / MenuItem | `FUN_004fbad0` / `FUN_004fc2f0` (update `FUN_004fbbb0`, item message `FUN_004fc480`) | Hover and click dispatch of the computer's buttons. |
| ComputerButtonItem / ComputerTextItem | `FUN_0046a0c0` (create `FUN_0046a200`, draw `FUN_0046a170`) / `FUN_0046a370` (create `FUN_0046a4f0`, draw `FUN_0046a410`) | Sprite buttons and text buttons. |
| LineFilter | `FUN_004992e0` (draw `LAB_00499bd0`) | Scan lines and interference (the cut-scene LINE filter class). |

- **Opening** [recovered]. The player state `FUN_0040e470` (an entry of the
  player state table 0x5366c0) plays an animation (`FUN_00488290`, blend
  0.2), enters player state 4 and creates the Computer. The Computer:
  - loads the model "mapcomputer" when the map is enabled;
  - creates its own camera and a full-screen view (`FUN_00415c40(0, 0, 1,
    1)`) and switches the main view off (`FUN_004dee00`/`FUN_004dedd0`), plus
    `FUN_004985b0(0)` (`DAT_00541b38`, a renderer flag; purpose not traced);
  - resets the zoom to 0 (`FUN_004696e0`), targets the player
    (`FUN_004696f0`) and opens page 1, or page 2 when the map is disabled.
- **Map enabled** [recovered]: HumanPlayerInput "Mapcomputer on expression"
  (0x45cb23): `DAT_0053dd64` = fistp(eval) each tick, 1 when the expression
  is empty (level 1: empty, map enabled). Without the map, the objectives
  and log pages have no "Map" item and the objective buttons are absent.
- **Closing** [recovered]: `FUN_0040e4c0` each tick leaves the state when the
  MapComputer input channel (+0x230 = channel 32) rises from 0 (+0x190 = the
  previous tick), or when state flag 0x20000 is set (inferred: forced exit,
  e.g. hit or death). The dtor deletes the menu (the pointer starts centred
  next time) and restores the main view.
- **What keeps running** [recovered]: the computer is a player tool, not a
  pause. The world, AI and messages continue. The computer itself does not
  update while the game is paused (`FUN_00415c50` test in `FUN_004697d0`).
  The player HUD is not drawn while it is open (`DAT_005c1680`, section 4);
  radio messages are (StatusMessageScreen draws always). That they appear on
  top of the computer screen is inferred.

### 11.2 Pointer, buttons and items [recovered]

- **Pointer** (`FUN_004697d0`): starts at (W/2, H/2). Each tick x += look
  channel 0 × W × 0.5, y += channel 1 × H × 0.5, reading the human's
  channels +0x1b0 / +0x1b4 (`FUN_0045cde0`: clamp(counts / 255, ±1) ×
  clamp(GOInMouSens, 0.05, 1), channel 1 negated by +0x538), the vertical one
  multiplied by −1 again when +0x538 is non-zero (so the pointer is never
  inverted). At the shipped 0.4 one mouse count moves it about 0.5 px in
  640 × 480. Clamped to [W·0.0484375, W − W·0.0453125] × [H·0.0541667,
  H − H·0.0958333] = [31, 611] × [26, 434]. Frozen while the sphere is
  dragged (+0x2c). [recovered; port: hud.ts pointerStep]
- **Buttons**: mouse button 1 → bit 0x10, button 2 → 0x20 (+0x30); pressed
  edges +0x34. The wheel arrives as the bits 0x100 (up) and 0x200 (down) of
  the mouse state (`MOUSE_WHEEL_UP/DOWN` in the key table).
- **Items** (`FUN_004fbbb0`, `FUN_004fc480`), every tick:
  1. each item: highlighted = hovered-this-tick ? 1 : highlighted; hovered = 0;
  2. if the pointer did not move and no button 0x70 is held: the (last)
     highlighted item's id is dispatched; nothing otherwise;
  3. else if it did not move and an item is highlighted: dispatch that id;
  4. else every item whose rectangle [fistp(x), fistp(x + w)] ×
     [fistp(y), fistp(y + h)] (inclusive) contains the pointer dispatches its
     id; if none, id 0 is dispatched (un-highlights all).
  Dispatch: the item with that id is marked hovered, every other one loses
  its highlight, and every item's callback runs with the message (id, motion,
  position, buttons, pressed).
- **Button item** rectangle: sprite width × max(18, sprite height) (the
  empty computer/font1 label is 18 high, inferred for an empty text). Sprite
  `_1` normal, `_2` highlighted, `_3` highlighted while the left button is
  held (+0x80, set by the page callbacks). Drawn neutral, alpha 1.
- **Text item** rectangle: text width × line height; in-game menu font3
  (`FUN_00417c50` takes fonts from the in-game MenuManager); colour from the
  table 0x53d780 (x/128 scale: 0 (128,16,16), 1 (16,96,16), 2 (48,96,48),
  3 (128,128,128)); highlighted: c × 0.5 + 64.

### 11.3 The map page

**Camera** [recovered `FUN_004682d0`, `FUN_004688a0`, `FUN_00468e70`]:
- Rotation = Rx(−π/2)·Rx(−π/2) (`FUN_004a9e40`, `FUN_004a97d0`): looking
  straight down, screen right = +x (east), screen up = +y (IGI north).
- Position = target + the down column of Rx(−π/2) × −921600 = target + 225 m.
  Every tick a ray from the camera goes 450 m (1843200 units) straight down;
  on a hit the camera becomes hit + 225 m (it follows the ground or roof
  under the map centre).
- Field of view: the horizontal tangent is `fptan` of the zoom angle
  (0x53d700): 45°, 18.75°, 8°, 0.55° (zoom 0–3) → tan 1, 0.339, 0.1405,
  0.0096; vertical = 0.75 × it (4:3, rendering.md). At zoom 0 the view spans
  450 m × 337.5 m at ground level.
- Submitted with `FUN_004cfed0(camera, pos, M, tan, 1.0, 300.0, …)`.
- Port: `Hud.mapComputerView()` = { position (engine m), forward (0,−1,0),
  up (0,0,−1), tanX, fovYDegrees }.

**Screen tint and filter** [recovered; order partly inferred]:
- ComputerMenu draw: full-screen rectangle (0,127,0)/128, flags 0xc0040000:
  ZERO/SRCCOLOR, i.e. the whole view is multiplied by (0, 253, 0)/255 →
  monochrome green. On the other pages the page's opaque black rectangle
  covers it.
- LineFilter colour (0,0,0): a line every 4 px (y = 0, 4, … 476) across the
  view, alpha 0x4c; then, while the intensity v > 0: n = 10v (if n < 1 the
  row step becomes 1/n and n = 1), fistp(n) segments per row, each from
  x0 = rand × W to min(x0 + rand × 50, W), grey trunc(rand × 255), alpha
  trunc(v × 255). It uses its own generator (`DAT_006c62c8`) and runs per
  drawn frame.
- Intensity (+0x78, `FUN_00468c70`): 1.0 when the page opens with 60 ticks to
  the next burst; each tick: if the countdown is 0 → v = 0.1 + rand × 0.4,
  countdown = 15 + rand(75), else countdown − 1; then v −= 1/30. A zoom
  change (`FUN_00468b80`) sets v = 0.95 + rand × 0.05 and the countdown to
  15 + rand(75). These draws use the level generator (`FUN_00415c20`).
- Draw order used by the port: world, multiply, markers, LineFilter,
  buttons and texts, startup bar, pointer. Every computer primitive is drawn
  immediately (bucket −1), so this is submission order; the order between
  the page's children (markers, filter, items, startup) follows their
  creation order [inferred].

**Controls** [recovered `FUN_00468940`, `FUN_00468ed0`]:

| Id | Sprite | Position (fx = W·0.834375 = 534, fy = H·0.7125 = 342) | Action |
|---|---|---|---|
| 3 | arrow1 (46×29) | (fx − 23, fy − 47) = (511, 295) | pan north while held |
| 4 | arrow3 (46×29) | (fx − 23, fy + 18) = (511, 360) | pan south |
| 5 | arrow4 (30×46) | (fx − 47, fy − 23) = (487, 319) | pan west |
| 6 | arrow2 (30×46) | (fx + 18, fy − 23) = (552, 319) | pan east |
| 7 | plus (24×24) | (fx − 48, fy + 48) = (486, 390) | zoom in on the press edge |
| 8 | minus (24×24) | (fx + 24, fy + 48) = (558, 390) | zoom out |
| 9 | sphere (34×34) | (fx − 17, fy − 17) = (517, 325) | drag: hide and freeze the pointer, move the map |
| 1 | "Objectives" | (W·0.1, H·0.8083) = (64, 388) | page 2 (left press) |
| 2 | "Log" | (64, H·0.775 = 372) | page 3 |

- Pan: 27306.666 units × tan^0.7 per held tick (`pow` via `FUN_0049c620`,
  exponent 0.7 at 0x531a28): 6.67 m per tick at zoom 0, 3.13 m at zoom 1.
  Panning stops tracking.
- Drag: map += (channel 0, −channel 1 after the pointer's own sign rule) ×
  409600 × tan^0.7.
- Zoom buttons: on the press edge, if the zoom changes, the markers are
  hidden (`FUN_00466e50(…, 0)`) and the startup restarts; `mapcomp_01` plays on
  every press edge (also at the limit). Then, for every button message, the
  tangent of the current zoom is applied: if it changed, `mapcomp_05` and
  `mapcomp_03` play (2-D, volume 1) and the interference burst starts.
- On the map itself (no item highlighted): the wheel (edges) or a double left
  click within 13 ticks zooms in, a double right click zooms out (both
  restart the startup but keep the markers). A single left click casts a ray
  through the pointer (`dir = right·bx + down·by + forward`, 1000 m) and:
  picks the first human within sqrt(tan) × 10 m of the hit (squared distance
  < tan × 167772160 units²), a mine or a security camera (selects it: its
  view cone is drawn, `FUN_00441fb0`); unless a mine or camera was picked and
  the point is inside the DefineComputerLimit box, the map recentres on the
  hit; a picked human (or a clicked vehicle / human hit directly) is tracked
  (+0x90: the map follows it every tick); otherwise tracking stops.

**Startup** [recovered `FUN_00464dc0`, `FUN_00465810`, `FUN_00465870`,
`FUN_00465000`, `FUN_004681f0`]:
- Starts with every map page and every zoom change. Steps INITIALIZING (9
  ticks), CONNECTING (4.5), DOWNLOADING (9); a step ends when its timer (+1
  per tick) exceeds its length, i.e. after 10, 5 and 10 ticks. After each step
  the marker set becomes 4 (hilights), 0x15 (+ humans, vehicles) and 0x1f
  (all).
- Step 0 covers the whole view with opaque black.
- Bar: outline from (W·0.15, H·0.65) = (96, 312), size 320 × 12, colour
  (25,255,25); fill from (97, 313) to (96.5 + 319·t/length, 323.5),
  colour (0,127,25); pre-transformed vertices (no −0.5 offset).
- Text: the step's computer.res string at (96, 312 − 9 − 2) in computer
  font3, colour (12.7, 127, 12.7)/128.

**Markers** [recovered `FUN_004664f0`, `FUN_00466970`, `FUN_00466aa0`,
`FUN_00466c20`, handlers registered for message `DAT_0053d532`]:
- Projection (`FUN_00466130`): x = W/2 + (W/2)·vx/(depth·tan), y = H/2 +
  aspect·(W/2)·vy/(depth·tan) in the camera frame.
- Shape markers: line strips from `PTR_DAT_0053d5a0` scaled by size ×
  (W/2)/tan/depth (`FUN_004962b0`; size = the object's +0xa0, at least 3072
  units), rotated by −yaw (`FUN_004a9f30`), alpha 0.75, colours 0x53d5b8
  (0..255 passed through the x/128 scale, so 255 overflows: red → (252,0,0)).
  Shapes: 0 box (±1), 1 soldier triangle (0,−2.5)(1.5,1)(−1.5,1), 2 player
  triangle (0,−7.5)(4.5,3)(−4.5,3).
- Player (`FUN_004136d0`): shape 2, colour (64,255,64), every zoom.
- Soldiers (`FUN_0045eef0`): zoom 1 and 2 only, in the world, inside the view
  and visible along a ray from the camera; shape 1, colour (64,255,64) for
  teams 0 and 2, red otherwise (level 1: team 1, red).
- Hilights (`FUN_00467310` → the linked object's handler `FUN_00446ad0`): the
  "Click to select sprite" (h_*.spr) centred on the object; the marker shape
  and colour (MARKER_BOX 0 / MARKER_COLOR_RED 0, YELLOW 1, GREEN 2, BLUE 4,
  NONE −1); text at fistp(projected position), wrapped at 128 px, in-game
  font4, colour 0 (red): the title at zoom 1, the info text at zoom ≥ 2.
- Security cameras (`FUN_00441e40`, zoom > 0): h_scamera1, or h_scamera2 at
  the camera's animation frame; the selected one's view cone (`FUN_00441fb0`).
- Sentry guns h_sentrygun (`FUN_0046d570`), proximity mines h_mine when
  revealed (`FUN_00474680`), vehicles a box (`FUN_004667e0`, zoom 1–2).
- Level 1: 17 ComputerHilights (all "Hilight" 1, all MARKER_NONE): building
  titles and infos from messages.res, plus h_1.spr on the garage (1120);
  5 SCameras; 29 soldiers (team 1).

### 11.4 Objectives and log pages [recovered]

- **Objectives** (`FUN_00467ca0`): opaque black screen. x = W·0.15 = 96 (W·0.1
  without the map), y = H·0.1 = 48. For each of the six objectives with a
  text: the button `objective_1/2.spr` (ids 3–8) moves to (x − 34, y + 2);
  "%s %d: " with objectives.res OBJECTIVE and the number, followed by
  FAILED ("Failed!") / COMPLETE / INCOMPLETE, wrapped at 400 px in the
  in-game font3, colour 2; then the objective text in font4, colour 1; the
  next objective starts 8 px lower. Clicking a button (left held) targets the
  linked task and opens the map there. Items "Map" (64, 388) and "Log"
  (64, 372).
- **Log** (`FUN_00467740`, `FUN_00467960`): the last 50 radio texts
  (non-cut-scene messages that got a slot, `FUN_004845c0`); full → the oldest
  is dropped. Cleared by StatusMessageScreen_ClearMessages (`FUN_00483ad0`)
  and on restart. Drawn newest first from (96, 48), at most 15 entries, each
  wrapped at 400 px in the in-game font1, colour 1, then a 100-px line
  (48,96,48) → (0,16,0) 2 px below it, 4 px gap. Scroll arrows arrowup /
  arrowdown at (58, 48) and (58, 84) on the press edge (0 … count − 15).
  Items "Map" (64, 388), "Objectives" (64, 372).
- Text layout (`FUN_00467fe0`): words keep their trailing space; a word goes
  on the line if its full pen advance is smaller than the room left, else the
  pen returns to x one line height lower.
- Strings: language computer.res (MAP, OBJECTIVES, LOG, INITIALIZING,
  CONNECTING, DOWNLOADING), objectives.res (OBJECTIVE, COMPLETE, …, the
  objective texts) and messages.res (building titles); a missing key shows
  "RM: key".

### 11.5 Port wiring

`Hud.openMapComputer()` / `closeMapComputer()` / `isMapComputerOpen()` /
`mapComputerView()`; the HUD reads the mouse itself (window `mousemove`
movementX/Y, buttons, wheel) while the computer is open, and multiplies the
3-D frame through a `mix-blend-mode: multiply` element. game.ts must open
and close it on the MapComputer action, keep the player in a "using the
computer" state, and render the world from `mapComputerView()` (nothing
when it is null).

## 12. Menu sub-screens and widgets

Port: `menu-widgets.ts`, `menu-config.ts`, `menu-model.ts`, `menu-draw.ts`;
tests `tests/ui-widgets.test.ts`.

### 12.1 Screens [observed: mainmenu.qvm, ingamemenu.qvm]

| Menu | Screen | Contents |
|---|---|---|
| main | 904 Configuration | Graphics, Sound, Controls, Language (hidden for USA), Content Control, OK |
| main | 905 Graphics | ListBox Render Device, ListBox Resolution, SlideBar Performance Level (7 steps), Reset to Default (dialog 935), OK (commit) / Cancel |
| main | 906 Sound | SlideBars Music Volume, FX Volume (size 100) |
| main | 907 Controls | ToggleBox Invert Mouse, SlideBar Mouse Sensitivity, ControlsMenu + vertical SlideBar, Reset to Default (dialog 931) |
| main | 910 Language | English…Spanish (MenuManager_SetLanguage) |
| main | 911 Advanced Graphic Options | toggles on the performance flags; no item opens it |
| main | 912 Player Configuration | ListBox profiles, PictureBox mission, Delete Player (its script has a syntax error: does nothing), InputBox Add Player → dialog 933 Easy / Medium / Hard |
| main | 913 Read Me | AsciiBox "LANGUAGE:readme.txt" 430 × 276, font4 |
| main | 914 Select Mission | (section 10) |
| main | 915 Content Control | ToggleBox Blood Enabled, InputBox password (hidden) |
| main | 916 Credits | TypeWriterBox 610 × 270 |
| in-game | 902 Sound, 903 Controls | as 906 / 907 (sizes 140); OK = PopScreen(TRUE) |
| in-game | 901 Graphics | not reachable from 900 |

There is no load / save game screen and no separate objectives or briefing
screen in either menu (the objectives are on the map computer).

### 12.2 Data flow [recovered]

- Screens are persistent task objects: PushScreen and RequestScreen open the
  target with a data load (state 0 → `FUN_00417580` → `FUN_00417600`):
  MenuScreen "On Init Data" (`FUN_004218d0`), then every widget's Get Data.
  PopScreen returns without loading (state 1), so the widgets keep what they
  showed. Pop-ups load when they open (`FUN_00417720`).
- Commit (`FUN_00416420`) = RequestScreen(id, TRUE) / PopScreen(TRUE):
  "On Change Data" (`FUN_00421970`), then every widget's Set Data, before the
  screen changes.
- "Modify Data Script" runs at once on every change (the volume sliders apply
  live; Cancel does not undo them).
- `MenuManager_ForceUpdateWindow(id)` reloads one window (the resolution list
  after a device change, the profile list after a new / deleted profile).
- While an InputBox edits or the ControlsMenu waits for a key the manager is
  in state 3 (`FUN_00417dd0` / `FUN_00417de0`): it neither moves the selection
  nor takes mouse buttons; the widget reads the key queue (`FUN_00488cf0`;
  characters positive, special keys negative) or the raw key state.

### 12.3 Widgets [recovered; addresses in `menu-widgets.ts`]

Common: every widget starts at (300, 230), centred in its parent; it fades
with alpha (fade − 8)/8; its box (`FUN_00423f50`) is an outline (0,1,0), or
(0.5,1,0.5) when the parent frame is highlighted, over black × 0.5. Keyboard
LEFT / RIGHT / RETURN reach widgets through their selectable MenuFrame.

- **SlideBar**: track "Size" (default 50), horizontal unless "Horizontal" is
  FALSE, sprites `<res>_1` (minus), `_2` (plus), `_3` (knob). Width =
  track + 6 + both button widths, height = max(button heights, knob) + 4.
  Value 0..1 (double); step = "Carret Speed" (default 0.05) or 1/(n − 1)
  with "Set Num Options" n. Minus / plus clicks or LEFT / RIGHT step it (with
  menu_high, only inside 0..1); dragging inside the track sets it to
  (pointer − track start)/(track − knob size); with n options it snaps to
  floor((n − 1)v + 0.5)/(n − 1); nValue = fistp((n − 1)v + 0.5). Loading with
  options uses (i + 0.5)/n. Draw: buttons at (x + 2, y + 2) and after the
  track, knob at fistp((track − knob)·v).
- **ToggleBox**: 50 × 15; left half "Yes" (on), right half "No" (off), font4,
  black, centred in each half; the chosen half filled (0,128,0)/128, or
  (64,128,64) when highlighted. LEFT / a click on the left half switches on,
  RIGHT / the right half off (menu_high).
- **ListBox**: "<" and ">" buttons around a text field of "Width" (default
  100); width = text width + 6 + buttons, height = buttons + 4. Clicks or
  LEFT / RIGHT cycle (wrapping); a changed id plays menu_high and runs
  Modify. Text centred, green (0,128,0)/128, "Font Resource"; longer than
  width − 4 → cut to width − 12 and "..." appended.
- **InputBox**: height 15, "Width", at most "String Length" − 1 characters
  (default 20). A click or RETURN starts editing (menu_k01, cursor at the
  end); HOME, END, LEFT, RIGHT, BACKSPACE, DELETE edit; characters insert
  (menu_k0 1–7 by the character code); ESC leaves; RETURN leaves and runs
  "On Modify Script". Text in font1 at (x + 2, y + 2), '*' per character when
  "Hide Input"; a 6-px caret line at y + 12 blinks twice a second.
- **ControlsMenu**: 360 × 200, 27 actions (table 0x5345b8, names from
  menusystem.res), ten rows of 20 px from "nOffset" (0..17, driven by the
  vertical SlideBar through ControlsMenu_ConvertFloatFromOffset /
  ConvertOffsetFromFloat). Row: action name at (x + 4, y + 5) green, key name
  at (x + 214, y + 5) (128,85,0)/128; backgrounds (x, 210 px) (0,32,0) /
  (0,16,0) and (x + 210, 150 px) (0,48,0) / (0,32,0) by row parity, alpha × 0.5;
  outline and a divider at x + 211. A click on a row shows "Select a key or
  button" (a fixed English string), plays menu_sel2 and waits: ESC cancels
  (menu_cancel); the first key or mouse button held (table 0x5349f8 order,
  127 entries) is assigned (menu_k0 random 1–7) and any other action that
  had it gets this action's old key. "isReset" (Reset to Default → Yes)
  reloads the defaults (0x534470, the shipped config bindings).
- **AsciiBox**: the text file wrapped at width − 28 at spaces, tabs and new
  lines; rows of font line height + 2 from (x + 4, y + 4); a vertical
  "slidevert" SlideBar at x + w − 19 with one option per line chooses the first
  row; the box is drawn 20 px narrower.
- **TypeWriterBox**: a 130-entry script compiled into igi.exe (0x537cd8,
  36 bytes: x (0 centred, < 0 right-aligned − 8, > 0 + 8), y (−1 page
  break), palette colour, font 1–4, pause, page-start flag, localised flag,
  text). One character every 4 updates (60 Hz in the main menu), the pause
  after a line, at a page end 253 updates during which the page fades to
  white then out; a block cursor (3/4 line height) blinks with the frame
  counter bit 3. It sets the manager's "modified" flag every update.

### 12.4 Settings [recovered `FUN_00402ab0` registrations; profile 0x564 bytes at 0xb680c8]

| Setting | Field | Effect in igi.exe | Port API |
|---|---|---|---|
| Invert Mouse | +0x538 (GOInMouInv). The menu shows **Yes when the field is 0** (`FUN_00403c90`). The shipped config.qvm stores 0 (config.qsc says 1) | look inversion; the map pointer un-negates it | `settings.snapshot().invertMouse` / `invertField` |
| Mouse Sensitivity | +0x53c float (GOInMouSens 0.4) | look scale (the scale itself is not recovered) | `mouseSensitivity` 0..1 |
| FX Volume | +0x224 (GOSoundFX) | DirectSound master scale `DAT_005417ec` (audio.md) via Game_UpdateVolume `FUN_00414bf0` | `fxVolume` → `mixer.fxVolume` |
| Music Volume | +0x228 (GOSoundMusic) | only the Windows CD mixer line (`FUN_00494150`); the in-game music is unaffected | `musicVolume`: levels the port's menu music (inferred, §13); the in-game music is unaffected, as in igi.exe |
| Key bindings | binding table +0x234 (GOInRemap) | Input remap | `bindings` (GOInRemap form) |
| Profiles | name, difficulty (GOGameDiff 0–2), active mission | LevelFlow difficulty (mission.md), mission list | `profileName`, `difficulty`, `activeMission` |
| Gamma, performance flags, resolution, device | graphics block | renderer settings | resolution: the frame size; performance flags: terrain threshold and model LOD scale at the next level load (bits 1/2/4/8 not modelled); gamma: no effect, as in igi.exe (no gamma ramp is set, [rendering.md](rendering.md)); device: WebGL only |
| Blood, content password | +0x8, global | blood effects | blood: `effects.setBlood`; password: stored |

**Story / Free mode dialog** (port addition, ui/mode-menu.ts): "Play
Project IGI" (900, text key "Single Player") opens DialogWindow 936 at the
Quit dialog's place and size (197, 234, 256 × 133) with "Story Mode", "Free
Mode" and "Cancel". Both modes run `Game_SetPlayMode(n)`, close the dialog and
push the original Select Mission screen 914. Story Mode lists the missions up
to the profile's progress (as igi.exe); Free Mode lists every staged mission.
Finishing a mission in Story Mode makes its DefineMission "next mission"
playable [inferred: the exe's progress update was not traced]; Free Mode
leaves the progress alone.

**Cheats screen** (port addition, ui/cheat-menu.ts): the entry "Cheats" is
added to Configuration (904, after Content Control) and to Game Paused
(in-game 900, after Controls); it pushes screen 920, built like Content
Control (915): one selectable row per cheat (MenuText + ToggleBox 980–984,
LineUpMode 8, 29 px apart), OK = `MenuManager_PopScreen(TRUE)` (the toggles'
`Config_CheatSet(i, this.isOn)` run), Cancel = `PopScreen(FALSE)`. The new text
keys are not in menusystem.res; the port supplies them.

The port keeps the profiles in the browser's storage (`MenuConfig.save` /
`restore`, saved on every applied change) where igi.exe writes config.qsc;
without storage every page load starts from config.qvm.

`Config_GraphicOptionsGetPerfLevelFromFlags` = the first entry of
{0, 0x41, 0x4d, 0xd, 0x60, 0xae, 0x9e} with the fewest differing bits;
resolutions are listed as "%dx%dx%d" with id (bpp << 13 | w) << 13 | h, and
"Get" picks the closest mode (|dw|·|dh| + |dbpp|·0x1000000). New profiles:
at most 16, name trimmed of trailing blanks, empty or duplicate (strcmpi)
names refused, settings copied from the active profile.

## 13. Other 2-D items

- **Menu music** [recovered by absence]: menusystem/SOUND/sounds.res is
  registered whole when a MenuManager loads (`FUN_00416c40` →
  `FUN_004dd3b0`) and unregistered by `FUN_00416a70`, but the name
  "menu_music" occurs in no executable string, script (.qvm / .qsc) or other
  file. Nothing in this exe plays it (no MCI_PLAY either; [audio.md](audio.md)
  "Menu music"). The port loops it on the front-end menus at the music
  volume [inferred], because the sample ships for that purpose and players
  hear it; the menus of igi.exe as analysed here are silent apart from their
  click sounds.
- **Idle attract mode** [recovered `FUN_00416f70` 0x416fb0–0x41705d, flow
  table 0x4028a0, `FUN_00418340`, `FUN_00418210`]: in an own-display menu,
  every update compares the current screen, the mouse state, the selection
  and the key queue with the last snapshot; with no change and the
  "modified" flag clear the counter rises, and above 3600 updates (60 s at
  the main menu's 60 Hz) the manager is deleted and Flow event 8 starts:
  the intro (eidos.avi, innerloop.avi; no USA difference) in a loop. Esc
  stops it (Flow 3, the main menu opens at screen 900). Any change resets
  the counter; the Credits screen sets "modified" every update, so it never
  times out. Port: `HudCallbacks.onAttract` (the movies are not decodable).
- **Binocular target squares** [recovered `FUN_00470510`, `FUN_004708f0`]:
  see `binocular-targets.ts`: ten slots of humans (in the world, not dead,
  in the frustum, projected in front), first-seen / last-seen in GetTickCount
  ms, a square ±1 shrinking from 11× to 1× and turning 90° in 250 ms, half
  size radius × (W/2)/tanX/depth (radius = the human's +0xa0, its bounding
  radius = model header +0x78; the same value feeds the frustum sphere test
  `FUN_004c5420`), red (127,0,0) for team 1 and green
  otherwise, drawn only with a clear line of sight to the human's eye,
  forgotten 3 s after leaving view; replaced by depth when full. Port:
  `Hud.setBinocularTargets(list)` every frame while zoomed.
- **M203 counter** [recovered `FUN_00471e40`, `FUN_00479190`]: after the Gun
  panel, the AMMO_ID_M203 pool in "%-4d" right-aligned at W·0.984375 − 4 − 8
  − clip20 width − main counter width, top H·0.8958333 + 4, then
  M16_alternative.spr 8 px further left. Port: `Hud.setM203Rounds(n)`.
- **Camera LineFilter** (cut-scene filter type 1, also the map's
  interference): drawing recovered above (`LAB_00499bd0`).

## 14. Open questions

- Which hit direction sets which damage corners (`FUN_004126e4`,
  `FUN_004127b5`, `FUN_00412c04`), and where the flash-bang value +0xddc is set
  and decayed.
- How the barrel spin counter (+0x19c) advances.
- The movie subtitle layout (MovieSubtitle_RegisterFont/Text, intro font3/4.fnt).
  IV50 and ILSF format 2 decoding are out of scope.
- The exact on-screen colour of the two binocular tape-centre markers (their
  unscaled vertex colours overflow).
- The loading buffer's clear colour and the blit's channel order (inferred:
  black, X8R8G8B8).
- What view mode +0xe8 == 1 means precisely (inferred: first-person player
  view). `DAT_005c1680` is the open Computer (section 11).
- Map computer: the scale of the look channels that move its pointer; the
  relative order of the deferred startup bar, the LineFilter and the
  immediate markers / items; the human "+0xcf6" flag and the exact ray filter
  of the soldier visibility test; the security-camera cone geometry
  (`FUN_00441fb0`) and the SCamera state bits +0x168 / +0x170; vehicle box
  markers (+0x745); what `FUN_004985b0(0)` switches off.
- Menus: the look-path meaning of GOInMouInv and GOInMouSens (only the menu
  side is recovered); the enumerated D3D device and display-mode names (the
  port lists "WebGL" and six common modes); language switching.
