/**
 * LOOP v11 texture decode tests against real game data:
 *  - sky_layer1.tex (standalone 64x64 BGRA file, fmt=3 — verified against
 *    the raw bytes: offset 8 holds u32 3, offset 30 holds bpp 4)
 *  - a texture extracted from the body of level1.res (fmt=2 A1R5G5B5)
 */
import { describe, expect, it } from "vitest";
import { decodeTex } from "../src/loaders/loop-tex";
import { readIlffMembers } from "../src/loaders/ilff";
import { readRaw } from "./helpers";

const SKY_PATH = "missions/location0/common/textures/sky_layer1.tex";
const RES_PATH = "missions/location0/level1/textures/level1.res";
const TERRAIN_TEX_PATH = "missions/location0/level1/terrain/terrain.tex";

describe("decodeTex (sky_layer1.tex, fmt=3, bpp=4)", () => {
  it("decodes to 64x64 RGBA", async () => {
    const texture = decodeTex(await readRaw(SKY_PATH));
    expect(texture.width).toBe(64);
    expect(texture.height).toBe(64);
    expect(texture.rgba.length).toBe(64 * 64 * 4);
    expect(texture.format).toBe("inferred BGRA8888");
  });

  it("does not produce identical pixels everywhere", async () => {
    const texture = decodeTex(await readRaw(SKY_PATH));
    const first = texture.rgba[0];
    let different = 0;
    for (let i = 0; i < texture.rgba.length; i += 4) {
      if (texture.rgba[i] !== first) different++;
    }
    expect(different).toBeGreaterThan(0);
  });

  it("swaps BGRA storage into RGBA order (verified against raw bytes)", async () => {
    const buffer = await readRaw(SKY_PATH);
    const texture = decodeTex(buffer);
    const raw = new Uint8Array(buffer);
    // Base pixels start at offset 32: raw bytes are B,G,R,A.
    expect(texture.rgba[0]).toBe(raw[34]); // R
    expect(texture.rgba[1]).toBe(raw[33]); // G
    expect(texture.rgba[2]).toBe(raw[32]); // B
    expect(texture.rgba[3]).toBe(raw[35]); // A
  });
});

describe("decodeTex (textures from level1.res body, fmt=2, bpp=2)", () => {
  it("decodes a LOOP member extracted from the ILFF container", async () => {
    const members = readIlffMembers(await readRaw(RES_PATH));
    const member = members.find((m) => {
      const magic = new Uint8Array(m.payload.slice(0, 4));
      return String.fromCharCode(...magic) === "LOOP";
    });
    expect(member).toBeDefined();
    const texture = decodeTex(member!.payload);
    // First member measured: 256x128, format 2 (A1R5G5B5).
    expect(texture.width).toBe(256);
    expect(texture.height).toBe(128);
    expect(texture.rgba.length).toBe(256 * 128 * 4);
    expect(texture.format).toBe("inferred A1R5G5B5");
    let different = 0;
    const first = texture.rgba[0];
    for (let i = 0; i < texture.rgba.length; i += 4) {
      if (texture.rgba[i] !== first) different++;
    }
    expect(different).toBeGreaterThan(0);
  });

  it("expands 5-bit channels to 8 bits with the standard bit replicate", () => {
    // One pixel: A1R5G5B5 value 0xFC00 = alpha 1, r=31, g=0, b=0.
    const buffer = new ArrayBuffer(32 + 2);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    bytes.set([0x4c, 0x4f, 0x4f, 0x50], 0); // LOOP
    view.setUint32(4, 11, true); // version
    view.setUint32(8, 2, true); // format
    view.setUint16(22, 1, true); // width
    view.setUint16(24, 1, true); // height
    view.setUint16(26, 1, true); // stored width
    view.setUint16(28, 1, true); // stored height
    view.setUint16(30, 2, true); // bpp
    view.setUint16(32, 0xfc00, true); // pixel
    const texture = decodeTex(buffer);
    expect(Array.from(texture.rgba)).toEqual([255, 0, 0, 255]);
  });
});

describe("decodeTex (rejected inputs)", () => {
  it("throws on LOOP v9 (terrain.tex)", async () => {
    const buffer = await readRaw(TERRAIN_TEX_PATH);
    expect(() => decodeTex(buffer)).toThrow(/v11/);
  });

  it("throws on an unknown (format, bpp) combination", () => {
    const buffer = new ArrayBuffer(32 + 4);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    bytes.set([0x4c, 0x4f, 0x4f, 0x50], 0);
    view.setUint32(4, 11, true);
    view.setUint32(8, 5, true); // format 5 is not in the supported set
    view.setUint16(22, 2, true);
    view.setUint16(24, 2, true);
    view.setUint16(26, 2, true);
    view.setUint16(28, 2, true);
    view.setUint16(30, 2, true);
    expect(() => decodeTex(buffer)).toThrow(/unsupported pixel format 5/);
  });

  it("throws when the pixel data is truncated", async () => {
    const buffer = await readRaw(SKY_PATH);
    expect(() => decodeTex(buffer.slice(0, 100))).toThrow(/truncated/);
  });

  it("throws on a non-LOOP buffer", () => {
    expect(() => decodeTex(new ArrayBuffer(64))).toThrow(/LOOP/);
  });
});
