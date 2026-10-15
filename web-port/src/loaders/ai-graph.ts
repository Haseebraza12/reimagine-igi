/**
 * Soldier AI walk graphs (`missions/.../graphs/graph<id>.dat`).
 *
 * Evidence (details and addresses in docs/ai.md section 3):
 * - The file is the engine's generic "GraphStream" [recovered: writer
 *   FUN_004f0a80, reader FUN_004f08a0, field table FUN_004f09c0]. After the
 *   u32 magic 0xFFEEDDCC every field is
 *       u8 4 | u32 tag | u8 0 | u8 fieldType | u8 valueType | payload
 *   and tag = graphStreamHash(field name) (FUN_004f0a40). Value types:
 *   5 = i32, 6 = f32, 8 = 3 x f64, 9 = u8 length + text, 10 = blob
 *   (u8 10, u8 5, u32 length, bytes). [recovered; observed on all 11 level-1
 *   files, which parse to exactly EOF]
 * - Field order: nMaxNodes, RouteTable, then per node nNodeID, tNodePosition,
 *   vNodeGamma, vNodeRadius, nNodeMaterial, nNodeCriteria, then per link
 *   nLinkID1, nLinkID2, eLinkType. [observed]
 * - RouteTable = cap*cap entries {i32 next node, f32 cost}; entry (from, to)
 *   is at index cap*to + from (FUN_005001f0). The AIGraph task loads it from
 *   the file (FUN_004ffe00 registers it, handler 0x500100); soldiers walk by
 *   repeatedly taking `next` (FUN_004506b0). -1 / -1.0 = unreachable.
 *   [recovered; observed: next == to for all 1,752 directed links of graph
 *   4019; every next hop is a neighbour; graphs 7 and 13 costs equal Dijkstra
 *   on 3-D link lengths; graph 4019 holds 46 stale link costs, so use the
 *   stored table, not a recomputed one]
 * - Node in memory (FUN_004f00e0): +8 position (graph-local, IGI units),
 *   +0x20 gamma (rad, rotation of the node square about +z), +0x24 radius
 *   (METRES: half-size of the node's square, x4096 at use), +0x28 2*radius,
 *   +0x30 criteria flags (the criteria text evaluated as an expression over
 *   NODECRITERIA_DOOR / _VIEW / _STAIR, registered by FUN_004ffe00),
 *   +0x138 material, +0x13c up to 64 link pointers. Node ids must be < 1000
 *   and < nMaxNodes. [recovered]
 * - World position = graph position + node position for a graph whose
 *   AIGraph task is static; a graph flagged as attached is additionally
 *   transformed by its parent object (FUN_004f0340). [recovered; which
 *   graphs are attached (inferred: those under Heli/Train/Car) not traced]
 */

export const AI_GRAPH_MAGIC = 0xffeeddcc;

/** Field names the exe registers for graph files, with their declared field type. */
export const AI_GRAPH_FIELDS: Readonly<Record<string, number>> = Object.freeze({
  nMaxNodes: 5,
  RouteTable: 10,
  nNodeID: 5,
  tNodePosition: 8,
  vNodeGamma: 6,
  vNodeRadius: 6,
  nNodeMaterial: 5,
  nNodeCriteria: 9,
  nLinkID1: 5,
  nLinkID2: 5,
  eLinkType: 5,
});

/** Port bit assignment for the three criteria the exe registers (FUN_004ffe00). */
export const AI_NODE_DOOR = 1;
export const AI_NODE_VIEW = 2;
export const AI_NODE_STAIR = 4;

export interface AiGraphNode {
  id: number;
  /** Graph-local position in IGI units (x, y horizontal, z up). */
  position: [number, number, number];
  /** Rotation of the node square about +z, radians (0 on every level-1 node). */
  gamma: number;
  /** Half-size of the node square in metres (multiply by 4096 for units). */
  radius: number;
  material: number;
  criteria: string;
  /** AI_NODE_DOOR | AI_NODE_VIEW | AI_NODE_STAIR. */
  flags: number;
  /** Neighbour node ids, in link order. */
  neighbours: number[];
}

export interface AiGraphLink {
  a: number;
  b: number;
  type: number;
}

export interface AiGraph {
  maxNodes: number;
  nodes: AiGraphNode[];
  nodeById: Map<number, AiGraphNode>;
  links: AiGraphLink[];
  /** next[cap*to + from]: next node from `from` toward `to`, -1 = none. */
  routeNext: Int32Array;
  /** cost[cap*to + from] in IGI units, -1 = none. */
  routeCost: Float32Array;
}

function fail(message: string): never {
  throw new Error(`AI graph: ${message}`);
}

/** FUN_004f0a40: upper-cased characters weighted 1, 1+0x13d, ... (weights mod 0x10000). */
export function graphStreamHash(name: string): number {
  let acc = 0;
  let weight = 1;
  for (let i = 0; i < name.length; i++) {
    let c = name.charCodeAt(i);
    if (c > 0x60 && c < 0x7b) c -= 0x20;
    acc = (acc + c * weight) >>> 0;
    weight = (weight + 0x13d) & 0xffff;
  }
  return acc;
}

const TAG_TO_FIELD = new Map<number, string>(
  Object.keys(AI_GRAPH_FIELDS).map((name) => [graphStreamHash(name), name]),
);

/** Criteria text -> port flags (single names or `|`-joined names). */
export function aiNodeCriteriaFlags(criteria: string): number {
  let flags = 0;
  for (const token of criteria.split(/[^A-Za-z_]+/)) {
    if (token === "NODECRITERIA_DOOR") flags |= AI_NODE_DOOR;
    else if (token === "NODECRITERIA_VIEW") flags |= AI_NODE_VIEW;
    else if (token === "NODECRITERIA_STAIR") flags |= AI_NODE_STAIR;
  }
  return flags;
}

/** Parse one graph file. Throws an Error naming the offset on any deviation. */
export function readAiGraph(buffer: ArrayBuffer): AiGraph {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  if (buffer.byteLength < 4) fail("file shorter than the magic");
  if (view.getUint32(0, true) !== AI_GRAPH_MAGIC) fail(`bad magic at 0x0`);

  let maxNodes = -1;
  let routeOffset = -1;
  const nodes: AiGraphNode[] = [];
  const links: AiGraphLink[] = [];
  let node: Partial<AiGraphNode> | null = null;
  let link: Partial<AiGraphLink> | null = null;

  let pos = 4;
  while (pos < buffer.byteLength) {
    const at = pos;
    if (pos + 8 > buffer.byteLength) fail(`truncated record header at 0x${at.toString(16)}`);
    if (bytes[pos] !== 4) fail(`record at 0x${at.toString(16)}: tag value type ${bytes[pos]} != 4`);
    const tag = view.getUint32(pos + 1, true);
    const field = TAG_TO_FIELD.get(tag);
    if (field === undefined) fail(`record at 0x${at.toString(16)}: unknown tag 0x${tag.toString(16)}`);
    if (bytes[pos + 5] !== 0) fail(`record at 0x${at.toString(16)}: field-type prefix ${bytes[pos + 5]} != 0`);
    const fieldType = bytes[pos + 6];
    if (fieldType !== AI_GRAPH_FIELDS[field]) {
      fail(`record at 0x${at.toString(16)}: ${field} has field type ${fieldType}`);
    }
    const valueType = bytes[pos + 7];
    pos += 8;
    const need = (n: number) => {
      if (pos + n > buffer.byteLength) fail(`${field} at 0x${at.toString(16)} runs past EOF`);
    };
    if (fieldType === 10) {
      need(6);
      if (valueType !== 0 || bytes[pos] !== 10 || bytes[pos + 1] !== 5) {
        fail(`blob ${field} at 0x${at.toString(16)} has a bad header`);
      }
      const length = view.getUint32(pos + 2, true);
      pos += 6;
      need(length);
      if (field !== "RouteTable") fail(`unexpected blob ${field} at 0x${at.toString(16)}`);
      if (maxNodes < 0) fail(`RouteTable at 0x${at.toString(16)} precedes nMaxNodes`);
      if (length !== maxNodes * maxNodes * 8) {
        fail(`RouteTable at 0x${at.toString(16)} is ${length} bytes, expected 8*${maxNodes}^2`);
      }
      routeOffset = pos;
      pos += length;
      continue;
    }
    if (fieldType === 9) {
      if (valueType !== 9) fail(`${field} at 0x${at.toString(16)} has value type ${valueType}`);
      need(1);
      const n = bytes[pos];
      need(1 + n);
      let text = "";
      for (let i = 0; i < n && bytes[pos + 1 + i] !== 0; i++) text += String.fromCharCode(bytes[pos + 1 + i]);
      pos += 1 + n;
      if (!node || node.material === undefined) fail(`criteria at 0x${at.toString(16)} outside a complete node`);
      node.criteria = text;
      node.flags = aiNodeCriteriaFlags(text);
      node.neighbours = [];
      nodes.push(node as AiGraphNode);
      node = null;
      continue;
    }
    if (valueType !== fieldType) fail(`${field} at 0x${at.toString(16)}: value type ${valueType} != ${fieldType}`);
    if (fieldType === 8) {
      need(24);
      const p: [number, number, number] = [
        view.getFloat64(pos, true),
        view.getFloat64(pos + 8, true),
        view.getFloat64(pos + 16, true),
      ];
      pos += 24;
      if (!node) fail(`position at 0x${at.toString(16)} outside a node`);
      node.position = p;
      continue;
    }
    need(4);
    const i32 = view.getInt32(pos, true);
    const f32 = view.getFloat32(pos, true);
    pos += 4;
    switch (field) {
      case "nMaxNodes":
        if (i32 < 1 || i32 > 1000) fail(`nMaxNodes ${i32} at 0x${at.toString(16)} out of range`);
        maxNodes = i32;
        break;
      case "nNodeID":
        if (node) fail(`node at 0x${at.toString(16)} starts before the previous one ended`);
        node = { id: i32 };
        break;
      case "vNodeGamma":
        if (!node) fail(`gamma at 0x${at.toString(16)} outside a node`);
        node.gamma = f32;
        break;
      case "vNodeRadius":
        if (!node) fail(`radius at 0x${at.toString(16)} outside a node`);
        node.radius = f32;
        break;
      case "nNodeMaterial":
        if (!node) fail(`material at 0x${at.toString(16)} outside a node`);
        node.material = i32;
        break;
      case "nLinkID1":
        link = { a: i32 };
        break;
      case "nLinkID2":
        if (!link) fail(`nLinkID2 at 0x${at.toString(16)} without nLinkID1`);
        link.b = i32;
        break;
      case "eLinkType":
        if (!link || link.b === undefined) fail(`eLinkType at 0x${at.toString(16)} without link ids`);
        link.type = i32;
        links.push(link as AiGraphLink);
        link = null;
        break;
      default:
        fail(`unexpected field ${field} at 0x${at.toString(16)}`);
    }
  }
  if (node || link) fail("file ends inside a node or link record");
  if (maxNodes < 0 || routeOffset < 0) fail("missing nMaxNodes or RouteTable");

  const nodeById = new Map<number, AiGraphNode>();
  for (const n of nodes) {
    if (n.id < 0 || n.id >= maxNodes || n.id >= 1000) fail(`node id ${n.id} outside [0, ${maxNodes})`);
    if (nodeById.has(n.id)) fail(`duplicate node id ${n.id}`);
    nodeById.set(n.id, n);
  }
  for (const l of links) {
    const a = nodeById.get(l.a);
    const b = nodeById.get(l.b);
    if (!a || !b) fail(`link ${l.a}-${l.b} names a missing node`);
    if (a.neighbours.length >= 64 || b.neighbours.length >= 64) fail(`node link limit (64) exceeded at ${l.a}-${l.b}`);
    a.neighbours.push(l.b);
    b.neighbours.push(l.a);
  }
  const count = maxNodes * maxNodes;
  const routeNext = new Int32Array(count);
  const routeCost = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    routeNext[i] = view.getInt32(routeOffset + i * 8, true);
    routeCost[i] = view.getFloat32(routeOffset + i * 8 + 4, true);
  }
  return { maxNodes, nodes, nodeById, links, routeNext, routeCost };
}

/** FUN_00500520 / FUN_005001f0: route entry from -> to, or null when absent. */
export function aiGraphRoute(graph: AiGraph, from: number, to: number): { next: number; cost: number } | null {
  const cap = graph.maxNodes;
  if (from < 0 || to < 0 || from >= cap || to >= cap) return null;
  const i = cap * to + from;
  const next = graph.routeNext[i];
  return next === -1 ? null : { next, cost: graph.routeCost[i] };
}

/**
 * Node sequence from -> to by following stored next hops (the route
 * FUN_004506b0 queues). [from] when from === to; null when unroutable.
 */
export function aiGraphPath(graph: AiGraph, from: number, to: number): number[] | null {
  if (!graph.nodeById.has(from) || !graph.nodeById.has(to)) return null;
  const path = [from];
  let cur = from;
  for (let guard = 0; cur !== to; guard++) {
    if (guard > graph.maxNodes) return null;
    const entry = aiGraphRoute(graph, cur, to);
    if (!entry || !graph.nodeById.has(entry.next)) return null;
    cur = entry.next;
    path.push(cur);
  }
  return path;
}

type Vec3 = readonly [number, number, number];

/** FUN_004f0340 for a static graph: graph position + node position (IGI units). */
export function aiGraphNodeWorld(node: AiGraphNode, graphPosition: Vec3): [number, number, number] {
  return [node.position[0] + graphPosition[0], node.position[1] + graphPosition[1], node.position[2] + graphPosition[2]];
}

/**
 * FUN_004f0610: is `point` on the node? The node is a square of half-size
 * (radius + marginMetres) * 4096, rotated by gamma (FUN_004a9ec0: local =
 * R(gamma)^T * d). With checkHeight, |dz| must also be <= 4096 (1 m).
 * The exe uses marginMetres 0.3 for "standing on a node" tests and 0 for
 * the roll-room test.
 */
export function aiGraphNodeContains(
  node: AiGraphNode,
  graphPosition: Vec3,
  point: Vec3,
  marginMetres: number,
  checkHeight: boolean,
): boolean {
  const w = aiGraphNodeWorld(node, graphPosition);
  const dx = point[0] - w[0];
  const dy = point[1] - w[1];
  const dz = point[2] - w[2];
  if (checkHeight && Math.abs(dz) > 4096) return false;
  if (dx === 0 && dy === 0 && dz === 0) return false; // FUN_004a9600 zero-vector early-out
  const c = Math.cos(node.gamma);
  const s = Math.sin(node.gamma);
  const lx = c * dx + s * dy;
  const ly = -s * dx + c * dy;
  const half = (node.radius + marginMetres) * 4096;
  return lx >= -half && lx <= half && ly >= -half && ly <= half;
}

/**
 * FUN_00500550: closest node to `point`, skipping NODECRITERIA_VIEW nodes,
 * ranked by |node - point| - radius*4096. `inside` is true when that value
 * is negative (the exe returns 2 instead of 1).
 */
export function aiGraphClosestNode(
  graph: AiGraph,
  graphPosition: Vec3,
  point: Vec3,
): { node: AiGraphNode; distance: number; inside: boolean } | null {
  let best: AiGraphNode | null = null;
  let bestD = Infinity;
  for (const node of graph.nodes) {
    if (node.flags & AI_NODE_VIEW) continue;
    const w = aiGraphNodeWorld(node, graphPosition);
    const d = Math.hypot(w[0] - point[0], w[1] - point[1], w[2] - point[2]) - node.radius * 4096;
    if (d < bestD) {
      bestD = d;
      best = node;
    }
  }
  return best ? { node: best, distance: bestD, inside: bestD < 0 } : null;
}

/**
 * FUN_00450e90: where a route leg enters / leaves a node. The point lies on
 * the border of the node's axis-aligned square (half-size radius*4096)
 * along `direction` (x, y of the leg; exit = +direction, entry = -direction);
 * the height stays the node's. Returns the node centre when the leg is
 * zero or the border cannot be reached.
 */
export function aiGraphLegPoint(
  node: AiGraphNode,
  nodeWorld: Vec3,
  direction: Vec3,
  exit: boolean,
): [number, number, number] {
  const r = node.radius * 4096;
  const [dx, dy, dz] = direction;
  if (dx !== 0 || dy !== 0 || dz !== 0) {
    if (dx > r || dx < -r) {
      const oy = Math.abs(r / dx) * dy;
      if (Math.abs(oy) <= r) {
        const ox = dx < 0 ? -r : r;
        return exit ? [nodeWorld[0] + ox, nodeWorld[1] + oy, nodeWorld[2]] : [nodeWorld[0] - ox, nodeWorld[1] - oy, nodeWorld[2]];
      }
    }
    if (dy > r || dy < -r) {
      const ox = Math.abs(r / dy) * dx;
      if (Math.abs(ox) <= r) {
        const oy = dy < 0 ? -r : r;
        return exit ? [nodeWorld[0] + ox, nodeWorld[1] + oy, nodeWorld[2]] : [nodeWorld[0] - ox, nodeWorld[1] - oy, nodeWorld[2]];
      }
    }
  }
  return [nodeWorld[0], nodeWorld[1], nodeWorld[2]];
}

/**
 * Waypoints a soldier queues to walk from node `from` to node `to`
 * (FUN_004506b0, simplified to static graphs): for every leg a -> b of the
 * stored route, the exit point of a and the entry point of b
 * (aiGraphLegPoint); the final point is `finalPoint` (an occupancy-cell
 * position) or the target node centre. `door` marks legs whose two nodes
 * are both NODECRITERIA_DOOR: the walker looks for a door there, opens it
 * and waits (FUN_00450310). The first exit point is only used when the
 * walker already stands on `from` (0.3 m margin) - pass onFrom.
 */
export function aiGraphWaypoints(
  graph: AiGraph,
  graphPosition: Vec3,
  from: number,
  to: number,
  onFrom: boolean,
  finalPoint?: Vec3,
): Array<{ point: [number, number, number]; node: number; door: boolean }> | null {
  const path = aiGraphPath(graph, from, to);
  if (!path) return null;
  const out: Array<{ point: [number, number, number]; node: number; door: boolean }> = [];
  if (path.length === 1) {
    const n = graph.nodeById.get(to)!;
    out.push({ point: finalPoint ? [finalPoint[0], finalPoint[1], finalPoint[2]] : aiGraphNodeWorld(n, graphPosition), node: to, door: false });
    return out;
  }
  for (let i = 0; i + 1 < path.length; i++) {
    const a = graph.nodeById.get(path[i])!;
    const b = graph.nodeById.get(path[i + 1])!;
    const wa = aiGraphNodeWorld(a, graphPosition);
    const wb = aiGraphNodeWorld(b, graphPosition);
    const dir: [number, number, number] = [wb[0] - wa[0], wb[1] - wa[1], wb[2] - wa[2]];
    const door = (a.flags & AI_NODE_DOOR) !== 0 && (b.flags & AI_NODE_DOOR) !== 0;
    if (b.id !== to) {
      if (i > 0 || onFrom) out.push({ point: aiGraphLegPoint(a, wa, dir, true), node: a.id, door });
      out.push({ point: aiGraphLegPoint(b, wb, dir, false), node: b.id, door: false });
      continue;
    }
    // Last leg: no exit point of a; the entry point of b only when a final
    // point is given, then the final point if it lies on b (0.3 m margin,
    // height of b), else b's centre.
    if (!finalPoint) {
      out.push({ point: wb, node: b.id, door });
    } else {
      out.push({ point: aiGraphLegPoint(b, wb, dir, false), node: b.id, door });
      const on = aiGraphNodeContains(b, graphPosition, finalPoint, 0.3, false);
      out.push({ point: on ? [finalPoint[0], finalPoint[1], wb[2]] : wb, node: b.id, door: false });
    }
  }
  return out;
}
