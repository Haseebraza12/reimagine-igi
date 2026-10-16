/**
 * Story Mode / Free Mode: the dialog added in front of the original Select
 * Mission screen (ui/mode-menu.ts), driven through the original menu manager.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { IgiTask } from "../src/loaders";
import { loadUiAssets } from "../src/engine/ui/assets";
import { MenuConfig } from "../src/engine/ui/menu-config";
import { MenuManager, type MenuEnvironment, type MenuItem } from "../src/engine/ui/menu-model";
import { MODE_DIALOG_ID, MODE_MENU_TEXT, NOT_INSTALLED_DIALOG_ID, injectModeDialog } from "../src/engine/ui/mode-menu";
import { RAW_ROOT, readRaw } from "./helpers";

const have = (...paths: string[]) => paths.every((p) => existsSync(`${RAW_ROOT}/${p}`));
const rawSource = { exists: async (p: string) => existsSync(`${RAW_ROOT}/${p}`), readBinary: (p: string) => readRaw(p) };

describe.skipIf(!have("menusystem/mainmenu.qvm"))("Story / Free mode dialog", () => {
  it("routes Play Project IGI through dialog 936 (Quit dialog geometry), once", async () => {
    const a = await loadUiAssets(rawSource);
    expect(injectModeDialog(a.mainMenu)).toBe(true);
    expect(injectModeDialog(a.mainMenu)).toBe(true);
    const all: IgiTask[] = [];
    const walk = (t: IgiTask) => {
      all.push(t);
      t.children.forEach(walk);
    };
    a.mainMenu.forEach(walk);
    const entry = all.find((t) => t.type === "MenuText" && t.params["Text Resource"] === "Single Player")!;
    expect(entry.params["On Click Script"]).toBe(`MenuManager_ActivatePopupScreen(${MODE_DIALOG_ID})`);
    const dialogs = all.filter((t) => t.type === "DialogWindow" && t.id === MODE_DIALOG_ID);
    expect(dialogs.length).toBe(1);
    const quit = all.find((t) => t.type === "DialogWindow" && t.id === 934)!;
    for (const k of ["X-Pos", "Y-Pos", "Width", "Height"]) expect(dialogs[0].params[k]).toBe(quit.params[k]);
    // Siblings: the dialog sits with the other screens / dialogs (where the manager looks them up).
    const holder = a.mainMenu.find((t) => t.type === "MenuManager")?.children ?? a.mainMenu;
    expect(holder.some((t) => t.id === MODE_DIALOG_ID && t.type === "DialogWindow")).toBe(true);
  });

  async function manager(free = false) {
    const a = await loadUiAssets(rawSource);
    injectModeDialog(a.mainMenu);
    const config = new MenuConfig();
    const modes: number[] = [];
    const leaves: number[] = [];
    const env: MenuEnvironment = {
      text: (k) => a.menuStrings.get(k.toLowerCase()) ?? MODE_MENU_TEXT.get(k.toLowerCase()) ?? `RM: ${k}`,
      measure: (f, t) => {
        const font = a.main.fonts.get(f);
        return font ? { w: t.length * 9, h: font.lineHeight } : null;
      },
      picture: (n) => {
        const p = a.main.pictures.get(n);
        return p ? { w: p.width, h: p.height } : null;
      },
      missions: () => (free ? a.missionCatalogue : a.missions),
      missionInstalled: (id) => a.missions.some((m) => m.id === id),
      activeMission: () => 1,
      levelFailed: () => false,
      playerDead: () => false,
      sound: () => {},
      setMission: () => {},
      leave: (mode) => leaves.push(mode),
      setPaused: () => {},
      opened: () => {},
      config,
      spriteSize: (n) => {
        const s = a.main.sprites.get(n.toLowerCase());
        return s ? { w: s.width, h: s.height } : null;
      },
      font: (n) => a.main.fonts.get(n.toLowerCase()) ?? null,
      heldKeys: () => new Set<string>(),
      setPlayMode: (m) => modes.push(m),
    };
    const m = new MenuManager(a.mainMenu, env, { ownDisplay: true, ticksPerSecond: 60, startOpen: true });
    return { m, modes, leaves, a };
  }
  const run = (m: MenuManager, n: number) => {
    for (let i = 0; i < n; i++) m.tick();
  };
  const find = (root: MenuItem | null, key: string): MenuItem | null => {
    let out: MenuItem | null = null;
    const w = (i: MenuItem) => {
      if (!out && i.textKey === key) out = i;
      i.children.forEach(w);
    };
    if (root) w(root);
    return out;
  };
  const click = (m: MenuManager, item: MenuItem) => {
    m.pointerMove(item.x + 3, item.y + 3);
    m.pointerButton(true);
    run(m, 1);
    m.pointerButton(false);
    run(m, 2);
  };

  for (const [label, mode] of [["Story Mode", 0], ["Free Mode", 1]] as const) {
    it(`${label}: the dialog closes, the mode is set and Select Mission (914) opens`, async () => {
      const { m, modes } = await manager();
      run(m, 60);
      expect(m.screen?.id).toBe(900);
      click(m, find(m.screen, "Single Player")!);
      run(m, 40);
      expect(m.popup?.id).toBe(MODE_DIALOG_ID);
      const texts: string[] = [];
      const w = (i: MenuItem) => {
        if (i.kind === "text") texts.push(i.text);
        i.children.forEach(w);
      };
      w(m.popup!);
      expect(texts).toEqual(["Select Mode", "Story Mode", "Free Mode", "Cancel"]);
      click(m, find(m.popup, label)!);
      run(m, 80);
      expect(modes).toEqual([mode]);
      expect(m.popup).toBe(null);
      expect(m.screen?.id).toBe(914);
      // Cancel on Select Mission returns to the main menu.
      click(m, find(m.screen, "Cancel")!);
      run(m, 80);
      expect(m.screen?.id).toBe(900);
      expect(m.popup).toBe(null);
    });
  }

  it("the game names 14 missions, each with its picture; only the staged ones are installed", async () => {
    const a = await loadUiAssets(rawSource);
    const c = a.missionCatalogue;
    expect(c.map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(c.map((m) => m.name)).toEqual([
      "Trainyard", "SAM Base", "Military Airbase", "GOD", "Radar Base", "Get Priboi", "Border Crossing",
      "Re-supply", "Missile Trainyard", "Defend Priboi", "Eagle's Nest I", "Eagle's Nest II", "Nuclear Infiltration", "Finding the bomb",
    ]);
    expect(c[13].description).toBe("Kill Ekk and find the bomb");
    for (const m of c) expect(a.missionSprites.sprites.has(m.sprite)).toBe(true);
    expect(c.filter((m) => m.installed).map((m) => m.id)).toEqual(a.missions.map((m) => m.id));
  });

  it("Free Mode Select Mission lists all 14; OK on a mission without files opens 937, on Trainyard it starts", async () => {
    const { m, leaves } = await manager(true);
    run(m, 60);
    m.openScreen(914);
    run(m, 60);
    let list: MenuItem | null = null;
    const w = (i: MenuItem) => {
      if (!list && i.kind === "scrolllist") list = i;
      i.children.forEach(w);
    };
    w(m.screen!);
    const l = list as unknown as MenuItem;
    expect(l.entries.length).toBe(14);
    expect(l.entries.map((e) => e.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    // Select "SAM Base" (row 2) and press OK.
    m.pointerMove(l.x + 10, l.y + l.rowHeight * 1 + 2);
    m.pointerButton(true);
    run(m, 1);
    m.pointerButton(false);
    run(m, 4);
    const ok = find(m.screen, "OK")!;
    m.pointerMove(ok.x + 3, ok.y + 3);
    m.pointerButton(true);
    run(m, 1);
    expect(m.releaseStartsPlay()).toBe(false); // the mouse is not captured for a mission that will not start
    m.pointerButton(false);
    run(m, 40);
    expect(m.popup?.id).toBe(NOT_INSTALLED_DIALOG_ID);
    const texts: string[] = [];
    const t = (i: MenuItem) => {
      if (i.kind === "text") texts.push(i.text);
      i.children.forEach(t);
    };
    t(m.popup!);
    expect(texts).toEqual(["Mission Not Installed", "Its files are not part of", "this installation.", "OK"]);
    expect(leaves).toEqual([]);
    click(m, find(m.popup, "OK")!);
    run(m, 40);
    expect(m.popup).toBe(null);
    expect(m.screen?.id).toBe(914);
    // Trainyard (row 1) starts.
    m.pointerMove(l.x + 10, l.y + 2);
    m.pointerButton(true);
    run(m, 1);
    m.pointerButton(false);
    run(m, 4);
    m.pointerMove(ok.x + 3, ok.y + 3);
    m.pointerButton(true);
    run(m, 1);
    expect(m.releaseStartsPlay()).toBe(true);
    m.pointerButton(false);
    run(m, 120);
    expect(leaves).toEqual([13]); // MENUMANAGER_STARTGAME
  });

  it("Cancel closes the dialog and stays on the main menu", async () => {
    const { m, modes } = await manager();
    run(m, 60);
    click(m, find(m.screen, "Single Player")!);
    run(m, 40);
    click(m, find(m.popup, "Cancel")!);
    run(m, 60);
    expect(m.popup).toBe(null);
    expect(m.screen?.id).toBe(900);
    expect(modes).toEqual([]);
  });
});
