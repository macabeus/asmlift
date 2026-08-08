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

  test('a flag-setting instruction between a cmp and its branch declines loud', () => {
    // On Thumb-1 nearly every data-processing instruction on LOW registers writes the condition
    // flags, `s`-suffix or not (agbcc spells `adds r0,r0,r3` as `add r0,r0,r3` and the assembler
    // picks the flag-setting encoding). So the `add` below REPLACES the flags `beq` tests: folding
    // the earlier `cmp` in emitted `if (a0 != a1)` where the hardware branches on `r0 + 1 == 0`.
    // Silent wrong C — now the same loud decline the label-split case above gets.
    const clobbered =
      '\tcmp\tr0, r1\n\tadd\tr2, r0, #1\n\tbeq\t.Lt\n\tmov\tr0, #0\n\tbx\tlr\n.Lt:\n\tmov\tr0, #1\n\tbx\tlr\n';
    expect(() => dc('flagclobber', clobbered)).toThrow(/no reaching compare/);

    // …and the three shapes that must NOT trip it, or the guard would cost real matches: an
    // adjacent pair, a LOAD between them (loads leave the flags alone), and a HIGH-register move
    // (the high-register forms do not set flags — this is agbcc's callee-saved shuffling).
    const folds = (mid: string) =>
      dc('ok', `\tcmp\tr0, r1\n${mid}\tbeq\t.Lt\n\tmov\tr0, #0\n\tbx\tlr\n.Lt:\n\tmov\tr0, #1\n\tbx\tlr\n`).source;
    expect(folds('')).toContain('if (a0 != a1)');
    expect(folds('\tldr\tr2, [r3]\n')).toContain('if (a0 != a1)');
    expect(folds('\tmov\tr8, r2\n')).toContain('if (a0 != a1)');
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

describe('the return register cannot be both the return ADDRESS and the return value', () => {
  // `bx rN` branches THROUGH rN, so at that instruction rN holds the return address. When rN is
  // also the return-VALUE register the two uses collide and the address wins by definition —
  // whatever was in r0 is gone. agbcc's interworking epilogue is exactly that shape
  // (`push {lr}` … `pop {r0}; bx r0`), and reading r0 as a value there invents a return the
  // machine provably cannot make.
  test('a `bx r0` epilogue returns VOID, with no phantom value', () => {
    const src = dc('viaR0', '\tpush\t{lr}\n\tmov\tr0, #0x5\n\tpop\t{r0}\n\tbx\tr0\n').source;
    expect(src).toContain('void viaR0(void)');
    expect(src).not.toMatch(/return\s+\w/); // no value returned — there is none to return
  });

  test('the dead computation feeding that phantom return goes with it', () => {
    // `mov r0,#5` is dead once r0 is not a return value; keeping the phantom kept it alive.
    expect(dc('viaR0', '\tpush\t{lr}\n\tmov\tr0, #0x5\n\tpop\t{r0}\n\tbx\tr0\n').source).not.toContain('5');
  });

  test('control: `bx lr` keeps the value — lr is not the return register', () => {
    const src = dc('viaLr', '\tmov\tr0, #0x5\n\tbx\tlr\n').source;
    expect(src).toContain('return 5;');
    expect(src).toContain('s32 viaLr(void)');
  });

  test('control: `bx r1` keeps the value — only the register BRANCHED THROUGH is disqualified', () => {
    // agbcc also spells the interworking return through r1/r2; those leave r0 untouched, so a
    // value there is real. A blanket "any register epilogue means void" would lose it.
    const src = dc('viaR1', '\tpush\t{lr}\n\tmov\tr0, #0x5\n\tpop\t{r1}\n\tbx\tr1\n').source;
    expect(src).toContain('return 5;');
  });
});

describe('pre-UAL mnemonic spellings', () => {
  // Each pair below is ONE instruction with two accepted spellings, not two instructions. GNU `as`
  // assembles either to identical bytes, so a disassembler is free to emit whichever it likes --
  // and luvdis emits the legacy one. Before these were normalised, `ldsh` fell through the decode
  // switch to the loud `opaque` and the function declined with "unmodelled instruction 'ldsh'":
  // a lift refused over a spelling, on 14 functions of one real ROM.
  const legacy: ReadonlyArray<[string, string, string]> = [
    ['ldsh', '\tldsh\tr0, [r0, r1]\n\tbx\tlr\n', '\tldrsh\tr0, [r0, r1]\n\tbx\tlr\n'],
    ['ldsb', '\tldsb\tr0, [r0, r1]\n\tbx\tlr\n', '\tldrsb\tr0, [r0, r1]\n\tbx\tlr\n'],
    ['ldm', '\tldm\tr1!, {r0}\n\tbx\tlr\n', '\tldmia\tr1!, {r0}\n\tbx\tlr\n'],
    ['stm', '\tstm\tr1!, {r0}\n\tbx\tlr\n', '\tstmia\tr1!, {r0}\n\tbx\tlr\n'],
  ];

  test.each(legacy)('%s lifts, and identically to its UAL spelling', (_mn, legacyAsm, ualAsm) => {
    expect(dc('f', legacyAsm).source).toBe(dc('f', ualAsm).source);
  });

  test('the legacy spellings no longer decline as unmodelled', () => {
    // The pre-fix symptom, pinned so it cannot come back as a decline rather than as wrong output.
    for (const [, legacyAsm] of legacy) {
      expect(() => dc('f', legacyAsm)).not.toThrow();
    }
  });

  test('`ldm rN!, {…, pc}` is recognised as a return, not as an indirect jump', () => {
    // isReturn is why this is normalised at the parse site rather than with alias arms on each
    // decode `case`: it reads the mnemonic too, and its list carries `ldmia`/`ldmfd` but not bare
    // `ldm`. A per-case fix would have lifted the load and still mis-classified the control flow.
    expect(dc('f', '\tldm\tsp!, {r4, pc}\n').source).toBe(dc('f', '\tldmia\tsp!, {r4, pc}\n').source);
  });

  test('a mnemonic that merely STARTS with a legacy name is untouched', () => {
    // The table is keyed on the whole mnemonic, so nothing rewrites a prefix of a longer name.
    expect(() => dc('f', '\tldmxyz\tr1!, {r0}\n\tbx\tlr\n')).toThrow();
  });
});
