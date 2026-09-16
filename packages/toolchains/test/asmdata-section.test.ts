// THE SIDE-TABLE DUMP IS SCOPED TO ONE FUNCTION'S SECTION, and used to refuse instead.
//
// `objdump -s -r -t` describes the WHOLE object: one "Contents of section .text" block per section,
// of which the parser keeps the last, and every symbol resolved against whichever section defines
// it. On a CodeWarrior object — a translation unit split across several sections all named `.text`,
// all starting at address 0 — that means a jump table's base can be measured from another
// function's bytes. There was no symbol in the signature to answer with, so the step refused such
// an object outright and the row lost its side table (a dense switch then declines).
//
// Now the OBJECT is scoped first, the same way the disassembly already is, and the dump describes
// only the section that defines the symbol. TOOLCHAIN-FREE: the "objdump" here is a two-line shell
// script that prints the path it was handed, so what is asserted is which object the step dumps.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { multiTextObject, readBack } from '../../cli/test/offline/multi-text-object';
import { mipsObjdumpText } from '../src/asmdata';

/** An "objdump" that prints the arguments it was given, one per line, so the assertion can be about
 *  the OBJECT the step chose. */
function echoingObjdump(): string {
  const p = join(mkdtempSync(join(tmpdir(), 'asmdata-section-')), 'objdump');
  writeFileSync(p, '#!/bin/sh\nfor a; do echo "$a"; done\n');
  chmodSync(p, 0o755);
  return p;
}

/** `bl` to the section's relocation target, then `blr` — the instruction bytes are immaterial here;
 *  what matters is that each section has its own function and its own relocation. The relocation
 *  targets are other symbols the same object names (`ext` is its undefined one). */
const body = (n: number): Buffer => Buffer.from([0x60, 0x00, 0x00, n, 0x48, 0x00, 0x00, 0x01, 0x4e, 0x80, 0x00, 0x20]);

function objectWith(sections: number, names: readonly string[], targets: readonly string[]): string {
  const p = join(mkdtempSync(join(tmpdir(), 'asmdata-section-obj-')), 'u.o');
  writeFileSync(
    p,
    multiTextObject(
      Array.from({ length: sections }, (_, i) => body(i)),
      targets,
      { names },
    ),
  );
  return p;
}

describe('the asmdata dump of an object with several code sections', () => {
  test('dumps a copy holding only the section that defines the symbol, with only its relocations', () => {
    const obj = objectWith(3, ['alpha', 'beta', 'gamma'], ['gamma', 'ext', 'alpha']);
    const dumped = mipsObjdumpText(obj, echoingObjdump(), 'beta').trim().split('\n').at(-1)!;

    expect(dumped).not.toBe(obj);
    const scoped = readBack(readFileSync(dumped));
    expect(scoped.sections.filter((s) => s.nm === '.text')).toHaveLength(1);
    // beta keeps its definition; the other two survive as undefined symbols, so a relocation
    // reaching into them still disassembles under its own name
    expect(scoped.symbols.find((s) => s.name === 'beta')!.shndx).toBeGreaterThan(0);
    expect(scoped.symbols.find((s) => s.name === 'alpha')!.shndx).toBe(0);
    // and only beta's own relocation is left to measure a table base from
    expect(scoped.relocationTargets.map((r) => r.target)).toEqual(['ext']);
  });

  test('a single-code-section object is dumped as itself — byte for byte the call this always made', () => {
    const obj = objectWith(1, ['only'], ['ext']);
    expect(mipsObjdumpText(obj, echoingObjdump(), 'only').trim().split('\n').at(-1)).toBe(obj);
  });

  test('two functions of one object are dumped from DIFFERENT bytes', () => {
    const obj = objectWith(2, ['first', 'second'], ['second', 'first']);
    const dumpOf = (sym: string) => mipsObjdumpText(obj, echoingObjdump(), sym).trim().split('\n').at(-1)!;
    const [a, b] = [dumpOf('first'), dumpOf('second')];
    expect(a).not.toBe(b);
    expect(readFileSync(a).equals(readFileSync(b))).toBe(false);
  });

  test('a symbol no code section of a multi-section object defines is refused, not guessed at', () => {
    const obj = objectWith(2, ['first', 'second'], ['second', 'first']);
    expect(() => mipsObjdumpText(obj, echoingObjdump(), 'third')).toThrow(/none of them defines 'third'/);
  });
});
