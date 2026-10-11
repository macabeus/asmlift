// The outgoing-argument analysis's `escape` event reads a frame address this function hands out as
// a LOCAL's, so its receiver reads the words from there up and none of them is a call's outgoing
// argument (`target.ts` `escapedFrameAddressNamesALocal`). That is a compiler universal read
// backwards, and a wrong one costs an argument dropped from a call, so it rests on a committed
// agbcc probe (`scripts/regen-outgoing-area-probes.ts`, `corpus/agbcc-escape.s`): the layout half
// (`f0`, `f1`), and the residue with the staging order that keeps it safe (`qh5`, `a2`, `a3`).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-escape.s'), 'utf8');

const source = (fn: string): string => asm.slice(asm.indexOf(`${fn}:`), asm.indexOf('.Lfe', asm.indexOf(`${fn}:`)));
const lines = (fn: string): string[] =>
  source(fn)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

const words = (n: number) => Array.from({ length: n }, () => 's32');
const G = { g: { params: ['struct S *'], returns: 's32' } };
const H5 = { h5: { params: words(5), returns: 's32' } };

// The frame offsets each call's outgoing words are staged at, in the order the code stages them: a
// `str` to `[sp, #k]`, or a block copy whose destination `memcpy` is handed (`mov r0, sp` /
// `add r0, sp, #k`). Calls to `memcpy` itself are part of the staging, not a call that consumes it.
const staging = (fn: string): Array<{ callee: string; offs: number[] }> => {
  const out: Array<{ callee: string; offs: number[] }> = [];
  let offs: number[] = [];
  let dest: number | null = null;
  for (const l of lines(fn)) {
    const str = /^str\tr\d, \[sp(?:, #(0x[0-9a-f]+))?\]$/.exec(l);
    const add = /^add\tr0, sp, #(0x[0-9a-f]+)$/.exec(l);
    const bl = /^bl\t(\w+)$/.exec(l);
    if (str) {
      offs.push(str[1] === undefined ? 0 : parseInt(str[1], 16));
    } else if (l === 'mov\tr0, sp') {
      dest = 0;
    } else if (add) {
      dest = parseInt(add[1], 16);
    } else if (bl?.[1] === 'memcpy') {
      expect(dest).not.toBeNull();
      offs.push(dest!);
      dest = null;
    } else if (bl) {
      out.push({ callee: bl[1], offs });
      offs = [];
    }
  }
  return out;
};

describe('an address-taken local sits at [sp,#0] only when no call takes a stack word', () => {
  test('f0: the local is the frame base, handed to `g`, and nothing is staged for a call', () => {
    const f0 = lines('f0');
    expect(f0.slice(f0.indexOf('mov\tr0, sp'), f0.indexOf('bl\tg') + 1)).toEqual([
      'mov\tr0, sp',
      'strb\tr2, [r0, #0x8]',
      'strh\tr1, [r0, #0xa]',
      'bl\tg',
    ]);
    // the two word stores before the capture are the object's first two members
    expect(staging('f0')).toEqual([{ callee: 'g', offs: [0, 4] }]);
  });

  test('f1: beside a fifth argument the local moves above it, and [sp,#0] is staged after', () => {
    const f1 = lines('f1');
    expect(f1).toContain('add\tr0, sp, #0x4');
    expect(f1).not.toContain('mov\tr0, sp');
    expect(staging('f1')).toEqual([
      { callee: 'g', offs: [4, 8] },
      { callee: 'h5', offs: [0] },
    ]);
  });

  test('so the escape lifts both: every store of f0, and f1 with its fifth argument', () => {
    expect(decompile('f0', source('f0'), ARMV4T_AGBCC, { prototypes: G }).source).toContain(
      '    *p0 = 0;\n    p0[1] = a0;\n    ((u8 *)sp0)[8] = 0;\n    ((u16 *)sp0)[5] = a1;\n    return g(sp0);\n',
    );
    expect(decompile('f1', source('f1'), ARMV4T_AGBCC, { prototypes: { ...G, ...H5 } }).source).toContain(
      '    g(sp4);\n    return h5(1, 2, 3, 4, a0);\n',
    );
  });
});

// THE RESIDUE: a by-value struct argument's block copy hands `memcpy` a frame address that IS the
// outgoing area. What keeps the escape from clearing a real argument is the ORDER agbcc stages in:
// ascending offset, the copy included. A word staged before a copy lies BELOW its base, so the
// escape (which ends pending words from its offset up) leaves it pending; a word staged after the
// copy is pending at the call that takes it.
describe('agbcc stages every outgoing word in ascending offset order, a block copy included', () => {
  test('qh5, a2, a3: each call’s staging offsets ascend', () => {
    expect(staging('qh5')).toEqual([
      { callee: 'th', offs: [0] },
      { callee: 'h5', offs: [0] },
    ]);
    expect(staging('a2')).toEqual([
      { callee: 'gy', offs: [] },
      { callee: 'tg', offs: [0, 4] },
    ]);
    expect(staging('a3')).toEqual([{ callee: 'tt3', offs: [0, 0x44, 0x48] }]);
  });

  test('a word staged after the copy reaches its call pending, so it declines', () => {
    expect(() => decompile('qh5', source('qh5'), ARMV4T_AGBCC)).toThrow(
      /the store to \[sp,#0\] reaches `bl h5` unread/,
    );
    // …and a declaration that names the escaped word as an argument is the contradiction
    expect(() => decompile('qh5', source('qh5'), ARMV4T_AGBCC, { prototypes: H5 })).toThrow(
      /the frame address \[sp,#0\] escapes this function, so the words from there up are an object's/,
    );
  });

  test('a word staged before the copy lies below its base, so the escape leaves it pending', () => {
    expect(() => decompile('a2', source('a2'), ARMV4T_AGBCC)).toThrow(/the store to \[sp,#0\] is never reloaded/);
    const tg = { tg: { params: words(5 + 17), returns: 's32' } };
    expect(() => decompile('a2', source('a2'), ARMV4T_AGBCC, { prototypes: tg })).toThrow(
      /callee `tg` is declared with 22 arguments/,
    );
  });

  // `a3` with `tt3` UNDECLARED lifts with every stack word dropped. That predates the escape event,
  // which does not change it: the copied words are written by `memcpy`, not by a `str`, so the
  // contiguity filter never sees a supplied lower slot. An accepting assertion would freeze that
  // answer, so only the declared refusal is pinned here.
  test('a3, declared, declines', () => {
    const tt3 = { tt3: { params: words(4 + 17 + 1 + 17), returns: 's32' } };
    expect(() => decompile('a3', source('a3'), ARMV4T_AGBCC, { prototypes: tt3 })).toThrow(
      /callee `tt3` is declared with 39 arguments/,
    );
  });
});
