// asmlift — the reader of an integer LITERAL as GNU as reads it, for an immediate, a displacement or
// a shift amount in every frontend (Thumb's `#k`, the objdump `parseImm`/`parseMem` MIPS and PPC
// share, and each literal inside a Splat constant expression). Two grammars stay their own and
// narrower, and both fail closed where they differ from this one: the Thumb pool word
// (`POOL_MAGNITUDE`, a `.word` operand's addend, no leading zero at all) and the Thumb `.2byte`
// encoding (`halfwordLiteral`, four hex digits).
//
// An immediate, a displacement or a shift amount in assembly text is an EXPRESSION to gas: `#K`
// after `.set K, 2`, `#'a'`, `#2*2`, `#(3)`, and the radix prefixes `0b11` and `010` (octal) are
// all values the assembler resolves. `parseInt` reads none of them: it stops at the first character
// it cannot use, so a symbol or a character constant read as NaN and rendered as the text `NaN`,
// and everything that starts with digits read as its digit PREFIX — `#010` as 10 where gas encodes
// 8, `#2*2` as 2 where gas encodes 4, `#0b11` as 0 where gas encodes 3. Each of those is ordinary,
// compiling C with the wrong constant in it.
//
// So this is an ALLOWLIST of the spellings whose value is certain, and every other spelling is
// null for the caller to refuse: an optional sign, then a decimal without a leading zero, a `0x`/`0X`
// hex, or a run of zeros with at most one octal digit after it (`0`, `00`, `04`, `007`: octal to
// gas, and a single octal digit is the same value under any radix). Whitespace
// around the sign and the digits is gas's too (`# 7`, `#- 8`, `+ 8(a0)`).
// Each accepted spelling is pinned against the encoding `arm-none-eabi-as -mcpu=arm7tdmi` and
// `mips-linux-gnu-as -march=r4300` give it (test/gas-immediate.test.ts); objdump, the other
// producer, prints only decimal and `0x` hex.
//
// Reading the rest is deliberately not built. No compiler emits it: agbcc folds an enum, an octal
// and a character constant into a plain literal, and the only non-literal immediates over the
// vendored Thumb and Splat checkouts are in hand-written libraries that already decline. A reading
// of `.set`/`.equ` symbols or of gas's expression grammar would be a capability with no compiled
// inhabitant to referee it.

const GAS_INT_LITERAL = /^\s*([-+]?)\s*(0[xX][0-9a-fA-F]+|[1-9][0-9]*|0+[0-7]?)\s*$/;

/** The value of `text` when it is an integer literal whose gas value is certain (see the header),
 *  else null. Never a prefix of the text, never NaN. */
export function gasIntLiteral(text: string): number | null {
  const m = GAS_INT_LITERAL.exec(text);
  if (m === null) {
    return null;
  }
  const v = /^0[xX]/.test(m[2]) ? parseInt(m[2].slice(2), 16) : Number(m[2]);
  if (!Number.isSafeInteger(v)) {
    return null;
  }
  return m[1] === '-' ? 0 - v : v; // `0 - v`, not `-v`: `#-0` is 0, not -0
}
