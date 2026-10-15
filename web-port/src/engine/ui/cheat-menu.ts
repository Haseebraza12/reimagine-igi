/**
 * The Cheats screen (port addition, not in igi.exe): added to the menu task
 * trees of mainmenu.qvm (Configuration, screen 904, after "Content Control")
 * and ingamemenu.qvm ("Game Paused", screen 900, after "Controls") at load.
 *
 * It is built from the original widgets and layout, so it looks and behaves
 * like the shipped Content Control screen (915): a title frame, one
 * selectable row per cheat (MenuText label + ToggleBox, LineUpMode 8, 29 px
 * apart), and OK (MenuManager_PopScreen(TRUE): the toggles' Set Data scripts
 * run) / Cancel (PopScreen(FALSE): nothing changes). The toggles read and
 * write MenuConfig through Config_CheatGet(i) / Config_CheatSet(i, on).
 */
import type { IgiTask } from "../../loaders";
import { CHEAT_KEYS, CHEAT_LABELS } from "../cheats";

/** Screen id of the Cheats screen in both trees (unused by the shipped scripts). */
export const CHEAT_SCREEN_ID = 920;
/** ToggleBox ids (the shipped widgets use 950-966). */
const FIRST_TOGGLE_ID = 980;

/** Menu text keys the port adds; menusystem.res has none of them. */
export const CHEAT_MENU_TEXT: ReadonlyMap<string, string> = new Map(
  [["Cheats", "Cheats"], ...CHEAT_KEYS.map((k) => [CHEAT_LABELS[k], CHEAT_LABELS[k]] as [string, string])].map(([k, v]) => [k.toLowerCase(), v]),
);

const task = (type: string, params: IgiTask["params"], children: IgiTask[] = [], id = -1): IgiTask => ({ id, type, name: "", params, children });

const frame = (x: number, y: number, w: number, h: number, lineUp: number, xSpacing: number, ySpacing: number, selectable: boolean, children: IgiTask[]): IgiTask =>
  task("MenuFrame", {
    "Sprite Resource": "",
    "X-Pos": x,
    "Y-Pos": y,
    Width: w,
    Height: h,
    LineUpMode: lineUp,
    "X-Spacing": xSpacing,
    "Y-Spacing": ySpacing,
    "Is Selectable": selectable,
  }, children);

const text = (key: string, colour: number, click = "", sound = ""): IgiTask =>
  task("MenuText", { "Text Resource": key, "Font Resource": "font3.fnt", ColourIndex: colour, "On Click Script": click, "Click Sound Resource": sound });

interface Layout {
  /** Screen frame (x0, y0, x1, y1) and background, as the tree's other sub-screens. */
  screen: [number, number, number, number];
  title: [number, number, number];
  /** Content frame x, y, width; first row y; row pitch. */
  content: [number, number, number];
  rowY: number;
  rowWidth: number;
  /** OK / Cancel frame. */
  buttons: [number, number, number, number];
}

/** Main menu: Content Control (915) coordinates. In-game: Sound (902) coordinates. */
const LAYOUT: Record<"main" | "ingame", Layout> = {
  main: { screen: [100, 163, 540, 470], title: [95, 161, 455], content: [95, 185, 455], rowY: 189, rowWidth: 455, buttons: [555, 400, 4, 4] },
  ingame: { screen: [85, 80, 555, 410], title: [100, 77, 440], content: [100, 97, 440], rowY: 101, rowWidth: 440, buttons: [470, 360, 1, 3] },
};

function cheatScreen(kind: "main" | "ingame"): IgiTask {
  const l = LAYOUT[kind];
  const rows = CHEAT_KEYS.map((key, i) =>
    frame(l.content[0], l.rowY + 29 * i, l.rowWidth, 25, 8, 40, 4, true, [
      text(CHEAT_LABELS[key], 2),
      task("ToggleBox", { "Get Data Script": `Config_CheatGet(${i})`, "Set Data Script": `Config_CheatSet(${i}, this.isOn)` }, [], FIRST_TOGGLE_ID + i),
    ]),
  );
  return task("MenuScreen", {
    Background: "mainmenu.pic",
    "Frame x0": l.screen[0],
    "Frame y0": l.screen[1],
    "Frame x1": l.screen[2],
    "Frame y1": l.screen[3],
    "On Press Escape": "MenuManager_PopScreen(FALSE)",
    "On Init Data": "",
    "On Change Data": "",
  }, [
    frame(l.title[0], l.title[1], l.title[2], 26, 0, 4, 4, false, [text("Cheats", 1)]),
    frame(l.content[0], l.content[1], l.content[2], 26, 1, 4, 4, false, rows),
    frame(l.buttons[0], l.buttons[1], 80, 80, 1, l.buttons[2], l.buttons[3], false, [
      text("OK", 2, "MenuManager_PopScreen(TRUE)", "menu_ok"),
      text("Cancel", 2, "MenuManager_PopScreen(FALSE)", "menu_cancel"),
    ]),
  ], CHEAT_SCREEN_ID);
}

const walk = (t: IgiTask, f: (t: IgiTask) => void): void => {
  f(t);
  for (const c of t.children) walk(c, f);
};

/**
 * Add the Cheats entry and screen to a menu tree (in place; idempotent). The entry goes after
 * "Content Control" (main) or "Controls" (in-game) in the list frame of the screen that holds it.
 * Returns false when that entry was not found (the tree is left unchanged).
 */
export function injectCheatMenu(tree: IgiTask[], kind: "main" | "ingame"): boolean {
  let exists = false;
  for (const root of tree) walk(root, (t) => {
    if (t.type === "MenuScreen" && t.id === CHEAT_SCREEN_ID) exists = true;
  });
  if (exists) return true;
  const after = kind === "main" ? "Content Control" : "Controls";
  const host = kind === "main" ? 904 : 900;
  let list: IgiTask | null = null;
  let index = -1;
  let parentOfScreen: IgiTask[] | null = null;
  for (const root of tree) {
    walk(root, (t) => {
      if (t.type !== "MenuScreen" || t.id !== host || list) return;
      walk(t, (f) => {
        if (list) return;
        const i = f.children.findIndex((c) => (c.type === "MenuText" || c.type === "MenuTextConditional") && c.params["Text Resource"] === after);
        if (i >= 0) {
          list = f;
          index = i;
        }
      });
    });
    if (list) {
      parentOfScreen = findParentList(tree, host);
      break;
    }
  }
  if (!list || !parentOfScreen) return false;
  (list as IgiTask).children.splice(index + 1, 0, text("Cheats", 2, `MenuManager_PushScreen(${CHEAT_SCREEN_ID})`));
  (parentOfScreen as IgiTask[]).push(cheatScreen(kind));
  return true;
}

/** The children array that holds screen `id` (its siblings are the other screens). */
function findParentList(tree: IgiTask[], id: number): IgiTask[] | null {
  if (tree.some((t) => t.type === "MenuScreen" && t.id === id)) return tree;
  let found: IgiTask[] | null = null;
  for (const root of tree) {
    walk(root, (t) => {
      if (!found && t.children.some((c) => c.type === "MenuScreen" && c.id === id)) found = t.children;
    });
  }
  return found;
}
