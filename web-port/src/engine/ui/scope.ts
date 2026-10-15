/**
 * Zoomed weapon overlays (pure submission; draw with PrimList.flush).
 *
 * Binoculars (Binocular class, overlay FUN_0046ff00, compass FUN_004709e0,
 * level bars FUN_00470380 / FUN_00470440, init 0x46fbe0):
 *   - "RANGE: %0.fM" (distance / 4096) or "RANGE: 1000+M" without a hit, at
 *     (W*0.378125, H*0.55 - text height), computer/font3;
 *   - compass tape: box (W*0.625, H*0.7916667) W*0.28125 wide, 2 * text
 *     height + 26 high; 64 ticks per turn (12 px every 16th with the labels
 *     "WNES" above and below, 8 px every 8th, else 4 px), (0,64,0)/128; two
 *     4 px markers at the tape centre whose unscaled vertex green (64.0)
 *     overflows to bytes (63,192,0) (result inferred);
 *   - 12 level bars from x = W/8 every W*0.1875/12, W*0.1875/12 - W*0.009375
 *     wide, up to H/8 high above y = H*0.7625 + H/8, colour (64 v, 64, 0)/128
 *     alpha 0.5; each jumps to a random level, falls 0.02 per update and holds
 *     trunc((rand + 1) * 30 / 2) - 1 updates (fistp at 0x470414, chop mode:
 *     14..28) (the exe updates them per drawn
 *     frame; here per 30 Hz tick);
 *   - binoculars.spr stretched over each half (mirrored), s = W / 256 overscan,
 *     bilinear;
 *   - two "[ ]" chevrons (shape 0x532068, 3 segments, scale W/64, H/48) at
 *     W/2 -/+ W*0.09375, (0,100,0)/128 alpha 0.5;
 *   - full-width and full-height centre lines (0,32,0)/128 alpha 0.5.
 *   Lines drawn through FUN_004aba40 get an extra -0.5 offset (on top of the
 *   rasteriser's), reproduced here. The target squares (FUN_00470510) are not
 *   drawn (they need the AI's visibility list).
 *
 * Sniper scope (GunDRAGUNOV zoomed, FUN_00471860): snipersight.spr is the
 * top-left quadrant, drawn four times mirrored with s = W/128 overscan;
 * snipersight_x.spr stretched over the full width centred on H/2,
 * snipersight_y.spr over the full height centred on W/2; all bilinear.
 */
import { measureText, x87Fistp, type UiFont, type UiSprite } from "../../loaders";
import { colour128, NEUTRAL, vertexBytes } from "./hud-state";
import type { Painter } from "./painter";

export interface BinocularView {
  kind: "binoculars";
  /** Port yaw (radians, 0 = -z / IGI north, counter-clockwise). */
  yaw: number;
  /** Distance to what the view ray hits, metres; null = nothing within range ("1000+"). */
  rangeMetres: number | null;
}

export interface SniperView {
  kind: "sniper";
}

export type ScopeView = BinocularView | SniperView;

interface Bar {
  value: number;
  decay: number;
  counter: number;
  period: number;
}

/** The 12 level bars (init FUN_0046fd90(bar, period 30, decay 0.02)). */
export class BinocularBars {
  readonly bars: Bar[] = Array.from({ length: 12 }, () => ({ value: 0, decay: 0.019999999552965164, counter: 0, period: 30 }));

  /** FUN_00470380 for every bar. */
  tick(random: () => number): void {
    for (const b of this.bars) {
      if (b.value > 0) b.value = Math.min(1, Math.max(0, Math.fround(b.value - b.decay)));
      if (b.counter > 0) {
        b.counter--;
        continue;
      }
      const r = random();
      b.value = r <= b.value ? b.value : Math.fround(random());
      b.counter = x87Fistp((random() + 1) * b.period * 0.5) - 1;
    }
  }
}

export interface ScopeResources {
  /** common/sprites/sprites.res */
  sprites: Map<string, UiSprite>;
  hudFont: UiFont;
}

const LABELS = "WNES";

/** IGI compass heading (radians, 0 = east, counter-clockwise; inferred) from the port's yaw. */
export function compassHeading(yaw: number): number {
  let h = yaw + Math.PI / 2;
  h %= 2 * Math.PI;
  if (h < 0) h += 6.2831854820251465;
  return h;
}

/** A line through FUN_004aba40: endpoints shifted by -0.5 before the rasteriser's own -0.5. */
function helperLine(p: Painter, x0: number, y0: number, x1: number, y1: number, colour: readonly [number, number, number, number]): void {
  p.strip([x0 - 0.5, y0 - 0.5, x1 - 0.5, y1 - 0.5], colour);
}

export function submitBinoculars(view: BinocularView, bars: BinocularBars, res: ScopeResources, W: number, H: number, p: Painter): void {
  const font = res.hudFont;
  const textH = font.lineHeight;
  // RANGE text.
  const range = view.rangeMetres === null ? "RANGE: 1000+M" : `RANGE: ${Math.round(view.rangeMetres)}M`;
  p.text(font, range, Math.fround(W * 0.37812501192092896), Math.fround(H * 0.550000011920929) - textH, "left", NEUTRAL, 1);

  // Compass tape (FUN_004709e0).
  const x0 = Math.fround(W * 0.625);
  const y0 = Math.fround(H * 0.7916666865348816);
  const w = Math.fround(W * 0.28125);
  const h = textH + textH + 26;
  const cy = h * 0.5 + y0;
  const step = w * 0.015625;
  let offset = w * compassHeading(view.yaw) * 0.15915493667125702;
  const tick = colour128(0, 64, 0, 1);
  for (let k = 0; k < 64; k++) {
    const len = (k & 15) === 0 ? 12 : (k & 7) === 0 ? 8 : 4;
    const x = offset + x0;
    const top = cy - len * 0.5;
    const bottom = len * 0.5 + cy;
    helperLine(p, x, top, x, bottom, tick);
    if ((k & 15) === 0) {
      const label = LABELS[k >> 4];
      const lx = x - measureText(font, label) * 0.5;
      p.text(font, label, lx, top - textH - 2, "left", NEUTRAL, 1);
      p.text(font, label, lx, bottom + 2, "left", NEUTRAL, 1);
    }
    offset += step;
    if (w <= offset) offset -= w;
  }
  // Centre markers: 3-vertex triangle strips, unscaled green 64.0 -> bytes (63,192,0) (overflow; inferred result).
  const marker = vertexBytes(0, 64, 0, 1);
  const cx = w * 0.5 + x0;
  for (let j = 0; j < 4; j++) {
    const half = 4 * (1 - (j + 0.5) / 4);
    p.rect(cx - half, y0 + j, cx + half, y0 + j + 1, marker);
    p.rect(cx - half, y0 + h - j - 1, cx + half, y0 + h - j, marker);
  }

  // Level bars.
  const barStep = W * 0.1875 * 0.0833333358168602;
  const barW = barStep - W * 0.00937500037252903;
  const barY = Math.fround(H * 0.762499988079071);
  const barH = Math.fround(H * 0.125);
  let bx = W * 0.125;
  for (const b of bars.bars) {
    if (b.value > 0) p.rect(bx, (1 - b.value) * barH + barY, bx + barW, barY + barH, colour128(b.value * 64, 64, 0, 0.5));
    bx += barStep;
  }

  // Binocular mask halves (bilinear).
  const spr = res.sprites.get("binoculars.spr");
  const f = spr?.frames[0];
  if (spr && f) {
    const s = W / spr.width;
    p.quad(f, -s, -s, W * 0.5, H + s, [0, 0, 1, 1], NEUTRAL, 1, false, true);
    p.quad(f, W + s, -s, W * 0.5, H + s, [0, 0, 1, 1], NEUTRAL, 1, false, true);
  }

  // Chevrons (shape 0x532068, 4 points -> 3 segments).
  const shape = [-0.5, -2.5, -2, -2.5, -2, 2.5, -0.5, 2.5];
  const chevron = colour128(0, 100, 0, 0.5);
  const drawShape = (ox: number, oy: number, sx: number, sy: number) => {
    for (let i = 0; i + 3 < shape.length; i += 2) {
      helperLine(p, sx * shape[i] + ox, sy * shape[i + 1] + oy, sx * shape[i + 2] + ox, sy * shape[i + 3] + oy, chevron);
    }
  };
  const hw = Math.trunc(W / 2);
  const hh = Math.trunc(H / 2);
  drawShape(hw - W * 0.09375, hh, W * 0.015625, H * 0.02083333395421505);
  drawShape(W * 0.09375 + hw, hh, W * -0.015625, H * -0.02083333395421505);

  // Centre lines.
  const centre = colour128(0, 32, 0, 0.5);
  helperLine(p, 0, hh, W, hh, centre);
  helperLine(p, hw, 0, hw, H, centre);
}

export function submitSniperScope(res: ScopeResources, W: number, H: number, p: Painter): void {
  const sight = res.sprites.get("snipersight.spr");
  const sx = res.sprites.get("snipersight_x.spr");
  const sy = res.sprites.get("snipersight_y.spr");
  const f = sight?.frames[0];
  if (sight && f) {
    const s = W / sight.width;
    const cx = W * 0.5;
    const cy = H * 0.5;
    p.quad(f, -s, -s, cx, cy, [0, 0, 1, 1], NEUTRAL, 1, false, true);
    p.quad(f, W + s, -s, cx, cy, [0, 0, 1, 1], NEUTRAL, 1, false, true);
    p.quad(f, -s, H + s, cx, cy, [0, 0, 1, 1], NEUTRAL, 1, false, true);
    p.quad(f, W + s, H + s, cx, cy, [0, 0, 1, 1], NEUTRAL, 1, false, true);
  }
  const fx = sx?.frames[0];
  if (sx && fx) {
    const top = Math.trunc(H / 2) - Math.trunc(sx.height / 2);
    p.quad(fx, 0, top, W, top + sx.height, [0, 0, 1, 1], NEUTRAL, 1, false, true);
  }
  const fy = sy?.frames[0];
  if (sy && fy) {
    const left = Math.trunc(W / 2) - Math.trunc(sy.width / 2);
    p.quad(fy, left, 0, left + sy.width, H, [0, 0, 1, 1], NEUTRAL, 1, false, true);
  }
}
