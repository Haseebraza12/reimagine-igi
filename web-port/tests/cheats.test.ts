/**
 * Port cheats: the Cheats screen added to the original menu trees, its
 * toggles (Config_CheatGet / Config_CheatSet), and the stored settings.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { IgiTask } from "../src/loaders";
import { CHEAT_KEYS, allWeaponIds, noCheats, readCheats } from "../src/engine/cheats";
import { loadUiAssets } from "../src/engine/ui/assets";
import { CHEAT_MENU_TEXT, CHEAT_SCREEN_ID, injectCheatMenu } from "../src/engine/ui/cheat-menu";
import { MenuConfig } from "../src/engine/ui/menu-config";
import { MenuManager, type MenuEnvironment, type MenuItem } from "../src/engine/ui/menu-model";
import { RAW_ROOT, readRaw } from "./helpers";

const have = (...paths: string[]) => paths.every((p) => existsSync(`${RAW_ROOT}/${p}`));
const rawSource = { exists: async (p: string) => existsSync(`${RAW_ROOT}/${p}`), readBinary: (p: string) => readRaw(p) };
const args = (...v: Array<number | string>) => ({
  int: (i: number) => (typeof v[i] === "number" ? Math.trunc(v[i] as number) : 0),
  float: (i: number) => (typeof v[i] === "number" ? (v[i] as number) : 0),
  string: (i: number) => (typeof v[i] === "string" ? (v[i] as string) : ""),
});

const walk = (t: IgiTask, f: (t: IgiTask) => void): void => {
  f(t);
  t.children.forEach((c) => walk(c, f));
};
const findScreen = (tree: IgiTask[], id: number): IgiTask | null => {
  let out: IgiTask | null = null;
  for (const r of tree) walk(r, (t) => {
    if (!out && t.type === "MenuScreen" && t.id === id) out = t;
  });
  return out;
};
const listAround = (screen: IgiTask, key: string): string[] => {
  let names: string[] = [];
  walk(screen, (t) => {
    const keys = t.children.map((c) => String(c.params["Text Resource"] ?? ""));
    if (keys.includes(key)) names = keys;
  });
  return names;
};

describe("cheat state and MenuConfig", () => {
  it("all cheats are off by default and Config_CheatGet / Config_CheatSet address them in menu order", () => {
    const c = new MenuConfig();
    expect(c.cheats).toEqual(noCheats());
    expect(CHEAT_KEYS.map((_, i) => c.call("Config_CheatGet", args(i), () => {}))).toEqual([0, 0, 0, 0, 0]);
    const changes: string[] = [];
    c.onChange = (w) => changes.push(w);
    c.call("Config_CheatSet", args(0, 1), () => {});
    c.call("Config_CheatSet", args(3, 1), () => {});
    c.call("Config_CheatSet", args(3, 1), () => {}); // unchanged: no second notification
    expect(c.cheats).toMatchObject({ unlimitedAmmo: true, unlimitedHealth: false, oneShotKills: false, invisible: true, allWeapons: false });
    expect(changes).toEqual(["cheats", "cheats"]);
    expect(c.snapshot().cheats).toEqual(c.cheats);
    c.call("Config_CheatSet", args(9, 1), () => {}); // out of range: ignored
    expect(c.call("Config_CheatGet", args(9), () => {})).toBe(0);
  });

  it("cheats are saved with the settings; bad stored values are ignored", () => {
    const a = new MenuConfig();
    a.call("Config_CheatSet", args(1, 1), () => {});
    a.call("Config_CheatSet", args(4, 1), () => {});
    const b = new MenuConfig();
    expect(b.restore(JSON.parse(JSON.stringify(a.save())))).toBe(true);
    expect(b.cheats).toEqual({ ...noCheats(), unlimitedHealth: true, allWeapons: true });
    expect(readCheats({ unlimitedAmmo: "yes", invisible: true, extra: true })).toEqual({ ...noCheats(), invisible: true });
    expect(readCheats(null)).toEqual(noCheats());
    // Settings stored before the cheats existed restore with every cheat off.
    const old = a.save() as unknown as Record<string, unknown>;
    delete old.cheats;
    const c = new MenuConfig();
    expect(c.restore(old)).toBe(true);
    expect(c.cheats).toEqual(noCheats());
  });

  it("All Weapons gives the drawable weapons only (gun model loaded, stand clip), not the binoculars or knife", () => {
    const w = (scriptId: string, gunModel: string | null, weaponType: string, stand: number) => ({ scriptId, gunModel, weaponType, firstPersonAnims: { stand } });
    const ids = allWeaponIds(
      [
        w("WEAPON_ID_GLOCK", "117_01_1", "WEAPONTYPE_PISTOL", 14),
        w("WEAPON_ID_COLT", "101_01_1", "WEAPONTYPE_PISTOL", 35), // model not in the level
        w("WEAPON_ID_T80", "614_03_1", "WEAPONTYPE_GUN", -1), // no first-person clip
        w("WEAPON_ID_BINOCULARS", "102_01_1", "WEAPONTYPE_BINOCULAR", 68),
        w("WEAPON_ID_KNIFE", "133_01_1", "WEAPONTYPE_KNIFE", 26),
        w("WEAPON_ID_GRENADE", "135_01_1", "WEAPONTYPE_GRENADE", 22),
      ],
      (m) => m !== "101_01_1" && m !== "614_03_1",
    );
    expect(ids).toEqual(["WEAPON_ID_GLOCK", "WEAPON_ID_GRENADE"]);
  });
});

describe.skipIf(!have("menusystem/mainmenu.qvm", "menusystem/ingamemenu.qvm"))("Cheats screen in the original menus", () => {
  it("is added after Content Control (Configuration) and after Controls (Game Paused), once", async () => {
    const a = await loadUiAssets(rawSource);
    expect(injectCheatMenu(a.mainMenu, "main")).toBe(true);
    expect(injectCheatMenu(a.mainMenu, "main")).toBe(true); // idempotent
    expect(injectCheatMenu(a.ingameMenu, "ingame")).toBe(true);
    expect(listAround(findScreen(a.mainMenu, 904)!, "Cheats")).toEqual(["Graphics", "Sound", "Controls", "Language", "Content Control", "Cheats"]);
    expect(listAround(findScreen(a.ingameMenu, 900)!, "Cheats")).toEqual(["Resume Game", "Restart Game", "Sound", "Controls", "Cheats", "Quit to Main Menu"]);
    for (const tree of [a.mainMenu, a.ingameMenu]) {
      const screen = findScreen(tree, CHEAT_SCREEN_ID)!;
      const toggles: IgiTask[] = [];
      walk(screen, (t) => t.type === "ToggleBox" && toggles.push(t));
      expect(toggles.map((t) => t.id)).toEqual([980, 981, 982, 983, 984]);
      expect(toggles.map((t) => t.params["Set Data Script"])).toEqual(CHEAT_KEYS.map((_, i) => `Config_CheatSet(${i}, this.isOn)`));
      let screens = 0;
      for (const r of tree) walk(r, (t) => t.type === "MenuScreen" && t.id === CHEAT_SCREEN_ID && screens++);
      expect(screens).toBe(1);
    }
    for (const key of ["Cheats", "Unlimited Ammo", "Unlimited Health", "One Shot Kills", "Invisible To Enemies", "All Weapons"]) {
      expect(a.menuStrings.has(key.toLowerCase())).toBe(false); // not in the game's text: the port's table names it
      expect(CHEAT_MENU_TEXT.get(key.toLowerCase())).toBe(key);
    }
  });

  async function manager(main: boolean) {
    const a = await loadUiAssets(rawSource);
    injectCheatMenu(main ? a.mainMenu : a.ingameMenu, main ? "main" : "ingame");
    const archive = main ? a.main : a.ingame;
    const config = new MenuConfig();
    const changes: string[] = [];
    config.onChange = (w) => changes.push(w);
    const env: MenuEnvironment = {
      text: (k) => a.menuStrings.get(k.toLowerCase()) ?? CHEAT_MENU_TEXT.get(k.toLowerCase()) ?? `RM: ${k}`,
      measure: (f, t) => {
        const font = archive.fonts.get(f);
        return font ? { w: t.length * 9, h: font.lineHeight } : null;
      },
      picture: (n) => {
        const p = archive.pictures.get(n);
        return p ? { w: p.width, h: p.height } : null;
      },
      missions: () => [],
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
        const s = archive.sprites.get(n.toLowerCase());
        return s ? { w: s.width, h: s.height } : null;
      },
      font: (n) => archive.fonts.get(n.toLowerCase()) ?? null,
      heldKeys: () => new Set<string>(),
    };
    const m = new MenuManager(main ? a.mainMenu : a.ingameMenu, env, { ownDisplay: main, ticksPerSecond: main ? 60 : 30, startOpen: main });
    return { m, config, changes };
  }
  const run = (m: MenuManager, n: number) => {
    for (let i = 0; i < n; i++) m.tick();
  };
  const click = (m: MenuManager, x: number, y: number) => {
    m.pointerMove(x, y);
    m.pointerButton(true);
    run(m, 1);
    m.pointerButton(false);
    run(m, 2);
  };
  const find = (root: MenuItem | null, f: (i: MenuItem) => boolean): MenuItem[] => {
    const out: MenuItem[] = [];
    const w = (i: MenuItem) => {
      if (f(i)) out.push(i);
      i.children.forEach(w);
    };
    if (root) w(root);
    return out;
  };

  for (const main of [true, false]) {
    it(`${main ? "main" : "in-game"} menu: the toggles show the settings, OK commits them, Cancel does not`, async () => {
      const { m, config, changes } = await manager(main);
      config.cheats = { ...noCheats(), invisible: true };
      m.openScreen(CHEAT_SCREEN_ID);
      run(m, 40);
      expect(m.screen?.id).toBe(CHEAT_SCREEN_ID);
      const labels = find(m.screen, (i) => i.kind === "text").map((i) => i.text);
      expect(labels).toEqual(["Cheats", "Unlimited Ammo", "Unlimited Health", "One Shot Kills", "Invisible To Enemies", "All Weapons", "OK", "Cancel"]);
      expect(labels.some((t) => t.startsWith("RM:"))).toBe(false);
      const toggles = find(m.screen, (i) => i.widget?.kind === "toggle");
      expect(toggles.map((t) => (t.widget as { isOn: boolean }).isOn)).toEqual([false, false, false, true, false]);
      // Unlimited Ammo -> Yes (left half), Invisible -> No (right half); nothing applied yet.
      click(m, toggles[0].x + 4, toggles[0].y + 4);
      click(m, toggles[3].x + toggles[3].w - 4, toggles[3].y + 4);
      expect(toggles.map((t) => (t.widget as { isOn: boolean }).isOn)).toEqual([true, false, false, false, false]);
      expect(config.cheats).toEqual({ ...noCheats(), invisible: true });
      const ok = find(m.screen, (i) => i.textKey === "OK")[0];
      click(m, ok.x + 2, ok.y + 2);
      run(m, 40);
      expect(config.cheats).toEqual({ ...noCheats(), unlimitedAmmo: true });
      expect(changes.filter((c) => c === "cheats").length).toBe(2);
      // Again with Cancel: the toggle moves but the setting does not.
      m.openScreen(CHEAT_SCREEN_ID);
      run(m, 40);
      const t2 = find(m.screen, (i) => i.widget?.kind === "toggle");
      expect((t2[0].widget as { isOn: boolean }).isOn).toBe(true);
      click(m, t2[1].x + 4, t2[1].y + 4);
      const cancel = find(m.screen, (i) => i.textKey === "Cancel")[0];
      click(m, cancel.x + 2, cancel.y + 2);
      run(m, 40);
      expect(config.cheats).toEqual({ ...noCheats(), unlimitedAmmo: true });
    });
  }
});
