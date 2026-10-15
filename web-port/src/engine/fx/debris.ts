/**
 * Impact fragments and shell casings: small rigid models moved by igi.exe's
 * per-tick rules (bullet-effects.ts FRAGMENTS / CASING) [recovered]:
 *
 *   Fragments (GunShotEffect "debris" flag): Explosion0 (FUN_0047f410) with
 *   no fireball, no smoke, no sound and no damage; its first tick bursts
 *   rand(3) + 2 copies of the material's model (1009/1011/1012/1013_01_1) at
 *   the hit point, scale 0.1, launched in a 30-degree half cone around the
 *   mirrored bullet direction at 340-680 units/tick (FUN_0047d570 /
 *   FUN_0047d440); all copies share one spin (three floats x 0.6283 rad/tick,
 *   x 0.99 per tick) applied as R = spin R; velocity x 0.98 per tick and
 *   -19.67 units/tick in z (FUN_004fa1d0); no collision; each lives 45 ticks
 *   (+1 to be removed, FUN_004fa7d0).
 *
 *   Casings (player's gun only, WeaponConfig "Casing Model"): FUN_00476430 at
 *   the gun's XTVM point 3, the gun's rotation, velocity gun-rotated
 *   (s cos a, 0, s sin a) plus the shooter's vector; v.z -= 44.6 then v x
 *   0.985 per tick, R = R x spin; no collision; 19 ticks (FUN_004769f0).
 *   They are drawn with the first-person gun (GunCasing +0xec = 0 = layer 0)
 *   and only when the camera's +0x5c flag is set (0x476c30) [flag meaning
 *   inferred: first-person view].
 *
 * Both draw as rigid vertex-lit objects: texture x clamp(ambient + front x
 * max(0, n . sun)), object fog for fragments (world layer) [render path:
 * RigidDynCubeObj class draw, as world objects].
 */
import * as THREE from "three";
import type { Vec3 } from "../../contracts";
import type { IgiLevel } from "../../loaders";
import type { FogUniforms } from "../render/fog";
import { whiteTexture } from "../render/object-material";
import { createLevelTexture } from "../world/world-builder";
import {
  CASING,
  FRAGMENTS,
  casingLaunch,
  casingStep,
  enginePoint,
  fragmentLaunch,
  fragmentStep,
  mulMat3Vec,
  rotZYX,
  x87Spin,
  type DebrisPlan,
  type EffectRng,
  type Mat3,
} from "./bullet-effects";
import type { EffectModel } from "./effect-assets";
import { explosionFragmentStep } from "../combat/explosion-rules";

const VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform vec3 uSunDir;
uniform vec3 uAmbient;
uniform vec3 uFront;
uniform float uFogK;
varying vec2 vUv;
varying vec3 vLight;
varying float vFog;
void main() {
	vUv = uv;
	vec3 n = normalize( mat3( modelMatrix ) * normal );
	vLight = min( vec3( 1.0 ), uAmbient + uFront * max( 0.0, dot( n, uSunDir ) ) );
	vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
	gl_Position = projectionMatrix * mvPosition;
	#include <logdepthbuf_vertex>
	vFog = exp( - uFogK * length( mvPosition.xyz ) );
}
`;

const FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D map;
uniform vec3 uFogColour;
varying vec2 vUv;
varying vec3 vLight;
varying float vFog;
void main() {
	#include <logdepthbuf_fragment>
	vec4 t = texture2D( map, vUv );
	gl_FragColor = vec4( mix( uFogColour, t.rgb * vLight, vFog ), 1.0 );
}
`;

/** IGI rotation (world = R v, z up) -> engine rotation (y up). */
export function engineRotation(r: Mat3): THREE.Matrix4 {
  // C = [[1,0,0],[0,0,1],[0,-1,0]]; engine = C R C^T.
  const c = [1, 0, 0, 0, 0, 1, 0, -1, 0];
  const m = (a: number[], b: number[]) => {
    const o = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
    return o;
  };
  const ct = [1, 0, 0, 0, 0, -1, 0, 1, 0];
  const e = m(m(c, r), ct);
  return new THREE.Matrix4().set(e[0], e[1], e[2], 0, e[3], e[4], e[5], 0, e[6], e[7], e[8], 0, 0, 0, 0, 1);
}

/** Engine rotation (column-major Matrix4 upper 3x3) -> IGI rotation. */
export function igiRotation(m: THREE.Matrix4): Mat3 {
  const e = m.elements;
  // engine row-major r_e[i][j] = e[j*4+i]; IGI = C^T r_e C.
  const re = [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
  const ct = [1, 0, 0, 0, 0, -1, 0, 1, 0];
  const c = [1, 0, 0, 0, 0, 1, 0, -1, 0];
  const mul = (a: number[], b: number[]) => {
    const o = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
    return o;
  };
  return mul(mul(ct, re), c) as Mat3;
}

export interface ModelLook {
  level: IgiLevel;
  fog: FogUniforms | null;
}

/** Shared mesh resources of one effect model. */
class ModelKit {
  readonly geometry: THREE.BufferGeometry;
  readonly materials: THREE.ShaderMaterial[];
  constructor(model: EffectModel, look: ModelLook, textures: Map<string, THREE.Texture>) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(model.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(model.normals, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(model.uv, 2));
    g.setIndex(new THREE.BufferAttribute(model.indices, 1));
    g.computeBoundingSphere();
    const light = look.level.objectLight;
    this.materials = model.groups.map((grp, i) => {
      g.addGroup(grp.start, grp.count, i);
      let map: THREE.Texture | null = null;
      if (grp.texture) {
        map = textures.get(grp.texture) ?? null;
        if (!map && look.level.textures.has(grp.texture)) {
          map = createLevelTexture(look.level, grp.texture).texture;
          textures.set(grp.texture, map);
        }
      }
      return new THREE.ShaderMaterial({
        name: `igi-effect-model:${model.name}`,
        uniforms: {
          map: { value: map ?? whiteTexture() },
          uSunDir: { value: new THREE.Vector3(...light.sunDirection) },
          uAmbient: { value: new THREE.Vector3(...light.ambient) },
          uFront: { value: new THREE.Vector3(...light.front) },
          uFogK: look.fog ? look.fog.objectFogK : { value: 0 },
          uFogColour: look.fog ? look.fog.objectFogColour : { value: new THREE.Color(0, 0, 0) },
        },
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        side: THREE.FrontSide,
      });
    });
    this.geometry = g;
  }
  mesh(): THREE.Mesh {
    const m = new THREE.Mesh(this.geometry, this.materials);
    m.matrixAutoUpdate = false;
    m.frustumCulled = false;
    return m;
  }
  dispose(): void {
    this.geometry.dispose();
    for (const m of this.materials) m.dispose();
  }
}

class Kits {
  private readonly kits = new Map<string, ModelKit | null>();
  private readonly textures = new Map<string, THREE.Texture>();
  constructor(
    private readonly models: Map<string, EffectModel>,
    private readonly look: ModelLook,
  ) {}
  get(name: string): ModelKit | null {
    if (this.kits.has(name)) return this.kits.get(name)!;
    const model = this.models.get(name);
    const kit = model ? new ModelKit(model, this.look, this.textures) : null;
    this.kits.set(name, kit);
    return kit;
  }
  dispose(): void {
    for (const k of this.kits.values()) k?.dispose();
    for (const t of this.textures.values()) t.dispose();
    this.kits.clear();
    this.textures.clear();
  }
}

const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();
function place(mesh: THREE.Mesh, positionIgi: Vec3, rotation: Mat3, scale: number): void {
  const r = engineRotation(rotation);
  const p = enginePoint(positionIgi);
  tmpScale.set(scale, scale, scale);
  mesh.matrix.copy(r).scale(tmpScale);
  mesh.matrix.setPosition(tmpPos.set(p[0], p[1], p[2]));
  mesh.matrixWorldNeedsUpdate = true;
}

interface Fragment {
  position: Vec3;
  velocity: Vec3;
  rotation: Mat3;
  life: number;
  mesh: THREE.Mesh;
}

interface Burst {
  plan: DebrisPlan;
  origin: Vec3;
  spin: Vec3;
  fragments: Fragment[];
  burst: boolean;
  /** Explosion fragments: the container's own gravity per tick (FUN_0047f410 size radius x 0.9/4096). */
  gravity?: number;
}

export interface FragmentSystem {
  readonly object: THREE.Group;
  /** Explosion0 created at `hitIgi` (IGI units rel. origin); its fragments burst on the next tick. */
  spawn(plan: DebrisPlan, hitIgi: Vec3): void;
  /**
   * An explosion's fragments, already launched by FUN_0047d570 (velocities and
   * tilts drawn there, combat/explosion-rules.ts fragmentPlan): `originIgi` =
   * the centre (IGI units rel. origin), `spin` = the container's spin,
   * `gravity` = its per-tick gravity (fragmentGravity(radius)). The next
   * tick() moves them with the same rules (FUN_004fa1d0 / FUN_004fa7d0): the
   * container follows the Explosion0 in the Dynamic walk, so call tick() in
   * the same game tick.
   */
  launch(model: string, originIgi: Vec3, pieces: ReadonlyArray<{ velocity: Vec3; rotation: Mat3 }>, spin: Vec3, gravity: number): boolean;
  /** One game tick (`rng` = the level generator for the bursts). */
  tick(rng: EffectRng): void;
  count(): number;
  clear(): void;
  dispose(): void;
}

export function createFragmentSystem(models: Map<string, EffectModel>, look: ModelLook): FragmentSystem {
  const object = new THREE.Group();
  object.name = "impact-fragments";
  const kits = new Kits(models, look);
  const bursts: Burst[] = [];
  return {
    object,
    spawn(plan, hitIgi) {
      if (!kits.get(plan.model)) return;
      bursts.push({ plan, origin: [...hitIgi], spin: [...plan.spin], fragments: [], burst: false });
    },
    launch(model, originIgi, pieces, spin, gravity) {
      const kit = kits.get(model);
      if (!kit || pieces.length === 0) return false;
      const burst: Burst = {
        plan: { model, count: pieces.length, spin: [...spin], direction: [0, 0, 1] },
        origin: [...originIgi],
        spin: [...spin],
        fragments: [],
        burst: true,
        gravity,
      };
      for (const p of pieces) {
        const mesh = kit.mesh();
        object.add(mesh);
        const f: Fragment = { position: [...originIgi], velocity: [...p.velocity], rotation: p.rotation, life: FRAGMENTS.lifeTicks, mesh };
        place(mesh, f.position, f.rotation, FRAGMENTS.scale);
        burst.fragments.push(f);
      }
      bursts.push(burst);
      return true;
    },
    tick(rng) {
      for (let b = bursts.length - 1; b >= 0; b--) {
        const burst = bursts[b];
        if (!burst.burst) {
          // FUN_0047f2b0: delay 0 -> FUN_0047d570 now, then the Explosion0 is gone.
          burst.burst = true;
          const kit = kits.get(burst.plan.model)!;
          for (let i = 0; i < burst.plan.count; i++) {
            const launch = fragmentLaunch(burst.plan.direction, rng);
            const mesh = kit.mesh();
            object.add(mesh);
            const f: Fragment = { position: [...burst.origin], velocity: launch.velocity, rotation: launch.rotation, life: FRAGMENTS.lifeTicks, mesh };
            place(mesh, f.position, f.rotation, FRAGMENTS.scale);
            burst.fragments.push(f);
          }
          continue;
        }
        // FUN_004fa1d0: spin decays, then moves every child; FUN_004fa7d0: life.
        burst.spin = [x87Spin(burst.spin[0]), x87Spin(burst.spin[1]), x87Spin(burst.spin[2])];
        const r = rotZYX(burst.spin[0], burst.spin[1], burst.spin[2]);
        for (let i = burst.fragments.length - 1; i >= 0; i--) {
          const f = burst.fragments[i];
          const s = burst.gravity === undefined ? fragmentStep(f.position, f.velocity, f.rotation, r) : explosionFragmentStep(f.position, f.velocity, f.rotation, r, burst.gravity);
          f.position = s.position;
          f.velocity = s.velocity;
          f.rotation = s.rotation;
          if (f.life < 1) {
            f.mesh.removeFromParent();
            burst.fragments.splice(i, 1);
            continue;
          }
          f.life--;
          place(f.mesh, f.position, f.rotation, FRAGMENTS.scale);
        }
        if (burst.fragments.length === 0) bursts.splice(b, 1);
      }
    },
    count() {
      return bursts.reduce((n, b) => n + b.fragments.length, 0);
    },
    clear() {
      for (const b of bursts) for (const f of b.fragments) f.mesh.removeFromParent();
      bursts.length = 0;
    },
    dispose() {
      this.clear();
      object.removeFromParent();
      kits.dispose();
    },
  };
}

interface Casing {
  position: Vec3;
  velocity: Vec3;
  rotation: Mat3;
  spin: Mat3;
  life: number;
  mesh: THREE.Mesh;
}

export interface CasingSystem {
  /** Add to the first-person gun scene (layer 0). Positions are world space. */
  readonly object: THREE.Group;
  /**
   * The player's gun fired (FUN_004772c0 0x477b80): `gunMatrix` = the gun
   * model's world matrix (engine), `ejection` = its XTVM point 3 (engine
   * gun-model metres), `shooterVelocity` = the vector the fire message carries
   * (engine metres per tick; zero when none). Draws from `rng` (level
   * generator): rand(30), rand(4), rand(2), rand(5), rand(5).
   */
  eject(model: string, gunMatrix: THREE.Matrix4, ejection: Vec3, rng: EffectRng, shooterVelocity?: Vec3): boolean;
  tick(): void;
  count(): number;
  clear(): void;
  dispose(): void;
}

export function createCasingSystem(models: Map<string, EffectModel>, look: ModelLook): CasingSystem {
  const object = new THREE.Group();
  object.name = "gun-casings";
  const kits = new Kits(models, { level: look.level, fog: null });
  const casings: Casing[] = [];
  const v = new THREE.Vector3();
  return {
    object,
    eject(model, gunMatrix, ejection, rng, shooterVelocity) {
      const kit = kits.get(model);
      if (!kit) return false;
      v.set(ejection[0], ejection[1], ejection[2]).applyMatrix4(gunMatrix);
      const position: Vec3 = [v.x * 4096, -v.z * 4096, v.y * 4096];
      const rotation = igiRotation(gunMatrix);
      const launch = casingLaunch(rng);
      const w = mulMat3Vec(rotation, launch.localVelocity);
      const sv = shooterVelocity ? [shooterVelocity[0] * 4096, -shooterVelocity[2] * 4096, shooterVelocity[1] * 4096] : [0, 0, 0];
      const mesh = kit.mesh();
      object.add(mesh);
      const c: Casing = {
        position,
        velocity: [Math.fround(w[0] + sv[0]), Math.fround(w[1] + sv[1]), Math.fround(w[2] + sv[2])],
        rotation,
        spin: launch.spin,
        life: CASING.lifeTicks,
        mesh,
      };
      place(mesh, c.position, c.rotation, 1);
      casings.push(c);
      return true;
    },
    tick() {
      for (let i = casings.length - 1; i >= 0; i--) {
        const c = casings[i];
        if (c.life === 0) {
          c.mesh.removeFromParent();
          casings.splice(i, 1);
          continue;
        }
        c.life--;
        const s = casingStep(c.position, c.velocity, c.rotation, c.spin);
        c.position = s.position;
        c.velocity = s.velocity;
        c.rotation = s.rotation;
        place(c.mesh, c.position, c.rotation, 1);
      }
    },
    count() {
      return casings.length;
    },
    clear() {
      for (const c of casings) c.mesh.removeFromParent();
      casings.length = 0;
    },
    dispose() {
      this.clear();
      object.removeFromParent();
      kits.dispose();
    },
  };
}
