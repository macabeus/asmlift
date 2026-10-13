// O32 frame objects and incoming stack arguments (frontend/mips.ts `measureO32Frame`, `emitLoad`),
// pinned on gcc2.7.2 — the MIPS lane the synthetic tier does not cover. The same five shapes are
// synthetic rows on ido7.1 and gcc2.7.2kmc (`apps/benchmark/dataset/synthetic.ts`). Each lift
// recompiles byte-exact with Mario Party 3's GCC 2.7.2 at its canonical flags.
import { decompile } from '@asmlift/core/pipeline';
import type { Prototypes } from '@asmlift/core/proto';
import { MIPS_GCC, TOOLCHAIN_TARGETS } from '@asmlift/core/target';
import { compileMipsGcc272Target, extractAsmData, gcc272Available, scoreObjects } from '@asmlift/toolchains';
import { expect, test } from 'vitest';

interface Case {
  name: string;
  sym: string;
  c: string;
  prototypes: Prototypes;
  spelled: RegExp;
}

const CASES: Case[] = [
  {
    name: 'an array handed to a callee and read back, kept as one object above the home area',
    sym: 'escarr',
    c: 'void fill(s32 *p); s32 escarr(void){ s32 a[4]; fill(a); return a[0] + a[3]; }',
    prototypes: { fill: { params: ['s32 *'], returnsVoid: true } },
    spelled: /u8 sp16\[16\];[\s\S]*fill\(sp16\);/,
  },
  {
    name: 'a runtime byte offset into it through `addu rD,sp,rX`',
    sym: 'escaddu',
    c: 'void k(void *p); s32 escaddu(s32 i){ s32 a[8]; k(a); return *(s32 *)((u8 *)a + i); }',
    prototypes: { k: { params: ['void *'], returnsVoid: true } },
    spelled: /u8 sp16\[32\];[\s\S]*\(u32\)sp16 \+ a0/,
  },
  {
    name: 'a struct filled before it is handed over',
    sym: 'escstr',
    c: 'struct P { s32 x, y; }; void gp(struct P *p); s32 escstr(s32 v){ struct P p; p.x = v; p.y = 2; gp(&p); return p.x; }',
    prototypes: { gp: { params: ['void *'], returnsVoid: true } },
    spelled: /gp\(sp16\);/,
  },
  {
    name: 'incoming stack arguments in a frameless leaf',
    sym: 'in9e',
    c: 's32 in9e(s32 a, s32 b, s32 c, s32 d, s32 e, s32 f, s32 g, s32 h, s32 i){ return e + i; }',
    prototypes: {},
    spelled: /return a4 \+ a8;/,
  },
  {
    name: 'incoming stack arguments past a frame, one read after a branch',
    sym: 'in9',
    c: 's32 k1(s32 x); s32 in9(s32 a, s32 b, s32 c, s32 d, s32 e, s32 f, s32 g, s32 h, s32 i){ if (a) return k1(i) + e; return b; }',
    prototypes: { k1: { params: 1 } },
    spelled: /k1\(a8\) \+ a4/,
  },
];

test.runIf(gcc272Available()).each(CASES)(
  'gcc2.7.2: $name',
  ({ sym, c, prototypes, spelled }) => {
    const flags = TOOLCHAIN_TARGETS['gcc2.7.2'].canonicalFlags;
    const { obj, asm } = compileMipsGcc272Target(c, sym, flags);
    const source = decompile(sym, asm, MIPS_GCC, { asmData: extractAsmData(obj, MIPS_GCC, sym), prototypes }).source;
    expect(source).toMatch(spelled);
    expect(scoreObjects(obj, compileMipsGcc272Target(source, sym, flags).obj, sym).score).toBe(0);
  },
  60_000,
);
