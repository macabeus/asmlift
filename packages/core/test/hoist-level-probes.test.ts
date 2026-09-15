// agbcc declares `readsStayWhereWritten` (target.ts), and every flag set of a toolchain decompiles
// against its declarations. gcse.c's code hoister runs at -Os and not at -O2, so the committed pair
// (`scripts/regen-flag-pair-probes.ts`) is what the declaration's reach at -Os rests on: on
// `if (c) A(*gp); else B(*gp);` -Os moves the pool ADDRESS load above the branch and leaves each
// dereference in the arm that spelled it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const f = (level: 'O2' | 'Os'): string[] => {
  const lines = readFileSync(join(import.meta.dirname, 'corpus', `agbcc-hoist-${level}.s`), 'utf8')
    .split('\n')
    .map((l) => l.trim());
  return lines.slice(lines.indexOf('f:'), lines.indexOf('.Lfe1:'));
};

test.each([
  ['O2', 'after'],
  ['Os', 'before'],
] as const)('-%s loads the address %s the branch, and each arm dereferences on its own', (level, where) => {
  const body = f(level);
  const branch = body.findIndex((l) => /^beq\t/.test(l));
  const addressLoad = body.findIndex((l) => /^ldr\tr\d, \.L\d+$/.test(l));
  expect(branch).toBeGreaterThan(0);
  expect(where === 'before' ? addressLoad < branch : addressLoad > branch).toBe(true);
  const derefs = body.flatMap((l, i) => (/^ldr\tr0, \[r\d\]$/.test(l) ? [i] : []));
  expect(derefs).toHaveLength(2);
  expect(derefs.every((i) => i > branch)).toBe(true);
});
