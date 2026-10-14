/**
 * Terrain height sampling and collision helpers.
 *
 * Confidence: the heightfield *data* is recovered (see loaders/hmp.ts); the
 * choice of bilinear sampling and the walk-collision model are inferred
 * implementation decisions pending validation against the original (docs/
 * roadmap Phase 3). The vertex->world mapping matches the pipeline manifest:
 *   world(x,z) = worldOffset + (gx*cellSize, heights[gz*size+gx], gz*cellSize).
 */
import type { TerrainData, Vec3 } from "../contracts";

/** Bilinear terrain field over a recovered heightfield grid. */
export class TerrainField {
  readonly size: number;
  readonly cellSize: number;
  readonly offsetX: number;
  readonly offsetZ: number;
  private readonly heights: Float32Array;

  constructor(terrain: TerrainData, worldOffset: Vec3 = [0, 0, 0]) {
    this.size = terrain.size;
    this.cellSize = terrain.cellSize;
    this.offsetX = worldOffset[0];
    this.offsetZ = worldOffset[2];
    this.heights = terrain.heights;
  }

  /** Clamp a grid coordinate to a valid vertex index. */
  private clampIndex(i: number): number {
    return i < 0 ? 0 : i > this.size - 1 ? this.size - 1 : i;
  }

  /**
   * Terrain surface height (world Y) at world (x, z) via bilinear interpolation.
   * Outside the grid the nearest-edge height is returned (clamped), so the
   * player can walk to the border without falling through.
   */
  heightAt(x: number, z: number): number {
    const fx = (x - this.offsetX) / this.cellSize;
    const fz = (z - this.offsetZ) / this.cellSize;
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const tz = fz - z0;

    const ix0 = this.clampIndex(x0);
    const iz0 = this.clampIndex(z0);
    const ix1 = this.clampIndex(x0 + 1);
    const iz1 = this.clampIndex(z0 + 1);

    const h00 = this.heights[iz0 * this.size + ix0];
    const h10 = this.heights[iz0 * this.size + ix1];
    const h01 = this.heights[iz1 * this.size + ix0];
    const h11 = this.heights[iz1 * this.size + ix1];

    const top = h00 + (h10 - h00) * tx;
    const bottom = h01 + (h11 - h01) * tx;
    return top + (bottom - top) * tz;
  }

  /** Approximate surface normal at (x, z) from central differences. */
  normalAt(x: number, z: number): Vec3 {
    const e = this.cellSize;
    const hl = this.heightAt(x - e, z);
    const hr = this.heightAt(x + e, z);
    const hd = this.heightAt(x, z - e);
    const hu = this.heightAt(x, z + e);
    const nx = hl - hr;
    const nz = hd - hu;
    const ny = 2 * e;
    const len = Math.hypot(nx, ny, nz) || 1;
    return [nx / len, ny / len, nz / len];
  }

  /**
   * Resolve a horizontal move against the terrain: returns the ground height
   * the entity should stand on. A simple step-up limit rejects moves onto walls
   * steeper than `maxSlopeCos` (dot of normal with up) so the player cannot
   * climb cliffs. `currentY` is the entity's present foot height.
   */
  groundHeightAfterMove(x: number, z: number, currentY: number, maxStep = 1.2): number {
    const h = this.heightAt(x, z);
    if (h - currentY > maxStep) {
      // Too steep to step onto: stay at current height (blocked by wall logic).
      return currentY;
    }
    return h;
  }
}
