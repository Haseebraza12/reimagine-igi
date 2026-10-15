/**
 * One animation layer of an igi.exe bone object: the blend tree that hangs
 * off a bone record (bone + 0x80), as the exe builds, advances, samples and
 * collapses it. Shared by the player's body (player/body.ts), the soldiers'
 * bodies (ai/clip-player.ts) and the first-person arms
 * (player/first-person.ts). docs/characters.md "Blending" has the full
 * derivation. Layer 0 (bone 0) only: the bone has no parent, so the
 * parent-inheriting leaf (LAB_004cae10) never appears.
 *
 * Recovered (addresses in igi.exe):
 *   - Instance (FUN_004cae60 -> FUN_004cb5f0, 0x34 bytes): clip id (+4),
 *     flags (+8: 1 loop, 2 reverse, 0x100 finished, 0x8000 first advance),
 *     stored root sample (+0x10, starts at the first translation key, the
 *     last one when reversed), last root change (+0x1c), rate (+0x28: 160
 *     ticks per update, -160 reversed), time (+0x2c: 0, or the duration
 *     reversed).
 *   - Node (FUN_004c9c50, 0x2c bytes): parent (+0), blend function (+8, 0 =
 *     FUN_004ca850), weight getter (+0xc, LAB_004cca30), destroy (+0x10),
 *     update (+0x14, LAB_004cca40), fade record (+0x18) and two branches
 *     {type, pointer} at +0x1c / +0x24 (type -1 empty, 0 node, 1 leaf).
 *     Branch 0 is the older pose, branch 1 the newer one.
 *   - Fade record (FUN_004cc660, 16 bytes): {t = 0, n, w = 1.0, result}.
 *     Update (LAB_004cca40): t = t + 1; t >= n: w = 0, return result (0 for
 *     a play); else w = f32(1 - t/n) (x87 chop), return -1.
 *   - Play (FUN_004cc860(obj, layer, clip, flags, blend)): n =
 *     f32(f32(blend) x 4800 / 160). A new instance is created every time
 *     (the same clip restarts). If the layer already has a tree and n >= 1
 *     (FUN_004cc550): when the root's branch 1 is empty (a single clip) the
 *     root is reused, else a new root takes the old tree as branch 0; the
 *     new instance becomes branch 1 with a fresh fade, and the bone's
 *     blending flag 0x10000 is set. Otherwise the whole tree is freed
 *     (FUN_004c9b40) and a single-leaf root holds the new instance; flags
 *     0x100 / 0x10000 / 0x40000 are cleared.
 *   - Root motion (FUN_004c9650 -> FUN_004c96c0): every leaf samples its
 *     translation at its time and returns (sample, sample - stored), storing
 *     the sample (FUN_004caed0; a one-key track gives (key, 0)); a blend node
 *     returns out = (b0 - b1) w + b1 for both the absolute value and the
 *     change (FUN_004c9800), i.e. linear by the fade weight of the OLD pose.
 *     No tree: both zero.
 *   - Rotations (FUN_004ca5e0 / FUN_004ca850 / FUN_004cab90): each branch is
 *     evaluated at its own time and the node blends the two with the exe's
 *     slerp (blendRotation) by the same weight w of branch 0.
 *   - Advance (FUN_004c98b0 -> FUN_004c9940): clear the blending flag; a node
 *     without a fade advances branch 0 then branch 1. A fading node first
 *     updates its record: still running -> blending flag set, branch 0
 *     (older) advanced, then branch 1; finished (result 0) -> the record is
 *     destroyed, branch 0 freed WITHOUT a last advance, branch 1 advanced.
 *     Then the tree is collapsed (FUN_004c9dc0 / FUN_004c9de0): a node left
 *     with one branch is replaced by it.
 *   - Instance advance (FUN_004cb1f0): the instance's and the bone's
 *     finished flags are cleared, time += rate (float32), events (FUN_004cb450)
 *     appended to the shared list; at the end the finished flag rises, a
 *     loop wraps (re-basing the stored root sample of a bone-0 instance after
 *     its first advance so the root change is continuous), a one-shot clamps.
 *     Because every instance clears the bone's flag first, the bone's
 *     finished flag after an advance is the newest instance's.
 *   - Newest instance (FUN_004ccaf0, used by FUN_004ccb50 clip id,
 *     FUN_004ccb70 duration, FUN_004ccb90 time, FUN_004ccbb0 phase,
 *     FUN_004ccc10 speed, FUN_004ccc40 set time): blending -> follow branch 1
 *     down to a leaf; else branch 0 of the root.
 *   - Events: the list holds every fired event, oldest instance first; the
 *     humans and the arms act on the first one only (FUN_00460010 +0x538,
 *     FUN_00463840 +0x20c), and footsteps also need its clip to be the newest
 *     instance's (FUN_00462560 / FUN_004594e0 compare +0x53c with
 *     FUN_004ccb50).
 *
 * Port precision: root samples are double precision (as sampleTranslation);
 * times, rates and fade weights follow the exe's float32 / x87 chop rules.
 */
import { blendRotation, sampleRotation, sampleTranslation, type AnimClip } from "../../loaders/anim";
import { x87Div, x87F32Add, x87F32Sub, x87Mul, x87StoreF32, x87Sub } from "../../loaders/x87";

/** Animation ticks per game tick: 4800 / 30 (FUN_004c93d0(30.0) -> DAT_007e4d68) [recovered]. */
export const ANIM_STEP = 160;
const ANIM_TICKS_PER_SECOND = 4800;

/** What playback needs from a clip; an AnimClip fits (tests may pass duration + events only). */
export interface PlaybackClip {
  readonly duration: number;
  readonly events: ReadonlyArray<{ readonly time: number; readonly trigger: number }>;
  /** Root translation track (root motion is zero without it). */
  readonly translation?: AnimClip["translation"];
  /** Rotation tracks (the pose is unavailable without them). */
  readonly rotation?: AnimClip["rotation"];
  /** BOAH loop bit (rotations wrap from the last key to key 0). */
  readonly loop?: boolean;
}

/** FUN_004cc860 flags: bit 0 loop, bit 1 reverse. */
export const PLAY_LOOP = 1;
export const PLAY_REVERSE = 2;

/** One clip instance (FUN_004cb5f0). */
export interface AnimInstance {
  /** Clip id (+4). */
  readonly clip: number;
  /** Clip data (+0xc); null when the lookup had none (nothing advances). */
  data: PlaybackClip | null;
  /** Time in animation ticks (+0x2c, float32). */
  time: number;
  /** Advance per update (+0x28, float32): 160, x speed after FUN_004ccc10. */
  rate: number;
  /** Flag 1. */
  readonly loop: boolean;
  /** Flag 2 (FUN_004ccbe0: rate < 0). */
  reverse: boolean;
  /** Flag 0x8000: not advanced yet (its first advance also fires events exactly at the start time). */
  fresh: boolean;
  /** Flag 0x100: the last advance reached the end. */
  finished: boolean;
  /** Stored root sample (+0x10), IGI units, object space. */
  readonly stored: [number, number, number];
  /** Root change of the last sample (+0x1c). */
  readonly change: [number, number, number];
}

/** An event appended to the advance's list (FUN_004cb450 record: trigger +4, clip +8, time +0xc). */
export interface FiredEvent {
  trigger: number;
  clip: number;
  time: number;
}

/** A fade record (FUN_004cc660). */
export interface Fade {
  /** Updates so far (float32). */
  t: number;
  /** Length in updates: f32(seconds x 4800 / 160). */
  readonly n: number;
  /** Weight of branch 0 (the older pose), float32. */
  w: number;
  /** Result once t >= n (FUN_004cc860 passes 0: keep branch 1). */
  readonly result: number;
}

type Branch = { leaf: AnimInstance } | { node: BlendNode } | null;

interface BlendNode {
  parent: BlendNode | null;
  /** Branch 0 (older) and branch 1 (newer). */
  b0: Branch;
  b1: Branch;
  fade: Fade | null;
}

/** A root sample (FUN_004c9650 outputs: human +0x514 absolute, +0x520 change). */
export interface RootSample {
  abs: [number, number, number];
  change: [number, number, number];
}

/** FUN_004cc860: blend length in updates, f32(f32(seconds) x 4800 / 160) (x87 chop). */
export function blendUpdates(seconds: number): number {
  return x87StoreF32(x87Div(x87Mul(Math.fround(seconds), ANIM_TICKS_PER_SECOND), ANIM_STEP));
}

/** LAB_004cca40: one update of a fade; returns -1 while it runs, else its result. */
export function updateFade(f: Fade): number {
  f.t = x87StoreF32(f.t + 1);
  if (f.n <= f.t) {
    f.w = 0;
    return f.result;
  }
  f.w = x87StoreF32(x87Sub(1, x87Div(f.t, f.n)));
  return -1;
}

function firstKey(data: PlaybackClip | null, last: boolean): [number, number, number] {
  const tr = data?.translation;
  if (!tr || tr.times.length === 0) return [0, 0, 0];
  const k = last ? tr.times.length - 1 : 0;
  return [tr.values[3 * k], tr.values[3 * k + 1], tr.values[3 * k + 2]];
}

/** FUN_004caed0: sample the root at the instance's time; change = sample - stored; stored = sample. */
function sampleLeafRoot(l: AnimInstance): void {
  const tr = l.data?.translation;
  if (!tr || tr.times.length === 0) {
    l.change[0] = l.change[1] = l.change[2] = 0;
    return;
  }
  if (tr.times.length === 1) {
    l.stored[0] = tr.values[0];
    l.stored[1] = tr.values[1];
    l.stored[2] = tr.values[2];
    l.change[0] = l.change[1] = l.change[2] = 0;
    return;
  }
  const s = sampleTranslation(l.data as AnimClip, l.time);
  for (let k = 0; k < 3; k++) {
    l.change[k] = s[k] - l.stored[k];
    l.stored[k] = s[k];
  }
}

/** FUN_004cb450: append the events of the window (from, to) in file order. */
function fire(l: AnimInstance, from: number, to: number, out: FiredEvent[]): void {
  const events = l.data?.events;
  if (!events) return;
  const forward = from <= to;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  for (const e of events) {
    if (hi < e.time) return;
    let hit: boolean;
    if (lo === hi) hit = e.time === lo;
    else if (forward) hit = lo < e.time;
    else hit = lo <= e.time && e.time < hi;
    if (hit) out.push({ trigger: e.trigger, clip: l.clip, time: e.time });
  }
}

export class BoneAnim {
  private root: BlendNode | null = null;
  /** Bone flag 0x10000: a fade runs (set by a blended play and by every advance that keeps one). */
  blending = false;
  /** Bone flag 0x100: the newest advanced instance reached its end on the last advance. */
  finished = false;
  /** The last root sample (human +0x514; arms +0x1f0), null before the first. */
  rootAbs: [number, number, number] | null = null;

  /** `resolve` fills in instances whose clip data was missing when they were played. */
  constructor(private readonly resolve: ((id: number) => PlaybackClip | null) | null = null) {}

  /** FUN_004cc860 on layer 0: a new instance of `clip` (flags PLAY_LOOP | PLAY_REVERSE), faded in over `blendSeconds`. */
  play(clip: number, data: PlaybackClip | null, flags: number, blendSeconds: number): AnimInstance {
    const n = blendUpdates(blendSeconds);
    const reverse = (flags & PLAY_REVERSE) !== 0;
    const leaf: AnimInstance = {
      clip,
      data,
      time: reverse ? (data?.duration ?? 0) : 0,
      rate: reverse ? -ANIM_STEP : ANIM_STEP,
      loop: (flags & PLAY_LOOP) !== 0,
      reverse,
      fresh: true,
      finished: false,
      stored: firstKey(data, reverse),
      change: [0, 0, 0],
    };
    const root = this.root;
    if (root && n >= 1) {
      // FUN_004cc550 (result 0).
      let node = root;
      if (node.b1 !== null) {
        const top: BlendNode = { parent: null, b0: { node }, b1: null, fade: null };
        node.parent = top;
        node = top;
      }
      node.b1 = { leaf };
      node.fade = { t: 0, n, w: 1, result: 0 };
      this.root = node;
      this.blending = true;
      return leaf;
    }
    this.root = { parent: null, b0: { leaf }, b1: null, fade: null };
    this.blending = false;
    this.finished = false;
    return leaf;
  }

  /** Drop the tree (no animation). */
  clear(): void {
    this.root = null;
    this.blending = false;
    this.finished = false;
    this.rootAbs = null;
  }

  /** FUN_004ccaf0: the newest instance. */
  newest(): AnimInstance | null {
    const root = this.root;
    if (!root) return null;
    if (this.blending) {
      let n: BlendNode = root;
      for (;;) {
        const b = n.b1;
        if (!b) return null;
        if ("leaf" in b) return b.leaf;
        n = b.node;
      }
    }
    const b = root.b0;
    return b && "leaf" in b ? b.leaf : null;
  }

  /** The fade of the root node (the newest blend), or null. */
  get fade(): Fade | null {
    return this.root?.fade ?? null;
  }

  /** The newest instance of the older branch of the root fade (what is fading out), or null. */
  outgoing(): AnimInstance | null {
    const root = this.root;
    if (!root?.fade) return null;
    let b = root.b0;
    while (b && "node" in b) b = b.node.b1 ?? b.node.b0;
    return b ? b.leaf : null;
  }

  /** Every instance, oldest first (the advance order). */
  instances(): AnimInstance[] {
    const out: AnimInstance[] = [];
    const walk = (b: Branch) => {
      if (!b) return;
      if ("leaf" in b) out.push(b.leaf);
      else {
        walk(b.node.b0);
        walk(b.node.b1);
      }
    };
    if (this.root) {
      walk(this.root.b0);
      walk(this.root.b1);
    }
    return out;
  }

  private data(l: AnimInstance): PlaybackClip | null {
    if (!l.data && this.resolve) l.data = this.resolve(l.clip);
    return l.data;
  }

  // --- root motion: FUN_004c9650 ---------------------------------------------------------

  /** FUN_004c9650: the blended root translation and its change since the last sample (IGI units). */
  sampleRoot(): RootSample {
    const r = this.root ? this.nodeRoot(this.root) : null;
    const out: RootSample = r ?? { abs: [0, 0, 0], change: [0, 0, 0] };
    this.rootAbs = [out.abs[0], out.abs[1], out.abs[2]];
    return out;
  }

  private branchRoot(b: Branch): RootSample | null {
    if (!b) return null;
    if ("node" in b) return this.nodeRoot(b.node);
    const l = b.leaf;
    this.data(l);
    sampleLeafRoot(l);
    return { abs: [l.stored[0], l.stored[1], l.stored[2]], change: [l.change[0], l.change[1], l.change[2]] };
  }

  /** FUN_004c96c0. */
  private nodeRoot(n: BlendNode): RootSample | null {
    const a = this.branchRoot(n.b0);
    const b = this.branchRoot(n.b1);
    if (!a) return b;
    if (!b) return a;
    // FUN_004c9800: out = (a - b) w + b, w = the getter's weight of branch 0.
    const w = n.fade ? n.fade.w : 0;
    const lerp = (x: number[], y: number[]): [number, number, number] => [
      (x[0] - y[0]) * w + y[0],
      (x[1] - y[1]) * w + y[1],
      (x[2] - y[2]) * w + y[2],
    ];
    return { abs: lerp(a.abs, b.abs), change: lerp(a.change, b.change) };
  }

  // --- advance: FUN_004c98b0 ----------------------------------------------------------------

  /** FUN_004c98b0 for this layer: advance every instance; returns the events in firing order. */
  advance(): FiredEvent[] {
    const out: FiredEvent[] = [];
    const root = this.root;
    if (!root) return out;
    this.blending = false;
    this.advanceNode(root, out);
    this.root = this.collapse(root);
    if (!this.root) {
      this.blending = false;
      this.finished = false;
    }
    return out;
  }

  private advanceBranch(b: Branch, out: FiredEvent[]): void {
    if (!b) return;
    if ("node" in b) this.advanceNode(b.node, out);
    else this.advanceLeaf(b.leaf, out);
  }

  /** FUN_004c9940. */
  private advanceNode(n: BlendNode, out: FiredEvent[]): void {
    if (!n.fade) {
      this.advanceBranch(n.b0, out);
      this.advanceBranch(n.b1, out);
      return;
    }
    const r = updateFade(n.fade);
    if (r !== -1) n.fade = null; // FUN_004c9d80
    if (r === 0) {
      n.b0 = null;
      this.advanceBranch(n.b1, out);
    } else if (r === 1) {
      n.b1 = null;
      this.advanceBranch(n.b0, out);
    } else if (r === 2) {
      n.b0 = null;
      n.b1 = null;
    } else {
      this.blending = true;
      this.advanceBranch(n.b0, out);
      this.advanceBranch(n.b1, out);
    }
  }

  /** FUN_004cb1f0 (the layer's bone is bone 0). */
  private advanceLeaf(l: AnimInstance, out: FiredEvent[]): void {
    const data = this.data(l);
    this.finished = false;
    l.finished = false;
    if (!data) return;
    const t0 = l.time;
    const t1 = x87F32Add(l.rate, t0);
    l.time = t1;
    const hasEvents = data.events.length > 0;
    if (hasEvents) {
      if (l.fresh && t0 !== t1) fire(l, t0, t0, out);
      fire(l, t0, t1, out);
    }
    const dur = data.duration;
    if ((!l.reverse && dur <= t1) || (l.reverse && t1 <= 0)) {
      l.finished = true;
      this.finished = true;
      if (!l.loop) {
        l.time = l.reverse ? 0 : dur;
      } else {
        let from: number;
        if (!l.reverse) {
          l.time = x87F32Sub(t1, dur);
          from = -1;
        } else {
          l.time = x87F32Add(dur, t1);
          from = x87StoreF32(dur + 1);
        }
        if (hasEvents) fire(l, from, l.time, out);
        if (!l.fresh) {
          // Re-base the stored sample: the change across the wrap continues the motion.
          const saved = l.time;
          l.time = l.reverse ? 0 : dur;
          sampleLeafRoot(l);
          const k = firstKey(data, l.reverse);
          for (let c = 0; c < 3; c++) l.stored[c] = k[c] - l.change[c];
          l.time = saved;
        }
      }
    }
    l.fresh = false;
  }

  /** FUN_004c9de0: replace nodes left with one branch by that branch; returns the (new) node. */
  private collapse(n: BlendNode): BlendNode | null {
    const p = n.parent;
    const slot: "b0" | "b1" | null = p ? (p.b0 && "node" in p.b0 && p.b0.node === n ? "b0" : "b1") : null;
    if (n.b0 === null) {
      if (n.b1 === null) {
        if (p && slot) {
          p.fade = null;
          p[slot] = null;
        }
        return p;
      }
      n.b0 = n.b1;
      n.b1 = null;
      return this.collapse(n);
    }
    if (n.b1 === null) {
      if ("node" in n.b0 || p !== null) {
        let ret: BlendNode | null = n;
        if (p && slot) {
          p[slot] = n.b0;
          ret = p;
        }
        const child = "node" in n.b0 ? n.b0.node : null;
        if (child) child.parent = p;
        n.b0 = null;
        if (child) return this.collapse(child);
        return ret;
      }
      return n;
    }
    if ("node" in n.b0) this.collapse(n.b0.node);
    if (n.b1 && "node" in n.b1) this.collapse(n.b1.node);
    if (n.b0 === null || n.b1 === null) return this.collapse(n);
    return n;
  }

  // --- pose: FUN_004ca5e0 per bone ------------------------------------------------------

  /**
   * Local rotations (x, y, z, w per bone) of the blended pose at the
   * instances' current times; null without a tree or rotation data.
   * `clipOf` overrides the instances' clip data (e.g. a renderer's copy).
   */
  sampleRotations(boneCount: number, out?: Float32Array, clipOf?: (id: number) => PlaybackClip | null): Float32Array | null {
    if (!this.root) return null;
    const r = this.nodeRotations(this.root, boneCount, clipOf);
    if (!r) return null;
    if (out && out !== r) {
      out.set(r.subarray(0, Math.min(out.length, r.length)));
      return out;
    }
    return r;
  }

  private branchRotations(b: Branch, boneCount: number, clipOf?: (id: number) => PlaybackClip | null): Float32Array | null {
    if (!b) return null;
    if ("node" in b) return this.nodeRotations(b.node, boneCount, clipOf);
    const l = b.leaf;
    const data = clipOf ? clipOf(l.clip) : this.data(l);
    const tracks = data?.rotation;
    if (!data || !tracks) return null;
    const q = new Float32Array(4 * boneCount);
    const n = Math.min(boneCount, tracks.length);
    for (let bone = 0; bone < n; bone++) sampleRotation(data as AnimClip, bone, l.time, q, 4 * bone);
    for (let bone = n; bone < boneCount; bone++) q[4 * bone + 3] = 1;
    return q;
  }

  /** FUN_004ca5e0 / FUN_004ca850: branch 0 and 1 blended by branch 0's weight (FUN_004cab90). */
  private nodeRotations(n: BlendNode, boneCount: number, clipOf?: (id: number) => PlaybackClip | null): Float32Array | null {
    const a = this.branchRotations(n.b0, boneCount, clipOf);
    const b = this.branchRotations(n.b1, boneCount, clipOf);
    if (!a) return b;
    if (!b) return a;
    const w = n.fade ? n.fade.w : 0;
    for (let i = 0; i < a.length; i += 4) blendRotation(a, i, a, i, b, i, w);
    return a;
  }
}
