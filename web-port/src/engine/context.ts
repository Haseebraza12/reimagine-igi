/**
 * GameContext — the integration contract shared by every engine subsystem.
 * Core systems (input/clock/events/render/world) populate it; gameplay systems
 * (player/weapon/AI/objectives/HUD/audio) read and mutate it. Subsystems talk
 * through `ctx` and `ctx.events` instead of importing each other.
 *
 * Positions are engine space: metres, y up (see loaders/coords.ts). Values
 * that come from the original files are documented where they are loaded
 * (loaders/level.ts); gameplay constants that are not recovered are marked
 * "inferred" where they are defined.
 */
import type * as THREE from "three";
import type { PlayerTuning, Vec3 } from "../contracts";
import type { IgiLevel, LevelArea, LevelWeapon } from "../loaders";
import type { Clock } from "./clock";
import type { EventBus } from "./events";
import type { Input } from "./input";
import type { PlayArea } from "./world/character";
import type { CollisionWorld } from "./world/collision";

/** Live player state; `position` is the feet. */
export interface PlayerState {
  position: Vec3;
  velocity: Vec3;
  /** Radians; 0 looks along -z (IGI north), increasing counter-clockwise from above. */
  yaw: number;
  pitch: number;
  grounded: boolean;
  crouching: boolean;
  running: boolean;
  /**
   * Remaining health in the original's damage units: maxHealth = the player's
   * damage capacity (humanplayer.qvm, 3.0); health = maxHealth - damage taken.
   */
  health: number;
  maxHealth: number;
  alive: boolean;
  /** Walk instead of run (ToggleWalkRun). */
  walking: boolean;
  /** Camera height above the feet: pelvis (animated root) + 0.69 m standing / 0.35 m crouched. */
  eyeHeight: number;
  /** View kick offsets (radians) added to the view; they decay x0.9 per tick. */
  kickPitch: number;
  kickYaw: number;
  /** Lean (Peek) camera offsets in metres: sideways (+right) and up. */
  leanSide: number;
  leanUp: number;
}

/** Live state of the carried weapon. */
export interface WeaponState {
  spec: LevelWeapon;
  ammo: number;
  reserve: number;
  reloading: boolean;
  reloadRemaining: number;
  cooldownRemaining: number;
  /** Seconds the trigger has been held continuously (drives spread growth). */
  heldSeconds: number;
}

export type EnemyState = "idle" | "patrol" | "alert" | "engage" | "search" | "dead";

/** Runtime soldier. `position` is the feet. */
export interface Enemy {
  id: number;
  taskId: number;
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  /** 1 = full health, 0 = dead (IGI stores soldier health on a 0..1 scale). */
  health: number;
  alive: boolean;
  state: EnemyState;
  aiType: string;
  weapon: LevelWeapon | null;
  object: THREE.Object3D | null;
}

export interface ObjectiveState {
  id: string;
  text: string;
  area: LevelArea;
  completed: boolean;
}

export interface MessageState {
  id: string;
  text: string;
  area: LevelArea;
  shown: boolean;
}

/**
 * The level's task runtime (objects.qvm tasks at 30 Hz): task member
 * variables and condition expressions, as igi.exe evaluates them
 * (docs/qvm-vm.md "Expression language", docs/mission.md).
 */
export interface TaskRuntimeApi {
  /** Value of a task member such as "AreaActivate_303.nActive"; undefined when no such member exists. */
  member(name: string): number | undefined;
  /**
   * Evaluate an objects.qvm condition string in float mode, with `this.`
   * resolving to `selfName` (the owning task's "<Type>_<id>").
   */
  condition(expression: string, selfName: string): number;
  /** Is the task (by id) in the world, i.e. no enclosing ConditionalContainer has removed it? */
  inWorld?(taskId: number): boolean;
  /**
   * Perception phase (0..3) a HumanAI task (by id) took from the process-wide
   * counter DAT_005c4a48 at this mission's load (loaders/mission.ts
   * perceptionPhases); undefined when unknown.
   */
  perceptionPhase?(taskId: number): number | undefined;
}

export interface GameSubsystems {
  weapon: import("./combat/weapon").WeaponSystem | null;
  enemies: import("./combat/enemy").EnemyManager | null;
  objectives: import("./combat/objectives").ObjectiveTracker | null;
  audio: import("./audio/audio").AudioManager | null;
  hud: import("./ui/hud").Hud | null;
  effects: import("./fx/effects").Effects | null;
  /** Task runtime; null until the level is loaded. */
  tasks: TaskRuntimeApi | null;
  player: import("./player/player").PlayerController | null;
}

export interface GameContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  events: EventBus;
  clock: Clock;
  input: Input;

  /** Decoded level (null until loaded). */
  level: IgiLevel | null;
  /** Static collision for terrain + placed geometry (null until loaded). */
  world: CollisionWorld | null;
  /** Horizontal area with full-detail terrain collision; characters are kept inside it. */
  playArea: PlayArea | null;
  tuning: PlayerTuning;

  player: PlayerState;
  weapon: WeaponState | null;
  enemies: Enemy[];
  objectives: ObjectiveState[];
  messages: MessageState[];
  systems: GameSubsystems;
  /**
   * The player's first-person view object (igi.exe arms task, human+0x4ec):
   * arms clip, sway, shake / dip, FOV tangents and the scope flag
   * (player/first-person.ts). Created by the weapon system; read by the
   * camera and the arms renderer.
   */
  firstPerson?: import("./player/first-person").FirstPersonState;

  /** Game ticks simulated since the mission (re)started (30 per second, clock.ts). */
  tick: number;
  /**
   * The application tick *(DAT_00563dfc + 0x34) (FUN_00402a30) [recovered]:
   * reset to 0 at each level load / restart (FUN_004029a0), +1 after every
   * main-loop tick (FUN_00402250, 0x4023ce), also while the in-game menu
   * pauses the Game task (Game +0xe0 only stops FUN_00415306 from updating its
   * children; the MenuManager sets it, FUN_00415c60). So it runs ahead of
   * `tick` by the paused ticks. The perception phase tests of the soldiers
   * (FUN_00487b70) and the security cameras read it; when absent they use
   * `tick`.
   */
  appTick?: number;
  /**
   * The level RNG at DAT_00577b78 + 0x2c (FUN_00415c20), seeded 0x19111911 at
   * level start (FUN_00415c90). igi.exe draws the AI, gun spread and kick,
   * bullet ricochet / penetration and sound picks from this one generator.
   */
  rng: import("./ai/rng").LevelRng;
  /** The 4:3 game frame in CSS pixels (render/renderer.ts); the HUD is laid out in it. */
  frame: import("./render/renderer").FrameRect;

  /** True while the mission simulation runs. */
  running: boolean;
  /** "loading" | "ready" | "playing" | "complete" | "failed" | "error". */
  phase: GamePhase;
  requestStop(): void;
}

export type GamePhase = "loading" | "ready" | "playing" | "complete" | "failed" | "error";
