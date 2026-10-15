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
  ZoomIn: ["PageUp"], ZoomOut: ["PageDown"],
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`WeaponCategory${n}`, [`Digit${n}`]])),
};

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
      if (this.locked || e.code === "Space" || e.code.startsWith("Arrow") || e.code === "Backspace" || e.code === "Tab") {
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
      if (this.locked) press(`Mouse${e.button}`);
    };
    const onMouseUp = (e: MouseEvent) => release(`Mouse${e.button}`);
    const onContextMenu = (e: MouseEvent) => {
      if (this.locked) e.preventDefault();
    };
    const onPointerLockChange = () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.down.clear();
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
    this.listeners.push(
      () => window.removeEventListener("keydown", onKeyDown),
      () => window.removeEventListener("keyup", onKeyUp),
      () => window.removeEventListener("mousemove", onMouseMove),
      () => window.removeEventListener("mousedown", onMouseDown),
      () => window.removeEventListener("mouseup", onMouseUp),
      () => window.removeEventListener("contextmenu", onContextMenu),
      () => document.removeEventListener("pointerlockchange", onPointerLockChange),
      () => window.removeEventListener("blur", onBlur),
    );
  }

  /** Use the player's config.qvm bindings (unknown keys are skipped). */
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
  }

  dispose(): void {
    for (const off of this.listeners) off();
    this.listeners.length = 0;
    this.down.clear();
  }
}
