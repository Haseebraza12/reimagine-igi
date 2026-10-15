/**
 * Clip playback for a soldier body, as the bone-0 layer of igi.exe's bone
 * object (human+0x68): world/bone-anim.ts (the exe's blend tree). Pure (no
 * Three.js), shared by SoldierBody and the headless tests.
 *
 * Recovered:
 *   - Play (FUN_004cc860 -> FUN_004cae60 / FUN_004cb5f0): a new instance on
 *     every call, time 0, step 160 ticks (DAT_007e4d68), flags = the caller's
 *     loop flag | 0x8000 ("first advance"); the stored root sample (+0x10)
 *     starts at the first key of the translation track, so the first root
 *     delta is zero. Every soldier call site passes blend 0 (the 38 action
 *     entries through FUN_00488290 and the direct calls at 0x45bbc8,
 *     0x452880, 0x4566e0, 0x459660, 0x45ad74, 0x45b04e, 0x45b0fe, ...), and
 *     a play under one update frees the tree: soldiers never blend, every
 *     switch is instant and clears the finished flag. playClip's optional
 *     blend builds the exe's fade for other callers.
 *   - Root delta (FUN_004c9650 -> FUN_004caed0), taken BEFORE the advance in
 *     the soldier tick: sample the translation at the current time, delta =
 *     sample - stored sample, store the sample.
 *   - Advance (FUN_00460010 -> FUN_004c98b0 -> FUN_004cb1f0): time += 160
 *     (float32); events with old < t <= new fire (on the first advance also
 *     t == old); when time >= duration the finished flag is set (at every
 *     loop wrap too); one-shot play clamps the time at the duration (the flag
 *     is then set on every later advance), loop play subtracts the duration,
 *     fires the events from -1 to the new time and re-bases the stored sample
 *     at the first key minus the delta to the end, so the motion across the
 *     wrap is continuous.
 *   - The pose is drawn at the advanced time (FUN_0045e150 -> FUN_004c9f50).
 *   - The human's position is pelvis level: feet = position - root z, where
 *     the root z is FUN_004c9650's sample (+0x51c, FUN_00488760 /
 *     FUN_004606b0); rootZ is that value (the new clip's first key until the
 *     first sample).
 */
import { type AnimationFile } from "../../loaders";
import { x87Div, x87Mul, x87StoreF32 } from "../../loaders/x87";
import { BoneAnim, PLAY_LOOP } from "../world/bone-anim";

/** Animation ticks per game tick: 4800 / 30 (FUN_004c93d0(30.0)) [recovered]. */
export const ANIM_TICKS_PER_TICK = 160;
const DEFAULT_ROOT_Z = 0.95 * 4096;

export interface AnimTrigger {
  trigger: number;
  /** Clip that fired it (human+0x53c). */
  clip: number;
}

export interface AdvanceResult {
  triggers: AnimTrigger[];
  /** Bone 0's finished flag (0x100) after this advance. */
  finished: boolean;
}

/** What the soldier motor needs from an animated body. */
export interface BodyAnimator {
  /** Start a clip (new instance, time 0; FUN_004cc860 with blend 0). False when the clip is missing. */
  playClip(id: number, loop: boolean): boolean;
  hasClip(id: number): boolean;
  /** Clip duration in ticks, or 0. */
  clipDuration(id: number): number;
  /** Id of the playing clip, or -1. */
  readonly currentClip: number;
  /** FUN_004ccbb0: time / duration of the playing clip (x87 chop; 0 when none). */
  phase(): number;
  /** FUN_004ccc40: set the playing clip's time (ticks, float32). */
  setTime(t: number): void;
  /** FUN_004caed0: root translation change since the last sample, object space, IGI units. */
  rootDelta(): [number, number, number];
  /** FUN_004cb1f0: one 30 Hz advance. */
  advance(): AdvanceResult;
  /** The finished flag (cleared by playClip). */
  readonly finished: boolean;
  /** Pelvis height above the feet: z of the last root sample (+0x51c; IGI units). */
  readonly rootZ: number;
}

export class ClipPlayer implements BodyAnimator {
  private readonly layer: BoneAnim;

  constructor(readonly anim: AnimationFile | null) {
    this.layer = new BoneAnim((id) => this.anim?.clips.get(id) ?? null);
  }

  /**
   * The newest instance (FUN_004ccaf0): clip id, loop flag and time. Setting
   * it replaces the tree with that single clip at that time (a renderer
   * mirroring another animator's pose).
   */
  get clip(): { id: number; loop: boolean; time: number } | null {
    const n = this.layer.newest();
    return n ? { id: n.clip, loop: n.loop, time: n.time } : null;
  }

  set clip(value: { id: number; loop: boolean; time: number } | null) {
    if (!value) {
      this.layer.clear();
      return;
    }
    const leaf = this.layer.play(value.id, this.anim?.clips.get(value.id) ?? null, value.loop ? PLAY_LOOP : 0, 0);
    leaf.time = value.time;
  }

  /** FUN_004cc860: start clip `id` (new instance, time 0); `blendSeconds` >= 1/30 fades the old pose out (soldiers pass 0). */
  playClip(id: number, loop: boolean, blendSeconds = 0): boolean {
    const clip = this.anim?.clips.get(id);
    if (!clip) return false;
    this.layer.play(id, clip, loop ? PLAY_LOOP : 0, blendSeconds);
    return true;
  }

  hasClip(id: number): boolean {
    return Boolean(this.anim?.clips.has(id));
  }

  clipDuration(id: number): number {
    return this.anim?.clips.get(id)?.duration ?? 0;
  }

  /** The clip's own loop flag (BOAH bit 31; the exe's playback ignores it). */
  clipLoops(id: number): boolean {
    return Boolean(this.anim?.clips.get(id)?.loop);
  }

  get currentClip(): number {
    return this.layer.newest()?.clip ?? -1;
  }

  get clipId(): number | null {
    return this.layer.newest()?.clip ?? null;
  }

  get finished(): boolean {
    return this.layer.finished;
  }

  /** Bone 0's blending flag 0x10000 (never set for soldiers). */
  get blending(): boolean {
    return this.layer.blending;
  }

  get rootZ(): number {
    const n = this.layer.newest();
    if (!n) return DEFAULT_ROOT_Z;
    return this.layer.rootAbs?.[2] ?? n.stored[2];
  }

  phase(): number {
    const n = this.layer.newest();
    const d = n?.data?.duration ?? 0;
    return n && d > 0 ? x87Div(n.time, d) : 0;
  }

  setTime(t: number): void {
    const n = this.layer.newest();
    if (n) n.time = x87StoreF32(t);
  }

  rootDelta(): [number, number, number] {
    return this.layer.sampleRoot().change;
  }

  advance(): AdvanceResult {
    const triggers: AnimTrigger[] = this.layer.advance().map((e) => ({ trigger: e.trigger, clip: e.clip }));
    return { triggers, finished: this.layer.finished };
  }
}

/** FUN_004ccbb0 x FUN_004ccb70 -> FUN_004ccc40: a new clip's time at the old clip's phase (float32 chop). */
export function phaseTime(phase: number, duration: number): number {
  return x87StoreF32(x87Mul(duration, x87StoreF32(phase)));
}
