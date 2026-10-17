// PowerPC loads and stores WITH UPDATE (`lbzu rD,D(rA)`: rA += D, then rD = *(u8 *)rA), which
// frontend/ppc.ts decodes as the `addi rA,rA,D` it already lifts followed by the plain access at
// `0(rA)` (`withUpdate`). The listings are mwcc's (242 -O4,p), relocation lines and all: a fully
// unrolled table scan, a struct copy's word loop, and the first access of a run over a global
// table, whose displacement is the `@l` half of the table's address.
//
// The test of the decode is an EQUIVALENCE, so it does not depend on how the lift is spelled: each
// listing must lift to exactly the C of the same listing with every update form written out as
// the two instructions the ISA defines it as.
import { expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { PPC_MWCC } from '../src/target';

const dis = (sym: string, lines: string[]) =>
  decompile(sym, `0 <${sym}>:\n${lines.join('\n')}\n`, PPC_MWCC, {
    prototypes: { [sym]: { returnsVoid: !/^(hfind|scan|walk|lha)/.test(sym) } },
  }).source;

/** The listing with each update form `Xu rD,D(rA)` written out as `addi rA,rA,D` (carrying the
 *  form's relocation) and then `X rD,0(rA)`, at a fresh address no branch names. */
const writtenOut = (lines: string[]): string[] =>
  lines.flatMap((line, k) => {
    const m = line.match(/^\s*([0-9a-f]+):\t(lbzu|lhzu|lhau|lwzu|stbu|sthu|stwu)\s+(r\d+),(-?\d+)\((r\d+)\)$/);
    if (m === null || m[5] === 'r1') {
      return /R_PPC/.test(line) && writtenOut([lines[k - 1]]).length === 2 ? [] : [line];
    }
    const [, addr, mn, r, d, base] = m;
    const reloc = /R_PPC/.test(lines[k + 1] ?? '') ? [lines[k + 1]] : [];
    return [
      `  ${addr}:\taddi    ${base},${base},${d}`,
      ...reloc,
      `  ${(parseInt(addr, 16) + 2).toString(16)}:\t${mn.slice(0, -1)}     ${r},0(${base})`,
    ];
  });

// break_value at 242 -O4,p, cut to three probes of the unrolled `for (i = 1; i < 9; i++)` scan.
const SCAN = [
  '   0:\tlis     r3,0',
  '\t\t\t2: R_PPC_ADDR16_HA\tgTab',
  '   4:\tli      r4,1',
  '   8:\taddi    r3,r3,0',
  '\t\t\ta: R_PPC_ADDR16_LO\tgTab',
  '   c:\tlbz     r0,1(r3)',
  '  10:\tcmplwi  r0,28',
  '  14:\tbne-    20 <scan+0x20>',
  '  18:\tli      r4,1',
  '  1c:\tb       48 <scan+0x48>',
  '  20:\tlbzu    r0,2(r3)',
  '  24:\tcmplwi  r0,28',
  '  28:\tbne-    34 <scan+0x34>',
  '  2c:\tli      r4,2',
  '  30:\tb       48 <scan+0x48>',
  '  34:\tlbzu    r0,1(r3)',
  '  38:\tcmplwi  r0,28',
  '  3c:\tbne-    48 <scan+0x48>',
  '  40:\tli      r4,3',
  '  44:\tb       48 <scan+0x48>',
  '  48:\tmr      r3,r4',
  '  4c:\tblr',
];

// `*d = *s` for a 72-byte struct: the word loop of mwcc's copy, at every optimisation level.
const COPY = [
  '   0:\tli      r0,9',
  '   4:\taddi    r5,r3,-4',
  '   8:\taddi    r4,r4,-4',
  '   c:\tmtctr   r0',
  '  10:\tlwz     r3,4(r4)',
  '  14:\tlwzu    r0,8(r4)',
  '  18:\tstw     r3,4(r5)',
  '  1c:\tstwu    r0,8(r5)',
  '  20:\tbdnz+   10 <scopy+0x10>',
  '  24:\tblr',
];

// `for (i = 0; i < 8; i++) if (gH[i] == x) return i;`, cut to two probes: the FIRST load's
// displacement is the `@l` half of `gH`, and leaves `&gH` in r4.
const HSCAN = [
  '   0:\tlis     r4,0',
  '\t\t\t2: R_PPC_ADDR16_HA\tgH',
  '   4:\tlhzu    r0,0(r4)',
  '\t\t\t6: R_PPC_ADDR16_LO\tgH',
  '   8:\tclrlwi  r3,r3,16',
  '   c:\tcmplw   r3,r0',
  '  10:\tbne-    1c <hfind+0x1c>',
  '  14:\tli      r3,0',
  '  18:\tblr',
  '  1c:\tlhzu    r0,2(r4)',
  '  20:\tcmplw   r3,r0',
  '  24:\tbne-    30 <hfind+0x30>',
  '  28:\tli      r3,1',
  '  2c:\tblr',
  '  30:\tli      r3,-1',
  '  34:\tblr',
];

// `for (i = 0; i < 8; i++) gB[i] = v;`, cut to three stores: only the first is an update form.
const FILL = [
  '   0:\tlis     r4,0',
  '\t\t\t2: R_PPC_ADDR16_HA\tgB',
  '   4:\tstbu    r3,0(r4)',
  '\t\t\t6: R_PPC_ADDR16_LO\tgB',
  '   8:\tstb     r3,1(r4)',
  '   c:\tstb     r3,2(r4)',
  '  10:\tblr',
];

test('a load with update lifts as the add and the plain load the ISA defines it as', () => {
  const src = dis('scan', SCAN);
  expect(src).toBe(dis('scan', writtenOut(SCAN)));
  // The advanced base is what the NEXT update form adds to: offsets 1, 1+2 and 1+2+1 of gTab.
  expect(src).toContain('gTab');
  expect(src).not.toMatch(/ASMLIFT_ERROR|unmodelled/);
});

test('a loop-carried load and store with update advance their bases on every trip', () => {
  const src = dis('scopy', COPY);
  expect(src).toBe(dis('scopy', writtenOut(COPY)));
  // Both bases are loop-carried: each trip reads and writes 8 bytes (two words) past the last.
  expect(src).toMatch(/(v\d+) = \1 \+ 2;[^]*(v\d+) = \2 \+ 2;/);
});

test("an '@l' displacement completes its 'lis' and leaves the address in the base", () => {
  const h = dis('hfind', HSCAN);
  expect(h).toBe(dis('hfind', writtenOut(HSCAN)));
  expect(h).toContain('gH');
  const f = dis('fill', FILL);
  expect(f).toBe(dis('fill', writtenOut(FILL)));
  expect(f).toContain('gB');
});

test('a signed halfword load with update keeps its sign extension', () => {
  const lines = ['   0:\tlhau    r0,2(r4)', '   4:\tlha     r3,2(r4)', '   8:\tadd     r3,r3,r0', '   c:\tblr'];
  const src = dis('lha', lines);
  expect(src).toBe(dis('lha', writtenOut(lines)));
  expect(src).toMatch(/s16/);
});

test('an update form with no single meaning, or one that moves r1, refuses', () => {
  const one = (line: string) => () => dis('walk', [`   0:\t${line}`, '   4:\tmr      r3,r0', '   8:\tblr']);
  // the ISA's invalid forms: a base field of 0, and a load into its own base
  expect(one('lbzu    r0,1(r0)')).toThrow(/load with update not modelled — its base is r0/);
  expect(one('lwzu    r4,4(r4)')).toThrow(/loads into its own base r4, which the ISA makes an invalid form/);
  expect(one('stbu    r0,1(r0)')).toThrow(/store with update not modelled — its base is r0/);
  // a store of its own base stores the value BEFORE the update
  expect(one('stwu    r4,4(r4)')).toThrow(/stores its own base r4, whose stored value is the one before/);
  // r1 is moved only by the frame push and `addi r1,r1,N`
  expect(one('lwzu    r0,8(r1)')).toThrow(/moves the stack pointer/);
  // a relocation no compiler puts on an update form
  expect(() =>
    dis('walk', ['   0:\tlbzu    r0,0(r4)', '\t\t\t2: R_PPC_EMB_SDA21\tgB', '   4:\tmr      r3,r0', '   8:\tblr']),
  ).toThrow(/carries a 'R_PPC_EMB_SDA21' relocation/);
});

test("'stwu' on r1 keeps the frame push's rule: a second push or another source refuses", () => {
  // ac-decomp's select_draw_main pushes 'stwu r0,-48(r1)' mid-body.
  expect(() =>
    dis('push', ['   0:\tstwu    r1,-16(r1)', '   4:\tstwu    r0,-48(r1)', '   8:\taddi    r1,r1,16', '   c:\tblr']),
  ).toThrow(/is not the one frame push from the entry stack pointer — it stores r0, not the back chain/);
});

test('the indexed and floating-point update forms stay unmodelled, loudly', () => {
  // hand-written asm only, in the corpus
  expect(() => dis('walk', ['   0:\tlwzux   r0,r3,r4', '   4:\tmr      r3,r0', '   8:\tblr'])).toThrow(
    /unresolvable|unmodelled/,
  );
  expect(() => dis('walk', ['   0:\tstbux   r0,r3,r4', '   4:\tblr'])).toThrow(/stbux/);
  // the plain `lfs`/`stfs` are not lifted either
  expect(() => dis('walk', ['   0:\tlfsu    f1,4(r3)', '   4:\tblr'])).toThrow(/lfsu/);
});

test('a copy into a local through a base stepped by update forms declines at the frame audit', () => {
  // `struct Big b; b = *s; useb(&b);`: the copy's destination base is `addi r5,r1,4`, a word BELOW
  // the object at r1+8, and every `stwu r0,8(r5)` steps it. Stepped from below the area, or from
  // inside it (`lcopy2`, the base at r1+16 over `s32 pad[3]` and the struct), the audit names no
  // one object the stores reach, and the lift declines rather than guess one.
  const copyInto = (sym: string, base: number, callee: string) => [
    '   0:\tstwu    r1,-96(r1)',
    '   4:\tmflr    r0',
    '   8:\taddi    r4,r3,-4',
    '   c:\tstw     r0,100(r1)',
    '  10:\tli      r0,9',
    `  14:\taddi    r5,r1,${base}`,
    '  18:\tmtctr   r0',
    '  1c:\tlwz     r3,4(r4)',
    '  20:\tlwzu    r0,8(r4)',
    '  24:\tstw     r3,4(r5)',
    '  28:\tstwu    r0,8(r5)',
    `  2c:\tbdnz+   1c <${sym}+0x1c>`,
    `  30:\taddi    r3,r1,${base + 4}`,
    '  34:\tbl      34 <lcopy+0x34>',
    `\t\t\t34: R_PPC_REL24\t${callee}`,
    '  38:\tlwz     r0,100(r1)',
    '  3c:\tmtlr    r0',
    '  40:\taddi    r1,r1,96',
    '  44:\tblr',
  ];
  expect(() => dis('lcopy', copyInto('lcopy', 4, 'useb'))).toThrow(/address-taken stack local/);
  expect(() => dis('lcopy2', copyInto('lcopy2', 16, 'useb'))).toThrow(/address-taken stack local/);
});
