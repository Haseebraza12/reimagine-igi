/**
 * Per-instance model LOD choice (docs/rendering.md section 6; recovered
 * FUN_004c4d00, FUN_004e4620, FUN_004e46e0, FUN_00405e50):
 *   z = view depth of the bounding-sphere centre x detail (1.0 at
 *       GOGfxPerformance 0), r = model radius x max(scale),
 *   t = tan(horizontal half-FOV) of the current camera (zoom refines LOD).
 *   - explicit lod.qvm distances: selectLodExplicit (culled beyond "cutoff");
 *   - otherwise the LODSettings relative rule for the model kind
 *     (rigid / spline / bone): selectLodRelative (culled past the cutoff once
 *     the last variant is reached).
 * Returns the variant index or -1 (not drawn).
 */
import { selectLodExplicit, selectLodRelative, type LodSettings } from "../../loaders";
import type { LodKind } from "./model-lods";

export interface InstanceLodInput {
  kind: LodKind;
  /** Triangles per variant (variant 0 = the placed model). */
  faces: number[];
  radiusM: number;
  explicit: number[] | null;
}

/** tan(horizontal half-FOV) of a Three.js perspective camera (vertical fov in degrees, aspect = width/height). */
export function tanHalfFovX(fovYDeg: number, aspect: number): number {
  return Math.tan((fovYDeg * Math.PI) / 360) * aspect;
}

export function chooseLod(input: InstanceLodInput, depthM: number, tanX: number, settings: LodSettings | null, detail = 1): number {
  const count = input.faces.length;
  if (count === 0) return -1;
  if (input.explicit) {
    const i = selectLodExplicit(depthM, input.radiusM, input.explicit, count, tanX, detail);
    return i < 0 ? -1 : Math.min(i, count - 1);
  }
  if (!settings) return 0;
  const first = settings.firstSwitch[input.kind];
  const cutoff = settings.cutoff[input.kind];
  const i = selectLodRelative(depthM, input.radiusM, input.faces, first, cutoff, settings.radiusWeight, settings.idealRadiusM, tanX, detail);
  return i < 0 ? -1 : Math.min(i, count - 1);
}
