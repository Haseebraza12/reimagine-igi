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
import { MODE_DIALOG_ID, MODE_MENU_TEXT, injectModeDialog } from "../src/engine/ui/mode-menu";
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

  async function manager() {
    const a = await loadUiAssets(rawSource);
    injectModeDialog(a.mainMenu);
    const config = new MenuConfig();
    const modes: number[] = [];
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
      missions: () => a.missions,
      activeMission: () => 1,
      levelFailed: () => false,
      playerDead: () => false,
      sound: () => {},
      setMission: () => {},
      leave: () => {},
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
    return { m, modes };
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
