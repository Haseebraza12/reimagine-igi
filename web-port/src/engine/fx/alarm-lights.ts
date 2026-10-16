/**
 * SCamera alarm lights [recovered: lens draw LAB_00441c50 (method 4) ->
 * FUN_00496190 / FUN_004962b0 / FUN_004ab6b0 -> TL primitive FUN_00504300,
 * states FUN_00504b00 / FUN_00504c40 / FUN_00504e40; docs/mission.md
 * "SCamera light"]:
 *
 *   - while the holder isOn, before the head model, the lens projects
 *     lens + R x magic vertex 0 of its model; in front of the camera (view
 *     depth > 0) it draws one screen quad of `alarmlight.spr` frame 0
 *     (registered by FUN_004158c0 at class registration, loaded from
 *     "LOCAL:common/sprites/" by FUN_00415270) centred there, half-size = the
 *     world half-size x the viewport scale / depth (a camera-facing square
 *     of that world size), all four corners at the centre's depth;
 *   - colour (r, g, b) / 128 (0x532a90) from the lens state
 *     (securityCameraLight), bytes trunc(v x 255) (chop mode); the 0.5 vertex
 *     alpha is ignored: with flags 0x1040008 none of 0x10880024 is set, so
 *     FUN_00504300 writes alpha 255;
 *   - flags 0x1040008: 0x1000000 bilinear (clamp, no mips), 0x40000 z test
 *     LESSEQUAL without z write (the primitive goes to the depth-sorted
 *     deferred list FUN_004ad570), 0x8 blend SRCALPHA / ONE (additive) and
 *     alpha test > 10; FOGENABLE 0; texture x diffuse, alpha = texture alpha.
 *
 * Positions arrive in engine metres (mission-system securityCameraLights()).
 *
 * The AlarmLight reflector's glow (full exe FUN_00439f10, world/world-tasks.ts
 * alarmLightGlows) uses the same sprite, flags 0x1040008 and depth test; it is
 * drawn only while the camera is on the lamp's local +y side:
 * (camera - lamp origin) . (lamp +0x108 column 1) > 0 (`facing`).
 */
import * as THREE from "three";
import type { Vec3 } from "../../contracts";
import type { UiSprite } from "../../loaders";
import { colourByte } from "./bullet-effects";

/** The light sprite (FUN_004158c0("alarmlight.spr") in the SCamera class registration, 0x440635). */
export const ALARM_LIGHT_SPRITE = "alarmlight.spr";

/** One light: screen-aligned square at `position` (engine metres), colour in the 1/128 scale, half-size metres. */
export interface AlarmLightQuad {
  position: Vec3;
  rgb: Vec3;
  halfSize: number;
  /** Drawn only when (camera - origin) . axis > 0 (engine space; the AlarmLight glow). */
  facing?: { origin: Vec3; axis: Vec3 };
}

export interface AlarmLightRenderer {
  readonly object: THREE.Object3D;
  /** Rebuild the quads for `camera` (scene hook, every render of the world). */
  draw(camera: THREE.Camera, lights: readonly AlarmLightQuad[]): void;
  /** Quads drawn by the last draw (diagnostics / tests). */
  readonly count: number;
  dispose(): void;
}

const VERTEX = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 tint;
varying vec2 vUv;
varying vec3 vTint;
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
varying vec3 vTint;
void main() {
	#include <logdepthbuf_fragment>
	vec4 t = texture2D( map, vUv );
	if ( t.a * 255.0 <= 10.0 ) discard; // ALPHATESTENABLE, ALPHAREF 10, GREATER (flag 0x8)
	gl_FragColor = vec4( t.rgb * vTint, t.a ); // MODULATE(TEXTURE, DIFFUSE); diffuse alpha 255
}
`;

/** Diffuse byte of a 1/128-scale colour channel (FUN_004ab6b0 x 0x532a90, FUN_00504300 trunc(v x 255)). */
export function alarmLightChannel(c128: number): number {
  return colourByte(Math.fround(c128 * Math.fround(0.0078125))) / 255;
}

export function createAlarmLightRenderer(sprite: UiSprite): AlarmLightRenderer | null {
  const frame = sprite.frames[0];
  if (!frame) return null;
  const texture = new THREE.DataTexture(new Uint8Array(frame.rgba), frame.width, frame.height, THREE.RGBAFormat);
  texture.flipY = false;
  texture.magFilter = THREE.LinearFilter; // 0x1000000
  texture.minFilter = THREE.LinearFilter; // no mips
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  const material = new THREE.ShaderMaterial({
    name: "igi-alarm-light",
    uniforms: { map: { value: texture } },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthTest: true, // 0x40000: ZFUNC LESSEQUAL
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.SrcAlphaFactor, // 0x8: SRCALPHA / ONE
    blendDst: THREE.OneFactor,
    fog: false, // FOGENABLE 0
  });
  const geometry = new THREE.BufferGeometry();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "alarm-lights";
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.visible = false;
  let capacity = 0;
  let count = 0;
  const camPos = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const forward = new THREE.Vector3();

  return {
    object: mesh,
    get count() {
      return count;
    },
    draw(camera, lights) {
      camera.updateMatrixWorld();
      camPos.setFromMatrixPosition(camera.matrixWorld);
      right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
      forward.setFromMatrixColumn(camera.matrixWorld, 2).normalize().negate();
      const quads: AlarmLightQuad[] = [];
      for (const l of lights) {
        // FUN_00496190: drawn only when the view depth is > 0.
        const depth = (l.position[0] - camPos.x) * forward.x + (l.position[1] - camPos.y) * forward.y + (l.position[2] - camPos.z) * forward.z;
        if (!(depth > 0)) continue;
        const f = l.facing;
        if (f && !((camPos.x - f.origin[0]) * f.axis[0] + (camPos.y - f.origin[1]) * f.axis[1] + (camPos.z - f.origin[2]) * f.axis[2] > 0)) continue;
        quads.push(l);
      }
      count = quads.length;
      if (count > capacity) {
        capacity = Math.max(8, count * 2);
        geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(capacity * 12), 3));
        geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(capacity * 8), 2));
        geometry.setAttribute("tint", new THREE.BufferAttribute(new Float32Array(capacity * 12), 3));
        const index = new Uint32Array(capacity * 6);
        for (let i = 0; i < capacity; i++) index.set([i * 4, i * 4 + 2, i * 4 + 1, i * 4 + 1, i * 4 + 2, i * 4 + 3], i * 6);
        geometry.setIndex(new THREE.BufferAttribute(index, 1));
      }
      mesh.visible = count > 0;
      if (count === 0) return;
      const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
      const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
      const tint = geometry.getAttribute("tint") as THREE.BufferAttribute;
      // Corners (x - h, y - h), (x + h, y - h), (x - h, y + h), (x + h, y + h) in screen space (y down), uv (0,0) (1,0) (0,1) (1,1).
      const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
      quads.forEach((l, q) => {
        const c = [alarmLightChannel(l.rgb[0]), alarmLightChannel(l.rgb[1]), alarmLightChannel(l.rgb[2])];
        corners.forEach(([sx, sy], k) => {
          const ox = sx * l.halfSize;
          const oy = sy * l.halfSize;
          const v = q * 4 + k;
          pos.setXYZ(v, l.position[0] + right.x * ox - up.x * oy, l.position[1] + right.y * ox - up.y * oy, l.position[2] + right.z * ox - up.z * oy);
          uv.setXY(v, (sx + 1) / 2, (sy + 1) / 2);
          tint.setXYZ(v, c[0], c[1], c[2]);
        });
      });
      pos.needsUpdate = true;
      uv.needsUpdate = true;
      tint.needsUpdate = true;
      geometry.setDrawRange(0, count * 6);
    },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
