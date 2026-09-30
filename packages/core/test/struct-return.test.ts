// A call to a function declared to return a struct or union BY VALUE. agbcc hands such a callee a
// hidden pointer in r0 and moves every declared argument one register up (thumb.h:644-645, 672), so a
// lift that reads the declared parameters from r0 names the pointer as the first argument. Every
// fixture is agbcc's own output at the corpus flags (`-mthumb-interwork -O2 -fhex-asm
// -fprologue-bugfix`), or mwcc_242_81's at the synthetic tier's.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC, PPC_MWCC } from '../src/target';

// `struct Blob64 { u32 w[16]; }; struct Blob64 makeblob(const void *); extern struct Blob64 gDst;
//  void p4(void){ gDst = makeblob(gBlob); }` — a global destination is handed over directly
// (calls.c:1001-1009), so there is no frame for the frame-object audit to see.
const P4 =
  'p4:\n\tpush\t{lr}\n\tldr\tr0, .L3\n\tldr\tr1, .L3+0x4\n\tbl\tmakeblob\n\tpop\t{r0}\n\tbx\tr0\n' +
  '.L4:\n\t.align\t2, 0\n.L3:\n\t.word\tgDst\n\t.word\tgBlob\n';

// `void p1(void){ struct Blob64 b = makeblob(gBlob); }` — the storage is a frame temp (the
// synthetic row `stkextsret`)
const P1 =
  'p1:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x40\n\tldr\tr1, .L3\n\tmov\tr0, sp\n\tbl\tmakeblob\n' +
  '\tadd\tsp, sp, #0x40\n\tpop\t{r0}\n\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n\t.word\tgBlob\n';
// `struct S4 { u8 a, b, c, d; }; u32 q1(s32 x){ struct S4 s = mk4(x); return s.a; }`
const Q1 =
  'q1:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tadd\tr1, r0, #0\n\tmov\tr0, sp\n\tbl\tmk4\n' +
  '\tldr\tr0, [sp]\n\tlsl\tr0, r0, #0x18\n\tlsr\tr0, r0, #0x18\n\tadd\tsp, sp, #0x4\n\tpop\t{r1}\n\tbx\tr1\n';
// `struct S4 …; void u3(s32 x, s32 y){ mk4(x); mk4(y); }` — two temps, one per call
const U3 =
  'u3:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr2, r0, #0\n\tadd\tr4, r1, #0\n\tmov\tr0, sp\n' +
  '\tadd\tr1, r2, #0\n\tbl\tmk4\n\tadd\tr0, sp, #0x4\n\tadd\tr1, r4, #0\n\tbl\tmk4\n\tadd\tsp, sp, #0x8\n' +
  '\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n';

const BLOB64 = { kind: 'struct' as const, members: [{ name: 'w', type: 'u32', dims: [16] }] };
const S4 = { kind: 'struct' as const, members: ['a', 'b', 'c', 'd'].map((name) => ({ name, type: 'u8' })) };
const makeblob = { params: ['const void *'], returns: 'struct Blob64', returnLayout: BLOB64 };
const mk4 = { params: ['s32'], returns: 'struct S4', returnLayout: S4 };

describe('a callee declared to return a struct through memory', () => {
  test('its storage is a local of the declared type, and the call fills it', () => {
    const { source } = decompile('p1', P1, ARMV4T_AGBCC, { prototypes: { makeblob } });
    expect(source).toContain('struct Blob64 sp0;');
    expect(source).toContain('sp0 = makeblob(&gBlob);');
  });

  test('every argument reads one register up, and each call fills its own local', () => {
    const { source } = decompile('u3', U3, ARMV4T_AGBCC, { prototypes: { mk4 } });
    expect(source).toContain('sp0 = mk4(a0);');
    expect(source).toContain('sp4 = mk4(a1);');
  });

  test('a read of the returned struct declines', () => {
    expect(() => decompile('q1', Q1, ARMV4T_AGBCC, { prototypes: { mk4 } })).toThrow(
      /the object at \[sp,#0\) is where `mk4` returns struct S4, and this function also reads or writes it/,
    );
  });

  test('a struct returned straight into a global declines', () => {
    expect(() => decompile('p4', P4, ARMV4T_AGBCC, { prototypes: { makeblob } })).toThrow(
      /`makeblob` returns struct Blob64 through the pointer in r0, and that pointer is not the address of a local/,
    );
  });

  test('without a declared return it is the frame the out-parameter refusal names', () => {
    expect(() => decompile('p1', P1, ARMV4T_AGBCC, { prototypes: { makeblob: { params: 1 } } })).toThrow(
      /`makeblob` takes it at argument 0 and nothing says what that callee returns/,
    );
  });
});

describe('a callee declared to return a struct or union by value', () => {
  test('a Thumb call to one declines where nothing says it comes back through memory', () => {
    const makeblob = { params: ['const void *'], returns: 'struct Blob64' };
    expect(() => decompile('p4', P4, ARMV4T_AGBCC, { prototypes: { makeblob } })).toThrow(
      /`makeblob` is declared to return struct Blob64 by value, and nothing here says whether it comes back/,
    );
    // a typedef name states it through `returnLayout`
    const typedefd = { params: ['const void *'], returns: 'Blob', returnLayout: { kind: 'struct' as const } };
    expect(() => decompile('p4', P4, ARMV4T_AGBCC, { prototypes: { makeblob: typedefd } })).toThrow(
      /`makeblob` is declared to return Blob by value/,
    );
    // one agbcc hands back in r0 (`struct W1 { u32 x; } mkw(s32)` is called `bl mkw` with no frame)
    const mkw = {
      params: ['s32'],
      returns: 'struct W1',
      returnLayout: { kind: 'struct' as const, members: [{ name: 'x', type: 'u32' }] },
    };
    const q2 = 'q2:\n\tpush\t{lr}\n\tbl\tmkw\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('q2', q2, ARMV4T_AGBCC, { prototypes: { mkw } })).toThrow(
      /comes back in the return register, which is not modelled as a struct value/,
    );
    // a typedef name has no definition to print into the candidate
    const named = { ...makeblob, returns: 'Blob64', returnLayout: BLOB64 };
    expect(() => decompile('p1', P1, ARMV4T_AGBCC, { prototypes: { makeblob: named } })).toThrow(
      /its declaration cannot be printed into the candidate/,
    );
    // Told only an arity, nothing separates the pointer from an argument: `gBlob` is dropped. The
    // declaration is the whole of the fix.
    expect(decompile('p4', P4, ARMV4T_AGBCC, { prototypes: { makeblob: { params: 1 } } }).source).toContain(
      'makeblob(&gDst);',
    );
  });

  test('a PowerPC call to one declines', () => {
    const asm =
      '7c <p4>:\n7c:\tstwu    r1,-16(r1)\n80:\tmflr    r0\n84:\tlis     r3,0\n\t\t\t86: R_PPC_ADDR16_HA\tgDst\n' +
      '88:\tlis     r4,0\n\t\t\t8a: R_PPC_ADDR16_HA\tgBlob\n8c:\tstw     r0,20(r1)\n90:\taddi    r3,r3,0\n' +
      '\t\t\t92: R_PPC_ADDR16_LO\tgDst\n94:\taddi    r4,r4,0\n\t\t\t96: R_PPC_ADDR16_LO\tgBlob\n' +
      '98:\tbl      98 <p4+0x1c>\n\t\t\t98: R_PPC_REL24\tmakeblob\n9c:\tlwz     r0,20(r1)\na0:\tmtlr    r0\n' +
      'a4:\taddi    r1,r1,16\na8:\tblr\n';
    const makeblob = { params: ['const void *'], returns: 'struct Blob64' };
    expect(() => decompile('p4', asm, PPC_MWCC, { prototypes: { makeblob } })).toThrow(
      /'makeblob' is declared to return struct Blob64 by value/,
    );
  });
});
