/**
 * ILFF/IRES container tests against the real level1 texture archive plus
 * malformed-input checks.
 */
import { describe, expect, it } from "vitest";
import { readIlffMembers } from "../src/loaders/ilff";
import { readRaw } from "./helpers";

const RES_PATH = "missions/location0/level1/textures/level1.res";

describe("readIlffMembers (real level1.res)", () => {
  it("parses at least 100 members from the real archive", async () => {
    const buffer = await readRaw(RES_PATH);
    const members = readIlffMembers(buffer);
    // Measured with tools/igi_formats.py: exactly 393 texture payloads.
    expect(members.length).toBeGreaterThanOrEqual(100);
    expect(members.length).toBe(393);
  });

  it("returns the expected first member names and offsets", async () => {
    const buffer = await readRaw(RES_PATH);
    const members = readIlffMembers(buffer);
    expect(members[0].name).toBe("LOCAL:textures/000_03_1.tex");
    expect(members[0].offset).toBe(0x50);
    expect(members[0].size).toBe(65568);
    expect(members[1].name).toBe("LOCAL:textures/000_02_1.tex");
    expect(members[1].size).toBe(32800);
    expect(members[2].name).toBe("LOCAL:textures/000_06_1.tex");
    // Every payload is a LOOP texture in this archive.
    const magic = new Uint8Array(members[0].payload.slice(0, 4));
    expect(String.fromCharCode(...magic)).toBe("LOOP");
  });

  it("all payload sizes are > 0 and payloads fit inside the file", async () => {
    const buffer = await readRaw(RES_PATH);
    const members = readIlffMembers(buffer);
    let sum = 0;
    for (const member of members) {
      expect(member.size).toBeGreaterThan(0);
      expect(member.offset + member.size).toBeLessThanOrEqual(buffer.byteLength);
      sum += member.size;
    }
    // Container overhead (headers, NAME records, padding) must be positive.
    expect(sum).toBeLessThan(buffer.byteLength);
    expect(sum).toBeGreaterThan(buffer.byteLength / 2);
  });

  it("payloads are copies (mutating one does not affect the source)", async () => {
    const buffer = await readRaw(RES_PATH);
    const members = readIlffMembers(buffer);
    const first = new Uint8Array(members[0].payload);
    const original = first[0];
    first[0] = original ^ 0xff;
    const source = new Uint8Array(buffer)[members[0].offset];
    expect(source).toBe(original);
  });
});

describe("readIlffMembers (malformed input)", () => {
  it("throws on a buffer that is too short", () => {
    expect(() => readIlffMembers(new ArrayBuffer(8))).toThrow(/ILFF/);
  });

  it("throws on garbage bytes", () => {
    const garbage = new Uint8Array(64).fill(0xab);
    expect(() => readIlffMembers(garbage.buffer)).toThrow(/ILFF/);
  });

  it("throws when the root size field disagrees with the buffer length", async () => {
    const buffer = await readRaw(RES_PATH);
    // Truncating the real file makes u32@4 (total size) not match byteLength.
    expect(() => readIlffMembers(buffer.slice(0, 2048))).toThrow(/root size|ILFF/);
  });

  it("throws with the offending offset in the message", () => {
    // Valid root magic but a broken first chunk header (out of bounds).
    const header = new Uint8Array(24);
    header.set([0x49, 0x4c, 0x46, 0x46]); // "ILFF"
    const view = new DataView(header.buffer);
    view.setUint32(4, 24, true); // root size == buffer length
    view.setUint32(8, 4, true); // root alignment 4 -> first chunk at 20
    view.setUint32(12, 0, true);
    header.set([0x49, 0x52, 0x45, 0x53], 16); // "IRES"
    // Chunk at offset 20 has only 4 bytes -> truncated chunk header at 0x14.
    expect(() => readIlffMembers(header.buffer)).toThrow(/truncated chunk header at 0x14/);
  });
});
