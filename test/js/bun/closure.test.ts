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
