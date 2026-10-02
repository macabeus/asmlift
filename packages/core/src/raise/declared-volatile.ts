// asmlift — the decider for ir/discipline.ts's `declared` placement: a memory access of an object
// the project's symbol map declares volatile.
//
// The stamp is a function of the IR, the map the function is lifted and structured under, and the
// compiler, and nothing else: an access whose base reaches a global the map qualifies, at the byte
// the access names (`declaresVolatile`) — and, for a read, one the compiler could have made of a
// `volatile` (target.ts `readCouldBeVolatile`, which the device pin asks too). It is put as the
// lift is made (pipeline.ts `liftStamped`), before the first pass that asks whether a read may be
// deleted, folded or moved, and re-derived by every pass that changes which object an access names
// and by structuring. Structuring the same function under another map — the `/raw-globals` setting
// has none — re-runs it, and an op the new map does not qualify loses the stamp, so a structuring
// never answers for a map it was not given. The base is read as the structurer will read it: a join
// whose every edge passes one address is that address (`addressThroughJoins`). A base that reaches
// no name is a pointer parameter, a raw address or a genuine join: no declaration is in evidence,
// and the access stays unplaced unless the lift pinned it (`device`).
//
// A read structuring stamps that the earlier stamps left plain was plain to every raising pass, and a
// short-circuit fold may have lifted it out of the arm it ran in. structure.ts declines on such a
// read in a `&&`/`||`'s guarded operand rather than place it.
import { globalBaseOf, globalCellOf } from '../ir/alias';
import { type Fn, type Op, type Value, defOpMap } from '../ir/core';
import { DECLARED_VOLATILE } from '../ir/discipline';
import { MEM_BASE_OPS } from '../ir/opcodes';
import { type SymbolInfo, type SymbolMap, declaresVolatile, symbolsByName } from '../symbols';
import { type TargetDescription, readCouldBeVolatile } from '../target';
import { valueNumberOf } from './gvn';

/** The compiler fact the stamp reads. */
export type StampBehaviors = Pick<TargetDescription['compilerBehaviors'], 'volatileReadsExtendInRegister'>;

/** May this memory access be stamped: a store, or a read the compiler could have made of a
 *  `volatile`? */
const stampable = (op: Op, behaviors: StampBehaviors): boolean =>
  MEM_BASE_OPS.has(op.opcode) &&
  (op.opcode === 'store' || op.opcode === 'astore' || readCouldBeVolatile(behaviors, op));

/** The address a value stands for once `addrnum` (raise/pre-recovery.ts) has run: a block parameter
 *  every in-edge of which, a back edge's self-reference aside, passes one value after numbering
 *  (raise/gvn.ts `valueNumberOf`) is that value, as `simplifyTrivialPhis` collapses it; any other
 *  value stands for itself. Each arm of an `if` loading `&gVolReg` into the register the join reads
 *  is such a parameter, and the stamp is put before that pass, so it reads the base the structurer
 *  will. */
function addressThroughJoins(fn: Fn): (v: Value) => Value {
  const incoming = new Map<Value, Value[]>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      for (const s of op.successors) {
        if (s.block === fn.blocks[0]) {
          continue;
        }
        s.block.params.forEach((param, i) => {
          if (i < s.args.length) {
            (incoming.get(param) ?? incoming.set(param, []).get(param)!).push(s.args[i]);
          }
        });
      }
    }
  }
  const numberOf = valueNumberOf(fn);
  const through = (v: Value, onWalk: Set<Value>): Value | null => {
    const ins = incoming.get(v);
    if (ins === undefined) {
      return v;
    }
    if (onWalk.has(v)) {
      return null;
    }
    onWalk.add(v);
    const each = ins.filter((a) => a !== v).map((a) => through(a, onWalk));
    onWalk.delete(v);
    const first = each[0];
    return first !== undefined && first !== null && each.every((a) => a !== null && numberOf(a) === numberOf(first))
      ? first
      : null;
  };
  return (v) => through(v, new Set()) ?? v;
}

/** Stamp every memory access of `fn` to an object `symbols` declares volatile — a read only where a
 *  compiler behaving as `behaviors` says could have made it of one — and clear the stamp from every
 *  other op. Returns the ops it stamped that were not stamped before. */
export function stampDeclaredVolatile(
  fn: Fn,
  symbols: ReadonlyMap<string, SymbolInfo> | undefined,
  behaviors: StampBehaviors,
): Op[] {
  const added: Op[] = [];
  const defs = symbols ? defOpMap(fn) : undefined;
  const addressOf = symbols ? addressThroughJoins(fn) : undefined;
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      const addr = defs && stampable(op, behaviors) ? addressOf!(op.operands[0]) : undefined;
      const base = addr !== undefined ? globalBaseOf(defs!, addr) : null;
      // A subscript reaches the object while naming no cell, so only a `load`/`store` asks by byte,
      // and an access that names no byte is placed only where every byte it could reach is qualified.
      const cell =
        base !== null && (op.opcode === 'load' || op.opcode === 'store')
          ? globalCellOf(defs!, addr!, op.attrs.off as number)
          : null;
      const declared = base !== null && declaresVolatile(symbols!.get(base), cell === null ? null : cell.byte);
      // A fresh record either way: a rebuilder may hand two ops one `attrs` object.
      if (declared && op.attrs[DECLARED_VOLATILE] !== true) {
        op.attrs = { ...op.attrs, [DECLARED_VOLATILE]: true };
        added.push(op);
      } else if (!declared && DECLARED_VOLATILE in op.attrs) {
        const { [DECLARED_VOLATILE]: _, ...rest } = op.attrs;
        op.attrs = rest;
      }
    }
  }
  return added;
}

/** {@link stampDeclaredVolatile} under an address-keyed project map, through the name-keyed view
 *  structuring is handed for the same map (symbols.ts `symbolsByName`), narrowed to the names the
 *  function's own `gaddr`s carry. */
export function stampDeclaredVolatileUnder(fn: Fn, map: SymbolMap | undefined, behaviors: StampBehaviors): void {
  if (map === undefined) {
    stampDeclaredVolatile(fn, undefined, behaviors);
    return;
  }
  const names = new Set<string>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (op.opcode === 'gaddr') {
        names.add(op.attrs.sym as string);
      }
    }
  }
  stampDeclaredVolatile(fn, symbolsByName(map, names), behaviors);
}
