/**
 * Submits the in-game HUD (StatusScreen render FUN_00484ea0) in igi.exe's
 * order; draw with PrimList.flush (reverse order). Evidence: docs/hud.md
 * section 4 and the decompiles named per block.
 *
 * Submission order (so the reversed draw puts messages on top and the timer
 * at the bottom):
 *   1. StatusMessageScreen children: radio boxes / cut-scene lines;
 *   2. player HUD (FUN_004130c0): weapon panel (counter, graphic, name, icon,
 *      separator, crosshair) -> action icon -> health background -> health
 *      fill -> progress fill, box, outline -> damage tint -> flash;
 *   3. timer text.
 */
import {
  AMMO_DISPLAY,
  ammoText,
  measureText,
  barrelFrame,
  clipFrame,
  healthBarGeometry,
  HUD,
  shellFrame,
  STATUS_MESSAGE,
  WEAPON_ICON,
  type UiFont,
  type UiFrame,
  type UiSprite,
} from "../../loaders";
import type { UiArchive, WeaponHudInfo } from "./assets";
import {
  ammoCounterValue,
  colour128,
  crosshairPosition,
  NEUTRAL,
  timerText,
  tint128,
  vertexBytes,
  weaponPanelLayout,
  type TintCorners,
} from "./hud-state";
import type { Painter } from "./painter";
import { radioBoxGeometry, type StatusMessageScreen } from "./radio";
import type { BinocularTargets } from "./binocular-targets";
import { submitBinoculars, submitSniperScope, type BinocularBars, type ScopeView } from "./scope";

export interface HudWeaponView {
  info: WeaponHudInfo;
  /** Rounds in the clip / cylinder / tube. */
  clip: number;
  /** Calibre pool (the counter). */
  reserve: number;
  roundsPerClip: number;
  /** Barrel spin counter (gun +0x19c); 0 at rest (inferred). */
  barrelSpin?: number;
  /**
   * GunM16A2 only (FUN_00471e40): the AMMO_ID_M203 pool, drawn as a second
   * "%-4d" counter left of the main clip graphic with M16_alternative.spr;
   * null / undefined = not an M203 carrier.
   */
  m203?: number | null;
}

export interface HudView {
  W: number;
  H: number;
  /** Draw the player HUD (first-person player camera, map computer closed). */
  playerHud: boolean;
  /**
   * The player's camera is the first-person view (mode 1). In the third-person
   * modes (3 attached / using, 5 dead) FUN_0045f070 (0x45f098) skips the
   * health, weapon panel, crosshair and use icon, and FUN_004130c0 (0x413570)
   * the damage tint and flash; the progress bar is drawn in every mode.
   */
  firstPersonView?: boolean;
  /** 1 - damage / maxDamage (clamped at 0). */
  health: number;
  weapon: HudWeaponView | null;
  /** status.res action pictogram (e.g. "a_door.spr") or null. */
  actionIcon: string | null;
  actionAlpha: number;
  /** Timed-action progress 0..1, or null when no timed action runs. */
  progress: number | null;
  tint: TintCorners;
  flashAlpha: number;
  /** Remaining ticks of an interface timer, or null when disabled. */
  timerTicks: number | null;
  /** Zoomed binoculars / sniper scope: drawn instead of the weapon panel. */
  scope?: ScopeView | null;
  binocularBars?: BinocularBars;
  /** Binocular target squares (FUN_00470510) and the wall-clock time they animate with. */
  binocularTargets?: BinocularTargets;
  nowMs?: number;
}

export interface HudResources {
  status: UiArchive;
  /** computer/font3.fnt (HUD texts). */
  hudFont: UiFont;
  /** ingamemenu.res font1.fnt (radio) and font4.fnt (cut-scene). */
  radioFont: UiFont;
  cutsceneFont: UiFont;
  /** common/sprites/sprites.res (scope overlays); optional. */
  commonSprites?: UiArchive;
}

const sprite = (archive: UiArchive, name: string): UiSprite | null => archive.sprites.get(name.toLowerCase()) ?? null;
const frame0 = (s: UiSprite | null): UiFrame | null => s?.frames[0] ?? null;

/** FUN_00484060 + FUN_00484180 / FUN_00484520 for every active slot. */
export function submitStatusMessages(radio: StatusMessageScreen, res: HudResources, W: number, H: number, p: Painter): void {
  const radioTint = tint128(0, 120, 0);
  for (const { slot, x, y } of radio.layout(W, H)) {
    if (slot.cutscene) {
      // FUN_00484520: three text objects one line height apart, font4, default (white) colour.
      let ly = y;
      for (let i = 0; i < 3; i++) {
        const line = slot.lines[i];
        if (line) p.text(res.cutsceneFont, line, x, ly, "left", NEUTRAL, 1);
        ly += res.cutsceneFont.lineHeight;
      }
      continue;
    }
    const portrait = slot.portrait ? frame0(sprite(res.status, slot.portrait)) : null;
    if (portrait && slot.tick > 9) p.sprite(portrait, x, y, NEUTRAL, 1);
    const tx = x + (portrait ? sprite(res.status, slot.portrait!)!.width : 0) + 3;
    let ty = y + 2;
    for (let i = 0; i < 3; i++) {
      const line = slot.lines[i];
      if (line) p.text(res.radioFont, line, tx, ty, "left", radioTint, 1);
      ty += res.radioFont.lineHeight;
    }
    const box = radioBoxGeometry(slot, x, y, portrait ? sprite(res.status, slot.portrait!)!.height : null);
    // Black alpha 0.33, then the green quad: (0, 0.5, 0) at TL/TR/BL and (0, 1, 0) at BR, then the outline.
    p.rect(box.x0, box.y0, box.x1, box.y1, vertexBytes(0, 0, 0, 0.33000001311302185));
    const g = vertexBytes(0, 0.5, 0, box.greenAlpha);
    p.gouraud(box.x0, box.y0, box.x1, box.y1, g, g, g, vertexBytes(0, 1, 0, box.greenAlpha));
    p.strip([box.x0, box.y0, box.x1, box.y0, box.x1, box.y1, box.x0, box.y1, box.x0, box.y0], vertexBytes(0, 0.8999999761581421, 0, 0.5));
  }
}

/** FUN_00478440 (+ FUN_00478940 / a40 / c00 / e30): the weapon panel and crosshair. */
function submitWeaponPanel(view: HudView, res: HudResources, p: Painter): void {
  const w = view.weapon;
  if (!w) return;
  const { info } = w;
  const W = view.W;
  const H = view.H;
  const font = res.hudFont;
  const display = info.ammoDisplay;
  const counter = ammoText(ammoCounterValue(display, w.reserve, w.roundsPerClip));
  let graphic: UiSprite | null = null;
  let graphicFrame = 0;
  if (display === AMMO_DISPLAY.clip) {
    if (info.weaponId === 12) graphic = sprite(res.status, "rocket.spr");
    else {
      graphic = sprite(res.status, "clip20.spr");
      graphicFrame = w.roundsPerClip > 0 ? clipFrame(Math.max(0, w.clip), w.roundsPerClip) : 0;
    }
  } else if (display === AMMO_DISPLAY.barrel) {
    graphic = sprite(res.status, "barrel6.spr");
    graphicFrame = barrelFrame(Math.max(0, w.clip), w.barrelSpin ?? 0);
  } else if (display === AMMO_DISPLAY.shell) {
    graphic = sprite(res.status, "shell7.spr");
    graphicFrame = shellFrame(Math.max(0, w.clip));
  }
  const iconName = WEAPON_ICON[info.weaponId];
  const icon = iconName ? sprite(res.status, iconName) : null;
  const layout = weaponPanelLayout(W, H, font, {
    ammoDisplay: display,
    name: info.name,
    counter,
    icon: icon ? { width: icon.width, height: icon.height } : null,
    graphicWidth: graphic ? graphic.width : null,
  });
  const textTint = NEUTRAL; // computer/font3 has its green baked in
  if (layout.counter) p.text(font, counter, layout.counter.x, layout.counter.y, "left", textTint, 1);
  if (graphic && layout.graphic) {
    const f = graphic.frames[Math.min(graphic.frames.length - 1, graphicFrame)];
    if (f) p.sprite(f, layout.graphic.x, layout.graphic.y, NEUTRAL, 1);
  }
  if (layout.name) p.text(font, info.name, layout.name.x, layout.name.y, "left", textTint, 1);
  if (icon && layout.icon) {
    const f = frame0(icon);
    if (f) p.sprite(f, layout.icon.x, layout.icon.y, NEUTRAL, 1);
  }
  if (layout.separator) {
    const s = layout.separator;
    p.strip([s.x0, s.y, s.x1, s.y], vertexBytes(0, 0.8999999761581421, 0, 0.5));
  }
  if (w.m203 !== undefined && w.m203 !== null && layout.counter) {
    // FUN_00471e40 / FUN_00479190 (after the Gun handler): x0 = W*0.984375 - 4 - 8 - clip20 width - main counter
    // width; the M203 count is right-aligned at x0, M16_alternative.spr 8 px further left; top H*0.8958333 + 4.
    const clip = sprite(res.status, info.weaponId === 12 ? "M16_alternative.spr" : "clip20.spr");
    const alt = sprite(res.status, "M16_alternative.spr");
    const text = ammoText(w.m203);
    let x = Math.fround(W * 0.984375) - 4 - 8 - (clip ? clip.width : 0) - measureText(font, counter);
    const y = Math.fround(H * 0.8958333134651184) + 4;
    x -= measureText(font, text);
    p.text(font, text, x, y, "left", textTint, 1);
    x -= 8;
    if (alt) {
      x -= alt.width;
      const f = frame0(alt);
      if (f) p.sprite(f, x, y, NEUTRAL, 1);
    }
  }
  if (info.sightDisplay === 1) {
    const cross = sprite(res.status, "cross.spr");
    const f = frame0(cross);
    if (cross && f) {
      const c = crosshairPosition(W, H, cross.width, cross.height);
      p.sprite(f, c.x, c.y, NEUTRAL, 1);
    }
  }
}

/** FUN_004130c0 / FUN_0045f070: the player's HUD. */
export function submitPlayerHud(view: HudView, res: HudResources, p: Painter): void {
  const W = view.W;
  const H = view.H;
  const firstPerson = view.firstPersonView !== false;
  // Weapon handler: the zoomed Binocular / GunDRAGUNOV draw their overlay instead of the panel.
  if (!firstPerson) {
    // third-person view: no weapon panel, crosshair, use icon or health (0x45f098)
  } else if (view.scope?.kind === "binoculars" && view.binocularBars) {
    submitBinoculars(view.scope, view.binocularBars, { sprites: res.commonSprites?.sprites ?? new Map(), hudFont: res.hudFont }, W, H, p);
    view.binocularTargets?.submit(p, view.nowMs ?? 0);
  } else if (view.scope?.kind === "sniper") {
    submitSniperScope({ sprites: res.commonSprites?.sprites ?? new Map(), hudFont: res.hudFont }, W, H, p);
  } else {
    submitWeaponPanel(view, res, p);
  }
  // Action icon (FUN_00485130): centre (W/2, H*0.875), top-left = centre - size/2 (integer division).
  if (firstPerson && view.actionIcon) {
    const s = sprite(res.status, view.actionIcon);
    const f = frame0(s);
    if (s && f) {
      const x = Math.fround(W * 0.5) - Math.trunc(s.width / 2);
      const y = Math.fround(H * HUD.actionIcon.fy) - Math.trunc(s.height / 2);
      p.sprite(f, x, y, NEUTRAL, view.actionAlpha);
    }
  }
  // Health (FUN_0045f070).
  const bg = sprite(res.status, "powerbarbackground.spr");
  const bar = sprite(res.status, "powerbar.spr");
  if (firstPerson && bg && bar) {
    const geo = healthBarGeometry(W, H, bg, bar, view.health);
    const f = frame0(bg);
    if (f) p.sprite(f, geo.background.x, geo.background.y, NEUTRAL, 1);
    const fb = frame0(bar);
    if (geo.bar && fb) p.quad(fb, geo.bar.x0, geo.bar.yTop, geo.bar.x1, geo.bar.yBottom, [0, geo.bar.vTop, 1, 1], NEUTRAL, 1);
  }
  // Timed-action progress bar.
  if (view.progress !== null) {
    const pr = Math.max(0, Math.min(1, view.progress));
    const fx = Math.fround(W * HUD.progressFill.fx);
    const fy = Math.fround(H * HUD.progressFill.fy);
    p.rect(fx, fy, fx + pr * W * HUD.progressFill.fw, fy + Math.fround(H * HUD.progressFill.fh), colour128(128, 0, 0, 0.5));
    const bx = Math.fround(W * HUD.progressBox.fx);
    const by = Math.fround(H * HUD.progressBox.fy);
    const bw = Math.fround(W * HUD.progressBox.fw);
    const bh = Math.fround(H * HUD.progressBox.fh);
    p.rect(bx, by, bx + bw, by + bh, colour128(0, 100, 0, 0.5));
    const line = vertexBytes(0, 1, 0, 1);
    p.strip([bx, by, bx + bw, by], line);
    p.strip([bx, by + bh, bx + bw, by + bh], line);
    p.strip([bx, by, bx, by + bh], line);
    p.strip([bx + bw, by, bx + bw, by + bh + 1], line);
  }
  // Damage tint: (255,0,0) in the x/128 scale overflows to (252,0,0) with alpha + 1.
  const t = view.tint;
  if (!firstPerson) return;
  if (t.tl !== 0 || t.tr !== 0 || t.bl !== 0 || t.br !== 0) {
    p.gouraud(0, 0, W, H, colour128(255, 0, 0, t.tl), colour128(255, 0, 0, t.tr), colour128(255, 0, 0, t.bl), colour128(255, 0, 0, t.br));
  }
  // Flash-bang white-out: (255,255,255) -> (253,253,252).
  if (view.flashAlpha > 0) p.rect(0, 0, W, H, colour128(255, 255, 255, view.flashAlpha));
}

/** The whole StatusScreen frame. */
export function submitHud(view: HudView, radio: StatusMessageScreen, res: HudResources, p: Painter): void {
  submitStatusMessages(radio, res, view.W, view.H, p);
  if (!view.playerHud) return;
  submitPlayerHud(view, res, p);
  if (view.timerTicks !== null) {
    // Centred at (W*0.8125, H*0.0416667), computer/font3.
    p.text(res.hudFont, timerText(view.timerTicks), Math.fround(view.W * HUD.timer.fx), Math.fround(view.H * HUD.timer.fy), "centre", NEUTRAL, 1);
  }
}

/** Radio message text colour bytes (0,120,0)/128 -> (0,239,0). */
export const RADIO_TEXT_RGB = STATUS_MESSAGE.textRgb;
