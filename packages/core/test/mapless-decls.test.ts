// SELF-DECLARING CANDIDATES, THE MAP-LESS HALF — the invariant "a candidate's source only names
// symbols the map knows" is FALSE. asmlift reads a global's NAME out of the `.s` file's own
// literal pool (`.word gBgTilemapBufs`, frontend/thumb.ts's pool grammar) and spells `&gSym`
// with no map anywhere in sight. Before this file, `refsOf` (rank.ts) short-circuited to `[]`
// whenever `opts.symbols` was absent, so those candidates carried NO symbolRefs, the playground
// synthesized NO declarations, and every candidate of such a function failed to compile with
// "`gUnk_08116880' undeclared" — 43 of the benchmark's 126 rankable agbcc rows.
//
// The declaration synthesis for a name-only symbol is NOT new: declare.ts's `default:` arm has
// rendered `extern <T> name;` for symtab-only map projects since the self-declaring round. What
// is new is that a map-LESS reference reaches it at all, and the REFUSALS that keep the
// synthesis from poisoning a translation unit (a non-identifier reloc name, a prelude typedef
// name, a call target, the function's own name) are pinned here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { renderDeclarations } from '../src/declare';
import { type Fn, mkOp, mkValue } from '../src/ir/core';
import { T } from '../src/ir/types';
import { bareGlobalSymbols, enumerateCandidates } from '../src/rank';
import { ARMV4T_AGBCC } from '../src/target';

const corpus = (f: string) => readFileSync(join(import.meta.dirname, 'corpus', f), 'utf8');

describe('the reported row: kleod UpdateWorldMapNodeTile, opened in the playground with no map', () => {
  // The real benchmark row (`kleod:UpdateWorldMapNodeTile:agbcc`). Its pool names three globals
  // in each of its two literal pools; the playground opens a row with no symbol map at all.
  const cands = enumerateCandidates('UpdateWorldMapNodeTile', corpus('agbcc-mapless-globals.s'), ARMV4T_AGBCC);

  test('every candidate carries the pool-named globals as refs, and they render as externs', () => {
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect((c.symbolRefs ?? []).map((r) => r.name)).toEqual(['gBgTilemapBufs', 'gUnk_08116748', 'gUnk_08116880']);
      // name-only: no map shape, so declare.ts's documented `default:` arm renders the cell
      expect(renderDeclarations(c.symbolRefs!)).toBe(
        'extern u32 gBgTilemapBufs;\nextern u32 gUnk_08116748;\nextern u32 gUnk_08116880;\n',
      );
    }
  });

  test('the declarations cover every global the source actually spells', () => {
    for (const c of cands) {
      const declared = new Set((c.symbolRefs ?? []).map((r) => r.name));
      // every `gXxx` identifier the emitted source names must have a declaration, or the
      // candidate cannot compile outside the project's own headers
      for (const name of c.source.match(/\bg[A-Za-z_]\w*/g) ?? []) {
        expect(declared.has(name)).toBe(true);
      }
      expect(c.source).toContain('gUnk_08116880');
    }
  });
});

describe('the width authority is the candidate\u2019s own IR, map or no map', () => {
  test('a bare off-0 halfword access declares u16, not the u32 fallback', () => {
    // rank.ts's `accessFacts` was gated on `opts.symbols` too: without it every map-less
    // declaration would be the `extern u32` fallback, and `gHalfCell = x` would compile to
    // `str` where the target says `strh`.
    const cands = enumerateCandidates('maplesshalf', corpus('agbcc-mapless-half.s'), ARMV4T_AGBCC);
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(c.symbolRefs?.map((r) => r.access)).toEqual([{ width: 2, signed: false }]);
      expect(renderDeclarations(c.symbolRefs!)).toBe('extern u16 gHalfCell;\n');
    }
  });
});

describe('the refusals — a synthesized declaration that could poison the TU is not emitted', () => {
  const fnWith = (syms: string[]): Fn => ({
    name: 'f',
    blocks: [
      {
        params: [],
        ops: [...syms.map((sym) => mkOp('gaddr', { results: [mkValue(T.unk(32))], attrs: { sym } })), mkOp('ret', {})],
      },
    ],
  });

  test('R1 — a name that is not a C identifier is refused (MIPS reloc names carry `.` and `$`)', () => {
    // frontend/mips.ts takes `sym` straight from an object relocation, which can name `$L1` or
    // `.rodata.str1`; `extern u32 $L1;` is a syntax error that fails the WHOLE translation unit,
    // including candidates that had nothing to do with it. Undeclared is the loud outcome.
    expect([...bareGlobalSymbols(fnWith(['$L1', '.rodata.str1', 'gOk'])).keys()]).toEqual(['gOk']);
  });

  test('R2 — a prelude typedef or C keyword name is refused (redeclaring u32 is a hard error)', () => {
    expect([...bareGlobalSymbols(fnWith(['u32', 's16', 'int', 'gOk'])).keys()]).toEqual(['gOk']);
  });

  test('R3 — a call target and the function\u2019s own name stay undeclared', () => {
    // Both refusals live in collectSymbolRefs and are NOT relaxed by the map-less fallback:
    // `void F(void);` over a call with args is a gcc-2.9 hard error, and a declaration of the
    // function's own name conflicts with its definition.
    const body =
      '\tpush\t{lr}\n\tldr\tr0, .L1\n\tbl\tDoThing\n\tldr\tr0, .L1+0x4\n\tpop\t{r1}\n\tbx\tr1\n' +
      '.L1:\n\t.word\tDoThing\n\t.word\tf\n';
    const cands = enumerateCandidates('f', `f:\n${body}`, ARMV4T_AGBCC);
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      const names = (c.symbolRefs ?? []).map((r) => r.name);
      expect(names).not.toContain('DoThing');
      expect(names).not.toContain('f');
    }
  });

  test('a name-only symbol is data, never code — map-less the IR cannot tell them apart', () => {
    // `code: true` is set only from a symbol map (frontend/thumb.ts), so map-less a function
    // pointer and a data address are the same `gaddr`. structure.ts spells both `&Name`, and
    // `&Name` under `extern u32 Name;` is the relocated address whatever Name really is.
    expect([...bareGlobalSymbols(fnWith(['gOk'])).values()]).toEqual([{ name: 'gOk', kind: 'data' }]);
  });
});
