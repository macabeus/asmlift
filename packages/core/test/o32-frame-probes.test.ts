// `compilerBehaviors.o32LocalArea` (target.ts) says where an O32 compiler keeps its locals, and the
// MIPS frontend draws the frame-object audit's partition from it — so it rests on committed objects
// (`corpus/probe-o32-frame.c`, `scripts/regen-o32-frame-probes.ts`), read here off the text: each
// probe takes its local's address, so the instruction that names the local gives its offset.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { __testing } from '../src/frontend/mips';
import { MIPS_GCC, MIPS_IDO } from '../src/target';

interface Frame {
  size: number;
  /** offsets of the registers the prologue saves (`ra`, `s0`-`s8`/`fp`) */
  saves: number[];
  /** the offset the local's address is taken at: `addiu aX,sp,K`, or 0 for `addu rD,sp,rX` */
  local: number;
  /** the word offsets `sw` writes that save no register */
  stores: number[];
}

const frames = (fixture: string): Map<string, Frame> => {
  const text = readFileSync(join(import.meta.dirname, 'corpus', fixture), 'utf8');
  const out = new Map<string, Frame>();
  for (const part of text.split(/^[0-9a-f]+ </m).slice(1)) {
    const name = part.slice(0, part.indexOf('>'));
    const ins = part
      .split('\n')
      .map((l) => /^\s*[0-9a-f]+:\t(\S+)\t?(.*)$/.exec(l))
      .filter((m) => m !== null)
      .map((m) => ({ mn: m[1], ops: m[2].split(',') }));
    const spOff = (op: string) => {
      const m = /^(-?\d+)\(sp\)$/.exec(op);
      return m ? Number(m[1]) : null;
    };
    const push = ins.find((i) => i.mn === 'addiu' && i.ops[0] === 'sp' && i.ops[1] === 'sp');
    const capture = ins.find((i) => i.mn === 'addiu' && i.ops[0] !== 'sp' && i.ops[1] === 'sp');
    const indexed = ins.some((i) => i.mn === 'addu' && i.ops.includes('sp'));
    // A SAVE is a store of `ra` or a callee-saved register while it still holds the caller's value:
    // `out5arr` saves s0 and later stores the s0 it loaded `x` into as the call's fifth argument.
    const calleeSaved = (r: string) => r === 'ra' || r === 'fp' || /^s[0-8]$/.test(r);
    const written = new Set<string>();
    const saves: number[] = [];
    const stores: number[] = [];
    for (const i of ins) {
      const off = i.mn === 'sw' ? spOff(i.ops[1]) : null;
      if (off !== null) {
        (calleeSaved(i.ops[0]) && !written.has(i.ops[0]) ? saves : stores).push(off);
      } else if (!/^(s[bhw]|b|j|jr|jal|beqz|bnez|beq|bne|nop)$/.test(i.mn)) {
        written.add(i.ops[0]);
      }
    }
    out.set(name, {
      size: push ? -Number(push.ops[2]) : 0,
      saves,
      local: capture ? Number(capture.ops[2]) : indexed ? 0 : NaN,
      stores,
    });
  }
  return out;
};

// The bytes of each probe's local, from the source: `int a[4]` or `int a[3]`.
const LOCAL_BYTES: Record<string, number> = { leafarr: 16, callarr: 16, out5arr: 12, spillarr: 12 };
// Where each probe's outgoing area ends: no call, a call taking no stack word, one stack word.
const OUTGOING_END: Record<string, number> = { leafarr: 0, callarr: 16, out5arr: 20, spillarr: 16 };

// The MIPS frontend's own partition (`frontend/mips.ts` `o32LocalArea`), asked of each probe.
const area = (rule: 'above-outgoing-area' | 'above-saved-registers', f: Frame, outgoingEnd: number) =>
  __testing.o32LocalArea(rule, { frameSize: f.size, outgoingEnd, saves: f.saves })!;

describe.each([
  ['ido71-o32frame.txt', MIPS_IDO],
  ['gcc272kmc-o32frame.txt', MIPS_GCC],
  ['gcc272-o32frame.txt', MIPS_GCC],
] as const)('%s', (fixture, target) => {
  const rule = target.compilerBehaviors.o32LocalArea!;
  const fs = frames(fixture);

  test.each(Object.keys(LOCAL_BYTES))('%s: the local lies inside the area the target claims', (fn) => {
    const f = fs.get(fn)!;
    const a = area(rule, f, OUTGOING_END[fn]);
    expect(f.local).toBeGreaterThanOrEqual(a.from);
    expect(f.local + LOCAL_BYTES[fn]).toBeLessThanOrEqual(a.to);
    // …and no saved register inside it
    expect(f.saves.filter((s) => s >= a.from && s < a.to)).toEqual([]);
  });

  test('a function that makes no call keeps its local at the frame base', () => {
    expect(fs.get('leafarr')!.local).toBe(0);
  });

  // The area is the local's bytes and the padding and spills beside it, and nothing else: the
  // outgoing words below and every save are outside it.
  test('the partition the frontend draws on each probe', () => {
    const got = Object.fromEntries(
      Object.keys(LOCAL_BYTES).map((fn) => [fn, area(rule, fs.get(fn)!, OUTGOING_END[fn])]),
    );
    expect(got).toEqual(
      rule === 'above-outgoing-area'
        ? {
            leafarr: { from: 0, to: 16 },
            callarr: { from: 16, to: 32 },
            out5arr: { from: 24, to: 40 },
            spillarr: { from: 16, to: 32 },
          }
        : {
            leafarr: { from: 0, to: 16 },
            callarr: { from: 24, to: 40 },
            out5arr: { from: 32, to: 48 },
            spillarr: { from: 24, to: 40 },
          },
    );
  });

  test('incoming argument word k >= 4 is read at the pushed size + 4k', () => {
    const f = fs.get('in9')!;
    const text = readFileSync(join(import.meta.dirname, 'corpus', fixture), 'utf8');
    const in9 = text.slice(text.indexOf('<in9>:'));
    // `i` is argument word 8 and `e` word 4, so the two loads past the frame are N+32 and N+16
    expect(in9).toContain(`lw\ta0,${f.size + 32}(sp)`);
    expect(in9).toMatch(new RegExp(`lw\\t\\w+,${f.size + 16}\\(sp\\)`));
  });
});

test('no partition without a stated layout, or with nothing left between the outgoing area and the saves', () => {
  expect(__testing.o32LocalArea(undefined, { frameSize: 40, outgoingEnd: 16, saves: [32] })).toBeNull();
  // gcc2.7.2kmc `in9`: s0 and ra saved at 16 and 20, right above the home area — no local area
  expect(__testing.o32LocalArea('above-outgoing-area', { frameSize: 24, outgoingEnd: 16, saves: [16, 20] })).toBeNull();
  expect(__testing.o32LocalArea('above-saved-registers', { frameSize: 24, outgoingEnd: 16, saves: [20] })).toBeNull();
});

test('IDO: the local ends at the frame top, above `ra` and any spill', () => {
  const fs = frames('ido71-o32frame.txt');
  for (const fn of ['callarr', 'out5arr', 'spillarr']) {
    const f = fs.get(fn)!;
    expect(f.local + LOCAL_BYTES[fn]).toBe(f.size);
    expect(Math.max(...f.saves)).toBeLessThan(f.local);
  }
  // the value live across the first call is spilled between the save and the array
  const s = fs.get('spillarr')!;
  expect(s.saves).toEqual([20]);
  expect(s.stores.filter((o) => o < s.size)).toEqual([24]);
  expect(s.local).toBe(28);
});

test.each(['gcc272kmc-o32frame.txt', 'gcc272-o32frame.txt'])(
  '%s: the local sits right above the outgoing area, rounded up to 8, under every save',
  (fixture) => {
    const fs = frames(fixture);
    expect(fs.get('callarr')!.local).toBe(16);
    expect(fs.get('out5arr')!.local).toBe(24); // the area ends at 20
    for (const fn of ['callarr', 'out5arr', 'spillarr']) {
      const f = fs.get(fn)!;
      expect(Math.min(...f.saves)).toBeGreaterThanOrEqual(f.local + LOCAL_BYTES[fn]);
    }
  },
);
