/**
 * IGI audio: every ILSF sample variant, the sound-definition scripts and the
 * original software 3D mixer (volume / pan / pitch maths).
 *
 * Python reference with self-checks: tools/igi_audio.py. Evidence and the full
 * event table: docs/audio.md. Labels: observed (measured from data),
 * recovered (read from igi.exe code, VA given), inferred (assumption).
 *
 * ILSF layout (loader FUN_00494250; every field below is recovered unless noted):
 *   0  "ILSF" (u32 0x46534c49, compared at 0x494285)
 *   4  u16 format   0 = PCM16 streamed from disk   1 = PCM16 in memory
 *                   2 = IMA ADPCM streamed          3 = IMA ADPCM decoded at load
 *   6  u16 bits     16 (only value observed)
 *   8  u16 channels 1 | 2
 *   10 u16 flags    0x1002 for formats 1/3, 0 for 0/2 (observed; never read)
 *   12 u32 sample rate      16 u32 frame count      20 payload
 * PCM payload: frames * channels int16 LE, file = 20 + frames*channels*2
 *   exactly (observed on all 340 PCM files).
 * ADPCM payload (decoder FUN_00494560; index/step tables at 0x541800/0x541810
 *   are the standard IMA tables): no block headers, one nibble stream, HIGH
 *   nibble first, nibbles interleaved per frame over channels; each channel
 *   starts at predictor 0 / step index 0; predictor clamped to int16, index to
 *   0..88. Streamed files restart at offset 20 with a fresh state when looping
 *   (FUN_00494d70). Payload = (frames>>1)*channels + 1 bytes for all 37 ADPCM
 *   files (observed); ceil(frames*channels/2) bytes are consumed.
 */
import { isQvmCall, isQvmSymbol, readQvmCallTree } from "./qvm";
import type { QvmCall, QvmValue } from "./qvm";
import { x87Add, x87Div, x87Fistp, x87Mul, x87StoreF32, x87Sub } from "./x87";

// ------------------------------------------------------------------ ILSF

export type IlsfFormat = 0 | 1 | 2 | 3;

export const ILSF_FORMAT_NAMES: Readonly<Record<IlsfFormat, string>> = {
  0: "pcm16-stream",
  1: "pcm16",
  2: "ima-adpcm-stream",
  3: "ima-adpcm",
};

export interface IlsfHeader {
  format: IlsfFormat;
  /** True for formats 0 and 2 (the original streams them from disk in 2 s chunks). */
  streamed: boolean;
  /** True for formats 2 and 3 (IMA ADPCM). */
  compressed: boolean;
  bits: 16;
  channels: 1 | 2;
  /** Header word at +10 (observed 0x1002 / 0; not used by the original). */
  flags: number;
  sampleRate: number;
  frames: number;
  payloadBytes: number;
  /** frames / sampleRate in seconds. */
  duration: number;
}

export interface DecodedIlsfPcm extends IlsfHeader {
  /** Interleaved signed 16-bit samples (frames * channels). */
  pcm: Int16Array;
}

export interface DecodedAudio {
  format: IlsfFormat;
  sampleRate: number;
  channels: 1 | 2;
  frames: number;
  /** One Float32Array per channel, samples / 32768 (WebAudio AudioBuffer layout). */
  samples: Float32Array[];
}

const ILSF_HEADER = 20;

/** Standard IMA ADPCM index adjust table (igi.exe 0x541800, verified by tools/igi_audio.py). */
export const IMA_INDEX_TABLE: readonly number[] = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
/** Standard 89-entry IMA step table (igi.exe 0x541810). */
export const IMA_STEP_TABLE: readonly number[] = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80,
  88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598,
  658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289,
  16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
];

// (stepIndex * 16 + nibble) -> difference / next index, same arithmetic as FUN_00494560.
const IMA_DIFF = new Int32Array(89 * 16);
const IMA_NEXT = new Uint8Array(89 * 16);
for (let i = 0; i < 89; i++) {
  const step = IMA_STEP_TABLE[i];
  for (let n = 0; n < 16; n++) {
    let d = step >> 3;
    if (n & 4) d += step;
    if (n & 2) d += step >> 1;
    if (n & 1) d += step >> 2;
    IMA_DIFF[i * 16 + n] = n & 8 ? -d : d;
    IMA_NEXT[i * 16 + n] = Math.min(88, Math.max(0, i + IMA_INDEX_TABLE[n]));
  }
}

/** Validate and read the 20-byte ILSF header. Throws an Error naming the offset. */
export function readIlsfHeader(buffer: ArrayBuffer): IlsfHeader {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < ILSF_HEADER) {
    throw new Error(`ILSF: ${bytes.length}-byte file is shorter than the 20-byte header`);
  }
  if (bytes[0] !== 0x49 || bytes[1] !== 0x4c || bytes[2] !== 0x53 || bytes[3] !== 0x46) {
    throw new Error("ILSF: magic at 0x0 is not 'ILSF'");
  }
  const view = new DataView(buffer);
  const format = view.getUint16(4, true);
  const bits = view.getUint16(6, true);
  const channels = view.getUint16(8, true);
  const flags = view.getUint16(10, true);
  const sampleRate = view.getUint32(12, true);
  const frames = view.getUint32(16, true);
  if (format > 3) throw new Error(`ILSF: unknown format ${format} at 0x4`);
  if (bits !== 16) throw new Error(`ILSF: ${bits} bits per sample at 0x6 (only 16 observed)`);
  if (channels !== 1 && channels !== 2) throw new Error(`ILSF: ${channels} channels at 0x8`);
  if (sampleRate < 4000 || sampleRate > 96000) {
    throw new Error(`ILSF: implausible sample rate ${sampleRate} at 0xc`);
  }
  const payloadBytes = bytes.length - ILSF_HEADER;
  if (format === 0 || format === 1) {
    const need = frames * channels * 2;
    if (payloadBytes !== need) {
      throw new Error(`ILSF: PCM payload at 0x14 is ${payloadBytes} bytes, ${frames} frames need ${need}`);
    }
  } else {
    const need = Math.ceil((frames * channels) / 2);
    if (payloadBytes < need || payloadBytes > need + 1) {
      throw new Error(
        `ILSF: ADPCM payload at 0x14 is ${payloadBytes} bytes, ${frames} frames need ${need} (+1 pad)`,
      );
    }
  }
  return {
    format: format as IlsfFormat,
    streamed: format === 0 || format === 2,
    compressed: format >= 2,
    bits: 16,
    channels,
    flags,
    sampleRate,
    frames,
    payloadBytes,
    duration: frames / sampleRate,
  };
}

/**
 * Decode an ILSF IMA ADPCM nibble stream (FUN_00494560) to interleaved int16.
 * `highNibbleFirst = false` is the wrong alternative, kept for tests.
 */
export function decodeImaAdpcm(
  payload: Uint8Array,
  channels: number,
  frames: number,
  highNibbleFirst = true,
): Int16Array {
  const count = frames * channels;
  if (payload.length * 2 < count) {
    throw new Error(`ILSF: ADPCM payload of ${payload.length} bytes is short for ${frames} frames`);
  }
  const out = new Int16Array(count);
  const pred = new Int32Array(channels);
  const index = new Int32Array(channels);
  let c = 0;
  for (let k = 0; k < count; k++) {
    const b = payload[k >> 1];
    const nibble = ((k & 1) === 0) === highNibbleFirst ? b >> 4 : b & 15;
    const j = index[c] * 16 + nibble;
    let p = pred[c] + IMA_DIFF[j];
    if (p > 32767) p = 32767;
    else if (p < -32768) p = -32768;
    pred[c] = p;
    index[c] = IMA_NEXT[j];
    out[k] = p;
    if (++c === channels) c = 0;
  }
  return out;
}

/** Decode any ILSF variant to interleaved int16 PCM plus its header. */
export function decodeIlsfPcm16(buffer: ArrayBuffer): DecodedIlsfPcm {
  const header = readIlsfHeader(buffer);
  const count = header.frames * header.channels;
  let pcm: Int16Array;
  if (header.compressed) {
    pcm = decodeImaAdpcm(new Uint8Array(buffer, ILSF_HEADER), header.channels, header.frames);
  } else {
    pcm = new Int16Array(count);
    const view = new DataView(buffer, ILSF_HEADER);
    for (let i = 0; i < count; i++) pcm[i] = view.getInt16(i * 2, true);
  }
  return { ...header, pcm };
}

/** Decode any ILSF variant to per-channel float samples for WebAudio. */
export function decodeIlsfAny(buffer: ArrayBuffer): DecodedAudio {
  const d = decodeIlsfPcm16(buffer);
  const samples: Float32Array[] = [];
  for (let c = 0; c < d.channels; c++) {
    const ch = new Float32Array(d.frames);
    for (let f = 0, i = c; f < d.frames; f++, i += d.channels) ch[f] = d.pcm[i] / 32768;
    samples.push(ch);
  }
  return { format: d.format, sampleRate: d.sampleRate, channels: d.channels, frames: d.frames, samples };
}

/**
 * Sample registry key the original uses: the base name between the last
 * '/', '\\' or ':' and the first '.', upper-cased (FUN_00495600 + FUN_004956c0).
 * Definitions name samples by this key, case-insensitively ("MP5SD_LOOP").
 */
export function ilsfSampleKey(name: string): string {
  const base = name.split(/[/\\:]/).pop() ?? name;
  return base.split(".")[0].toUpperCase();
}

// ------------------------------------------------------------------ definitions

export type SoundDefinitionKind = "sound" | "graph" | "trigger-once";

/**
 * One DefineSound / DefineGraph / DefineTriggerOnce (handlers LAB_004df830,
 * LAB_004e18c0, LAB_004e0ab0). Distances are metres (x4096 IGI units).
 */
export interface SoundDefinition {
  kind: SoundDefinitionKind;
  /** "common" (common/sounds) or "mission" (MISSION:sounds); common loads first. */
  origin: string;
  /** Enclosing DefineGroup names joined by "/". */
  group: string;
  /** Lookup name (exact, case-sensitive match, first definition wins). */
  name: string;
  /** Sample key (case-insensitive ILSF base name). */
  sample: string;
  /** Offset from the parent object in IGI units (absolute when the parent has no transform). */
  offset: [number, number, number];
  /** Linear 0..1 volume (clamped to 0..1 by FUN_004df990). */
  volume: number;
  /** Full volume up to this distance (metres). */
  minDistance: number;
  /** Linear fade to silence at this distance; farther voices do not start (metres). */
  maxDistance: number;
  /** Index into the parent's float variables replacing the base volume, -1 = none. */
  volumeVar: number;
  /** Index into the parent's float variables replacing the base pitch, -1 = none. */
  pitchVar: number;
  /** Index into the parent's string variables replacing the sample, -1 = none. */
  sampleVar: number;
  /** DSBPLAY_LOOPING (bit 0x10). Graphs are driven continuously by their parent (inferred loop). */
  loop: boolean;
  /** Every definition starts positional (flag 2, FUN_004df190); 'relative to microphone' clears it. */
  positional: true;
  /** DefineGraph: 11-point volume curve over the parent variable 0..1. */
  volumeCurve?: number[];
  /** DefineGraph: 11-point pitch curve. */
  pitchCurve?: number[];
  /** DefineTriggerOnce: parent variable that triggers the one-shot. */
  triggerVar?: number;
  /** DefineTriggerOnce: trigger when the variable becomes 0 instead of non-zero. */
  triggerOnZero?: boolean;
}

/**
 * A DefineGroup. Groups are lookup targets too: FUN_004e21f0 matches the
 * group's own name before searching its children (depth-first pre-order), and
 * instantiating a group instantiates every child (e.g. "helicopter_1",
 * "truck_sounds" used by physicsobj/cars/truck/car.qvm).
 */
export interface SoundGroup {
  kind: "group";
  origin: string;
  /** Enclosing group path. */
  group: string;
  name: string;
  /** Names of the direct children in declaration order. */
  members: string[];
}

export type SoundEntry = SoundDefinition | SoundGroup;

function num(v: QvmValue, what: string): number {
  if (typeof v !== "number") throw new Error(`sounds.qvm: ${what} is not numeric`);
  return v;
}
function str(v: QvmValue, what: string): string {
  if (typeof v !== "string") throw new Error(`sounds.qvm: ${what} is not a string`);
  return v;
}
function bool(v: QvmValue, what: string): boolean {
  if (typeof v !== "boolean") throw new Error(`sounds.qvm: ${what} is not TRUE/FALSE`);
  return v;
}

/**
 * Decode a sounds.qvm (common or mission) into groups and definitions in
 * depth-first pre-order, the order the original searches them.
 */
export function readSoundDefinitions(qvmBuffer: ArrayBuffer, origin = "common"): SoundEntry[] {
  const out: SoundEntry[] = [];
  const walk = (call: QvmCall, path: string[]): void => {
    const a = call.args;
    const at = `${call.fn} at code 0x${call.codeOffset.toString(16)}`;
    if (call.fn === "DefineGroup") {
      const name = str(a[0], `${at} name`);
      const members: string[] = [];
      for (const child of a.slice(1)) {
        if (!isQvmCall(child)) throw new Error(`sounds.qvm: ${at} has a non-call child`);
        members.push(str(child.args[0], `${at} child name`));
      }
      out.push({ kind: "group", origin, group: path.join("/"), name, members });
      for (const child of a.slice(1)) walk(child as QvmCall, [...path, name]);
      return;
    }
    const want = call.fn === "DefineSound" ? 13 : call.fn === "DefineGraph" ? 33 : call.fn === "DefineTriggerOnce" ? 15 : -1;
    if (want < 0) throw new Error(`sounds.qvm: unknown call ${call.fn} at code 0x${call.codeOffset.toString(16)}`);
    if (a.length !== want) throw new Error(`sounds.qvm: ${at} has ${a.length} arguments (${want} expected)`);
    const base = {
      origin,
      group: path.join("/"),
      name: str(a[0], `${at} name`),
      sample: str(a[1], `${at} sample`),
      offset: [num(a[2], `${at} x`), num(a[3], `${at} y`), num(a[4], `${at} z`)] as [number, number, number],
      volume: num(a[5], `${at} volume`),
      minDistance: num(a[6], `${at} min distance`),
      maxDistance: num(a[7], `${at} max distance`),
      positional: true as const,
    };
    if (call.fn === "DefineSound") {
      out.push({
        ...base,
        kind: "sound",
        volumeVar: num(a[8], `${at} volume var`),
        pitchVar: num(a[9], `${at} pitch var`),
        sampleVar: num(a[10], `${at} sample var`),
        loop: bool(a[12], `${at} loop`),
      });
    } else if (call.fn === "DefineGraph") {
      out.push({
        ...base,
        kind: "graph",
        volumeVar: num(a[8], `${at} volume var`),
        pitchVar: num(a[9], `${at} pitch var`),
        sampleVar: num(a[10], `${at} sample var`),
        loop: true,
        volumeCurve: a.slice(11, 22).map((v, i) => num(v, `${at} volume curve ${i}`)),
        pitchCurve: a.slice(22, 33).map((v, i) => num(v, `${at} pitch curve ${i}`)),
      });
    } else {
      out.push({
        ...base,
        kind: "trigger-once",
        triggerVar: num(a[9], `${at} trigger var`),
        volumeVar: num(a[10], `${at} volume var`),
        pitchVar: num(a[11], `${at} pitch var`),
        sampleVar: num(a[12], `${at} sample var`),
        loop: bool(a[13], `${at} loop`),
        triggerOnZero: bool(a[14], `${at} trigger on zero`),
      });
    }
  };
  for (const statement of readQvmCallTree(qvmBuffer)) walk(statement, []);
  return out;
}

/**
 * First group or definition with exactly this name (FUN_004df650 / FUN_004e21f0
 * byte compare, depth-first pre-order; pass common entries before mission ones).
 */
export function findSoundDefinition(defs: readonly SoundEntry[], name: string): SoundEntry | undefined {
  return defs.find((d) => d.name === name);
}

/** Type guard for playable (non-group) entries. */
export function isSoundDefinition(entry: SoundEntry | undefined): entry is SoundDefinition {
  return entry !== undefined && entry.kind !== "group";
}

/** Per-material sounds from material/material.qvm DefineGameMaterial (handler FUN_00408060). */
export interface MaterialSounds {
  name: string;
  /** Footstep noise radius for AI hearing, metres (arg 5; used x4096 in FUN_00462560). */
  noiseRadius: number;
  /** Six footstep definitions, picked by FOOTSTEP_SEQUENCE. */
  walk: string[];
  land: string;
  rain: string;
  /** Six bullet-impact definitions, picked uniformly at random. */
  impact: string[];
}

export function readMaterialSounds(materialQvm: ArrayBuffer): MaterialSounds[] {
  const out: MaterialSounds[] = [];
  for (const s of readQvmCallTree(materialQvm)) {
    if (s.fn !== "DefineGameMaterial") continue;
    const a = s.args;
    const at = `DefineGameMaterial at code 0x${s.codeOffset.toString(16)}`;
    if (a.length < 20) throw new Error(`material.qvm: ${at} has ${a.length} arguments`);
    out.push({
      name: str(a[0], `${at} name`),
      noiseRadius: num(a[5], `${at} noise radius`),
      walk: a.slice(6, 12).map((v, i) => str(v, `${at} walk ${i}`)),
      land: str(a[12], `${at} land`),
      rain: str(a[13], `${at} rain`),
      impact: a.slice(14, 20).map((v, i) => str(v, `${at} impact ${i}`)),
    });
  }
  return out;
}

/** animtrigger/animtrigger.qvm DefineAnimTrigger(id, TASKTYPE_ANIMSOUND, def, attach). */
export interface AnimSoundTrigger {
  id: number;
  sound: string;
  /** true: the sound is a child of the animated owner (follows it); false: placed at the trigger point (FUN_005152c0). */
  attach: boolean;
}

export function readAnimSoundTriggers(animTriggerQvm: ArrayBuffer): AnimSoundTrigger[] {
  const out: AnimSoundTrigger[] = [];
  for (const s of readQvmCallTree(animTriggerQvm)) {
    if (s.fn !== "DefineAnimTrigger") continue;
    const a = s.args;
    const at = `DefineAnimTrigger at code 0x${s.codeOffset.toString(16)}`;
    if (a.length !== 4 || !isQvmSymbol(a[1]) || a[1].symbol !== "TASKTYPE_ANIMSOUND") {
      throw new Error(`animtrigger.qvm: unexpected ${at}`);
    }
    out.push({ id: num(a[0], `${at} id`), sound: str(a[2], `${at} sound`), attach: bool(a[3], `${at} attach`) });
  }
  return out;
}

// ------------------------------------------------------------------ mixer

/** Recovered constants (VA in igi.exe; see docs/audio.md). */
export const IGI_AUDIO = {
  /** IGI units per metre for min/max distances (0x531498). */
  unitsPerMetre: 4096,
  /** Volume / pan quantisation steps (table 0x6201b8, FUN_004935d0). */
  volumeSteps: 10000,
  /** DSBVOLUME_MIN, also table[0]. */
  silence: -10000,
  /** Pitch multiplier clamp before SetFrequency (0x531508 / 0x531588). */
  pitchMin: 0.5,
  pitchMax: 2.0,
  /** Primary buffer format (FUN_004935d0): 22050 Hz, 16-bit, stereo when the card supports it. */
  outputSampleRate: 22050,
  /** Simultaneous voices (DAT_005c606c = 32); a 33rd request is dropped (FUN_004dda00). */
  maxVoices: 32,
  /** In-game tick rate (FUN_004029a0(30) at 0x414c89; menus run at 60). */
  tickHz: 30,
  /** Streaming buffer length for formats 0/2 (FUN_00494b40). */
  streamBufferSeconds: 2,
  /** AmbientArea fade step per tick (0x5318e0) and delay scale (0x531488 = 30 ticks/s). */
  ambientFadePerTick: 0.05,
  /** Speech slot cooldown 30..59 ticks (FUN_00462400 0x46245a: 30 - fistp(rand * -30.0f), truncated; rand <= 65535/65536). */
  speechCooldownTicks: [30, 59] as const,
  /** AI "detected" sting global cooldown (> 90 ticks, FUN_00488d40). */
  detectedCooldownTicks: 90,
  /** Bullet-impact and ricochet limiter 6 + rand(6) ticks (FUN_00479e30 / FUN_0047aa10). */
  impactLimiterTicks: [6, 11] as const,
  /** gunshotmiss spacing (0x45f42c: now + 5). */
  nearMissTicks: 5,
  /** Footstep pitch = 0.8 + 0.5 * rand (FUN_00462560: rand*0.5 + 1 - 0.2). */
  footstepPitch: [0.8, 1.3] as const,
  /** Footstep volume multiplier when the walker's flag +0x33d is set (0x3f28f5c3). */
  footstepQuietVolume: 0.66,
} as const;

/** Walk-sound index sequence (0x53d2c8), cycled per footstep: walk[seq[k % 12]]. */
export const FOOTSTEP_SEQUENCE: readonly number[] = [0, 1, 2, 3, 4, 5, 3, 1, 4, 2, 3, 5];
/** AI-detects-player stings (table 0x53f574), picked with rand(6). */
export const DETECTED_SOUNDS: readonly string[] = [
  "detected_01", "detected_02", "detected_03", "detected_04", "detected_05", "detected_06",
];

/**
 * The game's float -> int conversion (x87 FISTP). igi.exe runs the FPU in
 * chop mode (FUN_004966d0; docs/gameplay.md "FPU rounding mode"), so despite
 * its historical name this TRUNCATES toward zero (2.5 -> 2, -2.7 -> -2).
 * @deprecated use x87Fistp (x87.ts)
 */
export function roundHalfEven(x: number): number {
  return x87Fistp(x);
}

/** 0x532248: the double the table loop multiplies by (1000/ln 2 written with a short ln 2; true value 1442.6950408889634). */
const DS_TABLE_SCALE = 1442.6950408888495;

/**
 * DirectSound attenuation table 0x6201b8[k], k = 0..10000 (built in FUN_004935d0,
 * 0x493605..0x49361b: fild k; fmul 1e-4; fldln2; fyl2x; fmul 1442.695...; fistp):
 * T[0] = -10000; T[k] = clamp(trunc(ln(k * 1e-4) * 1442.6950408888495), -10000, 0),
 * i.e. about 1000*log2(k/10000) hundredths of a dB (10 dB per halving), truncated
 * toward zero (chop mode): T[5000] = -999, T[1000] = -3321, T[100] = -6643;
 * 5053 of the 10000 entries are 1 above the rounded value.
 */
export function dsVolumeTable(k: number): number {
  if (k <= 0) return IGI_AUDIO.silence;
  const v = x87Fistp(x87Mul(Math.log(x87Mul(k, 1e-4)), DS_TABLE_SCALE));
  return Math.max(IGI_AUDIO.silence, Math.min(0, v)) + 0;
}

/**
 * SetVolume argument for a linear 0..1 voice volume (FUN_004950f0 0x4952f6:
 * T[-fistp(fx * v * -10000.0f)] = T[trunc(fx * v * 10000)]). fxVolume =
 * GOSoundFX volume (0x5417ec).
 */
export function dsVolume(volume: number, fxVolume = 1): number {
  const k = x87Fistp(x87Mul(x87Mul(fxVolume, volume), IGI_AUDIO.volumeSteps));
  return dsVolumeTable(Math.max(0, Math.min(IGI_AUDIO.volumeSteps, k)));
}

/**
 * SetPan argument for pan in [-1, 1] (positive = right): -sign(pan) * T[trunc((1-|pan|)*10000)]
 * (0x495335 / 0x495352: (pan + 1) or (1 - pan) times 10000.0f, fistp, chop mode).
 * The minus comes from the constant 'reverse stereo' word 0x5417f4 = 1 (never written).
 */
export function dsPan(pan: number): number {
  if (pan >= 0) return 0 - dsVolumeTable(x87Fistp(x87Mul(x87Sub(1, pan), IGI_AUDIO.volumeSteps))) + 0;
  return dsVolumeTable(x87Fistp(x87Mul(x87Add(pan, 1), IGI_AUDIO.volumeSteps)));
}

/** Linear gain for a DirectSound hundredths-of-dB value (WebAudio GainNode). */
export function gainFromDsUnits(db100: number): number {
  return Math.pow(10, db100 / 2000);
}

export interface VoiceInput {
  /** Definition volume x runtime multipliers, linear 0..1. */
  volume: number;
  /** Pitch multiplier (definition 1.0 unless set by the caller). */
  pitch?: number;
  sampleRate: number;
  /** false = 2D (relative to microphone / raw sample / menu). */
  positional: boolean;
  /** Source and listener positions in IGI units. */
  source?: readonly [number, number, number];
  listener?: readonly [number, number, number];
  /** Unit vector of the listener's right axis (microphone matrix column 0; inferred meaning). */
  listenerRight?: readonly [number, number, number];
  minDistance?: number;
  maxDistance?: number;
  /** GOSoundFX volume (config.qvm, 1.0 by default). */
  fxVolume?: number;
}

export interface VoiceState {
  /** Volume after distance attenuation, 0..1. */
  volume: number;
  /** -1 (left) .. 1 (right). */
  pan: number;
  dsVolume: number;
  dsPan: number;
  /** SetFrequency argument (Hz). */
  frequency: number;
  /** WebAudio equivalents of DirectSound volume + pan (pan attenuates one side only). */
  gainLeft: number;
  gainRight: number;
  /** frequency / sampleRate for AudioBufferSourceNode.playbackRate. */
  playbackRate: number;
}

/**
 * The original per-voice update (FUN_004950f0), executed every tick:
 *   d = |source - listener|; d > max: silent; min <= d <= max: v *= 1 - (d-min)/(max-min)
 *   pan = clamp((rel . right) / (min + max), -1, 1)   (0 when d == 0 or 2D)
 *   frequency = trunc(rate * clamp(pitch, 0.5, 2))   (0x4953d4: fild rate; fmul; fistp)
 */
export function computeVoice(input: VoiceInput): VoiceState {
  let v = Math.min(1, Math.max(0, input.volume));
  let pan = 0;
  if (input.positional) {
    const lo = (input.minDistance ?? 0) * IGI_AUDIO.unitsPerMetre;
    const hi = (input.maxDistance ?? 1) * IGI_AUDIO.unitsPerMetre;
    const s = input.source ?? [0, 0, 0];
    const l = input.listener ?? [0, 0, 0];
    const r = input.listenerRight ?? [1, 0, 0];
    const rel = [s[0] - l[0], s[1] - l[1], s[2] - l[2]];
    const dist = Math.hypot(rel[0], rel[1], rel[2]);
    if (dist > hi) v = 0;
    else if (dist >= lo) v = Math.min(1, Math.max(0, (1 - (dist - lo) / (hi - lo)) * v));
    if (dist > 0) {
      const x = rel[0] * r[0] + rel[1] * r[1] + rel[2] * r[2];
      pan = Math.min(1, Math.max(-1, x / (hi + lo)));
    }
  }
  const pitch = Math.min(IGI_AUDIO.pitchMax, Math.max(IGI_AUDIO.pitchMin, input.pitch ?? 1));
  const vol = dsVolume(v, input.fxVolume ?? 1);
  const p = dsPan(pan);
  const frequency = x87Fistp(x87Mul(input.sampleRate, pitch));
  return {
    volume: v,
    pan,
    dsVolume: vol,
    dsPan: p,
    frequency,
    gainLeft: gainFromDsUnits(vol + Math.min(0, -p)),
    gainRight: gainFromDsUnits(vol + Math.min(0, p)),
    playbackRate: frequency / input.sampleRate,
  };
}

/**
 * DefineGraph 11-point curve lookup (FUN_004ddbf0): x >= 1 -> values[10],
 * x <= 0 -> values[0]; otherwise i = trunc(x * 10.0f) (fistp at 0x4ddc47,
 * chop mode), so i <= 9 and the curve is plain piecewise-linear between
 * grid points x0 = float32(i * 0.1f) and x1 = float32((i+1) * 0.1f) (both
 * stored truncated); an exact grid hit returns the table value. The result
 * ((y1-y0)/(x1-x0)*(x-x0) + y0) is stored as float32. values[11] (any float
 * after the table) is never read; extra entries are ignored.
 */
export function graphCurve(values: readonly number[], x: number): number {
  if (x >= 1) return values[10];
  if (x <= 0) return values[0];
  const i = x87Fistp(x87Mul(x, 10));
  const step = Math.fround(0.1); // 0x5313c8
  const x0 = x87StoreF32(i * step);
  const x1 = x87StoreF32((i + 1) * step);
  const y0 = values[i];
  const y1 = values[i + 1];
  if (x0 === x) return y0;
  if (x1 === x) return y1;
  return x87StoreF32(x87Add(x87Mul(x87Div(x87Sub(y1, y0), x87Sub(x1, x0)), x87Sub(x, x0)), y0));
}

/**
 * AmbientArea variant pick (FUN_0044b1b0 0x44b3c5: rand; fimul count; fistp):
 * index = trunc(rand01 * count), chop mode. The game's rand01 is k / 65536 < 1,
 * so every name is equally likely and the index never reaches count.
 */
export function ambientPick(rand01: number, count: number): number {
  return x87Fistp(rand01 * count);
}
