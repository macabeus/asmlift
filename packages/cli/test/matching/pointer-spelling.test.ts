// The arithmetic table's operand-order rows (core structure/pointer-spelling.ts `ARITH_ROWS`) against
// the REAL compilers, in both worlds. The address the asm computed is the same under every spelling
// below; what differs between them is the order of the add's operands, and that is each compiler's
// own choice:
//   - agbcc, KMC gcc and IDO put the pointer first in a pointer sum, so `a0 + (u8 *)gPtr` swaps
//     the asm's `a0 + gPtr`, and the integer sum in the asm's order is the one that matches;
//   - CodeWarrior at -O4 puts the index first in every pointer sum, so `(u8 *)gPtr + a0` swaps the
//     asm's `gPtr + a0` there, and on the gcc family it does not.
// The project's header declares the global a `u16 *`, where a bare `a0 + gPtr` would scale the
// index; the candidate's own declared world declares it whatever `renderDeclarations` says. Each
// case finds the candidate that compiles byte-exact in the project's world, checks it is the table's
// spelling and byte-exact in its own declared world too, and compiles the pointer spelling the row
// replaces, which must not be.
//
// IDO and agbcc are native; KMC gcc and CodeWarrior are Docker-gated.
import { renderDeclarations } from '@asmlift/core/declare';
import { prototypesFromContext } from '@asmlift/core/proto-context';
import { enumerateCandidates } from '@asmlift/core/rank';
import type { SymbolMap } from '@asmlift/core/symbols';
import { C_TYPEDEFS, TOOLCHAIN_TARGETS, targetFor } from '@asmlift/core/target';
import {
  assembleTarget,
  compileMipsGccTarget,
  compileMipsTarget,
  compilePpcTarget,
  compileTargetAsm,
  extractAsmData,
  scoreC,
  scoreCMips,
  scoreCMipsGcc,
  scoreCPpc,
} from '@asmlift/toolchains';
import { describe, expect, it } from 'vitest';

import { dockerGate, ppcDockerGate } from './docker-gate';

const DECLS = 'extern u16 *gPtr; void use(u32);\n';

type Cc = 'agbcc' | 'ido' | 'kmc' | 'mwcc';
const ID = { agbcc: 'agbcc', ido: 'ido7.1', kmc: 'gcc2.7.2kmc', mwcc: 'mwcc_242_81' } as const;
const HAVE: Record<Cc, boolean> = {
  agbcc: true,
  ido: true,
  kmc: dockerGate('pointer-spelling kmc'),
  mwcc: ppcDockerGate('pointer-spelling mwcc', 'mwcc_242_81'),
};

const flags = (cc: Cc) => TOOLCHAIN_TARGETS[ID[cc]].canonicalFlags;
const compileTarget = (cc: Cc, c: string, fn: string): { asm: string; obj: string } => {
  switch (cc) {
    case 'agbcc': {
      const asm = compileTargetAsm(c, flags(cc));
      return { asm, obj: assembleTarget(asm) };
    }
    case 'ido':
      return compileMipsTarget(c, fn, flags(cc));
    case 'kmc':
      return compileMipsGccTarget(c, fn, flags(cc));
    case 'mwcc':
      return compilePpcTarget('mwcc_242_81', c, fn, flags(cc));
  }
};
const matches = (cc: Cc, src: string, fn: string, obj: string): boolean => {
  const score =
    cc === 'agbcc'
      ? scoreC(src, fn, obj, flags(cc))
      : cc === 'ido'
        ? scoreCMips(src, fn, obj, flags(cc))
        : cc === 'kmc'
          ? scoreCMipsGcc(src, fn, obj, flags(cc))
          : scoreCPpc('mwcc_242_81', src, fn, obj, flags(cc));
  return score.match;
};

interface Case {
  cc: Cc;
  /** the project's function: the asm's operand order */
  body: string;
  /** the table's spelling of the sum, in the default candidate */
  spelled: string;
  /** the pointer spelling of the same address in the other operand order */
  swapped: string;
}

const PTR_RIGHT = 'u8 sum(s32 x) { use(*gPtr); return *(u8 *)(x + (u32)gPtr); }';
const PTR_LEFT = 'u8 sum(s32 x) { use(*gPtr); return *(u8 *)((u32)gPtr + x); }';
const CASES: Case[] = [
  { cc: 'agbcc', body: PTR_RIGHT, spelled: '(u8 *)(a0 + (u32)gPtr)', swapped: '(a0 + (u8 *)gPtr)' },
  { cc: 'kmc', body: PTR_RIGHT, spelled: '(u8 *)(a0 + (u32)gPtr)', swapped: '(a0 + (u8 *)gPtr)' },
  { cc: 'ido', body: PTR_RIGHT, spelled: '(u8 *)(a0 + (u32)gPtr)', swapped: '(a0 + (u8 *)gPtr)' },
  { cc: 'mwcc', body: PTR_LEFT, spelled: '(u8 *)((u32)gPtr + a0)', swapped: '((u8 *)gPtr + a0)' },
];

describe('the integer sum of an undeclared pointer global, real compilers', () => {
  for (const { cc, body, spelled, swapped } of CASES) {
    it.runIf(HAVE[cc])(`keeps the asm's operand order on ${cc} where the pointer sum would swap it`, () => {
      const project = DECLS + body;
      const { asm, obj } = compileTarget(cc, project, 'sum');
      const { target } = targetFor(ID[cc], flags(cc));
      const candidate = enumerateCandidates('sum', asm, target, {
        prototypes: prototypesFromContext(C_TYPEDEFS + project, 'c'),
        asmData: extractAsmData(obj, target, 'sum'),
      }).find((c) => matches(cc, DECLS + c.source, 'sum', obj));
      expect(candidate?.source).toContain(spelled);
      if (candidate === undefined) {
        return;
      }
      const self = renderDeclarations(candidate.symbolRefs ?? []) + 'void use(u32);\n';
      expect(matches(cc, self + candidate.source, 'sum', obj)).toBe(true);
      expect(matches(cc, DECLS + candidate.source.replace(spelled, swapped), 'sum', obj)).toBe(false);
    });
  }
});

// The pointer sum of an undeclared pointer global plus an offset with a constant addend, on the
// compilers that reassociate an integer sum (core target.ts `keepsPointerSumAddend`): the
// integer sum `(u32)gPtr + (x + K)` compiles to `(gPtr + K) + x`, and only the pointer sum keeps the
// asm's `gPtr + (x + K)`. The project's header declares the global a `u16 *`, so the pointer sum is
// walked as bytes.
const SUM_DECLS = 'extern u16 *gPtr; void use(u32); void usep(void *);\n';
const PTR_SUM_K = 'void sum(s32 x) { use(*gPtr); usep((u8 *)gPtr + ((x << 4) + 772)); }';
const SUM_K_CASES = [
  {
    cc: 'agbcc',
    spelled: '(u8 *)gPtr + ((a0 << 4) + (193 << 2))',
    integer: '(u8 *)((u32)gPtr + ((a0 << 4) + (193 << 2)))',
  },
  { cc: 'kmc', spelled: '(u8 *)gPtr + ((a0 << 4) + 772)', integer: '(u8 *)((u32)gPtr + ((a0 << 4) + 772))' },
] as const;

describe('the pointer sum of an undeclared pointer global and an offset with a constant addend, real compilers', () => {
  for (const { cc, spelled, integer } of SUM_K_CASES) {
    it.runIf(HAVE[cc])(`keeps the asm's addend on ${cc}, where the integer sum would move it to the base`, () => {
      const project = SUM_DECLS + PTR_SUM_K;
      const { asm, obj } = compileTarget(cc, project, 'sum');
      const { target } = targetFor(ID[cc], flags(cc));
      const candidate = enumerateCandidates('sum', asm, target, {
        prototypes: prototypesFromContext(C_TYPEDEFS + project, 'c'),
        asmData: extractAsmData(obj, target, 'sum'),
      }).find((c) => matches(cc, SUM_DECLS + c.source, 'sum', obj));
      expect(candidate?.source).toContain(spelled);
      if (candidate === undefined) {
        return;
      }
      const self = renderDeclarations(candidate.symbolRefs ?? []) + 'void use(u32); void usep(void *);\n';
      expect(matches(cc, self + candidate.source, 'sum', obj)).toBe(true);
      expect(matches(cc, SUM_DECLS + candidate.source.replace(spelled, integer), 'sum', obj)).toBe(false);
    });
  }
});

// The same sum spelled only inside the access it addresses, agbcc: there both sums move the constant
// into the access, the pointer sum as `(x + gD) + K` and the integer sum as `(gD + x) + K`, so neither
// is the asm's `gD + (x + K)`, and the integer sum keeps its base-first order.
const ACCESS_DECLS = 'struct D { u8 buf[16]; u8 st; }; extern struct D *gD; extern u8 gOut;\n';
const ACCESS_SUM = 'void sum(void) { u8 i = 2 * (gD->st - 1); gOut = gD->buf[i + 1]; }';

describe('the sum of an undeclared pointer global read only as an access address, agbcc', () => {
  it('keeps the integer sum, whose operand order is closer to the asm than the pointer sum', () => {
    const project = ACCESS_DECLS + ACCESS_SUM;
    const { asm, obj } = compileTarget('agbcc', project, 'sum');
    const { target } = targetFor(ID.agbcc, flags('agbcc'));
    const [candidate] = enumerateCandidates('sum', asm, target, {
      prototypes: prototypesFromContext(C_TYPEDEFS + project, 'c'),
      asmData: extractAsmData(obj, target, 'sum'),
    });
    const integer = '(u8 *)((u32)gD + ';
    expect(candidate.source).toContain(integer);
    const score = (src: string) => scoreC(ACCESS_DECLS + src, 'sum', obj, flags('agbcc')).score;
    expect(score(candidate.source)).toBeLessThan(score(candidate.source.replace(integer, '((u8 *)gD + ')));
  });
});

// The evaluation-order re-spelling of a commutative load pair (core structure/pointer-spelling.ts
// `pointerSide`) against IDO 7.1, which evaluated the right side of each pair below first. The table
// spells the global as its word in an integer sum, and the sum's operand order must stay the IR's:
// re-spelled in evaluation order, IDO compiles different code.
const PAIR_DECLS =
  'extern u8 *gPtr; extern u32 gIdx; extern u8 *gP; extern u32 gJ; void use(u32); void usep(void *);\n';
const PAIRS = [
  {
    what: 'a pointer-loaded global',
    body: 'void pair(void) { use(*gP); usep(gJ + gP); }',
    spelled: '(u8 *)((u32)(u8 *)gJ + (u32)gP)',
    evaluated: '(u8 *)((u32)gP + (u32)(u8 *)gJ)',
  },
  {
    what: 'two word-loaded globals in a sum the IR types a pointer',
    body: 'void pair(void) { use(*(gIdx + gPtr)); }',
    spelled: '(u32)(u8 *)gIdx + (u32)(u8 *)gPtr',
    evaluated: '(u32)(u8 *)gPtr + (u32)(u8 *)gIdx',
  },
];

describe('the operand order of a load pair beside an undeclared global, IDO 7.1', () => {
  for (const { what, body, spelled, evaluated } of PAIRS) {
    it(`keeps the IR's order of ${what}`, () => {
      const project = PAIR_DECLS + body;
      const { asm, obj } = compileTarget('ido', project, 'pair');
      const { target } = targetFor(ID.ido, flags('ido'));
      const candidate = enumerateCandidates('pair', asm, target, {
        prototypes: prototypesFromContext(C_TYPEDEFS + project, 'c'),
        asmData: extractAsmData(obj, target, 'pair'),
      }).find((c) => matches('ido', PAIR_DECLS + c.source, 'pair', obj));
      expect(candidate?.source).toContain(spelled);
      if (candidate === undefined) {
        return;
      }
      const self = renderDeclarations(candidate.symbolRefs ?? []) + 'void use(u32); void usep(void *);\n';
      expect(matches('ido', self + candidate.source, 'pair', obj)).toBe(true);
      expect(matches('ido', PAIR_DECLS + candidate.source.replace(spelled, evaluated), 'pair', obj)).toBe(false);
    });
  }
});

// A temp that only holds a pointer global's value, summed with `x + K`, is declared `u8 *` (core
// structure.ts, pointer-spelling.ts `declaresBytePointer`) on the compilers whose
// `compilerBehaviors.keepsPointerSumAddend` holds. agbcc and KMC gcc fold an integer sum's constant
// addend onto its base, through a temp as well (`t + (x + K)` compiles as `(t + K) + x`), and keep a
// pointer sum's `t + (x + K)`; IDO 7.1 and CodeWarrior compile the two alike in this shape.
const TEMP_DECLS = 'struct S { u8 pad[4000]; }; extern struct S *gP; extern s32 gOut;\n';
const INT_TEMP = 'void f(u8 x) { s32 t = (s32)gP; gOut = t + ((x << 2) + 2672); }';
const PTR_TEMP = 'void f(u8 x) { u8 *t = (u8 *)gP; gOut = (s32)(t + ((x << 2) + 2672)); }';
const TEMP_SPLITS: Record<Cc, boolean> = { agbcc: true, kmc: true, ido: false, mwcc: false };

describe('a pointer global summed through an integer or a byte-pointer temp, real compilers', () => {
  for (const cc of Object.keys(TEMP_SPLITS) as Cc[]) {
    it.runIf(HAVE[cc])(`${TEMP_SPLITS[cc] ? 'compiles them differently' : 'compiles them alike'} on ${cc}`, () => {
      const { obj } = compileTarget(cc, TEMP_DECLS + PTR_TEMP, 'f');
      expect(matches(cc, TEMP_DECLS + INT_TEMP, 'f', obj)).toBe(!TEMP_SPLITS[cc]);
    });
  }
});

// Read through, IDO 7.1 splits the two the other way: the byte-pointer temp puts the index first in
// the `addu`, where the integer temp and the struct source the project would write keep the base
// first. So IDO keeps the integer temp.
const DEREF_DECLS = 'struct S { u16 arr[4000]; }; extern struct S *gP; void use(u32);\n';
const DEREF = {
  integer: 'u16 f(u32 x) { s32 t = (s32)gP; use(t); return *(u16 *)(t + ((x << 4) + 772)); }',
  bytes: 'u16 f(u32 x) { u8 *t = (u8 *)gP; use((u32)t); return *(u16 *)(t + ((x << 4) + 772)); }',
  struct: 'u16 f(u32 x) { struct S *p = gP; use((u32)p); return p->arr[(x << 3) + 386]; }',
};

describe('a pointer global read through an integer or a byte-pointer temp, IDO 7.1', () => {
  // the operands of the one `addu` that adds the base `a0` and the scaled index
  const adduFirst = (src: string): string | undefined =>
    /addu\s+\w+,(\w+),(\w+)/.exec(compileTarget('ido', DEREF_DECLS + src, 'f').asm)?.[1];

  it('keeps the base first under the integer temp and the struct source, and not under the byte pointer', () => {
    expect(adduFirst(DEREF.struct)).toBe('a0');
    expect(adduFirst(DEREF.integer)).toBe('a0');
    expect(adduFirst(DEREF.bytes)).not.toBe('a0');
  });
});

// Each case merges the global's value across two arms and adds it to `(pos << 2) + K`, finds the
// candidate byte-exact in the project's world, checks it is the pointer sum and byte-exact in its
// own declared world too, and compiles the integer sum it replaces in one arm, which must not be.
const MERGE_DECLS =
  'struct S { u8 pad[2672]; void *party[6]; void *box[30]; void **shift; };\nextern struct S *gP;\nextern s32 gOut;\n';
const MERGE_MAP: SymbolMap = new Map([
  [0x03001000, [{ name: 'gP', kind: 'data', declared: true, shape: 'pointer', size: 4 }]],
  [0x03001004, [{ name: 'gOut', kind: 'data', declared: true, shape: 'scalar', size: 4, signed: true }]],
]);
const MERGE_CASES: { cc: Cc; body: string; spelled: string; integer: string }[] = [
  {
    cc: 'agbcc',
    body: 'void f(u8 a, u8 pos) { if (a == 14) gP->shift = &gP->party[pos]; else gP->shift = &gP->box[pos]; }',
    spelled: '(u8 *)gP + ((a1 << 2) + (167 << 4))',
    integer: '(s32)gP + ((a1 << 2) + (167 << 4))',
  },
  {
    cc: 'kmc',
    body:
      'void f(u8 a, u8 pos) { if (a == 14) gOut = (s32)((u8 *)gP + ((pos << 2) + 2672));' +
      ' else gOut = (s32)((u8 *)gP + ((pos << 2) + 2696)); }',
    spelled: '(u8 *)gP + (((a1 & 255) << 2) + 2672)',
    integer: '(s32)gP + (((a1 & 255) << 2) + 2672)',
  },
];

describe('a temp holding a map-declared pointer global, real compilers', () => {
  for (const { cc, body, spelled, integer } of MERGE_CASES) {
    it.runIf(HAVE[cc])(`spells the pointer sum the asm's association needs on ${cc}`, () => {
      const project = MERGE_DECLS + body;
      const { asm, obj } = compileTarget(cc, project, 'f');
      const { target } = targetFor(ID[cc], flags(cc));
      const candidate = enumerateCandidates('f', asm, target, {
        symbols: MERGE_MAP,
        prototypes: prototypesFromContext(C_TYPEDEFS + project, 'c'),
        asmData: extractAsmData(obj, target, 'f'),
      }).find((c) => matches(cc, MERGE_DECLS + c.source, 'f', obj));
      expect(candidate?.source).toContain(spelled);
      if (candidate === undefined) {
        return;
      }
      expect(matches(cc, renderDeclarations(candidate.symbolRefs ?? []) + candidate.source, 'f', obj)).toBe(true);
      expect(matches(cc, MERGE_DECLS + candidate.source.replaceAll(spelled, integer), 'f', obj)).toBe(false);
    });
  }
});

// A byte-pointer temp stored as a word into a global and a member the map declares integers takes
// their casts there, so it is declared `u8 *` as when it only feeds the sum: the default candidate
// is byte-exact, also under the project's `-Werror`.
const CELL_DECLS =
  'struct S { u8 pad[4000]; }; extern struct S *gP; extern s32 gOut;\n' +
  'struct T { s32 a; s32 b; }; extern struct T gT; void use(s32);\n';
const CELL_MAP: SymbolMap = new Map([
  [0x03001000, [{ name: 'gP', kind: 'data', declared: true, shape: 'pointer', size: 4 }]],
  [0x03001004, [{ name: 'gOut', kind: 'data', declared: true, shape: 'scalar', size: 4, signed: true }]],
  [
    0x03001008,
    [
      {
        name: 'gT',
        kind: 'data',
        declared: true,
        shape: 'struct',
        structName: 'T',
        size: 8,
        layout: [
          { name: 'a', offset: 0, size: 4, signed: true },
          { name: 'b', offset: 4, size: 4, signed: true },
        ],
      },
    ],
  ],
]);
const CELL_BODY = 'void f(u8 x) { u8 *t = (u8 *)gP; use(0); gOut = (s32)(t + ((x << 2) + 2672)); gT.b = (s32)t; }';

describe('a byte-pointer temp also stored into integer cells the map declares, real compilers', () => {
  for (const cc of ['agbcc', 'kmc'] as const) {
    it.runIf(HAVE[cc])(`declares it in the default candidate, byte-exact under -Werror on ${cc}`, () => {
      const project = CELL_DECLS + CELL_BODY;
      const { asm, obj } = compileTarget(cc, project, 'f');
      const { target } = targetFor(ID[cc], flags(cc));
      const [first] = enumerateCandidates('f', asm, target, {
        symbols: CELL_MAP,
        prototypes: prototypesFromContext(C_TYPEDEFS + project, 'c'),
        asmData: extractAsmData(obj, target, 'f'),
      });
      expect(first.variations).toEqual(['unsigned']);
      expect(first.source).toContain('gT.b = (s32)v0;');
      const werror = [...flags(cc), '-Werror'];
      const src = CELL_DECLS + first.source;
      const score = cc === 'agbcc' ? scoreC(src, 'f', obj, werror) : scoreCMipsGcc(src, 'f', obj, werror);
      expect(score.match).toBe(true);
    });
  }
});
