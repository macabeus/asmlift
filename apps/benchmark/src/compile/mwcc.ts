// CodeWarrior / PowerPC (GameCube, Docker) — real-tier target build, candidate compile, and the
// vendor-time preprocessing of a project's include tree.
//
// Every step runs mwcceppc-via-wibo inside the linux/386 container, through the same pooled helper
// the synthetic tier compiles with (@asmlift/toolchains' `ppcCompile`) — with ONE difference, and it
// is the whole reason this module exists rather than reusing `compilePpcTarget`: the synthetic tier
// prepends `C_TYPEDEFS` to its source, and a real row's translation unit arrives already
// preprocessed against the project's own headers, which declare its types themselves.
//
// PREPROCESSING is the other half. The GBA and N64 projects' units go through a host `cpp`; a
// GameCube project's cannot, because its headers are written for this front end — they branch on
// `__MWERKS__` and the other macros only mwcceppc declares. So the preprocessor here is the compiler
// itself (`ppcPreprocess`), run with the checkout mounted, under the wrapper the unit's own build
// rule runs it under.
import { unitLanguage } from '@asmlift/core/codegen-flags';
import {
  type MwccToolchainId,
  ppcCompile,
  ppcPreprocess,
  ppcSectionScoped,
  ppcSymbolTableText,
} from '@asmlift/toolchains';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { unitCompileWrapper } from '../cases/dtk-project';
import { functionDisassembly } from '../eval/function-scope';
import type { BuiltTarget } from '../toolchains';
import { declarationsOnly } from './declarations';
import type { RealCompile, RealProjectCfg } from './types';
import { compilerDiagnostics, contentDir } from './util';

/** The CodeWarrior binary, as a project's own build rule names it. */
const MWCCEPPC = 'mwcceppc.exe';

/** The `-lang` word mwcceppc is handed to read a source in one dialect — stated ALWAYS, never left
 *  to the front end's default, and stated LAST so it overrides whatever the unit's own flags say.
 *
 *  That default is the file's extension, and every source this module writes is named `u.c` or
 *  `c.c`: neither a preprocessed blob nor a candidate has a project filename. Left implicit, a C++
 *  unit would be preprocessed against the `#ifdef __cplusplus` branch its own build does not take,
 *  its target would be built by the C front end, and its candidates would compile to unmangled
 *  symbols the mangled target has none of. */
const langFlag = (language: 'c' | 'c++'): string => `-lang=${language}`;

/** C++'s alternative operator spellings (ISO 646), defined as the operators they denote.
 *
 *  mwcceppc's COMPILE reads `or`, `and`, `not` and the rest as operators in a C++ unit, in `#if` as in
 *  code, but its preprocess-only modes (`-EP`, `-E`) do not: `#elif defined(A) or defined(B)` is an
 *  `expression syntax error` there, under every CodeWarrior build. Pikmin's `include/DebugLog.h` spells
 *  one, so without these no Pikmin unit preprocesses at all. Defined, the preprocessor reads the unit
 *  the way the compile does, and the definitions leave nothing in its output. Never in C, where the
 *  words are ordinary identifiers. Written into the source, not passed as `-D`, because mwcceppc's
 *  option parser refuses an `=` inside a define's value (`-Dand_eq=&=`). */
const ALTERNATIVE_TOKENS: readonly (readonly [string, string])[] = [
  ['and', '&&'],
  ['and_eq', '&='],
  ['bitand', '&'],
  ['bitor', '|'],
  ['compl', '~'],
  ['not', '!'],
  ['not_eq', '!='],
  ['or', '||'],
  ['or_eq', '|='],
  ['xor', '^'],
  ['xor_eq', '^='],
];

const alternativeTokenDefines = (language: 'c' | 'c++'): string =>
  language === 'c++' ? ALTERNATIVE_TOKENS.map(([word, op]) => `#define ${word} ${op}\n`).join('') : '';

/** Compile one source in `dir`, mapping a container or compiler failure onto the `<tool> failed:
 *  <diagnostic>` shape the evaluator turns into a row's error markers. */
function compile(
  mwcc: MwccToolchainId,
  dir: string,
  srcName: string,
  objName: string,
  cflags: readonly string[],
  disasm: boolean,
): string {
  try {
    return ppcCompile(mwcc, dir, srcName, objName, cflags, disasm);
  } catch (e) {
    throw new Error(`mwcceppc failed: ${compilerDiagnostics((e as Error).message)}`);
  }
}

/** A CodeWarrior declaration attribute, `__declspec(section "forcestrip")` or `__declspec(weak)`, as a
 *  preprocessed unit spells it. */
const DECLSPEC = /__declspec\s*\([^()]*\)\s*/g;

/** A bracketed expression holding no bracket of its own. */
const BRACKETED = /\[([^[\]]*)\]/g;

/** The distinct array bounds in `text` that `sizeof` spells, as written between their brackets.
 *
 *  A DECLARATION's text, never a whole unit's: `[...]` around a `sizeof` is an array bound in a
 *  declarator and a SUBSCRIPT in an expression, and only the first is a constant the compiler can be
 *  asked for. A unit prefix is mostly function bodies, and Mario Party 4's `SLSerialNoCheck` reaches
 *  three of them — `[(i) * sizeof(PlayerState) + …]` among them, which is not a constant at all. */
export function sizeofBounds(text: string): string[] {
  return [...new Set([...text.matchAll(BRACKETED)].map((m) => m[1]).filter((b) => /\bsizeof\b/.test(b)))];
}

/** The calls a failed `-requireprotos -msgstyle parseable` compile of `tu` refused for having no
 *  prototype, by name. Each diagnostic record is a `tool|Compiler|Error` line, a `(file|line|column|length|
 *  offset|length)` line and the message; the name is read out of `tu` at the record's byte offset, never
 *  out of the echoed source line, which CodeWarrior windows around a long line. */
export function noPrototypeCalls(output: string, tu: string): string[] {
  const names = new Set<string>();
  for (const m of output.matchAll(
    /\|Compiler\|Error\r?\n\([^|]*\|\d+\|\d+\|\d+\|(\d+)\|(\d+)\)\r?\n(?:=.*\r?\n)?>function has no prototype/g,
  )) {
    names.add(tu.slice(Number(m[1]), Number(m[1]) + Number(m[2])));
  }
  return [...names].sort();
}

/** The real tier for ONE CodeWarrior build. Three of them compile GameCube rows and they differ in
 *  codegen, so the build is bound here rather than defaulted: a row's target and its candidates
 *  must be the same compiler, and a scratch directory keyed by flags and text alone would let two
 *  builds share one. */
export const mwccReal = (mwcc: MwccToolchainId): RealCompile => ({
  buildTarget(iText, sym, cflags, language): BuiltTarget {
    const flags = [...cflags, langFlag(language)];
    const dir = contentDir('ppc', [mwcc, ...flags], iText);
    writeFileSync(join(dir, 'u.c'), iText);
    const asm = compile(mwcc, dir, 'u.c', 'u.o', flags, true);
    // A project unit is exactly where a translation unit gets several `.text` sections, all at
    // address 0: the decompiler reads the one that defines this row's function — and, of that section,
    // the function alone.
    return { obj: join(dir, 'u.o'), asm: functionDisassembly(ppcSectionScoped(mwcc, dir, 'u.o', sym, asm), sym) };
  },
  compileCandidate(tu, _sym, cflags, language): string {
    // ONE DIRECTORY PER CANDIDATE, leak and all — the rule kmc.ts and gcc272.ts follow, for the same
    // measured reason: a path reused across compiles that the container reaches through the shared
    // /tmp mount fails ~30% of the time with `c.o: No such file or directory`.
    const dir = mkdtempSync(join('/tmp', 'bench-ppc-cand-'));
    // The TU arrives whole: the ladder (compile/real.ts `scoringLadder`) decides what a context keeps of
    // the function's own prototype, and a unit context has to keep it.
    writeFileSync(join(dir, 'c.c'), tu);
    compile(mwcc, dir, 'c.c', 'c.o', [...cflags, langFlag(language)], false);
    return join(dir, 'c.o');
  },
  undeclaredCallees(tu, cflags, language): string[] {
    // C++ has no implicit declaration to find: the front end refuses the call outright, and the target
    // build says so.
    if (language === 'c++') {
      return [];
    }
    // THE COMPILER THAT READS THE UNIT ANSWERS, not the host's: a CodeWarrior unit calls intrinsics no
    // host compiler declares (`__fabs`, `__frsqrte`, which Animal Crossing's `math.h` inlines into every
    // unit) and is written in a dialect a host C parser only half reads. `-requireprotos` makes each
    // unprototyped call an error — the first of each function body, which is where CodeWarrior stops
    // reading that body.
    const dir = mkdtempSync(join('/tmp', 'bench-ppc-protos-'));
    writeFileSync(join(dir, 'u.c'), tu);
    try {
      ppcCompile(mwcc, dir, 'u.c', 'u.o', [...cflags, langFlag(language), '-requireprotos', '-msgstyle', 'parseable']);
      return [];
    } catch (e) {
      const names = noPrototypeCalls((e as Error).message, tu);
      if (names.length === 0) {
        throw new Error(`mwcceppc failed: ${compilerDiagnostics((e as Error).message)}`);
      }
      return names;
    }
  },
  vendoredContext(preprocessed, cflags, language): string {
    // m2c reads the context with a C parser, and two spellings a CodeWarrior unit is full of stop it
    // outright. Both are rewritten here into what the compiler itself makes of them; the row's own TU
    // blob keeps its text, because that blob is the unit the project compiled.
    //
    // `__declspec(section "forcestrip")`, `__declspec(weak)`: the parser refuses the keyword —
    // `Syntax error when parsing C context. before: "forcestrip"` on 29 of Animal Crossing's 38 C
    // contexts. On a DECLARATION the attribute says where another unit's definition is linked, or that
    // it may be absent, and nothing about its type, so a candidate compiled against the context
    // without it compiles to the same object.
    const ctx = preprocessed.replace(DECLSPEC, '');
    // An array bound spelled with `sizeof`: m2c evaluates a bound itself and has no `sizeof` —
    // `Failed to evaluate expression (OthersSave_c) … at compile time` on 28 of them, for m_card.h's
    // `u8 __align[ALIGN_NEXT(sizeof(OthersSave_c), mCD_MEMCARD_SECTORSIZE)]`. Each such bound is
    // replaced by the number CodeWarrior gives it at the unit's flags, which the layout depends on.
    const bounds = sizeofBounds(declarationsOnly(ctx));
    if (bounds.length === 0) {
      return ctx;
    }
    const dir = mkdtempSync(join('/tmp', 'bench-ppc-bounds-'));
    const probe = bounds.map((b, i) => `char __asmlift_bound_${i}[${b}];`).join('\n');
    writeFileSync(join(dir, 'u.c'), `${ctx}\n${probe}\n`);
    compile(mwcc, dir, 'u.c', 'u.o', [...cflags, langFlag(language)], false);
    const sizes = new Map(
      [...ppcSymbolTableText(mwcc, dir, 'u.o').matchAll(/\s([0-9a-f]{8})\s+__asmlift_bound_(\d+)\s*$/gm)].map((m) => [
        bounds[Number(m[2])],
        Number.parseInt(m[1], 16),
      ]),
    );
    const missing = bounds.filter((b) => !sizes.has(b));
    if (missing.length > 0) {
      throw new Error(`mwcceppc gave the array bound [${missing[0]}] no size`);
    }
    return ctx.replace(BRACKETED, (whole, inner: string) => {
      const size = sizes.get(inner);
      return size === undefined ? whole : `[${size}]`;
    });
  },
  preprocess(cfg: RealProjectCfg, tu: string): string {
    const language = unitLanguage(cfg.unit, cfg.cflags);
    const dir = mkdtempSync(join('/tmp', 'bench-ppc-vendor-'));
    writeFileSync(join(dir, 'u.c'), `${alternativeTokenDefines(language)}${tu}`);
    return ppcPreprocess({
      mwcc,
      root: cfg.root,
      srcPath: join(dir, 'u.c'),
      outPath: join(dir, 'u.i'),
      argv: [...cfg.cppIncludes, ...(cfg.defines ?? []), langFlag(language)],
      wrapper: unitCompileWrapper(cfg.root, cfg.unit, MWCCEPPC),
    });
  },
});
