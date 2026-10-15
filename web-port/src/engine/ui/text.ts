/**
 * Text measuring and wrapping as igi.exe does it for the radio messages and
 * the menu TextBox (pure; no DOM).
 *
 * Two different width functions exist in the exe (recovered):
 *   - FUN_004ad990 / FUN_004ad200: line width = pen position after the last
 *     MAPPED character (trailing spaces do not count). Port: `measureText`
 *     (loaders/ui.ts). Used for MenuText sizes, the weapon name, the ammo counter.
 *   - FUN_004ad2e0: the sum of the pen advances of ALL characters, unmapped
 *     ones (space) adding the font's space advance (FUN_004acf90). Used by the
 *     status-message word wrap (FUN_00483d20) and by the TextBox word wrap
 *     (FUN_0041b8b0). Port: `penAdvance` below.
 *
 * Note: loaders/ui.ts `wrapStatusText` measures with `measureText`; the
 * decompile of FUN_00483d20 calls FUN_004ad2e0, so `wrapRadioText` here uses
 * the full pen advance. The two agree except when the text before the current
 * character ends in a space.
 */
import type { UiFont } from "../../loaders";

/** FUN_004ad2e0: total pen advance of `text` (spaces and unmapped characters use the space advance). */
export function penAdvance(font: UiFont, text: string): number {
  let pen = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const g = c < 256 ? font.charMap[c] : 0;
    pen += g ? (font.proportional ? font.glyphs[g - 1].advance : font.cellWidth) : font.spaceAdvance;
  }
  return pen;
}

/**
 * FUN_00483d20 (status-message word wrap), including its quirks:
 *   - walk the characters; the width of the line text BEFORE the current
 *     character is measured (full pen advance);
 *   - break when that width >= wrapWidth or the current character is '\n';
 *     the break goes at the last space seen (never reset after a break), or
 *     before the current character when no space was seen yet;
 *   - at most 9 lines are produced; only the last 3 are returned.
 */
export function wrapRadioText(font: UiFont, text: string, wrapWidth: number): string[] {
  const lines: string[] = [];
  let lineStart = 0;
  let lastSpace = -1;
  let p = 0;
  for (; p < text.length; p++) {
    if (lines.length > 8) break;
    const c = text[p];
    const width = penAdvance(font, text.slice(lineStart, p));
    if (width >= wrapWidth || c === "\n") {
      if (lastSpace < 0) lastSpace = p - 1; // pcVar12 is set once and never reset
      // The exe NULs the break character and strcpy's from lineStart: when the
      // break lies before lineStart (a stale space) the copy runs to the end.
      lines.push(lastSpace >= lineStart ? text.slice(lineStart, lastSpace) : text.slice(lineStart));
      lineStart = lastSpace + 1;
    }
    if (text[p] === " ") lastSpace = p;
  }
  if (p !== lineStart && lineStart < text.length) lines.push(text.slice(lineStart));
  const first = lines.length >= 4 ? lines.length - 3 : 0;
  return lines.slice(first);
}

export interface PlacedWord {
  text: string;
  x: number;
  y: number;
}

/**
 * FUN_0041b8b0 (TextBox word wrap): the text is cut into words that keep their
 * trailing space; a word goes on the current line when its pen advance is
 * smaller than the room left, otherwise a new line starts one font line height
 * lower (the room becomes width - wordWidth). Each word is drawn on its own at
 * the pen position. No height clipping (the box height is not used).
 */
export function wrapTextBox(font: UiFont, text: string, x: number, y: number, width: number): PlacedWord[] {
  const out: PlacedWord[] = [];
  let room = width;
  let penX = x;
  let penY = y;
  let i = 0;
  while (i <= text.length) {
    let word = "";
    let ended = false;
    for (;;) {
      if (i >= text.length) {
        ended = true;
        i++;
        break;
      }
      const c = text[i++];
      word += c;
      if (c === " ") break;
    }
    const w = penAdvance(font, word);
    if (w < room) {
      room -= w;
    } else {
      penX = x;
      penY += font.lineHeight;
      room = width - w;
    }
    if (word.length) out.push({ text: word, x: penX, y: penY });
    penX += w;
    if (ended) break;
  }
  return out;
}
