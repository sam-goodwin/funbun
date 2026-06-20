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
  // Per captured object value, which own string keys to serialize: a Set of the
  // keys actually referenced by the closure (access-path pruning), or "all" /
  // absent to serialize every key. See computeKeepSets.
  keepSets: Map<object, Set<string> | "all">;
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
    keepSets: computeKeepSets(fn),
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

// Parse a function's source (in any form `Function.prototype.toString` yields)
// and return its AST node, or null if it can't be parsed.
function parseFunctionNode(source: string): any | null {
  const t = getTranspiler();
  const tryParse = (code: string): any | null => {
    let prog: any;
    try {
      prog = t.ast(code);
    } catch {
      return null;
    }
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
  };
  return tryParse("(" + source + ")") ?? tryParse(source) ?? tryParse("({" + source + "})");
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
      if (d !== undefined && "value" in d) apply(d.value, childNode);
      // accessor/missing props: kept (added above) but not recursed into.
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
    const fn = d.value;
    if (typeof fn !== "function") return;
    let source: string;
    try {
      source = fn.toString();
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
    if (thisNode === undefined) return; // method doesn't touch `this`
    apply(obj, thisNode); // its `this.X` reads are reads on `obj`
  }

  function visitValueFns(value: unknown): void {
    if (value === null) return;
    const type = typeof value;
    if (type !== "function" && type !== "object") return;
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
  location: { url: string; line: number; column: number } | undefined;
}

// Returns an expression that evaluates to a reconstruction of `fn`, wrapping its
// captured variables in an IIFE scope when it has any.
function reconstructFunctionExpr(fn: Function, ctx: Context): ReconstructedFunction {
  const original = fn.toString();
  if (isNativeFunctionSource(original)) {
    throw new TypeError("Cannot serialize a native function (no JavaScript source is available)");
  }
  // Transform `#private` class members into mangled public members so instances
  // can be reconstructed. Same-line replacement, so line counts are preserved
  // (source maps stay correct).
  const source = original.trimStart().startsWith("class") ? rewritePrivateMembers(original) : original;

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
    case "symbol":
      return emitSymbol(value as symbol);
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
  if (value instanceof WeakMap || value instanceof WeakSet) {
    throw new TypeError("Cannot serialize a WeakMap/WeakSet (its entries are not enumerable)");
  }
  if (value instanceof Promise) {
    throw new TypeError("Cannot serialize a Promise");
  }

  const name = REF_PREFIX + ctx.counter++;
  // Record BEFORE recursing so a self-reference resolves to `name`.
  ctx.refs.set(value, name);

  if (emitBuiltin(value, name, ctx)) {
    return name;
  }

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
  } else {
    ctx.module.push(`const ${name} = ${objectBaseExpression(value, ctx)};`);
    emitOwnProperties(name, value, ctx);
    emitPrivateFields(name, value, ctx);
  }

  return name;
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
function emitOwnProperties(name: string, value: object, ctx: Context): void {
  // Access-path pruning: when the closure only reads a known subset of this
  // object's string keys (and never uses it opaquely), `keepSets` holds exactly
  // those keys; emit only them. Symbol keys are never pruned (not statically
  // analyzable). "all" / absent means emit everything.
  const keep = ctx.keepSets.get(value);
  for (const key of Reflect.ownKeys(value)) {
    if (keep !== undefined && keep !== "all" && typeof key === "string" && !keep.has(key)) {
      continue;
    }
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

// Symbols with a stable global identity (registered via Symbol.for, or the
// well-known symbols) can be reconstructed; a unique symbol cannot (its identity
// is not reproducible).
function emitSymbol(value: symbol): string {
  const registered = Symbol.keyFor(value);
  if (registered !== undefined) return `Symbol.for(${JSON.stringify(registered)})`;
  for (const entry of WELL_KNOWN_SYMBOLS) {
    if (entry[0] === value) return entry[1];
  }
  throw new TypeError(`Cannot serialize a unique symbol value (${value.toString()})`);
}

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
  // `async *g(){}`, `async* [Symbol.iterator](){}`, `"str-key"(){}`, `123(){}`.
  // `async` and `*` may appear with or without surrounding whitespace. The
  // property name is irrelevant to the function value, so drop it and emit a
  // plain (async/generator) function expression.
  const method = trimmed.match(
    /^(async\b)?\s*(\*)?\s*(?:[A-Za-z_$][\w$]*|\[[\s\S]*?\]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\d[\w.]*)\s*(\([\s\S]*)$/,
  );
  if (method !== null) {
    const asyncPart = method[1] ? "async " : "";
    const star = method[2] ? "*" : "";
    return `(${asyncPart}function${star} ${method[3]})`;
  }
  // Fallback: wrap and extract by name (should be unreachable for valid sources).
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

function rewritePrivateMembers(source: string): string {
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
        out += PRIVATE_PREFIX + source.slice(i + 1, j);
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
  const refs = new Set<string>();
  const bound = new Set<string>();
  // Collect the names a binding pattern introduces (params / declarators),
  // including destructuring: `{a, b: c}`, `[x, ...rest]`, `a = 1`.
  const bindNames = (node: any): void => {
    if (!node || typeof node !== "object") return;
    switch (node.type) {
      case "Identifier":
        bound.add(node.name);
        break;
      case "AssignmentPattern":
        bindNames(node.left);
        break;
      case "ArrayPattern":
        for (const el of node.elements || []) bindNames(el);
        break;
      case "ObjectPattern":
        for (const p of node.properties || []) bindNames(p.value);
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
      // `obj.prop` references `obj`, not `prop` (a property name). Only a
      // computed `obj[expr]` references the property expression.
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
  })(ast);
  for (const b of bound) refs.delete(b);
  return refs;
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
  const ctx: Context = {
    module: [],
    refs: new Map(),
    counter: 0,
    sharedIds,
    replacer: typeof replacer === "function" ? replacer : undefined,
    sourceBlocks: [],
    keepSets: computeKeepSets(fn),
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
  const stateModule = (ctx.module.length ? ctx.module.join("\n") + "\n" : "") + stateExports.join("\n");

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
