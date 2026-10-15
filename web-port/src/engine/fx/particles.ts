/**
 * Particle2DDynCubeObjTask, the sprite particle systems of igi.exe
 * [recovered: class FUN_004f3b70, create FUN_004f4b20 / 0x4f4200, emit
 * FUN_004f4d40, cone emit FUN_004f4e30, tick FUN_004f4280, draw FUN_004f3c40
 * -> FUN_004ab6b0 (TL sprite quad); rules in bullet-effects.ts]:
 *
 *   - a system holds up to N particles of one sprite (.spr, common/sprites);
 *     per tick: velocity += acceleration, position += velocity, angle +=
 *     spin, scale += growth, frame advances every `frameDelay` ticks up to
 *     the last frame of the sprite's tile sequence; while the life counter
 *     is > 0 it counts down, afterwards alpha -= fade per tick and the
 *     particle dies at alpha <= 0 (or scale <= 0); an empty system removes
 *     itself;
 *   - systems with a hit callback test each particle's path every 15 ticks
 *     (staggered by a global counter mod 16): a ray from the last tested
 *     position to the current one; on a hit the callback runs and the
 *     particle is removed;
 *   - draw: a screen-aligned quad at the particle (2-D TL primitive at its
 *     view depth), half-size = size (x scale when the system grows) projected
 *     at that depth, at least 0.5 pixel, rotated by the angle when the spin is
 *     non-zero; not drawn nearer than 2048 units or beyond the system's far
 *     distance; colour = texture x (colour / 128), alpha = texture alpha x
 *     particle alpha (flag 0x80000; bytes trunc(v x 255)); bilinear, no mips,
 *     clamp; blend by flags (0x8 SRCALPHA / ONE, 0x10 ZERO / INVSRCCOLOR,
 *     0x80000000 ZERO / SRCCOLOR, else SRCALPHA / INVSRCALPHA; FUN_00504300);
 *     Z test without write; no fog.
 * Positions are IGI units relative to the level origin (bullet-effects.ts
 * axes); they are converted to engine metres when drawn.
 */
import * as THREE from "three";
import type { Vec3 } from "../../contracts";
import type { UiSprite } from "../../loaders";
import { PARTICLES, UNITS, colourByte, coneVelocity, enginePoint, stepParticle, type EffectRng, type ParticleState } from "./bullet-effects";

/** What a particle ray hit (engine space). */
export interface ParticleHit {
  point: Vec3;
  /** Outward face normal (engine, unit). */
  normal: Vec3;
  terrain: boolean;
  owner: number;
  body: number | null;
}

export interface ParticleSystemSpec {
  /** Sprite file name in common/sprites/sprites.res ("concrete1.spr"). */
  sprite: string;
  /** Acceleration per tick, IGI units. */
  accel: Vec3;
  /** Colour in the 1/128 scale (127 = 0.992). */
  colour: number;
  /** Half-size (x, y), IGI units. */
  halfSize: [number, number];
  /** Far draw limit, units. */
  far: number;
  /** Draw flags (0x80000: alpha from the particle, else colour x alpha). */
  flags: number;
  /** Ticks per animation frame (+0xf4). */
  frameDelay: number;
  /** Scale growth per tick (+0xe4); 0 = no scaling. */
  growth: number;
  maxParticles: number;
  /**
   * A task's own system (FUN_004f4b20 with the task as parent, FUN_004f51f0(sys, 0)): the owner
   * steps it among its children (ParticleSystem.tick) and it is kept when empty (+0xfd = 0);
   * the manager only draws it [recovered: Smoke FUN_00437280 / FUN_00437030].
   */
  owned?: boolean;
  /** Hit callback (prev, current in IGI units); the particle is removed after it. */
  onHit?: (hit: ParticleHit, previous: Vec3, current: Vec3) => void;
}

export interface Particle extends ParticleState {}

/**
 * Blend of a TL particle quad from the system flags (FUN_00504300): 0x8
 * SRCALPHA / ONE, 0x10 ZERO / INVSRCCOLOR, 0x80000000 ZERO / SRCCOLOR, else
 * SRCALPHA / INVSRCALPHA [recovered].
 */
export type ParticleBlend = "alpha" | "add" | "invsrc" | "srccolor";
export function particleBlend(flags: number): ParticleBlend {
  if ((flags & 0x8) !== 0) return "add";
  if ((flags & 0x10) !== 0) return "invsrc";
  if ((flags & 0x80000000) !== 0) return "srccolor";
  return "alpha";
}
const BLEND_FACTORS: Record<ParticleBlend, [THREE.BlendingSrcFactor, THREE.BlendingDstFactor]> = {
  alpha: [THREE.SrcAlphaFactor, THREE.OneMinusSrcAlphaFactor],
  add: [THREE.SrcAlphaFactor, THREE.OneFactor],
  invsrc: [THREE.ZeroFactor, THREE.OneMinusSrcColorFactor],
  srccolor: [THREE.ZeroFactor, THREE.SrcColorFactor],
};

export class ParticleSystem {
  readonly particles: Particle[] = [];
  /** Drawn (false while the owning task is out of the world). */
  visible = true;
  /** Last frame index of the sprite's sequence (0 = static). */
  readonly lastFrame: number;
  constructor(
    readonly spec: ParticleSystemSpec,
    readonly sequence: number[],
    private readonly manager: { nextCollide(): number },
  ) {
    this.lastFrame = sequence.length > 1 ? sequence.length - 1 : 0;
  }

  /** FUN_004f4d40: dropped when the system is full. `fadeTicks` 0 = fade 1.0 per tick. */
  emit(position: Vec3, velocity: Vec3, alpha: number, spin: number, angle: number, scale: number, life: number, fadeTicks: number): Particle | null {
    if (this.particles.length >= this.spec.maxParticles) return null;
    const p: Particle = {
      position: [position[0], position[1], position[2]],
      previous: [position[0], position[1], position[2]],
      velocity: [velocity[0], velocity[1], velocity[2]],
      collide: this.manager.nextCollide(),
      life,
      frame: 0,
      frameTicks: 0,
      alpha,
      spin,
      angle,
      scale,
      fade: fadeTicks !== 0 ? Math.fround(1 / fadeTicks) : 1,
    };
    this.particles.push(p);
    return p;
  }

  /** FUN_004f4e30: velocity in a cone around `dir` drawn from the particle generator. */
  emitCone(position: Vec3, dir: Vec3, cone: number, vmin: number, vmax: number, rng: EffectRng, alpha: number, spin: number, angle: number, scale: number, life: number, fadeTicks: number): Particle | null {
    const v = coneVelocity(dir, cone, vmin, vmax, rng);
    return this.emit(position, v, alpha, spin, angle, scale, life, fadeTicks);
  }

  /** FUN_004f4280. `cast` = the ray test for systems with a hit callback. */
  tick(cast: ((from: Vec3, to: Vec3) => ParticleHit | null) | null): void {
    const rules = { accel: this.spec.accel, growth: this.spec.growth, frameDelay: this.spec.frameDelay, lastFrame: this.lastFrame };
    for (let i = 0; i < this.particles.length; ) {
      if (stepParticle(this.particles[i], rules)) i++;
      else this.particles.splice(i, 1);
    }
    if (!this.spec.onHit || !cast) return;
    const tests: Array<{ p: Particle; from: Vec3; to: Vec3 }> = [];
    for (const p of this.particles) {
      if (p.collide !== 0) p.collide--;
      if (p.collide === 0) {
        tests.push({ p, from: [...p.previous], to: [...p.position] });
        p.collide = PARTICLES.collisionInterval;
        p.previous = [...p.position];
      }
    }
    for (const t of tests) {
      const hit = cast(t.from, t.to);
      if (!hit) continue;
      this.spec.onHit(hit, t.from, t.to);
      const i = this.particles.indexOf(t.p);
      if (i >= 0) this.particles.splice(i, 1);
    }
  }
}

export interface DecodedSprite {
  /** Frames as RGBA (top row first). */
  frames: Array<{ width: number; height: number; rgba: Uint8ClampedArray }>;
  /** Frame numbers (1-based) of the animation, from the tile map (blood1.spr: 1..7). */
  sequence: number[];
}

/** The animation sequence of a sprite: its tile-map cells, or frame 1. */
export function spriteSequence(sprite: UiSprite): number[] {
  const cells = sprite.tiles ? Array.from(sprite.tiles.cells).filter((c) => c > 0) : [];
  return cells.length > 0 ? cells : [1];
}

export interface ParticleManager {
  /** Scene object holding the particle meshes (add to the world scene). */
  readonly object: THREE.Object3D;
  /** FUN_004f4b20: a new system (null when the sprite is missing). */
  create(spec: ParticleSystemSpec): ParticleSystem | null;
  /** True while `system` still has particles (igi.exe destroys an empty system). */
  alive(system: ParticleSystem | null): system is ParticleSystem;
  /** Delete one system (its owner was deleted). */
  remove(system: ParticleSystem): void;
  /** One game tick of every system. */
  tick(): void;
  /** Rebuild the quads for `camera` and a viewport of width x height pixels (scene hook). */
  draw(camera: THREE.Camera, viewportWidth: number, viewportHeight: number): void;
  readonly systems: readonly ParticleSystem[];
  clear(): void;
  dispose(): void;
}

const VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 tint;
varying vec2 vUv;
varying vec4 vTint;
void main() {
	vUv = uv;
	vTint = tint;
	vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
	gl_Position = projectionMatrix * mvPosition;
	#include <logdepthbuf_vertex>
}
`;

const FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D map;
varying vec2 vUv;
varying vec4 vTint;
void main() {
	#include <logdepthbuf_fragment>
	vec4 t = texture2D( map, vUv );
	gl_FragColor = vec4( t.rgb * vTint.rgb, t.a * vTint.a ); // TL MODULATE / MODULATE
}
`;

interface SpriteBatch {
  sprite: DecodedSprite;
  /** Atlas: frames stacked vertically; v range per frame. */
  bands: Array<[number, number]>;
  texture: THREE.DataTexture;
  material: THREE.ShaderMaterial;
  mesh: THREE.Mesh;
  capacity: number;
}

/** Corner offsets (screen x right, y down) of a quad of half-size (w, h) rotated by `angle` (FUN_004f3c40). */
export function particleCorners(w: number, h: number, angle: number, spinning: boolean): [[number, number], [number, number], [number, number], [number, number]] {
  if (!spinning) {
    return [
      [-w, -h],
      [w, -h],
      [-w, h],
      [w, h],
    ];
  }
  const c = Math.fround(Math.cos(angle));
  const s = Math.fround(Math.sin(angle));
  return [
    [-c * w - s * h, s * w - c * h],
    [c * w - s * h, -s * w - c * h],
    [-c * w + s * h, s * w + c * h],
    [c * w + s * h, -s * w + c * h],
  ];
}

export function createParticleManager(sprites: Map<string, UiSprite>, cast: ((from: Vec3, to: Vec3) => ParticleHit | null) | null): ParticleManager {
  const object = new THREE.Group();
  object.name = "particles";
  const systems: ParticleSystem[] = [];
  const batches = new Map<string, SpriteBatch | null>();
  let collideCounter = 0;
  const manager = {
    /** DAT_0080abc4: a 16-step counter shared by every emit. */
    nextCollide(): number {
      const v = collideCounter;
      collideCounter = (collideCounter + 1) & 15;
      return v;
    },
  };

  const batchFor = (name: string, flags = 0): SpriteBatch | null => {
    const blend = particleBlend(flags);
    const key = blend === "alpha" ? name.toLowerCase() : `${name.toLowerCase()}|${blend}`;
    if (batches.has(key)) return batches.get(key)!;
    const ui = sprites.get(name.toLowerCase());
    if (!ui || ui.frames.length === 0) {
      batches.set(key, null);
      return null;
    }
    const sprite: DecodedSprite = { frames: ui.frames, sequence: spriteSequence(ui) };
    const width = Math.max(...sprite.frames.map((f) => f.width));
    const height = sprite.frames.reduce((n, f) => n + f.height, 0);
    const rgba = new Uint8Array(width * height * 4);
    const bands: Array<[number, number]> = [];
    let y0 = 0;
    for (const f of sprite.frames) {
      for (let y = 0; y < f.height; y++) rgba.set(f.rgba.subarray(y * f.width * 4, (y + 1) * f.width * 4), ((y0 + y) * width) * 4);
      bands.push([y0 / height, (y0 + f.height) / height]);
      y0 += f.height;
    }
    const texture = new THREE.DataTexture(rgba, width, height, THREE.RGBAFormat);
    texture.flipY = false;
    texture.magFilter = THREE.LinearFilter; // TL flag 0x1000000
    texture.minFilter = THREE.LinearFilter; // no mips
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    const material = new THREE.ShaderMaterial({
      name: `igi-particles:${key}`,
      uniforms: { map: { value: texture } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: BLEND_FACTORS[blend][0],
      blendDst: BLEND_FACTORS[blend][1],
      // D3D never shows the target alpha; keep the canvas opaque (WebGL composites it).
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      fog: false,
    });
    const geometry = new THREE.BufferGeometry();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `particles:${key}`;
    mesh.frustumCulled = false;
    mesh.renderOrder = 10;
    object.add(mesh);
    const batch: SpriteBatch = { sprite, bands, texture, material, mesh, capacity: 0 };
    batches.set(key, batch);
    return batch;
  };

  const camPos = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const forward = new THREE.Vector3();

  return {
    object,
    systems,
    create(spec) {
      const batch = batchFor(spec.sprite, spec.flags);
      if (!batch) return null;
      const s = new ParticleSystem(spec, batch.sprite.sequence, manager);
      systems.push(s);
      return s;
    },
    alive(system): system is ParticleSystem {
      return system !== null && system.particles.length > 0 && systems.includes(system);
    },
    remove(system) {
      const i = systems.indexOf(system);
      if (i >= 0) systems.splice(i, 1);
    },
    tick() {
      for (const s of systems) if (!s.spec.owned) s.tick(cast);
      for (let i = systems.length - 1; i >= 0; i--) if (!systems[i].spec.owned && systems[i].particles.length === 0) systems.splice(i, 1);
    },
    draw(camera, viewportWidth, viewportHeight) {
      camera.updateMatrixWorld();
      camPos.setFromMatrixPosition(camera.matrixWorld);
      right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
      forward.setFromMatrixColumn(camera.matrixWorld, 2).normalize().negate();
      const proj = (camera as THREE.PerspectiveCamera).projectionMatrix?.elements;
      // FUN_004962b0: pixels = size x viewport scale / depth (DAT_00b70868 / 0x6c).
      const fx = proj ? proj[0] * viewportWidth * 0.5 : viewportWidth * 0.5;
      const fy = proj ? proj[5] * viewportHeight * 0.5 : viewportHeight * 0.5;
      const quads = new Map<SpriteBatch, number[]>();
      for (const s of systems) {
        if (!s.visible) continue;
        const batch = batchFor(s.spec.sprite, s.spec.flags);
        if (!batch) continue;
        let out = quads.get(batch);
        if (!out) quads.set(batch, (out = []));
        const colour = colourByte(s.spec.colour / 128) / 255;
        const alphaMode = (s.spec.flags & 0x80000) !== 0;
        for (const p of s.particles) {
          const e = enginePoint(p.position);
          const dx = e[0] - camPos.x, dy = e[1] - camPos.y, dz = e[2] - camPos.z;
          const depthM = dx * forward.x + dy * forward.y + dz * forward.z;
          const depth = depthM * UNITS;
          if (!(PARTICLES.nearUnits < depth && depth < s.spec.far)) continue;
          let w = s.spec.halfSize[0];
          let h = s.spec.halfSize[1];
          if (s.spec.growth !== 0) {
            w *= p.scale;
            h *= p.scale;
          }
          // Projected half-size (pixels), floored at 0.5, back to metres at that depth.
          let wPx = ((w / UNITS) * fx) / depthM;
          let hPx = ((h / UNITS) * fy) / depthM;
          if (wPx < PARTICLES.minHalfPixels) wPx = PARTICLES.minHalfPixels;
          if (hPx < PARTICLES.minHalfPixels) hPx = PARTICLES.minHalfPixels;
          const wm = (wPx * depthM) / fx;
          const hm = (hPx * depthM) / fy;
          const corners = particleCorners(wm, hm, p.angle, p.spin !== 0);
          const a = alphaMode ? colourByte(p.alpha) / 255 : 1;
          const c = alphaMode ? colour : colourByte((s.spec.colour / 128) * p.alpha) / 255;
          const frameNumber = batch.sprite.sequence[Math.min(p.frame, batch.sprite.sequence.length - 1)] ?? 1;
          const band = batch.bands[Math.max(0, Math.min(batch.bands.length - 1, frameNumber - 1))];
          const uv = [
            [0, band[0]],
            [1, band[0]],
            [0, band[1]],
            [1, band[1]],
          ];
          for (let k = 0; k < 4; k++) {
            const [ox, oy] = corners[k];
            out.push(
              e[0] + right.x * ox - up.x * oy,
              e[1] + right.y * ox - up.y * oy,
              e[2] + right.z * ox - up.z * oy,
              uv[k][0],
              uv[k][1],
              c,
              a,
            );
          }
        }
      }
      for (const batch of batches.values()) {
        if (!batch) continue;
        const data = quads.get(batch) ?? [];
        const count = data.length / 7 / 4;
        const geometry = batch.mesh.geometry as THREE.BufferGeometry;
        if (count > batch.capacity) {
          batch.capacity = Math.max(16, count * 2);
          geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(batch.capacity * 12), 3));
          geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(batch.capacity * 8), 2));
          geometry.setAttribute("tint", new THREE.BufferAttribute(new Float32Array(batch.capacity * 16), 4));
          const index = new Uint32Array(batch.capacity * 6);
          for (let i = 0; i < batch.capacity; i++) index.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4 + 1, i * 4 + 2, i * 4 + 3], i * 6);
          geometry.setIndex(new THREE.BufferAttribute(index, 1));
        }
        if (batch.capacity === 0) continue;
        const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
        const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
        const tint = geometry.getAttribute("tint") as THREE.BufferAttribute;
        for (let v = 0; v < count * 4; v++) {
          const o = v * 7;
          pos.setXYZ(v, data[o], data[o + 1], data[o + 2]);
          uv.setXY(v, data[o + 3], data[o + 4]);
          tint.setXYZW(v, data[o + 5], data[o + 5], data[o + 5], data[o + 6]);
        }
        pos.needsUpdate = true;
        uv.needsUpdate = true;
        tint.needsUpdate = true;
        geometry.setDrawRange(0, count * 6);
        batch.mesh.visible = count > 0;
      }
    },
    clear() {
      systems.length = 0;
    },
    dispose() {
      systems.length = 0;
      object.removeFromParent();
      for (const b of batches.values()) {
        if (!b) continue;
        b.texture.dispose();
        b.material.dispose();
        b.mesh.geometry.dispose();
      }
      batches.clear();
    },
  };
}
