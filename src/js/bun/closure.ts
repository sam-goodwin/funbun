// bun:closure — experimental closure serialization.
//
// `serialize(fn)` returns the source of an ES module whose `export default` is a
// reconstruction of `fn`, including the state it captures.
//
// Handles: captured primitives; objects/arrays with cycles and shared
// references (deduped by identity); nested functions; shared mutable cells
// across closures (hoisted once, by Symbol.freeVariables id); a JSON.stringify
// `replacer(key, value)`; built-ins (Date/RegExp/Map/Set/typed arrays/Error);
// Proxies and bound functions; property descriptors (getters/setters,
// non-enumerable, registered/well-known symbol keys); prototypes (class
// instances via Object.create(Class.prototype), null-proto objects); and class
// values incl. statics, method-level captures, and `extends` inheritance. An
// inline source map points stack traces back at the original source.
//
// Known limitations: `#private` instance field VALUES are not captured (they're
// invisible to reflection, and the constructor is not re-run on a reconstructed
// instance); a variable captured ONLY by a class field initializer (referenced
// by no method) and captured as a direct class value can't be recovered, since
// class member executables aren't reachable from the class constructor — the
// workaround is to capture the class's factory, or reference the variable in a
// method; decorators are not part of `Function.prototype.toString()` and so are
// not preserved; unique (non-registered) symbol values/keys and native functions
// throw a clear error.

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
  // Records, for source-map generation, where each reconstructed function's
  // verbatim source lands. `moduleIndex` indexes into `module` (or -1 for the
  // default-export expression).
  sourceBlocks: SourceBlock[];
}

interface SourceBlock {
  moduleIndex: number;
  lineOffset: number;
  url: string;
  line: number;
  lineCount: number;
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
    sourceBlocks: [],
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
  let exportExpr: string;
  let exportReconstructed: ReconstructedFunction | undefined;
  if ((fn as any)[Symbol.boundFunction] !== undefined) {
    exportExpr = emitFunction(fn, ctx);
  } else {
    exportReconstructed = reconstructFunctionExpr(fn, ctx);
    exportExpr = exportReconstructed.expr;
  }

  const prelude = ctx.module.length ? ctx.module.join("\n") + "\n" : "";
  const moduleStartLines = computeStartLines(ctx.module);
  const preludeLineCount = prelude === "" ? 0 : countLines(prelude.slice(0, -1)) + 1;

  // `export default ` adds no newlines, so the export expression's source offset
  // is relative to the line the export statement begins on.
  if (exportReconstructed !== undefined && exportReconstructed.location && exportReconstructed.location.url) {
    ctx.sourceBlocks.push({
      moduleIndex: -1,
      lineOffset: exportReconstructed.sourceLineOffset,
      url: exportReconstructed.location.url,
      line: exportReconstructed.location.line,
      lineCount: exportReconstructed.sourceLineCount,
    });
  }

  let output = `${prelude}export default ${exportExpr};\n`;
  const sourceMap = buildSourceMap(ctx.sourceBlocks, moduleStartLines, preludeLineCount);
  if (sourceMap !== undefined) {
    const { Buffer } = require("node:buffer");
    const base64 = Buffer.from(sourceMap, "utf8").toString("base64");
    output += `//# sourceMappingURL=data:application/json;charset=utf-8;base64,${base64}\n`;
  }
  return output;
}

const BASE64_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function vlqEncode(value: number): string {
  let vlq = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) digit |= 32;
    out += BASE64_DIGITS[digit];
  } while (vlq > 0);
  return out;
}

// Builds a v3 source map (as a JSON string) mapping the generated module's lines
// back to the original source files at line granularity, or undefined if there
// is nothing to map. Column information is coarse (every mapped line points at
// column 0), which is enough for stack traces to name the right file and line.
function buildSourceMap(
  blocks: SourceBlock[],
  moduleStartLines: number[],
  preludeLineCount: number,
): string | undefined {
  if (blocks.length === 0) return undefined;

  const sources: string[] = [];
  const sourceIndexByUrl = new Map<string, number>();
  const mapped = new Map<number, [number, number]>(); // genLine -> [sourceIndex, srcLine0]
  let maxLine = 0;

  for (const block of blocks) {
    let sourceIndex = sourceIndexByUrl.get(block.url);
    if (sourceIndex === undefined) {
      sourceIndex = sources.length;
      sources.push(block.url);
      sourceIndexByUrl.set(block.url, sourceIndex);
    }
    const genStart =
      (block.moduleIndex === -1 ? preludeLineCount : moduleStartLines[block.moduleIndex]) + block.lineOffset;
    for (let k = 0; k < block.lineCount; k++) {
      const genLine = genStart + k;
      mapped.set(genLine, [sourceIndex, block.line - 1 + k]);
      if (genLine > maxLine) maxLine = genLine;
    }
  }

  let prevSource = 0;
  let prevSrcLine = 0;
  const lines: string[] = [];
  for (let g = 0; g <= maxLine; g++) {
    const entry = mapped.get(g);
    if (entry === undefined) {
      lines.push("");
      continue;
    }
    const sourceIndex = entry[0];
    const srcLine = entry[1];
    // [generatedColumn=0, sourceIndexDelta, sourceLineDelta, sourceColumn=0]
    lines.push(vlqEncode(0) + vlqEncode(sourceIndex - prevSource) + vlqEncode(srcLine - prevSrcLine) + vlqEncode(0));
    prevSource = sourceIndex;
    prevSrcLine = srcLine;
  }

  return JSON.stringify({ version: 3, sources, names: [], mappings: lines.join(";") });
}

function countLines(text: string): number {
  let count = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

// Start line (0-based) of each entry in `module` once joined by "\n".
function computeStartLines(module: string[]): number[] {
  const starts: number[] = [];
  let line = 0;
  for (let i = 0; i < module.length; i++) {
    starts.push(line);
    line += countLines(module[i]);
  }
  return starts;
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
      return;
    }
    // Walk own properties via descriptors so getters aren't invoked here (their
    // values are reconstructed lazily, not eagerly).
    for (const key of Reflect.ownKeys(o)) {
      const descriptor = Object.getOwnPropertyDescriptor(o, key)!;
      if (descriptor.get) visitValue(descriptor.get);
      if (descriptor.set) visitValue(descriptor.set);
      if ("value" in descriptor) visitValue(descriptor.value);
    }
    // A class instance is reconstructed via its class, so analyze that too.
    const proto = Object.getPrototypeOf(o);
    if (proto !== null && proto !== Object.prototype) {
      const ctor = (proto as any).constructor;
      visitValue(typeof ctor === "function" && ctor.prototype === proto ? ctor : proto);
    }
  }
  function visitFn(fn: Function): void {
    if (seenFns.has(fn)) return;
    seenFns.add(fn);
    let source: string;
    try {
      source = fn.toString();
    } catch {
      return;
    }
    const freeVariables = allFreeVariables(fn, source);
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
    // A class's superclass is reconstructed too, so analyze it.
    const superclass = Object.getPrototypeOf(fn);
    if (typeof superclass === "function" && superclass !== Function.prototype) {
      visitValue(superclass);
    }
  }

  visitFn(root);

  const sharedIds = new Set<number>();
  for (const [id, fns] of cellFunctions) {
    if (fns.size >= 2) sharedIds.add(id);
  }
  return { sharedIds, cellInfo };
}

interface ReconstructedFunction {
  expr: string;
  // Where the original `fn` source begins within `expr`, in lines (the source is
  // always emitted verbatim, so it maps line-for-line onto the original file).
  sourceLineOffset: number;
  sourceLineCount: number;
  location: { url: string; line: number; column: number } | undefined;
}

// Returns an expression that evaluates to a reconstruction of `fn`, wrapping its
// captured variables in an IIFE scope when it has any.
function reconstructFunctionExpr(fn: Function, ctx: Context): ReconstructedFunction {
  const source = fn.toString();
  if (isNativeFunctionSource(source)) {
    throw new TypeError("Cannot serialize a native function (no JavaScript source is available)");
  }

  const freeVariables = allFreeVariables(fn, source);
  const location = (fn as any)[Symbol.sourceLocation] as ReconstructedFunction["location"];
  const sourceLineCount = source.split("\n").length;

  const bindings: string[] = [];
  for (const variable of freeVariables) {
    // Shared cells are declared once at module scope; the source resolves to
    // them by name, so don't shadow them with a private binding here.
    if (ctx.sharedIds.has(variable.id)) continue;
    const value = transform(undefined, variable.name, variable.value, ctx);
    bindings.push(`${variable.kind} ${variable.name} = ${emitValue(value, ctx)};`);
  }

  // A class's `extends <Identifier>` superclass is referenced by the source but
  // is not a free variable, so bind it explicitly (its identity is the class's
  // own prototype). Only simple-identifier heritage is handled.
  const superclassBinding = classHeritageBinding(fn, source, ctx);
  if (superclassBinding !== undefined) bindings.push(superclassBinding);

  // functionSourceToExpression always places the original source on its own
  // first line, so the only vertical offset comes from the IIFE wrapper.
  const fnExpr = functionSourceToExpression(source, (fn as any).name);
  if (bindings.length === 0) {
    return { expr: fnExpr, sourceLineOffset: 0, sourceLineCount, location };
  }
  // (function () {\n  <bindings...>\n  return <fnExpr>;\n})()
  // The `return` line is at offset 1 (header) + bindings.length.
  return {
    expr: `(function () {\n${bindings.join("\n")}\nreturn ${fnExpr};\n})()`,
    sourceLineOffset: 1 + bindings.length,
    sourceLineCount,
    location,
  };
}

// The free variables a function closes over. For a class, Symbol.freeVariables
// reports only what the constructor body references, not its methods — so union
// in each method's (and static member's) own free variables, deduped by cell id.
// Methods share the class's defining scope, so same-named captures are the same
// cell.
function allFreeVariables(fn: Function, source: string): FreeVariable[] {
  const own = ((fn as any)[Symbol.freeVariables] as FreeVariable[] | undefined) ?? [];
  if (!source.trimStart().startsWith("class")) return own;

  const byId = new Map<number, FreeVariable>();
  for (const variable of own) {
    // `#name` private brands are an internal mechanism recreated by the class
    // body itself — never an external capture.
    if (variable.name.startsWith("#")) continue;
    byId.set(variable.id, variable);
  }
  collectMemberFreeVariables(fn, fn, byId);
  if (typeof fn === "function" && fn.prototype) collectMemberFreeVariables(fn.prototype, fn, byId);
  return [...byId.values()];
}

function collectMemberFreeVariables(holder: object, classFn: Function, byId: Map<number, FreeVariable>): void {
  for (const key of Reflect.ownKeys(holder)) {
    const descriptor = Object.getOwnPropertyDescriptor(holder, key)!;
    for (const member of [descriptor.value, descriptor.get, descriptor.set]) {
      if (typeof member !== "function") continue;
      const memberVars = (member as any)[Symbol.freeVariables] as FreeVariable[] | undefined;
      if (!memberVars) continue;
      for (const variable of memberVars) {
        // A reference to the class's own name resolves to the class expression's
        // binding, and `#name` private brands are recreated by the class body —
        // neither should be bound externally.
        if (variable.value === classFn || variable.name.startsWith("#")) continue;
        if (!byId.has(variable.id)) byId.set(variable.id, variable);
      }
    }
  }
}

// If `fn` is a class declared as `class X extends <Identifier> { ... }`, returns
// a binding that brings the superclass into scope under that identifier. The
// superclass is the class's own prototype (set by `extends`), which is reliable
// even though it is not reported as a free variable.
function classHeritageBinding(fn: Function, source: string, ctx: Context): string | undefined {
  const trimmed = source.trimStart();
  if (!trimmed.startsWith("class")) return undefined;
  const superclass = Object.getPrototypeOf(fn);
  if (typeof superclass !== "function" || superclass === Function.prototype) return undefined;
  const match = trimmed.match(/^class\s+(?:[A-Za-z_$][\w$]*\s+)?extends\s+([A-Za-z_$][\w$]*)\s*\{/);
  if (match === null) return undefined;
  return `const ${match[1]} = ${emitValue(superclass, ctx)};`;
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
    ctx.module.push(`const ${name} = ${objectBaseExpression(value, ctx)};`);
    emitOwnProperties(name, value, ctx);
  }

  return name;
}

// Returns the expression that creates a fresh object with `value`'s prototype.
// Plain objects use `{}`; null-prototype objects use `Object.create(null)`; a
// class instance is recreated via `Object.create(<Class>.prototype)` so its
// methods, prototype chain, and `instanceof` survive (its own public fields are
// then assigned by the caller). NOTE: `#private` fields are invisible to
// reflection and are not captured, and the constructor is not re-run.
function objectBaseExpression(value: object, ctx: Context): string {
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype) return "{}";
  if (proto === null) return "Object.create(null)";

  const ctor = (proto as any).constructor;
  if (typeof ctor === "function" && ctor.prototype === proto) {
    return `Object.create(${emitValue(ctor, ctx)}.prototype)`;
  }
  return `Object.create(${emitValue(proto, ctx)})`;
}

// Emits each own property of `value` onto the hoisted `name`, preserving
// accessor (get/set) properties, non-enumerable/non-writable flags, and
// symbol keys. Plain enumerable writable data properties use a simple
// assignment; everything else uses Object.defineProperty.
function emitOwnProperties(name: string, value: object, ctx: Context): void {
  for (const key of Reflect.ownKeys(value)) {
    const keyExpr = propertyKeyExpression(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;

    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      const parts: string[] = [];
      if (descriptor.get) parts.push(`get: ${emitValue(descriptor.get, ctx)}`);
      if (descriptor.set) parts.push(`set: ${emitValue(descriptor.set, ctx)}`);
      parts.push(`enumerable: ${descriptor.enumerable}`, `configurable: ${descriptor.configurable}`);
      ctx.module.push(`Object.defineProperty(${name}, ${keyExpr}, { ${parts.join(", ")} });`);
      continue;
    }

    const keyName = typeof key === "string" ? key : key.toString();
    const child = transform(value, keyName, descriptor.value, ctx);
    // A replacer that returns undefined omits enumerable string data properties
    // (JSON-like); other shapes keep the value.
    if (child === undefined && typeof key === "string" && descriptor.enumerable) continue;

    if (typeof key === "string" && descriptor.enumerable && descriptor.writable && descriptor.configurable) {
      ctx.module.push(`${name}[${keyExpr}] = ${emitValue(child, ctx)};`);
    } else {
      ctx.module.push(
        `Object.defineProperty(${name}, ${keyExpr}, { value: ${emitValue(child, ctx)}, writable: ${descriptor.writable}, enumerable: ${descriptor.enumerable}, configurable: ${descriptor.configurable} });`,
      );
    }
  }
}

// Maps each well-known symbol to its global expression, so symbol-keyed
// properties survive serialization.
const WELL_KNOWN_SYMBOLS: Array<[symbol, string]> = [
  [Symbol.iterator, "Symbol.iterator"],
  [Symbol.asyncIterator, "Symbol.asyncIterator"],
  [Symbol.hasInstance, "Symbol.hasInstance"],
  [Symbol.isConcatSpreadable, "Symbol.isConcatSpreadable"],
  [Symbol.match, "Symbol.match"],
  [Symbol.matchAll, "Symbol.matchAll"],
  [Symbol.replace, "Symbol.replace"],
  [Symbol.search, "Symbol.search"],
  [Symbol.species, "Symbol.species"],
  [Symbol.split, "Symbol.split"],
  [Symbol.toPrimitive, "Symbol.toPrimitive"],
  [Symbol.toStringTag, "Symbol.toStringTag"],
  [Symbol.unscopables, "Symbol.unscopables"],
];

function propertyKeyExpression(key: string | symbol): string {
  if (typeof key === "string") return JSON.stringify(key);
  const registered = Symbol.keyFor(key);
  if (registered !== undefined) return `Symbol.for(${JSON.stringify(registered)})`;
  for (const entry of WELL_KNOWN_SYMBOLS) {
    if (entry[0] === key) return entry[1];
  }
  throw new TypeError(`Cannot serialize a unique symbol property key (${key.toString()})`);
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

  const reconstructed = reconstructFunctionExpr(fn, ctx);
  // `const <name> = ` adds no newlines, so the source offset within the entry is
  // the offset within the expression.
  ctx.module.push(`const ${name} = ${reconstructed.expr};`);
  recordSourceBlock(ctx, ctx.module.length - 1, reconstructed);
  return name;
}

function recordSourceBlock(ctx: Context, moduleIndex: number, reconstructed: ReconstructedFunction): void {
  const location = reconstructed.location;
  if (location === undefined || !location.url) return;
  ctx.sourceBlocks.push({
    moduleIndex,
    lineOffset: reconstructed.sourceLineOffset,
    url: location.url,
    line: location.line,
    lineCount: reconstructed.sourceLineCount,
  });
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
  // Accessor source from a property descriptor: `get v() {...}` / `set v(n) {...}`
  // (note the space — `get(...)` with no space is a method named "get"). Convert
  // to a plain function expression; the accessor name is irrelevant.
  if (/^(get|set)\s/.test(trimmed)) {
    return `(${trimmed.replace(/^(get|set)\s+[^(]*/, "function ")})`;
  }
  // Method shorthand of any name shape — `foo(){}`, `async foo(){}`, `*gen(){}`,
  // `async *g(){}`, `[Symbol.iterator](){}`, `"str-key"(){}`, `123(){}`. The
  // property name is irrelevant to the function value, so drop it and emit a
  // plain (async/generator) function expression.
  const method = trimmed.match(
    /^(async\s+)?(\*\s*)?(?:[A-Za-z_$][\w$]*|\[[\s\S]*?\]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\d[\w.]*)\s*(\([\s\S]*)$/,
  );
  if (method !== null) {
    const asyncPart = method[1] ? "async " : "";
    const star = method[2] ? "*" : "";
    return `(${asyncPart}function${star} ${method[3]})`;
  }
  // Fallback: wrap and extract by name (should be unreachable for valid sources).
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
