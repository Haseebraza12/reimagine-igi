/**
 * Baked object lightmaps (`objNNNNN_MMMMM.olm` in level lightmaps.res).
 *
 * Layout (recovered from igi.exe FUN_0051daa0; observed on all 1,308 level-1
 * files; evidence in docs/formats.md "Object lighting"):
 *   header 60 bytes: f32 0.12, f32 model version (= the MEF's HSEM f32),
 *     u32 year, month, day, hour, minute, second (bake time, newer than the
 *     model's), u32 _, 0, 1, u32 lightmap count (= D3DR word 1), ...
 *   count x 44-byte entries: +4 u16 w, h; +8 u16 2w, u16 3; ...;
 *     +0x28 s16 w, +0x2a s16 h (the copy the loader uses)
 *   then w*h*4 bytes per lightmap, B G R A (A8R8G8B8); RGB is the final baked
 *   light colour (ambient included), alpha is ignored by the draw.
 * The game rejects (and re-bakes) a file whose magic, version, timestamp or
 * count do not match its model; all level-1 files pass those checks.
 */
import type { DecodedTexture } from "../contracts";

const HEADER = 0x3c;
const ENTRY = 0x2c;
const MAGIC = 0x3df5c28f; // f32 0.12

function fail(message: string): never {
  throw new Error(`OLM: ${message}`);
}

/** Decode the (single) lightmap of an .olm file to RGBA8888 (alpha forced to 255). */
export function decodeOlm(buffer: ArrayBuffer): DecodedTexture {
  const view = new DataView(buffer);
  if (buffer.byteLength < HEADER + ENTRY) fail("file shorter than header + one entry");
  if (view.getUint32(0, true) !== MAGIC) fail("bad magic");
  const count = view.getUint32(44, true);
  if (count !== 1) fail(`expected exactly one lightmap, found ${count}`);
  const width = view.getInt16(HEADER + 0x28, true);
  const height = view.getInt16(HEADER + 0x2a, true);
  if (width < 1 || height < 1 || width > 4096 || height > 4096) fail(`implausible size ${width}x${height}`);
  if (view.getUint16(HEADER + 4, true) !== width || view.getUint16(HEADER + 6, true) !== height) {
    fail("entry size copies disagree");
  }
  const start = HEADER + ENTRY * count;
  if (start + width * height * 4 !== buffer.byteLength) fail("pixel data does not end at EOF");
  const src = new Uint8Array(buffer, start, width * height * 4);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = src[i * 4 + 2];
    rgba[i * 4 + 1] = src[i * 4 + 1];
    rgba[i * 4 + 2] = src[i * 4];
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba, format: "OLM A8R8G8B8 (B,G,R,A stored)" };
}
