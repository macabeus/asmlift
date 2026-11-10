// `incoming stack arguments (AAPCS args 5+)` is one describe spread over three files, each
// re-opening it under the same name so every test keeps its describe chain:
// thumb-stack-args.test.ts (the incoming words and the register arguments beside them),
// thumb-frontend.test.ts (the frame-slot model), thumb-frame-objects.test.ts (frame objects and
// device accesses). This file holds the incoming words themselves and the register arguments beside them.
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';
import { dc } from './helpers';

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
    // NINE parameters — the stack argument holds slot 8, and what r7 holds is an uninitialised
    // local: r7's own, since `mov r7, r8` only stages r8 for its push (thumb.ts `prologueSavedRegs`)
    expect(decompile('f', hi, ARMV4T_AGBCC).source).toBe(
      's32 f(s32 a0, s32 a1, s32 a2, s32 a3, s32 a4, s32 a5, s32 a6, s32 a7, s32 a8) {\n' +
        '    s32 uninit_r7;\n    return a8 + uninit_r7;\n}\n',
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

  test('a high register staged through a register the function had not saved is a copy the function made', () => {
    // `prologueSavedRegs` skips a staging `mov rLow, rHi` only where agbcc emits it: rLow is
    // callee-saved and an EARLIER push already holds its own entry value. Hand-written asm may stage
    // through a scratch register and then read it; skipping that `mov` made r3 the caller's fourth
    // argument — `s32 h1(s32 a0, s32 a1, s32 a2, s32 a3) { return a0 + a3; }` — where the machine
    // holds r8. Lifted, the copy carries r8's entry value, which is r8's own uninitialised local.
    const h1 =
      'h1:\n\tpush\t{lr}\n\tmov\tr3, r8\n\tpush\t{r3}\n\tadd\tr0, r0, r3\n\tpop\t{r3}\n\tmov\tr8, r3\n' +
      '\tpop\t{r1}\n\tbx\tr1\n';
    expect(decompile('h1', h1, ARMV4T_AGBCC).source).toBe(
      's32 h1(s32 a0) {\n    s32 uninit_r8;\n    return a0 + uninit_r8;\n}\n',
    );
    // A callee-saved register staged before anything saved it is no save of its own: the `push`
    // holds r8's value, so r4's entry value is lost and the function returns with r8's in r4 — a
    // write the caller sees, which `return a0 + uninit_r8;` would drop.
    const unsaved =
      'h2:\n\tmov\tr4, r8\n\tpush\t{r4, lr}\n\tadd\tr0, r0, r4\n\tpop\t{r4}\n\tmov\tr8, r4\n' +
      '\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('h2', unsaved, ARMV4T_AGBCC)).toThrow(/it writes callee-saved r4, and saves or restores r4/);
  });

  // The other side of that fixture's premise, and the reason it had to be stated: the rule is
  // "the compiler homed a local here", which is only true of a register the function SAVED.
  describe('a register the prologue never saved is not one the compiler homed a local in', () => {
    // The MP2K engine's hand-written `ChnVolSetAsm` — vendored in klonoa, sa3 and pokeemerald
    // alike — receives two pointers in r4/r5 by a private convention and has no prologue at all.
    // Classified by the ABI alone it would store through `uninit_r4`; read as parameters it would be
    // `f(u8 *a0, u8 *a1)`, which a C caller hands over in r0/r1. What the machine does is share
    // the values with the caller in registers it expects preserved: a global register variable, and
    // `register u8 *ra __asm__("r4");` compiles to exactly these bytes.
    const noSave = 'f:\n\tldrb\tr0, [r4, #0x12]\n\tstrb\tr0, [r5, #2]\n\tbx\tlr\n';
    // PER REGISTER, not per function: saving r5 says nothing about r4, and a mid-function fragment
    // reached by agbcc's `bl`-as-a-long-branch is handed live values in registers it never saved
    // while saving the ones it uses itself.
    const half = 'f:\n\tpush\t{r5, lr}\n\tadd\tr5, r4, #1\n\tldr\tr0, [sp, #0x8]\n\tadd\tr0, r0, r5\n\tbx\tlr\n';
    // r8-sl cannot be pushed directly, so agbcc saves them as `mov rLow, rHi; push {rLow}` — the
    // shape every high-register inhabitant in the corpus goes through. Read literally, the save set
    // would hold only the low register and the four of them would lose their local. (The `hi`
    // fixture above is the positive half; this is what happens without the mov.)
    const movless =
      'f:\n\tpush\t{r4, r5, r6, r7, lr}\n\tpush\t{r7}\n\tldr\tr0, [sp, #0x28]\n\tmov\tr1, r8\n\tadd\tr0, r0, r1\n\tbx\tlr\n';
    // …and a WRITE to one is handed back to the caller
    const write = 'f:\n\tmov\tr8, r0\n\tbx\tlr\n';

    test('is a global register variable where agbcc can declare one', () => {
      expect(decompile('f', noSave, ARMV4T_AGBCC, { onGap: 'strict' }).source).toBe(
        's32 f(void) {\n    s32 v0;\n    v0 = ((u8 *)greg_r4)[18];\n    ((u8 *)greg_r5)[2] = v0;\n    return v0;\n}\n',
      );
      expect(decompile('f', half, ARMV4T_AGBCC).source).toContain('return a4 + (greg_r4 + 1);');
      expect(decompile('f', movless, ARMV4T_AGBCC).source).toContain('return a8 + greg_r8;');
      expect(decompile('f', write, ARMV4T_AGBCC).source).toBe(
        's32 f(s32 a0) {\n    greg_r8 = a0;\n    return a0;\n}\n',
      );
      // memory, not a value the function holds: a call between the write and the read may change it,
      // so the read is the global's again
      const call = 'f:\n\tpush\t{lr}\n\tmov\tr8, r0\n\tbl\tg\n\tmov\tr0, r8\n\tpop\t{r1}\n\tbx\tr1\n';
      expect(decompile('f', call, ARMV4T_AGBCC, { prototypes: { g: { params: 0, returnsVoid: true } } }).source).toBe(
        's32 f(s32 a0) {\n    greg_r8 = a0;\n    g();\n    return greg_r8;\n}\n',
      );
      // both spellings of r10 are the one global
      const sl = 'f:\n\tmov\tr1, sl\n\tmov\tr10, r0\n\tadd\tr0, r1, #0\n\tbx\tlr\n';
      expect(decompile('f', sl, ARMV4T_AGBCC).source).toBe(
        's32 f(s32 a0) {\n    s32 v0;\n    v0 = greg_r10;\n    greg_r10 = a0;\n    return v0;\n}\n',
      );
    });

    test('…and refuses where the compiler has no spelling for one', () => {
      const none = { ...ARMV4T_AGBCC, globalRegisterVariables: undefined };
      const read = (reg: string) =>
        new RegExp(`it reads callee-saved ${reg} before writing it, and no \`push\` ahead of every use saves ${reg}`);
      expect(() => decompile('f', noSave, none, { onGap: 'strict' })).toThrow(read('r4'));
      expect(() => decompile('f', half, none)).toThrow(read('r4'));
      expect(() => decompile('f', movless, none)).toThrow(read('r8'));
      expect(() => decompile('f', write, none)).toThrow(
        /it writes callee-saved r8, and no `push` ahead of every use saves r8/,
      );
    });

    // A push past the leading run saves the register all the same, and the pop that restores it is
    // transparent: hand-written asm keeping a register, not a global's write the caller sees.
    test('…and reads one a `push` saves before every use, past the prologue too, as a local', () => {
      const late = 'f:\n\tmov\tr1, r0\n\tpush\t{r4}\n\tmov\tr4, r1\n\tadd\tr0, r4, #1\n\tpop\t{r4}\n\tbx\tlr\n';
      expect(decompile('f', late, ARMV4T_AGBCC).source).toBe('s32 f(s32 a0) {\n    return a0 + 1;\n}\n');
      const lateHigh =
        'f:\n\tmov\tr1, r0\n\tmov\tr3, r8\n\tpush\t{r3}\n\tmov\tr8, r1\n\tmov\tr0, r8\n\tpop\t{r3}\n\tmov\tr8, r3\n\tbx\tlr\n';
      expect(decompile('f', lateHigh, ARMV4T_AGBCC).source).toBe('s32 f(s32 a0) {\n    return a0;\n}\n');
      // past a branch, on the one path that uses it
      const branch =
        'f:\n\tcmp\tr0, #0\n\tbeq\t.L1\n\tpush\t{r4}\n\tadd\tr4, r0, #0\n\tadd\tr0, r4, r4\n\tpop\t{r4}\n.L1:\n\tbx\tlr\n';
      expect(decompile('f', branch, ARMV4T_AGBCC).source).toBe(
        's32 f(s32 a0) {\n    if (a0 != 0) a0 = a0 + a0;\n    return a0;\n}\n',
      );
    });

    test('…and refuses one it saves or restores only where a use comes first', () => {
      const mis =
        /it reads callee-saved r4 before writing it, and saves or restores r4 but not around every use of it, restored at every return, on every path/;
      // a `pop` with no push before it restores the register all the same, a write the
      // transparent pop leaves out of the lift
      expect(() => decompile('f', 'f:\n\tmov\tr0, r4\n\tpop\t{r4}\n\tbx\tlr\n', ARMV4T_AGBCC)).toThrow(mis);
      // a read ahead of the push
      const before = 'f:\n\tmov\tr0, r4\n\tpush\t{r4}\n\tmov\tr4, #1\n\tpop\t{r4}\n\tbx\tlr\n';
      expect(() => decompile('f', before, ARMV4T_AGBCC)).toThrow(mis);
      // a read on a path the push is not on
      const path =
        'f:\n\tcmp\tr0, #0\n\tbeq\t.L1\n\tpush\t{r4}\n\tadd\tr4, r0, #0\n\tadd\tr0, r4, r4\n\tpop\t{r4}\n\tbx\tlr\n' +
        '.L1:\n\tmov\tr0, r4\n\tbx\tlr\n';
      expect(() => decompile('f', path, ARMV4T_AGBCC)).toThrow(mis);
    });

    // The restore ends the save: past it the register is the caller's again, so a use there is
    // neither a local's nor, the transparent `pop` having kept the function's last write, the
    // global's — and a save some path carries to a return unrestored saved nothing there.
    test('…and refuses one it uses past its restore, or returns with unrestored', () => {
      const mis = (rw: 'reads' | 'writes', reg: string) =>
        new RegExp(
          `it ${rw} callee-saved ${reg}${rw === 'reads' ? ' before writing it' : ''}, and saves or restores ${reg} but not around every use of it, restored at every return, on every path`,
        );
      const lift = (body: string) => () => decompile('f', `f:\n\t${body.split('; ').join('\n\t')}\n`, ARMV4T_AGBCC);
      // a read past the restore would see the function's own last write (`return 5;`), or `uninit_r8`
      expect(lift('push {r4}; mov r4, #5; pop {r4}; mov r0, r4; bx lr')).toThrow(mis('writes', 'r4'));
      expect(
        lift(
          'add r0, #1; mov r3, r8; push {r3}; mov r8, r0; add r0, r0, r8; pop {r3}; mov r8, r3; add r0, r0, r8; bx lr',
        ),
      ).toThrow(mis('reads', 'r8'));
      expect(lift('add r0, #1; mov r3, r8; push {r3}; mov r8, r0; pop {r3}; mov r8, r3; mov r0, r8; bx lr')).toThrow(
        mis('reads', 'r8'),
      );
      // a write past the restore is the caller's, which the lift would drop
      expect(lift('add r0, #1; push {r4}; mov r4, #5; add r0, r0, r4; pop {r4}; mov r4, r0; bx lr')).toThrow(
        mis('writes', 'r4'),
      );
      // the prologue's save is no different
      expect(lift('push {r4, lr}; mov r4, #5; add r0, r0, r4; pop {r4}; mov r4, r0; pop {r1}; bx r1')).toThrow(
        mis('writes', 'r4'),
      );
      // a staged save whose word is popped into another register restores no r8 (`a0 + 1 + a1`)
      expect(lift('add r0, #1; mov r3, r8; push {r3}; pop {r1}; add r0, r0, r1; bx lr')).toThrow(mis('reads', 'r8'));
      // a save dropped with `add sp` leaves the write the caller's — a broken save, so no global's
      expect(lift('push {r4}; mov r4, r0; add r0, r4, #1; add sp, #4; bx lr')).toThrow(mis('writes', 'r4'));
      expect(lift('push {r4}; mov r4, r0; add r0, r4, #1; add sp, #4; bx lr')).toThrow(
        /the caller sees the write — not modelled/,
      );
      // …where a return with the word still pushed is an epilogue the input left out, read as restored
      expect(
        decompile('f', 'f:\n\tpush\t{r4}\n\tmov\tr4, r0\n\tadd\tr0, r4, #1\n\tbx\tlr\n', ARMV4T_AGBCC).source,
      ).toBe('s32 f(s32 a0) {\n    return a0 + 1;\n}\n');
      // agbcc's own epilogue pops sl's word into r4 before r4's restore, and stays a save of both
      const agbcc =
        'f:\n\tpush\t{r4, r5, r6, r7, lr}\n\tmov\tr7, sl\n\tpush\t{r7}\n\tmov\tsl, r0\n\tmov\tr4, sl\n' +
        '\tadd\tr0, r4, #1\n\tpop\t{r4}\n\tmov\tsl, r4\n\tpop\t{r4, r5, r6, r7}\n\tpop\t{r1}\n\tbx\tr1\n';
      expect(decompile('f', agbcc, ARMV4T_AGBCC).source).toContain('return a0 + 1;');
    });

    // A pop restores a register only from the word that register's own push left: one that names
    // the register but loads another word rewrites it, and the pop being transparent to the fill,
    // the C would drop that write. Each of these leaves the caller's r4/r5 (or r8/r9) swapped or
    // holding a0, and read by name would lift as if restored.
    test('…and restores one only from the word its own push left', () => {
      const lift = (body: string) => () => decompile('f', `f:\n\t${body.split('; ').join('\n\t')}\n`, ARMV4T_AGBCC);
      const foreign = (pop: string, reg: string) =>
        new RegExp(`'${pop}' loads a word that is not ${reg}'s own save into callee-saved ${reg}`);
      expect(lift('push {r4, r5}; pop {r5}; pop {r4}; bx lr')).toThrow(foreign('pop {r5}', 'r5'));
      expect(lift('push {r4}; push {r0}; pop {r4}; pop {r1}; bx lr')).toThrow(foreign('pop {r4}', 'r4'));
      expect(lift('push {r4, r5}; mov r4, r0; mov r5, r1; add r0, r4, r5; pop {r5}; pop {r4}; bx lr')).toThrow(
        foreign('pop {r5}', 'r5'),
      );
      expect(lift('push {r4, lr}; push {r0}; mov r4, r1; add r0, r4, #1; pop {r4}; pop {r1}; pop {r1}; bx r1')).toThrow(
        foreign('pop {r4}', 'r4'),
      );
      // late, on the one path that saves
      expect(
        lift(
          'cmp r0, #0; beq .L1; push {r4, r5}; mov r4, r0; mov r5, r1; add r0, r4, r5; pop {r5}; pop {r4}; .L1: bx lr',
        ),
      ).toThrow(foreign('pop {r5}', 'r5'));
      // agbcc's high-register staging, its two restores crossed
      const crossed = (r8: string, r9: string) =>
        `push {r4, r5, lr}; mov r5, r9; mov r4, r8; push {r4, r5}; mov r8, r0; mov r9, r1; mov r0, r8; add r0, r9; ` +
        `pop {r3, r4}; mov r9, ${r9}; mov r8, ${r8}; pop {r4, r5}; pop {r1}; bx r1`;
      expect(lift(crossed('r4', 'r3'))).toThrow(foreign('mov r9, r3', 'r9'));
      expect(lift(crossed('r3', 'r4'))().source).toContain('return a0 + a1;');
      // and the same pops in their own order restore
      expect(lift('push {r4, r5}; mov r4, r0; mov r5, r1; add r0, r4, r5; pop {r4}; pop {r5}; bx lr')().source).toBe(
        's32 f(s32 a0, s32 a1) {\n    return a0 + a1;\n}\n',
      );
    });

    // The same holds of a scratch register, which no return hands back saved: a pop that fills one
    // with another word is a copy the fill never makes, and read by name `push {r1}; pop {r0}`
    // would lift `return a0` for a function returning a1. Only the return idiom, a `bx` through the
    // register straight after, uses such a word, and as where to go rather than as a value.
    test('…and fills a scratch register with another word only to return through it', () => {
      const lift = (body: string) => () => decompile('f', `f:\n\t${body.split('; ').join('\n\t')}\n`, ARMV4T_AGBCC);
      const copy = (pop: string, reg: string) =>
        new RegExp(`'${pop}' loads a word that is not ${reg}'s own into ${reg}, which is then used as a value`);
      expect(lift('push {r1}; pop {r0}; bx lr')).toThrow(copy('pop {r0}', 'r0'));
      expect(lift('push {r1}; pop {r2}; mov r0, r2; bx lr')).toThrow(copy('pop {r2}', 'r2'));
      // a word the function wrote before pushing it is no register's either: read by name, `g() + 1`
      // where the machine returns 6
      expect(lift('push {lr}; mov r1, #5; push {r1}; bl g; pop {r0}; add r0, #1; pop {r1}; bx r1')).toThrow(
        copy('pop {r0}', 'r0'),
      );
      // …and one nothing reads after it is no copy anyone sees
      expect(lift('push {r4, lr}; mov r0, #5; pop {r2, r3}; bx r3')().source).toContain('return 5;');
      // the return idioms: lr's word into a scratch register, the `bx` straight after it or past
      // the variadic save's release
      expect(lift('push {lr}; bl g; pop {r1}; bx r1')().source).toContain('g();');
      expect(lift('push {r0, r1, r2, r3}; push {lr}; bl g; pop {r3}; add sp, #0x10; bx r3')().source).toContain('g();');
    });

    // A word is a register's own only while the register held its entry value when it was pushed:
    // pushed again after a foreign pop, a write, or a save dropped with `add sp`, it holds the
    // function's value, and the pop of it leaves the caller that value (r4/r5 swapped, r4 = a0).
    test('…and a re-push of a register no longer its entry value restores nothing', () => {
      const lift = (body: string) => () =>
        decompile(
          'f',
          `f:\n\t${body
            .split('; ')
            .join('\n\t')
            .replace(/\t(\.L\d+:) /g, '$1\n\t')}\n`,
          ARMV4T_AGBCC,
        );
      const foreign = (pop: string, reg: string) =>
        new RegExp(`'${pop}' loads a word that is not ${reg}'s own save into callee-saved ${reg}`);
      expect(
        lift('push {r4, r5, lr}; pop {r5}; pop {r4}; push {r4, r5}; mov r0, #0; pop {r4, r5}; pop {r1}; bx r1'),
      ).toThrow(foreign('pop {r4, r5}', 'r5'));
      expect(lift('push {r4}; mov r4, r0; add sp, #4; push {r4}; mov r0, #0; pop {r4}; bx lr')).toThrow(
        foreign('pop {r4}', 'r4'),
      );
      expect(
        lift('push {r4, lr}; mov r4, r0; add r0, r4, #1; add sp, #4; push {r4}; pop {r4}; pop {r1}; bx r1'),
      ).toThrow(foreign('pop {r4}', 'r4'));
      expect(lift('push {r4}; mov r4, #3; push {r4}; mov r0, #0; pop {r4}; add sp, #4; bx lr')).toThrow(
        foreign('pop {r4}', 'r4'),
      );
      // agbcc's r8/r9 staging crossed, then staged again and restored in order: still swapped
      expect(
        lift(
          'push {r4, r5, lr}; mov r5, r9; mov r4, r8; push {r4, r5}; pop {r3, r4}; mov r9, r3; mov r8, r4; ' +
            'mov r5, r9; mov r4, r8; push {r4, r5}; mov r0, #0; pop {r3, r4}; mov r9, r4; mov r8, r3; pop {r4, r5}; pop {r1}; bx r1',
        ),
      ).toThrow(foreign('mov r9, r4', 'r9'));
      // paths as deep that disagree about a word: on the a0 != 0 path that word is a0
      expect(lift('push {r4}; cmp r0, #0; beq .L1; add sp, #4; push {r0}; .L1: mov r0, #0; pop {r4}; bx lr')).toThrow(
        foreign('pop {r4}', 'r4'),
      );
      expect(
        lift('push {r4, lr}; cmp r0, #0; beq .L1; add sp, #4; push {r0}; .L1: mov r0, #0; pop {r4}; pop {r1}; bx r1'),
      ).toThrow(foreign('pop {r4}', 'r4'));
      // …and paths that agree about it restore, whatever each writes
      expect(lift('push {r4}; cmp r0, #0; beq .L1; mov r4, r0; add r0, r4, #1; .L1: pop {r4}; bx lr')().source).toBe(
        's32 f(s32 a0) {\n    if (a0 != 0) a0 = a0 + 1;\n    return a0;\n}\n',
      );
    });

    // The staging `mov` is the save's only where its low register reaches the push unchanged; one
    // rewritten first pushes a value of the function's own, and saves no high register.
    test('…and a high register staged into a push through another value is still a global', () => {
      // (the word goes to r2, which nothing reads: the fill keeps a `pop` transparent, so one into r0
      // would read as `g`'s return where the machine has the pushed value back)
      const interposed =
        'f:\n\tpush\t{lr}\n\tmov\tr0, r8\n\tadd\tr0, #1\n\tpush\t{r0}\n\tbl\tg\n\tpop\t{r2}\n\tpop\t{r1}\n\tbx\tr1\n';
      expect(decompile('f', interposed, ARMV4T_AGBCC).source).toBe('s32 f(void) {\n    return g(greg_r8 + 1);\n}\n');
    });

    // `sl` and `r10` are one register: saved under one spelling and used under the other, it is
    // still saved — read as two, its writes would be a global's the epilogue undoes.
    test('one register spelt two ways in one function is one register', () => {
      const sl =
        'f:\n\tpush\t{r7, lr}\n\tmov\tr7, sl\n\tpush\t{r7}\n\tmov\tsl, r0\n\tmov\tr0, r10\n\tadd\tr0, r0, #1\n' +
        '\tpop\t{r3}\n\tmov\tsl, r3\n\tpop\t{r7}\n\tpop\t{r1}\n\tbx\tr1\n';
      expect(decompile('f', sl, ARMV4T_AGBCC).source).toContain('return a0 + 1;');
      const sb =
        'f:\n\tpush\t{lr}\n\tmov\tr3, sb\n\tpush\t{r3}\n\tmov\tr9, r0\n\tmov\tr0, sb\n\tpop\t{r3}\n\tmov\tsb, r3\n' +
        '\tpop\t{r1}\n\tbx\tr1\n';
      expect(decompile('f', sb, ARMV4T_AGBCC).source).toBe('s32 f(s32 a0) {\n    return a0;\n}\n');
      // unsaved, the two spellings are one global
      expect(
        decompile('f', 'f:\n\tmov\tfp, r0\n\tmov\tr1, r11\n\tadd\tr0, r1, #1\n\tbx\tlr\n', ARMV4T_AGBCC).source,
      ).toBe('s32 f(s32 a0) {\n    greg_r11 = a0;\n    return greg_r11 + 1;\n}\n');
    });
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
      // `foo` is declared: undeclared, r1 set and r0 not is a gap its own guess refuses
      const src = decompile(
        'f',
        'f:\n\tpush\t{lr}\n\tmov\tr1, #7\n\tbl\tfoo\n\tmov\tr0, #1\n\tbl\tbar\n\tpop\t{r0}\n\tbx\tlr\n',
        ARMV4T_AGBCC,
        {
          prototypes: { ...P, foo: { params: 0 } },
        },
      ).source;
      expect(src).toContain('bar(1);');
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
      // agbcc's `g(f(a, b), c)` — the shape of its soft-float `a * b + c` with the single helpers
      // undeclared: the result comes back in r0 and stays there while `c` goes into
      // r1. Argument 0 is unfresh and argument 1 is not, so the run bridges across r0 rather than
      // truncating the call to nothing.
      expect(dc('\tbl\tfoo\n\tmov\tr1, #9\n\tbl\tbar\n')).toContain('bar(foo(), 9);');
    });

    test('…and the HOLE a 64-bit return spans is not a hole once the helper table states its width', () => {
      // agbcc's soft-64 shift. `__muldi3`'s product occupies r0 AND r1, which is what made
      // argument 1 unfillable from the register file: the pre-call `asr r1` a guess would read is
      // the value the callee overwrote. Nothing has to be guessed now — the helper table states
      // each C parameter's WIDTH, so the frontend reads the pair as ONE value and the second call
      // takes the first call's whole result. The guessed-arity machinery never sees the site.
      //
      // Both results are dropped here, and a recognised 64-bit helper is a PURE op, so the body is
      // dead and nothing is emitted — the answer `__divsi3` gives for a dead soft-division. The
      // signature is what shows the pair was read.
      expect(dc('\tbl\t__muldi3\n\tmov\tr2, #9\n\tbl\t__ashrdi3\n')).toContain('(s64 a0, s64 a1)');
    });

    test('…and the run STOPS at a hole, rather than resuming at a later register that is fresh', () => {
      // An argument list has no holes, so evidence for argument 3 is not evidence for argument 2.
      // TWO gates bound this and they stop the run for different reasons, which is why both shapes
      // are here. `mov r1` gives r1 a reaching definition that `bl foo` then destroys, so the
      // arity guess counts three and the CLOBBER TRIM cuts it back (`foo` declared, whose own
      // guess would refuse r1 past an r0 nothing set).
      const clobbered = 'f:\n\tpush\t{lr}\n\tmov\tr1, #7\n\tbl\tfoo\n\tmov\tr2, #9\n\tbl\tbar\n\tpop\t{r0}\n\tbx\tlr\n';
      expect(
        decompile('f', clobbered, ARMV4T_AGBCC, { prototypes: { ...P, foo: { params: 0, returns: 's32' } } }).source,
      ).toContain('bar(foo());');
      // …without the `mov`, r1 has no reaching definition at all, and a register past it that does
      // is a gap the guess refuses rather than ends the run at (`fallbackArgc`).
      for (const body of [
        '\tbl\tfoo\n\tmov\tr2, #9\n\tbl\tbar\n',
        '\tbl\tfoo\n\tmov\tr2, #9\n\tmov\tr3, #9\n\tbl\tbar\n',
      ]) {
        expect(() => dc(body)).toThrow(
          /the call 'bl bar' in block 'f' has no prototype, r2 holds a value and r1 holds none/,
        );
      }
      // …and fill r1 and the same shape carries both.
      expect(dc('\tbl\tfoo\n\tmov\tr1, #9\n\tbl\tbar\n')).toContain('bar(foo(), 9);');
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
});
