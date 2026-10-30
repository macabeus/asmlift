// THE OFF-SIBLING WITNESS COMPOSES (rank.ts, `StructureVariation.offWitness`). A setting whose
// variation's OFF sibling structured without firing the witness is skipped, because it would rebuild
// that sibling's tree. The skipped setting must still be recorded as having fired what its sibling
// fired: otherwise a setting carrying TWO witnessed variations (`/tail-copies/for-continue`) finds
// each of its siblings skipped-and-unrecorded and is structured, however inert both variations are.
// `structureChecked` is wrapped only to observe which settings reach it.
import { expect, test, vi } from 'vitest';

import { enumerateCandidates } from '../src/rank';
import { STRUCTURE_VARIATIONS } from '../src/rank-variations';
import { ARMV4T_AGBCC } from '../src/target';

const reached: Record<string, unknown>[] = [];

vi.mock('../src/pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pipeline')>();
  return {
    ...actual,
    structureChecked: (...args: Parameters<typeof actual.structureChecked>) => {
      reached.push({ ...(args[1] ?? {}) });
      return actual.structureChecked(...args);
    },
  };
});

// `shared-tail.test.ts`'s `THUMB_FLAT`: no loop and no jump table, so neither witnessed variation
// has anything to change.
const THUMB_FLAT =
  'f:\n\tpush\t{lr}\n\tldr\tr2, .L9\n\tcmp\tr0, #0\n\tblt\t.L3\n\tcmp\tr1, #0\n\tbge\t.L5\n' +
  '\tcmp\tr0, #5\n\tbeq\t.L7\n\tmov\tr3, #7\n\tb\t.L6\n.L3:\n\tstr\tr1, [r2, #8]\n.L5:\n\tmov\tr3, #9\n' +
  '.L6:\n\tstr\tr3, [r2, #4]\n\tpop\t{r0}\n\tbx\tr0\n.L7:\n\tmov\tr3, #8\n\tstr\tr3, [r2, #4]\n' +
  '\tpop\t{r0}\n\tbx\tr0\n.L10:\n\t.align\t2, 0\n.L9:\n\t.word\tgQ\n';

test('no setting carrying an inert witnessed variation is structured, alone or combined', () => {
  const witnessed = STRUCTURE_VARIATIONS.filter((v) => v.offWitness !== undefined);
  // two of them, or there is nothing to compose
  expect(witnessed.length).toBeGreaterThanOrEqual(2);
  const optionOf = (on: boolean, v: (typeof witnessed)[number]) => Object.entries(v.options(on) ?? {})[0];
  reached.length = 0;
  const cands = enumerateCandidates('f', THUMB_FLAT, ARMV4T_AGBCC, {
    prototypes: { f: { params: 2, returnsVoid: true } },
  });
  expect(cands.length).toBeGreaterThan(0);
  expect(reached.length).toBeGreaterThan(0);
  const carrying = reached.filter((opts) =>
    witnessed.some((v) => {
      const [name, value] = optionOf(true, v) ?? [];
      return name !== undefined && opts[name] === value;
    }),
  );
  expect(carrying).toEqual([]);
});
