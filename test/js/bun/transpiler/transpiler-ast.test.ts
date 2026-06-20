import { describe, expect, test } from "bun:test";

// `new Bun.Transpiler().ast(code, loader?)` parses source and returns the AST as
// a tree of plain JS objects: `{ type, start, ...fields }`. Node kinds not yet
// mapped surface as `{ type: "Unsupported", node, start }` so a walk never throws.
const t = new Bun.Transpiler();
const ast = (code: string, loader?: string) => (t as any).ast(code, loader);

// Strip `start` offsets recursively so structural assertions stay readable.
function stripStart(node: any): any {
  if (Array.isArray(node)) return node.map(stripStart);
  if (node && typeof node === "object") {
    const out: any = {};
    for (const k of Object.keys(node)) {
      if (k === "start") continue;
      out[k] = stripStart(node[k]);
    }
    return out;
  }
  return node;
}

describe("Transpiler.ast", () => {
  test("returns a Program with a body array", () => {
    const a = ast("1;");
    expect(a.type).toBe("Program");
    expect(Array.isArray(a.body)).toBe(true);
    expect(a.body).toHaveLength(1);
    expect(a.body[0].type).toBe("ExpressionStatement");
  });

  test("member + call chains expose object/property/callee (method-call analysis)", () => {
    const a = ast("foo.bar(1, x)");
    expect(stripStart(a.body[0].expression)).toEqual({
      type: "CallExpression",
      callee: {
        type: "MemberExpression",
        object: { type: "Identifier", name: "foo" },
        property: { type: "Identifier", name: "bar" },
        computed: false,
      },
      arguments: [
        { type: "NumericLiteral", value: 1 },
        { type: "Identifier", name: "x" },
      ],
    });
  });

  test("computed member access is marked computed", () => {
    const a = ast("obj[key]");
    const m = a.body[0].expression;
    expect(m.type).toBe("MemberExpression");
    expect(m.computed).toBe(true);
    expect(m.property).toMatchObject({ type: "Identifier", name: "key" });
  });

  test("literals carry values", () => {
    expect(ast("42").body[0].expression).toMatchObject({ type: "NumericLiteral", value: 42 });
    expect(ast("true").body[0].expression).toMatchObject({ type: "BooleanLiteral", value: true });
    expect(ast("null").body[0].expression).toMatchObject({ type: "NullLiteral" });
    // A lone string statement is a directive; use a binding context for the literal.
    expect(ast(`const s = "héllo"`).body[0].declarations[0].init).toMatchObject({
      type: "StringLiteral",
      value: "héllo",
    });
  });

  test("binary and unary operators", () => {
    expect(ast("a + b * c").body[0].expression).toMatchObject({
      type: "BinaryExpression",
      operator: "+",
      left: { type: "Identifier", name: "a" },
      right: { type: "BinaryExpression", operator: "*" },
    });
    expect(ast("!x").body[0].expression).toMatchObject({ type: "UnaryExpression", operator: "!" });
  });

  test("variable declaration kinds and declarators", () => {
    for (const kind of ["var", "let", "const"]) {
      const decl = ast(`${kind} a = 1`).body[0];
      expect(decl).toMatchObject({
        type: "VariableDeclaration",
        kind,
        declarations: [{ type: "VariableDeclarator", id: { type: "Identifier", name: "a" } }],
      });
    }
  });

  test("functions: params, defaults, async, generator", () => {
    const a = ast("async function* g(x, y = 2) { return x }").body[0];
    expect(a).toMatchObject({
      type: "FunctionDeclaration",
      id: { type: "Identifier", name: "g" },
      async: true,
      generator: true,
      params: [
        { type: "Identifier", name: "x" },
        { type: "AssignmentPattern", left: { type: "Identifier", name: "y" }, right: { value: 2 } },
      ],
    });
    expect(a.body[0]).toMatchObject({ type: "ReturnStatement", argument: { type: "Identifier", name: "x" } });
  });

  test("arrow functions", () => {
    const a = ast("const f = (a, b) => a + b").body[0].declarations[0].init;
    expect(a).toMatchObject({
      type: "ArrowFunctionExpression",
      async: false,
      params: [{ name: "a" }, { name: "b" }],
    });
    expect(a.body[0]).toMatchObject({ type: "ReturnStatement", argument: { type: "BinaryExpression" } });
  });

  test("class: id, superClass, methods, fields, accessors, statics, privates", () => {
    const a = ast("class C extends B { #p = 2; m(x) { return this.#p } get v() { return 1 } static s = 3 }").body[0];
    expect(a.type).toBe("ClassDeclaration");
    expect(a.id).toMatchObject({ type: "Identifier", name: "C" });
    expect(a.superClass).toMatchObject({ type: "Identifier", name: "B" });
    const members = a.body.body;
    expect(a.body.type).toBe("ClassBody");

    expect(members[0]).toMatchObject({
      type: "PropertyDefinition",
      key: { type: "PrivateIdentifier", name: "#p" },
      kind: "field",
      static: false,
      value: { type: "NumericLiteral", value: 2 },
    });
    expect(members[1]).toMatchObject({
      type: "MethodDefinition",
      key: { type: "StringLiteral", value: "m" },
      kind: "method",
      value: { type: "FunctionExpression" },
    });
    expect(members[2]).toMatchObject({ type: "MethodDefinition", kind: "get", key: { value: "v" } });
    expect(members[3]).toMatchObject({ type: "PropertyDefinition", kind: "field", static: true, key: { value: "s" } });
  });

  test("object expression properties", () => {
    const a = ast("({ x: 1, y, ...rest })").body[0].expression;
    expect(a.type).toBe("ObjectExpression");
    expect(a.properties[0]).toMatchObject({ type: "Property", key: { value: "x" }, value: { value: 1 } });
    expect(a.properties[1]).toMatchObject({ type: "Property", shorthand: true });
    expect(a.properties[2]).toMatchObject({ type: "SpreadElement", argument: { name: "rest" } });
  });

  test("TypeScript input parses (types are erased by the parser)", () => {
    // Bun's parser strips TS types; we still get a valid JS-level AST.
    const a = ast("function f(a: number): string { return String(a) }", "ts").body[0];
    expect(a).toMatchObject({
      type: "FunctionDeclaration",
      id: { name: "f" },
      params: [{ type: "Identifier", name: "a" }],
    });
  });

  test("unmapped node kinds surface as Unsupported, never throw", () => {
    const a = ast("`tpl ${x}`").body[0].expression;
    expect(a.type).toBe("Unsupported");
    expect(typeof a.node).toBe("string");
  });

  test("start offsets point into the source", () => {
    const a = ast("  foo");
    expect(a.body[0].expression).toMatchObject({ type: "Identifier", name: "foo", start: 2 });
  });

  test("parse errors throw", () => {
    expect(() => ast("const = ;")).toThrow();
  });

  test("walking the tree collects called method names", () => {
    // Demonstrates the static-analysis use case: which methods are called.
    const a = ast("a.foo(); b.bar(); a.foo(); c[d]()");
    const called: string[] = [];
    const walk = (n: any) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== "object") return;
      if (n.type === "CallExpression" && n.callee?.type === "MemberExpression" && !n.callee.computed) {
        called.push(n.callee.property.name);
      }
      for (const k of Object.keys(n)) walk(n[k]);
    };
    walk(a);
    expect(called.sort()).toEqual(["bar", "foo", "foo"]);
  });
});
