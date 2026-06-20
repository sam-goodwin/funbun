import { test, expect } from "bun:test";
import { serialize } from "bun:closure";
import { tempDir } from "harness";

// Round-trip: serialize a function, write the resulting module, dynamic-import
// it, and return its default export so we can exercise it.
let counter = 0;
async function roundtrip<T extends Function>(fn: T): Promise<T> {
  const code = serialize(fn);
  using dir = tempDir(`closure-rt-${counter++}`, { "mod.mjs": code });
  const mod = await import(`${String(dir)}/mod.mjs`);
  return mod.default as T;
}

test("round-trips an arrow function with no free variables", async () => {
  const fn = await roundtrip((a: number, b: number) => a + b);
  expect(fn(2, 3)).toBe(5);
});

test("round-trips a function expression", async () => {
  const fn = await roundtrip(function double(x: number) {
    return x * 2;
  });
  expect(fn(21)).toBe(42);
});

test("round-trips an async function", async () => {
  const fn = await roundtrip(async (x: number) => x + 1);
  await expect(fn(1)).resolves.toBe(2);
});

test("the result is a module whose default export is the function", () => {
  const code = serialize((x: number) => x);
  expect(code).toContain("export default");
});

test("throws on non-functions", () => {
  expect(() => serialize(42 as any)).toThrow(TypeError);
});

test("throws on native functions", () => {
  expect(() => serialize(Math.max)).toThrow("Cannot serialize a native function");
});

test("reconstructs a captured primitive (number)", async () => {
  let i = 41;
  void i;
  const fn = await roundtrip(() => i + 1);
  expect(fn()).toBe(42);
});

test("reconstructs a mutable captured counter", async () => {
  let n = 0;
  const fn = await roundtrip(() => ++n);
  expect(fn()).toBe(1);
  expect(fn()).toBe(2);
});

test("reconstructs captured primitives of every kind", async () => {
  let str = 'hi\n"x"';
  let bool = true;
  let nul = null;
  let undef = undefined;
  let big = 123n;
  let neg0 = -0;
  let inf = Infinity;
  let nan = NaN;
  void [str, bool, nul, undef, big, neg0, inf, nan];
  const fn = await roundtrip(() => ({ str, bool, nul, undef, big, neg0, inf, nan }));
  const out = fn();
  expect(out).toEqual({
    str: 'hi\n"x"',
    bool: true,
    nul: null,
    undef: undefined,
    big: 123n,
    neg0: -0,
    inf: Infinity,
    nan: NaN,
  });
  expect(1 / out.neg0).toBe(-Infinity);
});

test("respects const vs let binding kind", () => {
  // Computed initializer so it's a real captured cell, not a folded constant.
  const k = Math.min(7, 9);
  void k;
  const code = serialize(() => k);
  expect(code).toContain("const k = 7;");
});

test("a closure over a compile-time-constant const round-trips (value inlined in source)", async () => {
  function make() {
    const k = 7;
    return () => k * 2;
  }
  const fn = await roundtrip(make());
  expect(fn()).toBe(14);
});

test("reconstructs a captured object", async () => {
  let o = { a: 1, b: "x", nested: { c: true } };
  void o;
  const fn = await roundtrip(() => o);
  expect(fn()).toEqual({ a: 1, b: "x", nested: { c: true } });
});

test("reconstructs a captured array", async () => {
  let arr = [1, "two", [3, 4]];
  void arr;
  const fn = await roundtrip(() => arr);
  expect(fn()).toEqual([1, "two", [3, 4]]);
});

test("round-trips a circular object", async () => {
  let o: any = { v: 1 };
  o.self = o;
  void o;
  const fn = await roundtrip(() => o);
  const result = fn();
  expect(result.v).toBe(1);
  expect(result.self).toBe(result);
});

test("shared object reference is emitted once (identity preserved)", async () => {
  let a = { v: 1 };
  let b = a;
  void [a, b];
  const fn = await roundtrip(() => [a, b]);
  const [x, y] = fn();
  expect(x).toBe(y);
  expect(x.v).toBe(1);
});

test("reconstructs a captured (nested) function", async () => {
  let g = (x: number) => x * 3;
  void g;
  const fn = await roundtrip(() => g(7));
  expect(fn()).toBe(21);
});

test("reconstructs a function captured inside an object", async () => {
  let o = { fn: (x: number) => x + 1, base: 10 };
  void o;
  const fn = await roundtrip(() => o.fn(o.base));
  expect(fn()).toBe(11);
});

test("nested functions keep isolated scopes (same-named captures don't collide)", async () => {
  // `a` and `b` each capture a different `x`.
  let a = (() => {
    let x = 1;
    return () => x;
  })();
  let b = (() => {
    let x = 2;
    return () => x;
  })();
  void [a, b];
  const fn = await roundtrip(() => [a(), b()]);
  expect(fn()).toEqual([1, 2]);
});

test("a captured function that itself captures an object shares that object", async () => {
  let shared = { hits: 0 };
  let bump = () => ++shared.hits;
  void [shared, bump];
  const fn = await roundtrip(() => {
    bump();
    return shared.hits;
  });
  expect(fn()).toBe(1);
});
