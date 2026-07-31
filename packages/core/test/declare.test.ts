// Declaration synthesis for self-declaring candidates (src/declare.ts — core-resident so the
// cli AND the webapp wasm scorer share one renderer) —
// research/self-declaring-candidates-2026-07-26.md. Byte-fidelity pins: member signedness
// spells s8-vs-u8 (an s8 read is ldrb+lsl+asr, u8 is ldrb alone), volatile/const survive,
// struct layouts are padded to exact offsets, and NOTHING guesses (a shapeless symbol is
// skipped so the candidate fails loud, never a silently-wrong declaration).
import { expect, test } from 'vitest';

import { renderDeclarations } from '../src/declare';
import type { SymbolRef } from '../src/l3/symbol-refs';

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

test('a shapeless (name-only) data symbol declares the u32 cell — the documented exception', () => {
  // symtab-only map projects (marioparty3) publish named-spelling rows whose eval compiled
  // inside project headers; the self-declared world needs SOME object decl for the name. The
  // u32 cell is address-identical for `&name` forms and word-exact for the bare spelling; a
  // narrower bare access under it can only LOSE score (target bytes derive from truth decls).
  expect(renderDeclarations([ref('gMystery', { kind: 'data' })])).toBe('extern u32 gMystery;\n');
  expect(renderDeclarations([ref('gRom', { kind: 'data', const: true })])).toBe('extern const u32 gRom;\n');
});

test('a name-only symbol with IR access facts declares that exact cell (the width authority)', () => {
  // rank.ts attaches the candidate's own bare off-0 access width/signedness; the decl must
  // reproduce it exactly — `extern u16 g;` compiles `g = v` to `sh` where a u32 guess is `sw`.
  const at = (name: string, access: { width: number; signed: boolean }) => ({
    ...ref(name, { kind: 'data' }),
    access,
  });
  expect(renderDeclarations([at('frameBufferCount', { width: 2, signed: false })])).toBe(
    'extern u16 frameBufferCount;\n',
  );
  expect(renderDeclarations([at('gLevel', { width: 1, signed: true })])).toBe('extern s8 gLevel;\n');
  // an un-declarable width (8-byte cell) falls back to the u32 address cell
  expect(renderDeclarations([at('gWide', { width: 8, signed: false })])).toBe('extern u32 gWide;\n');
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

test('a pointer global with NO pointee layout declares as void* (quals bind the variable)', () => {
  expect(renderDeclarations([ref('gPtr', { kind: 'data', shape: 'pointer' })])).toBe('extern void *gPtr;\n');
  expect(renderDeclarations([ref('gVolPtr', { kind: 'data', shape: 'pointer', volatile: true })])).toBe(
    'extern void *volatile gVolPtr;\n',
  );
  // named but layout-less: still void*, since no `->member` spelling can be emitted for it
  expect(
    renderDeclarations([ref('gOpaque', { kind: 'data', shape: 'pointer', pointee: { structName: 'Save', size: 8 } })]),
  ).toBe('extern void *gOpaque;\n');
});

test('a pointer global WITH a pointee layout declares the padded pointee and a typed extern', () => {
  // what the `gPtr->member` / `gPtr->member[i]` spellings compile against. The array member keeps
  // its OWN element type: `u8 slots[16]` spelled as the byte array of the same size would index
  // identically, but `u16 words[8]` spelled `u8 words[16]` would index BYTES — a wrong address.
  const out = renderDeclarations([
    ref('gSave', {
      kind: 'data',
      shape: 'pointer',
      pointee: {
        structName: 'Save',
        size: 24,
        layout: [
          { name: 'checksum', offset: 0, size: 4, signed: false },
          { name: 'words', offset: 8, size: 16, elemSize: 2, elemSigned: false, length: 8 },
        ],
      },
    }),
  ]);
  expect(out).toBe('struct Save { u32 checksum; u8 asmlift_pad_0[4]; u16 words[8]; };\nextern struct Save *gSave;\n');
});

test('an unsizable pointee member declines the typed extern — never a shifted layout', () => {
  const out = renderDeclarations([
    ref('gFlexPtr', {
      kind: 'data',
      shape: 'pointer',
      pointee: { structName: 'Flex', size: 8, layout: [{ name: 'data', offset: 4, size: null }] },
    }),
  ]);
  expect(out).toBe('extern void *gFlexPtr;\n');
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
