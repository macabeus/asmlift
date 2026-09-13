// Row identity (bench-schema ./identity): a real row is keyed by its address, its id is
// presentation, and a row answers to its former names. These pin the three properties the address
// migration exists to buy — a rename is not a removal, a pre-migration artifact still joins, and a
// same-named row of a DIFFERENT decompilation does not.
import { type Identifiable, joinArtifacts, resolveRow, rowIdentity, rowNames } from '@asmlift/bench-schema';
import { describe, expect, test } from 'vitest';

const real = (sym: string, over: Partial<Identifiable> = {}): Identifiable => ({
  id: `kleod:${sym}:agbcc`,
  project: 'kleod',
  sym,
  toolchain: 'agbcc',
  tier: 'real',
  sourceUrl: 'https://github.com/macabeus/kleod/blob/6f149e3/src/x.c#L1-L2',
  ...over,
});
const syn = (sym: string, toolchain = 'agbcc'): Identifiable => ({
  id: `synthetic:${sym}:${toolchain}`,
  project: 'synthetic',
  sym,
  toolchain,
  tier: 'synthetic',
});

describe('rowIdentity', () => {
  test('a real row with an address is keyed by it; its id plays no part', () => {
    expect(rowIdentity(real('sub_0804B254', { addr: '0x0804b254' }))).toBe('kleod:0x0804b254:agbcc');
    expect(rowIdentity(real('ReadU16', { addr: '0x0804b254' }))).toBe(
      rowIdentity(real('sub_0804B254', { addr: '0x0804b254' })),
    );
  });

  test('a synthetic row, and a real row from an artifact that predates addresses, are keyed by id', () => {
    expect(rowIdentity(syn('add'))).toBe('synthetic:add:agbcc');
    expect(rowIdentity(real('ReturnOne'))).toBe('kleod:ReturnOne:agbcc');
  });
});

describe('resolveRow — every spelling a person or a link uses', () => {
  const rows = [
    real('ReadU16', { addr: '0x0804b254', aliases: ['sub_0804B254'] }),
    syn('add', 'agbcc'),
    syn('add', 'ido7.1'),
  ];

  test('identity, id, alias id, and project:name all find the row', () => {
    for (const ref of [
      'kleod:0x0804b254:agbcc',
      'kleod:ReadU16:agbcc',
      'kleod:sub_0804B254:agbcc',
      'kleod:sub_0804B254',
      'kleod:ReadU16',
    ]) {
      expect(resolveRow(rows, ref)?.sym, ref).toBe('ReadU16');
    }
    expect(rowNames(rows[0])).toEqual(['kleod:ReadU16:agbcc', 'kleod:sub_0804B254:agbcc']);
  });

  test('a toolchain-less name that answers to two rows is ambiguous, and resolves to nothing', () => {
    expect(resolveRow(rows, 'synthetic:add')).toBeUndefined();
    expect(resolveRow(rows, 'synthetic:add:ido7.1')?.toolchain).toBe('ido7.1');
    expect(resolveRow(rows, 'kleod:Nope')).toBeUndefined();
  });
});

describe('joinArtifacts', () => {
  test('a NAME-keyed base joins an ADDRESS-keyed head through the name — and says how many it bridged', () => {
    const base = [real('MultiplyQ8'), syn('add')];
    const head = [real('MultiplyQ8', { addr: '0x08000948' }), syn('add')];
    const j = joinArtifacts(base, head);
    expect(j.baseKey(base[0])).toBe(j.headKey(head[0]));
    expect(j.baseKey(base[1])).toBe(j.headKey(head[1]));
    expect(j.bridged).toBe(1);
  });

  test('a rename between two ADDRESS-keyed artifacts joins at the address, not through the alias', () => {
    const base = [real('sub_0804B254', { addr: '0x0804b254' })];
    const head = [real('ReadU16', { addr: '0x0804b254', aliases: ['sub_0804B254'] })];
    const j = joinArtifacts(base, head);
    expect(j.baseKey(base[0])).toBe(j.headKey(head[0]));
    expect(j.bridged).toBe(0);
  });

  test('the same ADDRESS cited from a DIFFERENT repository does not join either: a source swap is removed + added', () => {
    // The kleod swap: 37 of the 42 new rows sit at an old row's address. Before this rule, a base
    // that carried addresses read CountCollectedGems (match) → WorldMapScreenCheckNewWorldUnlocked
    // (nonmatch) as ONE row losing its match, while a name-keyed base read the same pair as missing
    // + added: one swap, two answers, chosen by which artifact was the base.
    const old = 'https://github.com/Dream-Atelier/kl-eod-decomp/blob/494f499/src/x.c#L1-L2';
    const base = [
      real('CountCollectedGems', { addr: '0x0801e0b4', sourceUrl: old }),
      real('Kept', { addr: '0x08000100' }),
    ];
    const head = [
      real('WorldMapScreenCheckNewWorldUnlocked', { addr: '0x0801e0b4' }),
      real('Kept', { addr: '0x08000100' }),
    ];
    const j = joinArtifacts(base, head);
    expect(head.map(j.headKey)).not.toContain(j.baseKey(base[0]));
    expect(base.map(j.baseKey)).not.toContain(j.headKey(head[0]));
    // the same-repository row beside it still joins at its address
    expect(j.baseKey(base[1])).toBe(j.headKey(head[1]));
  });

  test('the same NAME cited from a DIFFERENT repository does not join: it is another decompilation', () => {
    const base = [
      real('MultiplyQ8', { sourceUrl: 'https://github.com/Dream-Atelier/kl-eod-decomp/blob/494f499/src/math.c#L1-L2' }),
    ];
    const head = [real('MultiplyQ8', { addr: '0x08000948' })];
    const j = joinArtifacts(base, head);
    expect(j.baseKey(base[0])).not.toBe(j.headKey(head[0]));
    expect(j.bridged).toBe(0);
  });
});
