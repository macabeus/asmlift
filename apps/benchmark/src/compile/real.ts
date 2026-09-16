// Real-tier compilation dispatch: ONE table from toolchain id to its compile module. The table is
// EXHAUSTIVE over `ToolchainId`, so a new toolchain is a compile error here rather than a row that
// fails at run time.
//
// Design: the dataset VENDORS each function's preprocessed translation unit (cases/vendor.ts) —
// the compiler's actual input, frozen — so the runner needs no project checkouts. The target and every
// candidate compile at the row's codegen flags (`Case.codegen`).
import { type MatchScore, scoreObjects } from '@asmlift/cli/score';
import { macroDefinesOf } from '@asmlift/core/declare';
import { C_TYPEDEFS, TOOLCHAIN_TARGETS } from '@asmlift/core/target';

import { type BuiltTarget, type ToolchainId, checkedTarget } from '../toolchains';
import { agbccReal, stripPrototype } from './agbcc';
import { declarationsOnly } from './declarations';
import { gcc272Real } from './gcc272';
import { idoReal } from './ido';
import { kmcReal } from './kmc';
import { mwccReal } from './mwcc';
import type { RealCompile, RealProjectCfg, TuModel } from './types';
import { ctxTypedefPrelude } from './util';

export type { RealProjectCfg } from './types';

const REAL_COMPILERS: Record<ToolchainId, RealCompile> = {
  agbcc: agbccReal,
  'ido7.1': idoReal,
  'gcc2.7.2kmc': kmcReal,
  'gcc2.7.2': gcc272Real,
  mwcc_242_81: mwccReal('mwcc_242_81'),
  mwcc_233_163n: mwccReal('mwcc_233_163n'),
  mwcc_247_107: mwccReal('mwcc_247_107'),
};

/** Build the full translation unit: project #includes + any per-function prelude + the function.
 *  Vendor/verify time only — the runner consumes the preprocessed result. */
export function makeTU(cfg: RealProjectCfg, prependC: string, funcC: string): string {
  const inc = cfg.headers.map((h) => `#include "${h}"`).join('\n');
  return `${inc}\n${prependC ?? ''}\n${funcC}\n`;
}

export function realCompilerFor(toolchain: ToolchainId): RealCompile {
  return REAL_COMPILERS[toolchain];
}

/** The context m2c's `--context` reads, out of the context a row's candidates compile in.
 *
 *  A host `cpp` writes GNU C, which m2c's C parser reads as it is. CodeWarrior's own `-EP` keeps CodeWarrior's
 *  dialect, and the Dolphin SDK every GameCube unit includes defines inline functions around `asm { … }`
 *  blocks, which m2c refuses at the first one — so for CodeWarrior m2c gets the DECLARATIONS
 *  (`declarationsOnly`). That is everything m2c takes from a context: its reader never descends into a
 *  function body, and on the two existing real rows whose contexts carry bodies
 *  (`pokeemerald:Cmd_tryconversiontypechange`, `pokeemerald:AnimTask_FlashHealthboxOnLevelUp_Step`) m2c's
 *  output is byte-identical with the bodies removed. The candidate context keeps them: a candidate calling
 *  an inline function has to inline it. */
export function m2cContext(toolchain: ToolchainId, ctxI: string): string {
  return TOOLCHAIN_TARGETS[toolchain].family === 'mwcc' ? declarationsOnly(ctxI) : ctxI;
}

/** The compile module for a row of this toolchain in this language, refusing the pairing no
 *  toolchain implements.
 *
 *  CodeWarrior is the one compiler here that is a C AND a C++ front end; agbcc, IDO and the two
 *  GCCs have no C++ mode at all. A `c++` row on one of them would otherwise reach a `buildTarget`
 *  that simply ignores the parameter and build a C object with an UNMANGLED symbol — which scores,
 *  and publishes a number about a language the toolchain never read. */
function compilerFor(toolchain: ToolchainId, language: 'c' | 'c++'): RealCompile {
  if (language === 'c++' && TOOLCHAIN_TARGETS[toolchain].family !== 'mwcc') {
    throw new Error(`${toolchain} has no C++ front end — a c++ row needs a CodeWarrior toolchain`);
  }
  return realCompilerFor(toolchain);
}

/** Compile a vendored (preprocessed) target TU → scoring target + disassembly. The real tier's
 *  `Case.build`, and the only place its `BuiltTarget`s are born — `checkedTarget` is stated here
 *  rather than per compiler for the same reason the synthetic tier states it in `cachedBuildTarget`
 *  and not in each `TOOLCHAINS[*].buildTarget`. */
export function buildRealTarget(
  toolchain: ToolchainId,
  sym: string,
  cflags: readonly string[],
  tuI: string,
  language: 'c' | 'c++',
): BuiltTarget {
  return checkedTarget(
    compilerFor(toolchain, language).buildTarget(tuI, sym, cflags, language),
    `${toolchain} real-tier target`,
  );
}

// ── context-aware candidate scoring ────────────────────────────────────────────────────────
// A decompiler's output for a REAL function may reference the project's globals/structs; with
// only bare typedefs available, every such function would be noncompile — a harness artifact,
// not a decompiler weakness. The scorer therefore escalates context, up to the function's
// VENDORED preprocessed context (the same text the target compiled against).

/** One context a candidate may be compiled in: a complete prelude, ready to be concatenated ahead of it. */
export interface ScoringRung {
  name: string;
  prelude: string;
}

/** The escalation ladder for ONE real function, tried in order: the first rung a candidate compiles in is the
 *  world it is scored in. What the ladder is depends on the row's translation unit (`tu`):
 *
 *  ASSEMBLED — cheapest → richest:
 *    1. bare typedefs: C_TYPEDEFS, enough for a candidate that names nothing of the project;
 *    2. + manifest prependC (skipping C_TYPEDEFS when that prelude owns `u8` already);
 *    3. vendored ctx: the function's preprocessed context — its real types + extern globals, with the
 *       prototype of `sym` itself stripped (the candidate's definition must be the only one) and the
 *       typedefs that context does not itself define added back (ctxTypedefPrelude — the SAME helper
 *       decomp-config.ts materializes into the reproduction's ctx.i).
 *
 *  UNIT — the unit first, because the unit is where the game's function was compiled and a poorer world
 *  compiles the same source to other code. Measured on Mario Party 4: `BoardRandMod`'s own source
 *  compiles under bare typedefs, with `BoardRand` implicitly declared and CALLED where the game inlines
 *  it (score 16), and matches only in its unit; `fn_1_77A4`'s scores 1 and 0 the same way. So:
 *    1. unit context: the vendored context VERBATIM, with the typedefs it lacks added. The function's own
 *       prototype stays: the unit's earlier code calls the function through it (`HuDvdErrorWatch` twice,
 *       `fn_1_C2BC` four times), and without it each call declares the function implicitly and its
 *       definition is `redeclared`. A candidate compiles where the project would compile it, so a
 *       signature the project's own header contradicts does not compile there;
 *    2. bare typedefs, for a candidate the unit refuses.
 *
 *  Every rung re-provides `NULL`: the vendored context is PREPROCESSED, so the standard macro is
 *  expanded away, and a candidate spelling a null check the idiomatic way (`p != NULL`, as m2c
 *  does) would fail to compile purely for that while a `p != 0` candidate (as asmlift emits)
 *  would not. Both decompilers are judged on the code, not on this artifact.
 *
 *  EXPORTED because the reproduction scripts must materialize the very rung the harness used —
 *  see resolveScoringPrelude. */
export function scoringLadder(tu: TuModel, prependC: string, ctxI: string, sym: string): ScoringRung[] {
  const bare = { name: 'bare typedefs', prelude: `${C_TYPEDEFS}\n` };
  if (tu === 'unit') {
    return [{ name: 'unit context', prelude: `${ctxTypedefPrelude(ctxI)}${ctxI}\n` }, bare].map(withNull);
  }
  const proDefsU8 = /typedef\s+unsigned\s+char\s+u8\b/.test(prependC);
  return [
    bare,
    { name: '+ manifest prependC', prelude: `${proDefsU8 ? '' : C_TYPEDEFS}\n${prependC}\n` },
    ...(ctxI ? [{ name: 'vendored ctx', prelude: `${ctxTypedefPrelude(ctxI)}${stripPrototype(ctxI, sym)}\n` }] : []),
  ].map(withNull);
}

const withNull = (r: ScoringRung): ScoringRung => ({ ...r, prelude: `#define NULL ((void *)0)\n${r.prelude}` });

/** THE CANDIDATE, GIVEN THE LINKAGE ITS TARGET SYMBOL HAS — the C++ row's half of the ladder.
 *
 *  A C++ row's target symbol is MANGLED (`Vec::dot(Vec*)` → `dot__3VecFP3Vec`), and objdiff aligns
 *  a candidate to its target by that exact string. A decompiler writing a C-shaped function NAMED
 *  by the mangled symbol — which is what m2c's `ppc-mwcc-c++` target emits, `this` named and all —
 *  mangles a SECOND time under the C++ front end: measured, `dot__3VecFP3Vec` compiles to
 *  `dot__3VecFP3Vec__FP3VecP3Vec`, and the row would publish a noncompile about nothing.
 *
 *  So a C++ row's candidate is compiled with C language linkage, and that is ONE rule for both
 *  decompilers rather than a per-tool shim: a genuine member definition — what asmlift's C++
 *  backend emits — keeps its normal mangling inside the block, which is what the standard says and
 *  what mwcceppc was measured to do (`int Vec::dot(Vec*o){…}` inside `extern "C"` still exports
 *  `dot__3VecFP3Vec`). The block wraps the CANDIDATE alone, never the prelude: rung 3 is the
 *  project's own preprocessed C++ context, and templates inside a linkage block are ill-formed. */
export function candidateLinkage(language: 'c' | 'c++', candC: string): string {
  return language === 'c++' ? `extern "C" {\n${candC}\n}\n` : `${candC}\n`;
}

/** THE DIALECTS a row's candidate may be compiled in, the row's own first.
 *
 *  A C++ row gets a second: PLAIN C. Its target's symbol is the mangled string, and a C compile
 *  exports whatever name the candidate is written with — so a C-shaped candidate named by the
 *  mangled symbol aligns either way. The fallback exists because m2c's `ppc-mwcc-c++` output names
 *  the implicit receiver `this` on EVERY member function, and `this` is a C++ keyword: compiled in
 *  the row's own dialect that is `'(' expected`, and m2c would go 0-for-42 on Pikmin for a spelling
 *  rather than for its code. Same policy as the `#define NULL` every rung re-provides — a
 *  decompiler is judged on the code, not on an artifact of the harness's choice of front end.
 *
 *  SOUND, measured rather than assumed: on `pikmin:getFlag__11ResultFlagsFi` at that unit's real
 *  flags, the same C-shaped candidate compiled `-lang=c++` inside the linkage block and compiled
 *  `-lang=c` produce BYTE-IDENTICAL 712-byte objects and score 7/13 either way. THE RISK IS STATED:
 *  that is one row at one flag set, so the row's own dialect is always tried first and C is reached
 *  only for text the C++ front end REFUSED — text which is therefore not C++ at all. */
const candidateDialects = (language: 'c' | 'c++'): readonly ('c' | 'c++')[] =>
  language === 'c++' ? ['c++', 'c'] : ['c'];

/** Compile a candidate in the project's escalating context, returning the object of the FIRST
 *  prelude that compiles. The context is what lets an emission referencing project types/GLOBALS
 *  compile at all — the same context m2c is scored in, so asmlift's real-tier scoring is
 *  symmetric. Throws if none compile. */
export function makeRealCompile(
  toolchain: ToolchainId,
  cflags: readonly string[],
  tu: TuModel,
  prependC: string,
  ctxI: string,
  language: 'c' | 'c++',
) {
  const rc = compilerFor(toolchain, language);
  return (candC: string, sym: string, _backendId?: string, declarations?: string): string => {
    // The candidate's ADDRESS-CAST MACRO defines ride every rung. Every rung here is a headers
    // world — rungs 1/2 are asmlift's own prelude, rung 3 the project's PREPROCESSED context —
    // and none of them can contain a macro, so a macro-named candidate is `undeclared identifier`
    // without this. The rest of the synthesized block stays dropped: the context owns it.
    const macros = macroDefinesOf(declarations);
    // Each dialect's complaint in the RICHEST context, because a row that compiles nowhere PUBLISHES
    // this text as its error markers: the project's own context is where the candidate had to compile,
    // and bare typedefs fail on every project type. The fallback dialect is a harness convenience, and a
    // C++ candidate handed to the C parser fails on the word `class` — a diagnostic about the harness's
    // ladder, not about the decompiler's output.
    const failed = new Map<'c' | 'c++', string>();
    const ladder = scoringLadder(tu, prependC, ctxI, sym);
    const richest = richestRung(tu, ladder);
    // The whole context ladder in the row's own dialect BEFORE the fallback dialect is tried at
    // all: a richer context is the ordinary reason a candidate compiles, and paying for the
    // fallback first would double every C++ row's compiles to answer a rarer question.
    for (const dialect of candidateDialects(language)) {
      const body = candidateLinkage(dialect, candC);
      for (const rung of ladder) {
        try {
          return rc.compileCandidate(`${rung.prelude}${macros}${body}`, sym, cflags, dialect);
        } catch (e) {
          if (rung === richest) {
            failed.set(dialect, (e as Error).message);
          }
        }
      }
    }
    const lastErr = failed.get(language) ?? '';
    throw new Error(lastErr || 'candidate did not compile in any context');
  };
}

/** Which rung of the ladder a KNOWN source actually compiles in — i.e. the world the harness
 *  scored that source in. `bench target` replays it over a published row's winning source so the
 *  reproduction script grades where the benchmark graded: materializing the richest rung
 *  unconditionally is wrong whenever escalation stopped earlier, because a richer context can
 *  REJECT what a poorer one accepts (a project prototype vs. the candidate's implicitly-declared
 *  call). Costs 1–3 candidate compiles. Falls back to the richest rung when nothing compiles —
 *  the same context today's unconditional materialization would have used. */
export function resolveScoringPrelude(
  toolchain: ToolchainId,
  cflags: readonly string[],
  tu: TuModel,
  prependC: string,
  ctxI: string,
  sym: string,
  candC: string,
  language: 'c' | 'c++',
  /** the candidate's address-cast macro defines — every rung needs them (see makeRealCompile),
   *  and replaying the ladder WITHOUT them would fail every rung and pick the wrong one */
  macros = '',
): { rung: ScoringRung; language: 'c' | 'c++' } {
  const rc = compilerFor(toolchain, language);
  const ladder = scoringLadder(tu, prependC, ctxI, sym);
  // The DIALECT is replayed with the rung, for the same reason the rung is replayed at all: a C++
  // row whose source only compiles as C was scored as C, and a reproduction that states the row's
  // dialect would refuse the very source the benchmark published.
  for (const dialect of candidateDialects(language)) {
    const body = candidateLinkage(dialect, candC);
    for (const rung of ladder) {
      try {
        rc.compileCandidate(`${rung.prelude}${macros}${body}`, sym, cflags, dialect);
        return { rung, language: dialect };
      } catch {
        // next rung
      }
    }
  }
  return { rung: richestRung(tu, ladder), language };
}

/** The richest rung of a ladder: the project's own context where the row has one. */
export const richestRung = (tu: TuModel, ladder: readonly ScoringRung[]): ScoringRung =>
  tu === 'unit' ? ladder[0] : ladder[ladder.length - 1];

/** A context-aware Scorer (real tier): compile the candidate in project context, then objdiff it
 *  against the target. Shares makeRealCompile so asmlift and m2c compile in the identical context. */
export function makeRealScorer(
  toolchain: ToolchainId,
  cflags: readonly string[],
  tu: TuModel,
  prependC: string,
  ctxI: string,
  language: 'c' | 'c++',
) {
  const compile = makeRealCompile(toolchain, cflags, tu, prependC, ctxI, language);
  return (candC: string, sym: string, targetObj: string): MatchScore =>
    scoreObjects(targetObj, compile(candC, sym), sym);
}
