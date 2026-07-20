// P1 — Regime A comparison-tree switch recovery (Regime A).
// Match tests: the nested-if → `switch` upgrade recompiles byte-exact. Decline tests: the recognizer's
// four preconditions hold — an ambiguous shape falls back to nested-if (a clean nonmatch, NEVER a wrong
// switch). Native/offline only (agbcc + IDO; no Docker).
import { pascalBackend } from '@asmlift/core/backend/pascal';
import { T } from '@asmlift/core/ir/types';
import type { SFn } from '@asmlift/core/l3/ast';
import { decompile } from '@asmlift/core/pipeline';
import { ARMV4T_AGBCC, MIPS_IDO } from '@asmlift/core/target';
import { assembleTarget, compileMipsTarget, compileTargetAsm, scoreC, scoreCMips } from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

const SW = {
  sw_ret:
    'int sw_ret(int x){ switch(x){case 0:return 10;case 1:return 20;case 2:return 30;case 3:return 40;default:return -1;} }',
  sw_op:
    'int sw_op(int op,int a,int b){ switch(op){case 0:return a+b;case 1:return a-b;case 2:return a*b;case 3:return a&b;default:return 0;} }',
  sw_sparse:
    'int sw_sparse(int x){ switch(x){case 1:return 1;case 10:return 2;case 100:return 3;case 1000:return 4;default:return 0;} }',
  sw_void: 'void sw_void(int x,int *p){ switch(x){case 0:*p=1;break;case 1:*p=2;break;default:*p=0;} }',
} as const;
const voidOpts = { prototypes: { sw_void: { params: 2, returnsVoid: true } } };

describe('P1 match — a recovered `switch` recompiles byte-exact', () => {
  for (const [sym, c] of Object.entries(SW)) {
    const opts = sym === 'sw_void' ? voidOpts : {};
    test(`${sym} — ARM (agbcc) scores 0 and emits a switch`, () => {
      const obj = assembleTarget(compileTargetAsm(c));
      const src = decompile(sym, compileTargetAsm(c), ARMV4T_AGBCC, opts).source;
      expect(src).toContain('switch (');
      expect(scoreC(src, sym, obj).score).toBe(0);
    });
    test(`${sym} — MIPS (IDO) scores 0 and emits a switch`, () => {
      const { asm, obj } = compileMipsTarget(c, sym);
      const src = decompile(sym, asm, MIPS_IDO, opts).source;
      expect(src).toContain('switch (');
      expect(scoreCMips(src, sym, obj).score).toBe(0);
    });
  }
});

describe('P1 decline — ambiguous shapes fall back to nested-if (sound, never a wrong switch)', () => {
  // PRE2: a fall-through switch (sw_fall) is NOT handled in P1 — it must decline, not emit a switch that
  // silently repoints the fall-through. Declines to behaviourally-identical nested-if (a clean nonmatch).
  test('sw_fall (fall-through) declines — no switch emitted', () => {
    const c = 'int sw_fall(int x){ int r=0; switch(x){case 3:r++;case 2:r++;case 1:r++;} return r; }';
    const { asm } = compileMipsTarget(c, 'sw_fall');
    const src = decompile('sw_fall', asm, MIPS_IDO).source;
    expect(src).not.toContain('switch ('); // declined
  });

  // A comparison whose non-scrutinee side is NOT a constant (`a == b`) is not a switch test — the
  // recognizer declines at the root and the chain stays nested-if.
  test('an if-chain testing a==b (non-constant) stays nested-if', () => {
    const c = 'int f(int a,int b){ if(a==b) return 1; if(a==0) return 2; return 3; }';
    const { asm } = compileMipsTarget(c, 'f');
    const src = decompile('f', asm, MIPS_IDO).source;
    expect(src).not.toContain('switch (');
  });

  // A single comparison (one case) is below the ≥2-case floor — stays an `if`.
  test('a single equality test stays an if (below the 2-case floor)', () => {
    const c = 'int f(int x){ if(x==5) return 1; return 0; }';
    const { asm } = compileMipsTarget(c, 'f');
    const src = decompile('f', asm, MIPS_IDO).source;
    expect(src).not.toContain('switch (');
  });

  // SOUNDNESS: a `case k` that is DEAD under a relational guard
  // (`if(x<5){ if(x==20) … }` — x==20 unreachable) must NOT be resurrected as a live case. The per-case
  // tree simulation (PRE3) declines. Constructed via IR because compilers optimize the dead branch away.
  test('a dead equality under a relational guard declines (no resurrected case)', async () => {
    const { structure } = await import('@asmlift/core/structure/structure');
    const { emitCFamily } = await import('@asmlift/core/backend/cfamily');
    const { mkOp, mkValue } = await import('@asmlift/core/ir/core');
    const b7: any = { params: [], ops: [] },
      c7: any = { params: [], ops: [] },
      t5: any = { params: [], ops: [] };
    const t20: any = { params: [], ops: [] },
      c20: any = { params: [], ops: [] },
      d99: any = { params: [], ops: [] };
    const x = mkValue(T.int(32, true));
    b7.params = [x];
    const cst = (blk: any, v: number) => {
      const c = mkValue(T.int(32, true));
      blk.ops.push(mkOp('const', { results: [c], attrs: { value: v } }));
      return c;
    };
    const test2 = (blk: any, opc: Parameters<typeof mkOp>[0], k: number, t: any, f: any) => {
      const cc = mkValue(T.int(32, true));
      blk.ops.push(mkOp(opc, { operands: [x, cst(blk, k)], results: [cc] }));
      blk.ops.push(
        mkOp('cond_br', {
          operands: [cc],
          successors: [
            { block: t, args: [] },
            { block: f, args: [] },
          ],
        }),
      );
    };
    test2(b7, 'icmp_eq', 7, c7, t5);
    c7.ops.push(mkOp('ret', { operands: [cst(c7, 7)] }));
    test2(t5, 'icmp_slt', 5, t20, d99);
    test2(t20, 'icmp_eq', 20, c20, d99);
    c20.ops.push(mkOp('ret', { operands: [cst(c20, 1)] }));
    d99.ops.push(mkOp('ret', { operands: [cst(d99, 99)] }));
    const sfn = structure({ name: 'f', blocks: [b7, c7, t5, t20, c20, d99] } as any);
    const src = emitCFamily('s32 f(s32 a0)', sfn);
    expect(src).not.toContain('switch ('); // declined — dead case not resurrected
    expect(src).not.toContain('case 20');
  });

  // MATCH PRESERVATION: IDO switch dispatch uses `==`/`<`, never `!=` cases; a
  // `!=`-rooted nested-if on IDO must STAY nested-if (switchAllowsNeqCase:false) or it regresses a match.
  test('IDO: a != rooted if-else chain stays nested-if (no mis-recognized switch)', () => {
    const c =
      'int g1(int x){ if(x!=0){ if(x!=1){ if(x==2) return 30; else return 40; } else return 20; } else return 10; }';
    const { asm } = compileMipsTarget(c, 'g1');
    const src = decompile('g1', asm, MIPS_IDO).source;
    expect(src).not.toContain('switch (');
  });
});

describe('P1 backends — Pascal case-of, and the fall-through loud-fail', () => {
  // A non-fall-through switch with assign bodies lowers to Pascal `case … of … otherwise`.
  test('Pascal emits case-of for a non-fall-through switch', () => {
    const fn: SFn = {
      name: 'f',
      params: [{ name: 'a0', type: T.int(32, true) }],
      locals: [{ name: 'r', type: T.int(32, true) }],
      retType: T.int(32, true),
      body: [
        {
          k: 'switch',
          scrutinee: { k: 'var', name: 'a0' },
          cases: [
            { values: [0], body: [{ k: 'assign', name: 'r', value: { k: 'const', value: 1 } }], fallsThrough: false },
            { values: [1], body: [{ k: 'assign', name: 'r', value: { k: 'const', value: 2 } }], fallsThrough: false },
          ],
          default: [{ k: 'assign', name: 'r', value: { k: 'const', value: 0 } }],
        },
      ],
    };
    const out = pascalBackend.emit(fn);
    expect(out).toContain('case a0 of');
    expect(out).toContain('otherwise');
  });

  // A `return` inside a case has no faithful IDO Pascal spelling (no early return → `fnName := v` would
  // fall through the case-of into post-switch code) → loud-fail, not a silent miscompile.
  test('Pascal loud-fails a return inside a switch case', () => {
    const fn: SFn = {
      name: 'f',
      params: [{ name: 'a0', type: T.int(32, true) }],
      locals: [],
      retType: T.int(32, true),
      body: [
        {
          k: 'switch',
          scrutinee: { k: 'var', name: 'a0' },
          cases: [{ values: [0], body: [{ k: 'return', value: { k: 'const', value: 1 } }], fallsThrough: false }],
          default: [{ k: 'return', value: { k: 'const', value: 0 } }],
        },
      ],
    };
    expect(() => pascalBackend.emit(fn)).toThrow(/return.*Pascal|no early return/);
  });

  // A fall-through case has no faithful IDO Pascal case-of spelling → loud-fail (honest, not silent).
  test('Pascal loud-fails a fall-through switch', () => {
    const fn: SFn = {
      name: 'f',
      params: [{ name: 'a0', type: T.int(32, true) }],
      locals: [],
      retType: T.int(32, true),
      body: [
        {
          k: 'switch',
          scrutinee: { k: 'var', name: 'a0' },
          cases: [
            { values: [3], body: [{ k: 'assign', name: 'r', value: { k: 'const', value: 1 } }], fallsThrough: true },
          ],
        },
      ],
    };
    expect(() => pascalBackend.emit(fn)).toThrow(/fall-through/);
  });
});
