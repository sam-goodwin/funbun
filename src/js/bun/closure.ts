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

// An `import` statement re-creating an external import binding (native / node:*
// / builtin) that can't be inlined.
function importStatement(variable: FreeVariable): string {
  const info = variable.import!;
  const src = JSON.stringify(info.source);
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
}

interface SourceBlock {
  moduleIndex: number;
  lineOffset: number;
  url: string;
  line: number;
  column: number;
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
    source = fn.toString();
  } catch {
    return false;
  }
  return !source.trimStart().startsWith("class");
}

function serialize(fn: Function, replacer?: Replacer): string {
  if (typeof fn !== "function") {
    throw new TypeError("serialize() expects a function");
  }

  const { sharedIds, cellInfo } = analyzeSharedCells(fn);
  // Start the generated-ref counter past any `__bunClosure$N` already present as a
  // free-variable name, so re-serializing already-serialized output (whose
  // generated names become free variables) doesn't collide.
  let counterStart = 0;
  for (const variable of cellInfo.values()) {
    const m = /^__bunClosure\$(\d+)$/.exec(variable.name);
    if (m !== null) counterStart = Math.max(counterStart, Number(m[1]) + 1);
  }
  const genuinePlan = computeGenuineClasses(fn);
  const ctx: Context = {
    module: [],
    refs: new Map(),
    counter: counterStart,
    sharedIds,
    imports: new Set(),
    replacer: typeof replacer === "function" ? replacer : undefined,
    sourceBlocks: [],
    keepSets: computeKeepSets(fn),
    symbols: new Map(),
    alsContexts: [],
    genuineClasses: genuinePlan.genuine,
    genuineMethods: computeGenuineMethods(genuinePlan.genuine),
    hostedArrows: genuinePlan.hostedArrows,
    classHosts: genuinePlan.classHosts,
    classReify: new Map(),
    genuineClassId: new Map(),
    needsReifySlot: false,
  };

  // Emit shared cells at module scope (deduped by id) before any function that
  // closes over them. Distinct shared cells with the same name can't coexist.
  const namesById = new Map<string, number>();
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

  // A bound or native root is emitted via the value path (bound → .bind(...),
  // native → its global path) and exported by reference; otherwise reconstruct
  // it inline.
  let exportExpr: string;
  let exportReconstructed: ReconstructedFunction | undefined;
  if ((fn as any)[Symbol.boundFunction] !== undefined || isNativeFunctionSource(fn.toString())) {
    exportExpr = emitFunction(fn, ctx);
  } else {
    exportReconstructed = reconstructFunctionExpr(fn, ctx);
    exportExpr = exportReconstructed.expr;
  }

  // Re-establish the captured AsyncLocalStorage context(s): wrap the root so each
  // call runs inside `als.run(store, ...)`, restoring `als.getStore()`. The
  // wrapper is single-line, so the function body's source-map lines are unchanged.
  // Only applies to plain/async functions: wrapping a class breaks `new`, and a
  // generator's body runs lazily after `run` returns (the context wouldn't be
  // active during iteration) — those reconstruct without context restoration.
  if (rootSupportsAlsWrap(fn)) {
    for (const { name, storeExpr } of ctx.alsContexts) {
      exportExpr = `(...__alsArgs) => ${name}.run(${storeExpr}, () => (${exportExpr})(...__alsArgs))`;
    }
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
      column: exportReconstructed.location.column,
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
  const sourceIndexByUrl = new Map<string, number>();
  // genLine -> [sourceIndex, srcLine0, genColumn, srcColumn]
  const mapped = new Map<number, [number, number, number, number]>();
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
      mapped.set(genLine, [sourceIndex, block.line - 1 + k, genColumn, srcColumn]);
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
    // An AsyncLocalStorage instance is reconstructed wholesale (fresh instance);
    // never walk its native internals (they reach unserializable functions).
    if (isAsyncLocalStorage(value as object)) return;
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
    const privateFields = (o as any)[Symbol.privateFields] as Array<{ value: unknown }> | undefined;
    if (privateFields) for (const field of privateFields) visitValue(field.value);
  }
  // Function -> the functions it captures (free-var values that are functions).
  const fnEdges = new Map<Function, Set<Function>>();
  // Cell id -> its value, when that value is a function. Used to hoist cells
  // whose function participates in a reference cycle.
  const cellValueFn = new Map<number, Function>();

  function visitFn(fn: Function): void {
    if (seenFns.has(fn)) return;
    seenFns.add(fn);
    let source: string;
    try {
      source = fn.toString();
    } catch {
      return;
    }
    const edges = new Set<Function>();
    fnEdges.set(fn, edges);
    const freeVariables = allFreeVariables(fn, source);
    for (const variable of freeVariables) {
      let set = cellFunctions.get(variable.id);
      if (set === undefined) {
        set = new Set();
        cellFunctions.set(variable.id, set);
        cellInfo.set(variable.id, variable);
      }
      set.add(fn);
      if (typeof variable.value === "function") {
        edges.add(variable.value as Function);
        cellValueFn.set(variable.id, variable.value as Function);
      }
      visitValue(variable.value);
    }
    // A class's superclass is reconstructed too, so analyze it.
    const superclass = Object.getPrototypeOf(fn);
    if (typeof superclass === "function" && superclass !== Function.prototype) {
      visitValue(superclass);
    }
  }

  visitFn(root);

  const cyclic = findCyclicFunctions(fnEdges);

  const sharedIds = new Set<number>();
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
  return { all: false, children: new Map(), calledMethods: new Set() };
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

// Parse a function's source (in any form `Function.prototype.toString` yields)
// and return its AST node plus the column `offset` of `source` within the code
// that actually parsed — each wrapper shifts node positions by its prefix length,
// so a node at AST position P sits at `source` position `P - offset`.
function parseWithOffset(source: string): { node: any; offset: number } | null {
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

// Module-level flag set true while a reify factory constructs a BARE genuine-private
// instance, so the injected constructor branch skips the original body; `false`/null
// otherwise, so a normal `new` is unaffected.
const REIFY_SLOT = "$bunClosureReify$";
// The per-class method injected to install that class's private fields from a values
// object, called on the bare instance AFTER all instances exist (so cycles work).
const PATCH_METHOD = "__bunReifyPatch";
// Builtin bases a genuine subclass can extend: their no-arg `super()` yields a valid empty
// instance and their content is restorable (Map.set/Set.add/array indices) after construction.
const RECONSTRUCTABLE_BUILTIN_BASES: Set<unknown> = new Set([Map, Set, Array]);

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
  const branch = `if(${REIFY_SLOT}){` + (isDerived ? "super();" : "") + `return;}`;
  // Patch keys are namespaced by class id so a same-named private across an inheritance
  // chain still maps to this class's own genuine slot.
  const patch = fields.length
    ? `${PATCH_METHOD}(v){${fields.map(f => `this.${f}=v[${JSON.stringify(keyPrefix + f)}];`).join("")}}`
    : "";
  const classBodyInjections = patch + hostMethods.join("");
  // The class body `{` — `node.body` (ClassBody) start is reliable and, crucially, points at
  // THIS class's brace, not a `{` inside the heritage (`extends class A {…}` / `extends
  // mixin({…})`), which `source.indexOf("{")` would wrongly find.
  const classBrace = typeof node.body?.start === "number" ? node.body.start - offset : source.indexOf("{");

  const ctor = node.body.body.find(
    (m: any) => m.type === "MethodDefinition" && m.static !== true && m.key?.value === "constructor",
  );
  if (ctor !== undefined) {
    // ctor.value.start is the params `(`; scan past the balanced param list to the
    // body `{` (ast() does not expose the body-brace position directly).
    let i = ctor.value.start - offset;
    let depth = 0;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === "(") depth++;
      else if (c === ")" && --depth === 0) {
        i++;
        break;
      }
    }
    while (i < source.length && source[i] !== "{") i++;
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
function computeGenuineClasses(root: unknown): GenuinePlan {
  // Cells shared across 2+ functions are hoisted to module scope by name; a hosted arrow
  // must reference such a cell by name (NOT thread it as a snapshot parameter) to keep
  // mutations shared.
  const sharedIds = typeof root === "function" ? analyzeSharedCells(root).sharedIds : new Set<number>();
  const funcs = new Set<Function>();
  const objs = new Set<object>();
  const seen = new Set<unknown>();
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
      }
      // Own DATA properties only — reading an accessor could fire a getter (side effect).
      for (const key of Reflect.ownKeys(v as object)) {
        const d = Object.getOwnPropertyDescriptor(v as object, key);
        if (d !== undefined && "value" in d) push(d.value);
      }
      push(Object.getPrototypeOf(v as object));
    }
  };
  drain();

  // Fold hostable escaped arrows' receivers into reachability: their `this` instance (and
  // hence its class) is otherwise invisible (the arrow captures only the brand), but we
  // recover it natively and host the arrow on the class. The instance must then be emitted
  // and its class must qualify as genuine.
  const arrowInstance = new Map<Function, object>();
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
  const structure = new Map<Function, ClassStructure | null>();
  const structOf = (C: Function): ClassStructure | null => {
    if (!structure.has(C)) {
      let s: ClassStructure | null = null;
      try {
        s = classStructure(C.toString());
      } catch {}
      structure.set(C, s);
    }
    return structure.get(C)!;
  };

  // Every reachable class's own methods — a method legitimately reading a private (even an
  // inherited one with a same-named field) must not be mistaken for an escaped closure.
  const allMethods = new Set<Function>();
  for (const f of funcs) {
    if (structOf(f) !== null) for (const m of classOwnMethods(f)) allMethods.add(m);
  }

  // Structural candidates: every class in a hierarchy that reaches Object through parseable
  // user classes only (no builtin base), has ≥1 private field, and no chain member with a
  // non-hostable escaped `#x` closure. (Same-name private collisions across the chain are
  // allowed — keys are namespaced by class id.)
  const candidate = new Set<Function>();
  for (const f of funcs) {
    const chain = genuineChain(f, structOf, funcs, allMethods);
    if (chain) for (const c of chain) candidate.add(c);
  }

  // Instance-leaf fixpoint: a genuine class is safe only if EVERY reachable instance with
  // it in its prototype chain is constructed by a genuine class (so the full constructor
  // chain installs every brand). If an instance's chain includes a non-candidate class, it
  // would be rebuilt via Object.create — unable to brand a genuine ancestor — so none of
  // its chain classes can be genuine; remove them all and repeat until stable.
  let changed = true;
  while (changed) {
    changed = false;
    for (const o of objs) {
      const chainClasses = instanceChainClasses(o);
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
  const hostedArrows: GenuinePlan["hostedArrows"] = new Map();
  const classHosts: GenuinePlan["classHosts"] = new Map();
  const hostCount = new Map<Function, number>();
  for (const [arrow, instance] of arrowInstance) {
    const proto = Object.getPrototypeOf(instance);
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
    hosts.push({ hostKey, source: arrow.toString(), params: captures.map(v => v.name) });
  }
  return { genuine: candidate, hostedArrows, classHosts };
}

// True if `fn` is an arrow that reads a `#private` through its lexical `this` (its non-`this`
// captures are threaded as host-method parameters, so any number of them is fine).
function hostableEscapedArrow(fn: Function): boolean {
  let src: string;
  try {
    src = fn.toString();
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
  const map = new Map<Function, { classFn: Function; key: string | symbol; kind: "method" | "get" | "set" }>();
  for (const C of genuineClasses) {
    const proto = C.prototype;
    if (proto == null) continue;
    for (const key of Reflect.ownKeys(proto)) {
      if (key === "constructor") continue;
      const d = Object.getOwnPropertyDescriptor(proto, key);
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
function genuineChain(
  C: Function,
  structOf: (C: Function) => ClassStructure | null,
  funcs: Set<Function>,
  allMethods: Set<Function>,
): Function[] | null {
  const chain: Function[] = [];
  let hasField = false;
  let cur: any = C;
  while (typeof cur === "function" && cur !== Function.prototype) {
    const s = structOf(cur);
    if (s === null) {
      // A builtin base we can reconstruct (its no-arg `super()` yields a valid empty instance
      // and its content is restorable) ends the chain genuinely; any other native base rejects.
      if (RECONSTRUCTABLE_BUILTIN_BASES.has(cur)) break;
      return null;
    }
    if (s.fields.length > 0) hasField = true;
    if (perClassDisqualified(cur, s.fields, funcs, allMethods)) return null;
    chain.push(cur);
    cur = Object.getPrototypeOf(cur);
  }
  return hasField ? chain : null;
}

// A stable per-genuine-class id, assigned on first use, for namespacing patch keys.
function genuineClassId(fn: Function, ctx: Context): number {
  let id = ctx.genuineClassId.get(fn);
  if (id === undefined) ctx.genuineClassId.set(fn, (id = ctx.genuineClassId.size));
  return id;
}

// The classes whose `.prototype` lies on `o`'s prototype chain (leaf-first) — i.e. the
// constructor chain that built `o`.
function instanceChainClasses(o: object): Function[] {
  const classes: Function[] = [];
  let p = Object.getPrototypeOf(o);
  while (p !== null && p !== Object.prototype) {
    const c = (p as any).constructor;
    if (typeof c === "function" && c.prototype === p) {
      // Stop at a builtin/native base (reconstructed via super(), not Object.create) — only
      // the user-class portion of the chain must be genuine for the fixpoint.
      if (isNativeFunctionSource(c.toString())) break;
      classes.push(c);
    }
    p = Object.getPrototypeOf(p);
  }
  return classes;
}

// The own (prototype + static) method/accessor function identities of class `C`.
function classOwnMethods(C: Function): Set<Function> {
  const methods = new Set<Function>();
  for (const holder of [C.prototype, C] as object[]) {
    if (holder == null) continue;
    for (const key of Reflect.ownKeys(holder)) {
      const d = Object.getOwnPropertyDescriptor(holder, key);
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
  for (const g of funcs) {
    if (g === C || allMethods.has(g) || hostableEscapedArrow(g)) continue;
    let src: string;
    try {
      src = g.toString();
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
  const table = new Map<string, AccessNode>();
  const get = (name: string): AccessNode => {
    let n = table.get(name);
    if (n === undefined) {
      n = newAccessNode();
      table.set(name, n);
    }
    return n;
  };

  // If `node` is a member chain rooted at a tracked name, return the AccessNode
  // for that path (creating it); computed/dynamic access marks the base whole.
  function accessOf(node: any): AccessNode | null {
    if (!node || typeof node !== "object") return null;
    if (node.type === "Identifier") return rootNames.has(node.name) ? get(node.name) : null;
    if (node.type === "ThisExpression") return rootNames.has("this") ? get("this") : null;
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
      case "CallExpression": {
        const callee = node.callee;
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
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (d !== undefined) return d;
    o = Object.getPrototypeOf(o);
  }
  return undefined;
}

// Build the per-value keep-sets: for each captured object, the set of own string
// keys to serialize (or "all"). Walks every reachable function, analyzes its
// access paths, and follows `this` into invoked methods so their reads are kept.
function computeKeepSets(root: Function): Map<object, Set<string> | "all"> {
  const keepSets = new Map<object, Set<string> | "all">();
  const seenFns = new Set<Function>();
  const seenObjs = new Set<object>();
  const followed = new Map<object, Set<string>>(); // receiver → methods already this-followed
  const followedFns = new Map<object, Set<Function>>(); // receiver → getter/method fns already this-followed

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
      if ($isProxyObject(o)) continue; // emitted via emitProxy, not keep-sets
      if ($isJSArray(o)) {
        for (const el of o as unknown[]) {
          if (el !== null && typeof el === "object") stack.push(el as object);
        }
        continue;
      }
      for (const key of Reflect.ownKeys(o)) {
        const d = Object.getOwnPropertyDescriptor(o, key)!;
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
      cur = new Set();
      keepSets.set(obj, cur);
    }
    for (const [prop, childNode] of node.children) {
      cur.add(prop);
      const d = lookupDescriptor(obj, prop);
      if (d !== undefined && "value" in d) {
        apply(d.value, childNode);
      } else if (d !== undefined && typeof d.get === "function") {
        // Reading `obj.prop` invokes the getter with `this === obj`; fold its
        // `this.X` reads into obj's keep-set. The getter's result is a fresh
        // value, so the child path past it is opaque (handled conservatively).
        thisFollowFn(obj, d.get);
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
      done = new Set();
      followed.set(obj, done);
    }
    if (done.has(method)) return;
    done.add(method);

    if (keepSets.get(obj) === "all") return;
    const d = lookupDescriptor(obj, method);
    if (d === undefined || !("value" in d)) {
      // accessor-valued or missing method: can't safely inspect → keep all.
      keepAll(obj);
      return;
    }
    thisFollowFn(obj, d.value);
  }

  // Fold a function's `this.X` reads into `obj`'s keep-set, given that it runs
  // with `this === obj` (an invoked method, or a getter read off `obj`).
  function thisFollowFn(obj: object, fn: unknown): void {
    if (typeof fn !== "function") return;
    let done = followedFns.get(obj);
    if (done === undefined) {
      done = new Set();
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
    const thisNode = analyzeAccess(fnNode, new Set(["this"])).get("this");
    if (thisNode === undefined) return; // doesn't touch `this`
    apply(obj, thisNode); // its `this.X` reads are reads on `obj`
  }

  function visitValueFns(value: unknown): void {
    if (value === null) return;
    const type = typeof value;
    if (type !== "function" && type !== "object") return;
    if (isAsyncLocalStorage(value as object)) return; // reconstructed wholesale; opaque
    if ($isProxyObject(value)) {
      const handler = $getProxyInternalField(value, $proxyFieldHandler);
      if (handler === null) return;
      visitValueFns($getProxyInternalField(value, $proxyFieldTarget));
      visitValueFns(handler);
      return;
    }
    if (type === "function") {
      const bound = (value as any)[Symbol.boundFunction] as BoundDetails | undefined;
      if (bound !== undefined) {
        visitValueFns(bound.target);
        visitValueFns(bound.boundThis);
        for (const arg of bound.boundArgs) visitValueFns(arg);
        return;
      }
      visitFn(value as Function);
      return;
    }
    const obj = value as object;
    if (seenObjs.has(obj)) return;
    seenObjs.add(obj);
    if ($isJSArray(obj)) {
      for (const el of obj as unknown[]) visitValueFns(el);
      return;
    }
    for (const key of Reflect.ownKeys(obj)) {
      const d = Object.getOwnPropertyDescriptor(obj, key)!;
      if (d.get) visitValueFns(d.get);
      if (d.set) visitValueFns(d.set);
      if ("value" in d) visitValueFns(d.value);
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== null && proto !== Object.prototype) {
      const ctor = (proto as any).constructor;
      visitValueFns(typeof ctor === "function" && ctor.prototype === proto ? ctor : proto);
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
    if (freeVariables.length === 0) return;
    const rootNames = new Set(freeVariables.map(v => v.name));
    const fnNode = parseFunctionNode(source);
    const table = fnNode === null ? null : analyzeAccess(fnNode, rootNames);
    for (const v of freeVariables) {
      apply(v.value, table === null ? undefined : table.get(v.name));
      visitValueFns(v.value);
    }
    const superclass = Object.getPrototypeOf(fn);
    if (typeof superclass === "function" && superclass !== Function.prototype) visitValueFns(superclass);
  }

  try {
    visitFn(root);
  } catch {
    // Any analysis failure must not break serialization: fall back to emitting
    // everything (the pre-pruning behaviour) by discarding partial keep-sets.
    return new Map();
  }
  return keepSets;
}

// Returns the set of functions that can reach themselves through the capture
// graph (self-loops and longer cycles).
function findCyclicFunctions(edges: Map<Function, Set<Function>>): Set<Function> {
  const cyclic = new Set<Function>();
  for (const start of edges.keys()) {
    const stack = [...(edges.get(start) ?? [])];
    const seen = new Set<Function>();
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node === start) {
        cyclic.add(start);
        break;
      }
      if (seen.has(node)) continue;
      seen.add(node);
      const next = edges.get(node);
      if (next) for (const f of next) stack.push(f);
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
  location: { url: string; line: number; column: number } | undefined;
  // Set when this is a class reconstructed with GENUINE `#private` fields: the field
  // names its injected constructor reify branch installs. emitFunction emits a reify
  // factory for it; instances are reconstructed through that factory.
  genuinePrivate?: { fields: string[] };
}

// Returns an expression that evaluates to a reconstruction of `fn`, wrapping its
// captured variables in an IIFE scope when it has any.
function reconstructFunctionExpr(fn: Function, ctx: Context): ReconstructedFunction {
  const original = fn.toString();
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
    source = injectReifyConstructor(original, gpInfo, hosts, `${genuineClassId(fn, ctx)}:`);
    genuinePrivate = { fields: gpInfo.fields };
    ctx.needsReifySlot = true;
  } else {
    source = rewritePrivateMembers(original);
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
    if (source.includes(PRIVATE_PREFIX) && !ctx.hostedArrows.has(fn) && arrowReadsLexicalThisPrivate(source)) {
      throw new TypeError(
        "Cannot serialize an arrow function that reads a #private field through its lexical `this`: " +
          "the receiving instance cannot be recovered. Capture the value first, e.g. " +
          "`const v = this.#x; return () => v;`.",
      );
    }
  }

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
  const boundNames = new Set<string>();
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
function classSourceAnchor(fn: Function, source: string): { url: string; line: number; column: number } | undefined {
  const parsed = parseWithOffset(source);
  if (parsed === null) return undefined;
  const members = parsed.node.body?.body;
  if (!$isJSArray(members)) return undefined;
  const proto = fn.prototype;
  if (proto == null) return undefined;
  for (const m of members) {
    if (m.type !== "MethodDefinition" || m.static === true) continue;
    const key = m.key?.value;
    if (typeof key !== "string" || key === "constructor") continue;
    if (typeof m.value?.start !== "number") continue;
    const d = Object.getOwnPropertyDescriptor(proto, key);
    const method = d?.value ?? d?.get ?? d?.set;
    const loc = (method as any)?.[Symbol.sourceLocation] as { url?: string; line?: number } | undefined;
    if (!loc?.url || typeof loc.line !== "number") continue;
    const posInSource = m.value.start - parsed.offset; // the method's params `(`
    if (posInSource < 0 || posInSource > source.length) continue;
    let rel = 0;
    for (let i = 0; i < posInSource; i++) if (source[i] === "\n") rel++;
    return { url: loc.url, line: loc.line - rel, column: 1 };
  }
  return undefined;
}

function allFreeVariables(fn: Function, source: string): FreeVariable[] {
  const own = ((fn as any)[Symbol.freeVariables] as FreeVariable[] | undefined) ?? [];
  if (!source.trimStart().startsWith("class")) {
    // `#name` private brands are recreated by the mangling rewrite (the receiver
    // carries the mangled field), never captured as an external free variable —
    // applies to a method extracted from a class just as to the class itself.
    return own.filter(v => !v.name.startsWith("#"));
  }

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

// If `fn` is a class with a superclass, returns the (possibly rewritten) source
// plus a binding bringing the superclass into scope. A simple identifier
// (`extends Base`) is bound as-is; a computed heritage (`extends mixin(Base)`,
// `extends ns.Base`) has its heritage expression replaced by a synthetic
// identifier bound to the captured superclass value. The superclass identity is
// the class's own prototype, reliable even though it isn't a free variable.
function classHeritage(fn: Function, source: string, ctx: Context): { source: string; binding: string } | undefined {
  if (!source.trimStart().startsWith("class")) return undefined;
  const superclass = Object.getPrototypeOf(fn);
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

  // Computed heritage (`extends mixin(Base)`, `extends ns.Base`): replace the
  // heritage expression with a synthetic identifier bound to the captured value.
  // The AST gives the heritage's start; its end is the class body `{` (the AST
  // node positions are offset by the parse wrapper), trimmed back over whitespace.
  const start = sc.start - parsed!.offset;
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
  const refs = new Set<string>();
  const bound = new Set<string>();
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

  const names = new Set<string>();
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
// Matching is robust (not order-based: Reflect.ownKeys groups strings before symbols): a
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
    for (const k of Reflect.ownKeys(holder)) {
      const d = Object.getOwnPropertyDescriptor(holder, k);
      if (d === undefined) continue;
      const f = d.value ?? d.get ?? d.set;
      if (typeof f !== "function") continue;
      let src: string;
      try {
        src = f.toString();
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

// A module namespace object (`import * as ns`) stringifies as `[object Module]`.
// Captured at load so user code can't tamper with `Object.prototype.toString`.
const objectToString = Object.prototype.toString;
function isModuleNamespaceObject(value: object): boolean {
  return objectToString.$call(value) === "[object Module]";
}

function emitObject(value: object, ctx: Context): string {
  const existing = ctx.refs.get(value);
  if (existing !== undefined) return existing;

  // Built-ins whose contents can't be enumerated or whose state can't be
  // captured: reject loudly rather than silently emitting an empty object.
  if (value instanceof Promise && $peekPromiseStatus(value) === 0) {
    // A pending promise's resolution is tied to live I/O / timers / a suspended
    // async frame in the event loop — not expressible as source. (Settled
    // promises are reconstructed in emitBuiltin.)
    throw new TypeError(
      "Cannot serialize a pending Promise (its resolution is tied to live I/O or timers). " +
        "Await it first, or serialize the settled value.",
    );
  }
  // Generator / async-generator objects and built-in iterator objects hold
  // suspended execution state (the yield point and local frame) in engine slots
  // that aren't reachable via reflection and can't be expressed as source.
  // Reject clearly instead of walking their native prototype chain (which would
  // throw an opaque "native function" error or silently emit a dead object).
  const tag = objectToString.$call(value);
  if (tag === "[object Generator]" || tag === "[object AsyncGenerator]" || tag.endsWith(" Iterator]")) {
    throw new TypeError(
      `Cannot serialize a ${tag.slice("[object ".length, -1)} object ` +
        `(its suspended execution state is not expressible as source). ` +
        `Serialize the generator function instead and re-create the iterator after reconstruction.`,
    );
  }

  const name = REF_PREFIX + ctx.counter++;
  // Record BEFORE recursing so a self-reference resolves to `name`.
  ctx.refs.set(value, name);

  // A genuine-private class instance (including a genuine subclass of a builtin like Map) is
  // reconstructed via its reify factory + patch methods, NOT the builtin/object paths below.
  // (Falls through to the frozen/sealed handling at the end.)
  if (!emitGenuinePrivateInstance(value, name, ctx)) {
    const builtinProto = emitBuiltin(value, name, ctx);
    if (builtinProto === null) {
      emitObjectBody(value, name, ctx);
      // An array subclass (`class X extends Array`) is constructed as a plain array
      // above; restore its prototype and any extra (non-index) own/private fields.
      if (Array.isArray(value) && Object.getPrototypeOf(value) !== Array.prototype) {
        restoreSubclass(value, name, ctx, arrayIndexSkip(value));
      }
    } else if (Object.getPrototypeOf(value) !== builtinProto) {
      // A built-in subclass (`class X extends Map/Set/...`): the base data is built;
      // restore the subclass prototype + its own/private instance fields.
      restoreSubclass(value, name, ctx);
    }
  }

  // Preserve a non-extensible/sealed/frozen state — applied LAST, after every
  // property (and any cycle) is wired, since a frozen object rejects mutation.
  // Covers built-ins (a frozen Map/Set/Date) as well as plain objects.
  if (!Object.isExtensible(value)) {
    if (Object.isFrozen(value)) ctx.module.push(`Object.freeze(${name});`);
    else if (Object.isSealed(value)) ctx.module.push(`Object.seal(${name});`);
    else ctx.module.push(`Object.preventExtensions(${name});`);
  }

  return name;
}

// Restores a built-in subclass instance: set its real prototype, then emit its
// extra own properties (instance fields) and private fields. `skip` excludes
// keys already materialized by the base construction (array indices + length).
function restoreSubclass(value: object, name: string, ctx: Context, skip?: Set<string>): void {
  // Point at the reconstructed class's own `.prototype` (not a standalone copy)
  // so `instanceof` and the shared prototype identity survive — same shape as
  // objectBaseExpression's class-instance case.
  const proto = Object.getPrototypeOf(value);
  const ctor = (proto as any)?.constructor;
  const protoExpr =
    typeof ctor === "function" && ctor.prototype === proto
      ? `${emitValue(ctor, ctx)}.prototype`
      : emitValue(proto, ctx);
  ctx.module.push(`Object.setPrototypeOf(${name}, ${protoExpr});`);
  emitOwnProperties(name, value, ctx, skip);
  emitPrivateFields(name, value, ctx);
}

function arrayIndexSkip(value: unknown[]): Set<string> {
  const skip = new Set<string>(["length"]);
  for (let i = 0; i < value.length; i++) skip.add(String(i));
  return skip;
}

function emitObjectBody(value: object, name: string, ctx: Context): void {
  if (Array.isArray(value)) {
    ctx.module.push(`const ${name} = [];`);
    const array = value as unknown[];
    for (let i = 0; i < array.length; i++) {
      if (i in array) {
        const child = transform(value, String(i), array[i], ctx);
        ctx.module.push(`${name}[${i}] = ${emitValue(child, ctx)};`);
      }
    }
    // Preserve the length, including trailing holes.
    ctx.module.push(`${name}.length = ${array.length};`);
  } else if (isModuleNamespaceObject(value)) {
    // A module namespace (`import * as ns`) — emit only the members the closure
    // referenced (access-path pruned), as a plain object. Its exotic prototype
    // chain and `Symbol.toStringTag` must NOT be walked (that reaches native
    // built-ins). Each member is read live and serialized like any value, so
    // imported functions/objects are inlined and tree-shaken to what's used.
    ctx.module.push(`const ${name} = {};`);
    const keep = ctx.keepSets.get(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") continue;
      if (keep !== undefined && keep !== "all" && !keep.has(key)) continue;
      const child = transform(value, key, (value as any)[key], ctx);
      if (child === undefined) continue;
      ctx.module.push(`${name}[${JSON.stringify(key)}] = ${emitValue(child, ctx)};`);
    }
  } else if (value instanceof Error) {
    emitErrorBody(value, name, ctx);
  } else {
    // Genuine-private instances are handled earlier in emitObject (before emitBuiltin).
    ctx.module.push(`const ${name} = ${objectBaseExpression(value, ctx)};`);
    emitOwnProperties(name, value, ctx);
    emitPrivateFields(name, value, ctx);
  }
}

// If `value` is an instance of a class the gate cleared for genuine privates, emit it in two
// phases: (1) construct a BARE instance via the reify factory, emitted BEFORE its private
// values so cycles/self-references can refer back to it; (2) install the genuine `#private`
// slots by calling each chain class's patch method (after all instances exist). Public own
// properties are restored last. Real `#private` slots preserve privacy, brand checks, and
// `instanceof`. Returns false (caller uses the default Object.create path) when not applicable.
function emitGenuinePrivateInstance(value: object, name: string, ctx: Context): boolean {
  const proto = Object.getPrototypeOf(value);
  const ctor = (proto as any)?.constructor;
  if (typeof ctor !== "function" || ctor.prototype !== proto) return false;
  if (!ctx.genuineClasses.has(ctor)) return false;
  // Emit the class first so its (and its ancestors') reify factories are in ctx.classReify.
  emitValue(ctor, ctx);
  const reify = ctx.classReify.get(ctor);
  if (reify === undefined) return false;

  // Phase 1: bare construct. Emitted before any private value so a private referencing this
  // instance (or a cycle through another instance) resolves to an already-declared binding.
  // For a builtin subclass the factory's `super()` yields an empty Map/Set/Array; its content
  // is restored onto the live instance next (the instance IS a Map/Set/Array).
  ctx.module.push(`const ${name} = ${reify.factory}();`);
  const builtinSkip = restoreBuiltinContent(value, name, ctx);

  // Phase 2: install privates. Each genuine class in the chain that declares private fields
  // gets its own patch method (sharing the name across the chain, reached via its prototype),
  // each reading only its own keys from the shared values object.
  const patchClasses: Function[] = [];
  for (let p: object | null = proto; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    const c = (p as any).constructor;
    if (typeof c === "function" && c.prototype === p && (ctx.classReify.get(c)?.fields.length ?? 0) > 0) {
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
        entries.push(`${JSON.stringify(prefix + fname)}: ${emitValue(transform(value, pf.name, pf.value, ctx), ctx)}`);
      }
    }
    const valsName = REF_PREFIX + ctx.counter++;
    ctx.module.push(`const ${valsName} = { ${entries.join(", ")} };`);
    for (const c of patchClasses) {
      ctx.module.push(`${emitValue(c, ctx)}.prototype.${PATCH_METHOD}.call(${name}, ${valsName});`);
    }
  }
  emitOwnProperties(name, value, ctx, builtinSkip);
  return true;
}

// Restores a genuine builtin subclass's content onto the already-constructed (empty) live
// instance: Map entries via `.set`, Set values via `.add`, array elements by index. Returns
// the own-property keys it handled (array indices + length) so the caller skips them.
function restoreBuiltinContent(value: object, name: string, ctx: Context): Set<string> | undefined {
  if (value instanceof Map) {
    for (const [k, v] of value as Map<unknown, unknown>) {
      const kx = emitValue(transform(value, "", k, ctx), ctx);
      const vx = emitValue(transform(value, "", v, ctx), ctx);
      ctx.module.push(`${name}.set(${kx}, ${vx});`);
    }
    return undefined;
  }
  if (value instanceof Set) {
    for (const v of value as Set<unknown>) {
      ctx.module.push(`${name}.add(${emitValue(transform(value, "", v, ctx), ctx)});`);
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (i in value) ctx.module.push(`${name}[${i}] = ${emitValue(transform(value, String(i), value[i], ctx), ctx)};`);
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
    ctx.module.push(`${name}[${JSON.stringify(mangledPrivateName(field.name))}] = ${emitValue(child, ctx)};`);
  }
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
function emitOwnProperties(
  name: string,
  value: object,
  ctx: Context,
  skip?: Set<string>,
  enumerableOnly = false,
): void {
  // Access-path pruning: when the closure only reads a known subset of this
  // object's string keys (and never uses it opaquely), `keepSets` holds exactly
  // those keys; emit only them. Symbol keys are never pruned (not statically
  // analyzable). "all" / absent means emit everything.
  const keep = ctx.keepSets.get(value);
  for (const key of Reflect.ownKeys(value)) {
    if (skip !== undefined && typeof key === "string" && skip.has(key)) {
      continue;
    }
    if (enumerableOnly && !Object.getOwnPropertyDescriptor(value, key)!.enumerable) {
      continue;
    }
    if (keep !== undefined && keep !== "all" && typeof key === "string" && !keep.has(key)) {
      continue;
    }
    const keyExpr = propertyKeyExpression(key, ctx);
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
    // A REPLACER that turns a defined value into undefined omits the property (JSON-like).
    // A genuinely-undefined own value is kept (faithful: `{a: undefined}` keeps `a`), so this
    // only fires when the replacer changed it (descriptor.value was not already undefined).
    if (child === undefined && descriptor.value !== undefined && typeof key === "string" && descriptor.enumerable) {
      continue;
    }

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
  if (registered !== undefined) return `Symbol.for(${JSON.stringify(registered)})`;
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
  ctx.module.push(`const ${name} = Symbol(${desc === undefined ? "" : JSON.stringify(desc)});`);
  return name;
}

function propertyKeyExpression(key: string | symbol, ctx: Context): string {
  if (typeof key === "string") return JSON.stringify(key);
  const stable = stableSymbolExpression(key);
  if (stable !== undefined) return stable;
  return uniqueSymbolRef(key, ctx);
}

// Reconstructs common built-in object types. Appends the construction to
// ctx.module under `name` and returns the built-in's NATURAL prototype (so the
// caller can detect and restore a subclass instance); returns null for plain
// objects/arrays, which the caller handles.
function emitBuiltin(value: object, name: string, ctx: Context): object | null {
  // A settled promise reconstructs from its result: Promise.resolve(value) /
  // Promise.reject(reason). Rejected promises are pre-handled (`.catch(...)`) so
  // module load doesn't raise an unhandled-rejection — the reason is still
  // delivered to anyone who awaits/catches `name`. (Pending promises already
  // threw in emitObject.)
  if (value instanceof Promise) {
    const status = $peekPromiseStatus(value);
    const settled = $peekPromiseSettledValue(value);
    if (status === 2) {
      ctx.module.push(`const ${name} = Promise.reject(${emitValue(settled, ctx)});`);
      ctx.module.push(`${name}.catch(() => {});`);
    } else {
      ctx.module.push(`const ${name} = Promise.resolve(${emitValue(settled, ctx)});`);
    }
    return Promise.prototype;
  }
  if (value instanceof Date) {
    ctx.module.push(`const ${name} = new Date(${(value as Date).getTime()});`);
    return Date.prototype;
  }
  if (value instanceof RegExp) {
    const re = value as RegExp;
    ctx.module.push(`const ${name} = new RegExp(${JSON.stringify(re.source)}, ${JSON.stringify(re.flags)});`);
    return RegExp.prototype;
  }
  if (value instanceof Map) {
    ctx.module.push(`const ${name} = new Map();`);
    for (const entry of value as Map<unknown, unknown>) {
      ctx.module.push(`${name}.set(${emitValue(entry[0], ctx)}, ${emitValue(entry[1], ctx)});`);
    }
    return Map.prototype;
  }
  if (value instanceof Set) {
    ctx.module.push(`const ${name} = new Set();`);
    for (const element of value as Set<unknown>) {
      ctx.module.push(`${name}.add(${emitValue(element, ctx)});`);
    }
    return Set.prototype;
  }
  // ArrayBuffer-backed: emit the underlying buffer through the normal value path
  // (so multiple views over one buffer share it by identity) then build the view
  // over it, preserving byteOffset/length. DataView and every typed-array kind go
  // through here. (Subclassing these is not supported — return the live prototype
  // so no subclass-restore is attempted.)
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView & { length?: number; constructor: { name: string } };
    const bufferExpr = emitValue(view.buffer, ctx);
    if (value instanceof DataView) {
      ctx.module.push(`const ${name} = new DataView(${bufferExpr}, ${view.byteOffset}, ${view.byteLength});`);
    } else {
      ctx.module.push(
        `const ${name} = new ${view.constructor.name}(${bufferExpr}, ${view.byteOffset}, ${view.length});`,
      );
    }
    return Object.getPrototypeOf(value);
  }
  if (
    value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer)
  ) {
    const ctor = value instanceof ArrayBuffer ? "ArrayBuffer" : "SharedArrayBuffer";
    const bytes = [...new Uint8Array(value as ArrayBufferLike)];
    ctx.module.push(`const ${name} = new ${ctor}(${(value as ArrayBufferLike).byteLength});`);
    if (bytes.some(b => b !== 0)) ctx.module.push(`new Uint8Array(${name}).set([${bytes.join(", ")}]);`);
    return Object.getPrototypeOf(value);
  }
  // Boxed primitives (new Number/String/Boolean) — objects wrapping a primitive.
  if (value instanceof Number) {
    ctx.module.push(`const ${name} = new Number(${serializeNumber((value as Number).valueOf())});`);
    return Number.prototype;
  }
  if (value instanceof String) {
    ctx.module.push(`const ${name} = new String(${JSON.stringify((value as String).valueOf())});`);
    return String.prototype;
  }
  if (value instanceof Boolean) {
    ctx.module.push(`const ${name} = new Boolean(${(value as Boolean).valueOf()});`);
    return Boolean.prototype;
  }
  // A WeakRef snapshots its live referent. If already collected at serialize
  // time, emit a WeakRef to a fresh (immediately collectable) object — best
  // effort, since "already collected" can't be reproduced.
  if (value instanceof WeakRef) {
    const target = (value as WeakRef<any>).deref();
    ctx.module.push(`const ${name} = new WeakRef(${target === undefined ? "{}" : emitValue(target, ctx)});`);
    return WeakRef.prototype;
  }
  // WeakMap / WeakSet entries aren't JS-enumerable, but their live entries can be
  // snapshotted natively. Reconstruct as a fresh weak collection with those
  // entries (keys keep their identity with other captures). Snapshot semantics:
  // the keys alive at serialize time.
  if (value instanceof WeakMap) {
    const snap = $weakCollectionSnapshot(value); // [k, v, k, v, ...]
    ctx.module.push(`const ${name} = new WeakMap();`);
    for (let i = 0; i + 1 < snap.length; i += 2) {
      ctx.module.push(`${name}.set(${emitValue(snap[i], ctx)}, ${emitValue(snap[i + 1], ctx)});`);
    }
    return WeakMap.prototype;
  }
  if (value instanceof WeakSet) {
    const snap = $weakCollectionSnapshot(value); // [k, k, ...]
    ctx.module.push(`const ${name} = new WeakSet();`);
    for (const element of snap) ctx.module.push(`${name}.add(${emitValue(element, ctx)});`);
    return WeakSet.prototype;
  }
  // FinalizationRegistry: its registrations aren't JS-enumerable, but a native
  // snapshot exposes the callback + live { target, heldValue, unregisterToken }.
  // Reconstruct as a fresh registry with those registrations (snapshot of the
  // targets alive at serialize time).
  if (typeof FinalizationRegistry !== "undefined" && value instanceof FinalizationRegistry) {
    const snap = $finalizationRegistrySnapshot(value); // { callback, flat: [t, h, tok, ...] }
    if (snap === null) return null;
    ctx.module.push(`const ${name} = new FinalizationRegistry(${emitValue(snap.callback, ctx)});`);
    const flat = snap.flat;
    for (let i = 0; i + 2 < flat.length; i += 3) {
      const token = flat[i + 2];
      const tokenArg = token === undefined ? "" : `, ${emitValue(token, ctx)}`;
      ctx.module.push(`${name}.register(${emitValue(flat[i], ctx)}, ${emitValue(flat[i + 1], ctx)}${tokenArg});`);
    }
    return FinalizationRegistry.prototype;
  }
  return null;
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
  for (let p: object | null = value; p; p = Object.getPrototypeOf(p)) {
    const ctor = (p as any).constructor;
    if (typeof ctor === "function" && ERROR_BASES.includes(ctor.name) && (globalThis as any)[ctor.name] === ctor) {
      return ctor.name;
    }
  }
  return "Error";
}

// Reconstructs an Error: create the right builtin base (with [[ErrorData]]),
// then restore every own property — `message`, `cause` (incl. circular), an
// AggregateError's `errors`, and any custom fields (`code`, `status`, ...) —
// and, for a subclass, its prototype. `stack` is intentionally not pinned to the
// original location.
function emitErrorBody(value: Error, name: string, ctx: Context): void {
  const base = builtinErrorBase(value);
  if (base === "AggregateError") {
    ctx.module.push(`const ${name} = new AggregateError([], ${JSON.stringify(value.message)});`);
  } else {
    ctx.module.push(`const ${name} = new ${base}(${JSON.stringify(value.message)});`);
  }
  emitOwnProperties(name, value, ctx, ERROR_SKIP_KEYS);
  const proto = Object.getPrototypeOf(value);
  if (proto !== (globalThis as any)[base].prototype) {
    ctx.module.push(`Object.setPrototypeOf(${name}, ${emitValue(proto, ctx)});`);
  }
}

const ERROR_SKIP_KEYS = new Set(["stack"]);

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

function emitFunction(fn: Function, ctx: Context): string {
  const existing = ctx.refs.get(fn);
  if (existing !== undefined) return existing;

  const name = REF_PREFIX + ctx.counter++;
  ctx.refs.set(fn, name);

  // An escaped arrow that reads a `#private` through its lexical `this` is reconstructed by
  // invoking its host method on the reified receiver instance: the host (injected into the
  // genuine class body) returns a fresh arrow whose `this` is that instance, so `this.#x`
  // reads the genuine slot.
  const hosted = ctx.hostedArrows.get(fn);
  if (hosted !== undefined) {
    const instanceExpr = emitValue(hosted.instance, ctx);
    const argExprs = hosted.args.map(a => emitValue(transform(undefined, a.name, a.value, ctx), ctx));
    ctx.module.push(`const ${name} = ${instanceExpr}.${hosted.hostKey}(${argExprs.join(", ")});`);
    return name;
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
    return name;
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
    return name;
  }

  // A native built-in (Math.max, Array.prototype.slice, console.log, Error, ...)
  // has no JS source but a stable identity reachable from globalThis — reference
  // it by its path rather than trying to reconstruct it. This is what lets a
  // captured native function round-trip, and `class X extends Error` work.
  if (isNativeFunctionSource(fn.toString())) {
    const path = nativeFunctionPath(fn);
    if (path !== undefined) {
      ctx.module.push(`const ${name} = ${path};`);
      return name;
    }
  }

  const reconstructed = reconstructFunctionExpr(fn, ctx);
  // `const <name> = ` adds no newlines, so the source offset within the entry is
  // the offset within the expression.
  ctx.module.push(`const ${name} = ${reconstructed.expr};`);
  recordSourceBlock(ctx, ctx.module.length - 1, reconstructed);
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
  // Functions can carry their own properties (e.g. `fn.version = 2`, or a class's
  // externally-assigned statics like `C.instance = ...`). Emit the ENUMERABLE
  // ones — that skips `name`/`length`/`prototype` and non-enumerable static
  // methods (already reconstructed from the class source).
  emitOwnProperties(name, fn, ctx, undefined, true);
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
    column: location.column,
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
    if ((value as any)?.constructor?.name !== "AsyncLocalStorage") return false;
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
  // The source is built via JSON.stringify so the builtin-module preprocessor
  // doesn't treat this template literal as a real import and strip it.
  ctx.imports.add(`import { AsyncLocalStorage } from ${JSON.stringify("node:async_hooks")};`);
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
  const map = new Map<Function, string>();
  const g = globalThis as any;
  const record = (f: unknown, path: string): void => {
    if (typeof f === "function" && !map.has(f)) map.set(f, path);
  };
  // Record the own function-valued properties of `obj` as `<base>.<key>` (data
  // properties only — accessors may throw or be context-sensitive).
  const walkMembers = (obj: any, base: string): void => {
    let keys: string[];
    try {
      keys = Object.getOwnPropertyNames(obj);
    } catch {
      return;
    }
    for (const key of keys) {
      if (key === "caller" || key === "arguments" || key === "callee") continue;
      let d: PropertyDescriptor | undefined;
      try {
        d = Object.getOwnPropertyDescriptor(obj, key);
      } catch {
        continue;
      }
      if (d !== undefined && typeof d.value === "function") record(d.value, `${base}.${key}`);
    }
  };
  for (const name of Object.getOwnPropertyNames(g)) {
    if (name === "globalThis" || name === "global" || name === "window" || name === "self") continue;
    let v: any;
    try {
      v = g[name];
    } catch {
      continue;
    }
    if (typeof v === "function") {
      record(v, name); // the constructor / global function itself
      walkMembers(v, name); // static methods (Object.keys, Array.from, ...)
      if (v.prototype) walkMembers(v.prototype, `${name}.prototype`); // instance methods
    } else if (typeof v === "object" && v !== null) {
      walkMembers(v, name); // namespace methods (Math.max, JSON.parse, console.log, ...)
    }
  }
  return map;
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
    return `({ ${source} })[${JSON.stringify(name)}]`;
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
  return `({ ${source} })[${JSON.stringify(name)}]`;
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
    const handled = new Set<number>();
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
      edits.push({ start, end, text: quoted ? JSON.stringify(mangled) : mangled });
    };
    (function walk(node: any): void {
      if ($isJSArray(node)) {
        for (const x of node) walk(x);
        return;
      }
      if (!node || typeof node !== "object") return;
      if (node.type === "BinaryExpression" && node.operator === "in" && node.left?.type === "PrivateIdentifier") {
        pushPid(node.left, true);
        if (typeof node.left.start === "number") handled.add(node.left.start);
      }
      if (node.type === "PrivateIdentifier" && typeof node.start === "number" && !handled.has(node.start)) {
        pushPid(node, false);
      }
      for (const k of Object.keys(node)) if (k !== "type") walk(node[k]);
    })(parsed.node);
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
          out += JSON.stringify(mangled);
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
    return new Set();
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
  const source = fn.toString();
  if (isNativeFunctionSource(source)) {
    throw new TypeError("Cannot bundle a native function (no JavaScript source is available)");
  }
  const location = (fn as any)[Symbol.sourceLocation];
  const url: string | undefined = location?.url;

  // 1. Captured state → a virtual module exporting each free variable. Reuses
  //    the existing value emitter (objects, prototypes, pruning, cycles, …).
  const { sharedIds } = analyzeSharedCells(fn);
  const genuinePlan = computeGenuineClasses(fn);
  const ctx: Context = {
    module: [],
    refs: new Map(),
    counter: 0,
    sharedIds,
    imports: new Set(),
    replacer: typeof replacer === "function" ? replacer : undefined,
    sourceBlocks: [],
    keepSets: computeKeepSets(fn),
    symbols: new Map(),
    alsContexts: [],
    genuineClasses: genuinePlan.genuine,
    genuineMethods: computeGenuineMethods(genuinePlan.genuine),
    hostedArrows: genuinePlan.hostedArrows,
    classHosts: genuinePlan.classHosts,
    classReify: new Map(),
    genuineClassId: new Map(),
    needsReifySlot: false,
  };
  // 2. Recover the closure module's import bindings: localName → original source.
  type Binding = { source: string; imported?: string; default?: boolean; star?: boolean };
  const bindings = new Map<string, Binding>();
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
  const emitted = new Set<string>();
  const emitImport = (name: string, b: Binding): void => {
    if (emitted.has(name)) return;
    emitted.add(name);
    if (b.default) importLines.push(`import ${name} from ${JSON.stringify(b.source)};`);
    else if (b.star) importLines.push(`import * as ${name} from ${JSON.stringify(b.source)};`);
    else
      importLines.push(
        `import { ${b.imported === name ? name : `${b.imported} as ${name}`} } from ${JSON.stringify(b.source)};`,
      );
  };

  // 3. Captured state → a virtual module exporting each free variable — EXCEPT
  //    free variables that are themselves import bindings (e.g. `import * as ns`,
  //    which JSC captures as a namespace object). Those are re-imported from
  //    their original source so the bundler resolves and tree-shakes them,
  //    rather than us value-walking the whole namespace object.
  const freeVariables = allFreeVariables(fn, source);
  const stateExports: string[] = [];
  const stateNames = new Set<string>();
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
