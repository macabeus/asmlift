// A READ OF A VOLATILE OBJECT IN A `&&`/`||`'s GUARDED OPERAND.
//
// `raise/shortcircuit.ts` may hoist a plain read out of the arm it guards, on the contract that the
// structurer inlines it back under C's own short circuit. It never hoists a qualified one (ir/
// discipline.ts `speculationUnsafe`), so a qualified read a connective reads ran above the branch,
// on every path, and the structurer names it there, as it names a call
// (`guarded-arm-call.test.ts`). For an ordinary cell the read stays in the connective.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { decompile } from '../src/pipeline';
import { stampDeclaredVolatile } from '../src/raise/declared-volatile';
import { recoverTypes } from '../src/raise/recover';
import { enumerateCandidates } from '../src/rank';
import { structure } from '../src/structure/structure';
import type { SymbolInfo } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

/** Structure `ir` under `symbols`, stamped as the lift stamps it, before any raising pass. */
const emitWith = (ir: string, symbols?: Map<string, SymbolInfo>): string => {
  const fn = parse(ir);
  verify(fn);
  stampDeclaredVolatile(fn, symbols, ARMV4T_AGBCC.compilerBehaviors);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, { returnsVoid: true, ...(symbols ? { symbols } : {}) }));
};

const VOLATILE_MAP = new Map<string, SymbolInfo>([['gVolReg', { name: 'gVolReg', kind: 'data', volatile: true }]]);
const PLAIN_MAP = new Map<string, SymbolInfo>([['gVolReg', { name: 'gVolReg', kind: 'data' }]]);

// `int t = gVolReg; if (a0 > 0 && t != 0) g(a0);` — the read is the connective's SECOND operand,
// defined above the branch.
const GUARDED_READ = `fn v {
^bb0(%0: s32):
  %1: s32* = gaddr {sym="gVolReg"}
  %2: s32 = load %1 {off=0, signed=true, width=4}
  %3: s32 = const {value=0}
  %4: u32 = icmp_sgt %0, %3
  %5: u32 = icmp_ne %2, %3
  %6: u32 = logic_and %4, %5
  cond_br %6, ^bb1(), ^bb2()
^bb1():
  %7: s32 = call %0 {target="g"}
  br ^bb2()
^bb2():
  ret
}
`;

/** `name` read into a local above the connective, and the local in its guarded operand. */
const namedAbove = (read: string): RegExp =>
  new RegExp(`(v\\d+) = ${read.replace(/[[\]().*]/g, '\\$&')};\\s*\\n\\s*if \\(a0 > 0 && \\1 != 0\\)`);

test('a volatile read in an `&&`’s guarded operand is named above the connective', () => {
  expect(emitWith(GUARDED_READ, VOLATILE_MAP)).toMatch(namedAbove('gVolReg'));
});

test('a volatile read in that operand placed only as structuring starts declines', () => {
  // Plain to every raising pass, so a fold may have lifted it out of the arm it ran in.
  const fn = parse(GUARDED_READ);
  verify(fn);
  recoverTypes(fn);
  expect(() => structure(fn, { returnsVoid: true, symbols: VOLATILE_MAP })).toThrow(
    "cannot structure 'v': a '&&'/'||' would guard a read of the volatile object 'gVolReg', and which side of the branch the asm read it on is not recoverable",
  );
});

test('the declaration is what decides it — an ordinary cell keeps the connective', () => {
  const plain = emitWith(GUARDED_READ, PLAIN_MAP);
  expect(plain).toContain('a0 > 0 && gVolReg != 0');
  // and a map that does not carry the cell at all knows nothing, which is the same answer
  expect(emitWith(GUARDED_READ)).toBe(plain);
});

test('the FIRST operand is unconditional, so a volatile read there is placed already', () => {
  // The one-fact edit: C evaluates `gVolReg != 0` on every evaluation of the test, which is what
  // the asm does, and no fold can have moved it into that position.
  const src = emitWith(GUARDED_READ.replace('logic_and %4, %5', 'logic_and %5, %4'), VOLATILE_MAP);
  expect(src).toContain('gVolReg != 0 && a0 > 0');
});

// `extern volatile int gVolArr[8]; … if (a > 0 && gVolArr[i] != 0) g(a);` — the same hazard reached
// by a SUBSCRIPT, which names the object and no cell. The two agbcc objects, the `ldr` above the
// `cmp` and below the `ble`, emitted one `if (a0 > 0 && gVolArr[a1] != 0)` between them. The walked
// twin is the same access with no `aload` recovered: `gaddr + (i << 2)` under a plain `load`, which
// is what the base has to answer for when the offset is a runtime term either way.
const GUARDED_ELEMENT = `fn v {
^bb0(%0: s32, %1: s32):
  %2: s32* = gaddr {sym="gVolArr"}
  %3: s32 = aload %2, %1 {elemSize=4, signed=true}
  %4: s32 = const {value=0}
  %5: u32 = icmp_sgt %0, %4
  %6: u32 = icmp_ne %3, %4
  %7: u32 = logic_and %5, %6
  cond_br %7, ^bb1(), ^bb2()
^bb1():
  %8: s32 = call %0 {target="g"}
  br ^bb2()
^bb2():
  ret
}
`;

const GUARDED_WALKED = `fn v {
^bb0(%0: s32, %1: s32):
  %2: s32* = gaddr {sym="gVolArr"}
  %3: s32 = const {value=2}
  %4: s32 = shl %1, %3
  %5: s32* = add %2, %4
  %6: s32 = load %5 {off=0, signed=true, width=4}
  %7: s32 = const {value=0}
  %8: u32 = icmp_sgt %0, %7
  %9: u32 = icmp_ne %6, %7
  %10: u32 = logic_and %8, %9
  cond_br %10, ^bb1(), ^bb2()
^bb1():
  %11: s32 = call %0 {target="g"}
  br ^bb2()
^bb2():
  ret
}
`;

const VOLATILE_ARRAY = new Map<string, SymbolInfo>([
  [
    'gVolArr',
    {
      name: 'gVolArr',
      kind: 'data',
      volatile: true,
      shape: 'array',
      size: 32,
      elemSize: 4,
      elemSigned: true,
      dims: [8],
    },
  ],
]);

test.each([
  ['a subscript', GUARDED_ELEMENT],
  ['walked arithmetic', GUARDED_WALKED],
  ['a walk that counts down', GUARDED_WALKED.replace('add %2, %4', 'sub %2, %4')],
])('%s reaches the same volatile object, so it is named too', (_label, ir) => {
  expect(emitWith(ir, VOLATILE_ARRAY)).toMatch(/(v\d+) = .*gVolArr.*;\s*\n\s*if \(a0 > 0 && \1 != 0\)/);
});

// A MIXED-VOLATILITY STRUCT, which is what the `vu16 field;` idiom produces: pokeemerald's `gMain`
// declares 23 members and qualifies one, and six more of the corpus's mapped globals have the same
// shape. The guarded read is decided per MEMBER — the qualified one is the hazard above, an
// ordinary one beside it is an ordinary cell whose placement is a matching question.
const GUARDED_MEMBER = (off: number): string => `fn v {
^bb0(%0: s32):
  %1: s32* = gaddr {sym="gIo"}
  %2: s32 = load %1 {off=${off}, signed=true, width=4}
  %3: s32 = const {value=0}
  %4: u32 = icmp_sgt %0, %3
  %5: u32 = icmp_ne %2, %3
  %6: u32 = logic_and %4, %5
  cond_br %6, ^bb1(), ^bb2()
^bb1():
  %7: s32 = call %0 {target="g"}
  br ^bb2()
^bb2():
  ret
}
`;

const MIXED_STRUCT = new Map<string, SymbolInfo>([
  [
    'gIo',
    {
      name: 'gIo',
      kind: 'data',
      shape: 'struct',
      structName: 'S',
      size: 8,
      layout: [
        { name: 'a', offset: 0, size: 4, signed: true },
        { name: 'b', offset: 4, size: 4, signed: true, volatile: true },
      ],
    },
  ],
]);

test('a plain member of a partly-volatile struct keeps the connective', () => {
  expect(emitWith(GUARDED_MEMBER(0), MIXED_STRUCT)).toContain('a0 > 0 && gIo.a != 0');
});

test('the volatile member of that same struct is named, through a qualified cast', () => {
  expect(emitWith(GUARDED_MEMBER(4), MIXED_STRUCT)).toMatch(namedAbove('((volatile s32 *)&gIo)[1]'));
});

// agbcc -O2 of `extern volatile int gVolReg; void v(int a) { if (a > 0 && gVolReg != 0) g(a); }`: the
// `ldr` runs only past the `ble`. The read is stamped as the lift is made, so the short-circuit fold
// leaves it in the arm it guards, and the structurer spells it there.
const BELOW_THE_GUARD =
  'v:\n\tpush\t{lr}\n\tadd\tr1, r0, #0\n\tcmp\tr1, #0\n\tble\t.L3\n\tldr\tr0, .L4\n\tldr\tr0, [r0]\n' +
  '\tcmp\tr0, #0\n\tbeq\t.L3\n\tadd\tr0, r1, #0\n\tbl\tg\n.L3:\n\tpop\t{r0}\n\tbx\tr0\n' +
  '.L4:\n\t.word\tgVolReg\n';

test('a volatile read the asm makes only past the guard is spelled under it', () => {
  const symbols = new Map([[0x3000000, [{ name: 'gVolReg', kind: 'data' as const, volatile: true }]]]);
  const prototypes = { v: { params: 1, returnsVoid: true }, g: { params: 1, returnsVoid: true } };
  const src = decompile('v', BELOW_THE_GUARD, ARMV4T_AGBCC, { symbols, prototypes }).source;
  expect(src).toMatch(/if \(a0 > 0\) \{\s*if \(gVolReg != 0\) g\(a0\);\s*\}/);
});

// agbcc -O2 of `extern volatile unsigned short gVolReg; void f(int a) { int t = gVolReg; if (a > 0 &&
// t != 0) g(a); }`: the `ldrh` runs above the first compare, on every path.
const ABOVE_THE_GUARD =
  'f:\n\tpush\t{lr}\n\tadd\tr1, r0, #0\n\tldr\tr0, .L4\n\tldrh\tr0, [r0]\n\tcmp\tr1, #0\n\tble\t.L3\n' +
  '\tcmp\tr0, #0\n\tbeq\t.L3\n\tadd\tr0, r1, #0\n\tbl\tg\n.L3:\n\tpop\t{r0}\n\tbx\tr0\n' +
  '.L4:\n\t.word\tgVolReg\n';

test('a volatile read the asm makes above the guard is named there, on every entry path', () => {
  const symbols = new Map([[0x3000000, [{ name: 'gVolReg', kind: 'data' as const, volatile: true }]]]);
  const prototypes = { f: { params: 1, returnsVoid: true }, g: { params: 1, returnsVoid: true } };
  const above = /(v\d+) = gVolReg;\s*\n\s*if \((?:\(s32\))?a0 > 0 && \1 != 0\) g\(a0\);/;
  expect(decompile('f', ABOVE_THE_GUARD, ARMV4T_AGBCC, { symbols, prototypes }).source).toMatch(above);
  const [first] = enumerateCandidates('f', ABOVE_THE_GUARD, ARMV4T_AGBCC, { symbols, prototypes });
  expect(first.source).toMatch(above);
});

// agbcc -O2 of `void f1(int a, int b) { volatile u16 *p; if (a) { p = &gVolReg; g(1); } else { p =
// &gVolReg; g(2); } if (b > 0 && *p != 0) g(3); }`: each arm loads the address into r5, and the
// `ldrh` through it runs only past the `ble`. The base the read names is the join of the two.
const BELOW_THE_GUARD_THROUGH_A_JOIN =
  'f1:\n\tpush\t{r4, r5, lr}\n\tadd\tr4, r1, #0\n\tcmp\tr0, #0\n\tbeq\t.L3\n\tldr\tr5, .L6\n\tmov\tr0, #1\n' +
  '\tbl\tg\n\tb\t.L4\n.L6:\n\t.word\tgVolReg\n.L3:\n\tldr\tr5, .L8\n\tmov\tr0, #2\n\tbl\tg\n' +
  '.L4:\n\tcmp\tr4, #0\n\tble\t.L5\n\tldrh\tr0, [r5]\n\tcmp\tr0, #0\n\tbeq\t.L5\n\tmov\tr0, #3\n\tbl\tg\n' +
  '.L5:\n\tpop\t{r4, r5}\n\tpop\t{r0}\n\tbx\tr0\n.L8:\n\t.word\tgVolReg\n';

test('a volatile read through a join of two spellings of its address is spelled under the guard', () => {
  const symbols = new Map([[0x3000000, [{ name: 'gVolReg', kind: 'data' as const, volatile: true }]]]);
  const prototypes = { f1: { params: 2, returnsVoid: true }, g: { params: 1, returnsVoid: true } };
  const below = /if \(a1 > 0\) \{\s*if \(gVolReg != 0\) g\(3\);\s*\}/;
  expect(decompile('f1', BELOW_THE_GUARD_THROUGH_A_JOIN, ARMV4T_AGBCC, { symbols, prototypes }).source).toMatch(below);
  for (const c of enumerateCandidates('f1', BELOW_THE_GUARD_THROUGH_A_JOIN, ARMV4T_AGBCC, { symbols, prototypes })) {
    expect(c.source, c.variations.join('/')).not.toMatch(/= gVolReg;/);
  }
});
