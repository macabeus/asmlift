// THE EXIT REGION OF A LOOP BREAK STOPS AT THE LOOP.
//
// `for (i = 0; i < n; i++) { p = i; while (1) { switch (n - p) { case 0: p += 1; break; case 1: p +=
// 2; break; case 2: u(p); goto next; } if (b(p)) break; c(p); } h(…); next:; }` breaks out of the
// inner loop after the switch has rewritten `p`, and the arm that leaves for the outer latch reads
// `p`. That arm is reached from the break's exit only round the outer loop and back through the
// inner header, which binds `p` afresh, so it reads no value the break left stale, and the exit
// region (structure.ts `exitRegionOf`) does not take it in, as in sub_080349AC's script loop, whose
// arms `bl` to the outer latch. The control reads `p` in the exit itself (`h(p)`), which is stale
// there, and keeps the naming that reads the old value. Both are judged against their own IR by the
// trace oracle (`irAgreement`).
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { readabilityRewrites } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { irAgreement, irTraceOf } from './helpers';

const SEEDS = Array.from({ length: 2000 }, (_, i) => i + 1);

const judged = (ir: string) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  const sfn = structure(fn, {});
  return {
    src: cBackend.emit(sfn),
    agreement: irAgreement(ir, sfn, SEEDS),
    shipped: irAgreement(ir, readabilityRewrites(sfn), SEEDS),
  };
};

const alike = (r: { judged: number; disagree: number }): void => {
  expect(r.disagree).toBe(0);
  expect(r.judged).toBeGreaterThan(SEEDS.length / 2);
};

const ran = (ir: string, callee: string): number =>
  SEEDS.filter((seed) => {
    try {
      return irTraceOf(parse(ir), seed).some((e) => e.fn === callee);
    } catch {
      return false;
    }
  }).length;

/** The nest above, its exit calling `h(i)` or, in the control, `h(p)`. */
const nest = (exitReads: 'i' | 'p') => `fn ex {
^bb0(%n: s32):
  %z: s32 = const {value=0}
  %one: s32 = const {value=1}
  %two: s32 = const {value=2}
  br ^bb1(%z)
^bb1(%i: s32):
  %c: u32 = icmp_slt %i, %n
  cond_br %c, ^bb2(%i), ^bb9()
^bb2(%p: s32):
  %t: s32 = sub %n, %p
  switch_br %t, ^bb3(), ^bb4(), ^bb6(), ^bb10() {cases=[0;1;2]}
^bb3():
  %p1: s32 = add %p, %one
  br ^bb5(%p1)
^bb4():
  %p3: s32 = add %p, %two
  br ^bb5(%p3)
^bb10():
  br ^bb5(%p)
^bb6():
  %u: s32 = call %p {target="u"}
  br ^bb8()
^bb5(%q: s32):
  %b: s32 = call %q {target="b"}
  cond_br %b, ^bb7(), ^bb11()
^bb11():
  %c2: s32 = call %q {target="c"}
  br ^bb2(%q)
^bb7():
  %h: s32 = call %${exitReads} {target="h"}
  br ^bb8()
^bb8():
  %i2: s32 = add %i, %one
  br ^bb1(%i2)
^bb9():
  ret
}`;

test('a break whose exit reaches an arm only through the loop header again is no hazard', () => {
  const ir = nest('i');
  const { src, agreement, shipped } = judged(ir);
  // the arm that leaves for the outer latch reads the header's name, the one the switch rewrote
  const named = /(v\d+) = (v\d+) \+ v\d+;\n\s*break;/.exec(src);
  expect(named).not.toBeNull();
  expect(named![1]).toBe(named![2]);
  expect(src).toMatch(new RegExp(`u\\(${named![1]}\\);`));
  expect(src).not.toContain('goto');
  alike(agreement);
  alike(shipped);
  expect(ran(ir, 'u')).toBeGreaterThan(SEEDS.length / 8);
  expect(ran(ir, 'h')).toBeGreaterThan(SEEDS.length / 8);
});

test('CONTROL: an exit that reads the rewritten name itself still reads the old value', () => {
  const ir = nest('p');
  const { src, agreement, shipped } = judged(ir);
  // the header's value keeps a name of its own past the switch, the one `h` reads after the loop
  const h = /h\((v\d+)\)/.exec(src);
  expect(h).not.toBeNull();
  expect(src).not.toMatch(new RegExp(`${h![1]} = ${h![1]} \\+`));
  alike(agreement);
  alike(shipped);
  expect(ran(ir, 'h')).toBeGreaterThan(SEEDS.length / 8);
});
