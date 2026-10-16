/**
 * The level's task runtime in the engine: hosts the recovered MissionRuntime
 * (loaders/mission.ts, docs/mission.md) and connects it to the player,
 * soldiers, HUD, camera and audio.
 *
 * Recovered (docs/mission.md): every 30 Hz tick the Level root updates its
 * task tree in file order with per-type child rules; conditions are task
 * expressions in float mode; AreaActivate tests a human's origin (the
 * pelvis-level position, +0x20); ConditionalContainers add/remove task
 * subtrees to/from the world; StatusMessage sends radio messages; CutScene
 * cameras take over the view (priority 1000 vs the player's 300) with a
 * letterbox; LevelFlow decides complete / failed; Esc breaks cut-scenes
 * (LevelFlow_GetBreakCutSceneKey).
 * Vehicles (world/vehicles.ts, docs/vehicles.md): helicopters and cars run
 * their recovered physics from their AnimTasks (MissionHost.onAnimInput),
 * trains follow the runtime's train distances on the rail; cut-scene cameras
 * linked to / aimed at them use their current poses (taskPose).
 * Dynamic world entries (doors, vehicles, container contents) are keyed by
 * the task's node index (MissionTasks node index = IgiLevel.tasks index =
 * LevelInstance.taskIndex): a collision hit on a dynamic body reports
 * triangle = -1 - nodeIndex.
 * Camera filters (render/cutscene-filter-state.ts, docs/mission.md "Camera
 * filters"): every CutScene apply feeds the current key's FILTER, colours and
 * Noise to the session's CutsceneFilters (FUN_004ec230); the overlays live per
 * cut-scene and are destroyed by the FUN_004ebe30 rule (a later tick in
 * another render frame after the stop tick) or when the cut-scene's subtree
 * leaves the world (FUN_004ed0f0). The renderer draws `filters` each frame.
 * Security cameras (docs/mission.md "SCamera"): each lens (the camera head,
 * world-builder scameraLensKey) turns about its pivot to Rz(Holder Gamma +
 * Camera Gamma + sweep) Rx(pitch) from the runtime's yaw / pitch after every
 * tick (lens update FUN_004a9bc0 at 0x440c24); render, light and collision
 * follow, so bullets hit it where it is drawn.
 * Security-camera vision (docs/mission.md "SCamera vision"): the runtime asks
 * cameraSighting() from each lens update; the lens detector
 * (SecurityCameraDetector, FUN_00487b70) runs on its perception phase with the
 * eye at magic vertex 1 of the Camera Model under the previous update's lens
 * matrix, tests the registry (SCamera holders, then humans, in tree order) with
 * the lens cone and the AI sight ray (TRI_SIGHT, see-through product >= 0.79,
 * its own holder and lens and the target camera's skipped), and reports the
 * target and its bearing. Humans are seen as they were at the start of the tick
 * (the SCameras update before every human). securityCameraLights() gives the
 * alarm light quads (LAB_00441c50) for fx/alarm-lights.ts.
 * Not available yet: terminal hacking and lock picking timers, the cameras'
 * sounds.
 */
import * as THREE from "three";
import {
  MissionRuntime,
  SecurityCameraDetector,
  applyCameraLink,
  apply3,
  doorPose,
  buildMissionTasks,
  cameraLookAt,
  eulerToMatrix,
  igiPointToEngine,
  letterboxBarHeight,
  perceptionPhases,
  securityCameraBearing,
  securityCameraCone,
  securityCameraInViewCone,
  securityCameraLensMatrix,
  securityCameraLight,
  type CameraDetectable,
  type CameraSighting,
  type CutSceneCameraSample,
  type CutSceneTask,
  type IgiLevel,
  type IgiTask,
  type MissionHuman,
  type MissionNode,
  type SecurityCameraCone,
  type SecurityCameraTask,
  type TaskPose,
  type Vec3,
} from "../../loaders";
import { NO_MATERIAL, aiSightPasses, sightTransmission } from "../../loaders/collision-mesh";
import type { GameContext, TaskRuntimeApi } from "../context";
import { GameEvent } from "../events";
import { createVehicleSystem, type MountedWeaponHooks, type VehicleSystem } from "../world/vehicles";
import { scameraLensKey, taskNodeOfKey } from "../world/world-builder";
import { TRI_SIGHT } from "../world/collision";
import { damageSystemOf } from "../combat/object-damage";
import { CutsceneFilters } from "../render/cutscene-filter-state";
import { isSoldierTaskType } from "../../loaders/soldier-types";
import { LevelRng } from "../ai/rng";
import { createObjectPresenter, type ObjectPresenter } from "./object-presenter";

const UNITS_PER_METRE = 4096;
/** Eye above the human origin (FUN_00464490): the origin is eye - 0.69 m standing / - 0.35 m crouched. */
const EYE_ABOVE_ORIGIN = { standing: 2826.24 / UNITS_PER_METRE, crouched: 1433.6 / UNITS_PER_METRE };

export interface CutsceneView {
  position: Vec3;
  quaternion: [number, number, number, number];
  /** Vertical FOV in degrees (tanY = 0.75 tanX, 4:3 frustum). */
  fovYDeg: number;
  /** Height of each letterbox bar as a fraction of the frame height. */
  barFraction: number;
  cutSceneId: number;
  /** Current key (k1) index and CAMERAFILTER_TYPE (0 none, 1 line, 2 band, 3 band update, 4 handicam). */
  keyIndex: number;
  filter: number;
  /** True on the tick the key index changed (filters rebuilt, FUN_004ec060). */
  cut: boolean;
  /** k1's own Filter color (line / handicam colour, band colour at the cut). */
  keyFilterColor: Vec3;
  /** Filter color interpolated linearly between k1 and k2 (band colour on every apply). */
  filterColor: Vec3;
  /** Interpolated Noise (line noise on every apply; band noise at the cut). */
  noise: number;
  /**
   * Interpolated Time of day (-1 keys -> the CutScene's), submitted with the
   * camera (FUN_004cfed0 -> camera +0x58). No reader in igi.exe: the lights
   * are interpolated at time 0 once at compile (docs/rendering.md), so it has
   * no visible effect.
   */
  timeOfDay: number;
}

export interface MissionSystem extends TaskRuntimeApi {
  readonly runtime: MissionRuntime | null;
  /** Build a fresh runtime for the loaded level (mission start / restart). */
  start(level: IgiLevel): void;
  /** One 30 Hz game tick. */
  tick(): void;
  /** The cut-scene camera of the last tick, or null when the player's view applies. */
  readonly cutscene: CutsceneView | null;
  /** The HumanPlayer task is in the world (false during the intro / outro). */
  readonly playerInWorld: boolean;
  /** No enclosing ConditionalContainer of task node `node` has its subtree out of the world. */
  inWorldNode(node: number): boolean;
  /** MenuManager_SetEnabled state (the in-game menu is disabled during cut-scenes). */
  readonly menuEnabled: boolean;
  readonly complete: boolean;
  readonly failed: boolean;
  /** Esc / break request for the next tick (LevelFlow_GetBreakCutSceneKey). */
  requestBreak(): void;
  /** Override a task's pose (moving vehicles, doors) for camera link/target and areas. */
  setTaskPose(taskId: number, pose: TaskPose): void;
  /** The built world whose dynamic tasks (doors, vehicles, container contents) follow the runtime. */
  attachWorld(world: MissionWorld | null): void;
  /**
   * The task-tree walk reached a node the runtime does not update itself (HumanPlayer, HumanSoldier,
   * HumanAI, ...): the game ticks that human there, in tree order (FUN_004e2d60). The node's
   * children are walked afterwards (a HumanAI under its HumanSoldier). Before the HumanPlayer tick
   * the dynamic tasks updated so far are applied to the world (doors, vehicles move first).
   */
  setNodeTick(tick: ((type: string, taskId: number, nodeIndex: number) => void) | null): void;
  /** Player "use" on a door task by id (FUN_00446c10): toggles it unless locked. Doors with id -1: useDoorNode. */
  useDoor(taskId: number): boolean;
  /**
   * Player "use" on the door with this node index (= the dynamic body id: a
   * ray hit with triangle < 0 hit body -1 - triangle). False when the node is
   * not a door or the door is locked.
   */
  useDoorNode(nodeIndex: number): boolean;
  /** Node index of the door owning dynamic body `bodyId` (= -1 - RayHit.triangle), or null. */
  doorOfBody(bodyId: number): number | null;
  /** The level's vehicles (null before start). */
  readonly vehicles: VehicleSystem | null;
  /** Cut-scene camera filter overlays (session-wide: RNG, time code and camera number persist across restarts). */
  readonly filters: CutsceneFilters;
  /**
   * Start of a game tick, before the player and the soldiers move: what the
   * security cameras see this tick when the humans move before tick() (they
   * update before every human in the task tree). Without this call the state at
   * the end of the previous mission tick is used; with setNodeTick the cameras
   * read the humans live (they are not moved yet when the SCameras update).
   */
  beginTick(): void;
  /** The alarm light quads of the switched-on cameras (LAB_00441c50), engine space, for fx/alarm-lights.ts. */
  securityCameraLights(): SecurityCameraLightQuad[];
  /** Lens detector of an SCamera node (diagnostics / tests), or null. */
  cameraDetector(node: number): SecurityCameraDetector | null;
  /** The full game's object tasks in the engine (elevators, pickups, drawers, sounds; object-presenter.ts). */
  readonly objects: ObjectPresenter;
  /**
   * A human about to take its platform's motion (dynamic body = task node `node`): an elevator whose
   * node has not run yet this tick updates now (FUN_0043e290 calls the elevator's update; its guard
   * keeps it to once per tick) and the world follows.
   */
  prepareRide(node: number): void;
  /**
   * Current pose (IGI) of task node `node`: an elevator's runtime pose, a vehicle's simulated pose,
   * a moved task's override, else its placement (Position, Orientation / Gamma); null when none.
   */
  poseOfNode(node: number): TaskPose | null;
  // --- combat: registered task behaviours (loaders/objects) ---------------------------------
  /** Receive the runtime's MissionHost.onTaskEvent (GuardGenerator spawns, MineField explosions, ...); returns the remover. */
  onTaskEvent(handler: (node: MissionNode, event: string, data?: unknown) => void): () => void;
  /** Answer MissionHost.query(name, ...args) for the registered behaviours (null removes it). */
  setTaskQuery(name: string, fn: ((...args: unknown[]) => unknown) | null): void;
  /** A HumanAI compiled at run time (a GuardGenerator spawn, FUN_00488000) takes the counter's next phase (FUN_00487ae0). */
  takePerceptionPhase(node: number): number;
  /** turrets: the vehicles' attached weapons (combat/vehicle-weapons.ts); the vehicle system calls them (null removes them). */
  setVehicleWeapons(hooks: MountedWeaponHooks | null): void;
}

/** One alarm light quad: screen-aligned at `position` (engine metres), colour (r, g, b) in the 1/128 scale, half-size metres. */
export interface SecurityCameraLightQuad {
  position: Vec3;
  rgb: Vec3;
  halfSize: number;
}

/** What the mission system needs from the built world (world/world-builder.ts BuiltWorld). Keys are task node indices. */
export interface MissionWorld {
  readonly dynamicTasks: ReadonlySet<number>;
  setTaskTransform(key: number, matrix: ArrayLike<number>): void;
  setInstanceTransform(i: number, matrix: ArrayLike<number>, copy?: number): void;
  setTaskHidden(key: number, hidden: boolean): void;
  /** Swap / remove a destructible instance (world-builder BuiltWorld; the exploded car's wreck). */
  setInstanceModel?(i: number, model: import("../../loaders").LevelModel | null): boolean;
}

/** IGI vector -> engine axes (x, z, -y). */
const conv = (v: readonly number[]): THREE.Vector3 => new THREE.Vector3(v[0], v[2], -v[1]);

export function createMissionSystem(ctx: GameContext): MissionSystem {
  let runtime: MissionRuntime | null = null;
  const objects = createObjectPresenter(ctx);
  let vehicles: VehicleSystem | null = null;
  let level: IgiLevel | null = null;
  let cutscene: CutsceneView | null = null;
  /** A cut-scene submitted its camera during the current tick (the camera with priority 1000 is per frame). */
  /** game.ts's per-node human tick (setNodeTick). */
  let nodeTick: ((type: string, taskId: number, nodeIndex: number) => void) | null = null;
  /**
   * A vehicle moved since its collision body was last placed. igi.exe moves a vehicle's object
   * in its own node update, so a rider (FUN_00461930) or any later node reads this tick's pose;
   * the world bodies follow before the next human node.
   */
  let vehiclesMoved = false;
  let cameraThisTick = false;
  /** Filter overlays; FUN_00499900 runs once per session. */
  const filters = new CutsceneFilters();
  /** Cut-scenes that applied their camera / stopped during the current tick (FUN_004ebe30 overlay lifetime). */
  const appliedThisTick = new Set<number>();
  const stoppedThisTick = new Set<number>();
  /** GetTickCount stand-in for the HandiCam's real-time clock (FUN_0048e780). */
  const nowMs = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
  let breakRequested = false;
  let menuEnabled = true;
  let complete = false;
  let failed = false;
  let failedAnnounced = false;
  /** Container node indices currently out of the world. */
  const outOfWorld = new Set<number>();
  const poseOverrides = new Map<number, TaskPose>();
  const teamOf = new Map<number, number>();
  const basis = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  let world: MissionWorld | null = null;
  /** Engine-space pose matrix of each door at mission start (its models were built there). */
  const doorInitial = new Map<number, THREE.Matrix4>();
  const hiddenTasks = new Map<number, boolean>();
  const engineMatrix = new THREE.Matrix4();
  const deltaMatrix = new THREE.Matrix4();
  /** SCamera lenses as placed by the loader (compile pose): pivot (IGI) and inverse build matrix, per SCamera node. */
  const lensPlacements = new Map<number, { pivot: Vec3; inverse: THREE.Matrix4 } | null>();
  /** Last yaw / pitch sent to the world per SCamera node (unchanged lenses are not re-posed). */
  const lensPosed = new Map<number, string>();

  /** IGI pose (units, rotation columns in IGI axes) -> engine 4x4 (metres; rotation C R C^T). */
  function poseToEngine(pose: TaskPose, out: THREE.Matrix4): THREE.Matrix4 {
    const m = pose.matrix;
    const x = conv([m[0], m[3], m[6]]);
    const y = conv([m[1], m[4], m[7]]);
    const z = conv([m[2], m[5], m[8]]);
    // Engine basis: columns C R C^T e_j = [conv(R e_x), conv(R e_z), -conv(R e_y)].
    const t = igiPointToEngine(pose.position, level!.originIgi);
    out.set(x.x, z.x, -y.x, t[0], x.y, z.y, -y.y, t[1], x.z, z.z, -y.z, t[2], 0, 0, 0, 1);
    return out;
  }

  /** Doors and vehicles to their current pose; dynamic tasks hidden while outside the world. */
  function syncWorld(): void {
    if (!world || !runtime || !level) return;
    for (const door of runtime.tasks.doors) {
      if (!world.dynamicTasks.has(door.nodeIndex)) continue;
      const state = runtime.doorStateAt(door.nodeIndex);
      if (!state) continue;
      const pose = doorPose(door, state);
      if (door.id >= 0) poseOverrides.set(door.id, pose);
      let initial = doorInitial.get(door.nodeIndex);
      if (!initial) {
        initial = poseToEngine(pose, new THREE.Matrix4()).invert();
        doorInitial.set(door.nodeIndex, initial);
      }
      // A door carried by an elevator (L14): its own motion, then the elevator's (0x547f40).
      const carry = objects.carried(door.nodeIndex);
      const placedPose = carry ? carry(pose) : pose;
      if (carry && door.id >= 0) poseOverrides.set(door.id, placedPose);
      deltaMatrix.multiplyMatrices(poseToEngine(placedPose, engineMatrix), initial);
      world.setTaskTransform(door.nodeIndex, deltaMatrix.elements);
    }
    objects.sync(world, poseToEngine);
    vehicles?.sync(world);
    syncSecurityCameras(world);
    for (const key of world.dynamicTasks) {
      const hidden = (!inWorldNode(taskNodeOfKey(key)) && !wrecks.has(key)) || objects.hidden(taskNodeOfKey(key));
      if (hiddenTasks.get(key) !== hidden) {
        hiddenTasks.set(key, hidden);
        world.setTaskHidden(key, hidden);
      }
    }
  }

  /**
   * SCamera lenses to the runtime's pose (lens update 0x440c24: FUN_004a9bc0(lens +0x70, pitch,
   * 0, sweep + Holder Gamma + Camera Gamma)); the pivot never moves. The transform maps the
   * loader's compile pose (pitch = Camera Alpha, no sweep) to the current one.
   */
  function syncSecurityCameras(target: MissionWorld): void {
    if (!runtime || !level) return;
    for (const cam of runtime.tasks.securityCameras) {
      const key = scameraLensKey(cam.nodeIndex);
      if (!target.dynamicTasks.has(key)) continue;
      let placed = lensPlacements.get(cam.nodeIndex);
      if (placed === undefined) {
        const instance = level.instances.find((i) => i.part === "scameraLens" && i.taskIndex === cam.nodeIndex);
        placed = instance
          ? { pivot: toIgi([instance.matrix[12], instance.matrix[13], instance.matrix[14]]), inverse: new THREE.Matrix4().fromArray(instance.matrix).invert() }
          : null;
        lensPlacements.set(cam.nodeIndex, placed);
      }
      if (!placed) continue;
      const s = runtime.nodeState(cam.nodeIndex);
      const yaw = s.yaw ?? 0;
      const pitch = s.pitch ?? cam.cameraAlpha;
      const posed = `${yaw}|${pitch}`;
      if (lensPosed.get(cam.nodeIndex) === posed) continue;
      lensPosed.set(cam.nodeIndex, posed);
      const pose: TaskPose = { position: placed.pivot, matrix: securityCameraLensMatrix(cam.holderGamma, cam.cameraGamma, yaw, pitch) };
      deltaMatrix.multiplyMatrices(poseToEngine(pose, engineMatrix), placed.inverse);
      target.setTaskTransform(key, deltaMatrix.elements);
    }
  }

  // --- Security-camera vision (docs/mission.md "SCamera vision") --------------------------------
  /**
   * DAT_005c4a48, the perception phase counter: process-wide (static 0, never reset), so it
   * carries over to a restarted mission (each load takes the lens and compile phases again).
   */
  let phaseCounter = 0;
  /** Node index -> phase this load handed out (lenses, HumanAI, Car, Heli, AIStationaryGunHolder). */
  let loadPhases = new Map<number, number>();
  interface CameraEye {
    detector: SecurityCameraDetector;
    cone: SecurityCameraCone;
    /** Placed instances of the holder and the lens (the sight ray skips both), -2 when absent. */
    holder: number;
    lens: number;
    /** Lens origin (+0x20) = the pivot, IGI units. */
    pivot: Vec3;
    /** "Camera Model" (magic vertex 1 = the eye, 0 = the light). */
    model: string;
  }
  const cameraEyes = new Map<number, CameraEye>();
  /**
   * Humans as the cameras see them this tick when the game moves them before mission.tick()
   * (no setNodeTick): their state at the start of the tick, from beginTick() or else from the end
   * of the previous tick. With node ticks the humans move at their place in the tree, after the
   * SCameras, so each lens reads them live.
   */
  let humanSnapshot: CameraDetectable[] | null = null;
  let nextSnapshot: CameraDetectable[] | null = null;
  let playerNode = -1;
  const soldierNodes = new Map<number, number>();
  /** Soldier origin above its feet when its AI is not loaded (the pelvis, about 0.95 m standing). */
  const SOLDIER_ORIGIN_M = 0.95;

  /** Magic vertex `i` of a model (XTVM, MefBounds from the damage data); none -> (0, 0, 0) like FUN_00486e20. */
  function magicVertex(model: string, i: number): Vec3 {
    const m = damageSystemOf(ctx)?.data?.bounds.get(model.toLowerCase())?.magic[i];
    return m ? [m[0], m[1], m[2]] : [0, 0, 0];
  }

  function setupCameraVision(): void {
    cameraEyes.clear();
    humanSnapshot = null;
    nextSnapshot = null;
    soldierNodes.clear();
    playerNode = -1;
    loadPhases = new Map();
    if (!runtime || !level) return;
    const lvl = level;
    const { phases, next } = perceptionPhases(runtime.tasks, phaseCounter);
    phaseCounter = next;
    loadPhases = phases;
    for (const n of runtime.tasks.nodes) {
      if (n.type === "HumanPlayer" && playerNode < 0) playerNode = n.index;
      if (isSoldierTaskType(n.type) && n.id >= 0 && !soldierNodes.has(n.id)) soldierNodes.set(n.id, n.index);
    }
    for (const cam of runtime.tasks.securityCameras) {
      const holder = lvl.instances.findIndex((i) => i.part === undefined && i.taskIndex === cam.nodeIndex);
      const lens = lvl.instances.findIndex((i) => i.part === "scameraLens" && i.taskIndex === cam.nodeIndex);
      const model = String(runtime.tasks.nodes[cam.nodeIndex].task.params["Camera Model"] ?? "");
      // The lens origin: the loader's placement (holder + Rz(Holder Gamma) x holder magic 0, FUN_00441290).
      const m = lens >= 0 ? lvl.instances[lens].matrix : null;
      const pivot = m ? toIgi([m[12], m[13], m[14]]) : ([...cam.holderPosition] as Vec3);
      cameraEyes.set(cam.nodeIndex, {
        detector: new SecurityCameraDetector(phases.get(cam.nodeIndex) ?? 0),
        cone: securityCameraCone(cam),
        holder: holder >= 0 ? holder : -2,
        lens: lens >= 0 ? lens : -2,
        pivot,
        model,
      });
    }
  }

  /**
   * The humans of the detectable registry in task-tree order (FUN_0045d850 registers them at
   * create): FUN_0045eaa0's team, alive, in-world flag and point (origin + 0.69 m standing /
   * 0.35 m crouched, FUN_00464490). The player's point is its eye (eyeHeight = origin + 0.69 /
   * 0.35 m, player.ts).
   */
  function captureHumans(): CameraDetectable[] {
    if (!runtime) return [];
    const out: Array<{ o: CameraDetectable; order: number }> = [];
    const p = ctx.player;
    if (playerNode >= 0) {
      out.push({
        o: {
          // Cheat Invisible To Enemies (engine/cheats.ts): the security cameras do not see the player.
          key: "player", kind: "human", node: playerNode, team: runtime.tasks.player?.team ?? 0, alive: p.alive, inWorld: inWorld(0) && ctx.cheats?.invisible !== true,
          point: toIgi([p.position[0], p.position[1] + p.eyeHeight, p.position[2]]),
        },
        order: -1,
      });
    }
    const enemies = ctx.systems?.enemies ?? null;
    let lastNode = -1;
    ctx.enemies.forEach((e, i) => {
      // Soldiers spawn in node order (enemy.ts); the id -1 ones keep their place after the previous one.
      const node = e.node ?? Math.max(lastNode, e.taskId >= 0 ? (soldierNodes.get(e.taskId) ?? lastNode) : lastNode);
      lastNode = node;
      const ai = enemies?.aiOf?.(e) ?? null;
      let point: Vec3;
      if (ai) {
        const o = ai.self.origin();
        point = [o[0], o[1], o[2] + (ai.self.crouched() ? 1433.6 : 2826.24)];
      } else {
        point = toIgi([e.position[0], e.position[1] + SOLDIER_ORIGIN_M + EYE_ABOVE_ORIGIN.standing, e.position[2]]);
      }
      out.push({
        o: { key: `soldier:${e.id}`, kind: "human", node, team: ai?.team ?? teamOf.get(e.taskId) ?? 1, alive: e.alive, inWorld: enemyInWorld(e), point },
        order: i,
      });
    });
    out.sort((a, b) => a.o.node - b.o.node || a.order - b.order);
    return out.map((x) => x.o);
  }

  /**
   * The registry as a lens sees it now, in create (tree) order: SCamera holders (FUN_00441bf0, with
   * their live isExploded) and the humans (live with node ticks, else as at the tick start).
   */
  function detectables(): CameraDetectable[] {
    const out: CameraDetectable[] = [];
    if (!runtime) return out;
    for (const cam of runtime.tasks.securityCameras) {
      out.push({
        key: `scamera:${cam.nodeIndex}`, kind: "scamera", node: cam.nodeIndex, team: 1,
        alive: !runtime.nodeState(cam.nodeIndex).isExploded, inWorld: true, point: [...cam.holderPosition] as Vec3,
      });
    }
    out.push(...(nodeTick ? captureHumans() : (humanSnapshot ??= captureHumans())));
    return out.sort((a, b) => a.node - b.node); // stable: soldiers sharing a node keep their order
  }

  /**
   * FUN_00487f40 for a lens: the world ray eye -> point (FUN_004c4630, filter 0x53f120); the lens
   * filter 0x441580 and the SCamera filter 0x441c30 skip this camera's lens and holder and the
   * target camera's; the target passes when nothing is hit or the see-through product is >= 0.79.
   */
  function cameraLineOfSight(eye: CameraEye, from: Vec3, o: CameraDetectable): boolean {
    const w = ctx.world;
    if (!w || !level) return true;
    const a = igiPointToEngine(from, level.originIgi);
    const b = igiPointToEngine(o.point, level.originIgi);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-9) return true;
    const skip = new Set([eye.holder, eye.lens]);
    if (o.kind === "scamera") {
      const other = cameraEyes.get(o.node);
      if (other) skip.add(other.holder).add(other.lens);
    }
    const hits: Array<{ material: number; front: boolean; terrain?: boolean }> = w
      .raycastAll(a[0], a[1], a[2], dx / d, dy / d, dz / d, d, TRI_SIGHT)
      .filter((h) => !skip.has(h.owner))
      .map((h) => ({ material: h.material < 0 ? NO_MATERIAL : h.material, front: h.front, terrain: h.terrain }));
    // Every human in the world but the target (filter 0x441c30; the ray's self is the holder):
    // soldiers alive or dead and the player, posed (FUN_0045e490, enemy.ts sightHits).
    const enemies = ctx.systems?.enemies;
    if (enemies?.sightHits) hits.push(...enemies.sightHits(a, b, o.kind === "human" ? [humanKey(o.key)] : []));
    const table = level.surfaceMaterials;
    return aiSightPasses(sightTransmission(hits, (m) => table[m]?.seeThrough ?? 0));
  }

  /** The AI key of a registry human (0 = the player, else Enemy.id): "player" / "soldier:<id>". */
  function humanKey(key: string | number): number {
    const k = String(key);
    return k === "player" ? 0 : Number(k.slice(k.indexOf(":") + 1));
  }

  /** MissionHost.cameraSighting: lens update LAB_00440930 (switched on) -> FUN_00487b70 -> FUN_00440db0 target and bearing. */
  function cameraSighting(cam: SecurityCameraTask): CameraSighting | null {
    const eye = cameraEyes.get(cam.nodeIndex);
    if (!eye || !runtime) return null;
    const s = runtime.nodeState(cam.nodeIndex);
    // Eye +0x110 / matrix +0x128: magic vertex 1 under the lens matrix +0x70 of the previous update.
    const r = securityCameraLensMatrix(cam.holderGamma, cam.cameraGamma, s.rotYaw ?? 0, s.rotPitch ?? cam.cameraAlpha);
    const off = apply3(r, magicVertex(eye.model, 1));
    const from: Vec3 = [eye.pivot[0] + off[0], eye.pivot[1] + off[1], eye.pivot[2] + off[2]];
    const objects = detectables();
    eye.detector.perceive(
      // The application tick (FUN_00402a30): it keeps counting while the in-game menu pauses the game.
      ctx.appTick ?? ctx.tick,
      cam.nodeIndex,
      objects,
      (o) => securityCameraInViewCone(from, r, o.point, eye.cone),
      (o) => cameraLineOfSight(eye, from, o),
    );
    const target = eye.detector.target();
    if (!target) return null;
    const o = objects.find((x) => x.key === target.key);
    return { key: target.key, alert: target.alert, bearing: o ? securityCameraBearing(eye.pivot, r, o.point) : undefined };
  }

  /** LAB_00441c50: the light at lens + R x magic vertex 0 of the Camera Model while the holder isOn. */
  function securityCameraLights(): SecurityCameraLightQuad[] {
    const out: SecurityCameraLightQuad[] = [];
    if (!runtime || !level) return out;
    for (const cam of runtime.tasks.securityCameras) {
      const eye = cameraEyes.get(cam.nodeIndex);
      if (!eye || !inWorldNode(cam.nodeIndex)) continue;
      const s = runtime.nodeState(cam.nodeIndex);
      const light = securityCameraLight(s);
      if (!light) continue;
      const r = securityCameraLensMatrix(cam.holderGamma, cam.cameraGamma, s.yaw ?? 0, s.pitch ?? cam.cameraAlpha);
      const off = apply3(r, magicVertex(eye.model, 0));
      const p: Vec3 = [eye.pivot[0] + off[0], eye.pivot[1] + off[1], eye.pivot[2] + off[2]];
      out.push({ position: igiPointToEngine(p, level.originIgi), rgb: light.rgb, halfSize: light.halfSize / UNITS_PER_METRE });
    }
    return out;
  }

  const toIgi = (p: readonly number[]): Vec3 => {
    const o = level?.originIgi ?? [0, 0, 0];
    return [o[0] + p[0] * UNITS_PER_METRE, o[1] - p[2] * UNITS_PER_METRE, o[2] + p[1] * UNITS_PER_METRE];
  };

  /** A soldier by its own node when known (task ids repeat), else by task id. */
  function enemyInWorld(e: { taskId: number; node?: number; outOfWorld?: boolean }): boolean {
    if (e.outOfWorld) return false; // removed from the world (a corpse after 300 ticks, combat/enemy.ts)
    return e.node !== undefined && e.node >= 0 ? inWorldNode(e.node) : inWorld(e.taskId);
  }

  function inWorld(taskId: number): boolean {
    const node = runtime?.tasks.byId.get(taskId);
    return node === undefined ? true : inWorldNode(node);
  }

  /** No enclosing ConditionalContainer of node `node` has removed its subtree from the world. */
  function inWorldNode(node: number): boolean {
    if (!runtime || node < 0 || node >= runtime.tasks.nodes.length) return true;
    for (let n = runtime.tasks.nodes[node].parent; n >= 0; n = runtime.tasks.nodes[n].parent) if (outOfWorld.has(n)) return false;
    return true;
  }

  function taskPose(taskId: number): TaskPose | null {
    const override = poseOverrides.get(taskId);
    if (override) return override;
    // Vehicles: the simulated pose (helis, cars) or the train car's place on the rail at the
    // runtime's current distance, computed on demand (also before the link-pose capture).
    const vehicle = vehicles?.pose(taskId);
    if (vehicle) return vehicle;
    const node = runtime?.tasks.byId.get(taskId);
    if (node === undefined || !runtime) return null;
    const task: IgiTask = runtime.tasks.nodes[node].task;
    const pos = task.params.Position;
    if (!Array.isArray(pos) || pos.length !== 3) return null;
    const orient = task.params.Orientation;
    const gamma = task.params.Gamma;
    const matrix = Array.isArray(orient) && orient.length === 3
      ? eulerToMatrix(orient[0] as number, orient[1] as number, orient[2] as number)
      : eulerToMatrix(0, 0, typeof gamma === "number" ? gamma : 0);
    return { position: [pos[0] as number, pos[1] as number, pos[2] as number], matrix };
  }

  function humanOrigin(feet: readonly number[], crouched: boolean, eyeHeight: number): Vec3 {
    const above = eyeHeight - (crouched ? EYE_ABOVE_ORIGIN.crouched : EYE_ABOVE_ORIGIN.standing);
    return toIgi([feet[0], feet[1] + above, feet[2]]);
  }

  function humans(): MissionHuman[] {
    const out: MissionHuman[] = [];
    const p = ctx.player;
    if (inWorld(0)) out.push({ position: humanOrigin(p.position, p.crouching, p.eyeHeight), team: 0 });
    for (const e of ctx.enemies) {
      if (!enemyInWorld(e)) continue;
      // Soldier origin: the pelvis, about 0.95 m above the feet standing.
      out.push({ position: toIgi([e.position[0], e.position[1] + 0.95, e.position[2]]), team: teamOf.get(e.taskId) ?? 1 });
    }
    return out;
  }

  function value(name: string): number | undefined {
    const m = /^([A-Za-z]+)_(-?\d+)\.([A-Za-z]+)$/.exec(name);
    if (!m) return undefined;
    const [, type, idText, member] = m;
    const id = Number(idText);
    if (type === "HumanPlayer") {
      if (member === "isDead") return ctx.player.alive ? 0 : 1;
      if (member === "eTeam") return 0;
    } else if (isSoldierTaskType(type)) {
      const e = ctx.enemies.find((x) => x.taskId === id);
      if (member === "isDead") return e && !e.alive ? 1 : 0;
      if (member === "eTeam") return teamOf.get(id) ?? 1;
    } else if (type === "HumanAI") {
      if (member === "isDetection") {
        const enemies = ctx.systems.enemies as unknown as { isDetection?(aiTaskId: number): number } | null;
        return enemies?.isDetection?.(id) ?? 0;
      }
    } else if (type === "Car" && member === "isExploded") {
      return vehicles?.isExploded(id) ?? 0; // +0x2ed5 (world/vehicles.ts car explosion)
    }
    return undefined;
  }

  /** The cut-scene shake generator DAT_00807358: FUN_004aaa00's state, set once at start-up (FUN_004eb760), never per mission. */
  const shakeRng = new LevelRng(0);
  const SHAKE_ANGLE = Math.fround(0.5340707898139954); // 0x532b50

  function onCutSceneCamera(sample: CutSceneCameraSample, cut: CutSceneTask): void {
    let position = sample.position;
    let matrix = sample.matrix;
    if (sample.link) {
      const current = taskPose(sample.link.taskId);
      const initial = initialPoses.get(sample.link.taskId) ?? current;
      if (current && initial) ({ position, matrix } = applyCameraLink(position, matrix, initial, current));
    }
    if (sample.target) {
      const target = taskPose(sample.target.taskId);
      if (target) matrix = cameraLookAt(position, target.position);
    }
    {
      // FUN_004ec230 0x4ec989: on every apply (shake 0 included) six draws of the cut-scene generator
      // DAT_00807358: position += (0.5 - r) x shake x 4096 per axis, then the camera matrix is
      // post-multiplied by Rz(g) Ry(b) Rx(a) with g, b, a = (0.5 - r) x shake x 0.5340708 (draws 4, 5, 6).
      const s = sample.shake;
      position = [
        position[0] + (0.5 - shakeRng.float()) * s * UNITS_PER_METRE,
        position[1] + (0.5 - shakeRng.float()) * s * UNITS_PER_METRE,
        position[2] + (0.5 - shakeRng.float()) * s * UNITS_PER_METRE,
      ];
      const gamma = Math.fround((0.5 - shakeRng.float()) * s * SHAKE_ANGLE);
      const beta = Math.fround((0.5 - shakeRng.float()) * s * SHAKE_ANGLE);
      const alpha = Math.fround((0.5 - shakeRng.float()) * s * SHAKE_ANGLE);
      if (s !== 0) {
        const r = eulerToMatrix(alpha, beta, gamma);
        const m = matrix;
        const out = new Array<number>(9);
        for (let row = 0; row < 3; row++) {
          for (let col = 0; col < 3; col++) out[row * 3 + col] = m[row * 3] * r[col] + m[row * 3 + 1] * r[3 + col] + m[row * 3 + 2] * r[6 + col];
        }
        matrix = out as typeof matrix;
      }
    }
    // Columns of `matrix` (row-major) are right, down, forward in IGI axes.
    const right = conv([matrix[0], matrix[3], matrix[6]]);
    const down = conv([matrix[1], matrix[4], matrix[7]]);
    const forward = conv([matrix[2], matrix[5], matrix[8]]);
    basis.makeBasis(right, down.clone().negate(), forward.clone().negate());
    quaternion.setFromRotationMatrix(basis);
    const engine = igiPointToEngine(position, level!.originIgi);
    const tanX = Math.min(3, Math.max(0.001, sample.fov));
    const bar = letterboxBarHeight(480, sample.viewportFactor);
    cutscene = {
      position: engine,
      quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
      fovYDeg: (2 * Math.atan(0.75 * tanX) * 180) / Math.PI,
      barFraction: bar / 481,
      cutSceneId: cut.id,
      keyIndex: sample.keyIndex,
      filter: sample.filter,
      cut: sample.cut,
      keyFilterColor: [...cut.keys[sample.curveKeys[1]].filterColor] as Vec3,
      filterColor: sample.filterColor,
      noise: sample.noise,
      timeOfDay: sample.timeOfDay,
    };
    // FUN_004ec230 tail: rebuild the overlays at a cut, refresh band colour / line noise.
    appliedThisTick.add(cut.id);
    filters.apply(cut.id, {
      cut: sample.cut, filter: sample.filter, keyColour: cutscene.keyFilterColor, colour: sample.filterColor, noise: sample.noise,
    }, nowMs());
  }

  /** combat: handlers of MissionHost.onTaskEvent / query (registered task behaviours). */
  const taskEventHandlers = new Set<(node: MissionNode, event: string, data?: unknown) => void>();
  const taskQueries = new Map<string, (...args: unknown[]) => unknown>();

  /** Link-task poses captured when the runtime is built (FUN_004ff270). */
  const initialPoses = new Map<number, TaskPose>();

  // --- Vehicles: perception, targets, explosions (world/vehicles.ts, spec vehicles §2.7, §3.1) ----
  /** Car task keys replaced by their wreck (FUN_004f0ee0): kept visible out of the world as well. */
  const wrecks = new Set<number>();
  /** turrets: the attached weapons of the vehicles (combat/vehicle-weapons.ts). */
  let vehicleWeapons: MountedWeaponHooks | null = null;
  function registryHuman(key: string | number): { alive: boolean; origin: Vec3 } | null {
    const k = String(key);
    if (k === "player") {
      const p = ctx.player;
      return { alive: p.alive, origin: humanOrigin(p.position, p.crouching, p.eyeHeight) };
    }
    const id = Number(k.slice(k.indexOf(":") + 1));
    const e = ctx.enemies.find((x) => x.id === id);
    if (!e) return null;
    const ai = ctx.systems?.enemies?.aiOf?.(e) ?? null;
    const origin = ai ? ([...ai.self.origin()] as Vec3) : toIgi([e.position[0], e.position[1] + SOLDIER_ORIGIN_M, e.position[2]]);
    return { alive: e.alive, origin };
  }
  /** FUN_00489b20 for a vehicle eye: the sight ray of the soldiers / cameras, the vehicle's own instances skipped. */
  function vehicleLineOfSight(from: Vec3, point: Vec3, target: string | number, selfKey: number): boolean {
    const w = ctx.world;
    if (!w || !level) return true;
    const a = igiPointToEngine(from, level.originIgi);
    const b = igiPointToEngine(point, level.originIgi);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const dz = b[2] - a[2];
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-9) return true;
    const lvl = level;
    const hits: Array<{ material: number; front: boolean; terrain?: boolean }> = w
      .raycastAll(a[0], a[1], a[2], dx / d, dy / d, dz / d, d, TRI_SIGHT)
      .filter((h) => !(h.owner >= 0 && lvl.instances[h.owner]?.taskIndex === selfKey))
      .map((h) => ({ material: h.material < 0 ? NO_MATERIAL : h.material, front: h.front, terrain: h.terrain }));
    const enemies = ctx.systems?.enemies;
    if (enemies?.sightHits) hits.push(...enemies.sightHits(a, b, [humanKey(target)]));
    const table = level.surfaceMaterials;
    return aiSightPasses(sightTransmission(hits, (m) => table[m]?.seeThrough ?? 0));
  }
  function vehicleHooks(): Omit<Parameters<typeof createVehicleSystem>[2], "collision" | "runtime"> {
    return {
      evaluate: (text) => (runtime ? runtime.evaluate(text) : 0),
      humans: () => (nodeTick ? captureHumans() : (humanSnapshot ??= captureHumans())),
      lineOfSight: vehicleLineOfSight,
      appTick: () => ctx.appTick ?? ctx.tick,
      phase: (node) => loadPhases.get(node),
      nextPhase: () => {
        const p = phaseCounter;
        phaseCounter = (phaseCounter + 1) & 3;
        return p;
      },
      targetDead: (key) => !(registryHuman(key)?.alive ?? false),
      targetPosition: (key) => registryHuman(key)?.origin ?? null,
      carDamaged: (node) => damageSystemOf(ctx)?.objects.some((o) => o.kind === "car" && o.node === node && o.flag) ?? false,
      explode: (e) => {
        const d = damageSystemOf(ctx);
        if (!d) return;
        // FUN_00480fe0(position, 1, delay, damage, radius, falloff, scorch, fragments, fireballs, 0, "1009_01_1", sound, 21, 2, 100000, 0).
        d.explode(d.makeExplosion({
          position: e.position, interval: e.delay, damage: e.damage, radius: e.radius, falloff: e.falloff, scorch: e.scorch,
          fragments: e.fragments, fireballs: e.fireballs, sound: e.sound, aiRange: 100000, fragmentModel: "1009_01_1",
        }));
      },
      wreck: (carNode, wreckModel) => {
        if (!level) return;
        wrecks.add(carNode);
        const model = wreckModel ? damageSystemOf(ctx)?.data?.models.get(wreckModel.toLowerCase()) ?? null : null;
        level.instances.forEach((inst, i) => {
          if (inst.taskIndex !== carNode) return;
          const root = (inst.attachmentPath ?? "") === "" && inst.part === undefined;
          world?.setInstanceModel?.(i, root ? model : null);
        });
      },
      random: () => ctx.rng.float(),
      // turrets: the vehicles' attached weapons (combat/vehicle-weapons.ts, registered by combat-objects.ts).
      mounted: () => vehicleWeapons,
      modelRadius: (model) => damageSystemOf(ctx)?.modelRadius(model) ?? 0,
      log: (message) => console.info(`[vehicles] ${message}`),
    };
  }

  const system: MissionSystem = {
    get runtime() {
      return runtime;
    },
    get cutscene() {
      return cutscene;
    },
    get playerInWorld() {
      return inWorld(0);
    },
    get menuEnabled() {
      return menuEnabled;
    },
    get complete() {
      return complete;
    },
    get failed() {
      return failed;
    },
    start(next: IgiLevel): void {
      level = next;
      cutscene = null;
      breakRequested = false;
      menuEnabled = true;
      complete = false;
      failed = false;
      failedAnnounced = false;
      outOfWorld.clear();
      wrecks.clear();
      poseOverrides.clear();
      doorInitial.clear();
      hiddenTasks.clear();
      lensPlacements.clear();
      lensPosed.clear();
      initialPoses.clear();
      teamOf.clear();
      filters.clear();
      appliedThisTick.clear();
      stoppedThisTick.clear();
      for (const s of next.soldiers) teamOf.set(s.taskId, s.team);
      const tasks = buildMissionTasks(next.taskRoots);
      runtime = null;
      // Vehicles exist before the runtime: its compile already sends nTick 0 to them (docs/vehicles.md 8).
      vehicles = createVehicleSystem(next, tasks, { collision: () => ctx.world, runtime: () => runtime, ...vehicleHooks() });
      runtime = new MissionRuntime(tasks, {
        humans,
        // CRITERIA_VEHICLE (FUN_004f4560): the Vehicle-class objects in the world.
        vehicles: () => (vehicles?.areaVehicles() ?? []).filter((v) => inWorldNode(v.node)),
        // turrets: the end of the Car update after its children (world/vehicles.ts afterChildren).
        afterTaskChildren(node) {
          if (node.type === "Car") vehicles?.afterChildren(node.index);
        },
        value,
        updateTask(node) {
          // Vehicle task updates at their node (world/vehicles.ts taskUpdate): Car "Can fire" / explosion,
          // CarAI driving (FUN_00425de0), Plane / Heli "Play sound", Heli "Open door".
          if (node.type === "Car" || node.type === "CarAI" || node.type === "Plane" || node.type === "Heli") {
            vehicles?.taskUpdate(node.index);
            vehiclesMoved = true;
          }
          if (!nodeTick) return false;
          if (node.type === "Train" || node.type === "Heli" || node.type === "Car") vehiclesMoved = true;
          if (node.type === "HumanPlayer") {
            syncWorld();
            vehiclesMoved = false;
          } else if ((isSoldierTaskType(node.type) || node.type === "HumanAI") && vehiclesMoved && world) {
            vehicles?.sync(world);
            vehiclesMoved = false;
          }
          nodeTick(node.type, node.task.id, node.index);
          return false;
        },
        escapePressed: () => breakRequested,
        digitPressed: (d) => ctx.input.isDown(`Digit${d}`),
        call(name, args) {
          if (name === "MenuManager_SetEnabled") menuEnabled = (args[0] ?? 1) !== 0;
          else if (name === "StatusMessageScreen_ClearMessages") ctx.events.emit(GameEvent.StatusClear);
          return 0;
        },
        onContainerWorld(container, present) {
          if (present) outOfWorld.delete(container.nodeIndex);
          else outOfWorld.add(container.nodeIndex);
        },
        onStatusMessage(message) {
          const strings = level?.messageStrings;
          ctx.events.emit(GameEvent.StatusMessage, {
            text: strings?.get(message.text) ?? message.text,
            sprite: message.sprite || null,
            sound: message.sound || null,
            durationSeconds: message.durationSeconds,
            cutscene: message.cutsceneMessage,
          });
        },
        onCutSceneCamera(sample, cut) {
          if (!cutscene || cutscene.cutSceneId !== cut.id) ctx.events.emit(GameEvent.CutsceneStart, { id: cut.id });
          cameraThisTick = true;
          onCutSceneCamera(sample, cut);
        },
        onCutSceneStop(cut) {
          stoppedThisTick.add(cut.id);
          if (cutscene && cutscene.cutSceneId === cut.id) {
            cutscene = null;
            ctx.events.emit(GameEvent.CutsceneEnd, { id: cut.id });
          }
        },
        onAnimInput: (anim, nTick, channels) => {
          vehicles?.animInput(anim, nTick, channels);
          vehiclesMoved = true;
        },
        cameraSighting,
        // The registered task behaviours (loaders/objects) talk to the engine through these: the
        // object presenter (sounds, elevators, pickups) and the combat systems' handlers / queries.
        onTaskEvent: (node, event, data) => {
          objects.event(node, event, data);
          for (const h of [...taskEventHandlers]) h(node, event, data);
        },
        query: (name, ...args) => (taskQueries.has(name) ? taskQueries.get(name)!(...args) : objects.query(name, ...args)),
        random: () => ctx.rng.float(),
        randomInt: (n) => ctx.rng.int(n),
        warn: (message) => console.info(`[mission] ${message}`),
      });
      objects.start(next, runtime);
      setupCameraVision();
      for (const cut of tasks.cutScenes) {
        for (const key of cut.keys) {
          for (const id of [key.linkTaskId, key.targetTaskId]) {
            if (id >= 0 && !initialPoses.has(id)) {
              const pose = taskPose(id);
              if (pose) initialPoses.set(id, pose);
            }
          }
        }
      }
    },
    tick(): void {
      if (!runtime) return;
      cameraThisTick = false;
      appliedThisTick.clear();
      stoppedThisTick.clear();
      humanSnapshot = nodeTick ? null : nextSnapshot;
      nextSnapshot = null;
      runtime.tick();
      objects.tick();
      // What the cameras see next tick unless beginTick() refreshes it before the humans move.
      if (!nodeTick) nextSnapshot = captureHumans();
      breakRequested = false;
      // Overlays of a cut-scene whose subtree left the world go at once (FUN_004ed0f0); the
      // rest follow FUN_004ebe30, then every overlay runs its per-tick update.
      for (const c of runtime.tasks.cutScenes) if (!inWorldNode(c.nodeIndex)) filters.destroy(c.id);
      filters.endTick(appliedThisTick, stoppedThisTick, nowMs());
      // A cut-scene that is no longer updated (stopped, or its container left the
      // world when Esc broke the intro) no longer submits its camera: the player's
      // camera takes over, as igi.exe picks the highest-priority camera each frame.
      if (cutscene && !cameraThisTick) {
        const id = cutscene.cutSceneId;
        cutscene = null;
        ctx.events.emit(GameEvent.CutsceneEnd, { id });
      }
      syncWorld();
      const flow = runtime.tasks.levelFlow ? runtime.member(`LevelFlow_${runtime.tasks.levelFlow.id}.isFailed`) : undefined;
      if (flow && !failedAnnounced) {
        failed = true;
        failedAnnounced = true;
        ctx.events.emit(GameEvent.MissionFailed, { text: level?.failedText ?? "Mission Failed!" });
      }
      if (runtime.missionComplete && !complete) {
        complete = true;
        ctx.events.emit(GameEvent.MissionComplete);
      }
    },
    requestBreak(): void {
      breakRequested = true;
    },
    setTaskPose(taskId, pose) {
      poseOverrides.set(taskId, pose);
    },
    setNodeTick(tick) {
      nodeTick = tick;
    },
    attachWorld(next) {
      world = next;
      hiddenTasks.clear();
      doorInitial.clear();
      lensPosed.clear();
      syncWorld();
    },
    useDoor(taskId) {
      const node = runtime?.tasks.byId.get(taskId);
      return node !== undefined && runtime ? runtime.useDoor(node) : false;
    },
    useDoorNode(nodeIndex) {
      return runtime && system.doorOfBody(nodeIndex) !== null ? runtime.useDoor(nodeIndex) : false;
    },
    doorOfBody(bodyId) {
      return runtime?.tasks.doors.some((d) => d.nodeIndex === bodyId) ? bodyId : null;
    },
    get vehicles() {
      return vehicles;
    },
    filters,
    beginTick() {
      if (!nodeTick) nextSnapshot = captureHumans();
    },
    securityCameraLights,
    objects,
    poseOfNode(node) {
      const n = runtime?.tasks.nodes[node];
      if (!n) return null;
      if (n.type === "Elevator") return objects.poseOf(node);
      return n.id >= 0 ? taskPose(n.id) : null;
    },
    prepareRide(node) {
      if (!runtime || runtime.tasks.nodes[node]?.type !== "Elevator") return;
      if (runtime.nodeState(node).guard === runtime.levelTick) return;
      runtime.updateBehaviourNow(node);
      syncWorld();
    },
    onTaskEvent(handler) {
      taskEventHandlers.add(handler);
      return () => void taskEventHandlers.delete(handler);
    },
    setTaskQuery(name, fn) {
      if (fn) taskQueries.set(name, fn);
      else taskQueries.delete(name);
    },
    setVehicleWeapons(hooks) {
      vehicleWeapons = hooks;
    },
    takePerceptionPhase(node) {
      const phase = phaseCounter;
      loadPhases.set(node, phase);
      phaseCounter = (phaseCounter + 1) & 3;
      return phase;
    },
    cameraDetector(node) {
      return cameraEyes.get(node)?.detector ?? null;
    },
    member(name: string): number | undefined {
      return runtime?.member(name) ?? value(name);
    },
    condition(expression: string, selfName: string): number {
      if (!runtime) return 0;
      const text = expression.replace(/\bthis\./g, `${selfName}.`);
      return runtime.evaluate(text);
    },
    inWorld,
    inWorldNode,
    perceptionPhase(taskId) {
      const node = runtime?.tasks.byId.get(taskId);
      return node === undefined ? undefined : loadPhases.get(node);
    },
  };
  return system;
}
