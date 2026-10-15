/**
 * Fog as igi.exe draws it (docs/rendering.md section 3, recovered
 * FUN_00521280, FUN_0050be70, FUN_0052daf0..FUN_0052e460, FUN_00498940):
 *
 *   - Mode EXP: f = exp(-k d), k = keyframe "Fog density" x 0.002048 per
 *     metre (render-params fogDensityPerMetre); colour = mix(fog, surface, f).
 *   - Terrain: f per VERTEX from VIEW DEPTH, "terrain" category colour and
 *     density; three passes give (f*layers + (1-f)*fog) * (f*lightmap + 1-f)
 *     (terrain-render.ts). The exe stores f as the byte trunc(255 f) in the
 *     specular alpha (FUN_0050be70 0x50c63d) and the fog colour as bytes
 *     trunc(255 c) of the clamped colour (0x50bf43); the density is clamped
 *     to [0, 16384] x 0.0005 (FUN_00508f60) [recovered]. terrain-render.ts
 *     applies both quantisations to these shared values.
 *   - Objects, decals, blob shadows: D3D vertex fog EXP with "object
 *     category 1" colour/density and RANGE fog (radial eye distance;
 *     RANGEFOGENABLE stays TRUE after the terrain sets it [inferred]).
 *   - Not fogged: sky dome, cloud layers, additive (ONE/ONE) blocks.
 *
 * The level's light state is the earliest GlobalLightKeyframe (time of day is
 * 0 and never advances, so level 1 uses its Time-12 keyframe) [recovered].
 *
 * Built-in Three.js materials (characters and anything else other modules
 * create) are fogged through scene.fog = FogExp2(object colour, k) with the
 * FOG_EXP2 shader chunks patched once to the recovered EXP/range form:
 * f = exp(-density * |eye - vertex|) instead of Three's exp(-(density*depth)^2).
 * Our own ShaderMaterials compute fog themselves from the shared uniforms.
 */
import * as THREE from "three";
import type { IgiLevel, Rgb } from "../../loaders";
import { readGlobalLight } from "../../loaders";

export interface FogCategory {
  /** Device (gamma-space) colour, used as stored (colour management is off). */
  colour: THREE.Color;
  /** k of f = exp(-k d), per metre. */
  perMetre: number;
}

export interface FogParams {
  terrain: FogCategory;
  objects: FogCategory;
}

/** Shared uniform objects: every fogged material references these, so one assignment updates all. */
export interface FogUniforms {
  terrainFogColour: THREE.IUniform<THREE.Color>;
  terrainFogK: THREE.IUniform<number>;
  objectFogColour: THREE.IUniform<THREE.Color>;
  objectFogK: THREE.IUniform<number>;
}

const colour = (c: Rgb) => new THREE.Color().setRGB(c[0], c[1], c[2]);

/** Fog of the level's light keyframes at time of day 0 (earliest keyframe), or no fog when the level has none. */
export function readFogParams(level: Pick<IgiLevel, "tasks">): FogParams {
  const light = readGlobalLight(level.tasks, 0);
  if (!light) {
    return { terrain: { colour: new THREE.Color(0, 0, 0), perMetre: 0 }, objects: { colour: new THREE.Color(0, 0, 0), perMetre: 0 } };
  }
  return {
    terrain: { colour: colour(light.terrain.fogColour), perMetre: light.terrain.fogPerMetre },
    // Object fog colour is not clamped by igi.exe (only the terrain one is,
    // FUN_00508f60); D3DCOLOR conversion saturates it anyway.
    objects: {
      colour: colour(light.objects.fogColour.map((v) => Math.min(1, Math.max(0, v))) as Rgb),
      perMetre: light.objects.fogPerMetre,
    },
  };
}

export function createFogUniforms(params: FogParams): FogUniforms {
  return {
    terrainFogColour: { value: params.terrain.colour.clone() },
    terrainFogK: { value: params.terrain.perMetre },
    objectFogColour: { value: params.objects.colour.clone() },
    objectFogK: { value: params.objects.perMetre },
  };
}

/** Process-wide fallback uniforms (no fog) for materials created before a level is loaded. */
export const NO_FOG: FogUniforms = createFogUniforms({
  terrain: { colour: new THREE.Color(0, 0, 0), perMetre: 0 },
  objects: { colour: new THREE.Color(0, 0, 0), perMetre: 0 },
});

let activeFog: FogUniforms = NO_FOG;
/** The level's fog uniforms (set by the environment), shared by effects created at any time. */
export function sharedFogUniforms(): FogUniforms {
  return activeFog;
}
export function setSharedFogUniforms(fog: FogUniforms): void {
  activeFog = fog;
}

/** Fraction of the surface colour kept (1 = unfogged), the recovered EXP formula. */
export function expFog(perMetre: number, distanceM: number): number {
  return Math.exp(-perMetre * distanceM);
}

/** igi.exe's terrain colour per channel (three fogged passes); f = expFog(k, view depth). */
export function terrainPassesColour(layers: number, lightmap: number, fog: number, f: number): number {
  return (f * layers + (1 - f) * fog) * (f * lightmap + 1 - f);
}

let chunksPatched = false;
/**
 * Patch Three's FOG_EXP2 chunks so built-in materials use the recovered
 * object fog: f = exp(-density * radial distance) (D3DFOG_EXP + range fog).
 * Idempotent; affects programs compiled afterwards (call before first render).
 */
export function installObjectFogChunks(): void {
  if (chunksPatched) return;
  chunksPatched = true;
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  chunks.fog_vertex = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = length( mvPosition.xyz ); // range fog (radial eye distance) [igi.exe objects]
#endif
`;
  chunks.fog_fragment = /* glsl */ `
#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * vFogDepth ); // D3DFOG_EXP [recovered]
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif
`;
}

/** scene.fog for built-in materials (with installObjectFogChunks): object category 1. */
export function objectSceneFog(params: FogParams): THREE.FogExp2 {
  return new THREE.FogExp2(params.objects.colour.clone(), params.objects.perMetre);
}
