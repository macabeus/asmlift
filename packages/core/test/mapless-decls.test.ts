// SELF-DECLARING CANDIDATES, THE MAP-LESS HALF — the invariant "a candidate's source only names
// symbols the map knows" is FALSE. asmlift reads a global's NAME out of the `.s` file's own
// literal pool (`.word gBgTilemapBufs`, frontend/thumb.ts's pool grammar) or out of a MIPS
// relocation, and spells `&gSym` with no map anywhere in sight. Before this file, `refsOf`
// (rank.ts) short-circuited to `[]` whenever `opts.symbols` was absent, so those candidates
// carried NO symbolRefs, the playground synthesized NO declarations, and every candidate of such
// a function failed to compile with "`gUnk_08116880' undeclared" — 43 of the benchmark's 126
// rankable agbcc rows.
//
// The declaration synthesis for a name-only symbol is NOT new: declare.ts's `default:` arm has
// rendered `extern <T> name;` for symtab-only map projects since the self-declaring round. What
// is new is that a map-LESS reference reaches it at all, that a PARTIAL map unions with the
// synthesis instead of switching it off, and the REFUSALS that keep the synthesis from claiming
// a name it cannot declare (a non-identifier reloc name, a name no `extern` can bind, a call
// target, the function's own name, a name the emitted tree binds as a local).
//
// Everything here drives the PUBLIC entry point (`enumerateCandidates`), never a hand-built `Fn`:
// the refusals are only worth pinning on the path the playground actually takes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { renderDeclarations, selfDeclaredContextFor } from '../src/declare';
import { type RefusedDeclarationReason, enumerateCandidates } from '../src/rank';
import { type SymbolMap, symbolsByName } from '../src/symbols';
import { ARMV4T_AGBCC, C_TYPEDEFS, MIPS_IDO } from '../src/target';

const corpus = (f: string) => readFileSync(join(import.meta.dirname, 'corpus', f), 'utf8');

/** A one-instruction MIPS function that value-references `sym` through a %hi/%lo pair — the
 *  frontend path that takes a symbol name straight from a RELOCATION, where the names that are
 *  not C identifiers actually live. */
const mipsRef = (sym: string) => `glabel getGlobal
    /* 200 80000200 3C02800A */  lui        $v0, %hi(${sym})
    /* 204 80000204 03E00008 */  jr         $ra
    /* 208 80000208 8C422884 */   lw        $v0, %lo(${sym})($v0)
endlabel getGlobal
`;

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

  test('every one of them is marked SYNTHESIZED — no map knew the name', () => {
    // The marker is the whole reason a consumer can publish an honest verdict: these
    // declarations were read out of the same asm the candidate is scored against, so they cannot
    // lose score, so they must be SHOWN rather than assumed away (see SymbolRef.synthesized).
    for (const c of cands) {
      expect((c.symbolRefs ?? []).every((r) => r.synthesized === true)).toBe(true);
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

  test('the compilation context is CORE\u2019s composition, prelude then block', () => {
    // One composition with two callers (the cli compile seam and the webapp scorer) — a second
    // hand-rolled `C_TYPEDEFS + decls` is how the two scoring worlds drift.
    const ctx = selfDeclaredContextFor(cands[0].symbolRefs);
    expect(ctx).toBe(C_TYPEDEFS + renderDeclarations(cands[0].symbolRefs!));
    expect(selfDeclaredContextFor(undefined)).toBe(C_TYPEDEFS);
    expect(selfDeclaredContextFor([])).toBe(C_TYPEDEFS);
  });
});

describe('a PARTIAL symbol map unions with the synthesis, it does not switch it off', () => {
  // The Symbols pane's normal case: a `.map`/symtab paste covers some pool names and not others.
  // With the old per-CALL fallback (`opts.symbols ?? bareGlobalSymbols(...)`), supplying ONE
  // entry made the tool strictly worse — the other two names lost their declarations and the row
  // went straight back into the reported bug.
  const asm = corpus('agbcc-mapless-globals.s');
  const partial: SymbolMap = new Map([
    [0x08116880, [{ name: 'gUnk_08116880', kind: 'data' as const, shape: 'array' as const, elemSize: 1 }]],
  ]);
  const cands = enumerateCandidates('UpdateWorldMapNodeTile', asm, ARMV4T_AGBCC, { symbols: partial });

  test('all three names are still declared, and the map wins on the one it knows', () => {
    const refs = cands[0].symbolRefs ?? [];
    expect(refs.map((r) => r.name)).toEqual(['gBgTilemapBufs', 'gUnk_08116748', 'gUnk_08116880']);
    const decls = renderDeclarations(refs);
    // the map's own shape for the name it knows …
    expect(decls).toContain('extern u8 gUnk_08116880[];');
    // … and the synthesized cell for the two it does not
    expect(decls).toContain('extern u32 gBgTilemapBufs;');
    expect(decls).toContain('extern u32 gUnk_08116748;');
  });

  test('provenance is per NAME: the map-known ref is not marked synthesized, the others are', () => {
    const byName = new Map((cands[0].symbolRefs ?? []).map((r) => [r.name, r]));
    expect(byName.get('gUnk_08116880')!.synthesized).toBeUndefined();
    expect(byName.get('gBgTilemapBufs')!.synthesized).toBe(true);
    expect(byName.get('gUnk_08116748')!.synthesized).toBe(true);
  });

  test('a name the map knows keeps taking the map path — symbolsByName is the same dictionary', () => {
    // The union is `bare ∪ map` with the map winning, so a map-ful row cannot lose a fact.
    expect(symbolsByName(partial).get('gUnk_08116880')!.shape).toBe('array');
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
      // …and it is FITTED to the target asm, which is why it carries the marker
      expect(c.symbolRefs?.[0].synthesized).toBe(true);
    }
  });
});

describe('the refusals — a name a declaration cannot claim is left undeclared, and REPORTED', () => {
  const refusalsFor = (name: string, asm: string, target = MIPS_IDO) => {
    const refused: { name: string; reason: RefusedDeclarationReason }[] = [];
    const cands = enumerateCandidates(name, asm, target, {
      onRefusedDeclaration: (n, reason) => refused.push({ name: n, reason }),
    });
    return { cands, refused };
  };

  test('R1 — a relocation name that is not a C identifier (`$LC0`, `.rodata`)', () => {
    // frontend/mips.ts takes `sym` straight from an object relocation, which can name `$LC0` or
    // `.rodata.str1`; `extern u32 $LC0;` is a syntax error that fails that candidate's whole
    // translation unit (each candidate compiles alone, with its own block — so the poisoning is
    // per spelling, not across siblings). Undeclared is the loud outcome, and the source spells
    // `$LC0` anyway, which no declaration could rescue.
    for (const sym of ['$LC0', '.rodata']) {
      const { cands, refused } = refusalsFor('getGlobal', mipsRef(sym));
      expect(cands[0].symbolRefs ?? []).toEqual([]);
      expect(refused).toEqual([{ name: sym, reason: 'not-an-identifier' }]);
    }
  });

  test('R2 — a name `extern u32 <name>;` cannot declare (keyword, prelude typedef, built-in)', () => {
    // MEASURED against the pinned agbcc, not assumed: `asm`/`typeof`/`__attribute__` are syntax
    // errors, `exit`/`abort` are "redeclared as different kind of symbol", `u32` redefines the
    // type the block is written in, and `inline` parses as an EMPTY declaration that declares
    // nothing at all.
    for (const sym of ['u32', 'int', 'asm', 'typeof', '__attribute__', 'exit', 'abort', 'inline']) {
      const { cands, refused } = refusalsFor('getGlobal', mipsRef(sym));
      expect(cands[0].symbolRefs ?? []).toEqual([]);
      expect(refused).toEqual([{ name: sym, reason: 'reserved' }]);
    }
  });

  test('R2 — an ordinary name beside them is still declared (the refusal is not a blanket)', () => {
    const { cands, refused } = refusalsFor('getGlobal', mipsRef('D_800A2884'));
    expect((cands[0].symbolRefs ?? []).map((r) => r.name)).toEqual(['D_800A2884']);
    expect(refused).toEqual([]);
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

  test('R4 — a name the emitted tree BINDS is refused: the extern would be inert, not wrong', () => {
    // The reported row's own asm with one pool global renamed to the emitter's parameter name.
    // A local/parameter of the same name shadows a file-scope extern, so the declaration would
    // change nothing (`&a0` takes the stack slot either way) while claiming a reference the
    // source does not make. It cannot false-match — a stack address is never a relocated one —
    // so the honest handling is to declare nothing and SAY so.
    const asm = corpus('agbcc-mapless-globals.s').replace(/gUnk_08116880/g, 'a0');
    const { cands, refused } = refusalsFor('UpdateWorldMapNodeTile', asm, ARMV4T_AGBCC);
    expect(cands[0].source).toContain('&a0'); // the collision is real: the tree spells it
    expect((cands[0].symbolRefs ?? []).map((r) => r.name)).toEqual(['gBgTilemapBufs', 'gUnk_08116748']);
    expect(refused).toEqual([{ name: 'a0', reason: 'shadowed' }]);
  });

  test('R4 — the emitter already avoids the collision where it MINTS the name', () => {
    // Renaming the same global to `p0` (a pointer local the emitter would otherwise mint) does
    // NOT collide: basecse names its base local around the global, so the declaration stands and
    // nothing is refused. The refusal above is the residue — a PARAMETER name, which is
    // positional and cannot move.
    const asm = corpus('agbcc-mapless-globals.s').replace(/gUnk_08116880/g, 'p0');
    const { cands, refused } = refusalsFor('UpdateWorldMapNodeTile', asm, ARMV4T_AGBCC);
    expect((cands[0].symbolRefs ?? []).map((r) => r.name)).toContain('p0');
    expect(refused).toEqual([]);
  });

  test('a refusal is reported ONCE per (name, reason), not once per candidate', () => {
    const { cands, refused } = refusalsFor('getGlobal', mipsRef('$LC0'));
    expect(cands.length).toBeGreaterThan(0);
    expect(refused).toHaveLength(1);
  });

  test('a name-only symbol is data, never code — map-less the IR cannot tell them apart', () => {
    // `code: true` is set only from a symbol map (frontend/thumb.ts), so map-less a function
    // pointer and a data address are the same `gaddr`. structure.ts spells both `&Name`, and
    // `&Name` under `extern u32 Name;` is the relocated address whatever Name really is.
    const { cands } = refusalsFor('getGlobal', mipsRef('D_800A2884'));
    expect(cands[0].symbolRefs?.[0].info).toEqual({ name: 'D_800A2884', kind: 'data' });
  });
});
