/**
 * In-game HUD rules of src/engine/ui (pure parts): radio timeline and wrap,
 * damage tint, flash-bang, action pulse, vertex-colour overflow, weapon panel
 * layout, loading screen, reverse submission order. Real-file checks are
 * skipped when web-port/game-data is not staged. Evidence: docs/hud.md.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { UiFont } from "../src/loaders";
import { loadUiAssets, readLanguageStrings, readWeaponHudInfo, type UiAssets } from "../src/engine/ui/assets";
import { submitHud, type HudView } from "../src/engine/ui/hud-draw";
import {
  ActionPulse,
  colour128,
  crosshairPosition,
  DamageTint,
  FlashBang,
  timerText,
  TINT_DECAY,
  vertexBytes,
  weaponPanelLayout,
} from "../src/engine/ui/hud-state";
import { submitLoading } from "../src/engine/ui/loading";
import { PrimList, type Painter } from "../src/engine/ui/painter";
import { normalisePortrait, radioBoxGeometry, StatusMessageScreen } from "../src/engine/ui/radio";
import { BinocularBars, compassHeading, submitBinoculars } from "../src/engine/ui/scope";
import { penAdvance, wrapRadioText, wrapTextBox } from "../src/engine/ui/text";
import { RAW_ROOT, readRaw } from "./helpers";

const have = (...paths: string[]) => paths.every((p) => existsSync(`${RAW_ROOT}/${p}`));
const rawSource = { exists: async (p: string) => existsSync(`${RAW_ROOT}/${p}`), readBinary: (p: string) => readRaw(p) };

/** Monospaced synthetic font: every printable character advances 5 px, space 4 px, line height 11. */
function fakeFont(advance = 5, space = 4, lineHeight = 11): UiFont {
  const charMap = new Uint8Array(256);
  const glyphs = [];
  for (let c = 33; c < 127; c++) {
    glyphs.push({ width: advance, height: lineHeight, x: 0, y: 0, advance, rgba: new Uint8ClampedArray(advance * lineHeight * 4) });
    charMap[c] = glyphs.length;
  }
  return { proportional: true, spaceAdvance: space, lineHeight, cellWidth: 24, charMap, glyphs };
}

describe("vertex colours (FUN_00504300, 128 = neutral, no clamping)", () => {
  it("packs bytes with the carry chain B -> G -> R -> A", () => {
    expect(colour128(128, 128, 128, 1)).toEqual([255, 255, 255, 255]);
    expect(colour128(0, 120, 0, 1)).toEqual([0, 239, 0, 255]);
    // Damage tint (255,0,0): 508 -> byte 252, carry into alpha (trunc(0.5 * 255) = 127, + 1).
    expect(colour128(255, 0, 0, 0.5)).toEqual([252, 0, 0, 128]);
    // Flash (255,255,255) -> (253,253,252).
    expect(colour128(255, 255, 255, 0.5)).toEqual([253, 253, 252, 128]);
    // trunc(v * 255) (chop-mode FISTP): 0.9 -> 229, 0.5 -> 127.
    expect(vertexBytes(0, 0.9, 0, 0.5)).toEqual([0, 229, 0, 127]);
  });
});

describe("StatusMessageScreen (FUN_00483b30)", () => {
  const font = fakeFont();
  const text = "ANYA: The truck is in the garage on the far side of the base."; // 61 characters
  it("lives 9 + 61 + 60 + 1 = 131 ticks with Duration 2", () => {
    const s = new StatusMessageScreen(() => font, () => font);
    expect(s.send({ text, portrait: null, durationSeconds: 2, cutscene: false })).toBe(true);
    for (let i = 0; i < 130; i++) s.tick();
    expect(s.slots[0]).not.toBeNull();
    s.tick();
    expect(s.slots[0]).toBeNull();
  });
  it("opens, widens, then types one character per tick from tick 9", () => {
    const s = new StatusMessageScreen(() => font, () => font);
    s.send({ text, portrait: null, durationSeconds: 2, cutscene: false });
    const slot = s.slots[0]!;
    s.tick();
    expect(slot.open).toBe(0.5);
    s.tick();
    expect(slot.open).toBe(1);
    for (let i = 0; i < 7; i++) s.tick();
    expect(slot.widen).toBeCloseTo(1, 6);
    expect(slot.typed).toBe(0);
    s.tick();
    expect(slot.typed).toBe(1);
    expect(slot.lines).toEqual(["A"]);
  });
  it("has 12 slots, the first free one is taken, and active slots are 42 px apart", () => {
    const s = new StatusMessageScreen(() => font, () => font);
    for (let i = 0; i < 12; i++) expect(s.send({ text: `m${i}`, portrait: null, durationSeconds: 2, cutscene: false })).toBe(true);
    expect(s.send({ text: "x", portrait: null, durationSeconds: 2, cutscene: false })).toBe(false);
    s.slots[0] = null;
    const l = s.layout(640, 480);
    expect(l[0].slot.text).toBe("m1");
    expect([l[0].x, l[0].y, l[1].y]).toEqual([10, 10, 52]);
  });
  it("shows cut-scene lines at (10, 415) for round(Duration * 30) + 1 updates", () => {
    const s = new StatusMessageScreen(() => font, () => font);
    s.send({ text: "JONES: Yeah.", portrait: null, durationSeconds: 1, cutscene: true });
    s.tick();
    const l = s.layout(640, 480);
    expect([l[0].x, l[0].y]).toEqual([10, 415]);
    expect(l[0].slot.lines).toEqual(["JONES: Yeah."]);
    for (let i = 0; i < 30; i++) s.tick();
    expect(s.slots[0]).not.toBeNull(); // 31 updates shown
    s.tick();
    expect(s.slots[0]).toBeNull();
  });
  it("box geometry: full 235 x 37 at tick 9, green alpha 0.75 only at tick 0", () => {
    const s = new StatusMessageScreen(() => font, () => font);
    s.send({ text, portrait: null, durationSeconds: 2, cutscene: false });
    const slot = s.slots[0]!;
    expect(radioBoxGeometry(slot, 10, 10, null).greenAlpha).toBeCloseTo(0.75, 6);
    for (let i = 0; i < 9; i++) s.tick();
    const g = radioBoxGeometry(slot, 10, 10, null);
    expect(g.x0).toBeCloseTo(10, 4);
    expect(g.x1).toBeCloseTo(245, 4);
    expect([g.y0, g.y1]).toEqual([10, 47]);
    expect(g.greenAlpha).toBeCloseTo(0.15, 6);
  });
  it("accepts only the four portrait sprites", () => {
    expect(normalisePortrait("STATUSSCREEN:anya.spr")).toBe("anya.spr");
    expect(normalisePortrait("ammo.spr")).toBe("ammo.spr");
    expect(normalisePortrait("STATUSSCREEN:health.spr")).toBeNull();
    expect(normalisePortrait("")).toBeNull();
  });
});

describe("word wraps (FUN_00483d20, FUN_0041b8b0)", () => {
  const font = fakeFont(5, 4);
  it("measures the full pen advance including spaces (FUN_004ad2e0)", () => {
    expect(penAdvance(font, "ab ")).toBe(14);
  });
  it("breaks at the last space once the text before the character reaches the width", () => {
    // "aaaa bbbb cccc" (5 px per letter, 4 per space), wrap 40: at the space after
    // "bbbb" the text before it is 44 px, and the last space seen is still the first one.
    expect(wrapRadioText(font, "aaaa bbbb cccc", 40)).toEqual(["aaaa", "bbbb cccc"]);
    // A '\n' also breaks, but at the last space seen (exe quirk).
    expect(wrapRadioText(font, "line one\nline two", 1000)).toEqual(["line", "one\nline two"]);
    // Without any space the break replaces the character before the current one.
    expect(wrapRadioText(font, "one\ntwo", 1000)).toEqual(["on", "\ntwo"]);
  });
  it("stops after 9 lines, appends the rest as a 10th, and keeps only the last three", () => {
    const lines = wrapRadioText(font, Array(12).fill("word").join(" "), 30);
    expect(lines).toEqual(["word", "word", "word word word"]);
  });
  it("TextBox places each word at the pen, new lines one line height lower", () => {
    const words = wrapTextBox(font, "aa bb cc", 0, 0, 30);
    expect(words).toEqual([
      { text: "aa ", x: 0, y: 0 },
      { text: "bb ", x: 14, y: 0 },
      { text: "cc", x: 0, y: 11 },
    ]);
  });
});

describe("damage tint, flash-bang, action pulse", () => {
  it("non-directional hit sets all corners to 0.4 (1 + rand) and fades 1/45 per tick", () => {
    const t = new DamageTint();
    t.hit(0.5);
    expect(t.corners.tl).toBeCloseTo(0.6, 6);
    expect(t.corners.br).toBeCloseTo(0.6, 6);
    let n = 0;
    while (t.active) {
      t.tick();
      n++;
    }
    // float32 arithmetic as in the exe: 27 steps leave a remainder, the 28th clamps to 0.
    expect(n).toBe(28);
    expect(27 * TINT_DECAY).toBeLessThan(0.6 + 1e-6);
  });
  it("directional hits: dominant side full, the other half (inferred axis mapping)", () => {
    const t = new DamageTint();
    t.hit(0, [1, 0, 0]);
    expect(t.corners).toEqual({ tl: Math.fround(0.4), tr: Math.fround(0.2), bl: Math.fround(0.4), br: Math.fround(0.2) });
    t.hit(0, [-1, 0.2, 0]);
    expect(t.corners.tr).toBeCloseTo(0.4, 6);
    expect(t.corners.tl).toBeCloseTo(0.2, 6);
    t.hit(0, [0, 1, 0]);
    expect([t.corners.tl, t.corners.bl]).toEqual([Math.fround(0.2), Math.fround(0.4)]);
    t.hit(0, [0, -1, 0]);
    expect(t.corners.tl).toBeCloseTo(0.4, 6);
    t.hit(0, [0, 0, -1]);
    expect([t.corners.tl, t.corners.bl]).toEqual([Math.fround(0.4), Math.fround(0.2)]);
  });
  it("flash-bang 2.0 stays at alpha 0.99 for 90 ticks, then fades over 60", () => {
    const f = new FlashBang();
    f.trigger();
    expect(f.alpha).toBe(0.99);
    let n = 0;
    while (f.value > 1) {
      f.tick();
      n++;
    }
    expect(n).toBeGreaterThanOrEqual(90);
    expect(n).toBeLessThanOrEqual(91);
    let m = 0;
    while (f.value > 0) {
      f.tick();
      m++;
    }
    expect(m).toBeGreaterThanOrEqual(59);
    expect(m).toBeLessThanOrEqual(61);
  });
  it("action pulse: 1/15 per tick, back to 0 above 2, alpha 0.3..1", () => {
    const p = new ActionPulse();
    expect(p.alpha).toBeCloseTo(0.3, 6);
    for (let i = 0; i < 15; i++) p.tick(true);
    expect(p.alpha).toBeCloseTo(1, 4);
    for (let i = 0; i < 16; i++) p.tick(true);
    expect(p.phase).toBeLessThan(0.1);
    p.tick(false);
    expect(p.phase).toBe(0);
  });
});

describe("binocular overlay (FUN_0046ff00)", () => {
  it("level bars jump to a random level, fall 0.02 per update and hold 15-30 updates", () => {
    const bars = new BinocularBars();
    const seq = [0.9, 0.7, 0.5];
    let i = 0;
    const rnd = () => seq[i++ % seq.length];
    bars.tick(rnd);
    const b = bars.bars[0];
    expect(b.value).toBeCloseTo(0.7, 6); // first rand 0.9 > 0 -> a second rand is the new level
    expect(b.counter).toBe(22 - 1); // fistp(22.5) truncates (chop mode) = 22
    bars.tick(rnd);
    expect(b.value).toBeCloseTo(0.68, 5);
  });
  it("compass heading: port yaw 0 (north) -> pi/2 in the exe's east-based angle (inferred)", () => {
    expect(compassHeading(0)).toBeCloseTo(Math.PI / 2, 6);
    expect(compassHeading(-Math.PI)).toBeCloseTo(1.5 * Math.PI, 6);
  });
  it("submits range text, 64 ticks with 8 labels, markers, bars and centre lines", () => {
    const list = new PrimList();
    const font = fakeFont(5, 4, 9);
    submitBinoculars({ kind: "binoculars", yaw: 0, rangeMetres: 87.4 }, new BinocularBars(), { sprites: new Map(), hudFont: font }, 640, 480, list);
    expect(list.labels[0]).toBe("text:RANGE: 87M");
    expect(list.labels.filter((l) => l === "strip").length).toBe(64 + 6 + 2);
    expect(list.labels.filter((l) => /^text:[WNES]$/.test(l)).length).toBe(8);
  });
});

describe("HUD helpers", () => {
  it("crosshair top-left truncates w/2 (chop-mode fistp): 9x9 -> (316, 236)", () => {
    expect(crosshairPosition(640, 480, 9, 9)).toEqual({ x: 316, y: 236 });
    expect(crosshairPosition(640, 480, 11, 11)).toEqual({ x: 315, y: 235 }); // trunc(5.5) = 5
  });
  it("timer text", () => {
    expect(timerText(30 * 61)).toBe("Time Left: 1 minute, 1 second");
    expect(timerText(30 * 125)).toBe("Time Left: 2 minutes, 5 seconds");
  });
  it("submits primitives in the exe's order and PrimList draws them reversed", () => {
    const list = new PrimList();
    const order: string[] = [];
    const rec = new Proxy({}, { get: (_t, k) => () => order.push(String(k)) }) as unknown as Painter;
    list.rect(0, 0, 1, 1, [0, 0, 0, 255]);
    list.strip([0, 0, 1, 0], [0, 0, 0, 255]);
    list.flush(rec);
    expect(order).toEqual(["strip", "rect"]);
  });
  it("loading screen bar: 4 of 9 steps fills trunc(560 * 4 / 9) = 248 px", () => {
    const list = new PrimList();
    const rects: number[][] = [];
    const rec = {
      rect: (x0: number, y0: number, x1: number, y1: number) => rects.push([x0, y0, x1, y1]),
      image: () => {},
    } as unknown as Painter;
    submitLoading({ sprites: new Map(), fonts: new Map(), pictures: new Map() }, false, 4, 9, list);
    list.flush(rec);
    // Drawn: black clear, empty bar, then the fill on top.
    expect(rects).toEqual([[0, 0, 640, 480], [40, 440, 600, 450], [40, 440, 288, 450]]);
  });
});

describe.skipIf(!have("computer/computer.res", "screens/game/status/status.res", "menusystem/ingamemenu.res", "weapons/weaponconfig.qvm"))(
  "HUD with the original files",
  () => {
    let assets: UiAssets | null = null;
    const load = async () => (assets ??= await loadUiAssets(rawSource));

    it("reads weaponconfig display types and names", async () => {
      const w = readWeaponHudInfo(await readRaw("weapons/weaponconfig.qvm"));
      expect(w.get("WEAPON_ID_MP5SD")).toMatchObject({ weaponId: 7, name: "Mp5 SD3", ammoDisplay: 2, sightDisplay: 1, roundsPerClip: 32 });
      expect(w.get("WEAPON_ID_KNIFE")).toMatchObject({ weaponId: 20, ammoDisplay: 0, sightDisplay: 0 });
      expect(w.get("WEAPON_ID_BINOCULARS")?.weaponType).toBe("WEAPONTYPE_BINOCULAR");
    });

    it("resolves language strings (menus, pickups, mission names)", async () => {
      const menu = readLanguageStrings(await readRaw("language/english/menusystem.res"));
      expect(menu.get("single player")).toBe("Play Project IGI");
      expect(menu.get("restart game")).toBe("Restart Mission");
      const msg = readLanguageStrings(await readRaw("language/english/messages.res"));
      expect(msg.get("pickedupweaponmp5 sd3")).toBe("Picked up a Mp5 SD3");
      expect(msg.get("pickedupammo")).toBe("Picked up ammo");
      const a = await load();
      expect(a.missions[0]).toMatchObject({ id: 1, name: "Trainyard", description: "Small coastline trainyard", sprite: "mission1.spr" });
    });

    it("wraps the level-1 radio example like the exe", async () => {
      const a = await load();
      const f1 = a.ingame.fonts.get("font1.fnt")!;
      const text = "ANYA: The truck is in the garage on the far side of the base.";
      expect(wrapRadioText(f1, text, 229)).toEqual(["ANYA: The truck is in the garage on the far", "side of the base."]);
    });

    it("lays out the weapon panel for the MP5 SD3 at 640x480", async () => {
      const a = await load();
      const font = a.computer.fonts.get("font3.fnt")!;
      const icon = a.status.sprites.get("mp5.spr")!;
      const clip = a.status.sprites.get("clip20.spr")!;
      const l = weaponPanelLayout(640, 480, font, {
        ammoDisplay: 2,
        name: "Mp5 SD3",
        counter: "49  ",
        icon: { width: icon.width, height: icon.height },
        graphicWidth: clip.width,
      });
      expect(l.icon).toEqual({ x: 582, y: 391 });
      expect(l.name!.y).toBe(419);
      expect(l.counter!.y).toBe(434);
      expect(l.separator!.x0).toBe(630);
      expect(l.separator!.y).toBeCloseTo(430, 3);
      expect(l.graphic!.x).toBe(626 - 8 - clip.width - (626 - l.counter!.x));
    });

    it("submits the radio messages first, so the reversed draw puts them over the player HUD", async () => {
      const a = await load();
      const radio = new StatusMessageScreen(() => a.ingame.fonts.get("font1.fnt")!, () => a.ingame.fonts.get("font4.fnt")!);
      radio.send({ text: "Picked up ammo", portrait: "ammo.spr", durationSeconds: 2, cutscene: false });
      for (let i = 0; i < 9 + 14; i++) radio.tick();
      const view: HudView = {
        W: 640, H: 480, playerHud: true, health: 0.5,
        weapon: { info: { weaponId: 7, scriptId: "WEAPON_ID_MP5SD", name: "Mp5 SD3", ammoDisplay: 2, sightDisplay: 1, weaponType: "WEAPONTYPE_GUN", roundsPerClip: 32 }, clip: 32, reserve: 49, roundsPerClip: 32 },
        actionIcon: null, actionAlpha: 1, progress: 0.5, tint: { tl: 0.5, tr: 0.5, bl: 0.5, br: 0.5 }, flashAlpha: 0.5, timerTicks: 600,
      };
      const list = new PrimList();
      submitHud(view, radio, { status: a.status, hudFont: a.computer.fonts.get("font3.fnt")!, radioFont: a.ingame.fonts.get("font1.fnt")!, cutsceneFont: a.ingame.fonts.get("font4.fnt")! }, list);
      const labels = list.labels;
      // Submission: portrait, text, box (rect, gouraud, strip) ... HUD ... tint, flash, timer.
      expect(labels[0]).toBe("sprite");
      expect(labels[1]).toBe("text:Picked up ammo");
      expect(labels.slice(2, 5)).toEqual(["rect", "gouraud", "strip"]);
      expect(labels[labels.length - 1]).toMatch(/^text:Time Left/);
      expect(labels[labels.length - 2]).toBe("rect"); // flash
      expect(labels[labels.length - 3]).toBe("gouraud"); // damage tint
      expect(labels).toContain("text:Mp5 SD3");
    });
  },
);

