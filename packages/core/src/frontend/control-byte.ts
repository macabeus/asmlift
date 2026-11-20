// asmlift — the bytes gas does not read as text. A control byte other than TAB (and a CR that closes
// a CRLF line) ends a statement for gas, or worse, where the readers here would keep it inside one
// (arm-none-eabi-as and mips-linux-gnu-as measured: `mov r0, #1<NUL>add r0, #2` assembles both
// instructions, and `.globl f<NUL>.set reorder` runs the `.set reorder`). Every reader that cuts
// GNU-as text into statements declines a line that holds one. UTF-8 and other non-ASCII bytes are
// not in the set.
export const CONTROL_BYTE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]|\r(?!$)/;

/** gas's blank space on a line: space and TAB (a CR is only ever the end of a CRLF line here, since
 *  one elsewhere is a {@link CONTROL_BYTE}). JS `trim()` and `\s` also take U+00A0, U+2028, U+3000
 *  and the like, which gas reads as name characters (mips-linux-gnu-as: `.set noreorder<U+00A0>` is
 *  an unrecognised option and leaves the mode alone), so the readers trim with this instead. */
export const asciiTrim = (text: string): string => text.replace(/^[ \t\r]+|[ \t\r]+$/g, '');

/** A code point gas does not read as this reader does: anything outside ASCII. A reader declines
 *  a line that holds one in code (a directive, a label, an operand); inside a comment or a string
 *  or character literal it is text, and stays allowed. */
export const isNonAscii = (c: string): boolean => c > '\x7f';
