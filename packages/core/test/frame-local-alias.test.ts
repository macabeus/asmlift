// `compilerBehaviors.disambiguatesFrameLocals`, read off the committed probe rather than a number in
// a comment: `corpus/frame-local-alias.txt` holds four shapes, each compiled as two arrays (`pNS`)
// and as one object (`pNO`), per toolchain. A compiler that tells two distinct frame arrays apart
// makes FEWER loads or stores in some split shape than in its one-object twin (a value kept in a
// register across the indexed store, or a store dropped as dead); one that does not makes the same.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { TOOLCHAIN_TARGETS } from '../src/target';

const corpus = readFileSync(join(import.meta.dirname, 'corpus', 'frame-local-alias.txt'), 'utf8');

const sections = new Map<string, string[]>();
let current: string[] | undefined;
for (const line of corpus.split('\n')) {
  const head = /^== (.+)$/.exec(line);
  if (head !== null) {
    current = [];
    sections.set(head[1], current);
  } else if (current !== undefined && line.trim() !== '') {
    current.push(line.trim());
  }
}

// every load and store, Thumb and MIPS, but a Thumb literal-pool load (`ldr rX, [pc, #k]`), which
// names a constant and not the frame
const memOps = (lines: readonly string[]) =>
  lines.filter(
    (l) => /^(ldr|ldrb|ldrsb|ldrh|ldrsh|str|strb|strh|lb|lbu|lh|lhu|lw|sb|sh|sw)\s/.test(l) && !/\[pc/.test(l),
  ).length;

const SHAPES = ['p1', 'p2', 'p3', 'p4'];
const counts = (tc: string) =>
  SHAPES.map((p) => {
    const split = sections.get(`${tc} ${p}S`);
    const one = sections.get(`${tc} ${p}O`);
    if (split === undefined || one === undefined) {
      throw new Error(`no ${tc} ${p} pair in the probe`);
    }
    return { split: memOps(split), one: memOps(one) };
  });

test('the probe carries all four shapes, split and one-object, for every measured toolchain', () => {
  for (const tc of ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2']) {
    expect(counts(tc).every(({ split, one }) => split > 0 && one > 0)).toBe(true);
  }
});

test('ido7.1 disambiguates the two arrays in every shape; the gcc-family compilers in none', () => {
  expect(counts('ido7.1').every(({ split, one }) => split < one)).toBe(true);
  for (const tc of ['agbcc', 'gcc2.7.2kmc', 'gcc2.7.2']) {
    expect(counts(tc).every(({ split, one }) => split === one)).toBe(true);
  }
  // gcc 2.7.2, both builds: not only the same count but the same object
  for (const tc of ['gcc2.7.2kmc', 'gcc2.7.2']) {
    for (const p of SHAPES) {
      expect(sections.get(`${tc} ${p}S`)).toEqual(sections.get(`${tc} ${p}O`));
    }
  }
});

test('each description states what its probe shows, and mwcc (unmeasured) states nothing', () => {
  const of = (tc: keyof typeof TOOLCHAIN_TARGETS) =>
    TOOLCHAIN_TARGETS[tc].description.compilerBehaviors.disambiguatesFrameLocals;
  for (const tc of ['agbcc', 'ido7.1', 'gcc2.7.2kmc', 'gcc2.7.2'] as const) {
    expect(of(tc)).toBe(counts(tc).some(({ split, one }) => split !== one));
  }
  expect(of('mwcc_242_81')).toBeUndefined();
});
