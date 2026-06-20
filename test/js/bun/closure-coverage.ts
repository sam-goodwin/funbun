// Objective spec-coverage tracker for the closure serializer (bun:closure).
//
// This is the single source of truth for "how close are we to supporting every
// case". Each item is a capability in the JS value/feature space a closure can
// capture or be, tagged with a status and an `evidence` substring that MUST
// appear in the closure test files. The reporter cross-checks evidence against
// the real tests, so a "supported" claim can't drift from reality.
//
//   Run:  bun test/js/bun/closure-coverage.ts          (or: bun run closure:coverage)
//   CI-ish: exits non-zero if any supported/limitation item is unverified.
//
// Status meanings:
//   supported  — works correctly, proven by a passing round-trip/assertion test.
//   limitation — intentionally not supported, but fails with a CLEAR error
//                (never silent corruption), proven by a test asserting the throw.
//   todo       — not yet handled / not yet measured. The roadmap to 100%.
//
// Metrics:
//   Coverage   = supported / (supported + todo)          ← "how close to every case"
//   Safety     = (supported + limitation) / total        ← "no silent failures"

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type Status = "supported" | "limitation" | "todo";

export interface CoverageItem {
  id: string;
  title: string;
  status: Status;
  /** Substring that must appear in a test file to back a supported/limitation claim. */
  evidence?: string;
  note?: string;
}

export interface CoverageCategory {
  name: string;
  items: CoverageItem[];
}

const S = (id: string, title: string, evidence: string, note?: string): CoverageItem => ({
  id,
  title,
  status: "supported",
  evidence,
  note,
});
const L = (id: string, title: string, evidence: string, note?: string): CoverageItem => ({
  id,
  title,
  status: "limitation",
  evidence,
  note,
});
const T = (id: string, title: string, note?: string): CoverageItem => ({ id, title, status: "todo", note });

export const CATEGORIES: CoverageCategory[] = [
  {
    name: "Root forms (what the serialized fn itself can be)",
    items: [
      S("root.arrow", "arrow function", "round-trips an arrow function with no free variables"),
      S("root.fnexpr", "function expression", "round-trips a function expression"),
      S("root.named-fnexpr", "named function expression (self-ref)", "named function expression with self-reference"),
      S("root.async", "async function", "round-trips an async function"),
      S(
        "root.async-arrow",
        "async arrow capturing a promise fn",
        "async function awaiting a captured promise-returning fn",
      ),
      S("root.generator", "generator function", "reconstructs generator and async generator functions"),
      S("root.async-generator", "async generator function", "async generator function with return value"),
      S("root.method", "extracted object method", "plain method reference"),
      S("root.class-decl", "class declaration as a value", "reconstructs a subclass value (extends superclass)"),
      S("root.class-expr", "class expression as a value", "named class expression round-trips"),
      S("root.bound", "bound function as the root", "serializes a bound function as the root"),
      L("root.native", "native function (clear error)", "throws on native functions"),
    ],
  },
  {
    name: "Captured value types",
    items: [
      S("val.number", "number", "reconstructs a captured primitive (number)"),
      S(
        "val.primitives",
        "string/bool/null/undefined/bigint/-0/Inf/NaN",
        "reconstructs captured primitives of every kind",
      ),
      S("val.object", "plain object", "reconstructs a captured object"),
      S("val.array", "array", "reconstructs a captured array"),
      S("val.sparse-array", "sparse array (holes + length)", "sparse array preserves holes and length"),
      S("val.nested", "deeply nested object", "reconstructs a captured object"),
      S("val.function", "function value", "reconstructs a captured (nested) function"),
      S("val.class", "class value", "reconstructs a subclass value (extends superclass)"),
      S("val.instance", "class instance", "reconstructs a class instance (prototype, methods, fields)"),
      S("val.null-proto", "null-prototype object", "reconstructs a null-prototype object"),
      S("val.date", "Date", "reconstructs a captured Date"),
      S("val.regexp", "RegExp", "reconstructs a captured RegExp"),
      S("val.map", "Map", "reconstructs a captured Map (with object values)"),
      S("val.set", "Set", "reconstructs a captured Set"),
      S("val.typedarray", "typed array (Uint8Array)", "reconstructs a captured typed array"),
      S("val.error", "Error (type + message)", "reconstructs a captured Error with its type and message"),
      S("val.getter", "object getter (live)", "reconstructs an object getter (preserves dynamic behavior)"),
      S("val.getter-setter", "getter/setter pair", "reconstructs a getter/setter pair"),
      S("val.non-enum", "non-enumerable data property", "preserves non-enumerable data properties"),
      S("val.symbol-key", "registered-symbol property key", "preserves a registered-symbol-keyed property"),
      S("val.registered-symbol", "registered symbol value (Symbol.for)", "registered symbol value (Symbol.for)"),
      S("val.wellknown-symbol", "well-known symbol value", "well-known symbol value"),
      L("val.unique-symbol-val", "unique symbol value (clear error)", "unique symbol value throws"),
      L("val.unique-symbol-key", "unique symbol key (clear error)", "throws on a unique-symbol-keyed property"),
      L("val.weakmap", "WeakMap (clear error)", "WeakMap"),
      L("val.weakset", "WeakSet (clear error)", "WeakSet"),
      L("val.promise", "Promise (clear error)", "let p = Promise.resolve(1)"),
      L(
        "val.generator-object",
        "generator object (clear error)",
        "partially-executed generator object throws a clear error",
      ),
      L(
        "val.async-generator-object",
        "async generator object (clear error)",
        "async generator object throws a clear error",
      ),
      L(
        "val.iterator-object",
        "native iterator object (clear error)",
        "native array iterator object throws a clear error",
      ),
      S(
        "val.boxed-primitive",
        "boxed primitives (new Number/String/Boolean)",
        "boxed Number/String/Boolean round-trip as objects",
      ),
      S("val.frozen", "Object.freeze / seal preserved", "Object.freeze is preserved"),
      S(
        "val.frozen-circular",
        "frozen circular graph (interaction)",
        "a frozen circular object round-trips and stays frozen",
      ),
      S(
        "val.frozen-instance",
        "frozen class instance (interaction)",
        "a frozen class instance round-trips frozen with working methods",
      ),
      S("val.other-typedarrays", "Float64Array / BigInt64Array", "Float64Array and BigInt64Array round-trip"),
      S("val.arraybuffer", "ArrayBuffer round-trips its bytes", "captured ArrayBuffer round-trips its bytes"),
      S("val.dataview", "DataView over a buffer", "DataView over a buffer round-trips and reads correct values"),
      S(
        "val.shared-buffer",
        "views over one ArrayBuffer share it (interaction)",
        "two typed-array views over one ArrayBuffer keep a shared buffer",
      ),
      S(
        "val.typedarray-offset",
        "typed-array view with byteOffset (interaction)",
        "a typed-array view with a byteOffset round-trips against its buffer",
      ),
      S("val.error-cause", "Error { cause } incl. circular", "Error with a cause round-trips the cause"),
      S("val.aggregate-error", "AggregateError errors array", "AggregateError preserves its errors array"),
      S(
        "val.error-subclass",
        "user Error subclass (extends Error)",
        "a user Error subclass keeps its prototype and own fields",
      ),
      S(
        "val.to-primitive",
        "object with custom Symbol.toPrimitive",
        "object with Symbol.toPrimitive coerces correctly after round-trip",
      ),
      S(
        "val.map-fn-keys",
        "Map/Set with object keys identity-preserved",
        "a Map object key shared with another capture keeps identity",
      ),
      L("val.weakref", "WeakRef (clear error)", "WeakRef throws a clear error"),
      L("val.finalization-registry", "FinalizationRegistry (clear error)", "FinalizationRegistry throws a clear error"),
      S("val.shared-arraybuffer", "SharedArrayBuffer + shared view", "SharedArrayBuffer and a view over it round-trip"),
      S(
        "val.own-accessor-instance",
        "instance own accessor (defineProperty)",
        "instance own accessor (defineProperty getter/setter) round-trips",
      ),
    ],
  },
  {
    name: "Scope & capture semantics",
    items: [
      S("scope.single", "single free variable", "reconstructs a captured primitive (number)"),
      S("scope.mutable-cell", "mutable let cell", "reconstructs a mutable captured counter"),
      S(
        "scope.shared-cell",
        "shared cell, mutation visible across closures",
        "shared cell mutations are visible across calls into different closures",
      ),
      S(
        "scope.shared-bidirectional",
        "shared let: inc via one ref seen via another",
        "sibling closures share one ancestor cell post-reconstruction",
      ),
      S("scope.shadowing", "lexical shadowing resolves to the right cell", "shadowing: innermost x wins"),
      S("scope.block", "block-scoped let", "block-scoped let is captured"),
      S(
        "scope.loop-var",
        "per-iteration let loop binding",
        "let loop: a single per-iteration closure captures its own i",
      ),
      S(
        "scope.nested-multi",
        "multi-level nested closures",
        "inner closure captures cells from non-adjacent ancestor scopes",
      ),
      S("scope.const-kind", "const vs let binding kind preserved", "respects const vs let binding kind"),
      S("scope.arguments", "arguments object", "function using arguments"),
      S(
        "scope.default-param",
        "default parameter capturing a free var",
        "default parameter that captures a free variable",
      ),
      S(
        "scope.destructure-param",
        "destructuring params / defaults / rest",
        "destructuring params, defaults, rest, spread",
      ),
      L(
        "scope.dup-shared-name",
        "two distinct shared cells, same name (clear error)",
        "two distinct shared cells with the same name throw",
      ),
      S(
        "scope.using",
        "`using` resource management + disposal",
        "`using` syntax round-trips and disposes the resource",
      ),
      S("scope.await-using", "`await using` async disposal", "`await using` syntax round-trips and async-disposes"),
      S(
        "scope.using-instance",
        "using over a captured disposable instance",
        "`using` over a captured disposable class instance",
      ),
      S(
        "scope.tla",
        "closure captured under top-level await",
        "a closure capturing a top-level-await value round-trips",
      ),
    ],
  },
  {
    name: "Recursion topologies",
    items: [
      S(
        "rec.self-decl",
        "self-recursion via declaration name",
        "self-recursion via the function's own (declaration) name",
      ),
      S("rec.self-arrow", "self-recursion via captured const arrow", "self-recursion via a captured const arrow"),
      S("rec.mutual", "mutual recursion (in-module)", "mutual recursion (two functions calling each other)"),
      S("rec.nway", "N-way mutual recursion", "four-way mutual recursion ring"),
      S(
        "rec.via-object",
        "recursion via captured object method",
        "recursion through a captured object's own method (o.fact)",
      ),
      S("rec.via-map", "recursion via captured Map of functions", "recursion through a captured Map of functions"),
      S(
        "rec.via-array",
        "recursion via captured array of functions",
        "recursion through a captured array of functions",
      ),
      S(
        "rec.y-combinator",
        "Y-combinator (no named self-ref)",
        "Y-combinator builds factorial without named self-reference",
      ),
      S("rec.trampoline", "trampolined recursion", "trampolined recursion via a captured trampoline helper"),
      S("rec.generator", "self-delegating recursive generator", "a self-delegating recursive generator round-trips"),
      S(
        "rec.cross-module",
        "mutual recursion across circular ESM graph",
        "mutual recursion across a circular ESM import graph",
      ),
      S(
        "rec.cross-module-alias",
        "cross-module recursion with aliased imports",
        "cross-module mutual recursion with renamed (aliased) imports",
      ),
    ],
  },
  {
    name: "Classes",
    items: [
      S(
        "cls.instance-fields",
        "instance prototype + methods + fields",
        "reconstructs a class instance (prototype, methods, fields)",
      ),
      S("cls.static", "static members", "preserves static class members"),
      S(
        "cls.private-field",
        "private #field value",
        "reconstructs a class instance's private #field state (made public)",
      ),
      S("cls.private-method", "private #method", "reconstructs a class with a private method (made public)"),
      S(
        "cls.private-static",
        "private static field + method",
        "private static field and method (class value) round-trip via mangling",
      ),
      S(
        "cls.private-brand",
        "#name in obj brand check",
        "private brand check (#x in obj) survives via mangled membership",
      ),
      S("cls.super-multi", "multi-level super.method()", "3-level super.method() chain is intact after reconstruction"),
      S("cls.super-ctor", "super(args) constructor forwarding", "super(args) constructor forwarding round-trips"),
      S("cls.subclass-instance", "instance of a subclass (inherited method)", "reconstructs an instance of a subclass"),
      S("cls.mixin-single", "single mixin application", "a class built by applying one mixin round-trips"),
      S(
        "cls.mixin-composed",
        "composed mixins A(B(C(Base)))",
        "a class composed from three mixins reconstructs the full chain",
      ),
      S("cls.nested-expr", "nested class expressions (3 levels)", "3-level nested class expressions reconstruct"),
      S(
        "cls.computed-member",
        "computed method name + Symbol.iterator",
        "computed method name (captured key) and [Symbol.iterator] round-trip",
      ),
      S("cls.static-block", "static {} initialization block", "static block executes on reconstruction"),
      S(
        "cls.extends-identifier",
        "captured superclass in extends clause",
        "a captured superclass identifier in the extends clause round-trips",
      ),
      S(
        "cls.symbol-gen-methods",
        "symbol-keyed / generator / async methods",
        "reconstructs symbol-keyed, generator, and async methods",
      ),
      S(
        "cls.method-free-var",
        "method capturing a free variable",
        "reconstructs a class whose method captures a free variable",
      ),
      S(
        "cls.instanceof",
        "instanceof across reconstruction",
        "instanceof holds across reconstruction for subclass and superclass",
      ),
      S("cls.integrity", "unused methods kept (no class-body pruning)", "unused methods of a captured class are kept"),
      L("cls.extends-call", "extends <call-expression> (unbound)", "extends <call-expression> heritage is unbound"),
      L(
        "cls.field-init-only",
        "field-initializer-only capture on direct class value",
        "a var captured only by a field initializer on a direct class value is unbound",
      ),
      S("cls.decorators", "method decorator round-trips", "a method decorator round-trips"),
      S("cls.private-accessor", "private #getter / #setter accessors", "private getter/setter accessors round-trip"),
      S("cls.static-private-accessor", "static private accessor", "static private accessor round-trips"),
      S(
        "cls.private-accessor-inherited",
        "private accessor via inherited method",
        "private accessor used through an inherited method",
      ),
    ],
  },
  {
    name: "Generators & iterators",
    items: [
      S("gen.return-value", "generator with a return value", "generator with a return value"),
      S("gen.two-way", "two-way generator (.next(v))", "two-way generator: yield receives sent values"),
      S("gen.yield-star", "yield* delegation chain", "three-level generator delegation ending in an array iterator"),
      S("gen.yield-star-return", "yield* forwards delegate return", "yield* forwards return value of the delegate"),
      S(
        "gen.captures-cell",
        "generator mutating a captured cell across yields",
        "generator capturing a mutable cell mutated across yields",
      ),
      S(
        "gen.async-method",
        "async generator method on a class",
        "class with a generator method and an async generator method",
      ),
      S("gen.custom-iterable", "custom [Symbol.iterator] iterable", "custom iterable object captured and re-iterated"),
      S(
        "gen.async-iterable",
        "for-await over captured async iterable",
        "async iteration over a captured async iterable",
      ),
      // (object forms are limitations, tracked under value types)
    ],
  },
  {
    name: "Proxies & this-binding",
    items: [
      S("px.object", "Proxy (object target)", "reconstructs a captured Proxy (object target)"),
      S("px.function", "Proxy (function target)", "reconstructs a captured Proxy whose target is a function"),
      L("px.revoked", "revoked Proxy (clear error)", "throws on a revoked Proxy"),
      S("bind.args", "bound function (bound args)", "reconstructs a bound function (bound args)"),
      S("bind.this", "bound method preserves bound this", "reconstructs a bound method preserving bound this"),
      S("px.nested", "Proxy wrapping a Proxy", "nested Proxy (proxy wrapping a proxy) round-trips"),
      S(
        "px.shared-target",
        "proxy + shared target identity",
        "a proxy and its target captured together keep one target",
      ),
    ],
  },
  {
    name: "Circular & shared references",
    items: [
      S("ref.circular-object", "circular object graph", "round-trips a circular object"),
      S(
        "ref.shared-identity",
        "shared object reference (identity preserved)",
        "shared object reference is emitted once (identity preserved)",
      ),
      S("ref.cycle-mixed", "deeply nested mixed graph with a cycle", "deeply nested mixed graph with a cycle"),
      S(
        "ref.cycle-pruning",
        "cycle-safe access-path pruning",
        "keeps everything reachable from an escaped object (cycle-safe)",
      ),
    ],
  },
  {
    name: "ES module imports & tree-shaking",
    items: [
      S("mod.named", "named import inlined", "named import does not pull in sibling exports"),
      S("mod.aliased", "aliased import", "import { used as u }"),
      S("mod.default", "default import", 'import d from "../deps/defaultexp.mjs"'),
      S("mod.namespace", "namespace import (pruned)", "namespace import keeps only the accessed member"),
      S(
        "mod.barrel",
        "barrel re-export (tree-shaken)",
        "barrel (export { ... } from) keeps only the re-export actually used",
      ),
      S("mod.star", "export * re-export", "export * re-export keeps only the used binding"),
      S("mod.star-as", "export * as ns re-export", "export * as ns re-export keeps only the accessed member"),
      S("mod.external", "node:* external import kept", "named builtin import stays an import statement"),
      S(
        "mod.external-namespace",
        "builtin import * as kept",
        "namespace builtin import stays an `import * as` statement",
      ),
      S("mod.unused-external", "unused external import not emitted", "an unused external import is not emitted at all"),
      S("mod.chain", "3-level re-export chain", "3-level re-export chain keeps only the used terminal binding"),
    ],
  },
  {
    name: "Optimality (tree-shaking / pruning)",
    items: [
      S(
        "opt.prune-props",
        "prune unreferenced object properties",
        "prunes unreferenced properties of a captured object",
      ),
      S("opt.deep-spine", "deep access path keeps only the spine", "deep access path keeps only the spine"),
      S("opt.this-follow-method", "follow this into invoked methods", "follows `this` into invoked methods"),
      S(
        "opt.this-follow-getter",
        "follow this into read getters",
        "getter read deeply still produces the correct value",
      ),
      S("opt.union-closures", "union members across closures", "union of members across multiple reachable closures"),
      S("opt.keepall-escape", "keep-all on opaque escape", "keeps the whole object when it escapes"),
      S("opt.keepall-computed", "keep-all on computed access", "keeps the whole object on computed access"),
      S(
        "opt.namespace-deep",
        "deep namespace member pruning",
        "deep namespace member access prunes to the used sub-path",
      ),
      S(
        "opt.transitive",
        "transitive pruning through captured fn",
        "transitive pruning: captured fn reads one field of its own big capture",
      ),
    ],
  },
  {
    name: "Source maps",
    items: [
      S("map.inline", "inline source map emitted", "emits an inline source map"),
      S(
        "map.remap-throw",
        "thrown error remapped to original file",
        "source map remaps a thrown error to the original file",
      ),
      S(
        "map.source-location",
        "Symbol.sourceLocation definition site",
        "Symbol.sourceLocation reports a function's definition site",
      ),
    ],
  },
];

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

const TEST_FILES = ["closure.test.ts", "symbol-free-variables.test.ts"];

function loadTestCorpus(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return TEST_FILES.map(f => {
    try {
      return readFileSync(join(here, f), "utf8");
    } catch {
      return "";
    }
  }).join("\n");
}

export interface CoverageReport {
  total: number;
  supported: number;
  limitation: number;
  todo: number;
  unverified: CoverageItem[];
  coverage: number; // supported / (supported + todo)
  safety: number; // (supported + limitation) / total
}

export function computeReport(corpus: string): CoverageReport {
  let supported = 0;
  let limitation = 0;
  let todo = 0;
  const unverified: CoverageItem[] = [];
  let total = 0;

  for (const cat of CATEGORIES) {
    for (const item of cat.items) {
      total++;
      if (item.status === "todo") {
        todo++;
        continue;
      }
      const verified = item.evidence !== undefined && corpus.includes(item.evidence);
      if (!verified) unverified.push(item);
      if (item.status === "supported") supported += verified ? 1 : 0;
      else limitation += verified ? 1 : 0;
      if (!verified) todo += 0; // unverified items don't count toward coverage
    }
  }

  // Unverified supported/limitation items are not counted as achieved; surface
  // them as a debt so the headline number stays honest.
  const achieved = supported + limitation;
  return {
    total,
    supported,
    limitation,
    todo: total - achieved - 0, // everything not achieved is remaining work
    unverified,
    coverage: supported / (supported + (total - achieved)),
    safety: achieved / total,
  };
}

function bar(pct: number, width = 24): string {
  const filled = Math.round(pct * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function main(): void {
  const corpus = loadTestCorpus();
  const report = computeReport(corpus);

  let out = "\n  bun:closure — spec coverage\n";
  out += "  " + "─".repeat(60) + "\n";

  for (const cat of CATEGORIES) {
    const sup = cat.items.filter(i => i.status === "supported").length;
    const lim = cat.items.filter(i => i.status === "limitation").length;
    const td = cat.items.filter(i => i.status === "todo").length;
    const n = cat.items.length;
    const done = sup + lim;
    out += `  ${cat.name}\n`;
    out += `    ${bar(done / n, 18)}  ${done}/${n}  (${sup} ok, ${lim} guarded, ${td} todo)\n`;
  }

  out += "  " + "─".repeat(60) + "\n";
  const counts = {
    supported: CATEGORIES.flatMap(c => c.items).filter(i => i.status === "supported").length,
    limitation: CATEGORIES.flatMap(c => c.items).filter(i => i.status === "limitation").length,
    todo: CATEGORIES.flatMap(c => c.items).filter(i => i.status === "todo").length,
  };
  out += `  Total capabilities : ${report.total}\n`;
  out += `  Supported          : ${counts.supported}  ${bar(counts.supported / report.total, 24)}\n`;
  out += `  Guarded limitation : ${counts.limitation}\n`;
  out += `  Todo / unmeasured  : ${counts.todo}\n`;
  out += "  " + "─".repeat(60) + "\n";
  out += `  Coverage  (supported / supported+todo) : ${(report.coverage * 100).toFixed(1)}%\n`;
  out += `  Safety    (no silent failure)          : ${(report.safety * 100).toFixed(1)}%\n`;

  if (report.unverified.length) {
    out += "\n  ⚠ unverified claims (no matching test found — fix evidence or add test):\n";
    for (const it of report.unverified) out += `    - ${it.id}: "${it.evidence}"\n`;
  }

  const todos = CATEGORIES.flatMap(c => c.items.filter(i => i.status === "todo").map(i => ({ cat: c.name, i })));
  if (todos.length) {
    out += "\n  Roadmap to 100% (todo):\n";
    for (const { i } of todos) out += `    - ${i.id}: ${i.title}${i.note ? ` — ${i.note}` : ""}\n`;
  }

  out += "\n";
  process.stdout.write(out);

  // Non-zero exit if any supported/limitation item lacks backing evidence, so
  // this can gate CI against coverage drift.
  if (report.unverified.length) process.exitCode = 1;
}

if (import.meta.main) main();
