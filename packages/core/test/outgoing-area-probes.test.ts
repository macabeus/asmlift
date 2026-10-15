// `survivorBound` (frontend/stackargs.ts) applies the contrapositive of a universal agbcc fact: the
// caller never reads a word of its outgoing area back, so a word it loads is a local. The committed probe (`scripts/regen-outgoing-area-probes.ts`) is what that universal rests
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

// THE UNIVERSAL ITSELF: no load of the outgoing area, anywhere. agbcc's source says why
// (thumb.h:628 sets ACCUMULATE_OUTGOING_ARGS; calls.c:642 compiles save_fixed_argument_area only
// under REG_PARM_STACK_SPACE, which thumb.h never defines; calls.c:1599-1610 precomputes every
// argument that contains a call; and store_one_arg, calls.c:3420-3470, saves an argument word
// only when a nested call overlaps it, which that precompute rules out). These are the shapes that
// would read the area if anything did: libcalls in arguments 5 and 6 (`libcalls`), a five-argument
// call nested in a six-argument one (`nested`), a conditional call in an argument (`cond`), and
// spilled locals live across six-argument calls (`spills`, the positive control: its loads exist
// and all land above the area).
test('no function loads a word of its outgoing area, whatever its arguments call', () => {
  const words: Record<string, number> = { five: 1, six: 2, use: 0, pick: 0, __divsi3: 0, __modsi3: 0 };
  const fns = [...asm.matchAll(/^(\w+):$/gm)].map((m) => m[1]);
  expect(fns).toEqual(['twice', 'owns', 'libcalls', 'nested', 'cond', 'spills']);
  const loadsAbove: Record<string, number[]> = {};
  for (const fn of fns) {
    const lines = asm
      .slice(asm.indexOf(`${fn}:`))
      .split('\n')
      .map((l) => l.trim());
    const text = lines.slice(
      0,
      lines.findIndex((l) => l.startsWith('.size')),
    );
    const area = Math.max(0, ...text.flatMap((l) => (l.startsWith('bl\t') ? [4 * words[l.slice(3)]] : [])));
    const loads = text.flatMap((l) => {
      const m = /^ldr\t\w+, \[sp(?:, #(0x[0-9a-f]+))?\]$/.exec(l);
      return m ? [m[1] === undefined ? 0 : Number(m[1])] : [];
    });
    expect(text.filter((l) => /^ld\w*\t.*\bsp\b/.test(l))).toHaveLength(loads.length);
    expect(
      loads.filter((o) => o < area),
      fn,
    ).toEqual([]);
    loadsAbove[fn] = loads;
  }
  expect(loadsAbove.spills.length).toBeGreaterThan(0);
});
