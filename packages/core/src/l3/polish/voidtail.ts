// The tail of a `void` function, as a reader writes it: no `return;` as its last statement.
//
// THE SAME PROGRAM: control that reaches the end of a `void` function returns, so a `return;` there
// is the end itself. The SAME CODE only where the compiler has no other jump to the epilogue to lay
// out against it, and only where it optimizes jumps.
//
// At -O0, agbcc, IDO 7.1, gcc 2.7.2 and KMC gcc compile a trailing `return;` as an explicit branch
// to the epilogue (`void f(s32 a){ if (a) j(); k(a); return; }`, and the same with an early
// `return;` in the arm), and its absence as falling into it. That branch is the evidence
// `structure/retspell.ts` reads to decide that the source WROTE the `return;`, so at such a level
// (`PolishFacts.literal`) the draft's trailing return is the asm's own answer and this pass stands
// down.
//
// At an optimizing level the two compile alike while the trailing `return;` is the body's ONLY
// return: twelve shapes (an if, an if/else, an else-if chain, a while with a break, a do/while, a
// for with a continue, a switch with and without a default, nested ifs, each with and without the
// trailing `return;`) compiled to identical .text and relocations on agbcc -O1/-O2, IDO -O2, gcc
// 2.7.2 and KMC gcc -O1/-O2 and mwcc 2.4.2 -O4,p. Not once another `return;` leaves early: gcc's jump
// optimization lays the blocks out by the returns it is given, and `if (a > 3) { j(); } else if (a)
// { m(a); return; } k(a); return;` and its twin without the last `return;` differ on agbcc -O1 and
// -O2 and on gcc 2.7.2 and KMC gcc -O1 and -O2 (`if (a) { j(); } else { m(a); return; } k(a);` on
// agbcc -O1 and both gcc 2.7.2 builds at -O1 and -O2), the same on IDO -O2 and mwcc -O4,p. So the
// pass fires only on a body whose trailing `return;` is its one `return` (the synthetic row `vtailret`
// pins the other case on agbcc and both gcc 2.7.2 builds).
//
// NOT ALSO `return;` → `break;` in a switch that ends the function, which reads as the same program
// and is not the same tree to two compilers: mwcc 2.4.2 build 81 (`synthetic:cwret_g17`,
// `synthetic:cwret_g125`) and IDO 7.1 (`synthetic:sw_void`) lost their matches with the arms left by
// `break`, and `synthetic:sw_defmid:ido7.1` moved the other way (full bench, 2026-11-12). Without
// that conversion a `default:` that only leaves does not arise, so there is none to drop.
import type { PolishFacts } from '.';
import { T, typeEquals } from '../../ir/types';
import { type SFn, type Stmt, stmtChildren } from '../ast';

/** Does any statement of `list`, at any depth, return? */
function holdsReturn(list: readonly Stmt[]): boolean {
  return list.some((s) => s.k === 'return' || holdsReturn(stmtChildren(s)));
}

export function voidTail(fn: SFn, facts: PolishFacts): SFn {
  const last = fn.body[fn.body.length - 1];
  return !facts.literal &&
    typeEquals(fn.retType, T.void()) &&
    last?.k === 'return' &&
    last.value === undefined &&
    !holdsReturn(fn.body.slice(0, -1))
    ? { ...fn, body: fn.body.slice(0, -1) }
    : fn;
}
