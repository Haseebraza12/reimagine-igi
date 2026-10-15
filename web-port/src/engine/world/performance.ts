/**
 * The Graphics menu's performance flags as igi.exe applies them at level load
 * (FUN_00405e50, docs/rendering.md section 6, docs/terrain.md) [recovered]:
 *   0x10 / 0x20  terrain LOD threshold 0x60 / 0x81, else 0xa3 (FUN_004c80f0 -> 0x5460d8);
 *   0x80 / 0x40  model LOD depth scale 2.0 / 1.5, else 1.0 (FUN_004c5f30 -> 0x545ffc,
 *                read by FUN_004c4d00 only: placed models, not the soldiers' bone models).
 * Bits 1 / 2 go to a device callback and bits 4 / 8 clear two capability
 * switches (0x5c4b28, 0x5c4b24); what those draw was not identified, so the
 * port leaves them out.
 */
import { TERRAIN_LOD_BASE } from "../../loaders/terrain-octree";

export const renderDetail = {
  /** Terrain LOD threshold base T (0xa3 at GOGfxPerformance(0)). */
  terrainLodBase: TERRAIN_LOD_BASE,
  /** Model LOD depth scale (1.0 at GOGfxPerformance(0)). */
  modelLodScale: 1,
  /** The flags last applied. */
  flags: 0,
};

/** FUN_00405e50: apply GOGfxPerformance flags (call at level load, as the exe does). */
export function applyPerformanceFlags(flags: number): void {
  const f = flags >>> 0;
  renderDetail.flags = f;
  renderDetail.terrainLodBase = f & 0x10 ? 0x60 : f & 0x20 ? 0x81 : 0xa3;
  renderDetail.modelLodScale = f & 0x80 ? 2 : f & 0x40 ? 1.5 : 1;
}
