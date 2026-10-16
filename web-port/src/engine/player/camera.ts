/**
 * Player camera: igi.exe's HumanCamera (type "HumanCamera", FUN_00480c80;
 * per-tick update FUN_00480dc0) looking through the player's view object
 * (FUN_00463840 / FUN_00464490 / FUN_00463470; docs/rendering.md,
 * docs/gameplay.md, docs/weapons-view.md, docs/interactions.md section 10).
 *
 * First person (view mode 1) [recovered]: the eye sits on the human's
 * animated pelvis + 0.69 m standing / 0.35 m crouched (player.eyeHeight,
 * updated per tick by the player controller); the per-shot view kick is an
 * offset added to the view that decays x0.9 per tick; lean (Peek) offsets are
 * applied in view space. Pitch (with the kick) is clamped to +-90 degrees
 * (FUN_00463470).
 *
 * View effects (ctx.firstPerson, stepped once per tick by the weapon system
 * in the order of FUN_00463840; player/first-person.ts):
 *   - shake: random pitch / roll / yaw (added after the clamp) and eye
 *     offsets along the view's horizontal right axis and world up;
 *   - landing dip: eye moved along world up by d sin(phi);
 *   - FOV: tan(horizontal half-FOV) = firstPerson.tanX (zoom, binoculars),
 *     vertical tangent = 0.75 x horizontal (FUN_00495fe0).
 * Not reproduced (inferred effect small): the eye collision ray that keeps
 * the shifted eye 0.05 m in front of walls.
 *
 * View mode (human+0x4f0, FUN_004623a0; copied each tick into the camera
 * record by the human method FUN_0045e940 and switched on at 0x480e2f)
 * [recovered]:
 *   - 1: first person (FUN_00481fc0): eye, view axes, FOV tangent arms+0x1e4.
 *   - 3: third-person orbit (FUN_00481630 entry, FUN_00481660 input,
 *     FUN_00481750 placement), set while attached to a ladder / fence / wire
 *     (FUN_00411380 / FUN_00411710 / FUN_00411a80 / FUN_00411ec0) and in the
 *     use states 30 lock pick, 31 cabinet, 32 terminal, 34-36 (0x40c1ee ...
 *     0x40d627); back to 1 when they end.
 *   - 5: death camera (player death state 47, FUN_0040e660 at 0x40e6c0;
 *     FUN_00482190 entry, FUN_004821d0 / FUN_004822d0 input and distance,
 *     FUN_00482860 placement).
 *   - (2: debug orbit toggled by input channel 19, never set for the player;
 *     4: StationaryGun view override FUN_00464540 - not in level 1.)
 * Orbit placement (modes 3 and 5): camera = eye + B R (0, -D, 0) with B the
 * body matrix (human+0x78: heading + gun yaw kick) and R = Rz(yaw) Rx(pitch)
 * (FUN_004a9bc0) of the orbit angles (cam+0x10c / +0x108, reset to 0 on
 * entering the mode), D = cam+0x114 = 10240 units (2.5 m); it looks at the
 * eye without roll (FUN_004813d0) with tan(pi/4) (zoom ignored). A ray from
 * the eye to the camera steps through see-through faces (material
 * transmission > 0) by 20.48 units; on an opaque hit the camera is pulled in
 * to (hit distance - 204.8 units) only when all eight corners of a box at the
 * pelvis (+-716.8 units in x and y, z 0 and +2662.4) are also blocked from
 * the camera (FUN_00481c80).
 */
import * as THREE from "three";
import { CAMERA, verticalFovDeg } from "../../loaders";
import type { GameContext } from "../context";
import { lookChannel, lookSensitivity } from "../look";
import { TRI_BULLET, type RayHit } from "../world/collision";
import { FIRST_PERSON_CONSTANTS, type ViewMode } from "./first-person";
import { stationaryGunsOf } from "../combat/stationary-guns";

const UNITS_PER_METRE = 4096;
const U = 1 / UNITS_PER_METRE;

/** HumanCamera orbit constants [recovered; addresses in igi.exe]. */
export const THIRD_PERSON = {
  /** cam+0x110 on entering mode 3 / 5 (0x44800000). */
  entryDistance: 1024,
  /** cam+0x114: camera distance behind the eye (0x46200000; mode-5 cap f32 0x5321d0). */
  distance: 10240,
  /** Distance ramp per tick (f32 0x5321cc). */
  distanceStep: Math.fround(341.3333435058594),
  /** Orbit angle per unit of input channel (f32 0x5321c8, 40 degrees; mode-3 yaw uses -this, f32 0x5321c0). */
  orbitScale: Math.fround(0.6981317400932312),
  /** Orbit pitch limit (f32 0x5321c4 / 0x531874, 75 degrees). */
  pitchLimit: Math.fround(1.3089969158172607),
  /** Mode-5 minimum distance (f32 0x5313b8). */
  minDistance: 4096,
  /** Mode-5 wall depth factor (f32 0x5321d4). */
  blockScale: Math.fround(-1.0499999523162842),
  /** Mode-5 probe spread: cam+0x110 x f32 0x5321d8 x f32 0x5313b8 (0.4). */
  spread: Math.fround(9.765625145519152e-5) * 4096,
  /** Pull-in margin in front of an opaque hit (f64 0x531988). */
  pullIn: 204.8,
  /** Step through a see-through face (f64 0x531880). */
  seeThroughStep: 20.48,
  /** Body box around the pelvis tested by FUN_00481c80 (f64 716.8 / 2662.4). */
  bodyHalfWidth: 716.8,
  bodyHeight: 2662.4,
} as const;

/** Eye height above the pelvis (FUN_00464490): 2826.24 standing, 1433.6 crouched. */
const EYE_ABOVE_PELVIS = { standing: 2826.24 * U, crouched: 1433.6 * U };

export interface CameraController {
  update(dt: number): void;
  /**
   * Vertical FOV in degrees of the player view: the zoomed tangent of the
   * first-person state (binoculars, MP5SD / Dragunov zoom), else 73.74 deg;
   * always 73.74 deg in the third-person modes (tan(pi/4), FUN_00481750).
   */
  fovYDeg(): number;
  /**
   * Mouse-look scale relative to the unzoomed view: tan(hFOV / 2) / tan(45 deg)
   * (FUN_0045fd00 / FUN_00463470 multiply each look delta by the tangent).
   */
  lookScale(): number;
  /** The HumanCamera view mode of the player (1 first person, 3 orbit, 5 death); see playerViewMode. */
  viewMode(): ViewMode;
  /**
   * One 30 Hz tick of the orbit input (FUN_00481660 mode 3, FUN_004821d0 /
   * FUN_004822d0 mode 5): `dx`, `dy` are the mouse counts of the tick (as
   * LookController.tick), `invertY` the port's look option. No effect in
   * mode 1. Call it every tick the player's own look is locked (attached,
   * using, dead).
   */
  /** `sensitivity`: GOInMouSens; mode 3 reads the human's channels (scaled by FUN_0045cde0), mode 5 the raw port. */
  orbitTick(dx: number, dy: number, invertY?: boolean, sensitivity?: number): void;
}

/**
 * human+0x4f0 for the player [recovered setters, docs/interactions.md 10]:
 * 5 once dead (state 47), 3 while attached (ladder, fence, wire, ladder
 * slide) or in a timed use (terminal hack, lock pick), else 1.
 */
export function playerViewMode(ctx: GameContext): ViewMode {
  if (!ctx.player.alive) return 5;
  // combat: FUN_0045fcd0 sets mode 4 while the view object's override is on (a StationaryGun user, FUN_004658d0).
  if (stationaryGunsOf(ctx)?.playerView()) return 4;
  const busy = ctx.systems.player?.interactions.busy ?? null;
  return busy !== null ? 3 : 1;
}

const euler = new THREE.Euler(0, 0, 0, "YXZ");

/**
 * The eye (position, engine metres) and view rotation for this tick: player
 * yaw / pitch + kick (pitch clamped), the shake angles, lean, shake and dip
 * offsets. The weapon system aims with it; the camera controller copies it.
 */
export function computeEye(ctx: GameContext, position: THREE.Vector3, quaternion: THREE.Quaternion): void {
  const p = ctx.player;
  const o = ctx.firstPerson?.effects.offsets;
  const yaw = p.yaw + p.kickYaw + (o ? o.yaw : 0);
  const pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, p.pitch + p.kickPitch)) + (o ? o.pitch : 0);
  const roll = o ? o.roll : 0;
  // YXZ: yaw about world up, then pitch about the yawed x axis, then roll
  // about the view axis; -Z looks where the player aims.
  euler.set(pitch, yaw, roll, "YXZ");
  quaternion.setFromEuler(euler);
  const rightX = Math.cos(p.yaw);
  const rightZ = -Math.sin(p.yaw);
  const side = p.leanSide + (o ? o.right / UNITS_PER_METRE : 0);
  const up = p.leanUp + (o ? o.up / UNITS_PER_METRE : 0);
  position.set(p.position[0] + rightX * side, p.position[1] + p.eyeHeight + up, p.position[2] + rightZ * side);
}

/**
 * Engine offset (metres) of the orbit-local IGI point (x right, y forward,
 * z up; units) under B R = Rz(heading + yaw) Rx(pitch).
 */
export function orbitOffset(heading: number, pitch: number, yaw: number, local: readonly [number, number, number]): THREE.Vector3 {
  const c = Math.cos(pitch), s = Math.sin(pitch);
  const x = local[0];
  const y = local[1] * c - local[2] * s;
  const z = local[1] * s + local[2] * c;
  const t = heading + yaw;
  const ct = Math.cos(t), st = Math.sin(t);
  // IGI (x, y, z) -> engine (x, z, -y).
  return new THREE.Vector3((x * ct - y * st) * U, z * U, -(x * st + y * ct) * U);
}

export function createCameraController(ctx: GameContext): CameraController {
  const tanX = () => ctx.firstPerson?.tanX ?? CAMERA.worldTanHalfFovX;
  /** cam+0xe8: the mode of the last update; cam+0x108 pitch, +0x10c yaw, +0x110 / +0x114 distances. */
  let mode: ViewMode = 1;
  const orbit = { pitch: 0, yaw: 0, dist: 0, target: 0 };
  const eye = new THREE.Vector3();
  const view = new THREE.Quaternion();
  const look = new THREE.Matrix4();
  const up = new THREE.Vector3(0, 1, 0);

  /** Track the mode and run the entry function on a change (FUN_00480dc0: cam+0xe8 != record mode). */
  const sync = (): ViewMode => {
    const now = playerViewMode(ctx);
    if (now !== mode) {
      // FUN_00481630 (3) / FUN_00482190 (5); FUN_00480f90 (1) only clears +0x110.
      orbit.dist = now === 1 ? 0 : THIRD_PERSON.entryDistance;
      orbit.target = THIRD_PERSON.distance;
      orbit.pitch = 0;
      orbit.yaw = 0;
      mode = now;
    }
    if (ctx.firstPerson) ctx.firstPerson.viewMode = mode;
    return mode;
  };

  const seeThrough = (hit: RayHit): boolean => {
    if (hit.terrain || hit.material < 0) return false;
    return (ctx.level?.surfaceMaterials[hit.material]?.seeThrough ?? 0) > 0;
  };

  /**
   * First opaque hit on the segment from..to, stepping 20.48 units through
   * see-through faces (FUN_00481750 / FUN_00481c80 loops), or null.
   */
  const opaqueHit = (from: THREE.Vector3, to: THREE.Vector3): RayHit | null => {
    const world = ctx.world;
    if (!world) return null;
    const start = from.clone();
    for (let guard = 0; guard < 64; guard++) {
      const d = to.clone().sub(start);
      const len = d.length();
      if (len <= 0) return null;
      d.divideScalar(len);
      const hit = world.raycast(start.x, start.y, start.z, d.x, d.y, d.z, len, TRI_BULLET);
      if (!hit) return null;
      if (!seeThrough(hit)) return hit;
      start.set(hit.point[0], hit.point[1], hit.point[2]).addScaledVector(d, THIRD_PERSON.seeThroughStep * U);
    }
    return null;
  };

  /** FUN_00481c80: every corner of the pelvis box is blocked from `camera`. */
  const bodyHidden = (camera: THREE.Vector3): boolean => {
    const p = ctx.player;
    const pelvisY = p.position[1] + p.eyeHeight - (p.crouching ? EYE_ABOVE_PELVIS.crouched : EYE_ABOVE_PELVIS.standing);
    const h = THIRD_PERSON.bodyHalfWidth * U;
    const corner = new THREE.Vector3();
    for (const z of [0, THIRD_PERSON.bodyHeight * U]) {
      for (const [x, y] of [[-h, h], [h, h], [-h, -h], [h, -h]]) {
        // World axes (not rotated): IGI (x, y, z) -> engine (x, z, -y).
        corner.set(p.position[0] + x, pelvisY + z, p.position[2] - y);
        if (!opaqueHit(corner, camera)) return false;
      }
    }
    return true;
  };

  /** FUN_00481750 / FUN_00482860 (after the first death tick): the orbit camera position. */
  const place = (out: THREE.Vector3): void => {
    const p = ctx.player;
    out.copy(eye).add(orbitOffset(p.yaw + p.kickYaw, orbit.pitch, orbit.yaw, [0, -orbit.target, 0]));
    const hit = opaqueHit(eye, out);
    if (hit && bodyHidden(out)) {
      const toHit = new THREE.Vector3(hit.point[0], hit.point[1], hit.point[2]).sub(eye);
      const d = toHit.length();
      orbit.dist = d * UNITS_PER_METRE;
      if (d > 0) out.copy(eye).addScaledVector(toHit.divideScalar(d), Math.max(d - THIRD_PERSON.pullIn * U, 0));
    }
  };

  /** cam+0x110 approaches cam+0x114 by 341.33 units per tick (FUN_00481660 / FUN_004821d0). */
  const rampDistance = (): void => {
    const step = THIRD_PERSON.distanceStep;
    if (orbit.dist < orbit.target) orbit.dist = Math.min(orbit.target, orbit.dist + step);
    else if (orbit.dist > orbit.target) orbit.dist = Math.max(orbit.target, orbit.dist - step);
  };

  const clampPitch = (): void => {
    const lim = THIRD_PERSON.pitchLimit;
    if (orbit.pitch < -lim) orbit.pitch = -lim;
    else if (orbit.pitch > lim) orbit.pitch = lim;
  };

  /**
   * FUN_004822d0 (mode 5): four rays from the eye to points +-0.4 cam+0x110
   * around the camera at the new angles; a front-facing hit sets cam+0x114 to
   * max(1.05 x its depth behind the eye, 4096) (and cam+0x110 to 4096 when
   * that depth is not beyond 4096); with both pairs free cam+0x114 grows by
   * 341.33 up to 10240. Then the angles take the input.
   */
  const deathScan = (dPitch: number, dYaw: number): void => {
    const p = ctx.player;
    const world = ctx.world;
    const heading = p.yaw + p.kickYaw;
    const pitch = orbit.pitch + dPitch;
    const yaw = orbit.yaw + dYaw;
    const free = [true, true];
    if (world) {
      const d = orbit.dist;
      const s = d * THIRD_PERSON.spread;
      const points: [number, number, number][] = [[-s, -d, 0], [s, -d, 0], [0, -d, s], [0, -d, -s]];
      // The camera's forward axis B R (0, 1, 0) in engine space.
      const axis = orbitOffset(heading, pitch, yaw, [0, UNITS_PER_METRE, 0]);
      points.forEach((local, k) => {
        const off = orbitOffset(heading, pitch, yaw, local);
        const len = off.length();
        if (len <= 0) return;
        const hit = world.raycast(eye.x, eye.y, eye.z, off.x / len, off.y / len, off.z / len, len, TRI_BULLET);
        if (!hit || !hit.front) return;
        const depth =
          ((hit.point[0] - eye.x) * axis.x + (hit.point[1] - eye.y) * axis.y + (hit.point[2] - eye.z) * axis.z) *
          UNITS_PER_METRE *
          THIRD_PERSON.blockScale;
        if (!(depth > THIRD_PERSON.minDistance)) orbit.dist = THIRD_PERSON.minDistance;
        orbit.target = Math.max(depth, THIRD_PERSON.minDistance);
        free[k < 2 ? 0 : 1] = false;
      });
    }
    orbit.yaw = yaw;
    orbit.pitch = pitch;
    if (free[0] && free[1]) orbit.target += THIRD_PERSON.distanceStep;
    if (orbit.target >= THIRD_PERSON.distance) orbit.target = THIRD_PERSON.distance;
  };

  // Modes 1 and 4 use the view object's FOV (arms +0x1e4, FUN_0045fcd0); the orbits tan(pi/4).
  const fovYDeg = (): number => verticalFovDeg(mode === 1 || mode === 4 ? tanX() : FIRST_PERSON_CONSTANTS.tanWorld);

  return {
    update(_dt: number): void {
      // The Euler order first: setting it re-derives the quaternion from the angles.
      if (ctx.camera.rotation.order !== "YXZ") ctx.camera.rotation.order = "YXZ";
      const m = sync();
      const override = m === 4 ? stationaryGunsOf(ctx)?.playerView() ?? null : null;
      if (m === 1) {
        computeEye(ctx, ctx.camera.position, ctx.camera.quaternion);
      } else if (override) {
        // Mode 4 (FUN_0045fcd0): the override eye and the gun matrix (columns right, barrel, up; IGI -> engine (x, z, -y)).
        const o = ctx.level?.originIgi ?? [0, 0, 0];
        const e = override.eye;
        ctx.camera.position.set((e[0] - o[0]) * U, (e[2] - o[2]) * U, -(e[1] - o[1]) * U);
        const g = override.matrix;
        const right = new THREE.Vector3(g[0], g[6], -g[3]);
        const fwd = new THREE.Vector3(g[1], g[7], -g[4]);
        const upv = new THREE.Vector3(g[2], g[8], -g[5]);
        look.makeBasis(right, upv, fwd.negate());
        ctx.camera.quaternion.setFromRotationMatrix(look);
      } else {
        computeEye(ctx, eye, view);
        place(ctx.camera.position);
        // FUN_004813d0: look at the eye, no roll.
        look.lookAt(ctx.camera.position, eye, up);
        ctx.camera.quaternion.setFromRotationMatrix(look);
      }
      const fov = fovYDeg();
      if (ctx.camera.fov !== fov) {
        ctx.camera.fov = fov;
        ctx.camera.updateProjectionMatrix();
      }
    },
    fovYDeg,
    lookScale(): number {
      return tanX() / CAMERA.worldTanHalfFovX;
    },
    viewMode(): ViewMode {
      return sync();
    },
    orbitTick(dx: number, dy: number, invertY = true, sensitivity = 1): void {
      const m = sync();
      if (m === 1) return;
      const turn = lookChannel(dx);
      if (m === 3) {
        // FUN_00481660: the human's channels (FUN_0045cde0: invert flip, x sensitivity), yaw -turn.
        const k = lookSensitivity(sensitivity);
        const lookC = Math.fround(k * lookChannel(invertY ? dy : -dy));
        const turn3 = Math.fround(k * turn);
        rampDistance();
        orbit.pitch = Math.fround(lookC * THIRD_PERSON.orbitScale + orbit.pitch);
        clampPitch();
        orbit.yaw = Math.fround(turn3 * -THIRD_PERSON.orbitScale + orbit.yaw);
        return;
      }
      if (m === 5) {
        // FUN_004821d0: the raw port value (no invert flip), yaw +turn. The first
        // tick's look at the killer (FUN_00482dc0, cam+0x124 bit 0) is not reproduced.
        computeEye(ctx, eye, view);
        rampDistance();
        deathScan(lookChannel(dy) * THIRD_PERSON.orbitScale, turn * THIRD_PERSON.orbitScale);
        clampPitch();
      }
    },
  };
}
