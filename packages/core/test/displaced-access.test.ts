// A MEMBER PAST THE DISPLACEMENT RANGE (raise/structs.ts `foldDisplacedAccesses`). The machine
// reaches it through an address it materialises first; folded, the access joins its struct as a
// member. On agbcc a member store and a cast store build two objects (gcc/expr.c expand_assignment
// :2535 vs :2689): `sa3:sub_800F0E8` needs the member, and the cast (or a hoisted pointer) is the
// `/far-cast` lift, which keeps the store on its address. Every agbcc fixture is agbcc's own output at
// the corpus flags (`-mthumb-interwork -O2 -fhex-asm -fprologue-bugfix`), every MIPS/PPC one the
// toolchain's own disassembly at its canonical flags.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { without } from '../src/l3/gates';
import { decompile } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import {
  DISPLACED_BASE_GATES,
  DISPLACED_ROOT_GATES,
  type DisplacedBehaviors,
  type DisplacedOptions,
  foldDisplacedAccesses,
  recognizeStructs,
} from '../src/raise/structs';
import { compareScored } from '../src/rank';
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

// `struct S { s32 a; u16 b; u8 pad[32]; u8 f38; u8 f39; };
//  u32 l1(struct S *p) { u8 *d = &p->f38; return d[0] + d[1] + p->a; }`
// One `add #0x26` read at two offsets: the pointer the source held. The member spelling
// `p->f38 + p->f39` gives every access its own add (`add #0x26`, `add #0x27`).
const HELD_PAIR =
  'l1:\n\tadd\tr2, r0, #0\n\tadd\tr1, r2, #0\n\tadd\tr1, r1, #0x26\n\tldrb\tr0, [r1]\n' +
  '\tldrb\tr1, [r1, #0x1]\n\tadd\tr0, r0, r1\n\tldr\tr1, [r2]\n\tadd\tr0, r0, r1\n\tbx\tlr\n';
// `struct B { u8 a; u8 pad[37]; u8 c; }; void ub(struct B *p, u8 *q) { p->c = *q; p->a = 0; }`
// Every access one byte wide, so the access set alone is array-shaped; `*q` is loaded before the
// `add #0x26`, which is the member's order and no cast's or held pointer's.
const UNIFORM_MEMBER =
  'ub:\n\tldrb\tr2, [r1]\n\tadd\tr3, r0, #0\n\tadd\tr3, r3, #0x26\n\tmov\tr1, #0x0\n' +
  '\tstrb\tr2, [r3]\n\tstrb\tr1, [r0]\n\tbx\tlr\n';
// The same bytes through a cast, `*((u8 *)p + 38) = *q; p->a = 0;`: address first.
const UNIFORM_CAST =
  'uc:\n\tadd\tr2, r0, #0\n\tadd\tr2, r2, #0x26\n\tldrb\tr1, [r1]\n\tstrb\tr1, [r2]\n' +
  '\tmov\tr1, #0x0\n\tstrb\tr1, [r0]\n\tbx\tlr\n';
// `struct B { u8 a; u8 pad[37]; u8 c; u8 d; }; void s3(struct B *p) { p->d = p->c; }` — the second
// address lands in r0 and stays there at `bx lr`.
const IN_RETURN_REG =
  's3:\n\tadd\tr1, r0, #0\n\tadd\tr1, r1, #0x26\n\tldrb\tr1, [r1]\n\tadd\tr0, r0, #0x27\n' +
  '\tstrb\tr1, [r0]\n\tbx\tlr\n';

describe('what agbcc says about a far base beyond the access set', () => {
  test('REFUSES: one materialised base at two offsets is a held pointer', () => {
    const c = lift('l1', HELD_PAIR, 'agbcc', false);
    expect(c).not.toContain('struct Struct');
    expect(c).toContain('(u8 *)a0 + 38');
  });

  test('a uniform-width root whose far store shows the member order is a struct', () => {
    const c = lift('ub', UNIFORM_MEMBER);
    expect(c).toContain('struct Struct0 { u8 field_0; u8 _pad0[37]; u8 field_38; };');
    expect(c).toContain('a0->field_38 = *a1;');
  });

  test('the same root stored address-first stays on its address', () => {
    const c = lift('uc', UNIFORM_CAST);
    expect(c).not.toContain('struct Struct');
    expect(c).toContain('*(a0 + 38) = *a1;');
  });

  test('an address left in the return register of a void function is not held', () => {
    const c = lift('s3', IN_RETURN_REG);
    expect(c).toContain('a0->field_39 = a0->field_38;');
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

// ido past the `addiu` reach. `struct H { s32 a; u8 pad[199996]; u8 b; u8 b1; u16 b2; u32 c; };`
// The member spelling `p->b = *q; p->c = 0;` gives each access its own `lui at, 3; addu`; a held
// `struct Msg *m = &play->msg; m->a = *q; return m->c;` (msg at 0x10A24) shares one `addu v1`.
const IDO_MEMBERS =
  '00000000 <m1>:\n   0:\tlbu\tt6,0(a1)\n   4:\tlui\tat,0x3\n   8:\taddu\tat,at,a0\n   c:\tsb\tt6,3392(at)\n' +
  '  10:\tlui\tat,0x3\n  14:\taddu\tat,at,a0\n  18:\tjr\tra\n  1c:\tsw\tzero,3396(at)\n';
const IDO_HELD =
  '00000000 <o1>:\n   0:\tlbu\tt6,0(a1)\n   4:\tlui\tat,0x1\n   8:\taddu\tv1,a0,at\n   c:\tlw\tv0,2600(v1)\n' +
  '  10:\tjr\tra\n  14:\tsb\tt6,2596(v1)\n';

describe('what ido says about a far base past its addiu reach', () => {
  test('one lui/addu per access is the member spelling', () => {
    const c = lift('m1', IDO_MEMBERS, 'ido7.1');
    expect(c).toContain('a0->field_200000 = *a1;');
    expect(c).toContain('a0->field_200004 = 0;');
  });

  test('REFUSES: one lui/addu read and written at two offsets is a held pointer', () => {
    const c = lift('o1', IDO_HELD, 'ido7.1', false);
    expect(c).not.toContain('field_68132');
    expect(c).toContain('65536');
  });
});

// The refusals no compiled fixture reaches cheaply, on hand-written IR.
function emit(ir: string, opts: DisplacedOptions = {}): { folded: number; c: string } {
  const fn = parse(ir);
  verify(fn);
  const folded = foldDisplacedAccesses(fn, opts);
  recognizeStructs(fn, ARMV4T_AGBCC.compilerBehaviors.aggregateBoundary);
  recoverTypes(fn);
  verify(fn);
  return { folded, c: cBackend.emit(structure(fn, structureOptionsFor(ARMV4T_AGBCC, true))) };
}

describe('the fold reads its target facts', () => {
  // `%3 = add %0, 38` read at offsets 0 and 1.
  const shared = `fn f {
^bb0(%0: unk32):
  %2: unk32 = const {value=38}
  %3: unk32 = add %0, %2
  %4: unk32 = load %3 {off=0, width=1, signed=false}
  %5: unk32 = load %3 {off=1, width=1, signed=false}
  %6: unk32 = load %0 {off=0, width=4, signed=false}
  %7: unk32 = add %4, %5
  %8: unk32 = add %7, %6
  ret %8
}
`;
  const fold = (behaviors: DisplacedBehaviors, base = DISPLACED_BASE_GATES, root = DISPLACED_ROOT_GATES) => {
    const fn = parse(shared);
    verify(fn);
    return foldDisplacedAccesses(fn, {}, behaviors, false, base, root);
  };

  test('a shared base at two offsets folds where members share one base (ido, mwcc)', () => {
    expect(fold({})).toBe(2);
  });

  test('past its reach only: ido shares an addiu base, and builds a lui base per access', () => {
    expect(fold({ farMemberBasePerAccess: { past: 32767 } })).toBe(2);
    const far = (k: number) => {
      const fn = parse(shared.replace('{value=38}', `{value=${k}}`));
      verify(fn);
      return foldDisplacedAccesses(fn, {}, { farMemberBasePerAccess: { past: 32767 } });
    };
    expect(far(32767)).toBe(2);
    expect(far(196608)).toBe(0);
  });

  test('and is refused where every member access gets its own base (agbcc)', () => {
    expect(fold({ farMemberBasePerAccess: { past: 0 } })).toBe(0);
    expect(fold({ farMemberBasePerAccess: { past: 0 } }, without(DISPLACED_BASE_GATES, 'held-pointer-offsets'))).toBe(
      2,
    );
  });

  // `store %3, %v` with `%v` loaded before the add: the member's order on agbcc.
  const uniform = `fn f {
^bb0(%0: unk32, %1: unk32):
  %4: unk32 = load %1 {off=0, width=1, signed=false}
  %2: unk32 = const {value=38}
  %3: unk32 = add %0, %2
  store %3, %4 {off=0, width=1}
  %5: unk32 = const {value=0}
  store %0, %5 {off=0, width=1}
  ret
}
`;
  const foldUniform = (behaviors: DisplacedBehaviors, root = DISPLACED_ROOT_GATES) => {
    const fn = parse(uniform);
    verify(fn);
    return foldDisplacedAccesses(fn, {}, behaviors, true, DISPLACED_BASE_GATES, root);
  };

  test('a uniform-width root folds on the store order only where that order names the member', () => {
    expect(foldUniform({})).toBe(0);
    expect(foldUniform({ farMemberStoreOrder: true })).toBe(1);
  });

  test('array-shaped is what refuses it elsewhere', () => {
    expect(foldUniform({}, without(DISPLACED_ROOT_GATES, 'array-shaped'))).toBe(1);
  });

  // A value an EARLIER statement computed — `u8 v = *q; *r = 0; p[38] = v;` and `*r = v; p[38] = v;`
  // — is loaded before the address by the member and the cast spelling alike: no evidence.
  const earlier = (between: string) => `fn f {
^bb0(%0: unk32, %1: unk32, %9: unk32):
  %4: unk32 = load %1 {off=0, width=1, signed=false}
  ${between}
  %2: unk32 = const {value=38}
  %3: unk32 = add %0, %2
  store %3, %4 {off=0, width=1}
  %5: unk32 = const {value=0}
  store %0, %5 {off=0, width=1}
  ret
}
`;
  test('a value an earlier statement computed is no member order', () => {
    const run = (between: string) => {
      const fn = parse(earlier(between));
      verify(fn);
      return foldDisplacedAccesses(fn, {}, { farMemberStoreOrder: true }, true);
    };
    expect(run('')).toBe(1);
    expect(run('%7: unk32 = const {value=0}\n  store %9, %7 {off=0, width=1}')).toBe(0);
    expect(run('store %9, %4 {off=0, width=1}')).toBe(0);
  });
});

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

  test('folds the plain shape, and reports the store it folded', () => {
    let reported = 0;
    const { folded } = emit(twoAccesses('store %3, %1 {off=0, width=1}'), { onFoldedStore: () => reported++ });
    expect(folded).toBe(1);
    expect(reported).toBe(1);
  });

  // `/far-cast`: agbcc builds the cast's object for `*((u8 *)p + 38) = v` and for a hoisted
  // `u8 *d = &p->f38; *d = v;`, so the lift that keeps a store on its address is the differ's.
  test('/far-cast keeps a store on its address and still folds a load', () => {
    const ir = `fn f {
^bb0(%0: unk32, %1: unk32):
  %2: unk32 = const {value=38}
  %3: unk32 = add %0, %2
  store %3, %1 {off=0, width=1}
  %4: unk32 = const {value=40}
  %5: unk32 = add %0, %4
  %6: unk32 = load %5 {off=0, width=1, signed=false}
  store %0, %6 {off=0, width=4}
  ret
}
`;
    let reported = 0;
    const { folded, c } = emit(ir, { keepStores: true, onFoldedStore: () => reported++ });
    expect(folded).toBe(1);
    expect(reported).toBe(0);
    expect(c).toContain('field_40');
    expect(c).not.toContain('field_38');
    expect(c).toContain('(u8 *)a0 + 38');
  });

  // `*(u16 *)(x + 0x6000000)`: an address constant added to an index, never a member offset.
  test('a displacement of 16 MiB or more is an address constant', () => {
    const ir = twoAccesses('store %3, %1 {off=0, width=1}').replace('{value=38}', '{value=100663296}');
    expect(emit(ir).folded).toBe(0);
    expect(emit(ir.replace('{value=100663296}', '{value=16777215}')).folded).toBe(1);
  });

  // `u16 *d = &p->f68; p->f38 = *q; return d[0] + d[1];` on agbcc: the held `d` stays on its
  // address and the member store beside it still folds.
  test('a refused base leaves the other bases of its root to fold', () => {
    const fn = parse(`fn f {
^bb0(%0: unk32, %1: unk32):
  %2: unk32 = const {value=68}
  %3: unk32 = add %0, %2
  %4: unk32 = load %1 {off=0, width=1, signed=false}
  %5: unk32 = const {value=38}
  %6: unk32 = add %0, %5
  store %6, %4 {off=0, width=1}
  %7: unk32 = load %3 {off=0, width=2, signed=false}
  %8: unk32 = load %3 {off=2, width=2, signed=false}
  %9: unk32 = load %0 {off=0, width=4, signed=false}
  %10: unk32 = add %7, %8
  %11: unk32 = add %10, %9
  ret %11
}
`);
    verify(fn);
    expect(foldDisplacedAccesses(fn, {}, { farMemberBasePerAccess: { past: 0 } })).toBe(1);
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

describe('/far-cast loses a score tie to the member spelling', () => {
  const cand = (variations: string[], source: string, order: number, farStoreCast?: true) => ({
    variations,
    source,
    preference: 0,
    order,
    score: { score: 0 },
    ...(farStoreCast ? { farStoreCast } : {}),
  });
  test('a shorter cast spelling enumerated first still ranks behind the member', () => {
    const cast = cand(['unsigned', 'far-cast'], 'void f(s32 *a0) {\n    *((u8 *)a0 + 38) = 1;\n}\n', 0, true);
    const member = cand(
      ['unsigned'],
      'struct Struct0 { s32 field_0; u8 _pad0[34]; u8 field_38; };\nvoid f(struct Struct0 *a0) {\n    a0->field_38 = 1;\n}\n',
      1,
    );
    expect([cast, member].sort(compareScored)[0]).toBe(member);
    expect([member, { ...cast, score: { score: -1 } }].sort(compareScored)[0].variations).toEqual([
      'unsigned',
      'far-cast',
    ]);
  });
});
