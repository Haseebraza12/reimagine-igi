/**
 * Skeleton and animation files `common/anims/<id>.iff` (EA-IFF, big-endian
 * chunk sizes). Reference implementation: tools/igi_anim.py; full notes in
 * docs/characters.md.
 *
 * Layout (observed on all six files; parsed by igi.exe FUN_004cce30):
 *
 *   FORM BOBJ
 *     FORM BOBH
 *       BOSH  u32 skeleton id (= HumanSoldier 'Bone Heirachy'), u32 bone count
 *       PLST  i32 parent per bone (-1 for bone 0; every parent < its child)
 *       TLST  f32[3] per bone: joint offset in the parent's frame (IGI units)
 *     FORM BOAL
 *       BALH  u32 clip count, u32 clip-id capacity (largest id + 1)
 *       clip count x FORM BOAN
 *         BOAH  f32 duration (ticks), u32 flags (bit 31 = loop), i32 clip id
 *         BOTH  u32 n, then (n > 0) BOTD: n x { f32 pos[3], f32 time,
 *               f32 c[3], f32 d[3] }  root translation keys (40 bytes)
 *         per bone: BORH u32 n, BORD n x { f32 q[4] (x, y, z, w), f32 time,
 *               f32 a[4], f32 b[4] }  rotation keys with squad controls
 *         BOEH  u32 n, BOED n x { i32 trigger, i32 0, f32 time, f32[3] }
 *
 *   The writer stores FORM sizes for BOBJ and BOAL that stop after the
 *   12-byte header of their last child FORM (observed on all six files);
 *   this reader checks that quirk and otherwise walks chunks by tag, as the
 *   exe does. Every other size must be exact.
 *
 * Time: ticks, 4800 per second (3ds Max). FUN_004c93d0 sets the per-frame
 * advance to 4800 / fps, FUN_004cc860 converts blend seconds x 4800.
 * [recovered] Keys are mostly on a 160-tick (30 fps) grid [observed].
 *
 * Sampling [recovered: FUN_004cb810 rotations, FUN_004caed0 translation,
 * FUN_004cd3d0 precomputation; FUN_004c92d0 enables the smooth mode]:
 *   rotation: find the first key with time >= t. Exact hit: that key.
 *     Before the first key: key 0. After the last key: key 0 interpolated
 *     from the last key over (duration - lastTime) if the clip loops, else
 *     the last key. Otherwise u = 1 - (t1 - t) / (t1 - t0) and the result is
 *     squad: slerp(slerp(q0, q1, u), slerp(a0, b1, u), 2u(1 - u)), each
 *     slerp taking the shorter arc and falling back to a plain lerp below
 *     0.01 rad (and to q0 at exactly 0).
 *   translation (root, object space): exact key, hold the last key past the
 *     end (never wraps), otherwise cubic Hermite with dt = t1 - t0:
 *       h00 p0 + h01 p1 + dt (h10 c0 + (u^2 - u^3) d1).
 *
 * Root translation: FUN_004c9650 returns the sampled position (object space,
 * z up, about 0.97 m for standing clips) and its change since the last
 * sample; humans move by the change (root motion) and the absolute value is
 * the pelvis offset above the feet (FUN_00488760 / FUN_004606b0). For the
 * first-person arms it is the offset of the arms root from the camera
 * (FUN_00463840). [recovered]
 */

export const TICKS_PER_SECOND = 4800;
const LOOP_FLAG = 0x80000000;

export interface Skeleton {
  /** BOSH skeleton id; equals the file number (000.iff -> 0). */
  id: number;
  boneCount: number;
  /** Parent bone per bone; -1 for the root (bone 0). parent < index. */
  parents: Int32Array;
  /** Joint offset from the parent, xyz per bone, IGI units, parent frame. */
  offsets: Float32Array;
}

export interface RotationTrack {
  /** Key times in ticks, strictly increasing, first = 0. */
  times: Float32Array;
  /** Key quaternions (x, y, z, w) per key. */
  q: Float32Array;
  /** Squad control quaternions a, b per key. */
  a: Float32Array;
  b: Float32Array;
  /** slerp(q_i, q_i+1) arc data per key (angle, 1/sin, flip); [] when 1 key. */
  arcQ: Float64Array;
  arcAB: Float64Array;
}

export interface TranslationTrack {
  times: Float32Array;
  /** Positions (x, y, z per key), IGI units, object space. */
  values: Float32Array;
  /** Hermite controls c (out of key i) and d (into key i+1), xyz per key. */
  c: Float32Array;
  d: Float32Array;
}

export interface AnimEvent {
  /** Trigger id (animtrigger/animtrigger.qvm DefineAnimTrigger, e.g. 1006 = mp5_reload_1). */
  trigger: number;
  time: number;
  values: [number, number, number];
}

export interface AnimClip {
  id: number;
  /** Duration in ticks (4800 per second). */
  duration: number;
  seconds: number;
  /** BOAH bit 31: rotations interpolate from the last key back to key 0. */
  loop: boolean;
  translation: TranslationTrack;
  /** One track per bone. */
  rotation: RotationTrack[];
  events: AnimEvent[];
  /** File offset of the clip's FORM (for diagnostics). */
  offset: number;
}

export interface AnimationFile {
  skeleton: Skeleton;
  /** BALH clip-id capacity (largest id + 1). */
  idCapacity: number;
  clips: Map<number, AnimClip>;
}

export interface ClipSample {
  /** Local rotation (x, y, z, w) per bone, relative to the parent. */
  rotations: Float32Array;
  /** Root translation (object space, IGI units). */
  translation: [number, number, number];
}

function fail(message: string): never {
  throw new Error(`ANIM: ${message}`);
}

class Reader {
  pos = 0;
  constructor(private readonly bytes: Uint8Array, private readonly view: DataView) {}

  private header(tag: string): number {
    const at = this.pos;
    if (at + 8 > this.bytes.length) fail(`truncated chunk header at 0x${at.toString(16)}`);
    const found = String.fromCharCode(this.bytes[at], this.bytes[at + 1], this.bytes[at + 2], this.bytes[at + 3]);
    if (found !== tag) fail(`expected ${tag} at 0x${at.toString(16)}, found "${found}"`);
    this.pos += 8;
    return this.view.getUint32(at + 4, false);
  }

  form(type: string): { at: number; size: number } {
    const at = this.pos;
    const size = this.header("FORM");
    const b = this.bytes;
    const p = this.pos;
    if (p + 4 > b.length) fail(`truncated FORM at 0x${at.toString(16)}`);
    const found = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
    if (found !== type) fail(`expected FORM ${type} at 0x${at.toString(16)}, found "${found}"`);
    this.pos += 4;
    return { at, size };
  }

  chunk(tag: string, expect?: number): { at: number; size: number } {
    const at = this.pos;
    const size = this.header(tag);
    if (this.pos + size > this.bytes.length) fail(`${tag} at 0x${at.toString(16)} runs past the end of the file`);
    if (expect !== undefined && size !== expect) fail(`${tag} at 0x${at.toString(16)} has ${size} bytes, expected ${expect}`);
    const start = this.pos;
    this.pos += size + (size & 1);
    return { at: start, size };
  }
}

/** FUN_004aa7b0: shortest-arc angle, 1/sin(angle) and whether to negate q1. */
function arc(q: ArrayLike<number>, i: number, r: ArrayLike<number>, j: number, out: Float64Array, o: number): void {
  let dot = q[i] * r[j] + q[i + 1] * r[j + 1] + q[i + 2] * r[j + 2] + q[i + 3] * r[j + 3];
  let flip = 0;
  if (dot < 0) {
    if (dot >= -1e-8) dot = 0;
    else {
      flip = 1;
      dot = -dot;
    }
  }
  const angle = Math.acos(Math.min(1, dot));
  out[o] = angle;
  out[o + 1] = angle !== 0 ? 1 / Math.sin(angle) : 1;
  out[o + 2] = flip;
}

export function readAnimations(buffer: ArrayBuffer): AnimationFile {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const r = new Reader(bytes, view);
  const f32 = (at: number) => view.getFloat32(at, true);

  const bobj = r.form("BOBJ");
  const bobh = r.form("BOBH");
  const bosh = r.chunk("BOSH", 8);
  const id = view.getUint32(bosh.at, true);
  const boneCount = view.getUint32(bosh.at + 4, true);
  if (boneCount < 1 || boneCount > 256) fail(`BOSH at 0x${bosh.at.toString(16)}: bone count ${boneCount}`);
  const plst = r.chunk("PLST", 4 * boneCount);
  const parents = new Int32Array(boneCount);
  for (let i = 0; i < boneCount; i++) {
    const p = view.getInt32(plst.at + 4 * i, true);
    if ((i === 0 && p !== -1) || (i > 0 && (p < 0 || p >= i))) {
      fail(`PLST at 0x${plst.at.toString(16)}: bone ${i} has parent ${p} (must be an earlier bone)`);
    }
    parents[i] = p;
  }
  const tlst = r.chunk("TLST", 12 * boneCount);
  const offsets = new Float32Array(3 * boneCount);
  for (let i = 0; i < 3 * boneCount; i++) offsets[i] = f32(tlst.at + 4 * i);
  if (r.pos !== bobh.at + 8 + bobh.size) fail(`FORM BOBH at 0x${bobh.at.toString(16)} size does not match its chunks`);

  const boal = r.form("BOAL");
  if (bobj.size !== 4 + 8 + bobh.size + 12) fail("FORM BOBJ size differs from the observed writer quirk");
  const balh = r.chunk("BALH", 8);
  const clipCount = view.getUint32(balh.at, true);
  const idCapacity = view.getUint32(balh.at + 4, true);
  const clips = new Map<number, AnimClip>();
  let lastAt = -1;
  for (let k = 0; k < clipCount; k++) {
    const boan = r.form("BOAN");
    lastAt = boan.at;
    const boah = r.chunk("BOAH", 12);
    const duration = f32(boah.at);
    const flags = view.getUint32(boah.at + 4, true);
    const clipId = view.getInt32(boah.at + 8, true);
    const where = `BOAN at 0x${boan.at.toString(16)}`;
    if (clipId < 0 || clipId >= idCapacity || clips.has(clipId)) fail(`${where}: clip id ${clipId} invalid or repeated`);
    if (!(duration > 0) || (flags & ~LOOP_FLAG) !== 0) fail(`${where}: duration ${duration}, flags 0x${flags.toString(16)}`);

    const both = r.chunk("BOTH", 4);
    const nt = view.getUint32(both.at, true);
    const translation: TranslationTrack = {
      times: new Float32Array(nt),
      values: new Float32Array(3 * nt),
      c: new Float32Array(3 * nt),
      d: new Float32Array(3 * nt),
    };
    if (nt > 0) {
      const botd = r.chunk("BOTD", 40 * nt);
      for (let i = 0; i < nt; i++) {
        const at = botd.at + 40 * i;
        translation.times[i] = f32(at + 12);
        for (let c = 0; c < 3; c++) {
          translation.values[3 * i + c] = f32(at + 4 * c);
          translation.c[3 * i + c] = f32(at + 16 + 4 * c);
          translation.d[3 * i + c] = f32(at + 28 + 4 * c);
        }
      }
    }

    const rotation: RotationTrack[] = [];
    for (let bone = 0; bone < boneCount; bone++) {
      const borh = r.chunk("BORH", 4);
      const n = view.getUint32(borh.at, true);
      if (n < 1) fail(`${where}: bone ${bone} has no rotation key`);
      const bord = r.chunk("BORD", 52 * n);
      const track: RotationTrack = {
        times: new Float32Array(n),
        q: new Float32Array(4 * n),
        a: new Float32Array(4 * n),
        b: new Float32Array(4 * n),
        arcQ: new Float64Array(n > 1 ? 3 * n : 0),
        arcAB: new Float64Array(n > 1 ? 3 * n : 0),
      };
      for (let i = 0; i < n; i++) {
        const at = bord.at + 52 * i;
        track.times[i] = f32(at + 16);
        for (let c = 0; c < 4; c++) {
          track.q[4 * i + c] = f32(at + 4 * c);
          track.a[4 * i + c] = f32(at + 20 + 4 * c);
          track.b[4 * i + c] = f32(at + 36 + 4 * c);
        }
      }
      if (n > 1) {
        // FUN_004cd3d0: segment i runs from key i to key (i + 1) mod n; the
        // wrap segment stays zero (= hold key i) unless the clip loops.
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          if (j === 0 && (flags & LOOP_FLAG) === 0) continue;
          arc(track.q, 4 * i, track.q, 4 * j, track.arcQ, 3 * i);
          arc(track.a, 4 * i, track.b, 4 * j, track.arcAB, 3 * i);
        }
      }
      rotation.push(track);
    }

    const boeh = r.chunk("BOEH", 4);
    const ne = view.getUint32(boeh.at, true);
    const boed = r.chunk("BOED", 24 * ne);
    const events: AnimEvent[] = [];
    for (let i = 0; i < ne; i++) {
      const at = boed.at + 24 * i;
      events.push({ trigger: view.getInt32(at, true), time: f32(at + 8), values: [f32(at + 12), f32(at + 16), f32(at + 20)] });
    }
    if (r.pos !== boan.at + 8 + boan.size) fail(`${where}: FORM size does not match its chunks`);
    for (const times of [translation.times, ...rotation.map((t) => t.times)]) {
      if (times.length === 0) continue;
      if (times[0] !== 0) fail(`${where}: first key is not at time 0`);
      for (let i = 1; i < times.length; i++) if (!(times[i] > times[i - 1])) fail(`${where}: key times do not increase`);
    }
    clips.set(clipId, {
      id: clipId,
      duration,
      seconds: duration / TICKS_PER_SECOND,
      loop: (flags & LOOP_FLAG) !== 0,
      translation,
      rotation,
      events,
      offset: boan.at,
    });
  }
  if (r.pos !== bytes.length) fail(`${bytes.length - r.pos} unexplained bytes after the last clip`);
  if (lastAt >= 0 && boal.at + 8 + boal.size !== lastAt + 12) fail("FORM BOAL size differs from the observed writer quirk");
  return { skeleton: { id, boneCount, parents, offsets }, idCapacity, clips };
}

/** Exe slerp between quaternion (x, y, z, w) arrays using a precomputed arc. */
function slerpInto(
  out: Float32Array, o: number,
  q0: ArrayLike<number>, i: number,
  q1: ArrayLike<number>, j: number,
  arcData: ArrayLike<number>, k: number,
  u: number,
): void {
  const angle = arcData[k];
  if (angle === 0) {
    for (let c = 0; c < 4; c++) out[o + c] = q0[i + c];
    return;
  }
  const sign = arcData[k + 2] ? -1 : 1;
  let c0: number;
  let c1: number;
  if (angle >= 0.009999999776482582) {
    c0 = Math.sin(angle - u * angle) * arcData[k + 1];
    c1 = Math.sin(u * angle) * arcData[k + 1];
  } else {
    c0 = 1 - u;
    c1 = u;
  }
  for (let c = 0; c < 4; c++) out[o + c] = c0 * q0[i + c] + c1 * sign * q1[j + c];
}

const tmpA = new Float32Array(4);
const tmpB = new Float32Array(4);
const tmpArc = new Float64Array(3);

/** Local rotation of one bone at `t` ticks (FUN_004cb810, smooth mode). */
export function sampleRotation(clip: AnimClip, bone: number, t: number, out: Float32Array, o = 0): void {
  t = Math.min(Math.max(t, 0), clip.duration); // the exe only samples [0, duration]
  const tr = clip.rotation[bone];
  if (!tr) fail(`clip ${clip.id} has no bone ${bone}`);
  const n = tr.times.length;
  const copy = (i: number) => {
    for (let c = 0; c < 4; c++) out[o + c] = tr.q[4 * i + c];
  };
  if (n === 1) return copy(0);
  let k = 0;
  while (k < n && tr.times[k] < t) k++;
  if (k < n && tr.times[k] === t) return copy(k);
  let i: number;
  let j: number;
  let u: number;
  if (k === n) {
    if (!clip.loop || !(clip.duration > tr.times[n - 1])) return copy(n - 1);
    i = n - 1;
    j = 0;
    u = (t - tr.times[i]) / (clip.duration - tr.times[i]);
  } else if (k === 0) {
    return copy(0);
  } else {
    i = k - 1;
    j = k;
    u = 1 - (tr.times[j] - t) / (tr.times[j] - tr.times[i]);
  }
  slerpInto(tmpA, 0, tr.q, 4 * i, tr.q, 4 * j, tr.arcQ, 3 * i, u);
  slerpInto(tmpB, 0, tr.a, 4 * i, tr.b, 4 * j, tr.arcAB, 3 * i, u);
  // FUN_004cab90 with weight w = 1 - 2u(1 - u): B below 0.001, A above 0.999.
  blendRotation(out, o, tmpA, 0, tmpB, 0, 1 - 2 * u * (1 - u));
}

/**
 * FUN_004cab90 (recovered): the exe's quaternion blend, also used by the
 * blend tree (FUN_004ca850 -> FUN_004ca5e0, docs/characters.md "Blending").
 * `w` is the weight of q0: w <= 0.001 (f32 0x5316c0) gives q1, w >= 0.999
 * (f32 0x532af8) gives q0; otherwise slerp from q0 toward q1 by u = 1 - w
 * along the shorter arc (FUN_004aa7b0: q1 negated when the dot product is
 * below -1e-8), a plain unnormalised lerp below 0.01 rad, and q0 at an
 * angle of exactly 0. `out` may alias q0 at the same offset.
 */
export function blendRotation(
  out: Float32Array, o: number,
  q0: ArrayLike<number>, i: number,
  q1: ArrayLike<number>, j: number,
  w: number,
): void {
  if (w <= 0.0010000000474974513) {
    for (let c = 0; c < 4; c++) out[o + c] = q1[j + c];
  } else if (w >= 0.9990000128746033) {
    for (let c = 0; c < 4; c++) out[o + c] = q0[i + c];
  } else {
    arc(q0, i, q1, j, tmpArc, 0);
    slerpInto(out, o, q0, i, q1, j, tmpArc, 0, 1 - w);
  }
}

/** Root translation at `t` ticks (FUN_004caed0, smooth mode). */
export function sampleTranslation(clip: AnimClip, t: number): [number, number, number] {
  t = Math.min(Math.max(t, 0), clip.duration);
  const { times, values, c, d } = clip.translation;
  const n = times.length;
  if (n === 0) return [0, 0, 0];
  const key = (i: number): [number, number, number] => [values[3 * i], values[3 * i + 1], values[3 * i + 2]];
  if (n === 1) return key(0);
  let k = 0;
  while (k < n && times[k] < t) k++;
  if (k === n) return key(n - 1);
  if (times[k] === t || k === 0) return key(k);
  const t0 = times[k - 1];
  const dt = times[k] - t0;
  const u = 1 - (times[k] - t) / dt;
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h01 = 3 * u2 - 2 * u3;
  const h10 = u - 2 * u2 + u3;
  const g = u2 - u3;
  const out: [number, number, number] = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    out[a] = h00 * values[3 * (k - 1) + a] + h01 * values[3 * k + a] + dt * (h10 * c[3 * (k - 1) + a] + g * d[3 * k + a]);
  }
  return out;
}

/** Sample every bone and the root translation at `t` ticks. */
export function sampleClip(clip: AnimClip, t: number, out?: Float32Array): ClipSample {
  const rotations = out ?? new Float32Array(4 * clip.rotation.length);
  for (let b = 0; b < clip.rotation.length; b++) sampleRotation(clip, b, t, rotations, 4 * b);
  return { rotations, translation: sampleTranslation(clip, t) };
}

/**
 * Playback time in ticks after `seconds` of play (FUN_004cb1f0): looping
 * playback subtracts the duration, one-shot playback stops at the duration.
 * The exe's loop decision is the caller's play flag, not the clip's BOAH loop
 * bit; the soldier tables give the flag per action.
 */
export function clipTime(clip: AnimClip, seconds: number, loop: boolean): number {
  const t = Math.max(0, seconds) * TICKS_PER_SECOND;
  if (!loop) return Math.min(t, clip.duration);
  return t % clip.duration;
}

// ---------------------------------------------------------------------------
// Recovered tables
// ---------------------------------------------------------------------------

/** One entry of a human action -> clip table: clip id in the human's own .iff and its play flag (1 = loop). */
export interface ActionAnim {
  clip: number;
  loop: boolean;
  /** Our reading of the action (inferred from the clip's motion and the action handler); recovered numbers, inferred labels. */
  meaning: string;
}

const A = (clip: number, loop: number, meaning: string): ActionAnim => ({ clip, loop: loop === 1, meaning });

/**
 * HumanSoldier action table at 0x53ccc0 (38 x {i32 clip, i32 flag}), used for
 * every AI type except PRIBOI (0x53cf20), CIVILIAN (0x53d050) and the SPETNAZ_*
 * types (0x53cdf0) (switch at 0x45bab0 on HumanAI type - 5). The action
 * handlers are the 38 functions at 0x53cbc0; FUN_00488290 plays entry i.
 * Clip ids refer to the soldier's own .iff (level-1 soldiers: 001.iff).
 * Actions 30 and 32-34 do not use the table: 32 = standing death (clip 22 or
 * 23 at random for gunshots, 28 / 71 for explosions; FUN_0045aea0),
 * 33 = kneeling death (clip 24, FUN_0045b000), 34 = prone death (clip 25,
 * FUN_0045b0b0). Action 0 plays the HumanSoldier 'Stand Animation' clip
 * instead of entry 0 when that is not -1 (FUN_00459620).
 */
export const HUMAN_SOLDIER_ACTIONS: readonly ActionAnim[] = [
  // Entry i is played by HumanSoldier state i's entry (docs/characters.md "Soldier state graph").
  A(2, 1, "state 0: stand (or 'Stand Animation', one-shot)"),
  A(34, 1, "state 1: panic run"),
  A(3, 1, "state 2: run"),
  A(57, 1, "state 3: walk"),
  A(10, 0, "state 4: roll left (stand to kneel)"),
  A(11, 0, "state 5: roll right (stand to kneel)"),
  A(56, 1, "state 6: stand fire (trigger held)"),
  A(14, 0, "state 7: stand reload"),
  A(58, 0, "state 8: throw grenade (event 11 releases)"),
  A(70, 0, "state 9: close combat (event 12 rolls the blow)"),
  A(54, 0, "state 10: stand aim"),
  A(53, 0, "state 11: raise to aim"),
  A(55, 0, "state 12: lower from aim"),
  A(7, 0, "state 13: stand to kneel"),
  A(19, 0, "state 14: kneel to stand (never entered)"),
  A(12, 0, "state 15: dive to prone"),
  A(13, 0, "state 16: prone to stand"),
  A(48, 1, "state 17: combat run"),
  A(52, 1, "state 18: run firing"),
  A(18, 0, "state 19: kneel"),
  A(33, 0, "state 20: kneel roll left"),
  A(32, 0, "state 21: kneel roll right"),
  A(9, 1, "state 22: kneel fire"),
  A(15, 0, "state 23: kneel reload"),
  A(8, 0, "state 24: kneel aim"),
  A(20, 0, "state 25: kneel to prone"),
  A(16, 0, "state 26: prone"),
  A(17, 0, "state 27: prone fire"),
  A(21, 0, "state 28: prone reload"),
  A(2, 1, "state 29: fall"),
  A(0, 0, "state 30: flinch (clip from the zone table 0x53d180)"),
  A(26, 0, "state 31: prone flinch"),
  A(0, 0, "state 32: standing death (see above)"),
  A(0, 0, "state 33: kneeling death (clip 24)"),
  A(0, 0, "state 34: prone death (clip 25)"),
  A(0, 0, "state 35: scripted animation (the requested clip, one-shot)"),
  A(31, 1, "state 36: stationary gun"),
  A(2, 0, "state 37: use"),
];

/**
 * First-person rig [recovered unless noted]. FUN_004632d0 creates the arms
 * object: model "005_01_1" (location0 models archive), skeleton 5
 * (005.iff), starts clip 2, LOD 0 (weighted skinning). FUN_00463840 places
 * it every frame: position = camera + R * rootTranslation(t) (+ wall
 * pull-back along the view direction), rotation R = view(pitch, yaw) x sway.
 * The camera is the human position + (0, 0, 2826.24) units standing,
 * (0, 0, 1433.6) crouched (FUN_00464490).
 * Gun parts follow bones of the arms skeleton [observed: in the weapons'
 * stand clips bones 52 / 55 sit within 0.15 cm of the gun models' magazine /
 * slide-bolt-pump ATTA offsets from bone 3 for most guns; the attaching code
 * was not located, so the binding itself is inferred]: gun body = bone 3,
 * magazine (GunClip) = bone 52, moving part = bone 55, identity offsets.
 */
export const FIRST_PERSON = {
  model: "005_01_1",
  skeleton: 5,
  initialClip: 2,
  eyeHeightStanding: 2826.24,
  eyeHeightCrouched: 1433.6,
  gunBone: 3,
  magazineBone: 52,
  movingPartBone: 55,
} as const;

/** Third-person soldiers: gun model on bone 22 of the 33-bone skeletons (observed fit, inferred). */
export const SOLDIER_GUN_BONE = 22;
