// asmlift — the decider for ir/discipline.ts's `declared` placement: a memory access of an object
// the project's symbol map, or its declaration context, declares volatile.
//
// The stamp is a function of the IR, the map the function is lifted and structured under, the
// declaration context's globals and the compiler, and nothing else: an access whose base reaches a
// global the map qualifies, at the byte the access names (`declaresVolatile`), or one the context
// declares with a volatile byte and the map does not lay out (`ContextGlobals.volatiles`, which is
// per object, not per byte) — and, for a read, one the compiler could have made of a `volatile`
// (target.ts `readCouldBeVolatile`, which the device pin asks too). It is put as the
// lift is made (pipeline.ts `liftStamped`), before the first pass that asks whether a read may be
// deleted, folded or moved, and re-derived by every pass that changes which object an access names
// and by structuring. Structuring the same function under another map — the `/raw-globals` setting
// has none — re-runs it, and an op the new map does not qualify loses the stamp, so a structuring
// never answers for a map it was not given. The context is not the map: every candidate compiles
// against it whichever names it spells, so it is read in both settings. The base is read as the structurer will read it: a join
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
import type { ContextGlobals } from '../proto-context';
import { type SymbolInfo, type SymbolMap, declaresVolatile, symbolsByName } from '../symbols';
import { type TargetDescription, readCouldBeVolatile } from '../target';
import { valueNumberOf } from './gvn';

/** The compiler fact the stamp reads, and the declaration context's globals when there is one.
 *  The context is a REQUIRED key, `undefined` when there is none: the stamp clears every stamp it
 *  does not re-derive, so a re-stamp that left it out — the compiler behaviors alone, which an
 *  optional key accepted — silently unplaced every read the context made volatile. Build one with
 *  pipeline.ts `stampBehaviorsFor`. */
export type StampBehaviors = Pick<TargetDescription['compilerBehaviors'], 'volatileReadsExtendInRegister'> & {
  readonly contextGlobals: ContextGlobals | undefined;
};

/** Does the map lay out this object's volatility itself? A layout answers per member, which is
 *  finer than the context's per-object fact; an entry with none (a name and a size off the symbol
 *  table) leaves the context's answer standing. */
const laysOut = (info: SymbolInfo | undefined): boolean => Array.isArray(info?.layout) && info.layout.length > 0;

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
  const incoming = joinIncoming(fn);
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

/** Every block parameter's incoming values, one per in-edge (the entry block's excepted). */
function joinIncoming(fn: Fn): Map<Value, Value[]> {
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
  return incoming;
}

/** The ONE global a value's address lies in, read through joins as well as `globalBaseOf`'s address
 *  arithmetic: a block parameter is in the object every in-edge's value is in, an edge that passes
 *  the parameter itself moved by an offset (a strength-reduced loop pointer `v0 = v0 + 2`) aside.
 *  So `c ? &gW.a : &gW.b`, and a pointer seeded with `&gVA` and stepped through it, are both
 *  accesses of that object, which `addressThroughJoins` — one value on every edge — does not see.
 *  Null where an edge reaches another object or none. */
function objectThroughJoins(fn: Fn, defs: Map<Value, Op>): (v: Value) => string | null {
  const incoming = joinIncoming(fn);
  const SELF = Symbol('self');
  type Reach = string | typeof SELF | null;
  const reach = (v: Value, onWalk: Set<Value>): Reach => {
    const d = defs.get(v);
    if (d?.opcode === 'gaddr') {
      return d.attrs.sym as string;
    }
    if (d?.opcode === 'add' && d.operands.length === 2) {
      const a = reach(d.operands[0], onWalk);
      const b = reach(d.operands[1], onWalk);
      return a !== null && b !== null ? null : (a ?? b);
    }
    if (d?.opcode === 'sub' && d.operands.length === 2) {
      return reach(d.operands[0], onWalk);
    }
    const ins = d === undefined ? incoming.get(v) : undefined;
    if (ins === undefined) {
      return null;
    }
    if (onWalk.has(v)) {
      return SELF;
    }
    onWalk.add(v);
    const each = ins.map((a) => reach(a, onWalk)).filter((r) => r !== SELF);
    onWalk.delete(v);
    const [first] = each;
    return typeof first === 'string' && each.every((r) => r === first) ? first : null;
  };
  return (v) => {
    const r = reach(v, new Set());
    return typeof r === 'string' ? r : null;
  };
}

/** Stamp every memory access of `fn` to an object `symbols` or `behaviors.contextGlobals` declares
 *  volatile — a read only where a compiler behaving as `behaviors` says could have made it of one —
 *  and clear the stamp from every other op. Returns the ops it stamped that were not stamped before. */
export function stampDeclaredVolatile(
  fn: Fn,
  symbols: ReadonlyMap<string, SymbolInfo> | undefined,
  behaviors: StampBehaviors,
): Op[] {
  const added: Op[] = [];
  const contextVolatiles = behaviors.contextGlobals?.volatiles;
  const reads = symbols !== undefined || (contextVolatiles !== undefined && contextVolatiles.size > 0);
  const defs = reads ? defOpMap(fn) : undefined;
  const addressOf = reads ? addressThroughJoins(fn) : undefined;
  const objectOf = reads ? objectThroughJoins(fn, defs!) : undefined;
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      const addr = defs && stampable(op, behaviors) ? addressOf!(op.operands[0]) : undefined;
      const base = addr !== undefined ? (globalBaseOf(defs!, addr) ?? objectOf!(addr)) : null;
      // A subscript reaches the object while naming no cell, so only a `load`/`store` asks by byte,
      // and an access that names no byte is placed only where every byte it could reach is qualified.
      const cell =
        base !== null && (op.opcode === 'load' || op.opcode === 'store')
          ? globalCellOf(defs!, addr!, op.attrs.off as number)
          : null;
      const info = base !== null ? symbols?.get(base) : undefined;
      const declared =
        base !== null &&
        (declaresVolatile(info, cell === null ? null : cell.byte) ||
          (contextVolatiles?.has(base) === true && !laysOut(info)));
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
