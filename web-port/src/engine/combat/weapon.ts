/**
 * Weapon system (hitscan).
 *
 * Handles trigger input, cyclic rate, spread, ammo/reload, and applies hitscan
 * damage against ctx.enemies via a ray from the camera. Emits GameEvent.Fire /
 * Hit / EnemyKilled.
 */
import * as THREE from "three";
import { GameEvent } from "../events";
import type { Enemy, GameContext } from "../context";
import type { Vec3 } from "../../contracts";

export interface WeaponSystem {
  update(dt: number): void;
  /** Begin/queued reload; no-op when already full or reloading. */
  reload(): void;
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);

export function createWeaponSystem(ctx: GameContext): WeaponSystem {
  const raycaster = new THREE.Raycaster();
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();

  /** Resolve a raycast hit object back to its Enemy (walking the parent chain). */
  function enemyFromObject(obj: THREE.Object3D): Enemy | null {
    let current: THREE.Object3D | null = obj;
    while (current) {
      const id = (current.userData as { enemyId?: number }).enemyId;
      if (typeof id === "number") {
        return ctx.enemies.find((e) => e.id === id) ?? null;
      }
      current = current.parent;
    }
    return null;
  }

  /** Fire one round: spend ammo, set cyclic cooldown, hitscan from the camera. */
  function fire(): void {
    const w = ctx.weapon;
    if (!w) return;

    w.ammo -= 1;
    w.cooldownRemaining = 60 / w.spec.rpm;
    ctx.events.emit(GameEvent.Fire, { weaponId: w.spec.id });

    // Ray from the camera along its look direction.
    ctx.camera.getWorldPosition(origin);
    ctx.camera.getWorldDirection(dir);

    // Apply a random cone of fire of half-angle spreadDeg.
    const spreadRad = (w.spec.spreadDeg * Math.PI) / 180;
    right.crossVectors(dir, WORLD_UP);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    up.crossVectors(right, dir).normalize();
    const tan = Math.tan(spreadRad);
    dir
      .addScaledVector(right, (Math.random() * 2 - 1) * tan)
      .addScaledVector(up, (Math.random() * 2 - 1) * tan)
      .normalize();

    raycaster.set(origin, dir);
    raycaster.far = w.spec.range;
    raycaster.near = 0.1;

    const targets: THREE.Object3D[] = [];
    for (const e of ctx.enemies) {
      if (e.alive && e.object) targets.push(e.object);
    }

    ctx.systems.effects?.muzzleFlash(
      [origin.x, origin.y, origin.z],
      [dir.x, dir.y, dir.z],
    );

    if (targets.length === 0) return;
    const hits = raycaster.intersectObjects(targets, true);
    if (hits.length === 0) return;

    const hit = hits[0];
    const point: Vec3 = [hit.point.x, hit.point.y, hit.point.z];
    const enemy = enemyFromObject(hit.object);
    if (!enemy) return;

    ctx.events.emit(GameEvent.Hit, { damage: w.spec.damage, point });
    ctx.systems.effects?.impact(point);

    enemy.health -= w.spec.damage;
    enemy.state = "engage";
    if (enemy.health <= 0) {
      enemy.health = 0;
      enemy.alive = false;
      enemy.state = "dead";
      if (enemy.object) enemy.object.visible = false;
      ctx.events.emit(GameEvent.EnemyKilled, { enemyId: enemy.id });
    }
  }

  /** Start a reload if there is ammo to move and room in the magazine. */
  function reload(): void {
    const w = ctx.weapon;
    if (!w) return;
    if (w.reloading) return;
    if (w.ammo >= w.spec.magSize) return;
    if (w.reserve <= 0) return;
    w.reloading = true;
    w.reloadRemaining = w.spec.reloadSeconds;
    ctx.events.emit(GameEvent.ReloadStart, { weaponId: w.spec.id });
  }

  return {
    update(dt: number): void {
      const w = ctx.weapon;
      if (!w) return;

      // Cyclic-rate cooldown.
      if (w.cooldownRemaining > 0) {
        w.cooldownRemaining = Math.max(0, w.cooldownRemaining - dt);
      }
      // Reload timer -> refill from reserve when it elapses.
      if (w.reloading && w.reloadRemaining > 0) {
        w.reloadRemaining = Math.max(0, w.reloadRemaining - dt);
        if (w.reloadRemaining === 0) {
          w.reloading = false;
          const need = w.spec.magSize - w.ammo;
          const take = Math.min(need, w.reserve);
          w.ammo += take;
          w.reserve -= take;
          ctx.events.emit(GameEvent.ReloadEnd, { weaponId: w.spec.id });
        }
      }

      if (!ctx.running || !ctx.player.alive) return;
      if (!ctx.input.isFiring) return;
      if (w.reloading || w.cooldownRemaining > 0) return;

      if (w.ammo > 0) {
        fire();
      } else {
        // Empty magazine + trigger pulled: dry-fire and auto-reload.
        ctx.events.emit(GameEvent.DryFire);
        reload();
      }
    },
    reload,
  };
}
