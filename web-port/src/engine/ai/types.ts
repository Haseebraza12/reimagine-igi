/**
 * Shared types of the soldier-AI port (docs/ai.md, docs/qvm-vm.md).
 *
 * Coordinates: the AI runs in IGI world units (4096 per metre, z up) like
 * igi.exe; the engine adapter (combat/enemy.ts) converts to engine space.
 * Object keys: 0 = the player, soldiers use their Enemy.id (>= 1).
 */
export type V3 = [number, number, number];
export type RV3 = readonly [number, number, number];

export const PLAYER_KEY = 0;
export const UNITS = 4096;

/** AIEVENT_* values (FUN_0044dd00) [recovered]. */
export const EV = {
  CREATE: 0, DELETE: 1, DEAD: 2, ANIMATION: 3, IDLE: 4, ALERT: 5, ALERT_RESPONSE: 6, COMBAT: 7,
  ALARMON: 8, ALARMOFF: 9, WALK: 10, GROUNDIMPACT: 11, DOOR: 12, FENCE: 13, LADDER: 14,
  TAKINGDAMAGE: 15, GUNSHOT: 16, GRENADETHROWN: 17, GRENADELAND: 18, FLASHBANG: 19,
  GUNSHOTMISS: 20, EXPLOSION: 21, ENEMYDETECTION: 22, FRIENDLYDETECTION: 23,
} as const;
export const EVENT_TYPES = 24;

/** One event record {type, team, flags, range, position, source, other} (FUN_0044fab0 / FUN_0044fb20) [recovered]. */
export interface AiEvent {
  type: number;
  team: number;
  flags: number;
  /** IGI units; -1 = none. */
  range: number;
  position: V3;
  source: number | null;
  other: number | null;
}

/** A human the AI can perceive: the player or a soldier. */
export interface AiHuman {
  readonly key: number;
  readonly team: number;
  readonly isPlayer: boolean;
  dead(): boolean;
  /** Feet position, IGI units. */
  feet(): V3;
  /** The exe's human position: the animated root (pelvis) = feet + root z, IGI units. */
  origin(): V3;
  /** Crouched / kneeling (lowers the vision target point and the aim point). */
  crouched(): boolean;
  /** In the world (task runtime inWorld); absent humans are neither perceived nor updated. */
  present(): boolean;
}

export const add = (a: RV3, b: RV3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: RV3, b: RV3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dist = (a: RV3, b: RV3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const dist2d = (a: RV3, b: RV3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const copy = (a: RV3): V3 => [a[0], a[1], a[2]];

/** Body forward / right for IGI heading gamma: models face +y, so forward = (-sin g, cos g), right = (cos g, sin g) (coords.ts). */
export function headingForward(gamma: number): V3 {
  return [-Math.sin(gamma), Math.cos(gamma), 0];
}
export function headingRight(gamma: number): V3 {
  return [Math.cos(gamma), Math.sin(gamma), 0];
}

/** Angle to turn RIGHT (clockwise from above) to face `to` from `from` with heading gamma; in (-pi, pi]. */
export function yawErrorRight(from: RV3, gamma: number, to: RV3): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const f = headingForward(gamma);
  const r = headingRight(gamma);
  const x = dx * r[0] + dy * r[1];
  const y = dx * f[0] + dy * f[1];
  if (x === 0 && y === 0) return 0;
  return Math.atan2(x, y);
}

/** Elevation angle of `to` seen from `from` (radians, up positive). */
export function elevation(from: RV3, to: RV3): number {
  const h = Math.hypot(to[0] - from[0], to[1] - from[1]);
  return Math.atan2(to[2] - from[2], h);
}
