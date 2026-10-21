// What an elided jump-table dispatch leaves in the registers it writes, and where it is written
// (frontend/jump-table.ts `idiomLeaves`, `caseEntries`). The frontends' own fixtures are in
// thumb-switch, ppc-frontend and mips-jump-table; these pin the shared model.
import { expect, test } from 'vitest';

import { caseEntries, idiomLeaves } from '../src/frontend/jump-table';

test('a register holds what the last idiom word writing it left', () => {
  // agbcc: `lsl r0,r1,#2 ; ldr r1,=T ; add r0,r0,r1 ; ldr r0,[r0]` — the add rewrites the index
  const thumb = idiomLeaves([
    { reg: 'r0', scaled: true },
    { reg: 'r1', scaled: false },
    { reg: 'r0', scaled: false },
    { reg: 'r0', scaled: false },
  ]);
  expect([...thumb]).toEqual([
    ['r0', 'opaque'],
    ['r1', 'opaque'],
  ]);
  // mwcc: `lis r4 ; slwi r3,r3,2 ; addi r4,r4 ; lwzx r0,r4,r3 ; mtctr r0` — r3 keeps the scaled index
  const ppc = idiomLeaves([
    { reg: 'r4', scaled: false },
    { reg: 'r3', scaled: true },
    { reg: 'r4', scaled: false },
    { reg: 'r0', scaled: false },
    { reg: 'ctr', scaled: false },
  ]);
  expect(ppc.get('r3')).toBe('scaled');
  expect(ppc.get('ctr')).toBe('opaque');
});

test('a target only its table’s case edges enter is EXACT; any other edge makes it MIXED', () => {
  const leaves = new Map([
    ['r3', 'scaled' as const],
    ['r4', 'opaque' as const],
  ]);
  const t = { at: 1, scrutReg: 'r3', cases: [2, 3, 4, 2], defaultBlock: 5, leaves };
  // 2: two case edges from the switch; 3: also a branch from block 4; 4: case and the default's label
  const preds = [[], [0], [1, 1], [1, 4], [1], [1, 4]];
  const e = caseEntries([{ ...t, cases: [2, 3, 5] }], preds);
  expect(e.get(2)?.leaves).toBe(leaves);
  expect([...e.get(3)!.leaves]).toEqual([
    ['r3', 'opaque'],
    ['r4', 'opaque'],
  ]);
  expect(e.get(5)?.leaves.get('r3')).toBe('opaque');
  // the default alone is no case target: the default path never ran the idiom
  expect(caseEntries([t], preds).has(5)).toBe(false);
  // a target two tables share, and the function's entry, are MIXED
  const two = caseEntries([t, { ...t, at: 4, cases: [2] }], [[], [0], [1, 4], [1], [1], [1]]);
  expect(two.get(2)?.leaves.get('r3')).toBe('opaque');
  expect(
    caseEntries([{ ...t, cases: [0] }], [[1], [0]])
      .get(0)
      ?.leaves.get('r3'),
  ).toBe('opaque');
});
