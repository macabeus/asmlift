// asmlift structurer — whether a global's declared storage agrees with the one access the
// assembly makes of it: the symbol map's sized scalar (`mappedStorage`), the comparison with a
// declaration (`storageDisagrees`), and whether a narrow read's extension is read at all
// (`extensionImmaterial`). structure.ts's declaration-shape override reads these to decide when a
// bare global name would read or write something other than what the assembly does.
import { type DemandedBitsIndex, demandedBits } from '../ir/bits';
import { Fn, Op, Value } from '../ir/core';
import type { DeclaredStorage } from '../proto-context';
import type { SymbolInfo } from '../symbols';
import type { UseSite } from './analysis';

/** The storage a symbol map states for a scalar or pointer global ({@link DeclaredStorage}): its
 *  `size`, and for a scalar its `signed`, which the map leaves out where the type is no base type
 *  (an enum, a float) and so states no sign. A map does not say whether a scalar is an integer or a
 *  float, so it is `sized`, compared by width and sign alone. None for a name the map sizes not, or
 *  describes as no scalar. */
export function mappedStorage(info: SymbolInfo | undefined): DeclaredStorage | MappedStorage | undefined {
  if (info?.size === undefined || (info.shape !== 'scalar' && info.shape !== 'pointer')) {
    return undefined;
  }
  return { kind: 'sized', bytes: info.size, signed: info.shape === 'scalar' ? info.signed : undefined };
}

/** A symbol map's scalar ({@link mappedStorage}): an integer, a float or an enum it does not tell
 *  apart, of `bytes` bytes and the sign it states, if any. */
interface MappedStorage {
  kind: 'sized';
  bytes: number;
  signed: boolean | undefined;
}

/** One global's one access, as the declaration-shape override compares it with a declaration:
 *  `width` bytes at offset 0, and `signed` the extension of a read whose extension some use reads
 *  (undefined for a write, or a read every use of which takes only its own bytes:
 *  `extensionImmaterial`). It moves integer bits: no frontend models a float load or store of a
 *  global's relocated address (`lwc1`/`swc1` against a `%lo`, `lfs`/`stfs` against a small-data
 *  relocation decline loudly, and agbcc's soft-float helpers refuse an operand loaded from memory:
 *  raise/floathelpers.ts). */
interface GlobalAccess {
  width: number;
  signed: boolean | undefined;
}

/** Whether a global's declared storage disagrees with its one access: a bare name then reads or
 *  writes what the declaration says rather than what the assembly does. An integer agrees with an
 *  access of its own width, and a read narrower than a register with its sign too, a plain `char`
 *  by the target's `plainCharSigned`; a write stores the same bytes either way. A float agrees with
 *  no access, every one of which moves integer bits (`GlobalAccess`): `*(u16 *)&gF` reinterprets
 *  the bytes the bare name would convert. An enum is an integer of the target's `enumBytes`, with
 *  no sign this knows. What the target does not measure, or the context cannot read, agrees with
 *  nothing, which costs a spelling and never the C. No storage (no declaration) never disagrees. */
export function storageDisagrees(
  declared: DeclaredStorage | MappedStorage | undefined,
  access: GlobalAccess,
  facts: { enumBytes: number | undefined; plainCharSigned: boolean | undefined },
): boolean {
  switch (declared?.kind) {
    case undefined:
      return false;
    case 'unread':
    case 'reference':
      return true;
    case 'float':
      return true;
    case 'enum':
      return (
        declared.unsized ||
        facts.enumBytes === undefined ||
        storageDisagrees({ kind: 'integer', bytes: facts.enumBytes, signed: undefined }, access, facts)
      );
    case 'integer':
    case 'sized': {
      if (declared.bytes !== access.width) {
        return true;
      }
      const signed = declared.signed === 'char' ? facts.plainCharSigned : declared.signed;
      return access.width < 4 && access.signed !== undefined && signed !== access.signed;
    }
  }
}

/** Whether no use of the narrow `load` (`width` bytes) reads the bits its extension fills: no reader
 *  of its value needs a bit past its own bytes (`demandedBits`, which follows it through
 *  arithmetic, masks, shifts and extensions, and across an edge into the join it reaches). A
 *  zero-extending `lbz` whose only use is an `extsb` then reads the byte a signed declaration names,
 *  and its bare name is the same program; so does the read-modify-write `gN += x`, whose `ldrh` /
 *  `add` / `strh` stores the same halfword whichever way the read extended, and `gN & 0x7f`. A load
 *  nothing uses is not one: what reads it is out of sight. A `ret` reads every bit, whatever the
 *  function returns. */
export function extensionImmaterial(
  fn: Fn,
  load: Op,
  width: number,
  useSitesOf: ReadonlyMap<Value, readonly UseSite[]>,
  index: () => DemandedBitsIndex,
): boolean {
  const v = load.results[0];
  return (
    width < 4 &&
    (useSitesOf.get(v)?.length ?? 0) > 0 &&
    (demandedBits(fn, v, false, index()) & ~(2 ** (8 * width) - 1)) >>> 0 === 0
  );
}
