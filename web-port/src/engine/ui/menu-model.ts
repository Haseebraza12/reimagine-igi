/**
 * Data-driven menus of igi.exe (pure model; no DOM): the MenuManager state
 * machine, the window tree built from mainmenu.qvm / ingamemenu.qvm task
 * trees, the recovered LineUpMode layout, selection, mouse/keyboard input and
 * the menu scripts. Drawing is in menu-draw.ts.
 *
 * Recovered (igi.exe, image base 0x400000):
 *   MenuManager   class FUN_00415fa0: ctor 416160, update 416f70, draw 4177e0,
 *                 keys 4173f0, select 417550/417df0, collect items 417660/4176b0,
 *                 script functions 4163a0 (RequestScreen), 416590 (PushScreen),
 *                 416610 (PopScreen), 416690 (LeaveMenus), 416800/416860 (popup).
 *   MenuWindow    base class FUN_00423610: fields +0x20 x, +0x24 y, +0x28 w,
 *                 +0x2c h, +0x30/+0x34 x/y spacing (default 4), +0x38 LineUpMode,
 *                 +0x3c/+0x40 centre-in-parent flags, +0x48..+0x4b mouse state,
 *                 +0x4c selectable, +0x4d highlighted, +0x50 key command.
 *                 Layout FUN_00423a80 (+ place 4239f0, measure 4239d0),
 *                 hover/click test FUN_00423e70.
 *   MenuFrame     FUN_00421a40 (update 4220c0, draw 421d40 + frame sprites).
 *   MenuText      FUN_00420330 (update 4206e0, draw 4207a0, init 4205b0).
 *   MenuTextConditional FUN_0041f970 (update 41fe50, draw 41ff60).
 *   MenuScreen    FUN_00420dc0 (update 421780, draw 421290, window 421340, init 4210e0).
 *   DialogWindow  FUN_0041c520 (draw 41c7e0 -> 41c860).
 *   ScrollListBox FUN_00419c30 (update 41a120, draw 41a3d0, init 419ff0).
 *   PictureBox    FUN_0041ada0 (draw 41b080).   TextBox FUN_0041b3f0 (draw 41b7a0).
 */
import {
  evaluateQvmExpression,
  parseQvmExpression,
  x87Fistp,
  type IgiTask,
  type QvmExpressionArg,
  type TaskParam,
  type UiFont,
} from "../../loaders";
import type { MenuConfig } from "./menu-config";
import { CONTROL_ACTIONS, CONTROL_KEYS } from "./menu-config";
import {
  createWidget,
  isWidgetType,
  loadAscii,
  loadControls,
  loadInput,
  loadList,
  loadSlide,
  loadToggle,
  saveControls,
  updateAscii,
  updateControls,
  updateInput,
  updateList,
  updateSlide,
  updateToggle,
  updateType,
  type ListState,
  type TypewriterEntry,
  type WidgetHost,
  type WidgetItem,
  type WidgetState,
} from "./menu-widgets";

export const LINEUP = {
  NONE: 0,
  VERT_TOP: 1,
  VERT_CENTRE: 2,
  VERT_BOTTOM: 3,
  HOR_LEFT: 4,
  HOR_CENTRE: 5,
  HOR_RIGHT: 6,
  VERT_FILLOUT: 7,
  HOR_FILLOUT: 8,
} as const;

/** LeaveMenus modes (FUN_00416160 registrations) = manager states. */
export const MENU_MODE = { QUIT: 10, QUITTOMAINMENU: 11, STARTGAME: 13, IDLE: 9, RESTARTLEVEL: 12 } as const;

/** Menu key codes pushed by the window procedure (VK -> code table at 0x488c64). */
export const MENU_KEY = {
  LEFT: -1,
  RIGHT: -2,
  UP: -3,
  DOWN: -4,
  BACKSPACE: -5,
  DELETE: -6,
  RETURN: -7,
  ESCAPE: -8,
  HOME: -9,
  END: -10,
  TAB: -11,
} as const;

/** Browser KeyboardEvent.code -> menu key code. */
export const MENU_KEY_BY_CODE: Readonly<Record<string, number>> = {
  ArrowLeft: MENU_KEY.LEFT,
  ArrowRight: MENU_KEY.RIGHT,
  ArrowUp: MENU_KEY.UP,
  ArrowDown: MENU_KEY.DOWN,
  Backspace: MENU_KEY.BACKSPACE,
  Delete: MENU_KEY.DELETE,
  Enter: MENU_KEY.RETURN,
  NumpadEnter: MENU_KEY.RETURN,
  Escape: MENU_KEY.ESCAPE,
  Home: MENU_KEY.HOME,
  End: MENU_KEY.END,
  Tab: MENU_KEY.TAB,
};

export type MenuKind = "screen" | "frame" | "text" | "dialog" | "picture" | "textbox" | "scrolllist" | "widget" | "other";

export interface ListEntry {
  id: number;
  text: string;
}

export interface MenuItem {
  kind: MenuKind;
  type: string;
  id: number;
  name: string;
  params: Record<string, TaskParam>;
  parent: MenuItem | null;
  children: MenuItem[];
  x: number;
  y: number;
  w: number;
  h: number;
  xSpacing: number;
  ySpacing: number;
  lineUp: number;
  centreX: boolean;
  centreY: boolean;
  /** +0x4c */
  selectable: boolean;
  /** +0x48 previous hover (or init suppression), +0x49 hover, +0x4a armed, +0x4b clicked */
  hoverPrev: boolean;
  hover: boolean;
  armed: boolean;
  clicked: boolean;
  /** +0x4d */
  highlighted: boolean;
  /** +0x50 key command (RETURN = click). */
  command: number;
  // MenuText / MenuTextConditional
  textKey: string;
  text: string;
  font: string;
  colour: number;
  enabled: boolean;
  visible: boolean;
  clickScript: string;
  clickSound: string;
  enabledExpr: string;
  visibleExpr: string;
  // MenuScreen / MenuFrame
  background: string;
  frame: [number, number, number, number];
  escapeScript: string;
  sprite: string;
  // DialogWindow
  swapKeys: boolean;
  // ScrollListBox / PictureBox / TextBox
  entries: ListEntry[];
  activeIndex: number;
  scroll: number;
  lastClickTick: number;
  focused: boolean;
  selectScript: string;
  activeExpr: string;
  /** Row height of a ScrollListBox (font line height + 1). */
  rowHeight: number;
  /** SlideBar / ToggleBox / ListBox / InputBox / ControlsMenu / AsciiBox / TypeWriterBox state. */
  widget: WidgetState | null;
  /** MenuScreen "On Init Data" / "On Change Data" (+0xfc / +0x14c) and its nUserData member (+0x19c). */
  onInit: string;
  onChange: string;
  userData: number;
}

export interface MenuEnvironment {
  /** Text Resource key -> string (language/english/menusystem.res, "RM: key" when missing). */
  text(key: string): string;
  /** Text size of `text` in font `font` (FUN_004ad200 width, line height): null when the font is missing. */
  measure(font: string, text: string): { w: number; h: number } | null;
  /** Size of a background picture known to this manager's resources, or null (no background). */
  picture(name: string): { w: number; h: number } | null;
  /** Mission list for Config_FillMission* (missions up to the player's progress). */
  missions(): ReadonlyArray<{ id: number; name: string; description: string; sprite: string }>;
  /** Config_PlayerGetActiveMission(): mission id selected for the profile. */
  activeMission(): number;
  levelFailed(): boolean;
  playerDead(): boolean;
  sound(name: string): void;
  setMission(id: number): void;
  /** A LeaveMenus mode was reached after the fade-out (STARTGAME, QUIT, ...). */
  leave(mode: number): void;
  /** In-game: pause (menu opened from idle) / unpause (back in idle). */
  setPaused(paused: boolean): void;
  /** Called when a screen opens (the menu needs the mouse: release pointer lock). */
  opened(): void;
  /** The profile configuration behind Config_* (menu-config.ts); without it those calls return 0. */
  config?: MenuConfig;
  /** Size of a sprite of the manager's resource archive ("slide_1.spr"). */
  spriteSize?(name: string): { w: number; h: number } | null;
  /** A font of the manager's resource archive ("font1.fnt"). */
  font?(name: string): UiFont | null;
  /** AsciiBox "Text File" ("LANGUAGE:readme.txt") contents, or null. */
  textFile?(name: string): string | null;
  /** TypeWriterBox script (the credits table of igi.exe), or null. */
  typewriterScript?(): TypewriterEntry[] | null;
  /** Key / button names (CONTROL_KEYS) held right now (ControlsMenu key capture). */
  heldKeys?(): ReadonlySet<string>;
  /** Main menu idle for more than 3600 logic ticks (FUN_00416f70 at 0x416ffe): Flow 8, the looping intro. */
  attract?(): void;
  /** Port: Game_SetPlayMode(0 story / 1 free) from the mode dialog (ui/mode-menu.ts). */
  setPlayMode?(mode: number): void;
}

export interface MenuInputState {
  /** Pointer in the 640x480 layout (already offset as in FUN_00416f70). */
  x: number;
  y: number;
}

const num = (v: TaskParam | undefined, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const str = (v: TaskParam | undefined): string => (typeof v === "string" ? v : "");

function kindOf(type: string): MenuKind {
  switch (type) {
    case "MenuScreen":
      return "screen";
    case "MenuFrame":
      return "frame";
    case "MenuText":
    case "MenuTextConditional":
      return "text";
    case "DialogWindow":
      return "dialog";
    case "PictureBox":
      return "picture";
    case "TextBox":
      return "textbox";
    case "ScrollListBox":
      return "scrolllist";
    default:
      return "other";
  }
}

/** Build the window tree of one MenuScreen / DialogWindow task (ctor + init defaults). */
export function buildMenuItem(task: IgiTask, env: MenuEnvironment, parent: MenuItem | null = null, host: WidgetHost | null = null): MenuItem {
  const p = task.params;
  const kind = host && isWidgetType(task.type) ? "widget" : kindOf(task.type);
  const item: MenuItem = {
    kind,
    type: task.type,
    id: task.id,
    name: task.name,
    params: p,
    parent,
    children: [],
    // MenuWindow ctor FUN_00423810: everything 0, spacing 4.
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    xSpacing: 4,
    ySpacing: 4,
    lineUp: 0,
    centreX: false,
    centreY: false,
    selectable: false,
    hoverPrev: false,
    hover: false,
    armed: false,
    clicked: false,
    highlighted: false,
    command: 0,
    textKey: "",
    text: "",
    font: "",
    colour: 0,
    enabled: true,
    visible: true,
    clickScript: "",
    clickSound: "",
    enabledExpr: "",
    visibleExpr: "",
    background: "",
    frame: [0, 0, 0, 0],
    escapeScript: "",
    sprite: "",
    swapKeys: false,
    entries: [],
    activeIndex: 0,
    scroll: 0,
    lastClickTick: -1,
    focused: false,
    selectScript: "",
    activeExpr: "",
    rowHeight: 1,
    widget: null,
    onInit: "",
    onChange: "",
    userData: 0,
  };
  switch (kind) {
    case "screen": {
      item.background = str(p.Background).toLowerCase();
      item.frame = [num(p["Frame x0"], 0), num(p["Frame y0"], 0), num(p["Frame x1"], 0), num(p["Frame y1"], 0)];
      item.escapeScript = str(p["On Press Escape"]);
      item.onInit = str(p["On Init Data"]);
      item.onChange = str(p["On Change Data"]);
      const bg = item.background ? env.picture(item.background) : null;
      if (bg) {
        // FUN_004210e0: the screen takes the background picture's size.
        item.w = bg.w;
        item.h = bg.h;
      }
      break;
    }
    case "frame":
      // FUN_00421c60 defaults 220,220 200x40; params override.
      item.x = num(p["X-Pos"], 220);
      item.y = num(p["Y-Pos"], 220);
      item.w = num(p.Width, 200);
      item.h = num(p.Height, 40);
      item.lineUp = num(p.LineUpMode, 0);
      item.xSpacing = num(p["X-Spacing"], 4);
      item.ySpacing = num(p["Y-Spacing"], 4);
      item.selectable = p["Is Selectable"] === true || p["Is Selectable"] === 1;
      item.sprite = str(p["Sprite Resource"]).toLowerCase();
      break;
    case "text": {
      // FUN_00420500 / FUN_0041fbc0: x 300, y 230, centred in the parent.
      item.x = 300;
      item.y = 230;
      item.centreX = item.centreY = true;
      item.textKey = str(p["Text Resource"]);
      item.text = env.text(item.textKey);
      item.font = str(p["Font Resource"]).toLowerCase();
      item.colour = num(p.ColourIndex, 0) & 0xf;
      item.clickScript = str(p["On Click Script"]).trim();
      item.clickSound = str(p["Click Sound Resource"]);
      item.enabledExpr = str(p["isEnabled Expression"]);
      item.visibleExpr = str(p["isVisible Expression"]);
      const size = env.measure(item.font, item.text);
      if (size) {
        item.w = size.w;
        item.h = size.h;
      }
      // FUN_004205b0: selectable when it has a click script.
      item.selectable = item.clickScript.length > 0;
      break;
    }
    case "dialog":
      item.x = num(p["X-Pos"], 0);
      item.y = num(p["Y-Pos"], 0);
      item.w = num(p.Width, 0);
      item.h = num(p.Height, 0);
      item.centreX = item.centreY = true;
      item.swapKeys = p.SwapKeys === true || p.SwapKeys === 1;
      break;
    case "picture":
      // FUN_0041af20: 320,240 256x192.
      item.x = 320;
      item.y = 240;
      item.w = num(p.Width, 256);
      item.h = num(p.Height, 192);
      item.centreX = item.centreY = true;
      item.activeExpr = str(p["Get Active Picture"]);
      break;
    case "textbox":
      // FUN_0041b5a0: 300,230 128x128.
      item.x = 300;
      item.y = 230;
      item.w = num(p.Width, 128);
      item.h = num(p.Height, 128);
      item.font = str(p["Font Resource"]).toLowerCase();
      item.centreX = item.centreY = true;
      item.activeExpr = str(p["Get Active Picture"]);
      break;
    case "scrolllist": {
      // FUN_00419e60: 100x100, centred; FUN_00419ff0: row height = font height + 1.
      item.w = num(p.Width, 100);
      item.h = num(p.Height, 100);
      item.font = str(p["Font Resource"]).toLowerCase();
      item.centreX = item.centreY = true;
      item.selectScript = str(p["On Select Item"]);
      const size = env.measure(item.font, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
      item.rowHeight = (size?.h ?? 0) + 1;
      break;
    }
    case "widget":
      // Every widget ctor: 300,230 and centred in the parent (+0x3c / +0x40 = 1).
      item.x = 300;
      item.y = 230;
      item.centreX = item.centreY = true;
      item.widget = createWidget(task, item as WidgetItem, host!);
      item.selectable = item.widget?.kind === "input";
      break;
    default:
      item.w = num(p.Width, num(p.Size, 0));
      item.h = num(p.Height, 0);
      item.centreX = item.centreY = true;
      break;
  }
  item.children = task.children.map((c) => buildMenuItem(c, env, item, host));
  return item;
}

/**
 * FUN_00423a80: arrange the children of `win` per its LineUpMode, then lay
 * out every child recursively. C integer division truncates toward zero; the
 * centring shift (>> 1) floors.
 */
export function layoutMenu(win: MenuItem): void {
  const kids = win.children;
  let sumW = 0;
  let sumH = 0;
  const count = kids.length;
  for (const k of kids) {
    sumW += k.w;
    sumH += k.h;
  }
  let horiz = false;
  let vert = false;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const div = (a: number, b: number) => Math.trunc(a / b);
  switch (win.lineUp) {
    case LINEUP.VERT_TOP:
      sy = win.ySpacing;
      cy = win.y + sy;
      vert = true;
      break;
    case LINEUP.VERT_CENTRE:
      vert = true;
      sy = div(win.h - sumH, count + 1);
      cy = win.y + sy;
      break;
    case LINEUP.VERT_BOTTOM:
      sy = win.ySpacing;
      vert = true;
      cy = win.h - sy * count + win.y - sumH;
      break;
    case LINEUP.HOR_LEFT:
      sx = win.xSpacing;
      cx = win.x + sx;
      horiz = true;
      break;
    case LINEUP.HOR_CENTRE:
      sx = div(win.w - sumW, count + 1);
      cx = win.x + sx;
      horiz = true;
      break;
    case LINEUP.HOR_RIGHT:
      sx = win.xSpacing;
      cx = win.w - sx * count + win.x - sumW;
      horiz = true;
      break;
    case LINEUP.VERT_FILLOUT: {
      cy = win.y + win.ySpacing;
      const n = Math.max(1, count - 1);
      vert = true;
      sy = div(win.h - win.ySpacing * 2 - sumH, n);
      break;
    }
    case LINEUP.HOR_FILLOUT: {
      const n = Math.max(1, count - 1);
      cx = win.x + win.xSpacing;
      sx = div(win.w - win.xSpacing * 2 - sumW, n);
      horiz = true;
      break;
    }
    default:
      break;
  }
  // FUN_004239f0 for every child.
  for (const k of kids) {
    if (!horiz) {
      if (k.centreX) k.x = ((win.w - k.w) >> 1) + win.x;
    } else {
      k.x = cx;
      cx += k.w + sx;
    }
    if (vert) {
      k.y = cy;
      cy += k.h + sy;
    } else if (k.centreY) {
      k.y = ((win.h - k.h) >> 1) + win.y;
    }
  }
  for (const k of kids) layoutMenu(k);
}

function walk(item: MenuItem, fn: (i: MenuItem) => void): void {
  fn(item);
  for (const c of item.children) walk(c, fn);
}

/** FUN_004176b0: selectable windows, depth first; a selectable window's children are not visited. */
export function collectSelectable(item: MenuItem, out: MenuItem[] = []): MenuItem[] {
  if (item.selectable) {
    out.push(item);
    return out;
  }
  for (const c of item.children) collectSelectable(c, out);
  return out;
}

/** True when a click script leaves the menus into play (used to request pointer lock inside the user gesture). */
export function scriptStartsPlay(script: string): boolean {
  return /MENUMANAGER_(STARTGAME|IDLE|RESTARTLEVEL)/.test(script);
}

interface PointerButtons {
  down: boolean;
  pressed: boolean;
  released: boolean;
  /** +0x254f: set while a screen's first update runs (no hover sound). */
  suppress: boolean;
}

export interface MenuManagerOptions {
  /** isOwnDisplay (main menu: TRUE; in-game: FALSE). */
  ownDisplay: boolean;
  /** Logic rate: 60 for the own-display main menu (FUN_004029a0(0x3c)), else 30. */
  ticksPerSecond: number;
  /** Start state: 0 = open "Current menuscreen" (main menu), 9 = idle (in-game). */
  startOpen: boolean;
}

export class MenuManager {
  /** +0x28 state, +0x2c next state */
  state: number;
  next = 0;
  /** +0x20 requested screen id, +0x24 popup id */
  screenId: number;
  popupId = -1;
  screen: MenuItem | null = null;
  popup: MenuItem | null = null;
  /** +0xcc fade 0..16, +0xc4 / +0xc8 its values one and two frames ago */
  fade = 0;
  fadePrev1 = 0;
  fadePrev2 = 0;
  private readonly stack: number[] = [];
  /** +0x3c.. selectable list, +0xc0 index, +0x38 selected */
  items: MenuItem[] = [];
  selection = 0;
  selected: MenuItem | null = null;
  readonly pointer: MenuInputState = { x: 320, y: 240 };
  private readonly buttons: PointerButtons = { down: false, pressed: false, released: false, suppress: false };
  private buttonQueue: boolean[] = [];
  /** Where the last button press happened (for releaseStartsPlay before a tick saw the press). */
  private pressAt: { x: number; y: number } | null = null;
  private buttonState = false;
  private keyQueue: number[] = [];
  private escapeFlag = false;
  private tabFlag = false;
  /** In-game failure timer DAT_00577b80 (opens the menu after 151 ticks). */
  failTimer = 0;
  private paused = false;
  /** Logic ticks run (FUN_00402a30), for double clicks. */
  ticks = 0;
  /** Raw key edges seen in idle state: Escape / Space / Return. */
  private idleKeys = { escape: false, space: false, enter: false };
  /** Screen / dialog objects persist like the exe's tasks (PopScreen returns to the same state). */
  private readonly built = new Map<number, MenuItem>();
  /** ListBox being filled by a Config_Fill* call (DAT_00577bc4). */
  private collecting: ListState | null = null;
  /** +0x2444 "modified" (FUN_00417ee0), cleared at the end of every update. */
  private modifiedFlag = false;
  /** Idle attract counter DAT_00577b84 and the snapshot it compares against. */
  idleTicks = 0;
  private idleSnapshot = "";
  /** The widget host (FUN_0041xxxx helpers reach the manager through it). */
  readonly host: WidgetHost;

  constructor(
    private readonly tree: IgiTask[],
    private readonly env: MenuEnvironment,
    readonly options: MenuManagerOptions,
  ) {
    const manager = tree.find((t) => t.type === "MenuManager");
    const first = manager ? num(manager.params["Current menuscreen"], 900) : 900;
    this.screenId = first;
    this.state = options.startOpen ? 0 : MENU_MODE.IDLE;
    this.host = this.createHost();
  }

  private createHost(): WidgetHost {
    const env = this.env;
    return {
      evaluate: (script, self, mode) => this.evaluate(script, self as MenuItem, mode),
      evaluateString: (script, self) => this.evaluateString(script, self as MenuItem),
      collectInto: (list) => {
        this.collecting = list;
      },
      sound: (name) => env.sound(name),
      spriteSize: (name) => env.spriteSize?.(name) ?? null,
      text: (key) => env.text(key),
      font: (name) => env.font?.(name) ?? null,
      hoverTest: (target, x, y, w, h) => this.hoverTest(target as MenuItem, x, y, w, h),
      pointer: () => this.pointer,
      lock: () => {
        this.state = 3;
      },
      unlock: () => {
        this.state = 2;
      },
      nextKey: () => (this.keyQueue.length ? this.keyQueue.shift()! : null),
      flushKeys: () => {
        this.keyQueue = [];
      },
      rawPress: () => {
        const held = env.heldKeys?.();
        if (!held) return null;
        for (const k of CONTROL_KEYS) if (held.has(k)) return k;
        return null;
      },
      escapeDown: () => env.heldKeys?.().has("KEY_ESC") ?? false,
      modified: () => {
        this.modifiedFlag = true;
      },
      ticks: () => this.ticks,
      rate: () => this.options.ticksPerSecond,
      bindings: () => CONTROL_ACTIONS.map((a) => env.config?.bindingIndex(a) ?? -1),
      setBindings: (rows) => {
        const cfg = env.config;
        if (!cfg) return;
        rows.forEach((k, i) => cfg.setBinding(CONTROL_ACTIONS[i], k));
        cfg.onChange?.("controls", cfg);
      },
      textFile: (name) => env.textFile?.(name) ?? null,
      typewriterScript: () => env.typewriterScript?.() ?? null,
    };
  }

  /** Load (FUN_00417600 / popup FUN_00417720): MenuScreen "On Init Data", then every widget's Get Data. */
  private loadData(root: MenuItem): void {
    walk(root, (i) => {
      if (i.kind === "screen" && i.onInit.trim()) this.evaluate(i.onInit, i, "float");
      this.loadWidget(i);
    });
    this.initData(root);
  }

  private loadWidget(i: MenuItem): void {
    const w = i.widget;
    if (!w) return;
    const host = this.host;
    switch (w.kind) {
      case "slide":
        loadSlide(i as WidgetItem, w, host);
        break;
      case "toggle":
        loadToggle(i as WidgetItem, w, host);
        break;
      case "list":
        loadList(i as WidgetItem, w, host);
        break;
      case "input":
        loadInput(i as WidgetItem, w, host);
        break;
      case "controls":
        loadControls(w, host);
        break;
      case "ascii":
        loadAscii(i as WidgetItem, w, host);
        break;
      default:
        break;
    }
  }

  /** Commit (FUN_00416420): MenuScreen "On Change Data", then every widget's Set Data. */
  private saveData(root: MenuItem): void {
    walk(root, (i) => {
      if (i.kind === "screen" && i.onChange.trim()) this.evaluate(i.onChange, i, "int");
      const w = i.widget;
      if (!w) return;
      if (w.kind === "controls") saveControls(w, this.host);
      else if ("set" in w && w.set.trim()) this.evaluate(w.set, i, "int");
    });
  }

  /** The screen/dialog task with this id. */
  private findTask(id: number): IgiTask | null {
    const manager = this.tree.find((t) => t.type === "MenuManager");
    const pool = manager ? manager.children : this.tree;
    return pool.find((t) => t.id === id && (t.type === "MenuScreen" || t.type === "DialogWindow")) ?? null;
  }

  get isOpen(): boolean {
    return this.state !== MENU_MODE.IDLE && this.screen !== null;
  }

  get isIdle(): boolean {
    return this.state === MENU_MODE.IDLE;
  }

  /** FUN_00417e60: open the in-game menu (screen 900) from idle. */
  openScreen(id = 900): void {
    this.screen = null;
    this.screenId = id;
    this.state = 0;
  }

  /** Reset to idle (in-game manager after a mission (re)start). */
  goIdle(): void {
    this.state = MENU_MODE.IDLE;
    this.screen = null;
    this.popup = null;
    this.failTimer = 0;
    this.paused = false;
    this.keyQueue = [];
    this.buttonQueue = [];
  }

  // ---------------------------------------------------------------- input ---

  pointerMove(x: number, y: number): void {
    this.pointer.x = Math.max(0, Math.min(639, Math.floor(x)));
    this.pointer.y = Math.max(0, Math.min(479, Math.floor(y)));
  }

  /** Mouse button transition (queued so a click shorter than a tick is not lost). */
  pointerButton(down: boolean): void {
    if (down) this.pressAt = { x: this.pointer.x, y: this.pointer.y };
    this.buttonQueue.push(down);
  }

  /** A menu key (MENU_KEY) from the window procedure queue (32 entries). */
  key(code: number): void {
    if (this.keyQueue.length < 31) this.keyQueue.push(code);
  }

  /** Idle-state raw keys (DirectInput state edges in the original). */
  idleKey(code: "Escape" | "Space" | "Enter"): void {
    if (code === "Escape") this.idleKeys.escape = true;
    else if (code === "Space") this.idleKeys.space = true;
    else this.idleKeys.enter = true;
  }

  /**
   * Would releasing the button now click an item whose script leaves into play?
   * (Lets the host request pointer lock inside the user's mouseup.)
   */
  releaseStartsPlay(): boolean {
    if (this.state !== 2) return false;
    const root = this.popup ?? this.screen;
    if (!root) return false;
    let hit = false;
    walk(root, (i) => {
      if (hit) return;
      const inside = this.inside(i.x, i.y, i.w, i.h);
      const p = this.pressAt;
      const pressedInside = !!p && i.x < p.x && i.y < p.y && p.x < i.x + i.w && p.y < i.y + i.h;
      const armed = i.armed || pressedInside;
      if (i.kind === "text" && i.selectable && i.enabled && armed && inside && scriptStartsPlay(i.clickScript)) hit = true;
      if (i.kind === "scrolllist" && inside && scriptStartsPlay(i.selectScript)) {
        const row = Math.trunc((this.pointer.y - i.y) / i.rowHeight) + i.scroll;
        if ((row === i.activeIndex || row >= i.entries.length) && i.lastClickTick !== -1 &&
          this.ticks - i.lastClickTick < Math.round(this.options.ticksPerSecond * 0.5)) hit = true;
      }
    });
    return hit;
  }

  /** Would this key (pressed now) leave into play? */
  keyStartsPlay(code: number): boolean {
    if (this.state !== 2) return false;
    if (code === MENU_KEY.RETURN && this.selected?.kind === "text") return scriptStartsPlay(this.selected.clickScript);
    if (code === MENU_KEY.ESCAPE && !this.popup && this.screen) return scriptStartsPlay(this.screen.escapeScript);
    return false;
  }

  private inside(x: number, y: number, w: number, h: number): boolean {
    const mx = this.pointer.x;
    const my = this.pointer.y;
    return x < mx && y < my && mx < x + w && my < y + h;
  }

  /** FUN_00423e70 */
  private hoverTest(item: MenuItem, x = item.x, y = item.y, w = item.w, h = item.h): void {
    const b = this.buttons;
    const inside = this.inside(x, y, w, h);
    const armed = (b.down && item.armed) || (b.pressed && inside);
    const clicked = item.armed && b.released && inside;
    const hover = (!b.down || armed) && inside;
    item.armed = armed;
    item.hoverPrev = item.hover || b.suppress;
    item.hover = hover;
    item.clicked = clicked;
  }

  // ---------------------------------------------------------------- selection

  /** FUN_00417550 */
  private select(index: number): void {
    if (this.selected) this.selected.highlighted = false;
    this.selection = index;
    this.selected = this.items[index] ?? null;
    if (this.selected) this.selected.highlighted = true;
  }

  /** FUN_00417df0: hover selects the item (and plays menu_high) when it changes. */
  private hoverSelect(item: MenuItem): void {
    const i = this.items.indexOf(item);
    if (i < 0) return;
    if (this.selection !== i) {
      this.select(i);
      this.env.sound("menu_high");
    }
  }

  /** FUN_00417660 */
  private collect(root: MenuItem): void {
    this.items = this.screen ? collectSelectable(root) : [];
    this.select(0);
  }

  // ---------------------------------------------------------------- scripts --

  private evaluate(script: string, self: MenuItem | null, mode: "int" | "float" = "int"): number {
    if (!script.trim()) return 0;
    let expr;
    try {
      expr = parseQvmExpression(this.inlineStrings(script, self));
    } catch {
      return 0; // the exe's parser rejects malformed scripts too (e.g. screen 912 "Delete Player")
    }
    return evaluateQvmExpression(expr, {
      value: (name, args) => this.scriptValue(name, args, self),
      assign: (name, value) => this.assignMember(name, value, self),
    }, mode);
  }

  /** String members (InputBox zData) become literals so string arguments reach the Config_* calls. */
  private inlineStrings(script: string, self: MenuItem | null): string {
    return script.replace(/\b(this|[A-Za-z]+_-?\d+)\.zData\b/g, (_m, owner: string) => {
      const item = this.memberOwner(owner, self);
      const text = item?.widget?.kind === "input" ? item.widget.text : "";
      return `"${text.replace(/"/g, "")}"`;
    });
  }

  /** A string-valued data script: a single string-returning call (Config_GetContentControlPassword()). */
  private evaluateString(script: string, self: MenuItem | null): string | null {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*$/.exec(script);
    if (m) return this.env.config?.callString(m[1]) ?? null;
    void self;
    return null;
  }

  private memberOwner(owner: string, self: MenuItem | null): MenuItem | null {
    if (owner === "this") return self;
    const m = /^(.*)_(-?\d+)$/.exec(owner);
    return m ? this.findById(m[1], Number(m[2])) : null;
  }

  /** Assignments to window members ("ControlsMenu_954.isReset = 1", "MenuScreen_905.nUserData = ..."). */
  private assignMember(name: string, value: number, self: MenuItem | null): void {
    const dot = name.indexOf(".");
    if (dot <= 0) return;
    const item = this.memberOwner(name.slice(0, dot), self);
    if (!item) return;
    const member = name.slice(dot + 1);
    const w = item.widget;
    switch (member) {
      case "nUserData":
        item.userData = x87Fistp(value);
        break;
      case "isOn":
        if (w?.kind === "toggle") w.isOn = x87Fistp(value) !== 0;
        break;
      case "nOffset":
        if (w?.kind === "controls") w.offset = x87Fistp(value);
        break;
      case "isReset":
        if (w?.kind === "controls") w.isReset = (x87Fistp(value) & 0xff) !== 0;
        break;
      case "vValue":
        if (w?.kind === "slide") w.value = value;
        break;
      default:
        break;
    }
  }

  private findById(type: string, id: number): MenuItem | null {
    let found: MenuItem | null = null;
    for (const root of [this.screen, this.popup]) {
      if (root) walk(root, (i) => {
        if (!found && i.type === type && i.id === id) found = i;
      });
    }
    return found;
  }

  private scriptValue(name: string, args: readonly QvmExpressionArg[] | null, self: MenuItem | null): number | undefined {
    const a = (i: number) => (args && args[i] ? args[i].int() : 0);
    switch (name) {
      case "TRUE":
        return 1;
      case "FALSE":
        return 0;
      case "MENUMANAGER_QUIT":
        return MENU_MODE.QUIT;
      case "MENUMANAGER_QUITTOMAINMENU":
        return MENU_MODE.QUITTOMAINMENU;
      case "MENUMANAGER_STARTGAME":
        return MENU_MODE.STARTGAME;
      case "MENUMANAGER_IDLE":
        return MENU_MODE.IDLE;
      case "MENUMANAGER_RESTARTLEVEL":
        return MENU_MODE.RESTARTLEVEL;
      case "MenuManager_RequestScreen": {
        // FUN_004163a0: argument 1 = commit the current screen (FUN_00416420) first.
        if (a(1) !== 0 && this.screen) this.saveData(this.screen);
        const id = a(0);
        this.screenId = id;
        this.next = 0;
        this.state = 6;
        return 1;
      }
      case "MenuManager_PushScreen":
        this.stack.push(this.screenId);
        this.screenId = a(0);
        this.next = 0;
        this.state = 6;
        return 1;
      case "MenuManager_PopScreen":
        // FUN_00416610: argument 0 = commit first; the previous screen is shown without reloading (next state 1).
        if (a(0) !== 0 && this.screen) this.saveData(this.screen);
        this.screenId = this.stack.length ? this.stack.pop()! : this.screenId;
        this.next = 1;
        this.state = 6;
        return 1;
      case "MenuManager_LeaveMenus": {
        const id = a(0);
        const mode = a(1);
        if (!this.env.levelFailed() || mode !== MENU_MODE.IDLE) {
          this.screenId = id;
          this.state = 6;
          this.next = mode;
        }
        return 1;
      }
      case "MenuManager_ActivatePopupScreen":
        this.popupId = a(0);
        this.state = 14;
        return 1;
      case "MenuManager_DeactivatePopuScreen":
        this.state = 8;
        this.next = 15;
        return 1;
      case "MenuManager_ForceUpdateWindow": {
        // Reload one window by id (the device list reloads the resolution list, a new profile the profile list).
        const id = a(0);
        for (const root of [this.screen, this.popup]) {
          if (root) walk(root, (i) => {
            if (i.id === id) {
              if (i.kind === "screen") this.loadData(i);
              else this.loadWidget(i);
            }
          });
        }
        return 1;
      }
      case "MenuManager_SetEnabled":
      case "MenuManager_SetLanguage":
        return 1;
      case "Game_SetMission":
        this.env.setMission(a(0));
        return 1;
      case "Game_SetPlayMode":
        this.env.setPlayMode?.(a(0));
        return 1;
      case "LevelFlow_LevelFailed":
        return this.env.levelFailed() ? 1 : 0;
      case "LevelFlow_IsCountryUSA":
      case "Config_IsGermany":
        return 0;
      case "Config_PlayerGetActiveMission":
        if (this.env.config && args && args.length) return this.env.config.call(name, { int: a, float: (i) => args[i]?.float() ?? 0, string: () => "" }, () => {}) ?? 0;
        return this.env.activeMission();
      case "Config_GetActivePlayerProfileIndex":
        return this.env.config?.active ?? 0;
      default:
        break;
    }
    const cfg = this.env.config;
    if (cfg && (name.startsWith("Config_") || name.startsWith("ControlsMenu_") || name === "Game_UpdateVolume")) {
      const v = cfg.call(name, {
        int: a,
        float: (i) => (args && args[i] ? args[i].float() : 0),
        string: (i) => (args && args[i] ? args[i].string() : ""),
      }, (text, id) => {
        this.collecting?.entries.push({ id, text });
      });
      if (v !== undefined) return v;
    }
    const dot = name.indexOf(".");
    if (dot > 0) {
      // Window members "<Type>_<id>.<member>" / "this.<member>".
      const owner = name.slice(0, dot);
      const member = name.slice(dot + 1);
      let item: MenuItem | null = null;
      if (owner === "this") item = self;
      else {
        const m = /^(.*)_(-?\d+)$/.exec(owner);
        if (m) item = this.findById(m[1], Number(m[2]));
      }
      const w = item?.widget;
      if (item && member === "nActiveID") return w?.kind === "list" ? w.activeId : item.entries[item.activeIndex]?.id ?? 0;
      if (item && member === "nUserData") return item.userData;
      if (w?.kind === "slide" && member === "vValue") return w.value;
      if (w?.kind === "slide" && member === "nValue") return w.nValue;
      if (w?.kind === "toggle" && member === "isOn") return w.isOn ? 1 : 0;
      if (w?.kind === "controls" && member === "nOffset") return w.offset;
      if (w?.kind === "controls" && member === "isReset") return w.isReset ? 1 : 0;
      return 0;
    }
    if (name.startsWith("Config_") || name.startsWith("MenuManager_") || name.startsWith("ControlsMenu_")) return 0;
    return undefined;
  }

  // ---------------------------------------------------------------- update ---

  /** One logic tick of the manager (FUN_00416f70) plus the draw-side fade bookkeeping. */
  tick(): void {
    this.ticks++;
    this.update();
    this.attractCheck();
    // FUN_004177e0 (end of every draw): +200 = +0xc4; +0xc4 = +0xcc.
    this.fadePrev2 = this.fadePrev1;
    this.fadePrev1 = this.fade;
  }

  private takeButtons(): void {
    const b = this.buttons;
    const prev = this.buttonState;
    if (this.buttonQueue.length) this.buttonState = this.buttonQueue.shift()!;
    if (!this.buttonState && prev) this.pressAt = null;
    b.down = this.buttonState;
    b.pressed = this.buttonState && !prev;
    b.released = !this.buttonState && prev;
  }

  private update(): void {
    if (this.state !== MENU_MODE.IDLE) this.failTimer = 0;
    switch (this.state) {
      case 0:
      case 1:
        this.goToScreen(this.screenId, this.state === 0);
        this.fade = this.fadePrev1 = this.fadePrev2 = 0;
        this.state = 5;
        return;
      case 2:
        this.processKeys();
        this.takeButtons();
        this.updateRoot();
        return;
      case 3:
        this.buttons.down = this.buttons.pressed = this.buttons.released = false;
        this.updateRoot();
        return;
      case 5:
      case 7:
        if (this.fade !== 16) this.fade += 2;
        if (this.fadePrev2 === 16) {
          this.state = 2;
          this.keyQueue = []; // FUN_00488ce0
        }
        return;
      case 6:
      case 8:
        if (this.fade !== 0) this.fade -= 2;
        if (this.fadePrev2 === 0) {
          this.state = this.next;
          this.closePopup();
        }
        return;
      case MENU_MODE.IDLE:
        this.idle();
        return;
      case MENU_MODE.QUIT:
      case MENU_MODE.STARTGAME:
        this.env.leave(this.state);
        this.state = MENU_MODE.IDLE;
        this.screen = null;
        return;
      case MENU_MODE.QUITTOMAINMENU:
      case MENU_MODE.RESTARTLEVEL:
        this.env.leave(this.state);
        this.state = MENU_MODE.IDLE;
        return;
      case 14:
        this.openPopup();
        this.fade = this.fadePrev1 = this.fadePrev2 = 0;
        this.state = 7;
        return;
      case 15:
        this.state = 2;
        this.fade = this.fadePrev1 = this.fadePrev2 = 16;
        return;
      case 17:
        this.state = MENU_MODE.IDLE;
        return;
      default:
        return;
    }
  }

  /** State 9 (in-game manager): failure timer, Esc / Space / Return, pause sync. */
  private idle(): void {
    let open = this.idleKeys.escape;
    if (this.env.levelFailed() && !this.env.playerDead()) {
      if (this.failTimer < 151) this.failTimer++;
      else {
        open = true;
        this.failTimer = 0;
      }
    }
    if (this.env.playerDead()) open = open || this.idleKeys.space || this.idleKeys.enter;
    this.idleKeys = { escape: false, space: false, enter: false };
    if (this.options.ownDisplay) return;
    if (open) {
      this.openScreen(900);
      if (!this.paused) {
        this.paused = true;
        this.env.setPaused(true);
      }
    } else if (this.paused) {
      this.paused = false;
      this.env.setPaused(false);
    }
  }

  /** FUN_0041fcb0 (init): MenuTextConditional evaluates isEnabled / isVisible before the items are collected. */
  private initConditionals(root: MenuItem): void {
    walk(root, (i) => {
      if (i.type !== "MenuTextConditional") return;
      if (i.enabledExpr) {
        i.enabled = this.evaluate(i.enabledExpr, i) !== 0;
        i.selectable = i.enabled && i.clickScript.length > 0;
      }
      if (i.visibleExpr) i.visible = this.evaluate(i.visibleExpr, i) !== 0;
    });
  }

  /**
   * The own-display menu's idle timer (FUN_00416f70 0x416fb0..0x41705d): when
   * the screen, the selection and the mouse state are unchanged, no key is
   * queued and nothing was modified, count; above 3600 updates (60 s at the
   * main menu's 60 Hz) the manager is deleted and Flow 8 plays the intro in a
   * loop. Any change resets the counter. The modified flag is cleared here.
   */
  private attractCheck(): void {
    if (this.options.ownDisplay) {
      const snap = `${this.screenId}|${this.popupId}|${this.selection}|${this.pointer.x},${this.pointer.y}|${this.buttonState}`;
      if (snap === this.idleSnapshot && this.keyQueue.length === 0 && !this.modifiedFlag && this.state === 2) {
        if (this.idleTicks > 3600) {
          this.idleTicks = 0;
          this.env.attract?.();
        } else this.idleTicks++;
      } else {
        this.idleTicks = 0;
        this.idleSnapshot = snap;
      }
    }
    this.modifiedFlag = false;
  }

  /** FUN_00417580 */
  private goToScreen(id: number, initial: boolean): void {
    const task = this.findTask(id);
    this.screenId = id;
    if (!task) {
      this.screen = null;
      return;
    }
    let screen = this.built.get(id);
    if (!screen) {
      screen = buildMenuItem(task, this.env, null, this.host);
      this.built.set(id, screen);
      this.initConditionals(screen);
    }
    this.screen = screen;
    this.screen.x = 0;
    this.screen.y = 0;
    layoutMenu(this.screen);
    if (initial) this.loadData(this.screen);
    this.collect(this.screen);
    this.buttons.down = this.buttons.pressed = this.buttons.released = false;
    this.buttons.suppress = true;
    this.updateItem(this.screen);
    this.buttons.suppress = false;
    this.env.opened();
  }

  /** FUN_00417720 */
  private openPopup(): void {
    const task = this.findTask(this.popupId);
    if (!task) {
      this.popup = null;
      return;
    }
    let popup = this.built.get(this.popupId);
    if (!popup) {
      popup = buildMenuItem(task, this.env, null, this.host);
      this.built.set(this.popupId, popup);
      this.initConditionals(popup);
    }
    this.popup = popup;
    layoutMenu(this.popup);
    this.loadData(this.popup);
    this.items = collectSelectable(this.popup);
    this.select(0);
    this.buttons.down = this.buttons.pressed = this.buttons.released = false;
    this.buttons.suppress = true;
    this.updateItem(this.popup);
    this.buttons.suppress = false;
  }

  /** FUN_004177b0 */
  private closePopup(): void {
    if (!this.popup) return;
    this.popup = null;
    if (this.screen) {
      layoutMenu(this.screen);
      this.collect(this.screen);
    }
  }

  /** "Collect Items" / "Get Data" scripts of the list widgets (Config_FillMission*). */
  private initData(root: MenuItem): void {
    const missions = this.env.missions();
    walk(root, (i) => {
      if (i.kind === "scrolllist" || i.kind === "picture" || i.kind === "textbox") {
        i.entries = missions.map((m) => ({ id: m.id, text: i.kind === "textbox" ? m.description : i.kind === "picture" ? m.sprite : m.name }));
      }
      if (i.kind === "scrolllist") {
        const active = this.env.activeMission();
        const idx = i.entries.findIndex((e) => e.id === active);
        i.activeIndex = idx >= 0 ? idx : 0;
      }
    });
    this.syncActive(root);
  }

  /** PictureBox / TextBox "Get Active Picture" (e.g. ScrollListBox_964.nActiveID). */
  private syncActive(root: MenuItem): void {
    walk(root, (i) => {
      if ((i.kind === "picture" || i.kind === "textbox") && i.activeExpr) {
        const id = this.evaluate(i.activeExpr, i);
        const idx = i.entries.findIndex((e) => e.id === id);
        if (idx >= 0) i.activeIndex = idx;
      }
    });
  }

  /** FUN_004173f0 */
  private processKeys(): void {
    this.escapeFlag = false;
    this.tabFlag = false;
    const swap = this.popup?.swapKeys ?? false;
    const list = this.focusedList();
    while (this.keyQueue.length) {
      let code = this.keyQueue.shift()!;
      if (list) {
        // FUN_0041a120 consumes the queue while the list has the keyboard focus.
        this.listKey(list, code);
        continue;
      }
      if (swap) {
        if (code === MENU_KEY.DOWN) code = MENU_KEY.RIGHT;
        else if (code === MENU_KEY.UP) code = MENU_KEY.LEFT;
        else if (code === MENU_KEY.RIGHT) code = MENU_KEY.DOWN;
        else if (code === MENU_KEY.LEFT) code = MENU_KEY.UP;
      }
      switch (code) {
        case MENU_KEY.TAB:
          this.tabFlag = true;
          break;
        case MENU_KEY.ESCAPE:
          this.escapeFlag = true;
          break;
        case MENU_KEY.RETURN:
        case MENU_KEY.RIGHT:
        case MENU_KEY.LEFT:
          if (this.selected) this.selected.command = code;
          break;
        case MENU_KEY.DOWN:
          if (this.items.length) {
            this.select(this.selection + 1 >= this.items.length ? 0 : this.selection + 1);
            this.env.sound("menu_high");
          }
          break;
        case MENU_KEY.UP:
          if (this.items.length) {
            this.select(this.selection - 1 < 0 ? this.items.length - 1 : this.selection - 1);
            this.env.sound("menu_high");
          }
          break;
        default:
          break;
      }
    }
  }

  private focusedList(): MenuItem | null {
    let found: MenuItem | null = null;
    const root = this.popup ?? this.screen;
    if (root) walk(root, (i) => {
      if (!found && i.kind === "scrolllist" && i.focused) found = i;
    });
    return found;
  }

  private listKey(list: MenuItem, code: number): void {
    const visible = Math.trunc((list.h - 4) / list.rowHeight);
    switch (code) {
      case MENU_KEY.TAB:
        list.focused = false;
        break;
      case MENU_KEY.RETURN:
        this.evaluate(list.selectScript, list);
        break;
      case MENU_KEY.DOWN:
        if (list.activeIndex < list.entries.length - 1) {
          list.activeIndex++;
          if (list.scroll + visible < list.activeIndex) list.scroll++;
          this.env.sound("menu_sel2");
        }
        break;
      case MENU_KEY.UP:
        if (list.activeIndex > 0) {
          list.activeIndex--;
          if (list.activeIndex < list.scroll) list.scroll--;
          this.env.sound("menu_sel2");
        }
        break;
      default:
        break;
    }
  }

  private updateRoot(): void {
    const root = this.popup ?? this.screen;
    if (!root) return;
    this.updateItem(root);
  }

  /** Per-class update; children are updated after the item itself (MenuWindow base update). */
  private updateItem(item: MenuItem): void {
    switch (item.kind) {
      case "screen":
        // FUN_00421780: escape runs "On Press Escape".
        if (this.escapeFlag) {
          this.escapeFlag = false;
          this.evaluate(item.escapeScript, item);
        }
        break;
      case "frame":
        if (item.selectable) {
          this.hoverTest(item);
          if (item.hover && !item.hoverPrev) this.hoverSelect(item);
          for (const c of item.children) {
            c.command = item.command;
            c.highlighted = item.highlighted;
          }
        }
        item.command = 0;
        break;
      case "text": {
        if (item.type === "MenuTextConditional") {
          if (item.enabledExpr) {
            item.enabled = this.evaluate(item.enabledExpr, item) !== 0;
            item.selectable = item.enabled && item.clickScript.length > 0;
          }
          if (item.visibleExpr) item.visible = this.evaluate(item.visibleExpr, item) !== 0;
        }
        if (item.clickScript && item.enabled) {
          this.hoverTest(item);
          if (item.hover && !item.hoverPrev) this.hoverSelect(item);
          if ((item.clicked || item.command === MENU_KEY.RETURN) && this.state === 2) {
            this.evaluate(item.clickScript, item);
            this.env.sound(item.clickSound || "menu_sel");
          }
        }
        item.command = 0;
        break;
      }
      case "scrolllist":
        this.updateList(item);
        break;
      case "widget":
        this.updateWidget(item);
        break;
      default:
        item.command = 0;
        break;
    }
    for (const c of item.children) this.updateItem(c);
    if (item.kind === "screen" || item.kind === "dialog") this.syncActive(item);
  }

  private updateWidget(item: MenuItem): void {
    const w = item.widget;
    if (!w) return;
    const host = this.host;
    const wi = item as WidgetItem;
    switch (w.kind) {
      case "slide":
        updateSlide(wi, w, host);
        break;
      case "toggle":
        updateToggle(wi, w, host);
        break;
      case "list":
        updateList(wi, w, host);
        break;
      case "input":
        updateInput(item, w, host, this.buttons.suppress);
        break;
      case "controls":
        updateControls(item, w, host);
        break;
      case "ascii":
        updateAscii(wi, w, host);
        break;
      case "type":
        updateType(w, host);
        break;
    }
  }

  /** FUN_0041a120 (mouse part; keys go through listKey while focused). */
  private updateList(list: MenuItem): void {
    this.hoverTest(list);
    if (list.clicked) {
      const row = Math.trunc((this.pointer.y - list.y) / list.rowHeight) + list.scroll;
      if (row === list.activeIndex || row >= list.entries.length) {
        const window = Math.round(this.options.ticksPerSecond * 0.5);
        if (list.lastClickTick !== -1 && this.ticks - list.lastClickTick < window) this.evaluate(list.selectScript, list);
        list.lastClickTick = this.ticks;
      } else {
        list.activeIndex = row;
        list.lastClickTick = this.ticks;
        this.env.sound("menu_sel2");
      }
    }
    if (this.tabFlag) {
      list.focused = true;
      this.tabFlag = false;
    }
  }
}
