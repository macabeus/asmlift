// A BACKEND THAT DECLINES COSTS A CANDIDATE, NEVER THE ROW — and refusing everything is loud.
//
// `structure()` is language-neutral: the signedness pins it inserts are `cast` nodes, and the
// Pascal backend loud-declines a cast because SGI Pascal has no faithful spelling for one. So an
// enumeration over a MIPS function whose compare has an unsigned-rendering operand asks that
// backend to spell a tree it cannot, on a function whose other candidates it spells fine. The
// fan's primary spelling has to take the same posture as its re-spellings there, or one
// unspellable tree loses every sibling with it.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import type { LanguageBackend } from '../src/l3/ast';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

// `a0 < a1 ? 1 : 0` — a divergent if whose compare the signedness pin casts under the `unsigned`
// candidate (both params declared u32, the compare opcode signed).
const ASM = [
  'f:',
  '\tcmp\tr0, r1',
  '\tbge\t.L2',
  '\tmov\tr0, #0x1',
  '\tbx\tlr',
  '.L2:',
  '\tmov\tr0, #0x0',
  '\tbx\tlr',
].join('\n');

/** A backend that refuses whatever `refuse` matches in the C it would otherwise emit. */
const refusing = (refuse: RegExp): LanguageBackend => ({
  ...cBackend,
  emit: (sfn) => {
    const source = cBackend.emit(sfn);
    if (refuse.test(source)) {
      throw new Error(`refusing backend: no spelling for ${refuse.source}`);
    }
    return source;
  },
});

test('a tree the backend refuses drops its candidates and keeps the others', () => {
  const seen: string[] = [];
  const all = enumerateCandidates('f', ASM, ARMV4T_AGBCC).map((c) => c.label);
  const kept = enumerateCandidates('f', ASM, ARMV4T_AGBCC, {
    backend: refusing(/\(s32\)/),
    onLeverError: (label, error) => seen.push(`${label}: ${error}`),
  }).map((c) => c.label);
  // the pin fires only under `unsigned`, so exactly the signed candidates survive
  expect(all).toContain('unsigned');
  expect(kept.length).toBeGreaterThan(0);
  expect(kept.every((l) => !l.startsWith('unsigned'))).toBe(true);
  // and the refusal is REPORTED, never swallowed — the same channel a dropped re-spelling uses
  expect(seen.some((s) => s.includes('refusing backend'))).toBe(true);
});

test('a backend that refuses every tree fails LOUD, naming the refusal', () => {
  expect(() => enumerateCandidates('f', ASM, ARMV4T_AGBCC, { backend: refusing(/.*/) })).toThrow(
    /no spellable candidate for 'f': refusing backend/,
  );
});
