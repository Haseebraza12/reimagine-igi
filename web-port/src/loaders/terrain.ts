/**
 * `loadTerrain` — assemble runtime `TerrainData` from a level manifest spec.
 *
 * Precedence per docs/loader-api.md:
 *   1. `spec.heightsBin` via `assetsSource` (pipeline-emitted little-endian
 *      Float32 LE grid, size*size, already in world units — used as-is).
 *   2. `spec.hmp` via `rawSource` (original binary; `readHmp` normalises to
 *      0..1 and the loader then applies `spec.heightScale`).
 *
 * Lightmap (optional): `spec.lightmapBin` via `assetsSource` (uint8
 * size*size, expanded to 0..1), else `spec.lmp` via `rawSource`. The raw
 * .lmp is an adaptive tile array whose whole-terrain tile is 128x128 while
 * the heightfield is 129x129 (measured; see lmp.ts), so raw tiles are
 * resampled to the height grid by nearest neighbour.
 *
 * `spec.worldOffset` is intentionally not baked into `TerrainData` (the
 * contract has no field for it); the engine reads it from the manifest.
 */
import type { IAssetSource, LevelManifest, TerrainData } from "../contracts";
import { readHmp } from "./hmp";
import { readLmp } from "./lmp";

/** size*size little-endian Float32 grid -> Float32Array (LE is the contract). */
function readFloat32Grid(buffer: ArrayBuffer, what: string): { size: number; heights: Float32Array } {
  if (buffer.byteLength % 4 !== 0) {
    throw new Error(`terrain: ${what} length ${buffer.byteLength} is not a multiple of 4`);
  }
  const count = buffer.byteLength / 4;
  const size = Math.sqrt(count);
  if (!Number.isInteger(size) || size < 2) {
    throw new Error(`terrain: ${what} has ${count} floats, not a square grid`);
  }
  return { size, heights: new Float32Array(buffer) };
}

/** uint8 size*size grid -> Float32Array expanded to 0..1. */
function readUint8Lightmap(buffer: ArrayBuffer, size: number, what: string): Float32Array {
  if (buffer.byteLength !== size * size) {
    throw new Error(
      `terrain: ${what} has ${buffer.byteLength} bytes, expected ${size * size} (size ${size})`,
    );
  }
  const src = new Uint8Array(buffer);
  const out = new Float32Array(size * size);
  for (let i = 0; i < out.length; i++) out[i] = src[i] / 255;
  return out;
}

/**
 * Load terrain for the level described by `spec`.
 *
 * Order: heightsBin via `assetsSource` -> raw hmp via `rawSource`.
 * heightsBin values are already scaled to world units (used as-is);
 * raw .hmp values are normalised by readHmp and scaled by `heightScale`.
 * Attaches a lightmap when available (lightmapBin uint8 grid, or raw .lmp
 * resampled to the height grid). Throws on malformed inputs.
 */
export async function loadTerrain(
  rawSource: IAssetSource,
  assetsSource: IAssetSource,
  spec: LevelManifest["terrain"],
): Promise<TerrainData> {
  let size: number;
  let heights: Float32Array;

  if (spec.heightsBin && (await assetsSource.exists(spec.heightsBin))) {
    const decoded = readFloat32Grid(
      await assetsSource.readBinary(spec.heightsBin),
      `heightsBin "${spec.heightsBin}"`,
    );
    size = decoded.size;
    heights = decoded.heights; // Already world units: use as-is.
  } else {
    // Raw .hmp: normalised 0..1 by readHmp; apply the manifest's scale.
    const hmp = readHmp(await rawSource.readBinary(spec.hmp));
    size = hmp.size;
    heights = new Float32Array(hmp.heights.length);
    for (let i = 0; i < heights.length; i++) {
      heights[i] = hmp.heights[i] * spec.heightScale;
    }
  }

  const terrain: TerrainData = { size, cellSize: spec.cellSize, heights };

  if (spec.lightmapBin && (await assetsSource.exists(spec.lightmapBin))) {
    terrain.lightmap = readUint8Lightmap(
      await assetsSource.readBinary(spec.lightmapBin),
      size,
      `lightmapBin "${spec.lightmapBin}"`,
    );
  } else if (spec.lmp && (await rawSource.exists(spec.lmp))) {
    const lmp = readLmp(await rawSource.readBinary(spec.lmp));
    // Resample the (possibly smaller) whole-terrain tile onto the height
    // grid by nearest neighbour; documented best-effort in lmp.ts.
    const lightmap = new Float32Array(size * size);
    for (let z = 0; z < size; z++) {
      const sz = Math.min(lmp.size - 1, Math.floor((z * lmp.size) / size));
      for (let x = 0; x < size; x++) {
        const sx = Math.min(lmp.size - 1, Math.floor((x * lmp.size) / size));
        lightmap[z * size + x] = lmp.intensities[sz * lmp.size + sx] / 255;
      }
    }
    terrain.lightmap = lightmap;
  }

  return terrain;
}
