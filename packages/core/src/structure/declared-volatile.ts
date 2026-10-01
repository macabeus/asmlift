// asmlift — the decider for ir/discipline.ts's `declared` placement: a memory read of an object the
// project's symbol map declares volatile.
//
// The stamp is a function of the IR and the map structuring is handed, and nothing else: a read
// whose base reaches a global the map qualifies, at the byte the access names (`declaresVolatile`).
// Structuring the same function under another map — the `/raw-globals` setting has none — re-runs
// it, and an op the new map does not qualify loses the stamp, so a structuring never answers for a
// map it was not given. A base that reaches no name is a pointer parameter or a raw address: no
// declaration is in evidence, and the read stays unplaced unless the lift pinned it (`device`).
import { globalBaseOf, globalCellOf } from '../ir/alias';
import { type Fn, defOpMap } from '../ir/core';
import { DECLARED_VOLATILE } from '../ir/discipline';
import { type SymbolInfo, declaresVolatile } from '../symbols';

/** Stamp every `load`/`aload` of `fn` that reads an object `symbols` declares volatile, and clear
 *  the stamp from every other op. */
export function stampDeclaredVolatile(fn: Fn, symbols: ReadonlyMap<string, SymbolInfo> | undefined): void {
  const defs = symbols ? defOpMap(fn) : undefined;
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      const read = op.opcode === 'load' || op.opcode === 'aload';
      const base = defs && read ? globalBaseOf(defs, op.operands[0]) : null;
      // A subscript reaches the object while naming no cell, so only a `load` asks by byte.
      const cell =
        base !== null && op.opcode === 'load' ? globalCellOf(defs!, op.operands[0], op.attrs.off as number) : null;
      const declared = base !== null && declaresVolatile(symbols!.get(base), cell === null ? null : cell.byte);
      // A fresh record either way: a rebuilder may hand two ops one `attrs` object.
      if (declared && op.attrs[DECLARED_VOLATILE] !== true) {
        op.attrs = { ...op.attrs, [DECLARED_VOLATILE]: true };
      } else if (!declared && DECLARED_VOLATILE in op.attrs) {
        const { [DECLARED_VOLATILE]: _, ...rest } = op.attrs;
        op.attrs = rest;
      }
    }
  }
}
