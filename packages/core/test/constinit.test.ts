// l3/constinit.ts: the copy of the compiler's anonymous constant image folds into the initializer
// of the local it fills — only where the declaration and the copy are one program. The end-to-end
// half, through the real agbcc, is packages/cli/test/matching/const-init.test.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { pascalBackend } from '../src/backend/pascal';
import { T } from '../src/ir/types';
import type { Expr, SFn, SStatic, Stmt } from '../src/l3/ast';
import { constantImageRefusal, foldConstantImages } from '../src/l3/constinit';
import { decompile } from '../src/pipeline';
import { ARMV4T_AGBCC } from '../src/target';

const v = (name: string): Expr => ({ k: 'var', name });
const c = (value: number): Expr => ({ k: 'const', value });
const copy = (dst: string, src: string, n: number): Stmt => ({
  k: 'exprstmt',
  value: { k: 'call', fn: 'memcpy', args: [v(dst), { k: 'addr', name: src }, c(n)] },
});
const image = (init: number[], width = 1, signed = false, extra: Partial<SStatic> = {}): SStatic => ({
  name: '.LC0',
  type: T.array(T.int(8 * width, signed), init.length),
  const: true,
  init,
  anonymous: true,
  ...extra,
});
const fn = (body: Stmt[], locals: SFn['locals'], img: SStatic = image([1, 2, 3, 4])): SFn => ({
  name: 'f',
  params: [],
  locals,
  statics: [img],
  retType: T.void(),
  body,
});
const bytes4 = [{ name: 'sp0', type: T.array(T.u(8), 4) }];
const use = (e: Expr): Stmt => ({ k: 'exprstmt', value: { k: 'call', fn: 'g', args: [e] } });

test('the copy folds into the declaration, and the image and the copy are gone', () => {
  const sfn = fn([copy('sp0', '.LC0', 4), use(v('sp0'))], bytes4);
  expect(constantImageRefusal(sfn)).toBeNull();
  const out = foldConstantImages(sfn);
  expect(out.statics).toBeUndefined();
  expect(out.body).toEqual([use(v('sp0'))]);
  expect(cBackend.emit(sfn)).toBe('void f(void) {\n    u8 sp0[4] = { 1, 2, 3, 4 };\n    g(sp0);\n}\n');
});

test('a local handed on whole takes the image’s element; one read by element keeps its own', () => {
  const halves = image([1, -1, 3], 2, true);
  const wide = [{ name: 'sp0', type: T.array(T.u(8), 8) }];
  // a 6-byte image in the 8 bytes the frame rounded the reservation to
  expect(cBackend.emit(fn([copy('sp0', '.LC0', 6), use(v('sp0'))], wide, halves))).toContain(
    '    s16 sp0[3] = { 1, -1, 3 };\n',
  );
  const read: Stmt = {
    k: 'return',
    value: { k: 'index', base: v('sp0'), idx: c(1), width: 1, signed: false },
  };
  const bytes = image([1, 0xff, 3, 4], 1, true);
  expect(cBackend.emit({ ...fn([copy('sp0', '.LC0', 4), read], bytes4, bytes), retType: T.u(8) })).toContain(
    '    u8 sp0[4] = { 1, 0xff, 3, 4 };\n',
  );
});

test('an image written as a string literal is spelled as one', () => {
  const str = image([0x68, 0x69, 0], 1, false, { string: true });
  expect(
    cBackend.emit(fn([copy('sp0', '.LC0', 3), use(v('sp0'))], [{ name: 'sp0', type: T.array(T.u(8), 4) }], str)),
  ).toContain('    u8 sp0[3] = "hi";\n');
});

test.each<[string, SFn, string]>([
  ['read twice', fn([copy('sp0', '.LC0', 4), use({ k: 'addr', name: '.LC0' })], bytes4), 'reads more than once'],
  [
    'copied inside a branch',
    fn([{ k: 'if', cond: v('x'), then: [copy('sp0', '.LC0', 4)], else: [] }], bytes4),
    'not the source of a block copy at the top level',
  ],
  ['copied in part', fn([copy('sp0', '.LC0', 2)], bytes4), 'does not move its whole 4 bytes'],
  ['into a global', fn([copy('gBuf', '.LC0', 4)], bytes4), 'does not fill a local'],
  [
    'into a volatile local',
    fn([copy('sp0', '.LC0', 4)], [{ name: 'sp0', type: T.array(T.u(8), 4), volatile: true }]),
    'which is volatile',
  ],
  [
    'into a local of another size',
    fn([copy('sp0', '.LC0', 4)], [{ name: 'sp0', type: T.array(T.u(8), 8) }]),
    'not an integer array of its 4 bytes',
  ],
  [
    'into a local the body touched first',
    fn([use(v('sp0')), copy('sp0', '.LC0', 4)], bytes4),
    'not the first thing the body does with it',
  ],
  [
    'into a local read by another element',
    fn(
      [
        copy('sp0', '.LC0', 4),
        { k: 'return', value: { k: 'index', base: v('sp0'), idx: c(0), width: 2, signed: false } },
      ],
      [{ name: 'sp0', type: T.array(T.u(16), 2) }],
    ),
    'are not the 2-byte elements the body reaches',
  ],
  [
    'into a local reached past the copy',
    fn([copy('sp0', '.LC0', 3), use({ k: 'bin', op: '+', l: v('sp0'), r: c(3) })], bytes4, image([1, 2, 3])),
    'the body reaches past the 3 bytes copied',
  ],
  [
    'into a local indexed past the copy',
    fn(
      [
        copy('sp0', '.LC0', 3),
        { k: 'return', value: { k: 'index', base: v('sp0'), idx: c(3), width: 1, signed: false } },
      ],
      bytes4,
      image([1, 2, 3]),
    ),
    'indexes past the 3 bytes copied',
  ],
])('%s: refuses, and the emitter will not print it', (_, sfn, why) => {
  expect(constantImageRefusal(sfn)?.refused).toContain(why);
  expect(() => cBackend.emit(sfn)).toThrow(why);
});

test('an image of mixed widths has no element type to declare', () => {
  const asm =
    '\t.section .rodata\n\t.align\t2, 0\n.LC0:\n\t.short\t0x1\n\t.byte\t0x2\n\t.byte\t0x3\n.text\n' +
    '\t.align\t2, 0\n\t.globl\tf\n\t.thumb_func\nf:\n\tpush\t{lr}\n\tadd\tsp, sp, #-0x4\n\tldr\tr1, .L2\n' +
    '\tmov\tr0, sp\n\tmov\tr2, #0x4\n\tbl\tmemcpy\n\tadd\tsp, sp, #0x4\n\tpop\t{r0}\n\tbx\tr0\n' +
    '\t.align\t2, 0\n.L2:\n\t.word\t.LC0\n';
  expect(() => decompile('f', asm, ARMV4T_AGBCC)).toThrow(
    "reads the compiler's anonymous constant ('.LC0') whose image writes no one element width",
  );
});

test('the Pascal backend has no spelling for the image, and says which object it is', () => {
  expect(() => pascalBackend.emit(fn([copy('sp0', '.LC0', 4)], bytes4))).toThrow(
    "the compiler's anonymous constant '.LC0' a local is initialized from has no IDO Pascal spelling yet",
  );
});

test('agbcc: kleod sub_0804C898 — a dead local array keeps its initializer', () => {
  const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-const-init.s'), 'utf8');
  expect(decompile('dead16', asm, ARMV4T_AGBCC).source).toBe(
    'void dead16(void) {\n    u8 sp0[16] = {\n        0, 1, 2, 4, 6, 4, 2, 1,\n' +
      '        0, 0xff, 0xfe, 0xfc, 0xfa, 0xfc, 0xfe, 0xff,\n    };\n}\n',
  );
});

test('agbcc: an element read through the local’s address keeps the image inside the copy', () => {
  // int fread(int i) { u8 a[6] = {9, 8, 7, 6, 5, 4}; return a[i]; } — the frame rounds the 6
  // bytes to 8, and the read is an index off `&sp0`, which carries its own width
  const asm = readFileSync(join(import.meta.dirname, 'corpus', 'agbcc-const-init.s'), 'utf8');
  expect(decompile('fread', asm, ARMV4T_AGBCC).source).toContain('    u8 sp0[6] = { 9, 8, 7, 6, 5, 4 };\n');
});
