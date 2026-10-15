/**
 * LOOP v11 `.tex` bitmap decoder.
 *
 * Port of `texture_preview` from `tools/igi_formats.py`. Layout measured on
 * the local corpus (confidence: observed header, inferred pixels):
 *
 *   offset 0   "LOOP"
 *   offset 4   u32 version == 11
 *   offset 8   u32 format identifier (2 or 3 or 67 observed)
 *   offset 22  u16 width
 *   offset 24  u16 height
 *   offset 26  u16 stored width  (equals width in this corpus)
 *   offset 28  u16 stored height (equals height in this corpus)
 *   offset 30  u16 bytes per pixel (2 or 4 observed)
 *   offset 32  base-level pixel data, width*height*bpp bytes
 *
 * Trailing bytes after the base level (mip chain of the 4-byte formats) are
 * deliberately NOT decoded; they are reported to the caller by being ignored
 * here — the Python reference simply exposes them as `tail_bytes`.
 *
 * Pixel interpretations are INFERRED (never validated against the original
 * renderer) and are labelled in `DecodedTexture.format` accordingly:
 *   (fmt=2, bpp=2)   -> "inferred A1R5G5B5"  (bits 10-14 R, 5-9 G, 0-4 B, 15 A)
 *   (fmt=3|67, bpp=4) -> "inferred BGRA8888" (B,G,R,A byte order)
 * Any other (format, bpp) combination throws — unknown variants are never
 * guessed.
 */
import type { DecodedTexture } from "../contracts";

const HEADER_SIZE = 32;
const MAX_DIMENSION = 4096;

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/**
 * Decode a LOOP v11 `.tex` bitmap to RGBA8888.
 *
 * @throws Error when the buffer is not a supported LOOP v11 texture
 *         (wrong magic/version/dimensions/pixel format) or is truncated.
 */
export function decodeTex(buffer: ArrayBuffer): DecodedTexture {
  if (buffer.byteLength < HEADER_SIZE) {
    throw new Error("LOOP tex: buffer shorter than 32-byte header");
  }
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const magic =
    String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== "LOOP" || readU32(view, 4) !== 11) {
    throw new Error("LOOP tex: only LOOP texture v11 is supported");
  }
  const formatId = readU32(view, 8);
  const width = view.getUint16(22, true);
  const height = view.getUint16(24, true);
  const storedWidth = view.getUint16(26, true);
  const storedHeight = view.getUint16(28, true);
  const bytesPerPixel = view.getUint16(30, true);

  if (width === 0 || height === 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error(`LOOP tex: unsupported texture dimensions ${width}x${height}`);
  }
  if (width !== storedWidth || height !== storedHeight) {
    throw new Error(
      `LOOP tex: different logical/storage dimensions (${width}x${height} vs ` +
        `${storedWidth}x${storedHeight}) need investigation`,
    );
  }
  const supported =
    (formatId === 2 && bytesPerPixel === 2) ||
    ((formatId === 3 || formatId === 67) && bytesPerPixel === 4);
  if (!supported) {
    throw new Error(
      `LOOP tex: unsupported pixel format ${formatId}, bytes/pixel ${bytesPerPixel}`,
    );
  }

  const count = width * height;
  const end = HEADER_SIZE + count * bytesPerPixel;
  if (end > buffer.byteLength) {
    throw new Error("LOOP tex: truncated base-level texture pixels");
  }

  const rgba = new Uint8ClampedArray(count * 4);
  let format: string;
  if (bytesPerPixel === 2) {
    // A1R5G5B5: bit 15 alpha, 10-14 red, 5-9 green, 0-4 blue; expand 5->8 bits.
    for (let i = 0; i < count; i++) {
      const value = view.getUint16(HEADER_SIZE + i * 2, true);
      const r = (value >> 10) & 31;
      const g = (value >> 5) & 31;
      const b = value & 31;
      rgba[i * 4] = (r << 3) | (r >> 2);
      rgba[i * 4 + 1] = (g << 3) | (g >> 2);
      rgba[i * 4 + 2] = (b << 3) | (b >> 2);
      rgba[i * 4 + 3] = (value & 0x8000) !== 0 ? 255 : 0;
    }
    format = "inferred A1R5G5B5";
  } else {
    // BGRA8888 -> RGBA8888.
    for (let i = 0; i < count; i++) {
      const src = HEADER_SIZE + i * 4;
      rgba[i * 4] = bytes[src + 2]; // R
      rgba[i * 4 + 1] = bytes[src + 1]; // G
      rgba[i * 4 + 2] = bytes[src]; // B
      rgba[i * 4 + 3] = bytes[src + 3]; // A
    }
    format = "inferred BGRA8888";
  }

  return { width, height, rgba, format };
}

/**
 * LOOP v9 multi-layer texture (terrain.tex).
 *
 * Measured on level 1's terrain.tex (confidence: observed):
 *   0x1C i32 footer offset (590452)   0x20 i32 layer count (18)
 *   0x28 i32 width, 0x2C height (128 x 128), 0x30 i32 mode (2)
 *   0x34 + 32 * i: i32 pixel offset, i32 mode, i16 row bytes, i16 width,
 *                  i16 height, i16 _, 16 reserved bytes
 *   Layers are packed back to back from 628; the last ends exactly at the
 *   footer, which starts with "LOOP".
 * Only mode 2 (A1R5G5B5) layers occur; other modes throw.
 */
export function decodeTexLayers(buffer: ArrayBuffer): DecodedTexture[] {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  if (buffer.byteLength < 0x34 || String.fromCharCode(...bytes.subarray(0, 4)) !== "LOOP" || readU32(view, 4) !== 9) {
    throw new Error("LOOP tex: expected a LOOP v9 layered texture");
  }
  const footer = view.getInt32(0x1c, true);
  const count = view.getInt32(0x20, true);
  if (count < 1 || count > 256 || 0x34 + count * 32 > buffer.byteLength) throw new Error(`LOOP tex: bad layer count ${count}`);
  if (footer + 4 > buffer.byteLength || String.fromCharCode(...bytes.subarray(footer, footer + 4)) !== "LOOP") {
    throw new Error("LOOP tex: v9 footer is missing");
  }
  const layers: DecodedTexture[] = [];
  for (let i = 0; i < count; i++) {
    const at = 0x34 + i * 32;
    const offset = view.getInt32(at, true);
    const mode = view.getInt32(at + 4, true);
    const rowBytes = view.getInt16(at + 8, true);
    const width = view.getInt16(at + 10, true);
    const height = view.getInt16(at + 12, true);
    if (mode !== 2 || rowBytes !== width * 2) throw new Error(`LOOP tex: layer ${i} has unsupported mode ${mode}`);
    if (width < 1 || height < 1 || offset < 0 || offset + rowBytes * height > footer) {
      throw new Error(`LOOP tex: layer ${i} lies outside the pixel area`);
    }
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < width * height; p++) {
      const value = view.getUint16(offset + p * 2, true);
      const r = (value >> 10) & 31;
      const g = (value >> 5) & 31;
      const b = value & 31;
      rgba[p * 4] = (r << 3) | (r >> 2);
      rgba[p * 4 + 1] = (g << 3) | (g >> 2);
      rgba[p * 4 + 2] = (b << 3) | (b >> 2);
      rgba[p * 4 + 3] = 255; // terrain layers are opaque
    }
    layers.push({ width, height, rgba, format: "inferred A1R5G5B5 (v9 layer)" });
  }
  return layers;
}
