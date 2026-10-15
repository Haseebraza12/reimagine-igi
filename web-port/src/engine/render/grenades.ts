/**
 * Draws the thrown grenades (combat/grenade.ts) as igi.exe does.
 *
 * Recovered: class "Grenade" registers no draw method (FUN_00474e70), so it
 * draws with the inherited rigid-object method (RigidDynCubeObj FUN_00506540:
 * one DrawRigidMesh of the object's model +0x6c, render/pickups.ts): the
 * weaponconfig "Gun Model" (135_01_1 for the hand grenade, the same model the
 * AMMO_ID_GRENADE pickup shows), vertex-lit with its current rotation, at the
 * object's pose of the last tick. No ATTA parts, no scale. The grenade turns
 * only from the impulses of its bounces (it is thrown with no spin).
 */
import * as THREE from "three";
import { readMipMapControl, type IgiLevel, type LevelModel } from "../../loaders";
import { igiRotationToEngine, type Mat3 } from "../../loaders/coords";
import type { GameContext } from "../context";
import type { Grenade } from "../combat/grenade";
import { createLevelTexture } from "../world/world-builder";
import { sharedFogUniforms, type FogUniforms } from "./fog";
import { createObjectMaterial, type BlockKind } from "./object-material";
import { pickupMatrix, pickupVertexLight } from "./pickups";

export interface GrenadeRenderer {
  readonly group: THREE.Group;
  /** Grenades currently drawn. */
  readonly count: number;
  /** Show `grenades` at their current pose (call once per rendered frame). */
  update(grenades: readonly Grenade[]): void;
  dispose(): void;
}

interface Entry {
  mesh: THREE.Mesh;
  light: THREE.BufferAttribute;
  model: LevelModel;
  rotation: number[];
}

export function createGrenadeRenderer(ctx: Pick<GameContext, "level">, scene: THREE.Object3D, options: { fog?: FogUniforms } = {}): GrenadeRenderer {
  const group = new THREE.Group();
  group.name = "grenades";
  scene.add(group);
  const entries = new Map<Grenade, Entry>();
  const textures = new Map<string, THREE.Texture>();
  const materials = new Map<string, THREE.ShaderMaterial>();
  let level: IgiLevel | null = null;
  let mipBias: THREE.IUniform<number> = { value: 0 };

  const clearEntries = () => {
    for (const e of entries.values()) {
      group.remove(e.mesh);
      e.mesh.geometry.dispose();
    }
    entries.clear();
  };
  const useLevel = (next: IgiLevel | null) => {
    if (next === level) return;
    clearEntries();
    for (const m of materials.values()) m.dispose();
    for (const t of textures.values()) t.dispose();
    materials.clear();
    textures.clear();
    level = next;
    if (level) mipBias = { value: readMipMapControl(level.tasks)?.lodBias ?? 0 };
  };
  const material = (texture: string | null, kind: BlockKind): THREE.ShaderMaterial => {
    const key = `${texture ?? "none"}|${kind}`;
    let m = materials.get(key);
    if (!m) {
      let map: THREE.Texture | null = null;
      if (texture) {
        map = textures.get(texture) ?? null;
        if (!map) {
          map = createLevelTexture(level!, texture).texture;
          textures.set(texture, map);
        }
      }
      m = createObjectMaterial({ map, lightMap: null, kind, fog: options.fog ?? sharedFogUniforms(), mipBias });
      m.name = `igi-grenade-${kind}`;
      materials.set(key, m);
    }
    return m;
  };
  /** DNER block kinds of the gun part using this model (render/pickups.ts), else opaque. */
  const kinds = (model: LevelModel): BlockKind[] => {
    for (const parts of level!.guns.values()) {
      const part = parts.find((x) => x.model === model.name);
      if (part) return model.groups.map((_, i) => (part.blocks[i]?.additive ? "additive" : part.blocks[i]?.deferred ? "deferred" : "opaque"));
    }
    return model.groups.map(() => "opaque");
  };
  const build = (g: Grenade): Entry | null => {
    const model = level!.models.get(g.model) ?? level!.models.get(g.model.toLowerCase());
    if (!model) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(model.positions, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(model.uv, 2));
    const light = new THREE.BufferAttribute(pickupVertexLight(model, igiRotationToEngine(g.matrix), level!.objectLight), 3);
    geometry.setAttribute("objLight", light);
    geometry.setIndex(new THREE.BufferAttribute(model.indices, 1));
    const list: THREE.ShaderMaterial[] = [];
    const k = kinds(model);
    model.groups.forEach((grp, i) => {
      if (grp.count === 0) return;
      geometry.addGroup(grp.start, grp.count, list.length);
      list.push(material(grp.texture, k[i]));
    });
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, list);
    mesh.name = `grenade:${g.id}:${model.name}`;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    return { mesh, light, model, rotation: [...g.matrix] };
  };

  return {
    group,
    get count() {
      return entries.size;
    },
    update(grenades) {
      useLevel(ctx.level);
      if (!level) return;
      const live = new Set<Grenade>();
      for (const g of grenades) {
        live.add(g);
        let e = entries.get(g);
        if (!e) {
          const built = build(g);
          if (!built) continue;
          e = built;
          entries.set(g, e);
        } else if (e.rotation.some((v, i) => v !== g.matrix[i])) {
          // The vertex light follows the rotation (world normals), as for a pickup.
          e.light.copyArray(pickupVertexLight(e.model, igiRotationToEngine(g.matrix as Mat3), level.objectLight));
          e.light.needsUpdate = true;
          e.rotation = [...g.matrix];
        }
        e.mesh.matrix.fromArray(pickupMatrix({ position: g.position, rotation: g.matrix }, level.originIgi));
        e.mesh.matrixWorldNeedsUpdate = true;
      }
      for (const [g, e] of entries) {
        if (live.has(g)) continue;
        group.remove(e.mesh);
        e.mesh.geometry.dispose();
        entries.delete(g);
      }
    },
    dispose() {
      useLevel(null);
      scene.remove(group);
    },
  };
}
