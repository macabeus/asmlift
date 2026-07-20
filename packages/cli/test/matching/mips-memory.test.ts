// MIPS memory access — struct-field / array / pointer loads+stores on the second ISA, in BOTH
// language backends. Reference C → IDO 7.1 compile → MIPS object (scoring target) + objdump
// disassembly (asmlift input) → decompile → recompile → REAL objdiff score. Byte-exact (0) =
// asmlift reproduced IDO's exact `lw/sw off(base)` codegen.
//
// WHY THIS FIXTURE EXISTS (the L2-trigger experiment; see docs/level-tower.md § "earning L2").
// It answers "does a struct/array access force a distinct L2 representation into existence?":
//   • CONSTANT-OFFSET access (`s->c`, `*p`, `p[2]`) does NOT. It rides entirely on L1 pointer
//     typing (recover.ts types the load base `T*`) + the L3 `index` node. The L2 `field` opcode
//     is never emitted. Byte-exact in C on BOTH ISAs (Thumb: fixtures.ts `field`/`deref`/…).
//   • VARIABLE-INDEX access (`a[i]` → `sll #k; addu; lw`) forces the earned second op-vocabulary:
//     the array-recognition legalization pass (raise/arrays.ts) rewrites the scaled-address load/
//     store into a typed `aload`/`astore` carrying `elemSize`, so the true base types as `elem *`
//     and structuring lowers it to the neutral `base[index]`. Byte-exact in C (aget/aset/asget).
//
// LANGUAGE-SEAM FINDING: the neutral `index(base, k)` node is C-shaped. For k=0 it lowers to
// valid IDO Pascal (`a0^`, byte-exact via upas). For k≠0 it emits `a0[k]`, which upas REJECTS
// (SGI Pascal has no bare-pointer indexing) — so only the zero-offset deref is a Pascal fixture.
import { pascalBackend } from '@asmlift/core/backend/pascal';
import { decompile } from '@asmlift/core/pipeline';
import type { Prototypes } from '@asmlift/core/proto';
import { MIPS_IDO } from '@asmlift/core/target';
import { compileMipsTarget, scoreCMips, scorePascalMips } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

// ── C backend: constant-offset memory, all byte-exact ─────────────────────────────────────
const C_CASES: { sym: string; c: string; proto?: Prototypes; expect: string }[] = [
  { sym: 'mderef', c: 'int mderef(int *p){ return *p; }', expect: 's32 mderef(s32 * a0) {\n    return *a0;\n}\n' }, // lw v0,0(a0)
  {
    sym: 'mfield',
    c: 'struct S{ int a; int b; int c; }; int mfield(struct S *s){ return s->c; }',
    expect: 's32 mfield(s32 * a0) {\n    return a0[2];\n}\n',
  }, // lw v0,8(a0)
  {
    sym: 'mbyte',
    c: 'int mbyte(unsigned char *p){ return p[2]; }',
    expect: 's32 mbyte(u8 * a0) {\n    return a0[2];\n}\n',
  }, // lbu v0,2(a0)
  {
    sym: 'msetp',
    c: 'void msetp(int *p, int v){ *p = v; }',
    proto: { msetp: { returnsVoid: true } },
    expect: 'void msetp(s32 * a0, s32 a1) {\n    *a0 = a1;\n    return;\n}\n',
  }, // sw a1,0(a0)
  {
    sym: 'mfieldw',
    c: 'struct S{ int a; int b; }; void mfieldw(struct S *s, int v){ s->b = v; }',
    proto: { mfieldw: { returnsVoid: true } },
    expect: 'void mfieldw(s32 * a0, s32 a1) {\n    a0[1] = a1;\n    return;\n}\n',
  }, // sw a1,4(a0)
  // STRUCT RECOVERY: a HETEROGENEOUS-width access pattern on one base (`char`@0 + `int`@4) is
  // inconsistent with any homogeneous array, so the access-pattern discriminator
  // (raise/structs.ts) recovers a real `struct` with named fields — `a0->field_0`, not `a0[?]` —
  // and the emitted struct DECL recompiles to IDO's exact `lbu/lw` codegen (byte-exact).
  // (IDO's `char` is unsigned → `lbu` → `u8` field.)
  {
    sym: 'stagv',
    c: 'struct S{ char tag; int val; }; int stagv(struct S *s){ return s->tag + s->val; }',
    expect:
      'struct Struct0 { u8 field_0; s32 field_4; };\ns32 stagv(struct Struct0 * a0) {\n    return a0->field_0 + a0->field_4;\n}\n',
  }, // lbu v0,0(a0); lw v1,4(a0); addu
  // VARIABLE-INDEX array access — the earned second op-vocabulary (aload/astore, raise/arrays.ts).
  {
    sym: 'aget',
    c: 'int aget(int *a, int i){ return a[i]; }',
    expect: 's32 aget(s32 * a0, s32 a1) {\n    return a0[a1];\n}\n',
  }, // sll #2; addu; lw
  {
    sym: 'aset',
    c: 'void aset(int *a, int i, int v){ a[i] = v; }',
    proto: { aset: { returnsVoid: true } },
    expect: 'void aset(s32 * a0, s32 a1, s32 a2) {\n    a0[a1] = a2;\n    return;\n}\n',
  }, // sll #2; addu; sw
  {
    sym: 'asget',
    c: 'short asget(short *a, int i){ return a[i]; }',
    expect: 's32 asget(s16 * a0, s32 a1) {\n    return a0[a1];\n}\n',
  }, // sll #1; addu; lh (elemSize 2)
];

describe('MIPS (IDO) memory — C: compile → disasm → decompile → recompile → objdiff', () => {
  for (const { sym, c, proto, expect: golden } of C_CASES) {
    test(`${sym}`, () => {
      const { obj, asm } = compileMipsTarget(c, sym);
      const r = decompile(sym, asm, MIPS_IDO, { prototypes: proto });
      expect(r.source).toBe(golden);
      const s = scoreCMips(r.source, sym, obj);
      if (!s.match) {
        console.log(`emitted C for ${sym}:\n${r.source}`);
        console.log('objdiff:', JSON.stringify(s));
      }
      expect(s.score).toBe(0);
      expect(s.match).toBe(true);
    });
  }
});

// ── Pascal backend (IDO upas): only the zero-offset deref lowers to valid IDO Pascal ──────
describe('MIPS (IDO) memory — Pascal: decompile → upas recompile → objdiff', () => {
  test('mderefp', () => {
    const sym = 'mderefp';
    const { obj, asm } = compileMipsTarget('int mderefp(int *p){ return *p; }', sym);
    const p = decompile(sym, asm, MIPS_IDO, { backend: pascalBackend }).source;
    expect(p).toBe('function mderefp(a0: ^Integer): Integer;\nbegin\n  mderefp := a0^;\nend;\n');
    const s = scorePascalMips(p, sym, obj);
    if (!s.match) {
      console.log(`emitted Pascal for ${sym}:\n${p}`);
      console.log('objdiff:', JSON.stringify(s));
    }
    expect(s.score).toBe(0);
    expect(s.match).toBe(true);
  });
});
