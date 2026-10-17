/**
 * Start screen for a static host (Vercel): the player opens the folder of
 * their own Project I.G.I. installation; the game then reads its files from
 * the player's disk (loaders/local-source.ts). Nothing is uploaded.
 *
 * Chromium browsers use the File System Access API and remember the folder
 * (its handle is kept in IndexedDB; the browser asks again for permission
 * after a restart). Other browsers use <input webkitdirectory>, picked again
 * on every visit.
 */
import type { IAssetSource } from "../../contracts";
import { createLocalAssetSource, findInstallRoot, type LocalFile } from "../../loaders/local-source";

type DirHandle = {
  kind: "directory";
  name: string;
  values(): AsyncIterable<DirHandle | FileHandle>;
  queryPermission?(o: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(o: { mode: "read" }): Promise<PermissionState>;
};
type FileHandle = { kind: "file"; name: string; getFile(): Promise<File> };
type PickerWindow = Window & { showDirectoryPicker?: (o?: { id?: string; mode?: "read" }) => Promise<DirHandle> };

const DB = "igi-port";
const STORE = "handles";
const KEY = "game-folder";

function idb<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onerror = () => resolve(undefined);
      open.onsuccess = () => {
        try {
          const tx = open.result.transaction(STORE, mode);
          const req = run(tx.objectStore(STORE));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      };
    } catch {
      resolve(undefined);
    }
  });
}

async function walk(dir: DirHandle, prefix: string, out: LocalFile[]): Promise<void> {
  for await (const entry of dir.values()) {
    const path = prefix + entry.name;
    if (entry.kind === "directory") await walk(entry, `${path}/`, out);
    else {
      const h = entry;
      out.push({ path, read: async () => (await h.getFile()).arrayBuffer() });
    }
  }
}

const CSS = `
#igi-folder{position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:#000;
  font-family:"Courier New",monospace;color:#cfe8cf;padding:16px;box-sizing:border-box;overflow:auto}
#igi-folder .panel{max-width:620px;width:100%;border:2px solid #2fd12f;background:linear-gradient(#0d2a0d,#061206);
  box-shadow:0 0 24px rgba(47,209,47,.25);padding:28px 32px;box-sizing:border-box}
#igi-folder h1{margin:0;text-align:center;font-size:34px;letter-spacing:10px;color:#e8f4e8;text-shadow:0 0 8px #2fd12f}
#igi-folder h2{margin:4px 0 22px;text-align:center;font-size:15px;font-weight:normal;color:#e0b030;letter-spacing:2px}
#igi-folder p{margin:0 0 14px;line-height:1.55;font-size:15px}
#igi-folder .buttons{display:flex;flex-wrap:wrap;gap:12px;justify-content:center;margin:22px 0 12px}
#igi-folder button{font:inherit;font-size:17px;letter-spacing:2px;color:#7dff7d;background:#0a1f0a;border:1px solid #2fd12f;
  padding:10px 22px;cursor:pointer}
#igi-folder button:hover{background:#143814;color:#fff}
#igi-folder .status{min-height:22px;text-align:center;color:#e0b030;font-size:14px}
#igi-folder .status.error{color:#ff6b6b}
#igi-folder small{display:block;margin-top:18px;color:#8aa88a;font-size:12px;line-height:1.5;text-align:center}
`;

/** Show the start screen until the player opened a folder that holds an installation. */
export function pickGameFolder(): Promise<IAssetSource> {
  return new Promise((resolve) => {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    const root = document.createElement("div");
    root.id = "igi-folder";
    root.innerHTML = `
      <div class="panel">
        <h1>PROJECT I.G.I.</h1>
        <h2>WEB PORT &middot; A HOBBY PROJECT BY HASEEB UR REHMAN</h2>
        <p>This is the game's engine, rebuilt for the browser. The game itself (its levels, models, sounds and
        menus) comes from your own copy of <b>Project I.G.I.: I'm Going In</b>.</p>
        <p>Open the folder where the game is installed (the one with the <b>missions</b> and <b>menusystem</b>
        folders). The files are read on your computer; nothing is uploaded.</p>
        <div class="buttons"></div>
        <div class="status"></div>
        <small>Project I.G.I. and all of its content belong to their copyright owners (Innerloop Studios,
        Eidos Interactive and their successors). This site does not include or distribute any game files.</small>
      </div>`;
    document.body.appendChild(root);
    const buttons = root.querySelector(".buttons") as HTMLDivElement;
    const status = root.querySelector(".status") as HTMLDivElement;
    const say = (text: string, error = false) => {
      status.textContent = text;
      status.classList.toggle("error", error);
    };
    const button = (label: string, onClick: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.addEventListener("click", onClick);
      buttons.appendChild(b);
      return b;
    };

    const accept = (files: LocalFile[]): boolean => {
      const installRoot = findInstallRoot(files.map((f) => f.path));
      if (installRoot === null) {
        say("That folder is not a Project I.G.I. installation (no menusystem/mainmenu.qvm). Please pick the game folder.", true);
        return false;
      }
      const source = createLocalAssetSource(files, installRoot);
      root.remove();
      style.remove();
      resolve(source);
      return true;
    };

    const fromHandle = async (dir: DirHandle) => {
      say("Reading the game folder...");
      const files: LocalFile[] = [];
      await walk(dir, "", files);
      if (accept(files)) void idb("readwrite", (s) => s.put(dir, KEY));
    };

    const w = window as PickerWindow;
    if (typeof w.showDirectoryPicker === "function") {
      void idb<DirHandle>("readonly", (s) => s.get(KEY) as IDBRequest<DirHandle>).then((saved) => {
        if (!saved) return;
        const again = button(`Continue: ${saved.name}`, async () => {
          try {
            const state = (await saved.queryPermission?.({ mode: "read" })) ?? "granted";
            if (state !== "granted" && (await saved.requestPermission?.({ mode: "read" })) !== "granted") {
              say("Permission to read the folder was not given.", true);
              return;
            }
            await fromHandle(saved);
          } catch (error) {
            say(`Could not open the saved folder: ${(error as Error).message}`, true);
          }
        });
        buttons.prepend(again);
      });
      button("Open game folder", async () => {
        try {
          await fromHandle(await w.showDirectoryPicker!({ id: "igi-game", mode: "read" }));
        } catch (error) {
          if ((error as Error).name !== "AbortError") say(`Could not open the folder: ${(error as Error).message}`, true);
        }
      });
    } else {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
      input.style.display = "none";
      root.appendChild(input);
      input.addEventListener("change", () => {
        const list = Array.from(input.files ?? []);
        say("Reading the game folder...");
        // webkitRelativePath = "<picked folder>/<path>": the root search finds the installation inside.
        accept(list.map((f) => ({ path: f.webkitRelativePath || f.name, read: () => f.arrayBuffer() })));
      });
      button("Open game folder", () => input.click());
    }
  });
}
