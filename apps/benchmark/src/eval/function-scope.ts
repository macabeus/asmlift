// A CodeWarrior object read as ONE function's. A row compiled in its own unit (`tu: "unit"`) builds an
// object holding every function the unit defines before it, and everything downstream of the target is about
// the row's function alone: the listing both decompilers are handed, the codegen tags read off it, the
// data dump the m2c normalizer and asmlift's jump-table reader take, and the `targetAsm` and `asmDump` the
// row publishes. An object that holds one function is its own scope, and reads the same either way.
import { firstFunctionHeader, sliceSymbol } from '@asmlift/core/frontend/disasm';
import { classifyRelocSymbol } from '@asmlift/core/frontend/reloc-symbol';

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
 *  from `.text` — Mario Party 4's `HandleNote` dump was 116 KB, 81 KB of them the unit's other code.
 *
 *  One kind of `.text` relocation outside the function stays: another function's naming a function-scope
 *  static this one names. That is the evidence asmlift reads to refuse re-declaring a static inside a
 *  function that does not own it alone (core `frontend/local-object.ts`): an inlined static function's
 *  `n$4` is addressed by every caller and by the function itself. */
export function functionScopedDump(dump: string, sym: string): string {
  const fn = new RegExp(`^([0-9a-f]{8})\\s.*\\sF \\.text\\t([0-9a-f]{8}) ${escapeRegExp(sym)}$`, 'm').exec(dump);
  if (fn === null) {
    return dump;
  }
  const start = parseInt(fn[1], 16);
  const end = start + parseInt(fn[2], 16);
  const inFn = (at: number) => at >= start && at < end;
  const lines = inBlocks(dump.split('\n'));
  const ownStatics = new Set(
    lines.flatMap(({ line, block }) => {
      const r = block === TEXT_RELOCS ? textReloc(line) : null;
      return r !== null && inFn(r.at) && classifyRelocSymbol(r.sym) === 'local-static' ? [r.sym] : [];
    }),
  );
  return lines
    .filter(({ line, block }) => {
      if (block === TEXT_RELOCS) {
        const r = textReloc(line);
        return r === null || inFn(r.at) || ownStatics.has(r.sym);
      }
      if (block === 'Contents of section .text:') {
        const at = /^ ([0-9a-f]{4,8}) /.exec(line);
        return at === null || (parseInt(at[1], 16) < end && parseInt(at[1], 16) + 16 > start);
      }
      return true;
    })
    .map(({ line }) => line)
    .join('\n');
}

const TEXT_RELOCS = 'RELOCATION RECORDS FOR [.text]:';

/** Each line of a dump with the header of the block it sits in (a header is its own block). */
function inBlocks(lines: string[]): { line: string; block: string }[] {
  let block = '';
  return lines.map((line) => {
    if (/^(?:RELOCATION RECORDS FOR \[|Contents of section |SYMBOL TABLE:)/.test(line)) {
      block = line;
    }
    return { line, block };
  });
}

/** A relocation line's offset and the symbol it names without its addend, or null for another line. */
function textReloc(line: string): { at: number; sym: string } | null {
  const r = /^([0-9a-f]{8})\s+\S+\s+(\S+)$/.exec(line);
  return r === null ? null : { at: parseInt(r[1], 16), sym: r[2].replace(/[+-]0x[0-9a-f]+$/, '') };
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
