/**
 * Cut-scene camera filters (src/engine/render/cutscene-filter-state.ts,
 * docs/mission.md "Camera filters"). Synthetic tests run everywhere; the
 * level-1 timeline reads the staged objects.qvm and is skipped without
 * web-port/game-data.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { RAW_ROOT, readRaw } from "./helpers";
import { MissionRuntime, readMissionTasks, readUiArchive, x87StoreF32, type MissionTasks, type Vec3 } from "../src/loaders";
import { LevelRng } from "../src/engine/ai/rng";
import {
  CAMERA_FILTER,
  CutsceneFilters,
  FILTER_ASSETS,
  FILTER_VIEWPORT,
  bandEdges,
  bandTexture,
  batteryQuad,
  drawBand,
  drawHandiCam,
  drawLine,
  scanLineColour,
  speckle,
  timecodeText,
  updateBand,
  type BandOverlay,
  type FilterPrimitive,
  type HandiCamOverlay,
  type LineOverlay,
} from "../src/engine/render/cutscene-filter-state";

const vp = FILTER_VIEWPORT;
const rects = (p: FilterPrimitive[]) => p.filter((x): x is Extract<FilterPrimitive, { kind: "rect" }> => x.kind === "rect");
const band = (o: Partial<BandOverlay> = {}): BandOverlay => ({
  kind: "band", cutSceneId: 1, colour: [1, 1, 1], noise: 0, burst: 0, roll: 0, burstCounter: 90, camera: 1, ...o,
});

describe("filter globals (FUN_00499900)", () => {
  it("time code starts at the first draw of the unseeded RNG x 21600 frames: 00 : 12 : 38 : 08", () => {
    const f = new CutsceneFilters();
    // FUN_004aaa00 state, one FUN_004aaa50 step: s0 & 0xffff = 0xd7b6.
    expect(f.timecode).toBe(Math.fround((0xd7b6 / 65536) * 21600));
    expect(timecodeText(f.timecode)).toBe("00 : 12 : 38 : 08");
    expect(f.cameraNumber).toBe(1);
  });

  it("time code text: hours are (minutes % 60) / 60, so always 00", () => {
    expect(timecodeText(24 * 3600 * 2 + 5)).toBe("00 : 00 : 00 : 05");
    expect(timecodeText(24 * 61 + 23.9)).toBe("00 : 01 : 01 : 23");
  });
});

describe("LineFilter (LAB_00499bd0)", () => {
  const line = (noise: number, colour: Vec3 = [0, 0, 0]): LineOverlay => ({ kind: "line", cutSceneId: 1, colour, noise });

  it("120 full-width lines every 4 px, filter colour at alpha 0x4c", () => {
    const out: FilterPrimitive[] = [];
    const rng = new LevelRng(0);
    drawLine(out, line(0), vp, rng);
    expect(out.length).toBe(120);
    expect(rects(out).map((r) => r.y0)).toEqual(Array.from({ length: 120 }, (_, i) => 4 * i));
    expect(rects(out).every((r) => r.x0 === 0 && r.x1 === 640 && r.y1 === r.y0 + 1 && r.blend === "alpha")).toBe(true);
    expect(rects(out)[0].rgba).toEqual([0, 0, 0, 0x4c]);
    expect(scanLineColour([1, 0.5, 0.25])).toEqual([255, 127, 63, 0x4c]);
    expect(rng.draws).toBe(0);
  });

  it("noise 1: every pixel row gets 10 random grey dashes (<= 50 px) at alpha 255; every 101st draw only flushes the vertex buffer", () => {
    const out: FilterPrimitive[] = [];
    const rng = new LevelRng(0);
    drawLine(out, line(1), vp, rng);
    const dashes = rects(out).slice(120);
    const iterations = 480 * 10;
    const skipped = Math.floor(iterations / 101);
    expect(dashes.length).toBeLessThanOrEqual(iterations - skipped);
    expect(rng.draws).toBe(3 * (iterations - skipped));
    for (const d of dashes) {
      expect(d.rgba[3]).toBe(255);
      expect(d.rgba[0]).toBe(d.rgba[1]);
      expect(d.x1 - d.x0).toBeLessThanOrEqual(51);
      expect(d.x1).toBeLessThanOrEqual(640);
    }
    expect(new Set(dashes.map((d) => d.y0)).size).toBe(480);
  });

  it("noise below 0.1 spreads the rows: 1 dash every 1/(10 noise) px", () => {
    const out: FilterPrimitive[] = [];
    const rng = new LevelRng(0);
    drawLine(out, line(0.05), vp, rng);
    const dashes = rects(out).slice(120);
    // 0.05f x 10 = 0.5000000075: step = chop(1 / n) = 1.99999997 px, 240 rows, 2 of them hit the 200-vertex flush.
    expect(rng.draws).toBe(3 * (240 - 2));
    expect(dashes.every((d) => d.rgba[3] === 12)).toBe(true); // trunc(0.05 x 255)
    const ys = [...new Set(dashes.map((d) => d.y0))];
    expect(ys.slice(0, 5)).toEqual([0, 2, 4, 6, 8]);
    expect(ys.every((y, i) => i === 0 || (y - ys[i - 1] >= 1 && y - ys[i - 1] <= 4))).toBe(true); // a flushed row leaves a gap
  });
});

describe("BandFilter (FUN_00499390, LAB_0049a7a0, FUN_0049a5d0, LAB_0049a840)", () => {
  it("noise 0: one ZERO/SRCCOLOR rectangle over the frame in the clamped colour (no bands)", () => {
    const out: FilterPrimitive[] = [];
    const rng = new LevelRng(0);
    drawBand(out, band({ colour: [0.5, 1, 0] }), vp, rng);
    expect(out).toEqual([{ kind: "rect", x0: 0, y0: 0, x1: 640, y1: 480, rgba: [127, 255, 0, 255], blend: "multiply" }]);
    expect(rng.draws).toBe(0);
  });

  it("band edges: 24-px bands from the top; shifted half a band while the roll counter is above 45", () => {
    const steps = Array.from({ length: 19 }, (_, i) => 24 * (i + 1));
    expect(bandEdges(band({ roll: 45 }), vp)).toEqual([0, 0, ...steps, 480]);
    expect(bandEdges(band({ roll: 46 }), vp)).toEqual([0, 12, ...steps.map((y) => y + 12), 480]);
  });

  it("textures: 2 rows x 128 / 2 rows x 255 of the colour (odd bands), flat x 255 (even bands)", () => {
    const scan = bandTexture([1, 1, 1], true);
    const row = (r: number) => Array.from(scan.slice(r * 16, r * 16 + 16));
    expect([0, 1, 2, 3, 4, 15].map((r) => row(r)[0])).toEqual([0x808080, 0x808080, 0xffffff, 0xffffff, 0x808080, 0xffffff]);
    expect(new Set(row(5)).size).toBe(1);
    expect(Array.from(bandTexture([0.5, 0.25, 1], false))).toEqual(Array(256).fill((127 << 16) | (63 << 8) | 255));
  });

  it("speckles: trunc(burst x 256) texels, each darkened by one factor and shifted one byte up", () => {
    const tex = bandTexture([1, 1, 1], false);
    const rng = new LevelRng(0);
    speckle(tex, 1 / 256, rng);
    const changed = Array.from(tex).map((v, i) => [v, i]).filter(([v]) => v !== 0xffffff);
    expect(changed.length).toBe(1);
    const [v] = changed[0];
    expect(v & 0xff).toBe(0); // B = 0, G = B', R = G', A = R'
    expect((v >>> 8) & 0xff).toBe((v >>> 16) & 0xff);
    expect(rng.draws).toBe(2);
  });

  it("noise > 0: odd bands scan-line texture, even bands flat, then CAMERA n at (526, 96)", () => {
    const out: FilterPrimitive[] = [];
    drawBand(out, band({ noise: 1, camera: 3 }), vp, new LevelRng(0));
    const bands = out.filter((p): p is Extract<FilterPrimitive, { kind: "band" }> => p.kind === "band");
    expect(bands.map((b) => [b.y0, b.y1])).toEqual([
      ...Array.from({ length: 10 }, (_, i) => [48 * i, 48 * i + 24]),
      ...Array.from({ length: 10 }, (_, i) => [48 * i + 24, 48 * i + 48]),
    ]);
    // 640 x 0.9f = 575.99998: x = 525.99994 (glyphs start at pixel 526), y = 96.
    expect(out[out.length - 1]).toMatchObject({ kind: "text", text: "CAMERA 3", y: 96, colourByte: 199 });
    expect((out[out.length - 1] as { x: number }).x).toBeCloseTo(526, 3);
  });

  it("per tick: burst decays 4/60, roll counter cycles 0..60, burst re-arms after 90 - trunc(rand x 63) ticks", () => {
    const rng = new LevelRng(0);
    const o = band({ noise: 1 });
    updateBand(o, rng); // first update: counter = 90 -> re-arm
    expect(rng.draws).toBe(2);
    expect(o.burst).toBeGreaterThan(0);
    expect(o.roll).toBe(1);
    const b = o.burst;
    updateBand(o, rng);
    expect(o.burst).toBeCloseTo(Math.max(0, b - 4 / 60), 6);
    for (let i = 0; i < 59; i++) updateBand({ ...o }, rng);
    const r = band({ roll: 60, burstCounter: 0 });
    updateBand(r, rng);
    expect(r.roll).toBe(0);
  });
});

describe("HandiCamFilter (FUN_00499810, LAB_0049bbb0, FUN_0049bc10, LAB_0049b200)", () => {
  const handi = (o: Partial<HandiCamOverlay> = {}): HandiCamOverlay => ({ kind: "handicam", cutSceneId: 1, colour: [0, 0, 0], blink: 0, lastMs: 0, ...o });

  it("2-px scan lines every 4 px, white 2-px corner brackets, time code, upside-down battery", () => {
    const out: FilterPrimitive[] = [];
    drawHandiCam(out, handi({ blink: 0.8 }), vp, 18200.6);
    const lines = rects(out).filter((r) => r.rgba[3] === 0x4c);
    expect(lines.length).toBe(240);
    expect(lines.slice(0, 4).map((r) => r.y0)).toEqual([0, 1, 4, 5]);
    const brackets = rects(out).filter((r) => r.rgba[3] === 255);
    expect(brackets.length).toBe(16);
    expect(brackets.slice(0, 4)).toEqual([
      { kind: "rect", x0: 64, y0: 96, x1: 114, y1: 97, rgba: [255, 255, 255, 255], blend: "alpha" },
      { kind: "rect", x0: 64, y0: 96, x1: 65, y1: 146, rgba: [255, 255, 255, 255], blend: "alpha" },
      { kind: "rect", x0: 64, y0: 97, x1: 114, y1: 98, rgba: [255, 255, 255, 255], blend: "alpha" },
      { kind: "rect", x0: 65, y0: 96, x1: 66, y1: 146, rgba: [255, 255, 255, 255], blend: "alpha" },
    ]);
    // 0.9f < 0.9: the right corners sit at x = trunc(575.99998) = 575; their arms point left (pixels 526..575),
    // the bottom corners' arms point up (rows 335..384).
    expect(brackets.slice(4, 8).map((r) => [r.x0, r.y0, r.x1, r.y1])).toEqual([[526, 96, 576, 97], [575, 96, 576, 146], [526, 97, 576, 98], [574, 96, 575, 146]]);
    expect(brackets.slice(12).map((r) => [r.x0, r.y0, r.x1, r.y1])).toEqual([[526, 384, 576, 385], [575, 335, 576, 385], [526, 383, 576, 384], [574, 335, 575, 385]]);
    const text = out.find((p) => p.kind === "text") as Extract<FilterPrimitive, { kind: "text" }>;
    expect(text).toMatchObject({ text: "00 : 12 : 38 : 08", y: 364, colourByte: 199 });
    expect(text.x).toBeCloseTo(459, 3);
    expect(out[out.length - 1]).toEqual({ kind: "battery", quad: batteryQuad(vp), alpha: 255 });
    const q = batteryQuad(vp);
    // (x0, y1) (x1, y1) (x0, y0) (x1, y0): x 68 .. 112.8 (w x 0.07), y 98 .. 120.4 (half the width): v = 0 at the bottom.
    expect([q[0], q[4], q[5], q[7]]).toEqual([68, 68, 98, 98]);
    expect(q[2]).toBeCloseTo(112.8, 4);
    expect(q[1]).toBeCloseTo(120.4, 4);
    expect(q[3]).toBe(q[1]);
    const off: FilterPrimitive[] = [];
    drawHandiCam(off, handi({ blink: 0.5 }), vp, 0);
    expect(off[off.length - 1]).toMatchObject({ kind: "battery", alpha: 0 });
  });

  it("per tick: time code += ms x 0.024, blink += ms / 1000, wraps above 1.5 s", () => {
    const f = new CutsceneFilters();
    const t0 = f.timecode;
    f.apply(7, { cut: true, filter: CAMERA_FILTER.HANDICAM, keyColour: [0, 0, 0], colour: [0, 0, 0], noise: 0 }, 1000);
    f.endTick(new Set([7]), new Set(), 2000);
    expect(f.timecode).toBe(x87StoreF32(t0 + 1000 * Math.fround(0.024))); // fstp in chop mode
    const h = f.overlays()[0] as HandiCamOverlay;
    expect(h.blink).toBe(x87StoreF32(1000 * Math.fround(0.001)));
    f.endTick(new Set([7]), new Set(), 2600);
    expect(h.blink).toBe(0);
  });
});

describe("overlay lifetime (FUN_004ec230, FUN_004ebe30)", () => {
  const apply = (filter: number, cut = true, noise = 0) => ({ cut, filter, keyColour: [1, 1, 1] as Vec3, colour: [0.5, 0.5, 0.5] as Vec3, noise });

  it("cuts rebuild the slots; band colour follows the interpolated colour, line noise the interpolated noise", () => {
    const f = new CutsceneFilters();
    f.apply(1, apply(CAMERA_FILTER.LINE, true, 1), 0);
    expect(f.overlays()).toMatchObject([{ kind: "line", colour: [1, 1, 1], noise: 1 }]);
    f.apply(1, apply(CAMERA_FILTER.LINE, false, 0.25), 0);
    expect(f.overlays()).toMatchObject([{ kind: "line", noise: 0.25 }]);
    f.apply(1, apply(CAMERA_FILTER.BAND), 0);
    expect(f.overlays()).toMatchObject([{ kind: "band", colour: [0.5, 0.5, 0.5], camera: 1 }]);
    f.apply(1, apply(CAMERA_FILTER.NONE), 0);
    expect(f.overlays()).toEqual([]);
  });

  it("BAND_UPDATE advances the camera number 1..9 before creating the band", () => {
    const f = new CutsceneFilters();
    const cams: number[] = [];
    for (let i = 0; i < 10; i++) {
      f.apply(1, apply(CAMERA_FILTER.BAND_UPDATE), 0);
      cams.push((f.overlays()[0] as BandOverlay).camera);
    }
    expect(cams).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 1, 2]);
  });

  it("a stopped cut-scene keeps its overlays until a later tick in another render frame", () => {
    const f = new CutsceneFilters();
    f.apply(1, apply(CAMERA_FILTER.HANDICAM), 0);
    f.endTick(new Set([1]), new Set(), 0);
    f.buildFrame();
    f.endTick(new Set(), new Set([1]), 0); // stop tick: frame remembered
    expect(f.overlays().length).toBe(1);
    f.endTick(new Set(), new Set(), 0); // no frame drawn in between: kept
    expect(f.overlays().length).toBe(1);
    f.buildFrame();
    f.endTick(new Set(), new Set(), 0);
    expect(f.overlays()).toEqual([]);
  });
});

const OBJECTS = "missions/location0/level1/objects.qvm";
const hasData = existsSync(`${RAW_ROOT}/${OBJECTS}`);

describe.skipIf(!hasData)("level 1", () => {
  let tasks: MissionTasks;
  const load = async () => (tasks ??= readMissionTasks(await readRaw(OBJECTS)));

  /** Run the intro (or the outro from tick 3001) with the mission-system wiring; one frame per tick. */
  const run = (t: MissionTasks, until: number, truck = false) => {
    const f = new CutsceneFilters();
    const applied = new Set<number>();
    const stopped = new Set<number>();
    const perTick: string[] = [];
    const tints: number[] = [];
    let rt!: MissionRuntime;
    rt = new MissionRuntime(t, {
      humans: () => (truck && rt.levelTick + 1 >= 3001 ? [{ position: [24956964, -56099004, 174417760], team: 0 }] : []),
      onCutSceneCamera(s, cut) {
        applied.add(cut.id);
        f.apply(cut.id, { cut: s.cut, filter: s.filter, keyColour: cut.keys[s.curveKeys[1]].filterColor, colour: s.filterColor, noise: s.noise }, 0);
      },
      onCutSceneStop: (cut) => stopped.add(cut.id),
    });
    while (rt.levelTick < until && !rt.missionComplete) {
      applied.clear();
      stopped.clear();
      rt.tick();
      f.endTick(applied, stopped, (rt.levelTick * 1000) / 30);
      perTick[rt.levelTick] = f.overlays().map((o) => `${o.kind}:${o.cutSceneId}`).join(",");
      const tint = f.buildFrame().find((p) => p.kind === "rect" && p.blend === "multiply");
      if (tint && tint.kind === "rect") tints[rt.levelTick] = tint.rgba[0];
    }
    return { perTick, tints, f };
  };

  const spans = (perTick: string[], value: string) => {
    const out: [number, number][] = [];
    perTick.forEach((v, tick) => {
      if (v !== value) return;
      const last = out[out.length - 1];
      if (last && last[1] === tick - 1) last[1] = tick;
      else out.push([tick, tick]);
    });
    return out;
  };

  it("intro: LINE over the Anya video link, HANDICAM on the truck shots (+2 ticks after CutScene_1202 stops)", async () => {
    const { perTick, f } = run(await load(), 2930);
    expect(spans(perTick, "line:1202")).toEqual([[1233, 1697], [1791, 2234]]);
    expect(spans(perTick, "handicam:1202")).toEqual([[2318, 2760]]);
    expect(perTick.filter((v) => v && v !== "line:1202" && v !== "handicam:1202")).toEqual([]);
    expect(f.overlays()).toEqual([]);
  });

  it("outro: BAND with noise 0 = multiply fade from white to black over the last 3 s", async () => {
    const { perTick, tints } = run(await load(), 6000, true);
    const band = spans(perTick, "band:1204");
    expect(band[0][0]).toBe(3001 + 660); // 22 s after the start tick
    const fade = tints.filter((v) => v !== undefined);
    expect(fade[0]).toBe(255);
    expect(fade[fade.length - 1]).toBe(0);
    for (let i = 1; i < fade.length; i++) expect(fade[i]).toBeLessThanOrEqual(fade[i - 1]);
  });

  it("assets: computer.res font1.fnt and sprites.res battery.spr (64 x 32)", async () => {
    const font = readUiArchive(await readRaw(FILTER_ASSETS.font.archive)).get(FILTER_ASSETS.font.member);
    expect(font?.kind).toBe("font");
    const bat = readUiArchive(await readRaw(FILTER_ASSETS.battery.archive)).get(FILTER_ASSETS.battery.member);
    expect(bat?.kind === "sprite" ? [bat.sprite.width, bat.sprite.height] : null).toEqual([64, 32]);
  });
});
