/**
 * The original sound object model and software 3D mixer (docs/audio.md §2-3).
 *
 * Recovered behaviour reproduced here:
 * - A sound lookup creates an *instance* of a definition (a group creates all
 *   its members) as a child of a parent object (FUN_004dd750). The parent may
 *   publish a position / rotation (children follow it) and float variables
 *   (volVar / pitchVar / DefineGraph curves / DefineTriggerOnce).
 * - Every 30 Hz tick each instance updates its parameters (FUN_004df990:
 *   volume = clamp(defVolume) x clamp(runtimeVolume) x base, pitch =
 *   SetPitch x base), one-shots advance `elapsed` by 1/30 s and die once
 *   elapsed >= sample length and their voice has stopped (FUN_004df3f0), and
 *   the instance refreshes its voice unless it is positional and farther than
 *   maxDistance (FUN_004df0d0).
 * - Voice requests (FUN_004dda00): an existing voice is updated, and stopped
 *   when its computed volume is 0; a new voice needs one of 32 slots
 *   (DAT_005c606c), otherwise the request is dropped. In-memory samples
 *   (formats 1/3) start at the instance's elapsed time, streamed ones (0/2)
 *   and loops from 0 (FUN_00494a50).
 * - Housekeeping once per tick (FUN_004dcf60): a refreshed voice that was not
 *   refreshed since the last pass stops; fire-and-forget voices (raw sample
 *   and 2D-by-name paths, flag 1) stop when they end.
 * - Per-voice maths: computeVoice (FUN_004950f0) = linear distance fade,
 *   pan from the microphone's right axis, DSBVOLUME table, pitch clamp.
 *
 * Port deviation (documented): a one-shot whose voice reached the end of its
 * sample is finished even if its tick-counted `elapsed` has not reached the
 * sample length yet. The browser's tick rate can lag real time; the
 * original's literal rule would then restart streamed one-shots from 0.
 */
import type { Vec3 } from "../../contracts";
import {
  IGI_AUDIO,
  computeVoice,
  graphCurve,
  igiDirToEngine,
  igiPointToEngine,
  x87Fistp,
  type SoundDefinition,
  type VoiceState,
} from "../../loaders";
import type { IgiSample, SampleRegistry, SoundBank } from "./igi-audio";

/** The microphone: camera position and axes in engine space (metres, y up). */
export interface AudioListener {
  position: Vec3;
  /** Unit right axis (pan axis; microphone matrix column 0, docs/audio.md §3). */
  right: Vec3;
  forward: Vec3;
  up: Vec3;
}

export const DEFAULT_LISTENER: AudioListener = {
  position: [0, 0, 0],
  right: [1, 0, 0],
  forward: [0, 0, -1],
  up: [0, 1, 0],
};

/** Listener from a Three.js world matrix (Matrix4.elements, column-major). */
export function listenerFromMatrix(e: ArrayLike<number>): AudioListener {
  const norm = (x: number, y: number, z: number): Vec3 => {
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l];
  };
  return {
    position: [e[12], e[13], e[14]],
    right: norm(e[0], e[1], e[2]),
    up: norm(e[4], e[5], e[6]),
    forward: norm(-e[8], -e[9], -e[10]),
  };
}

/** Row-major 3x3 rotation in engine axes. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** A parent object that sound instances are children of (the parent message of FUN_004df990). */
export interface SoundParent {
  /** World position (engine); null when the parent publishes none (children then use absolute positions). */
  position(): Vec3 | null;
  /** Rotation applied to child offsets (row-major, engine axes). */
  rotation?(): Mat3 | null;
  /** Published float variables (e.g. train var0 = pitch, var1 = on/off). */
  vars?(): readonly number[] | null;
}

/** Whoever ticks an instance (its parent task); an inactive owner neither updates nor refreshes it. */
export interface SoundOwner {
  active(): boolean;
}

// ---------------------------------------------------------------- backend

export interface BackendVoice {
  readonly id: number;
}

/** Where voices actually play (WebAudio, or a recording fake in tests). */
export interface VoiceBackend {
  /** False while no audio can be produced (context suspended, no context yet). */
  readonly ready: boolean;
  start(sample: IgiSample, loop: boolean, offsetSeconds: number, state: VoiceState): BackendVoice | null;
  update(voice: BackendVoice, state: VoiceState): void;
  stop(voice: BackendVoice): void;
  /** False once a non-looping voice has played to its end. */
  isPlaying(voice: BackendVoice): boolean;
}

// ---------------------------------------------------------------- instances

export const TICK_SECONDS = 1 / IGI_AUDIO.tickHz;

const clamp01 = (v: number) => (v > 1 ? 1 : v > 0 ? v : 0);

let nextInstanceId = 1;

interface Voice {
  readonly id: number;
  readonly sample: IgiSample;
  readonly loop: boolean;
  /** Raw-sample / 2D-by-name voice (flag 1): plays to its end, never refreshed. */
  readonly fireAndForget: boolean;
  readonly backend: BackendVoice;
  owner: SoundInstance | null;
  refreshed: boolean;
  state: VoiceState;
}

export type InstanceKind = "definition" | "raw";

export class SoundInstance {
  readonly id = nextInstanceId++;
  /** Distance limits (metres); raw voices use the reset defaults 0 / 1 (FUN_00495750). */
  readonly minDistance: number;
  readonly maxDistance: number;
  /** Local position: relative to the parent when it publishes a position, else absolute (engine metres). */
  local: Vec3;
  /** Flag 2 (positional); cleared by "relative to microphone" (FUN_004e09a0). */
  positional: boolean;
  /** SetVolume runtime volume (message 0x546677, default 1). */
  runtimeVolume = 1;
  /** SetPitch multiplier (FUN_004dd8f0, default 1). */
  pitchMul = 1;
  /** Seconds played, +1/30 per tick for one-shots (FUN_004df3f0). */
  elapsed = 0;
  /** Elapsed time when the parameters were last updated (start offset for restarts). */
  paramElapsed = 0;
  // Per-tick results.
  world: Vec3 = [0, 0, 0];
  volume = 0;
  pitch = 1;
  voice: Voice | null = null;
  /** Kill message received (destroyed on the next tick, FUN_004df4b0). */
  killed = false;
  destroyed = false;
  /** The voice reached the end of the sample. */
  finished = false;
  /** DefineTriggerOnce state. */
  trigPrev: boolean | null = null;
  trigActive = false;

  constructor(
    readonly kind: InstanceKind,
    readonly name: string,
    readonly def: SoundDefinition | null,
    readonly sample: IgiSample | null,
    readonly loop: boolean,
    public parent: SoundParent | null,
    public owner: SoundOwner | null,
    local: Vec3,
    positional: boolean,
  ) {
    this.local = local;
    this.positional = positional;
    this.minDistance = def?.minDistance ?? 0;
    this.maxDistance = def?.maxDistance ?? 1;
  }

  /** Sample length in seconds (0 when the sample is not loaded). */
  get duration(): number {
    return this.sample?.duration ?? 0;
  }
}

/** What FUN_004dd750 returns: one object, which for a group owns all members. Messages go to every member. */
export class SoundHandle {
  constructor(
    readonly name: string,
    readonly instances: readonly SoundInstance[],
  ) {}

  /** The weak handle is non-null (*handle != 0): the object still exists. */
  get alive(): boolean {
    return this.instances.some((i) => !i.destroyed);
  }

  /** At least one member currently holds a voice. */
  get audible(): boolean {
    return this.instances.some((i) => i.voice !== null);
  }

  kill(): void {
    for (const i of this.instances) i.killed = true;
  }

  /** FUN_004dd880: sets the local position (absolute for parentless instances). */
  setPosition(p: Vec3): void {
    for (const i of this.instances) i.local = [p[0], p[1], p[2]];
  }

  /** SetVolume(-1, v) (FUN_004dd8b0). */
  setVolume(v: number): void {
    for (const i of this.instances) i.runtimeVolume = v;
  }

  /** FUN_004dd8f0. */
  setPitch(p: number): void {
    for (const i of this.instances) i.pitchMul = p;
  }

  /** Message 0x54667b (FUN_004e09a0): true makes the sound 2D. */
  setRelativeToMicrophone(on: boolean): void {
    for (const i of this.instances) i.positional = !on;
  }
}

export interface SpawnOptions {
  /** Parent object; children follow its position and read its variables. */
  parent?: SoundParent | null;
  owner?: SoundOwner | null;
  /** Initial local position (absolute without a parent). */
  position?: Vec3;
  /** false = relative to microphone (2D). */
  positional?: boolean;
  volume?: number;
  pitch?: number;
}

export interface MixerOptions {
  /** DAT_005c606c = 32. */
  maxVoices?: number;
  /** GOSoundFX volume (config.qvm). */
  fxVolume?: number;
  /** IGI position mapped to engine (0,0,0); converts absolute definition offsets. */
  originIgi?: Vec3 | null;
}

export interface MixerStats {
  voices: number;
  peakVoices: number;
  instances: number;
  started: number;
  /** Requests dropped because all voices were busy. */
  dropped: number;
}

/** Engine metres -> IGI units for computeVoice (axes do not matter for distance and the dot product). */
const toUnits = (v: Vec3): [number, number, number] => [
  v[0] * IGI_AUDIO.unitsPerMetre,
  v[1] * IGI_AUDIO.unitsPerMetre,
  v[2] * IGI_AUDIO.unitsPerMetre,
];

export class SoundMixer {
  private backend: VoiceBackend | null = null;
  private instances: SoundInstance[] = [];
  private readonly voices = new Set<Voice>();
  private readonly loops = new Map<string, Voice>();
  private listener: AudioListener = DEFAULT_LISTENER;
  private voiceSeq = 0;
  readonly maxVoices: number;
  fxVolume: number;
  originIgi: Vec3 | null;
  readonly stats: MixerStats = { voices: 0, peakVoices: 0, instances: 0, started: 0, dropped: 0 };

  constructor(
    private samples: SampleRegistry,
    private bank: SoundBank,
    options: MixerOptions = {},
  ) {
    this.maxVoices = options.maxVoices ?? IGI_AUDIO.maxVoices;
    this.fxVolume = options.fxVolume ?? 1;
    this.originIgi = options.originIgi ?? null;
  }

  /** Swap the data (after loading); existing instances are destroyed. */
  setData(samples: SampleRegistry, bank: SoundBank): void {
    this.stopAll();
    this.samples = samples;
    this.bank = bank;
  }

  /** Attach (or detach) the voice backend; voices of the previous backend are stopped. */
  setBackend(backend: VoiceBackend | null): void {
    for (const v of [...this.voices]) this.stopVoice(v);
    this.loops.clear();
    this.backend = backend;
  }

  get currentListener(): AudioListener {
    return this.listener;
  }

  /** Live instances (for inspection). */
  get liveInstances(): readonly SoundInstance[] {
    return this.instances.filter((i) => !i.destroyed);
  }

  get voiceCount(): number {
    return this.voices.size;
  }

  // ------------------------------------------------------------ creation

  /** FUN_004dd750: instance a definition or group by exact name; null when no entry matches. */
  spawn(name: string, options: SpawnOptions = {}): SoundHandle | null {
    const entry = this.bank.find(name);
    if (!entry) return null;
    const parent = options.parent ?? null;
    const instances = this.bank.instantiate(entry).map((def) => {
      const local: Vec3 = options.position
        ? [options.position[0], options.position[1], options.position[2]]
        : this.defaultLocal(def, parent);
      const inst = new SoundInstance(
        "definition",
        def.name,
        def,
        this.samples.get(def.sample) ?? null,
        def.loop,
        parent,
        options.owner ?? null,
        local,
        options.positional ?? true,
      );
      if (options.volume !== undefined) inst.runtimeVolume = options.volume;
      if (options.pitch !== undefined) inst.pitchMul = options.pitch;
      this.instances.push(inst);
      return inst;
    });
    return new SoundHandle(name, instances);
  }

  /**
   * A raw sample voice that its owner refreshes every tick while it plays
   * (ConditionalSound "Simple", FUN_004247d0 / FUN_004248b0): 2D, volume 1,
   * no loop. Starts immediately; null when the sample is not loaded.
   */
  spawnRaw(sampleName: string, owner: SoundOwner | null, volume = 1): SoundHandle | null {
    const sample = this.samples.get(sampleName);
    if (!sample) return null;
    const inst = new SoundInstance("raw", sample.key, null, sample, false, null, owner, [0, 0, 0], false);
    inst.volume = clamp01(volume);
    this.instances.push(inst);
    this.requestVoice(inst);
    return new SoundHandle(sample.key, [inst]);
  }

  /** FUN_004dddc0: a DefineSound's sample played 2D, fire-and-forget, at `volume` (its own volume and distances ignored). */
  play2DByName(name: string, volume = 1, pitch = 1): boolean {
    const def = this.bank.findSound(name);
    if (!def) return false;
    const sample = this.samples.get(def.sample);
    return sample ? this.playFireAndForget(sample, volume, pitch, false) !== null : false;
  }

  /** FUN_004ddd40: a raw sample, 2D, fire-and-forget. `registry` defaults to the level samples. */
  playRaw(sampleName: string, volume = 1, registry: SampleRegistry = this.samples): boolean {
    const sample = registry.get(sampleName);
    return sample ? this.playFireAndForget(sample, volume, 1, false) !== null : false;
  }

  /** Legacy keyed 2D loop (AudioManager.startLoop). */
  startKeyedLoop(key: string, sampleName: string, volume = 1): boolean {
    if (this.loops.has(key)) return true;
    const sample = this.samples.get(sampleName);
    if (!sample) return false;
    const v = this.playFireAndForget(sample, volume, 1, true);
    if (v) this.loops.set(key, v);
    return v !== null;
  }

  stopKeyedLoop(key: string): boolean {
    const v = this.loops.get(key);
    if (!v) return false;
    this.loops.delete(key);
    this.stopVoice(v);
    return true;
  }

  private playFireAndForget(sample: IgiSample, volume: number, pitch: number, loop: boolean): Voice | null {
    const state = computeVoice({ volume, pitch, sampleRate: sample.sampleRate, positional: false, fxVolume: this.fxVolume });
    return this.startVoice(sample, loop, 0, state, null, true);
  }

  /** Default local position from the definition's x/y/z (IGI units). */
  private defaultLocal(def: SoundDefinition, parent: SoundParent | null): Vec3 {
    const [x, y, z] = def.offset;
    if (x === 0 && y === 0 && z === 0) return [0, 0, 0];
    if (parent) {
      const d = igiDirToEngine([x, y, z]);
      return [d[0] / IGI_AUDIO.unitsPerMetre, d[1] / IGI_AUDIO.unitsPerMetre, d[2] / IGI_AUDIO.unitsPerMetre];
    }
    return this.originIgi ? igiPointToEngine([x, y, z], this.originIgi) : [0, 0, 0];
  }

  // ------------------------------------------------------------ tick

  /** One 30 Hz tick: update and refresh every instance, then voice housekeeping. */
  tick(listener: AudioListener): void {
    this.listener = listener;
    for (const inst of this.instances.slice()) this.tickInstance(inst);
    this.instances = this.instances.filter((i) => !i.destroyed);
    this.housekeeping();
    this.stats.instances = this.instances.length;
    this.stats.voices = this.voices.size;
  }

  /** Stop every voice and destroy every instance (FUN_004ddcf0 + level teardown). */
  stopAll(): void {
    for (const inst of this.instances) inst.destroyed = true;
    this.instances = [];
    for (const v of [...this.voices]) this.stopVoice(v);
    this.loops.clear();
    this.stats.voices = 0;
    this.stats.instances = 0;
  }

  private tickInstance(inst: SoundInstance): void {
    if (inst.destroyed) return;
    if (inst.killed) {
      this.destroy(inst);
      return;
    }
    if (inst.owner && !inst.owner.active()) return;
    if (inst.kind === "raw") {
      // FUN_004248b0: refreshed while it plays; done once it stopped.
      if (!inst.voice) {
        this.destroy(inst);
        return;
      }
      this.requestVoice(inst);
      return;
    }
    const def = inst.def!;
    if (def.kind === "trigger-once") {
      this.tickTrigger(inst);
      return;
    }
    if (!inst.loop) {
      const playing = inst.voice !== null;
      if (inst.finished || (inst.duration <= inst.elapsed && !playing)) {
        this.destroy(inst);
        return;
      }
      this.updateParams(inst);
      inst.elapsed += TICK_SECONDS;
    } else {
      this.updateParams(inst);
    }
    this.refresh(inst);
  }

  /** DefineTriggerOnce: one play per edge of trunc(var[trigVar]) (fistp, chop mode) (to non-zero, or to zero with onZero). */
  private tickTrigger(inst: SoundInstance): void {
    const def = inst.def!;
    this.updateParams(inst);
    const vars = inst.parent?.vars?.() ?? null;
    const x = vars && def.triggerVar !== undefined && def.triggerVar >= 0 ? vars[def.triggerVar] : undefined;
    const cur = x !== undefined && x87Fistp(x) !== 0;
    if (inst.trigPrev === null) inst.trigPrev = cur;
    const fire = def.triggerOnZero ? inst.trigPrev && !cur : !inst.trigPrev && cur;
    inst.trigPrev = cur;
    if (fire) {
      if (inst.voice) this.stopVoice(inst.voice);
      inst.trigActive = true;
      inst.finished = false;
      inst.elapsed = 0;
    }
    if (!inst.trigActive) return;
    if (inst.finished || (inst.duration <= inst.elapsed && !inst.voice)) {
      inst.trigActive = false;
      inst.finished = false;
      return;
    }
    inst.paramElapsed = inst.elapsed;
    inst.elapsed += TICK_SECONDS;
    this.refresh(inst);
  }

  /** FUN_004df990 / FUN_004e1a40: position, volume and pitch for this tick. */
  private updateParams(inst: SoundInstance): void {
    const def = inst.def!;
    let base = 1;
    let basePitch = 1;
    const vars = inst.parent?.vars?.() ?? null;
    if (vars) {
      const has = (i: number) => i >= 0 && i < vars.length && Number.isFinite(vars[i]);
      if (def.kind === "graph") {
        if (has(def.volumeVar)) {
          const x = vars[def.volumeVar];
          base = x < 0 ? 0 : graphCurve(def.volumeCurve ?? [], x);
        }
        if (has(def.pitchVar)) basePitch = graphCurve(def.pitchCurve ?? [], vars[def.pitchVar]);
      } else {
        if (has(def.volumeVar)) base = vars[def.volumeVar];
        if (has(def.pitchVar)) basePitch = vars[def.pitchVar];
      }
    }
    inst.volume = clamp01(clamp01(def.volume) * clamp01(inst.runtimeVolume) * base);
    inst.pitch = inst.pitchMul * basePitch;
    inst.world = this.worldOf(inst);
    inst.paramElapsed = inst.elapsed;
  }

  private worldOf(inst: SoundInstance): Vec3 {
    const p = inst.parent?.position() ?? null;
    const l = inst.local;
    if (!p) return [l[0], l[1], l[2]];
    const r = inst.parent?.rotation?.() ?? null;
    const o: Vec3 = r
      ? [r[0] * l[0] + r[1] * l[1] + r[2] * l[2], r[3] * l[0] + r[4] * l[1] + r[5] * l[2], r[6] * l[0] + r[7] * l[1] + r[8] * l[2]]
      : l;
    return [p[0] + o[0], p[1] + o[1], p[2] + o[2]];
  }

  /** FUN_004df0d0: positional instances beyond maxDistance are not refreshed (their voice then stops). */
  private refresh(inst: SoundInstance): void {
    if (!inst.sample) return;
    if (inst.positional) {
      const l = this.listener.position;
      const d = Math.hypot(inst.world[0] - l[0], inst.world[1] - l[1], inst.world[2] - l[2]);
      if (d > inst.maxDistance) return;
    }
    this.requestVoice(inst);
  }

  /** Current per-voice parameters for an instance (FUN_004950f0). */
  voiceStateOf(inst: SoundInstance): VoiceState {
    const s = inst.sample!;
    return computeVoice({
      volume: inst.volume,
      pitch: inst.pitch,
      sampleRate: s.sampleRate,
      positional: inst.positional,
      source: toUnits(inst.world),
      listener: toUnits(this.listener.position),
      listenerRight: this.listener.right,
      minDistance: inst.minDistance,
      maxDistance: inst.maxDistance,
      fxVolume: this.fxVolume,
    });
  }

  /** FUN_004dda00. */
  private requestVoice(inst: SoundInstance): void {
    const state = this.voiceStateOf(inst);
    const v = inst.voice;
    if (v) {
      v.refreshed = true;
      v.state = state;
      if (state.volume === 0) this.stopVoice(v);
      else this.backend?.update(v.backend, state);
      return;
    }
    const s = inst.sample!;
    const offset = !s.streamed && inst.paramElapsed < s.duration ? inst.paramElapsed : 0;
    this.startVoice(s, inst.loop, offset, state, inst, false);
  }

  private startVoice(
    sample: IgiSample,
    loop: boolean,
    offset: number,
    state: VoiceState,
    owner: SoundInstance | null,
    fireAndForget: boolean,
  ): Voice | null {
    const backend = this.backend;
    if (!backend || !backend.ready) return null;
    if (this.voices.size >= this.maxVoices) {
      this.stats.dropped++;
      return null;
    }
    // A voice whose first computed volume is 0 is stopped at once (FUN_004dda00).
    if (state.volume === 0) return null;
    const bv = backend.start(sample, loop, offset, state);
    if (!bv) return null;
    const voice: Voice = {
      id: ++this.voiceSeq,
      sample,
      loop,
      fireAndForget,
      backend: bv,
      owner,
      refreshed: true,
      state,
    };
    this.voices.add(voice);
    if (owner) owner.voice = voice;
    this.stats.started++;
    if (this.voices.size > this.stats.peakVoices) this.stats.peakVoices = this.voices.size;
    return voice;
  }

  private stopVoice(v: Voice): void {
    if (!this.voices.delete(v)) return;
    this.backend?.stop(v.backend);
    if (v.owner && v.owner.voice === v) v.owner.voice = null;
  }

  /** FUN_004dcf60. */
  private housekeeping(): void {
    const backend = this.backend;
    for (const v of [...this.voices]) {
      if (v.fireAndForget) {
        if (!backend || !backend.isPlaying(v.backend) || v.state.volume === 0) this.stopVoice(v);
        continue;
      }
      if (!v.refreshed) {
        this.stopVoice(v);
        continue;
      }
      if (backend && !v.loop && !backend.isPlaying(v.backend)) {
        const owner = v.owner;
        this.stopVoice(v);
        if (owner) owner.finished = true;
        continue;
      }
      v.refreshed = false;
    }
  }

  private destroy(inst: SoundInstance): void {
    inst.destroyed = true;
    if (inst.voice) this.stopVoice(inst.voice);
  }
}
