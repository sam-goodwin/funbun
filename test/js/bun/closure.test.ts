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

test("a shared mutable primitive cell stays shared across reconstructed functions", async () => {
  let i = 0;
  let inc = () => ++i;
  let read = () => i;
  void [i, inc, read];
  const fn = await roundtrip(() => {
    inc();
    inc();
    return read();
  });
  expect(fn()).toBe(2);
});

test("shared cell mutations are visible across calls into different closures", async () => {
  let log: number[] = [];
  let push = (n: number) => log.push(n);
  let dump = () => log.slice();
  void [log, push, dump];
  const fn = await roundtrip(() => {
    push(1);
    push(2);
    return dump();
  });
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

test("replacer transforms captured free-variable values", async () => {
  let secret = "real";
  void secret;
  const code = serialize(
    () => secret,
    (key, value) => (key === "secret" ? "redacted" : value),
  );
  using dir = tempDir("closure-replacer", { "mod.mjs": code });
  const { default: fn } = await import(`${String(dir)}/mod.mjs`);
  expect(fn()).toBe("redacted");
});

test("replacer transforms nested object properties", async () => {
  let o = { keep: 1, double: 5 };
  void o;
  const code = serialize(
    () => o,
    (key, value) => (key === "double" ? (value as number) * 2 : value),
  );
  using dir = tempDir("closure-replacer-nested", { "mod.mjs": code });
  const { default: fn } = await import(`${String(dir)}/mod.mjs`);
  expect(fn()).toEqual({ keep: 1, double: 10 });
});

test("replacer omits object properties it returns undefined for", async () => {
  let o = { keep: 1, drop: 2 };
  void o;
  const code = serialize(
    () => o,
    (key, value) => (key === "drop" ? undefined : value),
  );
  using dir = tempDir("closure-replacer-omit", { "mod.mjs": code });
  const { default: fn } = await import(`${String(dir)}/mod.mjs`);
  expect(fn()).toEqual({ keep: 1 });
});

test("reconstructs a captured Date", async () => {
  let d = new Date("2020-01-02T03:04:05.678Z");
  void d;
  const fn = await roundtrip(() => d);
  expect(fn().getTime()).toBe(new Date("2020-01-02T03:04:05.678Z").getTime());
});

test("reconstructs a captured RegExp", async () => {
  let re = /ab+c/gi;
  void re;
  const fn = await roundtrip(() => re);
  const out = fn();
  expect(out.source).toBe("ab+c");
  expect(out.flags).toBe("gi");
  expect(out.test("xxABBBCyy")).toBe(true);
});

test("reconstructs a captured Map (with object values)", async () => {
  let m = new Map<string, unknown>([
    ["a", 1],
    ["b", { nested: true }],
  ]);
  void m;
  const fn = await roundtrip(() => m);
  const out = fn();
  expect(out.get("a")).toBe(1);
  expect(out.get("b")).toEqual({ nested: true });
});

test("reconstructs a captured Set", async () => {
  let s = new Set([1, 2, 3]);
  void s;
  const fn = await roundtrip(() => s);
  expect([...fn()]).toEqual([1, 2, 3]);
});

test("reconstructs a captured typed array", async () => {
  let bytes = new Uint8Array([1, 2, 255]);
  void bytes;
  const fn = await roundtrip(() => bytes);
  const out = fn();
  expect(out).toBeInstanceOf(Uint8Array);
  expect([...out]).toEqual([1, 2, 255]);
});

test("reconstructs a captured Error with its type and message", async () => {
  let err = new TypeError("boom");
  void err;
  const fn = await roundtrip(() => err);
  const out = fn();
  expect(out).toBeInstanceOf(TypeError);
  expect(out.message).toBe("boom");
});

test("reconstructs a captured Proxy (object target)", async () => {
  let target = { a: 1 };
  let p = new Proxy(target, {
    get(t, key) {
      return key === "a" ? (t as any).a + 100 : (t as any)[key];
    },
  });
  void p;
  const fn = await roundtrip(() => p);
  const out = fn();
  expect(out.a).toBe(101); // trap applied
});

test("reconstructs a captured Proxy whose target is a function", async () => {
  let p = new Proxy((x: number) => x, {
    apply(t, _this, args) {
      return (t as any)(...args) * 2;
    },
  });
  void p;
  const fn = await roundtrip(() => p);
  expect(fn()(5)).toBe(10); // apply trap doubles
});

test("throws on a revoked Proxy", () => {
  const { proxy, revoke } = Proxy.revocable({ a: 1 }, {});
  revoke();
  let p = proxy;
  void p;
  expect(() => serialize(() => p)).toThrow("revoked Proxy");
});

test("reconstructs a captured object with a method (shorthand)", async () => {
  let o = {
    base: 10,
    add(x: number) {
      return this.base + x;
    },
  };
  void o;
  const fn = await roundtrip(() => o.add(5));
  expect(fn()).toBe(15);
});

test("reconstructs a bound function (bound args)", async () => {
  function add(a: number, b: number) {
    return a + b;
  }
  let bound = add.bind(null, 10);
  void bound;
  const fn = await roundtrip(() => bound(5));
  expect(fn()).toBe(15);
});

test("serializes a bound function as the root", async () => {
  function mul(a: number, b: number) {
    return a * b;
  }
  const fn = await roundtrip(mul.bind(null, 6));
  expect(fn(7)).toBe(42);
});

test("reconstructs a bound method preserving bound this", async () => {
  let counter = {
    n: 0,
    inc() {
      return ++this.n;
    },
  };
  let bound = counter.inc.bind(counter);
  void bound;
  const fn = await roundtrip(() => [bound(), bound()]);
  expect(fn()).toEqual([1, 2]);
});

test("Symbol.sourceLocation reports a function's definition site", () => {
  const fn = (x: number) => x;
  const loc = (fn as any)[Symbol.sourceLocation];
  expect(typeof loc.url).toBe("string");
  expect(loc.url).toContain("closure.test");
  expect(typeof loc.line).toBe("number");
  expect(typeof loc.column).toBe("number");
  expect((Math.max as any)[Symbol.sourceLocation]).toBeUndefined();
});

test("emits an inline source map", () => {
  const code = serialize(function boom() {
    throw new Error("x");
  });
  expect(code).toContain("//# sourceMappingURL=data:application/json");
});

test("source map remaps a thrown error to the original file", async () => {
  function boom() {
    throw new Error("kaboom");
  }
  const code = serialize(boom);
  using dir = tempDir("closure-srcmap", { "mod.mjs": code });
  const { default: fn } = await import(`${String(dir)}/mod.mjs`);
  let caught: any;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught?.message).toBe("kaboom");
  expect(caught?.stack).toContain("closure.test");
});

test("reconstructs an object getter (preserves dynamic behavior)", async () => {
  let o = {
    _x: 5,
    get x() {
      return this._x * 2;
    },
  };
  void o;
  const fn = await roundtrip(() => o);
  const out = fn();
  expect(out.x).toBe(10);
  out._x = 100;
  expect(out.x).toBe(200); // getter is live, not a frozen value
});

test("reconstructs a getter/setter pair", async () => {
  let store = { _v: 0 } as any;
  let o = {
    get v() {
      return store._v;
    },
    set v(n: number) {
      store._v = n;
    },
  };
  void [store, o];
  const fn = await roundtrip(() => o);
  const out = fn();
  out.v = 42;
  expect(out.v).toBe(42);
});

test("preserves non-enumerable data properties", async () => {
  let o = {};
  Object.defineProperty(o, "hidden", { value: 7, enumerable: false, writable: true, configurable: true });
  void o;
  const fn = await roundtrip(() => o);
  const out = fn();
  expect(out.hidden).toBe(7);
  expect(Object.keys(out)).toEqual([]);
});

test("preserves a registered-symbol-keyed property", async () => {
  const key = Symbol.for("bun.closure.test.key");
  let o = { [key]: "value" };
  void o;
  const fn = await roundtrip(() => o);
  expect(fn()[key]).toBe("value");
});

test("throws on a unique-symbol-keyed property", () => {
  let o = { [Symbol("unique")]: 1 };
  void o;
  expect(() => serialize(() => o)).toThrow("unique symbol property key");
});

test("reconstructs a class instance (prototype, methods, fields)", async () => {
  class Animal {
    name: string;
    constructor(n: string) {
      this.name = n;
    }
    speak() {
      return this.name + " noise";
    }
  }
  let inst = new Animal("rex");
  void inst;
  const fn = await roundtrip(() => inst);
  const out = fn();
  expect(out.name).toBe("rex");
  expect(out.speak()).toBe("rex noise");
  // Cross-module: it's an instance of the *reconstructed* class.
  expect(out.constructor.name).toBe("Animal");
  expect(out instanceof out.constructor).toBe(true);
});

test("reconstructs a null-prototype object", async () => {
  let o: any = Object.create(null);
  o.a = 1;
  void o;
  const fn = await roundtrip(() => o);
  const out = fn();
  expect(out.a).toBe(1);
  expect(Object.getPrototypeOf(out)).toBe(null);
});

test("private #fields are not captured (documented limitation)", async () => {
  class Counter {
    #n = 5;
    get value() {
      return this.#n;
    }
  }
  let c = new Counter();
  void c;
  const fn = await roundtrip(() => c);
  const out = fn();
  // Prototype/methods survive, but the private field does not exist on the
  // reconstruction, so reading it throws. (#private is invisible to reflection.)
  expect(out.constructor.name).toBe("Counter");
  expect(() => out.value).toThrow();
});
