/**
 * Audio registry and loader (engine/audio/igi-audio.ts): sample keys and
 * first-wins, definition lookup / groups, materials, animation triggers,
 * config volumes, and the level-1 sound tasks on the real files. Real-file
 * tests skip when the game files are not staged (npm run stage).
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { flattenTasks, readQvmCallTree, readTaskTree, type IgiTask } from "../src/loaders";
import { createFsAssetSource } from "../src/loaders/fs-source";
import { SampleRegistry, SoundBank, loadIgiAudio, type IgiAudioData, type IgiSample } from "../src/engine/audio/igi-audio";
import { AmbienceRuntime } from "../src/engine/audio/ambience";
import { SoundMixer, type AudioListener, type BackendVoice, type VoiceBackend } from "../src/engine/audio/mixer";
import { igiPointToEngine, type VoiceState } from "../src/loaders";
import type { Vec3 } from "../src/contracts";
import { RAW_ROOT, readRaw } from "./helpers";

const staged = existsSync(`${RAW_ROOT}/common/sounds/sounds.res`) && existsSync(`${RAW_ROOT}/missions/location0/level1/sounds/m1_music.wav`);

function fakeSample(key: string, path: string): IgiSample {
  return { key, path, origin: "common", format: 1, streamed: false, sampleRate: 22050, channels: 1, frames: 1, duration: 1 / 22050, data: [new Float32Array(1)] };
}

describe("audio registry rules", () => {
  it("keys samples by upper-cased base name and keeps the first file per key", () => {
    const reg = new SampleRegistry();
    expect(reg.add(fakeSample("JUMP_1", "LOCAL:common/sounds/jump_1.wav"))).toBe(true);
    expect(reg.add(fakeSample("JUMP_1", "missions/location0/level1/sounds/JUMP_1.wav"))).toBe(false);
    expect(reg.rejected).toEqual(["missions/location0/level1/sounds/JUMP_1.wav"]);
    expect(reg.get("jump_1")?.path).toBe("LOCAL:common/sounds/jump_1.wav");
    expect(reg.get("LOCAL:x\\y/Jump_1.wav.bak")?.key).toBe("JUMP_1");
    expect(reg.get("")).toBeUndefined();
  });

  it("finds the first exact, case-sensitive name and expands groups depth-first", () => {
    const bank = new SoundBank([
      { kind: "group", origin: "common", group: "", name: "G", members: ["a", "H"] },
      { kind: "sound", origin: "common", group: "G", name: "a", sample: "A", offset: [0, 0, 0], volume: 1, minDistance: 0, maxDistance: 1, volumeVar: -1, pitchVar: -1, sampleVar: -1, loop: false, positional: true },
      { kind: "group", origin: "common", group: "G", name: "H", members: ["b"] },
      { kind: "sound", origin: "common", group: "G/H", name: "b", sample: "B", offset: [0, 0, 0], volume: 1, minDistance: 0, maxDistance: 1, volumeVar: -1, pitchVar: -1, sampleVar: -1, loop: false, positional: true },
      { kind: "sound", origin: "mission", group: "", name: "a", sample: "C", offset: [0, 0, 0], volume: 1, minDistance: 0, maxDistance: 1, volumeVar: -1, pitchVar: -1, sampleVar: -1, loop: false, positional: true },
    ]);
    expect(bank.instantiate(bank.find("G")!).map((d) => d.name)).toEqual(["a", "b"]);
    expect((bank.find("a") as { sample: string }).sample).toBe("A");
    expect(bank.find("A")).toBeUndefined();
    expect(bank.findSound("G")).toBeUndefined();
  });
});

describe.skipIf(!staged)("audio loader on the original files", () => {
  let data: IgiAudioData;
  let loadMs = 0;

  it("loads common, mission and menu samples with the recovered keys", async () => {
    const t0 = performance.now();
    const progress: number[] = [];
    data = await loadIgiAudio(createFsAssetSource(RAW_ROOT), { decoder: "inline", onProgress: (f) => progress.push(f) });
    loadMs = performance.now() - t0;
    console.info(
      `[audio] ${data.stats.files} files, ${(data.stats.bytes / 1e6).toFixed(1)} MB, ${(data.stats.samples / 1e6).toFixed(1)} M samples: ` +
        `fetch ${data.stats.fetchMs.toFixed(0)} ms, decode ${data.stats.decodeMs.toFixed(0)} ms (max block ${data.stats.maxBlockMs.toFixed(0)} ms), total ${loadMs.toFixed(0)} ms`,
    );
    expect(data.samples.size).toBe(332 + 29);
    expect(data.menuSamples.size).toBe(13);
    expect(data.samples.rejected).toEqual([]);
    expect(data.warnings).toEqual([]);
    expect(progress[progress.length - 1]).toBe(1);
    expect(progress.every((p, i) => i === 0 || p >= progress[i - 1])).toBe(true);

    const music = data.samples.get("m1_music")!;
    expect(music).toMatchObject({ origin: "mission", format: 2, streamed: true, channels: 2, sampleRate: 22050, frames: 3196294 });
    expect(data.samples.get("MACHINERY_01")?.origin).toBe("mission");
    expect(data.samples.get("mp5sd_loop")).toMatchObject({ origin: "common", format: 1, streamed: false });
    expect(data.menuSamples.get("menu_k01")).toMatchObject({ format: 3, sampleRate: 22050 });
    expect(data.menuSamples.get("MENU_MUSIC")).toMatchObject({ channels: 2, sampleRate: 44100 });
    expect(data.samples.get("menu_high")).toBeUndefined();
  }, 60000);

  it("reads definitions (common first), materials, animation triggers and volumes", () => {
    expect(data.bank.entries).toHaveLength(403 + 29);
    const machinery = data.bank.find("machinery_01")!;
    expect(machinery).toMatchObject({ group: "TEMP", volume: 0.3499999940395355, maxDistance: 25, loop: true });
    expect(data.bank.find("m1_music")).toMatchObject({ origin: "mission", volume: 0.5, loop: true });
    expect(data.bank.findSound("message")).toMatchObject({ sample: "MESSAGE" });
    expect(data.bank.instantiate(data.bank.find("helicopter_1")!).map((d) => d.kind)).toEqual(["graph"]);
    expect(data.bank.instantiate(data.bank.find("truck_sounds")!).map((d) => d.name)).toEqual([
      "TRUCK_START",
      "TRUCK_STOP",
      "truck_idle",
      "truck_engine",
      "truck_gravel",
    ]);
    expect(data.animTriggers.size).toBe(50);
    expect(data.animTriggers.get(1006)).toEqual({ id: 1006, sound: "mp5_reload_1", attach: true });
    expect(data.animTriggers.has(1010)).toBe(false);
    expect(data.materials.get("Gravel")?.noiseRadius).toBe(10);
    expect(data.volumes).toEqual({ fx: 1, music: 1, speech: 1 });
  });

  it("knows which event sounds are silent in the original (no definition or no sample)", () => {
    const playable = (name: string) => {
      const e = data.bank.find(name);
      if (!e) return false;
      return data.bank.instantiate(e).some((d) => data.samples.has(d.sample));
    };
    for (const n of ["player_hit_1", "player_xplhit_1", "ai_death_3", "detected_06", "riccochet_4", "gunshotmiss", "guns_dry_1", "jump_1", "message", "pickup", "weaponpickup_1", "mapcomp_03", "player_fall_3"]) {
      expect(playable(n), n).toBe(true);
    }
    for (const n of ["player_death_0", "ai_death_0", "earcandy", "bul_dirt_1", "Walk0", "Hit0", "mapcomp_05", "rain_1"]) {
      expect(playable(n), n).toBe(false);
    }
  });

  it("runs the level-1 AmbientAreas: music, base ambience and the random one-shots at the base", async () => {
    const tasks: IgiTask[] = flattenTasks(readTaskTree(readQvmCallTree(await readRaw("missions/location0/level1/objects.qvm"))));
    const origin: Vec3 = [24532436, -56171048, 174413120]; // centre of the 500 m areas
    const mixer = new SoundMixer(data.samples, data.bank, { originIgi: origin });
    const started: string[] = [];
    const backend: VoiceBackend = {
      ready: true,
      start: (s: IgiSample, _loop: boolean, _o: number, _st: VoiceState): BackendVoice => {
        started.push(s.key);
        return { id: started.length };
      },
      update: () => {},
      stop: () => {},
      isPlaying: () => true,
    };
    mixer.setBackend(backend);
    const ambience = new AmbienceRuntime(mixer, tasks, origin, () => null, { random: () => 0.1 });
    expect(ambience.areas).toHaveLength(22);
    expect(ambience.sounds.filter((s) => s.simple && s.oneShot).map((s) => s.soundDef)).toEqual(["_cut01_01"]);
    const listener: AudioListener = { position: igiPointToEngine([24532436, -56171048, 174413120 + 2 * 4096], origin), right: [1, 0, 0], forward: [0, 0, -1], up: [0, 1, 0] };
    for (let i = 0; i < 3; i++) {
      ambience.tick(listener);
      mixer.tick(listener);
    }
    expect(started).toEqual(expect.arrayContaining(["M1_MUSIC", "M1_AMBIENCE", "DOG_01", "WIND_FX_01", "HAMMER_01", "HELI_BY_01", "METAL_01"]));
    expect(started).not.toContain("MACHINERY_01");
  });
});
