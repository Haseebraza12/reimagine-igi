/**
 * The main menu's animated background effect ("BackgroundFX", class
 * FUN_0041c290; created by the own-display MenuManager at 0x417b1c). Pure
 * geometry; drawing goes through the Painter.
 *
 * Recovered: update FUN_0041c330 adds 1.0 to its time per logic tick (the
 * main menu runs at 60 ticks/s); draw FUN_0041c350 draws FUN_0041c390(t) and
 * FUN_0041c390(t + 1). FUN_0041c390 places three vector shapes with
 * FUN_0041be10 (rotation angle, uniform scale, translation):
 *   A: grid 20x20 of 300x300 (data 0x537c60), angle 0.002 t,
 *      scale 1.25 + 0.25 cos(0.005 t), at (200, 300);
 *   B: 5 lines (0x537b88) + circles r 100 and r 60 (0x537c38),
 *      angle -t/700, scale 1.15 + 0.15 cos(0.0025 t), at (400, 250);
 *   C: 5 lines (0x537be0) + circle r 200 (0x537c50),
 *      angle t/900, scale 2 + sin(t/300), at (150, 250).
 * Every line is a line strip (0, 1, 0) with alpha 0.075 (FUN_0041c070,
 * FUN_0041c160 circles of trunc(0.31416 r) <= 40 segments (fistp at 0x41c1b5,
 * chop mode), FUN_0041be60 grid).
 */
import { x87Fistp } from "../../loaders";
import { vertexBytes } from "./hud-state";
import type { Painter } from "./painter";

type Transform = [number, number, number, number, number, number, number];

const f = Math.fround;

/** FUN_0041be10: [m00, m01, m10, m11, tx, ty, scale]. */
function transform(angle: number, scale: number, x: number, y: number): Transform {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [f(c * scale), f(s * scale), f(-s * scale), f(c * scale), x, y, scale];
}

const apply = (m: Transform, x: number, y: number): [number, number] => [
  f(x * m[0] + y * m[2] + m[4]),
  f(x * m[1] + y * m[3] + m[5]),
];

const LINES_B = [0, 70, 0, 300, 5, 70, 5, 300, 0, -80, 0, -300, 90, 0, 300, 0, -65, 65, -190, 190];
const LINES_C = [-300, -100, 300, -100, -300, 100, 300, 100, -200, 100, -200, -100, 200, 100, 200, -100, 0, -400, 0, 150];
const CIRCLES_B = [0, 0, 100, 28, -28, 60];
const CIRCLES_C = [0, -100, 200];
const GRID_A = { nx: 20, ny: 20, cx: 0, cy: 0, w: 300, h: 300 };

function pushLines(out: number[], m: Transform, lines: readonly number[]): void {
  for (let i = 0; i < lines.length; i += 4) {
    const [ax, ay] = apply(m, lines[i], lines[i + 1]);
    const [bx, by] = apply(m, lines[i + 2], lines[i + 3]);
    out.push(ax, ay, bx, by);
  }
}

function pushCircles(out: number[], m: Transform, circles: readonly number[]): void {
  for (let i = 0; i < circles.length; i += 3) {
    const [cx, cy] = apply(m, circles[i], circles[i + 1]);
    const r = f(circles[i + 2] * m[6]);
    let n = x87Fistp(r * 0.3141592741012573); // 0x41c1af: fmul 0.31415927f; fistp (not stored as float32 first)
    if (n > 39) n = 40;
    if (n <= 0) continue;
    const pts: number[] = [];
    let a = 0;
    for (let k = 0; k < n; k++) {
      pts.push(f(Math.cos(a) * r + cx), f(Math.sin(a) * r + cy));
      a = 6.2831854820251465 / n + a;
    }
    pts.push(pts[0], pts[1]);
    for (let k = 0; k + 3 < pts.length; k += 2) out.push(pts[k], pts[k + 1], pts[k + 2], pts[k + 3]);
  }
}

function pushGrid(out: number[], m: Transform): void {
  const g = GRID_A;
  const wx = f(g.w * m[0]);
  const wy = f(g.w * m[1]);
  const hx = f(g.h * m[2]);
  const hy = f(g.h * m[3]);
  const sx = f(g.cy * m[2] + g.cx * m[0] + m[4] - (hx + wx) * 0.5);
  const sy = f(g.cx * m[1] + g.cy * m[3] + m[5] - (hy + wy) * 0.5);
  let px = sx;
  let py = sy;
  for (let i = 0; i <= g.nx; i++) {
    out.push(px, py, px + wx, py + wy);
    px = f(hx * 0.05 + px);
    py = f(hy * 0.05 + py);
  }
  px = sx;
  py = sy;
  for (let j = 0; j <= g.ny; j++) {
    out.push(px, py, px + hx, py + hy);
    px = f(wx * 0.05 + px);
    py = f(wy * 0.05 + py);
  }
}

/** All line segments of FUN_0041c390(t), as [x0, y0, x1, y1, ...] in the 640x480 layout. */
export function backgroundFxSegments(t: number): number[] {
  const out: number[] = [];
  pushGrid(out, transform(t * 0.0020000000949949026, Math.cos(t * 0.004999999888241291) * 0.25 + 1.25, 200, 300));
  const b = transform(t * -0.0014285714132711291, Math.cos(t * 0.0024999999441206455) * 0.15000000596046448 + 1.149999976158142, 400, 250);
  pushLines(out, b, LINES_B);
  pushCircles(out, b, CIRCLES_B);
  const c = transform(t * 0.0011111111380159855, Math.sin(t * 0.0033333334140479565) + 2, 150, 250);
  pushLines(out, c, LINES_C);
  pushCircles(out, c, CIRCLES_C);
  return out;
}

export const BACKGROUND_FX_COLOUR = vertexBytes(0, 1, 0, 0.07500000298023224);

export class BackgroundFx {
  /** +0x20 */
  t = 0;

  tick(): void {
    this.t = f(this.t + 1);
  }

  submit(p: Painter): void {
    p.lines(backgroundFxSegments(this.t), BACKGROUND_FX_COLOUR);
    p.lines(backgroundFxSegments(f(this.t + 1)), BACKGROUND_FX_COLOUR);
  }
}
