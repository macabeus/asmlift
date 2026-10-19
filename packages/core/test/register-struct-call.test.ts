// A CALLEE DECLARED TO RETURN A STRUCT THE TARGET HANDS BACK IN THE RETURN REGISTER: the caller's
// read of it (frontend/call-plan.ts `registerStructLocal`, frontend/register-struct-call.ts). Every
// listing below is compiled from `struct T { <m> }; extern struct T mk(s32 x); void c(s32 x) {
// struct T s = mk(x); gV = s.<m>; }` at the toolchain's canonical flags, and each lift recompiles
// to it byte for byte.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import type { FnProto } from '../src/proto';
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS } from '../src/target';

const mk = (
  members: { name: string; type: string; bits?: number }[],
  kind: 'struct' | 'union' = 'struct',
): FnProto => ({
  params: ['s32'],
  returns: 'struct T',
  returnLayout: { kind, members },
});

/** an agbcc caller that stores r0 off `bl mk` with `store` (and `pre` before it) */
const agbcc = (name: string, store: string, pre = '') =>
  `${name}:\n\tpush\t{lr}\n\tbl\tmk\n\tldr\tr1, .L3\n${pre}\t${store}\tr0, [r1]\n\tpop\t{r0}\n\tbx\tr0\n` +
  '.L4:\n\t.align\t2, 0\n.L3:\n\t.word\tgV\n';

describe('agbcc: a struct of one member comes back in r0', () => {
  test('a u8, u16 or u32 member is read off the local the call assigns', () => {
    const b1 = decompile('c_b1', agbcc('c_b1', 'strb'), ARMV4T_AGBCC, {
      prototypes: { mk: mk([{ name: 'a', type: 'u8' }]) },
    }).source;
    expect(b1).toMatch(/struct T mk_ret;\s+mk_ret = mk\(a0\);\s+gV = mk_ret\.a;/);
    const h1 = decompile('c_h1', agbcc('c_h1', 'strh'), ARMV4T_AGBCC, {
      prototypes: { mk: mk([{ name: 'a', type: 'u16' }]) },
    }).source;
    expect(h1).toMatch(/mk_ret = mk\(a0\);\s+gV = mk_ret\.a;/);
    const w1 = decompile('c_w1', agbcc('c_w1', 'str'), ARMV4T_AGBCC, {
      prototypes: { mk: mk([{ name: 'a', type: 'u32' }]) },
    }).source;
    expect(w1).toMatch(/mk_ret = mk\(a0\);\s+gV = \*\(s32 \*\)&mk_ret;/);
  });

  test('a bitfield is extracted from the local, and a union has no local and still declines', () => {
    const bf = agbcc('c_bf', 'str', '\tlsl\tr0, r0, #0x18\n\tlsr\tr0, r0, #0x1c\n');
    const members = [
      { name: 'a', type: 'u32', bits: 4 },
      { name: 'b', type: 'u32', bits: 4 },
    ];
    expect(decompile('c_bf', bf, ARMV4T_AGBCC, { prototypes: { mk: mk(members) } }).source).toMatch(
      /mk_ret = mk\(a0\);\s+gV = \(u32\)\(\*\(s32 \*\)&mk_ret << 24\) >> 28;/,
    );
    const un = mk(
      [
        { name: 'w', type: 'u32' },
        { name: 'h', type: 'u16' },
      ],
      'union',
    );
    expect(() => decompile('c_un', agbcc('c_un', 'strh'), ARMV4T_AGBCC, { prototypes: { mk: un } })).toThrow(
      /r0 is read on a path where a call has destroyed it/,
    );
  });

  test("each call's struct is its own local, so a read of the first after the second reads the first", () => {
    // `struct T s = mk(x); struct T t = mk(x + 1); gW = s.a + t.a;`, `struct T { u16 a; }`
    const t2 =
      't2:\n\tpush\t{r4, r5, lr}\n\tadd\tr5, r0, #0\n\tbl\tmk\n\tadd\tr4, r0, #0\n\tadd\tr5, r5, #0x1\n' +
      '\tadd\tr0, r5, #0\n\tbl\tmk\n\tldr\tr1, .L3\n\tlsl\tr4, r4, #0x10\n\tlsr\tr4, r4, #0x10\n\tlsl\tr0, r0, #0x10\n' +
      '\tlsr\tr0, r0, #0x10\n\tadd\tr4, r4, r0\n\tstr\tr4, [r1]\n\tpop\t{r4, r5}\n\tpop\t{r0}\n\tbx\tr0\n' +
      '.L4:\n\t.align\t2, 0\n.L3:\n\t.word\tgW\n';
    expect(decompile('t2', t2, ARMV4T_AGBCC, { prototypes: { mk: mk([{ name: 'a', type: 'u16' }]) } }).source).toMatch(
      /mk_ret = mk\(a0\);\s+v0 = mk_ret\.a;\s+mk_ret_ = mk\(a0 \+ 1\);\s+gW = v0 \+ mk_ret_\.a;/,
    );
  });

  test('a callee nothing declares returns a word, as the same bytes from a scalar callee do', () => {
    expect(decompile('c_w1', agbcc('c_w1', 'str'), ARMV4T_AGBCC, {}).source).toMatch(/gV = mk\(\);/);
  });

  test('a call nothing declares is not handed the struct, or a copy of it, by a guess', () => {
    const decl = { mk: mk([{ name: 'a', type: 'u32' }]) };
    // `other(mk(a), 3)` or `other(mk(a).a, 3)`: the bytes are one
    const inR0 = 'c2:\n\tpush\t{lr}\n\tbl\tmk\n\tmov\tr1, #0x3\n\tbl\tother\n\tpop\t{r0}\n\tbx\tr0\n';
    expect(() => decompile('c2', inR0, ARMV4T_AGBCC, { prototypes: decl })).toThrow(
      /argument 1 of the call to 'other' is a struct an earlier call handed back in r0/,
    );
    const inR1 =
      'c1:\n\tpush\t{lr}\n\tbl\tmk\n\tadd\tr1, r0, #0\n\tmov\tr0, #0x3\n\tbl\tother\n\tpop\t{r0}\n\tbx\tr0\n';
    expect(() => decompile('c1', inR1, ARMV4T_AGBCC, { prototypes: decl })).toThrow(
      /argument 2 of the call to 'other' is a struct an earlier call handed back in r0/,
    );
    // a declaration says which: here, the member
    const other = { params: ['u32', 's32'], returnsVoid: true as const };
    expect(decompile('c2', inR0, ARMV4T_AGBCC, { prototypes: { ...decl, other } }).source).toMatch(
      /mk_ret = mk\(a0\);\s+other\(\*\(s32 \*\)&mk_ret, 3\);/,
    );
    // and a guessed call after the struct takes nothing it left in r0
    const after = 'f:\n\tpush\t{lr}\n\tbl\tmk\n\tbl\tother\n\tpop\t{r0}\n\tbx\tr0\n';
    expect(decompile('f', after, ARMV4T_AGBCC, { prototypes: decl }).source).toMatch(/mk\(a0\);\s+other\(\);/);
  });
});

/** the caller's own declaration, `void c(s32)`: r3 at its return is no value it hands back */
const own = (name: string): Record<string, FnProto> => ({ [name]: { params: ['s32'], returnsVoid: true } });

/** an mwcc 2.4.2/2.4.7 caller: `body` follows `bl mk` */
const mwcc = (name: string, body: string) =>
  `00000000 <${name}>:\n   0:\tstwu    r1,-16(r1)\n   4:\tmflr    r0\n   8:\tstw     r0,20(r1)\n` +
  `   c:\tbl      c <${name}+0xc>\n\t\t\tc: R_PPC_REL24\tmk\n${body}`;
const EPILOGUE = (at: number) =>
  [`lwz     r0,20(r1)`, `mtlr    r0`, `addi    r1,r1,16`, `blr`]
    .map((ins, k) => `  ${(at + 4 * k).toString(16)}:\t${ins}\n`)
    .join('');
describe('mwcc: a struct of up to four bytes comes back in r3, left-justified', () => {
  const b1 = mwcc(
    'c_b1',
    '  10:\tsrwi    r0,r3,24\n  14:\tstb     r0,8(r1)\n  18:\tstb     r0,0(0)\n\t\t\t18: R_PPC_EMB_SDA21\tgV\n' +
      EPILOGUE(0x1c),
  );
  const h1 = mwcc(
    'c_h1',
    '  10:\tsrwi    r0,r3,16\n  14:\tsth     r0,8(r1)\n  18:\tsth     r0,0(0)\n\t\t\t18: R_PPC_EMB_SDA21\tgV\n' +
      EPILOGUE(0x1c),
  );
  for (const tc of ['mwcc_242_81', 'mwcc_247_107'] as const) {
    test(`${tc}: a sub-word member is the top of r3, shifted down`, () => {
      const target = TOOLCHAIN_TARGETS[tc].description;
      expect(
        decompile('c_b1', b1, target, { prototypes: { ...own('c_b1'), mk: mk([{ name: 'a', type: 'u8' }]) } }).source,
      ).toMatch(/struct T mk_ret;\s+mk_ret = mk\(a0\);\s+(v0|gV) = mk_ret\.a;/);
      expect(
        decompile('c_h1', h1, target, { prototypes: { ...own('c_h1'), mk: mk([{ name: 'a', type: 'u16' }]) } }).source,
      ).toMatch(/mk_ret = mk\(a0\);\s+(v0|gV) = mk_ret\.a;/);
    });
  }

  test('r3 read past a struct of fewer than four bytes declines: the rest is what the callee left', () => {
    const whole = mwcc('c_h1', '  10:\tstw     r3,0(0)\n\t\t\t10: R_PPC_EMB_SDA21\tgV\n' + EPILOGUE(0x14));
    const target = TOOLCHAIN_TARGETS.mwcc_242_81.description;
    expect(() =>
      decompile('c_h1', whole, target, { prototypes: { ...own('c_h1'), mk: mk([{ name: 'a', type: 'u16' }]) } }),
    ).toThrow(/`mk` hands back a struct of 2 bytes in r3, and this function reads bits of the register past it/);
    // where nothing declares the caller void, its return may hand the whole register back
    expect(() => decompile('c_h1', h1, target, { prototypes: { mk: mk([{ name: 'a', type: 'u16' }]) } })).toThrow(
      /`mk` hands back a struct of 2 bytes in r3/,
    );
  });
});
