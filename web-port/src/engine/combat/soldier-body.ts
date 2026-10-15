/**
 * Soldier bodies: the original skinned models, posed from their own .iff
 * clips (docs/characters.md), with the gun on bone 22, the upper-body aim,
 * distance LODs and per-bone hit zones (docs/gameplay.md).
 *
 * Recovered:
 *   - Bone model per HumanSoldier 'Model', skeleton = 'Bone Heirachy'
 *     (level 1: 003/019/001_01_1 on skeleton 1, 000_01_1 on 0, 015_01_1 on 6).
 *   - Posing (FUN_004c9f50): root bone at the object origin with the object
 *     rotation (gamma about z); world_q = parent_q * local_q; then the
 *     upper-body aim FUN_00488390 (soldier-graph.ts applyUpperBodyAim) when
 *     enabled (human+0x64c). Skinning FUN_0052be70: LOD 0 weighted with the
 *     extra influences, LOD >= 1 rigid.
 *   - LOD (FUN_0052fc20 -> FUN_004c4fc0, soldier-lod.ts): variant i of
 *     <base>_1 .. <base>_n by the lod.qvm distances; beyond the cutoff the
 *     body is not drawn (its pose still serves the hit tests).
 *   - The object position tracks the pelvis: feet = position - root z, the
 *     stored root sample (FUN_00488760); the pose is the advanced clip time.
 *   - Hit zone of a bone: table 0x53f148 (hitZoneForBone); damage multiplier
 *     per zone (SOLDIER_ZONE_MULTIPLIERS, head x100).
 *   - Lighting: fixed-function vertex lighting, ambient + front x max(0, n.sun).
 *   - Hit tests use the bone model's own collision set 0 (HSMC; bone-local
 *     vertices posed with the bone matrices, R_b p + T_b: FUN_004cdcb0 /
 *     FUN_004cef60), with its per-face materials (Flesh, BloodyFlesh, the
 *     helmet's metal) and the exe's hit ordering (docs/collision.md).
 *   - Sight rays (FUN_0045e490): the HSEM +120 sphere around the pelvis
 *     first (FUN_0045e210), then every crossed face of the same set
 *     (sightHits; docs/ai.md 2.2).
 *   - The gun leaves the hand when the death state starts (FUN_0045aea0 ->
 *     FUN_004e9010).
 * Observed fit (inferred binding): the gun model on bone 22, identity offset.
 */
import * as THREE from "three";
import {
  SOLDIER_GUN_BONE,
  SOLDIER_ZONE_MULTIPLIERS,
  hitZoneForBone,
  poseSkeleton,
  poseVertices,
  readAnimations,
  readSkinnedModel,
  sampleClip,
  type AnimationFile,
  type IgiLevel,
  type LevelSoldier,
  type SkinnedModel,
} from "../../loaders";
import type { IAssetSource } from "../../contracts";
import { BodyCollision, type BodyRayHit } from "./body-collision";
import { createLevelTexture } from "../world/world-builder";
import { ClipPlayer } from "../ai/clip-player";
import { applyUpperBodyAim } from "../ai/soldier-graph";
import { loadSoldierLods, soldierLod, type SoldierLodSet } from "./soldier-lod";

const UNITS_PER_METRE = 4096;

/** Shared, per-level resources (decoded models, animation files, textures, LOD sets). */
export class SoldierAssets {
  private readonly anims = new Map<number, AnimationFile>();
  private readonly models = new Map<string, SkinnedModel>();
  private readonly textures = new Map<string, THREE.Texture>();
  readonly disposables: Array<{ dispose(): void }> = [];
  /** LOD sets by model name, once loadLods() finished. */
  lods: Map<string, SoldierLodSet> | null = null;
  private loading: Promise<void> | null = null;

  constructor(readonly level: IgiLevel) {}

  anim(skeleton: number): AnimationFile | null {
    let a = this.anims.get(skeleton);
    if (!a) {
      const buffer = this.level.animations.get(skeleton);
      if (!buffer) return null;
      a = readAnimations(buffer);
      this.anims.set(skeleton, a);
    }
    return a;
  }

  model(name: string, skeleton: number, buffer?: ArrayBuffer): SkinnedModel | null {
    const key = `${name}@${skeleton}`;
    let m = this.models.get(key);
    if (!m) {
      const data = buffer ?? this.level.boneModels.get(name)?.buffer;
      const anim = this.anim(skeleton);
      if (!data || !anim) return null;
      try {
        m = readSkinnedModel(data, anim.skeleton);
      } catch {
        return null;
      }
      this.models.set(key, m);
    }
    return m;
  }

  texture(key: string | null): THREE.Texture | null {
    if (!key) return null;
    let t = this.textures.get(key);
    if (!t) {
      t = createLevelTexture(this.level, key).texture;
      this.textures.set(key, t);
      this.disposables.push(t);
    }
    return t;
  }

  /** Read the LOD variants and lod.qvm distances of the level's soldier models (once). */
  loadLods(raw: IAssetSource): Promise<void> {
    if (!this.loading) {
      const models = new Set(this.level.soldiers.map((s) => s.model).filter((m): m is string => Boolean(m)));
      this.loading = loadSoldierLods(raw, this.level, models)
        .then((lods) => {
          this.lods = lods;
        })
        .catch((error) => {
          console.warn("[soldiers] LOD models not loaded:", error);
          this.lods = new Map();
        });
    }
    return this.loading;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

export interface BodyHit {
  distance: number;
  point: [number, number, number];
  bone: number;
  zone: number;
  zoneMultiplier: number;
  /** material.qvm index of the face hit (untagged faces report Ground). */
  material: number;
  /** The ray entered the body through this face. */
  front: boolean;
}

export interface SoldierPoseOptions {
  /** The gun is in the hand (not dropped). */
  gunVisible?: boolean;
  /** Upper-body aim (FUN_00488390): view pitch (arms +0x120) and yaw (+0x12c); null = disabled (human+0x64c = 0). */
  aim?: { pitch: number; yaw: number } | null;
  /** Pelvis height above the feet (IGI units); default the clip's stored root sample. */
  rootZ?: number;
  /** Skin the vertices (false: bones only, e.g. a culled far body). */
  skin?: boolean;
  /** Bone rotations to pose instead of the animator's clip (the player's blended body). */
  rotations?: ArrayLike<number> | null;
}

interface LodMesh {
  model: SkinnedModel;
  mesh: THREE.Mesh;
  posed: { positions: Float32Array; normals: Float32Array };
  enginePositions: Float32Array;
  colours: Float32Array;
}

export class SoldierBody {
  readonly object = new THREE.Group();
  private readonly meshes: LodMesh[] = [];
  private readonly anim: AnimationFile | null;
  private readonly gun = new THREE.Group();
  /** Clip playback of bone 0 (the motor's BodyAnimator). */
  readonly animator: ClipPlayer;
  private bones: Float32Array | null = null;
  private rootZ = 0.95 * UNITS_PER_METRE;
  private poseVersion = 0;
  private collisionVersion = -1;
  private readonly collision: BodyCollision | null = null;
  private readonly light: IgiLevel["objectLight"];
  private readonly enemyId: number;
  readonly standAnimation: number;
  private lodSet: SoldierLodSet | null = null;
  /** Current LOD (0 = finest) or -1 when not drawn. */
  lod = 0;

  /** Muzzle in gun-local engine space: the gun's flame part (ATTA) origin, else 0.5 m along the barrel (inferred). */
  private readonly muzzleLocal = new THREE.Vector3(0, 0, -0.5);
  private readonly muzzleWorld = new THREE.Vector3();

  /** `weaponId` overrides soldier.weapon (level.ts infers an AK for soldiers without a Gun task). */
  constructor(private readonly assets: SoldierAssets, private readonly soldier: LevelSoldier, enemyId: number, weaponId: string | null = soldier.weapon) {
    this.enemyId = enemyId;
    this.object.userData.enemyId = enemyId;
    this.light = assets.level.objectLight;
    this.standAnimation = soldier.standAnimation;
    this.anim = assets.anim(soldier.skeleton);
    this.animator = new ClipPlayer(this.anim);
    const model = soldier.model ? assets.model(soldier.model, soldier.skeleton) : null;
    const data = soldier.model ? assets.level.boneModels.get(soldier.model) : undefined;
    if (model && data) {
      this.addLodMesh(model, data.textureKeys);
      this.collision = BodyCollision.fromModel(data.buffer);
    }
    // Gun (third person): the whole gun model with its parts on bone 22.
    const parts = weaponId ? assets.level.guns.get(weaponId) ?? [] : [];
    for (const part of parts) {
      if (part.role === "flame") {
        this.muzzleLocal.set(part.matrix[12], part.matrix[13], part.matrix[14]);
        continue;
      }
      const m = assets.level.models.get(part.model);
      if (!m) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
      geometry.setAttribute("uv", new THREE.BufferAttribute(m.uv, 2));
      geometry.setIndex(new THREE.BufferAttribute(m.indices, 1));
      const materials = m.groups.map((g, i) => {
        geometry.addGroup(g.start, g.count, i);
        const material = new THREE.MeshBasicMaterial({
          map: assets.texture(g.texture),
          color: new THREE.Color(...this.light.ambient.map((a, k) => Math.min(1, a + this.light.front[k] * 0.5)) as [number, number, number]),
        });
        assets.disposables.push(material);
        return material;
      });
      assets.disposables.push(geometry);
      const mesh = new THREE.Mesh(geometry, materials);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.fromArray(part.matrix);
      this.gun.add(mesh);
    }
    this.gun.matrixAutoUpdate = false;
    this.object.add(this.gun);
  }

  private addLodMesh(model: SkinnedModel, textureKeys: readonly (string | null)[]): void {
    const n = model.primaryCount;
    const posed = { positions: new Float32Array(3 * n), normals: new Float32Array(3 * n) };
    const enginePositions = new Float32Array(3 * n);
    const colours = new Float32Array(3 * n);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(enginePositions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("color", new THREE.BufferAttribute(colours, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("uv", new THREE.BufferAttribute(model.uv.subarray(0, 2 * n), 2));
    geometry.setIndex(new THREE.BufferAttribute(model.indices, 1));
    const materials = model.groups.map((g, i) => {
      geometry.addGroup(g.start, g.count, i);
      const material = new THREE.MeshBasicMaterial({ map: this.assets.texture(textureKeys[g.materialSlot] ?? null), vertexColors: true });
      this.assets.disposables.push(material);
      return material;
    });
    this.assets.disposables.push(geometry);
    const mesh = new THREE.Mesh(geometry, materials);
    mesh.frustumCulled = false;
    mesh.userData.enemyId = this.enemyId;
    mesh.visible = this.meshes.length === 0;
    this.object.add(mesh);
    this.meshes.push({ model, mesh, posed, enginePositions, colours });
  }

  /** Attach the LOD variants once SoldierAssets.loadLods() finished (FUN_004c4fc0's LOD set). */
  useLods(): void {
    const lods = this.assets.lods;
    if (this.lodSet || !lods || !this.soldier.model || this.meshes.length === 0) return;
    const set = lods.get(this.soldier.model) ?? null;
    if (!set) return;
    this.lodSet = set;
    for (const v of set.variants) {
      const model = this.assets.model(v.name, this.soldier.skeleton, v.buffer);
      if (!model) break;
      this.addLodMesh(model, v.textureKeys);
    }
  }

  /** Number of LOD variants available (1 before useLods()). */
  get lodCount(): number {
    return this.meshes.length;
  }

  /**
   * Choose the LOD for a camera (FUN_004c4fc0): depth along the camera's
   * forward axis of the pelvis position + the model's sphere centre.
   * feet: engine metres; camera position / unit forward: engine space.
   */
  chooseLod(feet: readonly number[], camera: readonly number[], forward: readonly number[], tanX: number): number {
    const set = this.lodSet;
    if (!set) {
      this.lod = 0;
      return 0;
    }
    const c = set.centre;
    const rootZ = this.animator.rootZ;
    // IGI (x, y, z) -> engine (x, z, -y), metres; the centre is not rotated.
    const px = feet[0] + c[0] / UNITS_PER_METRE;
    const py = feet[1] + (rootZ + c[2]) / UNITS_PER_METRE;
    const pz = feet[2] - c[1] / UNITS_PER_METRE;
    const depth = (px - camera[0]) * forward[0] + (py - camera[1]) * forward[1] + (pz - camera[2]) * forward[2];
    this.lod = soldierLod(set, this.meshes.length, depth, tanX);
    return this.lod;
  }

  /** Attach an object (e.g. the gun's muzzle flash) in gun-local space on bone 22. */
  attachToGun(object: THREE.Object3D): void {
    this.gun.add(object);
  }

  /** World position of the muzzle from the last pose (engine space). */
  muzzle(): [number, number, number] {
    this.muzzleWorld.copy(this.muzzleLocal).applyMatrix4(this.gun.matrix).add(this.object.position);
    return [this.muzzleWorld.x, this.muzzleWorld.y, this.muzzleWorld.z];
  }

  /** World position of the gun model's origin (bone 22) from the last pose (engine space). */
  gunPosition(): [number, number, number] {
    const e = this.gun.matrix.elements;
    const o = this.object.position;
    return [e[12] + o.x, e[13] + o.y, e[14] + o.z];
  }

  /** True once pose() has placed the gun at least once. */
  get hasPose(): boolean {
    return this.bones !== null;
  }

  get clipId(): number | null {
    return this.animator.clipId;
  }

  /** The posed bone matrices (object space, IGI units), or null before the first pose. */
  get boneMatrices(): Float32Array | null {
    return this.bones;
  }

  /**
   * Pose the body at the clip's current (advanced) time at `feet` (engine)
   * with body yaw `yaw` (engine yaw = IGI gamma of the body matrix).
   */
  pose(feet: readonly number[], yaw: number, options: SoldierPoseOptions = {}): void {
    const clipState = this.animator.clip;
    const clip = clipState && this.anim ? this.anim.clips.get(clipState.id) : undefined;
    this.object.position.set(feet[0], feet[1], feet[2]);
    if (!this.anim) return;
    const sample = !options.rotations && clip ? sampleClip(clip, Math.min(clipState!.time, clip.duration)) : null;
    const half = yaw / 2;
    const root = [0, 0, Math.sin(half), Math.cos(half)];
    const rotations = options.rotations ?? (sample ? sample.rotations : null);
    const bones = poseSkeleton(this.anim.skeleton, rotations as Parameters<typeof poseSkeleton>[1], root, (this.bones ?? undefined) as Float32Array<ArrayBuffer> | undefined);
    this.bones = bones;
    if (options.aim) applyUpperBodyAim(bones, this.anim.skeleton.parents, options.aim.pitch, options.aim.yaw, yaw);
    const rootZ = options.rootZ ?? this.animator.rootZ;
    this.rootZ = rootZ;
    this.poseVersion++;
    const lod = this.meshes.length > 0 ? Math.min(this.lod, this.meshes.length - 1) : -1;
    for (let i = 0; i < this.meshes.length; i++) this.meshes[i].mesh.visible = i === lod;
    if (lod >= 0 && options.skin !== false) this.skin(this.meshes[lod], lod === 0, rootZ);
    // Gun on bone 22 (bone matrices are IGI object space).
    const b = SOLDIER_GUN_BONE * 16;
    const m = bones;
    if (m.length >= b + 16) {
      const conv = (x: number, y: number, z: number): [number, number, number] => [x, z, -y];
      const bx = conv(m[b], m[b + 1], m[b + 2]);
      const by = conv(m[b + 4], m[b + 5], m[b + 6]);
      const bz = conv(m[b + 8], m[b + 9], m[b + 10]);
      const t = conv(m[b + 12], m[b + 13], m[b + 14] + rootZ);
      // Engine-space bone frame: column j = conv(R e_j) mapped through the engine basis of the gun model (x, z, -y).
      const ex = bx, ey = bz, ez = [-by[0], -by[1], -by[2]];
      this.gun.matrix.set(
        ex[0], ey[0], ez[0], t[0] / UNITS_PER_METRE,
        ex[1], ey[1], ez[1], t[1] / UNITS_PER_METRE,
        ex[2], ey[2], ez[2], t[2] / UNITS_PER_METRE,
        0, 0, 0, 1,
      );
    }
    this.gun.visible = lod >= 0 && options.gunVisible !== false;
  }

  private skin(l: LodMesh, weighted: boolean, rootZ: number): void {
    poseVertices(l.model, this.bones!, weighted, l.posed);
    const P = l.posed.positions;
    const N = l.posed.normals;
    const E = l.enginePositions;
    const C = l.colours;
    const s = this.light.sunDirection;
    for (let i = 0; i < P.length; i += 3) {
      // IGI object space (z up) -> engine (x, z, -y), metres; pelvis at the root height above the feet.
      E[i] = P[i] / UNITS_PER_METRE;
      E[i + 1] = (P[i + 2] + rootZ) / UNITS_PER_METRE;
      E[i + 2] = -P[i + 1] / UNITS_PER_METRE;
      const nx = N[i], ny = N[i + 2], nz = -N[i + 1];
      const len = Math.hypot(nx, ny, nz) || 1;
      const d = Math.max(0, (nx * s[0] + ny * s[1] + nz * s[2]) / len);
      for (let k = 0; k < 3; k++) C[i + k] = Math.min(1, this.light.ambient[k] + this.light.front[k] * d);
    }
    const geometry = l.mesh.geometry;
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
    geometry.computeBoundingSphere();
  }

  /** Pose the collision set with the current bone matrices (once per pose). */
  private poseCollision(): BodyCollision | null {
    const c = this.collision;
    if (!c || !this.bones) return null;
    if (this.collisionVersion !== this.poseVersion) {
      c.pose(this.bones, this.rootZ);
      this.collisionVersion = this.poseVersion;
    }
    return c;
  }

  /**
   * Ray test against the posed body: the nearest hit of the bone model's
   * collision set 0 (front beats back within 0.1 unit), with its bone, zone
   * and material. Falls back to the render mesh before the first pose.
   */
  hitTest(raycaster: THREE.Raycaster): BodyHit | null {
    const c = this.poseCollision();
    if (!c) return this.hitTestMesh(raycaster);
    const o = raycaster.ray.origin;
    const d = raycaster.ray.direction;
    const base = this.object.position;
    const ox = o.x - base.x, oy = o.y - base.y, oz = o.z - base.z;
    // Cheap reject: a 2.5 m sphere around the pelvis.
    const cy = this.rootZ / UNITS_PER_METRE;
    const t0 = ox * d.x + (oy - cy) * d.y + oz * d.z;
    if (ox * ox + (oy - cy) * (oy - cy) + oz * oz - t0 * t0 > 6.25) return null;
    const hit = c.raycast(ox, oy, oz, d.x, d.y, d.z, raycaster.near, raycaster.far);
    if (!hit) return null;
    const zone = hitZoneForBone(hit.bone);
    return {
      distance: hit.distance,
      point: [o.x + d.x * hit.distance, o.y + d.y * hit.distance, o.z + d.z * hit.distance],
      bone: hit.bone,
      zone,
      zoneMultiplier: SOLDIER_ZONE_MULTIPLIERS[zone] ?? 1,
      material: hit.material,
      front: hit.front,
    };
  }

  /**
   * A sight ray (FUN_00487f40 -> FUN_004c4630 message 8) from `from` to `to`
   * (engine) against this body as it is posed now: the human answers through
   * FUN_0045e490 (HSEM sphere around the pelvis, then every crossed face of
   * collision set 0, BodyCollision.sightHits). Alive or dead alike. Empty
   * without a collision set or before the first pose.
   */
  sightHits(from: readonly number[], to: readonly number[]): BodyRayHit[] {
    const c = this.poseCollision();
    if (!c) return [];
    const b = this.object.position;
    return c.sightHits(from[0] - b.x, from[1] - b.y, from[2] - b.z, to[0] - b.x, to[1] - b.y, to[2] - b.z);
  }

  /** Render-mesh ray test (before the first pose, or for models without collision). */
  private hitTestMesh(raycaster: THREE.Raycaster): BodyHit | null {
    const l = this.meshes[0];
    if (!l) return null;
    this.object.updateMatrixWorld(true);
    const hits = raycaster.intersectObject(l.mesh, false);
    const hit = hits[0];
    if (!hit || !hit.face) return null;
    const bone = l.model.vertexBone[hit.face.a];
    const zone = hitZoneForBone(bone);
    return {
      distance: hit.distance,
      point: [hit.point.x, hit.point.y, hit.point.z],
      bone,
      zone,
      zoneMultiplier: SOLDIER_ZONE_MULTIPLIERS[zone] ?? 1,
      material: 8, // Flesh [inferred]
      front: true,
    };
  }
}
