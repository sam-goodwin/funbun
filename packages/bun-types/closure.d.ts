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
}
