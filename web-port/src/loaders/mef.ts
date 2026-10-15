/**
 * `.mef` model decoder (nested ILFF, form id "OCEM").
 *
 * Every model in the level-1 and location0 model archives (601 files) uses
 * the chunk order HSEM ATTA XTVM TROP XVTP CFTP D3DR DNER XTRV
 * [PMTL] [HSMC XTVC ECFC TAMC HPSC XTVC ECFC TAMC HPSC].
 *
 * Measured layouts (confidence: observed unless noted):
 *
 *   HSEM  u32 at +32 = model type: 0 rigid, 1 bone (skinned), 3 lightmapped
 *   D3DR  type 0/1: u32 _, faces, blocks, ...; type 3: u32 _, lightmaps,
 *         faces, blocks, vertices. Face/block counts are cross-checked below.
 *   XTRV  type 0: 32-byte vertex  pos.xyz normal.xyz uv
 *         type 1/3: 40-byte vertex pos.xyz normal.xyz uv uv2
 *         (type 3 uv2 = lightmap coordinates; type 1 uv2 = packed bone data).
 *         The community MEF_REFERENCE.md claims type-3 UVs start at byte 12;
 *         the data contradicts it: bytes 12-23 are unit-length normals.
 *   DNER  linked render blocks, one per material:
 *         f32 x3 (block centre), then int16 fields
 *           type 0/1: indexCount, next, slot, vertexOffset, vertexCount, 3 x _
 *           type 3:   indexCount, next, slot, _, vertexOffset, vertexCount, 4 x _
 *         followed by indexCount u16 block-local indices.
 *         `slot` indexes the model's texture list in the level .mtp.
 *         Render flags read by igi.exe (docs/rendering.md section 5,
 *         recovered FUN_0052f2c0 / FUN_004ad570): the s16 at block +0x16
 *         (type 0/1) / +0x18 (type 3) non-zero = deferred (drawn after the
 *         opaque pass, depth-sorted, alpha blended); bit 0 of the byte at
 *         +0x18 (type 0/1) / +0x1c (type 3) = additive (ONE/ONE, unlit,
 *         unfogged); the byte at +0x1b / +0x1f feeds TEXTUREFACTOR alpha
 *         (no stage reads it; open question).
 *   ATTA  68-byte records: char[16] sub-model, f32 x3 offset, f32 x9 matrix,
 *         i32 bone. The matrix is applied as a row vector (v' = v * M):
 *         with that reading attached furniture sits inside its host rooms
 *         with zero wall penetrations, versus 40 per desk the other way
 *         (confidence: recovered, docs/formats.md "Models").
 *   PMTL  8-byte records {u16 w, u16 h, 0, 0}: the size of each baked .olm
 *         lightmap (equals the .olm size for all 1,308 level-1 files)
 *   HSMC  two 32-byte headers {faces, vertices, materials, spheres, 4 x 0};
 *         each count equals the matching XTVC/ECFC/TAMC/HPSC chunk (492/492).
 *   XTVC  16-byte vertices f32 xyz + u32; ECFC 8-byte faces u16 a,b,c + u16.
 *
 * Winding: 79% of triangles (92% of type-3 triangles) are clockwise with
 * respect to their stored normals, i.e. Direct3D front faces. Indices are
 * emitted as (a, c, b) so WebGL's counter-clockwise rule matches.
 *
 * Coordinates stay in IGI model space: 4096 units = 1 metre, z up,
 * right-handed (see docs/formats.md "Coordinate system").
 */

export interface MefAttachment {
  /** Sub-model name, e.g. "435_02_1". */
  name: string;
  /** Offset in the parent's model space (IGI units). */
  position: [number, number, number];
  /** Row-major 3x3 matrix applied as v' = v * M. */
  matrix: number[];
  bone: number;
}

export interface MefGroup {
  /** First index in `indices`. */
  start: number;
  /** Index count (multiple of 3). */
  count: number;
  /** Index into the model's texture list (.mtp). */
  materialSlot: number;
  /** Raw s16 at DNER block +0x16 (type 0/1) / +0x18 (type 3): non-zero = deferred alpha-blended block [recovered]. */
  deferredFlag: number;
  /** Raw byte at +0x18 (type 0/1) / +0x1c (type 3): bit 0 = additive ONE/ONE block [recovered]. */
  blendFlags: number;
  /** Raw byte at +0x1b (type 0/1) / +0x1f (type 3): TEXTUREFACTOR = (255 - byte) << 24, unused by any stage [recovered value, use open]. */
  textureFactorByte: number;
}

export interface MefCollisionMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export interface MefModel {
  modelType: 0 | 1 | 3;
  /** xyz per vertex in IGI units. */
  positions: Float32Array;
  normals: Float32Array;
  uv: Float32Array;
  /** Lightmap coordinates (type 3 only). */
  lightmapUv: Float32Array | null;
  /** Counter-clockwise triangle indices. */
  indices: Uint32Array;
  groups: MefGroup[];
  attachments: MefAttachment[];
  /** Up to two collision meshes (HSMC); empty when the model has none. */
  collision: MefCollisionMesh[];
  /** PMTL lightmap sizes [w, h] (type 3 models with baked lighting). */
  lightmapSizes: Array<[number, number]>;
  min: [number, number, number];
  max: [number, number, number];
}

interface Chunk {
  tag: string;
  offset: number;
  size: number;
}

function fail(message: string): never {
  throw new Error(`MEF: ${message}`);
}

function alignUp(value: number, alignment: number): number {
  if (alignment < 1 || alignment > 4096 || (alignment & (alignment - 1)) !== 0) {
    fail(`unsupported alignment ${alignment}`);
  }
  return Math.ceil(value / alignment) * alignment;
}

function readChunks(bytes: Uint8Array, view: DataView): Chunk[] {
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (bytes.length < 20 || tag(0) !== "ILFF" || tag(16) !== "OCEM") fail("expected ILFF/OCEM model");
  if (view.getUint32(4, true) !== bytes.length) fail("root size does not match file length");
  const chunks: Chunk[] = [];
  let pos = alignUp(20, view.getUint32(8, true));
  while (pos < bytes.length) {
    if (pos + 16 > bytes.length) fail(`truncated chunk header at 0x${pos.toString(16)}`);
    const size = view.getUint32(pos + 4, true);
    const offset = alignUp(pos + 16, view.getUint32(pos + 8, true));
    const delta = view.getUint32(pos + 12, true);
    if (offset + size > bytes.length) fail(`chunk ${tag(pos)} outside file at 0x${pos.toString(16)}`);
    chunks.push({ tag: tag(pos), offset, size });
    if (delta === 0) {
      if (offset + size !== bytes.length) fail(`unexplained bytes after final chunk ${tag(pos)}`);
      return chunks;
    }
    if (pos + delta < offset + size) fail(`chunk ${tag(pos)} overlaps its successor`);
    pos += delta;
  }
  fail("chunk chain does not terminate");
}

export function readMef(buffer: ArrayBuffer): MefModel {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const chunks = readChunks(bytes, view);
  const all = (tag: string) => chunks.filter((c) => c.tag === tag);
  const one = (tag: string) => {
    const found = all(tag);
    if (found.length !== 1) fail(`expected exactly one ${tag} chunk, found ${found.length}`);
    return found[0];
  };

  const hsem = one("HSEM");
  if (hsem.size < 36) fail("HSEM too short");
  const modelType = view.getUint32(hsem.offset + 32, true);
  if (modelType !== 0 && modelType !== 1 && modelType !== 3) fail(`unknown model type ${modelType}`);

  const d3dr = one("D3DR");
  const d3drU32 = (i: number) => view.getUint32(d3dr.offset + i * 4, true);
  const faceCount = modelType === 3 ? d3drU32(2) : d3drU32(1);
  const blockCount = modelType === 3 ? d3drU32(3) : d3drU32(2);

  // --- vertices -----------------------------------------------------------
  const xtrv = one("XTRV");
  const stride = modelType === 0 ? 32 : 40;
  if (xtrv.size % stride !== 0) fail(`XTRV size ${xtrv.size} not a multiple of ${stride}`);
  const vertexCount = xtrv.size / stride;
  if (modelType === 3 && d3drU32(4) !== vertexCount) fail("D3DR vertex count disagrees with XTRV");
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const lightmapUv = modelType === 3 ? new Float32Array(vertexCount * 2) : null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < vertexCount; v++) {
    const at = xtrv.offset + v * stride;
    for (let k = 0; k < 3; k++) {
      const p = view.getFloat32(at + k * 4, true);
      positions[v * 3 + k] = p;
      normals[v * 3 + k] = view.getFloat32(at + 12 + k * 4, true);
      if (p < min[k]) min[k] = p;
      if (p > max[k]) max[k] = p;
    }
    uv[v * 2] = view.getFloat32(at + 24, true);
    uv[v * 2 + 1] = view.getFloat32(at + 28, true);
    if (lightmapUv) {
      lightmapUv[v * 2] = view.getFloat32(at + 32, true);
      lightmapUv[v * 2 + 1] = view.getFloat32(at + 36, true);
    }
  }
  if (!positions.every(Number.isFinite)) fail("non-finite vertex position");

  // --- render blocks ------------------------------------------------------
  const dner = one("DNER");
  const header = modelType === 3 ? 32 : 28;
  const indices = new Uint32Array(faceCount * 3);
  const groups: MefGroup[] = [];
  let written = 0;
  let off = 0;
  while (off < dner.size) {
    const at = dner.offset + off;
    if (off + header > dner.size) fail(`truncated DNER block at +${off}`);
    const s16 = (i: number) => view.getInt16(at + 12 + i * 2, true);
    const indexCount = s16(0);
    const slot = s16(2);
    const vertexOffset = modelType === 3 ? s16(4) : s16(3);
    const blockVertices = modelType === 3 ? s16(5) : s16(4);
    if (indexCount < 0 || indexCount % 3 !== 0) fail(`DNER block +${off} index count ${indexCount}`);
    if (vertexOffset < 0 || blockVertices < 0 || vertexOffset + blockVertices > vertexCount) {
      fail(`DNER block +${off} vertex range outside XTRV`);
    }
    if (off + header + indexCount * 2 > dner.size) fail(`DNER block +${off} indices outside chunk`);
    if (written + indexCount > indices.length) fail("DNER holds more faces than D3DR declares");
    groups.push({
      start: written,
      count: indexCount,
      materialSlot: slot,
      deferredFlag: view.getInt16(at + (modelType === 3 ? 0x18 : 0x16), true),
      blendFlags: view.getUint8(at + (modelType === 3 ? 0x1c : 0x18)),
      textureFactorByte: view.getUint8(at + (modelType === 3 ? 0x1f : 0x1b)),
    });
    for (let i = 0; i < indexCount; i += 3) {
      const a = view.getUint16(at + header + i * 2, true);
      const b = view.getUint16(at + header + (i + 1) * 2, true);
      const c = view.getUint16(at + header + (i + 2) * 2, true);
      if (a >= blockVertices || b >= blockVertices || c >= blockVertices) {
        fail(`DNER block +${off} index outside its vertex range`);
      }
      indices[written++] = vertexOffset + a;
      indices[written++] = vertexOffset + c; // Direct3D clockwise -> WebGL CCW
      indices[written++] = vertexOffset + b;
    }
    off += header + indexCount * 2;
  }
  if (off !== dner.size) fail("DNER blocks do not end at the chunk boundary");
  if (groups.length !== blockCount) fail(`DNER has ${groups.length} blocks, D3DR declares ${blockCount}`);
  if (written !== indices.length) fail(`DNER has ${written / 3} faces, D3DR declares ${faceCount}`);

  // --- attachments --------------------------------------------------------
  const attachments: MefAttachment[] = [];
  for (const atta of all("ATTA")) {
    if (atta.size % 68 !== 0) fail(`ATTA size ${atta.size} not a multiple of 68`);
    for (let r = 0; r < atta.size / 68; r++) {
      const at = atta.offset + r * 68;
      let name = "";
      for (let i = 0; i < 16 && bytes[at + i] !== 0; i++) name += String.fromCharCode(bytes[at + i]);
      const f = (i: number) => view.getFloat32(at + 16 + i * 4, true);
      attachments.push({
        name,
        position: [f(0), f(1), f(2)],
        matrix: [f(3), f(4), f(5), f(6), f(7), f(8), f(9), f(10), f(11)],
        bone: view.getInt32(at + 64, true),
      });
    }
  }

  // --- collision meshes ---------------------------------------------------
  const collision: MefCollisionMesh[] = [];
  const hsmc = all("HSMC");
  if (hsmc.length > 0) {
    const [xtvc, ecfc] = [all("XTVC"), all("ECFC")];
    const meshCount = hsmc[0].size / 32;
    if (hsmc.length !== 1 || !Number.isInteger(meshCount) || xtvc.length !== meshCount || ecfc.length !== meshCount) {
      fail("collision chunks do not match their HSMC header");
    }
    for (let k = 0; k < meshCount; k++) {
      const faces = view.getUint32(hsmc[0].offset + k * 32, true);
      const verts = view.getUint32(hsmc[0].offset + k * 32 + 4, true);
      if (xtvc[k].size !== verts * 16 || ecfc[k].size !== faces * 8) fail(`collision mesh ${k} size mismatch`);
      const cp = new Float32Array(verts * 3);
      for (let v = 0; v < verts; v++) {
        for (let c = 0; c < 3; c++) cp[v * 3 + c] = view.getFloat32(xtvc[k].offset + v * 16 + c * 4, true);
      }
      const ci = new Uint32Array(faces * 3);
      for (let f = 0; f < faces; f++) {
        const at = ecfc[k].offset + f * 8;
        const a = view.getUint16(at, true);
        const b = view.getUint16(at + 2, true);
        const c = view.getUint16(at + 4, true);
        if (a >= verts || b >= verts || c >= verts) fail(`collision mesh ${k} face ${f} index out of range`);
        ci[f * 3] = a;
        ci[f * 3 + 1] = c;
        ci[f * 3 + 2] = b;
      }
      collision.push({ positions: cp, indices: ci });
    }
  }

  const lightmapSizes: Array<[number, number]> = [];
  for (const pmtl of all("PMTL")) {
    if (pmtl.size % 8 !== 0) fail(`PMTL size ${pmtl.size} not a multiple of 8`);
    for (let r = 0; r < pmtl.size / 8; r++) {
      lightmapSizes.push([view.getUint16(pmtl.offset + r * 8, true), view.getUint16(pmtl.offset + r * 8 + 2, true)]);
    }
  }

  return {
    modelType,
    positions,
    normals,
    uv,
    lightmapUv,
    indices,
    groups,
    attachments,
    collision,
    lightmapSizes,
    min,
    max,
  };
}
