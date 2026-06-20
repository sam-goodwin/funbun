import { test, expect } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";

// Experimental primitive: `fn[Symbol.freeVariables]` returns an array of
// descriptors — { name, id, scopeId, value, kind } — for the variables a
// closure (or any closure nested within it) transitively captures from an
// enclosing scope. `id` identifies the underlying variable cell (environment
// instance + slot); two closures over the same variable observe the same id.
// `const` bindings folded to a compile-time constant never get a cell and so do
// not appear; true globals and module imports are excluded.
const freeVariables = Symbol.freeVariables;

type Descriptor = { name: string; id: number; scopeId: number; value: any; kind: "const" | "let" };

function byName(fn: Function): Record<string, Descriptor> {
  const out: Record<string, Descriptor> = {};
  for (const d of (fn as any)[freeVariables] as Descriptor[]) out[d.name] = d;
  return out;
}

test("Symbol.freeVariables is a symbol exposed on the Symbol constructor", () => {
  expect(typeof freeVariables).toBe("symbol");
  expect(String(freeVariables)).toBe("Symbol(Symbol.freeVariables)");
});

test("returns an array of {name, id, scopeId, value, kind} descriptors", () => {
  function make() {
    let x = 42;
    return () => x;
  }
  const captured = (make() as any)[freeVariables] as Descriptor[];
  expect(Array.isArray(captured)).toBe(true);
  expect(captured).toHaveLength(1);
  expect(captured[0]).toEqual({
    name: "x",
    id: expect.any(Number),
    scopeId: expect.any(Number),
    value: 42,
    kind: "let",
  });
});

test("only transitively-referenced variables are captured (siblings excluded)", () => {
  function make() {
    let a = 1;
    let b = 2; // captured by sibling `other`, but NOT referenced by the returned closure
    const other = () => b;
    void other;
    return () => a;
  }
  const vars = byName(make());
  expect(vars.a.value).toBe(1);
  expect(vars.b).toBeUndefined();
});

test("cells in the same scope share a scopeId; id packs it", () => {
  function make() {
    let a = 1;
    let b = 2;
    return () => a + b;
  }
  const vars = byName(make());
  expect(vars.a.scopeId).toBe(vars.b.scopeId);
  expect(vars.a.id).not.toBe(vars.b.id);
});

test("kind reflects const vs non-const", () => {
  function make() {
    let mut = 1;
    const ref = { a: 2 }; // const object reference is captured (computed init)
    return () => mut + ref.a;
  }
  const vars = byName(make());
  expect(vars.mut.kind).toBe("let");
  expect(vars.ref.kind).toBe("const");
});

test("two closures over the same variable share one id", () => {
  function counter() {
    let i = 0;
    const inc = () => {
      i++;
    };
    const read = () => i;
    return { inc, read };
  }
  const c = counter();
  c.inc();
  const incI = byName(c.inc).i;
  const readI = byName(c.read).i;
  expect(incI.value).toBe(1);
  expect(readI.value).toBe(1);
  // Same underlying cell -> same id.
  expect(incI.id).toBe(readI.id);
});

test("separate activations of the same function get distinct ids", () => {
  function counter() {
    let i = 0;
    return () => i;
  }
  const a = counter();
  const b = counter();
  expect(byName(a).i.id).not.toBe(byName(b).i.id);
});

test("distinct variables in the same scope get distinct ids", () => {
  function make() {
    let a = 1;
    let b = 2;
    return () => a + b;
  }
  const vars = byName(make());
  expect(vars.a.id).not.toBe(vars.b.id);
});

test("compile-time-constant `const` bindings are folded and not captured", () => {
  function make() {
    const x = 42;
    const s = "hi";
    return () => x + (s as any);
  }
  expect((make() as any)[freeVariables]).toEqual([]);
});

test("a closure that captures nothing has no free variables", () => {
  function make() {
    return () => 5;
  }
  expect((make() as any)[freeVariables]).toEqual([]);
});

test("reflects the current (live) value of a captured binding", () => {
  function counter() {
    let n = 0;
    const inc = () => {
      n++;
    };
    const get = () => n;
    inc();
    inc();
    return get;
  }
  expect(byName(counter()).n.value).toBe(2);
});

test("inner scope shadows an outer binding of the same name", () => {
  function outer() {
    let x = "outer";
    void x;
    return function middle() {
      let x = "inner";
      return () => x;
    };
  }
  const vars = byName(outer()());
  expect(vars.x.value).toBe("inner");
});

test("captures variables transitively used by a nested closure", () => {
  // `outer`'s body never references x; only a doubly-nested closure does.
  // JSC's capture analysis is transitive, so x is still in the environment.
  function outer() {
    let x = 1;
    return () => () => x;
  }
  expect(byName(outer()).x.value).toBe(1);
});

test("native functions have no free variables", () => {
  expect((Math.max as any)[freeVariables]).toEqual([]);
});

// Characterization test for a known limitation (NOT desired behavior): the
// identifier-table approach can't tell a variable reference from a same-named
// property access, so a captured variable whose name only appears as a property
// access is still reported. Over-inclusion is the safe direction for
// serialization. If this is ever made precise, update this test.
test("over-includes a captured name used only as a property access (documented limitation)", () => {
  function make() {
    let value = 1;
    const reader = () => value; // forces `value` to be heap-allocated (captured)
    void reader;
    return (obj: any) => obj.value; // references "value" only as a property name
  }
  const propUser = make() as any;
  expect(byName(propUser).value?.value).toBe(1);

  // Control: with no name collision, nothing is captured.
  function control() {
    let value = 2;
    const reader = () => value;
    void reader;
    return (obj: any) => obj.other;
  }
  expect((control() as any)[freeVariables]).toEqual([]);
});

test("module-level captured variables are included; imports and globals are excluded", async () => {
  using dir = tempDir("free-vars-module", {
    "dep.js": `export const imported = "IMPORTED";`,
    "main.js": `
      import { imported } from "./dep.js";
      let i = 0;
      let unused = "nope";
      const fn = () => { i += 1; return imported; };
      fn();
      fn();
      const vars = fn[Symbol.freeVariables];
      console.log(JSON.stringify(vars.map(d => ({ name: d.name, value: d.value, kind: d.kind }))));
      console.log(JSON.stringify(typeof vars[0]?.scopeId));
    `,
  });

  await using proc = Bun.spawn({
    cmd: [bunExe(), String(dir) + "/main.js"],
    env: { ...bunEnv, BUN_DEBUG_QUIET_LOGS: "1" },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  const lines = stdout.trim().split("\n");

  // `i` is a referenced module-level variable; `unused` (not referenced), the
  // `imported` import, and the `console`/`return` globals are all excluded.
  expect(JSON.parse(lines[0])).toEqual([{ name: "i", value: 2, kind: "let" }]);
  expect(JSON.parse(lines[1])).toBe("number");
  expect({ stderr, exitCode }).toEqual({ stderr: expect.any(String), exitCode: 0 });
});
