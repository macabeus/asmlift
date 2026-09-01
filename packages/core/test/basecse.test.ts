import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { frontendFor } from '../src/frontend/registry';
import { parse } from '../src/ir/parse';
import { T } from '../src/ir/types';
import type { Expr, SFn, Stmt } from '../src/l3/ast';
import {
  BASECSE_GATES,
  BASEFOLD_GATES,
  LIVEBASE_BLOCK_GATES,
  LIVEBASE_GATES,
  UNFOLDED_GATES,
  admittedBases,
  hoistBaseLocals,
} from '../src/l3/basecse';
import { without } from '../src/l3/gates';
import { volatilePtrLocals } from '../src/l3/volatileptr';
import { structureChecked } from '../src/pipeline';
import { enumerateCandidates } from '../src/rank';
import type { SymbolInfo } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

// `fromOperand` marks the access whose offset reached the MEMORY OPERAND — the DISPLACEMENT the
// structurer records as `index.operandOff`, which `BaseKey.unfoldedOffset` reads the presence of
// and `l3/offmember.ts` reads the value of (see the describe block below it and l3/ast.ts).
const fromOperand = { operandOff: 3 } as const;
const idx = (name: string, i: Expr, width = 1, evidence: object = {}): Expr => ({
  k: 'index',
  base: { k: 'addr', name },
  idx: i,
  width,
  signed: false,
  ...evidence,
});
const cidx = (value: number, i: Expr, width = 4, evidence: object = {}): Expr => ({
  k: 'index',
  base: { k: 'const', value },
  idx: i,
  width,
  signed: true,
  ...evidence,
});
const c = (value: number): Expr => ({ k: 'const', value });
const fn = (body: Stmt[]): SFn => ({ name: 'f', params: [], locals: [], retType: T.void(), body });

// The L2→L3 fact the fold evidence rests on. agbcc spells a constant SUBSCRIPT off a symbol by
// folding it into the relocation (`((u8 *)&gSym)[3]` → `.word gSym+0x3` + `ldrb [r0]`) and leaves a
// MEMBER or a named base's offset in the instruction (`gSym.d`, `u8 *p = …; p[3]` → `.word gSym` +
// `ldrb [r0, #0x3]`) — so which side of that pair the asm sits on is what says which C could have
// written it. Both sides denote the same cell and print the same subscript, which is why the
// discriminator has to be CARRIED rather than re-derived from the tree.
describe('where a constant offset came from survives the lift', () => {
  const lifted = (ir: string): SFn => structureChecked(parse(ir), {});
  const firstIndex = (sfn: SFn): Extract<Expr, { k: 'index' }> => {
    const st = sfn.body[0];
    expect(st.k).toBe('return');
    const v = st.k === 'return' ? st.value : undefined;
    expect(v?.k).toBe('index');
    return v as Extract<Expr, { k: 'index' }>;
  };
  // `.word gSym` + `ldrb r0, [r0, #0x3]`
  const OPERAND = `fn f {
^bb0():
  %0: u8* = gaddr {sym="gSym"}
  %1: s32 = load %0 {off=3, signed=false, width=1}
  ret %1
}
`;
  // `.word gSym+0x3` + `ldrb r0, [r0]` — the relocation's addend, which the frontend keeps as an
  // explicit add rather than as an operand offset
  const ADDEND = `fn f {
^bb0():
  %0: u8* = gaddr {sym="gSym"}
  %1: s32 = const {value=3}
  %2: u8* = add %0, %1
  %3: s32 = load %2 {off=0, signed=false, width=1}
  ret %3
}
`;

  test('the two lift to the same C, down to the byte', () => {
    expect(cBackend.emit(lifted(ADDEND))).toEqual(cBackend.emit(lifted(OPERAND)));
    expect(cBackend.emit(lifted(OPERAND))).toContain('((u8 *)&gSym)[3]');
  });

  test('and are told apart by `operandOff`, which nothing else about the node records', () => {
    expect(firstIndex(lifted(OPERAND)).operandOff).toBe(3);
    expect(firstIndex(lifted(ADDEND)).operandOff).toBeUndefined();
    // …and only by it: strip the displacement and the trees are equal key for key
    const { operandOff: _drop, ...bare } = firstIndex(lifted(OPERAND));
    expect(bare).toEqual(firstIndex(lifted(ADDEND)));
  });

  // The recorded number is the INSTRUCTION's own immediate, not the total the subscript folds to:
  // `idx` already carries `idxVal + off / width`, and re-deriving the displacement from it is
  // exactly what is impossible once the two have been added together. Here the address carries a
  // +4 addend and the instruction a +6 displacement, so the subscript prints 5 (10 bytes / width
  // 2) while the field records 6.
  const MIXED = `fn f {
^bb0():
  %0: u16* = gaddr {sym="gSym"}
  %1: s32 = const {value=4}
  %2: u16* = add %0, %1
  %3: s32 = load %2 {off=6, signed=false, width=2}
  ret %3
}
`;

  test('the number is the instruction immediate, not the folded subscript', () => {
    expect(cBackend.emit(lifted(MIXED))).toContain('((u16 *)&gSym)[5]');
    expect(firstIndex(lifted(MIXED)).operandOff).toBe(6);
  });

  // A NEGATIVE displacement is a real access (`lw v0, -8(a1)` is ordinary MIPS frame/struct code),
  // and it is the case that makes `!== undefined` load-bearing rather than stylistic: read with a
  // truthiness test, -8 passes only by luck and 0 would be indistinguishable from absent. Lifted
  // through the same path as the rest, so the number really does travel.
  const NEG = `fn f {
^bb0(%0: u8*):
  %1: s32 = load %0 {off=-8, signed=false, width=1}
  ret %1
}
`;

  test('a negative displacement is recorded as one, not lost to a truthiness test', () => {
    expect(firstIndex(lifted(NEG)).operandOff).toBe(-8);
  });

  // …and the same on the plain pointer deref, the other spelling memAccess returns.
  const deref = (off: number): string => `fn f {
^bb0(%0: u8*):
  %1: s32 = load %0 {off=${off}, signed=false, width=1}
  ret %1
}
`;

  test('an offset of 0 records nothing — there is nothing for a fold to have absorbed', () => {
    expect(firstIndex(lifted(deref(3))).operandOff).toBe(3);
    expect(firstIndex(lifted(deref(0))).operandOff).toBeUndefined();
  });

  test('…and on the BARE-NAME array spelling a symbol map unlocks, which is a third mint site', () => {
    // `memAccess` mints the flag at three places — the `&gSym`-based index, the plain deref (both
    // above) and the bare `gSym[i]` form a rank-aware map produces. The third had no test: dropping
    // `...fromOperand` from it left the entire toolchain-free suite green, so the evidence could be
    // lost on exactly the rows a map serves without anything saying so.
    const arr = new Map<string, SymbolInfo>([
      ['gSym', { name: 'gSym', kind: 'data', shape: 'array', elemSize: 1, elemSigned: false, declared: true }],
    ]);
    const bare = structureChecked(parse(OPERAND), { symbols: arr });
    expect(cBackend.emit(bare)).toContain('gSym[3]');
    expect(firstIndex(bare).operandOff).toBe(3);
  });
});

// The one field on `Expr` that is EVIDENCE rather than spelling, and the one place that asymmetry
// is observable: `exprEquals` deliberately ignores it (two accesses agreeing on everything else
// denote the same cell and print the same subscript), while a COMMITTED pass that collapses
// statements with `exprEquals` runs UPSTREAM of the only pass that reads it —
// `structureChecked` is `hoistBaseLocals(eliminateDeadStores(mergeCommonTails(raw)))`. So which of
// two flags survives a merge is the merger's choice, not something read off the asm.
describe('`operandOff` is provenance, and a committed merge upstream decides which one survives', () => {
  // Two arms whose tails print the same C and differ ONLY in where the offset came from: one arm
  // loaded `[r, #3]`, the other added the relocation addend first. `mergeCommonTails` peels the
  // common tail off both.
  const twoArms = (thenCarriesEvidence: boolean): string => {
    const operand = (g: string, r: string) => `  ${r}: s32 = load ${g} {off=3, signed=false, width=1}`;
    const addend = (g: string, r: string) =>
      `  ${r}k: s32 = const {value=3}\n  ${r}a: u8* = add ${g}, ${r}k\n  ${r}: s32 = load ${r}a {off=0, signed=false, width=1}`;
    return `fn f {
^bb0(%0: s32):
  %1: s32 = const {value=0}
  %2: u32 = icmp_ne %0, %1
  cond_br %2, ^bb1(), ^bb2()
^bb1():
  %3: u8* = gaddr {sym="gSym"}
${(thenCarriesEvidence ? operand : addend)('%3', '%4')}
  %5: s32 = call %4 {target="sink"}
  br ^bb3()
^bb2():
  %6: u8* = gaddr {sym="gSym"}
${(thenCarriesEvidence ? addend : operand)('%6', '%9')}
  %10: s32 = call %9 {target="sink"}
  br ^bb3()
^bb3():
  ret
}
`;
  };

  test('the arms merge, and WHICH arm carried the evidence decides what the roster gate sees', () => {
    const merged = (thenCarriesEvidence: boolean) => structureChecked(parse(twoArms(thenCarriesEvidence)), {});
    // one call left, not two: the tails really did collapse under `exprEquals`
    expect(cBackend.emit(merged(true)).match(/sink\(/g)).toHaveLength(1);
    // …and the ELSE arm's spelling is the survivor, so the same asm shape reaches the gate or does
    // not depending only on which side of the `if` it sat on. Documented, not endorsed.
    expect(admittedBases(merged(true), BASEFOLD_GATES)).toEqual([]);
    expect(admittedBases(merged(false), BASEFOLD_GATES)).toEqual(['a:gSym 1 false']);
  });

  test('the blast radius is bounded to the roster: the COMMITTED table cannot read the flag', () => {
    // `unfoldedOffset` has exactly one reader — `BASEFOLD_GATES`' `single-use-unfolded` rule, which
    // only `rank.ts`'s roster asks for. So whatever a merge decides, `structureChecked`'s own hoist
    // binds the same bases either way: that is the bound, and it is about MEANING, not about
    // score. Widen the readership — promote the exemption into `BASECSE_GATES` — and it goes.
    //
    // The two directions are NOT symmetric, and reading them as one is how this note first got
    // written. A flag the merge INVENTS offers an extra candidate, and `compareScored` orders by
    // score, so that costs a compile and nothing else. A flag it EATS withholds one, and
    // withholding a `/basefold*` candidate costs whatever that candidate would have won: deleting
    // the sunk roster row turns `synthetic:foldsink` and `sa3:sub_803213C` from MATCH into diff:2
    // (ablated through the harness). So "it can only offer or withhold a candidate" is a bound on
    // meaning and not on matches.
    // Its reach today is zero, which is a measurement and not an argument: over the whole artifact
    // (1140 observations, five toolchains, both symbol-map configurations) `mergeCommonTails`
    // peels 25 tails and NONE of them is a pair of arms differing only in `operandOff`.
    expect(admittedBases(structureChecked(parse(twoArms(true)), {}), BASECSE_GATES)).toEqual([]);
    expect(admittedBases(structureChecked(parse(twoArms(false)), {}), BASECSE_GATES)).toEqual([]);
  });
});

describe('leaf-base hoisting', () => {
  test('a numeric pointer CONSTANT (MMIO/RAM base) indexed at ≥2 distinct offsets is hoisted', () => {
    const out = hoistBaseLocals(
      fn([
        { k: 'store', lval: cidx(0x40000d4, c(0)), value: c(0) },
        { k: 'store', lval: cidx(0x40000d4, c(1)), value: c(0) },
        { k: 'store', lval: cidx(0x40000d4, c(2)), value: c(0) },
      ]),
    );
    expect(out.locals).toEqual([{ name: 'p0', type: T.ptr(T.s(32)) }]);
    expect(out.body[0]).toEqual({
      k: 'assign',
      name: 'p0',
      value: { k: 'cast', to: T.ptr(T.s(32)), e: { k: 'const', value: 0x40000d4 } },
    });
    expect(out.body[1]).toEqual({
      k: 'store',
      lval: { k: 'index', base: { k: 'var', name: 'p0' }, idx: c(0), width: 4, signed: true },
      value: c(0),
    });
  });

  test('a const base at the SAME single constant offset (MMIO read-modify-write) is NOT hoisted', () => {
    // `*(u16 *)0x4000200 |= 2; *(u16 *)0x4000200 &= 0xFFFD` — a scalar RMW the compiler
    // re-materializes; hoisting it mismatches (it broke ProcessHBlankWait). Both accesses at idx 0.
    const body: Stmt[] = [
      { k: 'store', lval: cidx(0x4000200, c(0), 2), value: c(2) },
      { k: 'store', lval: cidx(0x4000200, c(0), 2), value: c(16) },
    ];
    const out = hoistBaseLocals(fn(body));
    expect(out.body).toEqual(body);
    expect(out.locals).toEqual([]);
  });

  test('a global at the SAME variable index at ≥2 sites IS hoisted (not a fixed-offset scalar)', () => {
    const vi: Expr = { k: 'var', name: 'a0' };
    const out = hoistBaseLocals(
      fn([
        { k: 'assign', name: 't', value: idx('gSin', vi) },
        { k: 'assign', name: 'u', value: idx('gSin', vi) },
      ]),
    );
    expect(out.locals.map((l) => l.name)).toEqual(['p0']);
  });

  test('a global indexed at ≥2 sites is hoisted into a typed local pointer', () => {
    const out = hoistBaseLocals(
      fn([
        { k: 'store', lval: idx('gTable', c(5)), value: c(0) },
        { k: 'store', lval: idx('gTable', c(6)), value: c(0) },
      ]),
    );
    // a `u8 *p0 = (u8 *)&gTable` local is introduced, and both accesses point at it.
    expect(out.locals).toEqual([{ name: 'p0', type: T.ptr(T.int(8, false)) }]);
    expect(out.body[0]).toEqual({
      k: 'assign',
      name: 'p0',
      value: { k: 'cast', to: T.ptr(T.int(8, false)), e: { k: 'addr', name: 'gTable' } },
    });
    expect(out.body[1]).toEqual({
      k: 'store',
      lval: { k: 'index', base: { k: 'var', name: 'p0' }, idx: c(5), width: 1, signed: false },
      value: c(0),
    });
    expect(out.body[2]).toEqual({
      k: 'store',
      lval: { k: 'index', base: { k: 'var', name: 'p0' }, idx: c(6), width: 1, signed: false },
      value: c(0),
    });
  });

  test('a global indexed ONCE is left inline (no hoist)', () => {
    const body: Stmt[] = [{ k: 'store', lval: idx('gTable', c(5)), value: c(0) }];
    const out = hoistBaseLocals(fn(body));
    expect(out.body).toEqual(body);
    expect(out.locals).toEqual([]);
  });

  // The offset the compiler DID NOT fold — `BASEFOLD_GATES`, the admission that exempts
  // `single-use` for it. Each refusal below differs by one fact from the admitted case.
  describe('a single access whose offset survived into the instruction', () => {
    const oneStore = (): SFn => fn([{ k: 'store', lval: cidx(0x3001100, c(3), 1, fromOperand), value: c(0) }]);

    test('a NUMERIC base whose offset reached the memory operand is hoisted', () => {
      const out = hoistBaseLocals(oneStore(), BASEFOLD_GATES);
      expect(out.locals).toEqual([{ name: 'p0', type: T.ptr(T.s(8)) }]);
      expect(out.body[0]).toEqual({
        k: 'assign',
        name: 'p0',
        value: { k: 'cast', to: T.ptr(T.s(8)), e: { k: 'const', value: 0x3001100 } },
      });
      expect(out.body[1]).toEqual({
        k: 'store',
        lval: { k: 'index', base: { k: 'var', name: 'p0' }, idx: c(3), width: 1, signed: true, ...fromOperand },
        value: c(0),
      });
    });

    test('a SYMBOL base is hoisted on the same evidence — the fold does not care which kind it is', () => {
      const out = hoistBaseLocals(fn([{ k: 'store', lval: idx('gTable', c(3), 1, fromOperand), value: c(0) }]));
      expect(out.locals).toEqual([]); // the default table still refuses it…
      const fold = hoistBaseLocals(
        fn([{ k: 'store', lval: idx('gTable', c(3), 1, fromOperand), value: c(0) }]),
        BASEFOLD_GATES,
      );
      expect(fold.locals).toEqual([{ name: 'p0', type: T.ptr(T.u(8)) }]);
      expect(fold.body[0]).toEqual({
        k: 'assign',
        name: 'p0',
        value: { k: 'cast', to: T.ptr(T.u(8)), e: { k: 'addr', name: 'gTable' } },
      });
    });

    test('the DEFAULT table leaves it inline: an inline aggregate member emits the same bytes', () => {
      const input = oneStore();
      expect(hoistBaseLocals(input)).toBe(input);
    });

    test('an offset the ADDRESS carried is left inline, at either kind of base', () => {
      // No `operandOff`: the constant is already inside the materialized literal (a relocation
      // addend, a folded `add`) — which is where a subscript would have put it, so there is no
      // evidence to read. An access at offset 0 reaches here the same way, the structurer having
      // nothing to record when the fold would be the identity.
      for (const lval of [cidx(0x3001100, c(3), 1), idx('gTable', c(3)), cidx(0x3001100, c(0), 1)]) {
        const input = fn([{ k: 'store', lval, value: c(0) }]);
        expect(hoistBaseLocals(input, BASEFOLD_GATES)).toBe(input);
      }
    });

    test('a base of 0 reads the evidence like any other: agbcc materializes a zero base too', () => {
      // A zero base looks like the one address with nowhere else for an offset to go, and on MIPS
      // it is (`lb $v0, 16($zero)`). This rule runs only on agbcc, which materializes it like any
      // other constant — compiled both ways with the benchmark's own flags, `((s8 *)0)[16]` is
      // `mov r0, #0x10` + `ldrb [r0, #0]` and `s8 *p = (s8 *)0; p[16]` is `mov r0, #0x0` +
      // `ldrb [r0, #0x10]`, the same pair that discriminates at every other base.
      const evidence = fn([{ k: 'store', lval: cidx(0, c(16), 1, { operandOff: 16 }), value: c(0) }]);
      expect(hoistBaseLocals(evidence, BASEFOLD_GATES).locals).toHaveLength(1);
      // …and with no operand offset it is refused, like any other base reached once
      const inline = fn([{ k: 'store', lval: cidx(0, c(16), 1), value: c(0) }]);
      expect(hoistBaseLocals(inline, BASEFOLD_GATES)).toBe(inline);
    });

    test('`prepend` is not a placement this pass may take — the hazard is typed out', () => {
      // A run already at the head carries the bases the compiler loads FIRST; prepending a minted
      // one above it spells its pool load first instead (the header). `HoistPlacement` excludes
      // the value, so a roster row or a caller reaching for it is a TYPE error — checked by
      // `pnpm typecheck`, whose root tsconfig includes `packages/*/test`.
      const input: SFn = {
        ...fn([
          { k: 'assign', name: 'q0', value: { k: 'cast', to: T.ptr(T.u(8)), e: { k: 'const', value: 0x4000000 } } },
          {
            k: 'store',
            lval: { k: 'index', base: { k: 'var', name: 'q0' }, idx: c(0), width: 1, signed: false },
            value: c(1),
          },
          { k: 'store', lval: cidx(0x3001100, c(3), 1, fromOperand), value: c(0) },
        ]),
        locals: [{ name: 'q0', type: T.ptr(T.u(8)) }],
      };
      // @ts-expect-error 'prepend' is a BaseInitPlacement but not a HoistPlacement
      const hazard = hoistBaseLocals(input, BASEFOLD_GATES, 'prepend');
      // …and this is the shape it emits when the type is defeated: the minted p0 above q0.
      expect(hazard.body.filter((st) => st.k === 'assign').map((st) => st.name)).toEqual(['p0', 'q0']);
      // what the pass actually does with the placement it may take
      expect(
        hoistBaseLocals(input, BASEFOLD_GATES, 'head')
          .body.filter((st) => st.k === 'assign')
          .map((st) => st.name),
      ).toEqual(['q0', 'p0']);
    });

    test('both tables still refuse what the PLACEMENT rules refuse', () => {
      const inLoop = fn([
        { k: 'while', cond: c(1), body: [{ k: 'store', lval: cidx(0x3001100, c(3), 1, fromOperand), value: c(0) }] },
      ]);
      expect(hoistBaseLocals(inLoop, BASEFOLD_GATES).locals).toEqual([]);
      expect(hoistBaseLocals(inLoop, BASECSE_GATES).locals).toEqual([]);
    });

    // What prices the exemption, and what does not. An ablation removes a whole gate, and this
    // one carries the rule AND its exemption together — so the price is the two tables'
    // admitted-set DIFF, and the ablation is the naive one.
    test('the exemption prices by the tables DIFF, because both ablations are the same table', () => {
      const input = oneStore();
      expect(
        admittedBases(input, BASEFOLD_GATES).filter((k) => !admittedBases(input, BASECSE_GATES).includes(k)),
      ).toHaveLength(1);
      // the use-count rule, alone — unchanged by the lever's existence
      expect(hoistBaseLocals(input, without(BASECSE_GATES, 'single-use')).locals).toHaveLength(1);
      // ...and dropping the exemption's gate drops `reachedOnce` with it, landing on that exact
      // table, which is why the exemption's own price is the diff and not an ablation.
      expect(without(BASEFOLD_GATES, 'single-use-unfolded')).toEqual(without(BASECSE_GATES, 'single-use'));
    });
  });

  test('two DIFFERENT globals each indexed twice both hoist, in first-use order', () => {
    const out = hoistBaseLocals(
      fn([
        { k: 'store', lval: idx('gA', c(0)), value: c(1) },
        { k: 'store', lval: idx('gB', c(0)), value: c(1) },
        { k: 'store', lval: idx('gA', c(4)), value: c(1) },
        { k: 'store', lval: idx('gB', c(4)), value: c(1) },
      ]),
    );
    expect(out.locals.map((l) => l.name)).toEqual(['p0', 'p1']); // gA first, gB second
    expect((out.body[0] as { value: { e: { name: string } } }).value.e.name).toBe('gA');
    expect((out.body[1] as { value: { e: { name: string } } }).value.e.name).toBe('gB');
  });

  test('a base used INSIDE a loop is NOT hoisted (avoids callee-saved push/pop)', () => {
    const body: Stmt[] = [
      {
        k: 'dowhile',
        cond: { k: 'bin', op: '!=', l: idx('gTable', c(0)), r: c(0) },
        body: [{ k: 'store', lval: idx('gTable', c(4)), value: c(0) }],
      },
    ];
    const out = hoistBaseLocals(fn(body));
    expect(out.body).toEqual(body); // unchanged
    expect(out.locals).toEqual([]);
  });

  test('same global at DIFFERENT widths is not merged (distinct pointer types)', () => {
    // gTable read as u8 once and as a u16 once → neither key reaches 2, nothing hoists.
    const out = hoistBaseLocals(
      fn([
        { k: 'store', lval: idx('gTable', c(0), 1), value: c(0) },
        { k: 'store', lval: idx('gTable', c(0), 2), value: c(0) },
      ]),
    );
    expect(out.locals).toEqual([]);
  });
});

describe('/livebase admission (LIVEBASE_GATES: placement heuristics ablated)', () => {
  // The MMIO poll: three stores plus a busy-wait re-read of the same fixed offset, all through
  // one constant base. `loop` and `repeated-const-offset` both reject it, yet the compiler holds
  // the base in ONE register throughout — the shape the lever exists for.
  const poll = (): SFn =>
    fn([
      { k: 'store', lval: cidx(0x40000d4, c(0)), value: { k: 'var', name: 'a0' } },
      { k: 'store', lval: cidx(0x40000d4, c(1)), value: { k: 'var', name: 'a1' } },
      { k: 'store', lval: cidx(0x40000d4, c(2)), value: { k: 'var', name: 'a2' } },
      { k: 'dowhile', cond: { k: 'bin', op: '!=', l: cidx(0x40000d4, c(2)), r: c(0) }, body: [] },
    ]);

  test('the poll shape: default gates refuse, LIVEBASE_GATES hoists every access onto one local', () => {
    const input = poll();
    expect(hoistBaseLocals(input)).toBe(input);

    const out = hoistBaseLocals(poll(), LIVEBASE_GATES);
    expect(out.locals).toEqual([{ name: 'p0', type: T.ptr(T.s(32)) }]);
    expect(out.body[0]).toEqual({
      k: 'assign',
      name: 'p0',
      value: { k: 'cast', to: T.ptr(T.s(32)), e: { k: 'const', value: 0x40000d4 } },
    });
    const dw = out.body[4] as Stmt & { k: 'dowhile' };
    expect((dw.cond as Expr & { k: 'bin' }).l).toEqual({
      k: 'index',
      base: { k: 'var', name: 'p0' },
      idx: c(2),
      width: 4,
      signed: true,
    });
  });

  test('the /livebase/volatile product: the hoisted numeric base qualifies for the volatile lever', () => {
    const out = hoistBaseLocals(poll(), LIVEBASE_GATES);
    const vol = volatilePtrLocals(out);
    expect(vol?.locals.find((l) => l.name === 'p0')?.pointeeVolatile).toBe(true);
  });

  test('single-use survives the ablation: one access is still refused, and by the SAME object', () => {
    const input = fn([{ k: 'store', lval: cidx(0x40000d4, c(0)), value: c(0) }]);
    expect(hoistBaseLocals(input, LIVEBASE_GATES)).toBe(input);
  });

  // Mixed admitted+refused bases: the lever re-runs on a tree whose head already holds the
  // default run's init, and pool-load order is FIRST-USE order across both — whichever base the
  // body touches first gets its init first, not whichever pass hoisted it.
  const admitted = (v: string): Stmt[] => [
    { k: 'store', lval: cidx(0x3001000, c(0)), value: { k: 'var', name: v } },
    { k: 'store', lval: cidx(0x3001000, c(1)), value: { k: 'var', name: v } },
  ];
  const refusedLoop: Stmt = {
    k: 'dowhile',
    cond: { k: 'bin', op: '!=', l: cidx(0x40000d4, c(2)), r: c(0) },
    body: [{ k: 'store', lval: cidx(0x40000d4, c(2)), value: c(1) }],
  };
  const initOrder = (body: Stmt[]): (number | undefined)[] => {
    const afterDefault = hoistBaseLocals(fn(body));
    const out = hoistBaseLocals(afterDefault, LIVEBASE_GATES);
    expect(out.locals.map((l) => l.name)).toEqual(['p0', 'p1']);
    return out.body.slice(0, 2).map((s) => {
      const a = s as Stmt & { k: 'assign' };
      return (a.value as Expr & { k: 'cast' }).e.k === 'const'
        ? ((a.value as Expr & { k: 'cast' }).e as Expr & { k: 'const' }).value
        : undefined;
    });
  };

  test('mixed bases, admitted base first-used first: its init stays first', () => {
    expect(initOrder([...admitted('a0'), refusedLoop])).toEqual([0x3001000, 0x40000d4]);
  });

  test('mixed bases, refused base first-used first: the lever init moves ahead of the default one', () => {
    expect(initOrder([refusedLoop, ...admitted('a0')])).toEqual([0x40000d4, 0x3001000]);
  });

  test('an `&q` escape counts as a first use, so the existing init keeps its place ahead', () => {
    // the first-use query is l3/hoist.ts's, shared with sinkinit.ts, and it counts `addr`. A
    // narrower notion would sort `q` behind the minted base it is loaded before.
    const input: SFn = {
      ...fn([
        { k: 'assign', name: 'q', value: { k: 'cast', to: T.ptr(T.s(8)), e: c(0x40000d4) } },
        { k: 'exprstmt', value: { k: 'call', fn: 'g', args: [{ k: 'addr', name: 'q' }] } },
        ...admitted('a0'),
      ]),
      locals: [{ name: 'q', type: T.ptr(T.s(8)) }],
    };
    const out = hoistBaseLocals(input, LIVEBASE_GATES);
    expect(out.body.slice(0, 2).map((st) => (st as Stmt & { k: 'assign' }).name)).toEqual(['q', 'p0']);
  });

  test('a head write to a `volatile` local ends the reorderable run: volatile write order is kept', () => {
    const input: SFn = {
      ...fn([
        { k: 'assign', name: 'v1', value: { k: 'cast', to: T.ptr(T.int(8, false)), e: c(0x111) } },
        { k: 'assign', name: 'v2', value: { k: 'cast', to: T.ptr(T.int(8, false)), e: c(0x222) } },
        { k: 'store', lval: cidx(0x3001000, c(0)), value: { k: 'var', name: 'v2' } },
        { k: 'store', lval: cidx(0x3001000, c(1)), value: { k: 'var', name: 'v1' } },
      ]),
      locals: [
        { name: 'v1', type: T.ptr(T.int(8, false)), volatile: true },
        { name: 'v2', type: T.ptr(T.int(8, false)), volatile: true },
      ],
    };
    const out = hoistBaseLocals(input);
    // the hoist init lands above, and v1/v2 keep their order even though v2 is first-used first
    expect(out.body.slice(0, 3).map((s) => (s as Stmt & { k: 'assign' }).name)).toEqual(['p0', 'v1', 'v2']);
  });

  test('a base the default gates already admitted leaves nothing: the lever declines', () => {
    const hoisted = hoistBaseLocals(
      fn([
        { k: 'store', lval: cidx(0x40000d4, c(0)), value: c(0) },
        { k: 'store', lval: cidx(0x40000d4, c(1)), value: c(0) },
      ]),
    );
    expect(hoisted.locals).toHaveLength(1);
    expect(hoistBaseLocals(hoisted, LIVEBASE_GATES)).toBe(hoisted);
  });
});

describe('the block admission (WHICH admitted bases get the local)', () => {
  // One MMIO register file indexed at three cells, beside two scalar cells re-read in place — all
  // three bases in the same loop, so the default gates refuse every one and only /livebase's
  // ablation admits them. The source spelled the register file as a pointer and the scalars as
  // bare derefs; the all-or-nothing hoist cannot offer that, `single-cell` makes it a candidate.
  const mixed = (): SFn =>
    fn([
      {
        k: 'dowhile',
        cond: { k: 'bin', op: '!=', l: cidx(0x40000d4, c(2)), r: c(0) },
        body: [
          { k: 'store', lval: cidx(0x3001048, c(0), 2), value: c(1) },
          { k: 'store', lval: cidx(0x3002048, c(0), 2), value: c(2) },
          { k: 'store', lval: cidx(0x3001048, c(0), 2), value: c(3) },
          { k: 'store', lval: cidx(0x3002048, c(0), 2), value: c(4) },
          { k: 'store', lval: cidx(0x40000d4, c(0)), value: c(0) },
          { k: 'store', lval: cidx(0x40000d4, c(1)), value: c(0) },
        ],
      },
    ]);
  const boundBases = (s: SFn): number[] =>
    s.body
      .filter((x): x is Stmt & { k: 'assign' } => x.k === 'assign')
      .map((x) => ((x.value as Expr & { k: 'cast' }).e as Expr & { k: 'const' }).value);

  test('the register file binds and the scalar cells stay inline', () => {
    // the register file first: `collect` reads the loop's own CONDITION before its body
    expect(boundBases(hoistBaseLocals(mixed(), LIVEBASE_GATES))).toEqual([0x40000d4, 0x3001048, 0x3002048]);
    expect(boundBases(hoistBaseLocals(mixed(), LIVEBASE_BLOCK_GATES))).toEqual([0x40000d4]);
  });

  test('the unhoisted cells keep the spelling they had', () => {
    const block = hoistBaseLocals(mixed(), LIVEBASE_BLOCK_GATES);
    const loop = block.body[1] as Stmt & { k: 'dowhile' };
    expect((loop.body[0] as Stmt & { k: 'store' }).lval).toEqual(cidx(0x3001048, c(0), 2));
    expect((loop.body[4] as Stmt & { k: 'store' }).lval).toEqual({
      k: 'index',
      base: { k: 'var', name: 'p0' },
      idx: c(0),
      width: 4,
      signed: true,
    });
  });

  test("the axis is one gate: ablating `single-cell` is /livebase's own admission", () => {
    expect(without(LIVEBASE_BLOCK_GATES, 'single-cell').map((g) => g.id)).toEqual(LIVEBASE_GATES.map((g) => g.id));
    expect(boundBases(hoistBaseLocals(mixed(), without(LIVEBASE_BLOCK_GATES, 'single-cell')))).toEqual(
      boundBases(hoistBaseLocals(mixed(), LIVEBASE_GATES)),
    );
  });

  test('a VARIABLE index reaches a block of cells however few constant offsets it also touches', () => {
    const walk = fn([
      { k: 'store', lval: cidx(0x3001048, { k: 'var', name: 'a0' }, 2), value: c(1) },
      { k: 'store', lval: cidx(0x3001048, c(0), 2), value: c(2) },
      { k: 'store', lval: cidx(0x3002048, c(0), 2), value: c(3) },
      { k: 'store', lval: cidx(0x3002048, c(0), 2), value: c(4) },
    ]);
    expect(boundBases(hoistBaseLocals(walk, LIVEBASE_BLOCK_GATES))).toEqual([0x3001048]);
  });

  test('the two DEGENERATE admissions, which rank turns into a decline', () => {
    // all cells: nothing left to hoist, and the pass says so by returning the tree it was given
    const cells = fn([
      { k: 'store', lval: cidx(0x3001048, c(0), 2), value: c(1) },
      { k: 'store', lval: cidx(0x3001048, c(0), 2), value: c(2) },
      { k: 'store', lval: cidx(0x3002048, c(0), 2), value: c(3) },
      { k: 'store', lval: cidx(0x3002048, c(0), 2), value: c(4) },
    ]);
    expect(hoistBaseLocals(cells, LIVEBASE_BLOCK_GATES)).toBe(cells);
    // all blocks: the gate rejects nothing, so this IS the /livebase hoist
    const blocks = fn([
      { k: 'store', lval: cidx(0x40000d4, c(0)), value: c(1) },
      { k: 'store', lval: cidx(0x40000d4, c(1)), value: c(2) },
    ]);
    expect(boundBases(hoistBaseLocals(blocks, LIVEBASE_BLOCK_GATES))).toEqual(
      boundBases(hoistBaseLocals(blocks, LIVEBASE_GATES)),
    );
  });

  test('the narrower hoist never changes what an access MEANS: same bases, fewer of them bound', () => {
    const all = boundBases(hoistBaseLocals(mixed(), LIVEBASE_GATES));
    const block = boundBases(hoistBaseLocals(mixed(), LIVEBASE_BLOCK_GATES));
    expect(block.every((b) => all.includes(b))).toBe(true);
    expect(block.length).toBeLessThan(all.length);
  });

  test('two register files bind TOGETHER — the COVERAGE limit the roster stops at', () => {
    const twoFiles = fn([
      { k: 'store', lval: cidx(0x40000d4, c(0)), value: c(1) },
      { k: 'store', lval: cidx(0x40000d4, c(1)), value: c(2) },
      { k: 'store', lval: cidx(0x40000b0, c(0)), value: c(3) },
      { k: 'store', lval: cidx(0x40000b0, c(1)), value: c(4) },
      { k: 'store', lval: cidx(0x3001048, c(0), 2), value: c(5) },
      { k: 'store', lval: cidx(0x3001048, c(0), 2), value: c(6) },
    ]);
    expect(boundBases(hoistBaseLocals(twoFiles, LIVEBASE_BLOCK_GATES))).toEqual([0x40000d4, 0x40000b0]);
  });
});

describe('the fold-evidence admission (WHICH reused bases the source PARKED)', () => {
  // Two numeric bases reached twice each in the same loop, so `/livebase` binds both and the
  // default table neither. One is read through a surviving operand offset — the shape a pointer
  // local strides — and the other at the address the pool already carried, which is what a source
  // that spelled it inline leaves behind. `single-cell` cannot tell them apart: both are read at
  // one fixed offset.
  const parked = (): SFn =>
    fn([
      {
        k: 'dowhile',
        cond: { k: 'bin', op: '!=', l: cidx(0x3002040, c(0)), r: c(0) },
        body: [
          { k: 'store', lval: cidx(0x3002040, c(0)), value: c(1) },
          { k: 'store', lval: cidx(0x3003400, c(15), 4, fromOperand), value: c(2) },
          { k: 'store', lval: cidx(0x3003400, c(15), 4, fromOperand), value: c(3) },
        ],
      },
    ]);
  const boundBases = (s: SFn): number[] =>
    s.body
      .filter((x): x is Stmt & { k: 'assign' } => x.k === 'assign')
      .map((x) => ((x.value as Expr & { k: 'cast' }).e as Expr & { k: 'const' }).value);

  test('it binds the base whose offset survived and leaves the folded one inline', () => {
    expect(boundBases(hoistBaseLocals(parked(), UNFOLDED_GATES))).toEqual([0x3003400]);
    // the two boundaries the roster already had: all of them, or all of them minus the cells
    expect(boundBases(hoistBaseLocals(parked(), LIVEBASE_GATES))).toEqual([0x3002040, 0x3003400]);
    expect(boundBases(hoistBaseLocals(parked(), LIVEBASE_BLOCK_GATES))).toEqual([]);
  });

  test("the axis is one gate: ablating `folded-offset` is /livebase's own admission", () => {
    expect(without(UNFOLDED_GATES, 'folded-offset').map((g) => g.id)).toEqual(LIVEBASE_GATES.map((g) => g.id));
    expect(admittedBases(parked(), without(UNFOLDED_GATES, 'folded-offset'))).toEqual(
      admittedBases(parked(), LIVEBASE_GATES),
    );
  });

  test('it is not `/basefold` relaxed: the two tables ask opposite questions of one field', () => {
    // `/basefold` exempts `single-use` on the evidence, so it reaches a base read ONCE and this
    // table refuses that same base on `single-use`; the evidenced base below is read twice inside
    // a loop, so `/basefold` refuses it first on `loop` — a placement heuristic it keeps and this
    // table ablates. Both rejections read off `firstRejection`, not off the table's order.
    const once = fn([{ k: 'store', lval: cidx(0x3001100, c(3), 1, fromOperand), value: c(0) }]);
    expect(admittedBases(once, BASEFOLD_GATES)).toHaveLength(1);
    expect(admittedBases(once, UNFOLDED_GATES)).toEqual([]);
    expect(admittedBases(parked(), BASEFOLD_GATES)).toEqual([]);
    expect(admittedBases(parked(), UNFOLDED_GATES)).toHaveLength(1);
  });

  test('MISSING evidence is what it refuses on, never a claim the offset was folded', () => {
    // An offset the address expression already carried records nothing (see the header), and
    // `structure/structure.ts` records nothing for an offset of 0 either — so a base the source
    // really parked can arrive here indistinguishable from one it spelled inline. The table
    // declines on both, and declining is the whole of the refusal: the tree comes back untouched
    // rather than hoisted on a guess.
    const noEvidence = (): SFn =>
      fn([
        { k: 'store', lval: cidx(0x3003400, c(15)), value: c(2) },
        { k: 'store', lval: cidx(0x3003400, c(15)), value: c(3) },
      ]);
    const input = noEvidence();
    expect(admittedBases(input, LIVEBASE_GATES)).toHaveLength(1);
    expect(admittedBases(input, UNFOLDED_GATES)).toEqual([]);
    expect(hoistBaseLocals(input, UNFOLDED_GATES)).toBe(input);
  });

  test("the census on the row's own agbcc output: the two parked bases, in first-use order", () => {
    // `corpus/agbcc-unfoldpark.s` is synthetic:unfoldpark:agbcc — one folded scalar cell
    // (`*(s32 *)0x03002040`) beside two bases the source held in pointer locals. The roster's two
    // admissions bind all three keys and one of them; the set the source actually parked is
    // neither, which is what this table is for.
    const sfn = structureChecked(
      frontendFor(ARMV4T_AGBCC).lift(
        'unfoldpark',
        readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-unfoldpark.s'), 'utf8'),
        ARMV4T_AGBCC,
        { unfoldpark: { params: ['s32', 's32*'], returnsVoid: true } },
      ),
      {},
    );
    expect(admittedBases(sfn, UNFOLDED_GATES)).toEqual(['c:50344960 4 true', 'c:67109076 4 true']);
    expect(admittedBases(sfn, LIVEBASE_GATES)).toHaveLength(3);
    expect(admittedBases(sfn, LIVEBASE_BLOCK_GATES)).toEqual(['c:67109076 4 true']);
    expect(admittedBases(sfn, BASECSE_GATES)).toEqual([]);
  });
});

describe('the block admission is WIRED into enumeration', () => {
  // Real agbcc outputs, so no toolchain: `corpus/agbcc-mixpoll.s` is synthetic:mixpoll:agbcc —
  // one DMA register file at three offsets beside three IWRAM halfwords read-modified in place,
  // the shape that needs a proper subset of its bases bound — and `corpus/agbcc-onepoll.s` is its
  // control, byte-identical C with the halfwords deleted. Which spelling wins is the benchmark's
  // business; these pin what reaches the differ at all.
  const candsFor = (file: string, target = ARMV4T_AGBCC, sym = file) =>
    enumerateCandidates(sym, readFileSync(join(import.meta.dirname, 'corpus', `agbcc-${file}.s`), 'utf8'), target, {
      prototypes: { [sym]: { returnsVoid: true } },
    });
  const cands = candsFor('mixpoll');

  test('the narrower hoist reaches the candidate list, plain and volatile', () => {
    // the roster's own four labels — the pairings that ride on them are their own tests' business
    expect(cands.filter((x) => /^signed\/livebase(-block)?(\/volatile)?$/.test(x.label)).map((x) => x.label)).toEqual([
      'signed/livebase',
      'signed/livebase/volatile',
      'signed/livebase-block',
      'signed/livebase-block/volatile',
    ]);
  });

  test('it binds the register file alone and leaves the scalar cells inline', () => {
    const src = cands.find((x) => x.label === 'signed/livebase-block/volatile')!.source;
    expect(src).toContain('volatile s32 * p0;');
    expect(src).toContain('p0 = (s32 *)67109076;');
    expect(src).toContain('*(u16 *)50335816 = *(u16 *)50335816 + 1;');
    expect(src).not.toContain('50335816;'); // no init binds it
  });

  test('one base and no cell beside it ⇒ it DECLINES rather than repeat /livebase', () => {
    const labels = candsFor('onepoll').map((x) => x.label);
    expect(labels).toContain('signed/livebase/volatile');
    expect(labels.filter((l) => l.includes('livebase-block'))).toEqual([]);
  });

  test('/basefold reaches the roster where the target declares the fold, and only there', () => {
    // `corpus/agbcc-basecell.s` is synthetic:basecell:agbcc — ONE access through a numeric base at
    // a non-zero byte offset, the shape the default table refuses and this admission exempts.
    const labels = candsFor('basecell').map((x) => x.label);
    expect(labels).toContain('unsigned/basefold');
    // its first use IS its first statement, so the sunk row re-emits the head row's source and the
    // dedup collapses it — the second placement costs nothing where it cannot move anything
    expect(labels.filter((l) => l.includes('basefold/sinkinit'))).toEqual([]);
    // the fold is a per-compiler declaration, so a target without it never offers the row
    const noFold = {
      ...ARMV4T_AGBCC,
      compilerBehaviors: { ...ARMV4T_AGBCC.compilerBehaviors, foldsConstAddrOffset: undefined },
    };
    expect(
      candsFor('basecell', noFold)
        .map((x) => x.label)
        .filter((l) => l.includes('basefold')),
    ).toEqual([]);
  });

  test('the admission rides at BOTH placements where they differ', () => {
    // `corpus/agbcc-foldsink.s` is synthetic:foldsink:agbcc — the same single fold-evidence access
    // three statements down, so head placement and first-use placement are different trees. Both
    // are offered and the differ referees: the row is a MATCH on the sunk one, and the head one
    // scores WORSE than not hoisting at all (the ladder is in the dataset's note).
    const labels = candsFor('foldsink').map((x) => x.label);
    expect(labels).toContain('unsigned/basefold');
    expect(labels).toContain('unsigned/basefold/sinkinit');
  });

  test('two rows binding DIFFERENT bases both ride — the set half of the shadow rule', () => {
    // `sameBases` collapses a row that binds exactly what an earlier row bound. mixpoll's two
    // livebase rows bind different sets, so neither shadows the other. This pins the SET
    // comparison only: both rows place at the head, so removing the rule's placement clause leaves
    // this test green. What the POSITION clause pins is one describe below — `/basefold` and
    // `/basefold/sinkinit` share one gate object, so without it the sunk row is shadowed on every
    // function and never fires at all ('the admission rides at BOTH placements where they differ',
    // the only test that fails when the clause goes).
    const labels = candsFor('mixpoll').map((x) => x.label);
    expect(labels.filter((l) => l.endsWith('/livebase'))).not.toEqual([]);
    expect(labels.filter((l) => l.endsWith('/livebase-block'))).not.toEqual([]);
  });

  test('the SYMBOL half reaches the roster end to end, from real agbcc output', () => {
    // `corpus/agbcc-tailmerge.s` is sa3:sub_803213C's own agbcc output — `.word gStageData` plus
    // `ldrb r0, [r0, #0x3]`, the symbol + operand-offset shape the widening is about. Everything
    // else about the symbol half is pinned on hand-built trees with `operandOff` written in by the
    // test, or on the real-tier row, which needs the 2.2 GB project checkouts. This is the one
    // offline gate that runs the whole chain: lift → `operandOff` → `BASEFOLD_GATES` → both
    // placement labels. It fails on `origin/main`'s core, where the gate binds nothing.
    const sfn = structureChecked(
      frontendFor(ARMV4T_AGBCC).lift(
        'sub_803213C',
        readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-tailmerge.s'), 'utf8'),
        ARMV4T_AGBCC,
        { sub_803213C: { returnsVoid: true } },
      ),
      {},
    );
    expect(admittedBases(sfn, BASEFOLD_GATES)).toEqual(['a:gStageData 1 false']);
    expect(admittedBases(sfn, BASECSE_GATES)).toEqual([]);
    const labels = candsFor('tailmerge', ARMV4T_AGBCC, 'sub_803213C').map((x) => x.label);
    expect(labels).toContain('unsigned/basefold');
    expect(labels).toContain('unsigned/basefold/sinkinit');
  });

  test('/basefold declines where its exemption binds nothing', () => {
    // mixpoll's bases are all reached 2+ times, so the exemption is vacuous there — and every key
    // it could have bound the DEFAULT hoist already took, before `fanOut` saw the tree.
    expect(cands.map((x) => x.label).filter((l) => l.includes('basefold'))).toEqual([]);
  });

  test('/basefold joins no PAIRING: no row demands the joint spelling', () => {
    // The `/livebase ×` products fan over the rows that declared `pairings`, and this one does
    // not — so the labels it contributes are its own family and nothing crossed with it. Read on
    // `foldsink`, where BOTH roster rows fire and are distinct: on `basecell` they emit the same
    // source and `seen` keeps only the head one, so `/basefold/sinkinit` is absent there for a
    // reason that has nothing to do with pairings and this test would pass without checking
    // anything.
    const basefold = candsFor('foldsink')
      .map((x) => x.label)
      .filter((l) => l.includes('basefold'));
    expect(basefold).toContain('unsigned/basefold');
    expect(basefold).toContain('unsigned/basefold/sinkinit');
    // the roster's own two suffixes and nothing else — no product crossed with them
    for (const suffix of ['/indexed', '/nearbase', '/coalesce']) {
      expect(basefold.filter((l) => l.includes(suffix))).toEqual([]);
    }
    expect(basefold.filter((l) => l.includes('/sinkinit') && !l.includes('/basefold/sinkinit'))).toEqual([]);
  });

  test('every /livebase PRODUCT fans over the roster, and one of them is reachable no other way', () => {
    // `corpus/agbcc-sizebound.s` is synthetic:sizebound:agbcc — a DMA register file beside a
    // halfword read as two loop bounds. The wide admission binds that halfword, which leaves
    // /nearbase no neighbour cells to cluster; only the narrow one leaves it inline, so the
    // pairing exists on `-block` alone.
    const labels = candsFor('sizebound').map((x) => x.label);
    expect(labels).toContain('signed/livebase-block/volatile/nearbase');
    expect(labels.filter((l) => l.startsWith('signed/livebase/') && l.includes('nearbase'))).toEqual([]);
  });

  test('/nearbase rides at BOTH orderings, so nothing commits its placement uncontested', () => {
    // `l3/nearbase.ts` places its cluster inits above the run already there, on the strength of
    // one row and no compiler fact. The sunk sibling is the other ordering; without it that
    // choice decides `synthetic:dmafield`'s match with no candidate beside it to lose to.
    const labels = candsFor('sizebound').map((x) => x.label);
    expect(labels).toContain('signed/livebase-block/volatile/nearbase');
    expect(labels).toContain('signed/defsite/loop-entry/livebase-block/volatile/nearbase/sinkinit');
    // and the sunk one is a DIFFERENT candidate, not a relabelled duplicate
    const src = (l: string) => candsFor('sizebound').find((x) => x.label === l)!.source;
    expect(src('signed/defsite/loop-entry/livebase-block/volatile/nearbase')).not.toEqual(
      src('signed/defsite/loop-entry/livebase-block/volatile/nearbase/sinkinit'),
    );
  });
});
