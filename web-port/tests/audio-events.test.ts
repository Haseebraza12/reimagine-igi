/**
 * Event -> sound rules (engine/audio/sound-events.ts) and the level sound
 * tasks (engine/audio/ambience.ts), checked against docs/audio.md §4-5 with a
 * scripted RNG: weapon loop + tail, 50/50 single shots, impact / ricochet
 * limiters, footstep sequence / pitch / quiet volume, speech gates and the
 * rand(n)-without-+1 death quirk, the detected cooldown, 2D status / pickup
 * sounds, animation triggers, falls, AmbientArea delays / pick / fade and
 * ConditionalSound edges.
 */
import { describe, expect, it } from "vitest";
import { FOOTSTEP_SEQUENCE, ambientPick, roundHalfEven, type IgiTask, type LevelWeapon, type MaterialSounds, type SoundDefinition, type SoundEntry, type VoiceState } from "../src/loaders";
import { EventBus, GameEvent } from "../src/engine/events";
import { createAudioData, SampleRegistry, type IgiAudioData, type IgiSample } from "../src/engine/audio/igi-audio";
import type { AudioListener, BackendVoice, VoiceBackend } from "../src/engine/audio/mixer";
import { createIgiAudio, type IgiAudioSystem } from "../src/engine/audio/igi-audio-system";
import { AUDIO_EVENTS, type AudioHostContext } from "../src/engine/audio/sound-events";
import { engineToIgiPoint } from "../src/engine/audio/ambience";
import type { TaskRuntimeApi } from "../src/engine/context";
import type { Vec3 } from "../src/contracts";

// ---------------------------------------------------------------- fixtures

interface Rec {
  sample: string;
  loop: boolean;
  offset: number;
  state: VoiceState;
  stopped: boolean;
  ended: boolean;
  tick: number;
}

class FakeBackend implements VoiceBackend {
  ready = true;
  tick = 0;
  readonly recs: Rec[] = [];
  start(sample: IgiSample, loop: boolean, offset: number, state: VoiceState): BackendVoice {
    const r: Rec = { sample: sample.key, loop, offset, state, stopped: false, ended: false, tick: this.tick };
    this.recs.push(r);
    return { id: this.recs.length, ...r, rec: r } as unknown as BackendVoice;
  }
  private rec(v: BackendVoice): Rec {
    return (v as unknown as { rec: Rec }).rec;
  }
  update(v: BackendVoice, state: VoiceState): void {
    this.rec(v).state = state;
  }
  stop(v: BackendVoice): void {
    this.rec(v).stopped = true;
  }
  isPlaying(v: BackendVoice): boolean {
    const r = this.rec(v);
    return !r.stopped && !r.ended;
  }
  live(): Rec[] {
    return this.recs.filter((r) => !r.stopped && !r.ended);
  }
  started(key: string): Rec[] {
    return this.recs.filter((r) => r.sample === key.toUpperCase());
  }
}

function sample(key: string, seconds: number, streamed = false): IgiSample {
  const frames = Math.max(1, Math.round(seconds * 22050));
  return {
    key: key.toUpperCase(),
    path: `${key}.wav`,
    origin: "common",
    format: streamed ? 2 : 1,
    streamed,
    sampleRate: 22050,
    channels: 1,
    frames,
    duration: frames / 22050,
    data: [new Float32Array(frames)],
  };
}

function def(name: string, extra: Partial<SoundDefinition> = {}): SoundDefinition {
  return {
    kind: "sound",
    origin: "common",
    group: "",
    name,
    sample: name.toUpperCase(),
    offset: [0, 0, 0],
    volume: 1,
    minDistance: 0,
    maxDistance: 65,
    volumeVar: -1,
    pitchVar: -1,
    sampleVar: -1,
    loop: false,
    positional: true,
    ...extra,
  };
}

const ONE_SHOTS = [
  "mp5sd_loop_e", "glock_shot_1", "glock_shot_2", "guns_dry_1", "riccochet_1", "riccochet_2", "riccochet_3", "riccochet_4",
  "bul_concrete_1", "bul_concrete_2", "gunshotmiss", "player_hit_1", "player_hit_2", "player_hit_3", "player_hit_4", "player_xplhit_1",
  "player_death_1", "player_death_2", "player_death_3", "player_death_4", "ai_hit_1", "ai_hit_2", "ai_hit_3", "ai_death_1",
  "ai_death_2", "ai_death_3", "ai_death_4", "detected_01", "detected_02", "detected_03", "detected_04", "detected_05", "detected_06",
  "message", "weaponpickup_1", "pickup", "mp5_reload_1", "jump_1", "player_fall_1", "player_fall_2", "player_fall_3",
  "land_ground_4", "dog_01", "dog_02", "m1_heliby02", "_cut01_01",
  ...[1, 2, 3, 4, 5, 6].map((i) => `walk_gravel_${i}`),
];
const LOOPS = ["mp5sd_loop", "m1_music", "alarm_1", "m1_heligen01"];

const GRAVEL: MaterialSounds = {
  name: "Gravel",
  noiseRadius: 10,
  walk: [1, 2, 3, 4, 5, 6].map((i) => `walk_gravel_${i}`),
  land: "land_ground_4",
  rain: "rain_1",
  impact: ["bul_concrete_1", "bul_concrete_2", "bul_concrete_1", "", "", ""],
};

function audioData(extraEntries: SoundEntry[] = []): IgiAudioData {
  const reg = new SampleRegistry();
  for (const n of ONE_SHOTS) reg.add(sample(n, n === "_cut01_01" ? 2 : 0.2, n === "_cut01_01"));
  for (const n of LOOPS) reg.add(sample(n, 3, n === "m1_music"));
  const entries: SoundEntry[] = [
    ...ONE_SHOTS.filter((n) => n !== "_cut01_01").map((n) => def(n, n === "message" ? { volume: 0.7, maxDistance: 200 } : {})),
    def("mp5sd_loop", { loop: true }),
    def("m1_music", { loop: true, volume: 0.5, maxDistance: 200 }),
    def("alarmsystem_working", { sample: "ALARM_1", loop: true, minDistance: 40, maxDistance: 80 }),
    def("m1_heligen01", { loop: true, volume: 0.5, maxDistance: 1000 }),
    ...extraEntries,
  ];
  return createAudioData({
    samples: reg,
    definitions: entries,
    materials: [GRAVEL],
    animTriggers: [{ id: 1006, sound: "mp5_reload_1", attach: true }, { id: 1025, sound: "walk_gravel_1", attach: false }],
  });
}

function weapon(scriptId: string, burst: number, fire: string, end: string, rpm = 700): LevelWeapon {
  return { scriptId, name: scriptId, maxRoundsPerBurst: burst, fireSound: fire, fireSoundEnd: end, roundsPerMinute: rpm } as unknown as LevelWeapon;
}

/** Scripted RNG: returns the queued values, then `fallback`. */
function scripted(initial = 0) {
  const queue: number[] = [];
  const state = { fallback: initial };
  const fn = () => (queue.length ? queue.shift()! : state.fallback);
  return Object.defineProperties(Object.assign(fn, { push: (...v: number[]) => queue.push(...v) }), {
    fallback: {
      get: () => state.fallback,
      set: (v: number) => {
        state.fallback = v;
      },
    },
  }) as (() => number) & { push(...v: number[]): number; fallback: number };
}

interface Harness {
  audio: IgiAudioSystem;
  backend: FakeBackend;
  events: EventBus;
  host: AudioHostContext;
  rng: ReturnType<typeof scripted>;
  tick(n?: number, listener?: AudioListener): void;
}

function harness(options: { tasks?: IgiTask[]; runtime?: TaskRuntimeApi | null; entries?: SoundEntry[] } = {}): Harness {
  const events = new EventBus();
  const weapons = new Map<string, LevelWeapon>([
    ["WEAPON_ID_MP5SD", weapon("WEAPON_ID_MP5SD", 32, "mp5sd_loop", "mp5sd_loop_e")],
    ["WEAPON_ID_GLOCK", weapon("WEAPON_ID_GLOCK", 1, "glock_shot_1", "glock_shot_2", 400)],
  ]);
  const host: AudioHostContext = {
    events,
    player: { position: [0, 0, 0], maxHealth: 100 },
    enemies: [{ id: 7, position: [20, 0, 0], weapon: weapons.get("WEAPON_ID_MP5SD")! }],
    weapon: { spec: weapons.get("WEAPON_ID_GLOCK")! },
    level: { weapons, tasks: options.tasks ?? [], originIgi: [0, 0, 0] },
    systems: { tasks: options.runtime ?? null },
  };
  const rng = scripted(0);
  const backend = new FakeBackend();
  const audio = createIgiAudio(host, { random: rng });
  audio.setData(audioData(options.entries));
  audio.mixer.setBackend(backend);
  const h: Harness = {
    audio,
    backend,
    events,
    host,
    rng,
    tick(n = 1, listener = { position: [0, 1.7, 0], right: [1, 0, 0], forward: [0, 0, -1], up: [0, 1, 0] }) {
      for (let i = 0; i < n; i++) {
        backend.tick++;
        audio.tick(listener);
      }
    },
  };
  return h;
}

// ---------------------------------------------------------------- weapons

describe("audio events: weapons", () => {
  it("keeps one loop at the gun while an automatic weapon fires, then kills it and plays the loop end", () => {
    const h = harness();
    for (let i = 0; i < 4; i++) {
      h.events.emit(GameEvent.Fire, { weaponId: "WEAPON_ID_MP5SD", shooter: "player", position: [0, 1.5, -0.5] });
      h.tick(2);
    }
    expect(h.backend.started("mp5sd_loop")).toHaveLength(1);
    expect(h.backend.started("mp5sd_loop")[0].loop).toBe(true);
    expect(h.audio.events.activeGunLoops).toBe(1);
    h.events.emit(GameEvent.FireStopped, { weaponId: "WEAPON_ID_MP5SD", shooter: "player", position: [0, 1.5, -0.5] });
    h.tick();
    expect(h.backend.started("mp5sd_loop")[0].stopped).toBe(true);
    expect(h.backend.started("mp5sd_loop_e")).toHaveLength(1);
    expect(h.audio.events.activeGunLoops).toBe(0);
  });

  it("picks Fire Sound or Loop End 50/50 on the RNG low bit for single-shot weapons", () => {
    const h = harness();
    // floor(r * 0x7fffffff) & 1: 1 -> fire sound (glock_shot_1), 0 -> loop-end field (glock_shot_2).
    h.rng.push(1 / 0x7fffffff + 1e-12, 2 / 0x7fffffff + 1e-12, 3 / 0x7fffffff + 1e-12);
    for (let i = 0; i < 3; i++) h.events.emit(GameEvent.Fire, { weaponId: "WEAPON_ID_GLOCK", shooter: "player", position: [0, 1.5, 0] });
    h.tick();
    expect(h.backend.recs.map((r) => r.sample)).toEqual(["GLOCK_SHOT_1", "GLOCK_SHOT_2", "GLOCK_SHOT_1"]);
  });

  it("uses the same rules for AI guns and closes an unterminated AI loop (watchdog)", () => {
    const h = harness();
    h.events.emit(GameEvent.Fire, { weaponId: "WEAPON_ID_MP5SD", shooter: 7, position: [20, 1.5, 0] });
    h.tick();
    expect(h.backend.started("mp5sd_loop")).toHaveLength(1);
    h.tick(10); // 700 rpm -> 3 ticks per round; nothing for > 6 ticks
    expect(h.backend.started("mp5sd_loop")[0].stopped).toBe(true);
    expect(h.backend.started("mp5sd_loop_e")).toHaveLength(1);
  });

  it("plays guns_dry_1 on dry fire", () => {
    const h = harness();
    h.events.emit(GameEvent.DryFire);
    h.tick();
    expect(h.backend.started("guns_dry_1")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- impacts

describe("audio events: impacts and near misses", () => {
  it("limits impacts globally to now - last > 6 + rand(6) and ricochets with their own limiter", () => {
    const h = harness();
    const fired: number[] = [];
    for (let t = 1; t <= 20; t++) {
      const before = h.backend.started("bul_concrete_1").length;
      h.events.emit(GameEvent.Impact, { point: [5, 0, 0], normal: [0, 1, 0], material: "Gravel", shooter: "player" });
      h.tick();
      if (h.backend.started("bul_concrete_1").length > before) fired.push(t);
    }
    // RNG 0: impact[0] = bul_concrete_1, limit 6 -> plays when now - last > 6.
    // The first event arrives at audio tick 0, so plays land on 0, 7, 14 (+1 for the loop's numbering).
    expect(fired).toEqual([1, 8, 15]);
    expect(h.backend.started("riccochet_1")).toHaveLength(3);
  });

  it("plays gunshotmiss at most when now > next, next = now + 5", () => {
    const h = harness();
    let count = 0;
    for (let t = 1; t <= 12; t++) {
      h.tick();
      h.events.emit(AUDIO_EVENTS.NearMiss, { point: [1, 1, 0] });
      count = h.backend.started("gunshotmiss").length;
    }
    h.tick();
    // now 1 > 0 plays (next 6); 7 > 6 plays (next 12); 12 > 12 does not.
    expect(count).toBe(2);
  });
});

// ---------------------------------------------------------------- movement

describe("audio events: footsteps, landing, jump, animation triggers", () => {
  it("walks the 12-step sequence with pitch 0.8 + 0.5 rand and x0.66 when quiet", () => {
    const h = harness();
    h.rng.fallback = 0.5;
    const names: string[] = [];
    for (let i = 0; i < 13; i++) {
      h.events.emit(GameEvent.Footstep, { actor: "player", position: [0, 0, 0], material: "Gravel", quiet: i === 12 });
      h.tick();
      names.push(h.backend.recs[h.backend.recs.length - 1].sample);
    }
    const expected = [...FOOTSTEP_SEQUENCE, FOOTSTEP_SEQUENCE[0]].map((s) => `WALK_GRAVEL_${s + 1}`);
    expect(names).toEqual(expected);
    const last = h.backend.recs[h.backend.recs.length - 1].state;
    expect(last.frequency).toBe(roundHalfEven(22050 * (0.5 * 0.5 + 1 - 0.2)));
    const inst = h.audio.mixer.liveInstances.find((i) => i.name === "walk_gravel_1" && i.runtimeVolume !== 1);
    expect(inst?.runtimeVolume).toBe(0.66);
  });

  it("advances the footstep index even without a material", () => {
    const h = harness();
    h.events.emit(GameEvent.Footstep, { actor: "player", position: [0, 0, 0], material: null, quiet: false });
    h.events.emit(GameEvent.Footstep, { actor: "player", position: [0, 0, 0], material: "Gravel", quiet: false });
    h.tick();
    expect(h.backend.recs.map((r) => r.sample)).toEqual([`WALK_GRAVEL_${FOOTSTEP_SEQUENCE[1] + 1}`]);
  });

  it("is silent without a material unless a fallback material is configured", () => {
    const h = harness();
    h.events.emit(GameEvent.Footstep, { actor: "player", position: [0, 0, 0], material: null, quiet: false });
    h.tick();
    expect(h.backend.recs).toHaveLength(0);
    h.audio.events.fallbackMaterial = "Gravel";
    h.events.emit(GameEvent.Footstep, { actor: "player", position: [0, 0, 0], material: null, quiet: false });
    h.tick();
    expect(h.backend.recs.map((r) => r.sample)).toEqual([`WALK_GRAVEL_${FOOTSTEP_SEQUENCE[1] + 1}`]);
  });

  it("plays player_fall_N by damage fraction and the material land sound", () => {
    const h = harness();
    h.events.emit(GameEvent.Land, { actor: "player", position: [0, 0, 0], material: "Gravel", damaged: true, damageFraction: 0.15 });
    h.events.emit(GameEvent.Land, { actor: "player", position: [0, 0, 0], material: "Gravel", damaged: true, damage: 25 });
    h.events.emit(GameEvent.Land, { actor: 7, position: [20, 0, 0], material: "Gravel", damaged: true, damageFraction: 0.5 });
    h.tick();
    expect(h.backend.recs.map((r) => r.sample).sort()).toEqual(["LAND_GROUND_4", "LAND_GROUND_4", "LAND_GROUND_4", "PLAYER_FALL_2", "PLAYER_FALL_3"]);
  });

  it("plays jump_1 and animation trigger sounds (attach = child of the actor)", () => {
    const h = harness();
    h.events.emit(AUDIO_EVENTS.Jump, { actor: "player" });
    h.events.emit(GameEvent.AnimTrigger, { actor: "player", trigger: 1006, position: [0, 1, 0] });
    h.events.emit(GameEvent.AnimTrigger, { actor: "player", trigger: 1010, position: [0, 1, 0] }); // footstep id: not in animtrigger.qvm
    h.tick();
    expect(h.backend.recs.map((r) => r.sample)).toEqual(["JUMP_1", "MP5_RELOAD_1"]);
    const reload = h.audio.mixer.liveInstances.find((i) => i.name === "mp5_reload_1")!;
    expect(reload.parent).not.toBeNull();
    h.host.player.position = [3, 0, 0];
    h.tick();
    expect(reload.world).toEqual([3, 1, 0]);
  });
});

// ---------------------------------------------------------------- speech

describe("audio events: speech gates and quirks", () => {
  it("gates hit speech per character for 30 + round(30 rand) ticks", () => {
    const h = harness();
    h.rng.fallback = 0.5; // gate 30 - round(-15) = 45; name rand(4)+1 = 3
    const played: number[] = [];
    for (let t = 0; t < 100; t++) {
      const before = h.backend.recs.length;
      h.events.emit(GameEvent.PlayerHit, { amount: 5 });
      h.tick();
      if (h.backend.recs.length > before) played.push(t);
    }
    expect(played).toEqual([0, 45, 90]);
    expect(new Set(h.backend.recs.map((r) => r.sample))).toEqual(new Set(["PLAYER_HIT_3"]));
  });

  it("does not stop the previous hit line (the 0x4624bf handle bug)", () => {
    const h = harness();
    h.rng.fallback = 0; // gate 30
    h.events.emit(GameEvent.PlayerHit, {});
    h.tick(31);
    h.events.emit(GameEvent.PlayerHit, {});
    h.tick();
    expect(h.backend.recs.filter((r) => r.sample === "PLAYER_HIT_1").every((r) => !r.stopped)).toBe(true);
  });

  it("uses rand(n) without +1 for death speech, so index 0 is silent", () => {
    const h = harness();
    // The player's death speech plays on state 47's enter (FUN_0040e660), not on the damage.
    h.rng.push(0); // player_death_0: no definition
    h.events.emit("game:player-death-state", { clip: 201 });
    h.rng.push(0.99); // ai_death_3
    h.events.emit(GameEvent.EnemyKilled, { enemyId: 7, taskId: 1 });
    h.rng.push(0.5); // player_death_1
    h.events.emit("game:player-death-state", { clip: 202 });
    h.tick();
    expect(h.backend.recs.map((r) => r.sample)).toEqual(["AI_DEATH_3", "PLAYER_DEATH_1"]);
  });

  it("gates AI hit speech per soldier and picks ai_hit_{rand(3)+1}", () => {
    const h = harness();
    h.rng.fallback = 0;
    h.events.emit(GameEvent.EnemyHit, { enemyId: 7, position: [20, 0, 0], damage: 0.2, explosion: false });
    h.events.emit(GameEvent.EnemyHit, { enemyId: 7, position: [20, 0, 0], damage: 0.2, explosion: false });
    h.tick();
    expect(h.backend.recs.map((r) => r.sample)).toEqual(["AI_HIT_1"]);
  });

  it("plays a detected sting only when more than 90 ticks passed since the last one", () => {
    const h = harness();
    const at: number[] = [];
    for (let t = 0; t < 200; t++) {
      const before = h.backend.recs.length;
      h.events.emit(GameEvent.Detected, { enemyId: 7, position: [20, 0, 0] });
      h.tick();
      if (h.backend.recs.length > before) at.push(t);
    }
    expect(at).toEqual([0, 91, 182]);
    expect(h.backend.recs[0].sample).toBe("DETECTED_01");
  });
});

// ---------------------------------------------------------------- 2D

describe("audio events: 2D sounds", () => {
  it("plays the StatusMessage sound 2D at volume 1 (the definition's 0.7 ignored)", () => {
    const h = harness();
    h.events.emit(GameEvent.StatusMessage, { text: "x", sprite: null, sound: "message", durationSeconds: 2, cutscene: false });
    h.events.emit(GameEvent.StatusMessage, { text: "y", sprite: null, sound: null, durationSeconds: 2, cutscene: false });
    expect(h.backend.recs).toHaveLength(1);
    expect(h.backend.recs[0].state.gainLeft).toBe(1);
    expect(h.backend.recs[0].state.gainRight).toBe(1);
  });

  it("plays weaponpickup_1 for gun and ammo pickups and pickup for other items", () => {
    // FUN_0045ec30 (0x45ecc7) and FUN_0045ebf0 (0x45ec19) push weaponpickup_1; FUN_0046af40 pushes pickup.
    const h = harness();
    h.events.emit(GameEvent.Pickup, { kind: "weapon", name: "AK47" });
    h.events.emit(GameEvent.Pickup, { kind: "ammo", name: "AMMO_ID_919" });
    h.events.emit(GameEvent.Pickup, { kind: "object", name: "medipack" });
    expect(h.backend.recs.map((r) => r.sample)).toEqual(["WEAPONPICKUP_1", "WEAPONPICKUP_1", "PICKUP"]);
  });

  it("plays no synthesized cue for names without a definition", () => {
    const h = harness();
    h.audio.play("fire");
    h.audio.play("objective");
    h.tick();
    expect(h.backend.recs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- ambience

function task(id: number, type: string, name: string, params: Record<string, unknown>, children: IgiTask[] = []): IgiTask {
  return { id, type, name, params: params as IgiTask["params"], children };
}

describe("audio ambience: AmbientArea (FUN_0044b1b0)", () => {
  const area = (soundDef: string, minDelay: number, randomWait: number, size: Vec3 = [500, 500, 150]) =>
    task(-1, "AmbientArea", "area", { Position: [0, 0, 0], Orientation: [0, 0, 0], Size: size, "Min Delay": minDelay, "Random wait": randomWait, SoundDef: soundDef });

  it("starts a loop at the listener with volume = fade, fading 0.05 per tick", () => {
    const h = harness({ tasks: [area("m1_music", 0, 0)] });
    h.tick();
    const inst = h.audio.mixer.liveInstances.find((i) => i.name === "m1_music")!;
    expect(inst.runtimeVolume).toBeCloseTo(0.05, 12);
    h.tick(19);
    expect(inst.runtimeVolume).toBe(1);
    expect(inst.world).toEqual([0, 1.7, 0]);
    const live = h.backend.live().find((r) => r.sample === "M1_MUSIC")!;
    expect(live.state.volume).toBeCloseTo(0.5, 6);
    expect(live.state.pan).toBe(0);
  });

  it("fades out when the listener leaves and kills the instance at fade 0", () => {
    const h = harness({ tasks: [area("m1_music", 0, 0, [10, 10, 10])] });
    h.tick(20);
    const far: AudioListener = { position: [50, 0, 0], right: [1, 0, 0], forward: [0, 0, -1], up: [0, 1, 0] };
    h.tick(19, far);
    const inst = h.audio.mixer.liveInstances.find((i) => i.name === "m1_music");
    expect(inst?.runtimeVolume).toBeCloseTo(0.05, 9);
    h.tick(2, far);
    expect(h.audio.mixer.liveInstances.find((i) => i.name === "m1_music")).toBeUndefined();
  });

  it("waits round((rand * Random wait + Min Delay) * 30) ticks after a one-shot ends", () => {
    const h = harness({ tasks: [area("dog_01 dog_02", 25, 25)] });
    h.rng.fallback = 0.2; // pick round(0.4) = 0 -> dog_01; delay round((5 + 25) * 30) = 900
    const starts: number[] = [];
    for (let t = 0; t < 2000; t++) {
      const before = h.backend.recs.length;
      h.tick();
      for (const r of h.backend.live()) if (t - r.tick >= 6) r.ended = true; // 0.2 s sample
      if (h.backend.recs.length > before) starts.push(t);
    }
    expect(h.backend.recs.every((r) => r.sample === "DOG_01")).toBe(true);
    expect(starts[0]).toBe(0);
    const gap = starts[1] - starts[0];
    // one-shot lifetime (7 ticks) + end detection, then 900 ticks of delay.
    expect(gap).toBeGreaterThanOrEqual(900);
    expect(gap).toBeLessThanOrEqual(912);
    expect(starts[2] - starts[1]).toBe(gap);
  });

  it("picks trunc(rand * n) (chop-mode fistp, 0x44b3c5): every name equally likely, never the empty slot", () => {
    expect(ambientPick(0.1, 2)).toBe(0);
    expect(ambientPick(0.5, 2)).toBe(1);
    expect(ambientPick(0.8, 2)).toBe(1);
    expect(ambientPick(65535 / 65536, 3)).toBe(2);
    const h = harness({ tasks: [area("dog_01 dog_02", 0, 0)] });
    h.rng.push(0.9); // index 1 = dog_02 (rounding would have picked the empty slot 2)
    h.tick();
    expect(h.backend.recs.map((r) => r.sample)).toEqual(["DOG_02"]);
  });

  it("converts engine positions back to IGI units for the inside test", () => {
    const origin: Vec3 = [24532436, -56171048, 174413120];
    expect(engineToIgiPoint([1, 2, -3], origin)).toEqual([origin[0] + 4096, origin[1] + 3 * 4096, origin[2] + 2 * 4096]);
  });
});

describe("audio ambience: ConditionalSound (FUN_004246a0)", () => {
  function runtime(values: Record<string, number>): TaskRuntimeApi {
    return { member: () => undefined, condition: (expr) => values[expr] ?? 0 };
  }

  it("starts on the rising edge, stops when false, positional at Position unless relative to microphone", () => {
    const values: Record<string, number> = { alarm: 0, heli: 1 };
    const tasks = [
      task(96, "ConditionalSound", "", { Condition: "alarm", SoundDef: "alarmsystem_working", Simple: false, OneShot: false, "Relative to microphone": false, Position: [40 * 4096, 0, 0] }),
      task(3000, "ConditionalSound", "heli gen 01", { Condition: "heli", SoundDef: "m1_heligen01", Simple: false, OneShot: false, "Relative to microphone": true, Position: [0, 0, 0] }),
    ];
    const h = harness({ tasks, runtime: runtime(values) });
    h.tick();
    expect(h.backend.live().map((r) => r.sample)).toEqual(["M1_HELIGEN01"]);
    expect(h.audio.mixer.liveInstances.find((i) => i.name === "m1_heligen01")!.positional).toBe(false);
    values.alarm = 1;
    h.tick();
    const alarm = h.audio.mixer.liveInstances.find((i) => i.name === "alarmsystem_working")!;
    expect(alarm.positional).toBe(true);
    expect(alarm.world.map((v) => v + 0)).toEqual([40, 0, 0]);
    values.heli = 0;
    h.tick(2);
    expect(h.backend.live().map((r) => r.sample)).toEqual(["ALARM_1"]);
  });

  it("plays a Simple OneShot raw sample 2D at volume 1 inside its container, and stops it when the container ends", () => {
    const values: Record<string, number> = { intro: 1, "1": 1 };
    const voiceOver = task(3998, "ConditionalSound", "Cutscene voiceover", { Condition: "1", SoundDef: "_cut01_01", Simple: true, OneShot: true, "Relative to microphone": false, Position: [0, 0, 0] });
    const container = task(4001, "ConditionalContainer", "Intro cutscene", { Condition: "intro" }, [voiceOver]);
    const h = harness({ tasks: [container, voiceOver], runtime: runtime(values) });
    h.tick(3);
    const vo = h.backend.started("_cut01_01");
    expect(vo).toHaveLength(1);
    expect(vo[0].state.gainLeft).toBe(1);
    expect(vo[0].state.gainRight).toBe(1);
    expect(vo[0].loop).toBe(false);
    values.intro = 0; // container off: the task is not ticked, its voice is not refreshed
    h.tick();
    expect(vo[0].stopped).toBe(true);
    values.intro = 1; // OneShot: never again
    h.tick(5);
    expect(h.backend.started("_cut01_01")).toHaveLength(1);
  });

  it("does nothing without a task runtime", () => {
    const tasks = [task(3000, "ConditionalSound", "", { Condition: "1", SoundDef: "m1_heligen01", Simple: false, OneShot: false, "Relative to microphone": true, Position: [0, 0, 0] })];
    const h = harness({ tasks, runtime: null });
    h.tick(5);
    expect(h.backend.recs).toHaveLength(0);
  });

  it("treats a condition as true by the low byte of its rounded value", () => {
    expect(roundHalfEven(256.4) & 0xff).toBe(0);
  });
});
