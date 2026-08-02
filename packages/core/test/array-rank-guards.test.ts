// The `index.lead` safety perimeter (the multidimensional array-global spelling).
//
// `lead` is an OPTIONAL field on an existing node, which is only safe because every generic
// rewrite preserves it (`mapExprChildren` spreads) and every site that REBUILDS an `index` from
// parts either carries it or refuses. Those refusals are the entire argument, so they are pinned
// here: each one is a place where dropping `lead` would turn an ELEMENT access into a ROW's —
// a wrong address, silently.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { pascalBackend } from '../src/backend/pascal';
import { T } from '../src/ir/types';
import type { Expr, SFn } from '../src/l3/ast';
import { exprEquals } from '../src/l3/ast';
import { decompile } from '../src/pipeline';
import type { SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

const ixLead = (lead?: number[]): Expr => ({
  k: 'index',
  base: { k: 'var', name: 'g' },
  idx: { k: 'var', name: 'i' },
  width: 2,
  signed: false,
  ...(lead ? { lead } : {}),
});

const fnOf = (value: Expr): SFn => ({
  name: 'f',
  params: [],
  locals: [{ name: 'i', type: T.u(32) }],
  globals: [{ name: 'g', type: T.ptr(T.u(16)) }],
  retType: T.u(16),
  body: [{ k: 'return', value }],
});

describe('exprEquals treats `lead` as part of the address', () => {
  test('different leading subscripts are DIFFERENT expressions', () => {
    // `g[0][i]` and `g[1][i]` are 2048 bytes apart; collapsing them in any dedup/CSE path
    // would silently reuse one element's value for the other's.
    expect(exprEquals(ixLead([0]), ixLead([1]))).toBe(false);
    expect(exprEquals(ixLead([0]), ixLead())).toBe(false); // `g[0][i]` is not `g[i]`
    expect(exprEquals(ixLead([0, 0]), ixLead([0]))).toBe(false); // rank is part of it too
  });

  test('identical leading subscripts still compare equal', () => {
    expect(exprEquals(ixLead([0, 0]), ixLead([0, 0]))).toBe(true);
    expect(exprEquals(ixLead(), ixLead())).toBe(true);
  });
});

describe('backends either spell `lead` or refuse it', () => {
  test('the C backend spells every leading subscript', () => {
    expect(cBackend.emit(fnOf(ixLead([0, 0])))).toContain('g[0][0][i]');
  });

  test('the C backend REFUSES a lead whose base does not stride the access width', () => {
    // `lead` implies the base is already a matching element pointer. If it were not, the
    // deref legalization would wrap it and spell `((u16 *)g)[0][i]` — a double subscript of a
    // scalar. The invariant is checked rather than assumed.
    const fn = fnOf(ixLead([0]));
    fn.globals = [{ name: 'g', type: T.ptr(T.u(8)) }]; // stride 1 vs the node's width 2
    expect(() => cBackend.emit(fn)).toThrow(/multidimensional array access needs a base that strides/);
  });

  test('the Pascal backend DECLINES rather than dropping the subscripts', () => {
    // IDO Pascal has no spelling for this yet; emitting `g[i]` would read a row's address.
    expect(() => pascalBackend.emit(fnOf(ixLead([0])))).toThrow(/multidimensional/);
  });
});

describe('shift signedness is judged in the environment that PRINTS the code', () => {
  test("an array global's ELEMENT signedness reaches the shift rule", () => {
    // The map says the elements are u32; the asm shifts one arithmetically (`asr`). The operand
    // must be cast back to signed, or C spells the LOGICAL shift over the u32 element and the
    // value differs for a negative element.
    //
    // This is why the rule lives in the backend: the structurer's variable environment holds
    // params and locals only, so it types `gTable[i]` from the access width alone and would
    // answer "signed" for every word load whatever the map said. The backend judges against
    // `declaredTypes(sfn)`, which includes the shaped globals.
    const asm =
      'f:\n\tldr\tr1, .L1\n\tlsls\tr0, r0, #0x2\n\tadds\tr0, r1, r0\n\tldr\tr0, [r0]\n' +
      '\tasrs\tr0, r0, #0x4\n\tbx\tlr\n.L1:\n\t.word\t0x08057B4C\n';
    const map: SymbolMap = new Map([
      [
        0x08057b4c,
        [
          {
            name: 'gTable',
            kind: 'data' as const,
            shape: 'array' as const,
            elemSize: 4,
            elemSigned: false,
            dims: [64],
          },
        ],
      ],
    ]);
    expect(decompile('f', asm, ARMV4T_AGBCC, { symbols: map }).source).toContain('(s32)gTable[a0] >> 4');
  });
});
