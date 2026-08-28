// CONNECTIVE: why `x == 0 || x == 2` and `switch (x) { case 0: case 2: }` are both enumerated.
// One asm shape, two legitimate C spellings, and raise/shortcircuit.ts must pick ONE — a folded
// `logic_or` is not the `icmp` switch-recover.ts requires, so whichever it takes disqualifies the
// other for the rest of the run. The default leaves the tree (the more specific recovery); these
// tests pin the other half — that the connective spelling is a DISTINCT source, enumerated only on
// a function whose fold actually reaches the refusal. Toolchain-free.
import { describe, expect, test } from 'vitest';

import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

const P = { f: { returnsVoid: true } };
const wrap = (body: string) => `f:\n\tpush\t{lr}\n${body}\tpop\t{r1}\n\tbx\tr1\n`;
const cands = (body: string) => enumerateCandidates('f', wrap(body), ARMV4T_AGBCC, { prototypes: P });
const distinct = (cs: { source: string }[]) => new Set(cs.map((c) => c.source)).size;

// ONE scrutinee against TWO constants, both tests reaching one shared block: the head's fall edge
// carries the second test, and either match takes the shared arm.
const TREE =
  '\tldr\tr0, [r1]\n\tcmp\tr0, #0\n\tbeq\t.L2\n\tcmp\tr0, #2\n\tbne\t.L4\n' +
  '.L2:\n\tmov\tr2, #5\n\tstr\tr2, [r1]\n\tb\t.L5\n' +
  '.L4:\n\tmov\tr2, #9\n\tstr\tr2, [r1]\n.L5:\n';

describe('/connective is enumerated wherever the tree refusal has an inhabitant', () => {
  test('a same-scrutinee const-test chain emits BOTH spellings', () => {
    const all = cands(TREE);
    expect(all.some((c) => c.label.includes('/connective'))).toBe(true);
    // Not a duplicate the dedup would have collapsed — dropping the axis drops a distinct
    // spelling, which is what makes the shape a question for the differ and not for a predicate.
    expect(distinct(all)).toBeGreaterThan(distinct(all.filter((c) => !c.label.includes('/connective'))));
    expect(all.some((c) => c.label.includes('/connective') && / \|\| |&&/.test(c.source))).toBe(true);
  });

  test('…and the tree spelling survives beside it', () => {
    // `pokeemerald:IsStringLengthAtLeast` is the corpus row this protects: its refusal covers a
    // real fall-through `switch`, and it keeps its score only because the tree spelling is still
    // in the fan to win it. An axis that REPLACED the default rather than joining it costs it.
    const all = cands(TREE);
    expect(all.some((c) => !c.label.includes('/connective') && !/ \|\| /.test(c.source))).toBe(true);
  });

  test('a function whose fold never reaches the refusal pays nothing for it', () => {
    // Two different scrutinees: an ordinary `||` the fold already takes, so there is no second
    // spelling to referee and no variant to enumerate.
    const PLAIN =
      '\tldr\tr0, [r1]\n\tcmp\tr0, #0\n\tbeq\t.L2\n\tldr\tr3, [r1, #4]\n\tcmp\tr3, #2\n\tbne\t.L4\n' +
      '.L2:\n\tmov\tr2, #5\n\tstr\tr2, [r1]\n\tb\t.L5\n' +
      '.L4:\n\tmov\tr2, #9\n\tstr\tr2, [r1]\n.L5:\n';
    expect(cands(PLAIN).some((c) => c.label.includes('/connective'))).toBe(false);
  });
});
