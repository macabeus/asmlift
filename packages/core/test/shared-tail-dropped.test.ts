// `X/shared-tail` NEVER SHIPS WHERE `X` WAS DROPPED — rank.ts's `/merge-names` closure, one level up.
//
// The twin structures the SUNK fn, which the structurer can accept where the unsunk one failed a
// boundary contract. Both are sound, and that is why only the enumeration can refuse it: the
// twin's axis point reads the unsunk pass's dropped set. `structureChecked` is mocked to fail
// every unsunk `/defsite` point and to mark every twin one, because no committed disassembly makes
// a contract fail on one lift and pass on its sunk twin — the closure is a property of the loop,
// not of any row.
import { expect, test, vi } from 'vitest';

import { T } from '../src/ir/types';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

vi.mock('../src/pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pipeline')>();
  return {
    ...actual,
    structureChecked: (...args: Parameters<typeof actual.structureChecked>) => {
      const opts = args[1];
      if (opts.anchorConstCopies && !opts.followEarlyReturns) {
        throw new Error('mocked contract failure');
      }
      const sfn = actual.structureChecked(...args);
      // a distinct tree at every twin `/defsite` point, so the tree dedup cannot hide one
      return opts.anchorConstCopies ? { ...sfn, locals: [...sfn.locals, { name: 'zzDefsite', type: T.s(32) }] } : sfn;
    },
  };
});

// `shared-tail.test.ts`'s cross-jumped tail, which only the sink turns into early returns.
const THUMB =
  'f:\n\tpush\t{lr}\n\tldr\tr2, .L9\n\tcmp\tr0, #0\n\tblt\t.L3\n\tcmp\tr1, #0\n\tbge\t.L5\n' +
  '\tmov\tr3, #7\n\tb\t.L6\n.L3:\n\tstr\tr1, [r2, #8]\n.L5:\n\tmov\tr3, #9\n.L6:\n\tstr\tr3, [r2, #4]\n' +
  '\tpop\t{r0}\n\tbx\tr0\n.L10:\n\t.align\t2, 0\n.L9:\n\t.word\tgQ\n';

test('the twin skips every axis point its unsunk sibling dropped, and keeps the rest', () => {
  const errors: string[] = [];
  const cands = enumerateCandidates('f', THUMB, ARMV4T_AGBCC, {
    prototypes: { f: { params: 2, returnsVoid: true } },
    onLeverError: (label) => errors.push(label),
  });
  expect(errors.some((l) => l.includes('/defsite') && !l.includes('/shared-tail'))).toBe(true);
  const twin = cands.filter((c) => c.label.includes('/shared-tail'));
  expect(twin.length).toBeGreaterThan(0);
  expect(twin.filter((c) => c.label.includes('/defsite'))).toEqual([]);
});
