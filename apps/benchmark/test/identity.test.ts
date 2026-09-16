// Row identity (bench-schema ./identity): a real row is keyed by its address, its id is
// presentation, and a row answers to its former names. These pin the three properties the address
// migration exists to buy — a rename is not a removal, a pre-migration artifact still joins, and a
// same-named row of a DIFFERENT decompilation does not.
import {
  ADDR_PATTERN,
  type Identifiable,
  idNames,
  joinArtifacts,
  moduleLocation,
  moduleOf,
  onlySelects,
  resolveRow,
  retiredKeySet,
  retirementKeys,
  rowIdentity,
  rowNames,
  selectByRef,
} from '@asmlift/bench-schema';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

describe('selection answers to a former name through every reader', () => {
  // Before one rule: after a rename, `bench target Old` (resolveRow) found the row, while
  // `bench fan Old` (selectCases), `bench sweep --only Old` (selectsRow) and `bench run --only Old`
  // (realCases) selected nothing and said nothing. The CLI entries themselves are pinned in
  // fan.test.ts and sweep.test.ts; these pin the two functions all of them go through.
  const renamed = real('EntityLookup', { addr: '0x0803d140', aliases: ['sub_0803D140'] });

  test('idNames spells an alias id exactly as rowNames does', () => {
    expect(idNames(renamed.id, renamed.aliases)).toEqual(rowNames(renamed));
    expect(idNames('synthetic:add:ido7.1')).toEqual(['synthetic:add:ido7.1']);
  });

  test('--only: a substring of the name or of a former name, never of project or toolchain', () => {
    expect(onlySelects('sub_0803D1', renamed.sym, renamed.aliases)).toBe(true);
    expect(onlySelects('Lookup', renamed.sym, renamed.aliases)).toBe(true);
    expect(onlySelects('kleod', renamed.sym, renamed.aliases)).toBe(false);
    expect(onlySelects(undefined, renamed.sym)).toBe(true);
  });

  test('by reference: an old id resolves exactly, and a substring of an old id still selects', () => {
    const rows = [renamed, syn('add')];
    expect(selectByRef(rows, 'kleod:sub_0803D140:agbcc')).toEqual([renamed]);
    expect(selectByRef(rows, 'sub_0803D140')).toEqual([renamed]);
    expect(selectByRef(rows, 'Nope')).toEqual([]);
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

// GAMECUBE REL CODE. A module is placed by the game's loader, so its functions have no linked
// address and are keyed by their location in the module instead. These pin the grammar, the
// module a location names, and — the property the whole spelling rests on — that carrying a `:`
// inside an identity breaks no reader of one.
const rel = (sym: string, addr: string, over: Partial<Identifiable> = {}): Identifiable => ({
  id: `marioparty4:${sym}:mwcc_242_81`,
  project: 'marioparty4',
  sym,
  toolchain: 'mwcc_242_81',
  tier: 'real',
  addr,
  sourceUrl: 'https://github.com/macabeus/marioparty4/blob/4f59dfde/src/REL/executor.c#L1-L2',
  ...over,
});

describe('a REL module location', () => {
  test('ADDR_PATTERN accepts a module location and a linked address, and nothing else', () => {
    for (const ok of [
      '0x0804b254',
      'm427Dll:.text+0x0000c2bc',
      'foresta:.text+0x00000000',
      'm446dll:.init+0x000000a0',
    ]) {
      expect(ADDR_PATTERN.test(ok), ok).toBe(true);
    }
    for (const bad of [
      '0x804b254', // not eight digits
      '0X0804B254', // uppercase
      'm427Dll:.text+0xc2bc', // offset not eight digits
      'm427Dll:text+0x0000c2bc', // section without its dot
      'm427Dll:.text', // no offset
      ':.text+0x0000c2bc', // no module
      'm427Dll:.text+0x0000C2BC', // uppercase offset
    ]) {
      expect(ADDR_PATTERN.test(bad), bad).toBe(false);
    }
  });

  test('moduleLocation reads the module, the section and the offset; a linked address has none', () => {
    expect(moduleLocation('m427Dll:.text+0x0000c2bc')).toEqual({
      module: 'm427Dll',
      section: '.text',
      offset: 0xc2bc,
    });
    expect(moduleLocation('0x0804b254')).toBeUndefined();
    expect(moduleOf('m427Dll:.text+0x0000c2bc')).toBe('m427Dll');
    expect(moduleOf('0x0804b254')).toBeUndefined();
    expect(moduleOf(undefined)).toBeUndefined();
  });

  test('the module is the disc file stem, case and all — `m446dll` is not `m446Dll`', () => {
    expect(moduleOf('m446dll:.text+0x00000100')).toBe('m446dll');
  });
});

describe('an identity carrying a `:` is still one key', () => {
  const row = rel('ObjectSetup', 'm416Dll:.text+0x00001f20');

  test('rowIdentity keys the row by its location, and the id stays project:sym:toolchain', () => {
    expect(rowIdentity(row)).toBe('marioparty4:m416Dll:.text+0x00001f20:mwcc_242_81');
    expect(rowNames(row)).toEqual(['marioparty4:ObjectSetup:mwcc_242_81']);
  });

  test('the same name in two modules is two rows; the same location under two names is one', () => {
    const other = rel('ObjectSetup', 'm417Dll:.text+0x00001f20', { id: 'marioparty4:ObjectSetup:mwcc_242_81' });
    expect(rowIdentity(row)).not.toBe(rowIdentity(other));
    const renamed = rel('fn_1_1F20', 'm416Dll:.text+0x00001f20');
    expect(rowIdentity(renamed)).toBe(rowIdentity(row));
  });

  test('resolveRow finds it by identity, by id and by project:name', () => {
    const rows = [row, syn('add')];
    for (const ref of [
      'marioparty4:m416Dll:.text+0x00001f20:mwcc_242_81',
      'marioparty4:ObjectSetup:mwcc_242_81',
      'marioparty4:ObjectSetup',
    ]) {
      expect(resolveRow(rows, ref)?.sym, ref).toBe('ObjectSetup');
    }
  });

  test('joinArtifacts joins two REL rows at the location, across a rename', () => {
    const base = [rel('fn_1_1F20', 'm416Dll:.text+0x00001f20')];
    const head = [rel('ObjectSetup', 'm416Dll:.text+0x00001f20', { aliases: ['fn_1_1F20'] })];
    const j = joinArtifacts(base, head);
    expect(j.baseKey(base[0])).toBe(j.headKey(head[0]));
    expect(j.bridged).toBe(0);
  });

  test('retirement keys both spellings, and the register splits only the id', () => {
    const keys = retirementKeys(row);
    expect(keys).toContain('marioparty4:m416Dll:.text+0x00001f20:mwcc_242_81@macabeus/marioparty4');
    expect(keys).toContain('marioparty4:ObjectSetup:mwcc_242_81@macabeus/marioparty4');
    const register = retiredKeySet([{ id: row.id, addr: row.addr!, sourceUrl: row.sourceUrl! }]);
    expect(keys.some((k) => register.has(k))).toBe(true);
  });
});

test('nothing in the shipped sources splits a row IDENTITY on `:`', () => {
  // A REL row's identity has four `:`-separated segments, so a reader that recovers a row's parts
  // by splitting on `:` is only correct if what it splits is an ID (three segments, middle a
  // symbol name). These are every `split(':')` the sources contain; each one is on an id, except
  // compile-command's, which splits a flag's path list. A new entry belongs here only after the
  // same check.
  const roots = [
    join(import.meta.dirname, '..', 'src'),
    ...readdirSync(join(import.meta.dirname, '..', '..', '..', 'packages'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(e.parentPath, e.name, 'src')),
  ].filter((d) => {
    try {
      readdirSync(d);
      return true;
    } catch {
      return false;
    }
  });
  const found: string[] = [];
  for (const root of roots) {
    for (const f of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
      if (!f.endsWith('.ts')) {
        continue;
      }
      for (const line of readFileSync(join(root, f), 'utf8').split('\n')) {
        if (/\.split\(['"]:['"]\)/.test(line)) {
          found.push(`${root.split('/').slice(-3).join('/')}/${f}: ${line.trim()}`);
        }
      }
    }
  }
  expect(found.sort()).toEqual([
    "apps/benchmark/src/cases/real.ts: `run \\`pnpm bench flags --project ${id.split(':')[0]}\\`, then \\`pnpm bench vendor\\``,",
    "apps/benchmark/src/cases/retired.ts: r.id.split(':').length < 3 ||",
    "apps/benchmark/src/run/sweep.ts: const parts = id.split(':');",
    "packages/bench-schema/src/identity.ts: const parts = e.id.split(':');",
    "packages/cli/src/compile-command.ts: for (const seg of val.split(':')) {",
  ]);
});
