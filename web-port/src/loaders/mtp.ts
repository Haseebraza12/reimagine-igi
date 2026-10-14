/**
 * `.mtp` model/texture table (EA IFF style "FORM" with form id "MTP ").
 *
 * Layout (confidence: observed on level1.mtp, location0.mtp, common.mtp):
 *   "FORM" u32BE size "MTP " then chunks: tag[4] u32BE size, payload,
 *   one pad byte when the size is odd.
 *   MODS / TEXF: u32LE count, then `count` NUL-terminated names.
 *                MODS order equals the member order of the matching models
 *                .res, TEXF the member order of the matching textures .res.
 *   INST: repeated { u32LE modelIndex, u32LE n, n x u32LE textureIndex },
 *         one record per model in MODS order, filling the chunk exactly.
 *         (The community MTP_REFERENCE.md describes u16 fields with a
 *         leading count; that layout does not parse these files.)
 * A model's DNER `slot` indexes its INST texture list.
 */

export interface MtpTable {
  models: string[];
  textures: string[];
  /** Model name -> texture names in slot order. */
  modelTextures: Map<string, string[]>;
}

function fail(message: string): never {
  throw new Error(`MTP: ${message}`);
}

function readNames(view: DataView, bytes: Uint8Array, start: number, end: number, what: string): string[] {
  if (end - start < 4) fail(`${what} chunk too short`);
  const count = view.getUint32(start, true);
  const names: string[] = [];
  let pos = start + 4;
  for (let i = 0; i < count; i++) {
    let name = "";
    while (pos < end && bytes[pos] !== 0) name += String.fromCharCode(bytes[pos++]);
    if (pos >= end) fail(`${what} name ${i} is not NUL terminated`);
    pos++;
    names.push(name);
  }
  return names;
}

export function readMtp(buffer: ArrayBuffer): MtpTable {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (bytes.length < 12 || tag(0) !== "FORM" || tag(8) !== "MTP ") fail("expected FORM/MTP file");
  const formEnd = 8 + view.getUint32(4, false);
  if (formEnd !== bytes.length) fail(`FORM size ${formEnd} does not match file length ${bytes.length}`);
  const chunks = new Map<string, { start: number; end: number }>();
  let pos = 12;
  while (pos < formEnd) {
    if (pos + 8 > formEnd) fail(`truncated chunk header at 0x${pos.toString(16)}`);
    const size = view.getUint32(pos + 4, false);
    const start = pos + 8;
    if (start + size > formEnd) fail(`chunk ${tag(pos)} outside FORM`);
    chunks.set(tag(pos), { start, end: start + size });
    pos = start + size + (size & 1);
  }
  const need = (name: string) => chunks.get(name) ?? fail(`missing ${name} chunk`);
  const mods = need("MODS");
  const texf = need("TEXF");
  const inst = need("INST");
  const models = readNames(view, bytes, mods.start, mods.end, "MODS");
  const textures = readNames(view, bytes, texf.start, texf.end, "TEXF");

  const modelTextures = new Map<string, string[]>();
  let at = inst.start;
  let expected = 0;
  while (at < inst.end) {
    if (at + 8 > inst.end) fail("truncated INST record");
    const modelIndex = view.getUint32(at, true);
    const count = view.getUint32(at + 4, true);
    at += 8;
    if (modelIndex !== expected) fail(`INST record ${expected} names model ${modelIndex}`);
    if (modelIndex >= models.length) fail(`INST model index ${modelIndex} outside MODS`);
    if (at + count * 4 > inst.end) fail(`INST record ${modelIndex} overruns the chunk`);
    const list: string[] = [];
    for (let i = 0; i < count; i++) {
      const textureIndex = view.getUint32(at + i * 4, true);
      if (textureIndex >= textures.length) fail(`INST texture index ${textureIndex} outside TEXF`);
      list.push(textures[textureIndex]);
    }
    at += count * 4;
    modelTextures.set(models[modelIndex], list);
    expected++;
  }
  if (expected !== models.length) fail(`INST has ${expected} records for ${models.length} models`);
  return { models, textures, modelTextures };
}
