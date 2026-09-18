// `return;` spelling (l3/tailret.ts + its frontend stamp): asmlift emits a void `return` only
// where the assembly shows one.
//
// A source `return;` is a control transfer to the epilogue and a compiler spells it as
// `b <epilogue>`. Where the epilogue is a block of its own, its in-edges ARE the function's return
// transfers, so the asm decides: an unconditional branch into it is a `return;` the source wrote,
// falling into it is not, and a conditional branch's own edge is not. The unoptimised object is
// where that distinction costs bytes — every `return;` is its own branch there — and it is exactly
// where reading the asm gets it right.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { T } from '../src/ir/types';
import type { SFn, Stmt } from '../src/l3/ast';
import { dropUnspelledReturns } from '../src/l3/tailret';
import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

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

  test('an epilogue some path BRANCHES to keeps its return', () => {
    // `b .L5` is a `return;` the source wrote; the fall-through from the store block is not. The
    // two disagree, so the block-level reading keeps the return rather than guessing per path.
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
