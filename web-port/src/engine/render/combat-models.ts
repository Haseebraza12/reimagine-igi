/**
 * Draws the combat objects' run-time models that are not placed instances of
 * the level: the stationary guns' weapons (M2HB 123_01_1, the Gun task
 * attached to a StationaryGun), the ceiling turrets' guns (456_13_1), the M203
 * grenades in flight (108_05_1) and the RPG missiles (110_02_1).
 *
 * Recovered: these are model objects drawn like any rigid object (the model
 * object's draw method, DrawRigidMesh of +0x6c, render/pickups.ts): the model
 * vertex-lit with its current rotation at the object's pose (+0x20 / +0x70) of
 * the last tick; no ATTA parts are drawn as separate objects except what the
 * caller attaches (the GUNFLAME muzzle flash, fx/muzzle-flash.ts).
 */
import * as THREE from "three";
import { readMipMapControl, type IgiLevel, type LevelModel } from "../../loaders";
import { igiRotationToEngine, type Mat3 } from "../../loaders/coords";
import type { GameContext } from "../context";
import { createLevelTexture } from "../world/world-builder";
import { sharedFogUniforms, type FogUniforms } from "./fog";
import { createObjectMaterial, type BlockKind } from "./object-material";
import { pickupMatrix, pickupVertexLight } from "./pickups";

/** One drawn object: its model and IGI pose (units, row-major rotation). */
export interface CombatModelEntry {
  key: string;
  model: string;
  position: readonly number[];
  matrix: readonly number[];
  /** Objects in the model's local (engine-converted) space, e.g. a muzzle flash. */
  children?: readonly THREE.Object3D[];
}

export interface CombatModelRenderer {
  readonly group: THREE.Group;
  readonly count: number;
  /** Draw exactly `entries` (call once per rendered frame). */
  update(entries: Iterable<CombatModelEntry>): void;
  dispose(): void;
}

interface Entry {
  mesh: THREE.Mesh;
  light: THREE.BufferAttribute;
  model: LevelModel;
  rotation: number[];
  children: readonly THREE.Object3D[];
}

export function createCombatModelRenderer(ctx: Pick<GameContext, "level">, scene: THREE.Object3D, options: { fog?: FogUniforms } = {}): CombatModelRenderer {
  const group = new THREE.Group();
  group.name = "combat-models";
  scene.add(group);
  const entries = new Map<string, Entry>();
  const textures = new Map<string, THREE.Texture>();
  const materials = new Map<string, THREE.ShaderMaterial>();
  let level: IgiLevel | null = null;
  let mipBias: THREE.IUniform<number> = { value: 0 };

  const drop = (key: string, e: Entry) => {
    for (const c of e.children) e.mesh.remove(c);
    group.remove(e.mesh);
    e.mesh.geometry.dispose();
    entries.delete(key);
  };
  const useLevel = (next: IgiLevel | null) => {
    if (next === level) return;
    for (const [k, e] of [...entries]) drop(k, e);
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
      m.name = `igi-combat-${kind}`;
      materials.set(key, m);
    }
    return m;
  };
  /** DNER block kinds of a gun part using this model, else opaque. */
  const kinds = (model: LevelModel): BlockKind[] => {
    for (const parts of level!.guns.values()) {
      const part = parts.find((x) => x.model === model.name);
      if (part) return model.groups.map((_, i) => (part.blocks[i]?.additive ? "additive" : part.blocks[i]?.deferred ? "deferred" : "opaque"));
    }
    return model.groups.map(() => "opaque");
  };
  const build = (e: CombatModelEntry): Entry | null => {
    const model = level!.models.get(e.model) ?? level!.models.get(e.model.toLowerCase());
    if (!model) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(model.positions, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(model.uv, 2));
    const light = new THREE.BufferAttribute(pickupVertexLight(model, igiRotationToEngine(e.matrix as Mat3), level!.objectLight), 3);
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
    mesh.name = `combat:${e.key}:${model.name}`;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    const children = e.children ?? [];
    for (const c of children) mesh.add(c);
    return { mesh, light, model, rotation: [...e.matrix], children };
  };

  return {
    group,
    get count() {
      return entries.size;
    },
    update(list) {
      useLevel(ctx.level);
      if (!level) return;
      const live = new Set<string>();
      for (const item of list) {
        live.add(item.key);
        let e = entries.get(item.key);
        if (e && e.model.name !== item.model && e.model.name !== item.model.toLowerCase()) {
          drop(item.key, e);
          e = undefined;
        }
        if (!e) {
          const built = build(item);
          if (!built) continue;
          e = built;
          entries.set(item.key, e);
        } else if (e.rotation.some((v, i) => v !== item.matrix[i])) {
          // The vertex light follows the rotation (world normals), as for a pickup.
          e.light.copyArray(pickupVertexLight(e.model, igiRotationToEngine(item.matrix as Mat3), level.objectLight));
          e.light.needsUpdate = true;
          e.rotation = [...item.matrix];
        }
        e.mesh.matrix.fromArray(pickupMatrix({ position: item.position as [number, number, number], rotation: item.matrix as Mat3 }, level.originIgi));
        e.mesh.matrixWorldNeedsUpdate = true;
      }
      for (const [k, e] of [...entries]) if (!live.has(k)) drop(k, e);
    },
    dispose() {
      useLevel(null);
      scene.remove(group);
    },
  };
}
