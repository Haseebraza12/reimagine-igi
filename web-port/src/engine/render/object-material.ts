/**
 * Materials for placed models (rigid / lightmapped .mef blocks), reproducing
 * igi.exe's fixed-function states (docs/rendering.md section 5, recovered;
 * render-params DRAW_STATES):
 *
 *   opaque block  : Z test+write, ZBIAS 3, cull CCW (D3D) = FrontSide here
 *                   (mef.ts already flips D3D clockwise fronts to WebGL CCW),
 *                   no blend, no alpha test; vertex-lit = MODULATE(texture,
 *                   lit vertex colour), lightmapped = texture x lightmap
 *                   (uv1, CLAMP, LINEAR, no mip); object fog.
 *   deferred block: (DNER flag != 0) drawn after the opaque pass, depth
 *                   sorted, SRCALPHA/INVSRCALPHA, alpha test GREATER 1,
 *                   Z test without write, object fog.
 *   additive block: (flag bit 0) ONE/ONE, unlit (texture only), no fog,
 *                   alpha test GREATER 1, no Z write.
 *   deferred lightmapped (alpha) block: FUN_0052f780 turns D3D LIGHTING on
 *                   and sets stage 0 MODULATE(TEXTURE, DIFFUSE) after the
 *                   lightmap stage group, and the lightmapped vertex format
 *                   (FVF 0x212 = XYZ|NORMAL|TEX2, table 0x54b944) has normals,
 *                   so these blocks are texture x vertex light x lightmap
 *                   [recovered]; opaque lightmapped blocks are unlit
 *                   (SELECTARG1). Enabled with `litLightmap` (the geometry
 *                   then carries objLight as well as objLmUv).
 *   TEXTUREFACTOR:  the deferred paths set (255 - byte) << 24 (0x52f4b2,
 *                   0x52f9a5, 0x52d941) but no texture stage in igi.exe takes
 *                   D3DTA_TFACTOR or uses BLENDFACTORALPHA: no visible effect
 *                   [recovered: every SetTextureStageState call site].
 *   stage 0       : MIN/MAG LINEAR, MIPFILTER POINT (LinearMipmapNearest),
 *                   WRAP, D3DTSS_MIPMAPLODBIAS from MipMapControl (level 1:
 *                   -0.4), applied with texture(..., bias) since WebGL2 has
 *                   no LOD-bias sampler state.
 *
 * Depth: the renderer uses a logarithmic depth buffer, which writes
 * gl_FragDepth, so polygonOffset has no effect. The two recovered depth
 * nudges are applied in the vertex shader instead:
 *   - objects ZBIAS 3: pull equivalent to 3 units of a 24-bit D3D z-buffer
 *     with the world near plane (0.1 m): z_eff = z / (1 + 3*2^-24 * z / near).
 *     [approximation: D3D7 ZBIAS scale is driver-defined; 24-bit assumed]
 *   - decals / blob shadows: near plane x 1.01 (FUN_00498c10), which equals
 *     drawing at z / 1.01 [recovered; exact for the D3D projection].
 * polygonOffset is also set so the same ordering holds if log depth is off.
 */
import * as THREE from "three";
import { DEPTH_LAYERS } from "../../loaders";
import type { FogUniforms } from "./fog";

export type BlockKind = "opaque" | "deferred" | "additive";

/** View-depth pull factor k (per metre) for z_eff = z / (1 + k z): ZBIAS units of a 24-bit z-buffer at the world near plane. */
export function zBiasPerMetre(units: number, nearM: number = DEPTH_LAYERS.world.nearM, depthBits = 24): number {
  return (units * 2 ** -depthBits) / nearM;
}

/** Objects: ZBIAS 3 (DRAW_STATES.object*.zBias) [recovered value; scale approximated]. */
export const OBJECT_ZBIAS_PER_METRE = zBiasPerMetre(3);
/** Decals and blob shadows: drawn with the near plane x 1.01 (FUN_00498c10) = depth / 1.01. */
export const DECAL_DEPTH_SCALE = 1 / 1.01;

/** GLSL: depth nudge after <logdepthbuf_vertex>. Needs uniforms uDepthScale, uZBiasK. */
export const DEPTH_NUDGE_VERTEX = /* glsl */ `
#ifdef USE_LOGDEPTHBUF
	vFragDepth = 1.0 + gl_Position.w * uDepthScale / ( 1.0 + uZBiasK * gl_Position.w );
#endif
`;

/** Shared 1x1 white texture for blocks without a texture (slot without .mtp entry). */
let white: THREE.DataTexture | null = null;
export function whiteTexture(): THREE.DataTexture {
  if (!white) {
    white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
    white.needsUpdate = true;
  }
  return white;
}

export interface ObjectMaterialOptions {
  map: THREE.Texture | null;
  /** Lightmap atlas page (geometry attribute objLmUv) or null for the vertex-lit path (attribute objLight). */
  lightMap: THREE.Texture | null;
  kind: BlockKind;
  fog: FogUniforms;
  /** Shared MipMapControl LOD bias uniform. */
  mipBias: THREE.IUniform<number>;
  /**
   * Deferred lightmapped block drawn with D3D lighting on (FUN_0052f780):
   * colour = texture x objLight x lightmap. Requires an objLight attribute
   * (the same lit colour as vertex-lit blocks) next to objLmUv.
   */
  litLightmap?: boolean;
}

const VERTEX = /* glsl */ `
#include <common>
#include <batching_pars_vertex>
#include <logdepthbuf_pars_vertex>
uniform float uDepthScale;
uniform float uZBiasK;
varying vec2 vUv;
#ifdef LIGHTMAPPED
	attribute vec2 objLmUv;
	varying vec2 vLmUv;
#endif
#if !defined( LIGHTMAPPED ) || defined( LIT_LIGHTMAPPED )
	attribute vec3 objLight;
	varying vec3 vLight;
#endif
#ifdef FOGGED
	uniform float uFogK;
	varying float vFog;
#endif
void main() {
	#include <batching_vertex>
	vec4 mvPosition = vec4( position, 1.0 );
	#ifdef USE_BATCHING
		mvPosition = batchingMatrix * mvPosition;
	#endif
	#ifdef USE_INSTANCING
		mvPosition = instanceMatrix * mvPosition;
	#endif
	mvPosition = modelViewMatrix * mvPosition;
	gl_Position = projectionMatrix * mvPosition;
	#include <logdepthbuf_vertex>
	${DEPTH_NUDGE_VERTEX}
	vUv = uv;
	#ifdef LIGHTMAPPED
		vLmUv = objLmUv;
	#endif
	#if !defined( LIGHTMAPPED ) || defined( LIT_LIGHTMAPPED )
		vLight = objLight;
	#endif
	#ifdef FOGGED
		// D3D vertex fog, EXP, range-based (radial eye distance) [recovered + inferred range]
		vFog = exp( - uFogK * length( mvPosition.xyz ) );
	#endif
}
`;

const FRAGMENT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D map;
uniform float uMipBias;
varying vec2 vUv;
#ifdef LIGHTMAPPED
	uniform sampler2D lightMap;
	varying vec2 vLmUv;
#endif
#if !defined( LIGHTMAPPED ) || defined( LIT_LIGHTMAPPED )
	varying vec3 vLight;
#endif
#ifdef FOGGED
	uniform vec3 uFogColour;
	varying float vFog;
#endif
void main() {
	#include <logdepthbuf_fragment>
	vec4 tex = texture( map, vUv, uMipBias );
	#ifdef ALPHA_GREATER
		// D3DRS_ALPHAFUNC GREATER, ALPHAREF on the 8-bit (filtered) alpha
		if ( floor( tex.a * 255.0 + 0.5 ) <= float( ALPHA_GREATER ) ) discard;
	#endif
	#ifdef ADDITIVE
		vec3 colour = tex.rgb; // unlit, texture only
	#elif defined( LIT_LIGHTMAPPED )
		// D3D LIGHTING on + stage 0 MODULATE(TEXTURE, DIFFUSE), stage 1 lightmap [FUN_0052f780]
		vec3 colour = tex.rgb * vLight * texture( lightMap, vLmUv ).rgb;
	#elif defined( LIGHTMAPPED )
		vec3 colour = tex.rgb * texture( lightMap, vLmUv ).rgb; // MODULATE x1
	#else
		vec3 colour = tex.rgb * vLight; // MODULATE(TEXTURE, DIFFUSE)
	#endif
	#ifdef FOGGED
		colour = mix( uFogColour, colour, vFog );
	#endif
	#ifdef BLENDED
		gl_FragColor = vec4( colour, tex.a );
	#else
		gl_FragColor = vec4( colour, 1.0 );
	#endif
}
`;

/** ShaderMaterial for one object block kind (shared per texture / path; works for Mesh, InstancedMesh and BatchedMesh). */
export function createObjectMaterial(o: ObjectMaterialOptions): THREE.ShaderMaterial {
  const defines: Record<string, string | number | boolean> = {};
  const lightmapped = o.lightMap !== null && o.kind !== "additive";
  if (lightmapped) defines.LIGHTMAPPED = "";
  if (lightmapped && o.kind === "deferred" && o.litLightmap) defines.LIT_LIGHTMAPPED = "";
  if (o.kind !== "additive") defines.FOGGED = "";
  if (o.kind === "additive") defines.ADDITIVE = "";
  if (o.kind !== "opaque") {
    defines.BLENDED = "";
    defines.ALPHA_GREATER = 1;
  }
  const material = new THREE.ShaderMaterial({
    name: `igi-object-${o.kind}${lightmapped ? (defines.LIT_LIGHTMAPPED !== undefined ? "-lm-lit" : "-lm") : "-vl"}`,
    defines,
    uniforms: {
      map: { value: o.map ?? whiteTexture() },
      lightMap: { value: lightmapped ? o.lightMap : null },
      uMipBias: o.mipBias,
      uFogColour: o.fog.objectFogColour,
      uFogK: o.fog.objectFogK,
      uDepthScale: { value: 1 },
      uZBiasK: { value: OBJECT_ZBIAS_PER_METRE },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: THREE.FrontSide, // D3DCULL_CCW on D3D clockwise fronts (mef.ts flips winding)
    fog: false, // fog computed here from the shared uniforms
    depthTest: true,
    depthWrite: o.kind === "opaque",
    depthFunc: THREE.LessEqualDepth,
    transparent: o.kind !== "opaque",
    polygonOffset: true,
    polygonOffsetFactor: 0,
    polygonOffsetUnits: -3,
  });
  if (o.kind === "deferred") {
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.SrcAlphaFactor;
    material.blendDst = THREE.OneMinusSrcAlphaFactor;
  } else if (o.kind === "additive") {
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.OneFactor;
    material.blendDst = THREE.OneFactor;
  }
  return material;
}

/**
 * Decal / blob-shadow material (PolyListDynCubeObj, flags 0): texture x vertex
 * colour, SRCALPHA/INVSRCALPHA, alpha test GREATER 0, Z test without write,
 * cull CW (D3D) = the quad is visible from its normal side, object fog, near
 * plane x 1.01 [recovered FUN_00498840/FUN_00498940/FUN_00498c10].
 * Works with InstancedMesh (instanceColor = vertex colour).
 */
export function createDecalMaterial(map: THREE.Texture, fog: FogUniforms, mipBias: THREE.IUniform<number>): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    name: "igi-decal",
    defines: { FOGGED: "" },
    uniforms: {
      map: { value: map },
      uMipBias: mipBias,
      uFogColour: fog.objectFogColour,
      uFogK: fog.objectFogK,
      uDepthScale: { value: DECAL_DEPTH_SCALE },
      uZBiasK: { value: 0 },
    },
    vertexShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uDepthScale;
uniform float uZBiasK;
uniform float uFogK;
varying vec2 vUv;
varying vec3 vTint;
varying float vFog;
void main() {
	vec4 mvPosition = vec4( position, 1.0 );
	#ifdef USE_INSTANCING
		mvPosition = instanceMatrix * mvPosition;
	#endif
	mvPosition = modelViewMatrix * mvPosition;
	gl_Position = projectionMatrix * mvPosition;
	#include <logdepthbuf_vertex>
	${DEPTH_NUDGE_VERTEX}
	vUv = uv;
	#ifdef USE_INSTANCING_COLOR
		vTint = instanceColor;
	#else
		vTint = vec3( 1.0 );
	#endif
	vFog = exp( - uFogK * length( mvPosition.xyz ) );
}
`,
    fragmentShader: /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D map;
uniform float uMipBias;
uniform vec3 uFogColour;
varying vec2 vUv;
varying vec3 vTint;
varying float vFog;
void main() {
	#include <logdepthbuf_fragment>
	vec4 tex = texture( map, vUv, uMipBias );
	if ( floor( tex.a * 255.0 + 0.5 ) <= 0.0 ) discard; // ALPHAREF 0, GREATER
	vec3 colour = mix( uFogColour, tex.rgb * vTint, vFog );
	gl_FragColor = vec4( colour, tex.a );
}
`,
    side: THREE.FrontSide,
    fog: false,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });
  return material;
}

/** Stage-0 sampler state for object textures: LINEAR, nearest mip level, WRAP, no anisotropy. */
export function applyObjectSampler(texture: THREE.Texture): void {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapNearestFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 1;
}
