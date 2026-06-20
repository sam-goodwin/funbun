// bun:closure — experimental closure serialization.
//
// `serialize(fn)` returns the source of an ES module whose `export default` is a
// reconstruction of `fn`. Built incrementally:
//
//   Step 1: functions with no free variables — `export default <source>`.
//   Step 2 (this): reconstruct captured PRIMITIVE free variables as
//   module-level bindings, so the function closes over them by name. Shared
//   cells, rich values, Proxy, bound functions, built-ins, and source maps land
//   in later steps.

type Replacer = (key: string, value: unknown) => unknown;

interface FreeVariable {
  name: string;
  id: number;
  scopeId: number;
  value: unknown;
  kind: "const" | "let";
}

function serialize(fn: Function, _replacer?: Replacer): string {
  if (typeof fn !== "function") {
    throw new TypeError("serialize() expects a function");
  }

  const source = fn.toString();
  if (isNativeFunctionSource(source)) {
    throw new TypeError("Cannot serialize a native function (no JavaScript source is available)");
  }

  const freeVariables = (fn as any)[Symbol.freeVariables] as FreeVariable[];

  let bindings = "";
  for (const variable of freeVariables) {
    bindings += `${variable.kind} ${variable.name} = ${serializeValue(variable.value)};\n`;
  }

  // Parenthesize so the source is always an expression position, whether it is
  // an arrow, a function expression/declaration, or a class.
  return `${bindings}export default (${source});\n`;
}

// Step 2: only primitives. Objects, functions, Proxies, etc. come in later steps.
function serializeValue(value: unknown): string {
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
      throw new TypeError("Cannot serialize object free variables yet");
    default:
      throw new TypeError(`Cannot serialize a free variable of type ${typeof value}`);
  }
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
