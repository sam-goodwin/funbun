import { test, expect, describe, beforeAll } from "bun:test";
import { serialize } from "bun:closure";
import { tempDir, bunExe, bunEnv } from "harness";

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

test("reconstructs a class instance's private #field state (made public)", async () => {
  class Counter {
    #n = 5;
    get value() {
      return this.#n;
    }
    bump() {
      return ++this.#n;
    }
  }
  let c = new Counter();
  c.bump(); // #n is now 6
  void c;
  const out = (await roundtrip(() => c))();
  // Private #field value is snapshotted and restored (as a mangled public field);
  // methods that referenced #n keep working.
  expect(out.value).toBe(6);
  expect(out.bump()).toBe(7);
  expect(out.constructor.name).toBe("Counter");
});

test("reconstructs a class with a private method (made public)", async () => {
  class Svc {
    #secret = 42;
    #compute() {
      return this.#secret * 2;
    }
    run() {
      return this.#compute();
    }
  }
  let s = new Svc();
  void s;
  const out = (await roundtrip(() => s))();
  expect(out.run()).toBe(84);
});

test("private field rewrite skips strings and comments", async () => {
  class WithHash {
    #n = 1;
    tag() {
      // a comment mentioning #n should be untouched
      return "literal #n stays" + this.#n;
    }
  }
  let w = new WithHash();
  void w;
  const out = (await roundtrip(() => w))();
  expect(out.tag()).toBe("literal #n stays1");
});

test("reconstructs a subclass value (extends superclass)", async () => {
  class Animal {
    kind() {
      return "animal";
    }
    speak() {
      return "generic";
    }
  }
  class Dog extends Animal {
    speak() {
      return "woof";
    }
  }
  void Dog;
  const fn = await roundtrip(() => Dog);
  const Klass = fn();
  const d = new Klass();
  expect(d.speak()).toBe("woof"); // own method
  expect(d.kind()).toBe("animal"); // inherited method
});

test("reconstructs an instance of a subclass", async () => {
  class Base {
    greet() {
      return "hi from " + (this as any).label;
    }
  }
  class Derived extends Base {
    label = "derived";
  }
  let inst = new Derived();
  void inst;
  const fn = await roundtrip(() => inst);
  const out = fn();
  expect(out.label).toBe("derived");
  expect(out.greet()).toBe("hi from derived"); // inherited method works
});

test("preserves static class members", async () => {
  class Cfg {
    static VERSION = "1.0";
    static make() {
      return new Cfg();
    }
    greet() {
      return "hi";
    }
  }
  void Cfg;
  const Klass = (await roundtrip(() => Cfg))();
  expect(Klass.VERSION).toBe("1.0");
  expect(Klass.make().greet()).toBe("hi");
});

test("reconstructs a prototype getter via a class instance", async () => {
  class Temp {
    c: number;
    constructor(c: number) {
      this.c = c;
    }
    get fahrenheit() {
      return (this.c * 9) / 5 + 32;
    }
  }
  let inst = new Temp(100);
  void inst;
  const out = (await roundtrip(() => inst))();
  expect(out.fahrenheit).toBe(212);
});

test("reconstructs a class whose method captures a free variable", async () => {
  function makeClass(offset: number) {
    return class {
      add(x: number) {
        return x + offset;
      }
    };
  }
  let Adder = makeClass(10);
  void Adder;
  const Klass = (await roundtrip(() => Adder))();
  expect(new Klass().add(5)).toBe(15);
});

test("reconstructs symbol-keyed, generator, and async methods", async () => {
  let obj = {
    [Symbol.iterator]() {
      return [10, 20][Symbol.iterator]();
    },
    *count() {
      yield 1;
      yield 2;
    },
    async ping() {
      return "pong";
    },
  };
  void obj;
  const out = await roundtrip(() => obj);
  const o = out();
  expect([...o]).toEqual([10, 20]);
  expect([...o.count()]).toEqual([1, 2]);
  await expect(o.ping()).resolves.toBe("pong");
});

test("reconstructs generator and async generator functions", async () => {
  function* g() {
    yield 1;
    yield 2;
  }
  void g;
  const out = (await roundtrip(() => g))();
  expect([...out()]).toEqual([1, 2]);
});

test("a class captured via its factory round-trips fully (field + method captures)", async () => {
  function makeClass(base: number) {
    return class {
      val = base + 1;
      double() {
        return base * 2;
      }
    };
  }
  void makeClass;
  const C = (await roundtrip(() => makeClass(41)))();
  const inst = new C();
  expect(inst.val).toBe(42);
  expect(inst.double()).toBe(82);
});

test("a directly-captured class works when its field var is also used by a method", async () => {
  let C = ((base: number) =>
    class {
      val = base + 1;
      get() {
        return base;
      }
    })(41);
  void C;
  const Klass = (await roundtrip(() => C))();
  expect(new Klass().val).toBe(42);
  expect(new Klass().get()).toBe(41);
});

test("known limitation: a var captured only by a field initializer on a direct class value is unbound", async () => {
  // `base` is referenced only by the field initializer (no method references it),
  // and the class is captured as a value rather than via its factory. The class's
  // member executables aren't reachable from the class constructor, so `base`
  // can't be recovered. Workaround: capture the factory, or use the var in a method.
  let C = ((base: number) =>
    class {
      val = base + 1;
    })(41);
  void C;
  const Klass = (await roundtrip(() => C))();
  expect(() => new Klass()).toThrow(); // base is not defined
});

describe("round-tripping a reference to a method (not the containing object)", () => {
  let obj = {
    [Symbol.iterator]() {
      return [10, 20][Symbol.iterator]();
    },
    *count() {
      yield 1;
      yield 2;
    },
    async ping() {
      return "pong";
    },
    plain(x: number) {
      return x + 1;
    },
  };

  test("symbol-keyed method reference", async () => {
    const iter = await roundtrip(obj[Symbol.iterator]);
    expect([...{ [Symbol.iterator]: iter }]).toEqual([10, 20]);
  });

  test("generator method reference", async () => {
    const count = await roundtrip(obj.count);
    expect([...count()]).toEqual([1, 2]);
  });

  test("async method reference", async () => {
    const ping = await roundtrip(obj.ping);
    await expect(ping()).resolves.toBe("pong");
  });

  test("plain method reference", async () => {
    const plain = await roundtrip(obj.plain);
    expect(plain(41)).toBe(42);
  });
});

test("round-trips an extracted method that captures a free variable", async () => {
  function make() {
    let n = 7;
    return {
      read() {
        return n;
      },
      bump() {
        return ++n;
      },
    };
  }
  const o = make();
  const read = await roundtrip(o.read);
  const bump = await roundtrip(o.bump);
  // Each is extracted independently, so they get independent copies of `n`.
  expect(read()).toBe(7);
  expect(bump()).toBe(8);
});

describe("recursion topologies", () => {
  test("self-recursion via the function's own (declaration) name", async () => {
    function fact(n: number): number {
      return n <= 1 ? 1 : n * fact(n - 1);
    }
    void fact;
    const f = await roundtrip(fact);
    expect(f(5)).toBe(120);
  });

  test("self-recursion via a captured const arrow", async () => {
    const fib = (n: number): number => (n < 2 ? n : fib(n - 1) + fib(n - 2));
    void fib;
    const f = await roundtrip(fib);
    expect(f(7)).toBe(13);
  });

  test("mutual recursion (two functions calling each other)", async () => {
    function isEven(n: number): boolean {
      return n === 0 || isOdd(n - 1);
    }
    function isOdd(n: number): boolean {
      return n !== 0 && isEven(n - 1);
    }
    void [isEven, isOdd];
    const f = await roundtrip(isEven);
    expect(f(10)).toBe(true);
    expect(f(7)).toBe(false);
  });
});

describe("function forms round-trip", () => {
  test("named function expression with self-reference", async () => {
    const f = await roundtrip(function fac(n: number): number {
      return n <= 1 ? 1 : n * fac(n - 1);
    });
    expect(f(4)).toBe(24);
  });
  test("generator with yield* delegation", async () => {
    function* inner() {
      yield 1;
      yield 2;
    }
    function* outer() {
      yield* inner();
      yield 3;
    }
    void [inner, outer];
    const g = await roundtrip(outer);
    expect([...g()]).toEqual([1, 2, 3]);
  });
  test("async function awaiting a captured promise-returning fn", async () => {
    let delay = (x: number) => Promise.resolve(x + 1);
    void delay;
    const f = await roundtrip(async () => (await delay(41)) * 1);
    await expect(f()).resolves.toBe(42);
  });
});

describe("exotic body syntax survives transforms", () => {
  test("destructuring params, defaults, rest, spread", async () => {
    const f = await roundtrip(
      (a: number, { b = 10 } = {} as any, ...rest: number[]) => a + b + rest.reduce((x, y) => x + y, 0),
    );
    expect(f(1, { b: 2 }, 3, 4)).toBe(10);
    expect(f(1)).toBe(11);
  });
  test("optional chaining, nullish, template, tagged template, regex", async () => {
    function tag(strings: TemplateStringsArray, ...v: any[]) {
      return strings.join("|") + "::" + v.join(",");
    }
    void tag;
    const f = await roundtrip((o: any) => {
      const re = /(\d+)-(\d+)/;
      const m = "12-34".match(re);
      return tag`a${o?.x ?? "none"}b${m?.[1]}`;
    });
    expect(f({ x: 5 })).toBe("a|b|::5,12");
    expect(f(null)).toBe("a|b|::none,12");
  });
  test("try/catch/finally, labeled loops, switch", async () => {
    const original = (n: number) => {
      let out = "";
      outer: for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
          if (j === n) continue outer;
          if (i === 3) break outer;
          out += `${i}${j}`;
        }
      }
      try {
        switch (n) {
          case 1:
            return out + "one";
          default:
            throw new Error("x");
        }
      } catch {
        return out + "caught";
      } finally {
        out += "!";
      }
    };
    const f = await roundtrip(original);
    for (const n of [0, 1, 2, 3]) expect(f(n)).toBe(original(n));
  });
});

describe("captured value types", () => {
  test("registered symbol value (Symbol.for)", async () => {
    let s = Symbol.for("bun.closure.test.sym");
    void s;
    const f = await roundtrip(() => s);
    expect(f()).toBe(Symbol.for("bun.closure.test.sym"));
  });
  test("well-known symbol value", async () => {
    let s = Symbol.iterator;
    void s;
    const f = await roundtrip(() => s);
    expect(f()).toBe(Symbol.iterator);
  });
  test("unique symbol value throws", () => {
    let s = Symbol("unique");
    void s;
    expect(() => serialize(() => s)).toThrow("unique symbol value");
  });
  test("sparse array preserves holes and length", async () => {
    let arr = [1, , 3];
    arr.length = 5;
    void arr;
    const out = (await roundtrip(() => arr))();
    expect(out.length).toBe(5);
    expect(1 in out).toBe(false);
    expect(out[0]).toBe(1);
    expect(out[2]).toBe(3);
  });
  test("deeply nested mixed graph with a cycle", async () => {
    let inner: any = { tag: "leaf" };
    let graph: any = { list: [1, { fn: () => inner.tag }], inner };
    inner.parent = graph;
    void graph;
    const out = (await roundtrip(() => graph))();
    expect(out.list[1].fn()).toBe("leaf");
    expect(out.inner.parent).toBe(out);
  });
});

test("captures a function and a value imported from another module", async () => {
  using dir = tempDir("closure-xmod", {
    "dep.ts": `export function helper(x: number) { return x * 10; }\nexport const FACTOR = 3;\n`,
    "main.ts": `
      import { serialize } from "bun:closure";
      import { helper, FACTOR } from "./dep.ts";
      import fs from "node:fs";
      let h = helper, f = FACTOR;
      fs.writeFileSync(new URL("./out.mjs", import.meta.url), serialize(() => h(f)));
    `,
    "runner.ts": `
      const fn = (await import("./out.mjs")).default;
      console.log(fn());
    `,
  });
  await using gen = Bun.spawn({
    cmd: [bunExe(), "main.ts"],
    cwd: String(dir),
    env: { ...bunEnv, BUN_DEBUG_QUIET_LOGS: "1" },
    stderr: "pipe",
  });
  const genErr = await gen.stderr.text();
  expect({ err: genErr, code: await gen.exited }).toEqual({ err: expect.any(String), code: 0 });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "runner.ts"],
    cwd: String(dir),
    env: { ...bunEnv, BUN_DEBUG_QUIET_LOGS: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect(stdout.trim()).toBe("30");
  expect(exitCode).toBe(0);
});

describe("unserializable values throw clearly (no silent loss)", () => {
  test("WeakMap", () => {
    let w = new WeakMap();
    void w;
    expect(() => serialize(() => w)).toThrow("WeakMap");
  });
  test("WeakSet", () => {
    let w = new WeakSet();
    void w;
    expect(() => serialize(() => w)).toThrow("WeakSet");
  });
  test("Promise", () => {
    let p = Promise.resolve(1);
    void p;
    expect(() => serialize(() => p)).toThrow("Promise");
  });
});

describe("more closure topologies", () => {
  test("three-level nested closures sharing an outer cell", async () => {
    function level1() {
      let total = 0;
      function level2() {
        function level3(n: number) {
          total += n;
          return total;
        }
        return level3;
      }
      return level2();
    }
    void level1;
    const add = (await roundtrip(level1))();
    expect(add(5)).toBe(5);
    expect(add(3)).toBe(8);
  });

  test("default parameter that captures a free variable", async () => {
    let fallback = 99;
    void fallback;
    const f = await roundtrip((x = fallback) => x);
    expect(f()).toBe(99);
    expect(f(1)).toBe(1);
  });

  test("function using arguments", async () => {
    const sum = await roundtrip(function () {
      let t = 0;
      for (let i = 0; i < arguments.length; i++) t += arguments[i] as number;
      return t;
    });
    expect((sum as any)(1, 2, 3, 4)).toBe(10);
  });

  test("async iteration over a captured async iterable", async () => {
    let source = {
      async *[Symbol.asyncIterator]() {
        yield 1;
        yield 2;
      },
    };
    void source;
    const collect = await roundtrip(async () => {
      const out: number[] = [];
      for await (const x of source) out.push(x);
      return out;
    });
    await expect(collect()).resolves.toEqual([1, 2]);
  });
});

describe("access-path pruning", () => {
  // Only the members the closure actually references should be serialized.
  test("prunes unreferenced properties of a captured object", async () => {
    const foo = { method: () => 42, unusedBig: "DO_NOT_SERIALIZE", alsoUnused: { deep: [1, 2, 3] } };
    const code = serialize(() => foo.method());
    expect(code).not.toContain("DO_NOT_SERIALIZE");
    expect(code).not.toContain("alsoUnused");
    const fn = await roundtrip(() => foo.method());
    expect(fn()).toBe(42);
  });

  test("follows `this` into invoked methods (keeps what the method reads)", async () => {
    const foo = {
      compute() {
        return this.config.x;
      },
      config: { x: 7, unusedField: 99 },
      unusedTop: "NOPE",
    };
    const code = serialize(() => foo.compute());
    expect(code).not.toContain("NOPE");
    expect(code).not.toContain("unusedField");
    const fn = await roundtrip(() => foo.compute());
    expect(fn()).toBe(7);
  });

  test("keeps a nested access path and nothing else", async () => {
    const foo = { a: { b: 5, bUnused: 6 }, aUnused: { z: 9 } };
    const code = serialize(() => foo.a.b);
    expect(code).not.toContain("bUnused");
    expect(code).not.toContain("aUnused");
    const fn = await roundtrip(() => foo.a.b);
    expect(fn()).toBe(5);
  });

  test("keeps the whole object when it escapes (passed opaquely)", async () => {
    const foo = { a: 1, b: 2 };
    const sink = (o: object) => JSON.stringify(o);
    const fn = await roundtrip(() => sink(foo));
    expect(fn()).toBe(`{"a":1,"b":2}`);
  });

  test("keeps the whole object on computed access", async () => {
    const key = "a";
    const foo = { a: 11, b: 22 };
    const fn = await roundtrip(() => foo[key as "a"]);
    expect(fn()).toBe(11);
  });

  test("unions the members referenced across multiple closures sharing an object", async () => {
    const shared = { x: 1, y: 2, z: 3 };
    const read = () => shared.x + shared.y;
    const code = serialize(read);
    // x and y are used; z is not.
    expect(code).not.toContain('"z"');
    const fn = await roundtrip(read);
    expect(fn()).toBe(3);
  });

  test("keeps everything reachable from an escaped object (cycle-safe)", async () => {
    const inner: any = { tag: "leaf" };
    const graph: any = { inner, note: "kept-because-graph-escapes" };
    inner.parent = graph;
    const fn = await roundtrip(() => graph);
    const out = fn();
    expect(out.note).toBe("kept-because-graph-escapes");
    expect(out.inner.parent).toBe(out);
  });

  // A namespace import (`import * as ns`) is a captured free variable. serialize()
  // (no bundler) inlines only the referenced members and tree-shakes the rest —
  // runtime visibility makes the static `export *` barrel problem moot.
  test("inlines and prunes a namespace import without the bundler", async () => {
    using dir = tempDir(`closure-ns-serialize-${counter++}`, {
      "m.mjs": `
        export function alpha() { return "ALPHA"; }
        export function unused() { return "UNUSED_MARKER"; }
        export const cfg = { a: 1, big: "BIG_UNUSED_MARKER" };
      `,
      "main.mjs": `
        import { serialize } from "bun:closure";
        import { writeFileSync } from "node:fs";
        import * as m from "./m.mjs";
        const out = serialize(() => m.cfg.a + ":" + m.alpha());
        writeFileSync(new URL("./out.mjs", import.meta.url), out);
        console.log(JSON.stringify({
          unusedTreeShaken: !out.includes("UNUSED_MARKER"),
          bigPruned: !out.includes("BIG_UNUSED_MARKER"),
          hasSourceMap: out.includes("sourceMappingURL"),
        }));
        console.log("RESULT:" + (await import(new URL("./out.mjs", import.meta.url).href)).default());
      `,
    });

    await using proc = Bun.spawn({
      cmd: [bunExe(), String(dir) + "/main.mjs"],
      env: { ...bunEnv, BUN_DEBUG_QUIET_LOGS: "1" },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    const lines = stdout.trim().split("\n");

    expect(JSON.parse(lines[0])).toEqual({ unusedTreeShaken: true, bigPruned: true, hasSourceMap: true });
    expect(lines.find(l => l.startsWith("RESULT:"))).toBe("RESULT:1:ALPHA");
    expect({ stderr, exitCode }).toEqual({ stderr: expect.any(String), exitCode: 0 });
  });

  // Named/default imports from user modules are captured as free variables and
  // inlined (tree-shaking the rest); external (node:*) imports are re-emitted as
  // `import` statements. All via serialize() — sync, no bundler.
  test("inlines user-module imports and keeps external (node:*) imports", async () => {
    using dir = tempDir(`closure-imports-${counter++}`, {
      "m.mjs": `
        export function alpha() { return "ALPHA"; }
        export function unused() { return "UNUSED_MARKER"; }
      `,
      "main.mjs": `
        import { serialize } from "bun:closure";
        import { writeFileSync } from "node:fs";
        import { alpha } from "./m.mjs";
        import { basename } from "node:path";
        const out = serialize(p => alpha() + ":" + basename(p));
        writeFileSync(new URL("./out.mjs", import.meta.url), out);
        console.log(JSON.stringify({
          alphaInlined: out.includes("function alpha"),
          unusedTreeShaken: !out.includes("UNUSED_MARKER"),
          keptNodeImport: /import\\s*\\{\\s*basename\\s*\\}\\s*from\\s*"node:path"/.test(out),
        }));
        console.log("RESULT:" + (await import(new URL("./out.mjs", import.meta.url).href)).default("/a/b/c.txt"));
      `,
    });

    await using proc = Bun.spawn({
      cmd: [bunExe(), String(dir) + "/main.mjs"],
      env: { ...bunEnv, BUN_DEBUG_QUIET_LOGS: "1" },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    const lines = stdout.trim().split("\n");

    expect(JSON.parse(lines[0])).toEqual({ alphaInlined: true, unusedTreeShaken: true, keptNodeImport: true });
    expect(lines.find(l => l.startsWith("RESULT:"))).toBe("RESULT:ALPHA:c.txt");
    expect({ stderr, exitCode }).toEqual({ stderr: expect.any(String), exitCode: 0 });
  });
});

describe("bundle (bundler-backed)", () => {
  // bundle() routes the closure through Bun's bundler: imports are resolved and
  // inlined (which plain serialize cannot do), unused exports are tree-shaken,
  // and captured state is pruned to referenced members.
  test("resolves imports, tree-shakes, prunes state, and round-trips", async () => {
    using dir = tempDir(`closure-bundle-${counter++}`, {
      "dep.mjs": `
        export function alpha() { return "ALPHA"; }
        export function unusedExport() { return "UNUSED_SHOULD_TREESHAKE"; }
      `,
      "main.mjs": `
        import { alpha } from "./dep.mjs";
        import { bundle } from "bun:closure";
        import { writeFileSync } from "node:fs";
        let n = 5;
        const obj = { pick: "PICK", drop: "DROP_ME" };
        const fn = () => alpha() + ":" + n + ":" + obj.pick;
        const out = await bundle(fn);
        writeFileSync(new URL("./out.mjs", import.meta.url), out);
        console.log(JSON.stringify({
          importInlined: out.includes("ALPHA"),
          treeShaken: !out.includes("UNUSED_SHOULD_TREESHAKE"),
          statePruned: !out.includes("DROP_ME"),
        }));
        const m = await import(new URL("./out.mjs", import.meta.url).href);
        console.log("RESULT:" + m.default());
      `,
    });

    await using proc = Bun.spawn({
      cmd: [bunExe(), String(dir) + "/main.mjs"],
      env: { ...bunEnv, BUN_DEBUG_QUIET_LOGS: "1" },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    const lines = stdout.trim().split("\n");

    expect(JSON.parse(lines[0])).toEqual({ importInlined: true, treeShaken: true, statePruned: true });
    expect(lines.find(l => l.startsWith("RESULT:"))).toBe("RESULT:ALPHA:5:PICK");
    expect({ stderr, exitCode }).toEqual({ stderr: expect.any(String), exitCode: 0 });
  });

  // A `import * as ns` namespace is captured as a free variable; it must be
  // re-imported (so the bundler tree-shakes it), not value-walked as state.
  test("re-imports namespace imports and tree-shakes their unused members", async () => {
    using dir = tempDir(`closure-bundle-ns-${counter++}`, {
      "m.mjs": `
        export function used() { return "USED"; }
        export function unused() { return "UNUSED_SHOULD_TREESHAKE"; }
      `,
      "main.mjs": `
        import * as ns from "./m.mjs";
        import { bundle } from "bun:closure";
        import { writeFileSync } from "node:fs";
        const fn = () => ns.used();
        const out = await bundle(fn);
        writeFileSync(new URL("./out.mjs", import.meta.url), out);
        console.log(JSON.stringify({ treeShaken: !out.includes("UNUSED_SHOULD_TREESHAKE") }));
        const m = await import(new URL("./out.mjs", import.meta.url).href);
        console.log("RESULT:" + m.default());
      `,
    });

    await using proc = Bun.spawn({
      cmd: [bunExe(), String(dir) + "/main.mjs"],
      env: { ...bunEnv, BUN_DEBUG_QUIET_LOGS: "1" },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    const lines = stdout.trim().split("\n");

    expect(JSON.parse(lines[0])).toEqual({ treeShaken: true });
    expect(lines.find(l => l.startsWith("RESULT:"))).toBe("RESULT:USED");
    expect({ stderr, exitCode }).toEqual({ stderr: expect.any(String), exitCode: 0 });
  });

  test("handles method / class / generator roots and the replacer", async () => {
    using dir = tempDir(`closure-bundle-forms-${counter++}`, {
      "main.mjs": `
        import { bundle } from "bun:closure";
        import { writeFileSync } from "node:fs";
        let i = 0;
        const rt = async (fn, replacer) => {
          const out = await bundle(fn, replacer);
          const f = new URL(\`./o\${i++}.mjs\`, import.meta.url);
          writeFileSync(f, out);
          return { out, mod: await import(f.href) };
        };
        const obj = { greet(n) { return "hi " + n; } };
        const method = (await rt(obj.greet)).mod.default("x");
        class Pt { constructor(x) { this.x = x; } get() { return this.x; } }
        const cls = new (await rt(Pt)).mod.default(7).get();
        async function* gen() { yield 1; yield 2; }
        const genVals = await Array.fromAsync((await rt(gen)).mod.default());
        const secret = { token: "SECRET", keep: "KEEP" };
        const r = await rt(() => secret.keep + ":" + secret.token, (k, v) => (k === "token" ? "REDACTED" : v));
        let base = 10;
        const destructured = (await rt(({ a, b: c }) => a + c + base)).mod.default({ a: 1, b: 2 });
        console.log(JSON.stringify({ method, cls, genVals, replacerHidSecret: !r.out.includes("SECRET"), replaced: r.mod.default(), destructured }));
      `,
    });

    await using proc = Bun.spawn({
      cmd: [bunExe(), String(dir) + "/main.mjs"],
      env: { ...bunEnv, BUN_DEBUG_QUIET_LOGS: "1" },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);

    expect(JSON.parse(stdout.trim())).toEqual({
      method: "hi x",
      cls: 7,
      genVals: [1, 2],
      replacerHidSecret: true,
      replaced: "KEEP:REDACTED",
      destructured: 13,
    });
    expect({ stderr, exitCode }).toEqual({ stderr: expect.any(String), exitCode: 0 });
  });

  test("rejects native and bound roots with a clear error", async () => {
    const { bundle } = (await import("bun:closure")) as any;
    await expect(bundle(Math.max)).rejects.toThrow("Cannot bundle a native function");
    await expect(bundle((() => {}).bind(null))).rejects.toThrow("Cannot bundle a bound function");
  });
});

// ---------------------------------------------------------------------------
// ESM import spec: every standard import/re-export form, asserted on two axes —
//   (1) correctness:  the reconstructed module produces the right value.
//   (2) optimality:   only the referenced bindings/members survive; everything
//                      unused is tree-shaken (its UNUSED_* marker is absent).
//
// Import capture is a property of the *module environment* (a free variable that
// is an import resolves to its exporting module), so these can't be exercised
// inline — each closure lives in its own ES-module fixture. To stay fast, ONE
// subprocess serializes every case and emits a single JSON report; the tests
// below assert against that report.
// ---------------------------------------------------------------------------
describe("ESM import spec", () => {
  type CaseReport = { name: string; code?: string; result?: unknown; error?: string };
  const report = new Map<string, CaseReport>();

  // Each subject module exports `fn` (the closure to serialize) and, optionally,
  // `input` (args to call the reconstructed default export with).
  const deps: Record<string, string> = {
    "deps/math.mjs": `
      export function used() { return "USED_math"; }
      export function unusedMath() { return "UNUSED_math"; }
      export const KONST = 42;
    `,
    "deps/defaultexp.mjs": `
      export default function greet() { return "DEFAULT_val"; }
      export function sideUnused() { return "UNUSED_default"; }
    `,
    "deps/shape.mjs": `
      export class Point { constructor(x) { this.x = x; } get() { return this.x; } }
      export class UnusedShape { constructor() { this.marker = "UNUSED_shape"; } }
    `,
    "deps/transit.mjs": `
      const secret = "TRANSIT_secret";
      function helper() { return secret; }
      export function pub() { return helper(); }
      export function unusedPub() { return "UNUSED_transit"; }
    `,
    "deps/impl.mjs": `
      export function one() { return "BARREL_one"; }
      export function two() { return "UNUSED_barrel_two"; }
      export function three() { return "UNUSED_barrel_three"; }
    `,
    "deps/barrel.mjs": `export { one, two, three } from "./impl.mjs";`,
    "deps/barrel_rename.mjs": `export { one as uno } from "./impl.mjs";`,
    "deps/starsrc.mjs": `
      export function alpha() { return "STAR_alpha"; }
      export function unusedStar() { return "UNUSED_star"; }
    `,
    "deps/star.mjs": `export * from "./starsrc.mjs";`,
    "deps/nsre.mjs": `export * as inner from "./starsrc.mjs";`,
    "deps/defaultexp2.mjs": `export default function origin() { return "DEFRE_val"; }`,
    "deps/defre.mjs": `export { default } from "./defaultexp2.mjs";`,
    "deps/mixed.mjs": `
      export default function () { return "MIXED_default"; }
      export function named() { return "MIXED_named"; }
      export function unusedMixed() { return "UNUSED_mixed"; }
    `,
  };

  const subjects: Record<string, string> = {
    named: `import { used } from "../deps/math.mjs"; export const fn = () => used();`,
    alias: `import { used as u } from "../deps/math.mjs"; export const fn = () => u();`,
    namespace: `import * as ns from "../deps/math.mjs"; export const fn = () => ns.used();`,
    konst: `import { KONST } from "../deps/math.mjs"; export const fn = () => KONST;`,
    default: `import d from "../deps/defaultexp.mjs"; export const fn = () => d();`,
    klass: `import { Point } from "../deps/shape.mjs"; export const fn = () => new Point(7).get();`,
    transit: `import { pub } from "../deps/transit.mjs"; export const fn = () => pub();`,
    barrel: `import { one } from "../deps/barrel.mjs"; export const fn = () => one();`,
    barrelRename: `import { uno } from "../deps/barrel_rename.mjs"; export const fn = () => uno();`,
    starReexport: `import { alpha } from "../deps/star.mjs"; export const fn = () => alpha();`,
    nsReexport: `import { inner } from "../deps/nsre.mjs"; export const fn = () => inner.alpha();`,
    defaultReexport: `import d from "../deps/defre.mjs"; export const fn = () => d();`,
    mixedImport: `import def, { named } from "../deps/mixed.mjs"; export const fn = () => def() + ":" + named();`,
    nodeNamed: `import { basename } from "node:path"; export const fn = (p) => basename(p); export const input = ["/a/b/c.txt"];`,
    nodeDefault: `import path from "node:path"; export const fn = (p) => path.basename(p); export const input = ["/a/b/c.txt"];`,
    nodeNamespace: `import * as path from "node:path"; export const fn = (p) => path.basename(p); export const input = ["/a/b/c.txt"];`,
    multiExternal: `import { basename } from "node:path"; import { EOL } from "node:os"; export const fn = (p) => basename(p); export const input = ["/a/b/c.txt"];`,
    userPlusExternal: `import { used } from "../deps/math.mjs"; import { basename } from "node:path"; export const fn = (p) => used() + ":" + basename(p); export const input = ["/a/b/c.txt"];`,
  };

  // One driver serializes every subject, round-trips it, and reports code+result.
  const subjectImports = Object.keys(subjects)
    .map(name => `import * as case_${name} from "./subjects/${name}.mjs";`)
    .join("\n");
  const subjectList = Object.keys(subjects)
    .map(name => `["${name}", case_${name}]`)
    .join(", ");
  const runner = `
    import { serialize } from "bun:closure";
    import { writeFileSync, mkdirSync } from "node:fs";
    ${subjectImports}
    mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
    const cases = [${subjectList}];
    const report = [];
    for (const [name, mod] of cases) {
      try {
        const code = serialize(mod.fn);
        const url = new URL("./out/" + name + ".mjs", import.meta.url);
        writeFileSync(url, code);
        const ns = await import(url.href);
        const result = await ns.default(...(mod.input || []));
        report.push({ name, code, result });
      } catch (e) {
        report.push({ name, error: String((e && e.message) || e) });
      }
    }
    process.stdout.write("REPORT:" + JSON.stringify(report) + "\\n");
  `;

  const files: Record<string, string> = { ...deps, "runner.mjs": runner };
  for (const [name, src] of Object.entries(subjects)) files[`subjects/${name}.mjs`] = src;

  beforeAll(async () => {
    using dir = tempDir("closure-esm-spec", files);
    await using proc = Bun.spawn({
      cmd: [bunExe(), String(dir) + "/runner.mjs"],
      env: { ...bunEnv, BUN_DEBUG_QUIET_LOGS: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    const line = stdout.split("\n").find(l => l.startsWith("REPORT:"));
    if (!line) {
      throw new Error(
        `driver produced no report (exit ${exitCode})\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
      );
    }
    for (const entry of JSON.parse(line.slice("REPORT:".length)) as CaseReport[]) report.set(entry.name, entry);
  });

  // Look up a case, asserting it serialized without error.
  function ok(name: string): { code: string; result: unknown } {
    const c = report.get(name);
    expect(c, `case "${name}" missing from report`).toBeDefined();
    expect(c!.error, `case "${name}" failed to serialize`).toBeUndefined();
    return { code: c!.code!, result: c!.result };
  }

  describe("correctness — every form round-trips", () => {
    test.each([
      ["named", "USED_math"],
      ["alias", "USED_math"],
      ["namespace", "USED_math"],
      ["konst", 42],
      ["default", "DEFAULT_val"],
      ["klass", 7],
      ["transit", "TRANSIT_secret"],
      ["barrel", "BARREL_one"],
      ["barrelRename", "BARREL_one"],
      ["starReexport", "STAR_alpha"],
      ["nsReexport", "STAR_alpha"],
      ["defaultReexport", "DEFRE_val"],
      ["mixedImport", "MIXED_default:MIXED_named"],
      ["nodeNamed", "c.txt"],
      ["nodeDefault", "c.txt"],
      ["nodeNamespace", "c.txt"],
      ["multiExternal", "c.txt"],
      ["userPlusExternal", "USED_math:c.txt"],
    ])("%s round-trips to the expected value", (name, expected) => {
      expect(ok(name).result).toEqual(expected);
    });
  });

  describe("optimality — unused bindings are tree-shaken", () => {
    test("named import does not pull in sibling exports", () => {
      expect(ok("named").code).not.toContain("UNUSED_math");
    });
    test("namespace import keeps only the accessed member", () => {
      expect(ok("namespace").code).not.toContain("UNUSED_math");
    });
    test("default import does not pull in sibling exports", () => {
      expect(ok("default").code).not.toContain("UNUSED_default");
    });
    test("class import does not pull in sibling classes", () => {
      expect(ok("klass").code).not.toContain("UNUSED_shape");
    });
    test("inlining a function pulls its module-private deps but shakes unused exports", () => {
      const { code } = ok("transit");
      expect(code).toContain("TRANSIT_secret"); // transitive private dep inlined
      expect(code).not.toContain("UNUSED_transit"); // unused sibling export shaken
    });
    test("barrel (export { ... } from) keeps only the re-export actually used", () => {
      const { code } = ok("barrel");
      expect(code).not.toContain("UNUSED_barrel_two");
      expect(code).not.toContain("UNUSED_barrel_three");
    });
    test("export * re-export keeps only the used binding", () => {
      expect(ok("starReexport").code).not.toContain("UNUSED_star");
    });
    test("export * as ns re-export keeps only the accessed member", () => {
      // The historically-hard static case: runtime visibility makes it tractable.
      expect(ok("nsReexport").code).not.toContain("UNUSED_star");
    });
    test("mixed default+named import shakes the module's unused export", () => {
      expect(ok("mixedImport").code).not.toContain("UNUSED_mixed");
    });
  });

  describe("external (node:*) imports are re-emitted, not inlined", () => {
    test("named builtin import stays an import statement", () => {
      expect(ok("nodeNamed").code).toMatch(/import\s*\{\s*basename\s*\}\s*from\s*["']node:path["']/);
    });
    test("default builtin import stays an import statement", () => {
      expect(ok("nodeDefault").code).toMatch(/import\s+path\s+from\s*["']node:path["']/);
    });
    test("namespace builtin import stays an `import * as` statement", () => {
      // A builtin namespace can't be value-walked (members are native), so it is
      // re-emitted as an import rather than inlined.
      expect(ok("nodeNamespace").code).toMatch(/import\s*\*\s*as\s+path\s+from\s*["']node:path["']/);
    });
    test("an unused external import is not emitted at all", () => {
      const { code } = ok("multiExternal");
      expect(code).toMatch(/from\s*["']node:path["']/);
      expect(code).not.toContain("node:os"); // EOL never referenced → no import for it
    });
    test("a user import is inlined while an external import is kept, in one closure", () => {
      const { code } = ok("userPlusExternal");
      expect(code).toContain("USED_math"); // user fn inlined
      expect(code).toMatch(/from\s*["']node:path["']/); // builtin kept as import
    });
  });
});
