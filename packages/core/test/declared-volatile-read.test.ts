// A READ OF AN OBJECT THE SYMBOL MAP DECLARES VOLATILE RUNS WHERE, AND AS OFTEN AS, THE ASM RAN IT —
// ir/discipline.ts's `declared` placement. Its spelling names the object, so every render is a read
// the recompile makes: one `ldrh` spelled at two uses is two hardware reads.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { placedAt } from '../src/ir/discipline';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { decompile } from '../src/pipeline';
import { recoverTypes } from '../src/raise/recover';
import { enumerateCandidates } from '../src/rank';
import { type StructureOptions, structure } from '../src/structure/structure';
import type { SymbolInfo, SymbolMap } from '../src/symbols';
import { ARMV4T_AGBCC, TOOLCHAIN_TARGETS, targetFor } from '../src/target';
import { decompileTraced } from '../src/trace';

const emit = (ir: string, opts: StructureOptions = {}): string => {
  const fn = parse(ir);
  verify(fn);
  recoverTypes(fn);
  return cBackend.emit(structure(fn, opts));
};

const VOLATILE = new Map<string, SymbolInfo>([['gVolReg', { name: 'gVolReg', kind: 'data', volatile: true }]]);
const PLAIN = new Map<string, SymbolInfo>([['gVolReg', { name: 'gVolReg', kind: 'data' }]]);

// `u16 v = gVolReg; return v * v;` — one `ldrh`, both operands of the `mul`.
const SQUARE = `fn sq {
^bb0():
  %0: u16* = gaddr {sym="gVolReg"}
  %1: u16 = load %0 {off=0, signed=false, width=2}
  %2: s32 = mul %1, %1
  ret %2
}
`;

// `u16 v = gVolReg; if (a0 > 0) return v; return v + 1;` — one read above the branch, a use in each arm.
const BOTH_ARMS = `fn arms {
^bb0(%0: s32):
  %1: u16* = gaddr {sym="gVolReg"}
  %2: u16 = load %1 {off=0, signed=false, width=2}
  %3: s32 = const {value=0}
  %4: u32 = icmp_sgt %0, %3
  cond_br %4, ^bb1(), ^bb2()
^bb1():
  ret %2
^bb2():
  %5: s32 = const {value=1}
  %6: s32 = add %2, %5
  ret %6
}
`;

// `while (n > 0) { gOut = gVolReg; n--; }` with the read in the loop's TEST block: the machine reads
// the cell on every test, the exiting one included, and only the body uses the value.
const HEADER_READ = `fn poll {
^bb0(%0: s32):
  %1: u16* = gaddr {sym="gVolReg"}
  %2: u16* = gaddr {sym="gOut"}
  br ^bb1(%0)
^bb1(%3: s32):
  %4: u16 = load %1 {off=0, signed=false, width=2}
  %5: s32 = const {value=0}
  %6: u32 = icmp_sgt %3, %5
  cond_br %6, ^bb2(), ^bb3()
^bb2():
  store %2, %4 {off=0, width=2}
  %7: s32 = const {value=1}
  %8: s32 = sub %3, %7
  br ^bb1(%8)
^bb3():
  ret
}
`;

describe('a read used twice', () => {
  test('is named once, and the name is used twice', () => {
    const src = emit(SQUARE, { symbols: VOLATILE });
    expect(src).toMatch(/v0 = gVolReg;/);
    expect(src).toContain('return v0 * v0;');
  });

  test('is named under `/reread-globals` too, which re-reads a plain cell at each use', () => {
    const src = emit(SQUARE, { symbols: VOLATILE, rereadGlobals: true });
    expect(src).toMatch(/v0 = gVolReg;/);
    expect(src).toContain('return v0 * v0;');
  });

  test('of an ordinary cell renders at both operands', () => {
    expect(emit(SQUARE, { symbols: PLAIN })).toContain('return gVolReg * gVolReg;');
    expect(emit(SQUARE)).toContain('return gVolReg * gVolReg;');
  });

  test('in each arm of a branch is named above it', () => {
    const src = emit(BOTH_ARMS, { symbols: VOLATILE });
    expect(src).toMatch(/v\d = gVolReg;\s*\n\s*if/);
    expect(emit(BOTH_ARMS, { symbols: PLAIN })).toContain('return gVolReg;');
  });
});

test('a read in a loop header, used only in the body, is named in the header', () => {
  const src = emit(HEADER_READ, { symbols: VOLATILE, returnsVoid: true });
  const read = /(v\d+) = gVolReg;/.exec(src);
  expect(read, src).not.toBeNull();
  expect(src).toContain(`gOut = ${read![1]};`);
  expect(emit(HEADER_READ, { symbols: PLAIN, returnsVoid: true })).toContain('gOut = gVolReg;');
});

// `gVolReg;` and `return 3;`: agbcc keeps the `ldrh` only because the object is volatile, and the
// raise-time dead-code pass runs long before structuring.
describe('a read nothing uses', () => {
  const DEAD = '\tldr\tr0, .L1\n\tldrh\tr0, [r0]\n\tmov\tr0, #0x3\n\tbx\tlr\n.L1:\n\t.word\t0x3001000\n';
  const asm = `f:\n${DEAD}`;
  const mapOf = (volatile: boolean): SymbolMap =>
    new Map([[0x3001000, [{ name: 'gVolReg', kind: 'data', ...(volatile ? { volatile: true } : {}) }]]]);
  const prototypes = { f: { params: 0 } };

  test('of a declared object is spelled on every entry path', () => {
    const symbols = mapOf(true);
    expect(decompile('f', asm, ARMV4T_AGBCC, { symbols, prototypes }).source).toMatch(/\n\s*gVolReg;\n/);
    const agbcc = targetFor('agbcc', TOOLCHAIN_TARGETS.agbcc.canonicalFlags);
    expect(decompileTraced('f', asm, agbcc, { symbols, prototypes }).source).toMatch(/\n\s*gVolReg;\n/);
    const [mapped] = enumerateCandidates('f', asm, ARMV4T_AGBCC, { symbols, prototypes });
    expect(mapped.source).toMatch(/\n\s*gVolReg;\n/);
  });

  test('of a declared object reached by walking off another one is spelled', () => {
    // `gPlain` is ordinary and twelve bytes past it is `gVolReg`; raise/offsetnames.ts names the walk.
    const walk =
      'f:\n\tldr\tr0, .L1\n\tadd\tr0, #12\n\tldrh\tr0, [r0]\n\tmov\tr0, #0x3\n\tbx\tlr\n.L1:\n\t.word\t0x3001000\n';
    const symbols: SymbolMap = new Map([
      [0x3001000, [{ name: 'gPlain', kind: 'data', shape: 'scalar', size: 2, signed: false }]],
      [0x300100c, [{ name: 'gVolReg', kind: 'data', shape: 'scalar', size: 2, signed: false, volatile: true }]],
    ]);
    expect(decompile('f', walk, ARMV4T_AGBCC, { symbols, prototypes }).source).toMatch(/\n\s*gVolReg;\n/);
  });

  test('of a declared object through a join of two spellings of its address is spelled', () => {
    // agbcc -O2 of `volatile u16 *p; if (a) { p = &gVolReg; g(1); } else { p = &gVolReg; g(2); } *p;`
    const join =
      'f4:\n\tpush\t{r4, lr}\n\tcmp\tr0, #0\n\tbeq\t.L11\n\tldr\tr4, .L13\n\tmov\tr0, #1\n\tbl\tg\n\tb\t.L12\n' +
      '.L13:\n\t.word\t0x3001000\n.L11:\n\tldr\tr4, .L15\n\tmov\tr0, #2\n\tbl\tg\n' +
      '.L12:\n\tldrh\tr0, [r4]\n\tpop\t{r4}\n\tpop\t{r0}\n\tbx\tr0\n.L15:\n\t.word\t0x3001000\n';
    const joinPrototypes = { f4: { params: 1, returnsVoid: true }, g: { params: 1, returnsVoid: true } };
    expect(decompile('f4', join, ARMV4T_AGBCC, { symbols: mapOf(true), prototypes: joinPrototypes }).source).toMatch(
      /\n\s*gVolReg;\n/,
    );
  });

  test('of an ordinary object is deleted', () => {
    const src = decompile('f', asm, ARMV4T_AGBCC, { symbols: mapOf(false), prototypes }).source;
    expect(src).not.toContain('gVolReg;');
  });
});

// `extern volatile struct S gVolS; do {} while (((volatile u16 *)&gVolS)[3] != 0);` — a read of
// bytes no member of the declaration names, so the tree reaches it through a cast of `&gVolS`, and a
// cast to a plain pointee drops the declaration's `volatile`: agbcc -O2 then reads the halfword once,
// above the loop.
const POLL_PART = (sym: string, off: number) => `fn poll {
^bb0():
  %0: u8* = gaddr {sym="${sym}"}
  br ^bb1()
^bb1():
  %1: u16 = load %0 {off=${off}, signed=false, width=2}
  %2: u16 = const {value=0}
  %3: u32 = icmp_ne %1, %2
  cond_br %3, ^bb1(), ^bb2()
^bb2():
  ret
}
`;

describe('a read through a cast of the object', () => {
  const struct = new Map<string, SymbolInfo>([
    [
      'gVolS',
      {
        name: 'gVolS',
        kind: 'data',
        volatile: true,
        shape: 'struct',
        size: 8,
        layout: [
          { name: 'a', offset: 0, size: 2 },
          { name: 'b', offset: 4, size: 4 },
        ],
      },
    ],
  ]);
  const word = new Map<string, SymbolInfo>([
    ['gVolW', { name: 'gVolW', kind: 'data', volatile: true, shape: 'scalar', size: 4, signed: false }],
  ]);

  test('puts the qualifier the cast drops on the cast', () => {
    expect(emit(POLL_PART('gVolS', 6), { symbols: struct, returnsVoid: true })).toContain(
      '((volatile u16 *)&gVolS)[3] != 0',
    );
    expect(emit(POLL_PART('gVolW', 2), { symbols: word, returnsVoid: true })).toContain(
      '((volatile u16 *)&gVolW)[1] != 0',
    );
  });

  test('of an ordinary object stays plain', () => {
    const plain = new Map([['gVolS', { ...struct.get('gVolS')!, volatile: false }]]);
    expect(emit(POLL_PART('gVolS', 6), { symbols: plain, returnsVoid: true })).toContain('((u16 *)&gVolS)[3] != 0');
  });

  test('nothing uses is spelled, qualified', () => {
    const dead = `fn d {
^bb0():
  %0: u8* = gaddr {sym="gVolS"}
  %1: u16 = load %0 {off=6, signed=false, width=2}
  ret
}
`;
    expect(emit(dead, { symbols: struct, returnsVoid: true })).toContain('((volatile u16 *)&gVolS)[3];');
  });

  test('named by the declaration keeps the declaration’s spelling', () => {
    expect(emit(POLL_PART('gVolS', 0), { symbols: struct, returnsVoid: true })).toContain('gVolS.a != 0');
  });
});

describe('the stamp', () => {
  const stamped = (ir: string, symbols?: Map<string, SymbolInfo>): (string | null)[] => {
    const fn = parse(ir);
    verify(fn);
    recoverTypes(fn);
    structure(fn, symbols ? { symbols } : {});
    return fn.blocks.flatMap((b) => b.ops.filter((o) => o.opcode === 'load').map(placedAt));
  };

  test('places a read of a declared object, and follows the map it is structured with', () => {
    const fn = parse(SQUARE);
    verify(fn);
    recoverTypes(fn);
    const load = fn.blocks[0].ops.find((o) => o.opcode === 'load')!;
    structure(fn, { symbols: VOLATILE });
    expect(placedAt(load)).toBe('declared');
    structure(fn, {});
    expect(placedAt(load)).toBeNull();
  });

  test('leaves a read the compiler could not have made of a `volatile` unplaced', () => {
    const signed = SQUARE.replace(
      '%1: u16 = load %0 {off=0, signed=false, width=2}',
      '%1: s16 = load %0 {off=0, signed=true, width=2}',
    );
    const fn = parse(signed);
    verify(fn);
    recoverTypes(fn);
    const load = fn.blocks[0].ops.find((o) => o.opcode === 'load')!;
    structure(fn, { symbols: VOLATILE, volatileReadsExtendInRegister: true });
    expect(placedAt(load)).toBeNull();
    structure(fn, { symbols: VOLATILE });
    expect(placedAt(load)).toBe('declared');
  });

  test('keys a member the map qualifies by the bytes it spans', () => {
    const MEMBER = `fn m {
^bb0():
  %0: u8* = gaddr {sym="gMain"}
  %1: u16 = load %0 {off=4, signed=false, width=2}
  %2: u16 = load %0 {off=0, signed=false, width=2}
  %3: s32 = add %1, %2
  ret %3
}
`;
    const map = new Map<string, SymbolInfo>([
      [
        'gMain',
        {
          name: 'gMain',
          kind: 'data',
          shape: 'struct',
          size: 8,
          layout: [
            { name: 'plain', offset: 0, size: 2 },
            { name: 'reg', offset: 4, size: 2, volatile: true },
          ],
        },
      ],
    ]);
    expect(stamped(MEMBER, map)).toEqual(['declared', null]);
    // and a read of that member nothing uses is spelled, qualified
    const dead = MEMBER.replace('%3: s32 = add %1, %2\n  ret %3', 'ret %2');
    expect(emit(dead, { symbols: map })).toContain('\n    ((volatile u16 *)&gMain)[2];\n');
  });
});

// agbcc -O2 over `extern volatile struct S gVolS;` (`s16 a; s16 pad; s32 b;`): `return ((s16
// *)&gVolS)[3];` is `ldrsh` of `gVolS+6`, and `return *(volatile s16 *)((u32)&gVolS + 6);` is `ldrh;
// lsl #16; asr #16` — agbcc sign-extends a qualified narrow read in a register, never in the load.
describe('a sign-extending read of a declared object', () => {
  const symbols: SymbolMap = new Map([
    [
      0x3001000,
      [
        {
          name: 'gVolS',
          kind: 'data',
          volatile: true,
          shape: 'struct',
          size: 8,
          layout: [
            { name: 'a', offset: 0, size: 2, signed: true },
            { name: 'pad', offset: 2, size: 2, signed: true },
            { name: 'b', offset: 4, size: 4, signed: true },
          ],
        },
      ],
    ],
  ]);
  const prototypes = { f: { params: 0 } };
  const read = (load: string): string =>
    `f:\n\tldr\tr0, .L3\n\tmov\tr1, #0\n\t${load}\tr0, [r0, r1]\n\tbx\tlr\n.L3:\n\t.word\t0x3001006\n`;

  test('was a plain read in the source, and stays plain', () => {
    const src = decompile('f', read('ldrsh'), ARMV4T_AGBCC, { symbols, prototypes }).source;
    expect(src).not.toContain('volatile');
    expect(src).toMatch(/\(s16 \*\)/);
  });

  test('…where a zero-extending one stays qualified', () => {
    const src = decompile('f', read('ldrh'), ARMV4T_AGBCC, { symbols, prototypes }).source;
    expect(src).toMatch(/\(volatile u16 \*\)/);
  });
});

// agbcc -O2 over `struct S { u16 arr[4]; vu16 reg; }; extern struct S gS;`: `return gS.arr[i];` is
// `ldr r1; lsl; add; ldrh`, and the same read through `(volatile u16 *)&gS` schedules the `ldr` after
// the `lsl`. A runtime index names no byte, so only a declaration that qualifies every byte the read
// could reach places it.
describe('a read the stamp cannot place by byte', () => {
  const layout = [
    { name: 'arr', offset: 0, size: 8, elemSize: 2, length: 4, signed: false },
    { name: 'reg', offset: 8, size: 2, signed: false, volatile: true },
  ];
  const mapOf = (extra: Partial<SymbolInfo>): SymbolMap =>
    new Map([[0x3001000, [{ name: 'gS', kind: 'data', shape: 'struct', size: 10, layout, ...extra }]]]);
  const RD =
    'rd:\n\tldr\tr1, .L3\n\tlsl\tr0, r0, #1\n\tadd\tr0, r0, r1\n\tldrh\tr0, [r0]\n\tbx\tlr\n.L3:\n\t.word\t0x3001000\n';
  const prototypes = { rd: { params: 1 } };

  test('of an object only some of whose members are volatile stays plain', () => {
    const src = decompile('rd', RD, ARMV4T_AGBCC, { symbols: mapOf({}), prototypes }).source;
    expect(src).not.toContain('volatile');
  });

  test('of an object the map declares volatile is placed', () => {
    const src = decompile('rd', RD, ARMV4T_AGBCC, { symbols: mapOf({ volatile: true }), prototypes }).source;
    expect(src).toContain('volatile');
  });

  test('of an object every member of which is volatile is placed', () => {
    const all = layout.map((f) => ({ ...f, volatile: true }));
    const src = decompile('rd', RD, ARMV4T_AGBCC, { symbols: mapOf({ layout: all }), prototypes }).source;
    expect(src).toContain('volatile');
  });
});

// agbcc -O2 over `extern volatile u32 gVolW;`: two halfword stores to its upper half, and one in a
// `for (i = n - 1; i != -1; i--)` loop. Spelled through a plain cast, agbcc deletes the first store and sinks the loop's out
// of the loop.
describe('a store to a declared object', () => {
  const mapOf = (volatile: boolean): SymbolMap =>
    new Map([
      [
        0x3001000,
        [{ name: 'gVolW', kind: 'data', shape: 'scalar', size: 4, signed: false, ...(volatile ? { volatile } : {}) }],
      ],
    ]);
  const ST2 =
    'st2v:\n\tldr\tr0, .L3\n\tmov\tr1, #1\n\tstrh\tr1, [r0]\n\tmov\tr1, #2\n\tstrh\tr1, [r0]\n\tbx\tlr\n' +
    '.L3:\n\t.word\t0x3001002\n';
  const LOOP =
    'stloopv:\n\tpush\t{lr}\n\tsub\tr0, r0, #1\n\tmov\tr1, #1\n\tneg\tr1, r1\n\tcmp\tr0, r1\n\tbeq\t.L4\n' +
    '\tldr\tr2, .L8\n.L6:\n\tstrh\tr0, [r2]\n\tsub\tr0, r0, #1\n\tcmp\tr0, r1\n\tbne\t.L6\n' +
    '.L4:\n\tpop\t{r0}\n\tbx\tr0\n.L8:\n\t.word\t0x3001002\n';
  const prototypes = { st2v: { params: 0, returnsVoid: true }, stloopv: { params: 1, returnsVoid: true } };
  const qualifiedStores = (src: string): number => src.match(/\(volatile u16 \*\)&gVolW\)\[1\] = /g)?.length ?? 0;

  test('through a cast puts the qualifier the cast drops on each store', () => {
    const src = decompile('st2v', ST2, ARMV4T_AGBCC, { symbols: mapOf(true), prototypes }).source;
    expect(qualifiedStores(src), src).toBe(2);
    const loop = decompile('stloopv', LOOP, ARMV4T_AGBCC, { symbols: mapOf(true), prototypes }).source;
    expect(qualifiedStores(loop), loop).toBe(1);
  });

  test('of an ordinary object stays plain', () => {
    const src = decompile('st2v', ST2, ARMV4T_AGBCC, { symbols: mapOf(false), prototypes }).source;
    expect(src).not.toContain('volatile');
  });
});
