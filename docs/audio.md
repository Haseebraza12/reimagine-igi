# Audio: samples, sound definitions, mixer and events

How Project I.G.I. (`igi.exe`) stores, selects and mixes its sounds, recovered
so the browser port can play the same sounds, voices, music and ambience.
Mission: `missions/location0/level1` (Trainyard).

- Reference tool: `python3 tools/igi_audio.py` (stdlib only). It decodes and
  checks every audio file, checks the recovered constants in `igi.exe`, and
  prints the level-1 sound tasks and the event table. `--wav-dir DIR` writes
  RIFF previews.
- Browser loader: `web-port/src/loaders/audio.ts`.
- Tests: `web-port/tests/audio.test.ts`. The TypeScript decoder must produce
  the same SHA-256 per file as the Python decoder, for all 376 files.

Labels: **observed** means measured from data (file and method given).
**recovered** means read from `igi.exe` code (virtual address given; image
base 0x400000). **inferred** means an assumption.

## 1. ILSF sample files

The loader is `FUN_00494250`. It is called for every `.wav` member of a
`.res` archive and for every loose `.wav` in a sound directory (`FUN_004dd520`
→ `LAB_004dd540`; archives go through `FUN_004dd3b0` → `LAB_004dd410`).
[recovered]

| Offset | Field | Notes |
|---|---|---|
| 0 | `"ILSF"` | `cmp eax,0x46534c49` at 0x494285. Any other magic logs "SOUND - File %s not valid format!" [recovered] |
| 4 | u16 format | See the format table below. [recovered] |
| 6 | u16 bits | Always 16. [observed] Used as the WAVEFORMATEX bit depth. [recovered] |
| 8 | u16 channels | 1 or 2. [observed] [recovered] |
| 10 | u16 flags | 0x1002 for formats 1 and 3; 0 for formats 0 and 2. [observed] The loader and player never read it. [recovered, `FUN_00494250`, `FUN_00494b40`] |
| 12 | u32 sample rate | 11025, 22050 or 44100. [observed] |
| 16 | u32 frame count | |
| 20 | payload | |

| Format | Meaning (recovered) | Payload (observed) |
|---|---|---|
| 0 | PCM16, streamed from disk | frames × channels × int16 LE; file = 20 + 2·frames·channels exactly |
| 1 | PCM16, copied into a DirectSound buffer at load | as format 0 |
| 2 | IMA ADPCM, streamed and decoded on the fly (`FUN_00494d70` → `FUN_00494f70`) | (frames>>1)·channels + 1 bytes |
| 3 | IMA ADPCM, decoded into the buffer at load (`FUN_00494250` case 3) | as format 2 |

Streamed files use a 2-second ring buffer (`FUN_00494b40`). When a looping
file reaches the end, the stream seeks back to byte 20 and resets the ADPCM
state (`FUN_00494d70`). [recovered]

### IMA ADPCM decoder (recovered, `FUN_00494560`)

The tables at 0x541800 and 0x541810 are the standard IMA index table
(`-1,-1,-1,-1,2,4,6,8`, repeated) and the 89-entry step table.
`tools/igi_audio.py` checks both against `igi.exe`.

- There are no block headers. The payload is one nibble stream. Each channel
  starts with predictor 0 and step index 0.
- Each byte gives two nibbles, **high nibble first**. Nibbles are interleaved
  by frame across the channels: nibble `f·channels + c` belongs to frame `f`,
  channel `c`.
- `step = STEP[i]; d = step>>3; if (n&4) d += step; if (n&2) d += step>>1;
  if (n&1) d += step>>2; if (n&8) d = -d`.
- The predictor is clamped to −32768..32767. The index becomes
  `clamp(i + INDEX[n], 0, 88)`.
- The extra trailing byte is never read: only ⌈frames·channels/2⌉ bytes are
  consumed. [observed, recovered]

How the decoder was checked:

- **All files decode.** Every one of the 37 ADPCM files decodes. At most 0.1 %
  of samples clip, which matches the source material: PCM files peak at 32767
  too. [observed]
- **Wrong nibble order fails.** On every mono file, decoding low nibble first
  either clips or more than doubles the RMS (DC random walk). Example:
  `m01_ing_01` gives RMS 3585 and no clipping; low-first gives RMS 17376 and
  clips. [observed]
- **Wrong interleave fails.** Splitting stereo by whole bytes instead of
  nibbles clips thousands of samples per 100 k bytes (`m1o_truck`: 4745).
  With the recovered nibble interleave, L/R correlation is plausible
  (`m1o_truck` 0.97, `m1_music` 0.71). [observed]
- **Channel order.** L = first nibble comes from the code. The data cannot
  prove it, because swapping channels is symmetric. [recovered]
- **Python and TypeScript agree.** Both decoders match sample-for-sample
  (SHA-256 table in `audio.test.ts`). [observed]

### Inventory (observed, `python3 tools/igi_audio.py`)

| Source | Files | Formats | Total duration |
|---|---|---|---|
| `common/sounds/sounds.res` | 332 `.wav` + 1 PATH member | all format 1: 302 mono 22050 Hz, 28 mono 44100 Hz, 2 stereo 22050 Hz (`alarm_1`, `helicopter_1`) | 309.1 s |
| `menusystem/SOUND/sounds.res` | 13 | 6 × format 1 at 44100 Hz (`menu_music` stereo); 7 × format 3 (`menu_k01..07`) | 39.9 s |
| `missions/location0/level1/sounds` | 29 | 28 × format 2 (22 mono, 6 stereo); 1 × format 0 (`m1_beeps01`) | 534.3 s |
| `screens/intro` | 2 | format 2, stereo, 44100 Hz | 29.7 s |

| File | Fmt | Ch | Rate | Frames | Seconds |
|---|---|---|---|---|---|
| `_cut01_01` | 2 | 1 | 22050 | 2154993 | 97.732 |
| `m01_ing_01` / `_02` / `_03` / `_04` / `_05` | 2 | 1 | 22050 | 57078 / 449536 / 42582 / 46976 / 488448 | 2.589 / 20.387 / 1.931 / 2.130 / 22.152 |
| `m1_ambience` | 2 | 2 | 11025 | 461793 | 41.886 |
| `m1_beeps01` | 0 | 1 | 22050 | 483324 | 21.919 |
| `m1_heliaway01` / `m1_heliblad01` / `m1_heliblad02` | 2 | 1 | 22050 | 179566 / 137964 / 108534 | 8.144 / 6.257 / 4.922 |
| `m1_heliby01` / `m1_heliby02` / `m1_heligen01` / `m1_heliinside01` | 2 | 1 | 22050 | 116388 / 87934 / 132354 / 69558 | 5.278 / 3.988 / 6.002 / 3.155 |
| `m1_music` | 2 | 2 | 22050 | 3196294 | 144.957 |
| `m1_office01` / `m1_office02` / `m1_office03` | 2 | 1 | 22050 | 448546 / 336859 / 341995 | 20.342 / 15.277 / 15.510 |
| `m1_trainby01` | 2 | 2 | 22050 | 94195 | 4.272 |
| `m1_trainext01` / `m1_type01` | 2 | 1 | 22050 | 82198 / 483324 | 3.728 / 21.919 |
| `m1o_baseamb` / `m1o_train2` / `m1o_truck` | 2 | 2 | 22050 | 377820 / 94195 / 406652 | 17.135 / 4.272 / 18.442 |
| `m1o_hammer` / `m1o_train1` / `m1o_wind` / `machinery_01` | 2 | 1 | 22050 | 64511 / 87040 / 227322 / 61183 | 2.926 / 3.947 / 10.309 / 2.775 |
| `eidos` / `innerloop` (intro) | 2 | 2 | 44100 | 721770 / 587776 | 16.367 / 13.328 |

### Sample registry (recovered)

A sample's key is its base name: the text between the last `/`, `\` or `:`
and the **first** `.`, upper-cased (`FUN_00495600`, `FUN_004956c0`,
`FUN_00495680`). If a key is already loaded, the later file is rejected
("SOUND - File %s already loaded!").

At level start, `LOCAL:common/sounds` loads first, then `MISSION:sounds`
(`FUN_00414e77`). The menu archive loads and unloads with the menus
(0x416c96 / 0x416b4f).

## 2. Sound definitions (`sounds.qvm`)

`common/sounds/sounds.qvm` loads before the mission's `sounds/sounds.qvm`
(0x414f31). The script functions are registered in `FUN_004dcd10`; all
arguments are positional. [recovered]

| Call | Arguments | Handler |
|---|---|---|
| `DefineGroup(name, child…)` | Grouping only. A group is itself a lookup target. | `LAB_004e2610` |
| `DefineSound` | name, sample, x, y, z, volume, minDist, maxDist, volVar, pitchVar, sampleVar, unused, loop | `LAB_004df830` |
| `DefineGraph` | name, sample, x, y, z, volume, minDist, maxDist, volVar, pitchVar, sampleVar, volCurve[11], pitchCurve[11] | `LAB_004e18c0` |
| `DefineTriggerOnce` | name, sample, x, y, z, volume, minDist, maxDist, unused, trigVar, volVar, pitchVar, sampleVar, loop, onZero | `LAB_004e0ab0` |

What each argument means (recovered from the handlers, the object layout
`FUN_004df330`, the save format string at 0x549a64, and `FUN_004df990` /
`FUN_004e1a40` / `FUN_004e0c30`):

- **name** (≤ 32 bytes) is the lookup key. **sample** is a sample key
  (case-insensitive).
- **x, y, z** are an offset in IGI units, transformed by the parent's matrix
  and position when the parent publishes one (parent message 0x546673).
  Otherwise they are absolute. Several `TEMP` and `RADARDISHSOUNDS`
  definitions carry editor leftovers here, such as (24260572, −56117744,
  174477024). These are overwritten when the user sets a position.
- **volume** is linear 0..1, clamped. It is multiplied by a runtime volume
  (`SetVolume` message 0x546677, default 1) and by the base volume, which is
  1 or the parent variable `volVar`.
- **minDist / maxDist** are metres (×4096 units, 0x531498). See §3.
- **volVar / pitchVar / sampleVar** are indexes into the float/string array
  the parent object publishes. −1 means none. Trains publish var 1 = volume
  (§4: var0 = pitch, var1 = on/off).
- **unused** (DefineSound arg 11, DefineTriggerOnce arg 8) is copied and
  saved but never read at runtime.
- **loop** selects `DSBPLAY_LOOPING` (bit 0x10, `LAB_004df0d0`, 0x4e03d8).
  A looping definition lives until its owner kills it. A one-shot
  self-destroys once its elapsed time reaches the sample length and the
  voice has stopped (`FUN_004df3f0`; elapsed += 1/30 s per tick).
- **DefineGraph curves** are two 11-point tables over the parent variable
  0..1 (`FUN_004ddbf0`).
  - The index is `i = trunc(x·10)`: `fistp` at 0x4ddc47, and the FPU runs
    in chop mode (gameplay.md "FPU rounding mode").
  - The code then interpolates linearly between grid points `i` and `i+1`
    (x0 = float32(i·0.1f)). So the curve is plain piecewise-linear and
    never reads past values[10].
  - Graphs are driven continuously by their parent; looping is inferred.
- **DefineTriggerOnce** plays once when `trunc(var[trigVar])` becomes
  non-zero, or, with `onZero`, when it becomes 0 (truck / APC / M60
  start/stop).

**Every definition starts positional.** Flags 0x2c = 2 are set in
`FUN_004df190`. The message 0x54667b ("relative to microphone",
`FUN_004e09a0`) clears that flag, which makes the sound 2D.

**Lookup** goes through `FUN_004dd750`, which broadcasts message 0x546674
over all definitions. The first exact, case-sensitive byte match wins
(`FUN_004df650` for sounds, `FUN_004e21f0` for groups, depth-first
pre-order). A match creates a fresh instance of the definition, with all
children for a group, as a child of the requesting object. Duplicate names
resolve to the first one: `machinery_01` resolves to `TEMP` (volume 0.35,
max 25 m), not to `POOL`. [recovered; behaviour on the files observed]

Counts [observed]:

- common: 26 groups, 360 DefineSound, 10 DefineGraph, 7 DefineTriggerOnce
- level 1: 5 groups, 24 DefineSound

30 definitions name samples that no level-1 directory contains (other
missions' samples). `m01_ing_01..05` and every `menu_*` sample are loaded,
but no definition names them.

## 3. Mixer: DirectSound use and 3D maths (recovered)

### DirectSound setup

`FUN_004935d0`:

- `DirectSoundCreate`, then `SetCooperativeLevel(DSSCL_PRIORITY)`.
- Primary buffer (`DSBCAPS_PRIMARYBUFFER`) format: **22050 Hz**, 16-bit when
  `DSCAPS_PRIMARY16BIT`, stereo when `DSCAPS_PRIMARYSTEREO`. It plays
  looping.
- **32 voices** (`DAT_005c606c`). A request with no free voice is dropped
  (`FUN_004dda00`).

Secondary buffers are created with flags 0x100e0 = CTRLFREQUENCY | CTRLPAN |
CTRLVOLUME | GETCURRENTPOSITION2 (0x494468, 0x494c50).

- **There is no DirectSound3D.** No buffer asks for CTRL3D, and
  `IID_IDirectSound3DListener` / `IID_IDirectSound3DBuffer` do not occur in
  the file. So there are no distance factor, rolloff or doppler settings.
- 3D is done in software every tick (30 Hz in game) by `FUN_004950f0`.
- The listener ("microphone") is the camera matrix and position copied by
  `FUN_00495090` from `FUN_004e2770` / `FUN_004de840`.

### Per-voice update (`FUN_004950f0`)

Positions are in IGI units; distances in the definition are in metres.

```
lo = minDist*4096, hi = maxDist*4096, rel = source - listener, d = |rel|
if positional:
    if d > hi:        v = 0
    elif d >= lo:     v = clamp((1 - (d - lo)/(hi - lo)) * v, 0, 1)   # linear fade
    (d < lo: unchanged)
    pan = 0 if d <= 0 else clamp((rel . M_col0) / (hi + lo), -1, 1)
DSBVOLUME = T[trunc(FX * v * 10000)]                    # FX = GOSoundFX volume, 0x5417ec
DSBPAN    = -sign(pan) * T[trunc((1 - |pan|) * 10000)]  # positive = right
frequency = trunc(sampleRate * clamp(pitch, 0.5, 2.0))
T[0] = -10000;  T[k] = clamp(trunc(ln(k*1e-4) * 1442.6950408888495), -10000, 0)   # ~ 1000*log2(k/10000)
# every trunc is a fistp in chop mode (gameplay.md "FPU rounding mode"); the products are chopped too
```

- **Volume table.** T is built at start-up in `FUN_004935d0`; the constants
  1e-4 (0x532250) and 1000/ln 2 (0x532248) are checked by the tool.
  - 0x532248 is 1442.6950408888495, slightly below 1000/ln 2 =
    1442.6950408889634.
  - This is **10 dB per halving**. WebAudio gain = 10^(DSBVOLUME/2000) ≈
    v^1.661.
  - The values are negative, so the truncating `fistp` (0x49361b) moves them
    toward 0. 5053 of the 10000 entries are 1 above the rounded value.
  - Examples: v = 0.5 → −999 (gain 0.316); v = 0.25 → −1999; v = 0.1 →
    −3321. Anything below about 0.001 → −10000.
- **Pan sign.** The "reverse stereo" word 0x5417f4 is a constant 1 and is
  never written. It makes the multiplier −1, so DSBPAN > 0 when pan > 0.
  DirectSound attenuates only the opposite channel.
- **Pan axis.** `M_col0` is column 0 of the microphone matrix (0x5c6098,
  0x5c60a4, 0x5c60b0). That it is the listener's right axis is
  **inferred**.
- **Out-of-range voices.** A definition's voice must be refreshed every
  tick; a voice that is not refreshed is stopped (`FUN_004dcf60`). A
  positional definition farther than maxDist is not refreshed
  (`LAB_004df0d0`), so it stops. Coming back in range restarts it: from 0
  for streamed files and loops, and at the elapsed time for in-memory
  one-shots (`SetCurrentPosition`, `FUN_00494a50`).
- **Fire-and-forget voices.** The raw-sample and by-name paths
  (`FUN_004ddd40`, `FUN_004dddc0`) set flag 1 and keep playing until they
  end.
- **Master volumes.** Only GOSoundFX's volume scales the DirectSound mix
  (0x5417ec, `FUN_00494210`). GOSoundMusic's volume drives the Windows mixer
  through `FUN_00494150` → `mixerSetControlDetails`. The CD is opened with
  MCI (0x493587) but never played: there is no `MCI_PLAY`. `config.qvm`
  sets all three volumes to 1.0.
- **Rounding.** Every conversion is a `FISTP` in chop mode, which
  truncates toward zero. [recovered]
  - `FUN_004966d0` runs before the table is built (0x48db81).
  - Precision is the Windows default of 53 bits.
  - No entry of T lies within 10⁻⁹ of a whole number except T[5000], T[2500],
    T[1250] and T[625]. Those come out 0.8–3.2·10⁻¹⁰ short of −1000 …
    −4000 and truncate to −999 … −3999, so the truncated table is exact
    whatever the last bit of the logarithm.

## 4. Event table

How sounds are found (recovered):

- **3D at an object.** Most events go through `FUN_004dd750(parent, name)`.
  The parent is the object, or the global root `DAT_00805f94` (from
  `FUN_004e7b80`). Then `FUN_004dd880` sets the position.
- **2D by name.** `FUN_004dddc0(name, flags, params)` takes only the
  definition's sample. Its own volume and distances are ignored; the voice
  is 2D at the caller's volume, which is 1.0 when params is null.
- **Raw sample.** `FUN_004ddd40(sample, …)` plays a raw sample, 2D, at
  volume 1.

Columns: definition volume (vol), min..max metres, loop, sample. All events
are positional unless marked 2D. "rand(n)" is uniform over 0..n−1 (RNG
`FUN_004aaa20`).

| Event | Sound(s) | Rule | Evidence |
|---|---|---|---|
| Automatic weapon fire (WeaponConfig "Maximum Rounds/Burst" > 1; MP5SD, AK47, Uzi, M16, Minimi, Jackhammer, M2HB …) | "Fire Sound Loop" (e.g. `mp5sd_loop`: 1.0, 0..65, loop) | Created at the gun position when firing starts and moved with the gun every tick. On release, burst cap, empty clip or reload: kill it and play "Loop End Sample" (`mp5sd_loop_e`: 1.0, 0..65, once) at the gun. | Gun update `FUN_004772c0` 0x4773e1–0x4774e7 [recovered]. Used by player and AI Gun tasks alike [inferred] |
| Single-shot weapon (burst ≤ 1: Glock, Colt, Deagle, Spas, Dragunov, knife …) | "Fire Sound" or "Loop End" field, 50/50 (`rng & 1`) | One-shot at the gun per round, e.g. `glock_shot_1` / `glock_shot_2` (both 1.0, 0..65) | 0x47749a [recovered] |
| Silenced weapon | Its own samples (`mp5sd_loop`, `svddrag_shot_1`) | No audio processing. Silencing only changes AI hearing (`HUMANAI_DETECTIONEVENT_GUNSHOT_SILENCED_RANGE`). | weaponconfig.qvm [observed] |
| Reload | animtrigger ids → definitions (MP5: 1006–1009, 1011 → `mp5_reload_1..5`: 1.0, 0..10 / 0..25) | Fired by animation trigger events. attach = true: child of the animated owner. | `FUN_005152c0`, animtrigger.qvm [recovered/observed]. Trigger frames live in the animations (not decoded here) |
| Dry fire | `guns_dry_1` (1.0, 0..30) | Child of the player model. Fires on an empty clip [inferred from the state machine] | `FUN_0040f1d0` |
| Bullet hits a surface | material `impact[rand(6)]` | At the hit point. Global limiter: at most one per 6..11 ticks (6 + rand(6)). | `FUN_00479e30` 0x47a173 |
| Ricochet | `riccochet_1..4` (rand(4); 1.0, 0..30) | With each surface-impact attempt; own 6 + rand(6) tick limiter. | `FUN_0047aa10` |
| Bullet passes near the player | `gunshotmiss` (sample `RICCOCHET_1`, 0.5, 0..6) | At the closest point; ≥ 5 ticks apart | 0x45f3ff |
| Footstep (player and AI) | material `walk[seq[k mod 12]]`, seq = 0,1,2,3,4,5,3,1,4,2,3,5 (0x53d2c8); `walk_rain_N` too when raining | On animation event 1010 (0x3f2). At the feet (+0x6a8). Pitch = 0.8 + 0.5·rand. Volume × 0.66 when walker flag +0x33d is set (that flag also suppresses the AI noise event; quiet walk [inferred]). AI noise radius = material arg 5 m. | `FUN_00462560` |
| Landing | material `land` | At the feet | `FUN_0040bce0`, `FUN_0040bf50`; AI 0x4533a1 |
| Fall damage (player) | `player_fall_1` / `_2` / `_3` for damage < 0.1, < 0.2, ≥ 0.2 of max health | Damage when \|v_z\|·30/4096 > 14 (m/s; units inferred) | `FUN_00408570` |
| Jump | `jump_1` | Child of player model | 0x40bbfd |
| Player hit / explosion hit | `player_hit_{rand(4)+1}` / `player_xplhit_1` (1.0, 0..31) | Child of player model. Ignored while now < next; then next = now + 30 + trunc(30·rand) = 30..59 ticks (0x462468). The previous line is **not** stopped: the handle store at 0x4624bf saves the killed instance, never the new one. | `FUN_00462400` |
| Player death | `player_death_{rand(3)}` → `_0` does not exist, so silent 1/3 of the time; `_1`, `_2` | Child of player | `FUN_004624e0` 0x40e6df |
| AI hit / explosion hit | `ai_hit_{rand(3)+1}` / `ai_xplhit_{rand(3)+1}` (1.0, 0..31) | Same 30..59 tick gate per soldier | `FUN_00462400` |
| AI death | `ai_death_{rand(4)}` → `_0` missing, so silent 1/4 of the time; `_4` never plays | Child of the soldier | `FUN_004624e0` |
| AI detects the player | `detected_01..06` (rand(6); 1.0, 0..200) | Child of the AI. Global cooldown: > 90 ticks (3 s) since the last one. No combat-music track exists. | `FUN_00488d40` |
| Knife hit | `stab_01` | | 0x45c0f0 |
| Status / radio message (StatusMessage "Sound") | Level 1: `message`, sample `MESSAGE` (0.317 s) | **2D, volume 1.0.** The definition's 0.7 is ignored. | `FUN_004845c0` → `FUN_004dddc0` |
| Voice lines `m01_ing_01..05` | — | Loaded, but nothing references them: no definition, task, message or exe string. Not played in this build. | observed |
| Intro cutscene voice-over | ConditionalSound 3998, Simple: raw sample `_CUT01_01` (97.7 s) | 2D, volume 1, no loop, one shot, while the intro container runs. Subtitles M1_CUT_01..16 are separate StatusMessages. | `FUN_004247d0` |
| Music | AmbientArea "music" → `m1_music` (0.5, loop) | See AmbientArea rules (§5) | `FUN_0044b1b0` |
| Weapon pickup / item pickup | `weaponpickup_1` / `pickup` | 2D, volume 1 | `FUN_0045ec30`, `FUN_0046af40` |
| Weapon drop | `weapondrop_01` or `_02` | At the weapon | `FUN_0046ba20` |
| Grenade bounce | `grenade_bnc_1` | | `FUN_004753f0` |
| Binoculars zoom | `bin_zoom_1` (0.5, loop) | | `FUN_0046f500` |
| Map computer zoom | `mapcomp_05` (sample missing → silent) + `mapcomp_03` | 2D, volume 1 | `FUN_00468b80` |
| Ear ringing after a blast | `earcandy` | No definition, so silent. Volume would be the blast intensity, decaying by 1/150 per tick. | `FUN_004111e0` |
| Security camera | `camera_move` while rotating; `camera_beep_s`; `camera_beep_l` / `_al` (alarm) | At the camera | `FUN_00440ca0`, `FUN_00440db0` |
| Door | "Open sound" when `isOpen` turns true; "Close sound" when `isClosed` turns true; "Move sound" while neither (killed on arrival) | At the door. Field names from script vars 0x53a774 / 0x53a768. | 0x4461bb–0x446288 |
| Explosion | Task "Explosion sound" (level 1: `explo_02_m` 1.0, 0..70; `explo_monitor` 1.0, 0..65) | At the explosion | `FUN_0047d570` |
| Train | `train_loop_1` (0.7, 5..100, loop) when the counter at +0x778 ≠ 0, else `train_loop_2` (0.5, 5..60, loop) | Child of the train. The train's variable block (+0x884) holds var0 = clamp(5·speed, 0.8, 1) and var1 = (speed > 0.001 ? 1 : 0). The definitions use volVar 1 and pitchVar 0, so the loop is silent when stopped and pitched 0.8..1.0 with speed. | 0x42aa90, 0x42ab3e. That the block is what the train publishes to its sounds is inferred. |
| Helicopter | Group `helicopter_1` → graph `helicopter_1` (0.5, 10..700) | Child of the heli. Volume and pitch curves over heli var 0. | 0x430994 |
| Truck / car | physicsobj type string, e.g. `truck_sounds` group (TRUCK_START/STOP triggers, truck_idle/engine graphs at volume 0, truck_gravel 0.4) | Child of the car | 0x42d63d |
| Menu | `menu_high` (cursor move), `menu_k01` / `menu_k0{1..7}` (typing), `menu_sel` (or a button's "Click Sound Resource", e.g. `menu_ok`), `menu_sel2` (slider / key binding), `menu_cancel` | Raw sample, 2D, volume 1 | `FUN_004ddd40` callers 0x4174d1…0x422d8a |
| Intro movies | `eidos.wav`, `innerloop.wav` | Raw sample, 2D, no loop, started with the AVI | `FUN_0048ef90` |

The "Play sound" field of Train, Heli and Car is an expression. When it is
empty, the sound always plays (`FUN_004e8360` returns false, so evaluation
is skipped). Every level-1 vehicle has it empty. [recovered]

### Level-1 references that are silent in the original

Observed with `tools/igi_audio.py`:

- `Walk0` and `Hit0`: placeholder names on the Air, Water and Flesh
  materials.
- `bul_dirt_1` / `bul_dirt_2`: the Ground material's impacts have no
  definition. Hits on Ground make only the ricochet sound.
- `earcandy`.
- `mapcomp_05`: its sample is not loaded.
- `player_death_0` and `ai_death_0`.
- `rain_1` / `rain_2`: their samples are not loaded.

## 5. Level-1 tasks that play sound

`objects.qvm` decoded with `tools/level_tasks.py`.

### ConditionalSound (`FUN_004246a0`)

The condition is re-evaluated every tick:

- **Rising edge:** start.
- **Condition false:** destroy the definition instance (stop). "Simple"
  sounds are not stopped this way; they run to the end.
- **OneShot:** once started, the task is no longer evaluated.
- **Simple:** SoundDef is a raw sample name, played 2D, volume 1, no loop.
- **Relative to microphone:** 2D definition.
- **Otherwise:** 3D definition at Position.

| Task | Definition (vol, m, loop) | Mode | Condition |
|---|---|---|---|
| 96, 93 | `alarmsystem_working` → ALARM_1 (1.0, 40..80, loop) | 3D at two positions | `AlarmControl_98.isAlarm` |
| 3000 heli gen 01 | `m1_heligen01` (0.5, loop) | 2D | CutScene_1200 tick < 11.5 s |
| 3004 heli gen 02 | `m1_heliblad02_vol1` (0.4, loop) | 2D | same |
| 3001 / 3003 heli inside | `m1_heliinside01` (0.6, loop), `m1_heliblad01` (0.6, once) | 2D | 11.5 s < tick < 16 s |
| 3002 heli by | `m1_heliby02` (0.8, once) | 2D | tick > 15.8 s |
| 3005 jones land on train | `land_ground_2` (1.0, once) | 2D | CutScene_1201 tick > 0.25 s |
| 3006 train by | `m1_trainby01` (0.8, once) | 2D | CutScene_1202 0..3.75 s |
| 3007 train full view | `m1_trainext01` (0.6, loop) | 2D | 10.2..19.79 s |
| 3008 / 3011 / 3012 office | `m1_office01` (0.7) + `m1_type01` (0.9) + `m1_beeps01` (0.9), loops | 2D | 19.79..35.29 s |
| 3009 / 3010 / 3013 office 2 | `m1_office03` (0.9) + `m1_type01` + `m1_beeps01`, loops | 2D | 38.8..53.6 s |
| 3998 cutscene voice-over | raw `_CUT01_01` | Simple, OneShot | `1`, inside the intro container (4001) |
| 1050 truck drive out | `m1o_truck` (1.0, once) | 2D | CutScene_1204 tick > 0 |
| 1051 / 1052 base amb | `m1o_baseamb`, `m1o_wind` (1.0, loop) | 2D | same |
| 1053 | `m1o_train1` (1.0, once) | 2D | CutScene_1204 tick > 7 s |

Never referenced in level 1: `m1_heliaway01`, `m1_heliby01`,
`m1_office02`, `m1o_hammer`, `m1o_train2`. Their definitions exist.

### AmbientArea (`FUN_0044b1b0`)

- **Inside test.** The listener is "inside" when its position, in the
  area's rotated frame, lies within ±Size (metres, ×4096; constants
  ±4096 at 0x5318b0 / 0x531498). Size is a half-extent.
- **Fade.** A fade value moves by ±0.05 per tick toward inside (1) or
  outside (0), so a full fade takes 20 ticks = 0.67 s.
- **Sound position.** The instance's position is set to the **listener's
  own position** each tick while inside, so distance attenuation is
  effectively off. Its runtime volume is the fade (`SetVolume(-1, fade)`).
- **Choosing a name.** When no instance exists and the delay counter is 0,
  the index is trunc(rand · n) over the SoundDef names (0x44b3c5, `fistp`
  in chop mode). rand = k/65536 < 1, so every name is equally likely.
- **Delay.** When a one-shot ends, or while fully faded out, the delay is
  trunc((rand · Random wait + Min Delay) · 30) ticks (0x44b48d).
- **Loops.** Looping definitions (music, wind) simply keep playing.

| Area | Half size (m) | Sound(s) | Delay |
|---|---|---|---|
| base ambience | 500 × 500 × 150 | `m1_ambience` (1.0, loop) | — |
| music | 500 × 500 × 150 | `m1_music` (0.5, loop) | — |
| dogs | 500 × 500 × 150 | `dog_01` / `dog_02` (0.4) | 25 + 25·rand s |
| wind gusts | 500 × 500 × 150 | `wind_fx_01` (0.7) / `wind_fx_02` (0.6) | 25 + 25·rand |
| the famous hammer | 500 × 500 × 150 | `hammer_01` (0.4) | 20 + 30·rand |
| heli and plane | 500 × 500 × 150 | `heli_by_01` (0.5) / `plane_by_01` (0.37) | 20 + 20·rand |
| metal stuff | 500 × 500 × 150 | `metal_01..03` (0.4) | 20 + 20·rand |
| wind behind / infront / on left / on right / small / roof / tissen | various | `wind_1` (0.75, loop) | — |
| windgusts at tower | 6 × 6 × 5 | `wind_fx_01` / `_02` | 4 + 4·rand |
| machinery room 01 / 02 | 5 × 9 × 4, 9 × 5 × 4 | `machinery_01` (TEMP def: 0.35, loop) | — |
| ventilation 01 | 24 × 6.5 × 6 | `ventilation_01` (0.9, loop) | — |
| electricity pole 1 / 2 / 3 | small | `electricity` → ELFENCE_LOOP (0.5, loop) | — |

Several wind areas overlap. Each area has its own instance, so overlapping
wind loops add up.

### Other level-1 tasks

- **StatusMessage** M1_MSG_4/5/6/7 and MISSION_FAILED play `message` (2D,
  volume 1). The two CAMERASOFFLINE messages and the 16 M1_CUT subtitles
  have no sound.
- **Doors:** 17 doors use `door_open_1` / `door_close_1` (1.0, 5..25, once)
  and `door_slide_1` (1.0, 0..25, once). Gates 400–403 and 408–409 use
  `gate_loop_e` (0.6, 5..25, once) and `gate_loop` (0.6, 5..25, loop).
- **Explosions:** AlarmControl, SCameraControl and Terminal use
  `explo_02_m`; the 6 Computer ExplodeObjects use `explo_monitor`.

## 6. WebAudio integration

**Context and samples**

- Use `new AudioContext({ sampleRate: 22050 })` where the browser allows it.
  The original mixes everything at 22050 Hz, so 44.1 kHz samples lose
  content above 11 kHz in the original too. This is the faithful choice;
  any rate works.
- Decode every sample with `decodeIlsfAny`. Keep them by `ilsfSampleKey`:
  common first, then mission. The first key wins.
- The streamed formats (0/2: music, ambience, voice-over) can be decoded
  whole. That takes 145 s × 2 ch for `m1_music`, about 25 MB as float32.

**Definitions**

- Load `readSoundDefinitions(common)` followed by `readSoundDefinitions(mission)`.
- Resolve names with `findSoundDefinition`; groups play all their members.

**Playing a voice, every tick (30 Hz)**

- Compute `computeVoice({volume, pitch, positional, source, listener,
  listenerRight, minDistance, maxDistance})`.
- Use one AudioBufferSourceNode → GainNode (left) / GainNode (right) →
  ChannelMerger, with `gainLeft` / `gainRight` and `playbackRate`. Mono
  sources feed both sides.
- Positional sounds beyond maxDistance must stop. They restart when back in
  range: looping or streamed from 0, in-memory one-shots at the elapsed
  offset.
- Cap at 32 simultaneous voices; drop new requests beyond that.
- Do **not** use PannerNode or HRTF: the original pans by attenuating one
  channel only.

**Events:** follow the table in §4. Notably:

- Weapon loops are started and killed by trigger state, with the end tail
  on release.
- Speech gates are 30–59 ticks, and death speech can be silent.
- Footsteps use the 12-step sequence.
- Impacts and ricochets have limiters.
- StatusMessage and pickups are 2D at volume 1.

**Staging:** besides the files already staged, the port needs
`material/material.qvm` (footstep and impact names) and
`animtrigger/animtrigger.qvm` (reload sounds). It also needs
`physicsobj/cars/truck/car.qvm` for the truck sound group; `physicsobj/` is
already staged.

## 7. Open questions

- **Pan axis.** Column 0 of the microphone matrix is assumed to be the
  listener's right axis. The camera matrix convention was not traced.
- **AI guns.** The rule that picks between the "Fire Sound" and
  "Loop End" fields comes from the burst field; this is recovered. That AI
  guns use the same Gun update is inferred.
- **Variables.** The meaning of the train counter +0x778 (with wagons?),
  the heli var 0 and the car variables (truck gravel) was not recovered.
- **Reload timing.** The animation frames carrying trigger ids 1000–1054 and
  1010 (footstep) are in the animation files, which were not decoded here.
- **Unused samples.** `m01_ing_01..05` have no reference in this build. No
  StatusMessage, definition or exe path plays them. Mapping them to
  M1_MSG_* texts would be a guess.
- **Menu music.** No code or menu script names `menu_music` [recovered]:
  every by-name call (`FUN_004ddd40`, 18 sites) passes `menu_high`,
  `menu_k01` / `menu_k0%d`, `menu_sel`, `menu_sel2`, `menu_cancel` or a
  widget's click sound; the archive loader (`FUN_00416c40` →
  `FUN_004dd3b0` → `FUN_00494250`) only copies each sample into a
  DirectSound buffer (`FUN_00494780` is Lock / copy / Unlock); the CD device
  is opened (`FUN_00493580`), stopped (`FUN_00494220`) and closed
  (`FUN_00493d70`) but never played (`mciSendCommandA` has three call sites,
  none MCI_PLAY); the GOSoundMusic volume drives only the mixer's CD-audio
  line (`FUN_00493920` picks component types 0x1005 / 0x1009 or "CD Audio").
  So this igi.exe build plays no menu music itself. The port loops
  `menu_music` (44.1 kHz stereo, format 1) 2D on the front-end menus at the
  profile's music volume, and stops it while a mission loads or runs
  [inferred: the sample ships in the menu archive and players report it
  playing; the trigger is not in this exe]. The archive is decoded at boot
  so the click sounds also work before the first mission.
- **The +0x33d walker flag.** It makes footsteps quieter (×0.66) and
  silent to the AI. It is assumed to be the walk (not run) state.
