/**
 * Game orchestrator — builds the GameContext, wires every subsystem, loads the
 * level, and runs the frame loop. This is the integration point that turns the
 * loader + engine layers into a running mission.
 *
 * Confidence: scaffolding / wiring. Individual behaviours live in their owning
 * modules; this file only sequences them and translates input/events.
 */
import { DEFAULT_PLAYER_TUNING, type Vec3 } from "../contracts";
import { Clock } from "./clock";
import { EventBus, GameEvent } from "./events";
import { Input } from "./input";
import { createRenderer } from "./render/renderer";
import type { GameContext, PlayerState } from "./context";
import { createPlayerController } from "./player/player";
import { createCameraController } from "./player/camera";
import { createWeaponSystem } from "./combat/weapon";
import { createEnemyManager } from "./combat/enemy";
import { createObjectiveTracker } from "./combat/objectives";
import { createAudioManager } from "./audio/audio";
import { createHud } from "./ui/hud";
import { createEffects } from "./fx/effects";
import { loadLevel, type LoadedLevel } from "./level";

export interface Game {
  stop(): void;
}

const DEG2RAD = Math.PI / 180;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function createGame(canvas: HTMLCanvasElement): Game {
  const { renderer, scene, camera, resize, dispose } = createRenderer(canvas);
  const events = new EventBus();
  const clock = new Clock();
  const input = new Input(canvas);

  let stopped = false;
  let loaded: LoadedLevel | null = null;

  const player: PlayerState = {
    position: [0, 40, 0] as Vec3,
    velocity: [0, 0, 0] as Vec3,
    yaw: 0,
    pitch: 0,
    grounded: true,
    crouching: false,
    running: false,
    health: 100,
    maxHealth: 100,
    alive: true,
  };

  const ctx: GameContext = {
    renderer,
    scene,
    camera,
    canvas,
    events,
    clock,
    input,
    terrain: null,
    assets: null,
    raw: null,
    nav: null,
    manifest: null,
    tuning: DEFAULT_PLAYER_TUNING,
    player,
    weapon: null,
    enemies: [],
    objectives: [],
    systems: {
      weapon: null,
      enemies: null,
      objectives: null,
      audio: null,
      hud: null,
      effects: null,
    },
    running: true,
    requestStop() {
      stopped = true;
    },
  };

  // --- Subsystems ----------------------------------------------------------
  const playerController = createPlayerController(ctx);
  const cameraController = createCameraController(ctx);
  const weaponSystem = createWeaponSystem(ctx);
  const enemyManager = createEnemyManager(ctx);
  const objectiveTracker = createObjectiveTracker(ctx);
  const audio = createAudioManager();
  const hud = createHud(ctx);
  const effects = createEffects(ctx);

  ctx.systems.weapon = weaponSystem;
  ctx.systems.enemies = enemyManager;
  ctx.systems.objectives = objectiveTracker;
  ctx.systems.audio = audio;
  ctx.systems.hud = hud;
  ctx.systems.effects = effects;

  // --- Audio cues from gameplay events ------------------------------------
  const audioBindings: Array<() => void> = [
    events.on(GameEvent.Fire, () => audio.play("fire")),
    events.on(GameEvent.DryFire, () => audio.play("dryfire")),
    events.on(GameEvent.ReloadStart, () => audio.play("reload")),
    events.on(GameEvent.Hit, () => audio.play("hit")),
    events.on(GameEvent.EnemyKilled, () => audio.play("death")),
    events.on(GameEvent.PlayerHit, () => audio.play("playerhit")),
    events.on(GameEvent.ObjectiveComplete, () => audio.play("objective")),
    events.on(GameEvent.MissionComplete, () => audio.play("complete")),
  ];

  // --- End-of-mission overlays ---------------------------------------------
  events.on(GameEvent.PlayerDied, () => {
    ctx.running = false;
    hud.showOverlay("YOU DIED — CLICK TO RESTART");
    input.exitLock();
  });
  events.on(GameEvent.MissionComplete, () => {
    ctx.running = false;
    hud.showOverlay("MISSION COMPLETE");
    input.exitLock();
  });

  // --- Level load ----------------------------------------------------------
  void loadLevel(ctx).then((result) => {
    loaded = result;
    enemyManager.spawn(4);
    hud.showOverlay("CLICK TO PLAY");
  });

  function resetLevel(): void {
    player.health = player.maxHealth;
    player.alive = true;
    player.velocity = [0, 0, 0];
    player.pitch = 0;
    ctx.enemies.length = 0;
    ctx.objectives = ctx.objectives.map((o) => ({ ...o, completed: false }));
    const spawn = ctx.manifest?.playerSpawn;
    if (spawn) {
      player.position = [...spawn.position] as Vec3;
      player.yaw = spawn.yaw * DEG2RAD;
    }
    if (ctx.terrain) {
      player.position[1] = Math.max(
        player.position[1],
        ctx.terrain.heightAt(player.position[0], player.position[2]) + 0.1,
      );
    }
    if (ctx.weapon) {
      ctx.weapon.ammo = ctx.weapon.spec.magSize;
      ctx.weapon.reserve = 90;
      ctx.weapon.reloading = false;
      ctx.weapon.reloadRemaining = 0;
      ctx.weapon.cooldownRemaining = 0;
    }
    ctx.systems.enemies?.spawn(4);
    ctx.running = true;
  }

  // --- Start / restart gesture ---------------------------------------------
  const onClick = () => {
    audio.resume();
    if (!ctx.player.alive) {
      resetLevel();
      hud.showOverlay(null);
      input.requestLock();
      return;
    }
    if (!ctx.running) {
      ctx.running = true;
      hud.showOverlay(null);
    }
    input.requestLock();
  };
  canvas.addEventListener("click", onClick);

  const onResize = () => resize();
  window.addEventListener("resize", onResize);

  // --- Frame loop ----------------------------------------------------------
  let raf = 0;
  const frame = (now: number) => {
    if (stopped) return;
    const dt = clock.tick(now);

    if (input.isLocked && ctx.running && ctx.player.alive) {
      const [yawDelta, pitchDelta] = input.consumeLook();
      player.yaw += yawDelta;
      player.pitch = clamp(
        player.pitch + pitchDelta,
        ctx.tuning.pitchMinDeg * DEG2RAD,
        ctx.tuning.pitchMaxDeg * DEG2RAD,
      );
      player.running = input.run;
      player.crouching = input.crouch;

      playerController.update(dt);
      cameraController.update(dt);
      weaponSystem.update(dt);
      enemyManager.update(dt);
      objectiveTracker.update(dt);
      effects.update(dt);

      if (input.wasPressed("KeyR")) weaponSystem.reload();
    } else {
      // Still integrate the camera so the view tracks a paused-but-visible world.
      cameraController.update(dt);
    }

    hud.update(dt);
    input.endFrame();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return {
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
      for (const off of audioBindings) off();
      events.clear();
      input.dispose();
      hud.dispose();
      effects.clear();
      loaded?.textures.dispose();
      canvas.removeEventListener("click", onClick);
      window.removeEventListener("resize", onResize);
      dispose();
    },
  };
}

