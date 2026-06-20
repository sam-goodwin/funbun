// bun:closure — experimental closure serialization.
//
// `serialize(fn)` returns the source of an ES module whose `export default` is a
// reconstruction of `fn`. Built incrementally:
//
//   Step 1: functions with no free variables.
//   Step 2: reconstruct captured PRIMITIVE free variables as module bindings.
//   Step 3 (this): reference graph — captured objects/arrays are hoisted as
//   `const` declarations, deduplicated by identity (shared references emitted
//   once) with cycles handled by declare-then-fill. Functions/Proxies/bound
//   functions/built-ins and source maps come in later steps.

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
  statements: string[];
  refs: Map<object, string>;
  counter: number;
}

function serialize(fn: Function, _replacer?: Replacer): string {
  if (typeof fn !== "function") {
    throw new TypeError("serialize() expects a function");
  }

  const source = fn.toString();
  if (isNativeFunctionSource(source)) {
    throw new TypeError("Cannot serialize a native function (no JavaScript source is available)");
  }

  const ctx: Context = { statements: [], refs: new Map(), counter: 0 };
  const freeVariables = (fn as any)[Symbol.freeVariables] as FreeVariable[];

  for (const variable of freeVariables) {
    const expr = emitValue(variable.value, ctx);
    ctx.statements.push(`${variable.kind} ${variable.name} = ${expr};`);
  }

  const prelude = ctx.statements.length ? ctx.statements.join("\n") + "\n" : "";
  // Parenthesize so the source is always an expression position.
  return `${prelude}export default (${source});\n`;
}

// Returns a JS expression for `value`, appending any hoisted construction
// statements (for objects) to `ctx`.
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
      throw new TypeError("Cannot serialize function free variables yet");
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
    ctx.statements.push(`const ${name} = [];`);
    for (let i = 0; i < value.length; i++) {
      if (i in value) {
        ctx.statements.push(`${name}[${i}] = ${emitValue(value[i], ctx)};`);
      }
    }
  } else {
    ctx.statements.push(`const ${name} = {};`);
    for (const key of Object.keys(value)) {
      ctx.statements.push(`${name}[${JSON.stringify(key)}] = ${emitValue((value as any)[key], ctx)};`);
    }
  }

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
