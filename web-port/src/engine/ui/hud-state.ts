/**
 * In-game HUD state and layout rules (pure; no DOM). Evidence: docs/hud.md
 * section 4 plus the decompiles of FUN_004130c0 (overlays), FUN_004112a0
 * (tint decay), FUN_004125xx-0041282a (hit tint), FUN_004112f0 (flash decay),
 * FUN_0045f070 (health), FUN_00478440/940/a40/c00/e30 (weapon panel) and
 * FUN_00485130/FUN_00485220 (action icon).
 */
import { HUD, measureText, x87Fistp, type UiFont } from "../../loaders";

// ---------------------------------------------------------------------------
// Vertex colours (FUN_00504300): channel byte = trunc(v * 255) (fistp in chop
// mode, 0x504501..0x50458d; e.g. 0.5 -> 127), v in 0..1 as
// written into the QVertex (helpers taking the 0..255 "x/128" scale divide by
// 128 first, 0x532a90). The game never clamps: a byte above 255 carries into
// the next higher channel of the packed A8R8G8B8 word.
// ---------------------------------------------------------------------------

export type Bytes4 = readonly [number, number, number, number];
export type Rgb8 = readonly [number, number, number];

/** Pack unit-scale (0..1) vertex values to [r, g, b, a] bytes with the carry chain B -> G -> R -> A. */
export function vertexBytes(r: number, g: number, b: number, a: number): [number, number, number, number] {
  let v = x87Fistp(b * 255);
  const b0 = v & 255;
  v = x87Fistp(g * 255) + (v >> 8);
  const g0 = v & 255;
  v = x87Fistp(r * 255) + (v >> 8);
  const r0 = v & 255;
  v = x87Fistp(a * 255) + (v >> 8);
  return [r0, g0, b0, v & 255];
}

/** Colour given in the engine's 0..255 "x/128" scale (128 = neutral) plus alpha 0..1. */
export function colour128(r: number, g: number, b: number, a = 1): [number, number, number, number] {
  return vertexBytes(r / 128, g / 128, b / 128, a);
}

/** RGB modulate bytes for a colour in the 128 scale (255 = texture unchanged). */
export function tint128(r: number, g: number, b: number): Rgb8 {
  const [R, G, B] = colour128(r, g, b, 0);
  return [R, G, B];
}

export const NEUTRAL: Rgb8 = [255, 255, 255];

// ---------------------------------------------------------------------------
// Damage tint (player +0xdcc TL, +0xdd8 TR, +0xdd0 BL, +0xdd4 BR)
// ---------------------------------------------------------------------------

/** Per-tick decay of each corner alpha: float32 1/45 (0x5314bc). */
export const TINT_DECAY = 0.02222222276031971;

export interface TintCorners {
  tl: number;
  tr: number;
  bl: number;
  br: number;
}

/**
 * Hit direction in the player's view frame, the direction the damage TRAVELS
 * (from the shooter towards the player): right = +x, forward = +y, up = +z.
 */
export type HitDirection = readonly [number, number, number];

export class DamageTint {
  readonly corners: TintCorners = { tl: 0, tr: 0, bl: 0, br: 0 };

  reset(): void {
    this.corners.tl = this.corners.tr = this.corners.bl = this.corners.br = 0;
  }

  /**
   * A hit: v = 0.4 * (1 + rand), rand in [0, 1) (0x4125a8, constants 1.0 and
   * 0.4 at 0x5313f8 / 0x531510).
   *
   * Without a direction all four corners get v. With one (recovered branch
   * structure at 0x4125d9-0x41282a; which world axis is which and the sign
   * convention are INFERRED): the dominant component of the direction in the
   * player's frame picks the full corners, the others get v / 2:
   *   x > 0 (travelling right, shooter on the left)  -> left  corners full
   *   x <= 0                                         -> right corners full
   *   y dominant, y > 0 (shot from behind)           -> bottom corners full
   *   y dominant, y <= 0 (shot from the front)       -> all four full
   *   z dominant, z > 0 (from below)                 -> bottom corners full
   *   z dominant, z <= 0 (from above)                -> top corners full
   */
  hit(rand: number, direction?: HitDirection | null): void {
    const v = Math.fround((rand + 1) * 0.4);
    const half = Math.fround(v * 0.5);
    const c = this.corners;
    const set = (tl: number, tr: number, bl: number, br: number) => {
      c.tl = tl;
      c.tr = tr;
      c.bl = bl;
      c.br = br;
    };
    if (!direction || (direction[0] === 0 && direction[1] === 0 && direction[2] === 0)) {
      set(v, v, v, v);
      return;
    }
    const [x, y, z] = direction;
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    const az = Math.abs(z);
    if (ax > ay && ax > az) {
      if (x > 0) set(v, half, v, half);
      else set(half, v, half, v);
    } else if (ay >= ax && ay >= az) {
      if (y > 0) set(half, half, v, v);
      else set(v, v, v, v);
    } else if (z > 0) set(half, half, v, v);
    else set(v, v, half, half);
  }

  /** FUN_004112a0: each non-zero corner loses 1/45 per tick, clamped at 0. */
  tick(): void {
    const c = this.corners;
    const dec = (a: number) => (a !== 0 ? Math.max(0, Math.fround(a - TINT_DECAY)) : 0);
    c.tl = dec(c.tl);
    c.tr = dec(c.tr);
    c.bl = dec(c.bl);
    c.br = dec(c.br);
  }

  get active(): boolean {
    const c = this.corners;
    return c.tl !== 0 || c.tr !== 0 || c.bl !== 0 || c.br !== 0;
  }
}

/**
 * Flash-bang white-out (player +0xddc). A flash in range sets the value to 2.0
 * (0x4130a8). Each tick (FUN_004112f0) it drops by 1/90 while above 1.0 and by
 * 1/60 at or below 1.0 (0x5314c4 / 0x5314c0), clamped at 0. Drawn as a
 * full-screen white rectangle with alpha clamp(value, 0, 0.99) (FUN_004130c0).
 */
export class FlashBang {
  value = 0;

  trigger(value = 2): void {
    this.value = value;
  }

  tick(): void {
    if (this.value === 0) return;
    this.value = Math.fround(this.value - (this.value > 1 ? 0.011111111380159855 : 0.01666666753590107));
    if (this.value < 0) this.value = 0;
  }

  get alpha(): number {
    return this.value <= 0 ? 0 : this.value > 0.99 ? 0.99 : this.value;
  }
}

/**
 * Action-icon pulse: the StatusScreen update (FUN_00484c40) adds 1/15 per tick
 * and sets the phase to 0 once it exceeds 2; the draw (FUN_00485130) uses
 * tri = p < 1 ? p : 2 - p and alpha = 0.3 + 0.7 * tri; FUN_00485220 resets the
 * phase to 0 whenever there is no use target.
 */
export class ActionPulse {
  phase = 0;

  tick(hasTarget: boolean): void {
    if (!hasTarget) {
      this.phase = 0;
      return;
    }
    this.phase = Math.fround(this.phase + HUD.actionPulseStep);
    if (this.phase > 2) this.phase = 0;
  }

  get alpha(): number {
    const tri = this.phase >= 1 ? 2 - this.phase : this.phase;
    return Math.fround(tri * 0.699999988079071 + 0.30000001192092896);
  }
}

// ---------------------------------------------------------------------------
// Weapon panel (FUN_00478440 & co.)
// ---------------------------------------------------------------------------

export interface WeaponPanelInput {
  /** Ammo display type (AMMO_DISPLAY): 0 none, 1 normal, 2 clip, 3 barrel, 4 shell, 5 grenade. */
  ammoDisplay: number;
  /** Weapon name text (config Name). */
  name: string;
  /** Counter text ("%-4d"). */
  counter: string;
  /** Icon sprite size, or null when the weapon has no icon. */
  icon: { width: number; height: number } | null;
  /** Clip / barrel / shell graphic sprite width, or null. */
  graphicWidth: number | null;
}

export interface WeaponPanelLayout {
  /** Counter text top-left (null when not drawn). */
  counter: { x: number; y: number } | null;
  /** Clip/barrel/shell graphic top-left (null when not drawn). */
  graphic: { x: number; y: number } | null;
  name: { x: number; y: number } | null;
  icon: { x: number; y: number } | null;
  /** Separator line from (x0, y) to (x1, y), x0 > x1 (drawn leftwards). */
  separator: { x0: number; x1: number; y: number } | null;
}

/**
 * Positions of the weapon panel elements in a W x H screen. Text widths come
 * from FUN_004ad200 (= measureText) and heights from FUN_004ad210 (= line
 * height x 1 row). All values float32 as in the exe.
 */
export function weaponPanelLayout(W: number, H: number, font: UiFont, input: WeaponPanelInput): WeaponPanelLayout {
  const right = Math.fround(W * HUD.weaponRight.fx);
  const base = Math.fround(H * HUD.weaponRight.fy);
  const textH = font.lineHeight;
  const out: WeaponPanelLayout = { counter: null, graphic: null, name: null, icon: null, separator: null };
  let nameWidth = 0;
  let iconWidth = 0;
  if (input.ammoDisplay !== 0) {
    const counterW = measureText(font, input.counter);
    const cx = right - HUD.ammoInset;
    out.counter = { x: cx - counterW, y: base + HUD.ammoInset };
    if (input.graphicWidth !== null && (input.ammoDisplay === 2 || input.ammoDisplay === 3 || input.ammoDisplay === 4)) {
      out.graphic = { x: cx - HUD.ammoGraphicGap - input.graphicWidth - counterW, y: base + HUD.ammoInset };
    }
    nameWidth = measureText(font, input.name);
    out.name = { x: right - nameWidth, y: base - 2 - textH };
  }
  if (input.icon) {
    out.icon = { x: right - input.icon.width, y: base - 2 - 2 - input.icon.height - textH };
    iconWidth = input.icon.width;
  }
  if (input.ammoDisplay !== 0) {
    const span = iconWidth < nameWidth ? nameWidth + 3 : iconWidth;
    out.separator = { x0: right, x1: right - span, y: base };
  }
  return out;
}

/** Counter value shown for the display type: the calibre pool; BARREL shows pool / rounds-per-clip. */
export function ammoCounterValue(ammoDisplay: number, reserve: number, roundsPerClip: number): number {
  if (ammoDisplay === 3 && roundsPerClip > 0) return Math.trunc(reserve / roundsPerClip);
  return Math.trunc(reserve);
}

/** Crosshair top-left (FUN_00478440): W/2 - trunc(w/2), H/2 - trunc(h/2) (fistp in chop mode, 0x47886c / 0x478887). */
export function crosshairPosition(W: number, H: number, w: number, h: number): { x: number; y: number } {
  return { x: W * 0.5 - x87Fistp(w * 0.5), y: H * 0.5 - x87Fistp(h * 0.5) };
}

/** "Time Left: %d minute%s, %d second%s" (0x53eef8); remaining = 30 * MaxTime - tick. */
export function timerText(remainingTicks: number): string {
  const seconds = Math.max(0, Math.trunc(remainingTicks / 30));
  const m = Math.trunc(seconds / 60);
  const s = seconds % 60;
  return `Time Left: ${m} minute${m === 1 ? "" : "s"}, ${s} second${s === 1 ? "" : "s"}`;
}
