// asmlift — the bytes gas does not read as text. A control byte other than TAB (and a CR that closes
// a CRLF line) ends a statement for gas, or worse, where the readers here would keep it inside one
// (arm-none-eabi-as and mips-linux-gnu-as measured: `mov r0, #1<NUL>add r0, #2` assembles both
// instructions, and `.globl f<NUL>.set reorder` runs the `.set reorder`). Every reader that cuts
// GNU-as text into statements declines a line that holds one. UTF-8 and other non-ASCII bytes are
// not in the set.
export const CONTROL_BYTE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]|\r(?!$)/;
