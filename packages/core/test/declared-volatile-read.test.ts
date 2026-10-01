// A READ OF AN OBJECT THE SYMBOL MAP DECLARES VOLATILE RUNS WHERE, AND AS OFTEN AS, THE ASM RAN IT —
// ir/discipline.ts's `declared` placement. Its spelling names the object, so every render is a read
// the recompile makes: one `ldrh` spelled at two uses is two hardware reads.
import { describe, expect, test } from 'vitest';

import { cBackend } from '../src/backend/c';
import { placedAt } from '../src/ir/discipline';
import { parse } from '../src/ir/parse';
import { verify } from '../src/ir/verify';
import { recoverTypes } from '../src/raise/recover';
import { type StructureOptions, structure } from '../src/structure/structure';
import type { SymbolInfo } from '../src/symbols';

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
  });
});
