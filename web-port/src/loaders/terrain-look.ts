/**
 * Terrain texturing and baked lighting, as igi.exe builds and draws terrain
 * cells (FUN_00509250 build, FUN_0050be70 draw). Port of tools/terrain_tex.py;
 * evidence in docs/terrain.md section "Texturing and lighting".
 *
 * Per emitted cell vertex (full detail, LOD factor 0):
 *   material  = first of the (up to 4, innermost first) TextureModifiers
 *               containing the cell whose terrain.bit mask is set at the
 *               vertex; else material 0                               [recovered]
 *   layer     = tilemap[material.levels[L].tilemapB][vtile * 8 + utile] [recovered]
 *   uv        = planar from the cell frame, or x/y-z where the vertex's
 *               projection bits 8-9 are set                            [recovered]
 *   light     = terrain.lmp record of the deepest TerrainLightMap node
 *               containing the cell, bilinear at the vertex, through the
 *               palette min(255, i * sun + 255 * ambient)              [recovered]
 * Colour = sum over the triangle's vertex materials of barycentric weight x
 * layer texel, times the light colour. No vertex lighting on terrain.
 */
import type { Vec3 } from "../contracts";
import { TERRAIN_ROOT_HALF, type TerrainCell, type TerrainCellGeometry, type TerrainOctree } from "./terrain-octree";
import { x87Add, x87Fistp, x87Mul } from "./x87";

/**
 * Everything the per-frame draw (FUN_0050be70) needs about one cell, built
 * the way FUN_00509250 builds it [recovered]:
 *  - per vertex its own material and, for an extra vertex whose morph target
 *    has another material, that material (else -1);
 *  - per material of the cell the "B" (detail) and "A" (coarse) layers;
 *  - per vertex B and A texture coordinates at its own position and at its
 *    morph target's position (same projection: the draw lerps them with the
 *    target's lod), likewise the lightmap coordinates.
 * The draw then weights, with w = 1 - lod (lod of the morph target; bytes
 * W = trunc(255 w), W2 = trunc(255 w w)):
 *   own material      B: W   A: 255 - W         (no material change)
 *   own material      B: W2  A: W - W2          (target has another material)
 *   target material   B: W - W2  A: 255 - 2W + W2
 */
export interface TerrainCellLook {
  material: Uint8Array;
  targetMaterial: Int16Array;
  /** Material -> [B layer, A layer] for this cell. */
  layers: Map<number, [number, number]>;
  /** Per vertex: B uv at the vertex, B uv at its morph target (u, v, ut, vt). */
  uvB: Float32Array;
  /** Per vertex: A uv likewise. */
  uvA: Float32Array;
  /** Index into TerrainLook.lightmaps, or -1 (no lightmap pass). */
  lightmap: number;
  /** Per vertex: lightmap uv at the vertex and at its morph target (u, v, ut, vt), 0..1 over the lightmap. */
  uvLight: Float32Array;
}

/** A TerrainLightMap record as drawn: side x side palette indices covering one octree node. */
export interface TerrainLightmapImage {
  level: number;
  side: number;
  data: Uint8Array;
}

export interface TerrainMaterialLevel {
  scaleA: number;
  tilemapA: number;
  scaleB: number;
  tilemapB: number;
}

export interface TerrainLookInput {
  /** Material id -> 32 per-level records (CreateTerrainMaterial). */
  materials: Map<number, TerrainMaterialLevel[]>;
  /** Tile map id -> 64 layer indices, index vtile * 8 + utile (CreateTerrainTileMap). */
  tilemaps: Map<number, number[]>;
  /** TextureModifier tasks in objects.qvm order. */
  modifiers: Array<{ position: Vec3; level: number; material: number; bitmapId: number }>;
  /** TerrainLightMap tasks. */
  lightmaps: Array<{ position: Vec3; level: number; textureIndex: number }>;
  /** GlobalLightKeyframe "Ambient color terrain" and Dirlight front colour (0..1). */
  ambient: Vec3;
  sun: Vec3;
}

/** Non-indexed render geometry: three vertices per triangle. */
export interface TerrainRenderMesh {
  /** xyz, IGI world units (float64; convert after subtracting an origin). */
  positions: Float64Array;
  /** Layer uv per vertex. */
  uv: Float32Array;
  /** Per vertex: the layers of the triangle's three vertex materials (same for all 3 vertices). */
  layers: Uint8Array;
  /** Lightmap value 0..255 per vertex (bilinear); NO_LIGHTMAP when the cell has none. */
  light: Float32Array;
  triangles: number;
}

interface Modifier {
  level: number;
  material: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  scale: number;
  rowBytes: number;
  mask: Uint8Array;
  order: number;
}

interface LayerFrame {
  layer: number;
  slope: number;
  off: [number, number, number];
}

interface Lightmap {
  level: number;
  x0: number;
  y0: number;
  full: number;
  side: number;
  data: Uint8Array;
}

function fail(message: string): never {
  throw new Error(`terrain look: ${message}`);
}

/** 256 x {ptr, flag, side} then side^2/8-byte masks in index order (terrain.bit). */
export function readTerrainBit(buffer: ArrayBuffer): Map<number, { side: number; mask: Uint8Array }> {
  const view = new DataView(buffer);
  if (buffer.byteLength < 0xc00) fail("terrain.bit shorter than its header");
  const out = new Map<number, { side: number; mask: Uint8Array }>();
  let p = 0xc00;
  for (let i = 0; i < 256; i++) {
    const side = view.getUint32(i * 12 + 8, true);
    if (!side) continue;
    if (side % 8 !== 0) fail(`terrain.bit entry ${i} side ${side} is not a multiple of 8`);
    const bytes = (side * side) / 8;
    if (p + bytes > buffer.byteLength) fail(`terrain.bit entry ${i} overruns the file`);
    out.set(i, { side, mask: new Uint8Array(buffer, p, bytes) });
    p += bytes;
  }
  if (p !== buffer.byteLength) fail("terrain.bit masks do not end at EOF");
  return out;
}

/** Records {u32 side, side^2 bytes} back to back (terrain.lmp). */
export function readTerrainLmp(buffer: ArrayBuffer): Array<{ side: number; data: Uint8Array }> {
  const view = new DataView(buffer);
  const out: Array<{ side: number; data: Uint8Array }> = [];
  let p = 0;
  while (p < buffer.byteLength) {
    if (p + 4 > buffer.byteLength) fail("truncated terrain.lmp record header");
    const side = view.getUint32(p, true);
    if (side < 1 || side > 4096 || p + 4 + side * side > buffer.byteLength) fail(`bad terrain.lmp record at ${p}`);
    out.push({ side, data: new Uint8Array(buffer, p + 4, side * side) });
    p += 4 + side * side;
  }
  return out;
}

const f32 = Math.fround;

/** Light value marking a cell without a lightmap: the game then skips the multiply pass. */
export const NO_LIGHTMAP = 256;

export class TerrainLook {
  private readonly mods: Modifier[] = [];
  private readonly lms = new Map<string, Lightmap>();
  private readonly lightmapLevels: number[];
  /** Palette (RGB bytes) shared by every terrain lightmap (FUN_00508d20). */
  readonly palette: Uint8Array;
  /** Every placed lightmap; TerrainCellLook.lightmap indexes this list. */
  readonly lightmaps: TerrainLightmapImage[] = [];
  private readonly lightmapIndex = new Map<Lightmap, number>();

  constructor(
    private readonly octree: TerrainOctree,
    private readonly input: TerrainLookInput,
    bit: ArrayBuffer,
    lmp: ArrayBuffer,
  ) {
    const masks = readTerrainBit(bit);
    input.modifiers.forEach((m, order) => {
      const entry = masks.get(m.bitmapId);
      if (m.bitmapId < 0 || !entry) return; // the push handler requires a bitmap
      const full = 2 * (TERRAIN_ROOT_HALF / 2 ** m.level);
      const x0 = Math.floor(m.position[0] / full) * full;
      const y0 = Math.floor(m.position[1] / full) * full;
      this.mods.push({
        level: m.level,
        material: m.material,
        x0,
        y0,
        x1: x0 + full,
        y1: y0 + full,
        scale: (entry.side - 1) / full,
        rowBytes: entry.side / 8,
        mask: entry.mask,
        order,
      });
    });
    const records = readTerrainLmp(lmp);
    const levels = new Set<number>();
    for (const t of input.lightmaps) {
      const record = records[t.textureIndex];
      if (!record) continue;
      const full = 2 * (TERRAIN_ROOT_HALF / 2 ** t.level);
      const x0 = Math.floor(t.position[0] / full) * full;
      const y0 = Math.floor(t.position[1] / full) * full;
      const lm: Lightmap = { level: t.level, x0, y0, full, side: record.side, data: record.data };
      this.lms.set(`${t.level},${x0},${y0}`, lm);
      levels.add(t.level);
    }
    for (const lm of this.lms.values()) {
      this.lightmapIndex.set(lm, this.lightmaps.length);
      this.lightmaps.push({ level: lm.level, side: lm.side, data: lm.data });
    }
    this.lightmapLevels = [...levels].sort((a, b) => b - a);
    // Palette (FUN_00508d20): min(255, fistp(sun * i + ambient * 255)) with
    // float32 sun / ambient and the float counter i; the x87 products are exact
    // and the sum chops (53-bit precision, chop mode).
    this.palette = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      for (let c = 0; c < 3; c++) {
        const v = x87Fistp(x87Add(x87Mul(f32(input.sun[c]), i), x87Mul(f32(input.ambient[c]), 255)));
        this.palette[i * 3 + c] = v >>> 0 > 255 ? 255 : v; // unsigned compare (0xff < uVar5)
      }
    }
  }

  /**
   * Active modifiers for a cell, innermost first, at most 4 (deeper level
   * first, then file order). A TextureModifier / TerrainLightMap of Level L is
   * linked into the level-L sector of the object octree (FUN_004bd570 with
   * the node's box) and its enter callback pushes it only when the traversal
   * refines that node (FUN_004c6530), so it applies to cells of levels > L;
   * a cell drawn at level L itself records its ancestors' state [recovered].
   */
  private modifierStack(cell: TerrainCell): Modifier[] {
    const active = this.mods.filter(
      (m) => m.level < cell.level && cell.cx >= m.x0 && cell.cx < m.x1 && cell.cy >= m.y0 && cell.cy < m.y1,
    );
    active.sort((a, b) => b.level - a.level || a.order - b.order);
    return active.slice(0, 4);
  }

  private static material(stack: Modifier[], x: number, y: number): number {
    for (const m of stack) {
      const ix = Math.trunc((x - m.x0) * m.scale); // x87 chop mode
      const iy = Math.trunc((y - m.y0) * m.scale);
      const k = (ix >> 3) + iy * m.rowBytes;
      if (ix >= 0 && k >= 0 && k < m.mask.length && (m.mask[k] >> (ix & 7)) & 1) return m.material;
    }
    return 0;
  }

  /** Deepest TerrainLightMap node coarser than the cell (an entered ancestor, see modifierStack) containing the cell centre. */
  private lightmapFor(cell: TerrainCell): Lightmap | null {
    for (const level of this.lightmapLevels) {
      if (level >= cell.level) continue;
      const full = 2 * (TERRAIN_ROOT_HALF / 2 ** level);
      const found = this.lms.get(`${level},${Math.floor(cell.cx / full) * full},${Math.floor(cell.cy / full) * full}`);
      if (found) return found;
    }
    return null;
  }

  private static lightValue(lm: Lightmap, x: number, y: number): number {
    // u = (x - x0)/node + 0.5/side => texel coordinate (x - x0)/node * side; bilinear, CLAMP.
    const side = lm.side;
    const tx = Math.min(Math.max(((x - lm.x0) / lm.full) * side, 0), side - 1);
    const ty = Math.min(Math.max(((y - lm.y0) / lm.full) * side, 0), side - 1);
    const x0 = Math.trunc(tx);
    const y0 = Math.trunc(ty);
    const x1 = Math.min(x0 + 1, side - 1);
    const y1 = Math.min(y0 + 1, side - 1);
    const fx = tx - x0;
    const fy = ty - y0;
    const d = lm.data;
    const a = d[y0 * side + x0] + (d[y0 * side + x1] - d[y0 * side + x0]) * fx;
    const b = d[y1 * side + x0] + (d[y1 * side + x1] - d[y1 * side + x0]) * fx;
    return a + (b - a) * fy;
  }

  /** Layer index and uv frame of material m for a cell, layer B (detail). */
  private layerB(material: number, cell: TerrainCell): LayerFrame {
    return this.layerFrame(material, cell, "B");
  }

  /**
   * Layer index and uv frame of material m for a cell (FUN_00509250
   * 0x509fea-0x50a0f0) [recovered]. CreateTerrainMaterial stores both scales
   * x 0.5 (FUN_004bc890 0x4bc8f7 / 0x4bc917), s = that float32:
   *   B (detail): k = trunc(s c) >> (22 - L), slope = s / half
   *   A (coarse): k = trunc(s c) >> (23 - L), slope = s * 0.5 / half
   * layer = tilemap[((k_y & 0x7ff) >> 8) * 8 + ((k_x & 0x7ff) >> 8)],
   * uv offset per axis ((k & 0xff) + 1) / 256. A spans two cells per repeat.
   */
  private layerFrame(material: number, cell: TerrainCell, kind: "A" | "B"): LayerFrame {
    const levels = this.input.materials.get(material) ?? this.input.materials.get(0);
    if (!levels) fail("terrain material 0 is not defined");
    const record = levels[Math.min(cell.level, levels.length - 1)];
    const s = f32((kind === "B" ? record.scaleB : record.scaleA) * 0.5);
    const shift = (kind === "B" ? 22 : 23) - cell.level;
    const k = [cell.cx, cell.cy, cell.cz].map((c) => {
      const v = x87Fistp(s * f32(c)); // float32 x float32 is exact in the x87; fistp chops
      return shift >= 0 ? v >> shift : v << -shift;
    });
    const utile = (k[0] & 0x7ff) >> 8;
    const vtile = (k[1] & 0x7ff) >> 8;
    const id = kind === "B" ? record.tilemapB : record.tilemapA;
    const tilemap = this.input.tilemaps.get(id);
    if (!tilemap) fail(`tile map ${id} is not defined`);
    const half = TERRAIN_ROOT_HALF / 2 ** cell.level;
    return {
      layer: tilemap[vtile * 8 + utile],
      slope: (kind === "B" ? s : s * 0.5) / half,
      off: [((k[0] & 0xff) + 1) / 256, ((k[1] & 0xff) + 1) / 256, ((k[2] & 0xff) + 1) / 256],
    };
  }

  /** uv of point (rx, ry, rz) relative to the cell centre in a frame, projection bits `proj` (FUN_00509250). */
  private static project(frame: LayerFrame, proj: number, t: number, rx: number, ry: number, rz: number, out: Float32Array, at: number): void {
    if (proj === 0) {
      out[at] = rx * frame.slope + frame.off[0];
      out[at + 1] = ry * frame.slope + frame.off[1];
    } else if ((proj ^ (t & 1)) & 1) {
      out[at] = ry * frame.slope + frame.off[1];
      out[at + 1] = rz * frame.slope + frame.off[2];
    } else {
      out[at] = rx * frame.slope + frame.off[0];
      out[at + 1] = rz * frame.slope + frame.off[2];
    }
  }

  /** Per-cell look for the LOD renderer (see TerrainCellLook). */
  cellLook(cell: TerrainCell, geometry: TerrainCellGeometry): TerrainCellLook {
    const { positions: p, target, words } = geometry;
    const count = target.length;
    const stack = this.modifierStack(cell);
    const material = new Uint8Array(count);
    for (let v = 0; v < count; v++) material[v] = stack.length ? TerrainLook.material(stack, p[v * 3], p[v * 3 + 1]) : 0;
    const targetMaterial = new Int16Array(count);
    const layers = new Map<number, [number, number]>();
    let frameB: LayerFrame | null = null;
    let frameA: LayerFrame | null = null;
    for (let v = 0; v < count; v++) {
      const tm = material[target[v]];
      targetMaterial[v] = tm === material[v] ? -1 : tm;
      for (const m of [material[v], tm]) {
        if (layers.has(m)) continue;
        const b = this.layerFrame(m, cell, "B");
        const a = this.layerFrame(m, cell, "A");
        // Level 1 gives every material the same scales, so one uv per vertex
        // serves all of a cell's materials; fail loudly if a level does not.
        if ((frameB && b.slope !== frameB.slope) || (frameA && a.slope !== frameA.slope)) {
          fail("materials with different scales share a cell; per-material uv needed");
        }
        frameB ??= b;
        frameA ??= a;
        layers.set(m, [b.layer, a.layer]);
      }
    }
    const uvB = new Float32Array(count * 4);
    const uvA = new Float32Array(count * 4);
    const uvLight = new Float32Array(count * 4);
    const lm = this.lightmapFor(cell);
    for (let v = 0; v < count; v++) {
      const projB = (words[v] >>> 8) & 3;
      const projA = (words[v] >>> 6) & 3;
      for (const [k, at] of [
        [v, 0],
        [target[v], 2],
      ] as const) {
        const rx = p[k * 3] - cell.cx;
        const ry = p[k * 3 + 1] - cell.cy;
        const rz = p[k * 3 + 2] - cell.cz;
        TerrainLook.project(frameB!, projB, cell.t, rx, ry, rz, uvB, v * 4 + at);
        TerrainLook.project(frameA!, projA, cell.t, rx, ry, rz, uvA, v * 4 + at);
        if (lm) {
          // u = (x - node min) / node size + 0.5 / side (FUN_004efac0 / FUN_00509250).
          uvLight[v * 4 + at] = (p[k * 3] - lm.x0) / lm.full + 0.5 / lm.side;
          uvLight[v * 4 + at + 1] = (p[k * 3 + 1] - lm.y0) / lm.full + 0.5 / lm.side;
        }
      }
    }
    return { material, targetMaterial, layers, uvB, uvA, lightmap: lm ? this.lightmapIndex.get(lm)! : -1, uvLight };
  }

  /** Build non-indexed, textured render geometry for the given cells. */
  buildRenderMesh(cells: Iterable<TerrainCell>): TerrainRenderMesh {
    const positions: number[] = [];
    const uv: number[] = [];
    const layers: number[] = [];
    const light: number[] = [];
    for (const cell of cells) {
      const mesh = this.octree.cellMesh(cell);
      const words = this.octree.cellVertexWords(cell.node);
      const count = mesh.positions.length / 3;
      const stack = this.modifierStack(cell);
      const lm = this.lightmapFor(cell);
      const mats = new Array<number>(count);
      const vuv = new Float32Array(count * 2);
      const vlight = new Float32Array(count);
      const frames = new Map<number, ReturnType<TerrainLook["layerB"]>>();
      for (let v = 0; v < count; v++) {
        const x = mesh.positions[v * 3];
        const y = mesh.positions[v * 3 + 1];
        const z = mesh.positions[v * 3 + 2];
        const m = stack.length ? TerrainLook.material(stack, x, y) : 0;
        mats[v] = m;
        let frame = frames.get(m);
        if (!frame) {
          frame = this.layerB(m, cell);
          frames.set(m, frame);
        }
        const rx = x - cell.cx;
        const ry = y - cell.cy;
        const rz = z - cell.cz;
        const proj = (words[v] >>> 8) & 3;
        if (proj === 0) {
          vuv[v * 2] = rx * frame.slope + frame.off[0];
          vuv[v * 2 + 1] = ry * frame.slope + frame.off[1];
        } else if ((proj ^ (cell.t & 1)) & 1) {
          vuv[v * 2] = ry * frame.slope + frame.off[1];
          vuv[v * 2 + 1] = rz * frame.slope + frame.off[2];
        } else {
          vuv[v * 2] = rx * frame.slope + frame.off[0];
          vuv[v * 2 + 1] = rz * frame.slope + frame.off[2];
        }
        vlight[v] = lm ? TerrainLook.lightValue(lm, x, y) : NO_LIGHTMAP;
      }
      // Every material in level 1 uses the same scale, so one uv per vertex is
      // exact; fail loudly if a level ever mixes scales within a cell.
      if (frames.size > 1) {
        const slopes = new Set([...frames.values()].map((f) => f.slope));
        if (slopes.size > 1) fail("materials with different scales share a cell; per-material uv needed");
      }
      const t = mesh.triangles;
      for (let k = 0; k < t.length; k += 3) {
        const tri = [t[k], t[k + 1], t[k + 2]];
        const triLayers = tri.map((v) => frames.get(mats[v])!.layer);
        for (const v of tri) {
          positions.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
          uv.push(vuv[v * 2], vuv[v * 2 + 1]);
          layers.push(triLayers[0], triLayers[1], triLayers[2]);
          light.push(vlight[v]);
        }
      }
    }
    return {
      positions: Float64Array.from(positions),
      uv: Float32Array.from(uv),
      layers: Uint8Array.from(layers),
      light: Float32Array.from(light),
      triangles: positions.length / 9,
    };
  }
}
