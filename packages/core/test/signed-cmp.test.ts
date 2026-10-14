// `/signed-cmp` (rank-variations.ts, structure.ts unsignedCompareSpelling OFF): an unsigned compare
// spelled without the `(u32)` cast and the u32 declaration the default gives it. It is a real source
// where the compiler proved the operands non-negative, and a different program where it did not, so
// it is offered, scored, and published only byte-exact.
import { describe, expect, test } from 'vitest';

import { enumerateCandidates, rankBy, withheldReason } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';
import { hasVariation } from '../src/variation-tokens';

// agbcc -O2 of `void g(unsigned);
//   void f(int n){ unsigned i=0; if (n!=1) do { g(i); i++; } while (i < (unsigned)(n-1)); }`
// The loop test is `cmp r4, r5; bcc`: unsigned. Spelled over `s32 n` and `s32 i` it is signed in C,
// and differs from the machine at n == 0, where n - 1 is 0xFFFFFFFF.
const P1 =
  'f:\n\tpush\t{r4, r5, lr}\n\tmov\tr4, #0x0\n\tcmp\tr0, #0x1\n\tbeq\t.L3\t@cond_branch\n\tsub\tr5, r0, #0x1\n' +
  '.L4:\n\tadd\tr0, r4, #0\n\tbl\tg\n\tadd\tr4, r4, #0x1\n\tcmp\tr4, r5\n\tbcc\t.L4\t@cond_branch\n' +
  '.L3:\n\tpop\t{r4, r5}\n\tpop\t{r0}\n\tbx\tr0\n';

describe('/signed-cmp', () => {
  const cands = enumerateCandidates('f', P1, ARMV4T_AGBCC);
  const named = (n: string) => cands.find((c) => c.variations.join('/') === n)!;
  // the signed spelling over the signed parameter: `s32 v0 < s32 a0 - 1`, a signed compare in C
  const wrong = named('signed/signed-cmp');

  test('the default spells the loop test unsigned even over a signed parameter', () => {
    const c = named('signed');
    expect(c.source).toContain('void f(s32 a0)');
    // `v0 < a0 - 1` compares unsigned once the counter is declared u32
    expect(c.source).toMatch(/u32 v0;[\s\S]*while \(v0 < a0 - 1\)/);
    expect(c.matchOnly).toBeUndefined();
  });

  test('a signed spelling of the compare is offered, and only as a proof-carrying candidate', () => {
    expect(wrong.source).toMatch(/void f\(s32 a0\)[\s\S]*s32 v0;[\s\S]*while \(v0 < a0 - 1\)/);
    expect(wrong.matchOnly).toBe(true);
    expect(withheldReason(wrong, { score: 0 })).toBeNull();
    expect(withheldReason(wrong, { score: 3 })).toContain('operands non-negative');
    for (const c of cands.filter((x) => !hasVariation(x.variations, 'signed-cmp'))) {
      expect(c.matchOnly).toBeUndefined();
    }
  });

  test('a /signed-cmp tree whose compare still renders unsigned carries no proof obligation', () => {
    // over `u32 a0`, `a0 - 1` is unsigned and so is the compare, whatever `v0` declares
    const c = named('unsigned/signed-cmp');
    expect(c.source).toMatch(/void f\(u32 a0\)[\s\S]*s32 v0;[\s\S]*while \(v0 < a0 - 1\)/);
    expect(c.matchOnly).toBeUndefined();
  });

  test('a better-scoring signed nonmatch is withheld, and a signed match wins', () => {
    const better = rankBy(cands, 'f', (source) => ({ score: source === wrong.source ? 2 : 9 }));
    expect(better.winner.source).not.toBe(wrong.source);
    expect(better.withheld.map((w) => w.variations.join('/'))).toEqual(['signed/signed-cmp']);
    const matched = rankBy(cands, 'f', (source) => ({ score: source === wrong.source ? 0 : 9 }));
    expect(matched.winner.source).toBe(wrong.source);
    expect(matched.withheld).toEqual([]);
  });

  test('a tie goes to the unsigned spelling', () => {
    const tie = rankBy(cands, 'f', () => ({ score: 4 }));
    expect(hasVariation(tie.winner.variations, 'signed-cmp')).toBe(false);
  });
});
