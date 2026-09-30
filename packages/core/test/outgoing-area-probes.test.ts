// `survivorBound` (frontend/stackargs.ts) applies the contrapositive of a universal agbcc fact: the
// caller never reads a word of its outgoing area back after a call, so a word loaded after a call is
// a local. The committed probe (`scripts/regen-outgoing-area-probes.ts`) is what that universal rests
// on — the callee may assign to the word, and the caller re-stages an argument before every call
// rather than trust it to survive.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-restage.s'), 'utf8');

const body = (fn: string, end: string): string[] => {
  const lines = asm.split('\n').map((l) => l.trim());
  return lines.slice(lines.indexOf(`${fn}:`), lines.indexOf(`${end}:`));
};

test('the caller re-stages an unchanged argument before every call', () => {
  const twice = body('twice', '.Lfe1');
  const calls = twice.flatMap((l, i) => (l === 'bl\tfive' ? [i] : []));
  expect(calls).toHaveLength(2);
  // r5 holds `x * y` from before the first call to after the second, and is written once
  expect(twice.filter((l) => /^\S+\tr5, /.test(l))).toEqual([
    'mov\tr5, r0',
    'mul\tr5, r5, r1',
    'str\tr5, [sp]',
    'str\tr5, [sp]',
  ]);
  let from = 0;
  for (const at of calls) {
    expect(twice.slice(from, at)).toContain('str\tr5, [sp]');
    from = at + 1;
  }
  expect(twice.slice(from).some((l) => /\[sp\]/.test(l))).toBe(false);
});

test("the callee assigns to its incoming stack parameter, which is the caller's outgoing word", () => {
  const owns = body('owns', '.Lfe2');
  // one word pushed, so [sp,#4] is argument 5 — the caller's [sp,#0]
  expect(owns.slice(1, 5)).toEqual(['push\t{lr}', 'ldr\tr1, [sp, #0x4]', 'add\tr1, r1, r0', 'str\tr1, [sp, #0x4]']);
});

test('declared, both calls take the re-staged word as argument 5; undeclared, they decline', () => {
  const twice = asm.slice(asm.indexOf('twice:'), asm.indexOf('.Lfe1:'));
  expect(decompile('twice', twice, ARMV4T_AGBCC, { prototypes: { five: { params: 5 } } }).source).toBe(
    's32 twice(s32 a0, s32 a1) {\n    s32 v0;\n    v0 = five(1, 2, 3, 4, a0 * a1);\n' +
      '    return v0 + five(1, 2, 3, 4, a0 * a1);\n}\n',
  );
  // no word is loaded after a call, so no survivor bounds the area, and the undeclared calls decline
  expect(() => decompile('twice', twice, ARMV4T_AGBCC)).toThrow(/is never reloaded .* outgoing stack argument/);
});
