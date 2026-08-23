// THE SIGNEDNESS AXIS and where it costs nothing. The axis itself — pin the entry scalars signed,
// then unsigned, and let the differ referee — is pinned by the rows that win on each side; these
// tests pin the other half: the two independent reasons a second pass produces no candidate, and
// the line between them and a pin the emitted C can actually READ.
//
// The reasons refuse at different points and are checked separately. The pin can write NOTHING (no
// scalar entry param to pin), or it can write something no rendered expression reads. Toolchain-free.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { T } from '../src/ir/types';
import type { Expr, LanguageBackend, SFn, Stmt } from '../src/l3/ast';
import { signednessObservable } from '../src/l3/typing';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

const wrap = (body: string) => `f:\n\tpush\t{lr}\n${body}\tpop\t{r1}\n\tbx\tr1\n`;

/** cBackend, plus every spelling it was asked to print — the enumeration's real work, where the
 *  candidate list shows only what survived the dedup. */
function recordingBackend(): { backend: LanguageBackend; emitted: string[] } {
  const emitted: string[] = [];
  return {
    backend: {
      ...cBackend,
      emit: (fn) => {
        const s = cBackend.emit(fn);
        emitted.push(s);
        return s;
      },
    },
    emitted,
  };
}

const a0: Expr = { k: 'var', name: 'a0' };
const k: Expr = { k: 'const', value: 7 };
const ret = (value: Expr): Stmt[] => [{ k: 'return', value }];
const fnWith = (body: Stmt[]): SFn => ({
  name: 'f',
  params: [{ name: 'a0', type: T.u(32) }],
  locals: [],
  retType: T.s(32),
  body,
});
const observable = (body: Stmt[]): boolean => signednessObservable(fnWith(body), new Set(['a0']));
const bin = (op: Extract<Expr, { k: 'bin' }>['op'], l: Expr, r: Expr): Expr => ({ k: 'bin', op, l, r });
const nop: Stmt = { k: 'break' };

describe('signednessObservable — can a declaration be read from the rendered C', () => {
  test('the operators that DECIDE a machine operation from a declaration', () => {
    for (const op of ['/', '%', '<', '<=', '>', '>=', '==', '!=', '&&', '||', '>>', '>>>'] as const) {
      expect(observable(ret(bin(op, a0, k)))).toBe(true);
    }
  });

  // `==`/`!=` cannot ANSWER differently — the bits are the bits — but mwcc spells the same test
  // `cmpwi` over a signed operand and `cmplwi` over an unsigned one, and byte-exactness is what
  // this decompiler is ranked on. synthetic:selnz:mwcc_242_81 is `if (a0 != 0) a2 = a1;` and
  // matches on ONE of the two pins.
  test('an equality test reads the declaration too, because the INSTRUCTION does', () => {
    expect(observable(ret(bin('!=', a0, { k: 'const', value: 0 })))).toBe(true);
  });

  test('…and the operators that produce the same 32 bits under one instruction do not', () => {
    for (const op of ['+', '-', '*', '&', '|', '^', '<<'] as const) {
      expect(observable(ret(bin(op, a0, k)))).toBe(false);
    }
    expect(observable(ret({ k: 'un', op: '-', e: a0 }))).toBe(false);
    expect(observable(ret({ k: 'un', op: '~', e: a0 }))).toBe(false);
  });

  // The two positions where the COMPILER emits a comparison the tree never spelled. Both were
  // found by a corpus sweep that lost fourteen winners without them.
  test('a truth test reads the declaration, spelled or not', () => {
    expect(observable([{ k: 'if', cond: a0, then: ret(k), else: [] }])).toBe(true);
    expect(observable([{ k: 'while', cond: a0, body: [] }])).toBe(true);
    expect(observable(ret({ k: 'un', op: '!', e: a0 }))).toBe(true);
  });

  test('a switch scrutinee reads it — the case dispatch is a chain of compares', () => {
    const sw = (scrutinee: Expr): Stmt => ({
      k: 'switch',
      scrutinee,
      cases: [{ values: [1], body: ret(k), fallsThrough: false }],
    });
    expect(observable([sw(a0)])).toBe(true);
    expect(observable([sw({ k: 'cast', to: T.u(32), e: a0 })])).toBe(false);
  });

  test('a carried signedness reaches an operator THROUGH the arithmetic above it', () => {
    // `(a0 + 1) / 7` — the division's left operand is `unsigned int` or `int` depending on a0's
    // declaration, which is exactly the case a rule about a0's own operator would miss.
    expect(observable(ret(bin('/', bin('+', a0, k), k)))).toBe(true);
    expect(observable(ret(bin('/', bin('<<', a0, k), k)))).toBe(true);
  });

  test('…and stops at an explicit cast, and at anything yielding int', () => {
    expect(observable(ret(bin('/', { k: 'cast', to: T.u(32), e: a0 }, k)))).toBe(false);
    // a comparison is `int` whatever it compared, so dividing by one reads no declaration
    expect(observable(ret(bin('/', k, bin('<', k, k))))).toBe(false);
  });

  test('it looks inside every statement the tree can nest', () => {
    const div: Expr = bin('%', a0, k);
    expect(observable([{ k: 'while', cond: k, body: ret(div) }])).toBe(true);
    expect(observable([{ k: 'if', cond: k, then: [], else: ret(div) }])).toBe(true);
    expect(observable([{ k: 'for', init: nop, cond: k, inc: nop, body: ret(div) }])).toBe(true);
    expect(
      observable([{ k: 'switch', scrutinee: k, cases: [{ values: [1], body: ret(div), fallsThrough: false }] }]),
    ).toBe(true);
  });

  test('a name that is not asked about is not carried', () => {
    expect(signednessObservable(fnWith(ret(bin('/', a0, k))), new Set(['a1']))).toBe(false);
  });
});

describe('the axis declines where the pin writes nothing', () => {
  // r0 is dereferenced, so it recovers as a pointer and NO_PIN_KINDS excludes it: `pinScalarParams`
  // has no scalar entry param to write, and both passes would lift the identical function.
  const PTR_ONLY = '\tldr\tr1, [r0]\n\tadd\tr1, r1, #1\n\tstr\tr1, [r0]\n';

  test('a function whose every entry param is a pointer is enumerated ONCE', () => {
    const { backend, emitted } = recordingBackend();
    const cands = enumerateCandidates('f', wrap(PTR_ONLY), ARMV4T_AGBCC, { backend });
    // The whole enumeration collapses onto one spelling, so the print count IS the work: eight
    // axis points, printed once each. With the second pin pass running it was sixteen — the same
    // eight strings a second time, every one of them thrown away by the dedup.
    expect(cands.length).toBe(1);
    expect(new Set(emitted).size).toBe(1);
    expect(emitted.length).toBe(8);
  });
});

describe('the axis declines where the pin cannot be read', () => {
  test('a scalar param only shifted LEFT and added to keeps one spelling', () => {
    const cands = enumerateCandidates('f', wrap('\tlsl\tr0, r0, #2\n\tadd\tr0, r0, #3\n'), ARMV4T_AGBCC, {});
    expect(cands.map((c) => c.label)).toEqual(['unsigned']);
    expect(cands[0].source).toContain('u32 a0');
  });

  test('…and one whose declaration a right shift reads keeps both', () => {
    // `asr` renders `>>`, and which shift that is comes from the operand's declared signedness.
    const cands = enumerateCandidates('f', wrap('\tasr\tr0, r0, #2\n'), ARMV4T_AGBCC, {});
    expect(cands.map((c) => c.label)).toEqual(['unsigned', 'signed']);
  });

  test('…and one under a relational keeps both', () => {
    const CMP = '\tcmp\tr0, #5\n\tblt\t.L2\n\tmov\tr0, #1\n\tb\t.L3\n.L2:\n\tmov\tr0, #2\n.L3:\n';
    const cands = enumerateCandidates('f', wrap(CMP), ARMV4T_AGBCC, {});
    expect(cands.some((c) => c.label.startsWith('signed'))).toBe(true);
    expect(cands.some((c) => c.label.startsWith('unsigned'))).toBe(true);
  });
});
