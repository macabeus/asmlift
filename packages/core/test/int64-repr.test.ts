// A 64-bit integer as ONE IR value: the representation's own invariants, checked where they are
// stated rather than where a later pass would notice them missing.
//
// The three opcodes and the two verifier rules are the whole of it. `concat` builds the value from
// its halves and `lo32`/`hi32` read one back; nothing else changes, because every arithmetic op
// already carries its width in its operand types.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { pascalBackend } from '../src/backend/pascal';
import { Block, Fn, mkOp, mkValue } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { T, intWidth, parseType, typeToString } from '../src/ir/types';
import { VerifyError, verify } from '../src/ir/verify';
import type { BinOp, Expr, SFn, Stmt } from '../src/l3/ast';
import { initFirstGuards } from '../src/l3/initfirst';
import { arithConversionSignedness, exprIntWidth } from '../src/l3/typing';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { ARMV4T_AGBCC, C_TYPEDEFS, structureOptionsFor } from '../src/target';

const fnOf = (blocks: Block[]): Fn => ({
  name: 'f',
  blocks,
  writeOrder: undefined,
  slotHomes: undefined,
  paramEvidence: undefined,
});
/** One block: the ops, then a `ret`. */
const oneBlock = (params: Block['params'], ops: Block['ops']): Fn => fnOf([{ params, ops: [...ops, mkOp('ret')] }]);

describe('the type already had the width', () => {
  test('a 64-bit integer round-trips through the IR text', () => {
    expect(typeToString(T.s(64))).toBe('s64');
    expect(typeToString(T.u(64))).toBe('u64');
    expect(parseType('s64')).toEqual(T.s(64));
    expect(parseType('u64')).toEqual(T.u(64));
  });

  test('a width-64 add parses and verifies, with no new arithmetic opcode', () => {
    const fn = parse(`fn f {\n^bb0(%0: s64, %1: s64):\n  %2: s64 = add %0, %1\n  ret %2\n}\n`);
    expect(() => verify(fn)).not.toThrow();
  });

  // THE PREDICATE ITSELF, over every `IrType` kind, because two consumers read it under opposite
  // policies: the verifier reads a null as "does not take part in the width rule, so pass", and
  // `arrivesAsDeclared` reads the same null as "no width to check a fold's claim against, so
  // refuse". A seventh kind added to `IrType` has to answer here before either of them is right.
  test('a width belongs to an integer and to an unrecovered value, and to nothing else', () => {
    expect(intWidth(T.s(64))).toBe(64);
    expect(intWidth(T.u(8))).toBe(8);
    expect(intWidth(T.unk(32))).toBe(32);
    // A pointer's own width is the machine's and says nothing about what it addresses; an
    // aggregate and `void` have no single width at all.
    expect(intWidth(T.ptr(T.s(32)))).toBeNull();
    expect(intWidth(T.struct('S', [{ off: 0, type: T.s(32), name: 'a' }]))).toBeNull();
    expect(intWidth(T.array(T.u(8), 4))).toBeNull();
    expect(intWidth(T.void())).toBeNull();
  });
});

describe('the three opcodes have a shape, and it is checked', () => {
  const wide = () => mkValue(T.s(64));
  const narrow = () => mkValue(T.s(32));

  test('concat takes two 32-bit halves and yields the 64-bit value', () => {
    const [lo, hi, v] = [narrow(), narrow(), wide()];
    expect(() => verify(oneBlock([lo, hi], [mkOp('concat', { operands: [lo, hi], results: [v] })]))).not.toThrow();
  });

  test('a concat whose RESULT is 32 bits is rejected', () => {
    const [lo, hi, v] = [narrow(), narrow(), narrow()];
    expect(() => verify(oneBlock([lo, hi], [mkOp('concat', { operands: [lo, hi], results: [v] })]))).toThrow(
      /'concat' result must be an integer of width 64/,
    );
  });

  test('a concat whose HALF is 64 bits is rejected', () => {
    const [lo, hi, v] = [wide(), narrow(), wide()];
    expect(() => verify(oneBlock([lo, hi], [mkOp('concat', { operands: [lo, hi], results: [v] })]))).toThrow(
      /'concat' half must be an integer of width 32/,
    );
  });

  test('lo32 and hi32 read a half off the 64-bit value', () => {
    const [v, lo, hi] = [wide(), narrow(), narrow()];
    expect(() =>
      verify(
        oneBlock([v], [mkOp('lo32', { operands: [v], results: [lo] }), mkOp('hi32', { operands: [v], results: [hi] })]),
      ),
    ).not.toThrow();
  });

  test('a projection off a 32-bit value is rejected', () => {
    const [v, lo] = [narrow(), narrow()];
    expect(() => verify(oneBlock([v], [mkOp('lo32', { operands: [v], results: [lo] })]))).toThrow(
      /'lo32' operand must be an integer of width 64/,
    );
  });

  // A POINTER IS NOT A 32-BIT HALF, and the distinction is not academic: the shape that produces
  // one is `bl __muldi3; ldr r0,[r0]`, where recovery types the low half by how it is used. A
  // pointer's own width is the machine's, so answering 32 for it would accept a half this
  // representation has no claim about.
  test('a half recovered as a POINTER is rejected, not treated as a word', () => {
    const [v, lo] = [wide(), mkValue(T.ptr(T.s(32)))];
    expect(() => verify(oneBlock([v], [mkOp('lo32', { operands: [v], results: [lo] })]))).toThrow(
      /'lo32' half must be an integer of width 32, got ptr/,
    );
  });

  // THE WHOLE SAFETY STORY FOR THE REPRESENTATION, which `structure/structure.ts` names as such
  // and nothing asserted. The structurer spells exactly one `concat`: the pair the machine builds
  // to WIDEN a word, `asr rN,rM,#31` or `mov rN,#0` in its high half. A `concat` of anything else
  // is a 64-bit value with no C spelling, and what it gets is the loud gap at the bottom — which
  // is why a pair that tried to cross a join, or that came from two unrelated words, cannot
  // quietly become a plausible expression.
  test('a concat that is not a widen has no C spelling, and gaps', () => {
    const fn = parse('fn f {\n^bb0(%0: s32, %1: s32):\n  %2: s64 = concat %0, %1\n  ret %2\n}\n');
    verify(fn);
    recoverTypes(fn);
    expect(() => cBackend.emit(structure(fn, structureOptionsFor(ARMV4T_AGBCC, false)))).toThrow(
      /no lowering for op 'concat'/,
    );
  });

  // …and the widen itself, the one shape it DOES spell, so what the case above pins is the
  // absence of a spelling rather than the structurer failing on every `concat`.
  test('…while the widen the machine builds does have one', () => {
    const fn = parse(
      'fn f {\n^bb0(%0: s32):\n  %1: s32 = shr_s %0 {imm = 31}\n  %2: s64 = concat %0, %1\n  ret %2\n}\n',
    );
    verify(fn);
    recoverTypes(fn);
    expect(cBackend.emit(structure(fn, structureOptionsFor(ARMV4T_AGBCC, false)))).toContain('(s64)a0');
  });

  // At L1 every value is `unknown`, so a rule that skipped that kind would be vacuous exactly where
  // the frontend builds these.
  test('the shape rules quantify over `unknown`, not only over recovered integers', () => {
    const [lo, hi, v] = [mkValue(T.unk(32)), mkValue(T.unk(32)), mkValue(T.unk(64))];
    expect(() => verify(oneBlock([lo, hi], [mkOp('concat', { operands: [lo, hi], results: [v] })]))).not.toThrow();
    const bad = mkValue(T.unk(32));
    expect(() => verify(oneBlock([lo, hi], [mkOp('concat', { operands: [lo, hi], results: [bad] })]))).toThrow(
      VerifyError,
    );
  });
});

// THE HIGH HALF IS THE ONE PROJECTION WHOSE C SPELLING CONSTRAINS ITS OPERAND. `(u32)x` truncates
// whatever `x` renders as, but `x >> 32` is undefined in C unless the promoted left operand is
// wider than 32 bits — and the 64-bit VALUE being projected and the rendered EXPRESSION's rank are
// two different questions that can part company.
describe('the high half shifts by 32, so its operand must render 64 bits wide', () => {
  // A CALL CARRIES ITS RANK ON THE NODE, and the cast here is the SIGNEDNESS pin rather than a
  // rank one: `renderedIntSignedness` cannot prove what a call renders as, so backend/cfamily.ts
  // pins the shift's left operand at the operand's own rank — 64, because the structurer stamped
  // `wide64`. The width in the cast is the assertion: `(s32)` there would be the truncation.
  test('a 64-bit call result inlined at its use is pinned at 64, never at 32', () => {
    const fn = parse('fn f {\n^bb0():\n  %0: s64 = call {target = "llsrc"}\n  %1: s32 = hi32 %0\n  ret %1\n}\n');
    verify(fn);
    recoverTypes(fn);
    expect(cBackend.emit(structure(fn, structureOptionsFor(ARMV4T_AGBCC, false)))).toContain('(s64)llsrc() >> 32');
  });

  // THE THREE SIBLING READERS OF THE SAME RANK, which is what makes the stamp a model rather than
  // a patch at one consumer: a variable shift, an unsigned 64-bit divide and a signed one all read
  // `exprIntWidth` through `pinnedOperands`, and a call answering 32 truncates the value in each.
  // Each assertion fails on the wrong answer by NAMING the 32-bit cast the un-stamped node emits.
  test.each([
    [
      'a variable-count logical shift',
      'fn f {\n^bb0(%0: u32):\n  %1: u64 = call {target = "llsrc"}\n' +
        '  %2: u64 = shr_u %1, %0\n  %3: u32 = lo32 %2\n  ret %3\n}\n',
      '(u64)llsrc() >>',
      '(u32)llsrc()',
    ],
    [
      'an unsigned 64-bit divide',
      'fn f {\n^bb0():\n  %0: u64 = call {target = "llsrc"}\n  %1: u64 = call {target = "llb"}\n' +
        '  %2: u64 = udiv %0, %1\n  %3: u32 = lo32 %2\n  ret %3\n}\n',
      '(u64)llsrc() / llb()',
      '(u32)llsrc()',
    ],
    [
      'a signed 64-bit divide',
      'fn f {\n^bb0():\n  %0: s64 = call {target = "llsrc"}\n  %1: s64 = call {target = "llb"}\n' +
        '  %2: s64 = sdiv %0, %1\n  %3: s32 = lo32 %2\n  ret %3\n}\n',
      '(s64)llsrc() / (s64)llb()',
      '(s32)llsrc()',
    ],
  ])('%s over a call keeps the call at 64 bits', (_label, ir, wanted, truncated) => {
    const fn = parse(ir);
    verify(fn);
    recoverTypes(fn);
    const src = cBackend.emit(structure(fn, structureOptionsFor(ARMV4T_AGBCC, false)));
    expect(src).toContain(wanted);
    expect(src).not.toContain(truncated);
  });

  // …AND THE CAST GOES ON ONLY WHERE THE RANK IS MISSING, which is the half that fails if the
  // shift's operand is cast unconditionally. A 64-bit PARAMETER renders as a declared `s64` local,
  // so it already carries the rank and `(s64)a0 >> 32` would be a cast the source never wrote.
  test('a half off an operand that already renders 64 bits wide takes no cast', () => {
    const fn = parse('fn f {\n^bb0(%0: s64):\n  %1: s32 = hi32 %0\n  ret %1\n}\n');
    verify(fn);
    recoverTypes(fn);
    const src = cBackend.emit(structure(fn, structureOptionsFor(ARMV4T_AGBCC, false)));
    expect(src).toContain('a0 >> 32');
    expect(src).not.toContain('(s64)a0');
  });

  // THE SHIFT'S KIND IS READ OFF THE 64-BIT OPERAND'S OWN SIGNEDNESS, and C spells both kinds
  // `>>`, so what the two arms differ in is the PIN the backend then takes. An unsigned whole must
  // shift logically: read as signed it would emit `(s64)a0 >> 32`, which is an arithmetic shift
  // over a value the machine shifted logically. Both arms are asserted because only one of them
  // had a witness.
  test.each([
    ['signed', 's64', '(u64)a0'],
    ['unsigned', 'u64', '(s64)a0'],
  ])('a %s whole shifts its own way, and takes no cast to the other', (_label, ty, wrongPin) => {
    const fn = parse(`fn f {\n^bb0(%0: ${ty}):\n  %1: u32 = hi32 %0\n  ret %1\n}\n`);
    verify(fn);
    recoverTypes(fn);
    const src = cBackend.emit(structure(fn, structureOptionsFor(ARMV4T_AGBCC, false)));
    expect(src).toContain('a0 >> 32');
    expect(src).not.toContain(wrongPin);
  });

  // A 64-BIT VALUE RECOVERY LEFT UNTYPED has no 64-bit C type to cast to, so there is no legal
  // shift to spell and it GAPS rather than printing the undefined C. Reach is zero by
  // construction rather than by measurement: every `hi32` a frontend builds sits beside a `concat`
  // or a pair return whose result recovery types as an integer.
  test('a high half off a value with no integer type is a gap, not undefined C', () => {
    const [v, hi] = [mkValue(T.unk(64)), mkValue(T.unk(32))];
    const fn = fnOf([
      { params: [v], ops: [mkOp('hi32', { operands: [v], results: [hi] }), mkOp('ret', { operands: [hi] })] },
    ]);
    verify(fn);
    expect(() => cBackend.emit(structure(fn, structureOptionsFor(ARMV4T_AGBCC, false)))).toThrow(
      /no upper half to shift out/,
    );
  });
});

describe('64 does not mix', () => {
  test('an add over one 64-bit and one 32-bit operand is rejected', () => {
    const [a, b, r] = [mkValue(T.s(64)), mkValue(T.s(32)), mkValue(T.s(64))];
    expect(() => verify(oneBlock([a, b], [mkOp('add', { operands: [a, b], results: [r] })]))).toThrow(
      /'add' mixes a 64-bit operand with a narrower one/,
    );
  });

  test('a 64-bit add whose RESULT is 32 bits is rejected — the truncation a cast site would make', () => {
    const [a, b, r] = [mkValue(T.s(64)), mkValue(T.s(64)), mkValue(T.s(32))];
    expect(() => verify(oneBlock([a, b], [mkOp('add', { operands: [a, b], results: [r] })]))).toThrow(VerifyError);
  });

  test('a compare over two 64-bit operands is fine — its RESULT is a C `int`', () => {
    const [a, b, r] = [mkValue(T.s(64)), mkValue(T.s(64)), mkValue(T.u(32))];
    expect(() => verify(oneBlock([a, b], [mkOp('icmp_slt', { operands: [a, b], results: [r] })]))).not.toThrow();
  });

  test('a 64-bit shift by a 32-bit COUNT is what the machine does, and verifies', () => {
    const [a, n, r] = [mkValue(T.s(64)), mkValue(T.s(32)), mkValue(T.s(64))];
    expect(() => verify(oneBlock([a, n], [mkOp('shl', { operands: [a, n], results: [r] })]))).not.toThrow();
  });

  test('a shift whose SHIFTED operand is 32 bits and whose result is 64 is rejected', () => {
    const [a, n, r] = [mkValue(T.s(32)), mkValue(T.s(32)), mkValue(T.s(64))];
    expect(() => verify(oneBlock([a, n], [mkOp('shl', { operands: [a, n], results: [r] })]))).toThrow(VerifyError);
  });

  test('a narrow parameter still meets a word — the rule is a quarantine, not width agreement', () => {
    // `raise/paramwidth.ts` narrows a declared parameter to 8 or 16 bits, and `add(p_u8, x_s32)` is
    // an ordinary correct L1 shape. Full width agreement would be false on 32-bit IR today.
    const [a, b, r] = [mkValue(T.u(8)), mkValue(T.s(32)), mkValue(T.s(32))];
    expect(() => verify(oneBlock([a, b], [mkOp('add', { operands: [a, b], results: [r] })]))).not.toThrow();
  });
});

describe('what recovery does with a width it did not choose', () => {
  test('an unknown value settles at its OWN width, not at 32', () => {
    const [a, r] = [mkValue(T.unk(64)), mkValue(T.unk(64))];
    const fn = oneBlock([a], [mkOp('neg', { operands: [a], results: [r] })]);
    recoverTypes(fn);
    expect(r.type).toEqual(T.s(64));
    expect(a.type).toEqual(T.s(64));
  });
});

describe('what the backends can spell', () => {
  test('the C prelude declares s64 and u64', () => {
    expect(C_TYPEDEFS).toContain('typedef long long s64;');
    expect(C_TYPEDEFS).toContain('typedef unsigned long long u64;');
  });

  test('the Pascal backend refuses a 64-bit integer rather than narrowing it', () => {
    expect(() =>
      pascalBackend.emit({
        name: 'f',
        params: [{ name: 'a', type: T.s(64) }],
        locals: [],
        retType: T.void(),
        body: [],
      }),
    ).toThrow(/no spelling for a 64-bit integer/);
  });
});

describe('the rank a rendered expression carries', () => {
  const env = (name: string) => (name === 'w' ? T.s(64) : name === 'uw' ? T.u(64) : T.s(32));
  const v = (name: string): Expr => ({ k: 'var', name });
  const bin = (op: BinOp, l: Expr, r: Expr): Expr => ({ k: 'bin', op, l, r });

  test('a 64-bit declaration is the only thing that makes it 64', () => {
    expect(exprIntWidth(v('w'), env)).toBe(64);
    expect(exprIntWidth(v('n'), env)).toBe(32);
    expect(exprIntWidth({ k: 'const', value: 7 }, env)).toBe(32);
    expect(exprIntWidth({ k: 'cast', to: T.u(64), e: v('n') }, env)).toBe(64);
  });

  test('arithmetic takes the wider side; a shift takes its left operand alone', () => {
    expect(exprIntWidth(bin('+', v('n'), v('w')), env)).toBe(64);
    expect(exprIntWidth(bin('<<', v('n'), v('w')), env)).toBe(32);
    expect(exprIntWidth(bin('<<', v('w'), v('n')), env)).toBe(64);
  });

  // THE NODES THAT ARE `int` WHATEVER THEY ARE OVER, which is the same list
  // `renderedIntSignedness` enumerates — a comparison, a logical connective and `!` all yield `int`
  // in C, and none of them is an arithmetic node taking the wider of its operands. A rank of 64
  // here reaches `pinnedOperands`, which spells `(u64)(a < b) / c` and calls `__udivdi3` where the
  // machine called `__udivsi3`.
  test('a comparison, a connective and `!` are `int`, however wide their operands', () => {
    for (const op of ['<', '<=', '>', '>=', '==', '!=', '&&', '||'] as BinOp[]) {
      expect(exprIntWidth(bin(op, v('w'), v('w')), env)).toBe(32);
      expect(exprIntWidth(bin(op, v('w'), v('n')), env)).toBe(32);
    }
    expect(exprIntWidth({ k: 'un', op: '!', e: v('w') }, env)).toBe(32);
  });

  // …and the two unary operators that are NOT, for the same reason they are not in that list: each
  // carries the promoted type of its operand.
  test("`-` and `~` keep their operand's rank", () => {
    expect(exprIntWidth({ k: 'un', op: '-', e: v('w') }, env)).toBe(64);
    expect(exprIntWidth({ k: 'un', op: '~', e: v('w') }, env)).toBe(64);
  });

  // MEMORY IS NOT A WAY IN, and that one IS a closure: `contracts.ts` `SCALAR_WIDTHS` is {1,2,4}
  // and there is no 64-bit global, so no access node can carry the width.
  test('memory is not a way a 64-bit value enters a rendered expression', () => {
    const idx: Expr = { k: 'index', base: v('p'), idx: { k: 'const', value: 0 }, width: 4, signed: true };
    expect(exprIntWidth(idx, env)).toBe(32);
  });

  // A CALL IS A WAY IN, AND IT IS THE ONE THE NODE HAS TO BE TOLD. A callee's return type comes
  // from a prototype outside the emitted function, so the rank is not derivable here — the
  // structurer stamps it and an unstamped call stays 32, which is what C makes of a callee nobody
  // declared. Both directions are asserted, because reading the stamp as "always 64" and reading
  // it as "never 64" are the two wrong answers and each is silent at one of these two calls.
  test('a call answers the rank the structurer stamped on it, in both directions', () => {
    expect(exprIntWidth({ k: 'call', fn: 'f', args: [] }, env)).toBe(32);
    expect(exprIntWidth({ k: 'call', fn: 'f', args: [], wide64: true }, env)).toBe(64);
  });

  test('at UNEQUAL rank the wider side decides, where at equal rank unsigned would have', () => {
    // `unsigned int / long long` is SIGNED: C converts to the wider type first. The equal-rank
    // shortcut would answer `false` here and spell an unsigned divide over a signed one.
    expect(arithConversionSignedness({ k: 'cast', to: T.u(32), e: v('n') }, v('w'), env)).toBe(true);
    expect(arithConversionSignedness(v('w'), { k: 'cast', to: T.u(32), e: v('n') }, env)).toBe(true);
    // …and at EQUAL rank it still does.
    expect(arithConversionSignedness({ k: 'cast', to: T.u(32), e: v('n') }, v('n'), env)).toBe(false);
    expect(arithConversionSignedness(v('uw'), v('w'), env)).toBe(false);
    // A COMPARISON OVER 64-BIT OPERANDS IS STILL `int`, so this pair is equal rank and the
    // unsigned side wins. Reading the comparison as 64 makes it the wider side and answers signed.
    expect(arithConversionSignedness(bin('<', v('w'), v('n')), { k: 'cast', to: T.u(32), e: v('n') }, env)).toBe(false);
  });
});

describe('what the C backend prints over a 64-bit operand', () => {
  const fn = (body: Stmt[]): SFn => ({
    name: 'f',
    params: [
      { name: 'w', type: T.s(64) },
      { name: 'n', type: T.s(32) },
    ],
    locals: [],
    retType: T.void(),
    body,
  });
  const v = (name: string): Expr => ({ k: 'var', name });

  test('a 64-bit divide is not pinned down to 32 bits', () => {
    const src = cBackend.emit(
      fn([{ k: 'assign', name: 'w', value: { k: 'bin', op: '/', l: v('w'), r: { k: 'const', value: 256 } } }]),
    );
    expect(src).toContain('w = w / 256;');
    expect(src).not.toContain('(s32)w');
  });

  test('an operand that needs the pin gets it at its OWN rank', () => {
    const src = cBackend.emit(
      fn([
        {
          k: 'assign',
          name: 'w',
          value: { k: 'bin', op: '/u', l: v('w'), r: { k: 'const', value: 256 } },
        },
      ]),
    );
    expect(src).toContain('(u64)w');
    expect(src).not.toContain('(u32)w');
  });

  test('a 32-bit operand is pinned exactly as before', () => {
    const src = cBackend.emit(
      fn([{ k: 'assign', name: 'n', value: { k: 'bin', op: '/u', l: v('n'), r: { k: 'const', value: 3 } } }]),
    );
    expect(src).toContain('(u32)n');
  });
});

// THE OTHER TWO PLACES THE RANK IS READ. Both are written at 64 and neither had anything to
// exercise it: no frontend builds a 64-bit compare, so the wide branch of each was reachable only
// from hand-authored IR and from a hand-built tree. These build them, at the level each gate is
// written at.
describe('the gates that read a 64-bit rank', () => {
  const v = (name: string): Expr => ({ k: 'var', name });

  // `(u32)a` over a 64-bit operand does not pin the compare's signedness, it truncates the
  // operand — so the cast the structurer inserts is at the OPERAND's own rank.
  test('a compare pin casts at the operand rank, not at 32', () => {
    const emit = (ir: string, opts: Record<string, unknown> = {}): string => {
      const fn = parse(ir);
      verify(fn);
      recoverTypes(fn);
      return cBackend.emit(structure(fn, { ...structureOptionsFor(ARMV4T_AGBCC, false), ...opts }));
    };
    const ltu = 'fn ltu {\n^bb0(%0: s64, %1: s64):\n  %2: u32 = icmp_ult %0, %1\n  ret %2\n}\n';
    expect(emit(ltu, { unsignedCompareSpelling: true })).toContain('(u64)a0 < a1');
    const lts = 'fn lts {\n^bb0(%0: u64, %1: u64):\n  %2: u32 = icmp_slt %0, %1\n  ret %2\n}\n';
    expect(emit(lts)).toContain('(s64)a0 < (s64)a1');
  });

  // /initfirst substitutes X into the guard behind `v = X`, and every signedness step of that
  // rests on `v` holding X exactly. A 64-bit X assigned to a 32-bit `v` truncates, so the
  // premise is gone and the rewrite refuses.
  test('/initfirst refuses to substitute a 64-bit value through a 32-bit variable', () => {
    const guard = (x: Expr): SFn => ({
      name: 'f',
      params: [
        { name: 'n', type: T.s(32) },
        { name: 'w', type: T.s(64) },
      ],
      locals: [{ name: 'v0', type: T.s(32) }],
      retType: T.void(),
      body: [
        {
          k: 'if',
          cond: { k: 'bin', op: '<', l: x, r: v('n') },
          then: [
            { k: 'assign', name: 'v0', value: x },
            { k: 'dowhile', cond: { k: 'bin', op: '<', l: v('v0'), r: v('n') }, body: [] },
          ],
          else: [],
        },
      ],
    });
    expect(initFirstGuards(guard(v('w')))).toBeNull();
    // …and the same shape one rank down still rewrites, so it is the WIDTH that refused.
    expect(initFirstGuards(guard(v('n')))).not.toBeNull();
  });
});
