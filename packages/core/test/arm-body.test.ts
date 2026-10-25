// WHAT A STRAIGHT-LINE ARM BODY READS OF ITS ARGUMENTS (frontend/arm-body.ts), and the Thumb
// interworking veneer that reaches one. Every word is arm-none-eabi-as output for the instruction in
// its comment; GetRandomValue's are kleod's own (kleod-syms.elf, 0x080002a0..0x080002cc).
import { describe, expect, test } from 'vitest';

import { armArgumentWords, thumbToArmVeneerTarget } from '../src/frontend/arm-body';
import { calleeBodyBounds } from '../src/frontend/callee-body';
import { decompile, liftStamped } from '../src/pipeline';
import { TOOLCHAIN_TARGETS } from '../src/target';

const BX_LR = 0xe12fff1e;
// kleod's GetRandomValue: writes r0, r3, r2, ip and r1 before reading any of them
const GET_RANDOM_VALUE = [
  0xe59f017c, // ldr r0, [pc, #380]
  0xe59f317c, // ldr r3, [pc, #380]
  0xe5d32000, // ldrb r2, [r3]
  0xe082c000, // add ip, r2, r0
  0xe59c0000, // ldr r0, [ip]
  0xe20000ff, // and r0, r0, #255
  0xe59f116c, // ldr r1, [pc, #364]
  0xe5d1c000, // ldrb ip, [r1]
  0xe38cc001, // orr ip, ip, #1
  0xe082200c, // add r2, r2, ip
  0xe5c32000, // strb r2, [r3]
  BX_LR,
];

describe('the argument words a straight-line ARM body reads', () => {
  test('kleod GetRandomValue reads none', () => {
    expect(armArgumentWords(GET_RANDOM_VALUE)).toBe(0);
  });
  test.each([
    ['add r0, r0, #1', [0xe2800001], 1],
    ['mov r0, #1', [0xe3a00001], 0],
    ['mov r0, #1; add r0, r0, #1', [0xe3a00001, 0xe2800001], 0],
    ['add r0, r1, r2, lsl r3', [0xe0810312], 4],
    ['str r1, [r2]', [0xe5821000], 3],
    ['mla r0, r1, r2, r3', [0xe0203291], 4],
    ['ldr r0, [r1, #4]!', [0xe5b10004], 2],
    ['ldrh r0, [r2], #2', [0xe0d200b2], 3],
    ['strh r3, [r0]', [0xe1c030b0], 4],
    ['ldrsb r0, [r1, r2]', [0xe19100d2], 3],
    ['cmp r2, #0', [0xe3520000], 3],
    ['movs r0, r1', [0xe1b00001], 2],
    ['ldr r0, [pc, #4]', [0xe59f0004], 0],
    ['mov ip, r2', [0xe1a0c002], 3],
  ])('%s; bx lr', (_, words, n) => {
    expect(armArgumentWords([...words, BX_LR])).toBe(n);
  });
  // every one of these makes the body something other than the words in order up to `bx lr`, reads
  // a stack word, or is not modelled
  test.each([
    ['beq .', 0x0afffffe],
    ['moveq r0, #0', 0x03a00000],
    ['bxeq lr', 0x012fff1e],
    ['bl .', 0xebfffffe],
    ['ldm r0, {r1, r2}', 0xe8900006],
    ['ldr r0, [sp]', 0xe59d0000],
    ['mov lr, r0', 0xe1a0e000],
    ['mrs r0, CPSR', 0xe10f0000],
    ['bx r0', 0xe12fff10],
    ['mov pc, r0', 0xe1a0f000],
    ['ldr pc, [r0]', 0xe590f000],
    ['swp r0, r1, [r2]', 0xe1020091],
    ['umull r0, r1, r2, r3', 0xe0810392],
  ])('%s gives no bound', (_, word) => {
    expect(armArgumentWords([0xe3a00001, word, BX_LR])).toBeUndefined();
  });
  test('a body with no bx lr gives no bound', () => {
    expect(armArgumentWords(GET_RANDOM_VALUE.slice(0, -1))).toBeUndefined();
  });
});

describe('a Thumb interworking veneer', () => {
  // kleod's thunk_GetRandomValue at 0x08051bc4: bx pc; nop; then ARM `b GetRandomValue` at 0x08051bc8
  test('kleod thunk_GetRandomValue branches to GetRandomValue', () => {
    expect(thumbToArmVeneerTarget(0x08051bc4, 0x4778, 0x46c0, 0xeafeb9b4)).toBe(0x080002a0);
    expect(thumbToArmVeneerTarget(0x08000000, 0x4778, 0x46c0, 0xea000000)).toBe(0x0800000c);
  });
  test('anything else is no veneer', () => {
    // not word-aligned, another first or second halfword, a conditional or linking branch
    expect(thumbToArmVeneerTarget(0x08051bc6, 0x4778, 0x46c0, 0xeafeb9b4)).toBeUndefined();
    expect(thumbToArmVeneerTarget(0x08051bc4, 0x4718, 0x46c0, 0xeafeb9b4)).toBeUndefined();
    expect(thumbToArmVeneerTarget(0x08051bc4, 0x4778, 0x2000, 0xeafeb9b4)).toBeUndefined();
    expect(thumbToArmVeneerTarget(0x08051bc4, 0x4778, 0x46c0, 0x0afeb9b4)).toBeUndefined();
    expect(thumbToArmVeneerTarget(0x08051bc4, 0x4778, 0x46c0, 0xebfeb9b4)).toBeUndefined();
  });
});

describe('an ARM body handed in bounds a Thumb callee', () => {
  const t = TOOLCHAIN_TARGETS.agbcc.description;
  const caller = '\t.code\t16\n\t.text\n\t.thumb_func\nf:\n\tbx\tlr\n';
  const bounds = (words: readonly number[]) =>
    calleeBodyBounds(
      'f',
      caller,
      t,
      {},
      (callee, table, entryReadCalls, text) =>
        liftStamped(callee, text, t, table, undefined, undefined, undefined, {
          calleeBodyBound: () => undefined,
          entryReadCalls,
        }),
      { thk: { kind: 'arm', words } },
    )('thk');
  test('as its scan reads it, and on no other target', () => {
    expect(bounds(GET_RANDOM_VALUE)).toBe(0);
    expect(bounds([0xe2800001, BX_LR])).toBe(1);
    expect(bounds([0x03a00000, BX_LR])).toBeUndefined();
    const mips = TOOLCHAIN_TARGETS['ido7.1'].description;
    expect(
      calleeBodyBounds('f', '', mips, {}, () => ({}) as never, { thk: { kind: 'arm', words: GET_RANDOM_VALUE } })(
        'thk',
      ),
    ).toBeUndefined();
  });
  // `gp = 3; thk();` leaves the store's 3 in r0, which the guess passes
  test('decompile: a body reading none drops the leftover, one reading r0 keeps it', () => {
    const f =
      '\t.code\t16\n\t.text\n\t.thumb_func\nf:\n\tpush\t{lr}\n\tldr\tr1, .L3\n\tmov\tr0, #0x3\n\tstr\tr0, [r1]\n' +
      '\tbl\tthk\n\tpop\t{r1}\n\tbx\tr1\n.L3:\n\t.word\tgp\n';
    const src = (words?: readonly number[]) =>
      decompile('f', f, t, words === undefined ? {} : { calleeBodies: { thk: { kind: 'arm', words } } }).source;
    expect(src()).toContain('thk(3, &gp)');
    expect(src(GET_RANDOM_VALUE)).toContain('thk()');
    expect(src([0xe2800001, BX_LR])).toContain('thk(3)');
    expect(src([0x03a00000, BX_LR])).toContain('thk(3, &gp)');
  });
});
