/**
 * StationaryGun (the M2HB tripod gun, 20 tasks in missions 4-12): the
 * deterministic part of igi.exe's class (docs/interactions.md "Stationary
 * guns"). IGI units (4096 = 1 m, z up), radians, row-major 3x3 matrices whose
 * columns are the object's axes.
 *
 * Recovered (full exe; class FUN_00473ed0, size 0x220, parent the model
 * object 0x4c48c0):
 *   - Create 0x473d30: Holder model "", Weapon ID "WEAPON_ID_M2HB" (+0x1c0),
 *     Max up 25 / down -25 / sideways 90 degrees (+0x1e0 / +0x1e4 / +0x1e8),
 *     Ammo -1 (+0x1ec); run-time pitch / yaw +0x1f8 / +0x1fc, kick +0x1f0 /
 *     +0x1f4, totals +0x200 / +0x204, user +0x208, tick stamp +0x218 = -1,
 *     in use +0x21c, all 0. Compile 0x474980: the holder model, the base
 *     matrix (Orientation) into +0x70, the same resets, the Gun created by
 *     FUN_00477c50(self, slot 0, weaponconfig(Weapon ID), Ammo, 0) at +0x20c.
 *   - Update FUN_00474190, once per application tick (+0x218 stamp):
 *       unmanned (+0x208 = 0): pitch moves toward maxDown x pi/180 (f32
 *         0x53367c) by 0.0872665 (5 deg, f32 0x53387c) per tick without
 *         overshoot; the yaw and the TOTALS are left alone; then the gun use
 *         FUN_00474360(self, 0);
 *       manned: pitch += user channel 1 (+0x1b4, look) x pi (f32 0x533400),
 *         yaw -= channel 0 (+0x1b0, turn) x pi; FUN_004748b0 clamps pitch to
 *         [maxDown, maxUp] x pi/180 and, only when maxSide x pi/180 < 2 pi
 *         (double 0x533728), yaw to +-maxSide x pi/180; fire = channel 6
 *         (+0x1c8) != 0; totals = pitch / yaw + kick; kick x 0.9 (f32
 *         0x5335a8); then FUN_00474360(self, fire).
 *     FUN_00474360 runs the Gun's use with {fire, scale = user +0x4d4 (1.0
 *     unmanned), user} and OVERWRITES the kick with the record's outputs
 *     (+0x20 / +0x24), which the Gun writes only when a round left: the
 *     recoil is a one-tick jitter on the next tick's totals.
 *   - Pose FUN_00474420: object matrix +0x70 = base x Rz(total yaw)
 *     (FUN_004b3be0; the holder model turns); pivot = origin + FUN_00414e20(
 *     self, count > 0 ? 1 : 0), which is zero when the index is not below
 *     the model's magic vertex count (FUN_004d0d20): 123_02_1 has ONE magic
 *     vertex, so the pivot is the holder's origin; gun matrix = object x
 *     FUN_004b38e0(total pitch, 0, pi) = object x Rz(pi) Rx(pitch): the
 *     barrel (gun +y, magic vertex 2 the muzzle) points along -col1 of the
 *     object. With a user: eye = pivot + 819.2 (f32 0x534134) x gun col 2 -
 *     2048 (f32 0x533688) x gun col 1, view matrix = gun matrix, written to
 *     the user's view object (FUN_004658d0: override on).
 *   - The unmanned drop therefore changes only the stored pitch: the drawn
 *     barrel keeps the last manned totals until someone mans the gun again.
 *   - Use: candidate test FUN_00474e30 (not in use; P = origin + object x
 *     magic vertex 0; (searcher - P) . col1 >= 0, then the common point test
 *     FUN_00416ad0), use kind 6 (FUN_00474ed0), start / continue
 *     FUN_00474ee0 (user taken at use counter 0, in use set every call),
 *     release FUN_00475340 (user 0, in use 0), IsInUse FUN_00475370.
 *   - Mount position (player FUN_0040c970, soldier FUN_0045c8b0) through
 *     FUN_00444b30: P = origin + object x magic 0, M = object matrix; the
 *     human stands at P + col1(M) x 2867.2 (0.7 m, double 0x533440) in x and
 *     y, its own z kept, heading gamma(M) + pi (FUN_004b3c50 + f32 pi). The
 *     player first turns M by pi when (human - P) . col1(M) < 0.
 */
import { registerTaskBehaviour } from "../mission";
import { x87StoreF32 } from "../x87";

type V3 = [number, number, number];
export type M3 = [number, number, number, number, number, number, number, number, number];
const f32 = x87StoreF32;

export const STATIONARY_GUN = {
  /** f32 pi/180 (0x53367c). */
  deg: Math.fround(0.01745329238474369),
  /** Unmanned pitch step, f32 0x53387c (5 deg). */
  dropStep: Math.fround(0.0872664675116539),
  /** f32 pi (0x533400). */
  pi: Math.fround(3.1415927410125732),
  /** double 2 pi (0x533728): sideways limits apply only below it. */
  twoPi: 6.283185307179586,
  /** f32 0.9 (0x5335a8). */
  kickDecay: Math.fround(0.8999999761581421),
  /** Eye override: 0.2 m up (f32 0x534134), 0.5 m back (f32 0x533688) along the gun axes. */
  eyeUp: Math.fround(819.2000122070312),
  eyeBack: 2048,
  /** Mount distance behind the use point, double 0x533440 (0.7 m). */
  mountBack: 2867.2,
  /** FUN_00489ea0 body clips: player state 33 (0xc6) and the soldier state 36 (0x1f). */
  playerClip: 198,
  soldierClip: 31,
  /** Use kind (FUN_00474ed0) and the gunner's request delay (FUN_0048d2c0: data +0x1c = 30). */
  useKind: 6,
  gunnerDelay: 30,
  defaults: { weaponId: "WEAPON_ID_M2HB", maxUp: 25, maxDown: -25, maxSide: 90, ammo: -1 },
} as const;

const S = STATIONARY_GUN;

/** The parameters of one StationaryGun task (create defaults overwritten by the parameters). */
export interface StationaryGunDef {
  /** +0xf0, IGI units. */
  position: V3;
  /** +0x108: the base matrix from Orientation (FUN_004a9bc0 convention Rz Ry Rx). */
  base: M3;
  holderModel: string;
  weaponId: string;
  /** Degrees as stored (float32). */
  maxUp: number;
  maxDown: number;
  maxSide: number;
  ammo: number;
}

/** Run-time fields (+0x1f0 .. +0x21c). */
export interface StationaryGunState {
  pitch: number;
  yaw: number;
  kickPitch: number;
  kickYaw: number;
  totalPitch: number;
  totalYaw: number;
  inUse: number;
}

/** A user's channels as the gun reads them: 0 turn (+0x1b0), 1 look (+0x1b4), 6 fire (+0x1c8). */
export interface StationaryGunUser {
  turn: number;
  look: number;
  fire: number;
}

/** The kick outputs of the Gun's use record (+0x20 / +0x24): non-zero only on a tick a round left. */
export interface GunKick {
  kickPitch: number;
  kickYaw: number;
}

/** Rz(c) Ry(b) Rx(a) (FUN_004b38e0 / FUN_004a9bc0). */
export function eulerZYX(a: number, b: number, c: number): M3 {
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  return [
    cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa,
    sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa,
    -sb, cb * sa, cb * ca,
  ];
}

export function mulM3(a: M3, b: M3): M3 {
  const o = new Array(9) as M3;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}

export const applyM3 = (m: M3, v: readonly number[]): V3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
export const colM3 = (m: M3, c: number): V3 => [m[c], m[3 + c], m[6 + c]];

const num = (p: Record<string, unknown>, k: string, d: number) => (typeof p[k] === "number" ? (p[k] as number) : d);
const strOf = (p: Record<string, unknown>, k: string, d: string) => (typeof p[k] === "string" && p[k] !== "" ? (p[k] as string) : d);

/** The task's parameters over the create defaults (0x473d30). */
export function stationaryGunDef(params: Record<string, unknown>): StationaryGunDef {
  const pos = params["Position"];
  const o = params["Orientation"];
  const position: V3 = Array.isArray(pos) && pos.length === 3 ? [Number(pos[0]), Number(pos[1]), Number(pos[2])] : [0, 0, 0];
  const angles = Array.isArray(o) && o.length === 3 ? o.map(Number) : [0, 0, 0];
  const d = S.defaults;
  return {
    position,
    base: eulerZYX(angles[0], angles[1], angles[2]),
    holderModel: strOf(params, "Holder model", ""),
    weaponId: strOf(params, "Weapon ID", d.weaponId),
    maxUp: f32(num(params, "Max up angle", d.maxUp)),
    maxDown: f32(num(params, "Max down angle", d.maxDown)),
    maxSide: f32(num(params, "Max sideways angle", d.maxSide)),
    ammo: Math.trunc(num(params, "Ammo", d.ammo)),
  };
}

export function newStationaryGunState(): StationaryGunState {
  return { pitch: 0, yaw: 0, kickPitch: 0, kickYaw: 0, totalPitch: 0, totalYaw: 0, inUse: 0 };
}

/** FUN_004748b0: pitch to [maxDown, maxUp], yaw to +-maxSide while maxSide < 2 pi. */
export function clampStationaryGun(def: StationaryGunDef, st: StationaryGunState): void {
  const down = f32(def.maxDown * S.deg);
  if (down <= st.pitch) {
    const up = f32(def.maxUp * S.deg);
    if (up < st.pitch) st.pitch = up;
  } else {
    st.pitch = down;
  }
  const side = f32(def.maxSide * S.deg);
  if (side < S.twoPi) {
    const neg = f32(-def.maxSide * S.deg);
    if (st.yaw < neg) st.yaw = neg;
    else if (side < st.yaw) st.yaw = side;
  }
}

/**
 * FUN_00474190 (the stamp test is the caller's): one update with the user's
 * channels (null = unmanned). `use(fire)` is the Gun's use (FUN_00474360):
 * it fires when it can and returns the kick outputs. Returns the fire request.
 */
export function stepStationaryGun(def: StationaryGunDef, st: StationaryGunState, user: StationaryGunUser | null, use: (fire: boolean) => GunKick): boolean {
  if (!user) {
    const target = f32(def.maxDown * S.deg);
    if (target <= st.pitch) {
      if (target < st.pitch) {
        st.pitch = f32(st.pitch - S.dropStep);
        if (st.pitch < target) st.pitch = target;
      }
    } else {
      st.pitch = f32(st.pitch + S.dropStep);
      if (target < st.pitch) st.pitch = target;
    }
    const k = use(false);
    st.kickPitch = f32(k.kickPitch);
    st.kickYaw = f32(k.kickYaw);
    return false;
  }
  st.pitch = f32(user.look * S.pi + st.pitch);
  st.yaw = f32(-(user.turn * S.pi) + st.yaw);
  clampStationaryGun(def, st);
  const fire = user.fire !== 0;
  st.totalPitch = f32(st.pitch + st.kickPitch);
  st.totalYaw = f32(st.yaw + st.kickYaw);
  st.kickPitch = f32(st.kickPitch * S.kickDecay);
  st.kickYaw = f32(st.kickYaw * S.kickDecay);
  const k = use(fire);
  st.kickPitch = f32(k.kickPitch);
  st.kickYaw = f32(k.kickYaw);
  return fire;
}

/** The posed gun (FUN_00474420) and the user's eye override. */
export interface StationaryGunPose {
  /** +0x70: base x Rz(total yaw) - the holder model's matrix. */
  object: M3;
  /** +0x170: the gun's origin. */
  pivot: V3;
  /** +0x188: object x Rz(pi) Rx(total pitch). */
  gun: M3;
  /** The view override of a user: pivot + 0.2 m gun col 2 - 0.5 m gun col 1. */
  eye: V3;
}

/** FUN_00474420. `magicCount` = the holder model's magic vertex count, `magic1` its vertex 1 (when it has one). */
export function stationaryGunPose(def: StationaryGunDef, st: StationaryGunState, magicCount: number, magic1: readonly number[] | null = null): StationaryGunPose {
  const object = mulM3(def.base, eulerZYX(0, 0, st.totalYaw));
  // FUN_00414e20(self, count > 0 ? 1 : 0): zero offset unless the index is below the count.
  const index = magicCount > 0 ? 1 : 0;
  const off: V3 = index < magicCount && magic1 ? applyM3(object, magic1) : [0, 0, 0];
  const pivot: V3 = [def.position[0] + off[0], def.position[1] + off[1], def.position[2] + off[2]];
  const gun = mulM3(object, eulerZYX(st.totalPitch, 0, S.pi));
  const c1 = colM3(gun, 1);
  const c2 = colM3(gun, 2);
  const eye: V3 = [
    f32(c2[0] * S.eyeUp - c1[0] * S.eyeBack) + pivot[0],
    f32(c2[1] * S.eyeUp - c1[1] * S.eyeBack) + pivot[1],
    f32(c2[2] * S.eyeUp - c1[2] * S.eyeBack) + pivot[2],
  ];
  return { object, pivot, gun, eye };
}

/** FUN_00444b30: the use point origin + object x magic vertex 0 and the object matrix. */
export function stationaryGunUsePoint(def: StationaryGunDef, st: StationaryGunState, magic0: readonly number[] | null): { point: V3; matrix: M3 } {
  const matrix = mulM3(def.base, eulerZYX(0, 0, st.totalYaw));
  const off = magic0 ? applyM3(matrix, magic0) : [0, 0, 0];
  return { point: [def.position[0] + off[0], def.position[1] + off[1], def.position[2] + off[2]], matrix };
}

/** FUN_00474e30's side test: a free gun is a candidate only from behind ((p - P) . col1 >= 0). */
export function stationaryGunBehind(usePoint: readonly number[], matrix: M3, searcher: readonly number[]): boolean {
  const c1 = colM3(matrix, 1);
  return (searcher[0] - usePoint[0]) * c1[0] + (searcher[1] - usePoint[1]) * c1[1] + (searcher[2] - usePoint[2]) * c1[2] >= 0;
}

/**
 * FUN_0040c970 (player, `flip`) / FUN_0045c8b0 (soldier): the human's new x, y
 * (z kept) 0.7 m behind the use point and its heading gamma(M) + pi.
 */
export function stationaryGunMount(usePoint: readonly number[], matrix: M3, human: readonly number[], flip: boolean): { x: number; y: number; heading: number } {
  let m = matrix;
  const c1 = colM3(m, 1);
  if (flip && (human[0] - usePoint[0]) * c1[0] + (human[1] - usePoint[1]) * c1[1] + (human[2] - usePoint[2]) * c1[2] < 0) {
    m = mulM3(m, eulerZYX(0, 0, S.pi)); // FUN_004b3790(M, M, pi)
  }
  const a = colM3(m, 1);
  const x = f32(a[0] * f32(S.mountBack)) + usePoint[0];
  const y = a[1] * f32(S.mountBack) + usePoint[1];
  // FUN_004b3c50: gamma = atan2(m[3], m[0]) (the heading of the matrix), + f32 pi.
  const gamma = Math.fround(Math.atan2(m[3], m[0]));
  return { x, y, heading: Math.fround(gamma + S.pi) };
}

/**
 * The gunner's arc test (FUN_0048d340): local = -(base^T (aim - origin)),
 * v = FUN_004148f0 (vertical angle of (0, y, z)), h = FUN_00414950
 * (horizontal angle of (x, y, 0)); in the arcs when |h| < maxSide and
 * maxDown < v < maxUp (radians).
 */
export function gunnerArcs(def: StationaryGunDef, aim: readonly number[]): { v: number; h: number; inArcs: boolean } {
  const d = [aim[0] - def.position[0], aim[1] - def.position[1], aim[2] - def.position[2]];
  const b = def.base;
  const l = [-(b[0] * d[0] + b[3] * d[1] + b[6] * d[2]), -(b[1] * d[0] + b[4] * d[1] + b[7] * d[2]), -(b[2] * d[0] + b[5] * d[1] + b[8] * d[2])];
  const vn = Math.hypot(l[1], l[2]);
  const v = vn === 0 ? 0 : (l[2] < 0 ? -1 : 1) * Math.acos(Math.max(-1, Math.min(1, l[1] / vn)));
  const hn = Math.hypot(l[0], l[1]);
  const h = hn === 0 ? 0 : (l[0] > 0 ? -1 : 1) * Math.acos(Math.max(-1, Math.min(1, l[1] / hn)));
  const side = f32(def.maxSide * S.deg);
  const inArcs = Math.abs(h) < side && f32(def.maxDown * S.deg) < v && v < f32(def.maxUp * S.deg);
  return { v, h, inArcs };
}

// --- the task behaviour ----------------------------------------------------------------

/** Engine protocol (MissionHost.query / onTaskEvent). */
export const STATIONARY_GUN_EVENTS = {
  /** query (node) -> StationaryGunUser | null: the mounted user's channels. */
  user: "sgun.user",
  /** query (node, fire: boolean) -> GunKick: the attached Gun's use (FUN_00474360). */
  use: "sgun.use",
  /** event after the pose (FUN_00474420): the engine moves the models and the user's view. */
  posed: "sgun.posed",
} as const;

const defs = new WeakMap<object, StationaryGunDef>();

/** The parsed parameters of a StationaryGun node (cached). */
export function stationaryGunDefOf(node: { task: { params: Record<string, unknown> } }): StationaryGunDef {
  let d = defs.get(node);
  if (!d) {
    d = stationaryGunDef(node.task.params);
    defs.set(node, d);
  }
  return d;
}

const NO_KICK: GunKick = { kickPitch: 0, kickYaw: 0 };

registerTaskBehaviour("StationaryGun", {
  create(c) {
    Object.assign(c.state, newStationaryGunState());
    stationaryGunDefOf(c.node);
  },
  update(c) {
    const def = stationaryGunDefOf(c.node);
    const st = c.state as unknown as StationaryGunState;
    const user = (c.host.query?.(STATIONARY_GUN_EVENTS.user, c.node) as StationaryGunUser | null | undefined) ?? null;
    st.inUse = user ? 1 : 0;
    stepStationaryGun(def, st, user, (fire) => (c.host.query?.(STATIONARY_GUN_EVENTS.use, c.node, fire) as GunKick | undefined) ?? NO_KICK);
    c.emit(STATIONARY_GUN_EVENTS.posed);
    c.updateChildren();
  },
});
