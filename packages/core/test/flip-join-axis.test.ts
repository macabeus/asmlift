// FLIP-JOIN: why the joined-if sense stays a differ-refereed axis rather than a decided default.
// The DEFAULT is the layout reading (structure.ts negateJoinedBranchSense, pinned in
// struct-harden.test.ts); these tests pin the other half — that the flipped spelling is a DISTINCT
// source on an ordinary two-armed joined `if`, so nothing may prune it on a per-function
// predicate. Toolchain-free.
import { describe, expect, test } from 'vitest';

import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

const P = { f: { returnsVoid: true } };
const wrap = (body: string) => `f:\n\tpush\t{lr}\n${body}\tpop\t{r1}\n\tbx\tlr\n`;
const cands = (body: string) => enumerateCandidates('f', wrap(body), ARMV4T_AGBCC, { prototypes: P });

// A two-armed joined `if` with nothing between the asm's branch and the structurer's reading of
// it: one `cmp`, a short conditional, both arms storing, reconverging on the tail.
const PLAIN =
  '\tcmp\tr0, #0\n\tbeq\t.L2\n\tmov\tr2, #1\n\tstr\tr2, [r1]\n\tb\t.L3\n' +
  '.L2:\n\tmov\tr2, #2\n\tstr\tr2, [r1]\n.L3:\n\tmov\tr0, #0\n';

describe('/flip-join is enumerated wherever a two-armed joined if exists', () => {
  test('an ordinary joined if emits BOTH senses, and the flipped one is a source of its own', () => {
    const all = cands(PLAIN);
    expect(all.some((c) => c.label.includes('/flip-join'))).toBe(true);
    // Not a duplicate the dedup would have collapsed: dropping the axis drops a distinct spelling,
    // which is what makes the sense a question for the differ and not for a predicate.
    const sources = (cs: typeof all) => new Set(cs.map((c) => c.source)).size;
    expect(sources(all)).toBeGreaterThan(sources(all.filter((c) => !c.label.includes('/flip-join'))));
  });

  test('…and a function with no joined if pays nothing for it', () => {
    // Both arms return, so `/flip-branch` owns the sense and `/flip-join` changes no text — the
    // dedup collapses the pair before any compile.
    const DIVERGENT = '\tcmp\tr0, #0\n\tbeq\t.L2\n\tmov\tr0, #1\n\tpop\t{r1}\n\tbx\tr1\n.L2:\n\tmov\tr0, #2\n';
    const all = enumerateCandidates('f', `f:\n\tpush\t{lr}\n${DIVERGENT}\tpop\t{r1}\n\tbx\tr1\n`, ARMV4T_AGBCC, {});
    expect(all.some((c) => c.label.includes('/flip-join'))).toBe(false);
  });
});
