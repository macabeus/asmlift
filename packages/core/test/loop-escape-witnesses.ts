// Frozen IR witnesses shared by two suites — not a `.test.ts`, so vitest never collects it, and
// importing it runs no test (a test file imported by another re-registers its own tests there).
//
// `namecoalesce.test.ts` holds them against the `/merge-names` axis's `loop-escape` gate;
// `nested-carrier.test.ts` against `structure.ts`'s `carriedByBothLoops`, which refuses the same
// collision when the naming walk's nested-carrier rule, not the coalescing pass, would make it.
//
// ── the two witnesses no differential sweep can re-find ────────────────────────────────────────
//
// `namecoalesce-fuzz`'s ablating arm only drops gates the table calls `sound`, and `loop-escape` is
// not one, so no seed count over there reaches it. To re-hunt: ablate it by name at depth 2
// (`generateSsaFn(seed, 2)`, `without(…, 'loop-escape')`) — these are the only two witnesses in
// 1..7000.
//
// FROZEN AS IR, not replayed by seed, because a seed is a live coupling to a shared PRNG generator:
// any edit to `generateSsaFn` desynchronises the stream and the test then goes red reading as an
// inert gate. Frozen, it runs in milliseconds instead of structuring 5,104 functions to reach the
// first witness.
//
// THE SHAPE, in both: an inner loop's variable adopts the ENCLOSING loop's carrier, and then
// overwrites it every iteration. The gate's work is one statement — the copy that gives the
// escaping value a home of its own, at the top of the outer body. Dropped, that copy is gone, the
// inner loop writes the carrier, and the function returns another number. NOTHING THROWS: that is
// what separates this from the `TRAILING_DOWHILE` shape, where the loop emitter's own `pre-update
// loop variable` check catches the merge loudly.
export const INNER_CLOBBERS_OUTER = [
  {
    seed: 5104,
    escapeCopy: 'v4 = v2;',
    ir: `fn fz5104 {
^bb0(%0: s32, %1: s32):
  %2: s32 = sub %1, %1
  %3: s32 = sub %1, %1
  %4: s32 = sub %0, %1
  %5: s32 = call %1 {target="f1"}
  br ^bb1(%2, %1)
^bb1(%6: s32, %7: s32):
  %8: s32 = sub %1, %0
  br ^bb2(%6, %3)
^bb2(%9: s32, %10: s32):
  %11: s32 = sub %0, %0
  br ^bb3(%3)
^bb3(%12: s32):
  %13: s32 = sub %1, %12
  %14: s32 = call %12 {target="f1"}
  %15: s32 = call %0 {target="f2"}
  %16: u32 = icmp_slt %3, %12
  cond_br %16, ^bb2(%2, %15), ^bb4(%14)
^bb4(%17: s32):
  %18: s32 = add %1, %3
  %19: s32 = add %2, %17
  %20: u32 = icmp_slt %17, %0
  cond_br %20, ^bb1(%0, %2), ^bb5()
^bb5():
  %21: s32 = call %0 {target="f0"}
  %22: s32 = sub %0, %3
  br ^bb6(%1, %2)
^bb6(%23: s32, %24: s32):
  %25: s32 = sub %23, %24
  %26: s32 = sub %2, %3
  ret %0
}
`,
  },
  {
    seed: 6437,
    escapeCopy: 'v5 = v4;',
    ir: `fn fz6437 {
^bb0(%0: s32, %1: s32):
  %2: s32 = sub %1, %0
  %3: s32 = call %0 {target="f1"}
  %4: s32 = sub %0, %1
  %5: s32 = call %0 {target="f1"}
  br ^bb1(%1, %1)
^bb1(%6: s32, %7: s32):
  %8: s32 = call %0 {target="f0"}
  %9: s32 = add %2, %6
  br ^bb2(%7, %3)
^bb2(%10: s32, %11: s32):
  %12: s32 = sub %11, %1
  br ^bb3(%1)
^bb3(%13: s32):
  %14: s32 = sub %2, %2
  %15: s32 = sub %13, %1
  %16: s32 = call %15 {target="f2"}
  %17: u32 = icmp_slt %15, %15
  cond_br %17, ^bb2(%2, %15), ^bb4(%16)
^bb4(%18: s32):
  %19: s32 = sub %0, %2
  %20: u32 = icmp_slt %2, %1
  cond_br %20, ^bb1(%3, %3), ^bb5(%3, %2)
^bb5(%21: s32, %22: s32):
  %23: s32 = call %22 {target="f0"}
  %24: s32 = call %2 {target="f1"}
  br ^bb6(%23, %22)
^bb6(%25: s32, %26: s32):
  %27: s32 = add %0, %26
  ret %3
}
`,
  },
] as const;
