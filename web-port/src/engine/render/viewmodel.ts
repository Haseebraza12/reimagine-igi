/**
 * First-person arms and gun, as igi.exe draws them (docs/characters.md,
 * docs/rendering.md).
 *
 * Recovered:
 *   - Arms: bone model 005_01_1 on skeleton 5 (005.iff), LOD 0 weighted
 *     skinning (FUN_004632d0, FUN_0052be70), posed with the view rotation
 *     times the sway rotation Euler(alpha, 0, gamma) (FUN_00463840).
 *   - Placement: arms root = eye + R * rootTranslation(clip, t); there is no
 *     hard-coded hold offset - the offset is the clip's root translation.
 *     Wall pull-back: 0.5 m forward ray; on a hit at d the arms move back by
 *     (0.5 m - d), approached at 113.8 units per tick (75.9 when returning).
 *   - Weapon switch: sway snaps to (-0.611, -0.349) rad and returns to 0 at
 *     0.0582 / 0.0332 rad per tick (FUN_0040f7f7).
 *   - Clips per weapon from weaponconfig.qvm (StandAnim, MoveAnim,
 *     FireAnim1-3, ReloadAnim); time advances 160 animation ticks per 30 Hz
 *     game tick (FUN_004c93d0(30)); animation triggers >= 1000 are sounds.
 *   - Gun layer: horizontal FOV 60 degrees (tan(pi/6)), near 0.05 m, far
 *     1.5 m, depth range in front of the world (DEPTH_LAYERS.gun).
 *   - Lighting: rigid and bone meshes use the fixed-function vertex-lit path:
 *     texture x clamp(ambient + front x max(0, n.sun)).
 *   - Block states from each block's DNER flags, as for world objects: opaque
 *     (no alpha test), deferred (alpha blend, alpha > 1/255, no Z write) or
 *     additive (ONE/ONE, unlit).
 * Observed fit, not located in code (inferred): gun body on arms bone 3,
 * magazine (GUNCLIP) on bone 52, moving part (GUNMOVINGPART) on bone 55,
 * identity offsets; a second gun (the Uzi x2's left Uzi: the body's ATTA part
 * with its own GUNFLAME) on bone 52, its own attachments (flame) keeping their
 * offsets from it.
 *
 * Bound to the player's view object (bind(ctx.firstPerson)), the arms show
 * exactly what igi.exe's weapon state machine plays (combat/weapon.ts,
 * player/first-person.ts, docs/weapons-view.md) [recovered]: the clip and
 * its time, the 12-tick crossfade from the previous clip (mixed by slerp,
 * inferred), the sway (or Rx(-90 deg) while the binoculars / scope are up,
 * which hides the arms), the gun-layer FOV tangent (zoom), the landing dip's
 * arms share, and the arms are drawn even with an empty hand. Unbound, the
 * older approximation below is used (stand when still, move while moving,
 * fire per shot, reload on reload).
 * Visibility [recovered FUN_004630e0 at 0x46310e]: bound, nothing is drawn
 * unless the view object's viewMode (HumanCamera cam+0xe8) is 1; ladders,
 * fences, wires, terminals, lock picking (mode 3) and death (mode 5) show the
 * third-person body instead (docs/interactions.md section 10).
 */
import * as THREE from "three";
import {
  CAMERA,
  DEPTH_LAYERS,
  FIRST_PERSON,
  TICKS_PER_SECOND as ANIM_TICKS_PER_SECOND,
  poseSkeleton,
  poseVertices,
  readAnimations,
  readMef,
  readSkinnedModel,
  sampleClip,
  verticalFovDeg,
  type AnimClip,
  type AnimEvent,
  type IgiLevel,
  type LevelGunPart,
  type SkinnedModel,
} from "../../loaders";
import { createLevelTexture } from "../world/world-builder";
import { createMuzzleFlash, type MuzzleFlash } from "../fx/muzzle-flash";
import type { FirstPersonState } from "../player/first-person";

/** Animation ticks per game tick: 4800 / 30 [recovered FUN_004c93d0(30.0)]. */
const ANIM_TICKS_PER_GAME_TICK = ANIM_TICKS_PER_SECOND / 30;
const UNITS_PER_METRE = 4096;
const SWAY_SNAP = { alpha: -0.611, gamma: -0.349 };
const SWAY_RETURN = { alpha: 0.0582, gamma: 0.0332 };
const PULLBACK_RANGE = 2048;
/** Pull-back rate per tick while the ray hits (f32 0x5319cc) and while returning to 0 (f32 0x5319d0). */
const PULLBACK_IN = 113.77777862548828;
const PULLBACK_OUT = 75.85185241699219;

export interface ViewModelState {
  /** Player is moving (selects the move clip). */
  moving: boolean;
}

export interface ViewModels {
  /**
   * Show the gun of `weaponId` (null hides the arms) with its stand clip.
   * A weapon switch also snaps the switch sway; `instant` (mission start)
   * shows the weapon already raised.
   */
  select(weaponId: string | null, options?: { instant?: boolean }): void;
  /** A shot was fired: restart the weapon's fire clip. */
  fire(): void;
  /** Start the reload clip; returns its length in seconds (0 if the weapon has none). */
  reload(): number;
  /** Reload clip length in seconds for a weapon (0 if none). */
  reloadSeconds(weaponId: string): number;
  /** Advance one 30 Hz game tick. `wallDistance` = metres to geometry straight ahead of the eye (Infinity if none). */
  tick(state: ViewModelState, wallDistance: number, onTrigger: (trigger: number) => void): void;
  /** Draw after the world (clears depth: the gun layer lies in front of the world). */
  render(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, dt?: number): void;
  /** Deprecated alias of fire() kept for older call sites. */
  kick(): void;
  /**
   * Follow the player's view object (ctx.firstPerson, stepped by the weapon
   * system): clip, blend, sway, scope, gun FOV and hand weapon come from it;
   * select / fire / reload then only drive the gun meshes and the flash.
   */
  bind(state: FirstPersonState | null): void;
  /** World matrix of the shown gun body as of the last render (shell casings eject from it), or null. */
  gunMatrix(): THREE.Matrix4 | null;
  /** Draw `object` with the gun layer (its camera and depth range), e.g. the shell casings. */
  addToGunLayer(object: THREE.Object3D): void;
  dispose(): void;
}

const vertexShader = /* glsl */ `
  uniform vec3 sunDir;
  uniform vec3 ambientColour;
  uniform vec3 frontColour;
  varying vec2 vUv;
  varying vec3 vLight;
  void main() {
    vUv = uv;
    vec3 n = normalize(mat3(modelMatrix) * normal);
    vLight = min(vec3(1.0), ambientColour + frontColour * max(0.0, dot(n, sunDir)));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
// Object render states (docs/rendering.md): opaque blocks have no alpha test;
// deferred blocks blend SRCALPHA/INVSRCALPHA with ALPHAREF 1 (alpha > 1/255);
// additive blocks are ONE/ONE, unlit (texture only).
const fragmentShader = /* glsl */ `
  uniform sampler2D map;
  uniform float hasMap;
  uniform float blockKind;
  varying vec2 vUv;
  varying vec3 vLight;
  void main() {
    vec4 t = hasMap > 0.5 ? texture2D(map, vUv) : vec4(1.0);
    if (blockKind > 0.5 && t.a <= 1.0 / 255.0) discard;
    if (blockKind > 1.5) gl_FragColor = vec4(t.rgb, 1.0);
    else gl_FragColor = vec4(t.rgb * vLight, blockKind > 0.5 ? t.a : 1.0);
  }`;

type ViewBlockKind = "opaque" | "deferred" | "additive";
const kindOf = (b: { deferred: boolean; additive: boolean } | undefined): ViewBlockKind =>
  !b ? "opaque" : b.additive ? "additive" : b.deferred ? "deferred" : "opaque";

/** IGI arms/object space (x right, y forward, z up; units) -> camera-local three space (metres). */
function igiToCamera(): THREE.Matrix4 {
  const s = 1 / UNITS_PER_METRE;
  return new THREE.Matrix4().set(s, 0, 0, 0, 0, 0, s, 0, 0, -s, 0, 0, 0, 0, 0, 1);
}

/** Quaternion (x, y, z, w) of Rz(gamma) * Rx(alpha) (FUN_004a9bc0 order with beta = 0). */
function swayQuaternion(alpha: number, gamma: number): [number, number, number, number] {
  const ca = Math.cos(alpha / 2), sa = Math.sin(alpha / 2);
  const cg = Math.cos(gamma / 2), sg = Math.sin(gamma / 2);
  // qz * qx with qz = (0, 0, sg, cg), qx = (sa, 0, 0, ca)
  return [cg * sa, sg * sa, sg * ca, cg * ca];
}

/** Rotate v by unit quaternion q (x, y, z, w): v + 2w (q x v) + 2 q x (q x v). */
function rotate(q: readonly number[], v: readonly number[]): [number, number, number] {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

export function createViewModels(level: IgiLevel, _sun?: unknown, _ambient?: unknown): ViewModels {
  const scene = new THREE.Scene();
  const gunLayer = DEPTH_LAYERS.gun;
  const viewCamera = new THREE.PerspectiveCamera(verticalFovDeg(CAMERA.gunTanHalfFovX), 4 / 3, gunLayer.nearM, gunLayer.farM);
  const holder = new THREE.Group();
  scene.add(holder);
  const gunWorld = new THREE.Matrix4();
  const disposables: Array<{ dispose(): void }> = [];
  const textures = new Map<string, ReturnType<typeof createLevelTexture>>();
  const light = level.objectLight;
  const uniformsBase = {
    sunDir: { value: new THREE.Vector3(...light.sunDirection) },
    ambientColour: { value: new THREE.Vector3(...light.ambient) },
    frontColour: { value: new THREE.Vector3(...light.front) },
  };

  const materialFor = (key: string | null, kind: ViewBlockKind = "opaque"): THREE.ShaderMaterial => {
    let tex = key ? textures.get(key) : undefined;
    if (key && !tex) {
      tex = createLevelTexture(level, key);
      textures.set(key, tex);
      disposables.push(tex.texture);
    }
    const material = new THREE.ShaderMaterial({
      uniforms: {
        ...uniformsBase,
        map: { value: tex?.texture ?? null },
        hasMap: { value: tex ? 1 : 0 },
        blockKind: { value: kind === "opaque" ? 0 : kind === "deferred" ? 1 : 2 },
      },
      vertexShader,
      fragmentShader,
      side: THREE.FrontSide,
      transparent: kind !== "opaque",
      depthWrite: kind === "opaque",
      blending: kind === "additive" ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    disposables.push(material);
    return material;
  };

  // --- Arms ----------------------------------------------------------------
  const armsData = level.boneModels.get(FIRST_PERSON.model);
  const animBuffer = level.animations.get(FIRST_PERSON.skeleton);
  const anim = animBuffer ? readAnimations(animBuffer) : null;
  let arms: SkinnedModel | null = null;
  let armsMesh: THREE.Mesh | null = null;
  let posed: { positions: Float32Array; normals: Float32Array } | null = null;
  if (armsData && anim) {
    arms = readSkinnedModel(armsData.buffer, anim.skeleton);
    const armsBlocks = readMef(armsData.buffer).groups; // DNER flags per block
    posed = { positions: new Float32Array(3 * arms.primaryCount), normals: new Float32Array(3 * arms.primaryCount) };
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(posed.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("normal", new THREE.BufferAttribute(posed.normals, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute("uv", new THREE.BufferAttribute(arms.uv.subarray(0, 2 * arms.primaryCount), 2));
    geometry.setIndex(new THREE.BufferAttribute(arms.indices, 1));
    const materials = arms.groups.map((g, i) => {
      geometry.addGroup(g.start, g.count, i);
      const block = armsBlocks[i];
      return materialFor(armsData.textureKeys[g.materialSlot] ?? null, kindOf(block && { deferred: block.deferredFlag !== 0, additive: (block.blendFlags & 1) !== 0 }));
    });
    disposables.push(geometry);
    armsMesh = new THREE.Mesh(geometry, materials);
    armsMesh.matrixAutoUpdate = false;
    armsMesh.matrix.copy(igiToCamera());
    armsMesh.frustumCulled = false;
    holder.add(armsMesh);
  }

  // --- Guns ----------------------------------------------------------------
  interface GunMesh {
    part: LevelGunPart;
    mesh: THREE.Mesh;
    /** The part's index in the weapon's part list. */
    index: number;
  }
  /** A weapon's second gun: the part carrying its own GUNFLAME (Uzi x2), and its gun-local matrix inverted. */
  interface SecondGun {
    index: number;
    inverse: THREE.Matrix4;
    /** Per part: carried by the second gun (itself or an attachment of it). */
    carried: boolean[];
    /** Indices (among the GUNFLAME parts, the muzzle flash's order) of the flames it carries. */
    flames: number[];
  }
  const secondGuns = new Map<string, SecondGun>();
  const guns = new Map<string, GunMesh[]>();
  const bodyMeshes = new Map<string, THREE.Mesh>();
  /** Muzzle flash per weapon (GUNFLAME parts, additive; none for the MP5SD), carried by the gun body's frame. */
  const flashes = new Map<string, { flash: MuzzleFlash; holder: THREE.Group }>();
  for (const [weaponId, parts] of level.guns) {
    const flash = createMuzzleFlash(level, weaponId);
    if (flash) {
      const holder = new THREE.Group();
      holder.matrixAutoUpdate = false;
      holder.visible = false;
      holder.add(flash.object);
      holder.renderOrder = 10;
      scene.add(holder);
      flashes.set(weaponId, { flash, holder });
      disposables.push(flash);
    }
    const meshes: GunMesh[] = [];
    const second = parts.findIndex((p, i) => p.role === "part" && parts.some((q) => q.role === "flame" && q.parent === i));
    if (second > 0) {
      const carried = parts.map((_, i) => {
        for (let j = i; j >= 0; j = parts[j].parent) if (j === second) return true;
        return false;
      });
      const flames = parts.filter((p) => p.role === "flame").map((p) => carried[parts.indexOf(p)]);
      secondGuns.set(weaponId, {
        index: second,
        inverse: new THREE.Matrix4().fromArray(parts[second].matrix).invert(),
        carried,
        flames: flames.flatMap((c, k) => (c ? [k] : [])),
      });
    }
    for (const [index, part] of parts.entries()) {
      if (part.role === "flame") continue; // muzzle flash: drawn by the effects module
      const model = level.models.get(part.model);
      if (!model) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(model.positions, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(model.normals, 3));
      geometry.setAttribute("uv", new THREE.BufferAttribute(model.uv, 2));
      geometry.setIndex(new THREE.BufferAttribute(model.indices, 1));
      const materials = model.groups.map((g, i) => {
        geometry.addGroup(g.start, g.count, i);
        return materialFor(g.texture, kindOf(part.blocks[i]));
      });
      disposables.push(geometry);
      const mesh = new THREE.Mesh(geometry, materials);
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false;
      mesh.visible = false;
      holder.add(mesh);
      meshes.push({ part, mesh, index });
      if (part.role === "body") bodyMeshes.set(weaponId, mesh);
    }
    guns.set(weaponId, meshes);
  }

  // --- State ---------------------------------------------------------------
  const conv = igiToCamera();
  const convInv = conv.clone().invert();
  const boneMatrix = new THREE.Matrix4();
  const partMatrix = new THREE.Matrix4();
  const rootOffset = new THREE.Matrix4();
  const secondFrame = new THREE.Matrix4();
  const flameCarrier = new THREE.Matrix4();
  const bodyInverse = new THREE.Matrix4();
  let weapon: string | null = null;
  let clip: AnimClip | null = null;
  let clipTicks = 0;
  let clipKind: "stand" | "move" | "fire" | "reload" = "stand";
  let swayAlpha = 0;
  let swayGamma = 0;
  let pullback = 0;
  /** The player's view object when bound (the weapon system steps it). */
  let bound: FirstPersonState | null = null;
  let boundSteps = -1;

  const spec = () => (weapon ? level.weapons.get(weapon) : undefined);
  const clipOf = (id: number | undefined): AnimClip | null => (anim && id !== undefined && id >= 0 ? anim.clips.get(id) ?? null : null);
  const play = (kind: typeof clipKind, id: number | undefined) => {
    const next = clipOf(id);
    if (!next) return;
    clip = next;
    clipKind = kind;
    clipTicks = 0;
  };

  /**
   * The bound view object's pose [recovered, first-person.ts ArmsAnimator.sample]: its blend tree
   * (older clips faded out by the exe slerp FUN_004cab90, nested fades included), root offset =
   * arms+0x1f0 of the last update.
   */
  const boundSample = (fp: FirstPersonState): { rotations: Float32Array; translation: [number, number, number] } | null =>
    anim ? fp.arms.sample(anim.skeleton.boneCount, clipOf) : null;

  /** Pose the arms and place every gun part for the current clip time. */
  const pose = () => {
    if (!arms || !anim || !posed || !armsMesh) return;
    let sample: { rotations: Float32Array; translation: readonly number[] } | null;
    let sway: [number, number, number, number];
    if (bound) {
      sample = boundSample(bound);
      // arms+0x1ec (binoculars / scope): Rx(-90 deg) replaces the sway (FUN_00463840 0x463ffa).
      sway = bound.scoped ? swayQuaternion(-Math.PI / 2, 0) : swayQuaternion(bound.sway.alpha, bound.sway.gamma);
    } else {
      const current = clip ?? clipOf(FIRST_PERSON.initialClip);
      sample = current ? sampleClip(current, Math.min(clipTicks, current.duration)) : null;
      sway = swayQuaternion(swayAlpha, swayGamma);
    }
    if (!sample) return;
    const bones = poseSkeleton(anim.skeleton, sample.rotations, sway);
    const root = rotate(sway, sample.translation);
    root[1] -= pullback;
    // Arms vertices: object space + root offset (IGI units), then to camera space.
    poseVertices(arms, bones, true, posed);
    for (let i = 0; i < posed.positions.length; i += 3) {
      posed.positions[i] += root[0];
      posed.positions[i + 1] += root[1];
      posed.positions[i + 2] += root[2];
    }
    const geometry = armsMesh.geometry;
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.normal.needsUpdate = true;
    // Gun parts on their bones.
    rootOffset.makeTranslation(root[0], root[1], root[2]);
    if (bound && bound.handWeapon !== weapon) showWeapon(bound.handWeapon);
    const second = secondGuns.get(weapon ?? "");
    if (second) {
      boneMatrix.fromArray(bones, 16 * FIRST_PERSON.secondGunBone);
      secondFrame.copy(conv).multiply(rootOffset).multiply(boneMatrix).multiply(convInv);
    }
    for (const { part, mesh, index } of guns.get(weapon ?? "") ?? []) {
      if (second?.carried[index]) {
        // The second gun on its bone (identity offset); its attachments keep their offsets from it.
        mesh.matrix.copy(secondFrame);
        if (index !== second.index) mesh.matrix.multiply(second.inverse).multiply(new THREE.Matrix4().fromArray(part.matrix));
        continue;
      }
      const bone = part.role === "clip" ? FIRST_PERSON.magazineBone : part.role === "moving" ? FIRST_PERSON.movingPartBone : FIRST_PERSON.gunBone;
      boneMatrix.fromArray(bones, 16 * bone);
      partMatrix.copy(conv).multiply(rootOffset).multiply(boneMatrix).multiply(convInv);
      // Body/clip/moving parts sit on their bones with identity offsets; other parts keep their ATTA offset from the body.
      if (part.role === "part") partMatrix.multiply(new THREE.Matrix4().fromArray(part.matrix));
      mesh.matrix.copy(partMatrix);
    }
    // The flash rides the body; the second gun's flames are carried to the second gun (body^-1 x frame x gun^-1).
    const f = weapon ? flashes.get(weapon) : undefined;
    const body = weapon ? bodyMeshes.get(weapon) : undefined;
    if (second && f && body) {
      flameCarrier.copy(bodyInverse.copy(body.matrix).invert()).multiply(secondFrame).multiply(second.inverse);
      for (const k of second.flames) f.flash.setCarrier(k, flameCarrier);
    }
  };

  const runTriggers = (onTrigger: (trigger: number) => void, from: number, to: number) => {
    if (!clip) return;
    for (const e of clip.events as AnimEvent[]) {
      if (e.time > from && e.time <= to && e.trigger >= 1000) onTrigger(e.trigger);
    }
  };

  /** Gun meshes and flash of one weapon (null: none). */
  function showWeapon(weaponId: string | null): void {
    for (const [id, meshes] of guns) for (const { mesh } of meshes) mesh.visible = id === weaponId;
    for (const [id, f] of flashes) {
      f.flash.reset();
      f.holder.visible = id === weaponId;
    }
    // igi.exe draws the arms object whenever the player view is on, even with an empty hand.
    if (armsMesh) armsMesh.visible = bound !== null || (weaponId !== null && guns.has(weaponId));
    weapon = weaponId;
  }

  /** Wall pull-back (FUN_00463840): target -(2048 - d) on a hit, approached at 113.78 units / tick, 75.85 back to 0. */
  function stepPullback(wallDistance: number): void {
    const wallUnits = Number.isFinite(wallDistance) ? wallDistance * UNITS_PER_METRE : Infinity;
    const target = wallUnits < PULLBACK_RANGE ? PULLBACK_RANGE - wallUnits : 0;
    const rate = target !== 0 ? PULLBACK_IN : PULLBACK_OUT;
    if (pullback < target) pullback = Math.min(target, pullback + rate);
    else if (pullback > target) pullback = Math.max(target, pullback - rate);
  }

  const api: ViewModels = {
    bind(state) {
      bound = state;
      boundSteps = state ? state.arms.steps : -1;
      showWeapon(state ? state.handWeapon : weapon);
      pose();
    },
    select(weaponId, options) {
      if (bound) {
        showWeapon(bound.handWeapon);
        if (options?.instant) pullback = 0;
        pose();
        return;
      }
      showWeapon(weaponId);
      const s = spec();
      play("stand", s?.firstPersonAnims.stand);
      swayAlpha = options?.instant ? 0 : SWAY_SNAP.alpha;
      swayGamma = options?.instant ? 0 : SWAY_SNAP.gamma;
      pullback = 0;
      pose();
    },
    fire() {
      if (!bound) play("fire", spec()?.firstPersonAnims.fire[0]);
      if (weapon) flashes.get(weapon)?.flash.fire();
    },
    kick() {
      api.fire();
    },
    reload() {
      const s = spec();
      const next = clipOf(s?.firstPersonAnims.reload);
      if (!next) return 0;
      if (!bound) play("reload", s?.firstPersonAnims.reload);
      return next.seconds;
    },
    reloadSeconds(weaponId) {
      return clipOf(level.weapons.get(weaponId)?.firstPersonAnims.reload)?.seconds ?? 0;
    },
    tick(state, wallDistance, onTrigger) {
      if (bound) {
        // The weapon system stepped the arms this tick; emit the sound triggers it crossed once.
        if (bound.arms.steps !== boundSteps) {
          boundSteps = bound.arms.steps;
          for (const t of bound.arms.triggers) if (t >= 1000) onTrigger(t);
        }
        stepPullback(wallDistance);
        pose();
        return;
      }
      const s = spec();
      if (!s || !clip) {
        pose();
        return;
      }
      const before = clipTicks;
      clipTicks += ANIM_TICKS_PER_GAME_TICK;
      runTriggers(onTrigger, before === 0 ? -1 : before, Math.min(clipTicks, clip.duration));
      const finished = clipTicks >= clip.duration;
      if (clipKind === "move") {
        if (!state.moving) play("stand", s.firstPersonAnims.stand);
        else if (finished) clipTicks -= clip.duration; // MoveAnim loops
      } else if (clipKind === "stand") {
        if (state.moving) play("move", s.firstPersonAnims.move);
        else if (finished) clipTicks = clip.duration; // one-shot: hold the last pose
      } else if (finished) {
        // Fire / reload finished: back to the stance clip (the stand clip's
        // final pose, not its start).
        if (state.moving) play("move", s.firstPersonAnims.move);
        else {
          play("stand", s.firstPersonAnims.stand);
          const stand = clipOf(s.firstPersonAnims.stand);
          if (stand) clipTicks = stand.duration;
        }
      }
      // Sway returns to rest.
      swayAlpha = swayAlpha < 0 ? Math.min(0, swayAlpha + SWAY_RETURN.alpha) : Math.max(0, swayAlpha - SWAY_RETURN.alpha);
      swayGamma = swayGamma < 0 ? Math.min(0, swayGamma + SWAY_RETURN.gamma) : Math.max(0, swayGamma - SWAY_RETURN.gamma);
      stepPullback(wallDistance);
      pose();
    },
    render(renderer, camera) {
      if (!weapon && !bound) return;
      // FUN_004630e0 draws the arms and the hand weapon only while the HumanCamera
      // shows this human in view mode 1 (cam+0xe8 == 1) [recovered]; in modes 3
      // (attached, terminal, lock pick) and 5 (death) the body is drawn instead.
      if (bound && bound.viewMode !== 1) return;
      holder.position.copy(camera.position);
      // The landing dip's arms share (0.075 d sin phi) is along world up.
      if (bound) holder.position.y += bound.effects.offsets.armsUp / UNITS_PER_METRE;
      holder.quaternion.copy(camera.quaternion);
      // The flash rides on the gun body (world = holder x body matrix).
      const f = weapon ? flashes.get(weapon) : undefined;
      const body = weapon ? bodyMeshes.get(weapon) : undefined;
      if (f && body) {
        holder.updateMatrixWorld();
        f.holder.matrix.multiplyMatrices(holder.matrixWorld, body.matrix);
        f.flash.update();
      }
      viewCamera.position.copy(camera.position);
      viewCamera.quaternion.copy(camera.quaternion);
      viewCamera.aspect = camera.aspect;
      // Gun layer FOV tangent arms+0x1e8 (zooms with the MP5SD / Dragunov), else tan(30 deg).
      viewCamera.fov = verticalFovDeg(bound ? bound.gunTanX : CAMERA.gunTanHalfFovX);
      viewCamera.updateProjectionMatrix();
      // A depth clear is ignored while depth writes are masked (the world pass
      // may end with a transparent, depthWrite=false draw).
      renderer.state.buffers.depth.setMask(true);
      renderer.clearDepth();
      renderer.render(scene, viewCamera);
    },
    gunMatrix() {
      const body = weapon ? bodyMeshes.get(weapon) : undefined;
      if (!body) return null;
      holder.updateMatrixWorld();
      return gunWorld.multiplyMatrices(holder.matrixWorld, body.matrix);
    },
    addToGunLayer(object) {
      scene.add(object);
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
  return api;
}
