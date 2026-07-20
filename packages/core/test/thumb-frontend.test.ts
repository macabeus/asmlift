// Thumb frontend robustness. Pins that an unmodelled instruction with a register destination is
// never SILENTLY DROPPED (stale/absent value → confidently-wrong C): like the MIPS/PPC frontends,
// Thumb degrades it to a loud `opaque`. Toolchain-free.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const dc = (sym: string, body: string) => decompile(sym, `${sym}:\n${body}`, ARMV4T_AGBCC);

describe('Thumb frontend robustness (CONTRACT-AS-INVARIANT)', () => {
  test('a conditional branch split from its cmp by a label declines loud', () => {
    // The label between `cmp` and `bge` splits the block, so the branch has no reaching compare in
    // its own block. Must be the DESIGNED FrontendUnsupportedError, not a null-deref crash.
    const body = '\tcmp\tr0, r1\n.Lmid:\n\tbge\t.Ltrue\n\tmov\tr0, #0\n\tbx\tlr\n.Ltrue:\n\tmov\tr0, #1\n\tbx\tlr\n';
    expect(() => dc('splitcmp', body)).toThrow(/no reaching compare/);
  });

  test('an unmodelled op that reaches the output FAILS LOUD (no silent wrong C)', () => {
    // `clz` (count-leading-zeros) is not modelled. If dropped, the function would return a
    // stale/absent r0; instead it emits an opaque the boundary contract rejects — loud.
    expect(() => dc('clzret', '\tclz\tr0, r0\n\tbx\tlr\n').source).toThrow();
  });

  test('a DEAD unmodelled op is harmless (does not fail loud)', () => {
    // `clz` writes r1, which is never read; the opaque is dead and DCE removes it, so the real
    // return (`a0 + 1`) is unaffected.
    expect(dc('clzdead', '\tclz\tr1, r0\n\tadd\tr0, r0, #1\n\tbx\tlr\n').source).toBe(
      's32 clzdead(s32 a0) {\n    return a0 + 1;\n}\n',
    );
  });

  test('a push frame op still falls through harmlessly (no spurious opaque)', () => {
    // `push {r4, lr}`'s operands are reg-list tokens (`{r4`, `lr}`), not a bare `rN` data
    // destination, so the guard skips it — frame transparency is preserved.
    expect(dc('framed', '\tpush\t{r4, lr}\n\tadd\tr0, r0, #1\n\tbx\tlr\n').source).toBe(
      's32 framed(s32 a0) {\n    return a0 + 1;\n}\n',
    );
  });

  test('an ENTRY block that is itself the loop header (tight strcpy self-loop) gets a preheader', () => {
    // The `strcpy`/`strlen`/`memset` shape: block 0 IS the loop — its first op reads a
    // loop-carried pointer (`ldrb r2,[r1]`) whose phi merges the entry PARAM with the back-edge
    // increment. Without a synthetic preheader supplying the entry operand, Braun SSA builds that
    // phi from the back-edge alone and the first read is use-before-def (a `verify` decline). The
    // preheader gives the header its forward predecessor: the loop lifts cleanly to a do-while.
    const src = decompile(
      'strcpyloop',
      'strcpyloop:\n\tldrb\tr2, [r1]\n\tstrb\tr2, [r0]\n\tadd\tr0, r0, #0x1\n\tadd\tr1, r1, #0x1\n\tcmp\tr2, #0\n\tbne\tstrcpyloop\n\tbx\tlr\n',
      ARMV4T_AGBCC,
      { prototypes: { strcpyloop: { returnsVoid: true } } },
    ).source;
    expect(src).toContain('do {');
    expect(src).toContain('} while (v0 != 0);');
    expect(src).not.toContain('ASMLIFT_ERROR'); // no decline / use-before-def
  });
});
