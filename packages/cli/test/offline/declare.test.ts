// Declaration synthesis for self-declaring candidates (src/declare.ts) —
// research/self-declaring-candidates-2026-07-26.md. Byte-fidelity pins: member signedness
// spells s8-vs-u8 (an s8 read is ldrb+lsl+asr, u8 is ldrb alone), volatile/const survive,
// struct layouts are padded to exact offsets, and NOTHING guesses (a shapeless symbol is
// skipped so the candidate fails loud, never a silently-wrong declaration).
import type { SymbolRef } from '@asmlift/core/l3/symbol-refs';
import { expect, test } from 'vitest';

import { renderDeclarations } from '../../src/declare';

const ref = (name: string, info: Omit<SymbolRef['info'], 'name'>): SymbolRef => ({
  name,
  info: { name, ...info },
});

test('a padded struct decl: signed narrow member, offset gaps and tail as u8 pads', () => {
  const out = renderDeclarations([
    ref('gStream', {
      kind: 'data',
      shape: 'struct',
      structName: 'GfxStream',
      size: 8,
      layout: [
        { name: 'timer', offset: 0, size: 1, signed: true }, // s8 — ldrb+lsl+asr, not ldrb
        { name: 'mode', offset: 2, size: 2, signed: false },
      ],
    }),
  ]);
  expect(out).toBe(
    'struct GfxStream { s8 timer; u8 asmlift_pad_0[1]; u16 mode; u8 asmlift_pad_1[4]; };\nextern struct GfxStream gStream;\n',
  );
});

test('a POINTER member spells void* (compare signedness truth); a volatile member keeps volatile', () => {
  const out = renderDeclarations([
    ref('gStream', {
      kind: 'data',
      shape: 'struct',
      structName: 'Stream',
      size: 8,
      layout: [
        { name: 'pos', offset: 0, size: 4, pointer: true }, // truth u8* — s32 would flip bcc→blt
        { name: 'level', offset: 4, size: 2, signed: false, volatile: true }, // vu16 field idiom
      ],
    }),
  ]);
  expect(out).toBe(
    'struct Stream { void *pos; volatile u16 level; u8 asmlift_pad_0[2]; };\nextern struct Stream gStream;\n',
  );
});

test('a volatile scalar (MMIO) keeps volatile; a const array keeps const + element signedness', () => {
  expect(
    renderDeclarations([ref('gMmio', { kind: 'data', shape: 'scalar', size: 2, signed: false, volatile: true })]),
  ).toBe('extern volatile u16 gMmio;\n');
  expect(
    renderDeclarations([ref('gTable', { kind: 'data', shape: 'array', elemSize: 2, elemSigned: true, const: true })]),
  ).toBe('extern const s16 gTable[];\n');
});

test('a value-referenced code symbol gets a void prototype', () => {
  expect(renderDeclarations([ref('DoThing', { kind: 'code' })])).toBe('void DoThing(void);\n');
});

test('nothing guesses: a shapeless data symbol renders NO declaration', () => {
  expect(renderDeclarations([ref('gMystery', { kind: 'data' })])).toBe('');
});

test('a narrow scalar without signedness is skipped; a 4-byte one is the C89 enum (s32)', () => {
  expect(renderDeclarations([ref('gNarrow', { kind: 'data', shape: 'scalar', size: 2 })])).toBe('');
  expect(renderDeclarations([ref('gEnumish', { kind: 'data', shape: 'scalar', size: 4 })])).toBe(
    'extern s32 gEnumish;\n',
  );
});

test('an unnamed struct mints a placeholder tag; a layoutless struct degrades to an unsized u8[]', () => {
  const withLayout = renderDeclarations([
    ref('gAnon', {
      kind: 'data',
      shape: 'struct',
      size: 4,
      layout: [{ name: 'a', offset: 0, size: 4, signed: false }],
    }),
  ]);
  expect(withLayout).toBe('struct Asmlift_gAnon { u32 a; };\nextern struct Asmlift_gAnon gAnon;\n');
  // no layout ⇒ every core spelling is &gSym-based, so the unsized byte-array extern is
  // codegen-identical — and can never seat a wrong field name
  expect(renderDeclarations([ref('gOpaque', { kind: 'data', shape: 'struct', structName: 'Opaque' })])).toBe(
    'extern u8 gOpaque[];\n',
  );
});

test('a pointer global declares as void* (pointee fidelity unnecessary; quals bind the variable)', () => {
  expect(renderDeclarations([ref('gPtr', { kind: 'data', shape: 'pointer' })])).toBe('extern void *gPtr;\n');
  expect(renderDeclarations([ref('gVolPtr', { kind: 'data', shape: 'pointer', volatile: true })])).toBe(
    'extern void *volatile gVolPtr;\n',
  );
});

test('an unsizable layout member declines the WHOLE struct decl (never a shifted layout)', () => {
  const out = renderDeclarations([
    ref('gFlex', {
      kind: 'data',
      shape: 'struct',
      structName: 'Flex',
      size: 8,
      layout: [
        { name: 'len', offset: 0, size: 4, signed: true },
        { name: 'data', offset: 4, size: null }, // flexible member — no faithful spelling
      ],
    }),
  ]);
  expect(out).toBe('extern u8 gFlex[];\n');
});

test('two struct refs sharing a tag declare it once; overlapping (union) members keep the first view', () => {
  const layout = [
    { name: 'x', offset: 0, size: 4, signed: false },
    { name: 'xAlias', offset: 0, size: 2, signed: false }, // union view — skipped
  ];
  const out = renderDeclarations([
    ref('gA', { kind: 'data', shape: 'struct', structName: 'Shared', size: 4, layout }),
    ref('gB', { kind: 'data', shape: 'struct', structName: 'Shared', size: 4, layout }),
  ]);
  expect(out).toBe('struct Shared { u32 x; };\nextern struct Shared gA;\nextern struct Shared gB;\n');
});
