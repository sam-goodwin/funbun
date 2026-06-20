// bun:closure — experimental closure serialization.
//
// `serialize(fn)` returns the source of an ES module whose `export default` is a
// reconstruction of `fn`. Built incrementally:
//
//   Step 1: functions with no free variables.
//   Step 2: reconstruct captured PRIMITIVE free variables.
//   Step 3: reference graph — objects/arrays, hoisted + deduplicated, cycles.
//   Step 4a: nested functions, each reconstructed inside an isolated IIFE.
//   Step 4b (this): shared mutable cells. A captured cell (identified by its
//   Symbol.freeVariables `id`) referenced by two or more functions is hoisted
//   once at module scope under its original name, so every reconstructed
//   function closes over the same binding — mutations stay shared. Cells used by
//   a single function remain private to its IIFE.

type Replacer = (key: string, value: unknown) => unknown;

interface FreeVariable {
  name: string;
  id: number;
  scopeId: number;
  value: unknown;
  kind: "const" | "let";
}

// Prefix for hoisted reference variables. Must not collide with a captured
// variable name; chosen to be extremely unlikely in user code.
const REF_PREFIX = "__bunClosure$";

interface Context {
  // Module-level hoisted declarations (shared cells, object refs, function refs).
  module: string[];
  // Identity -> hoisted variable name, for objects and functions.
  refs: Map<object, string>;
  counter: number;
  // Cell ids (Symbol.freeVariables id) shared by 2+ functions: hoisted to module
  // scope under their original name, skipped in per-function IIFEs.
  sharedIds: Set<number>;
}

function serialize(fn: Function, _replacer?: Replacer): string {
  if (typeof fn !== "function") {
    throw new TypeError("serialize() expects a function");
  }

  const { sharedIds, cellInfo } = analyzeSharedCells(fn);
  const ctx: Context = { module: [], refs: new Map(), counter: 0, sharedIds };

  // Emit shared cells at module scope (deduped by id) before any function that
  // closes over them. Distinct shared cells with the same name can't coexist.
  const namesById = new Map<string, number>();
  for (const id of sharedIds) {
    const cell = cellInfo.get(id)!;
    const claimed = namesById.get(cell.name);
    if (claimed !== undefined && claimed !== id) {
      throw new TypeError(`Cannot serialize: two distinct shared variables are both named "${cell.name}"`);
    }
    namesById.set(cell.name, id);
    ctx.module.push(`${cell.kind} ${cell.name} = ${emitValue(cell.value, ctx)};`);
  }

  const exportExpr = reconstructFunctionExpr(fn, ctx);
  const prelude = ctx.module.length ? ctx.module.join("\n") + "\n" : "";
  return `${prelude}export default ${exportExpr};\n`;
}

// Walks the function graph reachable from `root` and finds cells referenced by
// more than one function — those must share a single binding.
function analyzeSharedCells(root: Function): { sharedIds: Set<number>; cellInfo: Map<number, FreeVariable> } {
  const cellFunctions = new Map<number, Set<Function>>();
  const cellInfo = new Map<number, FreeVariable>();
  const seenFns = new Set<Function>();
  const seenObjs = new Set<object>();

  function visitValue(value: unknown): void {
    if (typeof value === "function") visitFn(value as Function);
    else if (value !== null && typeof value === "object") visitObj(value as object);
  }
  function visitObj(o: object): void {
    if (seenObjs.has(o)) return;
    seenObjs.add(o);
    if (Array.isArray(o)) {
      for (const el of o) visitValue(el);
    } else {
      for (const key of Object.keys(o)) visitValue((o as any)[key]);
    }
  }
  function visitFn(fn: Function): void {
    if (seenFns.has(fn)) return;
    seenFns.add(fn);
    const freeVariables = (fn as any)[Symbol.freeVariables] as FreeVariable[] | undefined;
    if (!freeVariables) return;
    for (const variable of freeVariables) {
      let set = cellFunctions.get(variable.id);
      if (set === undefined) {
        set = new Set();
        cellFunctions.set(variable.id, set);
        cellInfo.set(variable.id, variable);
      }
      set.add(fn);
      visitValue(variable.value);
    }
  }

  visitFn(root);

  const sharedIds = new Set<number>();
  for (const [id, fns] of cellFunctions) {
    if (fns.size >= 2) sharedIds.add(id);
  }
  return { sharedIds, cellInfo };
}

// Returns an expression that evaluates to a reconstruction of `fn`, wrapping its
// captured variables in an IIFE scope when it has any.
function reconstructFunctionExpr(fn: Function, ctx: Context): string {
  const source = fn.toString();
  if (isNativeFunctionSource(source)) {
    throw new TypeError("Cannot serialize a native function (no JavaScript source is available)");
  }

  const freeVariables = (fn as any)[Symbol.freeVariables] as FreeVariable[];

  const bindings: string[] = [];
  for (const variable of freeVariables) {
    // Shared cells are declared once at module scope; the source resolves to
    // them by name, so don't shadow them with a private binding here.
    if (ctx.sharedIds.has(variable.id)) continue;
    bindings.push(`${variable.kind} ${variable.name} = ${emitValue(variable.value, ctx)};`);
  }

  if (bindings.length === 0) {
    return `(${source})`;
  }
  return `(function () {\n${bindings.join("\n")}\nreturn (${source});\n})()`;
}

// Returns a JS expression for `value`, appending any hoisted declarations to
// `ctx.module` (for objects and nested functions).
function emitValue(value: unknown, ctx: Context): string {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "undefined":
      return "undefined";
    case "bigint":
      return `${value}n`;
    case "number":
      return serializeNumber(value as number);
    case "object":
      if (value === null) return "null";
      return emitObject(value as object, ctx);
    case "function":
      return emitFunction(value as Function, ctx);
    default:
      throw new TypeError(`Cannot serialize a free variable of type ${typeof value}`);
  }
}

function emitObject(value: object, ctx: Context): string {
  const existing = ctx.refs.get(value);
  if (existing !== undefined) return existing;

  const name = REF_PREFIX + ctx.counter++;
  // Record BEFORE recursing so a self-reference resolves to `name`.
  ctx.refs.set(value, name);

  if (Array.isArray(value)) {
    ctx.module.push(`const ${name} = [];`);
    for (let i = 0; i < value.length; i++) {
      if (i in value) {
        ctx.module.push(`${name}[${i}] = ${emitValue(value[i], ctx)};`);
      }
    }
  } else {
    ctx.module.push(`const ${name} = {};`);
    for (const key of Object.keys(value)) {
      ctx.module.push(`${name}[${JSON.stringify(key)}] = ${emitValue((value as any)[key], ctx)};`);
    }
  }

  return name;
}

function emitFunction(fn: Function, ctx: Context): string {
  const existing = ctx.refs.get(fn);
  if (existing !== undefined) return existing;

  const name = REF_PREFIX + ctx.counter++;
  ctx.refs.set(fn, name);
  const expr = reconstructFunctionExpr(fn, ctx);
  ctx.module.push(`const ${name} = ${expr};`);
  return name;
}

function serializeNumber(value: number): string {
  if (value !== value) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  // Preserve negative zero, which `String(-0)` collapses to "0".
  if (value === 0 && 1 / value === -Infinity) return "-0";
  return String(value);
}

function isNativeFunctionSource(source: string): boolean {
  // Native functions stringify as `function name() { [native code] }`.
  const trimmed = source.trimEnd();
  return trimmed.endsWith("[native code] }") || trimmed.endsWith("[native code]\n}");
}

export default {
  serialize,
};
