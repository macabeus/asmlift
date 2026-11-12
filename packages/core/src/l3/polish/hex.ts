// Hexadecimal where a literal is BITS, decimal where it is a COUNT: `x & 0x40`, `~0xFF`,
// `0xFF << 8` and `(u16 *)0x4000208`, but `x << 24`, `i < 10` and `a[12]`.
//
// A literal is bits where it is an operand of `&`, `|`, `^` or `~`, the value a shift moves (never
// the count it moves by), or an address (the operand of a cast to a pointer). Every other literal
// keeps its decimal spelling.
//
// THE SAME C TYPE BOTH WAYS, which is the whole condition: a decimal literal that fits `int` is an
// `int`, and so is a hex one; past `INT_MAX` they part (a hex literal turns `unsigned int` where the
// decimal one turns `long` or `unsigned long` by dialect), and that can move the type of the whole
// expression. So only 10..0x7FFFFFFF is spelled hex: a negative literal, and one past `INT_MAX`,
// keep the decimal spelling, and one under 10 reads the same either way. Lower-case digits, as the
// printer's initializers spell theirs (cfamily.ts `initNumber`).
import type { Expr, SFn } from '../ast';
import { mapFnExprs } from './walk';

const BITWISE = new Set(['&', '|', '^']);
const SHIFT = new Set(['<<', '>>', '>>>']);

const asHex = (e: Expr): Expr =>
  e.k === 'const' && Number.isInteger(e.value) && e.value >= 10 && e.value <= 0x7fffffff ? { ...e, hex: true } : e;

export function hexBitLiterals(fn: SFn): SFn {
  return mapFnExprs(fn, (e) => {
    if (e.k === 'bin' && BITWISE.has(e.op)) {
      return { ...e, l: asHex(e.l), r: asHex(e.r) };
    }
    if (e.k === 'bin' && SHIFT.has(e.op)) {
      return { ...e, l: asHex(e.l) };
    }
    if (e.k === 'un' && e.op === '~') {
      return { ...e, e: asHex(e.e) };
    }
    if (e.k === 'cast' && e.to.kind === 'ptr') {
      return { ...e, e: asHex(e.e) };
    }
    // a literal base is an address the printer casts to the access's pointer (`legalizedIndexBase`)
    if (e.k === 'index') {
      return { ...e, base: asHex(e.base) };
    }
    return e;
  });
}
