/**
 * Story Mode / Free Mode (port addition, not in igi.exe): "Play Project IGI"
 * on the main menu (screen 900, text key "Single Player", originally
 * MenuManager_PushScreen(914)) opens a dialog first, built like the shipped
 * Quit dialog 934 (same window, title frame and font): "Story Mode",
 * "Free Mode" and "Cancel". Both modes continue to the original Select
 * Mission screen 914; Game_SetPlayMode tells the port which missions it
 * lists (story: the installed missions up to the profile's progress, as
 * igi.exe; free: every mission the game names, missions.res 1..14, with its
 * picture and description) and whether finishing one moves the story on.
 * Select Mission's OK / double click start only an installed mission
 * (Game_IsMissionInstalled); another opens dialog 937 "Mission Not Installed".
 */
import type { IgiTask } from "../../loaders";

/** Dialog id (the shipped scripts use 930-935). */
export const MODE_DIALOG_ID = 936;
/** "Mission Not Installed" (Free Mode lists every mission the game names). */
export const NOT_INSTALLED_DIALOG_ID = 937;
export const PLAY_MODE = { story: 0, free: 1 } as const;
export type PlayMode = "story" | "free";

/** Text keys the port adds (menusystem.res has none of them). */
export const MODE_MENU_TEXT: ReadonlyMap<string, string> = new Map(
  ["Select Mode", "Story Mode", "Free Mode", "Cancel", "Mission Not Installed", "Its files are not part of", "this installation."].map((k) => [k.toLowerCase(), k]),
);

const task = (type: string, params: IgiTask["params"], children: IgiTask[] = [], id = -1): IgiTask => ({ id, type, name: "", params, children });
const text = (key: string, colour: number, click = "", sound = ""): IgiTask =>
  task("MenuText", { "Text Resource": key, "Font Resource": "font3.fnt", ColourIndex: colour, "On Click Script": click, "Click Sound Resource": sound });
const frame = (x: number, y: number, w: number, h: number, lineUp: number, children: IgiTask[]): IgiTask =>
  task("MenuFrame", {
    "Sprite Resource": "",
    "X-Pos": x,
    "Y-Pos": y,
    Width: w,
    Height: h,
    LineUpMode: lineUp,
    "X-Spacing": 4,
    "Y-Spacing": 4,
    "Is Selectable": false,
  }, children);

/** Dialog 936 at the Quit dialog's place and size (197, 234, 256 x 133). */
function modeDialog(): IgiTask {
  const choose = (mode: number) => `Game_SetPlayMode(${mode}), MenuManager_DeactivatePopuScreen(), MenuManager_PushScreen(914)`;
  return task("DialogWindow", { "X-Pos": 197, "Y-Pos": 234, Width: 256, Height: 133, SwapKeys: false }, [
    frame(197, 234, 256, 21, 2, [text("Select Mode", 1)]),
    frame(197, 255, 256, 107, 1, [
      text("Story Mode", 2, choose(PLAY_MODE.story), "menu_ok"),
      text("Free Mode", 2, choose(PLAY_MODE.free), "menu_ok"),
      text("Cancel", 2, "MenuManager_DeactivatePopuScreen()", "menu_cancel"),
    ]),
  ], MODE_DIALOG_ID);
}

/** Dialog 937 at the Quit dialog's place and size: title, two lines in font4, OK. */
function notInstalledDialog(): IgiTask {
  const line = (key: string): IgiTask =>
    task("MenuText", { "Text Resource": key, "Font Resource": "font4.fnt", ColourIndex: 1, "On Click Script": "", "Click Sound Resource": "" });
  return task("DialogWindow", { "X-Pos": 197, "Y-Pos": 234, Width: 256, Height: 133, SwapKeys: false }, [
    frame(197, 234, 256, 21, 2, [text("Mission Not Installed", 1)]),
    frame(197, 258, 256, 50, 1, [line("Its files are not part of"), line("this installation.")]),
    frame(197, 316, 256, 40, 1, [text("OK", 2, "MenuManager_DeactivatePopuScreen()", "menu_ok")]),
  ], NOT_INSTALLED_DIALOG_ID);
}

/** `script` (a Select Mission start) only for an installed mission; else the Not Installed dialog. */
const guardStart = (script: string, id: string): string =>
  script.includes("Game_IsMissionInstalled")
    ? script
    : `Game_IsMissionInstalled(${id}) ? (${script.trim()}) : MenuManager_ActivatePopupScreen(${NOT_INSTALLED_DIALOG_ID})`;

const walk = (t: IgiTask, f: (t: IgiTask) => void): void => {
  f(t);
  for (const c of t.children) walk(c, f);
};

/**
 * Route "Play Project IGI" through the mode dialog (in place; idempotent). False when the
 * main menu entry or the place of the dialogs was not found (the tree is left unchanged).
 */
export function injectModeDialog(tree: IgiTask[]): boolean {
  let entry: IgiTask | null = null;
  let siblings: IgiTask[] | null = null;
  let exists = false;
  const visit = (list: IgiTask[]) => {
    for (const t of list) {
      if (t.type === "DialogWindow" && t.id === MODE_DIALOG_ID) exists = true;
      if ((t.type === "DialogWindow" && t.id === 934) || (t.type === "MenuScreen" && t.id === 900)) siblings ??= list;
    }
  };
  visit(tree);
  for (const root of tree) walk(root, (t) => visit(t.children));
  for (const root of tree) walk(root, (t) => {
    if (t.type !== "MenuScreen" || t.id !== 900) return;
    walk(t, (c) => {
      if (!entry && c.type === "MenuText" && c.params["Text Resource"] === "Single Player") entry = c;
    });
  });
  if (!entry || !siblings) return false;
  (entry as IgiTask).params["On Click Script"] = `MenuManager_ActivatePopupScreen(${MODE_DIALOG_ID})`;
  if (!exists) (siblings as IgiTask[]).push(modeDialog(), notInstalledDialog());
  // Select Mission (914): OK and a double click on the list start the mission only when it is installed.
  for (const root of tree) walk(root, (t) => {
    if (t.type !== "MenuScreen" || t.id !== 914) return;
    walk(t, (c) => {
      if (c.type === "ScrollListBox" && c.id === 964 && typeof c.params["On Select Item"] === "string" && /MENUMANAGER_STARTGAME/.test(c.params["On Select Item"] as string)) {
        c.params["On Select Item"] = guardStart(c.params["On Select Item"] as string, "this.nActiveID");
      }
      if (c.type === "MenuText" && c.params["Text Resource"] === "OK" && /MENUMANAGER_STARTGAME/.test(String(c.params["On Click Script"] ?? ""))) {
        c.params["On Click Script"] = guardStart(c.params["On Click Script"] as string, "ScrollListBox_964.nActiveID");
      }
    });
  });
  return true;
}
