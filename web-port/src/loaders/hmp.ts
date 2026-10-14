/**
 * `.hmp` terrain heightfield reader (missions/.../terrain/terrain.hmp).
 *
 * The community research docs (tools/igi-research/Research/**) do not cover
 * `.hmp`; docs/formats.md says the structure "has not been established".
 * The layout below was therefore MEASURED directly from
 * `public/raw/missions/location0/level1/terrain/terrain.hmp` (52 995 bytes,
 * identical to the "Game Files" copy); confidence notes inline.
 *
 * Measured structure (confidence: observed):
 *
 *   offset 0x000  three 12-byte records, each:
 *                   u32 runtimeAddress  (original-process pointer; the three
 *                       rise by exactly 16641 = 129*129 — the buffer stride)
 *                   u32 zero
 *                   u32 cells (128 in this corpus -> 129x129 vertices)
 *   offset 0x024  zero padding up to 0xC00
 *   offset 0xC00  body: exactly 3 * 129 * 129 bytes = three u8 grids
 *                 (0xC00 + 3*16641 = 52995 = EOF, exact)
 *
 * The body CANNOT be a u16 grid: 52995 - 3072 = 49923 is odd, and every one
 * of the 49 923 body bytes lies in [7, 121] — impossible for u16 heights
 * spanning 1810..28512 (their low bytes would cover 0..255). Heights are
 * 8-bit, one value per vertex, normalised /255 here (NOT /65535 as the
 * loader-api.md prose guessed for a hypothetical u16 layout).
 *
 * Which of the three grids holds the elevations is INFERRED: the first
 * pointer / first body buffer is taken as the heightmap (primary data first
 * by convention); the other two grids are smooth, mutually decorrelated
 * (r ~ 0.2) auxiliary channels (likely lighting-related; role unknown).
 * Slope correlation, .lmp tile matching and QSC placements did not
 * discriminate further.
 *
 * `readHmp` throws whenever the header/body arithmetic does not resolve to
 * the measured layout instead of returning garbage.
 */
const OBSERVED_HEADER_SIZE = 0xc00; // 3072: header records + zero padding
const HEADER_RECORD_COUNT = 3;
const RECORD_SIZE = 12;

function fail(message: string): never {
  throw new Error(`HMP: ${message}`);
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

/**
 * Parse a `.hmp` heightfield.
 *
 * @returns `size` = vertices per side (129 in the measured corpus),
 *          `heights` = size*size normalised values in 0..1 (u8/255 observed;
 *          a u16 body, if ever encountered, is normalised /65535 per
 *          docs/loader-api.md), row-major, index = z*size + x.
 * @throws Error on any structural inconsistency.
 */
export function readHmp(buffer: ArrayBuffer): { size: number; heights: Float32Array } {
  if (buffer.byteLength < OBSERVED_HEADER_SIZE + 129) {
    fail(`buffer too small (${buffer.byteLength} bytes) for observed layout`);
  }
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // --- Header records: {runtimeAddress, zero, cells} x3 -------------------
  const cells = readU32(view, RECORD_SIZE - 4); // third field of first record
  if (cells < 16 || cells > 4096) {
    fail(`implausible grid cells field ${cells} at offset 0x8`);
  }
  const stride = (cells + 1) * (cells + 1); // observed pointer stride == grid bytes
  let previousAddress = readU32(view, 0);
  for (let i = 0; i < HEADER_RECORD_COUNT; i++) {
    const at = i * RECORD_SIZE;
    const address = readU32(view, at);
    const zero = readU32(view, at + 4);
    const recordCells = readU32(view, at + 8);
    if (zero !== 0) {
      fail(`header record ${i} has non-zero field at offset 0x${(at + 4).toString(16)}`);
    }
    if (recordCells !== cells) {
      fail(
        `header record ${i} cells ${recordCells} != first record ${cells} ` +
          `at offset 0x${(at + 8).toString(16)}`,
      );
    }
    if (i > 0 && address - previousAddress !== stride) {
      fail(
        `header record ${i} pointer stride ${address - previousAddress} != ` +
          `grid size ${stride} (expected 129*129-style buffer stride)`,
      );
    }
    previousAddress = address;
  }

  // Bytes 0x24..0xC00 are all zero in the measured file; keep the check
  // strict so a different file that merely "fits" the arithmetic still fails
  // loudly instead of silently mis-parsing.
  for (let i = RECORD_SIZE * HEADER_RECORD_COUNT; i < OBSERVED_HEADER_SIZE; i++) {
    if (bytes[i] !== 0) {
      fail(`unexpected non-zero byte at 0x${i.toString(16)} inside header padding`);
    }
  }

  const bodyLength = buffer.byteLength - OBSERVED_HEADER_SIZE;
  const size = cells + 1;
  const gridBytes = size * size;
  if (bodyLength < gridBytes) {
    fail(`body of ${bodyLength} bytes shorter than one ${size}x${size} grid`);
  }

  const count = size * size;
  const raw = new Float32Array(count);
  if (bodyLength % (2 * gridBytes) === 0) {
    // Hypothetical u16 grids (docs/loader-api.md assumption): raw/65535.
    // NOTE: a body of exactly 2*gridBytes is ambiguous (one u16 grid vs two
    // u8 grids); the u16 reading follows the frozen API contract.
    for (let i = 0; i < count; i++) {
      raw[i] = view.getUint16(OBSERVED_HEADER_SIZE + i * 2, true) / 65535;
    }
  } else if (bodyLength % gridBytes === 0) {
    // Observed layout: N u8 grids; the first is the heightmap (inferred).
    for (let i = 0; i < count; i++) {
      raw[i] = bytes[OBSERVED_HEADER_SIZE + i] / 255;
    }
  } else {
    fail(
      `body of ${bodyLength} bytes is neither a multiple of ${gridBytes} (u8 grids) ` +
        `nor 2*${gridBytes} (u16 grids)`,
    );
  }
  if (!Number.isFinite(raw[0])) {
    fail("decoded heightfield is non-finite");
  }
  return { size, heights: raw };
}
