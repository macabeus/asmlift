// What a Thumb callee's straight-line entry loads of its incoming stack words
// (frontend/thumb-entry.ts), read off agbcc's own output: `corpus/agbcc-entry-stack.s` is the
// compiler's `.s` of `corpus/probe-agbcc-entry-stack.c` (scripts/regen-outgoing-area-probes.ts),
// and the halfwords below are the same functions assembled (`arm-none-eabi-as -mthumb-interwork`).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { thumbEntryWordsFromHalfwords, thumbEntryWordsFromText } from '../src/frontend/thumb-entry';

const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-entry-stack.s'), 'utf8');

const HALFWORDS: Record<string, number[]> = {
  nine: [
    0xb5f0, 0x9d05, 0x9e06, 0x9f07, 0x4c07, 0x1940, 0x6020, 0x1989, 0x6061, 0x19d2, 0x60a2, 0x9808, 0x181b, 0x60e3,
    0x9809, 0x6120, 0xbcf0, 0xbc01, 0x4700,
  ],
  narrow9: [
    0xb5f0, 0x464f, 0x4646, 0xb4c0, 0xb094, 0x9c1b, 0x9d1c, 0x9e1d, 0x9f1e, 0x46b8, 0x9f1f, 0x46b9, 0x0600, 0x0409,
    0x0c09,
  ],
  fifth: [0x1c01, 0x9800, 0x1840, 0x4770],
  seventh: [0x9802, 0x4770],
  owns: [0xb500, 0x9901, 0x1809, 0x9101, 0xa801, 0xf7ff, 0x9801, 0xbc02, 0x4708],
  kr: [0x1c01, 0x9800, 0x1a40, 0x4770],
};

describe('the incoming stack words an agbcc callee loads, from its text and from its halfwords', () => {
  test.each([
    // five words through a push of five registers, past stores to a global between the loads
    ['nine', 5],
    // eight registers pushed and 0x50 reserved: [sp,#0x6c..#0x7c] are words 0..4
    ['narrow9', 5],
    // frameless: [sp] is word 0
    ['fifth', 1],
    // only the last parameter loaded: the bound is one past it, the words below it unread
    ['seventh', 3],
    // the word is loaded before the callee assigns to it and takes its address
    ['owns', 1],
    ['kr', 1],
  ])('%s loads %i', (fn, n) => {
    expect(thumbEntryWordsFromText(fn, asm)).toBe(n);
    expect(thumbEntryWordsFromHalfwords(HALFWORDS[fn])).toBe(n);
  });

  test('a callee whose entry loads no incoming word answers nothing', () => {
    expect(thumbEntryWordsFromText('call9', asm)).toBeUndefined();
    expect(thumbEntryWordsFromText('krmore', asm)).toBeUndefined();
    expect(thumbEntryWordsFromHalfwords([0xb500, 0x2001, 0xbc02, 0x4708])).toBeUndefined();
  });

  test('a text with no label of the callee answers nothing', () => {
    expect(thumbEntryWordsFromText('absent', asm)).toBeUndefined();
  });
});

describe('agbcc -g: the labels only debug information names', () => {
  // `nine` of corpus/probe-agbcc-entry-stack.c at -O2 -g, as agbcc lays it out: `.LFB1:` and `.LM1:`
  // before the prologue, and each named only by a `.4byte` under `.section .debug*`
  const g =
    'nine:\n.LFB1:\n.LM1:\n\n\tpush\t{r4, r5, r6, r7, lr}\n\tldr\tr4, [sp, #0x14]\n.LM2:\n\tldr\tr5, [sp, #0x24]\n' +
    '\tpop\t{r4, r5, r6, r7}\n\tpop\t{r1}\n\tbx\tr1\n.LFE1:\n\t.section\t.debug_line\n\t.4byte\t.LM1\n\t.4byte\t.LM2\n' +
    '\t.section\t.debug\n\t.4byte\t.LFB1\n';

  test('are followed past, so the entry reads as without -g', () => {
    expect(thumbEntryWordsFromText('nine', g)).toBe(5);
  });

  test('…while one the code names still stops it', () => {
    expect(thumbEntryWordsFromText('nine', `${g}\t.text\n\tb\t.LM2\n`)).toBe(1);
  });
});

describe('where the pass stops, and where it refuses', () => {
  const text = (...lines: string[]) => ['f:', ...lines.map((l) => `\t${l}`)].join('\n');

  test('a word the entry stores before it loads it holds no caller word', () => {
    expect(
      thumbEntryWordsFromText('f', text('push {lr}', 'str r0, [sp, #4]', 'ldr r1, [sp, #4]', 'bx lr')),
    ).toBeUndefined();
    expect(thumbEntryWordsFromHalfwords([0xb500, 0x9001, 0x9901, 0x4770])).toBeUndefined();
  });

  test('a word below the entry sp is a save or a local, never an incoming word', () => {
    expect(thumbEntryWordsFromText('f', text('push {r4, lr}', 'ldr r0, [sp, #4]', 'bx lr'))).toBeUndefined();
  });

  test('a load past a branch, a call or a label the code names is not read', () => {
    expect(thumbEntryWordsFromText('f', text('cmp r0, #0', 'beq .L1', 'ldr r0, [sp]', 'bx lr'))).toBeUndefined();
    expect(thumbEntryWordsFromText('f', text('ldr r1, [sp]', 'bl g', 'ldr r1, [sp, #4]'))).toBe(1);
    expect(thumbEntryWordsFromText('f', 'f:\n\tldr r1, [sp]\n.L1:\n\tldr r1, [sp, #8]\n\tb .L1\n')).toBe(1);
    // …a label a jump table names is one too, in whichever section the table sits
    expect(
      thumbEntryWordsFromText('f', 'f:\n\tldr r1, [sp]\n.L1:\n\tldr r1, [sp, #8]\n\t.section .rodata\n\t.word .L1\n'),
    ).toBe(1);
    expect(thumbEntryWordsFromHalfwords([0x9800, 0xd000, 0x9802])).toBe(1);
  });

  test('a frame address copied out stops the pass: the words above it may be written through it', () => {
    expect(thumbEntryWordsFromText('f', text('mov r2, sp', 'str r0, [r2]', 'ldr r1, [sp]'))).toBeUndefined();
    expect(thumbEntryWordsFromText('f', text('add r2, sp, #0', 'ldr r1, [sp]'))).toBeUndefined();
    expect(thumbEntryWordsFromHalfwords([0x466a, 0x9900])).toBeUndefined(); // mov r2, sp
    expect(thumbEntryWordsFromHalfwords([0xaa00, 0x9900])).toBeUndefined(); // add r2, sp, #0
  });

  test('sp written in a way the pass does not follow refuses outright', () => {
    expect(thumbEntryWordsFromText('f', text('ldr r1, [sp]', 'mov sp, r7', 'ldr r1, [sp, #4]'))).toBeUndefined();
    expect(thumbEntryWordsFromText('f', text('ldr r1, [sp]', 'add sp, r7'))).toBeUndefined();
    expect(thumbEntryWordsFromHalfwords([0x9800, 0x46bd])).toBeUndefined(); // mov sp, r7
  });

  test('`add sp, #-k`, `sub sp, sp, #k` and the UAL spellings move the delta alike', () => {
    expect(thumbEntryWordsFromText('f', text('push {r4-r7, lr}', 'add sp, sp, #-0x8', 'ldr r4, [sp, #0x1c]'))).toBe(1);
    expect(
      thumbEntryWordsFromText(
        'f',
        text('push {r4, r5, r6, r7, lr}', 'sub sp, #0x8', 'movs r0, #0', 'ldr r4, [sp, #0x20]'),
      ),
    ).toBe(2);
    expect(thumbEntryWordsFromHalfwords([0xb5f0, 0xb082, 0x9c08])).toBe(2); // push 5; sub sp, #8; ldr [sp,#0x20]
  });
});
