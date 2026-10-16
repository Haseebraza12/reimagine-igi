/**
 * AITYPE_GUNNER combat (full exe): the soldier takes the StationaryGun set by
 * AIFunction_SetGunnerID once its target has stayed inside the gun's arcs for
 * 30 ticks, and fights from it (docs/ai.md "Gunners").
 *
 * Recovered:
 *   - Start FUN_0048d2c0: tick FUN_0048d340, stop FUN_0048d7d0; the target
 *     record of the first event with an "other" object; data +0x1c = 30
 *     (the arc counter), +0x20 = 0 (not-visible ticks).
 *   - Tick FUN_0048d340: the common target refresh (FUN_0048a920; no target
 *     slot -> the action ends). With a gunner id (H+0x3ac8 != -1): the gun
 *     (FUN_004f1030; unknown -> "Stationary gun ID #%d not found"); a gun in
 *     use by someone else is skipped; else the target's aim point (FUN_00451380)
 *     minus the gun's origin (+0xf0), into the base frame (+0x108^T), negated:
 *     v = FUN_004148f0, h = FUN_00414950; in the arcs when |h| < maxSide and
 *     maxDown < v < maxUp (deg x f32 pi/180).
 *       Not on the gun (body state != 36): in the arcs: the counter runs down
 *       and at 0 request 4 = float(gun id) (channel 24: the body mounts in its
 *       pre-update, FUN_00459d50); out of the arcs: counter = 30. Then it fights
 *       as a guard with its own weapon (FUN_0048d080) or logs "No primary
 *       weapon" (H+0x3e00 = -1).
 *       On the gun: in the arcs: counter = 30; out: the counter runs down and
 *       at 0 request 0 (channel 20) and unregister as attacker (-1) - the gun
 *       state's tick 0x45c9b0 leaves only on a fresh channel-24 press or death,
 *       so the soldier stays on the gun. The AI eye / view = the gun's pose
 *       (FUN_00475310: pivot, gun matrix). Visible target: with fewer than 4
 *       attackers firing: status 0, aim point, a fire sequence (FUN_0048b9c0;
 *       the first one halves the hit probability) with the fire tick
 *       FUN_0048d8b0 -> FUN_0048d8e0; else status 2. Not visible: status -1,
 *       count; above the targeting timeout (H+0x3d50) the action ends; else
 *       turn toward the last known position (FUN_004525b0, 2 deg).
 *   - Fire tick FUN_0048d8e0: the gun (on the gun: the StationaryGun's Gun
 *     +0x20c); aim += (target aim - aim) x aim precision; for weapon types
 *     0..2: done when the rounds left or the clip are 0; request 6 (aim); a
 *     changed clip counts a round (the endless gun's clip -1 never changes:
 *     the sequence never ends while the target is visible) and draws the shot
 *     delay for single-shot weapons; facing the aim within 2 deg -> fire
 *     (channel 6) when the delay is over.
 *   - The gun turns by the user's channels (yaw -= ch0 pi, pitch += ch1 pi):
 *     the AI turn writes clamp(error, +-pi) / pi, so the gun follows the error.
 */
import { AI_TURN_CLAMP, aiAimStep, aiRoundsPerSequence, aiRulesHitProbability, aiShotDelayTicks, aiSteerValue } from "../../loaders";
import { gunnerArcs, type M3, type StationaryGunDef } from "../../loaders/objects/stationary-gun";
import type { ActionRecord, HumanAi } from "./human-ai";
import { BODY, CH } from "./motor";
import { dist, type V3 } from "./types";

const DEG = Math.PI / 180;
/** FUN_004525b0 tolerance of the fire tick and the look: 2 deg (0x3d0efa35). */
const AIM_TOL = Math.fround(2 * DEG);
/** data +0x1c (FUN_0048d2c0). */
export const GUNNER_ARC_DELAY = 30;

/** What the GUNNER reads of its StationaryGun (combat/stationary-guns.ts through AiHooks.stationaryGun). */
export interface AiStationaryGun {
  def: StationaryGunDef;
  /** +0x21c and the user (+0x208, the soldier's AI key; null = none / the player). */
  inUse: boolean;
  userKey: number | null;
  /** FUN_00475310 GetPose: pivot (+0x170) and gun matrix (+0x188). */
  pose(): { pivot: V3; gun: M3 };
  /** The attached Gun's Rounds/Clip, Maximum Rounds/Burst and clip (+0x144, -1 endless). */
  clipSize: number;
  maxBurst: number;
  clip(): number;
}

/** The gunner's part of the combat data. */
export interface GunnerData {
  /** data +0x1c: the arc counter. */
  arcCount: number;
  /** data +0x20: ticks the target was not visible while on the gun. */
  notVisible: number;
  fire: GunnerFire | null;
}

/** FUN_0048b9c0's sequence state for the gun (aim +0x3e70, rounds +0x3e54, clip +0x3e58, delay +0x3e60). */
export class GunnerFire {
  aim: V3;
  rounds: number;
  lastClip: number;
  delay = 0;
  readonly p: number;

  constructor(ai: HumanAi, gun: AiStationaryGun, eye: V3, forward: V3, targetAim: V3, firstSequence: boolean) {
    const r = ai.world.rng.float();
    const cfg = ai.cfg;
    this.rounds = cfg ? aiRoundsPerSequence(cfg, gun.clipSize, gun.maxBurst, r) : 1;
    const d = dist(eye, targetAim);
    this.p = cfg ? aiRulesHitProbability(d, ai.view.primary.length, cfg, firstSequence) : 0.5;
    ai.motor.hitProbability = this.p;
    this.aim = [eye[0] + forward[0] * d, eye[1] + forward[1] * d, eye[2] + forward[2] * d];
    this.lastClip = gun.clip();
  }
}

/** FUN_004525b0 in the gun's frame (the AI eye is the gun pose): turn / pitch requests, true when facing within `tol`. */
export function gunnerTurnTo(ai: HumanAi, pose: { pivot: V3; gun: M3 }, point: readonly number[], tol: number): boolean {
  const g = pose.gun;
  const d = [point[0] - pose.pivot[0], point[1] - pose.pivot[1], point[2] - pose.pivot[2]];
  const x = g[0] * d[0] + g[3] * d[1] + g[6] * d[2];
  const y = g[1] * d[0] + g[4] * d[1] + g[7] * d[2];
  const z = g[2] * d[0] + g[5] * d[1] + g[8] * d[2];
  const yawErr = x === 0 && y === 0 ? 0 : Math.atan2(x, y);
  const pitchErr = Math.atan2(z, Math.hypot(x, y));
  if (Math.abs(yawErr) <= tol && Math.abs(pitchErr) <= tol) return true;
  ai.ch[CH.TURN] = aiSteerValue(yawErr, AI_TURN_CLAMP.normal);
  ai.ch[CH.PITCH] = aiSteerValue(pitchErr, AI_TURN_CLAMP.normal);
  return false;
}

/** FUN_0048d8e0 on the gun; true when the sequence is done. */
export function gunnerFireTick(ai: HumanAi, gun: AiStationaryGun, f: GunnerFire, targetAim: V3): boolean {
  const pose = gun.pose();
  if (!(targetAim[0] === f.aim[0] && targetAim[1] === f.aim[1] && targetAim[2] === f.aim[2])) f.aim = aiAimStep(f.aim, targetAim, ai.cfg ? ai.cfg.aimPrecision : 1);
  const clip = gun.clip();
  if (f.rounds === 0 || clip === 0) return true;
  ai.ch[CH.AIM] = 1; // request 6
  if (clip !== f.lastClip) {
    f.lastClip = clip;
    f.rounds -= 1;
    f.delay = gun.maxBurst === 1 && ai.cfg ? aiShotDelayTicks(ai.cfg, 1, ai.world.rng.float()) : 0;
  }
  ai.motor.hitProbability = f.p;
  ai.aimPoint = f.aim;
  if (gunnerTurnTo(ai, pose, f.aim, AIM_TOL)) {
    if (f.delay === 0) {
      ai.ch[CH.FIRE] = 1;
      return false;
    }
    f.delay -= 1;
  }
  return false;
}

/** The pieces of combat.ts the gunner tick uses (kept there: the target record and the guard tick). */
export interface GunnerHost {
  data: GunnerData;
  visible: boolean;
  first: boolean;
  /** The target's aim point (FUN_00451380) and its last known position. */
  aim(): V3;
  setStatus(status: number): void;
  /** Attackers other than this one firing at the target (FUN_00451270). */
  firing(): number;
  /** FUN_0048d080: the guard combat tick with the soldier's own weapon. */
  guard(): void;
  end(): void;
}

/** FUN_0048d340 (after the common refresh). */
export function gunnerTick(ai: HumanAi, rec: ActionRecord, h: GunnerHost): void {
  void rec;
  const d = h.data;
  let gun: AiStationaryGun | null = null;
  let inArcs = false;
  if (ai.gunnerId !== -1) {
    gun = ai.world.hooks.stationaryGun?.(ai.gunnerId) ?? null;
    if (!gun) ai.world.hooks.log?.(`Stationary gun ID #${ai.gunnerId} not found`);
    else if (!(gun.inUse && gun.userKey !== ai.key)) inArcs = gunnerArcs(gun.def, h.aim()).inArcs;
  }
  const onGun = ai.motor.state === BODY.STATIONARY_GUN;
  if (!onGun) {
    if (inArcs) {
      if (d.arcCount === 0) {
        ai.ch[CH.USE] = ai.gunnerId; // request 4 = float(gun id)
        return;
      }
      d.arcCount -= 1;
    } else {
      d.arcCount = GUNNER_ARC_DELAY;
    }
    if (ai.motor.gun) h.guard();
    else ai.world.hooks.log?.("No primary weapon");
    return;
  }
  const notVisible = d.notVisible;
  d.notVisible = 0;
  if (inArcs) d.arcCount = GUNNER_ARC_DELAY;
  else {
    if (d.arcCount === 0) {
      ai.ch[CH.WALK_TOGGLE] = 1; // request 0
      h.setStatus(-1);
      return;
    }
    d.arcCount -= 1;
  }
  if (!gun) return;
  const pose = gun.pose();
  if (h.visible) {
    if (d.fire) {
      if (!gunnerFireTick(ai, gun, d.fire, h.aim())) return;
      d.fire = null;
    }
    if (h.firing() < 4) {
      h.setStatus(0);
      const aim = h.aim();
      const g = pose.gun;
      d.fire = new GunnerFire(ai, gun, pose.pivot, [g[1], g[4], g[7]], aim, h.first);
      h.first = false;
      if (gunnerFireTick(ai, gun, d.fire, aim)) d.fire = null;
      return;
    }
    h.setStatus(2);
    return;
  }
  h.setStatus(-1);
  d.notVisible = notVisible + 1;
  if (ai.cfg && d.notVisible > ai.cfg.targetingTimeoutTicks) {
    h.end();
    return;
  }
  d.fire = null;
  gunnerTurnTo(ai, pose, h.aim(), AIM_TOL);
}
