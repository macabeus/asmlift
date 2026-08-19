// Thumb frontend robustness. Pins that an unmodelled instruction with a register destination is
// never SILENTLY DROPPED (stale/absent value → confidently-wrong C): like the MIPS/PPC frontends,
// Thumb degrades it to a loud `opaque`. Toolchain-free.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
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

  test('a callee-saved live-in never takes an ARGUMENT slot from a stack argument', () => {
    // A `/^r(\d+)$/` rank sent `sl`/`sb` to 99 but ranked `r8` at 8 and `r4` at 4 — invisible while
    // nothing else occupied ranks >= 4, a positional miscompile once stack arguments ranked there.
    // sa3's sub_80B6B3C is the live one: 10 arguments, `mov r5, r8` in its prologue, so the r8
    // live-in and @sarg8 tied at 8 and the stable sort gave the slot to whichever was read first —
    // the prologue. ABI argument 8 came out as `a9`, and everything after it shifted.
    const hi =
      'f:\n\tpush\t{r4, r5, r6, r7, lr}\n\tmov\tr7, r8\n\tpush\t{r7}\n\tldr\tr0, [sp, #0x28]\n\tadd\tr0, r0, r7\n\tbx\tlr\n';
    const src = decompile('f', hi, ARMV4T_AGBCC).source;
    // ten parameters, and the STACK argument holds slot 8 — the r8 artifact ranks after them all
    expect(src).toContain('s32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4, s32 a5, s32 a6, s32 a7, s32 a8, s32 a9)');
    expect(src).toContain('return a8 + a9;');
    // the same tie at the low end, where a phantom `r4` would otherwise outrank argument 5
    const lo = 'f:\n\tpush\t{r5, lr}\n\tadd\tr5, r4, #1\n\tldr\tr0, [sp, #0x8]\n\tadd\tr0, r0, r5\n\tbx\tlr\n';
    expect(decompile('f', lo, ARMV4T_AGBCC).source).toContain('return a4 + (a5 + 1);');
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
      // the call's own result is the freshest r0 there is
      expect(dc('\tbl\tfoo\n\tbl\tbar\n')).toContain('bar(foo());');
      // …and with no call in between, nothing is clobbered
      expect(dc('\tmov\tr1, #7\n\tmov\tr0, #1\n\tbl\tbar\n')).toContain('bar(1, 7);');
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
    // …and the names come from the KEYS, so each one points at the frame slot it stands for
    expect(decompile('f', two, ARMV4T_AGBCC).source).toBe(
      's32 f(s32 a0) {\n    s32 v0;\n    s32 uninit_sp4;\n    s32 uninit_sp0;\n' +
        '    if (a0 == 0) {\n        v0 = uninit_sp4;\n        a0 = uninit_sp0;\n    } else {\n        v0 = a0;\n    }\n' +
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
      expect(src).toContain('uninit_sp4'); // …but nothing can write [sp,#4]
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
      expect(withMap).toContain('uninit_sp4'); // …and the undef still stands
    });

    // A LITERAL register offset folds, because the predicate resolves an ADDRESS and `[r2, r5]`
    // with `r5 = 0` names the same one as `[r2, #0]`. An offset it cannot fold does not.
    test('a register offset resolves when it is a literal and refuses when it is not', () => {
      const viaZero = escapeTo('0x00').replace('\tstr\tr4, [r2, #0x00]\n', '\tmov\tr5, #0x00\n\tstr\tr4, [r2, r5]\n');
      expect(viaZero).not.toBe(escapeTo('0x00'));
      expect(decompile('f', viaZero, ARMV4T_AGBCC).source).toContain('uninit_sp4');

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
    expect(decompile('f', captured, ARMV4T_AGBCC).source).toContain('uninit_sp4');
    // POSITIVE CONTROL: the same undefined slot with no address taken at all still recovers, so the
    // guard is the escape and not something incidental about the shape.
    const noEscape =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tstr\tr0, [sp]\n\tldr\tr1, [sp]\n\tcmp\tr1, #0\n\tbeq\t.L2\n\tstr\tr1, [sp, #4]\n' +
      '.L2:\n\tldr\tr2, [sp, #4]\n\tadd\tr0, r1, r2\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r3}\n\tbx\tr3\n';
    expect(decompile('f', noEscape, ARMV4T_AGBCC).source).toContain('uninit_sp4');
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
    expect(decompile('f', pushBefore, ARMV4T_AGBCC).source).toContain('uninit_sp0');
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
    expect(decompile('f', fits, ARMV4T_AGBCC).source).toContain('uninit_sp4');
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
    // `volatile` because the address ESCAPES: gcc-2.9 deletes a store to a non-volatile local
    // nothing in-function reads (measured — the recompiled loop loaded and never stored), and the
    // reference idiom's own spelling is `vu16 tmp` for exactly that reason.
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
