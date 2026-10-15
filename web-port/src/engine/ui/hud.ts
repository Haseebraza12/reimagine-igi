/**
 * The interface of Project I.G.I. in the browser: in-game HUD (StatusScreen),
 * radio messages and cut-scene subtitles (StatusMessageScreen), damage tint and
 * flash-bang, the loading screen, the main menu (mainmenu.qvm) with its
 * sub-screens and widgets (menu-widgets.ts, settings in menu-config.ts), the
 * in-game "Game Paused" menu (ingamemenu.qvm), the map computer (computer.ts),
 * plus the mission failed / complete flows. Everything is drawn from the user's original files
 * into a 640x480 canvas laid over the 4:3 game frame (ctx.frame), scaled with
 * nearest-neighbour sampling (the original runs GOGfxDisp(640, 480, 32)).
 *
 * Evidence: docs/hud.md; recovered details beyond it are documented in
 * hud-state.ts, radio.ts, menu-model.ts, menu-draw.ts, bgfx.ts.
 *
 * Wiring (game.ts):
 *   const hud = createHud(ctx, { source: raw, callbacks: { ... } });
 *   await hud.ready;                     // UI files decoded (rejects naming a missing file)
 *   hud.showMainMenu();                  // Flow 3 (the intro movies are not reproduced)
 *   per 30 Hz step (always, also when paused / in menus):  hud.tick(worldRunning);
 *   per rendered frame, after the 3D render:              hud.draw();
 *   level load:   hud.showLoading(i, 9) ... hud.hideLoading(); hud.startMission();
 *   pause:        hud.openPauseMenu()    (Esc / pointer-lock loss while playing)
 *   failure:      hud.missionFailed({ playerDead })
 *   success:      hud.missionComplete()
 *   map computer: hud.openMapComputer() / hud.closeMapComputer() on the MapComputer action;
 *                 render the world with hud.mapComputerView() while it is non-null
 *   settings:     hud.settings.snapshot() + callbacks.onSettingsChanged (input / audio)
 *   binoculars:   hud.setBinocularTargets(list) per frame while zoomed; M16: hud.setM203Rounds(n)
 *
 * The non-original #overlay text (showOverlay) is kept only for port-level
 * errors such as missing game files.
 */
import type { IAssetSource } from "../../contracts";
import { createHttpAssetSource, type UiFont } from "../../loaders";
import type { GameContext } from "../context";
import { GameEvent, type StatusMessagePayload } from "../events";
import { loadUiAssets, type UiAssets, type WeaponHudInfo } from "./assets";
import { BackgroundFx } from "./bgfx";
import { submitHud, submitStatusMessages, type HudResources, type HudView } from "./hud-draw";
import { ActionPulse, DamageTint, FlashBang, type HitDirection } from "./hud-state";
import { submitMenu, type MenuDrawResources } from "./menu-draw";
import { MENU_KEY_BY_CODE, MENU_MODE, MenuManager, type MenuEnvironment } from "./menu-model";
import { CanvasPainter, PrimList, VH, VW } from "./painter";
import { normalisePortrait, StatusMessageScreen } from "./radio";
import { submitLoading } from "./loading";
import { BinocularBars, type ScopeView } from "./scope";
import { BinocularTargets, type BinocularTargetInput } from "./binocular-targets";
import { ComputerLog, MapComputer, type ComputerInput, type MapComputerView } from "./computer";
import { COMPUTER_MULTIPLY_RGB, computerNeedsMultiply, drawComputer, type ComputerDrawResources } from "./computer-draw";
import { createComputerWorld } from "./computer-world";
import { CONTROL_KEYS, MenuConfig, type MenuSettingsSnapshot, type SettingsChange } from "./menu-config";
import type { TypewriterEntry } from "./menu-widgets";
import { codeFor } from "../input";

export interface HudCallbacks {
  /**
   * A menu sound by name (menusystem/SOUND/sounds.res): "menu_high" (selection
   * moved), "menu_sel" (item clicked), "menu_sel2" (list row), "menu_ok",
   * "menu_cancel" (Click Sound Resource of OK/Cancel/Yes/No items).
   */
  onSound?(name: string): void;
  /** Select Mission -> OK / double click, after the menu faded out (Flow 4). Show the loading screen now. */
  onStartMission?(missionId: number): void;
  /** Pause menu left with Resume Game / Esc, after its fade-out: unpause. */
  onResume?(): void;
  /** Pause menu -> Restart Mission -> Yes, after the fade-out (Flow 5: loading screen with 5 steps). */
  onRestart?(): void;
  /**
   * The mission ends and the main menu follows: "quit" = Quit to Main Menu -> Yes
   * (Flow 6), "complete" = the mission-complete hand-over finished (Flow 7).
   * The HUD shows the main menu right after this call.
   */
  onQuit?(reason: "quit" | "complete"): void;
  /** Main menu -> Quit -> Yes (MENUMANAGER_QUIT). */
  onExit?(): void;
  /** The pause menu opened (Esc, mission-failed flow): stop simulating. */
  onPause?(): void;
  /**
   * Called synchronously inside the user's click / key press that will leave
   * the menus into play (Start, Resume, Restart), so pointer lock can be
   * requested within the user gesture.
   */
  requestLock?(): void;
  /** A menu opened and needs the mouse pointer: release pointer lock. */
  releaseLock?(): void;
  /**
   * A 2-D game sound by definition name at volume 1 (FUN_004dddc0), used by the
   * map computer: "mapcomp_01" (zoom button click), "mapcomp_05" + "mapcomp_03"
   * (zoom changed; the exe plays both, mapcomp_05 has no sample in level 1).
   * Wire to IgiAudioSystem.play2D(name) (or mapZoom() for the 05 + 03 pair).
   */
  onGameSound?(name: string): void;
  /**
   * A menu setting changed (Config_* setters, Game_UpdateVolume, Controls OK,
   * a new / deleted / selected profile). `what` tells which group; the snapshot
   * holds every value (see Hud.settings for what each one drives).
   */
  onSettingsChanged?(settings: MenuSettingsSnapshot, what: SettingsChange): void;
  /**
   * The main menu sat idle for 3600 logic ticks (60 s at its 60 Hz): the exe
   * deletes the menu and requests Flow 8, which plays eidos.avi + innerloop.avi
   * in a loop until Esc, then Flow 3 (main menu). The HUD has left the menu
   * when this is called; call showMainMenu() when the attract sequence ends
   * (the port cannot decode the IV50 movies). Without this callback the menu stays.
   */
  onAttract?(): boolean | void;
}

export interface HudOptions {
  /** Where the original files are read from (default createHttpAssetSource("/raw/")). */
  source?: IAssetSource;
  callbacks?: HudCallbacks;
  /** Element the 640x480 UI canvas is appended to (default #hud, else <body>). */
  container?: HTMLElement | null;
  /** Windows country "USA": loading_us.pic and logo_us.pic. */
  usa?: boolean;
  /** Random source for the hit tint (default Math.random). */
  random?: () => number;
  /**
   * Apply the hit tint on every PlayerHit (default true). game.ts turns it off and drives the tint
   * itself (hit / setTintCorners) so the level-RNG draws keep the exe's order (shake, then tint).
   */
  autoHitTint?: boolean;
}

export interface Hud {
  /** Draw one frame (legacy name; same as draw()). `dt` drives ticks only while nobody calls tick(). */
  update(dt?: number): void;
  /** Show a radio-style message (legacy helper; prefer GameEvent.StatusMessage). */
  message(text: string, ttlSeconds?: number): void;
  /** Non-original text overlay for port-level errors (null hides it). */
  showOverlay(text: string | null): void;
  dispose(): void;

  /** Resolves once every UI file is decoded; rejects naming the first missing/bad file. */
  readonly ready: Promise<void>;
  load(): Promise<void>;
  /**
   * One 30 Hz step. Call it every step, also while paused or in menus: menus,
   * fades and the loading/complete flows always advance. The HUD timelines
   * (radio messages, damage tint, flash, action pulse) advance only when
   * `worldRunning` (default true) and the pause menu is not open, as the
   * original freezes them while the game is paused (FUN_00483af0).
   */
  tick(worldRunning?: boolean): void;
  /** Draw the UI for this frame (call after the 3D render). */
  draw(): void;

  showMainMenu(): void;
  /** Open "Game Paused" (screen 900) and pause, as Esc does in the original. No-op unless playing and idle. */
  openPauseMenu(): void;
  /** A menu (main or in-game) is on screen. */
  isMenuOpen(): boolean;
  /** The in-game menu has paused the game. */
  isPaused(): boolean;

  showLoading(stepsDone: number, totalSteps: number): void;
  hideLoading(): void;
  /** A mission (re)starts playing: clears messages, tint, flash and failure state; shows the in-game HUD. */
  startMission(): void;
  /**
   * LevelFlow failed: the pause menu opens after 151 ticks while the player
   * lives, or on Space / Return / Esc when dead; "Resume Game" is disabled.
   * `sendMessage`: also show messages.res MISSION_FAILED (only when the task
   * runtime does not send the level's own "Mission Failed!" StatusMessage).
   */
  missionFailed(options?: { playerDead?: boolean; sendMessage?: boolean }): void;
  /** LevelFlow complete: loading screen (1 step, empty bar), then onQuit("complete") and the main menu. */
  missionComplete(): void;

  /** Flash-bang in range: white-out value 2.0 (drawn at alpha min(v, 0.99), decays 1/90 then 1/60 per tick). */
  flashBang(value?: number): void;
  /** Add a hit tint by hand (PlayerHit events do this automatically). `direction` in the player's view frame. */
  hit(direction?: HitDirection | null): void;
  /** The shooter's position -> the hit direction in the player's view frame (for hit()). */
  hitDirectionFrom(from: [number, number, number]): HitDirection;
  /** Set the four tint corners (+0xdcc TL, +0xdd8 TR, +0xdd0 BL, +0xdd4 BR): melee and explosion hits. */
  setTintCorners(tl: number, tr: number, bl: number, br: number): void;
  /** Cut-scene running: the player HUD is hidden; messages stay. (CutsceneStart/End events do this too.) */
  setCutscene(active: boolean): void;
  /** StatusMessageScreen_ClearMessages() (task script function): remove every message. */
  clearMessages(): void;
  /** Use-target pictogram (status.res name, e.g. "a_door.spr") or null. */
  setActionIcon(name: string | null): void;
  /** Timed-action progress 0..1, or null to hide the bar. */
  setActionProgress(progress: number | null): void;
  /** "Time Left" interface timer in remaining ticks, or null (disabled). */
  setTimer(remainingTicks: number | null): void;
  /**
   * Zoomed view overlay, or null: binoculars ({ kind: "binoculars", yaw, rangeMetres })
   * or the Dragunov scope ({ kind: "sniper" }). Replaces the weapon panel while set.
   */
  setScope(scope: ScopeView | null): void;

  /**
   * Binocular target squares (FUN_00470510): every rendered frame while the
   * binoculars are zoomed, pass the humans in front of the zoomed camera
   * (frustum test, projection and eye line-of-sight done by the caller), or
   * null to clear. Drawn with the binocular overlay.
   */
  setBinocularTargets(targets: readonly BinocularTargetInput[] | null): void;
  /** GunM16A2: the AMMO_ID_M203 pool for the second counter, or null for other weapons. */
  setM203Rounds(rounds: number | null): void;

  /**
   * Map computer (the "Computer" object, FUN_0046a690). Call when the player
   * state enters the computer (MapComputer pressed, FUN_0040e470). The game
   * keeps running (not paused); the player HUD is hidden, radio messages stay.
   */
  openMapComputer(): void;
  /** MapComputer pressed again, or the state's forced exit (FUN_0040e4c0). */
  closeMapComputer(): void;
  isMapComputerOpen(): boolean;
  /** The player camera's view mode (1 first person, 3 attached / using, 5 dead): the player HUD is drawn only in mode 1. */
  setPlayerView(mode: number): void;
  /**
   * While open on the map page: the camera the world must be rendered with
   * (full 4:3 frame, looking straight down, 225 m above the ground under the
   * map centre). null = do not render the world (objectives / log pages are
   * opaque black, or the computer is closed).
   */
  mapComputerView(): MapComputerView | null;
  /** The map computer's radio log (last 50 radio texts; cleared with the messages). */
  readonly computerLog: ComputerLog;
  /**
   * The menus' profile configuration (config.qvm defaults, changed by the
   * Configuration / Sound / Controls / Select Player screens). snapshot():
   *   invertMouse / invertField   Controls "Invert Mouse" (GOInMouInv field: menu "Yes" = field 0)
   *   mouseSensitivity            Controls "Mouse Sensitivity" 0..1 (GOInMouSens; default 0.4)
   *   fxVolume                    Sound "FX Volume" 0..1: the DirectSound master scale (IgiAudioSystem.mixer.fxVolume)
   *   musicVolume                 Sound "Music Volume" 0..1: in igi.exe only the Windows CD mixer line (no in-game effect)
   *   bindings                    Controls key list (27 actions, GOInRemap form for Input.setBindings)
   *   difficulty / activeMission  the selected profile (GOGameDiff 0..2 / GOActiveMission)
   *   bloodEnabled                Content Control: the profile's blood flag (+0x8) read at every hit (effects.setBlood)
   *   gamma, performanceFlags     Graphics: gamma has no reader in igi.exe (no effect). The performance flags are applied at
   *                               level load (FUN_00405e50: 0x10 / 0x20 terrain threshold 0x60 / 0x81 else 0xa3, 0x40 / 0x80
   *                               FUN_004c5f30 scale 1.5 / 2.0, bits 1-8 other toggles); the port renders the shipped
   *                               GOGfxPerformance(0) and does not apply other choices yet
   */
  readonly settings: MenuConfig;
  /**
   * The Credits screen's TypeWriterBox script. It is compiled into igi.exe
   * (130 entries at VA 0x537cd8); pass the result of readExeCredits() run on
   * the user's own executable, or null. Without it the Credits box stays empty.
   */
  setCreditsScript(script: readonly TypewriterEntry[] | null): void;
}

/** The parts of GameContext the HUD reads. */
export type HudContext = Pick<GameContext, "events" | "player" | "weapon" | "level" | "frame" | "canvas" | "running">
  & Partial<Pick<GameContext, "enemies" | "world" | "systems" | "rng">>;

type Mode = "none" | "main" | "game";

/** Ticks the mission-complete loading screen stays up before the main menu (inferred: the hand-over time). */
const COMPLETE_HANDOVER_TICKS = 15;

export function createHud(ctx: HudContext, options: HudOptions = {}): Hud {
  const callbacks = options.callbacks ?? {};
  const random = options.random ?? Math.random;
  const usa = options.usa ?? false;
  const source = options.source ?? createHttpAssetSource("/raw/");
  const hasDom = typeof document !== "undefined";

  let assets: UiAssets | null = null;
  let disposed = false;
  let mode: Mode = "game";
  let loading: { done: number; total: number } | null = null;
  let completeCountdown = 0;
  let failed = false;
  let failedDead = false;
  let cutscene = false;
  let actionIcon: string | null = null;
  let progress: number | null = null;
  let playerViewMode = 1;
  let timer: number | null = null;
  let externalTicks = false;
  let tickAccumulator = 0;
  let legacyStatusAllowed = true;
  let activeMission = 1;
  let paused = false;
  let scope: ScopeView | null = null;
  const binocularBars = new BinocularBars();
  const binocularTargets = new BinocularTargets();
  let binocularCandidates: readonly BinocularTargetInput[] | null = null;
  let m203: number | null = null;
  const computerLog = new ComputerLog();
  const config = new MenuConfig();
  config.onChange = (what) => callbacks.onSettingsChanged?.(config.snapshot(), what);
  /** CONTROL_KEYS names held right now (the ControlsMenu reads key state, not the queue). */
  const heldKeys = new Set<string>();
  const keyByCode = new Map<string, string>();
  for (const k of CONTROL_KEYS) {
    const c = k === "KEY_ESC" ? "Escape" : codeFor(k);
    if (c && !c.startsWith("Mouse") && !keyByCode.has(c)) keyByCode.set(c, k);
  }
  let readmeText: string | null = null;
  let credits: TypewriterEntry[] | null = null;
  let computer: MapComputer | null = null;
  const computerInput: ComputerInput = { dx: 0, dy: 0, left: false, right: false, wheelUp: false, wheelDown: false };
  const computerWorld = createComputerWorld(ctx, { lookup: (key) => assets?.computerStrings.get(key.toLowerCase()) ?? null });

  const tint = new DamageTint();
  const flash = new FlashBang();
  const pulse = new ActionPulse();
  let fonts: { hud: UiFont; radio: UiFont; cutscene: UiFont } | null = null;
  const radio = new StatusMessageScreen(() => fonts?.radio ?? null, () => fonts?.cutscene ?? null, VW);
  /** FUN_004845c0: a radio (non-cut-scene) text that got a slot is also appended to the map computer log (FUN_00467960). */
  function sendRadio(input: Parameters<StatusMessageScreen["send"]>[0]): boolean {
    const ok = radio.send(input);
    if (ok && !input.cutscene) computerLog.add(input.text);
    return ok;
  }
  /** FUN_00483ad0: StatusMessageScreen_ClearMessages also clears the computer log (FUN_00467950). */
  function clearRadio(): void {
    radio.clear();
    computerLog.clear();
  }
  let mainMenu: MenuManager | null = null;
  let ingameMenu: MenuManager | null = null;
  let bgfx: BackgroundFx | null = null;

  // --- DOM ------------------------------------------------------------------
  const canvas: HTMLCanvasElement | null = hasDom ? (document.getElementById("igi-ui") as HTMLCanvasElement | null) ?? document.createElement("canvas") : null;
  let painter: CanvasPainter | null = null;
  if (canvas) {
    canvas.id = "igi-ui";
    canvas.width = VW;
    canvas.height = VH;
    if (!canvas.parentElement) (options.container ?? document.getElementById("hud") ?? document.body).appendChild(canvas);
    const g = canvas.getContext("2d");
    if (g) painter = new CanvasPainter(g);
  }
  const overlay = hasDom ? document.getElementById("overlay") : null;
  let lastRect = "";
  /**
   * The ComputerMenu's full-screen multiply (ZERO/SRCCOLOR by (0,253,0)/255) must
   * act on the WebGL frame below the 2-D canvas: a mix-blend-mode element in the
   * root stacking context, just below the HUD's container.
   */
  let multiplyLayer: HTMLDivElement | null = null;
  if (hasDom && canvas) {
    multiplyLayer = document.createElement("div");
    multiplyLayer.id = "igi-ui-multiply";
    const st = multiplyLayer.style;
    st.position = "fixed";
    st.pointerEvents = "none";
    st.display = "none";
    st.mixBlendMode = "multiply";
    st.background = `rgb(${COMPUTER_MULTIPLY_RGB[0]},${COMPUTER_MULTIPLY_RGB[1]},${COMPUTER_MULTIPLY_RGB[2]})`;
    let top: HTMLElement = canvas;
    while (top.parentElement && top.parentElement !== document.body) top = top.parentElement;
    if (top.parentElement === document.body) document.body.insertBefore(multiplyLayer, top);
    else document.body.appendChild(multiplyLayer);
  }
  let multiplyShown = false;
  function showMultiply(on: boolean): void {
    if (!multiplyLayer || on === multiplyShown) return;
    multiplyShown = on;
    multiplyLayer.style.display = on ? "block" : "none";
  }

  function syncCanvasRect(): void {
    if (!canvas) return;
    const frame = ctx.frame;
    let left = frame.x;
    let top = frame.y;
    if (ctx.canvas && typeof ctx.canvas.getBoundingClientRect === "function") {
      const r = ctx.canvas.getBoundingClientRect();
      left += r.left;
      top += r.top;
    }
    const key = `${left},${top},${frame.width},${frame.height}`;
    if (key === lastRect) return;
    lastRect = key;
    canvas.style.left = `${left}px`;
    canvas.style.top = `${top}px`;
    canvas.style.width = `${frame.width}px`;
    canvas.style.height = `${frame.height}px`;
    if (multiplyLayer) {
      const m = multiplyLayer.style;
      m.left = `${left}px`;
      m.top = `${top}px`;
      m.width = `${frame.width}px`;
      m.height = `${frame.height}px`;
    }
  }

  function activeMenu(): MenuManager | null {
    if (mode === "main" && mainMenu && mainMenu.isOpen) return mainMenu;
    if (mode === "game" && ingameMenu && ingameMenu.isOpen) return ingameMenu;
    return null;
  }

  let interactive: boolean | null = null;
  /** The UI canvas takes the mouse (and hides the OS cursor; pointer.spr is drawn instead) only while a menu is up. */
  function setInteractive(): void {
    if (!canvas) return;
    const on = activeMenu() !== null && !loading;
    if (on === interactive) return;
    interactive = on;
    canvas.style.pointerEvents = on ? "auto" : "none";
    canvas.style.cursor = on ? "none" : "";
  }

  const toVirtual = (e: { clientX: number; clientY: number }): [number, number] => {
    if (!canvas) return [0, 0];
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / Math.max(1, r.width)) * VW, ((e.clientY - r.top) / Math.max(1, r.height)) * VH];
  };

  const onPointerMove = (e: PointerEvent) => {
    const m = activeMenu();
    if (!m) return;
    const [x, y] = toVirtual(e);
    m.pointerMove(x, y);
  };
  const onPointerDown = (e: PointerEvent) => {
    const m = activeMenu();
    if (!m || e.button !== 0) return;
    const [x, y] = toVirtual(e);
    m.pointerMove(x, y);
    m.pointerButton(true);
    e.preventDefault();
  };
  const onPointerUp = (e: PointerEvent) => {
    const m = activeMenu();
    if (!m || e.button !== 0) return;
    const [x, y] = toVirtual(e);
    m.pointerMove(x, y);
    // Pointer lock must be requested inside the user gesture.
    if (m.releaseStartsPlay()) callbacks.requestLock?.();
    m.pointerButton(false);
    e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const k = keyByCode.get(e.code);
    if (k) heldKeys.delete(k);
  };
  const onMouseHeld = (e: MouseEvent) => {
    const k = e.button === 0 ? "MOUSE_BUTTON_1" : e.button === 2 ? "MOUSE_BUTTON_2" : e.button === 1 ? "MOUSE_BUTTON_3" : null;
    if (!k) return;
    if (e.type === "mousedown") heldKeys.add(k);
    else heldKeys.delete(k);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const held = keyByCode.get(e.code);
    if (held) heldKeys.add(held);
    if (!assets || loading) return;
    const m = activeMenu();
    if (m) {
      const code = MENU_KEY_BY_CODE[e.code];
      if (code === undefined) {
        // WM_CHAR: printable characters go into the menu key queue (InputBox).
        if (e.key.length === 1 && e.key.charCodeAt(0) < 256 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          m.key(e.key.charCodeAt(0));
          e.preventDefault();
        }
        return;
      }
      if (e.repeat && code !== MENU_KEY_BY_CODE.ArrowUp && code !== MENU_KEY_BY_CODE.ArrowDown) return;
      if (m.keyStartsPlay(code)) callbacks.requestLock?.();
      m.key(code);
      e.preventDefault();
      return;
    }
    if (mode === "game" && ingameMenu?.isIdle && ctx.level && !e.repeat) {
      if (e.code === "Escape") ingameMenu.idleKey("Escape");
      else if (failedDead || !ctx.player.alive) {
        if (e.code === "Space") ingameMenu.idleKey("Space");
        else if (e.code === "Enter" || e.code === "NumpadEnter") ingameMenu.idleKey("Enter");
      }
    }
  };
  // Map computer mouse: raw counts since the last tick (turned into the look channels at the tick), buttons, wheel.
  const pointerCounts = { x: 0, y: 0 };
  const onComputerMove = (e: MouseEvent) => {
    if (!computer) return;
    pointerCounts.x += e.movementX || 0;
    pointerCounts.y += e.movementY || 0;
  };
  /**
   * FUN_004697d0 reads the human's look channels (FUN_0045cde0: clamp(counts / 255, +-1) x
   * clamp(GOInMouSens, 0.05, 1), channel 1 negated by the invert flag, which the computer undoes):
   * x += ch0 x W x 0.5, y += ch1 x H x 0.5 per tick, in the 640 x 480 frame.
   */
  const pointerStep = () => {
    const sens = Math.min(1, Math.max(Math.fround(0.05), Math.fround(config.snapshot().mouseSensitivity)));
    const ch = (c: number) => Math.max(-1, Math.min(1, Math.fround(c * 0.00392156862745098)));
    computerInput.dx = Math.fround(ch(pointerCounts.x) * sens) * VW * 0.5;
    computerInput.dy = Math.fround(ch(pointerCounts.y) * sens) * VH * 0.5;
    pointerCounts.x = pointerCounts.y = 0;
  };
  const onComputerButton = (e: MouseEvent) => {
    if (!computer || activeMenu()) return;
    const down = e.type === "mousedown";
    if (e.button === 0) computerInput.left = down;
    else if (e.button === 2) computerInput.right = down;
  };
  const onComputerWheel = (e: WheelEvent) => {
    if (!computer || activeMenu()) return;
    if (e.deltaY < 0) computerInput.wheelUp = true;
    else if (e.deltaY > 0) computerInput.wheelDown = true;
  };
  if (hasDom) {
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousedown", onMouseHeld);
    window.addEventListener("mouseup", onMouseHeld);
    window.addEventListener("mousemove", onComputerMove);
    window.addEventListener("mousedown", onComputerButton);
    window.addEventListener("mouseup", onComputerButton);
    window.addEventListener("wheel", onComputerWheel, { passive: true });
  }
  if (canvas) {
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  }
  if (hasDom) window.addEventListener("keydown", onKeyDown);

  // --- strings ----------------------------------------------------------------
  const menuText = (key: string) => assets?.menuStrings.get(key.toLowerCase()) ?? `RM: ${key}`;
  /** A StatusMessage Text: a messages.res key (the task parameter) or already-resolved text. */
  function resolveMessage(text: string): string {
    const found = assets?.messages.get(text.toLowerCase());
    if (found !== undefined) return found;
    return /^[A-Za-z0-9_]+$/.test(text) && /[_0-9]/.test(text) ? `RM: ${text}` : text;
  }

  // --- menus ------------------------------------------------------------------
  function menuEnv(archiveOf: () => UiAssets["main"], main: boolean): MenuEnvironment {
    return {
      text: menuText,
      measure: (font, text) => {
        const f = archiveOf().fonts.get(font);
        if (!f) return null;
        return { w: measureLine(f, text), h: f.lineHeight };
      },
      picture: (name) => {
        const pic = archiveOf().pictures.get(name.toLowerCase());
        return pic ? { w: pic.width, h: pic.height } : null;
      },
      missions: () => (assets?.missions ?? []).filter((m) => m.id <= Math.max(1, activeMission)),
      activeMission: () => activeMission,
      levelFailed: () => failed,
      playerDead: () => failedDead || !ctx.player.alive,
      sound: (name) => callbacks.onSound?.(name),
      setMission: (id) => {
        activeMission = id;
      },
      leave: (leaveMode) => {
        if (main) {
          if (leaveMode === MENU_MODE.STARTGAME) {
            mode = "none";
            mainMenu = null;
            bgfx = null;
            setInteractive();
            callbacks.onStartMission?.(activeMission);
          } else if (leaveMode === MENU_MODE.QUIT) {
            callbacks.onExit?.();
          }
          return;
        }
        if (leaveMode === MENU_MODE.RESTARTLEVEL) {
          ingameMenu?.goIdle();
          paused = false;
          setInteractive();
          callbacks.onRestart?.();
        } else if (leaveMode === MENU_MODE.QUITTOMAINMENU) {
          ingameMenu?.goIdle();
          paused = false;
          callbacks.onQuit?.("quit");
          showMainMenu();
        }
      },
      setPaused: (p) => {
        if (main) return;
        paused = p;
        setInteractive();
        if (p) callbacks.onPause?.();
        else callbacks.onResume?.();
      },
      opened: () => {
        setInteractive();
        callbacks.releaseLock?.();
      },
      config,
      spriteSize: (name) => {
        const sp = archiveOf().sprites.get(name.toLowerCase());
        return sp ? { w: sp.width, h: sp.height } : null;
      },
      font: (name) => archiveOf().fonts.get(name.toLowerCase()) ?? null,
      textFile: (name) => (/readme\.txt$/i.test(name) ? readmeText : null),
      typewriterScript: () => credits,
      heldKeys: () => heldKeys,
      attract: () => {
        if (!main || !callbacks.onAttract) return;
        mode = "none";
        mainMenu = null;
        bgfx = null;
        setInteractive();
        callbacks.onAttract();
      },
    };
  }

  function showMainMenu(): void {
    if (!assets) return;
    mode = "main";
    loading = null;
    completeCountdown = 0;
    paused = false;
    ingameMenu?.goIdle();
    bgfx = new BackgroundFx();
    mainMenu = new MenuManager(assets.mainMenu, menuEnv(() => assets!.main, true), { ownDisplay: true, ticksPerSecond: 60, startOpen: true });
    setInteractive();
  }

  // --- events -----------------------------------------------------------------
  const bus = ctx.events;
  const offs: Array<() => void> = [];
  if (bus) {
    offs.push(bus.on(GameEvent.StatusMessage, (payload) => {
      const p = payload as StatusMessagePayload | undefined;
      if (!p || typeof p.text !== "string") return;
      legacyStatusAllowed = false;
      sendRadio({
        text: resolveMessage(p.text),
        portrait: normalisePortrait(p.sprite),
        durationSeconds: typeof p.durationSeconds === "number" ? p.durationSeconds : 2,
        cutscene: !!p.cutscene,
      });
    }));
    offs.push(bus.on(GameEvent.Status, (payload) => {
      // Legacy fallback (combat/objectives.ts) until the task runtime sends StatusMessage.
      const p = payload as { text?: string } | undefined;
      if (!legacyStatusAllowed || !p || typeof p.text !== "string") return;
      sendRadio({ text: resolveMessage(p.text), portrait: null, durationSeconds: 2, cutscene: false });
    }));
    offs.push(bus.on(GameEvent.Pickup, (payload) => {
      // GunPickup / AmmoPickup (FUN_00483920): "send once", instant, 2 s, radio style.
      const p = payload as { kind?: string; name?: string } | undefined;
      if (!p) return;
      if (p.kind === "ammo") {
        sendRadio({ text: resolveMessage("PICKEDUPAMMO"), portrait: "ammo.spr", durationSeconds: 2, cutscene: false });
      } else if (p.kind === "weapon") {
        const name = weaponName(p.name ?? "");
        sendRadio({ text: resolveMessage(`PICKEDUPWEAPON${name}`), portrait: null, durationSeconds: 2, cutscene: false });
      }
    }));
    if (options.autoHitTint !== false) {
      offs.push(bus.on(GameEvent.PlayerHit, (payload) => {
        const p = payload as { from?: [number, number, number] } | undefined;
        hit(p?.from ? directionFrom(p.from) : null);
      }));
    }
    offs.push(bus.on(GameEvent.StatusClear, () => {
      // StatusMessageScreen_ClearMessages() (level 1: "Main character and status messages" container start).
      clearRadio();
    }));
    offs.push(bus.on(GameEvent.MissionFailed, () => {
      // LevelFlow "Failed" became true (level 1: StatusMessage_1391.isSendt). The runtime sends the
      // "Mission Failed!" message itself; the menu opens 151 ticks later, or on Space/Return/Esc when dead.
      failed = true;
    }));
    offs.push(bus.on(GameEvent.CutsceneStart, () => {
      cutscene = true;
    }));
    offs.push(bus.on(GameEvent.CutsceneEnd, () => {
      cutscene = false;
    }));
  }

  function weaponName(name: string): string {
    const byScript = assets?.weapons.get(name);
    if (byScript) return byScript.name;
    return name;
  }

  /** Damage travel direction (shooter -> player) in the player's view frame (right, forward, up); inferred mapping. */
  function directionFrom(from: [number, number, number]): HitDirection {
    const p = ctx.player.position;
    const dx = p[0] - from[0];
    const eye = (ctx.player as { eyeHeight?: number }).eyeHeight;
    const dy = p[1] + (typeof eye === "number" && Number.isFinite(eye) ? eye : 1.6) - from[1];
    const dz = p[2] - from[2];
    const yaw = ctx.player.yaw;
    const right = dx * Math.cos(yaw) - dz * Math.sin(yaw);
    const forward = -dx * Math.sin(yaw) - dz * Math.cos(yaw);
    return [right, forward, dy];
  }

  function hit(direction?: HitDirection | null): void {
    tint.hit(random(), direction);
  }

  // --- loading ------------------------------------------------------------------
  const ready = loadUiAssets(source).then((a) => {
    if (disposed) return;
    assets = a;
    const hudFont = a.computer.fonts.get("font3.fnt");
    const radioFont = a.ingame.fonts.get("font1.fnt");
    const cutsceneFont = a.ingame.fonts.get("font4.fnt");
    if (!hudFont || !radioFont || !cutsceneFont) throw new Error("UI: computer/font3.fnt or ingamemenu.res font1/font4.fnt missing");
    fonts = { hud: hudFont, radio: radioFont, cutscene: cutsceneFont };
    ingameMenu = new MenuManager(a.ingameMenu, menuEnv(() => a.ingame, false), { ownDisplay: false, ticksPerSecond: 30, startOpen: false });
  }).then(async () => {
    // Optional menu data: the profile defaults (config.qvm) and the Read Me text.
    const tryRead = async (path: string) => {
      try {
        return await source.readBinary(path);
      } catch {
        return null;
      }
    };
    const cfg = await tryRead("config.qvm");
    if (cfg) {
      try {
        config.loadConfigQvm(cfg);
      } catch (error) {
        console.warn(`[ui] config.qvm: ${(error as Error).message}`);
      }
    }
    const readme = (await tryRead("language/english/ReadMe.txt")) ?? (await tryRead("language/english/readme.txt"));
    if (readme) readmeText = Array.from(new Uint8Array(readme), (c) => String.fromCharCode(c)).join("");
    // The Credits script lives in igi.exe itself (0x537cd8); it is only used when the host passes it in
    // (setCreditsScript, e.g. readExeCredits on the user's own executable). Without it the box stays empty.
  });
  ready.catch((error) => console.error("[hud] UI files failed to load:", error));

  // --- per tick -----------------------------------------------------------------
  function tickOnce(worldRunning: boolean): void {
    if (!assets) return;
    if (completeCountdown > 0 && --completeCountdown === 0) {
      loading = null;
      callbacks.onQuit?.("complete");
      showMainMenu();
      return;
    }
    if (mode === "main" && mainMenu) {
      // The own-display menu runs at 60 ticks/s (FUN_004029a0(0x3c) at 0x417b34).
      for (let i = 0; i < 2 && mainMenu; i++) {
        bgfx?.tick();
        mainMenu.tick();
      }
      return;
    }
    if (mode !== "game") return;
    ingameMenu?.tick();
    if (worldRunning && !paused && !loading) {
      radio.tick();
      tint.tick();
      flash.tick();
      pulse.tick(actionIcon !== null);
      if (scope?.kind === "binoculars") binocularBars.tick(random);
      if (computer) {
        // ComputerMenu FUN_004697d0 (skipped while paused, FUN_00415c50).
        computer.logLength = computerLog.entries.length;
        pointerStep();
        computer.tick({ ...computerInput });
      }
    }
    computerInput.dx = computerInput.dy = 0;
    computerInput.wheelUp = computerInput.wheelDown = false;
  }

  function computerRng() {
    const r = ctx.rng;
    if (r) return { float: () => r.float(), int: (n: number) => r.int(n) };
    return { float: () => random(), int: (n: number) => Math.floor(random() * n) };
  }

  function computerDrawResources(a: UiAssets): ComputerDrawResources {
    return { computer: a.computer, ingame: a.ingame, text: (key) => a.computerStrings.get(key.toLowerCase()) ?? `RM: ${key}` };
  }

  // --- drawing ------------------------------------------------------------------
  const list = new PrimList();

  function weaponView(): HudView["weapon"] {
    const w = ctx.weapon;
    if (!w || !assets) return null;
    const info: WeaponHudInfo | undefined = assets.weapons.get(w.spec.scriptId);
    if (!info) return null;
    // The Binocular class draws nothing until zoomed (FUN_0046f780).
    if (info.weaponType === "WEAPONTYPE_BINOCULAR") return null;
    return { info, clip: w.ammo, reserve: w.reserve, roundsPerClip: w.spec.roundsPerClip || info.roundsPerClip, m203 };
  }

  function draw(): void {
    if (!painter || !canvas) return;
    syncCanvasRect();
    setInteractive();
    const g = painter.g;
    g.clearRect(0, 0, VW, VH);
    if (!assets || !fonts) return;
    if (loading) {
      painter.opaqueTarget = true;
      submitLoading(assets.loading, usa, loading.done, loading.total, list);
      list.flush(painter);
      return;
    }
    if (mode === "main" && mainMenu) {
      painter.opaqueTarget = true; // mainmenu.pic covers the frame
      const res: MenuDrawResources = { archive: assets.main, missionSprites: assets.missionSprites, usa, bgfx };
      submitMenu(mainMenu, res, list);
      list.flush(painter);
      return;
    }
    painter.opaqueTarget = false;
    if (mode !== "game") {
      showMultiply(false);
      return;
    }
    if (computer) {
      // The computer screen replaces the player HUD (DAT_005c1680); radio messages are still drawn, on top (inferred).
      drawComputer(painter, computer, computerDrawResources(assets), {
        log: computerLog,
        objectives: computerWorld.objectives(),
        mapEnabled: computerWorld.mapEnabled(),
        filterRandom: random,
      });
      showMultiply(computerNeedsMultiply(computer));
      submitStatusMessages(radio, { status: assets.status, hudFont: fonts.hud, radioFont: fonts.radio, cutsceneFont: fonts.cutscene }, VW, VH, list);
      list.flush(painter);
      if (ingameMenu) {
        submitMenu(ingameMenu, { archive: assets.ingame, missionSprites: assets.missionSprites, usa, bgfx: null }, list);
        list.flush(painter);
      }
      return;
    }
    showMultiply(false);
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (scope?.kind === "binoculars") binocularTargets.update(binocularCandidates ?? [], now);
    const player = ctx.player;
    const view: HudView = {
      W: VW,
      H: VH,
      playerHud: !!ctx.level && !cutscene,
      firstPersonView: playerViewMode === 1,
      health: player.maxHealth > 0 ? Math.max(0, player.health / player.maxHealth) : 0,
      weapon: weaponView(),
      actionIcon,
      actionAlpha: pulse.alpha,
      progress,
      tint: tint.corners,
      flashAlpha: flash.alpha,
      timerTicks: timer,
      scope,
      binocularBars,
      binocularTargets,
      nowMs: now,
    };
    const res: HudResources = {
      status: assets.status,
      hudFont: fonts.hud,
      radioFont: fonts.radio,
      cutsceneFont: fonts.cutscene,
      commonSprites: assets.commonSprites,
    };
    submitHud(view, radio, res, list);
    list.flush(painter);
    if (ingameMenu) {
      submitMenu(ingameMenu, { archive: assets.ingame, missionSprites: assets.missionSprites, usa, bgfx: null }, list);
      list.flush(painter);
    }
  }

  // --- API ------------------------------------------------------------------------
  const hud: Hud = {
    ready,
    load: () => ready,
    tick(worldRunning = true): void {
      externalTicks = true;
      tickOnce(worldRunning);
    },
    draw,
    update(dt = 0): void {
      if (!externalTicks && Number.isFinite(dt) && dt > 0) {
        tickAccumulator = Math.min(tickAccumulator + dt, 0.5);
        while (tickAccumulator >= 1 / 30) {
          tickAccumulator -= 1 / 30;
          tickOnce(ctx.running);
        }
      }
      draw();
    },
    message(text: string, ttlSeconds = 2): void {
      sendRadio({ text: resolveMessage(text), portrait: null, durationSeconds: ttlSeconds, cutscene: false });
    },
    showOverlay(text: string | null): void {
      if (!overlay) return;
      if (text === null) {
        overlay.classList.add("hidden");
        overlay.textContent = "";
      } else {
        overlay.classList.remove("hidden");
        overlay.textContent = text;
      }
    },
    showMainMenu,
    openPauseMenu(): void {
      if (mode !== "game" || !ingameMenu || !ingameMenu.isIdle || loading || !ctx.level) return;
      ingameMenu.idleKey("Escape");
    },
    isMenuOpen: () => activeMenu() !== null,
    isPaused: () => paused,
    showLoading(stepsDone: number, totalSteps: number): void {
      loading = { done: Math.max(0, stepsDone), total: Math.max(1, totalSteps) };
      setInteractive();
    },
    hideLoading(): void {
      loading = null;
      setInteractive();
    },
    startMission(): void {
      mode = "game";
      mainMenu = null;
      bgfx = null;
      loading = null;
      completeCountdown = 0;
      failed = false;
      failedDead = false;
      cutscene = false;
      paused = false;
      actionIcon = null;
      progress = null;
      timer = null;
      scope = null;
      computer = null;
      showMultiply(false);
      binocularTargets.reset();
      clearRadio();
      tint.reset();
      flash.value = 0;
      pulse.phase = 0;
      ingameMenu?.goIdle();
      setInteractive();
    },
    missionFailed(opts = {}): void {
      if (opts.sendMessage && !failed) {
        sendRadio({ text: resolveMessage("MISSION_FAILED"), portrait: null, durationSeconds: 2, cutscene: false });
      }
      failed = true;
      if (opts.playerDead) failedDead = true;
    },
    missionComplete(): void {
      // FUN_00415306: loading screen with total 1, never advanced; next mission -1 -> main menu.
      loading = { done: 0, total: 1 };
      completeCountdown = COMPLETE_HANDOVER_TICKS;
      setInteractive();
    },
    flashBang(value = 2): void {
      flash.trigger(value);
    },
    hit,
    hitDirectionFrom: (from) => directionFrom(from),
    setTintCorners(tl, tr, bl, br) {
      tint.corners.tl = tl;
      tint.corners.tr = tr;
      tint.corners.bl = bl;
      tint.corners.br = br;
    },
    setCutscene(active: boolean): void {
      cutscene = active;
    },
    clearMessages(): void {
      clearRadio();
    },
    setActionIcon(name: string | null): void {
      actionIcon = name ? name.toLowerCase() : null;
    },
    setActionProgress(p: number | null): void {
      progress = p;
    },
    setTimer(remaining: number | null): void {
      timer = remaining;
    },
    setScope(next: ScopeView | null): void {
      if (next?.kind !== "binoculars") binocularTargets.reset();
      scope = next;
    },
    setBinocularTargets(targets: readonly BinocularTargetInput[] | null): void {
      binocularCandidates = targets;
      if (!targets) binocularTargets.reset();
    },
    setPlayerView(mode: number): void {
      playerViewMode = mode;
    },
    setM203Rounds(rounds: number | null): void {
      m203 = rounds;
    },
    openMapComputer(): void {
      if (!assets || computer) return;
      const a = assets;
      computer = new MapComputer({
        world: computerWorld,
        res: {
          spriteSize: (name) => {
            const sp = a.computer.sprites.get(name.toLowerCase());
            return sp ? { w: sp.width, h: sp.height } : null;
          },
          measure: (font, text) => {
            const f = a.ingame.fonts.get(font);
            return f ? { w: measureLine(f, text), h: f.lineHeight } : { w: 0, h: 0 };
          },
          buttonLabelHeight: a.computer.fonts.get("font1.fnt")?.lineHeight ?? 0,
          text: (key) => a.computerStrings.get(key.toLowerCase()) ?? `RM: ${key}`,
        },
        rng: computerRng(),
        sound: (name) => callbacks.onGameSound?.(name),
        mapEnabled: () => computerWorld.mapEnabled(),
      });
      computerInput.dx = computerInput.dy = 0;
      computerInput.left = computerInput.right = computerInput.wheelUp = computerInput.wheelDown = false;
    },
    closeMapComputer(): void {
      computer = null;
      showMultiply(false);
    },
    isMapComputerOpen: () => computer !== null,
    mapComputerView: () => computer?.view() ?? null,
    computerLog,
    settings: config,
    setCreditsScript(script: readonly TypewriterEntry[] | null): void {
      credits = script ? script.slice() : null;
    },
    dispose(): void {
      disposed = true;
      for (const off of offs) off();
      if (canvas) {
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointerup", onPointerUp);
        painter?.g.clearRect(0, 0, VW, VH);
      }
      if (hasDom) {
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("mousedown", onMouseHeld);
        window.removeEventListener("mouseup", onMouseHeld);
        window.removeEventListener("mousemove", onComputerMove);
        window.removeEventListener("mousedown", onComputerButton);
        window.removeEventListener("mouseup", onComputerButton);
        window.removeEventListener("wheel", onComputerWheel);
      }
      multiplyLayer?.remove();
      clearRadio();
    },
  };
  return hud;
}

/** FUN_004ad200: line width (pen position after the last mapped character). */
function measureLine(font: UiFont, text: string): number {
  let pen = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const g = c < 256 ? font.charMap[c] : 0;
    if (g === 0) pen += font.proportional ? font.spaceAdvance : font.cellWidth;
    else {
      pen += font.proportional ? font.glyphs[g - 1].advance : font.cellWidth;
      last = pen;
    }
  }
  return last;
}
