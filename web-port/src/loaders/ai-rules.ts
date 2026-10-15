/**
 * Recovered soldier-AI rules of igi.exe as typed constants and pure
 * functions an engine can call. Nothing here touches the scene: callers pass
 * positions (IGI units, z up), random numbers and ray results in.
 *
 * Evidence labels follow docs/ai.md: [recovered] = read from igi.exe code
 * (function addresses cited), [observed] = measured on shipped files,
 * [inferred] = reasoning only. Every numeric constant marked [recovered] is
 * re-read from igi.exe by `python tools/igi_ai.py`.
 *
 * Units: positions and distances in IGI units (4096 per metre), angles in
 * radians, time in ticks (30 per second).
 */

import { x87Add, x87Fistp, x87Mul, x87StoreF32 } from "./x87";

export const AI_TICKS_PER_SECOND = 30; // GAME_FREQUENCY [recovered FUN_004148b0]
export const AI_UNITS_PER_METRE = 4096; // WORLD_METER [recovered FUN_004148b0]

/**
 * x87 fistp as igi.exe runs it [recovered: every float->int in the AI]: the
 * FPU is in chop mode (FUN_004966d0; docs/gameplay.md "FPU rounding mode"),
 * so this TRUNCATES toward zero (9.6 -> 9, 2.5 -> 2, -1.75 -> -1). The name
 * is kept for the engine; it is x87Fistp (x87.ts).
 */
export function x87Round(x: number): number {
  return x87Fistp(x);
}

export type Vec3 = readonly [number, number, number];

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** AIEVENT_* values [recovered FUN_0044dd00]. */
export const AIEVENT = Object.freeze({
  CREATE: 0, DELETE: 1, DEAD: 2, ANIMATION: 3, IDLE: 4, ALERT: 5, ALERT_RESPONSE: 6, COMBAT: 7,
  ALARMON: 8, ALARMOFF: 9, WALK: 10, GROUNDIMPACT: 11, DOOR: 12, FENCE: 13, LADDER: 14,
  TAKINGDAMAGE: 15, GUNSHOT: 16, GRENADETHROWN: 17, GRENADELAND: 18, FLASHBANG: 19,
  GUNSHOTMISS: 20, EXPLOSION: 21, ENEMYDETECTION: 22, FRIENDLYDETECTION: 23,
} as const);

/**
 * Receive-filter bits of an event record (FUN_0044eee0) [recovered]. They
 * are tested in this order and the first failure drops the event:
 *  RANGE       |eventPos - listener.pos| <= range
 *  VIEW_CONE   eventPos inside the listener's view cones (aiInViewCone with
 *              requireFront, alarm length when the alarm flag is set); no
 *              occlusion test
 *  OTHER_HUMAN the record's "other" object (target/shooter) is a human
 *  OTHER_ALIVE / OTHER_DEAD  that object is alive / dead
 *  SAME_TEAM / OTHER_TEAM    record team vs listener team
 */
export const AI_EVENT_FILTER = Object.freeze({
  VIEW_CONE: 0x1, RANGE: 0x2, OTHER_HUMAN: 0x4, OTHER_ALIVE: 0x8, OTHER_DEAD: 0x10,
  SAME_TEAM: 0x20, OTHER_TEAM: 0x40,
} as const);

export interface AiEventProducer {
  type: number;
  flags: number;
  /** IGI units; -1 = none; string = taken from data at run time. */
  range: number | "weapon" | "material";
  position: string;
  producer: string;
  note: string;
}

/**
 * Every event source found in igi.exe [recovered; addresses in docs/ai.md 2.3].
 * 0x46 = RANGE | OTHER_HUMAN | OTHER_TEAM: heard only by soldiers of
 * another team than the noise maker, through walls (no occlusion test).
 */
export const AI_EVENT_PRODUCERS: readonly AiEventProducer[] = Object.freeze([
  { type: 10, flags: 0x46, range: "material", position: "walker step position (+0x6a8)", producer: "FUN_00462560",
    note: "each footstep sound; not while crouched; range = ground material DefineGameMaterial arg 5 (m) x 4096 (Ground/Concrete 1 m, Gravel 10 m, 0 on several)" },
  { type: 11, flags: 0x46, range: 20480, position: "lander position", producer: "FUN_00408570",
    note: "landing; 40960 (10 m) when the landing hurt" },
  { type: 12, flags: 0x46, range: 20480, position: "human position", producer: "FUN_0040c370", note: "door use" },
  { type: 13, flags: 0x46, range: 20480, position: "human position", producer: "FUN_00411710", note: "fence climb" },
  { type: 14, flags: 0x46, range: 20480, position: "human position", producer: "FUN_0040d8b0/0040daf3/0040dc53", note: "ladder" },
  { type: 15, flags: 0x00, range: -1, position: "damage origin (local vector)", producer: "0x4543b1 and 6 other human damage handlers",
    note: "sent only to the damaged soldier (FUN_0044fb20), other = attacker" },
  { type: 16, flags: 0x46, range: "weapon", position: "gun +0x150", producer: "FUN_00477ea0",
    note: "every shot; range = WeaponConfig 'AI Detection Event Range' (30 m, MP5SD/Dragunov/grenades/knife 1 m); other = shooter" },
  { type: 17, flags: 0x01, range: -1, position: "grenade", producer: "FUN_00475760", note: "grenade thrown: view-cone test only" },
  { type: 18, flags: 0x02, range: 20480, position: "grenade", producer: "FUN_004753f0", note: "grenade landing: range only, any team" },
  { type: 19, flags: 0x03, range: 40960, position: "flashbang", producer: "0x47cc92", note: "flashbang: range + view cone" },
  { type: 20, flags: 0x46, range: 8192, position: "points along the bullet path", producer: "0x45f443",
    note: "bullet passing / hitting near a soldier of another team than the shooter" },
  { type: 21, flags: 0x02, range: 102400, position: "explosion", producer: "projectile spawns (0x427b24 ...)",
    note: "25 m typical; 10 m (0x475314) and 5 m (0x439861) variants" },
  { type: 5, flags: 0x26, range: 28672, position: "alerting soldier", producer: "FUN_00488f30",
    note: "ALERT from a soldier in combat every 20 ticks; other = its target; same team, 7 m" },
  { type: 6, flags: 0x24, range: -1, position: "-", producer: "AIFunction_SendResponse FUN_0044dc90", note: "reply to an ALERT" },
  { type: 7, flags: 0x00, range: -1, position: "event position", producer: "SetCombat action FUN_0048c980", note: "to self" },
  { type: 22, flags: 0x00, range: -1, position: "seen object", producer: "FUN_0044e260", note: "each frame while an enemy is visible" },
  { type: 23, flags: 0x00, range: -1, position: "seen object", producer: "FUN_0044e260", note: "each frame while a dead friend is visible" },
  { type: 8, flags: 0x00, range: -1, position: "-", producer: "FUN_0044e260", note: "each frame while the AlarmControl (+0x2a1) is on" },
  { type: 9, flags: 0x00, range: -1, position: "-", producer: "FUN_0044e260", note: "each frame while AlarmControl +0x2a2 is set" },
] as AiEventProducer[]);

export interface AiEventRecord {
  type: number;
  team: number;
  flags: number;
  range: number;
  position: Vec3;
  /** Object ids; the listener never receives its own events. */
  source: number | null;
  other: number | null;
}

export interface AiListener {
  self: number;
  team: number;
  position: Vec3;
  dead: boolean;
  /** CREATE already ran (before that only type 0 is accepted). */
  created: boolean;
  /** Event types present in the soldier's priority list. */
  registered: ReadonlySet<number>;
}

/** FUN_0044eee0 [recovered]. `otherInfo` describes record.other. */
export function aiEventAccepted(
  listener: AiListener,
  ev: AiEventRecord,
  inViewCone: (position: Vec3) => boolean,
  otherInfo: { isHuman: boolean; dead: boolean } | null,
): boolean {
  if (listener.dead) return false;
  if (ev.source === listener.self || ev.other === listener.self) return false;
  if (!listener.created ? ev.type !== 0 : !listener.registered.has(ev.type)) return false;
  const f = ev.flags;
  if (f === 0) return true;
  if (f & AI_EVENT_FILTER.RANGE) {
    const d = Math.hypot(ev.position[0] - listener.position[0], ev.position[1] - listener.position[1],
      ev.position[2] - listener.position[2]);
    if (Math.fround(ev.range) < d) return false;
  }
  if (f & AI_EVENT_FILTER.VIEW_CONE && !inViewCone(ev.position)) return false;
  if (f & AI_EVENT_FILTER.OTHER_HUMAN && !(otherInfo && otherInfo.isHuman)) return false;
  if (f & AI_EVENT_FILTER.OTHER_ALIVE && otherInfo && otherInfo.dead) return false;
  if (f & AI_EVENT_FILTER.OTHER_DEAD && !(otherInfo && otherInfo.dead)) return false;
  if (f & AI_EVENT_FILTER.SAME_TEAM && ev.team !== listener.team) return false;
  if (f & AI_EVENT_FILTER.OTHER_TEAM && ev.team === listener.team) return false;
  return true;
}

/** ALERT broadcast while a soldier holds a combat target [recovered FUN_00488d40 / FUN_00488f30]. */
export const AI_ALERT = Object.freeze({ periodTicks: 20, radius: 28672, flags: 0x26 });

/** Gunshot hearing ranges [recovered FUN_0044dd00 constants, used by WeaponConfig]. */
export const AI_GUNSHOT_RANGE = 0x1e000;
export const AI_GUNSHOT_SILENCED_RANGE = 0x1000;

// ---------------------------------------------------------------------------
// Vision
// ---------------------------------------------------------------------------

/** One view cone: half-angles in radians, lengths in units. */
export interface AiViewCone {
  /** Vertical half-angle (SetViewAlpha). */
  alpha: number;
  /** Horizontal half-angle (SetViewGamma). */
  gamma: number;
  length: number;
  alarmLength: number;
}

export interface AiView {
  primary: AiViewCone;
  secondary: AiViewCone;
}

const DEG = Math.PI / 180;

/**
 * HumanAI defaults (FUN_0044deb0) [recovered]. No shipped script sets the
 * secondary cone, so every soldier keeps the 80 deg / 10 m peripheral cone.
 */
export function aiDefaultView(): AiView {
  return {
    primary: { alpha: 45 * DEG, gamma: 50 * DEG, length: 30 * 4096, alarmLength: 30 * 4096 },
    secondary: { alpha: 45 * DEG, gamma: 80 * DEG, length: 10 * 4096, alarmLength: 10 * 4096 },
  };
}

/** Apply an AIFunction_Set*View* call (FUN_0044ca80 ... FUN_0044cd80) [recovered]. */
export function aiApplyViewCall(view: AiView, fn: string, value: number): void {
  const p = view.primary;
  const s = view.secondary;
  switch (fn) {
    case "AIFunction_SetViewLength":
      p.length = value * 4096;
      if (p.alarmLength < p.length) p.alarmLength = p.length;
      break;
    case "AIFunction_SetAlarmViewLength": p.alarmLength = value * 4096; break;
    case "AIFunction_SetViewAlpha": p.alpha = value * 0.0174533; break;
    case "AIFunction_SetViewGamma": p.gamma = value * 0.0174533; break;
    case "AIFunction_SetSecondaryViewLength":
      s.length = value * 4096;
      if (s.alarmLength < s.length) s.alarmLength = s.length;
      break;
    case "AIFunction_SetSecondaryAlarmViewLength": s.alarmLength = value * 4096; break;
    case "AIFunction_SetSecondaryViewAlpha": s.alpha = value * 0.0174533; break;
    case "AIFunction_SetSecondaryViewGamma": s.gamma = value * 0.0174533; break;
    default: throw new Error(`aiApplyViewCall: not a view function: ${fn}`);
  }
}

/** Eye frame: right, forward, up unit vectors (columns of the head matrix). */
export interface AiEyeFrame {
  position: Vec3;
  right: Vec3;
  forward: Vec3;
  up: Vec3;
}

/**
 * Local angles of `point` seen from the eye (FUN_004868f0 / FUN_00486950)
 * [recovered]: vertical = |angle in the forward/up plane|, horizontal =
 * |angle in the right/forward plane|, both from +forward, in [0, pi].
 */
export function aiViewAngles(eye: AiEyeFrame, point: Vec3): { distance: number; vertical: number; horizontal: number; front: number } {
  const dx = point[0] - eye.position[0];
  const dy = point[1] - eye.position[1];
  const dz = point[2] - eye.position[2];
  const x = dx * eye.right[0] + dy * eye.right[1] + dz * eye.right[2];
  const y = dx * eye.forward[0] + dy * eye.forward[1] + dz * eye.forward[2];
  const z = dx * eye.up[0] + dy * eye.up[1] + dz * eye.up[2];
  const angle = (u: number, v: number) => {
    const n = Math.hypot(u, v);
    return n === 0 ? 0 : Math.acos(Math.max(-1, Math.min(1, v / n)));
  };
  return { distance: Math.hypot(dx, dy, dz), vertical: angle(z, y), horizontal: angle(x, y), front: y };
}

/**
 * View-cone test. Vision (FUN_00487d80): distance <= length and
 * vertical < alpha and horizontal < gamma, for the primary cone, else the
 * secondary cone. Event cones (FUN_0044f0c0) also require the point in
 * front (requireFront). `alarm` selects the alarm lengths: vision uses them
 * on the frame after ALARMON was queued or while tracking a target
 * (H+0x3ab7); event cones use the same flag. [recovered]
 */
export function aiInViewCone(eye: AiEyeFrame, point: Vec3, view: AiView, alarm: boolean, requireFront = false): boolean {
  const a = aiViewAngles(eye, point);
  if (requireFront && a.front < 0) return false;
  for (const cone of [view.primary, view.secondary]) {
    const length = alarm ? cone.alarmLength : cone.length;
    if (a.distance <= length && Math.fround(a.vertical) < Math.fround(cone.alpha) && Math.fround(a.horizontal) < Math.fround(cone.gamma)) {
      return true;
    }
  }
  return false;
}

/** A sight ray passes when nothing is hit or the first hit is at >= 79 % of the way [recovered FUN_00487f40]. */
export const AI_LOS_MIN_HIT_FRACTION = Math.fround(0.79);
export function aiLineOfSightClear(firstHitFraction: number | null): boolean {
  return firstHitFraction === null || firstHitFraction >= AI_LOS_MIN_HIT_FRACTION;
}

/** Point a soldier looks at on a human: origin + z (FUN_00464490) [recovered]. */
export const AI_VISION_TARGET_HEIGHT = Object.freeze({ standing: 2826.24, crouched: 1433.6 });
/** Point a soldier aims at: last known origin + z (FUN_00450150) [recovered]. */
export const AI_AIM_HEIGHT = Object.freeze({ standing: 2048, crouched: 1024 });

/**
 * Perception schedule (FUN_00487b70 / FUN_00487cf0, set up by FUN_00487ae0
 * with 4 and 8) [recovered]: a soldier's perception runs on ticks where
 * (tick & 3) == its phase (phases handed out round-robin 0..3 at creation);
 * per tracked object the cone test runs every 2nd run (8 ticks) and, while
 * the object is in the cone, the line-of-sight ray every 3rd run (12
 * ticks). Out of the cone clears "visible" at once. Tracked objects: alive
 * enemies (ENEMYDETECTION) and dead friends (FRIENDLYDETECTION).
 */
export const AI_PERCEPTION = Object.freeze({ periodTicks: 4, coneEveryRuns: 2, losEveryRuns: 3 });

export interface AiPerceptionSlot {
  coneCountdown: number;
  losCountdown: number;
  inCone: boolean;
  visible: boolean;
}

export function aiNewPerceptionSlot(): AiPerceptionSlot {
  return { coneCountdown: 0, losCountdown: 0, inCone: false, visible: false };
}

/** One perception run for one tracked object (FUN_00487cf0) [recovered]. */
export function aiPerceptionStep(slot: AiPerceptionSlot, coneTest: () => boolean, losTest: () => boolean): void {
  if (slot.coneCountdown === 0) {
    slot.inCone = coneTest();
    if (!slot.inCone) slot.visible = false;
    slot.coneCountdown = AI_PERCEPTION.coneEveryRuns;
  }
  if (slot.inCone) {
    if (slot.losCountdown === 0) {
      slot.visible = losTest();
      slot.losCountdown = AI_PERCEPTION.losEveryRuns;
    }
    slot.losCountdown--;
  }
  slot.coneCountdown--;
}

// ---------------------------------------------------------------------------
// Combat configuration (HumanAIConfigItem -> HumanAI, FUN_00407080)
// ---------------------------------------------------------------------------

export interface AiCombatConfig {
  damageScale: number;
  targetingTimeoutTicks: number;
  trackingDistance: number;
  liedownMinDistance: number;
  evasiveProbability: number;
  evasiveRollOrLiedownProbability: number;
  evasiveRollSideProbability: number;
  hitProbabilityMinRange: number;
  hitProbabilityMaxRange: number;
  maxRoundsPerSequence: number;
  aimPrecision: number;
  minClipFraction: number;
  randomClipFraction: number;
  minShotDelaySeconds: number;
  randomShotDelaySeconds: number;
  grenadeProbabilityClipEmpty: number;
  grenadeProbabilityClipLoaded: number;
  grenadeMinDistance: number;
  grenadeMaxDistance: number;
  /** Copied by igi.exe but never read (no effect) [recovered by reference count]. */
  unused: Readonly<Record<string, number>>;
}

/** Configuration fields of one HumanAIConfigItem (settings.qvm) -> engine units [recovered FUN_00407080]. */
export function aiCombatConfig(params: Readonly<Record<string, unknown>>): AiCombatConfig {
  const num = (name: string): number => {
    const v = params[name];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`aiCombatConfig: missing number "${name}"`);
    return v;
  };
  const f = (name: string) => Math.fround(num(name));
  return {
    damageScale: f("Damage scale"),
    // FUN_00407080 0x407100..0x40714c: float32 x 30.0f, fistp (truncated).
    targetingTimeoutTicks: x87Fistp(f("Combat targeting timeout (in seconds)") * 30),
    trackingDistance: f("Combat tracking distance (in meters)") * 4096,
    liedownMinDistance: f("Combat liedown mim distance (in meters)") * 4096,
    evasiveProbability: f("Combat evasive action probability"),
    evasiveRollOrLiedownProbability: f("Combat evasive stand roll / liedown probability"),
    evasiveRollSideProbability: f("Combat evasive stand roll side probability"),
    hitProbabilityMinRange: f("Combat firing hit probability at minimum range"),
    hitProbabilityMaxRange: f("Combat firing hit probability at maximum range"),
    maxRoundsPerSequence: num("Combat Firing Max Number Of Rounds per sequence") | 0,
    aimPrecision: f("Combat firing Aim precision"),
    minClipFraction: f("Combat firing minimum clip percentage"),
    randomClipFraction: f("Combat firing random clip percentage"),
    minShotDelaySeconds: f("Combat firing minimum shot delay (in seconds)"),
    randomShotDelaySeconds: f("Combat firing random shot delay (in seconds)"),
    grenadeProbabilityClipEmpty: f("Combat grenade throw probability"),
    grenadeProbabilityClipLoaded: f("Combat grenade throw when reload probability"),
    grenadeMinDistance: Math.fround(f("Combat grenade minimum distance (in meters)") * 4096),
    grenadeMaxDistance: Math.fround(f("Combat grenade maximum distance (in meters)") * 4096),
    unused: Object.freeze({
      initialMovementDelayTicks: x87Fistp(f("Combat initial movement delay (in seconds)") * 30),
      movementDelayTicks: x87Fistp(f("Combat movement delay (in seconds)") * 30),
      kneelRollOrLiedownProbability: f("Combat evasive kneel roll / liedown probability"),
      kneelRollSideProbability: f("Combat evasive kneel roll side probability"),
      firingMinDelaySeconds: f("Combat firing minimum delay (in seconds)"),
      firingRandomDelaySeconds: f("Combat firing random delay (in seconds)"),
    }),
  };
}

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------

/**
 * Hit probability of a fire sequence (FUN_00489de0) [recovered]: d is the
 * distance from the soldier to its aim point, "maximum range" is the
 * soldier's current (non-alarm) view length H+0xb0. The first sequence of
 * each Combat action uses half (AIAction_Combat sets the flag, x 0.5).
 */
export function aiHitProbability(distance: number, viewLength: number, cfg: AiCombatConfig, firstSequence: boolean): number {
  let p: number;
  if (distance < 0) {
    p = cfg.hitProbabilityMinRange;
  } else {
    const d = Math.min(distance, viewLength);
    p = d < 0.01 ? cfg.hitProbabilityMinRange
      : Math.fround((d / viewLength) * (cfg.hitProbabilityMaxRange - cfg.hitProbabilityMinRange) + cfg.hitProbabilityMinRange);
  }
  return firstSequence ? Math.fround(p * 0.5) : p;
}

/**
 * Rounds in a fire sequence (FUN_00489de0) [recovered]. clipSize = WeaponConfig
 * Rounds/Clip (gun +0x648), maxBurst = Maximum Rounds/Burst (+0x64c), r = RNG
 * float drawn at sequence start. Grenade-type weapons (WEAPONTYPE 4) fire 1.
 */
export function aiRoundsPerSequence(cfg: AiCombatConfig, clipSize: number, maxBurst: number, r: number, grenade = false): number {
  if (grenade) return 1;
  let n: number;
  if (maxBurst === clipSize || maxBurst < 2) {
    // 0x489e08: fstp DWORD (chop) of r x random + min; 0x489ec0: fild clip; fmul; fistp (exact product, truncated).
    n = x87Fistp(clipSize * x87StoreF32(x87Add(x87Mul(r, cfg.randomClipFraction), cfg.minClipFraction)));
    if (n < 1) n = 1;
    else if (cfg.maxRoundsPerSequence < n) n = cfg.maxRoundsPerSequence;
  } else {
    n = maxBurst;
  }
  return n === 0 ? 1 : n;
}

/** Ticks between shots of a single-shot weapon (maxBurst == 1), else 0 (FUN_0048bd00, 0x48bea1..0x48beb6: truncated) [recovered]. */
export function aiShotDelayTicks(cfg: AiCombatConfig, maxBurst: number, r: number): number {
  if (maxBurst !== 1) return 0;
  return x87Fistp(x87Mul(x87Add(x87Mul(r, cfg.randomShotDelaySeconds), cfg.minShotDelaySeconds), 30));
}

/** Aim point update per firing tick: aim += (target - aim) * precision (FUN_0048bd00) [recovered]. */
export function aiAimStep(aim: Vec3, target: Vec3, precision: number): [number, number, number] {
  return [aim[0] + (target[0] - aim[0]) * precision, aim[1] + (target[1] - aim[1]) * precision, aim[2] + (target[2] - aim[2]) * precision];
}

/** Trigger is pulled only when facing the aim point within 2 deg (0x3d0efa35) [recovered FUN_0048bd00]. */
export const AI_AIM_TOLERANCE = Math.fround(0.0349066);

/**
 * Whether an AI bullet may collide with the PLAYER (Human ray filter
 * FUN_0045d100) [recovered]: per bullet, rand() <= hit probability. A miss
 * passes through the player; the gun's own spread still applies. AI bullets
 * never collide with humans of the shooter's team; other humans always.
 */
export function aiBulletMayHitPlayer(r: number, hitProbability: number): boolean {
  return r <= hitProbability;
}

/** Simultaneous shooters per target (status 0 in the shared target record) [recovered]. */
export const AI_MAX_SHOOTERS = Object.freeze({ patrolAndFemale: 3, guardGunnerFollow: 4 });

/** Close-combat trigger distance H+0x3da8 (1.5 m); 0 for ANYA/EKK [recovered FUN_0044deb0 / FUN_00489080]. */
export const AI_CLOSE_COMBAT_DISTANCE = 6144;

/** Firing while running (Follow): only when cos(angle to target) > 0.96 [recovered FUN_0048ac80]. */
export const AI_FIRE_WHILE_RUNNING_COS = 0.96;

// ---------------------------------------------------------------------------
// Evasive action and combat decisions
// ---------------------------------------------------------------------------

export interface AiEvasiveInput {
  /** Three RNG floats in draw order (r0 always drawn). */
  rand: () => number;
  now: number;
  /** H+0x3df0, -1 initially; updated in place. */
  state: { nextAllowed: number; lastRollDir: number };
  /** GUNSHOTMISS, GUNSHOT or TAKINGDAMAGE events dispatched this frame. */
  threatenedThisFrame: boolean;
  onStairNode: boolean;
  distance: number;
  /** bit0: point 3 m to the left inside the current node square, bit1: 3 m right (FUN_004514f0). */
  freeSides: number;
  cfg: AiCombatConfig;
}

/** FUN_0048a250 [recovered]: -1 none, 0 lie down, 1 roll left, 2 roll right. */
export function aiEvasiveChoice(input: AiEvasiveInput): -1 | 0 | 1 | 2 {
  const r0 = input.rand();
  const st = input.state;
  if (st.nextAllowed >= 0 && input.now <= st.nextAllowed) return -1;
  st.nextAllowed = input.now + 10;
  if (!input.threatenedThisFrame || input.onStairNode) return -1;
  const c = input.cfg;
  if (input.rand() > c.evasiveProbability) return -1;
  if (c.evasiveRollOrLiedownProbability === 0 || (c.evasiveRollOrLiedownProbability < r0 && c.liedownMinDistance < input.distance)) {
    return 0;
  }
  const r2 = input.rand();
  const left = (input.freeSides & 1) !== 0 && st.lastRollDir !== 1;
  const right = (input.freeSides & 2) !== 0 && st.lastRollDir !== -1;
  if (left && (c.evasiveRollSideProbability === 0 || c.evasiveRollSideProbability < r2)) return 1;
  if (right && (c.evasiveRollSideProbability === 1 || r2 <= c.evasiveRollSideProbability)) return 2;
  return -1;
}

/** Decision codes of the patrol / female combat states. */
export const AI_COMBAT_DECISION = Object.freeze({
  RELOAD: 0, GRENADE: 1, FIRE: 2, CLOSE: 3, REPOSITION: 4, MOVE: 5, LOOK: 6, GIVE_UP: 7,
} as const);

export interface AiCombatDecisionInput {
  cfg: AiCombatConfig;
  rand: () => number;
  /** H+0x3de0 (-1 none); updated when MOVE is chosen. */
  memory: { destinationNode: number; notVisibleCount: number };
  currentNode: number;
  /** Soldier stands on its current node square (0.3 m margin). */
  onCurrentNode: boolean;
  targetVisible: boolean;
  /** Distance to the target's last known position. */
  distance: number;
  clipLoaded: boolean;
  hasGrenade: boolean;
  /** Other soldiers currently firing at this target. */
  shooters: number;
  /** H+0x3da8. */
  closeCombatDistance: number;
  /** FUN_00489470: node near the target, onRoute = must lie on my shortest route; null = none. */
  findNode: (onRoute: boolean) => number | null;
  /** FUN_004892b0 (ANYA / EKK) instead of FUN_0048a3f0. */
  female?: boolean;
}

/** FUN_0048a3f0 (patrol types) / FUN_004892b0 (ANYA, EKK) [recovered]. Returns code and my shooter status. */
export function aiCombatDecision(i: AiCombatDecisionInput): { code: number; status: number } {
  const D = AI_COMBAT_DECISION;
  const m = i.memory;
  const counter = m.notVisibleCount;
  m.notVisibleCount = 0;
  if (m.destinationNode === -1 && !i.onCurrentNode) return { code: D.REPOSITION, status: -1 };
  if (!i.targetVisible) {
    const c = counter + 1;
    m.notVisibleCount = c;
    if (c % 30 > 15) {
      const n = i.findNode(false);
      if (n !== null && n !== i.currentNode) {
        m.destinationNode = n;
        m.notVisibleCount = 0;
        return { code: D.MOVE, status: -1 };
      }
    }
    return { code: i.cfg.targetingTimeoutTicks < c ? D.GIVE_UP : D.LOOK, status: -1 };
  }
  const grenadeRange = i.hasGrenade && i.cfg.grenadeMinDistance < i.distance && i.distance < i.cfg.grenadeMaxDistance;
  if (!i.female && i.distance < i.closeCombatDistance) return { code: D.CLOSE, status: -1 };
  if (!i.clipLoaded) {
    if (!i.female && grenadeRange && i.rand() <= i.cfg.grenadeProbabilityClipEmpty) return { code: D.GRENADE, status: -1 };
    return { code: D.RELOAD, status: 1 };
  }
  if (i.cfg.trackingDistance < i.distance) {
    const n = i.findNode(true);
    if (n !== null && n !== i.currentNode) {
      m.destinationNode = n;
      return { code: D.MOVE, status: -1 };
    }
  }
  if (!i.female && grenadeRange && i.rand() <= i.cfg.grenadeProbabilityClipLoaded) return { code: D.GRENADE, status: -1 };
  return i.shooters < AI_MAX_SHOOTERS.patrolAndFemale ? { code: D.FIRE, status: 0 } : { code: D.LOOK, status: 2 };
}

// ---------------------------------------------------------------------------
// Patrol paths
// ---------------------------------------------------------------------------

/** PATROLPATHCOMMAND_* (strings 0x53c278..0x53c368; switch in FUN_0048cca0) [recovered]. */
export const PATROL_COMMAND = Object.freeze({
  NONE: -1, ANIMATION: 0, DELAY: 1, WALKTO: 2, RUNTO: 3, CROUCH: 4, LOOKATNODE: 5, END: 6, QUIT: 7, SETSPEED: 8,
} as const);

export interface PatrolCommand {
  command: number;
  parameter: number;
}

/**
 * Patrol cursor over a PatrolPath task's PatrolPathCommand children
 * (FUN_004525f0 init, FUN_00452540 next, FUN_00452570 advance) [recovered]:
 * past the last command the cursor returns to the END command once one was
 * passed, else to the first command; arriving again at that END leaves the
 * cursor where it is, so the command after END repeats forever. QUIT ends
 * the Patrol action (the script's IDLE handler then usually starts it again).
 */
export class AiPatrolCursor {
  private loop: number | null = null;
  /** Index of the current command, null for an empty path. */
  current: number | null;
  constructor(readonly commands: readonly PatrolCommand[], start = 0) {
    let i = 0;
    for (; i < commands.length && i < start; i++) {
      if (commands[i].command === PATROL_COMMAND.END) this.loop = i;
    }
    this.current = i < commands.length ? i : null;
    if (this.current !== null && commands[this.current].command === PATROL_COMMAND.END) this.current = this.next();
  }
  private next(): number | null {
    if (this.current !== null && this.current + 1 < this.commands.length) return this.current + 1;
    if (this.loop !== null) return this.loop;
    return this.commands.length ? 0 : null;
  }
  command(): PatrolCommand | null {
    return this.current === null ? null : this.commands[this.current];
  }
  /** Move to the next command; false when the cursor stays (the exe re-runs the same command). */
  advance(): boolean {
    let n = this.next();
    if (n === null) return false;
    if (this.commands[n].command === PATROL_COMMAND.END) {
      if (n === this.loop) return false;
      this.current = this.loop = n;
      n = this.next();
      if (n === null || n === this.current) return false;
      if (this.commands[n].command === PATROL_COMMAND.END) throw new Error("AiPatrolCursor: END command following END command");
    }
    this.current = n;
    return true;
  }
}

/** Turn limits passed to the steering (H+0x3ec0): Look/Walk use pi, LookAtNode 0.025926 rad [recovered FUN_004513c0 / FUN_00451390]. */
export const AI_TURN_CLAMP = Object.freeze({ normal: Math.fround(Math.PI), lookAtNode: Math.fround(0.025926) });
/** LookAtNode done when yaw and pitch errors are within 3 deg (0x3d567750) [recovered FUN_0048cca0]. */
export const AI_LOOKAT_NODE_TOLERANCE = Math.fround(0.0523599);

// ---------------------------------------------------------------------------
// Movement interface (virtual controller) and node occupancy
// ---------------------------------------------------------------------------

/** A queued waypoint counts as reached inside this half-size box in the soldier's frame (FUN_00450310) [recovered]. */
export const AI_WAYPOINT_REACHED = 1228.8;

/**
 * Steering value written to input channel 0 (turn) or 1 (pitch):
 * clamp(error, +-limit) / pi (FUN_00450310 / FUN_004510e0) [recovered]. The
 * body turns at (value x its own maximum rate); while walking channel 4
 * (forward) is 1.0. Walking speed is the body's animation root motion
 * (FUN_00453ea0 / FUN_004c9650), not an AI constant.
 */
export function aiSteerValue(errorRad: number, limitRad: number): number {
  const e = Math.max(-limitRad, Math.min(limitRad, errorRad));
  return Math.fround(e * 0.318309873);
}

/** AI virtual input channels (H+0x3c6c + 4*i, copied into soldier +0x1b0 each frame) [recovered]. */
export const AI_CHANNEL = Object.freeze({
  TURN: 0, PITCH: 1, LEFT: 2, RIGHT: 3, FORWARD: 4, BACK: 5, FIRE: 6, RELOAD: 8,
  WALK_TOGGLE: 20, KNEEL: 21, LIEDOWN: 22, ANIMATION: 23, USE: 24, PANIC: 25, CH26: 26, AIM: 27, CH28: 28,
  GRENADE: 29, CLOSE_COMBAT: 30,
} as const);

/** Body states checked by the actions (soldier +0x2fc; table 0x53f4fc) [recovered]. */
export const AI_BODY_STATE = Object.freeze({ STAND: 0, KNEEL: 19, LIEDOWN: 26, ANIMATION: 35, STATIONARY_GUN: 36 } as const);

/** Occupancy grid cell (2 m) and stamp (FUN_00451b30, FUN_00451990, table 0x53aa48) [recovered]. */
export const AI_OCCUPANCY_CELL = 8192;
export const AI_OCCUPANCY_KERNEL: readonly (readonly [number, number, number])[] = Object.freeze(
  [-2, -1, 0, 1, 2].flatMap((dy) => [-2, -1, 0, 1, 2].map((dx): readonly [number, number, number] => {
    const ring = Math.max(Math.abs(dx), Math.abs(dy));
    return [dx, dy, ring === 0 ? 100 : ring === 1 ? 50 : 25];
  })),
);

/**
 * Per-node occupancy (FUN_00451a70 / FUN_00489680 / FUN_00489ba0)
 * [recovered]: a node of radius r metres has n = trunc(r) cells per axis
 * (0x451adf: fld size; fmul 0.5; fistp; 0 for the usual 0.5 m nodes, 1 for
 * 1.5 m); a cell is free while its stamped
 * weight is < 25, so reserved cells keep >= 3 cells (6 m) apart. Nodes with
 * n = 0 hold one soldier.
 */
export class AiNodeOccupancy {
  readonly size: number;
  private readonly grid: Int32Array;
  occupants = 0;
  constructor(radiusMetres: number) {
    this.size = x87Fistp(x87StoreF32(radiusMetres * 2) * 0.5);
    this.grid = new Int32Array(Math.max(1, this.size * this.size));
  }
  private stamp(cx: number, cy: number, sign: number): void {
    for (const [dx, dy, w] of AI_OCCUPANCY_KERNEL) {
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.grid[x * this.size + y] += sign * w;
    }
  }
  isFree(cx: number, cy: number): boolean {
    return this.grid[cx * this.size + cy] < 25;
  }
  /** Some cell can take another soldier (FUN_00489680). */
  hasRoom(): boolean {
    if (this.occupants === 0) return true;
    if (this.occupants >= this.size * this.size) return false;
    for (let i = 0; i < this.size * this.size; i++) if (this.grid[i] < 25) return true;
    return false;
  }
  reserve(cx: number, cy: number): void {
    this.occupants++;
    this.stamp(cx, cy, 1);
  }
  release(cx: number, cy: number): void {
    this.occupants--;
    this.stamp(cx, cy, -1);
  }
  /** Cell containing a node-local offset (units): trunc(local / 8192 + n/2) clamped to [0, n] (FUN_00451b30, fistp at 0x451d56 / 0x451d65). */
  cellOf(localX: number, localY: number): [number, number] {
    const c = (v: number) => {
      let t = this.size * 0.5 + v * (1 / 8192);
      if (t < 0) t = 0;
      else if (this.size < t) t = this.size;
      return x87Fistp(t);
    };
    return [c(localX), c(localY)];
  }
  /** Node-local offset (units) of a cell centre: (i - n/2) * 8192 clamped to +-radius (FUN_00489ba0). */
  cellOffset(cx: number, cy: number, radiusMetres: number): [number, number] {
    const lim = radiusMetres * 4096;
    const o = (i: number) => Math.max(-lim, Math.min(lim, (i - Math.trunc(this.size / 2)) * 8192));
    return [o(cx), o(cy)];
  }
}

// ---------------------------------------------------------------------------
// Driver details
// ---------------------------------------------------------------------------

/**
 * Reaction delay stored with a newly pushed action (FUN_0044fc40):
 * fistp((r + 1) * 0.2 * 30), truncated (0x44fc8c), = 6..11 ticks for the
 * RNG's r = k / 65536 [recovered]. FUN_0044ecf0 only
 * counts it down for stack entries without an update function, and every
 * action's start function installs one, so it has no observable effect.
 */
export function aiReactionDelayTicks(r: number): number {
  return x87Fistp(x87Mul(x87Mul(x87Add(r, 1), Math.fround(0.2)), 30));
}

/** Priority given to an action queued while no event is current / by CREATE (-1) and the "empty stack" bound (24) [recovered FUN_0044eb80]. */
export const AI_EMPTY_STACK_PRIORITY = 0x18;

/** Corpse/AI shutdown countdown copied from H+0x3d38 (300 ticks) [recovered FUN_0044deb0; use in FUN_0044e260 only partly traced]. */
export const AI_DEATH_COUNTDOWN_TICKS = 300;
