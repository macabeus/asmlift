// A MEMBER PAST THE DISPLACEMENT RANGE (raise/structs.ts `foldDisplacedAccesses`). The machine
// reaches it through an address it materialises first, and the lift keyed the access on that
// address, so the member never joined its struct and was spelled as a cast. On agbcc the cast is a
// different program for a store of a loaded value (gcc/expr.c expand_assignment :2535 vs :2689),
// which is what kept `sa3:sub_800F0E8` from matching. Every agbcc fixture is agbcc's own output at
// the corpus flags (`-mthumb-interwork -O2 -fhex-asm -fprologue-bugfix`), every MIPS/PPC one the
// toolchain's own disassembly at its canonical flags.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { decompile } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { foldDisplacedAccesses, recognizeStructs } from '../src/raise/structs';
import { structure } from '../src/structure/structure';
import { ARMV4T_AGBCC, type ToolchainId, canonicalFlagsOf, structureOptionsFor, targetFor } from '../src/target';

const lift = (name: string, asm: string, tc: ToolchainId = 'agbcc', returnsVoid = true): string =>
  decompile(name, asm, targetFor(tc, canonicalFlagsOf(tc) ?? []).target, {
    prototypes: { [name]: { returnsVoid } },
  }).source;

// `struct S { s32 a; s32 b; u8 _p[30]; u8 f38; }; void h(struct S *a0, u8 *q) { a0->f38 = *q; a0->a = 0; }`
const BYTE38 =
  'h:\n\tldrb\tr2, [r1]\n\tadd\tr3, r0, #0\n\tadd\tr3, r3, #0x26\n\tmov\tr1, #0x0\n' +
  '\tstrb\tr2, [r3]\n\tstr\tr1, [r0]\n\tbx\tlr\n';
// `struct T { s32 a; u8 _p[66]; u16 f70; }; void h2(struct T *a0, u16 *q) { a0->f70 = *q; a0->a = 0; }`
const HALF70 =
  'h2:\n\tldrh\tr2, [r1]\n\tadd\tr3, r0, #0\n\tadd\tr3, r3, #0x46\n\tmov\tr1, #0x0\n' +
  '\tstrh\tr2, [r3]\n\tstr\tr1, [r0]\n\tbx\tlr\n';
// `struct W { u8 a; u8 _p[127]; s32 f128; }; s32 h3(struct W *a0) { return a0->f128 + a0->a; }`
const WORD128 =
  'h3:\n\tadd\tr1, r0, #0\n\tadd\tr1, r1, #0x80\n\tldrb\tr2, [r0]\n\tldr\tr0, [r1]\n' + '\tadd\tr0, r0, r2\n\tbx\tlr\n';
// `struct W { s32 a; u8 _p[124]; s32 f128; }; s32 h4(struct W *a0) { return a0->f128 + a0->a; }`
const WORDS =
  'h4:\n\tadd\tr1, r0, #0\n\tadd\tr0, r0, #0x80\n\tldr\tr0, [r0]\n\tldr\tr1, [r1]\n' + '\tadd\tr0, r0, r1\n\tbx\tlr\n';
// `void use(u8 *); void r1(struct S *a0, u8 *q) { u8 *d = &a0->f38; *d = *q; a0->a = 0; use(d); }`
const ESCAPES =
  'r1:\n\tpush\t{lr}\n\tadd\tr2, r0, #0\n\tadd\tr0, r0, #0x26\n\tldrb\tr1, [r1]\n' +
  '\tstrb\tr1, [r0]\n\tmov\tr1, #0x0\n\tstr\tr1, [r2]\n\tbl\tuse\n\tpop\t{r0}\n\tbx\tr0\n';

describe('a member past Thumb displacement range is a member', () => {
  test('a byte at 38: the stored loaded value keeps its member spelling', () => {
    const c = lift('h', BYTE38);
    expect(c).toContain('struct Struct0 { s32 field_0; u8 _pad0[34]; u8 field_38; };');
    expect(c).toContain('a0->field_38 = *a1;');
    expect(c).not.toContain('(u8 *)a0 + 38');
  });

  test('a halfword at 70', () => {
    const c = lift('h2', HALF70);
    expect(c).toContain('struct Struct0 { s32 field_0; u8 _pad0[66]; u16 field_70; };');
    expect(c).toContain('a0->field_70 = *a1;');
  });

  test('a word at 128, beside a byte at 0', () => {
    const c = lift('h3', WORD128, 'agbcc', false);
    expect(c).toContain('struct Struct0 { u8 field_0; u8 _pad0[127]; s32 field_128; };');
    expect(c).toContain('a0->field_128');
  });

  test('REFUSES: two words at 0 and 128 are array-shaped, no struct evidence', () => {
    const c = lift('h4', WORDS, 'agbcc', false);
    expect(c).not.toContain('struct Struct');
    expect(c).toContain('*(a0 + 32)');
  });

  test('REFUSES: the address itself escapes to a call, so the source held it', () => {
    const c = decompile('r1', ESCAPES, targetFor('agbcc', canonicalFlagsOf('agbcc') ?? []).target, {
      prototypes: { r1: { returnsVoid: true, params: 2 }, use: { returnsVoid: true, params: 1 } },
    }).source;
    expect(c).toContain('*((u8 *)a0 + 38) = *a1;');
    expect(c).toContain('use((u8 *)a0 + 38);');
  });
});

// `struct S { s32 a; u8 pad[39995]; u8 big; }; void f(struct S *p, u32 x) { p->a = 1; p->big = x; }`
const FAR: [ToolchainId, string][] = [
  [
    'ido7.1',
    '00000000 <f>:\n   0:\tli\tt6,1\n   4:\tsw\tt6,0(a0)\n   8:\taddiu\tat,a0,32767\n   c:\tjr\tra\n  10:\tsb\ta1,7232(at)\n',
  ],
  [
    'gcc2.7.2kmc',
    '00000000 <f>:\n   0:\tli\tv0,1\n   4:\tsw\tv0,0(a0)\n   8:\tlui\tat,0x1\n   c:\taddu\tat,at,a0\n' +
      '  10:\tjr\tra\n  14:\tsb\ta1,-25537(at)\n',
  ],
  [
    'gcc2.7.2',
    '00000000 <f>:\n   0:\tli\tv0,1\n   4:\tsw\tv0,0(a0)\n   8:\tlui\tat,0x1\n   c:\taddu\tat,at,a0\n' +
      '  10:\tjr\tra\n  14:\tsb\ta1,-25537(at)\n',
  ],
  [
    'mwcc_242_81',
    '00000000 <f>:\n   0:\tli      r0,1\n   4:\taddis   r5,r3,1\n   8:\tstw     r0,0(r3)\n' +
      '   c:\tstb     r4,-25537(r5)\n  10:\tblr\n',
  ],
];

describe('a member past a 16-bit displacement is a member', () => {
  test.each(FAR)('%s', (tc, asm) => {
    const c = lift('f', asm, tc);
    expect(c).toContain('struct Struct0 { s32 field_0; u8 _pad0[39995]; u8 field_39999; };');
    expect(c).toContain('a0->field_39999 = a1;');
  });
});

// The refusals no compiled fixture reaches cheaply, on hand-written IR.
function emit(ir: string): { folded: number; c: string } {
  const fn = parse(ir);
  verify(fn);
  const folded = foldDisplacedAccesses(fn);
  recognizeStructs(fn, ARMV4T_AGBCC.compilerBehaviors.aggregateBoundary);
  recoverTypes(fn);
  verify(fn);
  return { folded, c: cBackend.emit(structure(fn, structureOptionsFor(ARMV4T_AGBCC, true))) };
}

describe('foldDisplacedAccesses refusals', () => {
  const twoAccesses = (store: string) => `fn f {
^bb0(%0: unk32, %1: unk32):
  %2: unk32 = const {value=38}
  %3: unk32 = add %0, %2
  ${store}
  store %0, %1 {off=0, width=4}
  ret
}
`;

  test('folds the plain shape', () => {
    expect(emit(twoAccesses('store %3, %1 {off=0, width=1}')).folded).toBe(1);
  });

  test('a volatile access stays on its materialised address', () => {
    const { folded, c } = emit(twoAccesses('store %3, %1 {off=0, width=1, volatile=true}'));
    expect(folded).toBe(0);
    expect(c).not.toContain('field_38');
  });

  test('a folded offset below zero', () => {
    expect(emit(twoAccesses('store %3, %1 {off=-40, width=1}')).folded).toBe(0);
  });

  test('a sub folds as a negative displacement', () => {
    const { folded, c } = emit(`fn f {
^bb0(%0: unk32, %1: unk32):
  %2: unk32 = const {value=8}
  %3: unk32 = sub %0, %2
  store %3, %1 {off=48, width=2}
  store %0, %1 {off=0, width=4}
  ret
}
`);
    expect(folded).toBe(1);
    expect(c).toContain('field_40');
  });

  test('an address that is a loop-carried induction step', () => {
    const { folded } = emit(`fn f {
^bb0(%0: unk32, %1: unk32):
  br ^bb1(%0)
^bb1(%2: unk32):
  %3: unk32 = const {value=40}
  %4: unk32 = add %2, %3
  store %4, %1 {off=0, width=1}
  store %2, %1 {off=0, width=4}
  %5: unk32 = icmp_ne %1, %3
  cond_br %5, ^bb1(%4), ^bb2()
^bb2():
  ret
}
`);
    expect(folded).toBe(0);
  });

  test('an overlap the fold would create', () => {
    const { folded } = emit(`fn f {
^bb0(%0: unk32, %1: unk32):
  %2: unk32 = const {value=2}
  %3: unk32 = add %0, %2
  store %3, %1 {off=0, width=2}
  store %0, %1 {off=0, width=4}
  ret
}
`);
    expect(folded).toBe(0);
  });
});
