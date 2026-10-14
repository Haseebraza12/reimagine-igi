/**
 * Enemy + AI manager.
 *
 * Owns the enemy prototypes/capsules, spawns a small garrison for the slice,
 * and runs a simple perception -> patrol/engage state machine using the level
 * navigation graph (ctx.nav) and terrain height.
 */
import * as THREE from "three";
import { GameEvent } from "../events";
import type { Enemy, GameContext } from "../context";
import type { Vec3 } from "../../contracts";

const ENEMY_MAX_HEALTH = 100;
const CAPSULE_RADIUS = 0.35;
const CAPSULE_LENGTH = 1.0;
/** Distance from the capsule centre to its base (length/2 + radius). */
const CAPSULE_HALF_HEIGHT = CAPSULE_LENGTH / 2 + CAPSULE_RADIUS;

const SEE_RANGE = 40;
/** cos of half the ~110deg vision cone. */
const SEE_HALF_ANGLE_COS = Math.cos((110 / 2) * (Math.PI / 180));
const ENGAGE_RANGE = 25;
/** "Roughly facing" tolerance when shooting (degrees). */
const FACE_COS = Math.cos((35 * Math.PI) / 180);
/** Reaction delay between spotting the player (alert) and engaging. */
const REACTION_SECONDS = 0.5;
/** Seconds between enemy shots. */
const FIRE_INTERVAL = 0.8;
const ENEMY_DAMAGE = 8;
const PATROL_SPEED = 1.3;

/** Per-enemy transient AI timers (kept off the frozen Enemy interface). */
interface EnemyRuntime {
  fireCooldown: number;
  alertTimer: number;
}

export interface EnemyManager {
  update(dt: number): void;
  /** Spawn `count` enemies near the player using nav nodes. */
  spawn(count: number): void;
}

export function createEnemyManager(ctx: GameContext): EnemyManager {
  let nextId = 1;
  const rt = new Map<number, EnemyRuntime>();

  function groundY(x: number, z: number, fallback: number): number {
    return ctx.terrain ? ctx.terrain.heightAt(x, z) : fallback;
  }

  /** Spawn `count` enemies near nav nodes (or around the spawn when no nav). */
  function spawn(count: number): void {
    const nav = ctx.nav;
    const nodeCount = nav ? nav.nodes.length : 0;
    const spawnBase: Vec3 = ctx.manifest
      ? ctx.manifest.playerSpawn.position
      : ctx.player.position;

    for (let i = 0; i < count; i++) {
      let x: number;
      let z: number;
      let y: number;
      const route: number[] = [];

      if (nodeCount > 0 && nav) {
        const idx = Math.floor(Math.random() * nodeCount);
        const node = nav.nodes[idx];
        x = node.position[0] + (Math.random() * 4 - 2);
        z = node.position[2] + (Math.random() * 4 - 2);
        y = groundY(x, z, node.position[1]);
        // Patrol route: this node + up to two linked/nearby nodes.
        route.push(idx);
        for (const link of node.links) {
          if (route.length >= 3) break;
          if (link >= 0 && link < nodeCount && !route.includes(link)) route.push(link);
        }
        while (route.length < Math.min(3, nodeCount)) {
          const pick = Math.floor(Math.random() * nodeCount);
          if (!route.includes(pick)) route.push(pick);
        }
      } else {
        // No nav graph: scatter around the spawn point.
        const angle = Math.random() * Math.PI * 2;
        const dist = 8 + Math.random() * 14;
        x = spawnBase[0] + Math.cos(angle) * dist;
        z = spawnBase[2] + Math.sin(angle) * dist;
        y = groundY(x, z, spawnBase[1]);
      }

      const id = nextId++;
      const geometry = new THREE.CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_LENGTH, 4, 10);
      const material = new THREE.MeshStandardMaterial({ color: 0xcc2222 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y + CAPSULE_HALF_HEIGHT, z);
      mesh.userData.enemyId = id;
      ctx.scene.add(mesh);

      const enemy: Enemy = {
        id,
        position: [x, y, z],
        yaw: Math.random() * Math.PI * 2,
        health: ENEMY_MAX_HEALTH,
        alive: true,
        state: "patrol",
        object: mesh,
        patrol: route,
        patrolCursor: 0,
      };
      rt.set(id, { fireCooldown: FIRE_INTERVAL, alertTimer: 0 });
      ctx.enemies.push(enemy);
    }
  }

  /** Set an enemy's yaw so it faces the (dx, dz) direction. */
  function faceTowards(enemy: Enemy, dx: number, dz: number): void {
    enemy.yaw = Math.atan2(-dx, -dz);
  }

  /** True when the player is within sight range and inside the vision cone. */
  function seesPlayer(enemy: Enemy): boolean {
    const dx = ctx.player.position[0] - enemy.position[0];
    const dz = ctx.player.position[2] - enemy.position[2];
    const dist = Math.hypot(dx, dz);
    if (dist > SEE_RANGE || dist < 1e-4) return false;
    const fx = -Math.sin(enemy.yaw);
    const fz = -Math.cos(enemy.yaw);
    return (fx * dx + fz * dz) / dist >= SEE_HALF_ANGLE_COS;
  }

  /** Advance an enemy along its patrol route at a slow walk. */
  function patrol(enemy: Enemy, dt: number): void {
    const route = enemy.patrol;
    if (!ctx.nav || route.length === 0) return;
    const target = ctx.nav.nodes[route[enemy.patrolCursor]];
    if (!target) return;
    const dx = target.position[0] - enemy.position[0];
    const dz = target.position[2] - enemy.position[2];
    const dist = Math.hypot(dx, dz);
    if (dist < 1.0) {
      enemy.patrolCursor = (enemy.patrolCursor + 1) % route.length;
      return;
    }
    const step = Math.min(dist, PATROL_SPEED * dt);
    enemy.position[0] += (dx / dist) * step;
    enemy.position[2] += (dz / dist) * step;
    faceTowards(enemy, dx, dz);
  }

  /** Engage behaviour: face the player and shoot on an interval when in range. */
  function engage(enemy: Enemy, dt: number): void {
    const dx = ctx.player.position[0] - enemy.position[0];
    const dz = ctx.player.position[2] - enemy.position[2];
    const dist = Math.hypot(dx, dz);
    faceTowards(enemy, dx, dz);

    const s = rt.get(enemy.id);
    if (!s) return;
    s.fireCooldown -= dt;

    const facing =
      dist > 1e-4 &&
      (-Math.sin(enemy.yaw) * dx + -Math.cos(enemy.yaw) * dz) / dist >= FACE_COS;

    if (dist <= ENGAGE_RANGE && facing && ctx.player.alive && s.fireCooldown <= 0) {
      s.fireCooldown = FIRE_INTERVAL;
      ctx.player.health = Math.max(0, ctx.player.health - ENEMY_DAMAGE);
      ctx.events.emit(GameEvent.PlayerHit, { amount: ENEMY_DAMAGE });
      if (ctx.player.health <= 0 && ctx.player.alive) {
        ctx.player.alive = false;
        ctx.events.emit(GameEvent.PlayerDied);
      }
    }
  }

  function update(dt: number): void {
    for (const enemy of ctx.enemies) {
      if (!enemy.alive) continue;

      // Keep the enemy pinned to the terrain surface.
      enemy.position[1] = groundY(enemy.position[0], enemy.position[2], enemy.position[1]);

      let s = rt.get(enemy.id);
      if (!s) {
        s = { fireCooldown: FIRE_INTERVAL, alertTimer: 0 };
        rt.set(enemy.id, s);
      }

      switch (enemy.state) {
        case "idle":
        case "patrol":
          if (seesPlayer(enemy)) {
            enemy.state = "alert";
            s.alertTimer = REACTION_SECONDS;
          } else {
            patrol(enemy, dt);
          }
          break;
        case "alert":
          faceTowards(
            enemy,
            ctx.player.position[0] - enemy.position[0],
            ctx.player.position[2] - enemy.position[2],
          );
          s.alertTimer -= dt;
          if (s.alertTimer <= 0) enemy.state = "engage";
          break;
        case "engage":
          engage(enemy, dt);
          break;
        case "dead":
          break;
      }

      // Sync the rendered capsule to the logical state.
      if (enemy.object) {
        enemy.object.position.set(
          enemy.position[0],
          enemy.position[1] + CAPSULE_HALF_HEIGHT,
          enemy.position[2],
        );
        enemy.object.rotation.y = enemy.yaw;
        enemy.object.visible = enemy.alive;
      }
    }
  }

  return { update, spawn };
}
