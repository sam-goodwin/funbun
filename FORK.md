# Fork: Closure Serialization & JS Introspection Primitives

This fork adds an **experimental closure-serialization** capability to Bun —
the ability to take *any* JavaScript function and produce the source of an ES
module whose `export default` reconstructs that function, including the state it
closes over. To make that possible it introduces a small set of **native
JavaScriptCore introspection primitives** that expose information the language
otherwise hides.

This document explains what was built, why, the design decisions and their
trade-offs, the known limitations, and where this is going next.

Status: **experimental**. Nothing here is stabilized API.

---

## 1. Motivation

Closure serialization — turning a live function (with its captured variables)
back into runnable source — is the foundation for things like shipping a
closure to another process/worker/machine, durable workflows, and code-as-data
systems (think the model used by Cloudflare Workers' RPC or Unison).

`Function.prototype.toString()` gives you the *source* of a function, but not
the *variables it closed over*. A closure is `code + captured environment`;
without the environment you cannot reconstruct it. JavaScript deliberately hides
that environment. The core problem this fork solves is **getting at the hidden
state** — free variables, bound-function internals, Proxy internals, private
fields — and then assembling it back into a self-contained module.

The work is split into two layers:

- **Native primitives** (C++ / JSC bindings): expose hidden state to JS.
- **The `bun:closure` JS module**: the serializer, built on those primitives.

The native surface is kept deliberately small; the serializer logic lives in JS
(`src/js/bun/closure.ts`) because in debug builds JS builtins load from disk
(`BUN_DYNAMIC_JS_LOAD_PATH`), so it iterates without a native relink.

---

## 2. Native primitives

All four are implemented in `src/jsc/bindings/ZigGlobalObject.cpp` and registered
as well-known-style symbols (a registered symbol on the relevant prototype, plus
the matching `Symbol.<name>` on the `Symbol` constructor). They are
`DontEnum`/`ReadOnly` accessors.

### `fn[Symbol.freeVariables]`  → `Array<{ name, id, scopeId, value, kind }>`

The headline primitive. Returns the variables a closure captures from enclosing
scopes.

- **Mechanism.** JSC only heap-allocates a captured variable into a scope
  environment when some closure (at any depth) closes over it. The getter
  statically scans the function's **unlinked** bytecode (recursing through nested
  functions via `unlinkedCodeBlockFor`), gathers the referenced identifiers from
  each code block's identifier table, then resolves each name against the
  function's **live** scope chain (`JSScope`/`JSLexicalEnvironment`/
  `JSModuleEnvironment` symbol tables, nearest-first), stopping at the global
  object. A name that resolves to a captured environment is a free variable; one
  that resolves to a true global or a module import is *ambient* and excluded.
- **`id`** identifies the underlying variable *cell* — packed as
  `environmentId * 2^20 + scopeOffset`. Two closures that close over the same
  variable share the same environment instance, so they observe the same `id`.
  This is what lets a serializer represent a shared mutable binding once and have
  multiple closures reference it. `scopeId` is the environment id alone.
- **id stability.** Backed by `Bun::FreeVariableIdTable`
  (`src/jsc/bindings/BunFreeVariableIdTable.h`), a GC-aware
  (`WeakHandleOwner` + finalizer) map of `environment -> monotonic id`. WeakGCMap
  is weak-on-value, which is the wrong polarity here, so a manual `Weak` +
  finalizer side table is used so a freed-then-reused environment can never
  inherit a stale id.
- **`kind`** is `"const"` (read-only) or `"let"`; `var`/parameters aren't
  distinguished from `let` after compilation.
- **Folded constants.** `const x = 42` with a compile-time-constant initializer
  is inlined into the bytecode by JSC and never gets a cell, so it doesn't appear
  (it travels with the code, which is correct for serialization).

Why a *transitive superset* rather than a precise per-body set: a function can
spawn nested closures that use more variables than its own body references. JSC's
capture analysis is already transitive — the environment *is* the set you must
serialize. A precise per-body scan would under-report and break the restored
closure.

### `fn[Symbol.boundFunction]` → `{ target, boundThis, boundArgs } | undefined`

Bound functions (the result of `Function.prototype.bind`) stringify as
`[native code]`, hiding what they wrap. This reads JSC's `JSBoundFunction`
internals so the serializer can reconstruct `target.bind(boundThis, ...args)`.

### `fn[Symbol.sourceLocation]` → `{ url, line, column } | undefined`

Where a function was defined (1-based), from its `FunctionExecutable::source()`.
Foundation for source maps (and, longer term, for handing back the AST node).
`undefined` for native functions.

### `obj[Symbol.privateFields]` → `Array<{ name: "#x", value }>`

Reads an object's own `#private` instance fields — otherwise completely invisible
to reflection — via `getOwnPropertyNames` with `PrivateSymbolMode::Include` +
`getDirect`, filtering to private-symbol data properties. Lets the serializer
snapshot a class instance's private state. (Private *methods* are excluded; they
come from the class source.)

### Proxy internals — *no native code needed*

JSC already exposes `$isProxyObject` / `$getProxyInternalField` /
`$proxyFieldTarget` / `$proxyFieldHandler` as builtin intrinsics (used by
`util.inspect`), so Proxy unwrapping is done purely in JS.

---

## 3. `bun:closure` — the serializer

`import { serialize } from "bun:closure"`

`serialize(fn, replacer?) -> string` returns the source of an ES module whose
`export default` reconstructs `fn`. The replacer is JSON.stringify-style:
`(key, value) => newValue`, applied to every captured value, object property, and
array element; returning `undefined` omits an object property.

Implementation: `src/js/bun/closure.ts`. Registered as a builtin module in
`src/resolve_builtins/HardcodedModule.rs` (the one hand-edit required to add a
`bun:*` module; the bundled JS + generated registry are produced by codegen).

### Output model

```
<hoisted shared cells / object & function refs>
export default <reconstruction of fn>
//# sourceMappingURL=data:application/json;base64,...
```

The hoisted prelude declares captured state; the export is the function source
re-bound to that state.

### Core mechanisms

1. **Free-variable reconstruction.** Each captured cell becomes a binding the
   function source references by name. Primitive values are emitted as literals
   (`NaN`/`Infinity`/`-0`/bigint handled).

2. **Reference graph.** Objects/arrays are hoisted as `const` declarations,
   deduplicated by identity (a `Map<value, name>`), with cycles handled by
   recording the ref *before* filling properties (so a self-reference resolves to
   the already-declared name). Property descriptors are used (not `Object.keys`),
   so getters/setters stay live, non-enumerable/non-writable flags survive, and
   registered/well-known symbol keys round-trip.

3. **Per-function IIFE isolation.** Free-variable *names* aren't unique across
   functions (one function's `x` ≠ another's). Each function is reconstructed
   inside its own IIFE that declares its captured variables, so same-named
   captures in different functions don't collide.

4. **Shared cells.** A cell referenced by 2+ functions (matched by
   `freeVariables` id) is hoisted *once* to module scope under its original name,
   so every function closes over the same binding — mutations stay shared (the
   `inc`/`read`-over-a-counter case).

5. **Recursion & mutual recursion.** A function that references itself or another
   function does so via a free variable, and an IIFE-`const` binding can't
   forward-reference the resulting cycle (TDZ). A pre-pass builds the capture
   graph and detects functions in a reference cycle (self-loops and longer);
   their cells are hoisted to module scope by name (like shared cells), so the
   functions reference each other live.

6. **Prototypes / classes.** A class instance is reconstructed via
   `Object.create(<Class>.prototype)` so its methods, prototype chain, and
   `instanceof` survive; the class itself is serialized once. `extends
   <Identifier>` is recovered from `Object.getPrototypeOf(class)` (it isn't a
   free variable). Class *method* free variables aren't reported by the
   constructor's `Symbol.freeVariables`, so the serializer unions in each method's
   own free variables.

7. **Private members.** With the chosen fidelity trade (private → public), the
   class source has its `#name` members rewritten to mangled public members (a
   source-aware scanner that skips strings, template text, and comments), and a
   reconstructed instance's private-field values (from `Symbol.privateFields`)
   are assigned to the matching mangled keys. Private methods become public
   methods and keep working.

8. **Built-ins / Proxy / bound functions.** Date, RegExp, Map, Set, typed
   arrays, and Error are reconstructed with their constructors; Proxies as
   `new Proxy(target, handler)`; bound functions as `target.bind(...)`.

9. **Source maps.** Each reconstructed function's verbatim source is tracked to
   its generated-line range and mapped back to its original file
   (`Symbol.sourceLocation`); an inline v3 source map (VLQ) is appended covering
   every contributing file. Columns are accurate: because the source is emitted
   verbatim, the first line maps to the function's definition column and each
   body line keeps its original indentation (one segment per line at the
   content-start column — see the granularity note in §5). Bun now *chains* this
   map at runtime (§6), so a frame inside a reconstructed function — and
   `Symbol.sourceLocation` of it — resolves to the original source, not the
   reconstructed module.

### What round-trips (tested)

Coverage is tracked objectively — **`bun run closure:coverage`** prints a
capability manifest (~230 items) where each "supported" claim names a test whose
text must exist, so the number can't drift. Current state: **225 supported, 5
guarded limitations, 100% coverage / 100% safety** (every case either round-trips
or fails with a clear error — never silent corruption).

- **Values:** primitives (incl. `-0`/`NaN`/`Infinity`/bigint); plain/nested/null-
  prototype objects; arrays (incl. sparse + holes); cycles & shared references
  (identity preserved); `Date`/`RegExp`/`Map`/`Set`; **all typed arrays +
  `DataView` + `ArrayBuffer`/`SharedArrayBuffer`** (views over one buffer keep a
  **shared buffer**); **boxed primitives**; **`Error`** (incl. `cause`,
  `AggregateError.errors`, subclasses, custom fields); **`Object.freeze`/seal**
  (incl. frozen built-ins & frozen cycles); **unique symbols** (recreated, intra-
  closure identity preserved); registered & well-known symbols.
- **Weak collections & settled promises** (native snapshot): **`WeakMap`/
  `WeakSet`** (live-entry snapshot), **`WeakRef`** (live referent), **`Finalization
  Registry`** (callback + registrations), **fulfilled/rejected Promises**.
- **Functions & classes:** nested functions, shared mutable cells, recursion &
  mutual recursion (incl. **cross-module circular** import graphs); bound
  functions; **native built-ins referenced by global path** (`Math.max`,
  `Array.prototype.slice`, `console.log`, …); class values/instances/inheritance/
  `super`/statics/getters/setters/private fields & methods/`#x in obj`/static
  blocks/computed members; **mixins** & **computed `extends`** (`extends
  mixin(Base)`); **built-in subclasses** (`extends Array/Map/Set`,
  `instanceof` preserved); extracted method refs; generators & async generators;
  **`using`/`await using`**; **field-initializer closure captures** (via AST +
  native scope resolution); a method **decorator**.
- **Modules:** named/aliased/default/namespace imports, barrels, `export *` /
  `export * as`, re-export chains, node:* externals kept — all member-pruned.
- **Optimality:** access-path pruning (`a.b` serializes `b`, not `a`),
  this-following into methods & getters, namespace member pruning.
- **AsyncLocalStorage:** see §3.1.
- **Revoked Proxy** reconstructs as a revoked proxy. **Source maps** stay correct
  through every transform (private-rewrite, heritage rewrite, import re-emit, ALS
  wrap).

### 3.1 AsyncLocalStorage — capturing the active context

A captured `AsyncLocalStorage` instance is treated **opaquely** (its native
internals — e.g. Bun's `jsCleanupLater` cleanup callback — are never walked, in
`analyzeSharedCells` / `computeKeepSets` / `keepAll` / `emitValue`) and
reconstructed as a fresh `new AsyncLocalStorage()`.

The interesting part is the **async context**: serializing a closure *inside*
`als.run(store, …)` snapshots the active store and wraps the reified root so each
call re-enters `als.run(store, …)`. So the closure, shipped elsewhere and reified,
sees the same store from `als.getStore()`:

```js
als.run({ user: "alice" }, () => serialize(() => als.getStore().user))
//  → reify in another process → fn() === "alice"
```

It composes: nested runs capture the **innermost** store; the context survives
across `await`s in a reified async closure (and through promise continuations);
multiple ALS instances each capture their own; concurrent runs stay independent;
the store is snapshotted **by value** (later mutation doesn't leak; cycles &
cross-links preserved; a store object that's *also* a captured free variable
reconstructs as one object). The wrapper applies only to plain/async function
roots — a **class** root (would break `new`) or **generator** root (body iterates
after `run` returns) reconstructs gracefully *without* context restoration.

---

## 4. Key design decisions

- **Small native surface, JS serializer.** Only what JS can't see goes native.
  The serializer is JS for fast iteration (debug loads builtins from disk).
- **Superset, not precise capture** (§2) — correctness over minimalism.
- **Cell identity drives sharing.** The `id` is the linchpin: shared mutable
  state, recursion, and mutual recursion are all "is this the same cell?"
  questions.
- **Fail loud, not lossy.** Anything that can't be faithfully serialized (a
  pending Promise, a live generator object) throws a clear error instead of
  emitting something subtly wrong — the `closure:coverage` "Safety" metric tracks
  that every case either round-trips or errors cleanly (currently 100%).
- **Private → public is an explicit, opt-in fidelity trade**, chosen with the
  user, because `#private` cannot be written from outside its class.

---

## 5. Known limitations

The 5 remaining guarded limitations (each fails with a **clear error**, never
silent loss):

- **Pending Promise** — genuinely impossible: its resolution lives in the event
  loop (live I/O / timers / a suspended async frame), not expressible as source.
  *Settled* promises round-trip.
- **Generator / async-generator / iterator objects** — a live generator object
  holds suspended execution state (the yield point + local frame) in engine slots
  that aren't reachable via reflection and can't be expressed as source. The
  generator *function* round-trips; the live *object* throws. (The hardest
  remaining item; would need bytecode-level frame transplant.)
- **Two distinct shared cells with the same name** — both hoist to module scope
  under their original name and collide; throws. Could be fixed by mangling.

Other notes:

- **Field-initializer captures now work** (AST + native `$resolveClosureBinding`),
  *except* a computed key `[expr]` capturing a closure var (consumed at class-
  definition time, not in the class's runtime scope).
- **Native functions** are referenced by their globalThis path; only a native
  with *no* global path (a true engine-internal) still errors.
- **AsyncLocalStorage** context restoration applies to plain/async function roots
  only (§3.1).
- **String-based transforms are regex/scanner-driven** — fragile at the edges;
  the main motivation for the AST direction in §7.
- **Source-map column granularity is line/statement-level, not per-token.** The
  emitted map carries one segment per generated line, at that line's content-start
  column (the function-definition column on the first line; the indentation on
  body lines). Those positions are *exact*, and they are where stack frames
  normally sit (statement / call boundaries). But a frame that lands in the
  *middle* of an expression snaps back to the statement start, because we emit no
  segment there and source-map consumers (Bun, V8, browsers) return the
  at-or-before segment without interpolating. This is a deliberate serializer
  choice: the source is copied **verbatim** rather than tokenized, so there are no
  token boundaries to place finer segments at.
  **Future improvement:** tokenize the emitted source (a small JS tokenizer, or
  reuse `Bun.Transpiler`'s tokens) and emit a segment per token for full
  per-column accuracy — the standard way bundlers achieve it, since they already
  hold tokens while printing. Worth it only if mid-expression frame columns
  matter; the common stack-trace case (statement/call positions) is already
  exact.

---

## 6. Landed: chaining a loaded module's own source map

Originally this fork did **not** apply a loaded file's own source map: a frame
inside a reconstructed closure (a `throw` in the reified function) resolved to
the **reconstructed module**, not the original source. That gap is now closed —
stack traces and `Symbol.sourceLocation` survive serialization.

**How Bun already handled maps.** Bun reprints *every* loaded module and stores a
generated→thisFile map keyed by path (`put_mappings`); stack resolution and
`Symbol.sourceLocation` both funnel through `resolve_mapping`. This is why a `.ts`
run directly shows `.ts` positions — the AST nodes carry their original `.ts`
offsets, so the generated map points there. For a plain `.js`/`.mjs` the map is
identity, and the file's *own* `//# sourceMappingURL=` (pointing somewhere else)
was parsed into `lexer.source_mapping_url` and then dropped.

**The fix — chain at resolve** (commits in §10):

1. **Carry the pragma to the AST** (`Ast.source_mapping_url`, populated in
   `to_ast`). The lexer already scans line-comment pragmas via
   `scan_single_line_comment`.
2. **Store the input map** at transpile, keyed by the same source path as the
   generated map (both the sync `jsc_hooks` and async `RuntimeTranspilerStore`
   paths, including their **cache-hit** branches — re-scanned from the raw source
   there). Inline `data:` maps are decoded eagerly; an external `.map` reference
   is resolved to a path and read **lazily** on the first symbolication.
3. **Chain in `resolve_mapping`**: after the base lookup (generated→thisFile),
   look the result up in the stored input map (thisFile→original) via the same
   column-accurate `find_mapping`, returning the chained mapping with the input
   map as the source — so `display_source_url_if_needed` renames the frame. One
   chokepoint, so stack traces *and* `Symbol.sourceLocation` (its
   `Bun__resolveSourceMapPosition` now also returns the remapped filename) both
   chain.

Two general parser fixes fell out, each independently correct and tested:

- **`parse_url`** rejected `data:application/json;charset=utf-8;base64,` (what
  tsc/esbuild/webpack/bun:closure emit) because it compared the whole header
  against `"base64"` instead of scanning `;`-separated segments.
- **`parse_json`** *required* `sourcesContent` and that its length equal
  `sources`, rejecting spec-valid maps that omit it (tsc, the closure serializer).
  `sourcesContent` is now optional per the v3 spec.

Verified by `test/js/bun/sourcemap/runtime-inline-sourcemap.test.ts` (charset /
plain / no-`sourcesContent`, all fail on `USE_SYSTEM_BUN`) and the chaining tests
in `closure.test.ts` (inline stack frame, `Symbol.sourceLocation` url+line,
node_modules external `.js.map`).

Note: external `.map` loading is currently ungated (Bun maps by default) and only
touches disk on symbolication; when a `--enable-source-map` CLI flag lands it
should gate that disk read.

---

## 7. Where this is going: expose the full AST to JS

The string-based transform layer (method-shape detection, `extends` extraction,
`#private` rewriting, native-function detection) is regex/scanner-driven and
fragile — and it can't do scope-aware work like alpha-renaming. The intended
direction is to **expose Bun's real JS AST to JavaScript**.

Bun already has the full parser/printer/AST internally (`src/js_parser`,
`src/js_printer`, `src/ast`) used for transpiling and bundling, but it is *not*
exposed structurally to JS today (`Bun.Transpiler` only transforms/scans). The
plan is to surface the AST so JS can:

- Replace every regex/scanner transform with correct, scope-aware AST operations.
- Do **static analysis** — e.g. determine which methods of a given object a
  function actually calls (call-graph extraction), which informs *precise*
  capture, dead-code elimination of unused captured members, and security
  review of serialized closures.
- Enable proper **alpha-renaming**: rename every free variable to a unique
  module-scope name. That would *structurally dissolve* most of the current
  machinery and the §5 limitations — no name collisions, no IIFE isolation,
  recursion/mutual-recursion/field-initializer captures all fall out for free.

This is the next major piece of work and is intentionally a larger, separate
effort (the internal AST is bundler-shaped, not a clean ESTree, so the JS-facing
shape needs design).

### 7.1 Landed: `Bun.Transpiler.prototype.ast(code, loader?)`

The first slice of §7 is implemented: `new Bun.Transpiler().ast(code)` parses a
source string with Bun's native parser and returns the AST as a tree of plain
JS objects — `{ type, start, ...fields }`, recursively expanded. It covers
identifiers, literals, member/index/call/new, unary/binary/conditional,
array/object/spread, arrow/function, and full classes (methods, fields,
accessors, statics, `#private`). Unmapped node kinds surface as
`{ type: "Unsupported", node }` so a walk never panics; coverage grows
incrementally. `ast()` forces dead-code-elimination / minify / tree-shaking
**off** around the parse so the AST is faithful (pure unused statements and
constant folds aren't dropped). Lives in `AstJsConverter`
(`src/runtime/api/JSTranspiler.rs`); registered via `JSBundler.classes.ts`.

Two findings shaped the scope:

- **Bun's parser erases TypeScript types** (annotations/interfaces/aliases are
  skipped, never stored), so this is a **JS-level** AST. A type-level AST at
  runtime is not reachable through Bun's parser — it would need the TS compiler.
- **Bun discards the AST after loading a module** (parse → print JS → free
  arena). So any runtime AST means a **re-parse**; there is no retained AST to
  hand back, and `fn.toString()` is post-transpile JS.

### 7.2 Landed: source-map-aware positions

Building on §6: `fn[Symbol.sourceLocation]` previously reported the
transpiled-JS position (e.g. line 1) rather than the original source (e.g.
`.ts` line 6) — unlike stack traces, which Bun *does* remap. It now routes the
executable's position through the module's registered source map via a new host
export `Bun__resolveSourceMapPosition` (wrapping
`VirtualMachine::resolve_source_mapping`, the same machinery stack-frame
remapping uses), falling back to the raw position when no map is registered.
This is the position-mapping foundation for the value-level `fn[Symbol.ast]`
accessor (every AST node's position will resolve to the original source the
same way).

The remaining work for `fn[Symbol.ast]`: take a function/method/class value,
re-parse its own source (form-aware), and attach each node's original-source
position via the same source map.

### 7.3 Landed: more AST coverage — imports and destructuring

`AstJsConverter` gained two node families the serializer needs:

- **`ImportDeclaration`** — `{ source, specifiers: [{ type: "ImportSpecifier",
  local, imported } | "ImportDefaultSpecifier" | "ImportNamespaceSpecifier" ] }`.
  `local` is the binding, `imported` the exported name (matching how the printer
  emits `<alias> as <local>`). Used to recover a closure module's import bindings.
- **Destructuring patterns** — `ArrayPattern` / `ObjectPattern` (with
  `AssignmentPattern` for `= default`), so params and declarators like
  `({ a, b: c }, [x]) => …` and `const [x, y] = …` are represented instead of
  `UnsupportedBinding`. (Without this, the serializer's reference scan
  mis-classified destructured names as unresolved.)

### 7.4 Landed: access-path pruning

`serialize()` now serializes only the members of a captured object the closure
actually references. `computeKeepSets` (in `closure.ts`) parses each reachable
function via `Bun.Transpiler.ast`, builds a per-free-variable **access tree**
(which property paths are read, whether the variable escapes), **follows `this`**
into invoked methods (`foo.m()` → whatever `m` reads via `this` is kept), and maps
that onto values → a `keepSet` consumed by `emitOwnProperties`.

Sound by construction: any use that can't be proven a clean static read — a bare
reference, computed `foo[x]`, passing/returning/destructuring, or a method using
`this` opaquely — falls back to serializing the whole value, and keep-all
propagates transitively so an escaped object's contents are never pruned by a
nested closure's narrower view. So `() => foo.method()` serializes only
`foo.method` (plus what the method reads via `this`), not all of `foo`.

### 7.5 Landed: imports — the runtime-inline serializer

The largest addition, and the one that retires most of the open problems above.
Originally `serialize()` **dropped imports**: a closure referencing an imported
binding produced a module that threw `"x is not defined"`. Two approaches were
explored:

- A **bundler-backed `bundle()`** (async) routing the closure through `Bun.build`
  to resolve / inline / tree-shake imports. It works and is committed, but
  inherits the static bundler's limits — notably that `export * as` namespace
  re-exports aren't member-tree-shaken (characterized by tests in
  `test/bundler/bundler_barrel.test.ts`).
- The chosen approach: **runtime-inline.** At runtime we hold the *actual values*
  and the *actual access paths*, which is finer than any static tree-shaker — and
  makes the entire barrel / `export *` / namespace-materialization problem moot,
  because we read values rather than bundling modules.

**Native enabler** (`functionFreeVariablesGetter`, `ZigGlobalObject.cpp`): a
named/default import has *no slot* in the importing module's environment — JSC
resolves it to read from the *exporting* module. So when a referenced name in a
`JSModuleEnvironment` isn't a local slot, the resolver now follows
`moduleRecord()->resolveImport()` (which chases re-export/star chains to the
terminal binding), reads the value from the exporting module's environment
(TDZ-guarded), and emits the descriptor tagged with
`import: { source, importedName, kind, external }`. `external` (node:* / builtin /
synthetic — classified via `JSModuleRecord` + `Bun::isBuiltinModule`) marks
bindings with no serializable source. Namespace imports (`import * as ns`) keep
flowing through the existing local-slot path; `emitObject` detects a
`[object Module]` namespace and emits only its access-path-pruned members,
skipping the exotic prototype (which otherwise reaches native built-ins).

**JS side** (`closure.ts`): inlinable imports serialize their value like any
captured variable (so §7.4 pruning applies — `a.b` keeps `b`, not `a`); `external`
imports are re-emitted as `import` statements at the top of the module, with the
source map offset by the leading lines so it stays correct.

Net result — all in **sync `serialize()`, no bundler, source maps intact**:
`serialize(p => alpha() + basename(p))` (with `alpha` from a user module and
`basename` from `node:path`) inlines `alpha`, tree-shakes the module's unused
exports, keeps `import { basename } from "node:path"`, and round-trips. This makes
`bundle()` largely redundant and makes the `export *` namespace-tree-shaking
linker work unnecessary for the serializer.

---

## 8. File map

Native (require a build + relink):

- `src/jsc/bindings/ZigGlobalObject.cpp` — the four `Symbol.*` accessors +
  registration; `collectReferencedIdentifiers` (free-variable bytecode scan).
- `src/jsc/bindings/BunFreeVariableIdTable.h` — GC-aware env→id table.
- `src/jsc/bindings/ZigGlobalObject.h` — the id-table member.
- `src/resolve_builtins/HardcodedModule.rs` — registers `bun:closure`.

JS / types (reload from disk in debug; no relink):

- `src/js/bun/closure.ts` — the serializer.
- `packages/bun-types/{closure.d.ts, globals.d.ts, index.d.ts}` — public types
  for `serialize` and the `Symbol.*` primitives.

Tests:

- `test/js/bun/symbol-free-variables.test.ts` — the freeVariables primitive.
- `test/js/bun/closure.test.ts` — the serializer (round-trips + characterizations).
- `test/integration/bun-types/fixture/{closure,symbol-free-variables}.ts` — type checks.

---

## 9. Building this fork (macOS notes)

This fork was developed on a machine that needed:

- `brew install llvm@21 cmake ninja` (Bun requires clang ≥ 21).
- Homebrew clang ignores `SDKROOT` (its baked default SDK doesn't exist here), so
  exports of `CPATH=$SDK/usr/include` and `LIBRARY_PATH=$SDK/usr/lib` are needed
  for host-tool compiles.
- The Command Line Tools linker (ld-1115) hits `ld: pointer not aligned` on the
  Rust staticlib with the default `-ld_new`, so the final link is redone with
  `-Wl,-ld_classic`. (`bun bd` compiles fine but fails at the final link; relink
  manually with the classic linker, or run `./build/debug/bun-debug` directly.)
- JS-only changes to `src/js/bun/closure.ts` don't need a relink: regenerate the
  bundled JS (`ninja -C build/debug codegen/InternalModuleRegistryConstants.h`)
  and rerun; the debug binary loads builtin JS from disk.

---

## 10. Commit history

Developed incrementally (each step implemented, tested, committed):

- `Symbol.freeVariables`: primitive → transitive capture + module scope + scopeId
  → property-name over-inclusion characterization.
- `bun:closure` steps 1–9: source passthrough → primitives → reference graph →
  nested functions → shared cells → replacer → built-ins → Proxy/method-shorthand
  → bound functions → source maps; then types.
- Expansion: property descriptors → prototypes/instances → inheritance → class
  method/static/getter captures → method-shape generalization →
  field-initializer limitation → private fields (made public) → method references
  → recursion & mutual recursion → comprehensive coverage (symbols, sparse
  arrays, cross-module, exotic syntax) → unserializable rejection + `async*` fix.
