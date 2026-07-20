// The structurer's SSA-destruction soundness pins (C2–C7 + M7): shapes where structure() could
// emit confidently-WRONG, contract-clean, compilable C (or OOM). SSA destruction requires two
// models — value liveness (coalescing interference, C3) and effect ordering (inline-at-use
// barriers/materialization, C2/C4) — plus pre-update-read guards on both loop emitters (C5),
// full-Expr read-set walkers (C6), switch-edge phi copies (C7), and a terminating, declared
// swap-cycle spill (M7). Where correct code cannot be emitted it DECLINES loud (StructureError) —
// never silent wrong code.
//
// IR-level shapes use parse()/mkOp (compilers optimize some of these away); the C2/C4 shapes
// are END-TO-END: real C → agbcc → decompile(), scored with real objdiff where byte-exactness
// is expected.
import { cBackend } from '@asmlift/core/backend/c';
import { type Block, type Fn, mkOp, mkValue } from '@asmlift/core/ir/core';
import { parse } from '@asmlift/core/ir/parse';
import { T } from '@asmlift/core/ir/types';
import { decompile } from '@asmlift/core/pipeline';
import { StructureError, structure } from '@asmlift/core/structure/structure';
import { ARMV4T_AGBCC } from '@asmlift/core/target';
import { assembleTarget, compileTargetAsm, scoreC } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

const emit = (text: string) => cBackend.emit(structure(parse(text)));

describe("C2 — self-loop guard-fusion keeps the body's side effects", () => {
  // A guarded single-block store loop (memset shape, `str r2,[r0]; add; sub; cmp; bne`):
  // a copies-only loop body silently DELETES the store.
  test('store survives inside the recovered loop body (end-to-end, real asm)', () => {
    const c = 'int fill2(int *p, int n, int v){ while (n != 0) { *p = v; p = p + 2; n = n - 1; } return n; }';
    const asm = compileTargetAsm(c);
    expect(asm).toContain('str'); // the shape really has a plain store
    const src = decompile('fill2', asm, ARMV4T_AGBCC).source;
    const loopBody = src.slice(src.search(/for \(|while \(/));
    expect(loopBody).toContain('*v0 = a2;'); // the memory write is IN the loop
    // and the output still compiles + scores (correctness of the harness path)
    expect(scoreC(src, 'fill2', assembleTarget(asm)).rows).toBeGreaterThan(0);
  });
});

describe('C3 — coalescing has an interference (liveness) check', () => {
  // Failure A: the merge param must NOT coalesce onto the still-live entry param a0.
  // Ground truth: return (a1 ? 5 : a0) + a0 — the broken coalesce `if (a1) a0 = 5; return a0+a0`
  // returns 10 where 5+a0 is correct.
  test('merge param does not steal a still-live variable', () => {
    const src = emit(`fn c3a {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=5}
  cond_br %1, ^bb1(%2), ^bb1(%0)
^bb1(%3: s32):
  %4: s32 = add %3, %0
  ret %4
}
`);
    expect(src).toContain('v0 = 5;');
    expect(src).toContain('v0 = a0;');
    expect(src).toContain('return v0 + a0;');
    expect(src).not.toContain('a0 + a0');
  });

  // Failure B: two params of ONE block, where one edge passes the same value to both — they
  // must not share a name (broken: `a0 = 7; a0 = 9; return a0 + a0` = 18, truth 16).
  test('sibling params of one block never share a name', () => {
    const src = emit(`fn c3b {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=7}
  %3: s32 = const {value=9}
  cond_br %1, ^bb1(%0, %0), ^bb1(%2, %3)
^bb1(%4: s32, %5: s32):
  %6: s32 = add %4, %5
  ret %6
}
`);
    expect(src).toContain('a0 = 7;');
    expect(src).toContain('v0 = 9;');
    expect(src).toContain('return a0 + v0;');
  });
});

describe('C4 — inline-at-use has multi-use and memory-ordering barriers', () => {
  test('a call used twice executes ONCE (named temp), byte-exact (end-to-end)', () => {
    const c = 'extern int g(int); int t(int a){ int r = g(a); return r ^ (r >> 1); }';
    const asm = compileTargetAsm(c);
    const src = decompile('t', asm, ARMV4T_AGBCC, { prototypes: { g: { params: 1 } } }).source;
    expect(src.match(/g\(/g)!.length).toBe(1); // miscompile shape: g(a0) ^ (g(a0) >> 1)
    expect(scoreC(src, 't', assembleTarget(asm)).score).toBe(0);
  });

  test('a load never sinks past an aliasing store, byte-exact (end-to-end)', () => {
    const c = 'int xchg0(int *p){ int v = *p; *p = 0; return v; }';
    const asm = compileTargetAsm(c);
    const src = decompile('xchg0', asm, ARMV4T_AGBCC).source;
    // the read must be materialized BEFORE the store (miscompile shape: `*a0 = 0; return *a0;`)
    expect(src.indexOf('v0 = *a0;')).toBeGreaterThanOrEqual(0);
    expect(src.indexOf('v0 = *a0;')).toBeLessThan(src.indexOf('*a0 = 0;'));
    expect(src).toContain('return v0;');
    expect(scoreC(src, 'xchg0', assembleTarget(asm)).score).toBe(0);
  });

  test('a store to a provably-disjoint field is NOT a barrier (no spurious temp)', () => {
    // same-base, non-overlapping offsets: load field_0 may still inline past store field_4
    const src = emit(`fn disj {
^bb0(%0: unk32, %1: s32):
  %2: s32 = load %0 {off=0, signed=true, width=4}
  store %0, %1 {off=4, width=4}
  ret %2
}
`);
    expect(src).toContain('return');
    expect(src).not.toContain('v0 ='); // still inlined, no materialization
  });
});

describe('C5 — loop conditions/exits never read a pre-update value under its post-update name', () => {
  // the `i++ < n` do-while: the latch test reads the PRE-increment i. Rendering it under the
  // post-update name is one iteration off. Must DECLINE loud.
  const hazard = `fn c5 {
^bb0(%0: s32*, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  store %0, %3 {off=0, width=4}
  br ^bb2()
^bb2():
  %4: s32 = add %3 {imm=1}
  %5: u32 = icmp_slt %3, %1
  cond_br %5, ^bb1(%4), ^bb3()
^bb3():
  %6: s32 = const {value=0}
  ret %6
}
`;
  test('pre-update read in a do-while condition declines loud', () => {
    expect(() => structure(parse(hazard))).toThrow(StructureError);
    expect(() => structure(parse(hazard))).toThrow(/pre-update/);
  });

  test('post-update read (the sound spelling) still structures as do-while', () => {
    const src = emit(hazard.replace('icmp_slt %3, %1', 'icmp_slt %4, %1').replace('fn c5', 'fn c5ok'));
    expect(src).toContain('do {');
    expect(src).toContain('*a0 = v0;');
    expect(src).toContain('} while (v0 < a1);');
  });
});

describe('C6 — parallel-copy read-set walkers cover the full Expr union', () => {
  // latch copy {v ← a[k], k ← k+1}: if the index read of k is invisible to exprVars, the
  // increment can sequentialize FIRST and the load reads the post-update index.
  test("a copy keyed by another carried var orders before that var's update", () => {
    const src = emit(`fn c6 {
^bb0(%0: s32*, %1: s32, %2: s32):
  %3: s32 = const {value=0}
  cond_br %2, ^bb1(%3, %3), ^bb2()
^bb1(%5: s32, %6: s32):
  %7: s32 = add %6 {imm=1}
  %8: s32 = aload %0, %6 {elemSize=4, signed=true}
  %9: u32 = icmp_slt %7, %1
  cond_br %9, ^bb1(%8, %7), ^bb2()
^bb2():
  ret %5
}
`);
    // The correct sequentialization (read-then-increment) is what lets recognizeForLoops lift
    // the increment into the for-header (it must be the body's LAST statement): the body reads
    // a0[v1] at the PRE-update index. Broken walkers emit `v1 = v1 + 1; v0 = a0[v1];`,
    // which reads the post-update index (and can never become this for-shape).
    expect(src).toMatch(/for \(v1 = 0; v1 < a1; v1 = v1 \+ 1\) \{\s*\n\s*v0 = a0\[v1\];\s*\n\s*\}/);
  });
});

describe('C7 — switch_br edges carry their phi copies', () => {
  const mkSwitchFn = (sharedArgsDiffer: boolean): Fn => {
    const p0 = mkValue(T.int(32, true)),
      p1 = mkValue(T.int(32, true));
    const sum = mkValue(T.int(32, true)),
      sum2 = mkValue(T.int(32, true));
    const k10 = mkValue(T.int(32, true)),
      k0 = mkValue(T.int(32, true)),
      c4 = mkValue(T.int(32, true));
    const b1: Block = {
      params: [],
      ops: [mkOp('const', { results: [k10], attrs: { value: 10 } }), mkOp('ret', { operands: [k10] })],
    };
    const b2: Block = { params: [c4], ops: [mkOp('ret', { operands: [c4] })] };
    const b3: Block = {
      params: [],
      ops: [mkOp('const', { results: [k0], attrs: { value: 0 } }), mkOp('ret', { operands: [k0] })],
    };
    const entry: Block = {
      params: [p0, p1],
      ops: [
        mkOp('add', { results: [sum], operands: [p1, p1] }),
        mkOp('sub', { results: [sum2], operands: [p1, p0] }),
        mkOp('switch_br', {
          operands: [p0],
          attrs: { cases: [0, 1] },
          successors: sharedArgsDiffer
            ? [
                { block: b2, args: [sum] },
                { block: b2, args: [sum2] },
                { block: b3, args: [] },
              ]
            : [
                { block: b1, args: [] },
                { block: b2, args: [sum] },
                { block: b3, args: [] },
              ],
        }),
      ],
    };
    return { name: 'c7', blocks: [entry, b1, b2, b3] };
  };

  test("a case edge's phi arg is assigned at the top of the case body", () => {
    const src = cBackend.emit(structure(mkSwitchFn(false)));
    // miscompile shape: `case 1: return v0;` with v0 never assigned on the switch path
    expect(src).toMatch(/case 1:\s*\n\s*v0 = a1 \+ a1;\s*\n\s*return v0;/);
  });

  test('two case values sharing a target with DIFFERING args decline loud', () => {
    expect(() => structure(mkSwitchFn(true))).toThrow(/differing phi args/);
  });
});

describe('F1/F2 — write-site interference + materialization gate', () => {
  // F1a: a merge param that adopts the loop variable's name gets clobbered by the latch update
  // (`v0 = *a1`, emitted inside the do-while body) on the exiting iteration too. canTakeName
  // rejects a name that is WRITTEN anywhere the adopting param is live.
  test('merge param never adopts a name the loop update writes while it is live', () => {
    const src = emit(`fn takename {
^bb0(%0: s32, %1: unk32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb2(), ^bb3()
^bb2():
  br ^bb4(%3)
^bb3():
  %5: s32 = const {value=42}
  br ^bb4(%5)
^bb4(%6: s32):
  %7: s32 = load %1 {off=0, signed=true, width=4}
  %8: u32 = icmp_ne %7, %0
  cond_br %8, ^bb1(%7), ^bb5()
^bb5():
  ret %6
}
`);
    // the saved value must live in its OWN variable, distinct from the updated loop var
    expect(src).toContain('v1 = 42;');
    expect(src).toContain('return v1;');
    expect(src).not.toMatch(/return v0;\s*\}\s*$/);
  });

  // F1b: an over-broad pureAlias waiver lets a redundant phi of the pre-increment `i` share i's
  // name; the increment then rewrites it before the post-loop read (returning post-increment).
  // The waiver covers only the value-at-entry check, never a written name.
  test('a redundant-phi alias of a loop var still gets its own variable when the var is updated', () => {
    const src = emit(`fn palias {
^bb0(%0: s32, %1: s32):
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: u32 = icmp_slt %3, %0
  cond_br %4, ^bb2(), ^bb3()
^bb2():
  br ^bb4(%3)
^bb3():
  br ^bb4(%3)
^bb4(%5: s32):
  %6: s32 = add %3 {imm=1}
  %7: u32 = icmp_slt %6, %1
  cond_br %7, ^bb1(%6), ^bb5()
^bb5():
  ret %5
}
`);
    expect(src).toContain('v1 = v0;'); // the pre-increment value is SAVED
    expect(src).toContain('return v1;'); // and returned — not the post-increment v0
  });

  // F2: a guard-fused self-loop whose header holds a MATERIALIZED load (barred by the aliasing
  // store) would render the temp in the while condition before the body ever assigned it.
  test('guard-fusion declines when the header holds a materialized def', () => {
    expect(() =>
      structure(
        parse(`fn selfmat {
^bb0(%0: unk32, %1: s32):
  cond_br %1, ^bb1(%1), ^bb2()
^bb1(%2: s32):
  %3: s32 = load %0 {off=0, signed=true, width=4}
  store %0, %2 {off=0, width=4}
  %4: s32 = add %2 {imm=-1}
  %5: u32 = icmp_ne %3, %4
  cond_br %5, ^bb1(%4), ^bb2()
^bb2():
  %6: s32 = const {value=0}
  ret %6
}
`),
      ),
    ).toThrow(/materialized def/);
  });
});

describe('M7 — swap cycles terminate, spill through a declared temp', () => {
  test('a two-variable swap loop emits t0 = v0; v0 = v1; v1 = t0 and terminates', () => {
    // hazard: unbounded fresh temps → RangeError: Out of memory
    const src = emit(`fn m7 {
^bb0(%0: s32, %1: s32, %2: s32):
  cond_br %2, ^bb1(%0, %1, %2), ^bb2()
^bb1(%3: s32, %4: s32, %5: s32):
  %6: s32 = add %5 {imm=-1}
  %7: s32 = const {value=0}
  %8: u32 = icmp_ne %6, %7
  cond_br %8, ^bb1(%4, %3, %6), ^bb2()
^bb2():
  ret %3
}
`);
    expect(src).toContain('s32 t0;'); // the spill temp is DECLARED
    expect(src).toMatch(/t0 = v0;\s*\n\s*v0 = v1;\s*\n\s*v1 = t0;/);
  });
});
