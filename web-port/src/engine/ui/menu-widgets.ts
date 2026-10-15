/**
 * The menu widgets of igi.exe's MenuManager that the original menus use
 * besides texts and lists: SlideBar, ToggleBox, ListBox, InputBox,
 * ControlsMenu, AsciiBox (Read Me) and TypeWriterBox (Credits). Pure model +
 * submission (draw with PrimList.flush: the menu's per-frame list is drawn
 * in reverse order of submission). Evidence: docs/hud.md section 12.
 *
 * Recovered (image base 0x400000):
 *   SlideBar      class FUN_0041e9c0: ctor 41ec20 (300,230, track 50, horizontal,
 *                 caret 0.05), init 41edb0 (sprites "<res>_1/_2/_3.spr", size),
 *                 load 41f5a0, update 41f080, draw 41f350, value<->index 41f900 / 41f940.
 *   ToggleBox     FUN_0041df80: ctor 41e100 (50x15, on), init 41e260 ("Yes" / "No"
 *                 labels, font4), load 41e750, update 41e350, draw 41e460.
 *   ListBox       FUN_00418f80: ctor 4191b0 (text width 100), init 419360, load 419920,
 *                 update 419560, draw 419660.
 *   InputBox      FUN_004183c0: ctor 4185d0 (height 15, 20 chars), init 4186e0 (font1),
 *                 update 418790, draw 418a50, insert 4189d0, delete 418990.
 *   ControlsMenu  FUN_00422710: ctor 422920 (360x200), init 422a40, update 422b50,
 *                 load 423400, save 423500, draw 422f00 (+ 422f80 frame, 423110 rows),
 *                 reset 422e10, set 422dc0.
 *   AsciiBox      FUN_0041d580: ctor 41d750 (100x100 + vertical "slidevert" bar
 *                 41f850), init 41dac0, text load + wrap 41d850 / 41d9c0, update 41dba0,
 *                 draw 41dc70.
 *   TypeWriterBox FUN_0041cc90: ctor 41ce20, init 41cf80 (130-entry script at
 *                 0x537cd8), update 41d0b0, draw 41d160.
 *   MenuButton    FUN_00420aa0 (the SlideBar / ListBox end buttons; update 420c40, draw 420c70).
 *   Box           FUN_00423f50 (outline (0,1,0) or (0.5,1,0.5) when highlighted + black x 0.5).
 *   Hover / click FUN_00423e70.
 */
import { LevelRng } from "../ai/rng";
import { measureText, x87Fistp, type IgiTask, type TaskParam, type UiFont, type UiFrame } from "../../loaders";
import { CONTROL_ACTIONS, CONTROL_KEYS, DEFAULT_BINDINGS } from "./menu-config";
import { colour128, NEUTRAL, tint128, vertexBytes } from "./hud-state";
import type { Painter } from "./painter";
import { penAdvance } from "./text";

/** Menu key codes (copied from menu-model to avoid an import cycle). */
const KEY = { LEFT: -1, RIGHT: -2, UP: -3, DOWN: -4, BACKSPACE: -5, DELETE: -6, RETURN: -7, ESCAPE: -8, HOME: -9, END: -10 } as const;

export interface HoverTarget {
  hoverPrev: boolean;
  hover: boolean;
  armed: boolean;
  clicked: boolean;
}

export interface Rect extends HoverTarget {
  x: number;
  y: number;
  w: number;
  h: number;
}

const rect = (x = 0, y = 0, w = 0, h = 0): Rect => ({ x, y, w, h, hoverPrev: false, hover: false, armed: false, clicked: false });

/** The window the widget is (the MenuItem fields it reads and writes). */
export interface WidgetItem {
  x: number;
  y: number;
  w: number;
  h: number;
  /** +0x50 key command (LEFT / RIGHT / RETURN from the selectable parent frame). */
  command: number;
  /** +0x4d */
  highlighted: boolean;
  params: Record<string, TaskParam>;
  type: string;
  id: number;
}

export interface WidgetHost {
  /** Evaluate a script with `self` as "this" (float mode for data scripts). */
  evaluate(script: string, self: WidgetItem, mode: "int" | "float"): number;
  /** Evaluate a string-valued data script (InputBox Get Data); null when it does not give a string. */
  evaluateString(script: string, self: WidgetItem): string | null;
  /** Begin collecting list entries for `list` (Config_Fill* add to it). */
  collectInto(list: ListState | null): void;
  sound(name: string): void;
  spriteSize(name: string): { w: number; h: number } | null;
  /** Menu text resource ("Yes", "MoveLeft", "KEY_LEFT", ...). */
  text(key: string): string;
  font(name: string): UiFont | null;
  /** FUN_00423e70 against the manager's pointer and buttons. */
  hoverTest(target: HoverTarget, x: number, y: number, w: number, h: number): void;
  pointer(): { x: number; y: number };
  /** FUN_00417dd0 / FUN_00417de0: manager state 3 (widget owns the keyboard) / back to 2. */
  lock(): void;
  unlock(): void;
  /** The manager's key queue (FUN_00488cf0); chars are positive, special keys negative. */
  nextKey(): number | null;
  flushKeys(): void;
  /** Raw key / button pressed since the last update (DirectInput state edges): a CONTROL_KEYS name, or null. */
  rawPress(): string | null;
  /** DIK_ESCAPE held (the ControlsMenu's cancel test reads the key state directly). */
  escapeDown(): boolean;
  /** FUN_00417ee0: the manager's "modified" flag (+0x2444; also blocks the idle attract timer). */
  modified(): void;
  /** Logic ticks run and the logic rate (FUN_00402a30 / FUN_004029f0) for the caret blink. */
  ticks(): number;
  rate(): number;
  /** Action bindings: key table index per CONTROL_ACTIONS row, and writing them back. */
  bindings(): number[];
  setBindings(rows: number[]): void;
  /** Read Me text (AsciiBox "Text File"), or null. */
  textFile(name: string): string | null;
  /** The TypeWriterBox script (credits table of igi.exe), or null. */
  typewriterScript(): TypewriterEntry[] | null;
}

const num = (v: TaskParam | undefined, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: TaskParam | undefined): string => (typeof v === "string" ? v : "");
const bool = (v: TaskParam | undefined, d: boolean): boolean => (v === true || v === 1 ? true : v === false || v === 0 ? false : d);
const fadeAlpha = (fade: number) => {
  const a = (fade - 8) * 0.125;
  return a <= 0 ? 0 : a;
};

// ---------------------------------------------------------------------------
// Box (FUN_00423f50)
// ---------------------------------------------------------------------------

export function submitWidgetBox(item: { x: number; y: number; w: number; h: number }, black: number, alpha: number, highlighted: boolean, p: Painter): void {
  const X = item.x;
  const Y = item.y;
  const rb = highlighted ? 0.5 : 0;
  p.strip([X + 1, Y + 1, X + item.w, Y + 1, X + item.w, Y + item.h, X + 1, Y + item.h, X + 1, Y + 1],
    vertexBytes(rb, 1, rb, alpha > 0.9900000095367432 ? 1 : alpha));
  p.rect(X, Y, X + item.w, Y + item.h, vertexBytes(0, 0, 0, black * alpha));
}

// ---------------------------------------------------------------------------
// SlideBar
// ---------------------------------------------------------------------------

export interface SlideState {
  kind: "slide";
  sprite: string;
  horizontal: boolean;
  /** +0xac track length ("Size"). */
  track: number;
  /** +0xa0 value 0..1 (double), +0xb0 nValue. */
  value: number;
  nValue: number;
  /** +0xa8 caret step, +0x248 number of options (0 = continuous). */
  caret: number;
  options: number;
  b1: Rect;
  b2: Rect;
  knob: { w: number; h: number } | null;
  bar: HoverTarget;
  get: string;
  set: string;
  modify: string;
  numScript: string;
}

export function createSlide(item: WidgetItem, host: WidgetHost, overrides: Partial<SlideState> = {}): SlideState {
  const p = item.params;
  const s: SlideState = {
    kind: "slide",
    sprite: str(p["Sprite Resource"]).toLowerCase(),
    horizontal: bool(p.Horizontal, true),
    track: num(p.Size, 50),
    value: 0,
    nValue: 0,
    caret: 0.05000000074505806,
    options: 0,
    b1: rect(),
    b2: rect(),
    knob: null,
    bar: rect(),
    get: str(p["Get Data Script"]),
    set: str(p["Set Data Script"]),
    modify: str(p["Modify Data Script"]),
    numScript: str(p["Set Num Options"]),
    ...overrides,
  };
  const caret = str(p["Carret Speed"]).trim();
  if (caret) s.caret = Math.fround(host.evaluate(caret, item, "float"));
  layoutSlide(item, s, host);
  return s;
}

/** FUN_0041edb0 size rule. */
export function layoutSlide(item: WidgetItem, s: SlideState, host: WidgetHost): void {
  const b1 = host.spriteSize(`${s.sprite}_1.spr`) ?? { w: 0, h: 0 };
  const b2 = host.spriteSize(`${s.sprite}_2.spr`) ?? { w: 0, h: 0 };
  s.knob = host.spriteSize(`${s.sprite}_3.spr`);
  s.b1.w = b1.w;
  s.b1.h = b1.h;
  s.b2.w = b2.w;
  s.b2.h = b2.h;
  if (s.horizontal) {
    item.w = s.track + b2.w + 6 + b1.w;
    const m = Math.max(b1.h, b2.h);
    item.h = s.knob ? (s.knob.h < m ? m + 4 : s.knob.h + 4) : 4;
  } else {
    item.h = s.track + b2.h + 6 + b1.h;
    const m = Math.max(b1.w, b2.w);
    item.w = s.knob ? (s.knob.w < m ? m + 4 : s.knob.w + 4) : 4;
  }
}

/** FUN_0041f940 */
export const slideFromIndex = (s: SlideState, i: number) => {
  if (s.options !== 0) s.value = Math.fround((i + 0.5) / s.options);
};
/** FUN_0041f900 */
export const slideIndex = (s: SlideState) => (s.options !== 0 ? x87Fistp((s.options - 1) * s.value + 0.5) : 0);

function placeSlideButtons(item: WidgetItem, s: SlideState): void {
  const x = item.x + 2;
  const y = item.y + 2;
  s.b1.x = x;
  s.b1.y = y;
  if (s.horizontal) {
    s.b2.x = x + s.b1.w + 1 + s.track + 1;
    s.b2.y = y;
  } else {
    s.b2.x = x;
    s.b2.y = item.y + 3 + s.b1.h + s.track + 1;
  }
}

/** FUN_0041f5a0 */
export function loadSlide(item: WidgetItem, s: SlideState, host: WidgetHost): void {
  if (s.numScript.trim()) s.options = x87Fistp(host.evaluate(s.numScript, item, "float"));
  if (s.get.trim()) {
    const v = host.evaluate(s.get, item, "float");
    if (s.options === 0) s.value = v;
    else slideFromIndex(s, x87Fistp(v));
  }
}

/** FUN_0041f080 */
export function updateSlide(item: WidgetItem, s: SlideState, host: WidgetHost): void {
  const step = s.options === 0 ? s.caret : 1 / (s.options - 1);
  placeSlideButtons(item, s);
  host.hoverTest(s.b1, s.b1.x, s.b1.y, s.b1.w, s.b1.h);
  host.hoverTest(s.b2, s.b2.x, s.b2.y, s.b2.w, s.b2.h);
  let v = s.value;
  let changed = false;
  if (s.b1.clicked || item.command === KEY.LEFT) {
    if (s.value > 0) {
      changed = true;
      host.sound("menu_high");
      v = s.value - step;
    }
  } else if (s.b2.clicked || item.command === KEY.RIGHT) {
    if (s.value < 1) {
      changed = true;
      host.sound("menu_high");
      v = step + s.value;
    }
  } else if (s.knob) {
    const tx = s.horizontal ? item.x + 2 + s.b1.w + 1 : item.x + 2;
    const ty = s.horizontal ? item.y + 2 : item.y + 3 + s.b1.h;
    const tw = s.horizontal ? s.track : s.knob.w;
    const th = s.horizontal ? s.knob.h : s.track;
    host.hoverTest(s.bar, tx, ty, tw, th);
    if (s.bar.armed) {
      const pt = host.pointer();
      changed = true;
      v = s.horizontal ? (pt.x - tx) / (s.track - s.knob.w) : (pt.y - ty) / (s.track - s.knob.h);
    }
  }
  if (s.options !== 0) v = Math.floor((s.options - 1) * v + 0.5) / (s.options - 1);
  v = v < 0 ? 0 : v > 1 ? 1 : v;
  s.value = v;
  s.nValue = slideIndex(s);
  if (changed && s.modify.trim()) {
    host.evaluate(s.modify, item, "int");
    host.modified();
  }
}

/** FUN_0041f350 */
export function submitSlide(item: WidgetItem, s: SlideState, fade: number, host: WidgetHost, sprite: (name: string) => UiFrame | null, p: Painter): void {
  const a = fadeAlpha(fade);
  placeSlideButtons(item, s);
  const f1 = sprite(`${s.sprite}_1.spr`);
  const f2 = sprite(`${s.sprite}_2.spr`);
  if (f1) p.sprite(f1, s.b1.x, s.b1.y, NEUTRAL, a);
  if (f2) p.sprite(f2, s.b2.x, s.b2.y, NEUTRAL, a);
  const fk = sprite(`${s.sprite}_3.spr`);
  if (fk && s.knob) {
    if (s.horizontal) p.sprite(fk, item.x + 2 + s.b1.w + 1 + x87Fistp((s.track - s.knob.w) * s.value), item.y + 2, NEUTRAL, a);
    else p.sprite(fk, item.x + 2, item.y + 3 + s.b1.h + x87Fistp((s.track - s.knob.h) * s.value), NEUTRAL, a);
  }
  submitWidgetBox(item, 0.5, a, item.highlighted, p);
  void host;
}

// ---------------------------------------------------------------------------
// ToggleBox
// ---------------------------------------------------------------------------

export interface ToggleState {
  kind: "toggle";
  isOn: boolean;
  on: Rect;
  off: Rect;
  get: string;
  set: string;
}

export function createToggle(item: WidgetItem): ToggleState {
  item.w = 50;
  item.h = 15;
  return { kind: "toggle", isOn: true, on: rect(), off: rect(), get: str(item.params["Get Data Script"]), set: str(item.params["Set Data Script"]) };
}

/** FUN_0041e750: isOn = int(eval(Get Data)) != 0. */
export function loadToggle(item: WidgetItem, t: ToggleState, host: WidgetHost): void {
  if (t.get.trim()) t.isOn = host.evaluate(t.get, item, "int") !== 0;
}

/** FUN_0041e350 */
export function updateToggle(item: WidgetItem, t: ToggleState, host: WidgetHost): void {
  const half = item.w >> 1;
  Object.assign(t.on, { x: item.x, y: item.y, w: half, h: item.h });
  Object.assign(t.off, { x: item.x + half, y: item.y, w: item.w - half, h: item.h });
  host.hoverTest(t.on, t.on.x, t.on.y, t.on.w, t.on.h);
  host.hoverTest(t.off, t.off.x, t.off.y, t.off.w, t.off.h);
  if ((!t.on.clicked && item.command !== KEY.LEFT) || t.isOn) {
    if ((t.off.clicked || item.command === KEY.RIGHT) && t.isOn) {
      host.sound("menu_high");
      t.isOn = false;
    }
  } else {
    host.sound("menu_high");
    t.isOn = true;
  }
}

/** FUN_0041e460: "Yes" | "No" in font4, black; the chosen half filled (0,128,0) or (64,128,64) when highlighted. */
export function submitToggle(item: WidgetItem, t: ToggleState, fade: number, host: WidgetHost, p: Painter): void {
  const a = fadeAlpha(fade);
  const font = host.font("font4.fnt");
  if (font) {
    const yes = host.text("Yes");
    const no = host.text("No");
    const lh = font.lineHeight;
    const ty = Math.trunc((item.h - lh) / 2) + item.y;
    const black = tint128(0, 0, 0);
    p.text(font, yes, Math.trunc(item.w / 4) - Math.trunc(measureText(font, yes) / 2) + item.x, ty, "left", black, a);
    p.text(font, no, Math.trunc((item.w * 3) / 4) - Math.trunc(measureText(font, no) / 2) + item.x, ty, "left", black, a);
  }
  const half = item.w >> 1;
  const r = t.isOn ? { x: item.x, w: half } : { x: item.x + half, w: item.w - half };
  const c = item.highlighted ? 64 : 0;
  p.rect(r.x, item.y, r.x + r.w, item.y + item.h, colour128(c, 128, c, a));
  submitWidgetBox(item, 0.5, a, item.highlighted, p);
}

// ---------------------------------------------------------------------------
// ListBox
// ---------------------------------------------------------------------------

export interface ListState {
  kind: "list";
  sprite: string;
  font: string;
  /** +0xbec text width ("Width"). */
  width: number;
  entries: Array<{ id: number; text: string }>;
  index: number;
  activeId: number;
  b1: Rect;
  b2: Rect;
  collect: string;
  get: string;
  set: string;
  modify: string;
}

export function createList(item: WidgetItem, host: WidgetHost): ListState {
  const p = item.params;
  const l: ListState = {
    kind: "list",
    sprite: str(p["Sprite Resource"]).toLowerCase(),
    font: str(p["Font Resource"]).toLowerCase(),
    width: num(p.Width, 100),
    entries: [],
    index: 0,
    activeId: 0,
    b1: rect(),
    b2: rect(),
    collect: str(p["Collect Items Script"]),
    get: str(p["Get Data Script"]),
    set: str(p["Set Data Script"]),
    modify: str(p["Modify Data Script"]),
  };
  const b1 = host.spriteSize(`${l.sprite}_1.spr`) ?? { w: 0, h: 0 };
  const b2 = host.spriteSize(`${l.sprite}_2.spr`) ?? { w: 0, h: 0 };
  Object.assign(l.b1, { w: b1.w, h: b1.h });
  Object.assign(l.b2, { w: b2.w, h: b2.h });
  // FUN_00419360
  item.w = l.width + b2.w + 6 + b1.w;
  item.h = Math.max(b1.h, b2.h) + 4;
  return l;
}

/** FUN_00419920 */
export function loadList(item: WidgetItem, l: ListState, host: WidgetHost): void {
  l.entries = [];
  l.index = 0;
  host.collectInto(l);
  if (l.collect.trim()) host.evaluate(l.collect, item, "int");
  host.collectInto(null);
  if (l.get.trim()) {
    const id = x87Fistp(host.evaluate(l.get, item, "float"));
    const i = l.entries.findIndex((e) => e.id === id);
    if (i >= 0) {
      l.index = i;
      l.activeId = id;
    }
  }
  if (l.entries.length && !l.entries.some((e) => e.id === l.activeId)) l.activeId = l.entries[l.index]?.id ?? 0;
}

function placeListButtons(item: WidgetItem, l: ListState): void {
  l.b1.x = item.x + 2;
  l.b1.y = item.y + 2;
  l.b2.x = l.b1.w + l.b1.x + 2 + l.width;
  l.b2.y = item.y + 2;
}

/** FUN_00419560 */
export function updateList(item: WidgetItem, l: ListState, host: WidgetHost): void {
  placeListButtons(item, l);
  host.hoverTest(l.b1, l.b1.x, l.b1.y, l.b1.w, l.b1.h);
  host.hoverTest(l.b2, l.b2.x, l.b2.y, l.b2.w, l.b2.h);
  const before = l.activeId;
  const n = l.entries.length;
  if (n) {
    if (!l.b1.clicked && item.command !== KEY.LEFT) {
      if (l.b2.clicked || item.command === KEY.RIGHT) l.index = (l.index + 1) % n;
    } else {
      l.index--;
      if (l.index === -1) l.index = n - 1;
    }
    l.activeId = l.entries[l.index].id;
  }
  item.command = 0;
  if (before !== l.activeId) {
    host.sound("menu_high");
    if (l.modify.trim()) host.evaluate(l.modify, item, "int");
  }
}

/** FUN_00419660 */
export function submitList(item: WidgetItem, l: ListState, fade: number, host: WidgetHost, sprite: (name: string) => UiFrame | null, p: Painter): void {
  const a = fadeAlpha(fade);
  placeListButtons(item, l);
  const f1 = sprite(`${l.sprite}_1.spr`);
  const f2 = sprite(`${l.sprite}_2.spr`);
  if (f1) p.sprite(f1, l.b1.x, l.b1.y, NEUTRAL, a);
  if (f2) p.sprite(f2, l.b2.x, l.b2.y, NEUTRAL, a);
  const font = host.font(l.font);
  const entry = l.entries[l.index];
  if (font && entry) {
    let text = entry.text;
    if (l.width - 4 < penAdvance(font, text)) {
      while (text.length && l.width - 12 < penAdvance(font, text)) text = text.slice(0, -1);
      text += "...";
    }
    const tw = measureText(font, text);
    const x = Math.trunc((item.w - tw) / 2) + item.x;
    const y = Math.trunc((item.h - font.lineHeight) / 2) + item.y + 1;
    p.text(font, text, x, y, "left", tint128(0, 128, 0), a);
  }
  submitWidgetBox(item, 0.5, a, item.highlighted, p);
}

// ---------------------------------------------------------------------------
// InputBox
// ---------------------------------------------------------------------------

export interface InputState {
  kind: "input";
  text: string;
  maxLength: number;
  hide: boolean;
  editing: boolean;
  cursor: number;
  get: string;
  set: string;
  onModify: string;
  selectable: true;
}

export function createInput(item: WidgetItem): InputState {
  const p = item.params;
  item.w = num(p.Width, item.w || 0);
  item.h = 15;
  return {
    kind: "input",
    text: "",
    maxLength: num(p["String Length"], 20),
    hide: bool(p["Hide Input"], false),
    editing: false,
    cursor: 4,
    get: str(p["Get Data Script"]),
    set: str(p["Set Data Script"]),
    onModify: str(p["On Modify Script"]),
    selectable: true,
  };
}

export function loadInput(item: WidgetItem, s: InputState, host: WidgetHost): void {
  if (!s.get.trim()) return;
  const v = host.evaluateString(s.get, item);
  if (v !== null) s.text = v.slice(0, 39);
}

/** FUN_00418790 (state 3 while editing: the manager leaves the key queue to the box). */
export function updateInput(item: WidgetItem & HoverTarget, s: InputState, host: WidgetHost, locked: boolean): void {
  if (!s.editing && locked) {
    item.command = 0;
    return;
  }
  if (!s.editing) {
    host.hoverTest(item, item.x, item.y, item.w, item.h);
    if (item.clicked || item.command === KEY.RETURN) {
      host.lock();
      s.editing = true;
      s.cursor = s.text.length;
      host.sound("menu_k01");
    }
    return;
  }
  for (let k = host.nextKey(); k !== null; k = host.nextKey()) {
    const len = s.text.length;
    switch (k) {
      case KEY.END:
        s.cursor = len;
        break;
      case KEY.HOME:
        s.cursor = 0;
        break;
      case KEY.ESCAPE:
        host.unlock();
        s.editing = false;
        break;
      case KEY.RETURN:
        host.unlock();
        s.editing = false;
        if (s.onModify.trim()) host.evaluate(s.onModify, item, "int");
        break;
      case KEY.DELETE:
        if (s.cursor < len) {
          s.text = s.text.slice(0, s.cursor) + s.text.slice(s.cursor + 1);
          host.sound("menu_k01");
        }
        break;
      case KEY.BACKSPACE:
        if (s.cursor > 0) {
          s.text = s.text.slice(0, s.cursor - 1) + s.text.slice(s.cursor);
          s.cursor--;
          host.sound("menu_k01");
        }
        break;
      case KEY.UP:
      case KEY.DOWN:
        break;
      case KEY.RIGHT:
        s.cursor = Math.min(len, s.cursor + 1);
        break;
      case KEY.LEFT:
        s.cursor = Math.max(0, s.cursor - 1);
        break;
      default:
        if (k > 0 && len < s.maxLength - 1) {
          s.text = s.text.slice(0, s.cursor) + String.fromCharCode(k) + s.text.slice(s.cursor);
          s.cursor++;
          host.sound(`menu_k0${(Math.abs(k) % 7) + 1}`);
        }
        break;
    }
    if (!s.editing) break;
  }
}

/** FUN_00418a50 */
export function submitInput(item: WidgetItem, s: InputState, fade: number, host: WidgetHost, p: Painter): void {
  const a = fadeAlpha(fade);
  const font = host.font("font1.fnt");
  if (font) {
    const shown = s.hide ? "*".repeat(s.text.length) : s.text;
    if (s.editing && ((host.ticks() * 2) / Math.max(1, host.rate())) & 1) {
      const w = measureText(font, `${shown.slice(0, s.cursor)}a`);
      const x = item.x - 4 + w;
      p.strip([x, item.y + 12, x + 6, item.y + 12], [255, 255, 255, 255]);
    }
    p.text(font, shown, item.x + 2, item.y + 2, "left", NEUTRAL, a);
  }
  submitWidgetBox(item, 0.5, a, item.highlighted, p);
}

// ---------------------------------------------------------------------------
// ControlsMenu
// ---------------------------------------------------------------------------

export interface ControlsState {
  kind: "controls";
  /** CONTROL_KEYS index per CONTROL_ACTIONS row (+0x254). */
  rows: number[];
  /** +0x354 first visible row ("nOffset"), +0x35a "isReset", +0x359 waiting, +0x35c row. */
  offset: number;
  isReset: boolean;
  waiting: boolean;
  row: number;
}

/** The key-capture click generator DAT_0057f180: FUN_004aaa00's state, reset by every ControlsMenu ctor (0x4229b1). */
const controlsRng = new LevelRng(0);

export function createControls(item: WidgetItem): ControlsState {
  controlsRng.seed(0);
  item.x = 300;
  item.y = 230;
  item.w = 360;
  item.h = 200;
  return { kind: "controls", rows: CONTROL_ACTIONS.map((a) => CONTROL_KEYS.indexOf(DEFAULT_BINDINGS[a])), offset: 0, isReset: false, waiting: false, row: -1 };
}

export function loadControls(c: ControlsState, host: WidgetHost): void {
  c.rows = host.bindings().slice();
}

export function saveControls(c: ControlsState, host: WidgetHost): void {
  host.setBindings(c.rows.slice());
}

/** FUN_00422b50 */
export function updateControls(item: WidgetItem & HoverTarget, c: ControlsState, host: WidgetHost): void {
  if (c.isReset) {
    c.rows = CONTROL_ACTIONS.map((a) => CONTROL_KEYS.indexOf(DEFAULT_BINDINGS[a]));
    c.isReset = false;
  }
  if (!c.waiting) {
    host.hoverTest(item, item.x, item.y, item.w, item.h);
    if (item.clicked) {
      const pt = host.pointer();
      c.row = Math.trunc((pt.y - item.y) / 20) + c.offset;
      host.lock();
      c.waiting = true;
      host.sound("menu_sel2");
    }
    return;
  }
  if (!host.escapeDown()) {
    const key = host.rawPress();
    if (key === null) return;
    const k = CONTROL_KEYS.indexOf(key);
    if (k < 0) return;
    // 0x422c4d: menu_k0{|int32(FUN_004aaa20)| % 7 + 1}.
    host.sound(`menu_k0${(Math.abs(controlsRng.step() | 0) % 7) + 1}`);
    const old = c.rows[c.row];
    c.rows[c.row] = k;
    for (let i = 0; i < c.rows.length; i++) if (i !== c.row && c.rows[i] === k) c.rows[i] = old;
  } else {
    host.sound("menu_cancel");
  }
  host.flushKeys();
  host.unlock();
  c.waiting = false;
  c.row = -1;
}

/** FUN_00422f00: frame + divider (FUN_00422f80) and ten rows (FUN_00423110). */
export function submitControls(item: WidgetItem, c: ControlsState, fade: number, host: WidgetHost, p: Painter): void {
  const a = fadeAlpha(fade);
  const X = item.x;
  const Y = item.y;
  const line = vertexBytes(0, 1, 0, a);
  p.strip([X + 1, Y + 1, X + item.w, Y + 1, X + item.w, Y + item.h, X + 1, Y + item.h, X + 1, Y + 1], line);
  p.strip([X + 1 + 210, Y + 1, X + 1 + 210, Y + item.h], line);
  const font = host.font("font1.fnt");
  let rowY = Y;
  for (let r = c.offset; r < c.offset + 10; r++) {
    if (font && r < CONTROL_ACTIONS.length) {
      p.text(font, host.text(CONTROL_ACTIONS[r]), X + 4, rowY + 5, "left", tint128(0, 128, 0), a);
      const keyText = c.waiting && c.row === r ? "Select a key or button" : host.text(CONTROL_KEYS[c.rows[r]] ?? "");
      p.text(font, keyText, X + 214, rowY + 5, "left", tint128(128, 85, 0), a);
    }
    const even = (r & 1) === 0;
    p.rect(X, rowY, X + 210, rowY + 20, colour128(0, even ? 32 : 16, 0, a * 0.5));
    p.rect(X + 210, rowY, X + 210 + 150, rowY + 20, colour128(0, even ? 48 : 32, 0, a * 0.5));
    rowY += 20;
  }
}

// ---------------------------------------------------------------------------
// AsciiBox
// ---------------------------------------------------------------------------

export interface AsciiState {
  kind: "ascii";
  font: string;
  file: string;
  lines: string[];
  rowHeight: number;
  slider: SlideState;
  sliderItem: WidgetItem & HoverTarget;
}

/** FUN_0041d9c0: word wrap at spaces, tabs and newlines, measured with FUN_004ad200. */
export function wrapAscii(font: UiFont, text: string, width: number): string[] {
  const out: string[] = [];
  const t = text.replace(/\r/g, "");
  for (const para of t.split("\n")) {
    let line = "";
    let i = 0;
    while (i <= para.length) {
      let j = i;
      while (j < para.length && para[j] !== " " && para[j] !== "\t") j++;
      const candidate = line + para.slice(i, j);
      if (line && measureText(font, candidate) > width) {
        out.push(line.replace(/[ \t]$/, ""));
        line = para.slice(i, j);
      } else {
        line = candidate;
      }
      if (j < para.length) line += para[j];
      i = j + 1;
    }
    out.push(line);
  }
  return out;
}

export function createAscii(item: WidgetItem, host: WidgetHost): AsciiState {
  const p = item.params;
  item.w = num(p.Width, 100);
  item.h = num(p.Height, 100);
  const sliderItem: WidgetItem & HoverTarget = {
    x: 0, y: 0, w: 0, h: 0, command: 0, highlighted: false, params: {}, type: "SlideBar", id: -1,
    hoverPrev: false, hover: false, armed: false, clicked: false,
  };
  const slider = createSlide(sliderItem, host, { sprite: "slidevert", horizontal: false, track: 50, options: 3 });
  const font = str(p["Font Resource"]).toLowerCase();
  const f = host.font(font);
  return {
    kind: "ascii",
    font,
    file: str(p["Text File"]),
    lines: [],
    rowHeight: (f ? f.lineHeight : 0) + 2,
    slider,
    sliderItem,
  };
}

/** FUN_0041d850 + FUN_0041f8b0: load and wrap the file (width w - 28), size the bar to the box. */
export function loadAscii(item: WidgetItem, s: AsciiState, host: WidgetHost): void {
  const f = host.font(s.font);
  const text = host.textFile(s.file);
  s.lines = f && text !== null ? wrapAscii(f, text, item.w - 28) : [];
  const b1 = s.slider.b1.h;
  const b2 = s.slider.b2.h;
  Object.assign(s.sliderItem, { x: item.w - 19 + item.x, y: item.y, h: item.h });
  s.slider.track = item.h - b2 - b1 - 6;
  s.slider.options = s.lines.length;
  s.slider.value = 0;
}

export function updateAscii(item: WidgetItem, s: AsciiState, host: WidgetHost): void {
  Object.assign(s.sliderItem, { x: item.w - 19 + item.x, y: item.y, h: item.h });
  updateSlide(s.sliderItem, s.slider, host);
}

/** FUN_0041dc70 */
export function submitAscii(item: WidgetItem, s: AsciiState, fade: number, host: WidgetHost, sprite: (name: string) => UiFrame | null, p: Painter): void {
  const a = fadeAlpha(fade);
  Object.assign(s.sliderItem, { x: item.w - 19 + item.x, y: item.y, h: item.h });
  submitSlide(s.sliderItem, s.slider, fade, host, sprite, p);
  const f = host.font(s.font);
  if (f && s.rowHeight > 0) {
    const first = slideIndex(s.slider);
    const count = Math.min(Math.trunc((item.h - 4) / s.rowHeight), s.lines.length - first);
    let y = item.y + 4;
    for (let i = 0; i < count; i++) {
      p.text(f, s.lines[first + i], item.x + 4, y, "left", NEUTRAL, a);
      y += s.rowHeight;
    }
  }
  submitWidgetBox({ x: item.x, y: item.y, w: item.w - 20, h: item.h }, 0.5, a, false, p);
}

// ---------------------------------------------------------------------------
// TypeWriterBox
// ---------------------------------------------------------------------------

/** One line of the credits script (0x537cd8, 36 bytes each). */
export interface TypewriterEntry {
  /** 0 = centred, < 0 = right-aligned (x - 8 from the right edge), > 0 = x + 8 from the left. */
  x: number;
  /** Line y in the box; -1 = a page break (not drawn). */
  y: number;
  colour: number;
  font: number;
  /** Ticks to wait after the line; -1 = end of a page (253 ticks, fade out). */
  pause: number;
  /** First line of a page. */
  pageStart: boolean;
  /** Text is a menu text key (resolved through the language file). */
  localised: boolean;
  text: string;
}

export interface TypeState {
  kind: "type";
  script: TypewriterEntry[];
  /** +0x60 current line, +0x64 first line of the page, +0x68 typed characters, +0x6c wait, +0x70 frame, +0x74 fading. */
  line: number;
  page: number;
  typed: number;
  wait: number;
  frame: number;
  fading: boolean;
}

export function createType(item: WidgetItem, host: WidgetHost): TypeState {
  item.w = num(item.params.Width, 100);
  item.h = num(item.params.Height, 100);
  return { kind: "type", script: host.typewriterScript() ?? [], line: 0, page: 0, typed: 0, wait: 0, frame: 0, fading: false };
}

const typeText = (e: TypewriterEntry, host: WidgetHost) => (e.localised ? host.text(e.text) : e.text);

/** FUN_0041d0b0 */
export function updateType(t: TypeState, host: WidgetHost): void {
  const n = t.script.length;
  if (n) {
    if (t.wait === 0) {
      const len = typeText(t.script[t.line], host).length;
      t.fading = false;
      t.wait = 3;
      if (len === t.typed) {
        let next = t.line + 1;
        if (next === n) next = 0;
        const pause = t.script[next].pause;
        if (pause === -1) {
          t.wait = 0xfd;
          t.fading = true;
        } else {
          t.wait = pause + 3;
        }
        t.line = next;
        t.typed = 0;
        if (t.script[next].pageStart) t.page = next;
      } else {
        t.typed++;
      }
    } else {
      t.wait--;
    }
  }
  t.frame++;
  host.modified();
}

/** FUN_0041d160 */
export function submitType(item: WidgetItem, t: TypeState, fade: number, host: WidgetHost, palette: ReadonlyArray<readonly [number, number, number]>, p: Painter): void {
  const a = fadeAlpha(fade);
  const n = t.script.length;
  const fonts = ["font1.fnt", "font2.fnt", "font3.fnt", "font4.fnt"];
  if (n) {
    let i = t.page;
    let guard = 0;
    for (let k = i - 1; ((k % n) + n) % n !== t.line && guard < n; k++, i++, guard++) {
      const e = t.script[i % n];
      const font = host.font(fonts[e.font] ?? "");
      if (!font || e.y === -1) continue;
      const col = palette[e.colour] ?? palette[1];
      let alpha = a;
      let c = [col[0], col[1], col[2]];
      if (t.fading) {
        if (t.wait < 16) alpha = t.wait * a * 0.0625;
        if (t.wait < 32) {
          const f = Math.max(t.wait - 16, 0) * 0.0625;
          c = c.map((v) => (v - 128) * f + 128);
        }
      }
      const full = typeText(e, host);
      const text = i % n === t.line ? full.slice(0, t.typed) : full;
      const width = measureText(font, full);
      let x = e.x;
      if (x === 0) x = (item.w - measureText(font, text === full ? full : full)) >> 1;
      else if (x < 0) x = x - 8 + (item.w - width);
      else x += 8;
      void width;
      const tx = item.x + x;
      const ty = item.y + e.y;
      const tint = tint128(c[0], c[1], c[2]);
      p.text(font, text, tx, ty, "left", tint, alpha);
      if (i % n === t.line && (t.frame & 8) !== 0) {
        const cw = measureText(font, text);
        const h = font.lineHeight;
        p.rect(tx + cw, ty, tx + cw + ((h * 3) >> 2), ty + h, colour128(c[0], c[1], c[2], alpha));
      }
    }
  }
  submitWidgetBox(item, 0.5, a, false, p);
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export type WidgetState = SlideState | ToggleState | ListState | InputState | ControlsState | AsciiState | TypeState;

/** Widgets the manager builds for these task types. */
export function isWidgetType(type: string): boolean {
  return type === "SlideBar" || type === "ToggleBox" || type === "ListBox" || type === "InputBox" ||
    type === "ControlsMenu" || type === "AsciiBox" || type === "TypeWriterBox";
}

export function createWidget(task: IgiTask, item: WidgetItem, host: WidgetHost): WidgetState | null {
  switch (task.type) {
    case "SlideBar":
      return createSlide(item, host);
    case "ToggleBox":
      return createToggle(item);
    case "ListBox":
      return createList(item, host);
    case "InputBox":
      return createInput(item);
    case "ControlsMenu":
      return createControls(item);
    case "AsciiBox":
      return createAscii(item, host);
    case "TypeWriterBox":
      return createType(item, host);
    default:
      return null;
  }
}
