/**
 * Keyboard + mouse input with pointer-lock mouse-look, bound to the
 * original's named actions.
 *
 * Recovered/observed: igi.exe reads its controls from config.qvm
 * (GOInRemap(action, device, key), e.g. MoveUp = KEY_UP, Crouch =
 * KEY_RIGHT_CTRL, Jump = KEY_NUMPAD0, Fire = MOUSE_BUTTON_1, NextWeapon =
 * MOUSE_BUTTON_2, ToggleWalkRun = KEY_W). The port uses exactly the bindings
 * in the player's own config.qvm (IgiLevel.controls). `?keys=wasd` swaps in
 * a modern layout for players who prefer it (port option, not original).
 *
 * Inferred: the mapping of IGI KEY_* names to browser KeyboardEvent.code
 * values (by name); mouse look sensitivity (GOInMouSens is read but its scale
 * is not recovered).
 *
 * The Input owns no game state; it records key/mouse state that game ticks
 * read. Presses are latched until a game tick consumes them (endFrame()).
 */

/** One GOInRemap binding (config.qvm). */
export interface ControlBinding {
  action: string;
  device: string;
  key: string;
}

/** IGI KEY_* / MOUSE_BUTTON_* names -> browser codes ("Mouse0" = left button, "Mouse2" = right). */
const KEY_CODES: Record<string, string> = {
  KEY_LEFT: "ArrowLeft",
  KEY_RIGHT: "ArrowRight",
  KEY_UP: "ArrowUp",
  KEY_DOWN: "ArrowDown",
  KEY_RETURN: "Enter",
  KEY_SPACE: "Space",
  KEY_BACKSPACE: "Backspace",
  KEY_TAB: "Tab",
  KEY_ESCAPE: "Escape",
  KEY_RIGHT_SHIFT: "ShiftRight",
  KEY_LEFT_SHIFT: "ShiftLeft",
  KEY_RIGHT_CTRL: "ControlRight",
  KEY_LEFT_CTRL: "ControlLeft",
  KEY_RIGHT_ALT: "AltRight",
  KEY_LEFT_ALT: "AltLeft",
  KEY_PAGEUP: "PageUp",
  KEY_PAGEDOWN: "PageDown",
  KEY_HOME: "Home",
  KEY_END: "End",
  KEY_INSERT: "Insert",
  KEY_DELETE: "Delete",
  MOUSE_BUTTON_1: "Mouse0",
  MOUSE_BUTTON_2: "Mouse2",
  MOUSE_BUTTON_3: "Mouse1",
  // The key table's wheel bits 0x100 / 0x200 (docs/hud.md 11.2).
  MOUSE_WHEEL_UP: "WheelUp",
  MOUSE_WHEEL_DOWN: "WheelDown",
};

/** Browser code for an IGI KEY_* / MOUSE_BUTTON_* name (null if unknown). */
export function codeFor(key: string): string | null {
  if (KEY_CODES[key]) return KEY_CODES[key];
  let m = /^KEY_([A-Z])$/.exec(key);
  if (m) return `Key${m[1]}`;
  m = /^KEY_([0-9])$/.exec(key);
  if (m) return `Digit${m[1]}`;
  m = /^KEY_NUMPAD([0-9])$/.exec(key);
  if (m) return `Numpad${m[1]}`;
  m = /^KEY_F([0-9]{1,2})$/.exec(key);
  if (m) return `F${m[1]}`;
  return null;
}

/** The shipped config.qvm bindings (used until the player's own config is loaded) [observed]. */
export const ORIGINAL_BINDINGS: ControlBinding[] = [
  ["MoveLeft", "KEY_LEFT"], ["MoveRight", "KEY_RIGHT"], ["MoveUp", "KEY_UP"], ["MoveDown", "KEY_DOWN"],
  ["Fire", "MOUSE_BUTTON_1"], ["Reload", "KEY_RETURN"], ["Activate", "KEY_RIGHT_SHIFT"], ["Crouch", "KEY_RIGHT_CTRL"],
  ["Jump", "KEY_NUMPAD0"], ["NextWeapon", "MOUSE_BUTTON_2"], ["PrevWeapon", "KEY_O"], ["AlternateFire", "KEY_BACKSPACE"],
  ["Peek", "KEY_NUMPAD1"], ["Binoculars", "KEY_SPACE"], ["MapComputer", "KEY_C"], ["ToggleWalkRun", "KEY_W"],
  ["ZoomIn", "KEY_PAGEUP"], ["ZoomOut", "KEY_PAGEDOWN"],
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`WeaponCategory${n}`, `KEY_${n}`] as [string, string]),
].map(([action, key]) => ({ action, device: key.startsWith("MOUSE") ? "INPUTPORT_DEVICE_MOUSE" : "INPUTPORT_DEVICE_KEYBOARD", key }));

/** `?keys=wasd`: a modern layout (port option). */
const WASD: Record<string, string[]> = {
  MoveUp: ["KeyW"], MoveDown: ["KeyS"], MoveLeft: ["KeyA"], MoveRight: ["KeyD"], Fire: ["Mouse0"], Reload: ["KeyR"],
  Activate: ["KeyE"], Crouch: ["KeyC"], Jump: ["Space"], NextWeapon: ["Mouse2", "KeyQ"], PrevWeapon: ["KeyZ"],
  AlternateFire: ["KeyF"], Peek: ["KeyX"], Binoculars: ["KeyB"], MapComputer: ["KeyM"], ToggleWalkRun: ["ShiftLeft"],
  ZoomIn: ["PageUp", "WheelUp"], ZoomOut: ["PageDown", "WheelDown"],
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`WeaponCategory${n}`, [`Digit${n}`]])),
};

/** The added WASD movement keys (port addition, see Input.setBindings). */
const WASD_MOVE: ReadonlyArray<readonly [string, string]> = [
  ["MoveUp", "KeyW"],
  ["MoveDown", "KeyS"],
  ["MoveLeft", "KeyA"],
  ["MoveRight", "KeyD"],
];

/** Further port additions, each only while the profile leaves the input unbound: R reloads, the middle button scopes. */
const EXTRA_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["Reload", "KeyR"],
  ["AlternateFire", "Mouse1"],
];

/** Ticks a wheel notch holds its key (port addition: one tick per notch would be a 4 % zoom step). */
const WHEEL_TICKS_PER_NOTCH = 6;
/** At most this many ticks are queued, so turning the wheel back answers at once. */
const WHEEL_TICKS_MAX = 2 * WHEEL_TICKS_PER_NOTCH;
/** One notch of a mouse wheel in WheelEvent pixels (Chrome / Firefox report 100 / 3 lines). */
const WHEEL_NOTCH_PX = 100;

function addWasd(map: Map<string, string[]>): void {
  // The mouse wheel zooms (binoculars, Dragunov scope) unless the profile binds it to something else.
  const wheelBound = [...map.values()].some((codes) => codes.includes("WheelUp") || codes.includes("WheelDown"));
  if (!wheelBound) {
    map.set("ZoomIn", [...(map.get("ZoomIn") ?? []), "WheelUp"]);
    map.set("ZoomOut", [...(map.get("ZoomOut") ?? []), "WheelDown"]);
  }
  const owner = (code: string): string | null => {
    for (const [action, codes] of map) if (codes.includes(code)) return action;
    return null;
  };
  for (const [action, code] of WASD_MOVE) {
    const other = owner(code);
    if (other === action) continue;
    if (other === "ToggleWalkRun" && code === "KeyW" && owner("CapsLock") === null) {
      map.set(other, (map.get(other) ?? []).filter((c) => c !== code).concat("CapsLock"));
    } else if (other !== null) {
      continue;
    }
    map.set(action, [...(map.get(action) ?? []), code]);
  }
  for (const [action, code] of EXTRA_KEYS) {
    if (owner(code) === null) map.set(action, [...(map.get(action) ?? []), code]);
  }
}

export class Input {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  /** action -> codes */
  private bindings = new Map<string, string[]>();
  private mouseDX = 0;
  private mouseDY = 0;
  private locked = false;
  private readonly canvas: HTMLElement;
  private readonly listeners: Array<() => void> = [];
  private readonly modern = new URLSearchParams(location.search).get("keys") === "wasd";
  /** Remaining hold ticks of the wheel's virtual keys. */
  private readonly wheelTicks: Record<string, number> = {};
  /** ?keys=original: only the profile's bindings (no added WASD movement). */
  private readonly originalOnly = new URLSearchParams(location.search).get("keys") === "original";

  /**
   * Port option (?look=normal): un-invert the vertical look. igi.exe's look is
   * inverted and reads no invert setting (engine/look.ts).
   */
  /** The look is not negated (config +0x538 = 0, the shipped default); game.ts applies the profile. */
  lookInverted = new URLSearchParams(location.search).get("look") !== "normal";

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;
    this.setBindings(ORIGINAL_BINDINGS);

    const press = (code: string) => {
      if (!this.down.has(code)) this.pressed.add(code);
      this.down.add(code);
    };
    const release = (code: string) => this.down.delete(code);
    const onKeyDown = (e: KeyboardEvent) => {
      // Keep browser shortcuts (Ctrl+R, Ctrl+Shift+I...) usable unless the key is itself a bound modifier.
      const boundModifier = e.code === "ControlRight" || e.code === "ControlLeft" || e.code === "ShiftRight" || e.code === "ShiftLeft";
      if ((e.metaKey || e.altKey || e.ctrlKey) && !boundModifier && !this.locked) return;
      press(e.code);
      if (this.locked || e.code === "Space" || e.code.startsWith("Arrow") || e.code === "Backspace" || e.code === "Tab" || e.code === "PageUp" || e.code === "PageDown") {
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => release(e.code);
    const onMouseMove = (e: MouseEvent) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    };
    const onMouseDown = (e: MouseEvent) => {
      // The click that captures the pointer must not also act.
      if (!this.locked) return;
      // The middle button would start the browser's autoscroll.
      if (e.button === 1) e.preventDefault();
      press(`Mouse${e.button}`);
    };
    const onMouseUp = (e: MouseEvent) => release(`Mouse${e.button}`);
    const onContextMenu = (e: MouseEvent) => {
      if (this.locked) e.preventDefault();
    };
    const onPointerLockChange = () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.down.clear();
    };
    const onWheel = (e: WheelEvent) => {
      if (!this.locked) return;
      e.preventDefault();
      if (e.deltaY === 0) return;
      const px = e.deltaMode === 1 ? e.deltaY * (WHEEL_NOTCH_PX / 3) : e.deltaMode === 2 ? e.deltaY * 8 * WHEEL_NOTCH_PX : e.deltaY;
      const key = px < 0 ? "WheelUp" : "WheelDown";
      const other = px < 0 ? "WheelDown" : "WheelUp";
      // Turning the wheel the other way ends the opposite zoom at once.
      if ((this.wheelTicks[other] ?? 0) > 0) {
        this.wheelTicks[other] = 0;
        this.down.delete(other);
      }
      // Smooth-scrolling wheels and touchpads send many small deltas: they count in proportion.
      const ticks = (Math.abs(px) / WHEEL_NOTCH_PX) * WHEEL_TICKS_PER_NOTCH;
      this.wheelTicks[key] = Math.min(WHEEL_TICKS_MAX, Math.max(1, (this.wheelTicks[key] ?? 0) + ticks));
      press(key);
    };
    const onBlur = () => this.down.clear();

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("pointerlockchange", onPointerLockChange);
    window.addEventListener("blur", onBlur);
    window.addEventListener("wheel", onWheel, { passive: false });
    this.listeners.push(
      () => window.removeEventListener("keydown", onKeyDown),
      () => window.removeEventListener("keyup", onKeyUp),
      () => window.removeEventListener("mousemove", onMouseMove),
      () => window.removeEventListener("mousedown", onMouseDown),
      () => window.removeEventListener("mouseup", onMouseUp),
      () => window.removeEventListener("contextmenu", onContextMenu),
      () => document.removeEventListener("pointerlockchange", onPointerLockChange),
      () => window.removeEventListener("blur", onBlur),
      () => window.removeEventListener("wheel", onWheel),
    );
  }

  /**
   * Use the player's config.qvm bindings (unknown keys are skipped). Port additions (not original),
   * unless ?keys=original: W / A / S / D move as well as the configured keys (a WASD key the
   * profile binds to something else keeps that binding, except the shipped W = ToggleWalkRun,
   * which moves to Caps Lock so that W can walk forward); the wheel zooms; R reloads and the
   * middle mouse button is AlternateFire (scope) while the profile leaves them unbound.
   */
  setBindings(list: readonly ControlBinding[]): void {
    const map = new Map<string, string[]>();
    if (this.modern) {
      for (const [action, codes] of Object.entries(WASD)) map.set(action, codes);
    } else {
      for (const b of list) {
        const code = codeFor(b.key);
        if (!code) continue;
        map.set(b.action, [...(map.get(b.action) ?? []), code]);
      }
      if (!this.originalOnly) addWasd(map);
    }
    this.bindings = map;
  }

  /** Codes bound to `action` (for on-screen help). */
  codesFor(action: string): readonly string[] {
    return this.bindings.get(action) ?? [];
  }

  /** True while any key/button bound to `action` is held. */
  action(action: string): boolean {
    for (const code of this.bindings.get(action) ?? []) if (this.down.has(code)) return true;
    return false;
  }

  /** True once after any key/button bound to `action` went down (until endFrame()). */
  actionPressed(action: string): boolean {
    for (const code of this.bindings.get(action) ?? []) if (this.pressed.has(code)) return true;
    return false;
  }

  /** True while a raw key code is held. */
  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** True once after a raw key code went down. */
  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  /** Forward axis: MoveUp (+1) / MoveDown (-1). */
  get forward(): number {
    return (this.action("MoveUp") ? 1 : 0) - (this.action("MoveDown") ? 1 : 0);
  }

  /** Strafe axis: MoveRight (+1) / MoveLeft (-1). */
  get strafe(): number {
    return (this.action("MoveRight") ? 1 : 0) - (this.action("MoveLeft") ? 1 : 0);
  }

  /** True while the Fire action is held. */
  get isFiring(): boolean {
    return this.action("Fire");
  }

  get isLocked(): boolean {
    return this.locked;
  }

  /**
   * Request pointer lock (must be called from a user gesture). The outcome
   * arrives as "pointerlockchange" / "pointerlockerror"; promise rejections
   * are handled here.
   */
  requestLock(): void {
    try {
      const result = this.canvas.requestPointerLock?.() as unknown;
      if (result instanceof Promise) result.catch(() => {});
    } catch {
      // Older engines throw synchronously; "pointerlockerror" still fires.
    }
  }

  exitLock(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  /** Automation (?test): hold or release a raw key code (or "Mouse0"). */
  setKey(code: string, down: boolean): void {
    if (down) {
      if (!this.down.has(code)) this.pressed.add(code);
      this.down.add(code);
    } else {
      this.down.delete(code);
    }
  }

  /** Automation (?test): hold or release every key bound to an action. */
  setAction(action: string, down: boolean): void {
    for (const code of this.bindings.get(action) ?? []) this.setKey(code, down);
  }

  /** Automation (?test): hold or release the Fire action. */
  setFiring(down: boolean): void {
    this.setAction("Fire", down);
  }

  /**
   * Read and clear the mouse motion since the last call as [dx, dy] counts
   * (movementX / movementY: right / down positive, like DirectInput lX / lY).
   * The game turns the view from these once per tick (engine/look.ts).
   */
  consumeMouse(): [number, number] {
    const out: [number, number] = [this.mouseDX, this.mouseDY];
    this.mouseDX = 0;
    this.mouseDY = 0;
    return out;
  }

  /** Clear latched presses; call after a game tick has read them. */
  endFrame(): void {
    this.pressed.clear();
    // A wheel notch holds its key for WHEEL_TICKS_PER_NOTCH ticks.
    for (const key of ["WheelUp", "WheelDown"]) {
      const left = this.wheelTicks[key] ?? 0;
      if (left <= 0) continue;
      this.wheelTicks[key] = left - 1;
      if (left - 1 <= 0) {
        this.wheelTicks[key] = 0;
        this.down.delete(key);
      }
    }
  }

  dispose(): void {
    for (const off of this.listeners) off();
    this.listeners.length = 0;
    this.down.clear();
  }
}
