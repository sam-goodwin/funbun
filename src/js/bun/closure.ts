// bun:closure — experimental closure serialization.
//
// `serialize(fn)` returns the source of an ES module whose `export default` is a
// reconstruction of `fn`. Built incrementally:
//
//   Step 1: functions with no free variables.
//   Step 2: reconstruct captured PRIMITIVE free variables.
//   Step 3: reference graph — objects/arrays, hoisted + deduplicated, cycles.
//   Step 4a: nested functions, each reconstructed inside an isolated IIFE.
//   Step 4b: shared mutable cells hoisted once at module scope by id.
//   Step 5 (this): a JSON.stringify-style `replacer(key, value)` applied to
//   every captured free-variable value, object property, and array element
//   before it is serialized. An object property transformed to `undefined` is
//   omitted (as in JSON.stringify).

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
  replacer: Replacer | undefined;
}

function serialize(fn: Function, replacer?: Replacer): string {
  if (typeof fn !== "function") {
    throw new TypeError("serialize() expects a function");
  }

  const { sharedIds, cellInfo } = analyzeSharedCells(fn);
  const ctx: Context = {
    module: [],
    refs: new Map(),
    counter: 0,
    sharedIds,
    replacer: typeof replacer === "function" ? replacer : undefined,
  };

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
    const value = transform(undefined, cell.name, cell.value, ctx);
    ctx.module.push(`${cell.kind} ${cell.name} = ${emitValue(value, ctx)};`);
  }

  // A bound (or already-hoisted) root is emitted via the value path and
  // exported by reference; otherwise reconstruct it inline.
  const exportExpr =
    (fn as any)[Symbol.boundFunction] !== undefined ? emitFunction(fn, ctx) : reconstructFunctionExpr(fn, ctx);
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
    if (value === null) return;
    const type = typeof value;
    if (type !== "function" && type !== "object") return;
    if ($isProxyObject(value)) {
      // Don't trap through the proxy; analyze its real target and handler.
      const handler = $getProxyInternalField(value, $proxyFieldHandler);
      if (handler === null) return; // revoked: emit will throw later
      visitValue($getProxyInternalField(value, $proxyFieldTarget));
      visitValue(handler);
      return;
    }
    if (type === "function") {
      const bound = (value as any)[Symbol.boundFunction] as BoundDetails | undefined;
      if (bound !== undefined) {
        visitValue(bound.target);
        visitValue(bound.boundThis);
        for (const arg of bound.boundArgs) visitValue(arg);
        return;
      }
      visitFn(value as Function);
    } else {
      visitObj(value as object);
    }
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
    const value = transform(undefined, variable.name, variable.value, ctx);
    bindings.push(`${variable.kind} ${variable.name} = ${emitValue(value, ctx)};`);
  }

  const fnExpr = functionSourceToExpression(source, (fn as any).name);
  if (bindings.length === 0) {
    return fnExpr;
  }
  return `(function () {\n${bindings.join("\n")}\nreturn ${fnExpr};\n})()`;
}

// Applies the replacer (if any) to a value before it is serialized. `holder` is
// the object/array the value came from (the replacer's `this`), matching
// JSON.stringify; it is undefined for top-level free-variable values.
function transform(holder: unknown, key: string, value: unknown, ctx: Context): unknown {
  return ctx.replacer ? ctx.replacer.$call(holder, key, value) : value;
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
      if ($isProxyObject(value)) return emitProxy(value as object, ctx);
      return emitObject(value as object, ctx);
    case "function":
      // A Proxy whose target is callable has typeof "function".
      if ($isProxyObject(value)) return emitProxy(value as object, ctx);
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

  if (emitBuiltin(value, name, ctx)) {
    return name;
  }

  if (Array.isArray(value)) {
    ctx.module.push(`const ${name} = [];`);
    for (let i = 0; i < value.length; i++) {
      if (i in value) {
        const child = transform(value, String(i), value[i], ctx);
        ctx.module.push(`${name}[${i}] = ${emitValue(child, ctx)};`);
      }
    }
  } else {
    ctx.module.push(`const ${name} = {};`);
    for (const key of Object.keys(value)) {
      const child = transform(value, key, (value as any)[key], ctx);
      // An object property transformed to `undefined` is omitted (JSON-like).
      if (child === undefined) continue;
      ctx.module.push(`${name}[${JSON.stringify(key)}] = ${emitValue(child, ctx)};`);
    }
  }

  return name;
}

const ERROR_TYPES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
]);

// Reconstructs common built-in object types. Returns true (and appends the
// construction to ctx.module under `name`) if `value` is a recognized built-in;
// returns false for plain objects/arrays, which the caller handles.
function emitBuiltin(value: object, name: string, ctx: Context): boolean {
  if (value instanceof Date) {
    ctx.module.push(`const ${name} = new Date(${(value as Date).getTime()});`);
    return true;
  }
  if (value instanceof RegExp) {
    const re = value as RegExp;
    ctx.module.push(`const ${name} = new RegExp(${JSON.stringify(re.source)}, ${JSON.stringify(re.flags)});`);
    return true;
  }
  if (value instanceof Map) {
    ctx.module.push(`const ${name} = new Map();`);
    for (const entry of value as Map<unknown, unknown>) {
      ctx.module.push(`${name}.set(${emitValue(entry[0], ctx)}, ${emitValue(entry[1], ctx)});`);
    }
    return true;
  }
  if (value instanceof Set) {
    ctx.module.push(`const ${name} = new Set();`);
    for (const element of value as Set<unknown>) {
      ctx.module.push(`${name}.add(${emitValue(element, ctx)});`);
    }
    return true;
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    const view = value as unknown as { length: number; constructor: { name: string }; [i: number]: unknown };
    const elements: string[] = [];
    for (let i = 0; i < view.length; i++) {
      elements.push(emitValue(view[i], ctx));
    }
    ctx.module.push(`const ${name} = new ${view.constructor.name}([${elements.join(", ")}]);`);
    return true;
  }
  if (value instanceof Error) {
    const err = value as Error;
    const ctorName = ERROR_TYPES.has((err.constructor && err.constructor.name) as string)
      ? err.constructor.name
      : "Error";
    ctx.module.push(`const ${name} = new ${ctorName}(${JSON.stringify(err.message)});`);
    if (err.name !== ctorName) {
      ctx.module.push(`${name}.name = ${JSON.stringify(err.name)};`);
    }
    return true;
  }
  return false;
}

// Reconstructs a Proxy as `new Proxy(target, handler)`. Both the target and the
// handler (whose traps are themselves serialized functions) recurse through the
// normal value path. Uses JSC intrinsics to see inside the Proxy.
function emitProxy(value: object, ctx: Context): string {
  const existing = ctx.refs.get(value);
  if (existing !== undefined) return existing;

  const name = REF_PREFIX + ctx.counter++;
  ctx.refs.set(value, name);

  const handler = $getProxyInternalField(value, $proxyFieldHandler);
  if (handler === null) {
    throw new TypeError("Cannot serialize a revoked Proxy");
  }
  const target = $getProxyInternalField(value, $proxyFieldTarget);

  const targetExpr = emitValue(target, ctx);
  const handlerExpr = emitValue(handler, ctx);
  ctx.module.push(`const ${name} = new Proxy(${targetExpr}, ${handlerExpr});`);
  return name;
}

interface BoundDetails {
  target: Function;
  boundThis: unknown;
  boundArgs: unknown[];
}

function emitFunction(fn: Function, ctx: Context): string {
  const existing = ctx.refs.get(fn);
  if (existing !== undefined) return existing;

  const name = REF_PREFIX + ctx.counter++;
  ctx.refs.set(fn, name);

  // Bound functions stringify as native code; reconstruct them from their
  // internals instead: target.bind(boundThis, ...boundArgs).
  const bound = (fn as any)[Symbol.boundFunction] as BoundDetails | undefined;
  if (bound !== undefined) {
    const targetExpr = emitValue(bound.target, ctx);
    const thisExpr = emitValue(bound.boundThis, ctx);
    const argExprs = bound.boundArgs.map(arg => emitValue(arg, ctx));
    const tail = argExprs.length ? `, ${argExprs.join(", ")}` : "";
    ctx.module.push(`const ${name} = ${targetExpr}.bind(${thisExpr}${tail});`);
    return name;
  }

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

// `fn.toString()` yields different syntaxes depending on how the function was
// defined. Arrow / `function` / `class` sources are already valid expressions;
// method-shorthand sources (`foo() {}`, `async foo() {}`, `*foo() {}`, object
// or proxy-trap methods) are not, so wrap them in an object literal and pull the
// method back out by name.
function functionSourceToExpression(source: string, name: string): string {
  const trimmed = source.trimStart();
  if (/^(async\s+)?function\b/.test(trimmed) || /^class\b/.test(trimmed)) {
    return `(${source})`;
  }
  // Arrow: `(...) =>`, `x =>`, optionally async.
  if (/^(async\s+)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(trimmed)) {
    return `(${source})`;
  }
  return `({ ${source} })[${JSON.stringify(name)}]`;
}

function isNativeFunctionSource(source: string): boolean {
  // Native functions stringify as `function name() { [native code] }`.
  const trimmed = source.trimEnd();
  return trimmed.endsWith("[native code] }") || trimmed.endsWith("[native code]\n}");
}

export default {
  serialize,
};
