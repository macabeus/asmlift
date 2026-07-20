// asmlift — the shared per-block IR emitter kit for the MIPS and PPC decode loops. Bound per
// block (the `ops` array and `write` are block-scoped); the ISA-specific readers/guards
// (sp-as-data, frame transparency) stay in the frontends.
import { Op, Successor, Value, mkOp, mkValue } from '../ir/core';
import type { Opcode } from '../ir/opcodes';
import { T } from '../ir/types';

export interface EmitKit {
  /** a fresh `const` value */
  cnst: (n: number) => Value;
  /** emit `opc` over operands into register `d`; returns the result value */
  emit: (opc: Opcode, d: string, operands: Value[], attrs?: Record<string, number | boolean | string>) => Value;
  bin: (opc: Opcode, d: string, x: Value, y: Value) => Value;
  un: (opc: Opcode, d: string, x: Value) => Value;
  shImm: (opc: Opcode, d: string, x: Value, imm: number) => Value;
  /** emit `opc` into an unwritten temporary (a value feeding a following op, not a register dest) */
  tmp: (opc: Opcode, operands: Value[], attrs?: Record<string, number | boolean | string>) => Value;
}

export function mkEmitKit(ops: Op[], write: (reg: string, v: Value) => void): EmitKit {
  const tmp = (opc: Opcode, operands: Value[], attrs?: Record<string, number | boolean | string>): Value => {
    const v = mkValue(T.unk(32));
    ops.push(mkOp(opc, { operands, results: [v], ...(attrs ? { attrs } : {}) }));
    return v;
  };
  const emit = (
    opc: Opcode,
    d: string,
    operands: Value[],
    attrs?: Record<string, number | boolean | string>,
  ): Value => {
    const res = tmp(opc, operands, attrs);
    write(d, res);
    return res;
  };
  return {
    tmp,
    emit,
    cnst: (n) => tmp('const', [], { value: n }),
    bin: (opc, d, x, y) => emit(opc, d, [x, y]),
    un: (opc, d, x) => emit(opc, d, [x]),
    shImm: (opc, d, x, imm) => emit(opc, d, [x], { imm }),
  };
}

/** Emit a recovered jump-table dispatch: N case successors followed by the default (LAST), with
 *  the dense 0..N-1 `cases` list derived here — the single home of the case/successor
 *  alignment invariant. */
export function pushSwitchBr(ops: Op[], scrut: Value, successors: Successor[]): void {
  ops.push(
    mkOp('switch_br', {
      operands: [scrut],
      successors,
      attrs: { cases: successors.slice(0, -1).map((_, k) => k) },
    }),
  );
}
