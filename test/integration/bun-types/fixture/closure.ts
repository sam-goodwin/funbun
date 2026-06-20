import { serialize } from "bun:closure";
import { expectType } from "./utilities";

// `serialize` returns the module source as a string.
expectType(serialize(() => 1)).is<string>();
expectType(
  serialize(
    () => 1,
    (_key, value) => value,
  ),
).is<string>();

// The introspection symbols resolve without a cast.
const fn = (x: number) => x;
expectType(fn[Symbol.boundFunction]).is<BoundFunctionDetails | undefined>();
expectType(fn[Symbol.sourceLocation]).is<FunctionSourceLocation | undefined>();
