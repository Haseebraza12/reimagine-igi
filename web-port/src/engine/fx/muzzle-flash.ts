/**
 * Muzzle flash = the gun model's GUNFLAME attachment (magicobj.qvm
 * TASKTYPE_GUNFLAME; level.guns parts with role "flame"), docs/rendering.md
 * section 7 [observed + recovered]:
 *   - flat flame meshes across the barrel (1000_01_1, 1005_01_1, 1007_01_1,
 *     1008_01_1, 1010_01_1), drawn as deferred ADDITIVE blocks: ONE/ONE,
 *     unlit (texture only), unfogged, no Z write (the DNER flag bit 0 is set
 *     exactly on these models' blocks [observed], so every block of a GUNFLAME
 *     part is drawn additive here);
 *   - FUN_00476000: shown on render frame F only while the gun's last-shot
 *     frame >= F - 1 (gun +0x138 = FUN_004de150() at the shot, 0x477d2b),
 *     and only on frames an even number of frames after the flash first
 *     appeared (+0x13c; render-params muzzleFlashVisible); each shown frame
 *     it rolls about the flame's local y axis (FUN_004a9920 -> FUN_004a9e80,
 *     the barrel axis of the models) by {0, 4, 7}[rand(3)] degrees,
 *     cumulative, with rand(3) = FUN_004aaaa0 on the SECOND level generator
 *     (FUN_00415c30 = DAT_00577b78 + 0x38, seeded 0x19111911 at level start
 *     like +0x2c; the flash roll is its only user) [recovered];
 *   - the MP5SD (103_01_1) and Dragunov have no GUNFLAME: createMuzzleFlash
 *     returns null for them.
 * Barrel axis = gun-local IGI +y (models face +y, docs/formats.md) = engine
 * -z in gun space [inferred for guns].
 */
import * as THREE from "three";
import type { IgiLevel, LevelModel } from "../../loaders";
import { MUZZLE_FLASH, muzzleFlashVisible } from "../../loaders";
import { LevelRng, LEVEL_RNG_SEED } from "../ai/rng";
import { NO_FOG } from "../render/fog";
import { createObjectMaterial } from "../render/object-material";
import { createLevelTexture } from "../world/world-builder";

export interface MuzzleFlash {
  /**
   * The flame in GUN-LOCAL space (the GUNFLAME ATTA transform is applied):
   * add it as a child of the gun model's Object3D (first-person viewmodel or a
   * soldier's gun). It is hidden except on flash frames.
   */
  readonly object: THREE.Object3D;
  /** The gun fired (call from the tick that fires; any number of times). */
  fire(): void;
  /** Once per rendered frame, before rendering the scene that holds `object`. */
  update(): void;
  /** Hide immediately and forget the firing sequence (weapon switch, reset). */
  reset(): void;
  dispose(): void;
}

const ROLL_AXIS = new THREE.Vector3(0, 0, -1); // gun-local barrel axis (engine axes)

const textureCache = new WeakMap<IgiLevel, Map<string, THREE.Texture>>();
function flameTexture(level: IgiLevel, key: string): THREE.Texture {
  let cache = textureCache.get(level);
  if (!cache) {
    cache = new Map();
    textureCache.set(level, cache);
  }
  let t = cache.get(key);
  if (!t) {
    t = createLevelTexture(level, key).texture;
    cache.set(key, t);
  }
  return t;
}

/** Mesh of one GUNFLAME model (model-local, engine axes), one material group per block, additive. */
export function flameMesh(level: IgiLevel, model: LevelModel, mipBias: THREE.IUniform<number> = { value: 0 }): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(model.positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(model.uv, 2));
  geometry.setAttribute("objLight", new THREE.BufferAttribute(new Float32Array(model.positions.length).fill(1), 3));
  geometry.setIndex(new THREE.BufferAttribute(model.indices, 1));
  geometry.computeBoundingSphere();
  const materials = model.groups.map((g, i) => {
    geometry.addGroup(g.start, g.count, i);
    return createObjectMaterial({
      map: g.texture ? flameTexture(level, g.texture) : null,
      lightMap: null,
      kind: "additive",
      fog: NO_FOG,
      mipBias,
    });
  });
  const mesh = new THREE.Mesh(geometry, materials);
  mesh.name = `${model.name}:flame`;
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * The second level generator (DAT_00577b78 + 0x38): only FUN_00476000 draws
 * from it, so one shared instance reproduces its sequence across all guns.
 */
const flashGenerator = new LevelRng(LEVEL_RNG_SEED);

/** Level start (FUN_00415c90 seeds +0x38 with 0x19111911). */
export function resetMuzzleFlashRng(): void {
  flashGenerator.seed(LEVEL_RNG_SEED);
}

/** A float source (legacy/tests: index = floor(r x 3)) or an igi.exe generator (index = rand(3)). */
export type FlashRandom = (() => number) | { int(n: number): number };

/** Flash state machine of FUN_00476000 (pure; exported for tests). */
export class FlashSequence {
  /** Render frames counted by update(). */
  frame = 0;
  lastShot = -Infinity;
  firstShown: number | null = null;
  roll = 0;
  constructor(private readonly random: FlashRandom = flashGenerator) {}
  fire(): void {
    this.lastShot = this.frame;
  }
  /** Advance to the next render frame; returns whether the flash is drawn on it. */
  step(): boolean {
    this.frame++;
    if (this.lastShot < this.frame - 1) {
      this.firstShown = null;
      return false;
    }
    if (this.firstShown === null) this.firstShown = this.frame;
    const visible = muzzleFlashVisible(this.frame, this.lastShot, this.firstShown);
    if (visible) {
      const steps = MUZZLE_FLASH.rollStepsDeg;
      const r = this.random;
      const i = typeof r === "function" ? Math.min(steps.length - 1, Math.floor(r() * steps.length)) : r.int(steps.length);
      // (float)aiStack_18[i] * 0.017453292 (f32 0x531684), accumulated in the flame's matrix.
      this.roll += steps[i] * Math.fround(0.01745329238474369);
    }
    return visible;
  }
  reset(): void {
    this.lastShot = -Infinity;
    this.firstShown = null;
  }
}

/**
 * Muzzle flash for weapon `weaponId` (e.g. "WEAPON_ID_GLOCK"), or null when
 * its gun model has no GUNFLAME (MP5SD, Dragunov) or the gun is not loaded.
 */
export function createMuzzleFlash(level: IgiLevel, weaponId: string, mipBias?: THREE.IUniform<number>): MuzzleFlash | null {
  const parts = level.guns?.get(weaponId) ?? [];
  const flames = parts.filter((p) => p.role === "flame" && level.models.has(p.model));
  if (flames.length === 0) return null;
  const root = new THREE.Group();
  root.name = `muzzle-flash:${weaponId}`;
  root.visible = false;
  const holders: Array<{ holder: THREE.Object3D; position: THREE.Vector3; rotation: THREE.Quaternion }> = [];
  const disposables: Array<{ dispose(): void }> = [];
  for (const part of flames) {
    const m = new THREE.Matrix4().fromArray(part.matrix);
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    m.decompose(position, rotation, new THREE.Vector3());
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    holder.matrix.copy(m);
    const mesh = flameMesh(level, level.models.get(part.model)!, mipBias);
    holder.add(mesh);
    disposables.push(mesh.geometry, ...(mesh.material as THREE.Material[]));
    root.add(holder);
    holders.push({ holder, position, rotation });
  }
  const sequence = new FlashSequence();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  return {
    object: root,
    fire: () => sequence.fire(),
    update() {
      root.visible = sequence.step();
      if (!root.visible) return;
      q.setFromAxisAngle(ROLL_AXIS, sequence.roll);
      for (const h of holders) {
        // Roll about the barrel axis through the flame's attachment point: T(p) Rroll Rpart.
        h.holder.matrix.compose(h.position, q.clone().multiply(h.rotation), one);
        h.holder.matrixWorldNeedsUpdate = true;
      }
    },
    reset() {
      sequence.reset();
      root.visible = false;
    },
    dispose() {
      root.removeFromParent();
      for (const d of disposables) d.dispose();
    },
  };
}
