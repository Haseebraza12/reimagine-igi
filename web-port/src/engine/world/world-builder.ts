/**
 * Builds the renderable world and its collision from a decoded IgiLevel.
 *
 * Collision [recovered, docs/collision.md]: every placed instance adds its
 * model's own HSMC collision sets, posed by the instance matrix: set 1 (the
 * HumanCollision hull, about 0.2 m outside the walls) for the character sweep
 * and ground probe, set 0 (the visible faces with their surface materials)
 * for bullets and AI sight. Glass is skipped by sight; models without
 * collision chunks never collide; nothing is alpha-tested. Moving tasks
 * become dynamic bodies.
 *
 * Rendering follows the recovered igi.exe states (docs/rendering.md 5-6,
 * render/object-material.ts):
 *   - each DNER block is opaque (Z write, no blend, no alpha test), deferred
 *     (flag != 0: after the opaque pass, depth sorted, SRCALPHA/INVSRCALPHA,
 *     alpha > 1/255, no Z write) or additive (flag bit 0: ONE/ONE, unlit,
 *     unfogged) - texture alpha no longer decides it;
 *   - lighting: instances listed in a building's LightmapInfo draw texture x
 *     baked .olm lightmap (atlas, uv1); all others texture x clamp(ambient +
 *     front * max(0, n.l)) per vertex (D3D7 fixed-function, Gouraud), in
 *     device (gamma) space (docs/formats.md "Object lighting");
 *   - object fog (EXP, radial), objects ZBIAS 3, cull CCW (D3D);
 *   - model LOD per instance per frame (world/lod.ts): every LOD variant of
 *     every instance is pre-built; update(camera) shows the chosen variant or
 *     none (beyond the cutoff).
 * Moving entries are keyed by the placing task's pre-order index
 * (LevelInstance.taskIndex = the mission runtime's node index), unique even
 * for the many tasks with id -1: setTaskTransform / setTaskHidden act on all
 * instances of a task (render + its collision body, body id = the key), and
 * setInstanceTransform moves one instance's render entries (rotor spin, car
 * wheels). `renderCopies` adds extra render-only copies of an instance (the
 * rotor blur fans of docs/vehicles.md); they follow setTaskTransform and are
 * posed one by one with setInstanceTransform(i, matrix, copy).
 * Draw calls: opaque blocks are merged per (texture, lighting path) into one
 *   THREE.BatchedMesh each (one multi-draw call, per-entry visibility and
 *   frustum culling). igi.exe sorts ALL deferred blocks by depth in one queue
 *   (FUN_004ad570); here deferred/additive blocks are batched per (material,
 *   BLENDED_CELL_M square cell of the instance centre): entries inside a batch
 *   are sorted back to front by their centres every frame, and batches are
 *   sorted back to front by Three's transparent pass [approximation: the
 *   global order is exact within a material and cell, cell-granular across
 *   them; a per-block mesh would be exact but cost ~1000 draw calls].
 */
import * as THREE from "three";
import { decodeLevelTexture, type IgiLevel, type LevelInstance, type LevelModel } from "../../loaders";
import type { DecodedTexture } from "../../contracts";
import { CollisionWorldBuilder, TRI_BULLET, TRI_SIGHT, TRI_SOLID, type CollisionWorld } from "./collision";
import { buildLightmapAtlas, type AtlasRect } from "./lightmap-atlas";
import { chooseLod, tanHalfFovX, type InstanceLodInput } from "./lod";
import type { BlockFlags, LodVariant, ModelLodLibrary } from "./model-lods";
import { boundingSphereOf } from "./model-lods";
import { NO_FOG, type FogUniforms } from "../render/fog";
import { applyObjectSampler, createObjectMaterial, type BlockKind } from "../render/object-material";

export interface BuiltWorld {
  group: THREE.Group;
  collision: CollisionWorld;
  stats: {
    instances: number;
    triangles: number;
    /** Upper bound of GL draw calls (one multi-draw per batch). */
    drawCalls: number;
    textures: number;
    /** All batches (opaque + blended). */
    batches: number;
    /** Deferred/additive batches (material x cell). */
    blendedBatches: number;
    /** Instance blocks over all LOD variants. */
    lodEntries: number;
    /** Instances with more than one LOD variant. */
    instancesWithLods: number;
  };
  /** Per-frame model LOD and cutoff culling for `camera` (installed as a scene hook by engine/level.ts). */
  update(camera: THREE.Camera): void;
  /** Current LOD of placed instance `i` (-1 = culled), after the last update. */
  lodOf(i: number): number;
  /**
   * Move a dynamic task's instances (doors, vehicles): `matrix` (column-major,
   * rigid, engine space) maps their build pose to the current pose. Render and
   * collision (body id = `key`) follow. `key` is the task's pre-order index
   * (LevelInstance.taskIndex, = MissionTasks node index). No-op for tasks that
   * are not dynamic.
   */
  setTaskTransform(key: number, matrix: ArrayLike<number>): void;
  /**
   * Move the render entries of placed instance `i` (or of its render copy
   * `copy` >= 1) only: `matrix` maps its build pose to the current pose. Its
   * task must be dynamic. Call after setTaskTransform of the same tick (that
   * one resets all of the task's entries). Collision stays with the task body.
   */
  setInstanceTransform(i: number, matrix: ArrayLike<number>, copy?: number): void;
  /** Hide (and remove from collision) a dynamic task's instances, e.g. outside the world. */
  setTaskHidden(key: number, hidden: boolean): void;
  /** Task keys (pre-order task indices) built as dynamic, plus the SCamera lens keys (scameraLensKey). */
  readonly dynamicTasks: ReadonlySet<number>;
  /**
   * Placed instances that can be removed or swapped at run time (docs/damage.md):
   * TASKTYPE_GLASS and TASKTYPE_EXPLODEMAGICOBJ sub-models and the root model of
   * ExplodeObject / Terminal / AlarmControl / SCameraControl / Switch tasks.
   */
  readonly destructibleInstances: ReadonlySet<number>;
  /**
   * Replace destructible instance `i` by `model` at the same pose (the
   * "Destroyed model" swap, FUN_004baaf0) or remove it (null: a broken glass
   * pane, FUN_00401630). Render and collision (sets 0 and 1) follow; a swap of
   * an instance of a dynamic task follows that task's transform and hidden
   * state. Returns false when `i` is not destructible.
   */
  setInstanceModel(i: number, model: LevelModel | null): boolean;
  /** Undo every setInstanceModel (mission restart). */
  resetInstanceModels(): void;
  /**
   * Current model -> world matrix (column-major, engine space) of placed
   * instance `i`: its placement times its dynamic task's current transform.
   */
  instanceWorldMatrix(i: number): number[] | null;
  dispose(): void;
}

/**
 * Collision body id of the destructible instances of static tasks (one
 * shared body, rebuilt when one of them is removed or swapped). Above every
 * task key, so `-1 - RayHit.triangle` never names a task for it.
 */
export const DESTRUCTIBLE_BODY_ID = 1_000_000;

/**
 * Dynamic keys of SCamera lenses (LevelInstance.part "scameraLens"): key =
 * SCAMERA_LENS_KEY_BASE + the SCamera's node index. The lens is an object of
 * its own (SCameraLens) that turns every tick about its pivot while the
 * holder stays put, so it gets its own key (render entries + collision body),
 * always dynamic. Above DESTRUCTIBLE_BODY_ID and every task key.
 */
export const SCAMERA_LENS_KEY_BASE = 2_000_000;

/** Dynamic key of the lens of SCamera node `node`. */
export function scameraLensKey(node: number): number {
  return SCAMERA_LENS_KEY_BASE + node;
}

/** Task node index a dynamic key belongs to (a lens key names its SCamera). */
export function taskNodeOfKey(key: number): number {
  return key >= SCAMERA_LENS_KEY_BASE ? key - SCAMERA_LENS_KEY_BASE : key;
}

/** Task types whose root model can be destroyed (docs/damage.md). */
const DESTRUCTIBLE_ROOT_TASKS = new Set(["ExplodeObject", "Terminal", "AlarmControl", "SCameraControl", "Switch"]);

/** Is placed instance `instance` destructible (removable / swappable at run time)? */
export function isDestructibleInstance(instance: LevelInstance): boolean {
  if (instance.glass || instance.magicType === "TASKTYPE_EXPLODEMAGICOBJ") return true;
  if (instance.part === "scameraLens") return true; // "Camera Destroyed Model" swap (0x440bc3)
  return (instance.attachmentPath ?? "") === "" && instance.part === undefined && DESTRUCTIBLE_ROOT_TASKS.has(instance.taskType);
}

/**
 * Instances whose vertex light is recomputed when they turn: D3D lights every
 * vertex-lit object with its current world matrix each frame (docs/rendering.md
 * 5; E026). Every moving instance (the callers also require a dynamic task):
 * SCamera lenses, doors, trains, helicopters, the truck.
 */
const relitInstance = (_instance: LevelInstance): boolean => true;

export interface BuildWorldOptions {
  /**
   * Task keys (pre-order task indices, LevelInstance.taskIndex) whose
   * instances can move or leave the world (their collision becomes a dynamic
   * body with that id).
   */
  dynamicTasks?: ReadonlySet<number>;
  /** Extra render-only copies per placed instance index (instances of dynamic tasks only). */
  renderCopies?: ReadonlyMap<number, number>;
  /** LOD variants, DNER flags and LOD distances (world/model-lods.ts). Without it: one variant, all blocks opaque. */
  lods?: ModelLodLibrary | null;
  fog?: FogUniforms;
  /** Shared MipMapControl LOD-bias uniform. */
  mipBias?: THREE.IUniform<number>;
  /** LOD detail factor (1 = GOGfxPerformance 0). */
  detail?: number;
}

/** GPU texture for a level texture key (object stage-0 sampler state). */
export function createLevelTexture(level: IgiLevel, key: string): { texture: THREE.DataTexture } {
  const decoded = decodeLevelTexture(level, key);
  const texture = new THREE.DataTexture(
    new Uint8Array(decoded.rgba.buffer as ArrayBuffer, decoded.rgba.byteOffset, decoded.rgba.byteLength),
    decoded.width,
    decoded.height,
    THREE.RGBAFormat,
  );
  // Rows are stored top-down and IGI v = 0 is the top row (verified with the
  // "V-17" label texture), so no flip.
  texture.flipY = false;
  applyObjectSampler(texture); // LINEAR, MIPFILTER POINT, WRAP [recovered]
  texture.needsUpdate = true;
  return { texture };
}

/** Block kind from the DNER flags [recovered FUN_0052f2c0]. */
export function blockKind(flags: BlockFlags | undefined): BlockKind {
  if (!flags) return "opaque";
  if (flags.additive) return "additive";
  return flags.deferred ? "deferred" : "opaque";
}

/** Square cell (m) that groups deferred/additive blocks into sorted batches. */
export const BLENDED_CELL_M = 32;

/** One instance block (group) of one LOD variant: where it lives in the scene. */
interface EntryRef {
  batch: BatchState;
  id: number;
}

interface BatchState {
  mesh: THREE.BatchedMesh;
  visibleCount: number;
}

interface LodInstance {
  hidden: boolean;
  /** Removed or swapped by setInstanceModel (independent of the task's hidden state). */
  removed: boolean;
  /** Dynamic task key, or -1 for static entries. */
  key: number;
  centre: THREE.Vector3;
  /** Centre at the build pose (dynamic entries move `centre` with their transform). */
  buildCentre: THREE.Vector3;
  input: InstanceLodInput;
  variants: EntryRef[][];
  current: number;
}

/** World-space collision triangles of one placed instance in its build pose (one HSMC set). */
interface PosedSet {
  positions: Float32Array;
  indices: Uint32Array;
  flags: number;
  material: Int16Array;
  owner: number;
}

/** A collision body that can be rebuilt without some of its instances. */
interface RebuildableBody {
  /** Placed instance index -> its posed sets (all instances in the body). */
  members: Map<number, PosedSet[]>;
  /** Current transform (column-major) and enabled state, as last set. */
  matrix: Float64Array | null;
  enabled: boolean;
}

interface PendingBatch {
  texture: string | null;
  page: number | null;
  kind: BlockKind;
  blocks: PendingBlock[];
  vertices: number;
}

interface PendingBlock {
  positions: Float32Array;
  uv: Float32Array;
  /** objLmUv (2 per vertex) or objLight (3 per vertex). */
  second: Float32Array;
  /** Deferred lightmapped blocks: objLight as well (texture x vertex light x lightmap), else null. */
  light: Float32Array | null;
  /** Render entry index. */
  instance: number;
  variant: number;
  /** Belongs to a dynamic task (it moves: the batch cannot be culled by its build-time bounding sphere). */
  dynamic: boolean;
  /** Relit instances: build-pose world normals per block vertex (objLight is recomputed when it turns). */
  normals: Float32Array | null;
}

/** objLight range of one relit block inside its batch. */
interface RelitBlock {
  batch: BatchState;
  geometryId: number;
  /** Build-pose world normals (3 per vertex). */
  normals: Float32Array;
}

export function buildWorld(level: IgiLevel, extra?: (builder: CollisionWorldBuilder) => void, options: BuildWorldOptions = {}): BuiltWorld {
  const collision = new CollisionWorldBuilder();
  const light = level.objectLight;
  const fog = options.fog ?? NO_FOG;
  const mipBias = options.mipBias ?? { value: 0 };
  const lods = options.lods ?? null;
  const detail = options.detail ?? 1;
  const m4 = new THREE.Matrix4();
  const n3 = new THREE.Matrix3();
  const v = new THREE.Vector3();
  let triangles = 0;
  const textures = new Map<string, { texture: THREE.DataTexture }>();
  const disposables: Array<{ dispose(): void }> = [];

  const textureFor = (key: string) => {
    let entry = textures.get(key);
    if (!entry) {
      entry = createLevelTexture(level, key);
      textures.set(key, entry);
      disposables.push(entry.texture);
    }
    return entry;
  };
  // --- Collision: the models' own HSMC sets (docs/collision.md) -------------
  const worldPositions = (positions: Float32Array, matrix: THREE.Matrix4): Float32Array => {
    const count = positions.length / 3;
    const world = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      v.fromArray(positions, i * 3).applyMatrix4(matrix);
      world[i * 3] = v.x;
      world[i * 3 + 1] = v.y;
      world[i * 3 + 2] = v.z;
    }
    return world;
  };
  const dynamicTasks = new Set<number>(options.dynamicTasks ?? []);
  for (const instance of level.instances) {
    if (instance.part === "scameraLens" && instance.taskIndex !== undefined) dynamicTasks.add(scameraLensKey(instance.taskIndex));
  }
  /** Dynamic key of an instance (its task's pre-order index; an SCamera lens: its lens key), or -1 when static. */
  const keyOf = (instance: LevelInstance): number => {
    if (instance.taskIndex === undefined) return -1;
    if (instance.part === "scameraLens") return scameraLensKey(instance.taskIndex);
    return dynamicTasks.has(instance.taskIndex) ? instance.taskIndex : -1;
  };
  /** The collision sets of `model` placed like `instance`, in world space (build pose). */
  const posedSetsOf = (model: LevelModel, instance: LevelInstance, owner: number): PosedSet[] => {
    const sets = model.collision;
    if (!sets) return []; // no collision chunks: nothing collides with it in the original either
    m4.fromArray(instance.collisionMatrix ?? instance.matrix);
    const [visible, hull] = sets;
    // Wires: sight method cleared (0x43e2f9), the sweep filter always skips them (0x4159a0).
    const wire = instance.taskType === "Wire";
    const out: PosedSet[] = [];
    // Set 0: bullets (filter 0x53742f) and AI sight (filter 0x53f120 skips Glass).
    if (visible.indices.length > 0) {
      const flags = instance.glass || wire ? TRI_BULLET : TRI_BULLET | TRI_SIGHT;
      out.push({ positions: worldPositions(visible.positions, m4), indices: visible.indices, flags, material: visible.material, owner });
    }
    // Set 1: the character sweep and ground probe.
    if (hull.indices.length > 0 && !wire) {
      out.push({ positions: worldPositions(hull.positions, m4), indices: hull.indices, flags: TRI_SOLID, material: hull.material, owner });
    }
    return out;
  };
  // Destructible instances (glass, explosives; docs/damage.md) of static tasks share one
  // rebuildable body; those of dynamic tasks stay in their task's body, which is then
  // rebuilt without them. Rebuilt bodies keep every member's posed triangles.
  const destructibleInstances = new Set<number>();
  level.instances.forEach((instance, i) => {
    if (level.models.has(instance.model) && isDestructibleInstance(instance)) destructibleInstances.add(i);
  });
  const rebuildable = new Map<number, RebuildableBody>();
  for (const i of destructibleInstances) {
    const key = keyOf(level.instances[i]);
    const id = key >= 0 ? key : DESTRUCTIBLE_BODY_ID;
    if (!rebuildable.has(id)) rebuildable.set(id, { members: new Map(), matrix: null, enabled: true });
  }
  /** Collision body of placed instance i: its dynamic task key, DESTRUCTIBLE_BODY_ID, or -1 (static). */
  const bodyOf = (i: number): number => {
    const key = keyOf(level.instances[i]);
    return key >= 0 ? key : destructibleInstances.has(i) ? DESTRUCTIBLE_BODY_ID : -1;
  };
  level.instances.forEach((instance, owner) => {
    const model = level.models.get(instance.model);
    if (!model) return;
    triangles += model.indices.length / 3;
    const body = bodyOf(owner);
    const sets = posedSetsOf(model, instance, owner);
    rebuildable.get(body)?.members.set(owner, sets);
    if (sets.length === 0) return;
    collision.setTarget(body >= 0 ? body : null);
    for (const s of sets) collision.addIndexed(s.positions, s.indices, s.flags, s.material, s.owner);
  });
  collision.setTarget(null);
  extra?.(collision);

  // --- Variants and lightmaps per instance ------------------------------------
  const variantsOf = (instance: LevelInstance): LodVariant[] => {
    const info = lods?.info(instance.model);
    if (info) return info.variants;
    const model = level.models.get(instance.model);
    return model ? [{ name: model.name, model, flags: model.groups.map(() => ({ deferred: false, additive: false })), faces: model.indices.length / 3, lightmapSize: null }] : [];
  };
  const extraLightmaps = new Map<string, DecodedTexture>();
  const lightmapNames: Array<Array<string | null>> = level.instances.map((instance) =>
    variantsOf(instance).map((variant, k) => {
      if (!instance.lightmap || !variant.model.lightmapUv) return null;
      if (k === 0) return level.lightmaps.has(instance.lightmap) ? instance.lightmap : null;
      const name = lods?.lightmapFor(instance.lightmap, k) ?? null;
      const decoded = name ? lods!.lightmaps.get(name) : undefined;
      if (!name || !decoded) return null;
      // The .olm must match the variant's PMTL size (else the game re-bakes; we fall back to vertex light).
      if (variant.lightmapSize && (decoded.width !== variant.lightmapSize[0] || decoded.height !== variant.lightmapSize[1])) return null;
      extraLightmaps.set(name, decoded);
      return name;
    }),
  );
  const atlas = buildLightmapAtlas(new Map([...level.lightmaps, ...extraLightmaps]));
  disposables.push(atlas);

  // --- Blocks -> batches / meshes ------------------------------------------------
  const group = new THREE.Group();
  group.name = "level-geometry";
  const materials = new Map<string, THREE.ShaderMaterial>();
  const materialFor = (texture: string | null, page: number | null, kind: BlockKind): THREE.ShaderMaterial => {
    const key = `${texture ?? "none"}|${page ?? "vl"}|${kind}`;
    let material = materials.get(key);
    if (!material) {
      material = createObjectMaterial({
        map: texture ? textureFor(texture).texture : null,
        lightMap: page !== null ? atlas.pages[page] : null,
        kind,
        fog,
        mipBias,
        // FUN_0052f780 / FUN_0052f2c0: LIGHTING on, stage 0 MODULATE(TEXTURE, DIFFUSE) for deferred
        // lightmapped blocks (FVF 0x212 has normals) [recovered]; opaque ones stay unlit.
        litLightmap: page !== null && kind === "deferred",
      });
      materials.set(key, material);
      disposables.push(material);
    }
    return material;
  };

  const pending = new Map<string, PendingBatch>();
  const lodInstances: LodInstance[] = [];
  const refs: EntryRef[][][] = [];
  let blendedBatches = 0;
  let lodEntries = 0;
  let instancesWithLods = 0;

  // Render entries: every placed instance, then the render-only copies (appended,
  // so render index i = placed instance i for i < level.instances.length).
  const renders: Array<{ instance: LevelInstance; source: number }> = level.instances.map((instance, source) => ({ instance, source }));
  /** renderIndexOf[i][copy]: render entry of placed instance i (copy 0 = itself). */
  const renderIndexOf: number[][] = level.instances.map((_, i) => [i]);
  for (const [source, extra] of options.renderCopies ?? []) {
    const instance = level.instances[source];
    if (!instance || keyOf(instance) < 0) continue;
    for (let c = 0; c < extra; c++) {
      renderIndexOf[source].push(renders.length);
      renders.push({ instance, source });
    }
  }

  renders.forEach(({ instance, source }, ii) => {
    const variants = variantsOf(instance);
    const relit = relitInstance(instance) && keyOf(instance) >= 0;
    m4.fromArray(instance.matrix);
    n3.getNormalMatrix(m4);
    const info = lods?.info(instance.model) ?? null;
    const sphere = info ?? (variants[0] ? boundingSphereOf(variants[0].model.positions) : { centre: [0, 0, 0] as [number, number, number], radius: 0 });
    const scale = Math.max(
      new THREE.Vector3().setFromMatrixColumn(m4, 0).length(),
      new THREE.Vector3().setFromMatrixColumn(m4, 1).length(),
      new THREE.Vector3().setFromMatrixColumn(m4, 2).length(),
    );
    const centre = new THREE.Vector3().fromArray(sphere.centre).applyMatrix4(m4);
    lodInstances.push({
      hidden: false,
      removed: false,
      key: keyOf(instance),
      centre,
      buildCentre: centre.clone(),
      input: {
        kind: info?.kind ?? (instance.model.includes(":") ? "spline" : "rigid"),
        faces: variants.map((x) => x.faces),
        radiusM: sphere.radius * scale,
        explicit: info?.explicit ?? null,
      },
      variants: [],
      current: -2,
    });
    if (variants.length > 1) instancesWithLods++;
    refs.push(variants.map(() => []));

    variants.forEach((variant, k) => {
      const model = variant.model;
      const count = model.positions.length / 3;
      const world = worldPositions(model.positions, m4);
      const lmName = lightmapNames[source][k];
      const rect: AtlasRect | null = lmName ? atlas.rects.get(lmName) ?? null : null;
      // Per model vertex: atlas uv1 (lightmapped) or lit vertex colour (vertex-lit).
      let second: Float32Array;
      // The vertex light (vertex-lit blocks; deferred lightmapped blocks multiply it in as well).
      const lit = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        v.fromArray(model.normals, i * 3).applyMatrix3(n3).normalize();
        const d = Math.max(0, v.x * light.sunDirection[0] + v.y * light.sunDirection[1] + v.z * light.sunDirection[2]);
        for (let c = 0; c < 3; c++) lit[i * 3 + c] = Math.min(1, light.ambient[c] + light.front[c] * d);
      }
      if (rect) {
        second = new Float32Array(count * 2);
        for (let i = 0; i < count; i++) {
          const [u, w] = atlas.remap(rect, model.lightmapUv![i * 2], model.lightmapUv![i * 2 + 1]);
          second[i * 2] = u;
          second[i * 2 + 1] = w;
        }
      } else {
        second = lit;
      }
      const stride = rect ? 2 : 3;
      model.groups.forEach((g, gi) => {
        if (g.count === 0) return;
        const kind = blockKind(variant.flags[gi]);
        const p = new Float32Array(g.count * 3);
        const uv = new Float32Array(g.count * 2);
        const sec = new Float32Array(g.count * stride);
        const litLm = rect && kind === "deferred" ? new Float32Array(g.count * 3) : null;
        for (let j = 0; j < g.count; j++) {
          const index = model.indices[g.start + j];
          p.set(world.subarray(index * 3, index * 3 + 3), j * 3);
          uv[j * 2] = model.uv[index * 2];
          uv[j * 2 + 1] = model.uv[index * 2 + 1];
          sec.set(second.subarray(index * stride, index * stride + stride), j * stride);
          if (litLm) litLm.set(lit.subarray(index * 3, index * 3 + 3), j * 3);
        }
        let normals: Float32Array | null = null;
        if (relit && (!rect || litLm)) {
          normals = new Float32Array(g.count * 3);
          for (let j = 0; j < g.count; j++) {
            v.fromArray(model.normals, model.indices[g.start + j] * 3).applyMatrix3(n3).normalize();
            normals[j * 3] = v.x;
            normals[j * 3 + 1] = v.y;
            normals[j * 3 + 2] = v.z;
          }
        }
        lodEntries++;
        const page = rect ? rect.page : null;
        const centre = lodInstances[ii].centre;
        const cell = kind === "opaque" ? "" : `|${Math.floor(centre.x / BLENDED_CELL_M)},${Math.floor(centre.z / BLENDED_CELL_M)}`;
        const key = `${g.texture ?? "none"}|${page ?? "vl"}|${kind}${cell}`;
        let batch = pending.get(key);
        if (!batch) {
          batch = { texture: g.texture, page, kind, blocks: [], vertices: 0 };
          pending.set(key, batch);
        }
        batch.blocks.push({ positions: p, uv, second: sec, light: litLm, instance: ii, variant: k, dynamic: lodInstances[ii].key >= 0, normals });
        batch.vertices += g.count;
      });
    });
  });

  // Batches: opaque per (texture, lighting path); blended also per cell.
  const batches: BatchState[] = [];
  /** Relit blocks per dynamic key, and per render entry (instances moved on their own: train cars, copies). */
  const relitBlocks = new Map<number, RelitBlock[]>();
  const relitByEntry = new Map<number, RelitBlock[]>();
  for (const p of pending.values()) {
    const material = materialFor(p.texture, p.page, p.kind);
    const batch = new THREE.BatchedMesh(p.blocks.length, p.vertices, 0, material);
    batch.name = `${p.texture ?? "untextured"}|${p.page === null ? "vertex-lit" : "lightmapped"}|${p.kind}`;
    // Opaque: order irrelevant (Z buffer). Blended: back to front per entry
    // every frame (no Z write). Both frustum-cull per entry, so a batch with
    // nothing on screen issues no GL draw.
    batch.sortObjects = p.kind !== "opaque";
    batch.perObjectFrustumCulled = true;
    batch.matrixAutoUpdate = false;
    const state: BatchState = { mesh: batch, visibleCount: 0 };
    const secondName = p.page === null ? "objLight" : "objLmUv";
    const secondSize = p.page === null ? 3 : 2;
    for (const block of p.blocks) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(block.positions, 3));
      geometry.setAttribute("uv", new THREE.BufferAttribute(block.uv, 2));
      geometry.setAttribute(secondName, new THREE.BufferAttribute(block.second, secondSize));
      if (block.light) geometry.setAttribute("objLight", new THREE.BufferAttribute(block.light, 3));
      const geometryId = batch.addGeometry(geometry);
      const id = batch.addInstance(geometryId);
      batch.setVisibleAt(id, false);
      refs[block.instance][block.variant].push({ batch: state, id });
      if (block.normals) {
        const key = lodInstances[block.instance].key;
        const rb = { batch: state, geometryId, normals: block.normals };
        const list = relitBlocks.get(key) ?? [];
        list.push(rb);
        relitBlocks.set(key, list);
        const own = relitByEntry.get(block.instance) ?? [];
        own.push(rb);
        relitByEntry.set(block.instance, own);
      }
    }
    batch.computeBoundingSphere();
    // A batch with moving entries keeps per-entry frustum culling (current
    // matrices) but not the whole-batch test against its build-time sphere.
    if (p.blocks.some((b) => b.dynamic)) batch.frustumCulled = false;
    batch.visible = false;
    group.add(batch);
    batches.push(state);
    if (p.kind !== "opaque") blendedBatches++;
    disposables.push(batch);
  }
  lodInstances.forEach((inst, i) => (inst.variants = refs[i]));

  const setVariant = (inst: LodInstance, index: number, visible: boolean) => {
    if (index < 0 || index >= inst.variants.length) return;
    for (const ref of inst.variants[index]) {
      ref.batch.mesh.setVisibleAt(ref.id, visible);
      ref.batch.visibleCount += visible ? 1 : -1;
    }
  };

  const camPos = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const d = new THREE.Vector3();
  const update = (camera: THREE.Camera) => {
    camera.updateMatrixWorld();
    camPos.setFromMatrixPosition(camera.matrixWorld);
    forward.set(0, 0, -1).transformDirection(camera.matrixWorld);
    const persp = camera as THREE.PerspectiveCamera;
    // The first-person zoom changes the FOV and therefore the LOD (igi.exe uses the current tanX).
    const tanX = persp.isPerspectiveCamera ? tanHalfFovX(persp.fov, persp.aspect) : 1;
    const settings = lods?.settings ?? null;
    for (const inst of lodInstances) {
      const depth = d.subVectors(inst.centre, camPos).dot(forward);
      const lod = inst.hidden || inst.removed ? -1 : chooseLod(inst.input, depth, tanX, settings, detail);
      if (lod === inst.current) continue;
      setVariant(inst, inst.current, false);
      setVariant(inst, lod, true);
      inst.current = lod;
    }
    for (const b of batches) b.mesh.visible = b.visibleCount > 0;
    swapGroup.visible = swapGroup.children.length > 0;
  };

  const collisionWorld = collision.build(4);
  const instancesOfTask = new Map<number, LodInstance[]>();
  for (const inst of lodInstances) {
    if (inst.key < 0) continue;
    const list = instancesOfTask.get(inst.key) ?? [];
    list.push(inst);
    instancesOfTask.set(inst.key, list);
  }
  const delta = new THREE.Matrix4();
  const moveEntry = (inst: LodInstance) => {
    for (const variant of inst.variants) for (const ref of variant) ref.batch.mesh.setMatrixAt(ref.id, delta);
    inst.centre.copy(inst.buildCentre).applyMatrix4(delta);
  };
  /** Vertex light clamp(ambient + front x max(0, n.l)) of build-pose normals turned by `rot`, into `out` from vertex `offset`. */
  const relightInto = (out: Float32Array, offset: number, normals: Float32Array, rot: THREE.Matrix3) => {
    for (let j = 0; j < normals.length / 3; j++) {
      v.fromArray(normals, j * 3).applyMatrix3(rot);
      const dot = Math.max(0, v.x * light.sunDirection[0] + v.y * light.sunDirection[1] + v.z * light.sunDirection[2]);
      for (let c = 0; c < 3; c++) out[(offset + j) * 3 + c] = Math.min(1, light.ambient[c] + light.front[c] * dot);
    }
  };
  const relitRotation = new THREE.Matrix3();
  /** Relight the batched blocks of dynamic key `key` for its current transform (`delta`). */
  const relightKey = (key: number, list = relitBlocks.get(key)) => {
    if (!list) return;
    relitRotation.setFromMatrix4(delta);
    for (const r of list) {
      const range = r.batch.mesh.getGeometryRangeAt(r.geometryId);
      const attr = r.batch.mesh.geometry.getAttribute("objLight") as THREE.BufferAttribute | undefined;
      if (!range || !attr) continue;
      relightInto(attr.array as Float32Array, range.vertexStart, r.normals, relitRotation);
      attr.addUpdateRange(range.vertexStart * 3, r.normals.length);
      attr.needsUpdate = true;
    }
  };

  // --- Destructible instances: removal and model swaps (docs/damage.md) ----------
  /** Current transform and hidden state of the dynamic tasks, as last set. */
  const taskMatrix = new Map<number, Float64Array>();
  const taskHidden = new Map<number, boolean>();
  /** Swapped / removed instances: the replacement model (null = removed), its meshes and posed collision. */
  const swaps = new Map<number, { meshes: THREE.Mesh[]; sets: PosedSet[] }>();
  const swapGroup = new THREE.Group();
  swapGroup.name = "destroyed-models";
  group.add(swapGroup);
  /** Bodies left without triangles by removals: kept switched off until reset. */
  const emptied = new Set<number>();
  /** Rebuild a rebuildable body from its members, with swapped instances replaced. */
  const rebuildBody = (id: number) => {
    const body = rebuildable.get(id);
    if (!body) return;
    const builder = new CollisionWorldBuilder();
    let count = 0;
    for (const [i, sets] of body.members) {
      for (const s of swaps.get(i)?.sets ?? sets) {
        builder.addIndexed(s.positions, s.indices, s.flags, s.material, s.owner);
        count += s.indices.length / 3;
      }
    }
    if (count === 0) {
      emptied.add(id);
      collisionWorld.setBodyEnabled(id, false);
      return;
    }
    emptied.delete(id);
    collisionWorld.addBody(id, builder.build(4));
    if (body.matrix) collisionWorld.setBodyTransform(id, body.matrix);
    if (!body.enabled) collisionWorld.setBodyEnabled(id, false);
  };
  /** Render meshes of `model` placed like instance i (vertex-lit; destroyed models have no baked lightmap). */
  const replacementMeshes = (i: number, model: LevelModel): THREE.Mesh[] => {
    const instance = level.instances[i];
    m4.fromArray(instance.matrix);
    n3.getNormalMatrix(m4);
    const world = worldPositions(model.positions, m4);
    const flags = lods?.info(model.name)?.variants[0]?.flags;
    const relit = relitInstance(instance) && keyOf(instance) >= 0;
    const out: THREE.Mesh[] = [];
    model.groups.forEach((g, gi) => {
      if (g.count === 0 || (g.noMaterial && model.modelType === 3)) return;
      const p = new Float32Array(g.count * 3);
      const uv = new Float32Array(g.count * 2);
      const lit = new Float32Array(g.count * 3);
      const normals = relit ? new Float32Array(g.count * 3) : null;
      for (let j = 0; j < g.count; j++) {
        const index = model.indices[g.start + j];
        p.set(world.subarray(index * 3, index * 3 + 3), j * 3);
        uv[j * 2] = model.uv[index * 2];
        uv[j * 2 + 1] = model.uv[index * 2 + 1];
        v.fromArray(model.normals, index * 3).applyMatrix3(n3).normalize();
        if (normals) v.toArray(normals, j * 3);
        const dot = Math.max(0, v.x * light.sunDirection[0] + v.y * light.sunDirection[1] + v.z * light.sunDirection[2]);
        for (let c = 0; c < 3; c++) lit[j * 3 + c] = Math.min(1, light.ambient[c] + light.front[c] * dot);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(p, 3));
      geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      geometry.setAttribute("objLight", new THREE.BufferAttribute(lit, 3));
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, materialFor(g.texture, null, blockKind(flags?.[gi])));
      mesh.name = `${model.name}@${i}`;
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false; // moved by its task transform; tiny
      if (normals) mesh.userData.relitNormals = normals; // relit by placeSwap as it turns
      out.push(mesh);
    });
    return out;
  };
  const placeSwap = (i: number) => {
    const swap = swaps.get(i);
    if (!swap) return;
    const key = keyOf(level.instances[i]);
    const matrix = key >= 0 ? taskMatrix.get(key) : undefined;
    const hidden = key >= 0 && taskHidden.get(key) === true;
    for (const mesh of swap.meshes) {
      if (matrix) mesh.matrix.fromArray(matrix);
      else mesh.matrix.identity();
      mesh.matrixWorldNeedsUpdate = true;
      mesh.visible = !hidden;
      const normals = mesh.userData.relitNormals as Float32Array | undefined;
      const attr = mesh.geometry.getAttribute("objLight") as THREE.BufferAttribute | undefined;
      if (normals && attr) {
        relightInto(attr.array as Float32Array, 0, normals, relitRotation.setFromMatrix4(mesh.matrix));
        attr.needsUpdate = true;
      }
    }
  };
  const setRemoved = (i: number, removed: boolean) => {
    for (const r of renderIndexOf[i] ?? []) {
      const inst = lodInstances[r];
      if (inst) inst.removed = removed;
    }
  };

  return {
    group,
    collision: collisionWorld,
    dynamicTasks,
    destructibleInstances,
    setTaskTransform(key, matrix) {
      const list = instancesOfTask.get(key);
      if (!list) return;
      for (let i = 0; i < 16; i++) delta.elements[i] = matrix[i];
      for (const inst of list) moveEntry(inst);
      relightKey(key);
      collisionWorld.setBodyTransform(key, matrix);
      const stored = taskMatrix.get(key) ?? new Float64Array(16);
      for (let i = 0; i < 16; i++) stored[i] = matrix[i];
      taskMatrix.set(key, stored);
      const body = rebuildable.get(key);
      if (body) body.matrix = stored;
      for (const i of swaps.keys()) if (keyOf(level.instances[i]) === key) placeSwap(i);
    },
    setInstanceTransform(i, matrix, copy = 0) {
      const r = renderIndexOf[i]?.[copy];
      const inst = r === undefined ? undefined : lodInstances[r];
      if (!inst || inst.key < 0) return;
      for (let k = 0; k < 16; k++) delta.elements[k] = matrix[k];
      moveEntry(inst);
      relightKey(inst.key, relitByEntry.get(r!));
    },
    setTaskHidden(key, hidden) {
      const list = instancesOfTask.get(key);
      if (!list) return;
      for (const inst of list) inst.hidden = hidden;
      taskHidden.set(key, hidden);
      const body = rebuildable.get(key);
      if (body) body.enabled = !hidden;
      collisionWorld.setBodyEnabled(key, !hidden && !emptied.has(key));
      for (const i of swaps.keys()) if (keyOf(level.instances[i]) === key) placeSwap(i);
    },
    setInstanceModel(i, model) {
      if (!destructibleInstances.has(i)) return false;
      const old = swaps.get(i);
      if (old) {
        for (const mesh of old.meshes) swapGroup.remove(mesh);
        for (const mesh of old.meshes) mesh.geometry.dispose();
        swaps.delete(i);
      }
      const meshes = model ? replacementMeshes(i, model) : [];
      for (const mesh of meshes) swapGroup.add(mesh);
      swaps.set(i, { meshes, sets: model ? posedSetsOf(model, level.instances[i], i) : [] });
      setRemoved(i, true);
      placeSwap(i);
      rebuildBody(bodyOf(i));
      return true;
    },
    resetInstanceModels() {
      const bodies = new Set<number>();
      for (const [i, swap] of swaps) {
        for (const mesh of swap.meshes) {
          swapGroup.remove(mesh);
          mesh.geometry.dispose();
        }
        setRemoved(i, false);
        bodies.add(bodyOf(i));
      }
      swaps.clear();
      for (const id of bodies) rebuildBody(id);
    },
    instanceWorldMatrix(i) {
      const instance = level.instances[i];
      if (!instance) return null;
      const placed = new THREE.Matrix4().fromArray(instance.matrix);
      const key = keyOf(instance);
      const matrix = key >= 0 ? taskMatrix.get(key) : undefined;
      if (matrix) placed.premultiply(new THREE.Matrix4().fromArray(matrix));
      return placed.toArray();
    },
    stats: {
      instances: level.instances.length,
      triangles,
      drawCalls: batches.length,
      textures: textures.size,
      batches: batches.length,
      blendedBatches,
      lodEntries,
      instancesWithLods,
    },
    update,
    lodOf: (i) => lodInstances[i]?.current ?? -1,
    dispose() {
      for (const item of disposables) item.dispose();
    },
  };
}
