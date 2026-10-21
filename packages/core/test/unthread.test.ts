// A LOOP EXIT THE COMPILER JUMP-THREADED PAST THE RE-TEST AFTER THE LOOP (raise/unthread.ts).
//
// `for (i = 0; i < 3; i++) if (x == t[i].a || x == t[i].b) break;  if (x == t[i].a) A; else B;` —
// GCC's jump threading points the `x == t[i].a` exit straight at A, skipping the re-test R that the
// loop's other exits reach, and the loop leaves for two blocks. The fold points it back at R.
//
// Every fixture is run before and after the fold by the small interpreter below, which models
// memory (a read of a cell nobody stored answers a value off the seed, in 0..3 so equalities are
// common), so a fold that changes which edge a path takes changes an observable here. Each refusal
// is also run with its gate ablated: the fold then fires, and the program it leaves is a different
// one (or does not verify) — which is what makes the gate `sound`.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import type { Block, Fn, Value } from '../src/ir/core';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { type Gate, without } from '../src/l3/gates';
import { PRE_STRUCTURE_FOLDS } from '../src/raise/pre-structure';
import { recoverTypes } from '../src/raise/recover';
import { type ThreadedExit, UNTHREAD_GATES, unthreadLoopExits } from '../src/raise/unthread';
import { structure } from '../src/structure/structure';
import { symAddr } from './helpers';

const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1);

type Ev = string;

/** Run `fn` on `seed`: entry params in 0..3, memory a seeded function of the address until stored. */
function run(fn: Fn, seed: number): Ev[] {
  const out: Ev[] = [];
  const env = new Map<Value, number>();
  const mem = new Map<number, number>();
  const cell = (a: number) => mem.get(a) ?? (Math.imul(seed * 2654435761 + 7, a + 97) >>> 13) % 4;
  fn.blocks[0].params.forEach((p, i) => env.set(p, (seed >> (i * 2)) & 3));
  const rd = (x: Value): number => {
    const n = env.get(x);
    if (n === undefined) {
      throw new Error('read of an undefined value');
    }
    return n;
  };
  let b: Block = fn.blocks[0];
  for (let steps = 0; ;) {
    let next: { block: Block; args: Value[] } | undefined;
    for (const op of b.ops) {
      if (++steps > 5000) {
        throw new Error('step cap');
      }
      const o = op.operands.map(rd);
      const r = op.results[0];
      const set = (n: number) => env.set(r, n | 0);
      switch (op.opcode) {
        case 'const':
          set(op.attrs.value as number);
          break;
        case 'gaddr':
          set(symAddr(op.attrs.sym as string));
          break;
        case 'add':
          set(o[0] + o[1]);
          break;
        case 'and':
          set(o[0] & o[1]);
          break;
        case 'shl':
          set(o[0] << (op.attrs.imm as number));
          break;
        case 'zext':
          set(o[0] & ((1 << (op.attrs.width as number)) - 1));
          break;
        case 'icmp_eq':
          set(o[0] === o[1] ? 1 : 0);
          break;
        case 'icmp_ne':
          set(o[0] !== o[1] ? 1 : 0);
          break;
        case 'icmp_slt':
          set(o[0] < o[1] ? 1 : 0);
          break;
        case 'icmp_ult':
          set(o[0] >>> 0 < o[1] >>> 0 ? 1 : 0);
          break;
        case 'icmp_uge':
          set(o[0] >>> 0 >= o[1] >>> 0 ? 1 : 0);
          break;
        case 'icmp_ugt':
          set(o[0] >>> 0 > o[1] >>> 0 ? 1 : 0);
          break;
        case 'load':
          set(cell(o[0] + ((op.attrs.off as number) ?? 0)));
          break;
        case 'store': {
          const a = o[0] + ((op.attrs.off as number) ?? 0);
          mem.set(a, o[1]);
          out.push(`store ${a}=${o[1]}`);
          break;
        }
        case 'ret':
          out.push(`ret ${o.join(',')}`);
          return out;
        case 'br':
          next = op.successors[0];
          break;
        case 'cond_br':
          next = o[0] !== 0 ? op.successors[0] : op.successors[1];
          break;
        default:
          throw new Error(`the interpreter does not model ${op.opcode}`);
      }
    }
    const vals = next!.args.map(rd);
    next!.block.params.forEach((p, i) => env.set(p, vals[i]));
    b = next!.block;
  }
}

/** How many seeds the two programs disagree on. */
const disagreements = (a: Fn, b: Fn): number =>
  SEEDS.filter((s) => JSON.stringify(run(a, s)) !== JSON.stringify(run(b, s))).length;

const folded = (ir: string, gates: readonly Gate<ThreadedExit>[] = UNTHREAD_GATES) => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  const n = unthreadLoopExits(fn, gates);
  return { n, fn, before: parse(ir) };
};

/** `synthetic:thrbreak:agbcc` as it reaches the pre-structure folds. bb4's `x == t[i].a` exit goes to
 *  bb7 (the THEN arm, `gOut = 1`), past bb6, the re-test every other exit reaches. */
const AGBCC = `fn thrbreak {
^bb0(%0: u8):
  %1: s32 = const {value=0}
  %2: u8* = gaddr {sym="gTbl"}
  %3: u8* = gaddr {sym="gOut"}
  %4: s32 = load %2 {off=0, signed=false, width=1}
  %5: u32 = icmp_eq %0, %4
  cond_br %5, ^bb7(), ^bb1()
^bb1():
  %6: s32 = load %2 {off=1, signed=false, width=1}
  %7: u32 = icmp_eq %0, %6
  cond_br %7, ^bb6(%1), ^bb2()
^bb2():
  br ^bb3(%1) {fallthrough=true}
^bb3(%8: s32):
  %9: s32 = const {value=1}
  %10: s32 = add %8, %9
  %11: u32 = zext %10 {width=8}
  %12: u32 = const {value=2}
  %13: u32 = icmp_ugt %11, %12
  cond_br %13, ^bb6(%11), ^bb4()
^bb4():
  %14: s32 = shl %11 {imm=2}
  %15: u8* = add %14, %2
  %16: s32 = load %15 {off=0, signed=false, width=1}
  %17: u32 = icmp_eq %0, %16
  cond_br %17, ^bb7(), ^bb5()
^bb5():
  %18: s32 = load %15 {off=1, signed=false, width=1}
  %19: u32 = icmp_ne %0, %18
  cond_br %19, ^bb3(%11), ^bb6(%11)
^bb6(%20: s32):
  %21: s32 = shl %20 {imm=2}
  %22: u8* = add %21, %2
  %23: s32 = load %22 {off=0, signed=false, width=1}
  %24: u32 = icmp_ne %0, %23
  cond_br %24, ^bb8(), ^bb7()
^bb7():
  %25: s32 = const {value=1}
  br ^bb9(%25)
^bb8():
  %26: s32 = const {value=2}
  br ^bb9(%26) {fallthrough=true}
^bb9(%27: s32):
  store %3, %27 {off=0, width=1}
  ret
}`;

/** The gcc2.7.2kmc shape: the threaded exit lands on the JOIN past the THEN arm bb7, carrying the
 *  arm's `1` (MIPS moves the arm's `li v0,1` into the branch's delay slot). A loop whose exits hand
 *  the re-test one counter, so the args are defined. */
const KMC = `fn thrk {
^bb0(%0: s32):
  %1: u8* = gaddr {sym="gTbl"}
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = const {value=3}
  %5: u32 = icmp_slt %3, %4
  cond_br %5, ^bb2(), ^bb4(%3)
^bb2():
  %6: s32 = shl %3 {imm=2}
  %7: u8* = add %6, %1
  %8: s32 = load %7 {off=0, signed=false, width=1}
  %9: u32 = icmp_eq %0, %8
  %10: s32 = const {value=1}
  cond_br %9, ^bb6(%10), ^bb3()
^bb3():
  %11: s32 = load %7 {off=1, signed=false, width=1}
  %12: u32 = icmp_eq %0, %11
  cond_br %12, ^bb4(%3), ^bb5()
^bb5():
  %13: s32 = const {value=1}
  %14: s32 = add %3, %13
  br ^bb1(%14)
^bb4(%15: s32):
  %16: s32 = shl %15 {imm=2}
  %17: u8* = add %16, %1
  %18: s32 = load %17 {off=0, signed=false, width=1}
  %19: u32 = icmp_ne %0, %18
  %20: s32 = const {value=2}
  cond_br %19, ^bb6(%20), ^bb7()
^bb7():
  %21: s32 = const {value=1}
  br ^bb6(%21) {fallthrough=true}
^bb6(%22: s32):
  %23: u8* = gaddr {sym="gOut"}
  store %23, %22 {off=0, width=1}
  ret
}`;

/** gcc2.7.2kmc's pointer walk `for (p = t; p < t + 3; p++) if (x == p->a || x == p->b) break;
 *  if (x == p->a) gOut = 1; else gOut = 2;`, bottom-tested: the latch hands the re-test bb4 the
 *  stepped pointer %13 and the in-body exit hands it %5, the pointer bb1's threaded exit reads. */
const KMC_WALK = `fn walk {
^bb0(%0: s32):
  %1: u8* = gaddr {sym="gTbl"}
  %2: s32 = const {value=12}
  %3: u8* = add %1, %2
  %4: u32 = icmp_ult %1, %3
  cond_br %4, ^bb1(%1), ^bb4(%1)
^bb1(%5: u8*):
  %6: u32 = zext %0 {width=8}
  %7: s32 = load %5 {off=0, signed=false, width=1}
  %8: u32 = icmp_eq %6, %7
  %9: s32 = const {value=1}
  cond_br %8, ^bb6(%9), ^bb2()
^bb2():
  %10: s32 = load %5 {off=1, signed=false, width=1}
  %11: u32 = icmp_eq %6, %10
  cond_br %11, ^bb4(%5), ^bb3()
^bb3():
  %12: s32 = const {value=4}
  %13: u8* = add %5, %12
  %14: u32 = icmp_ult %13, %3
  cond_br %14, ^bb1(%13), ^bb4(%13)
^bb4(%15: u8*):
  %16: s32 = load %15 {off=0, signed=false, width=1}
  %17: u32 = zext %0 {width=8}
  %18: u32 = icmp_ne %17, %16
  %19: s32 = const {value=2}
  cond_br %18, ^bb6(%19), ^bb5()
^bb5():
  %20: s32 = const {value=1}
  br ^bb6(%20)
^bb6(%21: s32):
  %22: u8* = gaddr {sym="gOut"}
  store %22, %21 {off=0, width=1}
  ret
}`;

/** gcc2.7.2 -O1's thrwalk: as KMC_WALK, but each exit re-masks `x` on its own block (bb5 is the
 *  latch fall-through and the `beql` delay slot merged), so bb5, the loop's other exit target, only
 *  forwards to the re-test bb6, which the loop's guard enters as well. bb5 is dominated by bb3, the
 *  in-body exit's block, which does not dominate the threaded exit bb2. */
const GCC272_WALK = `fn walk {
^bb0(%0: s32):
  %1: u8* = gaddr {sym="gTbl"}
  %2: s32 = const {value=12}
  %3: u8* = add %1, %2
  %4: u32 = icmp_uge %1, %3
  %5: s32 = const {value=255}
  %6: s32 = and %0, %5
  cond_br %4, ^bb6(%1, %6), ^bb1()
^bb1():
  %7: s32 = const {value=255}
  %8: s32 = and %0, %7
  br ^bb2(%1)
^bb2(%11: u8*):
  %12: s32 = load %11 {off=0, signed=false, width=1}
  %13: u32 = icmp_eq %8, %12
  %14: s32 = const {value=1}
  cond_br %13, ^bb8(%14), ^bb3()
^bb3():
  %15: s32 = load %11 {off=1, signed=false, width=1}
  %16: u32 = icmp_eq %8, %15
  cond_br %16, ^bb5(%11), ^bb4()
^bb4():
  %17: s32 = const {value=4}
  %18: u8* = add %11, %17
  %19: u32 = icmp_ult %18, %3
  cond_br %19, ^bb2(%18), ^bb5(%18)
^bb5(%20: u8*):
  %21: s32 = const {value=255}
  %22: s32 = and %0, %21
  br ^bb6(%20, %22)
^bb6(%23: u8*, %24: s32):
  %25: s32 = load %23 {off=0, signed=false, width=1}
  %26: u32 = icmp_ne %24, %25
  %27: s32 = const {value=2}
  cond_br %26, ^bb8(%27), ^bb7()
^bb7():
  %28: s32 = const {value=1}
  br ^bb8(%28)
^bb8(%29: s32):
  %30: u8* = gaddr {sym="gOut"}
  store %30, %29 {off=0, width=1}
  ret
}`;

describe('a threaded loop exit goes back to the re-test it skipped', () => {
  test('agbcc: the exit lands on the THEN arm the re-test falls into', () => {
    const { n, fn, before } = folded(AGBCC);
    expect(n).toBe(1);
    verify(fn);
    const bb4 = fn.blocks[4];
    expect(bb4.ops[bb4.ops.length - 1].successors[0].block).toBe(fn.blocks[6]);
    expect(disagreements(before, fn)).toBe(0);
    // and the loop now has one way out, which loop recovery spells
    const src = cBackend.emit(structure(fn));
    expect(src).toContain('break;');
    expect(src).toContain('gOut = ');
  });

  test('gcc2.7.2kmc: the exit lands on the join past the THEN arm, carrying the arm’s value', () => {
    const { n, fn, before } = folded(KMC);
    expect(n).toBe(1);
    verify(fn);
    const bb2 = fn.blocks[2];
    const edge = bb2.ops[bb2.ops.length - 1].successors[0];
    expect(edge.block).toBe(fn.blocks[5]); // ^bb4, the re-test
    // every edge into the re-test now hands it the header's counter, so its param folds away
    expect(fn.blocks[5].params).toEqual([]);
    expect(disagreements(before, fn)).toBe(0);
    expect(() => structure(fn)).not.toThrow();
  });

  test('gcc2.7.2kmc pointer walk: the exit hands the re-test the pointer it read, not the latch’s stepped one', () => {
    const { n, fn, before } = folded(KMC_WALK);
    expect(n).toBe(1);
    verify(fn);
    const edge = fn.blocks[1].ops[fn.blocks[1].ops.length - 1].successors[0];
    expect(edge.block).toBe(fn.blocks[4]);
    expect(edge.args).toEqual([fn.blocks[1].params[0]]);
    expect(disagreements(before, fn)).toBe(0);
    expect(cBackend.emit(structure(fn))).toContain('break;');
  });

  test('gcc2.7.2kmc pointer walk with the step in the exit’s delay slot: of two pointers defined at the exit, the one the re-test decides on', () => {
    // kmc -O2 on `if (x == p->b || x == p->a) break;` threads `beq a1,v0,L` with `addiu v1,v1,4` in its
    // delay slot, so the stepped pointer %13 is defined in the exit block too: the latch hands the
    // re-test %13 and the in-body exit %5, both defined at bb1
    const ir = edit(
      KMC_WALK,
      [
        '  %9: s32 = const {value=1}\n',
        '  %9: s32 = const {value=1}\n  %12: s32 = const {value=4}\n  %13: u8* = add %5, %12\n',
      ],
      ['^bb3():\n  %12: s32 = const {value=4}\n  %13: u8* = add %5, %12\n', '^bb3():\n'],
    );
    const { n, fn, before } = folded(ir);
    expect(n).toBe(1);
    verify(fn);
    const edge = fn.blocks[1].ops[fn.blocks[1].ops.length - 1].successors[0];
    expect(edge.block).toBe(fn.blocks[4]);
    expect(edge.args).toEqual([fn.blocks[1].params[0]]);
    expect(disagreements(before, fn)).toBe(0);
    expect(cBackend.emit(structure(fn))).toContain('break;');
  });

  test('gcc2.7.2 pointer walk: the exit lands on the block that forwards to the re-test', () => {
    const { n, fn, before } = folded(GCC272_WALK);
    expect(n).toBe(1);
    verify(fn);
    const edge = fn.blocks[2].ops[fn.blocks[2].ops.length - 1].successors[0];
    expect(edge.block).toBe(fn.blocks[5]);
    expect(edge.args).toEqual([fn.blocks[2].params[0]]);
    expect(disagreements(before, fn)).toBe(0);
    expect(cBackend.emit(structure(fn))).toContain('break;');
  });

  test('the fold runs in the pre-structure record, ahead of the re-roll', () => {
    const ids = PRE_STRUCTURE_FOLDS.map((f) => f.id);
    expect(ids.indexOf('unthread')).toBeGreaterThan(ids.indexOf('trampoline'));
    expect(ids.indexOf('unthread')).toBeLessThan(ids.indexOf('reroll'));
  });
});

/** `ir` edited by each `[from, to]` replacement, each of which must apply. */
const edit = (ir: string, ...subs: [string, string][]): string =>
  subs.reduce((s, [a, b]) => {
    expect(s).toContain(a);
    return s.replace(a, b);
  }, ir);

/** Refused as given, and with `gate` ablated the fold fires and changes the program. */
function refusedBy(ir: string, gate: string): void {
  const kept = folded(ir);
  expect(kept.n).toBe(0);
  expect(disagreements(kept.before, kept.fn)).toBe(0);
  const ablated = folded(ir, without(UNTHREAD_GATES, gate));
  expect(ablated.n).toBeGreaterThan(0);
  let wrong: boolean;
  try {
    verify(ablated.fn);
    wrong = disagreements(ablated.before, ablated.fn) > 0;
  } catch {
    wrong = true; // a value used where it is not defined: the ablated rewrite is not a program
  }
  expect(wrong).toBe(true);
}

describe('refusals', () => {
  test('a re-test block that stores is left alone', () => {
    refusedBy(
      edit(AGBCC, [
        '  %24: u32 = icmp_ne %0, %23\n',
        '  %24: u32 = icmp_ne %0, %23\n  store %3, %23 {off=0, width=1}\n',
      ]),
      'retest-observable',
    );
  });

  test('a re-test whose onward block stores is left alone', () => {
    refusedBy(
      edit(KMC, [
        '  %21: s32 = const {value=1}\n',
        '  %21: s32 = const {value=1}\n  store %1, %21 {off=64, width=1}\n',
      ]),
      'retest-observable',
    );
  });

  test('a re-test of another operand is left alone', () => {
    refusedBy(
      edit(AGBCC, [
        '  %23: s32 = load %22 {off=0, signed=false, width=1}',
        '  %23: s32 = load %22 {off=1, signed=false, width=1}',
      ]),
      'test-differs',
    );
  });

  test('a re-test reading memory the exit block writes after its own read is left alone', () => {
    refusedBy(
      edit(AGBCC, [
        '  %17: u32 = icmp_eq %0, %16\n',
        '  %17: u32 = icmp_eq %0, %16\n  %90: s32 = const {value=9}\n  store %15, %90 {off=0, width=1}\n',
      ]),
      'test-differs',
    );
  });

  test('a re-test whose THEN arm hands the join another value is left alone', () => {
    refusedBy(edit(KMC, ['  %21: s32 = const {value=1}', '  %21: s32 = const {value=3}']), 'onward-differs');
  });

  test('a re-test whose decided edge is the other one is left alone', () => {
    // the THEN arm and the ELSE arm swapped in the re-test: E's sense now decides the `gOut = 2` arm
    refusedBy(edit(AGBCC, ['  cond_br %24, ^bb8(), ^bb7()', '  cond_br %24, ^bb7(), ^bb8()']), 'onward-differs');
  });

  test('a re-test reading a value from a block the exit does not pass is left alone', () => {
    // the exit is the header's own test; the re-test reads an address computed in the block after it
    refusedBy(
      `fn nodom {
^bb0(%0: s32):
  %1: u8* = gaddr {sym="gTbl"}
  %2: s32 = const {value=0}
  br ^bb1(%2)
^bb1(%3: s32):
  %4: s32 = shl %3 {imm=2}
  %5: u8* = add %4, %1
  %6: s32 = load %5 {off=0, signed=false, width=1}
  %7: u32 = icmp_eq %0, %6
  cond_br %7, ^bb5(), ^bb2()
^bb2():
  %8: s32 = shl %3 {imm=2}
  %9: u8* = add %8, %1
  %10: s32 = load %9 {off=1, signed=false, width=1}
  %11: u32 = icmp_eq %0, %10
  cond_br %11, ^bb4(), ^bb3()
^bb3():
  %12: s32 = const {value=1}
  %13: s32 = add %3, %12
  %14: s32 = const {value=3}
  %15: u32 = icmp_slt %13, %14
  cond_br %15, ^bb1(%13), ^bb4()
^bb4():
  %16: s32 = load %9 {off=0, signed=false, width=1}
  %17: u32 = icmp_ne %0, %16
  cond_br %17, ^bb6(), ^bb5()
^bb5():
  %18: s32 = const {value=1}
  br ^bb7(%18)
^bb6():
  %19: s32 = const {value=2}
  br ^bb7(%19)
^bb7(%20: s32):
  %21: u8* = gaddr {sym="gOut"}
  store %21, %20 {off=0, width=1}
  ret
}`,
      'not-dominated',
    );
  });

  test('a re-test param the loop hands two values takes the one the comparison decides', () => {
    // bb3's exit hands the constant 0 and bb1's the counter: both are defined at bb2, and only the
    // counter makes the re-test read what the exit read. Not a refusal: each candidate is judged.
    const { n, fn, before } = folded(edit(KMC, ['  cond_br %12, ^bb4(%3), ^bb5()', '  cond_br %12, ^bb4(%2), ^bb5()']));
    expect(n).toBe(1);
    verify(fn);
    expect(disagreements(before, fn)).toBe(0);
  });

  test('a re-test param whose only value defined at the exit is another pointer is left alone', () => {
    // bb2's exit hands the walk's base pointer instead of the current one, and the latch's stepped
    // pointer is not defined at bb1: the one candidate makes the re-test read another cell
    refusedBy(edit(KMC_WALK, ['  cond_br %11, ^bb4(%5), ^bb3()', '  cond_br %11, ^bb4(%1), ^bb3()']), 'test-differs');
  });

  test('a forwarder handing the re-test a value from the in-body exit’s block is left alone', () => {
    // bb5 forwards `x & 0xff` as bb3 computed it: bb3 dominates bb5 but not the threaded exit bb2
    refusedBy(
      edit(
        GCC272_WALK,
        ['  %15: s32 = load %11', '  %40: s32 = and %0, %7\n  %15: s32 = load %11'],
        ['  br ^bb6(%20, %22)', '  br ^bb6(%20, %40)'],
      ),
      'not-dominated',
    );
  });

  test('a forwarder that stores is left alone', () => {
    refusedBy(
      edit(GCC272_WALK, ['  br ^bb6(%20, %22)', '  store %20, %21 {off=0, width=1}\n  br ^bb6(%20, %22)']),
      'retest-observable',
    );
  });

  test('a re-test block ending in an unconditional branch is left alone', () => {
    const { n } = folded(edit(AGBCC, ['  cond_br %24, ^bb8(), ^bb7()', '  br ^bb8()']));
    expect(n).toBe(0);
  });

  test('an exit target another exit edge also reaches is left alone', () => {
    const ir = edit(AGBCC, ['  cond_br %19, ^bb3(%11), ^bb6(%11)', '  cond_br %19, ^bb3(%11), ^bb7()']);
    expect(folded(ir).n).toBe(0);
    expect(folded(ir, without(UNTHREAD_GATES, 'target-shared')).n).toBeGreaterThan(0);
  });

  test('an exit target that only returns is left alone', () => {
    const ir = edit(AGBCC, ['  %25: s32 = const {value=1}\n  br ^bb9(%25)', '  %25: s32 = const {value=1}\n  ret']);
    expect(folded(ir).n).toBe(0);
    expect(folded(ir, without(UNTHREAD_GATES, 'target-returns')).n).toBeGreaterThan(0);
  });
});
