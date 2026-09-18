// `return;` spelling (l3/tailret.ts + its frontend stamp): asmlift emits a void `return` only
// where the assembly shows one.
//
// A source `return;` is a control transfer to the epilogue and a compiler spells it as
// `b <epilogue>`. Where the epilogue is a block of its own, its in-edges ARE the ways the body
// ends, so the asm decides: FALLING into the epilogue is the body running out and spells nothing,
// which settles the statement at the end of the body; with no such edge, an unconditional branch
// into it is a `return;` the source wrote. The unoptimised object is where that distinction costs
// bytes — every `return;` is its own branch there — and it is exactly where reading the asm gets
// it right. The reading itself is `structure/retspell.ts`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { parse } from '../src/ir/parse';
import { T } from '../src/ir/types';
import type { SFn, Stmt } from '../src/l3/ast';
import { dropUnspelledReturns } from '../src/l3/tailret';
import { decompile } from '../src/pipeline';
import { unspelledEpilogues } from '../src/structure/retspell';
import { ARMV4T_AGBCC, MIPS_GCC, PPC_MWCC } from '../src/target';

const read = (f: string) => readFileSync(join(import.meta.dirname, 'corpus', f), 'utf8');
const O0 = read('agbcc-retspell-O0.s');
const O2 = read('agbcc-retspell-O2.s');

const lift = (name: string, asm: string) =>
  decompile(name, asm, ARMV4T_AGBCC, { prototypes: { [name]: { returnsVoid: true } } }).source;

const asg = (name: string): Stmt => ({ k: 'assign', name, value: { k: 'const', value: 1 } });
const unspelled = (): Stmt => ({ k: 'return', unspelled: true });
const iff = (then: Stmt[], els: Stmt[]): Stmt => ({ k: 'if', cond: { k: 'const', value: 1 }, then, else: els });
const fn = (body: Stmt[]): SFn => ({ name: 'f', params: [], locals: [], retType: T.void(), body });
const kinds = (b: Stmt[]): string[] => b.map((s) => s.k);

describe('the asm decides which returns exist', () => {
  test('an epilogue reached only by falling into it spells no return', () => {
    expect(lift('retflat', O0)).toBe(['void retflat(void) {', '    *(s32 *)50345024 = 3;', '}', ''].join('\n'));
  });

  test('an epilogue a path FALLS into spells no return, though another path branches in', () => {
    // `retjoin`'s `if`/`else` join sits ON the epilogue: the `then` arm branches there and the
    // `else` arm falls in. The falling edge is the body running out, so the statement at the end of
    // the body is not in the object — and its source wrote no `return;`. The branch is a `return;`
    // too, but it ends an arm the compiler must branch over either way, so the `}` spells it.
    expect(lift('retjoin', O0)).not.toContain('return');
  });

  test('a branch out of an EMPTY arm keeps the return — it is the only statement that arm has', () => {
    // `retearly` is `if (gFlag & 1) return; *gOutA = 3;`. Its `b .L5` leaves a block with nothing
    // else in it, so the `return;` it stands for has nowhere else to live: emptying that arm needs
    // a branch-sense flip, and the object keeps the branch either way. The fall-through from the
    // store block does not overrule it.
    expect(lift('retearly', O0)).toContain('return;');
  });

  test('an optimised epilogue reached by a conditional branch and a fall-through spells none', () => {
    // agbcc -O2: `beq .L3` skips the if body and `.L6` falls into `.L3` — neither is a source
    // `return;`, and armshare's source indeed has none. Both redundant spellings go.
    const src = lift('armshare', O2);
    expect(src).not.toContain('return');
    // The one `else` left is the source's own inner arm; the outer `else { return; }` is gone.
    expect(src.match(/else/g)).toHaveLength(1);
  });
});

describe('what the pass may drop', () => {
  test('a trailing unspelled return goes', () => {
    expect(kinds(dropUnspelledReturns(fn([asg('v0'), unspelled()])).body)).toEqual(['assign']);
  });

  test('a return the asm branched to stays', () => {
    expect(kinds(dropUnspelledReturns(fn([asg('v0'), { k: 'return' }])).body)).toEqual(['assign', 'return']);
  });

  test('a value-carrying return stays', () => {
    const ret: Stmt = { k: 'return', value: { k: 'const', value: 0 }, unspelled: true };
    expect(kinds(dropUnspelledReturns(fn([asg('v0'), ret])).body)).toEqual(['assign', 'return']);
  });

  test('a return that is not in tail position stays — dropping it would fall into what follows', () => {
    const out = dropUnspelledReturns(fn([iff([asg('v0'), unspelled()], []), asg('v1')]));
    expect(kinds((out.body[0] as Extract<Stmt, { k: 'if' }>).then)).toEqual(['assign', 'return']);
  });

  test('a return inside a loop stays — dropping it would keep looping', () => {
    const loop: Stmt = { k: 'while', cond: { k: 'const', value: 1 }, body: [asg('v0'), unspelled()] };
    const out = dropUnspelledReturns(fn([loop]));
    expect(kinds((out.body[0] as Extract<Stmt, { k: 'while' }>).body)).toEqual(['assign', 'return']);
  });

  test('a return ending a switch arm stays — dropping it would fall into the next case', () => {
    const sw: Stmt = {
      k: 'switch',
      scrutinee: { k: 'const', value: 1 },
      cases: [
        { values: [0], body: [asg('v0'), unspelled()], fallsThrough: false },
        { values: [1], body: [asg('v1')], fallsThrough: false },
      ],
    };
    const out = dropUnspelledReturns(fn([sw]));
    expect(kinds((out.body[0] as Extract<Stmt, { k: 'switch' }>).cases[0].body)).toEqual(['assign', 'return']);
  });

  test('a lone return in an `else` arm goes, and the arm with it', () => {
    const out = dropUnspelledReturns(fn([iff([asg('v0'), unspelled()], [unspelled()])]));
    const s = out.body[0] as Extract<Stmt, { k: 'if' }>;
    expect(kinds(s.then)).toEqual(['assign']);
    expect(s.else).toEqual([]);
  });

  test('a lone return in a `then` arm stays — emptying it needs a branch-sense flip nothing here can decide', () => {
    const out = dropUnspelledReturns(fn([asg('v0'), iff([unspelled()], [])]));
    expect(kinds((out.body[1] as Extract<Stmt, { k: 'if' }>).then)).toEqual(['return']);
  });

  test('a body that is nothing but a return stays — a function needs a statement to be one', () => {
    expect(kinds(dropUnspelledReturns(fn([unspelled()])).body)).toEqual(['return']);
  });
});

describe('the stamp the reading rests on, per ISA', () => {
  // `structure/retspell.ts` can only tell a written `b` from layout because the FRONTEND says so:
  // a `br` that stands for the machine running into the next block carries `attrs.fallthrough`, a
  // real branch instruction does not. Each ISA sets it in its own frontend, so each owes a case —
  // the same `if`/`else` join over a void tail as `retjoin`, hand-authored per ISA. Without the
  // stamp the falling edge reads as a branch and a `return;` comes back.
  test('MIPS: the falling edge of an if/else join is not a return', () => {
    const asm =
      '00000000 <mjoin>:\n' +
      '   0:\tbeqz\ta0,14 <mjoin+0x14>\n   4:\tnop\n' +
      '   8:\tli\tv0,3\n   c:\tb\t1c <mjoin+0x1c>\n  10:\tsw\tv0,0(a1)\n' +
      '  14:\tli\tv0,4\n  18:\tsw\tv0,4(a1)\n' +
      '  1c:\tjr\tra\n  20:\tnop\n';
    const src = decompile('mjoin', asm, MIPS_GCC, { prototypes: { mjoin: { returnsVoid: true } } }).source;
    expect(src).not.toContain('return');
  });

  test('PowerPC: the falling edge of an if/else join is not a return', () => {
    const asm =
      '0 <pjoin>:\n' +
      '0:\tcmpwi   r3,0\n4:\tbeq     14 <pjoin+0x14>\n' +
      '8:\tli      r0,3\nc:\tstw     r0,0(r4)\n10:\tb       1c <pjoin+0x1c>\n' +
      '14:\tli      r0,4\n18:\tstw     r0,4(r4)\n' +
      '1c:\tblr\n';
    const src = decompile('pjoin', asm, PPC_MWCC, { prototypes: { pjoin: { returnsVoid: true } } }).source;
    expect(src).not.toContain('return');
  });
});

describe('what the reading refuses to answer', () => {
  /** `ir` with `^bb0`'s `br` stamped as layout fall-through; how many epilogues come back marked. */
  const marked = (ir: string): number => {
    const fn = parse(ir);
    fn.blocks[0].ops[fn.blocks[0].ops.length - 1].attrs.fallthrough = true;
    const set = unspelledEpilogues(fn);
    return fn.blocks.filter((b) => set.has(b)).length;
  };

  const FALL_INTO_RET = `fn f {
^bb0(%0: s32*):
  br ^bb1()
^bb1():
  ret
}
`;

  test('a fall-through out of an UNREACHABLE block is not evidence — no execution takes it', () => {
    // The thumb frontend keeps unreachable blocks on purpose. One laid out just before the epilogue
    // hands it a fall-through in-edge the machine never uses, and the only real arrival here is
    // `^bb0`'s written branch: a `return;` the source wrote.
    const fn = parse(`fn f {
^bb0(%0: s32*):
  %1: s32 = const {value=1}
  store %0, %1 {off=0, width=4}
  br ^bb2()
^bb1():
  %2: s32 = const {value=7}
  br ^bb2()
^bb2():
  ret
}
`);
    fn.blocks[1].ops[fn.blocks[1].ops.length - 1].attrs.fallthrough = true;
    expect(unspelledEpilogues(fn).size).toBe(0);
  });

  test('an epilogue that also holds STATEMENTS is not asked at all', () => {
    // Its in-edges answer how control reached those statements, not how it reached the epilogue,
    // so a fall-through into it is no evidence about a `return;`. The bare block is the control:
    // same edge, same stamp, and it IS asked.
    expect(marked(FALL_INTO_RET)).toBe(1);
    expect(
      marked(
        FALL_INTO_RET.replace(
          '^bb1():\n  ret',
          '^bb1():\n  %1: s32 = const {value=1}\n  store %0, %1 {off=0, width=4}\n  ret',
        ),
      ),
    ).toBe(0);
  });
});
