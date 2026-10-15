/**
 * FlatSky dome and FlatSkyLayer clouds, drawn like igi.exe (docs/rendering.md
 * section 4; recovered FUN_00517d20, FUN_00518670, FUN_005268b0..FUN_00526de0,
 * FUN_00518760, FUN_00518850, FUN_00504300):
 *
 *   order    : Clear(FlatSky "Fog Color") -> dome -> cloud layers (task order)
 *              -> terrain/objects (environment.ts sets the clear colour; the
 *              dome and clouds sit first in the opaque list via renderOrder).
 *   dome     : the 321-vertex Gouraud mesh of render-params buildSkyDome,
 *              vertex colours only, rotated about the vertical so "Colour 1"
 *              faces the first directional light (skyDomeYawRad), centred on
 *              the camera; no depth test/write, no fog, no blending.
 *   clouds   : a plane "Z Pos" metres above the camera (camera-relative: no
 *              parallax). Per fragment: ray r (IGI axes), drawn only for
 *              r.z > 0; hit = r * ZPos / r.z; uv = hit.xy * Scale + offset;
 *              alpha = cloudLayerAlpha(camera depth of hit) x layer Alpha;
 *              colour = texture x layer Color, alpha = texture alpha x that;
 *              SRCALPHA/INVSRCALPHA, bilinear, no mipmaps, WRAP, no depth,
 *              no fog. Offsets advance by (X Speed, Y Speed) per 30 Hz game
 *              tick, wrapped to [0, 1].
 *   [approximation] igi.exe draws the clouds as a 13-row screen-space strip
 *   above the horizon (26 pre-transformed vertices, UV perspective-correct,
 *   alpha Gouraud); this draws the screen region above the horizon (clipped
 *   on the CPU each frame) and computes the same plane mapping per fragment,
 *   so UVs are identical and alpha differs only by the linear interpolation
 *   between those 13 rows.
 */
import * as THREE from "three";
import {
  IGI_PER_METRE,
  buildSkyDome,
  skyDomeYawRad,
  type FlatSkyParams,
  type SkyLayerParams,
} from "../../loaders";

/** Any radius inside the camera range works: depth test and write are off. */
const DOME_RADIUS_M = 1000;

/** Engine-space (x, y, z) of an IGI-axes direction (x, y, z): (x, z, -y) (loaders/coords.ts). */
export function igiDirToEngineAxes(x: number, y: number, z: number): [number, number, number] {
  return [x, z, -y];
}

/** IGI-axes direction of an engine-space direction: inverse of igiDirToEngineAxes. */
export function engineDirToIgiAxes(x: number, y: number, z: number): [number, number, number] {
  return [x, -z, y];
}

/** Dome geometry in engine axes (unit dome scaled to DOME_RADIUS_M), colours as normalised bytes. */
export function skyDomeGeometry(sky: FlatSkyParams): THREE.BufferGeometry {
  const dome = buildSkyDome(sky);
  const positions = new Float32Array(dome.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const [x, y, z] = igiDirToEngineAxes(dome.positions[i], dome.positions[i + 1], dome.positions[i + 2]);
    positions[i] = x * DOME_RADIUS_M;
    positions[i + 1] = y * DOME_RADIUS_M;
    positions[i + 2] = z * DOME_RADIUS_M;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  // D3DCOLOR bytes, Gouraud-interpolated (normalised: 0..255 -> 0..1, used as stored).
  geometry.setAttribute("color", new THREE.BufferAttribute(new Uint8Array(dome.colours), 3, true));
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(dome.indices), 1));
  return geometry;
}

/** Dome yaw (Three.js rotation.y) for the first directional light's toward-the-light vector in ENGINE axes. */
export function skyDomeYawForEngineLight(sunToward: readonly [number, number, number]): number {
  const [lx, ly] = engineDirToIgiAxes(sunToward[0], sunToward[1], sunToward[2]);
  // A rotation about IGI +z by a equals rotation.y = a in engine axes (x, z, -y).
  return skyDomeYawRad(lx, ly);
}

export function createSkyDome(sky: FlatSkyParams, sunTowardEngine: readonly [number, number, number]): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial({
    name: "igi-sky-dome",
    vertexColors: true,
    depthTest: false,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide, // seen from inside; CULL CCW only removes the outside
    toneMapped: false,
  });
  const dome = new THREE.Mesh(skyDomeGeometry(sky), material);
  dome.name = "sky-dome";
  dome.rotation.y = skyDomeYawForEngineLight(sunTowardEngine);
  dome.frustumCulled = false;
  dome.renderOrder = -1000; // first in the opaque list
  return dome;
}

/**
 * JS mirror of the cloud fragment shader (tests and tools): for a view ray
 * in ENGINE axes and the camera's forward axis, the layer UV (before
 * wrapping) and alpha, or null below the horizon.
 */
export function cloudSample(
  rayEngine: readonly [number, number, number],
  forwardEngine: readonly [number, number, number],
  sky: FlatSkyParams,
  layer: SkyLayerParams,
  offset: readonly [number, number],
): { u: number; v: number; alpha: number; depthM: number } | null {
  const r = engineDirToIgiAxes(rayEngine[0], rayEngine[1], rayEngine[2]);
  if (!(r[2] > 0)) return null;
  const f = engineDirToIgiAxes(forwardEngine[0], forwardEngine[1], forwardEngine[2]);
  const t = (sky.zPosM * IGI_PER_METRE) / r[2]; // IGI units along r
  const hit = [r[0] * t, r[1] * t, r[2] * t];
  const fl = Math.hypot(f[0], f[1], f[2]);
  const depthIgi = (hit[0] * f[0] + hit[1] * f[1] + hit[2] * f[2]) / fl;
  const D = sky.distanceM * IGI_PER_METRE;
  const s = D - (D - 409.6) * sky.fogAmount;
  let a = 1;
  if (depthIgi >= s) {
    a = (s - (s * D) / depthIgi) / (s - D);
    a = a <= 0 ? 0 : a > 0.999 ? 0.999 : a;
  }
  return {
    u: hit[0] * layer.scale + offset[0],
    v: hit[1] * layer.scale + offset[1],
    alpha: a * layer.alpha,
    depthM: depthIgi / IGI_PER_METRE,
  };
}

/** Wrap a scroll offset to [0, 1) after `ticks` 30 Hz game ticks (FUN_00518760 adds the speed per tick and wraps). */
export function cloudOffsetAfterTicks(speedPerTick: readonly [number, number], ticks: number): [number, number] {
  const wrap = (x: number) => x - Math.floor(x);
  return [wrap(speedPerTick[0] * ticks), wrap(speedPerTick[1] * ticks)];
}

export interface CloudLayer {
  mesh: THREE.Mesh;
  /** Set the scroll offset (already wrapped). */
  setOffset(u: number, v: number): void;
  /** Fit the drawn region to the screen part above the horizon for `camera` (call before Three builds its lists). */
  prepare(camera: THREE.Camera): void;
  dispose(): void;
}

/**
 * The part of the screen (NDC polygon, counter-clockwise) whose view rays
 * point above the horizon (world +y > 0), clipped to the screen rectangle:
 * igi.exe draws the cloud strip only there. Empty when looking down.
 * The ray's world y is affine in NDC (x, y) for a perspective projection.
 */
export function aboveHorizonPolygon(cameraWorld: THREE.Matrix4, projectionInverse: THREE.Matrix4): Array<[number, number]> {
  const v = new THREE.Vector4();
  const e = cameraWorld.elements;
  const worldY = (x: number, y: number) => {
    v.set(x, y, 1, 1).applyMatrix4(projectionInverse);
    return (e[1] * v.x + e[5] * v.y + e[9] * v.z) / v.w;
  };
  const f0 = worldY(0, 0);
  const fx = worldY(1, 0) - f0;
  const fy = worldY(0, 1) - f0;
  const f = (p: [number, number]) => f0 + fx * p[0] + fy * p[1];
  let poly: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const out: Array<[number, number]> = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const fa = f(a);
    const fb = f(b);
    if (fa > 0) out.push(a);
    if (fa > 0 !== fb > 0) {
      const t = fa / (fa - fb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  poly = out;
  return poly.length >= 3 ? poly : [];
}

const CLOUD_VERTEX = /* glsl */ `
uniform mat4 uInvProjection;
uniform mat4 uCameraWorld;
varying vec3 vRay;
void main() {
	// View ray of this screen point, IGI axes; affine in NDC, so the linear
	// interpolation across the polygon is exact (w = 1, no perspective).
	vec4 v = uInvProjection * vec4( position.xy, 1.0, 1.0 );
	vec3 e = mat3( uCameraWorld ) * ( v.xyz / v.w );
	vRay = vec3( e.x, -e.z, e.y );
	gl_Position = vec4( position.xy, 0.0, 1.0 ); // screen space; no depth test
}
`;

const CLOUD_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D map;
uniform vec3 uForward;     // camera forward, IGI axes, unit
uniform vec3 uColour;      // layer Color, clamped 0..1 (FUN_00518850)
uniform float uLayerAlpha; // layer Alpha
uniform float uZPos;       // IGI units above the camera
uniform float uScale;      // repeats per IGI unit
uniform vec2 uOffset;      // per-tick scroll, wrapped
uniform float uFadeStart;  // s = D - (D - 409.6) * FogAmount (IGI units)
uniform float uFadeEnd;    // D = Distance * 4096
varying vec3 vRay;
void main() {
	vec3 r = vRay;
	if ( r.z <= 0.0 ) discard;                        // only rays above the horizon
	vec3 hit = r * ( uZPos / r.z );
	float z = dot( hit, uForward );                   // camera depth of the plane point
	float a = 1.0;
	if ( z >= uFadeStart ) {
		a = ( uFadeStart - uFadeStart * uFadeEnd / z ) / ( uFadeStart - uFadeEnd );
		a = a <= 0.0 ? 0.0 : ( a > 0.999 ? 0.999 : a );
	}
	vec2 uv = hit.xy * uScale + uOffset;
	vec4 tex = texture( map, uv );
	gl_FragColor = vec4( tex.rgb * uColour, tex.a * a * uLayerAlpha );
}
`;

/** One FlatSkyLayer as a screen-space pass above the horizon (see the header). `texture` = decoded layer .tex as a GPU texture. */
export function createCloudLayer(sky: FlatSkyParams, layer: SkyLayerParams, texture: THREE.Texture, order: number): CloudLayer {
  const D = sky.distanceM * IGI_PER_METRE;
  const uniforms = {
    map: { value: texture },
    uInvProjection: { value: new THREE.Matrix4() },
    uCameraWorld: { value: new THREE.Matrix4() },
    uForward: { value: new THREE.Vector3(0, 1, 0) },
    uColour: { value: new THREE.Color().setRGB(layer.colour[0], layer.colour[1], layer.colour[2]) },
    uLayerAlpha: { value: layer.alpha },
    uZPos: { value: sky.zPosM * IGI_PER_METRE },
    uScale: { value: layer.scale },
    uOffset: { value: new THREE.Vector2() },
    uFadeStart: { value: D - (D - 409.6) * sky.fogAmount },
    uFadeEnd: { value: D },
  };
  const material = new THREE.ShaderMaterial({
    name: "igi-cloud-layer",
    uniforms,
    vertexShader: CLOUD_VERTEX,
    fragmentShader: CLOUD_FRAGMENT,
    depthTest: false,
    depthWrite: false,
    fog: false,
    // CustomBlending applies even in the opaque list (Three only disables NormalBlending there).
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    transparent: false,
    side: THREE.DoubleSide,
  });
  // Up to a pentagon (screen rectangle clipped by the horizon) = 3 triangles.
  const positions = new THREE.BufferAttribute(new Float32Array(9 * 3), 3);
  positions.setUsage(THREE.DynamicDrawUsage);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", positions);
  geometry.setDrawRange(0, 0);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "sky-cloud-layer";
  mesh.frustumCulled = false;
  mesh.renderOrder = -999 + order; // after the dome, before the world, in task order
  const forward = new THREE.Vector3();
  return {
    mesh,
    setOffset(u, v) {
      uniforms.uOffset.value.set(u, v);
    },
    prepare(camera) {
      uniforms.uInvProjection.value.copy(camera.projectionMatrixInverse);
      uniforms.uCameraWorld.value.copy(camera.matrixWorld);
      forward.set(0, 0, -1).transformDirection(camera.matrixWorld);
      uniforms.uForward.value.set(forward.x, -forward.z, forward.y);
      const poly = aboveHorizonPolygon(camera.matrixWorld, camera.projectionMatrixInverse);
      let n = 0;
      for (let i = 1; i + 1 < poly.length; i++) {
        for (const p of [poly[0], poly[i], poly[i + 1]]) positions.setXYZ(n++, p[0], p[1], 0);
      }
      positions.needsUpdate = true;
      geometry.setDrawRange(0, n);
      mesh.visible = n > 0;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/** GPU texture for a cloud layer: bilinear, no mipmaps, WRAP (TL flags 0x41480000). */
export function cloudTexture(decoded: { width: number; height: number; rgba: Uint8ClampedArray }): THREE.DataTexture {
  const t = new THREE.DataTexture(
    new Uint8Array(decoded.rgba.buffer as ArrayBuffer, decoded.rgba.byteOffset, decoded.rgba.byteLength),
    decoded.width,
    decoded.height,
    THREE.RGBAFormat,
  );
  t.flipY = false;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
