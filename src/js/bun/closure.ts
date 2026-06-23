// bun:closure — experimental closure serialization.
//
// `serialize(fn)` returns the source of an ES module whose `export default` is a
// reconstruction of `fn`, including the state it captures.
//
// Handles: captured primitives; objects/arrays with cycles and shared
// references (deduped by identity); nested functions; shared mutable cells
// across closures (hoisted once, by Symbol.freeVariables id); a JSONStringify
// `replacer(key, value)`; built-ins (Date/RegExp/Map/Set/typed arrays/Error);
// Proxies and bound functions; property descriptors (getters/setters,
// non-enumerable, registered/well-known symbol keys); prototypes (class
// instances via ObjectCreate(Class.prototype), null-proto objects); and class
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
// not preserved; native functions with no reachable global path throw a clear
// error. (Unique non-registered symbols DO round-trip — hoisted with identity
// preserved within the closure.)

type Replacer = (key: string, value: unknown) => unknown;

interface ImportInfo {
  source: string;
  importedName: string;
  kind: "named" | "default" | "namespace";
  external: boolean;
}

interface FreeVariable {
  name: string;
  id: number;
  scopeId: number;
  value: unknown;
  kind: "const" | "let";
  // Present when this binding is an ES-module import. `external` imports (native
  // / node:* / builtins) can't be inlined and are re-emitted as `import`
  // statements; inlinable ones (user modules) serialize their value like any
  // captured value.
  import?: ImportInfo;
}

// Prefix for hoisted reference variables. Must not collide with a captured
// variable name; chosen to be extremely unlikely in user code.
const REF_PREFIX = "__bunClosure$";

// Primordials. A serialize() call must not be subvertible by a caller that has reassigned global
// builtins (e.g. `ObjectKeys = evil`, `Map = class {}`, `JSONStringify = …`). $-intrinsics
// (`$getPrototypeOf`, `$isArray`, `$toString`) bind the originals at bytecode-compile time and are
// immune even to tampering done before this module is first imported; the statics/constructors
// below are snapshotted at module load. Use these everywhere internally — never the live globals.
// Destructured (not `Object.x = …`) so an internal `ObjectCreate`-style call site can never
// alias back to one of these captures during a mechanical rename.
const {
  getPrototypeOf: ObjectGetPrototypeOf,
  getOwnPropertyDescriptor: ObjectGetOwnPropertyDescriptor,
  getOwnPropertyNames: ObjectGetOwnPropertyNames,
  getOwnPropertySymbols: ObjectGetOwnPropertySymbols,
  keys: ObjectKeys,
  create: ObjectCreate,
  defineProperty: ObjectDefineProperty,
  freeze: ObjectFreeze,
  isFrozen: ObjectIsFrozen,
  isSealed: ObjectIsSealed,
  isExtensible: ObjectIsExtensible,
  seal: ObjectSeal,
  preventExtensions: ObjectPreventExtensions,
  setPrototypeOf: ObjectSetPrototypeOf,
} = Object;
const { ownKeys: ReflectOwnKeys } = Reflect;
const { stringify: JSONStringify, parse: JSONParse } = JSON;
const { isInteger: NumberIsInteger } = Number;
const { isView: ArrayBufferIsView } = ArrayBuffer;
const { from: ArrayFrom, isArray: ArrayIsArray } = Array;
// Constructors captured so `instanceof` / `new` can't be redirected by reassigning the global.
const MapCtor = Map;
const SetCtor = Set;
const WeakMapCtor = WeakMap;
const WeakSetCtor = WeakSet;
const WeakRefCtor = WeakRef;
const DateCtor = Date;
const RegExpCtor = RegExp;
const NumberCtor = Number;
const StringCtor = String;
const BooleanCtor = Boolean;
const PromiseCtor = Promise;
const ArrayBufferCtor = ArrayBuffer;
const SharedArrayBufferCtor = typeof SharedArrayBuffer !== "undefined" ? SharedArrayBuffer : undefined;
const ArrayCtor = Array;
const Uint8ArrayCtor = Uint8Array;
// Instance CONTENT is extracted through these snapshotted prototype methods/getters — never a live
// `value.getTime()` / `Map.prototype.entries` / `re.source` read, which goes through the
// user-mutable prototype and would let a caller forge a captured Map/Set/Date/RegExp/boxed
// primitive's serialized contents (the constructors above are snapshotted, but the prototype
// members are not). Mirrors `funcSource` snapshotting `Function.prototype.toString`.
const MapProtoEntries = Map.prototype.entries;
const SetProtoValues = Set.prototype.values;
const DateProtoGetTime = Date.prototype.getTime;
const NumberProtoValueOf = Number.prototype.valueOf;
const StringProtoValueOf = String.prototype.valueOf;
const BooleanProtoValueOf = Boolean.prototype.valueOf;
const RegExpSourceGetter = ObjectGetOwnPropertyDescriptor(RegExp.prototype, "source")!.get!;
const RegExpFlagsGetter = ObjectGetOwnPropertyDescriptor(RegExp.prototype, "flags")!.get!;
// The Map/Set iterator's own `.next` is snapshotted too, so draining can't be redirected by
// overriding `%MapIteratorPrototype%.next`; entries are read by index, never destructured (which
// would consult a user-mutable Array `[Symbol.iterator]`).
const MapIterNext = ObjectGetPrototypeOf(MapProtoEntries.$call(new MapCtor()) as object).next;
const SetIterNext = ObjectGetPrototypeOf(SetProtoValues.$call(new SetCtor()) as object).next;

// Drain a real Map's entries tamper-proof (caller guarantees a genuine [[MapData]] receiver).
function mapEachEntry(m: object, visit: (k: unknown, v: unknown) => void): void {
  const it = MapProtoEntries.$call(m as Map<unknown, unknown>) as object;
  for (;;) {
    const r = MapIterNext.$call(it) as { done?: boolean; value: [unknown, unknown] };
    if (r.done) break;
    visit(r.value[0], r.value[1]);
  }
}
// Drain a real Set's values tamper-proof.
function setEachValue(s: object, visit: (v: unknown) => void): void {
  const it = SetProtoValues.$call(s as Set<unknown>) as object;
  for (;;) {
    const r = SetIterNext.$call(it) as { done?: boolean; value: unknown };
    if (r.done) break;
    visit(r.value);
  }
}

// A function's source. `fn.toString()` looks `toString` up THROUGH fn's prototype chain to
// Function.prototype — for a deep `class extends` chain that walks the whole superclass chain
// (O(depth)) on EVERY `.toString()`, and source is read several times per class during analysis
// and emission (an O(N²) trap). Calling the captured Function.prototype.toString directly skips the
// inherited lookup (O(1) lookup + O(source)). Also tamper-proof.
const functionToStringMethod = Function.prototype.toString;
function funcSource(fn: Function): string {
  return functionToStringMethod.$call(fn);
}

// An `import` statement re-creating an external import binding (native / node:*
// / builtin) that can't be inlined.
function importStatement(variable: FreeVariable): string {
  const info = variable.import!;
  const src = JSONStringify(info.source);
  if (info.kind === "default") return `import ${variable.name} from ${src};`;
  if (info.kind === "namespace") return `import * as ${variable.name} from ${src};`;
  const spec = info.importedName === variable.name ? variable.name : `${info.importedName} as ${variable.name}`;
  return `import { ${spec} } from ${src};`;
}

interface Context {
  // Module-level hoisted declarations (shared cells, object refs, function refs).
  module: string[];
  // Identity -> hoisted variable name, for objects and functions.
  refs: Map<object, string>;
  counter: number;
  // Cell ids (Symbol.freeVariables id) shared by 2+ functions: hoisted to module
  // scope under their original name, skipped in per-function IIFEs.
  sharedIds: Set<number>;
  // External imports (node:*, builtins) re-emitted as `import` statements at the
  // top of the module instead of inlined. Deduplicated.
  imports: Set<string>;
  replacer: Replacer | undefined;
  // Records, for source-map generation, where each reconstructed function's
  // verbatim source lands. `moduleIndex` indexes into `module` (or -1 for the
  // default-export expression).
  sourceBlocks: SourceBlock[];
  // Per captured object value, which own string keys to serialize: a Set of the
  // keys actually referenced by the closure (access-path pruning), or "all" /
  // absent to serialize every key. See computeKeepSets.
  keepSets: Map<object, Set<string> | "all">;
  // Per class prototype reached via instances: the union, across all those instances,
  // of the member keys the closure can actually reach (transitively through `this` /
  // `super` / getters), or "all" if any such instance is kept wholesale. Drives
  // pruning of unreachable prototype methods from an emitted class. See computeKeepSets.
  methodKeep: Map<object, Set<PropertyKey> | "all">;
  // Functions / objects captured as first-class VALUES (a free variable, property
  // value, array/Map/Set element, …) rather than reached merely as the prototype-owner
  // of an instance or a structural `extends` superclass. A class in here is NEVER
  // method-pruned: a direct capture can construct fresh instances or call any method.
  capturedAsValue: Set<object>;
  // Per class fn: the prototype member keys pruneClassMethods removed from its source. The
  // prototype's own-property emit must ALSO skip these, or it would re-add the live method it
  // sees on the prototype (defeating the prune).
  prunedMethods: Map<Function, Set<PropertyKey>>;
  // Unique (non-registered, non-well-known) symbols -> hoisted variable name, so
  // the same captured symbol reconstructs to one symbol (identity preserved
  // within the serialized closure).
  symbols: Map<symbol, string>;
  // For each captured AsyncLocalStorage with an active store at serialize time:
  // the fresh instance's variable name + an expression for the snapshotted store.
  // The reified root function is wrapped so it runs inside `name.run(store, ...)`,
  // re-establishing the async context so `als.getStore()` returns the same store.
  alsContexts: Array<{ name: string; storeExpr: string }>;
  // Classes the reachability pre-pass cleared for GENUINE `#private` reconstruction
  // (real private slots installed via the constructor) rather than mangling. A whole
  // user-class hierarchy qualifies together when nothing in the captured graph would need
  // its privates outside a closed world — no foreign subclass instance and no escaped
  // `#x` closure. See computeGenuineClasses.
  genuineClasses: Set<Function>;
  // Prototype methods/accessors of genuine classes, by function identity → (class, key,
  // kind). A method peeled off a genuine class (extracted or bound) is emitted as a
  // reference through the reconstructed class prototype — which reads the genuine `#x` —
  // instead of being rebuilt standalone (where `this.#x` would have to be mangled).
  genuineMethods: Map<Function, { classFn: Function; key: string | symbol; kind: "method" | "get" | "set" }>;
  // Escaped arrows that read a `#private` through their lexical `this` and ARE hostable
  // (their `this` is an instance of a genuine class declaring the read privates). Each maps
  // to the recovered receiver instance, its class, the synthetic host-method key injected
  // into that class, and the VALUES of the arrow's non-`this` captures (threaded as host
  // arguments). emitFunction reconstructs the arrow as `<instance>.<hostKey>(<args>)`.
  hostedArrows: Map<
    Function,
    { instance: object; classFn: Function; hostKey: string; args: Array<{ name: string; value: unknown }> }
  >;
  // Per genuine class, the host methods to inject into its body, each as
  // `<hostKey>(<params>){ return (<arrow source>); }` — params are the arrow's non-`this`
  // captured variable names (resolved to the call-time arguments).
  classHosts: Map<Function, Array<{ hostKey: string; source: string; params: string[] }>>;
  // For a genuine-private class actually emitted: the reify factory name + the private
  // field names its injected constructor branch installs. Consumed when emitting an
  // instance so it flows through the factory.
  classReify: Map<Function, { factory: string; fields: string[] }>;
  // A stable per-genuine-class id used to namespace patch-method keys, so a private field
  // name that collides across an inheritance chain (`class A { #x } class B extends A { #x }`)
  // maps to distinct keys (each class writes its own genuine slot).
  genuineClassId: Map<Function, number>;
  // Whether any genuine-private class was emitted (so `let REIFY_SLOT` is hoisted).
  needsReifySlot: boolean;
  // Genuine-instance private-field patches (`<vals> = {...}; <Class>.prototype.patch.call(...)`)
  // deferred to the very end of the prelude. A private field can hold a value whose binding is
  // declared LATER than the instance — e.g. a hosted arrow stored in the instance's own private
  // slot, whose `const` is emitted after the instance. Running the patch last (once every
  // hoisted binding exists) avoids a temporal-dead-zone reference. The bare instance is still
  // emitted up front, so identity and cycles resolve.
  deferredPatches: string[];
  // Deferred object BODIES (property assignments, container contents, subclass/freeze
  // restoration). emitObject emits each object's `const name = <base>` declaration synchronously
  // at discovery (so a parent's `name.key = childref` always references an already-declared
  // binding) and enqueues the body here; a drain loop runs them. This bounds emission DEPTH by
  // the heap (the queue), not the JS call stack, so an arbitrarily deep/wide graph serializes
  // without overflowing.
  bodyQueue: Array<() => void>;
  // Functions whose declaration has actually been emitted (not just assigned a ref name).
  // emitFunction emits a function's captured-function dependencies before the function itself
  // (an iterative post-order, so a deep capture chain doesn't overflow), and uses this to know
  // which are already done.
  emittedFns: Set<Function>;
  // Functions whose body is mid-emission (expanded in the post-order but not yet finished),
  // shared across nested emitFunction calls. Emitting a function's own property can hold a
  // function that captures the host back (`F.helper = () => F`), re-entering emitFunction; without
  // a shared in-flight set the host would be re-expanded and double-declared.
  inProgressFns: Set<Function>;
}

interface SourceBlock {
  moduleIndex: number;
  lineOffset: number;
  url: string;
  line: number;
  column: number;
  // The definition's last original line (1-based), when known. `fn.toString()` reprints from
  // the AST, so a compact (e.g. single-line) definition is emitted across more generated lines
  // than the original spans; clamping the per-line walk to this bound stops the source map from
  // pointing past the definition onto unrelated lines. Undefined for classes (anchor derived).
  endLine?: number;
  lineCount: number;
  // The verbatim source emitted for this block. Its body lines keep their
  // original indentation (so their columns map identity), while the first line
  // is the function start (mapped to `column`).
  source: string;
}

// The ALS context-restoration wrapper turns the root into an arrow `(...args) =>
// als.run(store, () => root(...args))`. That only preserves behavior for plain
// and async functions — it breaks `new` on a class and doesn't cover a
// generator's lazily-iterated body. Skip wrapping (reconstruct without context)
// for those.
function rootSupportsAlsWrap(fn: Function): boolean {
  const ctorName = (fn as any)?.constructor?.name;
  if (ctorName === "GeneratorFunction" || ctorName === "AsyncGeneratorFunction") return false;
  let source: string;
  try {
    source = funcSource(fn);
  } catch {
    return false;
  }
  return !source.trimStart().startsWith("class");
}

function serialize(fn: Function, replacer?: Replacer): string {
  if (typeof fn !== "function") {
    throw new TypeError("serialize() expects a function");
  }
  // The whole pipeline — the analysis pre-passes AND the emission — walks the captured graph
  // recursively, so a deep chain (a long linked list, or a wide graph with a long acyclic
  // emission path) overflows the JS stack. Surface a clear, catchable serializer error rather
  // than leaking a bare RangeError. (No user code runs during the walk, so a stack-overflow
  // RangeError here is unambiguously ours.)
  try {
    return serializeImpl(fn, replacer);
  } catch (e) {
    if (e instanceof RangeError && /call stack/i.test(e.message)) {
      throw new TypeError(
        "Cannot serialize: the captured object graph is too deeply nested (the reconstruction " +
          "exceeded the call-stack limit). Flatten the graph or reduce its depth.",
      );
    }
    throw e;
  }
}

// A root function/class whose own state — static field values, externally-assigned properties, or
// monkey-patched prototype members — would be silently dropped by the inline reconstructFunctionExpr
// path (it neutralizes static initializers and emits no restore). Such a root must go through the
// binding path (emitFunction → emitFunctionContent), which restores that state via emitOwnProperties.
function rootNeedsBindingForOwnState(fn: Function): boolean {
  const source = funcSource(fn);
  const memberKeys = sourceDefinedMemberKeys(source);
  // Any own property the source doesn't already declare (a static field, an externally-assigned or
  // non-enumerable prop, a monkey-patched prototype member) is runtime state the inline path drops.
  // Route to the binding path on any of these. A false positive only makes output slightly more
  // verbose; a false negative silently loses data.
  const hasRuntimeOwn = (o: object, skip: Set<PropertyKey>): boolean => {
    for (const key of ReflectOwnKeys(o)) if (!skip.has(key)) return true;
    return false;
  };
  if (hasRuntimeOwn(fn, memberKeys.staticKeys)) return true;
  // frozen / sealed / preventExtensions on the function itself
  if (!ObjectIsExtensible(fn)) return true;
  // an overridden `.name` (a plain function's `.name` is its source-derived id, or "" when none;
  // if the live name can't be produced by the source, the binding path must restore it)
  if (typeof fn.name === "string") {
    const declaredName = parseFunctionNode(source)?.id?.name;
    if (fn.name !== (declaredName ?? "")) return true;
  }
  // an overridden `.length` (descriptor value differs from natural arity)
  const natural = naturalArityFromSource(source);
  if (natural !== undefined && fn.length !== natural) return true;
  const proto = (fn as { prototype?: object }).prototype;
  if (typeof proto === "object" && proto !== null && proto !== Function.prototype) {
    // frozen / sealed / preventExtensions on the prototype, or a monkey-patched member
    if (!ObjectIsExtensible(proto)) return true;
    if (hasRuntimeOwn(proto, memberKeys.instanceKeys)) return true;
  }
  return false;
}

function serializeImpl(fn: Function, replacer?: Replacer): string {
  const { sharedIds, cellInfo } = analyzeSharedCells(fn);
  // Start the generated-ref counter past any `__bunClosure$N` already present as a
  // free-variable name, so re-serializing already-serialized output (whose
  // generated names become free variables) doesn't collide.
  let counterStart = 0;
  for (const variable of cellInfo.values()) {
    const m = /^__bunClosure\$(\d+)$/.exec(variable.name);
    if (m !== null) counterStart = Math.max(counterStart, Number(m[1]) + 1);
  }
  const genuinePlan = computeGenuineClasses(fn, sharedIds);
  const keep = computeKeepSets(fn);
  const ctx: Context = {
    module: [],
    refs: new MapCtor(),
    counter: counterStart,
    sharedIds,
    imports: new SetCtor(),
    replacer: typeof replacer === "function" ? replacer : undefined,
    sourceBlocks: [],
    keepSets: keep.keepSets,
    methodKeep: keep.methodKeep,
    capturedAsValue: keep.capturedAsValue,
    symbols: new MapCtor(),
    alsContexts: [],
    genuineClasses: genuinePlan.genuine,
    genuineMethods: computeGenuineMethods(genuinePlan.genuine),
    hostedArrows: genuinePlan.hostedArrows,
    classHosts: genuinePlan.classHosts,
    classReify: new MapCtor(),
    genuineClassId: new MapCtor(),
    needsReifySlot: false,
    deferredPatches: [],
    bodyQueue: [],
    emittedFns: new SetCtor(),
    inProgressFns: new SetCtor(),
    prunedMethods: new MapCtor(),
  };

  // Emit shared cells at module scope (deduped by id) before any function that
  // closes over them. Distinct shared cells with the same name can't coexist.
  const namesById = new MapCtor<string, number>();
  for (const id of sharedIds) {
    const cell = cellInfo.get(id)!;
    // External imports are re-emitted as `import` statements, not inlined.
    if (cell.import?.external) {
      ctx.imports.add(importStatement(cell));
      continue;
    }
    const claimed = namesById.get(cell.name);
    if (claimed !== undefined && claimed !== id) {
      throw new TypeError(`Cannot serialize: two distinct shared variables are both named "${cell.name}"`);
    }
    namesById.set(cell.name, id);
    const value = transform(undefined, cell.name, cell.value, ctx);
    ctx.module.push(`${cell.kind} ${cell.name} = ${emitValue(value, ctx)};`);
  }

  // A bound or native root is emitted via the value path (bound → .bind(...), native → its
  // global path) and exported by reference; a hostable escaped `#private` arrow is emitted via
  // its host method on the reified receiver (emitFunction) — reconstructFunctionExpr has no
  // hosting branch and would emit `this.#x` off an unbound `this`. Otherwise reconstruct inline.
  let exportExpr: string;
  let exportReconstructed: ReconstructedFunction | undefined;
  if (
    (fn as any)[Symbol.boundFunction] !== undefined ||
    ctx.hostedArrows.has(fn) ||
    isNativeFunctionSource(funcSource(fn)) ||
    rootNeedsBindingForOwnState(fn)
  ) {
    exportExpr = emitFunction(fn, ctx);
  } else {
    exportReconstructed = reconstructFunctionExpr(fn, ctx);
    exportExpr = exportReconstructed.expr;
  }

  // Re-establish the captured AsyncLocalStorage context(s): wrap the root so each call runs
  // inside `als.run(store, ...)`, restoring `als.getStore()`. The wrapper is a regular
  // `function` (NOT an arrow): an arrow drops `this` and is non-constructable, so a plain
  // `function` root invoked with `.call`/`.apply` or `new` would break. `new.target`
  // branches between construct (`new __root(...)`, giving the instance the root's prototype)
  // and call (`__root.apply(this, ...)`, forwarding `this`). A Proxy wrapper would be more
  // transparent but its `toString` reports native code, so the reconstructed root couldn't be
  // re-serialized. The root is bound once via an IIFE so it isn't duplicated across branches
  // or nesting levels. Only plain/async functions are wrapped: a generator's body runs lazily
  // after `run` returns (context wouldn't be active during iteration). Nested wrappers
  // compose — the outer call/construct re-enters the inner wrapper, so every context is active.
  if (rootSupportsAlsWrap(fn)) {
    for (const { name, storeExpr } of ctx.alsContexts) {
      exportExpr =
        `(__root => function (...__a) { return new.target ` +
        `? ${name}.run(${storeExpr}, () => new __root(...__a)) ` +
        `: ${name}.run(${storeExpr}, () => __root.apply(this, __a)); })(${exportExpr})`;
    }
  }

  // Drain deferred object BODIES iteratively (a growing FIFO worklist, not recursion) so an
  // arbitrarily deep/wide graph emits without overflowing the stack. Each body op references
  // bindings declared at discovery; running a body may discover (and enqueue) more objects.
  for (let i = 0; i < ctx.bodyQueue.length; i++) ctx.bodyQueue[i]();

  // Genuine-instance private patches run last, after every hoisted binding (including any
  // hosted arrow a private slot points at) has been declared.
  for (const line of ctx.deferredPatches) ctx.module.push(line);

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
      column: exportReconstructed.location.column,
      endLine: exportReconstructed.location.endLine,
      lineCount: exportReconstructed.sourceLineCount,
      source: exportReconstructed.source,
    });
  }

  // External imports are re-emitted at the very top; they shift every generated
  // line down, so the source map is offset by their count to stay correct.
  const importBlock = ctx.imports.size > 0 ? [...ctx.imports].join("\n") + "\n" : "";
  // The genuine-private reify slot (if any) is hoisted just below the imports and counts
  // as another leading line for the source map.
  const reifyBlock = ctx.needsReifySlot ? `let ${REIFY_SLOT} = false;\n` : "";
  const leadingLines = ctx.imports.size + (ctx.needsReifySlot ? 1 : 0);

  let output = `${importBlock}${reifyBlock}${prelude}export default ${exportExpr};\n`;
  const sourceMap = buildSourceMap(ctx.sourceBlocks, moduleStartLines, preludeLineCount, leadingLines);
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

// Number of leading space/tab characters on a line (its indentation width).
function leadingWhitespace(line: string): number {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i++;
  }
  return i;
}

// Builds a v3 source map (as a JSON string) mapping the generated module back to
// the original source files, or undefined if there is nothing to map. The source
// is emitted verbatim, so columns are accurate: a block's first line maps to the
// function's start column (`block.column`); each body line keeps its original
// indentation, so its content-start column maps identity. One segment per line
// at the content start (the position a stack frame reports).
function buildSourceMap(
  blocks: SourceBlock[],
  moduleStartLines: number[],
  preludeLineCount: number,
  leadingLines: number = 0,
): string | undefined {
  if (blocks.length === 0) return undefined;

  const sources: string[] = [];
  const sourceIndexByUrl = new MapCtor<string, number>();
  // genLine -> [sourceIndex, srcLine0, genColumn, srcColumn]
  const mapped = new MapCtor<number, [number, number, number, number]>();
  let maxLine = 0;

  for (const block of blocks) {
    let sourceIndex = sourceIndexByUrl.get(block.url);
    if (sourceIndex === undefined) {
      sourceIndex = sources.length;
      sources.push(block.url);
      sourceIndexByUrl.set(block.url, sourceIndex);
    }
    const genStart =
      leadingLines +
      (block.moduleIndex === -1 ? preludeLineCount : moduleStartLines[block.moduleIndex]) +
      block.lineOffset;
    const sourceLines = block.source.split("\n");
    for (let k = 0; k < block.lineCount; k++) {
      const genLine = genStart + k;
      let genColumn: number;
      let srcColumn: number;
      if (k === 0) {
        // First line is the function start. `fn.toString()` strips its leading
        // indent (so it begins at generated column 0 of its placed line), and it
        // maps to the original definition column. `location.column` is 1-based.
        genColumn = 0;
        srcColumn = block.column > 0 ? block.column - 1 : 0;
      } else {
        // Body lines are verbatim — same indentation in generated and original —
        // so the content-start column maps identity.
        const ws = leadingWhitespace(sourceLines[k] ?? "");
        genColumn = ws;
        srcColumn = ws;
      }
      // Map generated body line `k` to original line `block.line - 1 + k`. `fn.toString()`
      // reprints from the AST, so a compact definition is emitted across MORE generated lines
      // than the original spans; without a bound the walk runs past the definition onto
      // unrelated later lines (or past EOF). Clamp to the definition's last original line when
      // known (functions expose it via Symbol.sourceLocation.endLine; classes don't, so they
      // fall back to the unclamped walk). Also clamp ≥ 0 (a negative line crashes the parser).
      const upper = block.endLine !== undefined ? block.endLine - 1 : Infinity;
      const srcLine = Math.max(0, Math.min(upper, block.line - 1 + k));
      mapped.set(genLine, [sourceIndex, srcLine, genColumn, srcColumn]);
      if (genLine > maxLine) maxLine = genLine;
    }
  }

  let prevSource = 0;
  let prevSrcLine = 0;
  let prevSrcColumn = 0;
  const lines: string[] = [];
  for (let g = 0; g <= maxLine; g++) {
    const entry = mapped.get(g);
    if (entry === undefined) {
      lines.push("");
      continue;
    }
    const [sourceIndex, srcLine, genColumn, srcColumn] = entry;
    // One segment per line: [generatedColumnDelta, sourceIndexDelta,
    // sourceLineDelta, sourceColumnDelta]. generatedColumn resets to 0 each line
    // (so its delta is the absolute column); the rest are cumulative.
    lines.push(
      vlqEncode(genColumn) +
        vlqEncode(sourceIndex - prevSource) +
        vlqEncode(srcLine - prevSrcLine) +
        vlqEncode(srcColumn - prevSrcColumn),
    );
    prevSource = sourceIndex;
    prevSrcLine = srcLine;
    prevSrcColumn = srcColumn;
  }

  return JSONStringify({ version: 3, sources, names: [], mappings: lines.join(";") });
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

// Visits a Map's keys+values / a Set's elements via the BASE iterator (never a user override),
// for the analysis graph walks. Map/Set CONTENTS are reconstructed at emit time, so the analysis
// pre-passes must see them too — otherwise a value reachable ONLY through a Map/Set (a genuine
// #private instance, a hostable escaped arrow) is invisible to genuine-class / hosted-arrow /
// keep-set planning (privacy silently downgraded to mangling; a hostable arrow wrongly rejected).
function forEachMapSetEntry(o: object, visit: (v: unknown) => void): void {
  // `instanceof` is necessary but not sufficient: a Map/Set SUBCLASS's `.prototype` object is
  // `instanceof Map`/`Set` yet has no internal [[MapData]]/[[SetData]] slot (the analysis walks
  // prototypes), so the base iterator throws on it. Guard with try/catch — a non-real receiver
  // simply has no entries to walk.
  try {
    if (o instanceof MapCtor) {
      mapEachEntry(o, (k, v) => {
        visit(k);
        visit(v);
      });
    } else if (o instanceof SetCtor) {
      setEachValue(o, visit);
    }
  } catch {}
}

// Walks the function graph reachable from `root` and finds cells referenced by
// more than one function — those must share a single binding.
function analyzeSharedCells(root: Function): { sharedIds: Set<number>; cellInfo: Map<number, FreeVariable> } {
  const cellFunctions = new MapCtor<number, Set<Function>>();
  const cellInfo = new MapCtor<number, FreeVariable>();
  const seenFns = new SetCtor<Function>();
  const seenObjs = new SetCtor<object>();

  // Function -> the functions it captures (free-var values that are functions).
  const fnEdges = new MapCtor<Function, Set<Function>>();
  // Cell id -> its value, when that value is a function. Used to hoist cells
  // whose function participates in a reference cycle.
  const cellValueFn = new MapCtor<number, Function>();

  // Iterative graph walk (an explicit heap stack, not the JS call stack) so a deep object
  // chain doesn't overflow. The result is order-independent (it only fills sets/maps), so any
  // visit order is fine. `enqueue` pushes objects/functions; `processValue` pops and expands.
  const stack: unknown[] = [];
  function enqueue(value: unknown): void {
    if (value === null) return;
    const t = typeof value;
    if (t === "function" || t === "object") stack.push(value);
  }
  function processValue(value: unknown): void {
    // An AsyncLocalStorage instance is reconstructed wholesale (fresh instance);
    // never walk its native internals (they reach unserializable functions).
    if (isAsyncLocalStorage(value as object)) return;
    if ($isProxyObject(value)) {
      // Don't trap through the proxy; analyze its real target and handler.
      const handler = $getProxyInternalField(value, $proxyFieldHandler);
      if (handler === null) return; // revoked: emit will throw later
      enqueue($getProxyInternalField(value, $proxyFieldTarget));
      enqueue(handler);
      return;
    }
    if (typeof value === "function") {
      const bound = (value as any)[Symbol.boundFunction] as BoundDetails | undefined;
      if (bound !== undefined) {
        enqueue(bound.target);
        enqueue(bound.boundThis);
        for (const arg of bound.boundArgs) enqueue(arg);
        return;
      }
      processFn(value as Function);
    } else {
      processObj(value as object);
    }
  }
  function processObj(o: object): void {
    if (seenObjs.has(o)) return;
    seenObjs.add(o);
    // A well-known global (Math/console/globalThis/...) is emitted as a reference to its path,
    // not walked — don't descend into its (native, host-specific) internals during analysis.
    if (nativeObjectPath(o) !== undefined) return;
    if (ArrayIsArray(o)) {
      const arr = o as unknown[];
      for (const i of arrayPresentIndices(arr)) enqueue(arr[i]);
      return;
    }
    // Walk own properties via descriptors so getters aren't invoked here (their
    // values are reconstructed lazily, not eagerly).
    for (const key of ReflectOwnKeys(o)) {
      const descriptor = ObjectGetOwnPropertyDescriptor(o, key)!;
      if (descriptor.get) enqueue(descriptor.get);
      if (descriptor.set) enqueue(descriptor.set);
      if ("value" in descriptor) enqueue(descriptor.value);
    }
    // A class instance is reconstructed via its class, so analyze that too.
    const proto = ObjectGetPrototypeOf(o);
    if (proto !== null && proto !== Object.prototype) {
      const ctor = (proto as any).constructor;
      enqueue(typeof ctor === "function" && ctor.prototype === proto ? ctor : proto);
    }
    const privateFields = (o as any)[Symbol.privateFields] as Array<{ value: unknown }> | undefined;
    if (privateFields) for (const field of privateFields) enqueue(field.value);
    forEachMapSetEntry(o, enqueue);
  }
  function processFn(fn: Function): void {
    if (seenFns.has(fn)) return;
    seenFns.add(fn);
    let source: string;
    try {
      source = funcSource(fn);
    } catch {
      return;
    }
    const edges = new SetCtor<Function>();
    fnEdges.set(fn, edges);
    const freeVariables = allFreeVariables(fn, source);
    for (const variable of freeVariables) {
      let set = cellFunctions.get(variable.id);
      if (set === undefined) {
        set = new SetCtor();
        cellFunctions.set(variable.id, set);
        cellInfo.set(variable.id, variable);
      }
      set.add(fn);
      // An external import (node:*, a package) is re-emitted as an `import` statement; its
      // VALUE is never inlined, so don't walk its implementation graph. Walking it dives into
      // a JS-implemented builtin's native internals (e.g. node:util `format`) and throws.
      // Mirrors the skip in reconstructFunctionExpr and the shared-cell emit loop.
      if (variable.import?.external) continue;
      if (typeof variable.value === "function") {
        edges.add(variable.value as Function);
        cellValueFn.set(variable.id, variable.value as Function);
      }
      enqueue(variable.value);
    }
    // A class's superclass is reconstructed too, so analyze it.
    const superclass = ObjectGetPrototypeOf(fn);
    if (typeof superclass === "function" && superclass !== Function.prototype) {
      enqueue(superclass);
    }
  }

  enqueue(root);
  while (stack.length > 0) processValue(stack.pop());

  const cyclic = findCyclicFunctions(fnEdges);

  const sharedIds = new SetCtor<number>();
  for (const [id, fns] of cellFunctions) {
    // A cell is hoisted to module scope (referenced live by name) if it is
    // shared by 2+ functions, OR if its value is a function in a reference
    // cycle (self-recursion or mutual recursion) — an IIFE-`const` binding
    // can't forward-reference a cycle.
    if (fns.size >= 2 || cyclic.has(cellValueFn.get(id) as Function)) sharedIds.add(id);
  }
  return { sharedIds, cellInfo };
}

// ── Access-path analysis ────────────────────────────────────────────────────
// Determine, for each captured object, which of its properties the closure
// actually references, so only those are serialized. Sound by construction:
// any usage we can't prove is a clean static property read marks the value as
// "used wholly" (keep everything), and we never under-serialize.

let cachedTranspiler: any;
function getTranspiler(): any {
  return (cachedTranspiler ??= new (globalThis as any).Bun.Transpiler());
}

interface AccessNode {
  all: boolean; // value is used in its entirety → keep all of it
  children: Map<string, AccessNode>; // statically read string-property paths
  calledMethods: Set<string>; // props invoked as `base.prop(...)` (this is bound to base)
}
function newAccessNode(): AccessNode {
  return { all: false, children: new MapCtor(), calledMethods: new SetCtor() };
}
function accessChild(node: AccessNode, prop: string): AccessNode {
  let c = node.children.get(prop);
  if (c === undefined) {
    c = newAccessNode();
    node.children.set(prop, c);
  }
  return c;
}

// Extract the function/class node from a parsed program, or null.
function extractCallableNode(prog: any): any | null {
  const body = prog?.body;
  if (!$isJSArray(body) || body.length === 0) return null;
  const first = body[0];
  if (first.type === "FunctionDeclaration" || first.type === "ClassDeclaration") return first;
  if (first.type === "ExpressionStatement") {
    const e = first.expression;
    if (
      e &&
      (e.type === "ArrowFunctionExpression" || e.type === "FunctionExpression" || e.type === "ClassExpression")
    ) {
      return e;
    }
    // method shorthand: `m(){}`, `get x(){}`, `async *m(){}`, `[sym](){}`
    if (e && e.type === "ObjectExpression" && e.properties?.length) {
      const p = e.properties[0];
      if (p && p.value) return p.value;
    }
  }
  return null;
}

// Source-keyed parse cache. A parse is a pure function of the source string, and EVERY caller
// treats the returned node as READ-ONLY (walks it / reads positions; none mutate), so it's safe
// to share one parse across the many passes that re-parse the same function — serialize() walks
// each captured function ~5× (analysis pre-passes + reconstruction), and a deep chain of
// identical-source closures parsed each one anew. Bounded (FIFO eviction) so a long-lived process
// serializing many DISTINCT closures doesn't grow it without limit; a single serialize() of a
// large same-source graph keeps its one entry hot.
const parseCache = new MapCtor<string, { node: any; offset: number } | null>();
const PARSE_CACHE_CAP = 4096;

// Parse a function's source (in any form `Function.prototype.toString` yields)
// and return its AST node plus the column `offset` of `source` within the code
// that actually parsed — each wrapper shifts node positions by its prefix length,
// so a node at AST position P sits at `source` position `P - offset`.
function parseWithOffset(source: string): { node: any; offset: number } | null {
  const cached = parseCache.get(source);
  if (cached !== undefined || parseCache.has(source)) return cached ?? null;
  const result = parseWithOffsetUncached(source);
  if (parseCache.size >= PARSE_CACHE_CAP) {
    const oldest = parseCache.keys().next().value;
    if (oldest !== undefined) parseCache.delete(oldest);
  }
  parseCache.set(source, result);
  return result;
}

function parseWithOffsetUncached(source: string): { node: any; offset: number } | null {
  const t = getTranspiler();
  const attempts: ReadonlyArray<readonly [string, number]> = [
    ["(" + source + ")", 1],
    [source, 0],
    ["({" + source + "})", 2],
  ];
  for (const [code, offset] of attempts) {
    let prog: any;
    try {
      prog = t.ast(code);
    } catch {
      continue;
    }
    const node = extractCallableNode(prog);
    if (node !== null) return { node, offset };
  }
  return null;
}

// Parse a function's source and return its AST node, or null if it can't parse.
function parseFunctionNode(source: string): any | null {
  return parseWithOffset(source)?.node ?? null;
}

// The natural `.length` (arity) a function's source produces: the count of leading formal params,
// stopping BEFORE the first one with a default (AssignmentPattern) or a rest element (RestElement)
// — neither is counted, matching the spec. A `class` carries its constructor's params on the
// constructor method. Returns undefined if the source can't be parsed. Used to detect a
// `defineProperty(fn,"length",{value:N})` override, otherwise indistinguishable from the natural one.
function naturalArityFromSource(source: string): number | undefined {
  const node = parseFunctionNode(source);
  let params: any[] | undefined;
  if (node?.type === "ClassDeclaration" || node?.type === "ClassExpression") {
    const body = node.body?.body;
    if ($isJSArray(body)) {
      for (const member of body) {
        if (member?.kind === "constructor") {
          params = member.value?.params;
          break;
        }
      }
    }
    if (params === undefined) return 0; // no explicit constructor → arity 0
  } else if (node !== null && typeof node === "object") {
    params = node.params;
  }
  if (!$isJSArray(params)) return undefined;
  let count = 0;
  for (const p of params!) {
    if (p?.type === "AssignmentPattern" || p?.type === "RestElement") break;
    count++;
  }
  return count;
}

// The own-property KEY a class member declares, or undefined for a `#private` field or an
// unresolvable computed key. Resolves plain string/number keys, computed string literals, and the
// two statically-knowable symbol forms (`[Symbol.iterator]`, `[Symbol.for("x")]`).
function memberKeyOf(m: any): string | symbol | undefined {
  const key = m?.key;
  if (key === undefined || key === null) return undefined;
  if (key.type === "PrivateIdentifier") return undefined;
  if (typeof key.value === "string") return key.value; // StringLiteral (incl. computed `["x"]`)
  if (typeof key.value === "number") return String(key.value);
  if (m.computed !== true && typeof key.name === "string") return key.name; // Identifier
  if (key.type === "MemberExpression" && key.object?.name === "Symbol" && typeof key.property?.name === "string") {
    const s = (Symbol as any)[key.property.name];
    if (typeof s === "symbol") return s;
  }
  if (
    key.type === "CallExpression" &&
    key.callee?.object?.name === "Symbol" &&
    key.callee?.property?.name === "for" &&
    typeof key.arguments?.[0]?.value === "string"
  ) {
    return Symbol.for(key.arguments[0].value);
  }
  return undefined;
}

// The own-property keys a class/function's RECONSTRUCTED SOURCE already defines, so emitting them
// again would duplicate a member or clobber a genuine-method reference. The constructor side gets
// the structural keys (name/length/prototype) + static member keys; the prototype side gets
// `constructor` + instance member keys. A plain function declares no members, so only the
// structural keys are skipped — letting emitOwnProperties (with enumerableOnly=false) emit
// runtime-added own props of ANY enumerability, fixing the non-enumerable-drop.
function sourceDefinedMemberKeys(source: string): { staticKeys: Set<PropertyKey>; instanceKeys: Set<PropertyKey> } {
  const staticKeys = new SetCtor<PropertyKey>(["name", "length", "prototype"]);
  const instanceKeys = new SetCtor<PropertyKey>(["constructor"]);
  const node = parseFunctionNode(source);
  const body = node?.body?.body;
  if ((node?.type === "ClassDeclaration" || node?.type === "ClassExpression") && $isJSArray(body)) {
    for (const m of body) {
      // Only METHODS/accessors are recreated by the class expression and must be skipped. A static
      // FIELD is declared but its value was neutralized to `undefined` (so the reify factory re-runs
      // no side effects) and must be RESTORED by emitOwnProperties — so it is NOT skipped.
      if (m?.type !== "MethodDefinition") continue;
      const k = memberKeyOf(m);
      if (k === undefined) continue;
      (m.static === true ? staticKeys : instanceKeys).add(k);
    }
  }
  return { staticKeys, instanceKeys };
}

// The member keys (instance or static, per `isStatic`) whose live function was REPLACED at runtime
// after the class was declared (`Class.prototype.read = fn`, `Class.s = fn`, or via
// `Object.defineProperty`). The emitted class source is reprinted from `toString()`, which still
// shows the ORIGINAL body, and the own-property emit normally SKIPS every key the class body
// declares — so an override would be silently lost (the stale original wins). These keys must be
// un-skipped so the live override is re-emitted (overwriting the inline original).
//
// Detection is by source identity, robust across method kinds and override mechanisms: an
// un-replaced class method's own `toString()` is byte-identical to its text inside the class
// source, so if the class source does NOT contain the live function's source at the member's start,
// the method was replaced. `original` MUST be the unmodified `fn.toString()` (not a mangled/pruned
// reconstruction) so a `#private`-reading method's live `#x` source still matches. Two subtleties:
//   - KIND FLIP: the live function is read off the SOURCE member's kind; if that descriptor slot is
//     empty (a method replaced by an accessor, or vice versa, or by a non-function value), the
//     runtime shape no longer matches the source — that is itself an override, so flag the key.
//   - STATIC ANCHOR: a static member's own `toString()` OMITS the `static` keyword (unlike
//     get/set/async/*, which it keeps), so for statics the match anchor advances past `static` and
//     the following whitespace — else every un-replaced static would falsely flag (and a static
//     `super` method would then re-emit standalone: a syntax error).
// Only string/identifier-keyed, non-computed members are considered.
function overriddenMemberKeys(fn: Function, original: string, isStatic: boolean): Set<PropertyKey> {
  const result = new SetCtor<PropertyKey>();
  const holder = isStatic ? (fn as object) : (fn as { prototype?: object }).prototype;
  if (holder === null || (typeof holder !== "object" && typeof holder !== "function")) return result;
  const parsed = parseWithOffset(original);
  const members = parsed?.node?.body?.body;
  if (parsed === null || !$isJSArray(members)) return result;
  for (const m of members) {
    if (m?.type !== "MethodDefinition" || (m.static === true) !== isStatic || m.computed === true) continue;
    if (m.key?.type === "PrivateIdentifier") continue;
    const key = memberKeyOf(m);
    if (key === undefined || key === "constructor") continue;
    const d = ObjectGetOwnPropertyDescriptor(holder, key);
    if (d === undefined) continue;
    // Read the live function off the SOURCE member's kind. An empty slot means the live descriptor
    // changed shape (method↔accessor, or replaced by a non-function value) — itself an override.
    const live = m.kind === "get" ? d.get : m.kind === "set" ? d.set : d.value;
    if (typeof live !== "function") {
      result.add(key);
      continue;
    }
    let at = typeof m.memberStart === "number" ? m.memberStart - parsed.offset : -1;
    if (at < 0) continue;
    if (isStatic && original.startsWith("static", at)) {
      // `memberStart` is the `static` keyword; the function's own toString omits it.
      at += "static".length;
      while (at < original.length) {
        const c = original.charCodeAt(at);
        if (c === 32 || c === 9 || c === 10 || c === 13) at++;
        else break;
      }
    }
    let liveSrc: string;
    try {
      liveSrc = funcSource(live);
    } catch {
      continue;
    }
    if (!original.startsWith(liveSrc, at)) result.add(key);
  }
  return result;
}

// True if `mangledSource` (the post-`#x`-rewrite form — `#x` outside a class body is a
// syntax error to parse standalone) is an arrow function that reads a private through its
// lexical `this`: `this.<mangled>` or `"<mangled>" in this`. Such an arrow is reconstructed
// by hosting (its receiver is recovered natively); if it can't be hosted it's rejected
// rather than emitted as a private read off an unbound `this`.
function arrowReadsLexicalThisPrivate(mangledSource: string): boolean {
  const node = parseFunctionNode(mangledSource);
  if (node?.type !== "ArrowFunctionExpression") return false;
  const isMangled = (s: unknown): boolean => typeof s === "string" && s.startsWith(PRIVATE_PREFIX);
  // The arrow's lexical `this` resolves to module scope when parsed standalone, which the
  // transpiler lowers to `exports`; a nested function's dynamic `this` stays a real
  // ThisExpression (and we don't descend into those). At the arrow's own level both forms
  // denote the captured `this`.
  const isLexicalThis = (n: any): boolean =>
    n?.type === "ThisExpression" || (n?.type === "Identifier" && n.name === "exports");
  let found = false;
  const walk = (n: any): void => {
    if (found || n === null || typeof n !== "object") return;
    if ($isJSArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    // this.<mangledPrivate>
    if (n.type === "MemberExpression" && isLexicalThis(n.object) && isMangled(n.property?.name ?? n.property?.value)) {
      found = true;
      return;
    }
    // "<mangledPrivate>" in this  (rewritten brand check)
    if (n.type === "BinaryExpression" && n.operator === "in" && isLexicalThis(n.right) && isMangled(n.left?.value)) {
      found = true;
      return;
    }
    // A nested `function`/class rebinds `this`; only nested arrows share the lexical one.
    if (
      n.type === "FunctionExpression" ||
      n.type === "FunctionDeclaration" ||
      n.type === "ClassExpression" ||
      n.type === "ClassDeclaration"
    ) {
      return;
    }
    for (const k in n) {
      if (k !== "start") walk(n[k]);
    }
  };
  walk(node.body);
  return found;
}

// True if `source` is an arrow that uses its lexical `this` at its own level (a member
// access, brand check, or `this` itself — public OR private). Such an arrow can't be
// reconstructed standalone: its `this` (the receiving instance) is baked in lexically. The
// genuine-private ones are hosted; anything else (e.g. `() => this.x` reading a public
// field) is rejected rather than emitted with an unbound `this`. Nested functions rebind
// `this`, so they're not descended into.
function arrowReadsLexicalThis(source: string): boolean {
  const node = parseFunctionNode(source);
  if (node?.type !== "ArrowFunctionExpression") return false;
  const isLexicalThis = (n: any): boolean =>
    n?.type === "ThisExpression" || (n?.type === "Identifier" && n.name === "exports");
  let found = false;
  const walk = (n: any): void => {
    if (found || n === null || typeof n !== "object") return;
    if ($isJSArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (isLexicalThis(n)) {
      found = true;
      return;
    }
    if (
      n.type === "FunctionExpression" ||
      n.type === "FunctionDeclaration" ||
      n.type === "ClassExpression" ||
      n.type === "ClassDeclaration"
    ) {
      return;
    }
    for (const k in n) {
      if (k !== "start") walk(n[k]);
    }
  };
  walk(node.body);
  return found;
}

// True if the reconstructed callable's OWN body uses `super` (`super.x`, `super[x]`,
// `super(...)`). `super` needs a [[HomeObject]] that a standalone reconstruction can't
// provide — emitting `(function(){ ... super ... })` is a syntax error. Nested functions,
// object-methods, and classes carry their own home object and are emitted verbatim within
// their container, so the walk skips into them (it only flags `super` at the top level).
function functionUsesSuper(source: string): boolean {
  const node = parseFunctionNode(source);
  if (node === null) return false;
  let found = false;
  const walk = (n: any): void => {
    if (found || n === null || typeof n !== "object") return;
    if ($isJSArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (n.type === "Super") {
      found = true;
      return;
    }
    if (
      n.type === "FunctionExpression" ||
      n.type === "FunctionDeclaration" ||
      n.type === "ClassExpression" ||
      n.type === "ClassDeclaration"
    ) {
      return;
    }
    for (const k in n) {
      if (k !== "start") walk(n[k]);
    }
  };
  walk(node.body);
  return found;
}

// Module-level flag set true while a reify factory constructs a BARE genuine-private
// instance, so the injected constructor branch skips the original body; `false`/null
// otherwise, so a normal `new` is unaffected.
const REIFY_SLOT = "$bunClosureReify$";
// The per-class method injected to install that class's private fields from a values
// object, called on the bare instance AFTER all instances exist (so cycles work).
const PATCH_METHOD = "__bunReifyPatch";

// Names that the reconstruction machinery itself introduces into a class's source and must
// NEVER be treated as a user free variable / re-bound on RE-serialization:
//   - `#private` brands are recreated by the class body itself (the receiver carries the slot).
//   - `$bunClosureReify$` (REIFY_SLOT) appears as a bare identifier in a reconstructed class's
//     field-init guard `<key> = $bunClosureReify$ ? undefined : (<init>)` and in the constructor
//     reify branch. It is reconstructed by the MODULE (the hoisted `let`), so re-binding it to a
//     LOCAL `const $bunClosureReify$ = false` inside the class's IIFE would shadow the module-level
//     mutable slot the reify factory toggles — the "bare" construct would then re-run every
//     instance initializer. Filtered on EVERY path that gathers free variables (Symbol.freeVariables
//     scan AND the AST-driven field-initializer scan), so re-serialization stays idempotent.
const isInternalFreeVariableName = (name: string): boolean => name.startsWith("#") || name === REIFY_SLOT;
// Builtin bases a genuine subclass can extend: their no-arg `super()` yields a valid empty
// instance and their content is restorable (Map.set/Set.add/array indices) after construction.
const RECONSTRUCTABLE_BUILTIN_BASES: Set<unknown> = new SetCtor([MapCtor, SetCtor, ArrayCtor]);

// Parse `source` and, if it is a base class (no heritage) declaring `#private` data
// fields, return those field names plus the parse offset; else null. This is the
// STRUCTURAL eligibility check; whether genuine reconstruction is actually safe in
// the captured graph is decided separately by the reachability gate (ctx.genuineClasses).
type ClassStructure = { fields: string[]; isDerived: boolean; node: any; offset: number };
function classStructure(source: string): ClassStructure | null {
  if (!source.trimStart().startsWith("class")) return null;
  const parsed = parseWithOffset(source);
  if (parsed === null) return null;
  const { node, offset } = parsed;
  if (node.type !== "ClassExpression" && node.type !== "ClassDeclaration") return null;
  const members = node.body?.body;
  if (!$isJSArray(members)) return null;
  const fields: string[] = [];
  for (const m of members) {
    // Private DATA fields only; private methods carry no per-instance state.
    if (
      m.type === "PropertyDefinition" &&
      m.static !== true &&
      m.key?.type === "PrivateIdentifier" &&
      typeof m.key.name === "string"
    ) {
      fields.push(m.key.name);
    }
  }
  return { fields, isDerived: node.superClass != null, node, offset };
}

// The string member key of a class member node, or undefined if it can't be statically pruned by
// key: a computed key (`[expr]() {}`), a `#private` key (mangled separately, genuine path), or a
// non-string key. A constructor is never prunable (its source must stay valid). Undefined means
// "keep" — pruning only removes members it can positively identify as unreachable.
function prunableMemberKey(m: any): string | undefined {
  if (m?.type !== "MethodDefinition") return undefined; // fields/static-blocks left intact
  if (m.static === true || m.computed === true) return undefined;
  if (m.key?.type === "PrivateIdentifier") return undefined;
  const key = m.key?.value;
  if (typeof key !== "string" || key === "constructor") return undefined;
  return key;
}

// Shrink a captured class to the prototype methods/accessors the closure can actually reach,
// deleting the rest from its source and routing each KEPT method through the replacer (so a
// consumer observes exactly the reachable methods — see computeKeepSets / Context.methodKeep).
// Returns the (possibly pruned) source, or `source` unchanged when pruning doesn't apply:
//   - not a class, or its prototype isn't an object;
//   - the class (or its prototype) is captured as a first-class value — it could construct fresh
//     instances or have any method called, so every method must survive;
//   - no instance reached it, or an instance was kept wholesale ("all") — keep every method.
// Members are removed by blanking `[member[i].start, member[i+1].start)` (the last runs to the
// class body's `}`) with the same number of newlines, so kept members stay byte-for-byte intact on
// their original lines (source maps unaffected). `super`-using methods are kept INLINE here — never
// extracted — so their `[[HomeObject]]` survives.
function pruneClassMethods(fn: Function, source: string, cs: ClassStructure, ctx: Context): string {
  const proto = (fn as { prototype?: object }).prototype;
  if (typeof proto !== "object" || proto === null) return source;
  if (ctx.capturedAsValue.has(fn) || ctx.capturedAsValue.has(proto)) return source;
  const keep = ctx.methodKeep.get(proto);
  if (keep === undefined || keep === "all") return source;

  const members = cs.node.body?.body;
  if (!$isJSArray(members) || members.length === 0) return source;
  const closeBrace = typeof cs.node.body?.closeBrace === "number" ? cs.node.body.closeBrace - cs.offset : -1;
  if (closeBrace < 0) return source;

  // `memberStart` is the member's true textual start (BEFORE leading modifiers/decorators) — the
  // correct deletion boundary. For a StaticBlock it differs from `.start` (which is the block's
  // `{`); using `.start` there would eat the preceding member's `static` keyword. Fall back to
  // `.start` only if memberStart is somehow absent.
  const starts: number[] = [];
  for (const m of members) {
    const s = typeof m.memberStart === "number" ? m.memberStart : m.start;
    starts.push(typeof s === "number" ? s - cs.offset : -1);
  }

  const cuts: Array<{ start: number; end: number }> = [];
  const pruned = new SetCtor<PropertyKey>();
  for (let i = 0; i < members.length; i++) {
    const key = prunableMemberKey(members[i]);
    if (key === undefined) continue; // constructor / field / computed / #private / static → keep
    if (keep.has(key)) {
      // Reachable — route the live method/accessor function through the replacer for observation.
      const d = ObjectGetOwnPropertyDescriptor(proto, key);
      const methodFn = d?.value ?? d?.get ?? d?.set;
      if (typeof methodFn === "function") transform(proto, key, methodFn, ctx);
      continue;
    }
    const a = starts[i];
    const b = i + 1 < starts.length ? starts[i + 1] : closeBrace;
    if (a >= 0 && b > a && b <= source.length) {
      cuts.push({ start: a, end: b });
      pruned.add(key);
    }
  }
  if (cuts.length === 0) return source;
  // Record removed keys so the prototype's own-property emit skips them (it still sees the live
  // method on the prototype object and would otherwise re-add it, defeating the prune).
  ctx.prunedMethods.set(fn, pruned);

  // Apply right-to-left so earlier cuts don't invalidate later offsets; replace each removed span
  // with its newline count to preserve the line structure of the surviving members.
  cuts.sort((x, y) => y.start - x.start);
  let out = source;
  for (const c of cuts) {
    const newlines = out.slice(c.start, c.end).split("\n").length - 1;
    out = out.slice(0, c.start) + "\n".repeat(newlines) + out.slice(c.end);
  }
  return out;
}

// Rewrite a genuine-private class's source for two-phase reification:
//   - a guarded reify branch at the top of the constructor body skips the original body
//     (and calls super() for a derived class) so the factory builds a BARE instance:
//       constructor(...) { if (REIFY_SLOT) { super(); return; } <orig> }
//   - a patch method installs this class's privates from a values object, called AFTER all
//     instances exist (so cycles and self-references work): `__patch(v){ this.#x = v["#x"]; }`
//   - any host methods (for escaped `#x` arrows) are injected too.
// The reify branch goes after the constructor body `{`; the patch + host methods after the
// class body `{`. All insertions are single-line, so source-map lines are unchanged.
function injectReifyConstructor(
  source: string,
  info: ClassStructure,
  hostMethods: string[],
  keyPrefix: string,
): string {
  const { fields, isDerived, node, offset } = info;
  // RE-serialization idempotency: a class whose source we reconstructed in an earlier round
  // already carries the reify branch, the `__bunReifyPatch` method, and any host methods (the
  // `#x` fields and the genuine-private gate still re-clear it as genuine). Re-injecting on top
  // would APPEND a second patch method (and a second branch) every round — unbounded growth and
  // a redundant scaffold. Detect the already-injected patch and skip BOTH injections: the
  // existing scaffolding is reused as-is (the host-method set is stable for a given graph).
  const alreadyInjected = $isJSArray(node.body?.body)
    ? node.body.body.some(
        (m: any) => m?.type === "MethodDefinition" && m.static !== true && m.key?.value === PATCH_METHOD,
      )
    : false;
  const branch = `if(${REIFY_SLOT}){` + (isDerived ? "super();" : "") + `return;}`;
  // Patch keys are namespaced by class id so a same-named private across an inheritance
  // chain still maps to this class's own genuine slot.
  const patch =
    !alreadyInjected && fields.length
      ? `${PATCH_METHOD}(v){${fields.map(f => `this.${f}=v[${JSONStringify(keyPrefix + f)}];`).join("")}}`
      : "";
  const classBodyInjections = alreadyInjected ? "" : patch + hostMethods.join("");
  // The class body `{` — `node.body` (ClassBody) start is reliable and, crucially, points at
  // THIS class's brace, not a `{` inside the heritage (`extends class A {…}` / `extends
  // mixin({…})`), which `source.indexOf("{")` would wrongly find.
  const classBrace = typeof node.body?.start === "number" ? node.body.start - offset : source.indexOf("{");

  // Already reconstructed: the constructor branch + patch + host methods are all present and
  // the field guards are already in place — nothing more to inject (idempotent re-serialization).
  if (alreadyInjected) return source;

  const ctor = node.body.body.find(
    (m: any) => m.type === "MethodDefinition" && m.static !== true && m.key?.value === "constructor",
  );
  if (ctor !== undefined && typeof ctor.value?.bodyStart === "number") {
    // ctor.value.bodyStart is the constructor body's `{` (surfaced by ast()).
    const i = ctor.value.bodyStart - offset;
    // Insert the reify branch after the constructor body `{` (later position) first, then the
    // class-body injections after the class body `{` (earlier position) so offsets stay valid.
    let out = source.slice(0, i + 1) + branch + source.slice(i + 1);
    if (classBodyInjections) {
      out = out.slice(0, classBrace + 1) + classBodyInjections + out.slice(classBrace + 1);
    }
    return out;
  }

  // No explicit constructor: synthesize one right after the class body `{`. A derived
  // class's NORMAL path must forward super(...args) — an explicit empty derived
  // constructor would otherwise never call super and throw.
  const synthesized = isDerived ? `constructor(...a){${branch}super(...a);}` : `constructor(){${branch}}`;
  return source.slice(0, classBrace + 1) + synthesized + classBodyInjections + source.slice(classBrace + 1);
}

// Neutralizes a reconstructed class's EAGER initializers, whose side effects would otherwise
// re-run when the class is re-evaluated / reified:
//   - STATIC blocks are emptied (`static { ... }` → `static {}`), and STATIC PUBLIC field
//     initializers replaced with `undefined` (they run at class definition, which the reify
//     flag can't guard; their resulting static state is restored separately as the class's own
//     properties). A static #PRIVATE field can't be restored that way, so it's left intact.
//     Applies to both genuine and mangled classes.
//   - INSTANCE field initializers are wrapped `<key> = REIFY_SLOT ? undefined : (<init>)` so the
//     reify factory's bare construct skips them (a normal `new C()` still runs them); their
//     values are restored by the patch (#private) / own-property (public) emit. Genuine path
//     only (mangled instances are `Object.create`d and never run initializers).
// Driven entirely by AST positions (no source scanning): the field initializer's text span is
// `[initStart, initEnd)` and a static block's braces are `[start, closeBrace]` (both surfaced
// by ast()). `offset` maps AST positions to source positions; edits applied right-to-left.
function neutralizeClassInitializers(
  source: string,
  classNode: any,
  offset: number,
  guardInstanceFields: boolean,
): string {
  const members = classNode?.body?.body;
  if (!$isJSArray(members)) return source;
  const edits: Array<{ start: number; end: number; replace: string }> = [];
  for (const m of members) {
    if (m?.type === "StaticBlock" && typeof m.start === "number" && typeof m.closeBrace === "number") {
      // `start` is the block's `{`, `closeBrace` its `}` — empty the body in between.
      const open = m.start - offset;
      const close = m.closeBrace - offset;
      if (open >= 0 && close > open && close <= source.length) edits.push({ start: open + 1, end: close, replace: "" });
      continue;
    }
    if (m?.type === "PropertyDefinition" && typeof m.initStart === "number" && m.initStart >= 0) {
      // `[initStart, initEnd)` is the initializer text just past `=` (incl. any grouping parens).
      const s = m.initStart - offset;
      const e = m.initEnd - offset;
      if (s < 0 || e < s || e > source.length) continue;
      if (m.static === true) {
        if (m.key?.type !== "PrivateIdentifier") edits.push({ start: s, end: e, replace: "undefined" });
      } else if (guardInstanceFields) {
        // RE-serialization idempotency: a reconstructed class's instance field is already guarded
        // (`<key> = $bunClosureReify$ ? undefined : (<init>)`). Re-wrapping would nest a second
        // identical guard every round (unbounded growth). The guard's leading token is the reify
        // slot, so skip a field whose initializer already begins with it.
        if (source.slice(s, e).trimStart().startsWith(REIFY_SLOT)) continue;
        edits.push({ start: s, end: s, replace: `${REIFY_SLOT}?undefined:(` });
        edits.push({ start: e, end: e, replace: ")" });
      }
    }
  }
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = source;
  for (const e of edits) out = out.slice(0, e.start) + e.replace + out.slice(e.end);
  return out;
}

// The reachability GATE. Genuine `#private` reconstruction only works in a closed world:
// every instance comes from the real constructor chain (so each level's brand installs)
// and the code reading `#x` lives on the class prototype. We over-approximate reachability
// (more mangling fallback is always safe) and clear a class for genuine reconstruction
// only when its whole hierarchy is reconstructable and nothing in the graph would need its
// privates elsewhere.
interface GenuinePlan {
  genuine: Set<Function>;
  hostedArrows: Map<Function, { instance: object; classFn: Function; hostKey: string }>;
  classHosts: Map<Function, Array<{ hostKey: string; source: string }>>;
}
function computeGenuineClasses(root: unknown, sharedIdsArg?: Set<number>): GenuinePlan {
  // Cells shared across 2+ functions are hoisted to module scope by name; a hosted arrow
  // must reference such a cell by name (NOT thread it as a snapshot parameter) to keep
  // mutations shared. The caller (serialize) already ran analyzeSharedCells — reuse its result
  // rather than walk the whole graph a second time.
  const sharedIds =
    sharedIdsArg ?? (typeof root === "function" ? analyzeSharedCells(root).sharedIds : new SetCtor<number>());
  const funcs = new SetCtor<Function>();
  const objs = new SetCtor<object>();
  const seen = new SetCtor<unknown>();
  const stack: unknown[] = [root];
  const push = (v: unknown) => {
    if (v !== null && (typeof v === "object" || typeof v === "function")) stack.push(v);
  };
  const drain = (): void => {
    while (stack.length) {
      const v = stack.pop()!;
      if (seen.has(v)) continue;
      seen.add(v);
      // Never walk a Proxy's internals (would trip its traps / observable side effects).
      if ($isProxyObject(v as object)) continue;
      // A well-known global is referenced by path, not walked — skip its native internals.
      if (typeof v === "object" && nativeObjectPath(v as object) !== undefined) continue;
      if (typeof v === "function") {
        funcs.add(v);
        const fv = (v as any)[Symbol.freeVariables] as FreeVariable[] | undefined;
        if (fv) for (const x of fv) push(x.value);
        const bound = (v as any)[Symbol.boundFunction] as BoundDetails | undefined;
        if (bound) {
          push(bound.target);
          push(bound.boundThis);
          for (const a of bound.boundArgs) push(a);
        }
        if ((v as any).prototype) push((v as any).prototype);
      } else {
        objs.add(v as object);
        // Reach values stored in private fields (e.g. an escaped arrow held in `this.#fn`)
        // so they participate in hosting/genuine decisions. Symbol.privateFields returns only
        // DATA fields (accessors/methods excluded) for any object, so this is safe.
        const pf = (v as any)[Symbol.privateFields] as Array<{ name: string; value: unknown }> | undefined;
        if (pf) for (const f of pf) push(f.value);
        forEachMapSetEntry(v as object, push);
      }
      // Own DATA properties only — reading an accessor could fire a getter (side effect).
      for (const key of ReflectOwnKeys(v as object)) {
        const d = ObjectGetOwnPropertyDescriptor(v as object, key);
        if (d !== undefined && "value" in d) push(d.value);
      }
      push(ObjectGetPrototypeOf(v as object));
    }
  };
  drain();

  // Fold hostable escaped arrows' receivers into reachability: their `this` instance (and
  // hence its class) is otherwise invisible (the arrow captures only the brand), but we
  // recover it natively and host the arrow on the class. The instance must then be emitted
  // and its class must qualify as genuine.
  const arrowInstance = new MapCtor<Function, object>();
  for (const f of [...funcs]) {
    if (!hostableEscapedArrow(f)) continue;
    const r = $resolveClosureBinding(f, "this");
    if (r?.found && r.value !== null && typeof r.value === "object") {
      arrowInstance.set(f, r.value as object);
      push(r.value);
    }
  }
  drain();

  // Cache each reachable class's parsed structure.
  const structure = new MapCtor<Function, ClassStructure | null>();
  const structOf = (C: Function): ClassStructure | null => {
    if (!structure.has(C)) {
      let s: ClassStructure | null = null;
      try {
        s = classStructure(funcSource(C));
      } catch {}
      structure.set(C, s);
    }
    return structure.get(C)!;
  };

  // Every reachable class's own methods — a method legitimately reading a private (even an
  // inherited one with a same-named field) must not be mistaken for an escaped closure.
  const allMethods = new SetCtor<Function>();
  for (const f of funcs) {
    if (structOf(f) !== null) for (const m of classOwnMethods(f)) allMethods.add(m);
  }

  // Structural candidates: every class in a hierarchy that reaches Object through parseable
  // user classes only (no builtin base), has ≥1 private field, and no chain member with a
  // non-hostable escaped `#x` closure. (Same-name private collisions across the chain are
  // allowed — keys are namespaced by class id.)
  const candidate = new SetCtor<Function>();
  const chainMemo = new MapCtor<Function, ChainSuffix>();
  for (const f of funcs) {
    const chain = genuineChain(f, structOf, funcs, allMethods, chainMemo);
    if (chain) for (const c of chain) candidate.add(c);
  }

  // Instance-leaf fixpoint: a genuine class is safe only if EVERY reachable instance with
  // it in its prototype chain is constructed by a genuine class (so the full constructor
  // chain installs every brand). If an instance's chain includes a non-candidate class, it
  // would be rebuilt via ObjectCreate — unable to brand a genuine ancestor — so none of
  // its chain classes can be genuine; remove them all and repeat until stable.
  const chainClassMemo = new MapCtor<object, Function[]>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const o of objs) {
      const chainClasses = instanceChainClasses(o, chainClassMemo);
      if (chainClasses.length === 0) continue;
      if (chainClasses.some(C => !candidate.has(C))) {
        for (const C of chainClasses) if (candidate.delete(C)) changed = true;
      }
    }
  }

  // Assign hosting: an escaped arrow is hosted only when its receiver's DIRECT class is
  // genuine and declares every private the arrow reads (so `this.#x` is legal in that
  // class's body and the receiver carries the brand). The arrow's non-`this` captures are
  // threaded as host-method parameters (passed the captured values at the call site). Each
  // gets a unique host-method key.
  const hostedArrows: GenuinePlan["hostedArrows"] = new MapCtor();
  const classHosts: GenuinePlan["classHosts"] = new MapCtor();
  const hostCount = new MapCtor<Function, number>();
  for (const [arrow, instance] of arrowInstance) {
    const proto = ObjectGetPrototypeOf(instance);
    const classFn = (proto as any)?.constructor;
    if (typeof classFn !== "function" || classFn.prototype !== proto || !candidate.has(classFn)) continue;
    const fv = ((arrow as any)[Symbol.freeVariables] as FreeVariable[] | undefined) ?? [];
    const reads = fv.filter(v => v.name.startsWith("#")).map(v => v.name);
    const fields = structOf(classFn)?.fields ?? [];
    if (!reads.every(name => fields.includes(name))) continue;
    // Non-`#brand` captures become host parameters threaded the captured value — EXCEPT
    // shared cells, which are hoisted to module scope and resolved by name inside the host
    // method (threading them would snapshot, breaking mutation sharing).
    const captures = fv.filter(v => !v.name.startsWith("#") && !sharedIds.has(v.id));
    const n = hostCount.get(classFn) ?? 0;
    hostCount.set(classFn, n + 1);
    const hostKey = `__bunClosureHost$${n}`;
    hostedArrows.set(arrow, {
      instance,
      classFn,
      hostKey,
      args: captures.map(v => ({ name: v.name, value: v.value })),
    });
    let hosts = classHosts.get(classFn);
    if (hosts === undefined) classHosts.set(classFn, (hosts = []));
    hosts.push({ hostKey, source: funcSource(arrow), params: captures.map(v => v.name) });
  }
  return { genuine: candidate, hostedArrows, classHosts };
}

// True if `fn` is an arrow that reads a `#private` through its lexical `this` (its non-`this`
// captures are threaded as host-method parameters, so any number of them is fine).
function hostableEscapedArrow(fn: Function): boolean {
  let src: string;
  try {
    src = funcSource(fn);
  } catch {
    return false;
  }
  if (!src.includes("#")) return false;
  return arrowReadsLexicalThisPrivate(rewritePrivateMembers(src));
}

// Index the prototype methods/accessors of every genuine class by function identity, so a
// method peeled off an instance (extracted or bound) can be emitted as a reference through
// the reconstructed class prototype rather than rebuilt standalone.
function computeGenuineMethods(
  genuineClasses: Set<Function>,
): Map<Function, { classFn: Function; key: string | symbol; kind: "method" | "get" | "set" }> {
  const map = new MapCtor<Function, { classFn: Function; key: string | symbol; kind: "method" | "get" | "set" }>();
  for (const C of genuineClasses) {
    const proto = C.prototype;
    if (proto == null) continue;
    for (const key of ReflectOwnKeys(proto)) {
      if (key === "constructor") continue;
      const d = ObjectGetOwnPropertyDescriptor(proto, key);
      if (d === undefined) continue;
      // First writer wins: a method is indexed to the class that declares it, not a
      // subclass that inherits the same identity (subclasses don't redefine it).
      if (typeof d.value === "function" && !map.has(d.value)) map.set(d.value, { classFn: C, key, kind: "method" });
      if (typeof d.get === "function" && !map.has(d.get)) map.set(d.get, { classFn: C, key, kind: "get" });
      if (typeof d.set === "function" && !map.has(d.set)) map.set(d.set, { classFn: C, key, kind: "set" });
    }
  }
  return map;
}

// Walk `C` and its superclass chain up to Object. Returns the chain (leaf-first) if every
// member is a parseable user class with ≥1 private field somewhere and no per-class
// disqualifier; else null. Same-name private fields across the chain are fine — each class
// writes its own genuine slot, namespaced by class id in the patch keys.
// The genuine-chain SUFFIX result for a class: the leaf-first chain of user classes from this
// class up to a terminal (Object / Function.prototype / a reconstructable builtin base), whether
// any member declares a private field, and whether the suffix is `valid` (no member is a
// non-reconstructable native base or per-class-disqualified). Memoized per class so an inheritance
// chain — where each class's suffix is the next class's suffix plus itself — is resolved in O(depth)
// TOTAL instead of re-walking the full suffix for every class (which made `class extends` chains
// super-linear in depth).
type ChainSuffix = { classes: Function[]; hasField: boolean; valid: boolean };
function chainSuffix(
  C: Function,
  structOf: (C: Function) => ClassStructure | null,
  funcs: Set<Function>,
  allMethods: Set<Function>,
  memo: Map<Function, ChainSuffix>,
): ChainSuffix {
  // Collect the unvisited prefix of the chain (leaf-first) until a memoized suffix, a terminal,
  // or a disqualifier. Then fold the result downward and fill the memo for each visited class.
  // Iterative (no recursion) so a very deep chain doesn't overflow the JS stack.
  const pending: Array<{ C: Function; s: ClassStructure }> = [];
  let cur: any = C;
  let tail: ChainSuffix = { classes: [], hasField: false, valid: true };
  while (true) {
    if (typeof cur !== "function" || cur === Function.prototype) break; // terminal: valid, empty
    const seen = memo.get(cur);
    if (seen !== undefined) {
      tail = seen;
      break;
    }
    const s = structOf(cur);
    if (s === null) {
      // A builtin base we can reconstruct (its no-arg `super()` yields a valid empty instance and
      // its content is restorable) ends the chain genuinely; any other native base rejects.
      tail = { classes: [], hasField: false, valid: RECONSTRUCTABLE_BUILTIN_BASES.has(cur) };
      break;
    }
    if (perClassDisqualified(cur, s.fields, funcs, allMethods)) {
      tail = { classes: [], hasField: false, valid: false };
      break;
    }
    pending.push({ C: cur, s });
    cur = ObjectGetPrototypeOf(cur);
  }
  // Fold downward: each class prepends itself onto the suffix above it.
  for (let i = pending.length - 1; i >= 0; i--) {
    const { C: pc, s } = pending[i];
    tail = tail.valid
      ? { classes: [pc, ...tail.classes], hasField: tail.hasField || s.fields.length > 0, valid: true }
      : { classes: [], hasField: false, valid: false };
    memo.set(pc, tail);
  }
  return tail;
}

// Walk `C` and its superclass chain up to Object. Returns the chain (leaf-first) if every
// member is a parseable user class with ≥1 private field somewhere and no per-class
// disqualifier; else null. Same-name private fields across the chain are fine — each class
// writes its own genuine slot, namespaced by class id in the patch keys.
function genuineChain(
  C: Function,
  structOf: (C: Function) => ClassStructure | null,
  funcs: Set<Function>,
  allMethods: Set<Function>,
  memo: Map<Function, ChainSuffix>,
): Function[] | null {
  const r = chainSuffix(C, structOf, funcs, allMethods, memo);
  return r.valid && r.hasField ? r.classes : null;
}

// A stable per-genuine-class id, assigned on first use, for namespacing patch keys.
function genuineClassId(fn: Function, ctx: Context): number {
  let id = ctx.genuineClassId.get(fn);
  if (id === undefined) ctx.genuineClassId.set(fn, (id = ctx.genuineClassId.size));
  return id;
}

// The classes whose `.prototype` lies on `o`'s prototype chain (leaf-first) — i.e. the
// constructor chain that built `o`.
const EMPTY_CLASSES: Function[] = [];
// The user classes in `o`'s prototype chain (leaf-first), stopping at a builtin/native base (only
// the user-class portion must be genuine for the fixpoint). Memoized by prototype object: the
// chain SUFFIX from a given prototype is the same for every object sharing it, so a deep
// Object.create / class-extends chain resolves in O(depth) total instead of re-walking O(depth)
// per object (which made the fixpoint O(N²)). `memo` is scoped to one computeGenuineClasses call,
// so a mutated prototype can't leave a stale entry across serialize() calls.
function instanceChainClasses(o: object, memo: Map<object, Function[]>): Function[] {
  const start = ObjectGetPrototypeOf(o);
  if (start === null || start === Object.prototype) return EMPTY_CLASSES;
  const cached = memo.get(start);
  if (cached !== undefined) return cached;
  // Walk up collecting not-yet-memoized prototypes (and whether each is a user-class prototype)
  // until a cached result, the chain end, or a native base; then fill each bottom-up. Iterative so
  // a deep chain doesn't recurse on the JS stack.
  const pending: Array<[object, Function | null]> = [];
  let p: object | null = start;
  let tail: Function[] = EMPTY_CLASSES;
  for (;;) {
    if (p === null || p === Object.prototype) break;
    const seen = memo.get(p);
    if (seen !== undefined) {
      tail = seen;
      break;
    }
    const c = ownConstructor(p);
    if (c !== undefined && isNativeFunctionSource(funcSource(c))) {
      memo.set(p, EMPTY_CLASSES); // native base: it and everything above contribute nothing
      break;
    }
    pending.push([p, c ?? null]);
    p = ObjectGetPrototypeOf(p);
  }
  for (let i = pending.length - 1; i >= 0; i--) {
    const [pp, c] = pending[i];
    const result = c !== null ? [c, ...tail] : tail;
    memo.set(pp, result);
    tail = result;
  }
  return tail;
}

// The own (prototype + static) method/accessor function identities of class `C`.
function classOwnMethods(C: Function): Set<Function> {
  const methods = new SetCtor<Function>();
  for (const holder of [C.prototype, C] as object[]) {
    if (holder == null) continue;
    for (const key of ReflectOwnKeys(holder)) {
      const d = ObjectGetOwnPropertyDescriptor(holder, key);
      if (d === undefined) continue;
      for (const m of [d.value, d.get, d.set]) if (typeof m === "function") methods.add(m);
    }
  }
  return methods;
}

// True if some reachable function — other than a class method or a hostable arrow — is an
// escaped closure that textually references one of C's private fields. A method (of ANY
// class, e.g. an inherited one that legitimately reads a same-named private) is fine; a
// hostable arrow is reconstructed by hosting it in C's body. Anything else reading the
// private — an escaped ordinary function whose `this` won't carry the genuine slot — can't
// be served by genuine reconstruction. `allMethods` is every reachable class's methods.
function perClassDisqualified(C: Function, fields: string[], funcs: Set<Function>, allMethods: Set<Function>): boolean {
  // A class declaring no private fields can't be disqualified by a closure reading its (nonexistent)
  // privates — `fields.some(...)` below is vacuously false. Short-circuit BEFORE the O(funcs) scan:
  // a deep `class extends` chain has many fieldless members, and walking every reachable function
  // (with a `toString()` each) for each of them is the dominant cost (it makes genuineChain O(funcs)
  // per chain member, so serialization super-linear in chain depth).
  if (fields.length === 0) return false;
  for (const g of funcs) {
    if (g === C || allMethods.has(g) || hostableEscapedArrow(g)) continue;
    let src: string;
    try {
      src = funcSource(g);
    } catch {
      continue;
    }
    if (src.includes("#") && fields.some(name => src.includes(name))) return true;
  }
  return false;
}

// Walk a function AST and record how each `rootNames` identifier (free variable
// names, or "this") is used. Returns name → AccessNode.
function analyzeAccess(fnNode: any, rootNames: Set<string>): Map<string, AccessNode> {
  const table = new MapCtor<string, AccessNode>();
  const get = (name: string): AccessNode => {
    let n = table.get(name);
    if (n === undefined) {
      n = newAccessNode();
      table.set(name, n);
    }
    return n;
  };
  // Dynamic code (`eval`, `new Function`) can reference any captured binding invisibly, so
  // every tracked name must be kept whole — no pruning is sound past that point.
  const markAllRoots = (): void => {
    for (const name of rootNames) get(name).all = true;
  };

  // If `node` is a member chain rooted at a tracked name, return the AccessNode
  // for that path (creating it); computed/dynamic access marks the base whole.
  function accessOf(node: any): AccessNode | null {
    if (!node || typeof node !== "object") return null;
    if (node.type === "Identifier") return rootNames.has(node.name) ? get(node.name) : null;
    if (node.type === "ThisExpression") return rootNames.has("this") ? get("this") : null;
    // `super.m()` inside a method resolves to a prototype member reached with the SAME receiver,
    // so for reachability it behaves like `this.m` — fold it into the `this` access node.
    if (node.type === "Super") return rootNames.has("this") ? get("this") : null;
    if (node.type === "MemberExpression") {
      const base = accessOf(node.object);
      if (base === null) return null;
      if (node.computed) {
        base.all = true; // `base[expr]` defeats static pruning of base
        walk(node.property);
        return null;
      }
      const prop = node.property?.name;
      if (typeof prop !== "string") {
        base.all = true;
        return null;
      }
      return accessChild(base, prop);
    }
    return null;
  }

  function walk(node: any): void {
    if ($isJSArray(node)) {
      for (const n of node) walk(n);
      return;
    }
    if (!node || typeof node !== "object" || typeof node.type !== "string") return;
    switch (node.type) {
      case "Identifier":
        if (rootNames.has(node.name)) get(node.name).all = true; // bare reference escapes
        return;
      case "ThisExpression":
        if (rootNames.has("this")) get("this").all = true;
        return;
      case "MemberExpression": {
        const a = accessOf(node);
        if (a !== null) {
          a.all = true; // a rooted read used here as a whole value
          return;
        }
        walk(node.object);
        if (node.computed) walk(node.property);
        return;
      }
      case "NewExpression":
        // `new Function("...")` builds a function from a string we can't analyze; be safe.
        if (node.callee?.type === "Identifier" && node.callee.name === "Function") markAllRoots();
        for (const key in node) {
          if (key === "type" || key === "start") continue;
          walk(node[key]);
        }
        return;
      case "CallExpression": {
        const callee = node.callee;
        // A direct `eval(...)` (or `Function(...)`) call can read captured bindings through a
        // string the AST walker can't see; pruning would silently drop those properties. Mark
        // every tracked name whole — the soundness floor for dynamic code.
        if (callee?.type === "Identifier" && (callee.name === "eval" || callee.name === "Function")) {
          markAllRoots();
        }
        if (callee && callee.type === "MemberExpression" && !callee.computed) {
          const base = accessOf(callee.object);
          const method = callee.property?.name;
          if (base !== null && typeof method === "string") {
            accessChild(base, method); // keep the method property
            base.calledMethods.add(method); // and follow its `this`
            walk(node.arguments);
            return;
          }
        }
        walk(callee);
        walk(node.arguments);
        return;
      }
      default:
        for (const key in node) {
          if (key === "type" || key === "start") continue;
          walk(node[key]);
        }
        return;
    }
  }

  walk(fnNode.params);
  walk(fnNode.body);
  return table;
}

// Own-or-prototype descriptor for a string key, without invoking getters.
function lookupDescriptor(obj: object, key: string): PropertyDescriptor | undefined {
  let o: object | null = obj;
  while (o !== null) {
    const d = ObjectGetOwnPropertyDescriptor(o, key);
    if (d !== undefined) return d;
    o = ObjectGetPrototypeOf(o);
  }
  return undefined;
}

// Build the per-value keep-sets: for each captured object, the set of own string
// keys to serialize (or "all"). Walks every reachable function, analyzes its
// access paths, and follows `this` into invoked methods so their reads are kept.
interface KeepSetResult {
  keepSets: Map<object, Set<string> | "all">;
  methodKeep: Map<object, Set<PropertyKey> | "all">;
  capturedAsValue: Set<object>;
}
function computeKeepSets(root: Function): KeepSetResult {
  const keepSets = new MapCtor<object, Set<string> | "all">();
  const capturedAsValue = new SetCtor<object>();
  const seenFns = new SetCtor<Function>();
  const seenObjs = new SetCtor<object>();
  const followed = new MapCtor<object, Set<string>>(); // receiver → methods already this-followed
  const followedFns = new MapCtor<object, Set<Function>>(); // receiver → getter/method fns already this-followed

  // Mark a value — and everything reachable through its object graph — as
  // serialized whole. Keep-all must propagate: if an object escapes, every
  // object it transitively contains is emitted in full too, overriding any
  // narrower keep-set a closure's access analysis may have assigned. Functions
  // are not traversed here — their captured free variables are pruned by their
  // own analysis (the function body only uses what it uses).
  function keepAll(value: object): void {
    const stack: object[] = [value];
    while (stack.length) {
      const o = stack.pop()!;
      if (o === null || typeof o !== "object") continue;
      if (keepSets.get(o) === "all") continue;
      keepSets.set(o, "all");
      if (isAsyncLocalStorage(o)) continue; // reconstructed wholesale; don't walk internals
      if (nativeObjectPath(o) !== undefined) continue; // referenced by path; don't walk internals
      if ($isProxyObject(o)) continue; // emitted via emitProxy, not keep-sets
      if ($isJSArray(o)) {
        const arr = o as unknown[];
        for (const i of arrayPresentIndices(arr)) {
          const el = arr[i];
          if (el !== null && typeof el === "object") stack.push(el as object);
        }
        continue;
      }
      for (const key of ReflectOwnKeys(o)) {
        const d = ObjectGetOwnPropertyDescriptor(o, key)!;
        if ("value" in d && d.value !== null && typeof d.value === "object") stack.push(d.value);
      }
    }
  }

  // Apply an access node to a value: union its kept keys, recurse into children,
  // and this-follow invoked methods. `node === undefined` means "used wholly".
  function apply(value: unknown, node: AccessNode | undefined): void {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
    if (typeof value === "function") return; // functions are serialized whole
    const obj = value as object;
    if (node === undefined || node.all) {
      keepAll(obj);
      return;
    }
    if (keepSets.get(obj) === "all") return;
    let cur = keepSets.get(obj) as Set<string> | undefined;
    if (cur === undefined) {
      cur = new SetCtor();
      keepSets.set(obj, cur);
    }
    for (const [prop, childNode] of node.children) {
      cur.add(prop);
      const d = lookupDescriptor(obj, prop);
      if (d !== undefined && "value" in d) {
        apply(d.value, childNode);
      } else if (d !== undefined) {
        // An accessor property reached on `obj`: reading invokes the getter, WRITING invokes the
        // setter — both run with `this === obj`. The access analysis doesn't distinguish read from
        // write, so fold BOTH bodies' `this.X` reads/calls into obj's keep-set (conservative: a
        // setter the closure actually fires would otherwise have its called methods pruned). The
        // accessor's result is a fresh value, so the child path past it is opaque.
        if (typeof d.get === "function") thisFollowFn(obj, d.get);
        if (typeof d.set === "function") thisFollowFn(obj, d.set);
      }
      // missing props: kept (added above), nothing to recurse.
    }
    for (const method of node.calledMethods) thisFollow(obj, method);
  }

  // A method `obj.m(...)` runs with `this === obj`; fold the method body's
  // `this.X` reads into `obj`'s keep-set so reconstruction stays correct.
  function thisFollow(obj: object, method: string): void {
    let done = followed.get(obj);
    if (done === undefined) {
      done = new SetCtor();
      followed.set(obj, done);
    }
    if (done.has(method)) return;
    done.add(method);

    if (keepSets.get(obj) === "all") return;
    const top = lookupDescriptor(obj, method);
    if (top === undefined || !("value" in top)) {
      // accessor-valued or missing method: can't safely inspect → keep all.
      keepAll(obj);
      return;
    }
    // Follow EVERY same-named method up the prototype chain, not just the most-derived override:
    // a `super.method()` inside that override resolves to an ANCESTOR's method, whose own body may
    // read further `this.X` / call `this.other()` that must be kept too. (thisFollowFn dedups per
    // receiver+fn and ignores non-function values, so this is cheap and safe.)
    let o: object | null = obj;
    while (o !== null) {
      const d = ObjectGetOwnPropertyDescriptor(o, method);
      if (d !== undefined && "value" in d) thisFollowFn(obj, d.value);
      o = ObjectGetPrototypeOf(o);
    }
  }

  // Fold a function's `this.X` reads into `obj`'s keep-set, given that it runs
  // with `this === obj` (an invoked method, or a getter read off `obj`).
  function thisFollowFn(obj: object, fn: unknown): void {
    if (typeof fn !== "function") return;
    let done = followedFns.get(obj);
    if (done === undefined) {
      done = new SetCtor();
      followedFns.set(obj, done);
    }
    if (done.has(fn as Function)) return;
    done.add(fn as Function);

    if (keepSets.get(obj) === "all") return;
    let source: string;
    try {
      source = (fn as Function).toString();
    } catch {
      keepAll(obj);
      return;
    }
    const fnNode = parseFunctionNode(source);
    if (fnNode === null) {
      keepAll(obj);
      return;
    }
    // A generator / async method body surfaces `yield`/`await` as opaque `Unsupported` AST nodes,
    // which HIDE the `this.X` reads/calls nested inside them — so the access scan would miss a
    // `this.helper()` and wrongly prune `helper`. When the body is incompletely representable,
    // fall back to keeping the whole receiver (conservative; never under-keeps).
    if (containsUnsupportedNode(fnNode.body)) {
      keepAll(obj);
      return;
    }
    const thisNode = analyzeAccess(fnNode, new SetCtor(["this"])).get("this");
    if (thisNode === undefined) return; // doesn't touch `this`
    apply(obj, thisNode); // its `this.X` reads are reads on `obj`
  }

  // Iterative graph walk (heap stack, not the JS call stack) so a deep object chain doesn't
  // overflow. Order-independent: keep-sets only accumulate (union, with keepAll overriding).
  // `apply`/this-follow recurse only over the shallow static access tree, never the graph.
  const stack: unknown[] = [];
  // `asValue` marks a genuine first-class capture (free var, property value, array/Map/Set
  // element, bound internals) — as opposed to a structural reference (an instance's
  // prototype-owner, a class's `extends` superclass). Only first-class captures keep a class
  // from being method-pruned; the structural references are exactly what pruning rewrites.
  function enqueueFns(value: unknown, asValue = true): void {
    if (value === null) return;
    const t = typeof value;
    if (t === "function" || t === "object") {
      if (asValue) capturedAsValue.add(value as object);
      stack.push(value);
    }
  }
  function processValueFns(value: unknown): void {
    if (isAsyncLocalStorage(value as object)) return; // reconstructed wholesale; opaque
    // A well-known global is referenced by path, not walked — don't descend into its internals.
    if (value !== null && typeof value === "object" && nativeObjectPath(value) !== undefined) return;
    if ($isProxyObject(value)) {
      const handler = $getProxyInternalField(value, $proxyFieldHandler);
      if (handler === null) return;
      enqueueFns($getProxyInternalField(value, $proxyFieldTarget));
      enqueueFns(handler);
      return;
    }
    if (typeof value === "function") {
      const bound = (value as any)[Symbol.boundFunction] as BoundDetails | undefined;
      if (bound !== undefined) {
        enqueueFns(bound.target);
        enqueueFns(bound.boundThis);
        for (const arg of bound.boundArgs) enqueueFns(arg);
        return;
      }
      processFn(value as Function);
      return;
    }
    const obj = value as object;
    if (seenObjs.has(obj)) return;
    seenObjs.add(obj);
    if ($isJSArray(obj)) {
      const arr = obj as unknown[];
      for (const i of arrayPresentIndices(arr)) enqueueFns(arr[i]);
      return;
    }
    for (const key of ReflectOwnKeys(obj)) {
      const d = ObjectGetOwnPropertyDescriptor(obj, key)!;
      if (d.get) enqueueFns(d.get);
      if (d.set) enqueueFns(d.set);
      if ("value" in d) enqueueFns(d.value);
    }
    const proto = ObjectGetPrototypeOf(obj);
    if (proto !== null && proto !== Object.prototype) {
      const ctor = (proto as any).constructor;
      // Structural: the instance's class is referenced only to host its prototype, not captured
      // as a value — so it stays method-prunable (asValue = false).
      enqueueFns(typeof ctor === "function" && ctor.prototype === proto ? ctor : proto, false);
    }
    forEachMapSetEntry(obj, enqueueFns);
  }

  function processFn(fn: Function): void {
    if (seenFns.has(fn)) return;
    seenFns.add(fn);
    let source: string;
    try {
      source = funcSource(fn);
    } catch {
      return;
    }
    const freeVariables = allFreeVariables(fn, source);
    if (freeVariables.length === 0) return;
    const rootNames = new SetCtor(freeVariables.map(v => v.name));
    const fnNode = parseFunctionNode(source);
    const table = fnNode === null ? null : analyzeAccess(fnNode, rootNames);
    for (const v of freeVariables) {
      apply(v.value, table === null ? undefined : table.get(v.name));
      enqueueFns(v.value);
    }
    const superclass = ObjectGetPrototypeOf(fn);
    // Structural `extends` reference, not a value capture — keep the superclass prunable.
    if (typeof superclass === "function" && superclass !== Function.prototype) enqueueFns(superclass, false);
  }

  const empty: KeepSetResult = {
    keepSets: new MapCtor(),
    methodKeep: new MapCtor(),
    capturedAsValue: new SetCtor(),
  };
  try {
    enqueueFns(root);
    while (stack.length > 0) processValueFns(stack.pop());
  } catch {
    // Any analysis failure must not break serialization: fall back to emitting
    // everything (the pre-pruning behaviour) by discarding partial keep-sets.
    return empty;
  }

  // Aggregate per-instance keep-sets up each instance's prototype CHAIN into a per-prototype
  // reachable-member set: a class's prototype is shared by every instance, so the methods to keep
  // are the UNION across them (and a class deeper in the chain unions in every subclass instance
  // that can reach through it). "all" (a wholesale-kept instance) wins. Used by pruneClassMethods.
  const methodKeep = new MapCtor<object, Set<PropertyKey> | "all">();
  try {
    for (const [obj, ks] of keepSets) {
      // A Proxy isn't a prunable class instance, and a revoked one throws on any reflection
      // (incl. getPrototypeOf) — skip it rather than walk its "chain".
      if (obj === null || typeof obj !== "object" || $isProxyObject(obj)) continue;
      let proto = ObjectGetPrototypeOf(obj);
      while (proto !== null && proto !== Object.prototype) {
        const existing = methodKeep.get(proto);
        if (ks === "all" || existing === "all") {
          methodKeep.set(proto, "all");
        } else {
          let s = existing as Set<PropertyKey> | undefined;
          if (s === undefined) {
            s = new SetCtor<PropertyKey>();
            methodKeep.set(proto, s);
          }
          for (const k of ks) s.add(k);
        }
        proto = ObjectGetPrototypeOf(proto);
      }
    }
  } catch {
    // Any reflection failure on an exotic object just disables pruning (safe: keep every method).
    return { keepSets, methodKeep: new MapCtor(), capturedAsValue };
  }
  return { keepSets, methodKeep, capturedAsValue };
}

// Returns the set of functions that can reach themselves through the capture graph (self-loops
// and longer cycles) — exactly the nodes in a strongly-connected component of size ≥2, plus any
// node with a self-edge. Iterative Tarjan SCC: O(V+E) (the old per-node DFS was O(V·E), minutes
// on a large graph) and non-recursive (a deep capture chain can't overflow it).
function findCyclicFunctions(edges: Map<Function, Set<Function>>): Set<Function> {
  const cyclic = new SetCtor<Function>();
  const index = new MapCtor<Function, number>();
  const lowlink = new MapCtor<Function, number>();
  const onStack = new SetCtor<Function>();
  const sccStack: Function[] = [];
  let counter = 0;

  for (const root of edges.keys()) {
    if (index.has(root)) continue;
    // Each work frame is a node plus a cursor over its (graph-resident) neighbors. A leaf
    // neighbor with no outgoing edges can't be on a cycle, so only nodes that are edge keys are
    // descended into.
    const work: Array<{ node: Function; neighbors: Function[]; i: number }> = [];
    const begin = (n: Function): void => {
      index.set(n, counter);
      lowlink.set(n, counter);
      counter++;
      sccStack.push(n);
      onStack.add(n);
      work.push({ node: n, neighbors: [...(edges.get(n) ?? [])], i: 0 });
    };
    begin(root);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame.i < frame.neighbors.length) {
        const w = frame.neighbors[frame.i++];
        if (!edges.has(w)) continue; // leaf (no outgoing edges) — never on a cycle
        if (!index.has(w)) {
          begin(w);
        } else if (onStack.has(w)) {
          lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, index.get(w)!));
        }
        continue;
      }
      // All neighbors explored: close out this node.
      work.pop();
      const node = frame.node;
      if (lowlink.get(node) === index.get(node)) {
        // Root of an SCC — pop it off the SCC stack.
        const scc: Function[] = [];
        let w: Function;
        do {
          w = sccStack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== node);
        if (scc.length >= 2) {
          for (const f of scc) cyclic.add(f);
        } else if (edges.get(node)?.has(node)) {
          cyclic.add(node); // a lone node is cyclic only via a self-edge
        }
      }
      // Propagate this node's lowlink up to its DFS parent.
      if (work.length > 0) {
        const parent = work[work.length - 1].node;
        lowlink.set(parent, Math.min(lowlink.get(parent)!, lowlink.get(node)!));
      }
    }
  }
  return cyclic;
}

interface ReconstructedFunction {
  expr: string;
  // Where the original `fn` source begins within `expr`, in lines (the source is
  // always emitted verbatim, so it maps line-for-line onto the original file).
  sourceLineOffset: number;
  sourceLineCount: number;
  // The verbatim source as emitted (post `#private`/heritage rewrite); used to
  // derive per-line columns for the source map.
  source: string;
  location: { url: string; line: number; column: number; endLine?: number } | undefined;
  // Set when this is a class reconstructed with GENUINE `#private` fields: the field
  // names its injected constructor reify branch installs. emitFunction emits a reify
  // factory for it; instances are reconstructed through that factory.
  genuinePrivate?: { fields: string[] };
}

// Returns an expression that evaluates to a reconstruction of `fn`, wrapping its
// captured variables in an IIFE scope when it has any.
function reconstructFunctionExpr(fn: Function, ctx: Context, sourceOverride?: string): ReconstructedFunction {
  // A generator reconstructs through a caller-supplied source (`function* name(){body}` built
  // from native introspection); skip the class/#private/super machinery — it's a plain
  // function expression whose free variables (including captured parameters) come from `fn`.
  if (sourceOverride !== undefined) {
    return reconstructFromSource(fn, ctx, sourceOverride, undefined);
  }
  const original = funcSource(fn);
  if (isNativeFunctionSource(original)) {
    throw new TypeError("Cannot serialize a native function (no JavaScript source is available)");
  }
  // A base class the gate cleared for genuine privates keeps real `#x` slots, installed
  // by a constructor reify branch; instances flow through a reify factory (true privacy,
  // real brand checks, `#x in obj`). Every other case — heritage classes, and methods
  // extracted from a class whose standalone `this.#x` is invalid syntax — mangles
  // `#private` into a public field. Both keep lines intact so source maps stay correct.
  let source: string;
  let genuinePrivate: { fields: string[] } | undefined;
  const gpInfo = ctx.genuineClasses.has(fn) ? classStructure(original) : null;
  if (gpInfo !== null) {
    const hosts = (ctx.classHosts.get(fn) ?? []).map(h => `${h.hostKey}(${h.params.join(",")}){return (${h.source});}`);
    // Neutralize eager initializers first (guard instance fields with the reify flag, strip
    // static blocks / static field inits) so the reify factory's bare construct re-runs no
    // side effects. The rewrite shifts positions, so re-derive the class structure from it
    // before injecting the reify branch/patch (fall back to the un-neutralized form if the
    // rewrite somehow no longer parses).
    const neutralized = neutralizeClassInitializers(original, gpInfo.node, gpInfo.offset, true);
    const info = neutralized === original ? gpInfo : classStructure(neutralized);
    if (info !== null) {
      source = injectReifyConstructor(neutralized, info, hosts, `${genuineClassId(fn, ctx)}:`);
    } else {
      source = injectReifyConstructor(original, gpInfo, hosts, `${genuineClassId(fn, ctx)}:`);
    }
    genuinePrivate = { fields: gpInfo.fields };
    ctx.needsReifySlot = true;
  } else {
    // A captured class instance flows through `Object.create(Class.prototype)`, so the class can
    // be shrunk to only the prototype methods the closure can actually reach — pruning the rest
    // and routing the kept ones through the replacer (observation). Done FIRST, on the original
    // source, so the downstream rewrites operate on the already-pruned class. No-op for a
    // non-class, a class captured as a value, or one reached wholesale (keep-all).
    const ms0 = classStructure(original);
    const pruned = ms0 !== null ? pruneClassMethods(fn, original, ms0, ctx) : original;
    // A mangled class still re-evaluates its static blocks / static field initializers when the
    // class is defined; strip those so their side effects don't re-run (instance fields never
    // run on the ObjectCreate path, so they're left alone). Non-class functions: no-op.
    const ms = pruned === original ? ms0 : classStructure(pruned);
    const pre = ms !== null ? neutralizeClassInitializers(pruned, ms.node, ms.offset, false) : pruned;
    source = rewritePrivateMembers(pre);
    // An arrow that reads a `#private` through its lexical `this` cannot be reconstructed:
    // the receiving instance is baked in lexically and is not recoverable. Reject it (the
    // mangled source IS parseable, unlike the `#x` original) instead of emitting
    // silently-broken output — a private read off an unbound `this`.
    // An arrow that reads a `#private` through its lexical `this` is reconstructed by
    // HOSTING: a synthetic method injected into the (genuine) class returns the arrow, and
    // it's obtained by invoking that host on the reified instance (ctx.hostedArrows). If it
    // wasn't hosted (its `this` class isn't genuine-reconstructable, or it captures more
    // than `this`/brands), it cannot be reconstructed — reject it instead of emitting
    // silently-broken output.
    if (!ctx.hostedArrows.has(fn) && arrowReadsLexicalThis(source)) {
      const isPrivate = source.includes(PRIVATE_PREFIX) && arrowReadsLexicalThisPrivate(source);
      throw new TypeError(
        isPrivate
          ? "Cannot serialize an arrow function that reads a #private field through its lexical `this`: " +
            "the receiving instance cannot be recovered. Capture the value first, e.g. " +
            "`const v = this.#x; return () => v;`."
          : "Cannot serialize an arrow function that reads its lexical `this`: " +
            "the receiving instance is baked in lexically and cannot be recovered. Capture the value " +
            "first, e.g. `const x = this.x; return () => x;`.",
      );
    }
    // A method extracted from its object/class and reconstructed standalone loses its
    // [[HomeObject]], so `super` becomes a syntax error in the emitted module. Reject clearly
    // rather than emit unimportable output. (super inside the whole object/class IS fine —
    // there it's reconstructed in its home context; this only fires for the peeled-off method.)
    // Cheap textual guard first: `super` is rare, so skip the parse+walk for the common case.
    if (source.includes("super") && functionUsesSuper(source)) {
      throw new TypeError(
        "Cannot serialize a method that uses `super`: it depends on the home object it was " +
          "defined in, which is lost when the method is extracted on its own. Serialize the whole " +
          "object or class instead.",
      );
    }
  }

  return reconstructFromSource(fn, ctx, source, genuinePrivate);
}

// The shared tail of function reconstruction: given a function and its (possibly
// rewritten) source, resolve free variables into a binding prelude, handle class
// heritage / field-initializer captures, and wrap the result as an expression with
// the source-map offsets. Used both for ordinary functions and for the synthetic
// `function* name(){body}` source a suspended generator reconstructs through.
function reconstructFromSource(
  fn: Function,
  ctx: Context,
  source: string,
  genuinePrivate: { fields: string[] } | undefined,
): ReconstructedFunction {
  const freeVariables = allFreeVariables(fn, source);
  let location = (fn as any)[Symbol.sourceLocation] as ReconstructedFunction["location"];
  // A class's own Symbol.sourceLocation is unreliable (empty url, line always 1), so its
  // body would never chain (or would chain to the wrong line). Derive a correct anchor
  // from a method, whose location IS reliable, so class-body frames map to the real source.
  if (location !== undefined && !location.url) {
    location = classSourceAnchor(fn, source) ?? location;
  }

  const bindings: string[] = [];
  // Names already resolvable in the reconstructed output (so a field-initializer
  // capture below doesn't re-bind them): every free variable (inlined, shared at
  // module scope, or re-imported all resolve by name).
  const boundNames = new SetCtor<string>();
  for (const variable of freeVariables) {
    boundNames.add(variable.name);
    // Shared cells are declared once at module scope; the source resolves to
    // them by name, so don't shadow them with a private binding here.
    if (ctx.sharedIds.has(variable.id)) continue;
    // External imports (native / node:* / builtins) can't be inlined — re-emit
    // them as `import` statements at module scope; the source resolves to them.
    if (variable.import?.external) {
      ctx.imports.add(importStatement(variable));
      continue;
    }
    const value = transform(undefined, variable.name, variable.value, ctx);
    bindings.push(`${variable.kind} ${variable.name} = ${emitValue(value, ctx)};`);
  }

  // A class's `extends <heritage>` superclass is referenced by the source but is
  // not a free variable, so bind it explicitly (its identity is the class's own
  // prototype). A simple identifier is bound in place; a computed heritage
  // (`extends mixin(Base)`) is rewritten to a synthetic identifier — line count
  // preserved so source maps stay correct.
  const heritage = classHeritage(fn, source, ctx);
  if (heritage !== undefined) {
    source = heritage.source;
    bindings.push(heritage.binding);
  }

  // Variables referenced ONLY by a class field initializer are invisible to the
  // bytecode free-variable scan (the initializer is a separate executable), but
  // the AST surfaces their names and they still live in the class's scope. Find
  // those names and resolve each natively against the class's scope chain.
  for (const binding of fieldInitializerBindings(fn, source, boundNames, ctx)) {
    bindings.push(binding);
  }
  const sourceLineCount = source.split("\n").length;

  // functionSourceToExpression always places the original source on its own
  // first line, so the only vertical offset comes from the IIFE wrapper.
  const fnExpr = functionSourceToExpression(source, (fn as any).name);
  if (bindings.length === 0) {
    return { expr: fnExpr, sourceLineOffset: 0, sourceLineCount, source, location, genuinePrivate };
  }
  // (function () {\n  <bindings...>\n  return <fnExpr>;\n})()
  // The `return` line is at offset 1 (header) + bindings.length.
  return {
    expr: `(function () {\n${bindings.join("\n")}\nreturn ${fnExpr};\n})()`,
    sourceLineOffset: 1 + bindings.length,
    sourceLineCount,
    source,
    location,
    genuinePrivate,
  };
}

// The free variables a function closes over. For a class, Symbol.freeVariables
// reports only what the constructor body references, not its methods — so union
// in each method's (and static member's) own free variables, deduped by cell id.
// Methods share the class's defining scope, so same-named captures are the same
// cell.
// A class's own Symbol.sourceLocation is unreliable (empty url, line always 1). Derive a
// correct anchor for the class's FIRST source line from one of its methods, whose location
// IS reliable: find a prototype method that is locatable in `source`, and subtract that
// method's line offset within `source` from its true file line. Returns undefined if no
// usable method is found (the class then simply isn't source-mapped).
function classSourceAnchor(
  fn: Function,
  source: string,
): { url: string; line: number; column: number; endLine?: number } | undefined {
  const parsed = parseWithOffset(source);
  if (parsed === null) return undefined;
  const members = parsed.node.body?.body;
  if (!$isJSArray(members)) return undefined;
  const proto = fn.prototype;
  if (proto == null) return undefined;
  let anchor: { url: string; line: number; column: number } | undefined;
  // The class's last original line, for the source-map clamp (see buildSourceMap): the max of
  // its methods' file end lines. Like a function's endLine, this stops a compact (e.g.
  // single-line) class — which toString() reprints onto more lines than it spans — from
  // mapping body lines past the definition.
  let endLine = 0;
  for (const m of members) {
    if (m.type !== "MethodDefinition" || m.static === true) continue;
    const key = m.key?.value;
    if (typeof key !== "string" || key === "constructor") continue;
    if (typeof m.value?.start !== "number") continue;
    const d = ObjectGetOwnPropertyDescriptor(proto, key);
    const method = d?.value ?? d?.get ?? d?.set;
    const loc = (method as any)?.[Symbol.sourceLocation] as
      | { url?: string; line?: number; endLine?: number }
      | undefined;
    if (!loc?.url || typeof loc.line !== "number") continue;
    if (typeof loc.endLine === "number" && loc.endLine > endLine) endLine = loc.endLine;
    if (anchor !== undefined) continue;
    const posInSource = m.value.start - parsed.offset; // the method's params `(`
    if (posInSource < 0 || posInSource > source.length) continue;
    let rel = 0;
    for (let i = 0; i < posInSource; i++) if (source[i] === "\n") rel++;
    const line = loc.line - rel;
    // `rel` is the member's line offset within `toString()`, while `loc.line` is its FILE
    // line. When toString() reformats a one-line class onto many lines, `rel` exceeds the
    // file span and `line` goes <= 0 — an unreliable anchor. Skip mapping rather than emit a
    // bogus (or crashing) map; the function still reconstructs, it just isn't stack-mapped.
    if (line < 1) continue;
    anchor = { url: loc.url, line, column: 1 };
  }
  if (anchor === undefined) return undefined;
  return { ...anchor, endLine: endLine >= anchor.line ? endLine : undefined };
}

// True if the AST contains any `Unsupported` node — ast() surfaces some constructs (yield*,
// await, …) opaquely, so an identifier-reference walk over such a tree is incomplete.
function containsUnsupportedNode(node: any): boolean {
  if ($isJSArray(node)) {
    for (const x of node) if (containsUnsupportedNode(x)) return true;
    return false;
  }
  if (!node || typeof node !== "object") return false;
  if (node.type === "Unsupported") return true;
  for (const k of ObjectKeys(node)) if (k !== "type" && containsUnsupportedNode(node[k])) return true;
  return false;
}

function allFreeVariables(fn: Function, source: string): FreeVariable[] {
  const own = ((fn as any)[Symbol.freeVariables] as FreeVariable[] | undefined) ?? [];
  // The native Symbol.freeVariables getter scans the bytecode identifier table, which
  // includes PROPERTY and METHOD NAMES (e.g. `read` in `{ read: ... }` or `obj.read`). If
  // such a name coincidentally matches an outer binding, it is WRONGLY reported as a free
  // variable — and binding it can even break (e.g. a name that's actually a later-emitted
  // value). Cross-check against real AST identifier REFERENCES: object/member/method keys
  // are StringLiterals that freeIdentifiersOfNode skips, so only genuine references survive.
  // Unparseable sources (an extracted method whose `this.#x` is invalid standalone) keep all,
  // conservatively — as do sources with opaque `Unsupported` AST nodes (yield*, await, …)
  // that hide the references inside, which would otherwise cause a legitimate capture to be
  // dropped. Filter ONLY when the parse is complete.
  const node = parseFunctionNode(source);
  const refs = node !== null && !containsUnsupportedNode(node) ? freeIdentifiersOfNode(node) : null;
  const isRealRef = (v: FreeVariable) => refs === null || refs.has(v.name);

  // Filter the reconstruction machinery's own identifiers (`#brand`, the reify slot) so they
  // are never re-bound as external captures on RE-serialization (see isInternalFreeVariableName).
  const isInternal = isInternalFreeVariableName;

  if (!source.trimStart().startsWith("class")) {
    // `#name` private brands are recreated by the mangling rewrite (the receiver
    // carries the mangled field), never captured as an external free variable —
    // applies to a method extracted from a class just as to the class itself.
    return own.filter(v => !isInternal(v.name) && isRealRef(v));
  }

  const byId = new MapCtor<number, FreeVariable>();
  for (const variable of own) {
    // `#name` private brands are an internal mechanism recreated by the class
    // body itself — never an external capture.
    if (isInternal(variable.name)) continue;
    byId.set(variable.id, variable);
  }
  collectMemberFreeVariables(fn, fn, byId);
  if (typeof fn === "function" && fn.prototype) collectMemberFreeVariables(fn.prototype, fn, byId);
  return [...byId.values()].filter(isRealRef);
}

function collectMemberFreeVariables(holder: object, classFn: Function, byId: Map<number, FreeVariable>): void {
  for (const key of ReflectOwnKeys(holder)) {
    const descriptor = ObjectGetOwnPropertyDescriptor(holder, key)!;
    for (const member of [descriptor.value, descriptor.get, descriptor.set]) {
      if (typeof member !== "function") continue;
      const memberVars = (member as any)[Symbol.freeVariables] as FreeVariable[] | undefined;
      if (!memberVars) continue;
      for (const variable of memberVars) {
        // A reference to the class's own name resolves to the class expression's
        // binding, and reconstruction-internal names (`#brand`, the reify slot) are
        // recreated by the class body / module — none should be bound externally.
        if (variable.value === classFn || isInternalFreeVariableName(variable.name)) continue;
        if (!byId.has(variable.id)) byId.set(variable.id, variable);
      }
    }
  }
}

// If `fn` is a class with a superclass, returns the (possibly rewritten) source
// plus a binding bringing the superclass into scope. A simple identifier
// (`extends Base`) is bound as-is; a computed heritage (`extends mixin(Base)`,
// `extends ns.Base`) has its heritage expression replaced by a synthetic
// identifier bound to the captured superclass value. The superclass identity is
// the class's own prototype, reliable even though it isn't a free variable.
function classHeritage(fn: Function, source: string, ctx: Context): { source: string; binding: string } | undefined {
  if (!source.trimStart().startsWith("class")) return undefined;
  const superclass = ObjectGetPrototypeOf(fn);
  if (typeof superclass !== "function" || superclass === Function.prototype) return undefined;

  const parsed = parseWithOffset(source);
  const node = parsed?.node;
  if (node === undefined || (node.type !== "ClassDeclaration" && node.type !== "ClassExpression") || !node.superClass) {
    return undefined; // no class / no extends clause we can locate
  }
  const sc = node.superClass;

  // `extends Identifier`: the heritage is a single name that resolves in scope;
  // bind it, no source edit needed.
  if (sc.type === "Identifier" && typeof sc.name === "string") {
    return { source, binding: `const ${sc.name} = ${emitValue(superclass, ctx)};` };
  }

  // Computed heritage (`extends mixin(Base)`, `extends ns.Base`, `extends (cond ? A : B)`):
  // replace the WHOLE heritage clause with a synthetic identifier bound to the captured value.
  // Anchor on the heritage-clause start (`superClassStart`, the first token after `extends`,
  // surfaced by ast()) rather than the heritage EXPRESSION's start — the expression node's start
  // sits INSIDE any wrapping parens, so replacing just it would consume the closing `)` (trimmed
  // back from the brace) while leaving a dangling `(`.
  const start = typeof node.superClassStart === "number" ? node.superClassStart - parsed!.offset : -1;
  const brace = node.body?.start === undefined ? -1 : node.body.start - parsed!.offset;
  if (start < 0 || brace <= start || brace > source.length) return undefined;
  let end = brace;
  while (end > start && /\s/.test(source[end - 1]!)) end--;
  const superName = `__bunSuper$${ctx.counter++}`;
  // Preserve the heritage's line span so generated line numbers (and thus the
  // source map) don't shift.
  const newlines = source.slice(start, end).split("\n").length - 1;
  const replacement = superName + "\n".repeat(newlines);
  return {
    source: source.slice(0, start) + replacement + source.slice(end),
    binding: `const ${superName} = ${emitValue(superclass, ctx)};`,
  };
}

// The free identifier names referenced by an AST node, excluding names bound
// within it (params, declarators, nested function/class names, destructuring).
function freeIdentifiersOfNode(node: any): Set<string> {
  const refs = new SetCtor<string>();
  const bound = new SetCtor<string>();
  const bindNames = (n: any): void => {
    if (!n || typeof n !== "object") return;
    switch (n.type) {
      case "Identifier":
        bound.add(n.name);
        break;
      case "AssignmentPattern":
        bindNames(n.left);
        break;
      case "ArrayPattern":
        for (const el of n.elements || []) bindNames(el);
        break;
      case "ObjectPattern":
        for (const p of n.properties || []) bindNames(p.value);
        break;
      case "RestElement":
        bindNames(n.argument);
        break;
    }
  };
  (function walk(n: any): void {
    if ($isJSArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    if (!n || typeof n !== "object" || typeof n.type !== "string") return;
    if (n.type === "Identifier") {
      refs.add(n.name);
      return;
    }
    if (n.type === "MemberExpression") {
      // `obj.prop` references `obj`, not `prop`; only `obj[expr]` reads `expr`.
      walk(n.object);
      if (n.computed) walk(n.property);
      return;
    }
    if (
      n.type === "FunctionDeclaration" ||
      n.type === "FunctionExpression" ||
      n.type === "ArrowFunctionExpression" ||
      n.type === "ClassDeclaration" ||
      n.type === "ClassExpression"
    ) {
      if (n.id) bound.add(n.id.name);
      for (const p of n.params || []) bindNames(p);
    }
    if (n.type === "VariableDeclarator") bindNames(n.id);
    for (const k in n) {
      if (k === "type" || k === "start") continue;
      walk(n[k]);
    }
  })(node);
  for (const b of bound) refs.delete(b);
  return refs;
}

// Resolves variables referenced only by a class field initializer (or a computed
// member-key expression) and returns `const <name> = <value>;` bindings for the
// ones that live in the class's scope and aren't already bound.
function fieldInitializerBindings(fn: Function, source: string, boundNames: Set<string>, ctx: Context): string[] {
  if (!source.trimStart().startsWith("class")) return [];
  const classNode = parseFunctionNode(source);
  const members = classNode?.body?.body;
  if (!$isJSArray(members)) return [];
  if (classNode.id?.name) boundNames.add(classNode.id.name);

  const names = new SetCtor<string>();
  for (const m of members) {
    if (!m || typeof m !== "object") continue;
    // Field initializer values (`x = <expr>`). The value runs in the class's scope
    // (per-instance for instance fields, at definition for static), so a captured var it
    // references is resolvable.
    if (m.type === "PropertyDefinition" && m.value) for (const n of freeIdentifiersOfNode(m.value)) names.add(n);
    // Computed member keys (`[expr]() {}` / `[expr] = v`). The key expression is evaluated
    // when the class definition runs, in the class's defining scope — so a captured var it
    // references (e.g. a Symbol) is resolvable and must be bound BEFORE the class.
    if (m.computed && m.key) for (const n of freeIdentifiersOfNode(m.key)) names.add(n);
  }

  const bindings: string[] = [];
  for (const name of names) {
    if (boundNames.has(name)) continue;
    // The reify slot (`$bunClosureReify$`) appears in a reconstructed class's field-init guard
    // `<key> = $bunClosureReify$ ? undefined : (<init>)`. On RE-serialization the AST surfaces it
    // here, and resolving it against the class's scope would bind a LOCAL `const $bunClosureReify$
    // = false` inside the IIFE — shadowing the module-level mutable slot the reify factory toggles,
    // so the bare construct would re-run every initializer. It (and any `#brand`) is reconstructed
    // by the module/class itself, never an external capture — skip it. Keeps re-serialization
    // idempotent (round 2+ must NOT shadow the slot; see isInternalFreeVariableName).
    if (isInternalFreeVariableName(name)) continue;
    const resolved = $resolveClosureBinding(fn, name) as { found: boolean; value: unknown };
    if (!resolved.found) continue; // a global, or not in the class's scope — leave as-is
    boundNames.add(name);
    const value = transform(undefined, name, resolved.value, ctx);
    bindings.push(`const ${name} = ${emitValue(value, ctx)};`);
  }

  // Computed keys whose identifier is used ONLY as the key (`[mk]() {}` and `mk` is
  // referenced nowhere else) are pruned from the class's scope by JSC, so the resolve above
  // can't find them. Recover the ACTUAL evaluated key from the reconstructed class's own
  // members and bind the identifier to it.
  for (const [name, value] of recoverComputedKeyValues(fn, members, boundNames)) {
    boundNames.add(name);
    bindings.push(`const ${name} = ${emitValue(transform(undefined, name, value, ctx), ctx)};`);
  }
  return bindings;
}

// For each member with a computed identifier key (`[mk]() {}`) whose identifier is still
// unbound, recover the real evaluated key from the live class and bind the identifier to it.
// Matching is robust (not order-based: ReflectOwnKeys groups strings before symbols): a
// computed member's reconstructed source begins with `[name]`, so we find the holder key
// whose own method/accessor `toString()` begins with `[name]`. Returns [name, key] entries.
function recoverComputedKeyValues(fn: Function, members: any[], boundNames: Set<string>): Array<[string, unknown]> {
  const out: Array<[string, unknown]> = [];
  // `[name]` at the start of a member source, after any modifiers (async/*/get/set/static).
  const startsWithComputed = (src: string, name: string): boolean =>
    new RegExp(`^\\s*(?:static\\s+|async\\s+|get\\s+|set\\s+|\\*\\s*)*\\[\\s*${name}\\s*\\]`).test(src);
  for (const m of members) {
    if (!m.computed || m.key?.type !== "Identifier") continue;
    const name = m.key.name as string;
    if (boundNames.has(name)) continue;
    const holder = m.static ? fn : fn.prototype;
    if (holder == null) continue;
    for (const k of ReflectOwnKeys(holder)) {
      const d = ObjectGetOwnPropertyDescriptor(holder, k);
      if (d === undefined) continue;
      const f = d.value ?? d.get ?? d.set;
      if (typeof f !== "function") continue;
      let src: string;
      try {
        src = funcSource(f);
      } catch {
        continue;
      }
      if (startsWithComputed(src, name)) {
        out.push([name, k]);
        break;
      }
    }
  }
  return out;
}

// Applies the replacer (if any) to a value before it is serialized. `holder` is
// the object/array the value came from (the replacer's `this`), matching
// JSONStringify; it is undefined for top-level free-variable values.
function transform(holder: unknown, key: string, value: unknown, ctx: Context): unknown {
  return ctx.replacer ? ctx.replacer.$call(holder, key, value) : value;
}

// The replacer key for a Map VALUE: the entry's own key when it's a string (the natural analog of
// an object property name), else the positional index. Map keys are never passed `""` — that
// collides with JSON's synthetic root key, so a replacer dropping `""` would wipe the collection.
function mapReplacerKey(key: unknown, index: number): string {
  return typeof key === "string" ? key : String(index);
}

// Returns a JS expression for `value`, appending any hoisted declarations to
// `ctx.module` (for objects and nested functions).
function emitValue(value: unknown, ctx: Context): string {
  switch (typeof value) {
    case "string":
      return JSONStringify(value);
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
      if (isAsyncLocalStorage(value as object)) return emitAsyncLocalStorage(value as object, ctx);
      if ($isProxyObject(value)) return emitProxy(value as object, ctx);
      return emitObject(value as object, ctx);
    case "function":
      // A Proxy whose target is callable has typeof "function".
      if (isAsyncLocalStorage(value as object)) return emitAsyncLocalStorage(value as object, ctx);
      if ($isProxyObject(value)) return emitProxy(value as object, ctx);
      return emitFunction(value as Function, ctx);
    case "symbol":
      return emitSymbol(value as symbol, ctx);
    default:
      throw new TypeError(`Cannot serialize a free variable of type ${typeof value}`);
  }
}

// A module namespace object (`import * as ns`) carries `Symbol.toStringTag === "Module"` as an OWN
// property (an exotic-object invariant). Read the OWN descriptor rather than
// `Object.prototype.toString.call(value)`: the latter does a `Get(value, @@toStringTag)` that walks
// the whole prototype chain, so for a deep `Object.create` chain it cost O(depth) on EVERY object
// (an O(N²) trap). The own-property read is O(1) and matches the same real namespace objects.
function isModuleNamespaceObject(value: object): boolean {
  return ObjectGetOwnPropertyDescriptor(value, Symbol.toStringTag)?.value === "Module";
}

// A (sync) generator object's reconstructable states (Tier A), fork-free and portable:
//   - SuspendedStart (state 0): never `.next()`-ed. The generator's body source and original
//     name are read natively; parameters were bound to their argument values and surface as
//     captured free variables of the body function, so a generator of ANY arity is rebuilt as
//     `function* name() {body}`, its free variables re-bound, then `.call(this)` to obtain a
//     fresh not-yet-started generator with the same first-resume behavior.
//   - Completed (state -1): exhausted; yields {value: undefined, done: true} forever and its
//     body/frame are no longer observable — emit a minimal pre-exhausted generator.
// A generator paused mid-iteration (state > 0) keeps its yield point and live locals in
// engine-internal slots (the locals are keyed by numeric register, their source names discarded
// by the compiler) and cannot be expressed as source — reject clearly. Returns undefined to let
// the caller fall through to the generic reject when no source is introspectable.

// Reserved words that are legal as a METHOD name but NOT as a function-expression binding name in
// strict/module code (the emitted output is ESM). `ecmaName()` can hand us any of these.
const RESERVED_FUNCTION_NAMES = new SetCtor<string>([
  "yield",
  "await",
  "let",
  "static",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "default",
  "break",
  "continue",
  "return",
  "function",
  "class",
  "extends",
  "super",
  "new",
  "delete",
  "typeof",
  "instanceof",
  "in",
  "void",
  "this",
  "null",
  "true",
  "false",
  "var",
  "const",
  "throw",
  "try",
  "catch",
  "finally",
  "with",
  "debugger",
  "export",
  "import",
  "enum",
]);
// True when `name` is safe to use as a generator function-expression name: a plain ASCII binding
// identifier that isn't a reserved word. Non-ASCII / non-identifier / reserved names fall back to
// anonymous (the name is cosmetic), so reconstruction never emits un-parseable source.
function isUsableFunctionName(name: string): boolean {
  if (name === "" || RESERVED_FUNCTION_NAMES.has(name)) return false;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return false;
  return true;
}

function emitGenerator(
  value: object,
  gs: { state: number; this: unknown; name: string; body: string; fn: Function },
  ctx: Context,
): string | undefined {
  const { state } = gs;
  if (state > 0) {
    throw new TypeError(
      "Cannot serialize a generator that has started iterating: its paused execution state " +
        "(the current yield point and live local variables) lives in engine-internal slots that " +
        "are not expressible as source. Serialize it before the first .next() call, or re-create " +
        "the iterator from its generator function after reconstruction.",
    );
  }
  if (state === -2) {
    throw new TypeError("Cannot serialize a generator while it is executing.");
  }

  const refName = REF_PREFIX + ctx.counter++;
  // Record BEFORE recursing into `this` / captured free variables so a cycle (a generator
  // captured by the very object that is its `this`) resolves back to this declaration.
  ctx.refs.set(value, refName);

  if (state === -1) {
    ctx.module.push(`const ${refName} = (() => { const g = (function* () {})(); g.next(); return g; })();`);
    return refName;
  }

  // SuspendedStart. Without an introspectable body we can't rebuild it — undo the ref record
  // and fall through to the generic reject.
  if (typeof gs.body !== "string" || typeof gs.name !== "string") {
    ctx.refs.delete(value);
    ctx.counter--;
    return undefined;
  }
  // A generator that reads `arguments` cannot be rebuilt parameter-free: JSC captures the
  // outer `arguments` object as a free variable of the body, but an arguments object's identity
  // (and its callee) is not reconstructable. Detect it via the captured-variable name (the
  // engine surfaces it as a free variable) rather than scanning source, and reject clearly.
  const freeVars = (gs.fn as any)[Symbol.freeVariables] as Array<{ name: string }> | undefined;
  if ($isJSArray(freeVars)) {
    for (const v of freeVars) {
      if (v.name === "arguments") {
        ctx.refs.delete(value);
        ctx.counter--;
        throw new TypeError(
          "Cannot serialize a generator that reads `arguments`: the arguments object is not " +
            "recoverable once the generator is suspended. Capture the values you need into named " +
            "variables before the first `yield`.",
        );
      }
    }
  }
  // gs.body is the generator body block (`{ ... }`); the parameters are captured by value, so the
  // rebuilt function takes none. The name is purely cosmetic (`.name`) — but `ecmaName()` can be a
  // RESERVED word (a `*yield(){}` method) or a non-identifier string key (`{ "a-b": *(){} }`),
  // neither of which is legal as a generator-function-expression name; fall back to anonymous so we
  // never emit un-importable source. (A non-ASCII identifier name also falls back — cosmetic only.)
  const genName = isUsableFunctionName(gs.name) ? gs.name : "";
  const wrappedSource = `function* ${genName} () ${gs.body}`;
  // The body must be reconstructable as a STANDALONE generator. If it reads a `#private` field (or
  // any syntax invalid outside its defining class/scope), `function* (){ … this.#x … }` won't parse
  // — reject clearly instead of emitting source that throws a SyntaxError at import.
  if (parseWithOffset(wrappedSource) === null) {
    ctx.refs.delete(value);
    ctx.counter--;
    throw new TypeError(
      "Cannot serialize a generator whose body can't be reconstructed standalone (it reads a " +
        "#private field, or uses syntax not valid outside its defining scope). Capture the values " +
        "you need into named variables before the first `yield`.",
    );
  }
  const rec = reconstructFunctionExpr(gs.fn, ctx, wrappedSource);
  const thisExpr = emitValue(transform(undefined, "this", gs.this, ctx), ctx);
  ctx.module.push(`const ${refName} = (${rec.expr}).call(${thisExpr});`);
  return refName;
}

function emitObject(value: object, ctx: Context): string {
  const existing = ctx.refs.get(value);
  if (existing !== undefined) return existing;

  // Built-ins whose contents can't be enumerated or whose state can't be captured: reject loudly
  // rather than silently emitting an empty object. Detect them by INTERNAL SLOT ($-intrinsics),
  // not `instanceof` / `Symbol.toStringTag` — a plain object can spoof those (forge the tag, or
  // be `Object.create(Promise.prototype)`) and must not be misrouted/falsely rejected.
  if ($isPromise(value) && $isPromisePending(value)) {
    // A pending promise's resolution is tied to live I/O / timers / a suspended
    // async frame in the event loop — not expressible as source. (Settled
    // promises are reconstructed in emitBuiltin.)
    throw new TypeError(
      "Cannot serialize a pending Promise (its resolution is tied to live I/O or timers). " +
        "Await it first, or serialize the settled value.",
    );
  }
  // A (sync) generator object in a reconstructable state — not-yet-started (SuspendedStart) or
  // completed — is rebuilt from its body source + captured free variables (Tier A). Mid-iteration
  // generators, async generators, and built-in iterators fall through to the reject below.
  const generatorState = $bunGeneratorState(value);
  if (generatorState !== undefined) {
    const emitted = emitGenerator(value, generatorState, ctx);
    if (emitted !== undefined) return emitted;
  }

  // Generator / async-generator objects and built-in iterator objects hold suspended execution
  // state (the yield point and local frame) in engine slots that aren't reachable via reflection
  // and can't be expressed as source. Reject clearly instead of walking their native prototype
  // chain (which would throw an opaque "native function" error or silently emit a dead object).
  // Detected by the actual JSC cell type (spoof-proof) — a forged Symbol.toStringTag can't fool it.
  const unserializableTag = $bunClosureUnserializableTag(value);
  if (unserializableTag !== undefined) {
    throw new TypeError(
      `Cannot serialize a ${unserializableTag} object ` +
        `(its suspended execution state is not expressible as source). ` +
        `Serialize the generator function instead and re-create the iterator after reconstruction.`,
    );
  }

  // Well-known global namespace objects / singletons (globalThis, Math, JSON, Reflect, console,
  // process, ...) are reachable by a stable global path. Emit a REFERENCE to that path — preserving
  // identity (`captured === Math`) and avoiding both a useless deep copy and the
  // recurse-into-native-methods failure — exactly as a captured native FUNCTION is referenced by
  // its nativeFunctionPath. The reconstructed module re-binds to its own realm's globals.
  const nativeObjPath = nativeObjectPath(value);
  if (nativeObjPath !== undefined) {
    const refName = REF_PREFIX + ctx.counter++;
    ctx.refs.set(value, refName);
    ctx.module.push(`const ${refName} = ${nativeObjPath};`);
    return refName;
  }

  const name = REF_PREFIX + ctx.counter++;
  // Record BEFORE recursing so a self-reference resolves to `name`.
  ctx.refs.set(value, name);

  // Each path emits the `const name = <base>` declaration SYNCHRONOUSLY and returns a thunk for
  // the (deep, recursive) body. The body is enqueued — not run inline — so emission depth lives
  // on the heap (ctx.bodyQueue) rather than the JS call stack. A non-extensible/sealed/frozen
  // state is applied LAST in the body, after every property and cycle is wired (freeze rejects
  // later mutation). A genuine-private class instance (incl. a genuine subclass of a builtin
  // like Map) goes through its reify factory + patch methods, not the builtin/object paths.
  const finishExtensibility = (): void => {
    if (!ObjectIsExtensible(value)) emitNonExtensible(name, value, ctx);
  };
  const genuineBody = emitGenuinePrivateInstance(value, name, ctx);
  if (genuineBody !== null) {
    ctx.bodyQueue.push(() => {
      genuineBody();
      finishExtensibility();
    });
    return name;
  }
  const builtin = emitBuiltin(value, name, ctx);
  if (builtin !== null) {
    ctx.bodyQueue.push(() => {
      builtin.body();
      // A built-in subclass (`class X extends Map/Set/...`): the base data is built; restore the
      // subclass prototype + its own/private instance fields.
      if (ObjectGetPrototypeOf(value) !== builtin.proto) restoreSubclass(value, name, ctx);
      finishExtensibility();
    });
    return name;
  }
  const objBody = emitObjectBody(value, name, ctx);
  ctx.bodyQueue.push(() => {
    objBody();
    // An array subclass (`class X extends Array`) is constructed as a plain array above; restore
    // its prototype and any extra (non-index) own/private fields.
    if (ArrayIsArray(value) && ObjectGetPrototypeOf(value) !== ArrayCtor.prototype) {
      restoreSubclass(value, name, ctx, arrayIndexSkip(value));
    }
    finishExtensibility();
  });
  return name;
}

// Restores a built-in subclass instance: set its real prototype, then emit its
// extra own properties (instance fields) and private fields. `skip` excludes
// keys already materialized by the base construction (array indices + length).
function restoreSubclass(value: object, name: string, ctx: Context, skip?: Set<string>): void {
  // Point at the reconstructed class's own `.prototype` (not a standalone copy)
  // so `instanceof` and the shared prototype identity survive — same shape as
  // objectBaseExpression's class-instance case.
  const proto = ObjectGetPrototypeOf(value);
  const ctor = (proto as any)?.constructor;
  const protoExpr =
    typeof ctor === "function" && ctor.prototype === proto
      ? `${emitValue(ctor, ctx)}.prototype`
      : emitValue(proto, ctx);
  ctx.module.push(`Object.setPrototypeOf(${name}, ${protoExpr});`);
  emitOwnProperties(name, value, ctx, skip);
  emitPrivateFields(name, value, ctx);
}

// The canonical array-INDEX keys actually present on `array` (a sparse array with a huge
// `.length` but few elements has only those). Driven by the real own keys, NOT a `[0, length)`
// scan — `new Array(4294967295)` must not take 4 billion iterations / allocate 4 billion strings.
function arrayPresentIndices(array: unknown[]): number[] {
  const out: number[] = [];
  for (const key of ObjectKeys(array)) {
    const n = +key;
    if (NumberIsInteger(n) && n >= 0 && n < 4294967295 && String(n) === key) out.push(n);
  }
  return out;
}

function arrayIndexSkip(value: unknown[]): Set<string> {
  const skip = new SetCtor<string>(["length"]);
  for (const i of arrayPresentIndices(value)) skip.add(String(i));
  return skip;
}

// Emits the object's `const name = <base>` declaration SYNCHRONOUSLY (so a parent referencing
// `name` always sees a declared binding) and returns a thunk that emits the BODY (property
// assignments / members) — deferred via emitObject so emission depth lives on the heap.
function emitObjectBody(value: object, name: string, ctx: Context): () => void {
  if (ArrayIsArray(value)) {
    ctx.module.push(`const ${name} = [];`);
    const array = value as unknown[];
    return () => {
      const indices = arrayPresentIndices(array);
      for (const i of indices) {
        const child = transform(value, String(i), array[i], ctx);
        ctx.module.push(`${name}[${i}] = ${emitValue(child, ctx)};`);
      }
      const presentIndices = indices.length;
      // Preserve the length, including trailing holes.
      ctx.module.push(`${name}.length = ${array.length};`);
      // An array can carry NON-index own properties (`a.foo = ...`, a symbol key, a
      // non-canonical-index string, a non-enumerable prop). Emit those too — but only when some
      // exist: own names beyond the present indices + `length`, or any symbol key. (The common
      // dense array has none, and an unconditional emitOwnProperties walk is a measurable cost.)
      if (
        ObjectGetOwnPropertyNames(array).length > presentIndices + 1 ||
        ObjectGetOwnPropertySymbols(array).length > 0
      ) {
        emitOwnProperties(name, value, ctx, arrayIndexSkip(array));
      }
    };
  }
  if (isModuleNamespaceObject(value)) {
    // A module namespace (`import * as ns`) — emit only the members the closure
    // referenced (access-path pruned), as a plain object. Its exotic prototype
    // chain and `Symbol.toStringTag` must NOT be walked (that reaches native
    // built-ins). Each member is read live and serialized like any value, so
    // imported functions/objects are inlined and tree-shaken to what's used.
    ctx.module.push(`const ${name} = {};`);
    return () => {
      const keep = ctx.keepSets.get(value);
      for (const key of ReflectOwnKeys(value)) {
        if (typeof key !== "string") continue;
        if (keep !== undefined && keep !== "all" && !keep.has(key)) continue;
        const child = transform(value, key, (value as any)[key], ctx);
        if (child === undefined) continue;
        ctx.module.push(`${name}[${JSONStringify(key)}] = ${emitValue(child, ctx)};`);
      }
    };
  }
  // `value instanceof Error` walks the prototype chain; guard it with the O(1) memoized
  // chain check so a deep `Object.create` chain doesn't pay an O(depth) walk per object
  // (Error.prototype is in BUILTIN_PROTOTYPES). Error instances have a shallow chain, so the
  // `instanceof` itself is cheap once the guard admits them.
  if (chainHasBuiltinPrototype(value) && value instanceof Error) {
    return emitErrorBody(value, name, ctx);
  }
  // Plain object / class instance (genuine-private instances are handled earlier in emitObject).
  ctx.module.push(`const ${name} = ${objectBaseExpression(value, ctx)};`);
  return () => {
    emitOwnProperties(name, value, ctx);
    emitPrivateFields(name, value, ctx);
  };
}

// If `value` is an instance of a class the gate cleared for genuine privates, emit it in two
// phases: (1) construct a BARE instance via the reify factory, emitted BEFORE its private
// values so cycles/self-references can refer back to it; (2) install the genuine `#private`
// slots by calling each chain class's patch method (after all instances exist). Public own
// properties are restored last. Real `#private` slots preserve privacy, brand checks, and
// `instanceof`. Returns false (caller uses the default ObjectCreate path) when not applicable.
function emitGenuinePrivateInstance(value: object, name: string, ctx: Context): (() => void) | null {
  const proto = ObjectGetPrototypeOf(value);
  if (proto === null) return null;
  const ctor = ownConstructor(proto);
  if (ctor === undefined || !ctx.genuineClasses.has(ctor)) return null;
  // Emit the class first so its (and its ancestors') reify factories are in ctx.classReify.
  emitValue(ctor, ctx);
  const reify = ctx.classReify.get(ctor);
  if (reify === undefined) return null;

  // DECL: bare construct. Emitted before any private value so a private referencing this
  // instance (or a cycle through another instance) resolves to an already-declared binding.
  // For a builtin subclass the factory's `super()` yields an empty Map/Set/Array; its content
  // is restored onto the live instance in the deferred body (the instance IS a Map/Set/Array).
  ctx.module.push(`const ${name} = ${reify.factory}();`);

  // Install privates. Each genuine class in the chain that declares private fields gets its own
  // patch method (sharing the name across the chain, reached via its prototype), each reading
  // only its own keys from the shared values object. The patch VALUES (emitValue, O(1) each)
  // and the patch CALLS are deferred to the end of the prelude — a private value can reference a
  // binding declared after this instance (e.g. a hosted arrow held in its own private slot).
  const patchClasses: Function[] = [];
  for (let p: object | null = proto; p && p !== Object.prototype; p = ObjectGetPrototypeOf(p)) {
    const c = ownConstructor(p);
    if (c !== undefined && (ctx.classReify.get(c)?.fields.length ?? 0) > 0) {
      patchClasses.push(c);
    }
  }
  const privateFields = (value as any)[Symbol.privateFields] as Array<{ name: string; value: unknown }> | undefined;
  if (patchClasses.length > 0 && privateFields && privateFields.length > 0) {
    // Symbol.privateFields is flat in base→derived declaration order; attribute each entry to
    // its declaring class (base-first) and key it by that class's id, so a same-named private
    // across the chain lands in the right genuine slot.
    const entries: string[] = [];
    let idx = 0;
    for (const c of [...patchClasses].reverse()) {
      const prefix = `${genuineClassId(c, ctx)}:`;
      for (const fname of ctx.classReify.get(c)?.fields ?? []) {
        const pf = privateFields[idx++];
        if (pf === undefined) continue;
        entries.push(`${JSONStringify(prefix + fname)}: ${emitValue(transform(value, pf.name, pf.value, ctx), ctx)}`);
      }
    }
    const valsName = REF_PREFIX + ctx.counter++;
    ctx.deferredPatches.push(`const ${valsName} = { ${entries.join(", ")} };`);
    for (const c of patchClasses) {
      ctx.deferredPatches.push(`${emitValue(c, ctx)}.prototype.${PATCH_METHOD}.call(${name}, ${valsName});`);
    }
  }
  // BODY (deferred): restore builtin-subclass content (.set/.add/indices) then public own props.
  return () => {
    const builtinSkip = restoreBuiltinContent(value, name, ctx);
    emitOwnProperties(name, value, ctx, builtinSkip);
  };
}

// Restores a genuine builtin subclass's content onto the already-constructed (empty) live
// instance: Map entries via `.set`, Set values via `.add`, array elements by index. Returns
// the own-property keys it handled (array indices + length) so the caller skips them.
function restoreBuiltinContent(value: object, name: string, ctx: Context): Set<string> | undefined {
  // A user subclass may OVERRIDE its iterator or `set`/`add` (e.g. to transform values or
  // log) — reading or restoring through the override would observe forged entries or re-apply
  // that transform/side effect on top of the already-final entries. Both the read (base
  // Symbol.iterator) and the restore (base set/add) go through the prototype directly so
  // restore reproduces the exact live contents. (The array branch assigns indices directly.)
  if (value instanceof MapCtor) {
    let i = 0;
    mapEachEntry(value, (k, v) => {
      const kx = emitValue(k, ctx);
      const vx = emitValue(transform(value, mapReplacerKey(k, i), v, ctx), ctx);
      ctx.module.push(`Map.prototype.set.call(${name}, ${kx}, ${vx});`);
      i++;
    });
    return undefined;
  }
  if (value instanceof SetCtor) {
    let i = 0;
    setEachValue(value, v => {
      ctx.module.push(`Set.prototype.add.call(${name}, ${emitValue(transform(value, String(i), v, ctx), ctx)});`);
      i++;
    });
    return undefined;
  }
  if (ArrayIsArray(value)) {
    for (const i of arrayPresentIndices(value)) {
      ctx.module.push(`${name}[${i}] = ${emitValue(transform(value, String(i), value[i], ctx), ctx)};`);
    }
    ctx.module.push(`${name}.length = ${value.length};`);
    return arrayIndexSkip(value as unknown[]);
  }
  return undefined;
}

// Emits an instance's private (#name) field values (read natively) as the
// matching mangled public properties the rewritten class methods reference.
function emitPrivateFields(name: string, value: object, ctx: Context): void {
  const privateFields = (value as any)[Symbol.privateFields] as Array<{ name: string; value: unknown }> | undefined;
  if (!privateFields || privateFields.length === 0) return;
  for (const field of privateFields) {
    const child = transform(value, field.name, field.value, ctx);
    ctx.module.push(`${name}[${JSONStringify(mangledPrivateName(field.name))}] = ${emitValue(child, ctx)};`);
  }
}

// Returns the expression that creates a fresh object with `value`'s prototype.
// Plain objects use `{}`; null-prototype objects use `Object.create(null)`; a
// class instance is recreated via `Object.create(<Class>.prototype)` so its
// methods, prototype chain, and `instanceof` survive (its own public fields are
// then assigned by the caller). NOTE: `#private` fields are invisible to
// reflection and are not captured, and the constructor is not re-run.
// A prototype's OWN `constructor` (a class/function whose `.prototype` is this object), or
// undefined. Reads the own property only — `proto.constructor` for a plain `Object.create` chain
// object is INHERITED from Object.prototype, so a bare `.constructor` access walks the whole chain
// (O(depth)); doing that per object made deep prototype chains O(N²). A class prototype always has
// its constructor as an OWN (non-enumerable) property, so this finds it in O(1) with no walk.
function ownConstructor(proto: object): Function | undefined {
  const d = ObjectGetOwnPropertyDescriptor(proto, "constructor");
  const c = d?.value;
  return typeof c === "function" && (c as Function).prototype === proto ? (c as Function) : undefined;
}

function objectBaseExpression(value: object, ctx: Context): string {
  const proto = ObjectGetPrototypeOf(value);
  if (proto === Object.prototype) return "{}";
  if (proto === null) return "Object.create(null)";

  const ctor = ownConstructor(proto);
  if (ctor !== undefined) {
    return `Object.create(${emitValue(ctor, ctx)}.prototype)`;
  }
  return `Object.create(${emitValue(proto, ctx)})`;
}

// Emits each own property of `value` onto the hoisted `name`, preserving
// accessor (get/set) properties, non-enumerable/non-writable flags, and
// symbol keys. Plain enumerable writable data properties use a simple
// assignment; everything else uses ObjectDefineProperty.
function emitOwnProperties(
  name: string,
  value: object,
  ctx: Context,
  skip?: Set<PropertyKey>,
  enumerableOnly = false,
): void {
  // Access-path pruning: when the closure only reads a known subset of this
  // object's string keys (and never uses it opaquely), `keepSets` holds exactly
  // those keys; emit only them. Symbol keys are never pruned (not statically
  // analyzable). "all" / absent means emit everything.
  const keep = ctx.keepSets.get(value);
  // For an inherited-accessor check (below): only a CUSTOM prototype can hold a same-key
  // accessor that a plain `obj[key] = v` would trip. Object.prototype's only accessor is
  // `__proto__` (handled separately), and a null prototype has none — so skip the per-key
  // prototype walk for those common cases (it's a measurable cost on large graphs).
  const accessorProto = (() => {
    const p = ObjectGetPrototypeOf(value);
    return p !== null && p !== Object.prototype ? p : null;
  })();
  for (const key of ReflectOwnKeys(value)) {
    if (skip !== undefined && skip.has(key)) {
      continue;
    }
    if (enumerableOnly && !ObjectGetOwnPropertyDescriptor(value, key)!.enumerable) {
      continue;
    }
    if (keep !== undefined && keep !== "all" && typeof key === "string" && !keep.has(key)) {
      continue;
    }
    const keyExpr = propertyKeyExpression(key, ctx);
    const descriptor = ObjectGetOwnPropertyDescriptor(value, key)!;

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
    // A REPLACER that turns a defined value into undefined omits the property (JSON-like) — for
    // every key kind (string OR symbol, enumerable OR not), not just enumerable string keys.
    // A genuinely-undefined own value is kept (faithful: `{a: undefined}` keeps `a`), so this
    // only fires when the replacer changed it (descriptor.value was not already undefined).
    if (child === undefined && descriptor.value !== undefined) {
      // On the genuine-instance path the reify factory runs the real constructor, so a
      // field-initialized property already exists on `name`; `delete` drops it for real. On the
      // plain-object path the property was never assigned, so the delete is a harmless no-op.
      // A non-configurable property can't be deleted (and `delete` would throw in the module's
      // strict mode), so just skip emitting it — best effort for that rare case.
      if (descriptor.configurable) ctx.module.push(`delete ${name}[${keyExpr}];`);
      continue;
    }

    // A plain `name[key] = v` assignment walks the prototype chain: if an ACCESSOR with the
    // same key lives there, the assignment fires its setter (or throws for a getter-only
    // accessor) instead of creating an own data property. `name["__proto__"] = v` similarly
    // hits the Object.prototype `__proto__` setter. In both cases route through
    // ObjectDefineProperty (which always defines an own property and never invokes a setter).
    const inherited =
      accessorProto !== null && typeof key === "string" ? lookupDescriptor(accessorProto, key) : undefined;
    const inheritedAccessor = inherited !== undefined && (inherited.get !== undefined || inherited.set !== undefined);
    if (
      typeof key === "string" &&
      key !== "__proto__" &&
      !inheritedAccessor &&
      descriptor.enumerable &&
      descriptor.writable &&
      descriptor.configurable
    ) {
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

// Registered (`Symbol.for`) and well-known symbols have a stable global identity
// and reconstruct directly. A unique `Symbol(desc)` has no reproducible global
// identity, but for a self-contained closure all that matters is that it stays
// unique and that the SAME captured symbol maps to one reconstructed symbol — so
// hoist `const sym = Symbol(desc)` once and reference it (identity preserved
// within the closure).
function emitSymbol(value: symbol, ctx: Context): string {
  const stable = stableSymbolExpression(value);
  if (stable !== undefined) return stable;
  return uniqueSymbolRef(value, ctx);
}

function stableSymbolExpression(value: symbol): string | undefined {
  const registered = Symbol.keyFor(value);
  if (registered !== undefined) return `Symbol.for(${JSONStringify(registered)})`;
  for (const entry of WELL_KNOWN_SYMBOLS) {
    if (entry[0] === value) return entry[1];
  }
  return undefined;
}

function uniqueSymbolRef(value: symbol, ctx: Context): string {
  const existing = ctx.symbols.get(value);
  if (existing !== undefined) return existing;
  const name = REF_PREFIX + ctx.counter++;
  ctx.symbols.set(value, name);
  const desc = value.description;
  ctx.module.push(`const ${name} = Symbol(${desc === undefined ? "" : JSONStringify(desc)});`);
  return name;
}

function propertyKeyExpression(key: string | symbol, ctx: Context): string {
  if (typeof key === "string") return JSONStringify(key);
  const stable = stableSymbolExpression(key);
  if (stable !== undefined) return stable;
  return uniqueSymbolRef(key, ctx);
}

// Base methods captured at module load (tamper-proof) that throw on a receiver lacking the
// built-in's internal slot — used to tell a real instance from a prototype-based look-alike
// (`Object.create(Date.prototype)`) for the types with no `$is*` intrinsic.
const slotProbeDate = DateCtor.prototype.getTime;
const slotProbeNumber = NumberCtor.prototype.valueOf;
const slotProbeString = StringCtor.prototype.valueOf;
const slotProbeBoolean = BooleanCtor.prototype.valueOf;
const slotProbeWeakRef = WeakRefCtor.prototype.deref;
const slotProbeWeakMapHas = WeakMapCtor.prototype.has;
const slotProbeWeakSetHas = WeakSetCtor.prototype.has;
const slotProbeMapHas = MapCtor.prototype.has;
const slotProbeSetHas = SetCtor.prototype.has;
const slotProbeArrayBuffer = ObjectGetOwnPropertyDescriptor(ArrayBufferCtor.prototype, "byteLength")!.get!;
// SharedArrayBuffer has its own [[SharedArrayBufferData]] slot; the ArrayBuffer byteLength getter
// throws on it, so it needs its own probe. (May be absent if SharedArrayBuffer is unavailable.)
const slotProbeSharedArrayBuffer =
  typeof SharedArrayBuffer !== "undefined"
    ? ObjectGetOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get
    : undefined;
// The RegExp `source` getter returns "(?:)" for RegExp.prototype itself and throws for any other
// non-RegExp receiver — a side-effect-free slot check (there's no $isRegExpObject intrinsic here).
const slotProbeRegExp = ObjectGetOwnPropertyDescriptor(RegExpCtor.prototype, "source")!.get!;
function hasSlot(value: object, probe: Function): boolean {
  try {
    probe.$call(value);
    return true;
  } catch {
    return false;
  }
}

// Host/Web builtins backed by a C++ internal slot. Like the ECMAScript builtins above they CANNOT
// be reconstructed by the generic `Object.create(proto)` path — that copies no slot, yielding a
// shell whose every method/getter throws "can only be used on instances of …". They are instead
// rebuilt from serializable state, or rejected with a clear error when their state isn't
// synchronously expressible as source. Globals + their extractor methods/getters are snapshotted at
// load (tamper-proof, mirroring `DateProtoGetTime`); a builtin absent in this realm stays undefined
// and is simply not handled (the value falls through to the generic path).
const URLCtor = typeof URL !== "undefined" ? URL : undefined;
const URLHrefGetter = URLCtor ? ObjectGetOwnPropertyDescriptor(URLCtor.prototype, "href")?.get : undefined;
const URLSearchParamsCtor = typeof URLSearchParams !== "undefined" ? URLSearchParams : undefined;
const URLSearchParamsToString = URLSearchParamsCtor ? URLSearchParamsCtor.prototype.toString : undefined;
const HeadersCtor = typeof Headers !== "undefined" ? Headers : undefined;
const HeadersEntries = HeadersCtor ? HeadersCtor.prototype.entries : undefined;
const TextEncoderCtor = typeof TextEncoder !== "undefined" ? TextEncoder : undefined;
const TextEncoderEncodingGetter = TextEncoderCtor
  ? ObjectGetOwnPropertyDescriptor(TextEncoderCtor.prototype, "encoding")?.get
  : undefined;
const TextDecoderCtor = typeof TextDecoder !== "undefined" ? TextDecoder : undefined;
const tdDesc = (k: string) =>
  TextDecoderCtor ? ObjectGetOwnPropertyDescriptor(TextDecoderCtor.prototype, k)?.get : undefined;
const TextDecoderEncodingGetter = tdDesc("encoding");
const TextDecoderFatalGetter = tdDesc("fatal");
const TextDecoderIgnoreBOMGetter = tdDesc("ignoreBOM");
// Host builtins whose state is NOT synchronously expressible as source (a body stream, async
// binary data, live signal state) — detected by a slot-checking getter so only a GENUINE instance
// is rejected (a `Object.create(Ctor.prototype)` look-alike with no slot falls through to the
// generic object path). `[ctor, label, slotProbeGetter, reason]`.
const hostGetter = (ctor: any, key: string): Function | undefined =>
  ctor ? ObjectGetOwnPropertyDescriptor(ctor.prototype, key)?.get : undefined;
const HOST_UNSERIALIZABLE: Array<[unknown, string, Function | undefined, string]> = [
  [
    typeof Request !== "undefined" ? Request : undefined,
    "Request",
    hostGetter(typeof Request !== "undefined" ? Request : undefined, "url"),
    "its body stream and request state are not expressible as source",
  ],
  [
    typeof Response !== "undefined" ? Response : undefined,
    "Response",
    hostGetter(typeof Response !== "undefined" ? Response : undefined, "status"),
    "its body stream and response state are not expressible as source",
  ],
  [
    typeof Blob !== "undefined" ? Blob : undefined,
    "Blob",
    hostGetter(typeof Blob !== "undefined" ? Blob : undefined, "size"),
    "its binary data is only readable asynchronously",
  ],
  [
    typeof AbortController !== "undefined" ? AbortController : undefined,
    "AbortController",
    hostGetter(typeof AbortController !== "undefined" ? AbortController : undefined, "signal"),
    "its live signal state is not expressible as source",
  ],
];

// The `.prototype` objects of every built-in `emitBuiltin` tests via `instanceof` (plus the
// typed-array / DataView prototypes its `ArrayBufferIsView` branch covers). An object can only
// match one of those `instanceof` checks if one of these prototypes is in its chain. Captured at
// load (tamper-proof); built-ins absent in this realm are simply not added.
const BUILTIN_PROTOTYPES: Set<object> = (() => {
  const set = new SetCtor<object>();
  const add = (p: unknown): void => {
    if (p !== null && typeof p === "object") set.add(p as object);
  };
  add(DateCtor.prototype);
  add(RegExpCtor.prototype);
  // Error.prototype is the base of every error subclass, so this one entry covers the
  // `instanceof Error` route in emitObjectBody (which the memoized guard short-circuits).
  add(Error.prototype);
  add(MapCtor.prototype);
  add(SetCtor.prototype);
  add(NumberCtor.prototype);
  add(StringCtor.prototype);
  add(BooleanCtor.prototype);
  add(WeakRefCtor.prototype);
  add(WeakMapCtor.prototype);
  add(WeakSetCtor.prototype);
  add(ArrayBufferCtor.prototype);
  if (SharedArrayBufferCtor !== undefined) add(SharedArrayBufferCtor.prototype);
  if (typeof FinalizationRegistry !== "undefined") add(FinalizationRegistry.prototype);
  if (typeof DataView !== "undefined") add(DataView.prototype);
  // Host/Web builtins (reconstructed or clearly rejected by emitBuiltin) — registered so the gate
  // routes their instances into emitBuiltin instead of the broken generic Object.create path.
  if (URLCtor !== undefined) add(URLCtor.prototype);
  if (URLSearchParamsCtor !== undefined) add(URLSearchParamsCtor.prototype);
  if (HeadersCtor !== undefined) add(HeadersCtor.prototype);
  if (TextEncoderCtor !== undefined) add(TextEncoderCtor.prototype);
  if (TextDecoderCtor !== undefined) add(TextDecoderCtor.prototype);
  for (const [ctor] of HOST_UNSERIALIZABLE) if (ctor !== undefined) add((ctor as { prototype: object }).prototype);
  // `%TypedArray%.prototype` — the shared base of every typed-array kind (Uint8Array, Float64Array,
  // …). A typed array's chain is `instance → Uint8Array.prototype → %TypedArray%.prototype → …`, so
  // this one entry covers them all (ArrayBufferIsView's targets).
  add(ObjectGetPrototypeOf(Uint8ArrayCtor.prototype));
  return set;
})();

// True iff one of the `BUILTIN_PROTOTYPES` lies in `value`'s prototype chain — i.e. `value` could
// match one of `emitBuiltin`'s `instanceof` / `ArrayBufferIsView` checks. Memoized per prototype
// object: the answer for an object depends only on its prototype chain, and every object sharing a
// prototype shares the answer. Without the memo, `emitBuiltin` walks the full chain (~14 `instanceof`
// checks) for EVERY object, so a depth-N `Object.create` / `class extends` chain costs O(N²); the
// memo amortizes each prototype to O(1) (it recurses on the parent's cached answer), making the
// whole chain O(N). The cache is keyed on the live prototype object via a WeakMap, so it can never
// go stale across serialize() calls (a given proto object always yields the same answer) and is
// reclaimed with its prototypes.
const builtinChainCache = new WeakMapCtor<object, boolean>();
function chainHasBuiltinPrototype(value: object): boolean {
  let proto = ObjectGetPrototypeOf(value);
  if (proto === null) return false;
  const cached = builtinChainCache.get(proto);
  if (cached !== undefined) return cached;
  // Walk up, collecting prototypes whose answer isn't cached yet, until a cached/known result or
  // the chain's end. Then fill every visited prototype's answer in one pass (iterative — a deep
  // chain must not recurse on the JS stack).
  const pending: object[] = [];
  let result = false;
  while (proto !== null) {
    if (BUILTIN_PROTOTYPES.has(proto)) {
      result = true;
      break;
    }
    const seen = builtinChainCache.get(proto);
    if (seen !== undefined) {
      result = seen;
      break;
    }
    pending.push(proto);
    proto = ObjectGetPrototypeOf(proto);
  }
  for (let i = 0; i < pending.length; i++) builtinChainCache.set(pending[i], result);
  return result;
}

// Reconstructs common built-in object types. Appends the construction to
// ctx.module under `name` and returns the built-in's NATURAL prototype (so the
// caller can detect and restore a subclass instance); returns null for plain
// objects/arrays, which the caller handles.
// Emits a builtin's `const name = new X(...)` declaration SYNCHRONOUSLY and returns its natural
// prototype plus a thunk that emits the deep content (Map/Set/Weak entries, own props) — or null
// if `value` isn't a recognized builtin. The content is deferred via emitObject so a deep
// container chain serializes without overflowing.
function emitBuiltin(value: object, name: string, ctx: Context): { proto: object; body: () => void } | null {
  // Built-ins are routed by INTERNAL SLOT, not `instanceof` — a plain object whose prototype is
  // a built-in's `.prototype` (`Object.create(Map.prototype)`, a prototype-based "Map-like") is
  // `instanceof Map` but has no [[MapData]] slot. Routing it into the Map branch would crash with
  // a raw "Map operation called on non-Map object"; instead it falls through here to the plain
  // object path (emitted with that exotic prototype). $-intrinsics check the slot directly (also
  // spoof-proof against a forged `Symbol.hasInstance`); types without an intrinsic ($isDate etc.
  // don't exist) use `instanceof` plus a slot probe (a base method that throws on a non-instance).
  // A settled promise reconstructs from its result: Promise.resolve(value) /
  // Promise.reject(reason). Rejected promises are pre-handled (`.catch(...)`) so
  // module load doesn't raise an unhandled-rejection — the reason is still
  // delivered to anyone who awaits/catches `name`. (Pending promises already
  // threw in emitObject.)
  if ($isPromise(value)) {
    const status = $peekPromiseStatus(value);
    const settled = $peekPromiseSettledValue(value);
    if (status === 2) {
      ctx.module.push(`const ${name} = Promise.reject(${emitValue(settled, ctx)});`);
      ctx.module.push(`${name}.catch(() => {});`);
    } else {
      ctx.module.push(`const ${name} = Promise.resolve(${emitValue(settled, ctx)});`);
    }
    return { proto: PromiseCtor.prototype, body: NOOP_BODY };
  }
  // Fast path: none of the `instanceof` / `ArrayBufferIsView` checks below can match unless a
  // built-in's `.prototype` is in `value`'s chain. The memoized check is O(1) amortized, so a deep
  // `Object.create` / `class extends` chain doesn't pay an O(depth) `instanceof` walk per object
  // (which made serialization O(depth²)). Promise is slot-based ($isPromise, above) and unaffected.
  if (!chainHasBuiltinPrototype(value)) return null;
  if (value instanceof DateCtor && hasSlot(value, slotProbeDate)) {
    ctx.module.push(`const ${name} = new Date(${DateProtoGetTime.$call(value as Date)});`);
    return {
      proto: DateCtor.prototype,
      // Extra own properties (`d.label = ...`) are only otherwise restored on the subclass
      // path; emit them here for a plain Date too. (A subclass's own props go through
      // restoreSubclass instead, so only do this when the prototype is the natural one.)
      body: () => {
        if (ObjectGetPrototypeOf(value) === DateCtor.prototype) emitOwnProperties(name, value, ctx);
      },
    };
  }
  if (value instanceof RegExpCtor && hasSlot(value, slotProbeRegExp)) {
    const re = value as RegExp;
    const reSource = RegExpSourceGetter.$call(re) as string;
    const reFlags = RegExpFlagsGetter.$call(re) as string;
    ctx.module.push(`const ${name} = new RegExp(${JSONStringify(reSource)}, ${JSONStringify(reFlags)});`);
    // lastIndex is the iteration cursor of a global/sticky regex — stateful, must be restored.
    if (re.lastIndex !== 0) ctx.module.push(`${name}.lastIndex = ${re.lastIndex};`);
    return {
      proto: RegExpCtor.prototype,
      // Extra own props (`re.custom = ...`) — same rationale as Date; skip the lastIndex own
      // slot (already set above, and it's non-configurable so defineProperty would fail).
      body: () => {
        if (ObjectGetPrototypeOf(value) === RegExpCtor.prototype) emitOwnProperties(name, value, ctx, REGEXP_SKIP_KEYS);
      },
    };
  }
  // Read the live entries AND restore them through the base prototype methods, never the
  // instance's own (possibly user-overridden) Symbol.iterator / set / add — an override
  // would let the walk observe forged entries or re-run a transform on restore (and a
  // throwing override would escape serialize() raw). Mirrors restoreBuiltinContent.
  if (value instanceof MapCtor && hasSlot(value, slotProbeMapHas)) {
    ctx.module.push(`const ${name} = new Map();`);
    return {
      proto: MapCtor.prototype,
      body: () => {
        let i = 0;
        mapEachEntry(value, (key, val) => {
          const k = emitValue(key, ctx);
          const v = emitValue(transform(value, mapReplacerKey(key, i), val, ctx), ctx);
          ctx.module.push(`Map.prototype.set.call(${name}, ${k}, ${v});`);
          i++;
        });
        // A plain Map can also carry extra own properties (`m.meta = ...`); a subclass's go
        // through restoreSubclass, so only emit them here when the prototype is the natural one.
        if (ObjectGetPrototypeOf(value) === MapCtor.prototype) emitOwnProperties(name, value, ctx);
      },
    };
  }
  if (value instanceof SetCtor && hasSlot(value, slotProbeSetHas)) {
    ctx.module.push(`const ${name} = new Set();`);
    return {
      proto: SetCtor.prototype,
      body: () => {
        let i = 0;
        setEachValue(value, element => {
          ctx.module.push(
            `Set.prototype.add.call(${name}, ${emitValue(transform(value, String(i), element, ctx), ctx)});`,
          );
          i++;
        });
        if (ObjectGetPrototypeOf(value) === SetCtor.prototype) emitOwnProperties(name, value, ctx);
      },
    };
  }
  // ArrayBuffer-backed: emit the underlying buffer through the normal value path
  // (so multiple views over one buffer share it by identity) then build the view
  // over it, preserving byteOffset/length. DataView and every typed-array kind go
  // through here. (Subclassing these is not supported — return the live prototype
  // so no subclass-restore is attempted.)
  if (ArrayBufferIsView(value)) {
    const view = value as ArrayBufferView & { length?: number; constructor: { name: string } };
    const bufferExpr = emitValue(view.buffer, ctx);
    const buf = view.buffer as ArrayBufferLike & { resizable?: boolean; growable?: boolean };
    // A length-tracking view (constructed without an explicit length over a resizable
    // buffer) auto-tracks the buffer's size; reconstructing it WITH an explicit length
    // would pin it so it no longer tracks. There's no public flag distinguishing the two,
    // so treat a view that currently spans to the end of a resizable buffer as
    // length-tracking and omit the length argument.
    const tracking =
      (buf.resizable === true || buf.growable === true) && view.byteOffset + view.byteLength === buf.byteLength;
    if (value instanceof DataView) {
      ctx.module.push(
        tracking
          ? `const ${name} = new DataView(${bufferExpr}, ${view.byteOffset});`
          : `const ${name} = new DataView(${bufferExpr}, ${view.byteOffset}, ${view.byteLength});`,
      );
    } else {
      ctx.module.push(
        tracking
          ? `const ${name} = new ${view.constructor.name}(${bufferExpr}, ${view.byteOffset});`
          : `const ${name} = new ${view.constructor.name}(${bufferExpr}, ${view.byteOffset}, ${view.length});`,
      );
    }
    return {
      proto: ObjectGetPrototypeOf(value),
      // Typed arrays / DataView aren't subclass-restored (the live prototype is returned), so
      // emit any extra own properties here. Skip a typed array's integer-index elements (already
      // materialized via the shared buffer); a DataView has none.
      body: () => {
        let skip: Set<string> | undefined;
        if (!(value instanceof DataView)) {
          skip = new SetCtor<string>();
          const len = (value as ArrayBufferView & { length: number }).length;
          for (let i = 0; i < len; i++) skip.add(String(i));
        }
        emitOwnProperties(name, value, ctx, skip);
      },
    };
  }
  if (
    (value instanceof ArrayBufferCtor && hasSlot(value, slotProbeArrayBuffer)) ||
    (SharedArrayBufferCtor !== undefined &&
      value instanceof SharedArrayBufferCtor &&
      slotProbeSharedArrayBuffer !== undefined &&
      hasSlot(value, slotProbeSharedArrayBuffer))
  ) {
    const ctor = value instanceof ArrayBufferCtor ? "ArrayBuffer" : "SharedArrayBuffer";
    const bytes = [...new Uint8ArrayCtor(value as ArrayBufferLike)];
    // A resizable/growable buffer needs its maxByteLength forwarded, or the reconstructed
    // buffer is fixed-size and .resize()/.grow() (and any length-tracking view) break.
    const ab = value as ArrayBufferLike & { resizable?: boolean; growable?: boolean; maxByteLength?: number };
    const resizeOpts = ab.resizable === true || ab.growable === true ? `, { maxByteLength: ${ab.maxByteLength} }` : "";
    ctx.module.push(`const ${name} = new ${ctor}(${(value as ArrayBufferLike).byteLength}${resizeOpts});`);
    if (bytes.some(b => b !== 0)) ctx.module.push(`new Uint8Array(${name}).set([${bytes.join(", ")}]);`);
    // Not subclass-restored (live prototype returned) — emit extra own props here.
    return { proto: ObjectGetPrototypeOf(value), body: () => emitOwnProperties(name, value, ctx) };
  }
  // Boxed primitives (new Number/String/Boolean) — objects wrapping a primitive. Extra own props
  // are restored here for the natural-prototype case (a subclass goes through restoreSubclass).
  if (value instanceof NumberCtor && hasSlot(value, slotProbeNumber)) {
    ctx.module.push(`const ${name} = new Number(${serializeNumber(NumberProtoValueOf.$call(value) as number)});`);
    return { proto: NumberCtor.prototype, body: () => emitBuiltinOwnProps(name, value, ctx, NumberCtor.prototype) };
  }
  if (value instanceof StringCtor && hasSlot(value, slotProbeString)) {
    ctx.module.push(`const ${name} = new String(${JSONStringify(StringProtoValueOf.$call(value) as string)});`);
    return {
      proto: StringCtor.prototype,
      body: () => {
        if (ObjectGetPrototypeOf(value) !== StringCtor.prototype) return;
        // A boxed String's own keys are its index chars + `length` (all intrinsic) — skip them.
        const skip = new SetCtor<string>(["length"]);
        const len = (value as String).length;
        for (let i = 0; i < len; i++) skip.add(String(i));
        emitOwnProperties(name, value, ctx, skip);
      },
    };
  }
  if (value instanceof BooleanCtor && hasSlot(value, slotProbeBoolean)) {
    ctx.module.push(`const ${name} = new Boolean(${BooleanProtoValueOf.$call(value) as boolean});`);
    return { proto: BooleanCtor.prototype, body: () => emitBuiltinOwnProps(name, value, ctx, BooleanCtor.prototype) };
  }
  // A WeakRef snapshots its live referent. If already collected at serialize
  // time, emit a WeakRef to a fresh (immediately collectable) object — best
  // effort, since "already collected" can't be reproduced.
  if (value instanceof WeakRefCtor && hasSlot(value, slotProbeWeakRef)) {
    const target = (value as WeakRef<any>).deref();
    ctx.module.push(`const ${name} = new WeakRef(${target === undefined ? "{}" : emitValue(target, ctx)});`);
    return { proto: WeakRefCtor.prototype, body: () => emitBuiltinOwnProps(name, value, ctx, WeakRefCtor.prototype) };
  }
  // WeakMap / WeakSet entries aren't JS-enumerable, but their live entries can be
  // snapshotted natively. Reconstruct as a fresh weak collection with those
  // entries (keys keep their identity with other captures). Snapshot semantics:
  // the keys alive at serialize time.
  if (value instanceof WeakMapCtor && hasSlot(value, slotProbeWeakMapHas)) {
    ctx.module.push(`const ${name} = new WeakMap();`);
    return {
      proto: WeakMapCtor.prototype,
      body: () => {
        const snap = $weakCollectionSnapshot(value); // [k, v, k, v, ...]
        for (let i = 0; i + 1 < snap.length; i += 2) {
          ctx.module.push(`${name}.set(${emitValue(snap[i], ctx)}, ${emitValue(snap[i + 1], ctx)});`);
        }
        emitBuiltinOwnProps(name, value, ctx, WeakMapCtor.prototype);
      },
    };
  }
  if (value instanceof WeakSetCtor && hasSlot(value, slotProbeWeakSetHas)) {
    ctx.module.push(`const ${name} = new WeakSet();`);
    return {
      proto: WeakSetCtor.prototype,
      body: () => {
        const snap = $weakCollectionSnapshot(value); // [k, k, ...]
        for (const element of snap) ctx.module.push(`${name}.add(${emitValue(element, ctx)});`);
        emitBuiltinOwnProps(name, value, ctx, WeakSetCtor.prototype);
      },
    };
  }
  // FinalizationRegistry: its registrations aren't JS-enumerable, but a native
  // snapshot exposes the callback + live { target, heldValue, unregisterToken }.
  // Reconstruct as a fresh registry with those registrations (snapshot of the
  // targets alive at serialize time).
  if (typeof FinalizationRegistry !== "undefined" && value instanceof FinalizationRegistry) {
    const snap = $finalizationRegistrySnapshot(value); // { callback, flat: [t, h, tok, ...] }
    if (snap === null) return null;
    ctx.module.push(`const ${name} = new FinalizationRegistry(${emitValue(snap.callback, ctx)});`);
    return {
      proto: FinalizationRegistry.prototype,
      body: () => {
        const flat = snap.flat;
        for (let i = 0; i + 2 < flat.length; i += 3) {
          const token = flat[i + 2];
          const tokenArg = token === undefined ? "" : `, ${emitValue(token, ctx)}`;
          ctx.module.push(`${name}.register(${emitValue(flat[i], ctx)}, ${emitValue(flat[i + 1], ctx)}${tokenArg});`);
        }
        emitBuiltinOwnProps(name, value, ctx, FinalizationRegistry.prototype);
      },
    };
  }
  // ── Host/Web builtins with an internal slot ──
  if (
    URLCtor !== undefined &&
    value instanceof URLCtor &&
    URLHrefGetter !== undefined &&
    hasSlot(value, URLHrefGetter)
  ) {
    ctx.module.push(`const ${name} = new URL(${JSONStringify(URLHrefGetter.$call(value) as string)});`);
    return { proto: URLCtor.prototype, body: () => emitBuiltinOwnProps(name, value, ctx, URLCtor.prototype) };
  }
  if (
    URLSearchParamsCtor !== undefined &&
    value instanceof URLSearchParamsCtor &&
    URLSearchParamsToString !== undefined &&
    hasSlot(value, URLSearchParamsToString)
  ) {
    ctx.module.push(
      `const ${name} = new URLSearchParams(${JSONStringify(URLSearchParamsToString.$call(value) as string)});`,
    );
    return {
      proto: URLSearchParamsCtor.prototype,
      body: () => emitBuiltinOwnProps(name, value, ctx, URLSearchParamsCtor.prototype),
    };
  }
  if (
    HeadersCtor !== undefined &&
    value instanceof HeadersCtor &&
    HeadersEntries !== undefined &&
    hasSlot(value, HeadersEntries)
  ) {
    // `.entries()` yields combined values (multi-valued headers joined by ", "); reconstructing
    // from those pairs preserves the observable `.get(name)` for every header. Read by index (no
    // destructuring off a user-mutable Array iterator).
    const pairs: string[] = [];
    for (const pair of HeadersEntries.$call(value) as Iterable<[string, string]>) {
      pairs.push(`[${JSONStringify(pair[0])}, ${JSONStringify(pair[1])}]`);
    }
    ctx.module.push(`const ${name} = new Headers([${pairs.join(", ")}]);`);
    return { proto: HeadersCtor.prototype, body: () => emitBuiltinOwnProps(name, value, ctx, HeadersCtor.prototype) };
  }
  if (
    TextEncoderCtor !== undefined &&
    value instanceof TextEncoderCtor &&
    TextEncoderEncodingGetter !== undefined &&
    hasSlot(value, TextEncoderEncodingGetter)
  ) {
    ctx.module.push(`const ${name} = new TextEncoder();`); // stateless (encoding is always utf-8)
    return {
      proto: TextEncoderCtor.prototype,
      body: () => emitBuiltinOwnProps(name, value, ctx, TextEncoderCtor.prototype),
    };
  }
  if (
    TextDecoderCtor !== undefined &&
    value instanceof TextDecoderCtor &&
    TextDecoderEncodingGetter !== undefined &&
    hasSlot(value, TextDecoderEncodingGetter)
  ) {
    const enc = TextDecoderEncodingGetter.$call(value) as string;
    const fatal = TextDecoderFatalGetter !== undefined ? !!TextDecoderFatalGetter.$call(value) : false;
    const ignoreBOM = TextDecoderIgnoreBOMGetter !== undefined ? !!TextDecoderIgnoreBOMGetter.$call(value) : false;
    ctx.module.push(
      `const ${name} = new TextDecoder(${JSONStringify(enc)}, { fatal: ${fatal}, ignoreBOM: ${ignoreBOM} });`,
    );
    return {
      proto: TextDecoderCtor.prototype,
      body: () => emitBuiltinOwnProps(name, value, ctx, TextDecoderCtor.prototype),
    };
  }
  // Host builtins whose state isn't synchronously expressible as source — reject clearly (a genuine
  // instance only, slot-checked) rather than emit a broken `Object.create(proto)` shell.
  for (const [ctor, label, probe, reason] of HOST_UNSERIALIZABLE) {
    if (ctor !== undefined && value instanceof (ctor as Function) && probe !== undefined && hasSlot(value, probe)) {
      throw new TypeError(`Cannot serialize a ${label} object (${reason}).`);
    }
  }
  return null;
}

// A shared no-op body for builtins with no deferred content (their declaration is complete).
const NOOP_BODY = (): void => {};

// Emits a builtin's extra own properties (`m.meta = ...`, symbol keys, non-enumerable props) —
// but only when its prototype is the natural one. A subclass instance has those restored by
// restoreSubclass instead, so emitting here too would double-emit.
function emitBuiltinOwnProps(name: string, value: object, ctx: Context, naturalProto: object): void {
  if (ObjectGetPrototypeOf(value) === naturalProto) emitOwnProperties(name, value, ctx);
}

// Known builtin Error constructors, in priority order (most specific first).
const ERROR_BASES = [
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "Error",
];

// The nearest builtin Error constructor name in `value`'s prototype chain, so a
// subclass instance is recreated from the right base (and its own prototype is
// restored separately).
function builtinErrorBase(value: object): string {
  for (let p: object | null = value; p; p = ObjectGetPrototypeOf(p)) {
    const ctor = (p as any).constructor;
    if (typeof ctor === "function" && ERROR_BASES.includes(ctor.name) && (globalThis as any)[ctor.name] === ctor) {
      return ctor.name;
    }
  }
  return "Error";
}

// Reconstructs an Error: create the right builtin base (with [[ErrorData]]),
// then restore every own property — `message`, `stack`, `cause` (incl. circular),
// an AggregateError's `errors`, and any custom fields (`code`, `status`, ...) —
// and, for a subclass, its prototype. `stack` is preserved as-is: it's a real own
// property (a user may have set it deliberately), and the original location is more
// faithful than the meaningless `new Error()` frame the reconstruction would produce.
// Emits the error's `const name = new Base(msg)` declaration synchronously and returns a thunk
// that restores its own properties and (for a subclass) its prototype.
function emitErrorBody(value: Error, name: string, ctx: Context): () => void {
  const base = builtinErrorBase(value);
  if (base === "AggregateError") {
    ctx.module.push(`const ${name} = new AggregateError([], ${JSONStringify(value.message)});`);
  } else {
    ctx.module.push(`const ${name} = new ${base}(${JSONStringify(value.message)});`);
  }
  return () => {
    emitOwnProperties(name, value, ctx);
    const proto = ObjectGetPrototypeOf(value);
    if (proto !== (globalThis as any)[base].prototype) {
      // Link to the reconstructed subclass's OWN `.prototype` (not a standalone rebuilt copy)
      // so `instanceof e.constructor` and shared prototype identity survive — same shape as
      // restoreSubclass / objectBaseExpression's class-instance case.
      const ctor = (proto as any)?.constructor;
      const protoExpr =
        typeof ctor === "function" && ctor.prototype === proto
          ? `${emitValue(ctor, ctx)}.prototype`
          : emitValue(proto, ctx);
      ctx.module.push(`Object.setPrototypeOf(${name}, ${protoExpr});`);
    }
  };
}

const REGEXP_SKIP_KEYS = new SetCtor(["lastIndex"]);

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
    // A revoked proxy has no target/handler left to capture, but every revoked
    // proxy is observationally identical (throws on every operation), so emit a
    // fresh one — behavior is preserved exactly.
    ctx.module.push(`const ${name} = (() => { const r = Proxy.revocable({}, {}); r.revoke(); return r.proxy; })();`);
    return name;
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

// The captured FUNCTIONS a function's reconstruction will emit inline (its free-var-function
// values + a class's superclass) — i.e. the edges along which function emission would otherwise
// recurse. Empty for the non-reconstruct paths (hosted/bound/native/genuine-method), which don't
// chain deeply. emitFunction emits these before the function, iteratively, so a deep capture
// chain doesn't overflow the stack.
function capturedFunctions(fn: Function, ctx: Context): Function[] {
  if (ctx.hostedArrows.has(fn)) return [];
  // A bound function's reconstruction (`target.bind(boundThis, ...boundArgs)`) emits each of
  // target/boundThis/boundArgs via emitValue. Its plain-function parts are the edges along which
  // emission would otherwise recurse — a deep chain of `base.bind(prev)` recurses through boundThis
  // N deep and overflows the stack. Report them as dependency edges so emitFunction's post-order
  // stack emits each before this bound function, and the bound branch's emitValue(...) resolves to
  // an already-emitted ref. (Non-function parts — and callable Proxies, which emitFunction can't
  // dispatch — keep their existing emitValue/emitObject path, which is already iterative.)
  const bound = (fn as any)[Symbol.boundFunction] as BoundDetails | undefined;
  if (bound !== undefined) {
    const deps: Function[] = [];
    const pushFn = (v: unknown): void => {
      if (typeof v === "function" && !$isProxyObject(v)) deps.push(v as Function);
    };
    pushFn(bound.target);
    pushFn(bound.boundThis);
    for (const arg of bound.boundArgs) pushFn(arg);
    return deps;
  }
  if (ctx.genuineMethods.has(fn)) return [];
  let source: string;
  try {
    source = funcSource(fn);
  } catch {
    return [];
  }
  if (isNativeFunctionSource(source)) return [];
  const out: Function[] = [];
  for (const v of allFreeVariables(fn, source)) {
    // An external import (node:*, a package) is re-emitted as an `import` statement by
    // reconstructFunctionExpr — never expand its (native) value as a dependency. Mirrors the
    // skip every other allFreeVariables consumer has.
    if (v.import?.external) continue;
    if (typeof v.value === "function") out.push(v.value as Function);
  }
  const superclass = ObjectGetPrototypeOf(fn);
  if (typeof superclass === "function" && superclass !== Function.prototype) out.push(superclass);
  return out;
}

// Emits a function as `const <name> = ...`. Its captured FUNCTION dependencies (the edges along
// which reconstruction recurses) are emitted FIRST, via an explicit post-order stack rather than
// recursion — so a chain of functions nested arbitrarily deep through their captures serializes
// without overflowing. A reference CYCLE among functions is hoisted to module scope beforehand,
// so this dependency graph is acyclic (the in-progress guard is a belt-and-braces backstop). A
// deep DATA graph under a function is already handled by emitObject's worklist.
function emitFunction(fn: Function, ctx: Context): string {
  // If a ref is already assigned, return it — even mid-emission. A self-reference / cycle (a
  // self-referencing static field, or a hosted arrow held in its own instance's private slot)
  // re-enters here while `fn`'s content is still being emitted; it must resolve to the ref, not
  // start a second emission. (emittedFns — used only for the post-order dedup below — would not
  // yet be set in that window.)
  const cached = ctx.refs.get(fn);
  if (cached !== undefined) return cached;

  const stack: Array<{ fn: Function; expanded: boolean }> = [{ fn, expanded: false }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const f = frame.fn;
    if (ctx.emittedFns.has(f)) {
      stack.pop();
      continue;
    }
    if (!frame.expanded) {
      frame.expanded = true;
      ctx.inProgressFns.add(f);
      if (!ctx.refs.has(f)) ctx.refs.set(f, REF_PREFIX + ctx.counter++);
      // Push captured-function dependencies so they're emitted (post-order) before `f`. Skip any
      // already emitted or already in-flight — a back-edge through an own property
      // (`F.helper = () => F`) re-enters here while F is mid-emission, and must resolve to F's ref
      // (the early-return above) rather than re-expand and double-declare it.
      for (const dep of capturedFunctions(f, ctx)) {
        if (!ctx.emittedFns.has(dep) && !ctx.inProgressFns.has(dep)) stack.push({ fn: dep, expanded: false });
      }
    } else {
      stack.pop();
      emitFunctionContent(f, ctx.refs.get(f)!, ctx);
      ctx.emittedFns.add(f);
      ctx.inProgressFns.delete(f);
    }
  }
  return ctx.refs.get(fn)!;
}

// Emits the body of one function (`name` already assigned). Its captured-function dependencies
// are already emitted (emitFunction's post-order), so inline emitValue calls for them resolve to
// refs without recursing.
function emitFunctionContent(fn: Function, name: string, ctx: Context): void {
  // An escaped arrow that reads a `#private` through its lexical `this` is reconstructed by
  // invoking its host method on the reified receiver instance: the host (injected into the
  // genuine class body) returns a fresh arrow whose `this` is that instance, so `this.#x`
  // reads the genuine slot.
  const hosted = ctx.hostedArrows.get(fn);
  if (hosted !== undefined) {
    const instanceExpr = emitValue(hosted.instance, ctx);
    const argExprs = hosted.args.map(a => emitValue(transform(undefined, a.name, a.value, ctx), ctx));
    ctx.module.push(`const ${name} = ${instanceExpr}.${hosted.hostKey}(${argExprs.join(", ")});`);
    return;
  }

  // Bound functions stringify as native code; reconstruct them from their
  // internals instead: target.bind(boundThis, ...boundArgs).
  const bound = (fn as any)[Symbol.boundFunction] as BoundDetails | undefined;
  if (bound !== undefined) {
    const targetExpr = emitValue(bound.target, ctx);
    const thisExpr = emitValue(bound.boundThis, ctx);
    const argExprs = bound.boundArgs.map(arg => emitValue(arg, ctx));
    const tail = argExprs.length ? `, ${argExprs.join(", ")}` : "";
    ctx.module.push(`const ${name} = ${targetExpr}.bind(${thisExpr}${tail});`);
    // A bound function can carry its own properties (`bf.extra = ...`); emit the enumerable
    // ones, like the from-source path does.
    emitOwnProperties(name, fn, ctx, undefined, true);
    return;
  }

  // A method peeled off a genuine class — extracted as a value, or a bound function's
  // target — is referenced through the reconstructed class prototype, so it reads the
  // genuine `#x` slot rather than a standalone mangled copy.
  const gm = ctx.genuineMethods.get(fn);
  if (gm !== undefined) {
    const classRef = emitValue(gm.classFn, ctx);
    const keyExpr = propertyKeyExpression(gm.key, ctx);
    if (gm.kind === "method") {
      ctx.module.push(`const ${name} = ${classRef}.prototype[${keyExpr}];`);
    } else {
      ctx.module.push(`const ${name} = Object.getOwnPropertyDescriptor(${classRef}.prototype, ${keyExpr}).${gm.kind};`);
    }
    return;
  }

  // A native built-in (Math.max, Array.prototype.slice, console.log, Error, ...)
  // has no JS source but a stable identity reachable from globalThis — reference
  // it by its path rather than trying to reconstruct it. This is what lets a
  // captured native function round-trip, and `class X extends Error` work.
  if (isNativeFunctionSource(funcSource(fn))) {
    const path = nativeFunctionPath(fn);
    if (path !== undefined) {
      ctx.module.push(`const ${name} = ${path};`);
      return;
    }
  }

  // Map this function's own `.prototype` object to `<name>.prototype` so a DIRECT capture of
  // it (e.g. `Class.prototype` held as a value) dedups to the reconstructed class's prototype
  // — the same object the class's instances are `Object.create`d from — instead of being
  // rebuilt as a fresh duplicate `{}`. (Native/bound/hosted/genuine-method functions returned
  // above; only normally-reconstructed functions reach here.)
  const ownProto = (fn as { prototype?: object }).prototype;
  if (typeof ownProto === "object" && ownProto !== null && !ctx.refs.has(ownProto)) {
    ctx.refs.set(ownProto, `${name}.prototype`);
  }

  const reconstructed = reconstructFunctionExpr(fn, ctx);
  // `const <name> = ` adds no newlines, so the source offset within the entry is
  // the offset within the expression.
  ctx.module.push(`const ${name} = ${reconstructed.expr};`);
  recordSourceBlock(ctx, ctx.module.length - 1, reconstructed);
  // A function's `.name` is non-enumerable, so emitOwnProperties skips it — but the live name
  // can differ from what the reconstructed source produces: overridden via defineProperty
  // (`name` was reassigned), or inferred from an assignment for an anonymous arrow/function
  // (`const f = () => {}` → `.name === "f"`, but the standalone reconstruction has no name).
  // When it differs from the source's declared id, restore it explicitly (matching the spec's
  // name descriptor: writable:false, enumerable:false, configurable:true).
  if (typeof fn.name === "string") {
    const declaredName = parseFunctionNode(reconstructed.source)?.id?.name;
    // A function with no source id produces `.name === ""`; compare against "" so an explicit
    // `name` override TO the empty string (differing from a non-empty source id) is also restored.
    if (fn.name !== (declaredName ?? "")) {
      ctx.module.push(
        `Object.defineProperty(${name}, "name", { value: ${JSONStringify(fn.name)}, writable: false, enumerable: false, configurable: true });`,
      );
    }
  }
  // `.length` is non-enumerable too, so emitOwnProperties skips it. The reconstructed source
  // reproduces the natural arity; a `defineProperty(fn,"length",{value:N})` override differs from
  // that and must be restored explicitly (same spec descriptor shape as `name`).
  if (typeof fn.length === "number") {
    const naturalLength = naturalArityFromSource(reconstructed.source);
    if (naturalLength !== undefined && fn.length !== naturalLength) {
      ctx.module.push(
        `Object.defineProperty(${name}, "length", { value: ${JSONStringify(fn.length)}, writable: false, enumerable: false, configurable: true });`,
      );
    }
  }
  // A genuine-private class needs a reify factory: set the module-level flag, construct a
  // BARE instance (the constructor's reify branch skips the original body), then clear the
  // flag. Privates are installed afterward by the patch method (see emitGenuinePrivateInstance)
  // so cycles work. A plain `new` of the class elsewhere still runs the original constructor.
  if (reconstructed.genuinePrivate !== undefined) {
    const factory = name + "_reify";
    ctx.module.push(
      `const ${factory} = () => { ${REIFY_SLOT} = true; try { return new ${name}(); } finally { ${REIFY_SLOT} = false; } };`,
    );
    ctx.classReify.set(fn, { factory, fields: reconstructed.genuinePrivate.fields });
  }
  // Functions/classes can carry runtime-added own properties (`fn.version = 2`, a class's
  // externally-assigned `C.instance = ...`, a non-enumerable hidden config). Emit ALL of them
  // (enumerable OR not, data/accessor/symbol-keyed) EXCEPT the keys the source already defines —
  // name/length/prototype and the static members (methods/fields the class expression recreates),
  // which would otherwise be duplicated or clobber a genuine-method reference.
  const memberKeys = sourceDefinedMemberKeys(reconstructed.source);
  // Override detection compares the LIVE members against the UN-mangled original source (#x intact).
  const classOriginal = funcSource(fn);
  // A source-declared STATIC method/accessor replaced at runtime is un-skipped so its override
  // re-emits over the inline original (same rationale as the instance case below).
  let staticSkip = memberKeys.staticKeys;
  const overriddenStatic = overriddenMemberKeys(fn, classOriginal, true);
  if (overriddenStatic.size > 0) {
    staticSkip = new SetCtor<PropertyKey>(staticSkip);
    for (const k of overriddenStatic) staticSkip.delete(k);
  }
  emitOwnProperties(name, fn, ctx, staticSkip, false);
  // Imperatively-assigned prototype members (`Ctor.prototype.method = ...`, the classic pre-ES6
  // pattern, or a monkey-patched class prototype) live on the `.prototype` object, not in the
  // function's source — emit its own properties (any enumerability) onto `<name>.prototype`,
  // skipping `constructor`, the instance members the class source already declares, and any
  // methods pruneClassMethods removed (those are deliberately gone — don't resurrect them). A
  // source-declared method REPLACED at runtime is un-skipped so its override re-emits over the
  // inline original (overriddenMemberKeys, detected against the un-mangled original source).
  if (typeof ownProto === "object" && ownProto !== null) {
    const pruned = ctx.prunedMethods.get(fn);
    const overridden = overriddenMemberKeys(fn, classOriginal, false);
    let skip = memberKeys.instanceKeys;
    if ((pruned !== undefined && pruned.size > 0) || overridden.size > 0) {
      skip = new SetCtor<PropertyKey>(skip);
      if (pruned !== undefined) for (const k of pruned) skip.add(k);
      // A pruned (unreachable) method stays gone even if also overridden; otherwise un-skip the
      // override so emitOwnProperties re-emits it.
      for (const k of overridden) if (pruned === undefined || !pruned.has(k)) skip.delete(k);
    }
    emitOwnProperties(`${name}.prototype`, ownProto, ctx, skip, false);
  }
  // A frozen/sealed/non-extensible class prototype or constructor is emitted via this function
  // path, never through emitObject, so its extensibility state would otherwise be lost. Apply
  // it LAST, after the prototype's own properties are wired (freeze rejects later mutation).
  if (typeof ownProto === "object" && ownProto !== null && !ObjectIsExtensible(ownProto)) {
    emitNonExtensible(`${name}.prototype`, ownProto, ctx);
  }
  if (!ObjectIsExtensible(fn)) {
    emitNonExtensible(name, fn, ctx);
  }
  return;
}

const PROTOTYPE_SKIP_KEYS = new SetCtor(["constructor"]);

// Emits the call that reproduces a value's non-extensible state (frozen > sealed >
// preventExtensions). Caller has already checked `!ObjectIsExtensible(value)`.
function emitNonExtensible(targetExpr: string, value: object, ctx: Context): void {
  if (ObjectIsFrozen(value)) ctx.module.push(`Object.freeze(${targetExpr});`);
  else if (ObjectIsSealed(value)) ctx.module.push(`Object.seal(${targetExpr});`);
  else ctx.module.push(`Object.preventExtensions(${targetExpr});`);
}

function recordSourceBlock(ctx: Context, moduleIndex: number, reconstructed: ReconstructedFunction): void {
  const location = reconstructed.location;
  if (location === undefined || !location.url) return;
  ctx.sourceBlocks.push({
    moduleIndex,
    lineOffset: reconstructed.sourceLineOffset,
    url: location.url,
    line: location.line,
    column: location.column,
    endLine: location.endLine,
    lineCount: reconstructed.sourceLineCount,
    source: reconstructed.source,
  });
}

// AsyncLocalStorage (a Proxy over native internals in Bun) reconstructs as a
// FRESH instance — getStore() is undefined until run()/enterWith(); the active
// store is ambient async-context state, not part of the closure.
function isAsyncLocalStorage(value: object): boolean {
  // Never touch a Proxy's properties here — that would fire its traps (observable
  // side effects) or throw on a revoked proxy. AsyncLocalStorage is not a Proxy.
  if ($isProxyObject(value)) return false;
  try {
    // Use the prototype's OWN constructor, not `value.constructor`: the latter is inherited, so for
    // a deep `Object.create` chain it walks the whole chain (O(depth)) on EVERY object emitValue
    // touches — an O(N²) trap. An ALS instance's direct prototype carries `AsyncLocalStorage` as its
    // own constructor (same instances the old `value.constructor.name` check matched).
    const proto = ObjectGetPrototypeOf(value);
    if (proto === null) return false;
    const ctor = ownConstructor(proto);
    if (ctor === undefined || ctor.name !== "AsyncLocalStorage") return false;
    return typeof (value as any).run === "function" && typeof (value as any).getStore === "function";
  } catch {
    return false;
  }
}
function emitAsyncLocalStorage(value: object, ctx: Context): string {
  const existing = ctx.refs.get(value);
  if (existing !== undefined) return existing;
  const name = REF_PREFIX + ctx.counter++;
  ctx.refs.set(value, name);
  // The source is built via JSONStringify so the builtin-module preprocessor
  // doesn't treat this template literal as a real import and strip it.
  ctx.imports.add(`import { AsyncLocalStorage } from ${JSONStringify("node:async_hooks")};`);
  ctx.module.push(`const ${name} = new AsyncLocalStorage();`);
  // Snapshot the store active in this ALS at serialize time (e.g. set by an
  // enclosing `als.run(store, () => serialize(fn))`). The root is wrapped to
  // re-enter this context so `als.getStore()` returns the same store on reify.
  let store: unknown;
  try {
    store = (value as any).getStore();
  } catch {
    store = undefined;
  }
  if (store !== undefined) ctx.alsContexts.push({ name, storeExpr: emitValue(store, ctx) });
  return name;
}

// Reverse map from a native built-in function to its canonical globalThis path
// (e.g. Math.max -> "Math.max", Array.prototype.slice -> "Array.prototype.slice")
// so captured native functions can be referenced instead of (impossibly)
// serialized. Built once, lazily, on first native capture.
let nativePathMap: Map<Function, string> | undefined;
function nativeFunctionPath(fn: Function): string | undefined {
  if (nativePathMap === undefined) nativePathMap = buildNativePathMap();
  return nativePathMap.get(fn);
}
function buildNativePathMap(): Map<Function, string> {
  const map = new MapCtor<Function, string>();
  const g = globalThis as any;
  const record = (f: unknown, path: string): void => {
    if (typeof f === "function" && !map.has(f)) map.set(f, path);
  };
  // Record the own function-valued properties of `obj` as `<base>.<key>` (data
  // properties only — accessors may throw or be context-sensitive).
  const walkMembers = (obj: any, base: string): void => {
    let keys: string[];
    try {
      keys = ObjectGetOwnPropertyNames(obj);
    } catch {
      return;
    }
    for (const key of keys) {
      if (key === "caller" || key === "arguments" || key === "callee") continue;
      let d: PropertyDescriptor | undefined;
      try {
        d = ObjectGetOwnPropertyDescriptor(obj, key);
      } catch {
        continue;
      }
      if (d !== undefined && typeof d.value === "function") record(d.value, `${base}.${key}`);
    }
  };
  for (const name of ObjectGetOwnPropertyNames(g)) {
    if (name === "globalThis" || name === "global" || name === "window" || name === "self") continue;
    let v: any;
    try {
      v = g[name];
    } catch {
      continue;
    }
    if (typeof v === "function") {
      record(v, name); // the constructor / global function itself
      walkMembers(v, name); // static methods (ObjectKeys, ArrayFrom, ...)
      if (v.prototype) walkMembers(v.prototype, `${name}.prototype`); // instance methods
    } else if (typeof v === "object" && v !== null) {
      walkMembers(v, name); // namespace methods (Math.max, JSONParse, console.log, ...)
    }
  }
  return map;
}

// Well-known global namespace objects / singletons that are HOST or INTRINSIC state (never user
// data), reachable by a stable global path. A captured value identical to one of these is emitted
// as a reference to its path rather than walked. NOT an open walk of globalThis's own properties —
// that would wrongly reference a user's own global object (`globalThis.myConfig`) instead of
// serializing it by value.
const NATIVE_OBJECT_PATHS = [
  // Host / intrinsic singletons (some absent depending on platform — each guarded by the
  // try/catch + typeof check in buildNativeObjectMap).
  "Math",
  "JSON",
  "Reflect",
  "Atomics",
  "Intl",
  "console",
  "process",
  "Bun",
  "WebAssembly",
  "crypto",
  "performance",
  "navigator",
  // The `.prototype` of every standard built-in constructor. These are HOST/INTRINSIC objects
  // shared across the realm — deep-copying them breaks identity (`x === Promise.prototype`), leaks
  // internal-slot keys, and (for prototypes carrying native methods) throws "Cannot serialize a
  // native function" when the walk reaches a method. Reference them by path instead.
  "Object.prototype",
  "Array.prototype",
  "Function.prototype",
  "Promise.prototype",
  "Error.prototype",
  "EvalError.prototype",
  "RangeError.prototype",
  "ReferenceError.prototype",
  "SyntaxError.prototype",
  "TypeError.prototype",
  "URIError.prototype",
  "AggregateError.prototype",
  "Number.prototype",
  "String.prototype",
  "Boolean.prototype",
  "Symbol.prototype",
  "BigInt.prototype",
  "Map.prototype",
  "Set.prototype",
  "WeakMap.prototype",
  "WeakSet.prototype",
  "WeakRef.prototype",
  "Date.prototype",
  "RegExp.prototype",
  "ArrayBuffer.prototype",
  "SharedArrayBuffer.prototype",
  "DataView.prototype",
  "Int8Array.prototype",
  "Uint8Array.prototype",
  "Uint8ClampedArray.prototype",
  "Int16Array.prototype",
  "Uint16Array.prototype",
  "Int32Array.prototype",
  "Uint32Array.prototype",
  "Float32Array.prototype",
  "Float64Array.prototype",
  "BigInt64Array.prototype",
  "BigUint64Array.prototype",
  // The shared %TypedArray%.prototype — the abstract base of every typed-array prototype. Not
  // reachable by a plain dotted path; resolved specially in buildNativeObjectMap. Its re-resolving
  // expression in the reconstructed module is `Object.getPrototypeOf(Uint8Array.prototype)`.
  // (resolved via NATIVE_OBJECT_EXPRESSIONS below, with the iterator/generator prototypes.)
  // `Iterator` is a real global here, so its prototype (%IteratorPrototype%) has a dotted path.
  "Iterator.prototype",
  // Intl sub-constructor prototypes (each guarded — older platforms lack some).
  "Intl.DateTimeFormat.prototype",
  "Intl.NumberFormat.prototype",
  "Intl.Collator.prototype",
  "Intl.PluralRules.prototype",
  "Intl.RelativeTimeFormat.prototype",
  "Intl.ListFormat.prototype",
  "Intl.Locale.prototype",
  "Intl.Segmenter.prototype",
];
// Built EAGERLY at module load (not lazily) so it snapshots the REAL globals before any user code
// that runs AFTER `import "bun:closure"` can reassign one (`globalThis.console = userObject`). A
// lazy build would record the user's object at path "console" and later (wrongly) reference a USER
// object by a global path. Resolving the captured globals here is safe: every alias this depends on
// (MapCtor, Uint8ArrayCtor, ObjectGetPrototypeOf) is declared earlier at module top.
// Intrinsic objects with NO dotted global path — the iterator/generator/typed-array abstract
// prototypes. Each entry resolves the real object at module load (left) and is emitted as a
// self-resolving expression (right) that re-derives the SAME intrinsic in the reconstructed realm.
const NATIVE_OBJECT_EXPRESSIONS: Array<[() => unknown, string]> = [
  [() => ObjectGetPrototypeOf(Uint8ArrayCtor.prototype), "Object.getPrototypeOf(Uint8Array.prototype)"],
  [() => ObjectGetPrototypeOf(ArrayCtor.prototype[Symbol.iterator]()), "Object.getPrototypeOf([][Symbol.iterator]())"],
  [() => ObjectGetPrototypeOf(new MapCtor()[Symbol.iterator]()), "Object.getPrototypeOf(new Map()[Symbol.iterator]())"],
  [() => ObjectGetPrototypeOf(new SetCtor()[Symbol.iterator]()), "Object.getPrototypeOf(new Set()[Symbol.iterator]())"],
  [() => ObjectGetPrototypeOf("a"[Symbol.iterator]()), 'Object.getPrototypeOf(""[Symbol.iterator]())'],
  [() => ObjectGetPrototypeOf(function* () {}), "Object.getPrototypeOf(function*(){})"],
  [() => ObjectGetPrototypeOf(async function () {}), "Object.getPrototypeOf(async function(){})"],
  [() => ObjectGetPrototypeOf(async function* () {}), "Object.getPrototypeOf(async function*(){})"],
];
function nativeObjectPath(value: object): string | undefined {
  return nativeObjectMap.get(value);
}
function buildNativeObjectMap(): Map<object, string> {
  const map = new MapCtor<object, string>();
  const g = globalThis as any;
  map.set(g, "globalThis");
  const record = (v: unknown, expr: string): void => {
    // Only a genuine object identical to the resolved global is recorded. A USER object identical
    // to nothing here is never matched, so it is always serialized BY VALUE (invariant preserved).
    if (typeof v === "object" && v !== null && !map.has(v as object)) map.set(v as object, expr);
  };
  for (const path of NATIVE_OBJECT_PATHS) {
    let v: unknown = g;
    try {
      for (const part of path.split(".")) v = (v as any)[part];
    } catch {
      continue;
    }
    record(v, path);
  }
  for (const [resolve, expr] of NATIVE_OBJECT_EXPRESSIONS) {
    let v: unknown;
    try {
      v = resolve();
    } catch {
      continue;
    }
    record(v, expr);
  }
  return map;
}
// Snapshot at module load. See the comment on buildNativeObjectMap for why this is eager.
const nativeObjectMap: Map<object, string> = buildNativeObjectMap();

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
// method-shorthand and accessor sources (`foo(){}`, `async *g(){}`, `get x(){}`,
// `[sym](){}`, `"str-key"(){}`) are not. We discriminate via the AST: only the
// object-literal wrapping (parse offset 2) accepts a method/accessor, and the
// method's FunctionExpression value starts exactly at its parameter `(` — so we
// rebuild a plain function expression by slicing from there and dropping the
// property name / get|set keyword (its value is all that matters).
function functionSourceToExpression(source: string, name: string): string {
  const parsed = parseWithOffset(source);
  if (parsed === null) {
    // Unparseable (an extracted method still referencing `this.#x`, or exotic
    // input) — wrap as an object member and pull it back out by name.
    return `({ ${source} })[${JSONStringify(name)}]`;
  }
  const { node, offset } = parsed;
  // function / arrow / class — already a valid expression once parenthesized.
  if (offset !== 2) return `(${source})`;
  // Method shorthand or accessor: `node` is the method's FunctionExpression
  // value and `node.start` is its parameter `(`.
  if (typeof node.start === "number") {
    const open = node.start - offset;
    if (open >= 0 && open < source.length && source[open] === "(") {
      const prefix = "(" + (node.async ? "async " : "") + "function" + (node.generator ? "*" : "") + " ";
      return prefix + source.slice(open) + ")";
    }
  }
  // Position sanity failed — fall back to wrap-by-name (always valid).
  return `({ ${source} })[${JSONStringify(name)}]`;
}

// Private (#name) members can't be set from outside the class, so a serialized
// instance can't restore them. With the user's consent we transform them into
// regular (mangled) public members: every `#name` in the class source becomes
// `PRIVATE_PREFIX + name`, and a reconstructed instance's private-field values
// (read natively via Symbol.privateFields) are assigned to the same mangled
// keys. Methods/fields that were private become public — an intentional
// fidelity trade. The rewrite skips strings, template text, and comments so it
// only touches `#name` in code position.
const PRIVATE_PREFIX = "$bunClosurePrivate$";

function mangledPrivateName(hashName: string): string {
  // hashName is like "#n"; drop the leading "#".
  return PRIVATE_PREFIX + hashName.slice(1);
}

// Rewrite every `#private` member reference to its mangled public name. Prefers
// the AST — a parseable source (a class) gives exact `PrivateIdentifier`
// positions, so strings/comments/templates/regex literals are excluded
// structurally. Falls back to the scanner for sources the parser rejects (a
// method extracted from a class whose `this.#x` is invalid standalone — the
// very reason this rewrite exists).
function rewritePrivateMembers(source: string): string {
  if (source.indexOf("#") === -1) return source;
  const parsed = parseWithOffset(source);
  if (parsed !== null) {
    const edits: Array<{ start: number; end: number; text: string }> = [];
    const handled = new SetCtor<number>();
    // Replace the `#name` at a PrivateIdentifier's position. A brand check
    // (`#x in obj`) becomes `"mangled" in obj` — string property membership, not
    // a bare (undefined) identifier; every other position is the bare name.
    const pushPid = (pid: any, quoted: boolean): void => {
      if (typeof pid.name !== "string" || typeof pid.start !== "number") return;
      const start = pid.start - parsed.offset;
      const end = start + pid.name.length;
      // Sanity: the bytes at the mapped position must be the `#name` itself.
      if (start < 0 || end > source.length || source.slice(start, end) !== pid.name) return;
      const mangled = mangledPrivateName(pid.name);
      edits.push({ start, end, text: quoted ? JSONStringify(mangled) : mangled });
    };
    // Only mangle privates whose nearest enclosing class IS the top-level node being
    // reconstructed (a mangle-fallback class). A class NESTED inside the reconstructed
    // source — e.g. `() => { class C { #x } return new C(); }`, or a class defined in an
    // extracted method — is valid verbatim source whose `#x` must stay a genuine private.
    const top = parsed.node;
    (function walk(node: any, enclosingClass: any): void {
      if ($isJSArray(node)) {
        for (const x of node) walk(x, enclosingClass);
        return;
      }
      if (!node || typeof node !== "object") return;
      const isClass = node.type === "ClassExpression" || node.type === "ClassDeclaration";
      const next = isClass ? node : enclosingClass;
      if (enclosingClass === top) {
        if (node.type === "BinaryExpression" && node.operator === "in" && node.left?.type === "PrivateIdentifier") {
          pushPid(node.left, true);
          if (typeof node.left.start === "number") handled.add(node.left.start);
        }
        if (node.type === "PrivateIdentifier" && typeof node.start === "number" && !handled.has(node.start)) {
          pushPid(node, false);
        }
      }
      for (const k of ObjectKeys(node)) if (k !== "type") walk(node[k], next);
    })(top, top.type === "ClassExpression" || top.type === "ClassDeclaration" ? top : null);
    if (edits.length === 0) return source;
    // Apply right-to-left so earlier edits don't shift later positions.
    edits.sort((a, b) => b.start - a.start);
    let out = source;
    for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    return out;
  }
  return rewritePrivateMembersScanner(source);
}

function rewritePrivateMembersScanner(source: string): string {
  if (source.indexOf("#") === -1) return source;
  let i = 0;
  const n = source.length;
  const isIdentStart = (c: string | undefined) => c !== undefined && /[A-Za-z_$]/.test(c);
  const isIdentPart = (c: string | undefined) => c !== undefined && /[\w$]/.test(c);

  function scanString(quote: string): string {
    let out = source[i];
    i++;
    while (i < n && source[i] !== quote) {
      if (source[i] === "\\") {
        out += source[i] + (source[i + 1] ?? "");
        i += 2;
      } else {
        out += source[i];
        i++;
      }
    }
    if (i < n) {
      out += source[i];
      i++;
    }
    return out;
  }

  function scanTemplate(): string {
    let out = "`";
    i++;
    while (i < n) {
      const c = source[i];
      if (c === "\\") {
        out += c + (source[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (c === "`") {
        out += "`";
        i++;
        return out;
      }
      if (c === "$" && source[i + 1] === "{") {
        out += "${";
        i += 2;
        out += scanCode(true); // consumes through the matching `}`
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  function scanCode(stopAtCloseBrace: boolean): string {
    let out = "";
    let braceDepth = 0;
    while (i < n) {
      const c = source[i];
      if (stopAtCloseBrace && c === "}" && braceDepth === 0) {
        i++;
        return out + "}";
      }
      if (c === "{") {
        braceDepth++;
        out += c;
        i++;
        continue;
      }
      if (c === "}") {
        braceDepth--;
        out += c;
        i++;
        continue;
      }
      if (c === "/" && source[i + 1] === "/") {
        const e = source.indexOf("\n", i);
        const end = e === -1 ? n : e;
        out += source.slice(i, end);
        i = end;
        continue;
      }
      if (c === "/" && source[i + 1] === "*") {
        const e = source.indexOf("*/", i + 2);
        const end = e === -1 ? n : e + 2;
        out += source.slice(i, end);
        i = end;
        continue;
      }
      if (c === '"' || c === "'") {
        out += scanString(c);
        continue;
      }
      if (c === "`") {
        out += scanTemplate();
        continue;
      }
      if (c === "#" && isIdentStart(source[i + 1])) {
        let j = i + 1;
        while (j < n && isIdentPart(source[j])) j++;
        const mangled = PRIVATE_PREFIX + source.slice(i + 1, j);
        // `#name in obj` is a brand check: the left operand must be the property
        // KEY as a string, not a (now-undefined) bare identifier reference. A
        // bare `#name` not preceded by `.` is otherwise a member declaration.
        let k = j;
        while (k < n && /\s/.test(source[k]!)) k++;
        if (source[k] === "i" && source[k + 1] === "n" && !isIdentPart(source[k + 2])) {
          out += JSONStringify(mangled);
        } else {
          out += mangled;
        }
        i = j;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  return scanCode(false);
}

function isNativeFunctionSource(source: string): boolean {
  // Native functions stringify as `function name() { [native code] }`.
  const trimmed = source.trimEnd();
  return trimmed.endsWith("[native code] }") || trimmed.endsWith("[native code]\n}");
}

// Collect the free identifier names a function's source references (so we know
// which module-level imports the closure depends on). Bound names (params,
// declarations, nested function names) are excluded.
function collectReferencedNames(transpiler: any, source: string): Set<string> {
  let ast: any;
  try {
    ast = transpiler.ast("(" + source + ")");
  } catch {
    return new SetCtor();
  }
  return freeIdentifiersOfNode(ast);
}

// **Experimental.** Like `serialize`, but routes the closure through Bun's
// bundler: the closure's captured state is emitted as a virtual state module,
// its module-level imports are re-imported from their original sources, and the
// bundler resolves + inlines + tree-shakes them. Unlike `serialize`, closures
// that reference imported bindings produce a working standalone module. Async
// (the bundler is async). Returns the bundled ESM source.
async function bundle(fn: Function, replacer?: Replacer): Promise<string> {
  if (typeof fn !== "function") {
    throw new TypeError("bundle() expects a function");
  }
  const fs = require("node:fs");
  const path = require("node:path");
  const Bun = (globalThis as any).Bun;
  const transpiler = new Bun.Transpiler();

  // A bound function also stringifies as `[native code]`, so check it first.
  if ((fn as any)[Symbol.boundFunction] !== undefined) {
    throw new TypeError("Cannot bundle a bound function as the root; use serialize() instead");
  }
  const source = funcSource(fn);
  if (isNativeFunctionSource(source)) {
    throw new TypeError("Cannot bundle a native function (no JavaScript source is available)");
  }
  const location = (fn as any)[Symbol.sourceLocation];
  const url: string | undefined = location?.url;

  // 1. Captured state → a virtual module exporting each free variable. Reuses
  //    the existing value emitter (objects, prototypes, pruning, cycles, …).
  const { sharedIds } = analyzeSharedCells(fn);
  const genuinePlan = computeGenuineClasses(fn, sharedIds);
  const keep = computeKeepSets(fn);
  const ctx: Context = {
    module: [],
    refs: new MapCtor(),
    counter: 0,
    sharedIds,
    imports: new SetCtor(),
    replacer: typeof replacer === "function" ? replacer : undefined,
    sourceBlocks: [],
    keepSets: keep.keepSets,
    methodKeep: keep.methodKeep,
    capturedAsValue: keep.capturedAsValue,
    symbols: new MapCtor(),
    alsContexts: [],
    genuineClasses: genuinePlan.genuine,
    genuineMethods: computeGenuineMethods(genuinePlan.genuine),
    hostedArrows: genuinePlan.hostedArrows,
    classHosts: genuinePlan.classHosts,
    classReify: new MapCtor(),
    genuineClassId: new MapCtor(),
    needsReifySlot: false,
    deferredPatches: [],
    bodyQueue: [],
    emittedFns: new SetCtor(),
    inProgressFns: new SetCtor(),
    prunedMethods: new MapCtor(),
  };
  // 2. Recover the closure module's import bindings: localName → original source.
  type Binding = { source: string; imported?: string; default?: boolean; star?: boolean };
  const bindings = new MapCtor<string, Binding>();
  if (url && fs.existsSync(url)) {
    const moduleAst = transpiler.ast(fs.readFileSync(url, "utf8"));
    for (const stmt of moduleAst.body) {
      if (stmt.type !== "ImportDeclaration" || typeof stmt.source !== "string") continue;
      const resolved = path.resolve(path.dirname(url), stmt.source);
      for (const spec of stmt.specifiers) {
        if (spec.type === "ImportSpecifier") bindings.set(spec.local, { source: resolved, imported: spec.imported });
        else if (spec.type === "ImportDefaultSpecifier") bindings.set(spec.local, { source: resolved, default: true });
        else if (spec.type === "ImportNamespaceSpecifier") bindings.set(spec.local, { source: resolved, star: true });
      }
    }
  }

  const importLines: string[] = [];
  const emitted = new SetCtor<string>();
  const emitImport = (name: string, b: Binding): void => {
    if (emitted.has(name)) return;
    emitted.add(name);
    if (b.default) importLines.push(`import ${name} from ${JSONStringify(b.source)};`);
    else if (b.star) importLines.push(`import * as ${name} from ${JSONStringify(b.source)};`);
    else
      importLines.push(
        `import { ${b.imported === name ? name : `${b.imported} as ${name}`} } from ${JSONStringify(b.source)};`,
      );
  };

  // 3. Captured state → a virtual module exporting each free variable — EXCEPT
  //    free variables that are themselves import bindings (e.g. `import * as ns`,
  //    which JSC captures as a namespace object). Those are re-imported from
  //    their original source so the bundler resolves and tree-shakes them,
  //    rather than us value-walking the whole namespace object.
  const freeVariables = allFreeVariables(fn, source);
  const stateExports: string[] = [];
  const stateNames = new SetCtor<string>();
  for (const variable of freeVariables) {
    if (stateNames.has(variable.name) || emitted.has(variable.name)) continue;
    const binding = bindings.get(variable.name);
    if (binding) {
      emitImport(variable.name, binding);
      continue;
    }
    stateNames.add(variable.name);
    const value = transform(undefined, variable.name, variable.value, ctx);
    stateExports.push(`export const ${variable.name} = ${emitValue(value, ctx)};`);
  }
  // Drain deferred object bodies iteratively (see the serialize() path) before the patches.
  for (let i = 0; i < ctx.bodyQueue.length; i++) ctx.bodyQueue[i]();
  // Genuine-instance private patches run last (see the serialize() path), after every
  // hoisted binding a private slot may point at has been declared.
  for (const line of ctx.deferredPatches) ctx.module.push(line);
  const reifyBlock = ctx.needsReifySlot ? `let ${REIFY_SLOT} = false;\n` : "";
  const stateModule = reifyBlock + (ctx.module.length ? ctx.module.join("\n") + "\n" : "") + stateExports.join("\n");

  // 4. Re-import the remaining referenced module-level dependencies (named imports
  //    that JSC does not surface as free variables) from their original sources.
  //    Names we can neither bind to state, a global, nor an import are dangling —
  //    most commonly because the closure's source module couldn't be located.
  const unresolved: string[] = [];
  for (const name of collectReferencedNames(transpiler, source)) {
    if (stateNames.has(name) || emitted.has(name) || name in (globalThis as any)) continue;
    const binding = bindings.get(name);
    if (binding) emitImport(name, binding);
    else unresolved.push(name);
  }
  if (unresolved.length > 0) {
    const where = url ? `module "${url}"` : "an unknown module (no source location available)";
    throw new Error(
      `Cannot bundle closure: it references ${unresolved.map(n => `"${n}"`).join(", ")}, ` +
        `which is neither captured state nor an import resolvable from ${where}.`,
    );
  }

  // 5. Synthetic entry wiring imports + state to the reconstructed closure. The
  //    root is reconstructed form-aware (arrow / function / class / method).
  const entry = [
    ...importLines,
    stateNames.size ? `import { ${[...stateNames].join(", ")} } from "bun-closure:state";` : "",
    `export default ${functionSourceToExpression(source, "default")};`,
  ]
    .filter(Boolean)
    .join("\n");

  // 6. Drive the bundler; it resolves + inlines + tree-shakes the real imports.
  const result = await Bun.build({
    entrypoints: ["bun-closure:entry"],
    format: "esm",
    plugins: [
      {
        name: "bun-closure",
        setup(build: any) {
          build.onResolve({ filter: /^bun-closure:/ }, (args: any) => ({ path: args.path, namespace: "bun-closure" }));
          build.onLoad({ filter: /.*/, namespace: "bun-closure" }, (args: any) => ({
            loader: "js",
            contents: args.path === "bun-closure:entry" ? entry : stateModule,
          }));
        },
      },
    ],
  });
  if (!result.success) {
    throw new Error("Failed to bundle closure:\n" + result.logs.map((l: unknown) => String(l)).join("\n"));
  }
  return await result.outputs[0].text();
}

export default {
  serialize,
  bundle,
};
