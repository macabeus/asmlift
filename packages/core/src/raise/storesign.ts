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
// member's recorded signedness, and recoverTypes, the structurer's store branch and raise/structs.ts
// (a field only ever stored) read it. It changes no op and no value: what it moves is which view of
// the cell the C spells, and both views store the same bytes.
//
// It refuses (leaves the attr unset, so the convention stands) for:
//   - a target that does not declare the behavior;
//   - a store that already carries `signed`, or a word-wide one;
//   - a stored value that is not a `const` — a `neg`/`shl` the materialization left unfolded, a
//     block param, anything computed;
//   - a constant whose narrow sign bit is clear: both lvalue types materialize it the same way;
//   - a constant whose upper bits are neither the zero- nor the sign-extension of its low bits:
//     no conversion to a narrow type produces one.
import { Fn, defOpMap } from '../ir/core';
import type { TargetDescription } from '../target';

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
  let n = 0;
  for (const b of fn.blocks) {
    for (const op of b.ops) {
      if (op.opcode !== 'store' || op.attrs.signed !== undefined) {
        continue;
      }
      const d = defs.get(op.operands[1]);
      if (d?.opcode !== 'const') {
        continue;
      }
      const signed = storedConstantSign(d.attrs.value as number, op.attrs.width as number);
      if (signed !== null) {
        op.attrs.signed = signed;
        n++;
      }
    }
  }
  return n;
}
