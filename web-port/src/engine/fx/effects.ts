/**
 * Visual effects (muzzle flash, tracers, impact sparks).
 *
 * Spawns short-lived Three.js objects into ctx.scene for weapon feedback and
 * recycles them through per-kind pools, so a firefight never allocates inside
 * the frame loop. All effects are additive/emissive and procedurally textured —
 * no data from the original game files is involved.
 *
 * Confidence: implementation choice (visual feel only). Lifetimes are tuned to
 * read as near-instant (muzzle flash 0.05 s, tracer 0.08 s) with slightly
 * longer impact debris (~0.3 s).
 */
import * as THREE from "three";
import type { Vec3 } from "../../contracts";
import type { GameContext } from "../context";

export interface Effects {
  update(dt: number): void;
  muzzleFlash(position: Vec3, direction: Vec3): void;
  tracer(from: Vec3, to: Vec3): void;
  impact(point: Vec3): void;
  clear(): void;
}

/** Effect lifetimes in seconds (also the length of the fade curve). */
const FLASH_LIFE = 0.05;
const TRACER_LIFE = 0.08;
const IMPACT_LIFE = 0.3;
/** Hard cap so sustained fire cannot flood the scene graph. */
const MAX_ACTIVE = 64;
/** Sparks spawned per impact. */
const SPARKS_PER_IMPACT = 8;
const SPARK_GRAVITY = -7.5;
/** Exponential velocity damping (1/s). */
const SPARK_DRAG = 2.6;
const SPARK_SPEED_MIN = 1.6;
const SPARK_SPEED_MAX = 4.8;
const FLASH_COLOR = 0xffd9a0;
const TRACER_COLOR = 0xfff0c0;
const SPARK_COLOR = 0xffc470;
/** Additive light intensity at t0 (decay 2 => falls off within a few metres). */
const FLASH_LIGHT_INTENSITY = 26;
const FLASH_LIGHT_DISTANCE = 10;
/** PlaneGeometry's normal is +Z; used to aim the flash quad down the barrel. */
const PLANE_FORWARD = new THREE.Vector3(0, 0, 1);

/** Pooled muzzle flash: additive quad + matching point light. */
interface FlashInstance {
  light: THREE.PointLight;
  mesh: THREE.Mesh;
  geometry: THREE.PlaneGeometry;
  material: THREE.MeshBasicMaterial;
}

/** Pooled bullet tracer: a single additive line segment. */
interface TracerInstance {
  line: THREE.Line;
  geometry: THREE.BufferGeometry;
  positions: THREE.BufferAttribute;
  material: THREE.LineBasicMaterial;
}

/** Pooled impact debris: N additive points with per-spark velocities. */
interface SparkInstance {
  points: THREE.Points;
  geometry: THREE.BufferGeometry;
  positions: THREE.BufferAttribute;
  velocities: Float32Array;
  material: THREE.PointsMaterial;
}

/** One live effect: age/life plus whichever pooled instance it owns. */
interface Active {
  age: number;
  life: number;
  /** t0 intensity of the flash light (0 for non-light effects). */
  lightIntensity: number;
  flash: FlashInstance | null;
  tracer: TracerInstance | null;
  spark: SparkInstance | null;
}

/** Dispose helper that tolerates null / already-disposed GPU resources. */
function disposeResource(resource: { dispose(): void } | null | undefined): void {
  if (!resource) return;
  try {
    resource.dispose();
  } catch {
    /* nothing sensible to do during teardown */
  }
}

let glowTexture: THREE.Texture | null = null;
/** True once we know the glow sprite cannot be produced here. */
let glowUnavailable = false;

/** Soft radial sprite texture, generated once from a 2D canvas. */
function glowMap(): THREE.Texture | null {
  if (glowTexture) return glowTexture;
  if (glowUnavailable) return null;
  glowUnavailable = true;
  if (typeof document === "undefined") return null;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  if (typeof canvas.getContext !== "function") return null;
  const ctx2d = canvas.getContext("2d");
  if (!ctx2d) return null;
  const half = size / 2;
  const gradient = ctx2d.createRadialGradient(half, half, 0, half, half, half);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.35, "rgba(255,228,180,0.7)");
  gradient.addColorStop(1, "rgba(255,170,80,0)");
  ctx2d.fillStyle = gradient;
  ctx2d.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  glowUnavailable = false;
  glowTexture = texture;
  return texture;
}

/** Release the shared glow sprite so it can be rebuilt later. */
function releaseGlowTexture(): void {
  disposeResource(glowTexture);
  glowTexture = null;
  glowUnavailable = false;
}


export function createEffects(ctx: GameContext): Effects {
  // Null-guarded: the scene is guaranteed by GameContext, but never assume it.
  const scene: THREE.Scene | null = ctx.scene ?? null;
  const active: Active[] = [];
  const idleFlashes: FlashInstance[] = [];
  const idleTracers: TracerInstance[] = [];
  const idleSparks: SparkInstance[] = [];

  /** Coerce a contract Vec3 into a finite Vector3 (bad input -> origin). */
  function vec(v: Vec3 | undefined): THREE.Vector3 {
    if (!v) return new THREE.Vector3();
    return new THREE.Vector3(
      Number.isFinite(v[0]) ? v[0] : 0,
      Number.isFinite(v[1]) ? v[1] : 0,
      Number.isFinite(v[2]) ? v[2] : 0,
    );
  }

  function acquireFlash(): FlashInstance {
    const pooled = idleFlashes.pop();
    if (pooled) return pooled;
    const geometry = new THREE.PlaneGeometry(0.42, 0.42);
    const material = new THREE.MeshBasicMaterial({
      color: FLASH_COLOR,
      map: glowMap(),
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    const light = new THREE.PointLight(FLASH_COLOR, 0, FLASH_LIGHT_DISTANCE, 2);
    light.matrixAutoUpdate = true;
    return { light, mesh, geometry, material };
  }

  function acquireTracer(): TracerInstance {
    const pooled = idleTracers.pop();
    if (pooled) return pooled;
    const positions = new THREE.BufferAttribute(new Float32Array(6), 3);
    positions.setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", positions);
    const material = new THREE.LineBasicMaterial({
      color: TRACER_COLOR,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    return { line, geometry, positions, material };
  }

  function acquireSpark(): SparkInstance {
    const pooled = idleSparks.pop();
    if (pooled) return pooled;
    const positions = new THREE.BufferAttribute(
      new Float32Array(SPARKS_PER_IMPACT * 3),
      3,
    );
    positions.setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", positions);
    const material = new THREE.PointsMaterial({
      color: SPARK_COLOR,
      size: 0.12,
      map: glowMap(),
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
      fog: false,
      toneMapped: false,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    return {
      points,
      geometry,
      positions,
      velocities: new Float32Array(SPARKS_PER_IMPACT * 3),
      material,
    };
  }

  /** Register an effect, evicting the oldest when the pool is saturated. */
  function push(entry: Active): void {
    active.push(entry);
    while (active.length > MAX_ACTIVE) retire(0);
  }

  /** Unhook one effect from the scene and return its instance to the pool. */
  function retire(index: number): void {
    const entry = active[index];
    if (!entry) return;
    active.splice(index, 1);
    if (entry.flash) {
      scene?.remove(entry.flash.mesh);
      scene?.remove(entry.flash.light);
      entry.flash.light.intensity = 0;
      idleFlashes.push(entry.flash);
    }
    if (entry.tracer) {
      scene?.remove(entry.tracer.line);
      idleTracers.push(entry.tracer);
    }
    if (entry.spark) {
      scene?.remove(entry.spark.points);
      idleSparks.push(entry.spark);
    }
  }

  /** Additive quad + point light at the barrel, fading over ~0.05 s. */
  function muzzleFlash(position: Vec3, direction: Vec3): void {
    if (!scene) return;
    const dir = vec(direction);
    if (dir.lengthSq() < 1e-8) dir.set(0, 0, -1);
    dir.normalize();
    const origin = vec(position);

    const flash = acquireFlash();
    flash.mesh.position.copy(origin).addScaledVector(dir, 0.12);
    flash.mesh.quaternion.setFromUnitVectors(PLANE_FORWARD, dir);
    flash.mesh.scale.setScalar(1);
    flash.material.opacity = 1;
    flash.light.position.copy(origin).addScaledVector(dir, 0.2);
    flash.light.intensity = FLASH_LIGHT_INTENSITY;
    scene.add(flash.mesh);
    scene.add(flash.light);

    push({
      age: 0,
      life: FLASH_LIFE,
      lightIntensity: FLASH_LIGHT_INTENSITY,
      flash,
      tracer: null,
      spark: null,
    });
  }

  /** Thin additive line from muzzle to impact point, fading over ~0.08 s. */
  function tracer(from: Vec3, to: Vec3): void {
    if (!scene) return;
    const t = acquireTracer();
    const a = vec(from);
    const b = vec(to);
    t.positions.setXYZ(0, a.x, a.y, a.z);
    t.positions.setXYZ(1, b.x, b.y, b.z);
    t.positions.needsUpdate = true;
    t.material.opacity = 1;
    scene.add(t.line);
    push({
      age: 0,
      life: TRACER_LIFE,
      lightIntensity: 0,
      flash: null,
      tracer: t,
      spark: null,
    });
  }

  /** Small spark burst that expands and falls under gravity over ~0.3 s. */
  function impact(point: Vec3): void {
    if (!scene) return;
    const spark = acquireSpark();
    const origin = vec(point);
    const velocities = spark.velocities;
    for (let i = 0; i < SPARKS_PER_IMPACT; i++) {
      const theta = Math.random() * Math.PI * 2;
      // Cosine-weighted +Y bias keeps debris on the struck surface's side.
      const up = 0.25 + Math.random() * 0.75;
      const radial = Math.sqrt(Math.max(0, 1 - up * up));
      const speed = SPARK_SPEED_MIN + Math.random() * (SPARK_SPEED_MAX - SPARK_SPEED_MIN);
      const o = i * 3;
      velocities[o] = Math.cos(theta) * radial * speed;
      velocities[o + 1] = up * speed;
      velocities[o + 2] = Math.sin(theta) * radial * speed;
      spark.positions.setXYZ(i, origin.x, origin.y, origin.z);
    }
    spark.positions.needsUpdate = true;
    spark.material.opacity = 1;
    scene.add(spark.points);
    push({
      age: 0,
      life: IMPACT_LIFE,
      lightIntensity: 0,
      flash: null,
      tracer: null,
      spark,
    });
  }

  /** Age every live effect, fade it out and recycle it once expired. */
  function update(dt: number): void {
    if (!scene || active.length === 0) return;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    for (let i = active.length - 1; i >= 0; i--) {
      const entry = active[i];
      entry.age += step;
      const life = entry.life > 0 ? entry.life : 0.0001;
      const fade = Math.max(0, 1 - Math.min(1, entry.age / life));

      if (entry.flash) {
        // Squared falloff reads as a much hotter initial pop.
        entry.flash.light.intensity = entry.lightIntensity * fade * fade;
        entry.flash.material.opacity = fade;
        entry.flash.mesh.scale.setScalar(1 + (1 - fade) * 0.9);
      } else if (entry.tracer) {
        entry.tracer.material.opacity = fade;
      } else if (entry.spark) {
        const spark = entry.spark;
        const attr = spark.positions;
        const vel = spark.velocities;
        const damp = Math.max(0, 1 - SPARK_DRAG * step);
        for (let j = 0; j < SPARKS_PER_IMPACT; j++) {
          const o = j * 3;
          vel[o + 1] += SPARK_GRAVITY * step;
          vel[o] *= damp;
          vel[o + 2] *= damp;
          attr.setXYZ(
            j,
            attr.getX(j) + vel[o] * step,
            attr.getY(j) + vel[o + 1] * step,
            attr.getZ(j) + vel[o + 2] * step,
          );
        }
        attr.needsUpdate = true;
        spark.material.opacity = fade * fade;
      }

      if (entry.age >= entry.life) retire(i);
    }
  }

  /** Remove every effect and release all GPU resources (teardown / level swap). */
  function clear(): void {
    while (active.length > 0) retire(active.length - 1);
    for (const flash of idleFlashes) {
      scene?.remove(flash.mesh);
      scene?.remove(flash.light);
      disposeResource(flash.geometry);
      disposeResource(flash.material);
    }
    idleFlashes.length = 0;
    for (const t of idleTracers) {
      scene?.remove(t.line);
      disposeResource(t.geometry);
      disposeResource(t.material);
    }
    idleTracers.length = 0;
    for (const spark of idleSparks) {
      scene?.remove(spark.points);
      disposeResource(spark.geometry);
      disposeResource(spark.material);
    }
    idleSparks.length = 0;
    releaseGlowTexture();
  }

  return { update, muzzleFlash, tracer, impact, clear };
}

