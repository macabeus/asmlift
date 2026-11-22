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
// frontend would have to remember to refuse.
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

// Each of these is a value gas resolves (or an error it raises), and a prefix reader answers
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
// through it, so neither a symbol nor a character lifts `return NaN;` and no prefix lifts ordinary,
// wrong C (`#010` as 10, `#2*2` as 2, `mul` by `#0b101` as `a0 * 0`).
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
    ['\tmov\tr0, #010\n\tbx\tlr\n', ''], // gas 8; not `return 10;`
    ['\tmov\tr0, #0b11\n\tbx\tlr\n', ''], // gas 3; not `return 0;`
    ['\tmov\tr0, #2*2\n\tbx\tlr\n', ''], // gas 4; not `return 2;`
    ['\tmov\tr0, #-1+2\n\tbx\tlr\n', ''], // gas 1; not `return -1;`
    ['\tadd\tr0, r0, #010\n\tbx\tlr\n', ''], // gas `adds r0, #8`; not `a0 + 10`
    ['\tsub\tr0, #010\n\tbx\tlr\n', ''],
    ['\tlsl\tr0, r0, #010\n\tbx\tlr\n', ''],
    ['\tlsr\tr0, r0, #2+1\n\tbx\tlr\n', ''], // gas 3; not `>> 2`
    ['\tldrb\tr0, [r0, #010]\n\tbx\tlr\n', ''], // gas `#8`; not `a0[10]`
    ['\tldrh\tr0, [r0, #010]\n\tbx\tlr\n', ''], // gas `#8`; not `a0[5]`
    ['\tldrb\tr0, [r0, #2*2]\n\tbx\tlr\n', ''], // gas `#4`; not `a0[2]`
    ['\tldr\tr0, [r0, #K]\n\tbx\tlr\n', '\t.set K, 4\n'], // named, not "offset NaN"
    ['\tcmp\tr0, #010\n\tbeq\t.L1\n\tmov\tr0, #0\n.L1:\n\tbx\tlr\n', ''], // not `a0 != 10`
    ['\tmov\tr1, #0b101\n\tmul\tr0, r1\n\tbx\tlr\n', ''], // gas 5; not `a0 * 0`
    ['\tmov\tr0, #1f\n\tbx\tlr\n', ''], // gas errors; not `return 1;`
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

  // The incoming-stack-word scan (frontend/thumb-entry.ts) stops at a spelling it cannot value, as
  // at any frame access it does not read, and answers no bound: `[sp, #020]` is 16 to gas, word 4,
  // and a prefix reader would answer word 5.
  test('the callee entry scan answers no bound past an octal frame offset', () => {
    const entry = (k: string) => thumbEntryWordsFromText('g', `g:\n\tldr\tr0, [sp, ${k}]\n\tbx\tlr\n`);
    expect(entry('#0x10')).toBe(5);
    expect(entry('#16')).toBe(5);
    expect(entry('#020')).toBeUndefined();
    expect(entry('#4*4')).toBeUndefined();
  });
});

// MIPS AND PPC. The shared objdump reader (frontend/disasm.ts) is reached by MIPS and PPC objdump
// text and by an operand Splat hands on unread (`2*2`, `0b11`, `addi r3,r3,2+1`, `li r3,K`), and by
// a memory operand whose displacement is not a literal (`2*4(a0)`); each declines. Splat folds a
// parenthesised expression itself (`(2*2)`, `(8)($a0)`).
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
    ['addiu       $v0, $zero, 2*2', '24020004'], // gas 4; not `return 2;`
    ['addiu       $v0, $zero, 0b11', '24020003'], // gas 3; not `return 0;`
    ['addiu       $v0, $zero, -1+2', '24020001'], // gas 1; not `return -1;`
    ['sll         $v0, $a0, 2+1', '000410C0'], // gas 3; not `<< 2`
    ['slti        $v0, $a0, 2+1', '28820003'], // gas 3; not `< 2`
    ['ori         $v0, $zero, 0x10|1', '34020011'], // gas 0x11; not 16
    // a comment between two terms hides the rest of the expression from a reader that cuts at it
    ['addiu       $v0, $a0, 0x8 /* x */ + 1 /* y */', '24820009'], // gas 9; not `a0 + 8`
    ['addiu       $v0, $a0, 8 /* x */ - 2 /* y */', '24820006'], // gas 6; not `a0 + 8`
    ['sll         $v0, $a0, 2 /* a */ + 1 /* b */', '000410C0'], // gas 3; not `<< 2`
    ['addiu       $v0, $a0, 0x20/* a */+1/* b */', '24820021'], // gas 33; not `a0 + 32`
    // a symbol inside an expression: a tokenizer that skips the `K` reads `K1` as 1
    ['addiu       $v0, $a0, (0x10 + K1)', '24820012'], // gas 18 under `.set K1, 2`; not `a0 + 17`
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
    ['lw          $v0, 0x8($a0) /* handwritten instruction */', '8C820008', 'return a0[2];'], // not `*a0`
    ['lw          $v0, -0x8($a0) /* handwritten instruction */', '8C82FFF8', 'return a0[-2];'], // not `*a0`
    ['lw          $v0, 0x8 /* c */ ($a0)', '8C820008', 'return a0[2];'],
    ['lw          $v0, /* c */ 0x8($a0)', '8C820008', 'return a0[2];'],
    ['lw          $v0, 0x8($a0 /* c */)', '8C820008', 'return a0[2];'], // not `*a0`
    ['lw          $v0, 0x8( $a0 )', '8C820008', 'return a0[2];'], // not `*a0`
    ['addiu       $v0, $a0, (0x8) /* c */', '24820008', 'return a0 + 8;'], // not a decline
    ['addiu       $v0, $a0, (0X8 + 1)', '24820009', 'return a0 + 9;'],
    ['lw          $v0, 0X8($a0)', '8C820008', 'return a0[2];'], // not a decline
    ['addiu       $v0, $a0, 0XFFFF', '2482FFFF', 'return a0 + -1;'], // not `a0 + 65535`
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
    ['li      r3,K'], // not `return NaN;`
    ['li      r3,2*2'],
    ['li      r3,010'],
    ['lwz     r3,K(r4)'],
    ['addi    r3,r3,2+1'],
    ['li      r3,0b11'],
    ["li      r3,'a'"], // not `return NaN;`
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

describe('a Splat operand is read in the slot gas reads it in', () => {
  const splat = (lines: [string, string][]) =>
    `.set noat\n.set noreorder\n.set FS, 0x18\n\n.text\nglabel f\n` +
    lines
      .map(
        ([line, word], i) =>
          `    /* ${(i * 4).toString(16)} ${(0x80000000 + i * 4).toString(16)} ${word} */  ${line}\n`,
      )
      .join('');
  const leaf = (line: string, word: string) =>
    splat([
      [line, word],
      ['jr          $ra', '03E00008'],
      ['nop', '00000000'],
    ]);
  const mips = (text: string) => decompile('f', text, MIPS_GCC).source;

  // each word is mips-linux-gnu-as -march=r4300's encoding of the line, and each `not` names the misreading
  test.each([
    ['lw          $v0, 0x8', '8C020008'], // gas `lw v0,8(zero)`; not `return *a0;`
    ['lbu         $v0, 0x8', '90020008'], // gas `lbu v0,8(zero)`; not `return *a0;` (u8)
    ['sw          $a1, 0x10', 'AC050010'], // gas `sw a1,16(zero)`; not `*a2 = a1;`
    ['addu        $v0, $a0, 8', '24820008'], // gas `addiu v0,a0,8`; not `return a0 + a1;`
    ['and         $v0, $a0, 0xFF', '308200FF'], // gas `andi`; not `return a0 & a1;`
    ['or          $v0, $a0, 1', '34820001'], // gas `ori`; not `return a0 | a1;`
    ['sltu        $v0, $a0, 5', '2C820005'], // gas `sltiu`; not `return a0 < a1;`
    ['sll         $v0, $a0, $2', '00441004'], // gas `sllv v0,a0,v0`; not `return a0 << 2;`
    ['addu        $v0, $4, $5', '00851021'], // a numbered register is no name this frontend reads
    ['addiu       $v0, a0, 1', '00000000'], // gas: "operand 2 must be constant" (a0 is a symbol)
    ['lw          $v0, 4(a0)', '00000000'], // gas: "invalid operands"
    ['addiu       $v0, $a0, 0x10000', '00000000'], // gas: "operand 3 out of range"; not `a0 + 0`
    ['slti        $v0, $a0, 0x10000', '00000000'], // gas: "operand 3 out of range"
  ])('`%s` declines', (line, word) => {
    expect(() => mips(leaf(line, word))).toThrow(
      /read as a register|non-numeric immediate|without the '\$'|16-bit field/,
    );
  });

  test.each([
    ['slti        $v0, $a0, 0xFFFF', '2882FFFF', 'return a0 < -1;'], // gas -1; not `a0 < 65535`
    ['slti        $v0, $a0, 0x8000', '28828000', 'return a0 < -32768;'], // not `a0 < 32768`
    ['sltiu       $v0, $a0, 0xFFFF', '2C82FFFF', 'return a0 < -1;'], // u32 a0 against 0xFFFFFFFF
    ['slti        $v0, $a0, -1', '2882FFFF', 'return a0 < -1;'],
    ['sll         $v0, $a0, 2', '00041080', 'return a0 << 2;'],
    // gas's precedence, not C's: three left-associative levels, `* << >>` over `| & ^` over `+ -`
    ['addiu       $v0, $a0, (3 | 1 + 1)', '24820004', 'return a0 + 4;'], // not `a0 + 3`
    ['addiu       $v0, $a0, (1 + 2 << 3)', '24820011', 'return a0 + 17;'], // not `a0 + 24`
    ['addiu       $v0, $a0, (4 | 1 & 2)', '24820000', 'return a0 + 0;'], // not `a0 + 4`
    ['addiu       $v0, $a0, (2 << 1 * 3)', '2482000C', 'return a0 + 12;'], // not `a0 + 16`
    ['addiu       $v0, $a0, (1 - 2 - 3)', '2482FFFC', 'return a0 + -4;'],
    ['addiu       $v0, $a0, (~1 + 3)', '24820001', 'return a0 + 1;'],
    ['lw          $v0, (4 | 4 + 4)($a0)', '8C820008', 'return a0[2];'], // not `a0[3]`
    ['lw          $v0, (0x12345678 >> 16)($a0)', '8C821234', 'return a0[1165];'],
  ])('`%s` lifts as gas encodes it', (line, word, want) => {
    expect(mips(leaf(line, word))).toContain(want);
  });
  test('`sw $a1, (4 | 4 + 4)($a0)` stores where gas encodes it', () => {
    expect(mips(leaf('sw          $a1, (4 | 4 + 4)($a0)', 'AC850008'))).toContain('a0[2] = a1;'); // not a0[3]
  });

  // the epilogue's release is read: a symbol, an expression or another size than the push declines
  const framed = (release: string) =>
    splat([
      ['addiu       $sp, $sp, -0x18', '27BDFFE8'],
      ['sw          $ra, 0x14($sp)', 'AFBF0014'],
      ['jal         g', '0C000000'],
      ['nop', '00000000'],
      ['lw          $ra, 0x14($sp)', '8FBF0014'],
      ['jr          $ra', '03E00008'],
      [`addiu       $sp, $sp, ${release}`, '27BD0018'],
    ]);
  test.each([['FS'], ['0x18 + 0x8'], ['0x10']])('a release by `%s` declines (not `return g();`)', (r) => {
    expect(() => mips(framed(r))).toThrow(/non-numeric immediate|releases no frame/);
  });
  test('the release of the bytes pushed lifts', () => {
    expect(mips(framed('0x18'))).toContain('return g();');
  });
});

// A LITERAL PAST A 32-BIT WORD has no gas value that is the number it spells: arm-none-eabi-as
// truncates it without a word (`mov r0, #0x100000008` assembles `movs r0, #8`) and mips-linux-gnu-as
// refuses it ("number larger than 32 bits"). Read as the number, each would lift the wider constant.
describe('a literal reads only inside a 32-bit word', () => {
  test.each([
    ['0xFFFFFFFF', 0xffffffff],
    ['4294967295', 0xffffffff],
    ['-0x80000000', -0x80000000],
  ])('%j is %d', (text, want) => {
    expect(gasIntLiteral(text)).toBe(want);
  });
  test.each([['0x100000000'], ['4294967296'], ['-0x80000001'], ['-4294967295']])('%j is null', (text) => {
    expect(gasIntLiteral(text)).toBeNull();
  });

  const thumb = (body: string) =>
    decompile('f', `\t.text\n\t.code 16\n\t.thumb_func\n\t.global f\nf:\n${body}\tbx\tlr\n`, ARMV4T_AGBCC).source;
  test.each([
    ['\tmov\tr0, #0x100000008\n'], // gas `movs r0, #8`; not `return 4294967304;`
    ['\tldr\tr0, [r0, #0x100000004]\n'], // gas `#4`; not `a0[1073741825]`
    ['\tcmp\tr0, #0x100000000\n\tbeq\t.L1\n\tmov\tr0, #1\n.L1:\n'], // gas `#0`
    ['\tmov\tr0, #-4294967295\n'], // gas 1
    ['\tadd\tr0, r0, #0x100000003\n'], // gas 3
    ['\tadd\tsp, #-0x100000000\n'], // gas `add sp, #0`; not a heap exhaustion
  ])('Thumb %j declines', (body) => {
    expect(() => thumb(body)).toThrow(/is not an integer literal/);
  });
});

// EVERY THUMB IMMEDIATE is read once per instruction before any lowering (frontend/thumb.ts
// `refuseUnreadableImmediates`), so a refusal names the function and the instruction.
describe('a Thumb immediate gas would resolve declines naming the function and the instruction', () => {
  const thumb = (body: string, pre = '') =>
    decompile('f', `${pre}\t.text\n\t.code 16\n\t.thumb_func\n\t.global f\nf:\n${body}\tbx\tlr\n`, ARMV4T_AGBCC).source;
  test.each([
    ['\tldrb\tr0, [r0, #K]\n', "'ldrb r0, [r0, #K]'"],
    ['\tsub\tsp, #K\n\tadd\tsp, #K\n', "'sub sp, #K'"],
  ])('%j', (body, instr) => {
    expect(() => thumb(body, '\t.set K, 2\n')).toThrow(
      `cannot lift 'f': ${instr} — immediate '#K' is not an integer literal`,
    );
  });
});

// SPLAT, THE REST. Each word is mips-linux-gnu-as -march=r4300's encoding of the line, 00000000
// where gas refuses it.
describe('a Splat operand holds the value gas gives it, or declines', () => {
  const splat = (lines: [string, string][]) =>
    `.set noat\n.set noreorder\n\n.text\nglabel f\n` +
    lines
      .map(
        ([line, word], i) =>
          `    /* ${(i * 4).toString(16)} ${(0x80000000 + i * 4).toString(16)} ${word} */  ${line}\n`,
      )
      .join('');
  const leaf = (...lines: [string, string][]) =>
    splat([...lines, ['jr          $ra', '03E00008'], ['nop', '00000000']]);
  const mips = (text: string) => decompile('f', text, MIPS_GCC).source;

  // gas evaluates in a 64-bit word: wrapped 32-bit arithmetic with shift counts mod 32 misreads these
  test.each([
    ['ori         $v0, $zero, (0x1000 >> 32)', '34020000'], // gas 0; not `return 4096;`
    ['ori         $v0, $zero, ((1 << 36) >> 24)', '34021000'], // gas 0x1000; not `return 0;`
    ['ori         $v0, $zero, ((0x80000000 << 1) >> 17)', '34028000'], // gas 0x8000; not 0
    ['ori         $v0, $zero, ((0x10000 * 0x10000) >> 20)', '34021000'], // gas 0x1000; not 0
    ['addiu       $v0, $a0, (0x1000 >> 32)', '24820000'], // gas 0; not `a0 + 4096`
    ['lw          $v0, (0x8 >> 32)($a0)', '8C820000'], // gas `0(a0)`; not `a0[2]`
    ['addiu       $v0, $zero, ((-16 >> 2) >> 28)', '00000000'], // gas: a logical 64-bit shift, out of range
    ['addiu       $v0, $zero, (0xFFFFFFFF + 1)', '00000000'], // gas: out of range
    ['lw          $v0, 0x100000004($a0)', '00000000'], // gas: "number larger than 32 bits"
  ])('`%s` declines', (line, word) => {
    expect(() => mips(leaf([line, word]))).toThrow(/past a 32-bit word/);
  });
  test.each([
    ['lui         $v0, (0x80001234 >> 16)', '3C028000', 'return -2147483648;'],
    ['addiu       $v0, $a0, (0x8000ABCD & 0xFFFF)', '2482ABCD', 'return a0 + -21555;'],
    ['lui         $v0, ((0x7FFF0000 + 0x10000) >> 16)', '3C028000', 'return -2147483648;'],
    // a displacement in [2^31, 2^32) is a 32-bit address addend to gas, re-signed to the word
    ['lh          $v0, (0xFFFFFFFE | 0)($a0)', '8482FFFE', 'return a0[-1];'], // was a0[2147483647]
    ['sw          $a1, (0xFFFFFFF8 & 0xFFFFFFFF)($a0)', 'AC85FFF8', 'a0[-2] = a1;'],
    ['lw          $v0, (0x7FFFFFFC + 0x80000000)($a0)', '8C82FFFC', 'return a0[-1];'],
    ['lw          $v0, 0xFFFFFFFC($a0)', '8C82FFFC', 'return a0[-1];'], // was a0[1073741823]
  ])('`%s` lifts as gas encodes it', (line, word, want) => {
    expect(mips(leaf([line, word]))).toContain(want);
  });

  // a numbered register in a DESTINATION slot would be a variable of its own beside the named one
  test.each([
    [
      [
        ['addiu       $v0, $zero, 5', '24020005'],
        ['addiu       $2, $zero, 7', '24020007'],
      ],
    ], // not `return 5;`
    [
      [
        ['addiu       $v0, $a0, 1', '24820001'],
        ['move        $2, $a1', '00A01025'],
      ],
    ], // not `return a0 + 1;`
    [[['addiu       $2, $zero, 5', '24020005']]], // not `return;`
    [[['lw          $2, 4($a0)', '8C820004']]], // not a discarded volatile read
  ] as [string, string][][][])('%j declines', (lines) => {
    expect(() => mips(leaf(...lines))).toThrow(/written as a register/);
  });
  test('a numbered register written in a delay slot declines (not `return a0 + 1;`, gas 9)', () => {
    const text = splat([
      ['addiu       $v0, $a0, 1', '24820001'],
      ['jr          $ra', '03E00008'],
      ['addiu       $2, $zero, 9', '24020009'],
    ]);
    expect(() => mips(text)).toThrow(/written as a register/);
  });

  // "operand N out of range" to gas
  test.each([
    ['lui         $v0, 0x10000'], // not `return 0;`
    ['andi        $v0, $a0, -1'], // not `a0 & -1`
    ['ori         $v0, $a0, -1'],
    ['ori         $v0, $a0, 0x10000'], // not `a0 | 65536`
    ['xori        $v0, $a0, -1'],
    ['sll         $v0, $a0, 32'], // not `a0 << 32`
    ['sll         $v0, $a0, -1'],
    ['sra         $v0, $a0, 33'],
  ])('`%s` declines', (line) => {
    expect(() => mips(leaf([line, '00000000']))).toThrow(/does not hold/);
  });
  test.each([
    ['sll         $v0, $a0, 31', '000417C0', 'return a0 << 31;'],
    ['ori         $v0, $a0, 0xFFFF', '3482FFFF', 'return a0 | 65535;'],
  ])('`%s` lifts', (line, word, want) => {
    expect(mips(leaf([line, word]))).toContain(want);
  });
});

// PPC reads a register slot by the same rule MIPS does: only a register name is one.
describe('a PPC register slot holding no register declines', () => {
  const obj = (lines: string[]) =>
    `00000000 <f>:\n${lines.map((l, i) => `   ${(i * 4).toString(16)}:\t${l}`).join('\n')}\n`;
  const ppc = (text: string) => decompile('f', text, PPC_MWCC).source;
  test.each([
    ['mr      r3,K'], // not `return a0;`
    ['add     r3,r3,K'], // not `return a0 + a1;`
    ['stw     K,8(r3)'], // not `a0[2] = a1; return a0;`
    ['mr      r3,4'],
    ['add     r3,r3,8'],
    ['stw     5,8(r3)'],
    ['li      K,5'], // a destination: not `return;`
  ])('`%s` declines', (line) => {
    expect(() => ppc(obj([line, 'blr']))).toThrow(/as a register — it names no PowerPC register/);
  });
});
