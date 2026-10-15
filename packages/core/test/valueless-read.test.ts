// The structurer's `sideEffects` walk, on an op whose RESULT NOBODY READS — the memory-read half.
//
// A void function's `bx lr` leaves whatever in r0, and the structurer suppresses that phantom
// return value — `analysis.ts` drops the `ret` operand from the use registry, so the suppressed
// value reaches the walk as a result nobody reads. When it is a memory READ, dropping it deletes an
// instruction the machine executed: a compiler deletes every dead read it is allowed to delete, so
// one that survives says the source's access was `volatile`.
//
// ONE DECIDER. That claim is the dead-read pin's (frontend/dead-reads.ts), asked of the raw lift at
// any address, and the pin does not count the `ret` operand of a function its own declaration says
// is void as a use. So the read is stamped `volatile` there and the walk spells what was stamped —
// at a device register, in RAM or ROM, at a runtime index or through a caller's pointer alike —
// and a read the pin refused is plain, and dropped. The refusals tested here are the walk's own:
//
//   • an arithmetic leftover in r0 really is phantom — nothing ran that a statement stands for;
//   • a read something else consumes is already spelled at that consumer;
//   • with no declared void return, the read IS the return value;
//   • a read the pin's gates refuse (a sign-extending narrow read on agbcc) stays plain and dropped.
//
// A read of an object the map declares is spelled through the declaration where it qualifies the
// object, and through a `volatile` cast on the object's address where it does not.
import { expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { enumerateCandidates } from '../src/rank';
import type { SymbolInfo, SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';
import { hasVariation } from '../src/variation-tokens';

/** `.word` pool holding one address, referenced as `_pool`. */
const pool = (hex: string) => `_pool: .4byte ${hex}\n`;

/** `X[0] = 1;` then a load of the same cell nobody consumes — the shape the whole file is about. */
const deadRead = (hex: string) =>
  'f:\n' +
  `\tldr\tr3, _pool\t@ =${hex}\n` +
  '\tmovs\tr0, #0x1\n' +
  '\tstr\tr0, [r3, #0x0]\n' +
  '\tldr\tr0, [r3, #0x0]\n' +
  '\tbx\tlr\n' +
  pool(hex);

/** 0x040000D4 = REG_DMA3SAD, inside ARMV4T_AGBCC's declared `deviceRegisters` window. */
const DEVICE = deadRead('0x040000D4');

const lift = (asm: string, returnsVoid: boolean, symbols?: SymbolMap) =>
  decompile('f', asm, ARMV4T_AGBCC, {
    prototypes: returnsVoid ? { f: { returnsVoid: true } } : {},
    ...(symbols ? { symbols } : {}),
  }).source;

/** the body of the emitted function, statements only — so a test can assert the WHOLE body and
 *  not merely the absence of one spelling it guessed the extra statement would take.
 *
 *  None of these bodies ends in a `return;`: each asm is a single block with no branch in it, so
 *  nothing transferred control to an epilogue and the source spelled none (`structure/retspell.ts`). */
const body = (src: string): string[] =>
  src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('void ') && l !== '}' && !l.startsWith('struct '));

test('a void function’s trailing read at a DEVICE register is spelled as a qualified statement, not dropped', () => {
  expect(body(lift(DEVICE, true))).toEqual(['*(s32 *)67109076 = 1;', '*(volatile s32 *)67109076;']);
});

test('an ARITHMETIC leftover in r0 really is phantom, and stays dropped', () => {
  // Same shape with the trailing load replaced by an add: nothing observed it, nothing ran that a
  // statement would stand for, and spelling it would be noise in every void function that ends in
  // a computation. Asserted as the WHOLE body — matching on a `+` passes vacuously against an
  // ablation whose extra statement constant-folds to `3;`.
  const src = lift(
    'f:\n' +
      '\tldr\tr3, _pool\t@ =0x040000D4\n' +
      '\tmovs\tr0, #0x1\n' +
      '\tstr\tr0, [r3, #0x0]\n' +
      '\tadds\tr0, r0, #0x2\n' +
      '\tbx\tlr\n' +
      pool('0x040000D4'),
    true,
  );
  expect(body(src)).toEqual(['*(s32 *)67109076 = 1;']);
});

test('a read something else consumes is spelled once, at its consumer', () => {
  const src = lift(
    'f:\n' +
      '\tldr\tr3, _pool\t@ =0x040000D4\n' +
      '\tldr\tr0, [r3, #0x0]\n' +
      '\tstr\tr0, [r3, #0x4]\n' +
      '\tbx\tlr\n' +
      pool('0x040000D4'),
    true,
  );
  expect(src).toMatch(/p0\[1\] = \*p0;/);
  expect(src).not.toMatch(/^\s*\*p0;$/m);
});

test('with a return VALUE to consume it, the read stays in the return', () => {
  const src = lift(DEVICE, false);
  expect(src).toMatch(/return \*\(s32 \*\)\d+;/);
  expect(src).not.toMatch(/^\s*\*\(s32 \*\)\d+;$/m);
});

test('ORDINARY RAM and ROM are kept the same way: the declared void return is the evidence, not the address', () => {
  // 0x02000100 is EWRAM and 0x08117BCC ROM — both outside `capabilities.deviceRegisters`. A read the
  // compiler kept in a function declared void was `volatile` wherever it points; the remaining
  // preimage is a WRONG `returnsVoid`, trusted here as the pair gate trusts a declared width.
  expect(body(lift(deadRead('0x02000100'), true))).toEqual(['*(s32 *)33554688 = 1;', '*(volatile s32 *)33554688;']);
  expect(body(lift(deadRead('0x08117BCC'), true))).toEqual(['*(s32 *)135363532 = 1;', '*(volatile s32 *)135363532;']);
  // …and through a base local the read keeps its own qualifier
  const wide =
    'f:\n\tldr\tr3, _pool\t@ =0x02000100\n\tmovs\tr0, #0x1\n\tstr\tr0, [r3, #0x0]\n' +
    '\tstr\tr0, [r3, #0x4]\n\tstr\tr0, [r3, #0x8]\n\tldr\tr0, [r3, #0x8]\n\tbx\tlr\n' +
    pool('0x02000100');
  expect(body(lift(wide, true)).at(-1)).toBe('((volatile s32 *)p0)[2];');
});

test('a SINGLE-ACCESS device read is kept qualified — no base local is needed for the qualifier', () => {
  // The `REG_IF`/`REG_VCOUNT` acknowledge idiom: the qualifier rides the access's own cast.
  const single = 'f:\n\tldr\tr3, _pool\t@ =0x04000200\n\tldr\tr0, [r3, #0x0]\n\tbx\tlr\n' + pool('0x04000200');
  expect(body(lift(single, true))).toEqual(['*(volatile s32 *)67109376;']);
});

test('a RUNTIME-INDEXED read is kept qualified at the cell it touches', () => {
  const indexed =
    'f:\n\tldr\tr3, _pool\t@ =0x04000000\n\tmovs\tr2, #0x1\n\tstr\tr2, [r3, #0x0]\n' +
    '\tlsls\tr1, r0, #0x2\n\tldr\tr0, [r3, r1]\n\tbx\tlr\n' +
    pool('0x04000000');
  const src = decompile('f', indexed, ARMV4T_AGBCC, {
    prototypes: { f: { params: ['s32'], returnsVoid: true } },
  }).source;
  expect(body(src)).toEqual(['*(s32 *)67108864 = 1;', '((volatile s32 *)67108864)[a0];']);
});

test('a CALLER’S POINTER is kept qualified', () => {
  const src = lift('g:\n\tmovs\tr2, #0x5\n\tstr\tr2, [r0, #0x4]\n\tldr\tr0, [r0, #0x0]\n\tbx\tlr\n', true).replace(
    /void g/,
    'void f',
  );
  expect(body(src)).toEqual(['a0[1] = 5;', '*(volatile s32 *)a0;']);
});

test('a read the pin refuses stays plain, and the walk drops it', () => {
  // agbcc reads a qualified `s16` with `ldrh` and extends in a register, so an `ldrsh` was a plain
  // read in the source (frontend/dead-reads.ts `not-a-volatile-read`).
  const src = lift(
    'f:\n\tldr\tr3, _pool\t@ =0x04000004\n\tmovs\tr1, #0x0\n\tldrsh\tr0, [r3, r1]\n\tbx\tlr\n' + pool('0x04000004'),
    true,
  );
  expect(src).not.toMatch(/volatile/);
  expect(src).not.toMatch(/67108868/);
});

// ── the symbol-map admission ─────────────────────────────────────────────────────────────────
// The other half of "a qualifier can reach it", and the arm the MAP-FED default source takes:
// l3/volatileptr.ts vetoes a local fed `&gSym` because "the symbol map owns a declared global's
// volatility" — so where the map DOES declare it, the read is one a `vu32 *` source really wrote.
// 0x03000100 is IWRAM, outside the device window, so these two pin the map arm on its own.
const gInfo = (isVolatile: boolean): SymbolInfo => ({
  name: 'gStatus',
  kind: 'data',
  shape: 'scalar',
  signed: false,
  size: 4,
  declared: true,
  ...(isVolatile ? { volatile: true } : {}),
});
const NAMED = deadRead('0x03000100');

test('a map-declared VOLATILE global admits the read even outside the device window', () => {
  expect(lift(NAMED, true, new Map([[0x03000100, [gInfo(true)]]]))).toMatch(/^\s*gStatus;$/m);
});

test('the SAME global without the map’s `volatile` is read through a `volatile` cast on its address', () => {
  // `gStatus;` under the map's plain declaration compiles to no read at all
  const src = lift(NAMED, true, new Map([[0x03000100, [gInfo(false)]]]));
  expect(src).not.toMatch(/^\s*gStatus;$/m);
  expect(src).toMatch(/^\s*\*\(volatile s32 \*\)&gStatus;$/m);
});

test('a map-declared VOLATILE register reached through a CAST is written and read through a `volatile` cast', () => {
  // The target row's own map-fed default: REG_DMA3SAD declared `volatile`, three stores and the
  // wait read, each reaching the register as `((s32 *)&REG_DMA3SAD)[k]` — a cast to a PLAIN `s32 *`,
  // which is not a volatile lvalue whatever the declaration says. So each access carries the
  // qualifier on its own cast (structure.ts `pinnedAccess`).
  const asm =
    'f:\n\tldr\tr3, _pool\t@ =0x040000D4\n\tmovs\tr0, #0x1\n\tstr\tr0, [r3, #0x0]\n' +
    '\tstr\tr0, [r3, #0x4]\n\tstr\tr0, [r3, #0x8]\n\tldr\tr0, [r3, #0x8]\n\tbx\tlr\n' +
    pool('0x040000D4');
  const reg: SymbolInfo = {
    name: 'REG_DMA3SAD',
    kind: 'data',
    shape: 'scalar',
    signed: false,
    size: 4,
    declared: true,
    volatile: true,
  };
  expect(body(lift(asm, true, new Map([[0x040000d4, [reg]]])))).toEqual([
    '*(volatile s32 *)&REG_DMA3SAD = 1;',
    '((volatile s32 *)&REG_DMA3SAD)[1] = 1;',
    '((volatile s32 *)&REG_DMA3SAD)[2] = 1;',
    '((volatile s32 *)&REG_DMA3SAD)[2];',
  ]);
});

test('a volatile CONTAINER admits its named member; a `vu16` MEMBER is accessed through a `volatile` cast', () => {
  // `memberQualsAllow` refuses to spell a volatile member by name at all (the name would
  // reintroduce a qualifier the cast form it replaces never carried), so a `vu16` member is reached
  // as `((s32 *)&gState)[2]`, and its store and read carry the qualifier on that cast.
  // `volatile struct State gState;` qualifies every member, and `gState.ctl;` really is observable.
  const asm =
    'f:\n\tldr\tr3, _pool\t@ =0x03000100\n\tmovs\tr0, #0x1\n\tstr\tr0, [r3, #0x8]\n' +
    '\tldr\tr0, [r3, #0x8]\n\tbx\tlr\n' +
    pool('0x03000100');
  const st = (memberVol: boolean, declVol: boolean): SymbolMap =>
    new Map([
      [
        0x03000100,
        [
          {
            name: 'gState',
            kind: 'data',
            shape: 'struct',
            size: 12,
            declared: true,
            structName: 'State',
            ...(declVol ? { volatile: true } : {}),
            layout: [
              { name: 'a', offset: 0, size: 4, signed: false },
              { name: 'b', offset: 4, size: 4, signed: false },
              { name: 'ctl', offset: 8, size: 4, signed: false, ...(memberVol ? { volatile: true } : {}) },
            ],
          } as SymbolInfo,
        ],
      ],
    ]);
  expect(body(lift(asm, true, st(false, true)))).toEqual(['gState.ctl = 1;', 'gState.ctl;']);
  expect(body(lift(asm, true, st(true, false)))).toEqual([
    '((volatile s32 *)&gState)[2] = 1;',
    '((volatile s32 *)&gState)[2];',
  ]);
  // …and a plain container with a plain member: the member's NAME would drop the qualifier the
  // stamp put on the read, so it is read through a `volatile` cast on the container's address
  expect(body(lift(asm, true, st(false, false)))).toEqual(['gState.ctl = 1;', '((volatile s32 *)&gState)[2];']);
});

// ── the payoff a stranger needs to see ───────────────────────────────────────────────────────
test('the `/volatile` candidate carries the read through a qualified pointer local', () => {
  // Three stores plus the wait read — enough uses that a base local survives basecse, which is
  // what `/volatile` qualifies. Without the statement there is nothing for the qualifier to make
  // observable, so this is the test that shows the rule reaching its stated purpose rather than
  // merely emitting a spelling.
  const asm =
    'f:\n' +
    '\tldr\tr3, _pool\t@ =0x040000D4\n' +
    '\tmovs\tr0, #0x1\n' +
    '\tstr\tr0, [r3, #0x0]\n' +
    '\tstr\tr0, [r3, #0x4]\n' +
    '\tstr\tr0, [r3, #0x8]\n' +
    '\tldr\tr0, [r3, #0x8]\n' +
    '\tbx\tlr\n' +
    pool('0x040000D4');
  const cands = enumerateCandidates('f', asm, ARMV4T_AGBCC, { prototypes: { f: { returnsVoid: true } } });
  const vol = cands.filter((c) => hasVariation(c.variations, 'volatile') && !hasVariation(c.variations, 'vol-store'));
  expect(vol.length).toBeGreaterThan(0);
  for (const c of vol) {
    expect(c.source).toMatch(/volatile s32 \*p0;/);
    expect(c.source).toMatch(/^\s*\(\(volatile s32 \*\)p0\)\[2\];$/m);
  }
});
