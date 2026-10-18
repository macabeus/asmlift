// asmlift — THE CALLEE HALF OF A STRUCT RETURNED THROUGH MEMORY.
//
// A function declared to return a struct by value, on a target whose rule (aggregate.ts
// `returnsInMemory`) returns it through memory, is handed its caller's storage in the first
// argument register and hands the same address back in the return register (O32 `move v0,a0`;
// agbcc and mwcc leave r0/r3 holding it). Its result is the stores through that pointer, so the
// machine code is the function `S *f(S *a0, ...)` — which is also what `void f(S *)` and `S *f(S *)`
// compile to, and why only the declaration can say which one the source wrote.
//
// Where the declaration says `struct S f(...)` and the lift PROVES the pointer is that storage and
// nothing else, the pointer becomes a local of the struct, its stores become that local's members,
// every return hands the local back, and the parameters are the declared ones: `struct S f(s32 a0)
// { struct S ret; ret.a = a0; return ret; }`. Compiled, the compiler builds that local in a frame
// temp or straight in the caller's storage, and copies it out as its own lowering of `return ret;`.
//
// THE PROOF, over the whole lifted function — each condition its own refusal:
//   - the function takes argument register 0 at all (the entry block's first parameter);
//   - every `ret` returns that incoming pointer and nothing else;
//   - outside the ops `dce` deletes (agbcc's `stmia r2!` writes back an address nothing reads),
//     the pointer is read only as the base of an unqualified store, at a byte offset that keeps the
//     store inside the struct, and is never the stored value — so it is not read through, does
//     not escape into a call, a global or another object, and joins no phi;
//   - at least one store goes through it: a function that writes nothing there returns the
//     address only, which a struct return cannot be told from.
// A refusal leaves the function as lifted. What the caller does with it is the caller's rule
// (pipeline.ts `liftStamped`): a stated declaration refuses, a context one keeps the pointer lift
// with a note.
import { type Fn, OWN_RETURN_OBJECT, type Op, RETURNS_OBJECT, type Value, mkOp, mkValue } from '../ir/core';
import { deadOps, qualified } from '../ir/discipline';
import { type IrType, T } from '../ir/types';
import type { TargetDescription } from '../target';

type StructType = Extract<IrType, { kind: 'struct' }>;

/** Rewrites `fn` so the hidden struct-return pointer in argument register 0 is a local of `type`,
 *  where the proof above holds; otherwise leaves `fn` as it is and answers why. */
export function liftOwnStructReturn(fn: Fn, type: StructType, target: TargetDescription): string | undefined {
  const entry = fn.blocks[0];
  const hidden = entry?.params[0];
  const reg = target.argRegs[0];
  if (hidden === undefined) {
    return `it never reads ${reg}, where its caller hands it the address to return the struct at`;
  }
  const size = type.size ?? 0;
  const dead = deadOps(fn.blocks);
  const addresses = storageAddresses(fn, hidden, dead);
  const why = provedReturnStorage(fn, addresses, size, reg, dead);
  if (why !== undefined) {
    return why;
  }
  const object = mkOp('laddr', {
    results: [mkValue(T.ptr(type))],
    attrs: { off: 0, width: 1, signed: false, count: size, aggregate: true, [OWN_RETURN_OBJECT]: true },
  });
  const local = object.results[0];
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      const k = addresses.get(op.operands[0]);
      if (!dead.has(op) && op.opcode === 'store' && k !== undefined) {
        op.operands = [local, ...op.operands.slice(1)];
        op.attrs = { ...op.attrs, off: (op.attrs.off as number) + k };
      } else if (op.opcode === 'ret') {
        op.operands = [local];
        op.attrs = { ...op.attrs, [RETURNS_OBJECT]: true };
      }
      // what is left reading the pointer is an op `dce` deletes: an address derived from it
      op.operands = op.operands.map((v) => (v === hidden ? local : v));
    }
  }
  entry.params = entry.params.slice(1);
  entry.ops.unshift(object);
  return undefined;
}

/** The incoming pointer `hidden` and every address derived from it by adding a constant (O32's
 *  `addu a3,a0,zero` copy; agbcc's `add r2, r0, #0`), each with the bytes it lies past `hidden`.
 *  Ops in `dead` derive nothing. */
function storageAddresses(fn: Fn, hidden: Value, dead: ReadonlySet<Op>): Map<Value, number> {
  const consts = new Map<Value, number>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (op.opcode === 'const' && typeof op.attrs.value === 'number') {
        consts.set(op.results[0], op.attrs.value);
      }
    }
  }
  const addresses = new Map<Value, number>([[hidden, 0]]);
  for (let grew = true; grew;) {
    grew = false;
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        if (op.opcode !== 'add' || dead.has(op) || addresses.has(op.results[0]) || op.operands.length !== 2) {
          continue;
        }
        const [x, y] = op.operands;
        const k =
          addresses.has(x) && consts.has(y)
            ? addresses.get(x)! + consts.get(y)!
            : addresses.has(y) && consts.has(x)
              ? addresses.get(y)! + consts.get(x)!
              : undefined;
        if (k !== undefined) {
          addresses.set(op.results[0], k);
          grew = true;
        }
      }
    }
  }
  return addresses;
}

/** Why the incoming pointer is not provably the storage a struct of `size` bytes is returned in —
 *  undefined where it is. `addresses` are it and what is derived from it (`storageAddresses`);
 *  uses in `dead` ops are no reads. */
function provedReturnStorage(
  fn: Fn,
  addresses: ReadonlyMap<Value, number>,
  size: number,
  reg: string,
  dead: ReadonlySet<Op>,
): string | undefined {
  let stores = 0;
  for (const [i, b] of fn.blocks.entries()) {
    if (b.params.slice(i === 0 ? 1 : 0).some((v) => addresses.has(v))) {
      return `${reg} reaches a join`;
    }
    for (const op of b.ops) {
      if (op.successors.some((s) => s.args.some((v) => addresses.has(v)))) {
        return `${reg} reaches a join`;
      }
      if (op.opcode === 'ret') {
        if (op.operands.length !== 1 || addresses.get(op.operands[0]) !== 0) {
          return `a return hands back something other than the address it was handed in ${reg}`;
        }
        continue;
      }
      const at = op.operands.flatMap((v, k) => (addresses.has(v) ? [k] : []));
      if (at.length === 0 || dead.has(op) || (op.opcode === 'add' && addresses.has(op.results[0]))) {
        continue;
      }
      const why = storeThrough(op, at, addresses.get(op.operands[at[0]])!, size);
      if (why !== undefined) {
        return `${reg} ${why}`;
      }
      stores++;
    }
  }
  return stores === 0 ? `nothing is stored through ${reg}` : undefined;
}

/** Why `op`, which reads an address `k` bytes into the struct at operand indexes `at`, is not a
 *  store of a value into the struct through it. */
function storeThrough(op: Op, at: readonly number[], k: number, size: number): string | undefined {
  if (op.opcode !== 'store') {
    return `is read by a ${op.opcode}, not only as the base of a store`;
  }
  if (at.length !== 1 || at[0] !== 0) {
    return 'is stored as a value';
  }
  if (qualified(op)) {
    return 'is the base of a qualified store';
  }
  const off = k + (op.attrs.off as number);
  const width = op.attrs.width as number;
  if (!(off >= 0 && off + width <= size)) {
    return `is stored through at bytes ${off}..${off + width}, outside the ${size} the struct takes`;
  }
  return undefined;
}
