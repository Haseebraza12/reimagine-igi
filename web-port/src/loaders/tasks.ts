/**
 * Mission task tree (`objects.qvm`) decoding on top of the QVM call tree.
 *
 * `objects.qvm` first declares parameter schemas:
 *   Task_DeclareParameters(type, name0, kind0, name1, kind1, ...)
 * and then instantiates tasks:
 *   Task_New(id, type, name, <params per schema>..., <child Task_New>...)
 *
 * Serialized widths per parameter kind (confidence: recovered — with these
 * widths every declared task in level 1 consumes its arguments exactly and
 * the remaining arguments are always nested Task_New children):
 *   ObjectPos, RGB, Real32x3, Real64x3 -> 3 values
 *   Real32x9 -> 3 values: (alpha, beta, gamma) Euler angles in radians. The
 *               editor type is a 3x3 matrix but the script stores angles.
 *   Graph    -> 3 values (node count, node capacity, link count; graph 4019
 *               stores 264/300/876, matching graphs/graph4019.dat exactly)
 *   AnimData -> 1 + 2n values: a count n followed by n value pairs
 *   everything else -> 1 value
 * Types the engine declares natively (Static, Container, Dynamic) have no
 * schema in the file; all their arguments are children.
 */
import { isQvmCall, type QvmCall, type QvmValue } from "./qvm";

export type TaskParam = QvmValue | QvmValue[];

export interface IgiTask {
  id: number;
  type: string;
  name: string;
  params: Record<string, TaskParam>;
  children: IgiTask[];
}

const WIDTH: Record<string, number> = {
  ObjectPos: 3,
  RGB: 3,
  Real32x3: 3,
  Real64x3: 3,
  Real32x9: 3,
  Graph: 3,
};

/** Serialized width of one parameter starting at rest[i]. */
function parameterWidth(kind: string, rest: QvmValue[], i: number): number {
  if (kind === "AnimData") {
    const count = rest[i];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      fail(`AnimData count is not a non-negative integer`);
    }
    return 1 + 2 * count;
  }
  return WIDTH[kind] ?? 1;
}

function fail(message: string): never {
  throw new Error(`tasks: ${message}`);
}

/** Decode the Task_DeclareParameters schemas and the Task_New tree. */
export function readTaskTree(statements: QvmCall[]): IgiTask[] {
  const schemas = new Map<string, Array<{ name: string; kind: string }>>();
  for (const statement of statements) {
    if (statement.fn !== "Task_DeclareParameters") continue;
    const [type, ...pairs] = statement.args;
    if (typeof type !== "string" || pairs.length % 2 !== 0) {
      fail(`malformed Task_DeclareParameters at code 0x${statement.codeOffset.toString(16)}`);
    }
    const fields: Array<{ name: string; kind: string }> = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const [name, kind] = [pairs[i], pairs[i + 1]];
      if (typeof name !== "string" || typeof kind !== "string") fail(`non-string schema entry for ${type}`);
      fields.push({ name, kind });
    }
    schemas.set(type, fields);
  }

  const decode = (call: QvmCall): IgiTask => {
    const [id, type, name, ...rest] = call.args;
    if (typeof id !== "number" || typeof type !== "string" || typeof name !== "string") {
      fail(`Task_New header is not (number, string, string) at code 0x${call.codeOffset.toString(16)}`);
    }
    const params: Record<string, TaskParam> = {};
    let i = 0;
    for (const field of schemas.get(type) ?? []) {
      if (i >= rest.length) fail(`${type} task ${id} is missing parameter "${field.name}"`);
      const width = parameterWidth(field.kind, rest, i);
      if (i + width > rest.length) {
        fail(`${type} task ${id} is missing parameter "${field.name}"`);
      }
      params[field.name] = width === 1 ? rest[i] : rest.slice(i, i + width);
      i += width;
    }
    const children: IgiTask[] = [];
    for (const child of rest.slice(i)) {
      if (!isQvmCall(child) || child.fn !== "Task_New") {
        fail(`${type} task ${id} has a non-task argument after its declared parameters`);
      }
      children.push(decode(child));
    }
    return { id, type, name, params, children };
  };

  return statements.filter((s) => s.fn === "Task_New").map(decode);
}

/** Depth-first list of every task in the tree (parents before children). */
export function flattenTasks(roots: IgiTask[]): IgiTask[] {
  const out: IgiTask[] = [];
  const walk = (task: IgiTask) => {
    out.push(task);
    task.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

/** Read a 3-number parameter (position, RGB, Euler angles). */
export function vec3Param(task: IgiTask, name: string): [number, number, number] | null {
  const value = task.params[name];
  if (!Array.isArray(value) || value.length !== 3 || !value.every((v) => typeof v === "number")) {
    return null;
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

export function numberParam(task: IgiTask, name: string): number | null {
  const value = task.params[name];
  return typeof value === "number" ? value : null;
}

export function stringParam(task: IgiTask, name: string): string | null {
  const value = task.params[name];
  return typeof value === "string" ? value : null;
}
