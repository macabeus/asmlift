// The structurer's `sideEffects` walk, on an op whose RESULT NOBODY READS — the memory-read half.
//
// A void function's `bx lr` leaves whatever in r0, and the structurer suppresses that phantom
// return value — `analysis.ts` drops the `ret` operand from the use registry, so the suppressed
// value reaches the walk as a result nobody reads. When it is a memory READ, dropping it deletes an
// instruction the machine executed: a compiler deletes every dead read it is allowed to delete, so
// one that survives says the source's access was `volatile`. Spelling it is what puts the access
// where l3/volatileptr.ts's `/volatile` can qualify it.
//
// The REFUSAL is the other half and has its own tests: an arithmetic leftover in r0 really is
// phantom, and a read something else consumes is already spelled at that consumer. On kleod, 14
// functions reach the suppressed `ret`, 3 carry a value nothing else consumes, and 1 of those is a
// read.
import { expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const POOL = '_pool: .4byte 0x040000D4\n';

/** `REG[0] = 1;` then a load of the same cell nobody consumes — the shape the whole file is about. */
const DEAD_READ =
  'f:\n' +
  '\tldr\tr3, _pool\t@ =0x040000D4\n' +
  '\tmovs\tr0, #0x1\n' +
  '\tstr\tr0, [r3, #0x0]\n' +
  '\tldr\tr0, [r3, #0x0]\n' +
  '\tbx\tlr\n' +
  POOL;

const lift = (asm: string, returnsVoid: boolean) =>
  decompile('f', asm, ARMV4T_AGBCC, {
    prototypes: returnsVoid ? { f: { returnsVoid: true } } : {},
  }).source;

test('a void function’s trailing read is spelled as a statement, not dropped', () => {
  const src = lift(DEAD_READ, true);
  expect(src).toMatch(/^\s*\*\(s32 \*\)\d+;$/m);
});

test('an ARITHMETIC leftover in r0 really is phantom, and stays dropped', () => {
  // Same shape with the trailing load replaced by an add: nothing observed it, nothing ran that a
  // statement would stand for, and spelling it would be noise in every void function that ends in
  // a computation.
  const src = lift(
    'f:\n' +
      '\tldr\tr3, _pool\t@ =0x040000D4\n' +
      '\tmovs\tr0, #0x1\n' +
      '\tstr\tr0, [r3, #0x0]\n' +
      '\tadds\tr0, r0, #0x2\n' +
      '\tbx\tlr\n' +
      POOL,
    true,
  );
  expect(src).not.toMatch(/^\s*[^=;]*\+[^=;]*;$/m);
});

test('a read something else consumes is spelled once, at its consumer', () => {
  const src = lift(
    'f:\n' +
      '\tldr\tr3, _pool\t@ =0x040000D4\n' +
      '\tldr\tr0, [r3, #0x0]\n' +
      '\tstr\tr0, [r3, #0x4]\n' +
      '\tbx\tlr\n' +
      POOL,
    true,
  );
  expect(src).toMatch(/p0\[1\] = \*p0;/);
  expect(src).not.toMatch(/^\s*\*p0;$/m);
});

test('with a return VALUE to consume it, the read stays in the return', () => {
  const src = lift(DEAD_READ, false);
  expect(src).toMatch(/return \*\(s32 \*\)\d+;/);
  expect(src).not.toMatch(/^\s*\*\(s32 \*\)\d+;$/m);
});
