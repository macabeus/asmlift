// A 64-bit value coming out of a CALL, which is how one enters the IR on agbcc: it has no 64-bit
// instruction, so a pair lives in registers on either side of a `bl`.
//
// TWO SOURCES SAY WHICH CALLS HAND ONE BACK, and they are the two kinds of thing a caller can be
// told. The compiler's own runtime-helper table needs no header — `__muldi3`'s signature is its
// compiler's — and is what the tests here are mostly about. A project's CALLEE needs one, and
// `FnProto.returns` is where a header states it; that source has its own describe at the bottom.
//
// Three things have to hold together for that to become `a * b`, and each has its own test below:
// the helper table states each C parameter's WIDTH so the frontend reads a register pair as one
// value; the call's own result is split back into the pair and the two halves are named, which is
// the ACCEPTANCE arm of the refusal in `frontend/ssa.ts`; and the parameters the pair came from are
// fused into one, which is what makes the signature `s64` rather than four words.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { type FnProto, type Prototypes, wordsOf } from '../src/proto';
import { enumerateCandidates } from '../src/rank';
import { AGBCC_RUNTIME_HELPERS, helperPrototypes, isWideHelper } from '../src/runtime-helpers';
import { ARMV4T_AGBCC } from '../src/target';

const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-int64-helpers.s'), 'utf8');
const lift = (name: string) => decompile(name, asm, ARMV4T_AGBCC).source;

/** Callers of callees whose names are members of `Object.prototype`, which a C symbol may be. */
const objectProtoCallers = (...names: string[]) =>
  names
    .map((sym) =>
      ['\t.code\t16', `\t.globl\tcalls_${sym}`, '\t.thumb_func', `calls_${sym}:`, '\tpush\t{lr}']
        .concat([`\tbl\t${sym}`, '\tpop\t{r2}', '\tbx\tr2'])
        .join('\n'),
    )
    .join('\n');

describe('a register pair read as one value', () => {
  test('a 64-bit helper recovers the operation, not the call', () => {
    expect(lift('llmul')).toBe('s64 llmul(s64 a0, s64 a1) {\n    return a0 * a1;\n}\n');
  });

  test('the WIDEN is a pair shape, and it says which extension the machine performed', () => {
    // `asr rN,rM,#31` per half is the signed one. The callee name cannot say: agbcc's libgcc has
    // no `__umuldi3`, so the unsigned spelling calls this very helper.
    expect(lift('llmulw')).toBe('s64 llmulw(s32 a0, s32 a1) {\n    return (s64)a0 * (s64)a1;\n}\n');
  });

  // …AND THE `asr` KEEPS SAYING IT WHEN THE DECLARATION DISAGREES. The signedness variation
  // declares the parameters `u32`, and a widen that renders as `(s64)a0` over one of those says
  // ZERO-extend — reading the extension off the declaration instead of off the instruction. Both
  // candidates of the pair must spell the same machine fact, so the cast is pinned where the
  // operand does not already carry it, exactly as the compare operands are.
  test('the extension survives a signedness variation that contradicts it', () => {
    const spelt = new Map(
      enumerateCandidates('llmulw', asm, ARMV4T_AGBCC, {}).map((c) => [c.variations.join('+'), c.source]),
    );
    expect(spelt.get('signed')).toContain('(s64)a0 * (s64)a1');
    expect(spelt.get('unsigned')).toContain('(s64)(s32)a0 * (s64)(s32)a1');
  });

  // THE HIGH HALF OF THE RESULT, which is the projection whose C spelling constrains its operand:
  // `x >> 32` is undefined unless `x` renders wider than 32 bits. Here the fold has already put a
  // multiply over two 64-bit parameters there, so the rank is present and no cast is written —
  // the end-to-end half of the rule `test/int64-repr.test.ts` states over hand-built IR, on real
  // agbcc output, and the half that fails if the shift's operand is cast unconditionally.
  test('the high half of a pair the helper returned shifts without a cast', () => {
    expect(lift('himul')).toBe('s32 himul(s64 a0, s64 a1) {\n    return (s32)(a0 * a1 >> 32);\n}\n');
  });
});

describe('what refuses', () => {
  // `b` is BOTH the shift count and an addend, so it is a word this function uses as a word.
  test('a parameter used on its own is a word, and is not fused into a pair', () => {
    const src = lift('llhalfuse');
    expect(src).toContain('s64 a0, s32 a1');
    expect(src).not.toContain('s64 a1');
  });

  // THE WIDTH IS THE EPILOGUE'S, and these two functions are the same four instructions apart
  // from which register the scratch pop names. `pop {r2}` cannot touch the return pair; `pop {r1}`
  // fills its high register with the return ADDRESS. Nothing in the value graph can tell them
  // apart, because this frontend models no write for a `pop` at all.
  test('a pair the epilogue pops over is not a 64-bit return', () => {
    expect(lift('lomul')).toBe('s32 lomul(s64 a0, s64 a1) {\n    return (s32)(a0 * a1);\n}\n');
  });

  test('…and the twin that pops elsewhere still is one', () => {
    expect(lift('llmul')).toBe('s64 llmul(s64 a0, s64 a1) {\n    return a0 * a1;\n}\n');
  });

  // A CALL DESTROYS THE HIGH HALF WITHOUT NAMING IT — r1 is caller-saved. agbcc cannot build this
  // shape (a 64-bit return keeps both halves across the call; a 32-bit one carries the epilogue
  // above), so the inhabitant is hand-written asm, which is what the playground lifts. `sink` is
  // declared void-of-nothing so that the call reads no argument register: with an arity to guess
  // it would read the low half and hit the refusal below instead, and then this would be testing
  // that one.
  const handWritten = (mid: string[]) =>
    ['\t.code\t16', '\t.globl\tlokeep', '\t.thumb_func', 'lokeep:', '\tpush\t{r4, lr}', '\tbl\t__muldi3', ...mid]
      .concat(['\tadd\tr0, r4, #0', '\tpop\t{r4}', '\tpop\t{pc}', ''])
      .join('\n');

  test('a call between the pair and the return takes the high half with it', () => {
    const src = decompile('lokeep', handWritten(['\tadd\tr4, r0, #0', '\tbl\tsink']), ARMV4T_AGBCC, {
      prototypes: { sink: { params: 0 } },
    }).source;
    expect(src).toMatch(/^s32 lokeep\(/);
  });

  test('…and with nothing in between, the same shape returns the pair', () => {
    const src = decompile('lokeep', handWritten(['\tadd\tr4, r0, #0']), ARMV4T_AGBCC, {
      prototypes: { sink: { params: 0 } },
    }).source;
    expect(src).toMatch(/^s64 lokeep\(/);
  });

  // A HALF THE FUNCTION ALSO USES ON ITS OWN IS A WORD. `add r4,r0,#0` copies out r0, which is
  // also the low half of the pair the `concat` names, so fusing that pair into one parameter would
  // delete the copy's operand. The refusal leaves the `concat` standing and it reaches the loud gap
  // at the bottom, which is the answer a shape with no C spelling is supposed to get.
  //
  // `llhalfuse` above does NOT pin this: its lone word arrives in r2, a third argument register
  // that is no part of the pair, so it never reaches the use-count condition at all.
  test('a pair one of whose halves is separately copied out is not fused', () => {
    expect(() => decompile('halfshare', asm, ARMV4T_AGBCC)).toThrow(/no lowering for op 'concat'/);
  });

  // THE CALL BOUNDARY IS WHERE THE PAIR STOPS WHEN NOTHING STATES A WIDTH. Handing a half to such
  // a callee is the wrong answer that recompiles to the right bytes, so it declines.
  test('a half handed to an ordinary callee declines, and names the half', () => {
    expect(() => decompile('lokeep', handWritten(['\tbl\tsink']), ARMV4T_AGBCC)).toThrow(
      /argument 1 of the call to 'sink' is the low half of a 64-bit value/,
    );
  });

  // A PAIR SPLIT ACROSS THE REGISTER/STACK BOUNDARY is a placement this frontend does not build:
  // agbcc puts the low half in r3 and the high half at [sp,#0]. The declaration is readable and
  // the block is the right size, so nothing else would stop it — the walk would read `r4`, which
  // is an argument register on no target here.
  //
  // THE ORDINAL IS THE PARAMETER'S AND THE POSITION IS THE WORD'S, and the message has to keep
  // them apart: with an EARLIER wide parameter they are different numbers, and printing the word
  // index as a parameter number sends a reader to the wrong entry of their own header.
  test('a declared pair that does not fit in the argument registers refuses, naming the parameter', () => {
    const declared = (params: string[]) =>
      decompile('lokeep', handWritten(['\tbl\tsink']), ARMV4T_AGBCC, {
        prototypes: { sink: { params, returnsVoid: true } },
      });
    expect(() => declared(['s32', 's32', 's32', 'long long'])).toThrow(
      /one half of a 64-bit value would be handed to `sink` outside the argument registers — its parameter 4 is 64 bits wide and takes argument words 4 and 5 of a call with 4 argument register\(s\), so the low half is in r3 and the upper half in this frame's outgoing stack block/,
    );
    // PARAMETER 3, WORD 4 — the ordinal and the position part company at the first wide parameter,
    // and an earlier version of this message printed `at + 1` for both.
    expect(() => declared(['long long', 's32', 'long long'])).toThrow(
      /handed to `sink` outside the argument registers — its parameter 3 is 64 bits wide/,
    );
    // WHOLLY IN THE FRAME is the other shape the comment above names and the message did not: at
    // word 5 of 4 registers NOTHING is in a register, so "one half lands in the frame and the
    // other in a register" was false about its own input, and it cited an argument register that
    // does not exist.
    expect(() => declared(['s32', 's32', 's32', 's32', 'long long'])).toThrow(
      /its parameter 5 is 64 bits wide and takes argument words 5 and 6 .* so both halves are in this frame's outgoing stack block/,
    );
  });
});

// THE OUTGOING HALF OF THE SAME ABI FACT. A helper table states its parameters' widths, and so
// does a project's header — the frontend reads ONE list of widths, from whichever source has it,
// and builds the pair the same way for both.
describe('a declared 64-bit parameter crosses a call as one value', () => {
  const src = (asmText: string, prototypes: Record<string, FnProto>) =>
    decompile('f', asmText, ARMV4T_AGBCC, { prototypes }).source;
  // `void f(…) { sink(…); }` — the body is the `bl` alone, so what the arguments are is entirely
  // the declaration's doing and nothing else can be scoring.
  const call = 'f:\n\tpush\t{lr}\n\tbl\tsink\n\tpop\t{r1}\n\tbx\tr1\n';

  test('a pair arriving in r0:r1 leaves in r0:r1, as one argument', () => {
    expect(
      src(call, {
        f: { params: ['long long'], returnsVoid: true },
        sink: { params: ['long long'], returnsVoid: true },
      }),
    ).toBe('void f(s64 a0) {\n    sink(a0);\n}\n');
  });

  // THE WITNESS THAT SEPARATES TWO PLAUSIBLE ABIs, and nothing else in this tree could: every
  // shipped helper entry is [64,64], [64,32] or [64], all of which land identically whether or not
  // the ABI aligns. agbcc does NOT align — `thumb.h` computes the register from a plain byte
  // counter with no rounding — so `void sink(s32, long long)` takes r0 and the pair r1:r2. An
  // AAPCS-aligned model pads to r2:r3, reads r3 (which this function never writes) as the high
  // half, and spells a different call.
  test('a mixed signature packs: the pair is r1:r2, not r2:r3', () => {
    const packed =
      'f:\n\tpush\t{lr}\n\tmov\tr0, #0x1\n\tmov\tr1, #0x2\n\tmov\tr2, #0x0\n\tbl\tsink\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(
      src(packed, { f: { returnsVoid: true }, sink: { params: ['s32', 'long long'], returnsVoid: true } }),
    ).toContain('sink(1, (s64)(u32)2)');
  });

  test('…and the same signature carries its parameters through unchanged', () => {
    expect(
      src(call, {
        f: { params: ['s32', 'long long'], returnsVoid: true },
        sink: { params: ['s32', 'long long'], returnsVoid: true },
      }),
    ).toBe('void f(s32 a0, s64 a1) {\n    sink(a0, a1);\n}\n');
  });
});

// A COUNT IS NOT A WIDTH. The evidence a fold rests on is the register PAIR the frontend built,
// and a call can carry the right number of operands without one — here because the arity came off
// a caller-supplied prototype, so no pair was ever built. Folding it publishes a 32-bit multiply
// of two words for a 64-bit multiply of two register pairs, which compiles and scores.
describe('a 64-bit fold needs the widths, not the arity', () => {
  test('a prototype for a wide helper declines; it does not silently narrow the operation', () => {
    // Two C parameters is the header spelling and the one a user reaches for after reading
    // `no model for the runtime helper '__muldi3'`; four is the word arity. `validatePrototypes`
    // accepts all three, and all three must decline.
    for (const params of [['s64', 's64'], 2, 4] as FnProto['params'][]) {
      expect(() => decompile('llmul', asm, ARMV4T_AGBCC, { prototypes: { __muldi3: { params } } })).toThrow(
        /no model for the runtime helper '__muldi3'/,
      );
    }
  });

  test('…and with no prototype the same function recovers the 64-bit multiply', () => {
    expect(lift('llmul')).toBe('s64 llmul(s64 a0, s64 a1) {\n    return a0 * a1;\n}\n');
  });
});

// A C function may be named `toString`, and both helper tables are object literals — so a bare
// index answers with a `Function` off `Object.prototype`. The wrong answer is not a wrong value
// here but a wrong CHANNEL: an internal TypeError out of `isWideHelper`, and on the target whose
// table was read with `in`, a decline whose stated reason names a runtime helper that does not
// exist. Both must be an ordinary call.
describe('the helper table is read by name, not by prototype chain', () => {
  test('a callee named after an Object.prototype member is an ordinary call', () => {
    const asmOf = objectProtoCallers('toString', 'valueOf', 'hasOwnProperty', 'constructor');
    for (const sym of ['toString', 'valueOf', 'hasOwnProperty', 'constructor']) {
      expect(decompile(`calls_${sym}`, asmOf, ARMV4T_AGBCC).source).toContain(`${sym}(`);
    }
  });
});

describe('the table says what a helper takes, in widths and not in words', () => {
  test('a 64-bit parameter is one C parameter and two argument registers', () => {
    expect(wordsOf([64, 32])).toBe(3);
    expect(wordsOf([32, 32])).toBe(2);
    expect(helperPrototypes(AGBCC_RUNTIME_HELPERS).__ashrdi3).toEqual({ params: 3 });
    expect(helperPrototypes(AGBCC_RUNTIME_HELPERS).__divsi3).toEqual({ params: 2 });
  });

  test('the 32-bit soft divisions are not wide, and the 64-bit family is', () => {
    expect(isWideHelper(AGBCC_RUNTIME_HELPERS.__divsi3)).toBe(false);
    expect(isWideHelper(AGBCC_RUNTIME_HELPERS.__muldi3)).toBe(true);
    expect(isWideHelper(AGBCC_RUNTIME_HELPERS.__negdi2)).toBe(true);
  });

  test('the DIVISIONS split on the name and the MULTIPLY does not', () => {
    expect(AGBCC_RUNTIME_HELPERS.__divdi3.op).toBe('sdiv');
    expect(AGBCC_RUNTIME_HELPERS.__udivdi3.op).toBe('udiv');
    // One multiply libfunc, both spellings — so there is no `__umuldi3` entry to disagree with.
    expect(AGBCC_RUNTIME_HELPERS.__muldi3.op).toBe('mul');
    expect(AGBCC_RUNTIME_HELPERS.__umuldi3).toBeUndefined();
  });
});

// A PAIR A DECLARATION SAYS COMES BACK — the other source, and the acceptance arm of
// `frontend/ssa.ts`'s stale-read refusal reached from a header rather than from the helper table.
//
// The refusal itself is right about the bytes: `mov r3,#0x2a ; bl callee ; add r4,r3,#0` must not
// lift to `return 42`, because agbcc's `thumb.h:405` marks r0–r3 caller-clobbered and the callee
// destroyed r3. What it could not tell apart is `thumb.h:655`/`:657`, which return a DImode value
// in the register pair from r0 — so after a `bl` to a callee that returns 64 bits, r1 is the
// returned HIGH half and reading it is not stale at all. Those two are the same instructions, so
// nothing in the assembly separates them and the caller has to be told.
describe('a pair a declaration says comes back', () => {
  // agbcc -O2 -mthumb-interwork -fhex-asm -fprologue-bugfix, from:
  //   long long llsrc(void);
  //   int llfrom(void){ return (int)(llsrc() >> 32); }
  const llfrom = ['\t.code\t16', '\t.globl\tllfrom', '\t.thumb_func', 'llfrom:', '\tpush\t{lr}']
    .concat(['\tbl\tllsrc', '\tadd\tr0, r1, #0', '\tpop\t{r1}', '\tbx\tr1', ''])
    .join('\n');
  const liftWith = (prototypes: Prototypes) => decompile('llfrom', llfrom, ARMV4T_AGBCC, { prototypes }).source;

  test('a declared 64-bit return makes the high register the callee’s, not a stale read', () => {
    expect(liftWith({ llsrc: { params: [], returns: 'long long' } })).toBe(
      's32 llfrom(void) {\n    return (s32)((s64)llsrc() >> 32);\n}\n',
    );
  });

  // THE HALF THAT FAILS IF THE GUARD IS WIDENED INSTEAD OF INFORMED. Every one of these declares
  // the callee as fully as the vocabulary allowed before `returns` existed, and every one must
  // still refuse: the same bytes, and nothing in them says a pair came back.
  test.each([
    ['nothing declared', {}],
    ['an arity and no return', { llsrc: { params: [] } }],
    ['a return that fits one register', { llsrc: { params: [], returns: 'int' } }],
    ['a return spelling nothing can size', { llsrc: { params: [], returns: 'Fixed64' } }],
    // A WIDTH THIS COULD READ AND COULD NOT GET DECLARED IS NOT A WIDTH IT MAY ACT ON. Both of
    // these size to 64 and neither can be printed into the candidate's translation unit — a bare
    // count names no C type for the parameters, and no candidate includes a header declaring
    // `int64_t`. Reading the pair anyway lifts a program the candidate then compiles against an
    // implicitly-`int` callee: `bl llsrc ; mov r1,#0x20 ; asr r0,r0,r1`, a different program.
    ['a 64-bit return behind a bare argument count', { llsrc: { params: 1, returns: 'long long' } }],
    ['a 64-bit return nothing declares', { llsrc: { params: [], returns: 'int64_t' } }],
  ])('%s still declines on the stale read', (_label, prototypes: Prototypes) => {
    expect(() => liftWith(prototypes)).toThrow(/r1 is read on a path where a call has destroyed it/);
  });

  // …AND THE ZERO-ARGUMENT COUNT IS THE ONE COUNT THAT CAN BE PRINTED, because `params: 0` and
  // `params: []` are the same `(void)`. It is the pair to the refusal above: what divides them is
  // whether the declaration can be spelled, not which form the author wrote it in.
  test('a 64-bit return behind a zero-argument count lifts, because (void) is spellable', () => {
    expect(liftWith({ llsrc: { params: 0, returns: 'long long' } })).toBe(
      's32 llfrom(void) {\n    return (s32)((s64)llsrc() >> 32);\n}\n',
    );
  });

  // …AND THE REFUSAL STILL COVERS THE DEFECT IT WAS BUILT FOR. A declared pair names r0 and r1 and
  // nothing else, so r3 is as destroyed as it ever was — a returned pair is an exception for two
  // registers, not a hole in the rule.
  test('a declared pair does not license a read of the rest of the caller-saved set', () => {
    const stale = ['\t.code\t16', '\t.globl\tstale', '\t.thumb_func', 'stale:', '\tpush\t{lr}']
      .concat(['\tmov\tr3, #0x2a', '\tbl\tllsrc', '\tadd\tr0, r3, #0', '\tpop\t{r1}', '\tbx\tr1', ''])
      .join('\n');
    expect(() =>
      decompile('stale', stale, ARMV4T_AGBCC, { prototypes: { llsrc: { params: [], returns: 'long long' } } }),
    ).toThrow(/r3 is read on a path where a call has destroyed it/);
  });
});
