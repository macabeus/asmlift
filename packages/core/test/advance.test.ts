// The BASE-ADVANCE capability: `ldr r3,=X; strh [r3]; adds r3,#2; strh [r3]` — a register the
// machine held as an address and then moved to reach a second address.
//
// Three levels, three questions, and this file holds the last two:
//   • `raise/const.ts` records the step on the literal its fold produces — pinned in
//     `const-fold.test.ts` case (g), beside the fold whose behaviour is unchanged;
//   • the STRUCTURE SEAM copies it onto the access node as `index.baseAdvanced` (l3/ast.ts's third
//     evidence field);
//   • `l3/advance.ts` reads it and offers the one C spelling that reproduces the `add`.
//
// WHY THE SPELLING IS A CANDIDATE AND NOT A DEFAULT, compiled through the benchmark's own agbcc
// command rather than reasoned about. Against `kleod:StreamCmd_SetWindowRegs`'s target object:
//   `volatile u16 *p = (volatile u16 *)0x04000048; *p = a; p++; *p = b;`  → byte-exact
//   the same with `p[1]` instead of `p++`                                 → `strh [r3, #2]`, no add
//   the same without `volatile`                                           → `strh [r3, #2]`, no add
// So the advance is INERT wherever the pointee is not volatile — agbcc folds it straight back into
// the memory operand — and it is the `volatile` × advance CONJUNCTION that reproduces the target.
// Neither half is worth a default: the subscript spelling is right for every access the compiler
// did fold, which is nearly all of them.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import type { Expr, SFn } from '../src/l3/ast';
import { recognizeConsts } from '../src/raise/const';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';

// Two halfword stores 2 bytes apart through ONE address register — the `REG_WININ` pair, reduced.
const ADVANCE_IR = `fn advance {
^bb0(%0: s32):
  %1: s32* = const {value=67108936}
  store %1, %0 {off=0, width=2}
  %2: s32 = const {value=2}
  %3: s32* = add %1, %2
  store %3, %0 {off=0, width=2}
  ret
}
`;

export const structured = (ir: string): SFn => {
  const fn = parse(ir);
  recognizeConsts(fn);
  recoverTypes(fn);
  return structure(fn, { returnsVoid: true });
};

/** Every `index` node in the tree, in emission order. */
const indexNodes = (sfn: SFn): Extract<Expr, { k: 'index' }>[] => {
  const out: Extract<Expr, { k: 'index' }>[] = [];
  const walk = (e: Expr): void => {
    if (e.k === 'index') {
      out.push(e);
    }
    for (const child of Object.values(e as Record<string, unknown>)) {
      if (child && typeof child === 'object' && 'k' in (child as object)) {
        walk(child as Expr);
      }
    }
  };
  for (const s of sfn.body) {
    if (s.k === 'store') {
      walk(s.lval);
      walk(s.value);
    }
  }
  return out;
};

test('the structure seam carries the advance onto the access it reached', () => {
  const nodes = indexNodes(structured(ADVANCE_IR));
  expect(nodes.map((n) => n.baseAdvanced)).toEqual([undefined, 2]);
});

test('the advanced access still denotes the cell its absolute address names', () => {
  const out = cBackend.emit(structured(ADVANCE_IR));
  expect(out).toContain('67108936');
  expect(out).toContain('67108938');
});
