/**
 * Audio loader tests: ILSF (all four variants), sound definitions and the
 * recovered DirectSound mixer maths. Synthetic vectors come from the Python
 * reference (tools/igi_audio.py); the digests below are SHA-256 of the int16
 * samples that reference decodes from the original files, so a match proves
 * the two decoders agree sample-for-sample. Real-file tests skip when the
 * game files are not staged (npm run stage).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DETECTED_SOUNDS,
  FOOTSTEP_SEQUENCE,
  IGI_AUDIO,
  ambientPick,
  computeVoice,
  decodeIlsfAny,
  decodeIlsfPcm16,
  decodeImaAdpcm,
  dsPan,
  dsVolume,
  dsVolumeTable,
  findSoundDefinition,
  gainFromDsUnits,
  graphCurve,
  ilsfSampleKey,
  isSoundDefinition,
  readAnimSoundTriggers,
  readIlsfHeader,
  readMaterialSounds,
  readSoundDefinitions,
  roundHalfEven,
} from "../src/loaders/audio";
import { readIlffMembers } from "../src/loaders/ilff";
import { readTaskTree, flattenTasks } from "../src/loaders/tasks";
import { readQvmCallTree } from "../src/loaders/qvm";
import { RAW_ROOT, readRaw } from "./helpers";

function ilsf(format: number, channels: number, rate: number, frames: number, payload: number[], flags = 0): ArrayBuffer {
  const out = new Uint8Array(20 + payload.length);
  const v = new DataView(out.buffer);
  out.set([0x49, 0x4c, 0x53, 0x46], 0);
  v.setUint16(4, format, true);
  v.setUint16(6, 16, true);
  v.setUint16(8, channels, true);
  v.setUint16(10, flags, true);
  v.setUint32(12, rate, true);
  v.setUint32(16, frames, true);
  out.set(payload, 20);
  return out.buffer;
}

function sha256Int16(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * 2);
  const v = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) v.setInt16(i * 2, pcm[i], true);
  return createHash("sha256").update(bytes).digest("hex");
}

describe("ILSF decoding (synthetic)", () => {
  it("decodes IMA ADPCM high nibble first, like FUN_00494560", () => {
    // Expected values from tools/igi_audio.py decode_ima().
    expect(Array.from(decodeImaAdpcm(new Uint8Array([0x70, 0x08, 0xf7]), 1, 5))).toEqual([11, 13, 14, 13, -9]);
    expect(Array.from(decodeImaAdpcm(new Uint8Array([0x70, 0x08, 0xf7]), 1, 5, false))).toEqual([0, 11, 9, 10, 33]);
    // Stereo: nibbles interleave per frame (L = high nibble, R = low nibble).
    expect(Array.from(decodeImaAdpcm(new Uint8Array([0x7f, 0x80, 0x00]), 2, 3))).toEqual([11, -11, 9, -9, 10, -8]);
  });

  it("decodes all four formats and splits channels", () => {
    const pcm = decodeIlsfAny(ilsf(1, 2, 22050, 2, [0x00, 0x40, 0x00, 0xc0, 0xff, 0x7f, 0x00, 0x80], 0x1002));
    expect(pcm.channels).toBe(2);
    expect(Array.from(pcm.samples[0])).toEqual([0.5, 32767 / 32768]);
    expect(Array.from(pcm.samples[1])).toEqual([-0.5, -1]);
    expect(decodeIlsfPcm16(ilsf(0, 1, 22050, 1, [0x01, 0x00])).pcm[0]).toBe(1);
    const adpcm = decodeIlsfPcm16(ilsf(3, 1, 22050, 5, [0x70, 0x08, 0xf7], 0x1002));
    expect(Array.from(adpcm.pcm)).toEqual([11, 13, 14, 13, -9]);
    expect(adpcm.compressed && !adpcm.streamed).toBe(true);
    const streamed = readIlsfHeader(ilsf(2, 1, 11025, 4, [0, 0, 0]));
    expect(streamed.streamed && streamed.compressed).toBe(true);
    expect(streamed.duration).toBeCloseTo(4 / 11025, 12);
  });

  it("rejects malformed headers naming the offset", () => {
    expect(() => readIlsfHeader(new ArrayBuffer(10))).toThrow(/shorter than the 20-byte header/);
    const bad = new Uint8Array(ilsf(1, 1, 22050, 1, [0, 0]));
    bad[0] = 0x52;
    expect(() => readIlsfHeader(bad.buffer)).toThrow(/magic at 0x0/);
    expect(() => readIlsfHeader(ilsf(4, 1, 22050, 1, [0, 0]))).toThrow(/unknown format 4 at 0x4/);
    expect(() => readIlsfHeader(ilsf(1, 3, 22050, 1, [0, 0, 0, 0, 0, 0]))).toThrow(/3 channels at 0x8/);
    expect(() => readIlsfHeader(ilsf(1, 1, 22050, 2, [0, 0]))).toThrow(/PCM payload at 0x14 is 2 bytes/);
    expect(() => readIlsfHeader(ilsf(2, 1, 22050, 8, [0, 0]))).toThrow(/ADPCM payload at 0x14/);
    expect(() => readIlsfHeader(ilsf(2, 1, 22050, 2, [0, 0, 0]))).toThrow(/ADPCM payload at 0x14/);
  });

  it("derives the original sample key", () => {
    expect(ilsfSampleKey("LOCAL:common/sounds/mp5sd_loop.wav")).toBe("MP5SD_LOOP");
    expect(ilsfSampleKey("m1_music.wav")).toBe("M1_MUSIC");
    expect(ilsfSampleKey("eidos.avi.wav")).toBe("EIDOS");
  });
});

describe("DirectSound mapping (recovered FUN_004935d0 / FUN_004950f0)", () => {
  it("converts like igi.exe's FISTP: truncation toward zero (chop mode, FUN_004966d0)", () => {
    // The helper keeps its historical name; it truncates.
    expect([0.5, 1.5, 2.5, -0.5, -1.5, 2.4, 2.6, -1.75].map(roundHalfEven)).toEqual([0, 1, 2, 0, -1, 2, 2, -1]);
  });

  it("maps volume to about 1000*log2(v) hundredths of a dB, truncated toward 0", () => {
    // T[k] = trunc(ln(k * 1e-4) * 1442.6950408888495) (0x49361b, chop mode): T[5000] = trunc(-999.99999999992) = -999.
    expect([1, 0.5, 0.25, 0, 0.3, 0.75].map((v) => dsVolume(v))).toEqual([0, -999, -1999, -10000, -1737, -415]);
    expect([1, 9, 10, 5000, 9999, 10000].map(dsVolumeTable)).toEqual([-10000, -10000, -9965, -999, 0, 0]);
    expect(dsVolume(1, 0.5)).toBe(-999);
    expect(gainFromDsUnits(-1000)).toBeCloseTo(0.31623, 5);
  });

  it("maps pan to a one-sided attenuation, positive = right", () => {
    // (1 - 0.3) * 10000 = 6999.999.. -> T[6999]; (-0.9 + 1) * 10000 = 999.999.. -> T[999] (all chopped).
    expect([0, 0.5, -0.5, 1, -1, 0.3, -0.9].map(dsPan)).toEqual([0, 999, -999, 10000, -10000, 514, -3323]);
  });

  it("attenuates linearly between min and max distance and pans by x/(min+max)", () => {
    const right10 = computeVoice({
      volume: 1, sampleRate: 22050, positional: true, source: [10 * 4096, 0, 0], listener: [0, 0, 0],
      listenerRight: [1, 0, 0], minDistance: 5, maxDistance: 65,
    });
    expect(right10.volume).toBeCloseTo(1 - 5 / 60, 12);
    expect(right10.pan).toBeCloseTo(10 / 70, 12);
    expect(right10.dsVolume).toBe(-125);
    expect(right10.dsPan).toBe(222);
    expect(right10.gainRight).toBeGreaterThan(right10.gainLeft);
    const ahead = computeVoice({
      volume: 0.8, pitch: 3, sampleRate: 22050, positional: true, source: [0, 40 * 4096, 0],
      minDistance: 5, maxDistance: 65,
    });
    expect(ahead.volume).toBeCloseTo(1 / 3, 12);
    expect(ahead.dsVolume).toBe(-1585);
    expect(ahead.frequency).toBe(44100); // pitch clamped to 2.0
    const far = computeVoice({ volume: 1, sampleRate: 22050, positional: true, source: [30 * 4096, 0, 0], maxDistance: 20 });
    expect(far.dsVolume).toBe(IGI_AUDIO.silence);
    const flat = computeVoice({ volume: 0.5, sampleRate: 11025, positional: false, source: [1e9, 0, 0] });
    expect([flat.dsVolume, flat.dsPan, flat.frequency]).toEqual([-999, 0, 11025]);
  });

  it("reproduces the DefineGraph curve lookup: i = trunc(x * 10), piecewise-linear, float32 result", () => {
    const heli = [0, 0.35, 0.425, 0.4875, 0.55, 0.575, 0.6125, 0.6375, 0.8, 0.875, 1].map(Math.fround);
    const at = (x: number) => graphCurve(heli, Math.fround(x));
    expect(at(0.33)).toBeCloseTo(0.50625, 6);
    expect(at(0.37)).toBeCloseTo(0.53125, 6); // segment 3 (rounding would have extrapolated segment 4: 0.5425)
    expect(at(0.4)).toBeCloseTo(0.55, 6);
    expect(at(0.97)).toBeCloseTo(0.9625, 6); // i = 9: never reads past values[10]
    expect(Math.fround(at(0.33))).toBe(at(0.33)); // stored as float32
    expect([graphCurve(heli, -1), graphCurve(heli, 2)]).toEqual([0, 1]);
  });

  it("exposes the recovered constants", () => {
    expect(FOOTSTEP_SEQUENCE).toEqual([0, 1, 2, 3, 4, 5, 3, 1, 4, 2, 3, 5]);
    expect(DETECTED_SOUNDS).toHaveLength(6);
    expect([ambientPick(0.2, 2), ambientPick(0.5, 2), ambientPick(0.8, 2)]).toEqual([0, 1, 1]); // trunc: never the empty slot
    expect(IGI_AUDIO.speechCooldownTicks).toEqual([30, 59]); // 30 + trunc(30 * rand), rand <= 65535/65536
    expect(IGI_AUDIO.maxVoices).toBe(32);
    expect(IGI_AUDIO.outputSampleRate).toBe(22050);
  });
});

/** SHA-256 of the int16 samples decoded by tools/igi_audio.py (python3 tools/igi_audio.py --json). */
const LOOSE_DIGESTS: Record<string, string> = {
  "missions/location0/level1/sounds/_cut01_01.wav": "205685466002513c7645d4bf9c315e96db7d14258275dc4dfdf48c14842151f5",
  "missions/location0/level1/sounds/m01_ing_01.wav": "abc188faf5e5a67b49a0fb40810b6af8c4945f670b4df213ead84b7b7c09c7bb",
  "missions/location0/level1/sounds/m01_ing_02.wav": "6b3ddb002283d3ab67c5538d8feb9896ca9e100b466b8f35374c70c5d046bc39",
  "missions/location0/level1/sounds/m01_ing_03.wav": "d9471e50f9155eaaa915651fbe819f30b9f2cc10a404e548e7ea25cc1ab2ec41",
  "missions/location0/level1/sounds/m01_ing_04.wav": "af9a0851e551409b3972d2268c159cf181d1f1612abd3961c17a39eb237fb186",
  "missions/location0/level1/sounds/m01_ing_05.wav": "ac31c65eea483f8ad0797e9b735e282a21aae299c4aa67233f08b33285f6a2fd",
  "missions/location0/level1/sounds/m1_ambience.wav": "59403b7e04b937c3ffbf8601bf7b583ab7c6bae189dba2b8f6560e4cef37f3c6",
  "missions/location0/level1/sounds/m1_beeps01.wav": "5719f2acf89f07803114e47ef52fa1eb1fda6411d28d0fbcbde624e71bab97eb",
  "missions/location0/level1/sounds/m1_heliaway01.wav": "9684da70706b26147c89099a97e3526076d519ada6e070e9f67f61b8aaf762d8",
  "missions/location0/level1/sounds/m1_heliblad01.wav": "35281e6ffc21b48efc3ce212c5105c24958a912a2c62284753f55f615518dab1",
  "missions/location0/level1/sounds/m1_heliblad02.wav": "0383eea4884491eb9e7f4bc7f861988c8f22714b03310392fd6d446f520b4e99",
  "missions/location0/level1/sounds/m1_heliby01.wav": "f7452ba4595f2a55ab4153b2113f38c10ccf26bbd18faa89a9bd4b0e81628bf6",
  "missions/location0/level1/sounds/m1_heliby02.wav": "e197a7cf739e167a2d779ef37f8c48962a0dcb38732e4eaf2bbc7eb1ba225e92",
  "missions/location0/level1/sounds/m1_heligen01.wav": "1bdfe6aae55b561359105ba6ecd0e5993ce492c1758a90340a36c16b2bdc7308",
  "missions/location0/level1/sounds/m1_heliinside01.wav": "d777715d78bf21dcc2702ba774579579ba3726f38f7c6b76c209bb84639f97f9",
  "missions/location0/level1/sounds/m1_music.wav": "6a0256f946461e2ea9ca89ca7fdde9a9daff9b01c87187d7fd8db8fcfb4f375c",
  "missions/location0/level1/sounds/m1_office01.wav": "e0655cf80b13e13176d89ac66e42124f4fc2f30692af93b1159f6d5dfd5e87c7",
  "missions/location0/level1/sounds/m1_office02.wav": "50fb72fe3d9f337121a612e4f848dab598f422b853838c39e83597ce4b84c608",
  "missions/location0/level1/sounds/m1_office03.wav": "6f0ea6ec5247012a63c07a74bc6e41244dc82f3796adee3ce1c60c519f06d551",
  "missions/location0/level1/sounds/m1_trainby01.wav": "73b6854256ddfd9c3add55f8a962da6eff8a347b3ee1c2a32d2f774150e86e17",
  "missions/location0/level1/sounds/m1_trainext01.wav": "918aa26f0818f1edf26980bbce4351709143cac2993a15f40dd23a56bc588be0",
  "missions/location0/level1/sounds/m1_type01.wav": "0d850f79e5c0b5d33c285b5fa721a788aaaa38f1e4fc193029e69628e5be55c8",
  "missions/location0/level1/sounds/m1o_baseamb.wav": "5343a875ee099a4563c7d7d62bba6e958b22702a3e7027d6035fb85005fd921e",
  "missions/location0/level1/sounds/m1o_hammer.wav": "08d510e5ad7390b374c654fa14418e6df54c9789e557d809b613d1d207101d8c",
  "missions/location0/level1/sounds/m1o_train1.wav": "3338f0d4d3342b75affa4ae3b8a94312b21c3cd1df266d62328ed4e0c7a05ca9",
  "missions/location0/level1/sounds/m1o_train2.wav": "21d86de2a454249bf3c392e7c6406f253abd92f6d6c7e6fc3fc0131910dc1cd4",
  "missions/location0/level1/sounds/m1o_truck.wav": "5d3bde1db5b91ca82f18193dca49ccd429b55120afa5d3c17aa5c75ec1516952",
  "missions/location0/level1/sounds/m1o_wind.wav": "c052128b21a863ed17061670f5f8c6ec6482c3a083b117ec2ec3ff2075b26a01",
  "missions/location0/level1/sounds/machinery_01.wav": "a2f537aab7ac37bd4ce651f4371706dbf7689bca38b961478664af3bdcbdff8e",
  "screens/intro/eidos.wav": "b1d38175aaeb6e1d95de3fbbb9aaeac8f5336c7574cd09eb56e8e03e65fe06a5",
  "screens/intro/innerloop.wav": "b41915e589f70b876c89e5aebbc72273d577827c7d724994b3c712371e10b5bf",
};
/** SHA-256 over (name NUL sha256(int16le)) of every .wav member, in archive order. */
const ARCHIVE_DIGESTS: Record<string, string> = {
  "common/sounds/sounds.res": "86a7ef2feab0a018a1e9503fc6bd90fbd254dec37f876b40a135c6082496f920",
  "menusystem/SOUND/sounds.res": "3c57e97861c82acc8ee61a366f115639169fc4d99eaebd45c82c11d4d4f4a3f4",
};

const staged = (p: string): boolean => existsSync(`${RAW_ROOT}/${p}`);
const hasSounds =
  Object.keys(LOOSE_DIGESTS).every(staged) && Object.keys(ARCHIVE_DIGESTS).every(staged);

describe.skipIf(!hasSounds)("ILSF decoding (original files)", () => {
  it("matches the Python reference sample-for-sample on every loose file", async () => {
    const formats = new Map<string, number>();
    for (const [path, digest] of Object.entries(LOOSE_DIGESTS)) {
      const d = decodeIlsfPcm16(await readRaw(path));
      formats.set(`${d.format}/${d.channels}`, (formats.get(`${d.format}/${d.channels}`) ?? 0) + 1);
      expect(sha256Int16(d.pcm), path).toBe(digest);
      if (d.compressed) expect(d.payloadBytes, path).toBe((d.frames >> 1) * d.channels + 1);
    }
    // level 1: 22 mono + 6 stereo streamed ADPCM, 1 streamed PCM; intro: 2 stereo ADPCM
    expect(Object.fromEntries(formats)).toEqual({ "2/1": 22, "2/2": 8, "0/1": 1 });
  });

  it("matches the Python reference on both sounds.res archives", async () => {
    let total = 0;
    for (const [path, digest] of Object.entries(ARCHIVE_DIGESTS)) {
      const outer = createHash("sha256");
      for (const m of readIlffMembers(await readRaw(path))) {
        if (!m.name.toLowerCase().endsWith(".wav")) continue;
        const d = decodeIlsfPcm16(m.payload);
        total++;
        expect(d.flags, m.name).toBe(d.format === 1 || d.format === 3 ? 0x1002 : 0);
        const name = new Uint8Array(m.name.length + 1);
        for (let i = 0; i < m.name.length; i++) name[i] = m.name.charCodeAt(i);
        outer.update(name).update(Buffer.from(sha256Int16(d.pcm), "hex"));
      }
      expect(outer.digest("hex"), path).toBe(digest);
    }
    expect(total).toBe(332 + 13);
  });

  it("decodes plausible audio and rejects the wrong nibble order / interleave", async () => {
    const music = decodeIlsfAny(await readRaw("missions/location0/level1/sounds/m1_music.wav"));
    expect([music.channels, music.sampleRate, music.frames]).toEqual([2, 22050, 3196294]);
    const ambience = readIlsfHeader(await readRaw("missions/location0/level1/sounds/m1_ambience.wav"));
    expect([ambience.channels, ambience.sampleRate, ambience.frames]).toEqual([2, 11025, 461793]);
    expect(ambience.duration).toBeCloseTo(41.886, 3);
    // Mono: the low-nibble-first alternative drifts and clips; the recovered order does not.
    for (const name of ["m01_ing_01", "m1_heliblad01", "m1o_wind", "machinery_01"]) {
      const buf = await readRaw(`missions/location0/level1/sounds/${name}.wav`);
      const h = readIlsfHeader(buf);
      const frames = Math.min(h.frames, 120000);
      const payload = new Uint8Array(buf, 20);
      const score = (pcm: Int16Array) => {
        let e = 0;
        let clip = 0;
        for (const x of pcm) {
          e += x * x;
          if (x === 32767 || x === -32768) clip++;
        }
        return { rms: Math.sqrt(e / pcm.length), clip };
      };
      const good = score(decodeImaAdpcm(payload, 1, frames, true));
      const bad = score(decodeImaAdpcm(payload, 1, frames, false));
      expect(good.clip, name).toBe(0);
      expect(bad.clip > 0 || bad.rms > 1.5 * good.rms, name).toBe(true);
    }
    // Stereo: interleaving whole bytes per channel instead of nibbles saturates.
    const buf = await readRaw("missions/location0/level1/sounds/m1o_truck.wav");
    const payload = new Uint8Array(buf, 20, 100000);
    const left = payload.filter((_, i) => i % 2 === 0);
    let clipped = 0;
    for (const x of decodeImaAdpcm(left, 1, left.length * 2)) if (x === 32767 || x === -32768) clipped++;
    expect(clipped).toBeGreaterThan(100);
    const right = decodeIlsfPcm16(buf).pcm.subarray(0, 200000);
    let ok = 0;
    for (const x of right) if (x === 32767 || x === -32768) ok++;
    expect(ok).toBeLessThan(5);
  });
});

const hasDefs =
  staged("common/sounds/sounds.qvm") && staged("missions/location0/level1/sounds/sounds.qvm");

describe.skipIf(!hasDefs)("sound definitions (original files)", () => {
  it("decodes every DefineSound / DefineGraph / DefineTriggerOnce", async () => {
    const common = readSoundDefinitions(await readRaw("common/sounds/sounds.qvm"), "common");
    const mission = readSoundDefinitions(await readRaw("missions/location0/level1/sounds/sounds.qvm"), "mission");
    const count = (defs: typeof common, kind: string) => defs.filter((d) => d.kind === kind).length;
    expect(["group", "sound", "graph", "trigger-once"].map((k) => count(common, k))).toEqual([26, 360, 10, 7]);
    expect(["group", "sound"].map((k) => count(mission, k))).toEqual([5, 24]);
    const defs = [...common, ...mission];
    const mp5 = findSoundDefinition(defs, "mp5sd_loop");
    expect(mp5).toMatchObject({ sample: "MP5SD_LOOP", volume: 1, minDistance: 0, maxDistance: 65, loop: true, group: "GUN SHOTS" });
    expect(findSoundDefinition(defs, "mp5sd_loop_e")).toMatchObject({ loop: false, maxDistance: 65 });
    expect(findSoundDefinition(defs, "m1_music")).toMatchObject({ origin: "mission", group: "MUSIC", volume: 0.5, maxDistance: 200, loop: true });
    expect(findSoundDefinition(defs, "message")).toMatchObject({ sample: "MESSAGE", loop: false });
    expect(findSoundDefinition(defs, "alarmsystem_working")).toMatchObject({ sample: "ALARM_1", minDistance: 40, maxDistance: 80, loop: true });
    // Duplicate names: the first declaration wins (TEMP before POOL).
    expect(findSoundDefinition(defs, "machinery_01")).toMatchObject({ group: "TEMP", maxDistance: 25 });
    // "helicopter_1" names a group (found first) that contains a graph of the same name.
    expect(findSoundDefinition(defs, "helicopter_1")).toMatchObject({ kind: "group", members: ["helicopter_1"] });
    const heli = defs.find((d) => d.kind === "graph" && d.name === "helicopter_1");
    expect(isSoundDefinition(heli)).toBe(true);
    if (!isSoundDefinition(heli)) throw new Error("graph missing");
    expect(heli.volumeCurve).toHaveLength(11);
    expect(heli.pitchCurve?.[10]).toBeCloseTo(1.05, 5);
    expect(findSoundDefinition(defs, "truck_sounds")).toMatchObject({ kind: "group", members: ["TRUCK_START", "TRUCK_STOP", "truck_idle", "truck_engine", "truck_gravel"] });
    // Silent references in the original: no definition / no loaded sample.
    for (const n of ["Walk0", "Hit0", "bul_dirt_1", "bul_dirt_2", "player_death_0", "ai_death_0"]) {
      expect(findSoundDefinition(defs, n), n).toBeUndefined();
    }
    expect(findSoundDefinition(defs, "TRUCK_STOP")).toMatchObject({ kind: "trigger-once", triggerVar: 1, triggerOnZero: true });
    expect(findSoundDefinition(defs, "earcandy")).toBeUndefined(); // FUN_004111e0 asks for it: silent in this build
  });

  it.skipIf(!staged("missions/location0/level1/objects.qvm"))("resolves every level-1 sound task", async () => {
    const defs = [
      ...readSoundDefinitions(await readRaw("common/sounds/sounds.qvm"), "common"),
      ...readSoundDefinitions(await readRaw("missions/location0/level1/sounds/sounds.qvm"), "mission"),
    ];
    const tasks = flattenTasks(readTaskTree(readQvmCallTree(await readRaw("missions/location0/level1/objects.qvm"))));
    const names: string[] = [];
    for (const t of tasks) {
      const p = t.params as Record<string, unknown>;
      if (t.type === "ConditionalSound" && p["Simple"] !== true) names.push(String(p["SoundDef"]));
      if (t.type === "AmbientArea") names.push(...String(p["SoundDef"]).split(/\s+/).filter(Boolean));
      if (t.type === "StatusMessage" && p["Sound"]) names.push(String(p["Sound"]));
      if (t.type === "Door") names.push(String(p["Open sound"]), String(p["Close sound"]), String(p["Move sound"]));
    }
    expect(names.length).toBeGreaterThan(60);
    for (const n of names) expect(findSoundDefinition(defs, n), n).toBeDefined();
  });

  it.skipIf(!staged("material/material.qvm"))("reads material footstep and impact sounds", async () => {
    const mats = readMaterialSounds(await readRaw("material/material.qvm"));
    expect(mats).toHaveLength(24);
    expect(mats.find((m) => m.name === "Gravel")).toMatchObject({ walk: ["walk_gravel_1", "walk_gravel_2", "walk_gravel_3", "walk_gravel_4", "walk_gravel_5", "walk_gravel_6"], land: "land_ground_4", noiseRadius: 10 });
  });

  it.skipIf(!staged("animtrigger/animtrigger.qvm"))("reads reload animation sound triggers", async () => {
    const triggers = readAnimSoundTriggers(await readRaw("animtrigger/animtrigger.qvm"));
    expect(triggers).toHaveLength(50);
    expect(triggers.filter((t) => t.sound.startsWith("mp5_reload_")).map((t) => t.id)).toEqual([1006, 1007, 1008, 1009, 1011]);
  });
});
