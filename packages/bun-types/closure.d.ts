declare module "bun:closure" {
  /**
   * **Experimental.** A JSON.stringify-style replacer applied to every captured
   * value (free variables, object properties, array elements) before it is
   * serialized. Return a transformed value, or `undefined` to omit an object
   * property.
   */
  type ClosureReplacer = (key: string, value: unknown) => unknown;

  /**
   * **Experimental.** Serialize a function — including the variables it captures
   * — to the source of an ES module whose `export default` reconstructs it.
   *
   * Captured primitives, objects/arrays (with cycles and shared references),
   * nested functions, shared mutable cells, common built-ins (Date, RegExp,
   * Map, Set, typed arrays, Error), Proxies, and bound functions are all
   * reconstructed. The result includes an inline source map so errors thrown in
   * the generated module point back to the original source.
   *
   * @param fn The function to serialize.
   * @param replacer Optional {@link ClosureReplacer} to transform/filter values.
   * @returns The source of an ES module that `export default`s the function.
   *
   * @experimental This is a Bun-specific API and may change.
   *
   * @example
   * ```ts
   * import { serialize } from "bun:closure";
   *
   * let count = 0;
   * const increment = () => ++count;
   * const moduleSource = serialize(increment);
   * // "let count = 0;\nexport default (() => ++count);\n//# sourceMappingURL=..."
   * ```
   */
  function serialize(fn: Function, replacer?: ClosureReplacer): string;

  /**
   * **Experimental.** Like {@link serialize}, but routes the closure through
   * Bun's bundler. The closure's captured state is emitted as a virtual module
   * and its module-level imports are re-imported from their original sources,
   * so the bundler resolves, inlines, and tree-shakes them.
   *
   * Unlike {@link serialize} — which drops imported bindings, producing a module
   * that throws `"x is not defined"` — `bundle` produces a working standalone
   * module for closures that reference imports. It is async because the bundler
   * is async.
   *
   * @param fn The function to serialize.
   * @returns A promise for the bundled ES module source.
   * @example
   * ```ts
   * import { bundle } from "bun:closure";
   * import { renderTemplate } from "./templates.ts";
   * const greet = (name: string) => renderTemplate(name);
   * const moduleSource = await bundle(greet); // renderTemplate inlined + tree-shaken
   * ```
   */
  function bundle(fn: Function): Promise<string>;
}
