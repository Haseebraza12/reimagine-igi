/**
 * Draws the weapon and ammo pickups (combat/pickups.ts items) as igi.exe does
 * (docs/interactions.md "Pickups (rendering, ammo types)").
 *
 * Recovered:
 *   - GunPickup (class 0x5c1690, FUN_0046b6f0) and AmmoPickup (0x5c16b0,
 *     FUN_0046bfa0) derive from SectorInteriorObject (FUN_004d7560), itself a
 *     RigidDynCubeObj (FUN_004baae0); neither registers a draw method, so they
 *     draw with RigidDynCubeObj's method 4 FUN_00506540: one "DrawRigidMesh"
 *     message (renderer id DAT_00aeca54, named at 0x4c5c3b) for the object's
 *     model +0x6c, then the object's child objects (+8 and +0xe8 lists).
 *   - The model: GunPickup = the weapon's WeaponConfig model (weapon def
 *     +0x61c, compile FUN_0046bbd0); AmmoPickup = DefineAmmoType arg 13 (ammo
 *     def +0x148, compile FUN_0046c350). Both only set +0x6c (FUN_004baaf0):
 *     neither calls FUN_004bab70, the builder of the ATTA child objects that
 *     a held Gun gets (FUN_004770e0 0x477187). So a gun pickup draws the gun
 *     body alone, without its GUNCLIP / GUNMOVINGPART / GUNFLAME parts.
 *   - Pose: position +0xf0 (the "Position" parameter; a dropped gun's falls,
 *     FUN_0046ba20 writes it to the object with FUN_00415810/FUN_004bcb60
 *     every tick) and the rotation +0x70 = FUN_004a9bc0(Orientation) =
 *     Rz(gamma) Ry(beta) Rx(alpha). No spin, bob or scale: the ticks
 *     (FUN_0046ba20, LAB_0046c2c0) only fall and delete.
 *   - Lighting: DrawRigidMesh (FUN_0052e5d0) without a baked lightmap = the
 *     vertex-lit object path: texture x clamp(ambient + front x max(0, n.l)),
 *     n the world normal (docs/formats.md "Object lighting"); object fog,
 *     ZBIAS 3, DNER block kinds (render/object-material.ts).
 *   - Removal: a collected pickup deletes itself on its next tick (+0x129 /
 *     +0x109 -> FUN_00401630); combat/pickups.ts drops it from `items`.
 * Not reproduced: the per-model LOD / cutoff (FUN_0052e5d0 -> FUN_004c4d00):
 * the _1 model is always drawn (pickup models are small and near the player).
 */
import * as THREE from "three";
import { readMipMapControl, type IgiLevel, type LevelModel } from "../../loaders";
import { engineMatrix4, igiPointToEngine, igiRotationToEngine, type Mat3 } from "../../loaders/coords";
import type { Vec3 } from "../../contracts";
import type { GameContext } from "../context";
import type { Pickup } from "../combat/pickups";
import { createLevelTexture } from "../world/world-builder";
import { sharedFogUniforms, type FogUniforms } from "./fog";
import { createObjectMaterial, type BlockKind } from "./object-material";

export interface PickupRenderAssets {
  /** Object fog uniforms (default: the level's shared ones, render/fog.ts). */
  fog?: FogUniforms;
  /** MipMapControl LOD bias uniform (default: read from the level's tasks). */
  mipBias?: THREE.IUniform<number>;
}

export interface PickupRenderer {
  /** Parent of every pickup mesh (added to the scene). */
  readonly group: THREE.Group;
  /** Pickups currently drawn. */
  readonly count: number;
  /**
   * Show `items` (PickupSystem.items) at their current pose: new pickups get
   * meshes, taken or vanished ones lose them. `inWorld` hides pickups whose
   * ConditionalContainer left the world (PickupSystem.inWorld). Call once per
   * rendered frame (dropped guns fall).
   */
  update(items: readonly Pickup[], inWorld?: (p: Pickup) => boolean): void;
  dispose(): void;
}

interface Entry {
  object: THREE.Mesh;
  model: string;
  /** Rotation the vertex light was computed for. */
  rotation: number[];
}

/** Per-vertex D3D7 light of `model` under engine rotation `r` (world normals) [recovered formula]. */
export function pickupVertexLight(model: LevelModel, r: Mat3, light: IgiLevel["objectLight"]): Float32Array {
  const count = model.normals.length / 3;
  const out = new Float32Array(count * 3);
  const l = light.sunDirection;
  for (let i = 0; i < count; i++) {
    const nx = model.normals[i * 3];
    const ny = model.normals[i * 3 + 1];
    const nz = model.normals[i * 3 + 2];
    // Row-major engine rotation applied to the model-space normal.
    let wx = r[0] * nx + r[1] * ny + r[2] * nz;
    let wy = r[3] * nx + r[4] * ny + r[5] * nz;
    let wz = r[6] * nx + r[7] * ny + r[8] * nz;
    const len = Math.hypot(wx, wy, wz) || 1;
    wx /= len;
    wy /= len;
    wz /= len;
    const d = Math.max(0, wx * l[0] + wy * l[1] + wz * l[2]);
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.min(1, light.ambient[c] + light.front[c] * d);
  }
  return out;
}

/** Engine model -> world matrix (column-major) of a pickup: IGI row-major rotation and position [engine = (x, z, -y) / 4096 from originIgi]. */
export function pickupMatrix(p: Pick<Pickup, "position" | "rotation">, originIgi: Vec3): number[] {
  return engineMatrix4(igiRotationToEngine(p.rotation as Mat3), igiPointToEngine(p.position, originIgi));
}

export function createPickupRenderer(ctx: Pick<GameContext, "level">, scene: THREE.Object3D, assets: PickupRenderAssets = {}): PickupRenderer {
  const group = new THREE.Group();
  group.name = "pickups";
  scene.add(group);

  const entries = new Map<Pickup, Entry>();
  let level: IgiLevel | null = null;
  const textures = new Map<string, THREE.Texture>();
  const materials = new Map<string, THREE.ShaderMaterial>();
  let mipBias: THREE.IUniform<number> = assets.mipBias ?? { value: 0 };

  const clearEntries = () => {
    for (const e of entries.values()) {
      group.remove(e.object);
      e.object.geometry.dispose();
    }
    entries.clear();
  };
  const clearCaches = () => {
    for (const m of materials.values()) m.dispose();
    for (const t of textures.values()) t.dispose();
    materials.clear();
    textures.clear();
  };
  /** Rebuild everything for a new level object. */
  const useLevel = (next: IgiLevel | null) => {
    if (next === level) return;
    clearEntries();
    clearCaches();
    level = next;
    if (level && !assets.mipBias) mipBias = { value: readMipMapControl(level.tasks)?.lodBias ?? 0 };
  };

  const textureFor = (key: string): THREE.Texture => {
    let t = textures.get(key);
    if (!t) {
      t = createLevelTexture(level!, key).texture;
      textures.set(key, t);
    }
    return t;
  };
  const materialFor = (texture: string | null, kind: BlockKind): THREE.ShaderMaterial => {
    const key = `${texture ?? "none"}|${kind}`;
    let m = materials.get(key);
    if (!m) {
      m = createObjectMaterial({ map: texture ? textureFor(texture) : null, lightMap: null, kind, fog: assets.fog ?? sharedFogUniforms(), mipBias });
      m.name = `igi-pickup-${kind}`;
      materials.set(key, m);
    }
    return m;
  };
  /** DNER block kinds: from the gun parts that use this model, else opaque (every DefineAmmoType model has flags 0 [observed]). */
  const blockKinds = (model: LevelModel): BlockKind[] => {
    for (const parts of level!.guns.values()) {
      const part = parts.find((x) => x.model === model.name);
      if (part) return model.groups.map((_, i) => (part.blocks[i]?.additive ? "additive" : part.blocks[i]?.deferred ? "deferred" : "opaque"));
    }
    return model.groups.map(() => "opaque");
  };

  const build = (p: Pickup): Entry | null => {
    const model = p.model ? level!.models.get(p.model) : undefined;
    if (!model) return null;
    const r = igiRotationToEngine(p.rotation as Mat3);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(model.positions, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(model.uv, 2));
    geometry.setAttribute("objLight", new THREE.BufferAttribute(pickupVertexLight(model, r, level!.objectLight), 3));
    geometry.setIndex(new THREE.BufferAttribute(model.indices, 1));
    const kinds = blockKinds(model);
    const list: THREE.ShaderMaterial[] = [];
    model.groups.forEach((g, i) => {
      // Type-3 blocks without material have count 0 (not drawn); type-0 ones draw untextured (white x light).
      if (g.count === 0) return;
      geometry.addGroup(g.start, g.count, list.length);
      list.push(materialFor(g.texture, kinds[i]));
    });
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, list);
    mesh.name = `pickup:${p.id}:${model.name}`;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    return { object: mesh, model: model.name, rotation: [...p.rotation] };
  };

  const remove = (p: Pickup, e: Entry) => {
    group.remove(e.object);
    e.object.geometry.dispose();
    entries.delete(p);
  };

  return {
    group,
    get count() {
      return entries.size;
    },
    update(items, inWorld) {
      useLevel(ctx.level);
      if (!level) return;
      const live = new Set<Pickup>();
      for (const p of items) {
        if (p.taken) continue;
        live.add(p);
        let e = entries.get(p);
        // A new model (or rotation) for the same pickup: rebuild its mesh.
        if (e && (e.model !== p.model || e.rotation.some((v, k) => v !== p.rotation[k]))) {
          remove(p, e);
          e = undefined;
        }
        if (!e) {
          const built = build(p);
          if (!built) continue;
          e = built;
          entries.set(p, e);
        }
        e.object.matrix.fromArray(pickupMatrix(p, level.originIgi));
        e.object.matrixWorldNeedsUpdate = true;
        e.object.visible = inWorld ? inWorld(p) : true;
      }
      for (const [p, e] of entries) if (!live.has(p)) remove(p, e);
    },
    dispose() {
      clearEntries();
      clearCaches();
      scene.remove(group);
      level = null;
    },
  };
}
