/**
 * IGI audio system: the original samples, definitions, software 3D mixer,
 * event rules, ambience and cut-scene sound tasks behind one object.
 *
 *   const audio = createIgiAudio(ctx);                 // subscribes to ctx.events
 *   await audio.load(raw, (f, text) => ...);           // samples + definitions
 *   canvas click:  audio.resume();                     // AudioContext needs a gesture
 *   every 30 Hz tick:  audio.tick(listenerFromMatrix(camera.matrixWorld.elements));
 *   mission restart:  audio.reset();
 *
 * It implements the legacy AudioManager interface (engine/audio/audio.ts), so
 * it can sit in ctx.systems.audio unchanged. Nothing is synthesized: names
 * without an original definition or sample stay silent, as in the original.
 */
import type { GameRng } from "./sound-events";
import type { IAssetSource, Vec3 } from "../../contracts";
import type { AudioManager } from "./audio";
import { AmbienceRuntime } from "./ambience";
import { createAudioData, loadIgiAudio, type IgiAudioData, type LoadIgiAudioOptions } from "./igi-audio";
import {
  SoundMixer,
  type AudioListener,
  type Mat3,
  type MixerStats,
  type SoundHandle,
  type SoundParent,
} from "./mixer";
import { SoundEvents, type AudioHostContext } from "./sound-events";
import { WebAudioBackend, createIgiAudioContext } from "./webaudio-backend";
import type { Actor } from "../events";

/** A sound-emitting object (train, heli, truck, camera, binoculars…) that publishes a transform and variables. */
export interface SoundObject {
  /** Publish the object's state; call every tick before audio.tick. Vars as the original's object block (docs/audio.md §4). */
  update(position: Vec3, vars?: readonly number[] | null, rotation?: Mat3 | null): void;
  readonly handle: SoundHandle;
  readonly alive: boolean;
  /** Kill its sounds (the object was removed). */
  dispose(): void;
}

/** Door sound edges (0x4461bb-0x446288): open/close one-shots on arrival, move sound while travelling. */
export interface DoorSounds {
  update(position: Vec3, isOpen: boolean, isClosed: boolean): void;
  dispose(): void;
}

export interface AudioSystemStats extends MixerStats {
  tick: number;
  contextState: string;
  contextSampleRate: number;
  gunLoops: number;
  ambientAreas: number;
  conditionalSounds: number;
}

export interface IgiAudioSystem extends AudioManager {
  /** Fetch and decode the mission's audio (common, mission, menu) with progress. */
  load(raw: IAssetSource, onProgress?: (fraction: number, text: string) => void, options?: Omit<LoadIgiAudioOptions, "onProgress">): Promise<IgiAudioData>;
  /** Use already-loaded data (tests, harness, reuse across restarts). */
  setData(data: IgiAudioData): void;
  readonly data: IgiAudioData | null;
  /** One 30 Hz game tick with the microphone (camera) in engine space. */
  tick(listener: AudioListener): void;
  /** Suspend / resume the output (pause menu). */
  setPaused(paused: boolean): void;
  /** Mission restart: stop everything, clear gates, limiters, ambience and cut-scene sound state. */
  reset(): void;
  /** Menu sound: raw sample, 2D, volume 1 (menu_high, menu_sel, menu_sel2, menu_ok, menu_cancel, menu_k01..07). */
  playMenu(name: string): boolean;
  /** Instance a definition/group at a world position (explosions, grenade bounce, weapon drop, stab…). */
  playAt(name: string, position: Vec3, options?: { volume?: number; pitch?: number }): SoundHandle | null;
  /** Instance a definition/group as a child of an actor (follows it). */
  attachTo(name: string, actor: Actor): SoundHandle | null;
  /** 2D by name (FUN_004dddc0): the DefineSound's sample at volume 1. */
  play2D(name: string, volume?: number): boolean;
  /** Raw level sample, 2D, volume 1 (FUN_004ddd40). */
  playRawSample(name: string, volume?: number): boolean;
  /** Instance `name` (definition or group, e.g. "helicopter_1", "truck_sounds", "train_loop_1") as children of an object. */
  objectSound(name: string, position: Vec3, vars?: readonly number[] | null, rotation?: Mat3 | null): SoundObject | null;
  doorSounds(names: { open: string; close: string; move: string }): DoorSounds;
  /** Map computer zoom (FUN_00468b80): mapcomp_05 (sample missing: silent) + mapcomp_03, 2D. */
  mapZoom(): void;
  /** Footsteps also play walk_rain_N (level 1: dry). */
  setRaining(on: boolean): void;
  readonly mixer: SoundMixer;
  readonly events: SoundEvents;
  readonly ambience: AmbienceRuntime | null;
  readonly stats: AudioSystemStats;
  readonly context: BaseAudioContext | null;
  dispose(): void;
}

export interface IgiAudioOptions {
  /** Uniform [0,1) RNG standing in for the game RNG (default Math.random); ignored with `rng`. */
  random?: () => number;
  /** The level RNG itself (FUN_00415c20): float / int / raw step exactly as igi.exe draws them. */
  rng?: GameRng;
  /** Use this context instead of creating one on resume() (e.g. an OfflineAudioContext). */
  context?: BaseAudioContext;
  /** Treat the context as running (offline rendering). */
  alwaysReady?: boolean;
  /** Close loops that never got FireStopped (default true). */
  fireWatchdog?: boolean;
  /**
   * Material for Footstep / Land / Impact payloads whose material is null
   * (default null: silent, as igi.exe is without a material). The engine
   * now sends the collision materials (HSMC set 0 / terrain), so leave unset.
   */
  fallbackMaterial?: string | null;
}

export function createIgiAudio(host: AudioHostContext, options: IgiAudioOptions = {}): IgiAudioSystem {
  const random = options.rng ? () => options.rng!.float() : (options.random ?? Math.random);
  let data: IgiAudioData | null = null;
  const empty = createAudioData({});
  const mixer = new SoundMixer(empty.samples, empty.bank);
  let tickCount = 0;
  const now = () => tickCount;
  const events = new SoundEvents(host, mixer, () => data, now, {
    random,
    rng: options.rng,
    fireWatchdog: options.fireWatchdog,
    fallbackMaterial: options.fallbackMaterial,
  });
  const unbind = events.bind(host.events);
  let ambience: AmbienceRuntime | null = null;
  let ambienceLevel: object | null = null;
  let context: BaseAudioContext | null = options.context ?? null;
  let backend: WebAudioBackend | null = null;
  let unlocked = options.alwaysReady === true;
  let masterGain = 1;
  let paused = false;
  let disposed = false;

  const attachBackend = () => {
    if (!context || backend) return;
    // Before a user gesture nothing may start; once resume() was called voices
    // may start while the context finishes resuming (they play when it runs).
    backend = new WebAudioBackend(context, {
      alwaysReady: options.alwaysReady,
      isReady: () => !paused && unlocked && context !== null && context.state !== "closed",
    });
    backend.setMasterGain(masterGain);
    mixer.setBackend(backend);
  };
  if (context) attachBackend();

  const ensureAmbience = () => {
    const level = host.level;
    if (!level || !data) return;
    if (ambience && ambienceLevel === level) return;
    ambience = new AmbienceRuntime(mixer, level.tasks, level.originIgi, () => host.systems.tasks, { random });
    ambienceLevel = level;
    mixer.originIgi = level.originIgi;
  };

  const actorParent = (actor: Actor): SoundParent => events.actorParent(actor);

  const system: IgiAudioSystem = {
    async load(raw, onProgress, loadOptions = {}) {
      const loaded = await loadIgiAudio(raw, { ...loadOptions, onProgress });
      for (const w of loaded.warnings) console.info(`[audio] ${w}`);
      system.setData(loaded);
      return loaded;
    },

    setData(next) {
      data = next;
      mixer.setData(next.samples, next.bank);
      mixer.fxVolume = next.volumes.fx;
      ambience = null;
      ambienceLevel = null;
      events.reset();
    },

    get data() {
      return data;
    },

    tick(listener) {
      if (disposed) return;
      tickCount++;
      ensureAmbience();
      events.tick();
      ambience?.tick(listener);
      mixer.tick(listener);
    },

    setPaused(on) {
      paused = on;
      const ac = context as AudioContext | null;
      if (!ac || typeof ac.suspend !== "function" || options.alwaysReady) return;
      if (on) void ac.suspend().catch(() => {});
      else if (unlocked) void ac.resume().catch(() => {});
    },

    reset() {
      mixer.stopAll();
      events.reset();
      ambience?.reset();
      tickCount = 0;
    },

    playMenu(name) {
      if (!data) return false;
      return mixer.playRaw(name, 1, data.menuSamples) || mixer.playRaw(name, 1);
    },

    playAt(name, position, opts = {}) {
      return mixer.spawn(name, { position, volume: opts.volume, pitch: opts.pitch });
    },

    attachTo(name, actor) {
      return mixer.spawn(name, { parent: actorParent(actor) });
    },

    play2D(name, volume = 1) {
      return mixer.play2DByName(name, volume);
    },

    playRawSample(name, volume = 1) {
      return mixer.playRaw(name, volume);
    },

    objectSound(name, position, vars = null, rotation = null) {
      const state = { position: [...position] as Vec3, vars, rotation };
      const parent: SoundParent = {
        position: () => state.position,
        rotation: () => state.rotation,
        vars: () => state.vars,
      };
      const handle = mixer.spawn(name, { parent });
      if (!handle) return null;
      return {
        handle,
        update(p, v, r) {
          state.position = [p[0], p[1], p[2]];
          if (v !== undefined) state.vars = v;
          if (r !== undefined) state.rotation = r;
        },
        get alive() {
          return handle.alive;
        },
        dispose() {
          handle.kill();
        },
      };
    },

    doorSounds(names) {
      let prevOpen: boolean | null = null;
      let prevClosed: boolean | null = null;
      let move: SoundHandle | null = null;
      return {
        update(position, isOpen, isClosed) {
          if (prevOpen !== null && isOpen && !prevOpen) mixer.spawn(names.open, { position });
          if (prevClosed !== null && isClosed && !prevClosed) mixer.spawn(names.close, { position });
          const moving = !isOpen && !isClosed;
          if (moving && prevOpen !== null) {
            if (!move) move = mixer.spawn(names.move, { position });
            else if (move.alive) move.setPosition(position);
          } else if (move) {
            if (move.alive) move.kill();
            move = null;
          }
          prevOpen = isOpen;
          prevClosed = isClosed;
        },
        dispose() {
          if (move?.alive) move.kill();
          move = null;
        },
      };
    },

    mapZoom() {
      mixer.play2DByName("mapcomp_05", 1, 1);
      mixer.play2DByName("mapcomp_03", 1, 1);
    },

    setRaining(on) {
      events.raining = on;
    },

    get mixer() {
      return mixer;
    },

    get events() {
      return events;
    },

    get ambience() {
      return ambience;
    },

    get context() {
      return context;
    },

    get stats(): AudioSystemStats {
      return {
        ...mixer.stats,
        voices: mixer.voiceCount,
        tick: tickCount,
        contextState: context ? context.state : "none",
        contextSampleRate: context ? context.sampleRate : 0,
        gunLoops: events.activeGunLoops,
        ambientAreas: ambience?.areas.length ?? 0,
        conditionalSounds: ambience?.sounds.length ?? 0,
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      unbind();
      mixer.stopAll();
      mixer.setBackend(null);
      backend?.dispose();
      backend = null;
      if (context && !options.context && "close" in context) void (context as AudioContext).close().catch(() => {});
      context = null;
    },

    // ---------------------------------------------------------- AudioManager (legacy)

    resume() {
      if (disposed) return;
      unlocked = true;
      if (!context) context = createIgiAudioContext();
      if (!context) return;
      attachBackend();
      const ac = context as AudioContext;
      if (!paused && ac.state !== "running" && typeof ac.resume === "function") void ac.resume().catch(() => {});
    },

    /** Legacy cue API: plays the DefineSound `name` 2D; nothing is synthesized. */
    play(name, gain = 1) {
      mixer.play2DByName(name, gain);
    },

    /** Legacy: samples come from load(); ignored. */
    registerSamples() {},

    playSample(name, gain = 1) {
      return mixer.playRaw(name, gain);
    },

    startLoop(key, name, gain = 1) {
      return mixer.startKeyedLoop(key, name, gain);
    },

    stopLoop(key, tail = null, gain = 1) {
      if (mixer.stopKeyedLoop(key) && tail) mixer.playRaw(tail, gain);
    },

    setMasterVolume(volume) {
      masterGain = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
      backend?.setMasterGain(masterGain);
    },

    get ready() {
      return backend !== null && backend.ready && context !== null && context.state === "running";
    },
  };
  return system;
}
