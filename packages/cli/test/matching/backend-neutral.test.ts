// Language-backend seam — ISA neutrality on memory access. The SAME struct/array access,
// lifted from TWO different ISAs (ARMv4T/agbcc and MIPS/IDO), must lower to byte-identical
// C and byte-identical Pascal — because everything below the L3 neutral AST is the backend's,
// and the backend never sees the ISA. This is the "both C and Pascal
// on both ISAs" corner that CANNOT be objdiff-scored: agbcc is C-only and IDO `upas` targets
// MIPS, so there is no ARM-Pascal toolchain. Emission-equality is the honest proof here; the
// scored Pascal path lives in pascal-ido.test.ts (arithmetic) and mips-memory.test.ts (deref).
import { cBackend } from '@asmlift/core/backend/c';
import { pascalBackend } from '@asmlift/core/backend/pascal';
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC, MIPS_IDO } from '@asmlift/core/target';
import { compileMipsTarget, compileTargetAsm } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

// Lift the same reference C from both toolchains, renaming to a shared symbol so only the
// body (not the name) is compared.
function liftBoth(sym: string, thumbC: string, mipsC: string) {
  const thumbAsm = compileTargetAsm(thumbC);
  const { asm: mipsAsm } = compileMipsTarget(mipsC, sym);
  const emit = (backend: typeof cBackend) => ({
    thumb: decompile(sym, thumbAsm, ARMV4T_AGBCC, { backend }).source,
    mips: decompile(sym, mipsAsm, MIPS_IDO, { backend }).source,
  });
  return { c: emit(cBackend), pascal: emit(pascalBackend) };
}

describe('backend seam is ISA-neutral: same access → identical C and Pascal from Thumb & MIPS', () => {
  test('pointer deref (*p / p^)', () => {
    const { c, pascal } = liftBoth('nderef', 'int nderef(int *p){ return *p; }', 'int nderef(int *p){ return *p; }');
    expect(c.thumb).toBe('s32 nderef(s32 * a0) {\n    return *a0;\n}\n');
    expect(c.mips).toBe(c.thumb); // C identical across ISAs
    expect(pascal.thumb).toBe('function nderef(a0: ^Integer): Integer;\nbegin\n  nderef := a0^;\nend;\n');
    expect(pascal.mips).toBe(pascal.thumb); // Pascal identical across ISAs
  });

  test('struct field at word offset (s->c / a0[2])', () => {
    const S = 'struct S{ int a; int b; int c; };';
    const { c, pascal } = liftBoth(
      'nfield',
      `${S} int nfield(struct S *s){ return s->c; }`,
      `${S} int nfield(struct S *s){ return s->c; }`,
    );
    expect(c.thumb).toBe('s32 nfield(s32 * a0) {\n    return a0[2];\n}\n');
    expect(c.mips).toBe(c.thumb);
    // NB: this Pascal (`a0[2]`) is emit-only — upas rejects bare-pointer indexing (see
    // mips-memory.test.ts). The seam still lowers it identically from both ISAs, which is the
    // property under test; making it a scored Pascal fixture needs record/array typing.
    expect(pascal.thumb).toBe('function nfield(a0: ^Integer): Integer;\nbegin\n  nfield := a0[2];\nend;\n');
    expect(pascal.mips).toBe(pascal.thumb);
  });
});
