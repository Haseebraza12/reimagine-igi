#!/usr/bin/env python3
"""Project I.G.I. (2000) audio: ILSF samples, sound definitions, the software
3D mixer and the game events that trigger sounds.  Stdlib only; run from the
repository root:  python3 tools/igi_audio.py  [--game DIR] [--wav-dir DIR] [--json]

Browser port: web-port/src/loaders/audio.ts (same decoders and maths), tests in
web-port/tests/audio.test.ts.  Full write-up with evidence: docs/audio.md.
Labels: [observed] measured from data, [recovered] read from igi.exe code (VA
given), [inferred] assumption.

ILSF  (.wav members of common/sounds/sounds.res and menusystem/SOUND/sounds.res,
       loose .wav in MISSION:sounds and screens/intro; loader FUN_00494250)
    0  "ILSF" (u32 0x46534c49; any other magic -> "SOUND - File %s not valid format!")
    4  u16 format     0 = PCM16 streamed from disk, 1 = PCM16 in memory,
                      2 = IMA ADPCM streamed, 3 = IMA ADPCM decoded at load
                      [recovered: switch in FUN_00494250, FUN_00494b40, FUN_004949c0]
    6  u16 bits (16)  8 u16 channels (1|2)  10 u16 flags (0x1002 for formats
                      1/3, 0 for 0/2 [observed]; never read by the loader [recovered])
   12  u32 sample rate   16 u32 frame count   20 payload
    PCM: frames*channels int16 LE, file = 20 + frames*channels*2 exactly [observed].
    ADPCM (FUN_00494560, tables 0x541800 / 0x541810 = the standard IMA index and
    89-entry step tables): no block headers; one continuous nibble stream,
    HIGH nibble first, nibbles interleaved per frame over the channels
    (frame f, channel c -> nibble f*channels + c); every channel starts with
    predictor 0, step index 0; predictor clamped to int16, index to 0..88:
        step = STEP[i]; d = step>>3; if n&4 d+=step; if n&2 d+=step>>1;
        if n&1 d+=step>>2; pred += -d if n&8 else d; i += INDEX[n&15]
    Streamed files restart from offset 20 with a fresh state when they loop
    (FUN_00494d70).  Payload length = (frames//2)*channels + 1 for all 37
    ADPCM files [observed]; only ceil(frames*channels/2) bytes are consumed.

Sound definitions (sounds.qsc compiled to sounds.qvm; handlers FUN_004dcd10):
    DefineGroup(name, children...)                       grouping only
    DefineSound(name, sample, x, y, z, volume, minDist, maxDist,
                volVar, pitchVar, sampleVar, unused, loop)        LAB_004df830
    DefineGraph(name, sample, x, y, z, volume, minDist, maxDist,
                volVar, pitchVar, sampleVar, volCurve[11], pitchCurve[11])
    DefineTriggerOnce(name, sample, x, y, z, volume, minDist, maxDist, unused,
                trigVar, volVar, pitchVar, sampleVar, loop, onZero)
    Distances in metres (x4096 IGI units, 0x531498); x,y,z offset relative to
    the parent object (absolute when the parent gives no transform).  The
    *Var fields index a float array the parent object publishes (-1 = none).
    Name lookup = first exact (case-sensitive) match, common defs before
    mission defs; sample lookup = case-insensitive base name of a loaded ILSF.

Mixer (FUN_004950f0, per voice per tick):  see dsb_volume(), dsb_pan(),
    voice_params() below.  DirectSound primary buffer 22050 Hz / 16-bit /
    stereo (FUN_004935d0); secondary buffers DSBCAPS_CTRLFREQUENCY|PAN|VOLUME|
    GETCURRENTPOSITION2 (0x100e0) - no DirectSound3D, no rolloff, no doppler.
"""
import argparse
import hashlib
import json
from fractions import Fraction
import math
import os
import struct
import sys
import wave
from array import array

HERE = os.path.dirname(os.path.abspath(__file__))
GAME = os.path.join(os.path.dirname(HERE), "Game Files")
sys.path.insert(0, HERE)
from igi_formats import FormatError, resource_members  # noqa: E402
from igi_qvm import QVM  # noqa: E402

# ------------------------------------------------------------------ ILSF
ILSF_HEADER = 20
FORMAT_NAMES = {0: "pcm16-stream", 1: "pcm16", 2: "ima-adpcm-stream", 3: "ima-adpcm"}
IMA_INDEX = (-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8)
IMA_STEP = (
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
    253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
    3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
    11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767)

# (index*16 + nibble) -> signed difference / next index; same arithmetic as
# FUN_00494560, precomputed so the stdlib decoder is fast enough.
_DIFF = []
_NEXT = []
for _i, _s in enumerate(IMA_STEP):
    for _n in range(16):
        _d = _s >> 3
        if _n & 4:
            _d += _s
        if _n & 2:
            _d += _s >> 1
        if _n & 1:
            _d += _s >> 2
        _DIFF.append(-_d if _n & 8 else _d)
        _NEXT.append(min(88, max(0, _i + IMA_INDEX[_n])))


def ilsf_header(data):
    """Validated ILSF header (dict).  Raises FormatError naming the offset."""
    if len(data) < ILSF_HEADER:
        raise FormatError(f"ILSF: {len(data)}-byte file is shorter than the 20-byte header")
    if data[:4] != b"ILSF":
        raise FormatError("ILSF: magic at 0x0 is not 'ILSF'")
    fmt, bits, channels, flags, rate, frames = struct.unpack_from("<4H2I", data, 4)
    if fmt not in FORMAT_NAMES:
        raise FormatError(f"ILSF: unknown format {fmt} at 0x4")
    if bits != 16:
        raise FormatError(f"ILSF: {bits} bits per sample at 0x6 (only 16 observed)")
    if channels not in (1, 2):
        raise FormatError(f"ILSF: {channels} channels at 0x8")
    if not 4000 <= rate <= 96000:
        raise FormatError(f"ILSF: implausible sample rate {rate} at 0xc")
    payload = len(data) - ILSF_HEADER
    if fmt in (0, 1):
        need = frames * channels * 2
        if payload != need:
            raise FormatError(f"ILSF: PCM payload at 0x14 is {payload} bytes, "
                              f"{frames} frames need {need}")
    else:
        need = (frames * channels + 1) // 2
        if not need <= payload <= need + 1:
            raise FormatError(f"ILSF: ADPCM payload at 0x14 is {payload} bytes, "
                              f"{frames} frames need {need} (+1 pad)")
    return {"format": fmt, "format_name": FORMAT_NAMES[fmt], "bits": bits,
            "channels": channels, "flags": flags, "sample_rate": rate,
            "frames": frames, "payload_bytes": payload,
            "duration": frames / rate}


def decode_ima(payload, channels, frames, high_first=True):
    """IMA ADPCM nibble stream -> interleaved int16 array (FUN_00494560).
    high_first=False is the wrong alternative used by the self-check."""
    n = frames * channels
    out = array("h", bytes(2 * n))
    pred = [0] * channels
    idx = [0] * channels
    diff, nxt = _DIFF, _NEXT
    c = 0
    for k in range(n):
        b = payload[k >> 1]
        nib = (b >> 4) if ((k & 1) == 0) == high_first else (b & 15)
        j = idx[c] * 16 + nib
        p = pred[c] + diff[j]
        if p > 32767:
            p = 32767
        elif p < -32768:
            p = -32768
        pred[c] = p
        idx[c] = nxt[j]
        out[k] = p
        c += 1
        if c == channels:
            c = 0
    return out


def decode_ilsf(data):
    """Any ILSF variant -> header dict + 'samples' (interleaved int16 array)."""
    h = ilsf_header(data)
    if h["format"] in (0, 1):
        s = array("h")
        s.frombytes(bytes(data[ILSF_HEADER:]))
        if sys.byteorder != "little":
            s.byteswap()
    else:
        s = decode_ima(data[ILSF_HEADER:], h["channels"], h["frames"])
    h["samples"] = s
    return h


def pcm_digest(samples):
    """SHA-256 of int16 little-endian samples (shared with audio.test.ts)."""
    s = array("h", samples)
    if sys.byteorder != "little":
        s.byteswap()
    return hashlib.sha256(s.tobytes()).hexdigest()


def stats(samples, channels):
    n = len(samples)
    if n == 0:
        return {"rms": 0.0, "peak": 0, "clipped": 0, "hf": 0.0, "dc": 0.0}
    energy = 0
    total = 0
    peak = 0
    clipped = 0
    for x in samples:
        energy += x * x
        total += x
        if x >= 32767 or x <= -32768:
            clipped += 1
        ax = -x if x < 0 else x
        if ax > peak:
            peak = ax
    hf = 0
    for c in range(channels):
        ch = samples[c::channels]
        prev = ch[0] if len(ch) else 0
        for x in ch[1:]:
            hf += (x - prev) * (x - prev)
            prev = x
    return {"rms": math.sqrt(energy / n), "peak": peak, "clipped": clipped,
            "hf": hf / energy if energy else 0.0, "dc": total / n}


def write_wav(path, h):
    with wave.open(path, "wb") as w:
        w.setnchannels(h["channels"])
        w.setsampwidth(2)
        w.setframerate(h["sample_rate"])
        s = array("h", h["samples"])
        if sys.byteorder != "little":
            s.byteswap()
        w.writeframes(s.tobytes())


# ------------------------------------------------------------------ files
SOURCES = (
    ("common/sounds/sounds.res", "res"),
    ("menusystem/SOUND/sounds.res", "res"),
    ("missions/location0/level1/sounds", "dir"),
    ("screens/intro", "dir"),
)


def sound_files(game=GAME):
    """Every ILSF of the four sources: (source, name, bytes) in load order."""
    for rel, kind in SOURCES:
        path = os.path.join(game, rel)
        if not os.path.exists(path):
            continue
        if kind == "res":
            data = open(path, "rb").read()
            for name, chunk in resource_members(data):
                if chunk.tag == "BODY" and name.lower().endswith(".wav"):
                    yield rel, name, chunk.payload(data)
        else:
            for fn in sorted(os.listdir(path)):
                if fn.lower().endswith(".wav"):
                    yield rel, fn, open(os.path.join(path, fn), "rb").read()


def sample_key(name):
    """Sample registry key: base name between the last / \\ : and the first
    '.', upper-cased (FUN_00495600 + FUN_004956c0/FUN_00495680)."""
    base = name.replace("\\", "/").split("/")[-1].split(":")[-1]
    return base.split(".")[0].upper()


def archive_digest(members):
    """SHA-256 over (name NUL sha256(int16le)) for each member in order."""
    h = hashlib.sha256()
    for name, digest in members:
        h.update(name.encode("latin1") + b"\0" + bytes.fromhex(digest))
    return h.hexdigest()


# ------------------------------------------------------------------ definitions
SOUND_FIELDS = ("name", "sample", "x", "y", "z", "volume", "min_distance",
                "max_distance", "volume_var", "pitch_var", "sample_var",
                "unused_11", "loop")
TRIGGER_FIELDS = ("name", "sample", "x", "y", "z", "volume", "min_distance",
                  "max_distance", "unused_8", "trigger_var", "volume_var",
                  "pitch_var", "sample_var", "loop", "trigger_on_zero")


def read_sound_definitions(qvm_bytes, origin="common"):
    """sounds.qvm -> flat list of definition records in declaration order."""
    out = []

    def walk(node, path):
        fn, args = node["fn"], node["args"]
        if fn == "DefineGroup":
            if not args or not isinstance(args[0], str):
                raise FormatError(f"DefineGroup without a name in {origin}")
            # Groups are lookup targets too: FUN_004e21f0 matches the group's
            # own name before searching its children (depth-first pre-order),
            # and an instance of a group instantiates every child.
            out.append({"kind": "group", "origin": origin, "group": "/".join(path),
                        "name": args[0], "sample": "",
                        "members": [c["args"][0] for c in args[1:]
                                    if isinstance(c, dict) and c.get("args")]})
            for child in args[1:]:
                if not (isinstance(child, dict) and "fn" in child):
                    raise FormatError(f"DefineGroup {args[0]!r} has a non-call child")
                walk(child, path + [args[0]])
            return
        if fn == "DefineSound":
            if len(args) != 13:
                raise FormatError(f"DefineSound with {len(args)} arguments (13 expected)")
            rec = dict(zip(SOUND_FIELDS, args))
            kind = "sound"
        elif fn == "DefineGraph":
            if len(args) != 33:
                raise FormatError(f"DefineGraph with {len(args)} arguments (33 expected)")
            rec = dict(zip(SOUND_FIELDS[:11], args[:11]))
            rec["volume_curve"] = list(args[11:22])
            rec["pitch_curve"] = list(args[22:33])
            rec["loop"] = True  # [inferred] graphs are engine loops driven by a parent
            kind = "graph"
        elif fn == "DefineTriggerOnce":
            if len(args) != 15:
                raise FormatError(f"DefineTriggerOnce with {len(args)} arguments (15 expected)")
            rec = dict(zip(TRIGGER_FIELDS, args))
            kind = "trigger-once"
        else:
            raise FormatError(f"unknown sound definition call {fn!r} in {origin}")
        for key in ("x", "y", "z", "volume", "min_distance", "max_distance"):
            if not isinstance(rec[key], (int, float)) or isinstance(rec[key], bool):
                raise FormatError(f"{fn} {rec['name']!r}: {key} is not numeric")
        rec.update(kind=kind, origin=origin, group="/".join(path),
                   positional=True)  # every definition starts 3D (0x2c = 2, FUN_004df190)
        out.append(rec)

    for statement in QVM(qvm_bytes).call_tree():
        walk(statement, [])
    return out


def find_definition(defs, name):
    """First exact match in load order, groups included, depth-first pre-order
    (FUN_004df650 / FUN_004e21f0 byte compare)."""
    for d in defs:
        if d["name"] == name:
            return d
    return None


def read_materials(material_qvm):
    """material.qvm DefineGameMaterial -> per material walk/land/rain/impact
    sounds (layout recovered from the handler FUN_00408060)."""
    mats = []
    for s in QVM(material_qvm).call_tree():
        if s["fn"] != "DefineGameMaterial":
            continue
        a = s["args"]
        mats.append({"name": a[0], "noise_radius": a[5], "walk": a[6:12],
                     "land": a[12], "rain": a[13], "impact": a[14:20]})
    return mats


def read_anim_triggers(animtrigger_qvm):
    """animtrigger.qvm DefineAnimTrigger(id, TASKTYPE_ANIMSOUND, def, attach)."""
    out = []
    for s in QVM(animtrigger_qvm).call_tree():
        if s["fn"] == "DefineAnimTrigger":
            a = s["args"]
            out.append({"id": a[0], "type": a[1]["symbol"] if isinstance(a[1], dict) else a[1],
                        "sound": a[2], "attach": a[3]})
    return out


# ------------------------------------------------------------------ mixer maths
UNITS_PER_METRE = 4096.0          # 0x531498 (double)
VOLUME_STEPS = 10000               # table 0x6201b8, built in FUN_004935d0
PITCH_MIN, PITCH_MAX = 0.5, 2.0    # 0x531508 / 0x531588
GAME_TICK_HZ = 30                  # FUN_004029a0(0x1e) at level start (0x414c89)
MAX_VOICES = 32                    # DAT_005c606c = 0x20


def round_half_even(x):
    """x87 FISTP as igi.exe runs it. The FPU is in chop mode (FUN_004966d0,
    checked every frame at 0x48dbc1; docs/gameplay.md "FPU rounding mode"),
    so despite the historical name this truncates toward zero."""
    return int(x)


def chop(exact):
    """An x87 double op in chop mode: the double nearest `exact` (Fraction) toward zero."""
    d = float(exact)
    if d != 0 and abs(Fraction(d)) > abs(exact):
        d = math.nextafter(d, 0.0)
    return d


def f32_chop(exact):
    """FSTP DWORD in chop mode: the float32 nearest `exact` toward zero."""
    x = Fraction(exact)
    d = struct.unpack("<f", struct.pack("<f", float(x)))[0]
    if d != 0 and abs(Fraction(d)) > abs(x):
        bits = struct.unpack("<I", struct.pack("<f", d))[0] - 1
        d = struct.unpack("<f", struct.pack("<I", bits))[0]
    return d


DS_TABLE_SCALE = 1442.6950408888495   # double at 0x532248 (1000/ln 2 = 1442.6950408889634)


def ds_table(k):
    """Table 0x6201b8[k], k = 0..10000 (FUN_004935d0 0x493605..0x49361b):
    T[0] = -10000; T[k] = clamp(trunc(ln(k * 1e-4) * 1442.6950408888495), -10000, 0)
    i.e. about 1000*log2(k/10000) hundredths of a dB (10 dB per halving),
    truncated toward 0 by the chop-mode FISTP (T[5000] = -999)."""
    if k <= 0:
        return -10000
    v = round_half_even(chop(Fraction(math.log(chop(Fraction(k) * Fraction(1e-4)))) * Fraction(DS_TABLE_SCALE)))
    return max(-10000, min(0, v))


def dsb_volume(volume, fx_volume=1.0):
    """IDirectSoundBuffer::SetVolume argument for a linear 0..1 volume
    (FUN_004950f0 0x4952f6: T[-fistp(fx * v * -10000)] = T[trunc(fx * v * 10000)],
    fx = GOSoundFX volume 0x5417ec)."""
    k = round_half_even(chop(Fraction(chop(Fraction(fx_volume) * Fraction(volume))) * VOLUME_STEPS))
    return ds_table(max(0, min(VOLUME_STEPS, k)))


def dsb_pan(pan):
    """SetPan argument for pan in [-1, 1] (positive = right speaker):
    -sign(pan) * T[trunc((1 - |pan|) * 10000)]; the 'reverse stereo' word
    0x5417f4 is a constant 1 (never written), which supplies the minus."""
    if pan >= 0:
        return -ds_table(round_half_even(chop(Fraction(chop(1 - Fraction(pan))) * VOLUME_STEPS)))
    return ds_table(round_half_even(chop(Fraction(chop(Fraction(pan) + 1)) * VOLUME_STEPS)))


def gain_from_db100(db100):
    """WebAudio linear gain for a DirectSound hundredths-of-dB value."""
    return 10.0 ** (db100 / 2000.0)


def voice_params(volume, pitch=1.0, sample_rate=22050, positional=False,
                 source=(0.0, 0.0, 0.0), listener=(0.0, 0.0, 0.0),
                 listener_right=(1.0, 0.0, 0.0), min_distance=0.0,
                 max_distance=1.0, fx_volume=1.0):
    """Recovered per-voice DirectSound state (FUN_004950f0).  Positions in IGI
    units; distances in metres.  listener_right = the microphone matrix column
    0x5c6098/0x5c60a4/0x5c60b0 ([inferred] = the listener's right axis)."""
    v = min(1.0, max(0.0, volume))
    pan = 0.0
    if positional:
        lo = min_distance * UNITS_PER_METRE
        hi = max_distance * UNITS_PER_METRE
        rel = [s - l for s, l in zip(source, listener)]
        dist = math.sqrt(sum(r * r for r in rel))
        if dist > hi:
            v = 0.0
        elif dist >= lo:
            v = min(1.0, max(0.0, (1.0 - (dist - lo) / (hi - lo)) * v))
        if dist > 0.0:
            x = sum(r * a for r, a in zip(rel, listener_right))
            pan = min(1.0, max(-1.0, x / (hi + lo)))
    p = min(PITCH_MAX, max(PITCH_MIN, pitch))
    vol = dsb_volume(v, fx_volume)
    dpan = dsb_pan(pan)
    return {"volume": v, "pan": pan, "ds_volume": vol, "ds_pan": dpan,
            "frequency": round_half_even(chop(Fraction(sample_rate) * Fraction(p))),
            "gain_left": gain_from_db100(vol + min(0, -dpan)),
            "gain_right": gain_from_db100(vol + min(0, dpan))}


def curve(values, x):
    """11-point curve of DefineGraph (FUN_004ddbf0): i = trunc(x*10) (fistp
    0x4ddc47, chop mode), so i <= 9 and the curve is piecewise-linear between
    the float32 grid points x0 = f32(i*0.1f), x1 = f32((i+1)*0.1f); the result
    is stored as float32."""
    if x >= 1.0:
        return values[10]
    if x <= 0.0:
        return values[0]
    i = round_half_even(chop(Fraction(x) * 10))
    step = Fraction(struct.unpack("<f", struct.pack("<f", 0.1))[0])   # 0x5313c8
    x0, x1 = f32_chop(i * step), f32_chop((i + 1) * step)
    if x0 == x:
        return values[i]
    if x1 == x:
        return values[i + 1]
    return f32_chop((values[i + 1] - values[i]) / (x1 - x0) * (x - x0) + values[i])


# ------------------------------------------------------------------ events
FOOTSTEP_SEQUENCE = (0, 1, 2, 3, 4, 5, 3, 1, 4, 2, 3, 5)   # 0x53d2c8, cycled mod 12
DETECTED = ("detected_01", "detected_02", "detected_03", "detected_04",
            "detected_05", "detected_06")                   # 0x53f574

# Definition names hard-coded in igi.exe (strings pushed before FUN_004dd750 /
# FUN_004dddc0); speech prefixes are formatted "%s%d" (0x53d480).
EXE_SOUND_NAMES = (
    "guns_dry_1", "grenade_tick_1", "earcandy", "wire_slide_1", "wire_drag_1", "wire_drag_2",
    "jump_1", "picklock_loop", "typecomp_loop", "typecomp_end", "player_fall_1", "player_fall_2",
    "player_fall_3", "punched_01", "punched_02", "elfence_spark1", "explo_03_l", "train_loop_1",
    "train_loop_2", "helicopter_1", "su27", "elfence_loop", "explo_camera", "camera_beep_l",
    "camera_beep_al", "camera_beep_s", "camera_move", "explo_02_m", "switch", "glass_crush_1",
    "glass_crush_2", "glass_crush_3", "stab_01", "weaponpickup_1", "gunshotmiss", "mapcomp_01",
    "mapcomp_03", "mapcomp_05", "pickup", "weapondrop_01", "weapondrop_02", "bin_zoom_1",
    "m203_launch_1", "explo_proxy", "proxy_arm", "grenade_bnc_1", "riccochet_1", "riccochet_2",
    "riccochet_3", "riccochet_4", "explo_flash") + DETECTED
# (prefix, first, n): hit speech asks for rand(n)+1, death speech rand(n)
# (FUN_00462400 / FUN_004624e0), i.e. names prefix+first .. prefix+(first+n-1)
SPEECH = (("player_hit_", 1, 4), ("player_xplhit_", 1, 1), ("player_death_", 0, 3),
          ("ai_hit_", 1, 3), ("ai_xplhit_", 1, 3), ("ai_death_", 0, 4))

# (event, definitions or rule, how, evidence)
EVENTS = (
    ("weapon fire, automatic (Max Rounds/Burst > 1)", "WeaponConfig 'Fire Sound Loop' e.g. mp5sd_loop",
     "def at gun position while the trigger is held; on release kill it and play 'Loop End' (mp5sd_loop_e)",
     "Gun update 0x4773e1-0x4774e7"),
    ("weapon fire, single (Max Rounds/Burst <= 1)", "'Fire Sound' or 'Loop End' field, 50/50 (rng & 1)",
     "one-shot def at gun position per round (glock_shot_1 / glock_shot_2)", "0x47749a"),
    ("dry fire (player)", "guns_dry_1", "def, child of the player model", "FUN_0040f1d0"),
    ("ear ringing after explosions (player)", "earcandy (no such definition: silent)",
     "volume = blast intensity, decays 1/150 per tick", "FUN_004111e0"),
    ("reload", "animtrigger ids 1000-1054 (e.g. MP5 1006-1009,1011 -> mp5_reload_1..5)",
     "AnimSound trigger at an animation frame; attach=true -> child of owner, else world position",
     "FUN_005152c0"),
    ("bullet hits surface", "material impact[rand 6]", "at hit point; global limiter: next >= 6+rand(6) ticks",
     "FUN_00479e30 0x47a173"),
    ("ricochet", "riccochet_1..4 (rand 4)", "with each surface impact, own 6+rand(6) tick limiter",
     "FUN_0047aa10"),
    ("bullet passes the player", "gunshotmiss", "at closest point, >= 5 ticks apart", "0x45f3ff"),
    ("footstep (player and AI)", "material walk[FOOTSTEP_SEQUENCE[k % 12]] (+ walk_rain_N if raining)",
     "on animation event 1010 (0x3f2); at feet (+0x6a8); pitch = 0.8 + 0.5*rand; volume x0.66 when flag +0x33d",
     "FUN_00462560"),
    ("landing (player, AI)", "material land", "at feet", "FUN_0040bce0, 0x4533a1"),
    ("fall damage (player)", "player_fall_1/2/3 (damage <0.1, <0.2, >=0.2 of max health)",
     "child of player", "FUN_00408570"),
    ("jump (player)", "jump_1", "child of player model", "0x40bbfd"),
    ("player hit / explosion hit", "player_hit_1..4 / player_xplhit_1",
     "child of player model; ignored while now < next; next = now + 30 + trunc(30 rand) = 30..59 ticks (previous speech is not stopped)",
     "FUN_00462400"),
    ("player death", "player_death_0..2 (0 does not exist -> silent 1/3)", "child of player", "FUN_004624e0"),
    ("AI hit / explosion hit", "ai_hit_1..3 / ai_xplhit_1..3", "same 30..59 tick gate per soldier",
     "FUN_00462400"),
    ("AI death", "ai_death_0..3 (0 does not exist -> silent 1/4)", "child of the soldier", "FUN_004624e0"),
    ("AI detects the player", "detected_01..06 (rand 6)", "child of the AI; global cooldown > 90 ticks",
     "FUN_00488d40"),
    ("knife hit", "stab_01", "child of the attacker", "0x45c0f0"),
    ("status / radio message", "StatusMessage 'Sound' (level 1: message)",
     "2D, volume 1.0 (def volume ignored), def sample only", "FUN_004845c0 -> FUN_004dddc0"),
    ("weapon / item pickup", "weaponpickup_1 / pickup", "2D, default parameters", "FUN_0045ec30, FUN_0046af40"),
    ("weapon drop", "weapondrop_01 or _02", "at weapon", "FUN_0046ba20"),
    ("grenade bounce", "grenade_bnc_1", "at grenade", "FUN_004753f0"),
    ("binocular zoom", "bin_zoom_1", "child of player", "FUN_0046f500"),
    ("map computer zoom", "mapcomp_05 + mapcomp_03", "2D, volume 1, pitch 1", "FUN_00468b80"),
    ("security camera", "camera_move (rotating), camera_beep_s, camera_beep_l / _al", "at camera",
     "FUN_00440ca0, FUN_00440db0"),
    ("door", "Door 'Open sound' / 'Close sound' once on reaching open / closed; 'Move sound' while moving",
     "at door", "0x4461bb-0x446288"),
    ("explosion", "task 'Explosion sound' (level 1: explo_02_m, explo_monitor)", "at explosion",
     "FUN_0047d570"),
    ("train", "train_loop_1 (counter +0x778 != 0) / train_loop_2",
     "child of train; var0 = clamp(5*speed, 0.8, 1) -> pitch, var1 = speed > 0.001 -> volume",
     "0x42aa90, 0x42ab3e"),
    ("helicopter", "group helicopter_1 (DefineGraph)", "child of heli", "0x430994"),
    ("ambient area", "AmbientArea 'SoundDef' list (trunc(rand*n) pick, uniform)",
     "at listener, volume x fade (0.05/tick), Min Delay + rand*Random wait between one-shots",
     "FUN_0044b1b0"),
    ("conditional sound", "ConditionalSound 'SoundDef'",
     "on condition rising edge; Simple = raw sample 2D; Relative to microphone = 2D; else 3D at Position",
     "FUN_004246a0, FUN_004247d0"),
    ("menu", "menu_high, menu_k01, menu_k0N, menu_sel, menu_sel2, menu_cancel, button 'Click Sound Resource'",
     "raw sample, 2D, volume 1, pitch 1", "FUN_004ddd40 callers 0x4174d1..0x422d8a"),
    ("intro movie", "eidos.wav / innerloop.wav", "raw sample 2D, no loop", "FUN_0048ef90"),
)


# ------------------------------------------------------------------ level 1
def level_sound_tasks(objects_qvm):
    """objects.qvm tasks that emit sound: ConditionalSound, AmbientArea,
    StatusMessage (Sound), Door, ExplodeObject-like, Train, Heli, Car."""
    import level_tasks
    rows = []
    for t in level_tasks.read_tasks(objects_qvm):
        p = t["params"]
        if t["type"] == "ConditionalSound":
            rows.append({"id": t["id"], "type": t["type"], "name": t["name"],
                         "defs": [p["SoundDef"]], "condition": " ".join(p["Condition"].split()),
                         "simple": p["Simple"], "one_shot": p["OneShot"],
                         "relative": p["Relative to microphone"], "position": p["Position"]})
        elif t["type"] == "AmbientArea":
            rows.append({"id": t["id"], "type": t["type"], "name": t["name"],
                         "defs": p["SoundDef"].split(), "size": p["Size"],
                         "min_delay": p["Min Delay"], "random_wait": p["Random wait"],
                         "position": p["Position"]})
        elif t["type"] == "StatusMessage" and p.get("Sound"):
            rows.append({"id": t["id"], "type": t["type"], "name": p["Text"],
                         "defs": [p["Sound"]], "condition": " ".join(p["Send"].split())})
        elif t["type"] == "Door":
            rows.append({"id": t["id"], "type": t["type"], "name": t["name"],
                         "defs": [p["Open sound"], p["Close sound"], p["Move sound"]]})
        elif "Explosion sound" in p and p["Explosion sound"]:
            rows.append({"id": t["id"], "type": t["type"], "name": t["name"],
                         "defs": [p["Explosion sound"]]})
    return rows


# ------------------------------------------------------------------ exe checks
def exe_checks(exe):
    """Spot-check the recovered constants in igi.exe (image base 0x400000,
    .text/.rdata/.data raw offset == RVA)."""
    def f32(va):
        return struct.unpack_from("<f", exe, va - 0x400000)[0]

    def f64(va):
        return struct.unpack_from("<d", exe, va - 0x400000)[0]

    checks = [
        ("ILSF magic compare at 0x494285", exe[0x94285:0x9428a] == b"\x3d\x49\x4c\x53\x46"),
        ("IMA index table 0x541800",
         struct.unpack_from("<16b", exe, 0x141800) == IMA_INDEX),
        ("IMA step table 0x541810", struct.unpack_from("<89h", exe, 0x141810) == IMA_STEP),
        ("dB table scale 1e-4 (0x532250)", f64(0x532250) == 1e-4),
        ("dB table factor 1000/ln2 (0x532248)", f64(0x532248) == DS_TABLE_SCALE and abs(f64(0x532248) - 1000 / math.log(2)) < 1e-9),
        ("dB table built with a truncating FISTP (0x49361b) after FUN_004966d0 set chop mode (0x4966d7 or 0xC00)",
         exe[0x9361b:0x9361f] == b"\xdf\x7c\x24\x3c" and exe[0x966d7:0x966e0] == b"\x66\x81\x0d\xdc\xb8\x68\x00\x00\x0c"),
        ("volume index scale -10000 (0x53225c)", f32(0x53225c) == -10000.0),
        ("pan index scale 10000 (0x532258)", f32(0x532258) == 10000.0),
        ("FX master default 1.0 (0x5417ec)", f32(0x5417ec) == 1.0),
        ("reverse-stereo word = 1 (0x5417f4)", struct.unpack_from("<i", exe, 0x1417f4)[0] == 1),
        ("units per metre 4096 (0x531498)", f64(0x531498) == 4096.0),
        ("pitch clamp 0.5 / 2.0", (f32(0x531508), f32(0x531588)) == (0.5, 2.0)),
        ("footstep sequence 0x53d2c8", struct.unpack_from("<12i", exe, 0x13d2c8) == FOOTSTEP_SEQUENCE),
        ("ambient fade 0.05/tick, delay x30 ticks", (f64(0x5318e0), f64(0x531488)) == (0.05, 30.0)),
        ("ambient box half size -4096 / 4096", (f64(0x5318b0), f64(0x531498)) == (-4096.0, 4096.0)),
        ("buffer flags 0x100e0, no CTRL3D (0x494468, 0x494c50)",
         exe[0x94468:0x94470] == b"\xc7\x44\x24\x60\xe0\x00\x01\x00"
         and exe[0x94c50:0x94c58] == b"\xc7\x44\x24\x2c\xe0\x00\x01\x00"),
        ("primary buffer 22050 Hz (0x49376a)", exe[0x9376a:0x93772] == b"\xc7\x44\x24\x18\x22\x56\x00\x00"),
        ("32 voices (0x493789)", exe[0x93789:0x93793] == b"\xc7\x05\x6c\x60\x5c\x00\x20\x00\x00\x00"),
        ("in-game tick 30 Hz (0x414c87 push 0x1e; call FUN_004029a0)",
         exe[0x14c87:0x14c89] == b"\x6a\x1e"),
    ]
    return checks


# ------------------------------------------------------------------ self-check
def self_check(game=GAME, wav_dir=None, as_json=False):
    ok = True
    report = {"files": [], "digests": {}, "formats": {}}
    archives = {}
    loaded = {}
    print("== ILSF inventory")
    for src, name, data in sound_files(game):
        h = decode_ilsf(data)
        st = stats(h["samples"], h["channels"])
        dig = pcm_digest(h["samples"])
        key = sample_key(name)
        loaded.setdefault(key, (src, name, h))   # first loaded wins (FUN_00494250)
        row = {"source": src, "name": name, "format": h["format"], "rate": h["sample_rate"],
               "channels": h["channels"], "frames": h["frames"],
               "duration": round(h["duration"], 4), "flags": h["flags"],
               "rms": round(st["rms"], 1), "peak": st["peak"], "clipped": st["clipped"],
               "sha256": dig}
        report["files"].append(row)
        fk = f"{h['format']}/{h['channels']}ch/{h['sample_rate']}"
        report["formats"][fk] = report["formats"].get(fk, 0) + 1
        if src.endswith(".res"):
            archives.setdefault(src, []).append((name, dig))
        else:
            report["digests"][f"{src}/{name}"] = dig
        # plausibility: real audio, no garbage
        if h["frames"] and (st["peak"] == 0 and h["frames"] > 50000):
            print(f"  WARN {name}: all-zero")
        if h["format"] in (2, 3):
            if h["payload_bytes"] != (h["frames"] // 2) * h["channels"] + 1:
                ok = False
                print(f"  FAIL {name}: ADPCM payload {h['payload_bytes']} != (frames//2)*ch+1")
            if h["flags"] != (0x1002 if h["format"] == 3 else 0):
                ok = False
                print(f"  FAIL {name}: flags {h['flags']:#x}")
            if st["clipped"] > 0.001 * len(h["samples"]) + 2:  # garbage saturates far more
                ok = False
                print(f"  FAIL {name}: {st['clipped']} clipped samples")
            if h["channels"] == 1:
                # wrong alternative: low nibble first must decode worse
                lim = min(h["frames"], 120000)
                good = stats(decode_ima(data[20:], 1, lim, True), 1)
                bad = stats(decode_ima(data[20:], 1, lim, False), 1)
                if not (bad["clipped"] > good["clipped"] or bad["rms"] > 1.5 * good["rms"]):
                    ok = False
                    print(f"  FAIL {name}: low-nibble-first decodes as well as high-first")
        elif h["flags"] != (0x1002 if h["format"] == 1 else 0):
            ok = False
            print(f"  FAIL {name}: flags {h['flags']:#x}")
        if wav_dir:
            os.makedirs(wav_dir, exist_ok=True)
            write_wav(os.path.join(wav_dir, sample_key(name).lower() + ".wav"), h)
    for src, members in archives.items():
        report["digests"][src] = archive_digest(members)
    by_src = {}
    for r in report["files"]:
        by_src.setdefault(r["source"], []).append(r)
    for src, rows in by_src.items():
        fm = {}
        for r in rows:
            fm[r["format"]] = fm.get(r["format"], 0) + 1
        dur = sum(r["duration"] for r in rows)
        print(f"  {src}: {len(rows)} files, formats {dict(sorted(fm.items()))}, {dur:.1f} s")
    print("  format/channels/rate:", dict(sorted(report["formats"].items())))
    if not as_json:
        print("  level / intro / menu files:")
        for r in report["files"]:
            if r["source"] != "common/sounds/sounds.res":
                print(f"    {r['name'][-34:]:34s} fmt {r['format']} {r['channels']}ch {r['rate']:5d} Hz "
                      f"{r['frames']:8d} fr {r['duration']:8.3f} s rms {r['rms']:7.1f} peak {r['peak']:5d}")

    print("== sound definitions")
    defs = []
    for rel, origin in (("common/sounds/sounds.qvm", "common"),
                        ("missions/location0/level1/sounds/sounds.qvm", "mission")):
        p = os.path.join(game, rel)
        if os.path.exists(p):
            d = read_sound_definitions(open(p, "rb").read(), origin)
            kinds = {}
            for r in d:
                kinds[r["kind"]] = kinds.get(r["kind"], 0) + 1
            print(f"  {rel}: {kinds}")
            defs += d
    missing = sorted({d["sample"] for d in defs if d["kind"] != "group" and d["sample"].upper() not in loaded})
    print(f"  {len(defs)} definitions, {len(missing)} reference samples that are not loaded: "
          f"{', '.join(missing[:12])}{' ...' if len(missing) > 12 else ''}")
    report["missing_samples"] = missing
    unused = sorted(k for k in loaded if k not in {d['sample'].upper() for d in defs if d['kind'] != 'group'})
    print(f"  {len(unused)} loaded samples no definition references (e.g. "
          f"{', '.join(u for u in unused if u.startswith('M01') or u.startswith('MENU'))})")
    expected = {"common": {"group": 26, "sound": 360, "graph": 10, "trigger-once": 7},
                "mission": {"group": 5, "sound": 24}}
    for origin, want in expected.items():
        got = {}
        for r in defs:
            if r["origin"] == origin:
                got[r["kind"]] = got.get(r["kind"], 0) + 1
        if defs and got != want:
            ok = False
            print(f"  FAIL {origin} definition counts {got} != {want}")

    print("== DirectSound volume / pan mapping")
    for v in (1.0, 0.5, 0.25, 0.1, 0.001, 0.0):
        print(f"  volume {v:5.3f} -> DSBVOLUME {dsb_volume(v):6d} -> gain {gain_from_db100(dsb_volume(v)):.4f}")
    # Chop-mode FISTP: the negative table values truncate toward 0 (-999.99999999992 -> -999).
    if (dsb_volume(1.0), dsb_volume(0.5), dsb_volume(0.25), dsb_volume(0.1), dsb_volume(0.0)) != (0, -999, -1999, -3321, -10000):
        ok = False
        print("  FAIL volume table")
    if (dsb_pan(0.0), dsb_pan(0.5), dsb_pan(-0.5), dsb_pan(1.0)) != (0, 999, -999, 10000):
        ok = False
        print("  FAIL pan table")
    # trunc(x*10) keeps i <= 9: a linear table reads back linearly up to x -> 1 (no read past values[10]).
    if any(abs(curve(list(range(11)), x) - 10 * x) > 1e-5 for x in (0.05, 0.25, 0.5, 0.95, 0.97, 0.999)):
        ok = False
        print("  FAIL graph curve")
    vp = voice_params(1.0, positional=True, source=(10 * 4096.0, 0, 0), min_distance=5, max_distance=65)
    print(f"  3D example: 10 m to the right, min 5 m, max 65 m -> volume {vp['volume']:.4f} "
          f"pan {vp['pan']:.4f} DSBVOLUME {vp['ds_volume']} DSBPAN {vp['ds_pan']}")

    exe_path = os.path.join(game, "igi.exe")
    if os.path.exists(exe_path):
        print("== igi.exe constants")
        for label, good in exe_checks(open(exe_path, "rb").read()):
            print(f"  {'ok  ' if good else 'FAIL'} {label}")
            ok &= bool(good)

    mat_path = os.path.join(game, "material/material.qvm")
    trig_path = os.path.join(game, "animtrigger/animtrigger.qvm")
    if os.path.exists(mat_path):
        mats = read_materials(open(mat_path, "rb").read())
        print(f"== materials ({len(mats)})")
        for m in mats[:20]:
            print(f"  {m['name']:12s} walk {m['walk'][0]:14s} land {m['land']:14s} impact {m['impact'][0]}")
    if os.path.exists(trig_path):
        trig = read_anim_triggers(open(trig_path, "rb").read())
        print(f"== anim sound triggers: {len(trig)} (ids {trig[0]['id']}..{trig[-1]['id']})")

    objects = os.path.join(game, "missions/location0/level1/objects.qvm")
    if os.path.exists(objects) and defs:
        print("== level 1 sound tasks (def -> volume, min..max m, loop, sample)")
        for row in level_sound_tasks(open(objects, "rb").read()):
            parts = []
            for name in row["defs"]:
                d = find_definition(defs, name)
                if d is None:
                    tag = "raw sample" if row.get("simple") else "MISSING DEF"
                    parts.append(f"{name} [{tag}]")
                elif d["kind"] == "group":
                    parts.append(f"{name} [group: {', '.join(d['members'])}]")
                else:
                    parts.append(f"{name} ({d['volume']:.2f}, {d['min_distance']:g}..{d['max_distance']:g}, "
                                 f"{'loop' if d['loop'] else 'once'}, {d['sample']})")
            extra = ""
            if row["type"] == "ConditionalSound":
                mode = "simple 2D" if row["simple"] else ("2D" if row["relative"] else "3D")
                extra = f" [{mode}{', one-shot' if row['one_shot'] else ''}] if {row['condition'][:60]}"
            elif row["type"] == "AmbientArea":
                extra = (f" box +-{row['size'][0]:g}x{row['size'][1]:g}x{row['size'][2]:g} m "
                         f"delay {row['min_delay']:g}+{row['random_wait']:g}*rand s")
            elif row["type"] == "StatusMessage":
                extra = f" [2D vol 1] if {row['condition'][:50]}"
            if not as_json:
                print(f"  {row['type']:16s} {str(row['name'])[:24]:24s} " + "; ".join(parts) + extra)

    if defs:
        # Names the exe or level data asks for that resolve to nothing: these
        # events are silent in the original (FUN_004dd750 returns 0).
        asked = set(EXE_SOUND_NAMES) | {f"{p}{i}" for p, first, n in SPEECH for i in range(first, first + n)}
        if os.path.exists(mat_path):
            for m in read_materials(open(mat_path, "rb").read()):
                asked.update(x for x in m["walk"] + [m["land"], m["rain"]] + m["impact"] if x)
        if os.path.exists(objects):
            for row in level_sound_tasks(open(objects, "rb").read()):
                if not row.get("simple"):
                    asked.update(row["defs"])
        level_loaded = {k for k, v in loaded.items() if not v[0].startswith("menusystem")}
        silent = []
        for n in sorted(asked):
            d = find_definition(defs, n)
            if d is None:
                silent.append(f"{n} (no definition)")
            elif d["kind"] != "group" and d["sample"].upper() not in level_loaded:
                silent.append(f"{n} (sample {d['sample']} not loaded)")
        print(f"== silent references in level 1 ({len(silent)}): " + ", ".join(silent))
        report["silent"] = silent

    print("== event table")
    for ev, what, how, where in EVENTS:
        print(f"  {ev:44s} | {what} | {how} | {where}")
    if as_json:
        print(json.dumps(report, indent=1))
    print("SELF-CHECK", "OK" if ok else "FAILED")
    return ok


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="IGI audio decoder and self-check")
    ap.add_argument("--game", default=GAME, help="game directory (default: ../Game Files)")
    ap.add_argument("--wav-dir", help="also write every decoded sample as a RIFF .wav here")
    ap.add_argument("--json", action="store_true", help="print the inventory and digests as JSON")
    ap.add_argument("--decode", help="decode one ILSF file and print its header")
    args = ap.parse_args()
    if args.decode:
        h = decode_ilsf(open(args.decode, "rb").read())
        st = stats(h["samples"], h["channels"])
        h.pop("samples")
        print(json.dumps({**h, **st, "duration": round(h["duration"], 4)}, indent=1))
        sys.exit(0)
    sys.exit(0 if self_check(args.game, args.wav_dir, args.json) else 1)
