/**
 * Software 3D mixer (engine/audio/mixer.ts) against the recovered rules in
 * docs/audio.md §2-3: per-tick voice parameters equal computeVoice, voices
 * beyond maxDistance stop and restart (loops / streamed from 0, in-memory
 * one-shots at the elapsed time), one-shot lifetime, the 32-voice drop rule,
 * fire-and-forget 2D voices, owner gating and parent variables.
 */
import { describe, expect, it } from "vitest";
import { IGI_AUDIO, computeVoice, graphCurve, type SoundDefinition, type SoundEntry, type VoiceState } from "../src/loaders/audio";
import { SampleRegistry, SoundBank, type IgiSample } from "../src/engine/audio/igi-audio";
import { SoundMixer, TICK_SECONDS, type AudioListener, type BackendVoice, type VoiceBackend } from "../src/engine/audio/mixer";

interface Rec {
  id: number;
  sample: string;
  loop: boolean;
  offset: number;
  state: VoiceState;
  stopped: boolean;
  ended: boolean;
  updates: number;
}

class FakeBackend implements VoiceBackend {
  ready = true;
  readonly recs: Rec[] = [];
  start(sample: IgiSample, loop: boolean, offsetSeconds: number, state: VoiceState): BackendVoice {
    const rec: Rec = { id: this.recs.length + 1, sample: sample.key, loop, offset: offsetSeconds, state, stopped: false, ended: false, updates: 0 };
    this.recs.push(rec);
    return rec;
  }
  update(voice: BackendVoice, state: VoiceState): void {
    const r = voice as Rec;
    r.state = state;
    r.updates++;
  }
  stop(voice: BackendVoice): void {
    (voice as Rec).stopped = true;
  }
  isPlaying(voice: BackendVoice): boolean {
    const r = voice as Rec;
    return !r.stopped && !r.ended;
  }
  live(): Rec[] {
    return this.recs.filter((r) => !r.stopped && !r.ended);
  }
}

function sample(key: string, seconds: number, extra: Partial<IgiSample> = {}): IgiSample {
  const sampleRate = extra.sampleRate ?? 22050;
  const frames = Math.round(seconds * sampleRate);
  const channels = extra.channels ?? 1;
  return {
    key: key.toUpperCase(),
    path: `${key}.wav`,
    origin: "common",
    format: 1,
    streamed: false,
    sampleRate,
    channels,
    frames,
    duration: frames / sampleRate,
    data: Array.from({ length: channels }, () => new Float32Array(frames)),
    ...extra,
  };
}

function def(name: string, sampleKey: string, extra: Partial<SoundDefinition> = {}): SoundDefinition {
  return {
    kind: "sound",
    origin: "common",
    group: "",
    name,
    sample: sampleKey.toUpperCase(),
    offset: [0, 0, 0],
    volume: 1,
    minDistance: 0,
    maxDistance: 30,
    volumeVar: -1,
    pitchVar: -1,
    sampleVar: -1,
    loop: false,
    positional: true,
    ...extra,
  };
}

function setup(samples: IgiSample[], entries: SoundEntry[], maxVoices?: number) {
  const reg = new SampleRegistry();
  for (const s of samples) reg.add(s);
  const mixer = new SoundMixer(reg, new SoundBank(entries), { maxVoices });
  const backend = new FakeBackend();
  mixer.setBackend(backend);
  return { mixer, backend, reg };
}

const listenerAt = (x: number, y = 0, z = 0): AudioListener => ({
  position: [x, y, z],
  right: [1, 0, 0],
  forward: [0, 0, -1],
  up: [0, 1, 0],
});

const U = IGI_AUDIO.unitsPerMetre;

describe("audio mixer: per-tick voice parameters", () => {
  it("matches computeVoice every tick as the listener moves (linear fade, one-sided pan)", () => {
    const { mixer, backend } = setup([sample("hum", 5)], [def("hum", "hum", { loop: true, minDistance: 5, maxDistance: 65, volume: 0.8 })]);
    const h = mixer.spawn("hum", { position: [10, 0, 0] })!;
    expect(h).not.toBeNull();
    for (const lx of [0, 4, -20, 9]) {
      mixer.tick(listenerAt(lx));
      const expected = computeVoice({
        volume: 0.8,
        sampleRate: 22050,
        positional: true,
        source: [10 * U, 0, 0],
        listener: [lx * U, 0, 0],
        listenerRight: [1, 0, 0],
        minDistance: 5,
        maxDistance: 65,
      });
      const rec = backend.live()[0];
      expect(rec.state.gainLeft).toBeCloseTo(expected.gainLeft, 12);
      expect(rec.state.gainRight).toBeCloseTo(expected.gainRight, 12);
      expect(rec.state.playbackRate).toBe(expected.playbackRate);
    }
    // Source to the right: the left channel is the attenuated one.
    mixer.tick(listenerAt(-20));
    const r = backend.live()[0].state;
    expect(r.gainRight).toBeGreaterThan(r.gainLeft);
    expect(backend.recs.length).toBe(1);
  });

  it("stops a positional loop beyond maxDistance and restarts it from 0 when back in range", () => {
    const { mixer, backend } = setup([sample("hum", 5)], [def("hum", "hum", { loop: true, maxDistance: 25 })]);
    mixer.spawn("hum", { position: [0, 0, 0] });
    mixer.tick(listenerAt(10));
    expect(backend.live()).toHaveLength(1);
    mixer.tick(listenerAt(26));
    expect(backend.live()).toHaveLength(0);
    expect(mixer.liveInstances).toHaveLength(1);
    mixer.tick(listenerAt(24));
    expect(backend.live()).toHaveLength(1);
    expect(backend.recs[1].offset).toBe(0);
  });

  it("restarts an in-memory one-shot at its elapsed time and a streamed one from 0", () => {
    for (const streamed of [false, true]) {
      const { mixer, backend } = setup([sample("bang", 2, { streamed, format: streamed ? 2 : 1 })], [def("bang", "bang", { maxDistance: 25 })]);
      mixer.spawn("bang", { position: [0, 0, 0] });
      mixer.tick(listenerAt(1)); // starts at 0, elapsed -> 1/30
      expect(backend.recs[0].offset).toBe(0);
      for (let i = 0; i < 9; i++) mixer.tick(listenerAt(100)); // out of range, elapsed keeps counting
      expect(backend.live()).toHaveLength(0);
      mixer.tick(listenerAt(1));
      expect(backend.recs).toHaveLength(2);
      expect(backend.recs[1].offset).toBeCloseTo(streamed ? 0 : 10 * TICK_SECONDS, 9);
    }
  });

  it("ends a one-shot once elapsed reaches the sample length and its voice stopped", () => {
    const { mixer, backend } = setup([sample("click", 0.1)], [def("click", "click")]);
    mixer.spawn("click", { position: [0, 0, 0] });
    let ticks = 0;
    while (mixer.liveInstances.length > 0 && ticks < 20) {
      mixer.tick(listenerAt(0));
      ticks++;
      // The fake voice "plays" until 0.1 s of ticks have passed.
      if (ticks * TICK_SECONDS >= 0.1 - 1e-9) for (const r of backend.recs) r.ended = true;
    }
    // 0.1 s = 3 ticks of playback; housekeeping sees the end on tick 4, the
    // instance is destroyed on tick 5 and its voice was never restarted.
    expect(ticks).toBe(5);
    expect(backend.recs).toHaveLength(1);
  });

  it("drops the 33rd voice request (DAT_005c606c = 32)", () => {
    const { mixer, backend } = setup([sample("bang", 1)], [def("bang", "bang")]);
    for (let i = 0; i < 33; i++) mixer.spawn("bang", { position: [0, 0, 0] });
    mixer.tick(listenerAt(0));
    expect(backend.live()).toHaveLength(32);
    expect(mixer.stats.dropped).toBe(1);
    expect(mixer.stats.peakVoices).toBe(32);
  });

  it("frees ended raw (menu) voices without a game tick, so clicks never run out of voices", () => {
    const { mixer, backend, reg } = setup([sample("menu_high", 0.1)], []);
    for (let i = 0; i < 100; i++) {
      expect(mixer.playRaw("menu_high", 1, reg)).toBe(true);
      backend.recs[backend.recs.length - 1].ended = true;
      mixer.releaseFinished();
    }
    expect(mixer.voiceCount).toBe(0);
    expect(mixer.stats.dropped).toBe(0);
    // Instance voices (no refresh while the world stands still) are kept.
    const { mixer: m2, backend: b2 } = setup([sample("hum", 5)], [def("hum", "hum", { loop: true })]);
    m2.spawn("hum", { positional: false });
    m2.tick(listenerAt(0));
    m2.releaseFinished();
    m2.releaseFinished();
    expect(b2.live()).toHaveLength(1);
  });

  it("plays 2D-by-name at volume 1 regardless of the definition's volume and distances", () => {
    const { mixer, backend } = setup([sample("message", 0.3)], [def("message", "message", { volume: 0.7, maxDistance: 200 })]);
    expect(mixer.play2DByName("message")).toBe(true);
    expect(backend.recs[0].state.gainLeft).toBe(1);
    expect(backend.recs[0].state.gainRight).toBe(1);
    expect(backend.recs[0].state.dsVolume).toBe(0);
    // Fire-and-forget: survives housekeeping without refreshes until it ends.
    mixer.tick(listenerAt(1000));
    mixer.tick(listenerAt(1000));
    expect(backend.live()).toHaveLength(1);
    backend.recs[0].ended = true;
    mixer.tick(listenerAt(0));
    expect(mixer.voiceCount).toBe(0);
    // Groups, graphs and unknown names are not playable this way.
    expect(mixer.play2DByName("nope")).toBe(false);
  });

  it("stops voices of instances whose owner did not tick them", () => {
    const { mixer, backend } = setup([sample("hum", 5)], [def("hum", "hum", { loop: true })]);
    let active = true;
    mixer.spawn("hum", { owner: { active: () => active }, positional: false });
    mixer.tick(listenerAt(0));
    expect(backend.live()).toHaveLength(1);
    active = false;
    mixer.tick(listenerAt(0));
    expect(backend.live()).toHaveLength(0);
    active = true;
    mixer.tick(listenerAt(0));
    expect(backend.live()).toHaveLength(1);
  });

  it("drives volume and pitch from the parent's variables (train: var1 on/off, var0 pitch)", () => {
    const { mixer, backend } = setup(
      [sample("train_loop_1", 3)],
      [def("train_loop_1", "train_loop_1", { loop: true, volume: 0.7, minDistance: 5, maxDistance: 100, volumeVar: 1, pitchVar: 0 })],
    );
    let vars = [0.8, 0];
    mixer.spawn("train_loop_1", { parent: { position: () => [0, 0, 0], vars: () => vars } });
    mixer.tick(listenerAt(0));
    expect(backend.recs).toHaveLength(0); // volume 0: never started
    vars = [0.9, 1];
    mixer.tick(listenerAt(0));
    const r = backend.live()[0];
    expect(r.state.volume).toBeCloseTo(0.7, 6);
    expect(r.state.frequency).toBe(Math.round(22050 * 0.9));
  });

  it("applies DefineGraph curves to the parent variable (helicopter_1)", () => {
    const volumeCurve = [0, 0.35, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1, 1];
    const pitchCurve = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.05, 1.1, 1.15, 1.2, 1.25];
    const graph: SoundDefinition = {
      ...def("helicopter_1", "heli", { loop: true, volume: 0.5, minDistance: 10, maxDistance: 700, volumeVar: 0, pitchVar: 0 }),
      kind: "graph",
      volumeCurve,
      pitchCurve,
    };
    const { mixer, backend } = setup([sample("heli", 3)], [graph]);
    mixer.spawn("helicopter_1", { parent: { position: () => [0, 0, 0], vars: () => [0.33] } });
    mixer.tick(listenerAt(0));
    const s = backend.live()[0].state;
    expect(s.volume).toBeCloseTo(0.5 * graphCurve(volumeCurve, 0.33), 6);
    expect(s.frequency).toBe(Math.round(22050 * graphCurve(pitchCurve, 0.33)));
  });

  it("instances every member of a group and resolves duplicate names to the first definition", () => {
    const group: SoundEntry = { kind: "group", origin: "common", group: "", name: "pair", members: ["a", "b"] };
    const entries: SoundEntry[] = [
      group,
      def("a", "s", { group: "pair" }),
      def("b", "s", { group: "pair" }),
      def("dup", "s", { volume: 0.35 }),
      def("dup", "s", { volume: 0.9, origin: "mission" }),
    ];
    const { mixer } = setup([sample("s", 1)], entries);
    expect(mixer.spawn("pair")!.instances.map((i) => i.name)).toEqual(["a", "b"]);
    expect(mixer.spawn("dup")!.instances[0].def!.volume).toBe(0.35);
    expect(mixer.spawn("")).toBeNull();
  });
});
