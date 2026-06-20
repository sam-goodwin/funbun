import { test, expect } from "bun:test";

// Experimental primitive: `fn[Symbol.freeVariables]` returns an array of
// descriptors — { name, id, value, kind } — for the variables a closure
// captures. It reflects the *mutable heap-allocated captured state*: JSC only
// allocates a captured variable into a scope environment when a nested function
// closes over it, so that environment is exactly what this exposes.
//
// `id` identifies the underlying variable cell (environment instance + slot);
// two closures over the same variable observe the same id. `const` bindings
// folded to a compile-time constant never get a cell and so do not appear.
const freeVariables = Symbol.freeVariables;

type Descriptor = { name: string; id: number; value: any; kind: "const" | "let" };

function byName(fn: Function): Record<string, Descriptor> {
  const out: Record<string, Descriptor> = {};
  for (const d of (fn as any)[freeVariables] as Descriptor[]) out[d.name] = d;
  return out;
}

test("Symbol.freeVariables is a symbol exposed on the Symbol constructor", () => {
  expect(typeof freeVariables).toBe("symbol");
  expect(String(freeVariables)).toBe("Symbol(Symbol.freeVariables)");
});

test("returns an array of {name, id, value, kind} descriptors", () => {
  function make() {
    let x = 42;
    return () => x;
  }
  const captured = (make() as any)[freeVariables] as Descriptor[];
  expect(Array.isArray(captured)).toBe(true);
  expect(captured).toHaveLength(1);
  expect(captured[0]).toEqual({ name: "x", id: expect.any(Number), value: 42, kind: "let" });
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
