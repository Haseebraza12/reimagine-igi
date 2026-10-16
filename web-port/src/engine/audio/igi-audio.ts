/**
 * IGI audio data for one mission: every sample, sound definition, material
 * sound set and animation sound trigger igi.exe loads, keyed the way igi.exe
 * keys them (docs/audio.md §1-2).
 *
 * Recovered rules implemented here:
 * - Sample key = base name between the last '/', '\\' or ':' and the first
 *   '.', upper-cased (FUN_00495600 / FUN_004956c0). A key that is already
 *   loaded rejects the later file ("SOUND - File %s already loaded!").
 * - Load order at level start: LOCAL:common/sounds (sounds.res), then
 *   MISSION:sounds (loose *.wav) (FUN_00414e77). The menu archive is a
 *   separate set that the original loads with the menus (0x416c96).
 * - common/sounds/sounds.qvm definitions come before the mission's
 *   (0x414f31); lookups take the first exact, case-sensitive name match.
 *
 * Port choices (not recovered behaviour):
 * - HTTP has no directory listing, so the mission sound directory is read from
 *   an explicit file list (the observed level-1 inventory) plus every sample
 *   key the mission's definitions name.
 * - ILSF decoding (IMA ADPCM + PCM, loaders/audio.ts) runs in a module worker
 *   when the browser has one; otherwise inline with event-loop yields.
 */
import type { IAssetSource } from "../../contracts";
import {
  decodeIlsfAny,
  ilsfSampleKey,
  isQvmCall,
  readAnimSoundTriggers,
  readIlffMembers,
  readIlsfHeader,
  readMaterialSounds,
  readQvmCallTree,
  readSoundDefinitions,
  type AnimSoundTrigger,
  type DecodedAudio,
  type IlsfFormat,
  type MaterialSounds,
  type SoundDefinition,
  type SoundEntry,
  type SoundGroup,
} from "../../loaders";

// ---------------------------------------------------------------- paths

export interface IgiAudioPaths {
  /** LOCAL:common/sounds archive (loads first). */
  commonSounds: string;
  commonDefinitions: string;
  /** MISSION:sounds directory (trailing slash). */
  missionSoundDir: string;
  /** Loose files of the mission sound directory (HTTP has no listing). */
  missionSoundFiles: readonly string[];
  missionDefinitions: string;
  /** Menu archive (loaded with the menus; optional). */
  menuSounds: string | null;
  materials: string | null;
  animTriggers: string | null;
  /** GOSoundFX / GOSoundMusic / GOSoundSpeech volumes. */
  config: string | null;
}

/** The loose .wav files of level 1's MISSION:sounds directory (the observed inventory, docs/audio.md §1). */
export const LEVEL1_SOUND_FILES: readonly string[] = [
    "_cut01_01.wav",
    "m01_ing_01.wav",
    "m01_ing_02.wav",
    "m01_ing_03.wav",
    "m01_ing_04.wav",
    "m01_ing_05.wav",
    "m1_ambience.wav",
    "m1_beeps01.wav",
    "m1_heliaway01.wav",
    "m1_heliblad01.wav",
    "m1_heliblad02.wav",
    "m1_heliby01.wav",
    "m1_heliby02.wav",
    "m1_heligen01.wav",
    "m1_heliinside01.wav",
    "m1_music.wav",
    "m1o_baseamb.wav",
    "m1_office01.wav",
    "m1_office02.wav",
    "m1_office03.wav",
    "m1o_hammer.wav",
    "m1o_train1.wav",
    "m1o_train2.wav",
    "m1o_truck.wav",
    "m1o_wind.wav",
    "m1_trainby01.wav",
    "m1_trainext01.wav",
    "m1_type01.wav",
    "machinery_01.wav",
  ];

/**
 * A mission's audio files: the shared archives plus its MISSION:sounds directory. `soundFiles` is
 * that directory's listing (igi.exe loads every file there; HTTP has no listing, so the staging
 * manifest supplies it); without it only the files the mission's definitions name are read.
 */
export function audioPathsFor(levelDir: string, soundFiles: readonly string[] = []): IgiAudioPaths {
  const L = levelDir.replace(/\/+$/, "");
  return {
    commonSounds: "common/sounds/sounds.res",
    commonDefinitions: "common/sounds/sounds.qvm",
    missionSoundDir: `${L}/sounds/`,
    missionSoundFiles: soundFiles,
    missionDefinitions: `${L}/sounds/sounds.qvm`,
    menuSounds: "menusystem/SOUND/sounds.res",
    materials: "material/material.qvm",
    animTriggers: "animtrigger/animtrigger.qvm",
    config: "config.qvm",
  };
}

/** Level-1 (Trainyard) audio files. */
export const LEVEL1_AUDIO_PATHS: IgiAudioPaths = audioPathsFor("missions/location0/level1", LEVEL1_SOUND_FILES);

// ---------------------------------------------------------------- samples

export type SampleOrigin = "common" | "mission" | "menu";

/** One decoded ILSF sample in the registry. */
export interface IgiSample {
  /** Registry key (upper-case base name). */
  key: string;
  /** Archive member or file it came from. */
  path: string;
  origin: SampleOrigin;
  format: IlsfFormat;
  /** Formats 0/2: streamed from disk by the original (restart from 0 when re-started). */
  streamed: boolean;
  sampleRate: number;
  channels: 1 | 2;
  frames: number;
  /** frames / sampleRate (seconds). */
  duration: number;
  /** One Float32Array per channel (samples / 32768). */
  data: Float32Array[];
  /**
   * WebAudio buffer holding the same samples (browser only). When present,
   * `data` are views of its channel storage, so nothing is stored twice and
   * the first play needs no copy.
   */
  audioBuffer?: AudioBuffer;
}

/** Move a sample into a context-independent AudioBuffer (no-op outside browsers). */
export function attachAudioBuffer(sample: IgiSample): IgiSample {
  if (sample.audioBuffer || sample.frames === 0 || typeof AudioBuffer === "undefined") return sample;
  try {
    const buffer = new AudioBuffer({ numberOfChannels: sample.channels, length: sample.frames, sampleRate: sample.sampleRate });
    for (let c = 0; c < sample.channels; c++) buffer.getChannelData(c).set(sample.data[c].subarray(0, sample.frames));
    sample.audioBuffer = buffer;
    sample.data = Array.from({ length: sample.channels }, (_, c) => buffer.getChannelData(c));
  } catch {
    /* keep the Float32 data; the backend copies on first play */
  }
  return sample;
}

/** Samples by key; the first file with a key wins (FUN_004956c0 + "already loaded"). */
export class SampleRegistry {
  private readonly byKey = new Map<string, IgiSample>();
  /** Files rejected because their key was already loaded. */
  readonly rejected: string[] = [];

  /** Add a sample; false (and recorded in `rejected`) when its key is taken. */
  add(sample: IgiSample): boolean {
    if (this.byKey.has(sample.key)) {
      this.rejected.push(sample.path);
      return false;
    }
    this.byKey.set(sample.key, sample);
    return true;
  }

  has(nameOrKey: string): boolean {
    return this.byKey.has(ilsfSampleKey(nameOrKey));
  }

  /** Look a sample up by key or any file name ("MP5SD_LOOP", "mp5sd_loop.wav", "LOCAL:x/y.wav"). */
  get(nameOrKey: string): IgiSample | undefined {
    if (!nameOrKey) return undefined;
    return this.byKey.get(ilsfSampleKey(nameOrKey));
  }

  get size(): number {
    return this.byKey.size;
  }

  keys(): IterableIterator<string> {
    return this.byKey.keys();
  }

  values(): IterableIterator<IgiSample> {
    return this.byKey.values();
  }
}

/** Build an IgiSample from a decoded ILSF file. */
export function sampleFromDecoded(key: string, path: string, origin: SampleOrigin, d: DecodedAudio): IgiSample {
  return {
    key,
    path,
    origin,
    format: d.format,
    streamed: d.format === 0 || d.format === 2,
    sampleRate: d.sampleRate,
    channels: d.channels,
    frames: d.frames,
    duration: d.frames / d.sampleRate,
    data: d.samples,
  };
}

// ---------------------------------------------------------------- definitions

/**
 * Sound definitions (common first, then mission) with the original lookup:
 * first exact, case-sensitive name match over groups and definitions in
 * depth-first pre-order (FUN_004dd750 -> FUN_004df650 / FUN_004e21f0).
 */
export class SoundBank {
  private readonly byName = new Map<string, SoundEntry>();
  private readonly childrenOf = new Map<SoundGroup, SoundEntry[]>();

  constructor(readonly entries: readonly SoundEntry[]) {
    const path = (e: SoundEntry) => `${e.origin}\u0000${e.group ? `${e.group}/${e.name}` : e.name}`;
    const groups = new Map<string, SoundGroup>();
    for (const e of entries) {
      if (!this.byName.has(e.name)) this.byName.set(e.name, e);
      if (e.kind === "group" && !groups.has(path(e))) {
        groups.set(path(e), e);
        this.childrenOf.set(e, []);
      }
    }
    for (const e of entries) {
      if (!e.group) continue;
      const parent = groups.get(`${e.origin}\u0000${e.group}`);
      if (parent) this.childrenOf.get(parent)!.push(e);
    }
  }

  /** First group or definition with exactly this name. */
  find(name: string): SoundEntry | undefined {
    if (!name) return undefined;
    return this.byName.get(name);
  }

  /** The DefineSound named `name`, as the 2D-by-name path accepts it (FUN_004dddc0 skips groups, graphs and triggers). */
  findSound(name: string): SoundDefinition | undefined {
    const e = this.find(name);
    return e && e.kind === "sound" ? e : undefined;
  }

  /** Every playable definition an instance of `entry` creates (a group creates all its descendants). */
  instantiate(entry: SoundEntry): SoundDefinition[] {
    if (entry.kind !== "group") return [entry];
    const out: SoundDefinition[] = [];
    for (const child of this.childrenOf.get(entry) ?? []) out.push(...this.instantiate(child));
    return out;
  }
}

// ---------------------------------------------------------------- config

/** GOSoundFX / GOSoundMusic / GOSoundSpeech volumes from config.qvm (all 1.0 in the shipped file). */
export interface AudioVolumes {
  /** Scales every DirectSound voice (0x5417ec). */
  fx: number;
  /** Drives the Windows mixer (FUN_00494150); not part of the DirectSound mix. */
  music: number;
  /** Read but no consumer traced. */
  speech: number;
}

export const DEFAULT_AUDIO_VOLUMES: AudioVolumes = { fx: 1, music: 1, speech: 1 };

/**
 * Read the three sound volume calls. Each is `GOSoundX(a, b)` (shipped: 1, 1);
 * the second argument is read as the volume and a first argument of 0 as
 * "off" (argument meaning inferred; the shipped values make it moot).
 */
export function readAudioVolumes(configQvm: ArrayBuffer): AudioVolumes {
  const out = { ...DEFAULT_AUDIO_VOLUMES };
  const pick = (args: unknown[]): number | null => {
    const nums = args.filter((a): a is number => typeof a === "number");
    if (nums.length === 0) return null;
    const volume = nums[nums.length - 1];
    const enabled = nums.length > 1 ? nums[0] !== 0 : true;
    return enabled ? Math.min(1, Math.max(0, volume)) : 0;
  };
  const visit = (calls: ReturnType<typeof readQvmCallTree>) => {
    for (const c of calls) {
      const v = c.fn === "GOSoundFX" || c.fn === "GOSoundMusic" || c.fn === "GOSoundSpeech" ? pick(c.args) : null;
      if (v !== null) {
        if (c.fn === "GOSoundFX") out.fx = v;
        else if (c.fn === "GOSoundMusic") out.music = v;
        else out.speech = v;
      }
      visit(c.args.filter(isQvmCall));
    }
  };
  visit(readQvmCallTree(configQvm));
  return out;
}

// ---------------------------------------------------------------- loaded data

export interface AudioLoadStats {
  files: number;
  /** Bytes of ILSF data decoded. */
  bytes: number;
  /** Total samples (frames x channels) decoded. */
  samples: number;
  fetchMs: number;
  decodeMs: number;
  /** Longest single main-thread decode block (0 with the worker). */
  maxBlockMs: number;
  decoder: "worker" | "inline";
}

export interface IgiAudioData {
  /** Level registry: common then mission, first key wins. */
  samples: SampleRegistry;
  /** Menu archive samples (separate set; empty when not loaded). */
  menuSamples: SampleRegistry;
  bank: SoundBank;
  /** material.qvm DefineGameMaterial sounds by material name. */
  materials: Map<string, MaterialSounds>;
  /** animtrigger.qvm DefineAnimTrigger by id. */
  animTriggers: Map<number, AnimSoundTrigger>;
  volumes: AudioVolumes;
  warnings: string[];
  stats: AudioLoadStats;
}

/** Assemble IgiAudioData from already-decoded parts (tests, harness). */
export function createAudioData(parts: {
  samples?: SampleRegistry;
  menuSamples?: SampleRegistry;
  definitions?: readonly SoundEntry[];
  materials?: readonly MaterialSounds[];
  animTriggers?: readonly AnimSoundTrigger[];
  volumes?: AudioVolumes;
}): IgiAudioData {
  const animTriggers = new Map<number, AnimSoundTrigger>();
  for (const t of parts.animTriggers ?? []) if (!animTriggers.has(t.id)) animTriggers.set(t.id, t);
  const materials = new Map<string, MaterialSounds>();
  for (const m of parts.materials ?? []) if (!materials.has(m.name)) materials.set(m.name, m);
  return {
    samples: parts.samples ?? new SampleRegistry(),
    menuSamples: parts.menuSamples ?? new SampleRegistry(),
    bank: new SoundBank(parts.definitions ?? []),
    materials,
    animTriggers,
    volumes: parts.volumes ?? { ...DEFAULT_AUDIO_VOLUMES },
    warnings: [],
    stats: { files: 0, bytes: 0, samples: 0, fetchMs: 0, decodeMs: 0, maxBlockMs: 0, decoder: "inline" },
  };
}

// ---------------------------------------------------------------- decoders

/** Decodes ILSF buffers; the buffer may be transferred (detached) by the call. */
export interface SampleDecoder {
  readonly kind: "worker" | "inline";
  decode(buffer: ArrayBuffer): Promise<DecodedAudio>;
  /** Longest synchronous main-thread block so far (ms). */
  readonly maxBlockMs: number;
  dispose(): void;
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Main-thread decoder. Calls are serialized and the decoder yields to the
 * event loop after ~12 ms of work, so the page keeps rendering progress.
 */
export function createInlineDecoder(): SampleDecoder {
  let sinceYield = 0;
  let maxBlock = 0;
  let chain: Promise<unknown> = Promise.resolve();
  return {
    kind: "inline",
    decode(buffer: ArrayBuffer): Promise<DecodedAudio> {
      const run = async (): Promise<DecodedAudio> => {
        if (sinceYield > 12) {
          await yieldToEventLoop();
          sinceYield = 0;
        }
        const t0 = now();
        const d = decodeIlsfAny(buffer);
        const dt = now() - t0;
        sinceYield += dt;
        if (dt > maxBlock) maxBlock = dt;
        return d;
      };
      const p = chain.then(run);
      chain = p.catch(() => {});
      return p;
    },
    get maxBlockMs() {
      return maxBlock;
    },
    dispose() {},
  };
}

interface WorkerReply {
  id: number;
  ok: boolean;
  error?: string;
  format?: IlsfFormat;
  sampleRate?: number;
  channels?: 1 | 2;
  frames?: number;
  samples?: Float32Array[];
}

/**
 * Module-worker decoder (decode-worker.ts). Resolves null when workers are
 * unavailable or the worker does not answer a ping within `timeoutMs`.
 */
export async function createWorkerDecoder(timeoutMs = 4000): Promise<SampleDecoder | null> {
  if (typeof Worker === "undefined") return null;
  let worker: Worker;
  try {
    worker = new Worker(new URL("./decode-worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
  const pending = new Map<number, { resolve: (d: DecodedAudio) => void; reject: (e: Error) => void }>();
  let seq = 0;
  let failed: Error | null = null;
  let pong: (() => void) | null = null;
  worker.onmessage = (event: MessageEvent<WorkerReply | { pong: true }>) => {
    const msg = event.data;
    if ("pong" in msg) {
      pong?.();
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (!msg.ok) p.reject(new Error(msg.error ?? "decode failed"));
    else p.resolve({ format: msg.format!, sampleRate: msg.sampleRate!, channels: msg.channels!, frames: msg.frames!, samples: msg.samples! });
  };
  worker.onerror = (event) => {
    failed = new Error(`audio decode worker failed: ${event.message || "load error"}`);
    for (const p of pending.values()) p.reject(failed);
    pending.clear();
    pong = null;
  };
  const alive = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    pong = () => {
      clearTimeout(timer);
      resolve(true);
    };
    worker.postMessage({ ping: true });
  });
  pong = null;
  if (!alive || failed) {
    worker.terminate();
    return null;
  }
  return {
    kind: "worker",
    decode(buffer: ArrayBuffer): Promise<DecodedAudio> {
      if (failed) return Promise.reject(failed);
      const id = ++seq;
      return new Promise<DecodedAudio>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, buffer }, [buffer]);
      });
    },
    maxBlockMs: 0,
    dispose() {
      worker.terminate();
    },
  };
}

// ---------------------------------------------------------------- loader

export interface LoadIgiAudioOptions {
  paths?: IgiAudioPaths;
  /** fraction 0..1 and a short status line. */
  onProgress?: (fraction: number, text: string) => void;
  /** "auto" (default): worker when available, else inline. */
  decoder?: "auto" | "worker" | "inline";
  /** Load the menu archive too (default true). */
  menu?: boolean;
  /** Store samples in AudioBuffers (default: when the browser has the AudioBuffer constructor). */
  audioBuffers?: boolean;
}

interface DecodeJob {
  key: string;
  path: string;
  origin: SampleOrigin;
  buffer: ArrayBuffer;
}

async function readOptional(raw: IAssetSource, path: string | null, warnings: string[]): Promise<ArrayBuffer | null> {
  if (!path) return null;
  try {
    return await raw.readBinary(path);
  } catch (error) {
    warnings.push(`audio: ${path} not readable (${(error as Error).message})`);
    return null;
  }
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Load and decode a mission's audio: samples (common, mission, menu),
 * definitions (common then mission), materials, animation triggers and the
 * configured volumes.
 */
export async function loadIgiAudio(raw: IAssetSource, options: LoadIgiAudioOptions = {}): Promise<IgiAudioData> {
  const paths = options.paths ?? LEVEL1_AUDIO_PATHS;
  const progress = options.onProgress ?? (() => {});
  const warnings: string[] = [];
  const t0 = now();

  progress(0, "Loading sounds…");
  let fetched = 0;
  let totalFetch = paths.missionSoundFiles.length + 7;
  const fetchMission = (files: ReadonlyArray<{ file: string; required: boolean }>) =>
    mapLimit(files, 6, async ({ file, required }) => {
      const path = paths.missionSoundDir + file;
      try {
        const buffer = await raw.readBinary(path);
        progress(Math.min(0.3, (0.3 * ++fetched) / totalFetch), `Loading sounds… ${fetched}/${totalFetch}`);
        return { path, buffer };
      } catch (error) {
        if (required) warnings.push(`audio: ${path} not readable (${(error as Error).message})`);
        return null;
      }
    });
  const counted = <T>(p: Promise<T>) =>
    p.then((v) => {
      progress(Math.min(0.3, (0.3 * ++fetched) / totalFetch), `Loading sounds… ${fetched}/${totalFetch}`);
      return v;
    });
  // The listed mission files are fetched alongside the archives and scripts.
  const listedFetch = fetchMission(paths.missionSoundFiles.map((f) => ({ file: f, required: true })));
  const [commonRes, commonQvm, missionQvm, menuRes, materialQvm, animQvm, configQvm] = await Promise.all([
    counted(raw.readBinary(paths.commonSounds)),
    counted(raw.readBinary(paths.commonDefinitions)),
    counted(readOptional(raw, paths.missionDefinitions, warnings)),
    counted(options.menu === false ? Promise.resolve(null) : readOptional(raw, paths.menuSounds, warnings)),
    counted(readOptional(raw, paths.materials, warnings)),
    counted(readOptional(raw, paths.animTriggers, warnings)),
    counted(readOptional(raw, paths.config, warnings)),
  ]);

  const definitions: SoundEntry[] = [...readSoundDefinitions(commonQvm, "common")];
  if (missionQvm) definitions.push(...readSoundDefinitions(missionQvm, "mission"));
  await yieldToEventLoop();

  // Mission directory: the listed files, plus any sample key a mission
  // definition names that the list lacks (read tolerantly: other missions'
  // names are simply absent).
  const listed = new Set(paths.missionSoundFiles.map((f) => ilsfSampleKey(f)));
  const extraFiles: Array<{ file: string; required: boolean }> = [];
  for (const d of definitions) {
    if (d.kind === "group" || d.origin !== "mission" || !d.sample) continue;
    const key = ilsfSampleKey(d.sample);
    if (listed.has(key)) continue;
    listed.add(key);
    extraFiles.push({ file: `${d.sample.toLowerCase()}.wav`, required: false });
  }
  totalFetch += extraFiles.length;
  const missionBuffers = [...(await listedFetch), ...(await fetchMission(extraFiles))];
  const fetchMs = now() - t0;

  // Registry order: common archive, mission directory, then (separately) menu.
  const jobs: DecodeJob[] = [];
  const seen = new Set<string>();
  const levelRejected: string[] = [];
  const queue = (origin: SampleOrigin, path: string, buffer: ArrayBuffer, keys: Set<string>, rejected: string[]) => {
    const key = ilsfSampleKey(path);
    try {
      readIlsfHeader(buffer);
    } catch (error) {
      warnings.push(`audio: ${path}: ${(error as Error).message}`);
      return;
    }
    if (keys.has(key)) {
      rejected.push(path);
      return;
    }
    keys.add(key);
    jobs.push({ key, path, origin, buffer });
  };
  for (const m of readIlffMembers(commonRes)) {
    if (m.name.toLowerCase().endsWith(".wav")) queue("common", m.name, m.payload, seen, levelRejected);
  }
  await yieldToEventLoop();
  for (const entry of missionBuffers) if (entry) queue("mission", entry.path, entry.buffer, seen, levelRejected);
  const menuSeen = new Set<string>();
  const menuRejected: string[] = [];
  if (menuRes) {
    for (const m of readIlffMembers(menuRes)) {
      if (m.name.toLowerCase().endsWith(".wav")) queue("menu", m.name, m.payload, menuSeen, menuRejected);
    }
    await yieldToEventLoop();
  }

  let decoder: SampleDecoder | null = null;
  if (options.decoder !== "inline") decoder = await createWorkerDecoder();
  if (!decoder && options.decoder === "worker") warnings.push("audio: worker decoder unavailable, decoding inline");
  decoder ??= createInlineDecoder();

  const samples = new SampleRegistry();
  const menuSamples = new SampleRegistry();
  for (const p of levelRejected) samples.rejected.push(p);
  for (const p of menuRejected) menuSamples.rejected.push(p);
  let bytes = 0;
  let total = 0;
  const td = now();
  let done = 0;
  try {
    const decoded = await Promise.all(
      jobs.map(async (job) => {
        bytes += job.buffer.byteLength;
        const d = await decoder!.decode(job.buffer);
        done++;
        if (done % 8 === 0 || done === jobs.length) {
          progress(0.3 + (0.7 * done) / jobs.length, `Decoding sounds… ${done}/${jobs.length}`);
        }
        return d;
      }),
    );
    const toBuffers = options.audioBuffers ?? typeof AudioBuffer !== "undefined";
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      const d = decoded[i];
      total += d.frames * d.channels;
      const sample = sampleFromDecoded(job.key, job.path, job.origin, d);
      if (toBuffers) {
        if (i % 16 === 15 || d.frames * d.channels > 1_000_000) await yieldToEventLoop();
        attachAudioBuffer(sample);
      }
      (job.origin === "menu" ? menuSamples : samples).add(sample);
    }
  } finally {
    decoder.dispose();
  }
  const decodeMs = now() - td;

  const data = createAudioData({
    samples,
    menuSamples,
    definitions,
    materials: materialQvm ? readMaterialSounds(materialQvm) : [],
    animTriggers: animQvm ? readAnimSoundTriggers(animQvm) : [],
    volumes: configQvm ? readAudioVolumes(configQvm) : { ...DEFAULT_AUDIO_VOLUMES },
  });
  data.warnings.push(...warnings);
  data.stats = {
    files: jobs.length,
    bytes,
    samples: total,
    fetchMs,
    decodeMs,
    maxBlockMs: decoder.maxBlockMs,
    decoder: decoder.kind,
  };
  progress(1, "Sounds ready");
  return data;
}

/**
 * Decode only the menu archive (menusystem/SOUND/sounds.res, loaded by the
 * menu manager FUN_00416c40 before any mission): the click / selection /
 * typing sounds and menu_music. Same registry rules as loadIgiAudio's menu set.
 */
export async function loadMenuSamples(raw: IAssetSource, options: Pick<LoadIgiAudioOptions, "paths" | "decoder" | "audioBuffers"> = {}): Promise<{ samples: SampleRegistry; warnings: string[] }> {
  const paths = options.paths ?? LEVEL1_AUDIO_PATHS;
  const warnings: string[] = [];
  const samples = new SampleRegistry();
  const res = await readOptional(raw, paths.menuSounds, warnings);
  if (!res) return { samples, warnings };
  const jobs: DecodeJob[] = [];
  const seen = new Set<string>();
  for (const m of readIlffMembers(res)) {
    if (!m.name.toLowerCase().endsWith(".wav")) continue;
    const key = ilsfSampleKey(m.name);
    try {
      readIlsfHeader(m.payload);
    } catch (error) {
      warnings.push(`audio: ${m.name}: ${(error as Error).message}`);
      continue;
    }
    if (seen.has(key)) {
      samples.rejected.push(m.name);
      continue;
    }
    seen.add(key);
    jobs.push({ key, path: m.name, origin: "menu", buffer: m.payload });
  }
  let decoder: SampleDecoder | null = null;
  if (options.decoder !== "inline") decoder = await createWorkerDecoder();
  decoder ??= createInlineDecoder();
  try {
    const decoded = await Promise.all(jobs.map((job) => decoder!.decode(job.buffer)));
    const toBuffers = options.audioBuffers ?? typeof AudioBuffer !== "undefined";
    for (let i = 0; i < jobs.length; i++) {
      const sample = sampleFromDecoded(jobs[i].key, jobs[i].path, "menu", decoded[i]);
      if (toBuffers) attachAudioBuffer(sample);
      samples.add(sample);
    }
  } finally {
    decoder.dispose();
  }
  return { samples, warnings };
}
