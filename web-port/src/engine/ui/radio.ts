/**
 * StatusMessageScreen: radio messages and cut-scene subtitles (pure model; no
 * DOM). Evidence: docs/hud.md section 5; decompiles of FUN_00483b30 (update),
 * FUN_00483d20 (wrap), FUN_00483f90 (slot walk), FUN_00484060 / FUN_00484180
 * (radio draw, box) and FUN_00484520 (cut-scene draw).
 *
 * The SENDER rules (Send expression, "Is send once", at most one send per 210
 * ticks, the Sound played on send, the map-computer log) belong to the task
 * runtime that emits GameEvent.StatusMessage, not to this screen.
 */
import type { UiFont } from "../../loaders";
import { STATUS_MESSAGE, x87Fistp } from "../../loaders";
import { wrapRadioText } from "./text";

/** Ticks of the box animation before typing starts (ticks 0-1 open, 2-8 widen). */
export const RADIO_TYPING_START = 9;
/** Width scale step per tick while widening: float32(1/7) (0x5321ec). */
const WIDEN_STEP = 0.1428571492433548;
/** Cut-scene wrap width fraction of the screen width (0x5321e8). */
const CUTSCENE_WRAP_FRACTION = 0.96875;

export interface StatusMessageInput {
  /** Text to show (already resolved from messages.res). */
  text: string;
  /** Portrait sprite name (anya.spr, note.spr, ammo.spr, weapon.spr) or null. */
  portrait: string | null;
  durationSeconds: number;
  cutscene: boolean;
}

export interface StatusSlot {
  readonly text: string;
  readonly portrait: string | null;
  readonly durationSeconds: number;
  readonly cutscene: boolean;
  /** Slot +0x24: ticks updated so far. */
  tick: number;
  /** Slot +0x28: hold counter (radio: after typing; cut-scene: from the first update). */
  hold: number;
  /** Characters typed (radio). */
  typed: number;
  /** Box height scale (+0x48), 0..1. */
  open: number;
  /** Box width scale (+0x44), 0..1 (float32 accumulation). */
  widen: number;
  /** Visible text lines (at most 3). */
  lines: string[];
}

/** Portrait names accepted by the Sprite parameter (strcmp list at 0x53ea04). */
export function normalisePortrait(sprite: string | null | undefined): string | null {
  if (!sprite) return null;
  const short = sprite.slice(sprite.lastIndexOf(":") + 1).toLowerCase();
  const allowed = STATUS_MESSAGE.portraits.map((p) => p.slice(p.indexOf(":") + 1).toLowerCase());
  return allowed.includes(short) ? short : null;
}

export class StatusMessageScreen {
  readonly slots: Array<StatusSlot | null> = new Array(STATUS_MESSAGE.slots).fill(null);

  constructor(
    private readonly radioFont: () => UiFont | null,
    private readonly cutsceneFont: () => UiFont | null,
    private readonly screenWidth = 640,
  ) {}

  /** FUN_004845c0: take the first free slot. Returns false when all 12 are busy. */
  send(input: StatusMessageInput): boolean {
    const free = this.slots.indexOf(null);
    if (free < 0) return false;
    this.slots[free] = {
      text: input.text,
      portrait: input.portrait,
      durationSeconds: Number.isFinite(input.durationSeconds) ? input.durationSeconds : 2,
      cutscene: input.cutscene,
      tick: 0,
      hold: 0,
      typed: 0,
      open: 0,
      widen: 0,
      lines: [],
    };
    return true;
  }

  clear(): void {
    this.slots.fill(null);
  }

  /** One 30 Hz update of every slot (FUN_00483b30). Not called while the game is paused. */
  tick(): void {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s && !this.update(s)) this.slots[i] = null;
    }
  }

  /** Returns false when the slot is removed (FUN_00483cc0). */
  private update(s: StatusSlot): boolean {
    const holdLimit = x87Fistp(s.durationSeconds * 30); // 0x483bf5: float32 x 30.0f, fistp (truncated)
    if (s.cutscene) {
      if (s.hold === 0) {
        const font = this.cutsceneFont();
        s.lines = font ? wrapRadioText(font, s.text, Math.fround(this.screenWidth * CUTSCENE_WRAP_FRACTION)) : [s.text];
      }
      const removed = holdLimit < s.hold;
      s.hold++;
      s.tick++;
      return !removed;
    }
    if (s.tick < RADIO_TYPING_START) {
      if (s.tick < 2) s.open = Math.fround(s.open + 0.5);
      else s.widen = Math.fround(s.widen + WIDEN_STEP);
      s.tick++;
      return true;
    }
    if (s.typed < s.text.length) {
      s.typed++;
      const font = this.radioFont();
      s.lines = font ? wrapRadioText(font, s.text.slice(0, s.typed), STATUS_MESSAGE.wrapWidth) : [s.text.slice(0, s.typed)];
      s.tick++;
      return true;
    }
    s.hold++;
    if (holdLimit < s.hold) return false;
    s.tick++;
    return true;
  }

  /**
   * FUN_00483f90: active slots in order; each one (radio or cut-scene) moves
   * the next radio box 42 px down. Positions in a W x H screen.
   */
  layout(W: number, H: number): Array<{ slot: StatusSlot; x: number; y: number }> {
    const out: Array<{ slot: StatusSlot; x: number; y: number }> = [];
    const x = Math.fround(W * STATUS_MESSAGE.origin.fx);
    let y = Math.fround(H * STATUS_MESSAGE.origin.fy);
    for (const s of this.slots) {
      if (!s) continue;
      if (s.cutscene) out.push({ slot: s, x, y: Math.fround(H * STATUS_MESSAGE.cutscene.fy) });
      else out.push({ slot: s, x, y });
      y += STATUS_MESSAGE.lineStep;
    }
    return out;
  }
}

export interface RadioBoxGeometry {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Alpha of the green fill (0.75 at tick 0, else 0.15). */
  greenAlpha: number;
}

/** FUN_00484180: the message box rectangle for a slot drawn at (x, y). */
export function radioBoxGeometry(slot: StatusSlot, x: number, y: number, portraitHeight: number | null): RadioBoxGeometry {
  const h = portraitHeight ?? STATUS_MESSAGE.defaultHeight;
  const step = Math.trunc((9 - slot.tick) / 9);
  const greenAlpha = (step > 0 ? step : 0) * 0.6000000238418579 + 0.15000000596046448;
  const cy = h * 0.5 + y;
  const half = slot.widen * STATUS_MESSAGE.halfWidth;
  const halfH = h * 0.5 * slot.open;
  return {
    x0: x + STATUS_MESSAGE.halfWidth - half,
    x1: half + x + STATUS_MESSAGE.halfWidth,
    y0: cy - halfH,
    y1: halfH + cy,
    greenAlpha,
  };
}
