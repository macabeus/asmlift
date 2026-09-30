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

describe('a callee declared to return a struct or union by value', () => {
  test('a Thumb call to one declines instead of reading the hidden pointer as argument 1', () => {
    const makeblob = { params: ['const void *'], returns: 'struct Blob64' };
    expect(() => decompile('p4', P4, ARMV4T_AGBCC, { prototypes: { makeblob } })).toThrow(
      /`makeblob` is declared to return struct Blob64 by value/,
    );
    // a typedef name states it through `returnLayout`
    const typedefd = { params: ['const void *'], returns: 'Blob', returnLayout: { kind: 'struct' as const } };
    expect(() => decompile('p4', P4, ARMV4T_AGBCC, { prototypes: { makeblob: typedefd } })).toThrow(
      /`makeblob` is declared to return Blob by value/,
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
