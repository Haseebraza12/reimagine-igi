/**
 * Collision meshes and surface materials, as igi.exe uses them for bullets,
 * line of sight, character movement and footsteps.
 *
 * Evidence: docs/collision.md; reference implementation and 51 self-checks (byte-level
 * ones) against the analysed igi.exe: tools/igi_collision.py.
 * Labels: observed (measured over the data), recovered (read from igi.exe
 * code, address named), inferred (not proven by the traced code).
 *
 * `.mef` collision chunks (all 601 model files decode; every `_1` model has
 * them, no LOD `_2+` model does)                                  [observed]
 *   HSMC  2 x 32 bytes {u32 faces, vertices, surfaces, spheres, 4 x u32 0}.
 *         The loader (0x53025b) stores ECFC/XTVC/TAMC/HPSC pointers at
 *         +0x10/+0x14/+0x18/+0x1c of each header; set k = model+0x2c + 32k.
 *   XTVC  16 bytes: f32 x, y, z, u32 bone (bone models: bone-local position
 *         of that bone; 0 on rigid models).
 *   ECFC  8 bytes: u16 a, b, c, u16 surface (TAMC index). Same winding as the
 *         render mesh (38,726 / 38,726 matched faces); outward normal
 *         = (c - a) x (b - a) (FUN_004b7a60)                       [recovered]
 *   TAMC  12 bytes: f32 transparency, i16 portal, i16 texture slot,
 *         u16 game material, u16 uninitialised.
 *           portal >= 0: the face is that portal's polygon (matches the
 *             model's TROP/XVTP records); every traced query skips it
 *             (0x4b84c0, 0x4ba07e)                                 [recovered]
 *           slot >= 0: the faces are exactly the render triangles of that
 *             texture slot (1028 of 1032 slots identical)          [observed]
 *           material: material.qvm SetActiveMaterial index; 0xffff = none,
 *             which rays treat as material 1 "Ground" (0x4b8eea) and the
 *             line-of-sight test as opaque (0x4ba728)              [recovered]
 *           transparency: 1 on collision-only faces and on set 1, 0 on
 *             textured faces, 0.2-0.5 on 4 glow/flame textures; no traced
 *             runtime reader (lightmap-baker transparency)         [inferred]
 *   HPSC  24 bytes: f32 centre xyz, f32 radius, u16 first face, u16 face
 *         count, u16 first child, u16 next sibling. A binary bounding-sphere
 *         tree stored first-child / next-sibling, node 0 = root, 2n - 1
 *         nodes, one face per leaf (all 246 models validated)   [observed]
 *
 * The two sets                                                   [recovered]
 *   set 0 ("bullet" set): visible geometry + collision-only faces + portals,
 *         per-face game material. Read by every ray built with FUN_004c24c0
 *         (bullets FUN_00479e30, query word 5 = 0 at 0x4c2734) and by the
 *         line-of-sight test (method 8, FUN_004b9810, always set 0).
 *   set 1 ("character" set): a simplified hull with material 21
 *         "HumanCollision", drawn about 0.2 m outside the walls (wall-offset
 *         mode 800-850 units over 2,687 faces) and not raised vertically
 *         [observed]. Read by the wall sweep (FUN_004606b0) and the ground
 *         probe (FUN_00460fd0), both passing 1 to FUN_004c3d40. Models
 *         whose set 1 is empty (glass panes, characters, small props) do not
 *         block characters at all.
 *
 * Characters are not spheres or capsules: the sweep casts three rays (zero
 * radius) at 0.1 / 0.4 / 1.8 m above the feet (crouched 0.1 / 0.2 / 1.3 m),
 * each extended by 10.24 units, against set 1; the hull offset supplies the
 * body width. No face is alpha-tested (FUN_0051d680 returns 0).  [recovered]
 *
 * Terrain: rays report game material 1 (Ground) on the side they hit from
 * (FUN_004c3520 / FUN_004c2a30). The ground probe's column query instead
 * looks the material up: TextureModifier masks (bilinear >= 0.3, innermost
 * first) -> terrain material -> CreateTerrainMaterial argument 1
 * (FUN_004c1a30, handler 0x4bc890). Level 1: every terrain material's
 * argument 1 is 1, so all terrain is Ground.                     [recovered]
 *
 * Coordinates stay in IGI units (4096 = 1 m, z up), model space for meshes.
 */
import type { Vec3 } from "../contracts";
import { isQvmSymbol, readQvmCallTree, type QvmValue } from "./qvm";
import { readTerrainBit } from "./terrain-look";
import { TERRAIN_ROOT_HALF } from "./terrain-octree";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** HSMC set index used by bullets, line of sight and material lookups. */
export const COLLISION_SET_BULLET = 0;
/** HSMC set index used by the character wall sweep and ground probe. */
export const COLLISION_SET_CHARACTER = 1;
/** TAMC material value meaning "no material". */
export const NO_MATERIAL = -1;
/** Material index rays report for untagged faces (world table +0xd40 = entry 1, FUN_004b7a60). */
export const UNTAGGED_RAY_MATERIAL = 1;
/** Index of material.qvm "HumanCollision", the material of every set-1 hull [observed]. */
export const HUMAN_COLLISION_MATERIAL = 21;

/** One TAMC record. */
export interface CollisionSurface {
  /** f32 at +0: 1 on collision-only faces, 0 on textured faces; not read by the ray code [inferred meaning]. */
  transparency: number;
  /** i16 at +4: portal id (>= 0 = portal polygon, never solid), else -1. */
  portal: number;
  /** i16 at +6: model texture slot whose render triangles these faces duplicate, else -1. */
  textureSlot: number;
  /** u16 at +8: game material index (material.qvm SetActiveMaterial), or NO_MATERIAL. */
  material: number;
}

/** One HPSC node. */
export interface CollisionSphere {
  center: Vec3;
  radius: number;
  /** First ECFC face of a leaf (leaves own exactly `faceCount` consecutive faces). */
  firstFace: number;
  /** 0 for inner nodes. */
  faceCount: number;
  /** First child node index, 0 = none (node 0 is the root, so 0 never names a child). */
  firstChild: number;
  /** Next sibling node index, 0 = none. */
  nextSibling: number;
}

export interface CollisionSet {
  /** xyz per vertex, IGI model units (bone-local for bone models). */
  positions: Float32Array;
  /** XTVC dword 3: bone index (bone models), 0 otherwise. */
  vertexBones: Uint32Array;
  /** a, b, c per face, as stored (Direct3D clockwise front). */
  faces: Uint16Array;
  /** ECFC u16 3: TAMC index per face. */
  faceSurface: Uint16Array;
  surfaces: CollisionSurface[];
  spheres: CollisionSphere[];
}

export interface CollisionModel {
  /** HSEM model type: 0 rigid, 1 bone, 3 lightmapped. */
  modelType: number;
  /** [set 0 (bullets, sight, materials), set 1 (character hull)]; a set may have no faces. */
  sets: [CollisionSet, CollisionSet];
}

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new Error(`collision-mesh: ${message}`);
}

const hex = (n: number) => `0x${n.toString(16)}`;

interface Chunk {
  tag: string;
  offset: number;
  size: number;
}

function alignUp(value: number, alignment: number, where: number): number {
  if (alignment < 1 || alignment > 4096 || (alignment & (alignment - 1)) !== 0) {
    fail(`unsupported alignment ${alignment} at ${hex(where)}`);
  }
  return Math.ceil(value / alignment) * alignment;
}

function readChunks(bytes: Uint8Array, view: DataView): Chunk[] {
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (bytes.length < 20 || tag(0) !== "ILFF" || tag(16) !== "OCEM") fail("expected an ILFF/OCEM model");
  if (view.getUint32(4, true) !== bytes.length) fail("root size does not match the file length");
  const out: Chunk[] = [];
  let pos = alignUp(20, view.getUint32(8, true), 8);
  for (;;) {
    if (pos + 16 > bytes.length) fail(`truncated chunk header at ${hex(pos)}`);
    const size = view.getUint32(pos + 4, true);
    const offset = alignUp(pos + 16, view.getUint32(pos + 8, true), pos + 8);
    const delta = view.getUint32(pos + 12, true);
    if (offset + size > bytes.length) fail(`chunk ${tag(pos)} at ${hex(pos)} runs past the file`);
    out.push({ tag: tag(pos), offset, size });
    if (delta === 0) {
      if (offset + size !== bytes.length) fail(`bytes after the final chunk ${tag(pos)} at ${hex(pos)}`);
      return out;
    }
    if (pos + delta < offset + size) fail(`chunk ${tag(pos)} at ${hex(pos)} overlaps its successor`);
    pos += delta;
  }
}

/**
 * Decode the HSMC collision sets of a `.mef` model. Returns null when the
 * model has none (every LOD `_2+` model). Validates every count, index and
 * the sphere tree; errors name the file offset.
 */
export function readCollisionModel(buffer: ArrayBuffer, materialCount = 32): CollisionModel | null {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const chunks = readChunks(bytes, view);
  const hsem = chunks.filter((c) => c.tag === "HSEM");
  if (hsem.length !== 1 || hsem[0].size < 36) fail("missing HSEM");
  const modelType = view.getUint32(hsem[0].offset + 32, true);
  const h = chunks.findIndex((c) => c.tag === "HSMC");
  if (h < 0) {
    const stray = chunks.find((c) => c.tag === "XTVC" || c.tag === "ECFC" || c.tag === "TAMC" || c.tag === "HPSC");
    if (stray) fail(`${stray.tag} at ${hex(stray.offset)} without HSMC`);
    return null;
  }
  const order = ["HSMC", "XTVC", "ECFC", "TAMC", "HPSC", "XTVC", "ECFC", "TAMC", "HPSC"];
  order.forEach((tag, i) => {
    const c = chunks[h + i];
    if (!c || c.tag !== tag) fail(`expected ${tag} as collision chunk ${i} after HSMC at ${hex(chunks[h].offset)}`);
  });
  const hsmc = chunks[h];
  if (hsmc.size !== 64) fail(`HSMC at ${hex(hsmc.offset)} is ${hsmc.size} bytes, expected 2 x 32`);
  const sets: CollisionSet[] = [];
  for (let k = 0; k < 2; k++) {
    const at = hsmc.offset + 32 * k;
    const [nf, nv, nm, ns] = [0, 1, 2, 3].map((i) => view.getUint32(at + 4 * i, true));
    for (let i = 4; i < 8; i++) {
      if (view.getUint32(at + 4 * i, true) !== 0) fail(`HSMC set ${k} header at ${hex(at)} has non-zero runtime words`);
    }
    const [xt, ec, tm, hp] = [1, 2, 3, 4].map((i) => chunks[h + 4 * k + i]);
    const sizes: Array<[Chunk, number, number]> = [[xt, nv, 16], [ec, nf, 8], [tm, nm, 12], [hp, ns, 24]];
    for (const [c, n, stride] of sizes) {
      if (c.size !== n * stride) fail(`set ${k} ${c.tag} at ${hex(c.offset)} is ${c.size} bytes, header says ${n} x ${stride}`);
    }
    const positions = new Float32Array(nv * 3);
    const vertexBones = new Uint32Array(nv);
    for (let i = 0; i < nv; i++) {
      const o = xt.offset + 16 * i;
      for (let c = 0; c < 3; c++) {
        const v = view.getFloat32(o + 4 * c, true);
        if (!Number.isFinite(v)) fail(`set ${k} vertex ${i} at ${hex(o)} is not finite`);
        positions[i * 3 + c] = v;
      }
      vertexBones[i] = view.getUint32(o + 12, true);
      if (modelType !== 1 && vertexBones[i] !== 0) fail(`set ${k} vertex ${i} at ${hex(o)} has a bone on a non-bone model`);
    }
    const faces = new Uint16Array(nf * 3);
    const faceSurface = new Uint16Array(nf);
    for (let i = 0; i < nf; i++) {
      const o = ec.offset + 8 * i;
      for (let c = 0; c < 3; c++) {
        faces[i * 3 + c] = view.getUint16(o + 2 * c, true);
        if (faces[i * 3 + c] >= nv) fail(`set ${k} face ${i} at ${hex(o)} indexes vertex ${faces[i * 3 + c]} of ${nv}`);
      }
      faceSurface[i] = view.getUint16(o + 6, true);
      if (faceSurface[i] >= nm) fail(`set ${k} face ${i} at ${hex(o)} indexes surface ${faceSurface[i]} of ${nm}`);
    }
    const surfaces: CollisionSurface[] = [];
    for (let i = 0; i < nm; i++) {
      const o = tm.offset + 12 * i;
      const raw = view.getUint16(o + 8, true);
      const surface: CollisionSurface = {
        transparency: view.getFloat32(o, true),
        portal: view.getInt16(o + 4, true),
        textureSlot: view.getInt16(o + 6, true),
        material: raw === 0xffff ? NO_MATERIAL : raw,
      };
      if (surface.portal < -1 || surface.textureSlot < -1 || surface.material >= materialCount) {
        fail(`set ${k} TAMC ${i} at ${hex(o)} out of range`);
      }
      surfaces.push(surface);
    }
    if (ns !== (nf > 0 ? 2 * nf - 1 : 0)) fail(`set ${k} HPSC at ${hex(hp.offset)} has ${ns} nodes for ${nf} faces`);
    const spheres: CollisionSphere[] = [];
    for (let i = 0; i < ns; i++) {
      const o = hp.offset + 24 * i;
      spheres.push({
        center: [view.getFloat32(o, true), view.getFloat32(o + 4, true), view.getFloat32(o + 8, true)],
        radius: view.getFloat32(o + 12, true),
        firstFace: view.getUint16(o + 16, true),
        faceCount: view.getUint16(o + 18, true),
        firstChild: view.getUint16(o + 20, true),
        nextSibling: view.getUint16(o + 22, true),
      });
    }
    const set: CollisionSet = { positions, vertexBones, faces, faceSurface, surfaces, spheres };
    validateSphereTree(set, `set ${k} HPSC at ${hex(hp.offset)}`);
    sets.push(set);
  }
  return { modelType, sets: [sets[0], sets[1]] };
}

/**
 * Check the HPSC tree: every node reached once from the root through
 * first-child / next-sibling links, inner nodes have exactly two children,
 * leaves cover every face once, and each sphere contains its faces' vertices
 * (to 1 unit; the data's worst case is 0.007 units).
 */
export function validateSphereTree(set: CollisionSet, where = "HPSC"): void {
  const { spheres, faces, positions } = set;
  if (spheres.length === 0) return;
  if (spheres[0].nextSibling !== 0) fail(`${where}: root has a sibling`);
  const seen = new Uint8Array(spheres.length);
  const covered = new Uint8Array(faces.length / 3);
  const visit = (index: number, depth: number): number[] => {
    if (depth > 4096 || seen[index]) fail(`${where}: node ${index} reached twice`);
    seen[index] = 1;
    const node = spheres[index];
    const owned: number[] = [];
    if (node.faceCount > 0) {
      if (node.firstChild !== 0) fail(`${where}: leaf ${index} has children`);
      if (node.firstFace + node.faceCount > covered.length) fail(`${where}: leaf ${index} faces outside ECFC`);
      for (let f = node.firstFace; f < node.firstFace + node.faceCount; f++) {
        if (covered[f]++) fail(`${where}: face ${f} in two leaves`);
        owned.push(f);
      }
    } else {
      const kids: number[] = [];
      for (let c = node.firstChild; c !== 0; c = spheres[c].nextSibling) {
        if (c >= spheres.length || kids.length > 2) fail(`${where}: node ${index} has bad child links`);
        kids.push(c);
      }
      if (kids.length !== 2) fail(`${where}: inner node ${index} has ${kids.length} children`);
      for (const c of kids) owned.push(...visit(c, depth + 1));
    }
    const [cx, cy, cz] = node.center;
    for (const f of owned) {
      for (let j = 0; j < 3; j++) {
        const v = faces[f * 3 + j] * 3;
        const d = Math.hypot(positions[v] - cx, positions[v + 1] - cy, positions[v + 2] - cz);
        if (d > node.radius + 1) fail(`${where}: node ${index} misses a vertex of face ${f} by ${(d - node.radius).toFixed(2)} units`);
      }
    }
    return owned;
  };
  visit(0, 0);
  if (seen.some((s) => s === 0)) fail(`${where}: unreachable nodes`);
  if (covered.some((c) => c !== 1)) fail(`${where}: leaves do not cover every face`);
}

// ---------------------------------------------------------------------------
// Ray query against one set (mirrors FUN_004b7a60)
// ---------------------------------------------------------------------------

export interface CollisionRayHit {
  /** Fraction along from -> to, 0..1. */
  t: number;
  /** Distance from `from`, IGI units. */
  distance: number;
  point: Vec3;
  /** Unit outward normal (c - a) x (b - a). */
  normal: Vec3;
  face: number;
  surface: CollisionSurface;
  /** True when the ray travels against the outward normal (result word 0x13, "entry"). */
  front: boolean;
  /** Material the game reports: surface material, or UNTAGGED_RAY_MATERIAL when untagged. */
  material: number;
}

export interface CollisionRayOptions {
  /** Also test portal faces (query word 6; no traced caller sets it). Default false. */
  includePortals?: boolean;
}

/** Hit ordering within the 0.1-unit tie window (FUN_004b7a60): front faces win over back faces. */
export const HIT_TIE_WINDOW = 0.1;

/**
 * Should `candidate` replace `best`? Strictly closer by more than 0.1 units
 * wins; within 0.1 units a front-face hit beats a back-face hit. [recovered]
 */
export function hitReplaces(candidate: { distance: number; front: boolean }, best: { distance: number; front: boolean } | null): boolean {
  if (!best) return true;
  const w = HIT_TIE_WINDOW;
  if (candidate.distance < best.distance - w) return true;
  if (candidate.distance >= best.distance + w) return false;
  if (candidate.distance < best.distance) return candidate.front || !best.front;
  return candidate.front && !best.front;
}

/** Game material a ray hit on `surface` reports. */
export function rayMaterial(surface: CollisionSurface): number {
  return surface.material === NO_MATERIAL ? UNTAGGED_RAY_MATERIAL : surface.material;
}

/** True when the face takes part in ray, sweep and sight queries (not a portal polygon). */
export function isSolidSurface(surface: CollisionSurface): boolean {
  return surface.portal < 0;
}

/** Outward face normal (c - a) x (b - a), normalised; [0, 0, 0] for degenerate faces. */
export function faceNormal(set: CollisionSet, face: number): Vec3 {
  const p = set.positions;
  const a = set.faces[face * 3] * 3;
  const b = set.faces[face * 3 + 1] * 3;
  const c = set.faces[face * 3 + 2] * 3;
  const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
  const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
  const n: Vec3 = [e2[1] * e1[2] - e2[2] * e1[1], e2[2] * e1[0] - e2[0] * e1[2], e2[0] * e1[1] - e2[1] * e1[0]];
  const len = Math.hypot(n[0], n[1], n[2]);
  return len > 0 ? [n[0] / len, n[1] / len, n[2] / len] : [0, 0, 0];
}

/**
 * Nearest hit of the segment from -> to (model space) on a collision set.
 * Walks the sphere tree (line-to-centre distance <= radius and box overlap,
 * as FUN_004b7a60 does), tests each face with t in [0, 1] and barycentric
 * coordinates in [0, 1], and orders hits with hitReplaces. No alpha test.
 */
export function raycastCollisionSet(set: CollisionSet, from: Vec3, to: Vec3, options: CollisionRayOptions = {}): CollisionRayHit | null {
  if (set.spheres.length === 0) return null;
  const p = set.positions;
  const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  if (len2 === 0) return null;
  const len = Math.sqrt(len2);
  const lo = [0, 1, 2].map((i) => Math.min(from[i], to[i]) - HIT_TIE_WINDOW);
  const hi = [0, 1, 2].map((i) => Math.max(from[i], to[i]) + HIT_TIE_WINDOW);
  let best: CollisionRayHit | null = null;
  const sphereHit = (s: CollisionSphere): boolean => {
    const v = [s.center[0] - from[0], s.center[1] - from[1], s.center[2] - from[2]];
    const along = v[0] * d[0] + v[1] * d[1] + v[2] * d[2];
    if (v[0] * v[0] + v[1] * v[1] + v[2] * v[2] - (along * along) / len2 > s.radius * s.radius) return false;
    for (let i = 0; i < 3; i++) {
      if (s.center[i] + s.radius < lo[i] || s.center[i] - s.radius > hi[i]) return false;
    }
    return true;
  };
  const testFace = (f: number) => {
    const surface = set.surfaces[set.faceSurface[f]];
    if (surface.portal !== -1 && !options.includePortals) return;
    const a = set.faces[f * 3] * 3;
    const b = set.faces[f * 3 + 1] * 3;
    const c = set.faces[f * 3 + 2] * 3;
    const e1 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const e2 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const n = [e2[1] * e1[2] - e2[2] * e1[1], e2[2] * e1[0] - e2[0] * e1[2], e2[0] * e1[1] - e2[1] * e1[0]];
    const denom = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
    if (denom === 0) return;
    const t = (n[0] * (p[a] - from[0]) + n[1] * (p[a + 1] - from[1]) + n[2] * (p[a + 2] - from[2])) / denom;
    if (t < 0 || t > 1) return;
    const q: Vec3 = [from[0] + t * d[0], from[1] + t * d[1], from[2] + t * d[2]];
    // Barycentric (u along e1, v along e2) by Cramer's rule on the dominant plane.
    const w = [q[0] - p[a], q[1] - p[a + 1], q[2] - p[a + 2]];
    const ax = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2]) ? 0 : Math.abs(n[1]) >= Math.abs(n[2]) ? 1 : 2;
    const [i, j] = ax === 0 ? [1, 2] : ax === 1 ? [0, 2] : [0, 1];
    const det = e1[i] * e2[j] - e1[j] * e2[i];
    if (det === 0) return;
    const u = (w[i] * e2[j] - w[j] * e2[i]) / det;
    const v = (e1[i] * w[j] - e1[j] * w[i]) / det;
    if (u < 0 || v < 0 || u + v > 1) return;
    const front = denom < 0;
    const candidate = { distance: t * len, front };
    if (!hitReplaces(candidate, best)) return;
    const nl = Math.hypot(n[0], n[1], n[2]);
    best = {
      t,
      distance: candidate.distance,
      point: q,
      normal: [n[0] / nl, n[1] / nl, n[2] / nl],
      face: f,
      surface,
      front,
      material: rayMaterial(surface),
    };
  };
  const stack = [0];
  while (stack.length > 0) {
    const index = stack.pop()!;
    const node = set.spheres[index];
    if (index !== 0 && !sphereHit(node)) continue; // the root is not tested (the object sphere was)
    for (let f = node.firstFace; f < node.firstFace + node.faceCount; f++) testFace(f);
    for (let c = node.firstChild; c !== 0; c = set.spheres[c].nextSibling) stack.push(c);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Movement rules (FUN_004600f0 / FUN_004606b0 / FUN_00460fd0)   [recovered]
// ---------------------------------------------------------------------------

/** Character wall sweep: three zero-radius rays against HSMC set 1. */
export const CHARACTER_SWEEP = {
  /** Collision set queried (push 1 at 0x46097d). */
  set: COLLISION_SET_CHARACTER,
  /** Probe heights above the feet, IGI units (0x531418, 0x531478, 0x531960). */
  heightsStanding: [409.6, 1638.4, 7372.8] as const,
  /** Crouched (human+0x33d set): 0x531418, 0x531970, 0x531968. */
  heightsCrouched: [409.6, 819.2, 5324.8] as const,
  /** Rays run from the old position, length = move + skin; slides push out by the skin (0x531978). */
  skin: 10.24,
  /** A hit whose |normal z| < 0.1 is a wall (0x5313c8): its normal is flattened to xy. */
  wallMaxAbsNormalZ: 0.1,
  /** Lowest-probe hit with normal z > 0.9999 while airborne lifts the body onto it (0x53195c). */
  stepFloorMinNormalZ: 0.9999,
  /** While grounded only the upper two probes block (the step / ground snap handles the rest). */
  groundedIgnoresLowestProbe: true,
  /** Slide iterations before the move is cancelled (FUN_004606b0 loop count > 10). */
  maxIterations: 10,
} as const;

/** Ground probe: rays straight down/up against set 1 (and terrain). */
export const GROUND_PROBE = {
  set: COLLISION_SET_CHARACTER,
  /** Ray start above the feet: standing / crouched (0x531478 / 0x531970). */
  startStanding: 1638.4,
  startCrouched: 819.2,
  /** Down ray length: 1000 m (dz = -4096000 at 0x46137e). */
  down: 4096000,
  /** Roof ray length: 2 m (8192 units); roof flag when the ceiling is within 1.8 m (0x531960). */
  roof: 8192,
  /** Grounded while the ground is within 0.5 m (2048 units, 0x460524). */
  snap: 2048,
  /** Footstep material: re-cast the hit object's set 0 from hit + 204.8 down 2048 units (0x531988, 0x531460). */
  materialRecastUp: 204.8,
  materialRecastDown: 2048,
  materialSet: COLLISION_SET_BULLET,
} as const;

/** The three sweep rays for a move from `feet` by `delta` (IGI units, z up). Empty for a zero move. */
export function characterSweepRays(feet: Vec3, delta: Vec3, crouched: boolean): Array<{ from: Vec3; to: Vec3; height: number }> {
  const len = Math.hypot(delta[0], delta[1], delta[2]);
  if (len === 0) return [];
  const k = (len + CHARACTER_SWEEP.skin) / len;
  const heights = crouched ? CHARACTER_SWEEP.heightsCrouched : CHARACTER_SWEEP.heightsStanding;
  return heights.map((height) => {
    const from: Vec3 = [feet[0], feet[1], feet[2] + height];
    return { from, to: [from[0] + delta[0] * k, from[1] + delta[1] * k, from[2] + delta[2] * k], height };
  });
}

/** Wall normal used for sliding: null unless |n.z| < 0.1; otherwise n with z = 0, renormalised. */
export function flattenWallNormal(n: Vec3): Vec3 | null {
  const len = Math.hypot(n[0], n[1], n[2]);
  if (len === 0 || Math.abs(n[2] / len) >= CHARACTER_SWEEP.wallMaxAbsNormalZ) return null;
  const h = Math.hypot(n[0], n[1]);
  return [n[0] / h, n[1] / h, 0];
}

/**
 * New end point after hitting a wall (FUN_004606b0 + FUN_004a8f50): only when
 * moving into the wall (move . n < 0) the end is projected onto the wall
 * plane through the hit point and pushed out by the skin. Returns null when
 * the move does not go into the wall.
 */
export function slideOnWall(start: Vec3, end: Vec3, hitPoint: Vec3, wallNormal: Vec3): Vec3 | null {
  const move = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
  if (move[0] * wallNormal[0] + move[1] * wallNormal[1] + move[2] * wallNormal[2] >= 0) return null;
  const rel = [end[0] - hitPoint[0], end[1] - hitPoint[1], end[2] - hitPoint[2]];
  const k = rel[0] * wallNormal[0] + rel[1] * wallNormal[1] + rel[2] * wallNormal[2];
  const s = CHARACTER_SWEEP.skin;
  return [
    hitPoint[0] + rel[0] - k * wallNormal[0] + wallNormal[0] * s,
    hitPoint[1] + rel[1] - k * wallNormal[1] + wallNormal[1] * s,
    hitPoint[2] + rel[2] - k * wallNormal[2] + wallNormal[2] * s,
  ];
}

// ---------------------------------------------------------------------------
// Line of sight (FUN_004c4630, FUN_004b9810, FUN_00487f40)       [recovered]
// ---------------------------------------------------------------------------

/** AI sight passes a blocked ray when the transmission is at least this (0x532218). */
export const AI_SIGHT_MIN_TRANSMISSION = 0.79;

/**
 * Transmission of a sight ray through its set-0 hits: starts at 1, every
 * front-face hit multiplies by the material's QMaterial argument 0
 * ("see-through"), any hit on a material with see-through 0, on an untagged
 * face or on terrain makes it 0. Any hit at all marks the ray blocked.
 */
export function sightTransmission(
  hits: ReadonlyArray<{ material: number; front: boolean; terrain?: boolean }>,
  seeThrough: (material: number) => number,
): { blocked: boolean; transmission: number } {
  let t = 1;
  for (const hit of hits) {
    if (hit.terrain || hit.material === NO_MATERIAL) return { blocked: true, transmission: 0 };
    const f = seeThrough(hit.material);
    if (hit.front) t *= f;
    if (f === 0) return { blocked: true, transmission: 0 };
  }
  return { blocked: hits.length > 0, transmission: t };
}

/** FUN_00487f40: a soldier sees the target point when nothing was hit, or the transmission is >= 0.79. */
export function aiSightPasses(result: { blocked: boolean; transmission: number }): boolean {
  return !result.blocked || result.transmission >= AI_SIGHT_MIN_TRANSMISSION;
}

// ---------------------------------------------------------------------------
// Materials (material/material.qvm)
// ---------------------------------------------------------------------------

/**
 * One SetActiveMaterial(i) / DefineQMaterial / DefineGameMaterial group.
 * Record i lives at 0x565380 + i x 0x268 and the world table at +0xd3c
 * points at it (FUN_004084a0); QMaterial at +0, GameMaterial from +0x20
 * (FUN_00407f40, FUN_00408060).                                  [recovered]
 */
export interface SurfaceMaterial {
  index: number;
  name: string;
  /** DefineQMaterial arg 0 (+0x00): sight transmission factor (Air/Glass/HumanCollision/MetalLadder/MetalFence 1, Fence 0.8, else 0). */
  seeThrough: number;
  /** DefineQMaterial args 1-2 (+0x0c, +0x08): no runtime reader traced. */
  qArgs: [number, number];
  /** DefineQMaterial args 3-5 (x 1/255 at +0x14..+0x1c): editor colour. */
  colour: Vec3;
  /** Arg 1 (+0x40): subtracted from the weapon's penetration power (FUN_00479e30). */
  hardness: number;
  /** Arg 2 (+0x44): ricochet angle in degrees (FUN_00479e30). */
  ricochetDeg: number;
  /** Arg 3 (+0x48) and arg 4 (+0x4c): no reader traced. */
  arg3: number;
  arg4: boolean;
  /** Arg 5 (+0x50): AIEVENT_WALK hearing range in metres (FUN_00462560). */
  footstepRangeM: number;
  /** Args 6-11, 12, 13, 14-19: walk[6], land, rain, impact[6] sound definition names. */
  walk: string[];
  land: string;
  rain: string;
  impact: string[];
  /** Args 22-28 and 29-35: front/back bullet-impact effects (decals, size, model). */
  effects: Array<{ task: string; flagA: boolean; flagB: boolean; decals: [string, string]; size: number; model: string }>;
}

function num(v: QvmValue | undefined, what: string): number {
  if (typeof v !== "number") fail(`${what} is not a number`);
  return v;
}

function str(v: QvmValue | undefined, what: string): string {
  if (typeof v === "string") return v;
  if (v !== undefined && typeof v === "object" && isQvmSymbol(v)) return v.symbol;
  return fail(`${what} is not a string`);
}

function bool(v: QvmValue | undefined, what: string): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return fail(`${what} is not TRUE/FALSE`);
}

/** Decode material/material.qvm, indexed by SetActiveMaterial number (24 materials in this install). */
export function readSurfaceMaterials(materialQvm: ArrayBuffer): SurfaceMaterial[] {
  const out: SurfaceMaterial[] = [];
  let active = -1;
  let q: number[] | null = null;
  for (const call of readQvmCallTree(materialQvm)) {
    const a = call.args;
    const at = `${call.fn} at code ${hex(call.codeOffset)}`;
    if (call.fn === "SetActiveMaterial") {
      active = num(a[0], `${at} index`);
      q = null;
    } else if (call.fn === "DefineQMaterial") {
      if (a.length !== 6) fail(`${at} has ${a.length} arguments, expected 6`);
      q = a.map((v, i) => num(v, `${at} argument ${i}`));
    } else if (call.fn === "DefineGameMaterial") {
      if (a.length !== 36) fail(`${at} has ${a.length} arguments, expected 36`);
      if (active < 0 || !q) fail(`${at} without SetActiveMaterial/DefineQMaterial`);
      const effect = (o: number) => ({
        task: str(a[o], `${at} effect task`),
        flagA: bool(a[o + 1], `${at} effect flag`),
        flagB: bool(a[o + 2], `${at} effect flag`),
        decals: [str(a[o + 3], `${at} decal`), str(a[o + 4], `${at} decal`)] as [string, string],
        size: num(a[o + 5], `${at} decal size`),
        model: str(a[o + 6], `${at} impact model`),
      });
      out[active] = {
        index: active,
        name: str(a[0], `${at} name`),
        seeThrough: q[0],
        qArgs: [q[1], q[2]],
        colour: [q[3] / 255, q[4] / 255, q[5] / 255],
        hardness: num(a[1], `${at} hardness`),
        ricochetDeg: num(a[2], `${at} ricochet`),
        arg3: num(a[3], `${at} argument 3`),
        arg4: bool(a[4], `${at} argument 4`),
        footstepRangeM: num(a[5], `${at} footstep range`),
        walk: a.slice(6, 12).map((v, i) => str(v, `${at} walk ${i}`)),
        land: str(a[12], `${at} land`),
        rain: str(a[13], `${at} rain`),
        impact: a.slice(14, 20).map((v, i) => str(v, `${at} impact ${i}`)),
        effects: [effect(22), effect(29)],
      };
    }
  }
  for (let i = 0; i < out.length; i++) {
    if (!out[i]) fail(`material ${i} is not defined`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Terrain material (FUN_004c1a30)
// ---------------------------------------------------------------------------

/** terrain.qvm CreateTerrainMaterial(id, arg1, ...): terrain material id -> game material (arg 1, handler 0x4bc890). */
export function readTerrainGameMaterials(terrainQvm: ArrayBuffer): Map<number, number> {
  const out = new Map<number, number>();
  for (const call of readQvmCallTree(terrainQvm)) {
    if (call.fn !== "CreateTerrainMaterial") continue;
    const at = `CreateTerrainMaterial at code ${hex(call.codeOffset)}`;
    out.set(num(call.args[0], `${at} id`), num(call.args[1], `${at} argument 1`) & 0xff);
  }
  return out;
}

export interface TerrainModifierInput {
  /** TextureModifier "Position" (IGI units). */
  position: Vec3;
  level: number;
  /** "Material Index" (terrain material id). */
  material: number;
  bitmapId: number;
}

interface ModifierEntry {
  level: number;
  material: number;
  order: number;
  x0: number;
  y0: number;
  full: number;
  scale: number;
  rowBytes: number;
  mask: Uint8Array;
}

/**
 * Terrain material under a point, as the ground probe's column query gets it
 * (FUN_004c1a30): the TextureModifiers whose node contains the point,
 * innermost first [order inferred, as for rendering], each sampled
 * bilinearly from its terrain.bit mask (x87 chop truncation for the cell,
 * FUN_004966d0 keeps the FPU in chop mode); the first whose value is
 * >= 0.3 gives the terrain material, else terrain material 0. The game
 * material is that terrain material's CreateTerrainMaterial argument 1.
 */
export class TerrainMaterialLookup {
  private readonly mods: ModifierEntry[] = [];

  constructor(
    modifiers: readonly TerrainModifierInput[],
    terrainBit: ArrayBuffer,
    private readonly terrainToGame: ReadonlyMap<number, number>,
  ) {
    const masks = readTerrainBit(terrainBit);
    modifiers.forEach((m, order) => {
      const entry = masks.get(m.bitmapId);
      if (m.bitmapId < 0 || !entry) return; // FUN_004fcd70 only registers modifiers with a mask
      const full = 2 * (TERRAIN_ROOT_HALF / 2 ** m.level);
      this.mods.push({
        level: m.level,
        material: m.material,
        order,
        x0: Math.floor(m.position[0] / full) * full,
        y0: Math.floor(m.position[1] / full) * full,
        full,
        scale: Math.fround((entry.side - 1) / full),
        rowBytes: entry.side / 8,
        mask: entry.mask,
      });
    });
  }

  /** Terrain material id at (x, y). */
  terrainMaterialAt(x: number, y: number): number {
    const stack = this.mods
      .filter((m) => x >= m.x0 && x < m.x0 + m.full && y >= m.y0 && y < m.y0 + m.full)
      .sort((a, b) => b.level - a.level || a.order - b.order);
    for (const m of stack) {
      const fx = (x - m.x0) * m.scale;
      const fy = Math.fround((y - m.y0) * m.scale);
      const ix = Math.trunc(fx);
      const iy = Math.trunc(fy);
      const bit = (cx: number, cy: number) => {
        const k = (cx >> 3) + cy * m.rowBytes;
        return cx >= 0 && k >= 0 && k < m.mask.length ? (m.mask[k] >> (cx & 7)) & 1 : 0;
      };
      const tx = fx - ix;
      const ty = fy - iy;
      const top = bit(ix, iy) + (bit(ix + 1, iy) - bit(ix, iy)) * tx;
      const bottom = bit(ix, iy + 1) + (bit(ix + 1, iy + 1) - bit(ix, iy + 1)) * tx;
      if (top + (bottom - top) * ty >= 0.3) return m.material;
    }
    return 0;
  }

  /** Game material (material.qvm index) of the terrain at (x, y). */
  gameMaterialAt(x: number, y: number): number {
    const id = this.terrainMaterialAt(x, y);
    return this.terrainToGame.get(id) ?? this.terrainToGame.get(0) ?? UNTAGGED_RAY_MATERIAL;
  }
}

/** Game material a ray reports on terrain (FUN_004c3520 / FUN_004c2a30: entry 1 of the world table). */
export const TERRAIN_RAY_MATERIAL = 1;
