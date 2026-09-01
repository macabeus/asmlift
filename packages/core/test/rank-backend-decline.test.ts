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

// …AND IT MUST SAY WHICH SPELLING IT REFUSED. The PRE-FAN products (rank.ts PRE_FAN_PRODUCTS)
// rewrite the TREE and then run this same fan over the result, so a backend refusal there deletes
// the lever's whole half of the row's candidates. Reported under the bare function name it is
// byte-identical to a refusal of the PRIMARY spelling, which sends the reader at the one spelling
// that did not fail — the wrong-cause attribution the channel exists to remove.
//
// This is the ONE assertion on the `[lever]` line's content anywhere, and NOT because no lever
// throws over the corpus. `onLeverError` has exactly one caller — packages/cli/src/main.ts — and
// the benchmark reaches `decompileRanked` (apps/benchmark/src/eval/asmlift.ts) without supplying
// one, so a `pnpm bench run` cannot print the line at all. Its absence over 951 rows is evidence
// about the WIRING, not about the levers, which leaves nothing but this test pinning the label.
test('a refusal on a PRE-FAN tree is reported under the pre-fan label, not the primary spelling', () => {
  // `if (c) { *A = 1; } else { *B = 2; }` as agbcc cross-jumps it: both arms leave an ADDRESS and a
  // VALUE in registers and the merged store follows the join — the shape `/unmerge` rewrites.
  const asm = [
    'f:',
    '\tcmp\tr0, #0x0',
    '\tbeq\t.L2',
    '\tldr\tr1, .L8',
    '\tmov\tr2, #0x1',
    '\tb\t.L3',
    '.L2:',
    '\tldr\tr1, .L9',
    '\tmov\tr2, #0x2',
    '.L3:',
    '\tstr\tr2, [r1]',
    '\tbx\tlr',
    '.L8:',
    '\t.word\t0x03001000',
    '.L9:',
    '\t.word\t0x03002000',
  ].join('\n');

  const plain = enumerateCandidates('f', asm, ARMV4T_AGBCC).map((c) => c.label);
  const unmerged = plain.filter((l) => l.includes('/unmerge'));
  expect(unmerged.length).toBeGreaterThan(0); // the fixture really reaches the pre-fan product

  // a backend that emits normally but refuses exactly the trees the pre-fan product produced
  const refused = new Set(
    enumerateCandidates('f', asm, ARMV4T_AGBCC)
      .filter((c) => c.label.includes('/unmerge'))
      .map((c) => c.source),
  );
  const seen: string[] = [];
  const kept = enumerateCandidates('f', asm, ARMV4T_AGBCC, {
    backend: {
      ...cBackend,
      emit: (sfn) => {
        const source = cBackend.emit(sfn);
        if (refused.has(source)) {
          throw new Error('refusing backend: no spelling for the rewritten tree');
        }
        return source;
      },
    },
    onLeverError: (label) => seen.push(label),
  }).map((c) => c.label);

  expect(kept.some((l) => l.includes('/unmerge'))).toBe(false); // the half really was deleted
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((l) => l.includes('/unmerge'))).toBe(true); // …and every report names it
});

// …AND THE PRE-FAN LABEL HAS TO REACH THE LEVER REFUSALS TOO, not just the primary emit's. The
// test above refuses the pre-fan tree's PRIMARY spelling, which makes `fanOut` report and return
// before a single re-spelling runs — so it cannot see the four other `onLeverError` sites inside
// that function, each of which is reachable from both fans and each of which already carries a
// suffix naming a LEVER. On a pre-fan tree that lever is a lever applied to the REWRITE, so a
// refusal of `/unmerge/volatile` reported as `/volatile` sends the reader at a spelling that did
// not fail and is still in the fan — the same wrong cause, one lever further down.
//
// The fixture therefore keeps the pre-fan tree SPELLABLE and refuses only what a lever built on
// top of it emitted.
test('a refusal of a LEVER on a pre-fan tree carries the pre-fan label too', () => {
  // Same cross-jump shape as above, plus a device-block base written at two displacements before
  // the `if` — a numeric-address pointer local that survives `/unmerge`, so the unmerged tree
  // still admits `/volatile` and the fan reaches `unsigned/unmerge/volatile`.
  const asm = [
    'f:',
    '\tpush\t{r4, lr}',
    '\tldr\tr3, .LA',
    '\tmov\tr4, #0x5',
    '\tstr\tr4, [r3]',
    '\tmov\tr4, #0x7',
    '\tstr\tr4, [r3, #0x4]',
    '\tcmp\tr0, #0x0',
    '\tbeq\t.L2',
    '\tldr\tr1, .L8',
    '\tmov\tr2, #0x1',
    '\tb\t.L3',
    '.L2:',
    '\tldr\tr1, .L9',
    '\tmov\tr2, #0x2',
    '.L3:',
    '\tstr\tr2, [r1]',
    '\tpop\t{r4}',
    '\tpop\t{r0}',
    '\tbx\tr0',
    '.LA:',
    '\t.word\t0x04000010',
    '.L8:',
    '\t.word\t0x03001000',
    '.L9:',
    '\t.word\t0x03002000',
  ].join('\n');

  const all = enumerateCandidates('f', asm, ARMV4T_AGBCC);
  // the fixture really reaches a LEVER spelling built on the pre-fan tree
  const deeper = all.filter((c) => /\/unmerge\/./.test(c.label));
  expect(deeper.length).toBeGreaterThan(0);
  // …and the pre-fan tree's own primary spelling is NOT among what we refuse, so `fanOut` gets
  // past the early return and into the re-spellings
  const refused = new Set(deeper.map((c) => c.source));
  expect(all.some((c) => /\/unmerge$/.test(c.label) && !refused.has(c.source))).toBe(true);

  const seen: string[] = [];
  const kept = enumerateCandidates('f', asm, ARMV4T_AGBCC, {
    backend: {
      ...cBackend,
      emit: (sfn) => {
        const source = cBackend.emit(sfn);
        if (refused.has(source)) {
          throw new Error('refusing backend: no spelling for the re-spelt rewritten tree');
        }
        return source;
      },
    },
    onLeverError: (label) => seen.push(label),
  }).map((c) => c.label);

  expect(kept.some((l) => /\/unmerge\/./.test(l))).toBe(false); // the lever spellings really died
  expect(seen.length).toBeGreaterThan(0);
  // every report names the pre-fan spelling it was fanning, ahead of the lever that failed
  expect(seen.every((l) => l.includes('/unmerge/'))).toBe(true);
});
