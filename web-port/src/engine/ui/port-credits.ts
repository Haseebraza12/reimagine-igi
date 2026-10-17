/**
 * The Credits screen (TypeWriterBox) of the port: the web port's own pages, in
 * the style of igi.exe's table (title in colour 1 / font index 2, headings in
 * colour 3 / font index 3, names in colour 2 / font index 2, a page break
 * ends each page). igi.exe's own table (the original team) is not shown.
 */
import type { IgiTask } from "../../loaders";
import type { TypewriterEntry } from "./menu-widgets";

const title = (y: number, text: string): TypewriterEntry => ({ x: 0, y, colour: 1, font: 2, pause: 0, pageStart: true, localised: false, text });
const heading = (y: number, text: string): TypewriterEntry => ({ x: 0, y, colour: 3, font: 3, pause: 0, pageStart: false, localised: false, text });
const name = (y: number, text: string): TypewriterEntry => ({ x: 0, y, colour: 2, font: 2, pause: 0, pageStart: false, localised: false, text });
/** End of a page: not drawn, the page fades out (pause -1), as the table's own breaks (x -100, y -1). */
const pageBreak = (): TypewriterEntry => ({ x: -100, y: -1, colour: 2, font: 2, pause: -1, pageStart: false, localised: false, text: "" });

/** The port's pages. */
export function portCreditsScript(): TypewriterEntry[] {
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
    pageBreak(),
  ];
}

/**
 * Fit the Credits screen (916) like the Read Me screen (913): mainmenu.qvm gives its TypeWriterBox
 * 610 x 270, wider than its 455-wide frame (and the screen frame 100..540), so the box spilled over
 * the window; the port gives it the Read Me AsciiBox's 430 x 276 inside the same frame, and its Ok the
 * Read Me's place. Returns false when the screen is not found.
 */
export function fitCreditsScreen(tree: IgiTask[]): boolean {
  const find = (t: IgiTask, id: number, type: string): IgiTask | null => {
    if (t.id === id && t.type === type) return t;
    for (const c of t.children) {
      const r = find(c, id, type);
      if (r) return r;
    }
    return null;
  };
  const screenOf = (id: number) => tree.map((t) => find(t, id, "MenuScreen")).find(Boolean) ?? null;
  const credits = screenOf(916);
  const readme = screenOf(913);
  if (!credits || !readme) return false;
  const childOf = (screen: IgiTask, type: string) => screen.children.find((f) => f.children.some((c) => c.type === type)) ?? null;
  const box = childOf(credits, "TypeWriterBox")?.children.find((c) => c.type === "TypeWriterBox");
  const ascii = childOf(readme, "AsciiBox")?.children.find((c) => c.type === "AsciiBox");
  if (!box || !ascii) return false;
  box.params.Width = ascii.params.Width;
  box.params.Height = ascii.params.Height;
  const okOf = (screen: IgiTask) => screen.children.find((f) => f.children.some((c) => c.type === "MenuText" && c.params["Text Resource"] === "Ok")) ?? null;
  const ok = okOf(credits);
  const readmeOk = okOf(readme);
  if (ok && readmeOk) {
    ok.params["X-Pos"] = readmeOk.params["X-Pos"];
    ok.params["Y-Pos"] = readmeOk.params["Y-Pos"];
  }
  return true;
}
