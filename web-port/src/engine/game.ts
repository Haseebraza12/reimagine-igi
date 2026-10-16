/**
 * Game orchestrator: builds the GameContext, runs the original's flow and the
 * frame loop.
 *
 * Flow (docs/hud.md "Launch-to-play", docs/mission.md): main menu -> Select
 * Mission -> loading screen (9 steps) -> the level's own task logic, which
 * starts with the intro cut-scene (Esc breaks it) and hands control to the
 * player -> Esc opens "Game Paused"; failure and completion follow the
 * recovered flows (radio message + pause menu; loading screen -> main menu).
 * The intro movies (Indeo 5 video) cannot be played in a browser and are
 * skipped, so the port starts at the main menu.
 *
 * Game logic runs in fixed 30 Hz ticks (clock.ts); rendering shows the
 * latest state each frame.
 *
 * URL parameters (for automated checks; ignored otherwise):
 *   ?shot=x,y,z,yawDeg,pitchDeg  load straight into the level and render a fixed view
 *   ?shot=spawn                  render the player's spawn view
 *   ?test[&mission=N]            load straight into the level (mission N, default 1) and expose
 *                                window.__igiTest (simulates without pointer lock)
 *   ?menutest                    normal boot to the main menu, exposing window.__igiMenu
 */
import * as THREE from "three";
import { DEFAULT_PLAYER_TUNING, type Vec3 } from "../contracts";
import { createHttpAssetSource } from "../loaders";
import { Clock, TICK_SECONDS } from "./clock";
import { EventBus, GameEvent } from "./events";
import { Input } from "./input";
import { createRenderer } from "./render/renderer";
import { createCutsceneFilterRenderer } from "./render/cutscene-filters";
import { DAMAGE_EVENTS, attachDamageSystem, createDamageSystem, missionRuntimeBridge } from "./combat/object-damage";
import type { GameContext, PlayerState } from "./context";
import { createPlayerController } from "./player/player";
import { computeEye, createCameraController } from "./player/camera";
import { createWeaponSystem } from "./combat/weapon";
import { createEnemyManager } from "./combat/enemy";
import { createIgiAudio, listenerFromMatrix } from "./audio/audio";
import { LEVEL1_AUDIO_PATHS, LEVEL1_SOUND_FILES, audioPathsFor } from "./audio/igi-audio";
import { LEVEL1_MISSION, levelPathsFor } from "../loaders";
import { applyPerformanceFlags } from "./world/performance";
import { allWeaponIds, noCheats, type CheatState } from "./cheats";
import { createHud } from "./ui/hud";
import { createEffects } from "./fx/effects";
import { createPickupRenderer } from "./render/pickups";
import { createSmokeEmitters } from "./fx/smoke-emitter";
import { createGrenadeRenderer } from "./render/grenades";
import { grenadeSystemOf } from "./combat/grenade";
import { createPlayerBodyRenderer } from "./render/player-body";
import { createMissionSystem } from "./mission/mission-system";
import { attachWorldTasks, createWorldTasks } from "./world/world-tasks";
import { loadLevel, missingRawFiles, type LoadedLevel } from "./level";
import { TRI_BULLET, TRI_SIGHT } from "./world/collision";
import { LookController } from "./look";
import { readWeaponExtras } from "./combat/weapon-tags";
import { LEVEL_RNG_SEED, LevelRng } from "./ai/rng";
import { createCombatObjects } from "./combat/combat-objects";
import { isSoldierTaskType } from "../loaders/soldier-types";
import { createCombatModelRenderer } from "./render/combat-models";

export interface Game {
  stop(): void;
}

declare global {
  interface Window {
    /** Set when a ?shot= view has been rendered (automation hook). */
    __igiShot?: "ready" | "error";
    /** ?test automation hook. */
    __igiTest?: {
      ctx: GameContext;
      start(): void;
      key(code: string, down: boolean): void;
      /** Hold/release every key bound to an original action (e.g. "MoveUp", "Crouch"). */
      action(name: string, down: boolean): void;
      /** Break the intro cut-scene (as Esc does) until the player is in the world. */
      skipIntro(): void;
      fire(down: boolean): void;
      /** The audio system (mixer, sound events) for inspection. */
      audio: ReturnType<typeof createIgiAudio>;
      /** The combat task objects (stationary guns, turrets, projectiles) for inspection. */
      combat: ReturnType<typeof createCombatObjects>;
      /** Unload the mission and load `id` again from scratch (the mission-switch path), then reset it. */
      reloadMission(id?: number): Promise<void>;
    };
    /** ?menutest automation hook (the normal menu boot). */
    __igiMenu?: {
      audio: ReturnType<typeof createIgiAudio>;
      settings(): ReturnType<ReturnType<typeof createHud>["settings"]["snapshot"]>;
      ctx: GameContext;
    };
  }
}

const DEG = Math.PI / 180;
/** View pitch limit +-90 degrees (FUN_00463470) [recovered]. */
const PITCH_LIMIT = Math.PI / 2;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** Mission load steps shown on the loading screen (docs/hud.md: 9 for a level load, 5 for a restart). */
const LOAD_STEPS = 9;
const RESTART_STEPS = 5;

export function createGame(canvas: HTMLCanvasElement): Game {
  const display = createRenderer(canvas);
  const { renderer, scene, camera, resize, dispose } = display;
  const events = new EventBus();
  const clock = new Clock();
  const input = new Input(canvas);
  const params = new URLSearchParams(location.search);
  const shot = params.get("shot");
  const testMode = params.has("test");
  const raw = createHttpAssetSource("/raw/");
  // Cut-scene camera overlays (LINE / BAND / HANDICAM, docs/mission.md "Camera filters").
  const cutsceneFilters = createCutsceneFilterRenderer(renderer, raw);

  let stopped = false;
  let loaded: LoadedLevel | null = null;
  /** The mission number `loaded` holds. */
  let loadedMission: number | null = null;
  /** Its audio files (MISSION:sounds directory and listing). */
  let audioPaths = LEVEL1_AUDIO_PATHS;
  /** The mission is running (between hud.startMission() and quitting to the menu). */
  let missionActive = false;

  const player: PlayerState = {
    position: [0, 0, 0] as Vec3,
    velocity: [0, 0, 0] as Vec3,
    yaw: 0,
    pitch: 0,
    grounded: false,
    crouching: false,
    running: false,
    health: 3,
    maxHealth: 3,
    alive: true,
    walking: false,
    eyeHeight: 1.64,
    kickPitch: 0,
    kickYaw: 0,
    leanSide: 0,
    leanUp: 0,
  };

  const ctx: GameContext = {
    renderer,
    scene,
    camera,
    canvas,
    events,
    clock,
    input,
    level: null,
    world: null,
    playArea: null,
    tuning: DEFAULT_PLAYER_TUNING,
    player,
    weapon: null,
    enemies: [],
    objectives: [],
    messages: [],
    systems: { weapon: null, enemies: null, objectives: null, audio: null, hud: null, effects: null, tasks: null, player: null },
    tick: 0,
    // The application tick (FUN_00402a30): perception phases test it; it counts while paused too.
    appTick: 0,
    rng: new LevelRng(),
    // Port cheats (Configuration -> Cheats); the menu settings replace them once loaded.
    cheats: noCheats(),
    frame: display.frame,
    running: false,
    phase: "loading",
    requestStop() {
      stopped = true;
    },
  };

  // Use / Activate, doors included, run the recovered search (player/interact.ts).
  const playerController = createPlayerController(ctx, { interactions: { doors: true } });
  const look = new LookController();
  const cameraController = createCameraController(ctx);
  const weaponSystem = createWeaponSystem(ctx);
  const enemyManager = createEnemyManager(ctx);
  const mission = createMissionSystem(ctx);
  // combat: GuardGenerator, MineField, StationaryGun, AIStationaryGun(Holder), M203 / RPG projectiles (combat/combat-objects.ts).
  const combat = createCombatObjects(ctx, mission);
  const audio = createIgiAudio(ctx, { rng: ctx.rng });
  const effects = createEffects(ctx);
  // Weapon / ammo pickups (render/pickups.ts): the gun body or ammo model, vertex-lit, no animation.
  const pickupRenderer = createPickupRenderer(ctx, scene);
  // Thrown grenades in flight (135_01_1, vertex-lit; combat/grenade.ts).
  const grenadeRenderer = createGrenadeRenderer(ctx, scene);
  // combat: the stationary guns' and turrets' gun models, M203 grenades and RPG missiles (render/combat-models.ts).
  const combatModels = createCombatModelRenderer(ctx, scene);
  /**
   * The player's blob shadow [recovered]: every human gets one (FUN_0045d850 -> FUN_004d7960), and
   * its draw (FUN_004d7670) skips nobody, so the player sees it in first person too. It is drawn
   * while +0x7e8 (cleared by the ladder / fence / wire / attach entries, FUN_00462e70) and the ground
   * probe found ground (+0x7ec, FUN_00460fd0); placed like the soldiers' (combat/enemy.ts).
   */
  let playerShadow: ReturnType<typeof effects.createBlobShadow> | null = null;
  const updatePlayerShadow = () => {
    if (!ctx.level || !ctx.world) return;
    playerShadow ??= effects.createBlobShadow();
    const attached = playerController.interactions.attach.attached;
    const p = player.position;
    const hit = mission.playerInWorld && !attached ? ctx.world.raycast(p[0], p[1] + 0.5, p[2], 0, -1, 0, 50, TRI_BULLET) : null;
    if (!hit) {
      playerShadow.setVisible(false);
      return;
    }
    playerShadow.setVisible(true);
    const pose = playerController.bodyPose();
    const pelvis = pose ? pose.pelvis[1] : p[1] + 0.95;
    playerShadow.update(hit.point, hit.normal, pelvis - hit.point[1]);
  };
  /**
   * Security-camera beeps, the lens update's FUN_00440ca0 [recovered], at the lens (its pivot):
   * camera_beep_s restarts whenever it ended while the 90-tick count runs (holder +0x16c != 0) and
   * stops when it is 0; on isDetection (+0x169) camera_beep_l (a live target) or camera_beep_al (a
   * body or destroyed camera, +0x164) starts once and stops when isDetection clears; camera_move
   * plays while the head's sweep yaw changes (FUN_00440db0 0x441171).
   */
  const cameraBeeps = new Map<number, { s: ReturnType<typeof audio.playAt>; d: ReturnType<typeof audio.playAt>; m: ReturnType<typeof audio.playAt>; yaw: number }>();
  const updateCameraBeeps = () => {
    const rt = mission.runtime;
    if (!rt || !ctx.level) return;
    for (const cam of rt.tasks.securityCameras) {
      const st = rt.nodeState(cam.nodeIndex) as { nDetectionTime?: number; isDetection?: number; alert?: number; yaw?: number };
      let slot = cameraBeeps.get(cam.nodeIndex);
      if (!slot) {
        slot = { s: null, d: null, m: null, yaw: st.yaw ?? 0 };
        cameraBeeps.set(cam.nodeIndex, slot);
      }
      const lens = ctx.level.instances.find((i) => i.part === "scameraLens" && i.taskIndex === cam.nodeIndex);
      const at: [number, number, number] | null = lens ? [lens.matrix[12], lens.matrix[13], lens.matrix[14]] : null;
      if (slot.s && !slot.s.alive) slot.s = null;
      if (!st.nDetectionTime) {
        slot.s?.kill();
        slot.s = null;
      } else if (!slot.s && at) slot.s = audio.playAt("camera_beep_s", at);
      if (!st.isDetection) {
        slot.d?.kill();
        slot.d = null;
      } else if (!slot.d && at) slot.d = audio.playAt(st.alert ? "camera_beep_al" : "camera_beep_l", at);
      // FUN_00440db0's end (0x441171): camera_move while the sweep / tracking turned the head this pass.
      const yaw = st.yaw ?? 0;
      if (yaw === slot.yaw) {
        slot.m?.kill();
        slot.m = null;
      } else if (!slot.m && at) slot.m = audio.playAt("camera_move", at);
      slot.yaw = yaw;
    }
  };
  /**
   * Vehicle sounds (world/vehicles.ts sounds()): each Heli / Plane / Car runs its group
   * ("helicopter_1", "su27", the car type's +0x262 group) as a child of the vehicle with its
   * per-tick parameter block (thrust, playing[, speed x 0.001]) unless "Play sound" evaluates to
   * 0 (FUN_004316d0, FUN_00433690, FUN_0042e320; started once by FUN_004e6b00) [recovered]. A
   * vehicle out of the world (its container stopped) is not updated and keeps no voice [inferred].
   */
  const vehicleSounds = { level: null as unknown, objects: new Map<number, ReturnType<typeof audio.objectSound>>() };
  const updateVehicleSounds = () => {
    const vehicles = mission.vehicles;
    const level = ctx.level;
    if (!vehicles || !level) return;
    if (vehicleSounds.level !== level) {
      for (const o of vehicleSounds.objects.values()) o?.dispose();
      vehicleSounds.objects.clear();
      vehicleSounds.level = level;
    }
    for (const v of vehicles.sounds()) {
      const o = level.originIgi;
      const at: Vec3 = [(v.position[0] - o[0]) / 4096, (v.position[2] - o[2]) / 4096, -(v.position[1] - o[1]) / 4096];
      const known = vehicleSounds.objects.has(v.key);
      const obj = vehicleSounds.objects.get(v.key) ?? null;
      if (!v.on || !mission.inWorldNode(v.key)) {
        obj?.dispose();
        vehicleSounds.objects.delete(v.key);
        continue;
      }
      if (obj && obj.alive) obj.update(at, v.vars);
      else if (!known || obj) vehicleSounds.objects.set(v.key, audio.objectSound(v.group, at, v.vars)); // null: no such group (t80_sounds)
    }
  };
  // The player's own body: drawn outside view mode 1 and under cut-scene cameras (FUN_0045ddd0).
  const playerBody = createPlayerBodyRenderer(ctx, scene);
  const updatePlayerBody = () => {
    const thirdPerson = cameraController.viewMode() !== 1 || !!mission.cutscene;
    const pose = mission.playerInWorld && thirdPerson ? playerController.bodyPose() : null;
    playerBody.update(
      pose
        ? {
            clipId: pose.clipId,
            time: pose.time,
            loop: pose.loop,
            rootZ: pose.rootZ,
            feet: [pose.pelvis[0], pose.pelvis[1] - pose.rootZ / 4096, pose.pelvis[2]],
            yaw: pose.yaw,
            rotations: pose.rotations,
          }
        : null,
      ctx.weapon?.spec.scriptId ?? null,
    );
  };
  // Smoke tasks (the locomotives' exhaust, fx/smoke-emitter.ts): they follow their train.
  const smokeEmitters = createSmokeEmitters({
    runtime: () => mission.runtime,
    // Any vehicle parent (train locomotive, heli, car, plane: world/vehicles.ts nodePose).
    trainPose: (node) => mission.vehicles?.nodePose(node) ?? null,
    particles: () => effects.particles,
    particleRng: () => effects.particleRng,
    originIgi: () => ctx.level?.originIgi ?? [0, 0, 0],
  });
  // Object damage and explosions (glass, barrels, terminals, cameras; docs/damage.md).
  const damage = createDamageSystem(ctx);
  attachDamageSystem(ctx, damage);
  // Rotating dishes, alarm lights, sirens and rain / snow (world/world-tasks.ts).
  const worldTasks = createWorldTasks(ctx, {
    runtime: () => mission.runtime,
    world: () => loaded?.world ?? null,
    audio: () => audio,
    inWorldNode: (node) => mission.inWorldNode(node),
  });
  attachWorldTasks(ctx, worldTasks);
  const hud = createHud(ctx, {
    source: raw,
    // The damage tint's (rand + 1) x 0.4 comes from the level RNG (FUN_00415c20 at 0x4125a8).
    random: () => ctx.rng.float(),
    // game.ts drives the hit tint (after the shake, as the exe draws them).
    autoHitTint: false,
    callbacks: {
      onSound: (name) => audio.playMenu(name),
      onStartMission: (id) => void startMission(id),
      onResume: () => setRunning(true),
      onRestart: () => void restartMission(),
      onQuit: () => quitToMenu(),
      // Main menu -> Quit -> Yes (MENUMANAGER_QUIT): igi.exe ends; the port closes the page.
      onExit: () => exitGame(),
      onPause: () => setRunning(false),
      requestLock: () => {
        audio.resume();
        input.requestLock();
      },
      releaseLock: () => input.exitLock(),
      // Map computer clicks and zoom (FUN_004dddc0, 2-D at volume 1).
      onGameSound: (name) => void audio.play2D(name),
      onSettingsChanged: (settings, what) => {
        // FX volume = the DirectSound master scale; the music volume levels the menu music
        // (igi.exe: the CD mixer line, docs/audio.md "Menu music").
        if (what === "volume" || what === "profile") {
          audio.mixer.fxVolume = settings.fxVolume;
          updateMenuMusic();
        }
        // Controls OK: the remapped GOInRemap bindings. GOInMouInv / GOInMouSens have no reader in the
        // look code (engine/look.ts); the map computer pointer reads the invert field itself.
        // Content Control: the profile's blood flag (+0x8), read at every hit (FUN_00462710).
        if (what === "content" || what === "profile") effects.setBlood(settings.bloodEnabled);
        // Graphics > Resolution: the display mode the frame is rendered at.
        if (what === "graphics" || what === "profile") display.setRenderResolution({ width: settings.resolution.w, height: settings.resolution.h });
        // Configuration -> Cheats (engine/cheats.ts): read by the weapon, player, soldier and camera code.
        applyCheats(settings.cheats);
        if (what === "controls") {
          input.setBindings(settings.bindings);
          applyInvert(settings.invertField);
          mouseSensitivity = settings.mouseSensitivity;
        }
      },
      // Idle main menu: Flow 8 would loop eidos.avi + innerloop.avi (Indeo 5, not decoded here) until Esc.
      onAttract: () => hud.showMainMenu(),
    },
  });
  // The dead player's hand item drops where the hand is (FUN_004e9010 -> GunPickup, combat/pickups.ts).
  events.on("game:player-release-item", (payload) => {
    const weaponId = (payload as { weaponId?: string } | undefined)?.weaponId;
    if (!weaponId) return;
    const p = player.position;
    const at = playerBody.gunPosition() ?? ([p[0], p[1] + 1, p[2]] as [number, number, number]);
    playerController.pickups.drop(weaponId, at, player.yaw);
  });
  // State 45 (the map computer) opens and closes the HUD's Computer (FUN_0046aba0 / FUN_0046abd0).
  events.on("game:map-computer", (payload) => {
    const open = (payload as { open?: boolean } | undefined)?.open;
    if (open) hud.openMapComputer();
    else hud.closeMapComputer();
  });
  Object.assign(ctx.systems, {
    player: playerController,
    weapon: weaponSystem,
    enemies: enemyManager,
    tasks: mission,
    audio,
    hud,
    effects,
  });

  /** Menu music on the front-end menus only (not while loading or in a mission). */
  let frontEnd = false;
  function updateMenuMusic(): void {
    const s = hud.settings.snapshot();
    audio.setMenuMusic(frontEnd && !missionActive && s.music, s.musicVolume);
  }
  function setFrontEnd(on: boolean): void {
    frontEnd = on;
    updateMenuMusic();
  }

  /** Simulation on/off (the world runs while playing and not paused by a menu). */
  function setRunning(running: boolean): void {
    ctx.phase = running ? "playing" : "ready";
    ctx.running = running;
    audio.setPaused(!running);
  }

  // --- Event reactions (sound, HUD messages and tints subscribe themselves) ---
  const bindings: Array<() => void> = [
    events.on(GameEvent.Fire, (payload) => {
      const shooter = (payload as { shooter?: unknown } | undefined)?.shooter;
      if (shooter !== "player") return;
      // The AI hears the shot through this event itself (combat/enemy.ts).
      loaded?.viewModels.fire();
    }),
    events.on(GameEvent.ReloadStart, () => {
      loaded?.viewModels.reload();
    }),
    events.on(GameEvent.WeaponChanged, () => {
      loaded?.viewModels.select(ctx.weapon?.spec.scriptId ?? null);
    }),
    /**
     * The player's hit effects in the exe's level-RNG order (the hit speech already ran: the audio
     * listener is registered first):
     *   bullets FUN_004123e0: the shake draw, then one tint draw spread by the hit direction;
     *   melee FUN_00412c80: punched_0{1 odd | 2 even} by the step's low bit, the shake, then four
     *     corner draws (+0xdcc TL, +0xdd0 BL, +0xdd4 BR, +0xdd8 TR);
     *   explosions FUN_00412930: the four indicators the damage system drew (shake via its event).
     */
    events.on(GameEvent.PlayerHit, (payload) => {
      const p = (payload ?? {}) as { from?: [number, number, number]; explosion?: boolean; melee?: boolean; fall?: boolean; effectsDriven?: boolean };
      if (p.fall) return;
      p.effectsDriven = true;
      if (p.explosion) return;
      if (p.melee) audio.play2D((ctx.rng.step() & 1) === 0 ? "punched_02" : "punched_01");
      weaponSystem.firstPerson.effects.hitShake(() => ctx.rng.float());
      if (p.melee) {
        const corner = () => Math.fround((ctx.rng.float() + 1) * 0.4);
        const tl = corner();
        const bl = corner();
        const br = corner();
        const tr = corner();
        hud.setTintCorners(tl, tr, bl, br);
      } else {
        hud.hit(p.from ? hud.hitDirectionFrom(p.from) : null);
      }
    }),
    events.on(DAMAGE_EVENTS.PlayerExplosion, (payload) => {
      const ind = (payload as { indicators?: [number, number, number, number] | null } | undefined)?.indicators;
      if (ind) hud.setTintCorners(ind[0], ind[3], ind[1], ind[2]);
    }),
    events.on(GameEvent.PlayerDied, () => {
      hud.missionFailed({ playerDead: true });
    }),
    events.on(GameEvent.MissionComplete, () => {
      hud.missionComplete();
    }),
  ];

  /**
   * The profile's invert flag (config +0x538 = "Invert Mouse" == No, FUN_00403c20): FUN_0045cde0
   * (0x45ce64) negates the look channel when it is set. The shipped default (0) keeps the exe's
   * inverted look. ?look=normal / ?look=inverted override it (port option).
   */
  /** GOInMouSens of the profile (FUN_0045cde0 scales the look channels by clamp(s, 0.05, 1)). */
  let mouseSensitivity = 0.4000000059604645;
  const applyInvert = (field: number) => {
    const forced = new URLSearchParams(location.search).get("look");
    input.lookInverted = forced === "normal" ? false : forced === "inverted" ? true : field === 0;
  };

  // --- Mission lifecycle -------------------------------------------------------
  /** Reset every system to the mission start (the level's task logic restarts from tick 0). */
  function resetMission(): void {
    playerController.reset();
    weaponSystem.reset();
    loaded?.viewModels.select(ctx.weapon?.spec.scriptId ?? null, { instant: true });
    enemyManager.reset();
    effects.clear();
    audio.reset();
    clock.reset();
    ctx.tick = 0;
    ctx.appTick = 0; // FUN_004029a0 at a level load or restart
    ctx.rng.seed(LEVEL_RNG_SEED); // FUN_00415c90 at level start
    look.reset();

    if (ctx.level) mission.start(ctx.level);
    mission.attachWorld(loaded?.world ?? null);
    combat.reset();
    combat.attachWorld(loaded?.world ?? null);
    smokeEmitters.reset();
    // Every object intact, glass thresholds redrawn; the bridge writes into the fresh runtime.
    damage.reset();
    damage.setMissionBridge(mission.runtime ? missionRuntimeBridge(mission.runtime) : null);
    worldTasks.reset();
    // Cheat All Weapons: armed at every (re)start.
    if (ctx.cheats?.allWeapons) giveAllWeapons();
  }

  /** Cheat All Weapons: every weapon the level can draw, with a full clip and a full reserve. */
  function giveAllWeapons(): void {
    const level = ctx.level;
    if (!level) return;
    for (const id of allWeaponIds(level.weapons.values(), (m) => level.models.has(m))) weaponSystem.giveFull(id);
  }

  /** New cheat settings from the menus; All Weapons switched on during a mission arms the player at once. */
  function applyCheats(next: CheatState): void {
    const before = ctx.cheats ?? noCheats();
    ctx.cheats = { ...next };
    if (next.allWeapons && !before.allWeapons && missionActive && ctx.level) giveAllWeapons();
  }

  /** Load the level once (original files) with loading-screen progress. */
  /**
   * Load mission `missionId` (its folders come from its DefineMission, ui/assets.ts), replacing
   * another loaded mission first. Mission 1 when the menus have not listed it (?test, ?shot).
   */
  async function ensureLoaded(onStep: () => void, missionId = 1): Promise<void> {
    if (loaded && loadedMission === missionId) return;
    const info = hud.missionInfo(missionId);
    const location = info?.location ?? (missionId === 1 ? LEVEL1_MISSION : null);
    if (!location) throw new Error(`MISSION ${missionId} IS NOT INSTALLED\n\nIts files were not found in the staged game data.`);
    const paths = levelPathsFor(location);
    const missing = await missingRawFiles(raw, paths);
    if (missing.length) {
      throw new Error(
        "ORIGINAL GAME FILES NOT FOUND\n\nThis port reads your own Project I.G.I. installation.\n" +
          "From web-port/, run:  npm run stage\n(or IGI_GAME_DIR=/path/to/IGI npm run stage)\nthen reload this page.\n\n" +
          `Missing: ${missing.join(", ")}`,
      );
    }
    if (loaded) {
      // Another mission: its world, terrain, sky and arms go; the systems rebuild for the new level.
      loaded.dispose();
      loaded = null;
      loadedMission = null;
    }
    loaded = await loadLevel(ctx, raw, () => onStep(), paths);
    loadedMission = missionId;
    // The mission's MISSION:sounds listing: the staging manifest's, else level 1's built-in list.
    audioPaths = audioPathsFor(location.levelDir, info?.soundFiles ?? (missionId === 1 ? LEVEL1_SOUND_FILES : []));
    await damage.load(raw, ctx.level!, loaded.world);
    await worldTasks.load(raw, ctx.level!);
    // Zoom tags / task types of weaponconfig.qvm (combat/weapon-tags.ts), and the arms bound to the view object.
    weaponSystem.setWeaponExtras(readWeaponExtras(await raw.readBinary(ctx.level!.paths.weaponConfig)));
    loaded.viewModels.bind(ctx.firstPerson ?? null);
    // Shell casings: ejected from the first-person gun body, drawn in the gun layer (fx/debris.ts).
    loaded.viewModels.addToGunLayer(effects.casingLayer);
    const viewModels = loaded.viewModels;
    weaponSystem.setGunMatrixSource(() => viewModels.gunMatrix());
    await audio.load(raw, () => {}, { paths: audioPaths });
    onStep();
    // The selected profile's bindings (the menus start from config.qvm and may have remapped them).
    await hud.ready.catch(() => undefined);
    const menuSettings = hud.settings.snapshot();
    ctx.cheats = { ...menuSettings.cheats };
    input.setBindings(menuSettings.bindings.length > 0 ? menuSettings.bindings : ctx.level!.controls.bindings);
    applyInvert(menuSettings.invertField);
    mouseSensitivity = menuSettings.mouseSensitivity;
    effects.setBlood(menuSettings.bloodEnabled);
    // The profile's Sound FX volume (the DirectSound master scale, FUN_00494210).
    audio.mixer.fxVolume = menuSettings.fxVolume;
    weaponSystem.reloadSeconds = (id) => loaded?.viewModels.reloadSeconds(id) || (ctx.level?.weapons.get(id)?.reloadSeconds ?? 0);
  }

  function fail(error: unknown): void {
    console.error("[game] level failed to load:", error);
    const text = (error as Error).message;
    hud.showOverlay(text.startsWith("ORIGINAL GAME FILES") ? text : `FAILED TO LOAD THE LEVEL\n\n${text}\n\nSee the browser console for details.`);
    ctx.phase = "error";
    window.__igiShot = "error";
  }

  /** Select Mission -> OK: loading screen, load, then the mission (intro first). */
  async function startMission(missionId = 1): Promise<void> {
    let step = 0;
    setFrontEnd(false);
    hud.showLoading(0, LOAD_STEPS);
    try {
      await ensureLoaded(() => hud.showLoading(Math.min(LOAD_STEPS - 1, ++step), LOAD_STEPS), missionId);
    } catch (error) {
      fail(error);
      return;
    }
    hud.showLoading(LOAD_STEPS, LOAD_STEPS);
    // FUN_00405e50 at level load: the profile's performance flags (terrain / model LOD detail).
    applyPerformanceFlags(hud.settings.snapshot().performanceFlags);
    resetMission();
    hud.startMission();
    missionActive = true;
    setRunning(true);
  }

  /** Pause menu -> Restart Mission: loading screen (5 steps) and a fresh start. */
  async function restartMission(): Promise<void> {
    for (let i = 0; i <= RESTART_STEPS; i++) {
      hud.showLoading(i, RESTART_STEPS);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    applyPerformanceFlags(hud.settings.snapshot().performanceFlags);
    resetMission();
    hud.startMission();
    missionActive = true;
    setRunning(true);
  }

  /** The mission ended (quit or completed): back to the main menu (the HUD shows it). */
  function quitToMenu(): void {
    missionActive = false;
    setRunning(false);
    input.exitLock();
    // The mission's sounds end with it; the menus keep the output running.
    audio.reset();
    audio.setPaused(false);
    setFrontEnd(true);
  }

  // Canvas click while playing without the pointer (e.g. after Esc broke the
  // intro): capture it again. Menu clicks are handled by the HUD.
  const onClick = () => {
    audio.resume();
    if (missionActive && ctx.phase === "playing" && !input.isLocked && !hud.isMenuOpen()) input.requestLock();
  };
  canvas.addEventListener("click", onClick);
  const onAnyGesture = () => audio.resume();
  window.addEventListener("pointerdown", onAnyGesture);
  window.addEventListener("keydown", onAnyGesture);

  const onPointerLock = () => {
    if (input.isLocked || !missionActive || ctx.phase !== "playing") return;
    // Esc releases the pointer: during a cut-scene it is the break key,
    // otherwise it opens "Game Paused" (when the level allows the menu).
    if (!mission.playerInWorld || mission.cutscene) mission.requestBreak();
    else if (mission.menuEnabled) hud.openPauseMenu();
  };
  document.addEventListener("pointerlockchange", onPointerLock);

  const onResize = () => resize();
  window.addEventListener("resize", onResize);

  // --- Boot ------------------------------------------------------------------------
  void (async () => {
    try {
      if (shot || testMode) {
        hud.showOverlay("Loading Project I.G.I. — Mission 1…");
        // ?mission=N (automation): load that staged mission instead of mission 1.
        await hud.ready.catch(() => {});
        await ensureLoaded(() => {}, Math.max(1, Number(params.get("mission")) || 1));
        hud.showOverlay(null);
        resetMission();
        if (shot) {
          applyShot(shot);
          return;
        }
        window.__igiTest = {
          ctx,
          start: () => {
            resetMission();
            hud.startMission();
            missionActive = true;
            setRunning(true);
          },
          key: (code, down) => input.setKey(code, down),
          action: (name, down) => input.setAction(name, down),
          // Esc held through the intro: full world ticks (soldiers and mission, as the
          // frame loop runs them) until the player is in the world with no cut-scene.
          skipIntro: () => {
            // The first ticks start the intro (a fresh runtime has the player in the world).
            for (let i = 0; i < 4000 && (i < 2 || !(mission.playerInWorld && !mission.cutscene)); i++) {
              mission.requestBreak();
              damage.beginTick();
              enemyManager.update(TICK_SECONDS);
              mission.tick();
              smokeEmitters.tick();
              damage.endTick();
              worldTasks.tick();
              ctx.tick++;
              ctx.appTick = (ctx.appTick ?? 0) + 1;
            }
          },
          fire: (down) => input.setFiring(down),
          audio,
          combat,
          reloadMission: async (id = 1) => {
            setRunning(false);
            missionActive = false;
            loadedMission = -1; // forces ensureLoaded to dispose and load again
            await ensureLoaded(() => {}, id);
            resetMission();
          },
        };
        return;
      }
      await hud.ready;
      // The profile's display mode (GOGfxDisp, Graphics > Resolution) sizes the frame.
      const startSettings = hud.settings.snapshot();
      display.setRenderResolution({ width: startSettings.resolution.w, height: startSettings.resolution.h });
      ctx.cheats = { ...startSettings.cheats };
      // The menu archive (FUN_00416c40 loads it with the menus): clicks and the menu music.
      await audio.loadMenu(raw).catch((error) => console.info("[audio] menu sounds:", error));
      hud.showOverlay(null);
      hud.showMainMenu();
      ctx.phase = "ready";
      setFrontEnd(true);
      if (params.has("menutest")) window.__igiMenu = { audio, settings: () => hud.settings.snapshot(), ctx };
    } catch (error) {
      fail(error);
    }
  })();

  function applyShot(spec: string): void {
    ctx.phase = "ready";
    ctx.running = false;
    if (spec !== "spawn") {
      const [x, y, z, yaw, pitch] = spec.split(",").map(Number);
      if ([x, y, z].every(Number.isFinite)) {
        player.position = [x, y, z];
        player.yaw = (yaw || 0) * DEG;
        player.pitch = (pitch || 0) * DEG;
      }
    }
    cameraController.update(0);
    loaded?.environment.update(0, camera);
    pickupRenderer.update(playerController.pickups.items, (p) => playerController.pickups.inWorld(p));
    display.beginFrame();
    renderer.render(scene, camera);
    if (spec === "spawn") loaded?.viewModels.render(renderer, camera, 0);
    window.__igiShot = "ready";
  }

  // --- Frame loop -------------------------------------------------------------
  let raf = 0;
  const eye = new THREE.Vector3();
  const eyeQ = new THREE.Quaternion();
  const forward = new THREE.Vector3();
  /** First-person arms: one 30 Hz animation step, wall pull-back ray, reload sound triggers. */
  const tickViewModels = () => {
    if (!loaded) return;
    cameraController.update(0);
    // From the view object (the camera may be the third-person orbit in modes 3 / 5).
    computeEye(ctx, eye, eyeQ);
    forward.set(0, 0, -1).applyQuaternion(eyeQ);
    // The pull-back ray queries the visible faces like bullets (FUN_00463840 -> FUN_004c24c0, HSMC set 0).
    const hit = ctx.world?.raycast(eye.x, eye.y, eye.z, forward.x, forward.y, forward.z, 0.5, TRI_BULLET);
    const moving = Math.hypot(player.velocity[0], player.velocity[2]) > 0.1;
    loaded.viewModels.tick({ moving }, hit ? hit.distance : Infinity, (trigger) =>
      events.emit(GameEvent.AnimTrigger, { actor: "player", trigger, position: [eye.x, eye.y, eye.z] }),
    );
  };

  const mapCamera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 1000);
  const toEye = new THREE.Vector3();
  /** HUD items fed per rendered frame: binocular target squares (FUN_00470510) and the M203 counter (FUN_00471e40). */
  const updateHudItems = () => {
    hud.setM203Rounds(weaponSystem.handTaskType === "TASKTYPE_GUNM16A2" ? weaponSystem.reserveOf("AMMO_ID_M203") : null);
    if (!weaponSystem.binocularZoomed || !inControl()) {
      hud.setBinocularTargets(null);
      return;
    }
    const tanX = ctx.firstPerson?.tanX ?? 1;
    camera.getWorldPosition(eye);
    camera.getWorldDirection(forward);
    const list = [];
    for (const s of enemyManager.visibleSoldiers()) {
      toEye.set(s.eye[0], s.eye[1], s.eye[2]);
      const depth = toEye.clone().sub(eye).dot(forward);
      if (depth <= camera.near) continue;
      const ndc = toEye.clone().project(camera);
      if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) continue;
      const d = toEye.clone().sub(eye);
      const len = d.length();
      const hit = ctx.world?.raycast(eye.x, eye.y, eye.z, d.x / len, d.y / len, d.z / len, len, TRI_SIGHT);
      list.push({
        id: s.enemy.id,
        x: (ndc.x + 1) * 320,
        y: (1 - ndc.y) * 240,
        depth,
        // Human +0xa0: the bounding radius (model header +0x78 x scale 1; the frustum sphere test
        // FUN_004c5420 and the human draw 0x45e0be read it).
        radius: damage.modelRadius(s.model) / 4096 || 0.5,
        pixelsPerUnitAtUnitDepth: 320 / tanX,
        team: s.team,
        lineOfSight: !hit,
      });
    }
    hud.setBinocularTargets(list);
  };

  /** Ticks run at most per frame (after a long stall the game slows down instead of jumping). */
  const MAX_TICKS_PER_FRAME = 4;
  const inControl = () => mission.playerInWorld && !mission.cutscene && player.alive;
  const worldRunning = () => missionActive && ctx.phase === "playing" && (testMode || input.isLocked || !inControl());

  const frame = (now: number) => {
    if (stopped) return;
    const dt = clock.tick(now);
    const ticks = Math.min(clock.consumeFixedSteps(), MAX_TICKS_PER_FRAME);
    // While the game does not run (menus, pause), mouse motion is not kept for later.
    if (!worldRunning()) input.consumeMouse();
    for (let i = 0; i < ticks; i++) {
      const running = worldRunning();
      if (running) {
        damage.beginTick();
        if ((mission.cutscene || !mission.playerInWorld) && input.wasPressed("Escape")) mission.requestBreak();
        /** The HumanPlayer node's tick (FUN_00410a30): look, weapon keys, the player and weapon machines. */
        const playerStep = () => {
          if (inControl()) {
            // Look (FUN_0045fd00 / FUN_00463470): the mouse motion since the last tick turns the view.
            // While attached or using (ladder, wire, fence, terminal) the tick forces the view.
            // While the map computer is open its pointer takes the mouse (the HUD reads it).
            const [mx, my] = input.consumeMouse();
            if (!playerController.interactions.viewLocked && !hud.isMapComputerOpen()) {
              const view = look.tick(mx, my, ctx.firstPerson?.tanX ?? 1, player.yaw, player.pitch, input.lookInverted, mouseSensitivity);
              player.yaw = view.yaw;
              player.pitch = view.pitch;
            } else {
              // View mode 3 (attached / using): the mouse turns the third-person orbit (FUN_00481660).
              look.reset();
              cameraController.orbitTick(mx, my, input.lookInverted, mouseSensitivity);
              // Movement state 33: the mouse and Fire are the StationaryGun user's channels 0 / 1 / 6.
              if (combat.stationaryGuns.playerGun) combat.stationaryGuns.setPlayerInput(mx, my, input.lookInverted, mouseSensitivity, input.isFiring);
            }
            if (input.actionPressed("Reload")) weaponSystem.reload();
            // FUN_00410a30: no weapon selection while the map computer exists (FUN_0046abe0).
            if (!hud.isMapComputerOpen()) {
              if (input.actionPressed("NextWeapon")) weaponSystem.cycle();
              if (input.actionPressed("PrevWeapon")) weaponSystem.cycle(-1);
              for (let k = 1; k <= 9; k++) if (input.actionPressed(`WeaponCategory${k}`)) weaponSystem.selectCategory(k);
            }
            playerController.update(TICK_SECONDS);
            // FUN_0045f0f1: the use icon while a target exists and nothing is in use; FUN_004130c0: the progress bar.
            hud.setActionIcon(playerController.interactions.actionIcon);
            hud.setActionProgress(playerController.interactions.progress);
            weaponSystem.update(TICK_SECONDS);
            player.pitch = clamp(player.pitch, -PITCH_LIMIT, PITCH_LIMIT);
          } else {
            hud.setActionIcon(null);
            hud.setActionProgress(null);
            const [mx, my] = input.consumeMouse();
            look.reset();
            if (mission.playerInWorld && !mission.cutscene && !player.alive) {
              // State 47 keeps running (death clip, gravity, weapon S0) and view mode 5 orbits (FUN_004821d0).
              cameraController.orbitTick(mx, my, input.lookInverted);
              playerController.update(TICK_SECONDS);
              weaponSystem.update(TICK_SECONDS);
            }
          }
        };
        // The level's task tree in node order (FUN_004e2d60): doors, areas, vehicles and cut-scenes
        // before HumanPlayer_0, the soldiers (each HumanSoldier node, then its HumanAI) at their own
        // nodes (8 of them before the player in level 1), LevelFlow last.
        enemyManager.beginNodeTick(TICK_SECONDS);
        let playerTicked = false;
        let walked = false;
        mission.setNodeTick((type, taskId, nodeIndex) => {
          walked = true;
          if (type === "HumanPlayer") {
            playerTicked = true;
            playerStep();
          } else if (isSoldierTaskType(type) || type === "HumanAI") enemyManager.tickNode(taskId, type, nodeIndex);
        });
        mission.tick();
        mission.setNodeTick(null);
        smokeEmitters.tick();
        // The player's node was not reached (out of the world, e.g. the intro): its input side still runs.
        if (!playerTicked) playerStep();
        enemyManager.endNodeTick(!walked);
        // Explosions created this tick go off at its end (their first update, last children of Dynamic).
        damage.endTick();
        // Dish poses, lamp models / reflectors, siren sounds, rain steps of this tick (world/world-tasks.ts).
        worldTasks.tick();
        updateCameraBeeps();
        updateVehicleSounds();
        updatePlayerShadow();
        if (inControl()) tickViewModels();
        // Mixer update with the camera as the microphone (every 30 Hz tick).
        updateCamera();
        camera.updateMatrixWorld();
        audio.tick(listenerFromMatrix(camera.matrixWorld.elements));
        ctx.tick++;
      }
      hud.tick(running);
      effects.update(TICK_SECONDS, running);
      // Key presses are kept until a tick has seen them.
      input.endFrame();
      // The main loop's application tick (0x4023ce): it advances with the pause menu open as well.
      if (missionActive) ctx.appTick = (ctx.appTick ?? 0) + 1;
    }
    if (!shot) {
      display.beginFrame();
      if (loaded && missionActive) {
        updateCamera();
        loaded.environment.update(dt, camera);
        pickupRenderer.update(playerController.pickups.items, (p) => playerController.pickups.inWorld(p));
        grenadeRenderer.update(grenadeSystemOf(ctx).grenades);
        combatModels.update(combat.models());
        updatePlayerBody();
        const computerOpen = hud.isMapComputerOpen();
        const mapView = computerOpen ? hud.mapComputerView() : null;
        if (mapView) {
          // The map page: the world seen from 225 m straight above (its own camera, full 4:3 view).
          mapCamera.position.set(mapView.position[0], mapView.position[1], mapView.position[2]);
          mapCamera.up.set(mapView.up[0], mapView.up[1], mapView.up[2]);
          mapCamera.lookAt(mapView.position[0] + mapView.forward[0], mapView.position[1] + mapView.forward[1], mapView.position[2] + mapView.forward[2]);
          mapCamera.fov = mapView.fovYDegrees;
          mapCamera.near = camera.near;
          mapCamera.far = camera.far;
          mapCamera.updateProjectionMatrix();
          mapCamera.updateMatrixWorld();
          loaded.environment.update(dt, mapCamera);
          renderer.render(scene, mapCamera);
        } else if (!computerOpen) {
          renderer.render(scene, camera);
        }
        // Every rendered frame: the overlays' lifetime counts render frames (FUN_004ebe30).
        cutsceneFilters.draw(mission.filters);
        const view = mission.cutscene;
        if (view && view.barFraction > 0) display.letterbox(view.barFraction);
        else if (!view && inControl() && !computerOpen) loaded.viewModels.render(renderer, camera, dt);
        updateHudItems();
        hud.setPlayerView(cameraController.viewMode());
      }
      hud.draw();
    }
    raf = requestAnimationFrame(frame);
  };

  /** Player camera, or the running cut-scene's camera (priority 1000 > 300, docs/mission.md). */
  function updateCamera(): void {
    const view = mission.cutscene;
    if (view) {
      camera.position.set(view.position[0], view.position[1], view.position[2]);
      camera.quaternion.set(view.quaternion[0], view.quaternion[1], view.quaternion[2], view.quaternion[3]);
      if (camera.fov !== view.fovYDeg) {
        camera.fov = view.fovYDeg;
        camera.updateProjectionMatrix();
      }
    } else {
      cameraController.update(0);
      const fov = cameraController.fovYDeg(); // zoom (MP5SD, Dragunov, binoculars) included
      if (camera.fov !== fov) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
    }
  }
  raf = requestAnimationFrame(frame);

  /**
   * igi.exe's Quit ends the program. The port stops the engine and closes the tab; a browser lets a
   * page close itself only when the page opened it or the tab has no history, so otherwise the page
   * is replaced by a black "closed" screen (the game is no longer running either way).
   */
  function exitGame(): void {
    input.exitLock();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    api.stop();
    try {
      window.close();
    } catch {
      /* not closable */
    }
    window.setTimeout(() => {
      if (!window.closed) showClosedScreen();
    }, 150);
  }

  const api: Game = {
    stop() {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      for (const off of bindings) off();
      events.clear();
      input.dispose();
      hud.dispose();
      cutsceneFilters.dispose();
      effects.clear();
      pickupRenderer.dispose();
      grenadeRenderer.dispose();
      combatModels.dispose();
      combat.dispose();
      playerBody.dispose();
      playerShadow?.dispose();
      damage.dispose();
      worldTasks.dispose();
      loaded?.dispose();
      audio.dispose();
      canvas.removeEventListener("click", onClick);
      window.removeEventListener("pointerdown", onAnyGesture);
      window.removeEventListener("keydown", onAnyGesture);
      document.removeEventListener("pointerlockchange", onPointerLock);
      window.removeEventListener("resize", onResize);
      dispose();
    },
  };
  return api;
}

/** The page after Quit when the browser does not let it close itself. */
function showClosedScreen(): void {
  document.title = "Project I.G.I. — closed";
  for (const el of Array.from(document.body.children)) (el as HTMLElement).style.display = "none";
  const screen = document.createElement("div");
  screen.id = "closed";
  screen.style.cssText =
    "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#000;color:#9a9a9a;" +
    "font:16px/1.8 'Courier New',monospace;letter-spacing:1px;text-align:center;white-space:pre-line;padding:24px;box-sizing:border-box;";
  screen.textContent = "Project I.G.I. has quit.\nYou can close this tab now.\n\n(Reload the page to play again.)";
  document.body.appendChild(screen);
}
