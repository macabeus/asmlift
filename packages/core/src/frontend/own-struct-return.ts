// asmlift — THE CALLEE HALF OF A STRUCT RETURNED THROUGH MEMORY.
//
// A function declared to return a struct by value, on a target whose rule (aggregate.ts
// `returnsInMemory`) returns it through memory, is handed its caller's storage in the first
// argument register. Where its compiler hands the same address back in the return register (O32
// `move v0,a0`; agbcc leaves r0 holding it, or restores it), the machine code is the function
// `S *f(S *a0, ...)`; where it does not (mwcc leaves in r3 whatever was last there, `target.ts`
// `structReturnHandsBackPointer`), it is `void f(S *a0, ...)`. Its result is the stores through that
// pointer either way, which is also what `void f(S *)` and `S *f(S *)` compile to, and why only the
// declaration can say which one the source wrote.
//
// Where the declaration says `struct S f(...)` and the lift PROVES the pointer is that storage and
// nothing else, the pointer becomes a local of the struct, its stores become that local's members,
// every return hands the local back, and the parameters are the declared ones: `struct S f(s32 a0)
// { struct S ret; ret.a = a0; return ret; }`. Compiled, the compiler builds that local in a frame
// temp or straight in the caller's storage, and copies it out as its own lowering of `return ret;`.
//
// THE PROOF, over the whole lifted function — each condition its own refusal:
//   - the function takes argument register 0 at all (the entry block's first parameter);
//   - where the compiler hands the pointer back (`structReturnHandsBackPointer`), every `ret`
//     returns that incoming pointer and nothing else; where it does not, what a `ret` hands back
//     is read as nothing — save a value COMPUTED FOR THE RETURN ALONE (`returnedAlone`): one that
//     nothing but a `ret` reads, through joins of nothing else. mwcc's struct-returning callee
//     leaves in r3 what was last there, which is a value the body needed for something else (a
//     reloaded word it stores, the pointer itself); a value nothing else reads is a scalar the
//     function computed to return, which the declaration would silently drop — `int f(struct S12
//     *p, int x) { ...; return x * 2; }` under a header that says `struct S12 f(int x)`. It does
//     not catch a returned value the body also stores (`return x;` past `p->a = x`), which the
//     machine code cannot tell from a struct return;
//   - outside the ops `dce` deletes (agbcc's `stmia r2!` writes back an address nothing reads),
//     the pointer is read only as the base of an unqualified store, at a byte offset that keeps the
//     store inside the struct, and is never the stored value — so it is not read through, does
//     not escape into a call, a global or another object, and joins no phi;
//   - at least one store goes through it: a function that writes nothing there returns the
//     address only, which a struct return cannot be told from.
// A refusal leaves the function as lifted. What the caller does with it is the caller's rule
// (pipeline.ts `liftStamped`): a stated declaration refuses, a context one keeps the pointer lift
// with a note.
//
// THE FRAME COPY. Where the compiler built the struct in a frame object and copied it out word by
// word (IDO's `addiu t7,sp,4; lw t9,0(t7); sw t9,0(a0)`, agbcc's `ldmia`/`stmia` pair), that frame
// object IS the returned local and the copy is `return ret;`'s lowering, so lifting the copy as
// member stores would compile to a second copy. `foldFrameCopy` folds it: the object's stores
// become the return object's, and the copy goes. It folds only a copy it can prove is that one —
// see its own note — and otherwise leaves the stores of the copied words, which is the same
// function spelled with one copy too many.
//
// A STRUCT RETURNED IN THE RETURN REGISTER is the other half of the target's rule, and only its
// simplest case is spelled as the struct (`liftOwnRegisterStruct`): one word that is all one
// integer member.
import {
  type Block,
  type Fn,
  OWN_RETURN_OBJECT,
  type Op,
  RETURNS_OBJECT,
  type Value,
  defOpMap,
  mergeClasses,
  mkOp,
  mkValue,
  predecessors,
  successorsOf,
} from '../ir/core';
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
  const handsBack = target.compilerBehaviors.structReturnHandsBackPointer !== false;
  const why =
    provedReturnStorage(fn, addresses, size, reg, dead, handsBack) ??
    (handsBack ? undefined : returnedAlone(fn, addresses, dead, target.returnReg));
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
  foldFrameCopy(fn, local, size, dead);
  return undefined;
}

/** THE ONE-WORD STRUCT A TARGET RETURNS IN ITS RETURN REGISTER (agbcc's and mwcc's `struct W {
 *  u32 x; }` in r0/r3): the register holds the struct's one member, so each `ret`'s word is stored
 *  to that member of a local of `type` and the local is returned by value, `ret.x = a0 + 5; return
 *  ret;`. Only a struct of exactly one word whose member at byte 0 is an integer of that word fills
 *  the register with nothing else; any other struct, or a `ret` that hands back no word, leaves `fn`
 *  as it is (its word the lift's return), and answers why. */
export function liftOwnRegisterStruct(fn: Fn, type: StructType): string | undefined {
  const member = type.fields.find((f) => f.off === 0 && f.type.kind === 'int' && f.type.width === 32);
  if (type.size !== 4 || type.fields.length !== 1 || member === undefined) {
    return 'it is not one word that is all one integer member';
  }
  const rets = fn.blocks.map((b) => b.ops[b.ops.length - 1]).filter((op) => op?.opcode === 'ret');
  if (rets.some((op) => op.operands.length !== 1)) {
    return 'a return hands back no word';
  }
  const object = mkOp('laddr', {
    results: [mkValue(T.ptr(type))],
    attrs: { off: 0, width: 1, signed: false, count: 4, aggregate: true, [OWN_RETURN_OBJECT]: true },
  });
  const local = object.results[0];
  for (const b of fn.blocks) {
    const ret = b.ops[b.ops.length - 1];
    if (ret?.opcode === 'ret') {
      b.ops.splice(
        b.ops.length - 1,
        0,
        mkOp('store', { operands: [local, ret.operands[0]], attrs: { off: 0, width: 4 } }),
      );
      ret.operands = [local];
      ret.attrs = { ...ret.attrs, [RETURNS_OBJECT]: true };
    }
  }
  fn.blocks[0].ops.unshift(object);
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
 *  uses in `dead` ops are no reads, and so is a `ret`'s where the compiler does not hand the
 *  pointer back (`handsBack` false), since what the return register then holds is garbage. */
function provedReturnStorage(
  fn: Fn,
  addresses: ReadonlyMap<Value, number>,
  size: number,
  reg: string,
  dead: ReadonlySet<Op>,
  handsBack: boolean,
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
        if (handsBack && (op.operands.length !== 1 || addresses.get(op.operands[0]) !== 0)) {
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

/** Where the compiler does not hand the pointer back: why a `ret` hands back a value the function
 *  computed for that return alone — undefined where none does. A ret's value and every value joined
 *  with it (`mergeClasses`) form its web; the web is the return's alone where nothing but a `ret` or
 *  a jump into the web reads any of it (ops in `dead` read nothing), and it is a computed value
 *  where some member is an op's result other than an `undef` (a register the machine left unset),
 *  or an incoming register other than the pointer. */
function returnedAlone(
  fn: Fn,
  addresses: ReadonlyMap<Value, number>,
  dead: ReadonlySet<Op>,
  reg: string,
): string | undefined {
  const readers = new Map<Value, Op[]>();
  const defs = defOpMap(fn);
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (!dead.has(op)) {
        for (const v of [...op.operands, ...op.successors.flatMap((s) => s.args)]) {
          (readers.get(v) ?? readers.set(v, []).get(v)!).push(op);
        }
      }
    }
  }
  const webs = mergeClasses(fn);
  const entry = new Set(fn.blocks[0]?.params ?? []);
  for (const b of fn.blocks) {
    const ret = b.ops[b.ops.length - 1];
    if (ret?.opcode !== 'ret' || ret.operands.length !== 1 || addresses.has(ret.operands[0])) {
      continue;
    }
    const web = webs.get(ret.operands[0]) ?? [ret.operands[0]];
    const alone = web.every((v) =>
      (readers.get(v) ?? []).every(
        (op) => op.opcode === 'ret' || (op.successors.length > 0 && !op.operands.includes(v)),
      ),
    );
    const computed = web.some((v) =>
      defs.has(v) ? defs.get(v)!.opcode !== 'undef' : entry.has(v) && !addresses.has(v),
    );
    if (alone && computed) {
      return `a return hands back in ${reg} a value nothing else reads, which a function returning the struct through memory has no reason to compute`;
    }
  }
  return undefined;
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

/** One access through a frame object: the op, and the byte it reaches from the object's start. */
interface FrameAccess {
  op: Op;
  at: number;
}

/** FOLDS A FRAME OBJECT COPIED WHOLE INTO THE RETURN OBJECT, where every store to the return object
 *  (`ret`, the hidden pointer's local) is a COPY: an unqualified store of a load of the same width,
 *  read through one frame object (`laddr`) at one fixed shift from the stored byte. Then the frame
 *  object's stores are the return object's, the copy is deleted, and the frame object goes with it.
 *
 *  It folds only where that is the same function, which needs every one of:
 *   - the copies tile the struct, `[0, size)`, each byte once: the compiler copies the whole of it;
 *   - each copied load is read by its copy alone, and is a load of the frame object at
 *     `shift + off` for the copy at `off`;
 *   - the frame object is reached only through `laddr`s of its offset, as the base of unqualified
 *     loads and stores — never passed, stored or added to — and every access lies in the copied
 *     range `[shift, shift + size)`, so the struct is all the object holds;
 *   - at least one store reaches the frame object: one nothing stores to is a struct returned
 *     wholly unset, whose copy is all that writes `ret`;
 *   - every copy is in ONE block, and no store to the frame object follows a copied load: not later
 *     in that block, and not in any block reachable from it — so the copy reads what was stored —
 *     and every store to the object is on a path into that block, so it is one the returned struct
 *     holds and not a write to storage a path that returns without the copy leaves alone.
 *  Anything else leaves `fn` as it is. */
function foldFrameCopy(fn: Fn, ret: Value, size: number, dead: ReadonlySet<Op>): void {
  const defs = new Map<Value, Op>();
  const blockOf = new Map<Op, Block>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      op.results.forEach((r) => defs.set(r, op));
      blockOf.set(op, b);
    }
  }
  const uses = new Map<Value, Op[]>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (dead.has(op)) {
        continue;
      }
      for (const v of [...op.operands, ...op.successors.flatMap((s) => s.args)]) {
        (uses.get(v) ?? uses.set(v, []).get(v)!).push(op);
      }
    }
  }
  const copies = (uses.get(ret) ?? []).filter((op) => op.opcode === 'store');
  if (copies.length === 0) {
    return;
  }
  // each copy: the load it stores, its frame object's offset, and the shift from the stored byte
  let frame: number | undefined;
  let shift: number | undefined;
  const copiedLoads = new Set<Op>();
  const tiles: [number, number][] = [];
  for (const c of copies) {
    const load = defs.get(c.operands[1]);
    const base = load?.opcode === 'load' ? defs.get(load.operands[0]) : undefined;
    if (
      load === undefined ||
      base?.opcode !== 'laddr' ||
      base.attrs[OWN_RETURN_OBJECT] === true ||
      qualified(c) ||
      qualified(load) ||
      load.attrs.width !== c.attrs.width ||
      (uses.get(load.results[0]) ?? []).length !== 1 ||
      blockOf.get(c) !== blockOf.get(copies[0])
    ) {
      return;
    }
    const s = (load.attrs.off as number) - (c.attrs.off as number);
    if ((frame ?? base.attrs.off) !== base.attrs.off || (shift ?? s) !== s) {
      return;
    }
    frame = base.attrs.off as number;
    shift = s;
    copiedLoads.add(load);
    tiles.push([c.attrs.off as number, c.attrs.width as number]);
  }
  tiles.sort((a, b) => a[0] - b[0]);
  if (tiles.reduce((end, [off, w]) => (end === off ? off + w : -1), 0) !== size) {
    return;
  }
  // every access to the frame object, and nothing else that reaches it
  const accesses: FrameAccess[] = [];
  const laddrs = fn.blocks
    .flatMap((b) => b.ops)
    .filter((op) => op.opcode === 'laddr' && op.attrs.off === frame && op.attrs[OWN_RETURN_OBJECT] !== true);
  for (const l of laddrs) {
    for (const u of uses.get(l.results[0]) ?? []) {
      const access = (u.opcode === 'load' || u.opcode === 'store') && u.operands[0] === l.results[0];
      const stored = u.opcode === 'store' && u.operands[1] === l.results[0];
      if (!access || stored || qualified(u) || u.operands.filter((v) => v === l.results[0]).length !== 1) {
        return;
      }
      const at = u.attrs.off as number;
      if (at < shift! || at + (u.attrs.width as number) > shift! + size) {
        return;
      }
      if (u.opcode === 'load' && !copiedLoads.has(u)) {
        return;
      }
      accesses.push({ op: u, at });
    }
  }
  const stores = accesses.filter((a) => a.op.opcode === 'store');
  // a frame object nothing stores to is a struct returned wholly unset (`struct S12 r; return r;`):
  // folding it would leave `ret` read and never written, so the copy of its unset words stays
  if (stores.length === 0 || storeFollowsCopy(fn, blockOf.get(copies[0])!, copiedLoads, stores, blockOf)) {
    return;
  }
  for (const { op, at } of stores) {
    op.operands = [ret, ...op.operands.slice(1)];
    op.attrs = { ...op.attrs, off: at - shift! };
  }
  const gone = new Set<Op>([...copies, ...copiedLoads]);
  for (const b of fn.blocks) {
    b.ops = b.ops.filter((op) => !gone.has(op));
  }
  // …and the frame object's addresses, where nothing still reads them (an op `dce` deletes may)
  const read = new Set(fn.blocks.flatMap((b) => b.ops.flatMap((op) => op.operands)));
  for (const b of fn.blocks) {
    b.ops = b.ops.filter((op) => !laddrs.includes(op) || read.has(op.results[0]));
  }
}

/** Whether a store in `stores` is not one the copy reads: it can run after a copied load — later in
 *  the copy's block `at`, or in any block reachable from it (which includes `at` itself, where it
 *  heads a loop) — or it runs on a path that never reaches the copy at all, where the caller's
 *  storage was left unwritten and folding would write it. */
function storeFollowsCopy(
  fn: Fn,
  at: Block,
  loads: ReadonlySet<Op>,
  stores: readonly FrameAccess[],
  blockOf: ReadonlyMap<Op, Block>,
): boolean {
  const first = at.ops.findIndex((op) => loads.has(op));
  if (first < 0 || [...loads].some((l) => blockOf.get(l) !== at)) {
    return true;
  }
  const walk = (from: Block[], next: (b: Block) => Block[]): Set<Block> => {
    const seen = new Set<Block>();
    const work = [...from];
    while (work.length > 0) {
      const b = work.pop()!;
      if (!seen.has(b)) {
        seen.add(b);
        work.push(...next(b));
      }
    }
    return seen;
  };
  const after = walk(successorsOf(at), successorsOf);
  const preds = predecessors(fn);
  const before = walk(preds.get(at) ?? [], (b) => preds.get(b) ?? []);
  return stores.some(({ op }) => {
    const b = blockOf.get(op)!;
    return after.has(b) || (b === at ? at.ops.indexOf(op) > first : !before.has(b));
  });
}
