/**
 * createHud (src/engine/ui/hud.ts) driven headless with the original files:
 * the mission-failed and mission-complete flows, the pause menu and the
 * callbacks game.ts wires. Skipped when web-port/game-data is not staged.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EventBus, GameEvent } from "../src/engine/events";
import type { PlayerState } from "../src/engine/context";
import { UI_REQUIRED_FILES } from "../src/engine/ui/assets";
import { createHud, type HudContext } from "../src/engine/ui/hud";
import { RAW_ROOT, readRaw } from "./helpers";

const staged = UI_REQUIRED_FILES.every((p) => existsSync(`${RAW_ROOT}/${p}`));
const rawSource = { exists: async (p: string) => existsSync(`${RAW_ROOT}/${p}`), readBinary: (p: string) => readRaw(p) };

function setup() {
  const log: string[] = [];
  const player: PlayerState = {
    position: [0, 0, 0], velocity: [0, 0, 0], yaw: 0, pitch: 0, grounded: true, crouching: false, running: false,
    health: 3, maxHealth: 3, alive: true, walking: false, eyeHeight: 1.6, kickPitch: 0, kickYaw: 0, leanSide: 0, leanUp: 0,
  };
  const ctx: HudContext = {
    events: new EventBus(),
    player,
    weapon: null,
    level: {} as HudContext["level"],
    frame: { x: 0, y: 0, width: 640, height: 480 },
    canvas: undefined as unknown as HTMLCanvasElement,
    running: true,
  };
  const hud = createHud(ctx, {
    source: rawSource,
    random: () => 0.5,
    callbacks: {
      onSound: (n) => log.push(`sound:${n}`),
      onStartMission: (id) => log.push(`start:${id}`),
      onResume: () => log.push("resume"),
      onRestart: () => log.push("restart"),
      onQuit: (r) => log.push(`quit:${r}`),
      onExit: () => log.push("exit"),
      onPause: () => log.push("pause"),
      requestLock: () => log.push("lock"),
      releaseLock: () => log.push("unlock"),
    },
  });
  const ticks = (n: number) => {
    for (let i = 0; i < n; i++) hud.tick();
  };
  return { hud, ctx, player, log, ticks };
}

describe.skipIf(!staged)("createHud flows (original files)", () => {
  it("loads every UI file and starts idle in-game", async () => {
    const { hud } = setup();
    await hud.ready;
    expect(hud.isMenuOpen()).toBe(false);
    expect(hud.isPaused()).toBe(false);
  });

  it("pause menu: openPauseMenu pauses and releases the pointer", async () => {
    const { hud, log, ticks } = setup();
    await hud.ready;
    hud.startMission();
    hud.openPauseMenu();
    ticks(1);
    expect(log).toEqual(["pause"]);
    ticks(1);
    expect(hud.isMenuOpen()).toBe(true);
    expect(log).toContain("unlock");
    expect(hud.isPaused()).toBe(true);
  });

  it("mission failed while alive: the menu opens after 151 + 1 ticks", async () => {
    const { hud, log, ticks } = setup();
    await hud.ready;
    hud.startMission();
    hud.missionFailed({ playerDead: false, sendMessage: true });
    ticks(151);
    expect(log).not.toContain("pause");
    ticks(1);
    expect(log).toContain("pause");
  });

  it("mission failed when dead: waits for Space / Return / Esc", async () => {
    const { hud, log, ticks, player } = setup();
    await hud.ready;
    hud.startMission();
    player.alive = false;
    hud.missionFailed({ playerDead: true });
    ticks(300);
    expect(log).not.toContain("pause");
    hud.openPauseMenu(); // Esc
    ticks(1);
    expect(log).toContain("pause");
  });

  it("mission complete: loading screen, then onQuit('complete') and the main menu", async () => {
    const { hud, log, ticks } = setup();
    await hud.ready;
    hud.startMission();
    hud.missionComplete();
    expect(hud.isMenuOpen()).toBe(false);
    ticks(15);
    expect(log).toContain("quit:complete");
    ticks(2);
    expect(hud.isMenuOpen()).toBe(true);
  });

  it("GameEvent.MissionFailed starts the failure flow (menu after 151 + 1 ticks)", async () => {
    const { hud, ctx, log, ticks } = setup();
    await hud.ready;
    hud.startMission();
    ctx.events.emit(GameEvent.MissionFailed, { text: "Mission Failed!" });
    ticks(152);
    expect(log).toContain("pause");
  });

  it("PlayerHit, StatusMessage, StatusClear and Pickup events are accepted", async () => {
    const { hud, ctx, ticks } = setup();
    await hud.ready;
    hud.startMission();
    ctx.events.emit(GameEvent.StatusMessage, { text: "x", sprite: null, sound: null, durationSeconds: 2, cutscene: false });
    ctx.events.emit(GameEvent.StatusClear);
    ticks(1);
    expect(hud.isMenuOpen()).toBe(false);
  });

  it("PlayerHit and StatusMessage events are accepted without errors", async () => {
    const { hud, ctx, ticks } = setup();
    await hud.ready;
    hud.startMission();
    ctx.events.emit(GameEvent.PlayerHit, { amount: 0.5, from: [10, 1, 0] });
    ctx.events.emit(GameEvent.StatusMessage, { text: "M1_MSG_4", sprite: "", sound: "message", durationSeconds: 2, cutscene: false });
    ctx.events.emit(GameEvent.Pickup, { kind: "weapon", name: "WEAPON_ID_MP5SD" });
    ticks(200);
    expect(hud.isMenuOpen()).toBe(false);
  });
});
