// An immediate is read as GNU as reads it, or not at all (frontend/gas-int.ts). Every value below
// is the encoding the assembler gave the spelling, measured with `arm-none-eabi-as -mcpu=arm7tdmi`
// (`mov r0, #S`, `add sp, #S`, `ldr r0, [r1, #S]`) and `mips-linux-gnu-as -march=r4300 -mabi=32`
// (`addiu $v0, $zero, S`, `lw $v0, S($a0)`) and read back with objdump.
import { describe, expect, test } from 'vitest';

import { gasIntLiteral } from '../src/frontend/gas-int';

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
