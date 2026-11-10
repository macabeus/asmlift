// Thumb frontend: a narrow reload of a word slot.
import { describe, expect, test } from 'vitest';

import { type StaleIdiomRead, refuseStaleIdiomReads, staleMarker } from '../src/frontend/jump-table';
import { type Op, type Value, mkOp } from '../src/ir/core';
import { decompile } from '../src/pipeline';
import type { Prototypes } from '../src/proto';
import { ARMV4T_AGBCC } from '../src/target';

// A NARROW RELOAD OF A WORD SLOT. agbcc spills a promoted u8/u16 local as a word and reloads only
// the narrow part where the use is narrow, through a copy of sp made for that load alone (Thumb
// has no sp-relative `ldrb`/`ldrh`): `void f(u8 x){ struct R4 s; u8 m = x; … s = mk(); … use(m); }`
// is `str r0, [sp, #0x4] / … / add r0, sp, #0x4 / ldrb r0, [r0]`. The bytes it reads are the
// slot's low-order part, so the load is the slot's value narrowed. Each frame here also holds a
// struct-return temp at [sp,#0) — an escape, so the one-object answer is off and every shape the
// fold refuses declines loud rather than lifting through the frame as memory.
describe('a narrow reload of a word slot is the slot narrowed', () => {
  const P: Prototypes = {
    f: { params: 1, returns: 's32' },
    mk: {
      params: [],
      returns: 'struct R4',
      returnLayout: {
        kind: 'struct',
        members: [
          { name: 'a', type: 'u16' },
          { name: 'b', type: 'u16' },
        ],
      },
    },
  };
  const fr = (mid: string, tail = '') =>
    'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr0, r0, #0x1\n\tstr\tr0, [sp, #0x4]\n\tmov\tr0, sp\n\tbl\tmk\n' +
    `${mid}\tldr\tr1, [sp]\n\tadd\tr0, r0, r1\n\tadd\tsp, sp, #0x8\n\tpop\t{r1}\n\tbx\tr1\n${tail}`;
  const lift = (asm: string, target = ARMV4T_AGBCC) => decompile('f', asm, target, { prototypes: P }).source;

  test('a byte through `add rD, sp, #k` and a halfword through `mov rD, sp` read the slot', () => {
    expect(lift(fr('\tadd\tr0, sp, #0x4\n\tldrb\tr0, [r0]\n'))).toContain('return (u8)(a0 + 1) + *(s32 *)&sp0;');
    expect(lift(fr('\tmov\tr0, sp\n\tldrh\tr0, [r0, #0x4]\n'))).toContain('return (u16)(a0 + 1) + *(s32 *)&sp0;');
    // …and an instruction that leaves the copy alone may sit between the two
    expect(lift(fr('\tmov\tr0, sp\n\tmov\tr2, #0x3\n\tldrh\tr0, [r0, #0x4]\n\tadd\tr0, r0, r2\n'))).toContain(
      'return (u16)(a0 + 1) + 3 + *(s32 *)&sp0;',
    );
  });

  // …and a word the entry stores straight from an argument register is that argument's home, the
  // by-value struct parameter's shape, whose members are an object's (thumb.ts `argumentHomes`) —
  // while the one-object answer can take it: with no address escaping, the frame is that one object
  test('an incoming argument stored on entry keeps the object model', () => {
    const own =
      'f:\n\tadd\tsp, sp, #-0x8\n\tstr\tr0, [sp, #0x4]\n\tstr\tr1, [sp]\n\tadd\tr0, sp, #0x4\n\tldrb\tr0, [r0]\n' +
      '\tadd\tsp, sp, #0x8\n\tbx\tlr\n';
    const one = decompile('f', own, ARMV4T_AGBCC, { prototypes: { f: { params: 2, returns: 's32' } } }).source;
    expect(one).toContain('u8 sp0[8];');
    expect(one).toContain('return ((u8 *)sp0)[4];');
    // A struct-return temp beside it escapes to `mk`, a writer the one object cannot hold, so that
    // answer is withheld and the held home only declined ("disagree on width (4 vs 1)"): the audit
    // asks for a relift with the home released (frame-objects.ts `auditFrameObjects`), and its
    // reload is the word narrowed, as a spilled local's is.
    const home = fr('\tadd\tr0, sp, #0x4\n\tldrb\tr0, [r0]\n').replace('\tadd\tr0, r0, #0x1\n', '');
    expect(lift(home)).toContain('return (u8)a0 + *(s32 *)&sp0;');
    // …which a call before the store ends: r0 is then the callee's return, not the argument
    const afterCall = fr('\tadd\tr0, sp, #0x4\n\tldrb\tr0, [r0]\n').replace(
      '\tadd\tr0, r0, #0x1\n\tstr\tr0, [sp, #0x4]\n',
      '\tbl\tget\n\tstr\tr0, [sp, #0x4]\n',
    );
    const GET: Prototypes = { ...P, get: { params: [], returns: 'u32' } };
    expect(decompile('f', afterCall, ARMV4T_AGBCC, { prototypes: GET }).source).toContain('return (u8)v0 + ');
  });

  // A RELEASED HOME IS STILL JUDGED WHOLE. A narrow store into the home through another sp copy is
  // a write the slot model would never see: read as the slot narrowed, the reload would return the
  // entry's value and miss the 5. The second audit refuses the object over the released slot, and
  // the decline leads with the first audit's refusal of the held home (frame-objects.ts
  // `liftWithRelift`), as with no release at all.
  test('a home released to the slot model that is written through another copy declines', () => {
    const home = (store: string) =>
      fr(`\tmov\tr3, sp\n\tmov\tr2, #0x5\n\t${store}\tr2, [r3, #0x4]\n\tmov\tr0, sp\n\tldrb\tr0, [r0, #0x4]\n`).replace(
        '\tadd\tr0, r0, #0x1\n',
        '',
      );
    expect(lift(fr('\tmov\tr0, sp\n\tldrb\tr0, [r0, #0x4]\n').replace('\tadd\tr0, r0, #0x1\n', ''))).toContain(
      'return (u8)a0 + *(s32 *)&sp0;',
    );
    expect(() => lift(home('strb'))).toThrow(
      'the object at [sp,#4) overlaps the SSA slot at [sp,#4] — one byte, two models',
    );
    expect(() => lift(home('strh'))).toThrow('the accesses through the captured address disagree on width (2 vs 1)');
  });

  // …and the decline leads with the first lift's refusal where that is not the held home's: here
  // an 8-byte struct-return temp at [sp,#0) that covers the home, which the function writes
  test('a refusal that is not the held home declines with its own reason', () => {
    const R8: Prototypes = {
      ...P,
      mk: {
        params: [],
        returns: 'struct R8',
        returnLayout: {
          kind: 'struct',
          members: [
            { name: 'a', type: 'u32' },
            { name: 'b', type: 'u32' },
          ],
        },
      },
    };
    const home = fr('\tadd\tr0, sp, #0x4\n\tldrb\tr0, [r0]\n').replace('\tadd\tr0, r0, #0x1\n', '');
    expect(() => decompile('f', home, ARMV4T_AGBCC, { prototypes: R8 })).toThrow(
      'the object at [sp,#0) is where `mk` returns struct R8, and this function also writes it',
    );
  });

  // …and where the released lift stops at another obstacle, the decline names it after the first:
  // here g's escape at [sp,#8], which the first refusal (the width disagreement over the held home)
  // stopped short of
  test('a released relift that declines elsewhere reports both refusals', () => {
    const asm =
      'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x10\n\tstr\tr0, [sp, #0xc]\n\tmov\tr0, sp\n\tbl\tmk\n' +
      '\tadd\tr0, sp, #0x8\n\tbl\tg\n\tadd\tr0, sp, #0xc\n\tldrb\tr0, [r0]\n\tldr\tr1, [sp]\n\tadd\tr0, r0, r1\n' +
      '\tadd\tsp, sp, #0x10\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(() => lift(asm)).toThrow(
      /disagree on width \(4 vs 1\).*; with the argument home released: address-taken stack local — the captured address is never dereferenced/,
    );
  });

  // A HELD HOME'S NARROW RELOAD IS STILL ITS WORD'S RELOAD for the stack-argument analysis. agbcc
  // stores a by-value struct over 8 bytes (BLKmode) at the frame's bottom, below a struct-return
  // temp: `struct P { u8 m0, …, m8; }; s32 k1(struct P p) { struct R r0 = mk0(1); return p.m0 +
  // p.m4 + r0.a; }`. Read as no reload, [sp,#0] would decline as a possible outgoing argument.
  test('a home below an escaping struct-return temp reaches the audit', () => {
    const k1 =
      'k1:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x10\n\tstr\tr0, [sp]\n\tstr\tr1, [sp, #0x4]\n\tstr\tr2, [sp, #0x8]\n' +
      '\tadd\tr0, sp, #0xc\n\tmov\tr1, #0x1\n\tbl\tmk0\n\tldr\tr2, [sp, #0xc]\n\tmov\tr0, sp\n\tldrb\tr0, [r0]\n' +
      '\tmov\tr1, sp\n\tldrb\tr1, [r1, #0x4]\n\tadd\tr0, r0, r1\n\tlsl\tr2, r2, #0x10\n\tlsr\tr2, r2, #0x10\n' +
      '\tadd\tr0, r0, r2\n\tadd\tsp, sp, #0x10\n\tpop\t{r1}\n\tbx\tr1\n';
    const mk0: Prototypes[string] = {
      params: ['s32'],
      returns: 'struct R',
      returnLayout: {
        kind: 'struct',
        members: [
          { name: 'a', type: 'u16' },
          { name: 'b', type: 'u8' },
          { name: 'c', type: 'u8' },
        ],
      },
    };
    expect(
      decompile('k1', k1, ARMV4T_AGBCC, { prototypes: { k1: { params: 3, returns: 's32' }, mk0 } }).source,
    ).toContain('return (u8)a0 + (u8)a1 + sp12.a;');
    // …and the word a declared callee takes as its fifth argument is still refused where this
    // function loads it back
    const g5 =
      'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x8\n\tstr\tr0, [sp]\n\tmov\tr0, #0x1\n\tmov\tr1, #0x2\n\tmov\tr2, #0x3\n' +
      '\tmov\tr3, #0x4\n\tbl\tg5\n\tmov\tr0, sp\n\tldrb\tr0, [r0]\n\tadd\tsp, sp, #0x8\n\tpop\t{r1}\n\tbx\tr1\n';
    const G5: Prototypes = { ...P, g5: { params: ['s32', 's32', 's32', 's32', 's32'], returns: 'void' } };
    expect(() => decompile('f', g5, ARMV4T_AGBCC, { prototypes: G5 })).toThrow('but this function also LOADS it');
  });

  // …AND SO IS A NARROW RELOAD INSIDE THE BYTES A FIRST AUDIT KEPT AS ONE OBJECT, which the
  // one-object relift keeps as a capture. The BLKmode home with a call and no struct-return temp
  // beside it: `s32 m2(struct P p) { g(); return p.m0 + p.m8; }` asks for [0,12) as one object,
  // and read as no reload there, [sp,#0] would decline as a possible outgoing argument.
  test('a home kept as one object across a call lifts', () => {
    const m2 =
      'm2:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0xc\n\tstr\tr0, [sp]\n\tstr\tr1, [sp, #0x4]\n\tstr\tr2, [sp, #0x8]\n' +
      '\tbl\tg\n\tmov\tr0, sp\n\tldrb\tr0, [r0]\n\tmov\tr1, sp\n\tldrb\tr1, [r1, #0x8]\n\tadd\tr0, r0, r1\n' +
      '\tadd\tsp, sp, #0xc\n\tpop\t{r1}\n\tbx\tr1\n';
    const source = decompile('m2', m2, ARMV4T_AGBCC, {
      prototypes: { m2: { params: 3, returns: 's32' }, g: { params: [], returns: 'void' } },
    }).source;
    expect(source).toContain('u8 sp0[12];');
    expect(source).toContain('g();\n    return *p1 + p1[8];');
  });

  // …unless the function's own declaration proves the register holds one integer word, which no
  // struct passed by value is (proto.ts `ownLeadingWordRegisters`): `u32 f(u32 k)` spilling k on
  // entry and reading `(u8)k` back. A count states no type, and a by-value parameter is the home it
  // guards.
  test("the own declaration's word parameter is no by-value home", () => {
    // no address escapes, so a home would be the one object (the test above)
    const home =
      'f:\n\tadd\tsp, sp, #-0x8\n\tstr\tr0, [sp, #0x4]\n\tstr\tr1, [sp]\n\tadd\tr0, sp, #0x4\n\tldrb\tr0, [r0]\n' +
      '\tadd\tsp, sp, #0x8\n\tbx\tlr\n';
    const own = (params: Prototypes[string]['params']): string =>
      decompile('f', home, ARMV4T_AGBCC, { prototypes: { f: { params, returns: 's32' } } }).source;
    expect(own(['u32', 'u32'])).toContain('return (u8)a0;');
    expect(own(['u8 *', 'u32'])).toContain('return (u8)a0;');
    expect(own(['struct Q', 'u32'])).toContain('return ((u8 *)sp0)[4];');
    expect(own(2)).toContain('return ((u8 *)sp0)[4];');
  });

  test('a byte that is not the low-order part of the word is no reload of it', () => {
    expect(() => lift(fr('\tadd\tr0, sp, #0x4\n\tldrb\tr0, [r0, #0x1]\n'))).toThrow(
      'the objects at [sp,#4) and [sp,#5) overlap — one byte, two models',
    );
  });

  // reload hands the load another register where the value is a `?:` join's operand (`add r3, sp,
  // #0x28 / ldrb r1, [r3]`): the copy outlives its load, and is no capture only where it is dead
  test('a copy that outlives its load and dies is no capture', () => {
    expect(lift(fr('\tadd\tr3, sp, #0x4\n\tldrb\tr0, [r3]\n'))).toContain('return (u8)(a0 + 1) + *(s32 *)&sp0;');
    // …and a halfword through `mov rD, sp` (sa3 EraseSaveSector's `mov r1, sp / ldrh r2, [r1]`)
    expect(lift(fr('\tmov\tr1, sp\n\tldrh\tr0, [r1, #0x4]\n'))).toContain('return (u16)(a0 + 1) + *(s32 *)&sp0;');
    // …written again on one arm of a branch before anything reads it, and never read on the other
    expect(
      lift(
        fr(
          '\tadd\tr3, sp, #0x4\n\tldrb\tr0, [r3]\n\tcmp\tr0, #0x3\n\tbcs\t.La\n\tmov\tr3, #0x2\n\tadd\tr0, r0, r3\n.La:\n',
        ),
      ),
    ).toContain('(u8)(a0 + 1)');
    // …or by a three-operand write that reads only its sources
    expect(lift(fr('\tadd\tr3, sp, #0x4\n\tldrb\tr0, [r3]\n\tadd\tr3, r0, #0x2\n\tadd\tr0, r0, r3\n'))).toContain(
      '(u8)(a0 + 1)',
    );
  });

  // The copy is not lifted: r3 holds a marker past it (thumb.ts `writeNarrowCopyMarker`), so with
  // the deadness check ablated each of these still declines, on the marker's read, where the 9
  // below would otherwise stand for the address (`((u8 *)9)[1]`, `*(u8 *)9 = 0`, `gP = 9`, `+ 9`).
  test('a copy read after its load, on any path, stays a capture', () => {
    for (const after of [
      // read again by a second load, a store through it, a store of it, and an add
      '\tldrb\tr2, [r3, #0x1]\n\tadd\tr0, r0, r2\n',
      '\tmov\tr2, #0x0\n\tstrb\tr2, [r3]\n',
      '\tldr\tr2, .L9\n\tstr\tr3, [r2]\n',
      '\tadd\tr0, r0, r3\n',
      // …on one arm of a branch only
      '\tcmp\tr0, #0x3\n\tbcs\t.La\n\tmov\tr3, #0x2\n\tb\t.Lb\n.La:\n\tldrb\tr3, [r3, #0x1]\n.Lb:\n\tadd\tr0, r0, r3\n',
    ]) {
      const asm = fr(`\tmov\tr3, #0x9\n\tadd\tr3, sp, #0x4\n\tldrb\tr0, [r3]\n${after}`, '.L9:\n\t.word\tgP\n');
      expect(() => lift(asm), after).toThrow(/address-taken stack local/);
    }
    // a copy in r0 a return may hand back, in a function that returns a value
    const ret =
      'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr0, r0, #0x1\n\tstr\tr0, [sp, #0x4]\n\tmov\tr0, sp\n\tbl\tmk\n' +
      '\tadd\tr0, sp, #0x4\n\tldrb\tr1, [r0]\n\tldr\tr2, .L9\n\tstrb\tr1, [r2]\n\tadd\tsp, sp, #0x8\n\tpop\t{r1}\n' +
      '\tbx\tr1\n.L9:\n\t.word\tgP\n';
    expect(() => lift(ret)).toThrow('the captured address flows into `ret`');
  });

  // A return reads what the own declaration returns (thumb.ts `returnMayHand`): nothing where it
  // proves void, r0 alone where it proves one word. Undeclared, or wider, it may hand back r0:r1.
  test('a copy a return cannot hand back dies there', () => {
    const r1 = (tail: string) =>
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr0, r0, #0x1\n\tstr\tr0, [sp, #0x4]\n\tmov\tr0, sp\n' +
      `\tbl\tmk\n\tadd\tr1, sp, #0x4\n\tldrb\tr0, [r1]\n\tldr\tr2, .L9\n\tstrb\tr0, [r2]\n${tail}` +
      '\tadd\tsp, sp, #0x8\n\tpop\t{r4, pc}\n.L9:\n\t.word\tgP\n';
    const ownLift = (asm: string, f: Prototypes[string]) =>
      decompile('f', asm, ARMV4T_AGBCC, { prototypes: { ...P, f } }).source;
    expect(ownLift(r1(''), { params: ['u32'], returnsVoid: true })).toContain('gP = (u8)(a0 + 1);');
    expect(ownLift(r1('\tmov\tr0, #0x5\n'), { params: ['u32'], returns: 'u32' })).toContain('return 5;');
    // …and a copy in r0 at a void return
    const r0 = r1('')
      .replace('add\tr1, sp, #0x4\n\tldrb\tr0, [r1]', 'add\tr0, sp, #0x4\n\tldrb\tr3, [r0]')
      .replace('strb\tr0, [r2]', 'strb\tr3, [r2]');
    expect(ownLift(r0, { params: ['u32'], returnsVoid: true })).toContain('gP = (u8)(a0 + 1);');
    // a declaration that proves no return as narrow as a word keeps the r1 copy a capture
    for (const f of [{ params: ['u32'], returns: 'u64' }, { params: ['u32'] }]) {
      expect(() => ownLift(r1(''), f), JSON.stringify(f)).toThrow('disagree on width (4 vs 1)');
    }
    // The context's own `void f(u32)` proves no dropped return: pipeline.ts drops a ret operand
    // only for a stated entry, so the lifted `ret` still reads r0, and the r0 copy there stays a
    // capture. Dropped, it would print `s32 f(s32 a0)` returning `uninit_r0`.
    const contextLift = (asm: string) =>
      decompile('f', asm, ARMV4T_AGBCC, {
        prototypes: { mk: P.mk },
        ownContextProto: { params: ['u32'], returnsVoid: true },
      }).source;
    expect(() => contextLift(r0)).toThrow('the captured address flows into `ret`');
    // …while the r1 copy dies there all the same: the lifted `ret` reads r1 only through a pair the
    // asm builds, so a context void drops it as a context one-word return does
    expect(contextLift(r1(''))).toContain('gP = (u8)(a0 + 1);');
  });

  // A call reads only what it is handed (thumb.ts `frameAddressReceivers`): a declared callee its
  // argument words, an undeclared one every argument register. Past it a clobbered register is
  // dead and a callee-saved one still holds the copy.
  test('a call past the load reads the copy only where it is handed it', () => {
    const PC: Prototypes = { ...P, g0: { params: [], returns: 'u32' }, g1: { params: ['u32'], returns: 'u32' } };
    const saved = (mid: string) =>
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0x8\n\tadd\tr0, r0, #0x1\n\tstr\tr0, [sp, #0x4]\n\tmov\tr0, sp\n' +
      `\tbl\tmk\n${mid}\tldr\tr1, [sp]\n\tadd\tr0, r0, r1\n\tadd\tsp, sp, #0x8\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n`;
    const callLift = (asm: string) => decompile('f', asm, ARMV4T_AGBCC, { prototypes: PC }).source;
    // a declared one-word callee is handed r0, so a copy in r2 dies at the call
    expect(callLift(fr('\tadd\tr2, sp, #0x4\n\tldrb\tr0, [r2]\n\tbl\tg1\n'))).toContain('g1((u8)(a0 + 1))');
    // …and a copy in r4 the callee preserves dies where the next copy of sp is written over it
    expect(
      callLift(
        saved(
          '\tadd\tr4, sp, #0x4\n\tldrb\tr0, [r4]\n\tbl\tg1\n\tadd\tr4, sp, #0x4\n\tldrb\tr4, [r4]\n\tadd\tr0, r0, r4\n',
        ),
      ),
    ).toContain('g1((u8)(a0 + 1))');
    // …and a copy in r0 a callee is not handed dies there too: what it returns is written over it
    expect(callLift(saved('\tadd\tr0, sp, #0x4\n\tldrb\tr4, [r0]\n\tbl\tg0\n\tadd\tr0, r0, r4\n'))).toContain(
      'g0() + (u8)(a0 + 1)',
    );
    for (const declines of [
      // an undeclared callee may be handed every argument register
      fr('\tadd\tr2, sp, #0x4\n\tldrb\tr0, [r2]\n\tmov\tr1, #0x1\n\tbl\tg9\n'),
      // the copy in the register the declared callee is handed
      fr('\tadd\tr0, sp, #0x4\n\tldrb\tr1, [r0]\n\tbl\tg1\n'),
      // a callee-saved copy read after the call
      saved(
        '\tmov\tr4, #0x9\n\tadd\tr4, sp, #0x4\n\tldrb\tr0, [r4]\n\tbl\tg1\n\tldrb\tr1, [r4, #0x1]\n\tadd\tr0, r0, r1\n',
      ),
    ]) {
      expect(() => callLift(declines), declines).toThrow(/address-taken stack local/);
    }
  });

  test('a copy anything else reads stays a capture', () => {
    const WIDTHS = 'the accesses through the captured address disagree on width (4 vs 1)';
    // a second load through the copy
    expect(() => lift(fr('\tadd\tr0, sp, #0x4\n\tldrb\tr2, [r0]\n\tldrb\tr0, [r0]\n\tadd\tr0, r0, r2\n'))).toThrow(
      WIDTHS,
    );
    // the copy stored out before the load
    expect(() =>
      lift(fr('\tadd\tr0, sp, #0x4\n\tldr\tr2, .L9\n\tstr\tr0, [r2]\n\tldrb\tr0, [r0]\n', '.L9:\n\t.word\tgP\n')),
    ).toThrow(WIDTHS);
    // a call between the copy and the load: under `escapedFrameAddressNamesALocal` the undeclared
    // `mk2` keeps no outgoing word at [sp,#0], so the decline is the escape's, not the overlap's
    expect(() => lift(fr('\tadd\tr0, sp, #0x4\n\tbl\tmk2\n\tldrb\tr0, [r0]\n'))).toThrow(
      'the captured address at [sp,#0) is where `mk` returns its struct',
    );
  });

  // The deadness proof picks the copies left unlifted; the marker each leaves in its register holds
  // the lift to that proof, so a read the proof missed declines instead of reading the register's
  // value from before the copy.
  test("a read of a dropped copy's register declines", () => {
    const ops: Op[] = [];
    const stale = new Map<Value, StaleIdiomRead>();
    ops.push(mkOp('ret', { operands: [staleMarker(ops, 'r3', { reg: 'r3', form: 'narrow', parks: false }, stale)] }));
    const refuse = (own?: Prototypes[string], dropsVoidReturn?: boolean) => () =>
      refuseStaleIdiomReads(
        'f',
        [{ params: [], ops }],
        stale,
        { everyReachingDef: () => false },
        own,
        (m) => {
          throw new Error(m);
        },
        { refuseDispatchUnlockedPassThrough: () => {} },
        dropsVoidReturn,
      );
    const READ =
      "cannot lift 'f': address-taken stack local — r3 is read past the narrow slot reload that read through it";
    expect(refuse()).toThrow(READ);
    // a void own exempts the `ret` only where the pipeline drops its operand: a stated entry, not the
    // context's own alone
    const VOID = { params: [], returnsVoid: true };
    expect(refuse(VOID, false)).toThrow(READ);
    expect(refuse(VOID, true)).not.toThrow();
  });

  test('a register-offset or signed narrow load is no reload of the slot', () => {
    expect(() => lift(fr('\tadd\tr0, sp, #0x4\n\tmov\tr2, #0x0\n\tldrsb\tr0, [r0, r2]\n'))).toThrow(
      'the accesses through the captured address disagree on width (4 vs 1)',
    );
  });

  test('a narrow store into the slot through another copy keeps the slot refused', () => {
    expect(() =>
      lift(fr('\tmov\tr2, sp\n\tmov\tr1, #0x7\n\tstrb\tr1, [r2, #0x5]\n\tadd\tr0, sp, #0x4\n\tldrb\tr0, [r0]\n')),
    ).toThrow('the object at [sp,#5) overlaps the SSA slot at [sp,#4] — one byte, two models');
    expect(() =>
      lift(fr('\tadd\tr2, sp, #0x4\n\tmov\tr1, #0x7\n\tstrb\tr1, [r2]\n\tadd\tr0, sp, #0x4\n\tldrb\tr0, [r0]\n')),
    ).toThrow('the accesses through the captured address disagree on width (4 vs 1)');
  });

  // Each object model that covers the slot keeps it (thumb.ts `narrowReloadOf`). Without an escape
  // the frame is the one object, and the reload stays a member read of it: read as the slot
  // narrowed instead, the object's other narrow reads leave the slot unkeyed, and the lowering
  // refuses a frame the one object lifts.
  test('the one object keeps a narrow reload of its word', () => {
    const one =
      'f:\n\tadd\tsp, sp, #-0xc\n\tadd\tr0, r0, #0x1\n\tstr\tr0, [sp, #0x4]\n\tmov\tr1, sp\n\tldrb\tr1, [r1, #0x9]\n' +
      '\tmov\tr2, sp\n\tldrh\tr2, [r2, #0x8]\n\tadd\tr3, sp, #0x4\n\tldrb\tr3, [r3]\n\tadd\tr0, r1, r2\n' +
      '\tadd\tr0, r0, r3\n\tadd\tsp, sp, #0xc\n\tbx\tlr\n';
    expect(lift(one)).toContain('return p0[9] + ((u16 *)sp0)[4] + p0[4];');
  });

  // …a word of a struct built in the frame and passed by value is the struct's member…
  test("a by-value block keeps a narrow reload of its word as the struct's", () => {
    const W = {
      kind: 'struct' as const,
      members: [
        { name: 'a', type: 'u32' },
        { name: 'b', type: 'u32' },
      ],
    };
    const PB: Prototypes = {
      ...P,
      f: { params: 2, returns: 's32' },
      take: { params: ['struct W'], returns: 'void', byValueLayouts: { 0: W } },
    };
    const byval =
      'f:\n\tpush\t{r4, lr}\n\tadd\tsp, sp, #-0xc\n\tadd\tr0, r0, #0x1\n\tstr\tr0, [sp]\n\tadd\tr1, r1, #0x2\n' +
      '\tstr\tr1, [sp, #0x4]\n\tadd\tr0, sp, #0x8\n\tbl\tmk\n\tadd\tr4, sp, #0x4\n\tldrb\tr4, [r4]\n\tldr\tr0, [sp]\n' +
      '\tldr\tr1, [sp, #0x4]\n\tbl\ttake\n\tadd\tr0, r4, #0\n\tadd\tsp, sp, #0xc\n\tpop\t{r4}\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(decompile('f', byval, ARMV4T_AGBCC, { prototypes: PB }).source).toContain('v0 = ((u8 *)&sp0)[4];');
  });

  // …and the one-word frame handed to a callee is read back as memory the callee may have written,
  // through the other capture at offset 0 that hands it out (no gate of its own)
  test('a one-word frame handed to a callee keeps a narrow reload of it', () => {
    const whole =
      'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tadd\tr0, r0, #0x1\n\tstr\tr0, [sp]\n\tmov\tr0, sp\n\tbl\tg\n' +
      '\tmov\tr0, sp\n\tldrb\tr0, [r0]\n\tadd\tsp, sp, #0x4\n\tpop\t{r1}\n\tbx\tr1\n';
    const PG: Prototypes = { ...P, g: { params: ['u32 *'], returns: 'void' } };
    expect(decompile('f', whole, ARMV4T_AGBCC, { prototypes: PG }).source).toContain(
      '    g(sp0);\n    return *(u8 *)sp0;',
    );
  });

  test('a slot inside the struct-return temp is the temp, and refuses', () => {
    const P8: Prototypes = {
      ...P,
      mk: {
        params: [],
        returns: 'struct R8',
        returnLayout: {
          kind: 'struct',
          members: [
            { name: 'a', type: 'u32' },
            { name: 'b', type: 'u32' },
          ],
        },
      },
    };
    expect(() =>
      decompile('f', fr('\tadd\tr0, sp, #0x4\n\tldrb\tr0, [r0]\n'), ARMV4T_AGBCC, { prototypes: P8 }),
    ).toThrow('the object at [sp,#0) overlaps the SSA slot at [sp,#4] — one byte, two models');
  });

  // The word must be a slot: with no word store to it anywhere, the bytes are a sub-word local's and
  // the copy stays the capture it was.
  test('a word no `str` writes is no slot, and the copy stays a capture', () => {
    const unstored =
      'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x8\n\tmov\tr0, sp\n\tbl\tmk\n\tadd\tr0, sp, #0x4\n\tldrb\tr0, [r0]\n' +
      '\tadd\tsp, sp, #0x8\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(lift(unstored)).toContain('    u8 sp4;\n    sp0 = mk();\n    return sp4;');
  });

  // A reload no store reaches reads an uninitialised local only under the after-call layout claim,
  // as for the word reload; without it the copy was never lifted, so the reload refuses by name.
  test('a slot no store reaches reads uninitialised only where the layout claim holds', () => {
    const before =
      'f:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x8\n\tmov\tr0, sp\n\tbl\tmk\n\tadd\tr0, sp, #0x4\n\tldrb\tr0, [r0]\n' +
      '\tstr\tr0, [sp, #0x4]\n\tadd\tsp, sp, #0x8\n\tpop\t{r1}\n\tbx\tr1\n';
    expect(lift(before)).toContain('(u8)uninit_sp4');
    const { localsAboveOutgoingArea: _claim, ...behaviors } = ARMV4T_AGBCC.compilerBehaviors;
    expect(() => lift(before, { ...ARMV4T_AGBCC, compilerBehaviors: behaviors })).toThrow(
      "narrow reload of a stack local through a copy of sp — 'ldrb r0, [r0]' reads the word slot [sp,#4]",
    );
  });

  // The low-order part is an ENDIANNESS fact. No big-endian toolchain emits this shape (MIPS
  // gcc/kmc spill the byte itself, IDO reloads at the width it stored, mwcc keeps the local in a
  // register), so this target is hypothetical: on it the low byte of [sp,#4] is at +3.
  test('on a big-endian target the low-order part is the last bytes of the word', () => {
    const BE = { ...ARMV4T_AGBCC, capabilities: { ...ARMV4T_AGBCC.capabilities, endianness: 'big' as const } };
    expect(lift(fr('\tadd\tr0, sp, #0x4\n\tldrb\tr0, [r0, #0x3]\n'), BE)).toContain('return (u8)(a0 + 1) + ');
    expect(lift(fr('\tmov\tr0, sp\n\tldrh\tr0, [r0, #0x6]\n'), BE)).toContain('return (u16)(a0 + 1) + ');
    expect(() => lift(fr('\tadd\tr0, sp, #0x4\n\tldrb\tr0, [r0]\n'), BE)).toThrow(
      'the accesses through the captured address disagree on width (4 vs 1)',
    );
  });
});
