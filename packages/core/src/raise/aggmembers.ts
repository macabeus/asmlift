// asmlift — A WHOLE-WORD READ OF A DECLARED STRUCT LOCAL, every use of which takes one member's
// bits, READS THOSE MEMBERS.
//
// agbcc has no sp-relative halfword or byte load, so `struct S4 { u16 a; u8 b; u8 pad; } s =
// mk(x); gOut = s.a;` reads the struct-return temp a word at a time and narrows in registers:
//
//     mov r0, sp / bl mk / ldr r1, [sp] / ldr r0, =gOut / strh r1, [r0]
//
// The frame-object audit types the temp as the struct the call returns (frame-objects.ts, the
// `aggregate` stamp), so the word is bytes of a declared object, and each use of it names a byte
// range: a narrowing store or extension (the low end), or one of those applied to a right shift
// by whole bytes, or such a shift alone (the top end, whose zero fill is the member's own zero
// extension). Where every use names exactly one declared integer member, the word is those
// member reads — the same bytes, read at the same program point: each member load is placed where
// the word load was, and the word load is left to dce.
//
// REFUSALS, each leaving the word read whole (spelled through a cast, which is the same bytes):
//   * the base is not a frame object the audit typed as a struct, or the read is qualified;
//   * a use is anything but the shapes above (an add, a compare of the whole word, a phi
//     argument, a call argument), or a shift whose uses are not all of one width;
//   * a range names no declared member exactly (a straddle, padding, a bitfield, a nested
//     aggregate) — the member must start at that byte and be an integer of that width.
import { type Block, type Fn, type Op, type Value, mkOp, mkValue } from '../ir/core';
import { qualified } from '../ir/discipline';
import { type IrType, T } from '../ir/types';

type StructType = Extract<IrType, { kind: 'struct' }>;

/** The struct a frame object's address points at, where the audit stamped one. */
function frameStructOf(defs: ReadonlyMap<Value, Op>, base: Value): StructType | undefined {
  const d = defs.get(base);
  const t = d?.results[0].type;
  return d?.opcode === 'laddr' && d.attrs.aggregate === true && t?.kind === 'ptr' && t.to.kind === 'struct'
    ? t.to
    : undefined;
}

/** The declared integer member at exactly `[byte, byte + width)`: its signedness, or undefined. */
function memberAt(st: StructType, byte: number, width: number): boolean | undefined {
  const f = st.fields.find((m) => m.off === byte);
  return f !== undefined && f.type.kind === 'int' && f.type.width === width * 8 ? f.type.signed : undefined;
}

interface Use {
  readonly op: Op;
  readonly idx: number;
}

/** The bytes a use keeps of the value it reads, low end first: a narrowing store's or an
 *  extension's width; undefined for any other use. */
function narrowedTo(u: Use): number | undefined {
  if (u.op.opcode === 'store' && u.idx === 1) {
    return u.op.attrs.width as number;
  }
  return u.op.opcode === 'zext' || u.op.opcode === 'sext' ? (u.op.attrs.width as number) / 8 : undefined;
}

/** One member a word's uses take: its byte range in the word, and each op it is read for with the
 *  rewiring of that op onto the member's load `m` (returning an op to place after the load). */
interface MemberUse {
  readonly byte: number;
  readonly width: number;
  readonly sites: readonly { readonly op: Op; readonly rewire: (m: Value, signed: boolean) => Op | undefined }[];
}

/** WHERE A MEMBER IS READ. The word was read once, where the compiler CSE'd the member reads of
 *  the source into it; the source read each member where it is used. So a member read for an op
 *  in another block is placed just before that op — where no write to the object lies on any path
 *  from the word's load to it, which is the condition under which the two read the same bytes.
 *  A write is any op but a load that takes the object's address (its struct-return call). */
function readableAt(
  load: Op,
  site: Op,
  { blockOf, preds, writes }: { blockOf: Map<Op, Block>; preds: Map<Block, Block[]>; writes: (op: Op) => boolean },
): boolean {
  const seen = new Set<Block>();
  const work: [Block, number][] = [[blockOf.get(site)!, blockOf.get(site)!.ops.indexOf(site)]];
  while (work.length > 0) {
    const [b, end] = work.pop()!;
    let reached = false;
    for (let i = end - 1; i >= 0; i--) {
      if (b.ops[i] === load) {
        reached = true;
        break;
      }
      if (writes(b.ops[i])) {
        return false;
      }
    }
    if (reached) {
      continue;
    }
    const ps = preds.get(b) ?? [];
    if (ps.length === 0) {
      return false;
    }
    for (const p of ps) {
      if (!seen.has(p)) {
        seen.add(p);
        work.push([p, p.ops.length]);
      }
    }
  }
  return true;
}

export function readDeclaredMembers(fn: Fn, littleEndian: boolean): number {
  const defs = new Map<Value, Op>();
  const uses = new Map<Value, Use[]>();
  const branchArgs = new Set<Value>();
  const blockOf = new Map<Op, Block>();
  const preds = new Map<Block, Block[]>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      blockOf.set(op, b);
      op.results.forEach((r) => defs.set(r, op));
      op.operands.forEach((v, idx) => (uses.get(v) ?? uses.set(v, []).get(v)!).push({ op, idx }));
      op.successors.forEach((s) => {
        s.args.forEach((a) => branchArgs.add(a));
        (preds.get(s.block) ?? preds.set(s.block, []).get(s.block)!).push(b);
      });
    }
  }
  // every read of `from`, an edge's argument included
  const replaceAll = (from: Value, to: Value): void => {
    for (const { op, idx } of uses.get(from) ?? []) {
      op.operands[idx] = to;
    }
    if (branchArgs.has(from)) {
      for (const b of fn.blocks) {
        for (const op of b.ops) {
          op.successors.forEach((sc) => (sc.args = sc.args.map((a) => (a === from ? to : a))));
        }
      }
    }
  };
  // a narrowing use of `m`: a store takes the member's low bytes, an extension of the member's
  // own kind is the member read, another extension extends the member
  const narrowOnto = (u: Use, m: Value, signed: boolean): undefined => {
    if (u.op.opcode === 'store') {
      u.op.operands[1] = m;
    } else if (signed === (u.op.opcode === 'sext')) {
      replaceAll(u.op.results[0], m);
    } else {
      u.op.operands[0] = m;
    }
    return undefined;
  };
  const narrowSite = (u: Use) => ({ op: u.op, rewire: (m: Value, signed: boolean) => narrowOnto(u, m, signed) });
  // a shift that leaves exactly a member's bits, extended its own way: the member, or the member
  // extended that way where it is declared the other
  const extractSite = (sh: Op, width: number) => ({
    op: sh,
    rewire: (m: Value, signed: boolean): Op | undefined => {
      const want = sh.opcode === 'shr_s';
      if (signed === want) {
        replaceAll(sh.results[0], m);
        return undefined;
      }
      const x = mkOp(want ? 'sext' : 'zext', {
        operands: [m],
        results: [mkValue(T.unk(32))],
        attrs: { width: width * 8 },
      });
      replaceAll(sh.results[0], x.results[0]);
      return x;
    },
  });
  const isShr = (op: Op): boolean => (op.opcode === 'shr_u' || op.opcode === 'shr_s') && op.operands.length === 1;
  const frameOff = (v: Value): number | undefined => {
    const d = defs.get(v);
    return d?.opcode === 'laddr' ? (d.attrs.off as number) : undefined;
  };
  let changed = 0;
  for (const blk of fn.blocks) {
    for (let i = 0; i < blk.ops.length; i++) {
      const load = blk.ops[i];
      if (load.opcode !== 'load' || qualified(load)) {
        continue;
      }
      const st = frameStructOf(defs, load.operands[0]);
      const word = load.attrs.width as number;
      const at0 = load.attrs.off as number;
      const v = load.results[0];
      if (st === undefined || branchArgs.has(v)) {
        continue;
      }
      // the byte a `width`-byte range `shift` bits up the word starts at
      const byteOf = (shift: number, width: number): number => (littleEndian ? shift / 8 : word - shift / 8 - width);
      const plan: MemberUse[] = [];
      let ok = (uses.get(v) ?? []).length > 0;
      for (const u of uses.get(v) ?? []) {
        const width = narrowedTo(u);
        if (width !== undefined && width < word) {
          plan.push({ byte: byteOf(0, width), width, sites: [narrowSite(u)] });
          continue;
        }
        // `(x << a) >> b`: bits [b - a, 32 - a) of the word, the middle members
        if (u.op.opcode === 'shl' && u.op.operands.length === 1 && !branchArgs.has(u.op.results[0])) {
          const a = u.op.attrs.imm as number;
          const shrs = uses.get(u.op.results[0])?.map((x) => x.op) ?? [];
          const b = shrs[0]?.attrs.imm as number | undefined;
          const width = b === undefined ? 0 : (32 - b) / 8;
          if (
            b !== undefined &&
            shrs.every((x) => isShr(x) && x.attrs.imm === b && !branchArgs.has(x.results[0])) &&
            b >= a &&
            (b - a) % 8 === 0 &&
            (width === 1 || width === 2) &&
            32 - a <= word * 8
          ) {
            plan.push({ byte: byteOf(b - a, width), width, sites: shrs.map((x) => extractSite(x, width)) });
            continue;
          }
          ok = false;
          break;
        }
        const shift = isShr(u.op) ? (u.op.attrs.imm as number) : 0;
        if (shift <= 0 || shift % 8 !== 0 || shift >= word * 8 || branchArgs.has(u.op.results[0])) {
          ok = false;
          break;
        }
        const top = word - shift / 8;
        const shUses = uses.get(u.op.results[0]) ?? [];
        const widths = new Set(shUses.map(narrowedTo));
        const narrowed = [...widths][0];
        if (
          u.op.opcode === 'shr_u' &&
          shUses.length > 0 &&
          widths.size === 1 &&
          narrowed !== undefined &&
          narrowed < top
        ) {
          plan.push({ byte: byteOf(shift, narrowed), width: narrowed, sites: shUses.map(narrowSite) });
        } else if (top === 1 || top === 2) {
          // the shift's fill is the top member's own extension
          plan.push({ byte: byteOf(shift, top), width: top, sites: [extractSite(u.op, top)] });
        } else {
          ok = false;
          break;
        }
      }
      const signs = plan.map((p) => memberAt(st, at0 + p.byte, p.width));
      if (!ok || signs.some((s) => s === undefined)) {
        continue;
      }
      const obj = frameOff(load.operands[0]);
      const writes = (op: Op): boolean => op.opcode !== 'load' && op.operands.some((o) => frameOff(o) === obj);
      const objectIsBranchArg = [...branchArgs].some((a) => frameOff(a) === obj);
      const mkLoad = (p: MemberUse, signed: boolean): Op =>
        mkOp('load', {
          operands: [load.operands[0]],
          results: [mkValue(T.unk(32))],
          attrs: { off: at0 + p.byte, width: p.width, signed },
        });
      // a member read for an op of the word's own block shares one load where the word was read
      const shared = new Map<string, Op>();
      const after: Op[] = [];
      const sunk: [Op, Op[]][] = [];
      plan.forEach((p, k) => {
        const signed = signs[k]!;
        for (const site of p.sites) {
          const elsewhere = blockOf.get(site.op) !== blk;
          if (elsewhere && !objectIsBranchArg && readableAt(load, site.op, { blockOf, preds, writes })) {
            const m = mkLoad(p, signed);
            const extra = site.rewire(m.results[0], signed);
            sunk.push([site.op, extra === undefined ? [m] : [m, extra]]);
            continue;
          }
          const key = `${p.byte}:${p.width}`;
          const m = shared.get(key) ?? shared.set(key, mkLoad(p, signed)).get(key)!;
          const extra = site.rewire(m.results[0], signed);
          if (extra !== undefined) {
            after.push(extra);
          }
        }
      });
      for (const [site, ops] of sunk) {
        const b = blockOf.get(site)!;
        b.ops.splice(b.ops.indexOf(site), 0, ...ops);
        ops.forEach((o) => blockOf.set(o, b));
      }
      blk.ops.splice(blk.ops.indexOf(load) + 1, 0, ...shared.values(), ...after);
      i = blk.ops.indexOf(load);
      changed++;
    }
  }
  return changed;
}
