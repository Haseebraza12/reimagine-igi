/**
 * `.lmp` terrain lightmap reader (missions/.../terrain/terrain.lmp).
 *
 * The community research docs do not cover `.lmp`. The layout below was
 * MEASURED from `public/raw/missions/location0/level1/terrain/terrain.lmp`
 * (461 360 bytes) and cross-validated against the 268 `TerrainLightMap`
 * entries in Research/QSC/level1/objects.qsc (confidence: observed):
 *
 *   The file is a flat ARRAY OF TEXTURES, one per engine "TextureIndex":
 *
 *     repeat until EOF:
 *       u32 size          (power of two, 16..128 observed)
 *       size*size bytes   (uint8 intensities, size x size texels)
 *
 *   The greedy parse consumes the measured file EXACTLY (268 records:
 *   138x16 + 79x32 + 40x64 + 11x128), and record i's `size` matches the
 *   TerrainLightMap entry whose TextureIndex is i for all 268 entries (0
 *   mismatches). Sizes are in terrain CELLS: the measured terrain is 128x128
 *   cells (see hmp.ts), so a size-128 record is a whole-terrain lightmap at
 *   one texel per cell; smaller records are adaptive local patches.
 *
 * Tile PLACEMENT (world position + LOD level) lives in objects.qsc, NOT in
 * the .lmp; therefore a single flat grid cannot be reconstructed from the
 * .lmp alone. The frozen `readLmp` API returns one size*size grid, so —
 * INFERRED policy — it returns the FIRST MAX-SIZED tile. In the measured
 * corpus that is TextureIndex 38, the only size-128 tile at the coarsest QSC
 * LOD (level 4), i.e. the canonical whole-terrain coarse lightmap. Callers
 * needing patch placement must use the mission QSC data.
 */
function fail(message: string): never {
  throw new Error(`LMP: ${message}`);
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

/**
 * Parse a `.lmp` lightmap tile array.
 *
 * @returns the first maximum-size tile: `size` (texels per side) and
 *          `intensities` (size*size uint8 bytes, row-major).
 * @throws Error when the record stream is malformed or does not consume the
 *         file exactly.
 */
export function readLmp(buffer: ArrayBuffer): { size: number; intensities: Uint8Array } {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  if (buffer.byteLength < 8) {
    fail(`buffer too small (${buffer.byteLength} bytes)`);
  }

  let offset = 0;
  let recordCount = 0;
  let best: { size: number; offset: number } | null = null;
  while (offset < buffer.byteLength) {
    if (offset + 4 > buffer.byteLength) {
      fail(`truncated tile size field at 0x${offset.toString(16)}`);
    }
    const size = view.getUint32(offset, true);
    const headerOffset = offset;
    offset += 4;
    if (!isPowerOfTwo(size) || size > 4096) {
      fail(`implausible tile size ${size} at 0x${headerOffset.toString(16)}`);
    }
    const byteCount = size * size;
    if (offset + byteCount > buffer.byteLength) {
      fail(`tile of ${size}x${size} overruns file at 0x${headerOffset.toString(16)}`);
    }
    if (best === null || size > best.size) {
      best = { size, offset };
    }
    offset += byteCount;
    recordCount++;
  }
  if (offset !== buffer.byteLength) {
    fail("tile stream does not end exactly at EOF");
  }
  if (recordCount === 0 || best === null) {
    fail("no tiles found");
  }

  const intensities = bytes.slice(best.offset, best.offset + best.size * best.size);
  return { size: best.size, intensities };
}
