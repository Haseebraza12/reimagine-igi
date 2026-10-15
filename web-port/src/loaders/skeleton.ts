/**
 * Skinned ("bone", HSEM type 1) models and skeleton posing.
 * Reference implementation: tools/igi_anim.py; notes in docs/characters.md.
 *
 * Bone-model vertex (XTRV, 40 bytes) [observed on all 26 bone models,
 * recovered from the skinning routine FUN_0052be70]:
 *   +0  f32 pos[3]     position in the space of `bone` (IGI units)
 *   +12 f32 normal[3]  normal in the same space
 *   +24 f32 uv[2]
 *   +32 f32 weight
 *   +36 u16 target     for extra influences: the primary vertex they add to
 *                      (unused on primaries)
 *   +38 u16 bone
 * D3DR u32 words: [0] 4, [1] faces, [2] blocks, [3] extra-influence count,
 * [4] primary vertex count; XTRV = primaries followed by extras. Render
 * blocks (DNER) index primaries only. Weights of a primary plus its extras
 * sum to 1 (within 2e-6 on every model).
 *
 * Skinning (FUN_0052be70, called from DrawBoneMesh FUN_0052fc20) with bone
 * world rotation R_b and position T_b (object space):
 *   LOD 0:  out[v] = w_v (R_b p_v + T_b); then every extra e adds
 *           w_e (R_b' p_e + T_b') into out[target_e].
 *   LOD 1+: out[v] = R_b p_v + T_b (weights and extras ignored).
 *   Normals: R_b n_v of the primary bone only, not blended.
 * At most 4000 primaries per model ("Bone model too large").
 *
 * Posing (FUN_004c9f50 -> FUN_004ca120): bone 0 sits at the object origin
 * with the object rotation as its parent; for every bone
 *   world_q = parent_q * local_q   (Hamilton product, quaternions x,y,z,w)
 *   world_T = parent_T + R(parent_q) * TLST
 * There is no inverse bind matrix: vertices are already bone-local. With
 * every local rotation = identity ("bind pose") the extra influences of each
 * soldier vertex land within 1 cm of its primary (0.02 cm for 000_01_1,
 * 003_01_1, 015_01_1): this is the pose the meshes were authored in.
 *
 * Bone-model collision meshes (HSMC/XTVC) store the bone index in the 4th
 * dword of each 16-byte XTVC vertex; positions are bone-local (FUN_004cdcb0,
 * FUN_004cef60) [recovered; values 0..31 / 0..48 observed].
 */
import type { AnimationFile, ClipSample, Skeleton } from "./anim";
import { readMef } from "./mef";

export interface SkinnedBone {
  /** Descriptive label (inferred from geometry and placement). */
  name: string;
  parent: number;
  /** Column-major 4x4: bind pose (identity rotations) in object space, IGI units. */
  bindMatrix: Float32Array;
}

export interface SkinnedModel {
  primaryCount: number;
  extraCount: number;
  /** Bone-space positions for primaries then extras (xyz, IGI units). */
  positions: Float32Array;
  normals: Float32Array;
  uv: Float32Array;
  weights: Float32Array;
  /** Bone per vertex (primaries then extras). */
  vertexBone: Uint16Array;
  /** For each extra influence: the primary vertex it adds to. */
  extraTarget: Uint16Array;
  /** Counter-clockwise triangles over the primaries (from readMef). */
  indices: Uint32Array;
  groups: { start: number; count: number; materialSlot: number }[];
  /** Highest bone index referenced by any vertex. */
  maxBone: number;
  /** Collision meshes in bone space with the bone per vertex. */
  collision: { positions: Float32Array; indices: Uint32Array; vertexBone: Uint16Array }[];
  /** Present when a skeleton was supplied. */
  bones?: SkinnedBone[];
}

function fail(message: string): never {
  throw new Error(`SKIN: ${message}`);
}

interface RawChunk {
  tag: string;
  offset: number;
  size: number;
}

function chunks(bytes: Uint8Array, view: DataView): RawChunk[] {
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (bytes.length < 20 || tag(0) !== "ILFF" || tag(16) !== "OCEM") fail("expected ILFF/OCEM model");
  const align = (v: number, a: number) => Math.ceil(v / a) * a;
  const out: RawChunk[] = [];
  let pos = align(20, view.getUint32(8, true));
  for (;;) {
    if (pos + 16 > bytes.length) fail(`truncated chunk header at 0x${pos.toString(16)}`);
    const size = view.getUint32(pos + 4, true);
    const offset = align(pos + 16, view.getUint32(pos + 8, true));
    const delta = view.getUint32(pos + 12, true);
    if (offset + size > bytes.length) fail(`chunk ${tag(pos)} at 0x${pos.toString(16)} outside the file`);
    out.push({ tag: tag(pos), offset, size });
    if (delta === 0) return out;
    pos += delta;
  }
}

/** Inferred labels; IGI models face +y with +x on the character's right. */
const BODY_33 = [
  "pelvis (root)", "spine", "chest", "upper chest", "neck/head", "head top (end)", "head detail", "head detail (end)",
  "left clavicle", "left upper arm", "left forearm", "left hand", "left fingers", "left fingers (end)",
  "right clavicle", "right upper arm", "right forearm", "right hand", "right fingers", "right fingers (end)",
  "gun chain 1", "gun chain 2", "gun mount",
  "left thigh", "left shin", "left foot", "left toes", "left toes (end)",
  "right thigh", "right shin", "right foot", "right toes", "right toes (end)",
];

function boneName(skeleton: Skeleton, b: number): string {
  if (skeleton.boneCount === 33) return BODY_33[b];
  if (skeleton.boneCount === 56) {
    if (b === 0) return "arms root";
    if (b <= 3) return b === 3 ? "gun body" : `gun chain ${b}`;
    if (b === 4 || b === 27) return `${b === 4 ? "right" : "left"} upper arm`;
    if (b === 5 || b === 28) return `${b === 5 ? "right" : "left"} forearm`;
    if (b === 6 || b === 29) return `${b === 6 ? "right" : "left"} hand`;
    if (b < 27) return `right finger ${Math.floor((b - 7) / 4)} joint ${(b - 7) % 4}`;
    if (b < 50) return `left finger ${Math.floor((b - 30) / 4)} joint ${(b - 30) % 4}`;
    if (b <= 52) return b === 52 ? "magazine" : `magazine chain ${b - 49}`;
    return b === 55 ? "moving part" : `moving-part chain ${b - 52}`;
  }
  return `bone ${b}`;
}

/** Decode a type-1 MEF; pass the skeleton (from readAnimations) to check bone indices and get bind matrices. */
export function readSkinnedModel(mefBuffer: ArrayBuffer, skeleton?: Skeleton): SkinnedModel {
  const bytes = new Uint8Array(mefBuffer);
  const view = new DataView(mefBuffer);
  const mef = readMef(mefBuffer);
  if (mef.modelType !== 1) fail(`model type ${mef.modelType} is not a bone model`);
  const list = chunks(bytes, view);
  const one = (tag: string) => {
    const found = list.filter((c) => c.tag === tag);
    if (found.length !== 1) fail(`expected one ${tag} chunk, found ${found.length}`);
    return found[0];
  };
  const d3dr = one("D3DR");
  if (d3dr.size < 20) fail(`D3DR at 0x${d3dr.offset.toString(16)} too short`);
  const extraCount = view.getUint32(d3dr.offset + 12, true);
  const primaryCount = view.getUint32(d3dr.offset + 16, true);
  const xtrv = one("XTRV");
  const n = primaryCount + extraCount;
  if (xtrv.size !== 40 * n) fail(`XTRV at 0x${xtrv.offset.toString(16)} holds ${xtrv.size / 40} vertices, D3DR declares ${primaryCount} + ${extraCount}`);
  if (primaryCount > 4000) fail(`${primaryCount} primary vertices exceed the exe's 4000 limit`);

  const positions = new Float32Array(3 * n);
  const normals = new Float32Array(3 * n);
  const uv = new Float32Array(2 * n);
  const weights = new Float32Array(n);
  const vertexBone = new Uint16Array(n);
  const extraTarget = new Uint16Array(extraCount);
  const sums = new Float64Array(primaryCount);
  let maxBone = 0;
  for (let v = 0; v < n; v++) {
    const at = xtrv.offset + 40 * v;
    for (let c = 0; c < 3; c++) {
      positions[3 * v + c] = view.getFloat32(at + 4 * c, true);
      normals[3 * v + c] = view.getFloat32(at + 12 + 4 * c, true);
    }
    uv[2 * v] = view.getFloat32(at + 24, true);
    uv[2 * v + 1] = view.getFloat32(at + 28, true);
    weights[v] = view.getFloat32(at + 32, true);
    const target = view.getUint16(at + 36, true);
    const bone = view.getUint16(at + 38, true);
    vertexBone[v] = bone;
    if (bone > maxBone) maxBone = bone;
    if (skeleton && bone >= skeleton.boneCount) fail(`vertex ${v} at 0x${at.toString(16)} uses bone ${bone} of ${skeleton.boneCount}`);
    if (v < primaryCount) sums[v] += weights[v];
    else {
      if (target >= primaryCount) fail(`extra influence ${v} at 0x${at.toString(16)} targets vertex ${target} >= ${primaryCount}`);
      extraTarget[v - primaryCount] = target;
      sums[target] += weights[v];
    }
  }
  for (let v = 0; v < primaryCount; v++) {
    if (Math.abs(sums[v] - 1) > 1e-4) fail(`influence weights of vertex ${v} sum to ${sums[v]}`);
  }
  for (const i of mef.indices) if (i >= primaryCount) fail(`render index ${i} is not a primary vertex`);

  const xtvc = list.filter((c) => c.tag === "XTVC");
  if (xtvc.length !== mef.collision.length) fail("collision chunks do not match readMef");
  const collision = mef.collision.map((mesh, k) => {
    const count = mesh.positions.length / 3;
    if (xtvc[k].size !== 16 * count) fail(`XTVC ${k} size mismatch`);
    const vb = new Uint16Array(count);
    for (let v = 0; v < count; v++) {
      const b = view.getUint32(xtvc[k].offset + 16 * v + 12, true);
      if (b > 0xffff || (skeleton && b >= skeleton.boneCount)) fail(`collision vertex ${v} uses bone ${b}`);
      vb[v] = b;
    }
    return { positions: mesh.positions, indices: mesh.indices, vertexBone: vb };
  });

  const model: SkinnedModel = {
    primaryCount,
    extraCount,
    positions,
    normals,
    uv,
    weights,
    vertexBone,
    extraTarget,
    indices: mef.indices,
    groups: mef.groups,
    maxBone,
    collision,
  };
  if (skeleton) {
    const world = poseSkeleton(skeleton, null);
    model.bones = Array.from({ length: skeleton.boneCount }, (_, b) => ({
      name: boneName(skeleton, b),
      parent: skeleton.parents[b],
      bindMatrix: world.slice(16 * b, 16 * b + 16),
    }));
  }
  return model;
}

/**
 * World (object-space) matrices of every bone, column-major 4x4 per bone,
 * IGI units, for local rotations (x, y, z, w per bone; null = bind pose).
 * `rootRotation` is the object's rotation (quaternion), identity by default;
 * the root bone sits at the origin (add the clip's root translation and the
 * object position yourself).
 */
export function poseSkeleton(
  skeleton: Skeleton,
  rotations: ArrayLike<number> | null,
  rootRotation: ArrayLike<number> = [0, 0, 0, 1],
  out = new Float32Array(16 * skeleton.boneCount),
): Float32Array {
  const n = skeleton.boneCount;
  const wq = new Float64Array(4 * n);
  const wt = new Float64Array(3 * n);
  for (let b = 0; b < n; b++) {
    const p = skeleton.parents[b];
    const px = p < 0 ? rootRotation[0] : wq[4 * p];
    const py = p < 0 ? rootRotation[1] : wq[4 * p + 1];
    const pz = p < 0 ? rootRotation[2] : wq[4 * p + 2];
    const pw = p < 0 ? rootRotation[3] : wq[4 * p + 3];
    const lx = rotations ? rotations[4 * b] : 0;
    const ly = rotations ? rotations[4 * b + 1] : 0;
    const lz = rotations ? rotations[4 * b + 2] : 0;
    const lw = rotations ? rotations[4 * b + 3] : 1;
    // world = parent * local
    wq[4 * b] = pw * lx + px * lw + py * lz - pz * ly;
    wq[4 * b + 1] = pw * ly - px * lz + py * lw + pz * lx;
    wq[4 * b + 2] = pw * lz + px * ly - py * lx + pz * lw;
    wq[4 * b + 3] = pw * lw - px * lx - py * ly - pz * lz;
    const ox = skeleton.offsets[3 * b];
    const oy = skeleton.offsets[3 * b + 1];
    const oz = skeleton.offsets[3 * b + 2];
    // R(parent) * offset
    const [r0, r1, r2, r3, r4, r5, r6, r7, r8] = rot(px, py, pz, pw);
    const bx = p < 0 ? 0 : wt[3 * p];
    const by = p < 0 ? 0 : wt[3 * p + 1];
    const bz = p < 0 ? 0 : wt[3 * p + 2];
    wt[3 * b] = bx + r0 * ox + r1 * oy + r2 * oz;
    wt[3 * b + 1] = by + r3 * ox + r4 * oy + r5 * oz;
    wt[3 * b + 2] = bz + r6 * ox + r7 * oy + r8 * oz;
    const m = rot(wq[4 * b], wq[4 * b + 1], wq[4 * b + 2], wq[4 * b + 3]);
    const o = 16 * b;
    out[o] = m[0]; out[o + 1] = m[3]; out[o + 2] = m[6]; out[o + 3] = 0;
    out[o + 4] = m[1]; out[o + 5] = m[4]; out[o + 6] = m[7]; out[o + 7] = 0;
    out[o + 8] = m[2]; out[o + 9] = m[5]; out[o + 10] = m[8]; out[o + 11] = 0;
    out[o + 12] = wt[3 * b]; out[o + 13] = wt[3 * b + 1]; out[o + 14] = wt[3 * b + 2]; out[o + 15] = 1;
  }
  return out;
}

/** Row-major rotation matrix of (x, y, z, w) as in FUN_004ca120 (column vectors). */
function rot(x: number, y: number, z: number, w: number): number[] {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

/** Convenience: pose a skeleton from a sampled clip (root translation not applied). */
export function poseFromSample(anim: AnimationFile, sample: ClipSample, rootRotation?: ArrayLike<number>): Float32Array {
  return poseSkeleton(anim.skeleton, sample.rotations, rootRotation);
}

/**
 * CPU skinning exactly as FUN_0052be70: returns primary positions and
 * normals in object space (IGI units). `lod0` = weighted with extra
 * influences (the exe's LOD 0, also used for the first-person arms);
 * false = rigid (other LODs).
 */
export function poseVertices(
  model: SkinnedModel,
  boneMatrices: Float32Array,
  lod0 = true,
  out?: { positions: Float32Array; normals: Float32Array },
): { positions: Float32Array; normals: Float32Array } {
  const np = model.primaryCount;
  const positions = out?.positions ?? new Float32Array(3 * np);
  const normals = out?.normals ?? new Float32Array(3 * np);
  const P = model.positions;
  const N = model.normals;
  const apply = (v: number, w: number, accumulate: number) => {
    const m = 16 * model.vertexBone[v];
    if (m + 16 > boneMatrices.length) fail(`vertex ${v} uses bone ${model.vertexBone[v]} beyond the pose`);
    const x = P[3 * v], y = P[3 * v + 1], z = P[3 * v + 2];
    const t = accumulate < 0 ? v : accumulate;
    const ox = boneMatrices[m] * x + boneMatrices[m + 4] * y + boneMatrices[m + 8] * z + boneMatrices[m + 12];
    const oy = boneMatrices[m + 1] * x + boneMatrices[m + 5] * y + boneMatrices[m + 9] * z + boneMatrices[m + 13];
    const oz = boneMatrices[m + 2] * x + boneMatrices[m + 6] * y + boneMatrices[m + 10] * z + boneMatrices[m + 14];
    if (accumulate < 0) {
      positions[3 * t] = w * ox;
      positions[3 * t + 1] = w * oy;
      positions[3 * t + 2] = w * oz;
      const nx = N[3 * v], ny = N[3 * v + 1], nz = N[3 * v + 2];
      normals[3 * t] = boneMatrices[m] * nx + boneMatrices[m + 4] * ny + boneMatrices[m + 8] * nz;
      normals[3 * t + 1] = boneMatrices[m + 1] * nx + boneMatrices[m + 5] * ny + boneMatrices[m + 9] * nz;
      normals[3 * t + 2] = boneMatrices[m + 2] * nx + boneMatrices[m + 6] * ny + boneMatrices[m + 10] * nz;
    } else {
      positions[3 * t] += w * ox;
      positions[3 * t + 1] += w * oy;
      positions[3 * t + 2] += w * oz;
    }
  };
  for (let v = 0; v < np; v++) apply(v, lod0 ? model.weights[v] : 1, -1);
  if (lod0) for (let e = 0; e < model.extraCount; e++) apply(np + e, model.weights[np + e], model.extraTarget[e]);
  return { positions, normals };
}

/**
 * GPU-skinning buffers (e.g. three.js SkinnedMesh with `bones[b]` posed by
 * poseSkeleton and boneInverses = inverse(bindMatrix)): bind-pose positions
 * of the primaries plus up to `maxInfluences` (bone, weight) pairs per
 * vertex, keeping the heaviest and renormalising. Approximate where a vertex
 * has more influences (up to 6 observed) or where its influences disagree
 * in the bind pose (< 1 cm on soldiers, up to 18 cm at the arms' shoulders);
 * poseVertices is exact.
 */
export function skinBuffers(
  model: SkinnedModel,
  maxInfluences = 4,
): { bindPositions: Float32Array; bindNormals: Float32Array; skinIndex: Uint16Array; skinWeight: Float32Array } {
  const bones = model.bones ?? fail("skinBuffers needs a model read with its skeleton");
  const bind = new Float32Array(16 * bones.length);
  bones.forEach((b, i) => bind.set(b.bindMatrix, 16 * i));
  const { positions, normals } = poseVertices(model, bind, false);
  const np = model.primaryCount;
  const lists: { bone: number; weight: number }[][] = [];
  for (let v = 0; v < np; v++) lists.push([{ bone: model.vertexBone[v], weight: model.weights[v] }]);
  for (let e = 0; e < model.extraCount; e++) {
    const v = np + e;
    const list = lists[model.extraTarget[e]];
    const same = list.find((x) => x.bone === model.vertexBone[v]);
    if (same) same.weight += model.weights[v];
    else list.push({ bone: model.vertexBone[v], weight: model.weights[v] });
  }
  const skinIndex = new Uint16Array(maxInfluences * np);
  const skinWeight = new Float32Array(maxInfluences * np);
  for (let v = 0; v < np; v++) {
    const list = lists[v].sort((a, b) => b.weight - a.weight).slice(0, maxInfluences);
    const total = list.reduce((s, x) => s + x.weight, 0) || 1;
    list.forEach((x, k) => {
      skinIndex[maxInfluences * v + k] = x.bone;
      skinWeight[maxInfluences * v + k] = x.weight / total;
    });
  }
  return { bindPositions: positions, bindNormals: normals, skinIndex, skinWeight };
}
