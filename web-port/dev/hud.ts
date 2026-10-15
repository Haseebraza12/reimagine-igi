/**
 * Dev-only HUD / menu harness (dev/hud.html?scene=...). Mounts the real
 * src/engine/ui over a static background with simulated game state, runs a
 * fixed number of 30 Hz ticks and draws, then sets window.__hudReady.
 *
 * Scenes: hud (health 60 %, MP5SD 32/49, radio mid-typing, damage tint),
 * loading (4/9), main, select, pause, dialog, failed, cutscene, flash,
 * computer / computer-zoom / computer-objectives / computer-log / computer-init
 * (the map computer over a procedural stand-in for the satellite render),
 * targets (binocular target squares), m203, config / graphics / sound /
 * controls / player / readme / credits (main-menu sub-screens), igsound / igcontrols.
 * Extra: &w=WIDTH&h=HEIGHT for the frame (default: the window, 4:3 fitted).
 */
import { createHttpAssetSource, flattenTasks, igiPointToEngine, readQvmCallTree, readTaskTree, type LevelWeapon, type Vec3 } from "../src/loaders";
import { EventBus, GameEvent } from "../src/engine/events";
import type { PlayerState, WeaponState } from "../src/engine/context";
import { createHud, type HudContext } from "../src/engine/ui/hud";

declare global {
  interface Window {
    __hudReady?: boolean | string;
    __hudLog?: string[];
    __hudTick?: (n: number) => void;
  }
}

const params = new URLSearchParams(location.search);
const scene = params.get("scene") ?? "hud";
const log: string[] = [];
window.__hudLog = log;

const game = document.getElementById("game") as HTMLCanvasElement;
const fit = () => {
  const W = innerWidth;
  const H = innerHeight;
  const scale = Math.min(W / 640, H / 480);
  const width = Math.floor(640 * scale);
  const height = Math.floor(480 * scale);
  return { x: Math.floor((W - width) / 2), y: Math.floor((H - height) / 2), width, height };
};
const frame = fit();

// Static stand-in for the 3D frame: dusk sky over a dull ground.
function paintBackground(): void {
  game.width = innerWidth;
  game.height = innerHeight;
  const g = game.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, game.width, game.height);
  const sky = g.createLinearGradient(0, frame.y, 0, frame.y + frame.height * 0.55);
  sky.addColorStop(0, "#5d6f86");
  sky.addColorStop(1, "#a7a99a");
  g.fillStyle = sky;
  g.fillRect(frame.x, frame.y, frame.width, frame.height * 0.55);
  const ground = g.createLinearGradient(0, frame.y + frame.height * 0.55, 0, frame.y + frame.height);
  ground.addColorStop(0, "#6b6a55");
  ground.addColorStop(1, "#3b3a2e");
  g.fillStyle = ground;
  g.fillRect(frame.x, frame.y + frame.height * 0.55, frame.width, frame.height * 0.45);
  g.fillStyle = "#4a4d47";
  g.fillRect(frame.x + frame.width * 0.62, frame.y + frame.height * 0.32, frame.width * 0.22, frame.height * 0.26);
}
paintBackground();

const mp5: LevelWeapon = {
  scriptId: "WEAPON_ID_MP5SD",
  name: "Mp5 SD3",
  weaponType: "WEAPONTYPE_GUN",
  roundsPerClip: 32,
} as unknown as LevelWeapon;

const player: PlayerState = {
  position: [0, 0, 0],
  velocity: [0, 0, 0],
  yaw: 0,
  pitch: 0,
  grounded: true,
  crouching: false,
  running: false,
  health: 1.8, // original damage units: 3.0 capacity, 1.2 taken -> 60 %
  maxHealth: 3,
  alive: true,
  walking: false,
  eyeHeight: 1.6,
  kickPitch: 0,
  kickYaw: 0,
  leanSide: 0,
  leanUp: 0,
};
const weapon: WeaponState = { spec: mp5, ammo: 32, reserve: 49, reloading: false, reloadRemaining: 0, cooldownRemaining: 0, heldSeconds: 0 };
const events = new EventBus();
const ctx: HudContext = {
  events,
  player,
  weapon,
  level: {} as HudContext["level"],
  frame,
  canvas: game,
  running: true,
};

const hud = createHud(ctx, {
  source: createHttpAssetSource("/raw/"),
  callbacks: {
    onSound: (n) => log.push(`sound ${n}`),
    onStartMission: (id) => log.push(`start ${id}`),
    onResume: () => log.push("resume"),
    onRestart: () => log.push("restart"),
    onQuit: (r) => log.push(`quit ${r}`),
    onExit: () => log.push("exit"),
    onPause: () => log.push("pause"),
    requestLock: () => log.push("requestLock"),
    releaseLock: () => log.push("releaseLock"),
  },
});

/** Stand-in for the world rendered from the map camera: a procedural aerial pattern (dev only). */
function paintAerial(): void {
  const g = game.getContext("2d")!;
  const { x, y, width, height } = frame;
  for (let j = 0; j < 48; j++) {
    for (let i = 0; i < 64; i++) {
      const v = 70 + ((i * 37 + j * 91 + ((i * j) % 7) * 13) % 60);
      g.fillStyle = `rgb(${v + 20},${v + 10},${v - 10})`;
      g.fillRect(x + (i * width) / 64, y + (j * height) / 48, width / 64 + 1, height / 48 + 1);
    }
  }
  g.fillStyle = "#3a3a3a";
  g.fillRect(x + width * 0.3, y + height * 0.42, width * 0.25, height * 0.06);
  g.fillRect(x + width * 0.62, y + height * 0.2, width * 0.05, height * 0.6);
  g.fillStyle = "#d8d8d0";
  g.fillRect(x + width * 0.45, y + height * 0.25, width * 0.08, height * 0.1);
}

/** Level-1 tasks for the map computer (objects.qvm), the player at its spawn and the soldiers at theirs. */
async function loadLevelStandIn(): Promise<void> {
  const buf = await (await fetch("/raw/missions/location0/level1/objects.qvm")).arrayBuffer();
  const tasks = flattenTasks(readTaskTree(readQvmCallTree(buf)));
  const spawn = tasks.find((t) => t.type === "HumanPlayer")!.params.Position as number[];
  const origin: Vec3 = [spawn[0], spawn[1], spawn[2]];
  (ctx as { level: unknown }).level = { tasks, originIgi: origin, origin };
  player.position = [0, 0, 0];
  player.yaw = 0.6;
  let id = 1;
  ctx.enemies = tasks.filter((t) => t.type === "HumanSoldier").map((t) => {
    const p = t.params.Position as number[];
    return {
      id: id++, taskId: t.id, position: igiPointToEngine([p[0], p[1], p[2]], origin), velocity: [0, 0, 0] as Vec3,
      yaw: Number(t.params.Gamma) || 0, health: 1, alive: true, state: "patrol" as const, aiType: "guard", weapon: null, object: null,
    };
  });
}

const tick = (n: number) => {
  for (let i = 0; i < n; i++) hud.tick();
  hud.draw();
};
window.__hudTick = tick;
const key = (code: string) => window.dispatchEvent(new KeyboardEvent("keydown", { code }));
const ui = document.getElementById("igi-ui") as HTMLCanvasElement;
const pointer = (type: "pointermove" | "pointerdown" | "pointerup", vx: number, vy: number) => {
  const r = ui.getBoundingClientRect();
  ui.dispatchEvent(new PointerEvent(type, { clientX: r.left + ((vx + 0.5) / 640) * r.width, clientY: r.top + ((vy + 0.5) / 480) * r.height, button: 0 }));
};

async function run(): Promise<void> {
  await hud.ready;
  switch (scene) {
    case "hud": {
      hud.startMission();
      // Level 1's radio messages have no portrait (Sprite ""); the ammo pickup uses ammo.spr.
      events.emit(GameEvent.StatusMessage, { text: "M1_MSG_4", sprite: "", sound: "message", durationSeconds: 2, cutscene: false });
      tick(20);
      events.emit(GameEvent.Pickup, { kind: "ammo", name: "AMMO_ID_919" });
      tick(25); // first message mid-typing (34 of 61 characters), second one typing
      events.emit(GameEvent.PlayerHit, { amount: 0.1 });
      tick(6);
      hud.setActionIcon("a_door.spr");
      tick(8);
      break;
    }
    case "radio-open": {
      hud.startMission();
      events.emit(GameEvent.StatusMessage, { text: "M1_MSG_4", sprite: "STATUSSCREEN:anya.spr", sound: null, durationSeconds: 2, cutscene: false });
      tick(5);
      break;
    }
    case "cutscene": {
      hud.startMission();
      hud.setCutscene(true);
      events.emit(GameEvent.StatusMessage, { text: "M1_CUT_01", sprite: null, sound: null, durationSeconds: 8, cutscene: true });
      tick(3);
      break;
    }
    case "flash": {
      hud.startMission();
      hud.flashBang();
      tick(100);
      break;
    }
    case "binoculars":
      hud.startMission();
      hud.setScope({ kind: "binoculars", yaw: 0.35, rangeMetres: 87.4 });
      tick(40);
      break;
    case "sniper":
      hud.startMission();
      hud.setScope({ kind: "sniper" });
      tick(2);
      break;
    case "loading":
      hud.showLoading(4, 9);
      tick(1);
      break;
    case "main":
      hud.showMainMenu();
      tick(12);
      pointer("pointermove", 330, 220); // over "Configuration"
      tick(4);
      break;
    case "select":
      hud.showMainMenu();
      tick(12);
      key("Enter"); // "Play Project IGI" is the first selectable item
      tick(20);
      break;
    case "start": {
      hud.showMainMenu();
      tick(12);
      key("Enter");
      tick(20);
      // Click OK (found by its layout position) and let the menu fade out.
      pointer("pointermove", 590, 412);
      tick(1);
      pointer("pointerdown", 590, 412);
      tick(1);
      pointer("pointerup", 590, 412);
      tick(20);
      break;
    }
    case "pause":
      hud.startMission();
      tick(2);
      hud.openPauseMenu();
      tick(14);
      pointer("pointermove", 320, 135);
      tick(2);
      break;
    case "dialog":
      hud.startMission();
      hud.openPauseMenu();
      tick(14);
      key("ArrowDown");
      tick(1);
      key("Enter"); // Restart Mission -> dialog 932
      tick(14);
      break;
    case "failed":
      hud.startMission();
      events.emit(GameEvent.StatusMessage, { text: "MISSION_FAILED", sprite: null, sound: "message", durationSeconds: 2, cutscene: false });
      hud.missionFailed({ playerDead: false });
      tick(170);
      break;
    case "complete":
      hud.startMission();
      hud.missionComplete();
      tick(1);
      break;
    case "computer":
    case "computer-zoom":
    case "computer-objectives":
    case "computer-log":
    case "computer-init": {
      await loadLevelStandIn();
      paintAerial();
      hud.startMission();
      events.emit(GameEvent.StatusMessage, { text: "M1_MSG_4", sprite: "", sound: "message", durationSeconds: 2, cutscene: false });
      events.emit(GameEvent.StatusMessage, { text: "M1_MSG_5", sprite: "", sound: "message", durationSeconds: 2, cutscene: false });
      tick(200);
      hud.openMapComputer();
      if (scene === "computer-init") {
        tick(4);
        break;
      }
      tick(30);
      const move = (vx: number, vy: number) => window.dispatchEvent(new MouseEvent("mousemove", { movementX: (vx * frame.width) / 640, movementY: (vy * frame.height) / 480 }));
      const click = () => {
        window.dispatchEvent(new MouseEvent("mousedown", { button: 0 }));
        tick(1);
        window.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
        tick(1);
      };
      if (scene === "computer-zoom") {
        move(486 + 8 - 320, 390 + 8 - 240); // over "+"
        tick(1);
        click();
        tick(40);
        move(-150, -150);
        tick(2);
      } else if (scene === "computer-objectives") {
        move(64 + 10 - 320, 388 + 6 - 240); // "Objectives"
        tick(1);
        click();
        tick(3);
      } else if (scene === "computer-log") {
        move(64 + 6 - 320, 372 + 6 - 240); // "Log"
        tick(1);
        click();
        tick(3);
      } else {
        move(120, -60);
        tick(1);
      }
      break;
    }
    case "targets":
      hud.startMission();
      hud.setScope({ kind: "binoculars", yaw: 0.35, rangeMetres: 87.4 });
      hud.setBinocularTargets([
        { id: 1, x: 300, y: 250, depth: 60, radius: 0.5, pixelsPerUnitAtUnitDepth: 320 / 0.09, team: 1, lineOfSight: true },
        { id: 2, x: 420, y: 230, depth: 90, radius: 0.5, pixelsPerUnitAtUnitDepth: 320 / 0.09, team: 0, lineOfSight: true },
      ]);
      tick(10);
      await new Promise((r) => setTimeout(r, 400));
      tick(1);
      break;
    case "config":
    case "graphics":
    case "sound":
    case "controls":
    case "player":
    case "readme":
    case "credits": {
      hud.showMainMenu();
      tick(12);
      const down = (n: number) => {
        for (let i = 0; i < n; i++) {
          key("ArrowDown");
          tick(1);
        }
      };
      const into = { config: [1], graphics: [1, 0], sound: [1, 1], controls: [1, 2], player: [2], readme: [4], credits: [5] }[scene]!;
      for (const n of into) {
        down(n);
        key("Enter");
        tick(14);
      }
      if (scene === "sound") {
        key("ArrowRight"); // FX volume one caret step up (first row selected)
        tick(2);
      }
      if (scene === "credits") tick(150);
      break;
    }
    case "igsound":
    case "igcontrols":
      hud.startMission();
      tick(2);
      hud.openPauseMenu();
      tick(14);
      for (let i = 0; i < (scene === "igsound" ? 2 : 3); i++) {
        key("ArrowDown");
        tick(1);
      }
      key("Enter");
      tick(30); // fade out (8 + 2 ticks), open, fade in (8 + 2) at 30 Hz
      break;
    case "m203":
      hud.startMission();
      weapon.spec = { scriptId: "WEAPON_ID_M16A2", name: "M16 A2", weaponType: "WEAPONTYPE_GUN", roundsPerClip: 30 } as unknown as LevelWeapon;
      weapon.ammo = 18;
      weapon.reserve = 90;
      hud.setM203Rounds(3);
      tick(2);
      break;
    default:
      break;
  }
  log.push(`scene ${scene} ready`);
  window.__hudReady = true;
}

run().catch((error) => {
  console.error(error);
  window.__hudReady = `error: ${(error as Error).message}`;
});
