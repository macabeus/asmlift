// A CodeWarrior object read as ONE function's. A row compiled in its own unit (`tu: "unit"`) builds an
// object holding every function the unit defines before it, and everything downstream of the target is about
// the row's function alone: the listing both decompilers are handed, the codegen tags read off it, the
// data dump the m2c normalizer and asmlift's jump-table reader take, and the `targetAsm` and `asmDump` the
// row publishes. An object that holds one function is its own scope, and reads the same either way.
import { firstFunctionHeader, sliceSymbol } from '@asmlift/core/frontend/disasm';

/** `objdump -d -r` text of `sym` alone: the listing's header, then the function's own lines.
 *
 *  Read whole, Mario Party 4's `fn_2_E66C` is 555 KB, and `fn_1_C2BC` — two float stores — was tagged
 *  `libm-call`, `savegpr-helper`, `float-compare` and `float-callee-save` by the unit's other functions.
 *  objdump's own `--disassemble=<sym>` is no answer: binutils 2.40 prints every earlier function's
 *  relocations under the symbol's first instruction. */
export function functionDisassembly(asm: string, sym: string): string {
  const firstFunction = firstFunctionHeader(asm);
  return firstFunction === -1 ? asm : `${asm.slice(0, firstFunction)}${sliceSymbol(asm, sym).trimEnd()}\n`;
}

/** `objdump -s -r -t` text with its `.text` relocations and contents narrowed to `sym`'s own bytes. Its
 *  symbol table and every other section stay whole: a data section is shared by the unit's functions, and
 *  a jump table or a constant the function reads is found in it by name. Neither reader takes anything else
 *  from `.text` — Mario Party 4's `HandleNote` dump was 116 KB, 81 KB of them the unit's other code. */
export function functionScopedDump(dump: string, sym: string): string {
  const fn = new RegExp(`^([0-9a-f]{8})\\s.*\\sF \\.text\\t([0-9a-f]{8}) ${escapeRegExp(sym)}$`, 'm').exec(dump);
  if (fn === null) {
    return dump;
  }
  const start = parseInt(fn[1], 16);
  const end = start + parseInt(fn[2], 16);
  let block = '';
  return dump
    .split('\n')
    .filter((line) => {
      if (/^(?:RELOCATION RECORDS FOR \[|Contents of section |SYMBOL TABLE:)/.test(line)) {
        block = line;
        return true;
      }
      if (block === 'RELOCATION RECORDS FOR [.text]:') {
        const at = /^([0-9a-f]{8}) /.exec(line);
        return at === null || (parseInt(at[1], 16) >= start && parseInt(at[1], 16) < end);
      }
      if (block === 'Contents of section .text:') {
        const at = /^ ([0-9a-f]{4,8}) /.exec(line);
        return at === null || (parseInt(at[1], 16) < end && parseInt(at[1], 16) + 16 > start);
      }
      return true;
    })
    .join('\n');
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
