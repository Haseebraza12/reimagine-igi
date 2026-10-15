/**
 * Explosion and glass-shatter visuals (docs/damage.md section 3,
 * docs/rendering.md 7.10). Every rule is recovered from igi.exe; the level
 * RNG draws happen in combat/object-damage.ts in the exe's order (this file
 * draws nothing from it), the glass shards use their private generator
 * (fx/glass-shatter.ts).
 *
 *   - Fireball (FireBall task: create FUN_0047e3d0 / LAB_0047e960, update
 *     FUN_0047ea50, draw LAB_0047eb00): model 1006_01_1 (a hemisphere dome,
 *     radius 2038 units, apex on +z) with the 26 textures 1006_anim000..025;
 *     while the start delay runs the update only counts it down and nothing
 *     is drawn; then each update sets frame = trunc((life - left) / period x
 *     26) mod 26 and counts `left` down, deleting the task at 0 (life drawn
 *     frames; a delayed fireball is also drawn on the tick its delay reaches
 *     0, with frame -1 = the model's current texture frame). The draw turns
 *     the dome's z axis to the camera (x horizontal: fireballBasis), scales
 *     x, y by size / 2048 and z by (1 - left / life) x size / 2048 + 0.01.
 *     Render: the model's additive deferred block: ONE / ONE, texture only
 *     (unlit), alpha test > 1, z test without write, ZBIAS 3, D3D cull CCW,
 *     no fog, depth-sorted after the opaque pass (object-material "additive").
 *   - Smoke (ExplosionSmoke FUN_0047e790 -> FUN_0047ce40): two one-particle
 *     smoke2.spr systems in the shared particle manager (effects.particles):
 *     the glow (SRCALPHA / ONE) on the first update, the shade (ZERO /
 *     INVSRCCOLOR) at trunc(0.9 T), whose alpha the smoke rewrites every
 *     update (explosion-rules SMOKE). Colour 12.7 / 128: both are faint.
 *   - Fragments: model 1009_01_1 through fx/debris.ts (FragmentSystem.launch:
 *     vertex-lit, object fog, FUN_004fa1d0 motion with the explosion's
 *     gravity, no collision, 45 ticks).
 *   - Glass shards: fx/glass-shatter.ts (FUN_00449010 / FUN_0044abb0 /
 *     FUN_004494b0 / LAB_00448c90), drawn as the exe's PolyList: untextured
 *     grey 0.7, vertex alpha left / 30, SRCALPHA / INVSRCALPHA, alpha test > 0,
 *     no z write, D3D cull CW (the (a, b, c) order is the front), object fog,
 *     near plane x 1.01, in the pane's frame at the break.
 */
import * as THREE from "three";
import type { Vec3 } from "../../contracts";
import { readMipMapControl, type IgiLevel, type LevelModel } from "../../loaders";
import type { DamageModelData } from "../../loaders/damage-data";
import type { GameContext } from "../context";
import type { ExplosionFxSink } from "../combat/object-damage";
import {
  FIREBALL_MODEL,
  FRAGMENT_MODEL,
  SMOKE,
  fireballBasis,
  fireballFrame,
  fireballScale,
  fragmentGravity,
  type ExplosionSpec,
  type FireballSpec,
  type SmokeParticle,
  type V3,
} from "../combat/explosion-rules";
import type { Mat3 } from "./bullet-effects";
import { createFragmentSystem, engineRotation, igiRotation, type FragmentSystem } from "./debris";
import type { EffectModel } from "./effect-assets";
import {
  SHARD_COLOUR_BYTE,
  shardAlphaByte,
  shatterByBullet,
  shatterByExplosion,
  stepGlassShatter,
  type GlassShatterState,
  type PaneFaces,
} from "./glass-shatter";
import type { ParticleSystem } from "./particles";
import { createObjectMaterial, DECAL_DEPTH_SCALE, DEPTH_NUDGE_VERTEX } from "../render/object-material";
import { NO_FOG, sharedFogUniforms, type FogUniforms } from "../render/fog";
import { addSceneHook } from "../render/scene-hooks";
import { createLevelTexture } from "../world/world-builder";

const UNITS = 4096;

interface Fireball {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
  spec: FireballSpec;
  /** Absolute IGI centre (+0x20). */
  centre: V3;
  /** +0xf4 (left), +0xfc (delay), +0xf0 (frame, -1 until the first update after the delay). */
  left: number;
  delay: number;
  frame: number;
}

interface Shatter {
  state: GlassShatterState;
  mesh: THREE.Mesh;
  positions: THREE.BufferAttribute;
  alpha: THREE.BufferAttribute;
}

export interface ExplosionFxStats {
  fireballs: number;
  visibleFireballs: number;
  smokeSystems: number;
  fragments: number;
  shatters: number;
  shards: number;
}

export interface ExplosionFx extends ExplosionFxSink {
  readonly group: THREE.Group;
  /** Diagnostics (tests, visual checks). */
  stats(): ExplosionFxStats;
  dispose(): void;
}

/** IGI model-space vector -> engine (x, z, -y). */
const engineVec = (x: number, y: number, z: number): [number, number, number] => [x, z, -y];

/** A LevelModel as fx/debris.ts reads it (geometry + texture keys). */
function asEffectModel(m: LevelModel): EffectModel {
  return {
    name: m.name,
    positions: m.positions,
    normals: m.normals,
    uv: m.uv,
    indices: m.indices,
    groups: m.groups.map((g) => ({ start: g.start, count: g.count, texture: g.texture, deferred: false, additive: false })),
  };
}

/**
 * The pane's HSMC set 0 in its own IGI frame with the file's face order
 * (a, b, c): the level stores it in engine metres as (a, c, b).
 */
export function paneFaces(model: LevelModel | null): PaneFaces | null {
  const set = model?.collision?.[0];
  if (!set || set.indices.length < 3) return null;
  const n = set.positions.length / 3;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = set.positions[i * 3] * UNITS;
    positions[i * 3 + 1] = -set.positions[i * 3 + 2] * UNITS;
    positions[i * 3 + 2] = set.positions[i * 3 + 1] * UNITS;
  }
  const indices = new Uint32Array(set.indices.length);
  for (let t = 0; t + 2 < set.indices.length; t += 3) {
    indices[t] = set.indices[t];
    indices[t + 1] = set.indices[t + 2];
    indices[t + 2] = set.indices[t + 1];
  }
  return { positions, indices };
}

/** Normal (pane frame) of the face of `faces` the point lies on (the hit record's face normal) [inferred equivalent]. */
export function hitFaceNormal(faces: PaneFaces, p: readonly number[]): V3 {
  let best: V3 = [0, 0, 1];
  let bestD = Infinity;
  const q = faces.positions;
  for (let t = 0; t + 2 < faces.indices.length; t += 3) {
    const ia = faces.indices[t] * 3, ib = faces.indices[t + 1] * 3, ic = faces.indices[t + 2] * 3;
    const u = [q[ib] - q[ia], q[ib + 1] - q[ia + 1], q[ib + 2] - q[ia + 2]];
    const v = [q[ic] - q[ia], q[ic + 1] - q[ia + 1], q[ic + 2] - q[ia + 2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (!(len > 0)) continue;
    const w = [p[0] - q[ia], p[1] - q[ia + 1], p[2] - q[ia + 2]];
    const plane = Math.abs((w[0] * n[0] + w[1] * n[1] + w[2] * n[2]) / len);
    // Barycentric test in the face's plane (tolerant): outside faces count with a penalty.
    const uu = u[0] * u[0] + u[1] * u[1] + u[2] * u[2], vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2], uv = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const wu = w[0] * u[0] + w[1] * u[1] + w[2] * u[2], wv = w[0] * v[0] + w[1] * v[1] + w[2] * v[2];
    const den = uv * uv - uu * vv;
    const s = den !== 0 ? (uv * wv - vv * wu) / den : -1;
    const r = den !== 0 ? (uv * wu - uu * wv) / den : -1;
    const outside = s < -1e-3 || r < -1e-3 || s + r > 1 + 1e-3 ? 1e6 : 0;
    if (plane + outside < bestD) {
      bestD = plane + outside;
      best = [n[0] / len, n[1] / len, n[2] / len];
    }
  }
  return best;
}

const SHARD_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uDepthScale;
uniform float uZBiasK;
uniform float uFogK;
attribute float alpha;
varying float vAlpha;
varying float vFog;
void main() {
	vAlpha = alpha;
	vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
	gl_Position = projectionMatrix * mvPosition;
	#include <logdepthbuf_vertex>
	${DEPTH_NUDGE_VERTEX}
	vFog = exp( - uFogK * length( mvPosition.xyz ) );
}
`;

const SHARD_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColour;
uniform vec3 uFogColour;
varying float vAlpha;
varying float vFog;
void main() {
	#include <logdepthbuf_fragment>
	if ( floor( vAlpha * 255.0 + 0.5 ) <= 0.0 ) discard; // ALPHAREF 0, GREATER
	gl_FragColor = vec4( mix( uFogColour, uColour, vFog ), vAlpha ); // SELECTARG2 (diffuse), vertex fog
}
`;

/** PolyList of the shards (FUN_00498840 / FUN_00498940 / FUN_00498c10, flags 0, untextured). */
function createShardMaterial(fog: FogUniforms): THREE.ShaderMaterial {
  const c = SHARD_COLOUR_BYTE / 255;
  return new THREE.ShaderMaterial({
    name: "igi-glass-shards",
    uniforms: {
      uColour: { value: new THREE.Vector3(c, c, c) },
      uFogColour: fog.objectFogColour,
      uFogK: fog.objectFogK,
      uDepthScale: { value: DECAL_DEPTH_SCALE },
      uZBiasK: { value: 0 },
    },
    vertexShader: SHARD_VERTEX,
    fragmentShader: SHARD_FRAGMENT,
    side: THREE.FrontSide, // D3DCULL_CW: the (a, b, c) order seen counter-clockwise is drawn
    fog: false,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    depthFunc: THREE.LessEqualDepth,
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    // The target alpha is never displayed by D3D: keep the canvas opaque.
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
}

/** Explosion visuals for `level`; `data` supplies the fireball (1006_01_1) and fragment (1009_01_1) models. */
export function createExplosionFx(ctx: GameContext, level: IgiLevel, data: DamageModelData): ExplosionFx {
  const group = new THREE.Group();
  group.name = "explosion-fx";
  ctx.scene.add(group);
  const origin = level.originIgi;
  const toEngine = (p: readonly number[]): THREE.Vector3 =>
    new THREE.Vector3((p[0] - origin[0]) / UNITS, (p[2] - origin[2]) / UNITS, -(p[1] - origin[1]) / UNITS);
  const relative = (p: readonly number[]): Vec3 => [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
  const fog = sharedFogUniforms();
  const mipBias = { value: readMipMapControl(level.tasks)?.lodBias ?? 0 };

  // Fireball geometry and its frame textures (1006_anim000..025, the model's texture animation 0).
  const sphere: LevelModel | null = data.models.get(FIREBALL_MODEL) ?? null;
  let fireballGeometry: THREE.BufferGeometry | null = null;
  const frames: THREE.Texture[] = [];
  if (sphere) {
    fireballGeometry = new THREE.BufferGeometry();
    fireballGeometry.setAttribute("position", new THREE.BufferAttribute(sphere.positions, 3));
    fireballGeometry.setAttribute("uv", new THREE.BufferAttribute(sphere.uv, 2));
    fireballGeometry.setAttribute("objLight", new THREE.BufferAttribute(new Float32Array(sphere.positions.length).fill(1), 3));
    fireballGeometry.setIndex(new THREE.BufferAttribute(sphere.indices, 1));
    const archive = data.modelArchive.get(FIREBALL_MODEL) ?? "location0";
    for (const name of data.modelTextures.get(FIREBALL_MODEL) ?? []) {
      const key = `${archive}:${name}`;
      if (level.textures.has(key)) frames.push(createLevelTexture(level, key).texture);
    }
  }
  const fireballs: Fireball[] = [];
  /** The model's texture-animation frame as last set by a fireball draw (FUN_004c5e10 writes the shared model) [initial 0 inferred]. */
  let modelFrame = 0;

  // Fragments: fx/debris.ts with the damage data's models.
  const fragmentModels = new Map<string, EffectModel>();
  for (const [name, m] of data.models) if (name === FRAGMENT_MODEL || /^10(09|11|12|13)_01_1$/.test(name)) fragmentModels.set(name, asEffectModel(m));
  const fragments: FragmentSystem = createFragmentSystem(fragmentModels, { level, fog });
  group.add(fragments.object);

  // Smoke systems by smoke id: the shade system takes the alpha writes.
  const shades = new Map<number, ParticleSystem>();
  let smokeSystems: ParticleSystem[] = [];

  // Glass shards.
  const shatters: Shatter[] = [];
  const shardMaterial = createShardMaterial(fog);
  const faceCache = new Map<string, PaneFaces | null>();

  const camPos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const removeHook = addSceneHook(ctx.scene, (_r, _s, camera) => {
    camPos.setFromMatrixPosition(camera.matrixWorld);
    // Camera in IGI units relative to the origin (DAT_00b70848.. minus the origin).
    const cam: V3 = [camPos.x * UNITS, -camPos.z * UNITS, camPos.y * UNITS];
    for (const f of fireballs) {
      if (f.delay > 0) {
        f.mesh.visible = false;
        continue;
      }
      let frame = f.frame;
      if (frame >= 0) modelFrame = frame;
      else frame = modelFrame;
      if (frames.length > 0) f.material.uniforms.map.value = frames[Math.min(frame, frames.length - 1)];
      const c = relative(f.centre);
      const basis = fireballBasis([cam[0] - c[0], cam[1] - c[1], cam[2] - c[2]]);
      const s = fireballScale(f.spec.size, f.left, f.spec.life);
      // Model-space IGI scale (x, y, z) -> engine axes (x, z, y).
      f.mesh.matrix.copy(engineRotation(basis)).scale(scale.set(s[0], s[2], s[1]));
      f.mesh.matrix.setPosition(toEngine(f.centre));
      f.mesh.matrixWorldNeedsUpdate = true;
      f.mesh.visible = true;
    }
  });

  function addFireball(spec: ExplosionSpec, fb: FireballSpec): void {
    if (!fireballGeometry || frames.length === 0) return;
    const material = createObjectMaterial({ map: frames[0], lightMap: null, kind: "additive", fog: NO_FOG, mipBias });
    const mesh = new THREE.Mesh(fireballGeometry, material);
    mesh.name = "fireball";
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    mesh.frustumCulled = false;
    group.add(mesh);
    const centre: V3 = [spec.position[0] + fb.offset[0], spec.position[1] + fb.offset[1], spec.position[2] + fb.offset[2]];
    fireballs.push({ mesh, material, spec: fb, centre, left: fb.life, delay: fb.delay, frame: -1 });
  }

  /** Engine-space positions of the shards (pane frame) into the attribute. */
  function writeShards(s: Shatter): void {
    const arr = s.positions.array as Float32Array;
    let o = 0;
    for (const sh of s.state.shards) {
      for (const v of sh.vertices) {
        const e = engineVec(v[0] / UNITS, v[1] / UNITS, v[2] / UNITS);
        arr[o++] = e[0];
        arr[o++] = e[1];
        arr[o++] = e[2];
      }
    }
    s.positions.needsUpdate = true;
    (s.alpha.array as Float32Array).fill(shardAlphaByte(s.state.alpha) / 255);
    s.alpha.needsUpdate = true;
  }

  const fx: ExplosionFx = {
    group,
    explosion(spec, plan) {
      // FUN_0047d570 order: fireballs, smoke task (its particles come with its updates), fragments.
      for (const f of plan.fireballs) addFireball(spec, f);
      if (plan.fragments.length > 0) {
        const model = fragmentModels.has(spec.fragmentModel) ? spec.fragmentModel : FRAGMENT_MODEL;
        fragments.launch(model, relative(spec.position), plan.fragments, spec.spin, fragmentGravity(spec.radius));
      }
    },
    smoke(id, position, p: SmokeParticle) {
      const particles = ctx.systems.effects?.particles ?? null;
      if (!particles) return;
      const sys = particles.create({
        sprite: SMOKE.sprite,
        accel: [0, 0, SMOKE.accel],
        colour: SMOKE.colour,
        halfSize: [p.halfSize, p.halfSize],
        far: SMOKE.far,
        flags: p.flags | 0x40000,
        frameDelay: 0,
        growth: p.growth,
        maxParticles: SMOKE.maxParticles,
      });
      if (!sys) return;
      sys.emit(relative(position), [0, 0, SMOKE.velocity], p.alpha, p.spin, p.angle, 1, p.life, p.fadeTicks);
      smokeSystems.push(sys);
      if (p.flags === SMOKE.shadeFlags) shades.set(id, sys);
    },
    smokeAlpha(id, alpha) {
      const sys = shades.get(id);
      if (!sys) return;
      for (const q of sys.particles) q.alpha = alpha;
    },
    glassShatter(_i, model, matrix, push, fromExplosion, from) {
      if (!model || !matrix) return;
      let faces = faceCache.get(model.name);
      if (faces === undefined) faceCache.set(model.name, (faces = paneFaces(model)));
      if (!faces) return;
      const m = new THREE.Matrix4().fromArray(matrix);
      const rotation: Mat3 = igiRotation(m);
      const e = m.elements;
      const pane: V3 = [e[12] * UNITS, -e[14] * UNITS, e[13] * UNITS];
      const at: V3 = from ? [from[0] * UNITS - pane[0], -from[2] * UNITS - pane[1], from[1] * UNITS - pane[2]] : [0, 0, 0];
      let state: GlassShatterState;
      if (fromExplosion) {
        state = shatterByExplosion(faces, rotation, at);
      } else {
        const local: V3 = [
          rotation[0] * at[0] + rotation[3] * at[1] + rotation[6] * at[2],
          rotation[1] * at[0] + rotation[4] * at[1] + rotation[7] * at[2],
          rotation[2] * at[0] + rotation[5] * at[1] + rotation[8] * at[2],
        ];
        const nl = hitFaceNormal(faces, local);
        const normal: V3 = [
          rotation[0] * nl[0] + rotation[1] * nl[1] + rotation[2] * nl[2],
          rotation[3] * nl[0] + rotation[4] * nl[1] + rotation[5] * nl[2],
          rotation[6] * nl[0] + rotation[7] * nl[1] + rotation[8] * nl[2],
        ];
        state = shatterByBullet(faces, rotation, [push[0], -push[2], push[1]], at, normal);
      }
      if (state.shards.length === 0) return;
      const n = state.shards.length * 3;
      const geometry = new THREE.BufferGeometry();
      const positions = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
      positions.setUsage(THREE.DynamicDrawUsage);
      const alpha = new THREE.BufferAttribute(new Float32Array(n), 1);
      alpha.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute("position", positions);
      geometry.setAttribute("alpha", alpha);
      const mesh = new THREE.Mesh(geometry, shardMaterial);
      mesh.name = "glass-shards";
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(m);
      mesh.frustumCulled = false;
      mesh.visible = false; // drawn after its first update (same tick)
      group.add(mesh);
      const s: Shatter = { state, mesh, positions, alpha };
      writeShards(s);
      shatters.push(s);
    },
    tick() {
      // FireBall updates (FUN_0047ea50).
      for (let k = 0; k < fireballs.length; k++) {
        const f = fireballs[k];
        if (f.delay > 0) {
          f.delay -= 1;
          continue;
        }
        f.frame = fireballFrame(f.spec.life, f.left, f.spec.period, frames.length);
        if (f.left !== 0) {
          f.left -= 1;
          continue;
        }
        group.remove(f.mesh);
        f.material.dispose();
        fireballs.splice(k--, 1);
      }
      // Fragment containers (FUN_004fa1d0 / FUN_004fa7d0); their own launches carry no draws.
      fragments.tick(ctx.rng);
      // GlassShatter updates (LAB_00448c90).
      for (let k = 0; k < shatters.length; k++) {
        const s = shatters[k];
        if (!stepGlassShatter(s.state)) {
          group.remove(s.mesh);
          s.mesh.geometry.dispose();
          shatters.splice(k--, 1);
          continue;
        }
        writeShards(s);
        s.mesh.visible = true;
      }
      // Forget smoke systems the particle manager has dropped.
      const particles = ctx.systems.effects?.particles ?? null;
      smokeSystems = smokeSystems.filter((sys) => particles?.alive(sys) ?? false);
      for (const [id, sys] of shades) if (!smokeSystems.includes(sys)) shades.delete(id);
    },
    clear() {
      for (const f of fireballs) {
        group.remove(f.mesh);
        f.material.dispose();
      }
      fireballs.length = 0;
      fragments.clear();
      for (const s of shatters) {
        group.remove(s.mesh);
        s.mesh.geometry.dispose();
      }
      shatters.length = 0;
      shades.clear();
      smokeSystems = [];
    },
    stats() {
      return {
        fireballs: fireballs.length,
        visibleFireballs: fireballs.filter((f) => f.delay <= 0).length,
        smokeSystems: smokeSystems.length,
        fragments: fragments.count(),
        shatters: shatters.length,
        shards: shatters.reduce((n, s) => n + s.state.shards.length, 0),
      };
    },
    dispose() {
      removeHook();
      ctx.scene.remove(group);
      for (const f of fireballs) f.material.dispose();
      fireballs.length = 0;
      fireballGeometry?.dispose();
      for (const t of frames) t.dispose();
      fragments.dispose();
      for (const s of shatters) s.mesh.geometry.dispose();
      shatters.length = 0;
      shardMaterial.dispose();
      shades.clear();
      smokeSystems = [];
    },
  };
  return fx;
}

/** Engine vector helper (IGI units -> engine metres, relative directions). */
export function igiDirectionToEngine(v: V3): Vec3 {
  return [v[0] / UNITS, v[2] / UNITS, -v[1] / UNITS];
}
