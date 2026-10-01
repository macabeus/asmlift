/** THE DEVICE PIN: which memory accesses of a lifted function are a device register's, and of those,
 *  which the recompile must make exactly where the machine did. Such an access is stamped
 *  `volatile` (the `device` placement, ir/discipline.ts), and the structurer spells it through a
 *  qualified pointer or declines.
 *
 *  The frame-object audit (frontend/frame-objects.ts) decides WHETHER a function is pinned and
 *  under which policy: it is the pass that sees a frame address handed to a device that reads
 *  through it, and that chooses the one-object or the per-object model. This module decides WHICH
 *  accesses, from the policy row the audit names. Nothing here decodes, so the pass is the same for
 *  every ISA whose target declares its device registers.
 *
 *  EVERY DEVICE ACCESS OF A FUNCTION KEPT AS ONE OBJECT IS PINNED, as the source's `REG_*` and
 *  `vu32 *dmaRegs` spell them — store and load alike, because agbcc drops or moves either when it
 *  is plain:
 *   • a plain store to an address a later store overwrites, with nothing between that may alias
 *     it, is deleted (flow.c:2041-2052), and at -O2 a store of another type does not alias (strict
 *     aliasing, toplev.c:3616) — so of two transfers armed back to back through one channel, with
 *     only a `u16` member store between, the first one's source, destination and control stores go
 *     and that transfer never runs; `REG_IME = 0; … REG_IME = saved;` loses its first store the
 *     same way;
 *   • a plain load in a loop that stores nothing it may alias is invariant, so
 *     `while (REG_VCOUNT != 160);` is hoisted into a loop that never reads the register again.
 *  The address may be a literal, a literal plus a runtime index — `(vu32 *)(0x40000B0 + ch*12)`, a
 *  channel chosen at run time — or a phi each of whose incoming values is one of those: every way
 *  the lift names a device register and not a pointer loaded, passed or computed from nothing it
 *  can place. Over-reach costs a spelling and never an access: `volatile` keeps the accesses the
 *  machine made, and a pinned read is placed once, as a call is (structure/analysis.ts), so the
 *  qualifier adds none. The window is the target's `deviceRegisters`, which has to cover every
 *  register a source reaches — an address outside it stays plain; without one, it is the channels
 *  handed a frame address.
 *
 *  A FUNCTION ACCEPTED OBJECT BY OBJECT pins every device read, and of its device stores only those
 *  of the first kind (`overwritten`). A read is pinned because a plain one is lost either way:
 *  nothing uses the `dmaRegs[2];` that ends a DMA macro, so the lift drops it outright, and a poll
 *  is hoisted as above. Its other device stores stay plain, their qualified spelling left to
 *  `/vol-store`'s candidate (l3/volstore.ts): pinned in the structured tree they are pinned in every
 *  variation, and the ones that home the base or un-reduce a loop refuse a qualified base, which
 *  costs `synthetic:dmastride` and `synthetic:dmaptrsrc` their matches. That is also why the two
 *  policies stay two rows: the one-object row's every-store pin is what keeps `threeFills`' nine
 *  qualified stores (thumb-frontend.test.ts), and on the per-object row it costs those two matches. */
import type { Block, Op, Value } from '../ir/core';
import type { SymbolMap } from '../symbols';
import type { TargetDescription } from '../target';

/** The literal addresses a function's values denote, over its IR as it stands when asked. */
export interface LiteralAddresses {
  readonly defOf: ReadonlyMap<Value, Op>;
  /** the value of a `const`, else undefined */
  constOf(v: Value): number | undefined;
  /** the literal address `v` denotes, or undefined when this cannot say */
  literalAddrOf(v: Value): number | undefined;
}

/** `literalAddrOf`: `const` is the bare pool word, `gaddr` is the same word after the symbol map
 *  named it, a constant shifted by a constant is the word agbcc builds without a pool (`mov r0,
 *  #0x80; lsl r0, #0x13` is 0x04000000), and `add` or `sub` of a constant, on either side, is the
 *  base+displacement form an interior attribution or a member access produces — spellings of one
 *  address, which is the point: the answer must not turn on which one the assembly happened to use.
 *  A runtime index is not a constant, and neither is a pointer loaded from memory, a parameter or a
 *  phi.
 *
 *  A NAME IS NOT AN ADDRESS. The same symbol name can sit at two addresses — a symbol map is free to
 *  carry one — and a `gaddr`'s `sym` can also come straight from the assembly text (`.word
 *  REG_DMA3SAD`), where nothing looked it up at all. So names resolve to an address here or they
 *  resolve to nothing: a name at more than one address vouches for neither. */
export function literalAddresses(irBlocks: readonly Block[], symbols: SymbolMap | undefined): LiteralAddresses {
  const defOf = new Map<Value, Op>();
  for (const blk of irBlocks) {
    for (const op of blk.ops) {
      for (const res of op.results) {
        defOf.set(res, op);
      }
    }
  }
  const addrOfName = new Map<string, number | null>();
  for (const [addr, infos] of symbols ?? []) {
    for (const si of infos) {
      addrOfName.set(si.name, addrOfName.has(si.name) ? null : addr);
    }
  }
  const constOf = (v: Value): number | undefined => {
    const d = defOf.get(v);
    return d?.opcode === 'const' ? (d.attrs.value as number) : undefined;
  };
  const literalAddrOf = (v: Value, depth = 0): number | undefined => {
    const d = defOf.get(v);
    if (d === undefined || depth > 8) {
      return undefined;
    }
    if (d.opcode === 'const') {
      return d.attrs.value as number;
    }
    if (d.opcode === 'gaddr') {
      return addrOfName.get(d.attrs.sym as string) ?? undefined;
    }
    if (d.opcode === 'shl') {
      const shifted = constOf(d.operands[0]);
      const by = d.operands.length === 1 ? (d.attrs.imm as number | undefined) : constOf(d.operands[1]);
      return shifted === undefined || by === undefined || by < 0 || by > 31 ? undefined : (shifted << by) >>> 0;
    }
    if ((d.opcode === 'add' || d.opcode === 'sub') && d.operands.length === 2) {
      const [x, y] = d.operands;
      const cy = constOf(y);
      if (cy !== undefined) {
        const base = literalAddrOf(x, depth + 1);
        return base === undefined ? undefined : d.opcode === 'add' ? base + cy : base - cy;
      }
      const cx = d.opcode === 'add' ? constOf(x) : undefined;
      if (cx !== undefined) {
        const base = literalAddrOf(y, depth + 1);
        return base === undefined ? undefined : base + cx;
      }
    }
    return undefined;
  };
  return { defOf, constOf, literalAddrOf: (v) => literalAddrOf(v) };
}

/** Which device stores a policy pins, beside every device read. */
type StorePin =
  /** every one */
  | 'every'
  /** those a later store in their own block overwrites (`overwritten`) */
  | 'overwritten';

/** The model the frame-object audit accepted a function under. */
export type DevicePinPolicy = 'one-object' | 'per-object';

export const DEVICE_PIN_POLICIES: Readonly<Record<DevicePinPolicy, { readonly stores: StorePin }>> = {
  'one-object': { stores: 'every' },
  'per-object': { stores: 'overwritten' },
};

/** What the frame-object audit hands this pass: the policy it accepted the function under, and the
 *  `readOnlyAddressSinks` registers it saw a frame address stored to. No sink, no pin. */
export interface DevicePins {
  readonly policy: DevicePinPolicy;
  readonly sinks: readonly number[];
}

/** The stores pinned as `overwritten` are those a later store in their own block overwrites, with
 *  no call between to clear flow.c's list of pending stores (flow.c:1962). A plain read of its
 *  bytes between does not always keep it: one agbcc forwards the stored value to (cse.c) leaves the
 *  store dead, and one of another type does not alias. A read it does not forward — a `char` read,
 *  or one it extends — keeps it, and pinning a store agbcc keeps costs a spelling. Two fills through
 *  one channel back to back is the shape, and plain, the first transfer is gone. */
function overwritten(op: Op, blk: Block, at: number, { literalAddrOf }: LiteralAddresses): boolean {
  if (op.opcode !== 'store') {
    return false;
  }
  const addressOf = (x: Op): number | undefined => {
    const lit = literalAddrOf(x.operands[0]);
    return lit === undefined ? undefined : lit + (x.attrs.off as number);
  };
  // Where `x` starts relative to `op`, when both name their bytes the same way.
  const startOf = (x: Op): { from: number; by: number } | undefined => {
    const sameBase = x.operands[0] === op.operands[0];
    const from = sameBase ? (op.attrs.off as number) : addressOf(op);
    const by = sameBase ? (x.attrs.off as number) : addressOf(x);
    return from === undefined || by === undefined ? undefined : { from, by };
  };
  const width = op.attrs.width as number;
  for (const later of blk.ops.slice(at + 1)) {
    if (later.opcode === 'call') {
      return false;
    }
    const s = later.opcode === 'store' ? startOf(later) : undefined;
    if (s !== undefined && s.by <= s.from && s.by + (later.attrs.width as number) >= s.from + width) {
      return true;
    }
  }
  return false;
}

/** Stamp `volatile` on the device accesses `pins.policy` pins. */
export function pinDeviceAccesses(
  irBlocks: Block[],
  { policy, sinks }: DevicePins,
  target: TargetDescription,
  symbols: SymbolMap | undefined,
): void {
  if (sinks.length === 0) {
    return;
  }
  const addresses = literalAddresses(irBlocks, symbols);
  const { defOf, literalAddrOf } = addresses;
  const { stores } = DEVICE_PIN_POLICIES[policy];
  const reach = (target.capabilities.readSourceControl?.offset ?? 2) + 2;
  const window = target.capabilities.deviceRegisters;
  const isDevice = (a: number, w: number): boolean =>
    window !== undefined ? a >= window[0] && a + w <= window[1] : sinks.some((s) => a < s + reach && a + w > s);
  const incoming = new Map<Value, Value[]>();
  for (const blk of irBlocks) {
    for (const op of blk.ops) {
      for (const sx of op.successors ?? []) {
        sx.args.forEach((arg, i) => {
          const param = sx.block.params[i];
          if (param !== undefined) {
            (incoming.get(param) ?? incoming.set(param, []).get(param)!).push(arg);
          }
        });
      }
    }
  }
  // The literal a pointer is a device register plus a runtime index from. `'cycle'` is a phi
  // already on the walk — a pointer stepped around a loop — which contradicts nothing, so a phi
  // is placed by the incoming values that are not its own back edge.
  const placed = (v: Value, onWalk: Set<Value>, depth = 0): number | 'cycle' | undefined => {
    const lit = literalAddrOf(v);
    if (lit !== undefined || depth > 8) {
      return lit;
    }
    const d = defOf.get(v);
    if (d?.opcode === 'add' && d.operands.length === 2) {
      const [x, y] = d.operands.map((o) => placed(o, onWalk, depth + 1));
      return typeof x === 'number' ? x : typeof y === 'number' ? y : (x ?? y);
    }
    const ins = d === undefined ? incoming.get(v) : undefined;
    if (ins === undefined || onWalk.has(v)) {
      return ins === undefined ? undefined : 'cycle';
    }
    onWalk.add(v);
    const each = ins.map((a) => placed(a, onWalk, depth + 1));
    onWalk.delete(v);
    if (each.some((a) => a === undefined || (typeof a === 'number' && !isDevice(a, 1)))) {
      return undefined;
    }
    return each.find((a) => typeof a === 'number') ?? 'cycle';
  };
  const pins = (op: Op, blk: Block, at: number): boolean =>
    op.opcode === 'load' || stores === 'every' || overwritten(op, blk, at, addresses);
  for (const blk of irBlocks) {
    blk.ops.forEach((op, at) => {
      if (op.opcode !== 'store' && op.opcode !== 'load') {
        return;
      }
      const base = placed(op.operands[0], new Set());
      if (
        typeof base === 'number' &&
        isDevice(base + (op.attrs.off as number), op.attrs.width as number) &&
        pins(op, blk, at)
      ) {
        op.attrs = { ...op.attrs, volatile: true };
      }
    });
  }
}
