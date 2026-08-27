// asmlift — STRUCT-MEMBER ARRAY recovery (L1 → a struct whose member is an ARRAY).
//
// THE SHAPE. `d->name[i]` — a variable-index walk over an array that lives at a constant byte
// offset INSIDE a struct — reaches this pass as an `aload`/`astore` whose base is a materialized
// `add(P, K)`:
//
//   add  r5, r0, #0x4       %4 = add %0, {value=4}      (the member's address, loop-invariant)
//   ldrh r0, [r1, r0]       %9 = aload %6, %8 {elemSize=2}
//
// raise/arrays.ts legalizes the access, but the `+K` stays an ordinary add, so the base is an
// untyped word and the backend spells the whole thing `((u16 *)(a0 + 4))[i]`. This pass reads the
// add as a MEMBER SELECTION instead: `P` points at a struct whose byte-K member is an array of
// `elemSize` elements, and the access is `P->field_K[i]`.
//
// WHY THE SPELLING IS NOT COSMETIC. agbcc puts the `+K` in a different place for each of the three
// C spellings of this access, and only one of them is the target's. Compiled with this benchmark's
// own agbcc and scored against `synthetic:membnarrow`'s own target object:
//
//   `(a0 + 2)[i]`              `+4` in the LOAD DISPLACEMENT, `ldrh r0,[r0,#0x4]`, 2 saves      11
//   `u16 *v = a0 + 2; v[i]`    preheader `add r4,r0,#0x4`, INDEX-first `add r2,r0,r4`, 2 saves  11
//   `a0->field_4[i]`           preheader `add r5,r0,#0x4`, BASE-first  `add r2,r5,r0`, 3 saves   0
//
// So the evidence this pass reads is the materialized add itself: the cast spelling materializes no
// member address at all, and `arrays.ts` legalizes only an `off === 0` access, so that spelling
// produces no site here. `synthetic:basefold` is that control — its reference IS the cast spelling
// — and it MATCHES today, untouched.
//
// A DEFAULT, NOT A RANKED AXIS, and the reason is a measurement rather than a preference. An axis
// exists where two source spellings collapse onto one asm, so nothing but the differ can separate
// them. Here the asm separates them itself — line one folds `+K` into the memory operand and
// produces NO site — so `add(P, K)` feeding an off-0 scaled access is evidence AGAINST the spelling
// asmlift emits today, not a coin flip. And an axis at this level is a LIFT variant (`/setup-args`'s
// position in rank.ts), doubling the whole candidate product for every function with a site: swept
// over 2288 sa3 and 412 klonoa functions in both symbol-map configurations, the gates below admit
// two bases, in one function, which declines for an unrelated reason — so the price would be paid
// to referee a question the corpus never poses. What is NOT settled is line two, and that is a
// different question: where a base LOCAL goes is the L3 base-local levers' business, taken over
// whatever type the recovery mints, not a second answer to the TYPE this pass decides.
//
// WHY THE COUNT IS A GATE RATHER THAN A GUESS. The declared element count of the TRAILING member is
// byte-observable in its own right (agbcc hoists the base out of the loop only once the struct is
// big enough), so it is read off the loop that walks the member — `boundedCount` below — and the
// whole base DECLINES when no counted loop states it. An INTERIOR member's count is not a choice at
// all: it is forced by the member that follows it.
//
// THE SIBLING PASSES, and why this is a third one rather than a case inside either.
// raise/structs.ts recovers a struct from CONSTANT-offset accesses and leaves every variable-index
// base alone (its `arrayBases` set); raise/struct-arrays.ts recovers an ARRAY OF STRUCTS, where the
// index scales the stride and the constant offset is the field. This pass is the remaining corner —
// the constant offset selects the member and the index strides inside it.
//
// The three shapes are NOT disjoint, and the overlap is per-ACCESS rather than per-base:
// `P->tbl[i].f` is an array of structs living at a member offset, so it carries both this pass's
// address shape and struct-arrays'. Ordering alone does not deconflict them, because the two passes
// claim different VALUES — struct-arrays types the materialized `add(P, K)`, this pass groups on
// `P` — so each refuses what another has marked: `claimed-access` and `base-typed` here,
// `arrayBases` and the `unknown` check there. `field_K[i].f` is a layout this pass does not declare;
// the loud half of that refusal is in structure.ts's `arrayAccess`.
import { type Fn, type Op, type Value, defOpMap } from '../ir/core';
import { type IrType, type StructField, T, scalarTypeForAccess } from '../ir/types';
import { type Gate, firstRejection } from '../l3/gates';
import { firstFreeStructIndex } from './structs';

/** One variable-index access, resolved onto (base value, member offset). */
interface MemberAccess {
  op: Op;
  off: number;
  elemSize: number;
  /** loads only; a store carries structs.ts's `width === 4` convention */
  signed: boolean;
  isLoad: boolean;
  index: Value;
  /** the `add(base, off)` result, or null when the access sits straight on the base */
  addr: Value | null;
}

/** One member of the synthesized struct: an offset, an element type, and the counts the loops
 *  walking it reach. */
interface Member {
  off: number;
  elemSize: number;
  signed: boolean;
  /** element counts derived from the walking loops' bounds — empty when none was derivable */
  bounds: number[];
}

/** What the gates below judge: one base value and the member set its accesses describe. */
export interface MemberArrayCandidate {
  /** the base is still untyped, so no earlier recovery has claimed it */
  untypedBase: boolean;
  /** no access, nor the member address it is taken off, was already claimed by an earlier recovery */
  unclaimedAccesses: boolean;
  /** the base is the address of a NAMED global, whose declaration is the project's own */
  namedGlobalBase: boolean;
  /** some access sits at a NONZERO member offset — a base walked only at offset 0 is a plain array */
  hasNonZeroMember: boolean;
  /** every member offset is small enough to BE an offset rather than an absolute address */
  offsetsInRange: boolean;
  /** no constant-offset `load`/`store` reads the base or a member address (raise/structs.ts's shape) */
  noDirectAccess: boolean;
  /** every use of the base and of every member address is a variable-index access BASE */
  noEscape: boolean;
  /** every member offset is a multiple of its own element size */
  aligned: boolean;
  /** accesses sharing an offset agree on element size and on load signedness */
  consistent: boolean;
  /** natural C alignment seats every member at exactly its observed offset */
  seatable: boolean;
  /** the TRAILING member's element count is stated by a counted loop */
  trailingBounded: boolean;
  /** no member's walk runs past the member that follows it */
  inBounds: boolean;
}

export const MEMBER_ARRAY_GATES: readonly Gate<MemberArrayCandidate>[] = [
  {
    id: 'base-typed',
    why: 'an earlier recovery already typed this base from evidence of its own',
    sound: false,
    guardedBy: 'member-arrays.test.ts: an array-of-struct base declines',
    rejects: (c) => !c.untypedBase,
  },
  {
    // The per-ACCESS half of `base-typed`, and it is a different region rather than a stronger
    // rule: raise/struct-arrays.ts types the MATERIALIZED member address `add(P, K)` and marks the
    // accesses it mints with its own `fieldOff`, while the base `P` this pass groups on stays
    // untyped — so `P->tbl[i].f` reaches the gates as an ordinary member walk. Claiming it drops
    // the field offset (an array of structs at a member offset is not the layout this pass
    // declares) and re-spells the element STRIDE as a scalar width.
    id: 'claimed-access',
    why: 'an access another recovery has already claimed carries an offset this pass would drop',
    sound: true,
    guardedBy: 'member-arrays.test.ts: an array-of-struct member declines',
    rejects: (c) => !c.unclaimedAccesses,
  },
  {
    // A named global's layout belongs to the project's headers — raise/structs.ts makes the same
    // carve-out — and the symbol context already renders its accesses. Synthesizing a struct around
    // one would re-declare a type asmlift does not own.
    id: 'global-base',
    why: "a named global's layout is the project's own declaration, not one to synthesize",
    sound: false,
    guardedBy: 'member-arrays.test.ts: a named global base declines',
    rejects: (c) => c.namedGlobalBase,
  },
  {
    id: 'no-member-offset',
    why: 'a base walked only at offset 0 is a plain array — nothing states a struct around it',
    sound: false,
    guardedBy: 'member-arrays.test.ts: a bare array walk declines',
    rejects: (c) => !c.hasNonZeroMember,
  },
  {
    // A MATERIALIZED addend is not bounded the way a memory operand's immediate is. `add(P, K)`
    // with K an absolute address — `ldr r0, =0x03000004` then `add r0, r0, rX` — is base-plus-index
    // with the roles reversed, and reading it as a member selection declares a 48 MB struct. Nothing
    // in the IR separates the two: raise/const.ts folds a pool-loaded literal and an add-immediate
    // into the same `const`. So the separation is STATED here rather than derived, and the number is
    // chosen where the two populations do not overlap on this corpus — above every offset sa3 and
    // klonoa admit (the largest is 26) and below every mapped GBA region base (0x02000000). A target
    // whose objects run past it is what would earn a declared field to read instead.
    id: 'member-offset-range',
    why: 'a materialized addend that large is an absolute address, not a member offset',
    sound: false,
    guardedBy: 'member-arrays.test.ts: an absolute-address addend declines',
    rejects: (c) => !c.offsetsInRange,
  },
  {
    id: 'direct-access',
    why: 'a constant-offset access alongside the walk is the struct-POINTER shape raise/structs.ts owns',
    sound: false,
    guardedBy: 'member-arrays.test.ts: a base read at a constant offset declines',
    rejects: (c) => !c.noDirectAccess,
  },
  {
    id: 'escaping-use',
    why: 'a use this rewrite cannot see keeps reading the base as a word the retype no longer spells',
    sound: false,
    guardedBy: 'member-arrays.test.ts: a member address forwarded on a branch declines',
    rejects: (c) => !c.noEscape,
  },
  {
    id: 'member-conflict',
    why: 'one offset read at two widths or two extensions is a union view, not a member',
    sound: false,
    guardedBy: 'member-arrays.test.ts: two widths at one offset decline',
    rejects: (c) => !c.consistent,
  },
  {
    // SOUND, and it is the address that is at stake rather than the spelling: C aligns a member to
    // its own element type, so declaring an `s32` member at byte 2 would seat it at byte 4 and
    // every access through it would read four bytes off the observed address.
    id: 'member-align',
    why: 'a member C cannot seat at its observed offset addresses different bytes than the asm did',
    sound: true,
    guardedBy: 'member-arrays.test.ts: a word member at byte 2 declines',
    rejects: (c) => !c.aligned,
  },
  {
    // SOUND for the same reason: the interior member counts are what place every later member, so
    // a run that overlaps its successor or does not divide by its element size mislays it.
    id: 'member-seat',
    why: 'a member run that overlaps the next one shifts every later member off its observed offset',
    sound: true,
    guardedBy: 'member-arrays.test.ts: overlapping member runs decline',
    rejects: (c) => !c.seatable,
  },
  {
    id: 'trailing-unbounded',
    why: "nothing but the walking loop's bound states the last member's element count, and the count is byte-observable",
    sound: false,
    guardedBy: 'member-arrays.test.ts: a member walked to a runtime bound declines',
    rejects: (c) => !c.trailingBounded,
  },
  {
    id: 'member-overrun',
    why: 'a walk running past the next member is evidence of a layout other than the one being declared',
    sound: false,
    guardedBy: 'member-arrays.test.ts: a walk overrunning its successor declines',
    rejects: (c) => !c.inBounds,
  },
];

/** The envelope `member-offset-range` states — see that gate. */
const MAX_MEMBER_OFFSET = 0x10000;

/** Strip `sext`/`zext` wrappers — a narrow counter reaches its uses through them. */
function stripExt(v: Value, defs: Map<Value, Op>): Value {
  for (;;) {
    const d = defs.get(v);
    if (d === undefined || (d.opcode !== 'sext' && d.opcode !== 'zext')) {
      return v;
    }
    v = d.operands[0];
  }
}

/** `add(x, const)` read as (other operand, constant), or null. The add is commutative. */
function constAddend(op: Op, defs: Map<Value, Op>): { of: Value; k: number } | null {
  if (op.opcode !== 'add' || op.operands.length !== 2) {
    return null;
  }
  for (const [ci, oi] of [
    [0, 1],
    [1, 0],
  ] as const) {
    const c = defs.get(op.operands[ci]);
    if (c?.opcode === 'const') {
      return { of: op.operands[oi], k: c.attrs.value as number };
    }
  }
  return null;
}

/** How many elements the loop walking `idx` reaches, or null when the shape is not a counted loop.
 *
 *  THE ONE SHAPE THIS READS, and everything else declines: `idx` is a block parameter (through any
 *  extensions) of a header with exactly two in-edges, one carrying a non-negative constant and one
 *  the TRUE arm of a `cond_br` whose condition compares `param + 1` against a constant bound. The
 *  count is then the bound plus one for `<=`, the bound itself for `<`. A `>`/`>=` test, a step
 *  other than one, a bound that is not a constant, or a third edge into the header all decline —
 *  the answer is a DECLARED element count, so a shape whose last index is not read off the asm has
 *  no honest one. */
function boundedCount(fn: Fn, idx: Value, defs: Map<Value, Op>): number | null {
  const param = stripExt(idx, defs);
  const header = fn.blocks.find((b) => b.params.includes(param));
  if (header === undefined) {
    return null;
  }
  const slot = header.params.indexOf(param);
  const edges: { op: Op; index: number }[] = [];
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      op.successors.forEach((s, i) => {
        if (s.block === header) {
          edges.push({ op, index: i });
        }
      });
    }
  }
  if (edges.length !== 2) {
    return null;
  }
  const entry = edges.find((e) => defs.get(e.op.successors[e.index].args[slot])?.opcode === 'const');
  const back = edges.find((e) => e !== entry);
  if (entry === undefined || back === undefined || back.op.opcode !== 'cond_br' || back.index !== 0) {
    return null;
  }
  if ((defs.get(entry.op.successors[entry.index].args[slot])!.attrs.value as number) < 0) {
    return null;
  }
  // the back edge carries `param + 1`, possibly re-extended by the counter's own truncation
  const next = stripExt(back.op.successors[0].args[slot], defs);
  const step = defs.get(next) === undefined ? null : constAddend(defs.get(next)!, defs);
  if (step === null || step.k !== 1 || stripExt(step.of, defs) !== param) {
    return null;
  }
  // …and the exit test compares that same value against a constant bound
  const cond = defs.get(back.op.operands[0]);
  if (cond === undefined || cond.operands.length !== 2) {
    return null;
  }
  const inclusive = cond.opcode === 'icmp_sle' || cond.opcode === 'icmp_ule';
  if (!inclusive && cond.opcode !== 'icmp_slt' && cond.opcode !== 'icmp_ult') {
    return null;
  }
  if (stripExt(cond.operands[0], defs) !== next) {
    return null;
  }
  const bound = defs.get(cond.operands[1]);
  if (bound?.opcode !== 'const') {
    return null;
  }
  const count = (bound.attrs.value as number) + (inclusive ? 1 : 0);
  return count >= 1 ? count : null;
}

/** Group every variable-index access by the base it is taken off, resolving a `add(P, K)` address
 *  into (P, K). An offset-0 access contributes its own base. */
function accessesByBase(fn: Fn, defs: Map<Value, Op>): Map<Value, MemberAccess[]> {
  const out = new Map<Value, MemberAccess[]>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (op.opcode !== 'aload' && op.opcode !== 'astore') {
        continue;
      }
      const isLoad = op.opcode === 'aload';
      const elemSize = op.attrs.elemSize as number;
      const addrDef = defs.get(op.operands[0]);
      const add = addrDef === undefined ? null : constAddend(addrDef, defs);
      const base = add === null ? op.operands[0] : add.of;
      const list = out.get(base) ?? [];
      list.push({
        op,
        off: add === null ? 0 : add.k,
        elemSize,
        signed: isLoad ? (op.attrs.signed as boolean) : elemSize === 4,
        isLoad,
        index: op.operands[1],
        addr: add === null ? null : op.operands[0],
      });
      out.set(base, list);
    }
  }
  return out;
}

/** One candidate base, as the gates read it, plus the members the rewrite would declare. */
export interface MemberArrayGroup {
  base: Value;
  c: MemberArrayCandidate;
  members: Member[];
  accesses: MemberAccess[];
}

/** Every base a variable-index access is taken off, with the member set its accesses describe.
 *  Exported so a corpus sweep can price the gate table over the bases it REFUSES. */
export function memberArrayCandidates(fn: Fn): MemberArrayGroup[] {
  const defs = defOpMap(fn);
  const out: MemberArrayGroup[] = [];
  const bounds = new Map<Value, number | null>();
  for (const [base, accesses] of accessesByBase(fn, defs)) {
    // one loop-bound read per index value — the two ends of a copy loop share it
    const bound = (v: Value): number | null => {
      if (!bounds.has(v)) {
        bounds.set(v, boundedCount(fn, v, defs));
      }
      return bounds.get(v)!;
    };
    const addrs = new Set<Value>(accesses.flatMap((a) => (a.addr === null ? [] : [a.addr])));
    // Every use of the base and of every member address must be a variable-index access base: the
    // member addresses disappear in the rewrite, and the base takes a struct-pointer type every
    // other use would have to spell.
    let noEscape = true;
    let noDirectAccess = true;
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        const isVarIndex = op.opcode === 'aload' || op.opcode === 'astore';
        op.operands.forEach((o, k) => {
          if (o !== base && !addrs.has(o)) {
            return;
          }
          if (op.opcode === 'load' || op.opcode === 'store') {
            noDirectAccess = false;
          } else if (isVarIndex ? k !== 0 : !(o === base && addrs.has(op.results[0]))) {
            noEscape = false;
          }
        });
        for (const s of op.successors) {
          if (s.args.some((a) => a === base || addrs.has(a))) {
            noEscape = false;
          }
        }
      }
    }
    // one member per distinct offset; a load's extension wins over a store's width convention
    const byOff = new Map<number, Member>();
    const loadSigned = new Map<number, boolean>();
    let consistent = true;
    let aligned = true;
    for (const a of accesses) {
      if (a.off < 0 || a.off % a.elemSize !== 0) {
        aligned = false;
      }
      const prev = byOff.get(a.off);
      const m = prev ?? { off: a.off, elemSize: a.elemSize, signed: a.signed, bounds: [] };
      if (prev !== undefined && prev.elemSize !== a.elemSize) {
        consistent = false;
      }
      if (a.isLoad) {
        const seen = loadSigned.get(a.off);
        if (seen !== undefined && seen !== a.signed) {
          consistent = false;
        }
        loadSigned.set(a.off, a.signed);
        m.signed = a.signed;
      }
      const n = bound(a.index);
      if (n !== null) {
        m.bounds.push(n);
      }
      byOff.set(a.off, m);
    }
    const members = [...byOff.values()].sort((x, y) => x.off - y.off);
    // Natural C alignment must seat every member at its observed offset. An INTERIOR member's run
    // reaches exactly the offset of the member that follows it, so the only pad this layout ever
    // needs is the leading one and the only way to mislay a member is a span its element size does
    // not divide.
    let seatable = true;
    let inBounds = true;
    for (const [i, m] of members.entries()) {
      const next = members[i + 1];
      if (next === undefined) {
        break;
      }
      const span = next.off - m.off;
      if (span % m.elemSize !== 0) {
        seatable = false;
      } else if (m.bounds.some((n) => n > span / m.elemSize)) {
        inBounds = false;
      }
    }
    const trailing = members[members.length - 1];
    out.push({
      base,
      accesses,
      members,
      c: {
        untypedBase: base.type.kind === 'unknown',
        unclaimedAccesses: accesses.every(
          (a) => a.op.attrs.fieldOff === undefined && (a.addr === null || a.addr.type.kind === 'unknown'),
        ),
        namedGlobalBase: defs.get(base)?.opcode === 'gaddr',
        hasNonZeroMember: members.some((m) => m.off > 0),
        offsetsInRange: members.every((m) => m.off < MAX_MEMBER_OFFSET),
        noDirectAccess,
        noEscape,
        aligned,
        consistent,
        seatable,
        trailingBounded: trailing !== undefined && trailing.bounds.length > 0,
        inBounds,
      },
    });
  }
  return out;
}

/** The declared field list for an admitted base: a leading `u8[N]` pad when the first member does
 *  not start at 0, then one array member per offset — interior counts forced by the member that
 *  follows, the trailing count read off its walking loop. */
function fieldsOf(members: Member[]): StructField[] {
  const fields: StructField[] = [];
  if (members[0].off > 0) {
    fields.push({ off: 0, type: T.array(T.u(8), members[0].off), name: '_pad0' });
  }
  for (const [i, m] of members.entries()) {
    const next = members[i + 1];
    // `trailing-unbounded` is what makes the trailing member's `bounds` non-empty; the `1` is what
    // an ABLATION of that gate declares rather than a count of nothing.
    const count = next === undefined ? Math.max(1, ...m.bounds) : (next.off - m.off) / m.elemSize;
    fields.push({
      off: m.off,
      type: T.array(scalarTypeForAccess(m.elemSize, m.signed), count),
      name: `field_${m.off}`,
    });
  }
  return fields;
}

/** Recover a struct whose MEMBER is an array from the variable-index accesses taken off a constant
 *  byte offset of one base. Runs after array legalization and array-of-struct recovery, before
 *  struct-pointer recovery. Returns the number of bases recovered.
 *
 *  Bases sharing a layout share one declared struct — the two ends of a copy loop are one type,
 *  and two identical declarations under different names would be an artifact of the walk order. */
export function recognizeMemberArrays(
  fn: Fn,
  gates: readonly Gate<MemberArrayCandidate>[] = MEMBER_ARRAY_GATES,
): number {
  const admitted = memberArrayCandidates(fn).filter((g) => firstRejection(gates, g.c) === null);
  if (admitted.length === 0) {
    return 0;
  }
  let next = firstFreeStructIndex(fn);
  const byLayout = new Map<string, IrType>();
  for (const g of admitted) {
    const fields = fieldsOf(g.members);
    const key = JSON.stringify(fields);
    let type = byLayout.get(key);
    if (type === undefined) {
      type = T.struct(`Struct${next++}`, fields);
      byLayout.set(key, type);
    }
    g.base.type = T.ptr(type);
    for (const a of g.accesses) {
      a.op.operands[0] = g.base;
      a.op.attrs.memberOff = a.off;
      if (!a.isLoad) {
        // an astore carries no signedness of its own — the member's decides how the index node
        // types, so the store spells through the same declaration the load does
        a.op.attrs.signed = g.members.find((m) => m.off === a.off)!.signed;
      }
    }
  }
  // the now-dead `add`/`const` member addresses are reaped by the DRIVER's dce
  return admitted.length;
}
