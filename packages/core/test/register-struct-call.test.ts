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
/** an mwcc 2.3.3 caller, which round-trips the image through the struct's home at 12(r1) */
const mwcc233 = (name: string, load: string, store: string) =>
  `00000000 <${name}>:\n   0:\tmflr    r0\n   4:\tstw     r0,4(r1)\n   8:\tstwu    r1,-16(r1)\n` +
  `   c:\tbl      c <${name}+0xc>\n\t\t\tc: R_PPC_REL24\tmk\n  10:\tstw     r3,12(r1)\n  14:\t${load}\n` +
  `  18:\t${store}     r0,0(0)\n\t\t\t1a: R_PPC_EMB_SDA21\tgV\n  1c:\tlwz     r0,20(r1)\n  20:\taddi    r1,r1,16\n` +
  '  24:\tmtlr    r0\n  28:\tblr\n';

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
      ).toMatch(/struct T mk_ret;\s+mk_ret = mk\(a0\);\s+gV = mk_ret\.a;/);
      expect(
        decompile('c_h1', h1, target, { prototypes: { ...own('c_h1'), mk: mk([{ name: 'a', type: 'u16' }]) } }).source,
      ).toMatch(/mk_ret = mk\(a0\);\s+gV = mk_ret\.a;/);
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

describe("mwcc: the struct's frame home is the local the call assigns", () => {
  // the home `stw r3,8(r1)` is written after the store to gV and read by nothing
  const w1 = mwcc(
    'c_w1',
    '  10:\tstw     r3,0(0)\n\t\t\t10: R_PPC_EMB_SDA21\tgV\n  14:\tlwz     r0,20(r1)\n  18:\tstw     r3,8(r1)\n' +
      '  1c:\tmtlr    r0\n  20:\taddi    r1,r1,16\n  24:\tblr\n',
  );
  // `struct T { u8 a, b; }`: the image's top half is stored to the home and b read back off it
  const bb = mwcc(
    'c_bb',
    '  10:\tsrwi    r0,r3,16\n  14:\tsth     r0,8(r1)\n  18:\tlbz     r0,9(r1)\n  1c:\tstb     r0,0(0)\n' +
      '\t\t\t1c: R_PPC_EMB_SDA21\tgV\n' +
      EPILOGUE(0x20),
  );
  const BB = mk([
    { name: 'a', type: 'u8' },
    { name: 'b', type: 'u8' },
  ]);
  for (const tc of ['mwcc_242_81', 'mwcc_247_107'] as const) {
    test(`${tc}: a home nothing reads, and one a member is read back from`, () => {
      const target = TOOLCHAIN_TARGETS[tc].description;
      expect(
        decompile('c_w1', w1, target, { prototypes: { ...own('c_w1'), mk: mk([{ name: 'a', type: 'u32' }]) } }).source,
      ).toMatch(/mk_ret = mk\(a0\);\s+gV = \*\(s32 \*\)&mk_ret;/);
      expect(decompile('c_bb', bb, target, { prototypes: { ...own('c_bb'), mk: BB } }).source).toMatch(
        /mk_ret = mk\(a0\);\s+gV = mk_ret\.b;/,
      );
    });
  }

  test("a home read back after a second call is the first call's local", () => {
    // `struct T s = mk(x); struct T t = mk(x + 1); gW = s.a + t.a;`, `struct T { u16 a; }`: s's home
    // at 12(r1) is reloaded past the second call
    const t2 =
      '00000000 <t2>:\n   0:\tstwu    r1,-32(r1)\n   4:\tmflr    r0\n   8:\tstw     r0,36(r1)\n' +
      '   c:\tstw     r31,28(r1)\n  10:\tmr      r31,r3\n  14:\tbl      14 <t2+0x14>\n\t\t\t14: R_PPC_REL24\tmk\n' +
      '  18:\tsrwi    r0,r3,16\n  1c:\taddi    r3,r31,1\n  20:\tsth     r0,12(r1)\n  24:\tbl      24 <t2+0x24>\n' +
      '\t\t\t24: R_PPC_REL24\tmk\n  28:\tlhz     r0,12(r1)\n  2c:\tsrwi    r3,r3,16\n  30:\tsth     r3,8(r1)\n' +
      '  34:\tadd     r0,r0,r3\n  38:\tstw     r0,0(0)\n\t\t\t38: R_PPC_EMB_SDA21\tgW\n  3c:\tlwz     r31,28(r1)\n' +
      '  40:\tlwz     r0,36(r1)\n  44:\tmtlr    r0\n  48:\taddi    r1,r1,32\n  4c:\tblr\n';
    const target = TOOLCHAIN_TARGETS.mwcc_242_81.description;
    expect(
      decompile('t2', t2, target, { prototypes: { ...own('t2'), mk: mk([{ name: 'a', type: 'u16' }]) } }).source,
    ).toMatch(/mk_ret = mk\(a0\);\s+mk_ret_ = mk\(a0 \+ 1\);\s+gW = mk_ret_\.a \+ mk_ret\.a;/);
  });

  test("mwcc_233_163n: the struct's home holds the image the call handed back", () => {
    const target = TOOLCHAIN_TARGETS.mwcc_233_163n.description;
    const lift = (members: { name: string; type: string }[], load: string, store: string) =>
      decompile('c', mwcc233('c', load, store), target, { prototypes: { ...own('c'), mk: mk(members) } }).source;
    expect(lift([{ name: 'a', type: 'u8' }], 'lbz     r0,12(r1)', 'stb')).toMatch(
      /mk_ret = mk\(a0\);\s+gV = mk_ret\.a;/,
    );
    expect(lift([{ name: 'a', type: 'u16' }], 'lhz     r0,12(r1)', 'sth')).toMatch(
      /mk_ret = mk\(a0\);\s+gV = mk_ret\.a;/,
    );
    expect(
      lift(
        [
          { name: 'a', type: 'u8' },
          { name: 'b', type: 'u8' },
        ],
        'lbz     r0,13(r1)',
        'stb',
      ),
    ).toMatch(/mk_ret = mk\(a0\);\s+gV = mk_ret\.b;/);
  });

  test('an unread home is still refused where a call nothing declares might take it as a stack word', () => {
    const target = TOOLCHAIN_TARGETS.mwcc_242_81.description;
    const later =
      '  10:\tstw     r3,0(0)\n\t\t\t10: R_PPC_EMB_SDA21\tgV\n  14:\tstw     r3,8(r1)\n' +
      '  18:\tbl      18 <c_w1+0x18>\n\t\t\t18: R_PPC_REL24\tother\n' +
      EPILOGUE(0x1c);
    expect(() =>
      decompile('c_w1', mwcc('c_w1', later), target, {
        prototypes: { ...own('c_w1'), mk: mk([{ name: 'a', type: 'u32' }]) },
      }),
    ).toThrow(/'8\(r1\)' is stored at 0x14 and never read back/);
  });
});

describe('a struct with a floating member has no local here', () => {
  test('agbcc: `struct T { float a; }` comes back in r0, and r0 still holds nothing the caller may read', () => {
    // `struct T s = mk(x); gF = s.a;` against `extern float gF;`: read as `*(s32 *)&s`, the store
    // would convert the bits to a float (`bl __floatsisf`)
    const fl = agbcc('c_f', 'str');
    expect(() =>
      decompile('c_f', fl, ARMV4T_AGBCC, { prototypes: { mk: mk([{ name: 'a', type: 'float' }]) } }),
    ).toThrow(/r0 is read on a path where a call has destroyed it/);
  });
});

describe("a function returning what a call returned returns the call's struct", () => {
  const T16 = mk([{ name: 'a', type: 'u16' }]);
  const W = mk([{ name: 'a', type: 'u32' }]);
  const ownT = (name: string): Record<string, FnProto> => ({
    [name]: { params: ['s32'], returns: 'struct T', returnLayout: T16.returnLayout },
  });
  const ownW = (name: string): Record<string, FnProto> => ({
    [name]: { params: [], returns: 'struct T', returnLayout: W.returnLayout },
  });

  test('agbcc: `return mk(x);` of a `{u16}`, which the own side cannot spell as a member copy', () => {
    const fwd = 'f:\n\tpush\t{lr}\n\tbl\tmk\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(decompile('f', fwd, ARMV4T_AGBCC, { prototypes: { ...ownT('f'), mk: T16 } }).source).toMatch(
      /struct T f\(s32 a0\) \{\s+return mk\(a0\);\s+\}/,
    );
  });

  test('a word computed from the struct and returned as the own `{u16}` declines, as it did', () => {
    // `struct T s = mk(x); s.a += 1; return s;`: agbcc keeps the pad's bits, which no member copy says
    const mod =
      'f:\n\tpush\t{lr}\n\tbl\tmk\n\tadd\tr2, r0, #0\n\tadd\tr0, r2, #0x1\n\tlsl\tr0, r0, #0x10\n\tlsr\tr0, r0, #0x10\n' +
      '\tldr\tr1, .L3\n\tand\tr1, r1, r2\n\torr\tr0, r0, r1\n\tpop\t{r1}\n\tbx\tr1\n.L4:\n\t.align\t2, 0\n.L3:\n\t.word\t-0x10000\n';
    expect(() => decompile('f', mod, ARMV4T_AGBCC, { prototypes: { ...ownT('f'), mk: T16 } })).toThrow(
      /it is declared to return struct T by value, which comes back in r0 — it is not one word that is all one integer member, and what it returns is computed from a struct a call returned there/,
    );
  });

  test('mwcc_242_81: the call itself with no home, the local where the source named one', () => {
    const target = TOOLCHAIN_TARGETS.mwcc_242_81.description;
    const head = (name: string) =>
      `00000000 <${name}>:\n   0:\tstwu    r1,-16(r1)\n   4:\tmflr    r0\n   8:\tli      r3,1\n` +
      `   c:\tstw     r0,20(r1)\n  10:\tbl      10 <${name}+0x10>\n\t\t\t10: R_PPC_REL24\tmk\n  14:\tlwz     r0,20(r1)\n`;
    // `return mk(1);`
    const bare = `${head('f')}  18:\tmtlr    r0\n  1c:\taddi    r1,r1,16\n  20:\tblr\n`;
    expect(decompile('f', bare, target, { prototypes: { ...ownW('f'), mk: W } }).source).toMatch(
      /struct T f\(void\) \{\s+return mk\(1\);\s+\}/,
    );
    // `struct T s = mk(1); return s;`, whose home `stw r3,8(r1)` nothing reads
    const named = `${head('f')}  18:\tstw     r3,8(r1)\n  1c:\tmtlr    r0\n  20:\taddi    r1,r1,16\n  24:\tblr\n`;
    expect(decompile('f', named, target, { prototypes: { ...ownW('f'), mk: W } }).source).toMatch(
      /struct T f\(void\) \{\s+struct T mk_ret;\s+mk_ret = mk\(1\);\s+return mk_ret;\s+\}/,
    );
  });
});

test('mwcc_242_81: an unread home after the last call is no stack word of a call nothing declares before it', () => {
  // `foo(); s = mk1(x); gW = s.x;`, foo undeclared: its call runs before the home is written
  const before =
    '00000000 <f>:\n   0:\tstwu    r1,-32(r1)\n   4:\tmflr    r0\n   8:\tstw     r0,36(r1)\n   c:\tstw     r31,28(r1)\n' +
    '  10:\tmr      r31,r3\n  14:\tbl      14 <f+0x14>\n\t\t\t14: R_PPC_REL24\tfoo\n  18:\tmr      r3,r31\n' +
    '  1c:\tbl      1c <f+0x1c>\n\t\t\t1c: R_PPC_REL24\tmk\n  20:\tstw     r3,0(0)\n\t\t\t20: R_PPC_EMB_SDA21\tgW\n' +
    '  24:\tlwz     r0,36(r1)\n  28:\tstw     r3,8(r1)\n  2c:\tlwz     r31,28(r1)\n  30:\tmtlr    r0\n' +
    '  34:\taddi    r1,r1,32\n  38:\tblr\n';
  const target = TOOLCHAIN_TARGETS.mwcc_242_81.description;
  expect(
    decompile('f', before, target, { prototypes: { ...own('f'), mk: mk([{ name: 'x', type: 'u32' }]) } }).source,
  ).toMatch(/foo\(a0\);\s+mk_ret = mk\(a0\);\s+gW = /);
});
