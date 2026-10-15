/**
 * Interface assets (sprites, pictures, fonts) and the recovered HUD layout
 * rules: synthetic fixtures for the format/failure paths, plus the real staged
 * UI archives (skipped when absent).  Evidence: docs/hud.md.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ammoText,
  barrelFrame,
  buildFontAtlas,
  clipFrame,
  composeUiPicture,
  healthBarGeometry,
  layoutText,
  loadingBarFill,
  loadingOrigin,
  measureText,
  pixelStart,
  readFont,
  readUiArchive,
  readUiSprite,
  roundHalfEven,
  shellFrame,
  statusMessageFrame,
  UI_PATHS,
  vertexColourByte,
  WEAPON_ICON,
  wrapStatusText,
  type UiFont,
  type UiSprite,
} from "../src/loaders/ui";
import { readIlffMembers } from "../src/loaders/ilff";
import { RAW_ROOT, readRaw } from "./helpers";

// --- fixture builders ------------------------------------------------------

class Bytes {
  data: number[] = [];
  at(offset: number): this {
    while (this.data.length < offset) this.data.push(0);
    return this;
  }
  u8(v: number): this {
    this.data.push(v & 255);
    return this;
  }
  u16(v: number): this {
    return this.u8(v).u8(v >> 8);
  }
  u32(v: number): this {
    return this.u16(v & 0xffff).u16((v >>> 16) & 0xffff);
  }
  ascii(s: string): this {
    for (const c of s) this.u8(c.charCodeAt(0));
    return this;
  }
  set32(offset: number, v: number): this {
    for (let i = 0; i < 4; i++) this.data[offset + i] = (v >>> (8 * i)) & 255;
    return this;
  }
  buffer(): ArrayBuffer {
    return new Uint8Array(this.data).buffer;
  }
}

/** One-frame 2x1 BGRA sprite with a 1x1 tile map (layout of every single .spr). */
function spriteFixture(): Bytes {
  const b = new Bytes().ascii("LOOP").u32(9).at(0x10).u32(0x50000).u32(0).u32(0).u32(0); // +0x1c footer patched
  b.at(0x20).u32(1).u32(0).u32(2).u32(1).u32(3); // count, _, w, h, format
  // frame record at 0x34
  b.at(0x34).u32(0x54).u32(3).u16(8).u16(2).u16(1).u16(5).at(0x4a).u16(1).u16(0).at(0x54);
  b.u8(10).u8(20).u8(30).u8(255); // B G R A
  b.u8(1).u8(2).u8(3).u8(0);
  const footer = b.data.length;
  b.set32(0x1c, footer);
  b.ascii("LOOP").u32(6).u32(2).u32(1).u32(1).u32(1); // w, h, cols, rows
  b.u32(0).u32(0).u32(0).u32(1); // cell: 0, x, y, frame+1
  return b;
}

/** Two-glyph proportional font: 'A' -> glyph 1 (2x1, advance 3), 'B' -> glyph 2. */
function fontFixture(): Bytes {
  const b = new Bytes().ascii("LOOP").u32(10).u32(0).u32(0).u32(2); // +0x10 count
  const base = 0x124 + 3 * 20;
  b.u32(base).u16(1).u16(4).u16(32).u16(11).u16(24).u16(3); // +0x14 base .. +0x22 format
  b.at(0x24 + 65).u8(1).u8(2).at(0x124 + 20);
  // glyph 1: offset 0, fmt 3, row 8, w 2, h 1, x 0, y 1, adv 3
  b.u32(0).u32(3).u16(8).u16(2).u16(1).u16(0).u16(1).u16(3);
  // glyph 2: offset 8, fmt 2, row 2, w 1, h 1, x 1, y 0, adv 5
  b.u32(8).u32(2).u16(2).u16(1).u16(1).u16(1).u16(0).u16(5);
  b.at(base).u8(0).u8(0).u8(255).u8(255).u8(0).u8(255).u8(0).u8(128);
  b.u16(0x8000 | (31 << 10));
  return b;
}

describe("readUiSprite (synthetic LOOP v9)", () => {
  it("decodes frames, offsets and the tile map", () => {
    const s = readUiSprite(spriteFixture().buffer(), "fixture");
    expect(s.version).toBe(9);
    expect(s.frames).toHaveLength(1);
    const f = s.frames[0];
    expect([f.width, f.height, f.advance, f.x, f.y, f.format]).toEqual([2, 1, 5, 1, 0, 3]);
    expect(Array.from(f.rgba)).toEqual([30, 20, 10, 255, 3, 2, 1, 0]);
    expect(s.tiles?.cells[0]).toBe(1);
    const pic = composeUiPicture(s, "fixture");
    expect([pic.width, pic.height]).toEqual([2, 1]);
  });

  it("throws naming the offset for a bad frame count, palette or footer", () => {
    const badCount = spriteFixture().set32(0x20, 0);
    expect(() => readUiSprite(badCount.buffer(), "x")).toThrow(/0x20/);
    const palette = spriteFixture().set32(0x18, 4);
    expect(() => readUiSprite(palette.buffer(), "x")).toThrow(/0x18/);
    const badFooter = spriteFixture();
    badFooter.set32(0x1c, 0x58);
    expect(() => readUiSprite(badFooter.buffer(), "x")).toThrow(/0x58/);
    const badFormat = spriteFixture();
    badFormat.set32(0x38, 7);
    expect(() => readUiSprite(badFormat.buffer(), "x")).toThrow(/format 7/);
    const truncated = spriteFixture();
    truncated.set32(0x34, 0x400);
    expect(() => readUiSprite(truncated.buffer(), "x")).toThrow(/outside file at 0x400/);
  });
});

describe("readFont / text layout (synthetic LOOP v10)", () => {
  const font = readFont(fontFixture().buffer(), "fixture");

  it("decodes header, map and glyphs", () => {
    expect(font.proportional).toBe(true);
    expect([font.spaceAdvance, font.lineHeight, font.cellWidth]).toEqual([4, 11, 24]);
    expect(font.glyphs).toHaveLength(2);
    expect(Array.from(font.glyphs[0].rgba)).toEqual([255, 0, 0, 255, 0, 255, 0, 128]);
    expect(Array.from(font.glyphs[1].rgba)).toEqual([255, 0, 0, 255]);
  });

  it("measures like FUN_004ad990 (trailing unmapped characters ignored)", () => {
    expect(measureText(font, "AB")).toBe(8);
    expect(measureText(font, "A ")).toBe(3);
    expect(measureText(font, " A")).toBe(7);
    expect(measureText(font, "")).toBe(0);
  });

  it("places glyphs like FUN_004adb90 for each alignment", () => {
    expect(layoutText(font, "A B", 10, 20)).toEqual([
      { glyph: 0, x: 10, y: 21 },
      { glyph: 1, x: 18, y: 20 },
    ]);
    expect(layoutText(font, "AB", 100, 0, "right")[0].x).toBe(92);
    expect(layoutText(font, "AB", 100, 0, "centre")[0].x).toBe(96);
  });

  it("builds an atlas with one rect per glyph", () => {
    const atlas = buildFontAtlas(font);
    expect(atlas.rects).toHaveLength(2);
    expect(atlas.texture.rgba.length).toBe(atlas.texture.width * atlas.texture.height * 4);
  });

  it("rejects a glyph number beyond the count, naming the map offset", () => {
    const bad = fontFixture();
    bad.data[0x24 + 67] = 9;
    expect(() => readFont(bad.buffer(), "x")).toThrow(/0x67/);
    const badBase = fontFixture().set32(0x14, 0x130);
    expect(() => readFont(badBase.buffer(), "x")).toThrow(/0x14/);
  });
});

describe("recovered drawing rules", () => {
  it("vertex colour bytes follow trunc(c/128*255) (chop-mode FISTP) with the overflow carry", () => {
    expect(vertexColourByte(128)).toEqual({ byte: 255, carry: 0 });
    expect(vertexColourByte(120).byte).toBe(239);
    expect(vertexColourByte(100).byte).toBe(199);
    expect(vertexColourByte(64).byte).toBe(127); // 127.5 truncated
    expect(vertexColourByte(255)).toEqual({ byte: 252, carry: 1 });
    // The historical name truncates: igi.exe runs the FPU in chop mode (FUN_004966d0).
    expect(roundHalfEven(127.5)).toBe(127);
    expect(roundHalfEven(229.5)).toBe(229);
    expect(roundHalfEven(-1.75)).toBe(-1);
    expect(pixelStart(10)).toBe(10);
    expect(pixelStart(10.5)).toBe(10);
    expect(pixelStart(10.6)).toBe(11);
  });

  it("ammo graphics frames", () => {
    expect(clipFrame(32, 32)).toBe(0);
    expect(clipFrame(0, 32)).toBe(60);
    expect(clipFrame(23, 32)).toBe(60 - Math.trunc((23 * 60) / 32));
    expect(barrelFrame(6)).toBe(0);
    expect(barrelFrame(0)).toBe(60);
    expect(shellFrame(7)).toBe(0);
    expect(shellFrame(0)).toBe(7);
    expect(ammoText(49)).toBe("49  ");
    expect(WEAPON_ICON[7]).toBe("Mp5.spr");
  });

  it("health bar at 640x480 matches the recovered anchors", () => {
    const g = healthBarGeometry(640, 480, { width: 64, height: 78 }, { width: 23, height: 70 }, 0.5);
    expect(g.background.x).toBeCloseTo(8, 4);
    expect(g.background.y).toBeCloseTo(391, 3);
    expect(g.bar?.x0).toBeCloseTo(26.5, 4);
    expect(g.bar?.yBottom).toBeCloseTo(463, 3);
    expect(g.bar?.yTop).toBeCloseTo(428, 3);
    expect(g.bar?.vTop).toBeCloseTo(0.5, 6);
    expect(healthBarGeometry(640, 480, { width: 64, height: 78 }, { width: 23, height: 70 }, 0).bar).toBeNull();
  });

  it("status message timeline (open 2 ticks, widen 7, type 1 char/tick, hold duration*30)", () => {
    expect(statusMessageFrame(0, 10, 2)).toMatchObject({ open: 0, widen: 0, typed: 0, portrait: false });
    expect(statusMessageFrame(1, 10, 2).open).toBe(0.5);
    expect(statusMessageFrame(2, 10, 2).open).toBe(1);
    expect(statusMessageFrame(9, 10, 2).widen).toBeCloseTo(1, 5);
    expect(statusMessageFrame(10, 10, 2)).toMatchObject({ typed: 1, portrait: true });
    expect(statusMessageFrame(19, 10, 2).typed).toBe(10);
    expect(statusMessageFrame(19 + 60, 10, 2).alive).toBe(true);
    expect(statusMessageFrame(19 + 61, 10, 2).alive).toBe(false);
    expect(statusMessageFrame(0, 10, 2).greenAlpha).toBeCloseTo(0.75, 5);
    expect(statusMessageFrame(5, 10, 2).greenAlpha).toBeCloseTo(0.15, 5);
  });

  it("loading bar fill and origin", () => {
    expect(loadingBarFill(0, 9)).toBe(0);
    expect(loadingBarFill(4, 9)).toBe(248);
    expect(loadingBarFill(9, 9)).toBe(560);
    expect(loadingOrigin(1024, 768)).toEqual({ x: 192, y: 144 });
    expect(loadingOrigin(640, 480)).toEqual({ x: 0, y: 0 });
  });
});

// --- real staged files -------------------------------------------------------

const have = (p: string) => existsSync(`${RAW_ROOT}/${p}`);

describe.skipIf(!have(UI_PATHS.status))("status.res (HUD sprites)", () => {
  it("decodes all 47 sprites with the measured sizes", async () => {
    const assets = readUiArchive(await readRaw(UI_PATHS.status));
    expect(assets.size).toBe(47);
    const sprite = (n: string): UiSprite => {
      const a = assets.get(n);
      if (!a || a.kind !== "sprite") throw new Error(`missing ${n}`);
      return a.sprite;
    };
    const size = (n: string) => [sprite(n).frames[0].width, sprite(n).frames[0].height];
    expect(size("cross.spr")).toEqual([9, 9]);
    expect(size("powerbarbackground.spr")).toEqual([64, 78]);
    expect(size("powerbar.spr")).toEqual([23, 70]);
    expect(size("Mp5.spr")).toEqual([48, 26]);
    expect(size("anya.spr")).toEqual([30, 33]);
    expect(sprite("clip20.spr").frames).toHaveLength(61);
    expect(sprite("barrel6.spr").frames).toHaveLength(61);
    expect(sprite("shell7.spr").frames).toHaveLength(8);
    for (const icon of Object.values(WEAPON_ICON)) expect(assets.has(icon)).toBe(true);
    // The crosshair is format 2 with transparent corners.
    const cross = sprite("cross.spr").frames[0];
    expect(cross.format).toBe(2);
    expect(cross.rgba[3]).toBe(0);
  });
});

describe.skipIf(!have(UI_PATHS.ingameMenu))("ingamemenu.res fonts (radio messages)", () => {
  async function font(name: string): Promise<UiFont> {
    const assets = readUiArchive(await readRaw(UI_PATHS.ingameMenu));
    const a = assets.get(name);
    if (!a || a.kind !== "font") throw new Error(`missing ${name}`);
    return a.font;
  }

  it("font1/font3/font4 have the measured metrics", async () => {
    const f1 = await font("font1.fnt");
    expect([f1.glyphs.length, f1.lineHeight, f1.spaceAdvance, f1.cellWidth]).toEqual([151, 11, 4, 24]);
    const f3 = await font("font3.fnt");
    expect([f3.lineHeight, f3.spaceAdvance]).toEqual([21, 6]);
    const f4 = await font("font4.fnt");
    expect([f4.lineHeight, f4.spaceAdvance]).toEqual([15, 4]);
  });

  it("measures and wraps M1_MSG_4 like the game (229 px)", async () => {
    const f1 = await font("font1.fnt");
    const text = "ANYA: The truck is in the garage on the far side of the base.";
    expect(measureText(f1, text)).toBe(303);
    expect(measureText(f1, "Picked up ammo")).toBe(79);
    expect(wrapStatusText(f1, text, 229)).toEqual(["ANYA: The truck is in the garage on the far", "side of the base."]);
    // Only the last three lines stay visible.
    const long = Array(20).fill("word").join(" ");
    expect(wrapStatusText(f1, long, 60).length).toBeLessThanOrEqual(3);
  });
});

describe.skipIf(!have(UI_PATHS.loading))("loadingscreen.res", () => {
  it("composes loading.pic and loading_us.pic to 640x480 from 10x15 tiles", async () => {
    const assets = readUiArchive(await readRaw(UI_PATHS.loading));
    for (const name of ["loading.pic", "loading_us.pic"]) {
      const a = assets.get(name);
      if (!a || a.kind !== "sprite") throw new Error(`missing ${name}`);
      expect(a.sprite.tiles?.columns).toBe(10);
      expect(a.sprite.tiles?.rows).toBe(15);
      expect(a.sprite.frames).toHaveLength(150);
      const pic = composeUiPicture(a.sprite, name);
      expect([pic.width, pic.height]).toEqual([640, 480]);
      // Opaque everywhere (format 3 tiles with alpha 255).
      let transparent = 0;
      for (let i = 3; i < pic.rgba.length; i += 4) if (pic.rgba[i] !== 255) transparent++;
      expect(transparent).toBe(0);
    }
  });
});

describe.skipIf(!have(UI_PATHS.mainMenu) || !have(UI_PATHS.sprites) || !have(UI_PATHS.missionSprites))(
  "menu, mission and overlay sprites",
  () => {
    it("decode every member", async () => {
      for (const path of [UI_PATHS.mainMenu, UI_PATHS.sprites, UI_PATHS.missionSprites]) {
        const buffer = await readRaw(path);
        const members = readIlffMembers(buffer).filter((m) => /\.(spr|pic|fnt)$/.test(m.name));
        const assets = readUiArchive(buffer);
        expect(assets.size).toBe(new Set(members.map((m) => m.name.slice(m.name.lastIndexOf("/") + 1))).size);
      }
      const menu = readUiArchive(await readRaw(UI_PATHS.mainMenu));
      const main = menu.get("mainmenu.pic");
      if (!main || main.kind !== "sprite") throw new Error("missing mainmenu.pic");
      expect(composeUiPicture(main.sprite).width).toBe(640);
      const logo = menu.get("logo.pic");
      if (!logo || logo.kind !== "sprite") throw new Error("missing logo.pic");
      const pic = composeUiPicture(logo.sprite);
      expect([pic.width, pic.height]).toEqual([295, 107]);
    });
  },
);

describe.skipIf(!have(UI_PATHS.computer))("computer.res (HUD text font3)", () => {
  it("font3 is the 9-px green HUD font", async () => {
    const assets = readUiArchive(await readRaw(UI_PATHS.computer));
    const a = assets.get("font3.fnt");
    if (!a || a.kind !== "font") throw new Error("missing font3.fnt");
    expect([a.font.glyphs.length, a.font.lineHeight, a.font.spaceAdvance]).toEqual([96, 9, 3]);
    expect(measureText(a.font, "Mp5 SD3")).toBe(36);
    // v7 sprites (arrows, plus, sphere) decode too.
    expect(assets.size).toBe(53);
  });
});
