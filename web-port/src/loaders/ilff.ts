/**
 * ILFF/IRES resource container parser.
 *
 * Faithful TypeScript port of `tools/igi_formats.py` (`ilff_chunks` +
 * `resource_members`), which was measured against all 53 `.res` files of the
 * local IGI installation (see docs/formats.md, "Resource containers").
 *
 * Measured layout (confidence: observed):
 *
 *   offset 0   "ILFF"
 *   offset 4   u32 total file size (including this header)
 *   offset 8   u32 initial alignment (4 or 32 in this corpus)
 *   offset 12  u32 zero
 *   offset 16  "IRES"
 *
 * The first child header begins at `alignUp(20, rootAlignment)`. Each child
 * header is 16 bytes:
 *
 *   +0  four bytes  tag: "NAME", "BODY", "CSTR" or "PATH"
 *   +4  u32         payload length
 *   +8  u32         payload alignment against the file origin
 *   +12 u32         delta to the next child header (zero for the final child)
 *
 * Payload starts at `alignUp(headerOffset + 16, alignment)`. "NAME" carries a
 * NUL-terminated virtual name for the following "BODY"/"CSTR"/"PATH" payload.
 * The final payload ends exactly at EOF.
 *
 * Every boundary is validated; malformed input throws an Error that includes
 * the offending file offset (mirroring the Python FormatError messages).
 */

/** One named resource extracted from an ILFF/IRES container. */
export interface IlffMember {
  /** Virtual name stored in the preceding NAME chunk (latin-1, NULs stripped). */
  name: string;
  /** Absolute file offset of the first payload byte. */
  offset: number;
  /** Payload length in bytes (> 0). */
  size: number;
  /** Copy of the payload bytes. */
  payload: ArrayBuffer;
}

function readU32(data: DataView, offset: number, what: string): number {
  if (offset < 0 || offset + 4 > data.byteLength) {
    throw new Error(`ILFF: u32 for ${what} outside file at ${offset.toString(16)}`);
  }
  return data.getUint32(offset, true);
}

/** Round `value` up to the next multiple of `alignment` (power of two, 1..4096). */
function alignUp(value: number, alignment: number, where: string): number {
  if (
    alignment < 1 ||
    alignment > 4096 ||
    (alignment & (alignment - 1)) !== 0
  ) {
    throw new Error(`ILFF: unsupported alignment ${alignment} ${where}`);
  }
  return Math.ceil(value / alignment) * alignment;
}

interface RawChunk {
  tag: string;
  headerOffset: number;
  payloadOffset: number;
  size: number;
}

/**
 * Walk the chunk chain with full boundary checks. Yields every chunk header
 * (NAME, BODY, CSTR, PATH); any other tag is rejected like the Python port.
 */
function* walkChunks(view: DataView, bytes: Uint8Array): Generator<RawChunk> {
  const length = view.byteLength;
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  const tail = String.fromCharCode(...bytes.subarray(16, 20));
  if (length < 20 || magic !== "ILFF" || tail !== "IRES") {
    throw new Error("ILFF: expected ILFF/IRES resource container");
  }
  if (readU32(view, 4, "root size") !== length || readU32(view, 12, "root link") !== 0) {
    throw new Error("ILFF: unexpected root size or link");
  }
  const rootAlignment = readU32(view, 8, "root alignment");
  let pos = alignUp(20, rootAlignment, "(root)");
  while (pos < length) {
    if (pos + 16 > length) {
      throw new Error(`ILFF: truncated chunk header at 0x${pos.toString(16)}`);
    }
    let tag = "";
    let printable = true;
    for (let i = 0; i < 4; i++) {
      const b = bytes[pos + i];
      if (b < 32 || b > 126) printable = false;
      tag += String.fromCharCode(b);
    }
    if (!printable) {
      throw new Error(`ILFF: invalid chunk tag at 0x${pos.toString(16)}`);
    }
    const size = readU32(view, pos + 4, `chunk size at 0x${pos.toString(16)}`);
    const alignment = readU32(view, pos + 8, `chunk alignment at 0x${pos.toString(16)}`);
    const delta = readU32(view, pos + 12, `chunk delta at 0x${pos.toString(16)}`);
    const payload = alignUp(pos + 16, alignment, `at 0x${pos.toString(16)}`);
    const end = payload + size;
    if (end > length) {
      throw new Error(`ILFF: chunk payload outside file at 0x${pos.toString(16)}`);
    }
    if (delta === 0) {
      // Observed terminal chunks end at EOF without compulsory padding.
      if (end !== length) {
        throw new Error(`ILFF: unexplained bytes after final chunk at 0x${pos.toString(16)}`);
      }
    } else if (pos + delta < end || pos + delta >= length) {
      throw new Error(`ILFF: invalid next-chunk delta at 0x${pos.toString(16)}`);
    }
    yield { tag, headerOffset: pos, payloadOffset: payload, size };
    if (delta === 0) return;
    pos += delta;
  }
  if (pos !== length) {
    throw new Error("ILFF: root alignment exceeds file");
  }
}

function decodeLatin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * Parse an IGI ILFF/IRES `.res` container into NAME-paired resource members.
 *
 * Pairs each "NAME" with the next "BODY", "CSTR" or "PATH" payload, preserving
 * the original virtual names (e.g. "LOCAL:textures/000_03_1.tex"). "PATH"
 * records are kept as opaque payloads, exactly like the Python reference.
 * Throws Error on any structural anomaly.
 */
export function readIlffMembers(buffer: ArrayBuffer): IlffMember[] {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const members: IlffMember[] = [];
  let pendingName: string | null = null;

  for (const chunk of walkChunks(view, bytes)) {
    if (chunk.tag === "NAME") {
      if (pendingName !== null) {
        throw new Error("ILFF: NAME without a corresponding payload");
      }
      const raw = bytes.subarray(chunk.payloadOffset, chunk.payloadOffset + chunk.size);
      if (raw.length === 0 || raw[raw.length - 1] !== 0) {
        throw new Error(
          `ILFF: NAME is not NUL terminated at 0x${chunk.payloadOffset.toString(16)}`,
        );
      }
      // Strip only the trailing NULs (latin-1, matching the Python rstrip).
      let end = raw.length;
      while (end > 0 && raw[end - 1] === 0) end--;
      pendingName = decodeLatin1(raw.subarray(0, end));
    } else if (chunk.tag === "BODY" || chunk.tag === "CSTR" || chunk.tag === "PATH") {
      if (pendingName === null) {
        throw new Error(`ILFF: ${chunk.tag} without NAME at 0x${chunk.headerOffset.toString(16)}`);
      }
      // Copy so callers can retain payloads without pinning the source buffer.
      const copy = bytes.slice(chunk.payloadOffset, chunk.payloadOffset + chunk.size);
      members.push({
        name: pendingName,
        offset: chunk.payloadOffset,
        size: chunk.size,
        payload: copy.buffer as ArrayBuffer,
      });
      pendingName = null;
    } else {
      throw new Error(
        `ILFF: unsupported resource chunk ${chunk.tag} at 0x${chunk.headerOffset.toString(16)}`,
      );
    }
  }
  if (pendingName !== null) {
    throw new Error("ILFF: resource ends with unmatched NAME");
  }
  return members;
}
