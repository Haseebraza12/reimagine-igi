/**
 * GlassShatter, the shards of a broken pane (docs/damage.md "Glass",
 * docs/rendering.md 7.10) [recovered: class FUN_00448b70, bullet create
 * FUN_00449010, explosion create FUN_0044abb0, subdivision FUN_004494b0,
 * update LAB_00448c90, draw = a PolyList (FUN_004986c0, FUN_00498840 /
 * FUN_00498940 / FUN_00498c10)]:
 *
 *   - Private generator DAT_0057f768: FUN_004aaa00 state (= LevelRng seed 0),
 *     set once when the class registers at start-up (FUN_00405f30 from
 *     0x401011), so it runs on across levels and restarts; the level RNG is
 *     not touched (only the glass_crush sound, FUN_00449470, is).
 *   - Rotation table (30 entries at 0x57f7b8, stride 0x28), drawn at
 *     registration: entry k = FUN_004a9bc0(k a1, k a2, k a3) = Rz Ry Rx with
 *     a = (r x 40 - 20) / 900 rad (f32 0x5318c0, 0x5315c4, 0x5318bc).
 *   - Create: works in the pane's frame (world = R local + p). The faces of
 *     the model's collision set 0 (the HSMC block, `*(model + 0x2c)`) whose
 *     (b - a) x (c - a) has a positive dot product with the push (bullet:
 *     the cast segment x 0.007; explosion: pane - centre; a WORLD vector
 *     dotted with a LOCAL normal) are cut by FUN_004494b0 around the impact
 *     point; at most 1000 shards; life 30 updates.
 *   - Bullet (FUN_00449010): impact point P = R^T (hit - p) and normal
 *     N = R^T n are stored in globals (DAT_0057f788..0x57f7a0) that the
 *     explosion create does NOT set, so an explosion cuts around the last
 *     bullet's impact (zero before any); shard speed 10 units/tick
 *     (0x41200000) radially from P.
 *   - Explosion (FUN_0044abb0): shard speed clamp(|p - centre|, 0, 1) x
 *     409.6 = 409.6 units/tick radially from the local centre.
 *   - FUN_004494b0(a, b, c): P inside the triangle (projected on the plane of
 *     the largest |N| component) gives distances 0; else, per edge, the
 *     distance from P to the edge segment (ca, ab, bc) x 1/5120 clamped to
 *     [0, 1]; limit = d x 4505.6 + 409.6; if limit(ca)^2 < |ab|^2 or
 *     limit(ab)^2 < |bc|^2 or limit(bc)^2 < |ca|^2: one discarded draw, then
 *     the longest edge is cut at t (one draw) and both halves recurse; else a
 *     shard: centroid (x 0.33333334), rotation index trunc(((1 - dmin) + r)
 *     x 0.5 x 30), velocity = unit(centroid - P') x speed + (r x 4096 -
 *     2048) / 30 per axis (three draws).
 *   - Update: g = (R[6], R[7], R[8]) x -44.6 (world -z in the pane frame);
 *     alpha = left / 30 on every vertex; per shard: centre += v, each vertex
 *     = centre' + M (vertex - centre), v += g; left -= 1, deleted at 0.
 *   - Draw: untextured triangles (a, b, c), colour (0.7, 0.7, 0.7) ("333?"
 *     0x53a890), vertex alpha bytes trunc(alpha x 255); LIGHTING off, z test,
 *     no z write, D3DCULL_CW, SRCALPHA / INVSRCALPHA, alpha test > 0, object
 *     fog, near plane x 1.01; in the pane's frame at the time of the break.
 * Coordinates here are IGI units in the pane's frame; floats are rounded to
 * float32 where igi.exe stores them (x87 temporaries kept as doubles).
 */
import { LevelRng } from "../ai/rng";
import { x87Add, x87Fistp, x87Mul, x87StoreF32, x87Sub } from "../../loaders/x87";
import { rotZYX, type Mat3 } from "./bullet-effects";

type V3 = [number, number, number];
/** FSTP DWORD in igi.exe's chop mode (constants are exact float32 values, unchanged by it). */
const f = x87StoreF32;

export const GLASS_SHATTER = {
  /** Updates (+0xbc = 0x1e). */
  life: 30,
  /** More than 999 shards: no more (+0xb8). */
  maxShards: 1000,
  /** Bullet shard speed (0x41200000) and the explosion one (param_6 = 409.6, LAB_004489e0). */
  bulletSpeed: 10,
  explosionSpeed: f(409.6000061035156),
  /** Gravity per update (f32 0x5318c4), along the pane-local world down. */
  gravity: f(-44.600887298583984),
  /** Vertex alpha = left x 1/30 (f32 0x531680). */
  alphaStep: f(0.03333333507180214),
  /** Shard colour (0.7, 0.7, 0.7): the floats "333?" x 3 at 0x53a890 / 0x53a8a0. */
  colour: f(0.699999988079071),
  /** Rotation table: 30 entries, angle (r x 40 - 20) x k / 900 (0x5318c0, 0x5315c4, 0x5318bc). */
  rotations: 30,
  rotRange: f(40),
  rotBias: f(20),
  rotScale: f(0.0011111111380159855),
  /** Edge limit = d x 4505.6 + 409.6 (0x5318d4, 0x5318d0), d = distance x 1/5120 (0x5318d8) clamped. */
  distScale: f(0.00019531250291038305),
  limitRange: f(4505.60009765625),
  limitBase: f(409.6000061035156),
  /** Cut jitter r x 0.1 (0x5313c8) around the fraction (cut no nearer than 0.5 of the longest edge). */
  cutJitter: f(0.10000000149011612),
  third: f(0.3333333432674408),
  /** Rotation index trunc(((1 - d) + r) x 0.5 x 30) (0x531508, 0x5313bc). */
  spinIndexScale: 30,
  /** Scatter (r x 4096 - 2048) x 1/30 per axis (0x5313b8, 0x531500, 0x5318c8). */
  scatterRange: 4096,
  scatterBias: 2048,
  scatterScale: f(0.03333333507180214),
} as const;

/** One shard: a triangle turning about its centroid (shard record, stride 0x60). */
export interface GlassShard {
  centre: V3;
  vertices: [V3, V3, V3];
  /** Rotation table index (+0x48). */
  spin: number;
  velocity: V3;
}

export interface GlassShatterState {
  shards: GlassShard[];
  /** Updates left (+0xbc). */
  left: number;
  /** Per-update gravity in the pane frame. */
  gravity: V3;
  /** Vertex alpha of the last update (DAT_0057f780). */
  alpha: number;
}

/** The pane's collision set 0 in its own frame: IGI units, faces (a, b, c) in file order. */
export interface PaneFaces {
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
}

// --- Process-wide state (globals of igi.exe) ----------------------------------------------

let rng: LevelRng | null = null;
let table: Mat3[] = [];
/** DAT_0057f788..0x57f790: the impact point used by the subdivision (bullet creates only). */
let impact: V3 = [0, 0, 0];
/** DAT_0057f798..0x57f7a0: the impact normal choosing the projection plane (bullet creates only). */
let impactNormal: V3 = [0, 0, 0];

/** FUN_00448b70: seed the private generator and draw the rotation table (once per process). */
function registered(): LevelRng {
  if (rng) return rng;
  rng = new LevelRng(0);
  table = [];
  const G = GLASS_SHATTER;
  for (let k = 0; k < G.rotations; k++) {
    const a1 = f(rng.float() * G.rotRange - G.rotBias);
    const a2 = f(rng.float() * G.rotRange - G.rotBias);
    const a3 = (rng.float() * G.rotRange - G.rotBias) * k;
    const fk = f(k);
    table.push(rotZYX(f(fk * a1 * G.rotScale), f(fk * a2 * G.rotScale), f(a3 * G.rotScale)));
  }
  return rng;
}

/** Start-up state (tests): a fresh generator, no impact remembered. */
export function resetGlassShatterState(): void {
  rng = null;
  table = [];
  impact = [0, 0, 0];
  impactNormal = [0, 0, 0];
}

/** The rotation table (built on first use). */
export function glassRotationTable(): readonly Mat3[] {
  registered();
  return table;
}

/** Draws taken from the private generator since start-up (diagnostics). */
export function glassRngDraws(): number {
  return registered().draws;
}

// --- Create ------------------------------------------------------------------------------

/** R^T v for a row-major world = R local rotation. */
function toLocal(r: Mat3, v: readonly number[]): V3 {
  return [
    f(r[0] * v[0] + r[3] * v[1] + r[6] * v[2]),
    f(r[1] * v[0] + r[4] * v[1] + r[7] * v[2]),
    f(r[2] * v[0] + r[5] * v[1] + r[8] * v[2]),
  ];
}

interface Build {
  rng: LevelRng;
  shards: GlassShard[];
  /** Radial origin of the shard velocities (DAT_0057f7a8..0x57f7b0). */
  from: V3;
  /** DAT_0057f774. */
  speed: number;
}

/**
 * FUN_00449010: a bullet broke the pane. `push` = the shot direction in the
 * WORLD frame (any length), `hit` / `hitNormal` = the hit point and face
 * normal relative to the pane origin (world frame, IGI units / unit).
 */
export function shatterByBullet(faces: PaneFaces, rotation: Mat3, push: readonly number[], hit: readonly number[], hitNormal: readonly number[]): GlassShatterState {
  const r = registered();
  const local = toLocal(rotation, [f(hit[0]), f(hit[1]), f(hit[2])]);
  impact = local;
  impactNormal = toLocal(rotation, hitNormal);
  return shatter(faces, rotation, push, { rng: r, shards: [], from: local, speed: GLASS_SHATTER.bulletSpeed });
}

/**
 * FUN_0044abb0: an explosion broke the pane. `centre` = the explosion centre
 * relative to the pane origin (world frame, IGI units). The subdivision keeps
 * the last bullet's impact point and normal (globals not set here).
 */
export function shatterByExplosion(faces: PaneFaces, rotation: Mat3, centre: readonly number[], speed: number = GLASS_SHATTER.explosionSpeed): GlassShatterState {
  const r = registered();
  const away: V3 = [-centre[0], -centre[1], -centre[2]];
  const dist = f(Math.sqrt(away[2] * away[2] + away[1] * away[1] + away[0] * away[0]));
  const clamped = dist >= 0 ? (dist > 1 ? 1 : dist) : 0;
  const local = toLocal(rotation, [f(centre[0]), f(centre[1]), f(centre[2])]);
  return shatter(faces, rotation, away, { rng: r, shards: [], from: local, speed: f(clamped * speed) });
}

function shatter(faces: PaneFaces, rotation: Mat3, push: readonly number[], build: Build): GlassShatterState {
  const p = faces.positions;
  const idx = faces.indices;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a: V3 = [p[idx[t] * 3], p[idx[t] * 3 + 1], p[idx[t] * 3 + 2]];
    const b: V3 = [p[idx[t + 1] * 3], p[idx[t + 1] * 3 + 1], p[idx[t + 1] * 3 + 2]];
    const c: V3 = [p[idx[t + 2] * 3], p[idx[t + 2] * 3 + 1], p[idx[t + 2] * 3 + 2]];
    // -((b - a) x (c - a)) . push < 0
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const s = -(uz * vx - ux * vz) * push[1] + (uy * vx - ux * vy) * push[2] + (uz * vy - uy * vz) * push[0];
    if (s < 0) subdivide(build, a, b, c);
  }
  const G = GLASS_SHATTER.gravity;
  return { shards: build.shards, left: GLASS_SHATTER.life, gravity: [f(rotation[6] * G), f(rotation[7] * G), f(rotation[8] * G)], alpha: 1 };
}

const clamp01 = (v: number): number => (v >= 0 ? (v > 1 ? 1 : v) : 0);

/** FUN_004494b0. */
function subdivide(st: Build, a: V3, b: V3, c: V3): void {
  const G = GLASS_SHATTER;
  const P = impact;
  const N = impactNormal;
  const ax = Math.abs;
  const dza = f(P[2] - a[2]), dya = f(P[1] - a[1]), dxa = f(P[0] - a[0]);
  const pa2 = f(dza * dza + dya * dya + dxa * dxa);
  const dzb = f(P[2] - b[2]), dyb = f(P[1] - b[1]), dxb = f(P[0] - b[0]);
  const pb2 = f(dzb * dzb + dyb * dyb + dxb * dxb);
  const pc2 = f((P[2] - c[2]) * (P[2] - c[2]) + (P[1] - c[1]) * (P[1] - c[1]) + (P[0] - c[0]) * (P[0] - c[0]));
  const uz = f(b[2] - a[2]), uy = f(b[1] - a[1]), ux = f(b[0] - a[0]);
  const ab2 = f(uz * uz + uy * uy + ux * ux);
  const wz = f(c[2] - b[2]), wy = f(c[1] - b[1]), wx = f(c[0] - b[0]);
  const bc2 = f(wx * wx + wz * wz + wy * wy);
  const ca2 = f((a[2] - c[2]) * (a[2] - c[2]) + (a[1] - c[1]) * (a[1] - c[1]) + (a[0] - c[0]) * (a[0] - c[0]));
  const vx = f(c[0] - a[0]), vy = f(c[1] - a[1]), vz = f(c[2] - a[2]);

  // Is P inside (a, b, c), projected along the largest |N| component?
  const nx = ax(N[0]), ny = ax(N[1]), nz = ax(N[2]);
  const plane = ny <= nx ? (nz <= nx ? "yz" : "xy") : ny <= nz ? (nz <= nx ? "yz" : "xy") : "xz";
  let ok: boolean;
  let s: number;
  let t: number;
  let inside: boolean;
  if (plane === "yz") {
    const det = f(uz * vy - uy * vz);
    ok = det !== 0;
    s = f((dza * vy - dya * vz) / det);
    if (s < 0 || 1 < s) ok = false;
    if (ax(vy) <= ax(vz)) {
      if (vz === 0) ok = false;
      t = f((dza - s * uz) / vz);
    } else t = f((dya - s * uy) / vy);
    inside = !(t < 0 || 1 < t + s) && ok;
  } else if (plane === "xy") {
    const det = f(uy * vx - ux * vy);
    ok = det !== 0;
    s = f((dya * vx - dxa * vy) / det);
    if (s < 0 || 1 < s) ok = false;
    if (ax(vx) <= ax(vy)) {
      if (vy === 0) ok = false;
      t = f((dya - s * uy) / vy);
    } else t = f((dxa - s * ux) / vx);
    inside = 0 <= t && t + s <= 1 && ok;
  } else {
    const det = f(uz * vx - ux * vz);
    ok = det !== 0;
    s = f((dza * vx - dxa * vz) / det);
    if (s < 0 || 1 < s) ok = false;
    if (ax(vx) <= ax(vz)) {
      if (vz === 0) ok = false;
      t = f((dza - s * uz) / vz);
    } else t = f((dxa - s * ux) / vx);
    inside = !(t < 0 || 1 < t + s) && ok;
  }

  let dca = 0;
  let dab = 0;
  let dbc = 0;
  if (!inside) {
    let mca = pc2 < pa2 ? pc2 : pa2;
    let mab = pb2 < pa2 ? pb2 : pa2;
    let mbc = pc2 < pb2 ? pc2 : pb2;
    // Edge a -> c.
    let lenP = f(Math.sqrt(dza * dza + dya * dya + dxa * dxa));
    let inv = f(1 / lenP);
    const lenV = f(Math.sqrt(vz * vz + vy * vy + vx * vx));
    const invV = f(1 / lenV);
    let ex = f(invV * vx), ey = f(invV * vy), ez = f(invV * vz);
    let proj = f((dxa * inv * ex + dya * inv * ey + dza * inv * ez) * lenP);
    if (0 < proj && proj < lenV) {
      ex = f(proj * ex); ey = f(proj * ey); ez = f(proj * ez);
      const qz = f(ez + a[2] - P[2]), qy = f(ey + a[1] - P[1]), qx = f(ex + a[0] - P[0]);
      const q2 = f(qz * qz + qy * qy + qx * qx);
      if (q2 <= mca) mca = q2;
    }
    dca = clamp01(f(f(Math.sqrt(mca)) * G.distScale));
    // Edge a -> b.
    lenP = f(Math.sqrt(dza * dza + dya * dya + dxa * dxa));
    inv = f(1 / lenP);
    const lenU = f(Math.sqrt(uz * uz + uy * uy + ux * ux));
    const invU = f(1 / lenU);
    ex = f(invU * ux); ey = f(invU * uy); ez = f(invU * uz);
    proj = f((dxa * inv * ex + dya * inv * ey + dza * inv * ez) * lenP);
    if (0 < proj && proj < lenU) {
      ex = f(proj * ex); ey = f(proj * ey); ez = f(proj * ez);
      const qz = f(ez + a[2] - P[2]), qy = f(ey + a[1] - P[1]), qx = f(ex + a[0] - P[0]);
      const q2 = f(qz * qz + qy * qy + qx * qx);
      if (q2 <= mab) mab = q2;
    }
    dab = clamp01(f(f(Math.sqrt(mab)) * G.distScale));
    // Edge b -> c.
    lenP = f(Math.sqrt(dzb * dzb + dyb * dyb + dxb * dxb));
    inv = f(1 / lenP);
    const nzb = f(dzb * inv);
    const lenW = f(Math.sqrt(wz * wz + wy * wy + wx * wx));
    const invW = f(1 / lenW);
    const gx = f(invW * wx);
    let gy = f(invW * wy), gz = f(invW * wz);
    proj = f((dxb * inv * gx + dyb * inv * gy + nzb * gz) * lenP);
    if (0 < proj && proj < lenW) {
      gy = f(proj * gy); gz = f(proj * gz);
      const qz = f(gz + b[2] - P[2]), qy = f(gy + b[1] - P[1]), qx = f(proj * gx + b[0] - P[0]);
      const q2 = f(qz * qz + qy * qy + qx * qx);
      if (q2 <= mbc) mbc = q2;
    }
    dbc = clamp01(f(f(Math.sqrt(mbc)) * G.distScale));
  }

  const lca = f(dca * G.limitRange + G.limitBase); // limits from the distances to ca, ab, bc
  const lab = f(dab * G.limitRange + G.limitBase);
  const lbc = f(dbc * G.limitRange + G.limitBase);
  if (lca * lca < ab2 || lab * lab < bc2 || lbc * lbc < ca2) {
    st.rng.float(); // drawn and not used (0x44a020)
    const cut = (longest: number, x: number, y: number): number => {
      // x <= y: cut from the far end, else from the near one (fractions as in FUN_004494b0).
      let fr: number;
      if (x <= y) {
        fr = f(1 - Math.sqrt(x) / Math.sqrt(longest));
        if (fr <= 0.5) fr = 0.5;
        return fr - st.rng.float() * G.cutJitter;
      }
      fr = f(Math.sqrt(y) / Math.sqrt(longest));
      if (0.5 <= fr) fr = 0.5;
      return st.rng.float() * G.cutJitter + fr;
    };
    const lerp = (from: V3, to: V3, k: number): V3 => [f((to[0] - from[0]) * k + from[0]), f((to[1] - from[1]) * k + from[1]), f((to[2] - from[2]) * k + from[2])];
    if (bc2 <= ab2 && ca2 <= ab2) {
      const m = lerp(a, b, cut(ab2, bc2, ca2));
      subdivide(st, b, c, m);
      subdivide(st, m, c, a);
      return;
    }
    if (ab2 <= bc2 && ca2 <= bc2) {
      const m = lerp(b, c, cut(bc2, ca2, ab2));
      subdivide(st, c, a, m);
      subdivide(st, m, a, b);
      return;
    }
    if (ab2 <= ca2 && bc2 <= ca2) {
      const m = lerp(c, a, cut(ca2, ab2, bc2));
      subdivide(st, a, b, m);
      subdivide(st, m, b, c);
      return;
    }
  }

  // A shard.
  let dmin: number;
  const m2 = dab < dbc ? dab : dbc;
  if (m2 <= dca) dmin = dbc <= dab ? dbc : dab;
  else dmin = dca;
  if (st.shards.length > G.maxShards - 1) return;
  const centre: V3 = [f((a[0] + b[0] + c[0]) * G.third), f((b[1] + a[1] + c[1]) * G.third), f((b[2] + a[2] + c[2]) * G.third)];
  const spin = x87Fistp(x87Mul(x87Mul(x87Add(x87Sub(1, dmin), st.rng.float()), 0.5), G.spinIndexScale));
  let velocity: V3 = [0, 0, 0];
  if (st.speed > 0) {
    const d: V3 = [f(centre[0] - st.from[0]), f(centre[1] - st.from[1]), f(centre[2] - st.from[2])];
    const k = f(st.speed / f(Math.sqrt(d[2] * d[2] + d[1] * d[1] + d[0] * d[0])));
    velocity = [f(d[0] * k), f(d[1] * k), f(d[2] * k)];
  }
  for (let i = 0; i < 3; i++) velocity[i] = f((st.rng.float() * G.scatterRange - G.scatterBias) * G.scatterScale + velocity[i]);
  st.shards.push({ centre, vertices: [[...a], [...b], [...c]], spin, velocity });
}

// --- Update ------------------------------------------------------------------------------

/**
 * LAB_00448c90: one update; returns false when the GlassShatter deletes
 * itself (left reached 0: deleted with its PolyList before any draw, so the
 * drawn alphas are 30/30 .. 2/30).
 */
export function stepGlassShatter(state: GlassShatterState): boolean {
  registered();
  state.alpha = f(state.left * GLASS_SHATTER.alphaStep);
  const g = state.gravity;
  for (const s of state.shards) {
    const m = table[Math.min(s.spin, table.length - 1)];
    const old = s.centre;
    const centre: V3 = [f(s.velocity[0] + old[0]), f(s.velocity[1] + old[1]), f(s.velocity[2] + old[2])];
    s.vertices = s.vertices.map((v) => {
      const dx = v[0] - old[0], dy = v[1] - old[1], dz = v[2] - old[2];
      return [
        f(centre[0] + dx * m[0] + dy * m[1] + dz * m[2]),
        f(centre[1] + dx * m[3] + dy * m[4] + dz * m[5]),
        f(centre[2] + dx * m[6] + dy * m[7] + dz * m[8]),
      ] as V3;
    }) as [V3, V3, V3];
    s.centre = centre;
    s.velocity = [f(g[0] + s.velocity[0]), f(g[1] + s.velocity[1]), f(g[2] + s.velocity[2])];
  }
  state.left -= 1;
  return state.left !== 0;
}

/** The D3D vertex alpha byte of the shards (trunc(alpha x 255), FUN_00498c10). */
export function shardAlphaByte(alpha: number): number {
  return x87Fistp(alpha * 255);
}

/** The D3D vertex colour byte of the shards: trunc(0.7 x 255) = 178. */
export const SHARD_COLOUR_BYTE = x87Fistp(GLASS_SHATTER.colour * 255);
