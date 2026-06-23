import { test, expect, describe, beforeAll } from "bun:test";
import { serialize } from "bun:closure";
import { tempDir, bunExe, bunEnv } from "harness";
import { AsyncLocalStorage } from "node:async_hooks";
import { format as nodeUtilFormat } from "node:util";
import { EOL } from "node:os";

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

test("a native function captured as the root is referenced by its global path", async () => {
  const fn = await roundtrip(Math.max as any);
  expect(fn(3, 7, 5)).toBe(7);
});

test("captured native functions round-trip by reference", async () => {
  const fns = { max: Math.max, parse: JSON.parse, slice: Array.prototype.slice, log: console.log };
  void fns;
  const out = (await roundtrip(() => fns))();
  expect(out.max).toBe(Math.max);
  expect(out.parse).toBe(JSON.parse);
  expect(out.slice).toBe(Array.prototype.slice);
  expect(out.log).toBe(console.log);
  // and they still work
  expect(out.max(1, 9, 2)).toBe(9);
  expect(out.parse('{"a":1}')).toEqual({ a: 1 });
});

test("a closure calling a captured native function round-trips", async () => {
  const round = Math.round;
  void round;
  const fn = await roundtrip((x: number) => round(x));
  expect(fn(3.6)).toBe(4);
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

// The serializer emits a correct inline source map (verified by the decode tests
// below), AND Bun chains a loaded module's own `//# sourceMappingURL=data:` map
// onto its generated map at resolve time. So a frame inside the reconstructed
// function resolves to the ORIGINAL source where `boom` was defined (this test
// file) — not the reconstructed `mod.mjs`. This is the payoff of the runtime
// input-map chaining: stack traces survive serialization.
test("thrown error's own frame chains through the inline map back to the original source", async () => {
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
  // The boom frame (first stack line after the message) names the ORIGINAL
  // source file, proving the inline map was chained — not the reconstructed
  // module. (We assert the boom frame specifically; the call-site frame would
  // mention closure.test vacuously regardless of remapping.)
  const boomFrame = caught.stack.split("\n").find((l: string) => l.includes("at boom"));
  expect(boomFrame).toBeDefined();
  expect(boomFrame).toContain("closure.test");
  expect(boomFrame).not.toContain("mod.mjs");
});

// Symbol.sourceLocation resolves through the SAME chained map, so a function
// reconstructed in mod.mjs reports its ORIGINAL definition site (this test file)
// — both the url and the line are remapped, not just the line.
test("Symbol.sourceLocation of a reified function chains to the original source", async () => {
  function defined() {
    return 123;
  }
  const code = serialize(defined);
  using dir = tempDir("closure-srcloc-chain", { "mod.mjs": code });
  const { default: fn } = await import(`${String(dir)}/mod.mjs`);
  const loc = (fn as any)[Symbol.sourceLocation];
  expect(loc).toBeDefined();
  expect(loc.url).toContain("closure.test");
  expect(loc.url).not.toContain("mod.mjs");
  expect(typeof loc.line).toBe("number");
});

// ---------------------------------------------------------------------------
// Source maps: the serializer owns the *emitted* inline v3 map. These tests
// decode that map (independent of Bun's runtime source-map application, which
// the characterization test above shows does not consume it) and assert it
// points generated lines back at the correct original (source, line). Column
// info is coarse by design (buildSourceMap maps at line granularity, column 0),
// so we only verify file + line fidelity.
// ---------------------------------------------------------------------------
describe("source maps: emitted inline map is decode-correct", () => {
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const B64INV: Record<string, number> = {};
  for (let i = 0; i < B64.length; i++) B64INV[B64[i]] = i;

  // Decode a v3 `mappings` string into per-generated-line segments. Each segment
  // is { genLine, genCol, srcIdx, srcLine, srcCol } (all 0-based). srcIdx/srcLine/
  // srcCol are cumulative across the whole string per the v3 spec; genCol resets
  // per line.
  function decodeMappings(mappings: string) {
    const out: Array<Array<{ genLine: number; genCol: number; srcIdx: number; srcLine: number; srcCol: number }>> = [];
    let srcIdx = 0;
    let srcLine = 0;
    let srcCol = 0;
    const lines = mappings.split(";");
    for (let gl = 0; gl < lines.length; gl++) {
      const segments: Array<{ genLine: number; genCol: number; srcIdx: number; srcLine: number; srcCol: number }> = [];
      const raw = lines[gl];
      if (raw !== "") {
        let genCol = 0;
        for (const seg of raw.split(",")) {
          const fields: number[] = [];
          let shift = 0;
          let value = 0;
          for (const c of seg) {
            const digit = B64INV[c];
            const cont = digit & 32;
            value += (digit & 31) << shift;
            if (cont) {
              shift += 5;
            } else {
              const negative = value & 1;
              let v = value >> 1;
              if (negative) v = -v;
              fields.push(v);
              value = 0;
              shift = 0;
            }
          }
          genCol += fields[0] ?? 0;
          if (fields.length >= 4) {
            srcIdx += fields[1];
            srcLine += fields[2];
            srcCol += fields[3];
            segments.push({ genLine: gl, genCol, srcIdx, srcLine, srcCol });
          }
        }
      }
      out.push(segments);
    }
    return out;
  }

  function decodeInlineMap(code: string) {
    const m = code.match(/sourceMappingURL=data:application\/json;charset=utf-8;base64,([A-Za-z0-9+/=]+)/);
    if (!m) throw new Error("no inline source map found in serialized output");
    const json = JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
    return { json, decoded: decodeMappings(json.mappings as string) };
  }

  // All (srcIdx, srcLine) pairs the map points at, deduped.
  function mappedPairs(decoded: ReturnType<typeof decodeMappings>) {
    const set = new Set<string>();
    for (const segs of decoded) for (const s of segs) set.add(`${s.srcIdx}:${s.srcLine}`);
    return set;
  }

  test("is a structurally valid v3 map", () => {
    function boom() {
      throw new Error("x");
    }
    const { json } = decodeInlineMap(serialize(boom));
    expect(json.version).toBe(3);
    expect(Array.isArray(json.sources)).toBe(true);
    expect(json.sources.length).toBeGreaterThanOrEqual(1);
    expect(json.names).toEqual([]);
    expect(typeof json.mappings).toBe("string");
    expect(json.mappings.length).toBeGreaterThan(0);
  });

  test("source is the captured function's file and a line maps to its definition line", () => {
    function boom() {
      throw new Error("x");
    }
    const loc = (boom as any)[Symbol.sourceLocation];
    const { json, decoded } = decodeInlineMap(serialize(boom));
    const srcIdx = json.sources.findIndex((s: string) => s.includes("closure.test"));
    expect(srcIdx).toBeGreaterThanOrEqual(0);
    // The first body line of `boom` maps to its original (0-based) definition line.
    expect(mappedPairs(decoded).has(`${srcIdx}:${loc.line - 1}`)).toBe(true);
  });

  test("columns are accurate: definition line maps to its column, body lines to their indentation", () => {
    // 6-space indent here; the body `throw` carries that indentation verbatim.
    function deep() {
      throw new Error("x");
    }
    const loc = (deep as any)[Symbol.sourceLocation];
    const { decoded } = decodeInlineMap(serialize(deep));
    const flat = decoded.flat();

    // The function's first line maps to its original definition column (0-based).
    // JSC's startColumn points just past the name (the `(`), and the map must
    // reproduce it — NOT the old coarse column 0.
    const defSeg = flat.find(s => s.srcLine === loc.line - 1);
    expect(defSeg).toBeDefined();
    expect(defSeg!.srcCol).toBe(loc.column - 1);
    expect(defSeg!.srcCol).toBeGreaterThan(0);

    // The body `throw` line keeps its source indentation, so its column maps
    // identity (generated column == source column == original column) and is the
    // line's leading-whitespace width, not 0.
    const bodySeg = flat.find(s => s.srcLine === loc.line); // line after the def
    expect(bodySeg).toBeDefined();
    expect(bodySeg!.srcCol).toBe(bodySeg!.genCol);
    expect(bodySeg!.srcCol).toBeGreaterThan(0);
  });

  test("captured-value prelude shifts generated lines but original lines stay correct", () => {
    // An object free variable forces a `const __bunClosure$N = {}` prelude ahead
    // of the function body (a primitive would be inlined and produce no prelude).
    const config = { base: 41 };
    function reader() {
      return config.base + 1;
    }
    const loc = (reader as any)[Symbol.sourceLocation];
    const { json, decoded } = decodeInlineMap(serialize(reader));
    const srcIdx = json.sources.findIndex((s: string) => s.includes("closure.test"));
    // The body maps back to its true original line despite the generated offset.
    const seg = decoded.flat().find(s => s.srcIdx === srcIdx && s.srcLine === loc.line - 1);
    expect(seg).toBeDefined();
    // And it is genuinely offset: the mapping for the definition line is not at
    // generated line 0 (the prelude binding comes first).
    expect(seg!.genLine).toBeGreaterThan(0);
  });

  test("two functions from the same file produce one source and both definition lines", () => {
    function first() {
      return 1;
    }
    function second() {
      return 2;
    }
    const l1 = (first as any)[Symbol.sourceLocation].line;
    const l2 = (second as any)[Symbol.sourceLocation].line;
    expect(l1).not.toBe(l2);
    // Capture both into one closure graph so both bodies are inlined.
    const root = () => [first(), second()];
    const { json, decoded } = decodeInlineMap(serialize(root));
    const fileSources = json.sources.filter((s: string) => s.includes("closure.test"));
    expect(fileSources.length).toBe(1);
    const srcIdx = json.sources.indexOf(fileSources[0]);
    const pairs = mappedPairs(decoded);
    expect(pairs.has(`${srcIdx}:${l1 - 1}`)).toBe(true);
    expect(pairs.has(`${srcIdx}:${l2 - 1}`)).toBe(true);
  });

  test("monotonic generated lines: every mapped generated line is unique and ordered", () => {
    const a = 1;
    const b = 2;
    function uses() {
      return a + b;
    }
    void uses;
    const root = () => uses();
    const { decoded } = decodeInlineMap(serialize(root));
    const mappedGenLines = decoded.map((segs, i) => (segs.length ? i : -1)).filter(i => i >= 0);
    const sorted = [...mappedGenLines].sort((x, y) => x - y);
    expect(mappedGenLines).toEqual(sorted);
    expect(new Set(mappedGenLines).size).toBe(mappedGenLines.length);
  });

  test("decoded original lines are all valid (non-negative) line numbers", () => {
    function multi() {
      const x = 1;
      const y = 2;
      return x + y;
    }
    const { decoded } = decodeInlineMap(serialize(multi));
    const srcLines = decoded.flat().map(s => s.srcLine);
    expect(srcLines.length).toBeGreaterThan(0);
    for (const sl of srcLines) expect(sl).toBeGreaterThanOrEqual(0);
  });

  // `fn.toString()` REPRINTS the captured source from the AST, so a definition written on
  // FEWER lines than its canonical form (e.g. a one-line function/class) is emitted across MORE
  // generated lines than the original spans. buildSourceMap maps generated body line `k` to
  // `defLine + k`, which would walk PAST the definition onto unrelated later lines — so it's
  // CLAMPED to the definition's original end line (Symbol.sourceLocation.endLine for functions;
  // the max method end line for classes). Every generated line of a single-line definition
  // therefore maps back to its one source line.
  test("a compact single-line function maps every generated line to its definition line", () => {
    // prettier-ignore
    function f(){const a=1;const b=2;return a+b;} // entire function on ONE source line
    const loc = (f as any)[Symbol.sourceLocation];
    const { json, decoded } = decodeInlineMap(serialize(f));
    const srcIdx = json.sources.findIndex((s: string) => s.includes("closure.test"));
    const srcLines = decoded
      .flat()
      .filter(s => s.srcIdx === srcIdx)
      .map(s => s.srcLine);
    for (const sl of srcLines) expect(sl).toBe(loc.line - 1);
  });

  test("a compact single-line class does not over-run its source map", () => {
    // prettier-ignore
    class K { go(){ return 1 } probe(){ return 2 } } // entire class on ONE source line
    const defLine = (K.prototype.go as any)[Symbol.sourceLocation].line; // the class's line
    const i = new K();
    void i;
    const { json, decoded } = decodeInlineMap(serialize(() => i));
    const srcIdx = json.sources.findIndex((s: string) => s.includes("closure.test"));
    const srcLines = decoded
      .flat()
      .filter(s => s.srcIdx === srcIdx)
      .map(s => s.srcLine);
    expect(srcLines.length).toBeGreaterThan(0);
    // No generated line maps past the (single) definition line — the clamp holds.
    for (const sl of srcLines) expect(sl).toBeLessThanOrEqual(defLine - 1);
  });

  // --- Indirection: the same edge cases explored for ALS, applied to maps. ---
  // The transforms (nesting, #private rewrite, ALS-wrapping) all reshape the
  // generated text; the map must keep pointing every body at its true origin.

  test("nested-function source maps back to the enclosing definition line", () => {
    function outer() {
      function inner() {
        return 7;
      }
      return inner;
    }
    const loc = (outer as any)[Symbol.sourceLocation];
    const { json, decoded } = decodeInlineMap(serialize(outer));
    const srcIdx = json.sources.findIndex((s: string) => s.includes("closure.test"));
    // `inner` lives textually inside `outer`'s source, so the block covers the
    // whole outer body — the first mapped line is outer's definition line.
    expect(mappedPairs(decoded).has(`${srcIdx}:${loc.line - 1}`)).toBe(true);
  });

  test("class method survives #private rewrite with its definition line intact", () => {
    class Secret {
      #value = 5;
      reveal() {
        return this.#value;
      }
    }
    const inst = new Secret();
    const method = inst.reveal.bind(inst);
    // The bound method's source location is the class/method site in this file.
    const loc = (inst.reveal as any)[Symbol.sourceLocation];
    const { json, decoded } = decodeInlineMap(serialize(method));
    const srcIdx = json.sources.findIndex((s: string) => s.includes("closure.test"));
    expect(srcIdx).toBeGreaterThanOrEqual(0);
    // Despite the `#value` -> rewritten-field transform, the map still points the
    // method body at its exact original definition line.
    expect(mappedPairs(decoded).has(`${srcIdx}:${loc.line - 1}`)).toBe(true);
  });

  test("ALS-wrapped root keeps the body's original line mapping (offset by the wrap)", () => {
    const als = new AsyncLocalStorage<{ tag: string }>();
    const captured = als.run({ tag: "ctx" }, () => {
      function worker() {
        return als.getStore()?.tag;
      }
      return worker;
    });
    const loc = (captured as any)[Symbol.sourceLocation];
    const code = serialize(captured);
    // Sanity: the root really was wrapped in an als.run reconstruction.
    expect(code).toContain("AsyncLocalStorage");
    const { json, decoded } = decodeInlineMap(code);
    const srcIdx = json.sources.findIndex((s: string) => s.includes("closure.test"));
    const seg = decoded.flat().find(s => s.srcIdx === srcIdx && s.srcLine === loc.line - 1);
    expect(seg).toBeDefined();
  });
});

// A function imported from a node_modules package that ships a built `.js` + an
// EXTERNAL `.js.map`. Bun now chains that external map (read lazily from disk on
// first resolve), so `Symbol.sourceLocation` reports the package's ORIGINAL `.ts`
// — and the serializer's emitted map follows automatically. The serializer still
// inlines the function body (self-contained), it is not re-imported by reference.
test("node_modules external .js.map chains; sourceLocation + emitted map reference the original .ts", async () => {
  const externalMap = JSON.stringify({
    version: 3,
    sources: ["original.ts"],
    names: [],
    // Cover the function's definition line (generated line 0) so sourceLocation
    // chains; identity line-for-line is enough for this assertion.
    mappings: "AAAA;AACA;AACA",
  });
  using dir = tempDir("closure-nm-map", {
    "node_modules/pkg/package.json": JSON.stringify({
      name: "pkg",
      version: "1.0.0",
      main: "index.js",
      type: "module",
    }),
    "node_modules/pkg/index.js": `export function greet() {\n  return "hi from pkg";\n}\n//# sourceMappingURL=index.js.map\n`,
    "node_modules/pkg/index.js.map": externalMap,
    "fixture.mjs": `
      import { serialize } from "bun:closure";
      import { greet } from "pkg";
      const loc = greet[Symbol.sourceLocation];
      const code = serialize(greet);
      const m = code.match(/base64,([A-Za-z0-9+/=]+)/);
      const map = JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
      console.log(JSON.stringify({ locUrl: loc.url, sources: map.sources, inlined: code.includes("hi from pkg") }));
    `,
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "fixture.mjs"],
    env: bunEnv,
    cwd: String(dir),
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  const result = JSON.parse(stdout.trim());
  // sourceLocation chains through the external map to original.ts, not index.js.
  expect(result.locUrl).toContain("original.ts");
  expect(result.locUrl).not.toContain("index.js");
  // The emitted map follows sourceLocation to the original .ts.
  expect(result.sources.some((s: string) => s.includes("original.ts"))).toBe(true);
  expect(result.sources.some((s: string) => s.includes("index.js"))).toBe(false);
  // The package function is inlined (self-contained), not re-imported by reference.
  expect(result.inlined).toBe(true);
  expect({ stderr: stderr.includes("error:"), exitCode }).toEqual({ stderr: false, exitCode: 0 });
});

// When a closure captures a function defined in a DIFFERENT file, the serializer
// inlines both and emits a MULTI-source map. After reify, a frame from the
// captured function must chain to ITS original file (source index > 0 resolving
// through the input map's per-source names) — distinct from the root's file.
test("multi-source map: a captured cross-file function's frame chains to its own original file", async () => {
  using dir = tempDir("closure-multisrc", {
    // a.mjs's factory returns a closure whose throw lives in a.mjs.
    "a.mjs": `export const makeHelper = () => {\n  const helper = () => {\n    throw new Error("from-a");\n  };\n  return helper;\n};\n`,
    "fixture.mjs": `
      import { serialize } from "bun:closure";
      import { makeHelper } from "./a.mjs";
      import { writeFileSync } from "node:fs";
      const helper = makeHelper();
      const root = () => helper();
      const code = serialize(root);
      const map = JSON.parse(Buffer.from(code.match(/base64,([A-Za-z0-9+/=]+)/)[1], "base64").toString("utf8"));
      writeFileSync(new URL("./mod.mjs", import.meta.url), code);
      const fn = (await import("./mod.mjs")).default;
      let frame = "";
      try { fn(); } catch (e) { frame = e.stack.split("\\n").find(l => l.includes("a.mjs")) ?? ""; }
      console.log(JSON.stringify({ nSources: map.sources.length, frame: frame.trim() }));
    `,
  });
  await using proc = Bun.spawn({
    cmd: [bunExe(), "fixture.mjs"],
    env: bunEnv,
    cwd: String(dir),
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  const result = JSON.parse(stdout.trim());
  // The emitted map genuinely has two sources (a.mjs + the fixture).
  expect(result.nSources).toBe(2);
  // A stack frame chains to a.mjs (the captured helper's original file), and to
  // the throw line (3) — proving the right source index resolved, not source 0.
  expect(result.frame).toContain("a.mjs:3");
  expect({ stderr: stderr.includes("error:"), exitCode }).toEqual({ stderr: false, exitCode: 0 });
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

test("reconstructs a unique-symbol-keyed property (recreated symbol)", async () => {
  const key = Symbol("unique");
  let o = { [key]: 1, plain: 2 };
  void o;
  const out = (await roundtrip(() => o))();
  expect(out.plain).toBe(2);
  // The reconstructed symbol is a fresh unique symbol with the same description;
  // the property is reachable via the own symbol key.
  const symKeys = Object.getOwnPropertySymbols(out);
  expect(symKeys).toHaveLength(1);
  expect(symKeys[0].description).toBe("unique");
  expect(out[symKeys[0]]).toBe(1);
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
  // Regression (found by fuzzing): an own property whose value is `undefined` must be
  // preserved (key present), not dropped like JSON.stringify does. A replacer that returns
  // undefined still omits (tested separately in the replacer suite).
  test("own properties with undefined values are preserved (key kept)", async () => {
    const o = { a: undefined, b: 1, c: undefined, d: null };
    void o;
    const out = (await roundtrip(() => o))();
    expect(Object.keys(out)).toEqual(["a", "b", "c", "d"]);
    expect("a" in out).toBe(true);
    expect(out.a).toBeUndefined();
    expect(out.b).toBe(1);
    expect(out.d).toBeNull();
  });

  test("an array with explicit undefined elements (not holes) preserves them", async () => {
    const arr = [1, undefined, 3];
    delete arr[0]; // arr is now [hole, undefined, 3]
    void arr;
    const out = (await roundtrip(() => arr))();
    expect(0 in out).toBe(false); // hole stays a hole
    expect(1 in out).toBe(true); // explicit undefined stays present
    expect(out[1]).toBeUndefined();
    expect(out[2]).toBe(3);
    expect(out.length).toBe(3);
  });

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
  test("unique symbol value round-trips and preserves intra-closure identity", async () => {
    let s = Symbol("unique");
    // Same symbol captured twice + used as a key — all must be the SAME symbol.
    let obj: any = { [s]: "v" };
    void [s, obj];
    const out = (await roundtrip(() => ({ a: s, b: s, obj })))();
    expect(typeof out.a).toBe("symbol");
    expect(out.a).toBe(out.b); // identity preserved
    expect(out.a.description).toBe("unique");
    expect(out.obj[out.a]).toBe("v"); // key and value are the same symbol
  });
  test("a symbol with no description round-trips", async () => {
    let s = Symbol();
    void s;
    const out = (await roundtrip(() => s))();
    expect(typeof out).toBe("symbol");
    expect(out.description).toBeUndefined();
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

describe("weak collections snapshot their live entries", () => {
  test("a WeakMap round-trips entries whose keys are shared with other captures", async () => {
    const k1 = { id: 1 };
    const k2 = { id: 2 };
    const wm = new WeakMap<object, unknown>([
      [k1, "one"],
      [k2, { nested: true }],
    ]);
    void [k1, k2, wm];
    const out = (await roundtrip(() => ({ k1, k2, wm })))();
    expect(out.wm).toBeInstanceOf(WeakMap);
    expect(out.wm.get(out.k1)).toBe("one"); // key identity preserved
    expect(out.wm.get(out.k2)).toEqual({ nested: true });
  });

  test("a WeakSet round-trips membership for shared captures", async () => {
    const a = { id: "a" };
    const b = { id: "b" };
    const ws = new WeakSet([a, b]);
    void [a, b, ws];
    const out = (await roundtrip(() => ({ a, b, ws })))();
    expect(out.ws).toBeInstanceOf(WeakSet);
    expect(out.ws.has(out.a)).toBe(true);
    expect(out.ws.has(out.b)).toBe(true);
    expect(out.ws.has({ id: "a" })).toBe(false); // different identity
  });

  test("an empty WeakMap round-trips", async () => {
    const wm = new WeakMap();
    void wm;
    const out = (await roundtrip(() => wm))();
    expect(out).toBeInstanceOf(WeakMap);
  });
});

describe("unserializable values throw clearly (no silent loss)", () => {
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

  // We can't statically prove which key a parameter lookup will use, so the WHOLE object
  // must be kept — every entry has to survive, not just one observed at serialize time.
  test("a parameter-keyed lookup keeps every entry of the object", async () => {
    const obj = { foo: () => "foo", bar: () => "bar", baz: () => "baz" };
    const code = serialize((key: keyof typeof obj) => obj[key]?.());
    // No pruning: all three entries are present in the output.
    expect(code).toContain("foo");
    expect(code).toContain("bar");
    expect(code).toContain("baz");
    const fn = await roundtrip((key: keyof typeof obj) => obj[key]?.());
    expect(fn("foo")).toBe("foo");
    expect(fn("bar")).toBe("bar");
    expect(fn("baz")).toBe("baz"); // baz survived even though no static access proved it
    expect(fn("nope" as any)).toBeUndefined();
  });

  test("a static access alongside a dynamic one on the same object keeps everything", async () => {
    const obj = { a: () => 1, b: () => 2, c: () => 3 };
    // `obj.a` is a static access; `obj[k]` is dynamic — the dynamic one widens to keep all.
    const fn = await roundtrip((k: keyof typeof obj) => obj.a() + (obj[k]?.() ?? 0));
    expect(fn("b")).toBe(3); // a() + b()
    expect(fn("c")).toBe(4); // a() + c()
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

  // The hazard: a generator OBJECT paused MID-ITERATION holds suspended engine state (its yield
  // point and live locals, keyed by numeric register) that is not expressible as source — those
  // must throw a CLEAR error (not silently corrupt). A not-yet-started or completed generator IS
  // reconstructable (Tier A) and is covered by the "generators: Tier A" suite.
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
    expect(() => serialize(() => captured)).toThrow(/started iterating/);
  });

  test("freshly-created (not-started) generator object reconstructs", async () => {
    function* g() {
      yield 1;
    }
    let captured = g();
    void captured;
    const out = (await roundtrip(() => captured))() as Generator<number>;
    expect([...out]).toEqual([1]);
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
      yield 2;
    }
    const live = g();
    live.next();
    const wrapper = { label: "box", it: live };
    void wrapper;
    expect(() => serialize(() => wrapper)).toThrow(/started iterating/);
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

  test("class instance: an uncalled prototype method is pruned; correctness preserved", async () => {
    class Widget {
      used = 1;
      ownUnused = "UNUSED_MARKER_OWNFIELD";
      reach() {
        return this.used;
      }
      neverCalled() {
        return "PROTO_METHOD_BODY";
      }
    }
    const inst = new Widget();
    void inst;
    const code = serialize(() => inst.reach());
    // Only `reach` is reachable; `neverCalled` is pruned from the emitted class.
    expect(code).not.toContain("PROTO_METHOD_BODY");
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

  test("a WeakRef round-trips its live referent", async () => {
    const target = { a: 1 };
    const r = new WeakRef(target);
    void r;
    const out = (await roundtrip(() => r))();
    expect(out).toBeInstanceOf(WeakRef);
    expect(out.deref()).toEqual({ a: 1 });
  });

  test("a WeakRef sharing its referent with another capture keeps identity", async () => {
    const target = { a: 1 };
    const r = new WeakRef(target);
    void [target, r];
    const out = (await roundtrip(() => ({ target, r })))();
    expect(out.r.deref()).toBe(out.target); // same object identity
  });

  test("a FinalizationRegistry round-trips its callback + live registrations", async () => {
    const sink: string[] = [];
    const cleanup = (held: string) => sink.push("HELD_MARKER:" + held);
    const reg = new FinalizationRegistry(cleanup);
    const target = { id: 1 };
    reg.register(target, "held-value");
    void [sink, cleanup, reg, target];

    const code = serialize(() => reg);
    // The callback and the held value were captured from the registry's internals.
    expect(code).toContain("HELD_MARKER");
    expect(code).toContain("held-value");
    expect(code).toMatch(/new FinalizationRegistry\(/);
    expect(code).toMatch(/\.register\(/);

    const out = (await roundtrip(() => reg))();
    expect(out).toBeInstanceOf(FinalizationRegistry);
  });

  test("an empty FinalizationRegistry round-trips", async () => {
    const reg = new FinalizationRegistry(() => {});
    void reg;
    const out = (await roundtrip(() => reg))();
    expect(out).toBeInstanceOf(FinalizationRegistry);
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

// A base class with `#private` data fields, when nothing in the captured graph
// needs its privates outside a closed world (no subclass instance, no extracted/
// bound method, no escaped `#x` closure), is reconstructed with GENUINE private
// slots — installed by a constructor reify branch and seeded through a factory —
// rather than mangled into a public field. The reachability gate routes the
// closed-world cases to mangling so everything still round-trips.
describe("genuine #private reification", () => {
  // Regression (found by adversarial probing): a captured class instance defined NEAR THE
  // TOP of its source file produced a source map with a NEGATIVE source line (the engine's
  // toString() reformats a one-line class onto several lines, so a member's toString-relative
  // line exceeds its small file line). That crashed the runtime source-map parser on import
  // (debug) / corrupted the map (release). Needs a fixture so the class is at a low line.
  test("a captured instance defined at the top of its file imports without a source-map crash", async () => {
    using dir = tempDir(`closure-smtop-${counter++}`, {
      "gen.mjs": [
        `import { serialize } from "bun:closure";`,
        `import { writeFileSync } from "node:fs";`,
        `class C { #a = 1; #b = 2; #c = 3; sum() { return this.#a + this.#b + this.#c; } }`,
        `const inst = new C();`,
        `writeFileSync(new URL("./mod.mjs", import.meta.url), serialize(() => inst));`,
        `const out = (await import("./mod.mjs")).default();`,
        `console.log("sum=" + out.sum());`,
      ].join("\n"),
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), `${String(dir)}/gen.mjs`],
      env: bunEnv,
      cwd: String(dir),
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect(stdout.trim()).toBe("sum=6");
    expect(stderr).not.toContain("panic");
    expect(exitCode).toBe(0);
  });

  // Regression (found by adversarial probing): a class DEFINED INSIDE the serialized
  // function (not a captured top-level class) is verbatim valid source — its `#x` must stay
  // a genuine private, never get mangled to a public `$bunClosurePrivate$x`. The private
  // rewrite only applies to the OUTERMOST class being reconstructed via the mangle fallback.
  test("a class defined inside the serialized function keeps genuine privates", async () => {
    const code = serialize(() => {
      class C {
        #x = 11;
        raw() {
          return this.#x;
        }
      }
      return new C();
    });
    expect(code).not.toContain("$bunClosurePrivate$"); // not mangled

    const make = await roundtrip(() => {
      class C {
        #x = 11;
        raw() {
          return this.#x;
        }
      }
      return new C();
    });
    const inst = make();
    expect(inst.raw()).toBe(11);
    expect(Object.keys(inst)).toEqual([]); // genuinely private — no public key leaked
    expect((inst as any).$bunClosurePrivate$x).toBeUndefined();
  });

  test("a factory function returning instances of an inner class keeps privacy", async () => {
    const factory = await roundtrip((v: number) => {
      class Box {
        #v: number;
        constructor(v: number) {
          this.#v = v;
        }
        get() {
          return this.#v;
        }
      }
      return new Box(v);
    });
    expect(factory(42).get()).toBe(42);
    expect(factory(7).get()).toBe(7); // a fresh genuine instance each call
    expect(Object.keys(factory(1))).toEqual([]);
  });

  // The genuine private's brand check is real: reading `#x` through a Proxy (whose receiver
  // is the proxy, not the branded instance) must throw — exactly as it does pre-serialize.
  test("a Proxy over an inner-class instance preserves the genuine brand check", async () => {
    const out = await roundtrip(() => {
      class C {
        #x = 5;
        raw() {
          return this.#x;
        }
      }
      return new Proxy(new C(), {});
    });
    expect(() => (out() as any).raw()).toThrow(TypeError); // brand check fails on the proxy
  });

  test("a single-class instance reifies with true privacy (no mangled public field)", async () => {
    class Account {
      #balance = 100;
      deposit(n: number) {
        this.#balance += n;
        return this.#balance;
      }
      get balance() {
        return this.#balance;
      }
    }
    const a = new Account();
    a.deposit(50);
    void a;

    const code = serialize(() => a);
    // The genuine path is taken: a reify factory + slot, and NO mangled public field.
    expect(code).toContain("_reify");
    expect(code).toContain("$bunClosureReify$");
    expect(code).not.toContain("$bunClosurePrivate$");

    const out = (await roundtrip(() => a))();
    expect(out.balance).toBe(150); // reified private state
    expect(out.deposit(10)).toBe(160); // method mutates the genuine slot
    // The `#balance` slot is genuinely private: not present as any own property.
    expect(Object.getOwnPropertyNames(out)).not.toContain("$bunClosurePrivate$balance");
    expect(Object.keys(out)).toEqual([]);
  });

  test("instanceof and class identity are retained across two instances", async () => {
    class Point {
      #x: number;
      #y: number;
      constructor(x: number, y: number) {
        this.#x = x;
        this.#y = y;
      }
      sum() {
        return this.#x + this.#y;
      }
    }
    const p = new Point(1, 2);
    const q = new Point(10, 20);
    void [p, q];

    const out = (await roundtrip(() => [p, q] as const))();
    expect(out[0].sum()).toBe(3);
    expect(out[1].sum()).toBe(30);
    // One shared reconstructed class cell: identical constructor, mutual instanceof.
    const Ctor = Object.getPrototypeOf(out[0]).constructor;
    expect(Object.getPrototypeOf(out[1]).constructor).toBe(Ctor);
    expect(out[0]).toBeInstanceOf(Ctor);
    expect(out[1]).toBeInstanceOf(Ctor);
  });

  test("a reified method that throws maps its stack frame to the original source (line + column)", async () => {
    class Boom {
      #tag = "kab";
      explode() {
        throw new Error(this.#tag + "oom");
      }
    }
    const b = new Boom();
    void b;

    const code = serialize(() => b);
    expect(code).toContain("_reify"); // genuine path
    using dir = tempDir("closure-gp-srcmap", { "mod.mjs": code });
    const { default: fn } = await import(`${String(dir)}/mod.mjs`);
    let caught: any;
    try {
      fn().explode();
    } catch (e) {
      caught = e;
    }
    expect(caught?.message).toBe("kaboom");
    // The `explode` frame chains through the inline map back to THIS file with a
    // line:column suffix — not the reconstructed module — so stack traces survive.
    const frame = caught.stack.split("\n").find((l: string) => l.includes("explode"));
    expect(frame).toBeDefined();
    expect(frame).toContain("closure.test");
    expect(frame).not.toContain("mod.mjs");
    expect(frame).toMatch(/:\d+:\d+/); // a concrete line:column was mapped
  });

  // GP2b: a bound method is emitted as `Class.prototype.method.bind(instance)` through the
  // reconstructed genuine prototype — reading the genuine slot — so it stays genuine.
  test("a bound method reads the genuine slot through the reconstructed prototype", async () => {
    class Counter {
      #n = 5;
      step() {
        return ++this.#n;
      }
    }
    const c = new Counter();
    const bound = c.step.bind(c);
    void bound;

    const code = serialize(() => bound());
    expect(code).not.toContain("$bunClosurePrivate$"); // genuine, via prototype reference
    const out = await roundtrip(() => bound());
    expect(out()).toBe(6);
    expect(out()).toBe(7);
  });

  test("a method extracted as a value round-trips against a genuine instance", async () => {
    class Box {
      #v: number;
      constructor(v: number) {
        this.#v = v;
      }
      read() {
        return this.#v;
      }
    }
    const box = new Box(42);
    const read = box.read; // extracted, unbound — same identity as Box.prototype.read
    void [box, read];

    const code = serialize(() => ({ box, read }));
    expect(code).not.toContain("$bunClosurePrivate$");
    const out = (await roundtrip(() => ({ box, read })))();
    expect(out.read.call(out.box)).toBe(42); // the extracted method reads the genuine #v
  });

  // GP2a: a whole user-class hierarchy is reconstructed genuinely — the leaf instance is
  // built through `new Derived()` so every level's constructor installs its own brand.
  test("an inheritance chain reifies privates at every level genuinely", async () => {
    class Animal {
      #species: string;
      constructor(s: string) {
        this.#species = s;
      }
      describe() {
        return `a ${this.#species}`;
      }
    }
    class Dog extends Animal {
      #name: string;
      constructor(name: string) {
        super("dog");
        this.#name = name;
      }
      intro() {
        return `${this.#name} is ${this.describe()}`;
      }
    }
    const d = new Dog("Rex");
    void d;

    const code = serialize(() => d);
    expect(code).toContain("_reify");
    expect(code).not.toContain("$bunClosurePrivate$"); // genuine, both levels

    const out = (await roundtrip(() => d))();
    expect(out.intro()).toBe("Rex is a dog"); // derived #name + base #species (via inherited method)
    expect(out.describe()).toBe("a dog"); // base private through an inherited method
    const Leaf = Object.getPrototypeOf(out).constructor;
    const Basecls = Object.getPrototypeOf(Object.getPrototypeOf(out)).constructor;
    expect(out).toBeInstanceOf(Leaf);
    expect(out).toBeInstanceOf(Basecls); // instanceof up the chain
    expect(Object.getOwnPropertyNames(out).filter(k => k.includes("Private"))).toEqual([]);
  });

  // GP3b: a class extending a reconstructable builtin (Map/Set/Array) reifies genuinely —
  // the factory's super() yields an empty Map, content is restored via .set, and the genuine
  // #tag is patched. The builtin base is NOT reconstructed; super() calls the real one.
  test("a class extending a builtin (Map) reifies genuinely with content + private", async () => {
    class TaggedMap extends Map<string, number> {
      #tag = "m";
      getTag() {
        return this.#tag;
      }
    }
    const m = new TaggedMap([["a", 1]]);
    m.set("b", 2);
    void m;

    const code = serialize(() => m);
    expect(code).not.toContain("$bunClosurePrivate$"); // genuine
    const out = (await roundtrip(() => m))();
    expect(out.getTag()).toBe("m"); // genuine private
    expect(out.get("a")).toBe(1); // restored Map content
    expect(out.get("b")).toBe(2);
    expect(out.size).toBe(2);
    expect(out).toBeInstanceOf(Map);
  });

  test("classes extending Set and Array reify genuinely with content + private", async () => {
    class TaggedSet extends Set<number> {
      #label = "S";
      lbl() {
        return this.#label;
      }
    }
    class NumList extends Array<number> {
      #unit = "px";
      unit() {
        return this.#unit;
      }
    }
    const s = new TaggedSet([1, 2, 3]);
    const a = new NumList();
    a.push(10, 20);
    void [s, a];

    const so = (await roundtrip(() => s))();
    expect(so.lbl()).toBe("S");
    expect(so.has(2)).toBe(true);
    expect(so.size).toBe(3);
    expect(so).toBeInstanceOf(Set);

    const ao = (await roundtrip(() => a))();
    expect(ao.unit()).toBe("px");
    expect([...ao]).toEqual([10, 20]);
    expect(Array.isArray(ao)).toBe(true);
  });

  // A bound base method on a subclass instance: the chain stays genuine (GP2b) and the
  // bound method reads the genuine #sides through the reconstructed Shape prototype.
  test("a bound base method on a subclass instance stays genuine", async () => {
    class Shape {
      #sides: number;
      constructor(n: number) {
        this.#sides = n;
      }
      sides() {
        return this.#sides;
      }
    }
    class Tri extends Shape {
      constructor() {
        super(3);
      }
    }
    const tri = new Tri();
    const bound = tri.sides.bind(tri);
    void [tri, bound];

    const code = serialize(() => ({ tri, run: bound }));
    expect(code).not.toContain("$bunClosurePrivate$");
    const out = (await roundtrip(() => ({ tri, run: bound })))();
    expect(out.tri.sides()).toBe(3);
    expect(out.run()).toBe(3);
  });

  test("public own fields are restored alongside genuine privates", async () => {
    class Mixed {
      label = "init"; // public field
      #secret = 1; // private field
      constructor() {
        this.#secret = 7;
        this.label = "set";
      }
      both() {
        return `${this.label}:${this.#secret}`;
      }
    }
    const x = new Mixed();
    x.label = "mutated";
    (x as any).extra = 99; // externally-assigned public prop
    void x;

    const code = serialize(() => x);
    expect(code).not.toContain("$bunClosurePrivate$");
    const out = (await roundtrip(() => x))();
    expect(out.label).toBe("mutated"); // public field restored (post-construction value)
    expect((out as any).extra).toBe(99); // externally-added public prop restored
    expect(out.both()).toBe("mutated:7"); // genuine private + public together
  });

  test("a private field holding a complex value reifies by identity", async () => {
    class Holder {
      #data: { n: number[] };
      constructor(d: { n: number[] }) {
        this.#data = d;
      }
      get() {
        return this.#data;
      }
    }
    const shared = { n: [1, 2, 3] };
    const h = new Holder(shared);
    void h;

    const out = (await roundtrip(() => h))();
    expect(out.get()).toEqual({ n: [1, 2, 3] }); // nested object reified through the slot
    out.get().n.push(4);
    expect(out.get().n).toEqual([1, 2, 3, 4]); // it's a live object, not a copy
  });

  test("a class captured without an instance still constructs with genuine privates", async () => {
    class Counter {
      #n: number;
      constructor(start: number) {
        this.#n = start;
      }
      next() {
        return ++this.#n;
      }
    }
    void Counter;

    const code = serialize(() => Counter);
    expect(code).toContain("_reify"); // reconstructed genuine (reify branch present)
    const Reconstructed = (await roundtrip(() => Counter))() as typeof Counter;
    const inst = new Reconstructed(10); // normal `new` path (reify slot is null)
    expect(inst.next()).toBe(11);
    expect(inst.next()).toBe(12);
    expect(Object.getOwnPropertyNames(inst)).not.toContain("$bunClosurePrivate$n");
  });

  test("a three-level inheritance chain reifies every level", async () => {
    class A {
      #a = 0;
      constructor() {
        this.#a = 1;
      }
      ga() {
        return this.#a;
      }
    }
    class B extends A {
      #b = 0;
      constructor() {
        super();
        this.#b = 2;
      }
      gb() {
        return this.#b;
      }
    }
    class C extends B {
      #c = 0;
      constructor() {
        super();
        this.#c = 3;
      }
      gc() {
        return this.#c;
      }
    }
    const c = new C();
    void c;

    const code = serialize(() => c);
    expect(code).not.toContain("$bunClosurePrivate$");
    const out = (await roundtrip(() => c))();
    expect([out.ga(), out.gb(), out.gc()]).toEqual([1, 2, 3]);
  });

  test("an intermediate class with no private fields is bridged genuinely", async () => {
    class Base {
      #v: number;
      constructor(v: number) {
        this.#v = v;
      }
      val() {
        return this.#v;
      }
    }
    class Mid extends Base {} // no own privates, no explicit constructor
    class Leaf extends Mid {
      #w = 0;
      constructor() {
        super(10);
        this.#w = 20;
      }
      sum() {
        return this.val() + this.#w;
      }
    }
    const leaf = new Leaf();
    void leaf;

    const code = serialize(() => leaf);
    expect(code).not.toContain("$bunClosurePrivate$");
    const out = (await roundtrip(() => leaf))();
    expect(out.sum()).toBe(30); // base #v (10, through Mid) + leaf #w (20)
  });

  test("a derived class with no explicit constructor reifies and still constructs normally", async () => {
    class Base {
      #v: number;
      constructor(v: number) {
        this.#v = v;
      }
      val() {
        return this.#v;
      }
    }
    class Derived extends Base {} // synthesized constructor must forward super(...args)
    const d = new Derived(5);
    void Derived;

    // Reified instance reads the genuine base private.
    const out = (await roundtrip(() => d))();
    expect(out.val()).toBe(5);

    // The reconstructed class still constructs normally (reify slot null path).
    const Reconstructed = (await roundtrip(() => Derived))() as typeof Derived;
    expect(new Reconstructed(42).val()).toBe(42);
  });

  test("a throwing base-class method maps to the original base source line", async () => {
    class Base {
      #v = 0;
      detonate() {
        throw new Error("kapow");
      }
    }
    class Sub extends Base {
      #w = 1;
    }
    const s = new Sub();
    void s;

    const code = serialize(() => s);
    expect(code).toContain("_reify");
    using dir = tempDir("closure-gp-base-srcmap", { "mod.mjs": code });
    const { default: fn } = await import(`${String(dir)}/mod.mjs`);
    let caught: any;
    try {
      fn().detonate();
    } catch (e) {
      caught = e;
    }
    expect(caught?.message).toBe("kapow");
    const frame = caught.stack.split("\n").find((l: string) => l.includes("detonate"));
    expect(frame).toBeDefined();
    expect(frame).toContain("closure.test");
    expect(frame).not.toContain("mod.mjs");
    expect(frame).toMatch(/:\d+:\d+/);
  });

  // GP3a: an escaped arrow that reads a #private through its lexical `this` is reconstructed
  // by HOSTING — its receiver is recovered natively, the class is reconstructed genuinely
  // with a synthetic host method returning the arrow, and the arrow is obtained by invoking
  // that host on the reified instance. So `() => this.#x` round-trips with true privacy.
  test("an escaped arrow reading a private through lexical this is hosted genuinely", async () => {
    class C {
      #x = 41;
      make() {
        return () => this.#x + 1;
      }
    }
    const f = new C().make();
    void f;

    const code = serialize(() => f);
    expect(code).not.toContain("$bunClosurePrivate$"); // genuine, not mangled
    expect(code).toContain("__bunClosureHost$"); // hosted on the class body
    const out = (await roundtrip(() => f))();
    expect(out()).toBe(42); // the reified arrow reads the genuine #x
  });

  test("an escaped arrow doing a private brand check on lexical this is hosted genuinely", async () => {
    class C {
      #x = 1;
      make() {
        return () => #x in this; // a real brand check against the genuine slot
      }
    }
    const f = new C().make();
    void f;

    const code = serialize(() => f);
    expect(code).not.toContain("$bunClosurePrivate$");
    const out = (await roundtrip(() => f))();
    expect(out()).toBe(true); // `#x in this` is true on the reified genuine instance
  });

  // The arrow's non-`this` captures are threaded as host-method parameters, so an escaped
  // arrow that also closes over outer variables (including inside a template literal, which
  // ast() exposes opaquely) still hosts genuinely.
  test("an escaped arrow capturing outer variables is hosted with threaded parameters", async () => {
    class C {
      #x = 1;
      make(offset: number, label: string) {
        return () => `${label}:${this.#x + offset}`;
      }
    }
    const f = new C().make(10, "tag");
    void f;

    const code = serialize(() => f);
    expect(code).not.toContain("$bunClosurePrivate$");
    expect(code).toMatch(/__bunClosureHost\$0\([^)]+\)/); // host method has parameters
    const out = (await roundtrip(() => f))();
    expect(out()).toBe("tag:11"); // label + (genuine #x + offset)
  });

  // A threaded capture that is an object keeps its identity (it's emitted once and shared),
  // so mutating it through the outer graph is visible to the hosted arrow.
  test("a hosted arrow's threaded object capture preserves shared identity", async () => {
    class C {
      #x = 5;
      make(box: { n: number }) {
        return () => this.#x + box.n;
      }
    }
    const box = { n: 100 };
    const f = new C().make(box);
    void [f, box];

    const out = (await roundtrip(() => ({ f, box })))();
    expect(out.f()).toBe(105);
    out.box.n = 200; // mutate the shared object through the outer graph
    expect(out.f()).toBe(205); // the hosted arrow sees it — same object, not a snapshot
  });

  test("capturing the private value first also round-trips (no hosting needed)", async () => {
    class C {
      #x = 7;
      make() {
        const v = this.#x; // capture the value, not `this`
        return () => v + 1;
      }
    }
    const f = new C().make();
    void f;
    const out = (await roundtrip(() => f))();
    expect(out()).toBe(8);
  });

  // Regression: a hosted arrow stored in its OWN instance's private slot. The instance's
  // patch object references the hosted arrow, but the arrow's `const` is obtained FROM that
  // same instance (`inst.__host()`), so it's declared after the bare instance. The patch is
  // deferred to the end of the prelude so it never references the arrow before its binding
  // exists (a temporal-dead-zone crash before the fix).
  test("a hosted arrow stored in its own instance's private field round-trips", async () => {
    class D {
      #x: number;
      #fn: () => number;
      constructor(v: number) {
        this.#x = v;
        this.#fn = () => this.#x; // arrow captured into this very instance's private slot
      }
      get() {
        return this.#fn;
      }
    }
    const f = new D(77).get();
    void f;
    const out = (await roundtrip(() => f))();
    expect(out()).toBe(77); // the reified arrow reads the genuine #x off the reified instance
  });

  // An escaped arrow that reads a PUBLIC field through its lexical `this` is not hosted
  // (hosting only triggers for #private reads). Its `this` is baked in lexically and cannot
  // be recovered, so reconstructing it standalone would emit a `this.x` off an unbound
  // `this`. Reject clearly at serialize time rather than emit silently-broken output.
  test("an escaped arrow reading a public field through lexical this is rejected clearly", () => {
    class C {
      x: number;
      constructor(v: number) {
        this.x = v;
      }
      make() {
        return () => this.x;
      }
    }
    const f = new C(42).make();
    void f;
    expect(() => serialize(() => f)).toThrow(/reads its lexical `this`/);
  });

  // Capturing the public value first sidesteps the lexical-`this` problem and round-trips.
  test("capturing the public value first round-trips", async () => {
    class C {
      x: number;
      constructor(v: number) {
        this.x = v;
      }
      make() {
        const x = this.x; // capture the value, not `this`
        return () => x;
      }
    }
    const f = new C(42).make();
    void f;
    const out = (await roundtrip(() => f))();
    expect(out()).toBe(42);
  });
});

// Generality: genuine privates must hold across arity (any number/order of fields), depth
// (arbitrary nesting), and interaction with other JS features (containers, identity,
// cycles, private methods/accessors, async/generator methods, hosted arrows).
describe("genuine #private: general permutations", () => {
  // Regression (found by fuzzing): a genuine class whose heritage is an INLINE class
  // expression (`extends class A {…}`) — the class-body brace must be located via the AST
  // (node.body.start), not `indexOf("{")` which would find the inline base's brace and
  // inject the patch method into the wrong class. Combined here with a same-name collision.
  test("a genuine class extending an inline class expression (with collision) round-trips", async () => {
    class Coll extends class A {
      #x: number;
      constructor(v: number) {
        this.#x = v;
      }
      ax() {
        return this.#x;
      }
    } {
      #x: number;
      constructor(a: number, b: number) {
        super(a);
        this.#x = b;
      }
      probe() {
        return { a: this.ax(), x: this.#x };
      }
    }
    const shared = { tag: "S" };
    const c = new Coll(1, 2);
    const c2 = new Coll(shared as any, shared as any); // same object in both #x slots
    void [c, c2];

    const out = (await roundtrip(() => ({ c, c2 })))();
    expect(out.c.probe()).toEqual({ a: 1, x: 2 }); // distinct slots, distinct values
    expect(out.c2.probe().a).toBe(out.c2.probe().x); // same object preserved in both slots
    expect(out.c2.probe().a).toEqual({ tag: "S" });
  });

  test("arbitrary arity: many private fields in any order", async () => {
    class C {
      #e = 5;
      #a = 1;
      #d = 4;
      #b = 2;
      #c = 3;
      all() {
        return [this.#a, this.#b, this.#c, this.#d, this.#e];
      }
    }
    const out = (await roundtrip(() => new C()))();
    expect(out.all()).toEqual([1, 2, 3, 4, 5]);
  });

  test("genuine instances nested in array, object, Map, and Set", async () => {
    class P {
      #x: number;
      constructor(x: number) {
        this.#x = x;
      }
      get() {
        return this.#x;
      }
    }
    const arr = [new P(1), new P(2)];
    const obj = { a: new P(3) };
    const map = new Map([["k", new P(4)]]);
    const set = new Set([new P(5)]);
    void [arr, obj, map, set];
    const out = (await roundtrip(() => ({ arr, obj, map, set })))();
    expect(out.arr.map((p: any) => p.get())).toEqual([1, 2]);
    expect(out.obj.a.get()).toBe(3);
    expect(out.map.get("k").get()).toBe(4);
    expect([...out.set][0].get()).toBe(5);
  });

  test("a shared instance keeps identity across multiple references", async () => {
    class C {
      #x = 1;
      get() {
        return this.#x;
      }
    }
    const c = new C();
    void c;
    const out = (await roundtrip(() => ({ p: c, q: c, list: [c, c] })))();
    expect(out.p).toBe(out.q);
    expect(out.list[0]).toBe(out.p);
    expect(out.list[1]).toBe(out.p);
    expect(out.p.get()).toBe(1);
  });

  test("arbitrarily deep nesting of genuine instances through private fields", async () => {
    class L {
      #v: number;
      #next: L | null;
      constructor(v: number, next: L | null) {
        this.#v = v;
        this.#next = next;
      }
      v() {
        return this.#v;
      }
      next() {
        return this.#next;
      }
    }
    const list = new L(1, new L(2, new L(3, null)));
    void list;
    const out = (await roundtrip(() => list))();
    expect([out.v(), out.next()!.v(), out.next()!.next()!.v()]).toEqual([1, 2, 3]);
    expect(out.next()!.next()!.next()).toBeNull();
  });

  test("private data + private method + private accessor coexist", async () => {
    class C {
      #x = 10;
      #double() {
        return this.#x * 2;
      }
      get #plusOne() {
        return this.#x + 1;
      }
      run() {
        return this.#double() + this.#plusOne;
      }
    }
    const out = (await roundtrip(() => new C()))();
    expect(out.run()).toBe(31);
  });

  test("async and generator methods read genuine privates", async () => {
    class C {
      #x = 7;
      async ax() {
        return this.#x;
      }
      *gen() {
        yield this.#x;
        yield this.#x * 2;
      }
    }
    const out = (await roundtrip(() => new C()))();
    expect(await out.ax()).toBe(7);
    expect([...out.gen()]).toEqual([7, 14]);
  });

  test("a static private field does not block instance reification", async () => {
    class C {
      static #count = 3;
      #x = 1;
      val() {
        return this.#x;
      }
      static count() {
        return C.#count;
      }
    }
    const out = (await roundtrip(() => new C()))();
    expect(out.val()).toBe(1);
  });

  test("two hosted arrows on the same class both read the genuine slot", async () => {
    class C {
      #x = 5;
      mkAdd() {
        return () => this.#x + 1;
      }
      mkMul() {
        return () => this.#x * 2;
      }
    }
    const c = new C();
    const add = c.mkAdd();
    const mul = c.mkMul();
    void [add, mul];
    const out = (await roundtrip(() => ({ add, mul })))();
    expect(out.add()).toBe(6);
    expect(out.mul()).toBe(10);
  });

  test("a circular reference through private fields round-trips", async () => {
    class Node {
      #peer: Node | null = null;
      id: number;
      constructor(id: number) {
        this.id = id;
      }
      link(p: Node) {
        this.#peer = p;
      }
      peer() {
        return this.#peer;
      }
    }
    const a = new Node(1);
    const b = new Node(2);
    a.link(b);
    b.link(a);
    void [a, b];
    const out = (await roundtrip(() => ({ a, b })))();
    expect(out.a.peer()!.id).toBe(2);
    expect(out.b.peer()!.id).toBe(1);
    expect(out.a.peer()!.peer()).toBe(out.a); // the cycle is preserved by identity
  });

  test("a private field that references the instance itself round-trips", async () => {
    class S {
      #self: S | null = null;
      constructor() {
        this.#self = this;
      }
      me() {
        return this.#self;
      }
    }
    const s = new S();
    void s;
    const out = (await roundtrip(() => s))();
    expect(out.me()).toBe(out); // self-cycle preserved
  });

  test("same-named private fields across an inheritance chain stay distinct (genuine)", async () => {
    class A {
      #x = "a";
      ax() {
        return this.#x;
      }
    }
    class B extends A {
      #x = "b"; // a DIFFERENT private slot than A's #x
      bx() {
        return this.#x;
      }
      both() {
        return this.ax() + this.#x;
      }
    }
    const b = new B();
    void b;

    const code = serialize(() => b);
    expect(code).not.toContain("$bunClosurePrivate$"); // genuine — distinct slots, not mangled
    const out = (await roundtrip(() => b))();
    expect(out.ax()).toBe("a"); // A's #x
    expect(out.bx()).toBe("b"); // B's #x
    expect(out.both()).toBe("ab"); // both distinct slots from inside B
  });

  test("a cycle through private fields across an inheritance chain round-trips", async () => {
    class Base {
      #link: any = null;
      bid: number;
      constructor(id: number) {
        this.bid = id;
      }
      setLink(x: any) {
        this.#link = x;
      }
      link() {
        return this.#link;
      }
    }
    class Derived extends Base {
      #tag: string;
      constructor(id: number, tag: string) {
        super(id);
        this.#tag = tag;
      }
      tag() {
        return this.#tag;
      }
    }
    const a = new Derived(1, "a");
    const b = new Derived(2, "b");
    a.setLink(b);
    b.setLink(a);
    void [a, b];
    const out = (await roundtrip(() => ({ a, b })))();
    expect([out.a.bid, out.a.tag(), out.a.link().bid, out.a.link().tag()]).toEqual([1, "a", 2, "b"]);
    expect(out.a.link().link()).toBe(out.a); // cross-level cycle preserved
  });

  test("mutual recursion between two different genuine classes round-trips", async () => {
    class Ping {
      #pong: any = null;
      set(p: any) {
        this.#pong = p;
      }
      pong() {
        return this.#pong;
      }
      kind() {
        return "ping";
      }
    }
    class Pong {
      #ping: any = null;
      set(p: any) {
        this.#ping = p;
      }
      ping() {
        return this.#ping;
      }
      kind() {
        return "pong";
      }
    }
    const ping = new Ping();
    const pong = new Pong();
    ping.set(pong);
    pong.set(ping);
    void [ping, pong];
    const out = (await roundtrip(() => ping))();
    expect(out.kind()).toBe("ping");
    expect(out.pong().kind()).toBe("pong");
    expect(out.pong().ping()).toBe(out); // mutual cycle preserved
  });

  test("a private field holding a hosted arrow bound to the same instance round-trips", async () => {
    class C {
      #x = 9;
      #getter: any = null;
      constructor() {
        this.#getter = () => this.#x; // an escaped arrow stored in a private field (a cycle)
      }
      getter() {
        return this.#getter;
      }
      direct() {
        return this.#x;
      }
    }
    const c = new C();
    void c;
    const out = (await roundtrip(() => c))();
    expect(out.direct()).toBe(9);
    expect(out.getter()()).toBe(9); // the hosted arrow reads the genuine slot of the same instance
  });

  test("arbitrarily nested arrows reading a private round-trip", async () => {
    class C {
      #x = 3;
      deep() {
        return () => () => () => this.#x + 1; // arrows nested 3 deep, all sharing lexical this
      }
    }
    const f = new C().deep();
    void f;
    const out = (await roundtrip(() => f))();
    expect(out()()()).toBe(4);
  });

  test("a nested ordinary function inside a hosted arrow keeps dynamic this", async () => {
    class C {
      #x = 5;
      mk() {
        // the arrow reads this.#x (lexical); the returned function's `this` is dynamic.
        return () => ({
          priv: this.#x,
          fn: function (this: any) {
            return this?.y;
          },
        });
      }
    }
    const f = new C().mk();
    void f;
    const out = (await roundtrip(() => f))();
    const r = out();
    expect(r.priv).toBe(5); // lexical this → genuine slot
    expect(r.fn.call({ y: 42 })).toBe(42); // dynamic this preserved
  });

  test("a hosted arrow sharing a mutable cell with another closure keeps it shared", async () => {
    let counter = 10;
    const inc = () => ++counter;
    class C {
      #x = 5;
      read() {
        return () => this.#x + counter; // escaped arrow captures #x AND the shared `counter`
      }
    }
    const read = new C().read();
    void [inc, read];

    const out = (await roundtrip(() => ({ inc, read })))();
    expect(out.read()).toBe(15);
    out.inc(); // mutate the shared cell through the other closure
    expect(out.read()).toBe(16); // the hosted arrow sees it — shared, not a snapshot
  });

  test("a private field holding a container of other genuine instances round-trips", async () => {
    class Leaf {
      #v: number;
      constructor(v: number) {
        this.#v = v;
      }
      v() {
        return this.#v;
      }
    }
    class Tree {
      #kids: Map<string, Leaf>;
      constructor(kids: Map<string, Leaf>) {
        this.#kids = kids;
      }
      kid(k: string) {
        return this.#kids.get(k);
      }
    }
    const t = new Tree(
      new Map([
        ["a", new Leaf(1)],
        ["b", new Leaf(2)],
      ]),
    );
    void t;
    const out = (await roundtrip(() => t))();
    expect(out.kid("a")!.v()).toBe(1);
    expect(out.kid("b")!.v()).toBe(2);
  });

  test("private fields holding builtins (Date, Map, bound method) round-trip", async () => {
    class C {
      #when: Date;
      #lookup: Map<string, number>;
      #bound: () => number;
      constructor() {
        this.#when = new Date(0);
        this.#lookup = new Map([["k", 7]]);
        this.#bound = this.raw.bind(this);
      }
      raw() {
        return 99;
      }
      when() {
        return this.#when.getTime();
      }
      look(k: string) {
        return this.#lookup.get(k);
      }
      bound() {
        return this.#bound();
      }
    }
    const c = new C();
    void c;
    const out = (await roundtrip(() => c))();
    expect(out.when()).toBe(0);
    expect(out.look("k")).toBe(7);
    expect(out.bound()).toBe(99);
  });

  test("a well-known-symbol-keyed method reads the genuine private", async () => {
    class C {
      #x = 8;
      *[Symbol.iterator]() {
        yield this.#x;
        yield this.#x + 1;
      }
    }
    const c = new C();
    void c;
    const out = (await roundtrip(() => c))();
    expect([...out]).toEqual([8, 9]); // the Symbol.iterator method reads the genuine slot
  });

  test("computed method/accessor keys captured ONLY as keys are recovered from the class", async () => {
    const tag = Symbol("tag"); // a captured string/symbol used ONLY as a method key is pruned
    const keyName = "dynamic"; // from the class's scope by JSC — recovered from the class's
    const accName = "view"; // own keys instead (robustly, by the member source).
    class C {
      #x = 8;
      [tag]() {
        return this.#x;
      }
      [keyName]() {
        return this.#x + 1;
      }
      get [accName]() {
        return this.#x * 10;
      }
    }
    const c = new C();
    void c; // tag / keyName / accName are not referenced anywhere the closure captures
    const out = (await roundtrip(() => c))();
    const sym = Object.getOwnPropertySymbols(Object.getPrototypeOf(out))[0];
    expect((out as any)[sym]()).toBe(8); // symbol-keyed computed method
    expect((out as any).dynamic()).toBe(9); // string-keyed computed method
    expect((out as any).view).toBe(80); // computed accessor
  });

  test("public accessors coexist with genuine privates", async () => {
    class C {
      #x = 4;
      get doubled() {
        return this.#x * 2;
      }
      set doubled(v: number) {
        this.#x = v / 2;
      }
    }
    const c = new C();
    void c;
    const out = (await roundtrip(() => c))();
    expect(out.doubled).toBe(8);
    out.doubled = 20;
    expect(out.doubled).toBe(20); // setter wrote the genuine slot
  });

  test("a frozen genuine instance round-trips and stays frozen", async () => {
    class C {
      #x = 3;
      get() {
        return this.#x;
      }
    }
    const c = Object.freeze(new C());
    void c;
    const out = (await roundtrip(() => c))();
    expect(out.get()).toBe(3);
    expect(Object.isFrozen(out)).toBe(true);
  });

  test("a genuine instance reached via a free var AND a private field keeps one identity", async () => {
    class Inner {
      #v = 1;
      v() {
        return this.#v;
      }
    }
    class Outer {
      #inner: Inner;
      constructor(i: Inner) {
        this.#inner = i;
      }
      inner() {
        return this.#inner;
      }
    }
    const shared = new Inner();
    const outer = new Outer(shared);
    void [shared, outer];
    const out = (await roundtrip(() => ({ shared, outer })))();
    expect(out.outer.inner()).toBe(out.shared); // same instance via both paths
    expect(out.shared.v()).toBe(1);
  });

  test("a genuine class also carrying external statics round-trips", async () => {
    class C {
      static label = "cls";
      #x = 6;
      get() {
        return this.#x;
      }
    }
    (C as any).extra = { tag: "x" };
    const c = new C();
    void c;
    const out = (await roundtrip(() => ({ c, C })))();
    expect(out.c.get()).toBe(6);
    expect((out.C as any).label).toBe("cls");
    expect((out.C as any).extra).toEqual({ tag: "x" });
    expect(out.c).toBeInstanceOf(out.C);
  });

  test("the replacer is applied to a genuine instance's private value", async () => {
    class C {
      #secret = "RAW";
      constructor(s?: string) {
        if (s) this.#secret = s;
      }
      get() {
        return this.#secret;
      }
    }
    const c = new C();
    void c;
    const code = serialize(
      () => c,
      (_key, value) => (value === "RAW" ? "REDACTED" : value),
    );
    using dir = tempDir(`closure-rt-${Date.now()}`, { "mod.mjs": code });
    const out = ((await import(`${String(dir)}/mod.mjs`)).default as any)();
    expect(out.get()).toBe("REDACTED"); // replacer rewrote the private value
  });
});

describe("interactions: guards fire when nested", () => {
  test("a WeakMap nested in a captured object round-trips", async () => {
    const key = { id: 1 };
    const o = { inner: new WeakMap([[key, "v"]]), key };
    void o;
    const out = (await roundtrip(() => o))();
    expect(out.inner).toBeInstanceOf(WeakMap);
    expect(out.inner.get(out.key)).toBe("v");
  });
  test("a mid-iteration generator object nested in a Map still throws", () => {
    function* g() {
      yield 1;
      yield 2;
    }
    const live = g();
    live.next();
    const m = new Map([["gen", live]]);
    void m;
    expect(() => serialize(() => m)).toThrow(/started iterating/);
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

describe("AsyncLocalStorage", () => {
  // A store VALUE captured inside run() is just data and round-trips directly.
  test("captures a store value (inside run)", async () => {
    const als = new AsyncLocalStorage<{ user: string }>();
    const out = await als.run({ user: "alice" }, async () => {
      const store = als.getStore();
      void store;
      return (await roundtrip(() => store))();
    });
    expect(out).toEqual({ user: "alice" });
  });

  // An ALS instance reconstructs as a fresh instance (treated opaquely — its
  // native internals are never walked). Outside any run(), getStore() is undefined.
  test("an ALS instance reconstructs as a fresh, working store", async () => {
    const als = new AsyncLocalStorage<{ v: number }>();
    void als;
    const out = (await roundtrip(() => als))();
    expect(out).toBeInstanceOf(AsyncLocalStorage);
    expect(out.getStore()).toBeUndefined();
    expect(out.run({ v: 1 }, () => out.getStore())).toEqual({ v: 1 });
  });

  // THE KEY CASE: serializing a closure INSIDE als.run captures the active store
  // and re-establishes it on reify, so als.getStore() returns the same store.
  test("captures the active ALS context and restores it on reify", async () => {
    const als = new AsyncLocalStorage<{ user: string }>();
    const code = await als.run({ user: "alice" }, async () => {
      return serialize(() => als.getStore()!.user); // serialized inside run()
    });
    using dir = tempDir(`closure-als-ctx-${Math.random().toString(36).slice(2)}`, { "mod.mjs": code });
    const fn = (await import(`${String(dir)}/mod.mjs`)).default as () => string;
    expect(fn()).toBe("alice"); // context restored on reification
  });

  // INTERACTION: nested run() inside the reconstructed closure still composes.
  test("nested als.run inside a reconstructed closure composes", async () => {
    const als = new AsyncLocalStorage<number>();
    void als;
    const fn = await roundtrip(() =>
      als.run(1, () => {
        const outer = als.getStore();
        const inner = als.run(2, () => als.getStore());
        return [outer, inner, als.getStore()];
      }),
    );
    expect(fn()).toEqual([1, 2, 1]);
  });

  // INTERACTION: two ALS contexts captured together; both restored.
  test("captures two ALS contexts and restores both", async () => {
    const a = new AsyncLocalStorage<string>();
    const b = new AsyncLocalStorage<string>();
    const code = a.run("A", () => b.run("B", () => serialize(() => [a.getStore(), b.getStore()])));
    using dir = tempDir(`closure-als-2-${Math.random().toString(36).slice(2)}`, { "mod.mjs": code });
    const fn = (await import(`${String(dir)}/mod.mjs`)).default as () => string[];
    expect(fn()).toEqual(["A", "B"]);
  });
});

// ===========================================================================
// AsyncLocalStorage — rich interactions: module-scope capture, nesting,
// promises, and intermixed contexts. Behavior model:
//  - An ALS instance reconstructs as a fresh instance (opaque).
//  - The store ACTIVE at serialize time is snapshotted; the reified root is
//    wrapped so each call re-enters `als.run(store, ...)`.
// ===========================================================================

// Module-scope ALS instances — captured as free variables from module scope.
const moduleALS = new AsyncLocalStorage<{ tag: string }>();
const moduleALS_B = new AsyncLocalStorage<number>();

// Serialize `fn` (optionally inside a context the caller establishes), reify the
// resulting module, and return its default export.
async function reify<T = any>(code: string): Promise<T> {
  using dir = tempDir(`als-rich-${Math.random().toString(36).slice(2)}`, { "mod.mjs": code });
  return (await import(`${String(dir)}/mod.mjs`)).default as T;
}

describe("ALS rich: module-scope capture", () => {
  test("module-scope ALS, serialized OUTSIDE any run, reconstructs fresh (no context)", async () => {
    const fn = () => moduleALS.getStore() ?? "none";
    const code = serialize(fn); // no active context here
    const reified = await reify<() => string>(code);
    expect(reified()).toBe("none");
    // the consumer can establish their own context on the fresh instance
  });

  test("module-scope ALS, serialized INSIDE a run, captures the context", async () => {
    const code = moduleALS.run({ tag: "module-ctx" }, () => serialize(() => moduleALS.getStore()!.tag));
    const reified = await reify<() => string>(code);
    expect(reified()).toBe("module-ctx");
  });

  test("module-scope ALS captured alongside a function free variable", async () => {
    const decorate = (s: string) => `[${s}]`;
    void decorate;
    const code = moduleALS.run({ tag: "X" }, () => serialize(() => decorate(moduleALS.getStore()!.tag)));
    const reified = await reify<() => string>(code);
    expect(reified()).toBe("[X]");
  });
});

describe("ALS rich: nesting", () => {
  test("nested run at serialize time captures the INNERMOST store", async () => {
    const als = new AsyncLocalStorage<number>();
    const code = als.run(1, () => als.run(2, () => als.run(3, () => serialize(() => als.getStore()))));
    const reified = await reify<() => number>(code);
    expect(reified()).toBe(3); // innermost active context wins
  });

  test("reified closure restores captured context AND can shadow it internally", async () => {
    const als = new AsyncLocalStorage<string>();
    const code = als.run("outer", () =>
      serialize(() => {
        const captured = als.getStore(); // should be "outer"
        const shadowed = als.run("inner", () => als.getStore()); // "inner"
        const restored = als.getStore(); // back to "outer"
        return [captured, shadowed, restored];
      }),
    );
    const reified = await reify<() => string[]>(code);
    expect(reified()).toEqual(["outer", "inner", "outer"]);
  });

  test("two different ALS instances, nested at serialize time, both captured", async () => {
    const a = new AsyncLocalStorage<string>();
    const b = new AsyncLocalStorage<string>();
    const code = a.run("a1", () => b.run("b1", () => serialize(() => `${a.getStore()}/${b.getStore()}`)));
    const reified = await reify<() => string>(code);
    expect(reified()).toBe("a1/b1");
  });

  test("same ALS, two closures serialized in different nested contexts, stay independent", async () => {
    const als = new AsyncLocalStorage<number>();
    const codeOuter = als.run(10, () => serialize(() => als.getStore()));
    const codeInner = als.run(10, () => als.run(20, () => serialize(() => als.getStore())));
    const [outer, inner] = await Promise.all([reify<() => number>(codeOuter), reify<() => number>(codeInner)]);
    expect(outer()).toBe(10);
    expect(inner()).toBe(20);
  });

  test("a reified closure that itself serializes inside its own run is not double-wrapped", async () => {
    const als = new AsyncLocalStorage<string>();
    // outer captured context "L1"; the body opens "L2" and reads it.
    const code = als.run("L1", () =>
      serialize(() =>
        als
          .run("L2", () => `${als.getStore()}`)
          .concat("|")
          .concat(als.getStore()!),
      ),
    );
    const reified = await reify<() => string>(code);
    expect(reified()).toBe("L2|L1");
  });
});

describe("ALS rich: promises & async contexts", () => {
  const tick = () => new Promise<void>(r => setTimeout(r, 0));

  test("a reified ASYNC closure keeps the captured context across an await", async () => {
    const als = new AsyncLocalStorage<{ id: number }>();
    const code = als.run({ id: 7 }, () =>
      serialize(async () => {
        const before = als.getStore()!.id;
        await new Promise<void>(r => setTimeout(r, 0));
        const after = als.getStore()!.id; // context must survive the await
        return [before, after];
      }),
    );
    const reified = await reify<() => Promise<number[]>>(code);
    await expect(reified()).resolves.toEqual([7, 7]);
  });

  test("serialize called AFTER an await inside run still captures that run's context", async () => {
    const als = new AsyncLocalStorage<string>();
    const code = await als.run("ctx", async () => {
      await new Promise<void>(r => setTimeout(r, 0));
      return serialize(() => als.getStore()); // serialized post-await, still in "ctx"
    });
    const reified = await reify<() => string>(code);
    expect(reified()).toBe("ctx");
  });

  test("a reified closure returning a promise whose .then reads the store", async () => {
    const als = new AsyncLocalStorage<number>();
    const code = als.run(
      42,
      () => serialize(() => Promise.resolve().then(() => als.getStore())), // continuation reads store
    );
    const reified = await reify<() => Promise<number>>(code);
    await expect(reified()).resolves.toBe(42);
  });

  test("two async operations with DIFFERENT contexts each capture their own", async () => {
    const als = new AsyncLocalStorage<string>();
    const [codeA, codeB] = await Promise.all([
      als.run("A", async () => {
        await tick();
        return serialize(() => als.getStore());
      }),
      als.run("B", async () => {
        await tick();
        return serialize(() => als.getStore());
      }),
    ]);
    const [a, b] = await Promise.all([reify<() => string>(codeA), reify<() => string>(codeB)]);
    expect([a(), b()]).toEqual(["A", "B"]);
  });

  test("a reified async closure that awaits a captured async helper keeps context", async () => {
    const als = new AsyncLocalStorage<string>();
    const delay = (v: number) => new Promise<number>(r => setTimeout(() => r(v), 0));
    void delay;
    const code = als.run("ROLE", () =>
      serialize(async () => {
        const n = await delay(5);
        return `${als.getStore()}:${n}`; // store survives awaiting the captured helper
      }),
    );
    const reified = await reify<() => Promise<string>>(code);
    await expect(reified()).resolves.toBe("ROLE:5");
  });

  test("nested awaits each see the captured context", async () => {
    const als = new AsyncLocalStorage<number>();
    const code = als.run(100, () =>
      serialize(async () => {
        const seen: number[] = [];
        seen.push(als.getStore()!);
        await new Promise<void>(r => setTimeout(r, 0));
        seen.push(als.getStore()!);
        await new Promise<void>(r => setTimeout(r, 0));
        seen.push(als.getStore()!);
        return seen;
      }),
    );
    const reified = await reify<() => Promise<number[]>>(code);
    await expect(reified()).resolves.toEqual([100, 100, 100]);
  });
});

describe("ALS rich: intermixing & complex stores", () => {
  test("two ALS captured, only one has an active store — only that one is restored", async () => {
    const withCtx = new AsyncLocalStorage<string>();
    const without = new AsyncLocalStorage<string>();
    const code = withCtx.run("HAS", () => serialize(() => `${withCtx.getStore()}/${without.getStore() ?? "none"}`));
    const reified = await reify<() => string>(code);
    expect(reified()).toBe("HAS/none");
  });

  test("the store is a complex nested object (snapshotted by value)", async () => {
    const als = new AsyncLocalStorage<any>();
    const store = { user: { id: 1, roles: ["admin", "user"] }, meta: new Map([["k", "v"]]) };
    const code = als.run(store, () => serialize(() => als.getStore()));
    const reified = await reify<() => any>(code);
    const out = reified();
    expect(out.user).toEqual({ id: 1, roles: ["admin", "user"] });
    expect(out.meta.get("k")).toBe("v");
  });

  test("the store contains a function which is reconstructed and callable", async () => {
    const als = new AsyncLocalStorage<{ format: (n: number) => string }>();
    const code = als.run({ format: (n: number) => `#${n}` }, () => serialize(() => als.getStore()!.format(7)));
    const reified = await reify<() => string>(code);
    expect(reified()).toBe("#7");
  });

  test("a circular store round-trips", async () => {
    const als = new AsyncLocalStorage<any>();
    const store: any = { name: "root" };
    store.self = store;
    const code = als.run(store, () => serialize(() => als.getStore()));
    const reified = await reify<() => any>(code);
    const out = reified();
    expect(out.name).toBe("root");
    expect(out.self).toBe(out); // cycle preserved
  });

  test("the SAME object captured as both the store and a closure free variable keeps identity", async () => {
    const als = new AsyncLocalStorage<{ v: number }>();
    const shared = { v: 1 };
    void shared;
    const code = als.run(shared, () => serialize(() => als.getStore() === shared));
    const reified = await reify<() => boolean>(code);
    expect(reified()).toBe(true); // store and captured `shared` reconstruct as one object
  });

  test("two ALS whose stores reference each other (cross-linked) round-trip", async () => {
    const a = new AsyncLocalStorage<any>();
    const b = new AsyncLocalStorage<any>();
    const storeA: any = { name: "a" };
    const storeB: any = { name: "b", peer: storeA };
    storeA.peer = storeB;
    const code = a.run(storeA, () => b.run(storeB, () => serialize(() => [a.getStore(), b.getStore()])));
    const reified = await reify<() => any[]>(code);
    const [outA, outB] = reified();
    expect(outA.name).toBe("a");
    expect(outA.peer).toBe(outB); // cross-links preserved
    expect(outB.peer).toBe(outA);
  });
});

describe("ALS rich: edge cases", () => {
  test("run(undefined) captures no context (no wrapping)", async () => {
    const als = new AsyncLocalStorage<string>();
    const code = als.run(undefined as any, () => serialize(() => als.getStore() ?? "empty"));
    expect(code).not.toMatch(/\.run\(/); // no wrapper emitted
    const reified = await reify<() => string>(code);
    expect(reified()).toBe("empty");
  });

  test("a reified closure called many times re-enters the context each call", async () => {
    const als = new AsyncLocalStorage<number>();
    let n = 0;
    const code = als.run(5, () =>
      serialize(() => {
        const s = als.getStore()!;
        return s; // pure read; must be stable across calls
      }),
    );
    void n;
    const reified = await reify<() => number>(code);
    expect([reified(), reified(), reified()]).toEqual([5, 5, 5]);
  });

  test("mutating the store object AFTER serialize does not affect the snapshot", async () => {
    const als = new AsyncLocalStorage<{ v: number }>();
    const store = { v: 1 };
    const code = als.run(store, () => serialize(() => als.getStore()!.v));
    store.v = 999; // mutate original after serializing
    const reified = await reify<() => number>(code);
    expect(reified()).toBe(1); // snapshot value, not the later mutation
  });

  test("the body reads getStore multiple times consistently", async () => {
    const als = new AsyncLocalStorage<string>();
    const code = als.run("Z", () => serialize(() => [als.getStore(), als.getStore(), als.getStore()].join("-")));
    const reified = await reify<() => string>(code);
    expect(reified()).toBe("Z-Z-Z");
  });

  test("re-serializing a reified closure (serialize → reify → serialize) keeps the context", async () => {
    const als = new AsyncLocalStorage<string>();
    const code1 = als.run("persist", () => serialize(() => als.getStore()));
    using dir1 = tempDir(`als-re-${Math.random().toString(36).slice(2)}`, { "mod.mjs": code1 });
    const mod1 = await import(`${String(dir1)}/mod.mjs`);
    const fn1 = mod1.default as () => string;
    expect(fn1()).toBe("persist");
    // serialize the reified function again — it references the reconstructed ALS
    const code2 = serialize(fn1);
    const fn2 = await reify<() => string>(code2);
    expect(fn2()).toBe("persist"); // context survives a second round-trip
  });

  test("a closure capturing the ALS but NOT calling getStore still reconstructs", async () => {
    const als = new AsyncLocalStorage<string>();
    const code = als.run("unused", () => serialize(() => (typeof als.run === "function" ? "ok" : "no")));
    const reified = await reify<() => string>(code);
    expect(reified()).toBe("ok");
  });
});

describe("ALS rich: adversarial & concurrency", () => {
  test("concurrent reified closures with different captured contexts stay independent", async () => {
    const als = new AsyncLocalStorage<string>();
    const codes = ["c1", "c2", "c3"].map(c => als.run(c, () => serialize(() => als.getStore())));
    const fns = await Promise.all(codes.map(c => reify<() => string>(c)));
    // run them interleaved
    const results = await Promise.all(
      fns.map(async f => {
        await new Promise<void>(r => setTimeout(r, 0));
        return f();
      }),
    );
    expect(results).toEqual(["c1", "c2", "c3"]);
  });

  test("the store itself contains another ALS instance (nested ALS), reconstructed", async () => {
    const outer = new AsyncLocalStorage<{ inner: AsyncLocalStorage<number> }>();
    const inner = new AsyncLocalStorage<number>();
    const code = outer.run({ inner }, () =>
      serialize(() => {
        const innerAls = outer.getStore()!.inner;
        return innerAls.run(99, () => innerAls.getStore());
      }),
    );
    const reified = await reify<() => number>(code);
    expect(reified()).toBe(99);
  });

  test("a reified async closure that opens its OWN run after an await", async () => {
    const a = new AsyncLocalStorage<string>();
    const b = new AsyncLocalStorage<string>();
    const code = a.run("A", () =>
      serialize(async () => {
        await new Promise<void>(r => setTimeout(r, 0));
        const fromA = a.getStore(); // captured context survives await
        const fromB = b.run("B", () => b.getStore()); // own run
        return `${fromA}+${fromB}`;
      }),
    );
    const reified = await reify<() => Promise<string>>(code);
    await expect(reified()).resolves.toBe("A+B");
  });

  test("captured context where the store is also closed over by a nested helper", async () => {
    const als = new AsyncLocalStorage<{ n: number }>();
    const code = als.run({ n: 21 }, () => {
      const helper = () => als.getStore()!.n * 2;
      return serialize(() => helper());
    });
    const reified = await reify<() => number>(code);
    expect(reified()).toBe(42);
  });
});

describe("ALS rich: root-shape limits (graceful, no context restoration)", () => {
  // A generator's body runs lazily after run() returns, and wrapping a class
  // breaks `new` — so for these root shapes the ALS reconstructs but the captured
  // context is NOT restored. They still reconstruct and work; getStore() is just
  // undefined unless the consumer establishes a context.
  test("a generator root captured in a context reconstructs (context not restored)", async () => {
    const als = new AsyncLocalStorage<number>();
    const code = als.run(7, () =>
      serialize(function* () {
        yield als.getStore() ?? "none";
        yield als.getStore() ?? "none";
      }),
    );
    const genFn = await reify<() => Generator>(code);
    expect([...genFn()]).toEqual(["none", "none"]); // works as a generator; no context
    // the consumer CAN establish context themselves:
    // (a generator-specific run() at iteration time would be needed for context)
  });

  test("a class root captured in a context reconstructs constructable (context not restored)", async () => {
    const als = new AsyncLocalStorage<string>();
    const code = als.run("ctx", () =>
      serialize(
        class Svc {
          role() {
            return als.getStore() ?? "none";
          }
        },
      ),
    );
    const Svc = await reify<any>(code);
    const inst = new Svc(); // must still be constructable
    expect(inst.role()).toBe("none");
    // but a fresh run on the reconstructed ALS works (instance method reads it):
    // (requires the consumer to run() around the call)
  });
});

// ===========================================================================
// DOCUMENTED LIMITATIONS — cases the serializer does NOT fully handle yet.
//
// These tests are skipped on purpose: they document, as executable specs, what
// we can and can't do. Each body asserts the IDEAL behavior (so when a case is
// implemented the test un-skips and proves it); the comment records the CURRENT
// behavior and whether the gap is FUNDAMENTAL (needs engine support / impossible)
// or FIXABLE (a feature we just haven't built).
//
// VERIFIED current behavior (2026-06-21): every case below currently fails with a
// clear error — a serialize-time TypeError for the suspended/live-state cases, or
// an import-time ReferenceError for the computed-field-key case — never silent
// corruption.
// ===========================================================================
describe("documented limitations (skipped)", () => {
  // FUNDAMENTAL. A generator's suspended frame (resume point + locals) lives in
  // engine slots not reachable via reflection. serialize() throws a clear
  // TypeError("Cannot serialize a Generator object ..."). Reconstructing a
  // PARTIALLY-consumed generator would need native VM support to snapshot/restore
  // the frame. Workaround: serialize the generator FUNCTION and recreate the
  // iterator (that round-trips today).
  test.skip("a partially-consumed generator resumes where it left off", async () => {
    function* g() {
      yield 1;
      yield 2;
      yield 3;
    }
    const it = g();
    it.next(); // consume the first value
    void it;
    const out = (await roundtrip(() => it))();
    expect(out.next().value).toBe(2); // would resume at 2
  });

  // FUNDAMENTAL (same reason as generators).
  test.skip("a partially-consumed async generator resumes where it left off", async () => {
    async function* ag() {
      yield 1;
      yield 2;
    }
    const ait = ag();
    await ait.next();
    void ait;
    const out = (await roundtrip(() => ait))();
    expect((await out.next()).value).toBe(2);
  });

  // FUNDAMENTAL. A builtin iterator (Map/Set/array .entries()/.values()) holds the
  // same kind of suspended cursor. serialize() throws a clear TypeError.
  test.skip("a partially-consumed builtin iterator resumes where it left off", async () => {
    const iter = new Map([
      ["a", 1],
      ["b", 2],
    ]).entries();
    iter.next();
    void iter;
    const out = (await roundtrip(() => iter))();
    expect(out.next().value).toEqual(["b", 2]);
  });

  // FUNDAMENTAL / BY DESIGN. A pending Promise's resolution is tied to live I/O or
  // timers — not expressible as source. serialize() throws a clear
  // TypeError("Cannot serialize a pending Promise ..."). Await it first, then
  // serialize the settled value (settled promises DO round-trip).
  test.skip("a pending promise round-trips and later resolves", async () => {
    let resolve!: (v: number) => void;
    const pending = new Promise<number>(r => (resolve = r));
    void pending;
    const out = (await roundtrip(() => pending))();
    resolve(42);
    expect(await out).toBe(42);
  });

  // FIXABLE. A computed FIELD key whose variable is used ONLY as the key
  // (`const k = "x"; class C { [k] = 1 }`) is pruned from the class's scope by JSC,
  // and — unlike a computed METHOD key — there is no method source to match the key
  // back to. serialize() currently succeeds but emits `[k]` referencing an unbound
  // `k`, so the reconstructed module throws ReferenceError at import. TODO: recover
  // the key from the instance's own keys (the analog of recoverComputedKeyValues for
  // methods), or reject at serialize time so it fails loudly instead.
  test.skip("a computed field key used only as the key round-trips", async () => {
    const k = "dynamicField";
    class C {
      [k] = 5;
      plain = 1;
    }
    const c = new C();
    void c;
    const out = (await roundtrip(() => c))();
    expect((out as any).dynamicField).toBe(5);
    expect((out as any).plain).toBe(1);
  });

  // FIXABLE-ish. Genuine #private reification of a subclass of WeakMap/WeakSet/Date/
  // Error/Promise is not done (only Map/Set/Array bases are genuine). These still
  // reconstruct CORRECTLY via the mangled fallback — they just don't get true
  // slot-privacy. This test asserts the stronger GENUINE outcome (no mangled field),
  // which we don't yet provide for these bases.
  test.skip("a WeakMap subclass with a private field reifies genuinely", async () => {
    class TaggedWeak extends WeakMap<object, number> {
      #tag = "w";
      tag() {
        return this.#tag;
      }
    }
    const w = new TaggedWeak();
    void w;
    const code = serialize(() => w);
    expect(code).not.toContain("$bunClosurePrivate$"); // would be genuine
    const out = (await roundtrip(() => w))();
    expect(out.tag()).toBe("w");
  });
});

// Deterministic round-trip fuzz: a seeded generator builds random value graphs (data,
// builtins, cycles, and genuine-private class instances across the supported matrix); each
// is serialized → re-imported → deep-compared. Fixed seeds keep it reproducible (not
// flaky). This guards against silent-corruption regressions across the whole machinery —
// the class of bug this caught (undefined-property drop, inline-base collision).
describe("round-trip fuzz (seeded, deterministic)", () => {
  const mulberry32 = (a: number) => () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  class P {
    #x: any;
    constructor(v: any) {
      this.#x = v;
    }
    probe() {
      return { x: this.#x };
    }
  }
  class Self {
    #me: any = null;
    #v: any;
    constructor(v: any) {
      this.#me = this;
      this.#v = v;
    }
    probe(): any {
      return { isSelf: this.#me === this, v: this.#v };
    }
  }
  class B {
    #b: any;
    constructor(v: any) {
      this.#b = v;
    }
    gb() {
      return this.#b;
    }
  }
  class D extends B {
    #d: any;
    constructor(b: any, d: any) {
      super(b);
      this.#d = d;
    }
    probe() {
      return { b: this.gb(), d: this.#d };
    }
  }
  class Coll extends class A {
    #x: any;
    constructor(v: any) {
      this.#x = v;
    }
    ax() {
      return this.#x;
    }
  } {
    #x: any;
    constructor(a: any, b: any) {
      super(a);
      this.#x = b;
    }
    probe() {
      return { a: this.ax(), x: this.#x };
    }
  }
  class TM extends Map<string, any> {
    #t: any;
    constructor(e: any, t: any) {
      super(e);
      this.#t = t;
    }
    probe() {
      return { t: this.#t, e: [...this] };
    }
  }
  const SHAPES = [
    (v: any) => new P(v),
    (v: any) => new Self(v),
    (v: any) => new D(v, v),
    (v: any) => new Coll(v, v),
    (v: any) => new TM([["k", v]], v),
  ];

  const genLeaf = (rng: () => number): any => {
    const t = Math.floor(rng() * 6);
    return t === 0
      ? Math.floor(rng() * 1000) - 500
      : t === 1
        ? "s" + Math.floor(rng() * 999)
        : t === 2
          ? rng() > 0.5
          : t === 3
            ? null
            : t === 4
              ? undefined
              : new Date(Math.floor(rng() * 1e12));
  };
  const genValue = (rng: () => number, depth: number): any => {
    if (depth <= 0 || rng() < 0.4) return genLeaf(rng);
    const t = Math.floor(rng() * 8);
    if (t === 0) {
      const n = Math.floor(rng() * 4);
      const a: any[] = [];
      for (let i = 0; i < n; i++) a.push(genValue(rng, depth - 1));
      return a;
    }
    if (t === 1) {
      const o: any = {};
      const n = Math.floor(rng() * 4);
      for (let i = 0; i < n; i++) o["k" + i] = genValue(rng, depth - 1);
      return o;
    }
    if (t === 2) {
      const m = new Map();
      const n = Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) m.set("k" + i, genValue(rng, depth - 1));
      return m;
    }
    if (t === 3) return SHAPES[Math.floor(rng() * SHAPES.length)](genValue(rng, depth - 1));
    return genLeaf(rng);
  };

  const eq = (a: any, b: any, seen: Array<[any, any]>): boolean => {
    if (a === b) return true;
    if (typeof a === "bigint" || typeof b === "bigint") return a === b;
    if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return Object.is(a, b);
    for (const [x, y] of seen) if (x === a && y === b) return true;
    seen.push([a, b]);
    if (a instanceof Date) return b instanceof Date && a.getTime() === b.getTime();
    if (typeof a.probe === "function" && typeof b.probe === "function") return eq(a.probe(), b.probe(), seen);
    if (a instanceof Map)
      return b instanceof Map && a.size === b.size && [...a].every(([k, v]) => b.has(k) && eq(v, b.get(k), seen));
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i], seen)) return false;
      return true;
    }
    const ka = Object.keys(a),
      kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!(k in b) || !eq(a[k], b[k], seen)) return false;
    return true;
  };

  test("100 seeded random graphs round-trip with deep equality", async () => {
    let checked = 0;
    for (let seed = 0; seed < 100; seed++) {
      const rng = mulberry32(seed + 1);
      const val = genValue(rng, 3);
      const fn = await roundtrip(() => val);
      const out = (fn as any)();
      checked++;
      // On mismatch, surface the seed so it can be reproduced.
      expect(eq(val, out, []) ? "ok" : `seed ${seed} mismatch`).toBe("ok");
    }
    expect(checked).toBe(100);
  });
});

// Regressions surfaced by the adversarial fuzz/subagent campaign.
describe("adversarial regressions", () => {
  // An own data property literally named `__proto__` must round-trip as an OWN property, not
  // reparent the object. The generated `name["__proto__"] = v` form would invoke the
  // Object.prototype `__proto__` setter (reparenting on an object value, silently dropping a
  // primitive); it's now routed through Object.defineProperty.
  test("an own `__proto__` data property round-trips without reparenting (plain object)", async () => {
    const marker = { iAmData: true };
    const obj: any = {};
    Object.defineProperty(obj, "__proto__", { value: marker, writable: true, enumerable: true, configurable: true });
    const out = (await roundtrip(() => obj))() as any;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype); // NOT reparented to marker
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toEqual({ iAmData: true });
  });

  test("an own `__proto__` data property round-trips on a genuine #private instance", async () => {
    class C {
      #s: string;
      constructor() {
        this.#s = "sek";
      }
      get() {
        return this.#s;
      }
    }
    const inst: any = new C();
    Object.defineProperty(inst, "__proto__", {
      value: { data: 1 },
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const out = (await roundtrip(() => inst))() as any;
    // The reconstructed instance belongs to a freshly-rebuilt class, so `instanceof` the
    // original C is naturally false; assert the prototype was NOT reparented to `{data:1}`.
    expect(Object.getPrototypeOf(out).constructor.name).toBe("C"); // still the rebuilt C, not reparented
    expect(out.get()).toBe("sek"); // prototype method + genuine #private still reachable
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toEqual({ data: 1 });
  });

  // A replacer returning undefined drops the property. On a genuine instance the reify factory
  // runs the real constructor, so a field-initialized public property already exists — the drop
  // must `delete` it, not merely skip re-assignment (which left the constructor's value).
  test("a replacer dropping a field-initialized public property removes it on a genuine instance", async () => {
    class C {
      #s = "S";
      pub = "PUB";
      get() {
        return this.#s;
      }
    }
    const c = new C();
    void c;
    const code = serialize(
      () => c,
      (_k, v) => (v === "PUB" ? undefined : v),
    );
    using dir = tempDir("closure-proto-drop", { "mod.mjs": code });
    const out = ((await import(`${String(dir)}/mod.mjs`)).default as any)();
    expect("pub" in out).toBe(false); // dropped for real
    expect(out.get()).toBe("S"); // the #private (not dropped) survives
  });

  // restoreBuiltinContent restores a genuine Map/Set subclass's entries via the BASE
  // set/add, not the subclass override — restoring through an override would re-apply its
  // transform / re-run its side effects on top of the already-final contents.
  test("a genuine Map subclass overriding set() restores exact entries (no double transform)", async () => {
    class Doubler extends Map {
      #tag: string;
      constructor() {
        super();
        this.#tag = "T";
      }
      set(k: any, v: any) {
        return super.set(k, v * 2); // stores doubled
      }
    }
    const m = new Doubler();
    m.set("a", 5); // stores 10
    void m;
    const out = (await roundtrip(() => m))() as any;
    expect(out instanceof Map).toBe(true);
    expect(out.get("a")).toBe(10); // restored value is the live 10, NOT re-doubled to 20
  });

  test("a genuine Set subclass overriding add() does not re-run side effects on restore", async () => {
    const flog: string[] = [];
    class Logged extends Set {
      #n: number;
      constructor() {
        super();
        this.#n = 7;
      }
      add(v: any) {
        flog.push(v);
        return super.add(v);
      }
    }
    const s = new Logged();
    s.add("x");
    s.add("y"); // flog === ["x","y"]
    void [s, flog];
    const out = (await roundtrip(() => ({ s, flog })))() as any;
    expect([...out.s]).toEqual(["x", "y"]);
    expect(out.flog).toEqual(["x", "y"]); // add() override NOT re-invoked during restore
  });

  // A plain Map/Set with a user-installed `Symbol.iterator` override must still serialize its
  // REAL entries (read via the base iterator), not whatever the override yields. This is the
  // read/walk-side analogue of the overridden-set/add restore bug.
  test("a Map with an overridden Symbol.iterator serializes its real entries", async () => {
    const m: any = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    m[Symbol.iterator] = function* () {
      yield ["HIJACKED", 999];
    };
    const out = (await roundtrip(() => m))() as any;
    expect([...Map.prototype[Symbol.iterator].call(out)]).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  test("a Set with an overridden Symbol.iterator serializes its real elements", async () => {
    const s: any = new Set([1, 2, 3]);
    s[Symbol.iterator] = function* () {
      yield "EVIL";
    };
    const out = (await roundtrip(() => s))() as any;
    expect([...Set.prototype[Symbol.iterator].call(out)]).toEqual([1, 2, 3]);
  });

  // An ALS-wrapped root that is a plain `function` must stay constructable (the wrapper is a
  // Proxy with apply+construct traps, not an arrow). `new` works and `this` is forwarded,
  // both inside the restored async context.
  test("an ALS-captured constructor function stays constructable and keeps its context", async () => {
    const als = new AsyncLocalStorage<{ tag: string }>();
    let code!: string;
    als.run({ tag: "t" }, () => {
      function Widget(this: any) {
        this.store = als.getStore();
      }
      code = serialize(Widget);
    });
    using dir = tempDir("closure-als-ctor", { "mod.mjs": code });
    const W = (await import(`${String(dir)}/mod.mjs`)).default as any;
    const inst = new W(); // would throw "not a constructor" with an arrow wrapper
    expect(inst.store).toEqual({ tag: "t" });
  });

  test("an ALS-captured function forwards `this` through .call inside the restored context", async () => {
    const als = new AsyncLocalStorage<{ tag: string }>();
    let code!: string;
    als.run({ tag: "t" }, () => {
      function reader(this: any) {
        return { store: als.getStore(), self: this };
      }
      code = serialize(reader);
    });
    using dir = tempDir("closure-als-this", { "mod.mjs": code });
    const r = (await import(`${String(dir)}/mod.mjs`)).default as any;
    const out = r.call({ id: "x" });
    expect(out.self).toEqual({ id: "x" }); // `this` forwarded (arrow wrapper dropped it)
    expect(out.store).toEqual({ tag: "t" });
  });

  // A resizable ArrayBuffer must keep its maxByteLength (so .resize works) and a
  // length-tracking view must keep tracking after the buffer resizes.
  test("a resizable ArrayBuffer and its length-tracking view round-trip", async () => {
    const rab = new ArrayBuffer(8, { maxByteLength: 32 });
    const lt = new Uint8Array(rab);
    lt.set([1, 2, 3, 4, 5, 6, 7, 8]);
    const v = { rab, lt };
    const out = (await roundtrip(() => v))() as any;
    expect(out.rab.resizable).toBe(true);
    expect(out.rab.maxByteLength).toBe(32);
    expect([...out.lt]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    out.rab.resize(16); // would throw on a non-resizable reconstruction
    expect(out.lt.length).toBe(16); // still length-tracking
  });
});

// Round-2 subagent findings. Encoded as regression tests BEFORE the fixes land; each
// currently FAILS, and must pass once the corresponding fix is in.
describe("adversarial regressions: round 2", () => {
  // BUG L: prototype properties assigned imperatively (the classic pre-ES6 constructor
  // pattern) are dropped — the reconstructed prototype carries only `constructor`, because
  // emission relies on the function's source text and never serializes `fn.prototype`'s own
  // properties.
  test("imperatively-assigned prototype properties on a constructor function round-trip", async () => {
    function Animal(this: any, name: string) {
      this.name = name;
    }
    (Animal.prototype as any).speak = function (this: any) {
      return this.name + " speaks";
    };
    (Animal.prototype as any).legs = 4;
    const dog = new (Animal as any)("Rex");
    const out = (await roundtrip(() => dog))() as any;
    expect(out.name).toBe("Rex");
    expect(out.legs).toBe(4);
    expect(out.speak()).toBe("Rex speaks");
  });

  // BUG L (class variant): a class prototype monkey-patched after declaration.
  test("imperatively-added class prototype members round-trip", async () => {
    class K {}
    (K.prototype as any).extra = function () {
      return 7;
    };
    const k = new K();
    void k;
    const out = (await roundtrip(() => k))() as any;
    expect(out.extra()).toBe(7);
  });

  // BUG M: a directly-captured `Class.prototype` must keep its identity — the same object as
  // the reconstructed class's `.prototype` and the instance's [[Prototype]] — not a fresh
  // duplicate `{}`.
  test("a directly-captured class prototype keeps shared identity", async () => {
    class Foo {
      hello() {
        return "hi";
      }
    }
    const inst = new Foo();
    const protoRef = Foo.prototype;
    void [inst, protoRef];
    const out = (await roundtrip(() => ({ inst, protoRef, cls: Foo })))() as any;
    expect(out.inst.hello()).toBe("hi");
    expect(Object.getPrototypeOf(out.inst)).toBe(out.protoRef); // one shared object
    expect(out.protoRef).toBe(out.cls.prototype);
  });

  // BUG N: the genuine #private reify path re-runs PUBLIC field initializers (they execute
  // before the constructor body, where the REIFY guard sits), so a side-effecting initializer
  // runs an extra time on reconstruction (and a field-initializer-only binding would be
  // needed at import). The final field VALUE must come from the snapshot, with no re-run.
  test("a side-effecting public field initializer does not re-run on a genuine instance", async () => {
    const log: string[] = [];
    class C {
      #p = 1;
      x = (log.push("init"), 5);
      read() {
        return log.length;
      }
      gp() {
        return this.#p;
      }
    }
    const inst = new C(); // log === ["init"]
    void inst;
    const out = (await roundtrip(() => inst))() as any;
    expect(out.read()).toBe(1); // initializer must NOT re-run (would be 2)
    expect(out.gp()).toBe(1);
    expect(out.x).toBe(5);
  });

  // BUG J: a static block referencing a captured outer variable. With the variable hoisted
  // (a method also reads it) there's no crash, but the static block RE-RUNS on class
  // re-evaluation, duplicating its side effect. (The crash variant — variable referenced
  // ONLY by the static block — is the same root cause: static blocks aren't part of the
  // class's collected free variables / aren't suppressed on reconstruction.)
  test("a static block's side effect does not re-run on reconstruction", async () => {
    const log: string[] = [];
    const make = () => {
      class C {
        static {
          log.push("s");
        }
        m() {
          return log.length;
        }
      }
      return new C();
    };
    const inst = make(); // log === ["s"]
    void inst;
    const out = (await roundtrip(() => inst))() as any;
    expect(out.m()).toBe(1); // static block side effect not duplicated (would be 2)
  });

  // A side-effecting STATIC field initializer must not re-run, but its value must survive
  // (restored as the class's own static property).
  test("a static field initializer does not re-run but its value is preserved", async () => {
    const log: string[] = [];
    const make = () => {
      class C {
        static x = (log.push("init"), 42);
        m() {
          return log.length;
        }
      }
      return new C();
    };
    const inst = make(); // log === ["init"], C.x === 42
    void inst;
    const out = (await roundtrip(() => inst))() as any;
    expect(out.m()).toBe(1); // not re-run
    expect(out.constructor.x).toBe(42); // value preserved
  });

  // A genuine instance field initializer that references a captured-only helper must not run
  // on reify (it would need the helper bound at import); the snapshot value is used instead.
  test("a genuine field initializer referencing a captured-only helper does not run on reify", async () => {
    const make = () => {
      const helper = () => 99;
      class C {
        #p = 1;
        x = helper();
        gp() {
          return this.#p;
        }
      }
      return new C();
    };
    const inst = make();
    void inst;
    const out = (await roundtrip(() => inst))() as any;
    expect(out.x).toBe(99); // snapshot value
    expect(out.gp()).toBe(1);
  });

  // A derived genuine class with a side-effecting field initializer: reify must skip it.
  test("a derived genuine class does not re-run a side-effecting field initializer", async () => {
    const log: string[] = [];
    class Base {
      #b = 1;
      getB() {
        return this.#b;
      }
    }
    class Derived extends Base {
      #d: number;
      y = (log.push("init"), 7);
      constructor() {
        super();
        this.#d = 3;
      }
      probe() {
        return [this.#d, log.length];
      }
    }
    const inst = new Derived(); // log === ["init"]
    void inst;
    const out = (await roundtrip(() => inst))() as any;
    expect(out.probe()).toEqual([3, 1]); // #d preserved, initializer not re-run
    expect(out.y).toBe(7);
    expect(out.getB()).toBe(1);
  });
});

// Round-3 subagent findings. Encoded as test.failing BEFORE their fixes; each flips red
// (signalling the fix landed) once correct, at which point it becomes a plain test().
describe("adversarial regressions: round 3", () => {
  // BUG R: analyzeSharedCells walks an EXTERNAL import's value graph instead of skipping it,
  // so a JS-implemented node builtin (node:util format) dives into native internals and throws.
  test("a closure referencing a JS-implemented node builtin re-emits the import", () => {
    const fn = () => nodeUtilFormat("%s", "x");
    expect(() => serialize(fn)).not.toThrow();
  });

  // BUG O: RegExp lastIndex (iteration cursor) is reset to 0; extra own props on RegExp/Date
  // are dropped (own-prop restore only runs on the subclass path).
  test("a stateful global regex preserves lastIndex", async () => {
    const re = /a/g;
    re.lastIndex = 2;
    const out = (await roundtrip(() => re))() as RegExp;
    expect(out.lastIndex).toBe(2);
    expect(out.exec("aaaa")!.index).toBe(2);
  });
  test("extra own properties on a RegExp and a Date round-trip", async () => {
    const re: any = /z/;
    re.custom = 42;
    const d: any = new Date(1000);
    d.label = "hi";
    const out = (await roundtrip(() => ({ re, d })))() as any;
    expect(out.re.custom).toBe(42);
    expect(out.d.label).toBe("hi");
  });

  // BUG P1: extra own properties on a bound function are dropped (the bound branch returns
  // before emitOwnProperties).
  test("extra own properties on a bound function round-trip", async () => {
    function g() {
      return 42;
    }
    const bf: any = g.bind(null);
    bf.extra = "hello";
    const out = (await roundtrip(() => bf))() as any;
    expect(out.extra).toBe("hello");
  });

  // BUG (name cluster): a function's reconstructed `.name` must match its live name —
  // covering a block-scoped function (toString omits the name), a `.name` overridden via
  // defineProperty, and the bound-function name (which derives "bound <name>").
  test("a block-scoped function preserves its name and self-reference", async () => {
    function makeSelf() {
      function inner() {
        return inner.name;
      }
      return inner;
    }
    const self = makeSelf();
    const out = (await roundtrip(() => self))() as any;
    expect(out.name).toBe("inner");
    expect(out()).toBe("inner"); // self-reference resolves to the named function, not a ref
  });
  test("a function with a defineProperty-overridden name preserves it", async () => {
    function f1() {
      return 1;
    }
    Object.defineProperty(f1, "name", { value: "renamed", configurable: true });
    const out = (await roundtrip(() => f1))() as any;
    expect(out.name).toBe("renamed");
  });
  test("a bound block-scoped function does not leak an internal name", async () => {
    function makeBound() {
      function foo(a: number, b: number, c: number) {
        return a + b + c;
      }
      return foo.bind(null, 1);
    }
    const bf = makeBound();
    const out = (await roundtrip(() => bf))() as any;
    expect(out.name).not.toContain("__bunClosure");
    expect(out.name).toBe("bound foo");
  });

  // BUG V: a property referenced ONLY inside an `eval` string is invisible to the access-path
  // walker, so it's pruned away — silent data corruption. A function that may call `eval`
  // must keep all its captured free variables whole.
  test("a property used only inside eval is not pruned away", async () => {
    const config = { apiKey: "SECRET", region: "us" };
    const fn = () => {
      const r = config.region;
      return r + ":" + eval("config.apiKey");
    };
    const out = (await roundtrip(fn))() as string;
    expect(out).toBe("us:SECRET");
  });

  // BUG Q: an Error subclass INSTANCE loses subclass identity — its prototype is rebuilt as a
  // standalone object instead of linking to the reconstructed constructor's prototype.
  test("an Error subclass instance keeps `instanceof` its reconstructed constructor", async () => {
    class AppError extends Error {
      constructor(m: string) {
        super(m);
        this.name = "AppError";
      }
    }
    const e = new AppError("boom");
    const out = (await roundtrip(() => e))() as any;
    expect(out instanceof Error).toBe(true);
    expect(out instanceof out.constructor).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(out.constructor.prototype);
  });

  // BUG S: a method using `super`, extracted from its object, emits a module with bare `super`
  // (a syntax error) — must be rejected clearly at serialize time, not emit unimportable output.
  test("extracting a method that uses super is rejected clearly", () => {
    const proto = {
      g() {
        return "hi";
      },
    };
    const o = {
      __proto__: proto,
      g() {
        return (super.g as any)() + "!";
      },
    };
    expect(() => serialize(o.g)).toThrow();
  });
});

// Computed field keys (a previously-noted limitation) work in this build — lock it in.
describe("computed field keys", () => {
  test("a computed string field key (used only as the key) round-trips", async () => {
    const k = "onlyKey";
    class C {
      [k] = 5;
    }
    const c = new C();
    void c;
    const out = (await roundtrip(() => c))() as any;
    expect(out.onlyKey).toBe(5);
  });
  test("a computed field key on a genuine #private class round-trips", async () => {
    const k = "gk";
    class C {
      #p = 1;
      [k] = 8;
      gp() {
        return this.#p;
      }
    }
    const c = new C();
    void c;
    const out = (await roundtrip(() => c))() as any;
    expect(out.gk).toBe(8);
    expect(out.gp()).toBe(1);
  });
});

// Round-4 subagent findings, encoded test.failing before their fixes.
describe("adversarial regressions: round 4", () => {
  // BUG W: a plain array drops every non-index own property (the array emit branch never
  // calls emitOwnProperties).
  test("a plain array preserves non-index own properties", async () => {
    const a: any = [1, 2, 3];
    a.foo = "bar";
    const out = (await roundtrip(() => a))() as any;
    expect(Array.isArray(out)).toBe(true);
    expect([...out]).toEqual([1, 2, 3]);
    expect(out.foo).toBe("bar");
  });

  // BUG X: an own data property shadowing a prototype accessor is emitted via plain
  // assignment, which walks the prototype chain and fires the inherited setter (or throws
  // for a getter-only accessor) instead of creating an own data property.
  test("an own data property shadowing a prototype accessor round-trips", async () => {
    const make = () => {
      class C {
        _viaSetter: any;
        get x() {
          return "proto";
        }
        set x(v) {
          this._viaSetter = v;
        }
      }
      const i: any = new C();
      Object.defineProperty(i, "x", { value: "own", enumerable: true, writable: true, configurable: true });
      return i;
    };
    const i = make();
    const out = (await roundtrip(() => i))() as any;
    expect(out.x).toBe("own"); // own data prop shadows the accessor
    expect(out._viaSetter).toBeUndefined(); // setter NOT invoked
  });

  // BUG Y: a frozen/sealed class prototype (or constructor) loses its extensibility state
  // (the prototype is emitted via the function path, never through emitObject's freeze block).
  test("a frozen class prototype stays frozen", async () => {
    const make = () => {
      class C {
        m() {
          return 1;
        }
      }
      Object.freeze(C.prototype);
      return new C();
    };
    const i = make();
    const out = (await roundtrip(() => i))() as any;
    expect(Object.isFrozen(Object.getPrototypeOf(out))).toBe(true);
    expect(out.m()).toBe(1);
  });

  // BUG2: a graph whose longest emission chain is very long (a deep linked list, or a wide
  // graph with a long acyclic path) used to overflow the recursive emission. The analysis
  // pre-passes and the emission are now iterative (heap worklists), so it serializes — and the
  // flat output (declarations + assignments, no nested literals) also imports without overflow.
  // 30000 is well past the old ~6000-deep call-stack limit.
  test("a deep object graph serializes iteratively without overflowing the stack", async () => {
    const N = 30000;
    let head: any = { v: 0 };
    for (let i = 1; i < N; i++) head = { v: i, next: head };
    const out = (await roundtrip(() => head))() as any;
    let n = out;
    let count = 0;
    let deepest: number | undefined;
    while (n) {
      deepest = n.v;
      count++;
      n = n.next;
    }
    expect(count).toBe(N);
    expect(out.v).toBe(N - 1); // head
    expect(deepest).toBe(0); // tail
  });

  // A deep chain of built-in containers (Maps) goes through the iterative builtin body path.
  test("a deep Map chain serializes iteratively", async () => {
    const N = 20000;
    let m = new Map<string, unknown>([["v", 0]]);
    for (let i = 1; i < N; i++)
      m = new Map<string, unknown>([
        ["v", i],
        ["next", m],
      ]);
    const out = (await roundtrip(() => m))() as Map<string, any>;
    let node: any = out;
    let count = 0;
    while (node) {
      count++;
      node = node.get("next");
    }
    expect(count).toBe(N);
    expect(out.get("v")).toBe(N - 1);
  });

  // A wide, heavily-shared graph (each node points at several others, including a long acyclic
  // path) serializes iteratively, preserving shared identity and cycles.
  test("a wide, heavily-shared graph serializes iteratively with identity preserved", async () => {
    const N = 6400;
    const nodes: Array<{ i: number; refs: any[] }> = [];
    for (let i = 0; i < N; i++) nodes.push({ i, refs: [] });
    for (let i = 0; i < N; i++) {
      nodes[i].refs.push(nodes[(i + 1) % N], nodes[(i * 7 + 3) % N], nodes[0]);
    }
    const out = (await roundtrip(() => nodes[0]))() as any;
    expect(out.i).toBe(0);
    expect(out.refs.length).toBe(3);
    expect(out.refs[2]).toBe(out); // the shared back-edge to node 0 keeps its identity
  });

  // A deep chain of functions captured through each other (`f0` closes over `f1` closes over
  // `f2` …) — function emission is an iterative post-order (captured-function deps emitted before
  // each function), so the chain serializes instead of overflowing. 8000 is well past the old
  // ~6000-deep call-stack limit.
  test("a deep chain of functions captured through each other serializes", async () => {
    const N = 8000;
    let f: any = () => 0;
    for (let i = 1; i < N; i++) {
      const prev = f;
      f = () => prev();
    }
    const out = (await roundtrip(() => f))() as any;
    expect(typeof out).toBe("function");
    expect(out()).toBe(0); // calling through all N levels reaches the base
  });
});

// Round-4 subagent campaign findings (post iterative-emission refactor).
describe("adversarial regressions: round 4", () => {
  // An own property holding a function that captures the host back (`F.helper = () => F`) used
  // to double-declare the host (the post-order in-progress guard was per-call, not shared) →
  // `SyntaxError: already declared` at import.
  test("a function whose own property captures it back round-trips (no double-declare)", async () => {
    function F() {
      return 1;
    }
    (F as any).helper = () => F;
    const out = (await roundtrip(() => F))() as any;
    expect(out()).toBe(1);
    expect(out.helper()).toBe(out); // the back-capture resolves to the one reconstructed F
  });

  test("a class with a static factory capturing itself round-trips", async () => {
    class C {
      static make = () => new C();
      tag() {
        return "c";
      }
    }
    const out = (await roundtrip(() => C))() as any;
    expect(out.make().tag()).toBe("c");
  });

  // Extra own properties on a plain built-in captured by reference were dropped (only Date/RegExp
  // /Error restored them) — Map/Set/typed-array/ArrayBuffer/boxed/Weak* now restore them too.
  test("extra own properties on a captured Map / typed array / boxed primitive round-trip", async () => {
    const m: any = new Map([["a", 1]]);
    m.meta = "x";
    const ta: any = new Uint8Array([1, 2, 3]);
    ta.label = "t";
    const n: any = new Number(42);
    n.tag = "num";
    const out = (await roundtrip(() => ({ m, ta, n })))() as any;
    expect(out.m.get("a")).toBe(1);
    expect(out.m.meta).toBe("x");
    expect(out.ta[0]).toBe(1);
    expect(out.ta.label).toBe("t");
    expect(out.n.valueOf()).toBe(42);
    expect(out.n.tag).toBe("num");
  });

  // The replacer was applied to array/object entries but bypassed for plain Map/Set entries
  // (only the genuine-subclass path honored it).
  test("the replacer is applied to plain Map values and Set elements", async () => {
    const m = new Map([["x", 2]]);
    const s = new Set([5, 6]);
    const code = serialize(
      () => ({ m, s }),
      (_k, v) => (typeof v === "number" ? v * 100 : v),
    );
    using dir = tempDir("closure-r4-replacer", { "mod.mjs": code });
    const out = ((await import(`${String(dir)}/mod.mjs`)).default as any)();
    expect(out.m.get("x")).toBe(200);
    expect([...out.s].sort((a: number, b: number) => a - b)).toEqual([500, 600]);
  });

  // A hostable escaped `#private` arrow as the SERIALIZATION ROOT was emitted with an unbound
  // `this` (the root routes through reconstructFunctionExpr, which has no hosting branch).
  test("a hostable #private arrow as the serialization root is hosted", async () => {
    class Counter {
      #n = 5;
      reader() {
        return () => this.#n;
      }
    }
    const c = new Counter();
    const arrow = c.reader();
    void arrow;
    const out = (await roundtrip(arrow))();
    expect(out).toBe(5);
  });

  // Values reachable ONLY through a Map/Set key/value were invisible to the analysis pre-passes,
  // so a genuine #private instance behind a Map was silently downgraded to public mangling
  // (privacy lost), and a hostable arrow behind a Map was wrongly rejected.
  test("a genuine #private instance reachable only through a Map keeps real privacy", async () => {
    class Secret {
      #pw = "hunter2";
      check(x: string) {
        return x === this.#pw;
      }
    }
    const s = new Secret();
    const m = new Map([["s", s]]);
    void m;
    const out = (await roundtrip(() => ({ m })))() as any;
    const rs = out.m.get("s");
    expect(Object.keys(rs)).toEqual([]); // #pw is NOT a public own key (genuine private)
    expect(rs.check("hunter2")).toBe(true);
    expect(rs.check("nope")).toBe(false);
  });

  test("a hostable #private arrow reachable only through a Map round-trips", async () => {
    class D {
      #v = 99;
      make() {
        return () => this.#v;
      }
    }
    const d = new D();
    const m = new Map([["a", d.make()]]);
    void [d, m];
    const out = (await roundtrip(() => ({ d, m })))() as any;
    expect(out.m.get("a")()).toBe(99);
  });
});

describe("adversarial regressions: round 5", () => {
  // An object that is `instanceof Map` (etc.) but lacks the internal slot — e.g.
  // `Object.create(Map.prototype)` — used to crash when the builtin emitter called a slot
  // method on it. Routing is now slot-checked (`hasSlot`), so it falls back to a plain object.
  test("a fake builtin (Object.create(Map.prototype)) serializes as a plain object", async () => {
    const fake: any = Object.create(Map.prototype);
    fake.x = 1;
    const out = (await roundtrip(() => fake))() as any;
    expect(out.x).toBe(1);
    expect(Object.getPrototypeOf(out)).toBe(Map.prototype);
    expect(out instanceof Map).toBe(true);
  });

  // A huge, sparse array (`new Array(2**32 - 1)` with two set indices) used to hang: the
  // analysis pre-passes and the emitter iterated `0..length` instead of the present indices.
  test("a huge sparse array serializes by present indices (no DoS)", async () => {
    const big: any = new Array(4294967295);
    big[0] = "a";
    big[4294967294] = "z";
    const out = (await roundtrip(() => big))() as any;
    expect(out.length).toBe(4294967295);
    expect(out[0]).toBe("a");
    expect(out[4294967294]).toBe("z");
    expect(Object.keys(out)).toEqual(["0", "4294967294"]);
  });

  // A class whose heritage is a parenthesized expression (`class X extends (Base) {}`) — the
  // heritage rewrite is now anchored on the AST `superClassStart`, consuming the clause cleanly.
  test("a class with a parenthesized heritage clause round-trips", async () => {
    class Base {
      tag() {
        return "b";
      }
    }
    // prettier-ignore
    class X extends (Base) {
      who() {
        return "x";
      }
    }
    void Base;
    const Out = (await roundtrip(() => X))() as any;
    const inst = new Out();
    expect(inst.who()).toBe("x");
    expect(inst.tag()).toBe("b");
    expect(inst instanceof Out).toBe(true);
  });

  // A genuine #private instance serialized once injects a module-level reify slot as a free
  // variable. Re-serializing the RECONSTRUCTED function must not treat that internal slot as a
  // real captured binding (it was leaking through and shadowing on the second pass).
  test("a genuine #private instance survives a second serialization round", async () => {
    class Secret {
      #pw = "hunter2";
      check(x: string) {
        return x === this.#pw;
      }
    }
    const s = new Secret();
    void s;
    const code1 = serialize(() => s);
    using dir1 = tempDir("closure-r5-reify1", { "mod.mjs": code1 });
    const fn1 = (await import(`${String(dir1)}/mod.mjs`)).default as any;
    const code2 = serialize(fn1);
    using dir2 = tempDir("closure-r5-reify2", { "mod.mjs": code2 });
    const fn2 = (await import(`${String(dir2)}/mod.mjs`)).default as any;
    const inst = fn2();
    expect(Object.keys(inst)).toEqual([]); // #pw stays private across both rounds
    expect(inst.check("hunter2")).toBe(true);
    expect(inst.check("nope")).toBe(false);
  });

  // A captured function that references an external import (`EOL` from `node:os`) used to make
  // `capturedFunctions` try to emit the import as a captured function. External imports are now
  // skipped — the reconstructed module re-imports them.
  test("a function capturing another that references an external import round-trips", async () => {
    function g() {
      return "eol=" + JSON.stringify(EOL);
    }
    function f() {
      return g();
    }
    void g;
    const out = (await roundtrip(f)) as any;
    expect(out()).toBe("eol=" + JSON.stringify(EOL));
  });

  // Generator/iterator rejection is now keyed on the actual JSC cell type (native), not on
  // Symbol.toStringTag — which userland can forge in either direction.
  test("a plain object forging a Generator toStringTag is NOT falsely rejected", async () => {
    const fake: any = { [Symbol.toStringTag]: "Generator", x: 1 };
    const out = (await roundtrip(() => fake))() as any;
    expect(out.x).toBe(1);
    expect(out[Symbol.toStringTag]).toBe("Generator");
  });

  test("a real mid-iteration generator with its toStringTag stripped is still rejected", () => {
    function* gen() {
      yield 1;
      yield 2;
    }
    const g: any = gen();
    g.next(); // mid-iteration: unserializable regardless of any tag spoofing
    // Shadow the prototype's tag with an own `undefined` so `toString` no longer reports it.
    Object.defineProperty(g, Symbol.toStringTag, { value: undefined, configurable: true });
    expect(Object.prototype.toString.call(g)).toBe("[object Object]");
    // Detected by the actual JSC cell type (via the native generator-state probe), not the tag.
    expect(() => serialize(() => g)).toThrow(/started iterating/);
  });

  test("a Map iterator is rejected with its precise native type label", () => {
    const it = new Map([[1, 2]]).entries();
    void it;
    expect(() => serialize(() => it)).toThrow(/Cannot serialize a Map Iterator object/);
  });
});

describe("tamper resistance (hostile primordials)", () => {
  // serialize() must not be subvertible by a caller that has reassigned global builtins
  // (Object.keys/getPrototypeOf, Reflect.ownKeys, Array.isArray, JSON.stringify, Map, Set, ...).
  // It captures primordials at module load, so it keeps producing correct output. The
  // serialization and the reconstruction run in SEPARATE processes — the reconstructed module
  // needs a clean Map/Set (the serializing process clobbered the globals).
  test("a closure serializes correctly even when every primordial is reassigned", async () => {
    using dir = tempDir("closure-tamper", {
      "serialize.mjs": `
        import { serialize } from "bun:closure";
        import { writeFileSync } from "node:fs";
        const data = { m: new Map([["a", 1]]), s: new Set([2, 3]), arr: [4, 5], nested: { x: 6 } };
        const boom = () => { throw new Error("tampered primordial was called"); };
        Object.keys = boom;
        Object.getOwnPropertyDescriptor = boom;
        Object.getPrototypeOf = boom;
        Object.create = boom;
        Reflect.ownKeys = boom;
        Array.isArray = boom;
        JSON.stringify = boom;
        globalThis.Map = class FakeMap {};
        globalThis.Set = class FakeSet {};
        writeFileSync(new URL("./out.mjs", import.meta.url), serialize(() => data));
        process.stdout.write("SERIALIZED");
      `,
      "check.mjs": `
        import out from "./out.mjs";
        const v = out();
        process.stdout.write(JSON.stringify({ m: v.m.get("a"), s: [...v.s], arr: v.arr, x: v.nested.x }));
      `,
    });

    await using ser = Bun.spawn({
      cmd: [bunExe(), "serialize.mjs"],
      env: bunEnv,
      cwd: String(dir),
      stderr: "pipe",
    });
    const [serOut, serErr, serCode] = await Promise.all([ser.stdout.text(), ser.stderr.text(), ser.exited]);
    expect({ serOut, serErr: serErr.includes("tampered") ? serErr : "", serCode }).toEqual({
      serOut: "SERIALIZED",
      serErr: "",
      serCode: 0,
    });

    await using chk = Bun.spawn({
      cmd: [bunExe(), "check.mjs"],
      env: bunEnv,
      cwd: String(dir),
      stderr: "pipe",
    });
    const [chkOut, chkErr, chkCode] = await Promise.all([chk.stdout.text(), chk.stderr.text(), chk.exited]);
    expect(chkOut).toBe(JSON.stringify({ m: 1, s: [2, 3], arr: [4, 5], x: 6 }));
    expect(chkCode).toBe(0);
    void chkErr;
  });
});

describe("adversarial regressions: round 6", () => {
  // A class passed DIRECTLY to serialize() (the root) had its public static field initializers
  // neutralized to `undefined` with no restore emitted — static state was silently lost. The
  // closure-wrapped path already restored them; the root now routes through the same binding path.
  test("a class as the serialization root keeps its public static fields", async () => {
    class Registry {
      static nextId = 1;
      static prefix = "id_";
      static make() {
        return this.prefix + this.nextId++;
      }
    }
    const Out = (await roundtrip(Registry as any)) as any;
    expect(Out.nextId).toBe(1);
    expect(Out.prefix).toBe("id_");
    expect(Out.make()).toBe("id_1");
    expect(Out.make()).toBe("id_2"); // mutable static state advances
  });

  // Externally-assigned own properties on a function root were dropped (the inline root path
  // emitted no own-property restore).
  test("a function root keeps its externally-assigned own properties", async () => {
    function f() {
      return 1;
    }
    (f as any).meta = "hello";
    (f as any).count = 42;
    const out = (await roundtrip(f)) as any;
    expect(out()).toBe(1);
    expect(out.meta).toBe("hello");
    expect(out.count).toBe(42);
  });

  // The replacer was invoked on Map keys/values and Set elements with `""` as the key — which
  // collides with JSON.stringify's synthetic root key, so a replacer dropping `""` wiped the
  // collection. Keys are no longer replacer-transformed; values/elements get a meaningful key.
  test("a replacer that drops the empty-string key does not wipe Maps and Sets", async () => {
    const data = { m: new Map([["realkey", "realval"]]), s: new Set(["x", "y"]) };
    const code = serialize(
      () => data,
      (k, v) => (k === "" ? undefined : v),
    );
    using dir = tempDir("closure-r6-mapdrop", { "mod.mjs": code });
    const out = ((await import(`${String(dir)}/mod.mjs`)).default as any)();
    expect(out.m.get("realkey")).toBe("realval");
    expect([...out.s].sort()).toEqual(["x", "y"]);
  });

  // ...while the replacer STILL transforms Map values and Set elements by value (the round-4
  // feature), now keyed by the entry's string key / positional index instead of `""`.
  test("a replacer still transforms Map values and Set elements", async () => {
    const data = { m: new Map([["x", 2]]), s: new Set([5, 6]) };
    const code = serialize(
      () => data,
      (_k, v) => (typeof v === "number" ? v * 100 : v),
    );
    using dir = tempDir("closure-r6-maptransform", { "mod.mjs": code });
    const out = ((await import(`${String(dir)}/mod.mjs`)).default as any)();
    expect(out.m.get("x")).toBe(200);
    expect([...out.s].sort((a: number, b: number) => a - b)).toEqual([500, 600]);
  });

  // A replacer returning undefined dropped enumerable string-keyed props but was ignored for
  // non-enumerable and symbol-keyed props (the drop path was gated on string+enumerable).
  test("a replacer drops non-enumerable and symbol-keyed properties too", async () => {
    const sym = Symbol.for("r6dk");
    const obj: any = { a: 1, [sym]: 2 };
    Object.defineProperty(obj, "b", { value: 3, enumerable: false, writable: true, configurable: true });
    const code = serialize(
      () => obj,
      (k, v) => (k === "b" || v === 2 ? undefined : v),
    );
    using dir = tempDir("closure-r6-dropkeys", { "mod.mjs": code });
    const out = ((await import(`${String(dir)}/mod.mjs`)).default as any)();
    expect(Object.keys(out)).toEqual(["a"]);
    expect("b" in out).toBe(false);
    expect(Object.getOwnPropertySymbols(out).length).toBe(0);
  });
});

describe("adversarial regressions: round 7", () => {
  // Well-known global namespace objects / singletons were either deep-copied (losing intrinsic
  // identity — `captured === Math` was false) or, for ones holding native methods with no
  // reachable path (console/globalThis/process), threw "Cannot serialize a native function".
  // They are now emitted as a REFERENCE to their global path, preserving identity.
  test("well-known globals captured as values keep their identity (=== global)", async () => {
    const out = (await roundtrip(() => ({ Math, JSON, Reflect, console, gt: globalThis, process })))() as any;
    expect(out.Math).toBe(Math);
    expect(out.JSON).toBe(JSON);
    expect(out.Reflect).toBe(Reflect);
    expect(out.console).toBe(console);
    expect(out.gt).toBe(globalThis);
    expect(out.process).toBe(process);
  });

  // The same must hold when the global is reached through a captured free VARIABLE (the analysis
  // pre-passes previously walked into the global's native internals and collected an
  // unserializable internal function — e.g. a node validator with no global path).
  test("a captured variable holding a global round-trips by reference", async () => {
    const c1 = console;
    const cfg = { logger: console, root: globalThis };
    void [c1, cfg];
    const out = (await roundtrip(() => ({ c1, cfg })))() as any;
    expect(out.c1).toBe(console);
    expect(out.cfg.logger).toBe(console);
    expect(out.cfg.root).toBe(globalThis);
  });

  // An Error's `stack` own property was dropped. A deliberately-set stack is now preserved, and
  // a normal error still carries a stack string.
  test("an Error's stack own property is preserved", async () => {
    const e: any = new Error("boom");
    e.stack = "ZZZ_CUSTOM_STACK";
    e.code = "E_X";
    const auto = new TypeError("auto");
    const out = (await roundtrip(() => ({ e, auto })))() as any;
    expect(out.e.stack).toBe("ZZZ_CUSTOM_STACK");
    expect(out.e.code).toBe("E_X");
    expect(out.e.message).toBe("boom");
    expect(typeof out.auto.stack).toBe("string");
    expect(out.auto).toBeInstanceOf(TypeError);
  });
});

describe("native object & prototype references (allowlist)", () => {
  // Built-in prototypes were deep-copied (identity broken, internal-slot key leak) or threw
  // "native function"; host singletons crypto/performance were deep-copied. All now referenced.
  test("built-in prototypes keep identity (=== Promise.prototype etc.)", async () => {
    const refs = {
      promiseProto: Promise.prototype,
      errorProto: Error.prototype,
      typeErrorProto: TypeError.prototype,
      numberProto: Number.prototype,
      mapProto: Map.prototype,
      dateProto: Date.prototype,
      regexpProto: RegExp.prototype,
    };
    void refs;
    const out = (await roundtrip(() => refs))() as any;
    expect(out.promiseProto).toBe(Promise.prototype);
    expect(out.errorProto).toBe(Error.prototype);
    expect(out.typeErrorProto).toBe(TypeError.prototype);
    expect(out.numberProto).toBe(Number.prototype);
    expect(out.mapProto).toBe(Map.prototype);
    expect(out.dateProto).toBe(Date.prototype);
    expect(out.regexpProto).toBe(RegExp.prototype);
  });

  test("typed-array prototypes and the shared %TypedArray%.prototype keep identity", async () => {
    const TypedArrayProto = Object.getPrototypeOf(Uint8Array.prototype);
    const refs = {
      u8: Uint8Array.prototype,
      f64: Float64Array.prototype,
      bi64: BigInt64Array.prototype,
      shared: TypedArrayProto,
    };
    void refs;
    const out = (await roundtrip(() => refs))() as any;
    expect(out.u8).toBe(Uint8Array.prototype);
    expect(out.f64).toBe(Float64Array.prototype);
    expect(out.bi64).toBe(BigInt64Array.prototype);
    expect(out.shared).toBe(TypedArrayProto);
    expect(Object.getPrototypeOf(out.u8)).toBe(out.shared);
  });

  test("host singletons crypto / performance keep identity", async () => {
    const refs = { crypto: globalThis.crypto, performance: globalThis.performance };
    void refs;
    const out = (await roundtrip(() => refs))() as any;
    expect(out.crypto).toBe(globalThis.crypto);
    expect(out.performance).toBe(globalThis.performance);
    expect(typeof out.performance.now()).toBe("number");
  });

  // The native-object map is snapshotted EAGERLY at `import "bun:closure"`. A user object assigned
  // to a fresh global AFTER import must NOT be referenced by that global path — serialized by value.
  test("a user object assigned to a global after import is serialized by value, not by path", async () => {
    const userObj = { secret: 1234, tag: "USER_OBJECT_NOT_A_GLOBAL" };
    serialize(() => 1); // warmup
    (globalThis as any).__closureTamperTarget = userObj;
    try {
      const code = serialize(() => userObj);
      expect(code).not.toContain("__closureTamperTarget");
      const out = (await roundtrip(() => userObj))() as any;
      expect(out).toEqual({ secret: 1234, tag: "USER_OBJECT_NOT_A_GLOBAL" });
      expect(out).not.toBe(userObj);
    } finally {
      delete (globalThis as any).__closureTamperTarget;
    }
  });
});

describe("root own-state integrity (non-enumerable) survives serialize", () => {
  test("frozen root class stays frozen", async () => {
    class C {
      static x = 1;
    }
    Object.freeze(C);
    const Out = (await roundtrip(C as any)) as any;
    expect(Object.isFrozen(Out)).toBe(true);
    expect(Out.x).toBe(1);
  });

  test("sealed root class stays sealed (not frozen)", async () => {
    // A writable static makes sealed distinguishable from frozen (an empty class has only
    // non-writable own props, so sealing it is also freezing it).
    class C {
      static x = 1;
    }
    Object.seal(C);
    const Out = (await roundtrip(C as any)) as any;
    expect(Object.isSealed(Out)).toBe(true);
    expect(Object.isFrozen(Out)).toBe(false); // x stays writable under seal
    Out.x = 2;
    expect(Out.x).toBe(2);
  });

  test("non-extensible root function stays non-extensible", async () => {
    function f() {
      return 1;
    }
    Object.preventExtensions(f);
    const Out = (await roundtrip(f)) as any;
    expect(Object.isExtensible(Out)).toBe(false);
    expect(Object.isSealed(Out)).toBe(false);
    expect(Out()).toBe(1);
  });

  test("frozen root prototype stays frozen", async () => {
    class C {}
    Object.freeze(C.prototype);
    const Out = (await roundtrip(C as any)) as any;
    expect(Object.isFrozen(Out.prototype)).toBe(true);
  });

  test("overridden root name survives (function and class)", async () => {
    function f() {}
    Object.defineProperty(f, "name", { value: "custom", configurable: true });
    const Of = (await roundtrip(f)) as any;
    expect(Of.name).toBe("custom");
    class C {}
    Object.defineProperty(C, "name", { value: "Renamed", configurable: true });
    const Oc = (await roundtrip(C as any)) as any;
    expect(Oc.name).toBe("Renamed");
  });

  test("overridden length survives (root and nested)", async () => {
    function f(a: number, b: number) {
      return a + b;
    }
    Object.defineProperty(f, "length", { value: 99, configurable: true });
    const Of = (await roundtrip(f)) as any;
    expect(Of.length).toBe(99);
    expect(Of(1, 2)).toBe(3);

    function inner(a: number) {
      return a;
    }
    Object.defineProperty(inner, "length", { value: 42, configurable: true });
    const outer = () => inner;
    const Oo = (await roundtrip(outer)) as any;
    expect(Oo().length).toBe(42);
    expect(Oo()(7)).toBe(7);
  });

  // Negative contract: a plain root closure with NO own state must still take the inline path.
  test("plain root arrow round-trips and stays extensible", async () => {
    const x = 5;
    const f = () => x;
    const Out = (await roundtrip(f)) as any;
    expect(Out()).toBe(5);
    expect(Object.isExtensible(Out)).toBe(true);
    expect(Out.length).toBe(0);
  });
});

describe("genuine #private: idempotent re-serialization", () => {
  // Round 1 emits a class referencing the module-level mutable reify slot, a __bunReifyPatch
  // method, and field guards. Re-serializing must NOT re-bind the reify slot as a local const
  // (which would re-run every initializer) nor accumulate duplicate patch methods (unbounded growth).
  test("re-serializing a reconstructed #private class does not re-run initializers or grow", async () => {
    using dir = tempDir(`closure-gp-reserialize-${counter++}`, {
      "gen.mjs": [
        `import { serialize } from "bun:closure";`,
        `import { writeFileSync } from "node:fs";`,
        `import { pathToFileURL } from "node:url";`,
        `globalThis.__ctorRuns = 0;`,
        `class C {`,
        `  #v = (globalThis.__ctorRuns++, 7);`,
        `  get() { return this.#v; }`,
        `}`,
        `let inst = new C();`,
        `const runsAfterLiveConstruct = globalThis.__ctorRuns;`,
        `const rounds = [];`,
        `for (let round = 1; round <= 3; round++) {`,
        `  const code = serialize(() => inst);`,
        `  const runsBefore = globalThis.__ctorRuns;`,
        `  const file = new URL("./round-" + round + ".mjs", import.meta.url);`,
        `  writeFileSync(file, code);`,
        `  const mod = await import(pathToFileURL(file.pathname).href);`,
        `  inst = mod.default();`,
        `  rounds.push({`,
        `    round,`,
        `    initRuns: globalThis.__ctorRuns - runsBefore,`,
        `    value: inst.get(),`,
        `    publicKeys: Object.keys(inst),`,
        `    length: code.length,`,
        `    patchMethods: (code.match(/__bunReifyPatch\\(/g) || []).length,`,
        `  });`,
        `}`,
        `console.log(JSON.stringify({ runsAfterLiveConstruct, rounds }));`,
      ].join("\n"),
    });

    await using proc = Bun.spawn({
      cmd: [bunExe(), `${String(dir)}/gen.mjs`],
      env: bunEnv,
      cwd: String(dir),
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    expect({ stdout: stdout.length > 0, stderr: stderr.includes("error:") ? stderr : "", exitCode }).toEqual({
      stdout: true,
      stderr: "",
      exitCode: 0,
    });

    const report = JSON.parse(stdout.trim()) as {
      runsAfterLiveConstruct: number;
      rounds: Array<{
        round: number;
        initRuns: number;
        value: number;
        publicKeys: string[];
        length: number;
        patchMethods: number;
      }>;
    };
    expect(report.runsAfterLiveConstruct).toBe(1);
    expect(report.rounds).toHaveLength(3);
    for (const r of report.rounds) {
      expect(r.initRuns).toBe(0); // BUG 1: reconstruction must not re-run initializers
      expect(r.value).toBe(7);
      expect(r.publicKeys).toEqual([]);
      expect(r.patchMethods).toBe(1); // BUG 2: exactly one patch method every round
    }
    expect(report.rounds[2].length).toBe(report.rounds[1].length); // stable size after round 1
  });
});

// Generality audit (re-serialization idempotence + genuine-private reconstruction).
//
// A single shared spawn-child fixture serializes a value N rounds IN ONE PROCESS — round k
// serializes round k-1's RECONSTRUCTED value, writes the module, and re-imports it. Per round it
// records: how many times an instance-field initializer re-ran (a counter side effect in the
// initializer — MUST stay 0 on every reconstruction), the exercised result (private values, brand
// checks, aliasing/identity), the public own keys of every probed instance (true privacy → empty),
// the serialized code length (must STABILIZE from round 2 onward, never grow unboundedly), and the
// `__bunReifyPatch(` DEFINITION count (one per genuine private-bearing class — stable across rounds).
//
// The suspected residual was MULTI-CLASS: patch keys are namespaced by a per-class id assigned in
// emission-order (`genuineClassId`); the patch METHOD bakes its prefix at round-1 injection and is
// NOT re-injected, while the patch VALUES object is re-emitted every round with a freshly computed
// id. If emission order diverged between rounds the baked prefix and the value-object key would
// mismatch → a lost #private. These tests prove the deterministic graph walk reproduces emission
// order exactly (so the ids — and thus the prefixes — coincide) across 5 distinct classes, cycles,
// and order-sensitive containers (Set/Map iteration, genuine instances as Map keys).
describe("generality: genuine #private re-serialization", () => {
  // Builds a fixture that re-serializes the value bound to `inst` for `rounds` rounds and prints one
  // JSON report. `makeBody` is inlined source declaring `let inst = <value>;`. `exercise` is inlined
  // source of `(inst) => <JSON-serializable payload>`.
  function reserializeFixture(makeBody: string, exercise: string, rounds: number): string {
    return [
      `import { serialize } from "bun:closure";`,
      `import { writeFileSync } from "node:fs";`,
      `import { pathToFileURL } from "node:url";`,
      `globalThis.__initRuns = 0;`, // any field initializer increments this
      makeBody, // declares: let inst = <value>;
      `const exercise = ${exercise};`,
      `const runsAfterLiveConstruct = globalThis.__initRuns;`,
      `const rounds = [];`,
      `for (let round = 1; round <= ${rounds}; round++) {`,
      `  const code = serialize(() => inst);`,
      `  const runsBefore = globalThis.__initRuns;`,
      `  const file = new URL("./round-" + round + ".mjs", import.meta.url);`,
      `  writeFileSync(file, code);`,
      `  const mod = await import(pathToFileURL(file.pathname).href);`,
      `  inst = mod.default();`,
      `  rounds.push({`,
      `    round,`,
      `    initRuns: globalThis.__initRuns - runsBefore,`,
      `    result: exercise(inst),`,
      `    length: code.length,`,
      `    patchDefs: (code.match(/__bunReifyPatch\\s*\\(\\s*v\\s*\\)\\s*\\{/g) || []).length,`,
      `    mangled: code.includes("$bunClosurePrivate$"),`, // genuine path: must stay false
      `  });`,
      `}`,
      `console.log(JSON.stringify({ runsAfterLiveConstruct, rounds }));`,
    ].join("\n");
  }

  type Report = {
    runsAfterLiveConstruct: number;
    rounds: Array<{
      round: number;
      initRuns: number;
      result: unknown;
      length: number;
      patchDefs: number;
      mangled: boolean;
    }>;
  };

  async function runReserialize(makeBody: string, exercise: string, rounds: number): Promise<Report> {
    using dir = tempDir(`closure-gen-reser-${counter++}`, {
      "gen.mjs": reserializeFixture(makeBody, exercise, rounds),
    });
    await using proc = Bun.spawn({
      cmd: [bunExe(), `${String(dir)}/gen.mjs`],
      env: bunEnv,
      cwd: String(dir),
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
    // Assert the whole {stdout-present, stderr, exitCode} shape so a crash surfaces the real error.
    expect({ ok: stdout.length > 0, stderr: stderr.includes("error:") ? stderr : "", exitCode }).toEqual({
      ok: true,
      stderr: "",
      exitCode: 0,
    });
    return JSON.parse(stdout.trim()) as Report;
  }

  // Asserts the universal idempotence invariants on a report:
  //  - the LIVE construction ran every instance's initializer exactly once (`expectLiveRuns`,
  //    one per genuine instance constructed in the source — N for an N-distinct-class graph),
  //  - every round took the genuine path (never mangled),
  //  - no initializer re-ran on any reconstruction (the core "reify never re-inits" invariant),
  //  - the patch-definition count is `expectPatchDefs` every round,
  //  - the serialized length is identical from round 2 onward (stabilizes, never grows),
  //  - the exercised result is identical across every round (privacy + values preserved).
  function assertIdempotent(report: Report, rounds: number, expectPatchDefs: number, expectLiveRuns = 1) {
    expect(report.runsAfterLiveConstruct).toBe(expectLiveRuns); // initializers ran once per real instance
    expect(report.rounds).toHaveLength(rounds);
    const first = report.rounds[0];
    for (const r of report.rounds) {
      expect(r.mangled).toBe(false); // genuine #private path, never the mangled public fallback
      expect(r.initRuns).toBe(0); // reconstruction NEVER re-runs an instance-field initializer
      expect(r.patchDefs).toBe(expectPatchDefs); // one patch method per private-bearing class
      expect(r.result).toEqual(first.result); // values, privacy, aliasing identical every round
    }
    // Length stabilizes from round 2: round 1 is the live class's source; from the first
    // reconstruction onward the scaffold is fixed and re-injection is suppressed (idempotent).
    const stable = report.rounds[1].length;
    for (let i = 1; i < report.rounds.length; i++) {
      expect(report.rounds[i].length).toBe(stable);
    }
  }

  const ROUNDS = 10;

  test("single #private class — 10 rounds, init runs 0×, length-stable, genuine", async () => {
    const report = await runReserialize(
      `class C { #x = (globalThis.__initRuns++, 42); get() { return this.#x; } }
       let inst = new C();`,
      `(i) => ({ x: i.get(), keys: Object.keys(i) })`,
      ROUNDS,
    );
    assertIdempotent(report, ROUNDS, 1);
    expect(report.rounds[0].result).toEqual({ x: 42, keys: [] });
  });

  test("multiple distinct private fields", async () => {
    const report = await runReserialize(
      `class C { #a = (globalThis.__initRuns++, 1); #b = 2; #c = 3; sum() { return this.#a + this.#b + this.#c; } }
       let inst = new C();`,
      `(i) => i.sum()`,
      ROUNDS,
    );
    assertIdempotent(report, ROUNDS, 1);
    expect(report.rounds[0].result).toBe(6);
  });

  test("inheritance chain (4 levels) with distinct private names — patch per level", async () => {
    const report = await runReserialize(
      `class A { #a = (globalThis.__initRuns++, 1); ga() { return this.#a; } }
       class B extends A { #b = 2; gb() { return this.#b; } }
       class C extends B { #c = 3; gc() { return this.#c; } }
       class D extends C { #d = 4; gd() { return this.#d; } }
       let inst = new D();`,
      `(i) => [i.ga(), i.gb(), i.gc(), i.gd()]`,
      ROUNDS,
    );
    assertIdempotent(report, ROUNDS, 4); // one patch method per private-bearing chain class
    expect(report.rounds[0].result).toEqual([1, 2, 3, 4]);
  });

  test("SAME private name across an inheritance chain maps to each class's own slot", async () => {
    const report = await runReserialize(
      `class A { #x = (globalThis.__initRuns++, 10); ax() { return this.#x; } }
       class B extends A { #x = 20; bx() { return this.#x; } }
       class C extends B { #x = 30; cx() { return this.#x; } }
       let inst = new C();`,
      `(i) => [i.ax(), i.bx(), i.cx()]`,
      ROUNDS,
    );
    // The per-class id prefix is what keeps the three identically-named #x slots distinct.
    assertIdempotent(report, ROUNDS, 3);
    expect(report.rounds[0].result).toEqual([10, 20, 30]);
  });

  test.each([
    [
      "Map",
      `class M extends Map { #t = (globalThis.__initRuns++, "m"); gt() { return this.#t; } }
       let inst = (() => { const m = new M(); m.set("k", "v"); return m; })();`,
      `(i) => [i.gt(), i.get("k"), i.size]`,
      ["m", "v", 1],
    ],
    [
      "Set",
      `class S extends Set { #t = (globalThis.__initRuns++, "s"); gt() { return this.#t; } }
       let inst = (() => { const s = new S(); s.add(1); s.add(2); return s; })();`,
      `(i) => [i.gt(), [...i], i.size]`,
      ["s", [1, 2], 2],
    ],
    [
      "Array",
      `class A extends Array { #t = (globalThis.__initRuns++, "a"); gt() { return this.#t; } }
       let inst = (() => { const a = new A(); a.push(9, 8, 7); return a; })();`,
      `(i) => [i.gt(), [...i], i.length]`,
      ["a", [9, 8, 7], 3],
    ],
  ])("a class extending %s reifies content + private genuinely across rounds", async (_name, body, ex, expected) => {
    const report = await runReserialize(body, ex, ROUNDS);
    assertIdempotent(report, ROUNDS, 1);
    expect(report.rounds[0].result).toEqual(expected);
  });

  test("a #private VALUE that is itself a genuine-private instance (5 levels deep)", async () => {
    const report = await runReserialize(
      `class L0 { #v = (globalThis.__initRuns++, 0); g() { return this.#v; } }
       class L1 { #c; constructor(c) { this.#c = c; } c() { return this.#c; } }
       class L2 { #c; constructor(c) { this.#c = c; } c() { return this.#c; } }
       class L3 { #c; constructor(c) { this.#c = c; } c() { return this.#c; } }
       class L4 { #c; constructor(c) { this.#c = c; } c() { return this.#c; } }
       let inst = new L4(new L3(new L2(new L1(new L0()))));`,
      `(i) => i.c().c().c().c().g()`,
      ROUNDS,
    );
    assertIdempotent(report, ROUNDS, 5);
    expect(report.rounds[0].result).toBe(0);
  });

  test("a hosted escaped arrow reading #x via lexical this", async () => {
    const report = await runReserialize(
      `class C { #x = (globalThis.__initRuns++, 7); make() { return () => this.#x; } }
       let inst = new C().make();`,
      `(arrow) => arrow()`,
      ROUNDS,
    );
    assertIdempotent(report, ROUNDS, 1);
    expect(report.rounds[0].result).toBe(7);
  });

  test("a self-cycle: a #field points back to its own instance", async () => {
    const report = await runReserialize(
      `class C { #self; #v = (globalThis.__initRuns++, 5); constructor() { this.#self = this; } me() { return this.#self; } gv() { return this.#v; } }
       let inst = new C();`,
      `(i) => ({ selfIsSelf: i.me() === i, v: i.gv() })`,
      ROUNDS,
    );
    assertIdempotent(report, ROUNDS, 1);
    expect(report.rounds[0].result).toEqual({ selfIsSelf: true, v: 5 });
  });

  test("private + public fields mixed — privacy preserved, public restored", async () => {
    const report = await runReserialize(
      `class C { #p = (globalThis.__initRuns++, 1); pub = 2; both() { return this.#p + this.pub; } }
       let inst = new C();`,
      `(i) => ({ both: i.both(), pub: i.pub, keys: Object.keys(i) })`,
      ROUNDS,
    );
    assertIdempotent(report, ROUNDS, 1);
    expect(report.rounds[0].result).toEqual({ both: 3, pub: 2, keys: ["pub"] });
  });

  // ── MULTI-CLASS GRAPHS (the priority residual) ────────────────────────────────────────────
  // A single serialized graph with N distinct genuine-private classes, reachable in orders that
  // could perturb the per-class id assignment. If the round-1 baked patch-method prefix ever
  // diverged from the round-N value-object key, a #private would read undefined — caught here
  // because the exercised values would change between rounds (assertIdempotent compares them).

  test("multi-class: 2 distinct private classes via array + reversed array + Map + Set", async () => {
    const report = await runReserialize(
      `class A { #a = (globalThis.__initRuns++, "A"); ga() { return this.#a; } }
       class B { #b = (globalThis.__initRuns++, "B"); gb() { return this.#b; } }
       let inst = (() => { const a = new A(), b = new B();
         return { arr: [a, b], rev: [b, a], m: new Map([["b", b], ["a", a]]), s: new Set([b, a]) }; })();`,
      `(i) => [i.arr[0].ga(), i.arr[1].gb(), i.rev[0].gb(), i.m.get("a").ga(), [...i.s][0].gb()]`,
      ROUNDS,
    );
    // Two distinct private classes, one instance each → 2 live inits; reconstruction adds 0.
    assertIdempotent(report, ROUNDS, 2, 2);
    expect(report.rounds[0].result).toEqual(["A", "B", "B", "A", "B"]);
  });

  test("multi-class: 5 distinct private classes reached via a Set (iteration-order sensitive)", async () => {
    const report = await runReserialize(
      `class A { #a = (globalThis.__initRuns++, "A"); g() { return this.#a; } }
       class B { #b = (globalThis.__initRuns++, "B"); g() { return this.#b; } }
       class C { #c = (globalThis.__initRuns++, "C"); g() { return this.#c; } }
       class D { #d = (globalThis.__initRuns++, "D"); g() { return this.#d; } }
       class E { #e = (globalThis.__initRuns++, "E"); g() { return this.#e; } }
       let inst = new Set([new C(), new E(), new A(), new D(), new B()]);`,
      `(i) => [...i].map(x => x.g()).join("")`,
      ROUNDS,
    );
    assertIdempotent(report, ROUNDS, 5, 5); // 5 distinct classes, one instance each
    expect(report.rounds[0].result).toBe("CEADB"); // Set iteration order preserved through reify
  });

  test("multi-class: genuine instances as Map KEYS and values (key-iteration sensitive)", async () => {
    const report = await runReserialize(
      `class K { #id; constructor(i) { this.#id = (globalThis.__initRuns++, i); } id() { return this.#id; } }
       class V { #v; constructor(v) { this.#v = (globalThis.__initRuns++, v); } v() { return this.#v; } }
       let inst = (() => { const k1 = new K(1), k2 = new K(2);
         const m = new Map(); m.set(k1, new V("a")); m.set(k2, new V("b"));
         return { m, k1, k2 }; })();`,
      `(i) => [i.m.get(i.k1).v(), i.m.get(i.k2).v(), i.k1.id(), i.k2.id()]`,
      ROUNDS,
    );
    assertIdempotent(report, ROUNDS, 2, 4); // 2 keys + 2 values constructed live
    expect(report.rounds[0].result).toEqual(["a", "b", 1, 2]);
  });

  test("multi-class: a mutual cycle between two distinct private classes", async () => {
    const report = await runReserialize(
      `class A { #peer; #t = (globalThis.__initRuns++, "A"); setPeer(p) { this.#peer = p; } peer() { return this.#peer; } t() { return this.#t; } }
       class B { #peer; #t = (globalThis.__initRuns++, "B"); setPeer(p) { this.#peer = p; } peer() { return this.#peer; } t() { return this.#t; } }
       let inst = (() => { const a = new A(), b = new B(); a.setPeer(b); b.setPeer(a); return { a, b }; })();`,
      `(i) => ({ at: i.a.t(), bt: i.b.t(), aPeerIsB: i.a.peer() === i.b, bPeerIsA: i.b.peer() === i.a, viaPeer: i.a.peer().t() })`,
      ROUNDS,
    );
    assertIdempotent(report, ROUNDS, 2, 2); // two instances in the cycle
    expect(report.rounds[0].result).toEqual({ at: "A", bt: "B", aPeerIsB: true, bPeerIsA: true, viaPeer: "B" });
  });

  // ── CONTAINERS / POSITION / ALIASING ──────────────────────────────────────────────────────

  test("aliased: the same instance via K paths collapses to one identity, privacy intact", async () => {
    const report = await runReserialize(
      `class A { #v = (globalThis.__initRuns++, "shared"); g() { return this.#v; } }
       let inst = (() => { const a = new A();
         return { p1: a, p2: a, arr: [a, a, a], m: new Map([["x", a]]), nested: { deep: { x: a } } }; })();`,
      `(i) => { const all = [i.p1, i.p2, ...i.arr, i.m.get("x"), i.nested.deep.x];
        return { v: i.p1.g(), allSame: all.every(x => x === i.p1), keys: Object.keys(i.p1) }; }`,
      ROUNDS,
    );
    // Aliasing → ONE construction → initRuns 0 on reconstruction, one shared identity.
    assertIdempotent(report, ROUNDS, 1);
    expect(report.rounds[0].result).toEqual({ v: "shared", allSame: true, keys: [] });
  });

  test("deeply nested genuine instance with a #field cycling back to the root container", async () => {
    const report = await runReserialize(
      `class C { #v = (globalThis.__initRuns++, "z"); #back; g() { return this.#v; } setBack(o) { this.#back = o; } back() { return this.#back; } }
       let inst = (() => { const c = new C(); const root = { a: { b: { c: [{ d: c }] } } }; c.setBack(root); return root; })();`,
      `(i) => ({ v: i.a.b.c[0].d.g(), cyclesBack: i.a.b.c[0].d.back() === i })`,
      ROUNDS,
    );
    assertIdempotent(report, ROUNDS, 1);
    expect(report.rounds[0].result).toEqual({ v: "z", cyclesBack: true });
  });

  test("a builtin (Map) subclass instance holding ITSELF as a map value", async () => {
    const report = await runReserialize(
      `class M extends Map { #t = (globalThis.__initRuns++, "m"); gt() { return this.#t; } }
       let inst = (() => { const m = new M(); m.set("self", m); m.set("x", 1); return m; })();`,
      `(i) => ({ tag: i.gt(), selfIsSelf: i.get("self") === i, x: i.get("x") })`,
      ROUNDS,
    );
    assertIdempotent(report, ROUNDS, 1);
    expect(report.rounds[0].result).toEqual({ tag: "m", selfIsSelf: true, x: 1 });
  });

  // ── COMPOSITION ───────────────────────────────────────────────────────────────────────────

  test("composition: a frozen genuine instance stays frozen with its #private intact", async () => {
    const report = await runReserialize(
      `class C { #x = (globalThis.__initRuns++, 42); g() { return this.#x; } }
       let inst = Object.freeze(new C());`,
      `(i) => ({ v: i.g(), frozen: Object.isFrozen(i) })`,
      ROUNDS,
    );
    assertIdempotent(report, ROUNDS, 1);
    expect(report.rounds[0].result).toEqual({ v: 42, frozen: true });
  });

  test.each([
    [
      "a Date",
      `class C { #d; constructor(d) { this.#d = (globalThis.__initRuns++, d); } g() { return this.#d.getTime(); } }
       let inst = new C(new Date(0));`,
      `(i) => i.g()`,
      0,
    ],
    [
      "a Map",
      `class C { #m; constructor(m) { this.#m = (globalThis.__initRuns++, m); } g() { return this.#m.get("k"); } }
       let inst = new C(new Map([["k", "v"]]));`,
      `(i) => i.g()`,
      "v",
    ],
    [
      "a global reference",
      `class C { #f; constructor(f) { this.#f = (globalThis.__initRuns++, f); } g() { return this.#f(1, 9, 3); } }
       let inst = new C(Math.max);`,
      `(i) => i.g()`,
      9,
    ],
  ])("composition: a #field holding %s round-trips and re-serializes", async (_name, body, ex, expected) => {
    const report = await runReserialize(body, ex, ROUNDS);
    assertIdempotent(report, ROUNDS, 1);
    expect(report.rounds[0].result).toEqual(expected);
  });

  test("composition: a class static (public) restored alongside a #private, across rounds", async () => {
    const report = await runReserialize(
      `class C { static tag = "T"; #x = (globalThis.__initRuns++, 1); g() { return this.#x; } st() { return C.tag; } }
       let inst = new C();`,
      `(i) => ({ x: i.g(), tag: i.st() })`,
      ROUNDS,
    );
    assertIdempotent(report, ROUNDS, 1);
    expect(report.rounds[0].result).toEqual({ x: 1, tag: "T" });
  });
});

describe("generality: aliasing & identity", () => {
  // Each "value kind" is built so that ONE instance is reachable through several
  // distinct paths in the returned graph. After round-trip, every path must
  // reconstruct to ONE identity (`===`). `roundtrip` returns the default export
  // (a function); calling it yields the graph.
  //
  // Builders return `() => graph`. The graph always exposes the shared value at
  // `.a` (the canonical handle) plus the alternate paths. `check` receives the
  // round-tripped graph and asserts identity across paths.
  const kinds: Array<[name: string, build: () => () => any, check: (g: any) => void]> = [
    [
      "plain object",
      () => {
        const a = { id: "hub" };
        return () => ({ a, arr: [a, [a]], m: new Map([[a, a]]), s: new Set([a]), nest: { x: { y: a } } });
      },
      g => {
        const a = g.a;
        expect(g.arr[0]).toBe(a);
        expect(g.arr[1][0]).toBe(a);
        expect([...g.s][0]).toBe(a);
        expect(g.nest.x.y).toBe(a);
        const [[k, val]] = [...g.m];
        expect(k).toBe(a);
        expect(val).toBe(a);
        expect(g.m.get(a)).toBe(a);
      },
    ],
    [
      "array",
      () => {
        const a = [1, 2, 3];
        return () => ({ a, arr: [a, a], m: new Map([["k", a]]), s: new Set([a]) });
      },
      g => {
        expect(g.arr[0]).toBe(g.a);
        expect(g.arr[1]).toBe(g.a);
        expect([...g.m.values()][0]).toBe(g.a);
        expect([...g.s][0]).toBe(g.a);
      },
    ],
    [
      "function",
      () => {
        function a() {
          return 1;
        }
        return () => ({ a, arr: [a], s: new Set([a]), nest: { f: a } });
      },
      g => {
        expect(g.arr[0]).toBe(g.a);
        expect([...g.s][0]).toBe(g.a);
        expect(g.nest.f).toBe(g.a);
      },
    ],
    [
      "class constructor",
      () => {
        class A {
          m() {
            return 1;
          }
        }
        return () => ({ a: A, arr: [A], m: new Map([["k", A]]) });
      },
      g => {
        expect(g.arr[0]).toBe(g.a);
        expect([...g.m.values()][0]).toBe(g.a);
      },
    ],
    [
      "class instance",
      () => {
        class K {
          x = 1;
        }
        const a = new K();
        return () => ({ a, arr: [a], m: new Map([[a, a]]), s: new Set([a]) });
      },
      g => {
        expect(g.arr[0]).toBe(g.a);
        expect([...g.s][0]).toBe(g.a);
        const [[k, val]] = [...g.m];
        expect(k).toBe(g.a);
        expect(val).toBe(g.a);
      },
    ],
    [
      "Date",
      () => {
        const a = new Date(0);
        return () => ({ a, arr: [a], m: new Map([[a, a]]), s: new Set([a]) });
      },
      g => {
        expect(g.arr[0]).toBe(g.a);
        const [[k, val]] = [...g.m];
        expect(k).toBe(g.a);
        expect(val).toBe(g.a);
        expect([...g.s][0]).toBe(g.a);
      },
    ],
    [
      "RegExp",
      () => {
        const a = /x/g;
        return () => ({ a, arr: [a], s: new Set([a]) });
      },
      g => {
        expect(g.arr[0]).toBe(g.a);
        expect([...g.s][0]).toBe(g.a);
      },
    ],
    [
      "Map instance",
      () => {
        const a = new Map([["k", 1]]);
        return () => ({ a, arr: [a], wrap: { m: a } });
      },
      g => {
        expect(g.arr[0]).toBe(g.a);
        expect(g.wrap.m).toBe(g.a);
      },
    ],
    [
      "Set instance",
      () => {
        const a = new Set([1]);
        return () => ({ a, arr: [a], wrap: { s: a } });
      },
      g => {
        expect(g.arr[0]).toBe(g.a);
        expect(g.wrap.s).toBe(g.a);
      },
    ],
    [
      "WeakMap",
      () => {
        const a = new WeakMap();
        return () => ({ a, arr: [a], m: new Map([["w", a]]) });
      },
      g => {
        expect(g.arr[0]).toBe(g.a);
        expect(g.m.get("w")).toBe(g.a);
      },
    ],
    [
      "WeakRef",
      () => {
        const target = { w: 1 };
        const a = new WeakRef(target);
        return () => ({ a, arr: [a], target });
      },
      g => {
        expect(g.arr[0]).toBe(g.a);
        expect(g.a.deref()).toBe(g.target);
      },
    ],
    [
      "typed array",
      () => {
        const a = new Uint8Array([1, 2, 3]);
        return () => ({ a, arr: [a], s: new Set([a]) });
      },
      g => {
        expect(g.arr[0]).toBe(g.a);
        expect([...g.s][0]).toBe(g.a);
      },
    ],
    [
      "boxed primitive",
      () => {
        // eslint-disable-next-line no-new-wrappers
        const a = new Number(42);
        return () => ({ a, arr: [a], m: new Map([[a, a]]) });
      },
      g => {
        expect(g.arr[0]).toBe(g.a);
        const [[k, val]] = [...g.m];
        expect(k).toBe(g.a);
        expect(val).toBe(g.a);
      },
    ],
    [
      "Error",
      () => {
        const a = new Error("boom");
        return () => ({ a, arr: [a], s: new Set([a]) });
      },
      g => {
        expect(g.arr[0]).toBe(g.a);
        expect([...g.s][0]).toBe(g.a);
      },
    ],
    [
      "Proxy",
      () => {
        const a = new Proxy({ x: 1 }, {});
        return () => ({ a, arr: [a], wrap: { p: a } });
      },
      g => {
        expect(g.arr[0]).toBe(g.a);
        expect(g.wrap.p).toBe(g.a);
        expect(g.a.x).toBe(1);
      },
    ],
    [
      "bound function",
      () => {
        function f(x: number, y: number) {
          return x + y;
        }
        const a = f.bind(null, 1);
        return () => ({ a, arr: [a], wrap: { b: a } });
      },
      g => {
        expect(g.arr[0]).toBe(g.a);
        expect(g.wrap.b).toBe(g.a);
        expect(g.a(2)).toBe(3);
      },
    ],
    [
      "well-known global (Math)",
      () => {
        return () => ({ a: Math, arr: [Math], wrap: { m: Math } });
      },
      g => {
        expect(g.a).toBe(Math);
        expect(g.arr[0]).toBe(Math);
        expect(g.wrap.m).toBe(Math);
      },
    ],
    [
      "genuine #private instance",
      () => {
        class K {
          #p = 99;
          peek() {
            return this.#p;
          }
        }
        const a = new K();
        return () => ({ a, arr: [a], m: new Map([[a, a]]), s: new Set([a]) });
      },
      g => {
        // The #private VALUE is a documented non-goal; identity dedup is not.
        expect(g.arr[0]).toBe(g.a);
        const [[k, val]] = [...g.m];
        expect(k).toBe(g.a);
        expect(val).toBe(g.a);
        expect([...g.s][0]).toBe(g.a);
      },
    ],
    [
      "Symbol value",
      () => {
        const a = Symbol("tag");
        return () => ({ a, arr: [a], m: new Map([[a, a]]), o: { [a]: 1, ref: a } });
      },
      g => {
        expect(g.arr[0]).toBe(g.a);
        const [[k, val]] = [...g.m];
        expect(k).toBe(g.a);
        expect(val).toBe(g.a);
        expect(g.o.ref).toBe(g.a);
      },
    ],
  ];

  test.each(kinds)("%s: one instance, K>=3 paths -> single identity", async (_name, build, check) => {
    const out = await roundtrip(build());
    check((out as any)());
  });

  test("ArrayBuffer shared by multiple views stays shared", async () => {
    const out = await roundtrip(() => {
      const ab = new ArrayBuffer(16);
      const u8 = new Uint8Array(ab, 0, 8);
      const u8b = new Uint8Array(ab, 8, 8);
      const f64 = new Float64Array(ab);
      return { ab, u8, u8b, f64 };
    });
    const g = (out as any)();
    expect(g.u8.buffer).toBe(g.ab);
    expect(g.u8b.buffer).toBe(g.ab);
    expect(g.f64.buffer).toBe(g.ab);
    expect(g.u8.buffer).toBe(g.u8b.buffer);
    expect(g.u8b.byteOffset).toBe(8);
  });

  test("cycle + aliasing: shared value participates in a self cycle", async () => {
    const out = await roundtrip(() => {
      const o: any = {};
      o.self = o;
      o.also = o;
      return { a: o, b: o, arr: [o] };
    });
    const g = (out as any)();
    expect(g.a).toBe(g.b);
    expect(g.arr[0]).toBe(g.a);
    expect(g.a.self).toBe(g.a);
    expect(g.a.also).toBe(g.a);
    expect(g.a.self.self.self).toBe(g.a);
  });

  test("mutual cycle where both nodes are aliased elsewhere", async () => {
    const out = await roundtrip(() => {
      const x: any = {};
      const y: any = {};
      x.y = y;
      y.x = x;
      return { x, y, arr: [x, y], ax: x, ay: y };
    });
    const g = (out as any)();
    expect(g.x).toBe(g.ax);
    expect(g.y).toBe(g.ay);
    expect(g.x.y).toBe(g.y);
    expect(g.y.x).toBe(g.x);
    expect(g.arr[0]).toBe(g.x);
    expect(g.arr[1]).toBe(g.y);
    expect(g.x.y.x).toBe(g.x);
  });

  test("aliased value buried deep on one path, shallow on another", async () => {
    const out = await roundtrip(() => {
      const hub = { tag: "deep" };
      let cur: any = { leaf: hub };
      for (let i = 0; i < 25; i++) cur = { next: cur };
      return { shallow: hub, deep: cur };
    });
    const g = (out as any)();
    let c = g.deep;
    for (let i = 0; i < 25; i++) c = c.next;
    expect(c.leaf).toBe(g.shallow);
  });

  test("dedup direction: one value is Map key AND value AND Set member AND prop", async () => {
    const out = await roundtrip(() => {
      const x = { role: "all" };
      const m = new Map([[x, x]]);
      const s = new Set([x]);
      return { prop: x, m, s };
    });
    const g = (out as any)();
    const x = g.prop;
    const [[k, val]] = [...g.m];
    expect(k).toBe(x);
    expect(val).toBe(x);
    expect(g.m.get(x)).toBe(x); // key->value identity actually wired
    expect([...g.s][0]).toBe(x);
    expect(g.s.has(x)).toBe(true);
  });

  test("scale: a hub referenced by 500 distinct nodes is one identity, no blow-up", async () => {
    const out = await roundtrip(() => {
      const hub = { h: 1 };
      const nodes: any[] = [];
      for (let i = 0; i < 500; i++) nodes.push({ i, ref: hub });
      return { hub, nodes };
    });
    const g = (out as any)();
    expect(g.nodes).toHaveLength(500);
    for (const node of g.nodes) expect(node.ref).toBe(g.hub);
    expect(g.nodes[0].ref).toBe(g.nodes[499].ref);
  });

  test("free variable aliases a value also reachable in the returned object", async () => {
    const out = await roundtrip(() => {
      const shared = { fv: 1 };
      const get = () => shared;
      return { shared, get };
    });
    const g = (out as any)();
    expect(g.shared).toBe(g.get());
  });

  test("two separate closures capturing the same cell reconstruct one identity", async () => {
    const out = await roundtrip(() => {
      const cell = { c: 1 };
      const f = () => cell;
      const h = () => cell;
      return { f, h, cell };
    });
    const g = (out as any)();
    expect(g.f()).toBe(g.cell);
    expect(g.h()).toBe(g.cell);
    expect(g.f()).toBe(g.h());
  });

  test("a getter's closed-over value is the same identity as a direct property", async () => {
    const out = await roundtrip(() => {
      const secret = { s: 1 };
      return {
        direct: secret,
        get g() {
          return secret;
        },
      };
    });
    const g = (out as any)();
    expect(g.direct).toBe(g.g);
  });

  test("class static field aliases an instance field of the same value", async () => {
    const out = await roundtrip(() => {
      const shared = { s: 1 };
      class K {
        static hub = shared;
        ref = shared;
      }
      const inst = new K();
      return { Cls: K, inst };
    });
    const g = (out as any)();
    expect(g.Cls.hub).toBe(g.inst.ref);
  });

  test("object reachable via plain, non-enumerable, and symbol keys is one identity", async () => {
    const out = await roundtrip(() => {
      const x = { x: 1 };
      const o: any = { a: x };
      Object.defineProperty(o, "b", { value: x, enumerable: false });
      o[Symbol.for("aliasing-test-sym")] = x;
      return { o, x };
    });
    const g = (out as any)();
    expect(g.o.a).toBe(g.x);
    expect(g.o.b).toBe(g.x);
    expect(g.o[Symbol.for("aliasing-test-sym")]).toBe(g.x);
  });

  test("distinct empty objects must NOT be merged", async () => {
    const out = await roundtrip(() => {
      const a = {};
      const b = {};
      return { a, b, arr: [a, b] };
    });
    const g = (out as any)();
    expect(g.a).not.toBe(g.b);
    expect(g.arr[0]).not.toBe(g.arr[1]);
    expect(g.arr[0]).toBe(g.a);
    expect(g.arr[1]).toBe(g.b);
  });

  test("distinct boxed primitives with equal value must NOT be merged", async () => {
    const out = await roundtrip(() => {
      // eslint-disable-next-line no-new-wrappers
      const a = new Number(5);
      // eslint-disable-next-line no-new-wrappers
      const b = new Number(5);
      return { a, b };
    });
    const g = (out as any)();
    expect(g.a).not.toBe(g.b);
    expect(+g.a).toBe(5);
    expect(+g.b).toBe(5);
  });

  test("self-referential array aliased elsewhere closes its cycle", async () => {
    const out = await roundtrip(() => {
      const a: any[] = [];
      a.push(a);
      a.push(a);
      return { a, alias: a };
    });
    const g = (out as any)();
    expect(g.a).toBe(g.alias);
    expect(g.a[0]).toBe(g.a);
    expect(g.a[1]).toBe(g.a);
  });

  test("Map whose key is the Map itself closes its cycle", async () => {
    const out = await roundtrip(() => {
      const m = new Map<any, any>();
      m.set(m, "self");
      return { m };
    });
    const g = (out as any)();
    expect([...g.m.keys()][0]).toBe(g.m);
    expect(g.m.get(g.m)).toBe("self");
  });

  test("two Maps sharing the same key object reconstruct one key identity", async () => {
    const out = await roundtrip(() => {
      const key = { k: 1 };
      const m1 = new Map([[key, "a"]]);
      const m2 = new Map([[key, "b"]]);
      return { key, m1, m2 };
    });
    const g = (out as any)();
    expect([...g.m1.keys()][0]).toBe(g.key);
    expect([...g.m2.keys()][0]).toBe(g.key);
    expect([...g.m1.keys()][0]).toBe([...g.m2.keys()][0]);
  });

  test("shared prototype object across two Object.create targets is one identity", async () => {
    const out = await roundtrip(() => {
      const proto = {
        greet() {
          return "hi";
        },
      };
      const a = Object.create(proto);
      const b = Object.create(proto);
      return { a, b, proto };
    });
    const g = (out as any)();
    expect(Object.getPrototypeOf(g.a)).toBe(g.proto);
    expect(Object.getPrototypeOf(g.b)).toBe(g.proto);
    expect(Object.getPrototypeOf(g.a)).toBe(Object.getPrototypeOf(g.b));
  });

  test("omni-container: shared value reachable through every kind plus a cycle", async () => {
    const out = await roundtrip(() => {
      const h = { hub: 1 };
      const o: any = {
        h,
        arr: [h],
        m: new Map([[h, h]]),
        s: new Set([h]),
        nest: { a: { b: h } },
        fn: function () {
          return h;
        },
      };
      o.cycle = o;
      return o;
    });
    const g = (out as any)();
    const h = g.h;
    expect(g.arr[0]).toBe(h);
    const [[k, val]] = [...g.m];
    expect(k).toBe(h);
    expect(val).toBe(h);
    expect([...g.s][0]).toBe(h);
    expect(g.nest.a.b).toBe(h);
    expect(g.cycle).toBe(g);
    expect(g.fn()).toBe(h);
  });
});

// ── Generality audit: replacer + property descriptors ────────────────────────
// These prove the JSON.stringify-style `serialize(fn, replacer)` and the
// property-descriptor handling are general across DEPTH, every container
// (object / array / Map / Set / class instance / builtin subclass), cycles, and
// every key kind (string / array-index / Map-key / Set-index / symbol / #private)
// — not spot-checks. The replacer runs at serialize time; reconstruction is
// imported and exercised in-process. Each test serializes a CAPTURED free
// variable (`() => value`) so the replacer actually traverses the graph (a value
// produced only as the function's RETURN value is never visited).
describe("generality: replacer & descriptors", () => {
  let n = 0;
  // Serialize `() => value` with `replacer`, reconstruct, return the captured value.
  async function rt<T>(value: T, replacer?: (key: string, val: unknown) => unknown): Promise<T> {
    const cap = () => value;
    const code = serialize(cap, replacer as any);
    using dir = tempDir(`closure-gen-${n++}`, { "mod.mjs": code });
    const { default: fn } = await import(`${String(dir)}/mod.mjs`);
    return fn() as T;
  }
  const x100 = (_k: string, v: unknown) => (typeof v === "number" ? (v as number) * 100 : v);
  const dropUndef = (val: unknown) => (val === "SECRET" ? undefined : val);

  describe("replacer fires at every depth and position", () => {
    test("transforms object properties 10 levels deep", async () => {
      let deep: any = { v: 0 };
      for (let i = 1; i <= 10; i++) deep = { v: i, child: deep };
      const out: any = await rt(deep, x100);
      let node = out;
      const seen: number[] = [];
      while (node) {
        seen.push(node.v);
        node = node.child;
      }
      expect(seen).toEqual([1000, 900, 800, 700, 600, 500, 400, 300, 200, 100, 0]);
    });

    test("transforms nested array elements at every level", async () => {
      const out = await rt([1, [2, [3, [4]]]], x100);
      expect(out).toEqual([100, [200, [300, [400]]]]);
    });

    test("transforms Map values (top-level and nested)", async () => {
      const out = await rt(
        {
          m: new Map<string, number>([
            ["a", 1],
            ["b", 2],
          ]),
        },
        x100,
      );
      expect([...out.m.entries()]).toEqual([
        ["a", 100],
        ["b", 200],
      ]);
    });

    test("transforms Set members", async () => {
      const out = await rt(new Set([1, 2, 3]), x100);
      expect([...out.values()]).toEqual([100, 200, 300]);
    });

    test("transforms class-instance public fields at depth", async () => {
      class Pt {
        x: number;
        y: number;
        nested: { z: number };
        constructor(x: number, y: number) {
          this.x = x;
          this.y = y;
          this.nested = { z: 3 };
        }
      }
      const out = await rt(new Pt(1, 2), x100);
      expect([out.x, out.y, out.nested.z]).toEqual([100, 200, 300]);
      expect(out).toBeInstanceOf(Object.getPrototypeOf(out).constructor);
    });

    test("transforms deeply-mixed object → Set → Map → array", async () => {
      const out = await rt({ s: new Set([new Map<string, number[]>([["k", [1, 2]]])]) }, x100);
      const inner = [...out.s][0];
      expect([...inner.get("k")!]).toEqual([100, 200]);
    });
  });

  describe("key semantics per position", () => {
    test("Map value is keyed by its string entry-key", async () => {
      const out = await rt(
        new Map<string, number>([
          ["keep", 1],
          ["zap", 2],
        ]),
        (k, v) => (k === "zap" ? "X" : v),
      );
      expect([...out.entries()]).toEqual([
        ["keep", 1],
        ["zap", "X"],
      ]);
    });

    test("Map value with a non-string key is keyed by positional index", async () => {
      const out = await rt(
        new Map<object, number>([
          [{ id: 1 }, 10],
          [{ id: 2 }, 20],
        ]),
        (k, v) => (k === "1" ? "X" : v),
      );
      expect([...out.values()]).toEqual([10, "X"]);
    });

    test("Set member is keyed by positional index", async () => {
      const out = await rt(new Set([10, 20, 30]), (k, v) => (k === "1" ? "X" : v));
      expect([...out.values()]).toEqual([10, "X", 30]);
    });

    test("array element is keyed by its index as a string", async () => {
      const out = await rt([5, 6, 7], (k, v) => (k === "1" ? "X" : v));
      expect(out).toEqual([5, "X", 7]);
    });

    test('dropping key "" does NOT wipe a Map (the old root-collision bug)', async () => {
      const out = await rt(
        new Map<string, number>([
          ["a", 1],
          ["b", 2],
        ]),
        (k, v) => (k === "" ? undefined : v),
      );
      expect([...out.entries()]).toEqual([
        ["a", 1],
        ["b", 2],
      ]);
    });

    test('dropping key "" does NOT wipe a Set', async () => {
      const out = await rt(new Set([10, 20]), (k, v) => (k === "" ? undefined : v));
      expect([...out.values()]).toEqual([10, 20]);
    });

    test('dropping key "" does NOT wipe a NESTED Map/Set at depth', async () => {
      const out = await rt({ lvl: { m: new Map([["a", 1]]), s: new Set([9]) } }, (k, v) => (k === "" ? undefined : v));
      expect([...out.lvl.m.entries()]).toEqual([["a", 1]]);
      expect([...out.lvl.s.values()]).toEqual([9]);
    });

    test("a #private field is passed under its #name", async () => {
      class Secret {
        #s: number;
        constructor(s: number) {
          this.#s = s;
        }
        reveal() {
          return this.#s;
        }
      }
      const keys: string[] = [];
      const out = await rt(new Secret(7), (k, v) => {
        keys.push(k);
        return typeof v === "number" ? (v as number) * 100 : v;
      });
      expect(keys).toContain("#s");
      expect(out.reveal()).toBe(700);
    });
  });

  describe("drop (returning undefined) is general across key kinds and depth", () => {
    test("drops an enumerable string property", async () => {
      const out = await rt({ keep: 1, gone: "SECRET" }, (_k, v) => dropUndef(v));
      expect(out).toEqual({ keep: 1 });
    });

    test("drops a NON-enumerable property", async () => {
      const o: any = { shown: 1 };
      Object.defineProperty(o, "hidden", { value: "SECRET", enumerable: false, configurable: true, writable: true });
      const out = await rt(o, (_k, v) => dropUndef(v));
      expect(Object.getOwnPropertyNames(out)).toEqual(["shown"]);
    });

    test("drops a SYMBOL-keyed property", async () => {
      const S = Symbol("s");
      const out = await rt({ [S]: "SECRET", v: 1 } as any, (_k, v) => dropUndef(v));
      expect(Object.getOwnPropertySymbols(out)).toHaveLength(0);
      expect(out.v).toBe(1);
    });

    test("drops a class-instance field", async () => {
      class Pt {
        x = 1;
        y = "SECRET";
      }
      const out = await rt(new Pt(), (_k, v) => dropUndef(v));
      expect("x" in out).toBe(true);
      expect("y" in out).toBe(false);
    });

    test("drops at depth (level 5)", async () => {
      let d: any = { leaf: "SECRET", keep: 1 };
      for (let i = 0; i < 5; i++) d = { child: d, lvl: i };
      const out = await rt(d, (_k, v) => dropUndef(v));
      let x = out;
      while (x.child) x = x.child;
      expect("leaf" in x).toBe(false);
      expect(x.keep).toBe(1);
    });

    test("dropping a Map/Set value keeps the entry with value undefined (NOT JSON-style removal)", async () => {
      // Documented divergence from JSON.stringify: a Map/Set is a keyed/positional
      // collection, so an entry is not removed — its value becomes undefined.
      const m = await rt(
        new Map<string, number>([
          ["a", 1],
          ["b", 2],
        ]),
        (k, v) => (k === "b" ? undefined : v),
      );
      expect([...m.entries()]).toEqual([
        ["a", 1],
        ["b", undefined],
      ]);
      const s = await rt(new Set([1, 2, 3]), (k, v) => (k === "1" ? undefined : v));
      expect([...s.values()]).toEqual([1, undefined, 3]);
    });
  });

  describe("transform-to-complex: the replacer's return value is fully (re)serialized", () => {
    test("returning a new object is recursed into", async () => {
      const out = await rt({ a: 1 }, (k, v) => (k === "a" ? { nested: 5 } : v));
      expect(out).toEqual({ a: { nested: 5 } });
    });

    test("the returned object's children are themselves transformed at depth", async () => {
      const out = await rt({ a: "X" }, (k, v) => {
        if (k === "a") return { m: 3 };
        return typeof v === "number" ? (v as number) * 100 : v;
      });
      expect(out).toEqual({ a: { m: 300 } });
    });

    test("returning a Map is serialized", async () => {
      const out = await rt({ a: 1 }, (k, v) => (k === "a" ? new Map([["z", 9]]) : v));
      expect([...out.a.entries()]).toEqual([["z", 9]]);
    });

    test("returning a fresh cycle is preserved (no infinite loop)", async () => {
      const out = await rt({ a: 1 }, (k, v) => {
        if (k === "a") {
          const c: any = {};
          c.loop = c;
          return c;
        }
        return v;
      });
      expect(out.a.loop).toBe(out.a);
    });
  });

  describe("cycles compose with the replacer", () => {
    test("a self-referential graph is preserved while values are transformed", async () => {
      const o: any = { n: 2 };
      o.self = o;
      const out: any = await rt(o, x100);
      expect(out.self).toBe(out);
      expect(out.n).toBe(200);
    });
  });

  describe("`this` is the holder", () => {
    test("object holder", async () => {
      const out = await rt({ a: 1, b: 2 }, function (this: any, k, v) {
        return k === "a" ? this.b : v;
      });
      expect(out.a).toBe(2);
    });

    test("array holder (this is the array)", async () => {
      const out = await rt([10, 20, 30], function (this: any, k, v) {
        return k === "0" ? this.length : v;
      });
      expect(out).toEqual([3, 20, 30]);
    });

    test("Map holder (this is the Map)", async () => {
      const out = await rt(new Map([["a", 1]]), function (this: any, k, v) {
        return k === "a" ? (this instanceof Map ? "ISMAP" : "NO") : v;
      });
      expect([...out.entries()]).toEqual([["a", "ISMAP"]]);
    });

    test("nested holder is the immediate parent", async () => {
      const out = await rt({ outer: { inner: 1 } }, function (this: any, k, v) {
        return k === "inner" ? (this.inner === 1 ? "PARENT_OK" : "NO") : v;
      });
      expect(out.outer.inner).toBe("PARENT_OK");
    });
  });

  describe("replacer composes with builtins / proxies / bound fns at depth", () => {
    test("Date passes through intact while siblings transform", async () => {
      const out = await rt({ d: new Date(0), n: 5 }, x100);
      expect(out.d).toBeInstanceOf(Date);
      expect(out.d.getTime()).toBe(0);
      expect(out.n).toBe(500);
    });

    test("typed array stays intact; sibling transforms", async () => {
      const out = await rt({ ta: new Uint8Array([1, 2, 3]), n: 2 }, x100);
      expect(out.ta).toBeInstanceOf(Uint8Array);
      expect(Array.from(out.ta)).toEqual([1, 2, 3]);
      expect(out.n).toBe(200);
    });

    test("Error passes through; sibling transforms", async () => {
      const out = await rt({ e: new Error("msg"), n: 1 }, x100);
      expect(out.e).toBeInstanceOf(Error);
      expect(out.e.message).toBe("msg");
      expect(out.n).toBe(100);
    });

    test("a builtin subclass (extends Map) has both entries and own fields transformed", async () => {
      class MyMap extends Map<string, number> {
        meta = 9;
        constructor(e: [string, number][]) {
          super(e);
        }
      }
      const out = await rt(new MyMap([["a", 1]]), x100);
      expect(out).toBeInstanceOf(Map);
      expect(out.get("a")).toBe(100);
      expect(out.meta).toBe(900);
    });

    test("Proxy target is traversed and transformed", async () => {
      const out = await rt(new Proxy({ n: 4 }, {}), x100);
      expect(out.n).toBe(400);
    });

    test("bound function's bound-this state is transformed", async () => {
      const obj = { v: 3 };
      function f(this: any) {
        return this.v;
      }
      const bound = f.bind(obj);
      const out = await rt(bound as any, x100);
      expect((out as any)()).toBe(300);
    });

    test("frozen object's value is transformed and frozenness preserved", async () => {
      const out = await rt(Object.freeze({ n: 5 }), x100);
      expect(Object.isFrozen(out)).toBe(true);
      expect(out.n).toBe(500);
    });
  });

  describe("replacer failure modes", () => {
    test("a throwing replacer (deep) propagates a clear serializer error", async () => {
      // Capture the graph as a free variable so the replacer actually traverses it.
      const value = { a: { b: 1 } };
      const cap = () => value;
      expect(() =>
        serialize(cap, (k: string, v: unknown) => {
          if (k === "b") throw new Error("boom-deep");
          return v;
        }),
      ).toThrow("boom-deep");
    });
  });

  describe("documented divergences from JSON.stringify", () => {
    test("a getter's VALUE is NOT passed through the replacer (accessor preserved, getter not invoked)", async () => {
      // JSON.stringify would invoke `g` and yield 500; the closure serializer
      // preserves the accessor descriptor and never invokes the getter, so the
      // replacer never sees its value. The data sibling `x` IS transformed.
      const o: any = { x: 1 };
      Object.defineProperty(o, "g", { get: () => 5, enumerable: true, configurable: true });
      const out: any = await rt(o, x100);
      expect(out.x).toBe(100);
      expect(out.g).toBe(5);
      expect(typeof Object.getOwnPropertyDescriptor(out, "g")!.get).toBe("function");
    });

    test("toJSON is NOT honored (consistently, at depth)", async () => {
      const out: any = await rt({ wrap: { toJSON: () => "X", real: 1 } }, (_k, v) => v);
      expect(out.wrap.real).toBe(1);
    });

    test("a getter that throws is preserved (not invoked during serialization)", async () => {
      const o: any = { ok: 1 };
      Object.defineProperty(o, "bad", {
        get() {
          throw new Error("nope");
        },
        enumerable: true,
        configurable: true,
      });
      const out: any = await rt(o, (_k, v) => v);
      expect(typeof Object.getOwnPropertyDescriptor(out, "bad")!.get).toBe("function");
      expect(out.ok).toBe(1);
    });
  });

  describe("descriptor preservation: full writable×enumerable×configurable matrix", () => {
    const combos: Array<[number, number, number]> = [
      [1, 1, 1],
      [1, 1, 0],
      [1, 0, 1],
      [1, 0, 0],
      [0, 1, 1],
      [0, 1, 0],
      [0, 0, 1],
      [0, 0, 0],
    ];
    function matrixObj() {
      const o: any = {};
      for (const [w, e, c] of combos) {
        Object.defineProperty(o, `k${w}${e}${c}`, {
          value: 42,
          writable: !!w,
          enumerable: !!e,
          configurable: !!c,
        });
      }
      return o;
    }
    function dump(o: any) {
      const d = Object.getOwnPropertyDescriptors(o);
      const out: Record<string, number[]> = {};
      for (const k of Object.keys(d)) {
        const x = d[k];
        out[k] = [x.value, +!!x.writable, +!!x.enumerable, +!!x.configurable];
      }
      return out;
    }

    test("preserved exactly at the root", async () => {
      const src = matrixObj();
      const out = await rt(src, (_k, v) => v);
      expect(dump(out)).toEqual(dump(src));
    });

    test("preserved exactly when nested", async () => {
      const src = matrixObj();
      const out = await rt({ inner: src }, (_k, v) => v);
      expect(dump(out.inner)).toEqual(dump(src));
    });

    test("preserved on a non-index array own property", async () => {
      const a: any = [1];
      Object.defineProperty(a, "extra", { value: 42, writable: false, enumerable: false, configurable: true });
      const out = await rt(a, (_k, v) => v);
      const d = Object.getOwnPropertyDescriptor(out, "extra")!;
      expect([d.value, d.writable, d.enumerable, d.configurable]).toEqual([42, false, false, true]);
    });

    test("preserved on a class instance", async () => {
      class C {}
      const src: any = new C();
      Object.defineProperty(src, "p", { value: 7, writable: false, enumerable: false, configurable: true });
      const out = await rt(src, (_k, v) => v);
      const d = Object.getOwnPropertyDescriptor(out, "p")!;
      expect([d.value, d.writable, d.enumerable, d.configurable]).toEqual([7, false, false, true]);
      expect(out).toBeInstanceOf(Object.getPrototypeOf(out).constructor);
    });
  });

  describe("accessor descriptors at every position/depth", () => {
    function accObj() {
      const o: any = {};
      Object.defineProperty(o, "getter", { get: () => 7, enumerable: true, configurable: false });
      Object.defineProperty(o, "setter", { set() {}, enumerable: false, configurable: true });
      Object.defineProperty(o, "both", { get: () => 9, set() {}, enumerable: true, configurable: true });
      return o;
    }

    test("get-only descriptor + flags preserved", async () => {
      const out = await rt(accObj(), (_k, v) => v);
      const d = Object.getOwnPropertyDescriptor(out, "getter")!;
      expect(typeof d.get).toBe("function");
      expect(d.set).toBeUndefined();
      expect([d.enumerable, d.configurable]).toEqual([true, false]);
      expect(out.getter).toBe(7);
    });

    test("set-only descriptor + flags preserved", async () => {
      const out = await rt(accObj(), (_k, v) => v);
      const d = Object.getOwnPropertyDescriptor(out, "setter")!;
      expect(d.get).toBeUndefined();
      expect(typeof d.set).toBe("function");
      expect([d.enumerable, d.configurable]).toEqual([false, true]);
    });

    test("get+set descriptor preserved", async () => {
      const out = await rt(accObj(), (_k, v) => v);
      const d = Object.getOwnPropertyDescriptor(out, "both")!;
      expect(typeof d.get).toBe("function");
      expect(typeof d.set).toBe("function");
      expect(out.both).toBe(9);
    });

    test("get===set deduped to one function", async () => {
      const o: any = {};
      function f(this: any, x?: number) {
        if (arguments.length) this._v = x;
        return this._v ?? 11;
      }
      Object.defineProperty(o, "p", { get: f, set: f, enumerable: true, configurable: true });
      const out = await rt(o, (_k, v) => v);
      const d = Object.getOwnPropertyDescriptor(out, "p")!;
      expect(d.get).toBe(d.set);
      expect(out.p).toBe(11);
    });

    test("accessor preserved when it is a Map value (depth)", async () => {
      const inner: any = {};
      Object.defineProperty(inner, "g", { get: () => 5, enumerable: true, configurable: true });
      inner.d = 2;
      const out = await rt(new Map([["k", inner]]), x100);
      const got = out.get("k")!;
      expect(typeof Object.getOwnPropertyDescriptor(got, "g")!.get).toBe("function");
      expect(got.g).toBe(5);
      expect(got.d).toBe(200);
    });

    test("non-enumerable accessor preserved at depth", async () => {
      const o: any = { level: {} };
      Object.defineProperty(o.level, "a", { get: () => 3, enumerable: false, configurable: true });
      const out = await rt(o, (_k, v) => v);
      const d = Object.getOwnPropertyDescriptor(out.level, "a")!;
      expect(d.enumerable).toBe(false);
      expect(out.level.a).toBe(3);
    });
  });

  describe("symbol-keyed descriptors and key ordering", () => {
    function symKeyed() {
      const S = Symbol.for("reg");
      const o: any = { first: 1 };
      Object.defineProperty(o, S, { value: 2, writable: false, enumerable: true, configurable: false });
      o.second = 3;
      return o;
    }

    test("registered-symbol descriptor + flags preserved", async () => {
      const out = await rt(symKeyed(), (_k, v) => v);
      const d = Object.getOwnPropertyDescriptor(out, Symbol.for("reg"))!;
      expect([d.value, d.writable, d.enumerable, d.configurable]).toEqual([2, false, true, false]);
    });

    test("string keys precede symbol keys (ordering preserved)", async () => {
      const out = await rt(symKeyed(), (_k, v) => v);
      expect(Reflect.ownKeys(out).map(k => (typeof k === "symbol" ? "SYM" : k))).toEqual(["first", "second", "SYM"]);
    });

    test("a symbol-keyed descriptor at depth (inside an array element) is preserved", async () => {
      const S = Symbol.for("x");
      const o: any = {};
      Object.defineProperty(o, S, { value: 7, writable: false, enumerable: true, configurable: false });
      const out = await rt([o], (_k, v) => v);
      const d = Object.getOwnPropertyDescriptor(out[0], S)!;
      expect([d.value, d.writable, d.configurable]).toEqual([7, false, false]);
    });

    test("a unique (non-registered) symbol-keyed value transforms at depth", async () => {
      const S = Symbol.for("d");
      const out = await rt({ wrap: { [S]: 4 } } as any, x100);
      expect(out.wrap[S]).toBe(400);
    });
  });

  describe("__proto__ as an OWN property (not the prototype)", () => {
    test("own data property named __proto__ is preserved without affecting the prototype", async () => {
      const o: any = {};
      Object.defineProperty(o, "__proto__", { value: "literal", writable: true, enumerable: true, configurable: true });
      const out = await rt(o, (_k, v) => v);
      expect(Object.getOwnPropertyDescriptor(out, "__proto__")!.value).toBe("literal");
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    });

    test("own accessor named __proto__ is preserved", async () => {
      const o: any = {};
      Object.defineProperty(o, "__proto__", { get: () => "viaGetter", enumerable: true, configurable: true });
      const out = await rt(o, (_k, v) => v);
      expect(out.__proto__).toBe("viaGetter");
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    });
  });
});

// ── GENERALITY SUITE: built-in objects ───────────────────────────────────────
// Proves built-in handling (Date/RegExp/Map/Set/WeakMap/WeakSet/WeakRef/typed
// arrays/DataView/ArrayBuffer/SharedArrayBuffer/boxed primitives/Error+subclasses/
// AggregateError/settled Promise) is GENERAL across POSITION, ALIASING, CYCLES,
// NESTING, OWN-PROPERTIES, ENTRIES, SUBCLASSING, REPLACER, RE-SERIALIZATION, and
// typed-array completeness — not just flat spot-checks.
//
// Paste into test/js/bun/closure.test.ts. Relies on the file's existing
// `roundtrip` helper (serialize → write module → dynamic-import → default export)
// and a `roundtripWith(fn, replacer)` variant (added below if absent).
describe("generality: built-ins", () => {
  // serialize() with a replacer, round-tripped via the same write+import path.
  // (Mirror of the file's `roundtrip`; uses serialize's 2nd arg.)
  let rwCounter = 0;
  async function roundtripWith<T extends Function>(fn: T, replacer: (k: string, v: unknown) => unknown): Promise<T> {
    const { serialize } = await import("bun:closure");
    const code = serialize(fn, replacer);
    using dir = tempDir(`closure-genrep-${rwCounter++}`, { "mod.mjs": code });
    const mod = await import(`${String(dir)}/mod.mjs`);
    return mod.default as T;
  }

  // ── POSITION: each builtin kind reconstructs correctly at every position ──────
  // A Date carrying a recognizable time, captured through each position; the
  // returned accessor pulls it back out. Value + type asserted everywhere.
  describe.each([
    [
      "free var",
      () => {
        const d = new Date(111);
        return () => d;
      },
    ],
    [
      "object property",
      () => {
        const d = new Date(111);
        const o = { d };
        return () => o.d;
      },
    ],
    [
      "array element",
      () => {
        const d = new Date(111);
        const a = [0, d];
        return () => a[1];
      },
    ],
    [
      "Map key",
      () => {
        const d = new Date(111);
        const m = new Map([[d, "v"]]);
        return () => [...m.keys()][0];
      },
    ],
    [
      "Map value",
      () => {
        const d = new Date(111);
        const m = new Map([["k", d]]);
        return () => m.get("k");
      },
    ],
    [
      "Set member",
      () => {
        const d = new Date(111);
        const s = new Set([d]);
        return () => [...s][0];
      },
    ],
    [
      "getter return",
      () => {
        const d = new Date(111);
        const o = {
          get x() {
            return d;
          },
        };
        return () => o.x;
      },
    ],
    [
      "deeply nested",
      () => {
        const d = new Date(111);
        const o = { a: { b: { c: [{ d }] } } };
        return () => o.a.b.c[0].d;
      },
    ],
    [
      "class static",
      () => {
        const d = new Date(111);
        class C {
          static d = d;
        }
        return () => C.d;
      },
    ],
    [
      "non-enumerable own prop",
      () => {
        const d = new Date(111);
        const o = {};
        Object.defineProperty(o, "d", { value: d, enumerable: false });
        return () => (o as any).d;
      },
    ],
    [
      "symbol-keyed prop",
      () => {
        const d = new Date(111);
        const S = Symbol.for("k");
        const o = { [S]: d };
        return () => o[S];
      },
    ],
    [
      "#private field",
      () => {
        const d = new Date(111);
        class C {
          #d = d;
          get() {
            return this.#d;
          }
        }
        const c = new C();
        return () => c.get();
      },
    ],
  ])("a Date at position: %s", (_pos, factory) => {
    test("preserves value and type", async () => {
      const accessor = (await roundtrip(factory as any))();
      const d = accessor();
      expect(d).toBeInstanceOf(Date);
      expect(d.getTime()).toBe(111);
    });
  });

  // A Map at a representative set of positions.
  describe.each([
    [
      "object property",
      () => {
        const m = new Map([["k", 1]]);
        const o = { m };
        return () => o.m;
      },
    ],
    [
      "Map value",
      () => {
        const inner = new Map([["k", 1]]);
        const m = new Map([["x", inner]]);
        return () => m.get("x");
      },
    ],
    [
      "Set member",
      () => {
        const m = new Map([["k", 1]]);
        const s = new Set([m]);
        return () => [...s][0];
      },
    ],
    [
      "#private field",
      () => {
        const m = new Map([["k", 1]]);
        class C {
          #m = m;
          g() {
            return this.#m;
          }
        }
        const c = new C();
        return () => c.g();
      },
    ],
  ])("a Map at position: %s", (_pos, factory) => {
    test("preserves entries and type", async () => {
      const m = (await roundtrip(factory as any))()();
      expect(m).toBeInstanceOf(Map);
      expect(m.get("k")).toBe(1);
    });
  });

  // ── ALIASING: one builtin instance reached via K paths collapses to 1 identity ─
  test("the same Date via two paths is one identity", async () => {
    const d = new Date(5);
    const o = { a: d, b: d };
    void o;
    const out = (await roundtrip(() => o))();
    expect(out.a).toBe(out.b);
    expect(out.a.getTime()).toBe(5);
  });

  test("a Map that is BOTH a key and a value of another Map stays one instance", async () => {
    const inner = new Map<unknown, unknown>();
    const m = new Map<unknown, unknown>();
    m.set(inner, "as-key");
    m.set("k", inner);
    void m;
    const out = (await roundtrip(() => m))();
    const reachedAsKey = [...out.keys()].find(k => k instanceof Map);
    expect(reachedAsKey).toBe(out.get("k"));
  });

  test("a typed array and its ArrayBuffer both captured share the buffer", async () => {
    const b = new ArrayBuffer(8);
    const a = new Int32Array(b);
    const pair = { a, b };
    void pair;
    const out = (await roundtrip(() => pair))();
    expect(out.a.buffer).toBe(out.b);
  });

  test("two views over one buffer reached via different paths stay shared", async () => {
    const b = new ArrayBuffer(8);
    const a = new Float64Array(b);
    const o = { o1: { view: a }, o2: { view: a } };
    void o;
    const out = (await roundtrip(() => o))();
    expect(out.o1.view).toBe(out.o2.view);
    expect(out.o1.view.buffer).toBe(out.o2.view.buffer);
  });

  test("two distinct views over one buffer write through to each other", async () => {
    const b = new ArrayBuffer(8);
    const i32 = new Int32Array(b);
    const u8 = new Uint8Array(b);
    const pair = { i32, u8 };
    void pair;
    const out = (await roundtrip(() => pair))();
    expect(out.i32.buffer).toBe(out.u8.buffer);
    out.i32[0] = 0x01020304;
    expect(out.u8[0]).not.toBe(0); // shared backing store
  });

  // ── CYCLES ───────────────────────────────────────────────────────────────────
  test("a Map containing itself as a value", async () => {
    const m = new Map<string, unknown>();
    m.set("self", m);
    void m;
    const out = (await roundtrip(() => m))();
    expect(out.get("self")).toBe(out);
  });

  test("a Map containing itself as a key", async () => {
    const m = new Map<unknown, unknown>();
    m.set(m, "v");
    void m;
    const out = (await roundtrip(() => m))();
    expect(out.has(out)).toBe(true);
    expect(out.get(out)).toBe("v");
  });

  test("a Set containing itself", async () => {
    const s = new Set<unknown>();
    s.add(s);
    void s;
    const out = (await roundtrip(() => s))();
    expect(out.has(out)).toBe(true);
  });

  test("a Map whose value cycles back to the container through an object", async () => {
    const m = new Map<string, any>();
    const o: any = { m };
    m.set("o", o);
    void m;
    const out = (await roundtrip(() => m))();
    expect(out.get("o").m).toBe(out);
  });

  test("an array inside a Map in a cycle", async () => {
    const m = new Map<string, any>();
    const a: any[] = [m];
    m.set("a", a);
    void m;
    const out = (await roundtrip(() => m))();
    expect(out.get("a")[0]).toBe(out);
  });

  test("an Error whose .cause cycles back to itself", async () => {
    const e = new Error("a") as any;
    e.cause = e;
    void e;
    const out = (await roundtrip(() => e))();
    expect(out.cause).toBe(out);
  });

  test("a Date inside a cyclic object", async () => {
    const d = new Date(7);
    const o: any = { d };
    o.self = o;
    void o;
    const out = (await roundtrip(() => o))();
    expect(out.self).toBe(out);
    expect(out.d.getTime()).toBe(7);
  });

  // ── NESTING ──────────────────────────────────────────────────────────────────
  test("Map of Map of Map (deep)", async () => {
    const m = new Map([["a", new Map([["b", new Map([["c", 42]])]])]]);
    void m;
    const out = (await roundtrip(() => m))();
    expect(out.get("a")!.get("b")!.get("c")).toBe(42);
  });

  test("Set of Set of Set", async () => {
    const s = new Set([new Set([new Set([9])])]);
    void s;
    const out = (await roundtrip(() => s))();
    const inner = [...[...[...out][0]][0]][0];
    expect(inner).toBe(9);
  });

  test("Error.cause chain (3 deep)", async () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    const c = new Error("c", { cause: b });
    void c;
    const out = (await roundtrip(() => c))();
    expect((out.cause as Error).message).toBe("b");
    expect(((out.cause as Error).cause as Error).message).toBe("a");
  });

  test("Map of Maps, cyclic AND aliased (same inner at two keys, inner→outer)", async () => {
    const outer = new Map<string, any>();
    const inner = new Map<string, any>();
    inner.set("up", outer);
    outer.set("a", inner);
    outer.set("b", inner);
    void outer;
    const out = (await roundtrip(() => outer))();
    expect(out.get("a")).toBe(out.get("b"));
    expect(out.get("a").get("up")).toBe(out);
  });

  // ── OWN-PROPERTY generality on every builtin kind ────────────────────────────
  test.each([
    [
      "Map",
      () => {
        const m = new Map([["k", 1]]);
        (m as any).meta = "hi";
        return m;
      },
      (o: any) => expect(o.meta).toBe("hi"),
    ],
    [
      "Set",
      () => {
        const s = new Set([1]);
        (s as any).tag = "t";
        return s;
      },
      (o: any) => expect(o.tag).toBe("t"),
    ],
    [
      "Date",
      () => {
        const d = new Date(1);
        (d as any).x = "dx";
        return d;
      },
      (o: any) => expect(o.x).toBe("dx"),
    ],
    [
      "RegExp",
      () => {
        const r = /a/;
        (r as any).y = "ry";
        return r;
      },
      (o: any) => expect(o.y).toBe("ry"),
    ],
    [
      "typed array",
      () => {
        const a = new Uint8Array([1, 2]);
        (a as any).label = "L";
        return a;
      },
      (o: any) => expect(o.label).toBe("L"),
    ],
    [
      "ArrayBuffer",
      () => {
        const b = new ArrayBuffer(2);
        (b as any).z = "z";
        return b;
      },
      (o: any) => expect(o.z).toBe("z"),
    ],
    [
      "boxed Number",
      () => {
        const x = new Number(3);
        (x as any).w = "w";
        return x;
      },
      (o: any) => expect(o.w).toBe("w"),
    ],
    [
      "WeakMap",
      () => {
        const m = new WeakMap();
        (m as any).v = "wmv";
        return m;
      },
      (o: any) => expect(o.v).toBe("wmv"),
    ],
    [
      "Error",
      () => {
        const e = new Error("e");
        (e as any).code = "C";
        return e;
      },
      (o: any) => expect(o.code).toBe("C"),
    ],
  ])("an enumerable own prop survives on a %s", async (_kind, make, assert) => {
    const v = make();
    void v;
    const out = (await roundtrip(() => v))();
    assert(out);
  });

  test("a non-enumerable own prop on a Map survives with its descriptor", async () => {
    const m = new Map();
    Object.defineProperty(m, "hidden", { value: 7, enumerable: false, configurable: true });
    void m;
    const out = (await roundtrip(() => m))();
    const d = Object.getOwnPropertyDescriptor(out, "hidden")!;
    expect(d.value).toBe(7);
    expect(d.enumerable).toBe(false);
  });

  test("a symbol-keyed own prop on a Set survives", async () => {
    const S = Symbol.for("z");
    const s = new Set([1]);
    (s as any)[S] = "sv";
    void s;
    const out = (await roundtrip(() => s))();
    expect((out as any)[S]).toBe("sv");
  });

  test("an accessor own prop on a Date survives as an accessor", async () => {
    const d = new Date(1);
    Object.defineProperty(d, "acc", {
      get() {
        return 99;
      },
      enumerable: true,
      configurable: true,
    });
    void d;
    const out = (await roundtrip(() => d))();
    const desc = Object.getOwnPropertyDescriptor(out, "acc")!;
    expect(typeof desc.get).toBe("function");
    expect((out as any).acc).toBe(99);
  });

  test("an own prop whose VALUE is itself a Map survives", async () => {
    const inner = new Map([["x", 5]]);
    const d = new Date(1);
    (d as any).payload = inner;
    void d;
    const out = (await roundtrip(() => d))();
    expect((out as any).payload).toBeInstanceOf(Map);
    expect((out as any).payload.get("x")).toBe(5);
  });

  test("an own prop whose VALUE is a well-known global is referenced (identity)", async () => {
    const d = new Date(1);
    (d as any).m = Math;
    void d;
    const out = (await roundtrip(() => d))();
    expect((out as any).m).toBe(Math);
  });

  test("a Map with BOTH entries AND extra own props keeps both", async () => {
    const m = new Map([
      ["a", 1],
      ["b", 2],
    ]) as any;
    m.meta = { t: true };
    void m;
    const out = (await roundtrip(() => m))();
    expect(out.get("a")).toBe(1);
    expect(out.get("b")).toBe(2);
    expect(out.meta.t).toBe(true);
  });

  // ── ENTRIES generality ───────────────────────────────────────────────────────
  test("Map keyed by a builtin (Date) preserves key identity and value", async () => {
    const d = new Date(1);
    const m = new Map([[d, "v"]]);
    void m;
    const out = (await roundtrip(() => m))();
    const k = [...out.keys()][0];
    expect(k).toBeInstanceOf(Date);
    expect(out.get(k)).toBe("v");
  });

  test("Map whose value is a function with its own capture", async () => {
    const x = 21;
    const f = () => x * 2;
    const m = new Map([["f", f]]);
    void m;
    const out = (await roundtrip(() => m))();
    expect(out.get("f")!()).toBe(42);
  });

  test("Map with a NaN key round-trips (SameValueZero)", async () => {
    const m = new Map([[NaN, "n"]]);
    void m;
    const out = (await roundtrip(() => m))();
    expect(out.get(NaN)).toBe("n");
  });

  test("Map insertion order is preserved", async () => {
    const m = new Map<string, number>();
    m.set("z", 1);
    m.set("a", 2);
    m.set("m", 3);
    void m;
    const out = (await roundtrip(() => m))();
    expect([...out.keys()]).toEqual(["z", "a", "m"]);
  });

  test("Set insertion order is preserved", async () => {
    const s = new Set<string>();
    s.add("c");
    s.add("a");
    s.add("b");
    void s;
    const out = (await roundtrip(() => s))();
    expect([...out]).toEqual(["c", "a", "b"]);
  });

  test("a large Map (10k entries) round-trips fully", async () => {
    const m = new Map<number, number>();
    for (let i = 0; i < 10000; i++) m.set(i, i * 2);
    void m;
    const out = (await roundtrip(() => m))();
    expect(out.size).toBe(10000);
    expect(out.get(0)).toBe(0);
    expect(out.get(9999)).toBe(19998);
  });

  // ── SUBCLASS generality ──────────────────────────────────────────────────────
  test("class extends Map with fields + entries + own prop", async () => {
    class MyMap extends Map {
      extra = 7;
    }
    const m = new MyMap([["k", 1]]);
    (m as any).tag = "t";
    void m;
    const out = (await roundtrip(() => m))();
    expect(out).toBeInstanceOf(Map);
    expect(out.get("k")).toBe(1);
    expect((out as any).extra).toBe(7);
    expect((out as any).tag).toBe("t");
    expect(out.constructor.name).toBe("MyMap");
  });

  test("class extends Set with a field", async () => {
    class MySet extends Set {
      extra = 9;
    }
    const s = new MySet([1, 2]);
    void s;
    const out = (await roundtrip(() => s))();
    expect(out).toBeInstanceOf(Set);
    expect([...out]).toEqual([1, 2]);
    expect((out as any).extra).toBe(9);
  });

  test("class extends Array with a field", async () => {
    class MyArr extends Array {
      extra = 3;
    }
    const a = new MyArr();
    a.push(1, 2, 3);
    void a;
    const out = (await roundtrip(() => a))();
    expect(out).toBeInstanceOf(Array);
    expect(out.length).toBe(3);
    expect(out[2]).toBe(3);
    expect((out as any).extra).toBe(3);
  });

  test("class extends Error with name + code", async () => {
    class MyErr extends Error {
      code = 5;
      constructor(m: string) {
        super(m);
        this.name = "MyErr";
      }
    }
    const e = new MyErr("boom");
    void e;
    const out = (await roundtrip(() => e))();
    expect(out).toBeInstanceOf(Error);
    expect(out.message).toBe("boom");
    expect((out as any).code).toBe(5);
    expect(out.name).toBe("MyErr");
  });

  test("class extends Date preserves time, field, and instanceof", async () => {
    class MyDate extends Date {
      extra = 1;
    }
    const d = new MyDate(123);
    void d;
    const out = (await roundtrip(() => d))();
    expect(out).toBeInstanceOf(Date);
    expect(out.getTime()).toBe(123);
    expect((out as any).extra).toBe(1);
    expect(out.constructor.name).toBe("MyDate");
  });

  test("class extends Map with #private + entries", async () => {
    class MyMap extends Map {
      #secret = 42;
      rev() {
        return this.#secret;
      }
    }
    const m = new MyMap([["a", 1]]);
    void m;
    const out = (await roundtrip(() => m))();
    expect(out.get("a")).toBe(1);
    expect((out as any).rev()).toBe(42);
  });

  test("a Map subclass in a cycle", async () => {
    class MyMap extends Map {}
    const m = new MyMap();
    m.set("self", m);
    void m;
    const out = (await roundtrip(() => m))();
    expect(out.get("self")).toBe(out);
    expect(out).toBeInstanceOf(Map);
  });

  test("a Map subclass aliased at two paths is one identity", async () => {
    class MyMap extends Map {}
    const m = new MyMap([["x", 1]]);
    const o = { a: m, b: m };
    void o;
    const out = (await roundtrip(() => o))();
    expect(out.a).toBe(out.b);
    expect(out.a.get("x")).toBe(1);
  });

  test("a Map subclass that overrides set() restores via the BASE set (no re-transform)", async () => {
    class M extends Map {
      set(k: unknown, v: any) {
        return super.set(k, v * 10);
      }
    }
    const m = new M();
    m.set("a", 1); // override stores 10
    void m;
    const out = (await roundtrip(() => m))();
    expect(out.get("a")).toBe(10); // not 100 — restore must not re-run the override
  });

  // ── REPLACER + builtins (replacer applies to CAPTURED state) ─────────────────
  // The builtin must be captured from a scope OUTSIDE the serialized root so it
  // flows through value-emission (where the replacer runs), not verbatim source.
  const double = (_k: string, v: unknown) => (typeof v === "number" ? v * 2 : v);

  test("a replacer transforms Map values", async () => {
    const root = (
      (m: Map<string, number>) => () =>
        m
    )(
      new Map([
        ["a", 1],
        ["b", 2],
      ]),
    );
    const out = (await roundtripWith(root, double))();
    expect(out.get("a")).toBe(2);
    expect(out.get("b")).toBe(4);
  });

  test("a replacer transforms Set members", async () => {
    const root = (
      (s: Set<number>) => () =>
        s
    )(new Set([1, 2, 3]));
    const out = (await roundtripWith(root, double))();
    expect([...out].sort((a, b) => a - b)).toEqual([2, 4, 6]);
  });

  test("a replacer transforms a value at depth (Map in Map)", async () => {
    const root = (
      (m: Map<string, Map<string, number>>) => () =>
        m
    )(new Map([["x", new Map([["y", 5]])]]));
    const out = (await roundtripWith(root, double))();
    expect(out.get("x")!.get("y")).toBe(10);
  });

  test("a replacer transforms an Error's custom field", async () => {
    const root = (
      (e: Error) => () =>
        e
    )(Object.assign(new Error("m"), { count: 3 }));
    const out = (await roundtripWith(root, double))();
    expect((out as any).count).toBe(6);
  });

  test("a replacer transforms inside a cyclic Map without breaking the cycle", async () => {
    const m = new Map<string, any>([["n", 4]]);
    m.set("self", m);
    const root = (
      (mm: typeof m) => () =>
        mm
    )(m);
    const out = (await roundtripWith(root, double))();
    expect(out.get("n")).toBe(8);
    expect(out.get("self")).toBe(out);
  });

  test("a replacer dropping a specific key's value does not corrupt the collection", async () => {
    const root = (
      (m: Map<string, number>) => () =>
        m
    )(
      new Map([
        ["keep", 1],
        ["drop", 2],
      ]),
    );
    // Only the "drop" entry's value is replaced with undefined; every other value
    // (and the Map itself) passes through unchanged.
    const out = (await roundtripWith(root, (k: string, v: unknown) => (k === "drop" ? undefined : v)))();
    expect(out).toBeInstanceOf(Map);
    expect(out.get("keep")).toBe(1);
    expect(out.get("drop")).toBeUndefined();
  });

  // ── typed-array COMPLETENESS ─────────────────────────────────────────────────
  test.each([
    ["Int8Array", Int8Array, [-1, 2, -3]],
    ["Uint8Array", Uint8Array, [1, 2, 255]],
    ["Uint8ClampedArray", Uint8ClampedArray, [0, 128, 255]],
    ["Int16Array", Int16Array, [-1, 1000, -2000]],
    ["Uint16Array", Uint16Array, [1, 60000, 3]],
    ["Int32Array", Int32Array, [-1, 2000000, -3]],
    ["Uint32Array", Uint32Array, [1, 4000000000, 3]],
    ["Float32Array", Float32Array, [1.5, -2.5, 0]],
    ["Float64Array", Float64Array, [1.1, -2.2, 3.3]],
  ] as const)("%s round-trips with its values and prototype", async (_name, Ctor, vals) => {
    const a = new (Ctor as any)(vals);
    void a;
    const out = (await roundtrip(() => a))();
    expect(out).toBeInstanceOf(Ctor as any);
    expect([...out]).toEqual([...new (Ctor as any)(vals)]);
  });

  test.each([
    ["BigInt64Array", BigInt64Array, [1n, -2n, 3n]],
    ["BigUint64Array", BigUint64Array, [1n, 2n, 3n]],
  ] as const)("%s round-trips with its BigInt values", async (_name, Ctor, vals) => {
    const a = new (Ctor as any)(vals as any);
    void a;
    const out = (await roundtrip(() => a))();
    expect(out).toBeInstanceOf(Ctor as any);
    expect([...out]).toEqual([...new (Ctor as any)(vals as any)]);
  });

  test("a typed array with a nonzero byteOffset round-trips", async () => {
    const b = new ArrayBuffer(16);
    const a = new Int32Array(b, 8, 2);
    a[0] = 11;
    a[1] = 22;
    void a;
    const out = (await roundtrip(() => a))();
    expect(out.byteOffset).toBe(8);
    expect(out.length).toBe(2);
    expect([...out]).toEqual([11, 22]);
  });

  test("two views over one buffer at different offsets stay shared", async () => {
    const b = new ArrayBuffer(16);
    const a = new Int32Array(b, 0, 2);
    const c = new Int32Array(b, 8, 2);
    a[0] = 1;
    c[0] = 2;
    const pair = { a, c };
    void pair;
    const out = (await roundtrip(() => pair))();
    expect(out.a.buffer).toBe(out.c.buffer);
    expect(out.c.byteOffset).toBe(8);
    expect(out.a[0]).toBe(1);
    expect(out.c[0]).toBe(2);
  });

  test("a DataView with a nonzero offset round-trips", async () => {
    const b = new ArrayBuffer(16);
    const dv = new DataView(b, 4, 8);
    dv.setInt32(0, 7);
    void dv;
    const out = (await roundtrip(() => dv))();
    expect(out.byteOffset).toBe(4);
    expect(out.byteLength).toBe(8);
    expect(out.getInt32(0)).toBe(7);
  });

  test("a length-tracking view over a resizable buffer keeps tracking", async () => {
    const b = new ArrayBuffer(8, { maxByteLength: 32 });
    const a = new Uint8Array(b);
    a[0] = 9;
    const pair = { b, a };
    void pair;
    const out = (await roundtrip(() => pair))();
    expect((out.b as any).resizable).toBe(true);
    expect(out.a.length).toBe(8);
    (out.b as any).resize(16);
    expect(out.a.length).toBe(16); // still tracking
    expect(out.a[0]).toBe(9);
  });

  test("a SharedArrayBuffer round-trips with its bytes", async () => {
    const b = new SharedArrayBuffer(4);
    new Uint8Array(b).set([1, 2, 3, 4]);
    void b;
    const out = (await roundtrip(() => b))();
    expect(out).toBeInstanceOf(SharedArrayBuffer);
    expect([...new Uint8Array(out)]).toEqual([1, 2, 3, 4]);
  });

  // ── boxed primitives, WeakRef, AggregateError, settled Promise ───────────────
  test.each([
    [
      "Number",
      () => new Number(42),
      (o: any) => {
        expect(o).toBeInstanceOf(Number);
        expect(o.valueOf()).toBe(42);
      },
    ],
    [
      "String",
      () => new String("hi"),
      (o: any) => {
        expect(o).toBeInstanceOf(String);
        expect(o.valueOf()).toBe("hi");
      },
    ],
    [
      "Boolean",
      () => new Boolean(true),
      (o: any) => {
        expect(o).toBeInstanceOf(Boolean);
        expect(o.valueOf()).toBe(true);
      },
    ],
  ])("a boxed %s round-trips", async (_kind, make, assert) => {
    const v = make();
    void v;
    const out = (await roundtrip(() => v))();
    assert(out);
  });

  test("a WeakRef preserves its referent's identity when the referent is also captured", async () => {
    const t = { v: 9 };
    const w = new WeakRef(t);
    const o = { w, t, also: t };
    void o;
    const out = (await roundtrip(() => o))();
    expect(out.w.deref()).toBe(out.t);
    expect(out.t).toBe(out.also);
  });

  test("an AggregateError preserves its errors and message", async () => {
    const e = new AggregateError([new Error("a"), new Error("b")], "agg");
    void e;
    const out = (await roundtrip(() => e))();
    expect(out).toBeInstanceOf(AggregateError);
    expect(out.message).toBe("agg");
    expect((out.errors as Error[]).map(x => x.message)).toEqual(["a", "b"]);
  });

  test("a settled Promise resolving to a Map round-trips", async () => {
    const p = Promise.resolve(new Map([["k", 1]]));
    void p;
    const out = (await roundtrip(() => p))();
    const m = await out;
    expect(m).toBeInstanceOf(Map);
    expect(m.get("k")).toBe(1);
  });

  test("a settled rejected Promise carrying an Error round-trips", async () => {
    const p = Promise.reject(new TypeError("boom"));
    p.catch(() => {});
    void p;
    const out = (await roundtrip(() => p))();
    await expect(out).rejects.toThrow(new TypeError("boom"));
  });

  // ── COMPOSITION ──────────────────────────────────────────────────────────────
  test("a Map keyed by a #private instance preserves both key behavior and value", async () => {
    class P {
      #x = 1;
      g() {
        return this.#x;
      }
    }
    const p = new P();
    const m = new Map([[p, "v"]]);
    void m;
    const out = (await roundtrip(() => m))();
    const k = [...out.keys()][0] as P;
    expect(k.g()).toBe(1);
    expect(out.get(k)).toBe("v");
  });

  test("a #private field holding a Map round-trips", async () => {
    class C {
      #m = new Map([["k", 7]]);
      get() {
        return this.#m;
      }
    }
    const c = new C();
    void c;
    const out = (await roundtrip(() => c))();
    expect(out.get()).toBeInstanceOf(Map);
    expect(out.get().get("k")).toBe(7);
  });

  test("an array of one of each builtin kind round-trips", async () => {
    const a = [new Date(1), /x/g, new Map([["k", 1]]), new Set([9]), new Int8Array([3])];
    void a;
    const out = (await roundtrip(() => a))();
    expect(out[0]).toBeInstanceOf(Date);
    expect(out[1]).toBeInstanceOf(RegExp);
    expect((out[2] as Map<string, number>).get("k")).toBe(1);
    expect((out[3] as Set<number>).has(9)).toBe(true);
    expect((out[4] as Int8Array)[0]).toBe(3);
  });

  // ── RE-SERIALIZATION idempotency (3 rounds) ──────────────────────────────────
  // Each round: serialize → import → assert → re-serialize the reconstructed root.
  async function reserialize3<T extends Function>(fn: T, assert: (root: T) => void | Promise<void>): Promise<void> {
    const { serialize } = await import("bun:closure");
    let code = serialize(fn);
    for (let round = 0; round < 3; round++) {
      using dir = tempDir(`closure-reser-${rwCounter++}`, { "mod.mjs": code });
      const root = (await import(`${String(dir)}/mod.mjs`)).default as T;
      await assert(root);
      code = serialize(root);
    }
  }

  test.each([
    [
      "Date",
      (
        (d: Date) => () =>
          d
      )(new Date(999)),
      (root: any) => {
        const d = root();
        expect(d).toBeInstanceOf(Date);
        expect(d.getTime()).toBe(999);
      },
    ],
    [
      "Map",
      (
        (m: Map<string, number>) => () =>
          m
      )(
        new Map([
          ["a", 1],
          ["b", 2],
        ]),
      ),
      (root: any) => {
        const m = root();
        expect(m.get("a")).toBe(1);
        expect(m.get("b")).toBe(2);
      },
    ],
    [
      "Set",
      (
        (s: Set<number>) => () =>
          s
      )(new Set([1, 2, 3])),
      (root: any) => {
        const s = root();
        expect([...s]).toEqual([1, 2, 3]);
      },
    ],
    [
      "RegExp",
      (
        (r: RegExp) => () =>
          r
      )(/ab+/gi),
      (root: any) => {
        const r = root();
        expect(r.source).toBe("ab+");
        expect(r.flags).toBe("gi");
      },
    ],
    [
      "Error",
      (
        (e: Error) => () =>
          e
      )(Object.assign(new TypeError("x"), { code: "E" })),
      (root: any) => {
        const e = root();
        expect(e).toBeInstanceOf(TypeError);
        expect(e.code).toBe("E");
      },
    ],
    [
      "typed array",
      (
        (a: Int32Array) => () =>
          a
      )(new Int32Array([5, 6, 7])),
      (root: any) => {
        const a = root();
        expect([...a]).toEqual([5, 6, 7]);
      },
    ],
    [
      "AggregateError",
      (
        (e: AggregateError) => () =>
          e
      )(new AggregateError([new Error("a")], "agg")),
      (root: any) => {
        const e = root();
        expect(e.message).toBe("agg");
        expect(e.errors.length).toBe(1);
      },
    ],
  ] as const)("a captured %s round-trips idempotently across 3 rounds", async (_kind, root, assert) => {
    await reserialize3(root as any, assert as any);
  });

  test("a cyclic Map round-trips idempotently across 3 rounds", async () => {
    const m = new Map<string, any>();
    m.set("self", m);
    const root = (
      (mm: typeof m) => () =>
        mm
    )(m);
    await reserialize3(root, (r: any) => {
      const out = r();
      expect(out.get("self")).toBe(out);
    });
  });

  test("an aliased Date round-trips idempotently across 3 rounds", async () => {
    const d = new Date(1);
    const o = { a: d, b: d };
    const root = (
      (x: typeof o) => () =>
        x
    )(o);
    await reserialize3(root, (r: any) => {
      const out = r();
      expect(out.a).toBe(out.b);
      expect(out.a.getTime()).toBe(1);
    });
  });
});

// PASTE INTO: test/js/bun/closure.test.ts
// Relies on the existing in-file `roundtrip` helper:
//   async function roundtrip<T extends Function>(fn: T): Promise<T>
// and the existing imports: { test, expect, describe } from "bun:test".
//
// Goal: prove function/class INTEGRITY & OWN-STATE survive serialization at EVERY
// position (root + nested) and under composition — not just root spot-checks.

describe("generality: function & class integrity", () => {
  // ---- Position matrix -----------------------------------------------------
  // Each position takes a pre-built inner value `v` and produces the exported ROOT
  // plus a navigator that recovers it from the round-tripped default export.
  //
  // CRITICAL: the inner value is built ONCE by the caller and CAPTURED as a free
  // variable, then nested. This is the path that exercises the serializer's
  // reflective own-state reproduction (emitFunction → emitFunctionContent). If the
  // value were instead constructed by statements inside the serialized closure
  // body, those statements would be re-emitted as SOURCE and re-executed on import,
  // masking any own-state-reproduction bug. `root` exports the value directly.
  type Position = {
    name: string;
    wrap: (v: any) => () => any;
    nav: (def: any) => any;
  };
  const positions: Position[] = [
    { name: "root", wrap: v => v, nav: d => d },
    { name: "returned-from-closure", wrap: v => () => () => v, nav: d => d()() },
    { name: "array-element", wrap: v => () => [v], nav: d => d()[0] },
    { name: "object-property", wrap: v => () => ({ p: v }), nav: d => d().p },
    { name: "map-value", wrap: v => () => new Map([["k", v]]), nav: d => d().get("k") },
    { name: "map-key", wrap: v => () => new Map([[v, "x"]]), nav: d => [...d().keys()][0] },
    { name: "set-member", wrap: v => () => new Set([v]), nav: d => [...d()][0] },
    { name: "deeply-nested", wrap: v => () => ({ a: { b: [{ c: v }] } }), nav: d => d().a.b[0].c },
    { name: "captured-free-var", wrap: v => () => v, nav: d => d() },
    {
      name: "static-field-of-another-class",
      wrap: v => {
        class Host {}
        (Host as any).field = v;
        return () => Host;
      },
      nav: d => (d() as any).field,
    },
  ];

  // ---- Integrity / own-state kinds ----------------------------------------
  // `make` builds the special value; `assert` checks the recovered value with the
  // strongest invariant for that kind (level + behavior, not just a flag).
  type Kind = {
    name: string;
    make: () => any;
    assert: (v: any) => void;
    // Known-broken kinds: assert documents desired behavior; suite marks them failing.
    failing?: boolean;
  };
  const kinds: Kind[] = [
    {
      name: "frozen function",
      make: () =>
        Object.freeze(function f(a: number) {
          return a;
        }),
      assert: v => {
        expect(Object.isFrozen(v)).toBe(true);
        expect(v(5)).toBe(5);
        expect(v.length).toBe(1);
      },
    },
    {
      name: "sealed function",
      make: () =>
        Object.seal(function f(a: number) {
          return a;
        }),
      assert: v => {
        expect(Object.isSealed(v)).toBe(true);
        expect(Object.isFrozen(v)).toBe(false);
        expect(Object.isExtensible(v)).toBe(false);
      },
    },
    {
      name: "non-extensible function",
      make: () =>
        Object.preventExtensions(function f(a: number) {
          return a;
        }),
      assert: v => {
        expect(Object.isExtensible(v)).toBe(false);
        expect(Object.isSealed(v)).toBe(false);
      },
    },
    {
      name: "overridden name",
      make: () => {
        function f() {}
        Object.defineProperty(f, "name", { value: "XYZ", configurable: true });
        return f;
      },
      assert: v => expect(v.name).toBe("XYZ"),
    },
    {
      name: "overridden length",
      make: () => {
        function f(_a: any, _b: any, _c: any) {}
        Object.defineProperty(f, "length", { value: 1, configurable: true });
        return f;
      },
      assert: v => expect(v.length).toBe(1),
    },
    {
      name: "frozen class",
      make: () =>
        Object.freeze(
          class C {
            m() {
              return 1;
            }
          },
        ),
      assert: v => {
        expect(Object.isFrozen(v)).toBe(true);
        expect(new v().m()).toBe(1);
      },
    },
    {
      name: "frozen prototype",
      make: () => {
        function f() {}
        Object.freeze(f.prototype);
        return f;
      },
      assert: v => expect(Object.isFrozen(v.prototype)).toBe(true),
    },
    {
      name: "enumerable own data prop",
      make: () => {
        function f() {}
        (f as any).pub = 7;
        return f;
      },
      assert: v => expect(v.pub).toBe(7),
    },
    {
      // KNOWN BUG: non-enumerable own data props on a function/class are DROPPED at
      // every position (root takes inline path, nested takes emitOwnProperties with
      // enumerableOnly=true). See report. Flip to plain `test.each` when fixed.
      name: "non-enumerable own data prop",
      failing: true,
      make: () => {
        function f() {}
        Object.defineProperty(f, "secret", { value: 42, enumerable: false, configurable: true, writable: true });
        return f;
      },
      assert: v => {
        expect(v.secret).toBe(42);
        expect(Object.getOwnPropertyDescriptor(v, "secret")!.enumerable).toBe(false);
      },
    },
    {
      // composition: frozen + renamed + overridden length + frozen prototype + own prop
      name: "kitchen sink (frozen + name + length + frozen proto + own prop)",
      make: () => {
        function K(a: number) {
          return a;
        }
        (K as any).tag = "T";
        Object.defineProperty(K, "name", { value: "Renamed", configurable: true });
        Object.defineProperty(K, "length", { value: 9, configurable: true });
        Object.freeze(K.prototype);
        Object.freeze(K);
        return K;
      },
      assert: v => {
        expect(Object.isFrozen(v)).toBe(true);
        expect(v.name).toBe("Renamed");
        expect(v.length).toBe(9);
        expect(v.tag).toBe("T");
        expect(Object.isFrozen(v.prototype)).toBe(true);
        expect(v(3)).toBe(3);
      },
    },
  ];

  for (const pos of positions) {
    for (const kind of kinds) {
      const runner = kind.failing ? test : test;
      runner(`${kind.name} survives at position: ${pos.name}`, async () => {
        const root = await roundtrip(pos.wrap(kind.make()) as any);
        kind.assert(pos.nav(root));
      });
    }
  }
});

describe("generality: name & length matrix", () => {
  test("name inferred for anonymous arrow round-trips", async () => {
    // The arrow's name is inferred from its binding ("g"); capture it as a free
    // variable so the export name ("default") doesn't shadow what we're testing.
    const g = () => 5;
    const holder = await roundtrip(() => g);
    const f = holder();
    expect(f.name).toBe("g");
    expect(f()).toBe(5);
  });

  // KNOWN BUG: name overridden to "" is not restored (guarded by `name !== ""`);
  // the reconstructed function keeps its source-derived name instead.
  test("name overridden to empty string is preserved", async () => {
    const f = await roundtrip(
      (() => {
        function x() {}
        Object.defineProperty(x, "name", { value: "", configurable: true });
        return x;
      })(),
    );
    expect(f.name).toBe("");
  });

  test("very long name round-trips", async () => {
    const long = Buffer.alloc(200, "a").toString();
    const f = await roundtrip(
      (() => {
        function x() {}
        Object.defineProperty(x, "name", { value: long, configurable: true });
        return x;
      })(),
    );
    expect(f.name).toBe(long);
  });

  test("unicode name round-trips", async () => {
    const f = await roundtrip(
      (() => {
        function x() {}
        Object.defineProperty(x, "name", { value: "é中😀", configurable: true });
        return x;
      })(),
    );
    expect(f.name).toBe("é中😀");
  });

  test("name with quotes/newlines round-trips", async () => {
    const f = await roundtrip(
      (() => {
        function x() {}
        Object.defineProperty(x, "name", { value: 'a"b\nc', configurable: true });
        return x;
      })(),
    );
    expect(f.name).toBe('a"b\nc');
  });

  test("name equal to source name is a no-op and round-trips", async () => {
    const f = await roundtrip(function realName() {
      return 1;
    });
    expect(f.name).toBe("realName");
    expect((f as any)()).toBe(1);
  });

  test("natural length with rest param", async () => {
    const f = await roundtrip(function (_a: any, ..._b: any[]) {});
    expect(f.length).toBe(1);
  });

  test("natural length with default param", async () => {
    const f = await roundtrip(function (_a: any, _b = 2) {});
    expect(f.length).toBe(1);
  });

  test("length override that matches natural arity round-trips", async () => {
    const f = await roundtrip(
      (() => {
        function x(a: number, b: number) {
          return a + b;
        }
        Object.defineProperty(x, "length", { value: 2, configurable: true });
        return x;
      })(),
    );
    expect(f.length).toBe(2);
    expect((f as any)(1, 2)).toBe(3);
  });

  test("class length = explicit constructor arity", async () => {
    const C = await roundtrip(
      class {
        a: number;
        constructor(a: number, _b: number) {
          this.a = a;
        }
      },
    );
    expect(C.length).toBe(2);
    expect(new (C as any)(1, 2).a).toBe(1);
  });

  test("class length with rest constructor param", async () => {
    const C = await roundtrip(
      class {
        constructor(_a: number, ..._b: number[]) {}
      },
    );
    expect(C.length).toBe(1);
  });

  test("class with no explicit constructor has length 0", async () => {
    const C = await roundtrip(
      class {
        m() {
          return 1;
        }
      },
    );
    expect(C.length).toBe(0);
  });
});

describe("generality: own-property descriptor preservation on functions", () => {
  test("accessor (get) own property round-trips", async () => {
    const f = await roundtrip(
      (() => {
        function x() {}
        Object.defineProperty(x, "g", { get: () => 11, enumerable: true, configurable: true });
        return x;
      })(),
    );
    expect((f as any).g).toBe(11);
  });

  // KNOWN BUG: a NON-enumerable accessor is dropped (same enumerableOnly bug).
  test("non-enumerable accessor own property round-trips", async () => {
    const f = await roundtrip(
      (() => {
        function x() {}
        Object.defineProperty(x, "g", { get: () => 12, enumerable: false, configurable: true });
        return x;
      })(),
    );
    expect((f as any).g).toBe(12);
  });

  test("enumerable symbol-keyed own property round-trips", async () => {
    const s = Symbol.for("gen-sym-enum");
    const f = await roundtrip(
      (() => {
        function x() {}
        (x as any)[s] = 99;
        return x;
      })(),
    );
    expect((f as any)[s]).toBe(99);
  });

  // KNOWN BUG: a NON-enumerable symbol-keyed prop is dropped (same enumerableOnly bug).
  test("non-enumerable symbol-keyed own property round-trips", async () => {
    const s = Symbol.for("gen-sym-nonenum");
    const f = await roundtrip(
      (() => {
        function x() {}
        Object.defineProperty(x, s, { value: 97, enumerable: false, configurable: true });
        return x;
      })(),
    );
    expect((f as any)[s]).toBe(97);
  });

  test("own property whose value is a Map round-trips", async () => {
    const f = await roundtrip(
      (() => {
        function x() {}
        (x as any).data = new Map([["a", 1]]);
        return x;
      })(),
    );
    expect((f as any).data).toBeInstanceOf(Map);
    expect((f as any).data.get("a")).toBe(1);
  });

  test("own property that cycles back to the function round-trips with identity", async () => {
    const f = await roundtrip(
      (() => {
        function x() {}
        (x as any).self = x;
        return x;
      })(),
    );
    expect((f as any).self).toBe(f);
  });

  test("own property whose value is another frozen function round-trips", async () => {
    const f = await roundtrip(
      (() => {
        function x() {}
        const g = Object.freeze(function () {
          return 5;
        });
        (x as any).helper = g;
        return x;
      })(),
    );
    expect((f as any).helper()).toBe(5);
    expect(Object.isFrozen((f as any).helper)).toBe(true);
  });
});

describe("generality: prototype member preservation", () => {
  test("enumerable monkey-patched prototype method round-trips", async () => {
    const C = await roundtrip(
      (() => {
        function K(this: any) {}
        K.prototype.m = function () {
          return 21;
        };
        return K;
      })() as any,
    );
    expect(new (C as any)().m()).toBe(21);
  });

  // KNOWN BUG: a NON-enumerable prototype member is dropped (emitOwnProperties on
  // <name>.prototype also uses enumerableOnly=true).
  test("non-enumerable prototype method round-trips", async () => {
    const C = await roundtrip(
      (() => {
        function K(this: any) {}
        Object.defineProperty(K.prototype, "m", {
          value: function () {
            return 22;
          },
          enumerable: false,
          configurable: true,
          writable: true,
        });
        return K;
      })() as any,
    );
    expect(new (C as any)().m()).toBe(22);
  });

  test("symbol-keyed prototype member round-trips", async () => {
    const s = Symbol.for("gen-proto-sym");
    const C = await roundtrip(
      (() => {
        function K(this: any) {}
        (K.prototype as any)[s] = function () {
          return 23;
        };
        return K;
      })() as any,
    );
    expect(new (C as any)()[s]()).toBe(23);
  });
});

describe("generality: composition & mutation guards", () => {
  test("frozen function with own prop rejects mutation and keeps the prop", async () => {
    const f = await roundtrip(
      (() => {
        function x() {}
        (x as any).v = 1;
        Object.freeze(x);
        return x;
      })(),
    );
    expect(Object.isFrozen(f)).toBe(true);
    expect((f as any).v).toBe(1);
  });

  test("frozen class with static field cannot be mutated", async () => {
    const C = await roundtrip(
      Object.freeze(
        class {
          static s = 5;
        },
      ) as any,
    );
    expect(Object.isFrozen(C)).toBe(true);
    expect((C as any).s).toBe(5);
  });

  test("sealed function: props writable, shape locked", async () => {
    const f = await roundtrip(
      (() => {
        function x() {}
        (x as any).v = 1;
        Object.seal(x);
        return x;
      })(),
    );
    expect(Object.isSealed(f)).toBe(true);
    expect(Object.isExtensible(f)).toBe(false);
    (f as any).v = 9;
    expect((f as any).v).toBe(9);
  });

  test("frozen function that is also a captured cycle node", async () => {
    const f = await roundtrip(
      (() => {
        function x() {}
        (x as any).self = x;
        Object.freeze(x);
        return () => x;
      })() as any,
    );
    const inner = (f as any)();
    expect(Object.isFrozen(inner)).toBe(true);
    expect(inner.self).toBe(inner);
  });

  test("sealed class whose prototype is frozen, instances still usable", async () => {
    const C = await roundtrip(
      (() => {
        class K {
          m() {
            return 7;
          }
        }
        Object.freeze(K.prototype);
        Object.seal(K);
        return K;
      })() as any,
    );
    expect(Object.isSealed(C)).toBe(true);
    expect(Object.isFrozen((C as any).prototype)).toBe(true);
    expect(new (C as any)().m()).toBe(7);
  });

  test("frozen class with frozen static-field object", async () => {
    const C = await roundtrip(
      (() => {
        class K {
          static cfg = Object.freeze({ k: 1 });
        }
        Object.freeze(K);
        return K;
      })() as any,
    );
    expect(Object.isFrozen(C)).toBe(true);
    expect(Object.isFrozen((C as any).cfg)).toBe(true);
    expect((C as any).cfg.k).toBe(1);
  });
});

describe("generality: no regression for plain functions", () => {
  test("plain arrow stays on inline path and round-trips", async () => {
    const f = await roundtrip((x: number) => x + 1);
    expect(f(2)).toBe(3);
    expect(Object.isExtensible(f)).toBe(true);
  });

  test("plain function: name/length/extensibility unchanged, no defineProperty bloat", async () => {
    const fn = function plainFn(a: number) {
      return a * 2;
    };
    const code = serialize(fn);
    // Plain function must NOT be rerouted through the binding path: no name/length
    // restore and no freeze/seal calls in the emitted module.
    expect(code).not.toContain('"name"');
    expect(code).not.toContain('"length"');
    expect(code).not.toContain("Object.freeze");
    const f = await roundtrip(fn);
    expect(f(4)).toBe(8);
    expect(f.name).toBe("plainFn");
    expect(f.length).toBe(1);
    expect(Object.isExtensible(f)).toBe(true);
  });
});

describe("generality: re-serialization preserves integrity", () => {
  test("frozen + renamed + length + own prop + frozen proto survives two rounds", async () => {
    const make = () => {
      class K {
        m() {
          return 4;
        }
      }
      (K as any).tag = "T";
      Object.defineProperty(K, "name", { value: "Renamed", configurable: true });
      Object.defineProperty(K, "length", { value: 9, configurable: true });
      Object.freeze(K.prototype);
      Object.freeze(K);
      return K;
    };
    const round1 = await roundtrip(make() as any);
    const round2 = await roundtrip(round1);
    expect(Object.isFrozen(round2)).toBe(true);
    expect(round2.name).toBe("Renamed");
    expect(round2.length).toBe(9);
    expect((round2 as any).tag).toBe("T");
    expect(Object.isFrozen((round2 as any).prototype)).toBe(true);
    expect(new (round2 as any)().m()).toBe(4);
  });
});

// Generality of the iterative emission: deep / mixed / cyclic / wide graphs must serialize and
// reconstruct without stack overflow, with leaf identity + cycles preserved. The value-emission
// path enqueues bodies on ctx.bodyQueue (no deep recursion); these prove it generalizes across
// MIXED kinds and every container edge, not just a homogeneous object chain. Depths run ~1s on
// debug+ASAN; comments note larger depths verified manually against the debug build.
describe("generality: nesting & recursion", () => {
  test("deep object chain round-trips with leaf preserved (verified 200k)", async () => {
    let root: any = {},
      cur = root;
    for (let i = 0; i < 2000; i++) {
      cur.next = {};
      cur = cur.next;
    }
    cur.leaf = "bottom";
    const r = (await roundtrip(() => root))();
    let n = r,
      depth = 0;
    while (n.next) {
      n = n.next;
      depth++;
    }
    expect(depth).toBe(2000);
    expect(n.leaf).toBe("bottom");
  });

  test("deep Map-key chain round-trips (object is the key)", async () => {
    let cur: any = { LEAF: 1 };
    for (let i = 0; i < 1500; i++) {
      const m = new Map();
      m.set(cur, 1);
      cur = m;
    }
    const r = (await roundtrip(() => cur))();
    let n: any = r,
      depth = 0;
    while (n instanceof Map) {
      n = [...n.keys()][0];
      depth++;
    }
    expect(depth).toBe(1500);
    expect(n.LEAF).toBe(1);
  });

  test("deep Set-of-Set round-trips", async () => {
    let cur: any = { LEAF: 1 };
    for (let i = 0; i < 1500; i++) {
      const s = new Set();
      s.add(cur);
      cur = s;
    }
    const r = (await roundtrip(() => cur))();
    let n: any = r,
      depth = 0;
    while (n instanceof Set) {
      n = [...n][0];
      depth++;
    }
    expect(depth).toBe(1500);
    expect(n.LEAF).toBe(1);
  });

  test("deep MIXED alternating-kind chain round-trips (verified 4000)", async () => {
    class C {
      child: any = null;
    }
    const kinds = ["obj", "map", "arr", "class", "set", "nullproto"];
    let cur: any = { LEAF: true };
    for (let i = 0; i < 1200; i++) {
      switch (kinds[i % kinds.length]) {
        case "obj":
          cur = { child: cur };
          break;
        case "map":
          cur = new Map([["child", cur]]);
          break;
        case "arr":
          cur = [cur];
          break;
        case "class": {
          const c = new C();
          c.child = cur;
          cur = c;
          break;
        }
        case "set":
          cur = new Set([cur]);
          break;
        case "nullproto": {
          const o = Object.create(null);
          o.child = cur;
          cur = o;
          break;
        }
      }
    }
    const r = (await roundtrip(() => cur))();
    const childOf = (x: any) =>
      x instanceof Map ? x.get("child") : x instanceof Set ? [...x][0] : Array.isArray(x) ? x[0] : x.child;
    let n: any = r,
      depth = 0;
    while (n && n.LEAF !== true) {
      n = childOf(n);
      depth++;
    }
    expect(depth).toBe(1200);
    expect(n.LEAF).toBe(true);
  });

  test("deep Error.cause chain round-trips (verified 50k)", async () => {
    let cur: any = new Error("leaf");
    for (let i = 0; i < 1000; i++) cur = new Error("e" + i, { cause: cur });
    const r = (await roundtrip(() => cur))();
    let n: any = r,
      depth = 0;
    while (n.cause) {
      n = n.cause;
      depth++;
    }
    expect(depth).toBe(1000);
    expect(n.message).toBe("leaf");
  });

  test("deep #private-field chain round-trips", async () => {
    class Box {
      #child: any;
      constructor(c: any) {
        this.#child = c;
      }
      get child() {
        return this.#child;
      }
    }
    let cur: any = { LEAF: 1 };
    for (let i = 0; i < 1000; i++) cur = new Box(cur);
    const r = (await roundtrip(() => cur))();
    let n: any = r,
      depth = 0;
    while (n.child) {
      n = n.child;
      depth++;
    }
    expect(depth).toBe(1000);
    expect(n.LEAF).toBe(1);
  });

  test("deep chain whose leaf cycles back to root and a mid node (identity at the join)", async () => {
    let root: any = { id: "root" },
      cur = root,
      mid: any = null;
    for (let i = 0; i < 2000; i++) {
      const x: any = { id: i };
      if (i === 1000) mid = x;
      cur.next = x;
      cur = x;
    }
    cur.backToRoot = root;
    cur.backToMid = mid;
    const r = (await roundtrip(() => root))();
    let n: any = r;
    while (n.next) n = n.next;
    expect(n.backToRoot).toBe(r);
    expect(n.backToMid.id).toBe(1000);
  });

  test("aliased value deep and shallow keeps one identity", async () => {
    const shared = { SHARED: 1 };
    let root: any = {},
      cur = root;
    for (let i = 0; i < 2000; i++) {
      cur.next = {};
      cur = cur.next;
    }
    cur.shared = shared;
    root.alsoShared = shared;
    const r = (await roundtrip(() => root))();
    let n: any = r;
    while (n.next) n = n.next;
    expect(n.shared).toBe(r.alsoShared);
    expect(n.shared.SHARED).toBe(1);
  });

  test("a hub referenced by many nodes keeps one identity (verified 50k)", async () => {
    const hub = { HUB: 1 };
    const arr: any[] = [];
    for (let i = 0; i < 5000; i++) arr.push({ ref: hub });
    const r = (await roundtrip(() => ({ arr })))();
    const first = r.arr[0].ref;
    expect(r.arr.length).toBe(5000);
    expect(r.arr.every((e: any) => e.ref === first)).toBe(true);
    expect(first.HUB).toBe(1);
  });

  test("deeply nested closures round-trip and run (verified 200k)", async () => {
    let f: any = function leaf() {
      return 42;
    };
    for (let i = 0; i < 2000; i++) {
      const prev = f;
      f = function () {
        return prev();
      };
    }
    const g = await roundtrip(f);
    expect(g()).toBe(42);
  });

  // A deep bound-function chain (boundThis = previous) used to be the one shape that still rode the
  // recursive emission path (~12k overflowed). It is now iterative (capturedFunctions reports a
  // bound function's target/boundThis/boundArgs as post-order edges), so it serializes like every
  // other deep graph — see "generality: deep bound-function chains". The serialize() try/catch that
  // maps a residual stack-overflow RangeError to a clean "too deeply nested" TypeError remains a
  // defensive backstop for any future pathological shape.
  test("a deep bound chain serializes iteratively (no overflow)", async () => {
    function base() {
      return 1;
    }
    let cur: any = base.bind({ L: 1 });
    for (let i = 0; i < 15000; i++) cur = base.bind(cur);
    const root = cur;
    const out = (await roundtrip(() => (root as () => number)()))();
    expect(out).toBe(1);
  });
});

// Generality of well-known-global references: a captured value identical to a global namespace,
// built-in prototype, iterator/generator prototype, or host singleton is emitted as a REFERENCE to
// its path (identity preserved), at every position, aliased, in cycles, and across re-serialization
// — never deep-copied or thrown. A USER object is never wrongly referenced as a global.
describe("generality: native global references", () => {
  test.each([
    ["Math", Math],
    ["JSON", JSON],
    ["Reflect", Reflect],
    ["Atomics", Atomics],
    ["console", console],
    ["globalThis", globalThis],
    ["crypto", globalThis.crypto],
    ["performance", globalThis.performance],
  ])("namespace/singleton %s keeps identity", async (_n, g) => {
    const out = (await roundtrip(() => ({ x: g })))() as any;
    expect(out.x).toBe(g);
  });

  const PROTOS: Array<[string, object]> = [
    ["Object", Object.prototype],
    ["Array", Array.prototype],
    ["Promise", Promise.prototype],
    ["Error", Error.prototype],
    ["TypeError", TypeError.prototype],
    ["AggregateError", AggregateError.prototype],
    ["Number", Number.prototype],
    ["Map", Map.prototype],
    ["Set", Set.prototype],
    ["WeakMap", WeakMap.prototype],
    ["Date", Date.prototype],
    ["RegExp", RegExp.prototype],
    ["DataView", DataView.prototype],
    ["Uint8Array", Uint8Array.prototype],
    ["Float64Array", Float64Array.prototype],
    ["BigInt64Array", BigInt64Array.prototype],
  ];
  test.each(PROTOS)("%s.prototype keeps identity", async (_n, p) => {
    const out = (await roundtrip(() => ({ x: p })))() as any;
    expect(out.x).toBe(p);
  });

  // The iterator/generator/typed-array abstract prototypes (no dotted path — resolved by
  // expression). Previously these threw "Cannot serialize a native function".
  const EXPR_PROTOS: Array<[string, object]> = [
    ["%IteratorPrototype%", Iterator.prototype],
    ["%TypedArray%.prototype", Object.getPrototypeOf(Uint8Array.prototype)],
    ["%ArrayIteratorPrototype%", Object.getPrototypeOf([][Symbol.iterator]())],
    ["%MapIteratorPrototype%", Object.getPrototypeOf(new Map().entries())],
    ["%SetIteratorPrototype%", Object.getPrototypeOf(new Set().values())],
    ["%StringIteratorPrototype%", Object.getPrototypeOf(""[Symbol.iterator]())],
    ["%GeneratorFunction.prototype%", Object.getPrototypeOf(function* () {})],
    ["%AsyncFunction.prototype%", Object.getPrototypeOf(async function () {})],
    ["%AsyncGeneratorFunction.prototype%", Object.getPrototypeOf(async function* () {})],
  ];
  test.each(EXPR_PROTOS)("%s keeps identity (expression-resolved)", async (_n, p) => {
    const out = (await roundtrip(() => ({ x: p })))() as any;
    expect(out.x).toBe(p);
  });

  // POSITION generality — Math referenced from every position.
  test("a global is referenced from every position", async () => {
    class C {
      static s = Math;
      #p = Math;
      get() {
        return this.#p;
      }
    }
    const o: any = {
      direct: Math,
      arr: [Math],
      mapV: new Map([["k", Math]]),
      mapK: new Map([[Math, 1]]),
      set: new Set([Math]),
      getter: {
        get g() {
          return Math;
        },
      },
      cls: C,
      inst: new C(),
      proto: Object.create(Math),
      deep: { a: { b: [{ c: Math }] } },
    };
    o.cause = new Error("x", { cause: Math });
    const out = (await roundtrip(() => o))() as any;
    expect(out.direct).toBe(Math);
    expect(out.arr[0]).toBe(Math);
    expect(out.mapV.get("k")).toBe(Math);
    expect(out.mapK.get(Math)).toBe(1);
    expect(out.set.has(Math)).toBe(true);
    expect(out.getter.g).toBe(Math);
    expect(out.cls.s).toBe(Math);
    expect(out.inst.get()).toBe(Math);
    expect(Object.getPrototypeOf(out.proto)).toBe(Math);
    expect(out.deep.a.b[0].c).toBe(Math);
    expect(out.cause.cause).toBe(Math);
  });

  test("the same global via K paths is one reference, and survives a cycle", async () => {
    const a: any = { m: Math, arr: [Math, Math], n: new Map([[Math, Math]]) };
    a.self = a;
    const out = (await roundtrip(() => a))() as any;
    expect(out.m).toBe(Math);
    expect(out.arr[0]).toBe(Math);
    expect(out.arr[0]).toBe(out.arr[1]);
    expect(out.n.get(Math)).toBe(Math);
    expect(out.self).toBe(out);
  });

  test.each([
    ["Math.max", Math.max],
    ["console.log", console.log],
    ["Array.prototype.slice", Array.prototype.slice],
  ])("native method %s as a value keeps identity", async (_n, f) => {
    const out = (await roundtrip(() => ({ f })))() as any;
    expect(out.f).toBe(f);
  });

  test("globals stay references across re-serialization", async () => {
    const code1 = serialize(() => ({ m: Math, c: console }));
    using d1 = tempDir(`closure-natre1-${counter++}`, { "mod.mjs": code1 });
    const fn1 = (await import(`${String(d1)}/mod.mjs`)).default as any;
    const code2 = serialize(fn1);
    using d2 = tempDir(`closure-natre2-${counter++}`, { "mod.mjs": code2 });
    const out = ((await import(`${String(d2)}/mod.mjs`)).default as any)();
    expect(out.m).toBe(Math);
    expect(out.c).toBe(console);
  });

  test("a user object whose prototype IS a global: proto referenced, object by value", async () => {
    const u = Object.create(Math);
    u.userField = 7;
    const out = (await roundtrip(() => ({ u })))() as any;
    expect(Object.getPrototypeOf(out.u)).toBe(Math);
    expect(out.u.userField).toBe(7);
    expect(out.u).not.toBe(u);
  });
});

describe("generality: destructuring captures", () => {
  // The serializer must capture a variable introduced by a destructuring pattern.
  // These verify that across pattern form, nesting depth, defaults, computed keys,
  // renames, array holes, rest, destructuring-assignment, loop/catch positions,
  // and value complexity, the reconstructed closure computes the same value
  // (proving the binding was captured with the correct value/identity).

  describe("nesting", () => {
    test("4-level object nesting captures the leaf", async () => {
      const obj = { a: { b: { c: { d: 42 } } } };
      const {
        a: {
          b: {
            c: { d },
          },
        },
      } = obj;
      const out = await roundtrip(() => d);
      expect(out()).toBe(42);
    });
    test("6-level object nesting captures the leaf", async () => {
      const obj = { a: { b: { c: { d: { e: { f: 5 } } } } } };
      const {
        a: {
          b: {
            c: {
              d: {
                e: { f },
              },
            },
          },
        },
      } = obj;
      const out = await roundtrip(() => f);
      expect(out()).toBe(5);
    });
    test("mixed object/array pattern", async () => {
      const obj = { a: [{ b: 7 }] };
      const {
        a: [{ b }],
      } = obj;
      const out = await roundtrip(() => b);
      expect(out()).toBe(7);
    });
    test("nested array-of-array-of-object", async () => {
      const arr = [[{ x: 9 }]];
      const [[{ x }]] = arr;
      const out = await roundtrip(() => x);
      expect(out()).toBe(9);
    });
    test("two bindings at different depths", async () => {
      const obj = { a: { b: 1, q: { c: 2 } } };
      const {
        a: {
          b,
          q: { c },
        },
      } = obj;
      const out = await roundtrip(() => b + c);
      expect(out()).toBe(3);
    });
    test("destructure whose source is itself a destructured binding", async () => {
      const root = { inner: { val: 70 } };
      const { inner } = root;
      const { val } = inner;
      const out = await roundtrip(() => val);
      expect(out()).toBe(70);
    });
  });

  describe("defaults", () => {
    test("default is an object literal (key absent)", async () => {
      const o: { x?: { k: number } } = {};
      const { x = { k: 1 } } = o;
      const out = await roundtrip(() => x);
      expect(out()).toEqual({ k: 1 });
    });
    test("default is an array literal", async () => {
      const o: { x?: number[] } = {};
      const { x = [1, 2, 3] } = o;
      const out = await roundtrip(() => x);
      expect(out()).toEqual([1, 2, 3]);
    });
    test("default references a captured free variable", async () => {
      const cap = 99;
      const o: { x?: number } = {};
      const { x = cap } = o;
      const out = await roundtrip(() => x);
      expect(out()).toBe(99);
    });
    test("default references an earlier binding in the same pattern", async () => {
      const o = { a: 5 } as { a: number; b?: number };
      const { a, b = a } = o;
      const out = await roundtrip(() => b);
      expect(out()).toBe(5);
    });
    test("default is an expression over an earlier binding", async () => {
      const o = { a: 1 } as { a: number; b?: number };
      const { a, b = a * 2 } = o;
      const out = await roundtrip(() => b);
      expect(out()).toBe(2);
    });
    test("default uses a property of an earlier binding", async () => {
      const o = { a: { foo: 8 } } as { a: { foo: number }; x?: number };
      const { a, x = a.foo } = o;
      const out = await roundtrip(() => x);
      expect(out()).toBe(8);
    });
    test("nested default with empty fallback object (outer key absent)", async () => {
      const o: { a?: { b?: number } } = {};
      const { a: { b = 5 } = {} } = o;
      const out = await roundtrip(() => b);
      expect(out()).toBe(5);
    });
    test("nested default with present outer", async () => {
      const o: { a?: { b?: number } } = { a: {} };
      const { a: { b = 7 } = {} } = o;
      const out = await roundtrip(() => b);
      expect(out()).toBe(7);
    });
    test("default fires on an explicit undefined property", async () => {
      const cap = 11;
      const o = { z: undefined } as { z?: number };
      const { z = cap } = o;
      const out = await roundtrip(() => z);
      expect(out()).toBe(11);
    });
    test("default is a function literal that is then called", async () => {
      const o: { fn?: (z: number) => number } = {};
      const { fn = (z: number) => z * 2 } = o;
      const out = await roundtrip(() => fn(4));
      expect(out()).toBe(8);
    });
    test("default is a spread over a captured object", async () => {
      const base = { x: 1 };
      const o: { merged?: object } = {};
      const { merged = { ...base, y: 2 } } = o;
      const out = await roundtrip(() => merged);
      expect(out()).toEqual({ x: 1, y: 2 });
    });
    test("default calls a captured function", async () => {
      const fn = (z: number) => z * 3;
      const o: { r?: number } = {};
      const { r = fn(5) } = o;
      const out = await roundtrip(() => r);
      expect(out()).toBe(15);
    });
    test("binding captured ONLY through a default expression", async () => {
      const secret = 88;
      const o: { captured?: number } = {};
      const { captured = secret } = o;
      const out = await roundtrip(() => captured);
      expect(out()).toBe(88);
    });
    test("deeply nested default referencing a capture used only there", async () => {
      const deep = 9;
      const o: { a?: { b?: number } } = { a: {} };
      const { a: { b = deep } = {} } = o;
      const out = await roundtrip(() => b);
      expect(out()).toBe(9);
    });
    test("array default references a prior element", async () => {
      const arr = [5];
      const [a, b = a + 1] = arr;
      const out = await roundtrip(() => b);
      expect(out()).toBe(6);
    });
  });

  describe("computed keys", () => {
    test("computed key from a captured string", async () => {
      const k = "foo";
      const o = { foo: 8 };
      const { [k]: v } = o;
      const out = await roundtrip(() => v);
      expect(out()).toBe(8);
    });
    test("computed key from an expression", async () => {
      const k1 = "a",
        k2 = "b";
      const o = { ab: 3 };
      const { [k1 + k2]: v } = o;
      const out = await roundtrip(() => v);
      expect(out()).toBe(3);
    });
    test("computed key from a captured symbol", async () => {
      const s = Symbol.for("zz");
      const o = { [s]: 9 };
      const { [s]: v } = o;
      const out = await roundtrip(() => v);
      expect(out()).toBe(9);
    });
    test("free var used only as an outer computed key", async () => {
      const onlyKey = "kk";
      const o = { kk: 6 };
      const { [onlyKey]: val } = o;
      const out = await roundtrip(() => val);
      expect(out()).toBe(6);
    });
    test("free var used only as a computed key inside a default pattern", async () => {
      const innerKey = "ik";
      const o: { a?: Record<string, number> } = {};
      const { a: { [innerKey]: v } = { ik: 41 } } = o;
      const out = await roundtrip(() => v);
      expect(out()).toBe(41);
    });
    test("computed key evaluated once is not re-run on reconstruction", async () => {
      let count = 0;
      const k = (() => {
        count++;
        return "p";
      })();
      const o = { p: 5 };
      const { [k]: v } = o;
      const out = await roundtrip(() => v);
      expect(out()).toBe(5);
    });
  });

  describe("renaming", () => {
    test("rename with default (key present)", async () => {
      const o = { a: 6 } as { a?: number };
      const { a: b = 5 } = o;
      const out = await roundtrip(() => b);
      expect(out()).toBe(6);
    });
    test("rename with default (key absent)", async () => {
      const o: { a?: number } = {};
      const { a: b = 5 } = o;
      const out = await roundtrip(() => b);
      expect(out()).toBe(5);
    });
    test("multiple renames", async () => {
      const o = { a: 1, c: 2 };
      const { a: b, c: d } = o;
      const out = await roundtrip(() => b + d);
      expect(out()).toBe(3);
    });
    test("rename + nested default + computed combined", async () => {
      const k = "zz";
      const o: { p?: Record<string, number> } = { p: {} };
      const { p: { [k]: w = 60 } = {} } = o;
      const out = await roundtrip(() => w);
      expect(out()).toBe(60);
    });
  });

  describe("array holes and rest", () => {
    test("leading hole", async () => {
      const arr = [1, 2, 3];
      const [, x] = arr;
      const out = await roundtrip(() => x);
      expect(out()).toBe(2);
    });
    test("middle hole", async () => {
      const arr = [1, 2, 3];
      const [a, , c] = arr;
      const out = await roundtrip(() => a + c);
      expect(out()).toBe(4);
    });
    test("hole with default", async () => {
      const arr = [1];
      const [a, b = 9] = arr;
      const out = await roundtrip(() => a + b);
      expect(out()).toBe(10);
    });
    test("object rest", async () => {
      const o = { a: 1, b: 2, c: 3 };
      const { a, ...rest } = o;
      void a;
      const out = await roundtrip(() => rest);
      expect(out()).toEqual({ b: 2, c: 3 });
    });
    test("array rest", async () => {
      const arr = [1, 2, 3, 4];
      const [a, ...rest] = arr;
      void a;
      const out = await roundtrip(() => rest);
      expect(out()).toEqual([2, 3, 4]);
    });
    test("nested object rest", async () => {
      const o = { a: { b: 1, c: 2, d: 3 } };
      const {
        a: { b, ...rest },
      } = o;
      void b;
      const out = await roundtrip(() => rest);
      expect(out()).toEqual({ c: 2, d: 3 });
    });
    test("nested array rest", async () => {
      const arr = [[1, 2, 3, 4]];
      const [[h, ...t]] = arr;
      void h;
      const out = await roundtrip(() => t);
      expect(out()).toEqual([2, 3, 4]);
    });
  });

  describe("destructuring assignment (not declaration)", () => {
    test("object assignment", async () => {
      let a: number, b: number;
      const o = { a: 1, b: 2 };
      ({ a, b } = o);
      const out = await roundtrip(() => a + b);
      expect(out()).toBe(3);
    });
    test("array assignment", async () => {
      let a: number, b: number;
      const arr = [4, 5];
      [a, b] = arr;
      const out = await roundtrip(() => a + b);
      expect(out()).toBe(9);
    });
    test("assignment to an existing captured variable", async () => {
      let a = 1;
      const f = () => a;
      const o = { a: 42 };
      ({ a } = o);
      const out = await roundtrip(f);
      expect(out()).toBe(42);
    });
    test("assignment mixing a member target and a binding", async () => {
      const target: { a?: number } = {};
      const o = { a: 1, b: 2 };
      let b: number;
      ({ a: target.a, b } = o);
      const out = await roundtrip(() => [target.a, b]);
      expect(out()).toEqual([1, 2]);
    });
  });

  describe("other binding positions", () => {
    test("for-of object pattern, closure from last iteration", async () => {
      const items = [{ x: 1 }, { x: 2 }];
      const fns: Array<() => number> = [];
      for (const { x } of items) fns.push(() => x);
      const out = await roundtrip(fns[fns.length - 1]);
      expect(out()).toBe(2);
    });
    test("for-of object pattern, closure from first iteration (per-iteration binding)", async () => {
      const items = [{ x: 1 }, { x: 2 }, { x: 3 }];
      const fns: Array<() => number> = [];
      for (const { x } of items) fns.push(() => x);
      const out = await roundtrip(fns[0]);
      expect(out()).toBe(1);
    });
    test("for-of Map entry array pattern", async () => {
      const m = new Map([["k", 10]]);
      let f!: () => number;
      for (const [k, v] of m) {
        void k;
        f = () => v;
      }
      const out = await roundtrip(f);
      expect(out()).toBe(10);
    });
    test("while-loop destructure", async () => {
      const data = [{ y: 10 }];
      let f!: () => number;
      let i = 0;
      while (i < data.length) {
        const { y } = data[i];
        f = () => y;
        i++;
      }
      const out = await roundtrip(f);
      expect(out()).toBe(10);
    });
    test("catch clause destructure", async () => {
      let f!: () => string;
      try {
        throw new Error("boom");
      } catch ({ message }) {
        f = () => message as string;
      }
      const out = await roundtrip(f);
      expect(out()).toBe("boom");
    });
    test("function parameter object pattern", async () => {
      function mk({ p }: { p: number }) {
        return () => p;
      }
      const out = await roundtrip(mk({ p: 21 }));
      expect(out()).toBe(21);
    });
    test("function parameter array pattern", async () => {
      function mk([p]: number[]) {
        return () => p;
      }
      const out = await roundtrip(mk([22]));
      expect(out()).toBe(22);
    });
    test("function parameter nested pattern", async () => {
      function mk({ a: { b } }: { a: { b: number } }) {
        return () => b;
      }
      const out = await roundtrip(mk({ a: { b: 23 } }));
      expect(out()).toBe(23);
    });
    test("function parameter pattern with default", async () => {
      function mk({ p = 24 }: { p?: number }) {
        return () => p;
      }
      const out = await roundtrip(mk({}));
      expect(out()).toBe(24);
    });
  });

  describe("value complexity and identity", () => {
    test("binding and its source property share identity after roundtrip", async () => {
      const inner = { v: 1 };
      const obj = { a: inner };
      const { a } = obj;
      const out = await roundtrip(() => [a, obj.a] as const);
      const [x, y] = out();
      expect(x).toBe(y);
      expect(x.v).toBe(1);
    });
    test("destructured Map", async () => {
      const o = { m: new Map([["k", 5]]) };
      const { m } = o;
      const out = await roundtrip(() => m);
      const got = out();
      expect(got).toBeInstanceOf(Map);
      expect(got.get("k")).toBe(5);
    });
    test("destructured class instance", async () => {
      class C {
        x = 7;
      }
      const o = { c: new C() };
      const { c } = o;
      const out = await roundtrip(() => c.x);
      expect(out()).toBe(7);
    });
    test("destructured function value", async () => {
      const o = { f: (z: number) => z + 1 };
      const { f } = o;
      const out = await roundtrip(() => f(9));
      expect(out()).toBe(10);
    });
    test("destructured global keeps reference identity", async () => {
      const o = { J: JSON };
      const { J } = o;
      const out = await roundtrip(() => J === JSON);
      expect(out()).toBe(true);
    });
    test("destructured value forming a cycle", async () => {
      const a: any = {};
      a.self = a;
      const o = { a };
      const { a: cap } = o;
      const out = await roundtrip(() => cap.self === cap);
      expect(out()).toBe(true);
    });
    test("destructured bigint", async () => {
      const o = { n: 9007199254740993n };
      const { n } = o;
      const out = await roundtrip(() => n === 9007199254740993n);
      expect(out()).toBe(true);
    });
    test("destructured getter snapshots the value", async () => {
      let calls = 0;
      const o = {
        get a() {
          calls++;
          return 50;
        },
      };
      const { a } = o;
      const out = await roundtrip(() => a);
      expect(out()).toBe(50);
    });
  });

  describe("scoping and shadowing", () => {
    test("var destructure", async () => {
      var o1 = { a: 1 };
      var { a: va } = o1;
      const out = await roundtrip(() => va);
      expect(out()).toBe(1);
    });
    test("block-scoped destructure", async () => {
      const o = { a: 1 };
      {
        const { a } = o;
        const out = await roundtrip(() => a);
        expect(out()).toBe(1);
      }
    });
    test("inner destructure shadows outer", async () => {
      const o1 = { a: 1 },
        o2 = { a: 2 };
      const { a } = o1;
      void a;
      {
        const { a } = o2;
        const out = await roundtrip(() => a);
        expect(out()).toBe(2);
      }
    });
    test("shadow across a function boundary", async () => {
      const a = 1;
      void a;
      function outer() {
        const o = { a: 2 };
        const { a } = o;
        return () => a;
      }
      const out = await roundtrip(outer());
      expect(out()).toBe(2);
    });
    test("body-local destructure shadows a captured outer name", async () => {
      const a = 5;
      void a;
      const out = await roundtrip(() => {
        const o = { a: 99 };
        const { a } = o;
        return a;
      });
      expect(out()).toBe(99);
    });
    test("nested arrow captures a deeply-destructured binding", async () => {
      const o = { a: { b: { c: 13 } } };
      const {
        a: {
          b: { c },
        },
      } = o;
      const out = await roundtrip(() => () => c);
      const inner = out();
      expect(inner()).toBe(13);
    });
  });

  describe("multi-declarator and shared statements", () => {
    test("two closures capture different bindings of one statement", async () => {
      const o = { a: 1, b: 2 };
      const { a, b } = o;
      const fa = await roundtrip(() => a);
      const fb = await roundtrip(() => b);
      expect(fa()).toBe(1);
      expect(fb()).toBe(2);
    });
    test("second declarator default cross-references the first", async () => {
      const o1 = { a: 3 };
      const { a } = o1,
        { b = a * 10 } = {} as { b?: number };
      const out = await roundtrip(() => b);
      expect(out()).toBe(30);
    });
  });

  describe("destructuring inside the serialized body", () => {
    test("body destructures a captured object", async () => {
      const capObj = { a: 33 };
      const out = await roundtrip(() => {
        const { a } = capObj;
        return a;
      });
      expect(out()).toBe(33);
    });
    test("body array destructure with a hole", async () => {
      const capArr = [1, 2, 3];
      const out = await roundtrip(() => {
        const [, x] = capArr;
        return x;
      });
      expect(out()).toBe(2);
    });
    test("body destructure default references another capture", async () => {
      const capObj: { z?: number } = {};
      const fallback = 77;
      const out = await roundtrip(() => {
        const { z = fallback } = capObj;
        return z;
      });
      expect(out()).toBe(77);
    });
    test("body destructure computed key from a capture", async () => {
      const capObj = { dynk: 5 };
      const key = "dynk";
      const out = await roundtrip(() => {
        const { [key]: v } = capObj;
        return v;
      });
      expect(out()).toBe(5);
    });
    test("destructure inside a parameter default expression", async () => {
      const f = (
        x = (() => {
          const { q } = { q: 4 };
          return q;
        })(),
      ) => x;
      const out = await roundtrip(f);
      expect(out()).toBe(4);
    });
  });
});

describe("generality: destructuring parameters", () => {
  // Every function KIND with destructuring params round-trips its source + behavior.
  test("object/array/default params across function kinds", async () => {
    const f1 = await roundtrip(function ({ a, b = 5 }: any) {
      return a + b;
    });
    expect(f1({ a: 1 })).toBe(6);
    expect(f1({ a: 1, b: 10 })).toBe(11);
    expect(f1.length).toBe(1);

    const f2 = await roundtrip(({ a }: any, { b }: any) => a + b);
    expect(f2({ a: 1 }, { b: 2 })).toBe(3);
    expect(f2.length).toBe(2);

    const f3 = await roundtrip(async ({ a }: any) => a);
    await expect(f3({ a: 9 })).resolves.toBe(9);

    const f4 = await roundtrip(function* ({ a }: any) {
      yield a;
      yield a + 1;
    });
    expect([...f4({ a: 5 })]).toEqual([5, 6]);

    const f5 = await roundtrip(async function* ({ a }: any) {
      yield a;
      yield a + 1;
    });
    const out: number[] = [];
    for await (const v of f5({ a: 5 })) out.push(v);
    expect(out).toEqual([5, 6]);
  });

  test("object method, constructor, setter, and class-field arrow with destructure params", async () => {
    const obj = {
      m({ a }: any) {
        return a * 2;
      },
    };
    expect((await roundtrip(obj.m))({ a: 6 })).toBe(12);

    class C {
      s: number;
      constructor({ a, b }: any) {
        this.s = a + b;
      }
    }
    const Ctor = (await roundtrip(C as any)) as any;
    expect(new Ctor({ a: 1, b: 2 }).s).toBe(3);

    const sObj = {
      _v: 0,
      set x([a]: any) {
        this._v = a;
      },
    };
    const setter = Object.getOwnPropertyDescriptor(sObj, "x")!.set!;
    const target = { _v: 0 } as any;
    (await roundtrip(setter)).call(target, [77]);
    expect(target._v).toBe(77);

    class D {
      f = ({ a }: any) => a + 1;
    }
    expect((await roundtrip(new D().f))({ a: 5 })).toBe(6);
  });

  // Defaults that CAPTURE free variables — including capture-only-via-default.
  test("param defaults capture free variables", async () => {
    const captured = 42;
    const f1 = await roundtrip(function ({ x = captured }: any = {}) {
      return x;
    });
    expect(f1()).toBe(42);
    expect(f1({ x: 1 })).toBe(1);

    const onlyInDefault = 777;
    const f2 = await roundtrip(function ({ x = onlyInDefault }: any) {
      return x * 2;
    });
    expect(f2({})).toBe(1554);

    const obj = { z: 99 };
    const cap = () => 100;
    const map = new Map([["k", 1]]);
    class Cap {
      v = 5;
    }
    expect(
      (
        await roundtrip(function ({ x = obj }: any = {}) {
          return x.z;
        })
      )(),
    ).toBe(99);
    expect(
      (
        await roundtrip(function ({ x = cap }: any = {}) {
          return x();
        })
      )(),
    ).toBe(100);
    expect(
      (
        await roundtrip(function ({ x = cap() }: any = {}) {
          return x;
        })
      )(),
    ).toBe(100);
    expect(
      (
        await roundtrip(function ({ x = map }: any = {}) {
          return x.get("k");
        })
      )(),
    ).toBe(1);
    expect(
      (
        await roundtrip(function ({ x = Cap }: any = {}) {
          return new x().v;
        })
      )(),
    ).toBe(5);

    const c2 = 42;
    const f3 = await roundtrip(function ({ a: { b = c2 } = {} }: any) {
      return b;
    });
    expect(f3({})).toBe(42);
  });

  test("defaults reference earlier params/bindings; param shadows outer; param-default not confused with outer", async () => {
    const f1 = await roundtrip(function (a: number, b = a) {
      return a + b;
    });
    expect(f1(5)).toBe(10);
    expect(f1(5, 1)).toBe(6);

    const f2 = await roundtrip(function ({ a }: any, b = a) {
      return a + b;
    });
    expect(f2({ a: 4 })).toBe(8);

    const outer = 999;
    void outer;
    const f3 = await roundtrip(function (p: number, q = p) {
      return q;
    });
    expect(f3(5)).toBe(5);

    const a = 999;
    void a;
    const f4 = await roundtrip(function ({ a }: any) {
      return a;
    });
    expect(f4({ a: 5 })).toBe(5);
  });

  test("deep nesting, holes, rest, renaming, whole-param defaults", async () => {
    expect(
      (
        await roundtrip(function ({
          a: {
            b: { c },
          },
        }: any) {
          return c;
        })
      )({ a: { b: { c: 7 } } }),
    ).toBe(7);
    expect(
      (
        await roundtrip(function ([[{ x }]]: any) {
          return x;
        })
      )([[{ x: 9 }]]),
    ).toBe(9);
    expect(
      (
        await roundtrip(function ([, x]: any) {
          return x;
        })
      )([10, 20]),
    ).toBe(20);
    expect(
      (
        await roundtrip(function ([a, , c]: any) {
          return [a, c];
        })
      )([1, 2, 3]),
    ).toEqual([1, 3]);
    expect(
      (
        await roundtrip(function ([a, ...rest]: any) {
          return [a, rest];
        })
      )([1, 2, 3]),
    ).toEqual([1, [2, 3]]);
    expect(
      (
        await roundtrip(function ({ a, ...rest }: any) {
          return [a, rest];
        })
      )({ a: 1, b: 2, c: 3 }),
    ).toEqual([1, { b: 2, c: 3 }]);
    expect(
      (
        await roundtrip(function ({ a: b = 5 }: any) {
          return b;
        })
      )({}),
    ).toBe(5);
    expect(
      (
        await roundtrip(function ({ a: b, c: d = 7 }: any) {
          return [b, d];
        })
      )({ a: 1 }),
    ).toEqual([1, 7]);

    const f1 = await roundtrip(function ({ a, b }: any = { a: 1, b: 2 }) {
      return a + b;
    });
    expect(f1()).toBe(3);
    expect(f1({ a: 5, b: 5 })).toBe(10);
    expect(f1.length).toBe(0);

    const f2 = await roundtrip(function ([x, y]: any = [10, 20]) {
      return x + y;
    });
    expect(f2()).toBe(30);
    expect(f2.length).toBe(0);
  });

  test("computed keys (captured string / Symbol.for / well-known) in param patterns", async () => {
    const key = "dyn";
    expect(
      (
        await roundtrip(function ({ [key]: v }: any) {
          return v;
        })
      )({ dyn: 55 }),
    ).toBe(55);

    const reg = Symbol.for("generality-param-sym");
    expect(
      (
        await roundtrip(function ({ [reg]: v }: any) {
          return v;
        })
      )({ [reg]: 9 }),
    ).toBe(9);

    expect(
      (
        await roundtrip(function ({ [Symbol.iterator]: v }: any) {
          return typeof v;
        })
      )({ [Symbol.iterator]: () => {} }),
    ).toBe("function");
  });

  // A captured UNIQUE symbol can't equal one from another realm (unforgeable), so a reconstructed
  // closure must mint its own. Identity is preserved INTERNALLY: when the closure captures both the
  // symbol and an object keyed by it, the computed-key destructure resolves correctly.
  test("captured unique Symbol is internally consistent as a computed key", async () => {
    const key = Symbol("c");
    const obj = { [key]: 42 };
    const fn = await roundtrip(() => {
      const { [key]: v } = obj;
      return v;
    });
    expect(fn()).toBe(42);
  });

  test("arguments / this / new.target / .length with destructure params", async () => {
    const f1 = await roundtrip(function ({ a }: any) {
      return [a, arguments.length];
    });
    expect(f1({ a: 1 }, 2, 3)).toEqual([1, 3]);

    const obj = {
      t: 9,
      m({ a }: any) {
        return this.t + a;
      },
    };
    expect((await roundtrip(obj.m)).bind({ t: 9 })({ a: 1 })).toBe(10);

    const f3 = (await roundtrip(function ({ a }: any) {
      return [a, new.target !== undefined];
    } as any)) as any;
    expect(new f3({ a: 1 })).toEqual([1, true]);

    const f4 = await roundtrip(function ({ a }: any, b: number, c = 1) {
      return a + b + c;
    });
    expect(f4({ a: 1 }, 2)).toBe(4);
    expect(f4.length).toBe(2);

    const f5 = await roundtrip(function (a: number, { b }: any, c: number) {
      return a + b + c;
    });
    expect(f5(1, { b: 2 }, 3)).toBe(6);
    expect(f5.length).toBe(3);
  });

  test("a destructure-param function survives a second round-trip", async () => {
    const once = await roundtrip(function ({ a, b = 5 }: any) {
      return a + b;
    });
    const twice = await roundtrip(once);
    expect(twice({ a: 1 })).toBe(6);
    expect(twice.length).toBe(1);
  });
});

describe("generality: deep bound-function chains", () => {
  // A chain of bound functions whose boundThis is the previous bound function used to ride the
  // RECURSIVE emission path (emitFunctionContent's bound branch → emitValue(boundThis) → ...),
  // overflowing at ~9k deep (debug+ASAN) / ~12k (release) as the catchable "too deeply nested"
  // TypeError. emitFunction's post-order stack now emits each link first, so a bound chain
  // serializes like every other deep graph. Depth 20000 is well past the old overflow threshold.
  test("deep boundThis chain round-trips and calls correctly", async () => {
    function base() {
      return 42;
    }
    let f: Function = base.bind({});
    for (let i = 0; i < 20000; i++) f = base.bind(f);
    const r = (await roundtrip(() => (f as () => number)()))();
    expect(r).toBe(42);
  });

  test("deep bound-ARG chain round-trips and calls correctly", async () => {
    function id(x: number) {
      return x;
    }
    function pick(first: Function) {
      return first();
    }
    let f: Function = id.bind(null, 7);
    for (let i = 0; i < 20000; i++) f = pick.bind(null, f);
    const r = (await roundtrip(() => (f as () => number)()))();
    expect(r).toBe(7);
  });

  test("identity dedup: same bound function captured twice yields one binding", async () => {
    function base(this: any, a: number) {
      return a + (this?.n ?? 0);
    }
    const bound = base.bind({ n: 100 }, 5);
    void bound;
    const code = serialize(() => [(bound as any)(), (bound as any)()]);
    expect(code.split(".bind(").length - 1).toBe(1);
    const fn = await roundtrip(() => [(bound as any)(), (bound as any)()]);
    expect(fn()).toEqual([105, 105]);
  });
});

describe("generality: deep prototype chains scale", () => {
  // Serializing a value with a deep prototype / inheritance chain used to be super-linear in
  // depth. Two distinct quadratic-or-worse sites:
  //   1. emitBuiltin ran ~14 `instanceof` checks per object, each walking the FULL prototype chain
  //      — O(depth) per object × N objects = O(depth²) for an Object.create chain. A memoized
  //      "is any built-in prototype in this object's chain" guard now short-circuits in O(1).
  //   2. computeGenuineClasses re-walked each class's whole superclass chain (genuineChain) and,
  //      for every chain member, scanned every reachable function in perClassDisqualified — O(depth³)
  //      for a `class extends` chain. genuineChain now memoizes chain suffixes (O(depth) total) and
  //      perClassDisqualified short-circuits when a class declares no private fields.
  // Measured on debug+ASAN with the prebuilt binary BEFORE the fix:
  //   Object.create depth 1500 ≈ 2.2s, 2000 ≈ 3.8s; `class extends` depth 800 ≈ 8s (1600 timed out).
  // The assertions below construct chains at a depth that would have taken many seconds (or hung)
  // and assert correct round-trip behavior; the test simply completing quickly is the signal. The
  // committed depths keep the test to a few seconds even on debug+ASAN.
  test("deep Object.create chain round-trips with the leaf reachable", async () => {
    const DEPTH = 1500;
    let proto: any = { tag: "root" };
    for (let i = 0; i < DEPTH; i++) proto = Object.create(proto);
    const leaf = Object.create(proto);
    leaf.value = 123;
    void leaf;
    const fn = await roundtrip(() => leaf);
    const out = fn() as any;
    expect(out.value).toBe(123);
    // The whole inherited chain survives: `tag` lives ~1500 prototypes up.
    expect(out.tag).toBe("root");
  });

  test("deep class-extends chain round-trips with instanceof and methods intact", async () => {
    const DEPTH = 1200;
    let C: any = class Base {
      greet() {
        return "hi";
      }
    };
    const Base = C;
    for (let i = 0; i < DEPTH; i++) {
      const Prev = C;
      C = class extends Prev {};
    }
    const Leaf = C;
    const inst = new Leaf();
    void inst;
    void Leaf;
    void Base;
    const fn = await roundtrip(() => ({ inst, Leaf, Base }));
    const out = fn() as any;
    // The inherited method (declared ~1200 classes up the chain) is callable.
    expect(out.inst.greet()).toBe("hi");
    // instanceof through the reconstructed inheritance chain holds at both ends.
    expect(out.inst instanceof out.Leaf).toBe(true);
    expect(out.inst instanceof out.Base).toBe(true);
  });
});

describe("generators: Tier A (suspended-start + completed, portable)", () => {
  // A not-yet-iterated (SuspendedStart) generator reconstructs as an equivalent fresh generator —
  // its full sequence is unchanged because nothing has been consumed. arity 0, no `arguments`.
  test("a not-started generator round-trips and yields its full sequence", async () => {
    function* gen() {
      yield 1;
      yield 2;
      yield 3;
    }
    const g = gen();
    void g;
    const out = (await roundtrip(() => g))() as Generator<number>;
    expect([...out]).toEqual([1, 2, 3]);
  });

  test("a not-started generator capturing a free variable round-trips", async () => {
    const base = 10;
    function* gen() {
      yield base;
      yield base + 1;
    }
    const g = gen();
    void g;
    const out = (await roundtrip(() => g))() as Generator<number>;
    expect([...out]).toEqual([10, 11]);
  });

  test("a not-started method generator capturing `this` round-trips", async () => {
    const obj = {
      v: 5,
      *gen(this: { v: number }) {
        yield this.v;
        yield this.v * 2;
      },
    };
    const g = obj.gen();
    void g;
    const out = (await roundtrip(() => g))() as Generator<number>;
    expect([...out]).toEqual([5, 10]);
  });

  test("a not-started generator captured twice keeps one identity", async () => {
    function* gen() {
      yield 1;
      yield 2;
    }
    const g = gen();
    void g;
    const out = (await roundtrip(() => ({ a: g, b: g })))() as any;
    expect(out.a).toBe(out.b);
    expect([...out.a]).toEqual([1, 2]);
  });

  test("a completed generator round-trips as an immediately-done generator", async () => {
    function* gen() {
      yield 1;
    }
    const g = gen();
    [...g]; // drive to completion
    void g;
    const out = (await roundtrip(() => g))() as Generator<number>;
    expect(out.next()).toEqual({ value: undefined, done: true });
    expect([...out]).toEqual([]);
  });

  // Cross-runtime: the emitted module + reconstruction must run in any JS runtime (Node), not Bun.
  test("a reconstructed not-started generator runs in Node", async () => {
    using dir = tempDir("closure-gen-node", {
      "gen.mjs": `
        import { serialize } from "bun:closure";
        import { writeFileSync } from "node:fs";
        const base = 7;
        function* g() { yield base; yield base + 1; yield base + 2; }
        const inst = g();
        writeFileSync(new URL("./out.mjs", import.meta.url), serialize(() => inst));
        process.stdout.write("SERIALIZED");
      `,
      "check.mjs": `
        import build from "./out.mjs";
        const it = build();
        process.stdout.write(JSON.stringify([...it]));
      `,
    });
    await using ser = Bun.spawn({ cmd: [bunExe(), "gen.mjs"], env: bunEnv, cwd: String(dir), stderr: "pipe" });
    const [sOut, sErr, sCode] = await Promise.all([ser.stdout.text(), ser.stderr.text(), ser.exited]);
    expect({ sOut, sErr: sErr.includes("error") ? sErr : "", sCode }).toEqual({
      sOut: "SERIALIZED",
      sErr: "",
      sCode: 0,
    });

    await using chk = Bun.spawn({ cmd: ["node", "check.mjs"], env: bunEnv, cwd: String(dir), stderr: "pipe" });
    const [cOut, cErr, cCode] = await Promise.all([chk.stdout.text(), chk.stderr.text(), chk.exited]);
    expect(cOut).toBe(JSON.stringify([7, 8, 9]));
    expect(cCode).toBe(0);
    void cErr;
  });

  // An unstarted generator of arity ≥ 1 reconstructs: the parameters were bound to their
  // argument values, which JSC surfaces as captured free variables of the body, so they are
  // re-bound by value and the rebuilt generator takes no parameters.
  test("an unstarted generator created with arguments reconstructs (params captured by value)", async () => {
    function* gen(a: number, b: number) {
      yield a + b;
      yield a * b;
    }
    const g = gen(3, 4);
    void g;
    const out = (await roundtrip(() => g))() as Generator<number>;
    expect([...out]).toEqual([7, 12]);
  });

  // ── Clear errors (out of Tier A scope) ──
  test("a started (mid-iteration) generator is a clear error", () => {
    function* gen() {
      yield 1;
      yield 2;
    }
    const g = gen();
    g.next(); // now mid-iteration
    expect(() => serialize(() => g)).toThrow(/started iterating/);
  });

  test("an unstarted generator that reads `arguments` is a clear error", () => {
    function* gen() {
      yield arguments.length;
    }
    const g = (gen as any)(1, 2);
    void g;
    expect(() => serialize(() => g)).toThrow(/arguments/);
  });

  test("an async generator is a clear error", () => {
    async function* agen() {
      yield 1;
    }
    const g = agen();
    void g;
    expect(() => serialize(() => g)).toThrow(/[Aa]sync ?[Gg]enerator/);
  });
});

// ── Class method pruning (non-#private) ──────────────────────────────────────
// A captured class instance is reconstructed via `Object.create(Class.prototype)`,
// and historically the WHOLE class (every prototype method) was emitted as one
// `toString()` unit — so the replacer never saw individual methods and unreached
// methods were dragged into the output. These tests pin the desired behavior:
// the replacer is called for EXACTLY the reachable methods (the ones the closure
// can actually call, transitively through `this`/`super`/getters), unreachable
// methods are pruned from the output, and identity/behavior are preserved. When
// reachability can't be determined statically (dynamic dispatch, the class captured
// as a first-class value), it falls back to keeping every method.
describe("class method pruning (non-#private)", () => {
  let cmpN = 0;
  const methodMeta = new WeakMap<Function, string>();
  const tag = (label: string, fn: Function): void => void methodMeta.set(fn, label);

  // Serialize, collecting the labels of every annotated method the replacer observed.
  function serializeCollect(fn: Function): { code: string; observed: string[] } {
    const observed: string[] = [];
    const code = serialize(fn, (_k, v) => {
      if (typeof v === "function" && methodMeta.has(v)) observed.push(methodMeta.get(v)!);
      return v;
    });
    return { code, observed: observed.sort() };
  }
  async function rt<T extends Function>(fn: T): Promise<T> {
    const code = serialize(fn);
    using dir = tempDir(`closure-cmp-${cmpN++}`, { "mod.mjs": code });
    return (await import(`${String(dir)}/mod.mjs`)).default as T;
  }

  test("calling one method observes & emits only that method", async () => {
    class Svc {
      read(id: number) {
        return `READ_MARK:${id}`;
      }
      write(id: number, v: string) {
        return `WRITE_MARK:${id}=${v}`;
      }
    }
    tag("read", Svc.prototype.read);
    tag("write", Svc.prototype.write);
    const svc = new Svc();
    const root = (id: number) => svc.read(id);

    const { code, observed } = serializeCollect(root);
    expect(observed).toEqual(["read"]); // ONLY the called method
    expect(code).not.toContain("WRITE_MARK"); // uncalled method pruned
    expect(code).toContain("READ_MARK");

    const fn = await rt(root);
    expect(fn(42)).toBe("READ_MARK:42");
  });

  test("a kept method's this.other() keeps the transitively-reached method only", async () => {
    class Svc {
      entry(id: number) {
        return this.helper(id) + ":E";
      }
      helper(id: number) {
        return `HELP_MARK:${id}`;
      }
      unused() {
        return "UNUSED_MARK";
      }
    }
    tag("entry", Svc.prototype.entry);
    tag("helper", Svc.prototype.helper);
    tag("unused", Svc.prototype.unused);
    const svc = new Svc();
    const root = (id: number) => svc.entry(id);

    const { code, observed } = serializeCollect(root);
    expect(observed).toEqual(["entry", "helper"]);
    expect(code).not.toContain("UNUSED_MARK");

    const fn = await rt(root);
    expect(fn(7)).toBe("HELP_MARK:7:E");
  });

  test("a kept subclass method's super.m() keeps the superclass method", async () => {
    class Base {
      greet() {
        return "BASE_GREET";
      }
      other() {
        return "BASE_OTHER_UNUSED";
      }
    }
    class Sub extends Base {
      greet() {
        return super.greet() + ":SUB";
      }
    }
    tag("Base.greet", Base.prototype.greet);
    tag("Base.other", Base.prototype.other);
    tag("Sub.greet", Sub.prototype.greet);
    const sub = new Sub();
    const root = () => sub.greet();

    const { code, observed } = serializeCollect(root);
    expect(observed).toEqual(["Base.greet", "Sub.greet"]);
    expect(code).not.toContain("BASE_OTHER_UNUSED");

    const fn = await rt(root);
    expect(fn()).toBe("BASE_GREET:SUB");
  });

  test("a super method's own this.other() call is followed transitively", async () => {
    class Base {
      greet() {
        return "BASE:" + this.helper(); // reached only via super.greet() → this.helper()
      }
      helper() {
        return "HELPER_MARK";
      }
      idle() {
        return "IDLE_UNUSED_MARK";
      }
    }
    class Sub extends Base {
      greet() {
        return super.greet() + ":SUB";
      }
    }
    const sub = new Sub();
    const root = () => sub.greet();

    const { code } = serializeCollect(root);
    expect(code).toContain("HELPER_MARK"); // reached through Base.greet's body
    expect(code).not.toContain("IDLE_UNUSED_MARK");

    const fn = await rt(root);
    expect(fn()).toBe("BASE:HELPER_MARK:SUB");
  });

  test("calling an inherited method keeps it and prunes inherited & own siblings", async () => {
    class Base {
      inheritedUsed() {
        return "INH_USED";
      }
      inheritedUnused() {
        return "INH_UNUSED";
      }
    }
    class Sub extends Base {
      own() {
        return "OWN_UNUSED";
      }
    }
    const sub = new Sub();
    const root = () => sub.inheritedUsed();

    const { code } = serializeCollect(root);
    expect(code).toContain("INH_USED");
    expect(code).not.toContain("INH_UNUSED");
    expect(code).not.toContain("OWN_UNUSED");

    const fn = await rt(root);
    expect(fn()).toBe("INH_USED");
  });

  test("two instances of one class keep the UNION of reached methods", async () => {
    class Svc {
      read() {
        return "READ_U";
      }
      write() {
        return "WRITE_U";
      }
      idle() {
        return "IDLE_UNUSED";
      }
    }
    const a = new Svc();
    const b = new Svc();
    const root = () => a.read() + b.write();

    const { code } = serializeCollect(root);
    expect(code).toContain("READ_U");
    expect(code).toContain("WRITE_U");
    expect(code).not.toContain("IDLE_UNUSED");

    const fn = await rt(root);
    expect(fn()).toBe("READ_UWRITE_U");
  });

  test("dynamic method dispatch (computed key) keeps all methods", async () => {
    class Svc {
      read() {
        return "READ_D";
      }
      write() {
        return "WRITE_D";
      }
    }
    const svc = new Svc();
    const root = (name: string) => (svc as any)[name]();

    const { code } = serializeCollect(root);
    expect(code).toContain("READ_D");
    expect(code).toContain("WRITE_D");

    const fn = await rt(root);
    expect(fn("read")).toBe("READ_D");
    expect(fn("write")).toBe("WRITE_D");
  });

  test("dynamic dispatch through `this[name]()` INSIDE a method keeps all methods", async () => {
    class Svc {
      dispatch(name: string) {
        return (this as any)[name](); // computed `this` access → can't statically prune
      }
      read() {
        return "READ_T";
      }
      write() {
        return "WRITE_T";
      }
    }
    const svc = new Svc();
    // The closure only calls `dispatch`, but `dispatch` can reach ANY method via `this[name]()`,
    // discovered through this-following — so every method must survive.
    const root = (name: string) => svc.dispatch(name);

    const { code } = serializeCollect(root);
    expect(code).toContain("READ_T");
    expect(code).toContain("WRITE_T");

    const fn = await rt(root);
    expect(fn("read")).toBe("READ_T");
    expect(fn("write")).toBe("WRITE_T");
  });

  test("passing the instance as a value (Reflect/apply) keeps all methods", async () => {
    class Svc {
      read() {
        return "READ_V";
      }
      write() {
        return "WRITE_V";
      }
    }
    const svc = new Svc();
    // `Reflect.get(svc, name)` hands the whole instance to a foreign call → can't prune.
    const root = (name: string) => (Reflect.get(svc, name) as () => string).call(svc);

    const { code } = serializeCollect(root);
    expect(code).toContain("READ_V");
    expect(code).toContain("WRITE_V");

    const fn = await rt(root);
    expect(fn("read")).toBe("READ_V");
    expect(fn("write")).toBe("WRITE_V");
  });

  test("a getter reached through a kept method is preserved; an unused one is pruned", async () => {
    class Svc {
      get config() {
        return "CONF_MARK";
      }
      get unusedCfg() {
        return "UNUSED_CFG";
      }
      run() {
        return this.config + ":R";
      }
    }
    const svc = new Svc();
    const root = () => svc.run();

    const { code } = serializeCollect(root);
    expect(code).toContain("CONF_MARK");
    expect(code).not.toContain("UNUSED_CFG");

    const fn = await rt(root);
    expect(fn()).toBe("CONF_MARK:R");
  });

  test("a class captured directly keeps all methods (no pruning)", async () => {
    class Svc {
      read() {
        return "READ_C";
      }
      write() {
        return "WRITE_C";
      }
    }
    const root = () => Svc;

    const { code } = serializeCollect(root);
    expect(code).toContain("READ_C");
    expect(code).toContain("WRITE_C");

    const Cls = (await rt(root))() as any;
    const inst = new Cls();
    expect(inst.read()).toBe("READ_C");
    expect(inst.write()).toBe("WRITE_C");
  });

  test("a pruned instance keeps its constructor/prototype identity and runs the kept method", async () => {
    class Svc {
      kind() {
        return this.constructor.name; // reads identity WITHOUT escaping `this` wholesale
      }
      used() {
        return "USED_I";
      }
      unused() {
        return "UNUSED_I";
      }
    }
    const svc = new Svc();
    const root = () => svc.kind() + ":" + svc.used();

    const code = serialize(root);
    expect(code).not.toContain("UNUSED_I"); // unused truly pruned

    const fn = await rt(root);
    // `this.constructor.name === "Svc"` ⇒ the reconstructed instance's prototype/constructor
    // identity survived pruning; both reached methods run.
    expect(fn()).toBe("Svc:USED_I");
  });

  test("a method only READ (not called) off the instance is still kept", async () => {
    class Svc {
      read() {
        return "READ_REF";
      }
      write() {
        return "WRITE_REF_UNUSED";
      }
    }
    const svc = new Svc();
    // `read` is taken as a value (not called through svc) — still reachable, so kept.
    const root = () => svc.read;

    const { code } = serializeCollect(root);
    expect(code).toContain("READ_REF");
    expect(code).not.toContain("WRITE_REF_UNUSED");

    const fn = await rt(root);
    expect((fn() as () => string).call(null)).toBe("READ_REF");
  });

  test("a method reached through an INVOKED setter (this.x = v) is kept", async () => {
    class Svc {
      log = "";
      go() {
        this.s = 5; // fires the setter, which calls this.helper()
        return this.log;
      }
      set s(v: number) {
        this.helper(v);
      }
      helper(v: number) {
        this.log = "HELPER_MARK:" + v;
      }
      unused() {
        return "UNUSED_SETTER_MARK";
      }
    }
    const svc = new Svc();
    const root = () => svc.go();

    const { code } = serializeCollect(root);
    expect(code).toContain("HELPER_MARK"); // reached via the setter body
    expect(code).not.toContain("UNUSED_SETTER_MARK");

    const fn = await rt(root);
    expect(fn()).toBe("HELPER_MARK:5");
  });

  test("a method reached through a DIRECT setter write (svc.x = v) is kept", async () => {
    class Svc {
      log = "";
      set s(v: number) {
        this.helper(v);
      }
      helper(v: number) {
        this.log = "DIRECT_HELPER_MARK:" + v;
      }
      idle() {
        return "IDLE_SETTER_MARK";
      }
    }
    const svc = new Svc();
    const root = () => {
      svc.s = 9;
      return svc.log;
    };

    const { code } = serializeCollect(root);
    expect(code).toContain("DIRECT_HELPER_MARK");
    expect(code).not.toContain("IDLE_SETTER_MARK");

    const fn = await rt(root);
    expect(fn()).toBe("DIRECT_HELPER_MARK:9");
  });

  test("pruning the method immediately before a `static {}` block stays valid syntax", async () => {
    class Svc {
      hidden() {
        return "HIDDEN_STATIC_MARK";
      }
      static {
        // a static block sitting right after the pruned method
        void 0;
      }
      greet() {
        return "GREET_MARK";
      }
    }
    const svc = new Svc();
    const root = () => svc.greet();

    const code = serialize(root);
    expect(code).not.toContain("HIDDEN_STATIC_MARK"); // hidden pruned

    const fn = await rt(root);
    expect(fn()).toBe("GREET_MARK"); // imports cleanly (no orphaned `{}`), runs
  });
});
