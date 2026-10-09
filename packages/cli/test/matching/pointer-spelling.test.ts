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
// compilers that reassociate an integer sum (core target.ts `reassociatesIntegerSumConstant`): the
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
