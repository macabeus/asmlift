// asmlift structurer — the IR's integer arithmetic opcodes and the L3 operator each one renders
// as. The float ops are FLOAT_TO_BIN in structure.ts, which says why they are not here.
import type { BinOp } from '../l3/ast';

export const ARITH_TO_BIN: Record<string, BinOp> = {
  add: '+',
  sub: '-',
  mul: '*',
  sdiv: '/',
  // the UNSIGNED quotient/remainder — the C backend spells them `/`/`%` over an operand it casts
  // unsigned (l3/ast.ts BinOp, backend/cfamily.ts C_SPELLING)
  udiv: '/u',
  smod: '%',
  umod: '%u',
  or: '|',
  and: '&',
  xor: '^',
  shl: '<<',
  shr_u: '>>>', // the LOGICAL right shift; the C backend spells it `>>` over an unsigned operand
  shr_s: '>>',
  logic_and: '&&',
  logic_or: '||', // short-circuit connectives (raise/shortcircuit.ts)
};
