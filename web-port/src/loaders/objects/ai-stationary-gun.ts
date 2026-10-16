/**
 * AIStationaryGunHolder + AIStationaryGun: the ceiling sentry turrets of
 * mission 14 (holder model 456_11_1, its ATTA 456_12_1 is the turret, gun
 * 456_13_1 = WEAPON_ID_SENTRY). IGI units, radians, row-major matrices.
 *
 * Recovered (full exe):
 *   - Holder (FUN_0046e370, size 0x26a0): create 0x46e210: Viewcone Alpha /
 *     Gamma 360 deg (+0x25e8 / +0x25ec), length 10 m (+0x25f0), team 1
 *     (+0x2694), isOn 0 (+0x2698). Compile FUN_0046e7f0: the model's children
 *     (FUN_004e0930: the ATTA magic objects, here the AIStationaryGun), the
 *     detector cone alpha x pi/180 (+0x130), gamma x pi/180 (+0x138), length
 *     x 4096 (+0x140), flags FUN_004896c0(det, 1, 4, FUN_00464250(4, 8)).
 *   - Holder update 0x46e5b0: team = fistp(Team expression), isOn =
 *     (char)fistp(On expression) (each only when valid); off: when it was on
 *     the detector is reset; on: the detector frame = the holder's pose and
 *     FUN_00489750(det, frame, self, team) runs on its phase ticks; then the
 *     children and the model children (the turret's update 0x46f390).
 *   - Turret def (DefineMagicObj tail, FUN_0046fa50): +0x00 gun model, +0x28
 *     max side, +0x20 max up, +0x24 max down (deg x f32 pi/180), +0x2c ammo,
 *     +0x30 / +0x34 pitch / yaw step (deg/s x pi/180 x f32 1/30), +0x38 sound,
 *     +0x58 spin step (same), +0x5c min range (m x 4096.0f).
 *   - Turret create FUN_0046eae0: holder +0x130, def +0x1b8, the Gun of the
 *     weaponconfig whose "Gun Model" is the def's (FUN_00413c00) with the def's
 *     ammo; pitch +0x1bc, yaw +0x1c0, memory +0x1d4, spin +0x1e4 all 0.
 *   - Turret update 0x46f390: target = the first slot of the holder's enemy
 *     list (det +0x18) with "visible" (+0x29) and an object; local = H^T
 *     (object - turret) (H = holder matrix); yaw = FUN_00414950(local), d2 =
 *     |local|^2 (FUN_004b3160), pitch = angle between local and its horizontal
 *     projection, negative below. Memory: a target that disappears keeps the
 *     last angles for 90 ticks (+0x1d4 = 0x5a); with no target and no memory
 *     the angles are 0. maxSide > 2 pi (f32 0x5334a8): |target yaw - yaw| > pi
 *     -> target yaw += 2 pi. Pitch / yaw slew by the steps without overshoot;
 *     clamp FUN_0046f9d0 (pitch [maxDown, maxUp], yaw +-maxSide only below 2 pi).
 *     Fire FUN_0046f950(gun, f): f = target && |dpitch| < 5 deg && |dyaw| <
 *     5 deg (f32 0x53387c) && d2 > minRange^2; then spin += def +0x58. The
 *     turning sound (def +0x38, looped at the turret) runs while the error to
 *     the target clamped to the limits exceeds 2 deg (f32 0x533834).
 *   - Pose: turret = H x B x Rz(yaw) (B = its ATTA matrix, FUN_0046fba0);
 *     gun at the turret origin (FUN_00414e20 index 1: 456_12_1 has no magic
 *     vertex) = H x B x FUN_004b38e0(pitch, spin, yaw + pi) (FUN_0046ec90).
 * Engine protocol: event "turret.update" { team, isOn, wasOn } after the
 * holder's expressions; the engine runs the detector and the turret.
 */
import { registerTaskBehaviour } from "../mission";
import { qvmRoundToInt } from "../qvm-vm";
import { x87StoreF32 } from "../x87";
import { applyM3, eulerZYX, mulM3, type M3 } from "./stationary-gun";

type V3 = [number, number, number];
const f32 = x87StoreF32;

export const AI_TURRET = {
  deg: Math.fround(0.01745329238474369),
  /** f32 1/30 (0x533678). */
  perTick: Math.fround(0.03333333507180214),
  /** f32 2 pi (0x5334a8). */
  twoPiF: Math.fround(6.2831854820251465),
  /** double 2 pi (0x533728) of the clamp. */
  twoPi: 6.283185307179586,
  pi: Math.fround(3.1415927410125732),
  /** Fire window, f32 0x53387c (5 deg); turning sound threshold f32 0x533834 (2 deg). */
  aimWindow: Math.fround(0.0872664675116539),
  soundThreshold: Math.fround(0.03490658476948738),
  /** Lost-target memory (+0x1d4 = 0x5a). */
  memoryTicks: 90,
  /** Holder create defaults (0x46e210). */
  holderDefaults: { alpha: 360, gamma: 360, lengthM: 10, team: 1 },
} as const;

const T = AI_TURRET;

/** The turret definition (DefineMagicObj ..., TASKTYPE_AISTATIONARYGUN, gunModel, ...) [FUN_0046fa50]. */
export interface AiTurretDef {
  model: string;
  gunModel: string;
  /** Radians (deg x f32 pi/180, stored as float). */
  maxSide: number;
  maxUp: number;
  maxDown: number;
  ammo: number;
  /** Per tick, radians. */
  pitchStep: number;
  yawStep: number;
  sound: string;
  spinStep: number;
  /** Units. */
  minRange: number;
}

/** DefineMagicObj(name, model, TASKTYPE_AISTATIONARYGUN, gunModel, side, up, down, ammo, pitchSpeed, yawSpeed, sound, spin, minRange). */
export function aiTurretDef(args: readonly unknown[]): AiTurretDef | null {
  const n = (i: number) => (typeof args[i] === "number" ? (args[i] as number) : 0);
  const s = (i: number) => (typeof args[i] === "string" ? (args[i] as string) : "");
  if (typeof args[0] !== "string") return null;
  const step = (deg: number) => f32(Math.fround(deg) * T.deg * T.perTick);
  return {
    model: s(1) || s(0),
    gunModel: s(3),
    maxSide: f32(Math.fround(n(4)) * T.deg),
    maxUp: f32(Math.fround(n(5)) * T.deg),
    maxDown: f32(Math.fround(n(6)) * T.deg),
    ammo: Math.trunc(n(7)),
    pitchStep: step(n(8)),
    yawStep: step(n(9)),
    sound: s(10),
    spinStep: step(n(11)),
    minRange: f32(Math.fround(n(12)) * 4096),
  };
}

/** The holder's detector cone (FUN_0046e7f0): alpha / gamma radians, length units. */
export function aiTurretHolderCone(params: Record<string, unknown>): { alpha: number; gamma: number; length: number } {
  const d = T.holderDefaults;
  const num = (k: string, v: number) => (typeof params[k] === "number" ? (params[k] as number) : v);
  return {
    alpha: Math.fround(num("Viewcone Alpha", d.alpha)) * T.deg,
    gamma: Math.fround(num("Viewcone Gamma", d.gamma)) * T.deg,
    length: Math.fround(num("Viewcone Length", d.lengthM)) * 4096,
  };
}

/** Run-time turret fields (+0x1bc ...). */
export interface AiTurretState {
  pitch: number;
  yaw: number;
  /** +0x1d4 memory countdown, +0x1d8 had a target last tick, +0x1dc / +0x1e0 remembered angles. */
  memory: number;
  hadTarget: boolean;
  memPitch: number;
  memYaw: number;
  /** +0x1e4 barrel spin. */
  spin: number;
}

export function newAiTurretState(): AiTurretState {
  return { pitch: 0, yaw: 0, memory: 0, hadTarget: false, memPitch: 0, memYaw: 0, spin: 0 };
}

/** FUN_00414950 (horizontal angle of (x, y, 0), negative to the right). */
function horizontal(v: readonly number[]): number {
  const n = Math.hypot(v[0], v[1]);
  if (n === 0) return 0;
  const a = Math.acos(Math.max(-1, Math.min(1, v[1] / n)));
  return v[0] > 0 ? -a : a;
}

/** The target angles of an object as the turret sees it (0x46f44e-0x46f59b). */
export function aiTurretAim(holder: M3, turret: readonly number[], object: readonly number[]): { pitch: number; yaw: number; d2: number } {
  const d = [object[0] - turret[0], object[1] - turret[1], object[2] - turret[2]];
  const l: V3 = [
    holder[0] * d[0] + holder[3] * d[1] + holder[6] * d[2],
    holder[1] * d[0] + holder[4] * d[1] + holder[7] * d[2],
    holder[2] * d[0] + holder[5] * d[1] + holder[8] * d[2],
  ];
  const yaw = Math.fround(horizontal(l));
  const d2 = Math.fround(l[0] * l[0] + l[1] * l[1] + l[2] * l[2]);
  const n1 = Math.hypot(l[0], l[1], l[2]);
  const n2 = Math.hypot(l[0], l[1]);
  let pitch = 0;
  if (n1 > 0 && n2 > 0) pitch = Math.fround(Math.acos(Math.max(-1, Math.min(1, Math.fround((l[0] * l[0] + l[1] * l[1]) / (n1 * n2))))));
  else if (n1 > 0) pitch = Math.fround(Math.PI / 2);
  if (l[2] < 0) pitch = -pitch;
  return { pitch, yaw, d2 };
}

/** FUN_0046f9d0. */
export function clampAiTurret(def: AiTurretDef, st: AiTurretState): void {
  if (st.pitch < def.maxDown) st.pitch = def.maxDown;
  else if (def.maxUp < st.pitch) st.pitch = def.maxUp;
  if (def.maxSide < T.twoPi) {
    if (st.yaw < -def.maxSide) st.yaw = -def.maxSide;
    else if (def.maxSide < st.yaw) st.yaw = def.maxSide;
  }
}

const slew = (value: number, target: number, step: number): number => {
  if (target <= value) {
    if (target < value) {
      const v = f32(value - step);
      return v < target ? target : v;
    }
    return value;
  }
  const v = f32(step + value);
  return target < v ? target : v;
};

/**
 * Turret update 0x46f390 for the target's angles (null: no visible enemy).
 * Returns the fire flag of FUN_0046f950 and whether the turning sound runs.
 */
export function stepAiTurret(def: AiTurretDef, st: AiTurretState, aim: { pitch: number; yaw: number; d2: number } | null): { fire: boolean; turning: boolean } {
  const has = aim !== null;
  let tp = aim ? aim.pitch : 0;
  let ty = aim ? aim.yaw : 0;
  if (!st.hadTarget) {
    if (has) st.memory = 0;
  } else if (!has) st.memory = T.memoryTicks;
  else st.memory = 0;
  st.hadTarget = has;
  if (st.memory === 0) {
    st.memPitch = tp;
    st.memYaw = ty;
  } else {
    tp = st.memPitch;
    ty = st.memYaw;
    st.memory -= 1;
  }
  if (T.twoPiF < def.maxSide && Math.abs(f32(ty - st.yaw)) > T.pi) ty = f32(ty + T.twoPiF);
  st.pitch = slew(st.pitch, tp, def.pitchStep);
  st.yaw = slew(st.yaw, ty, def.yawStep);
  clampAiTurret(def, st);
  const dp = Math.abs(f32(st.pitch - tp));
  const dy = Math.abs(f32(st.yaw - ty));
  let fire = false;
  if (has) {
    fire = dp < T.aimWindow && dy < T.aimWindow && !(aim!.d2 <= f32(def.minRange * def.minRange));
    if (fire) st.spin = f32(def.spinStep + st.spin);
  }
  // The turning sound compares with the target clamped to the limits (always, also above 2 pi).
  const cp = tp < def.maxDown ? def.maxDown : def.maxUp < tp ? def.maxUp : tp;
  const cy = ty < -def.maxSide ? -def.maxSide : def.maxSide < ty ? def.maxSide : ty;
  const turning = T.soundThreshold < Math.abs(f32(st.pitch - cp)) || T.soundThreshold < Math.abs(f32(st.yaw - cy));
  return { fire, turning };
}

/** The turret and gun matrices (FUN_0046fba0 / FUN_0046ec90). `attach` = the ATTA matrix B (row-major, world = B local). */
export function aiTurretPose(holder: M3, attach: M3, st: AiTurretState): { turret: M3; gun: M3 } {
  const hb = mulM3(holder, attach);
  return { turret: mulM3(hb, eulerZYX(0, 0, st.yaw)), gun: mulM3(hb, eulerZYX(st.pitch, st.spin, f32(st.yaw + T.pi))) };
}

/** The gun's muzzle (magic vertex 2) and direction (col 1) for a gun pose at `origin`. */
export function aiTurretMuzzle(origin: readonly number[], gun: M3, magic2: readonly number[]): { muzzle: V3; dir: V3 } {
  const o = applyM3(gun, magic2);
  return { muzzle: [origin[0] + o[0], origin[1] + o[1], origin[2] + o[2]], dir: [gun[1], gun[4], gun[7]] };
}

export const AI_TURRET_EVENTS = {
  /** event after the holder's expressions: { team, isOn, wasOn }. */
  update: "turret.update",
} as const;

registerTaskBehaviour("AIStationaryGunHolder", {
  expressions: ["On expression", "Team expression"],
  create(c) {
    Object.assign(c.state, { team: T.holderDefaults.team, isOn: 0 });
  },
  update(c) {
    const s = c.state;
    const wasOn = s.isOn;
    const team = c.eval("Team expression");
    if (team !== null) s.team = qvmRoundToInt(team);
    const on = c.evalByte("On expression");
    if (on !== null) s.isOn = on;
    c.updateChildren();
    c.emit(AI_TURRET_EVENTS.update, { team: s.team, isOn: s.isOn, wasOn });
  },
});
