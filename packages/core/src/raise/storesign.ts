// asmlift — the signedness of a NARROW store, read off the constant it stores.
//
// A store does not say whether its lvalue is signed: `sh` writes the low half of a register either
// way, so a 1- or 2-byte `store` gets the unsigned view by convention (raise/recover.ts, and the
// structurer's store branch reads the same rule). But a compiler that converts the constant to the
// lvalue's type before it materializes it (`compilerBehaviors.narrowStoreConstantTakesLvalueType`)
// leaves that type in the register's UPPER bits, which the store throws away:
//
//     u16 *p; p[6] = -1;       li v0,0xffff   →  const 65535   →  unsigned
//     s16 *p; p[6] = 0xFFFF;   li v0,-1       →  const -1      →  signed
//
// This pass records that as the store's `signed` attr, the slot an `astore` already carries for a
// member's recorded signedness. raise/arrays.ts and raise/struct-arrays.ts carry it into the
// `astore` they make. Every pass that seeds a cell's type from a store reads it through
// `storeSigned` below, the map-less bare-global declaration (rank-declare.ts) among them, since a
// bare `gSym = v` has no cast to carry the stamp; raise/struct-arrays.ts types a field only ever
// stored from it; and the structurer spells a stamped store through a member whose declared sign
// is not the stamp's as a cast cell instead (structure/structure.ts `stampedStoreLval`). It changes no op and no value:
// what it moves is which view of the cell the C spells, and both views store the same bytes.
//
// It refuses (leaves the attr unset, so the convention stands) for:
//   - a target that does not declare the behavior;
//   - a store that already carries `signed`, or a word-wide one;
//   - a stored value that is not a `const` — a `neg`/`shl` the materialization left unfolded, a
//     block param, anything computed;
//   - a constant whose narrow sign bit is clear: both lvalue types materialize it the same way;
//   - a constant whose upper bits are neither the zero- nor the sign-extension of its low bits:
//     no conversion to a narrow type produces one;
//   - a constant some OTHER use reads too, or whose 32-bit value another store writes at another
//     width. The conversion is a fact about a LITERAL on the right of the store. A variable or a
//     chained assignment whose value is a known constant is stored unconverted, in the register
//     a wider use reads: `s32 v = -1; *q = v; p[1] = v;` with `u16 *p` is `li v0,-1; sw v0;
//     sh v0` on gcc2.7.2 and gcc2.7.2kmc, and `li t6,-1; sw t6; li t7,-1; sh t7` on ido7.1, which
//     rematerializes it. When that wide use is there, the register says the wider type's sign,
//     not the lvalue's (the NONLITERAL bodies of
//     packages/cli/test/matching/narrow-store-constant.test.ts).
//
// What it does NOT refuse is such a variable with no wide use: `s32 v = -1; p[6] = v;` (`u16 *p`),
// or one only returned. Its register is the variable's, not the lvalue's, so the stamp can name a
// type the source did not declare (`s16 *` there). It is not refused because nothing tells it
// apart from a literal, and the spelling it gives recompiles to the register the target holds
// (that body scores 1 → 0 on gcc2.7.2, gcc2.7.2kmc and ido7.1).
import { Fn, Op, Value, defOpMap } from '../ir/core';
import type { TargetDescription } from '../target';

/** THE view a store's lvalue is seeded at, `width` bytes wide (`width` for a `store`, `elemSize`
 *  for an `astore`): the `signed` a recovery recorded on it — this pass's reading of a stored
 *  constant, or a member array's own declaration (raise/memberarrays.ts) — else the convention,
 *  word ⇒ signed and narrow ⇒ unsigned. Every pass that types a cell from a store seeds it here,
 *  so none of them can come to read the stamp by a rule of its own. What each then does when a
 *  LOAD disagrees, or a member was already declared, is its own: raise/structs.ts and
 *  raise/struct-arrays.ts prefer the load, as does rank-declare.ts's bare-global declaration; the
 *  structurer spells a member that disagrees with the stamp as a cast cell (structure/structure.ts
 *  `stampedStoreLval`), and an unstamped sign-neutral constant through its base's own view
 *  (`storeView`). */
export function storeSigned(op: Op, width: number): boolean {
  return (op.attrs.signed as boolean | undefined) ?? width === 4;
}

/** The lvalue signedness a constant stored at `width` bytes witnesses, read off the 32-bit register
 *  it was materialized into: `true` sign-extended, `false` zero-extended, `null` when it says
 *  neither (see the refusals at the top of this file). */
export function storedConstantSign(value: number, width: number): boolean | null {
  if (!Number.isInteger(value) || value < -(2 ** 31) || value >= 2 ** 32 || (width !== 1 && width !== 2)) {
    return null;
  }
  const bits = width * 8;
  const reg = value | 0;
  const low = reg & ((1 << bits) - 1);
  if ((low & (1 << (bits - 1))) === 0) {
    return null;
  }
  if (reg === low) {
    return false;
  }
  return reg === (low << (32 - bits)) >> (32 - bits) ? true : null;
}

/** Stamp `signed` on every narrow `store` whose stored constant witnesses its lvalue's signedness.
 *  Returns how many it stamped. */
export function seedNarrowStoreSigns(fn: Fn, target: TargetDescription): number {
  if (target.compilerBehaviors.narrowStoreConstantTakesLvalueType !== true) {
    return 0;
  }
  const defs = defOpMap(fn);
  const stores: Op[] = fn.blocks.flatMap((b) => b.ops.filter((op) => op.opcode === 'store'));
  // the values read other than as the value a store stores. Not a `ret`'s: before the return
  // type is known it reads the return register whether the function returns it or not, and gcc
  // stores a constant from that register in its delay slot (`li v0,-1; jr ra; sh v0,12(a0)`).
  // Nor an edge's into a block param only a `ret` reads, directly or through more such params:
  // that is the same register live out of a branch, `beqz a1,L; ...; li v0,0x8000; sh v0,4(a0);
  // L: jr ra`.
  const retOnly = retOnlyParams(fn);
  const otherUses = new Set<Value>();
  const bump = (v: Value) => otherUses.add(v);
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      op.operands.forEach((v, i) => ((op.opcode === 'store' && i === 1) || op.opcode === 'ret' ? undefined : bump(v)));
      op.successors.forEach((s) => s.args.forEach((v, i) => (retOnly.has(s.block.params[i]) ? undefined : bump(v))));
    }
  }
  // a stored constant's 32-bit register → the widths it is stored at, across every const op
  const widthsOf = new Map<number, Set<number>>();
  for (const op of stores) {
    const d = defs.get(op.operands[1]);
    if (d?.opcode === 'const') {
      const reg = (d.attrs.value as number) | 0;
      (widthsOf.get(reg) ?? widthsOf.set(reg, new Set()).get(reg)!).add(op.attrs.width as number);
    }
  }
  let n = 0;
  for (const op of stores) {
    const d = defs.get(op.operands[1]);
    if (
      op.attrs.signed !== undefined ||
      d?.opcode !== 'const' ||
      otherUses.has(op.operands[1]) ||
      widthsOf.get((d.attrs.value as number) | 0)!.size > 1
    ) {
      continue;
    }
    const signed = storedConstantSign(d.attrs.value as number, op.attrs.width as number);
    if (signed !== null) {
      op.attrs.signed = signed;
      n++;
    }
  }
  return n;
}

/** The block params (not the entry's: those are the function's parameters) that nothing reads but
 *  a `ret` and the edges into other such params. */
function retOnlyParams(fn: Fn): Set<Value> {
  const read = new Set<Value>();
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (op.opcode !== 'ret') {
        op.operands.forEach((v) => read.add(v));
      }
    }
  }
  const out = new Set(fn.blocks.slice(1).flatMap((b) => b.params.filter((p) => !read.has(p))));
  // an edge into a param that is not ret-only reads its argument: drop arguments until none moves
  for (let moved = true; moved;) {
    moved = false;
    for (const b of fn.blocks) {
      for (const op of b.ops) {
        for (const s of op.successors) {
          s.args.forEach((v, i) => {
            if (out.has(v) && !out.has(s.block.params[i])) {
              out.delete(v);
              moved = true;
            }
          });
        }
      }
    }
  }
  return out;
}
