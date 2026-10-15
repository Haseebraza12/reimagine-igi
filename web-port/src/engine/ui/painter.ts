/**
 * 2D primitives of igi.exe's interface renderer, drawn into a 640x480 virtual
 * canvas (docs/hud.md section 3).
 *
 *   - Sprites and glyphs are drawn 1:1 with point sampling; quads are
 *     `texture x vertex colour` (MODULATE), alpha = texture alpha x vertex
 *     alpha, blended SRCALPHA/INVSRCALPHA (canvas "source-over") or
 *     SRCALPHA/ONE (flag 8, canvas "lighter").
 *   - D3D rasterisation with the -0.5 vertex offset: a quad edge at x covers
 *     pixels from ceil(x - 0.5) (`pixelStart`).
 *   - Primitives of one frame are drawn in REVERSE order of submission
 *     (FUN_00495b20 pushes to the front of the list): use `PrimList` to submit
 *     in the exe's order and `flush()` to draw them back to front.
 *
 * Line strips: D3D7 line rasterisation is approximated as "segment from a to
 * b covers the pixels from pixelStart(a) up to, not including, pixelStart(b)"
 * (last pixel of each segment omitted, so closed outlines draw each corner
 * once). Which row an integer-y horizontal line lands on under the diamond
 * rule is inferred (row y).
 */
import {
  buildFontAtlas,
  layoutText,
  pixelStart,
  type DecodedTexture,
  type TextAlign,
  type UiFont,
  type UiFrame,
} from "../../loaders";
import type { Bytes4, Rgb8 } from "./hud-state";

export const VW = 640;
export const VH = 480;

export interface Painter {
  /** Sprite frame 1:1 at (x + frame.x, y + frame.y). */
  sprite(frame: UiFrame, x: number, y: number, tint?: Rgb8, alpha?: number, additive?: boolean): void;
  /** Sprite frame stretched over (x0,y0)-(x1,y1), texture coordinates u/v in 0..1; `bilinear` = flag 0x1000000. */
  quad(frame: UiFrame, x0: number, y0: number, x1: number, y1: number, uv?: readonly [number, number, number, number],
    tint?: Rgb8, alpha?: number, additive?: boolean, bilinear?: boolean): void;
  /** One text line (FUN_004adb90) with the font's own glyph offsets and advances. */
  text(font: UiFont, text: string, x: number, y: number, align: TextAlign, tint: Rgb8, alpha: number): void;
  /** Flat rectangle (x0,y0)-(x1,y1). */
  rect(x0: number, y0: number, x1: number, y1: number, colour: Bytes4): void;
  /** Gouraud quad (triangle strip TL, TR, BL, BR). */
  gouraud(x0: number, y0: number, x1: number, y1: number, tl: Bytes4, tr: Bytes4, bl: Bytes4, br: Bytes4): void;
  /** Axis-aligned line strip: points as [x0, y0, x1, y1, ...]. */
  strip(points: readonly number[], colour: Bytes4): void;
  /** Arbitrary line segments [x0, y0, x1, y1, ...] (BackgroundFX). */
  lines(segments: readonly number[], colour: Bytes4): void;
  /** A composed picture (.pic) drawn 1:1 at (x, y). */
  image(texture: DecodedTexture, x: number, y: number, alpha?: number): void;
}

type Op = (p: Painter) => void;

/** Records primitives in submission order; `flush` draws them in reverse (FUN_00495aa0). */
export class PrimList implements Painter {
  readonly ops: Op[] = [];
  /** Debug: a label per op (tests). */
  readonly labels: string[] = [];

  private push(label: string, op: Op): void {
    this.ops.push(op);
    this.labels.push(label);
  }

  sprite(frame: UiFrame, x: number, y: number, tint?: Rgb8, alpha?: number, additive?: boolean): void {
    this.push("sprite", (p) => p.sprite(frame, x, y, tint, alpha, additive));
  }

  quad(frame: UiFrame, x0: number, y0: number, x1: number, y1: number, uv?: readonly [number, number, number, number],
    tint?: Rgb8, alpha?: number, additive?: boolean, bilinear?: boolean): void {
    this.push("quad", (p) => p.quad(frame, x0, y0, x1, y1, uv, tint, alpha, additive, bilinear));
  }

  text(font: UiFont, text: string, x: number, y: number, align: TextAlign, tint: Rgb8, alpha: number): void {
    this.push(`text:${text}`, (p) => p.text(font, text, x, y, align, tint, alpha));
  }

  rect(x0: number, y0: number, x1: number, y1: number, colour: Bytes4): void {
    this.push("rect", (p) => p.rect(x0, y0, x1, y1, colour));
  }

  gouraud(x0: number, y0: number, x1: number, y1: number, tl: Bytes4, tr: Bytes4, bl: Bytes4, br: Bytes4): void {
    this.push("gouraud", (p) => p.gouraud(x0, y0, x1, y1, tl, tr, bl, br));
  }

  strip(points: readonly number[], colour: Bytes4): void {
    this.push("strip", (p) => p.strip(points, colour));
  }

  lines(segments: readonly number[], colour: Bytes4): void {
    this.push("lines", (p) => p.lines(segments, colour));
  }

  image(texture: DecodedTexture, x: number, y: number, alpha?: number): void {
    this.push("image", (p) => p.image(texture, x, y, alpha));
  }

  /** Draw everything back to front and empty the list. */
  flush(target: Painter): void {
    for (let i = this.ops.length - 1; i >= 0; i--) this.ops[i](target);
    this.ops.length = 0;
    this.labels.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Canvas 2D implementation (browser only)
// ---------------------------------------------------------------------------

type Surface = HTMLCanvasElement;

function makeSurface(width: number, height: number): Surface {
  const c = document.createElement("canvas");
  c.width = Math.max(1, width);
  c.height = Math.max(1, height);
  return c;
}

function surfaceFromRgba(rgba: Uint8ClampedArray, width: number, height: number, tint?: Rgb8, additive = false): Surface {
  const c = makeSurface(width, height);
  const g = c.getContext("2d")!;
  const data = new ImageData(width, height);
  if (additive) {
    // SRCALPHA/ONE adds P = texel x tint x alpha. On a transparent overlay the
    // closest "over" equivalent is colour P / a' with alpha a' = max(P) / 255:
    // dst (1 - a') + P (exact for black, slightly less bright on light pixels).
    const t = tint ?? [255, 255, 255];
    const d = data.data;
    for (let i = 0; i < rgba.length; i += 4) {
      const a = rgba[i + 3] / 255;
      const r = (rgba[i] * t[0] * a) / 255;
      const gg = (rgba[i + 1] * t[1] * a) / 255;
      const b = (rgba[i + 2] * t[2] * a) / 255;
      const m = Math.max(r, gg, b);
      if (m <= 0) continue;
      d[i] = (r * 255) / m;
      d[i + 1] = (gg * 255) / m;
      d[i + 2] = (b * 255) / m;
      d[i + 3] = m;
    }
  } else if (!tint || (tint[0] === 255 && tint[1] === 255 && tint[2] === 255)) {
    data.data.set(rgba);
  } else {
    const d = data.data;
    for (let i = 0; i < rgba.length; i += 4) {
      // D3D MODULATE: texel x diffuse / 255.
      d[i] = (rgba[i] * tint[0] + 127) / 255;
      d[i + 1] = (rgba[i + 1] * tint[1] + 127) / 255;
      d[i + 2] = (rgba[i + 2] * tint[2] + 127) / 255;
      d[i + 3] = rgba[i + 3];
    }
  }
  g.putImageData(data, 0, 0);
  return c;
}

const tintKey = (t?: Rgb8) => (t ? `${t[0]},${t[1]},${t[2]}` : "255,255,255");

interface FontCache {
  atlas: ReturnType<typeof buildFontAtlas>;
  surfaces: Map<string, Surface>;
}

/** Draws primitives immediately onto a 2D context of a 640x480 canvas. */
export class CanvasPainter implements Painter {
  private readonly frameSurfaces = new WeakMap<UiFrame, Map<string, Surface>>();
  private readonly textureSurfaces = new WeakMap<DecodedTexture, Surface>();
  private readonly fonts = new WeakMap<UiFont, FontCache>();
  private readonly gouraudCache = new Map<string, Surface>();
  private lineLayer: { surface: Surface; data: ImageData } | null = null;
  /**
   * True while the drawn region is opaque (main menu, loading screen): additive
   * primitives then use the exact "lighter" blend. Over the transparent in-game
   * overlay an equivalent "over" image is used instead (see surfaceFromRgba).
   */
  opaqueTarget = false;

  constructor(readonly g: CanvasRenderingContext2D) {
    g.imageSmoothingEnabled = false;
  }

  private frameSurface(frame: UiFrame, tint?: Rgb8, additiveOver = false): Surface {
    let byTint = this.frameSurfaces.get(frame);
    if (!byTint) {
      byTint = new Map();
      this.frameSurfaces.set(frame, byTint);
    }
    const key = (additiveOver ? "add:" : "") + tintKey(tint);
    let s = byTint.get(key);
    if (!s) {
      s = surfaceFromRgba(frame.rgba, frame.width, frame.height, tint, additiveOver);
      byTint.set(key, s);
    }
    return s;
  }

  private fontSurface(font: UiFont, tint: Rgb8): { surface: Surface; atlas: FontCache["atlas"] } {
    let cache = this.fonts.get(font);
    if (!cache) {
      cache = { atlas: buildFontAtlas(font), surfaces: new Map() };
      this.fonts.set(font, cache);
    }
    const key = tintKey(tint);
    let s = cache.surfaces.get(key);
    if (!s) {
      const t = cache.atlas.texture;
      s = surfaceFromRgba(t.rgba, t.width, t.height, tint);
      cache.surfaces.set(key, s);
    }
    return { surface: s, atlas: cache.atlas };
  }

  private withBlend(alpha: number, additive: boolean, draw: () => void): void {
    if (alpha <= 0) return;
    const g = this.g;
    g.globalAlpha = Math.min(1, alpha);
    g.globalCompositeOperation = additive ? "lighter" : "source-over";
    draw();
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
  }

  sprite(frame: UiFrame, x: number, y: number, tint?: Rgb8, alpha = 1, additive = false): void {
    const over = additive && !this.opaqueTarget;
    const s = this.frameSurface(frame, tint, over);
    const px = pixelStart(x + frame.x);
    const py = pixelStart(y + frame.y);
    this.withBlend(alpha, additive && !over, () => this.g.drawImage(s, px, py));
  }

  quad(frame: UiFrame, x0: number, y0: number, x1: number, y1: number, uv: readonly [number, number, number, number] = [0, 0, 1, 1],
    tint?: Rgb8, alpha = 1, additive = false, bilinear = false): void {
    const px0 = pixelStart(Math.min(x0, x1));
    const px1 = pixelStart(Math.max(x0, x1));
    const py0 = pixelStart(Math.min(y0, y1));
    const py1 = pixelStart(Math.max(y0, y1));
    if (px1 <= px0 || py1 <= py0) return;
    const over = additive && !this.opaqueTarget;
    const s = this.frameSurface(frame, tint, over);
    additive = additive && !over;
    const [u0, v0, u1, v1] = uv;
    const flipX = (x1 < x0) !== (u1 < u0);
    const flipY = (y1 < y0) !== (v1 < v0);
    const su = Math.min(u0, u1) * frame.width;
    const sv = Math.min(v0, v1) * frame.height;
    const sw = Math.abs(u1 - u0) * frame.width;
    const sh = Math.abs(v1 - v0) * frame.height;
    if (sw <= 0 || sh <= 0) return;
    this.withBlend(alpha, additive, () => {
      const g = this.g;
      g.imageSmoothingEnabled = bilinear;
      if (flipX || flipY) {
        g.save();
        g.translate(flipX ? px0 + px1 : 0, flipY ? py0 + py1 : 0);
        g.scale(flipX ? -1 : 1, flipY ? -1 : 1);
        g.drawImage(s, su, sv, sw, sh, px0, py0, px1 - px0, py1 - py0);
        g.restore();
      } else {
        g.drawImage(s, su, sv, sw, sh, px0, py0, px1 - px0, py1 - py0);
      }
      g.imageSmoothingEnabled = false;
    });
  }

  text(font: UiFont, text: string, x: number, y: number, align: TextAlign, tint: Rgb8, alpha: number): void {
    if (!text || alpha <= 0) return;
    const { surface, atlas } = this.fontSurface(font, tint);
    const glyphs = layoutText(font, text, x, y, align);
    this.withBlend(alpha, false, () => {
      for (const p of glyphs) {
        const r = atlas.rects[p.glyph];
        if (r.width <= 0 || r.height <= 0) continue;
        this.g.drawImage(surface, r.x, r.y, r.width, r.height, pixelStart(p.x), pixelStart(p.y), r.width, r.height);
      }
    });
  }

  rect(x0: number, y0: number, x1: number, y1: number, c: Bytes4): void {
    const px0 = pixelStart(Math.min(x0, x1));
    const px1 = pixelStart(Math.max(x0, x1));
    const py0 = pixelStart(Math.min(y0, y1));
    const py1 = pixelStart(Math.max(y0, y1));
    if (px1 <= px0 || py1 <= py0 || c[3] === 0) return;
    const g = this.g;
    g.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`;
    g.fillRect(px0, py0, px1 - px0, py1 - py0);
  }

  gouraud(x0: number, y0: number, x1: number, y1: number, tl: Bytes4, tr: Bytes4, bl: Bytes4, br: Bytes4): void {
    const px0 = pixelStart(x0);
    const px1 = pixelStart(x1);
    const py0 = pixelStart(y0);
    const py1 = pixelStart(y1);
    const w = px1 - px0;
    const h = py1 - py0;
    if (w <= 0 || h <= 0) return;
    if (tl[3] === 0 && tr[3] === 0 && bl[3] === 0 && br[3] === 0) return;
    const same = (a: Bytes4, b: Bytes4) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
    if (same(tl, tr) && same(tl, bl) && same(tl, br)) {
      this.rect(x0, y0, x1, y1, tl);
      return;
    }
    const key = `${w}x${h}:${tl}:${tr}:${bl}:${br}:${x0 - px0},${y0 - py0},${x1 - x0},${y1 - y0}`;
    let s = this.gouraudCache.get(key);
    if (!s) {
      if (this.gouraudCache.size > 64) this.gouraudCache.clear();
      s = makeSurface(w, h);
      const data = new ImageData(w, h);
      fillGouraud(data, x0 - px0, y0 - py0, x1 - x0, y1 - y0, tl, tr, bl, br);
      s.getContext("2d")!.putImageData(data, 0, 0);
      this.gouraudCache.set(key, s);
    }
    this.g.drawImage(s, px0, py0);
  }

  strip(points: readonly number[], c: Bytes4): void {
    if (c[3] === 0) return;
    const g = this.g;
    g.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`;
    for (let i = 0; i + 3 < points.length; i += 2) {
      const ax = pixelStart(points[i]);
      const ay = pixelStart(points[i + 1]);
      const bx = pixelStart(points[i + 2]);
      const by = pixelStart(points[i + 3]);
      if (ay === by) {
        if (bx > ax) g.fillRect(ax, ay, bx - ax, 1);
        else if (bx < ax) g.fillRect(bx + 1, ay, ax - bx, 1);
      } else if (ax === bx) {
        if (by > ay) g.fillRect(ax, ay, 1, by - ay);
        else g.fillRect(ax, by + 1, 1, ay - by);
      } else {
        this.lines([points[i], points[i + 1], points[i + 2], points[i + 3]], c);
        g.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${c[3] / 255})`;
      }
    }
  }

  lines(segments: readonly number[], c: Bytes4): void {
    if (c[3] === 0 || segments.length < 4) return;
    if (!this.lineLayer) {
      const surface = makeSurface(VW, VH);
      this.lineLayer = { surface, data: new ImageData(VW, VH) };
    }
    const { surface, data } = this.lineLayer;
    const d = data.data;
    d.fill(0);
    const a = c[3] / 255;
    let minX = VW;
    let minY = VH;
    let maxX = -1;
    let maxY = -1;
    const plot = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= VW || y >= VH) return;
      const i = (y * VW + x) * 4;
      // Blend onto the (transparent) layer: alpha accumulates as A + a (1 - A).
      const prev = d[i + 3] / 255;
      const next = prev + a * (1 - prev);
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      d[i + 3] = Math.round(next * 255);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    };
    for (let k = 0; k + 3 < segments.length; k += 4) {
      rasteriseLine(segments[k], segments[k + 1], segments[k + 2], segments[k + 3], plot);
    }
    if (maxX < 0) return;
    surface.getContext("2d")!.putImageData(data, 0, 0, minX, minY, maxX - minX + 1, maxY - minY + 1);
    this.g.drawImage(surface, minX, minY, maxX - minX + 1, maxY - minY + 1, minX, minY, maxX - minX + 1, maxY - minY + 1);
  }

  image(texture: DecodedTexture, x: number, y: number, alpha = 1): void {
    let s = this.textureSurfaces.get(texture);
    if (!s) {
      s = surfaceFromRgba(texture.rgba, texture.width, texture.height);
      this.textureSurfaces.set(texture, s);
    }
    const surface = s;
    this.withBlend(alpha, false, () => this.g.drawImage(surface, pixelStart(x), pixelStart(y)));
  }
}

/**
 * Fill `data` (w x h pixels, origin at the first covered pixel) with the
 * Gouraud-interpolated colours of the strip quad whose top-left vertex is at
 * (ox, oy) relative to that origin and whose size is (qw, qh). Triangles are
 * (TL, TR, BL) and (TR, BL, BR); pixel (i, j) samples at (i + 0.5, j + 0.5).
 */
export function fillGouraud(data: { width: number; height: number; data: Uint8ClampedArray },
  ox: number, oy: number, qw: number, qh: number, tl: Bytes4, tr: Bytes4, bl: Bytes4, br: Bytes4): void {
  const { width: w, height: h } = data;
  const d = data.data;
  // Per channel: triangle 1 value = tl + (tr - tl) u + (bl - tl) v; triangle 2 = br + (bl - br)(1 - u) + (tr - br)(1 - v).
  const c1u = [0, 0, 0, 0];
  const c2u = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    c1u[k] = tr[k] - tl[k];
    c2u[k] = br[k] - bl[k];
  }
  for (let j = 0; j < h; j++) {
    const v = Math.min(1, Math.max(0, (j + 0.5 - oy) / qh));
    const base1 = [0, 0, 0, 0];
    const base2 = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) {
      base1[k] = tl[k] + (bl[k] - tl[k]) * v;
      // br + (bl - br)(1 - u) + (tr - br)(1 - v) = (bl + (tr - br)(1 - v)) + (br - bl) u
      base2[k] = bl[k] + (tr[k] - br[k]) * (1 - v);
    }
    let o = j * w * 4;
    for (let i = 0; i < w; i++, o += 4) {
      const u = Math.min(1, Math.max(0, (i + 0.5 - ox) / qw));
      if (u + v <= 1) {
        d[o] = base1[0] + c1u[0] * u;
        d[o + 1] = base1[1] + c1u[1] * u;
        d[o + 2] = base1[2] + c1u[2] * u;
        d[o + 3] = base1[3] + c1u[3] * u;
      } else {
        d[o] = base2[0] + c2u[0] * u;
        d[o + 1] = base2[1] + c2u[1] * u;
        d[o + 2] = base2[2] + c2u[2] * u;
        d[o + 3] = base2[3] + c2u[3] * u;
      }
    }
  }
}

/** DDA line from (x0, y0) to (x1, y1), last pixel omitted (D3D line strips). */
export function rasteriseLine(x0: number, y0: number, x1: number, y1: number, plot: (x: number, y: number) => void): void {
  const ax = x0 - 0.5;
  const ay = y0 - 0.5;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
  if (steps === 0) return;
  for (let s = 0; s < steps; s++) {
    const t = s / steps;
    plot(Math.round(ax + dx * t + 0.5), Math.round(ay + dy * t + 0.5));
  }
}
