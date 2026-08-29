// A PARAMETER'S POINTEE, and why threading it through buys nothing today. The proposal — carry a
// struct pointee on `SymbolTypeFacts` so a DWARF `Sprite *` argument stops arriving as `void *` —
// is priced here rather than re-derived, because the fact it would add has no reader: a declared
// parameter type is consulted for its WIDTH and a callee's list for its LENGTH, and neither reads
// what a `*` points at. Pinned below: that discard, the pointee asmlift recovers from the asm
// instead, the callee side that is the only transferable population, the `void *` the DWARF bridge
// writes today — and the one shape where a pointee WOULD be byte-load-bearing, which is a struct
// ASSIGNMENT and has no inhabitant.
//
// Each test below fails the moment a pointee starts to matter — which is the point. When it does,
// the refusal is stale and belongs re-measured, not re-asserted. The sibling refusal is
// test/sign-axis.test.ts; the prose half is docs/level-tower.md. Toolchain-free.
import { describe, expect, test } from 'vitest';

import { type ParamType, type Prototypes, declaredWidth, prototypesFromSymbols } from '../src/proto';
import { enumerateCandidates } from '../src/rank';
import { type SymbolMap, type SymbolTypeFacts } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

const sources = (asm: string, prototypes: Prototypes): string[] =>
  enumerateCandidates('f', asm, ARMV4T_AGBCC, { prototypes }).map((c) => `${c.label}\n${c.source}`);

/** The pointee spellings a DWARF thread would produce, against the `void *` it produces today and
 *  the bare COUNT that carries no type at all. Every candidate set below is asserted equal across
 *  all four. */
const POINTEE_SPELLINGS: readonly (ParamType | null)[] = [null, 'void *', 'struct Sprite *', 'const u8 *'];

describe('a declared pointee is discarded by the one reader of a parameter type', () => {
  test('declaredWidth answers 32 for every pointer, whatever it points at', () => {
    // The `*` test IS the discard: raise/paramwidth.ts (the sole call site) checks its inferred
    // width against this number, and a pointee cannot move a register-wide answer.
    for (const t of ['void *', 'struct Sprite *', 'const u8 *', 'volatile struct S **', 'Player *']) {
      expect(declaredWidth(t)).toBe(32);
    }
  });

  test('and a pointee has no room to reach it: SymbolTypeFacts is width, signedness, pointer-ness', () => {
    // A TYPECHECK-level pin, because the absence is upstream's: `SymbolSignature.params` is filled
    // from `@gba-kit/debug-info`'s `TypeFacts`, whose `{size, signed, pointer?}` is the whole
    // vocabulary. Adding a field here fails this line, and the reader is then owed a re-measurement
    // rather than a widened assertion.
    type Keys = keyof SymbolTypeFacts;
    const exhaustive: Record<Keys, true> = { size: true, signed: true, pointer: true };
    expect(Object.keys(exhaustive).sort()).toEqual(['pointer', 'signed', 'size']);
  });
});

// A pointer parameter written at three widths and read back at one — the shape that makes the
// recovered pointee visible in the output, so an inert declaration cannot hide behind `s32 *`.
const STRUCT_PARAM =
  'f:\n\tpush\t{r4, lr}\n\tstr\tr0, [r1, #0]\n\tstrh\tr0, [r1, #4]\n\tstrb\tr0, [r1, #6]\n' +
  '\tldr\tr3, [r1, #8]\n\tadds\tr3, r3, r0\n\tstr\tr3, [r1, #8]\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n';

describe('the pointee asmlift emits is SYNTHESIZED from the asm, not declared', () => {
  test('a pointer parameter recovers a struct tag and an interior spelling on its own', () => {
    const [primary] = sources(STRUCT_PARAM, {});
    expect(primary).toContain('struct Struct0 { s32 field_0; u16 field_4; u8 field_6; s32 field_8; };');
    expect(primary).toContain('void f(u32 a0, struct Struct0 * a1)');
    expect(primary).toContain('a1->field_6 = a0;');
  });

  test('…so declaring the pointee — or declaring nothing but the arity — changes no candidate', () => {
    // What a DWARF pointee would add here is a NAME for a field the access pattern already found,
    // and declare.ts's pointer arm states the invariant a name obeys: the cell is 4 bytes whatever
    // it addresses, and every stride is already explicit, so nothing emitted is scaled by it.
    const base = sources(STRUCT_PARAM, { f: { params: 2 } });
    expect(base.length).toBe(2);
    for (const spelling of POINTEE_SPELLINGS) {
      const params: number | ParamType[] = spelling === null ? 2 : ['s32', spelling];
      expect(sources(STRUCT_PARAM, { f: { params } })).toEqual(base);
    }
  });
});

// `f(s32 a0, T *a1) { g(a1, a0); }` — the call is a1's only consumer, so if a callee's parameter
// TYPES were read anywhere this fixture would show it.
const CALLS_G =
  'f:\n\tpush\t{r4, lr}\n\tmov\tr4, r0\n\tmov\tr0, r1\n\tmov\tr1, r4\n\tbl\tg\n' +
  '\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n';

describe('a CALLEE signature is read for its LENGTH only — the transferable half is the arity', () => {
  test('every pointee spelling for g produces the same candidates as no proto for g at all', () => {
    // This is the population the round would have served: `asIfUndecompiled` correctly redacts the
    // row's OWN signature, so a callee's is the only one a real user has. `protoArity` reads the
    // list's length; nothing reads its entries.
    const none = sources(CALLS_G, {});
    for (const spelling of POINTEE_SPELLINGS) {
      const params: number | ParamType[] = spelling === null ? 2 : [spelling, 's32'];
      expect(sources(CALLS_G, { g: { params } })).toEqual(none);
    }
  });

  test('the ARITY does move it — the control that says the fixture reads the proto at all', () => {
    // Without this, "identical under every spelling" would be satisfied by a proto nothing reads.
    expect(sources(CALLS_G, { g: { params: 1 } })[0]).toContain('g(a1);');
    expect(sources(CALLS_G, { g: { params: 2 } })[0]).toContain('g(a1, a0);');
  });
});

describe('the DWARF bridge flattens every pointer, and the flattening is inert', () => {
  test('prototypesFromSymbols spells a pointer parameter `void *`', () => {
    // proto.ts typeSpelling — GAP 1's site. A thread that made this `struct Sprite *` fails here,
    // and the tests above say what it would buy at the emitter: nothing yet.
    const ptr: SymbolTypeFacts = { size: 4, signed: null, pointer: true };
    const symbols: SymbolMap = new Map([
      [
        0x8000100,
        [{ name: 'g', kind: 'code' as const, signature: { returns: null, params: [ptr, { size: 4, signed: true }] } }],
      ],
    ]);
    expect(prototypesFromSymbols(symbols)).toEqual({ g: { params: ['void *', 's32'], returnsVoid: true } });
  });
});

// THE ONE SHAPE WHERE A POINTEE IS BYTE-LOAD-BEARING — and it is a struct ASSIGNMENT, not an
// argument. agbcc compiles `void copy_struct(struct S *dst, struct S *src) { *dst = *src; }`
// (S = 12 bytes) to the pair below, verbatim; asmlift lifts it to three word copies and scores 7
// against the real object under EITHER declared spelling. No parameter type moves it, because the
// capability missing is a whole-struct assignment and not a type on the boundary.
// It has ZERO inhabitants in the real tier (no row's target asm carries an ldmia/stmia pair), which
// is why it is pinned here as the named next step rather than built.
const BLOCK_COPY =
  'copy_struct:\n\tpush\t{r4, lr}\n\tldmia\tr1!, {r2, r3, r4}\n\tstmia\tr0!, {r2, r3, r4}\n' +
  '\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n';

describe('the block-copy shape is the named next step, and it is not a pointee gap', () => {
  test('a sized, named pointee would spell `*d = *s`; asmlift spells three word copies', () => {
    const spell = (params: ParamType[]): string =>
      enumerateCandidates('copy_struct', BLOCK_COPY, ARMV4T_AGBCC, { prototypes: { copy_struct: { params } } })
        .map((c) => c.source)
        .join('\n');
    const asVoid = spell(['void *', 'void *']);
    expect(asVoid).toContain('void copy_struct(s32 * a0, s32 * a1)');
    expect(asVoid).toContain('*a0 = *a1;');
    expect(asVoid).toContain('a0[2] = v1;');
    expect(spell(['struct S *', 'struct S *'])).toBe(asVoid);
  });
});
