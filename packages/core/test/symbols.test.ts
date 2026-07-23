// The address→symbol map seam (symbols.ts + the thumb numeric-pool promotion + the
// declaration-shape spellings) — research/symbol-map-plan-2026-07-22.md.
//
// Pins the plan's contracts: INERTNESS (no map ⇒ byte-identical output), the kind-aware
// two-probe promotion, the `(u32)Func` code spelling (dogfood defect G), the struct-interior
// `gSym.field` dot spelling from a layout, the bare `gSym[i]` array spelling, and the
// nothing-guesses rules (unmapped stays raw; width/field mismatches fall back loudly).
import { describe, expect, test } from 'vitest';

import { decompile } from '../src/pipeline';
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
