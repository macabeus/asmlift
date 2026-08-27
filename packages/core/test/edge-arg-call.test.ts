// A CALL WHOSE VALUE RIDES A `cond_br` EDGE runs on one path in the C and on every path in the asm.
//
// `structure/analysis.ts`'s `anchored` calls a terminator ONE render position, which is true of the
// branch itself and false of its edge copies: those are emitted inside the arms. So a call whose
// only consumer is a successor argument was inlined into one arm and skipped on the other — an
// effect the asm performs unconditionally, performed sometimes. `assertEffectsPreserved` cannot see
// it: the call IS emitted (its `total` is 1) and no path emits it twice, and the two counts that
// contract keeps are exactly those. The rule that stops it is a placement one — materialize the
// call at the position the asm ran it — and this is its guard.
//
// Reached from ordinary source, not only from hand-built IR — the compiled pair is in analysis.ts,
// and the shape is 2 of klonoa's 412 functions and 0 of 2288 sa3 ones. Toolchain-free.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';

const emit = (ir: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
};

const EDGE_CALL = `fn f {
^bb0(%0: unk32):
  %1: unk32 = call %0 {target="f2"}
  %2: unk32 = const {value=0}
  %3: u32 = icmp_sgt %0, %2
  cond_br %3, ^bb1(%1), ^bb1(%2)
^bb1(%4: unk32):
  ret %4
}
`;

test('a call whose only consumer is a branch argument is emitted on every path', () => {
  const src = emit(EDGE_CALL);
  // the call is a statement of its own, ahead of the branch — not an arm's edge copy
  expect(src).toMatch(/v0 = f2\(a0\);\s*\n\s*if /);
  expect(src.match(/f2\(/g)).toHaveLength(1);
  // and nothing has made the OTHER arm's constant conditional in its place
  expect(src).toContain('v0 = 0;');
});

test('a `switch_br` arm hides the call the same way, and is covered by the same rule', () => {
  // The scope is every multi-successor terminator, not `cond_br` alone: a jump table's edge copies
  // are arm bodies too. Narrowed to `cond_br` this fixture calls `f2` under `case 0:` only.
  const ir = `fn f {
^bb0(%0: unk32):
  %1: unk32 = call %0 {target="f2"}
  %2: unk32 = const {value=0}
  switch_br %0, ^bb1(%1), ^bb2(), ^bb3() {cases=[0;1]}
^bb1(%3: unk32):
  ret %3
^bb2():
  ret %2
^bb3():
  ret %0
}
`;
  const src = emit(ir);
  expect(src).toMatch(/v0 = f2\(a0\);\s*\n\s*switch /);
  expect(src.match(/f2\(/g)).toHaveLength(1);
});

test('the same call with a second consumer still materializes — the older rule', () => {
  // A second operand slot duplicates the call, which `sites.length > 1` already refused. The new
  // rule is about the SOLE-use case, so this one must keep passing for the reason it always did.
  const ir = EDGE_CALL.replace('  ret %4', '  %5: unk32 = add %4, %1\n  ret %5');
  expect(emit(ir).match(/f2\(/g)).toHaveLength(1);
});
