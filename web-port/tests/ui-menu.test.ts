/**
 * Menu system of src/engine/ui: the recovered LineUpMode layout
 * (FUN_00423a80), the MenuManager state machine (FUN_00416f70), selection,
 * scripts, the failure flow and the BackgroundFX geometry. Real menu files
 * are used when web-port/game-data is staged. Evidence: docs/hud.md section 8
 * and the decompiles listed in src/engine/ui/menu-model.ts.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { IgiTask } from "../src/loaders";
import { loadUiAssets, type UiAssets } from "../src/engine/ui/assets";
import { backgroundFxSegments } from "../src/engine/ui/bgfx";
import { submitMenu } from "../src/engine/ui/menu-draw";
import {
  buildMenuItem,
  layoutMenu,
  LINEUP,
  MENU_KEY,
  MENU_MODE,
  MenuManager,
  scriptStartsPlay,
  type MenuEnvironment,
  type MenuItem,
} from "../src/engine/ui/menu-model";
import { PrimList } from "../src/engine/ui/painter";
import { RAW_ROOT, readRaw } from "./helpers";

const have = (...paths: string[]) => paths.every((p) => existsSync(`${RAW_ROOT}/${p}`));
const rawSource = { exists: async (p: string) => existsSync(`${RAW_ROOT}/${p}`), readBinary: (p: string) => readRaw(p) };

function env(over: Partial<MenuEnvironment> = {}): MenuEnvironment & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    text: (k) => k,
    measure: (_f, t) => ({ w: t.length * 10, h: 20 }),
    picture: () => null,
    missions: () => [{ id: 1, name: "Trainyard", description: "Small coastline trainyard", sprite: "mission1.spr" }],
    activeMission: () => 1,
    levelFailed: () => false,
    playerDead: () => false,
    sound: (n) => log.push(`sound:${n}`),
    setMission: (id) => log.push(`mission:${id}`),
    leave: (m) => log.push(`leave:${m}`),
    setPaused: (p) => log.push(`paused:${p}`),
    opened: () => log.push("opened"),
    ...over,
  };
}

const task = (type: string, params: Record<string, unknown>, children: IgiTask[] = [], id = -1): IgiTask =>
  ({ id, type, name: "", params, children }) as IgiTask;
const frame = (x: number, y: number, w: number, h: number, mode: number, xs: number, ys: number, children: IgiTask[]) =>
  task("MenuFrame", { "Sprite Resource": "", "X-Pos": x, "Y-Pos": y, Width: w, Height: h, LineUpMode: mode, "X-Spacing": xs, "Y-Spacing": ys, "Is Selectable": false }, children);
const text = (label: string, script = "") =>
  task("MenuText", { "Text Resource": label, "Font Resource": "font3.fnt", ColourIndex: 2, "On Click Script": script, "Click Sound Resource": "" });

function laidOut(root: IgiTask, e = env()): MenuItem {
  const item = buildMenuItem(root, e);
  layoutMenu(item);
  return item;
}

describe("LineUpMode layout (FUN_00423a80 / FUN_004239f0)", () => {
  // Three 40x20 (4 chars x 10) children in a 200x100 frame at (100, 50), spacing 4.
  const kids = () => [text("aaaa"), text("bbbb"), text("cccc")];
  const pos = (mode: number) => laidOut(frame(100, 50, 200, 100, mode, 4, 4, kids())).children.map((c) => [c.x, c.y]);
  it("NONE centres children that have the centre flags", () => {
    expect(pos(LINEUP.NONE)).toEqual([[180, 90], [180, 90], [180, 90]]);
  });
  it("VERT_TOP stacks from y + spacing", () => {
    expect(pos(LINEUP.VERT_TOP)).toEqual([[180, 54], [180, 78], [180, 102]]);
  });
  it("VERT_CENTRE spaces evenly: (h - sumH) / (n + 1)", () => {
    expect(pos(LINEUP.VERT_CENTRE)).toEqual([[180, 60], [180, 90], [180, 120]]);
  });
  it("VERT_BOTTOM ends at y + h - spacing * n - sumH", () => {
    expect(pos(LINEUP.VERT_BOTTOM)).toEqual([[180, 78], [180, 102], [180, 126]]);
  });
  it("HOR_LEFT / HOR_CENTRE / HOR_RIGHT", () => {
    expect(pos(LINEUP.HOR_LEFT)).toEqual([[104, 90], [148, 90], [192, 90]]);
    expect(pos(LINEUP.HOR_CENTRE)).toEqual([[120, 90], [180, 90], [240, 90]]);
    expect(pos(LINEUP.HOR_RIGHT)).toEqual([[168, 90], [212, 90], [256, 90]]);
  });
  it("VERT_FILLOUT / HOR_FILLOUT spread between the spacing margins", () => {
    expect(pos(LINEUP.VERT_FILLOUT)).toEqual([[180, 54], [180, 90], [180, 126]]);
    expect(pos(LINEUP.HOR_FILLOUT)).toEqual([[104, 90], [180, 90], [256, 90]]);
  });
  it("divisions truncate toward zero, centring floors", () => {
    // One 20-high child in a 19-high VERT_CENTRE frame: (19 - 20) / 2 = 0.
    const item = laidOut(frame(0, 0, 41, 19, LINEUP.VERT_CENTRE, 4, 0, [text("ab")]));
    expect([item.children[0].x, item.children[0].y]).toEqual([10, 0]);
  });
});

describe("MenuManager (FUN_00416f70)", () => {
  const tree = (): IgiTask[] => [
    task("MenuManager", { "Current menuscreen": 900 }, [
      task("MenuScreen", { Background: "", "Frame x0": 85, "Frame y0": 80, "Frame x1": 555, "Frame y1": 410, "On Press Escape": "MenuManager_LeaveMenus(900, MENUMANAGER_IDLE)" }, [
        frame(100, 97, 440, 200, LINEUP.VERT_TOP, 4, 4, [
          task("MenuTextConditional", { "Text Resource": "Resume Game", "Font Resource": "font3.fnt", ColourIndex: 2, "isEnabled Expression": "!LevelFlow_LevelFailed()", "isVisible Expression": "TRUE", "On Click Script": "MenuManager_LeaveMenus(900, MENUMANAGER_IDLE)", "Click Sound Resource": "" }),
          text("Restart Game", "MenuManager_ActivatePopupScreen(932)\n"),
          text("Quit to Main Menu", "MenuManager_ActivatePopupScreen(931)\n"),
        ]),
      ], 900),
      task("DialogWindow", { "X-Pos": 220, "Y-Pos": 180, Width: 200, Height: 120, SwapKeys: true }, [
        frame(200, 200, 240, 100, LINEUP.HOR_CENTRE, 4, 4, [
          text("Yes", "MenuManager_LeaveMenus(900, MENUMANAGER_RESTARTLEVEL)"),
          text("No", "MenuManager_DeactivatePopuScreen()\n"),
        ]),
      ], 932),
      task("DialogWindow", { "X-Pos": 220, "Y-Pos": 180, Width: 200, Height: 120, SwapKeys: true }, [
        frame(200, 200, 240, 100, LINEUP.HOR_CENTRE, 4, 4, [text("Yes", "MenuManager_LeaveMenus(0, MENUMANAGER_QUITTOMAINMENU)")]),
      ], 931),
    ]),
  ];
  const run = (m: MenuManager, n: number) => {
    for (let i = 0; i < n; i++) m.tick();
  };

  it("idles in-game, opens 900 on Esc and pauses; fades in 8 steps of 2", () => {
    const e = env();
    const m = new MenuManager(tree(), e, { ownDisplay: false, ticksPerSecond: 30, startOpen: false });
    run(m, 3);
    expect(m.isOpen).toBe(false);
    m.idleKey("Escape");
    m.tick();
    expect(e.log).toContain("paused:true");
    m.tick(); // state 0 -> builds the screen, state 5
    expect(m.screen?.id).toBe(900);
    expect(m.state).toBe(5);
    run(m, 8);
    expect(m.fade).toBe(16);
    run(m, 2);
    expect(m.state).toBe(2);
    expect(m.selected?.text).toBe("Resume Game");
  });

  it("Resume leaves to idle after the fade-out and unpauses", () => {
    const e = env();
    const m = new MenuManager(tree(), e, { ownDisplay: false, ticksPerSecond: 30, startOpen: false });
    m.openScreen(900);
    run(m, 12);
    expect(scriptStartsPlay(m.selected!.clickScript)).toBe(true);
    expect(m.keyStartsPlay(MENU_KEY.RETURN)).toBe(true);
    m.key(MENU_KEY.RETURN);
    m.tick();
    expect(m.state).toBe(6);
    expect(e.log).toContain("sound:menu_sel");
    run(m, 10);
    expect(m.state).toBe(MENU_MODE.IDLE);
  });

  it("keyboard navigation wraps and plays menu_high", () => {
    const e = env();
    const m = new MenuManager(tree(), e, { ownDisplay: false, ticksPerSecond: 30, startOpen: false });
    m.openScreen(900);
    run(m, 12);
    m.key(MENU_KEY.UP);
    m.tick();
    expect(m.selected?.text).toBe("Quit to Main Menu");
    m.key(MENU_KEY.DOWN);
    m.tick();
    expect(m.selected?.text).toBe("Resume Game");
    expect(e.log.filter((l) => l === "sound:menu_high").length).toBe(2);
  });

  it("Restart -> dialog 932 -> Yes leaves with RESTARTLEVEL", () => {
    const e = env();
    const m = new MenuManager(tree(), e, { ownDisplay: false, ticksPerSecond: 30, startOpen: false });
    m.openScreen(900);
    run(m, 12);
    m.key(MENU_KEY.DOWN);
    m.key(MENU_KEY.RETURN);
    m.tick();
    expect(m.state).toBe(14);
    run(m, 12);
    expect(m.popup?.id).toBe(932);
    expect(m.state).toBe(2);
    // Dialog layout: HOR_CENTRE in (200, 200, 240, 100), vertically centred.
    const [yes, no] = m.popup!.children[0].children;
    expect(yes.y).toBe(240);
    expect(no.x - (yes.x + yes.w)).toBe(yes.x - 200);
    expect(m.selected?.text).toBe("Yes");
    m.key(MENU_KEY.RETURN);
    m.tick();
    run(m, 12);
    expect(e.log).toContain(`leave:${MENU_MODE.RESTARTLEVEL}`);
  });

  it("failed flow: opens after 151 ticks alive with Resume disabled; Resume cannot leave", () => {
    let failed = false;
    const e = env({ levelFailed: () => failed });
    const m = new MenuManager(tree(), e, { ownDisplay: false, ticksPerSecond: 30, startOpen: false });
    failed = true;
    run(m, 151);
    expect(m.state).toBe(MENU_MODE.IDLE);
    m.tick();
    expect(m.state).toBe(0);
    run(m, 12);
    const resume = m.screen!.children[0].children[0];
    expect(resume.enabled).toBe(false);
    expect(m.selected?.text).toBe("Restart Game");
    m.key(MENU_KEY.ESCAPE); // On Press Escape = LeaveMenus(900, IDLE): ignored while failed
    m.tick();
    expect(m.state).toBe(2);
  });

  it("failed flow when dead: Space opens the menu at once", () => {
    const e = env({ levelFailed: () => true, playerDead: () => true });
    const m = new MenuManager(tree(), e, { ownDisplay: false, ticksPerSecond: 30, startOpen: false });
    run(m, 200);
    expect(m.state).toBe(MENU_MODE.IDLE);
    m.idleKey("Space");
    m.tick();
    expect(m.state).toBe(0);
  });

  it("mouse: press and release inside an item clicks it; hover selects with menu_high", () => {
    const e = env();
    const m = new MenuManager(tree(), e, { ownDisplay: false, ticksPerSecond: 30, startOpen: false });
    m.pointerMove(0, 0);
    m.openScreen(900);
    run(m, 12);
    const quit = m.screen!.children[0].children[2];
    m.pointerMove(quit.x + 5, quit.y + 5);
    m.tick();
    expect(m.selected).toBe(quit);
    expect(e.log).toContain("sound:menu_high");
    m.pointerButton(true);
    m.tick();
    expect(m.releaseStartsPlay()).toBe(false);
    m.pointerButton(false);
    m.tick();
    expect(m.state).toBe(14); // ActivatePopupScreen(931)
  });
});

describe("BackgroundFX (FUN_0041c390)", () => {
  it("draws a 21+21 line grid, 10 lines and 3 circles", () => {
    const s = backgroundFxSegments(0);
    // t = 0: grid scale 1.5 at (200, 300); circle B r 100*1.3 -> trunc(130 * 0.31416) = 40 segments;
    // r 60*1.3 = 78 -> trunc(24.50) = 24 (chop-mode fistp at 0x41c1b5); circle C r 400 -> 40.
    expect(s.length % 4).toBe(0);
    const n = s.length / 4;
    expect(n).toBe(42 + 5 + 5 + 40 + 24 + 40);
    // First grid line starts at the rotated square's corner: (200 - 225, 300 - 225).
    expect(s[0]).toBeCloseTo(-25, 3);
    expect(s[1]).toBeCloseTo(75, 3);
  });
});

describe.skipIf(!have("menusystem/mainmenu.qvm", "menusystem/ingamemenu.qvm", "menusystem/menusystem.res", "language/english/menusystem.res"))(
  "menus from the original files",
  () => {
    let assets: UiAssets | null = null;
    const load = async () => (assets ??= await loadUiAssets(rawSource));
    const realEnv = (a: UiAssets, archive: UiAssets["main"], over: Partial<MenuEnvironment> = {}) =>
      env({
        text: (k) => a.menuStrings.get(k.toLowerCase()) ?? `RM: ${k}`,
        measure: (f, t) => {
          const font = archive.fonts.get(f);
          if (!font) return null;
          let pen = 0;
          let last = 0;
          for (const ch of t) {
            const g = font.charMap[ch.charCodeAt(0)];
            pen += g ? font.glyphs[g - 1].advance : font.spaceAdvance;
            if (g) last = pen;
          }
          return { w: last, h: font.lineHeight };
        },
        picture: (n) => {
          const p = archive.pictures.get(n);
          return p ? { w: p.width, h: p.height } : null;
        },
        missions: () => a.missions,
        ...over,
      });

    it("in-game 900: title at y 79, items from y 101 every 25 px, centred in x", async () => {
      const a = await load();
      const m = new MenuManager(a.ingameMenu, realEnv(a, a.ingame), { ownDisplay: false, ticksPerSecond: 30, startOpen: false });
      m.openScreen(900);
      m.tick();
      const [titleFrame, items] = m.screen!.children;
      const title = titleFrame.children[0];
      expect(title.text).toBe("Game Paused");
      expect(title.y).toBe(79);
      expect(title.x).toBe(100 + ((440 - title.w) >> 1));
      expect(items.children.map((c) => c.text)).toEqual(["Resume Game", "Restart Mission", "Sound", "Controls", "Quit to Main Menu"]);
      expect(items.children.map((c) => c.y)).toEqual([101, 126, 151, 176, 201]);
    });

    it("main 900 and Select Mission 914 layouts", async () => {
      const a = await load();
      const m = new MenuManager(a.mainMenu, realEnv(a, a.main), { ownDisplay: true, ticksPerSecond: 60, startOpen: true });
      m.tick();
      const s = m.screen!;
      expect([s.w, s.h]).toEqual([640, 480]);
      expect(s.children[1].children.map((c) => [c.text, c.y])).toEqual([
        ["Play Project IGI", 189],
        ["Configuration", 214],
        ["Select Player", 239],
        ["Quit", 264],
      ]);
      expect(s.children[2].children.map((c) => [c.text, c.y])).toEqual([
        ["Read Me", 433],
        ["Credits", 449],
      ]);
      // Single Player -> 914.
      for (let i = 0; i < 24; i++) m.tick();
      m.key(MENU_KEY.RETURN);
      for (let i = 0; i < 40; i++) m.tick();
      expect(m.screen!.id).toBe(914);
      const level = m.screen!.children[1];
      const [left, list] = level.children;
      const [picture, box] = left.children;
      expect([picture.x, picture.y, box.x, box.y, list.x, list.y]).toEqual([140, 210, 140, 350, 330, 210]);
      expect(list.entries).toEqual([{ id: 1, text: "Trainyard" }]);
      expect(list.rowHeight).toBe(16);
      const ok = m.screen!.children[2].children[0];
      expect([ok.text, ok.y]).toEqual(["OK", 404]);
      // The OK script starts the game with the list's active mission.
      expect(m.selected).toBe(ok);
      m.key(MENU_KEY.RETURN);
      for (let i = 0; i < 40; i++) m.tick();
      expect((m as unknown as { env: { log: string[] } }).env.log).toEqual(expect.arrayContaining(["mission:1", `leave:${MENU_MODE.STARTGAME}`]));
    });

    it("draw order: pointer, then the screen (children, frame, logo, background)", async () => {
      const a = await load();
      const m = new MenuManager(a.mainMenu, realEnv(a, a.main), { ownDisplay: true, ticksPerSecond: 60, startOpen: true });
      for (let i = 0; i < 30; i++) m.tick();
      const list = new PrimList();
      submitMenu(m, { archive: a.main, missionSprites: a.missionSprites, usa: false, bgfx: null }, list);
      expect(list.labels[0]).toBe("sprite"); // pointer
      expect(list.labels[list.labels.length - 1]).toBe("image"); // mainmenu.pic, drawn first
      expect(list.labels[list.labels.length - 2]).toBe("image"); // logo.pic
      expect(list.labels).toContain("text:Play Project IGI");
    });
  },
);
