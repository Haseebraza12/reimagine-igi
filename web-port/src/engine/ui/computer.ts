/**
 * The map computer (pure model; no DOM): the "Computer" player tool that the
 * MapComputer action opens. Draw it with computer-draw.ts; the 3-D satellite
 * view is the normal world render seen from `MapComputer.view()`.
 * Evidence: docs/hud.md section 11 (labels there); igi.exe, image base 0x400000.
 *
 * Objects (recovered):
 *   Computer              class 0x46a5e0 (ctor 46a690, update 46a8d0, dtor 46ab00);
 *                         created by the player state FUN_0040e470, removed by
 *                         FUN_0040e4c0 (MapComputer pressed again, or state flag 0x20000).
 *   ComputerMenu          0x469700 (ctor 469780, update 4697d0, draw 4699d0): pointer,
 *                         mouse buttons, page switching (FUN_00469b50: 1 map, 2 objectives, 3 log).
 *   ComputerMap           0x468240 (ctor 4682d0, update 468c70, dtor 469620), clicks 468ed0,
 *                         ground follow 468e70, limits 468da0, button callback 468940,
 *                         text callback 468910, zoom FUN_00468b80.
 *   ComputerObjectives    0x4679a0 (ctor 467a10, draw 467ca0, callbacks 467bc0 / 467bf0).
 *   ComputerLog           0x467420 (ctor 467490, draw 467740, callbacks 467680 / 4676b0);
 *                         the 50-entry log FUN_00467960 (fed by StatusMessageScreen FUN_004845c0,
 *                         cleared by FUN_00467950 = StatusMessageScreen_ClearMessages / restart).
 *   ComputerStartup       0x464f50 (ctor 464dc0, update 465810, draw 465870 + 465000).
 *   ComputerObject        0x466280 (draw 4664f0): markers FUN_00466970 (sprite),
 *                         FUN_00466aa0 (shape), FUN_00466c20 (title / info text),
 *                         projection FUN_00466130.
 *   MenuItemTask/MenuItem 0x4fbad0 / 0x4fc2f0 (hover + callbacks FUN_004fbbb0, FUN_004fc480),
 *   ComputerButtonItem    0x46a0c0 (create 46a200, draw 46a170),
 *   ComputerTextItem      0x46a370 (create 46a4f0, draw 46a410).
 *
 * Float -> int conversions use x87Fistp (the game runs the FPU in chop mode).
 */
import { x87Fistp } from "../../loaders";
import type { Vec3 } from "../../contracts";

// ---------------------------------------------------------------------------
// Constants (recovered; float32 values from .rdata)
// ---------------------------------------------------------------------------

/** IGI units per metre. */
const U = 4096;

/** Zoom angles (rad) at 0x53d700; the camera's horizontal tangent is fptan(angle) (FUN_004682d0, FUN_00468b80 callers). */
export const MAP_ZOOM_ANGLES: readonly number[] = [0.7853981852531433, 0.3272492289543152, 0.13962633907794952, 0.009599311277270317];
/** The zoom level is 0..3 (DAT_005c12d8; `< 3` / `!= 0` tests at 0x46901f / 0x469076). */
export const MAP_MAX_ZOOM = 3;
/** Camera offset along the down axis of Rx(-pi/2): -921600 units (0x531a24) = 225 m above the target. */
export const MAP_CAMERA_HEIGHT_M = 921600 / U;
/** Ground-follow ray length (FUN_00468e70, double -1843200 = 450 m). */
export const MAP_GROUND_RAY_M = 1843200 / U;
/** Click ray length: unit direction x 4096000 (0x531550) = 1000 m. */
export const MAP_CLICK_RAY_M = 4096000 / U;
/** Arrow pan per tick: 27306.666 units x tan^0.7 (FUN_00468940, pow via FUN_0049c620 with 0.7 at 0x531a28). */
export const MAP_PAN_UNITS = Math.fround(27306.666);
export const MAP_PAN_EXPONENT = 0.699999988079071;
/** Sphere drag: input channel x 409600 units x tan^0.7 (0x531a30). */
export const MAP_DRAG_UNITS = 409600;
/** Double-click window, ticks (+0x80 / +0x84 = 13). */
export const MAP_CLICK_WINDOW = 13;
/** Pick radius^2 = tan x 167772160 units^2 (0x531a38) = tan x 100 m^2. */
export const MAP_PICK_RADIUS2_M2 = 167772160 / (U * U);
/** Marker size floor 3072 units (0x5314f0). */
export const MAP_MARKER_MIN_SIZE_M = 3072 / U;

/** Pointer limits as fractions of W / H (FUN_004697d0, 0x531a4c..0x531a40). */
export const POINTER_LIMITS = { left: 0.04843749850988388, right: 0.04531250149011612, top: 0.05416666716337204, bottom: 0.09583333134651184 } as const;

/** ComputerStartup steps (FUN_004682d0): texts (language computer.res) and durations in ticks (9, 4.5, 9). */
export const STARTUP_STEPS: ReadonlyArray<{ key: string; ticks: number }> = [
  { key: "INITIALIZING", ticks: 9 },
  { key: "CONNECTING", ticks: 4.5 },
  { key: "DOWNLOADING", ticks: 9 },
];
/** Marker flags the startup callback FUN_004681f0 sets after each step: hilights; + humans + 0x10 lists; all. */
export const STARTUP_MARKER_FLAGS: readonly number[] = [4, 0x15, 0x1f];

/** Marker list bits of ComputerObject +0x20 (FUN_004664f0). */
export const MARKERS = { humans: 1, list2: 2, hilights: 4, cameras: 8, vehicles: 0x10 } as const;

/** Marker shapes PTR_DAT_0053d5a0: point lists (closed by repeating the first point). */
export const MARKER_SHAPES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]], // 0 MARKER_BOX
  [[0, -2.5], [1.5, 1], [-1.5, 1], [0, -2.5]], // 1 soldier
  [[0, -7.5], [4.5, 3], [-4.5, 3], [0, -7.5]], // 2 player
];
/** Marker colours 0x53d5b8 (0..255, passed through the x/128 scale, so 255 overflows): red, yellow, green, player, blue. */
export const MARKER_COLOURS: ReadonlyArray<readonly [number, number, number]> = [
  [255, 0, 0],
  [255, 255, 0],
  [0, 255, 0],
  [64, 255, 64],
  [0, 0, 255],
];
/** Computer text colours 0x53d780 (x/128 scale): 0 red, 1 green, 2 pale green, 3 white. */
export const COMPUTER_TEXT_COLOURS: ReadonlyArray<readonly [number, number, number]> = [
  [128, 16, 16],
  [16, 96, 16],
  [48, 96, 48],
  [128, 128, 128],
];

/** Interface depths ("z" of the 2-D calls); smaller is drawn in front. */
export const COMPUTER_Z = { pointer: 512.48, items: 522.48, markers: 532.48, background: 542.48, filter: 552.48 } as const;

/** Computer.res sprite names per button (normal, highlighted, pressed). */
const ARROW_UP = ["arrow1_1.spr", "arrow1_2.spr", "arrow1_3.spr"] as const;
const ARROW_RIGHT = ["arrow2_1.spr", "arrow2_2.spr", "arrow2_3.spr"] as const;
const ARROW_DOWN = ["arrow3_1.spr", "arrow3_2.spr", "arrow3_3.spr"] as const;
const ARROW_LEFT = ["arrow4_1.spr", "arrow4_2.spr", "arrow4_3.spr"] as const;
const PLUS = ["plus_1.spr", "plus_2.spr", "plus_3.spr"] as const;
const MINUS = ["minus_1.spr", "minus_2.spr", "minus_3.spr"] as const;
const SPHERE = ["sphere_1.spr", "sphere_2.spr", "sphere_3.spr"] as const;
const LOG_UP = ["arrowup_1.spr", "arrowup_2.spr", "arrowup_3.spr"] as const;
const LOG_DOWN = ["arrowdown_1.spr", "arrowdown_2.spr", "arrowdown_3.spr"] as const;
const OBJECTIVE = ["objective_1.spr", "objective_2.spr", "objective_2.spr"] as const;

/** h_*.spr sprites of computer.res, in the order of the table at 0x53d7b0. */
export const HILIGHT_SPRITES: readonly string[] = [
  "h_player.spr", "h_guard.spr", "h_camera.spr", "h_computer.spr", "h_cabinet.spr", "h_mine.spr",
  "h_0.spr", "h_1.spr", "h_2.spr", "h_3.spr", "h_4.spr", "h_5.spr", "h_6.spr", "h_7.spr", "h_8.spr", "h_9.spr",
  "h_sentrygun.spr", "h_scamera1.spr", "h_scamera2.spr",
];

export type ComputerPage = 1 | 2 | 3;
export const PAGE = { map: 1, objectives: 2, log: 3 } as const;

/** Mouse button bits as the ComputerMenu stores them (+0x30 / +0x34). */
export const COMPUTER_BUTTON = { left: 0x10, right: 0x20 } as const;

// ---------------------------------------------------------------------------
// Data the computer reads from the world (engine space, metres, y up)
// ---------------------------------------------------------------------------

export interface ComputerHuman {
  id: number;
  /** Engine metres (the human's origin). */
  position: Vec3;
  /** Port yaw: 0 looks along -z (IGI north), counter-clockwise from above (= IGI gamma). */
  yaw: number;
  /** Team (HumanSoldier "Team"); 0 or 2 draw green, others red (FUN_0045eef0). */
  team: number;
  alive: boolean;
  /** Marker size in metres (object +0xa0; floor 0.75 m). */
  size?: number;
}

export interface ComputerCamera {
  id: number;
  position: Vec3;
  /** Rotating camera: h_scamera2.spr animation frame (+0x25e0); otherwise h_scamera1.spr. */
  rotatingFrame?: number | null;
  /** Destroyed / switched off: no marker (+0x25d0 -> +0x170). */
  disabled?: boolean;
}

/** One object a ComputerHilight currently highlights (its "Hilight" expression is non-zero). */
export interface ComputerHilightTarget {
  taskId: number;
  position: Vec3;
  /** computer.res sprite ("h_1.spr") or null. */
  sprite: string | null;
  /** MARKER_* shape (-1 = none) and MARKER_COLOR_* (-1 = none). */
  marker: number;
  markerColour: number;
  /** Resolved title / info texts (zoom 1 / zoom >= 2), or null when the key is empty. */
  title: string | null;
  info: string | null;
  size?: number;
}

export interface ComputerObjective {
  /** Resolved objective text (objectives.res), "" when the slot is unused. */
  text: string;
  /** "Objective N Link To Position" task id, -1 = none. */
  link: number;
  complete: boolean;
  failed: boolean;
}

export interface ComputerWorld {
  player(): ComputerHuman | null;
  soldiers(): readonly ComputerHuman[];
  cameras(): readonly ComputerCamera[];
  hilights(): readonly ComputerHilightTarget[];
  /** The six objective slots of the active DefineComputerObjective (null when none is active). */
  objectives(): readonly ComputerObjective[] | null;
  /** Position of a task by id (objective links), engine metres. */
  taskPosition(id: number): Vec3 | null;
  /** First hit of a ray (unit direction) within maxDistance metres, or null. */
  ray(origin: Vec3, dir: Vec3, maxDistance: number): Vec3 | null;
  /** Line of sight between two points (the soldier marker test, FUN_0045eef0); default: always visible. */
  lineOfSight?(from: Vec3, to: Vec3): boolean;
}

export interface ComputerRandom {
  /** FUN_004aaa50: [0, 1). */
  float(): number;
  /** FUN_004aaaa0: [0, n). */
  int(n: number): number;
}

export interface ComputerResources {
  /** Size of a computer.res sprite. */
  spriteSize(name: string): { w: number; h: number } | null;
  /** FUN_004ad200 width / line height of a text in an in-game menu font ("font1.fnt", "font3.fnt", "font4.fnt"). */
  measure(font: string, text: string): { w: number; h: number };
  /** Line height of computer/font1.fnt (the empty label of the sprite buttons). */
  buttonLabelHeight: number;
  /** language computer.res / objectives.res / messages.res lookup ("RM: key" when missing). */
  text(key: string): string;
}

export interface ComputerEnv {
  world: ComputerWorld;
  res: ComputerResources;
  rng: ComputerRandom;
  /** 2-D by-name sound at volume 1 (FUN_004dddc0): mapcomp_01, mapcomp_03, mapcomp_05. */
  sound(name: string): void;
  /** "Mapcomputer on expression" of HumanPlayerInput (DAT_0053dd64; level 1: empty -> 1). */
  mapEnabled(): boolean;
}

// ---------------------------------------------------------------------------
// The radio log (FUN_00467960 / FUN_00467950)
// ---------------------------------------------------------------------------

export class ComputerLog {
  /** Oldest first; at most 50 (0x32) entries, the oldest is dropped. */
  readonly entries: string[] = [];

  add(text: string): void {
    if (this.entries.length >= 50) this.entries.shift();
    this.entries.push(text);
  }

  clear(): void {
    this.entries.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Menu items (MenuItem 0x4fc2f0 + ComputerButtonItem / ComputerTextItem)
// ---------------------------------------------------------------------------

export interface ComputerItem {
  id: number;
  kind: "button" | "text";
  x: number;
  y: number;
  w: number;
  h: number;
  /** Button sprites: normal, highlighted, pressed. */
  sprites?: readonly [string, string, string];
  /** Text item: resolved text, in-game font name, COMPUTER_TEXT_COLOURS index. */
  text?: string;
  font?: string;
  colour?: number;
  /** +0x4d hovered this tick, +0x4e highlighted (latched), +0x80 / +0x81 left button held (now / last tick). */
  hoverNow: boolean;
  highlighted: boolean;
  held: boolean;
  heldPrev: boolean;
  callback: (item: ComputerItem, msg: ItemMessage) => void;
}

interface ItemMessage {
  id: number;
  dx: number;
  dy: number;
  x: number;
  y: number;
  buttons: number;
  pressed: number;
}

/** MenuItemTask: the hover / dispatch logic of FUN_004fbbb0 and FUN_004fc480. */
class ItemTask {
  readonly items: ComputerItem[] = [];
  private cur = { x: 0, y: 0, b: 0 };
  private prev = { x: 0, y: 0, b: 0 };

  /** FUN_004fc070 (sent by the ComputerMenu every tick). */
  setPointer(x: number, y: number, buttons: number): void {
    this.prev = this.cur;
    this.cur = { x, y, b: buttons };
  }

  /** The last highlighted item (FUN_004fc6f0 keeps the last one found). */
  highlighted(): ComputerItem | null {
    let found: ComputerItem | null = null;
    for (const it of this.items) if (it.highlighted) found = it;
    return found;
  }

  update(): void {
    for (const it of this.items) {
      it.highlighted = it.hoverNow ? true : it.highlighted;
      it.hoverNow = false;
    }
    const { x, y, b } = this.cur;
    const dx = x - this.prev.x;
    const dy = y - this.prev.y;
    const pressed = ~this.prev.b & b;
    const msg = (id: number): ItemMessage => ({ id, dx, dy, x, y, buttons: b, pressed });
    if (dx === 0 && dy === 0 && (b & 0x70) === 0) {
      const h = this.highlighted();
      if (h) this.dispatch(msg(h.id));
      return;
    }
    const h = this.highlighted();
    if (dx === 0 && dy === 0 && h) {
      this.dispatch(msg(h.id));
      return;
    }
    let id = 0;
    for (const it of this.items) {
      const x0 = x87Fistp(it.x);
      const x1 = x87Fistp(it.x + it.w);
      const y0 = x87Fistp(it.y);
      const y1 = x87Fistp(it.y + it.h);
      if (x0 <= x && x <= x1 && y0 <= y && y <= y1) {
        id = it.id;
        this.dispatch(msg(id));
      }
    }
    if (id === 0) this.dispatch(msg(0));
  }

  private dispatch(m: ItemMessage): void {
    for (const it of this.items) {
      if (m.id === it.id) it.hoverNow = true;
      else it.highlighted = false;
      it.callback(it, m);
    }
  }
}

// ---------------------------------------------------------------------------
// Marker / text output of one map frame (drawn by computer-draw.ts)
// ---------------------------------------------------------------------------

export interface MapSpriteMarker {
  kind: "sprite";
  sprite: string;
  frame: number;
  /** Projected position; the sprite's top-left is (x - w * 0.5, y - h * 0.5). */
  x: number;
  y: number;
}

export interface MapShapeMarker {
  kind: "shape";
  shape: number;
  colour: number;
  x: number;
  y: number;
  /** Rotation (rad, screen space, FUN_004abb70) and per-axis scale (pixels per shape unit). */
  angle: number;
  sx: number;
  sy: number;
}

export interface MapTextMarker {
  kind: "text";
  text: string;
  /** fistp of the projected position (FUN_00466c20). */
  x: number;
  y: number;
}

export type MapMarker = MapSpriteMarker | MapShapeMarker | MapTextMarker;

/** Camera of the satellite view (engine space). */
export interface MapComputerView {
  /** Camera position, engine metres. */
  position: Vec3;
  /** Looks straight down; screen right = +x (east), screen up = -z (IGI north). */
  forward: Vec3;
  up: Vec3;
  /** Horizontal tangent (90 deg at zoom 0); the vertical one is 0.75 x it (4:3, rendering.md). */
  tanX: number;
  /** Vertical field of view in degrees for a THREE.PerspectiveCamera with aspect 4/3. */
  fovYDegrees: number;
  zoom: number;
}

// ---------------------------------------------------------------------------
// The computer
// ---------------------------------------------------------------------------

export interface ComputerInput {
  /** Pointer motion this tick in 640x480 pixels (the original scales the look channels by W/2, H/2). */
  dx: number;
  dy: number;
  left: boolean;
  right: boolean;
  /** Mouse wheel moved up / down this tick (DAT_00bceccc 0x100 / 0x200 = ZoomIn / ZoomOut wheel bits). */
  wheelUp: boolean;
  wheelDown: boolean;
}

interface MapState {
  /** Camera position (DAT_005c12b0..c0), engine metres. */
  camera: Vec3;
  tan: number;
  /** Interference filter: intensity (+0x78) and ticks to the next burst (+0x7c). */
  noise: number;
  noiseTimer: number;
  clickL: number;
  clickR: number;
  clickPos: { x: number; y: number };
  /** Tracked object (+0x90): a human id, or null. */
  tracking: { kind: "player" | "soldier"; id: number } | null;
  /** Selected security camera (+0xa4). */
  selectedCamera: number | null;
  /** Previous wheel bits (+0xa8). */
  prevWheel: number;
  markerFlags: number;
  startup: { running: boolean; step: number; timer: number };
}

const W = 640;
const H = 480;

export class MapComputer {
  page: ComputerPage = PAGE.map;
  /** +0x24 / +0x28 */
  readonly pointer = { x: W * 0.5, y: H * 0.5 };
  /** +0x2c: the sphere is being dragged (pointer frozen and hidden). */
  dragging = false;
  /** +0x30 held, +0x34 pressed this tick. */
  buttons = 0;
  pressed = 0;
  /** +0x38: page requested by a click, applied on the next tick. */
  private requested: ComputerPage | 0 = 0;
  /** Zoom level DAT_005c12d8 (0..3). */
  zoom = 0;
  /** Target object for the next map page (DAT_005c12d4): a task id, "player" or null. */
  private target: { kind: "player" } | { kind: "task"; id: number } | null = null;
  /** Log page scroll (+0x20). */
  logScroll = 0;
  readonly map: MapState = {
    camera: [0, MAP_CAMERA_HEIGHT_M, 0],
    tan: 1,
    noise: 1,
    noiseTimer: 60,
    clickL: 0,
    clickR: 0,
    clickPos: { x: 0, y: 0 },
    tracking: null,
    selectedCamera: null,
    prevWheel: 0,
    markerFlags: 0,
    startup: { running: false, step: 0, timer: 0 },
  };
  private items = new ItemTask();
  private readonly env: ComputerEnv;

  constructor(env: ComputerEnv) {
    this.env = env;
    // FUN_0046a690: zoom 0, target = the player, map page if the map is enabled, else objectives.
    this.zoom = 0;
    this.target = { kind: "player" };
    this.createPage(env.mapEnabled() ? PAGE.map : PAGE.objectives);
  }

  get itemList(): readonly ComputerItem[] {
    return this.items.items;
  }

  /** The satellite camera while the map page shows; null on the objectives / log pages (the world is not drawn). */
  view(): MapComputerView | null {
    if (this.page !== PAGE.map) return null;
    const tan = this.map.tan;
    return {
      position: [this.map.camera[0], this.map.camera[1], this.map.camera[2]],
      forward: [0, -1, 0],
      up: [0, 0, -1],
      tanX: tan,
      fovYDegrees: (2 * Math.atan(0.75 * tan) * 180) / Math.PI,
      zoom: this.zoom,
    };
  }

  // ------------------------------------------------------------- pages ----

  /** FUN_00469b50: destroy the current page and create `page`. */
  private createPage(page: ComputerPage): void {
    this.page = page;
    this.items = new ItemTask();
    this.dragging = false;
    if (page === PAGE.map) this.createMapPage();
    else if (page === PAGE.objectives) this.createObjectivesPage();
    else this.createLogPage();
  }

  private textItem(id: number, key: string, x: number, y: number, colour: number, cb: ComputerItem["callback"]): ComputerItem {
    // FUN_0046a4f0: in-game menu font3, rect = text width x text height.
    const text = this.env.res.text(key);
    const size = this.env.res.measure("font3.fnt", text);
    const item: ComputerItem = { id, kind: "text", x, y, w: size.w, h: size.h, text, font: "font3.fnt", colour, hoverNow: false, highlighted: false, held: false, heldPrev: false, callback: cb };
    this.items.items.push(item);
    return item;
  }

  private buttonItem(id: number, sprites: readonly [string, string, string], x: number, y: number, cb: ComputerItem["callback"]): ComputerItem {
    // FUN_0046a200: sprite + empty computer/font1 label; rect = (spriteW + labelW) x max(labelH, spriteH).
    const s = this.env.res.spriteSize(sprites[0]) ?? { w: 0, h: 0 };
    const item: ComputerItem = {
      id, kind: "button", x, y, w: s.w, h: Math.max(this.env.res.buttonLabelHeight, s.h), sprites,
      hoverNow: false, highlighted: false, held: false, heldPrev: false, callback: cb,
    };
    this.items.items.push(item);
    return item;
  }

  /** FUN_004682d0 */
  private createMapPage(): void {
    const m = this.map;
    if (this.target) {
      this.centreOnTarget(this.target);
      this.target = null;
    }
    m.tan = mapTan(this.zoom);
    m.clickL = 0;
    m.clickR = 0;
    m.tracking = null;
    m.selectedCamera = null;
    m.noise = 1;
    m.noiseTimer = 60;
    m.markerFlags = 0;
    const fx = Math.fround(W * 0.8343750238418579);
    const fy = Math.fround(H * 0.7124999761581421);
    const cb = (item: ComputerItem, msg: ItemMessage) => this.mapButton(item, msg);
    this.buttonItem(3, ARROW_UP, fx - 23, fy - 47, cb);
    this.buttonItem(4, ARROW_DOWN, fx - 23, fy + 18, cb);
    this.buttonItem(5, ARROW_LEFT, fx - 47, fy - 23, cb);
    this.buttonItem(6, ARROW_RIGHT, fx + 18, fy - 23, cb);
    this.buttonItem(7, PLUS, fx - 48, fy + 48, cb);
    this.buttonItem(8, MINUS, fx + 24, fy + 48, cb);
    this.buttonItem(9, SPHERE, fx - 17, fy - 17, cb);
    const tx = Math.fround(W * 0.10000000149011612);
    const pageCb = (_item: ComputerItem, msg: ItemMessage) => {
      // FUN_00468910: Objectives -> page 2, Log -> page 3 on a left press.
      if ((this.pressed & COMPUTER_BUTTON.left) === 0) return;
      if (msg.id === 1) this.requested = PAGE.objectives;
      else if (msg.id === 2) this.requested = PAGE.log;
    };
    this.textItem(1, "OBJECTIVES", tx, Math.fround(H * 0.8083333373069763), 1, pageCb);
    this.textItem(2, "LOG", tx, Math.fround(H * 0.7749999761581421), 1, pageCb);
    this.restartStartup();
  }

  /** FUN_00467a10 */
  private createObjectivesPage(): void {
    const tx = Math.fround(W * 0.10000000149011612);
    const pageCb = (_item: ComputerItem, msg: ItemMessage) => {
      // FUN_00467bc0: Map -> page 1, Log -> page 3.
      if ((this.pressed & COMPUTER_BUTTON.left) === 0) return;
      if (msg.id === 1) this.requested = PAGE.map;
      else if (msg.id === 2) this.requested = PAGE.log;
    };
    if (this.env.mapEnabled()) this.textItem(1, "MAP", tx, Math.fround(H * 0.8083333373069763), 1, pageCb);
    this.textItem(2, "LOG", tx, Math.fround(H * 0.7749999761581421), 1, pageCb);
    if (this.env.mapEnabled()) {
      const bx = Math.fround(W * -0.125);
      const by = Math.fround(H * -0.1666666716337204);
      for (let i = 0; i < 6; i++) {
        this.buttonItem(3 + i, OBJECTIVE, bx, by, (item, msg) => this.objectiveButton(item, msg, i));
      }
    }
  }

  /** FUN_00467490 */
  private createLogPage(): void {
    this.logScroll = 0;
    const tx = Math.fround(W * 0.10000000149011612);
    const pageCb = (_item: ComputerItem, msg: ItemMessage) => {
      // FUN_00467680: Map -> page 1, Objectives -> page 2.
      if ((this.pressed & COMPUTER_BUTTON.left) === 0) return;
      if (msg.id === 1) this.requested = PAGE.map;
      else if (msg.id === 2) this.requested = PAGE.objectives;
    };
    if (this.env.mapEnabled()) this.textItem(1, "MAP", tx, Math.fround(H * 0.8083333373069763), 1, pageCb);
    this.textItem(2, "OBJECTIVES", tx, Math.fround(H * 0.7749999761581421), 1, pageCb);
    const bx = Math.fround(W * 0.09062500298023224);
    const by = Math.fround(H * 0.10000000149011612);
    const cb = (item: ComputerItem, msg: ItemMessage) => this.logButton(item, msg);
    this.buttonItem(3, LOG_UP, bx, by, cb);
    this.buttonItem(4, LOG_DOWN, bx, by + 36, cb);
  }

  // --------------------------------------------------------- callbacks ----

  /** FUN_00468940 */
  private mapButton(item: ComputerItem, msg: ItemMessage): void {
    if (item.id !== msg.id) return;
    const held = (this.buttons & COMPUTER_BUTTON.left) !== 0;
    item.heldPrev = item.held;
    item.held = held;
    let px = 0;
    let py = 0; // + = IGI north (+y)
    const m = this.map;
    if (held) {
      switch (item.id) {
        case 3:
          m.tracking = null;
          py = MAP_PAN_UNITS;
          break;
        case 4:
          m.tracking = null;
          py = -MAP_PAN_UNITS;
          break;
        case 5:
          m.tracking = null;
          px = -MAP_PAN_UNITS;
          break;
        case 6:
          m.tracking = null;
          px = MAP_PAN_UNITS;
          break;
        case 7:
        case 8:
          if (!item.heldPrev) {
            if (item.id === 7 ? this.zoom < MAP_MAX_ZOOM : this.zoom !== 0) {
              this.zoom += item.id === 7 ? 1 : -1;
              m.markerFlags = 0; // FUN_00466e50(ComputerObject, 0)
              this.restartStartup();
            }
            this.env.sound("mapcomp_01");
          }
          break;
        default:
          break;
      }
    }
    this.setZoomTan(mapTan(this.zoom));
    if (item.id === 9) {
      if (!held) this.dragging = false;
      else {
        // The look channels are pointer motion / (W/2, H/2) (FUN_004697d0 inverse); the vertical one is negated
        // unless the profile field +0x538 is set, which the pointer code un-does: net effect, the map moves
        // with the pointer motion as below (inferred sign from the two recovered negations).
        // The pointer is frozen while dragging, so the raw motion of this tick is used.
        const dx = this.lastInput?.dx ?? 0;
        const dy = this.lastInput?.dy ?? 0;
        px = (dx / (W * 0.5)) * MAP_DRAG_UNITS;
        py = -(dy / (H * 0.5)) * MAP_DRAG_UNITS;
        this.dragging = true;
        m.tracking = null;
      }
    }
    const k = Math.pow(m.tan, MAP_PAN_EXPONENT);
    m.camera[0] += Math.fround(k * px) / U;
    m.camera[2] -= (k * py) / U;
  }

  /** FUN_004676b0 */
  private logButton(item: ComputerItem, msg: ItemMessage): void {
    if (item.id !== msg.id) return;
    const prev = item.held;
    item.heldPrev = prev;
    item.held = (this.buttons & COMPUTER_BUTTON.left) !== 0;
    if (!item.held) return;
    if (item.id === 3) {
      if (!item.heldPrev && this.logScroll > 0) this.logScroll--;
    } else if (item.id === 4 && !prev && this.logScroll < this.logLength - 15) {
      this.logScroll++;
    }
  }

  /** Set by the HUD each tick (the log lives outside the computer). */
  logLength = 0;

  /** FUN_00467bf0 */
  private objectiveButton(item: ComputerItem, msg: ItemMessage, index: number): void {
    if (item.id !== msg.id) return;
    item.heldPrev = item.held;
    item.held = (this.buttons & COMPUTER_BUTTON.left) !== 0;
    if (!item.held) return;
    const obj = this.env.world.objectives()?.[index];
    if (obj && obj.link !== -1) {
      this.target = { kind: "task", id: obj.link };
      this.requested = PAGE.map;
    }
  }

  /** FUN_00467ca0 positions the objective buttons while drawing; the HUD calls this with the layout. */
  placeObjectiveButton(index: number, x: number, y: number): void {
    const item = this.items.items.find((i) => i.id === 3 + index);
    if (item) {
      item.x = x;
      item.y = y;
    }
  }

  // -------------------------------------------------------------- map -----

  private centreOnTarget(target: { kind: "player" } | { kind: "task"; id: number }): void {
    const pos = target.kind === "player" ? this.env.world.player()?.position ?? null : this.env.world.taskPosition(target.id);
    if (pos) this.centreOn(pos);
  }

  /** FUN_004688a0: camera = point + 225 m up. */
  private centreOn(p: Vec3): void {
    this.map.camera = [p[0], p[1] + MAP_CAMERA_HEIGHT_M, p[2]];
  }

  /** FUN_00468b80: a new tangent starts an interference burst and plays mapcomp_05 + mapcomp_03. */
  private setZoomTan(tan: number): void {
    const m = this.map;
    if (tan === m.tan) return;
    m.tan = tan;
    const r = this.env.rng.float();
    m.noise = Math.fround(r * 0.05000000074505806 + 0.949999988079071);
    m.noiseTimer = this.env.rng.int(75) + 15;
    this.env.sound("mapcomp_05");
    this.env.sound("mapcomp_03");
  }

  /** FUN_00464f30 */
  private restartStartup(): void {
    this.map.startup = { running: true, step: 0, timer: 0 };
  }

  /** FUN_00465810 */
  private tickStartup(): void {
    const s = this.map.startup;
    if (!s.running) return;
    s.timer += 1;
    if (STARTUP_STEPS[s.step].ticks < s.timer) {
      this.map.markerFlags = STARTUP_MARKER_FLAGS[s.step];
      if (s.step < STARTUP_STEPS.length - 1) {
        s.timer = 0;
        s.step++;
      } else {
        s.running = false;
      }
    }
  }

  /** Screen ray through the pointer (FUN_00468ed0): unit direction in engine space. */
  private pointerRay(px: number, py: number): Vec3 {
    const tan = this.map.tan;
    const bx = ((px + px - W) * tan) / W;
    const by = (1 * tan * (py + py - H)) / W; // aspect() = 4H/(3W) = 1 at 4:3
    // camera basis: right = +x, down = +z (south), forward = -y
    const d: Vec3 = [bx, -1, by];
    const len = Math.hypot(d[0], d[1], d[2]);
    return [d[0] / len, d[1] / len, d[2] / len];
  }

  /** FUN_00468ed0 */
  private mapInput(input: ComputerInput): void {
    const m = this.map;
    const wheel = (input.wheelUp ? 0x100 : 0) | (input.wheelDown ? 0x200 : 0);
    let click = false;
    if (!this.items.highlighted()) {
      let zoomIn = false;
      let zoomOut = false;
      if (this.pressed & COMPUTER_BUTTON.left) {
        if (m.clickL === 0) {
          click = true;
          m.clickPos = { x: this.pointer.x, y: this.pointer.y };
          m.clickL = MAP_CLICK_WINDOW;
        } else {
          zoomIn = true;
          m.clickL = 0;
        }
      }
      if (this.pressed & COMPUTER_BUTTON.right) {
        if (m.clickR === 0) m.clickR = MAP_CLICK_WINDOW;
        else {
          zoomOut = true;
          m.clickR = 0;
        }
      }
      if ((((wheel & 0x100) !== 0 && (m.prevWheel & 0x100) === 0) || zoomIn) && this.zoom < MAP_MAX_ZOOM) {
        this.zoom++;
        this.setZoomTan(mapTan(this.zoom));
        this.restartStartup();
      }
      if ((((wheel & 0x200) !== 0 && (m.prevWheel & 0x200) === 0) || zoomOut) && this.zoom !== 0) {
        this.zoom--;
        this.setZoomTan(mapTan(this.zoom));
        this.restartStartup();
      }
    }
    if (m.clickL > 0) m.clickL--;
    if (m.clickR > 0) m.clickR--;
    if (click) this.mapClick(m.clickPos.x, m.clickPos.y);
    else if (m.tracking) {
      const pos = this.trackedPosition();
      if (pos) this.centreOn(pos);
      else m.tracking = null;
    }
    m.prevWheel = wheel;
  }

  private trackedPosition(): Vec3 | null {
    const t = this.map.tracking;
    if (!t) return null;
    if (t.kind === "player") return this.env.world.player()?.position ?? null;
    const s = this.env.world.soldiers().find((h) => h.id === t.id);
    return s && s.alive ? s.position : null;
  }

  /** The single-click part of FUN_00468ed0: pick a human (within 10 m x sqrt(tan) of the ground hit), a camera, or recentre. */
  private mapClick(px: number, py: number): void {
    const m = this.map;
    const origin: Vec3 = [m.camera[0], m.camera[1], m.camera[2]];
    const hit = this.env.world.ray(origin, this.pointerRay(px, py), MAP_CLICK_RAY_M);
    const r2 = m.tan * MAP_PICK_RADIUS2_M2;
    let human: { kind: "player" | "soldier"; id: number } | null = null;
    let camera = false;
    if (hit) {
      const near = (p: Vec3) => (p[0] - hit[0]) ** 2 + (p[2] - hit[2]) ** 2 < r2;
      const player = this.env.world.player();
      if (player && near(player.position)) human = { kind: "player", id: player.id };
      if (!human) for (const s of this.env.world.soldiers()) {
        if (near(s.position)) {
          human = { kind: "soldier", id: s.id };
          break;
        }
      }
      for (const c of this.env.world.cameras()) {
        if (near(c.position)) {
          m.selectedCamera = c.id;
          camera = true;
          break;
        }
      }
      if (!camera) this.centreOn(hit); // no DefineComputerLimit in level 1 (FUN_00469510 always passes)
      if (human) {
        m.tracking = human;
        const pos = this.trackedPosition();
        if (pos) this.centreOn(pos);
        return;
      }
    }
    m.tracking = null;
  }

  /** FUN_00468e70: keep the camera 225 m above whatever lies below the map centre. */
  private followGround(): void {
    const m = this.map;
    const hit = this.env.world.ray([m.camera[0], m.camera[1], m.camera[2]], [0, -1, 0], MAP_GROUND_RAY_M);
    if (hit) this.centreOn(hit);
  }

  /** The interference filter step at the end of FUN_00468c70. */
  private tickNoise(): void {
    const m = this.map;
    if (m.noiseTimer === 0) {
      m.noise = 0.10000000149011612;
      m.noiseTimer = 15;
      m.noise = Math.fround(this.env.rng.float() * 0.4000000059604645 + m.noise);
      m.noiseTimer += this.env.rng.int(75);
    } else {
      m.noiseTimer--;
    }
    m.noise = Math.fround(m.noise - 0.03333333507180214);
  }

  // ------------------------------------------------------------- tick -----

  /**
   * One 30 Hz step of ComputerMenu (FUN_004697d0) and the current page. The
   * original skips it entirely while the game is paused (FUN_00415c50).
   */
  tick(input: ComputerInput): void {
    if (this.requested) {
      const page = this.requested;
      this.requested = 0;
      this.createPage(page);
    }
    if (!this.dragging) {
      // x += ch0 * W * 0.5 etc.; the port feeds pointer pixels directly. Clamp (0x531a4c..0x531a40).
      let x = this.pointer.x + input.dx;
      let y = this.pointer.y + input.dy;
      const xl = Math.fround(W * POINTER_LIMITS.left);
      const xr = W - Math.fround(W * POINTER_LIMITS.right);
      const yt = Math.fround(H * POINTER_LIMITS.top);
      const yb = H - Math.fround(H * POINTER_LIMITS.bottom);
      x = x < xl ? xl : x > xr ? xr : x;
      y = y < yt ? yt : y > yb ? yb : y;
      this.pointer.x = x;
      this.pointer.y = y;
    }
    const buttons = (input.left ? COMPUTER_BUTTON.left : 0) | (input.right ? COMPUTER_BUTTON.right : 0);
    this.pressed = ~this.buttons & buttons;
    this.buttons = buttons;
    this.items.setPointer(x87Fistp(this.pointer.x), x87Fistp(this.pointer.y), buttons);
    this.lastInput = input;
    // Page update: children (ComputerObject, LineFilter, MenuItemTask, ComputerStartup), then the page itself.
    this.items.update();
    if (this.page === PAGE.map) {
      this.tickStartup();
      this.mapInput(input);
      this.followGround();
      this.tickNoise();
    }
  }

  private lastInput: ComputerInput | null = null;

  // ----------------------------------------------------------- markers ----

  /** Project an engine point (FUN_00466130): screen x, y and depth (metres), or null behind the camera. */
  project(p: Vec3): { x: number; y: number; depth: number } | null {
    const c = this.map.camera;
    const depth = c[1] - p[1];
    if (!(depth > 0)) return null;
    const f = (W * 0.5) / (depth * this.map.tan);
    return { x: f * (p[0] - c[0]) + W * 0.5, y: f * (p[2] - c[2]) + H * 0.5, depth };
  }

  /** The ComputerObject draw (FUN_004664f0) as a list of markers in draw order. */
  markers(): MapMarker[] {
    const out: MapMarker[] = [];
    if (this.page !== PAGE.map) return out;
    const flags = this.map.markerFlags;
    const world = this.env.world;
    const shape = (pos: Vec3, yaw: number, size: number | undefined, shapeIndex: number, colour: number) => {
      const pr = this.project(pos);
      if (!pr) return;
      const s = Math.max(size ?? 0, MAP_MARKER_MIN_SIZE_M);
      // FUN_004962b0: pixels = size x (W/2)/tan / depth.
      const k = (s * (W * 0.5)) / (this.map.tan * pr.depth);
      // FUN_004a9f30 yaw of the object's matrix; the marker is rotated by -yaw.
      out.push({ kind: "shape", shape: shapeIndex, colour, x: pr.x, y: pr.y, angle: -yaw, sx: k, sy: k });
    };
    if (flags & MARKERS.humans) {
      // FUN_004136d0 (player): shape 2, colour 3, at every zoom.
      const player = world.player();
      if (player) shape(player.position, player.yaw, player.size, 2, 3);
      // FUN_0045eef0 (soldiers): zoom 1 and 2 only, alive and visible from the camera; team 0/2 colour 3, else red.
      if (this.zoom !== 0 && this.zoom !== 3) {
        for (const s of world.soldiers()) {
          if (!s.alive) continue;
          const c = this.map.camera;
          if (world.lineOfSight && !world.lineOfSight([c[0], c[1], c[2]], s.position)) continue;
          shape(s.position, s.yaw, s.size, 1, s.team === 0 || s.team === 2 ? 3 : 0);
        }
      }
    }
    if (flags & MARKERS.hilights) {
      // FUN_00467310 -> the linked task's handler (0x446ad0): sprite, marker shape, title / info text.
      for (const h of world.hilights()) {
        const pr = this.project(h.position);
        if (!pr) continue;
        if (h.sprite) out.push({ kind: "sprite", sprite: h.sprite, frame: 0, x: pr.x, y: pr.y });
        if (h.marker >= 0 && h.markerColour >= 0) shape(h.position, 0, h.size, h.marker, h.markerColour);
        const text = this.zoom === 1 ? h.title : this.zoom > 1 ? h.info : null;
        if (text) out.push({ kind: "text", text, x: x87Fistp(pr.x), y: x87Fistp(pr.y) });
      }
    }
    if ((flags & MARKERS.cameras) && this.zoom > 0) {
      // FUN_00441e40: h_scamera1.spr, or h_scamera2.spr at the rotation frame.
      for (const c of world.cameras()) {
        if (c.disabled) continue;
        const pr = this.project(c.position);
        if (!pr) continue;
        const rotating = c.rotatingFrame !== undefined && c.rotatingFrame !== null;
        out.push({ kind: "sprite", sprite: rotating ? "h_scamera2.spr" : "h_scamera1.spr", frame: rotating ? c.rotatingFrame! : 0, x: pr.x, y: pr.y });
      }
    }
    return out;
  }
}

/** fptan of the float32 zoom angle, stored as float32 (+0x70). */
export function mapTan(zoom: number): number {
  return Math.fround(Math.tan(MAP_ZOOM_ANGLES[Math.max(0, Math.min(MAP_MAX_ZOOM, zoom))]));
}

/**
 * FUN_00467fe0: word-by-word text layout used by the log, the objectives and
 * the map labels. Words keep their trailing space; a word goes on the current
 * line when its full pen advance (FUN_004ad2e0) is smaller than the room left,
 * otherwise the pen returns to x and moves down one line height. Returns the
 * placed words and the y below the last line.
 */
export function layoutComputerText(text: string, x: number, y: number, wrap: number,
  advance: (word: string) => number, lineHeight: number): { words: Array<{ text: string; x: number; y: number }>; bottom: number } {
  const words: Array<{ text: string; x: number; y: number }> = [];
  let room = wrap;
  let penX = x;
  let penY = y;
  let i = 0;
  for (;;) {
    let word = "";
    let last = false;
    for (;;) {
      if (i >= text.length) {
        last = true;
        break;
      }
      const c = text[i++];
      word += c;
      if (c === " ") break;
    }
    const w = advance(word);
    if (w < room) room -= w;
    else {
      penX = x;
      penY += lineHeight;
      room = wrap - w;
    }
    words.push({ text: word, x: penX, y: penY });
    penX += w;
    if (last) return { words, bottom: penY + lineHeight };
  }
}
