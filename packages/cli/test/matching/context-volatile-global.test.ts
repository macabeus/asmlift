// A VOLATILE GLOBAL THE DECLARATION CONTEXT DESCRIBES AND THE SYMBOL MAP DOES NOT, end to end on the
// toolchains the synthetic tier does not cover: gcc2.7.2 and the two CodeWarrior builds with no
// synthetic rows (`volpoll`/`volpollb` pin agbcc, ido7.1, gcc2.7.2kmc and mwcc_242_81). The context's
// volatile objects reach the declared-volatile stamp (core raise/declared-volatile.ts), so the cast
// an aggregate is read through carries the qualifier: `*(volatile u16 *)&gV`. A plain cast lets the
// compiler hoist a poll's load out of its loop and merge two reads of one member. A pointer the
// context declares to point at a volatile (`volatile u16 *gP`) qualifies the access through its value
// the same way.
//
// Each candidate is compiled against the same header the target was, as a project's would be.
import { decompile } from '@asmlift/core/pipeline';
import { type ContextGlobals, globalsFromContext } from '@asmlift/core/proto-context';
import { MIPS_GCC, TOOLCHAIN_TARGETS, type TargetDescription } from '@asmlift/core/target';
import {
  type MwccToolchainId,
  compileMipsGcc272Target,
  compilePpcTarget,
  extractAsmData,
  extractPpcAsmData,
  gcc272Available,
  scoreObjects,
} from '@asmlift/toolchains';
import { describe, expect, test } from 'vitest';

import { ppcDockerGate } from './docker-gate';

const H =
  'struct V { u16 a; u16 b; }; extern volatile struct V gV;\n' +
  'struct W { s32 a; s32 b; }; extern volatile struct W gW;\n' +
  'extern volatile u16 *gP; extern volatile struct V *gQ;\n' +
  'void vpoll(void); void vpollb(void); s32 vtwb(void); void pvp(void); void pvq(void);\n';
const CTX = globalsFromContext(H, 'c');
const PROTOS = {
  vpoll: { params: [], returnsVoid: true },
  vpollb: { params: [], returnsVoid: true },
  pvp: { params: [], returnsVoid: true },
  pvq: { params: [], returnsVoid: true },
};

const CASES = [
  // a poll at offset 0: a dereference of the cast
  { sym: 'vpoll', c: 'void vpoll(void){ while (gV.a == 0) ; }', spelled: '*(volatile u16 *)&gV', reads: 1 },
  // a poll at byte 2: a subscript on the cast
  { sym: 'vpollb', c: 'void vpollb(void){ while (gV.b == 0) ; }', spelled: '((volatile u16 *)&gV)[1]', reads: 1 },
  // two reads of one member, which a plain cast merges into one
  { sym: 'vtwb', c: 's32 vtwb(void){ return gW.b + gW.b; }', spelled: '((volatile s32 *)&gW)[1]', reads: 2 },
  // polls through a pointer the context declares to point at a volatile: the pointer is plain, the
  // access through its value is qualified on the cast it is spelled through
  { sym: 'pvp', c: 'void pvp(void){ while (*gP == 0) ; }', spelled: '*(volatile u16 *)gP', reads: 1 },
  { sym: 'pvq', c: 'void pvq(void){ while (gQ->b == 0) ; }', spelled: '((volatile u16 *)gQ)[1]', reads: 1 },
];

interface Build {
  name: string;
  have: boolean;
  target: TargetDescription;
  /** the object and its disassembly */
  compile: (c: string, sym: string) => { obj: string; asm: string };
  asmData: (obj: string, sym: string) => ReturnType<typeof extractPpcAsmData> | undefined;
  /** a load of a word or a halfword, in the build's disassembly */
  load: RegExp;
}

const PPC_FLAGS = TOOLCHAIN_TARGETS.mwcc_242_81.canonicalFlags;
const BUILDS: Build[] = [
  {
    name: 'gcc2.7.2',
    have: gcc272Available(),
    target: MIPS_GCC,
    compile: (c, s) => compileMipsGcc272Target(c, s, TOOLCHAIN_TARGETS['gcc2.7.2'].canonicalFlags),
    asmData: (obj, s) => extractAsmData(obj, MIPS_GCC, s),
    load: /\t(lw|lhu|lh)\t/g,
  },
  ...(['mwcc_233_163n', 'mwcc_247_107'] as MwccToolchainId[]).map((id): Build => ({
    name: id,
    have: ppcDockerGate('context-volatile-global', id),
    target: TOOLCHAIN_TARGETS[id].description,
    compile: (c, s) => compilePpcTarget(id, c, s, PPC_FLAGS),
    asmData: (obj, s) => extractPpcAsmData(obj, s),
    load: /\t(lwz|lhz|lha)\s/g,
  })),
];

const loads = (asm: string, load: RegExp): number => (asm.match(load) ?? []).length;

describe.each(BUILDS)('a context-declared volatile aggregate — $name', ({ have, target, compile, asmData, load }) => {
  const lift = (sym: string, c: string, contextGlobals: ContextGlobals) => {
    const t = compile(H + c, sym);
    const source = decompile(sym, t.asm, target, {
      asmData: asmData(t.obj, sym),
      prototypes: PROTOS,
      contextGlobals,
    }).source;
    return { t, source, cand: compile(H + source, sym) };
  };

  test.runIf(have).each(CASES)(
    '$sym reads $spelled and keeps every load',
    ({ sym, c, spelled, reads }) => {
      const { t, source, cand } = lift(sym, c, CTX);
      // gcc2.7.2 rotates a poll, so its read is spelled twice, once above the loop and once in it
      expect(source.split(spelled).length - 1, source).toBeGreaterThanOrEqual(reads);
      expect(loads(cand.asm, load), source).toBe(loads(t.asm, load));
      // the polls recompile byte-exact; vtwb's two reads stay two, whatever the scheduling
      if (sym !== 'vtwb') {
        expect(scoreObjects(t.obj, cand.obj, sym).score, source).toBe(0);
      }
    },
    120_000,
  );

  test.runIf(have)(
    'with the volatility withheld, the plain cast merges the two reads',
    () => {
      const { c, sym } = CASES[2];
      const { t, source, cand } = lift(sym, c, {
        aggregates: CTX.aggregates,
        volatiles: new Set(),
        pointeeVolatiles: new Set(),
        declared: new Set(),
        objectTypes: new Map(),
        structTypes: new Map(),
      });
      expect(source).not.toContain('volatile');
      expect(loads(cand.asm, load), source).toBeLessThan(loads(t.asm, load));
    },
    120_000,
  );
});
