/**
 * Bullet tracers [recovered: GunShot class FUN_00479b90; decision in the
 * bullet loop FUN_00479e30 0x47a7c0-0x47a90e; slots FUN_0047aba0; draw
 * FUN_004792b0 -> FUN_004d7ac0 (TL line) / FUN_0047acf0 (PolyList triangle);
 * removal FUN_0047ac40; rules in bullet-effects.ts TRACER]:
 *
 *   - only guns whose ammo type (DefineAmmoType with arg 4 = the gun's
 *     Calibre ID) has arg 12 = 1: 9 mm (919), .357, .44, 5.56, 7.62 and
 *     12.7 mm; never 12-gauge shotguns or the Dragunov (AMMO_ID_DRAGUNOV);
 *   - each gun counts casts: a cast draws a tracer when the counter is 0 or
 *     the bullet has ricocheted or passed through a face on it (counter back
 *     to 10), else the counter drops by 1; so about one cast in 11;
 *   - the tracer is that cast's segment (start -> hit point / range end);
 *     each end's fraction t = distance along the bullet / bullet range gives
 *     colour lerp(args 6-8, args 9-11, t) / 255 (level-1 ammo: (250, 200, 0)
 *     -> (255, 255, 0)) and alpha t, faded by view depth and floored at 0.2;
 *   - drawn as a 1-pixel 2-D line (TL line strip, z test, no z write,
 *     SRCALPHA/INVSRCALPHA, no texture, no fog) clipped at depth 409.6 units;
 *     a segment crossing the camera plane is instead one PolyList triangle
 *     (start, end, a vertex 286.72 units across the segment in xy at the end
 *     in front of the camera... see FUN_0047acf0) with alphas (0, 0, 1);
 *   - visible from the tick that fired until the next tick: every frame drawn
 *     marks it done (+0x34 = 0) and the next tick removes it; five slots per
 *     gun.
 */
import * as THREE from "three";
import type { Vec3 } from "../../contracts";
import type { FogUniforms } from "../render/fog";
import { DECAL_DEPTH_SCALE, DEPTH_NUDGE_VERTEX } from "../render/object-material";
import {
  TRACER,
  TracerCounter,
  UNITS,
  colourByte,
  tracerAlpha,
  tracerColour,
  type AmmoTracer,
  type BulletReport,
} from "./bullet-effects";

interface TracerSlot {
  start: Vec3;
  end: Vec3;
  /** Distances along the bullet (units) at the two ends, and the bullet range. */
  d0: number;
  d1: number;
  total: number;
  ammo: AmmoTracer;
  life: number;
  /** Crossing triangle built (+0xc0). */
  triangle: THREE.Mesh | null;
  gun: GunShot;
}

interface GunShot {
  counter: TracerCounter;
  slots: number;
  triangles: number;
}

export interface TracerSystem {
  readonly object: THREE.Group;
  /** The tracer casts of one bullet (FUN_00479e30), `ammo` = the gun's ammo tracer data (null: no tracers). */
  bullet(report: BulletReport, ammo: AmmoTracer | null): number;
  /** Per rendered frame (scene hook): build the lines for `camera`, mark every tracer drawn. */
  draw(camera: THREE.Camera): void;
  /** Per tick (FUN_0047ac40): drop drawn tracers, age the others. */
  tick(): void;
  count(): number;
  clear(): void;
  dispose(): void;
}

const LINE_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 tint;
varying vec4 vTint;
void main() {
	vTint = tint;
	vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
	gl_Position = projectionMatrix * mvPosition;
	#include <logdepthbuf_vertex>
}
`;
const LINE_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec4 vTint;
void main() {
	#include <logdepthbuf_fragment>
	gl_FragColor = vTint;
}
`;

const TRI_VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uDepthScale;
uniform float uZBiasK;
uniform float uFogK;
attribute vec4 tint;
varying vec4 vTint;
varying float vFog;
void main() {
	vTint = tint;
	vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
	gl_Position = projectionMatrix * mvPosition;
	#include <logdepthbuf_vertex>
	${DEPTH_NUDGE_VERTEX}
	vFog = exp( - uFogK * length( mvPosition.xyz ) );
}
`;
const TRI_FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uFogColour;
varying vec4 vTint;
varying float vFog;
void main() {
	#include <logdepthbuf_fragment>
	if ( floor( vTint.a * 255.0 + 0.5 ) <= 0.0 ) discard; // ALPHAREF 0, GREATER
	gl_FragColor = vec4( mix( uFogColour, vTint.rgb, vFog ), vTint.a );
}
`;

const byte = (v: number) => colourByte(v) / 255;

export function createTracerSystem(fog: FogUniforms | null): TracerSystem {
  const object = new THREE.Group();
  object.name = "tracers";
  const guns = new Map<string, GunShot>();
  const live: TracerSlot[] = [];

  const lineMaterial = new THREE.ShaderMaterial({
    name: "igi-tracer-line",
    vertexShader: LINE_VERTEX,
    fragmentShader: LINE_FRAGMENT,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const lineGeometry = new THREE.BufferGeometry();
  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  lines.name = "tracer-lines";
  lines.frustumCulled = false;
  lines.renderOrder = 11;
  object.add(lines);
  let capacity = 0;

  const triMaterial = new THREE.ShaderMaterial({
    name: "igi-tracer-triangle",
    uniforms: {
      uDepthScale: { value: DECAL_DEPTH_SCALE },
      uZBiasK: { value: 0 },
      uFogK: fog ? fog.objectFogK : { value: 0 },
      uFogColour: fog ? fog.objectFogColour : { value: new THREE.Color(0, 0, 0) },
    },
    vertexShader: TRI_VERTEX,
    fragmentShader: TRI_FRAGMENT,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide, // PolyList culls CW; which side faces the camera is not derived [inferred: both]
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });

  const camPos = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const depthOf = (p: Vec3) => ((p[0] - camPos.x) * forward.x + (p[1] - camPos.y) * forward.y + (p[2] - camPos.z) * forward.z) * UNITS;

  const removeSlot = (t: TracerSlot) => {
    if (t.triangle) {
      t.triangle.removeFromParent();
      t.triangle.geometry.dispose();
      t.triangle = null;
      t.gun.triangles--;
    }
    t.gun.slots--;
  };

  return {
    object,
    bullet(report, ammo) {
      const key = `${report.shooter}|${report.weaponId}`;
      let gun = guns.get(key);
      if (!gun) guns.set(key, (gun = { counter: new TracerCounter(), slots: 0, triangles: 0 }));
      const has = ammo !== null && ammo.tracer;
      const total = report.rangeMetres * UNITS;
      let d0 = 0;
      let added = 0;
      for (const seg of report.segments) {
        const len = Math.hypot(seg.end[0] - seg.start[0], seg.end[1] - seg.start[1], seg.end[2] - seg.start[2]) * UNITS;
        if (!gun.counter.cast(has, seg, len)) continue;
        const d1 = Math.fround(len + d0);
        if (gun.slots < TRACER.slots) {
          gun.slots++;
          live.push({ start: [...seg.start], end: [...seg.end], d0, d1, total, ammo: ammo!, life: TRACER.lifeTicks, triangle: null, gun });
          added++;
        }
        d0 = d1;
      }
      return added;
    },
    draw(camera) {
      camera.updateMatrixWorld();
      camPos.setFromMatrixPosition(camera.matrixWorld);
      forward.setFromMatrixColumn(camera.matrixWorld, 2).normalize().negate();
      const data: number[] = [];
      for (const t of live) {
        const f0 = t.total > 0 ? Math.fround(t.d0 / t.total) : 0;
        const f1 = t.total > 0 ? Math.fround(t.d1 / t.total) : 0;
        const c0 = tracerColour(t.ammo, f0);
        const c1 = tracerColour(t.ammo, f1);
        let z0 = depthOf(t.start);
        let z1 = depthOf(t.end);
        const a0 = tracerAlpha(f0, z0);
        const a1 = tracerAlpha(f1, z1);
        t.life = 0; // drawn (FUN_004792b0 sets +0x34 = 0)
        if (z1 < 0 === z0 < 0) {
          // FUN_004d7ac0: clip at the near depth, colours stay the end colours.
          let p0 = t.start;
          let p1 = t.end;
          const near = TRACER.nearClip;
          if (z0 > near) {
            if (z1 <= near) {
              const k = (near - z1) / (z0 - z1);
              p1 = [k * (p0[0] - p1[0]) + p1[0], k * (p0[1] - p1[1]) + p1[1], k * (p0[2] - p1[2]) + p1[2]];
              z1 = near;
            }
          } else {
            if (z1 <= near) continue;
            const k = (near - z0) / (z1 - z0);
            p0 = [k * (p1[0] - p0[0]) + p0[0], k * (p1[1] - p0[1]) + p0[1], k * (p1[2] - p0[2]) + p0[2]];
            z0 = near;
          }
          data.push(...p0, byte(c0[0]), byte(c0[1]), byte(c0[2]), byte(a0), ...p1, byte(c1[0]), byte(c1[1]), byte(c1[2]), byte(a1));
        } else if (!t.triangle && t.gun.triangles < TRACER.crossingMax) {
          // FUN_0047acf0: third vertex 286.72 units across the segment (xy) at the end that is in front.
          const sx = t.start[0], sy = -t.start[2];
          const ex = t.end[0], ey = -t.end[2];
          let wx = -(ey - sy);
          let wy = ex - sx;
          const l = Math.hypot(wx, wy);
          if (l === 0) continue;
          wx = (wx / l) * (TRACER.crossingWidth / UNITS);
          wy = (wy / l) * (TRACER.crossingWidth / UNITS);
          const base = z0 > 0 ? t.end : t.start;
          const third: Vec3 = [base[0] + wx, base[1], base[2] - wy];
          const g = new THREE.BufferGeometry();
          g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([...t.start, ...t.end, ...third]), 3));
          g.setAttribute(
            "tint",
            new THREE.BufferAttribute(new Float32Array([byte(c0[0]), byte(c0[1]), byte(c0[2]), 0, byte(c1[0]), byte(c1[1]), byte(c1[2]), 0, byte(c1[0]), byte(c1[1]), byte(c1[2]), 1]), 4),
          );
          const mesh = new THREE.Mesh(g, triMaterial);
          mesh.frustumCulled = false;
          mesh.name = "tracer-crossing";
          object.add(mesh);
          t.triangle = mesh;
          t.gun.triangles++;
        }
      }
      const count = data.length / 14;
      if (count > capacity) {
        capacity = Math.max(16, count * 2);
        lineGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(capacity * 6), 3));
        lineGeometry.setAttribute("tint", new THREE.BufferAttribute(new Float32Array(capacity * 8), 4));
      }
      if (capacity > 0) {
        const pos = lineGeometry.getAttribute("position") as THREE.BufferAttribute;
        const tint = lineGeometry.getAttribute("tint") as THREE.BufferAttribute;
        for (let v = 0; v < count * 2; v++) {
          const o = v * 7;
          pos.setXYZ(v, data[o], data[o + 1], data[o + 2]);
          tint.setXYZW(v, data[o + 3], data[o + 4], data[o + 5], data[o + 6]);
        }
        pos.needsUpdate = true;
        tint.needsUpdate = true;
        lineGeometry.setDrawRange(0, count * 2);
      }
      lines.visible = count > 0;
    },
    tick() {
      for (let i = live.length - 1; i >= 0; i--) {
        const t = live[i];
        if (t.life === 0) {
          removeSlot(t);
          live.splice(i, 1);
        }
      }
      for (const t of live) t.life--;
    },
    count() {
      return live.length;
    },
    clear() {
      for (const t of live) removeSlot(t);
      live.length = 0;
      guns.clear();
      lines.visible = false;
    },
    dispose() {
      this.clear();
      object.removeFromParent();
      lineGeometry.dispose();
      lineMaterial.dispose();
      triMaterial.dispose();
    },
  };
}
