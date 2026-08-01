// The address→symbol map seam (symbols.ts + the thumb numeric-pool promotion + the
// declaration-shape spellings) — research/symbol-map-plan-2026-07-22.md.
//
// Pins the plan's contracts: INERTNESS (no map ⇒ byte-identical output), the kind-aware
// two-probe promotion, the `(u32)Func` code spelling (dogfood defect G), the struct-interior
// `gSym.field` dot spelling from a layout, the bare `gSym[i]` array spelling, and the
// nothing-guesses rules (unmapped stays raw; width/field mismatches fall back loudly).
import { describe, expect, test } from 'vitest';

import { renderDeclarations } from '../src/declare';
import type { SymbolRef } from '../src/l3/symbol-refs';
import { decompile } from '../src/pipeline';
import { enumerateCandidates, rankBy } from '../src/rank';
import { type SymbolMap, lookupInterior, lookupSymbol } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

const asmOf = (sym: string, body: string) => `${sym}:\n${body}`;
const run = (sym: string, body: string, symbols?: SymbolMap) =>
  decompile(sym, asmOf(sym, body), ARMV4T_AGBCC, symbols ? { symbols } : {}).source;

const mapOf = (entries: [number, Parameters<typeof Object.assign>[1]][]): SymbolMap =>
  new Map(entries.map(([addr, info]) => [addr, [info]]));

// ldr rN, =0x03001234; load/store through it — the numeric-pool shape the promotion targets
const LOADW = '\tldr\tr0, .L1\n\tldr\tr0, [r0]\n\tbx\tlr\n.L1:\n\t.word\t0x03001234\n';

describe('inertness (the optionality contract)', () => {
  test('no map ⇒ byte-identical raw-literal output', () => {
    const base = run('f', LOADW);
    expect(base).toContain('50336308'); // 0x03001234 rendered as a raw literal
    expect(run('f', LOADW, new Map())).toBe(base); // empty map ⇒ same bytes
  });
});

describe('the numeric-pool promotion (P1 names)', () => {
  test('an exact data hit renders the bare named global', () => {
    const src = run('f', LOADW, mapOf([[0x03001234, { name: 'gCounter', kind: 'data' }]]));
    expect(src).toContain('return gCounter;');
    expect(src).not.toContain('50336308');
  });

  test('an unmapped address stays a raw literal — nothing guesses', () => {
    const src = run('f', LOADW, mapOf([[0x03009999, { name: 'gElsewhere', kind: 'data' }]]));
    expect(src).toContain('50336308');
    expect(src).not.toContain('gElsewhere');
  });

  test('a Thumb code pointer (odd pool word) resolves through the masked probe as (u32)Func', () => {
    // ldr r0, =Func|1 ... returned as a value: the map stores the bit-0-cleared address
    const body = '\tldr\tr0, .L1\n\tbx\tlr\n.L1:\n\t.word\t0x08012345\n';
    const src = run('f', body, mapOf([[0x08012344, { name: 'DoThing', kind: 'code' }]]));
    expect(src).toContain('(u32)DoThing');
    expect(src).not.toContain('&DoThing');
  });

  test('an exact odd DATA hit wins over a masked code hit', () => {
    const body = '\tldr\tr0, .L1\n\tbx\tlr\n.L1:\n\t.word\t0x03000001\n';
    const map: SymbolMap = new Map([
      [0x03000001, [{ name: 'gOddData', kind: 'data' }]],
      [0x03000000, [{ name: 'CodeAtEven', kind: 'code' }]],
    ]);
    expect(lookupSymbol(map, 0x03000001)?.name).toBe('gOddData');
    const src = run('f', body, map);
    expect(src).toContain('gOddData');
  });
});

describe('declaration shapes (P2)', () => {
  test('a struct global with a layout spells a constant-offset interior as gSym.field (dot)', () => {
    // pool word = base+4 interior; load word there
    const body = '\tldr\tr0, .L1\n\tldr\tr0, [r0]\n\tbx\tlr\n.L1:\n\t.word\t0x03002004\n';
    const map = mapOf([
      [
        0x03002000,
        {
          name: 'gState',
          kind: 'data',
          shape: 'struct',
          size: 24,
          layout: [
            { name: 'frames', offset: 0, size: 4 },
            { name: 'timer', offset: 4, size: 4 },
          ],
        },
      ],
    ]);
    const src = run('f', body, map);
    expect(src).toContain('return gState.timer;');
  });

  test('a load offset off a struct base composes into the field lookup', () => {
    // pool word = base; ldr r0,[r0,#4]
    const body = '\tldr\tr0, .L1\n\tldr\tr0, [r0, #0x4]\n\tbx\tlr\n.L1:\n\t.word\t0x03002000\n';
    const map = mapOf([
      [
        0x03002000,
        {
          name: 'gState',
          kind: 'data',
          shape: 'struct',
          size: 24,
          layout: [{ name: 'timer', offset: 4, size: 4 }],
        },
      ],
    ]);
    expect(run('f', body, map)).toContain('return gState.timer;');
  });

  test('a width-mismatched field falls back to the cast spelling, never a wrong field name', () => {
    // byte load at offset 4, but the layout field there is 4 bytes wide
    const body = '\tldr\tr0, .L1\n\tldrb\tr0, [r0, #0x4]\n\tbx\tlr\n.L1:\n\t.word\t0x03002000\n';
    const map = mapOf([
      [
        0x03002000,
        { name: 'gState', kind: 'data', shape: 'struct', size: 24, layout: [{ name: 'timer', offset: 4, size: 4 }] },
      ],
    ]);
    const src = run('f', body, map);
    expect(src).not.toContain('.timer');
    expect(src).toContain('gState'); // still named (interior/index spelling), just not a field
  });

  test('an array global spells the BARE gSym[i], uncast', () => {
    // u16 table indexed by a0*2: ldr r1,=tbl; lsls r0,#1; adds r0,r1,r0; ldrh r0,[r0]
    const body =
      '\tldr\tr1, .L1\n\tlsls\tr0, r0, #0x1\n\tadds\tr0, r1, r0\n\tldrh\tr0, [r0]\n\tbx\tlr\n.L1:\n\t.word\t0x08057B4C\n';
    const map = mapOf([
      [0x08057b4c, { name: 'gBlendModeTable', kind: 'data', shape: 'array', elemSize: 2, elemSigned: false }],
    ]);
    const src = run('f', body, map);
    expect(src).toContain('gBlendModeTable[');
    expect(src).not.toContain('&gBlendModeTable'); // the cast-aggregate form is exactly what this replaces
  });

  test('interior attribution requires a size — an unsized symbol never attributes', () => {
    expect(lookupInterior(mapOf([[0x03002000, { name: 'gU', kind: 'data' }]]), 0x03002004)).toBeNull();
    expect(lookupInterior(mapOf([[0x03002000, { name: 'gS', kind: 'data', size: 8 }]]), 0x03002004)?.offset).toBe(4);
    // strictly inside only: the end is exclusive, the base is not interior
    expect(lookupInterior(mapOf([[0x03002000, { name: 'gS', kind: 'data', size: 8 }]]), 0x03002008)).toBeNull();
    expect(lookupInterior(mapOf([[0x03002000, { name: 'gS', kind: 'data', size: 8 }]]), 0x03002000)).toBeNull();
  });
});

describe('value-context escapes intify — a named address never declines what raw C compiled', () => {
  // The S1 decline family (kleod StreamCmd_SetBGScroll): promotion puts `&gSym` into arithmetic
  // the fold rules cannot consume — a struct-array stride (`&gSym + i*28`, access width 2) or an
  // interior address escaping as a VALUE. Emitting bare `&gSym + K` would element-scale by the
  // project's sizeof (byte-inexact ⇒ assertDerefsTyped declined the function); the additive
  // lowering now spells integer math on the address, `(u32)&gSym + K` — byte-exact, legal C.
  test('an ESCAPING struct-array stride base spells (u32)&gSym math, not a decline', () => {
    // r1 = &gBgInfo + a0*28; strh r2,[r1,#8]; return r1 — the escaping element pointer fails the
    // struct-array raise's clean gate (exactly the kleod shape, where it escaped as a call arg),
    // the 28-byte stride never divides the 2-byte access width so globalOf declines the
    // whole-global spelling, and the `&gBgInfo + i*28` tree reaches both a deref base and a
    // value context. Both must render as integer math on the address.
    const body =
      '\tldr\tr1, .L1\n\tlsls\tr2, r0, #0x3\n\tsubs\tr2, r2, r0\n\tlsls\tr2, r2, #0x2\n' +
      '\tadds\tr1, r1, r2\n\tmovs\tr2, #0x1\n\tstrh\tr2, [r1, #0x8]\n\tadds\tr0, r1, #0x0\n' +
      '\tbx\tlr\n.L1:\n\t.word\t0x03003430\n';
    const map = mapOf([[0x03003430, { name: 'gBgInfo', kind: 'data', shape: 'array', elemSize: 28, size: 112 }]]);
    const src = run('f', body, map); // strict mode: an interior-pointer contract hit would THROW
    expect(src).toContain('(u32)&gBgInfo');
    expect(src).not.toMatch(/[^)]&gBgInfo/); // no bare, element-scaling &gBgInfo anywhere
  });

  test('an interior-attributed address escaping as a VALUE spells (u32)&gSym + K', () => {
    // pool word strictly inside gState (base+4), returned — a value context with no deref to fold
    const body = '\tldr\tr0, .L1\n\tbx\tlr\n.L1:\n\t.word\t0x03002004\n';
    const map = mapOf([[0x03002000, { name: 'gState', kind: 'data', shape: 'struct', size: 24 }]]);
    const src = run('f', body, map);
    expect(src).toContain('(u32)&gState + 4');
  });

  test('a NARROWED address ((u8)&gSym) never folds back to the named global', () => {
    // lsls#24/lsrs#24 truncates the promoted address to its low byte BEFORE the deref: the asm
    // reads address 0x30, not gBgInfo. addrIn must fold ONLY the value-preserving 32-bit cast —
    // folding the narrowing cast would spell `*(u8 *)&gBgInfo` (or worse, a named field) and
    // silently read the wrong address (the adversarial reviewer's wrong-address probe family).
    const body =
      '\tldr\tr0, .L1\n\tlsls\tr0, r0, #0x18\n\tlsrs\tr0, r0, #0x18\n\tldrb\tr0, [r0]\n' +
      '\tbx\tlr\n.L1:\n\t.word\t0x03003430\n';
    const map = mapOf([[0x03003430, { name: 'gBgInfo', kind: 'data', shape: 'array', elemSize: 28, size: 112 }]]);
    const src = run('f', body, map);
    expect(src).toContain('(u8)&gBgInfo'); // the truncation survives…
    expect(src).not.toContain('*(u8 *)&gBgInfo'); // …and never becomes an untruncated named read
    expect(src).not.toContain('gBgInfo['); // nor a named element at the wrong address
  });
});

describe('comparison operands intify SIGNEDNESS-AWARE — a compare never sees a bare &gSym', () => {
  // The cmp-path hole the adversarial reviewer of the additive intify flagged: a bare `&gSym`
  // reaching a COMPARISON is unspelled the same way (its C type is the project's declaration),
  // and worse — the compare's SIGNEDNESS lives in the operand types (icmp_ult and icmp_slt both
  // spell '<'), so the project's declaration would pick the emitted compare, silently
  // byte-inexact when it disagrees with the asm. The cast must AGREE with the opcode:
  // unsigned compares (and sign-agnostic ==/!=) spell (u32)&gSym, signed compares (s32)&gSym.
  // The assertDerefsTyped comparison rule makes any regression here a loud decline.
  const CMP_POOL = (cond: string) =>
    `\tldr\tr1, .L9\n\tcmp\tr1, r0\n\t${cond}\t.L2\n\tmovs\tr0, #0x0\n\tbx\tlr\n` +
    `.L2:\n\tmovs\tr0, #0x1\n\tbx\tlr\n.L9:\n\t.word\t0x03001234\n`;
  const CMP_IMM = (cond: string) =>
    `\tldr\tr1, .L9\n\tcmp\tr1, #0x50\n\t${cond}\t.L2\n\tmovs\tr0, #0x0\n\tbx\tlr\n` +
    `.L2:\n\tmovs\tr0, #0x1\n\tbx\tlr\n.L9:\n\t.word\t0x03001234\n`;
  const NAMED = mapOf([[0x03001234, { name: 'gCounter', kind: 'data' }]]);

  test('an UNSIGNED compare of a promoted address spells (u32)&gSym — vs a value and vs a constant', () => {
    for (const body of [CMP_POOL('bhi'), CMP_IMM('bhi')]) {
      const src = run('f', body, NAMED); // strict mode: a bare-addr contract hit would THROW
      expect(src).toContain('(u32)&gCounter');
      expect(src).not.toMatch(/[^)]&gCounter/); // no bare, declaration-typed &gCounter anywhere
    }
  });

  test('a SIGNED compare of a promoted address spells (s32)&gSym — vs a value and vs a constant', () => {
    for (const body of [CMP_POOL('blt'), CMP_IMM('blt')]) {
      const src = run('f', body, NAMED);
      expect(src).toContain('(s32)&gCounter'); // (u32) here would flip the compare to unsigned
      expect(src).not.toMatch(/[^)]&gCounter/);
    }
  });

  test('the symbol-carrying pool path (.word gSym, no map) has the same spelling', () => {
    // The pre-existing non-map path: the pool word IS the symbol, lowered as `gaddr` — the same
    // `addr` node reaches the compare, so the same hole and the same signedness-aware fix.
    const body =
      `\tldr\tr1, .L9\n\tcmp\tr1, r0\n\tbhi\t.L2\n\tmovs\tr0, #0x0\n\tbx\tlr\n` +
      `.L2:\n\tmovs\tr0, #0x1\n\tbx\tlr\n.L9:\n\t.word\tgCounter\n`;
    const src = run('f', body); // NO map — the symbol arrives from the pool itself
    expect(src).toContain('(u32)&gCounter');
    expect(src).not.toMatch(/[^)]&gCounter/);
  });
});

describe('register-offset addressing lowers exactly (never a silent index drop)', () => {
  // parseAddr used to silently read `[rB]`, dropping the index register — a silent miscompile
  // (ldrsh exists ONLY in this form in Thumb-1). Now it lowers as `rB + rX` then the access.
  test('ldrh rD, [rB, rX] reads base + index', () => {
    const body = '\tldr\tr1, .L1\n\tldrh\tr0, [r1, r0]\n\tbx\tlr\n.L1:\n\t.word\t0x08057B4C\n';
    const src = decompile('f', asmOf('f', body), ARMV4T_AGBCC, {}).source;
    // the index register participates (never dropped); the const is ELEMENT-scaled because the
    // recovered operand is u16* — 134576972 bytes = 67288486 u16 elements: byte-exact C
    expect(src).toContain('return *(67288486 + a0);');
  });

  test('ldrh rD, [rB, rX] off an array-mapped global spells gSym[…]', () => {
    const body = '\tldr\tr1, .L1\n\tlsls\tr0, r0, #0x1\n\tldrh\tr0, [r1, r0]\n\tbx\tlr\n.L1:\n\t.word\t0x08057B4C\n';
    const map = mapOf([
      [0x08057b4c, { name: 'gBlendModeTable', kind: 'data', shape: 'array', elemSize: 2, elemSigned: false }],
    ]);
    expect(run('f', body, map)).toContain('gBlendModeTable[a0]');
  });

  test('strh rS, [rB, rX] stores through base + index', () => {
    const body = '\tldr\tr1, .L1\n\tstrh\tr0, [r1, r2]\n\tbx\tlr\n.L1:\n\t.word\t0x03001234\n';
    const src = decompile('f', asmOf('f', body), ARMV4T_AGBCC, {}).source;
    expect(src).toContain('a1'); // the index register (r2 = a2? — at minimum both regs participate)
  });
});

describe('a POINTER-shaped global under arithmetic is spelled CAST-THEN-ADD', () => {
  // A pointer global's declaration is the PROJECT's, and the map deliberately does not model the
  // pointee (declare.ts spells every pointer global `void *` — "load/store/compare of the 4-byte
  // cell are identical for any object-pointer type"). True of the CELL; false of arithmetic on
  // the loaded VALUE: C scales `gPtr + K` by sizeof(*gPtr), which is 1 under the synthesized
  // `void *` and 0x5C under (say) the project's real struct pointer. Add-then-cast
  // `(u8 *)(gPtr + a0)` is therefore byte-correct in exactly ONE world — a silent wrongness that
  // scores as a match here and reads the wrong address in the user's tree. The honest spelling
  // makes the stride explicit: `(u8 *)gPtr + a0` — the same address in EVERY world.
  // (snowboardkids2:func_80037FE0_38BE0 flipped nonmatch → match on exactly this.)
  const PTR_MAP = mapOf([[0x03001234, { name: 'gPtr', kind: 'data', shape: 'pointer' }]]);
  // r1 = gPtr (the cell's value); r1 += a0; read at +16
  const derefAt = (ld: string) =>
    `\tldr\tr1, .L1\n\tldr\tr1, [r1]\n\tadds\tr1, r1, r0\n\t${ld}\n\tbx\tlr\n.L1:\n\t.word\t0x03001234\n`;

  test('byte access: the pointer is cast BEFORE the add, and the offset stays in the index', () => {
    const src = run('f', derefAt('ldrb\tr0, [r1, #0x10]'), PTR_MAP);
    expect(src).toContain('((u8 *)gPtr + a0)[16]');
    expect(src).not.toContain('(u8 *)(gPtr'); // add-then-cast: right only under `void *`
    expect(src).not.toContain('((u8 *)gPtr)[a0'); // folding into the index re-scales by the width
  });

  test('a WIDER access keeps the byte add and casts the whole base to the access type', () => {
    // the add is bytes either way; only the deref changes stride, so the byte-pointer add stays
    // inside and the access-width cast wraps it — address gPtr + a0 + 16 in every world
    const src = run('f', derefAt('ldr\tr0, [r1, #0x10]'), PTR_MAP);
    expect(src).toContain('((s32 *)((u8 *)gPtr + a0))[4]'); // 16 bytes / 4-byte stride
    expect(src).not.toMatch(/\*\)\(gPtr \+/); // never the add-then-cast shape at any width
  });

  test('under an operator C rejects for pointers, the cell spells integer math', () => {
    // `gPtr & 0xFF` is not C at all; the asm did 32-bit integer math on the address value
    const body =
      '\tldr\tr1, .L1\n\tldr\tr1, [r1]\n\tmovs\tr0, #0xFF\n\tands\tr0, r1\n\tbx\tlr\n.L1:\n\t.word\t0x03001234\n';
    const src = run('f', body, PTR_MAP);
    expect(src).toContain('(u32)gPtr');
  });

  test('INERT without the shape fact: a plain data symbol keeps the raw add', () => {
    const plain = mapOf([[0x03001234, { name: 'gPtr', kind: 'data' }]]);
    const src = run('f', derefAt('ldrb\tr0, [r1, #0x10]'), plain);
    expect(src).not.toContain('(u8 *)gPtr +'); // nothing to legalize — gPtr is not a pointer cell
  });
});

describe('a POINTER global with a known POINTEE spells the interior as gPtr->member', () => {
  // One indirection past the block above: the map now carries what the pointer points AT (its
  // struct name, size and layout — @gba-kit/debug-info's `variableShape().pointee`), so an access
  // at a known offset is a NAMED member of that struct rather than byte arithmetic on the cell.
  // The address is identical either way — `->member` adds the member's own DWARF offset, and an
  // index into an array member scales by the element size the rule REQUIRES to equal the access
  // width — so this changes readability, never bytes.
  // (snowboardkids2:func_80037FE0_38BE0 is the shape: `EepromSaveData->save_slot_status[arg0]`.)
  const pointee = (layout: unknown[]) => ({
    name: 'gPtr',
    kind: 'data',
    shape: 'pointer',
    pointee: { structName: 'Save', size: 92, layout },
  });
  const SLOTS = [
    { name: 'checksum', offset: 8, size: 4, signed: false },
    { name: 'slots', offset: 16, size: 16, elemSize: 1, elemSigned: false, length: 16 },
    { name: 'flag', offset: 78, size: 1, signed: false },
  ];
  // r1 = gPtr (the cell's value); optional index add; read at a constant offset
  const derefAt = (ld: string, pre = '') =>
    `\tldr\tr1, .L1\n\tldr\tr1, [r1]\n${pre}\t${ld}\n\tbx\tlr\n.L1:\n\t.word\t0x03001234\n`;
  const INDEXED = '\tadds\tr1, r1, r0\n';

  test('a constant offset matching a member exactly spells the ARROW field', () => {
    const src = run('f', derefAt('ldrb\tr0, [r1, #0x4E]'), mapOf([[0x03001234, pointee(SLOTS)]]));
    expect(src).toContain('return gPtr->flag;');
    expect(src).not.toContain('(u8 *)gPtr'); // the byte-cast spelling is exactly what this replaces
  });

  // A VARIABLE index never takes a member's name, at any offset and any width. `gPtr->arr[i]` and
  // `((u8 *)gPtr + i)[K]` were MEASURED against agbcc and are not the same bytes: at every nonzero
  // K the arrow form materialises `base + K` instead of folding it into the load (+2 code bytes at
  // width 1, +4 at widths 2 and 4), and even at K = 0 the two differ for widths 2 and 4 by which
  // register the commutative `adds` targets. The one case that did measure identical — width 1 at
  // K = 0 — holds only for a bare index in a function with a single such access, so no rule
  // deciding one expression at a time can rely on it.
  const AT_ZERO = [
    { name: 'slots', offset: 0, size: 16, elemSize: 1, elemSigned: false, length: 16 },
    { name: 'flag', offset: 78, size: 1, signed: false },
  ];

  test('an indexed ARRAY member is NEVER named — at offset 0 or anywhere else', () => {
    const atZero = run('f', derefAt('ldrb\tr0, [r1]', INDEXED), mapOf([[0x03001234, pointee(AT_ZERO)]]));
    expect(atZero).not.toContain('->slots');
    expect(atZero).toContain('(u8 *)gPtr'); // the arithmetic spelling the bytes were matched against

    const atSixteen = run('f', derefAt('ldrb\tr0, [r1, #0x10]', INDEXED), mapOf([[0x03001234, pointee(SLOTS)]]));
    expect(atSixteen).not.toContain('->slots');
    expect(atSixteen).toContain('((u8 *)gPtr + a0)[16]');
  });

  test('a WIDER indexed member is not named either — the width-2/4 case differs even at offset 0', () => {
    const layout = [{ name: 'words', offset: 0, size: 32, elemSize: 2, elemSigned: false, length: 16 }];
    const body = derefAt('ldrh\tr0, [r1]', '\tlsls\tr0, r0, #0x1\n' + INDEXED);
    expect(run('f', body, mapOf([[0x03001234, pointee(layout)]]))).not.toContain('->words');
  });

  test('a WIDTH mismatch falls back to the cast spelling, never a wrong member', () => {
    // a HALFWORD read at offset 8, where the layout declares a 4-byte member
    const src = run('f', derefAt('ldrh\tr0, [r1, #0x8]'), mapOf([[0x03001234, pointee(SLOTS)]]));
    expect(src).not.toContain('->checksum');
    expect(src).toContain('gPtr'); // still the named cell, just not a member of it
  });

  test('a WORD member is spelled only when declared SIGNED — the type the cast form rendered', () => {
    // A 4-byte access renders `(s32 *)` whatever the load said (one word load in the ISA), so
    // naming a u32-declared member in its place would change the operand TYPE, and with it what
    // every downstream operator compiles to. The s32 member keeps the type and is named.
    const u32 = [{ name: 'checksum', offset: 8, size: 4, signed: false }];
    const s32 = [{ name: 'count', offset: 8, size: 4, signed: true }];
    expect(run('f', derefAt('ldr\tr0, [r1, #0x8]'), mapOf([[0x03001234, pointee(u32)]]))).not.toContain('->checksum');
    expect(run('f', derefAt('ldr\tr0, [r1, #0x8]'), mapOf([[0x03001234, pointee(s32)]]))).toContain(
      'return gPtr->count;',
    );
  });

  test('a SIGNEDNESS mismatch falls back — an s8 read is not the u8 member', () => {
    // ldrsb sign-extends; spelling the u8-declared member would compile to ldrb (wrong bytes)
    const src = run('f', derefAt('ldrsb\tr0, [r1, r2]', '\tmovs\tr2, #0x4E\n'), mapOf([[0x03001234, pointee(SLOTS)]]));
    expect(src).not.toContain('->flag');
  });

  test('an offset naming NO member falls back — nothing is guessed', () => {
    const src = run('f', derefAt('ldrb\tr0, [r1, #0x4D]'), mapOf([[0x03001234, pointee(SLOTS)]]));
    expect(src).not.toContain('->');
    expect(src).toContain('((u8 *)gPtr)[77]');
  });

  test('a ONE-ELEMENT array member is never spelled as a scalar field', () => {
    // `u8 x[1]` matches a byte access by (offset, size) alone — but `gPtr->x` is not an lvalue of
    // that width, so the array facts must exclude it from the exact-match rule
    const layout = [{ name: 'x', offset: 16, size: 1, elemSize: 1, elemSigned: false, length: 1 }];
    const src = run('f', derefAt('ldrb\tr0, [r1, #0x10]'), mapOf([[0x03001234, pointee(layout)]]));
    expect(src).not.toContain('->x;');
  });

  test('NO layout ⇒ the pre-pointee spelling, byte-identical', () => {
    // a pointee the DWARF named but has no layout for, and a bare pointer shape, must both emit
    // exactly what the map emitted before pointees existed
    const bare = mapOf([[0x03001234, { name: 'gPtr', kind: 'data', shape: 'pointer' }]]);
    const named = mapOf([
      [0x03001234, { name: 'gPtr', kind: 'data', shape: 'pointer', pointee: { structName: 'Save', size: 92 } }],
    ]);
    const body = derefAt('ldrb\tr0, [r1, #0x10]', INDEXED);
    expect(run('f', body, named)).toBe(run('f', body, bare));
    expect(run('f', body, bare)).toContain('((u8 *)gPtr + a0)[16]');
  });

  test('INERTNESS: no map ⇒ unchanged output', () => {
    const body = derefAt('ldrb\tr0, [r1, #0x10]', INDEXED);
    expect(run('f', body, new Map())).toBe(run('f', body));
  });

  // ── the spelling rules and the declaration synthesis are ONE decision ────────────────────────
  // A member core NAMES must be a member declare.ts DECLARES: naming one it does not is C that
  // does not compile. Both consult the same predicate (symbols.ts declaredFields /
  // pointeeStructType), so each case below asserts the PAIR — what core spells AND what the
  // self-declared world declares for the same map.
  const declOf = (info: Record<string, unknown>) =>
    renderDeclarations([{ name: 'gPtr', info: { name: 'gPtr', ...info } } as SymbolRef]);
  const BYTE_AT_78 = derefAt('ldrb\tr0, [r1, #0x4E]');

  test('an UNSIZABLE pointee member declines the arrow AND leaves the extern void* — as a pair', () => {
    // declare.ts cannot seat the members after an unsizable one, so it declines the whole struct
    // and falls back to `void *`. Core must therefore name nothing through it, including the
    // members BEFORE the unsizable one, which on their own look perfectly spellable.
    const info = {
      kind: 'data',
      shape: 'pointer',
      pointee: {
        structName: 'Save',
        size: 92,
        layout: [
          { name: 'flag', offset: 78, size: 1, signed: false },
          { name: 'rest', offset: 80, size: null },
        ],
      },
    };
    expect(run('f', BYTE_AT_78, mapOf([[0x03001234, { name: 'gPtr', ...info }]]))).not.toContain('->flag');
    expect(declOf(info)).toBe('extern void *gPtr;\n');
  });

  test('a union ALIAS is never named — the declaration carries only the first view at that offset', () => {
    // `struct { u32 word; u16 half; }` both at offset 78: the padded synthesis declares `word` and
    // drops `half`, so a halfword read at 78 may NOT be spelled `->half` — that name does not
    // exist in the declaration the candidate compiles against.
    const info = {
      kind: 'data',
      shape: 'pointer',
      pointee: {
        structName: 'Save',
        size: 92,
        layout: [
          { name: 'word', offset: 78, size: 4, signed: true },
          { name: 'half', offset: 78, size: 2, signed: false },
        ],
      },
    };
    const src = run('f', derefAt('ldrh\tr0, [r1, #0x4E]'), mapOf([[0x03001234, { name: 'gPtr', ...info }]]));
    expect(src).not.toContain('->half');
    expect(declOf(info)).toContain('struct Save { u8 asmlift_pad_0[78]; s32 word;');
    expect(declOf(info)).not.toContain('half');
  });

  test('an UNNAMED or UNSIZED pointee declines the arrow AND the typed extern — as a pair', () => {
    // No tag ⇒ synthesis has nothing to declare the struct under; no size ⇒ the struct type is
    // incomplete. Either way the extern stays `void *`, so no member may be named.
    const layout = [{ name: 'flag', offset: 78, size: 1, signed: false }];
    for (const pointee of [
      { size: 92, layout },
      { structName: 'Save', layout },
    ]) {
      const info = { kind: 'data', shape: 'pointer', pointee };
      expect(run('f', BYTE_AT_78, mapOf([[0x03001234, { name: 'gPtr', ...info }]]))).not.toContain('->flag');
      expect(declOf(info)).toBe('extern void *gPtr;\n');
    }
  });

  test('a VOLATILE member is never named — the cast form it replaces carries no qualifier', () => {
    // `gPtr->vreg` is a volatile access; `((u8 *)gPtr)[78]` is a plain one. Same address, DIFFERENT
    // instruction sequence, so the member is not nameable and the arithmetic spelling stands.
    const info = {
      kind: 'data',
      shape: 'pointer',
      pointee: {
        structName: 'Io',
        size: 92,
        layout: [{ name: 'vreg', offset: 78, size: 1, signed: false, volatile: true }],
      },
    };
    const src = run('f', BYTE_AT_78, mapOf([[0x03001234, { name: 'gPtr', ...info }]]));
    expect(src).not.toContain('->vreg');
    expect(src).toContain('((u8 *)gPtr)[78]');
    expect(declOf(info)).toContain('volatile u8 vreg;'); // still DECLARED faithfully
  });

  test('a VOLATILE POINTEE declines every arrow spelling, and synthesis reproduces the qualifier', () => {
    const info = {
      kind: 'data',
      shape: 'pointer',
      pointee: {
        structName: 'Io',
        size: 92,
        volatile: true,
        layout: [{ name: 'flag', offset: 78, size: 1, signed: false }],
      },
    };
    expect(run('f', BYTE_AT_78, mapOf([[0x03001234, { name: 'gPtr', ...info }]]))).not.toContain('->flag');
    expect(declOf(info)).toContain('extern volatile struct Io *gPtr;');
  });

  test('a CONST pointee reads through the member name but never STORES through it', () => {
    // A store through a const-qualified pointee is a hard error where the cast form only cast the
    // qualifier away — so the load names the member and the store does not.
    const info = {
      kind: 'data',
      shape: 'pointer',
      pointee: {
        structName: 'Rom',
        size: 92,
        const: true,
        layout: [{ name: 'flag', offset: 78, size: 1, signed: false }],
      },
    };
    const map = mapOf([[0x03001234, { name: 'gPtr', ...info }]]);
    expect(run('f', BYTE_AT_78, map)).toContain('->flag');
    const store = `\tldr\tr1, .L1\n\tldr\tr1, [r1]\n\tmovs\tr0, #0x1\n\tstrb\tr0, [r1, #0x4E]\n\tbx\tlr\n.L1:\n\t.word\t0x03001234\n`;
    expect(run('f', store, map)).not.toContain('->flag');
    expect(declOf(info)).toContain('extern const struct Rom *gPtr;');
  });

  test('a CONST MEMBER is never a store target either', () => {
    const info = {
      kind: 'data',
      shape: 'pointer',
      pointee: {
        structName: 'Save',
        size: 92,
        layout: [{ name: 'flag', offset: 78, size: 1, signed: false, const: true }],
      },
    };
    const store = `\tldr\tr1, .L1\n\tldr\tr1, [r1]\n\tmovs\tr0, #0x1\n\tstrb\tr0, [r1, #0x4E]\n\tbx\tlr\n.L1:\n\t.word\t0x03001234\n`;
    expect(run('f', store, mapOf([[0x03001234, { name: 'gPtr', ...info }]]))).not.toContain('->flag');
  });

  test('an UNSCALED byte residual keeps the honest byte-arithmetic spelling', () => {
    // The member strides 2 bytes but the asm added an unscaled residual, so consecutive `i`
    // address OVERLAPPING halfwords — an address relationship no member spelling could express
    // even if the indexed form were allowed. What the map may never do is round it to something
    // expressible: the arithmetic that describes the real address stands.
    const layout = [{ name: 'words', offset: 0, size: 32, elemSize: 2, elemSigned: false, length: 16 }];
    const body = derefAt('ldrh\tr0, [r1]', INDEXED);
    const src = run('f', body, mapOf([[0x03001234, pointee(layout)]]));
    expect(src).not.toContain('->words');
    expect(src).toContain('(u16 *)((u8 *)gPtr + a0)');
  });

  test('TWO variable terms decline — only a single residual can be one member index', () => {
    const layout = [{ name: 'slots', offset: 0, size: 16, elemSize: 1, elemSigned: false, length: 16 }];
    const body = derefAt('ldrb\tr0, [r1]', '\tadds\tr1, r1, r0\n\tadds\tr1, r1, r2\n');
    expect(run('f', body, mapOf([[0x03001234, pointee(layout)]]))).not.toContain('->slots');
  });

  test('a MALFORMED layout is declined, never a crash (SymbolMap is public API)', () => {
    // the webapp accepts a caller-supplied map, so a layout that is not a list of members — or a
    // list holding a non-member — must degrade to the unshaped spelling rather than throw.
    // The MULTI-entry cases matter on their own: sorting a layout by offset only invokes the
    // comparator when there are two of them, so a one-element probe cannot reach a `.offset` read
    // on a malformed entry — which is exactly where the crash would be.
    for (const layout of [
      42,
      'nope',
      null,
      [null],
      [{ name: 'x' }],
      [{ name: 1, offset: 0, size: 1 }],
      [null, null],
      [{ name: 'a', offset: 0, size: 1 }, null],
      [null, { name: 'a', offset: 0, size: 1 }],
      [{}, {}],
    ]) {
      const info = { kind: 'data', shape: 'pointer', pointee: { structName: 'Save', size: 92, layout } };
      expect(() => run('f', BYTE_AT_78, mapOf([[0x03001234, { name: 'gPtr', ...info }]]))).not.toThrow();
      expect(() => declOf(info)).not.toThrow();
      expect(declOf(info)).toBe('extern void *gPtr;\n');
    }
    // …and the same for a STRUCT global's own layout
    const bad = { name: 'gS', kind: 'data', shape: 'struct', structName: 'S', size: 4, layout: 42 };
    expect(() => run('f', LOADW, mapOf([[0x03001234, bad]]))).not.toThrow();
  });
});

describe('ranking prefers the named spelling when bytes are equal', () => {
  // The map spelling and its `/raw-globals` sibling often compile identically. Which one the
  // user is shown must not depend on enumeration order surviving a stable sort, so rankBy
  // breaks a score tie on enumeration order and enumerateCandidates puts the named one first.
  test('an exact tie is won by the candidate that names the global', () => {
    const body = '\tldr\tr0, .L1\n\tldr\tr0, [r0]\n\tbx\tlr\n.L1:\n\t.word\t0x03001234\n';
    const symbols = mapOf([[0x03001234, { name: 'gCounter', kind: 'data' }]]);
    const cands = enumerateCandidates('f', asmOf('f', body), ARMV4T_AGBCC, { symbols });
    expect(cands.map((c) => c.label)).toEqual(['unsigned', 'unsigned/raw-globals']);
    const best = rankBy(cands, 'f', () => ({ score: 7 })).best; // every candidate scores the same
    expect(best.label).toBe('unsigned');
    expect(best.source).toContain('return gCounter;');
  });

  test('a strictly better raw spelling still wins — the tie-break never overrides bytes', () => {
    const body = '\tldr\tr0, .L1\n\tldr\tr0, [r0]\n\tbx\tlr\n.L1:\n\t.word\t0x03001234\n';
    const symbols = mapOf([[0x03001234, { name: 'gCounter', kind: 'data' }]]);
    const cands = enumerateCandidates('f', asmOf('f', body), ARMV4T_AGBCC, { symbols });
    const best = rankBy(cands, 'f', (_s, _sym, c) => ({ score: c.label.includes('raw') ? 1 : 2 })).best;
    expect(best.label).toBe('unsigned/raw-globals');
  });
});
