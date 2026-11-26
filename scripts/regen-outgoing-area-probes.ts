// Regenerate the committed agbcc probes the Thumb frontend's outgoing-argument analysis rests on.
//
// WHY A SCRIPT AND NOT A NOTE. Each probe backs a universal emission fact that the analysis reads
// backwards, and a universal wrong for some producer costs an ANSWER, an argument dropped from a
// call. So it owes the compiled objects it rests on, re-measurable and not only re-readable
// (`docs/level-tower.md`, RE-READABLE IS NOT RE-MEASURABLE).
//
//   agbcc-restage.s — `loadedWordBound` (frontend/stackargs.ts) applies the contrapositive of "agbcc
//     never reads a word of its outgoing area" (`target.ts` `outgoingAreaNeverLoadedFrom`).
//     `twice` re-stages an unchanged argument before its second call, `owns` assigns to its own
//     incoming stack parameter, which is its caller's outgoing word, and `libcalls`/`nested`/
//     `cond`/`spills` put calls inside stack arguments and spills beside them, and load no word of
//     the area.
//     Read by `packages/core/test/outgoing-area-probes.test.ts`.
//   agbcc-escape.s — the `escape` event reads a handed-out frame address as a local's
//     (`target.ts` `escapedFrameAddressNamesALocal`). `f0`/`f1` place an address-taken local at
//     [sp,#0] only with no outgoing word and above the area otherwise; `qh5`/`a2`/`a3` are the
//     residue, a by-value struct argument's block-copy base, and stage every outgoing word in
//     ascending offset order around it. Read by `packages/core/test/frame-escape-probes.test.ts`.
//   agbcc-entry-stack.s — the incoming stack words a callee loads bound the stack words an
//     undeclared call to it takes from below (frontend/callee-body.ts `CalleeStackWords`):
//     `nine`/`narrow9`/`fifth`/`seventh`/`owns`/`kr` load theirs in the straight-line entry
//     (frontend/thumb-entry.ts) and `br5` on one branch only; `call9`/`loop9`/`call_br` stage the
//     block their callee reads, and `krmore`/`krfewer` stage more and fewer words than `kr` reads.
//     Read by `packages/core/test/thumb-entry.test.ts` and `callee-stack-words.test.ts`.
//   agbcc-indexed.s — a load through a runtime index into a frame array is read as the outgoing-
//     argument analysis's `indexed-read` event, based where the index is added, which must be the
//     array's start or above it: `im1`/`six3` keep `a[i - 1]`'s constant in the index, `six1`/`six2`
//     stage [sp,#0] between two reads based above it, `bytes`/`members` add a byte array's and a
//     struct member's offset after the index, `ix` reads `a[k]` on one path of a loop only, and
//     `below1`..`below6` read through `a - 1` / `a - 2`, beneath the array, beside a K&R call's
//     stack arguments staged after the read, before it, and on another path; `blk1`..`blk3` pass a
//     struct by value through such a pointer, its register words loaded after the stack words.
//     `walk4`/`walkcall`/`walkkr`/`walkbefore`/`walkdn`/`walkbelow` loop over a local array through
//     a pointer captured before the loop and stepped up by the load (`ldmia r5!`), or down.
//     Read by `packages/core/test/frame-indexed-probes.test.ts`.
//   agbcc-dmafill.s — a DMA fill's source temp, its address stored to the device's source register:
//     `dcall`/`dpaths` load that register's address into a register that holds a frame address
//     elsewhere in the function, `dtwo` publishes the frame base in a frame wider than one word with a
//     call after it, and `dfive` moves the temp above a fifth argument staged at [sp,#0].
//     Read by `packages/core/test/frame-dmafill-probes.test.ts`.
//   agbcc-nested-body.s — a callee's body is lifted reading its own callees' bodies (core
//     pipeline.ts `bodyReadsIn`): `mid` stages `nine`'s five stack words, and `mid2` calls `one`,
//     which reads r0 alone, at a point where r1-r3 still hold `mid2`'s incoming values; and
//     `stkbody_self` stages its own five stack words for a call to itself.
//     Read by `packages/core/test/callee-body-nested.test.ts`.
//
//   ASMLIFT_AGBCC=… npx tsx scripts/regen-outgoing-area-probes.ts
//
// agbcc emits TEXT, so what is committed is the compiler's own `.s`, at agbcc's canonical flags.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { TOOLCHAIN_TARGETS } from '../packages/core/src/target';
import { TOOLCHAIN, compileTargetAsm } from '../packages/toolchains/src/index';

const CORPUS = join(import.meta.dirname, '..', 'packages', 'core', 'test', 'corpus');
const PROBES = [
  { source: 'probe-agbcc-restage.c', out: 'agbcc-restage.s', readBy: 'outgoing-area-probes.test.ts' },
  { source: 'probe-agbcc-escape.c', out: 'agbcc-escape.s', readBy: 'frame-escape-probes.test.ts' },
  { source: 'probe-agbcc-entry-stack.c', out: 'agbcc-entry-stack.s', readBy: 'thumb-entry.test.ts' },
  { source: 'probe-agbcc-indexed.c', out: 'agbcc-indexed.s', readBy: 'frame-indexed-probes.test.ts' },
  { source: 'probe-agbcc-dmafill.c', out: 'agbcc-dmafill.s', readBy: 'frame-dmafill-probes.test.ts' },
  { source: 'probe-agbcc-nested-body.c', out: 'agbcc-nested-body.s', readBy: 'callee-body-nested.test.ts' },
];

const flags = TOOLCHAIN_TARGETS.agbcc.canonicalFlags;
for (const { source, out, readBy } of PROBES) {
  const header =
    `@ GENERATED by scripts/regen-outgoing-area-probes.ts — do not hand-edit.\n` +
    `@ source    : packages/core/test/corpus/${source}\n` +
    `@ toolchain : ARMV4T_AGBCC (gcc 2.9-arm, Thumb), binary from $ASMLIFT_AGBCC\n` +
    `@ cc flags  : ${[...TOOLCHAIN.harnessFlags, ...flags].join(' ')}\n` +
    `@ read by   : packages/core/test/${readBy}\n`;
  const path = join(CORPUS, out);
  writeFileSync(path, header + compileTargetAsm(readFileSync(join(CORPUS, source), 'utf8'), flags));
  console.log(`wrote ${path}`);
}
