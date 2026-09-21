// The escaping-extension-home variation (structure.ts homeEscapingExtensions, rank.ts
// `/escape-home`): a `zext`/`sext` with 2+ distinct consumers, none of them in its own block,
// materializes into a local — the register the asm narrowed into once and every later block read —
// where the default writes the cast out again at every consumer. Off by default.
//
// What these tests pin is the SCOPE, since the sibling homing variations own the neighbouring
// shapes: a consumer BESIDE the def is what says the compiler could re-derive there, so it takes
// the value out of this scope and leaves it to them, and a value read only once is one the home
// could only add a copy to.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { hasEscapingExtension } from '../src/structure/analysis';
import { structure } from '../src/structure/structure';
import { count } from './helpers';

const emit = (ir: string, on: boolean): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, { homeEscapingExtensions: on, returnsVoid: false }));
};

// ── the isolate: DeleteAllSaveData's shape, reduced ──────────────────────────────────────────
// A call's result narrowed to 16 bits, then tested in one block and returned from another. The asm
// narrows once (`lsls`/`lsrs` into a register) and both later blocks read that register; the
// default spells `(u16)` at each of them.
const ESCAPED = `fn escaped {
^bb0():
  %0: s32 = call {target="poll"}
  %1: s32 = zext %0 {width=16}
  br ^bb1()
^bb1():
  %2: s32 = const {value=0}
  %3: s32 = icmp_ne %1, %2
  cond_br %3, ^bb2(), ^bb3()
^bb2():
  ret %1
^bb3():
  ret %2
}
`;

test('an extension every consumer reads from another block homes at its def', () => {
  const on = emit(ESCAPED, true);
  expect(count(on, '(u16)')).toBe(1);
  expect(on).toContain('= (u16)poll()');
  expect(hasEscapingExtension(parse(ESCAPED))).toBe(true);
});

test('off by default: the cast is written out again at each consumer', () => {
  const off = emit(ESCAPED, false);
  expect(count(off, '(u16)')).toBe(2);
});

// ── the refusals ─────────────────────────────────────────────────────────────────────────────

// One consumer sits beside the def, which is where the compiler could have re-derived it — the
// straight-line class the sibling variations judge on their own evidence.
const CONSUMED_AT_HOME = `fn athome {
^bb0():
  %0: s32 = call {target="poll"}
  %1: s32 = zext %0 {width=16}
  %2: s32 = const {value=0}
  %3: s32 = icmp_ne %1, %2
  cond_br %3, ^bb1(), ^bb2()
^bb1():
  ret %1
^bb2():
  ret %2
}
`;

test('REFUSES an extension its own block consumes', () => {
  expect(hasEscapingExtension(parse(CONSUMED_AT_HOME))).toBe(false);
  expect(emit(CONSUMED_AT_HOME, true)).toBe(emit(CONSUMED_AT_HOME, false));
});

// A single reader inlines with the same bytes either way, so a home can only add a copy.
const READ_ONCE = `fn once {
^bb0():
  %0: s32 = call {target="poll"}
  %1: s32 = zext %0 {width=16}
  br ^bb1()
^bb1():
  ret %1
}
`;

test('REFUSES an extension read once', () => {
  expect(hasEscapingExtension(parse(READ_ONCE))).toBe(false);
  expect(emit(READ_ONCE, true)).toBe(emit(READ_ONCE, false));
});

// An edge ARGUMENT renders in the block whose terminator carries it — the def's own block — so a
// value handed to a merge is consumed at home however far the merge is.
const EDGE_FED = `fn edgefed {
^bb0():
  %0: s32 = call {target="poll"}
  %1: s32 = zext %0 {width=16}
  %2: s32 = const {value=0}
  %3: s32 = icmp_ne %1, %2
  cond_br %3, ^bb1(%1), ^bb2()
^bb1(%4: s32):
  ret %4
^bb2():
  ret %2
}
`;

test('REFUSES an extension an edge copy hands on — that copy renders at home', () => {
  expect(hasEscapingExtension(parse(EDGE_FED))).toBe(false);
});

// Nothing but an extension is in scope: a pure computation with the same escaping shape stays with
// the sibling variations, whose evidence is a loop or a read rather than a narrowed register.
const ESCAPING_XOR = `fn escxor {
^bb0():
  %0: s32 = call {target="poll"}
  %9: s32 = const {value=1023}
  %1: s32 = xor %0, %9
  br ^bb1()
^bb1():
  %2: s32 = const {value=0}
  %3: s32 = icmp_ne %1, %2
  cond_br %3, ^bb2(), ^bb3()
^bb2():
  ret %1
^bb3():
  ret %2
}
`;

test('REFUSES a pure value that is not an extension', () => {
  expect(hasEscapingExtension(parse(ESCAPING_XOR))).toBe(false);
  expect(emit(ESCAPING_XOR, true)).toBe(emit(ESCAPING_XOR, false));
});
