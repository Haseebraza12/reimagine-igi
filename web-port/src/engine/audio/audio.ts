/**
 * Legacy audio interface (kept so existing callers compile) and the audio
 * entry points.
 *
 * The game's audio is the recovered IGI system in igi-audio-system.ts
 * (createIgiAudio): original samples, sound definitions, the software 3D
 * mixer, event rules, ambience and cut-scene sound tasks. It implements
 * AudioManager, so it can be stored in ctx.systems.audio.
 *
 * createAudioManager() is the old minimal manager: it plays registered
 * original samples 2D and synthesizes NOTHING (the placeholder oscillator /
 * noise cues were removed: the original has a sample for everything it plays,
 * and its silent cases stay silent). play(name) is a no-op here.
 */
export interface AudioManager {
  /** Resume the AudioContext (call from a click/keydown gesture). */
  resume(): void;
  /** Play a named sound definition 2D (IGI system); a no-op in the legacy manager. */
  play(name: string, gain?: number): void;
  /** Make decoded original samples available by name (legacy manager only). */
  registerSamples(samples: Map<string, { sampleRate: number; channels: number; samples: Float32Array }>): void;
  /** Play an original sample once, 2D; false when it is not available. */
  playSample(name: string, gain?: number): boolean;
  /** Start (or keep) a looping sample under `key`; false when unavailable. */
  startLoop(key: string, name: string, gain?: number): boolean;
  /** Stop the loop under `key`, optionally playing `tail` once. */
  stopLoop(key: string, tail?: string | null, gain?: number): void;
  setMasterVolume(volume: number): void;
  readonly ready: boolean;
}

export { createIgiAudio } from "./igi-audio-system";
export type { IgiAudioSystem, IgiAudioOptions, SoundObject, DoorSounds, AudioSystemStats } from "./igi-audio-system";
export { listenerFromMatrix } from "./mixer";
export type { AudioListener } from "./mixer";
export { AUDIO_EVENTS } from "./sound-events";

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function resolveAudioContextCtor(): AudioContextCtor | null {
  if (typeof globalThis === "undefined") return null;
  const scope = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/** Minimal legacy manager: registered original samples only, nothing synthesized. */
export function createAudioManager(): AudioManager {
  let ac: AudioContext | null = null;
  let master: GainNode | null = null;
  let unavailable = false;
  let masterVolume = 1;
  let samples = new Map<string, { sampleRate: number; channels: number; samples: Float32Array }>();
  const buffers = new Map<string, AudioBuffer>();
  const loops = new Map<string, AudioBufferSourceNode>();

  const running = (): AudioContext | null => (ac && ac.state === "running" ? ac : null);

  function bufferFor(ctx: AudioContext, name: string): AudioBuffer | null {
    const cached = buffers.get(name);
    if (cached) return cached;
    const sound = samples.get(name);
    if (!sound) return null;
    const frames = sound.samples.length / sound.channels;
    const buffer = ctx.createBuffer(sound.channels, frames, sound.sampleRate);
    for (let c = 0; c < sound.channels; c++) {
      const out = buffer.getChannelData(c);
      for (let i = 0; i < frames; i++) out[i] = sound.samples[i * sound.channels + c];
    }
    buffers.set(name, buffer);
    return buffer;
  }

  function voice(name: string, gain: number, loop: boolean): AudioBufferSourceNode | null {
    const ctx = running();
    if (!ctx || !master) return null;
    const buffer = bufferFor(ctx, name);
    if (!buffer) return null;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = loop;
    const amp = ctx.createGain();
    amp.gain.value = Math.min(1, Math.max(0, gain));
    src.connect(amp);
    amp.connect(master);
    src.onended = () => {
      src.disconnect();
      amp.disconnect();
    };
    src.start();
    return src;
  }

  return {
    resume(): void {
      if (!ac && !unavailable) {
        const Ctor = resolveAudioContextCtor();
        if (!Ctor) return;
        try {
          ac = new Ctor();
          master = ac.createGain();
          master.gain.value = masterVolume;
          master.connect(ac.destination);
        } catch {
          unavailable = true;
          return;
        }
      }
      if (ac && ac.state !== "running") void ac.resume().catch(() => {});
    },
    play(): void {},
    registerSamples(map): void {
      samples = map;
      buffers.clear();
    },
    playSample(name: string, gain = 1): boolean {
      if (!running()) return samples.has(name);
      return voice(name, gain, false) !== null;
    },
    startLoop(key: string, name: string, gain = 1): boolean {
      if (loops.has(key)) return true;
      if (!running()) return samples.has(name);
      const src = voice(name, gain, true);
      if (src) loops.set(key, src);
      return src !== null;
    },
    stopLoop(key: string, tail?: string | null, gain = 1): void {
      const src = loops.get(key);
      if (!src) return;
      loops.delete(key);
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      if (tail) voice(tail, gain, false);
    },
    setMasterVolume(volume: number): void {
      masterVolume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 1;
      if (master && ac) master.gain.setValueAtTime(masterVolume, ac.currentTime);
    },
    get ready(): boolean {
      return running() !== null;
    },
  };
}
