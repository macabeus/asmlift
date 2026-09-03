// Thumb frontend robustness. Pins that an unmodelled instruction with a register destination is
// never SILENTLY DROPPED (stale/absent value → confidently-wrong C): like the MIPS/PPC frontends,
// Thumb degrades it to a loud `opaque`. Toolchain-free.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import type { SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

const dc = (sym: string, body: string) => decompile(sym, `${sym}:\n${body}`, ARMV4T_AGBCC);

// THE SPELLING OF AN IMMEDIATE IS NOT ITS VALUE. Two producers feed this frontend and write the
// same zero differently — agbcc's own `.s` emits `#0`, a pret-style disassembly emits `#0x0` — so an
// idiom gated on the TOKEN is silently off for a whole project. Counting the two gated shapes over
// the vendored agbcc checkouts: sa3 writes `#0` 9510 times and `#0x0` never; klonoa writes `#0` 36
// times and `#0x0` 3533.
//
// The predicate is `immEq`, a LITERAL-shape test rather than a `parseInt`, and the refusal tests
// are why: `parseInt` stops at the first character it cannot consume, so `#0b1` reads as zero — and
// at the `rsb` site that turned a loud decline into a confident negate. The `add` site cannot make
// the same promise, because a non-match there falls through to `imm()` rather than refusing; the
// last test pins what that costs instead of pretending it does not exist.
describe('an immediate idiom is keyed on the VALUE, not the spelling', () => {
  const spellings = ['#0', '#0x0', '#0X0', '#00'];

  // Not cosmetic: the copy makes both sides the SAME SSA VALUE, which is what the pattern engine
  // (`{same:'X'}`) and the structurer's pre-update loop test compare on.
  test.each(spellings)('`add rD, rS, %s` is a register copy', (n) => {
    expect(dc('f', `\tpush\t{r4, lr}\n\tadd\tr0, r1, ${n}\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n`).source).toBe(
      's32 f(s32 a0) {\n    return a0;\n}\n',
    );
  });

  // This one degrades LOUD when unrecognised — an `rsb` the arm does not claim becomes an `opaque`,
  // so the wrong spelling costs the whole function rather than one `+ 0`.
  test.each(spellings)('`rsb rD, rS, %s` is a negate', (n) => {
    expect(dc('f', `\tpush\t{r4, lr}\n\trsb\tr0, r1, ${n}\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n`).source).toBe(
      's32 f(s32 a0) {\n    return -a0;\n}\n',
    );
  });

  // REFUSALS at the `rsb` site, where a non-match declines. `parseInt` reads every one of these as
  // zero; the shape test is the only thing between them and a confident negate.
  test.each(['#0X10', '#0b1', '#0.5', '#0e5', '#0*4'])('`rsb rD, rS, %s` is not a negate', (n) => {
    const rsb = (imm: string) => `\tpush\t{r4, lr}\n\trsb\tr0, r1, ${imm}\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n`;
    expect(() => dc('f', rsb('#0'))).not.toThrow(); // control
    expect(() => dc('f', rsb(n))).toThrow(/unmodelled instruction 'rsb'/);
  });

  // CHARACTERIZATION, not an assertion of correctness. A non-match at the `add` site falls through
  // to `constVal(imm(…))`, and `imm` does not read binary — gas assembles `#0b1` as `+ 1`. Nothing
  // in any corpus spells it (105411 `#` operands, zero of this class), so the honest move is to pin
  // the gap where a reader will find it rather than leave the header claiming it cannot happen.
  test('KNOWN GAP: a binary immediate reaches the `add` lowering and is misread', () => {
    const add = (imm: string) => `\tpush\t{r4, lr}\n\tadd\tr0, r1, ${imm}\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n`;
    expect(dc('f', add('#0X1')).source).toBe('s32 f(s32 a0) {\n    return a0 + 1;\n}\n'); // the radix fix
    expect(dc('f', add('#0b1')).source).toBe('s32 f(s32 a0) {\n    return a0 + 0;\n}\n'); // gas: + 1
  });
});

// THE SAME QUESTION FOR A REGISTER ALIAS, and here it decides CONTROL FLOW rather than a value, so
// missing it does not degrade: the write is not recognised as a transfer, no terminator forms, and
// execution runs on into the next block. `readData` already treats `pc` and `r15` as one register;
// `classifyXfer` did not.
describe('a PC write is a control transfer under either spelling', () => {
  const body = (dest: string, src: string) =>
    `\tpush\t{r4, lr}\n\tcmp\tr0, #0\n\tbeq\t.L1\n\tmov\t${dest}, ${src}\n.L1:\n\tadd\tr0, r0, #1\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n`;
  const RETURNS =
    's32 f(s32 a0) {\n    if (a0 != 0) {\n        return a0;\n    } else {\n        return a0 + 1;\n    }\n}\n';

  test.each([
    ['pc', 'lr'],
    ['r15', 'lr'],
    ['pc', 'r14'],
    ['r15', 'r14'],
  ])('`mov %s, %s` is the return', (dest, src) => {
    expect(dc('f', body(dest, src)).source).toBe(RETURNS);
  });

  // …and a PC write that is NOT the link register is an indirect jump, which declines. Spelled
  // `r15` it used to be no transfer at all: the early return vanished and the leftover read minted
  // a phantom parameter, both silently.
  test.each(['pc', 'r15'])('`mov %s, rN` is an indirect jump, loudly', (dest) => {
    expect(() => dc('f', body(dest, 'lr'))).not.toThrow(); // control
    expect(() => dc('f', body(dest, 'r3'))).toThrow(/indirect\/computed jump/);
  });
});

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

  test('a DEAD unmodelled op fails loud too — a dead DESTINATION is not a dead INSTRUCTION', () => {
    // `clz` writes r1, which is never read. That says nothing about what the instruction did to
    // memory or to system state, because `clz` here stands for "a mnemonic this frontend does not
    // model" — and the mnemonics that reach this path include real stores (see opaque-effects.test.ts).
    expect(() => dc('clzdead', '\tclz\tr1, r0\n\tadd\tr0, r0, #1\n\tbx\tlr\n').source).toThrow(
      /unmodelled instruction 'clz'/,
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

  test('a register list naming no register degrades loud, it does not invent one', () => {
    // The ldm/stm arm used to reject only a leftover `-` from an unexpandable range, so a token
    // naming nothing at all passed as if it were a register: `ldmia r1!, {foo}` emitted
    // `s32 f(s32 a0, s32 a1) { return a0; }` — a fabricated parameter, from a list it could not
    // read. Both this arm and the frame walk now share one definite-register predicate.
    // It declines outright rather than degrading to an opaque: with no readable list there is no
    // register destination to hang one on, which is the loudest of the available answers.
    expect(() => dc('f', '\tldmia\tr1!, {foo}\n\tbx\tlr\n')).toThrow(/unmodelled effect instruction/);
    expect(() => dc('f', '\tldmia\tr1!, {ip}\n\tbx\tlr\n')).toThrow(/unmodelled effect instruction/);
    // the well-formed spelling still lifts, so the guard is not simply refusing everything
    expect(dc('f', '\tldmia\tr1!, {r0}\n\tbx\tlr\n').source).toContain('*a0');
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

  test('a register RANGE in the prologue counts every register it names', () => {
    // `push {r4-r7, lr}` is FIVE registers = 20 bytes. Counting the comma-separated tokens instead
    // gives two, a frame 12 bytes too shallow — and then a genuine LOCAL at [sp,#8] is minted as a
    // parameter reading uninitialised stack. agbcc emits no range pushes and none of the 743
    // benchmark rows contains one, so only a probe catches this.
    const frameTop = 'f:\n\tpush\t{r4-r7, lr}\n\tldr\tr0, [sp, #0x14]\n\tbx\tlr\n';
    expect(decompile('f', frameTop, ARMV4T_AGBCC).source).toContain('a0');
    const local = 'f:\n\tpush\t{r4-r7, lr}\n\tldr\tr0, [sp, #0x8]\n\tbx\tlr\n';
    expect(() => decompile('f', local, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
  });

  test('a range the expander cannot expand poisons the depth instead of guessing it', () => {
    // expandRegList leaves an alias-endpoint range (`{r4-lr}`) unexpanded on purpose, surfacing
    // `lo, hi, rawToken` so a consumer refuses. Counting the two endpoints would call this frame 8
    // bytes and mint the local at [sp,#8] as a parameter. The depth must be EXACT or unknown.
    expect(() => decompile('f', 'f:\n\tpush\t{r4-lr}\n\tldr\tr0, [sp, #0x8]\n\tbx\tlr\n', ARMV4T_AGBCC)).toThrow(
      /stack pointer used as data/,
    );
  });

  test('an unread REGISTER argument is still a parameter once a stack slot proves it exists', () => {
    // r3 is read, r1 and r2 are not, and a stack argument at index 4 proves the caller passed at
    // least five. Naming is positional, so omitting r1/r2 binds every later parameter to the wrong
    // ABI slot — this emitted a 2-parameter signature where the convention proves 5.
    const b = 'rs:\n\tpush\t{r4, r5, lr}\n\tadd\tr4, r3, #0\n\tldr\tr0, [sp, #0xc]\n\tbx\tlr\n';
    expect(decompile('rs', b, ARMV4T_AGBCC).source).toContain('rs(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4)');
  });

  test('a register OVERWRITTEN before the read is still a parameter', () => {
    // The sibling of the test above, and a different mechanism: r0-r2 here are not merely unread,
    // they are DEFINED before the frame is read. `readVar` answers such a key with its local
    // definition and mints nothing, so asserting the obligation needs `ensureParam` — this emitted
    // `f(a0, a1, a2, a3) { return g() + a3; }`, arity 4 where the ABI proves 5, with the stack
    // argument bound to r3's slot. `bl` then a frame read is the commonest shape of it.
    const call = 'f:\n\tpush\t{r4, lr}\n\tbl\tg\n\tldr\tr1, [sp, #8]\n\tadd\tr0, r0, r1\n\tbx\tlr\n';
    expect(decompile('f', call, ARMV4T_AGBCC).source).toBe(
      's32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4) {\n    return g() + a4;\n}\n',
    );
    // …and the parameter stays UNUSED: the local value that was already flowing keeps flowing.
    const mov = 'f:\n\tpush\t{r4, lr}\n\tmov\tr0, #0\n\tldr\tr1, [sp, #8]\n\tbx\tlr\n';
    expect(decompile('f', mov, ARMV4T_AGBCC).source).toBe(
      's32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4) {\n    return 0;\n}\n',
    );
  });

  test('sp above the incoming sp poisons the walk, permanently', () => {
    // `add sp,sp,#8` then `push {r4,r5,r6}` leaves the depth at a plausible +4, but the push wrote
    // r5 to the slot at the incoming sp: [sp,#4] reads the function's OWN callee-saved register.
    // The proof that an argument slot is unwritten holds only while sp stays at or below where it
    // came in. This emitted `f(a0, …, a4) { return a4; }` — r5, presented as argument 5.
    const above = 'f:\n\tadd\tsp, sp, #0x8\n\tpush\t{r4, r5, r6}\n\tldr\tr0, [sp, #4]\n\tbx\tlr\n';
    expect(() => decompile('f', above, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
    // a `pop` gets there too — the depth need never be written as a literal
    const popped = 'f:\n\tpop\t{r4}\n\tpush\t{r4, r5}\n\tldr\tr0, [sp, #4]\n\tbx\tlr\n';
    expect(() => decompile('f', popped, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
    // and it does not recover: a legitimate-looking frame read AFTER the excursion still declines,
    // because a push during the excursion may have written that slot too
    const later = 'f:\n\tadd\tsp, sp, #0x8\n\tsub\tsp, sp, #0x8\n\tpush\t{r4, lr}\n\tldr\tr0, [sp, #8]\n\tbx\tlr\n';
    expect(() => decompile('f', later, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
  });

  test('a callee-saved live-in is not an argument at all, so it cannot displace a stack one', () => {
    // A `/^r(\d+)$/` rank sent `sl`/`sb` to 99 but ranked `r8` at 8 and `r4` at 4 — invisible while
    // nothing else occupied ranks >= 4, a positional miscompile once stack arguments ranked there.
    // sa3's sub_80B6B3C is the live one: 10 arguments, `mov r5, r8` in its prologue, so the r8
    // live-in and @sarg8 tied at 8 and the stable sort gave the slot to whichever was read first —
    // the prologue. ABI argument 8 came out as `a9`, and everything after it shifted.
    //
    // The register partition answers it one step earlier: a register this ABI does not pass
    // arguments in, saved by the prologue as this one is, never reaches the signature, so there is no
    // tie left to break. The rank stays what a target declaring no partition gets, and `lr` still
    // reaches it here.
    const hi =
      'f:\n\tpush\t{r4, r5, r6, r7, lr}\n\tmov\tr7, r8\n\tpush\t{r7}\n\tldr\tr0, [sp, #0x28]\n\tadd\tr0, r0, r7\n\tbx\tlr\n';
    // NINE parameters — the stack argument holds slot 8, and the r8 live-in is an uninitialised local
    expect(decompile('f', hi, ARMV4T_AGBCC).source).toBe(
      's32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4, s32 a5, s32 a6, s32 a7, s32 a8) {\n' +
        '    s32 uninit_r8;\n    return a8 + uninit_r8;\n}\n',
    );
    // The same at the low end, where a phantom `r4` would otherwise outrank argument 5. SAVED, which
    // the `hi` case already is, and which the rule requires: the next test is the other side.
    const lo =
      'f:\n\tpush\t{r4, r5, lr}\n\tadd\tr5, r4, #1\n\tldr\tr0, [sp, #0xc]\n\tadd\tr0, r0, r5\n' +
      '\tpop\t{r4, r5}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(decompile('f', lo, ARMV4T_AGBCC).source).toBe(
      's32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4) {\n    s32 uninit_r4;\n    return a4 + (uninit_r4 + 1);\n}\n',
    );
  });

  // The other side of that fixture's premise, and the reason it had to be stated: the rule is
  // "the compiler homed a local here", which is only true of a register the function SAVED.
  test('a register the prologue never saved is not one the compiler homed a local in', () => {
    // The MP2K engine's hand-written `ChnVolSetAsm` — vendored in klonoa, sa3 and pokeemerald
    // alike — receives two pointers in r4/r5 by a private convention and has no prologue at all.
    // Classified by the ABI alone it came out `s32 ChnVolSetAsm(void)` storing through
    // `uninit_r4`, with no diagnostic: a correct two-pointer signature traded for C that reads
    // whatever the registers happen to hold.
    const noSave = 'f:\n\tldrb\tr0, [r4, #0x12]\n\tstrb\tr0, [r5, #2]\n\tbx\tlr\n';
    expect(decompile('f', noSave, ARMV4T_AGBCC, { onGap: 'strict' }).source).toBe(
      's32 f(u8 * a0, u8 * a1) {\n    s32 v0;\n    v0 = a0[18];\n    a1[2] = v0;\n    return v0;\n}\n',
    );
    // PER REGISTER, not per function: saving r5 says nothing about r4, and a mid-function fragment
    // reached by agbcc's `bl`-as-a-long-branch is handed live values in registers it never saved
    // while saving the ones it uses itself.
    const half = 'f:\n\tpush\t{r5, lr}\n\tadd\tr5, r4, #1\n\tldr\tr0, [sp, #0x8]\n\tadd\tr0, r0, r5\n\tbx\tlr\n';
    expect(decompile('f', half, ARMV4T_AGBCC).source).toBe(
      's32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4, s32 a5) {\n    return a4 + (a5 + 1);\n}\n',
    );
    // r8-sl cannot be pushed directly, so agbcc saves them as `mov rLow, rHi; push {rLow}` — the
    // shape every high-register inhabitant in the corpus goes through. Read literally, the save set
    // would hold only the low register and the four of them would lose their local. (The `hi`
    // fixture above is the positive half; this is what happens without the mov.)
    const movless =
      'f:\n\tpush\t{r4, r5, r6, r7, lr}\n\tpush\t{r7}\n\tldr\tr0, [sp, #0x28]\n\tmov\tr1, r8\n\tadd\tr0, r0, r1\n\tbx\tlr\n';
    expect(decompile('f', movless, ARMV4T_AGBCC).source).toContain('s32 a9');
  });

  test('a register the ABI never asked anyone to preserve needs no save to hold a local', () => {
    // AAPCS leaves r12 (`ip`) to the caller, so agbcc homes a local there with no prologue at all —
    // `dma_fill_uninit` compiles to exactly this, `mov ip, rX` in some switch arms and a read past
    // one that writes nothing. Demanding a save here would hand that local back to the signature as
    // a fabricated parameter, which is what the rule was written to stop.
    const scratch = 'f:\n\tcmp\tr0, #0x0\n\tbeq\t.L1\n\tmov\tip, r1\n.L1:\n\tmov\tr0, ip\n\tbx\tlr\n';
    expect(decompile('f', scratch, ARMV4T_AGBCC, { onGap: 'strict' }).source).toBe(
      's32 f(s32 a0, s32 a1) {\n    s32 uninit_ip;\n    if (a0 == 0) a1 = uninit_ip;\n    return a1;\n}\n',
    );
  });

  // A guessed arity reads the argument REGISTERS, so it must respect what a call does to them.
  // r0..r3 are caller-saved: a value the call sits between cannot be an argument the caller set up,
  // and counting it invents arguments — which C89's implicit declarations accept silently.
  describe('a guessed call arity respects the caller-saved clobber', () => {
    const P = { f: { returnsVoid: true } };
    const dc = (body: string) =>
      decompile('f', `f:\n\tpush\t{lr}\n${body}\tpop\t{r0}\n\tbx\tlr\n`, ARMV4T_AGBCC, { prototypes: P }).source;

    test('a register set up BEFORE an intervening call is not an argument to the later one', () => {
      expect(dc('\tmov\tr1, #7\n\tbl\tfoo\n\tmov\tr0, #1\n\tbl\tbar\n')).toContain('bar(1);');
    });

    test('…and one set up after it still is', () => {
      expect(dc('\tbl\tfoo\n\tmov\tr0, #1\n\tmov\tr1, #2\n\tbl\tbar\n')).toContain('bar(1, 2);');
      // …and with no call in between, nothing is clobbered
      expect(dc('\tmov\tr1, #7\n\tmov\tr0, #1\n\tbl\tbar\n')).toContain('bar(1, 7);');
    });

    test('back-to-back calls are two statements, not a nest', () => {
      // The return register IS argument 0 here, so `foo(); bar();` and `bar(foo())` assemble to the
      // same bytes and the asm decides nothing. Only the nest needs `foo` to return a value and
      // `bar` to accept one — which the project's own header rejects outright when it does not —
      // and the caller set nothing up to say there is an argument at all.
      expect(dc('\tbl\tfoo\n\tbl\tbar\n')).toContain('foo();\n    bar();');
    });

    test('…and a declared arity is still how the nest is recovered', () => {
      const src = decompile('f', 'f:\n\tpush\t{lr}\n\tbl\tfoo\n\tbl\tbar\n\tpop\t{r0}\n\tbx\tlr\n', ARMV4T_AGBCC, {
        prototypes: { ...P, bar: { params: 1 } },
      }).source;
      expect(src).toContain('bar(foo());');
    });

    test('…and a later argument register the caller DID set up carries the result with it', () => {
      // agbcc's soft-float `a * b + c`: the product comes back in r0 and stays there while `c` goes
      // into r1. Argument 0 is unfresh and argument 1 is not — a one-argument `__addsf3` is not a
      // thing, so the run bridges across r0 rather than truncating the call to nothing.
      expect(dc('\tbl\t__mulsf3\n\tadd\tr1, r4, #0\n\tbl\t__addsf3\n')).toContain('__addsf3(__mulsf3(), ');
    });

    test('…across the HOLE a 64-bit return spans, where the later register is the only evidence', () => {
      // agbcc's soft-64 shift: `__muldi3`'s product occupies r0 AND r1, so argument 1 cannot be
      // filled from the register file at all — the pre-call `asr r1` it would read is the value the
      // callee overwrote. The caller's own `add r2` still proves the call takes arguments, so the
      // run keeps r0 and stops at the hole rather than reading the site as argument-less.
      expect(dc('\tbl\t__muldi3\n\tadd\tr2, r4, #0\n\tbl\t__ashrdi3\n')).toContain('__ashrdi3(__muldi3())');
    });

    test('a JOIN of that result with a caller-computed value stays an argument', () => {
      // `if (c > 5) x = gVar; else x = foo(); bar(x);` — r0 at `bar` is a merge, and the register
      // file cannot say which path put the value there. Reading it as the callee's own return drops
      // the argument, and the merge dies with it: the global load is then unreachable from the
      // emitted C, which no longer mentions gVar at all.
      const src = dc(
        '\tcmp\tr0, #0x5\n\tble\t.L3\n\tldr\tr0, .L5\n\tldr\tr0, [r0]\n\tb\t.L4\n' +
          '.L5:\n\t.word\tgVar\n.L3:\n\tbl\tfoo\n.L4:\n\tbl\tbar\n',
      );
      expect(src).toContain('gVar');
      expect(src).toMatch(/bar\(v\d\);/);
    });

    test('a clobber on ONE path is enough — the analysis is a must', () => {
      // r1 survives the fall-through path and dies on the other; an argument has to be set up on
      // every path, so `bar` gets one argument, not two.
      expect(dc('\tmov\tr1, #7\n\tcmp\tr0, #0\n\tbeq\t.L1\n\tbl\tfoo\n.L1:\n\tmov\tr0, #1\n\tbl\tbar\n')).toContain(
        'bar(1);',
      );
    });
  });

  test('asserting a parameter does not invent a value reaching anything', () => {
    // ensureParam must not write into `defs`: a parameter the convention PROVES exists is not
    // evidence that a value reaches a call site. hasReachingDef feeds fallbackArgc, so a def here
    // silently raised the guessed arity of every prototype-less call in the function — the callee
    // below took four arguments purely because its CALLER has a fifth, three of them registers the
    // calling block never set up.
    const withStackArg = 'f:\n\tpush\t{r4, lr}\n\tldr\tr4, [sp, #8]\n\tbl\tunknown\n\tbx\tlr\n';
    const src = decompile('f', withStackArg, ARMV4T_AGBCC).source;
    expect(src).toContain('s32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4)');
    expect(src).toContain('return unknown();'); // the arity the same call gets without the stack arg
    // control: the identical call in a function with no stack argument
    expect(decompile('f', 'f:\n\tpush\t{r4, lr}\n\tbl\tunknown\n\tbx\tlr\n', ARMV4T_AGBCC).source).toContain(
      'return unknown();',
    );
  });

  test('a dead spill into the frame is a local slot, not a store through sp', () => {
    // `str rX,[sp,#k]` wholly inside this function's own frame is a spill: it moves a value, it
    // does not touch memory anyone else can see. Modelled as an SSA variable keyed by the offset
    // (`sp@<off>`, the spelling the MIPS frontend already uses), a spill nothing reloads becomes a
    // dead def and drops — where before the whole function declined as "sp used as data".
    const spill =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tadd\tr0, r0, #1\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    const src = decompile('f', spill, ARMV4T_AGBCC).source;
    expect(src).toBe('s32 f(s32 a0) {\n    return a0 + 1;\n}\n');
  });

  test('a slot survives a round trip, and a loop, as one variable', () => {
    // store then reload is a value move, not memory traffic: the reload must produce the STORED
    // value, and a slot read-modify-written across a loop must become one variable with a phi —
    // which is why keying it as an SSA variable is the whole implementation.
    const trip =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tldr\tr1, [sp]\n\tadd\tr0, r1, #1\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(decompile('f', trip, ARMV4T_AGBCC).source).toBe('s32 f(s32 a0) {\n    return a0 + 1;\n}\n');
    // accumulate into the slot across a back-edge: one variable, no load/store left
    const loop =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tmov\tr2, #0\n\tstr\tr2, [sp]\n' +
      '.L1:\n\tldr\tr2, [sp]\n\tadd\tr2, r2, r0\n\tstr\tr2, [sp]\n\tsub\tr0, r0, #1\n\tcmp\tr0, #0\n\tbne\t.L1\n' +
      '\tldr\tr0, [sp]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    const src = decompile('f', loop, ARMV4T_AGBCC).source;
    expect(src).not.toContain('*'); // no pointer, no load through sp
    expect(src).toContain('do {');
  });

  test('a reload from a slot that was never stored still declines', () => {
    // The guard that keeps the model from fabricating: an unstored slot holds nothing this function
    // put there, so routing it through readVar would mint a phantom parameter and hand back a value
    // the machine never had. Above the frame that read IS an argument (the path above); inside the
    // frame it is an uninitialised local, and the decline is the honest answer.
    const unstored =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tldr\tr0, [sp]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('f', unstored, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
  });

  test('a sub-word access anywhere disables the model for the whole function', () => {
    // The MIPS lesson (round 5's B2-F1), ported with the capability: routing the WORD store to an
    // SSA slot while a byte reload of the same slot stays on the memory path would drop the store
    // and read uninitialised memory — a silent miscompile. One sub-word sp access anywhere puts
    // every sp access back on the path that declines.
    const alias =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tldrb\tr1, [sp]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('f', alias, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
    // …and it is FUNCTION-wide: the byte access is nowhere near the word slot it protects
    const far =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tstr\tr0, [sp]\n\tldr\tr1, [sp]\n\tstrb\tr1, [sp, #4]\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('f', far, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
  });

  test('a frame that moves under a keyed slot disables the model', () => {
    // The key IS the raw offset, so it only denotes one place while sp holds still. A prologue
    // before the accesses and an epilogue after them are fine; a shift BETWEEN two accesses moves
    // the frame under a slot already keyed, and [sp,#0] stops meaning what it meant.
    const shifts =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tstr\tr0, [sp]\n\tadd\tsp, sp, #0x4\n\tldr\tr1, [sp]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('f', shifts, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
  });

  test('a slot stored on only ONE arm of a branch is an uninitialised LOCAL, not a parameter', () => {
    // The shape: stored on one arm, reloaded at the join, so the other arm reaches the read with
    // nothing written. Braun's live-in path used to mint an entry parameter for the SLOT — a
    // one-argument function came out as `s32 f(s32 a0, s32 a1) { … return a1 + 1; }`, where `a1`
    // stands in for uninitialised stack — and the frontend refused rather than emit that.
    //
    // It no longer has to: a `sp@` key CANNOT be an incoming argument (an incoming stack argument
    // is keyed `@sarg<k>`, see stackArgKey — it sits at or above this frame, not below it), so the
    // live-in is storage this function owns that nobody wrote. `undef` names exactly that, and the
    // recovery is the bare declaration.
    const diamond =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tcmp\tr0, #0\n\tbeq\t.L2\n\tstr\tr0, [sp]\n' +
      '.L2:\n\tldr\tr1, [sp]\n\tadd\tr0, r1, #1\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r2}\n\tbx\tr2\n';
    // ONE parameter — the arity is the assertion. `uninit0` is declared and never assigned.
    expect(decompile('f', diamond, ARMV4T_AGBCC).source).toBe(
      's32 f(s32 a0) {\n    s32 uninit_sp0;\n    if (a0 == 0) a0 = uninit_sp0;\n    return a0 + 1;\n}\n',
    );
    // control: store it on BOTH arms and there is nothing undefined to declare
    const both =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tcmp\tr0, #0\n\tbeq\t.L2\n\tstr\tr0, [sp]\n' +
      '.L2:\n\tldr\tr1, [sp]\n\tadd\tr0, r1, #1\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r2}\n\tbx\tr2\n';
    expect(decompile('f', both, ARMV4T_AGBCC).source).toBe('s32 f(s32 a0) {\n    return a0 + 1;\n}\n');
    // …and the refusal that survives, NOT YET rather than by design. A slot no store reaches
    // ANYWHERE is the same C as the diamond above; the reasons one reaches for — frame arithmetic,
    // an address-taken object — are both caught elsewhere (`stack pointer used as data`, and the
    // `laddr` audit). What decides it is that the gate sits at the LOAD, before the slot is keyed
    // at all. Closing it means moving that gate, not finding a new argument.
    const unstored =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tldr\tr0, [sp]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('f', unstored, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
  });

  test('two unstored slots are two DISTINCT uninitialised locals, never merged', () => {
    // The property that keeps `undef` honest as a representation: two uninitialised locals in the
    // source are two variables, the compiler allocated them separately, and emitting one would
    // re-spell the function as one the compiler never saw.
    //
    // Pins the STRUCTURER, not raise/gvn.ts's NUMBERABLE set: adding `undef` there leaves this
    // green, because that pass numbers by attribute equality and these two undefs carry different
    // keys. Numbering `undef` is a no-op, not a hazard, so no test can hold that line by failing.
    const two =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tcmp\tr0, #0\n\tbeq\t.L2\n\tstr\tr0, [sp]\n\tstr\tr0, [sp, #4]\n' +
      '.L2:\n\tldr\tr1, [sp]\n\tldr\tr2, [sp, #4]\n\tadd\tr0, r1, r2\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r3}\n\tbx\tr3\n';
    // Each slot reaches the merge as its OWN variable, and neither carries the other's value. Only
    // one is spelled by KEY: `sp@0`'s merge adopted the incoming parameter's name, so its undefined
    // arm must overwrite `a0` — dropping that copy would hand the arm `a0`'s defined value instead
    // (undefCarriesNothing, structure.ts). `sp@4`'s merge names nothing else, so its undefined arm
    // assigns nothing and `v0` IS that uninitialised local.
    expect(decompile('f', two, ARMV4T_AGBCC).source).toBe(
      's32 f(s32 a0) {\n    s32 v0;\n    s32 uninit_sp0;\n' +
        '    if (a0 != 0) {\n        v0 = a0;\n    } else {\n        a0 = uninit_sp0;\n    }\n' +
        '    return a0 + v0;\n}\n',
    );
  });

  // …but an escape is TWO questions, and only one of them retracts. A frame address stored into a
  // device's SOURCE register is one the hardware READS from — the DMA-fill idiom, `vu16 tmp;
  // DmaSet(n, &tmp, dest, … DMA_SRC_FIXED …)`, which is how every vendored project spells a fill.
  // Nothing can write the frame back through it, so the `undef` survives; the address still LEFT
  // the function, so the object is still `volatile`.
  //
  // The three fixtures differ by one hex digit — the offset from the DMA base — which is what makes
  // this a test of the direction rather than of the address.
  describe('an escape that the hardware only READS through keeps the undef', () => {
    // one object at [sp,#0] escaping to DMA3<reg>, and an `undef` at [sp,#4] the switch never writes
    const escapeTo = (regOff: string) =>
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tmov\tr4, sp\n\tldr\tr2, .L9\n' +
      `\tstr\tr4, [r2, #${regOff}]\n` +
      '\tldr\tr1, [r4]\n\tcmp\tr1, #0\n\tbeq\t.L2\n\tstr\tr1, [sp, #4]\n' +
      '.L2:\n\tldr\tr3, [sp, #4]\n\tadd\tr0, r1, r3\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r5}\n\tbx\tr5\n' +
      '.L9:\n\t.word\t0x040000D4\n';

    test('DMA3SAD (+0) — the hardware reads the object, so the undef stands', () => {
      const src = decompile('f', escapeTo('0x00'), ARMV4T_AGBCC).source;
      expect(src).toContain('volatile s32 sp0;'); // the address still left the function
      // …but nothing can write [sp,#4], so its merge still has an undefined arm: `v0` is that
      // uninitialised local, declared and assigned only where the store runs.
      expect(src).toBe(
        's32 f(void) {\n    s32 v0;\n    volatile s32 sp0;\n    *(s32 *)67109076 = &sp0;\n' +
          '    if (sp0 != 0) v0 = sp0;\n    return sp0 + v0;\n}\n',
      );
    });

    test.each([
      ['0x04', 'DMA3DAD'],
      ['0x08', 'DMA3CNT'],
    ])('%s (%s) — not a source register, so the retraction stands', (regOff) => {
      expect(() => decompile('f', escapeTo('0x00'), ARMV4T_AGBCC)).not.toThrow(); // control
      expect(() => decompile('f', escapeTo(regOff), ARMV4T_AGBCC)).toThrow(
        /address-taken stack local — the captured address escapes/,
      );
    });

    // A SECOND OBJECT still refuses, and this rule is NOT narrowed with the other one. Its argument
    // is about layout, which is symmetric: a device reading past the object it was given is as
    // wrong as a callee writing past it. `DmaCopy` of two halfwords off `&sp0` transfers `[sp,#2]`
    // too — and the store to that second object is DELETED, since only the escaping one is
    // `volatile`, so the emitted source transfers whatever follows `sp0` instead.
    test('a second object still refuses, even when the escape only reads', () => {
      const twoObjects =
        'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x10\n\tmov\tr4, sp\n\tstrh\tr0, [r4]\n' +
        '\tmov\tr5, sp\n\tstrh\tr1, [r5, #0x2]\n\tldr\tr2, .L9\n\tstr\tr4, [r2, #0x0]\n' +
        '\tstr\tr3, [r2, #0x4]\n\tmov\tr0, #0x0\n\tadd\tsp, sp, #0x10\n\tpop\t{r4}\n\tpop\t{r5}\n\tbx\tr5\n' +
        '.L9:\n\t.word\t0x040000D4\n';
      expect(() => decompile('f', twoObjects, ARMV4T_AGBCC)).toThrow(/including another object/);
    });

    // Half an address is not the address: `strh` to a source register hands the device something
    // that is not this object, so the narrow answer stays the true one.
    test('a HALFWORD store to a source register is not vouched for', () => {
      const halfStore = escapeTo('0x00').replace('\tstr\tr4, [r2, #0x00]\n', '\tstrh\tr4, [r2, #0x00]\n');
      expect(halfStore).not.toBe(escapeTo('0x00'));
      expect(() => decompile('f', halfStore, ARMV4T_AGBCC)).toThrow(/address-taken stack local/);
    });

    // …and the ANSWER MUST NOT DEPEND ON `--syms`. The same pool word lifts to a `const` bare and
    // to a `gaddr` when a symbol map names its address, so a predicate keyed on the op rather than
    // on the address would switch this capability off for exactly the projects that supply a map.
    test('a source register reached by NAME is the same source register', () => {
      const symbols = new Map([
        [0x040000d4, [{ name: 'REG_DMA3SAD', kind: 'data' as const, macroBody: '(*(vu32 *)0x040000D4)' }]],
      ]);
      const withMap = decompile('f', escapeTo('0x00'), ARMV4T_AGBCC, { symbols }).source;
      expect(withMap).toContain('REG_DMA3SAD = &sp0;'); // the map really did rename it
      expect(withMap).toContain('if (sp0 != 0) v0 = sp0;'); // …and the undef still stands
    });

    // A LITERAL register offset folds, because the predicate resolves an ADDRESS and `[r2, r5]`
    // with `r5 = 0` names the same one as `[r2, #0]`. An offset it cannot fold does not.
    test('a register offset resolves when it is a literal and refuses when it is not', () => {
      const viaZero = escapeTo('0x00').replace('\tstr\tr4, [r2, #0x00]\n', '\tmov\tr5, #0x00\n\tstr\tr4, [r2, r5]\n');
      expect(viaZero).not.toBe(escapeTo('0x00'));
      expect(decompile('f', viaZero, ARMV4T_AGBCC).source).toContain('if (sp0 != 0) v0 = sp0;');

      // …and a runtime offset is a base this cannot resolve, so it takes the conservative answer
      const viaParam = escapeTo('0x00').replace('\tstr\tr4, [r2, #0x00]\n', '\tstr\tr4, [r2, r0]\n');
      expect(() => decompile('f', viaParam, ARMV4T_AGBCC)).toThrow(/address-taken stack local/);
    });

    // A NAME IS NOT AN ADDRESS: the same name at two addresses vouches for neither, or a map could
    // publish a frame address into ordinary RAM and still keep the `undef`.
    test('a name the map places at two addresses vouches for neither', () => {
      const ambiguous = new Map([
        [0x040000d4, [{ name: 'REG_DMA3SAD', kind: 'data' as const, macroBody: '(*(vu32 *)0x040000D4)' }]],
        [0x03001000, [{ name: 'REG_DMA3SAD', kind: 'data' as const, macroBody: '(*(vu32 *)0x03001000)' }]],
      ]);
      expect(() => decompile('f', escapeTo('0x00'), ARMV4T_AGBCC, { symbols: ambiguous })).toThrow(
        /address-taken stack local/,
      );
    });
  });

  test('an ESCAPED frame address retracts the undef argument — a callee may have written the slot', () => {
    // `undef` rests on "no store reaches this slot, therefore nobody wrote it", which holds only
    // while this function is the sole writer of its frame. `g(&sp0)` breaks that: the frame-object
    // audit bounds what WE access through the object (one word here), not what `g` does, so the
    // real object can be wider — `struct P p; g(&p);` reading only `p.x` — and `g` fills the later
    // words. Reading one back at a slot no store of ours reaches is reading the CALLEE's value, and
    // declaring it uninitialised would spell that value as garbage.
    const escaped =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tmov\tr4, sp\n\tmov\tr0, r4\n\tbl\tg\n' +
      '\tldr\tr1, [r4]\n\tcmp\tr1, #0\n\tbeq\t.L2\n\tstr\tr1, [sp, #4]\n' +
      '.L2:\n\tldr\tr2, [sp, #4]\n\tadd\tr0, r1, r2\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r3}\n\tbx\tr3\n';
    expect(() => decompile('f', escaped, ARMV4T_AGBCC)).toThrow(
      /address-taken stack local — the captured address escapes/,
    );
    // DISCRIMINATING CONTROL — the one that makes the title true. The same captured address,
    // dereferenced only in-function, with NO call anywhere: nobody else can reach the frame, so
    // the undef argument still holds and this LIFTS. Keyed on "a laddr exists" instead, the guard
    // declines this and names a callee the input does not contain — which is what the fixture
    // separates: without it the test cannot tell capture from escape.
    const captured =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tmov\tr4, sp\n\tldr\tr1, [r4]\n\tcmp\tr1, #0\n\tbeq\t.L2\n\tstr\tr1, [sp, #4]\n' +
      '.L2:\n\tldr\tr2, [sp, #4]\n\tadd\tr0, r1, r2\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r3}\n\tbx\tr3\n';
    expect(decompile('f', captured, ARMV4T_AGBCC).source).toBe(
      's32 f(void) {\n    s32 v0;\n    s32 sp0;\n    if (sp0 != 0) v0 = sp0;\n    return sp0 + v0;\n}\n',
    );
    // POSITIVE CONTROL: the same undefined slot with no address taken at all still recovers, so the
    // guard is the escape and not something incidental about the shape.
    const noEscape =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tstr\tr0, [sp]\n\tldr\tr1, [sp]\n\tcmp\tr1, #0\n\tbeq\t.L2\n\tstr\tr1, [sp, #4]\n' +
      '.L2:\n\tldr\tr2, [sp, #4]\n\tadd\tr0, r1, r2\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r3}\n\tbx\tr3\n';
    expect(decompile('f', noEscape, ARMV4T_AGBCC).source).toBe(
      's32 f(s32 a0) {\n    s32 v0;\n    if (a0 != 0) v0 = a0;\n    return a0 + v0;\n}\n',
    );
  });

  test('a push AFTER the reservation slides the slot window onto the pushed words', () => {
    // `localArea` is measured by a walk that SKIPS push/pop — right for the callee-saved block,
    // which sits above the local area — while the depth arithmetic `argIndex` uses counts push at
    // 4 bytes per register. A push after the reservation therefore moves sp without moving
    // `localArea`, and `[0, localArea)` stops naming the reserved area and starts naming the
    // PUSHED words. Those are written, by an instruction that is dataflow-transparent, so nothing
    // downstream can tell — and with `undef` in the model that stopped being a lost slot and became
    // a miscompile: [sp,#0] holds a0 on BOTH paths here, so the machine returns 0 when a0 == 0
    // while the emitted C returned `0 + garbage`. Not corpus-reachable — agbcc pushes before it
    // reserves — which is exactly why only a probe finds it.
    const pushAfter =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tpush\t{r0}\n\tcmp\tr0, #0\n\tbeq\t.L2\n\tstr\tr0, [sp]\n' +
      '.L2:\n\tldr\tr1, [sp]\n\tadd\tr0, r0, r1\n\tadd\tsp, sp, #0xc\n\tpop\t{r4}\n\tpop\t{r3}\n\tbx\tr3\n';
    expect(() => decompile('f', pushAfter, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
    // POSITIVE CONTROL — the same function with the push BEFORE the reservation, which is what real
    // agbcc emits, still models its slot. Without this the test would pass with the slot model
    // disabled outright.
    const pushBefore =
      'f:\n\tpush\t{r4, lr}\n\tpush\t{r0}\n\tadd\tsp, sp, #-0x8\n\tcmp\tr0, #0\n\tbeq\t.L2\n\tstr\tr0, [sp]\n' +
      '.L2:\n\tldr\tr1, [sp]\n\tadd\tr0, r0, r1\n\tadd\tsp, sp, #0xc\n\tpop\t{r4}\n\tpop\t{r3}\n\tbx\tr3\n';
    expect(decompile('f', pushBefore, ARMV4T_AGBCC).source).toBe(
      's32 f(s32 a0) {\n    s32 v0;\n    if (a0 != 0) v0 = a0;\n    return a0 + v0;\n}\n',
    );
  });

  test('a word slot may not straddle the top of the reserved area', () => {
    // The window test bounds the slot's END (`off + 4 <= localArea`), not its start. With a
    // localArea that is not a multiple of 4 a word at the top spans past it, and the bytes beyond
    // are the callee-saved block the epilogue pops back. Pre-existing and playground-only — no
    // valid ARMv4T encoding produces a non-multiple-of-4 sp adjust — but it is the same class as
    // the push hazard above (the window not being where the model thinks), so it is closed too.
    const straddle =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x6\n\tcmp\tr0, #0\n\tbeq\t.L2\n\tstr\tr0, [sp, #4]\n' +
      '.L2:\n\tldr\tr1, [sp, #4]\n\tadd\tr0, r0, r1\n\tadd\tsp, sp, #0x6\n\tpop\t{r4}\n\tpop\t{r3}\n\tbx\tr3\n';
    expect(() => decompile('f', straddle, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
    // POSITIVE CONTROL: one more reserved byte and the same word fits, so the bound is the end of
    // the slot and not the offset being nonzero.
    const fits =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tcmp\tr0, #0\n\tbeq\t.L2\n\tstr\tr0, [sp, #4]\n' +
      '.L2:\n\tldr\tr1, [sp, #4]\n\tadd\tr0, r0, r1\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r3}\n\tbx\tr3\n';
    expect(decompile('f', fits, ARMV4T_AGBCC).source).toBe(
      's32 f(s32 a0) {\n    s32 v0;\n    if (a0 != 0) v0 = a0;\n    return a0 + v0;\n}\n',
    );
  });

  test('the OUTGOING argument area is not a local, however far inside the frame it sits', () => {
    // agbcc reserves the bottom of the frame for arguments 5+ of the calls this function makes:
    // `add sp,#-8` … `str r2,[sp]` / `str r3,[sp,#4]` … `bl`. Nothing reloads them, so modelling
    // them as locals made them dead defs and DCE deleted them — the arguments vanished from the
    // call with no diagnostic. sa3's CreateEntity_Platform_0_0 (platform.c:734) forwards SIX and
    // came out as `CreateEntity_Platform(0, 0, a0, (u16)a1)`. "Inside my frame" is not "private":
    // the outgoing area belongs to the callee. A function that CALLS gets no slot model.
    const outgoing =
      'f:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x8\n\tstr\tr2, [sp]\n\tstr\tr3, [sp, #0x4]\n' +
      '\tmov\tr0, #0\n\tbl\tcallee\n\tadd\tsp, sp, #0x8\n\tpop\t{r4, r5}\n\tpop\t{r0}\n\tbx\tr0\n';
    expect(() => decompile('f', outgoing, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
  });

  test('a pop taken while the locals are still reserved is a frame READ, not bookkeeping', () => {
    // push/pop are transparent to dataflow, so a pop taken before the local area is released reads
    // a slot this model has retargeted into SSA — the load simply disagrees with the store, and
    // `f(a0)` returned a1. A real epilogue releases first (`add sp,#N; pop {…}`).
    const midFrame =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tpop\t{r1}\n\tadd\tr0, r1, #0\n\tpop\t{r4, pc}\n';
    expect(() => decompile('f', midFrame, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
    // …including from a block that has no slot access of its own to give it away
    const elsewhere =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tb\t.L2\n.L2:\n\tpop\t{r1}\n\tadd\tsp, sp, #0x4\n\tpop\t{r4, pc}\n';
    expect(() => decompile('f', elsewhere, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
    // control: release, then pop — agbcc's actual shape, which must keep working
    const proper =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tldr\tr1, [sp]\n\tadd\tr0, r1, #1\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(decompile('f', proper, ARMV4T_AGBCC).source).toBe('s32 f(s32 a0) {\n    return a0 + 1;\n}\n');
  });

  test('a slot offset must be word-ALIGNED, not merely word-wide', () => {
    // The key is the raw byte offset, so two overlapping words at unaligned offsets become two
    // independent variables and the overlap is lost: `str r0,[sp]; str r1,[sp,#2]; ldr r0,[sp]`
    // returned a0 as though slot 0's upper half had not been overwritten. GNU as rejects the
    // encoding, so this is hand-written input — which is exactly where there is no oracle.
    const unaligned =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tstr\tr0, [sp]\n\tstr\tr1, [sp, #2]\n\tldr\tr0, [sp]\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('f', unaligned, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
  });

  test('a store made BEFORE the frame is reserved is the caller`s, not a local', () => {
    // `localArea` is the PROLOGUE's reservation. Summing the whole entry block instead let a store
    // that precedes the reservation fall inside `off < localArea`, so a write to the CALLER's frame
    // was claimed as a private local and deleted: this emitted `s32 f(s32 a0) { return 7; }`.
    const early = 'f:\n\tstr\tr0, [sp]\n\tadd\tsp, sp, #-0x4\n\tmov\tr0, #7\n\tadd\tsp, sp, #0x4\n\tbx\tlr\n';
    expect(() => decompile('f', early, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
  });

  test('the reserved area is a NET quantity, and a slot cannot sit below sp', () => {
    // Counting only reservations and discarding releases left `localArea` larger than the region
    // actually below the callee-saved block, so `off < localArea` claimed the SAVED REGISTERS —
    // which the epilogue's pop reads back. This deleted the store and rendered a computed `bx` as
    // an ordinary return, and it fooled the pop gate too, since `released` is compared against the
    // same inflated number. No agbcc function adjusts sp upward before its first frame access, so
    // only a probe reaches it.
    const inflated =
      'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tsp, sp, #0x8\n\tstr\tr0, [sp]\n\tmov\tr0, #7\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('f', inflated, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
    const popGate =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tsp, sp, #0x4\n\tstr\tr0, [sp, #0x4]\n\tldr\tr1, [sp, #0x4]\n' +
      '\tadd\tr0, r1, #1\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r2}\n\tbx\tr2\n';
    expect(() => decompile('f', popGate, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
    // …and the other end: a NEGATIVE offset is below sp, outside any frame this reasons about
    const below =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp, #-0x4]\n\tldr\tr1, [sp, #-0x4]\n\tadd\tr0, r1, #1\n' +
      '\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r2}\n\tbx\tr2\n';
    expect(() => decompile('f', below, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
  });

  test('a declared arity may REFUSE the model, and may never accept it', () => {
    const body =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tldr\tr4, [sp]\n\tbl\tg\n' +
      '\tadd\tr0, r4, #1\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    // the slot is read back before the call, so the code-reading fallback admits it
    expect(decompile('f', body, ARMV4T_AGBCC).source).toContain('g(');
    // …and a callee declared with five parameters PROVES this frame has an outgoing area, whatever
    // else is unknown. Consuming those stores as call operands is the dual capability, unbuilt.
    expect(() => decompile('f', body, ARMV4T_AGBCC, { prototypes: { g: { params: 5 } } })).toThrow(
      /stack pointer used as data/,
    );
    // A declared FOUR proves nothing, so it must not change the verdict either way: a declaration
    // is a LOWER bound on the words a call pushes. A parameter can occupy more than one word, a
    // variadic list is a prefix, and a large struct return adds a hidden pointer argument — none of
    // which any prototype here records. An earlier cut read `arity <= 4` as proof of an empty area,
    // and then a TRUE fact turned a correct decline into wrong C.
    expect(decompile('f', body, ARMV4T_AGBCC, { prototypes: { g: { params: 4 } } }).source).toContain('g(');
    const twoStackArgs =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tstr\tr0, [sp]\n\tstr\tr1, [sp, #0x4]\n\tbl\tg\n' +
      '\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r2}\n\tbx\tr2\n';
    for (const proto of [undefined, { g: { params: 2 } }, { g: { params: ['s32', 's32', 's32', 'double'] } }]) {
      expect(() => decompile('f', twoStackArgs, ARMV4T_AGBCC, proto ? { prototypes: proto } : {})).toThrow(
        /stack pointer used as data/,
      );
    }
  });

  test('an argument block is contiguous from [sp,#0] — a lone higher slot is a spill, not an argument', () => {
    // AAPCS lays outgoing stack arguments at [sp,#0] upward, so a store at [sp,#4] can be argument
    // 6 only if argument 5 at [sp,#0] is supplied on a path to the same call. With offset 0 never
    // stored in the whole function, a pending [sp,#4] at a call is provably not an argument block —
    // this is kleod's ProcessInputAndUpdateEntities shape: `sp4` spilled early, m4aSongNumStart
    // called 80 lines later, sp4 read at the end. Refusing it was a false alarm.
    const spill4 =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tstr\tr0, [sp, #0x4]\n\tbl\tg\n\tldr\tr4, [sp, #0x4]\n' +
      '\tadd\tr0, r4, #1\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(decompile('f', spill4, ARMV4T_AGBCC).source).toContain('g(');
    // …but store [sp,#0] anywhere on a path to that call and the same shape refuses: the pending
    // higher slot now has its argument-block prefix, and the pair could be arguments 5 and 6
    const withBase =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tstr\tr1, [sp]\n\tstr\tr0, [sp, #0x4]\n\tbl\tg\n' +
      '\tldr\tr4, [sp, #0x4]\n\tadd\tr0, r4, #1\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('f', withBase, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
    // …and a pending [sp,#0] alone always refuses — the prefix condition is vacuous at zero
    const base0 =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tbl\tg\n\tldr\tr4, [sp]\n' +
      '\tadd\tr0, r4, #1\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('f', base0, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
  });

  test('a slot store reaching a call unread is judged by PATH, not by listing order', () => {
    // The store reaches `bl g` through one arm; the other arm's reload must not excuse it. Scanning
    // per block let a LABEL decide the verdict; scanning the flat listing let BLOCK ORDER decide,
    // because the reload in the first-listed arm cleared a store that reaches the call through the
    // second. Same CFG and same semantics either way, so both spellings must agree.
    const loadArmFirst =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tcmp\tr0, #0\n\tbne\t.L3\n' +
      '.L2:\n\tldr\tr4, [sp]\n\tadd\tr0, r4, #1\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
      '.L3:\n\tbl\tg\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    const callArmFirst =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tcmp\tr0, #0\n\tbeq\t.L2\n' +
      '.L3:\n\tbl\tg\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
      '.L2:\n\tldr\tr4, [sp]\n\tadd\tr0, r4, #1\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('f', loadArmFirst, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
    expect(() => decompile('f', callArmFirst, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
  });

  test('with no arity to prove it, a slot store may not reach a call unread', () => {
    // The fallback for a caller with no prototypes at all. It is calibration, not proof, so it is
    // deliberately conservative: a store reaching a call unread refuses whether or not a label
    // happens to sit in between. Making the scan block-local instead admitted the cross-block case,
    // where the accept/refuse boundary was a LABEL rather than anything semantic.
    const sameBlock =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tbl\tg\n\tldr\tr4, [sp]\n' +
      '\tadd\tr0, r4, #1\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    const crossBlock =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tcmp\tr0, #0\n\tbeq\t.L2\n.L2:\n\tbl\tg\n' +
      '\tldr\tr4, [sp]\n\tadd\tr0, r4, #1\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('f', sameBlock, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
    expect(() => decompile('f', crossBlock, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
    // …and a store never read back at all is the plainest signature of an argument
    const neverRead =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tb\t.L2\n.L2:\n\tbl\tg\n' +
      '\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('f', neverRead, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
    // control: a slot read back BEFORE the call is a local, and lifts
    const readFirst =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tldr\tr4, [sp]\n\tbl\tg\n' +
      '\tadd\tr0, r4, #1\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(decompile('f', readFirst, ARMV4T_AGBCC).source).toContain('g(');
  });

  test('a tail-merged call site sets its stack argument up in BOTH predecessors', () => {
    // agbcc really does hoist argument setup out of the calling block: sa3's Task_BonusFlower_Spawn
    // tail-merges two call sites, so argument 5 is stored in both predecessors with the `bl` in the
    // join. A per-block scan does not see that at all — and with a post-call reload of the same
    // offset to satisfy the never-read test, the store became a dead local and the argument was
    // dropped from the call. The scan runs over the whole listing for this reason.
    const tailMerged =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tcmp\tr0, #0\n\tbeq\t.L2\n\tldr\tr2, .LP\n\tstr\tr2, [sp]\n\tb\t.L3\n' +
      '.L2:\n\tldr\tr2, .LP\n\tstr\tr2, [sp]\n.L3:\n\tbl\tg\n\tldr\tr1, [sp]\n\tadd\tr0, r0, r1\n' +
      '\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r2}\n\tbx\tr2\n.LP:\n\t.word\t0x08051F54\n';
    expect(() => decompile('f', tailMerged, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
  });

  test('a reload in DEAD code is not evidence that live code reads the slot back', () => {
    // The never-read test scanned every block, so a reload that can never execute satisfied it for
    // live code — letting an argument store pass as a local. Only entry-reachable blocks count.
    const deadReload =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tb\t.L3\n' +
      '.L2:\n\tldr\tr1, [sp]\n.L3:\n\tbl\tg\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r2}\n\tbx\tr2\n';
    expect(() => decompile('f', deadReload, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
  });

  test('a refused function names the capability actually missing', () => {
    // The gap histogram is the improvement loop's work-list; "local stack frames not supported" was
    // a false attribution that sent the loop to build a thing that already works. Each blocker now
    // names itself. The generic message survives only for sp uses no sub-family claims.
    // (the plain `mov rD, sp` capture is now the laddr capability — its refusals carry their own
    // attributed messages, tested with the capability below; the COMPUTED capture still refuses)
    const addrComputed =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr4, sp, #0x4\n\tstr\tr0, [r4]\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('f', addrComputed, ARMV4T_AGBCC)).toThrow(/address of a stack local is computed/);
    const outgoing =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tbl\tg\n\tldr\tr4, [sp]\n' +
      '\tadd\tr0, r4, #1\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('f', outgoing, ARMV4T_AGBCC)).toThrow(/outgoing stack argument/);
    const arity =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tldr\tr4, [sp]\n\tbl\tg\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('f', arity, ARMV4T_AGBCC, { prototypes: { g: { params: 5 } } })).toThrow(
      /declared with 5 arguments/,
    );
    // every attributed sp message keeps the class prefix, so nothing keyed on it breaks
    expect(() => decompile('f', addrComputed, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
  });

  // A ONE-WORD FRAME WHOSE BASE IS PASSED TO A CALLEE — the only thing in this file that makes the
  // never-reloaded refusal stop firing, and never one fact. The capture alone proves nothing about
  // the layout: agbcc emits a bare `mov rD, sp` for a block-copy base too (a by-value struct
  // argument's outgoing area, a struct return's hidden pointer). `localArea === 4` excludes every
  // one of those that needs two frame words, and the frame-object audit re-proves the rest after
  // the lift — that a call really does take the address, and that the object is not one the callee
  // owns. Every fixture below carries the frame size as part of the shape being pinned.
  //
  // Unless a comment says otherwise the fixture is agbcc 2.9-arm-000512 output (`-O2
  // -mthumb-interwork -Wimplicit -fhex-asm -fprologue-bugfix`), not hand-written, because the whole
  // argument is about what that compiler's frame layout can and cannot be.
  describe('a one-word frame whose base is passed to a callee has no outgoing argument area', () => {
    // `void f(u32 i){ s32 w; w = gEnts[i].h; use(&w); }` — the store at [sp,#0] is never reloaded
    // BY US for the ordinary reason: the callee reads it through the pointer. Before this proof the
    // never-reloaded condition read that as argument 5 of `use` and refused, and 3 of the corpus's
    // rows (every one tagged `stack-addr`) declined on it.
    const addrTaken =
      'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tlsl\tr1, r0, #0x2\n\tadd\tr1, r1, r0\n\tlsl\tr1, r1, #0x2\n' +
      '\tldr\tr0, .L3\n\tadd\tr1, r1, r0\n\tldrh\tr0, [r1, #0x12]\n\tstr\tr0, [sp]\n\tmov\tr0, sp\n\tbl\tuse\n' +
      '\tadd\tsp, sp, #0x4\n\tpop\t{r0}\n\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n\t.word\t0x8057acc\n';

    test('the never-reloaded store at [sp,#0] becomes the object, not an argument', () => {
      const out = decompile('f', addrTaken, ARMV4T_AGBCC, { prototypes: { use: { params: 1, returnsVoid: true } } });
      // the store SURVIVES as a write to memory — routed into the SSA slot model instead it would
      // be a dead def, and DCE would delete the value the callee reads back
      expect(out.source).toMatch(/sp0 = /);
      expect(out.source).toContain('use(&sp0)');
    });

    // …and the evidence for all of it is an agbcc compile table, so the gate names agbcc. `armv4t`
    // has one compiler entry today; a second one free to overlay a dead one-word local with a
    // one-word outgoing area would otherwise inherit a proof nobody ran for it.
    test('a second armv4t compiler does not inherit the proof', () => {
      const notAgbcc = { ...ARMV4T_AGBCC, compiler: 'sdt' };
      expect(() => decompile('f', addrTaken, notAgbcc, { prototypes: { use: { params: 1 } } })).toThrow(
        /never reloaded/,
      );
    });

    // THE PIN THE PROOF RESTS ON. With a five-argument call in the same function, agbcc stages
    // argument 5 at [sp,#0] and the address-taken local moves ABOVE it — so `&w` is COMPUTED and
    // there is no bare `mov rD, sp` anywhere. Compiled, `void f(u32 i, s32 a, s32 b){ s32 w;
    // w = gEnts[i].h; five(a,b,a+b,a-b,a*b); use(&w); }` is this, verbatim. A frame with a genuine
    // outgoing area must keep declining, and it does — one gate earlier, on the spelling the
    // layout forces.
    test('a frame with a GENUINE outgoing argument area still declines', () => {
      const withArea =
        'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr4, r2, #0\n\tlsl\tr2, r0, #0x2\n\tadd\tr2, r2, r0\n' +
        '\tlsl\tr2, r2, #0x2\n\tldr\tr0, .L6\n\tadd\tr2, r2, r0\n\tldrh\tr0, [r2, #0x12]\n\tstr\tr0, [sp, #0x4]\n' +
        '\tadd\tr2, r1, r4\n\tsub\tr3, r1, r4\n\tmov\tr0, r1\n\tmul\tr0, r0, r4\n\tstr\tr0, [sp]\n' +
        '\tadd\tr0, r1, #0\n\tadd\tr1, r4, #0\n\tbl\tfive\n\tadd\tr0, sp, #0x4\n\tbl\tuse\n' +
        '\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n.L7:\n\t.align\t2, 0\n.L6:\n\t.word\t0x8057acc\n';
      expect(() => decompile('f', withArea, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
      // and the message stays TRUE for what it refuses: the local really is at a computed address
      expect(() => decompile('f', withArea, ARMV4T_AGBCC)).toThrow(/address of a stack local is computed/);
    });

    // The arity refusal runs FIRST and still wins. A frame that both stages a fifth argument and
    // passes its own base is a frame no agbcc layout produces, so the two facts contradict — and
    // the honest answer to a contradiction is the decline, not a guess about which one to believe.
    test('a declared fifth argument still refuses, whatever the capture says', () => {
      const bothFacts =
        'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tmov\tr0, sp\n\tbl\tuse\n' +
        '\tadd\tsp, sp, #0x4\n\tpop\t{r0}\n\tbx\tr0\n';
      expect(decompile('f', bothFacts, ARMV4T_AGBCC, { prototypes: { use: { params: 1 } } }).source).toContain(
        'use(&sp0)',
      );
      expect(() => decompile('f', bothFacts, ARMV4T_AGBCC, { prototypes: { use: { params: 5 } } })).toThrow(
        /declared with 5 arguments/,
      );
    });

    // WHAT THE PROOF NEEDS, one condition at a time. Each of these is the same function with one
    // link of the chain cut, and each must fall back to the refusal — an acceptance may never
    // over-approximate, so anything short of "this register holds sp+0 at this call" is not it.
    test('the capture must still be live, in an argument register, at a call in its own block', () => {
      // (i) OVERWRITTEN before the call — the argument register no longer holds the frame base
      const clobbered =
        'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tmov\tr0, sp\n\tadd\tr0, r4, #0\n\tbl\tuse\n' +
        '\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
      expect(() => decompile('f', clobbered, ARMV4T_AGBCC)).toThrow(/never reloaded/);
      // (ii) captured into a CALLEE-SAVED register and never passed — merely live across the call
      // is not "handed to" it
      const notAnArg =
        'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tmov\tr4, sp\n\tbl\tuse\n\tldrh\tr0, [r4]\n' +
        '\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
      expect(() => decompile('f', notAnArg, ARMV4T_AGBCC)).toThrow(/never reloaded/);
      // (iii) capture and call in DIFFERENT blocks — a block is straight-line, so "still held" is a
      // fact there and a path question anywhere else; the proof stays block-local rather than
      // guessing
      const crossBlock =
        'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tmov\tr0, sp\n\tb\t.L2\n' +
        '.L2:\n\tbl\tuse\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
      expect(() => decompile('f', crossBlock, ARMV4T_AGBCC)).toThrow(/never reloaded/);
      // …and a BARE REGISTER COPY does carry it, because a copy is the whole of what it does
      const viaCopy =
        'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tmov\tr4, sp\n\tmov\tr0, r4\n\tbl\tuse\n' +
        '\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
      expect(decompile('f', viaCopy, ARMV4T_AGBCC, { prototypes: { use: { params: 1 } } }).source).toContain(
        'use(&sp0)',
      );
    });

    // DEAD CODE IS NOT EVIDENCE. This is verbatim agbcc output for a five-argument forwarder —
    // `void ctl(int a,int b,int c,int d,int e){ five(a,b,c,d,e); }`, whose [sp,#0] store IS the
    // fifth outgoing argument — with one unreachable block appended after the return. Scanning
    // every block for the capture let that block license the whole frame, and the lift emitted
    // `five()` with all five arguments dropped.
    test('a capture in an unreachable block proves nothing', () => {
      const deadCapture =
        'ctl:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tldr\tr4, [sp, #0xc]\n\tstr\tr4, [sp]\n\tbl\tfive\n' +
        '\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n' +
        '.L_unreached:\n\tmov\tr0, sp\n\tbl\tuse\n\tbx\tlr\n';
      expect(() => decompile('ctl', deadCapture, ARMV4T_AGBCC)).toThrow(/never reloaded/);
      // CONTROL: the same three instructions on a REACHABLE path do license it, so the test is
      // about reachability and not about the shape of the appended block.
      const liveCapture = deadCapture.replace('\tbl\tfive\n', '\tbl\tfive\n\tb\t.L_unreached\n');
      expect(decompile('ctl', liveCapture, ARMV4T_AGBCC, { prototypes: { use: { params: 1 } } }).source).toContain(
        'use(&sp0)',
      );
    });

    // THE TWO RULES INSIDE THE SCAN THAT ARE NOT ABOUT THE FRAME. Both are hand-written, because
    // agbcc emits neither — and a rule inside an acceptance either carries a test or is decoration.
    test('a call does not carry the base past it, and a `blx` target is not an argument', () => {
      // (i) a CALLER-SAVED register that is not an argument register (`lr`, `ip`) does not survive
      // the call that clobbers it, so a copy made afterwards carries nothing. Without the clear this
      // lifted to `a(a0); use(&sp0)` on the strength of an `lr` the `bl` had already destroyed.
      const acrossCall =
        'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tmov\tlr, sp\n\tbl\ta\n' +
        '\tmov\tr0, lr\n\tbl\tuse\n\tadd\tsp, sp, #0x4\n\tpop\t{r0}\n\tbx\tr0\n';
      expect(() => decompile('f', acrossCall, ARMV4T_AGBCC)).toThrow(/never reloaded/);
      // (ii) `blx rN` names its TARGET in the operand slot: it branches THROUGH the frame base, it
      // does not pass it. Counting r3 there lifted this to `r3(a0)` — with the store to the frame
      // gone entirely, as a dead def.
      const blxTarget =
        'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tmov\tr3, sp\n\tblx\tr3\n' +
        '\tadd\tsp, sp, #0x4\n\tpop\t{r0}\n\tbx\tr0\n';
      expect(() => decompile('f', blxTarget, ARMV4T_AGBCC)).toThrow(/never reloaded/);
    });

    // THE CONTROL THE ACCEPTANCE ACTUALLY NEEDS: both facts present at once — a bare `mov rD, sp`
    // AND a genuine outgoing stack argument in the same frame. agbcc produces exactly that, and the
    // capture is not an addressable local at all: it is the destination of the block copy that
    // builds the outgoing area for a by-value struct argument, and `str r5,[sp]` is argument 5 of
    // `five` sharing the same area. `void g3(struct Huge *p, int x){ takesH(*p); five(1,2,3,4,x); }`
    // with `struct Huge { int a[40]; }`, compiled, is this verbatim.
    //
    // With the capture alone licensing the acceptance this lifted to `five(1, 2, 3, 4)` — the fifth
    // argument written into a fabricated 4-byte local, in a frame declared 4 bytes where the machine
    // reserves 0x90. No prototypes on purpose: that is the norm, and it is where the arity refusal
    // has nothing to say.
    test('a frame that BOTH passes its base and stages an outgoing argument still declines', () => {
      const blockCopyBase =
        'g3:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x90\n\tadd\tr4, r0, #0\n\tadd\tr5, r1, #0\n' +
        '\tadd\tr1, r4, #0\n\tadd\tr1, r1, #0x10\n\tmov\tr0, sp\n\tmov\tr2, #0x90\n\tbl\tmemcpy\n' +
        '\tldr\tr0, [r4]\n\tldr\tr1, [r4, #0x4]\n\tldr\tr2, [r4, #0x8]\n\tldr\tr3, [r4, #0xc]\n\tbl\ttakesH\n' +
        '\tstr\tr5, [sp]\n\tmov\tr0, #0x1\n\tmov\tr1, #0x2\n\tmov\tr2, #0x3\n\tmov\tr3, #0x4\n\tbl\tfive\n' +
        '\tadd\tsp, sp, #0x90\n\tpop\t{r4, r5}\n\tpop\t{r0}\n\tbx\tr0\n';
      expect(() => decompile('g3', blockCopyBase, ARMV4T_AGBCC)).toThrow(/never reloaded/);
      // ORDER IS NOT THE DISCRIMINATOR. The same source with the five-argument call FIRST puts the
      // argument store before the copy, and it must decline just the same.
      const argFirst =
        'g4:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x90\n\tadd\tr4, r0, #0\n\tstr\tr1, [sp]\n' +
        '\tmov\tr0, #0x1\n\tmov\tr1, #0x2\n\tmov\tr2, #0x3\n\tmov\tr3, #0x4\n\tbl\tfive\n' +
        '\tadd\tr1, r4, #0\n\tadd\tr1, r1, #0x10\n\tmov\tr0, sp\n\tmov\tr2, #0x90\n\tbl\tmemcpy\n' +
        '\tldr\tr0, [r4]\n\tldr\tr1, [r4, #0x4]\n\tldr\tr2, [r4, #0x8]\n\tldr\tr3, [r4, #0xc]\n\tbl\ttakesH\n' +
        '\tadd\tsp, sp, #0x90\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n';
      expect(() => decompile('g4', argFirst, ARMV4T_AGBCC)).toThrow(/never reloaded/);
    });

    // …and the other block-copy base: a STRUCT-RETURN TEMP, where `mov r0, sp` is the hidden return
    // pointer and the callee writes every byte of it. `struct Big { int a,b,c,d,e; }; void f(int x){
    // struct Big b = mk(x); use2(b.a); }` compiled — five words, so the frame size refuses it.
    //
    // A ONE-WORD one does not refuse there, which is why the frame size is not the whole gate:
    // agbcc returns a <=4-byte struct in MEMORY unless it is INTEGER-LIKE, and `struct S4 { char
    // a,b,c,d; }` (also `{short a,b;}`) comes back through a one-word frame temp whose `mov r0, sp`
    // is the hidden pointer — instruction for instruction an out-parameter call. Compiled, both:
    //
    //   struct R { int a; } / { int a[1]; } / { float f; }  → returned in r0, no frame at all
    //   struct S4 { char a,b,c,d; } / { short a,b; }        → `add sp,#-4 / mov r0,sp / bl mk`
    //
    // What separates them is that a return temp is storage the CALLEE owns: it is written only by
    // the callee, and its pointer is argument 0, always. Both are facts about the finished function
    // rather than the text, so the premise re-check in the frame-object audit owns them.
    test('a struct-return temp is not an object of the width we happen to touch', () => {
      const structReturn =
        'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x14\n\tadd\tr1, r0, #0\n\tmov\tr0, sp\n\tbl\tmk\n' +
        '\tldr\tr0, [sp]\n\tbl\tuse2\n\tadd\tsp, sp, #0x14\n\tpop\t{r0}\n\tbx\tr0\n';
      expect(() => decompile('f', structReturn, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
      // the ONE-WORD spelling of the same source — verbatim agbcc for `struct S4 { char a,b,c,d; };
      // void f(int x){ struct S4 s = mk(x); use2(s.a); }`. Lifting it emitted `mk(&sp0, a0)`: a
      // three-line function rendered as a call the real prototype rejects outright.
      const oneWordReturn =
        'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tadd\tr1, r0, #0\n\tmov\tr0, sp\n\tbl\tmk\n' +
        '\tldr\tr0, [sp]\n\tlsl\tr0, r0, #0x18\n\tlsr\tr0, r0, #0x18\n\tbl\tuse2\n' +
        '\tadd\tsp, sp, #0x4\n\tpop\t{r0}\n\tbx\tr0\n';
      expect(() => decompile('f', oneWordReturn, ARMV4T_AGBCC)).toThrow(/hidden struct-return pointer/);
      expect(() => decompile('f', oneWordReturn, ARMV4T_AGBCC, { prototypes: { mk: { params: 1 } } })).toThrow(
        /hidden struct-return pointer/,
      );
      // CONTROLS, one per fact. A store of OURS before the call is an in-out parameter no struct
      // return can be…
      const filledFirst =
        'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tmov\tr0, sp\n\tbl\tmk\n' +
        '\tldr\tr0, [sp]\n\tbl\tuse2\n\tadd\tsp, sp, #0x4\n\tpop\t{r0}\n\tbx\tr0\n';
      expect(decompile('f', filledFirst, ARMV4T_AGBCC, { prototypes: { mk: { params: 1 } } }).source).toContain(
        'mk(&sp0)',
      );
      // …and so is a never-written object handed over at r2, since the hidden pointer is argument 0
      // and nothing shifts it. sa3's `Task_Interactable116` and `sub_801DD68` are this shape.
      const outAtArg2 =
        'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tmov\tr1, r0\n\tmov\tr0, #0\n\tmov\tr2, sp\n\tbl\tmk\n' +
        '\tldr\tr0, [sp]\n\tbl\tuse2\n\tadd\tsp, sp, #0x4\n\tpop\t{r0}\n\tbx\tr0\n';
      expect(decompile('f', outAtArg2, ARMV4T_AGBCC, { prototypes: { mk: { params: 3 } } }).source).toContain('&sp0');
      // …and the THIRD fact, which is the only one that reads a DECLARATION rather than the
      // function's own instructions: a callee the project declares `void` returns nothing, so it
      // has no hidden return pointer to be given whatever sits in r0. The bytes are identical
      // either way — that is the whole difficulty — so the header is what separates them, arriving
      // through the same table whose `params` this frontend already trusts for arity.
      expect(
        decompile('f', oneWordReturn, ARMV4T_AGBCC, { prototypes: { mk: { params: 2, returnsVoid: true } } }).source,
      ).toContain('mk(&sp0');
    });

    // The refusal SURVIVES, narrowed: only a callee the project actually declared `void` gets past
    // it, and every callee that took the address at argument 0 has to be one.
    test('the void discriminator is a declaration, and everything short of one still refuses', () => {
      const oneWordReturn =
        'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tadd\tr1, r0, #0\n\tmov\tr0, sp\n\tbl\tmk\n' +
        '\tldr\tr0, [sp]\n\tlsl\tr0, r0, #0x18\n\tlsr\tr0, r0, #0x18\n\tbl\tuse2\n' +
        '\tadd\tsp, sp, #0x4\n\tpop\t{r0}\n\tbx\tr0\n';
      const declines = (prototypes: Record<string, { params?: number; returnsVoid?: boolean }>) =>
        expect(() => decompile('f', oneWordReturn, ARMV4T_AGBCC, { prototypes })).toThrow(/not declared `void`/);
      declines({});
      declines({ mk: { params: 2 } });
      declines({ mk: { params: 2, returnsVoid: false } });
      // a declaration of the WRONG symbol says nothing about `mk`
      declines({ use2: { params: 1, returnsVoid: true } });
    });

    // THE PRICE OF THE DISCRIMINATOR, pinned rather than described. `returnsVoid` is unchecked
    // project data and this is the one refusal in the frontend that a declaration switches off, so
    // a WRONG entry buys a compiling, plausible, wrong program where a loud decline stood. Asserted
    // so that nobody reads the guard above as covering it, and so that any future asm-side
    // corroboration has a fixture that changes when it starts working.
    test('a wrong `void` declaration buys a wrong program, not a worse one — the accepted price', () => {
      // Verbatim agbcc output for `struct S4 { char a,b,c,d; }; struct S4 mk(int x);
      // u32 sret(int x) { struct S4 s = mk(x); return s.a; }` — a REAL hidden struct return, whose
      // storage `mk` owns. Instruction for instruction the out-parameter shape, which is why the
      // assembly cannot decide it.
      const realStructReturn =
        'sret:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tadd\tr1, r0, #0\n\tmov\tr0, sp\n\tbl\tmk\n' +
        '\tldr\tr0, [sp]\n\tlsl\tr0, r0, #0x18\n\tlsr\tr0, r0, #0x18\n' +
        '\tadd\tsp, sp, #0x4\n\tpop\t{r1}\n\tbx\tr1\n';
      // Told the truth (or told nothing), it declines — the guard doing its job.
      expect(() => decompile('sret', realStructReturn, ARMV4T_AGBCC, { prototypes: {} })).toThrow(
        /not declared `void`/,
      );
      // Told that `mk` returns nothing, it believes the manifest and models the callee's own
      // storage as this function's local. The argument goes too, because the same entry fixes the
      // arity — so the loud decline is traded for a silent wrong answer, and the trade is the
      // manifest's, not the frontend's.
      const wrong = decompile('sret', realStructReturn, ARMV4T_AGBCC, {
        prototypes: { mk: { params: 1, returnsVoid: true } },
      }).source;
      expect(wrong).toContain('mk(&sp0)');
      expect(wrong).not.toContain('mk(&sp0, a0)');
    });

    // TWO callees at argument 0 and only one declared: the ambiguity stands for the object, so the
    // whole lift refuses. The rule is per OBJECT, not per call — one register file, one decision.
    test('every callee that took the address at argument 0 must be declared void', () => {
      const twoCallees =
        'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tmov\tr0, sp\n\tbl\tfill\n' +
        '\tmov\tr0, sp\n\tbl\tmk\n\tldr\tr0, [sp]\n\tadd\tsp, sp, #0x4\n\tpop\t{r1}\n\tbx\tr1\n';
      expect(() =>
        decompile('f', twoCallees, ARMV4T_AGBCC, {
          prototypes: { fill: { params: 1, returnsVoid: true }, mk: { params: 1 } },
        }),
      ).toThrow(/not declared `void`/);
      // …and with BOTH declared it lifts
      expect(
        decompile('f', twoCallees, ARMV4T_AGBCC, {
          prototypes: { fill: { params: 1, returnsVoid: true }, mk: { params: 1, returnsVoid: true } },
        }).source,
      ).toContain('fill(&sp0)');
    });

    // THE LICENCE, RE-ASKED OF THE IR. `capturedObjectIsTheWholeFrame` reads the TEXT for "a
    // register holding sp reaches a `bl` as an argument"; the audit knows exactly what the finished
    // function passes. Where they disagree the licence is the wrong one, and an acceptance whose
    // premise nothing re-checks is the cheapest place for a wrong answer to hide.
    test('the acceptance is refused when the lifted function does not pass the address to a call', () => {
      // a declared arity DROPS the address: the licence claimed `use` receives the frame base and
      // the emitted call takes nothing — which also loses `five`'s fifth outgoing argument
      const droppedByArity =
        'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr4, [sp]\n\tmov\tr0, sp\n\tbl\tuse\n' +
        '\tmov\tr0, #0x1\n\tmov\tr1, #0x2\n\tmov\tr2, #0x3\n\tmov\tr3, #0x4\n\tbl\tfive\n' +
        '\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n';
      expect(() => decompile('f', droppedByArity, ARMV4T_AGBCC, { prototypes: { use: { params: 0 } } })).toThrow(
        /no call in the lifted function takes it/,
      );
      // CONTROL: the same function with `use` taking its argument is the shape this capability is
      // for, and lifts.
      expect(decompile('f', droppedByArity, ARMV4T_AGBCC, { prototypes: { use: { params: 1 } } }).source).toContain(
        'use(&sp0)',
      );
    });

    // A SPELLING IS NOT A FACT. The scan that licenses the acceptance drops a register the moment an
    // instruction mentions it, and a RANGE-spelled register list mentions none of the registers it
    // writes — so the same function lifted or declined on whether its `pop` was written `{r0-r3}`
    // or `{r0, r1, r2, r3}`. The accepting side is verbatim agbcc for `void f(int a,b,c,d,e){
    // five(a,b,c,d,e); }`, whose [sp,#0] store IS the fifth outgoing argument, with a capture the
    // `pop` clobbers before the call: it emitted `five()` with all five arguments dropped.
    test('a register RANGE kills the capture exactly as the enumerated list does', () => {
      const withList = (list: string) =>
        'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tldr\tr4, [sp, #0xc]\n\tstr\tr4, [sp]\n\tmov\tr2, sp\n' +
        `\tadd\tsp, sp, #0x4\n\tpop\t{${list}}\n\tadd\tsp, sp, #-0x4\n\tbl\tfive\n` +
        '\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n';
      for (const list of ['r0, r1, r2, r3', 'r0-r3', 'R0-R3', 'r1-r3']) {
        expect(() => decompile('f', withList(list), ARMV4T_AGBCC)).toThrow(/never reloaded/);
      }
      // …and the same for a range on a multi-load, which writes the list without popping it
      const viaLdmia =
        'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tldr\tr4, [sp, #0xc]\n\tstr\tr4, [sp]\n\tmov\tr2, sp\n' +
        '\tldmia\tr1!, {r0-r3}\n\tbl\tfive\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n';
      expect(() => decompile('f', viaLdmia, ARMV4T_AGBCC)).toThrow(/never reloaded/);
    });

    // …AND WHAT AN ESCAPE COSTS THE SLOT MODEL, refused. The object's extent is inferred from OUR
    // accesses, so a wider real object has its later words written by the callee — and any of them
    // modelled as an SSA slot is a value the slot model forwards ACROSS the call that overwrote it.
    //
    // The fixture is the pair, because the pair is the argument: these two sources compile to ONE
    // instruction stream, byte for byte, and they disagree about who owns [sp,#4].
    //
    //   u8 b;              s32 t0,t2..t7;  b = x; t0 = h(0); t   = h(1); … g(&b); use2(t0 + t   + …);
    //   struct M { u8 b; u8 pad[3]; s32 t; } m;  m.b = x; …    m.t = h(1); … g(&m); use2(t0 + m.t + …);
    //
    // The eight `h` results exhaust the callee-saved registers, so one of them spills to [sp,#4] —
    // and a spill is the only neighbour that can produce this shape. What moves the object OFF
    // [sp,#0] is a neighbour that is MEMORY-HOMED, not one that is merely declared: all eight here
    // are declared and the address-taken byte still sits at [sp,#0], because a declared local lives
    // in a register until something spills it. Compiled, all three:
    //
    //   u8 b; s32 t;           b = x; t = h(1); g(&b); use2(t);   frame 4, `mov r1, sp / strb r0,[r1]`
    //   u8 b; volatile s32 t;  …same body…                        frame 8, `add r4, sp, #0x4`
    //   u8 a; u8 arr[8];       a = x; garr(arr); g(&a); …          frame 0xc, `add r4, sp, #0x8`
    //
    // A homed neighbour takes [sp,#0] and the address-taken local goes above it, spelled `add rD,
    // sp, #k` — which declines earlier, on the spelling the layout forces. So the ambiguity is
    // exactly "an addressable local at [sp,#0] with a reload spill above it", and no reading of the
    // assembly resolves it: `struct M` needs the reload after `bl g` to read what `g` wrote, `u8 b`
    // needs it to read what we stored.
    // Without this rule both lifted to the same source — `g(&sp0); use2(v0 + v1 + …)` with the
    // reload replaced by the value from before the call, `g`'s write dropped, no diagnostic.
    test('a callee handed the frame base refuses the slot model above it', () => {
      const slotAbove =
        's_bytes_and_slot:\n' +
        '\tpush\t{r4, r5, r6, r7, lr}\n' +
        '\tmov\tr7, sl\n' +
        '\tmov\tr6, r9\n' +
        '\tmov\tr5, r8\n' +
        '\tpush\t{r5, r6, r7}\n' +
        '\tadd\tsp, sp, #-0x8\n' +
        '\tmov\tr1, sp\n' +
        '\tstrb\tr0, [r1]\n' +
        '\tmov\tr0, #0x0\n' +
        '\tbl\th\n' +
        '\tadd\tr4, r0, #0\n' +
        '\tmov\tr0, #0x1\n' +
        '\tbl\th\n' +
        '\tstr\tr0, [sp, #0x4]\n' +
        '\tmov\tr0, #0x2\n' +
        '\tbl\th\n' +
        '\tadd\tr7, r0, #0\n' +
        '\tmov\tr0, #0x3\n' +
        '\tbl\th\n' +
        '\tmov\tsl, r0\n' +
        '\tmov\tr0, #0x4\n' +
        '\tbl\th\n' +
        '\tmov\tr9, r0\n' +
        '\tmov\tr0, #0x5\n' +
        '\tbl\th\n' +
        '\tmov\tr8, r0\n' +
        '\tmov\tr0, #0x6\n' +
        '\tbl\th\n' +
        '\tadd\tr6, r0, #0\n' +
        '\tmov\tr0, #0x7\n' +
        '\tbl\th\n' +
        '\tadd\tr5, r0, #0\n' +
        '\tmov\tr0, sp\n' +
        '\tbl\tg\n' +
        '\tldr\tr0, [sp, #0x4]\n' +
        '\tadd\tr4, r4, r0\n' +
        '\tadd\tr4, r4, r7\n' +
        '\tadd\tr4, r4, sl\n' +
        '\tadd\tr4, r4, r9\n' +
        '\tadd\tr4, r4, r8\n' +
        '\tadd\tr4, r4, r6\n' +
        '\tadd\tr4, r4, r5\n' +
        '\tadd\tr0, r4, #0\n' +
        '\tbl\tuse2\n' +
        '\tadd\tsp, sp, #0x8\n' +
        '\tpop\t{r3, r4, r5}\n' +
        '\tmov\tr8, r3\n' +
        '\tmov\tr9, r4\n' +
        '\tmov\tsl, r5\n' +
        '\tpop\t{r4, r5, r6, r7}\n' +
        '\tpop\t{r0}\n' +
        '\tbx\tr0\n';
      expect(() => decompile('s_bytes_and_slot', slotAbove, ARMV4T_AGBCC)).toThrow(
        /passed to a callee, which may write the slot at \[sp,#4\]/,
      );
      // CONTROL, and it is what makes the refusal a rule about the SLOT rather than about the call:
      // drop the second word and the identical capture, escape and call lift.
      const oneWord =
        'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tmov\tr0, sp\n\tbl\tg\n' +
        '\tadd\tsp, sp, #0x4\n\tpop\t{r0}\n\tbx\tr0\n';
      expect(decompile('f', oneWord, ARMV4T_AGBCC, { prototypes: { g: { params: 1 } } }).source).toContain('g(&sp0)');
    });

    // THE SAME HAZARD ONE ESCAPE OVER. A callee is not the only writer that can reach this frame:
    // publish the base to an ordinary global and any later call writes through it. Verbatim agbcc
    // for `struct M { u8 b; u8 pad[3]; s32 t; }; extern struct M *gp; void pub(s32 x){ struct M m;
    // m.b = x; m.t = h(1); gp = &m; g2(); use2(m.t); }` — the machine RELOADS [sp,#4] after
    // `bl g2`, so the value the source reads there is the one `g2` wrote.
    //
    // Keyed on `passedToCallee` this lifted as `use2(v0)`: the reload replaced by the value from
    // before the call, `g2`'s write dropped, no diagnostic.
    test('a PUBLISHED frame base refuses the slot model above it too', () => {
      const publishedSlot =
        'pub:\n' +
        '\tpush\t{lr}\n' +
        '\tadd\tsp, sp, #-0x8\n' +
        '\tmov\tr1, sp\n' +
        '\tstrb\tr0, [r1]\n' +
        '\tmov\tr0, #0x1\n' +
        '\tbl\th\n' +
        '\tstr\tr0, [sp, #0x4]\n' +
        '\tldr\tr0, .L3\n' +
        '\tmov\tr1, sp\n' +
        '\tstr\tr1, [r0]\n' +
        '\tbl\tg2\n' +
        '\tldr\tr0, [sp, #0x4]\n' +
        '\tbl\tuse2\n' +
        '\tadd\tsp, sp, #0x8\n' +
        '\tpop\t{r0}\n' +
        '\tbx\tr0\n' +
        '.L4:\n\t.align\t2, 0\n.L3:\n\t.word\tgp\n';
      const protos = { prototypes: { h: { params: 1 }, g2: { params: 0 }, use2: { params: 1 } } };
      expect(() => decompile('pub', publishedSlot, ARMV4T_AGBCC, protos)).toThrow(
        /is stored to memory, which may write the slot at \[sp,#4\]/,
      );
      // …and the MULTI-WORD analogue, where the same escape loses two reloads rather than one:
      // `struct N { u8 b; u8 pad[3]; s32 t, u; }` filled the same way and read back as `m.t + m.u`
      // lifted as `use2(v0 + v1)`. Verbatim agbcc, frame 0xc.
      const publishedTwoSlots =
        'pubw:\n' +
        '\tpush\t{lr}\n' +
        '\tadd\tsp, sp, #-0xc\n' +
        '\tmov\tr1, sp\n' +
        '\tstrb\tr0, [r1]\n' +
        '\tmov\tr0, #0x1\n' +
        '\tbl\th\n' +
        '\tstr\tr0, [sp, #0x4]\n' +
        '\tmov\tr0, #0x2\n' +
        '\tbl\th\n' +
        '\tstr\tr0, [sp, #0x8]\n' +
        '\tldr\tr0, .L3\n' +
        '\tmov\tr1, sp\n' +
        '\tstr\tr1, [r0]\n' +
        '\tbl\tg2\n' +
        '\tldr\tr0, [sp, #0x4]\n' +
        '\tldr\tr1, [sp, #0x8]\n' +
        '\tadd\tr0, r0, r1\n' +
        '\tbl\tuse2\n' +
        '\tadd\tsp, sp, #0xc\n' +
        '\tpop\t{r0}\n' +
        '\tbx\tr0\n' +
        '.L4:\n\t.align\t2, 0\n.L3:\n\t.word\tgq\n';
      expect(() => decompile('pubw', publishedTwoSlots, ARMV4T_AGBCC, protos)).toThrow(
        /is stored to memory, which may write the slot at \[sp,#4\]/,
      );
      // CONTROL, and it is what makes `mayWrite` the right predicate rather than `escaped`: the
      // SAME publish to a DMA source register keeps lifting, because the device reads through the
      // address and never writes it (`readsThrough`). Only the sink word differs from `pub`.
      const dmaSink = publishedSlot.replace('.word\tgp', '.word\t0x40000d4');
      expect(decompile('pub', dmaSink, ARMV4T_AGBCC, protos).source).toContain('volatile u8 sp0;');
    });

    // THE MULTI-WORD ANALOGUE of the same hazard, which declines LOUDLY — but at the first gate it
    // meets, not at the rule that owns it, and the assertion pins only the former. Compiled,
    // `struct W { s32 a,b,c,d; }; void f(s32 x){ struct W w; w.a=x; w.b=x+1; w.c=x+2; w.d=x+3;
    // g(&w); use2(w.a+w.b+w.c+w.d); }`. Every extra word is another value a callee may write and
    // this function reads back, so what the refusal costs grows with the extent while what licenses
    // an acceptance does not.
    //
    // WHICH GATE, measured both ways, because the message is easy to read as an attribution and it
    // is not one. Today it lands on the contiguity filter, whose wording offers "it may be that
    // call's outgoing stack argument". What rules that out here is NOT that `mov r0, sp` is live
    // in r0 at the `bl` — the `g3` fixture above is a compiled frame where exactly that co-exists
    // with a genuine outgoing argument at [sp,#0], because the copy is a block-copy base. It is
    // that all four stores are RELOADED after the call: an outgoing argument is read by the callee
    // and never by the caller, which is the filter's own condition (a) and the one it is not
    // applying. Widen `capturedObjectIsTheWholeFrame` to `localArea >= 4` and this same fixture
    // declines at the rule above instead: "the captured address at [sp,#0) is passed to a callee,
    // which may write the slot at [sp,#4]". That is the refusal this shape belongs to, and a
    // reader chasing the contiguity filter would be attacking the wrong one.
    test('a multi-word object handed to a callee declines, at the first gate it meets', () => {
      const fourWords =
        'hazw:\n' +
        '\tpush\t{lr}\n' +
        '\tadd\tsp, sp, #-0x10\n' +
        '\tstr\tr0, [sp]\n' +
        '\tadd\tr1, r0, #0x1\n' +
        '\tstr\tr1, [sp, #0x4]\n' +
        '\tadd\tr1, r0, #0x2\n' +
        '\tstr\tr1, [sp, #0x8]\n' +
        '\tadd\tr0, r0, #0x3\n' +
        '\tstr\tr0, [sp, #0xc]\n' +
        '\tmov\tr0, sp\n' +
        '\tbl\tg\n' +
        '\tldr\tr0, [sp]\n' +
        '\tldr\tr1, [sp, #0x4]\n' +
        '\tadd\tr0, r0, r1\n' +
        '\tldr\tr1, [sp, #0x8]\n' +
        '\tadd\tr0, r0, r1\n' +
        '\tldr\tr1, [sp, #0xc]\n' +
        '\tadd\tr0, r0, r1\n' +
        '\tbl\tuse2\n' +
        '\tadd\tsp, sp, #0x10\n' +
        '\tpop\t{r0}\n' +
        '\tbx\tr0\n';
      expect(() => decompile('hazw', fourWords, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
    });

    // …AND THE TWO SHAPES WHOSE EXTENT THE ASM DOES PIN, which is what stops the twin's undecidable
    // slot from being read as a universal about an object's top. Both still decline, for reasons
    // that are not about extent at all.
    // Each fixture is verbatim agbcc 2.9-arm-000512 output (`-O2 -mthumb-interwork -Wimplicit
    // -fhex-asm -fprologue-bugfix`), and each pins WHICH refusal answers, so a later round widening
    // the frame licence is told what it has actually reached.
    //
    // Sub-word members, `struct Q { u8 a; u8 pad[3]; u8 b; }; void q_bytes(s32 x){ struct Q q;
    // q.a = x; q.b = x + 1; g(&q); use2(q.a + q.b); }`. Thumb has no sp-relative `strb`, so both
    // members are reached THROUGH a copy of sp and the access at +4 witnesses that the object
    // reaches past its first word. The escape is a use that is not an access, so the capture cannot
    // be split per offset, and the audit judges [+4] against the single scalar it models. The frame
    // gate is not what refuses it: widened to `localArea >= 4` it declines with this same message.
    test('a sub-word member at +4 pins the extent, and the object MODEL is what refuses it', () => {
      const subWordMembers =
        'q_bytes:\n' +
        '\tpush\t{lr}\n' +
        '\tadd\tsp, sp, #-0x8\n' +
        '\tmov\tr1, sp\n' +
        '\tstrb\tr0, [r1]\n' +
        '\tadd\tr0, r0, #0x1\n' +
        '\tstrb\tr0, [r1, #0x4]\n' +
        '\tmov\tr0, sp\n' +
        '\tbl\tg\n' +
        '\tmov\tr0, sp\n' +
        '\tldrb\tr0, [r0]\n' +
        '\tmov\tr1, sp\n' +
        '\tldrb\tr1, [r1, #0x4]\n' +
        '\tadd\tr0, r0, r1\n' +
        '\tbl\tuse2\n' +
        '\tadd\tsp, sp, #0x8\n' +
        '\tpop\t{r0}\n' +
        '\tbx\tr0\n';
      expect(() => decompile('q_bytes', subWordMembers, ARMV4T_AGBCC)).toThrow(/at \[\+4\] through the captured/);
      expect(() => decompile('q_bytes', subWordMembers, ARMV4T_AGBCC)).toThrow(
        /only a scalar at the captured address is modelled/,
      );
    });

    // A frame-covering block copy, `struct Big { s32 a[17]; }; extern const struct Big gK; void
    // big3f(void){ struct Big b; b = gK; g(&b); use2(b.a[0]); }`. `mov r2,#0x44` bounds the object
    // from below and the `add sp,#-0x44` reservation bounds it from above, so the two coincide and
    // the extent is exact. What stays ambiguous is the object's ROLE — the same instructions are
    // agbcc's by-value struct ARGUMENT block and its struct-return temp — which is where widening
    // the frame licence lands this fixture: on the struct-return refusal, never on extent.
    test('a frame-covering block copy pins the extent, and the object`s ROLE is what refuses it', () => {
      const blockCopy =
        'big3f:\n' +
        '\tpush\t{lr}\n' +
        '\tadd\tsp, sp, #-0x44\n' +
        '\tldr\tr1, .L3\n' +
        '\tmov\tr0, sp\n' +
        '\tmov\tr2, #0x44\n' +
        '\tbl\tmemcpy\n' +
        '\tmov\tr0, sp\n' +
        '\tbl\tg\n' +
        '\tldr\tr0, [sp]\n' +
        '\tbl\tuse2\n' +
        '\tadd\tsp, sp, #0x44\n' +
        '\tpop\t{r0}\n' +
        '\tbx\tr0\n' +
        '.L4:\n\t.align\t2, 0\n.L3:\n\t.word\tgK\n';
      expect(() => decompile('big3f', blockCopy, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
    });

    // …AND THE SHAPE NO GATE ABOVE EVER ASKS ABOUT: an array. `void arrf(s32 x){ u8 buf[12];
    // buf[0]=x; garr(buf); use2(buf[0]); }` compiles to `add sp,sp,#-0xc / mov r1,sp / strb r0,[r1]
    // / mov r0,sp / bl garr`, and the frame licence never sees it — that gate only switches the
    // outgoing-argument refusals off, while the object model runs on any frame. One object, no
    // `undef`, no slot above, so all three escape rules pass it and the lift declared a 12-byte
    // object `u8 sp0`: `garr` writing 8 bytes past a frame the recompile makes 4 wide, with no
    // diagnostic. It declines on the frame being ACCOUNTED FOR.
    test('an array whose top nothing bounds declines rather than shrinking the frame', () => {
      const arrf =
        'arrf:\n' +
        '\tpush\t{lr}\n' +
        '\tadd\tsp, sp, #-0xc\n' +
        '\tmov\tr1, sp\n' +
        '\tstrb\tr0, [r1]\n' +
        '\tmov\tr0, sp\n' +
        '\tbl\tgarr\n' +
        '\tmov\tr0, sp\n' +
        '\tldrb\tr0, [r0]\n' +
        '\tbl\tuse2\n' +
        '\tadd\tsp, sp, #0xc\n' +
        '\tpop\t{r0}\n' +
        '\tbx\tr0\n';
      const protos = { prototypes: { garr: { params: 1 }, use2: { params: 1 } } };
      expect(() => decompile('arrf', arrf, ARMV4T_AGBCC, protos)).toThrow(
        /the word at \[sp,#4\] is neither an object this lift models nor a slot it keys/,
      );
      expect(() => decompile('arrf', arrf, ARMV4T_AGBCC, protos)).toThrow(
        /nothing bounds the captured object's extent/,
      );
      // CONTROL, and it is what makes the refusal about the UNACCOUNTED WORD rather than about the
      // array: the same capture, escape and read-back in a frame the object fills lifts.
      const oneWordArr = arrf.replace(/#-0xc/, '#-0x4').replace(/#0xc/, '#0x4');
      expect(decompile('arrf', oneWordArr, ARMV4T_AGBCC, protos).source).toContain('garr(&sp0)');
    });

    // …AND THE OTHER CONJUNCT, which is the one a wide frame actually meets. This gate needs the
    // base LIVE IN AN ARGUMENT REGISTER AT A `bl`; the DMA-fill idiom PUBLISHES the base to a
    // device register instead, and that path never asks the gate anything. So a published capture
    // in a frame far wider than one word lifts today, slots above it and all — which is why no
    // widening of `localArea === 4` can reach klonoa's `LoadBGTilemapData` (instrumented:
    // localArea=60, frameBasePassedToCallee=false, and its lift is byte-identical with the
    // conjunct widened).
    //
    // The slots above it survive on the DEVICE, not on the frame: a word store to a DMA SOURCE
    // register is `readsThrough`, so this capture is never in `mayWrite` and neither the slot rule
    // nor the frame-accounting rule looks at it. Publish the same base to an ordinary global and
    // both refuse — the test above.
    //
    // Compiled, frame 0xc, with the two incoming pointers spilled into the slots above the object:
    // `void dmawide(u16 *dst, s32 n){ vu16 tmp; s32 t0..t7; tmp = 0; t0 = h(0); … t7 = h(7);
    // REG_DMA3[0] = (u32)&tmp; REG_DMA3[1] = (u32)dst; REG_DMA3[2] = n | 0x81000000;
    // use2(t0 + … + t7); }`. The arities are declared because a GUESSED four-argument `h` reads the
    // register that still holds the base as an argument, and the object is then "passed to a
    // callee" on the strength of a guess — the same lower-bound trap `--proto` exists for.
    test('a PUBLISHED capture in a wider frame lifts — this gate governs the callee-passed one', () => {
      const dmawide =
        'dmawide:\n' +
        '\tpush\t{r4, r5, r6, r7, lr}\n' +
        '\tmov\tr7, sl\n\tmov\tr6, r9\n\tmov\tr5, r8\n\tpush\t{r5, r6, r7}\n' +
        '\tadd\tsp, sp, #-0xc\n' +
        '\tstr\tr0, [sp, #0x4]\n' +
        '\tstr\tr1, [sp, #0x8]\n' +
        '\tmov\tr1, sp\n' +
        '\tmov\tr0, #0x0\n' +
        '\tstrh\tr0, [r1]\n' +
        '\tmov\tr0, #0x0\n\tbl\th\n\tadd\tr4, r0, #0\n' +
        '\tmov\tr0, #0x1\n\tbl\th\n\tadd\tr7, r0, #0\n' +
        '\tmov\tr0, #0x2\n\tbl\th\n\tmov\tsl, r0\n' +
        '\tmov\tr0, #0x3\n\tbl\th\n\tmov\tr9, r0\n' +
        '\tmov\tr0, #0x4\n\tbl\th\n\tmov\tr8, r0\n' +
        '\tmov\tr0, #0x5\n\tbl\th\n\tadd\tr6, r0, #0\n' +
        '\tmov\tr0, #0x6\n\tbl\th\n\tadd\tr5, r0, #0\n' +
        '\tmov\tr0, #0x7\n\tbl\th\n' +
        '\tldr\tr1, .L3\n' +
        '\tmov\tr2, sp\n' +
        '\tstr\tr2, [r1]\n' +
        '\tadd\tr1, r1, #0x4\n' +
        '\tldr\tr3, [sp, #0x4]\n' +
        '\tstr\tr3, [r1]\n' +
        '\tldr\tr2, .L3+0x4\n' +
        '\tmov\tr1, #0x81\n\tlsl\tr1, r1, #0x18\n' +
        '\tldr\tr3, [sp, #0x8]\n\torr\tr1, r1, r3\n\tstr\tr1, [r2]\n' +
        '\tadd\tr4, r4, r7\n\tadd\tr4, r4, sl\n\tadd\tr4, r4, r9\n\tadd\tr4, r4, r8\n' +
        '\tadd\tr4, r4, r6\n\tadd\tr4, r4, r5\n\tadd\tr4, r4, r0\n\tadd\tr0, r4, #0\n\tbl\tuse2\n' +
        '\tadd\tsp, sp, #0xc\n' +
        '\tpop\t{r3, r4, r5}\n\tmov\tr8, r3\n\tmov\tr9, r4\n\tmov\tsl, r5\n' +
        '\tpop\t{r4, r5, r6, r7}\n\tpop\t{r0}\n\tbx\tr0\n' +
        '.L4:\n\t.align\t2, 0\n.L3:\n\t.word\t0x40000d4\n\t.word\t0x40000dc\n';
      const src = decompile('dmawide', dmawide, ARMV4T_AGBCC, {
        prototypes: { h: { params: 1 }, use2: { params: 1 } },
      }).source;
      expect(src).toContain('volatile u16 sp0;');
      expect(src).toContain('*(s32 *)67109076 = &sp0;');
    });

    // `volatile` IS NOT FREE, so it goes only where the source writes one. The structurer emits one
    // C read per USE, not per machine load, so the qualifier forbids the CSE that turns the
    // reference's single `ldr` into four register copies. `void f(u32 i){ s32 w; w = gEnts[i].h;
    // use(&w); four(w,w,w,w); }` compiled, and the candidate recompiled both ways:
    //
    //   reference / without volatile → ldr r3,[sp] / add r0,r3,#0 / add r1,r3,#0 / add r2,r3,#0
    //   with volatile                → ldr r0,[sp] / ldr r1,[sp] / ldr r2,[sp] / ldr r3,[sp]
    //
    // Four instructions, so a byte-exact candidate becomes a nonmatch. agbcc also warns `discards
    // qualifiers` at the call. The DMA idiom keeps it: there the address is PUBLISHED to a device
    // register through a store, and every corpus project spells that scratch `vu16`.
    test('an ordinary `&local` argument is not volatile; a published address is', () => {
      const multiRead =
        'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tlsl\tr1, r0, #0x2\n\tadd\tr1, r1, r0\n\tlsl\tr1, r1, #0x2\n' +
        '\tldr\tr0, .L3\n\tadd\tr1, r1, r0\n\tldrh\tr0, [r1, #0x12]\n\tstr\tr0, [sp]\n\tmov\tr0, sp\n\tbl\tuse\n' +
        '\tldr\tr3, [sp]\n\tadd\tr0, r3, #0\n\tadd\tr1, r3, #0\n\tadd\tr2, r3, #0\n\tbl\tfour\n' +
        '\tadd\tsp, sp, #0x4\n\tpop\t{r0}\n\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n\t.word\t0x8057acc\n';
      const src = decompile('f', multiRead, ARMV4T_AGBCC, {
        prototypes: { use: { params: 1, returnsVoid: true }, four: { params: 4 } },
      }).source;
      expect(src).toContain('four(sp0, sp0, sp0, sp0)');
      expect(src).not.toContain('volatile');
      // …and the store still survives, which is what the qualifier used to be doing for asmlift's
      // own dead-store pass (l3/dce.ts keys on address-taken now).
      expect(src).toMatch(/sp0 = /);
    });
  });

  test('an address-taken frame local becomes a declared object whose address is a value', () => {
    // The DMA-fill idiom: `DmaFill16` expands to `vu16 tmp = v; DmaSet(…, &tmp, …)`, so agbcc
    // stores a halfword through a captured sp and hands the ADDRESS to the DMA source register.
    // `mov rD, sp` lifts to `laddr` — gaddr's local twin — the frame-object audit proves every use,
    // the structurer declares the object with exactly the access type the machine used, and the
    // escaped address is an ordinary value. L3 DCE must NOT reap the store: an address-taken
    // local's stores are observable through the escaped pointer (the hardware reads them).
    const dmaFill =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tmov\tr4, sp\n\tmov\tr0, #0\n\tstrh\tr0, [r4]\n' +
      '\tldr\tr2, .L1\n\tmov\tr1, sp\n\tstr\tr1, [r2]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
      '.L1:\n\t.word\t0x40000D4\n';
    // `volatile` because the address ESCAPES and the source spells it that way — every GBA
    // project's `DMA_FILL` declares the scratch `vu##bit`. gcc keeps the store either way (`&tmp`
    // makes it addressable), so the qualifier is about reproducing the declaration, not about
    // surviving DCE; it still changes register allocation, so it still has to be right.
    expect(decompile('f', dmaFill, ARMV4T_AGBCC).source).toBe(
      's32 f(void) {\n    volatile u16 sp0;\n    sp0 = 0;\n    *(s32 *)67109076 = &sp0;\n    return 0;\n}\n',
    );
    // …and the object co-exists with SSA slots at higher offsets, each model owning its own bytes
    const mixed =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tstr\tr0, [sp, #0x4]\n\tmov\tr4, sp\n\tstrh\tr1, [r4]\n' +
      '\tldr\tr2, .L1\n\tstr\tr4, [r2]\n\tldr\tr0, [sp, #0x4]\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
      '.L1:\n\t.word\t0x40000D4\n';
    const src = decompile('f', mixed, ARMV4T_AGBCC).source;
    expect(src).toContain('volatile u16 sp0;');
    expect(src).toContain('&sp0');
    expect(src).toContain('return a0;'); // the [sp,#4] slot is still a transparent SSA value
  });

  test('publish-the-address-then-fill: the store after the last &sp0 still survives DCE', () => {
    // The addr-as-read pin only protected stores UPSTREAM of an `&sp0` occurrence in the backward
    // liveness walk, so this legal DMA ordering — publish the address, then fill the object — had
    // its store deleted by asmlift's OWN L3 DCE, defeating the volatile the frontend added
    // precisely so the RECOMPILER would not delete it. A volatile local is never store-eligible.
    const publishThenFill =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tmov\tr4, sp\n\tldr\tr2, .L1\n\tmov\tr1, sp\n\tstr\tr1, [r2]\n' +
      '\tmov\tr0, #0\n\tstrh\tr0, [r4]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n.L1:\n\t.word\t0x40000D4\n';
    expect(decompile('f', publishThenFill, ARMV4T_AGBCC).source).toBe(
      's32 f(void) {\n    volatile u16 sp0;\n    *(s32 *)67109076 = &sp0;\n    sp0 = 0;\n    return 0;\n}\n',
    );
  });

  // one address-taken halfword frame object published to a DMA register — the shape that mints
  // an `sp<off>` name, reused by the two shadowing tests below
  const declaresSp0 =
    'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tmov\tr4, sp\n\tstrh\tr0, [r4]\n\tldr\tr2, .L1\n\tstr\tr4, [r2]\n' +
    '\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n.L1:\n\t.word\t0x40000D4\n';

  test('a callee named sp0 keeps its name — the minted local yields', () => {
    // Call targets are part of the namespace the structurer mints into: a local shadowing a
    // function named sp0 makes `sp0()` a call through a u16 object — a compile error. The minted
    // name steps aside (`sp0_`) exactly as it does for a same-named global or map symbol.
    const callsSp0 =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tmov\tr4, sp\n\tstrh\tr0, [r4]\n\tldr\tr2, .L1\n\tstr\tr4, [r2]\n' +
      '\tbl\tsp0\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n.L1:\n\t.word\t0x40000D4\n';
    const src = decompile('f', callsSp0, ARMV4T_AGBCC).source;
    expect(src).toContain('volatile u16 sp0_;');
    expect(src).toContain('&sp0_');
    expect(src).toContain('sp0(');
  });

  test('a MAP symbol named sp0 keeps its name — the minted local yields', () => {
    // The third namespace the minter shares, and the only one nothing else in this layer walks:
    // the project's symbol map. It is CONSULTED rather than copied into the taken set, so this
    // pins the arm — a map name that stops being asked about mints a local that shadows a real
    // project global, and `sp0` would then read the wrong object.
    const mapWithSp0: SymbolMap = new Map([[0x03005220, [{ name: 'sp0', kind: 'data', declared: true }]]]);
    const src = decompile('f', declaresSp0, ARMV4T_AGBCC, { symbols: mapWithSp0 }).source;
    expect(src).toContain('volatile u16 sp0_;');
    expect(src).toContain('&sp0_');
  });

  test('the frame-object audit refuses every use it cannot vouch for, loudly and by name', () => {
    const laddr = /address-taken stack local/;
    const wrap = (body: string) =>
      `f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n${body}\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n`;
    // never dereferenced: nothing pins the object's type, and a guessed declaration is the
    // plausible-but-wrong class (here the address escapes into the return value)
    expect(() =>
      decompile(
        'f',
        'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tmov\tr0, sp\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n',
        ARMV4T_AGBCC,
      ),
    ).toThrow(laddr);
    // accesses disagreeing on width: no single declared type reproduces both
    expect(() => decompile('f', wrap('\tmov\tr4, sp\n\tstrh\tr0, [r4]\n\tstr\tr1, [r4]\n'), ARMV4T_AGBCC)).toThrow(
      laddr,
    );
    // address arithmetic on the capture: the object's extent stops being one scalar
    expect(() => decompile('f', wrap('\tmov\tr4, sp\n\tadd\tr4, r4, #0x4\n\tstr\tr0, [r4]\n'), ARMV4T_AGBCC)).toThrow(
      laddr,
    );
    // an access at a nonzero offset through the capture
    expect(() => decompile('f', wrap('\tmov\tr4, sp\n\tstr\tr0, [r4, #0x4]\n'), ARMV4T_AGBCC)).toThrow(laddr);
    // overlap with an SSA slot: one byte, two models
    expect(() =>
      decompile(
        'f',
        wrap('\tmov\tr4, sp\n\tstr\tr0, [r4]\n\tstr\tr1, [sp]\n\tldr\tr2, [sp]\n\tadd\tr0, r2, #0\n'),
        ARMV4T_AGBCC,
      ),
    ).toThrow(laddr);
    // a COMPUTED capture is not the modelled shape at all
    expect(() => decompile('f', wrap('\tadd\tr4, sp, #0x4\n\tstr\tr0, [r4]\n'), ARMV4T_AGBCC)).toThrow(
      /address of a stack local is computed/,
    );
  });

  test('a gap in the slots read still yields ABI-correct offsets', () => {
    // frame 8, so [sp,#0xc] is argument 6 (index 5) and argument 5 is never read. Naming downstream
    // is POSITIONAL, so minting only the slot that was read would put the parameter at argument 5's
    // offset — silently the wrong signature. Reading slot k proves the caller pushed 4..k.
    const gap = 'f:\n\tpush\t{r4, lr}\n\tldr\tr0, [sp, #0xc]\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    // six parameters: r0-r3 and both stack slots, with the one actually read last and in place
    expect(decompile('f', gap, ARMV4T_AGBCC).source).toBe(
      's32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4, s32 a5) {\n    return a5;\n}\n',
    );
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
