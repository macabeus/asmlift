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
  // Each pair below is ONE instruction with two accepted spellings, not two instructions: GNU `as`
  // assembles either to identical bytes (checked across 14 operand shapes). A disassembler is free
  // to emit whichever it likes, and luvdis emits the legacy one 472 times against 12 UAL in one
  // real ROM. Before normalisation `ldsh` fell through the decode switch to the loud `opaque` and
  // the function declined with "unmodelled instruction 'ldsh'" — a lift refused over a spelling.
  //
  // Pinned as EQUIVALENCE (legacy output === UAL output) rather than against expected source, so
  // the test cannot rot into asserting whatever the frontend happens to emit. Both corpus operand
  // shapes are covered: multi-register lists and a base that appears in its own list.
  const pairs: ReadonlyArray<[string, string, string]> = [
    ['ldsh', '\tldsh\tr0, [r0, r1]\n\tbx\tlr\n', '\tldrsh\tr0, [r0, r1]\n\tbx\tlr\n'],
    ['ldsb', '\tldsb\tr0, [r0, r1]\n\tbx\tlr\n', '\tldrsb\tr0, [r0, r1]\n\tbx\tlr\n'],
    ['ldm', '\tldm\tr1!, {r0}\n\tbx\tlr\n', '\tldmia\tr1!, {r0}\n\tbx\tlr\n'],
    ['ldm multi', '\tldm\tr0!, {r5, r6, r7}\n\tbx\tlr\n', '\tldmia\tr0!, {r5, r6, r7}\n\tbx\tlr\n'],
    ['ldm no-!', '\tldm\tr1, {r0}\n\tbx\tlr\n', '\tldmia\tr1, {r0}\n\tbx\tlr\n'],
    ['ldmfd', '\tldmfd\tr1!, {r0}\n\tbx\tlr\n', '\tldmia\tr1!, {r0}\n\tbx\tlr\n'],
    ['stm', '\tstm\tr1!, {r0}\n\tbx\tlr\n', '\tstmia\tr1!, {r0}\n\tbx\tlr\n'],
    ['stm base lowest', '\tstm\tr0!, {r0, r1}\n\tbx\tlr\n', '\tstmia\tr0!, {r0, r1}\n\tbx\tlr\n'],
    ['stmea', '\tstmea\tr1!, {r0}\n\tbx\tlr\n', '\tstmia\tr1!, {r0}\n\tbx\tlr\n'],
  ];

  test.each(pairs)('%s lifts, and identically to its UAL spelling', (_mn, legacyAsm, ualAsm) => {
    expect(dc('f', legacyAsm).source).toBe(dc('f', ualAsm).source);
  });

  test('`ldmfd rN, {rD}` loads — it used to be deleted outright', () => {
    // The reason ldmfd is in the table. Without it the op reaches opaqueDest, which takes ops[0] —
    // the BASE — as the destination; the opaque is then dead, DCE removes it, and the load simply
    // vanishes. That is a SILENT wrong answer, not a decline: it lifted to `return a0;`.
    expect(dc('f', '\tldmfd\tr1, {r0}\n\tbx\tlr\n').source).toContain('*a0');
  });

  test('Thumb-1 has no no-writeback LDM: the `!`-less spelling still advances the base', () => {
    // `ldm r1,{r0}` and `ldm r1!,{r0}` assemble to the SAME halfword (0xc901); GNU as warns "this
    // instruction will write back the base register", gba-kit executes both with the base
    // advanced, and GBATEK says "Both STM and LDM are incrementing the Base Register". The
    // frontend used to drive writeback off the `!`, which is syntax, not architecture.
    expect(dc('f', '\tldm\tr1, {r0}\n\tbx\tlr\n').source).toBe(dc('f', '\tldm\tr1!, {r0}\n\tbx\tlr\n').source);
  });

  test('an LDM whose base is in its own list does NOT write back', () => {
    // GBATEK, THUMB.15: "no writeback (LDM/ARMv4/ARMv5; at this point, THUMB opcodes work
    // different than ARM opcodes)". The loaded value wins.
    expect(dc('f', '\tldm\tr1, {r1, r2}\n\tbx\tlr\n').source).toContain('return a0;');
  });

  test('an STM storing its own base, not lowest, DECLINES rather than guessing', () => {
    // ARM calls the stored value UNPREDICTABLE and GNU as warns "value stored for r4 is UNKNOWN";
    // GBATEK records that it is version-specific — new base on ARMv4, old base on ARMv5. This
    // frontend targets ARMv4T and used to emit the ARMv5 answer silently.
    expect(() => dc('f', '\tstm\tr4!, {r0, r2, r4}\n\tbx\tlr\n')).toThrow(/UNPREDICTABLE/);
    // …but the LOWEST-entry case is defined (old base) and must still lift.
    expect(dc('f', '\tstm\tr0!, {r0, r1}\n\tbx\tlr\n').source).toContain('*a0 = a0;');
  });

  test('a decline names the spelling the INPUT used, not the canonical one', () => {
    // Normalising must not send a reader looking for an instruction their .s does not contain.
    // `ldsh r0` is malformed (one operand), so it degrades to the loud opaque and is reported.
    expect(() => dc('f', '\tldsh\tr0\n\tbx\tlr\n')).toThrow(/'ldsh'/);
    expect(() => dc('f', '\tldsh\tr0\n\tbx\tlr\n')).not.toThrow(/'ldrsh'/);
  });

  test('a mnemonic that merely STARTS with a legacy name is untouched', () => {
    // The table is keyed on the whole mnemonic, so no prefix of a longer name is rewritten.
    // A prefix-keyed table would make this lift instead of declining.
    expect(() => dc('f', '\tldmxyz\tr1!, {r0}\n\tbx\tlr\n')).toThrow(/ldmxyz/);
  });

  test('an inherited Object key is not treated as an entry', () => {
    // The table is null-prototype. With a plain object literal, `LEGACY_MNEMONICS['constructor']`
    // resolves to Object's own constructor and the mnemonic becomes the string
    // "function Object() { [native code] }". Unreachable from real assembly — no assembler emits
    // `constructor` — so the property to pin is the absence of that leak, not which error fires.
    const run = () => dc('f', '\tconstructor\tr0, r1\n\tbx\tlr\n');
    expect(run).toThrow();
    expect(run).not.toThrow(/native code|function Object/);
  });
});

// AAPCS puts arguments 1-4 in r0-r3 and pushes the rest, so the callee reads argument 5+ at
// `[sp, #N]` with N at or above its own frame. Those are PARAMETERS. Declining them as "sp used as
// data" refuses a calling convention — and it is separable from stack LOCALS, which still decline
// because they live BELOW the frame top.
describe('incoming stack arguments (AAPCS args 5+)', () => {
  // asmlift derives arity from the registers actually READ, so a body that never touches r0-r3
  // legitimately has none of them in its signature. These bodies read all four, which is what makes
  // the ABI ORDERING claim testable at all.
  const readsR0R3 = '\tadd\tr0, r0, r1\n\tadd\tr0, r0, r2\n\tadd\tr0, r0, r3\n';

  test('a read at the frame top is argument 5, not a local', () => {
    // frame = push {r4, lr} = 8 bytes; [sp, #8] is the first pushed argument => a4
    const body = `\tpush\t{r4, lr}\n${readsR0R3}\tldr\tr4, [sp, #8]\n\tadd\tr0, r0, r4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n`;
    expect(dc('f', body).source).toContain('s32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4)');
  });

  test('further slots are the following arguments, in ABI order', () => {
    // frame = 8; [sp,#8] -> a4, [sp,#0xc] -> a5, [sp,#0x10] -> a6. Read OUT of order on purpose:
    // the signature must follow the ABI, not the order the body happens to touch them.
    const body =
      `\tpush\t{r4, lr}\n${readsR0R3}` +
      '\tldr\tr4, [sp, #0x10]\n\tadd\tr0, r0, r4\n\tldr\tr4, [sp, #8]\n\tadd\tr0, r0, r4\n' +
      '\tldr\tr4, [sp, #0xc]\n\tadd\tr0, r0, r4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(dc('f', body).source).toContain('s32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4, s32 a5, s32 a6)');
  });

  test('an sp adjustment deepens the frame, so the same slot is a different argument', () => {
    // frame = 8 + 4 = 12; now [sp,#0xc] is the FIRST pushed argument, and [sp,#8] is a LOCAL
    const body = `\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n${readsR0R3}\tldr\tr4, [sp, #0xc]\n\tadd\tr0, r0, r4\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n`;
    expect(dc('f', body).source).toContain('s32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4)');
    expect(() => dc('f', body.replace('#0xc]', '#8]'))).toThrow(/stack pointer used as data/);
  });

  // Each of these is a refusal, and each keeps a LOCAL from being minted as a parameter.
  test('everything the frame walk cannot vouch for still declines', () => {
    const spAsData = /stack pointer used as data/;
    // below the frame top: a spill slot / local, NOT an argument (the separate slot capability)
    expect(() => dc('f', '\tpush\t{r4, lr}\n\tldr\tr0, [sp, #4]\n\tbx\tlr\n')).toThrow(spAsData);
    // sub-word: the argument area is word-granular, so a byte/halfword read is not a whole slot
    expect(() => dc('f', '\tpush\t{r4, lr}\n\tldrb\tr0, [sp, #8]\n\tbx\tlr\n')).toThrow(spAsData);
    expect(() => dc('f', '\tpush\t{r4, lr}\n\tldrh\tr0, [sp, #8]\n\tbx\tlr\n')).toThrow(spAsData);
    // unaligned: not a slot boundary
    expect(() => dc('f', '\tpush\t{r4, lr}\n\tldr\tr0, [sp, #0xa]\n\tbx\tlr\n')).toThrow(spAsData);
    // register offset: not a fixed slot
    expect(() => dc('f', '\tpush\t{r4, lr}\n\tldr\tr0, [sp, r1]\n\tbx\tlr\n')).toThrow(spAsData);
    // a WRITE to the argument area is not a parameter read
    expect(() => dc('f', '\tpush\t{r4, lr}\n\tstr\tr0, [sp, #8]\n\tbx\tlr\n')).toThrow(spAsData);
    // outside the entry block the depth is not established by a linear walk, so it declines
    const later =
      '\tpush\t{r4, lr}\n\tcmp\tr0, #0\n\tbeq\t.L1\n\tmov\tr0, #1\n\tbx\tlr\n.L1:\n\tldr\tr0, [sp, #8]\n\tbx\tlr\n';
    expect(() => dc('f', later)).toThrow(spAsData);
  });
});
