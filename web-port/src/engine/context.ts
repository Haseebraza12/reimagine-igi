/**
 * GameContext — the single frozen integration contract shared by every engine
 * subsystem. This is the backbone the whole port is wired through: core systems
 * (input/clock/events/render/terrain) populate it, and gameplay systems
 * (player/weapons/AI/objectives/HUD/audio) read and mutate it. Subsystems never
 * import each other directly; they communicate through `ctx` and `ctx.events`.
 *
 * Confidence: scaffolding. Field *names/semantics* are this project's choice;
 * values loaded from the level manifest / generated JSON are recovered or
 * inferred per docs/evidence-ledger.md.
 */
import type * as THREE from "three";
import type { LevelManifest, ObjectiveSpec, Vec3, WeaponSpec } from "../contracts";
import { Clock } from "./clock";
import { EventBus } from "./events";
import { Input } from "./input";
import { TerrainField } from "./terrain";

/** Live, mutable player state (feet-based position + look angles). */
export interface PlayerState {
  position: Vec3;
  velocity: Vec3;
  /** Yaw in radians (0 = -Z, increasing counter-clockwise seen from above). */
  yaw: number;
  /** Pitch in radians, clamped to PlayerTuning pitch range. */
  pitch: number;
  grounded: boolean;
  crouching: boolean;
  running: boolean;
  health: number;
  maxHealth: number;
  alive: boolean;
}

/** Live, mutable weapon state for the single carried weapon of the slice. */
export interface WeaponState {
  spec: WeaponSpec;
  ammo: number;
  reserve: number;
  reloading: boolean;
  /** Seconds remaining on the current reload (0 when not reloading). */
  reloadRemaining: number;
  /** Seconds until the next shot is allowed (cyclic rate + spread recovery). */
  cooldownRemaining: number;
}

/** Runtime enemy tracked by the AI manager and rendered by the render layer. */
export interface Enemy {
  id: number;
  position: Vec3;
  yaw: number;
  health: number;
  alive: boolean;
  /** Current AI behaviour label (for HUD/debug). */
  state: "idle" | "patrol" | "alert" | "engage" | "dead";
  /** Three.js object for this enemy, added to the scene by the AI manager. */
  object: THREE.Object3D | null;
  /** Optional patrol route as nav-node indices (from the level graph). */
  patrol: number[];
  patrolCursor: number;
}

/** Runtime objective with completion tracking. */
export interface ObjectiveState {
  spec: ObjectiveSpec;
  completed: boolean;
}

/** Optional subsystem slots. Each is created by its owning module and attached
 *  to the context by game.ts; declared optional so the engine boots even when
 *  a subsystem is disabled or fails to initialise. */
export interface GameSubsystems {
  weapon: import("./combat/weapon").WeaponSystem | null;
  enemies: import("./combat/enemy").EnemyManager | null;
  objectives: import("./combat/objectives").ObjectiveTracker | null;
  audio: import("./audio/audio").AudioManager | null;
  hud: import("./ui/hud").Hud | null;
  effects: import("./fx/effects").Effects | null;
}

export interface GameContext {
  /** Three.js renderer/scene/camera (see render/renderer.ts). */
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;

  /** Core services. */
  events: EventBus;
  clock: Clock;
  input: Input;

  /** Terrain collision field (null before a level loads). */
  terrain: TerrainField | null;

  /** Asset source for converted web assets (public/assets). null before load. */
  assets: import("../contracts").IAssetSource | null;
  /** Raw original-file asset source (public/raw). null before load. */
  raw: import("../contracts").IAssetSource | null;
  /** Loaded navigation graph from the level (null when absent). */
  nav: import("../contracts").NavGraph | null;

  /** Loaded level manifest (null before a level loads). */
  manifest: LevelManifest | null;

  /** Gameplay tuning defaults (may be overridden by generated JSON later). */
  tuning: import("../contracts").PlayerTuning;

  /** Live gameplay state. */
  player: PlayerState;
  weapon: WeaponState | null;
  enemies: Enemy[];
  objectives: ObjectiveState[];

  /** Optional subsystems. */
  systems: GameSubsystems;

  /** True while the mission is running (paused when pointer unlocked + menu). */
  running: boolean;

  /** Request a clean shutdown (stops the frame loop). */
  requestStop(): void;
}
