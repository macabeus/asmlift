// A CALLEE'S BODY IS LIFTED READING ITS OWN CALLEES' BODIES, one level further (pipeline.ts
// `bodyReadsIn`).
//
// A call nothing declares is bounded by its callee's body (frontend/callee-body.ts), and that body
// is a lift too: a call inside it that stages stack words lifts only where ITS callee's body sizes
// the block, and a call it takes at every incoming register reads no more than its callee's body
// does. kl2dct's sub_08037530 calls sub_08037AF8, whose 9-word call to EntityCreate left its body
// unlifted and the caller's guess unbounded. A call to the function itself is sized by the stack
// words its own entry loads (callee-body.ts `bodyReads`): kl2dct's EntityCreate calls itself with
// nine words. The shapes are agbcc's own output
// (corpus/agbcc-nested-body.s, scripts/regen-outgoing-area-probes.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-nested-body.s'), 'utf8');
/** One function of the probe, from its label to its `.size` line. */
const fn = (name: string): string => {
  const from = asm.indexOf(`\t.globl\t${name}\n`);
  const to = asm.indexOf(`.size\t ${name},`, from);
  return asm.slice(from, asm.indexOf('\n', to) + 1);
};
const lift = (name: string, text: string) =>
  decompile(name, text, ARMV4T_AGBCC, {
    prototypes: { nine: { returnsVoid: true }, mid: { returnsVoid: true }, mid2: { returnsVoid: true } },
  });

describe("a body's own staged call is sized by its callee's body", () => {
  test("`mid` lifts reading `nine`'s five stack words, and reads no argument", () => {
    const r = lift('stkbody_nest', fn('nine') + fn('mid') + fn('stkbody_nest'));
    expect(r.source).toMatch(/\n {12}mid\(\);\n/);
  });

  test("without `nine`'s body, `mid`'s body proves nothing and the guess takes r0 (control)", () => {
    const r = lift('stkbody_nest', fn('mid') + fn('stkbody_nest'));
    expect(r.source).toMatch(/v0 = mid\(v0\);/);
  });

  test('the whole probe as one input: the same answer', () => {
    expect(lift('stkbody_nest', asm).source).toBe(
      lift('stkbody_nest', fn('nine') + fn('mid') + fn('stkbody_nest')).source,
    );
  });
});

describe("a body's call taken at every incoming register reads no more than its callee's body", () => {
  test('`mid2` hands `one` r0 alone, so its bound is one word and r1/r2 are no arguments', () => {
    const r = lift('stkbody_rnest', fn('one') + fn('mid2') + fn('stkbody_rnest'));
    expect(r.source).toMatch(/\n {4}mid2\(\*a0\);\n/);
  });

  test("without `one`'s body, the call takes r0-r3 and `mid2` is bounded at four (control)", () => {
    const r = lift('stkbody_rnest', fn('mid2') + fn('stkbody_rnest'));
    expect(r.source).toMatch(/mid2\(\*a0, &gv, a2 \+ 3\);/);
  });
});

describe('a call to itself is sized by its own entry', () => {
  test('a recursive nine-argument call: the five stack words its entry loads', () => {
    expect(lift('stkbody_self', fn('stkbody_self')).source).toMatch(
      /if \(a0 > 0\) stkbody_self\(a0 - 1, a1, a2, a3, a4, a5, a6, a7, a8 \+ 1\);/,
    );
  });
});
