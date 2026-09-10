// The structurer's `sideEffects` walk, on an op whose RESULT NOBODY READS — the memory-read half.
//
// A void function's `bx lr` leaves whatever in r0, and the structurer suppresses that phantom
// return value — `analysis.ts` drops the `ret` operand from the use registry, so the suppressed
// value reaches the walk as a result nobody reads. When it is a memory READ, dropping it deletes an
// instruction the machine executed: a compiler deletes every dead read it is allowed to delete, so
// one that survives says the source's access was `volatile`. Spelling it is what puts the access
// where l3/volatileptr.ts's `/volatile` can qualify it.
//
// THE REFUSALS ARE HALF THE RULE and each has its own test here:
//
//   • an arithmetic leftover in r0 really is phantom — nothing ran that a statement stands for;
//   • a read something else consumes is already spelled at that consumer;
//   • AN ADDRESS NO QUALIFIER COULD EVER REACH. The payoff is that a lever can qualify the
//     access, so where none can the statement is not inert — it is a permanent bare deref in the
//     DEFAULT source. `void g(s32 *a0) { a0[1] = 5; *a0; }` reads as a null-deref bug and no axis
//     improves it. The two admissions are DATA: the target's declared device-register window
//     (`capabilities.deviceRegisters`), and a symbol map that declares the named global
//     `volatile`. Ordinary RAM, a ROM table and a caller's pointer all refuse.
//
// SCOPE OF THE CENSUS, quoted with the number: over the 22 kleod BENCHMARK ROWS that declare
// `returnsVoid`, 14 functions reach the suppressed `ret`, 3 carry a value nothing else consumes
// (`VBlankDMA_LevelNoop` a param, `StrCpy` an add, `DmaSpriteToObjVram` a load) and 1 of those is
// a read. That is the row scope, NOT the project scope — the same shape occurs on project
// functions no benchmark row covers.
import { expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { enumerateCandidates } from '../src/rank';
import type { SymbolInfo, SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

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
 *  not merely the absence of one spelling it guessed the extra statement would take. */
const body = (src: string): string[] =>
  src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('void ') && l !== '}' && !l.startsWith('struct '));

test('a void function’s trailing read at a DEVICE register is spelled as a statement, not dropped', () => {
  expect(body(lift(DEVICE, true))).toEqual(['*(s32 *)67109076 = 1;', '*(s32 *)67109076;', 'return;']);
});

test('an ARITHMETIC leftover in r0 really is phantom, and stays dropped', () => {
  // Same shape with the trailing load replaced by an add: nothing observed it, nothing ran that a
  // statement would stand for, and spelling it would be noise in every void function that ends in
  // a computation. Asserted as the WHOLE body — an earlier version of this test looked for a `+`
  // and passed vacuously against an ablation whose extra statement constant-folded to `3;`.
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
  expect(body(src)).toEqual(['*(s32 *)67109076 = 1;', 'return;']);
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

test('ORDINARY RAM refuses: no lever can qualify it, so the statement would be permanent noise', () => {
  // 0x02000100 is EWRAM — outside `capabilities.deviceRegisters` [0x04000000, 0x04000400).
  expect(body(lift(deadRead('0x02000100'), true))).toEqual(['*(s32 *)33554688 = 1;', 'return;']);
  // 0x08117BCC is ROM. This is the population the refusal actually protects: a WRONG `returnsVoid`
  // in a dataset turns a function's RETURN VALUE into a dead read, and without the gate the
  // truncated body is replaced by confident-looking C that computes a table index and discards it.
  expect(body(lift(deadRead('0x08117BCC'), true))).toEqual(['*(s32 *)135363532 = 1;', 'return;']);
});

test('a CALLER’S POINTER refuses — volatileptr admits a local, never a parameter', () => {
  const src = lift('g:\n\tmovs\tr2, #0x5\n\tstr\tr2, [r0, #0x4]\n\tldr\tr0, [r0, #0x0]\n\tbx\tlr\n', true).replace(
    /void g/,
    'void f',
  );
  expect(body(src)).toEqual(['a0[1] = 5;', 'return;']);
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

test('the SAME global without the map’s `volatile` refuses — the map owns the qualifier', () => {
  expect(lift(NAMED, true, new Map([[0x03000100, [gInfo(false)]]]))).not.toMatch(/^\s*gStatus;$/m);
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
  const vol = cands.filter((c) => c.label.includes('volatile') && !c.label.includes('vol-store'));
  expect(vol.length).toBeGreaterThan(0);
  for (const c of vol) {
    expect(c.source).toMatch(/volatile s32 \* p0;/);
    expect(c.source).toMatch(/^\s*p0\[2\];$/m);
  }
});
