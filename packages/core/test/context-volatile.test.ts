// A GLOBAL THE DECLARATION CONTEXT DECLARES VOLATILE, which the symbol map does not lay out: every
// access to it is stamped `declared` (raise/declared-volatile.ts, from proto-context.ts
// `globalsFromContext`), so the cast an aggregate is read through carries the qualifier. Without
// it, `*(u16 *)&gV` lets the compiler load `gV.a` once and spin on the register, and merge two
// reads into one. The compiled proof, on the toolchains the synthetic tier does not cover, is
// packages/cli/test/matching/context-volatile-global.test.ts.
import { describe, expect, test } from 'vitest';

import { DECLARED_VOLATILE } from '../src/ir/discipline';
import { decompile, liftStamped } from '../src/pipeline';
import { type ContextGlobals, globalsFromContext } from '../src/proto-context';
import { enumerateCandidates } from '../src/rank';
import type { SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC } from '../src/target';

const HDR = 'typedef unsigned short u16; typedef int s32;\nstruct V { u16 a; u16 b; }; extern volatile struct V gV;\n';
const CTX = globalsFromContext(HDR, 'c');
/** the same context with its volatility withheld: what the aggregate spelling alone prints */
const AGGREGATES_ONLY: ContextGlobals = { aggregates: CTX.aggregates, volatiles: new Set() };

/** agbcc -O2 of `void vpoll(void){ while (gV.a == 0); }` */
const VPOLL =
  'vpoll:\n\tldr\tr1, .L7\n.L3:\n\tldrh\tr0, [r1]\n\tcmp\tr0, #0\n\tbeq\t.L3\n\tbx\tlr\n.L7:\n\t.word\tgV\n';
/** …of `gV.b`: the member at byte 2 */
const VPOLLB =
  'vpollb:\n\tldr\tr1, .L7\n.L3:\n\tldrh\tr0, [r1, #0x2]\n\tcmp\tr0, #0\n\tbeq\t.L3\n\tbx\tlr\n.L7:\n\t.word\tgV\n';
/** …of `s32 vtwb(void){ return gW.b + gW.b; }` over `extern volatile struct W { s32 a; s32 b; } gW;` */
const VTWB =
  'vtwb:\n\tldr\tr1, .L3\n\tldr\tr0, [r1, #0x4]\n\tldr\tr1, [r1, #0x4]\n\tadd\tr0, r0, r1\n\tbx\tlr\n.L3:\n\t.word\tgW\n';
const W = globalsFromContext('typedef int s32; struct W { s32 a; s32 b; }; extern volatile struct W gW;', 'c');

const count = (s: string, sub: string): number => s.split(sub).length - 1;
const VOID = { vpoll: { params: [], returnsVoid: true }, vpollb: { params: [], returnsVoid: true } };

describe('a context-declared volatile aggregate the map does not describe', () => {
  test('the poll reads through a qualified cast, at offset 0 and past it', () => {
    expect(decompile('vpoll', VPOLL, ARMV4T_AGBCC, { prototypes: VOID, contextGlobals: CTX }).source).toContain(
      'while (*(volatile u16 *)&gV == 0)',
    );
    expect(decompile('vpollb', VPOLLB, ARMV4T_AGBCC, { prototypes: VOID, contextGlobals: CTX }).source).toContain(
      'while (((volatile u16 *)&gV)[1] == 0)',
    );
  });

  test('withheld, the volatility leaves a plain cast — the spelling the compiler may hoist', () => {
    expect(
      decompile('vpoll', VPOLL, ARMV4T_AGBCC, { prototypes: VOID, contextGlobals: AGGREGATES_ONLY }).source,
    ).toContain('*(u16 *)&gV == 0');
  });

  test('two reads of one member stay two qualified reads', () => {
    const src = decompile('vtwb', VTWB, ARMV4T_AGBCC, { contextGlobals: W }).source;
    expect(count(src, '((volatile s32 *)&gW)[1]'), src).toBe(2);
  });

  test('the lift stamps every read of the object, and only with the context', () => {
    const stamped = (cg: ContextGlobals | undefined): number =>
      liftStamped('vtwb', VTWB, ARMV4T_AGBCC, {}, undefined, undefined, cg)
        .blocks.flatMap((b) => b.ops)
        .filter((op) => op.attrs[DECLARED_VOLATILE] === true).length;
    expect(stamped(W)).toBe(2);
    expect(stamped(undefined)).toBe(0);
  });

  test('a map that lays the object out answers per member, over the context', () => {
    const map: SymbolMap = new Map([
      [
        0x3000000,
        [
          {
            name: 'gV',
            kind: 'data',
            shape: 'struct',
            size: 4,
            layout: [
              { name: 'a', offset: 0, size: 2 },
              { name: 'b', offset: 2, size: 2 },
            ],
          },
        ],
      ],
    ]);
    const src = decompile('vpollb', VPOLLB, ARMV4T_AGBCC, { symbols: map, contextGlobals: CTX }).source;
    expect(src).not.toContain('volatile');
  });

  test('an array subscripted through its own name keeps it: the declaration already qualifies the element', () => {
    // agbcc -O2 of `void vidxp(int i){ while (gVA[i] == 0); }` over `extern volatile u16 gVA[8];`.
    // The printer spells the subscript through the name, and the qualifier the stamp would put on a
    // cast there is a spelling agbcc compiles differently (the ranked best went MATCH -> 2).
    const VIDXP =
      'vidxp:\n\tldr\tr1, .L7\n\tlsl\tr0, r0, #0x1\n\tadd\tr1, r0, r1\n.L3:\n\tldrh\tr0, [r1]\n\tcmp\tr0, #0\n' +
      '\tbeq\t.L3\n\tbx\tlr\n.L7:\n\t.word\tgVA\n';
    const ctx = globalsFromContext('typedef unsigned short u16; extern volatile u16 gVA[8];', 'c');
    const opts = { prototypes: { vidxp: { params: ['s32' as const], returnsVoid: true } }, contextGlobals: ctx };
    const lifted = liftStamped('vidxp', VIDXP, ARMV4T_AGBCC, opts.prototypes, undefined, undefined, ctx);
    expect(lifted.blocks.flatMap((b) => b.ops).some((op) => op.attrs[DECLARED_VOLATILE] === true)).toBe(true);
    const src = decompile('vidxp', VIDXP, ARMV4T_AGBCC, opts).source;
    expect(src).toContain('while (gVA[a0] == 0)');
    expect(src).not.toContain('(volatile u16 *)');
  });

  test('every ranked candidate keeps the qualifier, with the map and in the raw-globals setting', () => {
    // a map that knows another name, so the raw-globals setting is enumerated
    const map: SymbolMap = new Map([[0x3000000, [{ name: 'gOther', kind: 'data', shape: 'scalar', size: 1 }]]]);
    const cands = enumerateCandidates('vpollb', VPOLLB, ARMV4T_AGBCC, { symbols: map, contextGlobals: CTX });
    expect(cands.length).toBeGreaterThan(0);
    for (const c of cands) {
      expect(c.source, c.variations.join('/')).toContain('(volatile u16 *)&gV');
    }
  });
});

describe('a context-declared volatile scalar: the object is the pointer, not what it points at', () => {
  const ctxOf = (decl: string) => globalsFromContext(`typedef unsigned short u16; typedef int s32; ${decl}`, 'c');
  const wrap = (name: string, body: string, sym: string): string =>
    `${name}:\n${body}\tbx\tlr\n.L3:\n\t.word\t${sym}\n`;

  test('a read through the pointer value names no qualified object, so no cast drops its qualifier', () => {
    // agbcc -O2 of `u16 vptrv(void){ return *gPV + *gPV; }` over `extern u16 * volatile gPV;`. The
    // pointer is volatile, its pointee is not: `*(u16 *)gPV` reads the pointee, and the bare `gPV`
    // under it is the qualified read, spelled through the declaration. This was refused as a read of
    // `gPV` through a cast that drops its qualifier.
    const VPTRV = wrap(
      'vptrv',
      '\tldr\tr0, .L3\n\tldr\tr1, [r0]\n\tldr\tr0, [r0]\n\tldrh\tr0, [r0]\n\tldrh\tr1, [r1]\n\tadd\tr0, r0, r1\n' +
        '\tlsl\tr0, r0, #0x10\n\tlsr\tr0, r0, #0x10\n',
      'gPV',
    );
    expect(
      decompile('vptrv', VPTRV, ARMV4T_AGBCC, { contextGlobals: ctxOf('extern u16 * volatile gPV;') }).source,
    ).toContain('return (u16)(*(u16 *)gPV + *(u16 *)gPV);');
    // …`gTask->b` over `extern struct T * volatile gTask;`, a member of the pointee
    const VTASK = wrap('vtask', '\tldr\tr0, .L3\n\tldr\tr0, [r0]\n\tldrh\tr0, [r0, #0x2]\n', 'gTask');
    const task = ctxOf('struct T { u16 a; u16 b; }; extern struct T * volatile gTask;');
    expect(decompile('vtask', VTASK, ARMV4T_AGBCC, { contextGlobals: task }).source).toContain('((u16 *)gTask)[1]');
    // …and a store through it: `*(u16 *)gOV = x; gOV = (u8 *)gOV + 2;` over `extern void * volatile gOV;`
    const VPWR = wrap(
      'vpwr',
      '\tldr\tr2, .L3\n\tldr\tr1, [r2]\n\tstrh\tr0, [r1]\n\tldr\tr0, [r2]\n\tadd\tr0, r0, #0x2\n\tstr\tr0, [r2]\n',
      'gOV',
    );
    const pwr = decompile('vpwr', VPWR, ARMV4T_AGBCC, {
      prototypes: { vpwr: { params: ['s32'], returnsVoid: true } },
      contextGlobals: ctxOf('extern void * volatile gOV;'),
    }).source;
    expect(pwr).toContain('*(u16 *)gOV = a0;');
  });

  test('two reads of one cell meeting in a commutative op are spelled in one expression, a difference stays sequenced', () => {
    // agbcc -O2 of `s32 vsc32(void){ return gR + gR; }` over `extern volatile s32 gR;`: the value is
    // the same whichever read runs first, so the order is the compiler's (ido 7.1 loads it the other
    // way round from a named first read). `gH - gH` is not symmetric: the first read is the minuend.
    const VSC32 = wrap('vsc32', '\tldr\tr1, .L3\n\tldr\tr0, [r1]\n\tldr\tr1, [r1]\n\tadd\tr0, r0, r1\n', 'gR');
    expect(
      decompile('vsc32', VSC32, ARMV4T_AGBCC, { contextGlobals: ctxOf('extern volatile s32 gR;') }).source,
    ).toContain('return gR + gR;');
    const VSC16 = wrap('vsc16', '\tldr\tr1, .L3\n\tldrh\tr0, [r1]\n\tldrh\tr1, [r1]\n\tsub\tr0, r0, r1\n', 'gH');
    const diff = decompile('vsc16', VSC16, ARMV4T_AGBCC, { contextGlobals: ctxOf('extern volatile u16 gH;') }).source;
    expect(diff).toContain('v0 = gH;');
    expect(diff).toContain('return v0 - gH;');
  });
});

describe('an access of a context-declared volatile object through a pointer that is not its name', () => {
  test('a loop pointer seeded with the array and stepped through it reads through a qualified cast', () => {
    // agbcc -O2 of `u32 varrsum(void){ u32 s = 0; int i; for (i = 0; i < 8; i++) s += gVA[i]; return s; }`
    // over `extern volatile u16 gVA[8];`: the compiler strength-reduces `gVA[i]` to a pointer it
    // steps by 2. That pointer is a local in the lift, which the declaration does not qualify, so a
    // plain `*v1` let the read be hoisted or merged.
    const VARRSUM =
      'varrsum:\n\tmov\tr3, #0x0\n\tldr\tr2, .L8\n\tmov\tr1, #0x7\n.L6:\n\tldrh\tr0, [r2]\n\tadd\tr3, r0, r3\n' +
      '\tadd\tr2, r2, #0x2\n\tsub\tr1, r1, #0x1\n\tcmp\tr1, #0\n\tbge\t.L6\n\tadd\tr0, r3, #0\n\tbx\tlr\n.L8:\n' +
      '\t.word\tgVA\n';
    const ctx = globalsFromContext('typedef unsigned short u16; extern volatile u16 gVA[8];', 'c');
    const src = decompile('varrsum', VARRSUM, ARMV4T_AGBCC, { contextGlobals: ctx }).source;
    expect(src).toMatch(/= \*\(volatile u16 \*\)v\d+;/);
    expect(src).not.toMatch(/= \*v\d+;/);
    // without the context nothing says the array is volatile, and the read stays plain
    expect(decompile('varrsum', VARRSUM, ARMV4T_AGBCC, {}).source).not.toContain('volatile');
  });
});
