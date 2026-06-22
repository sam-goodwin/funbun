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

  // Source-position fields used by AST-driven source rewriters (e.g. the closure serializer):
  // a field initializer's text span, a static block's closing brace, the class body close, and
  // a function body's opening brace. All are byte offsets into the source.
  test("class members expose initializer span, static-block close, class close, and fn body brace", () => {
    const src = "class C { x = (1, 2); m() { return 0 } static { foo() } }";
    const a = ast(src).body[0];
    const members = a.body.body;
    // `initStart`..`initEnd` brackets the initializer text just past `=` (incl. grouping parens).
    const field = members[0];
    expect(src.slice(field.initStart, field.initEnd)).toBe("(1, 2)");
    // A field with no initializer reports -1.
    expect(members[1].initStart).toBe(-1);
    // The method's function body `{`.
    expect(src[members[1].value.bodyStart]).toBe("{");
    // The static block's closing `}` (and its node start is the opening `{`).
    const block = members[2];
    expect(block.type).toBe("StaticBlock");
    expect(src[block.start]).toBe("{");
    expect(src[block.closeBrace]).toBe("}");
    // The class body's closing `}`.
    expect(src[a.body.closeBrace]).toBe("}");
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

  test("destructuring params expose ArrayPattern / ObjectPattern bindings", () => {
    const a = ast(`const f = ({ a, b: c, d = 1 }, [x, z]) => a`).body[0].declarations[0].init;
    expect(stripStart(a.params)).toEqual([
      {
        type: "ObjectPattern",
        properties: [
          { type: "Property", key: { type: "StringLiteral", value: "a" }, value: { type: "Identifier", name: "a" } },
          { type: "Property", key: { type: "StringLiteral", value: "b" }, value: { type: "Identifier", name: "c" } },
          {
            type: "Property",
            key: { type: "StringLiteral", value: "d" },
            value: {
              type: "AssignmentPattern",
              left: { type: "Identifier", name: "d" },
              right: { type: "NumericLiteral", value: 1 },
            },
          },
        ],
      },
      {
        type: "ArrayPattern",
        elements: [
          { type: "Identifier", name: "x" },
          { type: "Identifier", name: "z" },
        ],
      },
    ]);
  });

  test("import declarations expose source + specifiers (local vs imported)", () => {
    const body = ast(`import def, { a, b as c } from "./dep"; import * as ns from "./y";`).body;
    expect(stripStart(body[0])).toEqual({
      type: "ImportDeclaration",
      source: "./dep",
      specifiers: [
        { type: "ImportDefaultSpecifier", local: "def" },
        { type: "ImportSpecifier", local: "a", imported: "a" },
        { type: "ImportSpecifier", local: "c", imported: "b" },
      ],
    });
    expect(stripStart(body[1])).toEqual({
      type: "ImportDeclaration",
      source: "./y",
      specifiers: [{ type: "ImportNamespaceSpecifier", local: "ns" }],
    });
  });

  test("template literals expose their interpolated expressions", () => {
    const a = ast("`tpl ${x} and ${y + 1}`").body[0].expression;
    expect(a.type).toBe("TemplateLiteral");
    expect(stripStart(a.expressions)).toEqual([
      { type: "Identifier", name: "x" },
      {
        type: "BinaryExpression",
        operator: "+",
        left: { type: "Identifier", name: "y" },
        right: { type: "NumericLiteral", value: 1 },
      },
    ]);
  });

  test("unmapped node kinds surface as Unsupported, never throw", () => {
    // A `with` statement is not mapped; it must surface as Unsupported, not throw.
    const a = ast("with (o) { x; }").body[0];
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

  // The AST must reflect the SOURCE, not the transpiler's lowering. `using` /
  // `await using` are lowered (into try/finally + an injected disposal-helper
  // import) for non-Bun targets, which corrupted the node shape — ast() now
  // parses with the Bun target (native support), so they stay faithful.
  test("`using` declarations are not lowered away", () => {
    const a = ast("{ using x = r; }");
    expect(a.body[0].type).toBe("BlockStatement");
    expect(a.body[0].body[0]).toMatchObject({ type: "VariableDeclaration", kind: "using" });
    expect(a.body[0].body[0].declarations[0].id).toMatchObject({ type: "Identifier", name: "x" });
  });

  test("`using` / `await using` inside a function body stay faithful", () => {
    // Previously these mis-parsed the whole program as an ImportDeclaration.
    const arrow = ast("(() => { using x = r; return 1; })").body[0];
    expect(arrow.type).toBe("ExpressionStatement");
    expect(arrow.expression.type).toBe("ArrowFunctionExpression");

    const asyncArrow = ast("(async () => { await using x = r; })").body[0].expression;
    expect(asyncArrow.type).toBe("ArrowFunctionExpression");
    // An arrow's block body is the statements array directly (no BlockStatement).
    expect(asyncArrow.body[0]).toMatchObject({ type: "VariableDeclaration", kind: "await using" });
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
