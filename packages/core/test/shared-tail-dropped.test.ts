// A SHARED-TAIL TWIN NEVER SHIPS WHERE ITS PRIMARY WAS DROPPED — rank.ts's `/merge-names` closure,
// one level up — AND ONE TWIN'S DROP NEVER COSTS THE OTHER.
//
// Each twin structures a fn the primary pass did not: `/shared-ret` the raised fn with the follow
// on, `/shared-tail` the SUNK fn with it. The structurer can accept either where the primary failed
// a boundary contract. Both are sound, and that is why only the enumeration can refuse it: each
// shared-tail pass's setting reads the default pass's dropped set. And each keeps its OWN drops apart,
// so a follow the unsunk fn cannot carry does not take the sunk fn's candidate with it.
// `structureChecked` is mocked to fail chosen `/defsite` points and to mark every other one, because
// no committed disassembly makes a contract fail on one of these passes and pass on another — the
// closure is a property of the loop, not of any row.
import { expect, test, vi } from 'vitest';

import { print } from '../src/ir/print';
import { T } from '../src/ir/types';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';
import { hasVariation } from '../src/variation-tokens';

/** Which passes the mock fails at every `/defsite` point. The primary pass is the one without the
 *  follow; the `/shared-ret` pass is the one with the follow on a fn the primary pass also saw. */
const fail = { default: false, sharedRet: false };
const defaultFns = new Set<string>();

vi.mock('../src/pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pipeline')>();
  return {
    ...actual,
    structureChecked: (...args: Parameters<typeof actual.structureChecked>) => {
      const fn = args[0];
      const opts = args[1] ?? {};
      const text = print(fn);
      if (!opts.followEarlyReturns) {
        defaultFns.add(text);
      }
      const pass = !opts.followEarlyReturns ? 'default' : defaultFns.has(text) ? 'sharedRet' : 'sharedTail';
      if (
        opts.anchorConstCopies &&
        ((pass === 'default' && fail.default) || (pass === 'sharedRet' && fail.sharedRet))
      ) {
        throw new Error('mocked contract failure');
      }
      const sfn = actual.structureChecked(...args);
      // a distinct tree at every `/defsite` point, so the tree dedup cannot hide one
      return opts.anchorConstCopies ? { ...sfn, locals: [...sfn.locals, { name: 'zzDefsite', type: T.s(32) }] } : sfn;
    },
  };
});

const P = { f: { params: 2, returnsVoid: true } };
// `shared-tail.test.ts`'s cross-jumped tail, which only the sink turns into early returns.
const THUMB =
  'f:\n\tpush\t{lr}\n\tldr\tr2, .L9\n\tcmp\tr0, #0\n\tblt\t.L3\n\tcmp\tr1, #0\n\tbge\t.L5\n' +
  '\tmov\tr3, #7\n\tb\t.L6\n.L3:\n\tstr\tr1, [r2, #8]\n.L5:\n\tmov\tr3, #9\n.L6:\n\tstr\tr3, [r2, #4]\n' +
  '\tpop\t{r0}\n\tbx\tr0\n.L10:\n\t.align\t2, 0\n.L9:\n\t.word\tgQ\n';
// `shared-tail.test.ts`'s arm the compiler left returning, where only the follow runs.
const THUMB_LEFT =
  'f:\n\tpush\t{lr}\n\tldr\tr2, .L9\n\tcmp\tr0, #0\n\tblt\t.L3\n\tcmp\tr1, #0\n\tbge\t.L5\n' +
  '\tmov\tr3, #7\n\tstr\tr3, [r2, #4]\n\tb\t.L6\n.L3:\n\tstr\tr1, [r2, #8]\n.L5:\n\tmov\tr3, #9\n' +
  '\tstr\tr3, [r2, #4]\n.L6:\n\tpop\t{r0}\n\tbx\tr0\n.L10:\n\t.align\t2, 0\n.L9:\n\t.word\tgQ\n';
// `shared-tail.test.ts`'s `THUMB_FLAT`, where both twins run.
const THUMB_FLAT =
  'f:\n\tpush\t{lr}\n\tldr\tr2, .L9\n\tcmp\tr0, #0\n\tblt\t.L3\n\tcmp\tr1, #0\n\tbge\t.L5\n' +
  '\tcmp\tr0, #5\n\tbeq\t.L7\n\tmov\tr3, #7\n\tb\t.L6\n.L3:\n\tstr\tr1, [r2, #8]\n.L5:\n\tmov\tr3, #9\n' +
  '.L6:\n\tstr\tr3, [r2, #4]\n\tpop\t{r0}\n\tbx\tr0\n.L7:\n\tmov\tr3, #8\n\tstr\tr3, [r2, #4]\n' +
  '\tpop\t{r0}\n\tbx\tr0\n.L10:\n\t.align\t2, 0\n.L9:\n\t.word\tgQ\n';

const run = (asm: string, failing: typeof fail) => {
  Object.assign(fail, failing);
  defaultFns.clear();
  const errors: string[] = [];
  const cands = enumerateCandidates('f', asm, ARMV4T_AGBCC, {
    prototypes: P,
    onEnumerationError: (label) => errors.push(label),
  });
  return { errors, cands };
};

test.each([
  ['/shared-tail', THUMB],
  ['/shared-ret', THUMB_LEFT],
])('the %s alternative skips every setting its default sibling dropped, and keeps the rest', (suffix, asm) => {
  const { errors, cands } = run(asm, { default: true, sharedRet: false });
  const reported = (l: string) => l.split('/').slice(1);
  expect(
    errors.some(
      (l) =>
        hasVariation(reported(l), 'defsite') &&
        !hasVariation(reported(l), 'shared-ret') &&
        !hasVariation(reported(l), 'shared-tail'),
    ),
  ).toBe(true);
  const alternative = cands.filter((c) => hasVariation(c.variations, suffix.slice(1)));
  expect(alternative.length).toBeGreaterThan(0);
  expect(alternative.filter((c) => hasVariation(c.variations, 'defsite'))).toEqual([]);
});

test('a setting the `/shared-ret` alternative drops still ships in the `/shared-tail` alternative', () => {
  const { errors, cands } = run(THUMB_FLAT, { default: false, sharedRet: true });
  expect(
    errors.some(
      (l) => hasVariation(l.split('/').slice(1), 'shared-ret') && hasVariation(l.split('/').slice(1), 'defsite'),
    ),
  ).toBe(true);
  expect(
    cands.filter((c) => hasVariation(c.variations, 'shared-ret') && hasVariation(c.variations, 'defsite')),
  ).toEqual([]);
  expect(cands.some((c) => hasVariation(c.variations, 'shared-tail') && hasVariation(c.variations, 'defsite'))).toBe(
    true,
  );
});
