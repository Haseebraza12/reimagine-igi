/**
 * Bullet holes, as igi.exe's BulletHole class builds and draws them
 * [recovered: registration FUN_0047b630, object handler FUN_0047b9d0,
 * terrain handler FUN_0047c6b0, quad FUN_0047bf10, frame FUN_004aa2f0, draw
 * 0x47b700 -> PolyListDynCubeObj FUN_00498c10; rules in bullet-effects.ts
 * BULLET_HOLE; docs/rendering.md section 7]:
 *
 *   - one hole list per hit OBJECT (a BulletHole child object, at most 100 in
 *     the level; objects beyond the 100th get no holes); 200 slots per list
 *     used as a ring (the oldest slot is reused). The terrain class has a
 *     handler too (FUN_0047c6b0, duplicates by distance only), but bullet
 *     hits on the terrain carry no object (FUN_004c24c0 0x4c29e9), so
 *     FUN_004376c0 never sends them: no bullet holes on the ground;
 *   - permission per object class: the hole message slot DAT_0053e894 has a
 *     handler on RigidDynCubeObj (and its descendants) and on the terrain;
 *     Wire, Rotor, Switch, ElevatorFloorIndicator, Gun, GunFlame, GunClip and
 *     GunMovingPart clear it, humans (BoneDynCubeObj) never had it: no holes
 *     there (effects.ts decalTarget);
 *   - a new hole is dropped when an existing valid hole of the same list lies
 *     within 1.5 x that hole's half-size AND (objects only, not terrain) the
 *     normals' dot product exceeds 0.9;
 *   - the hole is ONE fixed quad (not clipped, not projected, no random
 *     roll): corners (+-s, +-s, 12.288 units) in the frame of the face normal
 *     (FUN_004aa2f0: a = |(n.y, -n.x, 0)|, b = |a x n|), s = the material's
 *     size x 4096 = HALF-size; UVs (0,0) (0,1) (1,0) (1,1) for corners
 *     (+,+) (-,+) (+,-) (-,-);
 *   - each lifted corner casts a 24.576-unit ray along -n against all
 *     geometry; if any ray hits nothing the hole is marked invalid (never
 *     drawn) but keeps its slot;
 *   - drawn as PolyList triangles: LIGHTING off, vertex colour white,
 *     texture colour x white, ALPHAOP SELECTARG1 (texture alpha), alpha test
 *     > 0, SRCALPHA/INVSRCALPHA, Z test without write, object fog, near plane
 *     x 1.01 (render/object-material createDecalMaterial); up to 500
 *     triangles per list (200 quads fit).
 * Holes live in the object's frame (they move with doors and vehicles: lists
 * of dynamic bodies follow the body transform here).
 * Port approximation: the quad frame is built from the world-space normal;
 * igi.exe uses the object-local normal, which gives the same quad for objects
 * rotated about z only (all level-1 buildings) [inferred equivalence].
 */
import * as THREE from "three";
import type { DecodedTexture, Vec3 } from "../../contracts";
import type { ImpactEffect, ImpactMaterial } from "../../loaders";
import type { FogUniforms } from "../render/fog";
import { applyObjectSampler, createDecalMaterial } from "../render/object-material";
import {
  BULLET_HOLE,
  HoleRing,
  UNITS,
  bulletHoleCorners,
  enginePoint,
  igiDir,
  igiPoint,
  isDuplicateHole,
  normalise,
  type StoredHole,
} from "./bullet-effects";

/** Legacy limit name kept for callers; the recovered rule is BULLET_HOLE.slotsPerObject per object. */
export const DECALS_PER_TEXTURE = BULLET_HOLE.slotsPerObject;

/** Material used when an impact names none: "Ground" on up-facing surfaces, else "Concrete" [inferred stand-in, legacy path only]. */
export function defaultImpactMaterial(normal: Vec3): string {
  return normal[1] > 0.7 ? "Ground" : "Concrete";
}

/** Entry A of a material: its two textures (non-empty) and half-size (m), or null when it has no texture 1. */
export function decalFor(materials: ImpactMaterial[], name: string | null): { textures: string[]; halfSizeM: number } | null {
  const material = materials.find((m) => m.name.toLowerCase() === (name ?? "").toLowerCase());
  if (!material) return null;
  const effect: ImpactEffect = material.effects[0];
  const textures = effect.decalTextures.filter((t) => t.length > 0);
  if (textures.length === 0 || !(effect.size > 0)) return null;
  return { textures, halfSizeM: effect.size };
}

/** Quad transform (local +z = normal) centred on `point`, half-size `h`, rolled by `roll` (legacy helper, not used by the exact path). */
export function decalMatrix(point: Vec3, normal: Vec3, halfSizeM: number, roll: number, target = new THREE.Matrix4()): THREE.Matrix4 {
  const n = new THREE.Vector3(normal[0], normal[1], normal[2]);
  if (n.lengthSq() < 1e-12) n.set(0, 1, 0);
  n.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll));
  return target.compose(new THREE.Vector3(point[0], point[1], point[2]), q, new THREE.Vector3(2 * halfSizeM, 2 * halfSizeM, 1));
}

/** Which bullet-hole list a hit belongs to (effects.ts decalTarget). */
export interface DecalTarget {
  /** List key, e.g. "inst:<placed instance>", "body:<id>" ("terrain" for the terrain handler's list). */
  key: string;
  terrain: boolean;
  /** Dynamic body id: holes follow its transform. */
  body: number | null;
}

/** Engine-space corners of a hole: world point + outward unit normal, half-size in units (pure; exported for tests). */
export function bulletHoleQuad(point: Vec3, normal: Vec3, halfSizeUnits: number): [Vec3, Vec3, Vec3, Vec3] {
  const c = bulletHoleCorners(igiPoint(point), normalise(igiDir(normal)), halfSizeUnits);
  return [enginePoint(c[0]), enginePoint(c[1]), enginePoint(c[2]), enginePoint(c[3])];
}

export type HolePlacement = "placed" | "invalid" | "duplicate" | "full" | "no-texture";

/** True when some geometry lies on the segment (FUN_004c4630 returns the opposite). */
export type HoleProbe = (from: Vec3, to: Vec3) => boolean;

export interface DecalSystem {
  readonly group: THREE.Group;
  /**
   * FUN_0047b9d0 / FUN_0047c6b0: add a hole of `texture` (textures.res file
   * name) with half-size `halfSizeUnits` at `point` on a face with outward unit
   * normal `normal` (engine space) to the list of `target`.
   */
  place(target: DecalTarget, point: Vec3, normal: Vec3, texture: string, halfSizeUnits: number): HolePlacement;
  /** Legacy material-based entry (no target): entry A's texture 2 (the last-impact texture). */
  add(point: Vec3, normal: Vec3, material: string | null, random?: () => number): boolean;
  /** Per frame: lists of dynamic bodies follow `bodyMatrix(id)` (column-major, build pose -> current), hidden when null. */
  sync(bodyMatrix: (id: number) => ArrayLike<number> | null): void;
  /** Number of lists and of drawn holes (diagnostics, tests). */
  stats(): { lists: number; holes: number; drawn: number };
  /** Delete one object's list (the object left the world, e.g. a broken pane). */
  drop(key: string): void;
  clear(): void;
  dispose(): void;
}

interface Slot extends StoredHole {
  texture: string;
  /** Engine corners in the list's frame (body-local for dynamic bodies). */
  corners: [Vec3, Vec3, Vec3, Vec3];
}

interface HoleList {
  target: DecalTarget;
  ring: HoleRing;
  slots: (Slot | null)[];
  group: THREE.Group;
  meshes: Map<string, THREE.Mesh>;
  dirty: boolean;
}

export interface DecalSystemOptions {
  /** Geometry test for the corner rays; without it every hole is valid. */
  probe?: HoleProbe;
  /** Current transform of dynamic body `id` (column-major), for holes placed on it. */
  bodyMatrix?: (id: number) => ArrayLike<number> | null;
}

export function createDecalSystem(
  materials: ImpactMaterial[],
  textures: Map<string, DecodedTexture>,
  fog: FogUniforms,
  mipBias: THREE.IUniform<number>,
  options: DecalSystemOptions = {},
): DecalSystem {
  const group = new THREE.Group();
  group.name = "bullet-holes";
  const lists = new Map<string, HoleList>();
  const shared = new Map<string, { texture: THREE.Texture; material: THREE.ShaderMaterial } | null>();

  const materialFor = (file: string) => {
    const key = file.toLowerCase();
    if (shared.has(key)) return shared.get(key)!;
    const decoded = textures.get(key);
    if (!decoded) {
      shared.set(key, null);
      return null;
    }
    const texture = new THREE.DataTexture(
      new Uint8Array(decoded.rgba.buffer as ArrayBuffer, decoded.rgba.byteOffset, decoded.rgba.byteLength),
      decoded.width,
      decoded.height,
      THREE.RGBAFormat,
    );
    texture.flipY = false; // D3D v = 0 is the first row
    applyObjectSampler(texture); // PolyList stage 0: LINEAR, MIPFILTER POINT, WRAP (FUN_00498840)
    texture.needsUpdate = true;
    const entry = { texture, material: createDecalMaterial(texture, fog, mipBias) };
    shared.set(key, entry);
    return entry;
  };

  const listFor = (target: DecalTarget): HoleList | null => {
    let list = lists.get(target.key);
    if (list) return list;
    if (lists.size >= BULLET_HOLE.maxObjects) return null;
    const g = new THREE.Group();
    g.name = `bullet-holes:${target.key}`;
    if (target.body !== null) g.matrixAutoUpdate = false;
    group.add(g);
    list = { target, ring: new HoleRing(), slots: new Array(BULLET_HOLE.slotsPerObject).fill(null), group: g, meshes: new Map(), dirty: false };
    lists.set(target.key, list);
    return list;
  };

  const inverse = new THREE.Matrix4();
  const toList = (target: DecalTarget, p: Vec3, n: Vec3): { p: Vec3; n: Vec3 } => {
    if (target.body === null || !options.bodyMatrix) return { p, n };
    const m = options.bodyMatrix(target.body);
    if (!m) return { p, n };
    inverse.fromArray(Array.from(m)).invert();
    const lp = new THREE.Vector3(...p).applyMatrix4(inverse);
    const ln = new THREE.Vector3(...n).transformDirection(inverse);
    return { p: [lp.x, lp.y, lp.z], n: [ln.x, ln.y, ln.z] };
  };

  const rebuild = (list: HoleList) => {
    list.dirty = false;
    const byTexture = new Map<string, Slot[]>();
    for (const s of list.slots) {
      if (!s || s.invalid) continue;
      let arr = byTexture.get(s.texture);
      if (!arr) byTexture.set(s.texture, (arr = []));
      arr.push(s);
    }
    for (const [texture, mesh] of list.meshes) {
      if (!byTexture.has(texture)) {
        mesh.removeFromParent();
        mesh.geometry.dispose();
        list.meshes.delete(texture);
      }
    }
    for (const [texture, holes] of byTexture) {
      const m = materialFor(texture);
      if (!m) continue;
      const positions = new Float32Array(holes.length * 12);
      const uvs = new Float32Array(holes.length * 8);
      const index: number[] = [];
      holes.forEach((h, i) => {
        for (let c = 0; c < 4; c++) {
          positions.set(h.corners[c], i * 12 + c * 3);
          uvs.set(BULLET_HOLE.uvs[c], i * 8 + c * 2);
        }
        for (const t of BULLET_HOLE.triangles) index.push(i * 4 + t);
      });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
      geometry.setIndex(index);
      geometry.computeBoundingSphere();
      let mesh = list.meshes.get(texture);
      if (mesh) {
        mesh.geometry.dispose();
        mesh.geometry = geometry;
      } else {
        mesh = new THREE.Mesh(geometry, m.material);
        mesh.name = `holes:${texture}`;
        mesh.frustumCulled = false;
        list.group.add(mesh);
        list.meshes.set(texture, mesh);
      }
    }
  };

  const place = (target: DecalTarget, point: Vec3, normal: Vec3, texture: string, halfSizeUnits: number): HolePlacement => {
    if (!materialFor(texture)) return "no-texture";
    const list = listFor(target);
    if (!list) return "full";
    const n = normalise(normal);
    const local = toList(target, point, n);
    const centre = igiPoint(local.p);
    const nIgi = normalise(igiDir(local.n));
    if (isDuplicateHole(list.slots, centre, nIgi, target.terrain)) return "duplicate";
    const slot = list.ring.take();
    const cornersIgi = bulletHoleCorners(centre, nIgi, halfSizeUnits);
    // Corner rays in world space (FUN_0047bf10 0x47c5f0): lifted corner -> 24.576 units along -n.
    let invalid = false;
    if (options.probe) {
      const worldCorners = bulletHoleQuad(point, n, halfSizeUnits);
      const reach = BULLET_HOLE.probeUnits / UNITS;
      for (const c of worldCorners) {
        if (!options.probe(c, [c[0] - n[0] * reach, c[1] - n[1] * reach, c[2] - n[2] * reach])) invalid = true;
      }
    }
    list.slots[slot] = {
      centre,
      normal: nIgi,
      halfSize: halfSizeUnits,
      invalid,
      texture: texture.toLowerCase(),
      corners: [enginePoint(cornersIgi[0]), enginePoint(cornersIgi[1]), enginePoint(cornersIgi[2]), enginePoint(cornersIgi[3])],
    };
    list.dirty = true;
    rebuild(list);
    return invalid ? "invalid" : "placed";
  };

  const m4 = new THREE.Matrix4();
  return {
    group,
    place,
    add(point, normal, materialName) {
      const material = materials.find((m) => m.name.toLowerCase() === (materialName ?? "").toLowerCase());
      if (!material) return false;
      const e = material.effects[0];
      const texture = e.decalTextures[1] || null;
      if (!e.decalTextures[0] || !texture) return false;
      return place({ key: "legacy", terrain: false, body: null }, point, normal, texture, Math.fround(e.size * 4096)) === "placed";
    },
    sync(bodyMatrix) {
      for (const list of lists.values()) {
        if (list.target.body === null) continue;
        const m = bodyMatrix(list.target.body);
        list.group.visible = m !== null;
        if (m) {
          m4.fromArray(Array.from(m));
          list.group.matrix.copy(m4);
          list.group.matrixWorldNeedsUpdate = true;
        }
      }
    },
    stats() {
      let holes = 0;
      let drawn = 0;
      for (const l of lists.values()) {
        for (const s of l.slots) {
          if (!s) continue;
          holes++;
          if (!s.invalid) drawn++;
        }
      }
      return { lists: lists.size, holes, drawn };
    },
    drop(key) {
      const l = lists.get(key);
      if (!l) return;
      l.group.removeFromParent();
      for (const m of l.meshes.values()) m.geometry.dispose();
      lists.delete(key);
    },
    clear() {
      for (const l of lists.values()) {
        l.group.removeFromParent();
        for (const m of l.meshes.values()) m.geometry.dispose();
      }
      lists.clear();
    },
    dispose() {
      this.clear();
      group.removeFromParent();
      for (const s of shared.values()) {
        s?.texture.dispose();
        s?.material.dispose();
      }
      shared.clear();
    },
  };
}
