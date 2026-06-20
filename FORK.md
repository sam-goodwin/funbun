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
   (`Symbol.sourceLocation`); an inline v3 source map (VLQ, line-granularity) is
   appended covering every contributing file. **Caveat:** Bun itself does not
   currently *apply* a loaded file's own source map to stack traces (see §6), so
   these maps presently help external tools, not Bun's own error formatting.

### What round-trips (tested)

Closures with captured primitives/objects/arrays (incl. cycles & shared refs);
nested functions; shared mutable cells; recursion & mutual recursion; the
replacer; Date/RegExp/Map/Set/typed-arrays/Error; Proxies; bound functions;
class values/instances/inheritance/statics/getters/setters/private-fields;
extracted method references (generator/async/symbol-keyed methods); registered &
well-known symbols; sparse arrays; cross-module captures; generators & async
generators; and a broad swath of body syntax (destructuring/defaults/rest/spread,
optional chaining/nullish, template & tagged templates, regex, try/catch/finally,
labeled loops, switch, `arguments`, async iteration). WeakMap/WeakSet/Promise and
unique symbols throw clear errors rather than silently losing data.

---

## 4. Key design decisions

- **Small native surface, JS serializer.** Only what JS can't see goes native.
  The serializer is JS for fast iteration (debug loads builtins from disk).
- **Superset, not precise capture** (§2) — correctness over minimalism.
- **Cell identity drives sharing.** The `id` is the linchpin: shared mutable
  state, recursion, and mutual recursion are all "is this the same cell?"
  questions.
- **Fail loud, not lossy.** Anything that can't be faithfully serialized
  (WeakMap, Promise, unique symbol, native function) throws a clear error instead
  of emitting something subtly wrong.
- **Private → public is an explicit, opt-in fidelity trade**, chosen with the
  user, because `#private` cannot be written from outside its class.

---

## 5. Known limitations

- **Field-initializer-only captures.** A variable captured *only* by a class
  field initializer (no method references it), on a class captured as a direct
  value, can't be recovered — the class's member executables aren't reachable
  from the class constructor that `Symbol.freeVariables` operates on. Workaround:
  capture the class's factory, or reference the variable in any method. (Common
  patterns are unaffected.)
- **Decorators** aren't part of `Function.prototype.toString()`, so they aren't
  preserved.
- **Source-map application** (§6).
- **The string-based transforms are regex/scanner-driven** and therefore
  fragile at the edges (e.g. `#` inside a regex literal). This is the main
  motivation for the AST direction in §7.

---

## 6. Out of scope (found, not fixed): Bun ignores loaded files' source maps

While testing source maps we found that **Bun does not apply a loaded file's own
source map** — neither an external `.js.map` nor an inline
`//# sourceMappingURL=data:` — to stack traces. Running a `.ts` directly works
(Bun's internal transpile maps), but loading a pre-built `.js` shows the `.js`
position, unmapped. The resolution logic *exists* in `src/sourcemap/lib.rs`
(`get_source_map_impl`: scans for `sourceMappingURL`, decodes `data:` URLs,
loads external `.map` JSON), but external loading is gated behind
`SourceProvider::HAS_SOURCE_MAP_JSON` (true only for the bake dev-server
provider), and the inline path isn't reached for plain loaded `.js`. The store is
`src/jsc/SavedSourceMap.rs`; transpiled files register via `put_mappings`. This
is a core-runtime fix, deliberately left out of this fork's scope.

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
