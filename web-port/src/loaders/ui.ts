/**
 * Interface assets and HUD layout of Project I.G.I. (igi.exe, 2000):
 * sprites (.spr), tiled pictures (.pic), bitmap fonts (.fnt), and the screen
 * layout rules the game uses to draw the in-game HUD, radio/status messages and
 * the loading screen.  Full evidence and tables: docs/hud.md.
 * Reference implementation: tools/igi_ui.py.
 *
 * Labels: observed = measured on the files; recovered = read from igi.exe
 * (function addresses given); inferred = neither.
 *
 * ## LOOP v9 sprite / picture  (loader FUN_004ac9f0 "Invalid sprite file: %s"; recovered)
 *
 *   +0x00 "LOOP"  +0x04 u32 9   +0x12 s16 5 (passed to the texture creator)
 *   +0x18 u32 palette offset (0 in every shipped file; other values rejected here)
 *   +0x1c u32 tile-map footer offset (LOOP v6)
 *   +0x20 u32 frame count  +0x28 u32 width  +0x2c u32 height  +0x30 u32 format
 *   +0x34 + 32*i  frame: u32 pixel offset (file-relative), u32 format,
 *                 u16 row bytes, u16 width, u16 height, s16 advance (+0xe),
 *                 s16 x offset (+0x16), s16 y offset (+0x18), u32 flags (+0x1c)
 *   LOOP v6 footer: +0x08 u32 width px, +0x0c u32 height px (0xCCCCCCCC when
 *   unset), +0x10 u32 columns, +0x14 u32 rows, then 16-byte cells whose byte
 *   +12 is "frame index + 1" (FUN_004ad820 reads only that byte).  The footer
 *   ends exactly at EOF in all 109 UI sprites (observed).
 *   A .pic (loading.pic, mainmenu.pic, logo.pic) is a 10x15 (or 5x4, 7x4) grid
 *   of 64x32 tiles drawn as a fixed grid: cell (c, r) at (x + 64c, y + 32r).
 *
 * ## LOOP v7 sprite (computer.res only; same loader, recovered)
 *   +0x18 palette, +0x1c tile map, +0x20 count, +0x28 w, +0x2c h, +0x30 format,
 *   40-byte frames at +0x34: +0 offset, +4 row bytes, +8 w, +0xc h,
 *   +0x10 advance, +0x20 x, +0x24 y.
 *
 * ## LOOP v10 font (same loader, recovered; all 12 fonts parse, observed)
 *   +0x0c u32 palette (0)   +0x10 u32 glyph count   +0x14 u32 pixel base
 *   +0x18 u16 proportional flag (non-zero: pen advances per glyph)
 *   +0x1a u16 space advance (pen step for characters without a glyph)
 *   +0x1c u16 (not read by the loader; 32 in every font)
 *   +0x1e u16 line height   +0x20 u16 cell width   +0x22 u16 format
 *   +0x24 u8[256] character -> glyph number (1-based, 0 = none)
 *   +0x124 + 20*g (g = 1..count): u32 pixel offset (from the base), u32 format,
 *        s16 row bytes, s16 width, s16 height, s16 x offset, s16 y offset,
 *        s16 advance.
 *
 * Pixel formats (observed; same codes as LOOP v11 .tex): 2 = A1R5G5B5 with
 * bit 15 = opaque, 3 = 32-bit stored B,G,R,A.  No other code occurs.
 *
 * ## Text (recovered FUN_004adb90 draw, FUN_004ad990 width)
 *   Pen starts at x (flag 0x80: x - width/2 integer-halved; 0x100: x - width).
 *   Each glyph quad covers (pen + xoff, y + yoff) .. + (w, h); the pen moves by
 *   the glyph advance or by the space advance for unmapped characters; the line
 *   width excludes trailing unmapped characters.  Glyphs and sprites are drawn
 *   1:1 in screen pixels at every resolution; only anchor points scale.
 */
import type { DecodedTexture } from "../contracts";
import { readIlffMembers } from "./ilff";
import { x87Fistp } from "./x87";

// ---------------------------------------------------------------------------
// Low-level readers
// ---------------------------------------------------------------------------

function need(view: DataView, offset: number, size: number, what: string): void {
  if (offset < 0 || offset + size > view.byteLength) {
    throw new Error(`${what} outside file at 0x${offset.toString(16)}`);
  }
}

function u16(view: DataView, offset: number, what: string): number {
  need(view, offset, 2, what);
  return view.getUint16(offset, true);
}

function s16(view: DataView, offset: number, what: string): number {
  need(view, offset, 2, what);
  return view.getInt16(offset, true);
}

function u32(view: DataView, offset: number, what: string): number {
  need(view, offset, 4, what);
  return view.getUint32(offset, true);
}

function loopVersion(view: DataView, name: string): number {
  if (view.byteLength < 8) throw new Error(`${name}: shorter than a LOOP header at 0x0`);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== "LOOP") throw new Error(`${name}: missing LOOP magic at 0x0`);
  return view.getUint32(4, true);
}

/** Pixel format codes used by every UI image (observed). */
export type UiPixelFormat = 2 | 3;

/**
 * Decode one frame's pixels to RGBA8888 (rows top-down).
 * Format 2 = A1R5G5B5 (bit 15 opaque), 3 = B,G,R,A bytes.
 */
export function decodeUiPixels(
  view: DataView,
  offset: number,
  format: number,
  rowBytes: number,
  width: number,
  height: number,
  what: string,
): Uint8ClampedArray {
  const bpp = format === 2 ? 2 : format === 3 ? 4 : 0;
  if (bpp === 0) throw new Error(`${what}: unsupported pixel format ${format}`);
  if (width < 1 || height < 1 || width > 4096 || height > 4096 || rowBytes < width * bpp) {
    throw new Error(`${what}: bad frame size ${width}x${height} (row bytes ${rowBytes})`);
  }
  need(view, offset, rowBytes * (height - 1) + width * bpp, `${what} pixels`);
  const out = new Uint8ClampedArray(width * height * 4);
  let o = 0;
  for (let y = 0; y < height; y++) {
    const row = offset + y * rowBytes;
    if (bpp === 2) {
      for (let x = 0; x < width; x++) {
        const v = view.getUint16(row + x * 2, true);
        const r = (v >> 10) & 31;
        const g = (v >> 5) & 31;
        const b = v & 31;
        out[o] = (r << 3) | (r >> 2);
        out[o + 1] = (g << 3) | (g >> 2);
        out[o + 2] = (b << 3) | (b >> 2);
        out[o + 3] = v & 0x8000 ? 255 : 0;
        o += 4;
      }
    } else {
      for (let x = 0; x < width; x++) {
        const p = row + x * 4;
        out[o] = view.getUint8(p + 2);
        out[o + 1] = view.getUint8(p + 1);
        out[o + 2] = view.getUint8(p);
        out[o + 3] = view.getUint8(p + 3);
        o += 4;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sprites and pictures
// ---------------------------------------------------------------------------

export interface UiFrame {
  width: number;
  height: number;
  /** Added to the draw position (FUN_004ab0e0 / FUN_004ab3a0). */
  x: number;
  y: number;
  /** Pen step when the sprite is drawn as a tile row (64 for .pic tiles). */
  advance: number;
  format: UiPixelFormat;
  flags: number;
  rgba: Uint8ClampedArray;
}

export interface UiTileMap {
  /** Picture size from the footer (0 when unset / 0xCCCCCCCC). */
  width: number;
  height: number;
  columns: number;
  rows: number;
  /** Per cell: frame index + 1 (0 = empty). */
  cells: Uint8Array;
}

export interface UiSprite {
  version: 7 | 9;
  /** Sprite (tile) size from the header; FUN_004acf50 / FUN_004acf70 return these. */
  width: number;
  height: number;
  format: number;
  frames: UiFrame[];
  tiles: UiTileMap | null;
}

function readTileMap(view: DataView, offset: number, name: string): UiTileMap {
  if (loopVersionAt(view, offset) !== 6) {
    throw new Error(`${name}: tile-map footer (LOOP v6) missing at 0x${offset.toString(16)}`);
  }
  const rawW = u32(view, offset + 8, `${name} tile map width`);
  const rawH = u32(view, offset + 0xc, `${name} tile map height`);
  const columns = u32(view, offset + 0x10, `${name} tile map columns`);
  const rows = u32(view, offset + 0x14, `${name} tile map rows`);
  if (columns < 1 || rows < 1 || columns * rows > 4096) {
    throw new Error(`${name}: bad tile map ${columns}x${rows} at 0x${(offset + 0x10).toString(16)}`);
  }
  const end = offset + 0x18 + columns * rows * 16;
  if (end !== view.byteLength) {
    throw new Error(`${name}: tile map ends at 0x${end.toString(16)}, file at 0x${view.byteLength.toString(16)}`);
  }
  const cells = new Uint8Array(columns * rows);
  for (let i = 0; i < cells.length; i++) cells[i] = view.getUint8(offset + 0x24 + 16 * i);
  const unset = (v: number) => (v === 0xcccccccc || v > 8192 ? 0 : v);
  return { width: unset(rawW), height: unset(rawH), columns, rows, cells };
}

function loopVersionAt(view: DataView, offset: number): number {
  need(view, offset, 8, "LOOP footer");
  const magic = String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
  return magic === "LOOP" ? view.getUint32(offset + 4, true) : -1;
}

/** Decode a LOOP v9 (or v7) `.spr` / `.pic`.  Throws naming the offset on any anomaly. */
export function readUiSprite(buffer: ArrayBuffer, name = "sprite"): UiSprite {
  const view = new DataView(buffer);
  const version = loopVersion(view, name);
  if (version !== 9 && version !== 7) throw new Error(`${name}: LOOP v${version} at 0x4 is not a sprite`);
  need(view, 0, 0x34, `${name} header`);
  const palette = u32(view, 0x18, `${name} palette`);
  if (palette !== 0) throw new Error(`${name}: palette at 0x18 (0x${palette.toString(16)}) is not supported`);
  const count = u32(view, 0x20, `${name} frame count`);
  const width = u32(view, 0x28, `${name} width`);
  const height = u32(view, 0x2c, `${name} height`);
  const format = u32(view, 0x30, `${name} format`);
  const stride = version === 9 ? 32 : 40;
  if (count < 1 || count > 4096 || 0x34 + count * stride > view.byteLength) {
    throw new Error(`${name}: bad frame count ${count} at 0x20`);
  }
  const frames: UiFrame[] = [];
  for (let i = 0; i < count; i++) {
    const r = 0x34 + i * stride;
    const what = `${name} frame ${i} (record 0x${r.toString(16)})`;
    let offset: number;
    let fmt: number;
    let rowBytes: number;
    let w: number;
    let h: number;
    let advance: number;
    let x: number;
    let y: number;
    let flags: number;
    if (version === 9) {
      offset = u32(view, r, what);
      fmt = u32(view, r + 4, what);
      rowBytes = u16(view, r + 8, what);
      w = u16(view, r + 0xa, what);
      h = u16(view, r + 0xc, what);
      advance = s16(view, r + 0xe, what);
      x = s16(view, r + 0x16, what);
      y = s16(view, r + 0x18, what);
      flags = u32(view, r + 0x1c, what);
    } else {
      offset = u32(view, r, what);
      rowBytes = u32(view, r + 4, what);
      w = u32(view, r + 8, what);
      h = u32(view, r + 0xc, what);
      advance = view.getInt32(r + 0x10, true);
      x = view.getInt32(r + 0x20, true);
      y = view.getInt32(r + 0x24, true);
      fmt = format;
      flags = 0;
    }
    const rgba = decodeUiPixels(view, offset, fmt, rowBytes, w, h, what);
    frames.push({ width: w, height: h, x, y, advance, format: fmt as UiPixelFormat, flags, rgba });
  }
  const footer = u32(view, 0x1c, `${name} footer offset`);
  const tiles = footer ? readTileMap(view, footer, name) : null;
  return { version: version as 7 | 9, width, height, format, frames, tiles };
}

/** Frame as a DecodedTexture (shares the pixel array). */
export function uiFrameTexture(frame: UiFrame): DecodedTexture {
  return { width: frame.width, height: frame.height, rgba: frame.rgba, format: frame.format === 2 ? "A1R5G5B5" : "BGRA8888" };
}

/**
 * Assemble a tiled picture (.pic) into one image: the tile grid
 * (columns x width, rows x height) cropped to the footer's picture size.
 * loading.pic / loading_us.pic / mainmenu.pic -> 640x480 (observed).
 */
export function composeUiPicture(sprite: UiSprite, name = "picture"): DecodedTexture {
  const t = sprite.tiles;
  if (!t) throw new Error(`${name}: no tile map (footer offset at 0x1c is 0)`);
  const gridW = t.columns * sprite.width;
  const gridH = t.rows * sprite.height;
  const W = t.width > 0 && t.width <= gridW ? t.width : gridW;
  const H = t.height > 0 && t.height <= gridH ? t.height : gridH;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < t.cells.length; i++) {
    const cell = t.cells[i];
    if (cell === 0) continue;
    const f = sprite.frames[cell - 1];
    if (!f) throw new Error(`${name}: tile cell ${i} names missing frame ${cell}`);
    const cx = (i % t.columns) * sprite.width + f.x;
    const cy = Math.floor(i / t.columns) * sprite.height + f.y;
    for (let y = 0; y < f.height; y++) {
      const py = cy + y;
      if (py < 0 || py >= H) continue;
      for (let x = 0; x < f.width; x++) {
        const px = cx + x;
        if (px < 0 || px >= W) continue;
        const s = (y * f.width + x) * 4;
        const d = (py * W + px) * 4;
        out[d] = f.rgba[s];
        out[d + 1] = f.rgba[s + 1];
        out[d + 2] = f.rgba[s + 2];
        out[d + 3] = f.rgba[s + 3];
      }
    }
  }
  return { width: W, height: H, rgba: out, format: "LOOP v9 tiled picture" };
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

export interface UiGlyph {
  width: number;
  height: number;
  x: number;
  y: number;
  advance: number;
  rgba: Uint8ClampedArray;
}

export interface UiFont {
  proportional: boolean;
  spaceAdvance: number;
  lineHeight: number;
  cellWidth: number;
  /** Character code -> glyph number (1-based, 0 = no glyph). */
  charMap: Uint8Array;
  glyphs: UiGlyph[];
}

/** ILFF chunks of a file: tag, size, next (relative, 0 = last), data at +16 [recovered FUN_004b7490 / FUN_004b7470]. */
function ilffChunks(view: DataView, first: number, name: string): Map<string, { offset: number; size: number }[]> {
  const out = new Map<string, { offset: number; size: number }[]>();
  const tagAt = (o: number) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  for (let p = first, guard = 0; p !== -1 && guard < 4096; guard++) {
    need(view, p, 16, `${name} chunk header`);
    const tag = tagAt(p);
    const size = view.getUint32(p + 4, true);
    const next = view.getUint32(p + 12, true);
    need(view, p + 16, size, `${name} ${tag} chunk`);
    const list = out.get(tag) ?? [];
    list.push({ offset: p + 16, size });
    out.set(tag, list);
    p = next ? p + next : -1;
  }
  return out;
}

/**
 * Decode an ILFF FONT `.fnt` (the full game's fonts; the one-mission build has LOOP v10 fonts)
 * [recovered FUN_004b6720 0x4b6760-0x4b6890 of the full-game exe]:
 *   FNTH: u32 proportional, glyph records, ?, space advance, cell width, line height;
 *   TRAN: 256 x u16, low byte = glyph number of the character (1-based: record n - 1; 0 = none);
 *   ANMF: 40-byte records {f32 ?, u0, v0, u1, v1; s16 texture @0x14, width, height, advance, ..., x @0x22, y @0x24}
 *     (FUN_004b6540's last five arguments; the LOOP paths pass 0, 0, 0, 1.0, 1.0);
 *   TEXH + BODY pairs: the textures (u16 width @0xe, height @0x10, bits @0x16; u32 format @0, as decodeUiPixels).
 * Glyph g (1..count, the UiFont charMap convention) is ANMF record g - 1.
 */
export function readIlffFont(buffer: ArrayBuffer, name = "font"): UiFont {
  const view = new DataView(buffer);
  need(view, 0, 20, `${name} ILFF header`);
  const tag = (o: number) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (tag(0) !== "ILFF" || tag(16) !== "FONT") throw new Error(`${name}: not an ILFF FONT`);
  const chunks = ilffChunks(view, 20, name);
  const one = (t: string) => {
    const c = chunks.get(t)?.[0];
    if (!c) throw new Error(`${name}: no ${t} chunk`);
    return c;
  };
  const fnth = one("FNTH");
  const tran = one("TRAN");
  const anmf = one("ANMF");
  const proportional = view.getUint32(fnth.offset, true) !== 0;
  const records = view.getUint32(fnth.offset + 4, true);
  const spaceAdvance = view.getUint32(fnth.offset + 12, true);
  const cellWidth = view.getUint32(fnth.offset + 16, true);
  const lineHeight = view.getUint32(fnth.offset + 20, true);
  if (records < 1 || records > 255 || records * 40 > anmf.size) throw new Error(`${name}: bad FNTH glyph count ${records}`);
  // Textures, in TEXH / BODY order.
  const heads = chunks.get("TEXH") ?? [];
  const bodies = chunks.get("BODY") ?? [];
  if (!heads.length || heads.length !== bodies.length) throw new Error(`${name}: TEXH / BODY chunks do not pair up`);
  const textures = heads.map((h, i) => {
    const format = view.getUint32(h.offset, true);
    const width = view.getUint16(h.offset + 0xe, true);
    const height = view.getUint16(h.offset + 0x10, true);
    const bits = view.getUint16(h.offset + 0x16, true);
    const rowBytes = (bits * view.getUint16(h.offset + 0x12, true)) >> 3;
    const rgba = decodeUiPixels(view, bodies[i].offset, format, rowBytes, width, height, `${name} texture ${i}`);
    return { width, height, rgba };
  });
  const charMap = new Uint8Array(256);
  for (let c = 0; c < 256; c++) {
    const g = view.getUint8(tran.offset + 2 * c);
    if (g > records) throw new Error(`${name}: character ${c} maps to glyph ${g} > ${records}`);
    charMap[c] = g;
  }
  const glyphs: UiGlyph[] = [];
  for (let g = 0; g < records; g++) {
    const r = anmf.offset + g * 40;
    const u = view.getFloat32(r + 4, true);
    const v = view.getFloat32(r + 8, true);
    const texture = textures[view.getInt16(r + 0x14, true)];
    if (!texture) throw new Error(`${name}: glyph ${g} names a missing texture`);
    const width = view.getInt16(r + 0x16, true);
    const height = view.getInt16(r + 0x18, true);
    const advance = view.getInt16(r + 0x1a, true);
    const x = view.getInt16(r + 0x22, true);
    const y = view.getInt16(r + 0x24, true);
    const px = Math.round(u * texture.width);
    const py = Math.round(v * texture.height);
    const rgba = new Uint8ClampedArray(Math.max(0, width) * Math.max(0, height) * 4);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const sx = px + col;
        const sy = py + row;
        if (sx < 0 || sy < 0 || sx >= texture.width || sy >= texture.height) continue;
        rgba.set(texture.rgba.subarray((sy * texture.width + sx) * 4, (sy * texture.width + sx) * 4 + 4), (row * width + col) * 4);
      }
    }
    glyphs.push({ width, height, x, y, advance, rgba });
  }
  return { proportional, spaceAdvance, lineHeight, cellWidth, charMap, glyphs };
}

/** A `.fnt` of either build: LOOP v10 (one-mission build) or ILFF FONT (full game). */
export function readAnyFont(buffer: ArrayBuffer, name = "font"): UiFont {
  const view = new DataView(buffer);
  if (view.byteLength >= 20 && view.getUint32(0, true) === 0x46464c49) return readIlffFont(buffer, name);
  return readFont(buffer, name);
}

/** Decode a LOOP v10 `.fnt`.  Throws naming the offset on any anomaly. */
export function readFont(buffer: ArrayBuffer, name = "font"): UiFont {
  const view = new DataView(buffer);
  const version = loopVersion(view, name);
  if (version !== 10) throw new Error(`${name}: LOOP v${version} at 0x4 is not a font (v10)`);
  need(view, 0, 0x124, `${name} header`);
  const palette = u32(view, 0xc, `${name} palette`);
  if (palette !== 0) throw new Error(`${name}: palette at 0xc (0x${palette.toString(16)}) is not supported`);
  const count = u32(view, 0x10, `${name} glyph count`);
  const base = u32(view, 0x14, `${name} pixel base`);
  if (count < 1 || count > 255) throw new Error(`${name}: bad glyph count ${count} at 0x10`);
  if (0x124 + (count + 1) * 20 > base || base > view.byteLength) {
    throw new Error(`${name}: pixel base 0x${base.toString(16)} at 0x14 overlaps the glyph table`);
  }
  const charMap = new Uint8Array(buffer.slice(0x24, 0x124));
  for (let c = 0; c < 256; c++) {
    if (charMap[c] > count) {
      throw new Error(`${name}: character ${c} maps to glyph ${charMap[c]} > ${count} at 0x${(0x24 + c).toString(16)}`);
    }
  }
  const glyphs: UiGlyph[] = [];
  for (let g = 1; g <= count; g++) {
    const r = 0x124 + g * 20;
    const what = `${name} glyph ${g} (record 0x${r.toString(16)})`;
    const offset = u32(view, r, what);
    const fmt = u32(view, r + 4, what);
    const rowBytes = s16(view, r + 8, what);
    const w = s16(view, r + 10, what);
    const h = s16(view, r + 12, what);
    const x = s16(view, r + 14, what);
    const y = s16(view, r + 16, what);
    const advance = s16(view, r + 18, what);
    const rgba = decodeUiPixels(view, base + offset, fmt, rowBytes, w, h, what);
    glyphs.push({ width: w, height: h, x, y, advance, rgba });
  }
  return {
    proportional: u16(view, 0x18, name) !== 0,
    spaceAdvance: u16(view, 0x1a, name),
    lineHeight: u16(view, 0x1e, name),
    cellWidth: u16(view, 0x20, name),
    charMap,
    glyphs,
  };
}

function charCode(ch: string, at: number, text: string): number {
  const c = ch.charCodeAt(0);
  if (c > 255) throw new Error(`text "${text}" has non-Latin-1 character at index ${at}`);
  return c;
}

/** Line width exactly as FUN_004ad990 computes it (trailing unmapped characters do not count). */
export function measureText(font: UiFont, text: string): number {
  if (!font.proportional) {
    let last = 0;
    for (let i = 0; i < text.length; i++) if (font.charMap[charCode(text[i], i, text)]) last = (i + 1) * font.cellWidth;
    return last;
  }
  let pen = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const g = font.charMap[charCode(text[i], i, text)];
    if (g === 0) pen += font.spaceAdvance;
    else {
      pen += font.glyphs[g - 1].advance;
      last = pen;
    }
  }
  return last;
}

export type TextAlign = "left" | "centre" | "right";

export interface PlacedGlyph {
  glyph: number; // 0-based index into font.glyphs
  x: number;
  y: number;
}

/**
 * Glyph placement of one line as FUN_004adb90 draws it: align flag 0x80 =
 * centre (x - trunc(width / 2)), 0x100 = right (x - width).
 */
export function layoutText(font: UiFont, text: string, x: number, y: number, align: TextAlign = "left"): PlacedGlyph[] {
  const width = measureText(font, text);
  let pen = align === "centre" ? x - Math.trunc(width / 2) : align === "right" ? x - width : x;
  const out: PlacedGlyph[] = [];
  for (let i = 0; i < text.length; i++) {
    const g = font.charMap[charCode(text[i], i, text)];
    if (g !== 0) {
      const gl = font.glyphs[g - 1];
      out.push({ glyph: g - 1, x: pen + gl.x, y: y + gl.y });
      pen += font.proportional ? gl.advance : font.cellWidth;
    } else {
      pen += font.proportional ? font.spaceAdvance : font.cellWidth;
    }
  }
  return out;
}

export interface FontAtlas {
  texture: DecodedTexture;
  /** Per glyph (0-based): rectangle in the atlas. */
  rects: Array<{ x: number; y: number; width: number; height: number }>;
}

/** Pack every glyph into one RGBA atlas (1-pixel transparent gutter). */
export function buildFontAtlas(font: UiFont, columns = 16): FontAtlas {
  const cw = Math.max(...font.glyphs.map((g) => g.width)) + 1;
  const ch = Math.max(...font.glyphs.map((g) => g.height)) + 1;
  const rows = Math.ceil(font.glyphs.length / columns);
  const W = columns * cw;
  const H = rows * ch;
  const rgba = new Uint8ClampedArray(W * H * 4);
  const rects = font.glyphs.map((g, i) => {
    const ox = (i % columns) * cw;
    const oy = Math.floor(i / columns) * ch;
    for (let y = 0; y < g.height; y++) {
      rgba.set(g.rgba.subarray(y * g.width * 4, (y + 1) * g.width * 4), ((oy + y) * W + ox) * 4);
    }
    return { x: ox, y: oy, width: g.width, height: g.height };
  });
  return { texture: { width: W, height: H, rgba, format: "font atlas RGBA" }, rects };
}

// ---------------------------------------------------------------------------
// Archives
// ---------------------------------------------------------------------------

export type UiAsset = { kind: "sprite"; sprite: UiSprite } | { kind: "font"; font: UiFont };

/**
 * Decode every sprite/picture/font member of a UI `.res` archive, keyed by the
 * member's file name (e.g. "health.spr", "font3.fnt", "loading.pic").
 */
export function readUiArchive(buffer: ArrayBuffer): Map<string, UiAsset> {
  const out = new Map<string, UiAsset>();
  for (const m of readIlffMembers(buffer)) {
    const short = m.name.slice(m.name.lastIndexOf("/") + 1);
    if (short.endsWith(".fnt")) out.set(short, { kind: "font", font: readAnyFont(m.payload, m.name) });
    else if (short.endsWith(".spr") || short.endsWith(".pic")) {
      out.set(short, { kind: "sprite", sprite: readUiSprite(m.payload, m.name) });
    }
  }
  return out;
}

/** Original files the HUD and screens read (paths relative to the installation). */
export const UI_PATHS = {
  /** HUD sprites (StatusScreen, FUN_00484920). */
  status: "screens/game/status/status.res",
  /** HUD text font computer/font3.fnt, map computer (FUN_00469c10). Not staged by stage-raw.mjs yet. */
  computer: "computer/computer.res",
  /** Radio-message fonts font1.fnt / font4.fnt and the in-game menu (ingamemenu.qvm). */
  ingameMenu: "menusystem/ingamemenu.res",
  ingameMenuScript: "menusystem/ingamemenu.qvm",
  /** Loading screen pictures (FUN_00488860). */
  loading: "menusystem/loadingscreen.res",
  mainMenu: "menusystem/menusystem.res",
  mainMenuScript: "menusystem/mainmenu.qvm",
  missionSprites: "menusystem/missionsprites.res",
  menuStrings: "language/english/menusystem.res",
  messages: "language/english/messages.res",
  /** Binocular / sniper overlays (common/sprites/sprites.res). */
  sprites: "common/sprites/sprites.res",
  /** Radio-message sound "message" (common/sounds/sounds.res, ILSF PCM). */
  sounds: "common/sounds/sounds.res",
} as const;

// ---------------------------------------------------------------------------
// Drawing rules shared by every 2D primitive (recovered)
// ---------------------------------------------------------------------------

/**
 * Vertex colour byte for a colour argument c given in the engine's 0..255
 * "x/128" scale (FUN_004aace0 & co. multiply by 1/128, FUN_00504300 converts
 * with trunc(v * 255): fld; fmul 255.0f; fistp at 0x5043cf, chop mode).  128
 * means "texture as-is" (255); 64 gives 127, 100 gives 199.  Values from
 * 256 x 128/255 = 128.502 up overflow the byte; the carry goes into the next
 * higher channel (the game does not clamp).  Returns the byte and the carry.
 */
export function vertexColourByte(c: number): { byte: number; carry: number } {
  const v = x87Fistp((c / 128) * 255);
  return { byte: v & 0xff, carry: v >> 8 };
}

/**
 * The game's float -> int conversion (x87 FISTP). igi.exe runs the FPU in
 * chop mode (FUN_004966d0; docs/gameplay.md "FPU rounding mode"), so despite
 * its historical name this TRUNCATES toward zero (4.5 -> 4, 2.7 -> 2,
 * -1.75 -> -1). Kept for existing callers; new code should call x87Fistp.
 * @deprecated use x87Fistp (x87.ts)
 */
export function roundHalfEven(x: number): number {
  return x87Fistp(x);
}

/** Pixel the original's D3D rasteriser starts a quad edge at (vertices are offset by -0.5). */
export function pixelStart(x: number): number {
  return Math.ceil(x - 0.5);
}

/**
 * Blend modes of the 2D path (FUN_00504e40, D3D7 render states).  Every HUD
 * primitive blends; texture stage = texture x vertex colour (MODULATE for both
 * colour and alpha), point sampling and clamp unless flag 0x1000000 (bilinear).
 */
export const UI_BLEND = {
  /** default: SRCALPHA, INVSRCALPHA */
  alpha: 0,
  /** flag 0x08: SRCALPHA, ONE (additive; menu glow) */
  additive: 0x08,
  /** flag 0x10: ZERO, INVSRCCOLOR */
  darken: 0x10,
  /** flag 0x80000000: ZERO, SRCCOLOR (modulate) */
  modulate: 0x80000000,
} as const;

/**
 * Draw order (recovered FUN_00495b20 push-front + FUN_00495aa0 walk): HUD
 * primitives queued in a frame are drawn in REVERSE order of submission.  The
 * tables below list elements in submission order; draw them bottom-up.
 */
export const HUD_DRAW_ORDER_REVERSED = true;

// ---------------------------------------------------------------------------
// HUD layout (StatusScreen, recovered; positions = fraction x screen size)
// ---------------------------------------------------------------------------

/** Game logic rate: 30 ticks per second (FUN_004029a0(0x1e), "Time Left" /30). */
export const GAME_TICKS_PER_SECOND = 30;

/** Fractions read from igi.exe .rdata (addresses in docs/hud.md). */
export const HUD = {
  /** Health silhouette centre (FUN_0045f070): x = W/16, y = H*0.8958333. */
  healthCentre: { fx: 0.0625, fy: 0.8958333134651184 },
  /** powerbar.spr is centred 2 px left/up of the background centre. */
  healthBarInset: 2,
  /** Weapon panel right edge (FUN_00478440): x = W*0.984375; baseline y = H*0.8958333. */
  weaponRight: { fx: 0.984375, fy: 0.8958333134651184 },
  /** Separator line: green (0, 0.9f, 0) alpha 0.5f (0x47870b) = bytes (0,229,0,127) (trunc, chop-mode FISTP), x from right - max(iconW, nameW+3). */
  separator: { rgb: [0, 229, 0] as const, alpha: 127 },
  /** Ammo counter text: right edge = weaponRight - 4, top = baseline + 4; format "%-4d". */
  ammoInset: 4,
  /** Gap between the clip/barrel/shell graphic and the counter text. */
  ammoGraphicGap: 8,
  /** Crosshair cross.spr centred at (W/2 - trunc(w/2), H/2 - trunc(h/2)) (FUN_00478440, fistp 0x47886c / 0x478887) when Sight Display Type = CROSSHAIR. */
  crosshair: { fx: 0.5, fy: 0.5 },
  /** Action icon centre (FUN_00485130): x = W/2, y = H*0.875. */
  actionIcon: { fx: 0.5, fy: 0.875 },
  /** Action icon pulse: phase += 1/15 per tick, wraps above 2; alpha = 0.3 + 0.7*tri(phase). */
  actionPulseStep: 0.06666667014360428,
  /** Timed-action progress bar (FUN_004130c0). */
  progressBox: { fx: 0.3125, fy: 0.8333333134651184, fw: 0.375, fh: 0.01875000074505806 },
  progressFill: { fx: 0.31562501192092896, fy: 0.8374999761581421, fw: 0.3687500059604645, fh: 0.010416666977107525 },
  /** "Time Left: %d minute%s, %d second%s" centred at (W*0.8125, H*0.0416667). */
  timer: { fx: 0.8125, fy: 0.0416666679084301 },
} as const;

/** Weapon ID (weaponconfig.qvm) -> status.res icon (switch in FUN_00478440). */
export const WEAPON_ICON: Readonly<Record<number, string>> = {
  1: "glock.spr",
  3: "deserteagle.spr",
  4: "M16.spr",
  5: "ak47.spr",
  6: "uzi.spr",
  7: "Mp5.spr",
  8: "spaz.spr",
  9: "jackhammer.spr",
  10: "SAW.spr",
  11: "druganov.spr",
  12: "LAW80.spr",
  13: "uzi.spr",
  14: "splintgrenade.spr",
  15: "flashgrenade.spr",
  16: "proximity.spr",
  18: "binoculars.spr",
  19: "health.spr",
  21: "colt.spr",
  42: "stationary.spr",
};

/** AMMODISPLAYTYPE_* values (FUN_00413e70 registrations). */
export const AMMO_DISPLAY = { none: 0, normal: 1, clip: 2, barrel: 3, shell: 4, grenade: 5 } as const;

/** clip20.spr frame (61 frames, 0 = full): 60 - trunc(rounds*60/roundsPerClip), min 0 (FUN_00478a40). */
export function clipFrame(roundsInClip: number, roundsPerClip: number): number {
  if (roundsPerClip <= 0) throw new Error(`clipFrame: rounds per clip ${roundsPerClip}`);
  return Math.max(0, 60 - Math.trunc((roundsInClip * 60) / roundsPerClip));
}

/** barrel6.spr frame (61 frames): spin + (6 - rounds)*10, min 0 (FUN_00478c00; spin = gun +0x19c, inferred 0 at rest). */
export function barrelFrame(roundsInCylinder: number, spin = 0): number {
  return Math.max(0, spin + (6 - roundsInCylinder) * 10);
}

/** shell7.spr frame (8 frames): 7 - rounds, min 0 (FUN_00478e30). */
export function shellFrame(roundsInTube: number): number {
  return Math.max(0, 7 - roundsInTube);
}

/** The counter text: C printf "%-4d" (left-justified in 4 columns; trailing spaces do not add width). */
export function ammoText(count: number): string {
  return String(Math.trunc(count)).padEnd(4, " ");
}

/** Health bar geometry (FUN_0045f070) in screen pixels for a W x H screen. */
export function healthBarGeometry(
  W: number,
  H: number,
  background: { width: number; height: number },
  bar: { width: number; height: number },
  healthFraction: number,
): {
  background: { x: number; y: number };
  bar: { x0: number; x1: number; yTop: number; yBottom: number; vTop: number } | null;
} {
  const cx = W * HUD.healthCentre.fx;
  const cy = H * HUD.healthCentre.fy;
  const health = Math.max(0, healthFraction);
  const bgPos = { x: cx - background.width * 0.5, y: cy - background.height * 0.5 };
  if (health === 0) return { background: bgPos, bar: null };
  const bx = cx - HUD.healthBarInset;
  const by = cy - HUD.healthBarInset;
  const missing = 1 - health;
  return {
    background: bgPos,
    bar: {
      x0: bx - bar.width * 0.5,
      x1: bx + bar.width * 0.5,
      yTop: by - bar.height * 0.5 + bar.height * missing,
      yBottom: by + bar.height * 0.5,
      vTop: missing,
    },
  };
}

// ---------------------------------------------------------------------------
// Radio / status messages (StatusMessageScreen, recovered)
// ---------------------------------------------------------------------------

export const STATUS_MESSAGE = {
  /** 12 slots; a new message takes the first free slot (FUN_004845c0). */
  slots: 12,
  /** First box top-left = (W/64, H/48) = (10, 10) at 640x480; each active slot adds 42 px. */
  origin: { fx: 0.015625, fy: 0.02083333395421505 },
  lineStep: 42,
  /** Half width 117.5: box spans x .. x + 235 when fully open. */
  halfWidth: 117.5,
  /** Box height = portrait height, or 37 without a portrait. */
  defaultHeight: 37,
  /** Wrap width for radio text (px, FUN_00483b30). */
  wrapWidth: 229,
  /** Text at (x + portraitWidth + 3, y + 2), colour arg (0,120,0) -> bytes (0,239,0). */
  textOffset: { x: 3, y: 2 },
  textRgb: [0, 239, 0] as const,
  /** Box fill: black alpha 0.33 (byte 84), then green (0,0.5,0) = byte (0,127,0) alpha 0.15 (0.75 at tick 0), outline (0,0.9f,0) = (0,229,0) alpha 0.5 (0x48446d); bytes are trunc(v * 255). */
  boxBlackAlpha: 0.33,
  boxGreenRgb: [0, 127, 0] as const,
  outlineRgb: [0, 229, 0] as const,
  /** Cutscene subtitles: font4, wrap W*0.96875, lines at (W/64, H*0.8645833), white, no box. */
  cutscene: { fx: 0.015625, fy: 0.8645833134651184, wrapFraction: 0.96875 },
  visibleLines: 3,
  /** A repeatable message re-sends at most every 210 ticks (FUN_00483690). */
  resendTicks: 210,
  /** Portrait sprites allowed in the Sprite parameter (strcmp list at 0x53ea04). */
  portraits: ["STATUSSCREEN:anya.spr", "STATUSSCREEN:note.spr", "STATUSSCREEN:ammo.spr", "STATUSSCREEN:weapon.spr"],
  /** Missing text resources show "RM: <key>". */
  missingFormat: "RM: %s",
} as const;

export interface StatusMessageFrame {
  /** Box vertical scale 0..1 (height = h * scale, centred on y + h/2). */
  open: number;
  /** Box horizontal scale 0..1 (width = 235 * scale, centred on x + 117.5). */
  widen: number;
  /** Number of characters typed so far. */
  typed: number;
  /** Portrait drawn (tick > 9). */
  portrait: boolean;
  /** Alpha of the green box fill. */
  greenAlpha: number;
  /** False once the message has been removed. */
  alive: boolean;
}

/**
 * State of a radio message `tick` updates after it was sent (tick 0 = sent),
 * following FUN_00483b30: ticks 0-1 open the box (+0.5 each), ticks 2-8 widen
 * it (+1/7 each), from tick 9 one character per tick is typed, then the message
 * holds for trunc(duration*30) more ticks (fld; fmul 30.0f; fistp at 0x483bf5,
 * chop mode: 8.7 s -> 260) and is removed on the next one.
 */
export function statusMessageFrame(tick: number, textLength: number, durationSeconds: number): StatusMessageFrame {
  if (tick < 0) throw new Error(`statusMessageFrame: negative tick ${tick}`);
  let open = 0;
  let widen = 0;
  let typed = 0;
  let hold = 0;
  let alive = true;
  const holdLimit = x87Fistp(durationSeconds * GAME_TICKS_PER_SECOND);
  for (let t = 0; t < tick && alive; t++) {
    if (t < 2) open += 0.5;
    else if (t < 9) widen += 0.1428571492433548;
    else if (typed < textLength) typed++;
    else {
      hold++;
      if (hold > holdLimit) alive = false;
    }
  }
  const step = Math.trunc((9 - tick) / 9);
  const greenAlpha = (step > 0 ? step : 0) * 0.6000000238418579 + 0.15000000596046448;
  return { open: Math.min(open, 1), widen: Math.min(widen, 1), typed, portrait: tick > 9, greenAlpha, alive };
}

/**
 * Word wrap of FUN_00483d20, including its quirks: a line breaks when the
 * width of the text before the current character reaches `wrapWidth` (or at
 * '\n'), at the most recent space seen so far (or before the current
 * character if none); at most 9 lines are produced and only the last 3 are
 * shown.  Returns the visible lines.
 */
export function wrapStatusText(font: UiFont, text: string, wrapWidth: number): string[] {
  const buf = text.split("");
  const lines: string[] = [];
  let lineStart = 0;
  let lastSpace = -1;
  let p = 0;
  const strFrom = (start: number, nulAt: number) => {
    // C string from `start` up to the first NUL (nulAt, or the end).
    const end = nulAt >= start ? nulAt : buf.length;
    return buf.slice(start, end).join("");
  };
  for (; p < buf.length; p++) {
    if (lines.length > 8) break;
    const c = buf[p];
    const width = measureText(font, buf.slice(lineStart, p).join(""));
    if (width >= wrapWidth || c === "\n") {
      if (lastSpace < 0) lastSpace = p - 1;
      lines.push(strFrom(lineStart, lastSpace));
      lineStart = lastSpace + 1;
    }
    if (buf[p] === " ") lastSpace = p;
  }
  if (p !== lineStart && lineStart < buf.length) lines.push(buf.slice(lineStart).join(""));
  const first = lines.length >= 4 ? lines.length - 3 : 0;
  return lines.slice(first);
}

// ---------------------------------------------------------------------------
// Loading screen (FUN_00488860 / FUN_00488a40, recovered)
// ---------------------------------------------------------------------------

export const LOADING_SCREEN = {
  /** Picture drawn 1:1 at ((W-640)/2, (H-480)/2); loading_us.pic when the Windows country is "USA". */
  picture: "loading.pic",
  pictureUsa: "loading_us.pic",
  width: 640,
  height: 480,
  /** Bar: 560 x 10 at ((W-640)/2 + 40, (H-480)/2 + 440). */
  bar: { x: 40, y: 440, width: 560, height: 10 },
  /** Pixel words 0x7f00 (empty) and 0xff00 (filled): X8R8G8B8 green (inferred channel order). */
  emptyRgb: [0, 127, 0] as const,
  fillRgb: [0, 255, 0] as const,
  /** Steps: level load 9 (0x414d10), restart 5 (0x415eee), mission-complete hand-over 1 (0x415306). */
  stepsLevelLoad: 9,
  stepsRestart: 5,
  stepsMissionComplete: 1,
} as const;

/** Filled width of the loading bar after `done` of `total` steps (integer division, FUN_00488a40). */
export function loadingBarFill(done: number, total: number): number {
  if (total <= 0) throw new Error(`loadingBarFill: total ${total}`);
  return Math.trunc((LOADING_SCREEN.bar.width * done) / total);
}

/** Top-left of the 640x480 picture for a W x H screen (integer halving as in igi.exe). */
export function loadingOrigin(W: number, H: number): { x: number; y: number } {
  return { x: Math.trunc((W - 640) / 2), y: Math.trunc((H - 480) / 2) };
}
