// bun:closure — experimental closure serialization.
//
// `serialize(fn)` returns the source of an ES module whose `export default` is a
// reconstruction of `fn`. Built incrementally:
//
//   Step 1: functions with no free variables.
//   Step 2: reconstruct captured PRIMITIVE free variables.
//   Step 3: reference graph — objects/arrays, hoisted + deduplicated, cycles.
//   Step 4a (this): nested functions. A captured value that is itself a
//   function is reconstructed recursively. Each function's captured variables
//   are reconstructed inside an IIFE so its scope is isolated — two functions
//   that capture different variables of the same name don't collide. Shared
//   OBJECTS are still deduplicated by identity (so mutating shared object state
//   works); shared mutable PRIMITIVE cells across functions come in step 4b.

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
  // Module-level hoisted declarations (object refs, nested function refs).
  module: string[];
  // Identity -> hoisted variable name, for objects and functions.
  refs: Map<object, string>;
  counter: number;
}

function serialize(fn: Function, _replacer?: Replacer): string {
  if (typeof fn !== "function") {
    throw new TypeError("serialize() expects a function");
  }

  const ctx: Context = { module: [], refs: new Map(), counter: 0 };
  const exportExpr = reconstructFunctionExpr(fn, ctx);

  const prelude = ctx.module.length ? ctx.module.join("\n") + "\n" : "";
  return `${prelude}export default ${exportExpr};\n`;
}

// Returns an expression that evaluates to a reconstruction of `fn`, wrapping its
// captured variables in an IIFE scope when it has any.
function reconstructFunctionExpr(fn: Function, ctx: Context): string {
  const source = fn.toString();
  if (isNativeFunctionSource(source)) {
    throw new TypeError("Cannot serialize a native function (no JavaScript source is available)");
  }

  const freeVariables = (fn as any)[Symbol.freeVariables] as FreeVariable[];
  if (freeVariables.length === 0) {
    return `(${source})`;
  }

  const bindings: string[] = [];
  for (const variable of freeVariables) {
    bindings.push(`${variable.kind} ${variable.name} = ${emitValue(variable.value, ctx)};`);
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
