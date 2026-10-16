/**
 * The player's "use" target search and the per-type use tests of igi.exe
 * (docs/interactions.md §1-2). Everything here works in IGI space: units
 * (4096 = 1 m), z up, row-major 3x3 matrices whose columns are the object's
 * model axes in world space (obj+0x70).
 *
 * Recovered:
 *   - Each player tick, FUN_0045fb20 (called third in FUN_00410a30) clears
 *     the target (human+0x7b0) and, only while the human is grounded
 *     (state flag 4) and not using anything (+0x7b8 == 0), builds a search
 *     context: origin = the camera eye (camera+0xe0), view axes (camera+0xf8:
 *     columns right, forward, up), best vertical / horizontal angle = pi/4
 *     for the player (FUN_00461d90; pi for other humans), range 8192 units
 *     (2 m, f64 at context+0x78). It calls method 0x42a ("use-target test")
 *     of every object in the use list (DAT_00577b5c) in list order; the
 *     winner (context+0x80) becomes the target.
 *   - FUN_004159d0 (the common point test): the candidate point must be
 *     closer than the range (3-D, from the eye), in front of the view
 *     (view-space y > 0), with |vertical angle| (FUN_004868f0: angle of
 *     (0, y, z)) and |horizontal angle| (FUN_00486950: angle of (x, y, 0))
 *     both strictly below the current best; then both bests are replaced.
 *   - Ladder bottom and Fence do not use it: inside their region they claim
 *     the target with both angles 0, so no later candidate can beat them.
 *   - Use kinds (method 0x42b): Switch 2, Door 3, Cabinet 4, Terminal 5
 *     (also AlarmControl / SCameraControl, which derive from Terminal),
 *     StationaryGun 6, Wire 9, Ladder 10, Fence 11, GenericTBA 12,
 *     PlaceExplosiveTBA 13 (0x4e6d20, 0x4e6b60, 0x427380, 0x442f50,
 *     0x4736f0, 0x43e880, 0x43f880, 0x4e6430, 0x4261c0, 0x437e80).
 *   - HUD action icon (method 0x42e -> FUN_00485130, docs/hud.md): a_wire,
 *     a_fence, a_ladder, action_comput, action_searchcab,
 *     action_pressbutton, a_door or action_picklock (locked door), a_gun.
 */
import { x87Fistp, x87StoreF32 } from "../../loaders/x87";
import {
  WIRE_SLIDE_END_MARGIN,
  WIRE_SLIDE_HANG,
  WIRE_TRAVERSE_END_MARGIN,
  WIRE_TRAVERSE_HANG,
  wireAttachFrame,
  wireUseMode,
  type WireModelInfo,
  type WirePose,
  type WireUseMode,
} from "../../loaders/wire";

export type V3 = [number, number, number];
/** Row-major 3x3; columns are the object's model axes in world space. */
export type M3 = [number, number, number, number, number, number, number, number, number];

/** The "use kind" an object answers (method 0x42b) [recovered]. */
export const USE_KIND = {
  SWITCH: 2,
  DOOR: 3,
  CABINET: 4,
  TERMINAL: 5,
  STATIONARY_GUN: 6,
  WIRE: 9,
  LADDER: 10,
  FENCE: 11,
  GENERIC_TBA: 12,
  PLACE_EXPLOSIVE_TBA: 13,
} as const;
export type UseKind = (typeof USE_KIND)[keyof typeof USE_KIND];

/** HUD action icon sprite per object (status.res, FUN_00485130 callers; docs/hud.md) [recovered]. */
export const USE_ICON = {
  wire: "a_wire.spr",
  fence: "a_fence.spr",
  ladder: "a_ladder.spr",
  terminal: "action_comput.spr",
  cabinet: "action_searchcab.spr",
  switch: "action_pressbutton.spr",
  door: "a_door.spr",
  doorLocked: "action_picklock.spr",
  stationaryGun: "a_gun.spr",
} as const;

/**
 * The GenericTBA "Click to select sprite" list (DAT_0057c1f0 = 10 entries, FUN_004871b0;
 * the compile LAB_00448200 matches the name exactly) [recovered, full exe].
 */
export const TBA_SPRITES = [
  "action_searchcab.spr", "action_comput.spr", "action_picklock.spr", "a_gun.spr", "action_pressbutton.spr",
  "a_door.spr", "a_fence.spr", "a_ladder.spr", "a_wire.spr", "a_c4.spr",
] as const;

/** "STATUSSCREEN:a_c4.spr" -> "a_c4.spr" when it is one of the list's names (exact match), else null. */
export function tbaSprite(value: string | null | undefined): string | null {
  const v = value ?? "";
  const name = v.startsWith("STATUSSCREEN:") ? v.slice("STATUSSCREEN:".length) : null;
  return name && (TBA_SPRITES as readonly string[]).includes(name) ? name : null;
}

/** Search range: f64 8192 units (2 m) at context+0x78 (FUN_0045fb20) [recovered]. */
export const USE_RANGE = 8192;
/** Best-angle start values: pi/4 for the player (0x5317c0), pi for other humans (0x531400) [recovered]. */
export const USE_MAX_ANGLE_PLAYER = Math.fround(Math.PI / 4);
export const USE_MAX_ANGLE_OTHER = Math.fround(Math.PI);

// --- small vector helpers (IGI space) -----------------------------------------

export const col = (m: M3, c: number): V3 => [m[c], m[3 + c], m[6 + c]];
const dot = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: readonly number[], b: readonly number[]): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** R * v. */
export const apply = (m: M3, v: readonly number[]): V3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
/** R^T * v (world -> object axes). */
export const applyT = (m: M3, v: readonly number[]): V3 => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
];

/** acos as the CRT call behind FUN_004a8b80 (clamped). */
const acos = (x: number): number => Math.acos(x < -1 ? -1 : x > 1 ? 1 : x);

/** FUN_004868f0: signed angle of (0, y, z) from +y (negative below), 0 for a zero vector [recovered]. */
export function verticalAngle(v: readonly number[]): number {
  const n = Math.hypot(v[1], v[2]);
  if (n === 0) return 0;
  const a = acos(v[1] / n);
  return v[2] < 0 ? -a : a;
}

/** FUN_00486950: signed angle of (x, y, 0) from +y (negative to the right), 0 for a zero vector [recovered]. */
export function horizontalAngle(v: readonly number[]): number {
  const n = Math.hypot(v[0], v[1]);
  if (n === 0) return 0;
  const a = acos(v[1] / n);
  return v[0] > 0 ? -a : a;
}

/** FUN_004a8e10: angle between two vectors (0 when either is zero) [recovered]. */
export function vectorAngle(a: readonly number[], b: readonly number[]): number {
  if ((a[0] === 0 && a[1] === 0 && a[2] === 0) || (b[0] === 0 && b[1] === 0 && b[2] === 0)) return 0;
  const c = dot(a, b) / (Math.hypot(b[0], b[1], b[2]) * Math.hypot(a[0], a[1], a[2]));
  if (c >= 1) return 0;
  if (c <= -1) return Math.fround(Math.PI);
  return Math.acos(c);
}

/**
 * Heading of a rotation (the third angle of FUN_004a9f30): atan2(m[3], m[0]),
 * wrapped to [0, 2pi) [recovered]. The body yaw a human gets from it equals the
 * port's PlayerState.yaw (body forward = (-sin h, cos h, 0) in IGI axes).
 */
export function headingOf(m: M3): number {
  let h = Math.atan2(m[3], m[0]);
  if (h < 0) h += 2 * Math.PI;
  return Math.fround(h);
}

// --- the search (FUN_0045fb20 context, FUN_004159d0) ------------------------------

/** Camera eye and view axes in IGI space (camera +0xe0 / +0xf8). */
export interface UseView {
  eye: V3;
  /** Row-major; columns right, forward, up. */
  axes: M3;
}

export class UseSearch<T> {
  /** Best vertical angle (context+0x70). */
  bestVertical: number;
  /** Best horizontal angle (context+0x74). */
  bestHorizontal: number;
  winner: T | null = null;
  readonly range: number;

  constructor(readonly view: UseView, maxAngle: number = USE_MAX_ANGLE_PLAYER, range: number = USE_RANGE) {
    this.bestVertical = maxAngle;
    this.bestHorizontal = maxAngle;
    this.range = range;
  }

  /** FUN_004159d0 [recovered]: true when `point` beats the current best and `obj` becomes the winner. */
  consider(point: readonly number[], obj: T): boolean {
    const d = sub(point, this.view.eye);
    if (!(Math.hypot(d[0], d[1], d[2]) < this.range)) return false;
    const m = this.view.axes;
    const fx = Math.fround(d[0]), fy = Math.fround(d[1]), fz = Math.fround(d[2]);
    const local: V3 = [
      Math.fround(m[0] * fx + m[3] * fy + m[6] * fz),
      Math.fround(m[1] * fx + m[4] * fy + m[7] * fz),
      Math.fround(m[2] * fx + m[5] * fy + m[8] * fz),
    ];
    if (!(local[1] > 0)) return false;
    const v = Math.fround(Math.abs(verticalAngle(local)));
    const h = Math.fround(Math.abs(horizontalAngle(local)));
    if (v < this.bestVertical && h < this.bestHorizontal) {
      this.bestHorizontal = h;
      this.bestVertical = v;
      this.winner = obj;
      return true;
    }
    return false;
  }

  /**
   * PlaceExplosiveTBA's test (LAB_004389e0, full exe) [recovered]: only while nothing earlier
   * in the list won, within `range` units, in front of the view, better angles.
   */
  considerFirst(point: readonly number[], obj: T, range: number): boolean {
    if (this.winner !== null) return false;
    const d = sub(point, this.view.eye);
    if (!(Math.hypot(d[0], d[1], d[2]) < range)) return false;
    const m = this.view.axes;
    const fx = Math.fround(d[0]), fy = Math.fround(d[1]), fz = Math.fround(d[2]);
    const local: V3 = [
      Math.fround(m[0] * fx + m[3] * fy + m[6] * fz),
      Math.fround(m[1] * fx + m[4] * fy + m[7] * fz),
      Math.fround(m[2] * fx + m[5] * fy + m[8] * fz),
    ];
    if (!(local[1] > 0)) return false;
    const v = Math.fround(Math.abs(verticalAngle(local)));
    const h = Math.fround(Math.abs(horizontalAngle(local)));
    if (v < this.bestVertical && h < this.bestHorizontal) {
      this.bestHorizontal = h;
      this.bestVertical = v;
      this.winner = obj;
      return true;
    }
    return false;
  }

  /** Ladder bottom / fence region hit: winner with both angles 0 [recovered]. */
  claim(obj: T): void {
    this.bestVertical = 0;
    this.bestHorizontal = 0;
    this.winner = obj;
  }
}

// --- placed objects ---------------------------------------------------------------

/** A rigid placed object: position (+0x20), rotation (+0x70) and its model's points (XTVM, scale 1). */
export interface PlacedModel {
  position: V3;
  rotation: M3;
  /** Model points in model space (FUN_00486ed0 with scale 1). */
  points: V3[];
}

/** World offset of model point i (FUN_00486e20 with scale 1); (0, 0, 0) when the model has fewer points. */
export function pointOffset(obj: PlacedModel, i: number): V3 {
  const p = obj.points[i];
  return p ? apply(obj.rotation, p) : [0, 0, 0];
}

/** Local point i (FUN_00486ed0); (0, 0, 0) when missing. */
export function localPoint(obj: PlacedModel, i: number): V3 {
  return obj.points[i] ? [...obj.points[i]] as V3 : [0, 0, 0];
}

export const worldPoint = (obj: PlacedModel, i: number): V3 => {
  const o = pointOffset(obj, i);
  return [obj.position[0] + o[0], obj.position[1] + o[1], obj.position[2] + o[2]];
};

// --- Ladder (FUN_0043f5a0 type; tests FUN_0043f680; attach FUN_00411380) -----------

/** Ladder local x window: (-2867.2, 2867.2) (0x531868 / 0x531440) [recovered]. */
export const LADDER_HALF_WIDTH = 2867.2;
/** Rung spacing: rungs = trunc(|p2.z - p3.z| x 1/1228.8) (0x531860) [recovered]. */
export const LADDER_RUNG_SPACING = 1228.8;
/** Bottom mount: point 2 + R (0, 1515.52, 3915.776) (0x5314d0 / 0x5314c8) [recovered]. */
export const LADDER_BOTTOM_HOLD: V3 = [0, 1515.52, 3915.776];
/** Top mount: point 3 + R (0, -1638.4, 3481.6) (0x531478 / 0x531458) [recovered]. */
export const LADDER_TOP_HOLD: V3 = [0, -1638.4, 3481.6];
/** The top exit clip covers the last 6 rungs: exit at rung rungs - 6, top mount starts there [recovered]. */
export const LADDER_EXIT_RUNGS = 6;

export interface Ladder extends PlacedModel {
  kind: "ladder";
  /** +0x138: rung count (FUN_0043f440). */
  rungs: number;
  model: string;
  /** Owning Building task id. */
  taskId: number;
}

/** +0x138 = fistp(|p2.z - p3.z| x 0.00081380208) in chop mode (FUN_0043f440) [recovered]. */
export function ladderRungs(points: readonly V3[]): number {
  const p2 = points[2] ?? [0, 0, 0];
  const p3 = points[3] ?? [0, 0, 0];
  const dz = Math.abs(x87StoreF32(Math.fround(p2[2]) - Math.fround(p3[2])));
  // fmul by the float32 constant, then FISTP straight from the register (chop).
  return x87Fistp(dz * Math.fround(1 / LADDER_RUNG_SPACING));
}

/**
 * FUN_0043f680 [recovered]. Returns the mount side when the ladder answered:
 * "bottom" claims the target outright; "top" only when FUN_004159d0 accepted
 * the top point. `null` when the ladder took no part.
 *
 *   bottom: local = R^T (eye - pos): |local.y| < range, |local.x| < 2867.2,
 *           angle(view forward, -/+ ladder y) < pi/4 (towards the ladder) and
 *           pos.z < eye.z < pos.z + point1.z  -> claim (d7b = 0);
 *   top:    p1 = pos + R p1; (eye - p1) . ladder y < 0 and FUN_004159d0(p1)
 *           -> d7b = 1.
 */
export function ladderUseTest<T>(search: UseSearch<T>, ladder: Ladder, self: T): "bottom" | "top" | null {
  const eye = search.view.eye;
  const d = sub(eye, ladder.position);
  const r = ladder.rotation;
  const lx = r[0] * d[0] + r[3] * d[1] + r[6] * d[2];
  const ly = r[1] * d[0] + r[4] * d[1] + r[7] * d[2];
  let result: "bottom" | "top" | null = null;
  if (Math.abs(ly) < search.range && -LADDER_HALF_WIDTH < lx && lx < LADDER_HALF_WIDTH) {
    const forward = col(search.view.axes, 1);
    let axis = col(r, 1);
    if (ly > 0) axis = [-axis[0], -axis[1], -axis[2]];
    const angle = Math.fround(vectorAngle(forward, axis));
    const top = pointOffset(ladder, 1);
    if (angle < USE_MAX_ANGLE_PLAYER && eye[2] < top[2] + ladder.position[2] && ladder.position[2] < eye[2]) {
      search.claim(self);
      result = "bottom";
    }
  }
  const p1 = worldPoint(ladder, 1);
  const y = col(r, 1);
  if (dot(y, sub(eye, p1)) < 0 && search.consider(p1, self)) result = "top";
  return result;
}

/** Pelvis position and heading for a ladder mount (FUN_00411380) [recovered]. */
export function ladderMount(ladder: Ladder, side: "bottom" | "top"): { position: V3; heading: number; rung: number } {
  const p = side === "bottom" ? worldPoint(ladder, 2) : worldPoint(ladder, 3);
  const hold = side === "bottom" ? LADDER_BOTTOM_HOLD : LADDER_TOP_HOLD;
  const o = apply(ladder.rotation, hold);
  return {
    position: [p[0] + o[0], p[1] + o[1], p[2] + o[2]],
    heading: Math.fround(headingOf(ladder.rotation) + Math.fround(Math.PI)),
    rung: side === "bottom" ? 0 : ladder.rungs - LADDER_EXIT_RUNGS,
  };
}

// --- Wire (docs/wire.md; test FUN_0043e720; attach FUN_00411a80 / FUN_00411ec0) ------

export interface Wire {
  kind: "wire";
  taskId: number;
  nodeIndex: number;
  pose: WirePose;
  model: WireModelInfo;
  /** FUN_0043e9e0 frame (model point 0 -> 1). */
  frame: M3;
  mode: WireUseMode;
}

export function makeWire(taskId: number, nodeIndex: number, pose: WirePose, model: WireModelInfo): Wire {
  const frame = wireAttachFrame(pose, model) as M3;
  return { kind: "wire", taskId, nodeIndex, pose, model, frame, mode: wireUseMode(frame) };
}

/** Projected coordinate along the wire and its clamp window for a margin (FUN_00411a80 / FUN_00411ec0) [recovered]. */
export function wireCoordinate(wire: Wire, point: readonly number[]): { y: number; lo: number; hi: number } {
  const axis = col(wire.frame, 1);
  const y = dot(axis, sub(point, wire.pose.position));
  return { y, lo: wire.model.magicVertices[0][1] * wire.pose.scale[1], hi: wire.model.magicVertices[1][1] * wire.pose.scale[1] };
}

/** FUN_0043e720 [recovered]: the closest point of the wire to the eye goes through FUN_004159d0. */
export function wireUseTest<T>(search: UseSearch<T>, wire: Wire, self: T): boolean {
  const { y, lo, hi } = wireCoordinate(wire, search.view.eye);
  const t = Math.fround(Math.fround(y) < Math.fround(lo) ? lo : Math.fround(y) > Math.fround(hi) ? hi : y);
  const axis = col(wire.frame, 1);
  const point: V3 = [
    wire.pose.position[0] + Math.fround(axis[0] * t),
    wire.pose.position[1] + Math.fround(axis[1] * t),
    wire.pose.position[2] + Math.fround(axis[2] * t),
  ];
  return search.consider(point, self);
}

/** Margins and hang depths of the two wire modes [recovered, docs/wire.md]. */
export const WIRE_MODE = {
  traverse: { margin: WIRE_TRAVERSE_END_MARGIN, hang: WIRE_TRAVERSE_HANG },
  slide: { margin: WIRE_SLIDE_END_MARGIN, hang: WIRE_SLIDE_HANG },
} as const;

/**
 * Wire mount (FUN_00411a80 / FUN_00411ec0) [recovered]: hold point, heading
 * and (slide) the downhill unit direction p1 - p0 (negated when it points up).
 */
export function wireMount(wire: Wire, pelvis: readonly number[], mode: WireUseMode): { position: V3; heading: number; slideDir: V3 } {
  const { y, lo, hi } = wireCoordinate(wire, pelvis);
  const { margin, hang } = WIRE_MODE[mode];
  const fy = Math.fround(y);
  const a = Math.fround(lo + margin);
  const b = Math.fround(hi - margin);
  const t = fy < a ? a : fy > b ? b : fy;
  const axis = col(wire.frame, 1);
  const up = col(wire.frame, 2);
  const h = Math.fround(hang);
  const position: V3 = [
    wire.pose.position[0] + Math.fround(axis[0] * t - up[0] * h),
    wire.pose.position[1] + Math.fround(axis[1] * t - up[1] * h),
    wire.pose.position[2] + Math.fround(axis[2] * t - up[2] * h),
  ];
  let heading = headingOf(wire.frame);
  let slideDir: V3 = [0, 0, 0];
  if (mode === "traverse") {
    if (t > 0) heading = Math.fround(heading + Math.fround(Math.PI));
  } else {
    const p0 = apply(wire.pose.linear as M3, wire.model.magicVertices[0]);
    const p1 = apply(wire.pose.linear as M3, wire.model.magicVertices[1]);
    let d = sub(p1, p0);
    if (d[2] > 0) {
      d = [-d[0], -d[1], -d[2]];
      heading = Math.fround(heading + Math.fround(Math.PI));
    }
    const n = Math.hypot(d[0], d[1], d[2]);
    slideDir = [Math.fround(d[0] / n), Math.fround(d[1] / n), Math.fround(d[2] / n)];
  }
  return { position, heading, slideDir };
}

/** Still inside [lo + margin, hi - margin] (the attached branch of FUN_00411a80 / FUN_00411ec0) [recovered]. */
export function wireInRange(wire: Wire, pelvis: readonly number[], mode: WireUseMode): boolean {
  const { y, lo, hi } = wireCoordinate(wire, pelvis);
  const m = WIRE_MODE[mode].margin;
  const fy = Math.fround(y);
  return !(fy < Math.fround(lo + m) || Math.fround(hi - m) < fy);
}

// --- Door (FUN_00445920) ------------------------------------------------------------

/** Door window in its local frame: -4096 < x < 1843.2 and -4096 < z < 4096 (0x5318b0, 0x5318a8, 0x531498) [recovered]. */
export const DOOR_WINDOW = { min: -4096, maxX: 1843.2, maxZ: 4096 } as const;

export interface DoorTarget extends PlacedModel {
  kind: "door";
  taskId: number;
  nodeIndex: number;
  locked: boolean;
  pickable: boolean;
}

/**
 * FUN_00445920 [recovered]: a locked door that cannot be picked takes no part.
 * p0 = pos + R point0; local = R^T (eye - p0); inside the window both p0 and
 * the eye's projection p0 + R (local.x, 0, local.z) go through FUN_004159d0.
 */
export function doorUseTest<T>(search: UseSearch<T>, door: DoorTarget, self: T): boolean {
  if (door.locked && !door.pickable) return false;
  const p0 = worldPoint(door, 0);
  const d = sub(search.view.eye, p0);
  const r = door.rotation;
  const lx = r[0] * d[0] + r[3] * d[1] + r[6] * d[2];
  const lz = r[2] * d[0] + r[5] * d[1] + r[8] * d[2];
  if (!(DOOR_WINDOW.min < lx && lx < DOOR_WINDOW.maxX && DOOR_WINDOW.min < lz && lz < DOOR_WINDOW.maxZ)) return false;
  let hit = search.consider(p0, self);
  const fx = Math.fround(lx), fz = Math.fround(lz);
  // The exe stores the x sum (including p0.x) to a float32 (chop) before widening it again.
  const q: V3 = [
    x87StoreF32(r[0] * fx + r[2] * fz + x87StoreF32(p0[0])),
    p0[1] + Math.fround(r[3] * fx + r[5] * fz),
    p0[2] + Math.fround(r[6] * fx + r[8] * fz),
  ];
  if (search.consider(q, self)) hit = true;
  return hit;
}

// --- Switch / Terminal (FUN_00444500 / FUN_00442e60) ------------------------------------

/** Lateral limit |local x| < 3072 (f64 0x531890) for switches and terminals [recovered]. */
export const PANEL_HALF_WIDTH = 3072;

export interface PanelTarget extends PlacedModel {
  kind: "switch" | "terminal";
  type: string;
  taskId: number;
  nodeIndex: number;
  /** Switch: not destroyed (+0x1c2 == 0); Terminal: isOn (+0x240). */
  enabled: boolean;
  /** Terminal "Hack Time (s)" (+0x24c). */
  hackSeconds: number;
}

/**
 * FUN_00444500 (point 0) / FUN_00442e60 (point 1) [recovered]: p = pos + R
 * point; d = eye - p in float; in front (R col1 . d > 0) and |R col0 . d| <
 * 3072 -> FUN_004159d0(p).
 */
export function panelUseTest<T>(search: UseSearch<T>, panel: PanelTarget, self: T): boolean {
  if (!panel.enabled) return false;
  const p = worldPoint(panel, panel.kind === "switch" ? 0 : 1);
  const d = sub(search.view.eye, p).map(Math.fround);
  const r = panel.rotation;
  let x = Math.fround(r[0] * d[0] + r[3] * d[1] + r[6] * d[2]);
  const y = Math.fround(r[1] * d[0] + r[4] * d[1] + r[7] * d[2]);
  if (!(0 < y)) return false;
  if (x < 0) x = -x;
  if (!(x < PANEL_HALF_WIDTH)) return false;
  return search.consider(p, self);
}

/** Terminal hacking stance: point 1 + R col1 x 2764.8 (f64 0x531438 used as float), facing it (FUN_0040c780) [recovered]. */
export const TERMINAL_STAND_OFF = 2764.8;

export function terminalStance(panel: PanelTarget): { position: V3; heading: number } {
  const p = worldPoint(panel, 1);
  const y = col(panel.rotation, 1);
  const k = Math.fround(TERMINAL_STAND_OFF);
  return {
    // x goes through a float32 store in the exe ((float)dStack_40 + ...), y and z stay double.
    position: [x87StoreF32(p[0] + Math.fround(y[0] * k)), p[1] + Math.fround(y[1] * k), p[2] + Math.fround(y[2] * k)],
    heading: Math.fround(headingOf(panel.rotation) + Math.fround(Math.PI)),
  };
}

// --- Cabinet / GenericTBA / PlaceExplosiveTBA (full exe; docs/objects.md) -----------

/** A Cabinet (kind 4), GenericTBA (12) or PlaceExplosiveTBA (13) in the use list. */
export interface TimedUseTarget extends PlacedModel {
  kind: "cabinet" | "tba" | "placeExplosive";
  taskId: number;
  nodeIndex: number;
  /** TBA: isOn (the cabinet has no gate). */
  enabled: boolean;
  /** "Search Time (s)" / "Activate Time (s)". */
  seconds: number;
  /** TBA "Activate Anim" clip (looped). */
  anim: number;
  /** HUD icon: action_searchcab.spr for a cabinet, the TBA's resolved sprite. */
  icon: string | null;
  /** PlaceExplosiveTBA "Activate radius (meters)" x 4096 (0x5333b8). */
  range: number;
  /** PlaceExplosiveTBA "Task ID to place" (-1 none). */
  placeTaskId: number;
}

/**
 * Cabinet LAB_00444860 (point 0) and GenericTBA LAB_00443c80 (point 1, only while isOn):
 * the Switch / Terminal test, in front on R col 1 and |R col 0 . d| < 3072 [recovered, full exe].
 * PlaceExplosiveTBA LAB_004389e0 (point 1, while isOn): no front test and no 2 m limit, its own
 * radius, and only when no earlier object won [recovered, full exe].
 */
export function timedUseTest<T>(search: UseSearch<T>, obj: TimedUseTarget, self: T): boolean {
  if (!obj.enabled) return false;
  const p = worldPoint(obj, obj.kind === "cabinet" ? 0 : 1);
  if (obj.kind === "placeExplosive") return search.considerFirst(p, self, obj.range);
  const d = sub(search.view.eye, p).map(Math.fround);
  const r = obj.rotation;
  let x = Math.fround(r[0] * d[0] + r[3] * d[1] + r[6] * d[2]);
  const y = Math.fround(r[1] * d[0] + r[4] * d[1] + r[7] * d[2]);
  if (!(0 < y)) return false;
  if (x < 0) x = -x;
  if (!(x < PANEL_HALF_WIDTH)) return false;
  return search.consider(p, self);
}

/** Cabinet stance offset R (778.24, 2457.6, 0) (f64 0x533428 / 0x533420 as floats; FUN_0040c2f0) [recovered]. */
export const CABINET_STANCE: V3 = [Math.fround(778.24), Math.fround(2457.6), 0];
/** GenericTBA stance offset R (0, 3481.6, 0) (0x533458; FUN_0040cf70) [recovered]. */
export const TBA_STANCE: V3 = [0, Math.fround(3481.6), 0];

/**
 * States 31 / 35 entry stance (FUN_0040c2f0 / FUN_0040cf70): point (0 / 1) + R offset, x through
 * a float store as the terminal's; heading = gamma(R) + pi [recovered, full exe].
 */
export function timedUseStance(obj: TimedUseTarget): { position: V3; heading: number } {
  const p = worldPoint(obj, obj.kind === "cabinet" ? 0 : 1);
  const o = obj.kind === "cabinet" ? CABINET_STANCE : TBA_STANCE;
  const r = obj.rotation;
  const off = [0, 1, 2].map((i) => Math.fround(r[i * 3] * o[0] + r[i * 3 + 1] * o[1])) as V3;
  return {
    position: [x87StoreF32(p[0] + off[0]), p[1] + off[1], p[2] + off[2]],
    heading: Math.fround(headingOf(r) + Math.fround(Math.PI)),
  };
}

/** State 36: the player stands this far back from the hit along the eye ray (0x533460) [recovered]. */
export const PLACE_EXPLOSIVE_BACK_OFF = 2048;

/**
 * State 36 entry (FUN_0040d180) [recovered, full exe]: from the eye toward P = pos + point 1;
 * X = the ray's hit (else the eye) and n = its +0x38 vector (else P - eye) [n = the hit normal:
 * inferred]; gamma = atan2(n.y, n.x) (0 when n.x == 0, FUN_004b2d00) + pi/2. The charge goes to
 * X with Euler(pi/2, 0, gamma); the player to X - unit(P - eye) x 2048, heading gamma.
 */
export function placeExplosiveStance(eye: readonly number[], p: readonly number[], hit: { point: readonly number[]; normal: readonly number[] } | null): {
  position: V3; heading: number; charge: V3;
} {
  const ray: V3 = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
  let n = (hit ? [...hit.normal] : ray).map(Math.fround);
  const x: V3 = hit ? [hit.point[0], hit.point[1], hit.point[2]] : [eye[0], eye[1], eye[2]];
  if (n[0] !== 0 || n[1] !== 0 || n[2] !== 0) {
    const k = Math.fround(1 / Math.fround(Math.sqrt(n[2] * n[2] + n[1] * n[1] + n[0] * n[0])));
    n = n.map((v) => Math.fround(v * k));
  }
  const gamma = Math.fround((n[0] === 0 ? 0 : Math.fround(Math.atan2(n[1], n[0]))) + Math.fround(Math.PI / 2));
  const len = Math.hypot(ray[0], ray[1], ray[2]) || 1;
  const back = ray.map((v) => (v / len) * PLACE_EXPLOSIVE_BACK_OFF);
  return { position: [x[0] - back[0], x[1] - back[1], x[2] - back[2]], heading: gamma, charge: x };
}

// --- Fence (FUN_0043f280; attach FUN_00411710) ---------------------------------------

/** Fence approach angle limit pi/3 (f32 0x531858) [recovered]. */
export const FENCE_MAX_ANGLE = Math.fround(Math.PI / 3);
/** Fence mount: pos + R (x, -/+2457.6, 3891.2) (0x5314e0 / 0x531420, 0x5314d8) [recovered]. */
export const FENCE_HOLD = { side: 2457.6, up: 3891.2 } as const;

export interface FenceTarget extends PlacedModel {
  kind: "fence";
  taskId: number;
  nodeIndex: number;
  /** +0x11c ("Electric Expression"): an electrified fence cannot be used. */
  electric: boolean;
}

/** FUN_0043f280 [recovered]: |local y| < range, p0.x < local x < p1.x, facing it within pi/3 -> claim. */
export function fenceUseTest<T>(search: UseSearch<T>, fence: FenceTarget, self: T): boolean {
  if (fence.electric) return false;
  const d = sub(search.view.eye, fence.position);
  const r = fence.rotation;
  const lx = r[0] * d[0] + r[3] * d[1] + r[6] * d[2];
  const ly = r[1] * d[0] + r[4] * d[1] + r[7] * d[2];
  const p0 = localPoint(fence, 0);
  const p1 = localPoint(fence, 1);
  if (!(Math.abs(ly) < search.range && p0[0] < Math.fround(lx) && Math.fround(lx) < p1[0])) return false;
  let axis = col(r, 1);
  if (ly > 0) axis = [-axis[0], -axis[1], -axis[2]];
  if (!(vectorAngle(col(search.view.axes, 1), axis) < FENCE_MAX_ANGLE)) return false;
  search.claim(self);
  return true;
}

/** Fence mount position / heading from the pelvis (FUN_00411710) [recovered]. */
export function fenceMount(fence: FenceTarget, pelvis: readonly number[]): { position: V3; heading: number } {
  const d = sub(pelvis, fence.position);
  const r = fence.rotation;
  const lx = r[0] * d[0] + r[3] * d[1] + r[6] * d[2];
  const ly = r[1] * d[0] + r[4] * d[1] + r[7] * d[2];
  const front = ly >= 0;
  const side = front ? FENCE_HOLD.side : -FENCE_HOLD.side;
  const local = [lx, side, FENCE_HOLD.up];
  const o = apply(r, local);
  return {
    position: [fence.position[0] + o[0], fence.position[1] + o[1], fence.position[2] + o[2]],
    heading: Math.fround(headingOf(r) + (front ? Math.fround(Math.PI) : 0)),
  };
}

// --- StationaryGun (FUN_00473ed0 type; test FUN_00474e30, full exe) ----------------------

/**
 * A StationaryGun as a use target: the use point P = origin + object matrix x
 * magic vertex 0 (FUN_00414e20(self, 0)) and the object matrix (+0x70 = base x
 * Rz(total yaw)); only free guns are listed (+0x21c clear).
 */
export interface StationaryGunTarget {
  kind: "stationaryGun";
  taskId: number;
  nodeIndex: number;
  point: V3;
  rotation: M3;
}

/** FUN_00474e30 [recovered]: from behind ((eye - P) . col1 >= 0), then the common point test on P. */
export function stationaryGunUseTest<T>(search: UseSearch<T>, gun: StationaryGunTarget, self: T): boolean {
  const c1 = col(gun.rotation, 1);
  if (!(dot(sub(search.view.eye, gun.point), c1) >= 0)) return false;
  return search.consider(gun.point, self);
}

// --- the use list ---------------------------------------------------------------------

export type UseObject = Ladder | Wire | DoorTarget | PanelTarget | FenceTarget | TimedUseTarget | StationaryGunTarget;

export interface UseResult {
  target: UseObject | null;
  /** Ladder mount side chosen during this search (human+0xd7b). */
  ladderSide: "bottom" | "top";
}

/**
 * One search over the use list (FUN_0045fb20) [recovered]. `ladderSide`
 * mirrors the human-wide flag +0xd7b, which every ladder test may set.
 */
export function searchUseTarget(view: UseView, objects: readonly UseObject[], previousLadderSide: "bottom" | "top" = "bottom"): UseResult {
  const search = new UseSearch<UseObject>(view);
  let ladderSide = previousLadderSide;
  for (const obj of objects) {
    switch (obj.kind) {
      case "ladder": {
        const side = ladderUseTest(search, obj, obj);
        if (side) ladderSide = side;
        break;
      }
      case "wire":
        wireUseTest(search, obj, obj);
        break;
      case "door":
        doorUseTest(search, obj, obj);
        break;
      case "switch":
      case "terminal":
        panelUseTest(search, obj, obj);
        break;
      case "fence":
        fenceUseTest(search, obj, obj);
        break;
      case "cabinet":
      case "tba":
      case "placeExplosive":
        timedUseTest(search, obj, obj);
        break;
      case "stationaryGun":
        stationaryGunUseTest(search, obj, obj);
        break;
    }
  }
  return { target: search.winner, ladderSide };
}

/** Use kind of a target (method 0x42b) [recovered]. */
export function useKindOf(obj: UseObject): UseKind {
  switch (obj.kind) {
    case "ladder":
      return USE_KIND.LADDER;
    case "wire":
      return USE_KIND.WIRE;
    case "door":
      return USE_KIND.DOOR;
    case "switch":
      return USE_KIND.SWITCH;
    case "terminal":
      return USE_KIND.TERMINAL;
    case "fence":
      return USE_KIND.FENCE;
    case "cabinet":
      return USE_KIND.CABINET;
    case "tba":
      return USE_KIND.GENERIC_TBA;
    case "placeExplosive":
      return USE_KIND.PLACE_EXPLOSIVE_TBA;
    case "stationaryGun":
      return USE_KIND.STATIONARY_GUN;
  }
}

/** HUD action icon of a target (method 0x42e; docs/hud.md) [recovered]. */
export function useIconOf(obj: UseObject): string | null {
  switch (obj.kind) {
    case "ladder":
      return USE_ICON.ladder;
    case "wire":
      return USE_ICON.wire;
    case "door":
      return obj.locked ? USE_ICON.doorLocked : USE_ICON.door;
    case "switch":
      return USE_ICON.switch;
    case "terminal":
      return USE_ICON.terminal;
    case "fence":
      return USE_ICON.fence;
    case "cabinet":
    case "tba":
    case "placeExplosive":
      return obj.icon;
    case "stationaryGun":
      return USE_ICON.stationaryGun;
  }
}
