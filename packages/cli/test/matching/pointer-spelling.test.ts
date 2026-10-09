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
