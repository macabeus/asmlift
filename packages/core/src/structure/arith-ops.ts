// asmlift structurer — the IR's arithmetic and compare opcodes and the L3 operator each one renders
// as: the integer ops (ARITH_TO_BIN), the float ops (FLOAT_TO_BIN, which says why it is a table of
// its own), the integer and float compares (CMP_TO_BIN, FCMP_TO_BIN), and the operators whose
// operand order the machine does not fix (COMMUTATIVE_BIN).
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

export const CMP_TO_BIN: Record<string, BinOp> = {
  icmp_slt: '<',
  icmp_sle: '<=',
  icmp_sgt: '>',
  icmp_sge: '>=',
  icmp_ult: '<',
  icmp_ule: '<=',
  icmp_ugt: '>',
  icmp_uge: '>=', // unsignedness is in the operand types
  icmp_eq: '==',
  icmp_ne: '!=',
};

// The float ops (ir/opcodes.ts) and their L3 operators (l3/ast.ts BinOp). A table of their own and
// not entries in ARITH_TO_BIN (arith-ops.ts), because every rule that table's consumers apply —
// the pointer stride, the integer legalizations, the constant fold, the commutative re-spelling —
// is an integer rule.
export const FLOAT_TO_BIN: Record<string, BinOp> = { fadd: 'f+', fsub: 'f-', fmul: 'f*', fdiv: 'f/' };

// The float compares (ir/opcodes.ts) and their L3 operators. An ORDERED compare and `fcmp_une` are
// C's relation; an unordered one is the logical NOT of the ordered relation it negates
// (`NEGATED_FCMP`), and is spelled as that `!`, never as the integer negation of the relation.
export const FCMP_TO_BIN: Record<string, BinOp> = {
  fcmp_olt: 'f<',
  fcmp_ole: 'f<=',
  fcmp_ogt: 'f>',
  fcmp_oge: 'f>=',
  fcmp_oeq: 'f==',
  fcmp_une: 'f!=',
};

// The operators whose operand order the machine does not fix — candidates for the def-order
// re-spelling in structure.ts's lowerDef. `&&`/`||` are excluded: short-circuit order IS semantics.
export const COMMUTATIVE_BIN: ReadonlySet<BinOp> = new Set(['+', '*', '&', '|', '^']);
