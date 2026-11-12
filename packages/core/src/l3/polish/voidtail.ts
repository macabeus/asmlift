// The tail of a `void` function, as a reader writes it: no `return;` as its last statement.
//
// THE SAME PROGRAM, and the same code on every compiler the bench covers: control that reaches the
// end of a `void` function returns, so a `return;` there is the end itself.
//
// NOT ALSO `return;` → `break;` in a switch that ends the function, which reads as the same program
// and is not the same tree to two compilers: mwcc 2.4.2 build 81 (`synthetic:cwret_g17`,
// `synthetic:cwret_g125`) and IDO 7.1 (`synthetic:sw_void`) lost their matches with the arms left by
// `break`, and `synthetic:sw_defmid:ido7.1` moved the other way (full bench, 2026-11-12). With the
// conversion gone, a `default:` that only leaves never arises, so there is none to drop.
import { T, typeEquals } from '../../ir/types';
import type { SFn } from '../ast';

export function voidTail(fn: SFn): SFn {
  const last = fn.body[fn.body.length - 1];
  return typeEquals(fn.retType, T.void()) && last?.k === 'return' && last.value === undefined
    ? { ...fn, body: fn.body.slice(0, -1) }
    : fn;
}
