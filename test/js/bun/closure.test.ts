import { test, expect, describe, beforeAll } from "bun:test";
import { serialize } from "bun:closure";
import { tempDir, bunExe, bunEnv } from "harness";
import { AsyncLocalStorage } from "node:async_hooks";
import { format as nodeUtilFormat } from "node:util";

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
});
