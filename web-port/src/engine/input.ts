/**
 * Keyboard + mouse input with pointer-lock mouse-look.
 *
 * Confidence: inferred — IGI is a keyboard/mouse FPS; the concrete key binds and
 * any controller/gamepad support in the original are not recovered here. This
 * is a conventional WASD + mouse-look layout chosen for the web port.
 *
 * The Input owns no game state; it only records edge/level input that the
 * player controller reads each frame.
 */

export class Input {
  private readonly down = new Set<string>();
  private readonly pressedThisFrame = new Set<string>();

  /** Accumulated mouse movement (pixels) since the last read; consumed by read. */
  private mouseDX = 0;
  private mouseDY = 0;

  private firing = false;
  private locked = false;

  private readonly canvas: HTMLElement;
  private readonly listeners: Array<() => void> = [];

  /** Mouse-look sensitivity multiplier (radians per pixel). */
  lookSpeed = 0.0022;

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;

    const onKeyDown = (e: KeyboardEvent) => {
      // Avoid stealing browser shortcuts with modifiers (refresh, devtools...).
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!this.down.has(e.code)) this.pressedThisFrame.add(e.code);
      this.down.add(e.code);
      // Space/arrows would scroll the page; we own the viewport.
      if (
        e.code === "Space" ||
        e.code.startsWith("Arrow")
      ) {
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      this.down.delete(e.code);
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    };
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 0) this.firing = true;
    };
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 0) this.firing = false;
    };
    const onPointerLockChange = () => {
      this.locked = document.pointerLockElement === this.canvas;
    };
    const onBlur = () => {
      this.down.clear();
      this.firing = false;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);
    document.addEventListener("pointerlockchange", onPointerLockChange);
    window.addEventListener("blur", onBlur);

    this.listeners.push(
      () => window.removeEventListener("keydown", onKeyDown),
      () => window.removeEventListener("keyup", onKeyUp),
      () => window.removeEventListener("mousemove", onMouseMove),
      () => window.removeEventListener("mousedown", onMouseDown),
      () => window.removeEventListener("mouseup", onMouseUp),
      () => document.removeEventListener("pointerlockchange", onPointerLockChange),
      () => window.removeEventListener("blur", onBlur),
    );
  }

  /** True while a key is held. */
  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** True only on the frame a key transitioned to down. */
  wasPressed(code: string): boolean {
    return this.pressedThisFrame.has(code);
  }

  /** Movement axis in [-1, 1]: +1 forward (W), -1 back (S). */
  get forward(): number {
    return (this.isDown("KeyW") ? 1 : 0) - (this.isDown("KeyS") ? 1 : 0);
  }

  /** Strafe axis in [-1, 1]: +1 right (D), -1 left (A). */
  get strafe(): number {
    return (this.isDown("KeyD") ? 1 : 0) - (this.isDown("KeyA") ? 1 : 0);
  }

  get run(): boolean {
    return this.isDown("ShiftLeft") || this.isDown("ShiftRight");
  }

  get crouch(): boolean {
    return this.isDown("ControlLeft") || this.isDown("ControlRight") || this.isDown("KeyC");
  }

  get jump(): boolean {
    return this.isDown("Space");
  }

  /** True while the primary mouse button is held. */
  get isFiring(): boolean {
    return this.firing;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  /** Request pointer lock (must be called from a user gesture the first time). */
  requestLock(): void {
    void this.canvas.requestPointerLock?.();
  }

  /** Release pointer lock. */
  exitLock(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  /**
   * Read and clear the accumulated mouse delta as yaw/pitch radians.
   * @returns [yawRadians (right positive), pitchRadians (up positive)].
   */
  consumeLook(): [number, number] {
    const yaw = -this.mouseDX * this.lookSpeed;
    const pitch = -this.mouseDY * this.lookSpeed;
    this.mouseDX = 0;
    this.mouseDY = 0;
    return [yaw, pitch];
  }

  /** Clear per-frame edge state. Call once at the end of each frame. */
  endFrame(): void {
    this.pressedThisFrame.clear();
  }

  /** Detach every listener (teardown / tests). */
  dispose(): void {
    for (const off of this.listeners) off();
    this.listeners.length = 0;
    this.down.clear();
  }
}
