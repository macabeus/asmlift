// THE FILES A PROJECT'S ASSEMBLY `.include`s, found as gas finds them (src/asm-includes.ts): the
// project's root first, then each `-I` of its compile command, and the macro names they define.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

import {
  definedMacros,
  includeOperands,
  includeSearchFromCommand,
  readIncludes,
  resolveInclude,
} from '../../src/asm-includes';

const scratchDirs: string[] = [];
afterAll(() => scratchDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A directory holding `files` (path → text). */
const tree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'asmlift-asm-includes-test-'));
  scratchDirs.push(root);
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
};

describe('the -I directories of a compile command', () => {
  test('in order, joined or apart, resolved against the root', () => {
    expect(includeSearchFromCommand('/p', 'cc -E -I include x.c\nas -Iasm -I "inc dir" -I ./lib y.s')).toBeUndefined();
    expect(includeSearchFromCommand('/p', 'cc -E -I include x.c\nas -Iasm -I ./lib y.s', ['-I/abs'])).toEqual({
      cwd: '/p',
      dirs: ['/p/include', '/p/asm', '/p/lib', '/abs'],
    });
    // a directory spelt through a variable is no directory known
    expect(includeSearchFromCommand('/p', 'as -I $(INC) y.s')).toBeUndefined();
  });
});

describe('an include is resolved where gas resolves it, and only one way', () => {
  test('the root first, then each -I', () => {
    const root = tree({ 'a.inc': '', 'include/b.inc': '' });
    expect(resolveInclude('a.inc', { cwd: root, dirs: [] })).toBe(join(root, 'a.inc'));
    expect(resolveInclude('b.inc', { cwd: root, dirs: [] })).toBeUndefined();
    expect(resolveInclude('b.inc', { cwd: root, dirs: [join(root, 'include')] })).toBe(join(root, 'include/b.inc'));
  });
  test('a file two directories hold is no answer', () => {
    const root = tree({ 'a.inc': '', 'include/a.inc': '' });
    expect(resolveInclude('a.inc', { cwd: root, dirs: [join(root, 'include')] })).toBeUndefined();
    // the same file reached twice is one answer
    expect(resolveInclude('a.inc', { cwd: root, dirs: [root] })).toBe(join(root, 'a.inc'));
  });
  test('the chain, depth first, with every macro name', () => {
    const root = tree({
      'top.inc': '\t.include "include/mid.inc"\n\t.macro top_m a\n\t.endm\n',
      'include/mid.inc': '\t.macro MOV rd, imm\n\tadd \\rd, \\imm\n\t.endm\n',
    });
    const got = readIncludes(['top.inc'], { cwd: root, dirs: [] })!;
    expect(got.texts.map((t) => t.path)).toEqual([join(root, 'top.inc'), join(root, 'include/mid.inc')]);
    expect([...got.macros.keys()].sort()).toEqual(['mov', 'top_m']);
    expect(got.macros.get('mov')).toEqual([['add \\rd, \\imm']]);
  });
  test('a cycle, a missing file and an unread operand are no answer', () => {
    const root = tree({
      'a.inc': '\t.include "b.inc"\n',
      'b.inc': '\t.include "a.inc"\n',
      'c.inc': '\t.include "nowhere.inc"\n',
      'd.inc': '\t.macro inc f\n\t.include \\f\n\t.endm\n',
    });
    const search = { cwd: root, dirs: [] };
    expect(readIncludes(['a.inc'], search)).toBeUndefined();
    expect(readIncludes(['c.inc'], search)).toBeUndefined();
    expect(readIncludes(['d.inc'], search)).toBeUndefined();
    // a diamond is no cycle
    const diamond = tree({ 'l.inc': '.include "z.inc"\n', 'r.inc': '.include "z.inc"\n', 'z.inc': '' });
    expect(readIncludes(['l.inc', 'r.inc'], { cwd: diamond, dirs: [] })?.texts).toHaveLength(4);
  });
});

describe('macro names', () => {
  test('lower-cased, a label before .macro counted, and * for a name not read', () => {
    expect([...definedMacros('\t.MACRO Nop\n\t.endm\nm: .macro x\n.endm\n').keys()]).toEqual(['nop', 'm', 'x']);
    expect([...definedMacros('\t.irp n, nop\n\t.macro \\n\n\t.endm\n\t.endr\n').keys()]).toEqual(['*']);
    // a `.macro` in a comment still counts, as a name not read: the raw scan errs toward a name more
    expect([...definedMacros('@ .macro nop\n').keys()]).toEqual(['*']);
  });
  test('the operands of every .include', () => {
    expect(includeOperands('\t.include "a.inc" @ x\n\t.INCLUDE "b/c.inc"\n')).toEqual(['a.inc', 'b/c.inc']);
    expect(includeOperands('\t.include a.inc\n')).toBeUndefined();
  });
});
