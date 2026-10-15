/**
 * Port cheats (Configuration → Cheats, and the pause menu's Cheats). They are
 * not part of igi.exe's menus; all are off by default and are kept with the
 * menu settings in the browser.
 *
 * igi.exe has one hidden cheat of its own: the command-line switch
 * "UnlimitedAmmo" (FUN_0040ff30 registers it with FUN_0048d710, which scans
 * the command line; its handler LAB_00410450 sets DAT_0056a384) [recovered].
 * With it the clip still empties as you fire, but every reload refills the
 * clip without using the reserve and is allowed with an empty reserve
 * (0x40ee6d; the gun reload method FUN_00477fe0 with the flag), a thrown
 * grenade is replaced (0x40f840 / 0x40faf4, FUN_004e8fd0 with the flag) and
 * the M203 fires without M203 rounds (0x40edc5). The port's Unlimited Ammo is
 * stricter, as asked for: firing does not use rounds at all, and its reloads
 * follow the exe's flag (free, also with an empty reserve).
 */

export interface CheatState {
  /** Firing, throwing and medipacks use nothing; reloads are free (igi.exe's UnlimitedAmmo rule). */
  unlimitedAmmo: boolean;
  /** The player takes no damage (health stays where it is; falling out of the world still ends the game). */
  unlimitedHealth: boolean;
  /** The player's bullets and knife kill any soldier in one hit (soldiers the mission makes invulnerable excepted). */
  oneShotKills: boolean;
  /** Soldiers and security cameras do not see the player, and soldiers do not hear the player's noises. */
  invisible: boolean;
  /** Every weapon the level can draw, with full ammo, at each mission start (and at once when switched on in a mission). */
  allWeapons: boolean;
}

export type CheatKey = keyof CheatState;

/** Menu order (Config_CheatGet / Config_CheatSet index). */
export const CHEAT_KEYS: readonly CheatKey[] = ["unlimitedAmmo", "unlimitedHealth", "oneShotKills", "invisible", "allWeapons"];

/** Row labels in the Cheats screen (menu text keys; the menu font draws them). */
export const CHEAT_LABELS: Readonly<Record<CheatKey, string>> = {
  unlimitedAmmo: "Unlimited Ammo",
  unlimitedHealth: "Unlimited Health",
  oneShotKills: "One Shot Kills",
  invisible: "Invisible To Enemies",
  allWeapons: "All Weapons",
};

export function noCheats(): CheatState {
  return { unlimitedAmmo: false, unlimitedHealth: false, oneShotKills: false, invisible: false, allWeapons: false };
}

/** A copy with only known boolean keys taken from `data` (stored settings), the rest off. */
export function readCheats(data: unknown): CheatState {
  const out = noCheats();
  if (data && typeof data === "object") {
    for (const key of CHEAT_KEYS) {
      const v = (data as Record<string, unknown>)[key];
      if (typeof v === "boolean") out[key] = v;
    }
  }
  return out;
}

/**
 * The weapons "All Weapons" hands out: those the level can draw in first person (gun model in the
 * level's archives, a stand animation), the binoculars and knife aside (the player starts with them).
 */
export function allWeaponIds(
  weapons: Iterable<{ scriptId: string; gunModel: string | null; weaponType: string | null; firstPersonAnims: { stand: number } | null }>,
  hasModel: (name: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const w of weapons) {
    if (!w.gunModel || !hasModel(w.gunModel)) continue;
    if ((w.firstPersonAnims?.stand ?? -1) < 0) continue;
    if (w.weaponType === "WEAPONTYPE_BINOCULAR" || w.weaponType === "WEAPONTYPE_KNIFE") continue;
    out.push(w.scriptId);
  }
  return out;
}
