/**
 * The Credits screen (TypeWriterBox) of the port: its own pages first, in the
 * style of igi.exe's table (title in colour 1 / font index 2, headings in
 * colour 3 / font index 3, names in colour 2 / font index 2, a page break
 * ends each page), then the original game's credits read from the user's own
 * igi.exe when it is staged (loaders/exe-credits.ts).
 */
import type { TypewriterEntry } from "./menu-widgets";

const title = (y: number, text: string): TypewriterEntry => ({ x: 0, y, colour: 1, font: 2, pause: 0, pageStart: true, localised: false, text });
const heading = (y: number, text: string): TypewriterEntry => ({ x: 0, y, colour: 3, font: 3, pause: 0, pageStart: false, localised: false, text });
const name = (y: number, text: string): TypewriterEntry => ({ x: 0, y, colour: 2, font: 2, pause: 0, pageStart: false, localised: false, text });
/** End of a page: not drawn, the page fades out (pause -1), as the table's own breaks (x -100, y -1). */
const pageBreak = (): TypewriterEntry => ({ x: -100, y: -1, colour: 2, font: 2, pause: -1, pageStart: false, localised: false, text: "" });

/** The port's pages; `originalFollows` adds the line that introduces the original team's credits. */
export function portCreditsScript(originalFollows: boolean): TypewriterEntry[] {
  return [
    title(4, "Project IGI - Web Port"),
    heading(34, "Created by"),
    name(54, "Haseeb ur Rehman"),
    name(74, "CS Graduate"),
    heading(104, "Contact"),
    name(124, "munibhaseeb2@gmail.com"),
    pageBreak(),
    title(4, "About this port"),
    heading(34, "A hobby project"),
    name(54, "Not a distribution"),
    name(74, "Not for sale"),
    heading(104, "Built with"),
    name(124, "TypeScript and WebGL"),
    name(144, "three.js and Web Audio"),
    pageBreak(),
    title(4, "Project IGI: I'm Going In"),
    heading(34, "All rights belong to"),
    name(54, "Innerloop Studios"),
    name(74, "Eidos Interactive"),
    name(94, "and their successors"),
    ...(originalFollows ? [heading(124, "The original team")] : []),
    pageBreak(),
  ];
}
