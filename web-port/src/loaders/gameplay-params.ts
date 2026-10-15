/**
 * Player movement, combat and detection rules of Project I.G.I., recovered
 * from igi.exe and decoded from the original data files.
 *
 * Evidence labels (full write-up: docs/gameplay.md; byte-level self-checks:
 * tools/igi_gameplay.py, 101 checks against the analysed igi.exe):
 *   observed  — value read from a game data file
 *   recovered — meaning/formula read from igi.exe code (function addresses
 *               named next to each item)
 *   inferred  — interpretation not proven by the traced code
 *
 * Units (recovered): 4096 IGI units = 1 m. Game logic runs at a fixed
 * 30 ticks/s (FUN_00414f80 -> FUN_004c93d0(30.0) sets the animation clock to
 * 4800/30 anim ticks per game tick; FUN_00410a30 prints speeds as
 * units/tick x 30 / 4096 m/s). Everything "per tick" below is per 1/30 s.
 *
 * Main findings:
 * - DefineHumanPlayerGeneral (handler FUN_00410160) stores 9 scalars and two
 *   17-entry tables. Speeds are km/h converted to units/tick
 *   (x 4096000 / 108000), lengths metres (x 4096), the lean time seconds
 *   (x 30, FISTP, truncated). See HUMANPLAYER_GENERAL_FIELDS.
 * - Player walking/running/crouching speed is NOT a script constant: the
 *   player moves by the animation root-motion delta x 1.75 (arg 0,
 *   FUN_00410a30). Root speeds come from common/anims/000.iff
 *   (readAnimRootMotion); the animation id per movement state comes from
 *   the table at 0x5368c8 (PLAYER_CLIP_SLOTS, PLAYER_LOCOMOTION_ANIMS).
 * - Health: every human accumulates damage; it dies when the sum reaches its
 *   maximum. Player maximum = 3.0 (arg 7). Soldier maximum = settings.qvm
 *   "Damage scale" (FUN_00407080 writes it to human+0x258). A bullet's damage
 *   is the weapon's Damage Factor x hit-zone multiplier (x difficulty factor
 *   for the player). No distance fall-off for bullets.
 * - AI "hit probability" is a per-bullet roll made when an AI bullet ray
 *   reaches the player (FUN_0045d100); the probability is interpolated
 *   linearly from 0 m to the soldier's view length (FUN_00489de0).
 * - AI vision: AIFunction_SetViewAlpha is the VERTICAL half-angle,
 *   SetViewGamma the HORIZONTAL half-angle (FUN_00487d80); view lengths are
 *   metres. Hearing ranges are in IGI units: gunshot 30 m, silenced 1 m.
 */
import { IGI_UNITS_PER_METRE } from "./coords";
import { isQvmSymbol, readQvmCallTree, type QvmValue } from "./qvm";
import { flattenTasks, readTaskTree, type IgiTask } from "./tasks";
import { x87Div, x87Fistp, x87Mul, x87StoreF32 } from "./x87";

// ---------------------------------------------------------------------------
// Time and unit conversion (recovered)
// ---------------------------------------------------------------------------

/** Fixed logic rate (recovered: FUN_00414f80, FUN_00410a30). */
export const IGI_TICK_HZ = 30;
/** Animation clock (recovered: float 4800.0 at 0x532af4, FUN_004cc860). */
export const IGI_ANIM_TICKS_PER_SECOND = 4800;

/** km/h -> IGI units per tick: x 4096000 (0x5314a4) x 1/108000 (0x5314a0). */
export function kmhToUnitsPerTick(kmh: number): number {
  return (kmh * 4096000) / 108000;
}

/**
 * x87 FISTP as igi.exe executes it: the FPU runs in chop mode (FUN_004966d0,
 * checked every frame at 0x48dbc1; docs/gameplay.md "FPU rounding mode"), so
 * every float -> int conversion truncates toward zero (7.5 -> 7, -1.75 -> -1),
 * keeping the low 32 bits of the 64-bit result. Same as x87Fistp (x87.ts).
 */
export function fistp(x: number): number {
  return x87Fistp(x);
}

/** Seconds -> whole ticks as igi.exe converts them (x 30.0, FISTP: truncated). */
export function secondsToTicks(seconds: number): number {
  return x87Fistp(x87Mul(seconds, IGI_TICK_HZ));
}

// ---------------------------------------------------------------------------
// humanplayer.qvm
// ---------------------------------------------------------------------------

/**
 * DefineHumanPlayerGeneral arguments 0-8 (handler FUN_00410160 stores them
 * at 0x56a358..0x56a378; readers named per field). Values observed in
 * humanplayer.qvm; meanings recovered.
 */
export const HUMANPLAYER_GENERAL_FIELDS = [
  { index: 0, name: "animationSpeedScale", unit: "factor", reader: "FUN_00410a30", meaning: "root-motion delta multiplier (player only)" },
  { index: 1, name: "jumpHorizontalKmh", unit: "km/h", reader: "FUN_0040bb80", meaning: "jump: horizontal speed along the current move direction (0 when standing still)" },
  { index: 2, name: "jumpVerticalKmh", unit: "km/h", reader: "FUN_0040bb80", meaning: "jump: initial upward speed" },
  { index: 3, name: "airControlKmhPerTick", unit: "km/h per tick", reader: "FUN_00408570", meaning: "airborne: Left/Right/Up/Down add this to the velocity each tick (body axes)" },
  { index: 4, name: "leanSideMetres", unit: "m", reader: "FUN_0040e0c0", meaning: "Peek + Left/Right: sideways camera offset" },
  { index: 5, name: "leanUpMetres", unit: "m", reader: "FUN_0040e0c0", meaning: "Peek + Up while crouched: upward camera offset" },
  { index: 6, name: "leanSeconds", unit: "s", reader: "FUN_0040e0c0", meaning: "time to reach / leave a lean (stored as FISTP(s x 30) ticks, truncated)" },
  { index: 7, name: "maxDamage", unit: "damage", reader: "FUN_00410460", meaning: "player health capacity (human+0x258)" },
  { index: 8, name: "fenceShockDamage", unit: "damage", reader: "FUN_00412f20", meaning: "electric fence shock (x zone-13 multiplier, then 45-tick cooldown)" },
] as const;

/** Hit zones (index into the 17-entry tables). Recovered from FUN_00488080 and the bone table 0x53f148. */
export const HIT_ZONE = {
  /** Four limbs x (distal, middle, proximal): zones 0-11. Which limb is which side is not established (inferred grouping). */
  LIMB_A_DISTAL: 0, LIMB_A_MIDDLE: 1, LIMB_A_PROXIMAL: 2,
  LIMB_B_DISTAL: 3, LIMB_B_MIDDLE: 4, LIMB_B_PROXIMAL: 5,
  LIMB_C_DISTAL: 6, LIMB_C_MIDDLE: 7, LIMB_C_PROXIMAL: 8,
  LIMB_D_DISTAL: 9, LIMB_D_MIDDLE: 10, LIMB_D_PROXIMAL: 11,
  /** Torso bones 0-3 when the shot comes from the side. */
  TORSO: 12,
  /** Torso hit from the front (also: explosions, fence shock, melee from the front). */
  TORSO_FRONT: 13,
  /** Torso hit from behind (melee from behind). */
  TORSO_BACK: 14,
  /** Any front hit whose impact point is within 0.15 m (614.4 units, 0x532220) of skeleton bone 4. */
  HEAD_FRONT: 15,
  /** Bones 4-7 (head/neck). */
  HEAD: 16,
} as const;

/** Skeleton-000 bone index -> hit zone (recovered: int32[30] at 0x53f148, read by FUN_00488080). */
export const BONE_TO_HIT_ZONE: readonly number[] = [
  12, 12, 12, 12, 16, 16, 16, 16, 11, 10, 9, 9, 9, 9, 5, 4, 3, 3, 3, 3, 8, 7, 6, 6, 6, 2, 1, 0, 0, 0,
];

/**
 * Soldier damage multipliers per hit zone (recovered: identical 17-entry
 * tables for HumanSoldier 0x53d180, HumanSoldierPistol 0x53ca98,
 * HumanSoldierRPG 0x53c748, HumanSoldierFemale 0x53c4b8; installed by
 * FUN_00488050). Head x100 = any head hit kills (health <= 3).
 */
export const SOLDIER_ZONE_MULTIPLIERS: readonly number[] = [
  0.5, 0.75, 1, 0.5, 0.75, 1, 0.5, 0.75, 1, 0.5, 0.75, 1, 1, 1, 1, 100, 100,
];

export interface HumanPlayerParams {
  /** Raw DefineHumanPlayerGeneral arguments 0-42 (observed). */
  rawGeneral: number[];
  animationSpeedScale: number;
  jumpHorizontalSpeedMps: number;
  jumpVerticalSpeedMps: number;
  /** Air-control acceleration (m/s^2): km/h per tick x 30 / 3.6. */
  airControlAccelMps2: number;
  leanSideM: number;
  leanUpM: number;
  /** Lean transition in whole ticks (FISTP(0.25 x 30) = trunc(7.5) = 7, 0x4101ff). */
  leanTicks: number;
  maxDamage: number;
  fenceShockDamage: number;
  /** Player damage multiplier per hit zone (args 9-25 -> 0x536a50 -> human+0x264+8i). */
  zoneMultipliers: number[];
  /**
   * Args 26-42, written to 0x536b60. No reader of that table was found in
   * igi.exe (only the write loop references it); kept for completeness.
   */
  unusedZoneTable: number[];
  /** DefineHumanPlayerWeaponCategory: weapon ids per category key 1..9. */
  weaponCategories: string[][];
  /** DefineHumanPlayerWeaponCycle order (next/previous weapon). */
  weaponCycle: string[];
  /** DefineHumanPlayerAmmoLimit: carry cap per ammo id (FUN_00410460 -> FUN_0047b530). */
  ammoLimits: Record<string, number>;
}

function fail(message: string): never {
  throw new Error(`gameplay-params: ${message}`);
}

function num(value: QvmValue | undefined, what: string): number {
  if (typeof value !== "number") fail(`${what} is not a number`);
  return value;
}

function sym(value: QvmValue | undefined, what: string): string {
  if (value !== undefined && typeof value === "object" && isQvmSymbol(value)) return value.symbol;
  if (typeof value === "string") return value;
  return fail(`${what} is not a symbol`);
}

/** Decode humanplayer/humanplayer.qvm (4 declarative calls) into named fields in SI units. */
export function decodeHumanPlayerParams(buffer: ArrayBuffer): HumanPlayerParams {
  const calls = new Map(readQvmCallTree(buffer).map((c) => [c.fn, c.args]));
  const general = calls.get("DefineHumanPlayerGeneral") ?? fail("DefineHumanPlayerGeneral missing");
  if (general.length !== 43) fail(`DefineHumanPlayerGeneral has ${general.length} arguments, expected 43`);
  const g = general.map((v, i) => num(v, `DefineHumanPlayerGeneral argument ${i}`));

  const categories: string[][] = [];
  const cat = calls.get("DefineHumanPlayerWeaponCategory") ?? [];
  for (let i = 0; i < cat.length; ) {
    const n = num(cat[i], "weapon category count");
    categories.push(cat.slice(i + 1, i + 1 + n).map((v) => sym(v, "weapon category id")));
    i += 1 + n;
  }
  const ammo = calls.get("DefineHumanPlayerAmmoLimit") ?? [];
  const ammoLimits: Record<string, number> = {};
  for (let i = 0; i + 1 < ammo.length; i += 2) ammoLimits[sym(ammo[i], "ammo id")] = num(ammo[i + 1], "ammo limit");

  return {
    rawGeneral: g,
    animationSpeedScale: g[0],
    jumpHorizontalSpeedMps: g[1] / 3.6,
    jumpVerticalSpeedMps: g[2] / 3.6,
    airControlAccelMps2: (g[3] / 3.6) * IGI_TICK_HZ,
    leanSideM: g[4],
    leanUpM: g[5],
    leanTicks: secondsToTicks(g[6]),
    maxDamage: g[7],
    fenceShockDamage: g[8],
    zoneMultipliers: g.slice(9, 26),
    unusedZoneTable: g.slice(26, 43),
    weaponCategories: categories,
    weaponCycle: (calls.get("DefineHumanPlayerWeaponCycle") ?? []).map((v) => sym(v, "weapon cycle id")),
    ammoLimits,
  };
}

// ---------------------------------------------------------------------------
// Movement and physics constants (recovered)
// ---------------------------------------------------------------------------

/** Gravity: vz -= 84.7417 units/tick each airborne tick (0x5313f0, FUN_00408570) = 18.62 m/s^2. */
export const GRAVITY_UNITS_PER_TICK2 = 84.74169158935547;
export const GRAVITY_MPS2 = (GRAVITY_UNITS_PER_TICK2 * IGI_TICK_HZ * IGI_TICK_HZ) / IGI_UNITS_PER_METRE;

/** Ground snap / step-up distance while grounded: 2048 units (FUN_004600f0 -> FUN_00460fd0). 8192 while sliding. */
export const STEP_HEIGHT_M = 0.5;
export const SLIDE_STEP_HEIGHT_M = 2.0;

/**
 * Body probe heights above the FEET used by the wall sweep FUN_004606b0
 * (recovered constants 0x531418/0x531478/0x531970/0x531960/0x531968):
 * low 0.1 m; middle 0.4 m (0.2 m crouched); top 1.8 m (1.3 m crouched).
 * The feet are the human's position minus the animated root-bone height
 * (FUN_00488760), i.e. a human's position tracks its pelvis. The ground
 * probe FUN_00460fd0 starts at the middle height and flags a roof when the
 * ceiling is closer than 1.8 m. The sweep radius was not recovered.
 */
export const BODY_PROBES_M = {
  standing: { low: 0.1, middle: 0.4, top: 1.8 },
  crouched: { low: 0.1, middle: 0.2, top: 1.3 },
} as const;

/**
 * Slope handling while grounded (FUN_004600f0; slope = 90 deg - elevation of
 * the ground normal). Speeds/accelerations are along the horizontal part of
 * the ground normal; the slide velocity decays x0.9 per tick.
 */
export const SLOPE_RULES = [
  { aboveDeg: 80, mode: "set", unitsPerTick: 1137 },
  { aboveDeg: 60, mode: "set", unitsPerTick: 948 },
  { aboveDeg: 50, mode: "add", unitsPerTick: 56.88888931274414 },
  { aboveDeg: 45, mode: "add", unitsPerTick: 18.962963104248047 },
] as const;
export const WALKABLE_SLOPE_DEG = 45;
/** Per-tick decay of slide, bullet/explosion knock-back and the view kick (0x5315bc). */
export const PER_TICK_DECAY = 0.9;

/** Horizontal slide velocity (units/tick) contribution for a slope, or null if no slide. */
export function slopeSlide(slopeDeg: number): { mode: "set" | "add"; unitsPerTick: number } | null {
  for (const rule of SLOPE_RULES) if (slopeDeg > rule.aboveDeg) return { mode: rule.mode, unitsPerTick: rule.unitsPerTick };
  return null;
}

/**
 * The player's body clip slots: human+0x338 = the static table at 0x5368c8
 * (set by the HumanPlayer constructor, 0x4105a7), 49 x {i32 anim id, i32
 * flag} [recovered, read from igi.exe .data]. FUN_00488290(human, slot,
 * blend) plays slot `slot` on bone 0 (FUN_004cc860); every movement state's
 * enter function passes its own state id as the slot (docs/gameplay.md
 * "Player movement state graph"), except the lean 44, which plays slot 19
 * when crouched. Flag: 1 loop, 0 one shot, 2 one shot played backwards.
 * Slots 30-36 and 46-47 are {0, 0}: those states play their clips directly
 * (use objects, hit-zone tables).
 */
export const PLAYER_CLIP_SLOTS: readonly { readonly clip: number; readonly flag: number }[] = [
  [2, 1], [4, 1], [37, 1], [35, 1], [64, 1], [70, 1], [68, 1], [11, 1], [10, 1], // 0-8: stand, run
  [57, 1], [74, 1], [72, 1], [75, 1], [77, 1], [76, 1], [81, 1], [80, 1], // 9-16: walk
  [14, 0], [15, 0], [19, 1], // 17 crouch down, 18 stand up (both unreachable), 19 crouched
  [17, 1], [41, 1], [39, 1], [27, 1], [49, 1], [47, 1], [29, 1], [28, 1], // 20-27: crouched moves
  [25, 1], [2, 1], // 28 jump, 29 fall
  [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], // 30-36: use objects
  [168, 1], [170, 2], [170, 0], [169, 1], [171, 0], [172, 1], [173, 1], // 37-43: ladder, fence, wire
  [2, 1], [19, 1], // 44 lean, 45 map computer
  [0, 0], [0, 0], [2, 1], // 46 hit, 47 dead, 48 debug fly
].map(([clip, flag]) => ({ clip, flag }));

/**
 * Locomotion clip per named movement state (PLAYER_CLIP_SLOTS[state].clip).
 * The names are the recovered meaning of each state in the graph: which
 * input channel enters it and whether the walking flag human+0xd45
 * (ToggleWalkRun) is set: "run" = flag clear (the constructor's value),
 * "walk" = flag set [recovered, FUN_004088c0 and the state ticks].
 * crouchDown / standUp (states 17 / 18) are never entered: stance changes
 * blend straight between the standing and crouched states (0.2 s).
 */
export const PLAYER_LOCOMOTION_ANIMS = {
  stand: PLAYER_CLIP_SLOTS[0].clip,
  runForward: PLAYER_CLIP_SLOTS[1].clip, runForwardRight: PLAYER_CLIP_SLOTS[2].clip, runForwardLeft: PLAYER_CLIP_SLOTS[3].clip,
  runBack: PLAYER_CLIP_SLOTS[4].clip, runBackRight: PLAYER_CLIP_SLOTS[5].clip, runBackLeft: PLAYER_CLIP_SLOTS[6].clip,
  runRight: PLAYER_CLIP_SLOTS[7].clip, runLeft: PLAYER_CLIP_SLOTS[8].clip,
  walkForward: PLAYER_CLIP_SLOTS[9].clip, walkForwardRight: PLAYER_CLIP_SLOTS[10].clip, walkForwardLeft: PLAYER_CLIP_SLOTS[11].clip,
  walkBack: PLAYER_CLIP_SLOTS[12].clip, walkBackRight: PLAYER_CLIP_SLOTS[13].clip, walkBackLeft: PLAYER_CLIP_SLOTS[14].clip,
  walkRight: PLAYER_CLIP_SLOTS[15].clip, walkLeft: PLAYER_CLIP_SLOTS[16].clip,
  crouchDown: PLAYER_CLIP_SLOTS[17].clip, standUp: PLAYER_CLIP_SLOTS[18].clip, crouchIdle: PLAYER_CLIP_SLOTS[19].clip,
  crouchForward: PLAYER_CLIP_SLOTS[20].clip, crouchForwardRight: PLAYER_CLIP_SLOTS[21].clip, crouchForwardLeft: PLAYER_CLIP_SLOTS[22].clip,
  crouchBack: PLAYER_CLIP_SLOTS[23].clip, crouchBackRight: PLAYER_CLIP_SLOTS[24].clip, crouchBackLeft: PLAYER_CLIP_SLOTS[25].clip,
  crouchRight: PLAYER_CLIP_SLOTS[26].clip, crouchLeft: PLAYER_CLIP_SLOTS[27].clip,
} as const;

// ---------------------------------------------------------------------------
// Animation root motion (common/anims/*.iff)
// ---------------------------------------------------------------------------

export interface AnimRootKey {
  /** Root position (IGI units, model space: +X right, +Y forward, +Z up). */
  x: number;
  y: number;
  z: number;
  /** Key time in animation ticks (4800 per second). */
  t: number;
}

export interface AnimRootMotion {
  id: number;
  /** Loop length in animation ticks (BOAH f32). */
  durationTicks: number;
  /** BOAH flag bit 31 (set on all cyclic locomotion clips; meaning inferred). */
  loops: boolean;
  keys: AnimRootKey[];
}

/**
 * Root-translation tracks of an animation set (common/anims/NNN.iff, big
 * endian IFF). Per FORM BOAN: BOAH = {f32 duration, u32 flags, u32 id};
 * BOTH = u32 key count; BOTD = count x 10 f32 {x, y, z, time, in-tangent xyz,
 * out-tangent xyz}. The key layout is inferred (times are multiples of 160 =
 * one 30 Hz frame; tangents equal the per-anim-tick slope of the position).
 */
export function readAnimRootMotion(buffer: ArrayBuffer): Map<number, AnimRootMotion> {
  const view = new DataView(buffer);
  const out = new Map<number, AnimRootMotion>();
  let current: AnimRootMotion | null = null;
  const tag = (o: number) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  // Linear scan that enters every FORM instead of trusting its size: in
  // 000.iff the outer FORM BOBJ (size 588) is followed inside by FORM BOAL,
  // which runs to the end of the file, so the FORM sizes do not nest.
  let off = 0;
  while (off + 8 <= buffer.byteLength) {
    const id = tag(off);
    const size = view.getUint32(off + 4, false);
    const body = off + 8;
    if (id === "FORM") {
      if (size < 4 || body + 4 > buffer.byteLength) fail(`truncated FORM at ${off}`);
      if (tag(body) === "BOAN") current = null;
      off = body + 4;
      continue;
    }
    if (body + size > buffer.byteLength) fail(`IFF chunk ${id} at ${off} overruns the file`);
    if (id === "BOAH") {
      if (size < 12) fail(`short BOAH at ${off}`);
      const anim: AnimRootMotion = {
        durationTicks: view.getFloat32(body, true),
        loops: view.getUint32(body + 4, true) >>> 31 === 1,
        id: view.getUint32(body + 8, true),
        keys: [],
      };
      current = anim;
      if (!out.has(anim.id)) out.set(anim.id, anim);
    } else if (id === "BOTD" && current) {
      if (size % 40 !== 0) fail(`BOTD at ${off} is not a whole number of 40-byte keys`);
      for (let k = body; k < body + size; k += 40) {
        current.keys.push({
          x: view.getFloat32(k, true), y: view.getFloat32(k + 4, true),
          z: view.getFloat32(k + 8, true), t: view.getFloat32(k + 12, true),
        });
      }
    }
    off = body + size + (size & 1);
  }
  return out;
}

/**
 * Mean horizontal root speed (m/s) over one loop [0, duration], keys
 * interpolated linearly (inferred: the engine's sampler FUN_004c96c0 is a
 * blend tree that was not traced; Hermite tangents change the result < 1%).
 */
export function animRootSpeedMps(anim: AnimRootMotion): number {
  const k = anim.keys;
  if (k.length < 2 || anim.durationTicks <= 0) return 0;
  const at = (t: number): [number, number] => {
    for (let i = 0; i + 1 < k.length; i++) {
      const a = k[i];
      const b = k[i + 1];
      if (a.t <= t && t <= b.t) {
        const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
        return [a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f];
      }
    }
    const last = k[k.length - 1];
    return [last.x, last.y];
  };
  const [x0, y0] = at(0);
  const [x1, y1] = at(anim.durationTicks);
  return (Math.hypot(x1 - x0, y1 - y0) / anim.durationTicks) * (IGI_ANIM_TICKS_PER_SECOND / IGI_UNITS_PER_METRE);
}

/** Player speed per locomotion slot (m/s) = root speed x animationSpeedScale (FUN_00410a30). */
export function playerLocomotionSpeeds(
  anims: Map<number, AnimRootMotion>,
  animationSpeedScale: number,
): Record<keyof typeof PLAYER_LOCOMOTION_ANIMS, number> {
  const out = {} as Record<keyof typeof PLAYER_LOCOMOTION_ANIMS, number>;
  for (const [slot, id] of Object.entries(PLAYER_LOCOMOTION_ANIMS) as Array<[keyof typeof PLAYER_LOCOMOTION_ANIMS, number]>) {
    const anim = anims.get(id);
    out[slot] = anim ? animRootSpeedMps(anim) * animationSpeedScale : 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Health and damage (recovered)
// ---------------------------------------------------------------------------

/** Player damage multiplier per difficulty (FUN_004123e0 / FUN_00412930 / FUN_00412c80). GD_1..GD_3 = profile index 0..2. */
export const PLAYER_DIFFICULTY_DAMAGE: Readonly<Record<"GD_1" | "GD_2" | "GD_3", number>> = { GD_1: 0.75, GD_2: 1, GD_3: 1.25 };

/** Player bullet damage: zone multiplier x weapon Damage Factor x difficulty (FUN_004123e0). */
export function playerBulletDamage(damageFactor: number, zoneMultiplier: number, difficulty: keyof typeof PLAYER_DIFFICULTY_DAMAGE): number {
  return zoneMultiplier * damageFactor * PLAYER_DIFFICULTY_DAMAGE[difficulty];
}

/**
 * Soldier bullet damage (HumanSoldier FUN_0045bfe0): zone multiplier x
 * Damage Factor; a soldier whose AI flag +0x3ab9 is set takes the plain
 * Damage Factor on head zones (no x100); flag +0x3ab8 makes it immune.
 */
export function soldierBulletDamage(damageFactor: number, zone: number, opts: { headshotProof?: boolean } = {}): number {
  if (opts.headshotProof && (zone === HIT_ZONE.HEAD || zone === HIT_ZONE.HEAD_FRONT)) return damageFactor;
  return (SOLDIER_ZONE_MULTIPLIERS[zone] ?? 1) * damageFactor;
}

/** Soldier flinch: damage since the last flinch above settings.qvm "Recoil threshold" sets the hit-reaction flag and resets (FUN_0045bfe0). */
export function soldierFlinches(damageSinceLastFlinch: number, recoilThreshold: number): boolean {
  return damageSinceLastFlinch > recoilThreshold;
}

/** Fall damage on landing (FUN_00408570): (v - 14 m/s) / 13 x maxDamage, v = vertical landing speed. */
export const FALL_DAMAGE_THRESHOLD_MPS = 14;
export function fallDamage(landingSpeedMps: number, maxDamage: number): number {
  const over = landingSpeedMps - FALL_DAMAGE_THRESHOLD_MPS;
  return over > 0 ? (over / 13) * maxDamage : 0;
}

/** Medipack: each round (Fire held, weapon cooldown) removes maxDamage x factor of damage, clamped at 0 (state 0x40fd10). */
export const MEDIPACK_FACTOR_DEFAULT = 0.01;
export function medipackHeal(currentDamage: number, maxDamage: number, factor = MEDIPACK_FACTOR_DEFAULT): number {
  return Math.max(0, Math.min(maxDamage, currentDamage - maxDamage * factor));
}

/**
 * Explosion damage factor at a target (FUN_00415b90): e = distance -
 * targetRadius - radius; full damage inside, linear to 0 over `falloff`.
 * The player passes a third of its bounding radius and then applies the
 * zone-13 multiplier and the difficulty factor (FUN_00412930).
 */
export function explosionDamage(distM: number, targetRadiusM: number, radiusM: number, falloffM: number, damageFactor: number): number {
  const e = distM - targetRadiusM - radiusM;
  if (e < 0) return damageFactor;
  if (e < falloffM) return ((falloffM - e) * damageFactor) / falloffM;
  return 0;
}

/** Hit zone of a bone (FUN_00488080). Torso refinement by shot direction: see torsoZone. */
export function hitZoneForBone(bone: number): number {
  return bone >= 0 && bone < BONE_TO_HIT_ZONE.length ? BONE_TO_HIT_ZONE[bone] : HIT_ZONE.TORSO;
}

/**
 * Torso zone from the direction toward the shooter in the target's body
 * frame (x right, y forward): front if y >= 0 and |x| < y, back if y <= 0
 * and |y| > |x|, else side (FUN_00488080).
 */
export function torsoZone(towardShooterX: number, towardShooterY: number): number {
  if (towardShooterY <= 0 && Math.abs(towardShooterX) < Math.abs(towardShooterY)) return HIT_ZONE.TORSO_BACK;
  if (towardShooterY >= 0 && Math.abs(towardShooterX) < towardShooterY) return HIT_ZONE.TORSO_FRONT;
  return HIT_ZONE.TORSO;
}

// ---------------------------------------------------------------------------
// Weapons (recovered: gun task FUN_004772c0 / FUN_00477ea0, gunshot FUN_00479e30)
// ---------------------------------------------------------------------------

/**
 * Ticks between shots (FUN_004772c0, 0x477d6d: fild rpm; fdivr 60.0; fmul
 * 30.0; fistp): every step chops, so the result is trunc(1800 / rpm) except
 * when 1800 / rpm is a whole number reached through an inexact 60 / rpm:
 * MP5SD 700 -> 2 (2.57), AK47 650 -> 2, M16A2 500 -> 3 (3.6), UZIx2 1200 -> 1
 * (1.5), Dragunov 50 -> 35 (60/50 = 1.2 is inexact, 1.2 x 30 = 35.999...),
 * knife 150 -> 11; Colt 60 -> 30 and SPAS12 40 -> 45 are exact.
 */
export function fireCooldownTicks(roundsPerMinute: number): number {
  return x87Fistp(x87Mul(x87Div(60, roundsPerMinute), IGI_TICK_HZ));
}

/** Spread for the next shot: "Minimum random spread" for the first 4 shots of a trigger hold, then the maximum (degrees). */
export function spreadForShot(minSpreadDeg: number, maxSpreadDeg: number, shotsAlreadyFiredInBurst: number): number {
  return Math.abs(shotsAlreadyFiredInBurst <= 3 ? minSpreadDeg : maxSpreadDeg);
}

/**
 * One pellet's deviation (FUN_004772c0): angle = r1*r2*r3 x spread (cube of
 * uniform randoms, so most shots land near the centre), around the aim axis
 * at azimuth r4 x 2pi. Repeated "Bullets/Round" times per shot.
 */
export function sampleSpreadDeviation(spreadDeg: number, random: () => number): { deviationRad: number; azimuthRad: number } {
  const cube = random() * random() * random();
  return { deviationRad: cube * spreadDeg * (Math.PI / 180), azimuthRad: random() * 2 * Math.PI };
}

/**
 * View kick per shot (FUN_00477ea0): pitch = fixedX + randomX x u,
 * yaw = fixedZ + randomZ x v, (u, v) uniform in the unit disk (rejection
 * sampled), degrees. FUN_00461a90 adds the kick to a camera offset that then
 * decays x0.9 per tick (the view returns to the aim point).
 */
export function sampleViewKick(
  w: { kickFixedXDeg: number; kickRandomXDeg: number; kickFixedZDeg: number; kickRandomZDeg: number },
  random: () => number,
): { pitchRad: number; yawRad: number } {
  let u = 0;
  let v = 0;
  for (let guard = 0; guard < 64; guard++) {
    u = 2 * (random() - 0.5);
    v = 2 * (random() - 0.5);
    if (Math.hypot(u, v) <= 1) break;
  }
  const k = Math.PI / 180;
  return { pitchRad: (w.kickFixedXDeg + w.kickRandomXDeg * u) * k, yawRad: (w.kickFixedZDeg + w.kickRandomZDeg * v) * k };
}

/**
 * Bullet penetration of a surface (FUN_00479e30): power - hardness >= 1
 * passes; == 0 passes with probability 0.6; otherwise stops. Only surfaces
 * that belong to a task (objects/buildings) can be passed; the bullet also
 * continues through humans it hits (up to 10 hits per bullet).
 */
export function bulletPenetrates(penetrationPower: number, materialHardness: number, random: () => number): boolean {
  const d = penetrationPower - materialHardness;
  if (d === 0) return random() < 0.6;
  return d >= 1;
}

/** Ricochet chance off a material with ricochet angle A (deg), at incidence angle i from the surface normal: (A - (90 - i)) / A, once per bullet. */
export function ricochetChance(ricochetDeg: number, incidenceFromNormalDeg: number): number {
  if (ricochetDeg === 0) return 0;
  return Math.max(0, (ricochetDeg - (90 - incidenceFromNormalDeg)) / ricochetDeg);
}

/**
 * Grenade throw speed (FUN_00461a90): h = clamp(ticks the throw was held,
 * 3, 60); speed = (pow(50 h, 0.7) + 0.1 h) x Muzzle Velocity, along the aim
 * direction, added to the thrower's velocity. Unit inferred as IGI units per
 * tick (grenade, velocity 15: 3.7 m/s at a tap .. 30.5 m/s at 2 s).
 */
export function grenadeThrowSpeed(holdTicks: number, muzzleVelocity: number): number {
  const h = Math.max(3, Math.min(60, holdTicks));
  return (Math.pow(50 * h, 0.7) + 0.1 * h) * muzzleVelocity;
}

export interface WeaponRules {
  scriptId: string;
  weaponType: string;
  damageFactor: number;
  penetration: number;
  pellets: number;
  roundsPerMinute: number;
  cooldownTicks: number;
  roundsPerClip: number;
  maxRoundsPerBurst: number;
  minSpreadDeg: number;
  maxSpreadDeg: number;
  kickFixedXDeg: number;
  kickFixedZDeg: number;
  kickRandomXDeg: number;
  kickRandomZDeg: number;
  /** Bullet travel limit (Effective Range x 4096, FUN_00479870). */
  rangeM: number;
  /** "Reload Time": written by both loaders but never read by igi.exe (no reader found); reload length is animation-driven (inferred). */
  reloadTimeUnused: number;
  /**
   * "Muzzle Velocity": bullets ignore it (hitscan). For WEAPONTYPE_GRENADE
   * the throw speed is grenadeThrowSpeed(holdTicks, muzzleVelocity)
   * (FUN_00461a90).
   */
  muzzleVelocity: number;
  /** AI hearing range of a shot (HUMANAI_DETECTIONEVENT_* resolved: 30 m / 1 m). */
  noiseRangeM: number;
  /** Named TagItem children in weaponconfig.qvm (zoom FOVs, grenade radii, medipack factor...). */
  tags: Record<string, number | string>;
}

/** HUMANAI_DETECTIONEVENT_* symbol values (FUN_0044dd00: 0x1e000 and 0x1000 IGI units). */
export const DETECTION_EVENT_RANGE_M: Readonly<Record<string, number>> = {
  HUMANAI_DETECTIONEVENT_GUNSHOT_RANGE: 0x1e000 / IGI_UNITS_PER_METRE,
  HUMANAI_DETECTIONEVENT_GUNSHOT_SILENCED_RANGE: 0x1000 / IGI_UNITS_PER_METRE,
};

function taskNum(task: IgiTask, key: string): number {
  const v = task.params[key];
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return fail(`${task.type} parameter "${key}" is not a number`);
}

function taskSym(task: IgiTask, key: string): string {
  const v = task.params[key];
  if (v !== undefined && !Array.isArray(v)) return sym(v, `${task.type} parameter "${key}"`);
  return fail(`${task.type} parameter "${key}" missing`);
}

/**
 * weapons/weaponconfig.qvm. Each WeaponConfig task overwrites the weapon
 * record that weapons/<NAME>/weapon.qvm defined (FUN_00407cf0 copies 0x6e8
 * bytes over it after FUN_00413b10 loaded weapon.qsc), so these values are
 * the ones the game uses.
 */
export function readWeaponRules(buffer: ArrayBuffer): Map<string, WeaponRules> {
  const out = new Map<string, WeaponRules>();
  for (const t of flattenTasks(readTaskTree(readQvmCallTree(buffer)))) {
    if (t.type !== "WeaponConfig") continue;
    const tags: Record<string, number | string> = {};
    for (const c of t.children) {
      const name = c.params["Name"];
      const value = c.params["Value"];
      if (typeof name === "string" && (typeof value === "number" || typeof value === "string")) tags[name] = value;
    }
    const rpm = taskNum(t, "Rounds/Minute");
    const scriptId = taskSym(t, "Script ID");
    out.set(scriptId, {
      scriptId,
      weaponType: taskSym(t, "Weapon Type"),
      damageFactor: taskNum(t, "Damage Factor"),
      penetration: taskNum(t, "Penetration Power"),
      pellets: taskNum(t, "Bullets/Round"),
      roundsPerMinute: rpm,
      cooldownTicks: rpm > 0 ? fireCooldownTicks(rpm) : 0,
      roundsPerClip: taskNum(t, "Rounds/Clip"),
      maxRoundsPerBurst: taskNum(t, "Maximum Rounds/Burst"),
      minSpreadDeg: taskNum(t, "Minimum random spread"),
      maxSpreadDeg: taskNum(t, "Maximum random spread"),
      kickFixedXDeg: taskNum(t, "Fixed view change around X axis (degrees)"),
      kickFixedZDeg: taskNum(t, "Fixed view change around Z axis (degrees)"),
      kickRandomXDeg: taskNum(t, "Random view change around X axis (degrees)"),
      kickRandomZDeg: taskNum(t, "Random view change around Z axis (degrees)"),
      rangeM: taskNum(t, "Effective Range of Weapon"),
      reloadTimeUnused: taskNum(t, "Reload Time"),
      muzzleVelocity: taskNum(t, "Muzzle Velocity"),
      noiseRangeM: DETECTION_EVENT_RANGE_M[taskSym(t, "AI Detection Event Range")] ?? fail(`${scriptId}: unknown detection range`),
      tags,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// AI combat (settings.qvm, recovered: FUN_00407080 / FUN_00489de0 / FUN_0048bd00)
// ---------------------------------------------------------------------------

export interface AiCombatConfig {
  aiType: string;
  /** Max damage (health) of the soldier: settings.qvm "Damage scale" -> human+0x258. */
  health: number;
  /** HumanSoldier flinch threshold ("Recoil threshold" -> human+0xd04). */
  flinchThreshold: number;
  hitProbabilityAt0m: number;
  hitProbabilityAtViewLength: number;
  /** Aim point moves this fraction of the way to the target each AI fire update. */
  aimPrecision: number;
  maxRoundsPerSequence: number;
  minClipFraction: number;
  randomClipFraction: number;
  /** Delay between single shots (s): (min + rand x random) x 30 -> ticks. */
  minShotDelayS: number;
  randomShotDelayS: number;
  /** Delay between sequences: computed as FISTP(min + rand x random), truncated, WITHOUT x30 (FUN_0048b4a0, 0x48b60e); its reader was not found. */
  minSequenceDelay: number;
  randomSequenceDelay: number;
  targetingTimeoutTicks: number;
  trackingDistanceM: number;
  closeCombatHitProbability: number;
  closeCombatDamage: number;
}

/** HumanAIConfigItem tasks of one difficulty (GOGameDiff, e.g. "GD_2"). */
export function readAiCombatConfig(buffer: ArrayBuffer, difficulty: string): Map<string, AiCombatConfig> {
  const out = new Map<string, AiCombatConfig>();
  for (const t of flattenTasks(readTaskTree(readQvmCallTree(buffer)))) {
    if (t.type !== "HumanAIConfigItem" || taskSym(t, "Difficulty") !== difficulty) continue;
    const aiType = taskSym(t, "AI Type");
    out.set(aiType, {
      aiType,
      health: taskNum(t, "Damage scale"),
      flinchThreshold: taskNum(t, "Recoil threshold"),
      hitProbabilityAt0m: taskNum(t, "Combat firing hit probability at minimum range"),
      hitProbabilityAtViewLength: taskNum(t, "Combat firing hit probability at maximum range"),
      aimPrecision: taskNum(t, "Combat firing Aim precision"),
      maxRoundsPerSequence: taskNum(t, "Combat Firing Max Number Of Rounds per sequence"),
      minClipFraction: taskNum(t, "Combat firing minimum clip percentage"),
      randomClipFraction: taskNum(t, "Combat firing random clip percentage"),
      minShotDelayS: taskNum(t, "Combat firing minimum shot delay (in seconds)"),
      randomShotDelayS: taskNum(t, "Combat firing random shot delay (in seconds)"),
      minSequenceDelay: taskNum(t, "Combat firing minimum delay (in seconds)"),
      randomSequenceDelay: taskNum(t, "Combat firing random delay (in seconds)"),
      targetingTimeoutTicks: secondsToTicks(taskNum(t, "Combat targeting timeout (in seconds)")),
      trackingDistanceM: taskNum(t, "Combat tracking distance (in meters)"),
      closeCombatHitProbability: taskNum(t, "Close Combat hit probability"),
      closeCombatDamage: taskNum(t, "Close Combat damage"),
    });
  }
  return out;
}

/**
 * Probability that one AI bullet which reaches the player counts as a hit
 * (FUN_00489de0 computes it at the start of each fire sequence;
 * FUN_0045d100 rolls rand <= p per bullet ray). Linear in the AI-to-target
 * distance from 0 m (pMin) to the soldier's normal view length (pMax),
 * clamped beyond. An internal combat flag halves it (condition not traced).
 * Grenades always use p = 1. Bullets never hit the shooter's own team.
 */
export function aiHitProbability(distM: number, viewLengthM: number, pMin: number, pMax: number): number {
  if (viewLengthM <= 0) return pMin;
  const d = Math.min(distM, viewLengthM);
  if (d * IGI_UNITS_PER_METRE < 0.01) return pMin;
  return pMin + (d / viewLengthM) * (pMax - pMin);
}

/**
 * Rounds the AI fires in one sequence (FUN_00489de0): for weapons whose
 * burst equals the clip or is < 2, FISTP(clip x float32(minClip + rand x
 * randomClip)) (0x489ec8, truncated) clamped to [1, maxRoundsPerSequence];
 * otherwise the weapon's burst size.
 */
export function aiRoundsInSequence(
  weapon: { roundsPerClip: number; maxRoundsPerBurst: number },
  cfg: { minClipFraction: number; randomClipFraction: number; maxRoundsPerSequence: number },
  random: () => number,
): number {
  if (weapon.maxRoundsPerBurst !== weapon.roundsPerClip && weapon.maxRoundsPerBurst >= 2) return weapon.maxRoundsPerBurst;
  const n = x87Fistp(weapon.roundsPerClip * x87StoreF32(random() * cfg.randomClipFraction + cfg.minClipFraction));
  if (n < 1) return 1;
  return Math.min(n, cfg.maxRoundsPerSequence);
}

// ---------------------------------------------------------------------------
// Detection (recovered: FUN_00487b70 / FUN_00487cf0 / FUN_00487d80 / FUN_00487f40, FUN_0044eee0)
// ---------------------------------------------------------------------------

export interface AiView {
  /** AIFunction_SetViewLength (m) -> AI+0xb0; used when not alarmed. */
  lengthM: number;
  /**
   * AIFunction_SetAlarmViewLength (m) -> AI+0xb8; used while the soldier's
   * alarm is on or it has a combat target (FUN_0044e330). SetViewLength
   * raises it to the view length when it is smaller at that moment.
   */
  alarmLengthM: number;
  /** AIFunction_SetViewAlpha: VERTICAL half-angle (degrees). */
  verticalHalfAngleDeg: number;
  /** AIFunction_SetViewGamma: HORIZONTAL half-angle (degrees). */
  horizontalHalfAngleDeg: number;
}

/**
 * Is a target inside a soldier's view cone? `local` is the target position
 * relative to the soldier's eye in the eye frame (x right, y forward, z up),
 * IGI units or metres (only ratios matter except for the length test, which
 * takes metres). Vertical angle = acos of y in the y-z plane, horizontal =
 * acos of y in the x-y plane; both must be below the half-angles and the 3D
 * distance at most the view length (FUN_00487d80). Visibility then also
 * needs line of sight (lineOfSightClear).
 */
export function isInViewCone(localM: readonly [number, number, number], view: AiView, alarmed: boolean): boolean {
  const [x, y, z] = localM;
  const dist = Math.hypot(x, y, z);
  if (dist > (alarmed ? view.alarmLengthM : view.lengthM)) return false;
  const angle = (a: number, b: number) => {
    const n = Math.hypot(a, b);
    return n === 0 ? 0 : Math.acos(Math.max(-1, Math.min(1, b / n)));
  };
  const vertical = angle(z, y);
  const horizontal = angle(x, y);
  return vertical < (view.verticalHalfAngleDeg * Math.PI) / 180 && horizontal < (view.horizontalHalfAngleDeg * Math.PI) / 180;
}

/**
 * Offset of the point soldiers look at on a human above the human's position
 * (FUN_00464490; recovered). The position tracks the animation root (pelvis):
 * with the 000.iff root heights (stand 0.93 m, crouch idle 0.43 m) this is
 * about 1.62 m above the feet standing and 0.78 m crouched (composition
 * inferred).
 */
export const DETECTION_TARGET_HEIGHT_M = { standing: 2826.24 / IGI_UNITS_PER_METRE, crouched: 1433.6 / IGI_UNITS_PER_METRE } as const;

/** Line of sight (FUN_00487f40): clear ray, or an obstruction at >= 79% of the eye-to-target distance (fraction semantics inferred). */
export function lineOfSightClear(hitFraction: number | null): boolean {
  return hitFraction === null || hitFraction >= 0.79;
}

/**
 * Vision scheduling (FUN_00487b70/FUN_00487cf0): each soldier's detector
 * runs on 1 of every 4 ticks (staggered); the cone test repeats every 2
 * runs (8 ticks), the line-of-sight ray every 3 cone-positive runs
 * (12 ticks). When both pass, the soldier receives AIEVENT_ENEMYDETECTION
 * every AI update (no gradual "detection time"; nDetectionTime belongs to
 * security cameras). Dead same-team bodies in view raise
 * AIEVENT_FRIENDLYDETECTION. No lighting or stance term exists in this path;
 * crouching only lowers the target point.
 */
export const VISION_SCHEDULE_TICKS = { detectorPeriod: 4, coneTest: 8, lineOfSight: 12 } as const;

/**
 * Noise events (FUN_0044fab0 broadcast; FUN_0044eee0 filter). Range is a
 * 3D sphere; no line of sight unless noted; "enemy" = listener of another
 * team, source must be a human.
 */
export const NOISE_EVENTS = [
  { event: "AIEVENT_WALK", id: 10, rangeM: "ground material footstep range", who: "enemy", note: "each footstep while standing (not crouched); FUN_00462560" },
  { event: "AIEVENT_GROUNDIMPACT", id: 11, rangeM: 5, who: "enemy", note: "10 m if the landing caused fall damage; FUN_00408570" },
  { event: "AIEVENT_DOOR", id: 12, rangeM: 5, who: "enemy", note: "FUN_0040c370" },
  { event: "AIEVENT_FENCE", id: 13, rangeM: 5, who: "enemy", note: "fence climb FUN_00411710" },
  { event: "AIEVENT_LADDER", id: 14, rangeM: 5, who: "enemy", note: "ladder states 0x40d7xx-0x40dcxx" },
  { event: "AIEVENT_GUNSHOT", id: 16, rangeM: "weapon: 30 or 1 (silenced)", who: "enemy", note: "every shot; FUN_00477ea0" },
  { event: "AIEVENT_GRENADELAND", id: 18, rangeM: 5, who: "anyone", note: "FUN_00475470" },
  { event: "AIEVENT_FLASHBANG", id: 19, rangeM: 10, who: "anyone with line of sight", note: "record built at 0x47cc92" },
  { event: "AIEVENT_GUNSHOTMISS", id: 20, rangeM: 2, who: "enemy of the shooter", note: "bullet impact / near miss; record built at 0x45f443" },
  { event: "AIEVENT_ALERT", id: 5, rangeM: 7, who: "same team", note: "soldier alerting teammates; FUN_00488f30" },
] as const;

/** Game material properties used by combat/detection (material/material.qvm DefineGameMaterial, layout FUN_00408060). */
export interface GameMaterial {
  name: string;
  /** Arg 1 (record +0x20): subtracted from weapon penetration power. */
  hardness: number;
  /** Arg 2 (+0x24): ricochet angle limit in degrees (0 = never). */
  ricochetDeg: number;
  /** Arg 5 (+0x30): AIEVENT_WALK range in metres for footsteps on this ground. */
  footstepNoiseM: number;
}

export function readGameMaterials(buffer: ArrayBuffer): GameMaterial[] {
  const out: GameMaterial[] = [];
  for (const c of readQvmCallTree(buffer)) {
    if (c.fn !== "DefineGameMaterial") continue;
    const name = c.args[0];
    if (typeof name !== "string") fail("DefineGameMaterial name is not a string");
    out.push({
      name,
      hardness: num(c.args[1], `${name} hardness`),
      ricochetDeg: num(c.args[2], `${name} ricochet`),
      footstepNoiseM: num(c.args[5], `${name} footstep range`),
    });
  }
  return out;
}
