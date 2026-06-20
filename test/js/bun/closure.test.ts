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

test("round-trips a revoked Proxy (reconstructs as a revoked proxy)", async () => {
  const { proxy, revoke } = Proxy.revocable({ a: 1 }, {});
  revoke();
  let p = proxy;
  void p;
  const out = (await roundtrip(() => p))();
  // Every revoked proxy is observationally identical: any operation throws.
  expect(() => (out as any).a).toThrow(/revoked/);
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

test("a var captured only by a field initializer on a direct class value round-trips", async () => {
  // `base` is referenced only by the field initializer (no method references it),
  // and the class is captured as a value. Recovered via AST field-init analysis +
  // native scope resolution.
  let C = ((base: number) =>
    class {
      val = base + 1;
    })(41);
  void C;
  const Klass = (await roundtrip(() => C))();
  expect(new Klass().val).toBe(42);
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
  test("a pending Promise throws a clear error", () => {
    let p = new Promise(() => {}); // never settles
    void p;
    expect(() => serialize(() => p)).toThrow(/pending Promise/);
  });
});

describe("settled promises round-trip", () => {
  test("a fulfilled promise reconstructs with its value", async () => {
    let p = Promise.resolve(42);
    await p; // ensure settled before serializing
    void p;
    const out = (await roundtrip(() => p))();
    await expect(out).resolves.toBe(42);
  });

  test("a fulfilled promise resolving to a captured object", async () => {
    let p = Promise.resolve({ a: 1, nested: [2, 3] });
    await p;
    void p;
    const out = (await roundtrip(() => p))();
    await expect(out).resolves.toEqual({ a: 1, nested: [2, 3] });
  });

  test("a rejected promise reconstructs with its reason", async () => {
    let p = Promise.reject(new TypeError("boom"));
    await p.catch(() => {}); // settle + handle the original
    void p;
    const out = (await roundtrip(() => p))();
    await expect(out).rejects.toThrow("boom");
  });

  test("a fulfilled promise nested in a captured object", async () => {
    let p = Promise.resolve("inner");
    await p;
    const o = { label: "x", promise: p };
    void o;
    const result = (await roundtrip(() => o))();
    expect(result.label).toBe("x");
    await expect(result.promise).resolves.toBe("inner");
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

// ===========================================================================
// RADICAL CORRECTNESS & OPTIMALITY — deep nesting, recursion topologies,
// class shapes, generators, and tree-shaking limits. Designed to stress the
// ES spec corners of the serializer.
// ===========================================================================

describe("deeply nested scope capture", () => {
  test("inner closure captures cells from non-adjacent ancestor scopes", async () => {
    function level1() {
      let a = 100;
      function level2() {
        let b = 7;
        void b;
        function level3() {
          let c = 20;
          return () => a + c; // a is 3 scopes up, c is 1 scope up; b skipped
        }
        return level3();
      }
      return level2();
    }
    void level1;
    const fn = await roundtrip(level1());
    expect(fn()).toBe(120);
  });

  test("five-level closure summing one cell from every ancestor", async () => {
    function L1() {
      let a = 1;
      return (function L2() {
        let b = 2;
        return (function L3() {
          let c = 3;
          return (function L4() {
            let d = 4;
            return (function L5() {
              let e = 5;
              return () => a + b + c + d + e;
            })();
          })();
        })();
      })();
    }
    void L1;
    const fn = await roundtrip(L1());
    expect(fn()).toBe(15);
  });

  test("curry chain serialized at the leaf captures all earlier args", async () => {
    const curry = (a: number) => (b: number) => (c: number) => (d: number) => a + b + c + d;
    const leaf = curry(1)(2)(3);
    void leaf;
    const fn = await roundtrip(leaf);
    expect(fn(4)).toBe(10);
    expect(fn(40)).toBe(46);
  });

  test("curry chain serialized mid-way still produces working sub-closures", async () => {
    const curry = (a: number) => (b: number) => (c: number) => a * 100 + b * 10 + c;
    const partial = curry(7);
    void partial;
    const fn = await roundtrip(partial);
    expect(fn(2)(3)).toBe(723);
  });

  test("IIFE module pattern — captured M's api reads private state", async () => {
    const M = (() => {
      let _private = 41;
      return { get: () => _private, bump: () => ++_private };
    })();
    void M;
    const fn = await roundtrip(() => {
      M.bump();
      return M.get();
    });
    expect(fn()).toBe(42);
  });

  test("shadowing: innermost x wins", async () => {
    function outer() {
      let x = 1;
      void x;
      function mid() {
        let x = 2;
        void x;
        function inner() {
          let x = 3;
          return () => x;
        }
        return inner();
      }
      return mid();
    }
    void outer;
    const fn = await roundtrip(outer());
    expect(fn()).toBe(3);
  });

  test("shadowing: closure binds to the correct middle-scope x", async () => {
    function outer() {
      let x = "outer";
      void x;
      function mid() {
        let x = "mid";
        const read = () => x;
        function inner() {
          let x = "inner";
          void x;
          return read;
        }
        return inner();
      }
      return mid();
    }
    void outer;
    const fn = await roundtrip(outer());
    expect(fn()).toBe("mid");
  });

  test("let loop: a single per-iteration closure captures its own i", async () => {
    const fns: Array<() => number> = [];
    for (let i = 0; i < 5; i++) fns.push(() => i);
    const third = fns[3];
    void third;
    const fn = await roundtrip(third);
    expect(fn()).toBe(3);
  });

  test("let loop: all per-iteration closures keep distinct i", async () => {
    function build() {
      const fns: Array<() => number> = [];
      for (let i = 0; i < 4; i++) fns.push(() => i);
      return () => fns.map(f => f());
    }
    void build;
    const fn = await roundtrip(build());
    expect(fn()).toEqual([0, 1, 2, 3]);
  });

  test("block-scoped let is captured", async () => {
    function make() {
      let result: (() => number) | undefined;
      {
        let secret = 99;
        result = () => secret;
      }
      return result!;
    }
    void make;
    const fn = await roundtrip(make());
    expect(fn()).toBe(99);
  });

  test("sibling closures share one ancestor cell post-reconstruction", async () => {
    function make() {
      let count = 0;
      return { inc: () => ++count, get: () => count };
    }
    const { inc, get } = make();
    void [inc, get];
    const fn = await roundtrip(() => {
      inc();
      inc();
      inc();
      return get();
    });
    expect(fn()).toBe(3);
  });

  test("shared cell across object methods stays shared", async () => {
    function makeBank() {
      let balance = 100;
      return {
        deposit(n: number) {
          balance += n;
          return balance;
        },
        withdraw(n: number) {
          balance -= n;
          return balance;
        },
        balance: () => balance,
      };
    }
    const bank = makeBank();
    void bank;
    const fn = await roundtrip(() => {
      bank.deposit(50);
      bank.withdraw(30);
      return bank.balance();
    });
    expect(fn()).toBe(120);
  });

  test("co-recursive local helpers captured by an outer closure", async () => {
    function make() {
      const isEven = (n: number): boolean => (n === 0 ? true : isOdd(n - 1));
      const isOdd = (n: number): boolean => (n === 0 ? false : isEven(n - 1));
      return (n: number) => isEven(n);
    }
    void make;
    const fn = await roundtrip(make());
    expect(fn(10)).toBe(true);
    expect(fn(7)).toBe(false);
  });

  test("two distinct NON-shared cells with the same name coexist", async () => {
    function make1() {
      let x = 1;
      return () => x;
    }
    function make2() {
      let x = 2;
      return () => x;
    }
    const f1 = make1();
    const f2 = make2();
    void [f1, f2];
    const fn = await roundtrip(() => [f1(), f2()]);
    expect(fn()).toEqual([1, 2]);
  });

  test("deep ancestor cell shared by closures at different depths", async () => {
    function d1() {
      let acc = 0;
      function d2() {
        function d3() {
          const add = (n: number) => {
            acc += n;
            return acc;
          };
          function d4() {
            const read = () => acc;
            return { add, read };
          }
          return d4();
        }
        return d3();
      }
      return d2();
    }
    const { add, read } = d1();
    void [add, read];
    const fn = await roundtrip(() => {
      add(10);
      add(5);
      return read();
    });
    expect(fn()).toBe(15);
  });

  // GAP-PROBE: two lexically-distinct shared cells that happen to share a name.
  // Documented limitation — the serializer hoists shared cells by their original
  // name and throws on a collision. If a future change mangles colliding names,
  // flip this to assert [2, 1001].
  test("known limitation: two distinct shared cells with the same name throw", () => {
    function groupA() {
      let x = 1;
      return { inc: () => ++x, get: () => x };
    }
    function groupB() {
      let x = 1000;
      return { inc: () => ++x, get: () => x };
    }
    const a = groupA();
    const b = groupB();
    void [a, b];
    const root = () => {
      a.inc();
      b.inc();
      return [a.get(), b.get()];
    };
    expect(() => serialize(root)).toThrow('two distinct shared variables are both named "x"');
  });
});

describe("recursion topologies (radical)", () => {
  test("three-way mutual recursion", async () => {
    function f(n: number): number {
      return n <= 0 ? 0 : 1 + g(n - 1);
    }
    function g(n: number): number {
      return n <= 0 ? 0 : 1 + h(n - 1);
    }
    function h(n: number): number {
      return n <= 0 ? 0 : 1 + f(n - 1);
    }
    void [f, g, h];
    const fn = await roundtrip(f);
    expect(fn(9)).toBe(9);
  });

  test("four-way mutual recursion ring", async () => {
    function a(n: number): number {
      return n <= 0 ? 0 : 1 + b(n - 1);
    }
    function b(n: number): number {
      return n <= 0 ? 0 : 1 + c(n - 1);
    }
    function c(n: number): number {
      return n <= 0 ? 0 : 1 + d(n - 1);
    }
    function d(n: number): number {
      return n <= 0 ? 0 : 1 + a(n - 1);
    }
    void [a, b, c, d];
    const fn = await roundtrip(a);
    expect(fn(12)).toBe(12);
  });

  test("cycle where the entry function is outside the inner loop", async () => {
    function loopA(n: number): string {
      return n <= 0 ? "A" : loopB(n - 1);
    }
    function loopB(n: number): string {
      return n <= 0 ? "B" : loopA(n - 1);
    }
    function entry(n: number): string {
      return "start:" + loopA(n);
    }
    void [loopA, loopB, entry];
    const fn = await roundtrip(entry);
    expect(fn(4)).toBe("start:A");
    expect(fn(5)).toBe("start:B");
  });

  test("recursion through a captured object's own method (o.fact)", async () => {
    const o = {
      fact(n: number): number {
        return n <= 1 ? 1 : n * o.fact(n - 1);
      },
    };
    void o;
    const fn = await roundtrip(() => o.fact(5));
    expect(fn()).toBe(120);
  });

  test("recursion through a captured dispatch table", async () => {
    const table: Record<string, (n: number) => number> = {
      even(n) {
        return n === 0 ? 1 : table.odd(n - 1);
      },
      odd(n) {
        return n === 0 ? 0 : table.even(n - 1);
      },
    };
    void table;
    const fn = await roundtrip(() => table.even(10));
    expect(fn()).toBe(1);
  });

  test("recursion through a captured Map of functions", async () => {
    const dispatch = new Map<string, (n: number) => number>();
    dispatch.set("even", n => (n === 0 ? 1 : dispatch.get("odd")!(n - 1)));
    dispatch.set("odd", n => (n === 0 ? 0 : dispatch.get("even")!(n - 1)));
    void dispatch;
    const fn = await roundtrip(() => dispatch.get("even")!(6));
    expect(fn()).toBe(1);
  });

  test("recursion through a captured array of functions", async () => {
    const fns: Array<(n: number) => number> = [];
    fns.push(n => (n <= 0 ? 0 : 1 + fns[1](n - 1)));
    fns.push(n => (n <= 0 ? 0 : 1 + fns[0](n - 1)));
    void fns;
    const fn = await roundtrip(() => fns[0](8));
    expect(fn()).toBe(8);
  });

  test("Y-combinator builds factorial without named self-reference", async () => {
    const Y = (f: any): any => ((x: any) => f((v: any) => x(x)(v)))((x: any) => f((v: any) => x(x)(v)));
    const fact = Y((self: (n: number) => number) => (n: number) => (n <= 1 ? 1 : n * self(n - 1)));
    void fact;
    const fn = await roundtrip(fact);
    expect(fn(5)).toBe(120);
  });

  test("trampolined recursion via a captured trampoline helper", async () => {
    const trampoline = (start: () => any): number => {
      let result = start();
      while (typeof result === "function") result = result();
      return result;
    };
    const sumTo = (n: number, acc = 0): any => (n === 0 ? acc : () => sumTo(n - 1, acc + n));
    void [trampoline, sumTo];
    const fn = await roundtrip(() => trampoline(() => sumTo(100, 0)));
    expect(fn()).toBe(5050);
  });

  test("indirect recursion where the cycle passes through a captured HOF", async () => {
    const apply = (f: (n: number) => number, n: number): number => f(n);
    const countdown = (n: number): number => (n <= 0 ? 0 : 1 + apply(countdown, n - 1));
    void [apply, countdown];
    const fn = await roundtrip(countdown);
    expect(fn(7)).toBe(7);
  });

  test("a self-delegating recursive generator round-trips", async () => {
    function* walk(n: number): Generator<number> {
      if (n < 0) return;
      yield n;
      yield* walk(n - 1);
    }
    void walk;
    const gen = await roundtrip(walk);
    expect([...gen(3)]).toEqual([3, 2, 1, 0]);
  });

  test("mutually-recursive generators (ping/pong) round-trip", async () => {
    function* ping(n: number): Generator<string> {
      if (n <= 0) return;
      yield "ping";
      yield* pong(n - 1);
    }
    function* pong(n: number): Generator<string> {
      if (n <= 0) return;
      yield "pong";
      yield* ping(n - 1);
    }
    void [ping, pong];
    const gen = await roundtrip(ping);
    expect([...gen(4)]).toEqual(["ping", "pong", "ping", "pong"]);
  });

  test("crown jewel: mutual recursion across a circular ESM import graph", async () => {
    using dir = tempDir(`closure-xmod-circular-${counter++}`, {
      "a.mjs": `
        import { isOdd } from "./b.mjs";
        export function isEven(n) { return n === 0 ? true : isOdd(n - 1); }
      `,
      "b.mjs": `
        import { isEven } from "./a.mjs";
        export function isOdd(n) { return n === 0 ? false : isEven(n - 1); }
      `,
      "runner.mjs": `
        import { serialize } from "bun:closure";
        import { writeFileSync } from "node:fs";
        import { isEven } from "./a.mjs";
        const code = serialize(isEven);
        const url = new URL("./out.mjs", import.meta.url);
        writeFileSync(url, code);
        const ns = await import(url.href);
        process.stdout.write("RESULT:" + JSON.stringify({
          even10: ns.default(10),
          odd7: ns.default(7),
          noUserImport: !/from\\s*["'][^"']*\\/(a|b)\\.mjs["']/.test(code),
        }) + "\\n");
      `,
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), String(dir) + "/runner.mjs"],
      env: { ...bunEnv, BUN_DEBUG_QUIET_LOGS: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    const line = stdout.split("\n").find(l => l.startsWith("RESULT:"));
    expect({ line: line ?? `<none> stderr=${stderr}`, exitCode }).toEqual({
      line: expect.stringContaining("RESULT:"),
      exitCode: 0,
    });
    expect(JSON.parse(line!.slice("RESULT:".length))).toEqual({ even10: true, odd7: false, noUserImport: true });
  });

  test("cross-module mutual recursion with renamed (aliased) imports", async () => {
    using dir = tempDir(`closure-xmod-alias-${counter++}`, {
      "a.mjs": `
        import { isOdd as odd } from "./b.mjs";
        export function isEven(n) { return n === 0 ? true : odd(n - 1); }
      `,
      "b.mjs": `
        import { isEven as even } from "./a.mjs";
        export function isOdd(n) { return n === 0 ? false : even(n - 1); }
      `,
      "runner.mjs": `
        import { serialize } from "bun:closure";
        import { writeFileSync } from "node:fs";
        import { isEven } from "./a.mjs";
        const code = serialize(isEven);
        const url = new URL("./out.mjs", import.meta.url);
        writeFileSync(url, code);
        const ns = await import(url.href);
        process.stdout.write("RESULT:" + JSON.stringify({ even10: ns.default(10), odd7: ns.default(7) }) + "\\n");
      `,
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), String(dir) + "/runner.mjs"],
      env: { ...bunEnv, BUN_DEBUG_QUIET_LOGS: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    const line = stdout.split("\n").find(l => l.startsWith("RESULT:"));
    expect({ line: line ?? `<none> stderr=${stderr}`, exitCode }).toEqual({
      line: expect.stringContaining("RESULT:"),
      exitCode: 0,
    });
    expect(JSON.parse(line!.slice("RESULT:".length))).toEqual({ even10: true, odd7: false });
  });
});

describe("classes (radical)", () => {
  test("named class expression round-trips and self-name resolves internally", async () => {
    const C = class Named {
      self() {
        return Named;
      }
      tag() {
        return "named";
      }
    };
    void C;
    const K = (await roundtrip(() => C))();
    const inst = new K();
    expect(inst.tag()).toBe("named");
    expect(inst.self()).toBe(K);
  });

  test("3-level nested class expressions reconstruct, capturing an outer free var", async () => {
    const tag = "deep";
    void tag;
    const Outer = class {
      makeMid() {
        return class {
          makeInner() {
            return class {
              read() {
                return tag;
              }
            };
          }
        };
      }
    };
    void Outer;
    const KOuter = (await roundtrip(() => Outer))();
    const Mid = new KOuter().makeMid();
    const Inner = new Mid().makeInner();
    expect(new Inner().read()).toBe("deep");
  });

  test("a class built by applying one mixin round-trips (inherited method works)", async () => {
    class Base {
      base() {
        return "base";
      }
    }
    const Mixin = (B: typeof Base) =>
      class extends B {
        extra() {
          return "extra";
        }
      };
    const Combined = Mixin(Base);
    void Combined;
    const K = (await roundtrip(() => Combined))();
    const inst = new K();
    expect(inst.extra()).toBe("extra");
    expect(inst.base()).toBe("base");
    expect(inst instanceof K).toBe(true);
  });

  test("a class composed from three mixins reconstructs the full chain", async () => {
    class Base {
      fromBase() {
        return "B";
      }
    }
    const A = (S: any) =>
      class extends S {
        fromA() {
          return "A";
        }
      };
    const Mb = (S: any) =>
      class extends S {
        fromMb() {
          return "Mb";
        }
      };
    const C = (S: any) =>
      class extends S {
        fromC() {
          return "C";
        }
      };
    const Composed = A(Mb(C(Base)));
    void Composed;
    const K = (await roundtrip(() => Composed))();
    const inst = new K();
    expect([inst.fromA(), inst.fromMb(), inst.fromC(), inst.fromBase()]).toEqual(["A", "Mb", "C", "B"]);
    expect(inst instanceof K).toBe(true);
  });

  test("a mixin that captures a free var in its class's method round-trips", async () => {
    class Base {
      kind() {
        return "base";
      }
    }
    const prefix = ">>";
    void prefix;
    const Tagged = ((B: typeof Base) =>
      class extends B {
        label() {
          return prefix + this.kind();
        }
      })(Base);
    void Tagged;
    const K = (await roundtrip(() => Tagged))();
    expect(new K().label()).toBe(">>base");
  });

  test("3-level super.method() chain is intact after reconstruction", async () => {
    class A {
      who() {
        return "A";
      }
    }
    class B extends A {
      who() {
        return super.who() + "B";
      }
    }
    class C extends B {
      who() {
        return super.who() + "C";
      }
    }
    void C;
    const K = (await roundtrip(() => C))();
    expect(new K().who()).toBe("ABC");
  });

  test("super(args) constructor forwarding round-trips (as a class value)", async () => {
    class Base {
      x: number;
      constructor(x: number) {
        this.x = x;
      }
    }
    class Derived extends Base {
      constructor(n: number) {
        super(n * 2);
      }
    }
    void Derived;
    const K = (await roundtrip(() => Derived))();
    expect(new K(5).x).toBe(10);
  });

  test("private static field and method (class value) round-trip via mangling", async () => {
    class Reg {
      static #count = 0;
      static #bump() {
        return ++Reg.#count;
      }
      static next() {
        return Reg.#bump();
      }
    }
    void Reg;
    const K = (await roundtrip(() => Reg))();
    expect(K.next()).toBe(1);
    expect(K.next()).toBe(2);
  });

  test("private brand check (#x in obj) survives via mangled membership", async () => {
    class Box {
      #x = 1;
      static has(o: any) {
        return #x in o;
      }
    }
    void Box;
    const K = (await roundtrip(() => Box))();
    const inst = new K();
    expect(K.has(inst)).toBe(true);
    expect(K.has({})).toBe(false);
  });

  test("computed method name (captured key) and [Symbol.iterator] round-trip", async () => {
    const key = "dynamic";
    void key;
    const C = class {
      [key]() {
        return "computed";
      }
      *[Symbol.iterator]() {
        yield 1;
        yield 2;
      }
    };
    void C;
    const K = (await roundtrip(() => C))();
    const inst = new K();
    expect((inst as any).dynamic()).toBe("computed");
    expect([...inst]).toEqual([1, 2]);
  });

  test("static block executes on reconstruction and can use a captured var", async () => {
    const seed = 7;
    void seed;
    const C = class {
      static total = 0;
      static {
        (this as any).total = seed * 3;
      }
    };
    void C;
    const K = (await roundtrip(() => C))();
    expect((K as any).total).toBe(21);
  });

  test("a captured superclass identifier in the extends clause round-trips", async () => {
    class CapturedBase {
      hello() {
        return "hi";
      }
    }
    void CapturedBase;
    const Sub = class extends CapturedBase {
      bye() {
        return "bye";
      }
    };
    void Sub;
    const K = (await roundtrip(() => Sub))();
    const inst = new K();
    expect([inst.hello(), inst.bye()]).toEqual(["hi", "bye"]);
  });

  // GAP-PROBE: heritage that is a call expression (`extends computeBase()`) is not
  // a simple identifier, so the serializer can't bind it. Documents the boundary.
  test("extends <call-expression> heritage round-trips (computed superclass)", async () => {
    function computeBase() {
      return class {
        tag() {
          return "base";
        }
      };
    }
    void computeBase;
    const Sub = class extends computeBase() {
      own() {
        return "own";
      }
    };
    void Sub;
    const K = (await roundtrip(() => Sub))();
    const inst = new K();
    expect(inst.own()).toBe("own");
    expect((inst as any).tag()).toBe("base"); // inherited from the computed base
  });

  test("extends <member-expression> heritage round-trips", async () => {
    const ns = {
      Base: class {
        hi() {
          return "hi";
        }
      },
    };
    void ns;
    const Sub = class extends ns.Base {
      bye() {
        return "bye";
      }
    };
    void Sub;
    const K = (await roundtrip(() => Sub))();
    const inst = new K();
    expect([inst.bye(), (inst as any).hi()]).toEqual(["bye", "hi"]);
  });

  test("extends a call with object-literal args (brace inside heritage)", async () => {
    function mix(opts: { tag: string }) {
      return class {
        tag() {
          return opts.tag;
        }
      };
    }
    void mix;
    const Sub = class extends mix({ tag: "T" }) {
      own() {
        return "own";
      }
    };
    void Sub;
    const K = (await roundtrip(() => Sub))();
    const inst = new K();
    expect([inst.own(), (inst as any).tag()]).toEqual(["own", "T"]);
  });

  test("instanceof holds across reconstruction for subclass and superclass", async () => {
    class Base {}
    class Derived extends Base {}
    void Derived;
    const KD = (await roundtrip(() => Derived))();
    const inst = new KD();
    expect(inst instanceof KD).toBe(true);
    const KB = Object.getPrototypeOf(KD);
    expect(inst instanceof KB).toBe(true);
  });

  test("unused methods of a captured class are kept (class integrity over pruning)", async () => {
    const C = class {
      used() {
        return "used";
      }
      UNUSED_BUT_KEPT() {
        return "kept";
      }
    };
    void C;
    const code = serialize(() => new C().used());
    expect(code).toContain("UNUSED_BUT_KEPT");
    const fn = await roundtrip(() => new C());
    const inst = fn();
    expect(inst.used()).toBe("used");
    expect((inst as any).UNUSED_BUT_KEPT()).toBe("kept");
  });

  test("abstract-ish base with a subclass overriding one method round-trips", async () => {
    class Shape {
      area(): number {
        throw new Error("abstract");
      }
      describe() {
        return "area=" + this.area();
      }
    }
    class Square extends Shape {
      side: number;
      constructor(s: number) {
        super();
        this.side = s;
      }
      area() {
        return this.side * this.side;
      }
    }
    void Square;
    const K = (await roundtrip(() => Square))();
    const inst = new K(4);
    expect(inst.area()).toBe(16);
    expect(inst.describe()).toBe("area=16");
  });
});

describe("generators, iterators, and the live-generator hazard", () => {
  test("generator with a return value", async () => {
    function* g() {
      yield 1;
      yield 2;
      return "done";
    }
    void g;
    const make = (await roundtrip(() => g))();
    const it = make();
    expect(it.next()).toEqual({ value: 1, done: false });
    expect(it.next()).toEqual({ value: 2, done: false });
    expect(it.next()).toEqual({ value: "done", done: true });
  });

  test("two-way generator: yield receives sent values via .next(v)", async () => {
    function* adder() {
      let total = 0;
      while (true) {
        const x: number = yield total;
        total += x;
      }
    }
    void adder;
    const make = (await roundtrip(() => adder))();
    const it = make();
    expect(it.next().value).toBe(0);
    expect(it.next(5).value).toBe(5);
    expect(it.next(10).value).toBe(15);
  });

  test("async generator function with return value", async () => {
    async function* ag() {
      yield 1;
      yield 2;
      return 99;
    }
    void ag;
    const make = (await roundtrip(() => ag))();
    const it = make();
    expect(await it.next()).toEqual({ value: 1, done: false });
    expect(await it.next()).toEqual({ value: 2, done: false });
    expect(await it.next()).toEqual({ value: 99, done: true });
  });

  test("generator capturing a mutable cell mutated across yields", async () => {
    let seen: number[] = [];
    function* recorder() {
      let i = 0;
      while (i < 3) {
        seen.push(i);
        yield i++;
      }
    }
    void [seen, recorder];
    const out = await roundtrip(() => {
      const vals = [...recorder()];
      return { vals, seen };
    });
    expect(out()).toEqual({ vals: [0, 1, 2], seen: [0, 1, 2] });
  });

  test("three-level generator delegation ending in an array iterator", async () => {
    function* leaf() {
      yield* [3, 4];
    }
    function* mid() {
      yield 2;
      yield* leaf();
    }
    function* top() {
      yield 1;
      yield* mid();
      yield 5;
    }
    void [leaf, mid, top];
    const g = await roundtrip(top);
    expect([...g()]).toEqual([1, 2, 3, 4, 5]);
  });

  test("yield* forwards return value of the delegate", async () => {
    function* inner() {
      yield 1;
      return "inner-return";
    }
    function* outer() {
      const r = yield* inner();
      yield r;
    }
    void [inner, outer];
    const g = await roundtrip(outer);
    expect([...g()]).toEqual([1, "inner-return"]);
  });

  test("infinite generator consumed partially (take N) after reconstruction", async () => {
    function* nats() {
      let i = 0;
      while (true) yield i++;
    }
    void nats;
    const take = await roundtrip((n: number) => {
      const it = nats();
      const out: number[] = [];
      for (let k = 0; k < n; k++) out.push(it.next().value as number);
      return out;
    });
    expect(take(4)).toEqual([0, 1, 2, 3]);
  });

  test("custom iterable object captured and re-iterated", async () => {
    const range = {
      from: 1,
      to: 3,
      [Symbol.iterator]() {
        let cur = this.from;
        const end = this.to;
        return {
          next() {
            return cur <= end ? { value: cur++, done: false } : { value: undefined, done: true };
          },
        };
      },
    };
    void range;
    const out = await roundtrip(() => [...(range as any)]);
    expect(out()).toEqual([1, 2, 3]);
  });

  test("class with a generator method and an async generator method", async () => {
    class Stream {
      base: number;
      constructor(b: number) {
        this.base = b;
      }
      *take(n: number) {
        for (let i = 0; i < n; i++) yield this.base + i;
      }
      async *takeAsync(n: number) {
        for (let i = 0; i < n; i++) yield this.base + i;
      }
    }
    let inst = new Stream(10);
    void inst;
    const out = (await roundtrip(() => inst))();
    expect([...out.take(3)]).toEqual([10, 11, 12]);
    expect(await Array.fromAsync(out.takeAsync(2))).toEqual([10, 11]);
    expect(out.constructor.name).toBe("Stream");
  });

  // The hazard: a generator OBJECT holds suspended engine state not expressible
  // as source. Each of these must throw a CLEAR error (not silently corrupt).
  test("partially-executed generator object throws a clear error", () => {
    function* g() {
      yield 1;
      yield 2;
      yield 3;
    }
    const live = g();
    expect(live.next()).toEqual({ value: 1, done: false });
    let captured = live;
    void captured;
    expect(() => serialize(() => captured)).toThrow(/suspended execution state/i);
  });

  test("freshly-created generator object throws a clear error", () => {
    function* g() {
      yield 1;
    }
    let captured = g();
    void captured;
    expect(() => serialize(() => captured)).toThrow(/suspended execution state/i);
  });

  test("async generator object throws a clear error", async () => {
    async function* ag() {
      yield 1;
      yield 2;
    }
    const live = ag();
    expect(await live.next()).toEqual({ value: 1, done: false });
    let captured = live;
    void captured;
    expect(() => serialize(() => captured)).toThrow(/suspended execution state/i);
  });

  test("a native array iterator object throws a clear error", () => {
    const it = [1, 2, 3][Symbol.iterator]();
    it.next();
    let captured = it;
    void captured;
    expect(() => serialize(() => captured)).toThrow(/suspended execution state/i);
  });

  test("a live generator nested inside a captured object throws a clear error", () => {
    function* g() {
      yield 1;
    }
    const live = g();
    live.next();
    const wrapper = { label: "box", it: live };
    void wrapper;
    expect(() => serialize(() => wrapper)).toThrow(/suspended execution state/i);
  });
});

describe("optimality (radical)", () => {
  test("deep access path keeps only the spine, drops siblings at every level", async () => {
    const foo = {
      a: {
        sibA: "UNUSED_MARKER_A",
        b: { sibB: "UNUSED_MARKER_B", c: { sibC: "UNUSED_MARKER_C", d: 42, dSib: "UNUSED_MARKER_D" } },
      },
      rootSib: { huge: "UNUSED_MARKER_ROOT" },
    };
    const code = serialize(() => foo.a.b.c.d);
    for (const m of ["A", "B", "C", "D", "ROOT"]) expect(code).not.toContain(`UNUSED_MARKER_${m}`);
    const fn = await roundtrip(() => foo.a.b.c.d);
    expect(fn()).toBe(42);
  });

  test("two disjoint spines off one root keep both, prune the rest", async () => {
    const foo = { a: { b: 1, bSib: "UNUSED_MARKER_AB" }, x: { y: 2, ySib: "UNUSED_MARKER_XY" }, z: "UNUSED_MARKER_Z" };
    const code = serialize(() => foo.a.b + foo.x.y);
    for (const m of ["AB", "XY", "Z"]) expect(code).not.toContain(`UNUSED_MARKER_${m}`);
    const fn = await roundtrip(() => foo.a.b + foo.x.y);
    expect(fn()).toBe(3);
  });

  test("union of members across multiple reachable closures; global-unused dropped", async () => {
    const shared = { x: 1, y: 2, z: "UNUSED_MARKER_Z" };
    const read = () => shared.x;
    const peek = () => shared.y;
    void [read, peek];
    const root = () => read() + peek();
    const code = serialize(root);
    expect(code).not.toContain("UNUSED_MARKER_Z");
    expect(await (await roundtrip(root))()).toBe(3);
  });

  test("this-following unions fields across invoked methods; unreached field pruned", async () => {
    const obj = {
      a: 10,
      b: 20,
      c: "UNUSED_MARKER_C",
      m1() {
        return this.a;
      },
      m2() {
        return this.b;
      },
      mUnused() {
        return this.c;
      },
    };
    const code = serialize(() => obj.m1() + obj.m2());
    expect(code).not.toContain("UNUSED_MARKER_C");
    expect(await (await roundtrip(() => obj.m1() + obj.m2()))()).toBe(30);
  });

  test("only-reached method's this-reads kept; unread sibling field pruned", async () => {
    const obj = {
      a: 7,
      b: "UNUSED_MARKER_B",
      used() {
        return this.a;
      },
    };
    const code = serialize(() => obj.used());
    expect(code).not.toContain("UNUSED_MARKER_B");
    expect(await (await roundtrip(() => obj.used()))()).toBe(7);
  });

  test("transitive pruning: captured fn reads one field of its own big capture", async () => {
    const big = { keep: 99, huge: "UNUSED_MARKER_HUGE", other: { deep: "UNUSED_MARKER_DEEP" } };
    const pick = () => big.keep;
    void pick;
    const root = () => pick();
    const code = serialize(root);
    expect(code).not.toContain("UNUSED_MARKER_HUGE");
    expect(code).not.toContain("UNUSED_MARKER_DEEP");
    expect(await (await roundtrip(root))()).toBe(99);
  });

  test("method call this-follows receiver; result of the call is opaque (boundary)", async () => {
    const svc = {
      config: { host: "h" },
      unused: "UNUSED_MARKER_SVC_UNUSED",
      connect() {
        return { ok: this.config.host };
      },
    };
    const code = serialize(() => svc.connect().ok);
    expect(code).not.toContain("UNUSED_MARKER_SVC_UNUSED");
    expect(await (await roundtrip(() => svc.connect().ok))()).toBe("h");
  });

  test("escape via sink keeps everything (correct)", async () => {
    const foo = { a: 1, b: 2, c: { d: 3 } };
    const sink = (o: object) => JSON.stringify(o);
    void sink;
    expect(await (await roundtrip(() => sink(foo)))()).toBe(`{"a":1,"b":2,"c":{"d":3}}`);
  });

  test("static read + opaque escape across closures → keep-all dominates", async () => {
    const foo = { a: 1, b: 2, c: 3 };
    const reader = () => foo.a;
    const escaper = () => foo;
    void [reader, escaper];
    const root = () => reader() + (escaper() ? 0 : 0);
    const code = serialize(root);
    expect(code).toContain("2");
    expect(code).toContain("3");
    expect(await (await roundtrip(root))()).toBe(1);
  });

  // GAP-PROBE: a getter reached by member access (not a call) is not this-followed,
  // so fields its body reads via `this.*` may be pruned. This asserts the CORRECT
  // runtime result; if the serializer under-serializes, it fails — exposing the gap.
  test("getter read deeply still produces the correct value", async () => {
    const foo = {
      backing: 5,
      other: "tag",
      get live() {
        return { x: this.backing, tag: this.other };
      },
    };
    void foo;
    const fn = await roundtrip(() => foo.live.x);
    expect(fn()).toBe(5);
  });

  test("class instance: prototype methods kept verbatim; correctness preserved", async () => {
    class Widget {
      used = 1;
      ownUnused = "UNUSED_MARKER_OWNFIELD";
      reach() {
        return this.used;
      }
      neverCalled() {
        return "PROTO_METHOD_KEPT";
      }
    }
    const inst = new Widget();
    void inst;
    const code = serialize(() => inst.reach());
    expect(code).toContain("neverCalled");
    expect(await (await roundtrip(() => inst.reach()))()).toBe(1);
  });

  test("deep namespace member access prunes to the used sub-path", async () => {
    using dir = tempDir(`closure-ns-deep-${counter++}`, {
      "m.mjs": `
        export const sub = { method() { return this.val; }, val: 5, subUnused: "UNUSED_MARKER_SUBFIELD" };
        export const otherExport = { big: "UNUSED_MARKER_OTHEREXPORT" };
        export function unusedFn() { return "UNUSED_MARKER_FN"; }
      `,
      "main.mjs": `
        import { serialize } from "bun:closure";
        import { writeFileSync } from "node:fs";
        import * as m from "./m.mjs";
        const out = serialize(() => m.sub.method());
        writeFileSync(new URL("./out.mjs", import.meta.url), out);
        console.log(JSON.stringify({
          subFieldPruned: !out.includes("UNUSED_MARKER_SUBFIELD"),
          otherExportPruned: !out.includes("UNUSED_MARKER_OTHEREXPORT"),
          fnPruned: !out.includes("UNUSED_MARKER_FN"),
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
    expect(JSON.parse(lines[0])).toEqual({ subFieldPruned: true, otherExportPruned: true, fnPruned: true });
    expect(lines.find(l => l.startsWith("RESULT:"))).toBe("RESULT:5");
    expect({ stderr, exitCode }).toEqual({ stderr: expect.any(String), exitCode: 0 });
  });

  test("3-level re-export chain keeps only the used terminal binding", async () => {
    using dir = tempDir(`closure-chain3-${counter++}`, {
      "c.mjs": `
        export function leaf() { return "LEAF_VALUE"; }
        export function leafUnused() { return "UNUSED_MARKER_LEAF"; }
      `,
      "b.mjs": `export { leaf, leafUnused } from "./c.mjs"; export function bExtra() { return "UNUSED_MARKER_B"; }`,
      "a.mjs": `export { leaf, leafUnused } from "./b.mjs"; export function aExtra() { return "UNUSED_MARKER_A"; }`,
      "main.mjs": `
        import { serialize } from "bun:closure";
        import { writeFileSync } from "node:fs";
        import { leaf } from "./a.mjs";
        const out = serialize(() => leaf());
        writeFileSync(new URL("./out.mjs", import.meta.url), out);
        console.log(JSON.stringify({
          leafSiblingShaken: !out.includes("UNUSED_MARKER_LEAF"),
          bShaken: !out.includes("UNUSED_MARKER_B"),
          aShaken: !out.includes("UNUSED_MARKER_A"),
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
    expect(JSON.parse(lines[0])).toEqual({ leafSiblingShaken: true, bShaken: true, aShaken: true });
    expect(lines.find(l => l.startsWith("RESULT:"))).toBe("RESULT:LEAF_VALUE");
    expect({ stderr, exitCode }).toEqual({ stderr: expect.any(String), exitCode: 0 });
  });
});

// ===========================================================================
// FRONTIER COVERAGE — value types beyond the basics, and their interactions
// with circular refs, shared identity, classes, and pruning.
// ===========================================================================
describe("frontier: buffers & views", () => {
  test("captured ArrayBuffer round-trips its bytes", async () => {
    const buf = new ArrayBuffer(8);
    new Uint8Array(buf).set([1, 2, 3, 4, 5, 6, 7, 8]);
    void buf;
    const out = (await roundtrip(() => buf))();
    expect(out).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(out)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("Float64Array and BigInt64Array round-trip", async () => {
    const f = new Float64Array([1.5, -2.25, 3.125]);
    const b = new BigInt64Array([1n, -2n, 9007199254740993n]);
    void [f, b];
    const out = (await roundtrip(() => ({ f, b })))();
    expect([...out.f]).toEqual([1.5, -2.25, 3.125]);
    expect([...out.b]).toEqual([1n, -2n, 9007199254740993n]);
  });

  test("DataView over a buffer round-trips and reads correct values", async () => {
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setFloat64(0, 3.14159);
    void dv;
    const out = (await roundtrip(() => dv))();
    expect(out).toBeInstanceOf(DataView);
    expect(out.getFloat64(0)).toBeCloseTo(3.14159);
  });

  // INTERACTION: two views over ONE ArrayBuffer must stay aliased.
  test("two typed-array views over one ArrayBuffer keep a shared buffer", async () => {
    const buf = new ArrayBuffer(8);
    const a = new Uint8Array(buf);
    const b = new Uint8Array(buf);
    a.set([9, 9, 9, 9, 9, 9, 9, 9]);
    void [a, b];
    const out = (await roundtrip(() => ({ a, b })))();
    expect(out.a.buffer).toBe(out.b.buffer); // shared identity preserved
    out.a[0] = 42;
    expect(out.b[0]).toBe(42); // write through a is visible via b
  });

  // INTERACTION: a typed-array sub-view (byteOffset + length) over a buffer.
  test("a typed-array view with a byteOffset round-trips against its buffer", async () => {
    const buf = new ArrayBuffer(16);
    new Uint8Array(buf).set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    const mid = new Uint8Array(buf, 4, 4); // [4,5,6,7]
    void mid;
    const out = (await roundtrip(() => mid))();
    expect([...out]).toEqual([4, 5, 6, 7]);
    expect(out.byteOffset).toBe(4);
  });
});

describe("frontier: errors", () => {
  test("Error with a cause round-trips the cause", async () => {
    const inner = new RangeError("inner");
    const err = new Error("outer", { cause: inner });
    void err;
    const out = (await roundtrip(() => err))();
    expect(out.message).toBe("outer");
    expect(out.cause).toBeInstanceOf(RangeError);
    expect((out.cause as Error).message).toBe("inner");
  });

  test("AggregateError preserves its errors array", async () => {
    const agg = new AggregateError([new Error("a"), new TypeError("b")], "many");
    void agg;
    const out = (await roundtrip(() => agg))();
    expect(out.message).toBe("many");
    expect(out.errors.map((e: Error) => e.message)).toEqual(["a", "b"]);
  });

  test("a user Error subclass keeps its prototype and own fields", async () => {
    class HttpError extends Error {
      status: number;
      constructor(status: number, msg: string) {
        super(msg);
        this.name = "HttpError";
        this.status = status;
      }
    }
    const err = new HttpError(404, "not found");
    void err;
    const out = (await roundtrip(() => err))();
    expect(out.message).toBe("not found");
    expect(out.status).toBe(404);
    expect(out.name).toBe("HttpError");
  });

  test("Error with extra own properties round-trips them", async () => {
    const err = new Error("x") as Error & { code: string };
    err.code = "ECODE";
    void err;
    const out = (await roundtrip(() => err))() as Error & { code: string };
    expect(out.code).toBe("ECODE");
  });

  // INTERACTION: circular cause chain.
  test("a circular Error cause chain round-trips", async () => {
    const err = new Error("self") as Error & { cause?: unknown };
    err.cause = err;
    void err;
    const out = (await roundtrip(() => err))() as Error & { cause?: unknown };
    expect(out.cause).toBe(out);
  });
});

describe("frontier: boxed primitives & coercion", () => {
  test("boxed Number/String/Boolean round-trip as objects", async () => {
    const n = new Number(42);
    const s = new String("hi");
    const b = new Boolean(true);
    void [n, s, b];
    const out = (await roundtrip(() => ({ n, s, b })))();
    expect(typeof out.n).toBe("object");
    expect(out.n.valueOf()).toBe(42);
    expect(out.s.valueOf()).toBe("hi");
    expect(out.b.valueOf()).toBe(true);
  });

  test("object with Symbol.toPrimitive coerces correctly after round-trip", async () => {
    const money = {
      amount: 5,
      [Symbol.toPrimitive](hint: string) {
        return hint === "string" ? `$${this.amount}` : this.amount;
      },
    };
    void money;
    const out = (await roundtrip(() => money))();
    expect(+out).toBe(5);
    expect(`${out}`).toBe("$5");
  });
});

describe("frontier: frozen & sealed", () => {
  test("Object.freeze is preserved", async () => {
    const o = Object.freeze({ a: 1, b: 2 });
    void o;
    const out = (await roundtrip(() => o))();
    expect(Object.isFrozen(out)).toBe(true);
    expect(out).toEqual({ a: 1, b: 2 });
  });

  test("Object.seal is preserved", async () => {
    const o = Object.seal({ a: 1 });
    void o;
    const out = (await roundtrip(() => o))();
    expect(Object.isSealed(out)).toBe(true);
  });

  // INTERACTION: frozen + circular.
  test("a frozen circular object round-trips and stays frozen", async () => {
    const o: any = Object.freeze(Object.assign(Object.create(null), { v: 1 }));
    // freeze after wiring the cycle isn't possible if frozen; use a frozen graph
    const a: any = { v: 1 };
    const b: any = { v: 2, peer: a };
    a.peer = b;
    Object.freeze(a);
    Object.freeze(b);
    void [a, o];
    const out = (await roundtrip(() => a))();
    expect(Object.isFrozen(out)).toBe(true);
    expect(out.peer.peer).toBe(out);
  });

  // INTERACTION: frozen class instance.
  test("a frozen class instance round-trips frozen with working methods", async () => {
    class P {
      constructor(public x: number) {}
      get() {
        return this.x;
      }
    }
    const p = Object.freeze(new P(7));
    void p;
    const out = (await roundtrip(() => p))();
    expect(Object.isFrozen(out)).toBe(true);
    expect(out.get()).toBe(7);
  });
});

describe("frontier: collection key identity & guards", () => {
  // INTERACTION: a Map object-key is also captured elsewhere → identity shared.
  test("a Map object key shared with another capture keeps identity", async () => {
    const key = { id: 1 };
    const m = new Map<object, string>([[key, "v"]]);
    void [key, m];
    const out = (await roundtrip(() => ({ key, m })))();
    expect(out.m.get(out.key)).toBe("v"); // same key object identity
  });

  test("a Set of objects preserves element identity for membership", async () => {
    const x = { n: 1 };
    const s = new Set([x]);
    void [x, s];
    const out = (await roundtrip(() => ({ x, s })))();
    expect(out.s.has(out.x)).toBe(true);
  });

  test("WeakRef throws a clear error", () => {
    const r = new WeakRef({ a: 1 });
    void r;
    expect(() => serialize(() => r)).toThrow(/WeakRef/i);
  });

  test("FinalizationRegistry throws a clear error", () => {
    const reg = new FinalizationRegistry(() => {});
    void reg;
    expect(() => serialize(() => reg)).toThrow(/FinalizationRegistry/i);
  });
});

describe("frontier: language features & advanced", () => {
  test("SharedArrayBuffer and a view over it round-trip", async () => {
    const sab = new SharedArrayBuffer(4);
    new Uint8Array(sab).set([1, 2, 3, 4]);
    const view = new Int32Array(sab);
    void [sab, view];
    const out = (await roundtrip(() => ({ sab, view })))();
    expect(out.sab).toBeInstanceOf(SharedArrayBuffer);
    expect(out.view.buffer).toBe(out.sab); // shared identity
  });

  test("instance own accessor (defineProperty getter/setter) round-trips", async () => {
    const o: any = { _v: 1 };
    Object.defineProperty(o, "v", {
      get() {
        return this._v * 10;
      },
      set(n: number) {
        this._v = n;
      },
      configurable: true,
    });
    void o;
    const out = (await roundtrip(() => o))();
    expect(out.v).toBe(10);
    out.v = 5;
    expect(out.v).toBe(50);
  });

  test("`using` syntax round-trips and disposes the resource", async () => {
    const makeRes = (log: string[]) => ({
      [Symbol.dispose]() {
        log.push("disposed");
      },
    });
    void makeRes;
    const code = serialize(() => {
      const log: string[] = [];
      {
        using r = makeRes(log);
        log.push("used");
      }
      return log;
    });
    expect(code).toContain("using");
    using dir = tempDir(`closure-using-${counter++}`, { "mod.mjs": code });
    const fn = (await import(`${String(dir)}/mod.mjs`)).default as () => string[];
    expect(fn()).toEqual(["used", "disposed"]);
  });

  test("`await using` syntax round-trips and async-disposes", async () => {
    const makeRes = (log: string[]) => ({
      async [Symbol.asyncDispose]() {
        log.push("async-disposed");
      },
    });
    void makeRes;
    const fn = await roundtrip(async () => {
      const log: string[] = [];
      {
        await using r = makeRes(log);
        log.push("used");
      }
      return log;
    });
    await expect(fn()).resolves.toEqual(["used", "async-disposed"]);
  });

  // INTERACTION: using over a captured class instance whose dispose mutates a
  // shared captured cell.
  test("`using` over a captured disposable class instance", async () => {
    let disposeCount = 0;
    class Res {
      [Symbol.dispose]() {
        disposeCount++;
      }
    }
    const res = new Res();
    void [res, disposeCount];
    const fn = await roundtrip(() => {
      let ok = false;
      {
        using r = res;
        ok = true;
      }
      return ok;
    });
    expect(fn()).toBe(true);
  });

  test("private getter/setter accessors round-trip", async () => {
    class Box {
      #v = 1;
      get #doubled() {
        return this.#v * 2;
      }
      set #val(n: number) {
        this.#v = n;
      }
      read() {
        return this.#doubled;
      }
      write(n: number) {
        this.#val = n;
      }
    }
    const b = new Box();
    void b;
    const out = (await roundtrip(() => b))();
    expect(out.read()).toBe(2);
    out.write(10);
    expect(out.read()).toBe(20);
  });

  test("static private accessor round-trips", async () => {
    class Cfg {
      static #data = 5;
      static get #value() {
        return Cfg.#data * 3;
      }
      static read() {
        return Cfg.#value;
      }
    }
    void Cfg;
    const K = (await roundtrip(() => Cfg))();
    expect(K.read()).toBe(15);
  });

  // INTERACTION: private accessor + inheritance.
  test("private accessor used through an inherited method", async () => {
    class Base {
      #secret = 7;
      get #s() {
        return this.#secret;
      }
      reveal() {
        return this.#s;
      }
    }
    class Derived extends Base {}
    const d = new Derived();
    void d;
    const out = (await roundtrip(() => d))();
    expect(out.reveal()).toBe(7);
  });

  test("nested Proxy (proxy wrapping a proxy) round-trips", async () => {
    const inner = new Proxy({ a: 1 }, { get: (t, k) => (k === "a" ? 100 : (t as any)[k]) });
    const outer = new Proxy(inner, { get: (t, k) => (k === "a" ? (t as any).a + 1 : (t as any)[k]) });
    void outer;
    const out = (await roundtrip(() => outer))();
    expect((out as any).a).toBe(101);
  });

  // INTERACTION: proxy inside an object graph, with the target also captured.
  test("a proxy and its target captured together keep one target", async () => {
    const target = { n: 1 };
    const p = new Proxy(target, {});
    void [target, p];
    const out = (await roundtrip(() => ({ target, p })))();
    out.target.n = 42;
    expect((out.p as any).n).toBe(42); // proxy sees writes to the shared target
  });
});

describe("frontier: decorators", () => {
  test("a method decorator round-trips", async () => {
    const calls: string[] = [];
    function traced<T extends (...a: any[]) => any>(value: T, _ctx: any): T {
      return function (this: any, ...args: any[]) {
        calls.push("call");
        return value.apply(this, args);
      } as T;
    }
    void [calls, traced];
    class Svc {
      @traced
      greet() {
        return "hi";
      }
    }
    void Svc;
    const K = (await roundtrip(() => Svc))();
    expect(new K().greet()).toBe("hi");
  });
});

describe("frontier: top-level await context", () => {
  test("a closure capturing a top-level-await value round-trips", async () => {
    using dir = tempDir(`closure-tla-${counter++}`, {
      "runner.mjs": `
        import { serialize } from "bun:closure";
        import { writeFileSync } from "node:fs";
        const base = await Promise.resolve(40);     // top-level await
        const offset = await Promise.resolve(2);
        const code = serialize(() => base + offset);
        const url = new URL("./out.mjs", import.meta.url);
        writeFileSync(url, code);
        const ns = await import(url.href);
        process.stdout.write("RESULT:" + ns.default() + "\\n");
      `,
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), String(dir) + "/runner.mjs"],
      env: { ...bunEnv, BUN_DEBUG_QUIET_LOGS: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    const line = stdout.split("\n").find(l => l.startsWith("RESULT:"));
    expect({ line: line ?? `<none> ${stderr}`, exitCode }).toEqual({ line: "RESULT:42", exitCode: 0 });
  });
});

// ===========================================================================
// INTERACTION MATRIX — combinations of features that tend to expose gaps.
// ===========================================================================
describe("interactions: frozen + builtins", () => {
  test("a frozen Map round-trips frozen", async () => {
    const m = Object.freeze(new Map([["a", 1]]));
    void m;
    const out = (await roundtrip(() => m))();
    expect(Object.isFrozen(out)).toBe(true);
    expect(out.get("a")).toBe(1);
  });
  test("a frozen Set round-trips frozen", async () => {
    const s = Object.freeze(new Set([1, 2]));
    void s;
    const out = (await roundtrip(() => s))();
    expect(Object.isFrozen(out)).toBe(true);
    expect([...out]).toEqual([1, 2]);
  });
  test("a frozen Date round-trips frozen", async () => {
    const d = Object.freeze(new Date(0));
    void d;
    const out = (await roundtrip(() => d))();
    expect(Object.isFrozen(out)).toBe(true);
    expect(out.getTime()).toBe(0);
  });
  test("a frozen object holding a typed array round-trips", async () => {
    const o = Object.freeze({ bytes: new Uint8Array([1, 2, 3]) });
    void o;
    const out = (await roundtrip(() => o))();
    expect(Object.isFrozen(out)).toBe(true);
    expect([...out.bytes]).toEqual([1, 2, 3]);
  });
});

describe("interactions: cycles through collections", () => {
  test("a Map that contains itself round-trips", async () => {
    const m = new Map<string, unknown>();
    m.set("self", m);
    m.set("v", 1);
    void m;
    const out = (await roundtrip(() => m))();
    expect(out.get("self")).toBe(out);
    expect(out.get("v")).toBe(1);
  });
  test("a Set that contains an object referencing the Set", async () => {
    const s = new Set<any>();
    const o: any = { peer: s };
    s.add(o);
    void s;
    const out = (await roundtrip(() => s))();
    const first = [...out][0];
    expect(first.peer).toBe(out);
  });
  test("a Map keyed by a captured Date", async () => {
    const key = new Date(1000);
    const m = new Map([[key, "v"]]);
    void [key, m];
    const out = (await roundtrip(() => ({ key, m })))();
    expect(out.m.get(out.key)).toBe("v");
  });
});

describe("interactions: proxies over builtins", () => {
  test("a Proxy over a Map (method-binding handler) forwards through the target", async () => {
    // Plain `new Proxy(map, {}).get(k)` throws even without serialization (Map
    // methods need the internal slot), so use a handler that binds methods.
    const target = new Map([["a", 1]]);
    const p = new Proxy(target, {
      get(t, k) {
        const v = (t as any)[k];
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    void p;
    const out = (await roundtrip(() => p))();
    expect((out as any).get("a")).toBe(1);
  });
  test("a Proxy over an array round-trips", async () => {
    const p = new Proxy([10, 20, 30], { get: (t, k) => (k === "1" ? 999 : (t as any)[k]) });
    void p;
    const out = (await roundtrip(() => p))();
    expect((out as any)[0]).toBe(10);
    expect((out as any)[1]).toBe(999);
  });
});

describe("interactions: private fields + other features", () => {
  test("a private field holding a Date/Map round-trips", async () => {
    class Holder {
      #when = new Date(500);
      #cache = new Map([["k", "v"]]);
      when() {
        return this.#when.getTime();
      }
      cached() {
        return this.#cache.get("k");
      }
    }
    const h = new Holder();
    void h;
    const out = (await roundtrip(() => h))();
    expect(out.when()).toBe(500);
    expect(out.cached()).toBe("v");
  });
  test("a frozen class instance with a private field round-trips", async () => {
    class Sealed {
      #secret = 42;
      reveal() {
        return this.#secret;
      }
    }
    const s = Object.freeze(new Sealed());
    void s;
    const out = (await roundtrip(() => s))();
    expect(Object.isFrozen(out)).toBe(true);
    expect(out.reveal()).toBe(42);
  });
  test("a bound method capturing private state via this", async () => {
    class Counter {
      #n = 10;
      step() {
        return ++this.#n;
      }
    }
    const c = new Counter();
    const bound = c.step.bind(c);
    void bound;
    const out = await roundtrip(() => bound());
    expect(out()).toBe(11);
    expect(out()).toBe(12);
  });
});

describe("interactions: guards fire when nested", () => {
  test("a WeakMap nested in a captured object still throws", () => {
    const o = { inner: new WeakMap() };
    void o;
    expect(() => serialize(() => o)).toThrow(/WeakMap/i);
  });
  test("a generator object nested in a Map still throws", () => {
    function* g() {
      yield 1;
    }
    const m = new Map([["gen", g()]]);
    void m;
    expect(() => serialize(() => m)).toThrow(/suspended execution state/i);
  });
});

describe("interactions: shared cells across function kinds", () => {
  test("a shared cell mutated by both a generator and a plain function", async () => {
    let total = 0;
    function* accumulate(xs: number[]) {
      for (const x of xs) {
        total += x;
        yield total;
      }
    }
    const read = () => total;
    void [accumulate, read, total];
    const fn = await roundtrip(() => {
      const seen = [...accumulate([1, 2, 3])];
      return { seen, total: read() };
    });
    expect(fn()).toEqual({ seen: [1, 3, 6], total: 6 });
  });
});

describe("interactions: builtin subclasses & deep combos", () => {
  test("a class extends Array instance round-trips with its prototype", async () => {
    class Stack extends Array {
      peek() {
        return this[this.length - 1];
      }
    }
    const s = new Stack();
    s.push(1, 2, 3);
    void s;
    const out = (await roundtrip(() => s))();
    expect([...out]).toEqual([1, 2, 3]);
    expect(out.peek()).toBe(3);
    expect(out instanceof out.constructor).toBe(true);
  });

  test("a class extends Map instance round-trips with its prototype", async () => {
    class Registry extends Map {
      getOr(k: string, d: unknown) {
        return this.has(k) ? this.get(k) : d;
      }
    }
    const r = new Registry();
    r.set("a", 1);
    void r;
    const out = (await roundtrip(() => r))();
    expect(out.get("a")).toBe(1);
    expect(out.getOr("z", "def")).toBe("def");
  });

  test("a class extends Set instance round-trips", async () => {
    class Tags extends Set {
      toggle(x: unknown) {
        this.has(x) ? this.delete(x) : this.add(x);
        return this;
      }
    }
    const t = new Tags([1, 2]);
    void t;
    const out = (await roundtrip(() => t))();
    expect([...out]).toEqual([1, 2]);
    out.toggle(3);
    expect(out.has(3)).toBe(true);
  });

  test("a frozen array round-trips frozen", async () => {
    const a = Object.freeze([1, 2, 3]);
    void a;
    const out = (await roundtrip(() => a))();
    expect(Object.isFrozen(out)).toBe(true);
    expect(out).toEqual([1, 2, 3]);
  });

  test("an object with a custom (non-class) prototype round-trips the chain", async () => {
    const proto = {
      greet() {
        return "hi " + (this as any).who;
      },
    };
    const o = Object.create(proto);
    o.who = "x";
    void o;
    const out = (await roundtrip(() => o))();
    expect(out.greet()).toBe("hi x");
    expect(Object.getPrototypeOf(out).greet).toBeInstanceOf(Function);
  });

  test("Symbol.toPrimitive on a frozen object still coerces", async () => {
    const o = Object.freeze({
      v: 9,
      [Symbol.toPrimitive]() {
        return this.v;
      },
    });
    void o;
    const out = (await roundtrip(() => o))();
    expect(Object.isFrozen(out)).toBe(true);
    expect(+out).toBe(9);
  });

  test("a Map keyed by another Map round-trips identity", async () => {
    const innerKey = new Map([["x", 1]]);
    const outer = new Map([[innerKey, "found"]]);
    void [innerKey, outer];
    const out = (await roundtrip(() => ({ innerKey, outer })))();
    expect(out.outer.get(out.innerKey)).toBe("found");
  });

  test("an accessor pair sharing one captured cell stays consistent", async () => {
    let store = 0;
    const o = {
      get v() {
        return store;
      },
      set v(n: number) {
        store = n;
      },
    };
    void [store, o];
    const out = (await roundtrip(() => o))();
    out.v = 7;
    expect(out.v).toBe(7);
  });

  test("a function bound to a Proxy receiver round-trips", async () => {
    const target = { n: 5 };
    const p = new Proxy(target, { get: (t, k) => (k === "n" ? (t as any).n * 2 : (t as any)[k]) });
    function read(this: any) {
      return this.n;
    }
    const bound = read.bind(p);
    void bound;
    const out = await roundtrip(() => bound());
    expect(out()).toBe(10); // proxy get trap doubles n
  });

  // The everything-bagel: frozen subclass instance, private field, inherited
  // method using super, a Map field, all at once.
  test("mega: frozen subclass instance with private field + Map + super", async () => {
    class Base {
      kind() {
        return "base";
      }
    }
    class Store extends Base {
      #items = new Map<string, number>([["a", 1]]);
      kind() {
        return "store:" + super.kind();
      }
      count() {
        return this.#items.size;
      }
      get(k: string) {
        return this.#items.get(k);
      }
    }
    const s = Object.freeze(new Store());
    void s;
    const out = (await roundtrip(() => s))();
    expect(Object.isFrozen(out)).toBe(true);
    expect(out.kind()).toBe("store:base");
    expect(out.count()).toBe(1);
    expect(out.get("a")).toBe(1);
  });

  test("an async function using `await using` over a captured disposable", async () => {
    const makeRes = (log: string[]) => ({
      async [Symbol.asyncDispose]() {
        log.push("closed");
      },
      read() {
        return 1;
      },
    });
    void makeRes;
    const fn = await roundtrip(async () => {
      const log: string[] = [];
      let v = 0;
      {
        await using r = makeRes(log);
        v = r.read();
      }
      return { v, log };
    });
    await expect(fn()).resolves.toEqual({ v: 1, log: ["closed"] });
  });
});

describe("interactions: deeper adversarial combos", () => {
  test("a captured function with its own properties keeps them", async () => {
    const fn: any = (x: number) => x + 1;
    fn.version = 2;
    fn.meta = { author: "x" };
    void fn;
    const out = (await roundtrip(() => fn))();
    expect(out(10)).toBe(11);
    expect(out.version).toBe(2);
    expect(out.meta).toEqual({ author: "x" });
  });

  test("a class extends Date instance round-trips", async () => {
    class Timestamp extends Date {
      iso() {
        return this.toISOString();
      }
    }
    const t = new Timestamp(0);
    void t;
    const out = (await roundtrip(() => t))();
    expect(out.getTime()).toBe(0);
    expect(out.iso()).toBe("1970-01-01T00:00:00.000Z");
  });

  test("a 3-level inheritance chain rooted at a builtin (extends Array)", async () => {
    class A extends Array {
      a() {
        return "a";
      }
    }
    class B extends A {
      b() {
        return "b";
      }
    }
    const inst = new B();
    inst.push(1, 2);
    void inst;
    const out = (await roundtrip(() => inst))();
    expect([...out]).toEqual([1, 2]);
    expect(out.a()).toBe("a");
    expect(out.b()).toBe("b");
  });

  test("a class with a static field referencing itself (circular static)", async () => {
    class Node {
      static root: Node;
      label = "n";
    }
    Node.root = new Node();
    void Node;
    const K = (await roundtrip(() => Node))();
    expect(K.root).toBeInstanceOf(K);
    expect(K.root.label).toBe("n");
  });

  test("a frozen Map containing frozen objects", async () => {
    const m = Object.freeze(new Map([["k", Object.freeze({ v: 1 })]]));
    void m;
    const out = (await roundtrip(() => m))();
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.get("k"))).toBe(true);
    expect(out.get("k").v).toBe(1);
  });

  test("an array of closures sharing one cell stays shared", async () => {
    let n = 0;
    const fns = [() => ++n, () => n];
    void [n, fns];
    const out = (await roundtrip(() => fns))();
    expect(out[0]()).toBe(1);
    expect(out[0]()).toBe(2);
    expect(out[1]()).toBe(2); // reader sees the shared increment
  });

  test("a Proxy whose handler captures a shared cell", async () => {
    let calls = 0;
    const p = new Proxy(
      { a: 1 },
      {
        get(t, k) {
          calls++;
          return (t as any)[k];
        },
      },
    );
    const count = () => calls;
    void [calls, p, count];
    const out = await roundtrip(() => {
      const v = (p as any).a;
      return { v, calls: count() };
    });
    expect(out()).toEqual({ v: 1, calls: 1 });
  });

  test("a Proxy used as a Map key keeps identity", async () => {
    const key = new Proxy({}, {});
    const m = new Map([[key, "v"]]);
    void [key, m];
    const out = (await roundtrip(() => ({ key, m })))();
    expect(out.m.get(out.key)).toBe("v");
  });

  test("a getter that returns `this` (circular via accessor)", async () => {
    const o = {
      get self() {
        return this;
      },
      v: 5,
    };
    void o;
    const out = (await roundtrip(() => o))();
    expect(out.self).toBe(out);
    expect(out.self.v).toBe(5);
  });

  test("a field-initializer-only arrow capture round-trips (AST + native scope resolve)", async () => {
    function make(offset: number) {
      return class {
        add = (x: number) => x + offset;
      };
    }
    const C = make(100);
    void C;
    const K = (await roundtrip(() => C))();
    expect(new K().add(5)).toBe(105);
  });

  test("field-init capture: multiple instance + static field values", async () => {
    function make(a: number, b: string) {
      return class {
        x = a * 2;
        y = a + 1;
        static label = b;
      };
    }
    const C = make(10, "L");
    void C;
    const K = (await roundtrip(() => C))();
    const inst = new K();
    expect(inst.x).toBe(20);
    expect(inst.y).toBe(11);
    expect((K as any).label).toBe("L");
  });

  test("field-init capture: initializer calls a captured function", async () => {
    function make(factory: () => { v: number }) {
      return class {
        state = factory();
      };
    }
    const C = make(() => ({ v: 7 }));
    void C;
    const K = (await roundtrip(() => C))();
    expect(new K().state).toEqual({ v: 7 });
  });

  test("Map with NaN and -0 keys preserves lookup semantics", async () => {
    const m = new Map<number, string>([
      [NaN, "nan"],
      [-0, "negzero"],
    ]);
    void m;
    const out = (await roundtrip(() => m))();
    expect(out.get(NaN)).toBe("nan");
    expect(out.get(0)).toBe("negzero"); // -0 and 0 are the same Map key
  });
});

describe("interactions: exotic corners", () => {
  test("a typed array and a DataView over ONE buffer share it", async () => {
    const buf = new ArrayBuffer(8);
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    u8.set([1, 2, 3, 4, 5, 6, 7, 8]);
    void [buf, u8, dv];
    const out = (await roundtrip(() => ({ u8, dv })))();
    expect(out.u8.buffer).toBe(out.dv.buffer);
    out.u8[0] = 9;
    expect(out.dv.getUint8(0)).toBe(9); // write via typed array visible via DataView
  });

  test("a bound function whose bound args include a captured Map and instance", async () => {
    class P {
      constructor(public x: number) {}
    }
    function combine(m: Map<string, number>, p: P, extra: number) {
      return m.get("a")! + p.x + extra;
    }
    const m = new Map([["a", 10]]);
    const bound = combine.bind(null, m, new P(20));
    void bound;
    const out = await roundtrip(() => bound(5));
    expect(out()).toBe(35);
  });

  test("a Proxy with has / deleteProperty / ownKeys traps round-trips", async () => {
    const p = new Proxy({ a: 1, b: 2 } as Record<string, number>, {
      has: (t, k) => k in t || k === "virtual",
      ownKeys: t => Reflect.ownKeys(t),
      getOwnPropertyDescriptor: (t, k) => Object.getOwnPropertyDescriptor(t, k),
    });
    void p;
    const out = (await roundtrip(() => p))();
    expect("virtual" in out).toBe(true);
    expect("a" in out).toBe(true);
    expect(Object.keys(out).sort()).toEqual(["a", "b"]);
  });

  test("a class with a custom Symbol.hasInstance round-trips", async () => {
    class Even {
      static [Symbol.hasInstance](n: unknown) {
        return typeof n === "number" && n % 2 === 0;
      }
    }
    void Even;
    const K = (await roundtrip(() => Even))();
    expect((4 as any) instanceof K).toBe(true);
    expect((3 as any) instanceof K).toBe(false);
  });

  test("a prototype getter capturing a module free var round-trips", async () => {
    function makeClass(scale: number) {
      return class {
        base = 10;
        get scaled() {
          return this.base * scale;
        }
      };
    }
    const C = makeClass(3);
    void C;
    const K = (await roundtrip(() => C))();
    expect(new K().scaled).toBe(30);
  });

  test("a deeply nested mixed graph: Map → array → instance → private → Date", async () => {
    class Leaf {
      #when = new Date(7000);
      stamp() {
        return this.#when.getTime();
      }
    }
    const graph = new Map<string, unknown[]>([["items", [new Leaf(), { tag: "x" }]]]);
    void graph;
    const out = (await roundtrip(() => graph))();
    const items = out.get("items")!;
    expect((items[0] as Leaf).stamp()).toBe(7000);
    expect((items[1] as any).tag).toBe("x");
  });

  test("a frozen class instance with an async generator method", async () => {
    class Source {
      base = 100;
      async *take(n: number) {
        for (let i = 0; i < n; i++) yield this.base + i;
      }
    }
    const s = Object.freeze(new Source());
    void s;
    const out = (await roundtrip(() => s))();
    expect(Object.isFrozen(out)).toBe(true);
    expect(await Array.fromAsync(out.take(3))).toEqual([100, 101, 102]);
  });

  test("a function shared between a Map value and a direct capture keeps identity", async () => {
    const f = (x: number) => x * 2;
    const m = new Map<string, unknown>([["fn", f]]);
    void [f, m];
    const out = (await roundtrip(() => ({ f, m })))();
    expect(out.m.get("fn")).toBe(out.f); // same function identity
    expect((out.f as any)(21)).toBe(42);
  });

  test("re-entrant getters (one getter reads another)", async () => {
    const o = {
      _x: 5,
      get a() {
        return this._x + 1;
      },
      get b() {
        return this.a * 10;
      },
    };
    void o;
    const out = (await roundtrip(() => o))();
    expect(out.b).toBe(60);
  });

  test("an object with NaN and -0 values (not keys) round-trips exactly", async () => {
    const o = { nan: NaN, negZero: -0, arr: [NaN, -0, Infinity] };
    void o;
    const out = (await roundtrip(() => o))();
    expect(Number.isNaN(out.nan)).toBe(true);
    expect(1 / out.negZero).toBe(-Infinity);
    expect(Number.isNaN(out.arr[0])).toBe(true);
    expect(1 / out.arr[1]).toBe(-Infinity);
    expect(out.arr[2]).toBe(Infinity);
  });
});
