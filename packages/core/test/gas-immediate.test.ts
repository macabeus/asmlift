// An immediate is read as GNU as reads it, or not at all (frontend/gas-int.ts). Every value below
// is the encoding the assembler gave the spelling, measured with `arm-none-eabi-as -mcpu=arm7tdmi`
// (`mov r0, #S`, `add sp, #S`, `ldr r0, [r1, #S]`) and `mips-linux-gnu-as -march=r4300 -mabi=32`
// (`addiu $v0, $zero, S`, `lw $v0, S($a0)`) and read back with objdump.
import { describe, expect, test } from 'vitest';

import { gasIntLiteral } from '../src/frontend/gas-int';
import { thumbEntryWordsFromText } from '../src/frontend/thumb-entry';
import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

describe('the integer literals whose gas value is certain', () => {
  test.each([
    ['0', 0],
    ['00', 0], // octal zero to gas, zero under any radix
    ['-0', 0],
    ['7', 7],
    ['255', 255],
    ['0x1f', 31],
    ['0X1F', 31],
    ['0x00ff', 255],
    ['+5', 5],
    ['+ 5', 5],
    ['-0x8', -8],
    ['- 8', -8],
    [' 7', 7],
    ['7 ', 7],
  ])('%j is %d', (text, want) => {
    expect(Object.is(gasIntLiteral(text), want)).toBe(true);
  });
});

// Each of these is a value gas resolves (or an error it raises), and a prefix reader answered
// something else: NaN for the symbol and the character, the digit prefix for the rest. The reader
// answers null and the frontend refuses.
describe('every other spelling is null, never a prefix', () => {
  test.each([
    ['K', 'a `.set`/`.equ` symbol: gas gives its value'],
    ["'a'", 'a character constant: gas 97'],
    ["'\\n'", 'an escaped character: gas 10'],
    ['010', 'octal: gas 8, a prefix reader 10'],
    ['04', 'octal: gas 4'],
    ['08', 'gas: garbage following instruction'],
    ['0b11', 'binary: gas 3, a prefix reader 0'],
    ['0o7', 'gas: garbage following instruction'],
    ['2*2', 'an expression: gas 4, a prefix reader 2'],
    ['2+1', 'gas 3'],
    ['-1+2', 'gas 1, a prefix reader -1'],
    ['0x10|1', 'gas 0x11'],
    ['(3)', 'gas 3'],
    ['~0xfe', 'gas: out of range'],
    ['1f', 'a local label reference: gas errors, a prefix reader 1'],
    ['0x', 'gas: missing expression'],
    ['0x7g', 'gas: garbage following instruction'],
    ['1e2', 'gas: garbage following instruction'],
    ['', 'nothing'],
    ['0x20000000000000', 'past 2^53: not a value a JS number holds exactly'],
  ])('%j (%s)', (text) => {
    expect(gasIntLiteral(text)).toBeNull();
  });
});

// THUMB. Every immediate reader of the frontend (the ALU, compare, shift and move arms, a
// `[rN, #k]` offset, the sp adjust, a pc-relative literal load, the incoming-stack-word scan) reads
// through it. Before, a symbol or a character lifted `return NaN;` and a prefix lifted ordinary,
// wrong C: `#010` as 10, `#2*2` as 2, `mul` by `#0b101` as `a0 * 0`.
describe('a Thumb immediate gas would resolve declines, and a literal lifts as gas encodes it', () => {
  const thumb = (body: string, pre = '') =>
    decompile('f', `${pre}\t.text\n\t.code 16\n\t.thumb_func\n\t.global f\nf:\n${body}`, ARMV4T_AGBCC).source;
  const REFUSED = /immediate '#[^']*(?:'[^']*')?[^']*' is not an integer literal/;

  test.each([
    ['\tmov\tr0, #K\n\tbx\tlr\n', '\t.set K, 2\n'],
    ['\tmov\tr0, #K\n\tbx\tlr\n', '\t.equ K, 2\n'],
    ['\tmov\tr0, #K\n\tbx\tlr\n', 'K = 2\n'],
    ['\tmov\tr0, #K\n\tbx\tlr\n', ''],
    ["\tmov\tr0, #'a'\n\tbx\tlr\n", ''],
    ["\tmov\tr0, #'\\n'\n\tbx\tlr\n", ''],
    ['\tmov\tr0, #(3)\n\tbx\tlr\n', ''],
    ['\tmov\tr0, #010\n\tbx\tlr\n', ''], // gas 8; was `return 10;`
    ['\tmov\tr0, #0b11\n\tbx\tlr\n', ''], // gas 3; was `return 0;`
    ['\tmov\tr0, #2*2\n\tbx\tlr\n', ''], // gas 4; was `return 2;`
    ['\tmov\tr0, #-1+2\n\tbx\tlr\n', ''], // gas 1; was `return -1;`
    ['\tadd\tr0, r0, #010\n\tbx\tlr\n', ''], // gas `adds r0, #8`; was `a0 + 10`
    ['\tsub\tr0, #010\n\tbx\tlr\n', ''],
    ['\tlsl\tr0, r0, #010\n\tbx\tlr\n', ''],
    ['\tlsr\tr0, r0, #2+1\n\tbx\tlr\n', ''], // gas 3; was `>> 2`
    ['\tldrb\tr0, [r0, #010]\n\tbx\tlr\n', ''], // gas `#8`; was `a0[10]`
    ['\tldrh\tr0, [r0, #010]\n\tbx\tlr\n', ''], // gas `#8`; was `a0[5]`
    ['\tldrb\tr0, [r0, #2*2]\n\tbx\tlr\n', ''], // gas `#4`; was `a0[2]`
    ['\tldr\tr0, [r0, #K]\n\tbx\tlr\n', '\t.set K, 4\n'], // was a decline only by accident ("offset NaN")
    ['\tcmp\tr0, #010\n\tbeq\t.L1\n\tmov\tr0, #0\n.L1:\n\tbx\tlr\n', ''], // was `a0 != 10`
    ['\tmov\tr1, #0b101\n\tmul\tr0, r1\n\tbx\tlr\n', ''], // gas 5; was `a0 * 0`
    ['\tmov\tr0, #1f\n\tbx\tlr\n', ''], // gas errors; was `return 1;`
    ['\tldr\tr0, [pc, #010]\n\tbx\tlr\n\t.align 2\n\t.word 1\n\t.word 2\n\t.word 3\n\t.word 4\n', ''], // a pool word
    [
      '\tpush\t{lr}\n\tsub\tsp, #010\n\tmov\tr1, #3\n\tstr\tr1, [sp, #4]\n\tldr\tr0, [sp, #4]\n\tadd\tsp, #010\n\tpop\t{r1}\n\tbx\tr1\n',
      '',
    ],
  ])('%j declines', (body, pre) => {
    expect(() => thumb(body, pre)).toThrow(REFUSED);
  });

  test.each([
    ['\tmov\tr0, #0x10\n\tbx\tlr\n', 'return 16;'],
    ['\tmov\tr0, #0X1F\n\tbx\tlr\n', 'return 31;'],
    ['\tmov\tr0, # 7\n\tbx\tlr\n', 'return 7;'],
    ['\tadd\tr0, r0, #8\n\tbx\tlr\n', 'return a0 + 8;'],
    ['\tldrb\tr0, [r0, #0x8]\n\tbx\tlr\n', 'return a0[8];'],
    ['\tldrh\tr0, [r0, #8]\n\tbx\tlr\n', 'return a0[4];'],
  ])('%j lifts as gas encodes it', (body, want) => {
    expect(thumb(body)).toContain(want);
  });

  // The incoming-stack-word scan (frontend/thumb-entry.ts) read `[sp, #020]` as word 5, where gas
  // encodes 16, word 4. It now stops at a spelling it cannot value, as at any frame access it does
  // not read, and answers no bound.
  test('the callee entry scan answers no bound past an octal frame offset', () => {
    const entry = (k: string) => thumbEntryWordsFromText('g', `g:\n\tldr\tr0, [sp, ${k}]\n\tbx\tlr\n`);
    expect(entry('#0x10')).toBe(5);
    expect(entry('#16')).toBe(5);
    expect(entry('#020')).toBeUndefined();
    expect(entry('#4*4')).toBeUndefined();
  });
});
