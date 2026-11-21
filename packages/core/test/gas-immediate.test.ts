// An immediate is read as GNU as reads it, or not at all (frontend/gas-int.ts). Every value below
// is the encoding the assembler gave the spelling, measured with `arm-none-eabi-as -mcpu=arm7tdmi`
// (`mov r0, #S`, `add sp, #S`, `ldr r0, [r1, #S]`) and `mips-linux-gnu-as -march=r4300 -mabi=32`
// (`addiu $v0, $zero, S`, `lw $v0, S($a0)`) and read back with objdump.
import { describe, expect, test } from 'vitest';

import { parseImm, parseMem } from '../src/frontend/disasm';
import { gasIntLiteral } from '../src/frontend/gas-int';
import { thumbEntryWordsFromText } from '../src/frontend/thumb-entry';
import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC, MIPS_GCC, PPC_MWCC } from '../src/target';

describe('the integer literals whose gas value is certain', () => {
  test.each([
    ['0', 0],
    ['00', 0], // octal zero to gas, zero under any radix
    ['04', 4], // one octal digit: the same value under any radix (`movs r0, #4`, `addiu v0,a0,4`)
    ['007', 7],
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

// The shared objdump readers THROW on a spelling they cannot value, rather than answering a NaN each
// frontend had to remember to refuse (PPC did not: `li r3,K` lifted `return NaN;`).
describe('the shared objdump readers refuse instead of answering a sentinel', () => {
  test.each([['K'], ['2*2'], ['010'], ["'a'"], ['']])('parseImm(%j) throws', (text) => {
    expect(() => parseImm(text)).toThrow(/is not an integer literal/);
  });
  test('parseImm reads a literal', () => {
    expect(parseImm('-0x8')).toBe(-8);
  });
  test.each([['8(a0) /* c */'], ['8(a0)x'], ['(a0'], ['8(a0)(a1)']])('parseMem(%j) throws', (text) => {
    expect(() => parseMem(text)).toThrow(/memory operand/);
  });
  test.each([
    ['8(a0)', { off: 8, base: 'a0' }],
    ['(a0)', { off: 0, base: 'a0' }],
    ['a0', { off: 0, base: 'a0' }],
  ])('parseMem(%j) reads', (text, want) => {
    expect(parseMem(text)).toEqual(want);
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
    ['08', 'gas: garbage following instruction'],
    ['011', 'octal: gas 9, a prefix reader 11'],
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
    ['\tmov\tr0, #04\n\tbx\tlr\n', 'return 4;'], // gas `movs r0, #4`
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

// MIPS AND PPC. The shared objdump reader (frontend/disasm.ts) was the same prefix reader, reached by
// MIPS and PPC objdump text and by a Splat operand Splat hands on unread: `2*2` read as 2, `0b11`
// as 0, `addi r3,r3,2+1` as `+ 2`. MIPS already refused a NaN; PPC rendered it (`li r3,K` lifted
// `return NaN;`). A memory operand's displacement that is not a literal (`2*4(a0)`) fell back to
// offset 0. Splat folds a parenthesised expression itself (`(2*2)`, `(8)($a0)`) and still does.
describe('a MIPS or PPC immediate that is not an integer literal declines', () => {
  const obj = (lines: string[]) =>
    `00000000 <f>:\n${lines.map((l, i) => `   ${(i * 4).toString(16)}:\t${l}`).join('\n')}\n`;
  const splat = (line: string, word: string) =>
    `.set noat\n.set noreorder\n\n.text\nglabel f\n    /* 0 80000000 ${word} */  ${line}\n` +
    `    /* 4 80000004 03E00008 */  jr          $ra\n    /* 8 80000008 00000000 */   nop\n`;
  const ppc = (text: string) => decompile('f', text, PPC_MWCC).source;
  const mips = (text: string) => decompile('f', text, MIPS_GCC).source;
  const REFUSED =
    /is not an integer literal|non-numeric immediate|unparsable constant expression|is not a displacement and a base register/;

  // the word in each Splat comment is mips-linux-gnu-as's encoding of the line
  test.each([
    ['addiu       $v0, $zero, 2*2', '24020004'], // gas 4; was `return 2;`
    ['addiu       $v0, $zero, 0b11', '24020003'], // gas 3; was `return 0;`
    ['addiu       $v0, $zero, -1+2', '24020001'], // gas 1; was `return -1;`
    ['sll         $v0, $a0, 2+1', '000410C0'], // gas 3; was `<< 2`
    ['slti        $v0, $a0, 2+1', '28820003'], // gas 3; was `< 2`
    ['ori         $v0, $zero, 0x10|1', '34020011'], // gas 0x11; was 16
    // a comment between two terms hid the rest of the expression from a reader that cut at it
    ['addiu       $v0, $a0, 0x8 /* x */ + 1 /* y */', '24820009'], // gas 9; was `a0 + 8`
    ['addiu       $v0, $a0, 8 /* x */ - 2 /* y */', '24820006'], // gas 6; was `a0 + 8`
    ['sll         $v0, $a0, 2 /* a */ + 1 /* b */', '000410C0'], // gas 3; was `<< 2`
    ['addiu       $v0, $a0, 0x20/* a */+1/* b */', '24820021'], // gas 33; was `a0 + 32`
    // a symbol inside an expression: the tokenizer skipped the `K` and read `K1` as 1
    ['addiu       $v0, $a0, (0x10 + K1)', '24820012'], // gas 18 under `.set K1, 2`; was `a0 + 17`
    ['lw          $v0, K1($a0)', '8C820002'],
  ])('Splat `%s` declines', (line, word) => {
    expect(() => mips(splat(line, word))).toThrow(REFUSED);
  });

  test.each([
    ['addiu       $v0, $zero, (2*2)', '24020004', 'return 4;'],
    ['lw          $v0, 2*4($a0)', '8C820008', 'return a0[2];'],
    ['addiu       $v0, $zero, 4', '24020004', 'return 4;'],
    // a block comment is whitespace to gas wherever it sits; Splat writes one after an instruction
    // it did not attribute to the compiler (af's `addi` lines, marioparty3's OS `lw`/`sw` lines)
    ['addi        $v0, $a0, 0x20 /* handwritten instruction */', '20820020', 'return a0 + 32;'],
    ['lw          $v0, 0x8($a0) /* handwritten instruction */', '8C820008', 'return a0[2];'], // was `*a0`
    ['lw          $v0, -0x8($a0) /* handwritten instruction */', '8C82FFF8', 'return a0[-2];'], // was `*a0`
    ['lw          $v0, 0x8 /* c */ ($a0)', '8C820008', 'return a0[2];'],
    ['lw          $v0, /* c */ 0x8($a0)', '8C820008', 'return a0[2];'],
    ['lw          $v0, 0x8($a0 /* c */)', '8C820008', 'return a0[2];'], // was `*a0`
    ['lw          $v0, 0x8( $a0 )', '8C820008', 'return a0[2];'], // was `*a0`
    ['addiu       $v0, $a0, (0x8) /* c */', '24820008', 'return a0 + 8;'], // was a decline
    ['addiu       $v0, $a0, (0X8 + 1)', '24820009', 'return a0 + 9;'],
    ['lw          $v0, 0X8($a0)', '8C820008', 'return a0[2];'], // was a decline
    ['addiu       $v0, $a0, 0XFFFF', '2482FFFF', 'return a0 + -1;'], // was `a0 + 65535`
    ['addiu       $v0, $a0, 07', '24820007', 'return a0 + 7;'],
  ])('Splat `%s` lifts as gas encodes it', (line, word, want) => {
    expect(mips(splat(line, word))).toContain(want);
  });

  test.each([
    ['li\tv0,2*2'],
    ['addiu\tv0,a0,2+1'],
    ['lw\tv0,2*4(a0)'],
    ['li\tv0,0b11'],
    ['sll\tv0,a0,2+1'],
    ['lw\tv0,8(a0) junk'], // a memory operand that is not `X(base)`: the fallback read offset 0
  ])('MIPS objdump `%s` declines', (line) => {
    expect(() => mips(obj([line, 'jr\tra', 'nop']))).toThrow(REFUSED);
  });

  test.each([
    ['li      r3,K'], // was `return NaN;`
    ['li      r3,2*2'],
    ['li      r3,010'],
    ['lwz     r3,K(r4)'],
    ['addi    r3,r3,2+1'],
    ['li      r3,0b11'],
    ["li      r3,'a'"], // was `return NaN;`
    ['lwz     r3,2*4(r3)'],
    ['slwi    r3,r3,2+1'],
    ['cmpwi   r3,K'],
  ])('PPC `%s` declines', (line) => {
    expect(() => ppc(obj([line, 'blr']))).toThrow(REFUSED);
  });

  test.each([
    ['li      r3,16', 'return 16;'],
    ['li      r3,0x10', 'return 16;'],
    ['lwz     r3,8(r3)', 'return a0[2];'],
    ['addi    r3,r3,3', 'return a0 + 3;'],
  ])('PPC `%s` lifts', (line, want) => {
    expect(ppc(obj([line, 'blr']))).toContain(want);
  });
});
