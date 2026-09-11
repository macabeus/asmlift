// A SHARED-TAIL TWIN NEVER SHIPS WHERE ITS PRIMARY WAS DROPPED — rank.ts's `/merge-names` closure,
// one level up — AND ONE TWIN'S DROP NEVER COSTS THE OTHER.
//
// Each twin structures a fn the primary pass did not: `/shared-ret` the raised fn with the follow
// on, `/shared-tail` the SUNK fn with it. The structurer can accept either where the primary failed
// a boundary contract. Both are sound, and that is why only the enumeration can refuse it: each
// twin's axis point reads the primary pass's dropped set. And each twin keeps its OWN drops apart,
// so a follow the unsunk fn cannot carry does not take the sunk fn's candidate with it.
// `structureChecked` is mocked to fail chosen `/defsite` points and to mark every other one, because
// no committed disassembly makes a contract fail on one of these passes and pass on another — the
// closure is a property of the loop, not of any row.
import { expect, test, vi } from 'vitest';

import { print } from '../src/ir/print';
import { T } from '../src/ir/types';
import { enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

/** Which passes the mock fails at every `/defsite` point. The primary pass is the one without the
 *  follow; the `/shared-ret` pass is the one with the follow on a fn the primary pass also saw. */
const fail = { primary: false, sharedRet: false };
const primaryFns = new Set<string>();

vi.mock('../src/pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pipeline')>();
  return {
    ...actual,
    structureChecked: (...args: Parameters<typeof actual.structureChecked>) => {
      const fn = args[0];
      const opts = args[1] ?? {};
      const text = print(fn);
      if (!opts.followEarlyReturns) {
        primaryFns.add(text);
      }
      const pass = !opts.followEarlyReturns ? 'primary' : primaryFns.has(text) ? 'sharedRet' : 'sharedTail';
      if (
        opts.anchorConstCopies &&
        ((pass === 'primary' && fail.primary) || (pass === 'sharedRet' && fail.sharedRet))
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
  primaryFns.clear();
  const errors: string[] = [];
  const cands = enumerateCandidates('f', asm, ARMV4T_AGBCC, {
    prototypes: P,
    onLeverError: (label) => errors.push(label),
  });
  return { errors, cands };
};

test.each([
  ['/shared-tail', THUMB],
  ['/shared-ret', THUMB_LEFT],
])('the %s twin skips every axis point its primary sibling dropped, and keeps the rest', (suffix, asm) => {
  const { errors, cands } = run(asm, { primary: true, sharedRet: false });
  expect(errors.some((l) => l.includes('/defsite') && !l.includes('/shared-'))).toBe(true);
  const twin = cands.filter((c) => c.label.includes(suffix));
  expect(twin.length).toBeGreaterThan(0);
  expect(twin.filter((c) => c.label.includes('/defsite'))).toEqual([]);
});

test('a point the `/shared-ret` twin drops still ships in the `/shared-tail` twin', () => {
  const { errors, cands } = run(THUMB_FLAT, { primary: false, sharedRet: true });
  expect(errors.some((l) => l.includes('/shared-ret') && l.includes('/defsite'))).toBe(true);
  expect(cands.filter((c) => c.label.includes('/shared-ret') && c.label.includes('/defsite'))).toEqual([]);
  expect(cands.some((c) => c.label.includes('/shared-tail') && c.label.includes('/defsite'))).toBe(true);
});
