/**
 * Animation-driven body motion, as igi.exe moves humans (docs/gameplay.md,
 * docs/characters.md "Blending").
 *
 * Recovered: the player's body is layer 0 of its bone object (human+0x68),
 * the blend tree of world/bone-anim.ts. Each 30 Hz tick FUN_00410a30 runs
 * the movement graph (whose enters call FUN_004cc860), then FUN_004c9650
 * (root sample: the blended root translation +0x514 and its change since
 * the last sample +0x520), then FUN_00460010 (FUN_004c98b0 advance: 160
 * animation ticks per update, x speed after FUN_004ccc10; events; the
 * finished flag), then the move. So a tick's root motion is the change up
 * to the time the previous tick's advance reached, and the pelvis height is
 * the blended root z at that time (FUN_00488760 / FUN_004606b0 read +0x51c).
 * The movement scales the change by DefineHumanPlayerGeneral argument 0
 * (1.75; FUN_00410a30).
 *
 * Blends (FUN_004cc860 / FUN_004cc550 / LAB_004cca40): the player's body
 * actions pass 0.2 s = f32(0.2 x 4800 / 160) = 6 updates; the old pose keeps
 * playing, weighted w = 1 on the play tick's sample, then f32(1 - k/6) after
 * the k-th advance (5/6 ... 1/6); the 6th advance frees it without
 * advancing it. Root position, root change and every bone rotation use the
 * same w (linear for the root, the exe slerp for the bones). A new blended
 * play during a blend keeps the running blend as the older branch (nested).
 * A play under one update (the jump, the fall, the run states entered from
 * the jump) frees the whole tree: the new clip's root height applies at once
 * and its first change is 0.
 *
 * Events: every advance appends the events of the older instances first;
 * FUN_00460010 dispatches only the first one (+0x538) and the footstep code
 * (FUN_00462560) also requires its clip (+0x53c) to be the newest instance's
 * (FUN_004ccb50).
 */
import { TICKS_PER_SECOND as ANIM_TICKS_PER_SECOND, type AnimClip, type AnimationFile, type ClipSample } from "../../loaders";
import { x87Div, x87StoreF32 } from "../../loaders/x87";
import { ANIM_STEP, BoneAnim, PLAY_LOOP, type FiredEvent } from "../world/bone-anim";

/** Animation ticks per 30 Hz game tick. */
export const ANIM_TICKS_PER_GAME_TICK = ANIM_TICKS_PER_SECOND / 30;
/** The player's body action blend: 0.2 s (0x3e4ccccd) = 6 updates [recovered]. */
const BLEND_SECONDS = Math.fround(0.2);
/** Footstep trigger (FUN_00462560 compares +0x538 with 0x3f2). */
const FOOTSTEP_TRIGGER = 1010;

export interface BodyStep {
  /** Root change of this tick's sample (IGI model space: x right, y forward, z up; units). */
  delta: [number, number, number];
  /** Pelvis height above the feet: the blended root translation z of this tick's sample (IGI units). */
  rootZ: number;
  /**
   * The triggers igi.exe acts on this tick: the first event of the advance
   * (FUN_00460010 +0x538), a footstep 1010 only when that event belongs to
   * the newest instance's clip (FUN_00462560). At most one.
   */
  triggers: number[];
  /** Every event the advance fired, oldest instance first (the exe's event list). */
  events: FiredEvent[];
  /** The bone's finished flag after the advance (the newest instance reached its end). */
  finished: boolean;
}

export class BodyAnimator {
  private readonly layer: BoneAnim;

  constructor(private readonly anim: AnimationFile) {
    this.layer = new BoneAnim();
  }

  get clipId(): number | null {
    return this.layer.newest()?.clip ?? null;
  }

  /** The animation file (skeleton and clips). */
  get animation(): AnimationFile {
    return this.anim;
  }

  /** The newest instance's clip and time (animation ticks); sample() gives the blended pose. */
  get state(): { clip: AnimClip; time: number; loop: boolean } | null {
    const n = this.layer.newest();
    const clip = n ? (n.data as AnimClip | null) : null;
    return n && clip ? { clip, time: Math.min(n.time, clip.duration), loop: n.loop } : null;
  }

  /** Bone 0's blending flag 0x10000 (condition bit 0x2). */
  get blending(): boolean {
    return this.layer.blending;
  }

  /** Weight of the outgoing pose (1 on the play tick, then 1 - k/n), 0 when not blending. */
  get blendWeight(): number {
    return this.layer.fade?.w ?? 0;
  }

  /** Switch to clip `id` with the body's 0.2 s blend (no-op if it is already the newest with the same loop flag). */
  play(id: number, loop: boolean): void {
    const n = this.layer.newest();
    if (n && n.clip === id && n.loop === loop) return;
    this.start(id, loop, BLEND_SECONDS);
  }

  /**
   * FUN_004cc860: start clip `id` as a new instance at time 0, also when it
   * is already playing; with a blend of at least one update (0.2 s = 6) the
   * old pose fades out, otherwise the switch is immediate. Returns false
   * when the clip does not exist.
   */
  start(id: number, loop: boolean, blendSeconds: number): boolean {
    const clip = this.anim.clips.get(id);
    if (!clip) return false;
    this.layer.play(id, clip, loop ? PLAY_LOOP : 0, blendSeconds);
    return true;
  }

  /** FUN_004ccbb0: the newest instance's time / duration (x87), 0 without a clip. */
  phase(): number {
    const n = this.layer.newest();
    const d = n?.data?.duration ?? 0;
    return n && d > 0 ? x87Div(n.time, d) : 0;
  }

  /** The newest instance's clip duration (animation ticks; FUN_004ccb70). */
  get duration(): number {
    return this.layer.newest()?.data?.duration ?? 0;
  }

  /** FUN_004ccc40: set the newest instance's time (animation ticks). */
  setTime(time: number): void {
    const n = this.layer.newest();
    if (n) n.time = x87StoreF32(time);
  }

  /** FUN_004ccc10 + FUN_004ccbe0: the newest instance advances 160 x `speed` per update (float32; reverse below 0). */
  setSpeed(speed: number): void {
    const n = this.layer.newest();
    if (!n) return;
    n.rate = x87StoreF32(ANIM_STEP * Math.fround(speed));
    n.reverse = n.rate < 0;
  }

  /** One game tick: FUN_004c9650 (root sample), then FUN_004c98b0 (advance). */
  step(): BodyStep {
    const root = this.layer.sampleRoot();
    const events = this.layer.advance();
    const first = events[0];
    const newest = this.layer.newest();
    const triggers = first && (first.trigger !== FOOTSTEP_TRIGGER || first.clip === newest?.clip) ? [first.trigger] : [];
    return { delta: root.change, rootZ: root.abs[2], triggers, events, finished: this.layer.finished };
  }

  /**
   * The blended pose at the instances' current (advanced) times, as
   * FUN_004c9f50 poses the body: local rotations per bone and the root
   * translation of the last sample (+0x514; before the first step, the
   * newest instance's stored sample). Null without a clip.
   */
  sample(out?: Float32Array): ClipSample | null {
    const n = this.layer.newest();
    if (!n) return null;
    const rotations = this.layer.sampleRotations(this.anim.skeleton.boneCount, out);
    if (!rotations) return null;
    const t = this.layer.rootAbs ?? n.stored;
    return { rotations, translation: [t[0], t[1], t[2]] };
  }
}
