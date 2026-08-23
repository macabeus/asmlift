// An UNDEFINED edge argument gets no copy (structure.ts undefCarriesNothing). `undef` is storage
// whose only writer is this function and which none of its stores reached on this path, so
// `w = uninit_sp0;` spells a read of storage that was never written — an assignment the asm has no
// instruction for, and one that pins whatever register the undefined value was allocated across the
// merge. Not an axis: no source spells a read of a local it has not written, so there is nothing
// for a differ to referee.
//
// The guard is what makes it sound, and it is the half these tests pin hardest. Dropping the copy
// leaves the variable holding whatever it held, which is the undefined value only while NOTHING
// wrote it before this edge. A merge that adopted an incoming parameter's name is the case where
// something did, and there the copy has to stand — dropping it would substitute the parameter's
// defined value for the undefined one, silently, in compiling C.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';

const emitWith = (ir: string, anchorConstCopies: boolean, returnsVoid = true): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, { anchorConstCopies, returnsVoid }));
};
const emit = (ir: string, returnsVoid = true): string => emitWith(ir, false, returnsVoid);

// THE ISOLATE — `synthetic:loopfall`'s shape. A local decided inside a loop body on some but not
// all paths is a loop-carried phi whose entry operand is undefined, and the entry operand is the
// only place the undef appears.
const LOOPFALL = `fn loopfall {
^bb0(%n: u32):
  %u: u32 = undef {key="sp@0"}
  %z: u32 = const {value=0}
  br ^bb1(%z, %u)
^bb1(%i: u32, %w: u32):
  %c: u32 = icmp_ult %i, %n
  cond_br %c, ^bb2(%i, %w), ^bb6()
^bb2(%i2: u32, %w3: u32):
  %g: u32 = const {value=50345008}
  %x: u32 = load %g {off=0, signed=false, width=4}
  %sev: u32 = const {value=7}
  %cc: u32 = icmp_ugt %x, %sev
  cond_br %cc, ^bb4(%w3), ^bb3(%x)
^bb3(%xx: u32):
  %w2: u32 = shr_u %xx {imm=2}
  br ^bb4(%w2)
^bb4(%wm: u32):
  %g2: u32 = const {value=50345024}
  store %g2, %wm {off=0, width=4}
  %one: u32 = const {value=1}
  %i3: u32 = add %i2, %one
  br ^bb1(%i3, %wm)
^bb6():
  ret
}
`;

test("a loop-carried phi's undefined entry opens the loop with no assignment at all", () => {
  const out = emit(LOOPFALL);
  expect(out).not.toContain('= uninit_sp0'); // no preheader copy…
  // …and the loop variable is the source's own uninitialised local: declared, written only in the
  // arm that decides it, read after.
  expect(out).toContain('    u32 v1;\n');
  expect(out).toContain('v1 = v2 >> 2;');
  expect(out).toContain('*(s32 *)50345024 = v1;');
});

// The same shape without a loop: one arm decides the value, the other reaches the merge with
// nothing written. The merge names no other value, so nothing wrote it before either edge.
const DIAMOND = `fn diamond {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  %3: s32 = undef {key="sp@4"}
  %4: u32 = icmp_eq %0, %2
  cond_br %4, ^bb1(%3), ^bb2()
^bb2():
  %7: s32 = mul %1, %1
  br ^bb1(%7)
^bb1(%5: s32):
  %6: s32 = const {value=50345024}
  store %6, %5 {off=0, width=4}
  ret
}
`;

test('a switch/if arm that decides nothing assigns nothing, and the arm empties', () => {
  expect(emit(DIAMOND)).toBe(
    'void diamond(s32 a0, s32 a1) {\n    s32 v0;\n    s32 uninit_sp4;\n' +
      '    if (a0 != 0) v0 = a1 * a1;\n    *(s32 *)50345024 = v0;\n    return;\n}\n',
  );
});

// THE REFUSAL. The merge adopted the incoming parameter's name, so `a0` holds a DEFINED value on
// the way into the undefined edge. Dropping the copy there would return `a0 + 1` where the machine
// returns garbage + 1 — a different function, and one that still compiles.
const ADOPTED = `fn adopted {
^bb0(%0: s32):
  %1: s32 = undef {key="sp@0"}
  %2: s32 = const {value=0}
  %3: u32 = icmp_eq %0, %2
  cond_br %3, ^bb1(%1), ^bb1(%0)
^bb1(%4: s32):
  %5: s32 = const {value=1}
  %6: s32 = add %4, %5
  ret %6
}
`;

test('a merge holding a parameter is written before the edge, so the copy stands', () => {
  expect(emit(ADOPTED, false)).toBe(
    's32 adopted(s32 a0) {\n    s32 uninit_sp0;\n    if (a0 == 0) a0 = uninit_sp0;\n    return a0 + 1;\n}\n',
  );
});

// EDGE COPIES ONLY. A store of an undefined value is a real instruction — the source wrote
// `*p = w;` with `w` uninitialised — so the undef materializes as the expression it always was.
const STORED = `fn stored {
^bb0():
  %0: s32 = undef {key="sp@0"}
  %1: s32 = const {value=50345024}
  store %1, %0 {off=0, width=4}
  ret
}
`;

test('a store of an undefined value still emits', () => {
  expect(emit(STORED)).toBe(
    'void stored(void) {\n    s32 uninit_sp0;\n    *(s32 *)50345024 = uninit_sp0;\n    return;\n}\n',
  );
});

// THE REFUSAL, ONE AXIS OVER. `/defsite` (anchorConstCopies) MOVES a merge copy off the edge to the
// const's own def site, which dominates it — so the name is written before the undefined arm runs
// even though no member of its class has a def-block that reaches this predecessor. Dropping the
// arm's copy there stores 0 where the machine stores whatever the arm left.
//
// The sibling displacement is a pre-update exit copy sunk to the top of a loop body, and where that
// edge goes is irrelevant to it: `preUpdateCopies` writes the name at the TOP OF THE BODY, so it
// precedes every edge inside the loop, not only one leaving it. What refuses the collision is
// `dest-free-inside-loop` (hazards.ts) — an in-body merge under the exit param's name is a block
// param `definedInBody` sees, so the slot is never sunk (hazards.test.ts, 'a BLOCK PARAM inside the
// body under the destination name counts as busy'). That gate is not stated about undef and carries
// its own KNOWN GAP, so the pair is a conjecture; `sunkCopyOverDroppedUndef` re-checks it per
// function and declines loud rather than substituting a defined value.
const ANCHORED = `fn anch {
^bb0(%0: s32):
  %1: s32 = undef {key="sp@0"}
  %2: s32 = const {value=0}
  %3: s32 = const {value=7}
  %4: u32 = icmp_eq %0, %3
  cond_br %4, ^bb1(), ^bb2()
^bb1():
  br ^bb3(%2)
^bb2():
  br ^bb3(%1)
^bb3(%5: s32):
  %6: s32 = const {value=50345024}
  store %6, %5 {off=0, width=4}
  ret
}
`;

test('an ANCHORED const is a write before the edge, so the copy stands', () => {
  // off: the const rides its own edge, nothing precedes the undefined arm, and the copy drops
  expect(emitWith(ANCHORED, false)).toBe(
    'void anch(s32 a0) {\n    s32 v0;\n    s32 uninit_sp0;\n' +
      '    if (a0 == 7) v0 = 0;\n    *(s32 *)50345024 = v0;\n    return;\n}\n',
  );
  // on: `v0 = 0;` is hoisted to the def site, so the undefined arm has to overwrite it
  expect(emitWith(ANCHORED, true)).toBe(
    'void anch(s32 a0) {\n    s32 v0;\n    s32 uninit_sp0;\n' +
      '    v0 = 0;\n    if (a0 != 7) v0 = uninit_sp0;\n    *(s32 *)50345024 = v0;\n    return;\n}\n',
  );
});
