// A CALL THROUGH A REGISTER. agbcc calls a function pointer as `bl _call_via_<reg>`, a libgcc
// thunk that is `bx <reg>` (gcc/thumb.md:997-1021, libgcc/lib1thumb.asm:595-633), so the callee
// is the VALUE in <reg> and the thunk is no function the source names. Toolchain-free: the asm
// below is agbcc's own output at the canonical flags, compiled from the reference C each test
// names, except where a test calls its asm hand-written; packages/cli/test/matching/indirect-call.test.ts
// recompiles the lifts.
import { describe, expect, test } from 'vitest';

import { callArgs, calleeName, calleeValue, mkOp, mkValue, truncateCallArgs } from '../src/ir/core';
import { T } from '../src/ir/types';
import { VerifyError, verify } from '../src/ir/verify';
import { decompile } from '../src/pipeline';
import type { Prototypes } from '../src/proto';
import { ARMV4T_AGBCC } from '../src/target';

const PROTOS: Prototypes = {
  h: { params: [], returnsVoid: true },
  g4: { params: ['s32', 's32', 's32', 's32'], returnsVoid: true },
};

// `u8 fresh(void *a, s16 *b) { return tbl[b[24]](&g1, &g2); }` — the pointer is computed last and
// lands in r2, above the two arguments.
const FRESH = [
  'fresh:',
  '\tpush\t{lr}',
  '\tldr\tr0, .L3',
  '\tmov\tr3, #0x30',
  '\tldrsh\tr2, [r1, r3]',
  '\tlsl\tr2, r2, #0x2',
  '\tadd\tr2, r2, r0',
  '\tldr\tr0, .L3+0x4',
  '\tldr\tr1, .L3+0x8',
  '\tldr\tr2, [r2]',
  '\tbl\t_call_via_r2',
  '\tlsl\tr0, r0, #0x18',
  '\tlsr\tr0, r0, #0x18',
  '\tpop\t{r1}',
  '\tbx\tr1',
  '.L3:',
  '\t.word\ttbl',
  '\t.word\tg1',
  '\t.word\tg2',
  '',
].join('\n');

// pokeemerald `DoForcedMovement`'s shape: the pointer lives across a call, so it sits in a
// callee-saved HIGH register no argument travels in.
// `void f(u8 d, void (*move)(u8), int a, int b, int c) { h(); g4(a, b, c, d); h(); move(d); }`
const THROUGH_R8 = [
  'f:',
  '\tpush\t{r4, r5, r6, r7, lr}',
  '\tmov\tr7, r8',
  '\tpush\t{r7}',
  '\tadd\tr4, r0, #0',
  '\tmov\tr8, r1',
  '\tadd\tr5, r2, #0',
  '\tadd\tr6, r3, #0',
  '\tldr\tr7, [sp, #0x18]',
  '\tlsl\tr4, r4, #0x18',
  '\tlsr\tr4, r4, #0x18',
  '\tbl\th',
  '\tadd\tr0, r5, #0',
  '\tadd\tr1, r6, #0',
  '\tadd\tr2, r7, #0',
  '\tadd\tr3, r4, #0',
  '\tbl\tg4',
  '\tbl\th',
  '\tadd\tr0, r4, #0',
  '\tbl\t_call_via_r8',
  '\tpop\t{r3}',
  '\tmov\tr8, r3',
  '\tpop\t{r4, r5, r6, r7}',
  '\tpop\t{r0}',
  '\tbx\tr0',
  '',
].join('\n');

// pokeemerald `ObjectEventCB2_BerryTree`, `return tbl[b->d1](a, b);`: both arguments pass through
// untouched, so nothing sets r0 or r1 up, and the pointer lands in r2.
const PASSTHRU = [
  'passthru:',
  '\tpush\t{r4, lr}',
  '\tldr\tr3, .L3',
  '\tmov\tr4, #0x30',
  '\tldrsh\tr2, [r1, r4]',
  '\tlsl\tr2, r2, #0x2',
  '\tadd\tr2, r2, r3',
  '\tldr\tr2, [r2]',
  '\tbl\t_call_via_r2',
  '\tlsl\tr0, r0, #0x18',
  '\tlsr\tr0, r0, #0x18',
  '\tpop\t{r4}',
  '\tpop\t{r1}',
  '\tbx\tr1',
  '.L3:',
  '\t.word\ttbl',
  '',
].join('\n');

// `extern long long mkll(int); void w2(void (*g)(long long)) { g(mkll(3)); }`
const PAIR_ARG = [
  'w2:',
  '\tpush\t{r4, lr}',
  '\tadd\tr4, r0, #0',
  '\tmov\tr0, #0x3',
  '\tbl\tmkll',
  '\tbl\t_call_via_r4',
  '\tpop\t{r4}',
  '\tpop\t{r0}',
  '\tbx\tr0',
  '',
].join('\n');

describe('a call names its callee or calls a value, never both', () => {
  const fnOf = (attrs: Record<string, string | boolean>, operands = 1) => {
    const vs = Array.from({ length: operands }, () => mkValue(T.unk(32)));
    const call = mkOp('call', { operands: vs, results: [mkValue(T.unk(32))], attrs });
    return {
      name: 'f',
      blocks: [{ params: vs, ops: [call, mkOp('ret', { operands: [call.results[0]] })] }],
      writeOrder: undefined,
      slotHomes: undefined,
      paramEvidence: undefined,
      localObjects: undefined,
    } as unknown as Parameters<typeof verify>[0];
  };

  test('a named call and an indirect one verify', () => {
    expect(() => verify(fnOf({ target: 'g' }))).not.toThrow();
    expect(() => verify(fnOf({ indirect: true }))).not.toThrow();
  });

  test('neither, both, a non-string name or an indirect call with no callee operand is refused', () => {
    expect(() => verify(fnOf({}))).toThrow(VerifyError);
    expect(() => verify(fnOf({ target: 'g', indirect: true }))).toThrow(VerifyError);
    expect(() => verify(fnOf({ target: true }))).toThrow(VerifyError);
    expect(() => verify(fnOf({ indirect: true }, 0))).toThrow(VerifyError);
  });

  test('the callee value is the last operand, and trimming the arguments keeps it', () => {
    const [a, b, p] = [mkValue(T.unk(32)), mkValue(T.unk(32)), mkValue(T.unk(32))];
    const call = mkOp('call', { operands: [a, b, p], results: [mkValue(T.unk(32))], attrs: { indirect: true } });
    expect(calleeValue(call)).toBe(p);
    expect(calleeName(call)).toBeUndefined();
    expect(callArgs(call)).toEqual([a, b]);
    truncateCallArgs(call, 1);
    expect(call.operands).toEqual([a, p]);
  });
});

describe('Thumb lowers `bl _call_via_<reg>` as a call through <reg>', () => {
  test('the pointer is the callee, and no register at or above it is an argument', () => {
    const r = decompile('fresh', FRESH, ARMV4T_AGBCC);
    expect(r.ir.raw).toMatch(/= call %\d+, %\d+, %\d+ \{indirect=true\}/);
    // the 48 the `ldrsh` offset left in r3 used to be a fourth argument
    expect(r.source).toBe('s32 fresh(s32 a0, s16 *a1) {\n    return (u8)((s32 (*)())tbl[*(a1 + 24)])(&g1, &g2);\n}\n');
  });

  test('a pointer held in a high register is called, not dropped', () => {
    expect(decompile('f', THROUGH_R8, ARMV4T_AGBCC, { prototypes: PROTOS }).source).toBe(
      'void f(u8 a0, s32 a1, s32 a2, s32 a3, s32 a4) {\n    h();\n    g4(a2, a3, a4, a0);\n    h();\n' +
        '    ((s32 (*)())a1)(a0);\n}\n',
    );
  });

  test('a thunk through sp or lr declines: neither register holds a function', () => {
    for (const r of ['sp', 'lr']) {
      expect(() =>
        decompile('f', `f:\n\tpush\t{lr}\n\tbl\t_call_via_${r}\n\tpop\t{r0}\n\tbx\tr0\n`, ARMV4T_AGBCC),
      ).toThrow(`'bl _call_via_${r}' calls through a register that holds no function's address`);
    }
  });
});

describe('a call through argument register rN takes r0..r(N-1)', () => {
  test("an argument register nothing wrote is the function's own argument, passed on", () => {
    expect(decompile('passthru', PASSTHRU, ARMV4T_AGBCC).source).toBe(
      's32 passthru(s32 a0, s16 *a1) {\n    return (u8)((s32 (*)())tbl[*(a1 + 24)])(a0, a1);\n}\n',
    );
  });

  test('one a call destroyed names no value, and the lift declines', () => {
    // Hand-written: agbcc puts a pointer computed after a call in r0 (`h(); getP()();`), so no
    // source reaches this shape, and the refusal is pinned for asm it did not write.
    const asm =
      'f:\n\tpush\t{lr}\n\tbl\th\n\tldr\tr2, .L3\n\tldr\tr2, [r2]\n\tbl\t_call_via_r2\n\tpop\t{r0}\n\tbx\tr0\n.L3:\n\t.word\ttbl\n';
    expect(() => decompile('f', asm, ARMV4T_AGBCC, { prototypes: PROTOS })).toThrow(
      /r[01] is read on a path where a call has destroyed it/,
    );
  });
});

describe('`blx rN` is a call through rN too', () => {
  // Hand-written: agbcc never emits `blx`, and the playground takes asm it did not write.
  const through = (call: string) =>
    `f:\n\tpush\t{lr}\n\tldr\tr3, .L3\n\tldr\tr3, [r3]\n\t${call}\n\tpop\t{r0}\n\tbx\tr0\n.L3:\n\t.word\tgCb\n`;

  test('it lifts as the thunk through the same register does', () => {
    const viaThunk = decompile('f', through('bl\t_call_via_r3'), ARMV4T_AGBCC).source;
    expect(decompile('f', through('blx\tr3'), ARMV4T_AGBCC).source).toBe(viaThunk);
    expect(viaThunk).toBe('void f(s32 a0, s32 a1, s32 a2) {\n    ((s32 (*)())gCb)(a0, a1, a2);\n}\n');
  });

  test('one through sp or lr declines', () => {
    for (const r of ['sp', 'lr']) {
      expect(() => decompile('f', `f:\n\tpush\t{lr}\n\tblx\t${r}\n\tpop\t{r0}\n\tbx\tr0\n`, ARMV4T_AGBCC)).toThrow(
        `'blx ${r}' calls through a register that holds no function's address`,
      );
    }
  });
});

describe('a pair argument to a call through a register', () => {
  test('declines without naming a prototype, which no call through a register is keyed by', () => {
    const prototypes: Prototypes = { mkll: { params: ['s32'], returns: 'long long' } };
    const thrown = (() => {
      try {
        decompile('w2', PAIR_ARG, ARMV4T_AGBCC, { prototypes });
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    })();
    expect(thrown).toContain('argument 1 of the call through r4 is the low half of a 64-bit value');
    expect(thrown).not.toContain('prototype');
  });
});
