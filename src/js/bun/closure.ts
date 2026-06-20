// bun:closure — experimental closure serialization.
//
// `serialize(fn)` returns the source of an ES module whose `export default` is a
// reconstruction of `fn`. Built incrementally:
//
//   Step 1 (this): functions with no free variables — emit `export default
//   <source>`. Free-variable reconstruction, shared cells, rich values, Proxy,
//   bound functions, built-ins, and source maps land in later steps.

type Replacer = (key: string, value: unknown) => unknown;

function serialize(fn: Function, _replacer?: Replacer): string {
  if (typeof fn !== "function") {
    throw new TypeError("serialize() expects a function");
  }

  const source = fn.toString();
  if (isNativeFunctionSource(source)) {
    throw new TypeError("Cannot serialize a native function (no JavaScript source is available)");
  }

  // Parenthesize so the source is always an expression position, whether it is
  // an arrow, a function expression/declaration, or a class.
  return `export default (${source});\n`;
}

function isNativeFunctionSource(source: string): boolean {
  // Native functions stringify as `function name() { [native code] }`.
  const trimmed = source.trimEnd();
  return trimmed.endsWith("[native code] }") || trimmed.endsWith("[native code]\n}");
}

export default {
  serialize,
};
