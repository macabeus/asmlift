// A CALLEE'S BODY IS LIFTED READING ITS OWN CALLEES' BODIES, at every depth (frontend/callee-body.ts
// `calleeBodyReads`, pipeline.ts `bodyReadsIn`).
//
// A call nothing declares is bounded by its callee's body (frontend/callee-body.ts), and that body
// is a lift too: a call inside it that stages stack words lifts only where ITS callee's body sizes
// the block, and a call it takes at every incoming register reads no more than its callee's body
// does. kl2dct's sub_08037530 calls sub_08037AF8, whose body lifts only where EntityCreate's body
// sizes its 9-word call to it. A call to the function itself is sized by the stack
// words its own entry loads (callee-body.ts `unliftedReads`): kl2dct's EntityCreate calls itself with
// nine words. A body whose lift is under way, met again further down (a cycle), is read the same way,
// so the reading ends. The shapes are agbcc's own output
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
    prototypes: {
      nine: { returnsVoid: true },
      mid: { returnsVoid: true },
      mid2: { returnsVoid: true },
      top: { returnsVoid: true },
      cyca: { returnsVoid: true },
      cycb: { returnsVoid: true },
      cyoa: { returnsVoid: true },
      cyob: { returnsVoid: true },
    },
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

describe('the reading goes as deep as the calls do', () => {
  test("`top` wraps `mid` once more: `nine`'s body, three levels down, still sizes the chain", () => {
    const r = lift('stkbody_deep', fn('nine') + fn('mid') + fn('top') + fn('stkbody_deep'));
    expect(r.source).toMatch(/\n {12}top\(\);\n/);
  });

  test("without `nine`'s body, `top`'s bound is unproven and the guess takes r0 (control)", () => {
    const r = lift('stkbody_deep', fn('mid') + fn('top') + fn('stkbody_deep'));
    expect(r.source).toMatch(/v0 = top\(v0\);/);
  });

  test('a body handed in that decided only a body above it is named as read below', () => {
    const r = decompile('stkbody_nest', fn('stkbody_nest'), ARMV4T_AGBCC, {
      prototypes: { nine: { returnsVoid: true }, mid: { returnsVoid: true } },
      calleeBodies: { mid: { kind: 'listing', text: fn('mid') }, nine: { kind: 'listing', text: fn('nine') } },
    });
    expect(r.source).toMatch(/\n {12}mid\(\);\n/);
    expect(Object.keys(r.calleeBodiesAsked)).toEqual(['mid']);
    expect(r.calleeBodiesBelow).toEqual(['nine']);
  });

  // `lz` hands `leaf` four constants: its entry-read call takes no register, so `leaf`'s bound
  // could change nothing, and asking it would lift `leaf`'s body (and every body below it) for no answer
  test("a body's call that holds none of its incoming registers asks no body below", () => {
    const r = decompile('stkbody_lz', fn('stkbody_lz'), ARMV4T_AGBCC, {
      prototypes: { lz: { returnsVoid: true } },
      calleeBodies: { lz: { kind: 'listing', text: fn('lz') }, leaf: { kind: 'listing', text: fn('leaf') } },
    });
    expect(r.source).toBe(
      decompile('stkbody_lz', fn('stkbody_lz'), ARMV4T_AGBCC, {
        prototypes: { lz: { returnsVoid: true } },
        calleeBodies: { lz: { kind: 'listing', text: fn('lz') } },
      }).source,
    );
    expect(r.calleeBodiesBelow).toEqual([]);
  });

  test('a cycle ends, and proves no more than no bodies at all', () => {
    expect(lift('stkbody_cyc', fn('cyca') + fn('cycb') + fn('stkbody_cyc')).source).toBe(
      lift('stkbody_cyc', fn('stkbody_cyc')).source,
    );
  });

  // `cyoa` hands `cyob` r0-r3, and `cyob` zeroes r1-r3 before it calls `cyoa` and passes its own r0
  // on, so each call keeps an incoming register and asks the other's body. Read in a cycle, a
  // lift of either reads the other before that one's lift is done, so a single pass would bound
  // `cyoa` at one or four by which of `cyord1` and `cyord2` asks. Each is lifted again reading the
  // other as a body that does not lift, and the callee alone decides: `cyoa` four, `cyob` one.
  test('bodies that call each other say the same whichever is asked first', () => {
    const both = fn('cyoa') + fn('cyob');
    const first = lift('cyord1', both + fn('cyord1')).source;
    const second = lift('cyord2', both + fn('cyord2')).source;
    expect(first).toMatch(/\n {4}cyoa\(a0, &gh\);\n[^]*\n {4}cyob\(a0\);\n/);
    expect(second).toMatch(/\n {4}cyob\(a0\);\n[^]*\n {4}cyoa\(a0, &gw\);\n/);
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
