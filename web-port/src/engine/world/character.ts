/**
 * Human movement and collision for one 30 Hz tick, shared by the player and
 * the soldiers: FUN_004600f0 (integrate), FUN_004606b0 (wall sweep) and
 * FUN_00460fd0 (ground probe) of igi.exe [recovered; docs/collision.md 4,
 * docs/gameplay.md "Collision"].
 *
 * Engine space: metres, y up (IGI z). All rates are per tick, as in the exe.
 *
 *   - The human's position is its root (pelvis); its feet are `rootHeight`
 *     below (FUN_00488760: the animated root translation z).
 *   - move = root motion + air velocity (jump/fall, human+0x664) + slope
 *     slide (+0x67c) + knock-back (+0x670); slide and knock-back decay x0.9
 *     per tick (0x5315bc) before they are added.
 *   - Wall sweep: three zero-radius rays from the old position along the
 *     move, length |move| + 10.24 units, at 0.1 / 0.4 / 1.8 m above the feet
 *     (crouched 0.1 / 0.2 / 1.3 m), against the HumanCollision hulls (HSMC
 *     set 1) and the terrain. A hit with |n.y| < 0.1 is a wall; the nearest
 *     wall wins; while grounded the 0.1 m ray is ignored. Moving into the
 *     wall projects the end point onto the wall plane through the hit point
 *     and pushes it out by 10.24 units, then the sweep repeats; after more
 *     than 10 passes the horizontal move is cancelled. Airborne only: the
 *     0.1 m ray hitting a floor with n.y > 0.9999 lifts the body onto it, and
 *     the 1.8 m ray hitting anything else that is not a wall caps the head
 *     under it.
 *   - Ground probe: from 0.4 m (crouched 0.2 m) above the feet, rays 1000 m
 *     down and 2 m up (roof flag when rootHeight + up distance < 1.8 m); with
 *     nothing below, one ray 1000 m up. The body stands on the hit when the
 *     feet are at most `snap` above it: 0 in the air, 0.5 m grounded, 2 m
 *     while sliding - and always when the hit is above the feet, which is
 *     how steps up to the ray start height are climbed. The ground material
 *     on objects comes from a re-cast against that object's visible faces
 *     (HSMC set 0), 204.8 units above the hit, 2048 units down.
 *   - Slope slide from the last ground normal: slope = 90 - asin(n.y)
 *     degrees; > 80: slide = n.xz x 1137 units, > 60: x 948, > 50: += x 56.89,
 *     > 45: += x 18.96; otherwise none (and the snap distance becomes 2 m
 *     while sliding).
 *
 * Moving objects [recovered; docs/collision.md section 4 "Platforms"]:
 *   - Ground task (human+0x768): the object hit by the last ground probe while
 *     grounded. At the start of each tick FUN_0045f930 asks it for its motion
 *     since the last tick (method 0x537436, implemented only by Train, Car,
 *     Elevator and StationaryGun - not Heli, doors or other objects): pivot c
 *     (its position now), rotation R_d = R_now R_prev^T, translation t. The
 *     human's displacement (+0x728) is (c - p) - R_d (c - p) + t and its yaw
 *     change (+0x764) the gamma of R_d (FUN_004a9f30). FUN_004600f0 adds the
 *     displacement to the START of the move (then the normal sweep and ground
 *     probe run), +0x688 (`moved`) includes it, FUN_0045fd00 adds the yaw to
 *     the heading even while the yaw input is locked, and the jump / fall
 *     entries add it to the air velocity (0x40bc87, 0x40beff). Leaving the
 *     ground (FUN_00461f10) clears the ground task and the displacement.
 *   - Attach task (human+0x76c, `attach`): set by FUN_00461f50 only when a
 *     StationaryGun is used (player state 33, AI states) or, for AI soldiers
 *     only (human+0x800 = HumanAI), when the ground probe finds the soldier's
 *     AIGraph flagged as attached (graph+100; the object is graph+0x14);
 *     cleared by FUN_00462190. While set, FUN_00461930 replaces FUN_004600f0:
 *     local (+0x770) += R^T x root motion, position = obj + R local - no
 *     sweep, ground probe, gravity, air, knock-back or slide; FUN_0045fd00
 *     sets the body orientation rigidly from the object (no turn input).
 *
 * Port additions: `area` keeps characters on the terrain built for
 * collision (the original world has terrain everywhere).
 */
import type { Vec3 } from "../../contracts";
import { CHARACTER_SWEEP, GROUND_PROBE } from "../../loaders/collision-mesh";
import { x87Mul, x87StoreF32, x87Sub } from "../../loaders/x87";
import { TRI_BULLET, TRI_SOLID, type CollisionWorld, type RayHit } from "./collision";

const U = 1 / 4096;
/** Sweep ray extension and slide push-out: 10.24 units (f64 0x531978). */
export const SWEEP_SKIN_M = CHARACTER_SWEEP.skin * U;
const PROBES_STANDING = CHARACTER_SWEEP.heightsStanding.map((h) => h * U);
const PROBES_CROUCHED = CHARACTER_SWEEP.heightsCrouched.map((h) => h * U);
/** |n.z| below this (f32 0.1 at 0x5313c8) makes a hit a wall. */
const WALL_MAX_ABS_NY = Math.fround(CHARACTER_SWEEP.wallMaxAbsNormalZ);
/** Airborne lowest-ray floor lift: n.z > 0.9999 (f32 0x53195c). */
const LIFT_MIN_NY = Math.fround(CHARACTER_SWEEP.stepFloorMinNormalZ);
/** Airborne head cap keeps the horizontal move only under a ceiling with n.z < -0.9999 (f32 0x531958). */
const HEAD_CAP_MIN_NY = Math.fround(-0.9999);
/** The head cap uses the standing head height even when crouched (f64 0x531960). */
const HEAD_HEIGHT_M = CHARACTER_SWEEP.heightsStanding[2] * U;
/** The lowest probe height, used by the airborne floor lift (f32 0x531418). */
const LOW_PROBE_M = Math.fround(CHARACTER_SWEEP.heightsStanding[0]) * U;

export const GROUND_SNAP_M = { air: 0, grounded: GROUND_PROBE.snap * U, sliding: 8192 * U } as const;
const GROUND_START_STANDING = GROUND_PROBE.startStanding * U;
const GROUND_START_CROUCHED = GROUND_PROBE.startCrouched * U;
const GROUND_DOWN_M = GROUND_PROBE.down * U;
const ROOF_RAY_M = GROUND_PROBE.roof * U;
/** Roof flag when rootHeight + up distance is below 1.8 m (f32 cast of f64 0x531960). */
const ROOF_LIMIT_M = Math.fround(7372.8) * U;
const RECAST_UP_M = GROUND_PROBE.materialRecastUp * U;
const RECAST_DOWN_M = GROUND_PROBE.materialRecastDown * U;
/** Velocity decay per tick for slide and knock-back (f32 0x5315bc). */
const DECAY = Math.fround(0.9);
/** Untagged faces report Ground (world+0xd40 = material table entry 1). */
const UNTAGGED_MATERIAL = 1;

/** Slope tiers (degrees) and slide factors (units/tick) [recovered 0x531914-0x531950]. */
const SLOPE = {
  setFast: { above: 80, factor: 1137 * U },
  set: { above: 60, factor: 948 * U },
  addFast: { above: 50, factor: Math.fround(56.88888931274414) * U },
  add: { above: 45, factor: Math.fround(18.962963104248047) * U },
} as const;
const RAD_TO_DEG = Math.fround(57.2957763671875);

/** Horizontal limits (engine x/z) characters may not leave: the area with collision. */
export interface PlayArea {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** The last ground probe hit (human+0x6a0). */
export interface GroundRecord {
  point: Vec3;
  /** Unit outward normal of the hit face. */
  normal: Vec3;
  /** Surface material (material.qvm index) footsteps and landings use; -1 = none. */
  material: number;
  terrain: boolean;
  /** Placed instance index of the object stood on, -1 for terrain. */
  owner: number;
  /** Dynamic body (moving object) stood on, -1 for static geometry and terrain. */
  body: number;
  /** Feet height above the hit (human+0x710); negative when the hit is above the feet. */
  distance: number;
}

export interface HumanMoveState {
  /** Root (pelvis) position, engine metres (human+0x20). Feet = position - rootHeight. */
  position: Vec3;
  /** Standing on something (status bit 4). */
  grounded: boolean;
  /** Crouched stance (human+0x33d): picks the lower probe heights. */
  crouched: boolean;
  /** A ceiling within 1.8 m (status bit 0x10), from the last ground probe. */
  roof: boolean;
  /** Jump / fall / air-control velocity, metres per tick (human+0x664). */
  air: Vec3;
  /** Knock-back, metres per tick (human+0x670). */
  knock: Vec3;
  /** Slope slide, metres per tick (human+0x67c). */
  slide: Vec3;
  /** Last ground probe hit, or null (human+0x6a0 / +0x6f8). */
  ground: GroundRecord | null;
  /** Displacement of the last move after the wall sweep, metres per tick (human+0x688). */
  moved: Vec3;
  /** The wall sweep slid along a wall this tick (status bit 8). */
  slid: boolean;
  /** The moving object stood on at the end of the last tick and its transform then (human+0x768). */
  platform: { body: number; matrix: Float64Array } | null;
  /** Heading change of that object over the last tick (radians, engine yaw sense; human+0x764). */
  platformYaw: number;
  /** Displacement of the human's point under that object's motion this tick, metres (human+0x728). */
  platformMove: Vec3;
  /** updatePlatform already ran for this tick (moveHuman then does not run it again). */
  platformReady: boolean;
  /** Attach task (human+0x76c): the body the human rides rigidly, or null (see attachHuman). */
  attach: HumanAttach | null;
}

/** A human attached to a dynamic body (FUN_00461f50). */
export interface HumanAttach {
  body: number;
  /** The body's transform (build pose -> now, column-major) at the last tick. */
  matrix: Float64Array;
  /** Position in the body's build pose, engine metres (human+0x770 in the object's frame). */
  local: Vec3;
}

/** Options of moveHuman / updatePlatform. */
export interface HumanMoveOptions {
  /**
   * The bodies whose motion carries a human standing on them: objects with a
   * method 0x537436 handler, i.e. tasks of PLATFORM_TASK_TYPES [recovered].
   * Default: every dynamic body (port approximation).
   */
  carries?: (body: number) => boolean;
  /**
   * The object's origin (obj+0x20) in the body's build pose, engine metres:
   * the pivot of the exe's formula. Without it the exact rigid motion is used,
   * which differs by (I - R_d) t (second order in the turn per tick).
   */
  pivotOf?: (body: number) => Vec3 | null;
}

/**
 * Task types that implement the "delta move" method 0x537436 (FUN_00415790)
 * [recovered: registrations in FUN_0042a0d0 Train (FUN_0042ac50), FUN_0042cf90
 * Car (FUN_0042eea0), FUN_0043be30 Elevator (FUN_0043d450), FUN_004726f0
 * StationaryGun (FUN_00473750)]. Heli (FUN_00430370) and the Vehicle parent
 * register none.
 */
export const PLATFORM_TASK_TYPES: ReadonlySet<string> = new Set(["Train", "Car", "Elevator", "StationaryGun"]);

export function createHumanMoveState(position: Vec3): HumanMoveState {
  return {
    position: [...position] as Vec3,
    grounded: false,
    crouched: false,
    roof: false,
    air: [0, 0, 0],
    knock: [0, 0, 0],
    slide: [0, 0, 0],
    ground: null,
    moved: [0, 0, 0],
    slid: false,
    platform: null,
    platformYaw: 0,
    platformMove: [0, 0, 0],
    platformReady: false,
    attach: null,
  };
}

/**
 * Leave the ground (FUN_00461f10, used by the jump and the attach states):
 * grounded, the ground record and task and the platform displacement are
 * cleared (the yaw change of this tick is kept: FUN_0045fd00 still adds it).
 */
export function leaveGround(s: HumanMoveState): void {
  s.grounded = false;
  s.ground = null;
  s.platform = null;
  s.platformMove = [0, 0, 0];
}

/**
 * FUN_0045f930, at the start of a tick (before the state machine, so that a
 * jump or fall entry can add `platformMove` to its air velocity): the motion
 * of the attach task, else of the ground task, since the last tick. moveHuman
 * calls it itself when the caller has not.
 */
export function updatePlatform(world: CollisionWorld, s: HumanMoveState, options?: HumanMoveOptions): void {
  s.platformMove = [0, 0, 0];
  s.platformYaw = 0;
  s.platformReady = true;
  const ref = s.attach ?? (s.platform && s.grounded ? s.platform : null);
  if (!ref || (options?.carries && !s.attach && !options.carries(ref.body))) return;
  const now = world.bodyMatrix(ref.body);
  if (!now) return;
  const d = platformDelta(ref.matrix, now, s.position, options?.pivotOf?.(ref.body) ?? undefined);
  s.platformMove = d.move;
  s.platformYaw = d.yaw;
}

/**
 * FUN_00461f50: attach the human to dynamic body `body` (its position is
 * kept in the body's frame). Returns false when the body is unknown.
 */
export function attachHuman(world: CollisionWorld, s: HumanMoveState, body: number): boolean {
  const m = world.bodyMatrix(body);
  if (!m) return false;
  s.attach = { body, matrix: Float64Array.from(m), local: rigidInverse(m, s.position) };
  return true;
}

/** FUN_00462190: detach (the normal move resumes on the next tick). */
export function detachHuman(s: HumanMoveState): void {
  s.attach = null;
}

/** m^-1 p for a rigid column-major 4x4 transform. */
function rigidInverse(m: ArrayLike<number>, p: Vec3): Vec3 {
  const v = [p[0] - m[12], p[1] - m[13], p[2] - m[14]];
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[4] * v[0] + m[5] * v[1] + m[6] * v[2], m[8] * v[0] + m[9] * v[1] + m[10] * v[2]];
}

/**
 * FUN_00461930 (instead of FUN_004600f0 while attached): the root motion is
 * added in the body's frame (local += R^T move) and the position follows the
 * body rigidly (position = M local). Nothing else moves the human; `moved`
 * (+0x688) is left as it was.
 */
function moveAttached(world: CollisionWorld, s: HumanMoveState, a: HumanAttach, rootDelta: Vec3): void {
  const m = world.bodyMatrix(a.body);
  if (!m) return;
  a.local = [
    a.local[0] + m[0] * rootDelta[0] + m[1] * rootDelta[1] + m[2] * rootDelta[2],
    a.local[1] + m[4] * rootDelta[0] + m[5] * rootDelta[1] + m[6] * rootDelta[2],
    a.local[2] + m[8] * rootDelta[0] + m[9] * rootDelta[1] + m[10] * rootDelta[2],
  ];
  const l = a.local;
  s.position[0] = m[0] * l[0] + m[4] * l[1] + m[8] * l[2] + m[12];
  s.position[1] = m[1] * l[0] + m[5] * l[1] + m[9] * l[2] + m[13];
  s.position[2] = m[2] * l[0] + m[6] * l[1] + m[10] * l[2] + m[14];
  a.matrix = Float64Array.from(m);
}

/** Outward normal of a hit (RayHit.normal faces the ray origin). */
function outward(hit: RayHit): Vec3 {
  return hit.front ? [hit.normal[0], hit.normal[1], hit.normal[2]] : [-hit.normal[0], -hit.normal[1], -hit.normal[2]];
}

/** asin with the argument clamped to [-1, 1] (FUN_004a8ab0 -> FUN_0050faa0). */
function asinClamped(x: number): number {
  return Math.asin(x < -1 ? -1 : x > 1 ? 1 : x);
}

/** Slope slide for this tick from the last ground record (FUN_004600f0 head). Returns true while sliding. */
function updateSlide(s: HumanMoveState): boolean {
  const g = s.ground;
  const sl = s.slide;
  if (g && s.grounded) {
    const len = Math.hypot(g.normal[0], g.normal[1], g.normal[2]);
    const n = len > 0 ? [g.normal[0] / len, g.normal[1] / len, g.normal[2] / len] : [0, 0, 0];
    // (float)(90 - asin(n.z) x 57.2957...) in chop mode.
    const slope = x87StoreF32(x87Sub(90, x87Mul(asinClamped(n[1]), RAD_TO_DEG)));
    if (slope > SLOPE.setFast.above) {
      s.slide = [n[0] * SLOPE.setFast.factor, 0, n[2] * SLOPE.setFast.factor];
      return true;
    }
    if (slope > SLOPE.set.above) {
      s.slide = [n[0] * SLOPE.set.factor, 0, n[2] * SLOPE.set.factor];
      return true;
    }
    if (slope > SLOPE.addFast.above) {
      sl[0] += n[0] * SLOPE.addFast.factor;
      sl[2] += n[2] * SLOPE.addFast.factor;
      return true;
    }
    if (slope > SLOPE.add.above) {
      sl[0] += n[0] * SLOPE.add.factor;
      sl[2] += n[2] * SLOPE.add.factor;
      return true;
    }
  }
  s.slide = [0, 0, 0];
  return false;
}

/** Wall candidate of one sweep ray: the hit with its flattened outward normal, or null. */
function wallOf(hit: RayHit | null): { hit: RayHit; n: Vec3 } | null {
  if (!hit) return null;
  const n = outward(hit);
  if (!(Math.abs(n[1]) < WALL_MAX_ABS_NY)) return null;
  const h = Math.hypot(n[0], n[2]);
  return { hit, n: h > 0 ? [n[0] / h, 0, n[2] / h] : [0, 0, 0] };
}

/** FUN_004606b0: sweep from `start` to `end` (root positions), sliding along walls. Modifies `end`. */
function sweep(world: CollisionWorld, s: HumanMoveState, start: Vec3, end: Vec3, rootHeight: number): void {
  const probes = s.crouched ? PROBES_CROUCHED : PROBES_STANDING;
  const feetY = start[1] - rootHeight;
  s.slid = false;
  for (let pass = 1; ; pass++) {
    const dx = end[0] - start[0];
    const dy = end[1] - start[1];
    const dz = end[2] - start[2];
    if (dx === 0 && dy === 0 && dz === 0) return;
    const moveLen = Math.hypot(dx, dy, dz);
    const rayLen = moveLen + SWEEP_SKIN_M;
    const ux = dx / moveLen;
    const uy = dy / moveLen;
    const uz = dz / moveLen;
    const hits = probes.map((h) => world.raycast(start[0], feetY + h, start[2], ux, uy, uz, rayLen, TRI_SOLID));
    let wall: { hit: RayHit; n: Vec3 } | null = null;
    const consider = (k: number) => {
      const candidate = wallOf(hits[k]);
      if (candidate && (!wall || candidate.hit.distance < wall.hit.distance)) wall = candidate;
    };
    let slid = false;
    let headCapped = false;
    if (!s.grounded) {
      consider(0);
      consider(1);
      consider(2);
      const low = hits[0];
      if (low && !wall) {
        const n = outward(low);
        const len = Math.hypot(n[0], n[1], n[2]);
        if (len > 0 && n[1] / len > LIFT_MIN_NY) {
          end[0] = low.point[0];
          end[1] = low.point[1] + rootHeight - LOW_PROBE_M;
          end[2] = low.point[2];
        }
      }
      const head = hits[2];
      if (head && !wall) {
        const n = outward(head);
        const len = Math.hypot(n[0], n[1], n[2]);
        const ny = len > 0 ? n[1] / len : 0;
        if (ny >= HEAD_CAP_MIN_NY) {
          end[0] = head.point[0];
          end[2] = head.point[2];
          s.air[0] = 0;
          s.air[2] = 0;
        }
        s.air[1] = 0;
        end[1] = head.point[1] - (HEAD_HEIGHT_M - rootHeight) - SWEEP_SKIN_M;
        headCapped = true;
      }
    } else {
      consider(1);
      consider(2);
    }
    const w = wall as { hit: RayHit; n: Vec3 } | null;
    if (!headCapped && w) {
      const n = w.n;
      if (dx * n[0] + dy * n[1] + dz * n[2] < 0) {
        // FUN_004a8f50: project (end - hit) onto the wall plane, then push out by the skin.
        const p = w.hit.point;
        const rx = end[0] - p[0];
        const ry = end[1] - p[1];
        const rz = end[2] - p[2];
        const nn = n[0] * n[0] + n[1] * n[1] + n[2] * n[2];
        const k = Math.abs(nn) <= 1e-5 ? null : (rx * n[0] + ry * n[1] + rz * n[2]) / nn;
        const proj: Vec3 = k === null ? [0, 0, 0] : [rx - k * n[0], ry - k * n[1], rz - k * n[2]];
        end[0] = p[0] + proj[0] + n[0] * SWEEP_SKIN_M;
        end[1] = p[1] + proj[1] + n[1] * SWEEP_SKIN_M;
        end[2] = p[2] + proj[2] + n[2] * SWEEP_SKIN_M;
        s.slid = true;
        slid = true;
      }
    }
    if (pass > CHARACTER_SWEEP.maxIterations) {
      // More than 10 passes: cancel the horizontal move (x and y in IGI space).
      end[0] = start[0];
      end[2] = start[2];
      return;
    }
    if (!slid) return;
  }
}

/** Material a ground hit reports: objects re-cast their visible faces (set 0), terrain is the hit's own. */
function groundMaterial(world: CollisionWorld, hit: RayHit): number {
  let material = hit.terrain ? hit.material : hit.material < 0 ? UNTAGGED_MATERIAL : hit.material;
  if (hit.owner >= 0) {
    const p = hit.point;
    const recast = world.raycast(p[0], p[1] + RECAST_UP_M, p[2], 0, -1, 0, RECAST_DOWN_M, TRI_BULLET, hit.owner);
    // Only the record's front-face material word is read (+0x4c).
    if (recast) material = recast.front ? (recast.material < 0 ? UNTAGGED_MATERIAL : recast.material) : -1;
  }
  return material;
}

/** FUN_00460fd0: stand `end` (root position) on the ground within `snap`. */
function groundProbe(world: CollisionWorld, s: HumanMoveState, end: Vec3, rootHeight: number, snap: number): void {
  const oy = end[1] - rootHeight + (s.crouched ? GROUND_START_CROUCHED : GROUND_START_STANDING);
  let hit = world.raycast(end[0], oy, end[2], 0, -1, 0, GROUND_DOWN_M, TRI_SOLID);
  const up = world.raycast(end[0], oy, end[2], 0, 1, 0, ROOF_RAY_M, TRI_SOLID);
  if (up && outward(up)[1] < 0 && rootHeight + up.distance < ROOF_LIMIT_M) s.roof = true;
  if (!hit) hit = world.raycast(end[0], oy, end[2], 0, 1, 0, GROUND_DOWN_M, TRI_SOLID);
  if (!hit) {
    s.grounded = false;
    s.ground = null;
    return;
  }
  const distance = end[1] - hit.point[1] - rootHeight;
  s.ground = {
    point: [...hit.point] as Vec3,
    normal: outward(hit),
    material: groundMaterial(world, hit),
    terrain: hit.terrain,
    owner: hit.owner,
    body: hit.triangle < 0 ? -1 - hit.triangle : -1,
    distance,
  };
  if (distance > snap) {
    s.grounded = false;
    return;
  }
  s.grounded = true;
  end[1] = hit.point[1] + rootHeight;
}

/**
 * One tick of FUN_004600f0 (FUN_00461930 while attached). `rootDelta` is this
 * tick's root motion in world metres (already scaled and rotated by the
 * caller), `rootHeight` the current pose's root height above the feet
 * (metres). Runs updatePlatform first unless the caller already did this
 * tick; the caller adds `platformYaw` to the heading (FUN_0045fd00).
 */
export function moveHuman(
  world: CollisionWorld,
  s: HumanMoveState,
  rootDelta: Vec3,
  rootHeight: number,
  area?: PlayArea,
  options?: HumanMoveOptions,
): void {
  // FUN_0045f930 (normally at the start of the tick; see updatePlatform).
  if (!s.platformReady) updatePlatform(world, s, options);
  s.platformReady = false;
  // FUN_00410a30: FUN_00461930 instead of FUN_004600f0 while attached (+0x76c).
  if (s.attach) {
    moveAttached(world, s, s.attach, rootDelta);
    return;
  }
  // FUN_004600f0: the platform displacement (+0x728) moves the start of the move.
  const pm = s.platformMove;
  s.position[0] += pm[0];
  s.position[1] += pm[1];
  s.position[2] += pm[2];
  const sliding = updateSlide(s);
  for (let k = 0; k < 3; k++) {
    s.slide[k] *= DECAY;
    s.knock[k] *= DECAY;
  }
  const move: Vec3 = [
    s.knock[0] + s.slide[0] + rootDelta[0] + s.air[0],
    s.knock[1] + s.slide[1] + rootDelta[1] + s.air[1],
    s.knock[2] + s.slide[2] + rootDelta[2] + s.air[2],
  ];
  const start: Vec3 = [s.position[0], s.position[1], s.position[2]];
  const end: Vec3 = [start[0] + move[0], start[1] + move[1], start[2] + move[2]];
  s.roof = false;
  sweep(world, s, start, end, rootHeight);
  // +0x688 = the move plus the platform displacement (0x460625).
  s.moved = [end[0] - start[0] + pm[0], end[1] - start[1] + pm[1], end[2] - start[2] + pm[2]];
  if (area) {
    end[0] = Math.min(Math.max(end[0], area.minX), area.maxX);
    end[2] = Math.min(Math.max(end[2], area.minZ), area.maxZ);
  }
  const snap = sliding ? GROUND_SNAP_M.sliding : s.grounded ? GROUND_SNAP_M.grounded : GROUND_SNAP_M.air;
  groundProbe(world, s, end, rootHeight, snap);
  s.position[0] = end[0];
  s.position[1] = end[1];
  s.position[2] = end[2];
  // FUN_00462280: the object stood on becomes the platform for the next tick.
  const body = s.grounded && s.ground ? s.ground.body : -1;
  const matrix = body >= 0 ? world.bodyMatrix(body) : null;
  s.platform = matrix ? { body, matrix } : null;
}

/**
 * The motion of point `p` under a rigid object that moved from transform
 * `prev` to `now` (column-major, build pose -> pose; FUN_0045f930).
 *
 * With `pivot` (the object's origin in the build pose) the exe's formula
 * [recovered]: c = now pivot, t = c - prev pivot, R_d = R_now R_prev^T,
 * move = (c - p) - R_d (c - p) + t. Without it the exact rigid motion
 * D p - p, D = now prev^-1 (equal when the object only translates or only
 * turns about its origin).
 *
 * yaw = gamma of R_d as FUN_004a9f30 extracts it, atan2(R_d10, R_d00) in IGI
 * axes (0 when |(R_d00, R_d10)| <= 1e-4); the exe wraps it to [0, 2 pi), the
 * port returns the same angle in (-pi, pi].
 */
export function platformDelta(prev: ArrayLike<number>, now: ArrayLike<number>, p: Vec3, pivot?: Vec3): { move: Vec3; yaw: number } {
  // Column 0 of R_d = R_now (row 0 of R_prev).
  const v0 = prev[0], v1 = prev[4], v2 = prev[8];
  const d00 = now[0] * v0 + now[4] * v1 + now[8] * v2;
  const d20 = now[2] * v0 + now[6] * v1 + now[10] * v2;
  // IGI R_d00 = engine d00, IGI R_d10 = -engine d20.
  let yaw = Math.hypot(d00, d20) <= 1e-4 ? 0 : Math.atan2(-d20, d00);
  if (yaw > Math.PI) yaw -= 2 * Math.PI;
  else if (yaw <= -Math.PI) yaw += 2 * Math.PI;
  if (pivot) {
    const apply = (m: ArrayLike<number>, q: readonly number[]): Vec3 => [
      m[0] * q[0] + m[4] * q[1] + m[8] * q[2] + m[12],
      m[1] * q[0] + m[5] * q[1] + m[9] * q[2] + m[13],
      m[2] * q[0] + m[6] * q[1] + m[10] * q[2] + m[14],
    ];
    const c = apply(now, pivot);
    const cp = apply(prev, pivot);
    const w = [c[0] - p[0], c[1] - p[1], c[2] - p[2]];
    // R_d w = R_now (R_prev^T w).
    const local = [prev[0] * w[0] + prev[1] * w[1] + prev[2] * w[2], prev[4] * w[0] + prev[5] * w[1] + prev[6] * w[2], prev[8] * w[0] + prev[9] * w[1] + prev[10] * w[2]];
    const rw = [
      now[0] * local[0] + now[4] * local[1] + now[8] * local[2],
      now[1] * local[0] + now[5] * local[1] + now[9] * local[2],
      now[2] * local[0] + now[6] * local[1] + now[10] * local[2],
    ];
    return { move: [w[0] - rw[0] + c[0] - cp[0], w[1] - rw[1] + c[1] - cp[1], w[2] - rw[2] + c[2] - cp[2]], yaw };
  }
  const q = rigidInverse(prev, p);
  const x = now[0] * q[0] + now[4] * q[1] + now[8] * q[2] + now[12];
  const y = now[1] * q[0] + now[5] * q[1] + now[9] * q[2] + now[13];
  const z = now[2] * q[0] + now[6] * q[1] + now[10] * q[2] + now[14];
  return { move: [x - p[0], y - p[1], z - p[2]], yaw };
}

/** Ground below a point (feet), for spawning: the ground probe's down ray from 0.4 m above. */
export function groundBelow(world: CollisionWorld, feet: Vec3): RayHit | null {
  return world.raycast(feet[0], feet[1] + GROUND_START_STANDING, feet[2], 0, -1, 0, GROUND_DOWN_M, TRI_SOLID);
}
