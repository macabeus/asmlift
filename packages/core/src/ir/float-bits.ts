// asmlift IR — a double literal: the bit pattern the IR carries it as, and the C that spells it.
//
// THE IR CARRIES THE BITS, NOT A NUMBER, because a number has one value that is two doubles:
// `-0` prints and serializes as `0`, so a literal keyed or dumped by its number would be the
// other zero. Sixteen hex digits name exactly one double, NaN payloads included.

const view = new DataView(new ArrayBuffer(8));

/** The bit pattern, as sixteen hex digits, of the double whose high word (sign and exponent) is
 *  `hi` and low word is `lo`. */
export function doubleBits(hi: number, lo: number): string {
  return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
}

/** Whether `bits` is a double's bit pattern: sixteen hex digits, as `doubleBits` spells one. A
 *  single's eight would name another number read as a double, so nothing here takes one. */
export const isDoubleBits = (bits: unknown): bits is string => typeof bits === 'string' && /^[0-9a-f]{16}$/.test(bits);

/** The double a bit pattern names. */
export function doubleOf(bits: string): number {
  if (!isDoubleBits(bits)) {
    throw new Error(`'${bits}' is not a double's bit pattern`);
  }
  view.setUint32(0, parseInt(bits.slice(0, 8), 16));
  view.setUint32(4, parseInt(bits.slice(8, 16), 16));
  return view.getFloat64(0);
}

/** The C spelling of a finite double: the shortest decimal that reads back as the same double
 *  (ECMAScript's Number::toString, whose digits are the fewest that do), with a `.0` where it has
 *  neither a point nor an exponent, so C reads a `double` and not an `int`, and `-0.0` for the
 *  negative zero.
 *
 *  THAT IT READS BACK IS A PREMISE ABOUT THE COMPILER, and the one producer of a literal
 *  (`raise/floathelpers.ts`) runs only where the target states it
 *  (`compilerBehaviors.roundTripsDoubleLiterals`, which cites agbcc's source for it). */
export function doubleLiteral(bits: string): string {
  const x = doubleOf(bits);
  if (!Number.isFinite(x)) {
    throw new Error(`the double ${bits} is not finite and has no C literal`);
  }
  if (Object.is(x, -0)) {
    return '-0.0';
  }
  const s = String(x);
  return /[.e]/.test(s) ? s : `${s}.0`;
}
