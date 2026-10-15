/**
 * Draws the map computer (computer.ts) the way igi.exe submits it. Every
 * computer primitive is sent with bucket -1, i.e. drawn immediately in
 * submission order (FUN_00504300 -> FUN_00495ad0), not through the reversed
 * per-frame list of the HUD, so this module paints straight onto a Painter in
 * draw order.
 *
 * Order (recovered submission order; the relative order of the page's child
 * objects is their creation order, inferred):
 *   1. ComputerMenu (FUN_004699d0): full-screen (0, 127, 0)/128 rectangle with
 *      blend ZERO/SRCCOLOR (flag 0x80000000) = multiply the 3-D view by
 *      (0, 253, 0)/255. A 2-D canvas cannot multiply what WebGL drew below it,
 *      so the HUD puts a mix-blend-mode: multiply element between the two
 *      (`COMPUTER_MULTIPLY_RGB`); nothing is drawn here for it.
 *   2. the page:
 *      map        ComputerObject markers (FUN_004664f0), LineFilter (scanlines +
 *                 interference, LAB_00499bd0), buttons / texts, ComputerStartup
 *                 (FUN_00465870 / FUN_00465000);
 *      objectives opaque black screen, objective texts (FUN_00467ca0), items;
 *      log        opaque black screen, log entries (FUN_00467740), items.
 *   3. the pointer (computer/pointer.spr centred on the pointer) unless the
 *      sphere is being dragged.
 */
import { x87Fistp, type UiFont, type UiFrame, type UiSprite } from "../../loaders";
import type { UiArchive } from "./assets";
import {
  COMPUTER_TEXT_COLOURS,
  layoutComputerText,
  MARKER_COLOURS,
  MARKER_SHAPES,
  PAGE,
  STARTUP_STEPS,
  type ComputerItem,
  type ComputerLog,
  type ComputerObjective,
  type MapComputer,
} from "./computer";
import { colour128, NEUTRAL, tint128 } from "./hud-state";
import type { Painter } from "./painter";
import { penAdvance } from "./text";

/** The multiply colour of the ComputerMenu rectangle: (0, 127, 0) x 1/128 x 255, chopped. */
export const COMPUTER_MULTIPLY_RGB: readonly [number, number, number] = [0, 253, 0];

export interface ComputerDrawResources {
  /** computer/computer.res (sprites, font1..font4). */
  computer: UiArchive;
  /** menusystem/ingamemenu.res (font1, font3, font4: the fonts the computer takes from the in-game MenuManager). */
  ingame: UiArchive;
  /** language computer.res / objectives.res / messages.res lookup. */
  text(key: string): string;
}

export interface ComputerDrawState {
  log: ComputerLog;
  objectives: readonly ComputerObjective[] | null;
  mapEnabled: boolean;
  /** RNG of the LineFilter (FUN_004aaa50(&DAT_006c62c8), a generator of its own), [0, 1). */
  filterRandom: () => number;
}

const W = 640;
const H = 480;

const spriteOf = (a: UiArchive, name: string): UiSprite | null => a.sprites.get(name.toLowerCase()) ?? null;
const frameOf = (s: UiSprite | null, i = 0): UiFrame | null => (s ? s.frames[Math.min(s.frames.length - 1, Math.max(0, i))] ?? null : null);

function textTint(colour: number, highlight: boolean) {
  const c = COMPUTER_TEXT_COLOURS[colour] ?? COMPUTER_TEXT_COLOURS[3];
  return highlight ? tint128(c[0] * 0.5 + 64, c[1] * 0.5 + 64, c[2] * 0.5 + 64) : tint128(c[0], c[1], c[2]);
}

/** FUN_00467fe0: word-wrapped text; returns the y below it. */
function drawWrapped(p: Painter, font: UiFont, text: string, x: number, y: number, wrap: number, colour: number): number {
  const lay = layoutComputerText(text, x, y, wrap, (w) => penAdvance(font, w), font.lineHeight);
  const tint = textTint(colour, false);
  for (const w of lay.words) if (w.text.trim()) p.text(font, w.text, w.x, w.y, "left", tint, 1);
  return lay.bottom;
}

/** FUN_004abb70 + FUN_004aba40: a rotated, scaled shape as line segments (two -0.5 offsets: the call's and the rasteriser's). */
function drawShape(p: Painter, shape: number, colour: number, x: number, y: number, angle: number, sx: number, sy: number): void {
  const pts = MARKER_SHAPES[shape];
  const col = MARKER_COLOURS[colour];
  if (!pts || !col) return;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const segs: number[] = [];
  const at = (i: number): [number, number] => {
    const px = sx * pts[i][0];
    const py = sy * pts[i][1];
    return angle !== 0 ? [px * c - py * s + x, px * s + py * c + y] : [px + x, py + y];
  };
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = at(i);
    const b = at(i + 1);
    segs.push(a[0] - 0.5, a[1] - 0.5, b[0] - 0.5, b[1] - 0.5);
  }
  // Colours are given 0..255 in the x/128 scale: 255 overflows (carry into the next channel), alpha 0.75.
  p.lines(segs, colour128(col[0], col[1], col[2], 0.75));
}

function drawItem(p: Painter, item: ComputerItem, res: ComputerDrawResources): void {
  if (item.kind === "button" && item.sprites) {
    // FUN_0046a170: _3 while highlighted and held, _2 highlighted, _1 otherwise.
    const name = item.highlighted ? (item.held ? item.sprites[2] : item.sprites[1]) : item.sprites[0];
    const f = frameOf(spriteOf(res.computer, name));
    if (f) p.sprite(f, item.x, item.y, NEUTRAL, 1);
    return;
  }
  const font = item.font ? res.ingame.fonts.get(item.font) : undefined;
  if (font && item.text) p.text(font, item.text, item.x, item.y, "left", textTint(item.colour ?? 3, item.highlighted), 1);
}

/** LAB_00499bd0 (LineFilter, colour (0,0,0)): a black scanline every 4 px at alpha 0x4c, plus grey interference when the intensity is > 0. */
function drawLineFilter(p: Painter, intensity: number, random: () => number): void {
  const scan = [0, 0, 0, 0x4c] as const;
  for (let y = 0; y + 4 <= H; y += 4) p.strip([0.5, y + 0.5, W + 0.5, y + 0.5], scan);
  if (!(intensity > 0)) return;
  let n = intensity * 10;
  let step = 1;
  if (n < 1) {
    step = 1 / n;
    n = 1;
  }
  const count = x87Fistp(n);
  const alpha = x87Fistp(intensity * 255) & 0xff;
  for (let y = step; y <= H; y += step) {
    const row = x87Fistp(y);
    for (let i = 0; i < count; i++) {
      const x0 = random() * W;
      const grey = x87Fistp(random() * 255);
      const x1 = Math.min(random() * 50 + x0, W);
      p.strip([x0 + 0.5, row + 0.5, x1 + 0.5, row + 0.5], [grey, grey, grey, alpha]);
    }
  }
}

/** FUN_00465870 + FUN_00465000: the INITIALIZING / CONNECTING / DOWNLOADING bar. */
function drawStartup(p: Painter, c: MapComputer, res: ComputerDrawResources): void {
  const s = c.map.startup;
  if (!s.running) return;
  if (s.step === 0) p.rect(0, 0, W, H, [0, 0, 0, 255]);
  const L = Math.fround(W * 0.15000000596046448);
  const T = Math.fround(H * 0.6499999761581421);
  const bw = x87Fistp(Math.fround(W * 0.5));
  const bh = x87Fistp(Math.fround(H * 0.02500000037252903));
  // Pre-transformed vertices (no -0.5): +0.5 here so the painter's pixelStart lands on the same pixels.
  const out = [25, 255, 25, 255] as const; // (0.1, 1, 0.1) x 255, chopped
  p.strip([L + 0.5, T + 0.5, L + bw + 0.5, T + 0.5], out);
  p.strip([L + 0.5, T + 0.5, L + 0.5, T + bh + 0.5], out);
  p.strip([L + bw + 0.5, T + bh + 0.5, L + 0.5, T + bh + 0.5], out);
  p.strip([L + bw + 0.5, T + bh + 0.5, L + bw + 0.5, T + 0.5], out);
  const prog = s.timer / STARTUP_STEPS[s.step].ticks;
  const x1 = (W * 0.5 - 1) * prog + L + 0.5;
  p.rect(L + 1 + 0.5, T + 1 + 0.5, x1 + 0.5, T + Math.fround(H * 0.02500000037252903) - 0.5 + 0.5, [0, 127, 25, 255]);
  const font = res.computer.fonts.get("font3.fnt");
  if (font) {
    const text = res.text(STARTUP_STEPS[s.step].key);
    p.text(font, text, L, T - font.lineHeight - 2, "left", tint128(0.1 * 127, 127, 0.1 * 127), 1);
  }
}

function drawMapPage(p: Painter, c: MapComputer, res: ComputerDrawResources, state: ComputerDrawState): void {
  const font4 = res.ingame.fonts.get("font4.fnt");
  for (const m of c.markers()) {
    if (m.kind === "shape") drawShape(p, m.shape, m.colour, m.x, m.y, m.angle, m.sx, m.sy);
    else if (m.kind === "sprite") {
      const s = spriteOf(res.computer, m.sprite);
      const f = frameOf(s, m.frame);
      if (s && f) p.sprite(f, m.x - s.width * 0.5, m.y - s.height * 0.5, NEUTRAL, 1);
    } else if (font4) {
      drawWrapped(p, font4, m.text, m.x, m.y, 128, 0);
    }
  }
  drawLineFilter(p, c.map.noise, state.filterRandom);
  for (const item of c.itemList) drawItem(p, item, res);
  drawStartup(p, c, res);
}

/** FUN_00467ca0 */
function drawObjectivesPage(p: Painter, c: MapComputer, res: ComputerDrawResources, state: ComputerDrawState): void {
  p.rect(0, 0, W, H, [0, 0, 0, 255]);
  const font3 = res.ingame.fonts.get("font3.fnt");
  const font4 = res.ingame.fonts.get("font4.fnt");
  const x = state.mapEnabled ? x87Fistp(W * 0.15) : x87Fistp(W * 0.1);
  let y = x87Fistp(H * 0.1);
  const objectives = state.objectives ?? [];
  for (let i = 0; i < 6; i++) {
    const o = objectives[i];
    if (!o || !o.text) continue;
    if (state.mapEnabled) c.placeObjectiveButton(i, x - 34, y + 2);
    const status = res.text(o.failed ? "FAILED" : o.complete ? "COMPLETE" : "INCOMPLETE");
    const header = `${res.text("OBJECTIVE")} ${i + 1}: ${status}`;
    let y2 = y;
    if (font3) y2 = drawWrapped(p, font3, header, x, y, 400, 2);
    if (font4) y2 = drawWrapped(p, font4, o.text, x, y2, 400, 1);
    y = y2 + 8;
  }
  for (const item of c.itemList) drawItem(p, item, res);
}

/** FUN_00467740 */
function drawLogPage(p: Painter, c: MapComputer, res: ComputerDrawResources, state: ComputerDrawState): void {
  p.rect(0, 0, W, H, [0, 0, 0, 255]);
  const font1 = res.ingame.fonts.get("font1.fnt");
  const x = x87Fistp(W * 0.15);
  let y = x87Fistp(H * 0.1);
  const entries = state.log.entries;
  const n = entries.length;
  const a = colour128(48, 96, 48, 1);
  const b = colour128(0, 16, 0, 1);
  for (let i = 0; i < n && i <= 14; i++) {
    const text = entries[n - c.logScroll - i - 1];
    if (text === undefined) break;
    if (font1) y = drawWrapped(p, font1, text, x, y, 400, 1);
    y += 2;
    // Separator: FUN_004aba40 from (x, y) to (x + 100, y), Gouraud (48,96,48) -> (0,16,0); both -0.5 offsets put it one row up.
    p.gouraud(x - 0.5, y - 1 - 0.5, x + 100 - 0.5, y - 0.5, a, b, a, b);
    y += 2;
  }
  for (const item of c.itemList) drawItem(p, item, res);
}

/** Draw the whole computer screen (immediate order). */
export function drawComputer(p: Painter, c: MapComputer, res: ComputerDrawResources, state: ComputerDrawState): void {
  if (c.page === PAGE.map) drawMapPage(p, c, res, state);
  else if (c.page === PAGE.objectives) drawObjectivesPage(p, c, res, state);
  else drawLogPage(p, c, res, state);
  if (!c.dragging) {
    const s = spriteOf(res.computer, "pointer.spr");
    const f = frameOf(s);
    if (s && f) p.sprite(f, c.pointer.x - s.width * 0.5, c.pointer.y - s.height * 0.5, NEUTRAL, 1);
  }
}

/** True while the multiply layer must tint the world (the map page; the other pages are opaque). */
export function computerNeedsMultiply(c: MapComputer): boolean {
  return c.page === PAGE.map && !(c.map.startup.running && c.map.startup.step === 0);
}

