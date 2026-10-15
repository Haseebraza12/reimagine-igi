/**
 * Weapon and ammo pickups (GunPickup / AmmoPickup), as igi.exe handles them
 * (docs/interactions.md §6). IGI space inside (units, z up); the public API
 * takes engine positions where it meets the rest of the engine.
 *
 * Recovered:
 *   - Pickups are walked over, never "used": each player tick, while the
 *     player is alive (+0xcf5 == 0), FUN_00410f10 calls method 0x429 of
 *     every object in the pickup list (DAT_00577b64, capacity 256) with the
 *     player's position (the pelvis, +0x20).
 *   - Touch test (GunPickup FUN_0046bdb0, AmmoPickup FUN_0046c510): r = the
 *     model's origin radius x max scale, at least 2867.2 units (0.7 m,
 *     0x531440); collected when the HORIZONTAL distance (z of the vector set
 *     to 0) is below r and |dz| < 4096 (1 m, 0x531498).
 *   - GunPickup: the "ID" weapon; its rounds (+0x150) are the weapon's
 *     WeaponConfig Rounds/Clip (compile FUN_0046bbd0: weapon def +0x648);
 *     the model is the weapon def's +0x61c model [inferred: "Gun Model"].
 *     AmmoPickup: "ID" ammo type and "Ammo" rounds (int16 +0x130); model =
 *     DefineAmmoType's model (FUN_0046c350, ammo def +0x148).
 *   - Collect (the human's methods FUN_0045ec30 / FUN_0045ebf0): a weapon
 *     already carried adds the rounds to that gun's ammo pool; a new weapon
 *     is added with the rounds (FUN_00476370(human, 0, id, rounds, 1)); an
 *     ammo pickup adds to its pool. Pools: FUN_0047b4c0, count += amount,
 *     clamped to [0, cap] when the pool has a cap (DefineHumanPlayerAmmoLimit).
 *     Sound "weaponpickup_1" (2-D, FUN_004dddc0) for both. Radio-style
 *     message "PICKEDUPWEAPON<Name>" / "PICKEDUPAMMO" + ammo.spr
 *     (FUN_00483920, docs/hud.md). The pickup deletes itself on its next
 *     tick (+0x129 / +0x109 -> FUN_00401630).
 *   - Soldiers drop their weapon in hand when they die (death states
 *     FUN_004534d0, FUN_00458500, FUN_004585b0 -> FUN_004e9010 -> the Gun's
 *     drop method 0x478340): if the pickup list has room, FUN_0046b500
 *     creates a GunPickup at the gun's position with the gun's rotation
 *     reduced to (alpha 0, beta +pi/2, gamma kept) [the alpha test compares
 *     radians with -90/90 degrees, so alpha is always 0]; a ray from 2048
 *     units above to 204800 units below finds the rest height (hit +
 *     409.6, or the drop height when nothing is hit).
 *   - Drop fall (GunPickup tick FUN_0046ba20): below the rest height ->
 *     z = rest, v x -0.5 and weapondrop_01 (level RNG > 0.5) or _02 at the
 *     pickup; at or below rest with |v| < 409.6 -> v = 0 (at rest); else
 *     z -= v, v += 44.600889 units/tick^2.
 */
import type { Vec3 } from "../../contracts";
import type { IgiLevel, IgiTask } from "../../loaders";
import { vec3Param, numberParam, stringParam } from "../../loaders/tasks";
import type { GameContext } from "../context";
import { GameEvent } from "../events";
import { TRI_SOLID } from "../world/collision";

const UNITS = 4096;
/** Minimum touch radius 2867.2 units (0x531440) [recovered]. */
export const PICKUP_MIN_RADIUS = 2867.2;
/** Touch height window |dz| < 4096 (0x531498) [recovered]. */
export const PICKUP_HEIGHT_WINDOW = 4096;
/** Pickup list capacity (FUN_004b7a30(0x100) -> DAT_00577b64) [recovered]. */
export const PICKUP_LIST_CAPACITY = 256;
/** Drop fall: gravity 44.600889 units/tick^2 (f64 0x531a68), bounce x -0.5 (0x531a70), rest below |v| 409.6 (0x531418) [recovered]. */
export const DROP_GRAVITY = 44.60088888888889;
export const DROP_BOUNCE = -0.5;
export const DROP_REST_SPEED = 409.6;
/** Drop rest ray: from +2048 (0x531460) to -204800 (0x531a58) units; rest = hit + 409.6 (0x531418) [recovered]. */
export const DROP_RAY_UP = 2048;
export const DROP_RAY_DOWN = 204800;
export const DROP_REST_LIFT = 409.6;

export interface Pickup {
  kind: "weapon" | "ammo";
  /** WEAPON_ID_* or AMMO_ID_*. */
  id: string;
  /** Rounds granted. */
  rounds: number;
  /** IGI position (+0xf0) and rest height (+0x118). */
  position: Vec3;
  rest: number;
  /** Fall speed (+0x120), units per tick, positive downwards. */
  speed: number;
  /** Rotation, row-major (IGI), for drawing. */
  rotation: number[];
  /** Model to draw ("Gun Model" / ammo model), when known. */
  model: string | null;
  /** Touch radius (units). */
  radius: number;
  /** Mission node index of a placed pickup, -1 for a dropped one. */
  nodeIndex: number;
  /** Collected (+0x129 / +0x109): removed on the next update. */
  taken: boolean;
}

/** What collecting needs from the weapon system (hooks; see docs/interactions.md). */
export interface PickupInventory {
  /** The player carries this weapon (FUN_0045ec30's inventory walk). */
  hasWeapon(weaponId: string): boolean;
  /** Add rounds to the ammo pool of a carried weapon's gun (FUN_0047b4c0 with the gun's ammo type). */
  addWeaponAmmo(weaponId: string, rounds: number): void;
  /** Add rounds to an ammo pool (FUN_0047b4c0). */
  addAmmo(ammoId: string, rounds: number): void;
  /** Give a new weapon with its rounds (FUN_00476370(human, 0, id, rounds, 1)). */
  addWeapon(weaponId: string, rounds: number): void;
}

/** FUN_0047b4c0: count + amount, clamped to [0, cap] when cap != -1 [recovered]. */
export function addCappedAmmo(count: number, amount: number, cap: number | undefined): number {
  let next = count + amount;
  if (cap !== undefined && cap !== -1) {
    if (next < 0) next = 0;
    else if (cap < next) next = cap;
  }
  return next;
}

/** Touch test (FUN_0046bdb0 / FUN_0046c510) [recovered]: horizontal distance < r and |dz| < 4096. */
export function pickupTouched(pickup: { position: readonly number[]; radius: number }, pelvis: readonly number[]): boolean {
  const dx = pickup.position[0] - pelvis[0];
  const dy = pickup.position[1] - pelvis[1];
  const dz = Math.abs(pickup.position[2] - pelvis[2]);
  return Math.hypot(dx, dy) < pickup.radius && dz < PICKUP_HEIGHT_WINDOW;
}

/** Touch radius: model origin radius (scale 1), at least 2867.2 [recovered]. */
export function pickupRadius(modelRadius: number | null | undefined): number {
  const r = modelRadius ?? 0;
  return r < PICKUP_MIN_RADIUS ? PICKUP_MIN_RADIUS : r;
}

/** One drop-fall tick (FUN_0046ba20) [recovered]; `onBounce` plays the drop sound. */
export function dropFallStep(p: { position: Vec3; rest: number; speed: number }, onBounce: () => void): void {
  if (p.position[2] < p.rest) {
    p.speed *= DROP_BOUNCE;
    p.position[2] = p.rest;
    onBounce();
  }
  if (p.position[2] <= p.rest && Math.abs(p.speed) < DROP_REST_SPEED) {
    p.speed = 0;
    return;
  }
  p.position[2] -= p.speed;
  p.speed += DROP_GRAVITY;
}

/** FUN_004a9bc0(alpha, beta, gamma) = Rz(gamma) Ry(beta) Rx(alpha), row-major. */
function euler(alpha: number, beta: number, gamma: number): number[] {
  const [ca, sa, cb, sb, cg, sg] = [Math.cos(alpha), Math.sin(alpha), Math.cos(beta), Math.sin(beta), Math.cos(gamma), Math.sin(gamma)];
  return [
    cg * cb, cg * sb * sa - sg * ca, cg * sb * ca + sg * sa,
    sg * cb, sg * sb * sa + cg * ca, sg * sb * ca - cg * sa,
    -sb, cb * sa, cb * ca,
  ];
}

export interface PickupSystemOptions {
  /** Model origin radius by model name (from the model archives), when loaded. */
  modelRadius?: (model: string) => number | null;
  /** Inventory hooks; defaults to the weapon system when it implements PickupInventory. */
  inventory?: () => Partial<PickupInventory> | null;
}

export interface PickupSystem {
  readonly items: readonly Pickup[];
  /** Rebuild the placed pickups of the level (mission start / restart). */
  reset(): void;
  /**
   * One player tick (FUN_00410f10 + the pickups' own ticks): collect what the
   * player (pelvis, engine metres) touches while alive, advance dropped guns,
   * remove taken pickups and pickups whose container left the world.
   */
  update(pelvis: Vec3 | null): void;
  /** A soldier died holding `weaponId`: drop it at `gunPosition` (engine) with heading `yaw` (FUN_0046b500). */
  drop(weaponId: string, gunPosition: Vec3, yaw: number): Pickup | null;
  /** The pickup is in the world (no enclosing ConditionalContainer has left it): touched and drawn only then. */
  inWorld(p: Pickup): boolean;
  /** Detach the EnemyKilled listener. */
  dispose(): void;
}

export function createPickupSystem(ctx: GameContext, options: PickupSystemOptions = {}): PickupSystem {
  let items: Pickup[] = [];
  const origin = (): Vec3 => ctx.level?.originIgi ?? [0, 0, 0];
  const toIgi = (e: readonly number[]): Vec3 => {
    const o = origin();
    return [e[0] * UNITS + o[0], -e[2] * UNITS + o[1], e[1] * UNITS + o[2]];
  };
  const toEngine = (p: readonly number[]): Vec3 => {
    const o = origin();
    return [(p[0] - o[0]) / UNITS, (p[2] - o[2]) / UNITS, -(p[1] - o[1]) / UNITS];
  };
  const radiusOf = (model: string | null): number => pickupRadius(model ? options.modelRadius?.(model) : null);
  const inventory = (): Partial<PickupInventory> | null =>
    options.inventory ? options.inventory() : ((ctx.systems.weapon as unknown as Partial<PickupInventory> | null) ?? null);

  type Runtime = { tasks: { nodes: Array<{ index: number; type: string; parent: number; task: IgiTask }> }; nodeState(i: number): Readonly<Record<string, unknown>> };
  const runtime = (): Runtime | null => (ctx.systems.tasks as unknown as { runtime?: Runtime | null } | null)?.runtime ?? null;
  /** No enclosing ConditionalContainer has left the world (FUN_00485410 inWorld). */
  const nodeInWorld = (index: number): boolean => {
    const rt = runtime();
    if (!rt || index < 0) return true;
    for (let n = rt.tasks.nodes[index]?.parent ?? -1; n >= 0; n = rt.tasks.nodes[n].parent) {
      const node = rt.tasks.nodes[n];
      if (node.type === "ConditionalContainer" && rt.nodeState(n).inWorld === 0) return false;
    }
    return true;
  };

  function placed(level: IgiLevel): Pickup[] {
    const out: Pickup[] = [];
    level.tasks.forEach((task, index) => {
      if (task.type !== "GunPickup" && task.type !== "AmmoPickup") return;
      const position = vec3Param(task, "Position");
      const id = stringParam(task, "ID");
      if (!position || !id) return;
      const angles = vec3Param(task, "Orientation") ?? [0, 0, 0];
      if (task.type === "GunPickup") {
        const weapon = level.weapons.get(id);
        const model = weapon?.gunModel ?? null;
        out.push({
          kind: "weapon", id, rounds: weapon?.roundsPerClip ?? 0, position: [...position] as Vec3, rest: position[2], speed: 0,
          rotation: euler(angles[0], angles[1], angles[2]), model, radius: radiusOf(model), nodeIndex: index, taken: false,
        });
      } else {
        // DefineAmmoType arg 13 (ammo def +0x148, FUN_0046c350); "" (.50 cal) = no model.
        const model = level.ammoTypes?.get(id)?.model || null;
        out.push({
          kind: "ammo", id, rounds: numberParam(task, "Ammo") ?? 0, position: [...position] as Vec3, rest: position[2], speed: 0,
          rotation: euler(angles[0], angles[1], angles[2]), model, radius: radiusOf(model), nodeIndex: index, taken: false,
        });
      }
    });
    return out;
  }

  function collect(p: Pickup): void {
    p.taken = true;
    const inv = inventory();
    if (p.kind === "weapon") {
      if (inv?.hasWeapon?.(p.id)) inv.addWeaponAmmo?.(p.id, p.rounds);
      else inv?.addWeapon?.(p.id, p.rounds);
    } else {
      inv?.addAmmo?.(p.id, p.rounds);
    }
    // HUD message + weaponpickup_1 (both listen to GameEvent.Pickup).
    ctx.events.emit(GameEvent.Pickup, { kind: p.kind, name: p.id, rounds: p.rounds, position: toEngine(p.position) });
  }

  function update(pelvis: Vec3 | null): void {
    const at = pelvis ? toIgi(pelvis) : null;
    for (const p of items) {
      if (p.taken || !nodeInWorld(p.nodeIndex)) continue;
      // The model may load after the pickup was created: the radius follows it.
      p.radius = radiusOf(p.model);
      if (at && ctx.player.alive && pickupTouched(p, at)) collect(p);
    }
    for (const p of items) {
      if (p.taken || p.nodeIndex >= 0) continue;
      dropFallStep(p, () => {
        const name = ctx.rng.float() <= 0.5 ? "weapondrop_02" : "weapondrop_01";
        const audio = ctx.systems.audio as unknown as { playAt?(n: string, pos: Vec3): unknown } | null;
        audio?.playAt?.(name, toEngine(p.position));
      });
    }
    items = items.filter((p) => !p.taken);
  }

  function drop(weaponId: string, gunPosition: Vec3, yaw: number): Pickup | null {
    if (items.length >= PICKUP_LIST_CAPACITY) return null;
    const level = ctx.level;
    const weapon = level?.weapons.get(weaponId);
    const position = toIgi(gunPosition);
    let gamma = yaw % (2 * Math.PI);
    if (gamma < 0) gamma += 2 * Math.PI;
    let rest = position[2];
    if (ctx.world) {
      // FUN_004c24c0: segment from z + 2048 down to z - 204800 against the human collision set [set inferred].
      const top: Vec3 = [gunPosition[0], gunPosition[1] + DROP_RAY_UP / UNITS, gunPosition[2]];
      const hit = ctx.world.raycast(top[0], top[1], top[2], 0, -1, 0, (DROP_RAY_UP + DROP_RAY_DOWN) / UNITS, TRI_SOLID);
      if (hit) rest = toIgi(hit.point)[2] + DROP_REST_LIFT;
    }
    const model = weapon?.gunModel ?? null;
    const p: Pickup = {
      kind: "weapon", id: weaponId, rounds: weapon?.roundsPerClip ?? 0, position, rest, speed: 0,
      rotation: euler(0, Math.PI / 2, gamma), model, radius: radiusOf(model), nodeIndex: -1, taken: false,
    };
    items.push(p);
    return p;
  }

  const off = ctx.events.on(GameEvent.EnemyKilled, (payload) => {
    const k = payload as { enemyId?: number; position?: Vec3; gunPosition?: Vec3; weaponId?: string; yaw?: number } | undefined;
    if (!k) return;
    const enemy = ctx.enemies.find((e) => e.id === k.enemyId);
    const weaponId = k.weaponId ?? enemy?.weapon?.scriptId;
    if (!weaponId) return;
    // The gun's own world position is enemy.ts's (hook); without it the pickup starts 1 m above the feet [inferred].
    const feet = k.position ?? enemy?.position;
    const gun = k.gunPosition ?? (feet ? ([feet[0], feet[1] + 1, feet[2]] as Vec3) : null);
    if (!gun) return;
    drop(weaponId, gun, k.yaw ?? enemy?.yaw ?? 0);
  });

  return {
    get items() {
      return items;
    },
    reset() {
      items = ctx.level ? placed(ctx.level) : [];
    },
    update,
    drop,
    inWorld: (p) => nodeInWorld(p.nodeIndex),
    dispose() {
      off();
    },
  };
}
