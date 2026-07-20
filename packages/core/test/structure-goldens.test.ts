// BYTE-GOLDENS for the structurer's mutable-state machinery — the paths a structure.ts refactor
// is riskiest on and that no other offline test byte-pins. Each fixture exists to exercise ONE
// specific piece of shared dynamic state inside structure():
//
//   • POST_LOOP_USE      — the `withSub` exit-region substitution: a post-loop computation must
//                          read the loop variable by its HEADER name (activeSub, prev === null).
//   • SEQUENTIAL_LOOPS   — a second loop INSIDE the first loop's exit region: structuring its
//                          exit re-enters `withSub` while a substitution is already active, so
//                          the maps MERGE (activeSub, prev !== null) — the one path the corpus
//                          never hit. Post-loop code reads values from BOTH loops.
//   • SWAP_CYCLE         — a back edge that swaps two loop-carried values: the parallel copy has
//                          a cycle, so `sequentialize` must break it with a `tempCounter` temp.
//                          Pins temp naming + copy order.
//   • base-CSE + globals — hand thumb asm through the FULL decompile(): pool-loaded global
//                          recovery (frontend) + reused-base hoisting (L3) as EMITTED C, which
//                          their own test files only assert at AST/fragment level.
//
// Full-source `toBe` pins on purpose: any refactor of structure() that changes ONE byte of these
// fails here, in CI, without a toolchain in the loop.
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { decompile, raiseRecovered, structureChecked } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { structure } from '../src/structure/structure';
import { ARMV4T_AGBCC, structureOptionsFor } from '../src/target';

const emit = (ir: string): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn));
};

// while (i < n) i++; return i + n — the exit region COMPUTES with the loop value, so the
// substitution must spell it as the header var, not a stale SSA name.
const POST_LOOP_USE = `fn postloopuse {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: u32 = icmp_slt %2, %0
  cond_br %3, ^bb2(%2), ^bb3(%2)
^bb2(%4: s32):
  %5: s32 = const {value=1}
  %6: s32 = add %4, %5
  br ^bb1(%6)
^bb3(%7: s32):
  %8: s32 = add %7, %0
  ret %8
}
`;

test('post-loop use of the loop variable reads its header name (withSub substitution)', () => {
  expect(emit(POST_LOOP_USE)).toBe(
    's32 postloopuse(s32 a0) {\n    s32 v0;\n    for (v0 = 0; v0 < a0; v0 = v0 + 1) {\n    }\n' +
      '    return v0 + a0;\n}\n',
  );
});

// Loop A (i counts to n), then IN A'S EXIT REGION loop B (j += 2 up to i), then a return reading
// BOTH final values. B's exit-region withSub nests inside A's → the substitution maps merge.
const SEQUENTIAL_LOOPS = `fn twoloops {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  br ^bb1(%1)
^bb1(%2: s32):
  %3: u32 = icmp_slt %2, %0
  cond_br %3, ^bb2(%2), ^bb3(%2)
^bb2(%4: s32):
  %5: s32 = const {value=1}
  %6: s32 = add %4, %5
  br ^bb1(%6)
^bb3(%7: s32):
  %8: s32 = const {value=0}
  br ^bb4(%8)
^bb4(%9: s32):
  %10: u32 = icmp_slt %9, %7
  cond_br %10, ^bb5(%9), ^bb6(%9)
^bb5(%11: s32):
  %12: s32 = const {value=2}
  %13: s32 = add %11, %12
  br ^bb4(%13)
^bb6(%14: s32):
  %15: s32 = add %14, %7
  ret %15
}
`;

test("a loop inside another loop's exit region merges the two substitutions (nested withSub)", () => {
  // `return v1 + v0` is the point: the merged map must resolve BOTH loop A's value (v0, from the
  // outer substitution) and loop B's (v1, from the inner) in one exit-region expression.
  expect(emit(SEQUENTIAL_LOOPS)).toBe(
    's32 twoloops(s32 a0) {\n    s32 v0;\n    s32 v1;\n' +
      '    for (v0 = 0; v0 < a0; v0 = v0 + 1) {\n    }\n' +
      '    for (v1 = 0; v1 < v0; v1 = v1 + 2) {\n    }\n' +
      '    return v1 + v0;\n}\n',
  );
});

// while (k < 10) { swap(a, b); k++; } return a — the back edge carries (b, a, k+1) against header
// params (a, b, k): the a/b copies form a cycle sequentialize must break with a temp.
const SWAP_CYCLE = `fn swapcycle {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%0, %1, %2)
^bb1(%3: s32, %4: s32, %5: s32):
  %6: s32 = const {value=10}
  %7: u32 = icmp_slt %5, %6
  cond_br %7, ^bb2(%3, %4, %5), ^bb3(%3)
^bb2(%8: s32, %9: s32, %10: s32):
  %11: s32 = const {value=1}
  %12: s32 = add %10, %11
  br ^bb1(%9, %8, %12)
^bb3(%13: s32):
  ret %13
}
`;

test('a swap-cycle back edge sequentializes through a temp (tempCounter)', () => {
  expect(emit(SWAP_CYCLE)).toBe(
    's32 swapcycle(s32 a0, s32 a1) {\n    s32 v0;\n    s32 v1;\n    s32 v2;\n    s32 t0;\n' +
      '    v0 = a0;\n    v1 = a1;\n    v2 = 0;\n    while (v2 < 10) {\n        v2 = v2 + 1;\n' +
      '        t0 = v0;\n        v0 = v1;\n        v1 = t0;\n    }\n    return v0;\n}\n',
  );
});

// The struct-arrays clean-golden shape (`p[i].a + p[i].b`, stride 8), through the pipeline's OWN
// shared spine (raiseRecovered → structureChecked) — the same stage order decompile() runs, so
// this pins the stride discriminator's emitted C, contracts and L3 passes included.
// struct-arrays-guards.test.ts only counts recognizer hits.
const STRUCT_ARRAY = `fn sget {
^bb0(%0: unk32, %1: s32):
  %2: s32 = const {value=8}
  %3: s32 = mul %1, %2
  %4: s32 = add %0, %3
  %5: s32 = load %4 {off=0, signed=true, width=4}
  %6: s32 = load %4 {off=4, signed=false, width=2}
  %7: s32 = add %5, %6
  ret %7
}
`;

test('array-of-struct recovery, as emitted C (the shared raise spine)', () => {
  const fn = parse(STRUCT_ARRAY);
  verify(fn);
  raiseRecovered(fn, ARMV4T_AGBCC);
  const sfn = structureChecked(fn, { ...structureOptionsFor(ARMV4T_AGBCC, false), onGap: 'strict' });
  expect(cBackend.emit(sfn)).toBe(
    'struct Elem0 { s32 field_0; u16 field_4; u8 _pad0[2]; };\n' +
      's32 sget(struct Elem0 * a0, s32 a1) {\n    return a0[a1].field_0 + a0[a1].field_4;\n}\n',
  );
});

// Pool-loaded global + THREE distinct constant offsets through the same aggregate base: the
// frontend recovers `gCfg` from the pool word, and L3 base-CSE hoists the reused base into a
// typed local pointer. Emitted-C golden — basecse.test.ts/globals.test.ts stop at AST/fragments.
const BASECSE_ASM = [
  '\tldr\tr2, .L1',
  '\tmov\tr0, #0x1',
  '\tstrb\tr0, [r2]',
  '\tmov\tr0, #0x2',
  '\tstrb\tr0, [r2, #0x1]',
  '\tmov\tr0, #0x3',
  '\tstrb\tr0, [r2, #0x2]',
  '\tbx\tlr',
  '.L1:',
  '\t.word\tgCfg',
].join('\n');

test('pool-global recovery + base-CSE hoist, as emitted C (full pipeline)', () => {
  // (`return 3` is r0 live at `bx lr` under the no-proto default — faithful to the asm; pass
  // returnsVoid to suppress. The golden pins the hoist: one typed local, offsets as p0[i].)
  expect(decompile('initcfg', `initcfg:\n${BASECSE_ASM}\n`, ARMV4T_AGBCC).source).toBe(
    's32 initcfg(void) {\n    u8 * p0;\n    p0 = (u8 *)&gCfg;\n    *p0 = 1;\n    p0[1] = 2;\n' +
      '    p0[2] = 3;\n    return 3;\n}\n',
  );
});
