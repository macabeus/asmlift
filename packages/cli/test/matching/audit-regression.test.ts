// Regression tests for silent-miscompile findings from the adversarial audits. Each pins a case
// where asmlift emitted confidently-WRONG C instead of loud-failing / declining — the exact class
// the loud-fail invariant exists to prevent. Native toolchains only (no Docker).
import { pascalBackend } from '@asmlift/core/backend/pascal';
import { T } from '@asmlift/core/ir/types';
import type { SFn, Stmt } from '@asmlift/core/l3/ast';
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC, MIPS_IDO } from '@asmlift/core/target';
import { assembleTarget, compileMipsTarget, compileTargetAsm, scoreC, scoreCMips } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { decompileWithReport } from '../../src/report';

describe('soundness regressions — short-circuit hoisting, stack-passed args, report parity', () => {
  // FINDING 1 (shortcircuit.ts): a side effect in a `&&`/`||` RHS arm must NOT be hoisted out of the
  // short-circuit — `a && (*p = x)` must only store when `a` is true. The fold is declined (correct
  // merge-variable spelling) rather than emitting an unconditional `*p = x;`.
  test('short-circuit with a store in the RHS arm keeps the store conditional', () => {
    const asm = compileTargetAsm('int scb(int a,int *p,int x){ return a && ((*p = x) != 0); }');
    const src = decompile('scb', asm, ARMV4T_AGBCC).source;
    // the store must be guarded (inside an if/else), never a bare top-level statement before the return
    const beforeReturn = src.slice(0, src.indexOf('return'));
    const storeIsGuarded = /else\s*\{[^}]*\*a1 = a2/.test(src) || /if\s*\([^)]*\)\s*\{[^}]*\*a1 = a2/.test(src);
    expect(src).toContain('*a1 = a2'); // the store is still present…
    expect(storeIsGuarded).toBe(true); // …but conditional, not hoisted
    // guard against the miscompile shape: an unconditional `*a1 = a2;` with a following `&&` return
    expect(/^\s*\*a1 = a2;/m.test(beforeReturn) && /&&/.test(src.slice(src.indexOf('return')))).toBe(false);
  });

  // a normal (pure) short-circuit must STILL fold — the purity guard is not over-broad.
  test('pure short-circuit still folds to &&', () => {
    const asm = compileTargetAsm('int land2(int a,int b){ return a && b; }');
    expect(decompile('land2', asm, ARMV4T_AGBCC).source).toContain('&&');
  });

  // FINDING 2 (frontend/mips.ts): a word `lw` from an sp slot that was never stored is an incoming
  // stack-passed argument (5th+ param) — asmlift must loud-fail, not fabricate a phantom parameter
  // that scrambles the signature and returns the wrong argument.
  test('MIPS load from an unstored stack slot (5th arg) loud-fails', () => {
    const { asm } = compileMipsTarget('int f5(int a,int b,int c,int d,int e){ return e; }', 'f5');
    expect(() => decompile('f5', asm, MIPS_IDO)).toThrow(/never stored|stack-passed|not modelled/);
  });

  // a 4-arg function (all register args) is unaffected.
  test('MIPS 4-arg function still lifts normally', () => {
    const { asm } = compileMipsTarget('int f4(int a,int b,int c,int d){ return a+b+c+d; }', 'f4');
    expect(decompile('f4', asm, MIPS_IDO).source).toContain('a3');
  });

  // FINDING 3 (report/report.ts): the report path must apply the same raise passes as decompile()
  // or its headline source drifts. Byte-identical output required (soft-div exercises a pass that
  // drifted once).
  test('M5 report source matches decompile() (soft-div parity)', () => {
    const asm = compileTargetAsm('int divv(int a,int b){ return a/b; }');
    const d = decompile('divv', asm, ARMV4T_AGBCC).source;
    const r = decompileWithReport('divv', asm, ARMV4T_AGBCC).source;
    expect(r).toBe(d);
    expect(r).toContain('a0 / a1'); // soft-div folded, not a raw __divsi3(...) call
  });
});

describe('M1 — Thumb sp-as-data loud-fails (the MIPS/PPC guard, ported)', () => {
  // An address-taken local (`&local`) makes agbcc read sp as DATA (`mov r0, sp` /
  // `str r0, [sp]` / `add rD, sp, #N`). sp is never written in SSA, so lifting it materializes a
  // fabricated PHANTOM parameter — wrong arity, garbage address, silent. Required: loud
  // FrontendUnsupportedError in strict; a stub diagnostic in annotate.
  test('address-taken local declines loud in strict mode', () => {
    const asm = compileTargetAsm('extern void g(int*); int atl(int a){ int local = a; g(&local); return local; }');
    expect(() => decompile('atl', asm, ARMV4T_AGBCC, { prototypes: { g: { params: 1, returnsVoid: true } } })).toThrow(
      /stack pointer used as data/,
    );
  });

  test('address-taken local stubs with a lift diagnostic in annotate mode', () => {
    const asm = compileTargetAsm('extern void g(int*); int atl(int a){ int local = a; g(&local); return local; }');
    const r = decompile('atl', asm, ARMV4T_AGBCC, {
      prototypes: { g: { params: 1, returnsVoid: true } },
      onGap: 'annotate',
    });
    expect(r.diagnostics.length).toBe(1);
    expect(r.diagnostics[0].stage).toBe('lift');
    expect(r.diagnostics[0].reason).toMatch(/stack pointer used as data/);
  });

  // the sp guard must not over-fire: a plain push/pop frame (no sp-as-data) stays liftable
  test('push/pop frame without sp-as-data still lifts', () => {
    const asm = compileTargetAsm('extern int h(int); int keep(int a, int b){ return h(a) + b; }');
    const src = decompile('keep', asm, ARMV4T_AGBCC, { prototypes: { h: { params: 1 } } }).source;
    expect(src).toContain('h(a0)');
  });
});

describe('M2/M3/M8 — detection gaps stay closed', () => {
  // M2: MIPS 2-source `nor rd, rs, rt` must model ~(rs | rt) — a bare OR is confidently wrong.
  // The round-trip is byte-exact.
  test('M2: MIPS 2-source nor lifts as ~(a|b), byte-exact', () => {
    const { obj, asm } = compileMipsTarget('int nor2(int a, int b){ return ~(a | b); }', 'nor2');
    const src = decompile('nor2', asm, MIPS_IDO).source;
    expect(src).toContain('~(a0 | a1)');
    expect(scoreCMips(src, 'nor2', obj).score).toBe(0);
  });

  // M3: the Pascal backend must fail loud on a bare early `return;` (non-tail) — dropping it lets
  // control continue. Tail returns keep the assignment idiom.
  test('M3: Pascal non-tail return fails loud; tail return still spells', () => {
    const mkFn = (body: Stmt[]): SFn => ({
      name: 'p',
      params: [{ name: 'a0', type: T.int(32, true) }],
      locals: [],
      retType: T.int(32, true),
      body,
    });
    const ret = (v?: number): Stmt =>
      v === undefined ? { k: 'return' } : { k: 'return', value: { k: 'const', value: v } };
    // early bare return inside an if with code after → loud
    expect(() =>
      pascalBackend.emit(mkFn([{ k: 'if', cond: { k: 'var', name: 'a0' }, then: [ret()], else: [] }, ret(1)])),
    ).toThrow(/early `return`/);
    // divergent-if returns in tail position stay faithful
    const ok = pascalBackend.emit(mkFn([{ k: 'if', cond: { k: 'var', name: 'a0' }, then: [ret(1)], else: [ret(2)] }]));
    expect(ok).toContain('p := 1;');
    expect(ok).toContain('p := 2;');
  });

  // M8 (re-aimed when stmia became modelled, F7): the original hazard was an unmodelled
  // store-class instruction silently DELETING its writes. stmia now lifts to explicit stores +
  // writeback — the pin asserts the stores exist in the emission (never a store-free loop) and
  // the shape scores against the real object rather than declining.
  test('M8: modelled stmia emits its stores (never a store-free loop) and scores', () => {
    const { obj, asm } = (() => {
      const a = compileTargetAsm(
        'int fill(int *p, int n, int v){ while (n != 0) { *p = v; p = p + 1; n = n - 1; } return n; }',
      );
      return { obj: assembleTarget(a), asm: a };
    })();
    expect(asm).toContain('stmia'); // the shape really lowers to stmia
    const src = decompile('fill', asm, ARMV4T_AGBCC).source;
    expect(src).toMatch(/\*\w+ = |\w+\[\w*\] = /); // the store is in the artifact
    const s = scoreC(src, 'fill', obj);
    expect(typeof s.score).toBe('number'); // compiles and scores (exactness is the benchmark's row)
  });
});

describe('report path parity with decompile()', () => {
  // The report must share decompile()'s pattern defaults (DEFAULT_IDIOM_PATTERNS): defaulting to
  // [] diverges its headline source on any pattern-folded function while its embedded
  // decompileRanked uses the full set. Source must be byte-identical.
  test('pattern-dependent function: report source === decompile source', () => {
    for (const c of [
      'int p2(int a){ return a / 2; }', // sdiv-pow2/2 pattern
      'int mm(int a){ return a * 10; }', // mul-shift pattern family
      'unsigned char nb(int a){ return (unsigned char)a; }', // cast pattern family
    ]) {
      const asm = compileTargetAsm(c);
      const sym = c.match(/(\w+)\(int a\)/)![1];
      expect(decompileWithReport(sym, asm, ARMV4T_AGBCC).source).toBe(decompile(sym, asm, ARMV4T_AGBCC).source);
    }
  });

  test('annotate mode: a NON-localizable failure stubs identically on both paths', () => {
    // The sp-as-data decline is a frontend THROW (no line to mark). decompile() degrades to a
    // stub; the report path must not accept onGap yet re-throw on the same input.
    const asm = compileTargetAsm('extern void g(int*); int atl2(int a){ int local = a; g(&local); return local; }');
    const protos = { prototypes: { g: { params: 1, returnsVoid: true } } as const, onGap: 'annotate' as const };
    const viaPipeline = decompile('atl2', asm, ARMV4T_AGBCC, protos);
    expect(viaPipeline.source).toContain('could not decompile'); // really the stub path
    const viaReport = decompileWithReport('atl2', asm, ARMV4T_AGBCC, protos);
    expect(viaReport.source).toBe(viaPipeline.source);
    expect(viaReport.report.outcome).toBe('unscored');
  });

  test('annotate mode: report threads onGap exactly like decompile', () => {
    // a live unmodelled op (non-#0 rsb → loud opaque) → marker in annotate mode on BOTH paths
    const asm0 = compileTargetAsm('int rsb(int a){ return 4 - a; }');
    const asm = asm0.replace(/sub\tr0, r0, r1/, 'rsb\tr0, r1, #0x4');
    expect(asm).not.toBe(asm0); // the hostile edit really applied
    const viaPipeline = decompile('rsb', asm, ARMV4T_AGBCC, { onGap: 'annotate' });
    expect(viaPipeline.source).toContain('ASMLIFT_ERROR'); // and really produced a marker
    const viaReport = decompileWithReport('rsb', asm, ARMV4T_AGBCC, { onGap: 'annotate' });
    expect(viaReport.source).toBe(viaPipeline.source);
  });
});
