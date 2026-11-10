// `incoming stack arguments (AAPCS args 5+)` is one describe spread over three files, each
// re-opening it under the same name so every test keeps its describe chain:
// thumb-stack-args.test.ts (the incoming words and the register arguments beside them),
// thumb-frontend.test.ts (the frame-slot model), thumb-frame-objects.test.ts (frame objects and
// device accesses). This file holds the frame-slot model: spills, uninitialised locals, the outgoing area, and a one-word
// frame whose base is passed to a callee.
//
// These stay in this file by name: gate tables in packages/core/src cite six of them as
// `guardedBy: 'thumb-frontend.test.ts: <title>'` (gate-contract.test.ts looks each title up here),
// and apps/benchmark/test/citations.test.ts reads LONGEST_AGBCC_SYMBOL out of this file.
import { describe, expect, test } from 'vitest';

import { decompile, liftStamped } from '../src/pipeline';
import type { Prototypes } from '../src/proto';
import { ARMV4T_AGBCC } from '../src/target';

describe('incoming stack arguments (AAPCS args 5+)', () => {
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

  test('a reload from a slot that was never stored is an uninitialised local only under the layout claim', () => {
    // The guard that keeps the model from fabricating: `readVar` must answer a slot nothing stored
    // with `undef`, never a phantom parameter. A callee that assigned the word as its stack parameter
    // ran before the load, so the load is after a call; under the after-call layout claim
    // (`localsAboveOutgoingArea`) no such word is loaded, so it is a local, and with no call reaching
    // the load there is no such callee at all. Without the claim the decline is the honest answer.
    const unstored =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tldr\tr0, [sp]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    // …and the shape the claim exists for: a call reaches the load, and nothing stored the word
    const afterCall =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tbl\tg\n\tldr\tr0, [sp]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    const g = { prototypes: { g: { params: 0, returnsVoid: true } } };
    // the after-call form alone carries it: agbcc's stronger never-loaded claim is not read here
    const weakOnly = {
      ...ARMV4T_AGBCC,
      compilerBehaviors: { ...ARMV4T_AGBCC.compilerBehaviors, outgoingAreaNeverLoadedFrom: undefined },
    };
    for (const t of [ARMV4T_AGBCC, weakOnly]) {
      expect(decompile('f', unstored, t).source).toBe(
        's32 f(void) {\n    s32 uninit_sp0;\n    return uninit_sp0;\n}\n',
      );
      expect(decompile('f', afterCall, t, g).source).toBe(
        's32 f(void) {\n    s32 uninit_sp0;\n    g();\n    return uninit_sp0;\n}\n',
      );
    }
    const unclaimed = {
      ...ARMV4T_AGBCC,
      compilerBehaviors: {
        ...ARMV4T_AGBCC.compilerBehaviors,
        localsAboveOutgoingArea: false,
        outgoingAreaNeverLoadedFrom: undefined,
      },
    };
    expect(() => decompile('f', unstored, unclaimed)).toThrow(/stack pointer used as data/);
    expect(() => decompile('f', afterCall, unclaimed, g)).toThrow(/stack pointer used as data/);
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
      '.L2:\n\tldr\tr1, [sp]\n\tadd\tr0, r1, #1\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    // ONE parameter — the arity is the assertion. `uninit0` is declared and never assigned.
    expect(decompile('f', diamond, ARMV4T_AGBCC).source).toBe(
      's32 f(s32 a0) {\n    s32 uninit_sp0;\n    if (a0 == 0) a0 = uninit_sp0;\n    return a0 + 1;\n}\n',
    );
    // control: store it on BOTH arms and there is nothing undefined to declare
    const both =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tcmp\tr0, #0\n\tbeq\t.L2\n\tstr\tr0, [sp]\n' +
      '.L2:\n\tldr\tr1, [sp]\n\tadd\tr0, r1, #1\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(decompile('f', both, ARMV4T_AGBCC).source).toBe('s32 f(s32 a0) {\n    return a0 + 1;\n}\n');
  });

  // THE FUNCTION'S OWN DECLARATION BOUNDS ITS ARGUMENT REGISTERS (`ownArgumentWords`). agbcc,
  // canonical flags: `extern int gOut; int ufirst(int k, int *p){ int x; if (k > 5) gOut = x;
  // return *p + k; }` homes `x` in r3, which no caller of a two-parameter function fills. Without
  // the declaration the read is a made-up fourth parameter, and `gOut = a3` wrong C.
  describe('an argument register past the own declaration is an uninitialised local', () => {
    const UFIRST =
      'ufirst:\n\tadd\tr2, r0, #0\n\tcmp\tr2, #0x5\n\tble\t.L6\n\tldr\tr0, .L7\n\tstr\tr3, [r0]\n' +
      '.L6:\n\tldr\tr3, [r1]\n\tadd\tr0, r3, r2\n\tbx\tlr\n.L7:\n\t.word\tgOut\n';
    const lifted = (prototypes: Prototypes) => decompile('ufirst', UFIRST, ARMV4T_AGBCC, { prototypes }).source;
    const local =
      's32 ufirst(s32 a0, s32 *a1) {\n    s32 uninit_r3;\n    if (a0 > 5) gOut = uninit_r3;\n    return *a1 + a0;\n}\n';
    const param =
      's32 ufirst(s32 a0, s32 *a1, s32 a2, s32 a3) {\n    if (a0 > 5) gOut = a3;\n    return *a1 + a0;\n}\n';

    // a bare count bounds nothing: it may count C parameters, and `(s32, long long)` passes r0 and
    // r1:r2
    test('a typed list bounds it, and a count lifts as with no declaration', () => {
      expect(lifted({ ufirst: { params: ['s32', 's32 *'], returns: 's32' } })).toBe(local);
      expect(lifted({ ufirst: { params: 2, returns: 's32' } })).toBe(param);
      expect(lifted({ ufirst: { params: 1, returns: 's32' } })).toBe(param);
    });

    // `struct P mk(int x, int y, int z)` takes its hidden return pointer in r0 and z in r3.
    test('a return not shown to be a scalar leaves room for a hidden pointer in r0', () => {
      const r2 = 'f:\n\tadd\tr0, r0, r2\n\tbx\tlr\n';
      const f = (own: Prototypes[string]) => decompile('f', r2, ARMV4T_AGBCC, { prototypes: { f: own } }).source;
      const kept = 's32 f(s32 a0, s32 a1, s32 a2) {\n    return a0 + a2;\n}\n';
      expect(f({ params: ['s32', 's32'], returns: 's32' })).toMatch(/uninit_r2/);
      for (const own of [{ params: ['s32', 's32'] }, { params: ['s32', 's32'], returns: 'Pt' }, { params: 1 }]) {
        expect(f(own)).toBe(kept);
      }
    });

    // `int st2(int a, int b, int c, int d, int e){ return g(a) + e; }` declared with two
    // parameters: the stack word is the fifth argument, which no uninitialised local can be, and
    // named by position it would take the third parameter's slot (`st2(a0, a1, a2)` returning
    // `a2`).
    test('an incoming stack argument past the own declaration refuses', () => {
      const ST2 =
        'st2:\n\tpush\t{r4, lr}\n\tldr\tr4, [sp, #0x8]\n\tbl\tg\n\tadd\tr0, r0, r4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
      const st2 = (own?: Prototypes[string]) =>
        decompile('st2', ST2, ARMV4T_AGBCC, { prototypes: { g: { params: 1 }, ...(own ? { st2: own } : {}) } }).source;
      const words = (n: number) => Array.from({ length: n }, () => 's32');
      expect(() => st2({ params: words(2), returns: 's32' })).toThrow(
        /incoming stack argument 4, past the 2 argument words/,
      );
      expect(() => st2({ params: words(4), returns: 's32' })).toThrow(/incoming stack argument 4/);
      expect(st2({ params: words(5), returns: 's32' })).toMatch(/return g\(a0\) \+ a4;/);
      // a count bounds nothing, so it refuses nothing
      expect(st2({ params: 2, returns: 's32' })).toMatch(/return g\(a0\) \+ a4;/);
      expect(st2()).toMatch(/return g\(a0\) \+ a4;/);
    });

    test('no declaration, a variadic one or an unsized one bounds nothing', () => {
      expect(lifted({})).toBe(param);
      expect(lifted({ ufirst: { variadicParams: ['s32'] } })).toBe(param);
      expect(lifted({ ufirst: { params: ['s32', 'Unsized'] } })).toBe(param);
    });

    // `int f(int a, int b, int c){ return a + c; }`: r1 is declared and unread, so it stays
    // the parameter that keeps r2 in its slot.
    test('a declared register the body never reads is still a parameter', () => {
      const hole = 'f:\n\tadd\tr0, r0, r2\n\tbx\tlr\n';
      const typed = (n: number) => ({ params: Array.from({ length: n }, () => 's32'), returns: 's32' });
      expect(decompile('f', hole, ARMV4T_AGBCC, { prototypes: { f: typed(3) } }).source).toBe(
        's32 f(s32 a0, s32 a1, s32 a2) {\n    return a0 + a2;\n}\n',
      );
      expect(decompile('f', hole, ARMV4T_AGBCC, { prototypes: { f: typed(1) } }).source).toBe(
        's32 f(s32 a0) {\n    s32 uninit_r2;\n    return a0 + uninit_r2;\n}\n',
      );
    });
  });

  // The declaration context's OWN entry (`ownContextProto`, pipeline.ts `liftWithinContextBound`)
  // bounds the same registers SOFTLY: a register past it the lift never reads is no parameter, and
  // one it reads stays the parameter a context-less lift makes it, with a note — never
  // `uninit_<reg>`, since a header entry for a function still in assembly was checked by no
  // compiler. `int oc_ph(short a, int b){ if (gX) k4(a, b, 2, 0); while (zq(a) != 5) sl(); return
  // gX; }` at agbcc's canonical flags: r2/r3 reach only the guessed calls `zq` and `sl`.
  describe("the context's own entry bounds them softly", () => {
    const OC_PH =
      'oc_ph:\n\tpush\t{r4, lr}\n\tlsl\tr0, r0, #0x10\n\tlsr\tr4, r0, #0x10\n\tldr\tr0, .L8\n\tldr\tr0, [r0]\n' +
      '\tcmp\tr0, #0\n\tbeq\t.L3\n\tlsl\tr0, r4, #0x10\n\tasr\tr0, r0, #0x10\n\tmov\tr2, #0x2\n\tmov\tr3, #0x0\n' +
      '\tbl\tk4\n.L3:\n\tlsl\tr4, r4, #0x10\n\tb\t.L4\n.L8:\n\t.word\tgX\n.L6:\n\tbl\tsl\n.L4:\n\tasr\tr0, r4, #0x10\n' +
      '\tbl\tzq\n\tcmp\tr0, #0x5\n\tbne\t.L6\n\tldr\tr0, .L10\n\tldr\tr0, [r0]\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
      '.L10:\n\t.word\tgX\n';
    const k4 = { k4: { params: ['int', 'int', 'int', 'int'], returnsVoid: true } };
    const ocPh = (ownContextProto?: Prototypes[string]) =>
      decompile('oc_ph', OC_PH, ARMV4T_AGBCC, { prototypes: k4, ...(ownContextProto ? { ownContextProto } : {}) });

    test('an argument register past it that nothing reads is no parameter', () => {
      expect(ocPh().source).toMatch(/^s32 oc_ph\(u16 a0, s32 a1, s32 a2, s32 a3\) \{/m);
      const r = ocPh({ params: ['short', 'int'], returns: 'int' });
      expect(r.source).toMatch(/^s32 oc_ph\(u16 a0, s32 a1\) \{/m);
      expect(r.source).not.toMatch(/uninit_/);
      expect(r.ownArityNotes).toEqual([]);
      // the body is the stated entry's, byte for byte
      expect(r.source).toBe(
        decompile('oc_ph', OC_PH, ARMV4T_AGBCC, {
          prototypes: { ...k4, oc_ph: { params: ['short', 'int'], returns: 'int' } },
        }).source,
      );
    });

    // `void oc_cb(void);` ahead of `void oc_cb(struct T *t){ g(&t->b, t->c + 1); }`: the shape of
    // sbk2's task callbacks, whose `(void)` forward declarations were short when they were decompiled
    test('a register past it that the body reads stays a parameter, with a note', () => {
      const OC_CB =
        'oc_cb:\n\tpush\t{lr}\n\tadd\tr2, r0, #0x4\n\tldr\tr1, [r0, #0x8]\n\tadd\tr1, r1, #0x1\n\tadd\tr0, r2, #0\n' +
        '\tbl\tg\n\tpop\t{r0}\n\tbx\tr0\n';
      const g = { g: { params: ['int *', 'int'], returnsVoid: true } };
      const plain = decompile('oc_cb', OC_CB, ARMV4T_AGBCC, { prototypes: g });
      const r = decompile('oc_cb', OC_CB, ARMV4T_AGBCC, {
        prototypes: g,
        ownContextProto: { params: [], returnsVoid: true },
      });
      expect(r.source).toBe(plain.source);
      expect(r.source).toMatch(/^void oc_cb\(s32 \*a0\) \{/m);
      expect(r.ownArityNotes).toEqual([
        'oc_cb: its context declaration `void oc_cb(void)` fills 0 argument words, and the body reads r0 past ' +
          'them — kept as a parameter, which the header contradicts',
      ]);
      // stated, the same entry is the caller's word: r0 is an uninitialised local
      expect(
        decompile('oc_cb', OC_CB, ARMV4T_AGBCC, { prototypes: { ...g, oc_cb: { params: [], returnsVoid: true } } })
          .source,
      ).toMatch(/uninit_r0/);
    });

    // `int t3(int a, int b, int c){ int x = a ? b : c; g(0); return g(x); }` under `int t3(int);`:
    // r1's and r2's undefined values meet in r4's join, which collapses into one keyed r4
    // (frontend/ssa.ts `collapseUndefinedJoins`), and the read of r1/r2 must survive that
    test('a read of two registers past it through one join keeps both, with a note', () => {
      const T3 =
        't3:\n\tpush\t{r4, lr}\n\tadd\tr4, r2, #0\n\tcmp\tr0, #0\n\tbeq\t.L3\n\tadd\tr4, r1, #0\n.L3:\n' +
        '\tmov\tr0, #0x0\n\tbl\tg\n\tadd\tr0, r4, #0\n\tbl\tg\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
      const g = { g: { params: ['int'], returns: 'int' } };
      const r = decompile('t3', T3, ARMV4T_AGBCC, {
        prototypes: g,
        ownContextProto: { params: ['int'], returns: 'int' },
      });
      expect(r.source).toBe(decompile('t3', T3, ARMV4T_AGBCC, { prototypes: g }).source);
      expect(r.source).toMatch(/^s32 t3\(s32 a0, s32 a1, s32 a2\) \{/m);
      expect(r.ownArityNotes).toEqual([
        't3: its context declaration `int t3(int)` fills 1 argument word, and the body reads r1, r2 past it — ' +
          'kept as parameters, which the header contradicts',
      ]);
    });

    // a table carrying the context's entry under its mark is split where every lift passes, so a
    // path that hands the lift such a table unsplit still bounds softly, never hard
    test('a marked entry in the table bounds the lift softly', () => {
      const OC_CB =
        'oc_cb:\n\tpush\t{lr}\n\tadd\tr2, r0, #0x4\n\tldr\tr1, [r0, #0x8]\n\tadd\tr1, r1, #0x1\n\tadd\tr0, r2, #0\n' +
        '\tbl\tg\n\tpop\t{r0}\n\tbx\tr0\n';
      const g = { g: { params: ['int *', 'int'], returnsVoid: true } };
      const notes: string[] = [];
      const fn = liftStamped(
        'oc_cb',
        OC_CB,
        ARMV4T_AGBCC,
        { ...g, oc_cb: { params: [], returnsVoid: true, fromContext: true } },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        notes,
      );
      expect(fn.blocks[0].params).toHaveLength(1);
      expect(fn.blocks.some((b) => b.ops.some((op) => op.opcode === 'undef'))).toBe(false);
      expect(notes).toHaveLength(1);
    });

    test('a read of the last argument register lifts as without it, and a stated entry wins', () => {
      const UFIRST =
        'ufirst:\n\tadd\tr2, r0, #0\n\tcmp\tr2, #0x5\n\tble\t.L6\n\tldr\tr0, .L7\n\tstr\tr3, [r0]\n' +
        '.L6:\n\tldr\tr3, [r1]\n\tadd\tr0, r3, r2\n\tbx\tlr\n.L7:\n\t.word\tgOut\n';
      const own = { params: ['s32', 's32 *'], returns: 's32' };
      const soft = decompile('ufirst', UFIRST, ARMV4T_AGBCC, { ownContextProto: own });
      expect(soft.source).toBe(decompile('ufirst', UFIRST, ARMV4T_AGBCC).source);
      expect(soft.ownArityNotes).toHaveLength(1);
      expect(soft.ownArityNotes[0]).toMatch(/reads r3 past them/);
      const stated = decompile('ufirst', UFIRST, ARMV4T_AGBCC, { prototypes: { ufirst: own }, ownContextProto: own });
      expect(stated.source).toBe(decompile('ufirst', UFIRST, ARMV4T_AGBCC, { prototypes: { ufirst: own } }).source);
      expect(stated.ownArityNotes).toEqual([]);
    });

    // the stack refusal a stated entry has is no decline here: the lift goes back to its
    // context-less self, and says why
    test('an incoming stack argument past it lifts as without it, with a note', () => {
      const ST2 =
        'st2:\n\tpush\t{r4, lr}\n\tldr\tr4, [sp, #0x8]\n\tbl\tg\n\tadd\tr0, r0, r4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
      const g = { g: { params: 1 } };
      const r = decompile('st2', ST2, ARMV4T_AGBCC, {
        prototypes: g,
        ownContextProto: { params: ['s32', 's32'], returns: 's32' },
      });
      expect(r.source).toBe(decompile('st2', ST2, ARMV4T_AGBCC, { prototypes: g }).source);
      expect(r.ownArityNotes).toEqual([
        'st2: lifted without its context declaration `s32 st2(s32, s32)`, which it could not be lifted within ' +
          "(cannot lift 'st2': it reads incoming stack argument 4, past the 2 argument words its own declaration " +
          'fills — the declaration and the body disagree)',
      ]);
    });
  });

  // synthetic:uninitfirst:agbcc — `if (k > 5) gOut = v0 + …; switch (k) { case 0: v0 = p[0]; … }`:
  // the local is read BEFORE any store, so no store reaches the read on any path. A callee that
  // assigned the word as its stack parameter would have run before the read, and agbcc loads no
  // word of its outgoing area after a call, so a read nothing reaches is that local uninitialised —
  // unless a callee holding the frame's address may have written it, which the frame-object audit
  // answers.
  describe('a slot read before every store to it is an uninitialised local', () => {
    const readFirst = (tail: string) =>
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tcmp\tr0, #5\n\tble\t.L2\n' +
      '\tldr\tr1, [sp]\n\tldr\tr2, .L9\n\tstr\tr1, [r2]\n.L2:\n\tstr\tr0, [sp]\n' +
      tail +
      '\tldr\tr0, [sp]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n.L9:\n\t.word\tgOut\n';
    const g = { prototypes: { g: { params: 0, returnsVoid: true } } };

    test('read on one path, stored after it, with or without a call between', () => {
      expect(decompile('f', readFirst('\tbl\tg\n'), ARMV4T_AGBCC, g).source).toBe(
        's32 f(s32 a0) {\n    s32 uninit_sp0;\n    if (a0 > 5) gOut = uninit_sp0;\n    g();\n    return a0;\n}\n',
      );
      expect(decompile('f', readFirst(''), ARMV4T_AGBCC).source).toBe(
        's32 f(s32 a0) {\n    s32 uninit_sp0;\n    if (a0 > 5) gOut = uninit_sp0;\n    return a0;\n}\n',
      );
    });

    test('…and without the compiler’s layout claim the word may be one a callee left, so it declines', () => {
      // the after-call form is the claim read here; the stronger never-loaded form is not needed
      const weakOnly = {
        ...ARMV4T_AGBCC,
        compilerBehaviors: { ...ARMV4T_AGBCC.compilerBehaviors, outgoingAreaNeverLoadedFrom: undefined },
      };
      expect(decompile('f', readFirst(''), weakOnly).source).toContain('s32 uninit_sp0;');
      const unclaimed = {
        ...weakOnly,
        compilerBehaviors: { ...weakOnly.compilerBehaviors, localsAboveOutgoingArea: false },
      };
      expect(() => decompile('f', readFirst(''), unclaimed)).toThrow(/stack pointer used as data/);
    });

    test('a read of a word a declared call takes as its stack argument still refuses', () => {
      const licensed =
        'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tldr\tr1, [sp]\n\tldr\tr2, .L9\n\tstr\tr1, [r2]\n' +
        '\tstr\tr0, [sp]\n\tbl\tfive\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n.L9:\n\t.word\tgOut\n';
      expect(() => decompile('f', licensed, ARMV4T_AGBCC, { prototypes: { five: { params: 5 } } })).toThrow(
        /\[sp,#0\] is an outgoing stack-argument slot .* but this function also LOADS it/,
      );
    });

    // A read before the store of a word a CALLEE may write through an address of the frame is not
    // uninitialised. The load arm keys it as a slot all the same; the audit then sees the captured
    // object and its writer, and either keeps the bytes as one object in memory or refuses.
    // Compiled agbcc, canonical flags: `int a[2]; get(&a[1]); k += use(a[0]); a[0] = k; …` (`get`
    // may write `p[-1]`), the same with no store to a[0] at all, and the address published to a global.
    const escaped = (body: string, pool = '') =>
      `f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n${body}\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n${pool}`;
    const getUse = {
      prototypes: { get: { params: 1, returnsVoid: true }, use: { params: 1 }, g: { params: 0, returnsVoid: true } },
    };

    test('…read through the one object an escaped writer may reach, never as `undef`', () => {
      const storedLater = escaped(
        '\tadd\tr4, r0, #0\n\tadd\tr0, sp, #0x4\n\tbl\tget\n\tldr\tr0, [sp]\n\tbl\tuse\n\tadd\tr4, r4, r0\n' +
          '\tstr\tr4, [sp]\n\tadd\tr0, r4, #0\n\tbl\tuse\n\tldr\tr0, [sp, #0x4]\n',
      );
      const neverStored = escaped('\tadd\tr0, sp, #0x4\n\tbl\tget\n\tldr\tr0, [sp]\n\tbl\tuse\n');
      for (const asm of [storedLater, neverStored]) {
        const src = decompile('f', asm, ARMV4T_AGBCC, getUse).source;
        expect(src).toContain('u8 sp0[8];');
        expect(src).toContain('use(*(s32 *)sp0)');
        expect(src).not.toContain('uninit');
      }
    });

    test('…and refused where the writer is not one the object can hold', () => {
      const published = escaped(
        '\tadd\tr4, r0, #0\n\tldr\tr1, .L3\n\tadd\tr0, sp, #0x4\n\tstr\tr0, [r1]\n\tbl\tg\n\tldr\tr0, [sp]\n' +
          '\tbl\tuse\n\tstr\tr4, [sp]\n\tadd\tr0, r4, #0\n\tbl\tuse\n\tldr\tr0, [sp, #0x4]\n',
        '.L3:\n\t.word\tgp\n',
      );
      expect(() => decompile('f', published, ARMV4T_AGBCC, getUse)).toThrow(
        /an unstored slot is not provably uninitialised/,
      );
    });
  });

  // A captured store's bytes that a `[sp,#k]` SLOT load reads are a local's, under agbcc's claim
  // that it loads no word of its outgoing area (`outgoingAreaNeverLoadedFrom`). The slot load is the
  // slot model's and not in the IR the frame-object audit reads, so the frontend's loaded-word
  // bound, measured once off the instructions, carries it (`loadedWords`); without it
  // `storedNeverRead` would refuse these as a possible stack argument.
  describe('a slot load of a captured store proves it no call’s stack argument', () => {
    // Compiled agbcc, canonical flags: `struct S { u16 lo, hi; u32 x, y; } s; s.lo = a; s.hi = b;
    // s.x = c; s.y = c + 1; r = sink(s.y); return *(u32 *)&s + r + s.x;` — the load after the call.
    const after =
      'u4:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0xc\n\tlsl\tr1, r1, #0x10\n\tlsr\tr1, r1, #0x10\n\tmov\tr3, sp\n' +
      '\tstrh\tr0, [r3]\n\tmov\tr0, sp\n\tstrh\tr1, [r0, #0x2]\n\tstr\tr2, [sp, #0x4]\n\tadd\tr2, r2, #0x1\n' +
      '\tstr\tr2, [sp, #0x8]\n\tadd\tr0, r2, #0\n\tbl\tsink\n\tadd\tr1, r0, #0\n\tldr\tr0, [sp]\n\tadd\tr0, r0, r1\n' +
      '\tldr\tr1, [sp, #0x4]\n\tadd\tr0, r0, r1\n\tadd\tsp, sp, #0xc\n\tpop\t{r1}\n\tbx\tr1\n';
    // …and the klonoa shape (code_3 `GameplayMainLoop`), the word loaded BEFORE the call: only
    // the strong form clears it, since the after-call liveness sees no load across a call.
    const before =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tmov\tr3, sp\n\tstrh\tr0, [r3]\n\tstrh\tr1, [r3, #0x2]\n' +
      '\tldr\tr4, [sp]\n\tbl\tg\n\tadd\tr0, r4, #0\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    const protos = { prototypes: { sink: { params: 1 }, g: { params: 0, returnsVoid: true } } };

    test('lifts through the one object, the call taking no stack word', () => {
      const a = decompile('u4', after, ARMV4T_AGBCC, protos).source;
      expect(a).toContain('union { s32 word[3]; u16 half[6]; } sp0;');
      expect(a).toContain('return sp0.word[0] + sink(a2 + 1) + sp0.word[1];');
      const b = decompile('f', before, ARMV4T_AGBCC, protos).source;
      expect(b).toContain('g();');
      expect(b).not.toContain('uninit');
    });

    test('…and a captured store beneath every load still refuses, naming the bound it was judged by', () => {
      // Compiled agbcc, canonical flags: `struct S16 s = gS; use(k); return s.c + s.d;` — the
      // block copy's `stmia` stores [sp,#0], [sp,#4], [sp,#8] and its `str` [sp,#12]. The decline
      // names [sp,#0], the copy's first word: the lowest of the two stores beneath the lowest load,
      // at [sp,#8].
      const copy =
        'v2:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x10\n\tmov\tr2, sp\n\tldr\tr1, .L3\n\tldmia\tr1!, {r3, r4, r5}\n' +
        '\tstmia\tr2!, {r3, r4, r5}\n\tldr\tr1, [r1]\n\tstr\tr1, [r2]\n\tbl\tuse\n\tldr\tr0, [sp, #0x8]\n' +
        '\tldr\tr1, [sp, #0xc]\n\tadd\tr0, r0, r1\n\tadd\tsp, sp, #0x10\n\tpop\t{r4, r5}\n\tpop\t{r1}\n\tbx\tr1\n' +
        '.L3:\n\t.word\tgS\n';
      const use = { prototypes: { use: { params: 1 } } };
      expect(() => decompile('v2', copy, ARMV4T_AGBCC, use)).toThrow(/no load at or beneath it proves it a local's/);
      const weakOnly = {
        ...ARMV4T_AGBCC,
        compilerBehaviors: { ...ARMV4T_AGBCC.compilerBehaviors, outgoingAreaNeverLoadedFrom: undefined },
      };
      expect(() => decompile('v2', copy, weakOnly, use)).toThrow(/no load after a call proves it a local's/);
    });

    test('…and without the claim neither lifts', () => {
      const unclaimed = {
        ...ARMV4T_AGBCC,
        compilerBehaviors: { ...ARMV4T_AGBCC.compilerBehaviors, outgoingAreaNeverLoadedFrom: undefined },
      };
      expect(() => decompile('u4', after, unclaimed, protos)).toThrow();
      expect(() => decompile('f', before, unclaimed, protos)).toThrow();
    });
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
    // one object at [sp,#0] escaping to DMA3<reg>, and an `undef` at [sp,#4] the switch never
    // writes. The control word is `DMA_SRC_FIXED`, so the device reads [sp,#0) alone.
    const escapeTo = (regOff: string, control = '0x81000001') =>
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tmov\tr4, sp\n\tldr\tr2, .L9\n' +
      `\tstr\tr4, [r2, #${regOff}]\n\tldr\tr0, .L9+4\n\tstr\tr0, [r2, #0x8]\n` +
      '\tldr\tr1, [r4]\n\tcmp\tr1, #0\n\tbeq\t.L2\n\tstr\tr1, [sp, #4]\n' +
      '.L2:\n\tldr\tr3, [sp, #4]\n\tadd\tr0, r1, r3\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
      `.L9:\n\t.word\t0x040000D4\n\t.word\t${control}\n`;

    // …and it is the CONTROL WORD that keeps [sp,#4] out of the device's reach: an incrementing
    // source reads upward from the object.
    test('an incrementing source may read the slot above the object', () => {
      expect(() => decompile('f', escapeTo('0x00', '0x80000001'), ARMV4T_AGBCC)).toThrow(
        'the captured address at [sp,#0) is handed to a device that reads through it, which may read the slot at [sp,#4]',
      );
    });

    // …and a control word this function never states bounds nothing at all, so the whole local
    // area is kept as ONE object in memory: the slot at [sp,#4] is a member the device may read,
    // and its store stays a store.
    test('a control word that is not a literal keeps the whole local area as one object', () => {
      const src = decompile('f', escapeTo('0x00', 'gCtl'), ARMV4T_AGBCC).source;
      expect(src).toContain('    u8 sp0[8];');
      expect(src).toContain('if (v0 != 0) ((s32 *)sp0)[1] = v0;');
      expect(src).toContain('return v0 + ((s32 *)sp0)[1];');
    });

    test('DMA3SAD (+0) — the hardware reads the object, so the undef stands', () => {
      const src = decompile('f', escapeTo('0x00'), ARMV4T_AGBCC).source;
      expect(src).toContain('volatile s32 sp0;'); // the address still left the function
      // …but nothing can write [sp,#4], so its merge still has an undefined arm: `v0` is that
      // uninitialised local, declared and assigned only where the store runs.
      expect(src).toBe(
        's32 f(void) {\n    s32 v0;\n    volatile s32 sp0;\n    s32 *p0;\n    p0 = (s32 *)67109076;\n' +
          '    *p0 = &sp0;\n    p0[2] = 2164260865;\n    if (sp0 != 0) v0 = sp0;\n    return sp0 + v0;\n}\n',
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

    // A SECOND OBJECT a device may read is not declared as a second local. Two locals have no
    // guaranteed adjacency, so a device reading past the one it was given reads whatever the
    // recompile put there. Where nothing bounds the read — here no control word is written at all —
    // both are members of ONE object in memory, and each store is a store into it.
    test('a second object an unbounded read reaches is a member of one object', () => {
      const twoObjects =
        'f:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x10\n\tmov\tr4, sp\n\tstrh\tr0, [r4]\n' +
        '\tmov\tr5, sp\n\tstrh\tr1, [r5, #0x2]\n\tldr\tr2, .L9\n\tstr\tr4, [r2, #0x0]\n' +
        '\tstr\tr3, [r2, #0x4]\n\tmov\tr0, #0x0\n\tadd\tsp, sp, #0x10\n\tpop\t{r4, r5}\n\tpop\t{r1}\n\tbx\tr1\n' +
        '.L9:\n\t.word\t0x040000D4\n';
      const src = decompile('f', twoObjects, ARMV4T_AGBCC).source;
      expect(src).toContain('    u8 sp0[16];');
      expect(src).toContain('p0 = (u16 *)sp0;');
      expect(src).toContain('*p0 = a0;');
      expect(src).toContain('p0[1] = a1;');
    });

    // …and the object may start at [sp,#0] with its first member a word the slot model keyed, the
    // overlap the one object dissolves. Verbatim agbcc: `struct Q { u32 a, b, c; } s; s.a = x;
    // s.b = y; s.c = z; REG_DMA3SAD = (u32)&s; REG_DMA3DAD = (u32)gDst; REG_DMA3CNT = 0x84000001;
    // *gCnt = 0x84000003;` — its recompile is instruction-identical, all three member stores kept.
    test('an object at the frame base over a keyed slot is still one object', () => {
      const atBase =
        'u1:\n\tadd\tsp, sp, #-0xc\n\tstr\tr0, [sp]\n\tstr\tr1, [sp, #0x4]\n\tstr\tr2, [sp, #0x8]\n' +
        '\tldr\tr0, .L9\n\tmov\tr1, sp\n\tstr\tr1, [r0]\n\tldr\tr1, .L9+0x4\n\tldr\tr0, .L9+0x8\n\tstr\tr0, [r1]\n' +
        '\tadd\tr1, r1, #0x4\n\tldr\tr0, .L9+0xc\n\tstr\tr0, [r1]\n\tldr\tr0, .L9+0x10\n\tldr\tr1, [r0]\n' +
        '\tldr\tr0, .L9+0x14\n\tstr\tr0, [r1]\n\tadd\tsp, sp, #0xc\n\tbx\tlr\n.L10:\n\t.align\t2, 0\n.L9:\n' +
        '\t.word\t0x40000d4\n\t.word\t0x40000d8\n\t.word\tgDst\n\t.word\t-0x7bffffff\n\t.word\tgCnt\n' +
        '\t.word\t-0x7bfffffd\n';
      const src = decompile('u1', atBase, ARMV4T_AGBCC, {
        prototypes: { u1: { params: 3, returnsVoid: true } },
      }).source;
      expect(src).toContain('    u8 sp0[12];');
      expect(src).toContain('*p0 = a0;\n    p0[1] = a1;\n    p0[2] = a2;');
      // …and where the read is bounded, the one object is not on offer and the frame is still
      // refused: no call takes a stack word, so [sp,#0] is the published object's own word, and the
      // words at [sp,#4] and [sp,#8] the device may read are slots this lift keeps in registers
      const bounded = atBase.replace(
        '\tldr\tr0, .L9+0x10\n\tldr\tr1, [r0]\n\tldr\tr0, .L9+0x14\n\tstr\tr0, [r1]\n',
        '',
      );
      expect(() => decompile('u1', bounded, ARMV4T_AGBCC)).toThrow(
        /the captured address at \[sp,#0\) is handed to a device that reads through it, which may read the slot at \[sp,#4\]/,
      );
    });

    // …and a slot word and a narrower member through the captured address at the same bytes are
    // two types at one byte, which the one object declares as the views of one union rather than
    // cast-spell — every access a view, the address handed to the device as a value
    test('a slot word under a halfword member is the views of one union', () => {
      const twoWidths =
        'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x8\n\tstr\tr1, [sp]\n\tstr\tr1, [sp, #0x4]\n\tmov\tr2, sp\n' +
        '\tstrh\tr0, [r2]\n\tldr\tr3, .L9\n\tstr\tr2, [r3]\n\tldr\tr0, [sp]\n\tldr\tr1, [sp, #0x4]\n' +
        '\tadd\tr0, r0, r1\n\tadd\tsp, sp, #0x8\n\tpop\t{r1}\n\tbx\tr1\n.L9:\n\t.word\t0x040000D4\n';
      expect(decompile('f', twoWidths, ARMV4T_AGBCC).source).toContain(
        '    union { s32 word[2]; u16 half[4]; } sp0;\n    sp0.word[0] = a1;\n    sp0.word[1] = a1;\n' +
          '    sp0.half[0] = a0;\n    *(volatile s32 *)67109076 = &sp0;\n    return sp0.word[0] + sp0.word[1];',
      );
      // …and a halfword member misaligned to its width names no element of a view, so it refuses
      const misaligned = twoWidths.replace('\tstrh\tr0, [r2]\n', '\tstrh\tr0, [r2, #0x1]\n');
      expect(misaligned).not.toBe(twoWidths);
      expect(() => decompile('f', misaligned, ARMV4T_AGBCC)).toThrow(/is not aligned to its width/);
    });

    // THE MODEL IS CHOSEN BEFORE THE SHAPE: where a device read nothing bounds is the only escape,
    // a frame the per-object model cannot describe is kept as one object whatever the read reaches.
    // Verbatim agbcc, `union V { u32 w; u8 b[8]; } v; v.w = x; REG_DMA3SAD = (u32)&v; …; *gCnt = 5;
    // return v.b[0];` — the union's word is the only slot, at the object's own offset, and the
    // recompile is instruction-identical.
    test('an object over its own slot is one object when the read is unbounded', () => {
      const unionAtBase =
        'g5:\n\tadd\tsp, sp, #-0x8\n\tstr\tr0, [sp]\n\tldr\tr0, .L3\n\tmov\tr1, sp\n\tstr\tr1, [r0]\n' +
        '\tldr\tr1, .L3+0x4\n\tldr\tr0, .L3+0x8\n\tstr\tr0, [r1]\n\tadd\tr1, r1, #0x4\n' +
        '\tldr\tr0, .L3+0xc\n\tstr\tr0, [r1]\n\tldr\tr0, .L3+0x10\n\tldr\tr1, [r0]\n\tmov\tr0, #0x5\n' +
        '\tstr\tr0, [r1]\n\tmov\tr0, sp\n\tldrb\tr0, [r0]\n\tadd\tsp, sp, #0x8\n\tbx\tlr\n.L4:\n' +
        '\t.align\t2, 0\n.L3:\n\t.word\t0x40000d4\n\t.word\t0x40000d8\n\t.word\tgDst\n' +
        '\t.word\t-0x7bfffffe\n\t.word\tgCnt\n';
      const src = decompile('g5', unionAtBase, ARMV4T_AGBCC).source;
      expect(src).toContain('    u8 sp0[8];');
      expect(src).toContain('*(s32 *)sp0 = a0;');
      expect(src).toContain('return *(u8 *)sp0;');
      // …and bounded, the per-object refusal stands
      const bounded = unionAtBase.replace(
        '\tldr\tr0, .L3+0x10\n\tldr\tr1, [r0]\n\tmov\tr0, #0x5\n\tstr\tr0, [r1]\n',
        '',
      );
      expect(bounded).not.toBe(unionAtBase);
      expect(() => decompile('g5', bounded, ARMV4T_AGBCC)).toThrow(
        'the object at [sp,#0) overlaps the SSA slot at [sp,#0] — one byte, two models',
      );
    });

    // …and where the one object's only member is one access at its base, it is still the array the
    // declaration says. The read reaches words nothing accounts for, so the frame stays whole; a
    // scalar spelling of the member would assign to the array, or read its address. Verbatim agbcc,
    // `u16 buf[4]; buf[0] = x; REG_DMA3SAD = (u32)buf; REG_DMA3DAD = (u32)gDst; return buf[0];` —
    // the channel is never armed here, so nothing bounds the read.
    test('a lone member at the base of one object is spelled through the array', () => {
      const lone =
        'm6:\n\tadd\tsp, sp, #-0x8\n\tmov\tr1, sp\n\tstrh\tr0, [r1]\n\tldr\tr0, .L12\n\tstr\tr1, [r0]\n' +
        '\tldr\tr1, .L12+0x4\n\tldr\tr0, .L12+0x8\n\tstr\tr0, [r1]\n\tmov\tr0, sp\n\tldrh\tr0, [r0]\n' +
        '\tadd\tsp, sp, #0x8\n\tbx\tlr\n.L13:\n\t.align\t2, 0\n.L12:\n\t.word\t0x40000d4\n\t.word\t0x40000d8\n' +
        '\t.word\tgDst\n';
      const src = decompile('m6', lone, ARMV4T_AGBCC).source;
      expect(src).toContain('    u8 sp0[8];');
      expect(src).toContain('*(u16 *)sp0 = a0;');
      expect(src).toContain('return *(u16 *)sp0;');
      // …and a read alone: the machine loads the word at [sp], it does not return the frame address
      const readOnly =
        'j:\n\tadd\tsp, sp, #-0x10\n\tmov\tr1, sp\n\tldr\tr0, .L3\n\tstr\tr1, [r0]\n\tldr\tr0, [r1]\n' +
        '\tadd\tsp, sp, #0x10\n\tbx\tlr\n.L3:\n\t.word\t0x40000d4\n';
      const read = decompile('j', readOnly, ARMV4T_AGBCC).source;
      expect(read).toContain('    u8 sp0[16];');
      expect(read).toContain('return *(s32 *)sp0;');
    });

    // …a member at [+1] through the captured address. Verbatim agbcc, `union U { u16 h; u8 b[2]; }
    // u; u.h = x; REG_DMA3SAD = (u32)&u; …; *gCnt = 5; return u.b[1];`.
    test('a member through the captured address is one object when the read is unbounded', () => {
      const unionMember =
        'g1:\n\tadd\tsp, sp, #-0x4\n\tlsl\tr0, r0, #0x10\n\tlsr\tr0, r0, #0x10\n\tldr\tr2, .L3\n' +
        '\tldr\tr1, [sp]\n\tand\tr1, r1, r2\n\torr\tr1, r1, r0\n\tstr\tr1, [sp]\n\tldr\tr0, .L3+0x4\n' +
        '\tmov\tr2, sp\n\tstr\tr2, [r0]\n\tldr\tr1, .L3+0x8\n\tldr\tr0, .L3+0xc\n\tstr\tr0, [r1]\n' +
        '\tadd\tr1, r1, #0x4\n\tldr\tr0, .L3+0x10\n\tstr\tr0, [r1]\n\tldr\tr0, .L3+0x14\n' +
        '\tldr\tr1, [r0]\n\tmov\tr0, #0x5\n\tstr\tr0, [r1]\n\tldrb\tr0, [r2, #0x1]\n' +
        '\tadd\tsp, sp, #0x4\n\tbx\tlr\n.L4:\n\t.align\t2, 0\n.L3:\n\t.word\t-0x10000\n' +
        '\t.word\t0x40000d4\n\t.word\t0x40000d8\n\t.word\tgDst\n\t.word\t-0x7effffff\n\t.word\tgCnt\n';
      const src = decompile('g1', unionMember, ARMV4T_AGBCC).source;
      expect(src).toContain('    u8 sp0[4];');
      expect(src).toContain('return ((u8 *)sp0)[1];');
    });

    // …and a byte buffer filled through a runtime index, then handed to a transfer whose control
    // word is a parameter. Verbatim agbcc, `u8 buf[8]; for (i = 0; i < 8; i++) buf[i] = src[i];
    // REG_DMA3SAD = (u32)buf; …; REG_DMA3CNT = ctrl;` — a byte index names bytes of the storage and
    // aliases every type, so nothing needs checking; the recompile is instruction-identical.
    test('a byte index into one object is kept', () => {
      const byteBuffer =
        'g3:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr4, r0, #0\n\tadd\tr3, r1, #0\n' +
        '\tmov\tr2, #0x0\n\tldr\tr5, .L14\n.L12:\n\tmov\tr1, sp\n\tadd\tr0, r1, r2\n' +
        '\tadd\tr1, r3, r2\n\tldrb\tr1, [r1]\n\tstrb\tr1, [r0]\n\tadd\tr2, r2, #0x1\n' +
        '\tcmp\tr2, #0x7\n\tble\t.L12\n\tldr\tr0, .L14+0x4\n\tmov\tr1, sp\n\tstr\tr1, [r0]\n' +
        '\tadd\tr0, r0, #0x4\n\tstr\tr5, [r0]\n\tadd\tr0, r0, #0x4\n\tstr\tr4, [r0]\n' +
        '\tmov\tr0, #0x0\n\tadd\tsp, sp, #0x8\n\tpop\t{r4, r5}\n\tpop\t{r1}\n\tbx\tr1\n.L15:\n' +
        '\t.align\t2, 0\n.L14:\n\t.word\tgDst\n\t.word\t0x40000d4\n';
      const src = decompile('g3', byteBuffer, ARMV4T_AGBCC).source;
      expect(src).toContain('    u8 sp0[8];');
      expect(src).toContain('((u8 *)sp0)[v0] = *(u8 *)(a1 + v0);');
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
      expect(withMap).toContain('p0 = (s32 *)&REG_DMA3SAD;'); // the map really did rename it
      expect(withMap).toContain('if (sp0 != 0) v0 = sp0;'); // …and the undef still stands
    });

    // …nor on which side of which operator the constant sits: `DMA3DAD - 4` is DMA3SAD
    test('a source register reached by subtracting a constant is the same source register', () => {
      const bySub = escapeTo('0x00')
        .replace('\tldr\tr2, .L9\n', '\tldr\tr2, .L9\n\tsub\tr2, #0x4\n')
        .replace('\t.word\t0x040000D4\n', '\t.word\t0x040000D8\n');
      expect(decompile('f', bySub, ARMV4T_AGBCC).source).toContain('if (sp0 != 0) v0 = sp0;');
    });

    // A LITERAL register offset folds, because the predicate resolves an ADDRESS and `[r2, r5]`
    // with `r3 = 0` names the same one as `[r2, #0]`. An offset it cannot fold does not.
    test('a register offset resolves when it is a literal and refuses when it is not', () => {
      const viaZero = escapeTo('0x00').replace('\tstr\tr4, [r2, #0x00]\n', '\tmov\tr3, #0x00\n\tstr\tr4, [r2, r3]\n');
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

    // …and the same bound keeps a SECOND object private. agbcc's own output for two fills in one
    // function, `DMA_FILL16(0, a, 16); DMA_FILL32(0, b, 8);` with the macros writing a `vu16`/`vu32`
    // tmp and a fixed-source control: each device read stays inside its own object.
    const twoFills = (control16: string) =>
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tmov\tr3, sp\n\tmov\tr2, #0x0\n\tstrh\tr2, [r3]\n' +
      '\tldr\tr4, .L3\n\tstr\tr3, [r4]\n\tldr\tr3, .L3+0x4\n\tstr\tr0, [r3]\n\tldr\tr2, .L3+0x8\n' +
      '\tldr\tr0, .L3+0xc\n\tstr\tr0, [r2]\n\tldr\tr0, [r2]\n\tmov\tr0, #0x0\n\tstr\tr0, [sp, #0x4]\n' +
      '\tadd\tr0, sp, #0x4\n\tstr\tr0, [r4]\n\tstr\tr1, [r3]\n\tldr\tr0, .L3+0x10\n\tstr\tr0, [r2]\n' +
      '\tldr\tr0, [r2]\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n.L3:\n\t.word\t0x40000d4\n' +
      `\t.word\t0x40000d8\n\t.word\t0x40000dc\n\t.word\t${control16}\n\t.word\t-0x7afffff8\n`;

    test('two fixed-source fills each read their own object', () => {
      const src = decompile('f', twoFills('-0x7efffff0'), ARMV4T_AGBCC).source;
      expect(src).toContain('volatile u16 sp0;');
      expect(src).toContain('volatile u32 sp4;');
    });

    // …and a fixed source reads the unit-ALIGNED word holding its address, because the GBA drops
    // the low bits: agbcc's `void al(u16 x, u16 y){ vu16 a; vu16 b; a = x; b = y; … REG_DMA3SAD =
    // &b; … REG_DMA3CNT = 0x85000004; }` puts `b` at [sp,#2], and a 32-bit read of it reads `a`.
    const aligned = (control: string) =>
      'al:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x4\n\tlsl\tr0, r0, #0x10\n\tlsr\tr0, r0, #0x10\n' +
      '\tlsl\tr1, r1, #0x10\n\tlsr\tr1, r1, #0x10\n\tmov\tr2, sp\n\tstrh\tr0, [r2]\n\tmov\tr5, sp\n' +
      '\tadd\tr5, r5, #0x2\n\tstrh\tr1, [r5]\n\tldr\tr4, .L3\n\tmov\tr0, sp\n\tstr\tr0, [r4]\n\tldr\tr3, .L3+0x4\n' +
      '\tldr\tr1, .L3+0x8\n\tstr\tr1, [r3]\n\tldr\tr2, .L3+0xc\n\tldr\tr0, .L3+0x10\n\tstr\tr0, [r2]\n\tstr\tr5, [r4]\n' +
      '\tstr\tr1, [r3]\n\tldr\tr0, .L3+0x14\n\tstr\tr0, [r2]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4, r5}\n\tpop\t{r0}\n' +
      '\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n\t.word\t0x40000d4\n\t.word\t0x40000d8\n\t.word\tgDst\n' +
      `\t.word\t0x40000dc\n\t.word\t-0x7efffffc\n\t.word\t${control}\n`;

    test('a fixed source reads the whole aligned unit holding its address', () => {
      expect(() => decompile('al', aligned('-0x7afffffc'), ARMV4T_AGBCC)).toThrow(
        /the captured address at \[sp,#2\) is handed to a device that reads through it, which may read the object at \[sp,#0\)/,
      );
      // CONTROL: 16-bit units, and the halfword at [sp,#2] is a unit of its own
      expect(decompile('al', aligned('-0x7efffffc'), ARMV4T_AGBCC).source).toContain('volatile u16 sp2;');
    });

    test('an incrementing fill reads the object above its own', () => {
      expect(() => decompile('f', twoFills('0x80000010'), ARMV4T_AGBCC)).toThrow(
        /the captured address at \[sp,#0\) is handed to a device that reads through it, which may read the object at \[sp,#4\)/,
      );
    });

    // …and a BIOS block transfer is the same bound through a call (`blockTransferCalls`): CpuSet
    // reads its source as far as a literal control word says and never writes through it. agbcc's
    // output for `vu16 a; vu32 b; a = x; CpuSet((void *)&a, gA, 0x01000010); b = y;
    // CpuSet((void *)&b, gB, 0x05000008);` — sa3's `CpuFill16` then `CpuFill32`.
    const cpuFills = (callee: string) =>
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr4, r1, #0\n\tlsl\tr0, r0, #0x10\n\tlsr\tr0, r0, #0x10\n' +
      '\tmov\tr1, sp\n\tstrh\tr0, [r1]\n\tldr\tr1, .L3\n\tldr\tr2, .L3+0x4\n\tmov\tr0, sp\n\tbl\tCpuSet\n' +
      `\tstr\tr4, [sp, #0x4]\n\tadd\tr0, sp, #0x4\n\tldr\tr1, .L3+0x8\n\tldr\tr2, .L3+0xc\n\tbl\t${callee}\n` +
      '\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n\t.word\tgA\n' +
      '\t.word\t0x1000010\n\t.word\tgB\n\t.word\t0x5000008\n';

    test('two CpuSet fills each read their own object, spelled as the fill macro spells it', () => {
      const src = decompile('f', cpuFills('CpuSet'), ARMV4T_AGBCC).source;
      expect(src).toContain('volatile u16 sp0;');
      expect(src).toContain('volatile u32 sp4;');
      expect(src).toContain('CpuSet(&sp4, &gB, 83886088);');
      // CONTROL: a callee the target names no extent for may write anything from the address
      expect(() => decompile('f', cpuFills('CpuSet2'), ARMV4T_AGBCC)).toThrow(
        /something outside this function reaches the whole frame/,
      );
    });

    test('a control word built at run time bounds nothing', () => {
      // `CpuSet((void *)&b, gB, 0x05000000 | y)`
      const runtime = cpuFills('CpuSet').replace(
        '\tldr\tr2, .L3+0xc\n',
        '\tmov\tr2, #0xa0\n\tlsl\tr2, r2, #0x13\n\torr\tr2, r2, r4\n',
      );
      expect(() => decompile('f', runtime, ARMV4T_AGBCC)).toThrow(
        /something outside this function reaches the whole frame/,
      );
    });

    test('a copy reads every unit it copies, past its own object', () => {
      // `CpuSet((void *)&a, gA, 4)`: four halfwords from [sp,#0], and `b` at [sp,#4] is two of them
      const copy = cpuFills('CpuSet').replace('\t.word\t0x1000010\n', '\t.word\t0x4\n');
      expect(() => decompile('f', copy, ARMV4T_AGBCC)).toThrow(
        /the captured address at \[sp,#0\) is passed to a callee, which may read the object at \[sp,#4\)/,
      );
      // CpuFastSet rounds a count of one word up to eight, so it reads the slot above
      const fast =
        'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x8\n\tlsl\tr0, r0, #0x10\n\tlsr\tr0, r0, #0x10\n\tmov\tr2, sp\n' +
        '\tstrh\tr0, [r2]\n\tstr\tr1, [sp, #0x4]\n\tldr\tr1, .L18\n\tmov\tr0, sp\n\tmov\tr2, #0x1\n\tbl\tCpuFastSet\n' +
        '\tadd\tsp, sp, #0x8\n\tpop\t{r0}\n\tbx\tr0\n.L19:\n\t.align\t2, 0\n.L18:\n\t.word\tgA\n';
      expect(() => decompile('f', fast, ARMV4T_AGBCC)).toThrow(/which may read the slot at \[sp,#4\]/);
    });

    test('a copy that reads past its object into a word nothing accounts for declines', () => {
      // `u16 buf[8]; buf[0] = x; CpuSet(buf, gDst, 8);`: sixteen bytes read, two of them declared
      const wide = (count: string) =>
        'r1:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x10\n\tmov\tr1, sp\n\tstrh\tr0, [r1]\n\tldr\tr1, .L3\n\tmov\tr0, sp\n' +
        `\tmov\tr2, #${count}\n\tbl\tCpuSet\n\tadd\tsp, sp, #0x10\n\tpop\t{r0}\n\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n` +
        '\t.word\tgDst\n';
      expect(() => decompile('r1', wide('0x8'), ARMV4T_AGBCC)).toThrow(
        /the word at \[sp,#4\] is neither an object this lift models nor a slot it keys, and the captured address reaches something that may read it/,
      );
      // CONTROL: two halfwords stay inside the object's own word, and the frame's other words are
      // read by nothing
      expect(decompile('r1', wide('0x2'), ARMV4T_AGBCC).source).toContain('CpuSet(&sp0, &gDst, 2);');
      // …and a DMA copy that increments from `buf` reads every word above it: `REG_DMA3SAD =
      // (u32)buf; REG_DMA3DAD = (u32)gDst; REG_DMA3CNT = 0x80000008;`
      const dma =
        'd1:\n\tadd\tsp, sp, #-0x10\n\tmov\tr1, sp\n\tstrh\tr0, [r1]\n\tldr\tr0, .L15\n\tstr\tr1, [r0]\n' +
        '\tldr\tr1, .L15+0x4\n\tldr\tr0, .L15+0x8\n\tstr\tr0, [r1]\n\tadd\tr1, r1, #0x4\n\tldr\tr0, .L15+0xc\n' +
        '\tstr\tr0, [r1]\n\tadd\tsp, sp, #0x10\n\tbx\tlr\n.L16:\n\t.align\t2, 0\n.L15:\n\t.word\t0x40000d4\n' +
        '\t.word\t0x40000d8\n\t.word\tgDst\n\t.word\t-0x7ffffff8\n';
      expect(() => decompile('d1', dma, ARMV4T_AGBCC)).toThrow(
        /the word at \[sp,#4\] is neither an object this lift models nor a slot it keys, and the captured address reaches something that may read it/,
      );
    });

    test('a frame address the transfer writes through is a writer, as any callee is', () => {
      // `CpuSet((void *)&a, (void *)&b, 0x01000002); CpuSet((void *)&b, gB, 0x05000008);`
      const asDest =
        'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tlsl\tr0, r0, #0x10\n\tlsr\tr0, r0, #0x10\n\tmov\tr2, sp\n' +
        '\tstrh\tr0, [r2]\n\tstr\tr1, [sp, #0x4]\n\tadd\tr4, sp, #0x4\n\tldr\tr2, .L21\n\tmov\tr0, sp\n' +
        '\tadd\tr1, r4, #0\n\tbl\tCpuSet\n\tldr\tr1, .L21+0x4\n\tldr\tr2, .L21+0x8\n\tadd\tr0, r4, #0\n\tbl\tCpuSet\n' +
        '\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n.L22:\n\t.align\t2, 0\n.L21:\n\t.word\t0x1000002\n' +
        '\t.word\tgB\n\t.word\t0x5000008\n';
      expect(() => decompile('f', asDest, ARMV4T_AGBCC)).toThrow(
        /something outside this function reaches the whole frame/,
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
    // `g` declared `void`: an object only READ here and taken at argument 0 is otherwise a struct
    // return's temp, which refuses first. A callee writer is held by keeping the frame as one
    // object in memory, where the reload reads what `g` wrote — so the rule is met where the
    // address is instead stored to a global that `g` may write through, and handed to no callee:
    // `gp = &s; g(&gp);`, a writer nothing declares.
    const voidG = { prototypes: { g: { params: 1, returnsVoid: true } } };
    const published = escaped.replace('\tmov\tr0, r4\n', '\tldr\tr0, .L9\n\tstr\tr4, [r0]\n') + '.L9:\n\t.word\tgPtr\n';
    expect(() => decompile('f', published, ARMV4T_AGBCC, voidG)).toThrow(
      /address-taken stack local — the captured address escapes/,
    );
    expect(decompile('f', escaped, ARMV4T_AGBCC, voidG).source).toContain(
      'if (v0 != 0) ((s32 *)sp0)[1] = v0;\n    return v0 + ((s32 *)sp0)[1];',
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
    for (const proto of [undefined, { g: { params: 2 } }]) {
      expect(() => decompile('f', twoStackArgs, ARMV4T_AGBCC, proto ? { prototypes: proto } : {})).toThrow(
        /stack pointer used as data/,
      );
    }
    // A declared pair that straddles the register/stack boundary takes r3 and [sp,#0], so its
    // block is one word, and the second staged word is one nothing declared.
    expect(() =>
      decompile('f', twoStackArgs, ARMV4T_AGBCC, {
        prototypes: { g: { params: ['s32', 's32', 's32', 'long long'] } },
      }),
    ).toThrow(/block is \[sp,#0\] — but \[sp,#4\] also reaches the call unread/);
    // A spelling nothing can size states no layout at all, so the declaration licenses nothing and
    // the verdict is the one this shape gets when nothing is declared — the sp-as-data decline
    // above. DECLARING MORE MAY NOT DO LESS, and it may not do more either.
    expect(() =>
      decompile('f', twoStackArgs, ARMV4T_AGBCC, {
        prototypes: { g: { params: ['s32', 's32', 's32', 's32', 'Direction'] } },
      }),
    ).toThrow(/stack pointer used as data/);
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
    // …but store [sp,#0] anywhere on a path to that call and the shape refuses on [sp,#0]: the
    // reload proves [sp,#4] a local, and [sp,#0] beneath it could still be argument 5
    const withBase =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tstr\tr1, [sp]\n\tstr\tr0, [sp, #0x4]\n\tbl\tg\n' +
      '\tldr\tr4, [sp, #0x4]\n\tadd\tr0, r4, #1\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('f', withBase, ARMV4T_AGBCC)).toThrow(/the store to \[sp,#0\] is never reloaded/);
    // …and a pending [sp,#0] alone always refuses — the prefix condition is vacuous at zero
    const base0 =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tbl\tg\n' +
      '\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('f', base0, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
  });

  test('a slot store reaching a call unread is judged by PATH, not by listing order', () => {
    // The store reaches `bl g` through one arm; the other arm's reload must not excuse it. Scanning
    // per block let a LABEL decide the verdict; scanning the flat listing let BLOCK ORDER decide,
    // because the reload in the first-listed arm cleared a store that reaches the call through the
    // second. Same CFG and same semantics either way, so both spellings must agree. They are judged
    // without agbcc's never-loaded claim: under it the reload in either arm proves [sp,#0] a local
    // (`loadedWordBound`), and both spellings lift alike.
    const unclaimed = {
      ...ARMV4T_AGBCC,
      compilerBehaviors: { ...ARMV4T_AGBCC.compilerBehaviors, outgoingAreaNeverLoadedFrom: undefined },
    };
    const loadArmFirst =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tcmp\tr0, #0\n\tbne\t.L3\n' +
      '.L2:\n\tldr\tr4, [sp]\n\tadd\tr0, r4, #1\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
      '.L3:\n\tbl\tg\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    const callArmFirst =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tcmp\tr0, #0\n\tbeq\t.L2\n' +
      '.L3:\n\tbl\tg\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
      '.L2:\n\tldr\tr4, [sp]\n\tadd\tr0, r4, #1\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('f', loadArmFirst, unclaimed)).toThrow(/stack pointer used as data/);
    expect(() => decompile('f', callArmFirst, unclaimed)).toThrow(/stack pointer used as data/);
    expect(decompile('f', loadArmFirst, ARMV4T_AGBCC).source).toContain('return g(a0);');
    expect(decompile('f', callArmFirst, ARMV4T_AGBCC).source).toContain('return g(a0);');
  });

  test('with no arity to prove it, a slot store may not reach a call unread', () => {
    // The fallback for a caller with no prototypes at all. It is calibration, not proof, so it is
    // deliberately conservative: a store reaching a call unread refuses whether or not a label
    // happens to sit in between. Making the scan block-local instead admitted the cross-block case,
    // where the accept/refuse boundary was a LABEL rather than anything semantic. The reload comes
    // after a RE-STORE, so the word read back is not the one that reached the call — which matters
    // only without agbcc's never-loaded claim: under it, any reload proves the word a local.
    const unclaimed = {
      ...ARMV4T_AGBCC,
      compilerBehaviors: { ...ARMV4T_AGBCC.compilerBehaviors, outgoingAreaNeverLoadedFrom: undefined },
    };
    const sameBlock =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tbl\tg\n\tstr\tr0, [sp]\n\tldr\tr4, [sp]\n' +
      '\tadd\tr0, r4, #1\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    const crossBlock =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tcmp\tr0, #0\n\tbeq\t.L2\n.L2:\n\tbl\tg\n' +
      '\tstr\tr0, [sp]\n\tldr\tr4, [sp]\n\tadd\tr0, r4, #1\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('f', sameBlock, unclaimed)).toThrow(/stack pointer used as data/);
    expect(() => decompile('f', crossBlock, unclaimed)).toThrow(/stack pointer used as data/);
    expect(decompile('f', sameBlock, ARMV4T_AGBCC).source).toBe('s32 f(s32 a0) {\n    return g(a0) + 1;\n}\n');
    expect(decompile('f', crossBlock, ARMV4T_AGBCC).source).toBe('s32 f(s32 a0) {\n    return g(a0) + 1;\n}\n');
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

  test('a slot read back AFTER the call held a value across it, so it is a local and no argument', () => {
    // agbcc's outgoing area is the callee's across a call — the caller re-stages an argument before
    // every call and never reads one back — and it sits below every local (thumb.h:573/600-622/628).
    const survives =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tbl\tg\n\tldr\tr4, [sp]\n' +
      '\tadd\tr0, r4, #1\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(decompile('f', survives, ARMV4T_AGBCC).source).toBe('s32 f(s32 a0) {\n    g(a0);\n    return a0 + 1;\n}\n');
    // a compiler that stages its arguments in its frame but claims only the after-call form, as
    // MIPS and mwcc do, keeps the refusal: the outgoing-area bound reads the never-loaded claim
    const unclaimed = {
      ...ARMV4T_AGBCC,
      compilerBehaviors: { ...ARMV4T_AGBCC.compilerBehaviors, outgoingAreaNeverLoadedFrom: undefined },
    };
    expect(unclaimed.compilerBehaviors.stagesOutgoingArgsInFrame).toBe(true);
    expect(() => decompile('f', survives, unclaimed)).toThrow(/it may be that call's outgoing stack argument/);
  });

  test('spill10, compiled: six spills around `callee(i)` are locals, and every one of them lifts', () => {
    // `synthetic:spill10:agbcc`'s own source, agbcc 2.9-arm-000512 at the row's flags. [sp,#0]..
    // [sp,#0x14] are stored before or inside the loop and reloaded after `bl callee`.
    const spill10 = [
      'spill10:',
      '\tpush\t{r4, r5, r6, r7, lr}',
      '\tmov\tr7, sl',
      '\tmov\tr6, r9',
      '\tmov\tr5, r8',
      '\tpush\t{r5, r6, r7}',
      '\tadd\tsp, sp, #-0x18',
      '\tmov\tsl, r0',
      '\tmov\tr0, #0x0',
      '\tstr\tr0, [sp, #0x8]',
      '\tldr\tr3, [r1]',
      '\tldr\tr0, [r1, #0x4]',
      '\tmov\tip, r0',
      '\tldr\tr0, [r1, #0x8]',
      '\tmov\tr9, r0',
      '\tldr\tr0, [r1, #0xc]',
      '\tstr\tr0, [sp]',
      '\tldr\tr0, [r1, #0x10]',
      '\tstr\tr0, [sp, #0x4]',
      '\tldr\tr0, [r1, #0x14]',
      '\tmov\tr8, r0',
      '\tldr\tr7, [r1, #0x18]',
      '\tldr\tr6, [r1, #0x1c]',
      '\tldr\tr4, [r1, #0x20]',
      '\tldr\tr2, [r1, #0x24]',
      '\tmov\tr5, #0x0',
      '\tldr\tr1, [sp, #0x8]',
      '\tcmp\tr1, sl',
      '\tbge\t.L4\t@cond_branch',
      '\tlsl\tr0, r3, #0x1',
      '\tadd\tr0, r0, r3',
      '\tstr\tr0, [sp, #0xc]',
      '\tmov\tr3, ip',
      '\tlsl\tr0, r3, #0x2',
      '\tadd\tr0, r0, ip',
      '\tstr\tr0, [sp, #0x10]',
      '.L6:',
      '\tadd\tr0, r5, #0',
      '\tstr\tr2, [sp, #0x14]',
      '\tbl\tcallee',
      '\tldr\tr1, [sp, #0xc]',
      '\tadd\tr0, r0, r1',
      '\tldr\tr3, [sp, #0x10]',
      '\tadd\tr0, r0, r3',
      '\tmov\tr3, r9',
      '\tlsl\tr1, r3, #0x3',
      '\tsub\tr1, r1, r3',
      '\tadd\tr0, r0, r1',
      '\tmov\tr1, #0xb',
      '\tldr\tr3, [sp]',
      '\tmul\tr1, r1, r3',
      '\tadd\tr0, r0, r1',
      '\tmov\tr1, #0xd',
      '\tldr\tr3, [sp, #0x4]',
      '\tmul\tr1, r1, r3',
      '\tadd\tr0, r0, r1',
      '\tmov\tr3, r8',
      '\tlsl\tr1, r3, #0x4',
      '\tadd\tr1, r1, r8',
      '\tadd\tr0, r0, r1',
      '\tlsl\tr1, r7, #0x2',
      '\tadd\tr1, r1, r7',
      '\tlsl\tr1, r1, #0x2',
      '\tsub\tr1, r1, r7',
      '\tadd\tr0, r0, r1',
      '\tlsl\tr1, r6, #0x1',
      '\tadd\tr1, r1, r6',
      '\tlsl\tr1, r1, #0x3',
      '\tsub\tr1, r1, r6',
      '\tadd\tr0, r0, r1',
      '\tlsl\tr1, r4, #0x3',
      '\tsub\tr1, r1, r4',
      '\tlsl\tr1, r1, #0x2',
      '\tadd\tr1, r1, r4',
      '\tadd\tr0, r0, r1',
      '\tldr\tr2, [sp, #0x14]',
      '\tlsl\tr1, r2, #0x5',
      '\tsub\tr1, r1, r2',
      '\tadd\tr0, r0, r1',
      '\tldr\tr1, [sp, #0x8]',
      '\tadd\tr1, r1, r0',
      '\tstr\tr1, [sp, #0x8]',
      '\tadd\tr5, r5, #0x1',
      '\tcmp\tr5, sl',
      '\tblt\t.L6\t@cond_branch',
      '.L4:',
      '\tldr\tr0, [sp, #0x8]',
      '\tadd\tsp, sp, #0x18',
      '\tpop\t{r3, r4, r5}',
      '\tmov\tr8, r3',
      '\tmov\tr9, r4',
      '\tmov\tsl, r5',
      '\tpop\t{r4, r5, r6, r7}',
      '\tpop\t{r1}',
      '\tbx\tr1',
    ].join('\n');
    const src = decompile('spill10', `${spill10}\n`, ARMV4T_AGBCC, { prototypes: { callee: { params: 1 } } }).source;
    expect(src).toContain('callee(');
    for (let k = 1; k <= 9; k++) {
      expect(src).toContain(`a1[${k}]`);
    }
  });

  test('a spill that outlives a LICENSED call is not a word that call takes', () => {
    // agbcc's own output for `int mixed(int k, int *p)`: `s += five(i, 1, 2, 3, v0) + one(i) + …`
    // over ten live values. Argument 5 is staged at [sp,#0] before every `bl five`; the spills sit
    // above it at [sp,#4]..[sp,#0x20], several reaching the call unread and reloaded after it.
    const mixed = [
      'mixed:',
      '\tpush\t{r4, r5, r6, r7, lr}',
      '\tmov\tr7, sl',
      '\tmov\tr6, r9',
      '\tmov\tr5, r8',
      '\tpush\t{r5, r6, r7}',
      '\tadd\tsp, sp, #-0x24',
      '\tstr\tr0, [sp, #0x4]',
      '\tmov\tr0, #0x0',
      '\tstr\tr0, [sp, #0x18]',
      '\tldr\tr0, [r1]',
      '\tstr\tr0, [sp, #0x8]',
      '\tldr\tr2, [r1, #0x4]',
      '\tldr\tr0, [r1, #0x8]',
      '\tstr\tr0, [sp, #0xc]',
      '\tldr\tr0, [r1, #0xc]',
      '\tstr\tr0, [sp, #0x10]',
      '\tldr\tr0, [r1, #0x10]',
      '\tstr\tr0, [sp, #0x14]',
      '\tldr\tr0, [r1, #0x14]',
      '\tmov\tsl, r0',
      '\tldr\tr0, [r1, #0x18]',
      '\tmov\tr8, r0',
      '\tldr\tr7, [r1, #0x1c]',
      '\tldr\tr6, [r1, #0x20]',
      '\tldr\tr1, [r1, #0x24]',
      '\tmov\tr9, r1',
      '\tmov\tr5, #0x0',
      '\tldr\tr1, [sp, #0x18]',
      '\tldr\tr0, [sp, #0x4]',
      '\tcmp\tr1, r0',
      '\tbge\t.L4\t@cond_branch',
      '\tldr\tr1, [sp, #0x8]',
      '\tlsl\tr0, r1, #0x1',
      '\tadd\tr0, r0, r1',
      '\tstr\tr0, [sp, #0x1c]',
      '\tlsl\tr0, r2, #0x2',
      '\tadd\tr0, r0, r2',
      '\tstr\tr0, [sp, #0x20]',
      '.L6:',
      '\tldr\tr0, [sp, #0x8]',
      '\tstr\tr0, [sp]',
      '\tadd\tr0, r5, #0',
      '\tmov\tr1, #0x1',
      '\tmov\tr2, #0x2',
      '\tmov\tr3, #0x3',
      '\tbl\tfive',
      '\tadd\tr4, r0, #0',
      '\tadd\tr0, r5, #0',
      '\tbl\tone',
      '\tadd\tr4, r4, r0',
      '\tldr\tr1, [sp, #0x1c]',
      '\tadd\tr4, r4, r1',
      '\tldr\tr0, [sp, #0x20]',
      '\tadd\tr4, r4, r0',
      '\tldr\tr1, [sp, #0xc]',
      '\tlsl\tr0, r1, #0x3',
      '\tsub\tr0, r0, r1',
      '\tadd\tr4, r4, r0',
      '\tmov\tr0, #0xb',
      '\tldr\tr1, [sp, #0x10]',
      '\tmul\tr0, r0, r1',
      '\tadd\tr4, r4, r0',
      '\tmov\tr0, #0xd',
      '\tldr\tr1, [sp, #0x14]',
      '\tmul\tr0, r0, r1',
      '\tadd\tr4, r4, r0',
      '\tmov\tr1, sl',
      '\tlsl\tr0, r1, #0x4',
      '\tadd\tr0, r0, sl',
      '\tadd\tr4, r4, r0',
      '\tmov\tr1, r8',
      '\tlsl\tr0, r1, #0x2',
      '\tadd\tr0, r0, r8',
      '\tlsl\tr0, r0, #0x2',
      '\tsub\tr0, r0, r1',
      '\tadd\tr4, r4, r0',
      '\tlsl\tr0, r7, #0x1',
      '\tadd\tr0, r0, r7',
      '\tlsl\tr0, r0, #0x3',
      '\tsub\tr0, r0, r7',
      '\tadd\tr4, r4, r0',
      '\tlsl\tr0, r6, #0x3',
      '\tsub\tr0, r0, r6',
      '\tlsl\tr0, r0, #0x2',
      '\tadd\tr0, r0, r6',
      '\tadd\tr4, r4, r0',
      '\tmov\tr1, r9',
      '\tlsl\tr0, r1, #0x5',
      '\tsub\tr0, r0, r1',
      '\tadd\tr4, r4, r0',
      '\tldr\tr0, [sp, #0x18]',
      '\tadd\tr0, r0, r4',
      '\tstr\tr0, [sp, #0x18]',
      '\tadd\tr5, r5, #0x1',
      '\tldr\tr1, [sp, #0x4]',
      '\tcmp\tr5, r1',
      '\tblt\t.L6\t@cond_branch',
      '.L4:',
      '\tldr\tr0, [sp, #0x18]',
      '\tadd\tsp, sp, #0x24',
      '\tpop\t{r3, r4, r5}',
      '\tmov\tr8, r3',
      '\tmov\tr9, r4',
      '\tmov\tsl, r5',
      '\tpop\t{r4, r5, r6, r7}',
      '\tpop\t{r1}',
      '\tbx\tr1',
    ].join('\n');
    const prototypes = { five: { params: 5 }, one: { params: 1 } };
    const src = decompile('mixed', `${mixed}\n`, ARMV4T_AGBCC, { prototypes }).source;
    expect(src).toMatch(/five\(v\d+, 1, 2, 3, v0\)/);
    // a declaration that claims the survivor at [sp,#4] as argument 6 contradicts it, and refuses
    expect(() =>
      decompile('mixed', `${mixed}\n`, ARMV4T_AGBCC, { prototypes: { ...prototypes, five: { params: 6 } } }),
    ).toThrow(/stack pointer used as data/);
  });

  test('a tail-merged call site sets its stack argument up in BOTH predecessors', () => {
    // agbcc really does hoist argument setup out of the calling block: sa3's Task_BonusFlower_Spawn
    // tail-merges two call sites, so argument 5 is stored in both predecessors with the `bl` in the
    // join. A per-block scan does not see that at all, and the store became a dead local with the
    // argument dropped from the call. The scan runs over the whole listing for this reason.
    const tailMerged =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tcmp\tr0, #0\n\tbeq\t.L2\n\tldr\tr2, .LP\n\tstr\tr2, [sp]\n\tb\t.L3\n' +
      '.L2:\n\tldr\tr2, .LP\n\tstr\tr2, [sp]\n.L3:\n\tbl\tg\n' +
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

  // A COMPUTED CAPTURE IS A CAPTURE. `add rD, sp, #k` names a fixed frame offset, and `add rD, sp,
  // rX` (or the two-operand `add rD, sp`) is agbcc's one-instruction spelling of a runtime index
  // into the frame — the same address as `mov rB, sp / add rD, rB, rX`, lowered to the same IR, so
  // one audit rule judges both spellings.
  test('each computed capture is the capture it spells', () => {
    const frame = (capture: string) =>
      `f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n${capture}\tldrb\tr0, [r4]\n` +
      '\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    // the constant form is a capture at that offset
    expect(() => decompile('f', frame('\tadd\tr4, sp, #0x4\n'), ARMV4T_AGBCC)).not.toThrow();
    // There is no SIGNED row here and the reason is at the predicate: Thumb-1 ADD(6) has no
    // negative form, the assembler refuses `add r4, sp, #-0x4`, and the one negative spelling
    // agbcc does write has sp as its destination and never reaches this guard. A row for it would
    // be a row for an input no assembler accepts.
    // the runtime forms are the frame base plus the index, whichever operand holds sp
    const twoInsn = decompile('f', frame('\tmov\tr2, sp\n\tadd\tr4, r2, r1\n'), ARMV4T_AGBCC).source;
    expect(twoInsn).toContain('((u8 *)sp0)[a1]');
    for (const oneInsn of ['\tadd\tr4, sp, r1\n', '\tadd\tr4, r1, sp\n', '\tadd\tr4, r1, #0\n\tadd\tr4, sp\n']) {
      expect(decompile('f', frame(oneInsn), ARMV4T_AGBCC).source).toBe(twoInsn);
    }
    // An immediate the constant form cannot evaluate is not the runtime form's register: read as
    // one, `#(4)` is an entry parameter and the load `sp0[a0]`.
    for (const imm of ['#(4)', '#OFF']) {
      expect(() => decompile('f', `\t.set\tOFF, 4\n${frame(`\tadd\tr4, sp, ${imm}\n`)}`, ARMV4T_AGBCC)).toThrow(
        `operand '${imm}' read as a register`,
      );
    }
  });

  // A RUNTIME INDEX MOVED BY A CONSTANT REGISTER. Thumb has no `ldrsb`/`ldrsh` with an immediate,
  // so agbcc loads the whole displacement into a register (thumb.md:411-505): `s8 a[64]; … a[i]`
  // is `mov r1, sp / add r0, r1, r4 / mov r1, #0x0 / ldrsb r1, [r0, r1]`, lowered as `add` +
  // load@0. Displacement 0 is the indexed element and stays signed; any other moves the index to
  // the bytes at that displacement (`foldMovedCaptures`), which the frame rules then judge; and a
  // moved sum that escapes still refuses by its role.
  test('a runtime index moved by a constant register is judged at the displacement it lands on', () => {
    const frame = (access: string) =>
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x40\n\tadd\tr4, r0, #0\n\tmov\tr0, sp\n\tbl\tfill\n' +
      `\tmov\tr1, sp\n\tadd\tr0, r1, r4\n${access}\tadd\tsp, sp, #0x40\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n`;
    const opts = { prototypes: { fill: { params: ['void *'], returnsVoid: true }, f: { params: ['s32'] } } };
    const byte = decompile('f', frame('\tmov\tr1, #0x0\n\tldrsb\tr0, [r0, r1]\n'), ARMV4T_AGBCC, opts).source;
    expect(byte).toContain('u8 sp0[64];');
    expect(byte).toMatch(/return \*\(s8 \*\)\(\(u32\)sp0 \+ a0( \+ 0)?\);/);
    const half = decompile('f', frame('\tmov\tr1, #0x0\n\tldrsh\tr0, [r0, r1]\n'), ARMV4T_AGBCC, opts).source;
    expect(half).toMatch(/return \*\(s16 \*\)\(\(u32\)sp0 \+ a0( \+ 0)?\);/);
    // a nonzero literal is an index into the bytes at [sp,#k) (`foldMovedCaptures`), here beside
    // the escaping object at [sp,#0), so the frame is one object and the extension is kept
    for (const [access, spelled] of [
      ['\tmov\tr1, #0x3\n\tldrsb\tr0, [r0, r1]\n', 'return *(s8 *)((u32)sp0 + 3 + a0);'],
      ['\tmov\tr1, #0x2\n\tldrsh\tr0, [r0, r1]\n', 'return *(s16 *)((u32)sp0 + 2 + a0);'],
    ] as const) {
      const moved = decompile('f', frame(access), ARMV4T_AGBCC, opts).source;
      expect(moved).toContain('u8 sp0[64];');
      expect(moved).toContain(spelled);
    }
    // one literal move deep, as agbcc emits it: a second move is not walked, even a zero one
    const twice = frame('\tmov\tr1, #0x0\n\tadd\tr0, r0, r1\n\tmov\tr1, #0x0\n\tldrsb\tr0, [r0, r1]\n');
    expect(() => decompile('f', twice, ARMV4T_AGBCC, opts)).toThrow(
      'a runtime index into the object at [sp,#0) flows into `add`',
    );
    // the moved sum handed to a call escapes, and refuses as the call
    const escape = frame('\tmov\tr1, #0x0\n\tadd\tr0, r0, r1\n\tbl\tfill\n\tmov\tr0, #0x0\n');
    expect(() => decompile('f', escape, ARMV4T_AGBCC, opts)).toThrow(
      'a runtime index into the object at [sp,#0) flows into `call`',
    );
  });

  // AN INDEX MOVED BY A LITERAL `add` NAMES THE OBJECT AT THE SUM. agbcc's `a[i]` on a local
  // above a 5-argument call's outgoing word is the frame base plus the index, moved after
  // (`u16 a[8]; fill(a); five(1, 2, 3, 4, a[i]);`, compiled at the corpus flags): the index is into
  // the array at [sp,#4), not a field of an element of whatever sits at [sp,#0). A load displaced
  // through it, by its immediate or by agbcc's literal register, indexes the bytes it lands on.
  test('a runtime index moved by a literal add indexes the object at the sum', () => {
    const frame = (access: string) =>
      'r1:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x14\n\tadd\tr4, r0, #0\n\tadd\tr0, sp, #0x4\n\tbl\tfill\n' +
      `\tlsl\tr4, r4, #0x1\n\tmov\tr0, sp\n\tadd\tr0, r0, r4\n\tadd\tr0, r0, #0x4\n${access}\tstr\tr0, [sp]\n` +
      '\tmov\tr0, #0x1\n\tmov\tr1, #0x2\n\tmov\tr2, #0x3\n\tmov\tr3, #0x4\n\tbl\tfive\n' +
      '\tadd\tsp, sp, #0x14\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n';
    const opts = {
      prototypes: {
        fill: { params: ['void *'], returnsVoid: true },
        five: { params: ['s32', 's32', 's32', 's32', 's32'], returnsVoid: true },
        r1: { params: ['u32'], returnsVoid: true },
      },
    };
    const element = decompile('r1', frame('\tldrh\tr0, [r0]\n'), ARMV4T_AGBCC, opts).source;
    expect(element).toContain('u8 sp4[16];');
    expect(element).toContain('five(1, 2, 3, 4, ((u16 *)sp4)[a0]);');
    // the same index read signed, through agbcc's literal register, stays signed
    const signed = decompile('r1', frame('\tmov\tr1, #0x0\n\tldrsh\tr0, [r0, r1]\n'), ARMV4T_AGBCC, opts).source;
    expect(signed).toMatch(/five\(1, 2, 3, 4, \*\(s16 \*\)\(\(u32\)sp4 \+ \(a0 << 1\)( \+ 0)?\)\);/);
    // a displaced access reaches the same bytes whether the literal sits in the load's immediate
    // or in agbcc's register, so both are the index into the bytes at [sp,#5), each with its own
    // extension
    const unsigned = decompile('r1', frame('\tldrb\tr0, [r0, #0x1]\n'), ARMV4T_AGBCC, opts).source;
    expect(unsigned).toContain('u8 sp4[16];');
    expect(unsigned).toContain('five(1, 2, 3, 4, *(u8 *)((u32)sp4 + 1 + (a0 << 1)));');
    const viaRegister = decompile('r1', frame('\tmov\tr1, #0x1\n\tldrsb\tr0, [r0, r1]\n'), ARMV4T_AGBCC, opts);
    expect(viaRegister.source).toContain('five(1, 2, 3, 4, *(s8 *)((u32)sp4 + 1 + (a0 << 1)));');
  });

  // THE MOVE DOES NOT DEPEND ON BLOCK ORDER. The sum and the access through it are in two blocks,
  // and the block that reads the sum is laid out first: the fold reaches a fixpoint, so the use is
  // moved as it is when the sum comes first.
  test('a runtime index moved in a block laid out before its sum is moved the same', () => {
    const head = 'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x40\n\tadd\tr4, r0, #0\n\tmov\tr0, sp\n\tbl\tfill\n';
    const sum = '\tmov\tr1, sp\n\tadd\tr0, r1, r4\n';
    const use = '\tmov\tr1, #0x3\n\tldrsb\tr0, [r0, r1]\n\tadd\tsp, sp, #0x40\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    const opts = {
      prototypes: { fill: { params: ['void *'], returnsVoid: true }, f: { params: ['s32'], returns: 's32' } },
    };
    const inOrder = decompile('f', `${head}${sum}${use}`, ARMV4T_AGBCC, opts).source;
    const useFirst = decompile('f', `${head}\tb\t.Lsum\n.Luse:\n${use}.Lsum:\n${sum}\tb\t.Luse\n`, ARMV4T_AGBCC, opts);
    expect(inOrder).toContain('return *(s8 *)((u32)sp0 + 3 + a0);');
    expect(useFirst.source).toContain('return *(s8 *)((u32)sp0 + 3 + a0);');
  });

  // WHAT THE BENCHMARK ACTUALLY SLICES is the diagnostic's REASON, and the stage word is prepended
  // AFTERWARDS: `errorMarkers: dec.diagnostics.map((d) => `${d.stage}: ${firstLine(d.reason)}`)`,
  // where `firstLine` is `s.split('\n')[0].slice(0, 200)`. So a published marker runs to 206 for a
  // `lift:` diagnostic, and the budget a message has is 200 for the message alone. `packages/core`
  // cannot import from `apps/`, so both facts are copied here with the command that re-reads them:
  //   command grep -n 'slice(0, ' -B8 apps/benchmark/src/eval/asmlift.ts
  const REASON_CHARS = 200;

  // AND THE BUDGET IS NOT MET BY EVERY SYMBOL, which is the thing worth pinning rather than one
  // instance that happens to fit. The message carries the function's NAME and the instruction's
  // text, so its length is the caller's as much as this file's. Measured across the agbcc rows in
  // the artifact, the longest symbol is 37 characters:
  //   python3 -c "import json;a=json.load(open('apps/benchmark/results/results.json'));\
  //     print(max((r['id'].split(':')[1] for r in a['results'] if r['id'].endswith(':agbcc')),key=len))"
  // and at that name the runtime refusal's reason loses its last few characters in the artifact.
  // That is acceptable and it is why the assertion below is about CONTENT and not length: both
  // readers of a marker look at the front of it. The class pattern (`apps/web/.../declines.ts`)
  // matches the opening phrase, and the word saying which gap this is comes next. What must never
  // be true is a marker whose deciding word is cut off, so the bound is on where that word ENDS,
  // with 20 characters of margin, rather than on a total length no caller controls.
  const LONGEST_AGBCC_SYMBOL = 'VisionSelectUpdateRotationAndEntities';

  test('the runtime-index refusal survives the slice the artifact applies', () => {
    const [arm, capture] = ['runtime index', '\tadd\tr0, sp, r1\n'];
    const sym = LONGEST_AGBCC_SYMBOL;
    const worst =
      `${sym}:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n${capture}\tstr\tr1, [r0]\n` +
      '\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    let reason = '';
    try {
      decompile(sym, worst, ARMV4T_AGBCC);
    } catch (e) {
      reason = (e as Error).message.split('\n')[0];
    }
    const sliced = reason.slice(0, REASON_CHARS);
    // the class phrase and the arm word both survive, with the margin stated so a rewording that
    // eats it is a red test rather than a silently truncated marker
    expect(sliced).toContain('address-taken stack local');
    expect(sliced).toContain(arm);
    expect(sliced.indexOf(arm) + arm.length).toBeLessThanOrEqual(REASON_CHARS - 20);
  });

  test('a refused function names the capability actually missing', () => {
    // The gap histogram is the improvement loop's work-list; "local stack frames not supported" was
    // a false attribution that sent the loop to build a thing that already works. Each blocker now
    // names itself. The generic message survives only for sp uses no sub-family claims.
    // (the `mov rD, sp`, `add rD, sp, #k` and `add rD, sp, rX` captures are the laddr capability —
    // their refusals carry their own attributed messages, from the frame-object audit)
    const addrComputed =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr4, sp, r1\n\tstrh\tr0, [r4]\n\tstr\tr0, [r4]\n' +
      '\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('f', addrComputed, ARMV4T_AGBCC)).toThrow(
      /address-taken stack local — a runtime index into the bytes \[sp,#0\) to \[sp,#8\) kept as one object accesses 2 and 4 bytes wide/,
    );
    const outgoing =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tbl\tg\n' +
      '\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('f', outgoing, ARMV4T_AGBCC)).toThrow(/outgoing stack argument/);
    const arity =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tldr\tr4, [sp]\n\tbl\tg\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => decompile('f', arity, ARMV4T_AGBCC, { prototypes: { g: { params: 5 } } })).toThrow(
      /declared with 5 arguments/,
    );
    // every attributed sp message keeps the class prefix, so nothing keyed on it breaks
    expect(() => decompile('f', outgoing, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
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

    // …and the evidence for all of it is an agbcc compile table, so the gate asks for the layout
    // to be DECLARED — `compilerBehaviors.oneWordFrameIsTheCapturedObject`, a field and not a
    // `compiler ==` branch. `armv4t` has one compiler entry today; a second one free to overlay a
    // dead one-word local with a one-word outgoing area has to run the tables and say so.
    // (and so must the escape premise, which explains the same store on its own)
    const {
      oneWordFrameIsTheCapturedObject: _unprobed,
      escapedFrameAddressNamesALocal: _unprobedEscape,
      ...unprobedBehaviors
    } = ARMV4T_AGBCC.compilerBehaviors;
    const undeclared = { ...ARMV4T_AGBCC, compiler: 'sdt', compilerBehaviors: unprobedBehaviors };

    // The table is needed only where a call MAY take a stack word: with `use` undeclared, a
    // compiler that has not run it gets no proof. With `use` declared to take its one word in a
    // register no call takes a stack word, so there is no outgoing area to overlay on any compiler,
    // and the escaping frame base is a local's address without either premise (thumb.ts, beside
    // `noCallTakesAStackWord`).
    test('an armv4t compiler that has not declared the layout does not get the proof', () => {
      expect(() => decompile('f', addrTaken, undeclared)).toThrow(/never reloaded/);
      expect(decompile('f', addrTaken, ARMV4T_AGBCC).source).toContain('use(&sp0, ');
      expect(decompile('f', addrTaken, undeclared, { prototypes: { use: { params: 1 } } }).source).toContain(
        'use(&sp0);',
      );
    });

    // THE PIN THE PROOF RESTS ON. With a five-argument call in the same function, agbcc stages
    // argument 5 at [sp,#0] and the address-taken local moves ABOVE it — so `&w` is COMPUTED and
    // there is no bare `mov rD, sp` anywhere. Compiled, `void f(u32 i, s32 a, s32 b){ s32 w;
    // w = gEnts[i].h; five(a,b,a+b,a-b,a*b); use(&w); }` is this, verbatim. A frame with a genuine
    // outgoing area must keep declining, and it does — on the argument itself, since `five` is
    // declared nowhere.
    test('a frame with a GENUINE outgoing argument area still declines', () => {
      const withArea =
        'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr4, r2, #0\n\tlsl\tr2, r0, #0x2\n\tadd\tr2, r2, r0\n' +
        '\tlsl\tr2, r2, #0x2\n\tldr\tr0, .L6\n\tadd\tr2, r2, r0\n\tldrh\tr0, [r2, #0x12]\n\tstr\tr0, [sp, #0x4]\n' +
        '\tadd\tr2, r1, r4\n\tsub\tr3, r1, r4\n\tmov\tr0, r1\n\tmul\tr0, r0, r4\n\tstr\tr0, [sp]\n' +
        '\tadd\tr0, r1, #0\n\tadd\tr1, r4, #0\n\tbl\tfive\n\tadd\tr0, sp, #0x4\n\tbl\tuse\n' +
        '\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n.L7:\n\t.align\t2, 0\n.L6:\n\t.word\t0x8057acc\n';
      expect(() => decompile('f', withArea, ARMV4T_AGBCC)).toThrow(/stack pointer used as data/);
      expect(() => decompile('f', withArea, ARMV4T_AGBCC)).toThrow(/it may be an outgoing stack argument/);
    });

    // …and with the call DECLARED, the block is licensed and the local above it is the object its
    // computed address names. agbcc's own output for `s32 f(s32 a, s32 b){ u16 h; five(a, b, a, b,
    // a); geth(&h); return h; }`, at the corpus's flags.
    test('a local above a licensed outgoing block is the object `add rD, sp, #k` names', () => {
      const above =
        'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr2, r0, #0\n\tadd\tr3, r1, #0\n\tstr\tr2, [sp]\n' +
        '\tbl\tfive\n\tadd\tr0, sp, #0x4\n\tbl\tgeth\n\tadd\tr0, sp, #0x4\n\tldrh\tr0, [r0]\n' +
        '\tadd\tsp, sp, #0x8\n\tpop\t{r1}\n\tbx\tr1\n';
      const prototypes = {
        five: { params: ['s32', 's32', 's32', 's32', 's32'], returnsVoid: true },
        geth: { params: ['u16 *'], returnsVoid: true },
      };
      expect(decompile('f', above, ARMV4T_AGBCC, { prototypes }).source).toBe(
        's32 f(s32 a0, s32 a1) {\n    u16 sp4;\n    five(a0, a1, a0, a1, a0);\n    geth(&sp4);\n    return sp4;\n}\n',
      );
    });

    // …and a WORD local there is stored with `str rX, [sp, #0x4]`, which the slot model would key
    // as an SSA slot and the outgoing-argument analysis would read as a sixth staged argument. The
    // capture names it, so it is the object. agbcc's own output for `void f(s32 a, s32 b){ s32 w;
    // five(a, b, a, b, a); w = b; getw(&w); five(w, a, a, a, a); }`, at the corpus's flags.
    describe('a word the capture names is the object at every access', () => {
      const word = (capture: string) =>
        'f:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr4, r0, #0\n\tadd\tr5, r1, #0\n' +
        '\tstr\tr4, [sp]\n\tadd\tr2, r4, #0\n\tadd\tr3, r5, #0\n\tbl\tfive\n\tstr\tr5, [sp, #0x4]\n' +
        `${capture}\tbl\tgetw\n\tldr\tr0, [sp, #0x4]\n\tstr\tr4, [sp]\n\tadd\tr1, r4, #0\n` +
        '\tadd\tr2, r4, #0\n\tadd\tr3, r4, #0\n\tbl\tfive\n\tadd\tsp, sp, #0x8\n\tpop\t{r4, r5}\n' +
        '\tpop\t{r0}\n\tbx\tr0\n';
      const prototypes = {
        five: { params: ['s32', 's32', 's32', 's32', 's32'], returnsVoid: true },
        getw: { params: ['s32 *'], returnsVoid: true },
      };

      test('the store, the capture and the reload are one local', () => {
        expect(decompile('f', word('\tadd\tr0, sp, #0x4\n'), ARMV4T_AGBCC, { prototypes }).source).toBe(
          'void f(s32 a0, s32 a1) {\n    s32 sp4;\n    five(a0, a1, a0, a1, a0);\n    sp4 = a1;\n    getw(&sp4);\n' +
            '    five(sp4, a0, a0, a0, a0);\n}\n',
        );
      });

      // TWO SPELLINGS OF ONE COPY MUST NOT GIVE TWO VERDICTS: the offsets set aside for the object
      // and the capture the lift folds come off one walk (`heldFrameWalk`), so a register copy or
      // a move is the same capture whichever way it is written.
      test.each([
        ['a register copy', '\tmov\tr0, sp\n\tmov\tr1, r0\n\tadd\tr0, r1, #0x4\n'],
        ["agbcc's copy idiom", '\tmov\tr0, sp\n\tadd\tr1, r0, #0\n\tadd\tr0, r1, #0x4\n'],
        ['a two-operand move', '\tmov\tr0, sp\n\tadd\tr0, #0x4\n'],
      ])('%s is the same capture', (_, capture) => {
        expect(decompile('f', word(capture), ARMV4T_AGBCC, { prototypes }).source).toBe(
          decompile('f', word('\tadd\tr0, sp, #0x4\n'), ARMV4T_AGBCC, { prototypes }).source,
        );
      });
    });

    // …and a value that is one object on one path and another on the other names neither. agbcc's
    // own output for `s32 a, b; five(x, y, x, y, x); a = x; b = y; return get(c ? &a : &b);`.
    test('a phi of two objects refuses', () => {
      const select =
        'f:\n\tpush\t{r4, r5, r6, lr}\n\tadd\tsp, sp, #-0xc\n\tadd\tr4, r0, #0\n\tadd\tr5, r1, #0\n' +
        '\tadd\tr6, r2, #0\n\tstr\tr4, [sp]\n\tadd\tr2, r4, #0\n\tadd\tr3, r5, #0\n\tbl\tfive\n' +
        '\tstr\tr4, [sp, #0x8]\n\tstr\tr5, [sp, #0x4]\n\tadd\tr0, sp, #0x4\n\tcmp\tr6, #0\n\tbeq\t.L3\n' +
        '\tadd\tr0, sp, #0x8\n.L3:\n\tbl\tget\n\tadd\tsp, sp, #0xc\n\tpop\t{r4, r5, r6}\n\tpop\t{r1}\n\tbx\tr1\n';
      const prototypes = {
        five: { params: ['s32', 's32', 's32', 's32', 's32'], returnsVoid: true },
        get: { params: ['const s32 *'], returns: 's32' },
      };
      expect(() => decompile('f', select, ARMV4T_AGBCC, { prototypes })).toThrow(
        /a phi merges the frame objects at \[sp,#4\] and \[sp,#8\] — one value, two objects/,
      );
    });

    // A MOVE THE WALK DOES NOT FOLLOW IS STILL THE CAPTURE AT THE SUM, because the IR holds the
    // constant exactly: the register-offset spelling sa3's `sub_807A2AC` uses, `mov r0, sp / movs
    // r2, #4 / ldrsh r0, [r0, r2]`, is the object `add r0, sp, #4 / ldrsh r0, [r0]` names.
    test('a capture moved by a constant held in a register is the capture at the sum', () => {
      const half = (store: string, load: string) =>
        `f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x8\n${store}\tbl\tg\n${load}\tadd\tsp, sp, #0x8\n\tpop\t{r1}\n\tbx\tr1\n`;
      const g = { params: 0, returnsVoid: true };
      const byRegister = decompile(
        'f',
        half(
          '\tmov\tr1, sp\n\tmovs\tr2, #4\n\tstrh\tr0, [r1, r2]\n',
          '\tmov\tr0, sp\n\tmovs\tr2, #4\n\tldrsh\tr0, [r0, r2]\n',
        ),
        ARMV4T_AGBCC,
        { prototypes: { g } },
      ).source;
      expect(byRegister).toBe(
        decompile(
          'f',
          half('\tadd\tr1, sp, #4\n\tstrh\tr0, [r1]\n', '\tadd\tr0, sp, #4\n\tldrsh\tr0, [r0]\n'),
          ARMV4T_AGBCC,
          {
            prototypes: { g },
          },
        ).source,
      );
      expect(byRegister).toContain('s16 sp4;');
    });

    // …but the walk is what routes a `[sp,#k]` word to the object rather than to a slot, so a move
    // it cannot follow — the capture in one block, the move in the next — that lands on a keyed
    // slot is refused by that name, not as the slot overlap alone.
    test('a capture moved in another block is refused as the move', () => {
      const crossBlock =
        'f:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0xc\n\tadd\tr4, r0, #0\n\tmov\tr5, sp\n' +
        '\tstr\tr4, [sp, #0x8]\n\tcmp\tr1, #0\n\tbeq\t.L2\n\tadd\tr5, r5, #0x8\n\tadd\tr0, r5, #0\n' +
        '\tbl\tget\n\tb\t.L3\n.L2:\n\tadd\tr0, r5, #0x8\n\tbl\tget\n.L3:\n\tadd\tsp, sp, #0xc\n' +
        '\tpop\t{r4, r5}\n\tpop\t{r1}\n\tbx\tr1\n';
      // `get` with nothing said of its return: a callee that may take a hidden return pointer at
      // argument 0 is a writer the one-object answer cannot hold, so the per-object refusal stands
      const get = { params: ['const s32 *'] };
      expect(() => decompile('f', crossBlock, ARMV4T_AGBCC, { prototypes: { get } })).toThrow(
        /the capture moved by a constant to \[sp,#8\) is a move the pre-lift walk does not follow, so the slot model keys \[sp,#8\] too/,
      );
      // …declared, it is one, and the moved capture is an address inside the one object
      const declared = { get: { ...get, returns: 's32' } };
      expect(decompile('f', crossBlock, ARMV4T_AGBCC, { prototypes: declared }).source).toContain('get((u32)sp0 + 8)');
    });

    // …and a pointer a phi carries around a loop, stepped by a constant each trip (sa3's
    // `sub_80B59E4`), names a different byte on each: no fold makes it one object.
    test('a capture stepped around a loop is refused as the stepped pointer', () => {
      const stepped =
        'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x8\n\tmov\tr1, sp\n\tmovs\tr2, #0\n.L1:\n\tstrb\tr2, [r1]\n' +
        '\tadds\tr1, #1\n\tadds\tr2, #1\n\tcmp\tr2, #8\n\tblt\t.L1\n\tmov\tr0, sp\n\tbl\tg\n\tadd\tsp, sp, #0x8\n' +
        '\tpop\t{r1}\n\tbx\tr1\n';
      expect(() =>
        decompile('f', stepped, ARMV4T_AGBCC, { prototypes: { g: { params: 1, returnsVoid: true } } }),
      ).toThrow('the captured address at [sp,#0) reaches a phi and is then moved by a constant');
    });

    // …but a phi that merges the capture with a PARAMETER steps nothing: agbcc's own output for
    // `u32 known(struct Info *info, u32 i){ struct Info local; if (!info) { info = &local;
    // ReadInfo(info); } return info->bits[i]; }` (FE7J's `GGM_IsCharacterKnown` shape).
    test('a capture merged with a parameter and then moved is refused as the merge', () => {
      const merged =
        'known:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x48\n\tadd\tr4, r0, #0\n\tadd\tr5, r1, #0\n' +
        '\tcmp\tr4, #0\n\tbne\t.L3\n\tmov\tr4, sp\n\tmov\tr0, sp\n\tbl\tReadInfo\n.L3:\n\tadd\tr0, r4, #0\n' +
        '\tadd\tr0, r0, #0x40\n\tadd\tr0, r0, r5\n\tldrb\tr0, [r0]\n\tadd\tsp, sp, #0x48\n\tpop\t{r4, r5}\n' +
        '\tpop\t{r1}\n\tbx\tr1\n';
      expect(() =>
        decompile('known', merged, ARMV4T_AGBCC, { prototypes: { ReadInfo: { params: 1, returnsVoid: true } } }),
      ).toThrow(
        'the captured address at [sp,#0) reaches a phi that merges it with a pointer from outside the frame, and is then moved by a constant',
      );
    });

    // …and a READ of the capture between two moves does not end the walk: sa3's `sub_8068E5C`
    // addresses through a capture and then moves it (`mov r2, sp / adds r2, #5 / strb r0, [r2] /
    // … / adds r2, #2`). The move after the store is the capture at the sum, as the direct spelling
    // of that offset is.
    test('a capture moved after an access through it is the capture at the sum', () => {
      const bytes = (second: string) =>
        'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x8\n\tmov\tr2, sp\n\tadd\tr2, #0x4\n\tstrb\tr0, [r2]\n' +
        `${second}\tstrb\tr1, [r2]\n\tmov\tr3, sp\n\tadd\tr3, #0x4\n\tldrb\tr0, [r3]\n\tldrb\tr1, [r2]\n` +
        '\tadd\tr0, r0, r1\n\tadd\tsp, sp, #0x8\n\tpop\t{r1}\n\tbx\tr1\n';
      const moved = decompile('f', bytes('\tadd\tr2, #0x1\n'), ARMV4T_AGBCC).source;
      expect(moved).toBe(decompile('f', bytes('\tadd\tr2, sp, #0x5\n'), ARMV4T_AGBCC).source);
      expect(moved).toContain('return sp4 + sp5;');
    });

    // …and an address ABOVE the reserved area is not a local's. agbcc's own output for `s32 f(s32
    // a, s32 b, s32 c, s32 d, s32 e){ s32 t = a; g(&t); g(&e); return e + t; }`: [sp,#8] is the
    // fifth parameter, over one local word and the saved `lr`, and the refusal says so rather than
    // judging it as a local nothing types.
    test('the address of an incoming stack argument is refused as one', () => {
      const inArg =
        'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tmov\tr0, sp\n\tbl\tg\n\tadd\tr0, sp, #0x8\n' +
        '\tbl\tg\n\tldr\tr0, [sp, #0x8]\n\tldr\tr1, [sp]\n\tadd\tr0, r0, r1\n\tadd\tsp, sp, #0x4\n\tpop\t{r1}\n\tbx\tr1\n';
      const g = { params: 1, returnsVoid: true };
      expect(() => decompile('f', inArg, ARMV4T_AGBCC, { prototypes: { g } })).toThrow(
        /the captured address at \[sp,#8\) is above the reserved local area of 4 bytes — an incoming stack argument/,
      );
      // …while the TOP of the area is also C's one-past-the-end pointer: agbcc's `u32 r1(void){ u8
      // buf[8]; fill(buf); return count(buf, buf + 8); }`, where the saved `lr` sits at [sp,#8]
      const endPtr =
        'r1:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x8\n\tmov\tr0, sp\n\tbl\tfill\n\tadd\tr1, sp, #0x8\n\tmov\tr0, sp\n' +
        '\tbl\tcount\n\tadd\tsp, sp, #0x8\n\tpop\t{r1}\n\tbx\tr1\n';
      expect(() => decompile('r1', endPtr, ARMV4T_AGBCC, { prototypes: { fill: g, count: { params: 2 } } })).toThrow(
        'is the top of the reserved local area of 8 bytes — one past the end of a local array',
      );
      // …and the write-back of a block copy through a capture lands on the top too, but nothing
      // reads it, so it is no pointer at all: agbcc's `struct U { u32 a, b, c; }; void c4(void){
      // struct U s = gU; g(&s); }` declines at the multi-word store it really is
      const copied =
        'c4:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0xc\n\tmov\tr1, sp\n\tldr\tr0, .L12\n\tldmia\tr0!, {r2, r3, r4}\n' +
        '\tstmia\tr1!, {r2, r3, r4}\n\tmov\tr0, sp\n\tbl\tg\n\tadd\tsp, sp, #0xc\n\tpop\t{r4}\n\tpop\t{r0}\n' +
        '\tbx\tr0\n.L13:\n\t.align\t2, 0\n.L12:\n\t.word\tgU\n';
      expect(() => decompile('c4', copied, ARMV4T_AGBCC, { prototypes: { g: { params: 1 } } })).toThrow(
        'a store at [+4] through the captured address',
      );
      // …where `g`'s return is said, the one object holds the copy, word by word
      expect(decompile('c4', copied, ARMV4T_AGBCC, { prototypes: { g } }).source).toContain('u8 sp0[12];');
    });

    // …and the same frame word READ back after a call that took its address at argument 0 is,
    // instruction for instruction, a struct return's hidden temp. agbcc's own output for
    // `struct S4 { char a, b, c, d; }; s32 f(s32 x){ struct S4 s; five(x, x, x, x, x); s = mk(x);
    // return s.a; }`, at the corpus's flags. Lifted as a local it is `mk(&sp4, a0)` — the call the
    // real prototype rejects — so it declines until `mk`'s return is declared.
    test('an object only read after a call took it at argument 0 is a struct return until declared', () => {
      const sret =
        'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr4, r0, #0\n\tstr\tr4, [sp]\n\tadd\tr1, r4, #0\n' +
        '\tadd\tr2, r4, #0\n\tadd\tr3, r4, #0\n\tbl\tfive\n\tadd\tr0, sp, #0x4\n\tadd\tr1, r4, #0\n\tbl\tmk\n' +
        '\tldr\tr0, [sp, #0x4]\n\tlsl\tr0, r0, #0x18\n\tlsr\tr0, r0, #0x18\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n' +
        '\tpop\t{r1}\n\tbx\tr1\n';
      const five = { params: ['s32', 's32', 's32', 's32', 's32'], returnsVoid: true };
      expect(() => decompile('f', sret, ARMV4T_AGBCC, { prototypes: { five } })).toThrow(
        /the object at \[sp,#4\) is never written here, and `mk` takes it at argument 0 and nothing says what that callee returns/,
      );
      // an out-parameter the project declares as one is the local it looks like
      const mk = { params: ['s32 *', 's32'], returnsVoid: true };
      expect(decompile('f', sret, ARMV4T_AGBCC, { prototypes: { five, mk } }).source).toContain('mk(&sp4, a0);');
    });

    // A slot beside an escaped object may be part of it, and the slot model keeps that word in a
    // register. agbcc's own output at the corpus's flags, each against the control that differs
    // only in the slot.
    describe('a slot beside an escaped object refuses, above it and below it', () => {
      const five = { params: ['s32', 's32', 's32', 's32', 's32'], returnsVoid: true };
      // `struct P { u32 a, b; } s; five(x, y, x, y, x); s.a = x; s.b = y; REG_DMA3SAD = (u32)&s;
      // REG_DMA3DAD = (u32)dst; REG_DMA3CNT = 0x84000002;` — a device READS through the address,
      // so nothing writes the frame back, yet it reads `s.b`, which the slot model keeps in a
      // register
      const dma = (frame: string, stores: string, ctl: string) =>
        `f:\n\tpush\t{r4, r5, r6, lr}\n\tadd\tsp, sp, #-${frame}\n\tadd\tr4, r0, #0\n\tadd\tr5, r1, #0\n` +
        '\tadd\tr6, r2, #0\n\tstr\tr4, [sp]\n\tadd\tr2, r4, #0\n\tadd\tr3, r5, #0\n\tbl\tfive\n' +
        `${stores}\tldr\tr0, .L3\n\tadd\tr1, sp, #0x4\n\tstr\tr1, [r0]\n\tadd\tr0, r0, #0x4\n\tstr\tr6, [r0]\n` +
        `\tldr\tr1, .L3+0x4\n\tldr\tr0, .L3+0x8\n\tstr\tr0, [r1]\n\tadd\tsp, sp, #${frame}\n` +
        '\tpop\t{r4, r5, r6}\n\tpop\t{r0}\n\tbx\tr0\n.L4:\n\t.align\t2, 0\n.L3:\n\t.word\t0x40000d4\n' +
        `\t.word\t0x40000dc\n\t.word\t${ctl}\n`;

      test('above: a word a device may read past the object', () => {
        const two = dma('0xc', '\tstr\tr4, [sp, #0x4]\n\tstr\tr5, [sp, #0x8]\n', '-0x7bfffffe');
        expect(() => decompile('f', two, ARMV4T_AGBCC, { prototypes: { five } })).toThrow(
          /the captured address at \[sp,#4\) is handed to a device that reads through it, which may read the slot at \[sp,#8\]/,
        );
        // the one-word object, `u32 s` — nothing above it
        const one = dma('0x8', '\tstr\tr4, [sp, #0x4]\n', '-0x7bffffff');
        expect(decompile('f', one, ARMV4T_AGBCC, { prototypes: { five } }).source).toContain('volatile u32 sp4;');
      });

      // `vu32 buf[2]; buf[0] = x; buf[1] = h(buf[0]); g(&buf[1]); return buf[0];` — `g` may reach
      // `buf[0]` through `p[-1]`, and the slot model forwards the reload across the call
      const g = { params: ['vu32 *'], returnsVoid: true };
      const h = { params: ['s32'], returns: 's32' };
      test('below: the captured address may point into an object that starts lower', () => {
        const below =
          'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x8\n\tstr\tr0, [sp]\n\tldr\tr0, [sp]\n\tbl\th\n' +
          '\tstr\tr0, [sp, #0x4]\n\tadd\tr0, sp, #0x4\n\tbl\tg\n\tldr\tr0, [sp]\n\tadd\tsp, sp, #0x8\n' +
          '\tpop\t{r1}\n\tbx\tr1\n';
        // `g` with nothing said of its return, so the one-object answer cannot hold it
        const unsaid = { g: { params: g.params }, h };
        expect(() => decompile('f', below, ARMV4T_AGBCC, { prototypes: unsaid })).toThrow(
          /the captured address at \[sp,#4\) is passed to a callee, and it may point INTO an object that starts lower — the slot at \[sp,#0\]/,
        );
        // …and declared `void`, the slot below is a word of one object in memory, reloaded after `g`
        expect(decompile('f', below, ARMV4T_AGBCC, { prototypes: { g, h } }).source).toContain(
          'g((u32)sp0 + 4);\n    return *(s32 *)sp0;',
        );
      });

      test('…but not into the outgoing block below it, which is the callee’s', () => {
        // `vu32 b; five(x, x, x, x, x); b = h(x); g(&b); return b;` — [sp,#0] is `five`'s fifth
        // argument
        const aboveBlock =
          'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr4, r0, #0\n\tstr\tr4, [sp]\n\tadd\tr1, r4, #0\n' +
          '\tadd\tr2, r4, #0\n\tadd\tr3, r4, #0\n\tbl\tfive\n\tadd\tr0, r4, #0\n\tbl\th\n\tstr\tr0, [sp, #0x4]\n' +
          '\tadd\tr0, sp, #0x4\n\tbl\tg\n\tldr\tr0, [sp, #0x4]\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
        expect(decompile('f', aboveBlock, ARMV4T_AGBCC, { prototypes: { five, g, h } }).source).toContain('g(&sp4);');
      });
    });

    // THE OTHER ESCAPE: PUBLISHED TO MEMORY, not handed to a callee. `*(vu32 *)REG_DMA3SAD =
    // (u32)&tmp` gives a DEVICE the address; the function need not contain a `bl` at all, and
    // `sa3:sa2__sub_80078D4` contains none. The licence is the same licence — something outside
    // this function holds the address, so [sp,#0] is an object and not an outgoing argument slot —
    // and the producer table that bounds it is the publish one, at `frameBasePublishedToMemory`.
    describe('a one-word frame whose base is PUBLISHED to memory is the same object', () => {
      // agbcc's shape for `vu32 x = v; *(vu32 *)0x040000D4 = (u32)&x;`, which is `sa2__sub_80078D4`
      // minus its arithmetic: fill the word, capture sp, store the capture through a pool address.
      const PUBLISH =
        'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tldr\tr2, .L4\n\tmov\tr1, sp\n' +
        '\tstr\tr1, [r2]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
        '.L5:\n\t.align\t2, 0\n.L4:\n\t.word\t0x40000d4\n';
      // The refusal this capability lifts, kept in one place: without it the store at [sp,#0] is
      // keyed as an SSA slot and the audit refuses the object that names the same byte.
      const TWO_MODELS = /the object at \[sp,#0\) overlaps the SSA slot at \[sp,#0\] — one byte, two models/;

      test('the published frame base makes [sp,#0] the object', () => {
        // `volatile` because the address was published: a device reads through it, so a store here
        // is observable from outside and the qualifier is what reproduces the source.
        expect(decompile('f', PUBLISH, ARMV4T_AGBCC).source).toBe(
          's32 f(s32 a0) {\n    volatile u32 sp0;\n    sp0 = a0;\n    *(s32 *)67109076 = &sp0;\n    return a0;\n}\n',
        );
      });

      // NOT A BLANKET. Each of these is the same function with ONE fact removed, and each must
      // still not take the licence — otherwise the licence is not "the address escaped", it is
      // "there is a capture". Where the address then escapes nowhere, the byte the two models
      // disagree about is kept as one object in memory instead (frame-objects.ts, no escape at
      // all): an untyped array with the store in it, never the licence's `volatile u32` scalar.
      const NOT_THE_LICENCE = 's32 f(s32 a0) {\n    u8 sp0[4];\n    *(s32 *)sp0 = a0;\n    return a0;\n}\n';
      test('with nothing consuming the capture the licence stands down', () => {
        expect(decompile('f', PUBLISH.replace('\tstr\tr1, [r2]\n', ''), ARMV4T_AGBCC).source).toBe(NOT_THE_LICENCE);
      });

      // BOTH HALVES OF ONE RULE — "through a base that is neither sp nor another held capture" —
      // because each half is its own clause in the predicate and a clause without a witness is
      // decoration until an input proves otherwise. Dropping the second clause leaves the first
      // row green, which is exactly how a load-bearing guard comes to read as one.
      test('a capture stored back into its OWN frame publishes nothing', () => {
        // the address never leaves: `[sp]` is storage this function already owns, so the store
        // proves nothing about who else can reach the word. The first audit sees no escape (the
        // store is a slot's), and kept as one object the store writes the address into memory
        // nothing declares a reader of — so it still declines, on that writer
        expect(() => decompile('f', PUBLISH.replace('\tstr\tr1, [r2]', '\tstr\tr1, [sp]'), ARMV4T_AGBCC)).toThrow(
          /kept as one object cannot hold every writer — the captured address at \[sp,#0\): the address is published rather than passed/,
        );
        // …and the SAME frame reached through a second capture of it: `mov r2, sp` makes r2 the
        // frame base too, so `str r1, [r2]` writes the address into the very word it names
        expect(() =>
          decompile('f', PUBLISH.replace('\tmov\tr1, sp\n', '\tmov\tr1, sp\n\tmov\tr2, sp\n'), ARMV4T_AGBCC),
        ).toThrow(TWO_MODELS);
      });

      test('a HALFWORD store hands over half an address, and is not a publish', () => {
        // whatever the device reads from there, it is not this object's address
        expect(() => decompile('f', PUBLISH.replace('\tstr\tr1, [r2]', '\tstrh\tr1, [r2]'), ARMV4T_AGBCC)).toThrow(
          TWO_MODELS,
        );
      });

      // THE STORED VALUE, which is the clause a reader skips because the shape looks like a
      // publish: a word store through a pool address, in a function that holds a capture. What it
      // hands the device is `r0` — the incoming argument, not the frame base — so nothing outside
      // this function learns where the object is.
      test('a word store through a pool address publishes nothing when the VALUE is not the capture', () => {
        expect(decompile('f', PUBLISH.replace('\tstr\tr1, [r2]', '\tstr\tr0, [r2]'), ARMV4T_AGBCC).source).toBe(
          's32 f(s32 a0) {\n    u8 sp0[4];\n    *(s32 *)sp0 = a0;\n    *(s32 *)67109076 = a0;\n    return a0;\n}\n',
        );
      });

      // THE BASE CLAUSE IS WHOLE-FUNCTION, as the audit's `taint` is. A capture taken in the entry
      // block is not HELD when a later block stores through it, so a block-local base test would
      // accept here (`r2` neither sp nor held in `.L2`). The base is tested against every register
      // that holds a frame address anywhere (`registersThatMayHoldAFrameAddress`), so the licence
      // refuses it itself: the address is written into this frame, and nothing outside it has been
      // handed it.
      test('a base captured in an earlier block is the frame, and publishes nothing', () => {
        const crossBlock =
          'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr4, [sp]\n\tmov\tr2, sp\n\tcmp\tr0, #0\n\tbeq\t.L2\n' +
          '.L2:\n\tmov\tr1, sp\n\tstr\tr1, [r2]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
        expect(() => decompile('f', crossBlock, ARMV4T_AGBCC)).toThrow(TWO_MODELS);
      });

      // …and the outgoing-argument analysis's `escape` event reads the same clause: the address
      // stored through a base captured in an EARLIER block is no escape, so it ends no pending
      // word. Read block-locally it would, and the decline would say the store to [sp,#0] on every
      // path to `five` is "not stored on every path to the call" — a false fact.
      test('…and the escape event reads the same whole-function base clause', () => {
        const intoFrame =
          'f:\n\tpush\t{r5, lr}\n\tadd\tsp, sp, #-0x10\n\tadd\tr5, sp, #0x8\n\tcmp\tr0, #0\n\tbeq\t.L1\n' +
          '\tmov\tr1, #0\n.L1:\n\tstr\tr1, [sp]\n\tmov\tr0, sp\n\tstr\tr0, [r5]\n\tmov\tr0, #0x1\n\tmov\tr1, #0x2\n' +
          '\tmov\tr2, #0x3\n\tmov\tr3, #0x4\n\tbl\tfive\n\tadd\tsp, sp, #0x10\n\tpop\t{r5}\n\tpop\t{r1}\n\tbx\tr1\n';
        const five = { five: { params: ['s32', 's32', 's32', 's32', 's32'], returns: 's32' } };
        expect(() => decompile('f', intoFrame, ARMV4T_AGBCC, { prototypes: five })).toThrow(TWO_MODELS);
      });

      // …and the evidence is an agbcc compile table, exactly as for the callee escape: a second
      // table, its own shapes, and the same declared layout gating both. Asked of a transfer the
      // function arms, with a fixed source that reads two bytes: a read nothing bounds is kept as
      // one object in memory instead, which needs no layout proof — it declares every byte of the
      // reserved area and keeps every store to it.
      //
      // The layout is asked for only where a call MAY take a stack word, here a `bl h` nothing
      // declares: with no such call there is no outgoing area on any compiler, and the published
      // frame base is a local's address without the premise (thumb.ts, beside
      // `noCallTakesAStackWord`).
      test('an armv4t compiler that has not declared the layout does not get the publish proof', () => {
        const armed = PUBLISH.replace(
          '\tstr\tr1, [r2]\n',
          '\tstr\tr1, [r2]\n\tldr\tr3, .L4+0x4\n\tstr\tr3, [r2, #0x8]\n',
        ).concat('\t.word\t0x81000001\n');
        expect(armed).not.toBe(PUBLISH);
        const called = armed.replace('\tadd\tsp, sp, #0x4\n', '\tbl\th\n\tadd\tsp, sp, #0x4\n');
        expect(called).not.toBe(armed);
        expect(() => decompile('f', called, undeclared)).toThrow(/it may be an outgoing stack argument/);
        expect(decompile('f', called, ARMV4T_AGBCC).source).toContain('    volatile u32 sp0;');
        // …and with `h` declared to take no word, or with no call at all, nothing asks for it
        const noWord = { prototypes: { h: { params: 0 } } };
        expect(decompile('f', called, undeclared, noWord).source).toContain('    volatile u32 sp0;');
        expect(decompile('f', armed, undeclared).source).toContain('    volatile u32 sp0;');
      });

      // The walk is kill-on-mention and a `bl` drops every held capture, including one in a
      // CALLEE-SAVED register that survives the call in fact. That over-kill is deliberate and it
      // only ever costs a decline — which is the verdict asserted here, so the over-approximation
      // is pinned rather than discovered later as a regression.
      test('a capture held across a call is dropped, and the function declines', () => {
        const acrossCall =
          'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr0, [sp]\n\tldr\tr2, .L4\n\tmov\tr4, sp\n' +
          '\tbl\tg\n\tstr\tr4, [r2]\n\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
          '.L5:\n\t.align\t2, 0\n.L4:\n\t.word\t0x40000d4\n';
        expect(() => decompile('f', acrossCall, ARMV4T_AGBCC)).toThrow(/never reloaded/);
      });

      // A bare register COPY carries the base forward, the same shape the callee scan carries: the
      // capture and the register that is published need not be the same one.
      test('the capture reaches the store through a register copy', () => {
        const viaCopy = PUBLISH.replace('\tmov\tr1, sp\n', '\tmov\tr1, sp\n\tmov\tr3, r1\n').replace(
          '\tstr\tr1, [r2]',
          '\tstr\tr3, [r2]',
        );
        expect(decompile('f', viaCopy, ARMV4T_AGBCC).source).toContain('&sp0');
      });
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
      expect(() => decompile('g3', blockCopyBase, ARMV4T_AGBCC)).toThrow(
        /the store to \[sp,#0\] reaches `bl five` unread/,
      );
      // ORDER IS NOT THE DISCRIMINATOR. The same source with the five-argument call FIRST puts the
      // argument store before the copy, and it must decline just the same.
      const argFirst =
        'g4:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x90\n\tadd\tr4, r0, #0\n\tstr\tr1, [sp]\n' +
        '\tmov\tr0, #0x1\n\tmov\tr1, #0x2\n\tmov\tr2, #0x3\n\tmov\tr3, #0x4\n\tbl\tfive\n' +
        '\tadd\tr1, r4, #0\n\tadd\tr1, r1, #0x10\n\tmov\tr0, sp\n\tmov\tr2, #0x90\n\tbl\tmemcpy\n' +
        '\tldr\tr0, [r4]\n\tldr\tr1, [r4, #0x4]\n\tldr\tr2, [r4, #0x8]\n\tldr\tr3, [r4, #0xc]\n\tbl\ttakesH\n' +
        '\tadd\tsp, sp, #0x90\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n';
      expect(() => decompile('g4', argFirst, ARMV4T_AGBCC)).toThrow(/the store to \[sp,#0\] reaches `bl five` unread/);
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
      expect(() => decompile('f', structReturn, ARMV4T_AGBCC)).toThrow(
        /a struct returned through a hidden pointer is handed this same frame/,
      );
      // the ONE-WORD spelling of the same source — verbatim agbcc for `struct S4 { char a,b,c,d; };
      // void f(int x){ struct S4 s = mk(x); use2(s.a); }`. Lifting it emitted `mk(&sp0, a0)`: a
      // three-line function rendered as a call the real prototype rejects outright.
      const oneWordReturn =
        'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tadd\tr1, r0, #0\n\tmov\tr0, sp\n\tbl\tmk\n' +
        '\tldr\tr0, [sp]\n\tlsl\tr0, r0, #0x18\n\tlsr\tr0, r0, #0x18\n\tbl\tuse2\n' +
        '\tadd\tsp, sp, #0x4\n\tpop\t{r0}\n\tbx\tr0\n';
      expect(() => decompile('f', oneWordReturn, ARMV4T_AGBCC)).toThrow(
        /a struct returned through a hidden pointer is handed this same frame/,
      );
      expect(() => decompile('f', oneWordReturn, ARMV4T_AGBCC, { prototypes: { mk: { params: 1 } } })).toThrow(
        /a struct returned through a hidden pointer is handed this same frame/,
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
      // function's own instructions: a callee known to return nothing, or to return in a
      // register, has no hidden return pointer to be given whatever sits in r0. The bytes are
      // identical either way — that is the whole difficulty — so the header is what separates
      // them, arriving through the same table whose `params` this frontend already trusts for
      // arity.
      expect(
        decompile('f', oneWordReturn, ARMV4T_AGBCC, { prototypes: { mk: { params: 2, returnsVoid: true } } }).source,
      ).toContain('mk(&sp0');
    });

    // The refusal SURVIVES, narrowed: only a callee whose RETURN is described gets past it, and
    // every callee that took the address at argument 0 has to be one.
    test('the return discriminator is a declaration, and everything short of one still refuses', () => {
      const oneWordReturn =
        'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tadd\tr1, r0, #0\n\tmov\tr0, sp\n\tbl\tmk\n' +
        '\tldr\tr0, [sp]\n\tlsl\tr0, r0, #0x18\n\tlsr\tr0, r0, #0x18\n\tbl\tuse2\n' +
        '\tadd\tsp, sp, #0x4\n\tpop\t{r0}\n\tbx\tr0\n';
      const declines = (prototypes: Record<string, { params?: number; returnsVoid?: boolean }>) =>
        expect(() => decompile('f', oneWordReturn, ARMV4T_AGBCC, { prototypes })).toThrow(
          /nothing says what that callee returns/,
        );
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
        /nothing says what that callee returns/,
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

    // TWO callees at argument 0 and only one declared: position acquits a CALL, but a call that
    // took the address at argument 0 is acquitted only by its return — so one undescribed callee
    // leaves the object ambiguous and the whole lift refuses.
    test('every callee that took the address at argument 0 must have its return described', () => {
      const twoCallees =
        'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tmov\tr0, sp\n\tbl\tfill\n' +
        '\tmov\tr0, sp\n\tbl\tmk\n\tldr\tr0, [sp]\n\tadd\tsp, sp, #0x4\n\tpop\t{r1}\n\tbx\tr1\n';
      expect(() =>
        decompile('f', twoCallees, ARMV4T_AGBCC, {
          prototypes: { fill: { params: 1, returnsVoid: true }, mk: { params: 1 } },
        }),
      ).toThrow(/nothing says what that callee returns/);
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
    // A FIVE-ARGUMENT CALL WHOSE CALLEE IS UNDECLARED BELONGS ONLY IN A REFUSING INPUT. Nothing
    // tells this frontend that `five` takes five arguments, so the `str r4, [sp]` that stages the
    // fifth is indistinguishable from a store to a local — that is the residual this branch
    // states as open, and an ACCEPTING assertion over the shape would freeze the accepting answer
    // as expected output and hand whoever closes the hole a red suite reading as a regression. A
    // DECLINE is safe under either reading, so the tail stays where the verdict is a decline and
    // is absent from every control below.
    const FIVE_ARG_CALL = '\tmov\tr0, #0x1\n\tmov\tr1, #0x2\n\tmov\tr2, #0x3\n\tmov\tr3, #0x4\n\tbl\tfive\n';
    const PROLOGUE = 'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x4\n\tstr\tr4, [sp]\n';
    const EPILOGUE = '\tadd\tsp, sp, #0x4\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n';
    const POOL = '.L5:\n\t.align\t2, 0\n.L4:\n\t.word\t0x40000d4\n';

    test('the acceptance is refused when the lifted function does not pass the address to a call', () => {
      // a declared arity DROPS the address, and the licence reads the declaration too
      // (`frameAddressReceivers`): `use` taking nothing is handed nothing, so no licence is granted
      // and the store keeps the outgoing-argument refusal
      const captureAndCall = `${PROLOGUE}\tmov\tr0, sp\n\tbl\tuse\n`;
      expect(() =>
        decompile('f', captureAndCall + FIVE_ARG_CALL + EPILOGUE, ARMV4T_AGBCC, { prototypes: { use: { params: 0 } } }),
      ).toThrow(/the store to \[sp,#0\] is never reloaded/);
      // …and where NOTHING declares the callee the licence reads every argument register, and so
      // does the guessed arity: the frame base in r3 is a value nothing but the call reads, so `use`
      // takes it and the incoming r0..r2 below it (`decideGap`), and the licence's claim is the
      // call the lift emits. A gap the guess could not decide would refuse (`fallbackArgc`) ahead
      // of asking whether a register it leaves out may hold a frame address (`lowerCall`'s
      // `leftOut`); the audit's re-check is the backstop.
      expect(
        decompile('f', `${PROLOGUE}\tmov\tr3, sp\n\tbl\tuse\n${FIVE_ARG_CALL}${EPILOGUE}`, ARMV4T_AGBCC).source,
      ).toContain('use(a0, a1, a2, &sp0);\n    five(1, 2, 3, 4);');
      // CONTROL: the same function with `use` taking its argument is the shape this capability is
      // for, and lifts.
      expect(
        decompile('f', captureAndCall + EPILOGUE, ARMV4T_AGBCC, { prototypes: { use: { params: 1 } } }).source,
      ).toContain('use(&sp0)');
    });

    // THE RE-CHECK IS A CONTAINMENT, and a re-proof weaker than the licence it re-proves is a
    // second, wider door into the same acceptance. Each input below is the row above with ONE store
    // added that the pre-lift publish scan refuses BY NAME; a re-check read off the wide
    // `published` set would accept all three and drop `five`'s fifth outgoing argument, staged at
    // [sp,#0], from a compiling, plausible, wrong program. Undeclared, the call lowering refuses
    // each first (r1, which holds the frame base, is past r0, which holds nothing: a gap the guess
    // refuses); with `use` declared to take
    // nothing, no callee licenses it and the publish scan refuses the store by name.
    const USE_NOTHING = { use: { params: [], returns: 's32' } };
    test.each([
      ['a HALFWORD of the address is not the address', '\tldr\tr2, .L4\n\tstrh\tr1, [r2]\n'],
      ['a store back into the object’s own bytes publishes to nobody', '\tstr\tr1, [sp]\n'],
      ['a store through ANOTHER held capture is the same frame', '\tmov\tr2, sp\n\tstr\tr1, [r2]\n'],
    ])('the premise re-check refuses what the licence refuses: %s', (_why, publish) => {
      const build = (store: string, fiveArgCall: string) =>
        `${PROLOGUE}\tmov\tr1, sp\n${store}\tmov\tr3, sp\n\tbl\tuse\n${fiveArgCall}${EPILOGUE}` +
        (store.includes('.L4') ? POOL : '');
      expect(() => decompile('f', build(publish, FIVE_ARG_CALL), ARMV4T_AGBCC)).toThrow(
        /the call 'bl use' in block 'f' has no prototype, r\d holds a value and r0 holds none/,
      );
      expect(() => decompile('f', build(publish, FIVE_ARG_CALL), ARMV4T_AGBCC, { prototypes: USE_NOTHING })).toThrow(
        /the store to \[sp,#0\] is never reloaded/,
      );
      // CONTROL, and it is what makes each row a witness rather than a blanket: the same function
      // with the store widened to a word through a pool address — the one shape the licence does
      // admit — lifts, so the refusal is about the store and not about the surrounding frame. The
      // five-argument call is dropped from it for the reason stated above the fixture: a control
      // is an ACCEPTING assertion, and that tail has no declared callee to referee it.
      expect(
        decompile('f', build('\tldr\tr2, .L4\n\tstr\tr1, [r2]\n', ''), ARMV4T_AGBCC, { prototypes: USE_NOTHING })
          .source,
      ).toContain('&sp0');
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
      for (const list of ['r0, r1, r2, r3', 'r0-r3', 'r1-r3']) {
        expect(() => decompile('f', withList(list), ARMV4T_AGBCC)).toThrow(/never reloaded/);
      }
      // CASE is a third spelling of the same instruction, and it declines too — earlier, on the
      // spelling itself, because the whole frontend reads registers in one case only. Both
      // verdicts are a refusal, which is the property that matters: no spelling of this `pop`
      // lets the dead capture through.
      expect(() => decompile('f', withList('R0-R3'), ARMV4T_AGBCC)).toThrow(/is spelled in upper case/);
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
      // CONTROL: the same object published to a DMA source register lifts, because the device
      // reads through the address and never writes it (`readsThrough`), and its control word says
      // it re-reads the one object. Verbatim agbcc for `struct M { vu8 b; u8 pad[3]; s32 t; }; s32
      // pubd(s32 x){ struct M m; m.b = x; m.t = h(1); g2(); REG_DMA3[0] = (u32)&m; REG_DMA3[2] =
      // 0x81000001; return m.t; }`.
      const dmaSink = (tail: string) =>
        'pubd:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x8\n\tmov\tr1, sp\n\tldrb\tr2, [r1]\n\tstrb\tr0, [r1]\n' +
        '\tmov\tr0, #0x1\n\tbl\th\n\tstr\tr0, [sp, #0x4]\n' +
        tail +
        '\tldr\tr0, [sp, #0x4]\n\tadd\tsp, sp, #0x8\n\tpop\t{r1}\n\tbx\tr1\n.L4:\n\t.align\t2, 0\n.L3:\n' +
        '\t.word\t0x40000d4\n\t.word\t0x40000dc\n\t.word\t-0x7effffff\n';
      const dmaStores =
        '\tldr\tr0, .L3\n\tmov\tr1, sp\n\tstr\tr1, [r0]\n\tldr\tr1, .L3+0x4\n\tldr\tr0, .L3+0x8\n\tstr\tr0, [r1]\n';
      const dmaProtos = { prototypes: { h: { params: 1 }, g2: { params: 0, returnsVoid: true } } };
      expect(decompile('pubd', dmaSink(`\tbl\tg2\n${dmaStores}`), ARMV4T_AGBCC, dmaProtos).source).toContain(
        'volatile u8 sp0;',
      );
      // …and a call AFTER the control store bounds nothing away: a callee arms only a transfer it
      // set up itself, source register first (the premise `readWindow` states), so `g2` does not
      // re-read `&m` — agbcc's `pubc`, the same body with `g2()` moved below the control store.
      expect(decompile('pubd', dmaSink(`${dmaStores}\tbl\tg2\n`), ARMV4T_AGBCC, dmaProtos).source).toContain(
        'volatile u8 sp0;',
      );
      // …but a store through a pointer this cannot resolve may BE the control halfword, re-arming
      // the channel to read `m.t` as well — agbcc's `pube(s32 x, vu32 *cnt)`, the same body ending
      // `*cnt = 0x84000002`. Nothing bounds the read, so the local area is kept as ONE object in
      // memory and `m.t`'s store is a store into it, which is what agbcc emitted: recompiled, the
      // lift keeps `strb r0, [r1]` and `str r0, [sp, #0x4]` both.
      const unresolved =
        'pube:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr4, r1, #0\n\tmov\tr1, sp\n\tldrb\tr2, [r1]\n' +
        '\tstrb\tr0, [r1]\n\tmov\tr0, #0x1\n\tbl\th\n\tstr\tr0, [sp, #0x4]\n\tldr\tr0, .L15\n\tmov\tr1, sp\n' +
        '\tstr\tr1, [r0]\n\tldr\tr1, .L15+0x4\n\tldr\tr0, .L15+0x8\n\tstr\tr0, [r1]\n\tldr\tr0, .L15+0xc\n' +
        '\tstr\tr0, [r4]\n\tldr\tr0, [sp, #0x4]\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
        '.L16:\n\t.align\t2, 0\n.L15:\n\t.word\t0x40000d4\n\t.word\t0x40000dc\n\t.word\t-0x7effffff\n' +
        '\t.word\t-0x7bfffffe\n';
      const pube = decompile('pube', unresolved, ARMV4T_AGBCC, dmaProtos).source;
      expect(pube).toContain('    u8 sp0[8];');
      expect(pube).toContain('*(u8 *)sp0 = a0;');
      expect(pube).toContain('((s32 *)sp0)[1] = h(1);');
      expect(pube).toContain('return ((s32 *)sp0)[1];');
      // …and so is a pointer that is this frame's on only SOME paths: `p = cnt ? cnt : &o;
      // *p = 0x84000002` may be the control halfword, and `o` is then a member too. Hand-written —
      // the `pube` shape with that phi before the transfer; [sp,#4] is the object the device reads,
      // [sp,#8] a slot, [sp,#0xc] `o` — and it assembles with GNU as.
      const phiRearm = (pick: string) =>
        'e9:\n\tpush\t{r4, r5, r6, lr}\n\tadd\tsp, sp, #-0x10\n\tadd\tr4, r0, #0\n\tadd\tr5, r1, #0\n' +
        pick +
        '\tmov\tr0, #0x5\n\tstr\tr0, [sp]\n\tmov\tr0, #0x1\n\tmov\tr1, #0x2\n\tmov\tr2, #0x3\n\tmov\tr3, #0x4\n' +
        '\tbl\tfive\n\tstr\tr4, [sp, #0x4]\n\tstr\tr5, [sp, #0x8]\n\tldr\tr0, .L6\n\tadd\tr1, sp, #0x4\n' +
        '\tstr\tr1, [r0]\n\tldr\tr1, .L6+0x4\n\tldr\tr0, .L6+0x8\n\tstr\tr0, [r1]\n\tadd\tr1, r1, #0x4\n' +
        '\tldr\tr0, .L6+0xc\n\tstr\tr0, [r1]\n\tldr\tr0, .L6+0x10\n\tstr\tr0, [r6]\n\tadd\tsp, sp, #0x10\n' +
        '\tpop\t{r4, r5, r6}\n\tpop\t{r0}\n\tbx\tr0\n.L7:\n\t.align\t2, 0\n.L6:\n\t.word\t0x40000d4\n' +
        '\t.word\t0x40000d8\n\t.word\tgDst\n\t.word\t-0x7affffff\n\t.word\t-0x7bfffffe\n';
      const five = { prototypes: { five: { params: 5, returnsVoid: true } } };
      const e9 = decompile(
        'e9',
        phiRearm('\tadd\tr6, r2, #0\n\tcmp\tr6, #0\n\tbne\t.L1\n\tadd\tr6, sp, #0xc\n.L1:\n'),
        ARMV4T_AGBCC,
        five,
      ).source;
      expect(e9).toContain('    u8 sp4[12];');
      expect(e9).toContain('if (a2 == 0) a2 = (s32 *)((u32)sp4 + 8);');
      expect(e9).toContain('p0[1] = a1;');
      expect(e9).toContain('*a2 = -2080374782;');
      // CONTROL: `o` on every path is this frame's own store, which re-arms nothing
      expect(decompile('e9', phiRearm('\tadd\tr6, sp, #0xc\n'), ARMV4T_AGBCC, five).source).toContain(
        'volatile u32 sp4;',
      );
    });

    // A STORE TO A NAMED SYMBOL PLUS A CONSTANT does not re-arm the channel where a symbol map
    // places the name away from the control halfword, and the overlap test decides it exactly.
    // A name no map places may be a device register the disassembly spelled by name, and an
    // index or a pointer loaded from the symbol may be the control halfword: each leaves the read
    // unbounded, and then `s.b` at [sp,#8] is kept in memory with `s.a`. Verbatim agbcc, one body
    // with three endings: `struct P { u32 a, b; } s; five(1,2,3,4,5); s.a = x; s.b = y;
    // REG_DMA3SAD = (u32)&s; REG_DMA3DAD = (u32)gDst; REG_DMA3CNT = 0x85000001;` then
    // `gNamed.g = y` (n1), `gArr[x] = y` (n3), or `*gCnt = 0x84000002` with `extern vu32 *gCnt`
    // (e4); and e4's re-arm stored through `.word REG_DMA3CNT`, as sa2 spells an I/O register (e4s).
    test('a placed symbol plus a constant cannot re-arm the channel, an unplaced name, an index or a loaded pointer can', () => {
      const armed = (name: string, tail: string, pool: string) =>
        `${name}:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0xc\n\tadd\tr4, r0, #0\n\tadd\tr5, r1, #0\n` +
        '\tmov\tr0, #0x5\n\tstr\tr0, [sp]\n\tmov\tr0, #0x1\n\tmov\tr1, #0x2\n\tmov\tr2, #0x3\n\tmov\tr3, #0x4\n' +
        '\tbl\tfive\n\tstr\tr4, [sp, #0x4]\n\tstr\tr5, [sp, #0x8]\n\tldr\tr0, .L6\n\tadd\tr1, sp, #0x4\n' +
        '\tstr\tr1, [r0]\n\tldr\tr1, .L6+0x4\n\tldr\tr0, .L6+0x8\n\tstr\tr0, [r1]\n\tadd\tr1, r1, #0x4\n' +
        '\tldr\tr0, .L6+0xc\n\tstr\tr0, [r1]\n' +
        tail +
        '\tadd\tsp, sp, #0xc\n\tpop\t{r4, r5}\n\tpop\t{r0}\n\tbx\tr0\n.L7:\n\t.align\t2, 0\n.L6:\n' +
        '\t.word\t0x40000d4\n\t.word\t0x40000d8\n\t.word\tgDst\n\t.word\t-0x7affffff\n' +
        pool;
      const five = { prototypes: { five: { params: 5, returnsVoid: true } } };
      const n1 = armed('n1', '\tldr\tr0, .L6+0x10\n\tstr\tr5, [r0, #0x4]\n', '\t.word\tgNamed\n');
      const inIwram = new Map([[0x03000000, [{ name: 'gNamed', kind: 'data' as const }]]]);
      const bounded = decompile('n1', n1, ARMV4T_AGBCC, { ...five, symbols: inIwram }).source;
      expect(bounded).toContain('volatile u32 sp4;');
      expect(bounded).toContain('((s32 *)&gNamed)[1] = a1;');
      // …exactly, where a map places the name: at 0x040000d8, `gNamed.g` IS the control word. That
      // byte is then also the literal `REG_DMA3CNT` store's, two spellings of one cell agbcc does
      // not reload across, so on agbcc the lift declines (raise/offsetnames.ts `cellSpelledTwice`);
      // the window's exactness is read under a target that reloads across them
      const onControl = new Map([[0x040000d8, [{ name: 'gNamed', kind: 'data' as const }]]]);
      expect(() => decompile('n1', n1, ARMV4T_AGBCC, { ...five, symbols: onControl })).toThrow(
        /byte 0x40000dc is reached as a numeric address and as 'gNamed'/,
      );
      const reloading = {
        ...ARMV4T_AGBCC,
        compilerBehaviors: { ...ARMV4T_AGBCC.compilerBehaviors, reloadsAcrossSpellings: true },
      };
      const kept = decompile('n1', n1, reloading, { ...five, symbols: onControl }).source;
      expect(kept).toContain('    u8 sp4[8];');
      expect(kept).toContain('p0[1] = a1;');
      const n3 = armed(
        'n3',
        '\tldr\tr0, .L6+0x10\n\tlsl\tr4, r4, #0x2\n\tadd\tr4, r4, r0\n\tstr\tr5, [r4]\n',
        '\t.word\tgArr\n',
      );
      const e4 = armed(
        'e4',
        '\tldr\tr0, .L6+0x10\n\tldr\tr1, [r0]\n\tldr\tr0, .L6+0x14\n\tstr\tr0, [r1]\n',
        '\t.word\tgCnt\n\t.word\t-0x7bfffffe\n',
      );
      const e4s = armed(
        'e4s',
        '\tldr\tr1, .L6+0x10\n\tldr\tr0, .L6+0x14\n\tstr\tr0, [r1]\n',
        '\t.word\tREG_DMA3CNT\n\t.word\t-0x7bfffffe\n',
      );
      for (const [name, asm] of [
        ['n1', n1],
        ['n3', n3],
        ['e4', e4],
        ['e4s', e4s],
      ]) {
        const src = decompile(name, asm, ARMV4T_AGBCC, five).source;
        expect(src).toContain('    u8 sp4[8];');
        expect(src).toContain('p0[1] = a1;');
      }
    });

    // A STORE THROUGH A COMPUTED POINTER WHOSE EVERY ADDRESS MISSES THE CONTROL HALFWORD cannot
    // re-arm the channel (`addressRangeOf`), so the window stays where the literal stores put it
    // and the struct-return temp beside the published `tmp` is its own object. Verbatim agbcc,
    // `struct Ent { u16 x; u16 y; u8 f; u8 pad[3]; }`: `if (k) { s = mk(gEnts[i].x); gEnts[i].x =
    // s.a; } else { tmp = 0xFFFF; DMA3 = &tmp, 0x05000200, 0x81000010; } gEnts[i].f = 1;` with `i`
    // a `u8`, so the tail store lands at `base + 4 + 8 * [0, 255]`. The base is a literal
    // (synthetic:dmasret) or `extern struct Ent gEnts[]` (dmasretx): a name resolves only where a
    // map places it. Placed at 0x04000000 the span covers 0x040000de, but the stride steps over
    // it (0x04000004 + 8i is never 0x040000de or 0x040000df), so that placement lifts too; placed
    // at 0x040000da, i = 0 writes the control halfword's low byte and may re-arm. Through a
    // pointer parameter (dmaptr) nothing bounds the store. Every refusal keeps the decline it had:
    // the escape reaches `mk`'s return storage, a writer the one object cannot hold.
    test('a computed store whose every address misses the control halfword cannot re-arm the channel', () => {
      const dma =
        '.L3:\n\tmov\tr1, sp\n\tldr\tr2, .L7\n\tadd\tr0, r2, #0\n\tstrh\tr0, [r1]\n\tldr\tr0, .L7+0x4\n' +
        '\tstr\tr1, [r0]\n\tldr\tr1, .L7+0x8\n\tldr\tr0, .L7+0xc\n\tstr\tr0, [r1]\n\tadd\tr1, r1, #0x4\n' +
        '\tldr\tr0, .L7+0x10\n\tstr\tr0, [r1]\n';
      const pool =
        '\t.word\t0xffff\n\t.word\t0x40000d4\n\t.word\t0x40000d8\n\t.word\t0x5000200\n\t.word\t-0x7efffff0\n';
      const epilogue = (saved: string) => `\tadd\tsp, sp, #0x8\n\tpop\t{${saved}}\n\tpop\t{r0}\n\tbx\tr0\n`;
      const dmasret =
        'dmasret:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x8\n\tlsl\tr0, r0, #0x18\n\tlsr\tr5, r0, #0x18\n' +
        '\tlsl\tr1, r1, #0x18\n\tcmp\tr1, #0\n\tbeq\t.L3\n\tlsl\tr5, r5, #0x3\n\tldr\tr0, .L5\n\tadd\tr4, r5, r0\n' +
        '\tldrh\tr1, [r4]\n\tadd\tr0, sp, #0x4\n\tbl\tmk\n\tldr\tr0, [sp, #0x4]\n\tstrh\tr0, [r4]\n\tb\t.L4\n' +
        '.L6:\n\t.align\t2, 0\n.L5:\n\t.word\t0x3003440\n' +
        dma +
        '\tlsl\tr5, r5, #0x3\n.L4:\n\tldr\tr0, .L7+0x14\n\tadd\tr1, r5, r0\n\tmov\tr0, #0x1\n\tstrb\tr0, [r1, #0x4]\n' +
        epilogue('r4, r5') +
        '.L8:\n\t.align\t2, 0\n.L7:\n' +
        pool +
        '\t.word\t0x3003440\n';
      const dmasretx =
        'dmasretx:\n\tpush\t{r4, r5, lr}\n\tadd\tsp, sp, #-0x8\n\tlsl\tr0, r0, #0x18\n\tlsr\tr5, r0, #0x18\n' +
        '\tlsl\tr1, r1, #0x18\n\tcmp\tr1, #0\n\tbeq\t.L3\n\tldr\tr4, .L5\n\tlsl\tr5, r5, #0x3\n\tadd\tr4, r5, r4\n' +
        '\tldrh\tr1, [r4]\n\tadd\tr0, sp, #0x4\n\tbl\tmk\n\tldr\tr0, [sp, #0x4]\n\tstrh\tr0, [r4]\n\tb\t.L4\n' +
        '.L6:\n\t.align\t2, 0\n.L5:\n\t.word\tgEnts\n' +
        dma +
        '\tlsl\tr5, r5, #0x3\n.L4:\n\tldr\tr0, .L7+0x14\n\tadd\tr0, r5, r0\n\tmov\tr1, #0x1\n\tstrb\tr1, [r0, #0x4]\n' +
        epilogue('r4, r5') +
        '.L8:\n\t.align\t2, 0\n.L7:\n' +
        pool +
        '\t.word\tgEnts\n';
      const dmaptr =
        'dmaptr:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr4, r0, #0\n\tlsl\tr1, r1, #0x18\n\tcmp\tr1, #0\n' +
        '\tbeq\t.L3\n\tldrh\tr1, [r4]\n\tadd\tr0, sp, #0x4\n\tbl\tmk\n\tldr\tr0, [sp, #0x4]\n\tstrh\tr0, [r4]\n' +
        '\tb\t.L4\n' +
        dma +
        '.L4:\n\tmov\tr0, #0x1\n\tstrb\tr0, [r4, #0x4]\n' +
        epilogue('r4') +
        '.L8:\n\t.align\t2, 0\n.L7:\n' +
        pool;
      const S4 = {
        params: ['u16'],
        returns: 'struct S4',
        returnLayout: {
          kind: 'struct' as const,
          members: [
            { name: 'a', type: 'u16' },
            { name: 'b', type: 'u16' },
          ],
        },
      };
      const protos = (self: string) => ({ prototypes: { mk: S4, [self]: { returnsVoid: true } } });
      const placed = (at: number) => new Map([[at, [{ name: 'gEnts', kind: 'data' as const }]]]);
      const lifted = decompile('dmasret', dmasret, ARMV4T_AGBCC, protos('dmasret')).source;
      expect(lifted).toContain('    struct S4 sp4;');
      expect(lifted).toContain('    volatile u16 sp0;');
      expect(lifted).toContain('*(s32 *)67109076 = &sp0;');
      const named = decompile('dmasretx', dmasretx, ARMV4T_AGBCC, {
        ...protos('dmasretx'),
        symbols: placed(0x03003440),
      }).source;
      expect(named).toContain('    struct S4 sp4;');
      expect(named).toContain('    volatile u16 sp0;');
      const reachesTheTemp = /the one object cannot hold every writer: .* where `mk` returns its struct/;
      expect(() => decompile('dmasretx', dmasretx, ARMV4T_AGBCC, protos('dmasretx'))).toThrow(reachesTheTemp);
      expect(
        decompile('dmasretx', dmasretx, ARMV4T_AGBCC, { ...protos('dmasretx'), symbols: placed(0x04000000) }).source,
      ).toContain('    volatile u16 sp0;');
      expect(() =>
        decompile('dmasretx', dmasretx, ARMV4T_AGBCC, { ...protos('dmasretx'), symbols: placed(0x040000da) }),
      ).toThrow(reachesTheTemp);
      expect(() => decompile('dmaptr', dmaptr, ARMV4T_AGBCC, protos('dmaptr'))).toThrow(reachesTheTemp);
    });

    // …AND A WINDOW `misses` BOUNDED KEEPS THE ONE-OBJECT ANSWER ON OFFER that its unbounded read
    // had. pokeemerald's CB2_InitTrainerCard, cut down: DmaClear32 of a `vu32` stored `str r0,
    // [sp]` and published through `mov r2, sp`, DmaClear16 of a `vu16` at sp+4 (its read-back
    // dropped, which structuring otherwise refuses on both sides), and `gMain.state++` through a
    // phi of two loads of one literal. The phi's every address misses DMA3's control halfword, so
    // each read is bounded. Without the proof the read reaches the frame and the one object holds
    // it; the proof must not take that lift away. With `foo` declared to take no word, no call
    // takes a stack word, so the sp-direct store is the published `vu32`'s own (thumb.ts, beside
    // `noCallTakesAStackWord`) and each object stands on its own bytes, filled before its address
    // reaches the device.
    test('a window the miss proof bounds keeps the lift the unbounded read had', () => {
      const shared =
        'tc:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x8\n\tldr\tr3, .L9\n\tcmp\tr0, #1\n\tbhi\t.L7\n' +
        '\tcmp\tr0, #0\n\tbne\t.L2\n\tmov\tr1, #0xe0\n\tlsl\tr1, r1, #0x13\n\tmov\tr0, #0x0\n' +
        '\tstr\tr0, [sp]\n\tldr\tr0, .L9+0x4\n\tmov\tr2, sp\n\tstr\tr2, [r0]\n\tstr\tr1, [r0, #0x4]\n' +
        '\tldr\tr1, .L9+0x8\n\tstr\tr1, [r0, #0x8]\n\tldr\tr0, [r0, #0x8]\n\tmov\tr0, #0x87\n' +
        '\tlsl\tr0, r0, #0x3\n\tadd\tr1, r3, r0\n\tb\t.L5\n.L2:\n\tmov\tr2, #0xa0\n' +
        '\tlsl\tr2, r2, #0x13\n\tmov\tr0, #0\n\tadd\tr1, sp, #0x4\n\tstrh\tr0, [r1]\n' +
        '\tldr\tr0, .L9+0x4\n\tstr\tr1, [r0]\n\tstr\tr2, [r0, #0x4]\n\tldr\tr1, .L9+0xc\n' +
        '\tstr\tr1, [r0, #0x8]\n\tmov\tr2, #0x87\n\tlsl\tr2, r2, #0x3\n\tadd\tr1, r3, r2\n\tb\t.L5\n' +
        '.L7:\n\tbl\tfoo\n\tldr\tr1, .L9\n\tmov\tr0, #0x87\n\tlsl\tr0, r0, #0x3\n\tadd\tr1, r1, r0\n' +
        '.L5:\n\tldrb\tr0, [r1]\n\tadd\tr0, r0, #0x1\n\tstrb\tr0, [r1]\n\tadd\tsp, sp, #0x8\n' +
        '\tpop\t{r0}\n\tbx\tr0\n.L10:\n\t.align\t2, 0\n.L9:\n\t.word\t0x3002360\n\t.word\t0x40000d4\n' +
        '\t.word\t-0x7affff00\n\t.word\t-0x7efffe00\n';
      const src = decompile('tc', shared, ARMV4T_AGBCC, {
        prototypes: { tc: { params: ['s32'], returnsVoid: true }, foo: { params: [], returnsVoid: true } },
      }).source;
      expect(src).toContain('    volatile u32 sp0;\n    volatile u16 sp4;');
      expect(src).toContain('            sp0 = 0;\n            *(s32 *)67109076 = &sp0;');
      expect(src).toContain('            sp4 = 0;\n            *(s32 *)67109076 = &sp4;');
    });

    // …AND THE SAME WINDOW IS ASKED AS UNBOUNDED WHERE AN ESCAPE GATE REJECTS IT, not only where a
    // shape refuses. Compiled, `vu16 buf[2]; buf[0]=a; buf[1]=a+1; DMA3 = {&buf[1], 0x05000200,
    // 0x85000001}; gEnts[i].f = 1;` (gEnts a literal 0x03003440, stride 8): the 32-bit transfer off
    // sp+2 reaches buf[0] at sp+0 — a reach the per-object model refuses at the object gate. The
    // tail store misses the control halfword, so the window is bounded, but without that proof it
    // reaches the frame and the one object holds it; that lift stands.
    test('a gate that rejects a window the miss proof bounded still asks for the one object', () => {
      const v2 =
        'v2:\n\tadd\tsp, sp, #-0x4\n\tlsl\tr0, r0, #0x18\n\tlsl\tr1, r1, #0x10\n\tlsr\tr1, r1, #0x10\n' +
        '\tmov\tr2, sp\n\tldrh\tr3, [r2]\n\tstrh\tr1, [r2]\n\tadd\tr1, r1, #0x1\n\tldrh\tr3, [r2, #0x2]\n' +
        '\tstrh\tr1, [r2, #0x2]\n\tldr\tr2, .L3\n\tmov\tr1, sp\n\tadd\tr1, r1, #0x2\n\tstr\tr1, [r2]\n' +
        '\tadd\tr2, r2, #0x4\n\tldr\tr1, .L3+0x4\n\tstr\tr1, [r2]\n\tadd\tr2, r2, #0x4\n\tldr\tr1, .L3+0x8\n' +
        '\tstr\tr1, [r2]\n\tlsr\tr0, r0, #0x15\n\tldr\tr1, .L3+0xc\n\tadd\tr0, r0, r1\n\tmov\tr1, #0x1\n' +
        '\tstrb\tr1, [r0, #0x4]\n\tadd\tsp, sp, #0x4\n\tbx\tlr\n.L4:\n\t.align\t2, 0\n.L3:\n' +
        '\t.word\t0x40000d4\n\t.word\t0x5000200\n\t.word\t-0x7affffff\n\t.word\t0x3003440\n';
      const src = decompile('v2', v2, ARMV4T_AGBCC, {
        prototypes: { v2: { params: ['u8', 'u16'], returnsVoid: true } },
      }).source;
      expect(src).toContain('    u8 sp0[4];');
      expect(src).toContain('*(volatile s32 *)67109076 = (u32)sp0 + 2;');
      expect(src).toContain('((u8 *)((a0 << 3) + 50345024))[4] = 1;');
    });

    // THE MULTI-WORD ANALOGUE of the same hazard, which declines LOUDLY — but at the first gate it
    // meets, not at the rule that owns it, and the assertion pins only the former. Compiled,
    // `struct W { s32 a,b,c,d; }; void f(s32 x){ struct W w; w.a=x; w.b=x+1; w.c=x+2; w.d=x+3;
    // g(&w); use2(w.a+w.b+w.c+w.d); }`. Every extra word is another value a callee may write and
    // this function reads back, so what the refusal costs grows with the extent while what licenses
    // an acceptance does not.
    //
    // WHICH GATE, measured both ways, because the message is easy to read as an attribution and it
    // is not one. The outgoing-argument analysis passes it, and not because `mov r0, sp` is live in
    // r0 at the `bl` — the `g3` fixture above is a compiled frame where exactly that co-exists with
    // a genuine outgoing argument at [sp,#0], because the copy is a block-copy base. It is that all
    // four stores are RELOADED after the call: an outgoing argument is read by the callee and never
    // by the caller, so the four words are locals. The first gate is then the frame-object audit's
    // object/slot overlap. Widen `capturedObjectIsTheWholeFrame` to `localArea >= 4` and this same fixture
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
      expect(() => decompile('hazw', fourWords, ARMV4T_AGBCC)).toThrow(
        /the object at \[sp,#0\) overlaps the SSA slot at \[sp,#0\] — one byte, two models/,
      );
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
      expect(() => decompile('big3f', blockCopy, ARMV4T_AGBCC)).toThrow(
        /a struct returned through a hidden pointer is handed this same frame/,
      );
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
      // …and where `garr`'s return is said, the twelve bytes are one object the callee writes
      const voidGarr = { prototypes: { ...protos.prototypes, garr: { params: 1, returnsVoid: true } } };
      expect(decompile('arrf', arrf, ARMV4T_AGBCC, voidGarr).source).toContain('u8 sp0[12];');
    });

    // SEVERAL CAPTURES A CALLEE MAY WRITE THROUGH are one object: the whole declared area as one
    // byte array, each capture an address inside it. Two separate locals have no guaranteed
    // adjacency, and agbcc does not lay them out in declaration order (an array gets its slot at its
    // declaration, stmt.c expand_decl; a scalar only when `&` is parsed, c-typeck.c mark_addressable
    // → put_var_into_stack), so per-object declarations reorder the frame; one array has no order
    // to get wrong. agbcc's own output at the corpus's flags, and each lift below recompiles to the
    // same instructions.
    describe('several captures a callee writes through are one object', () => {
      const ret = '\tadd\tsp, sp, #0x8\n\tpop\t{r0}\n\tbx\tr0\n';
      // `u8 sp[4]; u32 sp4; if (two(a, sp, &sp4) <= 0) out(sp[0]);` — two out-parameters of one callee
      test('two out-parameters of one callee', () => {
        const outparams =
          'outparams:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr2, sp, #0x4\n\tmov\tr1, sp\n\tbl\ttwo\n' +
          `\tcmp\tr0, #0\n\tbgt\t.L3\n\tmov\tr0, sp\n\tldrb\tr0, [r0]\n\tbl\tout\n.L3:\n${ret}`;
        const prototypes = {
          two: { params: ['s32', 'u8 *', 'u32 *'], returns: 's32' },
          out: { params: ['u8'], returnsVoid: true },
        };
        const src = decompile('outparams', outparams, ARMV4T_AGBCC, { prototypes }).source;
        expect(src).toContain('u8 sp0[8];');
        expect(src).toContain('two(a0, sp0, (u32)sp0 + 4)');
        expect(src).toContain('out(*(u8 *)sp0)');
      });

      // `struct Pos p; outp(&p.x, &p.y); usepos(&p);` — the second capture is inside the object the
      // first names, and a per-object reading would split one six-byte struct into two halfwords
      test('an interior address of an object handed over whole', () => {
        const interior =
          'interior:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x8\n\tmov\tr1, sp\n\tadd\tr1, r1, #0x2\n\tmov\tr0, sp\n' +
          `\tbl\toutp\n\tmov\tr0, sp\n\tbl\tusepos\n${ret}`;
        const prototypes = {
          outp: { params: ['s16 *', 's16 *'], returnsVoid: true },
          usepos: { params: ['struct Pos *'], returnsVoid: true },
        };
        const src = decompile('interior', interior, ARMV4T_AGBCC, { prototypes }).source;
        expect(src).toContain('u8 sp0[8];');
        expect(src).toContain('outp(sp0, (u32)sp0 + 2);\n    usepos(sp0);');
      });

      // `u8 a[16], b[16]; memcpy(a, gS1, 16); memcpy(b, gS2, 16); return a[3] + b[5];` — verbatim
      // agbcc; each copy's destination is a writer the one object holds, and each copy's count
      // proves where its object starts and ends, so the one object is two, each named by element.
      // Handing `b` to a callee nothing bounds keeps it one.
      const copies = (second: string) =>
        'cpypair:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x20\n\tldr\tr1, .L3\n\tmov\tr0, sp\n\tmov\tr2, #0x10\n' +
        `\tbl\tmemcpy\n\tadd\tr4, sp, #0x10\n${second}\tmov\tr0, sp\n\tldrb\tr0, [r0, #0x3]\n` +
        '\tldrb\tr1, [r4, #0x5]\n\tadd\tr0, r0, r1\n\tadd\tsp, sp, #0x20\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n' +
        '\t.align\t2, 0\n.L3:\n\t.word\tgS1\n\t.word\tgS2\n';
      test('two arrays two copies fill are two objects', () => {
        const pair = copies('\tldr\tr1, .L3+0x4\n\tadd\tr0, r4, #0\n\tmov\tr2, #0x10\n\tbl\tmemcpy\n');
        const src = decompile('cpypair', pair, ARMV4T_AGBCC).source;
        expect(src).toContain('    u8 sp0[16];\n    u8 sp16[16];\n');
        expect(src).toContain('memcpy(sp0, &gS1, 16);\n    memcpy(sp16, &gS2, 16);\n    return sp0[3] + sp16[5];');
      });
      // …and at a RUNTIME index, whose reach the audit bounded inside `b` before it split the
      // object: the element of the part, `sp16[15 & a0]`, read and written, never the cast
      // `((u8 *)sp16)[15 & a0]` the one object's bytes get. Verbatim agbcc for
      // `return a[3] + b[i & 15];` and `b[i & 15] = v; return a[3] + b[5];`; each lift recompiles
      // to the same instructions.
      test('a runtime index into one of two copied arrays is an element of that part', () => {
        const head =
          '\tadd\tsp, sp, #-0x20\n\tadd\tr5, r0, #0\n\tldr\tr1, .L3\n\tmov\tr0, sp\n\tmov\tr2, #0x10\n\tbl\tmemcpy\n' +
          '\tadd\tr4, sp, #0x10\n\tldr\tr1, .L3+0x4\n\tadd\tr0, r4, #0\n\tmov\tr2, #0x10\n\tbl\tmemcpy\n';
        const pool = '\t.align\t2, 0\n.L3:\n\t.word\tgS1\n\t.word\tgS2\n';
        const read =
          `cpyidx:\n\tpush\t{r4, r5, lr}\n${head}\tmov\tr0, sp\n\tldrb\tr0, [r0, #0x3]\n\tmov\tr1, #0xf\n` +
          '\tand\tr1, r1, r5\n\tadd\tr4, r4, r1\n\tldrb\tr1, [r4]\n\tadd\tr0, r0, r1\n\tadd\tsp, sp, #0x20\n' +
          `\tpop\t{r4, r5}\n\tpop\t{r1}\n\tbx\tr1\n${pool}`;
        expect(decompile('cpyidx', read, ARMV4T_AGBCC).source).toContain('return sp0[3] + sp16[15 & a0];');
        const write =
          `cpyset:\n\tpush\t{r4, r5, r6, lr}\n${head.replace('\tldr\tr1, .L3\n', '\tadd\tr6, r1, #0\n\tldr\tr1, .L3\n')}` +
          '\tmov\tr0, #0xf\n\tand\tr0, r0, r5\n\tadd\tr0, r4, r0\n\tstrb\tr6, [r0]\n\tmov\tr0, sp\n' +
          '\tldrb\tr0, [r0, #0x3]\n\tldrb\tr1, [r4, #0x5]\n\tadd\tr0, r0, r1\n\tadd\tsp, sp, #0x20\n' +
          `\tpop\t{r4, r5, r6}\n\tpop\t{r1}\n\tbx\tr1\n${pool}`;
        expect(decompile('cpyset', write, ARMV4T_AGBCC).source).toContain(
          '    sp16[15 & a0] = a1;\n    return sp0[3] + sp16[5];',
        );
      });
      // …each part DECLARED with the element its accesses agree on (`stampPartElements`), so an
      // element of a `u16` or `s8` part is named bare too: u8 storage would hand the gate a type no
      // access reads, and the runtime index keeps `((u16 *)sp64)[…]`, which agbcc compiles with the
      // `sp + 64` re-formed at the read. Verbatim agbcc for `u16 a[32], b[32]` / `s8 a[64], b[64]`,
      // `memcpy` each, `sink(1, 2, 3, 4)`, `return a[3] + b[(i & 15) + 16]` (`+ 32` for s8); each
      // lift recompiles to the target's instructions. The s8 part's constant read is `ldrb; lsl;
      // asr` — no `ldrsb` takes an immediate — and it counts as the signed read it is.
      const pairOf64 = (name: string, regs: string, tail: string) =>
        `${name}:\n\tpush\t{${regs}, lr}\n\tadd\tsp, sp, #-0x80\n\tadd\tr5, r0, #0\n` +
        (regs === 'r4, r5, r6' ? '\tadd\tr6, r1, #0\n' : '') +
        `\tldr\tr1, .L3\n\tmov\tr0, sp\n\tmov\tr2, #0x40\n\tbl\tmemcpy\n\tadd\tr4, sp, #0x40\n` +
        '\tldr\tr1, .L3+0x4\n\tadd\tr0, r4, #0\n\tmov\tr2, #0x40\n\tbl\tmemcpy\n' +
        '\tmov\tr0, #0x1\n\tmov\tr1, #0x2\n\tmov\tr2, #0x3\n\tmov\tr3, #0x4\n\tbl\tsink\n' +
        `${tail}\tadd\tsp, sp, #0x80\n\tpop\t{${regs}}\n\tpop\t{r1}\n\tbx\tr1\n` +
        '\t.align\t2, 0\n.L3:\n\t.word\tgS1\n\t.word\tgS2\n';
      const prototypes = { sink: { params: ['u32', 'u32', 'u32', 'u32'], returnsVoid: true } };
      test('a part whose every access is one element is declared that element', () => {
        const halves = pairOf64(
          'cpyh',
          'r4, r5',
          '\tmov\tr0, sp\n\tldrh\tr0, [r0, #0x6]\n\tmov\tr1, #0xf\n\tand\tr1, r1, r5\n\tadd\tr1, r1, #0x10\n' +
            '\tlsl\tr1, r1, #0x1\n\tadd\tr4, r4, r1\n\tldrh\tr1, [r4]\n\tadd\tr0, r0, r1\n',
        );
        const h = decompile('cpyh', halves, ARMV4T_AGBCC, { prototypes }).source;
        expect(h).toContain('    u16 sp0[32];\n    u16 sp64[32];\n');
        expect(h).toContain('return sp0[3] + sp64[(15 & a0) + 16];');
        const bytes = pairOf64(
          'cpysb',
          'r4, r5',
          '\tmov\tr0, sp\n\tldrb\tr0, [r0, #0x3]\n\tlsl\tr0, r0, #24\n\tasr\tr0, r0, #24\n\tmov\tr1, #0xf\n' +
            '\tand\tr1, r1, r5\n\tadd\tr1, r1, #0x20\n\tadd\tr4, r4, r1\n\tmov\tr1, #0x0\n\tldrsb\tr1, [r4, r1]\n' +
            '\tadd\tr0, r0, r1\n',
        );
        const b = decompile('cpysb', bytes, ARMV4T_AGBCC, { prototypes }).source;
        expect(b).toContain('    s8 sp0[64];\n    s8 sp64[64];\n');
        expect(b).toContain('return sp0[3] + sp64[(15 & a0) + 32];');
      });
      test('a part read at both extensions keeps the storage default, and its cast', () => {
        // `… + b[(i & 15) + 32] + ((u8 *)b)[j & 15]` on `s8 b[64]`: no evidence picks one element
        const mixed = pairOf64(
          'cpymix',
          'r4, r5, r6',
          '\tmov\tr0, sp\n\tldrb\tr0, [r0, #0x3]\n\tlsl\tr0, r0, #24\n\tasr\tr0, r0, #24\n\tmov\tr2, #0xf\n' +
            '\tand\tr5, r5, r2\n\tadd\tr5, r5, #0x20\n\tadd\tr1, r4, r5\n\tmov\tr3, #0x0\n\tldrsb\tr1, [r1, r3]\n' +
            '\tand\tr6, r6, r2\n\tadd\tr4, r4, r6\n\tadd\tr0, r0, r1\n\tldrb\tr4, [r4]\n\tadd\tr0, r0, r4\n',
        );
        const m = decompile('cpymix', mixed, ARMV4T_AGBCC, { prototypes }).source;
        expect(m).toContain('    s8 sp0[64];\n    u8 sp64[64];\n');
        expect(m).toContain('sp64[a1 & 15]');
        expect(m).not.toContain('sp64[(a0 & 15) + 32]');
      });
      // the same pair with eight values live across two `sink` calls, at agbcc -O2: reload puts the
      // eighth one's spill slot ABOVE the arrays, at [sp,#0x20] (the Thumb frame grows up). Kept in
      // the one object it would join `b`; handed back to the slot model (`reliftRange`), it is a
      // local again and the copies tile what is left.
      test('a spill slot above two copied arrays goes back to the slot model, and the arrays split', () => {
        const spill =
          '\t.align\t2, 0\n' +
          '\t.thumb_func\n' +
          'f:\n' +
          '\tpush\t{r4, r5, r6, r7, lr}\n' +
          '\tmov\tr7, sl\n' +
          '\tmov\tr6, r9\n' +
          '\tmov\tr5, r8\n' +
          '\tpush\t{r5, r6, r7}\n' +
          '\tadd\tsp, sp, #-0x24\n' +
          '\tldr\tr1, .L3\n' +
          '\tmov\tr0, sp\n' +
          '\tmov\tr2, #0x10\n' +
          '\tbl\tmemcpy\n' +
          '\tadd\tr4, sp, #0x10\n' +
          '\tldr\tr1, .L3+0x4\n' +
          '\tadd\tr0, r4, #0\n' +
          '\tmov\tr2, #0x10\n' +
          '\tbl\tmemcpy\n' +
          '\tmov\tr0, sp\n' +
          '\tldrb\tr0, [r0, #0x3]\n' +
          '\tldrb\tr1, [r4, #0x5]\n' +
          '\tadd\tr0, r0, r1\n' +
          '\tldr\tr1, .L3+0x8\n' +
          '\tstr\tr0, [r1]\n' +
          '\tldr\tr0, .L3+0xc\n' +
          '\tldr\tr4, [r0]\n' +
          '\tldr\tr5, [r0, #0x4]\n' +
          '\tldr\tr6, [r0, #0x8]\n' +
          '\tldr\tr1, [r0, #0xc]\n' +
          '\tmov\tr8, r1\n' +
          '\tldr\tr1, [r0, #0x10]\n' +
          '\tmov\tr9, r1\n' +
          '\tldr\tr1, [r0, #0x14]\n' +
          '\tmov\tsl, r1\n' +
          '\tldr\tr7, [r0, #0x18]\n' +
          '\tldr\tr0, [r0, #0x1c]\n' +
          '\tstr\tr0, [sp, #0x20]\n' +
          '\tadd\tr0, r4, #0\n' +
          '\tadd\tr1, r5, #0\n' +
          '\tadd\tr2, r6, #0\n' +
          '\tmov\tr3, r8\n' +
          '\tbl\tsink\n' +
          '\tmov\tr0, r9\n' +
          '\tmov\tr1, sl\n' +
          '\tadd\tr2, r7, #0\n' +
          '\tldr\tr3, [sp, #0x20]\n' +
          '\tbl\tsink\n' +
          '\tadd\tr4, r4, r5\n' +
          '\tadd\tr4, r4, r6\n' +
          '\tadd\tr4, r4, r8\n' +
          '\tadd\tr4, r4, r9\n' +
          '\tadd\tr4, r4, sl\n' +
          '\tadd\tr4, r4, r7\n' +
          '\tldr\tr0, [sp, #0x20]\n' +
          '\tadd\tr4, r4, r0\n' +
          '\tldr\tr1, .L3+0x8\n' +
          '\tstr\tr4, [r1]\n' +
          '\tadd\tsp, sp, #0x24\n' +
          '\tpop\t{r3, r4, r5}\n' +
          '\tmov\tr8, r3\n' +
          '\tmov\tr9, r4\n' +
          '\tmov\tsl, r5\n' +
          '\tpop\t{r4, r5, r6, r7}\n' +
          '\tpop\t{r0}\n' +
          '\tbx\tr0\n' +
          '.L4:\n' +
          '\t.align\t2, 0\n' +
          '.L3:\n' +
          '\t.word\tgS1\n' +
          '\t.word\tgS2\n' +
          '\t.word\tgOut\n' +
          '\t.word\tgA\n';
        const prototypes = { sink: { params: 4, returnsVoid: true }, f: { returnsVoid: true } };
        const src = decompile('f', spill, ARMV4T_AGBCC, { prototypes }).source;
        expect(src).toContain('    u8 sp0[16];\n    u8 sp16[16];\n');
        expect(src).toContain('sink(v4, v5, v6, v7);');
        expect(src).not.toContain('sp32');
      });
      // `u8 s[36]; memcpy(s, gS1, 16); memcpy(s + 16, gS2, 16); *(u32 *)(s + 32) = x; return
      // s[16 + i];` at agbcc -O2: the word at [sp,#0x20] is spelled as a spill slot is, but the
      // index may reach it. Handed back to the slot model it is a local nothing reads, so the
      // recompile drops the store an index into the frame may read; kept, it stays memory.
      //
      // A MASKED index reaches only the bytes its range names: `s[16 + (i & 15)]` reads [16, 32)
      // and never the word at 32, which goes back to the slot model as the spill slot it is
      // spelled as; `s[16 + (i & 31)]` reaches [16, 48), the word included, and keeps it.
      test('a word a runtime index may reach is not handed back to the slot model', () => {
        const reached =
          '\t.align\t2, 0\n' +
          '\t.thumb_func\n' +
          'f:\n' +
          '\tpush\t{r4, r5, lr}\n' +
          '\tadd\tsp, sp, #-0x24\n' +
          '\tadd\tr4, r0, #0\n' +
          '\tadd\tr5, r1, #0\n' +
          '\tldr\tr1, .L3\n' +
          '\tmov\tr0, sp\n' +
          '\tmov\tr2, #0x10\n' +
          '\tbl\tmemcpy\n' +
          '\tldr\tr1, .L3+0x4\n' +
          '\tadd\tr0, sp, #0x10\n' +
          '\tmov\tr2, #0x10\n' +
          '\tbl\tmemcpy\n' +
          '\tstr\tr5, [sp, #0x20]\n' +
          '\tadd\tr4, r4, #0x10\n' +
          '\tmov\tr1, sp\n' +
          '\tadd\tr0, r1, r4\n' +
          '\tldrb\tr0, [r0]\n' +
          '\tadd\tsp, sp, #0x24\n' +
          '\tpop\t{r4, r5}\n' +
          '\tpop\t{r1}\n' +
          '\tbx\tr1\n' +
          '.L4:\n' +
          '\t.align\t2, 0\n' +
          '.L3:\n' +
          '\t.word\tgS1\n' +
          '\t.word\tgS2\n';
        const prototypes = { f: { params: 2 } };
        const src = decompile('f', reached, ARMV4T_AGBCC, { prototypes }).source;
        expect(src).toMatch(/\)\[\d+\] = a1;/);
        const masked = (mask: number) =>
          reached.replace('\tadd\tr4, r4, #0x10\n', `\tmov\tr0, #${mask}\n\tand\tr4, r0\n\tadd\tr4, r4, #0x10\n`);
        const inside = decompile('f', masked(15), ARMV4T_AGBCC, { prototypes }).source;
        expect(inside).toContain('u8 sp0[32];');
        expect(inside).not.toContain('= a1;');
        expect(inside).toContain('return ((u8 *)sp0)[(a0 & 15) + 16];');
        const across = decompile('f', masked(31), ARMV4T_AGBCC, { prototypes }).source;
        expect(across).toContain('u8 sp0[36];');
        expect(across).toContain('((s32 *)sp0)[8] = a1;');
        // …and so does a byte shifted down: `s[16 + (*p >> 4)]` reads [16, 32), `s[16 + (*p >> 3)]`
        // [16, 48)
        const shifted = (by: number) =>
          reached.replace('\tadd\tr4, r4, #0x10\n', `\tldrb\tr4, [r4]\n\tlsr\tr4, r4, #${by}\n\tadd\tr4, r4, #0x10\n`);
        const narrow = decompile('f', shifted(4), ARMV4T_AGBCC, { prototypes }).source;
        expect(narrow).toContain('u8 sp0[32];');
        expect(narrow).not.toContain('= a1;');
        const wide = decompile('f', shifted(3), ARMV4T_AGBCC, { prototypes }).source;
        expect(wide).toContain('u8 sp0[36];');
        expect(wide).toContain('((s32 *)sp0)[8] = a1;');
      });
      test('an array a callee nothing bounds is handed keeps the one object', () => {
        const handed = copies('\tadd\tr0, r4, #0\n\tbl\tfill\n');
        const prototypes = { fill: { params: ['u8 *'], returnsVoid: true } };
        const src = decompile('cpypair', handed, ARMV4T_AGBCC, { prototypes }).source;
        expect(src).toContain('u8 sp0[32];');
        expect(src).not.toContain('sp16');
      });

      // `u16 *a; u16 *b; pair(&a, &b); eight(1, 2, 3, 4, 5, 6, 7); use2(b);` — the two objects
      // sit above the three outgoing argument words `eight` reads at [sp,#0..#8]
      test('two captures above an outgoing argument block', () => {
        const abovearg =
          'abovearg:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x14\n\tadd\tr1, sp, #0x10\n\tadd\tr0, sp, #0xc\n\tbl\tpair\n' +
          '\tmov\tr0, #0x5\n\tstr\tr0, [sp]\n\tmov\tr0, #0x6\n\tstr\tr0, [sp, #0x4]\n\tmov\tr0, #0x7\n\tstr\tr0, [sp, #0x8]\n' +
          '\tmov\tr0, #0x1\n\tmov\tr1, #0x2\n\tmov\tr2, #0x3\n\tmov\tr3, #0x4\n\tbl\teight\n\tldr\tr0, [sp, #0x10]\n' +
          '\tbl\tuse2\n\tadd\tsp, sp, #0x14\n\tpop\t{r0}\n\tbx\tr0\n';
        const prototypes = {
          pair: { params: ['u16 **', 'u16 **'], returnsVoid: true },
          eight: { params: 7, returnsVoid: true },
          use2: { params: ['u16 *'], returnsVoid: true },
        };
        const src = decompile('abovearg', abovearg, ARMV4T_AGBCC, { prototypes }).source;
        expect(src).toContain('u8 sp12[8];');
        expect(src).toContain('pair(sp12, (u32)sp12 + 4);');
        expect(src).toContain('eight(1, 2, 3, 4, 5, 6, 7);\n    use2(((s32 *)sp12)[1]);');
      });
    });

    // …AND THE OTHER CONJUNCT, which is the one a wide frame actually meets. This gate needs the
    // base LIVE IN AN ARGUMENT REGISTER AT A `bl`; the DMA-fill idiom PUBLISHES the base to a
    // device register instead, and that path never asks the gate anything. So a published capture
    // in a frame far wider than one word lifts, slots above it and all.
    //
    // The slots above it survive on the DEVICE, not on the frame: a word store to a DMA SOURCE
    // register is `readsThrough`, so this capture is never in `mayWrite`, and a literal control
    // word saying the source is FIXED keeps the slots above it out of what the device reads. Publish
    // the same base to an ordinary global and both refuse — the test above.
    //
    // Compiled, frame 0xc, with the two incoming pointers spilled into the slots above the object:
    // `void dmawide(u16 *dst, s32 n){ vu16 tmp; s32 t0..t7; tmp = 0; t0 = h(0); … t7 = h(7);
    // use2(t0 + … + t7 + n); REG_DMA3[0] = (u32)&tmp; REG_DMA3[1] = (u32)dst; REG_DMA3[2] =
    // 0x81000010; }`. The arities are declared because a GUESSED four-argument `h` reads
    // the register that still holds the base as an argument, and the object is then "passed to a
    // callee" on the strength of a guess — the same lower-bound trap `--proto` exists for.
    test('a PUBLISHED capture in a wider frame lifts — this gate governs the callee-passed one', () => {
      const dmawide = (sum: string, dma: string) =>
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
        '\tadd\tr4, r4, r7\n\tadd\tr4, r4, sl\n\tadd\tr4, r4, r9\n\tadd\tr4, r4, r8\n' +
        '\tadd\tr4, r4, r6\n\tadd\tr4, r4, r5\n\tadd\tr4, r4, r0\n' +
        sum +
        '\tadd\tr0, r4, #0\n\tbl\tuse2\n' +
        '\tldr\tr0, .L9\n\tmov\tr1, sp\n\tstr\tr1, [r0]\n\tadd\tr0, r0, #0x4\n' +
        dma +
        '\tadd\tsp, sp, #0xc\n' +
        '\tpop\t{r3, r4, r5}\n\tmov\tr8, r3\n\tmov\tr9, r4\n\tmov\tsl, r5\n' +
        '\tpop\t{r4, r5, r6, r7}\n\tpop\t{r0}\n\tbx\tr0\n' +
        '.L10:\n\t.align\t2, 0\n.L9:\n\t.word\t0x40000d4\n\t.word\t0x40000dc\n\t.word\t-0x7efffff0\n';
      const protos = { prototypes: { h: { params: 1 }, use2: { params: 1 } } };
      const literal = dmawide(
        '\tldr\tr0, [sp, #0x8]\n\tadd\tr4, r4, r0\n',
        '\tldr\tr1, [sp, #0x4]\n\tstr\tr1, [r0]\n\tldr\tr1, .L9+0x4\n\tldr\tr0, .L9+0x8\n\tstr\tr0, [r1]\n',
      );
      const src = decompile('dmawide', literal, ARMV4T_AGBCC, protos).source;
      expect(src).toContain('volatile u16 sp0;');
      expect(src).toContain('*(s32 *)67109076 = &sp0;');
      // …and a count ORed in at run time bounds nothing: `n | 0x81000000` may carry any source
      // mode, so the device may read the spilled `dst` and `n` above the object, and all three are
      // kept as one object in memory. Verbatim agbcc again, the same body with `n` moved from the
      // sum into `REG_DMA3[2] = n | 0x81000000`.
      const runtimeCount = dmawide(
        '',
        '\tldr\tr2, [sp, #0x4]\n\tstr\tr2, [r0]\n\tldr\tr1, .L9+0x4\n\tmov\tr0, #0x81\n\tlsl\tr0, r0, #0x18\n' +
          '\tldr\tr2, [sp, #0x8]\n\torr\tr0, r0, r2\n\tstr\tr0, [r1]\n',
      );
      const kept = decompile('dmawide', runtimeCount, ARMV4T_AGBCC, protos).source;
      expect(kept).toContain('    u8 sp0[12];');
      expect(kept).toContain('((s32 *)sp0)[1] = a0;');
      expect(kept).toContain('((s32 *)sp0)[2] = a1;');
      expect(kept).toContain('*(volatile s32 *)67109084 = 129 << 24 | ((s32 *)sp0)[2];');
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
});
