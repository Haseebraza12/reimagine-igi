/**
 * The Credits screen's script (TypeWriterBox, igi.exe FUN_0041cf80): 130
 * entries of 36 bytes at VA 0x537cd8 in the shipped igi.exe, read at runtime
 * from the user's own executable (nothing is copied into the port).
 *
 * Entry (recovered from FUN_0041d0b0 / FUN_0041d160):
 *   +0x00 i32 x       0 = centred, < 0 = right-aligned (x - 8 from the right edge), > 0 = x + 8
 *   +0x04 i32 y       line y inside the box; -1 = page break (not drawn)
 *   +0x08 i32 colour  menu palette index (0x539728)
 *   +0x0c i32 font    0..3 = font1..font4 of the manager's archive
 *   +0x10 i32 pause   ticks to wait after the line; -1 = end of page (253-tick fade)
 *   +0x14 i32 page    first line of a page
 *   +0x18 i32 local   text is a language key (resolved through menusystem.res)
 *   +0x1c u32 text    pointer to the text (VA)
 *   +0x20             resolved text (runtime)
 */

export interface ExeCreditLine {
  x: number;
  y: number;
  colour: number;
  font: number;
  pause: number;
  pageStart: boolean;
  localised: boolean;
  text: string;
}

export const CREDITS_TABLE_VA = 0x537cd8;
/** The same table in the full game's IGI.exe (24 Nov 2000 build) [observed: entry 2's text pointer]. */
export const CREDITS_TABLE_VA_FULL = 0x539c48;
export const CREDITS_TABLE_COUNT = 0x82;

interface Section {
  va: number;
  vsize: number;
  raw: number;
  rsize: number;
}

/** Map a virtual address of a PE image to a file offset (null when unmapped). */
function sectionsOf(view: DataView): { base: number; sections: Section[] } {
  if (view.getUint16(0, true) !== 0x5a4d) throw new Error("igi.exe: not an MZ executable");
  const pe = view.getUint32(0x3c, true);
  if (view.getUint32(pe, true) !== 0x4550) throw new Error("igi.exe: no PE header");
  const count = view.getUint16(pe + 6, true);
  const optSize = view.getUint16(pe + 20, true);
  const base = view.getUint32(pe + 24 + 28, true);
  const sections: Section[] = [];
  const first = pe + 24 + optSize;
  for (let i = 0; i < count; i++) {
    const o = first + 40 * i;
    sections.push({ vsize: view.getUint32(o + 8, true), va: view.getUint32(o + 12, true), rsize: view.getUint32(o + 16, true), raw: view.getUint32(o + 20, true) });
  }
  return { base, sections };
}

export function readExeCredits(buffer: ArrayBuffer): ExeCreditLine[] {
  const view = new DataView(buffer);
  const { base, sections } = sectionsOf(view);
  const off = (va: number): number | null => {
    const rva = va - base;
    for (const s of sections) {
      if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rsize)) {
        if (rva - s.va >= s.rsize) return null;
        return s.raw + rva - s.va;
      }
    }
    return null;
  };
  const cstr = (va: number): string => {
    const o = off(va);
    if (o === null) return "";
    let out = "";
    for (let i = o; i < view.byteLength && view.getUint8(i) !== 0 && out.length < 256; i++) out += String.fromCharCode(view.getUint8(i));
    return out;
  };
  const readTable = (table: number): ExeCreditLine[] => {
    const out: ExeCreditLine[] = [];
    for (let i = 0; i < CREDITS_TABLE_COUNT; i++) {
      const o = table + i * 36;
      const v = (k: number) => view.getInt32(o + 4 * k, true);
      out.push({
        x: v(0),
        y: v(1),
        colour: v(2),
        font: v(3),
        pause: v(4),
        pageStart: v(5) !== 0,
        localised: v(6) !== 0,
        text: cstr(view.getUint32(o + 0x1c, true)),
      });
    }
    return out;
  };
  /** The table at `va` when it looks like one: page breaks (y = -1), fonts 0..3, text on the first line. */
  const read = (va: number): ExeCreditLine[] | null => {
    const table = off(va);
    if (table === null || table + CREDITS_TABLE_COUNT * 36 > view.byteLength) return null;
    const lines = readTable(table);
    return lines.some((e) => e.font < 0 || e.font > 3) || !lines.some((e) => e.y === -1) || !lines[0].text ? null : lines;
  };
  const out = read(CREDITS_TABLE_VA) ?? read(CREDITS_TABLE_VA_FULL);
  if (!out) throw new Error("igi.exe: credits table not found (other build?)");
  return out;
}
