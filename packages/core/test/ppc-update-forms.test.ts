// PowerPC loads and stores WITH UPDATE (`lbzu rD,D(rA)`: rA += D, then rD = *(u8 *)rA), which
// frontend/ppc.ts decodes as the `addi rA,rA,D` it already lifts followed by the plain access at
// `0(rA)` (`withUpdate`). The listings are mwcc's (242 -O4,p), relocation lines and all: a fully
// unrolled table scan, a struct copy's word loop, and the first access of a run over a global
// table, whose displacement is the `@l` half of the table's address.
//
// The test of the decode is an EQUIVALENCE, so it does not depend on how the lift is spelled: each
// listing must lift to exactly the C of the same listing with every update form written out as
// the two instructions the ISA defines it as. That expansion is the decode's own definition, so a
// separate test pins the ISA's order (access at rA + D, then rA = rA + D) against the C itself.
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
  // r1 is moved only by the frame push and `addi r1,r1,N`, and a load into it would be dropped
  expect(one('lwzu    r0,8(r1)')).toThrow(/moves the stack pointer/);
  expect(one('lwzu    r1,4(r3)')).toThrow(/loads into the stack pointer/);
  expect(one('lbzu    r1,1(r3)')).toThrow(/loads into the stack pointer/);
  // a relocation no compiler puts on an update form
  expect(() =>
    dis('walk', ['   0:\tlbzu    r0,0(r4)', '\t\t\t2: R_PPC_EMB_SDA21\tgB', '   4:\tmr      r3,r0', '   8:\tblr']),
  ).toThrow(/carries a 'R_PPC_EMB_SDA21' relocation/);
});

test('a write to r1 refuses, by any instruction, rather than lifting as a dropped read', () => {
  // A longjmp's `lwz r1,4(r3)`, a context switch's `mr r1,r10`: nothing reads r1 as a value, so the
  // write would vanish and the load would lift as a discarded volatile read.
  const one = (line: string) => () => dis('walk', [`   0:\t${line}`, '   4:\tblr']);
  expect(one('lwz     r1,4(r3)')).toThrow(/'lwz r1,4\(r3\)' at 0x0 writes the stack pointer r1/);
  expect(one('lbz     r1,4(r3)')).toThrow(/writes the stack pointer r1/);
  expect(one('lwzx    r1,r3,r4')).toThrow(/writes the stack pointer r1/);
  expect(one('mr      r1,r3')).toThrow(/'mr r1,r3' at 0x0 writes the stack pointer r1/);
  // only `addi r1,r1,N` is the frame teardown; an add into r1 from another register is a write
  expect(one('addi    r1,r3,0')).toThrow(/'addi r1,r3,0' at 0x0 writes the stack pointer r1/);
  expect(one('addi    r1,r3,16')).toThrow(/writes the stack pointer r1/);
  expect(one('addic   r1,r3,0')).toThrow(/writes the stack pointer r1/);
  expect(() =>
    dis('walk', ['   0:\tstwu    r1,-16(r1)', '   4:\taddi    r1,r3,0', '   8:\tli      r3,7', '   c:\tblr']),
  ).toThrow(/'addi r1,r3,0' at 0x4 writes the stack pointer r1/);
});

test('a write to a small-data base refuses, rather than leaving later small-data accesses unmoved', () => {
  // An access through r13 or r2 is read off its relocation, so a write to the base would vanish and
  // `gx` below would still read as `gx`.
  const sda = (line: string) => () =>
    dis('walk', [`   0:\t${line}`, '   4:\tlwz     r3,0(0)', '\t\t\t6: R_PPC_EMB_SDA21\tgx', '   8:\tblr']);
  expect(sda('lwzu    r13,4(r3)')).toThrow(/'lwzu r13,4\(r3\)' at 0x0 writes the small-data base r13/);
  expect(sda('lbzu    r2,1(r3)')).toThrow(/'lbzu r2,1\(r3\)' at 0x0 writes the small-data base r2/);
  expect(sda('lwz     r13,4(r3)')).toThrow(/writes the small-data base r13/);
  expect(sda('mr      r2,r4')).toThrow(/writes the small-data base r2/);
});

test('a load that writes a second register refuses in annotate mode too, rather than leaving it stale', () => {
  // An opaque stands for its first operand only, so annotate mode (the CLI and bench default) would
  // print `lwzux r0,r3,r4; lbz r3,0(r3)` as `*a0 + ASMLIFT_ERROR(...)`: the byte read through the
  // unmoved base, where it is at `a0 + a1`.
  const both = (lines: string[]) =>
    (['strict', 'annotate'] as const).map((onGap) => {
      const asm = `0 <g>:\n${lines.map((l, k) => `  ${(4 * k).toString(16)}:\t${l}`).join('\n')}\n`;
      try {
        return decompile('g', asm, PPC_MWCC, { onGap }).source;
      } catch (e) {
        return (e as Error).message;
      }
    });
  const tail = ['lbz     r3,0(r3)', 'add     r3,r3,r0', 'blr'];
  for (const mn of ['lbzux', 'lhzux', 'lhaux', 'lwzux']) {
    for (const out of both([`${mn}   r0,r3,r4`, ...tail])) {
      expect(out).toContain(`unmodelled instruction '${mn}' writes its base r3 as well as r0`);
    }
  }
  // `lmw` below r31 writes up to r31, and a string load the registers after its first
  for (const out of both(['lmw     r30,0(r3)', 'mr      r3,r31', 'blr'])) {
    expect(out).toContain(`unmodelled instruction 'lmw' writes r31 as well as r30`);
  }
  for (const out of both(['lswi    r5,r3,8', 'mr      r3,r6', 'blr'])) {
    expect(out).toContain(`unmodelled instruction 'lswi' writes the registers after it as well as r5`);
  }
  // the guard is case-blind, as the store and FP classes are: an upper-case spelling (pasted asm)
  // misses the lower-case decode and must not become a one-destination opaque either
  for (const [line, msg] of [
    ['LBZUX   r0,r3,r4', `'LBZUX' writes its base r3 as well as r0`],
    ['LWZU    r0,4(r3)', `'LWZU' writes its base r3 as well as r0`],
    ['Lmw     r30,0(r3)', `'Lmw' writes r31 as well as r30`],
  ]) {
    for (const out of both([line, ...tail])) {
      expect(out).toContain(`unmodelled instruction ${msg}`);
    }
  }
  // one destination still degrades to an honest opaque, and the plain indexed load still lifts
  expect(both(['lmw     r31,0(r3)', 'mr      r3,r31', 'blr'])[1]).toContain(
    `ASMLIFT_ERROR("unmodelled instruction 'lmw'")`,
  );
  expect(both(['lwzx    r0,r3,r4', ...tail])[1]).toContain('return *(s32 *)(a0 + a1) + *a0;');
  // the FP update forms keep the floating-point refusal
  expect(both(['lfdux   f1,r3,r4', 'blr'])[0]).toContain(`unmodelled floating-point instruction 'lfdux'`);
});

// What the ISA says, spelled out without the expansion `writtenOut` shares with the decode: the
// access is at rA + D, and the base holds rA + D AFTER it, for the next access and as a value.
test('an update form accesses rA + D and leaves rA + D in its base', () => {
  const lift = (sym: string, lines: string[], returnsVoid: boolean) =>
    decompile(sym, `0 <${sym}>:\n${lines.join('\n')}\n`, PPC_MWCC, { prototypes: { [sym]: { returnsVoid } } }).source;
  // `lbzu r0,1(r3)` reads byte 1; the plain `lbz r4,1(r3)` after it reads byte 2, not byte 1
  const load = lift(
    'ld',
    ['   0:\tlbzu    r0,1(r3)', '   4:\tlbz     r4,1(r3)', '   8:\tsubf    r3,r4,r0', '   c:\tblr'],
    false,
  );
  expect(load).toContain('return *(a0 + 1) - (a0 + 1)[1];');
  // a store with update stores at byte 1, and the next store's 1(r3) is byte 2
  const store = lift('st', ['   0:\tstbu    r4,1(r3)', '   4:\tstb     r5,1(r3)', '   8:\tblr'], true);
  expect(store).toMatch(/\*\(a0 \+ 1\) = a1;\s+\(a0 \+ 1\)\[1\] = a2;/);
  // the base, read as a value after a word load with update, is the advanced address
  const base = lift(
    'bv',
    ['   0:\tlwzu    r0,4(r3)', '   4:\tstw     r0,0(r4)', '   8:\tstw     r3,4(r4)', '   c:\tblr'],
    true,
  );
  expect(base).toMatch(/\*a1 = \*\(a0 \+ 1\);\s+a1\[1\] = \(s32\)\(a0 \+ 1\);/);
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
