/**
 * The player's first-person view object (igi.exe's arms/view task at
 * human+0x4ec), shared by the weapon logic (combat/weapon.ts), the camera
 * (player/camera.ts) and the arms renderer (render/viewmodel.ts).
 * docs/weapons-view.md has the full derivation.
 *
 * Recovered (addresses in igi.exe):
 *   - Arms clip player: layer 0 of the arms bone object (arms+0x68), the
 *     same blend tree as the bodies (world/bone-anim.ts; FUN_004cc860 play,
 *     FUN_004cc550 / FUN_004cc660 / LAB_004cca40 fade, FUN_004c98b0 /
 *     FUN_004cb1f0 advance, FUN_004c9650 root). FUN_00463840 samples the
 *     root (arms+0x1f0: the arms root offset from the eye, used for the
 *     placement) and then advances: a clip advances 160 animation ticks per
 *     game tick; at time >= duration the end flag (0x100) is set, a looping
 *     clip wraps (time -= duration), a one-shot clip holds its last frame
 *     and keeps setting the flag. A blend of b seconds becomes
 *     f32(b x 4800 / 160) updates; when >= 1 the old pose keeps playing and
 *     fades out linearly: weight f32(1 - t / n) after t updates; the n-th
 *     update frees it without advancing it (0.4 s -> 12). Blend 0 replaces
 *     the whole tree at once. A blend started during a blend nests (the
 *     running blend is the older branch). The older instances advance first
 *     and every advance clears the shared end flag, so the end flag is the
 *     newest clip's; the poses mix with the exe slerp (FUN_004cab90) and the
 *     root offsets linearly, by the same weight. Only the first event of an
 *     advance is acted on (arms+0x20c: FUN_004e2c60 sounds, the grenade
 *     triggers).
 *   - Sway (FUN_004633e0 sets target + rates, FUN_00463410 snaps current and
 *     target, FUN_00463440 = both angles equal their targets, stepped once per
 *     tick in FUN_00463840 at the given rates, clamped to the target).
 *   - FOV tangents: arms+0x1e4 (world, reset to f32 fptan(pi/4) = 1.0) and
 *     arms+0x1e8 (gun layer, reset to f32 fptan(pi/6)); FUN_00464650 resets
 *     both and clears the "scoped" flag arms+0x1ec, which FUN_00463840 turns
 *     into an arms rotation of Rx(-90 deg) instead of the sway (arms hidden).
 *   - View shake FUN_004645e0(arms, pos, ang, ticks): amplitude 1, step
 *     f32(1 / ticks); each tick while non-zero: pitch, roll, yaw += ang x amp x
 *     (2r - 1) (three draws of the level RNG), eye x (right) and z (up) +=
 *     pos x amp x (2r - 1) (two draws), then amp -= step (0 once below 0).
 *   - Landing dip FUN_00464620(arms, d), d = min(1, v / 8) x -1024 units
 *     (FUN_00408570, v = landing speed in m/s): each tick while d != 0: eye z
 *     += d sin(phi), arms z += 0.075 d sin(phi), phi += f32 12 deg; d = 0 once
 *     phi >= pi (15 ticks: phi = 0, 12, ..., 168 deg).
 */
import type { ClipSample } from "../../loaders/anim";
import { x87Div, x87Mul, x87StoreF32 } from "../../loaders/x87";
import { BoneAnim, PLAY_LOOP, type AnimInstance, type FiredEvent, type PlaybackClip } from "../world/bone-anim";

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);
/** The float32 with the given bit pattern. */
export function f32Bits(bits: number): number {
  U32[0] = bits >>> 0;
  return F32[0];
}

/** Recovered constants (bit patterns / addresses in the comments). */
export const FIRST_PERSON_CONSTANTS = {
  /** f32 fptan(pi/4) for the double 0.7853981852531433 at 0x5315f0 (chop): 1.0. */
  tanWorld: x87StoreF32(Math.tan(0.7853981852531433)),
  /** The same tangent before the float32 store (GunDRAGUNOV compares the unrounded value). */
  tanWorldExtended: Math.tan(0.7853981852531433),
  /** f32 fptan(pi/6) for the double 0.5235987901687622 at 0x5319b8. */
  tanGun: x87StoreF32(Math.tan(0.5235987901687622)),
  /** Weapon-switch sway target (0xbf1c61aa, 0xbeb2b8c3: -35 deg, -20 deg) and rates (0x3d6e4bae, 0x3d082b3f). */
  swayLowered: { alpha: f32Bits(0xbf1c61aa), gamma: f32Bits(0xbeb2b8c3) },
  swayRate: { alpha: f32Bits(0x3d6e4bae), gamma: f32Bits(0x3d082b3f) },
  /** Arms clip blend for stance clips: 0.4 s (0x3ecccccd) -> 12 game ticks. */
  blendSeconds: f32Bits(0x3ecccccd),
  /** Zoom factors: 0.96 (0x5319c4), 1.04 (0x531a78), GunMP5SD 0.8 (0x5316cc) / 1.25 (0x531528). */
  zoomIn: f32Bits(0x3f75c28f),
  zoomOutBinocular: 1.0399999618530273,
  mp5ZoomIn: 0.800000011920929,
  mp5ZoomOut: 1.25,
  /** GunDRAGUNOV scoped: view kick x 0.05 (0x5315c0). */
  scopeKickScale: 0.05000000074505806,
  /** Dip phase step 12 deg (f32 0x5319d4), arms share 0.075 (double 0x5319d8), end at f32 pi (0x531400). */
  dipPhaseStep: 0.20943951606750488,
  dipArmsShare: 0.075,
  piF32: 3.1415927410125732,
  /** Shake amplitudes: 204.8 units (0x531518) and 0.75 deg (0x53151c, 0.013089969754219055 rad). */
  shakePos: 204.8000030517578,
  shakeAngle: 0.013089969754219055,
  /** Bullet / melee hit shake: amplitude scale = clamp(r, 0.25, 1) (0x531520), 15 ticks. */
  hitShakeMin: 0.25,
  hitShakeTicks: 15,
  /** Electric-fence shock: full amplitude, 45 ticks (0x412f69). */
  fenceShakeTicks: 45,
  /** Kick decay factor (0x5315bc). */
  kickDecay: 0.8999999761581421,
} as const;

const C = FIRST_PERSON_CONSTANTS;
/** The clip data the animator needs (from 005.iff; any AnimClip fits, and enables the pose and root offset). */
export interface ArmsClipInfo extends PlaybackClip {
  duration: number;
  events: ReadonlyArray<{ time: number; trigger: number }>;
}

export interface ArmsTrack {
  clip: number;
  /** Clip time in animation ticks (4800 per second). */
  time: number;
  loop: boolean;
  /** Not yet advanced (its first step also fires events at the start time). */
  fresh: boolean;
}

/** igi.exe's first-person arms animation layer 0 (arms+0x68). */
export class ArmsAnimator {
  private readonly layer: BoneAnim;
  /** Clip-end flag (0x100) of the last step: what the weapon state machine reads next tick. */
  ended = false;
  /** The trigger the exe acts on after the last step: the advance's first event (arms+0x20c), if any. */
  triggers: number[] = [];
  /** Every event of the last step, oldest instance first. */
  events: FiredEvent[] = [];
  /** Root offset of the last step's sample (arms+0x1f0, IGI units, view axes), null before the first step. */
  rootOffset: [number, number, number] | null = null;
  /** Steps taken (the renderer uses it to emit triggers once). */
  steps = 0;
  /** Clip plays (play() calls that changed the clip). */
  plays = 0;

  constructor(private readonly clipInfo: (id: number) => ArmsClipInfo | null) {
    this.layer = new BoneAnim(clipInfo);
  }

  /** The newest instance (FUN_004ccaf0). */
  get current(): ArmsTrack | null {
    return this.layer.newest();
  }

  /** The newest instance of the pose being faded out by the newest blend, or null. */
  get previous(): ArmsTrack | null {
    return this.layer.outgoing();
  }

  /** Weight of `previous`'s branch after the last step (1 - t / n), 0 when not blending. */
  get previousWeight(): number {
    return this.layer.fade?.w ?? 0;
  }

  /** Every instance still playing, oldest first. */
  get instances(): readonly AnimInstance[] {
    return this.layer.instances();
  }

  /**
   * FUN_004cc860(anim, 0, clip, loop, blendSeconds): blend >= 1 update fades
   * from the current pose, else replaces it.
   */
  play(clip: number, loop: boolean, blendSeconds = 0): void {
    this.layer.play(clip, this.clipInfo(clip), loop ? PLAY_LOOP : 0, blendSeconds);
    this.plays++;
  }

  /** FUN_004ccc40: set the current clip's time (animation ticks). */
  setTime(time: number): void {
    const n = this.layer.newest();
    if (n) n.time = time;
  }

  /** One game tick (the arms update inside FUN_00463840): root sample, then the advance. */
  step(): void {
    const root = this.layer.sampleRoot();
    this.rootOffset = root.abs;
    const events = this.layer.advance();
    this.ended = this.layer.finished;
    this.events = events;
    this.triggers = events.length > 0 ? [events[0].trigger] : [];
    this.steps++;
  }

  /**
   * The blended arms pose (FUN_00464370 -> FUN_004c9f50 after the update):
   * rotations at the instances' current times, root = the last step's
   * offset (arms+0x1f0; before the first step, the newest clip sampled at
   * its time). `clipOf` supplies clips with rotation / translation data
   * when the lookup given to the constructor lacks them. Null without them.
   */
  sample(boneCount: number, clipOf?: (id: number) => PlaybackClip | null): ClipSample | null {
    const rotations = this.layer.sampleRotations(boneCount, undefined, clipOf);
    if (!rotations) return null;
    let t = this.rootOffset;
    if (!t) {
      const n = this.layer.newest();
      const c = n ? (clipOf ? clipOf(n.clip) : n.data) : null;
      const k = c?.translation;
      t = k && k.times.length > 0 ? [k.values[0], k.values[1], k.values[2]] : [0, 0, 0];
    }
    return { rotations, translation: [t[0], t[1], t[2]] };
  }
}

/** Arms sway (arms+0x1cc..0x1e0): alpha about x (pitch), gamma about z (yaw), radians. */
export class ArmsSway {
  alpha = 0;
  gamma = 0;
  targetAlpha = 0;
  targetGamma = 0;
  rateAlpha = 0;
  rateGamma = 0;

  /** FUN_004633e0: new target and rates (current unchanged). */
  setTarget(alpha: number, gamma: number, rateAlpha: number, rateGamma: number): void {
    this.targetAlpha = alpha;
    this.targetGamma = gamma;
    this.rateAlpha = rateAlpha;
    this.rateGamma = rateGamma;
  }

  /** FUN_00463410: current = target = (alpha, gamma). */
  snap(alpha: number, gamma: number): void {
    this.alpha = this.targetAlpha = alpha;
    this.gamma = this.targetGamma = gamma;
  }

  /** FUN_00463440: both angles on their targets. */
  reached(): boolean {
    return this.alpha === this.targetAlpha && this.gamma === this.targetGamma;
  }

  /** The step inside FUN_00463840 (skipped once reached). */
  step(): void {
    if (this.reached()) return;
    this.alpha = ArmsSway.approach(this.alpha, this.targetAlpha, this.rateAlpha);
    this.gamma = ArmsSway.approach(this.gamma, this.targetGamma, this.rateGamma);
  }

  private static approach(v: number, target: number, rate: number): number {
    if (target <= v) {
      if (target < v) {
        const exact = v - rate;
        return exact < target ? target : x87StoreF32(exact);
      }
      return v;
    }
    const exact = v + rate;
    return target < exact ? target : x87StoreF32(exact);
  }
}

/** Per-tick view offsets produced by the shake and the dip (IGI units / radians). */
export interface ViewOffsets {
  pitch: number;
  roll: number;
  yaw: number;
  /** Eye offset along the view's right axis (horizontal), units. */
  right: number;
  /** Eye offset along world up, units (shake + dip). */
  up: number;
  /** Extra arms offset along world up (0.075 x dip), units. */
  armsUp: number;
}

/** Shake (arms+0x1b4..0x1c0) and landing dip (arms+0x1c4 / 0x1c8). */
export class ViewEffects {
  shakeAmp = 0;
  shakePos = 0;
  shakeAngle = 0;
  shakeStep = 0;
  dipAmount = 0;
  dipPhase = 0;
  readonly offsets: ViewOffsets = { pitch: 0, roll: 0, yaw: 0, right: 0, up: 0, armsUp: 0 };

  /** FUN_004645e0(arms, pos, angle, ticks). */
  shake(pos: number, angle: number, ticks: number): void {
    this.shakeAmp = 1;
    this.shakePos = x87StoreF32(pos);
    this.shakeAngle = x87StoreF32(angle);
    this.shakeStep = x87StoreF32(x87Div(1, ticks));
  }

  /**
   * Bullet hit on the player (FUN_004123e0 0x412518) or melee hit
   * (FUN_00412c80 0x412e41): s = clamp(r, 0.25, 1) from the level RNG,
   * shake(s x 204.8, s x 0.75 deg, 15).
   */
  hitShake(random: () => number): void {
    let s = random();
    if (s < C.hitShakeMin) s = C.hitShakeMin;
    else if (s > 1) s = 1;
    this.shake(x87Mul(s, C.shakePos), x87Mul(s, C.shakeAngle), C.hitShakeTicks);
  }

  /**
   * Explosion near the player (FUN_00412930): d = distance from the eye to the
   * blast; e = d - 3 r; s = 1 if e < 0, else 1 - e / (6 r); shake(s x 204.8,
   * s x 0.75 deg, ticks) when s > 0. `radius` and `ticks` are the blast
   * record's +0x0c and +0x14 fields (which weaponconfig tags fill them is
   * not traced).
   */
  explosionShake(distanceUnits: number, radiusUnits: number, ticks: number): void {
    let s: number;
    const e = distanceUnits - radiusUnits * 3;
    if (e < 0) s = 1;
    else {
      s = 1 - e / (radiusUnits * 6);
      if (!(s > 0)) return;
    }
    this.shake(x87Mul(s, C.shakePos), x87Mul(s, C.shakeAngle), ticks);
  }

  /** Electric-fence shock (FUN_00412f20 0x412f69): shake(204.8, 0.75 deg, 45). */
  fenceShake(): void {
    this.shake(C.shakePos, C.shakeAngle, C.fenceShakeTicks);
  }

  /** FUN_00464620: start a dip of `amount` units (negative = down); the phase restarts. */
  dip(amount: number): void {
    this.dipAmount = x87StoreF32(amount);
    this.dipPhase = 0;
  }

  /**
   * Landing (FUN_00408570 0x408699): amount = clamp(v / 8, 0, 1) x -1024
   * units, v = landing speed in m/s.
   */
  landingDip(speedMetresPerSecond: number): void {
    let k = x87Mul(Math.abs(speedMetresPerSecond), 0.125);
    if (k < 0) k = 0;
    else if (k > 1) k = 1;
    this.dip(x87Mul(k, -1024));
  }

  /** One tick inside FUN_00463840: offsets for this tick, RNG draws while shaking, then the decay. */
  step(random: () => number): ViewOffsets {
    const o = this.offsets;
    o.pitch = o.roll = o.yaw = o.right = o.up = o.armsUp = 0;
    if (this.shakeAmp !== 0) {
      const ang = x87Mul(this.shakeAngle, this.shakeAmp);
      o.pitch = ang * (2 * (random() - 0.5));
      o.roll = ang * (2 * (random() - 0.5));
      o.yaw = ang * (2 * (random() - 0.5));
      const pos = x87Mul(this.shakePos, this.shakeAmp);
      o.right = pos * (2 * (random() - 0.5));
      o.up = pos * (2 * (random() - 0.5));
      if (this.shakeAmp > 0) {
        const exact = this.shakeAmp - this.shakeStep;
        this.shakeAmp = exact < 0 ? 0 : x87StoreF32(exact);
      } else {
        const exact = this.shakeAmp + this.shakeStep;
        this.shakeAmp = exact > 0 ? 0 : x87StoreF32(exact);
      }
    }
    if (this.dipAmount !== 0) {
      const s = Math.sin(this.dipPhase);
      o.up += this.dipAmount * s;
      o.armsUp = this.dipAmount * C.dipArmsShare * s;
      const next = this.dipPhase + C.dipPhaseStep;
      this.dipPhase = x87StoreF32(next);
      if (C.piF32 <= next) this.dipAmount = 0;
    }
    return o;
  }

  reset(): void {
    this.shakeAmp = this.shakePos = this.shakeAngle = this.shakeStep = 0;
    this.dipAmount = this.dipPhase = 0;
    const o = this.offsets;
    o.pitch = o.roll = o.yaw = o.right = o.up = o.armsUp = 0;
  }
}

/** Everything the camera and the arms renderer read from the player's view object. */
export interface FirstPersonState {
  arms: ArmsAnimator;
  sway: ArmsSway;
  effects: ViewEffects;
  /** arms+0x1e4: tan(horizontal half-FOV) of the player view (zoom). */
  tanX: number;
  /** arms+0x1e8: tan(horizontal half-FOV) of the gun layer. */
  gunTanX: number;
  /** arms+0x1ec: binoculars / Dragunov scope view: the arms are turned 90 deg down (hidden). */
  scoped: boolean;
  /** Weapon in the hand (its gun model is drawn on the arms), or null. */
  handWeapon: string | null;
  /**
   * The HumanCamera's view mode for this human (human+0x4f0, copied by
   * FUN_0045e940 into the camera record and kept by FUN_00480dc0 at
   * cam+0xe8; docs/interactions.md section 10) [recovered]: 1 first person,
   * 3 third-person orbit (attached, terminal, lock pick), 5 death camera.
   * The arms and the first-person gun are drawn only in mode 1
   * (FUN_004630e0). Written by player/camera.ts.
   */
  viewMode: ViewMode;
}

/** HumanCamera view modes (FUN_00480dc0): 2 (debug orbit) and 4 (stationary gun) are not used by the port. */
export type ViewMode = 1 | 2 | 3 | 4 | 5;

/** The arms object as FUN_004632d0 creates it: clip 2 (one-shot), no sway, default FOV. */
export function createFirstPersonState(clipInfo: (id: number) => ArmsClipInfo | null): FirstPersonState {
  const arms = new ArmsAnimator(clipInfo);
  arms.play(2, false, 0);
  return { arms, sway: new ArmsSway(), effects: new ViewEffects(), tanX: C.tanWorld, gunTanX: C.tanGun, scoped: false, handWeapon: null, viewMode: 1 };
}

/** FUN_00464650: default FOV tangents, scope off. */
export function resetFirstPersonFov(fp: FirstPersonState): void {
  fp.scoped = false;
  fp.tanX = C.tanWorld;
  fp.gunTanX = C.tanGun;
}

/**
 * Mouse-look transfer of FUN_0045fd00 (yaw) / FUN_00463470 (pitch) for one
 * analog input a (the channel value; its scale from mouse counts is not
 * recovered): delta = a x pi x tanX, divided by (2 - 16.667 |a|) when
 * |a| < 0.06, so zooming slows the look in proportion to tan(hFOV / 2).
 * Pitch first averages a with the previous tick's input while unzoomed
 * (0x46348a compares the float32 tangents). Yaw would do the same, but
 * 0x45ff17 compares the unrounded fptan(pi/4) = 1.0000000437 with the
 * float32 1.0, so yaw is never averaged. Yaw uses -delta, pitch +delta.
 */
export function lookDelta(analog: number, previousAnalog: number, tanX: number, axis: "yaw" | "pitch" = "pitch"): number {
  const smoothed = axis === "pitch" ? tanX === C.tanWorld : tanX === C.tanWorldExtended;
  const a = smoothed ? (analog + previousAnalog) * 0.5 : analog;
  let d = a * C.piF32 * tanX;
  const m = Math.abs(a);
  if (m < 0.05999999865889549) d /= 2 - m * 16.666666666666668;
  return d;
}
