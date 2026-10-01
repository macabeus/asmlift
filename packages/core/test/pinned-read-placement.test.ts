// A DEVICE READ THE LIFT PINNED RUNS WHERE THE ASM RAN IT — structure/analysis.ts's placement
// rules, asked of a `load {volatile=true}` (ir/discipline.ts's `device` placement) as they are asked
// of a call. Its qualified spelling is an access the recompile makes at every render, so a read
// rendered in another block runs on that block's paths instead of its own.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';

const emit = (ir: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, { returnsVoid: true }));
};

// `while (n > 0) { gOut = REG_VCOUNT; n--; }` with the read in the loop's TEST block: the machine
// reads the register on every test, the exiting one included, and only the body uses the value.
const HEADER_READ = `fn poll {
^bb0(%0: s32):
  %1: u16* = const {value=67108870}
  %2: s32* = gaddr {sym="gOut"}
  br ^bb1(%0)
^bb1(%3: s32):
  %4: u16 = load %1 {off=0, signed=false, width=2, volatile=true}
  %5: s32 = const {value=0}
  %6: u32 = icmp_sgt %3, %5
  cond_br %6, ^bb2(), ^bb3()
^bb2():
  store %2, %4 {off=0, width=2}
  %7: s32 = const {value=1}
  %8: s32 = sub %3, %7
  br ^bb1(%8)
^bb3():
  ret
}
`;

test('a pinned read in a loop header, used only in the body, is named in the header', () => {
  const src = emit(HEADER_READ);
  const read = /(\w+) = \*\(volatile u16 \*\)67108870;/.exec(src);
  expect(read, src).not.toBeNull();
  expect(src).toContain(`gOut = ${read![1]};`);
});

test('the same read left plain renders at its use', () => {
  const src = emit(HEADER_READ.replace(', volatile=true', ''));
  expect(src).toContain('gOut = *(u16 *)67108870;');
});
