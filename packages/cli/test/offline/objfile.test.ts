// Object-file (.o) CLI input, OFFLINE — the pre-spawn decision points plus the full object
// pipeline with the objdump spawns FAKED through runCli's ObjInput seam (the real spawns are
// proven by test/matching/objfile-e2e.test.ts against actual toolchains).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { type ObjInput, runCli } from '../../src/main';
import { ObjectInputUnsupportedError, isElfObject } from '../../src/objfile';

const ELF = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0]); // magic + junk
const corpus = (f: string) => readFileSync(join(import.meta.dirname, '../../../core/test/corpus', f), 'utf8');

test('isElfObject: magic detected, text and short buffers are not', async () => {
  expect(isElfObject(ELF)).toBe(true);
  expect(isElfObject(new TextEncoder().encode('.text\n\tadd r0, r1\n'))).toBe(false);
  expect(isElfObject(new Uint8Array([0x7f, 0x45]))).toBe(false);
});

test('object via stdin declines with exit 66', async () => {
  const r = await runCli(['-', '--target', 'ido7.1'], () => ELF);
  expect(r.code).toBe(66);
  expect(r.stderr).toContain('stdin');
});

test('object for the agbcc target is a [declined], not a crash', async () => {
  const r = await runCli(['fn.o', '--target', 'agbcc'], () => ELF);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain('[declined]');
  expect(r.stderr).toContain('agbcc .s text');
});

test('object input disassembles and decompiles; side-table failure only warns', async () => {
  const fake: ObjInput = {
    disasm: () => corpus('ido-add1.asm'),
    asmData: () => {
      throw new Error('objdump -s -r -t unavailable');
    },
  };
  const r = await runCli(['fn.o', '--target', 'ido7.1', '--name', 'add1'], () => ELF, fake);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('s32 add1(s32 a0)');
  expect(r.stderr).toContain('warning: no jump-table side-table');
});

test("disassembly failure is exit 66 with the tool's message", async () => {
  const fake: ObjInput = {
    disasm: () => {
      throw new Error('mips-linux-gnu-objdump not found');
    },
    asmData: () => undefined,
  };
  const r = await runCli(['fn.o', '--target', 'ido7.1'], () => ELF, fake);
  expect(r.code).toBe(66);
  expect(r.stderr).toContain('cannot disassemble');
  expect(r.stderr).toContain('objdump not found');
});

test('text input passed as bytes decodes and decompiles', async () => {
  const bytes = new TextEncoder().encode(corpus('ido-add1.asm'));
  const r = await runCli(['fn.asm', '--target', 'ido7.1', '--name', 'add1'], () => bytes);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('s32 add1(s32 a0)');
});

test('the ObjectInputUnsupportedError class is what the agbcc path throws', async () => {
  // pins the typed-error contract the CLI's [declined] branch depends on
  expect(new ObjectInputUnsupportedError('x')).toBeInstanceOf(Error);
});

test('mwcc .o with no PowerPC objdump anywhere fails loud naming every remedy', async () => {
  const prev = process.env.ASMLIFT_PPC_OBJDUMP;
  process.env.ASMLIFT_PPC_OBJDUMP = '/nonexistent/powerpc-eabi-objdump';
  try {
    const r = await runCli(['fn.o', '--target', 'mwcc_242_81', '--name', 'f'], () => ELF);
    expect(r.code).toBe(66);
    expect(r.stderr).toContain('no PowerPC objdump');
    expect(r.stderr).toContain('ASMLIFT_PPC_OBJDUMP');
    expect(r.stderr).toContain('tools.asmlift.objdump');
  } finally {
    if (prev === undefined) {
      delete process.env.ASMLIFT_PPC_OBJDUMP;
    } else {
      process.env.ASMLIFT_PPC_OBJDUMP = prev;
    }
  }
});
