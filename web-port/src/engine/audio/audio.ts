/**
 * WebAudio manager.
 *
 * Synthesises weapon/enemy/ambient cues with oscillators + a shared white-noise
 * buffer so the vertical slice has audio without shipping original .wav files.
 * The AudioContext is created lazily on the first {@link AudioManager.resume}
 * (browser autoplay policy requires a user gesture) and every cue is a no-op
 * until the context is actually running. Environments without WebAudio (SSR,
 * unit tests, locked-down browsers) degrade to a silent manager.
 *
 * Confidence: implementation choice. Cue *names* mirror the events emitted by
 * the combat systems (see events.ts); the synthesis recipes are hand-tuned to
 * evoke IGI's dry, percussive gunfire rather than recovered from game data.
 */
export interface AudioManager {
  /** Resume the AudioContext (call from a click/keydown gesture). */
  resume(): void;
  /** Play a named cue (fire, reload, hit, death, footstep, ambient...). */
  play(name: string, gain?: number): void;
  setMasterVolume(volume: number): void;
  readonly ready: boolean;
}

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

/** Options for a shaped white-noise burst (gunshot body, clicks, thuds). */
interface NoiseBurstOptions {
  /** Length of the burst in seconds. */
  dur: number;
  /** Peak linear gain (already multiplied by the per-cue trim). */
  gain: number;
  filter?: BiquadFilterType;
  /** Cutoff at t0 (also the sweep start when `sweepTo` is set). */
  frequency?: number;
  /** Cutoff at the end of the burst (falling = duller tail). */
  sweepTo?: number;
  q?: number;
  /** Playback rate of the noise buffer (>1 = brighter/grittier). */
  rate?: number;
}

/** Options for an oscillator voice (thumps, beeps, descending tones). */
interface ToneOptions {
  freq: number;
  dur: number;
  gain: number;
  type?: OscillatorType;
  /** Frequency at the end of the tone (exponential glide target). */
  sweepTo?: number;
  /** Optional lowpass cutoff, keeps saw/square cues from getting shrill. */
  filter?: number;
}

/** Live audio graph: context + master bus + reusable noise buffer. */
interface AudioGraph {
  ac: AudioContext;
  master: GainNode;
  noise: AudioBuffer;
}

/** Nominal master level (per-cue trims assume this is 1.0). */
const DEFAULT_MASTER_VOLUME = 0.6;
/** Looping wind bed level — present but never intrusive. */
const AMBIENT_GAIN = 0.03;
/** Guard rail so a bad caller cannot blow out the mix. */
const MAX_CUE_GAIN = 4;

function clamp01(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

/** WebAudio constructor lookup that survives prefixed/absent environments. */
function resolveAudioContextCtor(): AudioContextCtor | null {
  if (typeof globalThis === "undefined") return null;
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

export function createAudioManager(): AudioManager {
  let graph: AudioGraph | null = null;
  /** Set once we learn this environment has no usable WebAudio. */
  let unavailable = false;
  let masterVolume = DEFAULT_MASTER_VOLUME;
  /** Single looping ambient voice; extra `ambient` cues are ignored. */
  let ambientSource: AudioBufferSourceNode | null = null;

  function ensureGraph(): AudioGraph | null {
    if (graph) return graph;
    if (unavailable) return null;
    const Ctor = resolveAudioContextCtor();
    // Not cached: a WebAudio polyfill may appear after boot.
    if (!Ctor) return null;
    let ac: AudioContext;
    try {
      ac = new Ctor();
    } catch {
      unavailable = true;
      return null;
    }
    const master = ac.createGain();
    master.gain.value = masterVolume;
    master.connect(ac.destination);
    graph = { ac, master, noise: createNoiseBuffer(ac) };
    return graph;
  }

  function createNoiseBuffer(ac: AudioContext): AudioBuffer {
    const frames = Math.max(1, Math.floor(ac.sampleRate));
    const buffer = ac.createBuffer(1, frames, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /** Graph usable for scheduling right now (otherwise nudges resume()). */
  function activeGraph(): AudioGraph | null {
    // Never create the context here: that only happens in resume(), from a
    // user gesture, so a cue played too early simply stays silent.
    const g = graph;
    if (!g) return null;
    if (g.ac.state !== "running") {
      void g.ac.resume().catch(() => {
        /* still blocked; play() simply stays silent */
      });
      return null;
    }
    return g;
  }

  /** Percussive attack/decay envelope; never ramps to exact zero. */
  function envelope(
    param: AudioParam,
    t0: number,
    peak: number,
    attack: number,
    dur: number,
  ): void {
    const top = Math.max(0.0002, peak);
    const end = t0 + Math.max(attack + 0.01, dur);
    param.setValueAtTime(0.0001, t0);
    param.linearRampToValueAtTime(top, t0 + attack);
    param.exponentialRampToValueAtTime(0.0001, end);
  }

  function noiseBurst(g: AudioGraph, t0: number, o: NoiseBurstOptions): void {
    const src = g.ac.createBufferSource();
    src.buffer = g.noise;
    src.loop = true;
    src.playbackRate.value = o.rate ?? 1;

    let tail: AudioNode = src;
    if (o.filter) {
      const biquad = g.ac.createBiquadFilter();
      biquad.type = o.filter;
      biquad.frequency.setValueAtTime(o.frequency ?? 1000, t0);
      if (o.sweepTo !== undefined) {
        biquad.frequency.exponentialRampToValueAtTime(
          Math.max(30, o.sweepTo),
          t0 + o.dur,
        );
      }
      if (o.q !== undefined) biquad.Q.value = o.q;
      src.connect(biquad);
      tail = biquad;
    }

    const amp = g.ac.createGain();
    envelope(amp.gain, t0, o.gain, Math.min(0.008, o.dur * 0.25), o.dur);
    tail.connect(amp);
    amp.connect(g.master);

    const stopAt = t0 + o.dur + 0.05;
    // Random read offset keeps repeated bursts from sounding identical.
    src.start(t0, Math.random() * 0.9, o.dur + 0.05);
    src.stop(stopAt);
    src.onended = () => {
      try {
        src.disconnect();
        amp.disconnect();
      } catch {
        /* already torn down */
      }
    };
  }

  function tone(g: AudioGraph, t0: number, o: ToneOptions): void {
    const osc = g.ac.createOscillator();
    osc.type = o.type ?? "sine";
    osc.frequency.setValueAtTime(Math.max(20, o.freq), t0);
    if (o.sweepTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.sweepTo), t0 + o.dur);
    }

    let tail: AudioNode = osc;
    if (o.filter !== undefined) {
      const biquad = g.ac.createBiquadFilter();
      biquad.type = "lowpass";
      biquad.frequency.value = o.filter;
      osc.connect(biquad);
      tail = biquad;
    }

    const amp = g.ac.createGain();
    envelope(amp.gain, t0, o.gain, Math.min(0.012, o.dur * 0.25), o.dur);
    tail.connect(amp);
    amp.connect(g.master);

    osc.start(t0);
    osc.stop(t0 + o.dur + 0.03);
    osc.onended = () => {
      try {
        osc.disconnect();
        amp.disconnect();
      } catch {
        /* already torn down */
      }
    };
  }

  /** Mechanical click (magazine out/in, dry trigger). */
  function click(g: AudioGraph, t0: number, gain: number, freq: number): void {
    noiseBurst(g, t0, {
      dur: 0.03,
      gain,
      filter: "bandpass",
      frequency: freq,
      q: 1.6,
      rate: 1.1,
    });
    tone(g, t0, {
      freq: freq * 0.6,
      sweepTo: freq * 0.3,
      dur: 0.035,
      gain: gain * 0.35,
      type: "square",
    });
  }

  /** Very quiet looping noise bed (wind). Ignored once already running. */
  function ambient(g: AudioGraph): void {
    if (ambientSource) return;
    const src = g.ac.createBufferSource();
    src.buffer = g.noise;
    src.loop = true;
    const low = g.ac.createBiquadFilter();
    low.type = "lowpass";
    low.frequency.value = 420;
    const amp = g.ac.createGain();
    amp.gain.value = AMBIENT_GAIN;
    src.connect(low);
    low.connect(amp);
    amp.connect(g.master);
    src.start(g.ac.currentTime);
    src.onended = () => {
      try {
        src.disconnect();
        low.disconnect();
        amp.disconnect();
      } catch {
        /* already torn down */
      }
    };
    ambientSource = src;
  }

  return {
    resume(): void {
      const g = ensureGraph();
      if (!g) return;
      if (g.ac.state !== "running") {
        void g.ac.resume().catch(() => {
          /* gesture not accepted yet; ready stays false */
        });
      }
    },

    play(name: string, gain = 1): void {
      const g = activeGraph();
      if (!g) return;
      const trim = Number.isFinite(gain)
        ? Math.min(MAX_CUE_GAIN, Math.max(0, gain))
        : 1;
      if (trim <= 0) return;
      // +1ms keeps scheduling strictly in the future across browsers.
      const t0 = g.ac.currentTime + 0.001;

      switch (name) {
        case "fire": {
          // Crack: bright noise shaped by a fast falling lowpass.
          noiseBurst(g, t0, {
            dur: 0.14,
            gain: 0.95 * trim,
            filter: "lowpass",
            frequency: 5200,
            sweepTo: 380,
            q: 0.9,
          });
          // Sub thump for weight.
          tone(g, t0, {
            freq: 150,
            sweepTo: 55,
            dur: 0.16,
            gain: 0.5 * trim,
            type: "sine",
          });
          // Mechanical tail.
          noiseBurst(g, t0 + 0.02, {
            dur: 0.09,
            gain: 0.18 * trim,
            filter: "highpass",
            frequency: 2600,
          });
          break;
        }
        case "dryfire": {
          click(g, t0, 0.5 * trim, 2100);
          break;
        }
        case "reload": {
          // Magazine out, then magazine seated.
          click(g, t0, 0.45 * trim, 1500);
          click(g, t0 + 0.17, 0.4 * trim, 1050);
          break;
        }
        case "hit": {
          noiseBurst(g, t0, {
            dur: 0.07,
            gain: 0.4 * trim,
            filter: "lowpass",
            frequency: 1200,
            sweepTo: 300,
          });
          tone(g, t0, {
            freq: 210,
            sweepTo: 90,
            dur: 0.09,
            gain: 0.3 * trim,
            type: "triangle",
          });
          break;
        }
        case "death": {
          tone(g, t0, {
            freq: 340,
            sweepTo: 60,
            dur: 0.65,
            gain: 0.35 * trim,
            type: "sawtooth",
            filter: 1400,
          });
          tone(g, t0 + 0.02, {
            freq: 170,
            sweepTo: 45,
            dur: 0.7,
            gain: 0.22 * trim,
            type: "square",
            filter: 700,
          });
          break;
        }
        case "playerhit": {
          tone(g, t0, {
            freq: 110,
            sweepTo: 48,
            dur: 0.3,
            gain: 0.5 * trim,
            type: "sine",
          });
          noiseBurst(g, t0, {
            dur: 0.12,
            gain: 0.25 * trim,
            filter: "lowpass",
            frequency: 700,
            sweepTo: 180,
          });
          break;
        }
        case "objective": {
          tone(g, t0, { freq: 660, dur: 0.13, gain: 0.3 * trim, type: "sine" });
          tone(g, t0 + 0.13, { freq: 990, dur: 0.2, gain: 0.3 * trim, type: "sine" });
          break;
        }
        case "complete": {
          const arpeggio = [523.25, 659.25, 783.99, 1046.5];
          for (let i = 0; i < arpeggio.length; i++) {
            tone(g, t0 + i * 0.11, {
              freq: arpeggio[i],
              dur: i === arpeggio.length - 1 ? 0.45 : 0.2,
              gain: 0.28 * trim,
              type: "triangle",
            });
          }
          break;
        }
        case "footstep": {
          noiseBurst(g, t0, {
            dur: 0.05,
            gain: 0.16 * trim,
            filter: "lowpass",
            frequency: 900,
            sweepTo: 260,
            rate: 1.2,
          });
          break;
        }
        case "ambient": {
          ambient(g);
          break;
        }
        default:
          // Unknown cue names are ignored rather than faked.
          break;
      }
    },

    setMasterVolume(volume: number): void {
      masterVolume = clamp01(volume, DEFAULT_MASTER_VOLUME);
      // Applied lazily too, so call order against resume() does not matter.
      const g = graph;
      if (!g) return;
      const t = g.ac.currentTime;
      g.master.gain.cancelScheduledValues(t);
      g.master.gain.setTargetAtTime(masterVolume, t, 0.02);
    },

    get ready(): boolean {
      return graph !== null && graph.ac.state === "running";
    },
  };
}


