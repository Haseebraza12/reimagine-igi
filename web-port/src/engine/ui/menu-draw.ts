/**
 * Submits a MenuManager's primitives in igi.exe's order (draw them with
 * PrimList.flush for the reverse-order rule). Evidence: FUN_004177e0
 * (manager), FUN_00421290 / FUN_00421340 / FUN_004210e0 (screen, window frame,
 * logo), FUN_00421d40 (frame sprites), FUN_004207a0 / FUN_0041ff60 (texts +
 * glow), FUN_0041c860 (dialog), FUN_0041a3d0 (scroll list), FUN_0041b080
 * (picture box), FUN_0041b7a0 + FUN_0041b8b0 (text box), FUN_00423f50 (box),
 * FUN_00424210 (pointer).
 */
import { x87Fistp, type UiFont, type UiFrame } from "../../loaders";
import type { UiArchive } from "./assets";
import type { BackgroundFx } from "./bgfx";
import { colour128, NEUTRAL, tint128, vertexBytes, type Rgb8 } from "./hud-state";
import type { MenuItem, MenuManager } from "./menu-model";
import { submitAscii, submitControls, submitInput, submitList, submitSlide, submitToggle, submitType, type WidgetHost, type WidgetItem } from "./menu-widgets";
import type { Painter } from "./painter";
import { wrapTextBox } from "./text";

/** ColourIndex palette at 0x539728 (and 0x5396b8 for MenuTextConditional), 0..255 "x/128" scale. */
export const MENU_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [128, 128, 128],
  [0, 128, 0],
  [128, 95, 0],
  [64, 128, 64],
];

export interface MenuDrawResources {
  /** The manager's resource archive (menusystem.res or ingamemenu.res). */
  archive: UiArchive;
  missionSprites: UiArchive;
  /** Windows country "USA": logo_us.pic (+12 px). */
  usa: boolean;
  bgfx: BackgroundFx | null;
}

const textAlpha = (fade: number) => {
  const a = (fade - 8) * 0.125;
  return a <= 0 ? 0 : a;
};

const frameOf = (archive: UiArchive, name: string): UiFrame | null => archive.sprites.get(name.toLowerCase())?.frames[0] ?? null;

function paletteTint(index: number, highlight: boolean, scale = 1): Rgb8 {
  const c = MENU_PALETTE[index] ?? MENU_PALETTE[0];
  const t = (v: number) => (highlight ? v * 0.5 + 64 : v) * scale;
  return tint128(t(c[0]), t(c[1]), t(c[2]));
}

/** FUN_004177e0: pointer (state 2 only), popup, then screen. */
export function submitMenu(m: MenuManager, res: MenuDrawResources, p: Painter): void {
  if (!m.screen || m.state === 9) return;
  if (m.state === 2) {
    const pointer = frameOf(res.archive, "pointer.spr");
    // FUN_00424210: drawn at the mouse position + (-2, 0) (+0x2c = -2), neutral.
    if (pointer) p.sprite(pointer, m.pointer.x - 2, m.pointer.y, NEUTRAL, 1);
  }
  widgetHost = m.host;
  if (m.popup) submitItem(m.popup, m.fade, res, p);
  const screenFade = m.state === 7 || m.state === 8 || m.state === 15 ? 16 : m.fade;
  submitItem(m.screen, screenFade, res, p);
  widgetHost = null;
}

/** The manager whose widgets are being drawn (texts, fonts and sprite sizes come through it). */
let widgetHost: WidgetHost | null = null;

function submitWidget(item: MenuItem, fade: number, res: MenuDrawResources, p: Painter): void {
  const w = item.widget;
  const host = widgetHost;
  if (!w || !host) return;
  const wi = item as WidgetItem;
  const sprite = (name: string) => frameOf(res.archive, name);
  switch (w.kind) {
    case "slide":
      submitSlide(wi, w, fade, host, sprite, p);
      break;
    case "toggle":
      submitToggle(wi, w, fade, host, p);
      break;
    case "list":
      submitList(wi, w, fade, host, sprite, p);
      break;
    case "input":
      submitInput(wi, w, fade, host, p);
      break;
    case "controls":
      submitControls(wi, w, fade, host, p);
      break;
    case "ascii":
      submitAscii(wi, w, fade, host, sprite, p);
      break;
    case "type":
      submitType(wi, w, fade, host, MENU_PALETTE, p);
      break;
  }
}

function submitChildren(item: MenuItem, fade: number, res: MenuDrawResources, p: Painter): void {
  for (const c of item.children) submitItem(c, fade, res, p);
}

export function submitItem(item: MenuItem, fade: number, res: MenuDrawResources, p: Painter): void {
  switch (item.kind) {
    case "screen":
      submitChildren(item, fade, res, p);
      submitWindowFrame(item, fade, p, res.archive.pictures.has(item.background));
      {
        // FUN_004210e0: logo at x = trunc(320 - w/2) (0x42116c..0x421185: fild w; fmul 0.5f; fsubr 320.0f; fistp, chop mode)
        // (+12 for logo_us), y = (H>>1) - 220.
        const logoName = res.usa ? "logo_us.pic" : "logo.pic";
        const logo = res.archive.pictures.get(logoName);
        if (logo) p.image(logo, x87Fistp(320 - logo.width * 0.5) + (res.usa ? 12 : 0), 240 - 220);
      }
      if (res.bgfx) res.bgfx.submit(p);
      {
        const bg = item.background ? res.archive.pictures.get(item.background) : undefined;
        if (bg) p.image(bg, 0, 0);
      }
      return;
    case "frame":
      submitChildren(item, fade, res, p);
      if (item.sprite) submitFrameSprites(item, res.archive, p);
      return;
    case "text":
      submitText(item, fade, res, p);
      return;
    case "dialog":
      submitChildren(item, fade, res, p);
      submitDialogFrame(item, fade, p);
      return;
    case "picture": {
      const a = textAlpha(fade);
      submitChildren(item, fade, res, p);
      const entry = item.entries[item.activeIndex];
      const pic = entry ? frameOf(res.missionSprites, entry.text) : null;
      if (pic) p.quad(pic, item.x + 2, item.y + 2, item.x + item.w - 2, item.y + item.h - 2, [0, 0, 1, 1], NEUTRAL, a);
      submitBox(item, 0.5, a, false, p);
      return;
    }
    case "textbox": {
      const a = textAlpha(fade);
      const font = res.archive.fonts.get(item.font);
      const entry = item.entries[item.activeIndex];
      if (font && entry) {
        for (const w of wrapTextBox(font, entry.text, item.x + 4, item.y + 4, item.w - 8)) {
          p.text(font, w.text, w.x, w.y, "left", NEUTRAL, a);
        }
      }
      submitBox(item, 0.5, a, false, p);
      submitChildren(item, fade, res, p);
      return;
    }
    case "scrolllist":
      submitScrollList(item, fade, res, p);
      return;
    case "widget":
      submitChildren(item, fade, res, p);
      submitWidget(item, fade, res, p);
      return;
    default:
      submitChildren(item, fade, res, p);
      return;
  }
}

/** FUN_004207a0 / FUN_0041ff60 */
function submitText(item: MenuItem, fade: number, res: MenuDrawResources, p: Painter): void {
  if (item.type === "MenuTextConditional" && !item.visible) return;
  submitChildren(item, fade, res, p);
  const font: UiFont | undefined = res.archive.fonts.get(item.font);
  if (!font || !item.text) return;
  let alpha = textAlpha(fade);
  const highlight = fade === 16 && item.highlighted;
  if (item.type === "MenuTextConditional" && !item.enabled) alpha *= 0.5;
  p.text(font, item.text, item.x, item.y, "left", paletteTint(item.colour, highlight), alpha);
  if (highlight) {
    const glow = frameOf(res.archive, "glow.spr");
    if (glow) {
      const x0 = item.x - item.w * 0.4000000059604645;
      const y0 = item.y - item.h * 0.20000000298023224;
      const x1 = item.w * 1.7999999523162842 + x0;
      const y1 = item.h * 1.399999976158142 + y0;
      // Additive (flag 8), tinted palette x 0.2, vertex alpha forced to 1.
      p.quad(glow, x0, y0, x1, y1, [0, 0, 1, 1], paletteTint(item.colour, false, 0.20000000298023224), 1, true);
    }
  }
}

/** FUN_00421340: the MenuScreen window frame, opening horizontally from x = 320 over 8 fade steps. */
export function submitWindowFrame(item: MenuItem, fade: number, p: Painter, hasBackground: boolean): void {
  const f = Math.min(1, fade * 0.125);
  const x0 = (item.frame[0] + 1 - 320) * f + 320;
  const x1 = (item.frame[2] + 1 - 320) * f + 320;
  const y0 = item.frame[1] + 1;
  const y1 = item.frame[3] + 1;
  const line = vertexBytes(0, 0.75, 0, f);
  p.strip([x0, y0, x1, y0, x1, y1, x0, y1, x0, y0], line);
  p.strip([x0, y0 + 20, x1, y0 + 20], line);
  const top = vertexBytes(0, 1, 0, f * 0.20000000298023224);
  const bottom = vertexBytes(0, 1, 0, f * 0.05000000074505806);
  p.gouraud(x0, y0, x1, y1, top, top, bottom, bottom);
  if (!hasBackground) p.rect(x0, y0, x1, y1, vertexBytes(0, 0, 0, f * 0.6600000262260437));
}

/** FUN_0041c860: dialog window scaling from its centre. */
function submitDialogFrame(item: MenuItem, fade: number, p: Painter): void {
  const f = Math.min(1, fade * 0.125);
  const X0 = item.x;
  const Y0 = item.y;
  const X1 = item.x + item.w;
  const Y1 = item.y + item.h;
  const cx = (X1 + X0) * 0.5;
  const cy = (Y1 + Y0) * 0.5;
  const x0 = (X0 - cx) * f + cx;
  const x1 = (X1 - cx) * f + cx;
  const y0 = (Y0 - cy) * f + cy;
  const y1 = (Y1 - cy) * f + cy;
  const header = (Y0 + 20 - cy) * f + cy;
  const line = vertexBytes(0, 0.75, 0, f);
  p.strip([x0, y0, x1, y0, x1, y1, x0, y1, x0, y0], line);
  p.strip([x0, header, x1, header], line);
  const top = vertexBytes(0, 1, 0, f * 0.20000000298023224);
  const bottom = vertexBytes(0, 1, 0, f * 0.05000000074505806);
  p.gouraud(x0, y0, x1, y1, top, top, bottom, bottom);
  p.rect(x0, y0, x1, y1, vertexBytes(0, 0, 0, f * 0.8999999761581421));
}

/** FUN_00423f50: outline (0,1,0) or (0.5,1,0.5) when focused, then black fill. */
function submitBox(item: { x: number; y: number; w: number; h: number }, black: number, alpha: number, focused: boolean, p: Painter): void {
  const X = item.x;
  const Y = item.y;
  const rb = focused ? 0.5 : 0;
  p.strip([X + 1, Y + 1, X + item.w, Y + 1, X + item.w, Y + item.h, X + 1, Y + item.h, X + 1, Y + 1],
    vertexBytes(rb, 1, rb, alpha > 0.9900000095367432 ? 1 : alpha));
  p.rect(X, Y, X + item.w, Y + item.h, vertexBytes(0, 0, 0, black * alpha));
}

/** FUN_0041a3d0 */
function submitScrollList(item: MenuItem, fade: number, res: MenuDrawResources, p: Painter): void {
  const a = textAlpha(fade);
  const font = res.archive.fonts.get(item.font);
  const visible = Math.trunc((item.h - 4) / item.rowHeight);
  const count = Math.min(visible, item.entries.length);
  const scroll = visible < item.entries.length ? item.scroll : 0;
  const selectedRow = item.activeIndex - scroll;
  let y = item.y + 2;
  for (let r = 0; r < count; r++) {
    const entry = item.entries[scroll + r];
    const sel = r === selectedRow;
    if (font && entry) p.text(font, entry.text, item.x + 4, y, "left", sel ? tint128(64, 128, 64) : tint128(0, 128, 0), a);
    if (sel) p.rect(item.x + 2, y, item.x + 2 + (item.w - 4), y + item.rowHeight, colour128(0, 80, 0, a));
    y += item.rowHeight;
  }
  submitBox(item, 0.5, a, item.focused, p);
}

/** FUN_00421d40 + FUN_00421e10 / FUN_00422010: "<sprite>_1..8.spr" frame around a MenuFrame. */
function submitFrameSprites(item: MenuItem, archive: UiArchive, p: Painter): void {
  const s: Array<UiFrame | null> = [];
  for (let i = 1; i <= 8; i++) s.push(frameOf(archive, `${item.sprite}_${i}.spr`));
  if (!s[0]) return;
  const size = (f: UiFrame | null) => ({ w: f?.width ?? 0, h: f?.height ?? 0 });
  const row = (x: number, y: number, w: number, a: number, b: number, c: number, bottom: boolean): number => {
    const A = size(s[a]);
    const B = size(s[b]);
    const C = size(s[c]);
    const maxH = Math.max(A.h, B.h, C.h);
    if (bottom) y -= maxH;
    if (A.w && s[a]) {
      p.sprite(s[a]!, x, y, NEUTRAL, 1);
      x += A.w;
      w -= A.w;
    }
    if (!B.w) x += w - C.w;
    else for (let n = Math.trunc((w - C.w) / B.w); n > 0; n--) {
      p.sprite(s[b]!, x, y, NEUTRAL, 1);
      x += B.w;
    }
    if (C.w && s[c]) p.sprite(s[c]!, x, y, NEUTRAL, 1);
    return maxH;
  };
  const column = (x: number, y: number, h: number, k: number, right: boolean) => {
    const f = s[k];
    if (!f) return;
    let n = Math.trunc(h / f.height);
    if (right) x -= f.width;
    for (; n > 0; n--) {
      p.sprite(f, x, y, NEUTRAL, 1);
      y += f.height;
    }
  };
  const top = row(item.x, item.y, item.w, 0, 1, 2, false);
  const bottom = row(item.x, item.y + item.h, item.w, 6, 5, 4, true);
  const mid = item.h - (bottom + top);
  column(item.x, item.y + top, mid, 7, false);
  column(item.x + item.w, item.y + top, mid, 3, true);
}
