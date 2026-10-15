/**
 * WebAudio voice backend for the software mixer (mixer.ts).
 *
 * Each voice is AudioBufferSourceNode -> GainNode(left) + GainNode(right) ->
 * ChannelMerger -> bus, with the per-tick gains and playbackRate computed by
 * computeVoice (the original's DSBVOLUME + one-sided DSBPAN and SetFrequency,
 * docs/audio.md §3). Mono sources feed both sides; stereo sources are split so
 * the pan attenuates only the opposite channel, as DirectSound does. No
 * PannerNode / HRTF: the original has no DirectSound3D.
 *
 * Output rate: the original mixes into a 22050 Hz primary buffer. The
 * context is created at 22050 Hz when the browser allows it; otherwise two
 * cascaded 11025 Hz low-pass biquads stand in for the lost band (port
 * approximation of the 22050 Hz mix).
 */
import type { VoiceState } from "../../loaders";
import { IGI_AUDIO } from "../../loaders";
import type { IgiSample } from "./igi-audio";
import type { BackendVoice, VoiceBackend } from "./mixer";

interface WebVoice extends BackendVoice {
  src: AudioBufferSourceNode;
  left: GainNode;
  right: GainNode;
  nodes: AudioNode[];
  loop: boolean;
  duration: number;
  /** Position in the sample (seconds) at `lastTime`, integrated from the playback rate. */
  position: number;
  lastTime: number;
  rate: number;
  gainLeft: number;
  gainRight: number;
  ended: boolean;
}

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const scope = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/** Create the game's AudioContext at the original's 22050 Hz output rate, falling back to the default rate. */
export function createIgiAudioContext(): AudioContext | null {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  try {
    return new Ctor({ sampleRate: IGI_AUDIO.outputSampleRate, latencyHint: "interactive" });
  } catch {
    try {
      return new Ctor({ latencyHint: "interactive" });
    } catch {
      return null;
    }
  }
}

export interface WebAudioBackendOptions {
  /** Node the mix goes to (default: context.destination). */
  destination?: AudioNode;
  /** Treat the context as always ready (OfflineAudioContext rendering). */
  alwaysReady?: boolean;
  /** Custom readiness (default: context running). */
  isReady?: () => boolean;
}

export class WebAudioBackend implements VoiceBackend {
  readonly bus: GainNode;
  private readonly buffers = new WeakMap<IgiSample, AudioBuffer>();
  private readonly tail: AudioNode[] = [];
  private seq = 0;
  private readonly live = new Set<WebVoice>();

  constructor(
    readonly context: BaseAudioContext,
    private readonly options: WebAudioBackendOptions = {},
  ) {
    this.bus = context.createGain();
    let out: AudioNode = this.bus;
    if (context.sampleRate > IGI_AUDIO.outputSampleRate) {
      for (let i = 0; i < 2; i++) {
        const lp = context.createBiquadFilter();
        lp.type = "lowpass";
        lp.frequency.value = IGI_AUDIO.outputSampleRate / 2;
        lp.Q.value = Math.SQRT1_2;
        out.connect(lp);
        this.tail.push(lp);
        out = lp;
      }
    }
    out.connect(options.destination ?? context.destination);
  }

  get ready(): boolean {
    if (this.options.alwaysReady === true) return true;
    if (this.options.isReady) return this.options.isReady();
    return this.context.state === "running";
  }

  /** Voices currently held by the backend. */
  get liveVoices(): number {
    return this.live.size;
  }

  /** Master gain (user volume; 1 = the original mix). */
  setMasterGain(gain: number): void {
    this.bus.gain.setValueAtTime(gain, this.context.currentTime);
  }

  private bufferOf(sample: IgiSample): AudioBuffer {
    if (sample.audioBuffer) return sample.audioBuffer;
    let buffer = this.buffers.get(sample);
    if (!buffer) {
      buffer = this.context.createBuffer(sample.channels, Math.max(1, sample.frames), sample.sampleRate);
      for (let c = 0; c < sample.channels; c++) buffer.getChannelData(c).set(sample.data[c].subarray(0, sample.frames));
      this.buffers.set(sample, buffer);
    }
    return buffer;
  }

  start(sample: IgiSample, loop: boolean, offsetSeconds: number, state: VoiceState): BackendVoice | null {
    if (sample.frames === 0) return null;
    const ac = this.context;
    const t = ac.currentTime;
    const src = ac.createBufferSource();
    src.buffer = this.bufferOf(sample);
    src.loop = loop;
    src.playbackRate.setValueAtTime(state.playbackRate, t);
    const left = ac.createGain();
    const right = ac.createGain();
    for (const g of [left, right]) {
      g.channelCount = 1;
      g.channelCountMode = "explicit";
    }
    left.gain.setValueAtTime(state.gainLeft, t);
    right.gain.setValueAtTime(state.gainRight, t);
    const merger = ac.createChannelMerger(2);
    const nodes: AudioNode[] = [src, left, right, merger];
    if (sample.channels === 2) {
      const split = ac.createChannelSplitter(2);
      src.connect(split);
      split.connect(left, 0);
      split.connect(right, 1);
      nodes.push(split);
    } else {
      src.connect(left);
      src.connect(right);
    }
    left.connect(merger, 0, 0);
    right.connect(merger, 0, 1);
    merger.connect(this.bus);
    const offset = Math.max(0, Math.min(offsetSeconds, sample.duration));
    const voice: WebVoice = {
      id: ++this.seq,
      src,
      left,
      right,
      nodes,
      loop,
      duration: sample.duration,
      position: offset,
      lastTime: t,
      rate: state.playbackRate,
      gainLeft: state.gainLeft,
      gainRight: state.gainRight,
      ended: false,
    };
    src.onended = () => {
      voice.ended = true;
      this.release(voice);
    };
    src.start(t, offset);
    this.live.add(voice);
    return voice;
  }

  private advance(v: WebVoice): void {
    const t = this.context.currentTime;
    v.position += (t - v.lastTime) * v.rate;
    v.lastTime = t;
  }

  update(voice: BackendVoice, state: VoiceState): void {
    const v = voice as WebVoice;
    if (v.ended) return;
    this.advance(v);
    const t = this.context.currentTime;
    // Step changes at the tick, like DirectSound SetVolume / SetPan / SetFrequency.
    if (state.playbackRate !== v.rate) {
      v.rate = state.playbackRate;
      v.src.playbackRate.setValueAtTime(state.playbackRate, t);
    }
    if (state.gainLeft !== v.gainLeft) {
      v.gainLeft = state.gainLeft;
      v.left.gain.setValueAtTime(state.gainLeft, t);
    }
    if (state.gainRight !== v.gainRight) {
      v.gainRight = state.gainRight;
      v.right.gain.setValueAtTime(state.gainRight, t);
    }
  }

  stop(voice: BackendVoice): void {
    const v = voice as WebVoice;
    if (!v.ended) {
      v.ended = true;
      try {
        v.src.stop(this.context.currentTime);
      } catch {
        /* never started or already stopped */
      }
    }
    this.release(v);
  }

  isPlaying(voice: BackendVoice): boolean {
    const v = voice as WebVoice;
    if (v.ended) return false;
    if (v.loop) return true;
    this.advance(v);
    return v.position < v.duration;
  }

  private release(v: WebVoice): void {
    if (!this.live.delete(v)) return;
    for (const n of v.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  }

  /** Disconnect everything (the context itself belongs to the caller). */
  dispose(): void {
    for (const v of [...this.live]) this.stop(v);
    this.bus.disconnect();
    for (const n of this.tail) n.disconnect();
  }
}
