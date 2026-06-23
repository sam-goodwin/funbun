import { expectType } from "./utilities";

// `Symbol.freeVariables` resolves without a cast and is a unique symbol.
expectType(Symbol.freeVariables).is<typeof Symbol.freeVariables>();

function makeCounter() {
  let n = 0;
  return () => ++n;
}

const counter = makeCounter();

// `fn[Symbol.freeVariables]` is an array of descriptors.
const captured = counter[Symbol.freeVariables];
expectType(captured).is<FreeVariableDescriptor[]>();

const [first] = captured;
expectType(first!.name).is<string>();
expectType(first!.id).is<number>();
expectType(first!.scopeId).is<number>();
expectType(first!.value).is<any>();
expectType(first!.kind).is<"const" | "let">();
